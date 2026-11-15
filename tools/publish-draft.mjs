#!/usr/bin/env node
// Publish a live draft snapshot to the VM over SSH. Reads a local descriptor and
// its .abc files, validates everything locally, then streams one JSON payload on
// SSH stdin to the fixed owner-only command. Metadata never reaches a shell.
import { readFileSync, lstatSync, realpathSync } from 'node:fs';
import { dirname, resolve, extname, isAbsolute } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DraftError, LIMITS, validatePayload } from '../server/draft-validation.mjs';

export const REMOTE_COMMAND = 'sudo -n -u missingworks /usr/local/bin/missing-works-draft publish';
export const DEFAULT_HOST = 'lost-compositions.exe.xyz';

export const HELP = `usage: node tools/publish-draft.mjs --manifest draft.json --message "what changed" [--expect N] [--host HOST] [--dry-run]

Publishes the next immutable revision of a live draft (Missing Works).

  --manifest PATH   descriptor JSON:
                      {"id": "work-slug", "requestId": "composer:form:round",
                       "title": "...", "subtitle": "...", "description": "...",
                       "movements": [{"id": "i", "label": "I. Allegro", "file": "i.abc", "note": "..."}]}
                    each "file" is a local .abc regular file, relative to the descriptor's directory
  --message TEXT    change note shown to listeners (required, <= ${LIMITS.changeNote} chars)
  --expect N        refuse unless the current latest revision is N (0 = first publication)
  --host HOST       SSH destination (default ${DEFAULT_HOST}; user@host allowed)
  --dry-run         validate locally and print the metadata/validation report; no SSH
  -h, --help        this text

The scores are checked with abcjs 6.5.2: one tune, no parser warnings, every bar
full and all voices aligned (a consistent pickup is allowed). This is a structural
check, not a judgement of the music. On the server the request must be "composing".
Remote command (fixed): ssh HOST ${REMOTE_COMMAND}
Exit codes follow the remote CLI: 0 ok, 1 rejected, 2 usage, 3 stale --expect, 4 busy.`;

const DESCRIPTOR_KEYS = new Set(['id', 'requestId', 'title', 'subtitle', 'description', 'movements']);
const MOVEMENT_KEYS = new Set(['id', 'label', 'file', 'note']);
const HOST_RE = /^(?:[A-Za-z0-9._-]{1,64}@)?[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$/;

export class UsageError extends Error {}

export function parseArgs(argv) {
  const o = { host: DEFAULT_HOST, expect: null, dryRun: false, manifest: null, message: null, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = () => {
      if (i + 1 >= argv.length) throw new UsageError(`${a} needs a value`);
      return argv[++i];
    };
    switch (a) {
      case '--manifest': o.manifest = val(); break;
      case '--message': o.message = val(); break;
      case '--expect': {
        const v = val();
        if (!/^(0|[1-9][0-9]{0,8})$/.test(v)) throw new UsageError('--expect must be a non-negative integer');
        o.expect = Number(v);
        break;
      }
      case '--host': o.host = val(); break;
      case '--dry-run': o.dryRun = true; break;
      case '-h': case '--help': o.help = true; break;
      default: throw new UsageError(`unknown argument: ${a}`);
    }
  }
  if (o.help) return o;
  if (!o.manifest) throw new UsageError('--manifest is required');
  if (o.message === null) throw new UsageError('--message is required');
  if (!HOST_RE.test(o.host)) throw new UsageError('--host must be a plain host name or user@host');
  return o;
}

function readRegularFile(path, maxBytes, what) {
  let st;
  try {
    st = lstatSync(path);
  } catch {
    throw new DraftError('missing_file', `${what} not found: ${path}`);
  }
  if (st.isSymbolicLink() || !st.isFile()) throw new DraftError('invalid_file', `${what} must be a regular file (not a link or directory): ${path}`);
  if (st.size > maxBytes) throw new DraftError('invalid_file', `${what} is larger than ${maxBytes} bytes: ${path}`);
  return readFileSync(path);
}

// Builds the publish payload from a descriptor file. Throws DraftError.
export function buildPayload({ manifest, message, expect = null }) {
  const descPath = resolve(manifest);
  let desc;
  try {
    desc = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(readRegularFile(descPath, 64 * 1024, 'descriptor')));
  } catch (err) {
    if (err instanceof DraftError) throw err;
    throw new DraftError('invalid_descriptor', 'Descriptor must be valid UTF-8 JSON');
  }
  if (!desc || typeof desc !== 'object' || Array.isArray(desc)) throw new DraftError('invalid_descriptor', 'Descriptor must be a JSON object');
  for (const k of Object.keys(desc)) if (!DESCRIPTOR_KEYS.has(k)) throw new DraftError('invalid_descriptor', `Unknown descriptor field: ${k}`);
  if (!Array.isArray(desc.movements)) throw new DraftError('invalid_descriptor', 'movements must be an array');
  const base = dirname(descPath);
  const movements = desc.movements.map((m, i) => {
    if (!m || typeof m !== 'object' || Array.isArray(m)) throw new DraftError('invalid_descriptor', `movements[${i}] must be an object`);
    for (const k of Object.keys(m)) if (!MOVEMENT_KEYS.has(k)) throw new DraftError('invalid_descriptor', `Unknown field movements[${i}].${k}`);
    if (typeof m.file !== 'string' || !m.file) throw new DraftError('invalid_descriptor', `movements[${i}].file is required`);
    if (/^[a-z][a-z0-9+.-]*:/i.test(m.file) && !isAbsolute(m.file)) throw new DraftError('invalid_descriptor', `movements[${i}].file must be a local path, not a URL`);
    if (extname(m.file).toLowerCase() !== '.abc') throw new DraftError('invalid_descriptor', `movements[${i}].file must be a .abc file`);
    const buf = readRegularFile(resolve(base, m.file), LIMITS.abcBytes, `movements[${i}].file`);
    let abc;
    try {
      abc = new TextDecoder('utf-8', { fatal: true }).decode(buf);
    } catch {
      throw new DraftError('invalid_file', `movements[${i}].file is not valid UTF-8`);
    }
    const out = { id: m.id, label: m.label, abc };
    if (m.note !== undefined) out.note = m.note;
    return out;
  });
  const payload = { id: desc.id, requestId: desc.requestId, title: desc.title, changeNote: message, movements };
  for (const k of ['subtitle', 'description']) if (desc[k] !== undefined) payload[k] = desc[k];
  if (expect !== null) payload.expectedRevision = expect;
  return payload;
}

