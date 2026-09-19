import { AudioMixer } from './audio-engine.js';

const $ = id => document.getElementById(id);
const ui = Object.fromEntries(['songSelector', 'songTitle', 'songMeta', 'tracksContainer',
  'mixer-container', 'loadStatus', 'loadingBar', 'loadMessage', 'retryBtn', 'notice',
  'playBtn', 'playIcon', 'pauseIcon', 'rewindBtn', 'forwardBtn', 'currentTime', 'totalTime',
  'seekSlider', 'voicePreset', 'resetBtn', 'shareBtn', 'shareLink', 'shareStatus',
  'setABtn', 'setBBtn', 'loopBtn', 'clearLoopBtn', 'loopStatus', 'playbackStatus'
].map(id => [id, $(id)]));
const badgeClasses = new Set(['sop', 'sop-h', 'sop-l', 'alt', 'tenor', 'bas', 'click', 'piano', 'motyw-a', 'motyw-b', 'motyw-c']);
let songs = [];
let activeSong = null;
let loadVersion = 0;
let ready = false;
let volumes = {};
let previousVolumes = {};
let loop = { start: null, end: null, enabled: false };
let seeking = false;
let storageAvailable = true;

const mixer = new AudioMixer({
  onState: updateState,
  onProgress: ({ loaded, total }) => {
    ui.loadingBar.style.width = `${total ? loaded / total * 100 : 0}%`;
    ui.loadMessage.textContent = `Ładowanie głosów: ${loaded} z ${total}…`;
  },
  onTime: renderTime,
  onError: error => showError(error.message)
});

function formatTime(seconds) {
  const value = Math.max(0, Math.floor(Number(seconds) || 0));
  return `${Math.floor(value / 60)}:${String(value % 60).padStart(2, '0')}`;
}

function readSetting(key) {
  try { return JSON.parse(localStorage.getItem(`choir-mixer:${key}`)); }
  catch { storageAvailable = false; return null; }
}

function saveSetting(key, value) {
  try { localStorage.setItem(`choir-mixer:${key}`, JSON.stringify(value)); }
  catch {
    storageAvailable = false;
    ui.notice.textContent = 'Przeglądarka nie zapisuje ustawień. Możesz nadal ćwiczyć w tej karcie.';
  }
}

function validateConfig(config) {
  if (!Array.isArray(config?.songs) || !config.songs.length) throw new Error('Nie ma jeszcze utworów do odtworzenia.');
  const songIds = new Set();
  for (const song of config.songs) {
    if (!song || !/^[a-z0-9_-]+$/.test(song.id) || songIds.has(song.id) || typeof song.title !== 'string' || !song.title.trim() || !Array.isArray(song.tracks) || !song.tracks.length) {
      throw new Error('Lista utworów zawiera nieprawidłowy lub powtórzony wpis.');
    }
    songIds.add(song.id);
    const trackIds = new Set();
    for (const track of song.tracks) {
      if (!track || !/^[a-z0-9_-]+$/.test(track.id) || trackIds.has(track.id) || typeof track.name !== 'string' || !track.name.trim() || typeof track.badge !== 'string' || !badgeClasses.has(track.badgeClass) || typeof track.file !== 'string' || !/^audio\/[a-z0-9_-]+\/[a-zA-Z0-9_.-]+\.mp3$/.test(track.file) || !Number.isFinite(track.defaultVolume) || track.defaultVolume < 0 || track.defaultVolume > 100) {
        throw new Error(`Nieprawidłowa konfiguracja głosów w utworze „${song.title}”.`);
      }
      trackIds.add(track.id);
    }
  }
  return config.songs;
}

function updateState(state) {
  const playing = state === 'playing';
  const starting = state === 'starting';
  ui.playIcon.hidden = playing || starting;
  ui.pauseIcon.hidden = !playing && !starting;
  ui.playBtn.setAttribute('aria-label', playing || starting ? 'Pauza' : 'Odtwórz');
  ui.playBtn.setAttribute('aria-pressed', String(playing || starting));
  ui.playbackStatus.textContent = ({ loading: 'Ładowanie nagrań', starting: 'Przygotowanie odtwarzania…', playing: 'Odtwarzanie', paused: 'Pauza', ended: 'Koniec utworu', ready: 'Gotowe do ćwiczenia', error: 'Nie udało się odtworzyć nagrania' })[state] || '';
}

function enableTransport(enabled) {
  ready = enabled;
  for (const id of ['playBtn', 'rewindBtn', 'forwardBtn', 'seekSlider', 'setABtn', 'setBBtn']) ui[id].disabled = !enabled;
  renderLoop();
}

