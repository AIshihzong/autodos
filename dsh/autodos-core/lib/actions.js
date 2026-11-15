// What can be done to tasks, and the loop that keeps the board in step with the agents running them.
// Every action is a ledger event with who did it and why, so the timeline shows the whole story.
//
// The flow: create a task → dispatch it (Paseo starts Claude Code in a new worktree and branch) →
// sync follows the agent: its output lands in the timeline, a permission request becomes an open
// decision that waits on the person, and a finished turn becomes a "look at the result" decision.
// The person replies, retries, allows or denies, accepts or sends back, from the panel.
//
// Permission requests are only ever answered by the person (the panel routes), never by an agent tool.

import os from 'node:os';
import { Team, LIMIT_RE } from './team.js';

const ACTIVE = new Set(['running', 'busy', 'working', 'thinking', 'starting', 'initializing']);
const IDLE = new Set(['idle', 'done', 'finished', 'completed', 'stopped', 'waiting']);
const BROKEN = new Set(['error', 'failed', 'crashed', 'closed', 'exited', 'killed']);

export const RESULT_OPTIONS = ['Accept', 'Keep working'];
export const PERMISSION_OPTIONS = ['Allow', 'Deny'];
export const BUDGET_OPTIONS = ['Add budget', 'Close'];

export class Autodos {
  /**
   * @param {import('./store.js').Ledger} ledger
   * @param {{paseo?: ReturnType<import('./paseo.js').createPaseo>, provider?: string, mode?: string, log?: (m: string) => void}} opts
   */
  constructor(ledger, { team = null, paseo = null, paseoFor = null, git = null, check = null, provider = 'claude', mode, budgetUsd, budgetStepUsd, log = () => {} } = {}) {
    this.ledger = ledger;
    this.paseo = paseo; // the Paseo daemon on this machine
    this.paseoFor = paseoFor; // (host) => a Paseo client for another machine's daemon
    this.remote = new Map();
    // This machine is always on the team, imported or not.
    if (!ledger.get('machine', 'local')) ledger.create('machine', { id: 'local', name: os.hostname(), local: true, executor: 'paseo' }, { actor: 'system', reason: 'this machine' });
    this.team = team || new Team(ledger, { provider });
    // Until this machine's agents are found, assume it has the default one, so a task can start.
    if (!ledger.list('agent', { where: (a) => a.machine === 'local' }).length) {
      ledger.create('agent', { id: `local:${provider}`, machine: 'local', kind: provider, name: `${provider === 'codex' ? 'Codex' : 'Claude Code'} @ ${ledger.get('machine', 'local').name}`, detected: true, enabled: true, capacity: 2, limitedUntil: null, limitNote: null, source: 'autodos-core' }, { actor: 'system', reason: 'this machine' });
    }
    this.git = git; // lib/land.js createGit(); without it an accepted task is marked done but not merged
    this.check = check; // lib/land.js runCheck
    this.budgetUsd = Number(budgetUsd) > 0 ? Number(budgetUsd) : Number(ledger.get('settings', 'autodos')?.budgetUsd) || 5;
    this.budgetStepUsd = Number(budgetStepUsd) > 0 ? Number(budgetStepUsd) : this.budgetUsd;
    this.provider = provider;
    this.mode = mode;
    this.log = log;
    this.syncing = null;
  }

  /** The Paseo client for a machine: this machine's own, or one for the daemon at the machine's address. */
  paseoOn(machineId) {
    const m = machineId ? this.ledger.get('machine', machineId) : null;
    if (!m || m.local || !m.paseoHost) return this.paseo;
    if (!this.paseoFor) return null;
    if (!this.remote.has(m.paseoHost)) this.remote.set(m.paseoHost, this.paseoFor(m.paseoHost));
    return this.remote.get(m.paseoHost);
  }

  agentOf(thread) {
    return thread ? this.paseoOn(thread.machine) : null;
  }

  // ---- reading ----

