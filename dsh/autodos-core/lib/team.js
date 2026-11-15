// The team: staff (roles that do the work, each with the agent it runs and the machine it runs on)
// and machines (where agents run, reached through a Paseo daemon).
// Finding which agents are installed on this machine looks only at whether their command or folder
// exists. No conversation is read.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const AGENT_KINDS = {
  claude: { name: 'Claude Code', bin: 'claude', dir: '.claude', runs: true },
  codex: { name: 'Codex', bin: 'codex', dir: '.codex', runs: true },
  openclaw: { name: 'OpenClaw', bin: 'openclaw', dir: '.openclaw', runs: false },
  hermes: { name: 'Hermes', bin: 'hermes', dir: '.hermes', runs: false },
};

const onPath = (bin, env) =>
  String(env.PATH || '')
    .split(path.delimiter)
    .filter(Boolean)
    .some((dir) => {
      try {
        return fs.statSync(path.join(dir, bin)).isFile();
      } catch {
        return false;
      }
    });

/** Which agents this machine has: installed (command on PATH) and/or used before (its folder exists). */
export function detectAgents({ home = os.homedir(), env = process.env } = {}) {
  return Object.entries(AGENT_KINDS).map(([kind, k]) => ({
    kind,
    name: k.name,
    installed: onPath(k.bin, env),
    used: fs.existsSync(path.join(home, k.dir)),
    runs: k.runs, // Paseo can start it today
  }));
}

const clean = (v) => (v == null ? null : String(v).trim() || null);
const RUNTIMES = new Set(['claude', 'codex', 'auto']);

export class Team {
  constructor(ledger) {
    this.ledger = ledger;
  }

  // ---- staff ----

  staff(ref) {
    const s = String(ref ?? '').trim();
    const x = this.ledger.get('staff', s) || this.ledger.list('staff').find((y) => y.name?.toLowerCase() === s.toLowerCase());
    if (!x) throw new Error(`No staff ${ref}`);
    return x;
  }

  createStaff({ name, role, runtime = 'claude', machine = 'local', instructions, color }, { actor = 'you' } = {}) {
    if (!clean(name)) throw new Error('A staff member needs a name');
    if (this.ledger.list('staff').some((s) => s.name?.toLowerCase() === String(name).trim().toLowerCase())) throw new Error(`${name} already exists`);
    if (!RUNTIMES.has(runtime)) throw new Error(`Runtime must be one of ${[...RUNTIMES].join(', ')}`);
    const at = this.machine(machine || 'local').id;
    return this.ledger.create('staff', { kind: 'role', name: clean(name), role: clean(role) || '', runtime, machine: at, instructions: clean(instructions) || '', color: clean(color) || '', source: 'autodos-core' }, { actor, reason: 'new staff' });
  }

  updateStaff(ref, patch = {}, { actor = 'you' } = {}) {
    const s = this.staff(ref);
    const next = {};
    for (const k of ['name', 'role', 'instructions', 'color']) if (k in patch) next[k] = clean(patch[k]) || '';
    if ('name' in next && !next.name) throw new Error('A staff member needs a name');
    if ('runtime' in patch) {
      if (!RUNTIMES.has(patch.runtime)) throw new Error(`Runtime must be one of ${[...RUNTIMES].join(', ')}`);
      next.runtime = patch.runtime;
    }
    if ('machine' in patch) next.machine = this.machine(patch.machine || 'local').id;
    return this.ledger.update('staff', s.id, next, { actor, reason: 'staff settings' });
  }

