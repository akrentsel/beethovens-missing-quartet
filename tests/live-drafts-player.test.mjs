// Unit tests for the live-draft helpers in assets/player.js (work.html?draft=ID).
// Run: node --test tests/live-drafts-player.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
function loadCore() {
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(root, "assets/player.js"), "utf8"), { module, exports: module.exports, URL });
  return module.exports;
}
const P = loadCore();
const ID = "test-draft";
const manifest = (rev, extra = {}) => ({
  id: ID, requestId: "test:sonata:1", composerId: "test-fixture", formId: "symphony", round: 1, title: "Draft", status: "draft",
  revision: rev, publishedAt: "2026-11-15T10:00:00Z", changeNote: "Added bars", durationSeconds: 10,
  movements: [{ id: "i", label: "I", note: "", source: `api/drafts/${ID}/revisions/${rev}/i.abc`, bars: 8, durationSeconds: 5, sha256: "x" }],
  ...extra
});

test("revision numbers and the ?revision parameter", () => {
  for (const ok of [1, 2, 999]) assert.ok(P.validRevision(ok));
  for (const bad of [0, -1, 1.5, NaN, Infinity, "2", null, 1e12]) assert.equal(P.validRevision(bad), false, String(bad));
  assert.equal(P.revisionParam(null), null);
  assert.equal(P.revisionParam(""), null);
  assert.equal(P.revisionParam("12"), 12);
  for (const bad of ["0", "-1", "1.5", "1e3", "x", "01", " 2"]) assert.ok(Number.isNaN(P.revisionParam(bad)), bad);
});

test("draft API paths are fixed, relative and only for valid IDs", () => {
  assert.equal(P.draftApiPath(ID), "api/drafts/test-draft");
  assert.equal(P.draftApiPath(ID, 3), "api/drafts/test-draft/revisions/3");
  for (const bad of ["../x", "a/b", "https:", "", "A"]) assert.equal(P.draftApiPath(bad), null, bad);
  assert.equal(P.draftApiPath(ID, 0), null);
  assert.equal(P.draftApiPath(ID, 1.5), null);
});

test("draft manifests: accepted shape is normalized", () => {
  const w = P.validateDraftManifest(manifest(3), ID, 3);
  assert.equal(w.revision, 3);
  assert.equal(w.status, "draft");
  assert.equal(w.movements[0].bars, 8);
  assert.equal(w.movements[0].source, "api/drafts/test-draft/revisions/3/i.abc");
  assert.equal(w.publishedAt, "2026-11-15T10:00:00.000Z");
  // change notes are kept as plain text; rendering uses textContent
  assert.equal(P.validateDraftManifest(manifest(3, { changeNote: "<img src=x onerror=alert(1)>" }), ID).changeNote, "<img src=x onerror=alert(1)>");
});

test("draft manifests: wrong IDs, revisions, status and sources are refused", () => {
  const bad = [
    [null, "no manifest"], [manifest(3, { id: "other" }), "different work"], [manifest(0), "revision"],
    [manifest(3, { revision: "3" }), "revision"], [manifest(3, { revision: 3.5 }), "revision"], [manifest(3, { status: "completed" }), "draft"],
    [manifest(3, { movements: [] }), "no movements"],
  ];
  for (const [w, re] of bad) assert.throws(() => P.validateDraftManifest(w, ID), new RegExp(re), JSON.stringify(w));
  assert.throws(() => P.validateDraftManifest(manifest(3), ID, 4), /instead of 4/);
  const src = (s) => manifest(3, { movements: [{ id: "i", label: "I", source: s, bars: 1 }] });
  for (const s of ["https://evil.example/api/drafts/test-draft/revisions/3/i.abc", "//evil.example/i.abc", "/api/drafts/test-draft/revisions/3/i.abc",
    "api/drafts/test-draft/revisions/2/i.abc", "api/drafts/other/revisions/3/i.abc", "api/drafts/test-draft/revisions/3/../../../../etc/passwd.abc",
    "api/drafts/test-draft/revisions/3/i.txt", "scores/01.abc", "api/drafts/test-draft/revisions/3/sub/i.abc", "api/drafts/test-draft/revisions/3/i.abc?x=1", 7])
    assert.throws(() => P.validateDraftManifest(src(s), ID), /score path/, String(s));
  const dup = manifest(3, { movements: [manifest(3).movements[0], manifest(3).movements[0]] });
  assert.throws(() => P.validateDraftManifest(dup, ID), /repeated/);
  assert.throws(() => P.validateDraftManifest(manifest(3, { movements: [{ id: "../x", source: "api/drafts/test-draft/revisions/3/x.abc" }] }), ID), /bad or repeated id/);
});