  task(ref) {
    const l = this.ledger;
    const s = String(ref ?? '').trim();
    const t = l.get('task', s) || l.list('task').find((x) => x.number != null && String(x.number) === s.replace(/^#/, ''));
    if (!t) throw new Error(`No task ${ref}`);
    return t;
  }

  project(ref) {
    const s = String(ref ?? '').trim();
    const p = this.ledger.get('project', s) || this.ledger.list('project').find((x) => x.name?.toLowerCase() === s.toLowerCase());
    if (!p) throw new Error(`No project ${ref}`);
    return p;
  }

  threadOf(task) {
    return task.threadId ? this.ledger.get('thread', task.threadId) : null;
  }

  openDecisions(taskId, kind) {
    return this.ledger.list('decision', { where: (d) => d.open && d.taskId === taskId && (!kind || d.kind === kind) });
  }

  // ---- creating ----

  createProject({ name, path, description, check, budgetUsd, base }, { actor = 'you' } = {}) {
    if (!name) throw new Error('A project needs a name');
    if (!path) throw new Error('A project needs the path of its repository');
    if (this.ledger.list('project').some((p) => p.name?.toLowerCase() === String(name).toLowerCase())) throw new Error(`Project ${name} already exists`);
    return this.ledger.create('project', { name, path, description: description || '', check: check || null, budgetUsd: Number(budgetUsd) > 0 ? Number(budgetUsd) : null, base: base || null, source: 'autodos-core' }, { actor, reason: 'new project' });
  }

  /** Change a project's check command, budget per task, base branch or path. */
  updateProject(ref, patch = {}, { actor = 'you' } = {}) {
    const p = this.project(ref);
    const next = {};
    for (const k of ['path', 'description', 'check', 'base']) if (k in patch) next[k] = patch[k] || null;
    if ('budgetUsd' in patch) next.budgetUsd = Number(patch.budgetUsd) > 0 ? Number(patch.budgetUsd) : null;
    return this.ledger.update('project', p.id, next, { actor, reason: 'project settings' });
  }

  /** What a task may spend, and what it has spent across all its runs. */
  budget(task) {
    const project = task.projectId ? this.ledger.get('project', task.projectId) : null;
    const limit = Number(task.budgetUsd) || Number(project?.budgetUsd) || this.budgetUsd;
    const spent = this.ledger.list('thread', { where: (t) => t.taskId === task.id }).reduce((sum, t) => sum + (Number(t.costUsd) || 0), 0);
    return { limit, spent: Math.round(spent * 100) / 100 };
  }

  async createTask({ title, description = '', projectId, project, staffId = null, staff, machine, agent, provider, start = true }, { actor = 'you', reason } = {}) {
    if (!title) throw new Error('A task needs a title');
    const p = projectId || project ? this.project(projectId || project) : null;
    const s = staffId || staff ? this.ledger.get('staff', staffId || staff) || this.ledger.list('staff').find((x) => x.name?.toLowerCase() === String(staffId || staff).toLowerCase()) : null;
    if ((staffId || staff) && !s) throw new Error(`No staff ${staffId || staff}`);
    staffId = s?.id || null;
    const m = machine ? this.ledger.get('machine', machine) || this.ledger.list('machine').find((x) => x.name?.toLowerCase() === String(machine).toLowerCase()) : null;
    if (machine && !m) throw new Error(`No machine ${machine}`);
    const a = agent ? this.team.agent(agent) : null;
    const number = Math.max(0, ...this.ledger.list('task', { removed: true }).map((t) => Number(t.number) || 0)) + 1;
    const task = this.ledger.create(
      'task',
      { number, title, description, projectId: p?.id || null, goalId: null, staffId, runtime: provider || null, machineChoice: m?.id || null, agentChoice: a?.id || null, state: 'queued', labels: [], dependsOn: [], lastProgressAt: new Date().toISOString(), source: 'autodos-core' },
      { actor, reason: reason || 'new task' },
    );
    if (start && p) return this.dispatch(task.id, { actor });
    return task;
  }

  // ---- running ----

  async dispatch(ref, { actor = 'you', extra } = {}) {
    const task = this.task(ref);
    if (!task.projectId) throw new Error(`#${task.number} has no project, so there is no repository to work in`);
    const project = this.project(task.projectId);
    const staff = task.staffId ? this.ledger.get('staff', task.staffId) : null;
    // Who runs it: a free agent of the kind the staff member prefers; that agent's machine is where.
    const pick = this.team.pickAgent({ task, staff });
    if (!pick.agent) {
      if (task.waitingFor === pick.reason && task.wantsAgent) return task;
      return this.ledger.update('task', task.id, { state: 'queued', wantsAgent: true, waitingKind: 'agent', waitingFor: pick.reason, stuck: null }, { actor, reason: 'waiting for an agent' });
    }
    const agent = pick.agent;
    const machine = this.ledger.get('machine', agent.machine);
    if (!machine) throw new Error(`No machine ${agent.machine}`);
    const paseo = this.paseoOn(machine.id);
    if (!paseo) throw new Error(machine.local ? 'No execution layer: Paseo is not configured' : `${machine.name} has no Paseo address`);
    const cwd = machine.local ? project.path : project.paths?.[machine.id];
    if (!cwd) throw new Error(machine.local ? `Project ${project.name} has no repository path` : `Project ${project.name} has no checkout on ${machine.name}`);
    const branch = task.branch || `autodos/${task.number}`;
    const base = task.base || project.base || (this.git && machine.local ? await this.git.currentBranch(cwd) : null) || undefined;
    const runtime = agent.kind;
    const prompt = taskPrompt(task, project, branch, extra, staff);
    const run = await paseo.dispatch({ cwd, prompt, provider: runtime, branch, base, title: `#${task.number} ${task.title}`.slice(0, 80), mode: this.mode });
    const l = this.ledger;
    return l.transaction(() => {
      const old = this.threadOf(task);
      if (old?.active) l.update('thread', old.id, { active: false, status: 'replaced' }, { actor: 'system', task: task.id, reason: 'dispatched again' });
      const thread = l.create(
        'thread',
        { taskId: task.id, machine: machine.id, agentRef: agent.id, staffId: staff?.id || null, runtime: run.provider || runtime, agentId: run.agentId, sessionId: run.agentId, cwd, branch, base: base || null, prompt, status: run.status || 'running', active: true, source: 'paseo' },
        { actor, task: task.id, reason: 'dispatched to Paseo' },
      );
      return l.update('task', task.id, { state: 'working', threadId: thread.id, branch, base: base || null, machine: machine.id, agentRef: agent.id, runtime, wantsAgent: null, landPending: null, stuck: null, waitingFor: null, waitingKind: null, lastProgressAt: new Date().toISOString() }, { actor, reason: `started ${thread.runtime} on ${branch}` });
    });
  }

  /** Say something on a task. If an agent is on it, it gets the message. */
  async reply(ref, text, { actor = 'you' } = {}) {
    const task = this.task(ref);
    text = String(text ?? '').trim();
    if (!text) throw new Error('Nothing to say');
    const l = this.ledger;
    const thread = this.threadOf(task);
    l.record('thread.message', { text, threadId: thread?.id || null }, { actor, task: task.id });
    const paseo = this.agentOf(thread);
    if (!thread?.active || !paseo) return { task: l.get('task', task.id), sent: false };
    await paseo.send({ agentId: thread.agentId, text });
    l.transaction(() => {
      for (const d of this.openDecisions(task.id, 'result')) l.update('decision', d.id, { open: false, choice: 'replied', decidedBy: actor }, { actor, task: task.id, reason: 'replied instead' });
      l.update('task', task.id, { state: 'working', waitingFor: null, waitingKind: null, stuck: null, lastProgressAt: new Date().toISOString() }, { actor, reason: 'replied' });
    });
    return { task: l.get('task', task.id), sent: true };
  }

  /** Try again: nudge the agent if it is still there, else start a fresh one on the same branch. */
  async retry(ref, { actor = 'you', note } = {}) {
    const task = this.task(ref);
    if (task.landPending) return this.land(task.id, { actor });
    const thread = this.threadOf(task);
    const why = task.stuck ? `It stopped with: ${task.stuck.split('\n')[0].slice(0, 300)}` : '';
    if (thread?.active && this.agentOf(thread) && !BROKEN.has(thread.status)) {
      return (await this.reply(task.id, [note || 'Please try again.', why].filter(Boolean).join('\n'), { actor })).task;
    }
    return this.dispatch(task.id, { actor, extra: [note, why && `An earlier attempt failed. ${why}`].filter(Boolean).join('\n') });
  }

  /** Answer an open decision. `choice` is an option index or label; `note` goes to the agent when sending back. */
  async decide(decisionId, choice, { actor = 'you', note } = {}) {
    const l = this.ledger;
    const d = l.get('decision', decisionId);
    if (!d) throw new Error(`No decision ${decisionId}`);
    if (!d.open) throw new Error('That decision is already closed');
    const options = d.options || [];
    const picked = typeof choice === 'number' ? options[choice] : options.find((o) => o.toLowerCase() === String(choice).toLowerCase()) ?? choice;
    if (options.length && !options.includes(picked)) throw new Error(`Choose one of: ${options.join(', ')}`);
    const task = d.taskId ? this.task(d.taskId) : null;
    const close = (reason) => l.update('decision', d.id, { open: false, choice: picked, note: note || null, decidedBy: actor, decidedAt: new Date().toISOString() }, { actor, task: task?.id, reason });

    if (d.kind === 'permission') {
      const thread = l.get('thread', d.threadId);
      const allow = picked === PERMISSION_OPTIONS[0];
      await this.agentOf(thread).permit({ agentId: thread.agentId, requestId: d.permissionId, allow });
      l.transaction(() => {
        close(allow ? 'allowed' : 'denied');
        if (!this.openDecisions(task.id, 'permission').length) l.update('task', task.id, { state: 'working', waitingFor: null, waitingKind: null, lastProgressAt: new Date().toISOString() }, { actor, reason: allow ? 'allowed' : 'denied' });
      });
      if (!allow && note) await this.reply(task.id, note, { actor });
      return l.get('task', task.id);
    }

    if (d.kind === 'result') {
      if (picked === RESULT_OPTIONS[0]) {
        close('accepted');
        return this.land(task.id, { actor });
      }
      if (!note) throw new Error('Say what to change');
      close('sent back');
      return (await this.reply(task.id, note, { actor })).task;
    }

    if (d.kind === 'budget') {
      close(picked === BUDGET_OPTIONS[0] ? 'more budget' : 'closed');
      if (picked !== BUDGET_OPTIONS[0]) return this.drop(task.id, { actor, reason: 'stopped at the budget' });
      const { spent } = this.budget(task);
      l.update('task', task.id, { budgetUsd: Math.round((spent + this.budgetStepUsd) * 100) / 100 }, { actor, reason: 'more budget' });
      return this.dispatch(task.id, { actor, extra: [note, 'An earlier run stopped at its budget. Your earlier commits are on this branch: continue from there.'].filter(Boolean).join('\n') });
    }

    // An imported or free-form decision: record the answer; the task moves on when someone acts on it.
    close('decided');
    if (note && task) l.record('thread.message', { text: note }, { actor, task: task.id });
    return task ? l.get('task', task.id) : null;
  }

  // ---- landing ----

  /** Check the task's work, then merge its branch into the base. Anything that stops it says why. */
  async land(ref, { actor = 'you' } = {}) {
    const l = this.ledger;
    const task = this.task(ref);
    const project = task.projectId ? this.project(task.projectId) : null;
    const thread = this.threadOf(task);
    const branch = task.branch;
    const now = () => new Date().toISOString();
    l.update('task', task.id, { state: 'landing', waitingFor: null, waitingKind: null, stuck: null, landPending: null, lastProgressAt: now() }, { actor, reason: 'landing' });
    const sendBack = async (text, reason) => {
      if (thread?.active && this.agentOf(thread)) {
        l.record('task.landing', { ok: false, reason, text }, { actor: 'system', task: task.id });
        return (await this.reply(task.id, text, { actor: 'system' })).task;
      }
      return l.update('task', task.id, { state: 'stuck', stuck: text, landPending: true }, { actor: 'system', reason });
    };

    if (project?.check && this.check) {
      const cwd = thread?.worktree || thread?.cwd;
      const r = await this.check({ cwd, command: project.check });
      l.record('task.check', { ok: r.ok, command: project.check, text: r.output.slice(-3000), cwd }, { actor: 'system', task: task.id });
      if (!r.ok) return sendBack(`The check \`${project.check}\` failed in ${cwd}:\n${r.output.slice(-2500)}\n\nFix it, run the check again, and commit.`, 'check failed');
    }

    if (thread && thread.machine && thread.machine !== 'local' && !this.ledger.get('machine', thread.machine)?.local) {
      return l.update('task', task.id, { state: 'stuck', stuck: `The work is on ${this.ledger.get('machine', thread.machine)?.name || thread.machine}, branch ${branch}. Merging on another machine is not supported yet: merge it there, then close the task.`, landPending: true }, { actor: 'system', reason: 'remote merge' });
    }
    if (!this.git || !project || !branch) {
      return this.#landed(task, thread, { actor, commit: null, how: 'not merged (no repository to merge into)' });
    }
    const base = task.base || thread?.base || project.base || (await this.git.currentBranch(project.path));
    if (!base) return sendBack('Could not tell which branch to merge into.', 'no base');
    const m = await this.git.merge({ repo: project.path, branch, base, message: `Merge #${task.number}: ${task.title}` });
    if (m.ok) return this.#landed(task, thread, { actor, commit: m.commit, how: m.how, base });
    if (m.reason === 'conflict') return sendBack(`Merging ${branch} into ${base} conflicts:\n${m.detail}\n\nMerge ${base} into your branch, resolve the conflicts, run the tests, and commit.`, 'merge conflict');
    if (m.reason === 'missing' && thread?.active) return sendBack(`There is nothing to merge: ${m.detail}. Commit your work on ${branch}.`, 'nothing to merge');
    return l.update('task', task.id, { state: 'stuck', stuck: m.reason === 'dirty' ? `Not merged: ${m.detail}\nCommit or stash those changes, then retry.` : `Not merged: ${m.detail}`, landPending: true }, { actor: 'system', reason: `merge ${m.reason}` });
  }

  async #landed(task, thread, { actor, commit, how, base }) {
    const l = this.ledger;
    if (thread?.active && this.agentOf(thread)) await this.agentOf(thread).stop({ agentId: thread.agentId }).catch((e) => this.log(`stop ${thread.agentId}: ${e.message}`));
    l.transaction(() => {
      if (task.branch && !l.list('output', { where: (o) => o.taskId === task.id && o.type === 'change' && o.ref === task.branch }).length) {
        l.create('output', { taskId: task.id, projectId: task.projectId, type: 'change', title: base ? `${task.branch} → ${base}` : task.branch, ref: task.branch, commit, seen: true }, { actor, task: task.id, reason: 'landed' });
      }
      if (thread?.active) l.update('thread', thread.id, { active: false, status: 'done' }, { actor: 'system', task: task.id, reason: 'landed' });
      l.record('task.landing', { ok: true, commit, how, base: base || null }, { actor: 'system', task: task.id });
      l.update('task', task.id, { state: 'done', landedAt: new Date().toISOString(), commit, lastProgressAt: new Date().toISOString() }, { actor, reason: commit ? `merged into ${base}` : how });
    });
    return l.get('task', task.id);
  }

  /** Drop a task: stop its agent and close it. */
  async drop(ref, { actor = 'you', reason = 'dropped' } = {}) {
    const task = this.task(ref);
    const thread = this.threadOf(task);
    if (thread?.active && this.agentOf(thread)) await this.agentOf(thread).stop({ agentId: thread.agentId }).catch((e) => this.log(`stop ${thread.agentId}: ${e.message}`));
    const l = this.ledger;
    l.transaction(() => {
      for (const d of this.openDecisions(task.id)) l.update('decision', d.id, { open: false, choice: 'dropped', decidedBy: actor }, { actor, task: task.id, reason });
      if (thread?.active) l.update('thread', thread.id, { active: false, status: 'stopped' }, { actor, task: task.id, reason });
      l.update('task', task.id, { state: 'dropped', waitingFor: null, waitingKind: null, wantsAgent: null }, { actor, reason });
    });
    return l.get('task', task.id);
  }

  // ---- following the agents ----

  /** Follow every active agent once. Safe to call often: it runs one pass at a time. */
  sync() {
    if (!this.paseo && !this.paseoFor) return Promise.resolve([]);
    if (!this.syncing) this.syncing = this.#syncAll().finally(() => (this.syncing = null));
    return this.syncing;
  }

  async #syncAll() {
    const out = [];
    for (const thread of this.ledger.list('thread', { where: (t) => t.active && t.agentId && t.source === 'paseo' })) {
      try {
        out.push(await this.syncThread(thread));
      } catch (e) {
        this.log(`sync ${thread.agentId}: ${e.message}`);
      }
    }
    // Tasks that waited for a free agent start when one frees up.
    for (const task of this.ledger.list('task', { where: (t) => t.wantsAgent && t.state === 'queued' })) {
      try {
        await this.dispatch(task.id, { actor: 'system' });
      } catch (e) {
        this.log(`start #${task.number}: ${e.message}`);
      }
    }
    return out;
  }

