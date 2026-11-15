// SQLite storage for requests and anonymous votes (node:sqlite, Node 24+).
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { mkdirSync, existsSync, chmodSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

export const STATUSES = ['open', 'composing', 'completed'];
export const REQUEST_ID_RE = /^([a-z0-9]+(?:-[a-z0-9]+)*):([a-z0-9]+(?:-[a-z0-9]+)*):([1-9][0-9]{0,5})$/;
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class AppError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export function hashVoterToken(token) {
  if (typeof token !== 'string' || !UUID_RE.test(token)) throw new AppError(400, 'invalid_token', 'X-Voter-Token must be a UUID');
  return createHash('sha256').update(token.toLowerCase(), 'utf8').digest('hex');
}

export function requestId(composerId, formId, round) {
  return `${composerId}:${formId}:${round}`;
}

const SCHEMA_V1 = `
CREATE TABLE composers (
  id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 40 AND id NOT GLOB '*[^a-z0-9-]*')
) STRICT;
CREATE TABLE forms (
  id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 40 AND id NOT GLOB '*[^a-z0-9-]*')
) STRICT;
CREATE TABLE requests (
  id TEXT PRIMARY KEY,
  composer_id TEXT NOT NULL REFERENCES composers(id),
  form_id TEXT NOT NULL REFERENCES forms(id),
  round INTEGER NOT NULL CHECK (round >= 1),
  status TEXT NOT NULL CHECK (status IN ('open', 'composing', 'completed')),
  work_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  started_at TEXT,
  completed_at TEXT,
  CHECK (id = composer_id || ':' || form_id || ':' || round),
  CHECK ((status = 'completed') = (work_id IS NOT NULL AND completed_at IS NOT NULL)),
  CHECK (status = 'open' OR started_at IS NOT NULL OR status = 'completed'),
  UNIQUE (composer_id, form_id, round)
) STRICT;
CREATE UNIQUE INDEX requests_one_active_round
  ON requests (composer_id, form_id) WHERE status IN ('open', 'composing');
CREATE UNIQUE INDEX requests_work_id ON requests (work_id) WHERE work_id IS NOT NULL;
CREATE INDEX requests_status ON requests (status);
CREATE TABLE votes (
  request_id TEXT NOT NULL REFERENCES requests(id),
  voter_hash TEXT NOT NULL CHECK (length(voter_hash) = 64 AND voter_hash NOT GLOB '*[^0-9a-f]*'),
  created_at TEXT NOT NULL,
  PRIMARY KEY (request_id, voter_hash)
) STRICT, WITHOUT ROWID;
CREATE INDEX votes_voter ON votes (voter_hash);
`;

const LIST_SQL = `
SELECT r.id, r.composer_id, r.form_id, r.round, r.status, r.work_id, r.created_at,
       (SELECT count(*) FROM votes v WHERE v.request_id = r.id) AS votes,
       EXISTS (SELECT 1 FROM votes v WHERE v.request_id = r.id AND v.voter_hash = :voter) AS voted
FROM requests r`;
const ORDER_SQL = ` ORDER BY votes DESC, r.created_at ASC, r.id ASC`;

function toPublic(row) {
  return {
    id: row.id,
    composerId: row.composer_id,
    formId: row.form_id,
    round: Number(row.round),
    status: row.status,
    votes: Number(row.votes),
    voted: Boolean(Number(row.voted)),
    createdAt: row.created_at,
    workId: row.work_id ?? null,
  };
}

export class VoteStore {
  constructor({ dbPath, catalog, now = () => new Date().toISOString() }) {
    if (!catalog) throw new Error('catalog is required');
    this.catalog = catalog;
    this.now = now;
    this.dbPath = dbPath === ':memory:' ? dbPath : resolve(dbPath);
    if (this.dbPath !== ':memory:') {
      const dir = dirname(this.dbPath);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
    }
    this.db = new DatabaseSync(this.dbPath, { enableForeignKeyConstraints: true });
    this.db.exec('PRAGMA busy_timeout = 5000');
    if (this.dbPath !== ':memory:') {
      const mode = this.db.prepare('PRAGMA journal_mode = WAL').get();
      if (String(Object.values(mode)[0]).toLowerCase() !== 'wal') throw new Error('Could not enable WAL mode');
    }
    this.db.exec('PRAGMA synchronous = FULL');
    this.db.exec('PRAGMA foreign_keys = ON');
    this.migrate();
    this.seed();
    this.prepareStatements();
  }

  tx(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (err) {
      try { this.db.exec('ROLLBACK'); } catch { /* already rolled back */ }
      throw err;
    }
  }

  migrate() {
    const version = Number(this.db.prepare('PRAGMA user_version').get().user_version);
    if (version > 1) throw new Error(`Database schema version ${version} is newer than this server`);
    if (version === 0) {
      this.tx(() => {
        this.db.exec(SCHEMA_V1);
        this.db.exec('PRAGMA user_version = 1');
      });
    }
  }

  // Idempotent: registers catalogue composers/forms and seeds only combinations
  // with no rows at all. Existing statuses and votes are never touched.
  seed() {
    const { composers, forms, works } = this.catalog;
    this.tx(() => {
      const addComposer = this.db.prepare('INSERT OR IGNORE INTO composers (id) VALUES (?)');
      const addForm = this.db.prepare('INSERT OR IGNORE INTO forms (id) VALUES (?)');
      for (const id of composers) addComposer.run(id);
      for (const id of forms) addForm.run(id);
      const hasRows = this.db.prepare('SELECT 1 FROM requests WHERE composer_id = ? AND form_id = ? LIMIT 1');
      const insert = this.db.prepare(`INSERT INTO requests
        (id, composer_id, form_id, round, status, work_id, created_at, updated_at, started_at, completed_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
      const now = this.now();
      for (const composerId of composers) {
        for (const formId of forms) {
          if (hasRows.get(composerId, formId)) continue;
          const done = works
            .filter((w) => w.composerId === composerId && w.formId === formId && (w.status ?? 'completed') === 'completed')
            .sort((a, b) => a.round - b.round);
          let maxRound = 0;
          for (const w of done) {
            const at = w.date && /^\d{4}-\d{2}-\d{2}$/.test(w.date) ? `${w.date}T00:00:00.000Z` : now;
            insert.run(requestId(composerId, formId, w.round), composerId, formId, w.round, 'completed', w.id, at, at, at, at);
            maxRound = Math.max(maxRound, w.round);
          }
          const round = maxRound + 1;
          insert.run(requestId(composerId, formId, round), composerId, formId, round, 'open', null, now, now, null, null);
        }
      }
    });
  }

  prepareStatements() {
    this.sListAll = this.db.prepare(LIST_SQL + ORDER_SQL);
    this.sGetOne = this.db.prepare(LIST_SQL + ' WHERE r.id = :id');
    this.sUpdatedAt = this.db.prepare('SELECT max(updated_at) AS t FROM requests');
    this.sStatus = this.db.prepare('SELECT status FROM requests WHERE id = ?');
    this.sAddVote = this.db.prepare('INSERT OR IGNORE INTO votes (request_id, voter_hash, created_at) VALUES (?, ?, ?)');
    this.sDelVote = this.db.prepare('DELETE FROM votes WHERE request_id = ? AND voter_hash = ?');
    this.sTouch = this.db.prepare('UPDATE requests SET updated_at = ? WHERE id = ?');
  }

  listRequests(voterHash = null) {
    const rows = this.sListAll.all({ voter: voterHash ?? '' });
    return { requests: rows.map(toPublic), updatedAt: this.sUpdatedAt.get().t };
  }

  getRequest(id, voterHash = null) {
    const row = this.sGetOne.get({ id, voter: voterHash ?? '' });
    return row ? toPublic(row) : null;
  }

  setVote(id, voterHash, voted) {
    if (typeof id !== 'string' || !REQUEST_ID_RE.test(id)) throw new AppError(400, 'invalid_request_id', 'Invalid requestId');
    if (typeof voterHash !== 'string' || !/^[0-9a-f]{64}$/.test(voterHash)) throw new AppError(400, 'invalid_token', 'Invalid voter token');
    if (typeof voted !== 'boolean') throw new AppError(400, 'invalid_body', 'voted must be a boolean');
    return this.tx(() => {
      const row = this.sStatus.get(id);
      if (!row) throw new AppError(404, 'not_found', 'Request not found');
      if (row.status !== 'open') throw new AppError(409, 'request_closed', `Request is ${row.status}`);
      const now = this.now();
      const res = voted ? this.sAddVote.run(id, voterHash, now) : this.sDelVote.run(id, voterHash);
      if (Number(res.changes) > 0) this.sTouch.run(now, id);
      return this.getRequest(id, voterHash);
    });
  }

  // ---- administration (CLI only) ----

  queue() {
    const all = this.listRequests().requests;
    return {
      queue: all.filter((r) => r.status === 'open'),
      composing: all.filter((r) => r.status === 'composing'),
    };
  }

  startRequest(id) {
    return this.tx(() => {
      const row = this.requireRequest(id);
      if (row.status !== 'open') throw new AppError(409, 'bad_transition', `Request ${id} is ${row.status}, not open`);
      const now = this.now();
      this.db.prepare("UPDATE requests SET status = 'composing', started_at = ?, updated_at = ? WHERE id = ?").run(now, now, id);
      return this.getRequest(id);
    });
  }

  reopenRequest(id) {
    return this.tx(() => {
      const row = this.requireRequest(id);
      if (row.status !== 'composing') throw new AppError(409, 'bad_transition', `Request ${id} is ${row.status}, not composing`);
      this.db.prepare("UPDATE requests SET status = 'open', started_at = NULL, updated_at = ? WHERE id = ?").run(this.now(), id);
      return this.getRequest(id);
    });
  }

  completeRequest(id, workId) {
    return this.tx(() => {
      const row = this.requireRequest(id);
      if (row.status !== 'composing') throw new AppError(409, 'bad_transition', `Request ${id} is ${row.status}, not composing`);
      const work = this.catalog.works.find((w) => w.id === workId);
      if (!work) throw new AppError(400, 'unknown_work', `Work ${workId} is not in the catalogue`);
      if (work.composerId !== row.composer_id || work.formId !== row.form_id || work.round !== Number(row.round)) {
        throw new AppError(400, 'work_mismatch', `Work ${workId} is ${work.composerId}:${work.formId}:${work.round}, not ${id}`);
      }
      if (this.db.prepare('SELECT 1 FROM requests WHERE work_id = ?').get(workId)) {
        throw new AppError(409, 'work_used', `Work ${workId} already completes another request`);
      }
      const now = this.now();
      this.db.prepare("UPDATE requests SET status = 'completed', work_id = ?, completed_at = ?, updated_at = ? WHERE id = ?")
        .run(workId, now, now, id);
      const nextRound = Number(row.round) + 1;
      const nextId = requestId(row.composer_id, row.form_id, nextRound);
      this.db.prepare(`INSERT INTO requests (id, composer_id, form_id, round, status, work_id, created_at, updated_at)
        VALUES (?, ?, ?, ?, 'open', NULL, ?, ?)`).run(nextId, row.composer_id, row.form_id, nextRound, now, now);
      return { completed: this.getRequest(id), next: this.getRequest(nextId) };
    });
  }

  requireRequest(id) {
    if (typeof id !== 'string' || !REQUEST_ID_RE.test(id)) throw new AppError(400, 'invalid_request_id', `Invalid request id: ${id}`);
    const row = this.db.prepare('SELECT * FROM requests WHERE id = ?').get(id);
    if (!row) throw new AppError(404, 'not_found', `Request ${id} not found`);
    return row;
  }

  // Consistent online copy via VACUUM INTO; refuses to overwrite.
  backup(outputPath) {
    if (this.dbPath === ':memory:') throw new Error('Cannot back up an in-memory database');
    const out = resolve(outputPath);
    if (out === this.dbPath) throw new Error('Backup path must differ from the database path');
    if (existsSync(out)) throw new Error(`Refusing to overwrite existing file ${out}`);
    mkdirSync(dirname(out), { recursive: true, mode: 0o700 });
    this.db.prepare('VACUUM INTO ?').run(out);
    chmodSync(out, 0o600);
    const check = new DatabaseSync(out, { readOnly: true });
    try {
      const ok = check.prepare('PRAGMA integrity_check').get();
      if (Object.values(ok)[0] !== 'ok') throw new Error('Backup integrity check failed');
      const counts = check.prepare('SELECT (SELECT count(*) FROM requests) AS requests, (SELECT count(*) FROM votes) AS votes').get();
      return { path: out, requests: Number(counts.requests), votes: Number(counts.votes) };
    } finally {
      check.close();
    }
  }

  close() {
    if (this.db.isOpen) this.db.close();
  }
}
