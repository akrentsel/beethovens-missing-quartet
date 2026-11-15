// Backend tests: node --test tests/backend.test.mjs
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync, symlinkSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { createApp, optionsFromEnv } from '../server/index.mjs';
import { loadCatalog } from '../server/catalog.mjs';
import { RateLimiter, normaliseIp } from '../server/rate-limit.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CATALOG_PATH = join(ROOT, 'data/catalog.json');
const ORIGIN = 'https://lost-compositions.exe.xyz';
const tmpRoot = mkdtempSync(join(tmpdir(), 'mw-backend-'));
after(() => rmSync(tmpRoot, { recursive: true, force: true }));
let dbCounter = 0;
const freshDb = () => join(tmpRoot, `db${++dbCounter}`, 'votes.sqlite');
const sha = (s) => createHash('sha256').update(s).digest('hex');

async function start(opts = {}) {
  const app = createApp({ dbPath: opts.dbPath ?? freshDb(), catalogPath: CATALOG_PATH, rateLimitPerMinute: 10_000, globalRateLimitPerMinute: 100_000, ...opts });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  app.port = app.server.address().port;
  return app;
}

// Raw HTTP so paths are sent unnormalised and every header is under our control.
function request(app, { method = 'GET', path = '/', headers = {}, body, chunked = false }) {
  return new Promise((resolveReq, reject) => {
    const req = http.request({ host: '127.0.0.1', port: app.port, method, path, headers, agent: false }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json;
        try { json = JSON.parse(text); } catch { json = undefined; }
        resolveReq({ status: res.statusCode, headers: res.headers, text, json });
      });
    });
    req.on('error', reject);
    if (body !== undefined) {
      if (chunked) {
        const buf = Buffer.from(body);
        for (let i = 0; i < buf.length; i += 512) req.write(buf.subarray(i, i + 512));
      } else {
        req.setHeader('Content-Length', Buffer.byteLength(body));
        req.write(body);
      }
    }
    req.end();
  });
}

const vote = (app, token, requestId, voted = true, extra = {}) =>
  request(app, {
    method: 'POST',
    path: '/api/votes',
    headers: { Origin: ORIGIN, 'Content-Type': 'application/json', ...(token ? { 'X-Voter-Token': token } : {}), ...extra },
    body: JSON.stringify({ requestId, voted }),
  });

const list = (app, token) => request(app, { path: '/api/requests', headers: token ? { 'X-Voter-Token': token } : {} });
const find = (res, id) => res.json.requests.find((r) => r.id === id);

describe('seeding', () => {
  let app;
  before(async () => { app = await start(); });
  after(() => app.close());

  test('health', async () => {
    const r = await request(app, { path: '/api/health' });
    assert.equal(r.status, 200);
    assert.deepEqual(r.json, { ok: true });
  });

  test('144 open combinations plus completed Beethoven quartet round 1, no invented votes', async () => {
    const r = await list(app);
    assert.equal(r.status, 200);
    const reqs = r.json.requests;
    assert.equal(reqs.length, 145);
    const open = reqs.filter((x) => x.status === 'open');
    assert.equal(open.length, 144);
    const combos = new Set(open.map((x) => `${x.composerId}:${x.formId}`));
    assert.equal(combos.size, 144, 'one open round per combination');
    const done = reqs.filter((x) => x.status === 'completed');
    assert.equal(done.length, 1);
    assert.equal(done[0].id, 'beethoven:string-quartet:1');
    assert.equal(done[0].workId, 'beethoven-quartet-d-minor');
    const next = find(r, 'beethoven:string-quartet:2');
    assert.equal(next.status, 'open');
    assert.equal(next.round, 2);
    assert.equal(find(r, 'beethoven:string-quartet:1').round, 1);
    for (const x of reqs) {
      assert.equal(x.votes, 0);
      assert.equal(x.voted, false);
      assert.equal(x.id, `${x.composerId}:${x.formId}:${x.round}`);
      assert.deepEqual(Object.keys(x).sort(), ['composerId', 'createdAt', 'formId', 'id', 'round', 'status', 'votes', 'voted', 'workId'].sort());
      if (x.status !== 'completed') assert.equal(x.workId, null);
    }
    assert.ok(typeof r.json.updatedAt === 'string' && !Number.isNaN(Date.parse(r.json.updatedAt)));
    assert.match(r.headers['cache-control'], /no-store/);
  });

  test('database enforces status, composer, form and one active round per combination', () => {
    const db = app.store.db;
    const now = new Date().toISOString();
    const ins = db.prepare('INSERT INTO requests (id, composer_id, form_id, round, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)');
    assert.throws(() => ins.run('bach:symphony:9', 'bach', 'symphony', 9, 'open', now, now), /UNIQUE/);
    assert.throws(() => ins.run('bach:symphony:9', 'bach', 'symphony', 9, 'pending', now, now), /CHECK/);
    assert.throws(() => ins.run('nobody:symphony:1', 'nobody', 'symphony', 1, 'open', now, now), /FOREIGN KEY/);
    assert.throws(() => ins.run('bach:opera:1', 'bach', 'opera', 1, 'open', now, now), /FOREIGN KEY/);
    assert.throws(() => ins.run('bach:symphony:7', 'bach', 'symphony', 9, 'open', now, now), /CHECK/);
    assert.equal(db.prepare('PRAGMA journal_mode').get().journal_mode, 'wal');
    assert.equal(Number(db.prepare('PRAGMA foreign_keys').get().foreign_keys), 1);
  });
});

