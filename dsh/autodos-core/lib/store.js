// The Autodos ledger: one append-only event log, and the current state of every object
// (goals, projects, staff, tasks, threads, outputs, decisions, ...) folded from it.
//
// - Every change is an event: when, who did it, to what, what changed, why, and what caused it.
// - The `objects` table is the current state. It is written in the same transaction as the event,
//   and can always be rebuilt from the events alone (`rebuild()`).
// - Each event may name the task it belongs to, so any task can show its whole timeline.
//
// Plain ESM, no dependencies: node:sqlite (Node 22.5+).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

/** node:sqlite prints an ExperimentalWarning once on Node 22/23; keep it out of the person's logs. */
function loadSqlite() {
  const emit = process.emitWarning;
  process.emitWarning = (w, ...rest) => (String(w?.message || w).includes('SQLite') ? undefined : emit.call(process, w, ...rest));
  try {
    return require('node:sqlite');
  } finally {
    process.emitWarning = emit;
  }
}

/** The kinds of object the ledger knows. Others may be added; these are the ones the board reads. */
export const KINDS = ['goal', 'project', 'staff', 'machine', 'task', 'thread', 'output', 'decision', 'requirement', 'rule', 'settings'];

/** Task states, in the order the board shows them (waiting on you first). */
export const TASK_STATES = ['waiting_you', 'stuck', 'working', 'review', 'queued', 'landing', 'done', 'failed', 'dropped'];

