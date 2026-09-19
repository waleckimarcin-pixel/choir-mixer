import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { AudioMixer } from '../audio-engine.js';

const frames = new Map();
let frameNumber = 0;
let contexts = [];
let audios = [];

class FakeParam {
  constructor() { this.value = 1; }
  cancelScheduledValues() {}
  setTargetAtTime(value) { this.value = value; }
}

class FakeNode {
  constructor() { this.gain = new FakeParam(); this.disconnected = false; }
  connect() {}
  disconnect() { this.disconnected = true; }
}

class FakeContext extends EventTarget {
  constructor() {
    super();
    contexts.push(this);
    this.state = 'suspended';
    this.currentTime = 0;
    this.destination = {};
    this.nodes = [];
  }
  createGain() { const node = new FakeNode(); this.nodes.push(node); return node; }
  createMediaElementSource() { const node = new FakeNode(); this.nodes.push(node); return node; }
  async resume() { this.state = 'running'; this.dispatchEvent(new Event('statechange')); }
  async close() { this.state = 'closed'; }
}

class FakeAudio extends EventTarget {
  constructor() {
    super();
    audios.push(this);
    this._time = 0;
    this.duration = NaN;
    this.readyState = 0;
    this.paused = true;
    this.seeking = false;
    this.ended = false;
    this.playCalls = 0;
    this.pauseCalls = 0;
    this.assignments = 0;
  }
  get currentTime() { return this._time; }
  set currentTime(value) {
    this.assignments += 1;
    this._time = value;
    this.ended = false;
    this.seeking = true;
    if (!this.holdSeeking) queueMicrotask(() => {
      this.seeking = false;
      this.dispatchEvent(new Event('seeked'));
    });
  }
  load() {}
  removeAttribute(name) { delete this[name]; }
  ready(duration) {
    this.duration = duration;
    this.readyState = 4;
    this.dispatchEvent(new Event('loadedmetadata'));
    this.dispatchEvent(new Event('canplay'));
  }
  play() {
    this.playCalls += 1;
    this.paused = false;
    if (this.playImplementation) return this.playImplementation();
    if (this.readyState >= 3) return Promise.resolve();
    return new Promise(resolve => this.addEventListener('canplay', () => resolve(), { once: true }));
  }
  pause() { this.pauseCalls += 1; this.paused = true; }
  end() {
    this._time = this.duration;
    this.ended = true;
    this.paused = true;
    this.dispatchEvent(new Event('ended'));
  }
}

beforeEach(() => {
  frames.clear();
  audios = [];
  contexts = [];
  globalThis.Audio = FakeAudio;
  globalThis.AudioContext = FakeContext;
  globalThis.requestAnimationFrame = callback => { frames.set(++frameNumber, callback); return frameNumber; };
  globalThis.cancelAnimationFrame = id => frames.delete(id);
});

const tracks = [
  { id: 'sopran', name: 'Sopran', file: 'sopran.mp3', defaultVolume: 80 },
  { id: 'bas', name: 'Bas', file: 'bas.mp3', defaultVolume: 40 },
];
const flush = async () => { for (let i = 0; i < 20; i += 1) await Promise.resolve(); };
const createMixer = (t, callbacks = {}) => {
  const mixer = new AudioMixer(callbacks);
  t.after(() => mixer.destroy());
  return mixer;
};
const load = async (mixer, durations = [10, 12]) => {
  const start = audios.length;
  const promise = mixer.load(tracks);
  const media = audios.slice(start);
  media.forEach((audio, index) => audio.ready(durations[index]));
  const metadata = await promise;
  return { media, metadata };
};

test('loading counts each track once and chooses the longest master regardless of event order', async t => {
  const progress = [];
  const mixer = createMixer(t, { onProgress: value => progress.push(value) });
  const pending = mixer.load(tracks);
  audios[1].ready(12);
  audios[1].dispatchEvent(new Event('canplay'));
  audios[0].ready(10);
  const metadata = await pending;
  assert.deepEqual(metadata, { duration: 12, durations: { sopran: 10, bas: 12 } });
  assert.deepEqual(progress.map(item => item.loaded), [0, 1, 2]);
  assert.equal(mixer.state, 'ready');
});

