/* Missing Works — reusable score player.
 *
 * work.html?id=<work-id> reads data/catalog.json, fetches the work's ABC movements,
 * engraves them with abcjs 6.5.2 and plays them with abcjs's sampled synth.
 *
 * The pure helpers (path checks, part discovery, sound mapping, key-change workaround)
 * are exported for Node tests; the page code below runs only in a browser that has a
 * [data-mw-player] element.
 */
(function (root) {
  "use strict";

  /* ======================= pure helpers ======================= */

  // Bowed-string General MIDI programs: violin, viola, cello, contrabass, string
  // ensembles 1 and 2. Their samples swell slowly, so short notes need a lift.
  var BOWED = [40, 41, 42, 43, 48, 49];
  var CATALOG_PATH = "data/catalog.json";
  var FIXTURE_PREFIX = "tests/fixtures/";

  function isBowed(program) { return BOWED.indexOf(program) >= 0; }

  // dB lift for a note lasting `seconds`: +6 dB at 0.15 s or shorter, nothing at 0.9 s or more.
  function shortNoteLift(seconds) {
    if (!(seconds < 0.9)) return 0;
    if (seconds <= 0.15) return 6;
    return 6 * (0.9 - seconds) / 0.75;
  }

  function validWorkId(id) { return typeof id === "string" && /^[a-z0-9][a-z0-9-]{0,79}$/.test(id); }

  // A manifest path must be a plain relative path inside the site: no scheme, no host,
  // no leading slash, no "." or ".." segments, no escapes, query or fragment.
  function safeRelativePath(path, extensions) {
    if (typeof path !== "string" || !path || path.length > 200) return null;
    if (!/^[A-Za-z0-9._\-\/]+$/.test(path)) return null;          // rejects ':' '\\' '%' '?' '#' spaces
    if (path.charAt(0) === "/" || path.charAt(0) === ".") return null;
    var segs = path.split("/");
    for (var i = 0; i < segs.length; i++) if (!segs[i] || segs[i] === "." || segs[i] === "..") return null;
    if (extensions && !extensions.some(function (e) { return path.slice(-e.length).toLowerCase() === e; })) return null;
    return path;
  }

  // Resolve a validated path against the page and insist on the same origin.
  function resolveSameOrigin(path, pageUrl, extensions) {
    var p = safeRelativePath(path, extensions);
    if (!p) return null;
    try {
      var base = new URL(pageUrl), u = new URL(p, base);
      return u.origin === base.origin ? u.href : null;
    } catch (e) { return null; }
  }

  // Which catalogue file to read. Only test fixtures may replace the real catalogue.
  function catalogPathFrom(param) {
    if (param == null || param === "") return CATALOG_PATH;
    var p = safeRelativePath(param, [".json"]);
    return p && p.indexOf(FIXTURE_PREFIX) === 0 ? p : null;
  }

  function findWork(catalog, id) {
    if (!catalog || !Array.isArray(catalog.works) || !validWorkId(id)) return null;
    var work = null;
    catalog.works.forEach(function (w) { if (w && w.id === id) work = w; });
    if (!work || !Array.isArray(work.movements) || !work.movements.length) return null;
    var byId = function (list, key) {
      var hit = null;
      (Array.isArray(list) ? list : []).forEach(function (x) { if (x && x.id === key) hit = x; });
      return hit;
    };
    return { work: work, composer: byId(catalog.composers, work.composerId), form: byId(catalog.forms, work.formId) };
  }

  function fmtTime(s) {
    s = Math.max(0, Math.round(s || 0));
    return Math.floor(s / 60) + ":" + ("0" + (s % 60)).slice(-2);
  }

  function field(abc, key) {
    var out = [], re = new RegExp("^" + key + ":\\s*(.*)$", "gm"), m;
    while ((m = re.exec(abc))) out.push(m[1].trim());
    return out;
  }

  // Two abcjs quirks around a key change inside a piece: an inline [K:...] forgets the
  // voice's clef, and every source line after it redraws the key signature. So from the
  // first key change on, rebuild the body as one long line per voice per key section and
  // put the clef back into each [K:...]. Only the copy that is engraved is changed.
  function normalizeKeyChanges(abc) {
    var lines = abc.split("\n"), clefs = {}, head = [], text = {}, order = [], started = false;
    lines.forEach(function (l) { var m = /^V:\s*(\S+).*clef=(\w+)/.exec(l); if (m) clefs[m[1]] = m[2]; });
    lines.forEach(function (l) {
      var m = /^\[V:\s*(\S+)\]\s*(.*)$/.exec(l);
      if (!started && m && m[2].indexOf("[K:") >= 0) started = true;
      if (!started) { head.push(l); return; }
      if (!m) return;                                  // comments and blank lines inside are dropped
      if (!(m[1] in text)) { text[m[1]] = ""; order.push(m[1]); }
      text[m[1]] += (text[m[1]] ? " " : "") + m[2];
    });
    if (!started) return abc;
    var parts = order.map(function (v) { return text[v].split(/(?=\[K:)/); });
    var n = parts[0].length;
    if (parts.some(function (p) { return p.length !== n; })) return abc;   // voices disagree: leave it alone
    for (var i = 0; i < n; i++) order.forEach(function (v, k) {
      var seg = parts[k][i].replace(/^\[K:([^\]]*)\]/, function (tag, key) {
        return /clef=/.test(key) || !clefs[v] ? tag : "[K:" + key + " clef=" + clefs[v] + "]";
      });
      if (seg.trim()) head.push("[V:" + v + "] " + seg);
    });
    return head.join("\n") + "\n";
  }

  // The page heading shows title and composer, so keep them off the sheet. Blank them
  // in place (same length) so character positions still match the source textarea.
  function blankTitles(abc) {
    return abc.replace(/^([TC]):.*$/gm, function (line, k) {
      return k === "T" ? "T:" + Array(line.length - 1).join(" ") : "%" + Array(line.length).join(" ");
    });
  }

  // %%label and %%note are this project's movement metadata, not abcjs directives; blank
  // them (same length) so abcjs does not report them as notation problems.
  function blankMetaDirectives(abc) {
    return abc.replace(/^%%(label|note)\b.*$/gm, function (line) { return "%" + Array(line.length).join(" "); });
  }

  // Part labels in abcjs track order. abcjs numbers tracks staff by staff, voice by voice,
  // and keeps each voice's name in staff.title[k]. A staff with several voices yields
  // several tracks, so count the voices actually present.
  function voiceTitles(tune) {
    var best = [];
    ((tune && tune.lines) || []).forEach(function (line) {
      if (!line.staff) return;
      var titles = [];
      line.staff.forEach(function (st) {
        var n = Math.max((st.voices || []).length, 1), t = st.title || [];
        var first = String(t[0] || "").trim();
        for (var k = 0; k < n; k++) {
          var name = String(t[k] || "").trim();
          if (!name && first && n > 1) name = first + " (" + (k + 1) + ")";
          else if (name && n > 1 && k === 0 && t.slice(1, n).every(function (x) { return !String(x || "").trim(); })) name = first + " (1)";
          titles.push(name);
        }
      });
      if (titles.length > best.length || (titles.length === best.length && !best.some(Boolean) && titles.some(Boolean))) best = titles;
    });
    return best;
  }

  function trackProgram(track) {
    var prog = null, i;
    for (i = 0; i < track.length; i++) if (track[i].cmd === "note" && typeof track[i].instrument === "number") return track[i].instrument;
    for (i = 0; i < track.length; i++) if (track[i].cmd === "program" && typeof track[i].instrument === "number") { prog = track[i].instrument; break; }
    return prog == null ? 0 : prog;
  }

  // One entry per audio track: { index, label, program, notes }.
  function partsFromTune(tune, tracks, instrumentNames) {
    var titles = voiceTitles(tune), used = {};
    return (tracks || []).map(function (track, i) {
      var program = trackProgram(track);
      var label = titles[i] || "Part " + (i + 1);
      if (used[label]) label = label + " " + (++used[label]); else used[label] = 1;
      var notes = 0;
      track.forEach(function (e) { if (e.cmd === "note") notes++; });
      var inst = instrumentNames && instrumentNames[program];
      return { index: i, label: label, program: program, instrument: inst ? String(inst).replace(/_/g, " ") : "program " + program, notes: notes };
    });
  }

  // Spread n tracks across the stereo stage, first part left; a single part is centred.
  function panFor(n) {
    if (n <= 1) return n === 1 ? [0] : [];
    var out = [];
    for (var i = 0; i < n; i++) out.push(Math.round((-0.6 + 1.2 * i / (n - 1)) * 1000) / 1000);
    return out;
  }

  // Change a freshly built abcjs sequence in place: piano mode moves every part to
  // program 0; bowed-string notes that are short get a level lift.
  function applySound(seq, mode) {
    var secPerWhole = 240 / (seq.tempo || 120);
    seq.tracks.forEach(function (track) {
      track.forEach(function (e) {
        if (mode === "piano" && (e.cmd === "program" || e.cmd === "note")) e.instrument = 0;
        if (e.cmd === "note" && isBowed(e.instrument) && e.volume) {
          var lift = shortNoteLift(e.duration * secPerWhole);
          if (lift) e.volume = Math.min(127, Math.round(e.volume * Math.pow(10, lift / 20)));
        }
      });
    });
    return seq;
  }

  function isMidiHeader(bytes) {
    return !!bytes && bytes.length >= 14 && bytes[0] === 0x4d && bytes[1] === 0x54 && bytes[2] === 0x68 && bytes[3] === 0x64;
  }

  // Scale every channel so the loudest sample sits at `target`. Returns the old peak.
  function normalizeChannels(channels, target) {
    var peak = 0, c, d, i;
    for (c = 0; c < channels.length; c++) { d = channels[c]; for (i = 0; i < d.length; i++) { var a = d[i] < 0 ? -d[i] : d[i]; if (a > peak) peak = a; } }
    if (!peak) return 0;
    var g = target / peak;
    for (c = 0; c < channels.length; c++) { d = channels[c]; for (i = 0; i < d.length; i++) d[i] *= g; }
    return peak;
  }

  // Run `jobs` (functions returning promises) with at most `limit` at a time.
  // `cancelled()` is checked before each job starts.
  function runBounded(jobs, limit, cancelled) {
    var next = 0, active = 0, maxActive = 0;
    function worker() {
      if (next >= jobs.length || (cancelled && cancelled())) return Promise.resolve();
      var job = jobs[next++];
      active++; if (active > maxActive) maxActive = active;
      return Promise.resolve().then(job).then(function () { active--; return worker(); }, function (err) { active--; throw err; });
    }
    var workers = [];
    for (var i = 0; i < Math.min(limit, jobs.length); i++) workers.push(worker());
    return Promise.all(workers).then(function () { return maxActive; });
  }

  // abcjs setTune/setWarp continue using midiBuffer until their promises settle.
  // Destroying a superseded controller midway clears that buffer and breaks prime().
  // Pause immediately, but defer destruction until all in-flight builds finish.
  function createSynthLifecycle() {
    var active = new WeakMap(), requested = new WeakSet(), destroyed = new WeakSet();
    function dispose(sc) {
      if (!sc || destroyed.has(sc)) return;
      try { sc.pause(); } catch (e) { }
      requested.add(sc);
      if ((active.get(sc) || 0) > 0) return;
      destroyed.add(sc);
      try { sc.destroy(); } catch (e) { }
    }
    function build(sc, job) {
      active.set(sc, (active.get(sc) || 0) + 1);
      return Promise.resolve().then(function () {
        if (requested.has(sc)) { var e = new Error("Superseded sound build"); e.cancelled = true; throw e; }
        return job();
      }).finally(function () {
        active.set(sc, active.get(sc) - 1);
        if (!active.get(sc) && requested.has(sc)) dispose(sc);
      });
    }
    return { dispose: dispose, build: build };
  }

  /* ---------- live drafts (work.html?draft=ID) ---------- */

  var DRAFT_STATUSES = ["composing", "completed", "open"];
  var POLL_MS = 5000, POLL_MAX_MS = 60000;

  function validRevision(n) { return typeof n === "number" && isFinite(n) && n >= 1 && n <= 1e9 && Math.floor(n) === n; }
  // ?revision=N: null when absent, NaN when present but not a plain positive integer.
  function revisionParam(s) {
    if (s == null || s === "") return null;
    return /^[1-9][0-9]{0,8}$/.test(s) ? +s : NaN;
  }
  // Relative, same-origin API paths only; never a URL taken from a response.
  function draftApiPath(id, rev) {
    if (!validWorkId(id) || (rev != null && !validRevision(rev))) return null;
    return "api/drafts/" + id + (rev != null ? "/revisions/" + rev : "");
  }
  function str(v, max) { return v == null ? "" : String(v).slice(0, max || 400); }
  function badDraft(msg) { var e = new Error(msg); e.badDraft = true; return e; }

  // Check one snapshot manifest from the draft API and return a clean copy. Throws when the
  // shape, IDs, revision or source paths are not exactly what this site publishes.
  function validateDraftManifest(work, id, rev) {
    if (!work || typeof work !== "object" || Array.isArray(work)) throw badDraft("the draft has no manifest");
    if (work.id !== id) throw badDraft("the draft manifest names a different work");
    if (!validRevision(work.revision)) throw badDraft("the draft revision number is not valid");
    if (rev != null && work.revision !== rev) throw badDraft("the server sent revision " + work.revision + " instead of " + rev);
    if (work.status !== "draft") throw badDraft("the snapshot is not marked as a draft");
    if (!Array.isArray(work.movements) || !work.movements.length || work.movements.length > 60) throw badDraft("the draft lists no movements");
    var prefix = "api/drafts/" + id + "/revisions/" + work.revision + "/", seen = {};
    var movements = work.movements.map(function (m, i) {
      if (!m || typeof m !== "object") throw badDraft("movement " + (i + 1) + " is malformed");
      var mid = m.id;
      if (typeof mid !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(mid) || seen[mid]) throw badDraft("movement " + (i + 1) + " has a bad or repeated id");
      seen[mid] = true;
      var src = m.source;
      if (typeof src !== "string" || src.indexOf(prefix) !== 0 || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}\.abc$/.test(src.slice(prefix.length)) || !safeRelativePath(src, [".abc"]))
        throw badDraft("the score path for movement " + (i + 1) + " is not this revision's own file");
      var bars = m.bars;
      return {
        id: mid, label: str(m.label || "Movement " + (i + 1), 200), note: str(m.note, 600), source: src,
        bars: typeof bars === "number" && isFinite(bars) && bars >= 0 && Math.floor(bars) === bars ? bars : null,
        durationSeconds: typeof m.durationSeconds === "number" && isFinite(m.durationSeconds) && m.durationSeconds > 0 ? m.durationSeconds : 0
      };
    });
    var t = typeof work.publishedAt === "string" ? Date.parse(work.publishedAt) : NaN;
    return {
      id: id, requestId: str(work.requestId, 120), composerId: str(work.composerId, 80), formId: str(work.formId, 80),
      round: typeof work.round === "number" ? work.round : null,
      title: str(work.title || id, 200), subtitle: str(work.subtitle, 300), description: str(work.description, 2000),
      status: "draft", revision: work.revision, publishedAt: isFinite(t) ? new Date(t).toISOString() : null,
      changeNote: str(work.changeNote, 2000), durationSeconds: typeof work.durationSeconds === "number" && isFinite(work.durationSeconds) ? work.durationSeconds : 0,
      movements: movements
    };
  }

  // GET api/drafts/ID -> { work, revisions, status, completedWorkId }.
  function validateDraftResponse(json, id) {
    if (!json || typeof json !== "object") throw badDraft("the draft service sent no data");
    var work = validateDraftManifest(json.work, id, null);
    if (DRAFT_STATUSES.indexOf(json.status) < 0) throw badDraft("the draft status is unknown");
    var completedWorkId = json.status === "completed" && validWorkId(json.completedWorkId) ? json.completedWorkId : null;
    var byRev = {};
    (Array.isArray(json.revisions) ? json.revisions : []).forEach(function (r) {
      if (!r || !validRevision(r.revision) || r.revision > work.revision) return;
      var t = typeof r.publishedAt === "string" ? Date.parse(r.publishedAt) : NaN;
      byRev[r.revision] = { revision: r.revision, publishedAt: isFinite(t) ? new Date(t).toISOString() : null, changeNote: str(r.changeNote, 2000) };
    });
    byRev[work.revision] = { revision: work.revision, publishedAt: work.publishedAt, changeNote: work.changeNote };
    var revisions = Object.keys(byRev).map(function (k) { return byRev[k]; }).sort(function (a, b) { return a.revision - b.revision; });
    return { work: work, revisions: revisions, status: json.status, completedWorkId: completedWorkId };
  }

  // Delay before the next metadata check: 5 s, then doubling per failure, at most 60 s.
  function pollDelay(failures) { return failures > 0 ? Math.min(POLL_MS * Math.pow(2, failures), POLL_MAX_MS) : POLL_MS; }

  // What to do about a newer revision. "apply": load it now; "offer": keep the current take
  // and show a switch button; "newer": the listener chose an older revision, just say so.
  function draftDecision(o) {
    if (!o || !(o.latest > o.viewing)) return "none";
    if (!o.follow) return "newer";
    if (o.state !== "idle" || o.continuing || o.edited || o.busy) return "offer";
    return "apply";
  }

  // Bars from abcjs note timings (tune.noteTimings after setTiming). measureNumber counts
  // the written bars from 0 (a pickup is the first); repeats replay a measureNumber.
  function barMap(timings) {
    var starts = {}, end = null, max = -1, last = null, repeats = false;
    (timings || []).forEach(function (e) {
      if (!e || typeof e.milliseconds !== "number") return;
      if (e.type === "end") { end = end == null ? e.milliseconds : Math.max(end, e.milliseconds); return; }
      var m = e.measureNumber;
      if (typeof m !== "number" || m < 0) return;
      if (!(m in starts)) starts[m] = e.milliseconds;
      else if (m !== last || e.measureStart) repeats = true;     // a bar heard again (a one-bar repeat stays consecutive)
      if (m > max) max = m;
      last = m;
    });
    if (end == null || end <= 0 || max < 0) return null;
    return { count: max + 1, starts: starts, end: end, repeats: repeats };
  }
  // Where bar `bar` (1-based) starts, as a fraction of the movement. Clamped to the bars there are.
  function barSeek(map, bar) {
    if (!map || typeof bar !== "number" || !isFinite(bar)) return null;
    var want = Math.round(bar), b = Math.min(Math.max(1, want), map.count), k = b - 1;
    while (k < map.count && !(k in map.starts)) k++;
    if (!(k in map.starts)) return null;
    var ms = map.starts[k];
    return { bar: k + 1, requested: want, clamped: k + 1 !== want, ms: ms, fraction: Math.min(0.999, Math.max(0, ms / map.end)), repeats: map.repeats };
  }

  // A cheap sanity check before an ABC text may replace a playable take.
  function looksLikeAbc(text) {
    return typeof text === "string" && text.length > 0 && text.length < 2000000 && /^X:/m.test(text) && /^K:/m.test(text);
  }

  var core = {
    BOWED: BOWED, isBowed: isBowed, shortNoteLift: shortNoteLift, validWorkId: validWorkId,
    safeRelativePath: safeRelativePath, resolveSameOrigin: resolveSameOrigin, catalogPathFrom: catalogPathFrom,
    findWork: findWork, fmtTime: fmtTime, field: field, normalizeKeyChanges: normalizeKeyChanges,
    blankTitles: blankTitles, blankMetaDirectives: blankMetaDirectives, voiceTitles: voiceTitles, trackProgram: trackProgram, partsFromTune: partsFromTune,
    panFor: panFor, applySound: applySound, isMidiHeader: isMidiHeader, normalizeChannels: normalizeChannels,
    runBounded: runBounded, createSynthLifecycle: createSynthLifecycle,
    validRevision: validRevision, revisionParam: revisionParam, draftApiPath: draftApiPath,
    validateDraftManifest: validateDraftManifest, validateDraftResponse: validateDraftResponse,
    pollDelay: pollDelay, draftDecision: draftDecision, barMap: barMap, barSeek: barSeek, looksLikeAbc: looksLikeAbc
  };
  if (typeof module === "object" && module.exports) module.exports = core;
  if (typeof window === "undefined" || typeof document === "undefined") return;
  root.MWPlayerCore = core;

  /* ======================= page ======================= */

  var SOUNDFONT = "https://paulrosen.github.io/midi-js-soundfonts/abcjs/";
  var PLAY_ICON = "M7 4l14 8-14 8z", PAUSE_ICON = "M6 4h4v16H6zM14 4h4v16h-4z";
  var $ = function (id) { return document.getElementById(id); };

  var S = {
    catalog: null, info: null, movements: [], current: -1,
    sources: {}, edited: {},            // movement index -> fetched / edited ABC
    visualObj: null, parts: [], partsOn: [],
    synth: null, host: null,
    state: "idle",                      // idle | loading | playing | paused
    audioStale: true, gen: 0, totalSeconds: 0, pendingSeek: null,
    dragging: false, lastTop: null, cursorLine: null, lit: [], fetched: {}, nextTimer: null,
    lastPeak: 0, retry: null,
    urlCache: {}, barInfo: undefined     // fetched ABC by URL; bar positions of the engraved tune
  };
  var D = null;                         // live-draft state; null on finished works (?id=)

  function setStatus(t) { $("pl-status").textContent = t; }
  function setState(s) {
    S.state = s;
    var b = $("pl-play");
    b.dataset.state = s;
    b.setAttribute("aria-label", s === "playing" ? "Pause" : s === "loading" ? "Loading sound" : "Play");
    $("pl-play-icon").setAttribute("d", s === "playing" ? PAUSE_ICON : PLAY_ICON);
    $("pl-play-text").textContent = s === "playing" ? "Pause" : s === "loading" ? "Loading" : s === "paused" ? "Resume" : "Play";
    b.setAttribute("aria-busy", s === "loading" ? "true" : "false");
    $("pl-tempo").disabled = s === "loading";
    if (D && D.started) { renderOffer(); $("pl-stop").disabled = s === "idle" && !S.nextTimer; }
  }
  function showError(msg, retry) {
    S.retry = retry || null;
    $("pl-error-text").textContent = msg;
    $("pl-retry").hidden = !retry;
    $("pl-error").hidden = false;
  }
  function clearError() { $("pl-error").hidden = true; S.retry = null; }
  function el(tag, attrs, text) {
    var e = document.createElement(tag);
    Object.keys(attrs || {}).forEach(function (k) { e.setAttribute(k, attrs[k]); });
    if (text != null) e.textContent = text;
    return e;
  }

  /* ---------- sound teardown ---------- */
  var synthLifecycle = createSynthLifecycle();
  function killSynth(sc) { synthLifecycle.dispose(sc); }
  // Stop whatever is sounding or loading, and make the next play rebuild the audio.
  function stopAll(message) {
    S.gen++;
    clearTimeout(S.nextTimer); S.nextTimer = null;
    var old = S.synth;
    S.synth = null;
    killSynth(old);
    if (S.host) { S.host.remove(); S.host = null; }
    S.audioStale = true; S.totalSeconds = 0;
    clearLit();
    var was = S.state;
    setState("idle");
    $("pl-seek").value = S.pendingSeek == null ? 0 : Math.round(S.pendingSeek * 1000);
    var m = S.movements[S.current];
    $("pl-clock").textContent = "0:00 / " + (m && m.durationSeconds ? "~" + fmtTime(m.durationSeconds) : "0:00");
    if (message) setStatus(message);
    else if (was !== "idle") setStatus("Stopped. Press play to listen.");
  }

  /* ---------- engraving ---------- */
  function engrave() {
    var abc = $("pl-abc").value;
    var body = blankTitles(normalizeKeyChanges(blankMetaDirectives(abc)));
    var w = Math.max($("pl-sheet").clientWidth - 28, 300);
    var out = ABCJS.renderAbc("pl-paper", body, {
      responsive: "resize", add_classes: true, staffwidth: Math.max(w, 520),
      wrap: { minSpacing: 2.0, maxSpacing: 2.8, preferredMeasuresPerLine: w > 900 ? 5 : w > 620 ? 4 : 3 },
      paddingtop: 6, paddingbottom: 10, paddingleft: 6, paddingright: 6,
      foregroundColor: "#162c33", selectionColor: "#162c33",
      clickListener: onNoteClick,
      format: { annotationfont: "Newsreader italic 13", tempofont: "Newsreader bold 14", voicefont: "Newsreader italic 13", measurefont: "Newsreader italic 11", partsfont: "Newsreader bold 15", gchordfont: "Newsreader 13", vocalfont: "Newsreader 13" }
    });
    S.visualObj = out[0] || null;
    S.barInfo = undefined;
    var warnings = (S.visualObj && S.visualObj.warnings) || [];
    $("pl-warn").textContent = warnings.length ? "Notation problems:\n" + warnings.map(function (x) { return String(x).replace(/<[^>]+>/g, ""); }).join("\n") : "";
    S.cursorLine = null; S.lit = []; S.lastTop = null;
    var svg = document.querySelector("#pl-paper svg");
    if (svg) {
      S.cursorLine = document.createElementNS("http://www.w3.org/2000/svg", "line");
      S.cursorLine.setAttribute("class", "pl-cursor");
      svg.appendChild(S.cursorLine);
    }
    if (S.visualObj) {
      var orig = S.visualObj.setUpAudio;
      var tracks = orig.call(S.visualObj, {}).tracks;
      var parts = partsFromTune(S.visualObj, tracks, ABCJS.synth.instrumentIndexToName);
      var sameShape = parts.length === S.parts.length && parts.every(function (p, i) { return p.label === S.parts[i].label; });
      S.parts = parts;
      if (!sameShape) S.partsOn = parts.map(function () { return true; });
      // Set the sound where abcjs builds the sequence, before it decides which samples
      // to load. (A sequenceCallback runs after loading, and overriding there gave silence.)
      S.visualObj.setUpAudio = function (options) { return applySound(orig.call(this, options), $("pl-sound").value); };
    } else { S.parts = []; S.partsOn = []; }
    renderParts();
    S.audioStale = true;
  }
  function renderParts() {
    var host = $("pl-parts");
    host.textContent = "";
    S.parts.forEach(function (p, i) {
      var b = el("button", { type: "button", "aria-pressed": String(S.partsOn[i]), title: p.label + " (" + p.instrument + "). Click to " + (S.partsOn[i] ? "mute" : "unmute") + "." }, p.label);
      b.dataset.program = p.program;
      b.addEventListener("click", function () {
        S.partsOn[i] = !S.partsOn[i];
        b.setAttribute("aria-pressed", String(S.partsOn[i]));
        b.title = p.label + " (" + p.instrument + "). Click to " + (S.partsOn[i] ? "mute" : "unmute") + ".";
        changed();
      });
      host.appendChild(b);
    });
    $("pl-parts-wrap").hidden = !S.parts.length;
    $("pl-parts-count").textContent = S.parts.length === 1 ? "1 part" : S.parts.length + " parts";
  }

  /* ---------- cursor ---------- */
  function clearLit() {
    S.lit.forEach(function (e) { e.classList.remove("pl-on"); }); S.lit = [];
    if (S.cursorLine) { S.cursorLine.setAttribute("y1", 0); S.cursorLine.setAttribute("y2", 0); }
  }
  function follow() {
    var sheet = $("pl-sheet"), r = S.cursorLine.getBoundingClientRect(), s = sheet.getBoundingClientRect();
    var target = sheet.scrollTop + (r.top - s.top) - 24;
    if (Math.abs(target - sheet.scrollTop) > 8) sheet.scrollTo({ top: Math.max(0, target) });
  }
  function makeCursor(gen) {
    return {
      onStart: function () { },
      onBeat: function (beat, totalBeats, totalMs) {
        if (gen !== S.gen) return;
        S.totalSeconds = totalMs / 1000;
        var frac = totalBeats ? beat / totalBeats : 0;
        if (!S.dragging) $("pl-seek").value = Math.round(1000 * frac);
        $("pl-seek").setAttribute("aria-valuetext", fmtTime(S.totalSeconds * frac) + " of " + fmtTime(S.totalSeconds));
        $("pl-clock").textContent = fmtTime(S.totalSeconds * frac) + " / " + fmtTime(S.totalSeconds);
      },
      onEvent: function (ev) {
        if (gen !== S.gen || !ev || (ev.measureStart && ev.left === null)) return;
        S.lit.forEach(function (e) { e.classList.remove("pl-on"); }); S.lit = [];
        (ev.elements || []).forEach(function (group) { Array.prototype.forEach.call(group, function (e) { e.classList.add("pl-on"); S.lit.push(e); }); });
        if (S.cursorLine) {
          S.cursorLine.setAttribute("x1", ev.left - 3); S.cursorLine.setAttribute("x2", ev.left - 3);
          S.cursorLine.setAttribute("y1", ev.top); S.cursorLine.setAttribute("y2", ev.top + ev.height);
          if (ev.top !== S.lastTop) { S.lastTop = ev.top; follow(); }
        }
        if (ev.measureNumber != null && S.state === "playing") setStatus("Bar " + (ev.measureNumber + 1));
      },
      onFinished: function () {
        if (gen !== S.gen) return;
        clearLit();
        var wasPlaying = S.state === "playing";
        setState("idle");     // the buffer stays loaded; play starts again from the top
        S.pendingSeek = null;
        setStatus("Fine."); $("pl-seek").value = 0;
        $("pl-clock").textContent = fmtTime(0) + " / " + fmtTime(S.totalSeconds);
        var i = S.current;
        if (wasPlaying && $("pl-attacca").checked && i < S.movements.length - 1) {
          setStatus("Next: " + S.movements[i + 1].label);
          clearTimeout(S.nextTimer);
          S.nextTimer = setTimeout(function () {
            if (gen === S.gen && S.state === "idle" && S.current === i) openMovement(i + 1).then(function (ok) { if (ok) togglePlay(); });
          }, 2500);
        }
      }
    };
  }

  /* ---------- audio ---------- */
  function audioParams() {
    var off = [];
    S.partsOn.forEach(function (on, i) { if (!on) off.push(i); });
    // Measured on the quartet: at the default level (about 0.4) loud passages peak near 2.0;
    // the buffer is normalized afterwards anyway, this keeps abcjs's own mix headroom.
    return { soundFontUrl: SOUNDFONT, voicesOff: off.length ? off : false, soundFontVolumeMultiplier: 0.19, pan: panFor(S.parts.length) };
  }
  // abcjs downloads one mp3 per note and remembers a failed download for the life of the
  // page, so one network hiccup would silence the piece until a reload. Fetch the samples
  // first, a few at a time and with retries; abcjs then finds them in the HTTP cache.
  function sampleUrls() {
    var seen = {}, urls = [];
    S.visualObj.setUpAudio(audioParams()).tracks.forEach(function (track) {
      track.forEach(function (e) {
        if (e.cmd !== "note") return;
        var inst = typeof e.instrument === "number" ? ABCJS.synth.instrumentIndexToName[e.instrument] : e.instrument;
        var url = SOUNDFONT + inst + "-mp3/" + ABCJS.synth.pitchToNoteName[e.pitch] + ".mp3";
        if (!seen[url]) { seen[url] = true; urls.push(url); }
      });
    });
    return urls;
  }
  function fetchSample(url, attempt) {
    return fetch(url).then(function (r) { if (!r.ok) throw new Error("an instrument sample did not load (HTTP " + r.status + ")"); return r.arrayBuffer(); })
      .catch(function (err) {
        if (attempt >= 4) throw err;
        return new Promise(function (r) { setTimeout(r, 400 * attempt); }).then(function () { return fetchSample(url, attempt + 1); });
      });
  }
  function Cancelled() { this.cancelled = true; }
  function prefetchSamples(gen) {
    var urls = sampleUrls().filter(function (u) { return !S.fetched[u]; }), done = 0;
    var jobs = urls.map(function (url) {
      return function () {
        return fetchSample(url, 1).then(function () {
          S.fetched[url] = true; done++;
          if (gen === S.gen) setStatus("Loading the instruments\u2026 " + done + " of " + urls.length + " notes");
        });
      };
    });
    return runBounded(jobs, 6, function () { return gen !== S.gen; });
  }
  function normalize() {
    var b = S.synth && S.synth.midiBuffer && S.synth.midiBuffer.audioBuffers && S.synth.midiBuffer.audioBuffers[0];
    if (!b) return;
    var ch = [];
    for (var c = 0; c < b.numberOfChannels; c++) ch.push(b.getChannelData(c));
    S.lastPeak = normalizeChannels(ch, 0.9);
  }
  function loadAudio() {
    var gen = ++S.gen;
    var guard = function (v) { if (gen !== S.gen) throw new Cancelled(); return v; };
    killSynth(S.synth);
    if (S.host) S.host.remove();
    S.host = el("div", { hidden: "" });
    $("pl-synth-host").appendChild(S.host);
    var sc = new ABCJS.synth.SynthController();
    sc.load(S.host, makeCursor(gen), { displayPlay: true, displayProgress: true, displayWarp: true, displayRestart: true });
    S.synth = sc;
    setState("loading"); setStatus("Loading the instruments\u2026");
    return prefetchSamples(gen).then(guard).then(function () {
      setStatus("Preparing the sound\u2026");
      return synthLifecycle.build(sc, function () { return sc.setTune(S.visualObj, true, audioParams()); });
    }).then(guard).then(function () {
      var warp = +$("pl-tempo").value;
      return warp === 100 ? null : synthLifecycle.build(sc, function () { return sc.setWarp(warp); });
    }).then(guard).then(function () {
      normalize();
      S.audioStale = false;
      if (S.pendingSeek != null) { sc.seek(S.pendingSeek); S.pendingSeek = null; }
      return gen;
    }, function (err) {
      // A superseded load's controller has been destroyed, so abcjs may fail inside it.
      // That failure belongs to the old load, not to whatever the listener is doing now.
      throw gen !== S.gen ? new Cancelled() : err;
    });
  }
  function fail(err) {
    if (err && err.cancelled) return;     // superseded by a newer action; not an error
    stopAll("Playback stopped.");
    showError("Could not start the sound: " + (err && err.message ? err.message : err) + ". Check the connection and try again.", function () { togglePlay(); });
    if (window.console) console.error(err);
  }
  function togglePlay() {
    if (!window.ABCJS || !ABCJS.synth.supportsAudio()) { setStatus("This browser has no Web Audio, so the score is silent here."); return; }
    if (S.state === "loading" || !S.visualObj) return;
    clearError();
    clearTimeout(S.nextTimer);
    // SynthController.play() is a toggle: it pauses when started. Its pause() does not clear
    // the started flag, so pausing with pause() made the next play() pause again.
    var sc = S.synth;
    if (S.state === "playing") { setState("paused"); setStatus("Paused."); Promise.resolve(sc.play()).catch(fail); return; }
    var go = function (gen) {
      if (gen !== S.gen) throw new Cancelled();
      return Promise.resolve(S.synth.play()).then(function () { if (gen === S.gen) setState("playing"); });
    };
    (S.audioStale ? loadAudio() : Promise.resolve(S.gen)).then(go).catch(fail);
  }
  function changed() {
    // Anything that changes the sound needs the audio rebuilt on the next play.
    var was = S.state;
    S.pendingSeek = null;
    stopAll(was === "idle" ? null : "Changed. Press play to hear it.");
  }
  function seekTo(fraction) {
    fraction = Math.min(0.999, Math.max(0, fraction));
    if (!S.synth || S.audioStale) { S.pendingSeek = fraction; setStatus("Will start at " + Math.round(fraction * 100) + "% of the movement."); return; }
    if (S.state !== "playing") { S.synth.seek(fraction); return; }
    // abcjs's seek while sound runs leaves its start time stale, so a later pause/resume
    // would jump back. Pause (play() toggles), seek, resume.
    var sc = S.synth, gen = S.gen;
    sc.play().then(function () { if (gen !== S.gen) throw new Cancelled(); sc.seek(fraction); return sc.play(); }).catch(fail);
  }
  function onNoteClick(abcElem) {
    if (S.audioStale || !S.totalSeconds || !abcElem || abcElem.currentTrackMilliseconds == null) return;
    var ms = abcElem.currentTrackMilliseconds;
    if (Array.isArray(ms)) ms = ms[0];
    seekTo(ms / (S.totalSeconds * 1000));
  }

  /* ---------- movements ---------- */
  function fetchSource(i) {
    if (S.sources[i] != null) return Promise.resolve(S.sources[i]);
    var m = S.movements[i], movements = S.movements;
    return fetchAbc(m.source, m.label).then(function (t) { if (S.movements === movements) S.sources[i] = t; return t; });
  }
  // Fetch one ABC file by its manifest path. Draft revision files are immutable, so they are
  // kept by URL for the life of the page (switching back to an old revision is instant).
  function fetchAbc(source, label) {
    var url = resolveSameOrigin(source, location.href, [".abc"]);
    if (!url) return Promise.reject(new Error("the score path for \u201c" + label + "\u201d is not a local .abc file"));
    if (S.urlCache[url] != null) return Promise.resolve(S.urlCache[url]);
    return fetch(url, { cache: "no-cache" }).then(function (r) {
      if (!r.ok) throw new Error("the score file did not load (HTTP " + r.status + ")");
      return r.text();
    }).then(function (t) { if (D) S.urlCache[url] = t; return t; });
  }
  function openMovement(i) {
    stopAll(null);
    S.pendingSeek = null;
    clearError();
    S.current = i;
    var m = S.movements[i], gen = S.gen;
    Array.prototype.forEach.call(document.querySelectorAll("#pl-movements button"), function (b) {
      b.setAttribute("aria-current", +b.dataset.index === i ? "true" : "false");
    });
    $("pl-movement").textContent = m.label;
    $("pl-movement-note").textContent = m.note || "";
    $("pl-clock").textContent = "0:00 / " + (m.durationSeconds ? "~" + fmtTime(m.durationSeconds) : "0:00");
    setStatus("Loading the score\u2026");
    $("pl-sheet").setAttribute("aria-busy", "true");
    $("pl-play").disabled = true;
    return fetchSource(i).then(function (text) {
      if (gen !== S.gen) return false;
      $("pl-abc").value = S.edited[i] != null ? S.edited[i] : text;
      engrave();
      $("pl-sheet").scrollTop = 0;
      $("pl-play").disabled = false;
      $("pl-sheet").setAttribute("aria-busy", "false");
      setStatus("Ready. Press play to listen.");
      if (D) afterDraftMovement();
      return true;
    }).catch(function (err) {
      if (gen !== S.gen) return false;
      $("pl-sheet").setAttribute("aria-busy", "false");
      $("pl-paper").textContent = "";
      setStatus("The score is not available.");
      showError("Could not load \u201c" + m.label + "\u201d: " + (err && err.message ? err.message : err) + ".", function () { openMovement(i); });
      return false;
    });
  }

  /* ---------- downloads ---------- */
  function download(name, blob) {
    var a = el("a", { download: name });
    a.href = URL.createObjectURL(blob);
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 10000);
  }
  function baseName() { var m = S.movements[S.current]; return S.info.work.id + "-" + (m ? m.id : "score"); }
  function midiBytes() {
    var out = ABCJS.synth.getMidiFile($("pl-abc").value, { midiOutputType: "binary" });
    var bytes = out && out[0];
    if (!isMidiHeader(bytes)) throw new Error("the MIDI file could not be made from this source");
    return bytes;
  }

  /* ---------- page setup ---------- */
  function notFound(title, detail, catalog) {
    document.title = "Work not found \u2014 Missing Works";
    $("pl-app").hidden = true;
    var box = $("pl-missing");
    box.hidden = false;
    $("pl-missing-title").textContent = title;
    $("pl-missing-detail").textContent = detail;
    var list = $("pl-missing-works");
    list.textContent = "";
    var works = (catalog && Array.isArray(catalog.works)) ? catalog.works.filter(function (w) { return w && validWorkId(w.id); }) : [];
    works.forEach(function (w) {
      var li = el("li"), a = el("a", { href: "work.html?id=" + encodeURIComponent(w.id) }, w.title || w.id);
      li.appendChild(a);
      if (w.subtitle) li.appendChild(el("span", { class: "meta" }, " \u2014 " + w.subtitle));
      list.appendChild(li);
    });
    $("pl-missing-list").hidden = !works.length;
    $("pl-loading").hidden = true;
  }
  function setLink(id, path) {
    var a = $(id), url = path ? resolveSameOrigin(path, location.href, [".html"]) : null;
    if (url) { a.href = path; a.hidden = false; } else a.hidden = true;
    return !!url;
  }
  function buildPage(info) {
    var w = info.work, c = info.composer, f = info.form;
    document.title = (w.title || "Untitled") + " \u2014 Missing Works";
    var composerName = c ? c.name : "";
    $("pl-crumb-composer").textContent = c ? (c.shortName || c.name) : "Composer";
    $("pl-crumb-composer").href = "index.html#composer/" + encodeURIComponent(w.composerId || "");
    $("pl-crumb-work").textContent = w.title || w.id;
    $("pl-kicker").textContent = [composerName ? "After " + composerName : "", f ? f.label : "", w.durationSeconds ? "about " + Math.round(w.durationSeconds / 60) + " minutes" : ""].filter(Boolean).join(" \u00b7 ");
    $("pl-title").textContent = w.title || w.id;
    $("pl-subtitle").textContent = w.subtitle || "";
    $("pl-description").textContent = w.description || "";
    $("pl-disclaimer-who").textContent = composerName ? " by " + (c.shortName || composerName) : "";
    var any = setLink("pl-notebook", w.notebook);
    any = setLink("pl-transcript", w.transcript) || any;
    any = setLink("pl-legacy", w.legacyUrl) || any;
    $("pl-links").hidden = !any;
    var list = $("pl-movements");
    list.textContent = "";
    S.movements.forEach(function (m, i) {
      var li = el("li"), b = el("button", { type: "button", "aria-current": String(i === S.current) });
      b.dataset.index = i;
      b.dataset.id = m.id;
      b.appendChild(el("span", { class: "pl-mv-label" }, m.label));
      if (D) b.appendChild(el("span", { class: "pl-mv-time pl-mv-bars" }, m.bars == null ? "" : m.bars === 1 ? "1 bar" : m.bars + " bars"));
      else if (m.durationSeconds) b.appendChild(el("span", { class: "pl-mv-time" }, fmtTime(m.durationSeconds)));
      b.addEventListener("click", function () { if (i !== S.current || S.sources[i] == null) openMovement(i); });
      li.appendChild(b); list.appendChild(li);
    });
    $("pl-attacca-wrap").hidden = S.movements.length < 2;
    $("pl-loading").hidden = true;
    $("pl-app").hidden = false;
  }

  function wire() {
    $("pl-play").addEventListener("click", togglePlay);
    $("pl-sound").addEventListener("change", changed);
    $("pl-retry").addEventListener("click", function () { var r = S.retry; clearError(); if (r) r(); });
    $("pl-tempo").addEventListener("input", function () { $("pl-tempo-out").textContent = this.value + "%"; });
    $("pl-tempo").addEventListener("change", function () {
      var sc = S.synth;
      if (!sc || S.audioStale || S.state === "loading") return;   // read again on the next load
      var was = S.state, warp = +this.value, gen = S.gen;
      setState("loading"); setStatus("Changing the tempo\u2026");
      // Change tempo while paused (setWarp's own resume-and-seek has the stale-start-time
      // problem described in seekTo), then resume ourselves.
      (was === "playing" ? sc.play() : Promise.resolve()).then(function () {
        if (gen !== S.gen) throw new Cancelled();
        return synthLifecycle.build(sc, function () { return sc.setWarp(warp); });
      }).then(function () {
        if (gen !== S.gen) throw new Cancelled();
        normalize();
        return was === "playing" ? sc.play() : null;
      }).then(function () {
        if (gen !== S.gen) return;
        setState(was); setStatus(was === "playing" ? "" : "Tempo set. Press play.");
        if (+$("pl-tempo").value !== warp) $("pl-tempo").dispatchEvent(new Event("change"));
      }).catch(fail);
    });
    $("pl-seek").addEventListener("input", function () { S.dragging = true; });
    $("pl-seek").addEventListener("change", function () { S.dragging = false; seekTo(this.value / 1000); });
    var typing = null;
    $("pl-abc").addEventListener("input", function () {
      clearTimeout(typing);
      var i = S.current;
      typing = setTimeout(function () {
        if (i !== S.current) return;
        S.edited[i] = $("pl-abc").value;
        changed(); engrave();
        $("pl-edited").hidden = false;
      }, 400);
    });
    $("pl-reset").addEventListener("click", function () {
      if (S.current < 0 || S.sources[S.current] == null) return;
      delete S.edited[S.current];
      $("pl-abc").value = S.sources[S.current];
      changed(); engrave();
      $("pl-edited").hidden = true;
    });
    $("pl-dl-abc").addEventListener("click", function () {
      download(baseName() + ".abc", new Blob([$("pl-abc").value], { type: "text/plain;charset=utf-8" }));
    });
    $("pl-dl-midi").addEventListener("click", function () {
      try { download(baseName() + ".mid", new Blob([midiBytes()], { type: "audio/midi" })); }
      catch (e) { showError("Could not make the MIDI file: " + e.message + ".", null); }
    });
    var resizing = null, lastW = $("pl-sheet").clientWidth;
    if (window.ResizeObserver) new ResizeObserver(function () {
      var w = $("pl-sheet").clientWidth;
      if (Math.abs(w - lastW) < 40) return;
      lastW = w; clearTimeout(resizing);
      resizing = setTimeout(function () { if (S.state === "idle" && S.visualObj && S.audioStale) engrave(); }, 250);
    }).observe($("pl-sheet"));
    // Leaving the page (link, back button, bfcache) must silence everything.
    window.addEventListener("pagehide", function () { stopAll(null); });
    document.addEventListener("click", function (e) {
      var a = e.target.closest && e.target.closest("a[href]");
      if (a && !a.hasAttribute("download") && S.state !== "idle") stopAll("Stopped.");
    });
  }

  /* ---------- live drafts ---------- */
  // A draft is a series of immutable published revisions. The take on screen (score and
  // audio) is replaced only when the listener is idle and following the latest revision, or
  // when they press a switch button. Polling never touches the score or the sound otherwise.

  // Edits count from the first keystroke: the textarea is compared with the loaded source, so
  // a poll inside the 400 ms re-engrave debounce still sees them.
  function hasEdits() {
    if (Object.keys(S.edited).length) return true;
    var src = S.sources[S.current];
    return S.current >= 0 && src != null && $("pl-abc").value !== src;
  }
  function draftLog(entry) { entry.at = Date.now(); D.log.push(entry); if (D.log.length > 200) D.log.shift(); }
  function errText(err) { return err && err.message ? err.message : String(err); }
  function fmtWhen(iso) {
    if (!iso) return "";
    var d = new Date(iso);
    try { return d.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }); } catch (e) { return d.toLocaleString(); }
  }
  function catalogEntry(list, id) {
    var hit = null;
    (S.catalog && Array.isArray(S.catalog[list]) ? S.catalog[list] : []).forEach(function (x) { if (x && x.id === id) hit = x; });
    return hit;
  }
  function fetchDraftJson(path) {
    return fetch(path, { cache: "no-store", headers: { Accept: "application/json" } }).then(function (r) {
      if (r.status === 404) { var e = new Error("not published (HTTP 404)"); e.notFound = true; throw e; }
      if (!r.ok) throw new Error("HTTP " + r.status);
      return r.json().catch(function () { throw new Error("the draft service did not send JSON"); });
    });
  }
  function abcParses(text) {
    if (!looksLikeAbc(text)) return false;
    try { var t = ABCJS.parseOnly(text); return !!(t && t[0] && t[0].lines && t[0].lines.length); } catch (e) { return false; }
  }

  function startDraft(params, catalogPath) {
    var id = params.get("draft") || "";
    if (!validWorkId(id)) { notFound("That draft address is not valid", "Draft names use lower-case letters, digits and hyphens. Choose a work below or see the queue.", null); return; }
    var pin = revisionParam(params.get("revision"));
    D = {
      id: id, pin: validRevision(pin) ? pin : null, badPin: pin !== null && !validRevision(pin),
      follow: !validRevision(pin), viewing: 0, work: null, latest: 0, latestWork: null, revisions: [],
      status: null, completedWorkId: null, started: false, timer: null, inflight: null, failures: 0,
      nextDelay: POLL_MS, paused: false, token: 0, applying: null, confirm: null, confirmFollow: false,
      snaps: {}, log: [], polls: 0, lastError: null, want: params.get("movement") || "", optionsKey: ""
    };
    document.body.classList.add("pl-is-draft");
    $("pl-loading").textContent = "Loading the draft\u2026";
    fetch(catalogPath, { cache: "no-cache" }).then(function (r) { return r.ok ? r.json() : null; }).catch(function () { return null; }).then(function (catalog) {
      S.catalog = catalog;     // only for composer and form names; a draft needs no catalogue entry
      if (!window.ABCJS || !ABCJS.renderAbc) {
        showWaiting("The score cannot be shown", "The notation library did not load. Check the connection and reload the page.", "");
        $("pl-waiting-retry").onclick = function () { location.reload(); };
        return;
      }
      wire(); wireDraft();
      checkDraft();
    });
  }

  function showWaiting(title, detail, status) {
    document.title = "Draft not ready yet \u2014 Missing Works";
    $("pl-loading").hidden = true;
    $("pl-app").hidden = true;
    $("pl-waiting").hidden = false;
    $("pl-waiting-title").textContent = title;
    $("pl-waiting-detail").textContent = detail;
    $("pl-waiting-status").textContent = status;
    // Draft IDs start with the composer ID (e.g. bach-...); link that composer when it exists.
    var c = null;
    (S.catalog && Array.isArray(S.catalog.composers) ? S.catalog.composers : []).forEach(function (x) {
      if (x && validWorkId(x.id) && D && D.id.indexOf(x.id + "-") === 0) c = x;
    });
    var a = $("pl-waiting-composer");
    if (c) { a.href = "index.html#composer/" + encodeURIComponent(c.id); a.textContent = "More from " + (c.shortName || c.name); a.hidden = false; } else a.hidden = true;
  }
  function waitingForFirst() {
    var wait = Math.round(pollDelay(D.failures) / 1000);
    showWaiting("The first draft is not ready yet",
      "Nothing from this composition has been published yet. Keep this page open: the score appears here as soon as the first section is published.",
      D.lastError ? "Could not reach the draft service (" + D.lastError + "). Trying again in " + wait + " s." : "Checking every " + wait + " seconds.");
  }

  /* polling: one request at a time, every 5 s while visible, backing off after failures */
  function checkDraft() {
    if (!D) return Promise.resolve(null);
    if (D.inflight) return D.inflight;
    clearTimeout(D.timer); D.timer = null;
    D.polls++;
    var p = fetchDraftJson(draftApiPath(D.id)).then(function (json) {
      var meta = validateDraftResponse(json, D.id);
      D.failures = 0; D.lastError = null;
      return onDraftMeta(meta);
    }).catch(function (err) {
      if (err && err.notFound && !D.started) { D.failures = 0; D.lastError = null; return; }
      D.failures++; D.lastError = errText(err);
      draftLog({ t: "fail", error: D.lastError, failures: D.failures });
    }).then(function () {
      D.inflight = null;
      schedulePoll();
      if (!D.started) waitingForFirst(); else renderConn();
      return draftState();
    });
    D.inflight = p;
    return p;
  }
  function schedulePoll() {
    clearTimeout(D.timer); D.timer = null;
    D.nextDelay = pollDelay(D.failures);
    if (D.paused || document.hidden || D.inflight) return;
    D.timer = setTimeout(checkDraft, D.nextDelay);
  }
  function pausePolling() { if (D) { clearTimeout(D.timer); D.timer = null; } }
  function resumePolling() { if (D && !D.paused && !document.hidden && !D.inflight) checkDraft(); }

  function onDraftMeta(meta) {
    var rev = meta.work.revision;
    if (rev < D.latest) { draftLog({ t: "stale", revision: rev, latest: D.latest }); return; }   // never go backwards
    D.latest = rev; D.latestWork = meta.work; D.snaps[rev] = meta.work;
    var by = {};
    D.revisions.concat(meta.revisions).forEach(function (r) { by[r.revision] = r; });
    D.revisions = Object.keys(by).map(function (k) { return by[k]; }).sort(function (a, b) { return a.revision - b.revision; });
    D.status = meta.status; D.completedWorkId = meta.completedWorkId;
    if (!D.started) return showFirstDraft();
    renderDraft();
    return reconcileDraft();
  }
  function decide() {
    return draftDecision({
      latest: D.latest, viewing: D.viewing, follow: D.follow, state: S.state, continuing: !!S.nextTimer,
      edited: hasEdits(), busy: D.applying != null || D.confirm != null || $("pl-sheet").getAttribute("aria-busy") === "true"
    });
  }
  function reconcileDraft() {
    var action = decide();
    if (action !== "none") draftLog({ t: "decide", revision: D.latest, viewing: D.viewing, state: S.state, edited: hasEdits(), action: action });
    if (action === "apply") return applySnapshot(D.latest, { auto: true });
    renderOffer();
  }

  function showFirstDraft() {
    var latest = D.latestWork, pinNote = D.badPin ? "That revision number is not valid, so this is the latest revision." : "";
    var p = D.pin ? getSnapshot(D.pin).catch(function (err) {
      pinNote = "Revision " + D.pin + " could not be opened (" + errText(err) + "), so this is the latest revision.";
      D.pin = null; D.follow = true;
      return latest;
    }) : Promise.resolve(latest);
    return p.then(function (work) {
      var idx = 0;
      work.movements.forEach(function (m, i) { if (m.id === D.want) idx = i; });
      var opened = commitSnapshot(work, idx, null, { first: true });
      if (pinNote) showDraftMsg(pinNote, null);
      return opened;
    });
  }
  function getSnapshot(rev) {
    if (D.snaps[rev]) return Promise.resolve(D.snaps[rev]);
    return fetchDraftJson(draftApiPath(D.id, rev)).then(function (json) {
      var work = validateDraftManifest(json && json.work, D.id, rev);
      D.snaps[rev] = work;
      return work;
    });
  }

  // Load and check revision `rev` completely before anything on screen changes. A newer
  // request (token) wins; failures leave the current take exactly as it was.
  function applySnapshot(rev, opts) {
    var token = ++D.token, cur = S.movements[S.current], prevId = cur ? cur.id : D.want, prevLabel = cur ? cur.label : "", target = null;
    D.applying = rev;
    renderOffer();
    draftLog({ t: "load", revision: rev, auto: !!opts.auto });
    return getSnapshot(rev).then(function (work) {
      if (token !== D.token) return null;
      var idx = -1;
      work.movements.forEach(function (m, i) { if (m.id === prevId) idx = i; });
      target = { work: work, idx: idx < 0 ? 0 : idx, fallback: idx < 0 && !!prevLabel };
      var m = work.movements[target.idx];
      return fetchAbc(m.source, m.label);
    }).then(function (text) {
      if (token !== D.token) { draftLog({ t: "superseded", revision: rev }); return false; }
      if (!abcParses(text)) throw new Error("its score could not be read");
      D.applying = null;
      if (opts.auto && decide() !== "apply") { draftLog({ t: "deferred", revision: rev, state: S.state }); renderOffer(); return false; }
      commitSnapshot(target.work, target.idx, text, { auto: opts.auto, bar: opts.bar, fallbackFrom: target.fallback ? prevLabel : null });
      return true;
    }).catch(function (err) {
      if (token !== D.token) return false;
      D.applying = null;
      draftLog({ t: "loadfail", revision: rev, error: errText(err) });
      showDraftMsg("Revision " + rev + " could not be loaded (" + errText(err) + "). Still showing revision " + D.viewing + ".",
        opts.auto ? null : function () { switchTo(rev, { bar: opts.bar }); });
      renderOffer();
      return false;
    });
  }

  function commitSnapshot(work, idx, text, opts) {
    // Automatic updates keep the reader's place; one already at the bottom follows the new
    // bottom so freshly appended bars come into view. Explicit switches start at the top.
    var sheet = $("pl-sheet"), keepTop = sheet.scrollTop, atBottom = keepTop > 0 && keepTop + sheet.clientHeight >= sheet.scrollHeight - 8;
    stopAll(null);
    clearDraftMsg();
    D.work = work; D.viewing = work.revision; D.snaps[work.revision] = work; D.confirm = null;
    S.info = { work: work, composer: catalogEntry("composers", work.composerId), form: catalogEntry("forms", work.formId) };
    S.movements = work.movements.map(function (m) {
      return { id: m.id, label: m.label, note: m.note, source: m.source, durationSeconds: m.durationSeconds, bars: m.bars };
    });
    S.sources = {};
    if (text != null) S.sources[idx] = text;
    S.edited = {}; $("pl-edited").hidden = true;
    S.current = -1; S.pendingSeek = null;
    buildPage(S.info);
    D.started = true;
    $("pl-waiting").hidden = true;
    renderDraft();
    updateDraftUrl();
    draftLog({ t: "applied", revision: work.revision, movement: work.movements[idx].id, auto: !!opts.auto, first: !!opts.first });
    var p = openMovement(idx);
    if (opts.fallbackFrom) showDraftMsg("\u201c" + opts.fallbackFrom + "\u201d is not in revision " + work.revision + ", so this is \u201c" + work.movements[idx].label + "\u201d.", null);
    return p.then(function (ok) {
      if (ok && opts.auto) sheet.scrollTo({ top: atBottom ? sheet.scrollHeight : keepTop, behavior: "instant" });
      if (!ok || opts.first) return ok;
      if (opts.bar != null) goToBar(opts.bar);
      else setStatus((opts.auto ? "Updated to revision " : "Revision ") + work.revision + ". Press play to listen.");
      return ok;
    });
  }

  function switchTo(rev, opts) {
    if (opts.follow != null) D.follow = opts.follow;
    $("pl-follow").checked = D.follow;
    D.confirm = null;
    clearDraftMsg();
    if (S.state !== "idle" || S.nextTimer) stopAll("Stopped. Opening revision " + rev + "\u2026");
    updateDraftUrl();
    return applySnapshot(rev, { auto: false, bar: opts.bar });
  }

  function updateDraftUrl() {
    var p = new URLSearchParams(location.search);
    p.set("draft", D.id);
    if (D.follow || !D.viewing) p.delete("revision"); else p.set("revision", String(D.viewing));
    try { history.replaceState(history.state, "", location.pathname + "?" + p.toString() + location.hash); } catch (e) { }
  }

  /* bars */
  function currentBarMap() {
    if (S.barInfo === undefined) {
      S.barInfo = null;
      try {
        var t = S.visualObj && S.visualObj.setTiming ? S.visualObj.setTiming() : null;
        S.barInfo = barMap((S.visualObj && S.visualObj.noteTimings) || t);
      } catch (e) { S.barInfo = null; }
    }
    return S.barInfo;
  }
  // Seek to the start of a written bar, using abcjs's own note timings (tempo changes and
  // repeats included). With repeats, the first time through the bar is used.
  function goToBar(n) {
    var map = currentBarMap(), t = barSeek(map, +n);
    if (!t) { setStatus("Bar positions are not available for this score. Click a note to start there."); return null; }
    seekTo(t.fraction);
    setStatus((t.clamped ? "This movement has " + map.count + " bars. " : "") + (S.state === "playing" ? "Jumped to bar " : "Will start at bar ") + t.bar + (t.repeats ? " (first time through)" : "") + ".");
    return t;
  }
  function afterDraftMovement() {
    var map = currentBarMap();
    $("pl-goto").hidden = !map;
    if (map) $("pl-bar-of").textContent = "of " + map.count;     // no max attribute: larger numbers are clamped, not refused
    renderOffer();
  }

  /* rendering */
  function renderDraft() {
    var w = D.work, c = S.info && S.info.composer, f = S.info && S.info.form;
    $("pl-draft").hidden = false;
    $("pl-stop").hidden = false;
    document.title = "Draft: " + w.title + " \u2014 Missing Works";
    $("pl-kicker").textContent = ["Live draft", c ? "After " + c.name : "", f ? f.label : ""].filter(Boolean).join(" \u00b7 ");
    $("pl-crumb-work").textContent = w.title + " (draft)";
    $("pl-draft-rev").textContent = "Revision " + w.revision + (D.viewing === D.latest ? " \u00b7 latest" : " of " + D.latest);
    var t = $("pl-draft-time");
    t.textContent = w.publishedAt ? "published " + fmtWhen(w.publishedAt) : "";
    if (w.publishedAt) t.setAttribute("datetime", w.publishedAt); else t.removeAttribute("datetime");
    $("pl-draft-note").textContent = w.changeNote;
    $("pl-draft-note").hidden = !w.changeNote;
    var st = $("pl-draft-state");
    st.dataset.status = D.status || "";
    st.textContent = D.status === "completed" ? "Composition finished" : D.status === "open" ? "Paused \u2014 not being composed right now" : "Being composed now";
    var done = D.status === "completed" && D.completedWorkId;
    $("pl-draft-done").hidden = !done;
    if (done) $("pl-draft-final").href = "work.html?id=" + encodeURIComponent(D.completedWorkId);
    var key = D.revisions.map(function (r) { return r.revision; }).join(",") + "|" + D.latest;
    var sel = $("pl-revision");
    if (key !== D.optionsKey) {
      D.optionsKey = key;
      sel.textContent = "";
      D.revisions.slice().reverse().forEach(function (r) {
        var o = el("option", { value: String(r.revision) }, "Revision " + r.revision + (r.revision === D.latest ? " (latest)" : "") + (r.publishedAt ? " \u2014 " + fmtWhen(r.publishedAt) : ""));
        if (r.changeNote) o.title = r.changeNote;
        sel.appendChild(o);
      });
    }
    sel.value = String(D.viewing);
    $("pl-follow").checked = D.follow;
    renderOffer();
  }
  function renderOffer() {
    var box = $("pl-update");
    if (!D || !D.started) { box.hidden = true; return; }
    var keep = $("pl-keep"), barWrap = $("pl-update-bar-wrap"), btn = $("pl-switch"), live = $("pl-update-text");
    // A live region: write only real changes, so state changes do not re-announce it.
    var say = function (v) { if (live.textContent !== v) live.textContent = v; };
    keep.hidden = true; barWrap.hidden = true; btn.hidden = false;
    if (D.confirm != null) {
      say("Opening revision " + D.confirm + " discards your edits to this movement.");
      btn.textContent = "Discard my edits and open revision " + D.confirm;
      keep.hidden = false; box.hidden = false; box.dataset.kind = "confirm";
      return;
    }
    if (D.applying != null) {
      say("Loading revision " + D.applying + "\u2026");
      btn.hidden = true; box.hidden = false; box.dataset.kind = "loading";
      return;
    }
    if (!(D.latest > D.viewing)) { box.hidden = true; box.dataset.kind = ""; return; }
    var cur = S.movements[S.current], lm = null, edited = hasEdits();
    if (cur && D.latestWork) D.latestWork.movements.forEach(function (m) { if (m.id === cur.id) lm = m; });
    var grew = lm && cur && lm.bars != null && cur.bars != null && lm.bars !== cur.bars ? " This movement has " + lm.bars + " bars there (" + cur.bars + " here)." : "";
    var why = !D.follow ? "" : S.state !== "idle" || S.nextTimer ? " This take stays as it is until you switch or stop." : edited ? " Your edits stay until you switch." : "";
    say((D.follow ? "Revision " + D.latest + " is ready." : "You are on revision " + D.viewing + "; the latest is revision " + D.latest + ".") + grew + why);
    btn.textContent = edited ? "Discard my edits and switch to revision " + D.latest : D.follow ? "Switch to revision " + D.latest : "Back to latest (revision " + D.latest + ")";
    barWrap.hidden = false;
    $("pl-update-bar").max = lm && lm.bars ? lm.bars : "";
    box.hidden = false; box.dataset.kind = D.follow ? "offer" : "newer";
  }
  function renderConn() {
    var box = $("pl-conn");
    if (!D.started || !D.failures) { box.hidden = true; return; }
    $("pl-conn-text").textContent = "Can\u2019t reach the draft service (" + D.lastError + "). Still on revision " + D.viewing + "; it keeps playing. Next check in " + Math.round(D.nextDelay / 1000) + " s.";
    box.hidden = false;
  }
  function showDraftMsg(msg, retry) {
    D.msgRetry = retry;
    $("pl-draft-msg-text").textContent = msg;
    $("pl-draft-msg-retry").hidden = !retry;
    $("pl-draft-msg").hidden = false;
  }
  function clearDraftMsg() { if (D) D.msgRetry = null; $("pl-draft-msg").hidden = true; }

  function wireDraft() {
    $("pl-waiting-retry").onclick = function () { checkDraft(); };
    $("pl-conn-retry").addEventListener("click", function () { checkDraft(); });
    $("pl-draft-msg-retry").addEventListener("click", function () { var r = D.msgRetry; clearDraftMsg(); if (r) r(); });
    $("pl-draft-msg-close").addEventListener("click", clearDraftMsg);
    $("pl-revision").addEventListener("change", function () {
      var r = +this.value;
      this.value = String(D.viewing);          // shows the take actually on screen until it changes
      if (!validRevision(r) || r === D.viewing) return;
      var follow = r === D.latest ? D.follow : false;
      if (hasEdits()) { D.confirm = r; D.confirmFollow = follow; renderOffer(); return; }
      switchTo(r, { follow: follow });
    });
    $("pl-follow").addEventListener("change", function () {
      D.follow = this.checked;
      updateDraftUrl();
      if (D.follow) reconcileDraft(); else renderOffer();
    });
    $("pl-switch").addEventListener("click", function () {
      if (D.confirm != null) { var r = D.confirm; switchTo(r, { follow: D.confirmFollow }); return; }
      if (!(D.latest > D.viewing)) return;
      var v = $("pl-update-bar").value.trim(), bar = /^[0-9]{1,6}$/.test(v) && +v >= 1 ? +v : null;
      switchTo(D.latest, { follow: true, bar: bar });
    });
    $("pl-keep").addEventListener("click", function () { D.confirm = null; renderOffer(); });
    // Stop (draft only): silence the take without autoplay; a queued revision then follows
    // the usual rule (applied only when following latest and the source is unedited).
    $("pl-stop").addEventListener("click", function () {
      stopAll("Stopped.");
      $("pl-stop").disabled = true;
      reconcileDraft();
    });
    $("pl-goto").addEventListener("submit", function (e) {
      e.preventDefault();
      var v = $("pl-bar").value.trim();
      if (!/^[0-9]{1,6}$/.test(v) || +v < 1) { setStatus("Type a bar number, 1 or more."); return; }
      goToBar(+v);
    });
    $("pl-abc").addEventListener("input", function () { renderOffer(); });
    $("pl-reset").addEventListener("click", function () { renderOffer(); });
    document.addEventListener("visibilitychange", function () { if (document.hidden) pausePolling(); else resumePolling(); });
    window.addEventListener("pagehide", function () { D.paused = true; pausePolling(); });
    window.addEventListener("pageshow", function () { if (!D.paused) return; D.paused = false; resumePolling(); });
  }

  function draftState() {
    if (!D) return null;
    var cur = S.movements[S.current];
    return {
      id: D.id, viewing: D.viewing, latest: D.latest, follow: D.follow, status: D.status, completedWorkId: D.completedWorkId,
      started: D.started, polls: D.polls, failures: D.failures, nextDelay: D.nextDelay, inflight: !!D.inflight, timer: !!D.timer,
      applying: D.applying, confirm: D.confirm, edited: hasEdits(), movement: cur ? cur.id : null,
      bars: S.movements.map(function (m) { return m.bars; }), revisions: D.revisions.map(function (r) { return r.revision; }),
      offer: !$("pl-update").hidden && $("pl-update").dataset.kind, conn: !$("pl-conn").hidden, log: D.log.slice()
    };
  }

  function start() {
    var params = new URLSearchParams(location.search);
    var id = params.get("id") || "";
    var catalogPath = catalogPathFrom(params.get("catalog"));
    if (!catalogPath) { notFound("That catalogue is not available", "The page address points at a catalogue file this player will not read.", null); return; }
    if (params.has("draft")) { startDraft(params, catalogPath); return; }
    var load = function () {
      $("pl-loading").textContent = "Loading the catalogue\u2026";
      return fetch(catalogPath, { cache: "no-cache" }).then(function (r) {
        if (!r.ok) throw new Error("HTTP " + r.status);
        return r.json();
      });
    };
    load().then(function (catalog) {
      S.catalog = catalog;
      if (!id) { notFound("Choose a work", "This address does not name a work. Pick one below or browse the library.", catalog); return; }
      var info = findWork(catalog, id);
      if (!info) { notFound("We could not find that work", "There is no completed work called \u201c" + id.slice(0, 80) + "\u201d in the catalogue. It may not have been composed yet.", catalog); return; }
      S.info = info;
      S.movements = info.work.movements.map(function (m, i) {
        return { id: String(m.id || i + 1), label: String(m.label || "Movement " + (i + 1)), note: m.note ? String(m.note) : "", source: m.source, durationSeconds: +m.durationSeconds || 0 };
      });
      if (!window.ABCJS || !ABCJS.renderAbc) {
        buildPage(info);
        showError("The notation library did not load, so the score cannot be shown. Check the connection and reload.", function () { location.reload(); });
        $("pl-play").disabled = true;
        return;
      }
      buildPage(info);
      wire();
      var want = params.get("movement"), start = 0;
      S.movements.forEach(function (m, i) { if (m.id === want) start = i; });
      openMovement(start);
    }).catch(function (err) {
      $("pl-loading").hidden = false;
      $("pl-loading").textContent = "";
      var p = el("p", { class: "status-note error", role: "alert" }, "Could not load the catalogue (" + (err && err.message ? err.message : err) + "). ");
      var b = el("button", { type: "button", class: "secondary-button" }, "Try again");
      b.addEventListener("click", function () { location.reload(); });
      p.appendChild(b);
      $("pl-loading").appendChild(p);
    });
  }

  // Test and debugging hooks.
  window.mwPlayer = {
    state: function () { return S.state; }, synth: function () { return S.synth; }, gen: function () { return S.gen; },
    parts: function () { return S.parts.map(function (p, i) { return { label: p.label, program: p.program, on: S.partsOn[i] }; }); },
    current: function () { return S.current; }, peak: function () { return S.lastPeak; },
    audioParams: function () { return audioParams(); }, midiBytes: function () { return Array.prototype.slice.call(midiBytes(), 0, 14); },
    seek: seekTo, stop: function () { stopAll("Stopped."); },
    // live drafts
    revision: function () { return D ? D.viewing : null; }, draft: draftState,
    checkDraft: function () { return D ? checkDraft() : Promise.resolve(null); },
    goToBar: function (n) { return D ? goToBar(n) : null; }, bars: function () { return D ? currentBarMap() : null; }
  };

  if (document.querySelector("[data-mw-player]")) {
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start); else start();
  }
})(typeof window !== "undefined" ? window : this);
