// The team's report: what landed, what is moving, what is stuck and why, and what waits for the customer.
// It is put together from what Autodos already knows (no model call), on a schedule, said in the conversation
// when something changed, and (when the project names a branch) written to a file on that branch and pushed,
// so the state of the work can be read from anywhere without asking the machine that runs it.
import crypto from 'node:crypto';
import { now } from './store.js';
import { commitFileToBranch, baseOf } from './git.js';

const zh = (s) => /[一-鿿]/.test(String(s || ''));
const GATES = ['asking', 'confirm', 'review', 'failed'];
const MOVING = ['queued', 'planning', 'building', 'merging', 'shipping'];
const one = (s, n = 160) => {
  const x = String(s || '').replace(/\s+/g, ' ').trim();
  return x.length > n ? x.slice(0, n - 1) + '…' : x;
};
const hours = (ms) => Math.round(ms / 360000) / 10;

/**
 * The report for one project. `since` is when the last one was made (ISO, or '' for the first).
 * Returns the text, a key that changes only when the state of the work does, and the numbers behind it.
 */
export function buildReport(project, data, { since = '', at = Date.now(), quietHours = 6 } = {}) {
  const todos = data.todos.filter((t) => t.projectId === project.id);
  const cn = zh(project.name) || todos.slice(-20).some((t) => zh(t.title));
  const ref = (t) => `#${t.number} ${one(t.title, 60)}`;
  const log = project.leadLog || [];
  const lastWhy = (t) => [...log].reverse().find((x) => x.todo === t.number)?.why || '';

  const landed = todos.filter((t) => t.phase === 'done' && t.updatedAt > since).sort((a, b) => a.updatedAt.localeCompare(b.updatedAt));
  const lastLanded = todos.filter((t) => t.phase === 'done').reduce((m, t) => (t.updatedAt > m ? t.updatedAt : m), '');
  const open = todos.filter((t) => !['done', 'closed', 'todo'].includes(t.phase));
  const waitingCapacity = open.filter((t) => t.phase === 'queued' && t.capacity?.until && Date.parse(t.capacity.until) > at);
  const moving = open.filter((t) => MOVING.includes(t.phase) && !waitingCapacity.includes(t));
  const withLead = open.filter((t) => GATES.includes(t.phase) && t.leadPending);
  const yours = open.filter((t) => GATES.includes(t.phase) && !t.leadPending);
  // Still open after several rounds with the lead: the team is on it, and the customer should know why it takes long.
  const stuck = [...moving, ...withLead, ...waitingCapacity].filter((t) => (t.leadRounds || 0) >= 3);
  const cards = (data.requirements || []).filter((r) => r.projectId === project.id && r.status === 'confirm');
  const decided = log.filter((x) => x.at > since);
  const ids = new Set(todos.map((t) => t.id));
  const spent = (data.runs || []).filter((r) => ids.has(r.todoId) && r.startedAt > since).reduce((s, r) => s + (r.costUsd || 0), 0);
  const quiet = open.length && lastLanded ? hours(at - Date.parse(lastLanded)) : 0;

  const L = cn
    ? { title: `团队简报 · ${project.name}`, quiet: (h) => `已经 ${h} 小时没有新的合入，原因见下面每一项。`, landed: '已合入', none: '没有', moving: '进行中', lead: '主管正在处理', cap: '在等用量额度，到时间自己继续', stuck: '做了几轮还没过，团队在处理', yours: '等你决定', cards: '需求卡片等你确认', decided: '主管自己定了', spent: '这段时间的用量（按 API 价格估算）', rounds: (n) => `已来回 ${n} 轮`, until: '继续时间', suggest: '主管建议', nothing: '没有需要你做的事。', failed: '失败', stage: { queued: '排队', planning: '写计划', building: '开发', merging: '合并中', shipping: '提交中', verifying: '跑检查', fixing: '修检查', reviewing: '审查', setup: '装依赖' } }
    : { title: `Team report · ${project.name}`, quiet: (h) => `Nothing has landed for ${h} hours; each item below says why.`, landed: 'Landed', none: 'none', moving: 'In progress', lead: 'With the lead', cap: 'Waiting for the usage limit to lift (continues by itself)', stuck: 'Several rounds and not through yet; the team is on it', yours: 'Waiting for you', cards: 'Requirement cards for you to confirm', decided: 'Decided by the lead', spent: 'Usage in this period (estimate at API prices)', rounds: (n) => `${n} rounds so far`, until: 'continues at', suggest: 'The lead suggests', nothing: 'Nothing is needed from you.', failed: 'failed', stage: {} };
  const stage = (t) => L.stage[t.stage] || L.stage[t.phase] || t.stage || t.phase;

  const out = [`# ${L.title}`, new Date(at).toISOString().slice(0, 16).replace('T', ' ') + ' UTC'];
  if (quiet >= quietHours) out.push(`**${L.quiet(quiet)}**`);
  if (!yours.length && !cards.length) out.push(L.nothing);
  const section = (title, lines) => lines.length && out.push(`## ${title} (${lines.length})\n${lines.map((x) => `- ${x}`).join('\n')}`);
  section(L.yours, yours.map((t) => `${ref(t)}: ${one(t.leadAsk?.text || t.question?.text || (t.phase === 'failed' ? `${L.failed}: ${t.error}` : t.leadAsk?.why || t.gateReason || t.phase), 240)}${t.leadAsk?.recommend ? ` ${L.suggest}: ${one(t.leadAsk.recommend, 160)}` : ''}`));
  section(L.cards, cards.map((r) => `R${r.number} ${one(r.title, 80)}`));
  section(L.landed, landed.map(ref));
  section(L.stuck, stuck.map((t) => `${ref(t)}: ${L.rounds(t.leadRounds)}${lastWhy(t) ? `. ${one(lastWhy(t), 200)}` : ''}`));
  section(L.moving, moving.filter((t) => !stuck.includes(t)).map((t) => `${ref(t)} · ${stage(t)}`));
  section(L.lead, withLead.filter((t) => !stuck.includes(t)).map(ref));
  section(L.cap, waitingCapacity.map((t) => `${ref(t)} · ${L.until} ${t.capacity.until.slice(11, 16)} UTC`));
  if (decided.length) {
    const by = {};
    for (const x of decided) by[x.decision] = (by[x.decision] || 0) + 1;
    out.push(`${L.decided}: ${Object.entries(by).map(([k, n]) => `${k} ${n}`).join(', ')}`);
  }
  if (spent > 0) out.push(`${L.spent}: $${spent.toFixed(2)}`);

  // What makes two reports "the same": where every open todo stands, and what has landed.
  const state = [...open.map((t) => `${t.number}:${t.phase}:${t.leadRounds || 0}:${t.leadPending ? 'L' : ''}:${t.capacity?.tries || 0}`), `landed:${todos.filter((t) => t.phase === 'done').length}`, `cards:${cards.map((r) => r.number).join(',')}`, quiet >= quietHours ? `quiet:${Math.floor(quiet / quietHours)}` : ''];
  const key = crypto.createHash('sha1').update(state.join('|')).digest('hex').slice(0, 16);
  return { text: out.join('\n\n') + '\n', key, counts: { landed: landed.length, moving: moving.length, withLead: withLead.length, yours: yours.length + cards.length, stuck: stuck.length, capacity: waitingCapacity.length, quiet } };
}

