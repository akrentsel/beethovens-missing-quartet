// Live draft tests: node --test tests/drafts.test.mjs
// All scores here are tiny TEST FIXTURES, never published anywhere.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {
  mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync, symlinkSync, existsSync, readdirSync, chmodSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createApp, optionsFromEnv } from '../server/index.mjs';
import { VoteStore } from '../server/db.mjs';
import { loadCatalog } from '../server/catalog.mjs';
import { analyzeAbc, validatePayload, DraftError, LIMITS } from '../server/draft-validation.mjs';
import { publishDraft, defaultDraftRoot } from '../server/drafts.mjs';
import { buildPayload, parseArgs } from '../tools/publish-draft.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CATALOG_PATH = join(ROOT, 'data/catalog.json');
const CLI = join(ROOT, 'server/draft-cli.mjs');
const TOOL = join(ROOT, 'tools/publish-draft.mjs');
const ORIGIN = 'https://lost-compositions.exe.xyz';
const REQ = 'bach:violin-sonata:1';
const tmpRoot = mkdtempSync(join(tmpdir(), 'mw-drafts-'));
after(() => rmSync(tmpRoot, { recursive: true, force: true }));
let counter = 0;
const sha = (s) => createHash('sha256').update(s).digest('hex');

// ---------- fixtures ----------

// Bach-style trio texture (violin + two harpsichord voices), 3/4 with a pickup.
const TRIO = `%%label I. Adagio (test fixture)
%%note Test fixture only.
X:1
T:Test fixture trio
M:3/4
L:1/8
Q:1/4=60
%%score 1 {2 3}
V:1 clef=treble name="Violin"
V:2 clef=treble name="Harpsichord"
V:3 clef=bass
K:Gm
V:1
%%MIDI program 40
V:2
%%MIDI program 0
V:3
%%MIDI program 0
[V:1] d2 | g3 a (3bag | f4 =e2 | f6- | f2 e2 d2 |]
[V:2] z2 | B6 | A4 G2 | A2 c2 B2 | A6 |]
[V:3] z2 | G,6 | C,4 C2 | F,6 | F,2 C2 D2 |]
`;
const H = 'X:1\nT:Test fixture\nM:4/4\nL:1/8\nQ:1/4=120\nK:C\n';
const two = (a, b) => `X:1\nT:Test fixture\nM:4/4\nL:1/8\nQ:1/4=120\nV:1\nV:2\nK:C\n[V:1] ${a}\n[V:2] ${b}\n`;

function payload(over = {}) {
  return {
    id: 'test-fixture-sonata',
    requestId: REQ,
    title: 'Test fixture sonata',
    subtitle: 'Fixture only',
    description: 'Not music; a test.',
    changeNote: 'First fixture take',
    movements: [{ id: 'i', label: 'I. Adagio', note: 'fixture', abc: TRIO }],
    ...over,
  };
}

function env(t) {
  mkdirSync(t.dir, { recursive: true });
  return { PATH: process.env.PATH, DB_PATH: t.dbPath, CATALOG_PATH, DRAFT_ROOT: t.draftRoot };
}

// A fresh database with the Bach violin sonata request in "composing".
function world() {
  const dir = join(tmpRoot, `w${++counter}`);
  const t = { dir, dbPath: join(dir, 'db', 'votes.sqlite'), draftRoot: join(dir, 'drafts') };
  const store = new VoteStore({ dbPath: t.dbPath, catalog: loadCatalog(CATALOG_PATH) });
  store.startRequest(REQ);
  store.close();
  return t;
}

function withStore(t, fn, catalog = loadCatalog(CATALOG_PATH)) {
  const store = new VoteStore({ dbPath: t.dbPath, catalog });
  try { return fn(store); } finally { store.close(); }
}

function publish(t, p, extra = {}) {
  return withStore(t, (store) => publishDraft({ root: t.draftRoot, store, payload: validatePayload(p), ...extra }));
}

function runCli(t, args, input) {
  return new Promise((res, rej) => {
    const child = spawn(process.execPath, [CLI, ...args], { env: env(t), stdio: ['pipe', 'pipe', 'pipe'] });
    const out = []; const err = [];
    child.stdout.on('data', (c) => out.push(c));
    child.stderr.on('data', (c) => err.push(c));
    child.stdin.on('error', () => {});
    child.on('error', rej);
    child.on('close', (code) => {
      const stdout = Buffer.concat(out).toString();
      let json; try { json = JSON.parse(stdout); } catch { json = undefined; }
      res({ code, stdout, stderr: Buffer.concat(err).toString(), json });
    });
    child.stdin.end(input);
  });
}

async function startApp(t, opts = {}) {
  const app = createApp({ dbPath: t.dbPath, catalogPath: CATALOG_PATH, draftRoot: t.draftRoot, ...opts });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  app.port = app.server.address().port;
  return app;
}