describe('voting', () => {
  let app;
  before(async () => { app = await start(); });
  after(() => app.close());

  test('new, repeated and undone votes are idempotent', async () => {
    const t = randomUUID();
    let r = await vote(app, t, 'bach:symphony:1', true);
    assert.equal(r.status, 200);
    assert.equal(r.json.request.id, 'bach:symphony:1');
    assert.equal(r.json.request.votes, 1);
    assert.equal(r.json.request.voted, true);
    r = await vote(app, t, 'bach:symphony:1', true);
    assert.equal(r.json.request.votes, 1, 'repeat does not double count');
    r = await vote(app, t.toUpperCase(), 'bach:symphony:1', true);
    assert.equal(r.json.request.votes, 1, 'token is case-insensitive');
    r = await vote(app, t, 'bach:symphony:1', false);
    assert.equal(r.json.request.votes, 0);
    assert.equal(r.json.request.voted, false);
    r = await vote(app, t, 'bach:symphony:1', false);
    assert.equal(r.status, 200);
    assert.equal(r.json.request.votes, 0, 'repeat undo is a no-op');
  });

  test('independent tokens, multiple requests per token, voted flag per token', async () => {
    const a = randomUUID();
    const b = randomUUID();
    await vote(app, a, 'mozart:piano-sonata:1');
    await vote(app, b, 'mozart:piano-sonata:1');
    await vote(app, a, 'haydn:symphony:1');
    const ra = await list(app, a);
    assert.equal(find(ra, 'mozart:piano-sonata:1').votes, 2);
    assert.equal(find(ra, 'mozart:piano-sonata:1').voted, true);
    assert.equal(find(ra, 'haydn:symphony:1').voted, true);
    const rb = await list(app, b);
    assert.equal(find(rb, 'haydn:symphony:1').voted, false);
    assert.equal(find(rb, 'haydn:symphony:1').votes, 1);
    const anon = await list(app);
    assert.ok(anon.json.requests.every((x) => x.voted === false), 'voted defaults to false without token');
  });

  test('list sorted by votes desc, createdAt asc, id asc', async () => {
    const r = await list(app);
    const reqs = r.json.requests;
    assert.equal(reqs[0].id, 'mozart:piano-sonata:1');
    for (let i = 1; i < reqs.length; i++) {
      const p = reqs[i - 1];
      const c = reqs[i];
      const ok = p.votes > c.votes || (p.votes === c.votes && (p.createdAt < c.createdAt || (p.createdAt === c.createdAt && p.id < c.id)));
      assert.ok(ok, `${p.id} before ${c.id}`);
    }
  });

  test('simultaneous writes from many tokens and one token', async () => {
    const tokens = Array.from({ length: 50 }, () => randomUUID());
    const results = await Promise.all(tokens.map((t) => vote(app, t, 'brahms:symphony:1')));
    assert.ok(results.every((r) => r.status === 200));
    const same = randomUUID();
    const dup = await Promise.all(Array.from({ length: 20 }, () => vote(app, same, 'brahms:symphony:1')));
    assert.ok(dup.every((r) => r.status === 200));
    const mixed = await Promise.all([
      ...tokens.slice(0, 10).map((t) => vote(app, t, 'brahms:symphony:1', false)),
      ...tokens.slice(10, 20).map((t) => vote(app, t, 'brahms:symphony:1', true)),
    ]);
    assert.ok(mixed.every((r) => r.status === 200));
    assert.equal(find(await list(app), 'brahms:symphony:1').votes, 41);
  });

  test('public responses never contain token or token hash', async () => {
    const t = randomUUID();
    const v = await vote(app, t, 'chopin:piano-sonata:1');
    const l = await list(app, t);
    for (const text of [v.text, l.text]) {
      assert.ok(!text.includes(sha(t)), 'no hash');
      assert.ok(!text.includes(t), 'no raw token');
      assert.ok(!/[0-9a-f]{64}/.test(text), 'no hash-like values');
    }
    const stored = app.store.db.prepare('SELECT voter_hash FROM votes WHERE request_id = ?').all('chopin:piano-sonata:1');
    assert.deepEqual(stored.map((s) => s.voter_hash), [sha(t)]);
    const cols = app.store.db.prepare("SELECT name FROM pragma_table_info('votes')").all().map((c) => c.name);
    assert.deepEqual(cols.sort(), ['created_at', 'request_id', 'voter_hash']);
  });

  test('missing and malformed tokens', async () => {
    let r = await vote(app, null, 'bach:symphony:1');
    assert.equal(r.status, 400);
    for (const bad of ['', 'abc', 'not-a-uuid-at-all-0000000000000000', `${randomUUID()}x`, `${randomUUID()}-0`, `{${randomUUID()}}`, '../../etc/passwd']) {
      r = await vote(app, bad, 'bach:symphony:1');
      assert.equal(r.status, 400, `token ${JSON.stringify(bad)}`);
    }
    r = await request(app, { path: '/api/requests', headers: { 'X-Voter-Token': 'nope' } });
    assert.equal(r.status, 400);
    assert.equal(find(await list(app), 'bach:symphony:1').votes, 0);
  });

  test('invalid IDs, bodies and content types', async () => {
    const t = randomUUID();
    let r = await vote(app, t, 'nobody:symphony:1');
    assert.equal(r.status, 404);
    r = await vote(app, t, 'bach:symphony:99');
    assert.equal(r.status, 404);
    for (const id of ['', 'bach', 'bach:symphony', 'bach:symphony:0', 'bach:symphony:-1', 'BACH:symphony:1', "bach:symphony:1' OR 1=1", 'bach:symphony:1:1', 'x'.repeat(200)]) {
      r = await vote(app, t, id);
      assert.equal(r.status, 400, `id ${JSON.stringify(id)}`);
    }
    const post = (body, ct = 'application/json') => request(app, { method: 'POST', path: '/api/votes', headers: { Origin: ORIGIN, 'Content-Type': ct, 'X-Voter-Token': t }, body });
    for (const body of ['', 'null', '[]', '"x"', '{', '{"requestId":"bach:symphony:1"}', '{"requestId":"bach:symphony:1","voted":"true"}', '{"requestId":"bach:symphony:1","voted":1}', '{"requestId":"bach:symphony:1","voted":true,"votes":99}', '{"requestId":5,"voted":true}']) {
      r = await post(body);
      assert.equal(r.status, 400, `body ${body}`);
      assert.ok(r.json.error && typeof r.json.error.message === 'string');
      assert.ok(!/sqlite|SELECT|INSERT/i.test(r.text), 'no SQL details');
    }
    r = await post('{"requestId":"bach:symphony:1","voted":true}', 'text/plain');
    assert.equal(r.status, 415);
    r = await post('requestId=bach:symphony:1&voted=true', 'application/x-www-form-urlencoded');
    assert.equal(r.status, 415);
    r = await post('{"requestId":"bach:symphony:1","voted":true}', 'application/json; charset=utf-8');
    assert.equal(r.status, 200);
    r = await request(app, { method: 'PUT', path: '/api/votes', headers: { Origin: ORIGIN } });
    assert.equal(r.status, 405);
    r = await request(app, { path: '/api/admin' });
    assert.equal(r.status, 404);
  });

  test('oversized bodies are rejected without changing state', async () => {
    const t = randomUUID();
    const big = JSON.stringify({ requestId: 'bach:violin-sonata:1', voted: true, pad: 'x'.repeat(3000) });
    const headers = { Origin: ORIGIN, 'Content-Type': 'application/json', 'X-Voter-Token': t };
    let r = await request(app, { method: 'POST', path: '/api/votes', headers, body: big });
    assert.equal(r.status, 413);
    r = await request(app, { method: 'POST', path: '/api/votes', headers, body: big, chunked: true });
    assert.equal(r.status, 413);
    const exact = JSON.stringify({ requestId: 'bach:violin-sonata:1', voted: true }).padEnd(2048, ' ');
    r = await request(app, { method: 'POST', path: '/api/votes', headers, body: exact });
    assert.equal(r.status, 200, '2048 bytes is allowed');
    r = await request(app, { method: 'POST', path: '/api/votes', headers, body: exact + ' ' });
    assert.equal(r.status, 413);
    assert.equal(find(await list(app), 'bach:violin-sonata:1').votes, 1);
  });
});

