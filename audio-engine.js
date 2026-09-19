const LOAD_TIMEOUT = 45000;
const TRANSPORT_TIMEOUT = 30000;
const DRIFT_LIMIT = 0.08;
const MIN_LOOP_LENGTH = 1;

const abortError = () => new DOMException('Operacja anulowana.', 'AbortError');
const now = () => globalThis.performance?.now() ?? Date.now();
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

/**
 * Streaming mixer: one AudioContext is reused across songs. MP3 files stay in
 * HTMLAudioElements rather than being decoded into full-length AudioBuffers.
 *
 * load() resolves { duration, durations: { [trackId]: seconds } }.
 * Superseded operations reject with AbortError and never call onError.
 * Playback/seek failures reject AND call onError; UI event handlers should
 * consume the rejection because onError already supplies the visible message.
 * The longest track is the transport clock; shorter tracks have a silent tail.
 * End leaves the playhead at the end. The next play() starts from zero.
 */
export class AudioMixer {
  constructor({ onState, onProgress, onTime, onError } = {}) {
    this._callbacks = { onState, onProgress, onTime, onError };
    this._state = 'idle';
    this._entries = [];
    this._master = null;
    this._duration = 0;
    this._context = null;
    this._output = null;
    this._generation = 0;
    this._loadController = null;
    this._operation = null;
    this._transportPromise = null;
    this._frame = null;
    this._destroyed = false;
    this._lastSync = 0;
    this._loop = { start: 0, end: 0, enabled: false };
    this._contextListener = () => {
      // A phone call, screen lock or OS audio interruption must not leave the
      // interface claiming playback while the shared audio graph is suspended.
      if (this._context?.state !== 'running' && this._state === 'playing') this.pause();
    };
  }

  get state() { return this._state; }
  get duration() { return this._duration; }
  get currentTime() {
    return clamp(this._master?.audio.currentTime || 0, 0, this._duration);
  }

  async load(tracks) {
    this._assertAlive();
    const generation = ++this._generation;
    this._cancelTransport();
    this._loadController?.abort();
    this._releaseEntries();
    this._duration = 0;
    this._loop = { start: 0, end: 0, enabled: false };
    const controller = new AbortController();
    this._loadController = controller;
    this._setState('loading');
    this._emitTime();
    let loaded = 0;

    try {
      if (!Array.isArray(tracks) || !tracks.length) throw new Error('Ten utwór nie zawiera nagrań.');
      const ids = new Set();
      for (const track of tracks) {
        if (!track?.id || !track.file || ids.has(track.id)) {
          throw new Error('Nieprawidłowa konfiguracja ścieżek utworu.');
        }
        ids.add(track.id);
      }
      this._ensureContext();
      this._callbacks.onProgress?.({ loaded, total: tracks.length });
      // Keep each completed entry reachable if creating a later node fails.
      for (const track of tracks) this._entries.push(this._createEntry(track, generation));
      const pending = this._entries.map(entry => {
        const promise = this._waitForMedia(entry, controller.signal, () => (
          // Some iPhones preload metadata only until a user presses Play.
          Number.isFinite(entry.audio.duration) && entry.audio.duration > 0 && entry.audio.readyState >= 1
        ), LOAD_TIMEOUT, `Nie udało się wczytać nagrania „${entry.name}” w ciągu 45 sekund. Sprawdź połączenie i spróbuj ponownie.`)
          .then(() => {
            if (generation !== this._generation || controller.signal.aborted) throw abortError();
            loaded += 1;
            this._callbacks.onProgress?.({ loaded, total: tracks.length });
          });
        entry.audio.src = entry.file;
        entry.audio.load();
        return promise;
      });
      await Promise.all(pending);
      if (generation !== this._generation || controller.signal.aborted) throw abortError();
      this._master = this._entries.reduce((longest, entry) => (
        !longest || entry.audio.duration > longest.audio.duration ? entry : longest
      ), null);
      this._duration = this._master.audio.duration;
      this._loop.end = this._duration;
      this._setState('ready');
      this._emitTime();
      return {
        duration: this._duration,
        durations: Object.fromEntries(this._entries.map(entry => [entry.id, entry.audio.duration])),
      };
    } catch (error) {
      if (generation !== this._generation || controller.signal.aborted) throw abortError();
      controller.abort();
      this._releaseEntries();
      this._setState('error');
      this._callbacks.onError?.(error);
      throw error;
    }
  }

