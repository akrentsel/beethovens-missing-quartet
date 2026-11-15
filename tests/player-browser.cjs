// Browser test for work.html with headless Chrome over CDP (no npm).
// Needs a static server for the repository and a CDP driver exporting launch():
//   python3 -m http.server 8892 --bind 127.0.0.1 --directory <repo>
//   node tests/player-browser.cjs        (uses tests/browser.cjs; set CHROME to the browser binary)
// Env: MW_BASE (default http://127.0.0.1:8892/), MW_CDP (alternative driver module), MW_PORT (default 9362), MW_SHOTS (screenshot dir).
const path = require("path");
const { launch } = require(process.env.MW_CDP || path.join(__dirname, "browser.cjs"));
const BASE = process.env.MW_BASE || "http://127.0.0.1:8892/";
const PORT = +(process.env.MW_PORT || 9362);
const SHOTS = process.env.MW_SHOTS || "/tmp";
const FIX = "&catalog=tests/fixtures/catalog.json";

let failures = 0, passes = 0;
function check(name, ok, detail) {
  if (ok) passes++; else failures++;
  console.log((ok ? "ok   " : "FAIL ") + name + (detail !== undefined ? "  — " + (typeof detail === "string" ? detail : JSON.stringify(detail)) : ""));
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(page, expr, ms = 30000, step = 250) {
  const end = Date.now() + ms;
  let v;
  while (Date.now() < end) { v = await page.eval(expr); if (v) return v; await sleep(step); }
  return v;
}
async function open(page, query) {
  await page.send("Page.navigate", { url: BASE + "work.html" + query });
  await sleep(400);
  await waitFor(page, "document.readyState === 'complete' && !!window.mwPlayer && (document.getElementById('pl-missing').hidden === false || document.getElementById('pl-error').hidden === false || !!document.querySelector('#pl-paper svg') || /Could not/.test(document.getElementById('pl-loading').textContent))", 20000);
}
const BUF = `(() => { const s = mwPlayer.synth(); const b = s && s.midiBuffer && s.midiBuffer.audioBuffers && s.midiBuffer.audioBuffers[0]; if (!b) return null;
  let pk = 0; for (let c = 0; c < b.numberOfChannels; c++) { const d = b.getChannelData(c); for (let i = 0; i < d.length; i++) { const a = Math.abs(d[i]); if (a > pk) pk = a; } }
  return { peak: +pk.toFixed(4), seconds: +b.duration.toFixed(2), channels: b.numberOfChannels }; })()`;
const LABELS = "[...document.querySelectorAll('#pl-parts button')].map(b => b.textContent)";
const STATE = "mwPlayer.state()";
const CLOCK = "document.getElementById('pl-clock').textContent";
const secs = (clock) => { const m = /^(\d+):(\d\d)/.exec(clock || ""); return m ? +m[1] * 60 + +m[2] : NaN; };

async function playAndWait(page) {
  await page.eval("document.getElementById('pl-play').click()");
  return waitFor(page, "mwPlayer.state() === 'playing' || !document.getElementById('pl-error').hidden", 90000);
}

(async () => {
  const page = await launch({ width: 1280, height: 1000, port: PORT });
  try {
    /* ---------- the real quartet ---------- */
    await open(page, "?id=beethoven-quartet-d-minor");
    const info = await page.eval(`({ title: document.getElementById('pl-title').textContent, movements: document.querySelectorAll('#pl-movements button').length,
      crumb: document.getElementById('pl-crumb-composer').getAttribute('href'), crumbText: document.getElementById('pl-crumb-composer').textContent,
      home: document.querySelector('.wordmark').getAttribute('href'), notebook: document.getElementById('pl-notebook').getAttribute('href'),
      transcript: document.getElementById('pl-transcript').getAttribute('href'), disclaimer: document.querySelector('.pl-disclaimer').textContent,
      svg: document.querySelectorAll('#pl-paper svg').length, warn: document.getElementById('pl-warn').textContent, labels: ${LABELS},
      parts: mwPlayer.parts(), pan: mwPlayer.audioParams().pan, sound: document.getElementById('pl-sound').value })`);
    check("quartet title", info.title === "Beethoven’s Missing Quartet", info.title);
    check("four movements listed", info.movements === 4, info.movements);
    check("breadcrumb to composer", info.crumb === "index.html#composer/beethoven" && info.crumbText === "Beethoven", info.crumb);
    check("wordmark links index.html", info.home === "index.html");
    check("notebook + transcript links from manifest", info.notebook === "notebook.html" && info.transcript === "transcript.html");
    check("AI homage disclaimer", /AI-composed homage/.test(info.disclaimer) && /not an original or rediscovered work by Beethoven/.test(info.disclaimer) && /No composer endorsement/.test(info.disclaimer) && /not live performers/.test(info.disclaimer));
    check("score engraved without warnings", info.svg === 1 && info.warn === "", info.warn.slice(0, 200));
    check("part labels from score", JSON.stringify(info.labels) === JSON.stringify(["Vl. I", "Vl. II", "Vla.", "Vc."]), info.labels);
    check("original programs kept", JSON.stringify(info.parts.map((p) => p.program)) === "[40,40,41,42]", info.parts);
    check("default sound is score instruments", info.sound === "score");
    check("pan spread for 4", JSON.stringify(info.pan) === "[-0.6,-0.2,0.2,0.6]", info.pan);
    const midi = await page.eval("mwPlayer.midiBytes()");
    check("MIDI starts with MThd", String.fromCharCode(...midi.slice(0, 4)) === "MThd", midi.slice(0, 8));

    // seek before loading, near the end of movement I, then play
    await page.eval("mwPlayer.seek(0.95)");
    const t0 = Date.now();
    await playAndWait(page);
    check("quartet plays", (await page.eval(STATE)) === "playing", `${((Date.now() - t0) / 1000).toFixed(1)}s to start`);
    const buf = await page.eval(BUF);
    check("audio buffer normalized to 0.9", buf && Math.abs(buf.peak - 0.9) < 0.01, buf);
    check("whole movement rendered", buf && buf.seconds > 300, buf);
    await sleep(1500);
    const c1 = await page.eval(CLOCK);
    check("pending seek applied (near end)", secs(c1) > 340, c1);
    const bar = await page.eval("document.getElementById('pl-status').textContent");
    const cursor = await page.eval("+document.querySelector('.pl-cursor').getAttribute('y2') > 0 && document.querySelectorAll('#pl-paper .pl-on').length > 0");
    check("bar status and cursor follow", /^Bar \d+/.test(bar) && cursor, bar);
    const scrolled = await page.eval("document.getElementById('pl-sheet').scrollTop");
    check("score auto-scrolled", scrolled > 1000, scrolled);
    // pause, seek while paused, resume
    await page.eval("document.getElementById('pl-play').click()");
    await sleep(300);
    const p1 = await page.eval(CLOCK); await sleep(1200); const p2 = await page.eval(CLOCK);
    check("pause holds position", (await page.eval(STATE)) === "paused" && p1 === p2, [p1, p2]);
    await page.eval("mwPlayer.seek(0.97)");
    await page.eval("document.getElementById('pl-play').click()");
    await sleep(1500);
    const r1 = await page.eval(CLOCK);
    check("resume after seek-while-paused continues from seek point", (await page.eval(STATE)) === "playing" && secs(r1) >= 368 && secs(r1) <= 374, r1);
    // let it finish and continue into movement II
    const moved = await waitFor(page, "mwPlayer.current() === 1 && mwPlayer.state() === 'playing'", 70000, 500);
    check("auto-advances to the next movement", !!moved, await page.eval("[mwPlayer.current(), mwPlayer.state(), document.getElementById('pl-status').textContent]"));
    const mvTitle = await page.eval("document.getElementById('pl-movement').textContent");
    check("movement heading updated", /^II\./.test(mvTitle), mvTitle);

    // switch movement while II plays: sound stops and III is idle
    await page.eval("document.querySelectorAll('#pl-movements button')[2].click()");
    await waitFor(page, "!!document.querySelector('#pl-paper svg') && mwPlayer.current() === 2 && !document.getElementById('pl-play').disabled", 10000);
    await sleep(800);
    check("switching stops playback", (await page.eval(STATE)) === "idle" && (await page.eval("mwPlayer.synth()")) === null);

    // switching during loading must not start the old movement
    await page.eval("document.getElementById('pl-play').click()");
    await sleep(50);
    const midLoad = await page.eval(STATE);
    await page.eval("document.querySelectorAll('#pl-movements button')[3].click()");
    await sleep(12000);
    const after = await page.eval("[mwPlayer.state(), mwPlayer.current(), !!mwPlayer.synth(), document.getElementById('pl-movement').textContent]");
    check("switch during loading cancels the old load", midLoad === "loading" && after[0] === "idle" && after[1] === 3 && after[2] === false, { midLoad, after });

    // double play: two quick clicks start exactly one load and end playing
    await page.eval("mwPlayer.seek(0.9)");
    const g0 = await page.eval("mwPlayer.gen()");
    await page.eval("document.getElementById('pl-play').click(); document.getElementById('pl-play').click();");
    await waitFor(page, "mwPlayer.state() === 'playing'", 90000);
    const g1 = await page.eval("mwPlayer.gen()");
    check("double play: one load, playing", (await page.eval(STATE)) === "playing" && g1 === g0 + 1, { g0, g1, now: await page.eval("[mwPlayer.state(), document.getElementById('pl-status').textContent, document.getElementById('pl-error').hidden, document.getElementById('pl-error-text').textContent, document.getElementById('pl-play').disabled]") });
    // tempo change while playing
    await page.eval("const t = document.getElementById('pl-tempo'); t.value = 80; t.dispatchEvent(new Event('input')); t.dispatchEvent(new Event('change'));");
    await waitFor(page, "mwPlayer.state() === 'playing'", 30000);
    const tb = await page.eval(BUF);
    check("tempo change keeps playing, buffer longer and normalized", tb && tb.seconds > 225 / 0.85 && Math.abs(tb.peak - 0.9) < 0.01, tb);
    await page.eval("document.getElementById('pl-tempo').value = 100");

    // navigation silences sound
    await page.eval("document.querySelector('.wordmark').addEventListener('click', e => e.preventDefault(), { once: true }); document.querySelector('.wordmark').click();");
    await sleep(300);
    check("following a link stops sound", (await page.eval(STATE)) === "idle" && (await page.eval("mwPlayer.synth()")) === null);

    const clockAfterStop = await page.eval(CLOCK);
    check("clock resets on stop", /^0:00 \/ ~3:45$/.test(clockAfterStop), clockAfterStop);
    await page.eval("document.documentElement.style.scrollBehavior = 'auto'; window.scrollTo(0,0); document.getElementById('pl-sheet').scrollTop = 0");
    await sleep(300);
    await page.shot(path.join(SHOTS, "mw-player-desktop.png"));

    /* ---------- fixtures: 1, 2, 3 and 6 parts ---------- */
    await open(page, "?id=fixture-one" + FIX);
    let labels = await page.eval(LABELS);
    check("1 part: label", JSON.stringify(labels) === '["Flute"]', labels);
    check("1 part: centred", JSON.stringify(await page.eval("mwPlayer.audioParams().pan")) === "[0]");
    check("1 part: no auto-next option", await page.eval("document.getElementById('pl-attacca-wrap').hidden"));
    await playAndWait(page);
    let b = await page.eval(BUF);
    check("1 part: flute plays, peak 0.9", (await page.eval(STATE)) === "playing" && b && Math.abs(b.peak - 0.9) < 0.01, b);
    check("1 part: flute samples requested", await page.eval("performance.getEntriesByType('resource').some(e => /flute-mp3/.test(e.name))"));
    await waitFor(page, "mwPlayer.state() === 'idle'", 20000);
    check("1 part: finishes on its own", (await page.eval("document.getElementById('pl-status').textContent")) === "Fine.");
    // mute the only part: silence
    await page.eval("document.querySelector('#pl-parts button').click()");
    check("mute toggles aria-pressed", (await page.eval("document.querySelector('#pl-parts button').getAttribute('aria-pressed')")) === "false");
    await playAndWait(page);
    b = await page.eval(BUF);
    check("muted part is silent", b && b.peak === 0, b);
    await page.eval("mwPlayer.stop()");

    await open(page, "?id=fixture-two" + FIX);
    labels = await page.eval(LABELS);
    check("2 parts: labels", JSON.stringify(labels) === '["Violin","Piano"]', labels);
    check("2 parts: programs", JSON.stringify(await page.eval("mwPlayer.parts().map(p => p.program)")) === "[40,0]");
    await page.eval("document.querySelectorAll('#pl-parts button')[0].click()");
    check("mute maps to track index", JSON.stringify(await page.eval("mwPlayer.audioParams().voicesOff")) === "[0]");
    await playAndWait(page);
    b = await page.eval(BUF);
    check("2 parts with violin muted still sounds (piano)", b && Math.abs(b.peak - 0.9) < 0.01, b);
    await page.eval("mwPlayer.stop()");

    // editing the source re-engraves and rebuilds parts; undo restores
    await page.eval("const t = document.getElementById('pl-abc'); t.value = t.value.replace('name=\"Violin\"', 'name=\"Viola d\\'amore\"'); t.dispatchEvent(new Event('input'));");
    await sleep(900);
    labels = await page.eval(LABELS);
    check("edited source re-engraves with new label", JSON.stringify(labels) === `["Viola d'amore","Piano"]` && !(await page.eval("document.getElementById('pl-edited').hidden")), labels);
    await page.eval("document.getElementById('pl-reset').click()");
    check("undo edits restores source", JSON.stringify(await page.eval(LABELS)) === '["Violin","Piano"]');
    await page.eval("document.getElementById('pl-dl-abc').click(); document.getElementById('pl-dl-midi').click();");
    check("downloads raise no error", await page.eval("document.getElementById('pl-error').hidden"));

    await open(page, "?id=fixture-three" + FIX);
    labels = await page.eval(LABELS);
    check("3 parts (2 voices on one staff): labels", JSON.stringify(labels) === '["Clarinet","Piano (1)","Piano (2)"]', labels);
    // piano reduction: no clarinet samples requested
    await page.eval("const s = document.getElementById('pl-sound'); s.value = 'piano'; s.dispatchEvent(new Event('change'));");
    await playAndWait(page);
    const res = await page.eval("performance.getEntriesByType('resource').map(e => e.name).filter(n => /-mp3\\//.test(n)).map(n => n.split('/').slice(-2)[0])");
    check("piano reduction uses only piano samples", res.length > 0 && res.every((n) => n === "acoustic_grand_piano-mp3"), [...new Set(res)]);
    await page.eval("mwPlayer.stop()");

    await open(page, "?id=fixture-multi" + FIX);
    labels = await page.eval(LABELS);
    check("6 parts: labels", JSON.stringify(labels) === '["Flute","Horn","Violins","Viola","Cello","Bass"]', labels);
    check("6 parts: programs", JSON.stringify(await page.eval("mwPlayer.parts().map(p => p.program)")) === "[73,60,48,41,42,43]");
    check("6 parts: key change engraves cleanly", (await page.eval("document.getElementById('pl-warn').textContent")) === "");
    check("6 parts: pan", JSON.stringify(await page.eval("mwPlayer.audioParams().pan")) === "[-0.6,-0.36,-0.12,0.12,0.36,0.6]");
    await page.eval("document.querySelectorAll('#pl-parts button')[2].click()");
    await playAndWait(page);
    b = await page.eval(BUF);
    check("6 parts plays, peak 0.9", b && Math.abs(b.peak - 0.9) < 0.01, b);
    await page.eval("document.querySelectorAll('#pl-movements button')[1].click()");
    await waitFor(page, "mwPlayer.current() === 1 && !!document.querySelector('#pl-paper svg') && !document.getElementById('pl-play').disabled", 10000);
    labels = await page.eval(LABELS);
    check("switching movement rebuilds part buttons (all unmuted)", JSON.stringify(labels) === '["Violin","Piano"]' && (await page.eval("mwPlayer.parts().every(p => p.on)")), labels);
    await page.eval("document.querySelectorAll('#pl-movements button')[2].click()");
    await waitFor(page, "!document.getElementById('pl-error').hidden", 10000);
    const err = await page.eval("[document.getElementById('pl-error-text').textContent, document.getElementById('pl-retry').hidden, document.getElementById('pl-play').disabled]");
    check("missing score: readable error with retry, play disabled", /Could not load .*HTTP 404/.test(err[0]) && err[1] === false && err[2] === true, err);
    await page.eval("document.getElementById('pl-retry').click()");
    await sleep(800);
    check("retry runs again", !(await page.eval("document.getElementById('pl-error').hidden")));

    /* ---------- not found and unsafe paths ---------- */
    await open(page, "?id=no-such-work");
    let nf = await page.eval("[document.getElementById('pl-missing').hidden, document.getElementById('pl-app').hidden, document.getElementById('pl-missing-title').textContent, [...document.querySelectorAll('#pl-missing-works a')].map(a => a.getAttribute('href'))]");
    check("unknown id: friendly page, no fallback player", nf[0] === false && nf[1] === true && /could not find/i.test(nf[2]) && (await page.eval("!mwPlayer.synth() && !document.querySelector('#pl-paper svg')")), nf);
    check("unknown id: offers real works", nf[3].includes("work.html?id=beethoven-quartet-d-minor"), nf[3]);
    await open(page, "");
    nf = await page.eval("[document.getElementById('pl-missing').hidden, document.getElementById('pl-missing-title').textContent]");
    check("no id: choose a work", nf[0] === false && /Choose a work/.test(nf[1]), nf);
    await open(page, "?id=fixture-one&catalog=https://evil.example/tests/fixtures/catalog.json");
    check("external catalogue refused", (await page.eval("document.getElementById('pl-missing-title').textContent")) === "That catalogue is not available");
    await open(page, "?id=fixture-bad-path" + FIX);
    const bad = await page.eval("document.getElementById('pl-error-text').textContent");
    check("traversal source refused before fetch", /not a local \.abc file/.test(bad) && !(await page.eval("performance.getEntriesByType('resource').some(e => /passwd/.test(e.name))")), bad);

    /* ---------- mobile ---------- */
    await page.send("Emulation.setDeviceMetricsOverride", { width: 375, height: 812, deviceScaleFactor: 2, mobile: true });
    await open(page, "?id=beethoven-quartet-d-minor");
    await sleep(800);
    const mob = await page.eval("({ overflow: document.documentElement.scrollWidth - window.innerWidth, sheet: document.getElementById('pl-sheet').getBoundingClientRect().height, svgW: document.querySelector('#pl-paper svg').getBoundingClientRect().width, play: document.getElementById('pl-play').getBoundingClientRect().height, inside: [...document.querySelectorAll('#pl-transport *')].every(e => { const r = e.getBoundingClientRect(), t = document.getElementById('pl-transport').getBoundingClientRect(); return r.width === 0 || (r.left >= t.left - 0.5 && r.right <= t.right + 0.5); }) })");
    check("mobile: no horizontal overflow, usable sheet", mob.overflow <= 0 && mob.inside && mob.sheet > 400 && mob.svgW <= 375 && mob.play >= 44, mob);
    await page.shot(path.join(SHOTS, "mw-player-375-top.png"));
    await page.eval("document.documentElement.style.scrollBehavior = 'auto'; document.getElementById('pl-transport').scrollIntoView()");
    await sleep(300);
    await page.shot(path.join(SHOTS, "mw-player-375-transport.png"));
  } catch (e) {
    failures++;
    console.log("FAIL exception: " + (e && e.stack || e));
  }
  const errs = page.logs.filter((l) => /EXCEPTION|error/i.test(l) && !/404|does-not-exist/.test(l));
  check("no page exceptions", errs.length === 0, errs.slice(0, 5));
  await page.close();
  console.log(`\n${passes} passed, ${failures} failed`);
  process.exit(failures ? 1 : 0);
})();
