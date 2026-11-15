// Draft validation: publish payload shape and structural ABC checks.
// Uses the vendored abcjs 6.5.2 parser (parseOnly, no DOM). This checks syntax,
// bar arithmetic, voice alignment and timing. It is not a judgement of the music.
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { REQUEST_ID_RE } from './db.mjs';

const require = createRequire(import.meta.url);
// Loaded on first use so the HTTP server (which only reads drafts) never loads the parser.
let abcjs = null;
const parser = () => (abcjs ||= require('./vendor/abcjs.cjs'));

export const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const LIMITS = Object.freeze({
  payloadBytes: 2 * 1024 * 1024,
  movements: 16,
  abcBytes: 1024 * 1024,
  workIdLength: 80,
  movementIdLength: 40,
  title: 200,
  subtitle: 200,
  description: 2000,
  changeNote: 500,
  label: 200,
  note: 1000,
  maxRevision: 999_999_999,
  maxErrors: 20,
});

export class DraftError extends Error {
  constructor(code, message, details) {
    super(message);
    this.code = code;
    if (details && details.length) this.details = details.slice(0, LIMITS.maxErrors);
  }
}

// ---------- payload ----------

const PAYLOAD_KEYS = new Set(['id', 'requestId', 'title', 'subtitle', 'description', 'changeNote', 'expectedRevision', 'movements']);
const MOVEMENT_KEYS = new Set(['id', 'label', 'note', 'abc']);
// C0/C1 controls except tab and newline (newline only where multiline is allowed).
const CONTROL_ONE_LINE = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;
const CONTROL_MULTI_LINE = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u2028\u2029]/;

function text(obj, key, { max, required = false, multiline = false, where }) {
  const v = obj[key];
  if (v === undefined || v === null) {
    if (required) throw new DraftError('invalid_payload', `${where}${key} is required`);
    return '';
  }
  if (typeof v !== 'string') throw new DraftError('invalid_payload', `${where}${key} must be a string`);
  const s = v.replace(/\r\n?/g, '\n').trim();
  if (required && !s) throw new DraftError('invalid_payload', `${where}${key} must not be empty`);
  if ([...s].length > max) throw new DraftError('invalid_payload', `${where}${key} must be at most ${max} characters`);
  if ((multiline ? CONTROL_MULTI_LINE : CONTROL_ONE_LINE).test(s)) {
    throw new DraftError('invalid_payload', `${where}${key} contains control characters`);
  }
  return s;
}

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

// Parses the raw stdin bytes (Buffer). Enforces UTF-8 and the aggregate size limit.
export function parsePayloadBytes(buf) {
  if (buf.length > LIMITS.payloadBytes) {
    throw new DraftError('payload_too_large', `Payload must be at most ${LIMITS.payloadBytes} bytes`);
  }
  let value;
  try {
    value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(buf));
  } catch {
    throw new DraftError('invalid_json', 'Payload must be valid UTF-8 JSON');
  }
  return value;
}

