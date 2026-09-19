#!/usr/bin/env node
// Local preview with byte ranges so HTMLAudioElement seeking works correctly.
import { createServer } from 'node:http';
import { createReadStream, realpathSync } from 'node:fs';
import { realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = realpathSync(fileURLToPath(new URL('..', import.meta.url)));
const host = '127.0.0.1';
const port = 8000;
const mimeTypes = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function withinRoot(filename) {
  const relative = path.relative(root, filename);
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function byteRange(header, size) {
  if (!header || !header.toLowerCase().startsWith('bytes=')) return null;
  // Multiple ranges are optional; serve the complete representation instead.
  if (header.includes(',')) return null;
  const match = /^bytes=(\d*)-(\d*)$/i.exec(header);
  if (!match || (!match[1] && !match[2]) || size === 0) return false;
  let start;
  let end;
  if (!match[1]) {
    const suffix = Number(match[2]);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return false;
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] ? Number(match[2]) : size - 1;
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start >= size || start > end) return false;
    end = Math.min(end, size - 1);
  }
  return { start, end };
}

const server = createServer(async (request, response) => {
  const empty = (status, headers = {}) => {
    response.writeHead(status, { 'Content-Length': 0, ...headers });
    response.end();
  };
  if (!['GET', 'HEAD'].includes(request.method)) {
    empty(405, { Allow: 'GET, HEAD' });
    return;
  }
  let pathname;
  try { pathname = decodeURIComponent(request.url.split('?')[0]); }
  catch { empty(400); return; }
  if (!pathname.startsWith('/') || /[\\:\u0000]/.test(pathname)) {
    empty(400);
    return;
  }
  const segments = pathname.split('/').filter(Boolean);
  if (segments.some(segment => segment.startsWith('.'))) {
    empty(403);
    return;
  }
  if (segments.length === 0) segments.push('index.html');
  const filename = path.resolve(root, ...segments);
  if (!withinRoot(filename)) { empty(403); return; }

  try {
    const resolved = await realpath(filename);
    if (!withinRoot(resolved)) { empty(403); return; }
    const info = await stat(resolved);
    if (!info.isFile()) { empty(404); return; }
    const headers = {
      'Content-Type': mimeTypes[path.extname(resolved).toLowerCase()] || 'application/octet-stream',
      'Content-Length': info.size,
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'no-cache',
      'X-Content-Type-Options': 'nosniff',
    };
    // HTTP ranges apply to GET; HEAD returns the full representation's headers.
    const range = request.method === 'GET' ? byteRange(request.headers.range, info.size) : null;
    if (range === false) {
      empty(416, { ...headers, 'Content-Length': 0, 'Content-Range': `bytes */${info.size}` });
      return;
    }
    if (range) {
      headers['Content-Range'] = `bytes ${range.start}-${range.end}/${info.size}`;
      headers['Content-Length'] = range.end - range.start + 1;
    }
    response.writeHead(range ? 206 : 200, headers);
    if (request.method === 'HEAD' || info.size === 0) { response.end(); return; }
    const stream = createReadStream(resolved, range || undefined);
    stream.on('error', () => response.destroy());
    response.on('close', () => stream.destroy());
    stream.pipe(response);
  } catch (error) {
    empty(error.code === 'ENOENT' || error.code === 'ENOTDIR' ? 404 : 500);
  }
});

server.on('error', error => {
  console.error(`Nie można uruchomić podglądu: ${error.message}`);
  process.exitCode = 1;
});
server.listen(port, host, () => console.log(`Choir Voice Mixer: http://${host}:${port}`));
