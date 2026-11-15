// HTTP API. No framework, no dependencies.
import { createServer as createHttpServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { VoteStore, AppError, hashVoterToken, REQUEST_ID_RE } from './db.mjs';
import { loadCatalog } from './catalog.mjs';
import { RateLimiter, clientKey } from './rate-limit.mjs';
import { serveStatic } from './static.mjs';

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const PRODUCTION_ORIGIN = 'https://lost-compositions.exe.xyz';
export const MAX_BODY_BYTES = 2048;

const JSON_CT = /^application\/json\s*(;\s*charset\s*=\s*"?utf-8"?\s*)?$/i;

function envBool(v) {
  return typeof v === 'string' && /^(1|true|yes)$/i.test(v.trim());
}

function envInt(v, fallback, name) {
  if (v === undefined || v === '') return fallback;
  const n = Number(v);
  if (!Number.isSafeInteger(n) || n < 1) throw new Error(`${name} must be a positive integer`);
  return n;
}

// Builds options from environment variables (used by index.mjs).
export function optionsFromEnv(env = process.env) {
  const port = envInt(env.PORT, 3000, 'PORT');
  const serveStatic = envBool(env.SERVE_STATIC);
  const dev = serveStatic || env.NODE_ENV === 'development';
  let allowedOrigins;
  if (env.ALLOWED_ORIGINS !== undefined && env.ALLOWED_ORIGINS.trim() !== '') {
    allowedOrigins = env.ALLOWED_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean);
  } else {
    allowedOrigins = [PRODUCTION_ORIGIN];
    if (dev) allowedOrigins.push(`http://127.0.0.1:${port}`, `http://localhost:${port}`);
  }
  for (const o of allowedOrigins) {
    if (o === '*' || o === 'null') throw new Error(`ALLOWED_ORIGINS may not contain ${o}`);
    const u = new URL(o);
    if (u.origin !== o) throw new Error(`ALLOWED_ORIGINS entry is not a bare origin: ${o}`);
  }
  return {
    host: env.HOST || '127.0.0.1',
    port,
    dbPath: env.DB_PATH || resolve(REPO_ROOT, 'var/votes.sqlite'),
    catalogPath: env.CATALOG_PATH || resolve(REPO_ROOT, 'data/catalog.json'),
    allowedOrigins,
    trustProxy: envBool(env.TRUST_PROXY),
    serveStatic,
    staticRoot: REPO_ROOT,
    rateLimitPerMinute: envInt(env.RATE_LIMIT_PER_MINUTE, 30, 'RATE_LIMIT_PER_MINUTE'),
    globalRateLimitPerMinute: envInt(env.GLOBAL_RATE_LIMIT_PER_MINUTE, 600, 'GLOBAL_RATE_LIMIT_PER_MINUTE'),
  };
}