test('a newer load cancels old loading without stale callbacks or leaked media nodes', async t => {
  const errors = [];
  const progress = [];
  const mixer = createMixer(t, { onError: error => errors.push(error), onProgress: value => progress.push(value) });
  const old = mixer.load(tracks);
  const rejected = assert.rejects(old, { name: 'AbortError' });
  const oldAudio = [...audios];
  const oldNodes = contexts[0].nodes.slice(1);
  const { metadata } = await load(mixer, [20, 18]);
  oldAudio.forEach(audio => { audio.ready(100); audio.dispatchEvent(new Event('error')); });
  await rejected;
  assert.equal(metadata.duration, 20);
  assert.equal(mixer.duration, 20);
  assert.deepEqual(errors, []);
  assert.deepEqual(progress.map(item => item.loaded), [0, 0, 1, 2]);
  assert.equal(contexts.length, 1);
  assert.ok(oldNodes.every(node => node.disconnected));
  assert.ok(oldAudio.every(audio => audio.paused && !audio.src));
});

test('a missing file rejects promptly, identifies the voice, and releases every track', async t => {
  const errors = [];
  const mixer = createMixer(t, { onError: error => errors.push(error) });
  const pending = mixer.load(tracks);
  const rejected = assert.rejects(pending, /„Bas”/);
  audios[1].error = { code: 4 };
  audios[1].dispatchEvent(new Event('error'));
  await rejected;
  assert.equal(mixer.state, 'error');
  assert.equal(errors.length, 1);
  assert.ok(audios.every(audio => audio.paused && !audio.src));
});

test('one rejected play stops all tracks and keeps output muted; a user can retry', async t => {
  const errors = [];
  const mixer = createMixer(t, { onError: error => errors.push(error) });
  const { media } = await load(mixer);
  media[1].playImplementation = () => Promise.reject(new DOMException('Gesture needed', 'NotAllowedError'));
  await assert.rejects(mixer.play(), /„Bas”/);
  assert.ok(media.every(audio => audio.paused));
  assert.equal(mixer.state, 'paused');
  assert.equal(contexts[0].nodes[0].gain.value, 0);
  assert.equal(errors.length, 1);
  media[1].playImplementation = null;
  await mixer.play();
  assert.equal(mixer.state, 'playing');
  assert.equal(contexts[0].nodes[0].gain.value, 1);
});

test('the shorter track ending never restarts the choir; longest track ending pauses all', async t => {
  const mixer = createMixer(t);
  const { media } = await load(mixer);
  await mixer.play();
  media[0].end();
  assert.equal(mixer.state, 'playing');
  assert.equal(media[0].playCalls, 1);
  assert.equal(media[1].paused, false);
  media[1].end();
  assert.equal(mixer.state, 'ended');
  assert.equal(mixer.currentTime, 12);
  assert.ok(media.every(audio => audio.paused));
  assert.equal(frames.size, 0);
  await mixer.play();
  assert.equal(mixer.state, 'playing');
  assert.ok(media.every(audio => audio.currentTime === 0 && !audio.paused));
});

test('repeated seeks retain a single animation frame and include ended shorter tracks', async t => {
  const mixer = createMixer(t);
  const { media } = await load(mixer);
  await mixer.play();
  assert.equal(frames.size, 1);
  await mixer.seek(11);
  assert.equal(media[0].currentTime, 10);
  assert.equal(media[0].paused, true);
  await mixer.seek(4);
  await mixer.seek(2);
  assert.equal(frames.size, 1);
  assert.ok(media.every(audio => audio.currentTime === 2 && !audio.paused));
  mixer.pause();
  assert.equal(frames.size, 0);
});