  play() {
    this._assertAlive();
    if (this._state === 'playing') return Promise.resolve();
    if (this._state === 'starting' && this._transportPromise) return this._transportPromise;
    if (!this._master || this._state === 'loading' || this._state === 'error') {
      return Promise.reject(new Error('Najpierw wczytaj utwór.'));
    }
    const target = this._state === 'ended' || this.currentTime >= this._duration ? 0 : this.currentTime;
    return this._start(target);
  }

  pause() {
    if (this._destroyed) return;
    const wasActive = this._state === 'playing' || this._state === 'starting';
    this._cancelTransport();
    this._pauseAll();
    if (wasActive) this._setState('paused');
    this._emitTime();
  }

  seek(seconds) {
    this._assertAlive();
    if (!this._master || this._state === 'loading' || this._state === 'error') {
      return Promise.reject(new Error('Najpierw wczytaj utwór.'));
    }
    if (!Number.isFinite(Number(seconds))) return Promise.reject(new Error('Nieprawidłowy czas nagrania.'));
    const target = clamp(Number(seconds), 0, this._duration);
    const resume = this._state === 'playing' || this._state === 'starting';
    if (resume && target < this._duration) return this._start(target);

    const operation = this._beginTransport();
    this._pauseAll();
    this._setState(target >= this._duration ? 'ended' : 'paused');
    this._transportPromise = this._seekPaused(target, operation);
    return this._transportPromise;
  }

  setVolume(trackId, percent) {
    const entry = this._entries.find(track => track.id === trackId);
    if (!entry || !Number.isFinite(Number(percent))) return;
    const volume = clamp(Number(percent), 0, 100) / 100;
    entry.volume = volume;
    entry.gain.gain.cancelScheduledValues(this._context.currentTime);
    entry.gain.gain.setTargetAtTime(volume, this._context.currentTime, 0.015);
  }

  setLoop(start, end, enabled) {
    const a = clamp(Number(start) || 0, 0, this._duration);
    const b = clamp(Number(end) || 0, 0, this._duration);
    this._loop = { start: a, end: b, enabled: Boolean(enabled) && b - a >= MIN_LOOP_LENGTH };
    return { ...this._loop };
  }

  destroy() {
    if (this._destroyed) return;
    this._destroyed = true;
    this._generation += 1;
    this._loadController?.abort();
    this._cancelTransport();
    this._releaseEntries();
    this._context?.removeEventListener('statechange', this._contextListener);
    this._output?.disconnect();
    this._context?.close().catch(() => {});
    this._duration = 0;
    this._setState('idle');
  }

  _assertAlive() {
    if (this._destroyed) throw new Error('Odtwarzacz został zamknięty. Odśwież stronę.');
  }

  _ensureContext() {
    if (this._context) return;
    const Context = globalThis.AudioContext || globalThis.webkitAudioContext;
    if (!Context) throw new Error('Ta przeglądarka nie obsługuje miksera. Otwórz stronę w aktualnej przeglądarce.');
    this._context = new Context();
    this._output = this._context.createGain();
    this._output.gain.value = 0;
    this._output.connect(this._context.destination);
    this._context.addEventListener('statechange', this._contextListener);
  }

  _createEntry(track, generation) {
    const audio = new Audio();
    // Set CORS before src: assigning a URL may start a request immediately.
    audio.crossOrigin = 'anonymous';
    audio.preload = 'auto';
    audio.playsInline = true;
    const source = this._context.createMediaElementSource(audio);
    const gain = this._context.createGain();
    const entry = {
      id: track.id, name: track.name || track.id, file: track.file,
      audio, source, gain, listeners: [],
      volume: clamp(Number(track.defaultVolume ?? 80) || 0, 0, 100) / 100,
    };
    gain.gain.value = entry.volume;
    source.connect(gain);
    gain.connect(this._output);
    const listen = (event, callback) => {
      const guarded = () => {
        if (generation === this._generation && !this._destroyed) callback();
      };
      audio.addEventListener(event, guarded);
      entry.listeners.push([event, guarded]);
    };
    listen('error', () => {
      if (!['loading', 'idle', 'error'].includes(this._state)) this._fail(this._mediaError(entry));
    });
    listen('timeupdate', () => { if (entry === this._master) this._tick(); });
    listen('ended', () => {
      if (entry !== this._master || this._state !== 'playing') return;
      if (this._loop.enabled) this.seek(this._loop.start).catch(() => {});
      else this._finish();
    });
    listen('waiting', () => {
      if (this._state === 'playing' && audio.currentTime < audio.duration - 0.05) {
        // Silence the whole choir while a part buffers; restart together.
        this._start(this.currentTime).catch(() => {});
      }
    });
    return entry;
  }

