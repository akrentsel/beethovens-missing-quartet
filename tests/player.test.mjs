// Unit tests for the pure helpers in assets/player.js.
// Run: node --test tests/player.test.mjs
// Tests that parse real ABC need abcjs 6.5.2 locally: set ABCJS_PATH, or they use
// /home/mirendil/quartet/abcjs-basic-min.js when present, and are skipped otherwise.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const read = (p) => fs.readFileSync(path.join(root, p), "utf8");

// player.js is a classic browser script; run it with a CommonJS-style module object.
function loadCore() {
  const module = { exports: {} };
  vm.runInNewContext(read("assets/player.js"), { module, exports: module.exports, URL });
  return module.exports;
}
const P = loadCore();

const abcjsPath = process.env.ABCJS_PATH || "/home/mirendil/quartet/abcjs-basic-min.js";
let ABCJS = null;
try { if (fs.existsSync(abcjsPath)) ABCJS = createRequire(import.meta.url)(abcjsPath); } catch { ABCJS = null; }
const needAbc = { skip: ABCJS ? false : "abcjs not available locally" };

function partsOf(abc) {
  const tune = ABCJS.parseOnly(abc)[0];
  const tracks = tune.setUpAudio({}).tracks;
  return P.partsFromTune(tune, tracks, ABCJS.synth.instrumentIndexToName);
}

test("work ids", () => {
  assert.ok(P.validWorkId("beethoven-quartet-d-minor"));
  for (const bad of ["", "../x", "Beethoven", "a b", "a/b", "x".repeat(81), null, 3]) assert.equal(P.validWorkId(bad), false, String(bad));
});

test("manifest paths stay relative, same origin and traversal-free", () => {
  assert.equal(P.safeRelativePath("scores/01-dminor-i.abc", [".abc"]), "scores/01-dminor-i.abc");
  const bad = ["../secret.abc", "scores/../../x.abc", "/scores/a.abc", "//evil.example/a.abc", "https://evil.example/a.abc",
    "javascript:alert(1).abc", "scores\\a.abc", "scores/%2e%2e/a.abc", "scores/a.abc?x=1", "scores/a.abc#x", "./a.abc",
    "scores//a.abc", "scores/./a.abc", ".hidden.abc", "", null, "scores/a.txt", "data:text/plain,a.abc"];
  for (const p of bad) assert.equal(P.safeRelativePath(p, [".abc"]), null, String(p));
  const page = "https://example.org/site/work.html?id=x";
  assert.equal(P.resolveSameOrigin("scores/a.abc", page, [".abc"]), "https://example.org/site/scores/a.abc");
  assert.equal(P.resolveSameOrigin("https://evil.example/a.abc", page, [".abc"]), null);
  assert.equal(P.resolveSameOrigin("notebook.html", page, [".html"]), "https://example.org/site/notebook.html");
  assert.equal(P.resolveSameOrigin("notebook.html", page, [".abc"]), null);
});

test("only test fixtures can replace the catalogue", () => {
  assert.equal(P.catalogPathFrom(null), "data/catalog.json");
  assert.equal(P.catalogPathFrom(""), "data/catalog.json");
  assert.equal(P.catalogPathFrom("tests/fixtures/catalog.json"), "tests/fixtures/catalog.json");
  for (const p of ["data/other.json", "https://evil.example/tests/fixtures/c.json", "tests/fixtures/../../x.json", "tests/fixtures/a.abc"]) assert.equal(P.catalogPathFrom(p), null, p);
});

test("work lookup in the real catalogue, with no fallback", () => {
  const cat = JSON.parse(read("data/catalog.json"));
  const info = P.findWork(cat, "beethoven-quartet-d-minor");
  assert.ok(info);
  assert.equal(info.composer.id, "beethoven");
  assert.equal(info.work.movements.length, 4);
  for (const m of info.work.movements) {
    assert.ok(P.safeRelativePath(m.source, [".abc"]), m.source);
    assert.ok(fs.existsSync(path.join(root, m.source)), m.source);
  }
  assert.equal(P.findWork(cat, "mozart-symphony-imaginary"), null);
  assert.equal(P.findWork(cat, ""), null);
  assert.equal(P.findWork(cat, "../beethoven-quartet-d-minor"), null);
  assert.equal(P.findWork({}, "beethoven-quartet-d-minor"), null);
});

test("fixture catalogue is clearly a test catalogue", () => {
  const cat = JSON.parse(read("tests/fixtures/catalog.json"));
  assert.match(cat.title, /TEST FIXTURES/);
  for (const w of cat.works) assert.match(w.id, /^fixture-/);
  const real = JSON.parse(read("data/catalog.json"));
  assert.ok(!real.works.some((w) => /^fixture-/.test(w.id)), "fixtures must not be in the real catalogue");
});