function get(app, path, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((res, rej) => {
    const req = http.request({ host: '127.0.0.1', port: app.port, method, path, headers, agent: false }, (r) => {
      const chunks = [];
      r.on('data', (c) => chunks.push(c));
      r.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json; try { json = JSON.parse(text); } catch { json = undefined; }
        res({ status: r.statusCode, headers: r.headers, text, json });
      });
    });
    req.on('error', rej);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

const abcError = (abc) => {
  try { analyzeAbc(abc, { label: 'x' }); } catch (e) { assert.ok(e instanceof DraftError, String(e)); return e; }
  assert.fail('expected the score to be rejected');
};

// ---------- ABC validation ----------

describe('ABC validation (abcjs parseOnly)', () => {
  test('three-voice Bach-style trio with pickup, triplet and tie', () => {
    const r = analyzeAbc(TRIO);
    assert.equal(r.voices, 3);
    assert.equal(r.bars, 4);
    assert.equal(r.pickup, '1/4');
    // 1/4 pickup + 4 bars of 3/4 = 13/4 whole notes; quarter = 60 -> 13 s
    assert.equal(r.durationSeconds, 13);
    assert.equal(r.sha256, sha(TRIO));
  });

  test('catalogue quartet movements validate with catalogue durations', () => {
    const cat = JSON.parse(readFileSync(CATALOG_PATH, 'utf8'));
    for (const m of cat.works[0].movements) {
      const r = analyzeAbc(readFileSync(join(ROOT, m.source), 'utf8'));
      assert.equal(Math.round(r.durationSeconds), m.durationSeconds, m.id);
      assert.equal(r.voices, 4);
      assert.ok(r.bars > 50);
    }
  });

  test('incomplete, overlong and unfinished bars are rejected', () => {
    assert.match(abcError(H + 'c8 | d6 | e8 |]\n').message, /bar 2 is incomplete.*missing 1\/4/);
    assert.match(abcError(H + 'c8 | d10 |]\n').message, /bar 2 is too long/);
    assert.match(abcError(H + 'c8 | d6\n').message, /unfinished final bar/);
    assert.match(abcError(H + 'c8 | d7 | e8 |]\n').message, /incomplete/);
  });

  test('triplets, quintuplets, broken rhythm, chords and whole-bar rests count exactly', () => {
    assert.equal(analyzeAbc(H + '(3cde c2 d2 e2 | A>B c<d e2 f2 | z8 | Z | [CEG]8- | [CEG]8 |]\n').bars, 6);
    assert.equal(analyzeAbc(H + '(5abcde c3 z3 | (3:2:6 cdecde c4 |]\n').bars, 2);
    assert.equal(analyzeAbc(H + 'c6 (3cde | f8 |]\n').bars, 2);
    // A triplet that is one note short leaves the bar short.
    assert.equal(abcError(H + '(3cd c6 |]\n').code, 'invalid_bars');
    assert.equal(analyzeAbc('X:1\nM:3/4\nL:1/8\nK:C\nZ2 | c6 |]\n').bars, 3);
  });

  test('meter changes and additive meters', () => {
    assert.equal(analyzeAbc(H + 'c8 | [M:3/4] c6 | [M:6/8] c3 d3 | [M:C|] c8 |]\n').bars, 4);
    assert.equal(analyzeAbc('X:1\nM:2+3/8\nL:1/8\nK:C\nc2 c3 | c3 c2 |]\n').bars, 2);
    assert.equal(abcError('X:1\nM:none\nL:1/8\nK:C\nc6 | c4 |]\n').code, 'unsupported_meter');
    assert.equal(abcError('X:1\nL:1/8\nK:C\nc8 | c8 |]\n').code, 'unsupported_meter');
    assert.equal(abcError('X:1\nM:3/4\nL:1/8\nK:C\nc6 | [M:2/4] Z2 | c4 |]\n').code, 'unsupported_construct');
    assert.match(abcError(H + 'c4 [M:3/4] c4 |]\n').message, /meter change in the middle/);
  });

  test('voices must align bar for bar', () => {
    assert.equal(analyzeAbc(two('c8 | d8 |]', 'C8 | D8 |]')).voices, 2);
    const e = abcError(two('c8 | d8 |]', 'C8 | D8 | E8 |]'));
    assert.equal(e.code, 'voices_misaligned');
    assert.match(e.message, /voice 1 has 2 bars, voice 2 has 3/);
    // Same count but one voice has a different pickup.
    assert.equal(abcError(two('c2 | c8 | d6 |]', 'C | C8 | D7 |]')).code, 'voices_misaligned');
  });

  test('parser warnings, extra tunes and empty scores are rejected', () => {
    const w = abcError(H + 'c8 | d8 q9 |]\n');
    assert.equal(w.code, 'abc_warnings');
    assert.ok(w.details.length >= 1 && !/<span/.test(w.details[0]));
    assert.equal(abcError(H + 'c8 | [d8 |]\n').code, 'abc_warnings');
    assert.match(abcError(H + 'c8|]\nX:2\nK:C\nc8|]\n').message, /exactly one tune/);
    assert.match(abcError(H + 'z8 | z8 |]\n').message, /no notes/);
    assert.match(abcError(H + 'c8 | d8 |] \nK:H\n').code, /abc_warnings/);
  });

  test('repeats are included in duration but bars are counted as written', () => {
    const r = analyzeAbc(H + '|: c8 :| d8 |1 e8 :|2 f8 |]\n');
    assert.equal(r.bars, 4);
    // played: c c d e d f = 6 bars of 2 s
    assert.equal(r.durationSeconds, 12);
    const tempoChange = analyzeAbc('X:1\nM:4/4\nL:1/8\nQ:1/4=60\nK:C\nc8 | [Q:1/4=120] c8 |]\n');
    assert.equal(tempoChange.durationSeconds, 6);
  });

  test('section pickups: a short bar before :| completes the pickup', () => {
    const r = analyzeAbc(H + '|: G | c8 | d7 :: e | f8 | g7 :|\n');
    assert.equal(r.bars, 4);
    assert.equal(r.pickup, '1/8');
  });

  test('payload limits and slugs', () => {
    const bad = (over, re) => assert.throws(() => validatePayload(payload(over)), (e) => e instanceof DraftError && re.test(e.message));
    bad({ id: '../etc' }, /slug/);
    bad({ id: 'A' }, /slug/);
    bad({ id: 'a'.repeat(81) }, /80/);
    bad({ requestId: 'bach' }, /composer:form:round/);
    bad({ changeNote: '' }, /changeNote/);
    bad({ title: 'x'.repeat(201) }, /title/);
    bad({ title: 'a\u0000b' }, /control/);
    bad({ extra: 1 }, /Unknown payload field/);
    bad({ expectedRevision: -1 }, /expectedRevision/);
    bad({ movements: [] }, /non-empty/);
    bad({ movements: Array.from({ length: 17 }, (_, i) => ({ id: `m${i}`, label: 'x', abc: TRIO })) }, /At most 16/);
    bad({ movements: [{ id: 'i', label: 'x', abc: TRIO }, { id: 'i', label: 'y', abc: TRIO }] }, /Duplicate/);
    bad({ movements: [{ id: 'i/../x', label: 'x', abc: TRIO }] }, /slug/);
    bad({ movements: [{ id: 'i', label: 'x', abc: TRIO, file: 'x' }] }, /Unknown field/);
    bad({ movements: [{ id: 'i', label: 'x', abc: '%' + 'x'.repeat(LIMITS.abcBytes) }] }, /at most/);
    // All movement problems are reported together.
    assert.throws(() => validatePayload(payload({ movements: [{ id: 'i', label: 'x', abc: H + 'c7|]\n' }, { id: 'ii', label: 'y', abc: H + 'c9|]\n' }] })),
      (e) => e.code === 'invalid_score' && e.details.some((d) => /movement i:/.test(d)) && e.details.some((d) => /movement ii:/.test(d)));
  });
});

// ---------- storage and publishing ----------

describe('publishing', () => {
  test('revisions are immutable and numbered; edits keep bar counts; failed publish keeps latest', () => {
    const t = world();
    const r1 = publish(t, payload(), { now: () => '2026-11-15T10:00:00.000Z' });
    assert.equal(r1.work.revision, 1);
    assert.equal(r1.work.composerId, 'bach');
    assert.equal(r1.work.formId, 'violin-sonata');
    assert.equal(r1.work.round, 1);
    assert.equal(r1.work.status, 'draft');
    assert.equal(r1.work.movements[0].source, 'api/drafts/test-fixture-sonata/revisions/1/i.abc');
    const src1 = join(t.draftRoot, 'test-fixture-sonata/revisions/1/i.abc');
    assert.equal(readFileSync(src1, 'utf8'), TRIO);

    const edited = TRIO.replace('f4 =e2', 'f4 g2');
    const r2 = publish(t, payload({ changeNote: 'Fix bar 2', expectedRevision: 1, movements: [{ id: 'i', label: 'I. Adagio', abc: edited }] }));
    assert.equal(r2.work.revision, 2);
    assert.equal(r2.work.movements[0].bars, r1.work.movements[0].bars);
    assert.notEqual(r2.work.movements[0].sha256, r1.work.movements[0].sha256);
    assert.equal(readFileSync(src1, 'utf8'), TRIO, 'revision 1 source untouched');

    // Invalid score: rejected before any write, latest stays 2.
    assert.throws(() => publish(t, payload({ movements: [{ id: 'i', label: 'x', abc: H + 'c7 |]\n' }] })), /validation failed/);
    // Stale expectedRevision.
    assert.throws(() => publish(t, payload({ expectedRevision: 1 })), (e) => e.code === 'stale_revision');
    const idx = JSON.parse(readFileSync(join(t.draftRoot, 'test-fixture-sonata/index.json'), 'utf8'));
    assert.equal(idx.latest, 2);
    assert.deepEqual(idx.revisions.map((r) => r.revision), [1, 2]);
    assert.deepEqual(readdirSync(join(t.draftRoot, 'test-fixture-sonata/revisions')).sort(), ['1', '2']);
  });

  test('request must be composing, match the draft, and have only one draft', () => {
    const t = world();
    assert.throws(() => publish(t, payload({ requestId: 'bach:symphony:1' })), (e) => e.code === 'request_not_composing');
    assert.throws(() => publish(t, payload({ requestId: 'bach:violin-sonata:9' })), (e) => e.code === 'unknown_request');
    publish(t, payload());
    withStore(t, (s) => s.startRequest('bach:symphony:1'));
    assert.throws(() => publish(t, payload({ requestId: 'bach:symphony:1' })), (e) => e.code === 'request_mismatch');
    assert.throws(() => publish(t, payload({ id: 'another-draft' })), (e) => e.code === 'request_has_draft');
    // Reopened request: drafts stay readable but cannot change.
    withStore(t, (s) => s.reopenRequest(REQ));
    assert.throws(() => publish(t, payload()), (e) => e.code === 'request_not_composing');
  });

  test('interrupted publishes: staging and orphaned revisions never become visible or get overwritten', async () => {
    const t = world();
    publish(t, payload());
    // Crash while staging (before the rename into revisions/).
    assert.throws(() => publish(t, payload({ changeNote: 'crashy 0' }), { hooks: { beforeRename: () => { throw new Error('simulated crash'); } } }), /simulated crash/);
    assert.ok(readdirSync(join(t.draftRoot, 'test-fixture-sonata')).some((n) => n.startsWith('.staging-')));
    assert.ok(!existsSync(join(t.draftRoot, 'test-fixture-sonata/revisions/2')));
    // Crash after the revision directory moved into place but before the index update.
    assert.throws(() => publish(t, payload({ changeNote: 'crashy' }), { hooks: { beforeIndex: () => { throw new Error('simulated crash'); } } }), /simulated crash/);
    assert.ok(existsSync(join(t.draftRoot, 'test-fixture-sonata/revisions/2/manifest.json')));
    // Leftovers from an external kill.
    mkdirSync(join(t.draftRoot, 'test-fixture-sonata/.staging-9-junk'));
    writeFileSync(join(t.draftRoot, 'test-fixture-sonata/.staging-9-junk/i.abc'), 'partial');
    mkdirSync(join(t.draftRoot, '.staging-elsewhere'));

    const app = await startApp(t);
    try {
      const d = await get(app, '/api/drafts/test-fixture-sonata');
      assert.equal(d.json.work.revision, 1);
      assert.equal((await get(app, '/api/drafts/test-fixture-sonata/revisions/2')).status, 404);
      assert.equal((await get(app, '/api/drafts/test-fixture-sonata/revisions/2/i.abc')).status, 404);
      const list = await get(app, '/api/drafts');
      assert.deepEqual(list.json.drafts.map((x) => x.id), ['test-fixture-sonata']);

      const r = publish(t, payload({ changeNote: 'after crash', expectedRevision: 1 }));
      assert.equal(r.work.revision, 2);
      assert.deepEqual(r.recovered.orphans, [2]);
      assert.ok(r.recovered.staging >= 1);
      const dir = join(t.draftRoot, 'test-fixture-sonata');
      assert.ok(!readdirSync(dir).some((n) => n.startsWith('.staging-')));
      const orphans = readdirSync(join(dir, '.orphans'));
      assert.equal(orphans.length, 1);
      assert.equal(JSON.parse(readFileSync(join(dir, '.orphans', orphans[0], 'manifest.json'), 'utf8')).changeNote, 'crashy');
      assert.equal(JSON.parse(readFileSync(join(dir, 'revisions/2/manifest.json'), 'utf8')).changeNote, 'after crash');
      assert.equal((await get(app, '/api/drafts/test-fixture-sonata')).json.work.changeNote, 'after crash');
    } finally {
      await app.close();
    }
  });
});

// ---------- CLI ----------

describe('draft CLI', () => {
  test('publish prints JSON with public URLs and no local paths; stale expectedRevision exits 3', async () => {
    const t = world();
    const r = await runCli(t, ['publish'], JSON.stringify(payload({ expectedRevision: 0 })));
    assert.equal(r.code, 0, r.stderr + r.stdout);
    assert.equal(r.json.ok, true);
    assert.equal(r.json.revision, 1);
    assert.equal(r.json.url, `${ORIGIN}/work.html?draft=test-fixture-sonata`);
    assert.equal(r.json.revisionUrl, `${ORIGIN}/work.html?draft=test-fixture-sonata&revision=1`);
    assert.ok(!r.stdout.includes(tmpRoot), 'no private paths');
    const stale = await runCli(t, ['publish'], JSON.stringify(payload({ expectedRevision: 0 })));
    assert.equal(stale.code, 3);
    assert.equal(stale.json.error.code, 'stale_revision');
    const bad = await runCli(t, ['publish'], JSON.stringify(payload({ movements: [{ id: 'i', label: 'x', abc: H + 'c7 |]\n' }] })));
    assert.equal(bad.code, 1);
    assert.equal(bad.json.error.code, 'invalid_score');
    assert.ok(bad.json.error.details.some((d) => /incomplete/.test(d)));
    assert.equal((await runCli(t, ['nope'], '')).code, 2);
    assert.equal((await runCli(t, ['publish', 'x'], '')).code, 2);
    assert.equal((await runCli(t, ['publish'], '{not json')).json.error.code, 'invalid_json');
    const idx = JSON.parse(readFileSync(join(t.draftRoot, 'test-fixture-sonata/index.json'), 'utf8'));
    assert.equal(idx.latest, 1);
  });

  test('validate writes nothing', async () => {
    const t = world();
    const r = await runCli(t, ['validate'], JSON.stringify(payload()));
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.json.movements[0].bars, 4);
    assert.ok(!existsSync(t.draftRoot));
  });

  test('stdin over 2 MiB is refused without writing', async () => {
    const t = world();
    const big = JSON.stringify(payload({ description: 'x', movements: [{ id: 'i', label: 'x', abc: TRIO + '%'.repeat(LIMITS.payloadBytes) }] }));
    const r = await runCli(t, ['publish'], big);
    assert.equal(r.code, 1);
    assert.equal(r.json.error.code, 'payload_too_large');
    assert.ok(!existsSync(join(t.draftRoot, 'test-fixture-sonata')));
  });

  test('two concurrent publish processes serialise into distinct revisions', async () => {
    const t = world();
    const results = await Promise.all([1, 2, 3].map((i) => runCli(t, ['publish'], JSON.stringify(payload({ changeNote: `take ${i}` })))));
    for (const r of results) assert.equal(r.code, 0, r.stderr + r.stdout);
    assert.deepEqual(results.map((r) => r.json.revision).sort(), [1, 2, 3]);
    const idx = JSON.parse(readFileSync(join(t.draftRoot, 'test-fixture-sonata/index.json'), 'utf8'));
    assert.deepEqual(idx.revisions.map((r) => r.revision), [1, 2, 3]);
    // With the same expectedRevision exactly one of two racers wins.
    const race = await Promise.all([1, 2].map((i) => runCli(t, ['publish'], JSON.stringify(payload({ changeNote: `race ${i}`, expectedRevision: 3 })))));
    assert.deepEqual(race.map((r) => r.code).sort(), [0, 3]);
  });
});

