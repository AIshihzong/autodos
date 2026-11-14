// Hub side of the person's staff: every agent on every machine, and what Autodos has learned about the person
// from their conversations with those agents ("about you"), about each project, and about each agent.
// Machines send summaries and distilled notes only (see staff.js); the raw conversations stay where they are.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { id, now } from './store.js';
import { STAFF_KINDS, scanMachine, noteKey, redact } from './staff.js';
import { runtimes, resolveRuntime } from './runtimes.js';

export const LOCAL = 'local';
const SCAN_EVERY_MS = 30 * 60_000;
const MAX_NOTES = 3000;
const clip = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s);
const str = (v, n) => clip(String(v ?? ''), n);

export class Staff {
  constructor(store, { home, exclude = [] } = {}) {
    this.store = store;
    this.home = home;
    this.exclude = exclude;
    this.scanning = null;
    const s = (store.data.staff ||= {});
    s.machines ||= {};
    s.members ||= [];
    s.notes ||= [];
    s.consent ||= {};
    s.state ||= {};
    s.rescan ||= {};
  }

  get data() {
    return this.store.data.staff;
  }

  start() {
    this.timer = setTimeout(() => this.scanLocal().catch(() => {}), 5_000);
    this.interval = setInterval(() => this.scanLocal().catch(() => {}), SCAN_EVERY_MS);
    this.timer.unref?.();
    this.interval.unref?.();
  }

  stop() {
    clearTimeout(this.timer);
    clearInterval(this.interval);
  }

  machineName(machine) {
    if (machine === LOCAL) return this.data.machines[LOCAL]?.name || os.hostname().split('.')[0];
    return this.store.data.workers?.find((w) => w.id === machine)?.name || machine;
  }

  allowed(machine) {
    return Object.keys(STAFF_KINDS).filter((k) => this.data.consent[`${machine}:${k}`]);
  }

  /** The person allows (or stops allowing) one kind of agent on one machine to be read. */
  setConsent(machine, kind, allow) {
    if (!STAFF_KINDS[kind]) throw new Error('Unknown kind of agent');
    if (machine !== LOCAL && !this.store.data.workers?.some((w) => w.id === machine)) throw new Error('Unknown machine');
    const k = `${machine}:${kind}`;
    if (allow) this.data.consent[k] = now();
    else delete this.data.consent[k];
    this.data.rescan[machine] = true;
    this.store.changed();
    if (machine === LOCAL) this.scanLocal().catch(() => {});
    return this.view();
  }

  /** Ask for a fresh look now: this machine at once, the others on their next check-in. */
  rescan(machine) {
    const all = [LOCAL, ...(this.store.data.workers || []).map((w) => w.id)];
    for (const m of machine ? [machine] : all) this.data.rescan[m] = true;
    this.store.changed();
    if (!machine || machine === LOCAL) this.scanLocal().catch(() => {});
    return this.view();
  }