test("stereo pan spreads any number of parts", () => {
  assert.deepEqual([...P.panFor(0)], []);
  assert.deepEqual([...P.panFor(1)], [0]);
  assert.deepEqual([...P.panFor(2)], [-0.6, 0.6]);
  assert.deepEqual([...P.panFor(4)], [-0.6, -0.2, 0.2, 0.6]);
  const six = P.panFor(6);
  assert.equal(six.length, 6);
  assert.ok(six.every((v, i) => i === 0 || v > six[i - 1]));
});

test("short-note lift is only for bowed strings", () => {
  assert.deepEqual([...P.BOWED], [40, 41, 42, 43, 48, 49]);
  assert.equal(P.shortNoteLift(0.1), 6);
  assert.equal(P.shortNoteLift(1.2), 0);
  assert.ok(P.shortNoteLift(0.5) > 0 && P.shortNoteLift(0.5) < 6);
  // tempo 120: a 1/16 note (duration 0.0625 of a whole) lasts 0.125 s.
  const mk = () => ({ tempo: 120, tracks: [40, 0, 73, 60, 48, 43, 42, 41, 49, 44].map((p) => [
    { cmd: "program", instrument: p }, { cmd: "note", instrument: p, duration: 0.0625, volume: 80 }, { cmd: "note", instrument: p, duration: 1, volume: 80 }]) });
  const seq = P.applySound(mk(), "score");
  const lifted = seq.tracks.map((t) => t[1].volume > 80);
  assert.deepEqual(lifted, [true, false, false, false, true, true, true, true, true, false]);
  assert.ok(seq.tracks.every((t) => t[2].volume === 80), "long notes untouched");
  assert.ok(seq.tracks.every((t) => t[1].volume <= 127));
  // muted notes (volume 0) stay muted
  const muted = P.applySound({ tempo: 120, tracks: [[{ cmd: "note", instrument: 40, duration: 0.0625, volume: 0 }]] }, "score");
  assert.equal(muted.tracks[0][0].volume, 0);
  // piano reduction: every part to program 0, and no string lift
  const piano = P.applySound(mk(), "piano");
  assert.ok(piano.tracks.every((t) => t.every((e) => e.instrument === 0)));
  assert.ok(piano.tracks.every((t) => t[1].volume === 80));
});

test("normalizeKeyChanges puts clefs into inline keys and joins lines", () => {
  const abc = read("tests/fixtures/six-part.abc");
  const out = P.normalizeKeyChanges(abc);
  assert.match(out, /\[V:Va\] \[K:Bb clef=alto\]/);
  assert.match(out, /\[V:Cb\] \[K:Bb clef=bass\]/);
  assert.equal(P.normalizeKeyChanges("X:1\nK:C\nabc|\n"), "X:1\nK:C\nabc|\n");
});

test("blanking keeps character positions", () => {
  const abc = "%%label I. Allegro\nX:1\nT:Title\nC:Someone\nK:C\nabc|\n";
  const out = P.blankTitles(P.blankMetaDirectives(abc));
  assert.equal(out.length, abc.length);
  assert.ok(!/Allegro|Title|Someone/.test(out));
  assert.match(out, /^%\s+\nX:1\nT:\s+\n%\s+\nK:C/);
});

test("MIDI header check", () => {
  assert.ok(P.isMidiHeader([0x4d, 0x54, 0x68, 0x64, 0, 0, 0, 6, 0, 1, 0, 2, 1, 0xe0]));
  assert.equal(P.isMidiHeader([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]), false);
  assert.equal(P.isMidiHeader(null), false);
});

test("normalizeChannels sets the peak to 0.9", () => {
  const a = new Float32Array([0.1, -2, 0.5]), b = new Float32Array([1, 0, -0.2]);
  assert.equal(P.normalizeChannels([a, b], 0.9), 2);
  assert.ok(Math.abs(Math.max(...a.map(Math.abs), ...b.map(Math.abs)) - 0.9) < 1e-6);
  assert.equal(P.normalizeChannels([new Float32Array(4)], 0.9), 0);
});

test("bounded concurrency and cancellation", async () => {
  let active = 0, peak = 0, ran = 0;
  const jobs = Array.from({ length: 20 }, () => () => { active++; ran++; peak = Math.max(peak, active); return new Promise((r) => setTimeout(() => { active--; r(); }, 2)); });
  const max = await P.runBounded(jobs, 6);
  assert.equal(ran, 20); assert.ok(peak <= 6 && max <= 6);
  let started = 0, stop = false;
  const jobs2 = Array.from({ length: 20 }, () => () => { started++; if (started === 3) stop = true; return Promise.resolve(); });
  await P.runBounded(jobs2, 2, () => stop);
  assert.ok(started < 20);
});