function renderTime({ currentTime = 0, duration = 0 }) {
  ui.currentTime.textContent = formatTime(currentTime);
  ui.totalTime.textContent = formatTime(duration);
  ui.seekSlider.max = String(duration || 1);
  if (!seeking) ui.seekSlider.value = String(currentTime);
  const percent = duration ? Math.max(0, Math.min(100, currentTime / duration * 100)) : 0;
  ui.seekSlider.style.setProperty('--progress', `${percent}%`);
  ui.seekSlider.setAttribute('aria-valuetext', `${formatTime(currentTime)} z ${formatTime(duration)}`);
}

function showError(message) {
  const canRetryPlay = mixer.state === 'paused' && mixer.duration > 0;
  enableTransport(canRetryPlay);
  ui.loadStatus.hidden = false;
  ui.loadStatus.classList.add('has-error');
  ui.loadMessage.textContent = message || 'Nie udało się załadować nagrań. Spróbuj ponownie lub wybierz inny utwór.';
  ui.retryBtn.hidden = canRetryPlay;
}

function renderSelector() {
  ui.songSelector.replaceChildren();
  for (const song of songs) {
    const button = document.createElement('button');
    button.className = 'song-btn';
    button.textContent = song.title;
    button.dataset.song = song.id;
    button.addEventListener('click', () => selectSong(song.id));
    ui.songSelector.append(button);
  }
}

function renderTracks() {
  ui.tracksContainer.replaceChildren();
  for (const track of activeSong.tracks) {
    const row = document.createElement('div');
    row.className = `track${track.isClick ? ' click-track' : ''}`;
    row.dataset.voice = track.id;
    // Only fixed markup is used here; configuration values are assigned as text.
    row.innerHTML = '<div class="voice-badge" aria-hidden="true"></div><div class="track-info"><label class="track-name"></label><input type="range" class="volume-slider" min="0" max="100" step="1"></div><div class="track-controls"><span class="volume-value" aria-hidden="true"></span><button class="mute-btn" type="button"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M11 5L6 9H2v6h4l5 4V5z"/><path class="sound-waves" d="M15.5 8.5a5 5 0 0 1 0 7M19 5a10 10 0 0 1 0 14"/><path class="sound-cross" d="m17 9 6 6m0-6-6 6"/></svg></button></div>';
    const badge = row.querySelector('.voice-badge');
    badge.classList.add(track.badgeClass);
    badge.textContent = track.badge;
    const slider = row.querySelector('input');
    slider.id = `volume-${track.id}`;
    row.querySelector('label').htmlFor = slider.id;
    row.querySelector('label').textContent = track.name;
    slider.setAttribute('aria-label', `Głośność: ${track.name}`);
    slider.addEventListener('input', () => {
      setTrackVolume(track.id, Number(slider.value));
      ui.voicePreset.value = 'custom';
      saveVolumes();
    });
    row.querySelector('button').addEventListener('click', () => {
      setTrackVolume(track.id, volumes[track.id] === 0 ? previousVolumes[track.id] || track.defaultVolume || 80 : 0);
      ui.voicePreset.value = 'custom';
      saveVolumes();
    });
    ui.tracksContainer.append(row);
    updateTrackRow(track);
  }
  ui.voicePreset.replaceChildren(new Option('Własne ustawienia', 'custom'), new Option('Wszystkie głosy', 'all'));
  activeSong.tracks.filter(track => !track.isClick).forEach(track => ui.voicePreset.add(new Option(track.name, track.id)));
  ui.voicePreset.value = 'custom';
}

function updateTrackRow(track) {
  const row = [...ui.tracksContainer.children].find(element => element.dataset.voice === track.id);
  if (!row) return;
  const volume = volumes[track.id];
  row.querySelector('input').value = String(volume);
  row.querySelector('input').setAttribute('aria-valuetext', `${volume}%`);
  row.querySelector('.volume-value').textContent = `${volume}%`;
  const button = row.querySelector('button');
  button.classList.toggle('muted', volume === 0);
  button.setAttribute('aria-pressed', String(volume === 0));
  button.setAttribute('aria-label', `${volume === 0 ? 'Włącz' : 'Wycisz'}: ${track.name}`);
}

function setTrackVolume(id, volume) {
  if (volume > 0) previousVolumes[id] = volume;
  volumes[id] = volume;
  mixer.setVolume(id, volume);
  updateTrackRow(activeSong.tracks.find(track => track.id === id));
}

function saveVolumes() {
  saveSetting(`song:${activeSong.id}`, { volumes, previousVolumes });
}