  /** A model on this machine distils; the demo runtime means picking preferences out by rule. */
  #distiller() {
    const settings = this.store.data.settings;
    if (settings.staffModel === false) return null;
    const rt = resolveRuntime(settings.chiefRuntime || 'auto');
    if (!rt || rt === 'demo' || !runtimes[rt]) return null;
    const cwd = path.join(this.store.dir, 'staff');
    fs.mkdirSync(cwd, { recursive: true });
    return async (prompt) => (await runtimes[rt].run({ prompt, kind: 'chief', cwd, settings })).text;
  }

  async scanLocal() {
    if (this.scanning) return this.scanning;
    this.scanning = (async () => {
      const m = (this.data.machines[LOCAL] ||= { name: os.hostname().split('.')[0] });
      m.scanning = true;
      this.store.changed();
      try {
        delete this.data.rescan[LOCAL];
        const out = await scanMachine({ home: this.home, allow: this.allowed(LOCAL), state: this.data.state[LOCAL] || {}, distill: this.#distiller(), exclude: [this.store.dir, ...this.exclude] });
        this.data.state[LOCAL] = out.state;
        this.ingest(LOCAL, out);
        m.error = null;
      } catch (e) {
        m.error = str(e.message, 300);
      } finally {
        m.scanning = false;
        this.store.changed();
        this.scanning = null;
      }
    })();
    return this.scanning;
  }

  /** What a worker should read, and whether to look again now. */
  config(worker) {
    const rescan = !!this.data.rescan[worker.id];
    delete this.data.rescan[worker.id];
    if (rescan) this.store.changed();
    return { allow: this.allowed(worker.id), rescan, distill: this.store.data.settings.staffModel !== false };
  }

  /** The project a conversation's folder belongs to: the same folder here, or one with the same name elsewhere. */
  projectFor(cwd, machine) {
    if (!cwd) return null;
    const projects = this.store.data.projects || [];
    const abs = path.resolve(cwd);
    if (machine === LOCAL) {
      const here = projects.filter((p) => p.path && (abs === path.resolve(p.path) || abs.startsWith(path.resolve(p.path) + path.sep)));
      if (here.length) return here.sort((a, b) => b.path.length - a.path.length)[0];
    }
    const name = path.basename(abs).toLowerCase();
    return projects.find((p) => (p.path && path.basename(p.path).toLowerCase() === name) || String(p.name || '').toLowerCase() === name) || null;
  }

  /** A machine's report: its agents, and notes distilled from new conversations. Everything is trimmed and checked. */
  ingest(machine, { staff = [], notes = [], remaining = 0 } = {}) {
    const d = this.data;
    const m = (d.machines[machine] ||= {});
    m.name = this.machineName(machine);
    m.scannedAt = now();
    m.remaining = Math.max(0, Number(remaining) || 0);
    for (const x of Array.isArray(staff) ? staff.slice(0, 10) : []) {
      if (!STAFF_KINDS[x?.kind]) continue;
      const sid = `${machine}:${x.kind}`;
      let mem = d.members.find((y) => y.id === sid);
      if (!mem) d.members.push((mem = { id: sid, machine, kind: x.kind, firstSeen: now() }));
      Object.assign(mem, {
        name: STAFF_KINDS[x.kind].name,
        machineName: m.name,
        present: !!x.present,
        allowed: !!d.consent[sid],
        sessions: Math.max(0, Number(x.sessions) || 0),
        lastAt: x.lastAt ? str(x.lastAt, 40) : null,
        projects: (Array.isArray(x.projects) ? x.projects.slice(0, 20) : []).map((p) => ({ cwd: str(p.cwd, 300), name: str(p.name, 80), sessions: Number(p.sessions) || 0, lastAt: p.lastAt ? str(p.lastAt, 40) : null, projectId: this.projectFor(String(p.cwd || ''), machine)?.id || null })),
        recent: (Array.isArray(x.recent) ? x.recent.slice(0, 8) : []).map((r) => ({ id: str(r.id, 100), title: str(redact(r.title), 100), cwd: str(r.cwd, 300), at: r.at ? str(r.at, 40) : null, turns: Number(r.turns) || 0 })),
        seenAt: now(),
      });
    }
    let added = 0;
    for (const n of Array.isArray(notes) ? notes.slice(0, 200) : []) if (this.#addNote(machine, n)) added++;
    if (d.notes.length > MAX_NOTES) {
      // Drop the oldest notes the person took out first, then the least confirmed.
      d.notes.sort((a, b) => (a.status === 'removed') - (b.status === 'removed') || b.count - a.count || b.updatedAt.localeCompare(a.updatedAt));
      d.notes.length = MAX_NOTES;
    }
    this.store.changed();
    return { ok: true, added };
  }

  #addNote(machine, n) {
    if (!n || !['you', 'project', 'agent'].includes(n.scope) || typeof n.text !== 'string') return false;
    const text = str(redact(n.text).replace(/\s+/g, ' ').trim(), 300);
    if (text.length < 3 || text.includes('[secret]')) return false;
    const kind = STAFF_KINDS[n.kind] ? n.kind : null;
    const staffId = kind ? `${machine}:${kind}` : null;
    if (!kind || !this.data.consent[staffId]) return false; // only from conversations the person allowed to be read
    const cwd = str(n.cwd, 300);
    const project = n.scope === 'project' ? this.projectFor(cwd, machine) : null;
    const where = n.scope === 'project' ? project?.id || path.basename(cwd || '') : n.scope === 'agent' ? staffId || '' : '';
    const key = noteKey(n.scope, text, where);
    const source = { machine, machineName: this.machineName(machine), kind, session: str(n.session, 100), sessionTitle: str(redact(n.sessionTitle || ''), 100), cwd, at: n.at ? str(n.at, 40) : now(), quote: str(redact(n.quote || ''), 200) };
    const old = this.data.notes.find((x) => x.key === key);
    if (old) {
      if (old.status === 'removed') return false; // the person took it out: it does not come back
      if (old.sources.some((s) => s.machine === source.machine && s.session === source.session)) return false;
      old.sources = [source, ...old.sources].slice(0, 5);
      old.count = (old.count || 1) + 1;
      old.updatedAt = now();
      return true;
    }
    this.data.notes.push({ id: id('nt'), key, scope: n.scope, text, projectId: project?.id || null, cwd: n.scope === 'project' ? cwd : '', staffId: n.scope === 'agent' ? staffId : null, by: n.by === 'rule' ? 'rule' : 'distilled', status: 'active', count: 1, sources: [source], createdAt: now(), updatedAt: now() });
    return true;
  }

  /** The person writes a note themselves. */
  addOwn({ text, scope = 'you', projectId = null }) {
    const t = String(text || '').replace(/\s+/g, ' ').trim();
    if (!t) throw new Error('Empty note');
    if (!['you', 'project'].includes(scope)) throw new Error('Unknown scope');
    if (scope === 'project' && !this.store.project(projectId)) throw new Error('No such project');
    const note = { id: id('nt'), key: noteKey(scope, t, scope === 'project' ? projectId : ''), scope, text: clip(t, 300), projectId: scope === 'project' ? projectId : null, cwd: '', staffId: null, by: 'you', status: 'active', count: 1, sources: [], createdAt: now(), updatedAt: now() };
    this.data.notes.push(note);
    this.store.changed();
    return note;
  }

  edit(noteId, { text, status }) {
    const n = this.data.notes.find((x) => x.id === noteId);
    if (!n) throw new Error('No such note');
    if (typeof text === 'string' && text.trim()) {
      n.text = clip(text.replace(/\s+/g, ' ').trim(), 300);
      n.edited = true;
    }
    if (status === 'active' || status === 'removed') n.status = status;
    n.updatedAt = now();
    this.store.changed();
    return n;
  }

  view() {
    const d = this.data;
    const workers = this.store.data.workers || [];
    const machines = [{ id: LOCAL, local: true }, ...workers.map((w) => ({ id: w.id, local: false, online: !!w.lastSeen && Date.now() - Date.parse(w.lastSeen) < 120_000 }))].map((x) => {
      const m = d.machines[x.id] || {};
      return { ...x, name: this.machineName(x.id), scannedAt: m.scannedAt || null, scanning: !!m.scanning, remaining: m.remaining || 0, error: m.error || null, allowed: this.allowed(x.id), pending: !!d.rescan[x.id] };
    });
    const active = d.notes.filter((n) => n.status === 'active');
    const members = d.members
      .filter((m) => machines.some((x) => x.id === m.machine))
      .map((m) => ({ ...m, allowed: !!d.consent[m.id], notes: active.filter((n) => n.staffId === m.id || n.sources.some((s) => `${s.machine}:${s.kind}` === m.id)).length }));
    return { machines, members, kinds: Object.entries(STAFF_KINDS).map(([k, v]) => ({ id: k, name: v.name })), notes: { you: active.filter((n) => n.scope === 'you').length, project: active.filter((n) => n.scope === 'project').length, agent: active.filter((n) => n.scope === 'agent').length } };
  }

  notes() {
    return this.data.notes.slice().sort((a, b) => (a.status === 'removed') - (b.status === 'removed') || (b.count || 1) - (a.count || 1) || b.updatedAt.localeCompare(a.updatedAt));
  }

  /** What every prompt is told about the person and, for a project, what the person's agents learned about it. */
  block(project) {
    const active = this.data.notes.filter((n) => n.status === 'active');
    const rank = (a, b) => (b.by === 'you') - (a.by === 'you') || (b.count || 1) - (a.count || 1) || b.updatedAt.localeCompare(a.updatedAt);
    const you = active.filter((n) => n.scope === 'you').sort(rank).slice(0, 30);
    const proj = project ? active.filter((n) => n.scope === 'project' && n.projectId === project.id).sort(rank).slice(0, 15) : [];
    const parts = [];
    if (you.length) parts.push(`About the person you work for (learned from their own conversations with their AI agents, or written by them; follow it unless the task says otherwise):\n${you.map((n) => `- ${n.text}`).join('\n')}`);
    if (proj.length) parts.push(`What the person's agents learned about this project in earlier conversations:\n${proj.map((n) => `- ${n.text}`).join('\n')}`);
    return parts.join('\n\n');
  }
}