export class Watch {
  constructor(store, runner, chief) {
    this.store = store;
    this.runner = runner;
    this.chief = chief;
    this.timer = setInterval(() => this.tick().catch(() => {}), 60_000);
    this.timer.unref?.();
  }

  async tick() {
    for (const p of this.store.data.projects) {
      const r = p.report;
      if (!r) continue;
      const every = Math.max(15, Number(r.every) || 120) * 60_000;
      if (r.lastAt && Date.now() - Date.parse(r.lastAt) < every) continue;
      await this.report(p).catch((e) => {
        r.lastError = String(e.message).slice(0, 300);
        r.lastAt = now();
        this.store.changed();
      });
    }
  }

  /** Make the report now. It is said and written only when the state of the work changed, unless forced. */
  async report(project, { force = false } = {}) {
    const r = (project.report ||= {});
    const made = buildReport(project, this.store.data, { since: r.since || '', quietHours: Number(r.quietHours) || 6 });
    const changed = made.key !== r.lastKey;
    r.lastAt = now();
    r.lastError = null;
    if (!changed && !force) {
      this.store.changed();
      return { ...made, changed: false };
    }
    r.lastKey = made.key;
    r.since = r.lastAt;
    r.last = made.text.slice(0, 20000);
    this.store.changed();
    if (r.branch && project.path) {
      // Its own branch holding only this file: no noise in the code's history, readable from anywhere.
      await this.runner.landing(project.id, async () => {
        const base = await baseOf(project.path, project).catch(() => '');
        if (r.branch === base) throw new Error('The report needs a branch of its own, not the base branch');
        const res = await commitFileToBranch(project.path, r.branch, r.file || 'STATUS.md', made.text, 'Team report', { push: !!project.pushBase });
        r.sha = res.sha;
      }).catch((e) => {
        r.lastError = `Could not write the report to ${r.branch}: ${String(e.message).slice(0, 200)}`;
        this.store.changed();
      });
    }
    // In the conversation only when there is something to hear: work landed, something waits for them, or it has gone quiet.
    const c = made.counts;
    if (r.tell !== false && (c.landed || c.yours || c.stuck || c.quiet >= (Number(r.quietHours) || 6))) this.chief.say(made.text, { kind: 'report' });
    this.store.changed();
    return { ...made, changed: true };
  }
}