async function selectSong(id, updateUrl = true) {
  const song = songs.find(item => item.id === id);
  if (!song) return;
  const version = ++loadVersion;
  activeSong = song;
  enableTransport(false);
  loop = { start: null, end: null, enabled: false };
  ui.notice.textContent = '';
  ui.shareStatus.textContent = '';
  ui.shareLink.hidden = true;
  ui.loadStatus.hidden = false;
  ui.loadStatus.classList.remove('has-error');
  ui.retryBtn.hidden = true;
  ui.loadMessage.textContent = 'Ładowanie nagrań…';
  ui.loadingBar.style.width = '0%';
  ui['mixer-container'].hidden = false;
  ui.songTitle.textContent = song.title;
  ui.songMeta.textContent = song.meta || '';
  document.title = `${song.title} — Choir Voice Mixer`;
  const saved = readSetting(`song:${song.id}`);
  volumes = {};
  previousVolumes = {};
  for (const track of song.tracks) {
    const savedVolume = saved?.volumes?.[track.id];
    volumes[track.id] = Number.isFinite(savedVolume) && savedVolume >= 0 && savedVolume <= 100 ? savedVolume : track.defaultVolume;
    const oldVolume = saved?.previousVolumes?.[track.id];
    previousVolumes[track.id] = Number.isFinite(oldVolume) && oldVolume > 0 && oldVolume <= 100 ? oldVolume : track.defaultVolume || 80;
  }
  renderTracks();
  renderLoop();
  renderTime({});
  for (const button of ui.songSelector.children) {
    const active = button.dataset.song === id;
    button.classList.toggle('active', active);
    button.setAttribute('aria-pressed', String(active));
    if (active) button.scrollIntoView({ block: 'nearest', inline: 'center' });
  }
  if (updateUrl) {
    const url = new URL(location.href);
    url.searchParams.set('song', id);
    history.replaceState(null, '', url);
  }
  saveSetting('lastSong', id);
  try {
    await mixer.load(song.tracks.map(track => ({ ...track, defaultVolume: volumes[track.id] })));
    if (version !== loadVersion) return;
    // Sliders remain usable during loading; apply the latest values after load.
    for (const track of song.tracks) mixer.setVolume(track.id, volumes[track.id]);
    ui.loadStatus.hidden = true;
    enableTransport(true);
    renderTime({ currentTime: 0, duration: mixer.duration });
    if (!storageAvailable) ui.notice.textContent = 'Ustawienia są dostępne w tej karcie; przeglądarka nie pozwala ich zapisać.';
  } catch (error) {
    if (version === loadVersion && error.name !== 'AbortError') showError(error.message);
  }
}

function renderLoop() {
  const valid = loop.start !== null && loop.end !== null && loop.end - loop.start >= 1;
  ui.loopBtn.disabled = !ready || !valid;
  ui.clearLoopBtn.disabled = loop.start === null && loop.end === null;
  ui.loopBtn.setAttribute('aria-pressed', String(loop.enabled));
  ui.loopBtn.textContent = loop.enabled ? 'Wyłącz pętlę' : 'Włącz pętlę';
  ui.setABtn.textContent = loop.start === null ? 'Ustaw A' : `A · ${formatTime(loop.start)}`;
  ui.setBBtn.textContent = loop.end === null ? 'Ustaw B' : `B · ${formatTime(loop.end)}`;
  ui.loopStatus.textContent = valid ? `${loop.enabled ? 'Powtarzanie' : 'Wybrany fragment'}: ${formatTime(loop.start)} – ${formatTime(loop.end)}` : loop.start !== null ? 'Przewiń do końca fragmentu i ustaw B (co najmniej sekundę po A).' : 'Ustaw początek A i koniec B, żeby powtarzać trudny fragment.';
}

function applyLoop() {
  mixer.setLoop(loop.start || 0, loop.end || mixer.duration, loop.enabled);
  renderLoop();
}

async function runAction(action) {
  try { await action(); }
  catch (error) { if (error.name !== 'AbortError') showError(error.message); }
}

function togglePlay() {
  if (!ready) return;
  if (mixer.state === 'playing' || mixer.state === 'starting') mixer.pause();
  else {
    ui.loadStatus.hidden = true;
    runAction(() => mixer.play());
  }
}