test('a pause during pending playback cannot be undone by a late play promise', async t => {
  const errors = [];
  const mixer = createMixer(t, { onError: error => errors.push(error) });
  const { media } = await load(mixer);
  let finish;
  media[1].playImplementation = () => new Promise(resolve => { finish = resolve; });
  const pending = mixer.play();
  const rejected = assert.rejects(pending, { name: 'AbortError' });
  mixer.pause();
  media[1].paused = false; // Emulate an implementation settling late.
  finish();
  await rejected;
  await flush();
  assert.equal(mixer.state, 'paused');
  assert.ok(media.every(audio => audio.paused));
  assert.equal(frames.size, 0);
  assert.deepEqual(errors, []);
});

test('a new seek cancels a pending seek without reporting an error or resuming old intent', async t => {
  const errors = [];
  const mixer = createMixer(t, { onError: error => errors.push(error) });
  const { media } = await load(mixer);
  media.forEach(audio => { audio.holdSeeking = true; });
  const first = mixer.seek(8);
  const rejected = assert.rejects(first, { name: 'AbortError' });
  media.forEach(audio => { audio.holdSeeking = false; });
  await mixer.seek(3);
  await rejected;
  assert.ok(media.every(audio => audio.currentTime === 3 && audio.paused));
  assert.equal(mixer.state, 'paused');
  assert.deepEqual(errors, []);
});

test('A–B loop works through timeupdate when animation frames are suspended', async t => {
  const mixer = createMixer(t);
  const { media } = await load(mixer);
  assert.deepEqual(mixer.setLoop(3, 7, true), { start: 3, end: 7, enabled: true });
  await mixer.play();
  media.forEach(audio => { audio._time = 7.2; });
  media[1].dispatchEvent(new Event('timeupdate'));
  await flush();
  assert.equal(mixer.state, 'playing');
  assert.ok(media.every(audio => audio.currentTime === 3 && !audio.paused));
  assert.equal(frames.size, 1);
});

test('buffering a voice silences the whole group and resumes it together', async t => {
  const mixer = createMixer(t);
  const { media } = await load(mixer);
  await mixer.play();
  media.forEach(audio => { audio._time = 4; });
  media[0].readyState = 2;
  media[0].dispatchEvent(new Event('waiting'));
  assert.equal(mixer.state, 'starting');
  assert.equal(contexts[0].nodes[0].gain.value, 0);
  media[0].readyState = 4;
  media[0].dispatchEvent(new Event('canplay'));
  await flush();
  assert.equal(mixer.state, 'playing');
  assert.ok(media.every(audio => audio.currentTime === 4 && !audio.paused));
});

test('runtime media error stops all parts, and context interruption pauses playback', async t => {
  const errors = [];
  const mixer = createMixer(t, { onError: error => errors.push(error) });
  const { media } = await load(mixer);
  await mixer.play();
  contexts[0].state = 'suspended';
  contexts[0].dispatchEvent(new Event('statechange'));
  assert.equal(mixer.state, 'paused');
  assert.ok(media.every(audio => audio.paused));
  await mixer.play();
  media[0].error = { code: 3 };
  media[0].dispatchEvent(new Event('error'));
  assert.equal(mixer.state, 'error');
  assert.ok(media.every(audio => audio.paused));
  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /„Sopran”/);
});

test('destroy cancels loading and closes the one shared AudioContext', async t => {
  const mixer = createMixer(t);
  const pending = mixer.load(tracks);
  const rejected = assert.rejects(pending, { name: 'AbortError' });
  mixer.destroy();
  await rejected;
  assert.equal(contexts[0].state, 'closed');
  assert.ok(contexts[0].nodes.every(node => node.disconnected));
  assert.equal(mixer.state, 'idle');
  assert.equal(mixer.duration, 0);
});

