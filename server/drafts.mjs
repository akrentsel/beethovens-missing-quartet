// Live composition drafts: immutable revision storage, owner-only publishing
// (via server/draft-cli.mjs over SSH) and the public read-only API.
//
// Layout under DRAFT_ROOT (outside website releases):
//   <id>/index.json                       latest pointer + revision history (atomically replaced)
//   <id>/revisions/<n>/manifest.json      immutable
//   <id>/revisions/<n>/<movement>.abc     immutable, the exact submitted ABC
//   <id>/.staging-*                       incomplete writes (never served, cleaned under the lock)
//   <id>/.orphans/*                       complete revisions whose index update never happened
import {
  mkdirSync, readdirSync, readFileSync, renameSync, rmSync, openSync, writeSync, fsyncSync, closeSync,
  existsSync, constants as FS,
} from 'node:fs';
import { open, readFile, readdir } from 'node:fs/promises';
import { join, dirname, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { SLUG_RE, LIMITS, DraftError } from './draft-validation.mjs';
import { REQUEST_ID_RE } from './db.mjs';

export const DRAFT_INDEX_FORMAT = 1;
const DIR_MODE = 0o750;
const FILE_MODE = 0o640;
const REVISION_RE = /^[1-9][0-9]{0,8}$/;
const ROUTE_RE = /^\/api\/drafts(?:\/([a-z0-9]+(?:-[a-z0-9]+)*)(?:\/revisions\/([1-9][0-9]{0,8})(?:\/([a-z0-9]+(?:-[a-z0-9]+)*)\.abc)?)?)?$/;
const IMMUTABLE = 'public, max-age=31536000, immutable';

export function defaultDraftRoot(dbPath) {
  if (!dbPath || dbPath === ':memory:') return null;
  return join(dirname(resolve(dbPath)), 'drafts');
}

export function sourcePath(id, revision, movementId) {
  return `api/drafts/${id}/revisions/${revision}/${movementId}.abc`;
}

// ---------- index parsing (shared by reader and writer) ----------

function parseIndex(text, id) {
  let v;
  try { v = JSON.parse(text); } catch { return null; }
  if (!v || v.format !== DRAFT_INDEX_FORMAT || v.id !== id) return null;
  if (typeof v.requestId !== 'string' || !REQUEST_ID_RE.test(v.requestId)) return null;
  if (!Number.isSafeInteger(v.latest) || v.latest < 1) return null;
  if (!Array.isArray(v.revisions) || !v.revisions.length) return null;
  let prev = 0;
  for (const r of v.revisions) {
    if (!r || !Number.isSafeInteger(r.revision) || r.revision <= prev) return null;
    if (typeof r.publishedAt !== 'string' || typeof r.changeNote !== 'string') return null;
    prev = r.revision;
  }
  if (prev !== v.latest) return null;
  return v;
}

// ---------- public reads ----------

export class DraftReader {
  constructor({ root }) {
    this.root = root ? resolve(root) : null;
  }

  async index(id) {
    if (!this.root || typeof id !== 'string' || !SLUG_RE.test(id) || id.length > LIMITS.workIdLength) return null;
    try {
      return parseIndex(await readFile(join(this.root, id, 'index.json'), 'utf8'), id);
    } catch {
      return null;
    }
  }

  async manifest(index, revision) {
    if (!index || !index.revisions.some((r) => r.revision === revision)) return null;
    try {
      const m = JSON.parse(await readFile(join(this.root, index.id, 'revisions', String(revision), 'manifest.json'), 'utf8'));
      if (!m || m.id !== index.id || m.revision !== revision || !Array.isArray(m.movements)) return null;
      return m;
    } catch {
      return null;
    }
  }

  async source(index, revision, movementId) {
    const manifest = await this.manifest(index, revision);
    if (!manifest || !manifest.movements.some((m) => m.id === movementId)) return null;
    let fh;
    try {
      fh = await open(join(this.root, index.id, 'revisions', String(revision), `${movementId}.abc`), FS.O_RDONLY | FS.O_NOFOLLOW);
      const st = await fh.stat();
      if (!st.isFile() || st.size > LIMITS.abcBytes) return null;
      return await fh.readFile();
    } catch {
      return null;
    } finally {
      if (fh) await fh.close().catch(() => {});
    }
  }

  async ids() {
    if (!this.root) return [];
    try {
      const entries = await readdir(this.root, { withFileTypes: true });
      return entries.filter((e) => e.isDirectory() && SLUG_RE.test(e.name) && e.name.length <= LIMITS.workIdLength).map((e) => e.name).sort();
    } catch {
      return [];
    }
  }
}

function wrapperStatus(request) {
  return {
    status: request.status,
    completedWorkId: request.status === 'completed' ? request.workId ?? null : null,
  };
}

// Returns an async handler(req, res, rawPath, cors) for /api/drafts routes.
export function createDraftRoutes({ root, store, sendJson, sendError }) {
  const reader = new DraftReader({ root });

  async function current(id) {
    const index = await reader.index(id);
    if (!index) return null;
    const request = store.getRequest(index.requestId);
    if (!request) return null;
    return { index, request };
  }

  function sendText(res, buf, cors) {
    res.writeHead(200, {
      'Content-Type': 'text/plain; charset=utf-8',
      'Content-Length': buf.length,
      'Cache-Control': IMMUTABLE,
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; sandbox",
      ...cors,
    });
    res.end(buf);
  }

  return async function handleDrafts(req, res, rawPath, cors) {
    const match = ROUTE_RE.exec(rawPath);
    if (!match) return sendError(res, 404, 'not_found', 'Not found', cors);
    if (req.method !== 'GET') return sendError(res, 405, 'method_not_allowed', 'Method not allowed', { ...cors, Allow: 'GET, OPTIONS' });
    const [, id, rev, movement] = match;

    if (!id) {
      const drafts = [];
      for (const name of await reader.ids()) {
        const cur = await current(name);
        if (!cur) continue;
        const work = await reader.manifest(cur.index, cur.index.latest);
        if (!work) continue;
        drafts.push({
          id: work.id,
          requestId: cur.request.id,
          composerId: cur.request.composerId,
          formId: cur.request.formId,
          title: work.title,
          revision: work.revision,
          publishedAt: work.publishedAt,
          changeNote: work.changeNote,
          ...wrapperStatus(cur.request),
          movements: work.movements.map((m) => ({ id: m.id, label: m.label, bars: m.bars })),
        });
      }
      drafts.sort((a, b) => (a.publishedAt < b.publishedAt ? 1 : a.publishedAt > b.publishedAt ? -1 : a.id.localeCompare(b.id)));
      return sendJson(res, 200, { drafts }, cors);
    }

    const cur = await current(id);
    if (!cur) return sendError(res, 404, 'not_found', 'Draft not found', cors);
    if (!rev) {
      const work = await reader.manifest(cur.index, cur.index.latest);
      if (!work) return sendError(res, 404, 'not_found', 'Draft not found', cors);
      return sendJson(res, 200, {
        work,
        revisions: cur.index.revisions.map((r) => ({ revision: r.revision, publishedAt: r.publishedAt, changeNote: r.changeNote })),
        ...wrapperStatus(cur.request),
      }, cors);
    }
    const revision = Number(rev);
    if (!movement) {
      const work = await reader.manifest(cur.index, revision);
      if (!work) return sendError(res, 404, 'not_found', 'Revision not found', cors);
      return sendJson(res, 200, { work }, { ...cors, 'Cache-Control': IMMUTABLE });
    }
    const buf = await reader.source(cur.index, revision, movement);
    if (!buf) return sendError(res, 404, 'not_found', 'Score not found', cors);
    return sendText(res, buf, cors);
  };
}

// ---------- owner-only publishing ----------

function writeFileDurable(path, data) {
  const fd = openSync(path, FS.O_WRONLY | FS.O_CREAT | FS.O_EXCL | FS.O_NOFOLLOW, FILE_MODE);
  try {
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf8');
    let off = 0;
    while (off < buf.length) off += writeSync(fd, buf, off, buf.length - off);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function fsyncDir(path) {
  const fd = openSync(path, FS.O_RDONLY | FS.O_DIRECTORY);
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

function readIndexSync(dir, id) {
  let text;
  try {
    text = readFileSync(join(dir, 'index.json'), 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw new DraftError('storage_error', `Could not read the existing index for draft ${id}`);
  }
  const index = parseIndex(text, id);
  if (!index) throw new DraftError('storage_error', `The existing index for draft ${id} is unreadable; refusing to publish over it`);
  return index;
}

const tag = () => `${process.pid}-${randomBytes(6).toString('hex')}`;

// Removes leftovers of interrupted publishes. Runs only while holding the lock,
// so no other publisher can be writing them.
function recoverDraftDir(dir, latest) {
  const report = { staging: 0, orphans: [] };
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name.startsWith('.staging-') || e.name.startsWith('.index-')) {
      rmSync(join(dir, e.name), { recursive: true, force: true });
      report.staging++;
    }
  }
  const revDir = join(dir, 'revisions');
  if (!existsSync(revDir)) return report;
  for (const e of readdirSync(revDir, { withFileTypes: true })) {
    if (!REVISION_RE.test(e.name) || Number(e.name) <= latest) continue;
    // A complete revision that was never indexed (crash between the directory
    // rename and the index update). Keep it, but out of the served namespace.
    mkdirSync(join(dir, '.orphans'), { recursive: true, mode: DIR_MODE });
    renameSync(join(revDir, e.name), join(dir, '.orphans', `${e.name}-${Date.now()}-${tag()}`));
    report.orphans.push(Number(e.name));
  }
  if (report.orphans.length) { fsyncDir(revDir); fsyncDir(join(dir, '.orphans')); }
  return report;
}

function otherDraftForRequest(root, id, requestId) {
  for (const e of readdirSync(root, { withFileTypes: true })) {
    if (!e.isDirectory() || e.name === id || !SLUG_RE.test(e.name)) continue;
    try {
      const idx = parseIndex(readFileSync(join(root, e.name, 'index.json'), 'utf8'), e.name);
      if (idx && idx.requestId === requestId) return e.name;
    } catch { /* not a draft */ }
  }
  return null;
}

// Publishes an already validated payload (see validatePayload). `store` is a
// VoteStore; its write transaction (BEGIN IMMEDIATE) is the cross-process lock and
// makes the request-state check atomic with the publication.
// hooks.beforeIndex / hooks.beforeRename are test-only fault injection points.
export function publishDraft({ root, store, payload, now = () => new Date().toISOString(), hooks = {} }) {
  if (!root) throw new DraftError('storage_error', 'DRAFT_ROOT is not configured');
  root = resolve(root);
  mkdirSync(root, { recursive: true, mode: DIR_MODE });
  const p = payload;
  return store.tx(() => {
    const request = store.getRequest(p.requestId);
    if (!request) throw new DraftError('unknown_request', `Request ${p.requestId} does not exist`);
    if (request.status === 'completed') throw new DraftError('request_completed', `Request ${p.requestId} is completed; its drafts are archived and cannot change`);
    if (request.status !== 'composing') throw new DraftError('request_not_composing', `Request ${p.requestId} is ${request.status}, not composing`);
    const dir = join(root, p.id);
    const index = existsSync(dir) ? readIndexSync(dir, p.id) : null;
    if (index && index.requestId !== p.requestId) {
      throw new DraftError('request_mismatch', `Draft ${p.id} belongs to ${index.requestId}, not ${p.requestId}`);
    }
    const other = otherDraftForRequest(root, p.id, p.requestId);
    if (other) throw new DraftError('request_has_draft', `Request ${p.requestId} already has draft ${other}`);
    const latest = index ? index.latest : 0;
    if (p.expectedRevision !== null && p.expectedRevision !== latest) {
      throw new DraftError('stale_revision', `Expected revision ${p.expectedRevision} but the latest is ${latest}`);
    }
    if (latest >= LIMITS.maxRevision) throw new DraftError('storage_error', 'Revision limit reached');
    const revision = latest + 1;
    const publishedAt = now();

    mkdirSync(join(dir, 'revisions'), { recursive: true, mode: DIR_MODE });
    const recovered = recoverDraftDir(dir, latest);

    const manifest = {
      id: p.id,
      requestId: request.id,
      composerId: request.composerId,
      formId: request.formId,
      round: request.round,
      title: p.title,
      subtitle: p.subtitle,
      description: p.description,
      status: 'draft',
      revision,
      publishedAt,
      changeNote: p.changeNote,
      durationSeconds: Math.round(p.movements.reduce((s, m) => s + m.durationSeconds, 0)),
      movements: p.movements.map((m) => ({
        id: m.id,
        label: m.label,
        note: m.note,
        source: sourcePath(p.id, revision, m.id),
        bars: m.bars,
        durationSeconds: m.durationSeconds,
        sha256: m.sha256,
      })),
    };

    // 1. Complete revision directory in staging, then one rename into place.
    const staging = join(dir, `.staging-${revision}-${tag()}`);
    mkdirSync(staging, { mode: DIR_MODE });
    for (const m of p.movements) writeFileDurable(join(staging, `${m.id}.abc`), m.abc);
    writeFileDurable(join(staging, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
    fsyncDir(staging);
    if (hooks.beforeRename) hooks.beforeRename();
    const final = join(dir, 'revisions', String(revision));
    if (existsSync(final)) throw new DraftError('storage_error', `Revision ${revision} already exists; refusing to overwrite`);
    renameSync(staging, final); // fails rather than replace a non-empty directory
    fsyncDir(join(dir, 'revisions'));
    if (hooks.beforeIndex) hooks.beforeIndex();

    // 2. Atomically move the latest pointer.
    const next = {
      format: DRAFT_INDEX_FORMAT,
      id: p.id,
      requestId: request.id,
      latest: revision,
      revisions: [...(index ? index.revisions : []), { revision, publishedAt, changeNote: p.changeNote }],
    };
    const tmp = join(dir, `.index-${tag()}.tmp`);
    writeFileDurable(tmp, JSON.stringify(next, null, 2) + '\n');
    renameSync(tmp, join(dir, 'index.json'));
    fsyncDir(dir);
    return { work: manifest, previousRevision: latest, recovered };
  });
}
