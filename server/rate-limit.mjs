// Fixed-window write limiter: per-client and global, in bounded memory.
// Best-effort abuse control only; anonymous voting is not identity-verified.
import { isIP } from 'node:net';

export class RateLimiter {
  constructor({ perClient = 30, global = 600, windowMs = 60_000, maxClients = 10_000, now = () => Date.now() } = {}) {
    this.perClient = perClient;
    this.global = global;
    this.windowMs = windowMs;
    this.maxClients = maxClients;
    this.now = now;
    this.clients = new Map(); // key -> {start, count}; insertion order == age
    this.globalWindow = { start: 0, count: 0 };
  }

  // Returns {ok:true} or {ok:false, retryAfter:seconds}.
  hit(key) {
    const t = this.now();
    if (t - this.globalWindow.start >= this.windowMs) this.globalWindow = { start: t, count: 0 };
    let entry = this.clients.get(key);
    if (entry && t - entry.start >= this.windowMs) {
      this.clients.delete(key);
      entry = undefined;
    }
    if (!entry) {
      // Evict expired then oldest entries to stay bounded.
      for (const k of this.clients.keys()) {
        if (this.clients.size < this.maxClients) break;
        this.clients.delete(k); // oldest first (Map preserves insertion order)
      }
      entry = { start: t, count: 0 };
      this.clients.set(key, entry);
    }
    if (entry.count >= this.perClient) {
      return { ok: false, retryAfter: Math.max(1, Math.ceil((entry.start + this.windowMs - t) / 1000)) };
    }
    if (this.globalWindow.count >= this.global) {
      return { ok: false, retryAfter: Math.max(1, Math.ceil((this.globalWindow.start + this.windowMs - t) / 1000)) };
    }
    entry.count += 1;
    this.globalWindow.count += 1;
    return { ok: true };
  }
}

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

export function isLoopback(addr) {
  return LOOPBACK.has(addr) || (typeof addr === 'string' && /^(::ffff:)?127\./.test(addr));
}

// The client key used for rate limiting. X-Forwarded-For is honoured only when
// trustProxy is set AND the direct peer is loopback (the local reverse proxy).
// The rightmost entry is used: the trusted proxy appends the real client there,
// while anything to its left is client-supplied and spoofable.
export function clientKey(req, trustProxy) {
  const peer = req.socket.remoteAddress || 'unknown';
  let ip = peer;
  if (trustProxy && isLoopback(peer)) {
    const xff = req.headers['x-forwarded-for'];
    const raw = Array.isArray(xff) ? xff.join(',') : xff;
    if (typeof raw === 'string' && raw.length <= 2048) {
      const last = raw.split(',').map((s) => s.trim()).filter(Boolean).pop();
      if (last && isIP(last)) ip = last;
    }
  }
  return normaliseIp(ip);
}

// IPv4 as-is; IPv6 bucketed per /64 so a single host cannot trivially rotate.
export function normaliseIp(ip) {
  if (ip.startsWith('::ffff:') && isIP(ip.slice(7)) === 4) return ip.slice(7);
  if (isIP(ip) !== 6) return ip;
  const [head, tail = ''] = ip.split('::');
  const h = head ? head.split(':') : [];
  const t = tail ? tail.split(':') : [];
  if (t.length && t[t.length - 1].includes('.')) t.splice(-1, 1, '0', '0'); // embedded IPv4 in low bits
  const full = ip.includes('::') ? [...h, ...Array(8 - h.length - t.length).fill('0'), ...t] : h;
  return full.slice(0, 4).map((x) => parseInt(x || '0', 16).toString(16)).join(':') + '::/64';
}