// ---------- public API ----------

describe('public draft API', () => {
  let t; let app;
  before(async () => {
    t = world();
    publish(t, payload(), { now: () => '2026-11-15T10:00:00.000Z' });
    publish(t, payload({ changeNote: 'Second take', movements: [{ id: 'i', label: 'I. Adagio', abc: TRIO }, { id: 'ii', label: 'II. Allegro', abc: H + '|: c8 :| d8 |]\n' }] }), { now: () => '2026-11-15T11:00:00.000Z' });
    writeFileSync(join(t.draftRoot, 'secret.txt'), 'private');
    app = await startApp(t);
  });
  after(() => app.close());

  test('list, detail, revision and source shapes', async () => {
    const list = await get(app, '/api/drafts');
    assert.equal(list.status, 200);
    assert.equal(list.headers['cache-control'], 'no-store');
    assert.deepEqual(list.json, { drafts: [{
      id: 'test-fixture-sonata', requestId: REQ, composerId: 'bach', formId: 'violin-sonata', title: 'Test fixture sonata',
      revision: 2, publishedAt: '2026-11-15T11:00:00.000Z', changeNote: 'Second take', status: 'composing', completedWorkId: null,
      movements: [{ id: 'i', label: 'I. Adagio', bars: 4 }, { id: 'ii', label: 'II. Allegro', bars: 2 }],
    }] });

    const d = await get(app, '/api/drafts/test-fixture-sonata');
    assert.equal(d.headers['cache-control'], 'no-store');
    assert.equal(d.json.status, 'composing');
    assert.equal(d.json.completedWorkId, null);
    assert.deepEqual(d.json.revisions, [
      { revision: 1, publishedAt: '2026-11-15T10:00:00.000Z', changeNote: 'First fixture take' },
      { revision: 2, publishedAt: '2026-11-15T11:00:00.000Z', changeNote: 'Second take' },
    ]);
    const w = d.json.work;
    assert.deepEqual(Object.keys(w), ['id', 'requestId', 'composerId', 'formId', 'round', 'title', 'subtitle', 'description', 'status', 'revision', 'publishedAt', 'changeNote', 'durationSeconds', 'movements']);
    assert.deepEqual(Object.keys(w.movements[0]), ['id', 'label', 'note', 'source', 'bars', 'durationSeconds', 'sha256']);
    assert.equal(w.movements[1].durationSeconds, 6);
    assert.equal(w.durationSeconds, 19);

    const r1 = await get(app, '/api/drafts/test-fixture-sonata/revisions/1');
    assert.equal(r1.json.work.revision, 1);
    assert.equal(r1.json.work.movements.length, 1);
    assert.match(r1.headers['cache-control'], /immutable/);

    const s = await get(app, '/' + r1.json.work.movements[0].source);
    assert.equal(s.status, 200);
    assert.equal(s.text, TRIO);
    assert.equal(sha(s.text), r1.json.work.movements[0].sha256);
    assert.match(s.headers['content-type'], /^text\/plain; charset=utf-8/);
    assert.match(s.headers['cache-control'], /immutable/);
    assert.equal(s.headers['x-content-type-options'], 'nosniff');
  });

  test('CORS: allowed origins get headers on JSON and text; others are refused', async () => {
    const h = { Origin: ORIGIN };
    const j = await get(app, '/api/drafts/test-fixture-sonata', { headers: h });
    assert.equal(j.headers['access-control-allow-origin'], ORIGIN);
    const s = await get(app, '/api/drafts/test-fixture-sonata/revisions/1/i.abc', { headers: h });
    assert.equal(s.status, 200);
    assert.equal(s.headers['access-control-allow-origin'], ORIGIN);
    assert.equal(s.headers.vary, 'Origin');
    const bad = await get(app, '/api/drafts/test-fixture-sonata/revisions/1/i.abc', { headers: { Origin: 'https://evil.example' } });
    assert.equal(bad.status, 403);
    assert.ok(!bad.text.includes('Adagio'));
    const pre = await get(app, '/api/drafts', { method: 'OPTIONS', headers: h });
    assert.equal(pre.status, 204);
  });

  test('no public writes and no path tricks', async () => {
    for (const method of ['POST', 'PUT', 'DELETE', 'PATCH']) {
      const r = await get(app, '/api/drafts/test-fixture-sonata', { method, headers: { Origin: ORIGIN, 'Content-Type': 'application/json' }, body: '{}' });
      assert.equal(r.status, 405, method);
    }
    const paths = [
      '/api/drafts/', '/api/drafts/test-fixture-sonata/', '/api/drafts/test-fixture-sonata/index.json',
      '/api/drafts/test-fixture-sonata/revisions', '/api/drafts/test-fixture-sonata/revisions/0',
      '/api/drafts/test-fixture-sonata/revisions/01', '/api/drafts/test-fixture-sonata/revisions/3',
      '/api/drafts/test-fixture-sonata/revisions/1/manifest.json', '/api/drafts/test-fixture-sonata/revisions/1/ii.abc',
      '/api/drafts/test-fixture-sonata/revisions/1/missing.abc', '/api/drafts/test-fixture-sonata/revisions/1/i.ABC',
      '/api/drafts/test-fixture-sonata/revisions/1/../../index.json', '/api/drafts/..%2fsecret.txt', '/api/drafts/%2e%2e',
      '/api/drafts/test-fixture-sonata/revisions/1/%2e%2e%2fi.abc', '/api/drafts/secret.txt', '/api/drafts/.staging-x',
      '/api/drafts/unknown', '/api/drafts/Test-Fixture-Sonata', '/api/drafts/test-fixture-sonata/revisions/1/i.abc/x',
      '/api/drafts/test-fixture-sonata/revisions/99999999999/i.abc', '/api/drafts/test-fixture-sonata/revisions/1%2fi.abc',
    ];
    for (const p of paths) {
      const r = await get(app, p);
      assert.equal(r.status, 404, `${p} -> ${r.status}`);
      assert.equal(r.headers['cache-control'], 'no-store', p);
      assert.ok(!r.text.includes(tmpRoot) && !r.text.includes('private'), p);
    }
    // Query strings are ignored, not interpreted.
    assert.equal((await get(app, '/api/drafts/test-fixture-sonata/revisions/1/i.abc?x=../../secret')).text, TRIO);
  });

  test('a symlinked source is not followed', async () => {
    const t2 = world();
    publish(t2, payload());
    const f = join(t2.draftRoot, 'test-fixture-sonata/revisions/1/i.abc');
    rmSync(f);
    writeFileSync(join(t2.dir, 'outside.txt'), 'outside secret');
    symlinkSync(join(t2.dir, 'outside.txt'), f);
    const a2 = await startApp(t2);
    try {
      const r = await get(a2, '/api/drafts/test-fixture-sonata/revisions/1/i.abc');
      assert.equal(r.status, 404);
      assert.ok(!r.text.includes('outside secret'));
    } finally {
      await a2.close();
    }
  });

  test('after completion: status, completedWorkId, archive still readable, no more publishing; survives restart', async () => {
    const t3 = world();
    publish(t3, payload());
    const catalog = loadCatalog(CATALOG_PATH);
    catalog.works.push({ id: 'test-fixture-finished-sonata', composerId: 'bach', formId: 'violin-sonata', round: 1, status: 'completed', date: null });
    withStore(t3, (s) => s.completeRequest(REQ, 'test-fixture-finished-sonata'), catalog);
    assert.throws(() => publish(t3, payload()), (e) => e.code === 'request_completed');
    const a3 = await startApp(t3, { catalog });
    try {
      const list = await get(a3, '/api/drafts');
      assert.equal(list.json.drafts[0].status, 'completed');
      assert.equal(list.json.drafts[0].completedWorkId, 'test-fixture-finished-sonata');
      const d = await get(a3, '/api/drafts/test-fixture-sonata');
      assert.equal(d.json.status, 'completed');
      assert.equal(d.json.completedWorkId, 'test-fixture-finished-sonata');
      assert.equal(d.json.work.status, 'draft', 'historical snapshots stay draft-labelled');
      assert.equal((await get(a3, '/api/drafts/test-fixture-sonata/revisions/1/i.abc')).text, TRIO);
    } finally {
      await a3.close();
    }
    const r = await runCli(t3, ['publish'], JSON.stringify(payload()));
    assert.equal(r.code, 1);
    assert.equal(r.json.error.code, 'request_completed');
  });

  test('no drafts directory: empty list, catalogue routes unaffected', async () => {
    const t4 = world();
    const a4 = await startApp(t4);
    try {
      assert.deepEqual((await get(a4, '/api/drafts')).json, { drafts: [] });
      assert.equal((await get(a4, '/api/requests')).status, 200);
    } finally {
      await a4.close();
    }
  });

  test('DRAFT_ROOT option defaults next to the database', () => {
    assert.equal(optionsFromEnv({ DB_PATH: '/var/lib/missing-works/votes.sqlite' }).draftRoot, '/var/lib/missing-works/drafts');
    assert.equal(optionsFromEnv({ DB_PATH: '/x/v.sqlite', DRAFT_ROOT: '/srv/d' }).draftRoot, '/srv/d');
    assert.equal(defaultDraftRoot(':memory:'), null);
  });
});