  async syncThread(thread) {
    const l = this.ledger;
    const paseo = this.agentOf(thread);
    if (!paseo) return null;
    const st = await paseo.status({ agentId: thread.agentId });
    const task = l.get('task', thread.taskId);
    if (!task) return null;
    const meta = { actor: `agent:${thread.runtime || 'agent'}`, task: task.id };

    // New output since the last look goes into the timeline. The cursor lives in meta, not in an event.
    const key = `activity:${thread.id}`;
    const seen = l.meta(key)?.text || '';
    const project = task.projectId ? l.get('project', task.projectId) : null;
    const activity = withoutPrompt(st.activity, thread.prompt || (project ? taskPrompt(task, project, thread.branch) : ''));
    const fresh = newText(seen, activity);
    const now = new Date().toISOString();

    l.transaction(() => {
      if (fresh) {
        l.record('thread.activity', { text: fresh, threadId: thread.id }, meta);
        l.meta(key, { text: activity });
        // Out of quota is the agent's account, not the task: that agent takes nothing new until it resets.
        const hit = fresh.split('\n').find((x) => LIMIT_RE.test(x));
        if (hit && thread.agentRef) this.team.markLimited(thread.agentRef, hit);
      }
      const cost = Number(st.usage?.CostUsd ?? st.usage?.costUsd);
      const waiting = st.pendingPermissions.some((p) => p.id);
      l.update('thread', thread.id, { status: waiting ? 'permission' : st.status, model: st.model, worktree: st.cwd || thread.worktree || null, ...(Number.isFinite(cost) ? { costUsd: cost } : {}) }, meta);

      // Permission requests: one open decision each, closed when the request goes away.
      const pending = st.pendingPermissions.filter((p) => p.id);
      const open = this.openDecisions(task.id, 'permission').filter((d) => d.threadId === thread.id);
      for (const d of open) if (!pending.some((p) => p.id === d.permissionId)) l.update('decision', d.id, { open: false, choice: 'gone', decidedBy: 'system' }, { ...meta, reason: 'no longer pending' });
      for (const p of pending) {
        if (open.some((d) => d.permissionId === p.id)) continue;
        // Paseo names only the tool; the agent's last line about that tool says what it is about to do.
        const hint = p.tool ? lastLineAbout(activity, p.tool) : '';
        const question = p.description || [p.tool ? `Allow ${p.tool}?` : 'Allow this action?', hint].filter(Boolean).join('\n');
        l.create('decision', { taskId: task.id, threadId: thread.id, kind: 'permission', permissionId: p.id, tool: p.tool, question, options: PERMISSION_OPTIONS, reversible: false, open: true, decidedBy: null }, { ...meta, reason: 'the agent asks for permission' });
      }
      const t = l.get('task', task.id);
      if (pending.length) {
        const first = this.openDecisions(task.id, 'permission')[0];
        l.update('task', task.id, { state: 'waiting_you', waitingKind: 'permission', waitingFor: first?.question || null, lastProgressAt: fresh ? now : t.lastProgressAt }, { ...meta, reason: 'waiting for permission' });
        return;
      }
      if (BROKEN.has(st.status)) {
        l.update('thread', thread.id, { active: false }, meta);
        l.update('task', task.id, { state: 'stuck', stuck: `The agent stopped (${st.status}).${st.activity ? `\n${st.activity.slice(-500)}` : ''}`, waitingKind: null, waitingFor: null }, { ...meta, reason: `agent ${st.status}` });
        return;
      }
      if (IDLE.has(st.status) && (t.state === 'working' || t.waitingKind === 'permission')) {
        if (!this.openDecisions(task.id, 'result').length) {
          l.create('decision', { taskId: task.id, threadId: thread.id, kind: 'result', question: `The agent finished its turn. Accept to ${t.base || thread.base ? `merge ${t.branch || 'the branch'} into ${t.base || thread.base}` : 'finish it'}, or say what to change.`, options: RESULT_OPTIONS, reversible: true, open: true, decidedBy: null }, { ...meta, reason: 'turn finished' });
        }
        l.update('task', task.id, { state: 'waiting_you', waitingKind: 'result', waitingFor: null, lastProgressAt: now }, { ...meta, reason: 'turn finished' });
        return;
      }
      if (ACTIVE.has(st.status) && t.state !== 'working') {
        l.update('task', task.id, { state: 'working', waitingKind: null, waitingFor: null, lastProgressAt: fresh ? now : t.lastProgressAt }, meta);
      } else if (fresh) {
        l.update('task', task.id, { lastProgressAt: now }, meta);
      }
    });
    await this.#checkBudget(task.id, thread.id);
    return { thread: thread.id, status: st.status };
  }

