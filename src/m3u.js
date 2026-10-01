export const M3U_HEADER = '#EXTM3U';
const ATTRIBUTE_RE = /([A-Za-z0-9_-]+)=(?:"([^"]*)"|([^\s]+))/g;

const cleanText = (value = '') => String(value).replace(/^\uFEFF/, '').trim();

function parseAttributes(raw = '') {
  const attributes = {};
  let match;
  ATTRIBUTE_RE.lastIndex = 0;
  while ((match = ATTRIBUTE_RE.exec(raw)) !== null) attributes[match[1].toLowerCase()] = match[2] ?? match[3] ?? '';
  return attributes;
}

function parseExtInf(line) {
  const payload = line.slice(line.indexOf(':') + 1);
  const commaIndex = findAttributeSafeComma(payload);
  const metadata = commaIndex >= 0 ? payload.slice(0, commaIndex) : payload;
  const title = commaIndex >= 0 ? cleanText(payload.slice(commaIndex + 1)) : '';
  const durationMatch = metadata.match(/^\s*(-?\d+(?:\.\d+)?)/);
  const duration = durationMatch ? Number(durationMatch[1]) : -1;
  const attributeText = durationMatch ? metadata.slice(durationMatch[0].length).trim() : metadata;
  return { duration, title, attributes: parseAttributes(attributeText) };
}

function findAttributeSafeComma(payload) {
  let quoted = false;
  for (let i = 0; i < payload.length; i += 1) {
    if (payload[i] === '"') quoted = !quoted;
    else if (payload[i] === ',' && !quoted) return i;
  }
  return -1;
}

function normaliseEntry(entry, sourceUrl, pendingGroup = '') {
  const a = entry.attributes || {};
  const rawUrl = cleanText(entry.url);
  let resolvedUrl = rawUrl;
  if (sourceUrl && rawUrl) {
    try { resolvedUrl = new URL(rawUrl, sourceUrl).href; } catch {}
  }
  const referrer = entry.httpReferrer || a['http-referrer'] || '';
  const userAgent = entry.httpUserAgent || a['http-user-agent'] || '';
  return {
    id: `entry-${entry.index}`,
    index: entry.index,
    name: cleanText(a['tvg-name'] || entry.title || 'Untitled channel'),
    group: cleanText(a['group-title'] || entry.group || pendingGroup || 'Uncategorized'),
    tvgId: cleanText(a['tvg-id'] || ''),
    tvgName: cleanText(a['tvg-name'] || ''),
    tvgLogo: cleanText(a['tvg-logo'] || ''),
    duration: Number.isFinite(entry.duration) ? entry.duration : -1,
    url: resolvedUrl,
    sourceUrl: sourceUrl || '',
    attributes: a,
    httpReferrer: referrer,
    httpUserAgent: userAgent,
  };
}

export function parseM3U(text, { sourceUrl = '' } = {}) {
  if (typeof text !== 'string') throw new TypeError('Playlist content must be a string.');
  const lines = text.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  const entries = [];
  const warnings = [];
  let pending = null;
  let pendingGroup = '';
  let sawM3U = false;

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const line = cleanText(lines[lineIndex]);
    if (!line) continue;
    const upper = line.toUpperCase();
    if (upper === '#EXTM3U' || upper.startsWith('#EXTM3U ')) { sawM3U = true; continue; }
    if (upper.startsWith('#EXTINF:')) { pending = { ...parseExtInf(line), lineIndex }; continue; }
    if (upper.startsWith('#EXTGRP:')) { pendingGroup = cleanText(line.slice(line.indexOf(':') + 1)); continue; }
    if (upper.startsWith('#EXTVLCOPT:HTTP-REFERRER=')) {
      if (pending) pending.httpReferrer = cleanText(line.slice(line.indexOf('=') + 1));
      continue;
    }
    if (upper.startsWith('#EXTVLCOPT:HTTP-USER-AGENT=')) {
      if (pending) pending.httpUserAgent = cleanText(line.slice(line.indexOf('=') + 1));
      continue;
    }
    if (line.startsWith('#')) continue;

    const entry = pending
      ? { ...pending, url: line, index: entries.length, group: pendingGroup }
      : { index: entries.length, title: '', duration: -1, attributes: {}, url: line, lineIndex, group: pendingGroup };
    entries.push(normaliseEntry(entry, sourceUrl, pendingGroup));
    pending = null;
  }

  if (pending) warnings.push('Playlist ended with channel metadata without a following URL.');
  return { header: sawM3U ? M3U_HEADER : '', entries, lineCount: lines.length, sawM3U, warnings };
}

function quoteAttribute(value) { return String(value ?? '').replaceAll('"', '&quot;'); }

export function entryToExtInf(entry) {
  const attrs = { ...(entry.attributes || {}) };
  attrs['tvg-id'] = attrs['tvg-id'] ?? entry.tvgId;
  attrs['tvg-name'] = attrs['tvg-name'] ?? entry.tvgName ?? entry.name;
  attrs['tvg-logo'] = attrs['tvg-logo'] ?? entry.tvgLogo;
  attrs['group-title'] = attrs['group-title'] ?? entry.group;
  const preferred = ['tvg-id', 'tvg-name', 'tvg-logo', 'group-title'];
  const keys = [...preferred, ...Object.keys(attrs).filter(key => !preferred.includes(key)).sort()];
  const attrText = keys.filter(key => attrs[key] !== undefined && attrs[key] !== null && attrs[key] !== '')
    .map(key => `${key}="${quoteAttribute(attrs[key])}"`).join(' ');
  const duration = Number.isFinite(entry.duration) ? entry.duration : -1;
  return `#EXTINF:${duration}${attrText ? ` ${attrText}` : ''},${entry.name || 'Untitled channel'}`;
}

export function entryDirectives(entry) {
  const directives = [];
  if (entry.httpReferrer) directives.push(`#EXTVLCOPT:http-referrer=${entry.httpReferrer}`);
  if (entry.httpUserAgent) directives.push(`#EXTVLCOPT:http-user-agent=${entry.httpUserAgent}`);
  return directives;
}

export function buildM3U(entries) {
  return `#EXTM3U\n${entries.filter(e => e?.url).flatMap(e => [entryToExtInf(e), ...entryDirectives(e), e.url]).join('\n')}\n`;
}

export function buildCsv(results) {
  const esc = value => `"${String(value ?? '').replaceAll('"', '""')}"`;
  const header = 'Name,Group,URL,Final URL,Status,HTTP,Latency ms,Bytes,Confidence,Evidence,Detail';
  return [header, ...results.map(r => [r.name, r.group, r.url, r.finalUrl || '', r.status, r.httpStatus ?? '', r.latencyMs ?? '', r.bytesRead ?? '', r.confidence, r.evidence || '', r.detail].map(esc).join(','))].join('\n') + '\n';
}
