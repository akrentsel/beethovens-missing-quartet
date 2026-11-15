// Browser test for live drafts in work.html?draft=ID, with headless Chrome over CDP (no npm).
// Starts its own TEST-ONLY HTTP server: the repository's static files plus an in-memory mock of
// the draft API (GET api/drafts/ID, .../revisions/N, .../revisions/N/MOVEMENT.abc). The mock
// and its generated scores exist only in this file; nothing here is production data.
//   node tests/live-drafts-browser.cjs
// Env: MW_DRAFT_PORT (HTTP, default 8872), MW_PORT (CDP, default 9372), MW_CDP (driver module,
// default tests/browser.cjs), CHROME (browser binary), MW_SHOTS (screenshot dir, default /tmp).
const http = require("http");
const fs = require("fs");
const path = require("path");
const { launch } = require(process.env.MW_CDP || path.join(__dirname, "browser.cjs"));

const ROOT = path.resolve(__dirname, "..");
const HTTP_PORT = +(process.env.MW_DRAFT_PORT || 8872);
const CDP_PORT = +(process.env.MW_PORT || 9372);
const SHOTS = process.env.MW_SHOTS || "/tmp";
const BASE = `http://127.0.0.1:${HTTP_PORT}/`;
const FIX = "&catalog=tests/fixtures/catalog.json";

/* ---------------- test-only mock server ---------------- */
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".svg": "image/svg+xml", ".abc": "text/plain; charset=utf-8", ".png": "image/png" };
const store = {};          // draft id -> { revs, status, completedWorkId, fail, abcFail, metaDelay, revDelay, staleMeta }
const stats = { meta: {}, active: {}, maxActive: {} };
let clock = Date.parse("2026-11-15T10:00:00Z");