export function report(validated, bytes) {
  const lines = [
    `draft      ${validated.id}  (request ${validated.requestId})`,
    `title      ${validated.title}${validated.subtitle ? ` — ${validated.subtitle}` : ''}`,
    `change     ${validated.changeNote.replace(/\n/g, ' ')}`,
    `expect     ${validated.expectedRevision === null ? '(any)' : validated.expectedRevision}`,
    `payload    ${bytes} bytes of ${LIMITS.payloadBytes}`,
    'movements:',
  ];
  for (const m of validated.movements) {
    lines.push(`  ${m.id.padEnd(8)} ${String(m.bars).padStart(4)} bars  ${String(m.durationSeconds).padStart(7)} s  ${m.voices} voice(s)${m.pickup ? `  pickup ${m.pickup}` : ''}  sha256 ${m.sha256.slice(0, 12)}…  ${m.label}`);
  }
  const total = validated.movements.reduce((s, m) => s + m.durationSeconds, 0);
  lines.push(`total      ${Math.round(total)} s`);
  return lines.join('\n');
}

export async function main(argv, { env = process.env, stdout = process.stdout, stderr = process.stderr } = {}) {
  const o = parseArgs(argv);
  if (o.help) { stdout.write(HELP + '\n'); return 0; }
  const payload = buildPayload(o);
  const body = Buffer.from(JSON.stringify(payload), 'utf8');
  if (body.length > LIMITS.payloadBytes) throw new DraftError('payload_too_large', `Payload is ${body.length} bytes; the limit is ${LIMITS.payloadBytes}`);
  const validated = validatePayload(payload);
  if (o.dryRun) {
    stdout.write(report(validated, body.length) + '\nvalid (dry run; nothing sent)\n');
    return 0;
  }
  stderr.write(report(validated, body.length) + `\npublishing to ${o.host} ...\n`);
  // Argument vector only, no local shell. The remote command is a constant string.
  const sshBin = env.MISSING_WORKS_SSH || 'ssh';
  const child = spawn(sshBin, ['-T', '-o', 'BatchMode=yes', '--', o.host, REMOTE_COMMAND], { stdio: ['pipe', 'pipe', 'inherit'] });
  const out = [];
  child.stdout.on('data', (c) => out.push(c));
  child.stdin.on('error', () => { /* remote closed early; its exit status explains */ });
  child.stdin.end(body);
  const code = await new Promise((res, rej) => {
    child.on('error', rej);
    child.on('close', (c, sig) => res(c ?? (sig ? 1 : 0)));
  });
  const text = Buffer.concat(out).toString('utf8');
  let result = null;
  try { result = JSON.parse(text); } catch { /* not JSON */ }
  if (result && result.ok) {
    stdout.write(`published revision ${result.revision} of ${result.id}\n${result.url}\n${result.revisionUrl}\n`);
  } else if (result && result.error) {
    stderr.write(`rejected (${result.error.code}): ${result.error.message}\n${(result.error.details || []).join('\n')}${result.error.details ? '\n' : ''}`);
  } else {
    stderr.write(`unexpected response from ${o.host} (exit ${code})\n${text.slice(0, 2000)}\n`);
  }
  return code === 0 && !(result && result.ok) ? 1 : code;
}

function isMain() {
  try {
    return process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMain()) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (err) => {
    if (err instanceof UsageError) {
      process.stderr.write(`error: ${err.message}\n\n${HELP}\n`);
      process.exitCode = 2;
    } else if (err instanceof DraftError) {
      process.stderr.write(`error (${err.code}): ${err.message}\n${(err.details || []).join('\n')}${err.details ? '\n' : ''}`);
      process.exitCode = 1;
    } else {
      process.stderr.write(`error: ${err && err.message ? err.message : err}\n`);
      process.exitCode = 1;
    }
  });
}