// Checks shape and limits; returns a normalised payload. Does not parse ABC.
export function validatePayloadShape(p) {
  if (!isPlainObject(p)) throw new DraftError('invalid_payload', 'Payload must be a JSON object');
  for (const k of Object.keys(p)) {
    if (!PAYLOAD_KEYS.has(k)) throw new DraftError('invalid_payload', `Unknown payload field: ${String(k).slice(0, 40)}`);
  }
  if (typeof p.id !== 'string' || p.id.length > LIMITS.workIdLength || !SLUG_RE.test(p.id)) {
    throw new DraftError('invalid_payload', `id must be a lowercase slug of at most ${LIMITS.workIdLength} characters`);
  }
  if (typeof p.requestId !== 'string' || p.requestId.length > 100 || !REQUEST_ID_RE.test(p.requestId)) {
    throw new DraftError('invalid_payload', 'requestId must look like composer:form:round');
  }
  let expectedRevision = null;
  if (p.expectedRevision !== undefined && p.expectedRevision !== null) {
    if (!Number.isSafeInteger(p.expectedRevision) || p.expectedRevision < 0 || p.expectedRevision > LIMITS.maxRevision) {
      throw new DraftError('invalid_payload', 'expectedRevision must be a non-negative integer (0 = no draft yet)');
    }
    expectedRevision = p.expectedRevision;
  }
  const out = {
    id: p.id,
    requestId: p.requestId,
    title: text(p, 'title', { max: LIMITS.title, required: true, where: '' }),
    subtitle: text(p, 'subtitle', { max: LIMITS.subtitle, where: '' }),
    description: text(p, 'description', { max: LIMITS.description, multiline: true, where: '' }),
    changeNote: text(p, 'changeNote', { max: LIMITS.changeNote, required: true, multiline: true, where: '' }),
    expectedRevision,
    movements: [],
  };
  if (!Array.isArray(p.movements) || p.movements.length < 1) {
    throw new DraftError('invalid_payload', 'movements must be a non-empty array');
  }
  if (p.movements.length > LIMITS.movements) {
    throw new DraftError('invalid_payload', `At most ${LIMITS.movements} movements`);
  }
  const seen = new Set();
  p.movements.forEach((m, i) => {
    const where = `movements[${i}].`;
    if (!isPlainObject(m)) throw new DraftError('invalid_payload', `movements[${i}] must be an object`);
    for (const k of Object.keys(m)) {
      if (!MOVEMENT_KEYS.has(k)) throw new DraftError('invalid_payload', `Unknown field ${where}${String(k).slice(0, 40)}`);
    }
    if (typeof m.id !== 'string' || m.id.length > LIMITS.movementIdLength || !SLUG_RE.test(m.id)) {
      throw new DraftError('invalid_payload', `${where}id must be a lowercase slug of at most ${LIMITS.movementIdLength} characters`);
    }
    if (seen.has(m.id)) throw new DraftError('invalid_payload', `Duplicate movement id: ${m.id}`);
    seen.add(m.id);
    if (typeof m.abc !== 'string' || !m.abc.trim()) throw new DraftError('invalid_payload', `${where}abc must be a non-empty string`);
    if (Buffer.byteLength(m.abc, 'utf8') > LIMITS.abcBytes) {
      throw new DraftError('invalid_payload', `${where}abc must be at most ${LIMITS.abcBytes} bytes`);
    }
    if (/[\u0000\ufffd]/.test(m.abc)) throw new DraftError('invalid_payload', `${where}abc contains NUL or invalid characters`);
    out.movements.push({
      id: m.id,
      label: text(m, 'label', { max: LIMITS.label, required: true, where }),
      note: text(m, 'note', { max: LIMITS.note, multiline: true, where }),
      abc: m.abc,
    });
  });
  return out;
}

// ---------- exact fractions ----------

function gcd(a, b) {
  a = Math.abs(a); b = Math.abs(b);
  while (b) [a, b] = [b, a % b];
  return a || 1;
}
const frac = (n, d) => { const g = gcd(n, d); return d < 0 ? [-n / g, -d / g] : [n / g, d / g]; };
const add = (a, b) => frac(a[0] * b[1] + b[0] * a[1], a[1] * b[1]);
const mul = (a, b) => frac(a[0] * b[0], a[1] * b[1]);
const sub = (a, b) => add(a, [-b[0], b[1]]);
const eq = (a, b) => a[0] === b[0] && a[1] === b[1];
const lt = (a, b) => a[0] * b[1] < b[0] * a[1];
const ZERO = [0, 1];
const fmt = (f) => (f[1] === 1 ? String(f[0]) : `${f[0]}/${f[1]}`);

// abcjs stores durations as floats in whole notes. Recover the exact fraction;
// refuse anything that is not a small rational rather than guess.
function toFrac(x) {
  if (!Number.isFinite(x) || x < 0) return null;
  let [h0, h1, k0, k1] = [0, 1, 1, 0];
  let v = x;
  for (let i = 0; i < 40; i++) {
    const a = Math.floor(v);
    [h0, h1] = [h1, a * h1 + h0];
    [k0, k1] = [k1, a * k1 + k0];
    if (k1 > 1_000_000) return null;
    if (Math.abs(h1 / k1 - x) <= 1e-9 * Math.max(1, x)) return frac(h1, k1);
    const r = v - a;
    if (r < 1e-12) break;
    v = 1 / r;
  }
  return Math.abs(h1 / k1 - x) <= 1e-9 * Math.max(1, x) ? frac(h1, k1) : null;
}