  _mediaError(entry) {
    const reason = entry.audio.error?.code === 4
      ? 'Plik jest niedostępny lub ma nieobsługiwany format.'
      : 'Sprawdź połączenie i spróbuj ponownie.';
    return new Error(`Nie udało się odtworzyć nagrania „${entry.name}”. ${reason}`);
  }

  _waitForMedia(entry, signal, ready, timeout, timeoutMessage) {
    return new Promise((resolve, reject) => {
      const audio = entry.audio;
      const events = ['loadedmetadata', 'durationchange', 'loadeddata', 'canplay', 'seeked'];
      let timer;
      const cleanup = () => {
        clearTimeout(timer);
        for (const event of events) audio.removeEventListener(event, check);
        audio.removeEventListener('error', error);
        signal.removeEventListener('abort', abort);
      };
      const settle = (failure) => { cleanup(); failure ? reject(failure) : resolve(); };
      const check = () => { if (ready()) settle(); };
      const error = () => settle(this._mediaError(entry));
      const abort = () => settle(abortError());
      for (const event of events) audio.addEventListener(event, check);
      audio.addEventListener('error', error);
      signal.addEventListener('abort', abort, { once: true });
      timer = setTimeout(() => settle(new Error(timeoutMessage)), timeout);
      if (signal.aborted) abort();
      else if (audio.error) error();
      else check();
    });
  }

  _beginTransport() {
    this._cancelTransport();
    const operation = { controller: new AbortController(), generation: this._generation };
    this._operation = operation;
    return operation;
  }

  _cancelTransport() {
    this._operation?.controller.abort();
    this._operation = null;
    this._transportPromise = null;
    this._stopFrame();
  }

  _isCurrent(operation) {
    return operation === this._operation && operation.generation === this._generation && !operation.controller.signal.aborted;
  }

  _checkOperation(operation) {
    if (!this._isCurrent(operation)) throw abortError();
  }

  _start(target) {
    const operation = this._beginTransport();
    this._pauseAll();
    this._setState('starting');
    // Resume the Web Audio context directly in the user's click, before awaits.
    let resume;
    try { resume = this._context.state !== 'running' ? this._context.resume() : Promise.resolve(); }
    catch (error) { resume = Promise.reject(error); }
    this._transportPromise = this._runPlayback(target, operation, resume);
    return this._transportPromise;
  }

