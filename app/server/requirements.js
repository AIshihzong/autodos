// Requirements: what the customer asked for, settled with the analyst before any work starts.
// In a project with an analyst, a request that is more than a small fix becomes a requirement card
// (problem, scope, out of scope, what they will see, assumptions, the planned todos). Nothing is built
// until the customer confirms the card themselves: no agent, lead or autopilot can confirm it for them.
// Small fixes still go straight to work, and the reply says so.
import { id, now } from './store.js';

/** Card states, in order. Only `confirm` waits for the customer. */
export const REQ_STATES = ['discussing', 'confirm', 'building', 'done', 'dropped'];

const zh = (s) => /[一-鿿]/.test(String(s || ''));
const strs = (v, n, len = 400) => (Array.isArray(v) ? v : v ? [v] : []).map((x) => String(x || '').trim().slice(0, len)).filter(Boolean).slice(0, n);

/** "Yes, go ahead" in the customer's words. Short on purpose: anything longer is a change they want. */
export function isConfirm(text) {
  const s = String(text || '').toLowerCase().replace(/[\s,，。.!！~～、]/g, '');
  if (!s || s.length > 16) return false;
  return /^(?:确认|确定|可以|好的|好|行|没问题|就这样|就这么做|开工|开始|做吧|同意|吧|了|的|啊|呀|ok|okay|yes|yep|goahead|go|confirmed|confirm|lgtm|looksgood|soundsgood|shipit)+$/.test(s) && !/^[吧了的啊呀]+$/.test(s);
}

/** "Forget it" in the customer's words. */
export function isDrop(text) {
  const s = String(text || '').trim().replace(/[\s,，。.!！]+$/g, '');
  return s.length <= 24 && /^(不做了|算了|取消|先不做|先不要|不要了|放弃|drop it|cancel|never ?mind|forget it)/i.test(s);
}

/** Clean up what the analyst returned. Null when there is nothing usable. */
export function normalizeRequirement(r) {
  if (!r || typeof r !== 'object') return null;
  const title = String(r.title || '').trim().slice(0, 120);
  if (!title) return null;
  return {
    title,
    problem: String(r.problem || '').trim().slice(0, 1500),
    scope: strs(r.scope, 8),
    outOfScope: strs(r.outOfScope || r.out_of_scope, 8),
    acceptance: strs(r.acceptance, 3),
    assumptions: strs(r.assumptions, 6),
    refs: strs(r.refs, 10, 40),
  };
}

/** Make a new card, or revise the open one, from what the analyst returned. */
export function upsertRequirement(store, { existing, req, todos, projectId, topicId, origin }) {
  const d = store.data;
  d.requirements ||= [];
  const plan = (todos || []).filter((x) => x?.title).slice(0, 6).map((x) => ({ title: String(x.title).slice(0, 120), description: String(x.description || ''), agent: x.agent || '', labels: Array.isArray(x.labels) ? x.labels : [] }));
  if (existing) {
    Object.assign(existing, req, { todos: plan.length ? plan : existing.todos, status: 'confirm', updatedAt: now(), revisions: (existing.revisions || 0) + 1 });
    return existing;
  }
  d.reqSeq = (d.reqSeq || 0) + 1;
  const r = { id: id('rq'), number: d.reqSeq, projectId, topicId, ...req, todos: plan, todoIds: [], status: 'confirm', origin: String(origin || '').slice(0, 2000), createdAt: now(), updatedAt: now() };
  d.requirements.push(r);
  return r;
}

/** The open card of a conversation, if one waits for the customer. */
export function pendingRequirement(store, topicId) {
  return (store.data.requirements || []).filter((r) => r.topicId === topicId && r.status === 'confirm').sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0] || null;
}

/** What the customer reads: the card in their words, and how to answer it. */
export function requirementText(r, agentName = () => '', cn = zh(r.title + r.problem)) {
  const L = cn
    ? { head: `需求 R${r.number} · 待你确认`, problem: '要解决的问题', scope: '这次做', out: '这次不做', acc: '做完后你能看到', ass: '我替你做的假设', plan: '准备拆成', ask: '回复“确认”就开工；想改哪里直接说，我改好再给你看。' }
    : { head: `Requirement R${r.number} · waiting for you`, problem: 'Problem', scope: 'In scope', out: 'Not in scope', acc: 'What you will see when it is done', ass: 'Assumptions I made for you', plan: 'Planned work', ask: 'Reply “confirm” to start; or tell me what to change and I will show you the new version.' };
  const list = (xs) => xs.map((x) => `- ${x}`).join('\n');
  const parts = [`${L.head}\n${r.title}`];
  if (r.problem) parts.push(`${L.problem}${cn ? '：' : ': '}${r.problem}`);
  if (r.scope?.length) parts.push(`${L.scope}${cn ? '：' : ':'}\n${list(r.scope)}`);
  if (r.outOfScope?.length) parts.push(`${L.out}${cn ? '：' : ':'}\n${list(r.outOfScope)}`);
  if (r.acceptance?.length) parts.push(`${L.acc}${cn ? '：' : ':'}\n${r.acceptance.map((x, i) => `${i + 1}. ${x}`).join('\n')}`);
  if (r.assumptions?.length) parts.push(`${L.ass}${cn ? '：' : ':'}\n${list(r.assumptions)}`);
  if (r.todos?.length) parts.push(`${L.plan}${cn ? '：' : ':'}\n${r.todos.map((x) => `- ${x.title}${agentName(x.agent) ? ` → ${agentName(x.agent)}` : ''}`).join('\n')}`);
  parts.push(L.ask);
  return parts.join('\n\n');
}

/** The description a todo carries from its card, so the engineer and the lead see what was agreed. */
export function todoDescription(r, x) {
  const cn = zh(r.title + r.problem);
  const lines = [x.description || ''];
  lines.push(cn ? `\n—— 来自已确认的需求 R${r.number}：${r.title}` : `\n—— From confirmed requirement R${r.number}: ${r.title}`);
  if (r.problem) lines.push(`${cn ? '问题' : 'Problem'}: ${r.problem}`);
  if (r.outOfScope?.length) lines.push(`${cn ? '不在范围' : 'Not in scope'}: ${r.outOfScope.join('; ')}`);
  if (r.acceptance?.length) lines.push(`${cn ? '验收' : 'Acceptance'}: ${r.acceptance.join('; ')}`);
  if (r.assumptions?.length) lines.push(`${cn ? '假设' : 'Assumptions'}: ${r.assumptions.join('; ')}`);
  return lines.join('\n').trim();
}

/** A card's state follows its todos once they exist. Returns true when it changed. */
export function syncRequirement(r, todos) {
  if (r.status !== 'building' || !r.todoIds?.length) return false;
  const mine = r.todoIds.map((i) => todos.find((t) => t.id === i)).filter(Boolean);
  if (!mine.length || mine.some((t) => !['done', 'closed'].includes(t.phase))) return false;
  r.status = mine.some((t) => t.phase === 'done') ? 'done' : 'dropped';
  r.updatedAt = now();
  return true;
}