function meterLength(meter) {
  if (!meter) return null;
  if (meter.type === 'common_time') return [1, 1];
  if (meter.type === 'cut_time') return [1, 1];
  if (meter.type !== 'specified' || !Array.isArray(meter.value) || meter.value.length !== 1) {
    throw new DraftError('unsupported_meter', `Unsupported meter${meter.type ? ` (${meter.type})` : ''}: use one simple or additive meter such as M:3/4 or M:2+3/8`);
  }
  const { num, den } = meter.value[0];
  if (!/^\d{1,2}(\+\d{1,2}){0,5}$/.test(String(num)) || !/^\d{1,2}$/.test(String(den))) {
    throw new DraftError('unsupported_meter', `Unsupported meter ${num}/${den}`);
  }
  const n = String(num).split('+').reduce((s, x) => s + Number(x), 0);
  const d = Number(den);
  if (n < 1 || d < 1 || (d & (d - 1)) !== 0) throw new DraftError('unsupported_meter', `Unsupported meter ${num}/${den}`);
  return frac(n, d);
}

const SECTION_BARS = new Set(['bar_thin_thin', 'bar_thin_thick', 'bar_thick_thin', 'bar_right_repeat', 'bar_dbl_repeat']);

// Project metadata lines (%%label, %%note) are not abcjs directives: blank them,
// keeping offsets, exactly as the player does.
export function blankProjectMetadata(abc) {
  return abc.replace(/^%%(label|note)\b.*$/gm, (line) => '%' + ' '.repeat(line.length - 1));
}

function plainWarning(w) {
  return String(w).replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim().slice(0, 300);
}

// Splits one voice (concatenated over all lines) into measures.
function measuresOf(voiceKey, segments, initialMeters) {
  const measures = [];
  let barLen = initialMeters;
  let cur = null;
  let tripletMult = null;
  let hasNotes = false;
  const startMeasure = () => { cur = { dur: ZERO, barLen, multi: 0, startBar: null }; };
  let lastBarType = null;
  startMeasure();
  for (const seg of segments) {
    if (seg.meter) {
      if (!eq(cur.dur, ZERO)) throw new DraftError('invalid_bars', `${voiceKey}: meter change in the middle of bar ${measures.length + 1}`);
      barLen = meterLength(seg.meter);
      cur.barLen = barLen;
    }
    for (const el of seg.elements) {
      if (el.el_type === 'meter') {
        if (!eq(cur.dur, ZERO)) throw new DraftError('invalid_bars', `${voiceKey}: meter change in the middle of bar ${measures.length + 1}`);
        barLen = meterLength(el);
        cur.barLen = barLen;
        continue;
      }
      if (el.el_type === 'bar') {
        if (!eq(cur.dur, ZERO) || cur.multi) {
          cur.endBar = el.type;
          cur.startBar = lastBarType;
          measures.push(cur);
        }
        lastBarType = el.type;
        startMeasure();
        continue;
      }
      if (el.el_type !== 'note' || typeof el.duration !== 'number') continue;
      if (el.rest && el.rest.type === 'spacer') continue;
      if (el.startTriplet) {
        const m = toFrac(el.tripletMultiplier);
        if (!m) throw new DraftError('invalid_bars', `${voiceKey}: unsupported tuplet ratio`);
        tripletMult = m;
      }
      if (el.rest && el.rest.type && el.rest.type.includes('multimeasure')) {
        const n = Number(el.rest.text);
        if (!Number.isSafeInteger(n) || n < 1 || !eq(cur.dur, ZERO) || cur.multi) {
          throw new DraftError('invalid_bars', `${voiceKey}: a multi-bar rest (Z/X) must stand alone in its bar`);
        }
        const d = toFrac(el.duration);
        if (!d || !eq(d, mul(barLen, [n, 1]))) {
          throw new DraftError('unsupported_construct', `${voiceKey}: multi-bar rest after a meter change is timed incorrectly by abcjs; write whole-bar rests instead`);
        }
        cur.multi = n;
        continue;
      }
      if (cur.multi) throw new DraftError('invalid_bars', `${voiceKey}: a multi-bar rest (Z/X) must stand alone in its bar`);
      let d = toFrac(el.duration);
      if (!d) throw new DraftError('invalid_bars', `${voiceKey}: unsupported note length`);
      if (tripletMult) d = mul(d, tripletMult);
      if (el.endTriplet) tripletMult = null;
      if (!el.rest) hasNotes = true;
      cur.dur = add(cur.dur, d);
    }
  }
  if (tripletMult) throw new DraftError('invalid_bars', `${voiceKey}: a tuplet is not completed`);
  if (!eq(cur.dur, ZERO) || cur.multi) {
    cur.endBar = null;
    cur.startBar = lastBarType;
    measures.push(cur);
  }
  return { measures, hasNotes };
}