// ---------- local helper ----------

describe('tools/publish-draft.mjs', () => {
  function descriptorDir(movements, extra = {}) {
    const dir = join(tmpRoot, `desc${++counter}`);
    mkdirSync(join(dir, 'scores'), { recursive: true });
    writeFileSync(join(dir, 'scores/i.abc'), TRIO);
    writeFileSync(join(dir, 'draft.json'), JSON.stringify({ id: 'test-fixture-sonata', requestId: REQ, title: 'Test fixture sonata', movements, ...extra }));
    return dir;
  }

  function runTool(args, envExtra = {}) {
    return new Promise((res) => {
      const child = spawn(process.execPath, [TOOL, ...args], { env: { PATH: process.env.PATH, ...envExtra }, stdio: ['ignore', 'pipe', 'pipe'] });
      const out = []; const err = [];
      child.stdout.on('data', (c) => out.push(c));
      child.stderr.on('data', (c) => err.push(c));
      child.on('close', (code) => res({ code, stdout: Buffer.concat(out).toString(), stderr: Buffer.concat(err).toString() }));
    });
  }

  test('builds payload from descriptor-relative .abc files', () => {
    const dir = descriptorDir([{ id: 'i', label: 'I. Adagio', file: 'scores/i.abc', note: 'n' }]);
    const p = buildPayload({ manifest: join(dir, 'draft.json'), message: 'msg', expect: 2 });
    assert.equal(p.movements[0].abc, TRIO);
    assert.equal(p.changeNote, 'msg');
    assert.equal(p.expectedRevision, 2);
    assert.ok(!('file' in p.movements[0]));
  });

  test('refuses non-.abc, missing, symlinked, URL and directory files', () => {
    for (const file of ['scores/i.txt', 'scores/none.abc', 'https://example.com/x.abc', 'scores']) {
      const dir = descriptorDir([{ id: 'i', label: 'x', file }]);
      writeFileSync(join(dir, 'scores/i.txt'), TRIO);
      assert.throws(() => buildPayload({ manifest: join(dir, 'draft.json'), message: 'm' }), DraftError, file);
    }
    const dir = descriptorDir([{ id: 'i', label: 'x', file: 'link.abc' }]);
    symlinkSync(join(dir, 'scores/i.abc'), join(dir, 'link.abc'));
    assert.throws(() => buildPayload({ manifest: join(dir, 'draft.json'), message: 'm' }), /regular file/);
    const d2 = descriptorDir([{ id: 'i', label: 'x', file: 'scores/i.abc' }], { composerId: 'mozart' });
    assert.throws(() => buildPayload({ manifest: join(d2, 'draft.json'), message: 'm' }), /Unknown descriptor field/);
  });

  test('argument parsing rejects unsafe hosts', () => {
    assert.throws(() => parseArgs(['--manifest', 'x', '--message', 'm', '--host', '-oProxyCommand=evil']), /host/);
    assert.throws(() => parseArgs(['--manifest', 'x', '--message', 'm', '--host', 'a b']), /host/);
    assert.throws(() => parseArgs(['--manifest', 'x', '--message', 'm', '--expect', '1.5']), /expect/);
    assert.equal(parseArgs(['--manifest', 'x', '--message', 'm', '--host', 'me@lost-compositions.exe.xyz']).host, 'me@lost-compositions.exe.xyz');
  });

  test('--dry-run prints a report without the raw score and without SSH', async () => {
    const dir = descriptorDir([{ id: 'i', label: 'I. Adagio', file: 'scores/i.abc' }]);
    const r = await runTool(['--manifest', join(dir, 'draft.json'), '--message', 'm', '--dry-run'], { MISSING_WORKS_SSH: '/nonexistent/ssh' });
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /i\s+4 bars\s+13 s\s+3 voice\(s\)\s+pickup 1\/4/);
    assert.match(r.stdout, /dry run/);
    assert.ok(!r.stdout.includes('%%MIDI'));
    const bad = descriptorDir([{ id: 'i', label: 'x', file: 'scores/i.abc' }]);
    writeFileSync(join(bad, 'scores/i.abc'), H + 'c7 |]\n');
    const rb = await runTool(['--manifest', join(bad, 'draft.json'), '--message', 'm', '--dry-run']);
    assert.equal(rb.code, 1);
    assert.match(rb.stderr, /incomplete/);
    assert.equal((await runTool(['--help'])).code, 0);
    assert.equal((await runTool([])).code, 2);
  });

  test('sends the payload on stdin to the fixed remote command (fake ssh)', async () => {
    const t = world();
    const dir = descriptorDir([{ id: 'i', label: 'I. Adagio', file: 'scores/i.abc' }], { title: 'Title with $(touch pwned) `x` ; quotes \' "' });
    const fake = join(t.dir, 'fake-ssh');
    const argvLog = join(t.dir, 'argv.json');
    writeFileSync(fake, `#!${process.execPath}
const { writeFileSync } = require('node:fs');
const { spawnSync } = require('node:child_process');
const args = process.argv.slice(2);
writeFileSync(${JSON.stringify(argvLog)}, JSON.stringify(args));
const remote = args[args.length - 1];
if (remote !== 'sudo -n -u missingworks /usr/local/bin/missing-works-draft publish') process.exit(99);
const r = spawnSync(process.execPath, [${JSON.stringify(CLI)}, 'publish'], { input: require('node:fs').readFileSync(0), env: ${JSON.stringify(env(t))} });
process.stdout.write(r.stdout); process.stderr.write(r.stderr); process.exit(r.status);
`);
    chmodSync(fake, 0o755);
    const r = await runTool(['--manifest', join(dir, 'draft.json'), '--message', 'first $(x)', '--expect', '0', '--host', 'me@example.test'], { MISSING_WORKS_SSH: fake });
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /published revision 1 of test-fixture-sonata/);
    const args = JSON.parse(readFileSync(argvLog, 'utf8'));
    assert.deepEqual(args, ['-T', '-o', 'BatchMode=yes', '--', 'me@example.test', 'sudo -n -u missingworks /usr/local/bin/missing-works-draft publish']);
    assert.ok(!existsSync(join(process.cwd(), 'pwned')));
    const m = JSON.parse(readFileSync(join(t.draftRoot, 'test-fixture-sonata/revisions/1/manifest.json'), 'utf8'));
    assert.equal(m.title, 'Title with $(touch pwned) `x` ; quotes \' "');
    assert.equal(m.changeNote, 'first $(x)');
    const again = await runTool(['--manifest', join(dir, 'draft.json'), '--message', 'x', '--expect', '0', '--host', 'me@example.test'], { MISSING_WORKS_SSH: fake });
    assert.equal(again.code, 3);
    assert.match(again.stderr, /stale_revision/);
  });
});