  /** Over budget: stop the agent and ask the person whether to spend more. */
  async #checkBudget(taskId, threadId) {
    const l = this.ledger;
    const task = l.get('task', taskId);
    const thread = l.get('thread', threadId);
    if (!task || !thread?.active) return;
    const { limit, spent } = this.budget(task);
    if (spent < limit) return;
    await this.agentOf(thread)?.stop({ agentId: thread.agentId }).catch((e) => this.log(`stop ${thread.agentId}: ${e.message}`));
    l.transaction(() => {
      l.update('thread', thread.id, { active: false, status: 'stopped' }, { actor: 'system', task: task.id, reason: 'budget reached' });
      for (const d of this.openDecisions(task.id)) l.update('decision', d.id, { open: false, choice: 'budget', decidedBy: 'system' }, { actor: 'system', task: task.id, reason: 'budget reached' });
      const question = `Spent $${spent.toFixed(2)} of $${limit.toFixed(2)}. Add $${this.budgetStepUsd.toFixed(2)} and continue, or close the task?`;
      l.create('decision', { taskId: task.id, threadId: thread.id, kind: 'budget', question, options: BUDGET_OPTIONS, reversible: true, open: true, decidedBy: null }, { actor: 'system', task: task.id, reason: 'budget reached' });
      l.update('task', task.id, { state: 'waiting_you', waitingKind: 'budget', waitingFor: question }, { actor: 'system', reason: 'budget reached' });
    });
  }
}