  async _runPlayback(target, operation, resume) {
    // Attach a rejection handler immediately even if seeking is still pending.
    const contextReady = Promise.resolve(resume);
    contextReady.catch(() => {});
    try {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        this._checkOperation(operation);
        const seeking = this._seekAll(target, operation);
        this._checkOperation(operation);
        const active = this._entries.filter(entry => target < entry.audio.duration - 0.001);
        // Every element's initial play() must run before any await, in the
        // user's gesture. On iOS it also unlocks loading beyond metadata.
        // The play promises wait for enough media data while output is muted.
        const starts = active.map(entry => {
          let promise;
          try { promise = Promise.resolve(entry.audio.play()); }
          catch (error) { promise = Promise.reject(error); }
          return promise.then(() => {
            // A delayed play promise must not undo a later pause or song change.
            if (!this._isCurrent(operation) && !['playing', 'starting'].includes(this._state)) entry.audio.pause();
          }, error => {
            const message = error?.name === 'NotAllowedError'
              ? `Przeglądarka zablokowała nagranie „${entry.name}”. Naciśnij ponownie „Odtwórz”.`
              : `Nie udało się uruchomić nagrania „${entry.name}”. Spróbuj ponownie.`;
            throw new Error(message, { cause: error });
          });
        });
        await this._waitForOperation(Promise.all([contextReady, seeking, ...starts]), operation);
        this._checkOperation(operation);
        // Keep output muted until every play() succeeds. A slow stream may
        // have let the other media clocks advance; retry from a common point.
        const clock = this.currentTime;
        const aligned = active.every(entry => Math.abs(entry.audio.currentTime - clock) <= DRIFT_LIMIT);
        if (aligned) {
          this._lastSync = now();
          this._output.gain.value = 1;
          this._setState('playing');
          this._emitTime();
          this._scheduleFrame();
          return;
        }
        this._pauseAll();
      }
      throw new Error('Nagrania nie mogą wystartować razem. Sprawdź połączenie i spróbuj ponownie.');
    } catch (error) {
      if (!this._isCurrent(operation)) throw abortError();
      this._cancelTransport();
      this._pauseAll();
      this._setState('paused');
      const failure = error?.name === 'AbortError' ? error : new Error(error.message || 'Nie udało się uruchomić odtwarzania.');
      if (failure.name !== 'AbortError') this._callbacks.onError?.(failure);
      throw failure;
    }
  }

  _waitForOperation(promise, operation) {
    const signal = operation.controller.signal;
    return new Promise((resolve, reject) => {
      const cleanup = () => { clearTimeout(timer); signal.removeEventListener('abort', abort); };
      const abort = () => { cleanup(); reject(abortError()); };
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error('Odtwarzanie nie rozpoczęło się w ciągu 30 sekund. Sprawdź połączenie i spróbuj ponownie.'));
      }, TRANSPORT_TIMEOUT);
      signal.addEventListener('abort', abort, { once: true });
      promise.then(value => { cleanup(); resolve(value); }, error => { cleanup(); reject(error); });
      if (signal.aborted) abort();
    });
  }

  _seekAll(target, operation) {
    const waits = [];
    for (const entry of this._entries) {
      const time = Math.min(target, entry.audio.duration);
      if (Math.abs(entry.audio.currentTime - time) > 0.001) entry.audio.currentTime = time;
      if (entry.audio.seeking) {
        waits.push(this._waitForMedia(
          entry, operation.controller.signal, () => !entry.audio.seeking,
          TRANSPORT_TIMEOUT, `Nie udało się przewinąć nagrania „${entry.name}”. Spróbuj ponownie.`,
        ));
      }
    }
    this._lastSync = now();
    this._emitTime();
    return waits.length ? Promise.all(waits) : null;
  }

  async _seekPaused(target, operation) {
    try {
      const seeking = this._seekAll(target, operation);
      if (seeking) await seeking;
      this._checkOperation(operation);
      this._emitTime();
    } catch (error) {
      if (!this._isCurrent(operation)) throw abortError();
      this._cancelTransport();
      this._callbacks.onError?.(error);
      throw error;
    }
  }

  _tick() {
    this._emitTime();
    if (this._state !== 'playing') return;
    const time = this.currentTime;
    if (this._loop.enabled && time >= this._loop.end) {
      this.seek(this._loop.start).catch(() => {});
      return;
    }
    if (this._master.audio.ended || time >= this._duration) {
      this._finish();
      return;
    }
    if (now() - this._lastSync < 1000 || this._entries.some(entry => entry.audio.seeking)) return;
    this._lastSync = now();
    if (this._master.audio.readyState < 3) return;
    for (const entry of this._entries) {
      if (entry === this._master || entry.audio.ended || entry.audio.readyState < 3 || time >= entry.audio.duration) continue;
      if (Math.abs(entry.audio.currentTime - time) > DRIFT_LIMIT) {
        // Correct only audible drift, at most once a second, outside group seeks.
        try { entry.audio.currentTime = time; }
        catch { this._fail(new Error(`Nie udało się zsynchronizować nagrania „${entry.name}”. Wczytaj utwór ponownie.`)); return; }
      }
    }
  }

  _scheduleFrame() {
    if (this._frame !== null || this._state !== 'playing') return;
    this._frame = requestAnimationFrame(() => {
      this._frame = null;
      this._tick();
      this._scheduleFrame();
    });
  }

  _stopFrame() {
    if (this._frame !== null) cancelAnimationFrame(this._frame);
    this._frame = null;
  }

  _pauseAll() {
    if (this._output) this._output.gain.value = 0;
    for (const entry of this._entries) entry.audio.pause();
  }

  _finish() {
    this._cancelTransport();
    this._pauseAll();
    this._setState('ended');
    this._emitTime();
  }

  _fail(error) {
    this._cancelTransport();
    this._pauseAll();
    this._setState('error');
    this._callbacks.onError?.(error);
  }

  _releaseEntries() {
    this._pauseAll();
    for (const entry of this._entries) {
      for (const [event, callback] of entry.listeners) entry.audio.removeEventListener(event, callback);
      entry.source.disconnect();
      entry.gain.disconnect();
      entry.audio.removeAttribute('src');
      entry.audio.load();
    }
    this._entries = [];
    this._master = null;
  }

  _setState(state) {
    if (this._state === state) return;
    this._state = state;
    this._callbacks.onState?.(state);
  }

  _emitTime() {
    this._callbacks.onTime?.({ currentTime: this.currentTime, duration: this._duration });
  }
}
