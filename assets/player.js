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

  var core = {
    BOWED: BOWED, isBowed: isBowed, shortNoteLift: shortNoteLift, validWorkId: validWorkId,
    safeRelativePath: safeRelativePath, resolveSameOrigin: resolveSameOrigin, catalogPathFrom: catalogPathFrom,
    findWork: findWork, fmtTime: fmtTime, field: field, normalizeKeyChanges: normalizeKeyChanges,
    blankTitles: blankTitles, blankMetaDirectives: blankMetaDirectives, voiceTitles: voiceTitles, trackProgram: trackProgram, partsFromTune: partsFromTune,
    panFor: panFor, applySound: applySound, isMidiHeader: isMidiHeader, normalizeChannels: normalizeChannels,
    runBounded: runBounded, createSynthLifecycle: createSynthLifecycle
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
    lastPeak: 0, retry: null
  };

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
    var m = S.movements[i];
    var url = resolveSameOrigin(m.source, location.href, [".abc"]);
    if (!url) return Promise.reject(new Error("the score path for \u201c" + m.label + "\u201d is not a local .abc file"));
    return fetch(url, { cache: "no-cache" }).then(function (r) {
      if (!r.ok) throw new Error("the score file did not load (HTTP " + r.status + ")");
      return r.text();
    }).then(function (t) { S.sources[i] = t; return t; });
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
      var li = el("li"), b = el("button", { type: "button", "aria-current": "false" });
      b.dataset.index = i;
      b.appendChild(el("span", { class: "pl-mv-label" }, m.label));
      if (m.durationSeconds) b.appendChild(el("span", { class: "pl-mv-time" }, fmtTime(m.durationSeconds)));
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

  function start() {
    var params = new URLSearchParams(location.search);
    var id = params.get("id") || "";
    var catalogPath = catalogPathFrom(params.get("catalog"));
    if (!catalogPath) { notFound("That catalogue is not available", "The page address points at a catalogue file this player will not read.", null); return; }
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
    seek: seekTo, stop: function () { stopAll("Stopped."); }
  };

  if (document.querySelector("[data-mw-player]")) {
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start); else start();
  }
})(typeof window !== "undefined" ? window : this);