// A short single-flute TEST FIXTURE score: `bars` bars of quavers on four pitches.
function score(label, rev, bars, opts = {}) {
  const bar = (i) => ["GABc BAGA", "Bcde dcBA", "GABc BAGA", "Bcde dcBA"][i % 4];
  let body;
  if (opts.repeatTempo) {
    // bars 1-2 at q=200, |: 3-4 :| at q=200, then [Q:1/4=100] bars 5-6 -> starts (ms): 0,1200,2400,3600,(repeat)7200,9600; end 12000
    body = `${bar(0)} | ${bar(1)} |: ${bar(2)} | ${bar(3)} :| [Q:1/4=100] ${bar(0)} | ${bar(1)} |]`;
  } else {
    const parts = [];
    for (let i = 0; i < bars; i++) parts.push(bar(i) + (i === bars - 1 ? " |]" : " |") + ((i + 1) % 4 === 0 ? "\n" : " "));
    body = parts.join("").trim();
  }
  return `% TEST FIXTURE ${label} revision ${rev} -- not a composition\nX:1\nT:Test fixture ${label}\nM:4/4\nL:1/8\nQ:1/4=200\nV:Fl clef=treble name="Flute"\nK:G\nV:Fl\n%%MIDI program 73\n${body}\n`;
}
function draft(id) { return store[id] || (store[id] = { revs: [], status: "composing", completedWorkId: null, fail: 0, abcFail: false, metaDelay: 0, revDelay: {}, staleMeta: null }); }
// movements: [{ id, label, bars, repeatTempo? }]
function publish(id, movements, changeNote) {
  const d = draft(id), revision = d.revs.length + 1;
  clock += 60000;
  d.revs.push({ revision, publishedAt: new Date(clock).toISOString(), changeNote: changeNote || `Revision ${revision}`,
    movements: movements.map((m) => ({ ...m, abc: score(m.id, revision, m.bars, m) })) });
  return revision;
}
function manifest(id, r) {
  return { id, requestId: "test-fixture:symphony:1", composerId: "test-fixture", formId: "symphony", round: 1, title: "Test fixture draft", subtitle: "Test only",
    description: "Player test fixture.", status: "draft", revision: r.revision, publishedAt: r.publishedAt, changeNote: r.changeNote, durationSeconds: 10,
    movements: r.movements.map((m) => ({ id: m.id, label: m.label, note: "", source: `api/drafts/${id}/revisions/${r.revision}/${m.id}.abc`, bars: m.repeatTempo ? 6 : m.bars, durationSeconds: 5, sha256: "0" })) };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function send(res, code, body, type) { res.writeHead(code, { "Content-Type": type || "application/json", "Cache-Control": "no-store" }); res.end(typeof body === "string" ? body : JSON.stringify(body)); }

async function api(res, parts) {
  const [id, revWord, revStr, file] = parts;
  const d = store[id];
  if (!d) return send(res, 404, { error: "not found" });
  if (revWord == null) {                                    // metadata
    stats.meta[id] = (stats.meta[id] || 0) + 1;
    stats.active[id] = (stats.active[id] || 0) + 1;
    stats.maxActive[id] = Math.max(stats.maxActive[id] || 0, stats.active[id]);
    try {
      if (d.metaDelay) await sleep(d.metaDelay);
      if (d.fail) return send(res, d.fail, { error: "unavailable" });
      if (!d.revs.length) return send(res, 404, { error: "no published snapshot" });
      const latest = d.staleMeta ? d.revs[d.staleMeta - 1] : d.revs[d.revs.length - 1];
      return send(res, 200, { work: manifest(id, latest), revisions: d.revs.slice(0, latest.revision).map((r) => ({ revision: r.revision, publishedAt: r.publishedAt, changeNote: r.changeNote })), status: d.status, completedWorkId: d.completedWorkId });
    } finally { stats.active[id]--; }
  }
  const r = revWord === "revisions" && /^[1-9]\d*$/.test(revStr) ? d.revs[+revStr - 1] : null;
  if (!r) return send(res, 404, { error: "no such revision" });
  if (file == null) {
    if (d.revDelay[r.revision]) await sleep(d.revDelay[r.revision]);
    if (d.fail) return send(res, d.fail, { error: "unavailable" });
    return send(res, 200, { work: manifest(id, r) });
  }
  const m = r.movements.find((x) => x.id + ".abc" === file);
  if (!m) return send(res, 404, { error: "no such movement" });
  if (d.abcFail || d.fail) return send(res, 503, "unavailable", "text/plain");
  return send(res, 200, m.abc, "text/plain; charset=utf-8");
}
const server = http.createServer((req, res) => {
  const url = new URL(req.url, BASE);
  const parts = url.pathname.split("/").filter(Boolean);
  if (parts[0] === "api" && parts[1] === "drafts") return void api(res, parts.slice(2)).catch((e) => send(res, 500, { error: String(e) }));
  const file = path.resolve(ROOT, "." + decodeURIComponent(url.pathname));
  if (!file.startsWith(ROOT + path.sep) || /\/\.|node_modules|\/data\/[^/]*\.sqlite/.test(file)) return send(res, 403, "no", "text/plain");
  fs.readFile(file, (err, buf) => err ? send(res, 404, "not found", "text/plain") : (res.writeHead(200, { "Content-Type": TYPES[path.extname(file)] || "application/octet-stream" }), res.end(buf)));
});

/* ---------------- checks ---------------- */
let failures = 0, passes = 0;
function check(name, ok, detail) {
  if (ok) passes++; else failures++;
  console.log((ok ? "ok   " : "FAIL ") + name + (detail !== undefined ? "  — " + (typeof detail === "string" ? detail : JSON.stringify(detail)).slice(0, 600) : ""));
}
async function waitFor(page, expr, ms = 20000, step = 150) {
  const end = Date.now() + ms;
  let v;
  while (Date.now() < end) { v = await page.eval(expr); if (v) return v; await sleep(step); }
  return v;
}
const $t = (id) => `document.getElementById('${id}').textContent`;
const vis = (id) => `!document.getElementById('${id}').hidden`;
const ABC = "document.getElementById('pl-abc').value";
const STATE = "mwPlayer.state()";
const DRAFT = "mwPlayer.draft()";
const READY = "!!document.querySelector('#pl-paper svg') && !document.getElementById('pl-play').disabled && document.getElementById('pl-sheet').getAttribute('aria-busy') === 'false'";
// Two checks in a row: the first may be a timer poll that started before the change.
const POLL = "mwPlayer.checkDraft().then(() => mwPlayer.checkDraft())";

async function open(page, query) {
  await page.send("Page.navigate", { url: BASE + "work.html" + query });
  await sleep(300);
  await waitFor(page, "document.readyState === 'complete' && !!window.mwPlayer && (" + vis("pl-waiting") + " || " + vis("pl-missing") + " || (" + READY + "))", 20000);
}
const selectRev = (page, n) => page.eval(`{ const r = document.getElementById('pl-revision'); r.value = '${n}'; r.dispatchEvent(new Event('change')); }`);
async function playAndWait(page) {
  await page.eval("document.getElementById('pl-play').click()");
  return waitFor(page, "mwPlayer.state() === 'playing' || !document.getElementById('pl-error').hidden", 90000);
}

(async () => {
  await new Promise((r) => server.listen(HTTP_PORT, "127.0.0.1", r));
  const page = await launch({ width: 1280, height: 1000, port: CDP_PORT });
  try {
    /* ---------- finished works are unchanged ---------- */
    await open(page, "?id=fixture-one" + FIX);
    const fin = await page.eval(`({ stop: ${vis("pl-stop")}, draft: ${vis("pl-draft")}, goto: ${vis("pl-goto")}, update: ${vis("pl-update")}, waiting: ${vis("pl-waiting")}, rev: mwPlayer.revision(), d: ${DRAFT}, kicker: ${$t("pl-kicker")}, time: document.querySelector('.pl-mv-time').textContent })`);
    check("finished work: no draft UI, no draft state", !fin.stop && !fin.draft && !fin.goto && !fin.update && !fin.waiting && fin.rev === null && fin.d === null && !/draft/i.test(fin.kicker) && fin.time === "0:07", fin);

    /* ---------- 404 -> waiting screen -> first publication ---------- */
    draft("test-fixture-wait");
    await open(page, "?draft=test-fixture-wait" + FIX);
    let w = await page.eval(`({ waiting: ${vis("pl-waiting")}, app: ${vis("pl-app")}, missing: ${vis("pl-missing")}, title: ${$t("pl-waiting-title")}, status: ${$t("pl-waiting-status")}, svg: !!document.querySelector('#pl-paper svg'), comp: document.getElementById('pl-waiting-composer').getAttribute('href'), compHidden: document.getElementById('pl-waiting-composer').hidden, queue: !!document.querySelector('#pl-waiting a[href="index.html#queue"]') })`);
    check("no snapshot: waiting screen, not a completed-work fallback", w.waiting && !w.app && !w.missing && !w.svg && /first draft is not ready/i.test(w.title) && /every 5 seconds/.test(w.status), w);
    check("waiting screen: composer and queue navigation", !w.compHidden && w.comp === "index.html#composer/test-fixture" && w.queue, w);
    const polls0 = (await page.eval(DRAFT)).polls;
    publish("test-fixture-wait", [{ id: "i", label: "I. Opening", bars: 4 }], "First phrase");
    const t0 = Date.now();
    const appeared = await waitFor(page, READY + " && " + vis("pl-app"), 9000, 200);
    w = await page.eval(`({ d: ${DRAFT}, waiting: ${vis("pl-waiting")}, state: ${STATE}, synth: !!mwPlayer.synth(), rev: ${$t("pl-draft-rev")}, badge: ${$t("pl-draft")}, title: document.title })`);
    check("first publication appears by itself on the next 5 s poll", !!appeared && !w.waiting && w.d.viewing === 1 && w.d.polls > polls0, { secs: ((Date.now() - t0) / 1000).toFixed(1), polls: w.d.polls });
    check("first take: prominent Draft label, revision, no autoplay", /Draft/.test(w.badge) && /Revision 1/.test(w.rev) && w.state === "idle" && !w.synth && /^Draft:/.test(w.title), w.rev);
    await sleep(1500);
    check("first take: still idle after a while (no autoplay)", (await page.eval(STATE)) === "idle");

    /* ---------- idle + following: automatic apply, movement kept, plain-text note ---------- */
    const ID = "test-fixture-live";
    publish(ID, [{ id: "a", label: "A. First", bars: 4 }, { id: "b", label: "B. Second", bars: 4 }], "Two movements");
    await open(page, `?draft=${ID}${FIX}`);
    await page.eval("document.querySelectorAll('#pl-movements button')[1].click()");
    await waitFor(page, READY + " && mwPlayer.draft().movement === 'b'");
    publish(ID, [{ id: "a", label: "A. First", bars: 4 }, { id: "b", label: "B. Second", bars: 12 }], "<img src=x onerror=\"window.__xss=1\"> Longer B");
    let g0 = await page.eval("mwPlayer.gen()");
    await page.eval(POLL);
    await waitFor(page, READY);
    let s = await page.eval(`({ d: ${DRAFT}, abc: ${ABC}, note: ${$t("pl-draft-note")}, noteHtml: document.getElementById('pl-draft-note').innerHTML, img: !!document.querySelector('#pl-draft img'), xss: window.__xss, state: ${STATE}, synth: !!mwPlayer.synth(), bars: [...document.querySelectorAll('.pl-mv-bars')].map(e => e.textContent), url: location.search, gen: mwPlayer.gen(), offer: ${vis("pl-update")}, time: document.getElementById('pl-draft-time').getAttribute('datetime') })`);
    check("idle + follow: newer revision applied automatically", s.d.viewing === 2 && /revision 2/.test(s.abc) && s.gen > g0 && !s.offer, s.d.log.slice(-3));
    check("idle apply keeps the current movement", s.d.movement === "b", s.d.movement);
    check("idle apply: per-movement written bars shown", JSON.stringify(s.bars) === '["4 bars","12 bars"]', s.bars);
    check("idle apply: no autoplay", s.state === "idle" && !s.synth);
    check("change note shown as plain text", s.note.startsWith("<img") && !s.img && s.xss === undefined && /&lt;img/.test(s.noteHtml), s.note);
    check("publication time is machine-readable and local", typeof s.time === "string" && /T/.test(s.time), s.time);
    check("following latest: no ?revision in the URL", !/revision=/.test(s.url), s.url);
    g0 = await page.eval("mwPlayer.gen()");
    const abc0 = await page.eval(ABC);
    await page.eval(POLL);
    check("poll without a new revision changes nothing (gen, score)", (await page.eval("mwPlayer.gen()")) === g0 && (await page.eval(ABC)) === abc0);

    /* ---------- playing: pinned score and audio, switch offered ---------- */
    let p = await playAndWait(page);
    check("revision 2 plays", (await page.eval(STATE)) === "playing", p);
    g0 = await page.eval("mwPlayer.gen()");
    let synth0 = await page.eval("(window.__sc = mwPlayer.synth(), true)");
    publish(ID, [{ id: "a", label: "A. First", bars: 4 }, { id: "b", label: "B. Second", bars: 14 }], "Two more bars");
    await page.eval(POLL);
    s = await page.eval(`({ d: ${DRAFT}, abc: ${ABC}, state: ${STATE}, gen: mwPlayer.gen(), same: mwPlayer.synth() === window.__sc, offer: ${$t("pl-update-text")}, btn: ${$t("pl-switch")}, kind: document.getElementById('pl-update').dataset.kind })`);
    check("playing: score text and revision not replaced", s.d.viewing === 2 && s.abc === abc0 && s.d.latest === 3, { viewing: s.d.viewing, latest: s.d.latest });
    check("playing: audio untouched (same synth, same gen, still playing)", s.state === "playing" && s.same && s.gen === g0, s);
    check("playing: switch offered with bar change", s.kind === "offer" && /Revision 3 is ready/.test(s.offer) && /14 bars there \(12 here\)/.test(s.offer) && s.btn === "Switch to revision 3", s.offer);
    check("decision logged as offer while playing", s.d.log.some((e) => e.t === "decide" && e.revision === 3 && e.state === "playing" && e.action === "offer"));
    // paused
    await page.eval("document.getElementById('pl-play').click()");
    await waitFor(page, "mwPlayer.state() === 'paused'", 5000);
    publish(ID, [{ id: "a", label: "A. First", bars: 4 }, { id: "b", label: "B. Second", bars: 16 }], "Sixteen bars");
    g0 = await page.eval("mwPlayer.gen()");
    await page.eval(POLL);
    s = await page.eval(`({ d: ${DRAFT}, abc: ${ABC}, state: ${STATE}, gen: mwPlayer.gen(), same: mwPlayer.synth() === window.__sc, btn: ${$t("pl-switch")} })`);
    check("paused: score, audio and gen kept; newest offered", s.state === "paused" && s.d.viewing === 2 && s.abc === abc0 && s.gen === g0 && s.same && s.btn === "Switch to revision 4", { state: s.state, viewing: s.d.viewing, btn: s.btn });
    // explicit switch from a chosen bar
    await page.eval("document.getElementById('pl-update-bar').value = '3'; document.getElementById('pl-switch').click()");
    await waitFor(page, "mwPlayer.revision() === 4 && " + READY, 10000);
    await sleep(300);
    s = await page.eval(`({ d: ${DRAFT}, abc: ${ABC}, state: ${STATE}, synth: !!mwPlayer.synth(), status: ${$t("pl-status")}, bars: [...document.querySelectorAll('.pl-mv-bars')].map(e => e.textContent), offer: ${vis("pl-update")}, sel: [...document.querySelectorAll('#pl-revision option')].map(o => o.value), selVal: document.getElementById('pl-revision').value, of: ${$t("pl-bar-of")} })`);
    check("explicit switch: old take stopped, new score loaded, no autoplay", s.d.viewing === 4 && /revision 4/.test(s.abc) && s.state === "idle" && !s.synth && !s.offer, s);
    check("explicit switch: new bar counts", JSON.stringify(s.bars) === '["4 bars","16 bars"]' && s.of === "of 16" && s.d.movement === "b", s.bars);
    check("explicit switch: chosen start bar pending", s.status === "Will start at bar 3.", s.status);
    check("revision selector lists every take, newest first", JSON.stringify(s.sel) === '["4","3","2","1"]' && s.selVal === "4", s.sel);
    p = await playAndWait(page);
    const barNow = await waitFor(page, "/^Bar \\d+/.test(document.getElementById('pl-status').textContent) && document.getElementById('pl-status').textContent", 8000, 50);
    check("playback starts at the chosen bar", barNow === "Bar 3", barNow);
    await page.eval("mwPlayer.stop()");

    /* ---------- local edits are protected, even inside the 400 ms debounce ---------- */
    await waitFor(page, "mwPlayer.state() === 'idle'");
    publish(ID, [{ id: "a", label: "A. First", bars: 4 }, { id: "b", label: "B. Second", bars: 18 }], "Eighteen bars");
    const edit = await page.eval(`(() => { const t = document.getElementById('pl-abc'); t.value = t.value + '\\n% my local edit'; t.dispatchEvent(new Event('input'));
      return ${POLL}.then(d => ({ d, editedFlagShown: !document.getElementById('pl-edited').hidden, abc: t.value })); })()`);
    check("edit + immediate poll (before debounce): new revision not applied", edit.d.viewing === 4 && edit.d.latest === 5 && /my local edit/.test(edit.abc) && !edit.editedFlagShown, { viewing: edit.d.viewing, latest: edit.d.latest, flag: edit.editedFlagShown });
    check("edit protection logged as offer with edited=true", edit.d.log.some((e) => e.t === "decide" && e.revision === 5 && e.edited === true && e.action === "offer"));
    await sleep(700);
    await page.eval(POLL);
    s = await page.eval(`({ d: ${DRAFT}, abc: ${ABC}, btn: ${$t("pl-switch")}, flag: ${vis("pl-edited")} })`);
    check("edits kept across later polls; switch label warns", s.d.viewing === 4 && /my local edit/.test(s.abc) && s.flag && s.btn === "Discard my edits and switch to revision 5", s.btn);
    // picking an older take with edits asks first
    await selectRev(page, 1);
    s = await page.eval(`({ d: ${DRAFT}, btn: ${$t("pl-switch")}, keep: ${vis("pl-keep")}, abc: ${ABC} })`);
    check("older revision with edits: confirmation, nothing discarded yet", s.d.viewing === 4 && s.d.confirm === 1 && s.keep && s.btn === "Discard my edits and open revision 1" && /my local edit/.test(s.abc), s.btn);
    await page.eval("document.getElementById('pl-keep').click()");
    check("keep my edits cancels", (await page.eval("mwPlayer.draft().confirm")) === null && /my local edit/.test(await page.eval(ABC)));
    await page.eval("document.getElementById('pl-switch').click()");
    await waitFor(page, "mwPlayer.revision() === 5 && " + READY, 10000);
    s = await page.eval(`({ abc: ${ABC}, flag: ${vis("pl-edited")}, edited: mwPlayer.draft().edited })`);
    check("discard-and-switch replaces edits with revision 5", /revision 5/.test(s.abc) && !/my local edit/.test(s.abc) && !s.flag && !s.edited, s.flag);

    /* ---------- history: older take pinned, URL, Latest ---------- */
    await selectRev(page, 2);
    await waitFor(page, "mwPlayer.revision() === 2 && " + READY, 10000);
    s = await page.eval(`({ d: ${DRAFT}, url: location.search, follow: document.getElementById('pl-follow').checked, btn: ${$t("pl-switch")}, kind: document.getElementById('pl-update').dataset.kind, rev: ${$t("pl-draft-rev")}, abc: ${ABC} })`);
    check("history: revision 2 shown, Follow latest off, URL pinned", s.d.viewing === 2 && !s.d.follow && !s.follow && /revision=2/.test(s.url) && /revision 2/.test(s.abc), s.url);
    check("history: clear way back to latest", s.kind === "newer" && s.btn === "Back to latest (revision 5)" && /Revision 2 of 5/.test(s.rev), [s.btn, s.rev]);
    publish(ID, [{ id: "a", label: "A. First", bars: 4 }, { id: "b", label: "B. Second", bars: 20 }], "Twenty bars");
    await page.eval(POLL);
    s = await page.eval(DRAFT);
    check("history: idle but pinned take stays when newer arrives", s.viewing === 2 && s.latest === 6, s);
    // reload with ?revision=2 keeps the take
    await open(page, `?draft=${ID}&revision=2${FIX}`);
    s = await page.eval(`({ d: ${DRAFT}, follow: document.getElementById('pl-follow').checked, btn: ${$t("pl-switch")} })`);
    check("?revision=2 opens the pinned take after reload", s.d.viewing === 2 && s.d.latest === 6 && !s.follow && s.btn === "Back to latest (revision 6)", s.d);
    await page.eval("document.getElementById('pl-switch').click()");
    await waitFor(page, "mwPlayer.revision() === 6 && " + READY, 10000);
    s = await page.eval(`({ d: ${DRAFT}, url: location.search, follow: document.getElementById('pl-follow').checked, offer: ${vis("pl-update")} })`);
    check("Back to latest: revision 6, Follow latest on, ?revision removed", s.d.viewing === 6 && s.d.follow && s.follow && !/revision=/.test(s.url) && !s.offer, s.url);
    // Follow latest toggle back on from history auto-applies when idle
    await selectRev(page, 1);
    await waitFor(page, "mwPlayer.revision() === 1 && " + READY, 10000);
    await page.eval("{ const f = document.getElementById('pl-follow'); f.checked = true; f.dispatchEvent(new Event('change')); }");
    await waitFor(page, "mwPlayer.revision() === 6 && " + READY, 10000);
    check("turning Follow latest on while idle opens the latest", (await page.eval("mwPlayer.revision()")) === 6 && !/revision=/.test(await page.eval("location.search")));

    /* ---------- removed current movement ---------- */
    await page.eval("document.querySelector('#pl-movements button[data-id=b]').click()");
    await waitFor(page, READY + " && mwPlayer.draft().movement === 'b'");
    publish(ID, [{ id: "a", label: "A. First", bars: 6 }], "B withdrawn for now");
    await page.eval(POLL);
    await waitFor(page, "mwPlayer.revision() === 7 && " + READY, 10000);
    s = await page.eval(`({ d: ${DRAFT}, msg: ${$t("pl-draft-msg-text")}, msgShown: ${vis("pl-draft-msg")}, heading: ${$t("pl-movement")} })`);
    check("current movement removed: falls back to the first, says so", s.d.movement === "a" && s.heading === "A. First" && s.msgShown && /B\. Second.*not in revision 7/.test(s.msg), s.msg);

    /* ---------- stale and out-of-order responses ---------- */
    await open(page, `?draft=${ID}${FIX}`);                // fresh page: no cached snapshots
    draft(ID).revDelay[3] = 2000;
    await selectRev(page, 3);
    await sleep(150);
    await selectRev(page, 4);
    await waitFor(page, "mwPlayer.revision() === 4 && " + READY, 10000);
    await sleep(2500);
    s = await page.eval(DRAFT);
    check("slow older request cannot overwrite the newer choice", s.viewing === 4 && s.log.some((e) => e.t === "superseded" && e.revision === 3), s.log.slice(-4));
    draft(ID).revDelay = {};
    draft(ID).staleMeta = 2;                                // a lagging server answers with revision 2 as "latest"
    await page.eval(POLL);
    s = await page.eval(DRAFT);
    check("stale metadata (older latest) is ignored", s.latest === 7 && s.viewing === 4 && s.log.some((e) => e.t === "stale" && e.revision === 2), { latest: s.latest });
    draft(ID).staleMeta = null;
    await page.eval("document.getElementById('pl-switch').click()");
    await waitFor(page, "mwPlayer.revision() === 7 && " + READY, 10000);

    /* ---------- offline: keep the take, back off, retry ---------- */
    abc0Set: {
      const before = await page.eval(ABC);
      draft(ID).fail = 503;
      await page.eval("mwPlayer.checkDraft()");
      s = await page.eval(`({ d: ${DRAFT}, conn: ${vis("pl-conn")}, text: ${$t("pl-conn-text")}, abc: ${ABC}, svg: !!document.querySelector('#pl-paper svg'), play: !document.getElementById('pl-play').disabled })`);
      check("offline: last playable take kept, notice shown", s.conn && /HTTP 503/.test(s.text) && s.abc === before && s.svg && s.play && s.d.viewing === 7, s.text);
      const d1 = s.d.nextDelay;
      await page.eval("mwPlayer.checkDraft()");
      const d2 = (await page.eval(DRAFT)).nextDelay;
      const pc = (await page.eval(DRAFT)).polls;
      await page.eval("document.getElementById('pl-conn-retry').click()");
      await waitFor(page, `mwPlayer.draft().polls > ${pc} && !mwPlayer.draft().inflight`, 5000);
      const d3 = (await page.eval(DRAFT)).nextDelay;
      check("offline: backoff 10 s, 20 s, 40 s; Check now retries", d1 === 10000 && d2 === 20000 && d3 === 40000, [d1, d2, d3]);
      p = await playAndWait(page);
      check("offline: the kept take still plays", (await page.eval(STATE)) === "playing", p);
      await page.eval("mwPlayer.stop()");
      draft(ID).fail = 0;
      // the next revision's score fails to download: nothing changes
      draft(ID).abcFail = true;
      publish(ID, [{ id: "a", label: "A. First", bars: 8 }], "Eight bars");
      await page.eval(POLL);
      s = await page.eval(`({ d: ${DRAFT}, conn: ${vis("pl-conn")}, abc: ${ABC}, msg: ${$t("pl-draft-msg-text")}, svg: !!document.querySelector('#pl-paper svg') })`);
      check("online again: connection notice cleared", !s.conn && s.d.failures === 0 && s.d.nextDelay === 5000);
      check("score download failure keeps the previous take intact", s.d.viewing === 7 && s.d.latest === 8 && s.abc === before && s.svg && /Revision 8 could not be loaded/.test(s.msg), s.msg);
      draft(ID).abcFail = false;
      await page.eval(POLL);
      await waitFor(page, "mwPlayer.revision() === 8 && " + READY, 10000);
      check("after recovery the new revision applies", (await page.eval("mwPlayer.revision()")) === 8 && /revision 8/.test(await page.eval(ABC)));
    }

    /* ---------- polling: one at a time; paused while hidden ---------- */
    draft(ID).metaDelay = 6500;                              // slower than the 5 s interval
    stats.maxActive[ID] = 0;
    const m0 = stats.meta[ID];
    await page.eval("mwPlayer.checkDraft(); mwPlayer.checkDraft(); mwPlayer.checkDraft(); true");
    await sleep(14500);
    check("single flight: never two metadata requests at once", stats.maxActive[ID] === 1 && stats.meta[ID] - m0 <= 2, { max: stats.maxActive[ID], requests: stats.meta[ID] - m0 });
    draft(ID).metaDelay = 0;
    await waitFor(page, "!mwPlayer.draft().inflight", 8000);
    await page.eval("Object.defineProperty(document, 'hidden', { configurable: true, get: () => true }); Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' }); document.dispatchEvent(new Event('visibilitychange'))");
    const h0 = stats.meta[ID];
    await sleep(11000);
    s = await page.eval(DRAFT);
    check("hidden: no polling", stats.meta[ID] === h0 && !s.timer, { requests: stats.meta[ID] - h0, timer: s.timer });
    await page.eval("delete document.hidden; delete document.visibilityState; document.dispatchEvent(new Event('visibilitychange'))");
    await sleep(600);
    s = await page.eval(DRAFT);
    check("visible again: checks at once and resumes the 5 s timer", stats.meta[ID] === h0 + 1 && s.timer, { requests: stats.meta[ID] - h0, timer: s.timer });
    const n0 = stats.meta[ID];
    await sleep(5600);
    check("visible: polls every 5 s", stats.meta[ID] === n0 + 1, stats.meta[ID] - n0);

    /* ---------- loading: a new revision during sound loading is only offered ---------- */
    const LID = "test-fixture-load";
    publish(LID, [{ id: "i", label: "I. Loading", bars: 8 }], "Loading test");
    await open(page, `?draft=${LID}${FIX}`);
    await page.eval("window.__realFetch = window.fetch; window.fetch = (u, o) => /-mp3\\//.test(String(u)) ? new Promise(r => setTimeout(r, 2500)).then(() => window.__realFetch(u, o)) : window.__realFetch(u, o); true");
    const labc = await page.eval(ABC);
    publish(LID, [{ id: "i", label: "I. Loading", bars: 10 }], "More");
    s = await page.eval(`(() => { document.getElementById('pl-play').click(); const st = mwPlayer.state(); const g = mwPlayer.gen(); return ${POLL}.then(d => ({ st, g, d, now: mwPlayer.state(), gen: mwPlayer.gen(), abc: document.getElementById('pl-abc').value })); })()`);
    check("loading: decision taken while loading, offered not applied", s.st === "loading" && s.d.log.some((e) => e.t === "decide" && e.revision === 2 && e.state === "loading" && e.action === "offer") && s.d.viewing === 1 && s.abc === labc && s.gen === s.g, { st: s.st, now: s.now, log: s.d.log.slice(-2) });
    await waitFor(page, "mwPlayer.state() === 'playing'", 60000);
    check("loading: the original take then plays, still revision 1", (await page.eval("mwPlayer.revision()")) === 1 && (await page.eval(ABC)) === labc);

    /* ---------- completion and reopened requests ---------- */
    g0 = await page.eval("mwPlayer.gen()");
    draft(LID).status = "completed"; draft(LID).completedWorkId = "fixture-one";
    await page.eval(POLL);
    s = await page.eval(`({ state: ${STATE}, gen: mwPlayer.gen(), done: ${vis("pl-draft-done")}, href: document.getElementById('pl-draft-final').getAttribute('href'), st: ${$t("pl-draft-state")}, opts: document.querySelectorAll('#pl-revision option').length, badge: ${vis("pl-draft")} })`);
    check("completed: link to the finished work, current take keeps playing", s.done && s.href === "work.html?id=fixture-one" && /finished/i.test(s.st) && s.state === "playing" && s.gen === g0, s);
    check("completed: draft label and history remain", s.badge && s.opts === 2, s.opts);
    draft(LID).status = "open"; draft(LID).completedWorkId = null;
    await page.eval(POLL);
    s = await page.eval(`({ done: ${vis("pl-draft-done")}, st: ${$t("pl-draft-state")}, state: ${STATE} })`);
    check("reopened request: draft stays, labelled paused", !s.done && /Paused/.test(s.st) && /not being composed/.test(s.st) && s.state === "playing", s);
    // Stop (draft only) while revision 2 is queued: silence, then follow latest, no autoplay
    s = await page.eval(`({ shown: ${vis("pl-stop")}, enabled: !document.getElementById('pl-stop').disabled, offer: ${$t("pl-update-text")} })`);
    check("Stop control shown and enabled while playing", s.shown && s.enabled && /until you switch or stop/.test(s.offer), s);
    await page.eval("document.getElementById('pl-stop').click()");
    await waitFor(page, "mwPlayer.revision() === 2 && " + READY, 10000);
    await sleep(1200);
    s = await page.eval(`({ rev: mwPlayer.revision(), state: ${STATE}, synth: !!mwPlayer.synth(), abc: ${ABC}, offer: ${vis("pl-update")}, disabled: document.getElementById('pl-stop').disabled })`);
    check("Stop: sound stopped, queued revision applied, no autoplay", s.rev === 2 && s.state === "idle" && !s.synth && /revision 2/.test(s.abc) && !s.offer && s.disabled, s);

    /* ---------- bar choice with repeats and a tempo change ---------- */
    const BID = "test-fixture-bars";
    publish(BID, [{ id: "i", label: "I. Bars", bars: 8 }], "Plain");
    await open(page, `?draft=${BID}${FIX}`);
    p = await playAndWait(page);
    publish(BID, [{ id: "i", label: "I. Bars", repeatTempo: true }], "Repeat and slower ending");
    await page.eval(POLL);
    check("bars: offered while playing", (await page.eval("mwPlayer.revision()")) === 1 && (await page.eval(`${$t("pl-switch")}`)) === "Switch to revision 2");
    await page.eval("document.getElementById('pl-update-bar').value = '6'; document.getElementById('pl-switch').click()");
    await waitFor(page, "mwPlayer.revision() === 2 && " + READY, 10000);
    await sleep(200);
    s = await page.eval(`({ map: mwPlayer.bars(), status: ${$t("pl-status")}, state: ${STATE} })`);
    check("bars: timing map follows repeats and tempo change", s.map && s.map.count === 6 && s.map.starts[4] === 7200 && s.map.starts[5] === 9600 && s.map.end === 12000 && s.map.repeats, s.map);
    check("bars: chosen bar pending, honest about repeats", s.status === "Will start at bar 6 (first time through)." && s.state === "idle", s.status);
    await playAndWait(page);
    const bar6 = await waitFor(page, "/^Bar \\d+/.test(document.getElementById('pl-status').textContent) && document.getElementById('pl-status').textContent", 8000, 50);
    check("bars: playback starts at bar 6", bar6 === "Bar 6", bar6);
    await page.eval("mwPlayer.stop()");
    await waitFor(page, "mwPlayer.state() === 'idle'");
    await page.eval("document.getElementById('pl-bar').value = '99'; document.getElementById('pl-goto').requestSubmit()");
    check("Go to bar clamps to the bars there are", (await page.eval($t("pl-status"))) === "This movement has 6 bars. Will start at bar 6 (first time through).", await page.eval($t("pl-status")));
    await page.eval("document.getElementById('pl-bar').value = '2'; document.getElementById('pl-goto').requestSubmit()");
    check("Go to bar 2", (await page.eval($t("pl-status"))) === "Will start at bar 2 (first time through).");
    await page.shot(path.join(SHOTS, "mw-live-draft-desktop.png"));

    /* ---------- automatic updates keep the reader's place ---------- */
    const SID = "test-fixture-scroll";
    publish(SID, [{ id: "b", label: "B. Second", bars: 40 }], "Long B");
    await open(page, `?draft=${SID}${FIX}`);
    await waitFor(page, "mwPlayer.revision() === 1 && " + READY);
    await page.eval("{ const sh = document.getElementById('pl-sheet'); sh.style.scrollBehavior = 'auto'; sh.scrollTop = 120; }");
    publish(SID, [{ id: "b", label: "B. Second", bars: 44 }], "Longer B");
    await page.eval(POLL);
    await waitFor(page, "mwPlayer.revision() === 2 && " + READY);
    await sleep(200);
    const keptTop = await page.eval("document.getElementById('pl-sheet').scrollTop");
    check("automatic update keeps the score's scroll position", Math.abs(keptTop - 120) < 2, keptTop);
    await page.eval("{ const sh = document.getElementById('pl-sheet'); sh.scrollTop = sh.scrollHeight; }");
    const oldBottom = await page.eval("document.getElementById('pl-sheet').scrollTop");
    publish(SID, [{ id: "b", label: "B. Second", bars: 60 }], "Much longer B");
    await page.eval(POLL);
    await waitFor(page, "mwPlayer.revision() === 3 && " + READY);
    await sleep(200);
    const bot = await page.eval("(() => { const sh = document.getElementById('pl-sheet'); return { top: sh.scrollTop, max: sh.scrollHeight - sh.clientHeight }; })()");
    check("at the bottom, an automatic update follows the new bottom", bot.top > oldBottom && Math.abs(bot.top - bot.max) < 2, { oldBottom, ...bot });
    await page.eval("document.getElementById('pl-sheet').scrollTop = 0");

    /* ---------- invalid addresses ---------- */
    await open(page, "?draft=../etc" + FIX);
    check("invalid draft id refused without requests", /not valid/.test(await page.eval($t("pl-missing-title"))) && (await page.eval(vis("pl-missing"))));
    await open(page, `?draft=${ID}&revision=99${FIX}`);
    s = await page.eval(`({ d: ${DRAFT}, msg: ${$t("pl-draft-msg-text")} })`);
    check("unknown ?revision falls back to latest and says so", s.d.viewing === 8 && s.d.follow && /Revision 99 could not be opened/.test(s.msg), s.msg);

    /* ---------- phone layout ---------- */
    await page.send("Emulation.setDeviceMetricsOverride", { width: 375, height: 812, deviceScaleFactor: 2, mobile: true });
    await open(page, `?draft=${ID}&revision=2${FIX}`);
    await sleep(600);
    const mob = await page.eval(`({ overflow: document.documentElement.scrollWidth - window.innerWidth, draftH: document.getElementById('pl-draft').getBoundingClientRect().height, update: ${vis("pl-update")},
      inside: [...document.querySelectorAll('#pl-draft *, #pl-update *, #pl-transport *')].every(e => { const r = e.getBoundingClientRect(); return r.width === 0 || (r.left >= -0.5 && r.right <= window.innerWidth + 0.5); }) })`);
    check("phone: no horizontal overflow, compact draft panel", mob.overflow <= 0 && mob.inside && mob.update && mob.draftH < 260, mob);
    await page.shot(path.join(SHOTS, "mw-live-draft-375-top.png"));
    await page.eval("document.documentElement.style.scrollBehavior = 'auto'; document.getElementById('pl-update').scrollIntoView()");
    await sleep(300);
    await page.shot(path.join(SHOTS, "mw-live-draft-375-update.png"));
    draft("test-fixture-empty");
    await open(page, "?draft=test-fixture-empty" + FIX);
    const mobW = await page.eval("document.documentElement.scrollWidth - window.innerWidth");
    check("phone: waiting screen fits", mobW <= 0 && (await page.eval(vis("pl-waiting"))), mobW);
    await page.shot(path.join(SHOTS, "mw-live-draft-375-waiting.png"));
  } catch (e) {
    failures++;
    console.log("FAIL exception: " + (e && e.stack || e));
  }
  const errs = page.logs.filter((l) => /EXCEPTION|error/i.test(l) && !/404|503|does-not-exist/.test(l));
  check("no page exceptions", errs.length === 0, errs.slice(0, 5));
  await page.close();
  server.close();
  console.log(`\n${passes} passed, ${failures} failed`);
  process.exit(failures ? 1 : 0);
})();
