#!/usr/bin/env node
// Owner-only draft publishing over SSH. There is deliberately no HTTP write API.
//   node server/draft-cli.mjs publish    < payload.json
//   node server/draft-cli.mjs validate   < payload.json
// Production wrapper: sudo -u missingworks /usr/local/bin/missing-works-draft publish
//
// Payload (JSON on stdin, at most 2 MiB):
//   {id, requestId, title, subtitle?, description?, changeNote, expectedRevision?,
//    movements:[{id, label, note?, abc}]}            (1-16 movements)
// Output: one JSON object on stdout, {ok:true,...} or {ok:false,error:{code,message,details?}}.
// Exit codes: 0 ok, 1 rejected/failed, 2 usage, 3 stale expectedRevision, 4 database busy.
// Uses DB_PATH, CATALOG_PATH and DRAFT_ROOT like the server.
import { fileURLToPath } from 'node:url';
import { realpathSync } from 'node:fs';
import { VoteStore } from './db.mjs';
import { loadCatalog } from './catalog.mjs';
import { optionsFromEnv, PRODUCTION_ORIGIN } from './app.mjs';
import { DraftError, LIMITS, parsePayloadBytes, validatePayload } from './draft-validation.mjs';
import { publishDraft } from './drafts.mjs';

export const USAGE = `usage: node server/draft-cli.mjs <command> < payload.json
  publish     validate, then publish the next immutable revision of a live draft
  validate    validate only; writes nothing and does not touch the database
Payload: {id, requestId, title, subtitle?, description?, changeNote, expectedRevision?,
          movements:[{id, label, note?, abc}]}  (JSON on stdin, <= ${LIMITS.payloadBytes} bytes)
Exit codes: 0 ok, 1 rejected, 2 usage, 3 stale expectedRevision, 4 database busy`;

const EXIT = { usage: 2, stale_revision: 3, busy: 4 };

export class UsageError extends Error {}

export async function readLimited(stream, limit) {
  const chunks = [];
  let size = 0;
  for await (const chunk of stream) {
    size += chunk.length;
    if (size > limit) {
      stream.destroy?.();
      throw new DraftError('payload_too_large', `Payload must be at most ${limit} bytes`);
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function summary(work) {
  return {
    revision: work.revision,
    movements: work.movements.map((m) => ({ id: m.id, bars: m.bars, durationSeconds: m.durationSeconds, sha256: m.sha256 })),
    durationSeconds: work.durationSeconds,
  };
}

export async function runDraftCli(argv, { env = process.env, stdin = process.stdin, now } = {}) {
  const [cmd, ...rest] = argv;
  if (cmd !== 'publish' && cmd !== 'validate') throw new UsageError(cmd ? `unknown command: ${cmd}` : 'missing command');
  if (rest.length) throw new UsageError(`${cmd} takes no arguments; send the payload on stdin`);
  const raw = parsePayloadBytes(await readLimited(stdin, LIMITS.payloadBytes));
  const payload = validatePayload(raw); // expensive parsing happens before any lock
  if (cmd === 'validate') {
    return {
      ok: true,
      validated: true,
      id: payload.id,
      requestId: payload.requestId,
      movements: payload.movements.map((m) => ({ id: m.id, label: m.label, bars: m.bars, durationSeconds: m.durationSeconds, voices: m.voices, pickup: m.pickup, sha256: m.sha256 })),
    };
  }
  const opts = optionsFromEnv(env);
  const store = new VoteStore({ dbPath: opts.dbPath, catalog: loadCatalog(opts.catalogPath) });
  try {
    const { work, previousRevision, recovered } = publishDraft({ root: opts.draftRoot, store, payload, now });
    const base = `${PRODUCTION_ORIGIN}/work.html?draft=${encodeURIComponent(work.id)}`;
    return {
      ok: true,
      id: work.id,
      requestId: work.requestId,
      revision: work.revision,
      previousRevision,
      url: base,
      revisionUrl: `${base}&revision=${work.revision}`,
      apiUrl: `${PRODUCTION_ORIGIN}/api/drafts/${work.id}`,
      ...(recovered && (recovered.staging || recovered.orphans.length) ? { recovered: { staleStagingRemoved: recovered.staging, orphanedRevisionsSetAside: recovered.orphans } } : {}),
      summary: summary(work),
      work,
    };
  } finally {
    store.close();
  }
}

function errorBody(err) {
  if (err instanceof DraftError) {
    return { code: err.code, message: err.message, ...(err.details ? { details: err.details } : {}) };
  }
  if (err && /SQLITE_BUSY|database is locked/i.test(String(err.message))) {
    return { code: 'busy', message: 'Another publish or administrative command holds the database; try again' };
  }
  // Never echo raw system errors: they can contain private paths.
  return { code: 'internal_error', message: `Publishing failed (${(err && err.code) || (err && err.name) || 'Error'})` };
}

function isMain() {
  try {
    return process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMain()) {
  const args = process.argv.slice(2);
  if (args[0] === '--help' || args[0] === '-h' || args[0] === 'help') {
    console.log(USAGE);
    process.exit(0);
  }
  try {
    const result = await runDraftCli(args);
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  } catch (err) {
    if (err instanceof UsageError) {
      console.error(`error: ${err.message}\n${USAGE}`);
      process.exit(EXIT.usage);
    }
    const error = errorBody(err);
    process.stdout.write(JSON.stringify({ ok: false, error }, null, 2) + '\n');
    console.error(`error: ${error.message}`);
    process.exitCode = EXIT[error.code] ?? 1;
  }
}