test('a loading timeout reports the stalled voice and stops the other pending download', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const errors = [];
  const mixer = createMixer(t, { onError: error => errors.push(error) });
  const pending = mixer.load(tracks);
  const rejected = assert.rejects(pending, /„Sopran”.*45 sekund/);
  t.mock.timers.tick(45000);
  await rejected;
  assert.equal(mixer.state, 'error');
  assert.equal(errors.length, 1);
  assert.ok(audios.every(audio => audio.paused && !audio.src));
});

test('an unresolved play promise times out with the entire choir silent', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const errors = [];
  const mixer = createMixer(t, { onError: error => errors.push(error) });
  const { media } = await load(mixer);
  media[0].playImplementation = () => new Promise(() => {});
  const pending = mixer.play();
  const rejected = assert.rejects(pending, /30 sekund/);
  assert.equal(contexts[0].nodes[0].gain.value, 0);
  t.mock.timers.tick(30000);
  await rejected;
  assert.equal(mixer.state, 'paused');
  assert.equal(errors.length, 1);
  assert.ok(media.every(audio => audio.paused));
  assert.equal(frames.size, 0);
});

test('large playback drift is corrected, while ordinary jitter and active seeks are left alone', async t => {
  let clock = 0;
  t.mock.method(globalThis.performance, 'now', () => clock);
  const mixer = createMixer(t);
  const { media } = await load(mixer);
  await mixer.play();
  media[0]._time = 3.02;
  media[1]._time = 3;
  clock = 1500;
  media[1].dispatchEvent(new Event('timeupdate'));
  assert.equal(media[0].assignments, 0);
  media[0]._time = 3.6;
  media[0].seeking = true;
  clock = 3000;
  media[1].dispatchEvent(new Event('timeupdate'));
  assert.equal(media[0].assignments, 0);
  media[0].seeking = false;
  media[1].dispatchEvent(new Event('timeupdate'));
  assert.equal(media[0].currentTime, 3);
  assert.equal(media[0].assignments, 1);
});

test('slow startup remains muted and retries skewed clocks from a common point', async t => {
  const mixer = createMixer(t);
  const { media } = await load(mixer);
  let finish;
  media[1].playImplementation = () => {
    if (media[1].playCalls === 1) return new Promise(resolve => { finish = resolve; });
    return Promise.resolve();
  };
  const pending = mixer.play();
  assert.equal(contexts[0].nodes[0].gain.value, 0);
  media[0]._time = 2;
  finish();
  await pending;
  assert.equal(mixer.state, 'playing');
  assert.ok(media.every(audio => audio.currentTime === 0 && audio.playCalls === 2));
  assert.equal(contexts[0].nodes[0].gain.value, 1);
});

test('metadata-only mobile preload enables Play and starts every media element before awaits', async t => {
  const mixer = createMixer(t);
  const loading = mixer.load(tracks);
  audios.forEach(audio => {
    audio.duration = 12;
    audio.readyState = 1;
    audio.dispatchEvent(new Event('loadedmetadata'));
  });
  await loading;
  assert.equal(mixer.state, 'ready');
  const playing = mixer.play();
  // These must already have run in the calling click, not a later microtask.
  assert.ok(audios.every(audio => audio.playCalls === 1));
  assert.equal(mixer.state, 'starting');
  assert.equal(contexts[0].nodes[0].gain.value, 0);
  audios.forEach(audio => audio.ready(12));
  await playing;
  assert.equal(mixer.state, 'playing');
});

test('pressing Play while an initial seek is pending still calls each play in the gesture', async t => {
  const mixer = createMixer(t);
  const { media } = await load(mixer);
  media.forEach(audio => { audio.holdSeeking = true; });
  const seeking = mixer.seek(5);
  const cancelled = assert.rejects(seeking, { name: 'AbortError' });
  const playing = mixer.play();
  assert.ok(media.every(audio => audio.playCalls === 1 && audio.seeking));
  media.forEach(audio => {
    audio.seeking = false;
    audio.dispatchEvent(new Event('seeked'));
  });
  await playing;
  await cancelled;
  assert.equal(mixer.state, 'playing');
});