// Classifies measures: full, initial/section pickup (anacrusis) or the bar that
// completes a pickup at a section end. Anything else short or long is an error.
function checkMeasures(voiceKey, measures) {
  let pickup = null;
  const kinds = [];
  let bars = 0;
  measures.forEach((m, i) => {
    const where = `${voiceKey}, bar ${i + 1}`;
    if (m.multi) {
      kinds.push(`Z${m.multi}`);
      bars += m.multi;
      return;
    }
    if (eq(m.dur, m.barLen)) { kinds.push('full'); bars++; return; }
    if (!lt(m.dur, m.barLen)) {
      throw new DraftError('invalid_bars', `${where} is too long: ${fmt(m.dur)} of a whole note in a ${fmt(m.barLen)} bar`);
    }
    const afterSection = i === 0 || SECTION_BARS.has(m.startBar) || m.startBar === 'bar_left_repeat';
    // A short bar that ends a section (||, |], :|, ::) completes the latest pickup.
    if (pickup && SECTION_BARS.has(m.endBar) && eq(add(m.dur, pickup), m.barLen)) {
      kinds.push(`complement:${fmt(m.dur)}`);
      bars++;
      return;
    }
    // Pickup (anacrusis): the first bar, or the bar right after a section barline,
    // closed by a bar line and followed by more music. Not counted as a bar.
    if (afterSection && m.endBar !== null && i < measures.length - 1) {
      pickup = m.dur;
      kinds.push(`pickup:${fmt(m.dur)}`);
      return;
    }
    const tail = i === measures.length - 1 && m.endBar === null ? ' (unfinished final bar)' : '';
    throw new DraftError('invalid_bars', `${where} is incomplete${tail}: ${fmt(m.dur)} of a whole note in a ${fmt(m.barLen)} bar (missing ${fmt(sub(m.barLen, m.dur))})`);
  });
  return { kinds, bars };
}

