const DEFAULTS = {
  concurrency: 8,
  timeoutMs: 7000,
  retries: 1,
  maxBytes: 32768,
  deepHls: true,
  maxHlsDepth: 2,
  maxHlsVariants: 2,
  maxHlsResources: 2,
  maxRedirects: 5,
  userAgent: 'iPTV-Scanner/1.2 (+https://github.com/Harleythetech/iPTV-Scanner)',
};

export const STATUS = Object.freeze({
  ONLINE: 'online',
  RESPONDS: 'responds',
  REACHABLE: 'reachable',
  MANIFEST_ONLY: 'manifest_only',
  DUPLICATE: 'duplicate',
  AUTH_REQUIRED: 'auth_required',
  FORBIDDEN: 'forbidden',
  NOT_FOUND: 'not_found',
  RATE_LIMITED: 'rate_limited',
  HTTP_ERROR: 'http_error',
  SERVER_ERROR: 'server_error',
  TIMEOUT: 'timeout',
  NETWORK_ERROR: 'network_error',
  NO_DATA: 'no_data',
  UNEXPECTED_CONTENT: 'unexpected_content',
  INVALID_URL: 'invalid_url',
  MIXED_CONTENT: 'mixed_content',
  REDIRECT_LIMIT: 'redirect_limit',
  UNKNOWN: 'unknown',
});

export const STATUS_META = Object.freeze({
  [STATUS.ONLINE]: { label: 'Online', tone: 'good' },
  [STATUS.RESPONDS]: { label: 'Responds', tone: 'neutral' },
  [STATUS.REACHABLE]: { label: 'Reachable (opaque)', tone: 'neutral' },
  [STATUS.MANIFEST_ONLY]: { label: 'Manifest only', tone: 'warn' },
  [STATUS.DUPLICATE]: { label: 'Duplicate', tone: 'muted' },
  [STATUS.AUTH_REQUIRED]: { label: 'Auth required', tone: 'warn' },
  [STATUS.FORBIDDEN]: { label: 'Forbidden', tone: 'warn' },
  [STATUS.NOT_FOUND]: { label: 'Not found', tone: 'bad' },
  [STATUS.RATE_LIMITED]: { label: 'Rate limited', tone: 'warn' },
  [STATUS.HTTP_ERROR]: { label: 'HTTP error', tone: 'bad' },
  [STATUS.SERVER_ERROR]: { label: 'Server error', tone: 'bad' },
  [STATUS.TIMEOUT]: { label: 'Timeout', tone: 'bad' },
  [STATUS.NETWORK_ERROR]: { label: 'Network error', tone: 'bad' },
  [STATUS.NO_DATA]: { label: 'No data', tone: 'bad' },
  [STATUS.UNEXPECTED_CONTENT]: { label: 'Unexpected content', tone: 'warn' },
  [STATUS.INVALID_URL]: { label: 'Invalid URL', tone: 'bad' },
  [STATUS.MIXED_CONTENT]: { label: 'Mixed content', tone: 'warn' },
  [STATUS.REDIRECT_LIMIT]: { label: 'Redirect limit', tone: 'bad' },
  [STATUS.UNKNOWN]: { label: 'Unknown', tone: 'muted' },
});

