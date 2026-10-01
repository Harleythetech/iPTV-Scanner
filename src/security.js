import net from 'node:net';
import dns from 'node:dns/promises';

function parseIpv4(value) {
  const parts = value.split('.').map(Number);
  if (parts.length !== 4 || parts.some(n => !Number.isInteger(n) || n < 0 || n > 255)) return null;
  return parts;
}

function ipv4ToBigInt(ip) {
  const p = parseIpv4(ip);
  if (!p) return null;
  return (BigInt(p[0]) << 24n) | (BigInt(p[1]) << 16n) | (BigInt(p[2]) << 8n) | BigInt(p[3]);
}

function inCidr4(ip, network, prefix) {
  const value = ipv4ToBigInt(ip);
  const base = ipv4ToBigInt(network);
  if (value === null || base === null) return false;
  const shift = 32n - BigInt(prefix);
  const mask = ((1n << 32n) - 1n) ^ ((1n << shift) - 1n);
  return (value & mask) === (base & mask);
}

function isPrivateIpv4(ip) {
  return [
    ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
    ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
    ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24],
    ['224.0.0.0', 4], ['240.0.0.0', 4],
  ].some(([network, prefix]) => inCidr4(ip, network, prefix));
}

function parseEmbeddedIpv4(value) {
  const marker = value.lastIndexOf(':');
  if (marker < 0) return null;
  const candidate = value.slice(marker + 1);
  return parseIpv4(candidate) ? candidate : null;
}

function isPrivateIpv6(ip) {
  const v = ip.toLowerCase().replace(/^\[|\]$/g, '');
  if (v === '::' || v === '::1' || v.startsWith('ff')) return true;
  if (/^fe[89ab]/.test(v) || /^fc|^fd/.test(v) || v.startsWith('2001:db8:')) return true;
  const embedded = parseEmbeddedIpv4(v);
  if (embedded && (v.startsWith('::ffff:') || v.startsWith('::'))) return isPrivateIpv4(embedded);
  return false;
}

export function isPrivateIp(ip) {
  const type = net.isIP(ip);
  return type === 4 ? isPrivateIpv4(ip) : type === 6 ? isPrivateIpv6(ip) : false;
}

export async function assertPublicTarget(url, { allowPrivateTargets = false, resolveDns = true, dnsLookup = dns.lookup } = {}) {
  const target = new URL(url);
  if (!['http:', 'https:'].includes(target.protocol)) throw new Error('Only HTTP and HTTPS targets are allowed.');
  if (target.username || target.password) throw new Error('URLs with embedded credentials are not supported.');
  if (allowPrivateTargets) return;

  const hostname = target.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (hostname === 'localhost' || hostname.endsWith('.localhost') || hostname === 'metadata.google.internal' || hostname.endsWith('.internal')) {
    throw new Error('Private or metadata destinations are blocked.');
  }
  if (net.isIP(hostname) && isPrivateIp(hostname)) throw new Error('Private or reserved IP destinations are blocked.');
  if (!resolveDns) return;

  try {
    const records = await dnsLookup(hostname, { all: true, verbatim: true });
    if (!records.length) throw new Error('Hostname resolved without any usable address.');
    if (records.some(record => isPrivateIp(record.address))) throw new Error('Target hostname resolves to a private or reserved address.');
  } catch (error) {
    if (/private or reserved|Hostname resolved/i.test(error?.message || '')) throw error;
    const wrapped = new Error(`Could not safely resolve target hostname: ${error?.message || 'DNS lookup failed.'}`);
    wrapped.code = error?.code || 'DNS_ERROR';
    throw wrapped;
  }
}