// Validates one movement's ABC. Returns { bars, durationSeconds, sha256, voices }.
// Throws DraftError with details on any problem.
export function analyzeAbc(abc, { label = 'score' } = {}) {
  if (typeof abc !== 'string' || !abc.trim()) throw new DraftError('invalid_abc', `${label}: ABC is empty`);
  const sha256 = createHash('sha256').update(abc, 'utf8').digest('hex');
  const source = blankProjectMetadata(abc);
  // abcjs drops M:none silently; we cannot check bars without a meter.
  if (/(^|\[)\s*M:\s*none\b/im.test(source)) {
    throw new DraftError('unsupported_meter', `${label}: M:none (free meter) is not supported; bars cannot be checked`);
  }
  let tunes;
  try {
    tunes = parser().parseOnly(source);
  } catch {
    throw new DraftError('invalid_abc', `${label}: the ABC parser failed on this score`);
  }
  if (!Array.isArray(tunes) || tunes.length !== 1) {
    throw new DraftError('invalid_abc', `${label}: expected exactly one tune (one X: header), found ${Array.isArray(tunes) ? tunes.length : 0}`);
  }
  const tune = tunes[0];
  if (tune.warnings && tune.warnings.length) {
    throw new DraftError('abc_warnings', `${label}: the ABC parser reported ${tune.warnings.length} problem(s)`, tune.warnings.map(plainWarning));
  }
  // Collect voices by (staff index, voice index) across all systems.
  const voices = new Map();
  let staffMeters = [];
  for (const line of tune.lines || []) {
    if (!line.staff) continue;
    line.staff.forEach((staff, si) => {
      if (staff.meter) staffMeters[si] = staff.meter;
      (staff.voices || []).forEach((elements, vi) => {
        const key = `${si}:${vi}`;
        if (!voices.has(key)) {
          const meter = staffMeters[si] || null;
          if (!meter) throw new DraftError('unsupported_meter', `${label}: a meter (M: field) is required`);
          voices.set(key, { initial: meter, segments: [] });
          voices.get(key).segments.push({ meter: null, elements });
        } else {
          voices.get(key).segments.push({ meter: staff.meter || null, elements });
        }
      });
    });
  }
  if (!voices.size) throw new DraftError('invalid_abc', `${label}: no music found`);
  const results = [];
  let anyNotes = false;
  let n = 0;
  for (const [, v] of voices) {
    n++;
    const voiceKey = `${label}: voice ${n}`;
    const { measures, hasNotes } = measuresOf(voiceKey, v.segments, meterLength(v.initial));
    anyNotes ||= hasNotes;
    const checked = checkMeasures(voiceKey, measures);
    results.push({ voiceKey, measures, ...checked });
  }
  if (!anyNotes) throw new DraftError('invalid_abc', `${label}: the score has no notes`);
  const ref = results[0];
  if (!ref.measures.length) throw new DraftError('invalid_abc', `${label}: no bars found`);
  for (const r of results.slice(1)) {
    if (r.bars !== ref.bars || r.kinds.length !== ref.kinds.length) {
      throw new DraftError('voices_misaligned', `${label}: voices have different lengths (voice 1 has ${ref.bars} bars, ${r.voiceKey.split(': ')[1]} has ${r.bars})`);
    }
    for (let i = 0; i < r.kinds.length; i++) {
      if (r.kinds[i] !== ref.kinds[i] || !eq(r.measures[i].barLen, ref.measures[i].barLen)) {
        throw new DraftError('voices_misaligned', `${label}: voice 1 and ${r.voiceKey.split(': ')[1]} disagree at bar ${i + 1} (${ref.kinds[i]} in ${fmt(ref.measures[i].barLen)} vs ${r.kinds[i]} in ${fmt(r.measures[i].barLen)})`);
      }
    }
  }
  // Duration exactly as the player computes it: abcjs's audio sequence (repeats
  // expanded, tempo changes applied) scaled by the opening tempo and beat.
  let seq;
  try {
    seq = tune.setUpAudio({});
  } catch {
    throw new DraftError('invalid_abc', `${label}: abcjs could not build an audio sequence`);
  }
  const beat = tune.getBeatLength();
  const total = Number(seq && seq.totalDuration);
  const tempo = Number(seq && seq.tempo);
  if (!(total > 0) || !(tempo > 0) || !(beat > 0)) throw new DraftError('invalid_abc', `${label}: the score has no playable duration`);
  const durationSeconds = Math.round((total * 60 / (tempo * beat)) * 10) / 10;
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0 || durationSeconds > 6 * 3600) {
    throw new DraftError('invalid_abc', `${label}: implausible duration`);
  }
  return {
    bars: ref.bars,
    durationSeconds,
    sha256,
    voices: results.length,
    pickup: ref.kinds[0].startsWith('pickup:') ? ref.kinds[0].slice(7) : null,
  };
}

// Full, lock-free validation of a parsed payload object: shape plus every movement.
// Collects all movement errors so the composer sees everything at once.
export function validatePayload(raw) {
  const p = validatePayloadShape(raw);
  const problems = [];
  const analyses = [];
  for (const m of p.movements) {
    try {
      analyses.push(analyzeAbc(m.abc, { label: `movement ${m.id}` }));
    } catch (err) {
      if (!(err instanceof DraftError)) throw err;
      problems.push(err.message, ...(err.details || []).map((d) => `  ${d}`));
      analyses.push(null);
    }
  }
  if (problems.length) throw new DraftError('invalid_score', 'Score validation failed', problems);
  p.movements = p.movements.map((m, i) => ({ ...m, ...analyses[i] }));
  return p;
}