describe('origins and CORS', () => {
  let app;
  before(async () => { app = await start({ allowedOrigins: [ORIGIN, 'http://127.0.0.1:3000'] }); });
  after(() => app.close());

  test('allowlisted origin gets exact CORS headers, never a wildcard', async () => {
    const r = await request(app, { path: '/api/requests', headers: { Origin: ORIGIN } });
    assert.equal(r.status, 200);
    assert.equal(r.headers['access-control-allow-origin'], ORIGIN);
    assert.match(r.headers.vary, /Origin/);
    const pre = await request(app, { method: 'OPTIONS', path: '/api/votes', headers: { Origin: ORIGIN, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type,x-voter-token' } });
    assert.equal(pre.status, 204);
    assert.equal(pre.headers['access-control-allow-origin'], ORIGIN);
    assert.equal(pre.headers['access-control-allow-methods'], 'GET, POST, OPTIONS');
    assert.equal(pre.headers['access-control-allow-headers'], 'content-type, x-voter-token');
    assert.equal(pre.headers['access-control-allow-credentials'], undefined);
    assert.match(pre.headers.vary, /Origin/);
  });

  test('untrusted origins are refused for reads, writes and preflight', async () => {
    const t = randomUUID();
    for (const origin of ['https://evil.example', 'https://akrentsel.github.io.evil.example', 'http://akrentsel.github.io', 'null', 'https://AKRENTSEL.github.io', `${ORIGIN}/`]) {
      let r = await vote(app, t, 'bach:symphony:1', true, { Origin: origin });
      assert.equal(r.status, 403, origin);
      assert.equal(r.headers['access-control-allow-origin'], undefined);
      assert.match(r.headers.vary, /Origin/);
      r = await request(app, { path: '/api/requests', headers: { Origin: origin } });
      assert.equal(r.status, 403);
      r = await request(app, { method: 'OPTIONS', path: '/api/votes', headers: { Origin: origin } });
      assert.equal(r.status, 403);
      assert.equal(r.headers['access-control-allow-origin'], undefined);
    }
    assert.equal(find(await list(app), 'bach:symphony:1').votes, 0);
  });

  test('GET without Origin works (CLI); writes require Origin', async () => {
    const r = await request(app, { path: '/api/requests' });
    assert.equal(r.status, 200);
    assert.equal(r.headers['access-control-allow-origin'], undefined);
    const w = await request(app, { method: 'POST', path: '/api/votes', headers: { 'Content-Type': 'application/json', 'X-Voter-Token': randomUUID() }, body: '{"requestId":"bach:symphony:1","voted":true}' });
    assert.equal(w.status, 403);
  });

  test('env options: production default and dev-only local origins', () => {
    assert.deepEqual(optionsFromEnv({}).allowedOrigins, [ORIGIN]);
    assert.deepEqual(optionsFromEnv({ NODE_ENV: 'production' }).allowedOrigins, [ORIGIN]);
    assert.deepEqual(optionsFromEnv({ SERVE_STATIC: 'true' }).allowedOrigins, [ORIGIN, 'http://127.0.0.1:3000', 'http://localhost:3000']);
    assert.deepEqual(optionsFromEnv({ ALLOWED_ORIGINS: 'https://a.example, https://b.example' }).allowedOrigins, ['https://a.example', 'https://b.example']);
    assert.throws(() => optionsFromEnv({ ALLOWED_ORIGINS: '*' }));
    assert.throws(() => optionsFromEnv({ ALLOWED_ORIGINS: 'https://a.example/path' }));
    const o = optionsFromEnv({});
    assert.equal(o.host, '127.0.0.1');
    assert.equal(o.port, 3000);
    assert.equal(o.trustProxy, false);
    assert.equal(o.rateLimitPerMinute, 30);
    assert.equal(o.dbPath, join(ROOT, 'var/votes.sqlite'));
  });
});

describe('rate limits', () => {
  test('per-client limit returns 429 with Retry-After', async () => {
    const app = await start({ rateLimitPerMinute: 3 });
    try {
      const t = randomUUID();
      for (let i = 0; i < 3; i++) assert.equal((await vote(app, t, 'bach:symphony:1', i % 2 === 0)).status, 200);
      const r = await vote(app, randomUUID(), 'bach:symphony:1');
      assert.equal(r.status, 429, 'new token does not reset an IP limit');
      assert.ok(Number(r.headers['retry-after']) >= 1);
      assert.equal((await list(app)).status, 200, 'reads are not write-limited');
    } finally { await app.close(); }
  });

  test('X-Forwarded-For is ignored unless TRUST_PROXY', async () => {
    const app = await start({ rateLimitPerMinute: 2 });
    try {
      for (let i = 0; i < 2; i++) assert.equal((await vote(app, randomUUID(), 'bach:symphony:1', true, { 'X-Forwarded-For': `203.0.113.${i}` })).status, 200);
      assert.equal((await vote(app, randomUUID(), 'bach:symphony:1', true, { 'X-Forwarded-For': '203.0.113.50' })).status, 429);
    } finally { await app.close(); }
  });

  test('trusted loopback proxy: rightmost XFF entry is the client; spoofed left entries are ignored', async () => {
    const app = await start({ rateLimitPerMinute: 2, trustProxy: true });
    try {
      const real = '198.51.100.7';
      // Attacker rotates the first (spoofable) entry; the proxy-appended last entry stays the same.
      for (let i = 0; i < 2; i++) {
        assert.equal((await vote(app, randomUUID(), 'bach:symphony:1', true, { 'X-Forwarded-For': `10.0.0.${i}, ${real}` })).status, 200);
      }
      let r = await vote(app, randomUUID(), 'bach:symphony:1', true, { 'X-Forwarded-For': `192.0.2.99, ${real}` });
      assert.equal(r.status, 429, 'spoofed first entry cannot pick a new bucket');
      r = await vote(app, randomUUID(), 'bach:symphony:1', true, { 'X-Forwarded-For': real });
      assert.equal(r.status, 429);
      // A different real client (different last entry) has its own bucket, even if it spoofs the first.
      r = await vote(app, randomUUID(), 'bach:symphony:1', true, { 'X-Forwarded-For': `${real}, 198.51.100.8` });
      assert.equal(r.status, 200);
      // Garbage XFF falls back to the peer address rather than failing open per request.
      assert.equal((await vote(app, randomUUID(), 'bach:symphony:1', true, { 'X-Forwarded-For': 'garbage' })).status, 200);
      assert.equal((await vote(app, randomUUID(), 'bach:symphony:1', true, { 'X-Forwarded-For': 'still-garbage' })).status, 200);
      assert.equal((await vote(app, randomUUID(), 'bach:symphony:1', true, { 'X-Forwarded-For': 'more-garbage' })).status, 429);
    } finally { await app.close(); }
  });

  test('global bound and bounded client map', () => {
    let now = 0;
    const rl = new RateLimiter({ perClient: 5, global: 10, maxClients: 100, now: () => now });
    for (let i = 0; i < 10; i++) assert.ok(rl.hit(`ip${i}`).ok);
    assert.equal(rl.hit('fresh').ok, false, 'global cap applies across clients');
    now = 61_000;
    assert.ok(rl.hit('fresh').ok, 'window resets');
    for (let i = 0; i < 1000; i++) rl.hit(`many${i}`);
    assert.ok(rl.clients.size <= 100, 'map stays bounded');
    assert.equal(normaliseIp('2001:db8:1:2:3:4:5:6'), normaliseIp('2001:db8:1:2:ffff::1'));
    assert.notEqual(normaliseIp('2001:db8:1:2::1'), normaliseIp('2001:db8:1:3::1'));
    assert.equal(normaliseIp('::ffff:203.0.113.4'), '203.0.113.4');
  });
});

describe('persistence and administration', () => {
  const workCatalogPath = join(tmpRoot, 'catalog-with-work.json');
  before(() => {
    const data = JSON.parse(readFileSync(CATALOG_PATH, 'utf8'));
    data.works.push(
      { id: 'test-bach-symphony-1', composerId: 'bach', formId: 'symphony', round: 1, status: 'completed', title: 'fixture' },
      { id: 'test-bach-symphony-3', composerId: 'bach', formId: 'symphony', round: 3, status: 'completed', title: 'fixture' },
      { id: 'test-haydn-symphony-1', composerId: 'haydn', formId: 'symphony', round: 1, status: 'completed', title: 'fixture' },
    );
    writeFileSync(workCatalogPath, JSON.stringify(data));
  });

  test('votes and statuses survive close/reopen; reseeding does not reset or duplicate', async () => {
    const dbPath = freshDb();
    let app = await start({ dbPath });
    const t = randomUUID();
    await vote(app, t, 'schubert:piano-sonata:1');
    await vote(app, randomUUID(), 'schubert:piano-sonata:1');
    await vote(app, t, 'ravel:violin-sonata:1');
    app.store.startRequest('ravel:violin-sonata:1');
    const before = (await list(app, t)).json;
    await app.close();
    app = await start({ dbPath });
    try {
      const after2 = (await list(app, t)).json;
      assert.deepEqual(after2, before);
      assert.equal(after2.requests.length, 145);
      assert.equal(find({ json: after2 }, 'ravel:violin-sonata:1').status, 'composing');
      assert.equal(after2.requests.filter((r) => r.composerId === 'ravel' && r.formId === 'violin-sonata').length, 1, 'no new open round while composing');
      assert.equal(find({ json: after2 }, 'schubert:piano-sonata:1').votes, 2);
      assert.equal(find({ json: after2 }, 'schubert:piano-sonata:1').voted, true);
    } finally { await app.close(); }
  });

  // Realistic workflow: the DB is seeded from the published catalogue; a new
  // work is added to the catalogue later, then the request is completed.
  async function seededThenUpdated(dbPath = freshDb()) {
    await (await start({ dbPath })).close();
    return start({ dbPath, catalogPath: workCatalogPath });
  }

  test('a catalogue update does not reseed existing combinations', async () => {
    const app = await seededThenUpdated();
    try {
      const l = await list(app);
      assert.equal(l.json.requests.length, 145);
      assert.equal(find(l, 'bach:symphony:1').status, 'open');
    } finally { await app.close(); }
  });

  test('status transitions, completion and next round', async () => {
    const app = await seededThenUpdated();
    try {
      const s = app.store;
      const t = randomUUID();
      await vote(app, t, 'bach:symphony:1');
      await vote(app, randomUUID(), 'bach:symphony:1');
      assert.throws(() => s.completeRequest('bach:symphony:1', 'test-bach-symphony-1'), /not composing/);
      assert.throws(() => s.reopenRequest('bach:symphony:1'), /not composing/);
      s.startRequest('bach:symphony:1');
      assert.throws(() => s.startRequest('bach:symphony:1'), /not open/);
      let r = await vote(app, t, 'bach:symphony:1', false);
      assert.equal(r.status, 409, 'cannot unvote while composing');
      r = await vote(app, randomUUID(), 'bach:symphony:1', true);
      assert.equal(r.status, 409, 'cannot vote while composing');
      s.reopenRequest('bach:symphony:1');
      assert.equal((await vote(app, randomUUID(), 'bach:symphony:1')).status, 200);
      s.startRequest('bach:symphony:1');
      assert.throws(() => s.completeRequest('bach:symphony:1', 'no-such-work'), /not in the catalogue/);
      assert.throws(() => s.completeRequest('bach:symphony:1', 'test-haydn-symphony-1'), /not bach:symphony:1/);
      assert.throws(() => s.completeRequest('bach:symphony:1', 'test-bach-symphony-3'), /not bach:symphony:1/);
      assert.throws(() => s.completeRequest('bach:symphony:1', 'beethoven-quartet-d-minor'), /not bach:symphony:1/);
      const res = s.completeRequest('bach:symphony:1', 'test-bach-symphony-1');
      assert.equal(res.completed.status, 'completed');
      assert.equal(res.completed.workId, 'test-bach-symphony-1');
      assert.equal(res.completed.votes, 3, 'votes preserved');
      assert.equal(res.next.id, 'bach:symphony:2');
      assert.equal(res.next.status, 'open');
      assert.equal(res.next.votes, 0);
      r = await vote(app, t, 'bach:symphony:1', false);
      assert.equal(r.status, 409, 'completed is closed');
      assert.throws(() => s.startRequest('bach:symphony:1'), /not open/);
      assert.throws(() => s.reopenRequest('bach:symphony:1'), /not composing/);
      const l = await list(app, t);
      assert.equal(l.json.requests.length, 146);
      assert.equal(find(l, 'bach:symphony:1').voted, true, 'voter history kept on completed rounds');
      assert.equal((await vote(app, t, 'bach:symphony:2')).status, 200);
    } finally { await app.close(); }
  });

  test('backup via VACUUM INTO restores with votes; refuses overwrite', async () => {
    const app = await start();
    const t = randomUUID();
    await vote(app, t, 'debussy:violin-sonata:1');
    await vote(app, randomUUID(), 'debussy:violin-sonata:1');
    const out = join(tmpRoot, 'backups', 'b1.sqlite');
    const info = app.store.backup(out);
    assert.equal(info.votes, 2);
    assert.equal(info.requests, 145);
    assert.throws(() => app.store.backup(out), /overwrite/);
    await vote(app, randomUUID(), 'debussy:violin-sonata:1');
    await app.close();
    const restored = await start({ dbPath: out });
    try {
      const l = await list(restored, t);
      assert.equal(find(l, 'debussy:violin-sonata:1').votes, 2);
      assert.equal(find(l, 'debussy:violin-sonata:1').voted, true);
      assert.equal(l.json.requests.length, 145);
    } finally { await restored.close(); }
  });

  test('admin CLI: queue, start, complete, reopen, backup and strict argument checking', async () => {
    const dbPath = freshDb();
    const app = await seededThenUpdated(dbPath);
    await vote(app, randomUUID(), 'haydn:symphony:1');
    await vote(app, randomUUID(), 'haydn:symphony:1');
    await vote(app, randomUUID(), 'adams:symphony:1');
    const env = { ...process.env, DB_PATH: dbPath, CATALOG_PATH: workCatalogPath };
    delete env.ALLOWED_ORIGINS;
    const cli = (...args) => spawnSync(process.execPath, [join(ROOT, 'server/admin.mjs'), ...args], { env, encoding: 'utf8' });
    try {
      let r = cli('queue', '--json');
      assert.equal(r.status, 0, r.stderr);
      const q = JSON.parse(r.stdout);
      assert.equal(q.queue.length, 144);
      assert.deepEqual(q.queue.slice(0, 2).map((x) => [x.id, x.votes]), [['haydn:symphony:1', 2], ['adams:symphony:1', 1]]);
      assert.ok(q.queue.every((x) => x.status === 'open'));
      assert.ok(!/[0-9a-f]{64}/.test(r.stdout));
      r = cli('queue');
      assert.equal(r.status, 0);
      assert.match(r.stdout, /1\.\s+2\s+haydn:symphony:1/);
      for (const bad of [[], ['nope'], ['queue', '--csv'], ['start'], ['start', 'a', 'b'], ['complete', 'haydn:symphony:1'], ['backup'], ['start', '--force']]) {
        r = cli(...bad);
        assert.notEqual(r.status, 0, `should fail: ${bad.join(' ')}`);
      }
      assert.equal(cli('start', 'nobody:symphony:1').status, 1);
      assert.equal(cli('complete', 'haydn:symphony:1', 'test-haydn-symphony-1').status, 1, 'must be composing');
      r = cli('start', 'haydn:symphony:1');
      assert.equal(r.status, 0, r.stderr);
      assert.equal((await vote(app, randomUUID(), 'haydn:symphony:1')).status, 409, 'running server sees CLI change');
      assert.equal(cli('reopen', 'haydn:symphony:1').status, 0);
      assert.equal(cli('start', 'haydn:symphony:1').status, 0);
      q.composing = JSON.parse(cli('queue', '--json').stdout).composing;
      assert.deepEqual(q.composing.map((x) => x.id), ['haydn:symphony:1']);
      assert.equal(cli('complete', 'haydn:symphony:1', 'test-bach-symphony-1').status, 1, 'work must match');
      r = cli('complete', 'haydn:symphony:1', 'test-haydn-symphony-1');
      assert.equal(r.status, 0, r.stderr);
      const l = await list(app);
      assert.equal(find(l, 'haydn:symphony:1').status, 'completed');
      assert.equal(find(l, 'haydn:symphony:1').votes, 2);
      assert.equal(find(l, 'haydn:symphony:2').status, 'open');
      const out = join(tmpRoot, 'cli-backup', 'votes.sqlite');
      r = cli('backup', out);
      assert.equal(r.status, 0, r.stderr);
      assert.ok(existsSync(out));
      assert.notEqual(cli('backup', out).status, 0, 'no overwrite');
      const b = new DatabaseSync(out, { readOnly: true });
      assert.equal(Number(b.prepare('SELECT count(*) AS n FROM votes').get().n), 3);
      b.close();
    } finally { await app.close(); }
  });
});

describe('static serving (SERVE_STATIC)', () => {
  let app;
  let fixtureApp;
  const fixtureRoot = join(tmpRoot, 'site');
  before(async () => {
    app = await start({ serveStatic: true, allowedOrigins: [ORIGIN, 'http://127.0.0.1:3000', 'http://localhost:3000'] });
    mkdirSync(join(fixtureRoot, 'assets'), { recursive: true });
    mkdirSync(join(fixtureRoot, 'scores'), { recursive: true });
    mkdirSync(join(fixtureRoot, 'server'), { recursive: true });
    writeFileSync(join(fixtureRoot, 'index.html'), '<p>index</p>');
    writeFileSync(join(fixtureRoot, 'assets', 'app.js'), 'console.log(1)');
    writeFileSync(join(fixtureRoot, 'assets', '.hidden.js'), 'SECRET');
    writeFileSync(join(fixtureRoot, 'server', 'secret.mjs'), 'SECRET');
    writeFileSync(join(tmpRoot, 'outside.js'), 'SECRET');
    symlinkSync(join(tmpRoot, 'outside.js'), join(fixtureRoot, 'assets', 'link.js'));
    symlinkSync(join(fixtureRoot, 'server', 'secret.mjs'), join(fixtureRoot, 'scores', 'link.abc'));
    fixtureApp = await start({ serveStatic: true, staticRoot: fixtureRoot });
  });
  after(async () => { await app.close(); await fixtureApp.close(); });

  test('public files are served', async () => {
    for (const p of ['/', '/index.html', '/beethoven.html', '/notebook.html', '/transcript.html', '/transcript.json', '/data/catalog.json', '/scores/01-dminor-i.abc']) {
      const r = await request(app, { path: p });
      assert.equal(r.status, 200, p);
    }
    assert.equal((await request(fixtureApp, { path: '/assets/app.js' })).status, 200);
    assert.match((await request(app, { path: '/data/catalog.json' })).headers['content-type'], /application\/json/);
  });

  test('config.json is generated with a same-origin apiBaseUrl', async () => {
    let r = await request(app, { path: '/config.json', headers: { Host: 'localhost:3000' } });
    assert.equal(r.status, 200);
    assert.deepEqual(r.json, { apiBaseUrl: 'http://localhost:3000' });
    r = await request(app, { path: '/config.json', headers: { Host: 'evil.example' } });
    assert.deepEqual(r.json, { apiBaseUrl: 'http://127.0.0.1:3000' }, 'Host header cannot inject an arbitrary API URL');
    const onDisk = JSON.parse(readFileSync(join(ROOT, 'config.json'), 'utf8'));
    assert.equal(typeof onDisk.apiBaseUrl, 'string', 'public config untouched');
  });

  test('private paths are never served, including encoded and traversal forms', async () => {
    const denied = [
      '/server/db.mjs', '/server/index.mjs', '/server/', '/.git/config', '/.git/HEAD', '/var/votes.sqlite', '/var/votes.sqlite-wal',
      '/deploy/README.md', '/docs/plan.md', '/tests/backend.test.mjs', '/.env', '/.gitignore', '/README.md', '/package.json',
      '/assets/../server/db.mjs', '/scores/../docs/plan.md', '/assets/%2e%2e/server/db.mjs', '/assets/%2E%2E%2Fserver%2Fdb.mjs',
      '/assets/..%2fserver%2fdb.mjs', '/scores/%2e%2e%2f%2e%2e%2fetc%2fpasswd', '/%2e%2e/%2e%2e/etc/passwd', '/..%2f..%2fetc%2fpasswd',
      '//server/db.mjs', '/assets//db.mjs', '/assets/..\\server\\db.mjs', '/assets/%5c..%5cserver%5cdb.mjs', '/index.html/..',
      '/%69ndex.html/../server/db.mjs', '/assets/', '/scores', '/data/', '/data/catalog.json/..', '/assets/x%00.js',
      '/scores/01-dminor-i.abc/../../server/db.mjs', '/assets/.hidden.js', '/.git', '/var/', '/tests/', '/server/admin.mjs',
    ];
    for (const p of denied) {
      for (const a of [app, fixtureApp]) {
        const r = await request(a, { path: p });
        assert.equal(r.status, 404, `${p} -> ${r.status}`);
        assert.ok(!r.text.includes('SECRET') && !r.text.includes('DatabaseSync') && !r.text.includes('[core]'), p);
      }
    }
  });

  test('symlinks escaping the public directories are refused', async () => {
    assert.equal((await request(fixtureApp, { path: '/assets/link.js' })).status, 404);
    assert.equal((await request(fixtureApp, { path: '/scores/link.abc' })).status, 404);
  });

  test('static files are not served unless SERVE_STATIC', async () => {
    const plain = await start();
    try {
      for (const p of ['/', '/index.html', '/config.json', '/data/catalog.json']) {
        assert.equal((await request(plain, { path: p })).status, 404, p);
      }
    } finally { await plain.close(); }
  });

  test('raw socket traversal request', async () => {
    const text = await new Promise((resolveText, reject) => {
      const sock = net.connect(app.port, '127.0.0.1', () => sock.write('GET /assets/../../../../etc/passwd HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n'));
      let buf = '';
      sock.on('data', (d) => { buf += d; });
      sock.on('end', () => resolveText(buf));
      sock.on('error', reject);
    });
    assert.match(text, /^HTTP\/1\.1 404/);
    assert.ok(!text.includes('root:'));
  });
});

test('catalogue sanity used by the seed', () => {
  const c = loadCatalog(CATALOG_PATH);
  assert.equal(c.composers.length, 36);
  assert.deepEqual(c.forms, ['string-quartet', 'violin-sonata', 'piano-sonata', 'symphony']);
});