export const newId = (prefix) => `${prefix}_${crypto.randomBytes(6).toString('hex')}`;
export const nowIso = () => new Date().toISOString();

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS events (
  seq     INTEGER PRIMARY KEY AUTOINCREMENT,
  id      TEXT NOT NULL UNIQUE,
  at      TEXT NOT NULL,
  actor   TEXT NOT NULL,
  type    TEXT NOT NULL,
  kind    TEXT,
  object  TEXT,
  task    TEXT,
  cause   TEXT,
  reason  TEXT,
  data    TEXT NOT NULL DEFAULT '{}',
  was     TEXT
);
CREATE INDEX IF NOT EXISTS events_object ON events (kind, object, seq);
CREATE INDEX IF NOT EXISTS events_task ON events (task, seq);
CREATE INDEX IF NOT EXISTS events_type ON events (type, seq);
CREATE TABLE IF NOT EXISTS objects (
  kind       TEXT NOT NULL,
  id         TEXT NOT NULL,
  data       TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  removed    INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (kind, id)
);
CREATE INDEX IF NOT EXISTS objects_updated ON objects (kind, updated_at);
`;

/**
 * Object events change state; every other event type is a record only (a message, a check run, a
 * triage). `<kind>.created` sets the whole object, `<kind>.updated` merges a patch (null removes a
 * field), `<kind>.removed` marks it gone (it stays queryable with { removed: true }).
 */
function fold(row, ev) {
  const verb = ev.type.slice(ev.type.lastIndexOf('.') + 1);
  if (verb === 'created') return { data: { ...ev.data, id: ev.object }, created_at: ev.at, updated_at: ev.at, removed: 0 };
  if (!row) return null;
  if (verb === 'updated') {
    const data = { ...row.data };
    for (const [k, v] of Object.entries(ev.data || {})) {
      if (k === 'id') continue;
      if (v === null) delete data[k];
      else data[k] = v;
    }
    return { ...row, data, updated_at: ev.at };
  }
  if (verb === 'removed') return { ...row, removed: 1, updated_at: ev.at };
  return row;
}

const isObjectEvent = (ev) => ev.kind && ev.object && /\.(created|updated|removed)$/.test(ev.type) && ev.type.startsWith(ev.kind + '.');

export class Ledger {
  /** @param {string} file path of the SQLite file, or ':memory:' */
  constructor(file) {
    if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
    const { DatabaseSync } = loadSqlite();
    this.file = file;
    this.db = new DatabaseSync(file);
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON;');
    this.db.exec(SCHEMA);
    this.listeners = new Set();
    this.q = {
      insertEvent: this.db.prepare('INSERT INTO events (id, at, actor, type, kind, object, task, cause, reason, data, was) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'),
      getObject: this.db.prepare('SELECT * FROM objects WHERE kind = ? AND id = ?'),
      putObject: this.db.prepare('INSERT INTO objects (kind, id, data, created_at, updated_at, removed) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (kind, id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at, removed = excluded.removed'),
      listKind: this.db.prepare('SELECT * FROM objects WHERE kind = ? AND removed = 0 ORDER BY updated_at DESC'),
      listKindAll: this.db.prepare('SELECT * FROM objects WHERE kind = ? ORDER BY updated_at DESC'),
      byTask: this.db.prepare('SELECT * FROM events WHERE task = ? ORDER BY at, seq'),
      byObject: this.db.prepare('SELECT * FROM events WHERE kind = ? AND object = ? ORDER BY at, seq'),
      since: this.db.prepare('SELECT * FROM events WHERE seq > ? ORDER BY seq LIMIT ?'),
      lastSeq: this.db.prepare('SELECT COALESCE(MAX(seq), 0) AS seq FROM events'),
      count: this.db.prepare('SELECT COUNT(*) AS n FROM events'),
      countKind: this.db.prepare('SELECT kind, COUNT(*) AS n FROM objects WHERE removed = 0 GROUP BY kind'),
      getMeta: this.db.prepare('SELECT value FROM meta WHERE key = ?'),
      setMeta: this.db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value'),
    };
  }

  close() {
    this.db.close();
  }

  meta(key, value) {
    if (value === undefined) {
      const row = this.q.getMeta.get(key);
      return row ? JSON.parse(row.value) : undefined;
    }
    this.q.setMeta.run(key, JSON.stringify(value));
    return value;
  }

  /** Run fn inside one transaction; nested calls join the outer one. */
  transaction(fn) {
    if (this.inTx) return fn();
    this.inTx = true;
    this.db.exec('BEGIN IMMEDIATE');
    const pending = [];
    this.pending = pending;
    try {
      const out = fn();
      this.db.exec('COMMIT');
      this.inTx = false;
      this.pending = null;
      for (const ev of pending) this.#notify(ev);
      return out;
    } catch (e) {
      this.db.exec('ROLLBACK');
      this.inTx = false;
      this.pending = null;
      throw e;
    }
  }

  /**
   * Append one event and fold it into the current state.
   * @param {{type: string, actor?: string, kind?: string, object?: string, task?: string, cause?: string,
   *   reason?: string, data?: object, was?: object, at?: string, id?: string}} e
   * @returns the stored event
   */
  append(e) {
    if (!e?.type) throw new Error('event needs a type');
    const ev = {
      id: e.id || newId('ev'),
      at: e.at || nowIso(),
      actor: e.actor || 'system',
      type: e.type,
      kind: e.kind || null,
      object: e.object || null,
      task: e.task || (e.kind === 'task' ? e.object : null) || null,
      cause: e.cause || null,
      reason: e.reason || null,
      data: e.data || {},
      was: e.was || null,
    };
    return this.transaction(() => {
      const res = this.q.insertEvent.run(ev.id, ev.at, ev.actor, ev.type, ev.kind, ev.object, ev.task, ev.cause, ev.reason, JSON.stringify(ev.data), ev.was ? JSON.stringify(ev.was) : null);
      ev.seq = Number(res.lastInsertRowid);
      if (isObjectEvent(ev)) {
        if (ev.type.endsWith('.created') && this.q.getObject.get(ev.kind, ev.object)) throw new Error(`${ev.kind} ${ev.object} already exists`);
        const next = fold(this.#row(ev.kind, ev.object), ev);
        if (!next) throw new Error(`${ev.kind} ${ev.object} does not exist`);
        this.q.putObject.run(ev.kind, ev.object, JSON.stringify(next.data), next.created_at, next.updated_at, next.removed);
      }
      if (this.pending) this.pending.push(ev);
      return ev;
    });
  }

  /** Create an object. Returns it. */
  create(kind, fields = {}, meta = {}) {
    const id = fields.id || newId(kind.slice(0, 2));
    const { id: _drop, ...data } = fields;
    this.append({ ...meta, type: `${kind}.created`, kind, object: id, data });
    return this.get(kind, id);
  }

  /** Merge a patch into an object (null removes a field). Records the values it replaced. Returns it. */
  update(kind, id, patch = {}, meta = {}) {
    const before = this.get(kind, id, { removed: true });
    if (!before) throw new Error(`${kind} ${id} does not exist`);
    const changed = {};
    const was = {};
    for (const [k, v] of Object.entries(patch)) {
      if (JSON.stringify(before[k] ?? null) === JSON.stringify(v ?? null)) continue;
      changed[k] = v;
      was[k] = before[k] ?? null;
    }
    if (!Object.keys(changed).length) return before;
    this.append({ ...meta, type: `${kind}.updated`, kind, object: id, data: changed, was });
    return this.get(kind, id);
  }

  remove(kind, id, meta = {}) {
    this.append({ ...meta, type: `${kind}.removed`, kind, object: id });
  }

  /** Record something that happened without changing an object (a message, a triage, a check run). */
  record(type, data = {}, meta = {}) {
    return this.append({ ...meta, type, data });
  }

  #row(kind, id) {
    const r = this.q.getObject.get(kind, id);
    return r ? { data: JSON.parse(r.data), created_at: r.created_at, updated_at: r.updated_at, removed: r.removed } : null;
  }

  get(kind, id, { removed = false } = {}) {
    const r = this.q.getObject.get(kind, id);
    if (!r || (r.removed && !removed)) return null;
    return { ...JSON.parse(r.data), id: r.id, createdAt: r.created_at, updatedAt: r.updated_at, ...(r.removed ? { removed: true } : {}) };
  }

  list(kind, { removed = false, where } = {}) {
    const rows = (removed ? this.q.listKindAll : this.q.listKind).all(kind);
    const out = rows.map((r) => ({ ...JSON.parse(r.data), id: r.id, createdAt: r.created_at, updatedAt: r.updated_at, ...(r.removed ? { removed: true } : {}) }));
    return where ? out.filter(where) : out;
  }

  /** Everything that happened to one task, oldest first. */
  timeline(taskId) {
    return this.q.byTask.all(taskId).map(rowToEvent);
  }

  history(kind, id) {
    return this.q.byObject.all(kind, id).map(rowToEvent);
  }

  /** Events after a sequence number, for anyone following the log. */
  since(seq = 0, limit = 500) {
    return this.q.since.all(seq, limit).map(rowToEvent);
  }

  lastSeq() {
    return Number(this.q.lastSeq.get().seq);
  }

  counts() {
    const out = { events: Number(this.q.count.get().n) };
    for (const r of this.q.countKind.all()) out[r.kind] = Number(r.n);
    return out;
  }

  /** Throw away the current state and fold it again from the events. Returns the object count. */
  rebuild() {
    return this.transaction(() => {
      this.db.exec('DELETE FROM objects');
      const state = new Map();
      for (const r of this.db.prepare('SELECT * FROM events ORDER BY seq').iterate()) {
        const ev = rowToEvent(r);
        if (!isObjectEvent(ev)) continue;
        const key = `${ev.kind}\u0000${ev.object}`;
        const next = fold(state.get(key) || null, ev);
        if (next) state.set(key, next);
      }
      for (const [key, v] of state) {
        const [kind, id] = key.split('\u0000');
        this.q.putObject.run(kind, id, JSON.stringify(v.data), v.created_at, v.updated_at, v.removed);
      }
      return state.size;
    });
  }

  /** Called with each event after its transaction commits. Returns an unsubscribe function. */
  subscribe(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  #notify(ev) {
    for (const fn of this.listeners) {
      try {
        fn(ev);
      } catch {
        /* a listener's failure is its own */
      }
    }
  }
}

function rowToEvent(r) {
  return {
    seq: Number(r.seq),
    id: r.id,
    at: r.at,
    actor: r.actor,
    type: r.type,
    kind: r.kind,
    object: r.object,
    task: r.task,
    cause: r.cause,
    reason: r.reason,
    data: JSON.parse(r.data),
    ...(r.was ? { was: JSON.parse(r.was) } : {}),
  };
}