  removeStaff(ref, { actor = 'you' } = {}) {
    const s = this.staff(ref);
    const busy = this.ledger.list('task', { where: (t) => t.staffId === s.id && !['done', 'dropped', 'failed'].includes(t.state) });
    if (busy.length) throw new Error(`${s.name} still has ${busy.length} open task(s): ${busy.slice(0, 5).map((t) => `#${t.number}`).join(', ')}`);
    this.ledger.remove('staff', s.id, { actor, reason: 'removed' });
    return { removed: s.id };
  }

  // ---- machines ----

  machine(ref) {
    const s = String(ref ?? '').trim();
    const x = this.ledger.get('machine', s) || this.ledger.list('machine').find((y) => y.name?.toLowerCase() === s.toLowerCase());
    if (!x) throw new Error(`No machine ${ref}`);
    return x;
  }

  createMachine({ name, paseoHost, capacity, notes }, { actor = 'you' } = {}) {
    if (!clean(name)) throw new Error('A machine needs a name');
    if (!clean(paseoHost)) throw new Error('A machine needs the address of its Paseo daemon, e.g. 192.168.1.20:6767');
    if (this.ledger.list('machine').some((m) => m.name?.toLowerCase() === String(name).trim().toLowerCase())) throw new Error(`${name} already exists`);
    return this.ledger.create('machine', { name: clean(name), local: false, executor: 'paseo', paseoHost: clean(paseoHost), capacity: Number(capacity) > 0 ? Number(capacity) : 2, notes: clean(notes) || '', source: 'autodos-core' }, { actor, reason: 'new machine' });
  }

  updateMachine(ref, patch = {}, { actor = 'you' } = {}) {
    const m = this.machine(ref);
    const next = {};
    for (const k of ['name', 'notes']) if (k in patch) next[k] = clean(patch[k]) || '';
    if ('name' in next && !next.name) throw new Error('A machine needs a name');
    if ('paseoHost' in patch) {
      if (m.local && clean(patch.paseoHost)) throw new Error('This machine runs agents itself; it has no Paseo address');
      if (!m.local && !clean(patch.paseoHost)) throw new Error('A machine needs the address of its Paseo daemon');
      next.paseoHost = clean(patch.paseoHost);
    }
    if ('capacity' in patch) next.capacity = Number(patch.capacity) > 0 ? Number(patch.capacity) : null;
    return this.ledger.update('machine', m.id, next, { actor, reason: 'machine settings' });
  }

  removeMachine(ref, { actor = 'you' } = {}) {
    const m = this.machine(ref);
    if (m.local) throw new Error('This machine cannot be removed');
    const running = this.ledger.list('thread', { where: (t) => t.active && t.machine === m.id });
    if (running.length) throw new Error(`${m.name} still runs ${running.length} agent(s)`);
    const staff = this.ledger.list('staff', { where: (s) => s.machine === m.id });
    if (staff.length) throw new Error(`Move ${staff.map((s) => s.name).join(', ')} to another machine first`);
    this.ledger.remove('machine', m.id, { actor, reason: 'removed' });
    return { removed: m.id };
  }

  /** Record what agents this machine has. */
  noteAgents(machineId, agents) {
    const m = this.ledger.get('machine', machineId);
    if (!m) return null;
    return this.ledger.update('machine', m.id, { agents, agentsSeenAt: new Date().toISOString() }, { actor: 'system', reason: 'agents found' });
  }

  // ---- the roster ----

  /** Staff and machines with what each is doing now. */
  roster() {
    const l = this.ledger;
    const tasks = l.list('task');
    const threads = l.list('thread');
    const open = (t) => !['done', 'dropped'].includes(t.state);
    const spentOf = (pred) => Math.round(threads.filter(pred).reduce((s, t) => s + (Number(t.costUsd) || 0), 0) * 100) / 100;
    const machines = l.list('machine').map((m) => {
      const running = threads.filter((t) => t.active && t.machine === m.id);
      return {
        ...m,
        running: running.length,
        tasks: tasks.filter((t) => open(t) && t.machine === m.id).map((t) => ({ id: t.id, number: t.number, title: t.title, state: t.state })).slice(0, 20),
        staff: l.list('staff', { where: (s) => (s.machine || 'local') === m.id }).map((s) => ({ id: s.id, name: s.name })),
        spentUsd: spentOf((t) => t.machine === m.id),
        lastActiveAt: threads.filter((t) => t.machine === m.id).map((t) => t.updatedAt).sort().pop() || null,
      };
    });
    const staff = l.list('staff').map((s) => {
      const mine = tasks.filter((t) => t.staffId === s.id);
      const ids = new Set(mine.map((t) => t.id));
      return {
        ...s,
        machineName: l.get('machine', s.machine || 'local')?.name || s.machine || null,
        counts: {
          waiting: mine.filter((t) => t.state === 'waiting_you').length,
          working: mine.filter((t) => ['working', 'review', 'landing'].includes(t.state)).length,
          stuck: mine.filter((t) => ['stuck', 'failed'].includes(t.state)).length,
          queued: mine.filter((t) => t.state === 'queued').length,
          done: mine.filter((t) => t.state === 'done').length,
        },
        tasks: mine.filter(open).map((t) => ({ id: t.id, number: t.number, title: t.title, state: t.state })).slice(0, 20),
        spentUsd: spentOf((t) => ids.has(t.taskId)),
        lastActiveAt: mine.map((t) => t.lastProgressAt || t.updatedAt).sort().pop() || null,
      };
    });
    return { staff, machines, kinds: AGENT_KINDS };
  }
}