const TRANSIENT_HTTP = new Set([408, 425, 429, 500, 502, 503, 504]);
const REDIRECTS = new Set([301, 302, 303, 307, 308]);
const HLS_CONTENT_TYPES = /(?:application\/vnd\.apple\.mpegurl|application\/x-mpegurl|audio\/mpegurl|audio\/x-mpegurl)/i;
const MEDIA_CONTENT_TYPES = /^(?:video|audio)\//i;
const STREAMISH_CONTENT_TYPES = /(?:mpegurl|mp2t|mp4|m4s|webm|matroska|ogg|aac|mpeg|flac)/i;
const MEDIA_EXTENSIONS = /\.(?:ts|m2ts|mp4|m4v|m4s|mov|mkv|webm|aac|adts|mp3|ogg|oga|opus|flac|mpg|mpeg)(?:$|[?#])/i;

export function normaliseOptions(options = {}) {
  return {
    concurrency: clampInt(options.concurrency, 1, 24, DEFAULTS.concurrency),
    timeoutMs: clampInt(options.timeoutMs, 1500, 30000, DEFAULTS.timeoutMs),
    retries: clampInt(options.retries, 0, 3, DEFAULTS.retries),
    maxBytes: clampInt(options.maxBytes, 4096, 131072, DEFAULTS.maxBytes),
    deepHls: options.deepHls !== false,
    maxHlsDepth: clampInt(options.maxHlsDepth, 0, 3, DEFAULTS.maxHlsDepth),
    maxHlsVariants: clampInt(options.maxHlsVariants, 1, 4, DEFAULTS.maxHlsVariants),
    maxHlsResources: clampInt(options.maxHlsResources, 1, 4, DEFAULTS.maxHlsResources),
    maxRedirects: clampInt(options.maxRedirects, 0, 8, DEFAULTS.maxRedirects),
    userAgent: String(options.userAgent || DEFAULTS.userAgent).slice(0, 300),
    allowPrivateTargets: options.allowPrivateTargets === true,
    resolveDns: options.resolveDns !== false,
    signal: options.signal || null,
    headers: options.headers && typeof options.headers === 'object' ? sanitiseHeaders(options.headers) : {},
  };
}

function clampInt(value, min, max, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.round(parsed)));
}