test("draft responses: status, revisions list and completion link", () => {
  const r = P.validateDraftResponse({ work: manifest(3), revisions: [{ revision: 1, publishedAt: "2026-11-15T09:00:00Z", changeNote: "a" }, { revision: 2 }, { revision: "x" }, { revision: 9 }], status: "composing", completedWorkId: null }, ID);
  assert.equal(JSON.stringify(r.revisions.map((x) => x.revision)), "[1,2,3]");   // invalid and future entries dropped, the current one added
  assert.equal(r.status, "composing");
  assert.equal(r.completedWorkId, null);
  const done = P.validateDraftResponse({ work: manifest(3), revisions: [], status: "completed", completedWorkId: "test-work" }, ID);
  assert.equal(done.completedWorkId, "test-work");
  assert.equal(P.validateDraftResponse({ work: manifest(3), status: "completed", completedWorkId: "https://evil.example" }, ID).completedWorkId, null);
  assert.equal(P.validateDraftResponse({ work: manifest(3), status: "open", completedWorkId: "test-work" }, ID).completedWorkId, null);
  assert.throws(() => P.validateDraftResponse({ work: manifest(3), status: "deleted" }, ID), /status/);
  assert.throws(() => P.validateDraftResponse(null, ID), /no data/);
});

test("poll delay backs off and caps", () => {
  assert.equal(JSON.stringify([0, 1, 2, 3, 4, 5, 9].map(P.pollDelay)), "[5000,10000,20000,40000,60000,60000,60000]");
});

test("update decision: only idle, unedited, following listeners get the new take automatically", () => {
  const base = { latest: 4, viewing: 3, follow: true, state: "idle", continuing: false, edited: false, busy: false };
  assert.equal(P.draftDecision(base), "apply");
  assert.equal(P.draftDecision({ ...base, latest: 3 }), "none");
  assert.equal(P.draftDecision({ ...base, latest: 2 }), "none");
  for (const state of ["playing", "paused", "loading"]) assert.equal(P.draftDecision({ ...base, state }), "offer", state);
  assert.equal(P.draftDecision({ ...base, edited: true }), "offer");
  assert.equal(P.draftDecision({ ...base, continuing: true }), "offer");
  assert.equal(P.draftDecision({ ...base, busy: true }), "offer");
  assert.equal(P.draftDecision({ ...base, follow: false }), "newer");
  assert.equal(P.draftDecision({ ...base, follow: false, state: "playing" }), "newer");
});

test("bar map from abcjs note timings: pickup, repeats and tempo change", () => {
  // Measured from abcjs 6.5.2 setTiming() for: Q:1/4=120 | C2 | C D E F |: G A B c :| [Q:1/4=60] d e f g | a b c' d' |]
  const t = [[0, 0, true], [1000, 1, true], [1500, 1], [3000, 2, true], [3500, 2], [5000, 2, true], [5500, 2], [7000, 3, true], [8000, 3], [11000, 4, true], [12000, 4]]
    .map(([ms, m, s]) => ({ type: "event", milliseconds: ms, measureNumber: m, measureStart: !!s }));
  t.push({ type: "end", milliseconds: 15000, measureNumber: null });
  const map = P.barMap(t);
  assert.equal(map.count, 5);
  assert.equal(map.repeats, true);
  assert.equal(JSON.stringify(P.barSeek(map, 3)), JSON.stringify({ bar: 3, requested: 3, clamped: false, ms: 3000, fraction: 0.2, repeats: true }));
  assert.equal(P.barSeek(map, 4).ms, 7000);                 // after the repeat, not at a constant-tempo estimate
  assert.equal(P.barSeek(map, 5).fraction, 11000 / 15000);  // after the tempo change
  assert.equal(P.barSeek(map, 99).bar, 5);
  assert.equal(P.barSeek(map, 99).clamped, true);
  assert.equal(P.barSeek(map, 0).bar, 1);
  assert.equal(P.barSeek(map, NaN), null);
  assert.equal(P.barMap([]), null);
  assert.equal(P.barSeek(null, 1), null);
  const noRepeat = P.barMap([{ milliseconds: 0, measureNumber: 0, measureStart: true }, { milliseconds: 250, measureNumber: 0 }, { milliseconds: 500, measureNumber: 1, measureStart: true }, { type: "end", milliseconds: 1000 }]);
  assert.equal(noRepeat.repeats, false);
});

test("ABC sanity check before replacing a take", () => {
  assert.ok(P.looksLikeAbc("X:1\nK:C\nC|"));
  for (const bad of ["", null, "<html>", "K:C\nC", "X:1\nC"]) assert.equal(P.looksLikeAbc(bad), false, String(bad));
});
