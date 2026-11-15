#!/usr/bin/env node
// Owner-only administration over SSH. There is deliberately no HTTP admin API.
//   node server/admin.mjs queue [--json]
//   node server/admin.mjs start <requestId>
//   node server/admin.mjs complete <requestId> <workId>
//   node server/admin.mjs reopen <requestId>
//   node server/admin.mjs backup <outputPath>
// Uses DB_PATH and CATALOG_PATH like the server.
import { fileURLToPath } from 'node:url';
import { realpathSync } from 'node:fs';
import { VoteStore } from './db.mjs';
import { loadCatalog } from './catalog.mjs';
import { optionsFromEnv } from './app.mjs';

const USAGE = `usage: node server/admin.mjs <command>
  queue [--json]                    open requests by votes, then requests in progress
  start <requestId>                 open -> composing
  complete <requestId> <workId>     composing -> completed; opens the next round
  reopen <requestId>                composing -> open
  backup <outputPath>               consistent copy of the database (never overwrites)`;

const ARITY = { queue: [0, 1], start: [1, 1], complete: [2, 2], reopen: [1, 1], backup: [1, 1] };

export function runAdmin(argv, { env = process.env, out = console.log } = {}) {
  const [cmd, ...args] = argv;
  if (!cmd || !Object.hasOwn(ARITY, cmd)) throw new UsageError(cmd ? `unknown command: ${cmd}` : 'missing command');
  const [min, max] = ARITY[cmd];
  if (args.length < min || args.length > max) throw new UsageError(`wrong number of arguments for ${cmd}`);
  if (cmd !== 'queue' && args.some((a) => a.startsWith('-'))) throw new UsageError(`unexpected option for ${cmd}`);
  let json = false;
  if (cmd === 'queue' && args.length) {
    if (args[0] !== '--json') throw new UsageError(`unknown option: ${args[0]}`);
    json = true;
  }
  const opts = optionsFromEnv(env);
  const store = new VoteStore({ dbPath: opts.dbPath, catalog: loadCatalog(opts.catalogPath) });
  try {
    switch (cmd) {
      case 'queue': {
        const q = store.queue();
        if (json) return out(JSON.stringify({ generatedAt: new Date().toISOString(), ...q }, null, 2));
        const lines = [];
        if (q.composing.length) {
          lines.push('In progress:');
          for (const r of q.composing) lines.push(`  ${String(r.votes).padStart(5)}  ${r.id}`);
          lines.push('');
        }
        const voted = q.queue.filter((r) => r.votes > 0);
        lines.push(`Open requests with votes (${voted.length}):`);
        voted.forEach((r, i) => lines.push(`${String(i + 1).padStart(4)}. ${String(r.votes).padStart(5)}  ${r.id}`));
        if (!voted.length) lines.push('  (none)');
        lines.push(`Open requests without votes: ${q.queue.length - voted.length}`);
        return out(lines.join('\n'));
      }
      case 'start':
        return out(`started ${store.startRequest(args[0]).id}`);
      case 'reopen':
        return out(`reopened ${store.reopenRequest(args[0]).id}`);
      case 'complete': {
        const r = store.completeRequest(args[0], args[1]);
        return out(`completed ${r.completed.id} with ${r.completed.workId} (${r.completed.votes} votes kept); opened ${r.next.id}`);
      }
      case 'backup': {
        const b = store.backup(args[0]);
        return out(`backup written to ${b.path} (${b.requests} requests, ${b.votes} votes, integrity ok)`);
      }
    }
  } finally {
    store.close();
  }
}

export class UsageError extends Error {}

function isMain() {
  try {
    return process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMain()) {
  try {
    runAdmin(process.argv.slice(2));
  } catch (err) {
    console.error(`error: ${err.message}`);
    if (err instanceof UsageError) console.error(USAGE);
    process.exit(err instanceof UsageError ? 2 : 1);
  }
}
