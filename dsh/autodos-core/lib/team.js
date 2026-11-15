// The team, in three layers that each answer one question:
// - staff: who does what. A role with responsibilities and standing instructions, and which kind
//   of agent it prefers. Not tied to a machine.
// - agents: what does the work. One installed agent on one machine ("Claude Code on the Mac mini"),
//   with its own limits: how many it runs at once, whether it is switched off or out of quota.
// - machines: where it runs. This machine, or another one reached through its Paseo daemon.
// A task goes to a staff member; when it starts, a free agent of the kind they prefer is picked.
// Finding which agents are installed looks only at whether their command or folder exists.
// No conversation is read.
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

/** "You've hit your limit · resets 3pm" and the like. */
export const LIMIT_RE = /(hit your [^\n]*limit|usage limit|limit reached|rate[- ]limit(ed)?|quota (exceeded|reached))/i;

/** When a limit message says it resets ("resets 3pm", "resets at 15:30"), that time; else an hour from now. */
export function limitUntil(text, now = new Date()) {
  const m = String(text || '').match(/resets?\s+(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i);
  if (m) {
    let h = Number(m[1]) % 24;
    const min = Number(m[2] || 0);
    if (m[3]) h = (h % 12) + (m[3].toLowerCase() === 'pm' ? 12 : 0);
    const at = new Date(now);
    at.setHours(h, min, 0, 0);
    if (at <= now) at.setDate(at.getDate() + 1);
    return at.toISOString();
  }
  return new Date(now.getTime() + 60 * 60 * 1000).toISOString();
}

/** The agent a thread ran on; threads from before agents were their own layer name only machine and kind. */
export const agentOfThread = (t) => t.agentRef || (t.machine && t.runtime ? `${t.machine}:${t.runtime}` : null);

const clean = (v) => (v == null ? null : String(v).trim() || null);
const PREFS = new Set(['claude', 'codex', 'auto']);
const findBy = (list, s) => list.find((y) => y.name?.toLowerCase() === s.toLowerCase());

export class Team {
  constructor(ledger, { provider = 'claude' } = {}) {
    this.ledger = ledger;
    this.provider = provider; // the kind "auto" tries first
  }

  // ---- staff ----

  staff(ref) {
    const s = String(ref ?? '').trim();
    const x = this.ledger.get('staff', s) || findBy(this.ledger.list('staff'), s);
    if (!x) throw new Error(`No staff ${ref}`);
    return x;
  }

  #pin(ref) {
    if (!clean(ref)) return '';
    const a = this.agent(ref);
    if (!AGENT_KINDS[a.kind]?.runs) throw new Error(`${a.name} cannot take tasks yet`);
    return a.id;
  }

  /** prefer: the kind of agent (claude, codex or auto); agent: one agent this role always uses. */
  createStaff({ name, role, prefer, runtime, agent, instructions, color }, { actor = 'you' } = {}) {
    if (!clean(name)) throw new Error('A staff member needs a name');
    if (this.ledger.list('staff').some((s) => s.name?.toLowerCase() === String(name).trim().toLowerCase())) throw new Error(`${name} already exists`);
    const pref = prefer ?? runtime ?? 'auto';
    if (!PREFS.has(pref)) throw new Error(`Preferred agent must be one of ${[...PREFS].join(', ')}`);
    return this.ledger.create('staff', { kind: 'role', name: clean(name), role: clean(role) || '', runtime: pref, agent: this.#pin(agent), instructions: clean(instructions) || '', color: clean(color) || '', source: 'autodos-core' }, { actor, reason: 'new staff' });
  }

  updateStaff(ref, patch = {}, { actor = 'you' } = {}) {
    const s = this.staff(ref);
    const next = {};
    for (const k of ['name', 'role', 'instructions', 'color']) if (k in patch) next[k] = clean(patch[k]) || '';
    if ('name' in next && !next.name) throw new Error('A staff member needs a name');
    const pref = patch.prefer ?? patch.runtime;
    if (pref !== undefined) {
      if (!PREFS.has(pref)) throw new Error(`Preferred agent must be one of ${[...PREFS].join(', ')}`);
      next.runtime = pref;
    }
    if ('agent' in patch) next.agent = this.#pin(patch.agent);
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
    const x = this.ledger.get('machine', s) || findBy(this.ledger.list('machine'), s);
    if (!x) throw new Error(`No machine ${ref}`);
    return x;
  }

  /** agents: the kinds installed there, e.g. ['claude', 'codex'] (a remote machine is not inspected). */
  createMachine({ name, paseoHost, capacity, notes, agents = ['claude'] }, { actor = 'you' } = {}) {
    if (!clean(name)) throw new Error('A machine needs a name');
    if (!clean(paseoHost)) throw new Error('A machine needs the address of its Paseo daemon, e.g. 192.168.1.20:6767');
    if (this.ledger.list('machine').some((m) => m.name?.toLowerCase() === String(name).trim().toLowerCase())) throw new Error(`${name} already exists`);
    return this.ledger.transaction(() => {
      const m = this.ledger.create('machine', { name: clean(name), local: false, executor: 'paseo', paseoHost: clean(paseoHost), capacity: Number(capacity) > 0 ? Number(capacity) : 2, notes: clean(notes) || '', source: 'autodos-core' }, { actor, reason: 'new machine' });
      for (const kind of agents || []) this.addAgent(m.id, kind, { actor });
      return m;
    });
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
    const pinned = this.ledger.list('staff', { where: (s) => s.agent && this.ledger.get('agent', s.agent)?.machine === m.id });
    if (pinned.length) throw new Error(`${pinned.map((s) => s.name).join(', ')} always use an agent there; change that first`);
    this.ledger.transaction(() => {
      for (const a of this.ledger.list('agent', { where: (a) => a.machine === m.id })) this.ledger.remove('agent', a.id, { actor, reason: 'machine removed' });
      this.ledger.remove('machine', m.id, { actor, reason: 'removed' });
    });
    return { removed: m.id };
  }

  // ---- agents ----

  agents(where) {
    return this.ledger.list('agent', where ? { where } : undefined);
  }

  agent(ref) {
    const s = String(ref ?? '').trim();
    const x = this.ledger.get('agent', s) || findBy(this.agents(), s);
    if (!x) throw new Error(`No agent ${ref}`);
    return x;
  }

  #label(kind, machineId) {
    const m = this.ledger.get('machine', machineId);
    return `${AGENT_KINDS[kind]?.name || kind} @ ${m?.name || machineId}`;
  }

  /** Add an agent someone says a machine has. */
  addAgent(machineRef, kind, { actor = 'you', capacity } = {}) {
    const m = this.machine(machineRef);
    if (!AGENT_KINDS[kind]) throw new Error(`Agent must be one of ${Object.keys(AGENT_KINDS).join(', ')}`);
    const id = `${m.id}:${kind}`;
    const was = this.ledger.get('agent', id);
    if (was) return this.ledger.update('agent', id, { installed: true, enabled: true }, { actor, reason: 'agent added' });
    return this.ledger.create('agent', { id, machine: m.id, kind, name: this.#label(kind, m.id), installed: true, used: true, detected: false, enabled: true, capacity: Number(capacity) > 0 ? Number(capacity) : 2, limitedUntil: null, limitNote: null, source: 'autodos-core' }, { actor, reason: 'agent added' });
  }

  updateAgent(ref, patch = {}, { actor = 'you' } = {}) {
    const a = this.agent(ref);
    const next = {};
    if ('enabled' in patch) next.enabled = Boolean(patch.enabled);
    if ('capacity' in patch) next.capacity = Number(patch.capacity) > 0 ? Number(patch.capacity) : 1;
    if ('notes' in patch) next.notes = clean(patch.notes) || '';
    if (patch.clearLimit) Object.assign(next, { limitedUntil: null, limitNote: null });
    return this.ledger.update('agent', a.id, next, { actor, reason: 'agent settings' });
  }

  removeAgent(ref, { actor = 'you' } = {}) {
    const a = this.agent(ref);
    const running = this.ledger.list('thread', { where: (t) => t.active && agentOfThread(t) === a.id });
    if (running.length) throw new Error(`${a.name} is still running ${running.length} task(s)`);
    const pinned = this.ledger.list('staff', { where: (s) => s.agent === a.id });
    if (pinned.length) throw new Error(`${pinned.map((s) => s.name).join(', ')} always use ${a.name}; change that first`);
    this.ledger.remove('agent', a.id, { actor, reason: 'removed' });
    return { removed: a.id };
  }

  /** Record what agents a machine has: one agent per kind it has installed or used. */
  noteAgents(machineId, found) {
    const m = this.ledger.get('machine', machineId);
    if (!m) return null;
    const l = this.ledger;
    return l.transaction(() => {
      for (const f of found || []) {
        const id = `${m.id}:${f.kind}`;
        const was = l.get('agent', id);
        const has = Boolean(f.installed || f.used);
        if (was) {
          if (was.detected !== false && (was.installed !== f.installed || was.used !== f.used)) l.update('agent', id, { installed: f.installed, used: f.used }, { actor: 'system', reason: 'agents found' });
        } else if (has) {
          l.create('agent', { id, machine: m.id, kind: f.kind, name: this.#label(f.kind, m.id), installed: f.installed, used: f.used, detected: true, enabled: true, capacity: 2, limitedUntil: null, limitNote: null, source: 'autodos-core' }, { actor: 'system', reason: 'agents found' });
        }
      }
      return l.update('machine', m.id, { agents: found, agentsSeenAt: new Date().toISOString() }, { actor: 'system', reason: 'agents found' });
    });
  }

  /** The agent hit its account's limit: it takes no new tasks until then. */
  markLimited(agentRef, text, now = new Date()) {
    const a = agentRef && this.ledger.get('agent', agentRef);
    if (!a) return null;
    const until = limitUntil(text, now);
    if (a.limitedUntil && a.limitedUntil >= until) return a;
    return this.ledger.update('agent', a.id, { limitedUntil: until, limitNote: String(text).slice(0, 200) }, { actor: 'system', reason: 'usage limit' });
  }

  /** ready, off, limited, missing (not installed) or cannot (Paseo cannot start it yet). */
  statusOf(a, now = new Date()) {
    if (!AGENT_KINDS[a.kind]?.runs) return 'cannot';
    if (a.enabled === false) return 'off';
    if (a.installed === false && !a.used) return 'missing';
    if (a.limitedUntil && new Date(a.limitedUntil) > now) return 'limited';
    return 'ready';
  }

  #running() {
    const byAgent = new Map();
    const byMachine = new Map();
    for (const t of this.ledger.list('thread', { where: (t) => t.active })) {
      const ref = agentOfThread(t);
      if (ref) byAgent.set(ref, (byAgent.get(ref) || 0) + 1);
      if (t.machine) byMachine.set(t.machine, (byMachine.get(t.machine) || 0) + 1);
    }
    return { byAgent, byMachine };
  }

  /**
   * Who runs a task: the agent the task asks for, else the one its staff member always uses,
   * else a free agent of the kind they prefer (then any kind that runs), on the task's machine if
   * it names one. Returns {agent} or {agent: null, reason}.
   */
  pickAgent({ task = {}, staff = null, now = new Date() } = {}) {
    const { byAgent, byMachine } = this.#running();
    const free = (a) => {
      const m = this.ledger.get('machine', a.machine);
      if (!m) return false;
      if ((byAgent.get(a.id) || 0) >= (Number(a.capacity) || 2)) return false;
      if (m.capacity && (byMachine.get(m.id) || 0) >= Number(m.capacity)) return false;
      return true;
    };
    const fixed = task.agentChoice || staff?.agent;
    if (fixed) {
      const a = this.ledger.get('agent', fixed);
      if (!a) return { agent: null, reason: `The agent ${fixed} is no longer on the team` };
      const st = this.statusOf(a, now);
      if (st !== 'ready') return { agent: null, reason: `${a.name} is ${STATUS_TEXT[st]}` };
      if (!free(a)) return { agent: null, reason: `${a.name} is busy; it takes it when a slot frees up` };
      return { agent: a };
    }
    const pref = task.runtime || (staff && staff.runtime !== 'auto' ? staff.runtime : null);
    const order = [pref || this.provider, ...Object.keys(AGENT_KINDS)].filter((k, i, all) => k && all.indexOf(k) === i);
    const all = this.agents((a) => !task.machineChoice || a.machine === task.machineChoice);
    const ready = all.filter((a) => this.statusOf(a, now) === 'ready');
    const pool = task.runtime ? ready.filter((a) => a.kind === task.runtime) : ready;
    const sorted = pool
      .filter(free)
      .sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind) || (this.ledger.get('machine', b.machine)?.local ? 1 : 0) - (this.ledger.get('machine', a.machine)?.local ? 1 : 0) || (byAgent.get(a.id) || 0) - (byAgent.get(b.id) || 0));
    if (sorted.length) return { agent: sorted[0] };
    if (!all.length) return { agent: null, reason: task.machineChoice ? 'That machine has no agents' : 'No agents yet: add a machine with Claude Code or Codex' };
    if (!pool.length) {
      const limited = all.filter((a) => this.statusOf(a, now) === 'limited');
      if (limited.length) return { agent: null, reason: `Out of quota: ${limited.map((a) => `${a.name} until ${new Date(a.limitedUntil).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`).join(', ')}` };
      return { agent: null, reason: pref ? `No ${AGENT_KINDS[pref]?.name || pref} is available` : 'No agent is available' };
    }
    return { agent: null, reason: 'Every agent is busy; it starts when one frees up' };
  }

  // ---- the roster ----

  /** Staff, agents and machines with what each is doing now. */
  roster(now = new Date()) {
    const l = this.ledger;
    const tasks = l.list('task');
    const threads = l.list('thread');
    const open = (t) => !['done', 'dropped'].includes(t.state);
    const spentOf = (pred) => Math.round(threads.filter(pred).reduce((s, t) => s + (Number(t.costUsd) || 0), 0) * 100) / 100;
    const mini = (t) => ({ id: t.id, number: t.number, title: t.title, state: t.state });
    const agents = this.agents().map((a) => {
      const mine = threads.filter((t) => agentOfThread(t) === a.id);
      const running = mine.filter((t) => t.active);
      return {
        ...a,
        kindName: AGENT_KINDS[a.kind]?.name || a.kind,
        status: this.statusOf(a, now),
        running: running.length,
        tasks: running.map((t) => l.get('task', t.taskId)).filter(Boolean).map(mini),
        spentUsd: spentOf((t) => agentOfThread(t) === a.id),
        lastActiveAt: mine.map((t) => t.updatedAt).sort().pop() || null,
      };
    });
    const rank = Object.keys(AGENT_KINDS);
    agents.sort((x, y) => (x.status === 'cannot') - (y.status === 'cannot') || rank.indexOf(x.kind) - rank.indexOf(y.kind));
    const machines = l.list('machine').sort((x, y) => (y.local ? 1 : 0) - (x.local ? 1 : 0)).map((m) => ({
      ...m,
      running: threads.filter((t) => t.active && t.machine === m.id).length,
      agents: agents.filter((a) => a.machine === m.id),
      found: m.agents || [],
      spentUsd: spentOf((t) => t.machine === m.id),
      lastActiveAt: threads.filter((t) => t.machine === m.id).map((t) => t.updatedAt).sort().pop() || null,
    }));
    const staff = l.list('staff').map((s) => {
      const mine = tasks.filter((t) => t.staffId === s.id);
      const ids = new Set(mine.map((t) => t.id));
      const pinned = s.agent ? agents.find((a) => a.id === s.agent) : null;
      return {
        ...s,
        prefer: s.runtime || 'auto',
        agentName: pinned?.name || null,
        counts: {
          waiting: mine.filter((t) => t.state === 'waiting_you').length,
          working: mine.filter((t) => ['working', 'review', 'landing'].includes(t.state)).length,
          stuck: mine.filter((t) => ['stuck', 'failed'].includes(t.state)).length,
          queued: mine.filter((t) => t.state === 'queued').length,
          done: mine.filter((t) => t.state === 'done').length,
        },
        tasks: mine.filter(open).map(mini).slice(0, 20),
        spentUsd: spentOf((t) => ids.has(t.taskId)),
        lastActiveAt: mine.map((t) => t.lastProgressAt || t.updatedAt).sort().pop() || null,
      };
    });
    return { staff, agents, machines, kinds: AGENT_KINDS };
  }
}

const STATUS_TEXT = { off: 'switched off', limited: 'out of quota', missing: 'not installed', cannot: 'not something Autodos can start yet' };
