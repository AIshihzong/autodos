// What can be done to tasks, and the loop that keeps the board in step with the agents running them.
// Every action is a ledger event with who did it and why, so the timeline shows the whole story.
//
// The flow: create a task → dispatch it (Paseo starts Claude Code in a new worktree and branch) →
// sync follows the agent: its output lands in the timeline, a permission request becomes an open
// decision that waits on the person, and a finished turn becomes a "look at the result" decision.
// The person replies, retries, allows or denies, accepts or sends back, from the panel.
//
// Permission requests are only ever answered by the person (the panel routes), never by an agent tool.

const ACTIVE = new Set(['running', 'busy', 'working', 'thinking', 'starting', 'initializing']);
const IDLE = new Set(['idle', 'done', 'finished', 'completed', 'stopped', 'waiting']);
const BROKEN = new Set(['error', 'failed', 'crashed', 'closed', 'exited', 'killed']);

export const RESULT_OPTIONS = ['Accept', 'Keep working'];
export const PERMISSION_OPTIONS = ['Allow', 'Deny'];

export class Autodos {
  /**
   * @param {import('./store.js').Ledger} ledger
   * @param {{paseo?: ReturnType<import('./paseo.js').createPaseo>, provider?: string, mode?: string, log?: (m: string) => void}} opts
   */
  constructor(ledger, { paseo = null, provider = 'claude', mode, log = () => {} } = {}) {
    this.ledger = ledger;
    this.paseo = paseo;
    this.provider = provider;
    this.mode = mode;
    this.log = log;
    this.syncing = null;
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

  createProject({ name, path, description }, { actor = 'you' } = {}) {
    if (!name) throw new Error('A project needs a name');
    if (!path) throw new Error('A project needs the path of its repository');
    if (this.ledger.list('project').some((p) => p.name?.toLowerCase() === String(name).toLowerCase())) throw new Error(`Project ${name} already exists`);
    return this.ledger.create('project', { name, path, description: description || '', source: 'autodos-core' }, { actor, reason: 'new project' });
  }

  async createTask({ title, description = '', projectId, project, staffId = null, provider, start = true }, { actor = 'you', reason } = {}) {
    if (!title) throw new Error('A task needs a title');
    const p = projectId || project ? this.project(projectId || project) : null;
    const number = Math.max(0, ...this.ledger.list('task', { removed: true }).map((t) => Number(t.number) || 0)) + 1;
    const task = this.ledger.create(
      'task',
      { number, title, description, projectId: p?.id || null, goalId: null, staffId, runtime: provider || this.provider, state: 'queued', labels: [], dependsOn: [], lastProgressAt: new Date().toISOString(), source: 'autodos-core' },
      { actor, reason: reason || 'new task' },
    );
    if (start && p) return this.dispatch(task.id, { actor });
    return task;
  }

  // ---- running ----

  async dispatch(ref, { actor = 'you', extra } = {}) {
    if (!this.paseo) throw new Error('No execution layer: Paseo is not configured');
    const task = this.task(ref);
    if (!task.projectId) throw new Error(`#${task.number} has no project, so there is no repository to work in`);
    const project = this.project(task.projectId);
    if (!project.path) throw new Error(`Project ${project.name} has no repository path`);
    const branch = task.branch || `autodos/${task.number}`;
    const prompt = taskPrompt(task, project, branch, extra);
    const run = await this.paseo.dispatch({ cwd: project.path, prompt, provider: task.runtime || this.provider, branch, title: `#${task.number} ${task.title}`.slice(0, 80), mode: this.mode });
    const l = this.ledger;
    return l.transaction(() => {
      const old = this.threadOf(task);
      if (old?.active) l.update('thread', old.id, { active: false, status: 'replaced' }, { actor: 'system', task: task.id, reason: 'dispatched again' });
      const thread = l.create(
        'thread',
        { taskId: task.id, machine: 'local', runtime: run.provider || task.runtime || this.provider, agentId: run.agentId, sessionId: run.agentId, cwd: project.path, branch, status: run.status || 'running', active: true, source: 'paseo' },
        { actor, task: task.id, reason: 'dispatched to Paseo' },
      );
      return l.update('task', task.id, { state: 'working', threadId: thread.id, branch, machine: 'local', stuck: null, waitingFor: null, waitingKind: null, lastProgressAt: new Date().toISOString() }, { actor, reason: `started ${thread.runtime} on ${branch}` });
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
    if (!thread?.active || !this.paseo) return { task: l.get('task', task.id), sent: false };
    await this.paseo.send({ agentId: thread.agentId, text });
    l.transaction(() => {
      for (const d of this.openDecisions(task.id, 'result')) l.update('decision', d.id, { open: false, choice: 'replied', decidedBy: actor }, { actor, task: task.id, reason: 'replied instead' });
      l.update('task', task.id, { state: 'working', waitingFor: null, waitingKind: null, stuck: null, lastProgressAt: new Date().toISOString() }, { actor, reason: 'replied' });
    });
    return { task: l.get('task', task.id), sent: true };
  }

  /** Try again: nudge the agent if it is still there, else start a fresh one on the same branch. */
  async retry(ref, { actor = 'you', note } = {}) {
    const task = this.task(ref);
    const thread = this.threadOf(task);
    const why = task.stuck ? `It stopped with: ${task.stuck.split('\n')[0].slice(0, 300)}` : '';
    if (thread?.active && this.paseo && !BROKEN.has(thread.status)) {
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
      await this.paseo.permit({ agentId: thread.agentId, requestId: d.permissionId, allow });
      l.transaction(() => {
        close(allow ? 'allowed' : 'denied');
        if (!this.openDecisions(task.id, 'permission').length) l.update('task', task.id, { state: 'working', waitingFor: null, waitingKind: null, lastProgressAt: new Date().toISOString() }, { actor, reason: allow ? 'allowed' : 'denied' });
      });
      if (!allow && note) await this.reply(task.id, note, { actor });
      return l.get('task', task.id);
    }

    if (d.kind === 'result') {
      if (picked === RESULT_OPTIONS[0]) {
        const thread = this.threadOf(task);
        l.transaction(() => {
          close('accepted');
          if (task.branch && !l.list('output', { where: (o) => o.taskId === task.id && o.type === 'change' && o.ref === task.branch }).length) {
            l.create('output', { taskId: task.id, projectId: task.projectId, type: 'change', title: task.branch, ref: task.branch, seen: true }, { actor, task: task.id, reason: 'accepted' });
          }
          if (thread?.active) l.update('thread', thread.id, { active: false }, { actor, task: task.id, reason: 'accepted' });
          l.update('task', task.id, { state: 'done', waitingFor: null, waitingKind: null, lastProgressAt: new Date().toISOString() }, { actor, reason: 'accepted' });
        });
        return l.get('task', task.id);
      }
      if (!note) throw new Error('Say what to change');
      close('sent back');
      return (await this.reply(task.id, note, { actor })).task;
    }

    // An imported or free-form decision: record the answer; the task moves on when someone acts on it.
    close('decided');
    if (note && task) l.record('thread.message', { text: note }, { actor, task: task.id });
    return task ? l.get('task', task.id) : null;
  }

  /** Drop a task: stop its agent and close it. */
  async drop(ref, { actor = 'you', reason = 'dropped' } = {}) {
    const task = this.task(ref);
    const thread = this.threadOf(task);
    if (thread?.active && this.paseo) await this.paseo.stop({ agentId: thread.agentId }).catch((e) => this.log(`stop ${thread.agentId}: ${e.message}`));
    const l = this.ledger;
    l.transaction(() => {
      for (const d of this.openDecisions(task.id)) l.update('decision', d.id, { open: false, choice: 'dropped', decidedBy: actor }, { actor, task: task.id, reason });
      if (thread?.active) l.update('thread', thread.id, { active: false, status: 'stopped' }, { actor, task: task.id, reason });
      l.update('task', task.id, { state: 'dropped', waitingFor: null, waitingKind: null }, { actor, reason });
    });
    return l.get('task', task.id);
  }

  // ---- following the agents ----

  /** Follow every active agent once. Safe to call often: it runs one pass at a time. */
  sync() {
    if (!this.paseo) return Promise.resolve([]);
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
    return out;
  }

  async syncThread(thread) {
    const l = this.ledger;
    const st = await this.paseo.status({ agentId: thread.agentId });
    const task = l.get('task', thread.taskId);
    if (!task) return null;
    const meta = { actor: `agent:${thread.runtime || 'agent'}`, task: task.id };

    // New output since the last look goes into the timeline. The cursor lives in meta, not in an event.
    const key = `activity:${thread.id}`;
    const seen = l.meta(key)?.text || '';
    const fresh = newText(seen, st.activity);
    const now = new Date().toISOString();

    l.transaction(() => {
      if (fresh) {
        l.record('thread.activity', { text: fresh, threadId: thread.id }, meta);
        l.meta(key, { text: st.activity });
      }
      const cost = Number(st.usage?.CostUsd ?? st.usage?.costUsd);
      l.update('thread', thread.id, { status: st.status, model: st.model, worktree: st.cwd || thread.worktree || null, ...(Number.isFinite(cost) ? { costUsd: cost } : {}) }, meta);

      // Permission requests: one open decision each, closed when the request goes away.
      const pending = st.pendingPermissions.filter((p) => p.id);
      const open = this.openDecisions(task.id, 'permission').filter((d) => d.threadId === thread.id);
      for (const d of open) if (!pending.some((p) => p.id === d.permissionId)) l.update('decision', d.id, { open: false, choice: 'gone', decidedBy: 'system' }, { ...meta, reason: 'no longer pending' });
      for (const p of pending) {
        if (open.some((d) => d.permissionId === p.id)) continue;
        const question = p.description || (p.tool ? `Allow ${p.tool}?` : 'Allow this action?');
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
          l.create('decision', { taskId: task.id, threadId: thread.id, kind: 'result', question: 'The agent finished its turn. Accept the result, or say what to change.', options: RESULT_OPTIONS, reversible: true, open: true, decidedBy: null }, { ...meta, reason: 'turn finished' });
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
    return { thread: thread.id, status: st.status };
  }
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

function taskPrompt(task, project, branch, extra) {
  return [
    `Task #${task.number}: ${task.title}`,
    task.description ? `\n${task.description}` : '',
    `\nYou are working in project "${project.name}" on branch ${branch}, in its own worktree.`,
    'Make the change, run the project\'s tests if it has them, and commit your work on this branch with a clear message.',
    'Do not push, merge or deploy. When you are done, end with a short summary of what changed and anything the reviewer should check.',
    extra ? `\n${extra}` : '',
  ].filter(Boolean).join('\n');
}