test("fmtTime", () => { assert.equal(P.fmtTime(0), "0:00"); assert.equal(P.fmtTime(382), "6:22"); assert.equal(P.fmtTime(-3), "0:00"); });

test("parts from synthetic tune: multiple voices per staff and missing names", () => {
  const tune = { lines: [{ staff: [{ title: ["Piano"], voices: [[], [], []] }, { title: [], voices: [[]] }] }] };
  const tr = (p) => [{ cmd: "program", instrument: p }, { cmd: "note", instrument: p }];
  const parts = P.partsFromTune(tune, [tr(0), tr(0), tr(0), tr(40)]);
  assert.deepEqual(parts.map((p) => p.label), ["Piano (1)", "Piano (2)", "Piano (3)", "Part 4"]);
  assert.deepEqual(parts.map((p) => p.program), [0, 0, 0, 40]);
  // duplicate names are told apart
  const dup = P.partsFromTune({ lines: [{ staff: [{ title: ["Vn"], voices: [[]] }, { title: ["Vn"], voices: [[]] }] }] }, [tr(40), tr(40)]);
  assert.deepEqual(dup.map((p) => p.label), ["Vn", "Vn 2"]);
});

const FIXTURES = [
  ["one-part", ["Flute"], [73]],
  ["two-part", ["Violin", "Piano"], [40, 0]],
  ["three-part", ["Clarinet", "Piano (1)", "Piano (2)"], [71, 0, 0]],
  ["six-part", ["Flute", "Horn", "Violins", "Viola", "Cello", "Bass"], [73, 60, 48, 41, 42, 43]],
];
for (const [name, labels, programs] of FIXTURES) {
  test(`fixture ${name}: labels and programs from the score`, needAbc, () => {
    const parts = partsOf(read(`tests/fixtures/${name}.abc`));
    assert.deepEqual(parts.map((p) => p.label), labels);
    assert.deepEqual(parts.map((p) => p.program), programs);
    assert.ok(parts.every((p) => p.notes > 0));
    const tune = ABCJS.parseOnly(P.blankTitles(P.normalizeKeyChanges(read(`tests/fixtures/${name}.abc`))))[0];
    assert.deepEqual(tune.warnings || [], []);
  });
}

test("the four quartet movements: four string parts, no notation warnings", needAbc, () => {
  const cat = JSON.parse(read("data/catalog.json"));
  for (const m of P.findWork(cat, "beethoven-quartet-d-minor").work.movements) {
    const abc = read(m.source);
    const parts = partsOf(abc);
    assert.deepEqual(parts.map((p) => p.label), ["Vl. I", "Vl. II", "Vla.", "Vc."], m.source);
    assert.deepEqual(parts.map((p) => p.program), [40, 40, 41, 42], m.source);
    const tune = ABCJS.parseOnly(P.blankTitles(P.normalizeKeyChanges(P.blankMetaDirectives(abc))))[0];
    assert.deepEqual(tune.warnings || [], [], m.source);
    const midi = ABCJS.synth.getMidiFile(abc, { midiOutputType: "binary" })[0];
    assert.ok(P.isMidiHeader(midi), m.source);
  }
});

test('a cancelled synth build keeps its buffer until prime finishes, then destroys once', async () => {
  const life = P.createSynthLifecycle(); let resolve, paused = 0, destroyed = 0;
  const gate = new Promise(r => { resolve = r; });
  const sc = { midiBuffer: { prime() { return 'ready'; } }, pause() { paused++; }, destroy() { destroyed++; this.midiBuffer = null; } };
  const build = life.build(sc, async () => { await gate; return sc.midiBuffer.prime(); });
  await Promise.resolve(); // enter the deferred build, reproducing the race deterministically
  life.dispose(sc);
  assert.equal(paused, 1); assert.equal(destroyed, 0); assert.ok(sc.midiBuffer);
  resolve(); assert.equal(await build, 'ready');
  assert.equal(destroyed, 1); assert.equal(sc.midiBuffer, null);
  life.dispose(sc); assert.equal(destroyed, 1);
});

test('cancelled failed synth builds also dispose exactly once', async () => {
  const life = P.createSynthLifecycle(); let reject, destroyed = 0;
  const gate = new Promise((_,r) => { reject = r; });
  const sc = { pause() {}, destroy() { destroyed++; } };
  const build = life.build(sc, () => gate); await Promise.resolve(); life.dispose(sc);
  reject(new Error('sample failed')); await assert.rejects(build, /sample failed/);
  assert.equal(destroyed, 1);
});
