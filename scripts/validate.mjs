#!/usr/bin/env node
// Local, read-only validation. Requires Node.js and ffprobe on PATH.
import { readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = realpathSync(fileURLToPath(new URL('..', import.meta.url)));
const ffprobe = process.env.FFPROBE_PATH || 'ffprobe';
const badgeClasses = new Set([
  'sop', 'sop-h', 'sop-l', 'alt', 'tenor', 'bas', 'click', 'piano',
  'motyw-a', 'motyw-b', 'motyw-c',
]);
const identifier = /^[a-z0-9]+(?:[_-][a-z0-9]+)*$/;
const safeSegment = /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/;
const errors = [];
const warnings = [];
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const nonempty = value => typeof value === 'string' && value.trim().length > 0;
const fail = (location, message) => errors.push(`${location}: ${message}`);

function requiredText(object, key, location) {
  if (!nonempty(object[key])) fail(location, `pole „${key}” musi być niepustym tekstem.`);
}

function safeAudioPath(file, songId, location) {
  if (typeof file !== 'string') {
    fail(location, 'pole „file” musi wskazywać audio/<id_utworu>/<plik>.mp3.');
    return null;
  }
  const parts = file.split('/');
  if (parts.length < 3 || parts[0] !== 'audio' || parts[1] !== songId ||
      parts.some(part => !safeSegment.test(part) || part === '.' || part === '..') ||
      !parts.at(-1).endsWith('.mp3')) {
    fail(location, `nieprawidłowa ścieżka „${file}”; użyj audio/${songId}/<plik>.mp3, ukośników / i bez segmentów .., URL ani znaków specjalnych.`);
    return null;
  }
  let current = root;
  for (const segment of parts) {
    try {
      const entries = readdirSync(current);
      if (!entries.includes(segment)) {
        const caseMatch = entries.find(entry => entry.toLowerCase() === segment.toLowerCase());
        fail(location, caseMatch
          ? `wielkość liter w „${file}” nie zgadza się z plikiem: „${segment}” powinno być „${caseMatch}”. Netlify rozróżnia wielkość liter.`
          : `brakuje „${segment}” w „${path.relative(root, current) || '.'}”; dodaj plik albo popraw pole „file”.`);
        return null;
      }
      current = path.join(current, segment);
      const relative = path.relative(root, realpathSync(current));
      if (relative.startsWith(`..${path.sep}`) || relative === '..' || path.isAbsolute(relative)) {
        fail(location, `„${file}” prowadzi poza katalog aplikacji; użyj lokalnego pliku w audio/${songId}/.`);
        return null;
      }
    } catch (error) {
      fail(location, `nie można odczytać „${file}”: ${error.message}`);
      return null;
    }
  }
  if (!statSync(current).isFile()) {
    fail(location, `„${file}” nie jest zwykłym plikiem.`);
    return null;
  }
  return current;
}

function probeAudio(filename, location) {
  // Decode all frames to verify readability and count samples after MP3 padding.
  const result = spawnSync(ffprobe, [
    '-v', 'error', '-select_streams', 'a:0', '-show_frames',
    '-show_entries', 'frame=nb_samples:stream=codec_name,sample_rate,channels,duration:format=duration',
    '-of', 'json', filename,
  ], { encoding: 'utf8', timeout: 120_000, maxBuffer: 64 * 1024 * 1024, windowsHide: true });
  if (result.error || result.status !== 0 || result.stderr.trim()) {
    fail(location, `ffprobe nie potwierdził poprawnego odczytu; ponownie wyeksportuj MP3 ze źródła. ${result.error?.message || result.stderr.trim() || `kod wyjścia ${result.status}`}`);
    return null;
  }
  try {
    const data = JSON.parse(result.stdout);
    const stream = data.streams?.[0];
    const sampleRate = Number(stream?.sample_rate);
    const channels = Number(stream?.channels);
    const samples = data.frames?.reduce((sum, frame) => sum + Number(frame.nb_samples || 0), 0);
    const containerDuration = Number(stream?.duration || data.format?.duration);
    if (stream?.codec_name !== 'mp3' || !Number.isInteger(sampleRate) || sampleRate <= 0 ||
        !Number.isInteger(channels) || channels <= 0 || !Number.isSafeInteger(samples) || samples <= 0 ||
        !Number.isFinite(containerDuration) || containerDuration <= 0) {
      fail(location, 'plik musi zawierać odczytywalne audio MP3 z dodatnią długością, liczbą próbek, kanałów i częstotliwością próbkowania.');
      return null;
    }
    return { sampleRate, channels, samples, duration: samples / sampleRate };
  } catch (error) {
    fail(location, `nie można odczytać wyniku ffprobe: ${error.message}`);
    return null;
  }
}

let config;
try {
  config = JSON.parse(readFileSync(path.join(root, 'songs.json'), 'utf8').replace(/^\uFEFF/, ''));
} catch (error) {
  console.error(`BŁĄD songs.json: ${error.message}`);
  process.exit(1);
}
if (!isObject(config) || !Array.isArray(config.songs) || config.songs.length === 0) {
  console.error('BŁĄD songs.json: wymagany obiekt z niepustą tablicą „songs”.');
  process.exit(1);
}
const probeVersion = spawnSync(ffprobe, ['-version'], { encoding: 'utf8', windowsHide: true, timeout: 10_000 });
const probeAvailable = !probeVersion.error && probeVersion.status === 0;
if (!probeAvailable) fail('ffprobe', 'program niedostępny. Zainstaluj FFmpeg i dodaj ffprobe do PATH lub ustaw FFPROBE_PATH na plik wykonywalny.');

const songIds = new Set();
let trackCount = 0;
let validatedAudio = 0;
for (const [songIndex, song] of config.songs.entries()) {
  const location = `songs[${songIndex}]`;
  if (!isObject(song)) {
    fail(location, 'utwór musi być obiektem.');
    continue;
  }
  const songLocation = `${location} (${song.id ?? '?'})`;
  if (typeof song.id !== 'string' || !identifier.test(song.id)) fail(songLocation, '„id” musi zawierać małe litery ASCII, cyfry oraz opcjonalne pojedyncze _ lub - między członami.');
  if (songIds.has(song.id)) fail(songLocation, `powtórzony identyfikator utworu „${song.id}”; nadaj unikalne id.`);
  songIds.add(song.id);
  requiredText(song, 'title', songLocation);
  requiredText(song, 'meta', songLocation);
  if ('audioOffset' in song && (typeof song.audioOffset !== 'number' || !Number.isFinite(song.audioOffset) || song.audioOffset < 0)) {
    fail(songLocation, '„audioOffset”, jeśli podane, musi być liczbą >= 0 (pole informacyjne, odtwarzacz go nie stosuje).');
  }
  if (!Array.isArray(song.tracks) || song.tracks.length === 0) {
    fail(songLocation, 'wymagana niepusta tablica „tracks”.');
    continue;
  }
  const trackIds = new Set();
  const files = new Set();
  const audio = [];
  for (const [trackIndex, track] of song.tracks.entries()) {
    trackCount++;
    const trackLocation = `${songLocation}.tracks[${trackIndex}]`;
    if (!isObject(track)) {
      fail(trackLocation, 'ścieżka musi być obiektem.');
      continue;
    }
    if (typeof track.id !== 'string' || !identifier.test(track.id)) fail(trackLocation, '„id” ścieżki musi zawierać małe litery ASCII, cyfry oraz opcjonalne pojedyncze _ lub - między członami.');
    if (trackIds.has(track.id)) fail(trackLocation, `powtórzone id ścieżki „${track.id}”; identyfikatory muszą być unikalne w obrębie utworu.`);
    trackIds.add(track.id);
    for (const key of ['name', 'badge']) requiredText(track, key, trackLocation);
    if (!badgeClasses.has(track.badgeClass)) fail(trackLocation, `nieznana „badgeClass”; użyj jednej z: ${[...badgeClasses].join(', ')}.`);
    if (typeof track.defaultVolume !== 'number' || !Number.isFinite(track.defaultVolume) || track.defaultVolume < 0 || track.defaultVolume > 100) {
      fail(trackLocation, '„defaultVolume” musi być liczbą od 0 do 100.');
    }
    if ('isClick' in track && typeof track.isClick !== 'boolean') fail(trackLocation, '„isClick”, jeśli podane, musi mieć wartość true lub false.');
    if (files.has(track.file)) fail(trackLocation, `plik „${track.file}” przypisano do więcej niż jednego głosu; sprawdź przypisanie partii.`);
    files.add(track.file);
    const filename = safeAudioPath(track.file, song.id, trackLocation);
    if (filename && probeAvailable) {
      const metadata = probeAudio(filename, `${trackLocation} (${track.file})`);
      if (metadata) {
        validatedAudio++;
        audio.push({ id: track.id, ...metadata });
      }
    }
  }
  if (audio.length > 0) {
    const min = Math.min(...audio.map(track => track.duration));
    const max = Math.max(...audio.map(track => track.duration));
    console.log(`${song.id}: ${audio.map(track => `${track.id} ${track.duration.toFixed(3)} s / ${track.sampleRate} Hz / ${track.channels} kan. / ${track.samples} próbek`).join('; ')}`);
    if (max - min > 0.001) warnings.push(`${song.id}: długości głosów różnią się o ${(max - min).toFixed(3)} s. Sprawdź wspólny początek i koniec w plikach źródłowych; nie przycinaj ani nie rozciągaj partii automatycznie. Istniejący repertuar może celowo mieć różne długości.`);
    if (new Set(audio.map(track => track.sampleRate)).size > 1) warnings.push(`${song.id}: różne częstotliwości próbkowania. Przy nowych eksportach stosuj wspólne ustawienia dla wszystkich głosów.`);
  }
}
for (const warning of warnings) console.warn(`UWAGA ${warning}`);
for (const error of errors) console.error(`BŁĄD ${error}`);
console.log(`\n${config.songs.length} utworów, ${trackCount} ścieżek, ${validatedAudio} poprawnie odczytanych MP3; ${errors.length} błędów, ${warnings.length} ostrzeżeń.`);
console.log('Równa długość nie potwierdza zgodności muzycznej początku: nowe utwory sprawdź również odsłuchem.');
process.exitCode = errors.length ? 1 : 0;
