import test from 'node:test';
import assert from 'node:assert/strict';
import { probeUrl, parseHlsManifest, STATUS } from '../src/scanner.js';
import { assertPublicTarget, isPrivateIp } from '../src/security.js';

function response(body, {status=200, contentType='video/mp2t', url='https://example.com/live.ts', headers={}}={}) {
  return new Response(body, {status, headers:{'content-type':contentType, ...headers}});
}

function tsPacket() {
  const packet = new Uint8Array(188 * 3);
  packet[0]=0x47; packet[188]=0x47; packet[376]=0x47;
  return packet;
}

test('classifies an MPEG-TS-like response as online', async () => {
  const result = await probeUrl('https://example.com/live.ts', {}, async () => response(tsPacket()));
  assert.equal(result.status, STATUS.ONLINE);
  assert.equal(result.confidence, 'high');
  assert.equal(result.evidence, 'MPEG-TS');
});

test('distinguishes authentication from a dead endpoint', async () => {
  const result = await probeUrl('https://example.com/secure.m3u8', {}, async () => response('', {status:401,contentType:'text/plain'}));
  assert.equal(result.status, STATUS.AUTH_REQUIRED);
});

test('recognizes a valid HLS media manifest without calling it online', async () => {
  const manifest = '#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXTINF:6,\nseg1.ts\n';
  const result = await probeUrl('https://example.com/live.m3u8', {deepHls:false}, async () => response(manifest,{contentType:'application/vnd.apple.mpegurl'}));
  assert.equal(result.status, STATUS.MANIFEST_ONLY);
  assert.equal(result.hls.type, 'media');
  assert.equal(result.evidence, 'valid-hls-manifest');
});

test('follows an HLS master through a media playlist into a real media resource', async () => {
  const calls=[];
  const fetchImpl = async (url) => {
    calls.push(url);
    if (url.endsWith('master.m3u8')) return response('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1000,RESOLUTION=640x360\nchild.m3u8\n',{contentType:'application/vnd.apple.mpegurl',url});
    if (url.endsWith('child.m3u8')) return response('#EXTM3U\n#EXTINF:5,\nseg.ts\n',{contentType:'application/vnd.apple.mpegurl',url});
    return response(tsPacket(),{contentType:'video/mp2t',url});
  };
  const result=await probeUrl('https://example.com/master.m3u8',{deepHls:true,maxHlsDepth:2},fetchImpl,()=>Promise.resolve());
  assert.equal(result.status,STATUS.ONLINE);
  assert.equal(result.hls.verifiedResources,1);
  assert.deepEqual(calls,['https://example.com/master.m3u8','https://example.com/child.m3u8','https://example.com/seg.ts']);
});

test('does not call an arbitrary non-empty HLS child online', async () => {
  const fetchImpl = async (url) => {
    if (url.endsWith('master.m3u8')) return response('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1000\nchild.m3u8\n',{contentType:'application/vnd.apple.mpegurl',url});
    return response('hello world',{contentType:'text/plain',url});
  };
  const result=await probeUrl('https://example.com/master.m3u8',{deepHls:true,maxHlsDepth:1},fetchImpl,()=>Promise.resolve());
  assert.equal(result.status,STATUS.MANIFEST_ONLY);
});

test('handles transient server errors with retry', async () => {
  let attempts = 0;
  const result = await probeUrl('https://example.com/live.ts', {retries:1}, async () => {
    attempts += 1;
    if (attempts === 1) return response('', {status:503, contentType:'text/plain'});
    return response(tsPacket(), {contentType:'video/mp2t'});
  });
  assert.equal(result.status, STATUS.ONLINE);
  assert.equal(attempts, 2);
});

test('classifies rate limiting separately and honors Retry-After', async () => {
  let attempts = 0;
  const result = await probeUrl('https://example.com/live.ts', {retries:1, timeoutMs:1500}, async () => {
    attempts += 1;
    if (attempts === 1) return response('', {status:429, contentType:'text/plain', headers:{'retry-after':'0'}});
    return response(tsPacket(), {contentType:'video/mp2t'});
  });
  assert.equal(result.status, STATUS.ONLINE);
  assert.equal(attempts, 2);
});

test('records redirect destination and verifies the final response', async () => {
  const calls=[];
  const fetchImpl = async (url) => {
    calls.push(url);
    if (url === 'https://example.com/start') return new Response('', {status:302, headers:{location:'/live.ts'}});
    return response(tsPacket(), {contentType:'video/mp2t', url});
  };
  const result = await probeUrl('https://example.com/start', {}, fetchImpl, () => Promise.resolve());
  assert.equal(result.status, STATUS.ONLINE);
  assert.equal(result.finalUrl, 'https://example.com/live.ts');
  assert.equal(result.redirects, 1);
  assert.deepEqual(calls, ['https://example.com/start','https://example.com/live.ts']);
});

test('parses HLS BOM and LL-HLS parts', () => {
  const parsed = parseHlsManifest('\uFEFF#EXTM3U\n#EXT-X-PART:DURATION=0.5,URI="part001.ts"\n#EXT-X-PRELOAD-HINT:TYPE=PART,URI="part002.ts"\n', 'https://example.com/live.m3u8');
  assert.equal(parsed.valid, true);
  assert.equal(parsed.type, 'media');
  assert.equal(parsed.parts.length, 1);
  assert.equal(parsed.preload, 'https://example.com/part002.ts');
});

test('blocks private IPs and IPv4-mapped IPv6 addresses', async () => {
  await assert.rejects(() => assertPublicTarget('http://192.168.1.1/live.ts'), /private/i);
  assert.equal(isPrivateIp('::ffff:192.168.1.1'), true);
});

test('detects HTML false positives', async () => {
  const result = await probeUrl('https://example.com/login', {}, async () => response('<!doctype html><html><body>login</body></html>', {contentType:'text/html',url:'https://example.com/login'}));
  assert.equal(result.status, STATUS.UNEXPECTED_CONTENT);
});

test('marks a successful browser no-cors fallback as responds, not offline', async () => {
  const previousWindow = globalThis.window;
  const previousDocument = globalThis.document;
  globalThis.window = { location: { protocol: 'http:' } };
  globalThis.document = {};
  try {
    let calls = 0;
    const fetchImpl = async (_url, init = {}) => {
      calls += 1;
      if (init.mode === 'no-cors') return {type:'opaque', status:0};
      throw new TypeError('Failed to fetch');
    };
    const result = await probeUrl('https://cross-origin.example/live.ts', {}, fetchImpl);
    assert.equal(result.status, STATUS.REACHABLE);
    assert.equal(result.evidence, 'cors-opaque');
    assert.equal(calls, 2);
  } finally {
    if (previousWindow === undefined) delete globalThis.window; else globalThis.window = previousWindow;
    if (previousDocument === undefined) delete globalThis.document; else globalThis.document = previousDocument;
  }
});
