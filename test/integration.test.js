import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { probeUrl, STATUS } from '../src/scanner.js';

function tsPacket() {
  const packet = new Uint8Array(188 * 3);
  packet[0]=0x47; packet[188]=0x47; packet[376]=0x47;
  return packet;
}

function startFixture() {
  return new Promise(resolve => {
    const server = http.createServer((req, res) => {
      if (req.url === '/live.ts') {
        const body = Buffer.from(tsPacket());
        res.writeHead(req.headers.range ? 206 : 200, {'content-type':'video/mp2t', 'content-length':body.length});
        res.end(body);
        return;
      }
      if (req.url === '/range-fallback.ts') {
        if (req.headers.range) { res.writeHead(416, {'content-type':'text/plain'}); res.end('range unsupported'); }
        else { const body=Buffer.from(tsPacket()); res.writeHead(200, {'content-type':'video/mp2t','content-length':body.length}); res.end(body); }
        return;
      }
      if (req.url === '/redirect') { res.writeHead(302, {location:'/live.ts'}); res.end(); return; }
      if (req.url === '/master.m3u8') { const body='#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1000\nmedia.m3u8\n'; res.writeHead(200, {'content-type':'application/vnd.apple.mpegurl'}); res.end(body); return; }
      if (req.url === '/media.m3u8') { const body='#EXTM3U\n#EXTINF:6,\nsegment.ts\n'; res.writeHead(200, {'content-type':'application/vnd.apple.mpegurl'}); res.end(body); return; }
      if (req.url === '/segment.ts') { const body=Buffer.from(tsPacket()); res.writeHead(200, {'content-type':'video/mp2t'}); res.end(body); return; }
      if (req.url === '/html') { res.writeHead(200, {'content-type':'text/html'}); res.end('<!doctype html><html>login</html>'); return; }
      res.writeHead(404); res.end();
    });
    server.listen(0, '127.0.0.1', () => resolve({server, port:server.address().port}));
  });
}

test('real HTTP fixture validates range probing, redirects, and HLS chains', async t => {
  const {server, port} = await startFixture();
  t.after(() => server.close());
  const guard = async () => {};
  const base = `http://127.0.0.1:${port}`;

  const direct = await probeUrl(`${base}/live.ts`, {}, globalThis.fetch, guard);
  assert.equal(direct.status, STATUS.ONLINE);
  assert.equal(direct.httpStatus, 206);
  assert.equal(direct.evidence, 'MPEG-TS');

  const fallback = await probeUrl(`${base}/range-fallback.ts`, {}, globalThis.fetch, guard);
  assert.equal(fallback.status, STATUS.ONLINE);
  assert.equal(fallback.httpStatus, 200);

  const redirect = await probeUrl(`${base}/redirect`, {}, globalThis.fetch, guard);
  assert.equal(redirect.status, STATUS.ONLINE);
  assert.equal(redirect.finalUrl, `${base}/live.ts`);

  const hls = await probeUrl(`${base}/master.m3u8`, {deepHls:true,maxHlsDepth:2}, globalThis.fetch, guard);
  assert.equal(hls.status, STATUS.ONLINE);
  assert.equal(hls.evidence, 'hls-media-resource');

  const html = await probeUrl(`${base}/html`, {}, globalThis.fetch, guard);
  assert.equal(html.status, STATUS.UNEXPECTED_CONTENT);
});