function nowMs() { return typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now(); }
function isAbortError(error) { return error?.name === 'AbortError' || /aborted/i.test(error?.message || ''); }
function delay(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
function isBrowserRuntime() { return typeof window !== 'undefined' && typeof document !== 'undefined'; }

function sanitiseHeaders(headers) {
  const allowed = new Set(['referer', 'origin', 'accept-language', 'cookie']);
  return Object.fromEntries(Object.entries(headers)
    .filter(([key, value]) => allowed.has(String(key).toLowerCase()) && value != null)
    .map(([key, value]) => [key, String(value).slice(0, 2048)]));
}

function makeRequestSignal(parentSignal, timeoutMs) {
  const controller = new AbortController();
  let timedOut = false;
  const timeoutId = setTimeout(() => { timedOut = true; controller.abort('timeout'); }, timeoutMs);
  const onAbort = () => controller.abort('parent-abort');
  parentSignal?.addEventListener('abort', onAbort, { once: true });
  return {
    signal: controller.signal,
    timedOut: () => timedOut,
    cleanup: () => {
      clearTimeout(timeoutId);
      parentSignal?.removeEventListener('abort', onAbort);
    },
  };
}

export async function assertPublicTarget() { return undefined; }

function isHlsCandidate(url, contentType = '') {
  return /\.m3u8(?:$|[?#])/i.test(url) || HLS_CONTENT_TYPES.test(contentType);
}

function decodeText(bytes) {
  try { return new TextDecoder('utf-8', { fatal: false }).decode(bytes); }
  catch { return ''; }
}

function textSample(bytes) { return decodeText(bytes.slice(0, Math.min(bytes.length, 4096))); }

function looksLikeHtml(text) {
  const sample = text.replace(/^\uFEFF/, '').trimStart().slice(0, 1200).toLowerCase();
  return sample.startsWith('<!doctype html') || sample.startsWith('<html') || sample.startsWith('<head') || /<html[\s>]/.test(sample);
}

function looksLikeJson(text) {
  const sample = text.replace(/^\uFEFF/, '').trimStart();
  return sample.startsWith('{') || sample.startsWith('[');
}

function looksLikeXmlError(text) {
  const sample = text.replace(/^\uFEFF/, '').trimStart().toLowerCase();
  return sample.startsWith('<?xml') || sample.startsWith('<error') || sample.startsWith('<response');
}

function looksLikePlainTextError(bytes) {
  if (bytes.length < 12 || bytes.some(byte => byte === 0)) return false;
  let printable = 0;
  for (const byte of bytes) {
    if (byte === 9 || byte === 10 || byte === 13 || (byte >= 32 && byte <= 126)) printable += 1;
  }
  return printable / bytes.length > 0.92;
}

async function readLimited(response, maxBytes) {
  if (!response.body) return { bytes: new Uint8Array(), truncated: false };
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  let truncated = false;
  try {
    while (total < maxBytes) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      const remaining = maxBytes - total;
      const chunk = value.byteLength > remaining ? value.slice(0, remaining) : value;
      chunks.push(chunk);
      total += chunk.byteLength;
      if (chunk.byteLength < value.byteLength || total >= maxBytes) {
        truncated = true;
        break;
      }
    }
  } finally {
    try { await reader.cancel(); } catch {}
  }
  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.length;
  }
  return { bytes: output, truncated };
}

function hasTsSignature(bytes) {
  if (bytes.length < 188 * 3) return false;
  const maxStart = Math.min(bytes.length - 188 * 3, 188 * 12);
  for (let offset = 0; offset <= maxStart; offset += 1) {
    if (bytes[offset] === 0x47 && bytes[offset + 188] === 0x47 && bytes[offset + 376] === 0x47) return true;
  }
  return false;
}

function hasMp4Signature(bytes) {
  if (bytes.length < 12) return false;
  for (let offset = 0; offset <= Math.min(bytes.length - 8, 64); offset += 1) {
    const box = String.fromCharCode(bytes[offset + 4] || 0, bytes[offset + 5] || 0, bytes[offset + 6] || 0, bytes[offset + 7] || 0);
    if (box === 'ftyp' || box === 'styp' || box === 'moov' || box === 'mdat') return true;
  }
  return false;
}

function hasWebmSignature(bytes) { return bytes.length >= 4 && bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3; }
function hasOggSignature(bytes) { return bytes.length >= 4 && String.fromCharCode(...bytes.slice(0, 4)) === 'OggS'; }
function hasId3Signature(bytes) { return bytes.length >= 3 && bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33; }
function hasFlacSignature(bytes) { return bytes.length >= 4 && String.fromCharCode(...bytes.slice(0, 4)) === 'fLaC'; }

function hasMpegAudioSignature(bytes) {
  for (let i = 0; i + 2 < bytes.length; i += 1) {
    if (bytes[i] === 0xff && (bytes[i + 1] & 0xe0) === 0xe0) return true;
    if (bytes[i] === 0xff && bytes[i + 1] === 0xf1) return true;
    if (bytes[i] === 0xff && bytes[i + 1] === 0xf9) return true;
  }
  return false;
}

function detectMediaEvidence(bytes, contentType, url) {
  const byTs = hasTsSignature(bytes);
  const byMp4 = hasMp4Signature(bytes);
  const byWebm = hasWebmSignature(bytes);
  const byOgg = hasOggSignature(bytes);
  const byId3 = hasId3Signature(bytes);
  const byFlac = hasFlacSignature(bytes);
  const byMpeg = hasMpegAudioSignature(bytes);
  const byType = MEDIA_CONTENT_TYPES.test(contentType) || STREAMISH_CONTENT_TYPES.test(contentType);
  const byUrl = MEDIA_EXTENSIONS.test(url);
  const signature = byTs || byMp4 || byWebm || byOgg || byId3 || byFlac || byMpeg;
  return { signature, byType, byUrl, kind: byTs ? 'MPEG-TS' : byMp4 ? 'ISO-BMFF' : byWebm ? 'WebM/Matroska' : byOgg ? 'Ogg' : byId3 ? 'ID3/MP3' : byFlac ? 'FLAC' : byMpeg ? 'MPEG audio' : null };
}

function parseAttributeList(raw = '') {
  const attrs = {};
  const re = /([A-Z0-9-]+)=((?:"[^"]*")|(?:[^,]*))(?:,|$)/gi;
  let match;
  while ((match = re.exec(raw)) !== null) attrs[match[1].toUpperCase()] = match[2].replace(/^"|"$/g, '');
  return attrs;
}

export function parseHlsManifest(text, baseUrl) {
  const lines = text.replace(/^\uFEFF/, '').replace(/\r/g, '').split('\n').map(s => s.trim()).filter(Boolean);
  if (lines[0]?.toUpperCase() !== '#EXTM3U') return { valid: false, type: 'unknown', variants: [], segments: [], parts: [], preload: '', init: '', targetUrls: [] };

  const variants = [];
  const segments = [];
  const parts = [];
  let preload = '';
  let init = '';
  let pendingVariant = null;

  for (const line of lines.slice(1)) {
    const upper = line.toUpperCase();
    if (upper.startsWith('#EXT-X-STREAM-INF:')) {
      pendingVariant = parseAttributeList(line.slice(line.indexOf(':') + 1));
      continue;
    }
    if (upper.startsWith('#EXT-X-I-FRAME-STREAM-INF:')) {
      const attrs = parseAttributeList(line.slice(line.indexOf(':') + 1));
      if (attrs.URI) {
        try { variants.push({ url: new URL(attrs.URI, baseUrl).href, bandwidth: Number(attrs.BANDWIDTH) || 0, iframe: true }); } catch {}
      }
      continue;
    }
    if (upper.startsWith('#EXT-X-PART:')) {
      const attrs = parseAttributeList(line.slice(line.indexOf(':') + 1));
      if (attrs.URI) {
        try { parts.push(new URL(attrs.URI, baseUrl).href); } catch {}
      }
      continue;
    }
    if (upper.startsWith('#EXT-X-PRELOAD-HINT:')) {
      const attrs = parseAttributeList(line.slice(line.indexOf(':') + 1));
      if (attrs.TYPE === 'PART' && attrs.URI) {
        try { preload = new URL(attrs.URI, baseUrl).href; } catch {}
      }
      continue;
    }
    if (upper.startsWith('#EXT-X-MAP:')) {
      const attrs = parseAttributeList(line.slice(line.indexOf(':') + 1));
      if (attrs.URI) {
        try { init = new URL(attrs.URI, baseUrl).href; } catch {}
      }
      continue;
    }
    if (!line.startsWith('#')) {
      try {
        const resolved = new URL(line, baseUrl).href;
        if (pendingVariant) {
          variants.push({ url: resolved, bandwidth: Number(pendingVariant.BANDWIDTH) || 0, width: Number(pendingVariant.RESOLUTION?.split('x')[0]) || 0, height: Number(pendingVariant.RESOLUTION?.split('x')[1]) || 0 });
          pendingVariant = null;
        } else {
          segments.push(resolved);
        }
      } catch {
        pendingVariant = null;
      }
    }
  }

  variants.sort((a, b) => (b.bandwidth - a.bandwidth) || (b.width * b.height - a.width * a.height));
  const type = variants.length ? 'master' : 'media';
  const targetUrls = type === 'master'
    ? variants.map(v => v.url)
    : [...segments, ...parts, preload, init].filter(Boolean);
  return { valid: true, type, variants, segments, parts, preload, init, targetUrls: [...new Set(targetUrls)] };
}

function classifyHttp(status) {
  if (status === 401) return STATUS.AUTH_REQUIRED;
  if (status === 403) return STATUS.FORBIDDEN;
  if (status === 404 || status === 410) return STATUS.NOT_FOUND;
  if (status === 408 || status === 425 || status === 429) return status === 429 ? STATUS.RATE_LIMITED : STATUS.HTTP_ERROR;
  if (status >= 500) return STATUS.SERVER_ERROR;
  if (status >= 400) return STATUS.HTTP_ERROR;
  return null;
}

function createBaseResult(url) {
  return {
    url,
    finalUrl: url,
    status: STATUS.UNKNOWN,
    httpStatus: null,
    contentType: '',
    latencyMs: null,
    bytesRead: 0,
    confidence: 'low',
    detail: '',
    evidence: '',
    hls: null,
    attempts: 0,
    redirects: 0,
    retryAfterMs: null,
  };
}

function makeHeaders(options, range = true) {
  const headers = {
    Accept: 'application/vnd.apple.mpegurl, application/x-mpegURL, video/*, audio/*, */*;q=0.1',
    ...(range ? { Range: `bytes=0-${Math.max(4095, options.maxBytes - 1)}` } : {}),
    ...options.headers,
  };
  if (!isBrowserRuntime()) {
    headers['User-Agent'] = options.userAgent;
    headers['Accept-Encoding'] = 'identity';
  }
  return headers;
}

async function fetchWithRedirects(url, options, fetchImpl, targetGuard = assertPublicTarget, useRange = true) {
  let current = url;
  let redirects = 0;
  while (true) {
    await targetGuard(current, options);
    const req = makeRequestSignal(options.signal, options.timeoutMs);
    try {
      let response;
      try {
        response = await fetchImpl(current, {
          method: 'GET',
          redirect: 'manual',
          cache: 'no-store',
          credentials: 'omit',
          signal: req.signal,
          headers: makeHeaders(options, useRange),
        });
      } catch (error) {
        if (!isBrowserRuntime() || isAbortError(error) || options.signal?.aborted) throw error;
        // A normal browser fetch can fail solely because CORS blocks reading it.
        // A successful no-cors request is intentionally surfaced as RESPONDS later.
        try {
          const opaque = await fetchImpl(current, { method: 'GET', mode: 'no-cors', cache: 'no-store', credentials: 'omit', signal: req.signal });
          return { opaque: true, response: opaque, finalUrl: current, redirects, timedOut: req.timedOut, cleanup: req.cleanup };
        } catch {
          throw error;
        }
      }
      if (!REDIRECTS.has(response.status)) return { response, finalUrl: current, redirects, timedOut: req.timedOut, cleanup: req.cleanup };
      try { await response.body?.cancel(); } catch {}
      req.cleanup();
      if (redirects >= options.maxRedirects) return { response, finalUrl: current, redirects, redirectLimit: true, timedOut: req.timedOut(), cleanup: () => {} };
      const location = response.headers.get('location');
      if (!location) return { response, finalUrl: current, redirects };
      const next = new URL(location, current).href;
      await targetGuard(next, options);
      redirects += 1;
      current = next;
    } catch (error) {
      req.cleanup();
      if (req.timedOut()) error.__iptvTimeout = true;
      throw error;
    }
  }
}

async function probeOnce(url, options, fetchImpl, depth, targetGuard = assertPublicTarget, visited = new Set()) {
  const result = createBaseResult(url);
  const started = nowMs();
  let firstTimedOut = () => false;
  try {
    const parsed = new URL(url);
    if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('Only HTTP and HTTPS URLs are supported.');
    if (isBrowserRuntime() && window.location.protocol === 'https:' && parsed.protocol === 'http:') {
      result.status = STATUS.MIXED_CONTENT;
      result.confidence = 'high';
      result.detail = 'HTTP target was blocked by the browser security model on this HTTPS page.';
      return result;
    }

    const visitKey = canonicalizeUrl(url);
    if (visited.has(visitKey)) {
      result.status = STATUS.MANIFEST_ONLY;
      result.confidence = 'medium';
      result.detail = 'HLS verification loop detected; refusing to recurse indefinitely.';
      return result;
    }
    visited.add(visitKey);

    const first = await fetchWithRedirects(url, options, fetchImpl, targetGuard, true);
    firstTimedOut = typeof first.timedOut === 'function' ? first.timedOut : () => Boolean(first.timedOut);
    let firstCleaned = false;
    const cleanupFirst = () => { if (!firstCleaned) { firstCleaned = true; first.cleanup?.(); } };
    result.finalUrl = first.finalUrl;
    result.redirects = first.redirects;
    result.latencyMs = Math.round(nowMs() - started);

    if (first.opaque) {
      cleanupFirst();
      result.status = STATUS.REACHABLE;
      result.confidence = 'low';
      result.evidence = 'cors-opaque';
      result.detail = 'Browser received an opaque cross-origin response; HTTP status and body are unavailable.';
      return result;
    }

    const response = first.response;
    try {
      result.httpStatus = response.status;
    result.contentType = response.headers.get('content-type') || '';
    const retryAfter = response.headers.get('retry-after');
    if (retryAfter && /^\d+$/.test(retryAfter)) result.retryAfterMs = Number(retryAfter) * 1000;

    if (first.redirectLimit) {
      result.status = STATUS.REDIRECT_LIMIT;
      result.confidence = 'high';
      result.detail = `More than ${options.maxRedirects} redirects encountered.`;
      return result;
    }

    const httpStatus = classifyHttp(response.status);
    if (httpStatus) {
      result.status = httpStatus;
      result.confidence = 'high';
      result.detail = `HTTP ${response.status}`;
      return result;
    }
    if (!response.ok) {
      result.status = STATUS.HTTP_ERROR;
      result.confidence = 'high';
      result.detail = `HTTP ${response.status}`;
      return result;
    }

    const { bytes } = await readLimited(response, options.maxBytes);
    result.bytesRead = bytes.length;
    if (!bytes.length || response.status === 204) {
      result.status = STATUS.NO_DATA;
      result.confidence = 'medium';
      result.detail = 'The endpoint responded without a readable media body.';
      return result;
    }

    const text = textSample(bytes);
    if (looksLikeHtml(text) || looksLikeJson(text) || looksLikeXmlError(text)) {
      result.status = STATUS.UNEXPECTED_CONTENT;
      result.confidence = 'high';
      result.evidence = 'text-error-response';
      result.detail = 'HTTP succeeded, but the response looks like a web page or API/error document rather than media.';
      return result;
    }

    const trimmed = text.replace(/^\uFEFF/, '').trimStart();
    const hlsCandidate = isHlsCandidate(result.finalUrl, result.contentType) || trimmed.toUpperCase().startsWith('#EXTM3U');
    if (hlsCandidate) {
      const manifest = parseHlsManifest(text, result.finalUrl);
      if (!manifest.valid) {
        result.status = STATUS.UNEXPECTED_CONTENT;
        result.confidence = 'high';
        result.evidence = 'invalid-hls';
        result.detail = 'The endpoint looks like HLS, but the playlist is not a valid #EXTM3U manifest.';
        return result;
      }

      result.hls = {
        type: manifest.type,
        variants: manifest.variants.length,
        segments: manifest.segments.length,
        parts: manifest.parts.length,
        verifiedResources: 0,
        verification: null,
      };

      if (!options.deepHls || depth >= options.maxHlsDepth || !manifest.targetUrls.length) {
        result.status = STATUS.MANIFEST_ONLY;
        result.confidence = 'medium';
        result.evidence = 'valid-hls-manifest';
        result.detail = `Valid ${manifest.type} HLS manifest; media resource verification was not performed.`;
        return result;
      }

      const candidates = manifest.targetUrls.slice(0, options.maxHlsResources * (manifest.type === 'master' ? options.maxHlsVariants : 1));
      const childResults = [];
      for (const childUrl of candidates) {
        const child = await probeOnce(childUrl, options, fetchImpl, depth + 1, targetGuard, visited);
        childResults.push(child);
        if (child.status === STATUS.ONLINE) break;
      }

      const onlineChild = childResults.find(child => child.status === STATUS.ONLINE);
      result.hls.verifiedResources = childResults.filter(child => child.status === STATUS.ONLINE).length;
      result.hls.verification = childResults.map(child => ({ status: child.status, httpStatus: child.httpStatus, finalUrl: child.finalUrl }));

      if (onlineChild) {
        result.status = STATUS.ONLINE;
        result.confidence = 'high';
        result.evidence = 'hls-media-resource';
        result.detail = `Valid ${manifest.type} HLS manifest with a verified media resource.`;
        result.mediaChild = { url: onlineChild.url, finalUrl: onlineChild.finalUrl, status: onlineChild.status };
      } else {
        result.status = STATUS.MANIFEST_ONLY;
        result.confidence = childResults.some(child => child.status === STATUS.RESPONDS) ? 'medium' : 'low';
        result.evidence = 'valid-hls-unverified-resource';
        const last = childResults.at(-1);
        result.detail = `Valid ${manifest.type} HLS manifest, but no verified media resource was obtained (${last ? last.status : 'not checked'}).`;
      }
      return result;
    }

    if ((MEDIA_CONTENT_TYPES.test(result.contentType) || MEDIA_EXTENSIONS.test(result.finalUrl)) && looksLikePlainTextError(bytes)) {
      result.status = STATUS.UNEXPECTED_CONTENT;
      result.confidence = 'high';
      result.evidence = 'text-error-response';
      result.detail = 'The endpoint advertised a media resource, but the received bytes are overwhelmingly plain text.';
      return result;
    }

    const media = detectMediaEvidence(bytes, result.contentType, result.finalUrl);
    if (media.signature) {
      result.status = STATUS.ONLINE;
      result.confidence = 'high';
      result.evidence = media.kind || 'media-signature';
      result.detail = `Recognized ${media.kind || 'media'} data in the response.`;
      return result;
    }
    if (media.byType) {
      result.status = STATUS.ONLINE;
      result.confidence = 'high';
      result.evidence = `content-type:${result.contentType}`;
      result.detail = 'The server explicitly identified the response as audio/video/media data.';
      return result;
    }
    if (media.byUrl) {
      result.status = STATUS.RESPONDS;
      result.confidence = 'medium';
      result.evidence = 'media-url-extension';
      result.detail = 'The response was non-empty and the final URL resembles a media resource, but the body signature was not confirmed.';
      return result;
    }

    result.status = STATUS.RESPONDS;
    result.confidence = 'medium';
    result.evidence = 'http-nonempty';
    result.detail = 'HTTP succeeded with a non-empty body, but the response could not be confidently identified as media.';
    return result;
    } finally {
      cleanupFirst();
    }
  } catch (error) {
    result.latencyMs = Math.round(nowMs() - started);
    if (options.signal?.aborted) throw error;
    if (error?.__iptvTimeout || /aborted/i.test(error?.message || '') && firstTimedOut?.()) {
      result.status = STATUS.TIMEOUT;
      result.confidence = 'high';
      result.detail = `Probe exceeded ${options.timeoutMs} ms.`;
    } else if (isAbortError(error)) {
      result.status = STATUS.TIMEOUT;
      result.confidence = 'high';
      result.detail = `Probe aborted after ${options.timeoutMs} ms.`;
    } else if (/private|reserved|credentials|target/i.test(error?.message || '')) {
      result.status = STATUS.INVALID_URL;
      result.confidence = 'high';
      result.detail = error.message;
    } else {
      result.status = STATUS.NETWORK_ERROR;
      result.confidence = 'low';
      result.detail = error?.message || 'DNS, TLS, socket, or browser CORS failure.';
    }
    return result;
  }
}

export async function probeUrl(url, rawOptions = {}, fetchImpl = globalThis.fetch, targetGuard = async () => {}) {
  const options = normaliseOptions(rawOptions);
  const base = createBaseResult(url);
  try {
    const parsed = new URL(url);
    if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('Only HTTP and HTTPS URLs are supported.');
  } catch (error) {
    return { ...base, status: STATUS.INVALID_URL, confidence: 'high', detail: error.message || 'Invalid URL.' };
  }

  let last = base;
  for (let attempt = 0; attempt <= options.retries; attempt += 1) {
    const attemptOptions = { ...options, signal: options.signal };
    const result = await probeOnce(url, attemptOptions, fetchImpl, 0, targetGuard, new Set());
    result.attempts = attempt + 1;
    last = result;

    if (result.status === STATUS.HTTP_ERROR && [400, 405, 416, 501].includes(result.httpStatus)) {
      const retryOptions = { ...options, signal: options.signal };
      const noRangeFetch = (target, init) => {
        const headers = { ...(init?.headers || {}) };
        delete headers.Range;
        return fetchImpl(target, { ...init, headers });
      };
      const fallback = await probeOnce(url, retryOptions, noRangeFetch, 0, targetGuard, new Set());
      fallback.attempts = attempt + 1;
      if (fallback.status !== STATUS.HTTP_ERROR) return fallback;
      last = fallback;
    }

    const retryable = [STATUS.NETWORK_ERROR, STATUS.TIMEOUT].includes(last.status) || (last.httpStatus != null && TRANSIENT_HTTP.has(last.httpStatus));
    if (!retryable || attempt === options.retries) return last;
    const waitMs = last.retryAfterMs ?? (250 * 2 ** attempt);
    await delay(Math.min(waitMs, 5000));
  }
  return last;
}

function headersForEntry(entry) {
  const headers = {};
  if (entry?.httpReferrer) headers.Referer = entry.httpReferrer;
  if (entry?.httpUserAgent) headers['user-agent'] = entry.httpUserAgent;
  return headers;
}

export async function scanEntries(entries, rawOptions = {}, onResult = () => {}, externalSignal = null, targetGuard = async () => {}) {
  const options = normaliseOptions({ ...rawOptions, signal: externalSignal || rawOptions.signal || null });
  const results = new Array(entries.length);
  const seen = new Map();
  const queue = [];

  for (const entry of entries) {
    const key = canonicalizeUrl(entry.url);
    if (!key || !/^https?:\/\//i.test(key)) {
      queue.push({ entry, key: `invalid:${entry.index}`, duplicate: false });
    } else if (seen.has(key)) {
      queue.push({ entry, key, duplicate: true, duplicateOf: seen.get(key).index });
    } else {
      seen.set(key, { index: entry.index });
      queue.push({ entry, key, duplicate: false });
    }
  }

  let cursor = 0;
  const worker = async () => {
    while (true) {
      if (externalSignal?.aborted) throw new DOMException('Scan aborted', 'AbortError');
      const item = queue[cursor++];
      if (!item) return;
      let result;
      if (item.duplicate) {
        result = { ...createBaseResult(item.entry.url), status: STATUS.DUPLICATE, confidence: 'high', detail: `Duplicate of row ${item.duplicateOf + 1}.`, evidence: 'canonical-duplicate', duplicateOf: item.duplicateOf };
      } else if (!/^https?:\/\//i.test(String(item.entry.url || '').trim())) {
        result = { ...createBaseResult(item.entry.url), status: STATUS.INVALID_URL, confidence: 'high', detail: 'Only HTTP and HTTPS stream URLs can be probed.', evidence: 'unsupported-scheme' };
      } else {
        result = await probeUrl(item.entry.url, {
          ...options,
          headers: { ...options.headers, ...headersForEntry(item.entry) },
        }, globalThis.fetch, targetGuard);
      }
      const enriched = { ...item.entry, ...result, index: item.entry.index };
      results[item.entry.index] = enriched;
      await onResult(enriched);
    }
  };

  await Promise.all(Array.from({ length: Math.min(options.concurrency, Math.max(queue.length, 1)) }, worker));
  const ordered = results.filter(Boolean).sort((a, b) => a.index - b.index);
  return { results: ordered, summary: summarizeResults(ordered) };
}

function canonicalKey(url) {
  try {
    const parsed = new URL(url);
    parsed.hash = '';
    parsed.hostname = parsed.hostname.toLowerCase();
    if ((parsed.protocol === 'http:' && parsed.port === '80') || (parsed.protocol === 'https:' && parsed.port === '443')) parsed.port = '';
    return parsed.href;
  } catch { return ''; }
}

export function canonicalizeUrl(value) { return canonicalKey(value) || String(value ?? '').trim(); }

export function summarizeResults(results) {
  const summary = { total: results.length, online: 0, responds: 0, manifestOnly: 0, attention: 0, errors: 0, duplicates: 0, elapsedMs: 0 };
  for (const result of results) {
    if (result.status === STATUS.ONLINE) summary.online += 1;
    else if ([STATUS.RESPONDS, STATUS.REACHABLE].includes(result.status)) summary.responds += 1;
    else if (result.status === STATUS.MANIFEST_ONLY) summary.manifestOnly += 1;
    else if (result.status === STATUS.DUPLICATE) summary.duplicates += 1;
    else if ([STATUS.AUTH_REQUIRED, STATUS.FORBIDDEN, STATUS.RATE_LIMITED].includes(result.status)) summary.attention += 1;
    else summary.errors += 1;
  }
  return summary;
}

export function isTransientHttp(status) { return TRANSIENT_HTTP.has(status); }