export function createApp(opts) {
  const {
    dbPath,
    catalogPath = resolve(REPO_ROOT, 'data/catalog.json'),
    catalog = loadCatalog(catalogPath),
    allowedOrigins = [PRODUCTION_ORIGIN],
    trustProxy = false,
    serveStatic: staticEnabled = false,
    staticRoot = REPO_ROOT,
    rateLimitPerMinute = 30,
    globalRateLimitPerMinute = 600,
    maxRateClients = 10_000,
    now,
  } = opts;
  if (!dbPath) throw new Error('dbPath is required');
  const store = new VoteStore({ dbPath, catalog, now });
  const origins = new Set(allowedOrigins);
  const limiter = new RateLimiter({ perClient: rateLimitPerMinute, global: globalRateLimitPerMinute, maxClients: maxRateClients });

  function sendJson(res, status, body, extra = {}) {
    const text = JSON.stringify(body);
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': Buffer.byteLength(text),
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      ...extra,
    });
    res.end(text);
  }

  function sendError(res, status, code, message, extra) {
    sendJson(res, status, { error: { code, message } }, extra);
  }

  function readBody(req) {
    return new Promise((resolveBody, reject) => {
      const declared = req.headers['content-length'];
      if (declared !== undefined && Number(declared) > MAX_BODY_BYTES) {
        reject(new AppError(413, 'body_too_large', `Body must be at most ${MAX_BODY_BYTES} bytes`));
        return;
      }
      const chunks = [];
      let size = 0;
      let failed = false;
      req.on('data', (chunk) => {
        if (failed) return;
        size += chunk.length;
        if (size > MAX_BODY_BYTES) {
          failed = true;
          reject(new AppError(413, 'body_too_large', `Body must be at most ${MAX_BODY_BYTES} bytes`));
          return;
        }
        chunks.push(chunk);
      });
      req.on('end', () => { if (!failed) resolveBody(Buffer.concat(chunks)); });
      req.on('error', (err) => { if (!failed) { failed = true; reject(err); } });
    });
  }

  function voterHashFrom(req, required) {
    const raw = req.headers['x-voter-token'];
    if (raw === undefined) {
      if (required) throw new AppError(400, 'missing_token', 'X-Voter-Token header is required');
      return null;
    }
    return hashVoterToken(raw);
  }

  function parseVoteBody(buf) {
    let body;
    try {
      body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(buf));
    } catch {
      throw new AppError(400, 'invalid_json', 'Body must be valid JSON');
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new AppError(400, 'invalid_body', 'Body must be a JSON object');
    const keys = Object.keys(body);
    if (keys.length !== 2 || !keys.includes('requestId') || !keys.includes('voted')) {
      throw new AppError(400, 'invalid_body', 'Body must be exactly {requestId, voted}');
    }
    if (typeof body.requestId !== 'string' || body.requestId.length > 100 || !REQUEST_ID_RE.test(body.requestId)) {
      throw new AppError(400, 'invalid_request_id', 'Invalid requestId');
    }
    if (typeof body.voted !== 'boolean') throw new AppError(400, 'invalid_body', 'voted must be a boolean');
    return body;
  }

  async function handleApi(req, res, path, cors) {
    if (req.method === 'OPTIONS') {
      if (!cors['Access-Control-Allow-Origin']) return sendError(res, 403, 'origin_not_allowed', 'Origin not allowed', cors);
      res.writeHead(204, { ...cors, 'Access-Control-Max-Age': '600', 'Content-Length': '0' });
      return res.end();
    }
    if (path === '/api/health') {
      if (req.method !== 'GET') return sendError(res, 405, 'method_not_allowed', 'Method not allowed', { ...cors, Allow: 'GET, OPTIONS' });
      return sendJson(res, 200, { ok: true }, cors);
    }
    if (path === '/api/requests') {
      if (req.method !== 'GET') return sendError(res, 405, 'method_not_allowed', 'Method not allowed', { ...cors, Allow: 'GET, OPTIONS' });
      const voter = voterHashFrom(req, false);
      return sendJson(res, 200, store.listRequests(voter), cors);
    }
    if (path === '/api/votes') {
      if (req.method !== 'POST') return sendError(res, 405, 'method_not_allowed', 'Method not allowed', { ...cors, Allow: 'POST, OPTIONS' });
      // Origin and Content-Type checks limit cross-site browser abuse; they are not authentication.
      if (!req.headers.origin) throw new AppError(403, 'origin_required', 'Origin header is required');
      const rl = limiter.hit(clientKey(req, trustProxy));
      if (!rl.ok) return sendError(res, 429, 'rate_limited', 'Too many votes; try again shortly', { ...cors, 'Retry-After': String(rl.retryAfter) });
      if (!JSON_CT.test(req.headers['content-type'] || '')) throw new AppError(415, 'unsupported_media_type', 'Content-Type must be application/json');
      const voter = voterHashFrom(req, true);
      const body = parseVoteBody(await readBody(req));
      const request = store.setVote(body.requestId, voter, body.voted);
      return sendJson(res, 200, { request }, cors);
    }
    return sendError(res, 404, 'not_found', 'Not found', cors);
  }

  async function handle(req, res) {
    let path;
    try {
      path = new URL(req.url, 'http://localhost').pathname;
    } catch {
      return sendError(res, 400, 'bad_request', 'Bad request');
    }
    const rawPath = (req.url || '').split('?')[0];
    if (path.startsWith('/api/') || rawPath.startsWith('/api/')) {
      const cors = { Vary: 'Origin' };
      const origin = req.headers.origin;
      if (origin !== undefined) {
        if (!origins.has(origin)) return sendError(res, 403, 'origin_not_allowed', 'Origin not allowed', cors);
        cors['Access-Control-Allow-Origin'] = origin;
        cors['Access-Control-Allow-Methods'] = 'GET, POST, OPTIONS';
        cors['Access-Control-Allow-Headers'] = 'content-type, x-voter-token';
      }
      try {
        return await handleApi(req, res, rawPath, cors);
      } catch (err) {
        if (err instanceof AppError) {
          const extra = { ...cors };
          if (err.status === 413) extra.Connection = 'close';
          return sendError(res, err.status, err.code, err.message, extra);
        }
        throw err;
      }
    }
    if (staticEnabled && (req.method === 'GET' || req.method === 'HEAD')) {
      if (rawPath === '/config.json') {
        return sendJson(res, 200, { apiBaseUrl: sameOriginBase(req) });
      }
      return serveStatic(req, res, staticRoot, rawPath, sendError);
    }
    return sendError(res, 404, 'not_found', 'Not found');
  }

  function sameOriginBase(req) {
    const candidate = `http://${req.headers.host || ''}`;
    if (origins.has(candidate)) return candidate;
    const local = [...origins].find((o) => o.startsWith('http://127.0.0.1:') || o.startsWith('http://localhost:'));
    return local || '';
  }

  const server = createHttpServer({ requestTimeout: 15_000, headersTimeout: 10_000, maxHeaderSize: 16 * 1024 }, (req, res) => {
    handle(req, res).catch((err) => {
      // Never log request bodies, headers, tokens or IPs.
      console.error('internal error:', err && err.code ? err.code : (err && err.name) || 'Error');
      if (!res.headersSent) sendError(res, 500, 'internal_error', 'Internal server error');
      else res.destroy();
    });
  });
  server.keepAliveTimeout = 5_000;

  let closing = null;
  function close() {
    if (!closing) {
      closing = new Promise((resolveClose) => {
        if (!server.listening) { store.close(); resolveClose(); return; }
        server.close(() => { store.close(); resolveClose(); });
        server.closeIdleConnections();
        setTimeout(() => server.closeAllConnections(), 5_000).unref();
      });
    }
    return closing;
  }

  return { server, store, limiter, close };
}
