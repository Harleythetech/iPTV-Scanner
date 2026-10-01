import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseM3U, buildM3U, buildCsv } from './src/m3u.js';
import { scanEntries, normaliseOptions } from './src/scanner.js';
import { assertPublicTarget } from './src/security.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = ROOT;
const PORT = Number(process.env.PORT || 4199);
const PLAYLIST_TIMEOUT_MS = Number(process.env.PLAYLIST_TIMEOUT_MS || 15000);
const MAX_PLAYLIST_BYTES = 8 * 1024 * 1024;
const MAX_ENTRIES = 5000;
const ALLOW_PRIVATE_TARGETS = process.env.ALLOW_PRIVATE_TARGETS === 'true';

function json(res, status, value) { res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); res.end(JSON.stringify(value)); }
function send(res, status, contentType, body, extra = {}) { res.writeHead(status, { 'content-type': contentType, ...extra }); res.end(body); }
function readBody(req, maxBytes = MAX_PLAYLIST_BYTES) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', chunk => { size += chunk.length; if (size > maxBytes) { reject(Object.assign(new Error('Request too large.'), { statusCode: 413 })); req.destroy(); return; } chunks.push(chunk); });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8'))); req.on('error', reject);
  });
}

async function fetchPlaylistText(url) {
  let current = url;
  for (let i = 0; i <= 3; i += 1) {
    await assertPublicTarget(current, { allowPrivateTargets: ALLOW_PRIVATE_TARGETS });
    const response = await fetch(current, {
      redirect: 'manual',
      signal: AbortSignal.timeout(PLAYLIST_TIMEOUT_MS),
      headers: { Accept: 'application/vnd.apple.mpegurl, application/x-mpegURL, text/plain, */*', 'User-Agent': 'iPTV-Scanner/1.2' }
    });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get('location'); if (!location) break; current = new URL(location, current).href; continue;
    }
    if (!response.ok) throw Object.assign(new Error(`Playlist URL returned HTTP ${response.status}.`), { statusCode: response.status });
    const length = Number(response.headers.get('content-length') || 0); if (length > MAX_PLAYLIST_BYTES) throw Object.assign(new Error('Playlist is larger than the server limit.'), { statusCode: 413 });
    const text = await response.text(); if (Buffer.byteLength(text, 'utf8') > MAX_PLAYLIST_BYTES) throw Object.assign(new Error('Playlist is larger than the server limit.'), { statusCode: 413 });
    return { text, finalUrl: current, contentType: response.headers.get('content-type') || '' };
  }
  throw Object.assign(new Error('Too many playlist redirects.'), { statusCode: 400 });
}

function pickUrl(body) { return String(body?.url || '').trim(); }
async function handleApi(req, res, pathname) {
  if (pathname === '/api/health') return json(res, 200, { ok: true, version: '1.2.0' });
  if (pathname === '/api/playlist' && req.method === 'POST') {
    const body = JSON.parse(await readBody(req, 256 * 1024)); const url = pickUrl(body); if (!url) return json(res, 400, { error: 'A playlist URL is required.' });
    const remote = await fetchPlaylistText(url); const parsed = parseM3U(remote.text, { sourceUrl: remote.finalUrl });
    if (!parsed.entries.length) return json(res, 422, { error: 'No channel URLs were found in the playlist.', warnings: parsed.warnings });
    if (parsed.entries.length > MAX_ENTRIES) return json(res, 413, { error: `Playlist exceeds the ${MAX_ENTRIES} channel limit.` });
    return json(res, 200, { source: remote.finalUrl, contentType: remote.contentType, ...parsed });
  }
  if (pathname === '/api/scan' && req.method === 'POST') {
    const body = JSON.parse(await readBody(req));
    const entries = Array.isArray(body.entries)
      ? body.entries.slice(0, MAX_ENTRIES).map((entry, index) => ({
          ...(entry && typeof entry === 'object' ? entry : {}),
          index,
          name: String(entry?.name || 'Untitled channel'),
          group: String(entry?.group || 'Uncategorized'),
          url: String(entry?.url || '').trim(),
        }))
      : [];
    if (!entries.length) return json(res, 400, { error: 'No playlist entries were supplied.' });
    const controller = new AbortController(); req.on('aborted', () => controller.abort());
    const options = normaliseOptions({ ...(body.options || {}), allowPrivateTargets: ALLOW_PRIVATE_TARGETS });
    const result = await scanEntries(entries, options, () => {}, controller.signal, (url, opts) => assertPublicTarget(url, opts));
    return json(res, 200, { ...result, exportM3U: buildM3U(result.results.filter(r => r.status === 'online')), exportCsv: buildCsv(result.results) });
  }
  return json(res, 404, { error: 'Not found.' });
}

async function serveStatic(req, res, pathname) {
  const requested = pathname === '/' ? '/index.html' : pathname; const file = path.normalize(path.join(PUBLIC, requested));
  if (!file.startsWith(PUBLIC)) return send(res, 403, 'text/plain; charset=utf-8', 'Forbidden');
  try { const data = await fs.readFile(file); const type = file.endsWith('.html') ? 'text/html; charset=utf-8' : file.endsWith('.css') ? 'text/css; charset=utf-8' : 'text/javascript; charset=utf-8'; return send(res, 200, type, data, { 'cache-control': 'no-cache' }); }
  catch { return send(res, 404, 'text/plain; charset=utf-8', 'Not found'); }
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    if (url.pathname.startsWith('/api/')) await handleApi(req, res, url.pathname); else await serveStatic(req, res, url.pathname);
  } catch (error) { json(res, error.statusCode || 500, { error: error.message || 'Internal server error.' }); }
});
server.listen(PORT, () => console.log(`iPTV-Scanner listening on http://localhost:${PORT}`));