/** Drop the lines of the task prompt that Paseo echoes back in its log. */
export function withoutPrompt(text, prompt) {
  text = String(text || '');
  if (!prompt) return text.trim();
  const own = new Set(String(prompt).split('\n').map((x) => x.trim()).filter(Boolean));
  return text.split('\n').filter((line) => {
    const x = line.trim();
    if (!x) return false;
    const bare = x.replace(/^\[[^\]]*\]\s*/, '').replace(/^(user|you|prompt)\s*[:>]\s*/i, '');
    return !own.has(x) && !own.has(bare);
  }).join('\n').trim();
}

/** The last log line that mentions a tool, e.g. "[Write] src/hello.sh". */
export function lastLineAbout(text, tool) {
  const lines = String(text || '').split('\n').map((x) => x.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) if (lines[i].toLowerCase().includes(`[${String(tool).toLowerCase()}`)) return lines[i].slice(0, 300);
  return '';
}

/** The part of `next` that comes after what was already seen (log tails overlap). */
export function newText(seen, next) {
  next = String(next || '').trim();
  if (!next || next === seen) return '';
  if (!seen) return next;
  if (next.startsWith(seen)) return next.slice(seen.length).trim();
  // Find the longest suffix of `seen` that is a prefix of `next`, line by line.
  const a = seen.split('\n');
  const b = next.split('\n');
  for (let k = Math.min(a.length, b.length); k > 0; k--) {
    if (a.slice(-k).join('\n') === b.slice(0, k).join('\n')) return b.slice(k).join('\n').trim();
  }
  return next;
}

function taskPrompt(task, project, branch, extra, staff) {
  return [
    staff ? `You are ${staff.name}${staff.role ? `, ${staff.role}` : ''}.${staff.instructions ? `\n${staff.instructions}` : ''}\n` : '',
    `Task #${task.number}: ${task.title}`,
    task.description ? `\n${task.description}` : '',
    `\nYou are working in project "${project.name}" on branch ${branch}, in its own worktree.`,
    'Make the change, run the project\'s tests if it has them, and commit your work on this branch with a clear message.',
    'Do not push, merge or deploy. When you are done, end with a short summary of what changed and anything the reviewer should check.',
    extra ? `\n${extra}` : '',
  ].filter(Boolean).join('\n');
}