ui.playBtn.addEventListener('click', togglePlay);
ui.rewindBtn.addEventListener('click', () => runAction(() => mixer.seek(mixer.currentTime - 10)));
ui.forwardBtn.addEventListener('click', () => runAction(() => mixer.seek(mixer.currentTime + 10)));
ui.seekSlider.addEventListener('input', () => {
  seeking = true;
  ui.currentTime.textContent = formatTime(Number(ui.seekSlider.value));
});
ui.seekSlider.addEventListener('change', () => {
  const value = Number(ui.seekSlider.value);
  // Native ranges round their maximum down to a step; End should still reach
  // the actual end of an MP3 with a fractional duration.
  const time = value >= mixer.duration - 0.1 ? mixer.duration : value;
  seeking = false;
  runAction(() => mixer.seek(time));
});
ui.seekSlider.addEventListener('blur', () => { seeking = false; });
ui.seekSlider.addEventListener('pointercancel', () => { seeking = false; });
ui.voicePreset.addEventListener('change', () => {
  const selected = ui.voicePreset.value;
  if (selected === 'custom') return;
  for (const track of activeSong.tracks) setTrackVolume(track.id, selected === 'all' ? track.defaultVolume : track.id === selected ? 100 : track.isClick ? Math.min(track.defaultVolume, 30) : 30);
  saveVolumes();
});
ui.resetBtn.addEventListener('click', () => {
  for (const track of activeSong.tracks) setTrackVolume(track.id, track.defaultVolume);
  ui.voicePreset.value = 'all';
  saveVolumes();
});
ui.setABtn.addEventListener('click', () => {
  loop.start = Math.min(mixer.currentTime, Math.max(0, mixer.duration - 1));
  if (loop.end !== null && loop.end - loop.start < 1) loop.end = null;
  loop.enabled = false;
  applyLoop();
});
ui.setBBtn.addEventListener('click', () => {
  if (loop.start === null) loop.start = 0;
  const end = mixer.currentTime;
  if (end - loop.start < 1) {
    ui.loopStatus.textContent = 'Punkt B musi być co najmniej sekundę po A. Przewiń dalej i ustaw B.';
    return;
  }
  loop.end = end;
  loop.enabled = true;
  applyLoop();
});
ui.loopBtn.addEventListener('click', () => { loop.enabled = !loop.enabled; applyLoop(); });
ui.clearLoopBtn.addEventListener('click', () => { loop = { start: null, end: null, enabled: false }; applyLoop(); });
ui.retryBtn.addEventListener('click', () => activeSong ? selectSong(activeSong.id) : init());
ui.shareBtn.addEventListener('click', async () => {
  const url = new URL(location.href);
  url.searchParams.set('song', activeSong.id);
  url.hash = '';
  ui.shareLink.value = url.href;
  try {
    await navigator.clipboard.writeText(url.href);
    ui.shareStatus.textContent = 'Link do utworu skopiowany.';
  } catch {
    ui.shareLink.hidden = false;
    ui.shareLink.focus();
    ui.shareLink.select();
    ui.shareStatus.textContent = 'Skopiuj zaznaczony link do utworu.';
  }
});
document.addEventListener('keydown', event => {
  if (!ready || event.altKey || event.ctrlKey || event.metaKey || event.target.closest('input, select, textarea, button, a, [contenteditable="true"]')) return;
  if (event.code === 'Space') { event.preventDefault(); togglePlay(); }
  if (event.code === 'ArrowLeft' || event.code === 'ArrowRight') {
    event.preventDefault();
    runAction(() => mixer.seek(mixer.currentTime + (event.code === 'ArrowRight' ? 5 : -5)));
  }
});
window.addEventListener('popstate', () => {
  const id = new URL(location.href).searchParams.get('song');
  if (songs.some(song => song.id === id)) selectSong(id, false);
});
window.addEventListener('pagehide', () => mixer.pause());

async function init() {
  ui.loadStatus.hidden = false;
  ui.loadStatus.classList.remove('has-error');
  ui.loadMessage.textContent = 'Ładowanie listy utworów…';
  ui.retryBtn.hidden = true;
  enableTransport(false);
  try {
    const response = await fetch('songs.json', { cache: 'no-cache' });
    if (!response.ok) throw new Error('Nie udało się pobrać listy utworów. Sprawdź połączenie i spróbuj ponownie.');
    songs = validateConfig(await response.json());
    renderSelector();
    const requested = new URL(location.href).searchParams.get('song');
    const lastSong = readSetting('lastSong');
    const selected = songs.find(song => song.id === requested) || songs.find(song => song.id === lastSong) || songs[0];
    await selectSong(selected.id);
    if (requested && !songs.some(song => song.id === requested)) ui.notice.textContent = 'Utworu z tego linku nie ma na liście. Wybierz jeden z dostępnych utworów.';
  } catch (error) {
    showError(error instanceof SyntaxError ? 'Lista utworów ma nieprawidłowy format. Spróbuj ponownie później.' : error.message);
  }
}

init();
