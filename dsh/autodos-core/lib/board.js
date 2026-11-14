// The status board: one row per task, the ones waiting on the person first.
// Every row answers: what is it, which goal or project, who is on it (machine · staff),
// what state, where it is stuck, what it waits on you for, when it last moved, what it delivered.
import { TASK_STATES } from './store.js';

/** Map an old Autodos todo phase (and its flags) to a board state. */
export function taskState(t) {
  const p = t.phase;
  if (p === 'closed') return 'dropped';
  if (p === 'done') return 'done';
  if (p === 'failed') return 'failed';
  if (p === 'confirm' || p === 'asking' || p === 'review' || t.leadHold || t.leadPending) return 'waiting_you';
  if (t.error) return 'stuck';
  if (p === 'planning' || p === 'building') return 'working';
  if (p === 'merging' || p === 'shipping') return 'landing';
  return 'queued';
}

const OPEN = new Set(['waiting_you', 'stuck', 'working', 'review', 'queued', 'landing']);
const rank = (s) => {
  const i = TASK_STATES.indexOf(s);
  return i < 0 ? TASK_STATES.length : i;
};

/**
 * Build the board.
 * @param {import('./store.js').Ledger} ledger
 * @param {{open?: boolean, projectId?: string, goalId?: string, limit?: number}} opts
 */
export function board(ledger, { open = true, projectId, goalId, limit = 200 } = {}) {
  const projects = new Map(ledger.list('project').map((p) => [p.id, p]));
  const goals = new Map(ledger.list('goal').map((g) => [g.id, g]));
  const staff = new Map(ledger.list('staff').map((s) => [s.id, s]));
  const machines = new Map(ledger.list('machine').map((m) => [m.id, m]));
  const outputs = new Map();
  for (const o of ledger.list('output')) {
    if (!o.taskId) continue;
    if (!outputs.has(o.taskId)) outputs.set(o.taskId, []);
    outputs.get(o.taskId).push({ id: o.id, type: o.type, title: o.title, url: o.url || null, ref: o.ref || null });
  }
  const decisions = new Map();
  for (const d of ledger.list('decision')) if (d.open && d.taskId) decisions.set(d.taskId, { id: d.id, question: d.question, options: d.options || [], reversible: d.reversible !== false });

  let tasks = ledger.list('task');
  if (open) tasks = tasks.filter((t) => OPEN.has(t.state));
  if (projectId) tasks = tasks.filter((t) => t.projectId === projectId);
  if (goalId) tasks = tasks.filter((t) => t.goalId === goalId);

  const rows = tasks.map((t) => {
    const s = t.staffId ? staff.get(t.staffId) : null;
    const m = t.machine ? machines.get(t.machine) : null;
    const g = t.goalId ? goals.get(t.goalId) : null;
    const p = t.projectId ? projects.get(t.projectId) : null;
    return {
      id: t.id,
      number: t.number ?? null,
      title: t.title,
      goal: g ? { id: g.id, name: g.name } : null,
      project: p ? { id: p.id, name: p.name } : null,
      who: { staff: s ? s.name : null, staffId: t.staffId || null, machine: m ? m.name : t.machine || null, runtime: t.runtime || s?.runtime || null },
      state: t.state,
      stuck: t.stuck || null,
      waitingFor: t.state === 'waiting_you' ? t.waitingFor || decisions.get(t.id)?.question || 'Needs you' : null,
      decision: decisions.get(t.id) || null,
      lastProgressAt: t.lastProgressAt || t.updatedAt,
      outputs: outputs.get(t.id) || [],
    };
  });
  rows.sort((a, b) => rank(a.state) - rank(b.state) || String(b.lastProgressAt).localeCompare(String(a.lastProgressAt)));

  const byState = {};
  for (const r of rows) byState[r.state] = (byState[r.state] || 0) + 1;
  return { rows: rows.slice(0, limit), total: rows.length, byState, generatedAt: new Date().toISOString() };
}

/** One task with everything known about it: the row, its threads, outputs, decisions, and its timeline. */
export function taskDetail(ledger, taskId) {
  const t = ledger.get('task', taskId) || ledger.list('task').find((x) => String(x.number) === String(taskId).replace(/^#/, ''));
  if (!t) return null;
  return {
    task: t,
    threads: ledger.list('thread', { where: (x) => x.taskId === t.id }),
    outputs: ledger.list('output', { where: (x) => x.taskId === t.id }),
    decisions: ledger.list('decision', { where: (x) => x.taskId === t.id }),
    timeline: ledger.timeline(t.id),
  };
}

/** A short plain-text board, for the chief of staff to read in a tool result. */
export function boardText(b) {
  if (!b.rows.length) return 'No open tasks.';
  const label = { waiting_you: 'WAITING ON YOU', stuck: 'STUCK', working: 'working', review: 'in review', queued: 'queued', landing: 'landing', done: 'done', failed: 'failed', dropped: 'dropped' };
  const lines = b.rows.map((r) => {
    const who = [r.who.machine, r.who.staff].filter(Boolean).join(' · ') || 'unassigned';
    const where = r.goal?.name || r.project?.name || 'no project';
    const extra = r.waitingFor ? ` — needs: ${r.waitingFor}` : r.stuck ? ` — stuck: ${r.stuck.split('\n')[0].slice(0, 160)}` : '';
    return `- [${label[r.state] || r.state}] ${r.number ? `#${r.number} ` : ''}${r.title} (${where}; ${who}; last moved ${r.lastProgressAt})${extra}`;
  });
  return `${b.total} open task(s):\n${lines.join('\n')}`;
}
