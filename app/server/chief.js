// The Lead: one standing conversation that turns requests into todos and reports back.
import path from 'node:path';
import { id, now } from './store.js';
import { runtimes, resolveRuntime } from './runtimes.js';
import { memoryBlock } from './quality.js';
import { knowledgeBlock } from './lead.js';
import { refOf } from './git.js';
import { nextRun } from './rules.js';
import { retroStats, retroText } from './retro.js';
import { isConfirm, isDrop, normalizeRequirement, upsertRequirement, pendingRequirement, requirementText, todoDescription, syncRequirement } from './requirements.js';

const zh = (s) => /[一-鿿]/.test(s);

const ROLE_HINTS = [
  [/devops|deploy|ci\b|pipeline|docker|domain|infra|release|server setup|部署|上线|域名|流水线|运维/i, 'devops'],
  [/front|ui\b|page|css|style|layout|mobile|button|component|theme|页面|前端|样式|界面|按钮|布局|手机/i, 'frontend'],
  [/back|api|server|database|db\b|endpoint|parse|render markdown|sort|query|auth|后端|接口|数据库|排序|解析/i, 'backend'],
];

export function pickAgent(agents, text) {
  for (const [re, key] of ROLE_HINTS) {
    if (re.test(text)) {
      const a = agents.find((x) => new RegExp(key, 'i').test(x.name + ' ' + x.role));
      if (a) return a;
    }
  }
  // Otherwise the agent with the best word overlap with its role, else the first.
  const words = new Set(text.toLowerCase().split(/\W+/).filter((w) => w.length > 3));
  let best = agents[0];
  let score = 0;
  for (const a of agents) {
    const s = a.role.toLowerCase().split(/\W+/).filter((w) => words.has(w)).length;
    if (s > score) (best = a), (score = s);
  }
  return best;
}

export function labelsFor(text) {
  const l = [];
  if (/\b(fix|bug|broken|crash|wrong|error)\b|修复|错误|崩溃|不对/i.test(text)) l.push('bug');
  else if (/deploy|ci\b|pipeline|docker|infra|部署|上线/i.test(text)) l.push('infra');
  else l.push('feature');
  if (/mobile|phone|手机|移动端/i.test(text)) l.push('mobile');
  return l;
}

/** Questions and small talk that should be answered, not filed as work. */
export function isChat(text) {
  const s = text.trim();
  if (/^(hi|hello|hey|thanks|thank you|你好|您好|嗨|谢谢|多谢)[\s!！.。]*$/i.test(s)) return true;
  const question = /[?？]\s*$/.test(s) || /^(who|what|why|how|can you|do you|are you|你是|你能|你会|什么|为什么|怎么|如何)/i.test(s);
  const work = /\b(add|build|make|fix|create|implement|write|update|remove|refactor|deploy|set up)\b|做|加|修|写|建|改|实现|部署|删除|重构/i.test(s);
  return question && !work && s.length < 120;
}

/** Heuristic split used when no AI runtime is available for the Lead. */
export function splitRequest(text) {
  let clean = text.trim();
  // Drop a short lead-in such as "I want my own blog:" when a list of work follows it.
  const colon = clean.search(/[:：]/);
  if (colon > 0 && colon < 60 && /[;；\n,，]/.test(clean.slice(colon))) clean = clean.slice(colon + 1).trim();
  let items = clean
    .split(/\n+/)
    .map((s) => s.replace(/^\s*(?:[-*•]|\d+[.)、]|[一二三四五六七八九十]+[、.])\s*/, '').trim())
    .filter(Boolean);
  if (items.length === 1) {
    items = clean
      .split(/[;；]|。(?=.)|\.\s+(?=[A-Z])|,?\s+and then\s+|，然后|，再|并且/)
      .map((s) => s.trim().replace(/[。.]$/, ''))
      .filter((s) => s.length > 1);
  }
  if (!items.length) items = [clean];
  return items.slice(0, 8).map((s) => {
    const title = s.length > 90 ? s.slice(0, 87) + '…' : s;
    return { title: title.charAt(0).toUpperCase() + title.slice(1), description: s.length > 90 ? s : '' };
  });
}

/**
 * Which project a message is about when the person did not pick one. Never a question for them:
 * the one they name, else the one this conversation is already about, else the only one with its own
 * team (a lead or an analyst), else the one worked on most recently.
 */
export function pickProject(projects, todos, text, topic) {
  if (!projects?.length) return null;
  if (projects.length === 1) return projects[0];
  const s = String(text || '').toLowerCase();
  // The longest name found in the message wins ("docs-site" over "docs"); a tie leaves the rest to decide.
  const hit = (p) => Math.max(0, ...[p.name, p.path && path.basename(p.path)].map((n) => String(n || '').trim().toLowerCase()).filter((n) => n.length > 1 && s.includes(n)).map((n) => n.length));
  const best = Math.max(...projects.map(hit));
  const named = best ? projects.filter((p) => hit(p) === best) : [];
  if (named.length === 1) return named[0];
  const pool = named.length ? named : projects;
  const mine = topic?.projectId && pool.find((p) => p.id === topic.projectId);
  if (mine) return mine;
  const team = pool.filter((p) => p.analyst || p.lead?.decide);
  if (team.length === 1) return team[0];
  const among = team.length ? team : pool;
  const last = (p) => (todos || []).reduce((m, t) => (t.projectId === p.id && (t.updatedAt || '') > m ? t.updatedAt : m), '');
  return [...among].sort((a, b) => last(b).localeCompare(last(a)))[0];
}

/** Whether a todo is waiting for the person to say something (not for its lead). */
const waitsForPerson = (t) => !t.leadPending && (t.phase === 'asking' || (!!t.leadAsk && ['confirm', 'review', 'failed'].includes(t.phase)));

function extractJson(text) {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end < start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
}

/**
 * The requirements analyst: the voice the customer talks to in a project that has one (project.analyst).
 * It knows the product from the project's knowledge files and the repository, talks about ideas and problems
 * in the customer's terms, never asks them technical questions, and files work once it is clear enough to build.
 */
export function analystPrompt({ agents, project, history, text, card }) {
  const said = (history || []).map((m) => `${m.role === 'user' ? 'Customer' : 'You'}: ${String(m.text).slice(0, 1500)}`).join('\n\n');
  const rounds = (history || []).filter((m) => m.role !== 'user').length;
  const open = card
    ? `The requirement card the customer is looking at now (they have not confirmed it; their new message is about this card unless it plainly is something else):\n${JSON.stringify({ title: card.title, problem: card.problem, scope: card.scope, outOfScope: card.outOfScope, acceptance: card.acceptance, assumptions: card.assumptions, todos: (card.todos || []).map((x) => x.title) }, null, 1)}\n\n`
    : '';
  return `You are the requirements analyst of a professional software team, and you know this product in depth. The customer brings ideas and problems to you. Your job is to understand what they want, connect it to what already exists, and agree with them on a requirement the team can build without coming back to them. Nothing is built until the customer has confirmed the requirement, so a clear card matters more than speed.

Before you answer, read what you need: you are in the project's repository with read access. Do not change any files.
${knowledgeBlock(project) || 'Look through the repository (README, docs, task notes) for what the product is and what is already decided.'}

${memoryBlock(project) ? memoryBlock(project) + '\n\n' : ''}The team that will build it (the lead settles everything technical with them; you only pick who starts):
${agents}

${said ? `Conversation so far:\n${said}\n\n` : ''}${open}The customer's new message:
${text}

How to respond:
- A question about the product or the project: answer it from what you read, briefly. Return "small": false, "requirement": null, "todos": [].
- An idea or a problem: say back in one or two sentences what you understood. Relate it to requirements, decisions or known problems that already exist (name their ids) and say so if it repeats or contradicts one.
- Find out yourself whatever the repository or the project knowledge can tell you. Never ask the customer about code, repositories, branches, environments, servers, tooling, test methods or who on the team does what: leave such points to the lead as open technical questions.
- Ask only what the customer alone can know (who it is for, what they should see happen, what matters more), at most 2 questions in one reply, each about something they actually said, each with the answer you would assume so they can simply say yes.
- Stay inside what they asked for. Never offer to do more ("shall we also…"). Related things you noticed, or new wishes that come up in their answers, go under "outOfScope" with a note that they can be raised as a requirement of their own.
- Split what is still open into two kinds: what blocks the work (only the customer can settle it and the result would differ) and what does not (decide it with a sensible assumption and list the assumption). While something blocks, put your questions in "reply" and return "requirement": null, "todos": [].${rounds >= 3 ? `\n- You have already spoken ${rounds} times in this conversation: unless something truly blocks the work, settle the rest with assumptions and write the requirement now.` : ''}
- When nothing blocks, decide the size:
  - "small": true only for a fix the customer could not have meant two ways: a wording or typo change, one plainly broken thing to make work as it already should, a tiny visual adjustment. One todo, no requirement card; it starts at once and your reply says it is a small fix that has been started.
  - Everything else is "small": false: write the requirement card and the planned todos. They do not start until the customer confirms the card; your reply says in one sentence that the card below is ready for them to check (the card itself is shown to them separately, so do not repeat it).
- If an open card is shown above and the customer asks for changes, return the revised card in full (it waits for them again). If they raise something unrelated, leave the card as it is and treat the message on its own.
- Requirement card fields, in the customer's language and plain words: "title" (keep their own requirement id at the start when there is one), "problem" (the problem in their words), "scope" (what this delivers, 1-5 points), "outOfScope" (what it deliberately does not do), "acceptance" (at most 3 things a person can see happen when it is done, not implementation details), "assumptions" (what you decided for them), "refs" (related requirement ids).
- Todos: 1-6 that can run in parallel. Each description holds what this part delivers, its acceptance checks, and open technical questions for the lead.

Answer with JSON only, no prose and no code fence:
{"reply": "what you say to the customer, in the language they wrote in, plain words, no technical terms", "small": false, "requirement": {"title": "", "problem": "", "scope": [], "outOfScope": [], "acceptance": [], "assumptions": [], "refs": []} or null, "todos": [{"title": "imperative, under 80 chars", "description": "as described above", "agent": "exact teammate name", "labels": ["feature"|"bug"|"infra"|"docs"|...]}]}`;
}

export class Chief {
  constructor(store, runner) {
    this.store = store;
    this.runner = runner;
    this.busy = false;
    this.listeners = []; // called with every message the lead says (Feishu forwards them)
    this.analyze = null; // optional stand-in for the analyst's runtime call: (prompt, project) => text
    runner.on('phase', (t, from) => {
      this.#onPhase(t, from);
      this.#onRequirement(t);
    });
  }

  /** The topic a message belongs to: the given one, else the newest open topic (created if none). */
  topic(topicId) {
    const d = this.store.data;
    let tp = topicId && d.topics.find((x) => x.id === topicId);
    if (!tp) tp = d.topics.filter((x) => !x.archived).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
    if (!tp) {
      tp = { id: id('tp'), title: '', archived: false, createdAt: now(), updatedAt: now() };
      d.topics.push(tp);
    }
    return tp;
  }

  say(text, extra = {}) {
    const tp = this.topic(extra.topicId);
    const m = { id: id('c'), role: 'chief', text, at: now(), ...extra, topicId: tp.id };
    tp.updatedAt = now();
    this.store.data.chief.push(m);
    if (this.store.data.chief.length > 2000) this.store.data.chief.splice(0, 200);
    this.store.changed();
    for (const f of this.listeners) f(m);
    return m;
  }

  /** canApprove: false for people other than the owner (e.g. Feishu group members): they can ask, not merge or schedule. */
  async handle(text, { projectId, topicId, canApprove = true, canConfirm = true } = {}) {
    const d = this.store.data;
    const tp = this.topic(topicId);
    if (!tp.title) tp.title = text.replace(/\s+/g, ' ').slice(0, 48);
    tp.archived = false;
    tp.updatedAt = now();
    topicId = tp.id;
    d.chief.push({ id: id('c'), role: 'user', text, at: now(), topicId });
    // No project picked: work it out instead of asking or defaulting to the first one, and keep the conversation there.
    const chosen = !this.store.project(projectId);
    const project = this.store.project(projectId) || pickProject(d.projects, d.todos, text, tp);
    projectId = project?.id || null;
    if (projectId) tp.projectId = projectId;
    this.store.changed();
    const cn = zh(text);
    const say = (msg, extra = {}) => this.say(msg, { ...extra, topicId });
    const where = chosen && project && d.projects.length > 1 ? (cn ? `（项目：${project.name}）` : ` (project: ${project.name})`) : '';

    // A requirement card waits for the customer in this conversation: a yes starts the work, a no drops it,
    // anything else is a change they want (it goes back to the analyst below). Only the customer decides.
    const card = pendingRequirement(this.store, topicId);
    if (card && (isConfirm(text) || isDrop(text))) {
      if (!canApprove || !canConfirm) return say(cn ? `需求 R${card.number} 要由负责人确认。` : `Requirement R${card.number} has to be confirmed by the owner.`);
      if (isDrop(text)) return this.dropRequirement(card);
      return this.confirmRequirement(card);
    }

    if (/^(weekly )?retro(spective)?\b|^(周回顾|每周回顾|回顾|复盘)/i.test(text.trim())) return say(await this.#retro(cn));
    // "Run X every day" becomes a schedule (and a first run now).
    const every = canApprove && parseEvery(text);
    if (every) {
      const title = every.rest || text;
      const agent = pickAgent(d.agents, title);
      const name = title.charAt(0).toUpperCase() + title.slice(1);
      const s = { id: id('ru'), name, title: name, prompt: '', enabled: true, when: { every: every.minutes }, mode: 'run', tell: 'gates', agentId: agent?.id, projectId: projectId || d.projects[0]?.id || null, lastAt: now(), runs: 1 };
      s.nextAt = nextRun(s);
      d.rules.push(s);
      const t = this.#create({ title: s.title }, s.projectId, topicId);
      t.scheduleId = s.id;
      t.ruleId = s.id;
      t.labels = ['scheduled'];
      if (t.phase === 'todo') this.runner.start(t);
      return say(
        cn
          ? `好的，已设为每 ${every.label} 运行一次“${s.title}”，第一轮 #${t.number} 现在开始。可以在“规则”里修改。`
          : `Done: “${s.title}” will run every ${every.label}. The first run, #${t.number}, starts now. Change it under Rules.`,
        { todoIds: [t.id] },
      );
    }

    // A few direct commands, so you can drive the board from the conversation.
    if (/^(ship it|merge (them|all|it)|looks good|lgtm|全部合并|合并吧|上线吧|可以了)[\s.!。！]*$/i.test(text.trim())) {
      if (!canApprove) return say(cn ? '合并需要负责人在卡片上点「合并」。' : 'Only the owner can merge, with the button on the card.');
      const ready = d.todos.filter((t) => t.phase === 'review');
      if (!ready.length) return say(cn ? '现在没有等待审核的任务。' : 'Nothing is waiting for review right now.');
      const done = [];
      for (const t of ready) {
        try {
          await this.runner.complete(t, { merge: true });
          done.push(`#${t.number}`);
        } catch (e) {
          say(`#${t.number}: ${e.message}`);
        }
      }
      return say(cn ? `已处理 ${done.join('、')}：有分支的进入合并队列，逐个在最新代码上检查后合并。` : `${done.join(', ')}: branches are in the merge queue and land one by one after checks pass on the latest code.`);
    }
    if (/^(status|progress|what'?s going on|进度|状态)\??$/i.test(text.trim())) return say(this.#status(cn));
    if (/^(weekly )?retro(spective)?\b|^(周回顾|每周回顾|回顾|复盘)/i.test(text.trim())) return say(await this.#retro(cn));

    // An answer to a question a todo is waiting on goes to that todo; it is not a new piece of work.
    const answered = canApprove && this.#answer(text, topicId);
    if (answered) {
      const { todo, rest, others } = answered;
      const more = others.length ? (cn ? ` ${others.map((x) => `#${x.number}`).join('、')} 也在等你回答，回复时带上编号。` : ` ${others.map((x) => `#${x.number}`).join(', ')} ${others.length > 1 ? 'are' : 'is'} waiting for an answer too: start your reply with the number.`) : '';
      this.runner.reply(todo, todo.phase === 'asking' ? `Answer to your question “${todo.question?.text || ''}”: ${rest}` : rest);
      return say(cn ? `已把你的回答交给 #${todo.number}，它接着做。${more}` : `Passed your answer to #${todo.number}; it carries on.${more}`, { todoIds: [todo.id] });
    }

    this.busy = true;
    this.store.changed();
    try {
      const plan = await this.#split(text, projectId, topicId, card);
      // More than a small fix, in a project with an analyst: a card for the customer to confirm, nothing built yet.
      if (plan.requirement && plan.todos?.length) {
        const r = upsertRequirement(this.store, { existing: card, req: plan.requirement, todos: plan.todos, projectId, topicId, origin: text });
        if (plan.reply) say(plan.reply);
        return say(requirementText(r, (n) => this.#agentOf(n)?.name || ''), { requirementId: r.id });
      }
      // A question or small talk gets an answer, not a todo.
      if (!plan.todos?.length) return say(plan.reply || this.#intro(cn));
      const created = plan.todos.map((p) => this.#create(p, projectId, topicId));
      const list = created.map((t) => `#${t.number} ${t.title} → ${this.store.agent(t.agentId)?.name || '—'}`).join('\n') + (where ? `\n${where.trim()}` : '');
      const reply =
        plan.reply ||
        (created.length > 1
          ? cn
            ? `收到，我拆成了 ${created.length} 个任务并行处理：`
            : `On it. I split this into ${created.length} todos running in parallel:`
          : cn
            ? '收到，已建好任务：'
            : 'On it. Filed it as:');
      say(`${reply}\n${list}`, { todoIds: created.map((t) => t.id) });
    } catch (e) {
      say((cn ? '出错了：' : 'Something went wrong: ') + e.message, { error: true });
    } finally {
      this.busy = false;
      this.store.changed();
    }
  }

  /**
   * The todo this message answers, if any: the one it names (#12 …), else the newest question asked in this
   * conversation since the person last spoke. A long message, or one that says it is new, is a request of its own.
   */
  #answer(text, topicId) {
    const d = this.store.data;
    const waiting = d.todos.filter((t) => waitsForPerson(t) && !this.runner.busy(t));
    if (!waiting.length) return null;
    const m = text.trim().match(/^#(\d+)[\s:：,，]*([\s\S]+)$/);
    if (m) {
      const todo = waiting.find((t) => t.number === Number(m[1]));
      return todo && m[2].trim() ? { todo, rest: m[2].trim(), others: [] } : null;
    }
    if (text.length > 400 || /^(new( request| task| idea)?|another thing|新需求|新任务|另外|还有一个)[\s:：,，]/i.test(text.trim())) return null;
    // Questions asked in this conversation that the person has not said anything to since: the newest one is being answered.
    const here = d.chief.filter((x) => x.topicId === topicId && !x.error);
    const mine = here.filter((x) => x.role === 'user');
    const before = mine.length > 1 ? mine[mine.length - 2].at : '';
    const asked = (t) => here.filter((x) => x.role === 'chief' && x.todoIds?.includes(t.id)).map((x) => x.at).sort().pop() || '';
    const open = waiting
      .map((t) => ({ t, at: asked(t) }))
      .filter((x) => x.at && x.at >= before)
      .sort((x, y) => y.at.localeCompare(x.at));
    if (!open.length) return null;
    return { todo: open[0].t, rest: text.trim(), others: open.slice(1).map((x) => x.t) };
  }

  #create(p, projectId, topicId) {
    const d = this.store.data;
    const agent = (p.agent && d.agents.find((a) => a.name.toLowerCase() === String(p.agent).toLowerCase())) || pickAgent(d.agents, `${p.title} ${p.description || ''}`);
    const t = newTodo(this.store, {
      title: p.title,
      description: p.description || '',
      labels: p.labels?.length ? p.labels : labelsFor(p.title + ' ' + (p.description || '')),
      agentId: agent?.id,
      projectId: projectId || d.projects[0]?.id || null,
      mode: d.settings.planFirst ? 'plan' : 'run',
    });
    t.topicId = topicId;
    if (d.settings.autoStart) this.runner.start(t);
    return t;
  }

  #agentOf(name) {
    return name ? this.store.data.agents.find((a) => a.name.toLowerCase() === String(name).toLowerCase()) : null;
  }

  /** The customer said yes to a card: its todos are filed and start. Never called by a lead or an agent. */
  confirmRequirement(r) {
    if (r.status !== 'confirm') throw new Error(`R${r.number} is not waiting for confirmation`);
    const cn = /[一-鿿]/.test(r.title + (r.problem || ''));
    const created = (r.todos || []).map((x) => {
      const t = this.#create({ ...x, description: todoDescription(r, x) }, r.projectId, r.topicId);
      t.requirementId = r.id;
      return t;
    });
    r.todoIds = created.map((t) => t.id);
    r.status = created.length ? 'building' : 'done';
    r.confirmedAt = now();
    r.updatedAt = now();
    this.store.changed();
    const list = created.map((t) => `#${t.number} ${t.title} → ${this.store.agent(t.agentId)?.name || '—'}`).join('\n');
    return this.say(cn ? `需求 R${r.number} 已确认，开工：\n${list}` : `R${r.number} confirmed. Work has started:\n${list}`, { topicId: r.topicId, todoIds: r.todoIds, requirementId: r.id });
  }

  dropRequirement(r) {
    if (r.status !== 'confirm') throw new Error(`R${r.number} is not waiting for confirmation`);
    const cn = /[一-鿿]/.test(r.title + (r.problem || ''));
    r.status = 'dropped';
    r.updatedAt = now();
    this.store.changed();
    return this.say(cn ? `好，需求 R${r.number} 先不做了。` : `OK, R${r.number} is dropped.`, { topicId: r.topicId, requirementId: r.id });
  }

  #onRequirement(t) {
    const r = t.requirementId && (this.store.data.requirements || []).find((x) => x.id === t.requirementId);
    if (!r || !syncRequirement(r, this.store.data.todos)) return;
    this.store.changed();
    if (r.status !== 'done') return;
    const cn = /[一-鿿]/.test(r.title + (r.problem || ''));
    const acc = (r.acceptance || []).map((x, i) => `${i + 1}. ${x}`).join('\n');
    this.say(cn ? `需求 R${r.number}「${r.title}」的任务都做完了。${acc ? `可以对照这几条看看：\n${acc}` : ''}` : `R${r.number} “${r.title}” is done.${acc ? ` Worth checking:\n${acc}` : ''}`, { topicId: r.topicId, requirementId: r.id });
  }

  async #split(text, projectId, topicId, card = null) {
    const d = this.store.data;
    const runtimeId = resolveRuntime(d.settings.chiefRuntime);
    const analyst = this.store.project(projectId) || d.projects[0];
    if (runtimeId === 'demo' && !(this.analyze && analyst?.analyst)) return isChat(text) ? { todos: [] } : { todos: splitRequest(text) };
    const agents = d.agents.map((a) => `- ${a.name}: ${a.role}`).join('\n');
    if (analyst?.analyst) {
      // A project with an analyst: a conversation about requirements, not a one-shot split.
      const history = d.chief.filter((m) => m.topicId === topicId && !m.error).slice(-13, -1);
      try {
        const prompt = analystPrompt({ agents, project: analyst, history, text, card });
        const out = this.analyze ? await this.analyze(prompt, analyst) : (await runtimes[runtimeId].run({ prompt, kind: 'chief', cwd: analyst.path || this.store.dir, settings: d.settings })).text;
        const json = extractJson(out);
        if (json && (json.reply || json.todos?.length)) {
          const todos = Array.isArray(json.todos) ? json.todos.filter((x) => x?.title).slice(0, 6) : [];
          // Anything but a small fix waits for the customer (unless the person turned the card off for this project).
          const req = json.small === true && todos.length === 1 ? null : normalizeRequirement(json.requirement) || (todos.length ? normalizeRequirement({ title: todos[0].title, problem: text, scope: todos.map((x) => x.title) }) : null);
          const gate = analyst.confirmRequirements !== false;
          return { reply: String(json.reply || ''), todos, requirement: gate && todos.length ? req : null };
        }
      } catch (e) {
        this.say(`(${runtimeId} could not answer as the analyst, falling back to a simple split: ${e.message.slice(0, 160)})`);
      }
      return isChat(text) ? { todos: [] } : { todos: splitRequest(text) };
    }
    const prompt = `You are the lead of a small software team. Turn the person's request into 1-6 independent todos that can run in parallel, and assign each to the best teammate.

Team:
${agents}

${memoryBlock(this.store.project(projectId) || d.projects[0]) ? memoryBlock(this.store.project(projectId) || d.projects[0]) + '\n\n' : ''}Request:
${text}

If the message is a question, a greeting or small talk rather than a piece of work, answer it briefly in "reply" and return "todos": [].

Answer with JSON only, no prose and no code fence:
{"reply": "one short sentence to the person, in the language they wrote in", "todos": [{"title": "imperative, under 80 chars", "description": "what done looks like", "agent": "exact teammate name", "labels": ["feature"|"bug"|"infra"|"docs"|...]}]}`;
    const project = this.store.project(projectId) || d.projects[0];
    try {
      const res = await runtimes[runtimeId].run({ prompt, kind: 'chief', cwd: project?.path || this.store.dir, settings: d.settings });
      const json = extractJson(res.text);
      if (json?.todos?.length) return json;
    } catch (e) {
      this.say(`(${runtimeId} could not plan this, falling back to a simple split: ${e.message.slice(0, 160)})`);
    }
    return isChat(text) ? { todos: [] } : { todos: splitRequest(text) };
  }

  async #retro(cn) {
    const d = this.store.data;
    const stats = retroStats(d, 7);
    const plain = retroText(stats, cn);
    const runtimeId = resolveRuntime(d.settings.chiefRuntime);
    if (runtimeId === 'demo') return plain;
    this.busy = true;
    this.store.changed();
    try {
      const prompt = `You are the lead of a small team of AI coding agents. Write a short weekly retro for the person, in ${cn ? 'Chinese' : 'English'}: what shipped, where work bounced back and why, what to change next week (2-3 concrete suggestions, e.g. a project check to add, a decision to record in project memory, an agent role to adjust). Plain text, under 200 words, no headings. Use only these numbers:\n${JSON.stringify(stats)}`;
      const res = await runtimes[runtimeId].run({ prompt, kind: 'chief', cwd: this.store.dir, settings: d.settings });
      return `${plain}\n\n${res.text.trim()}`;
    } catch {
      return plain;
    } finally {
      this.busy = false;
      this.store.changed();
    }
  }

  #intro(cn) {
    return cn
      ? '我是主管。告诉我你想做成什么，我会拆成任务分给团队里的智能体并行去做，做完请你确认或审核。也可以说“进度”看状态，说“每天……”设定时任务。'
      : "I'm the lead. Tell me what you want built and I'll split it into todos for the agents on your team, run them in parallel, and bring them back for you to confirm or review. Say “status” for progress, or “every day …” to schedule work.";
  }

  #status(cn) {
    const d = this.store.data;
    const count = (ph) => d.todos.filter((t) => ph.includes(t.phase)).length;
    return cn
      ? `进行中 ${count(['queued', 'planning', 'building'])} 个，等你处理 ${count(['confirm', 'review', 'failed'])} 个，待开始 ${count(['todo'])} 个，已完成 ${count(['done'])} 个。`
      : `${count(['queued', 'planning', 'building'])} in progress, ${count(['confirm', 'review', 'failed'])} need you, ${count(['todo'])} in backlog, ${count(['done'])} done.`;
  }

  #onPhase(t, from) {
    const ref = `#${t.number} ${t.title}`;
    const cn = zh(t.title);
    const topicId = t.topicId;
    // The project's lead stands at this gate first (lead.js); the person hears only if the lead passes it on.
    if (t.leadPending) return;
    const ask = t.leadAsk;
    if (ask && ['confirm', 'review', 'asking', 'failed'].includes(t.phase)) {
      const q = ask.text || (cn ? '这一项需要你来定。' : 'This one needs your decision.');
      const hint = ask.recommend ? (cn ? `\n主管建议：${ask.recommend}` : `\nThe lead suggests: ${ask.recommend}`) : '';
      return void this.say(cn ? `${ref} 需要你拍板：${q}${hint}` : `${ref} needs your decision: ${q}${hint}`, { todoIds: [t.id], topicId });
    }
    if (t.phase === 'confirm') this.say(cn ? `${ref} 的计划写好了，等你确认。` : `${ref}: plan is ready for you to confirm.`, { todoIds: [t.id], topicId });
    else if (t.phase === 'review' && t.autoAccepting) return; // accepted without the person: nothing to ask of them
    else if (t.phase === 'review') this.say(cn ? `${ref} 完成了，等你审核。` : `${ref} is ready for your review.`, { todoIds: [t.id], topicId });
    else if (t.phase === 'asking') this.say(cn ? `${ref} 需要你拍板：${t.question?.text || ''}` : `${ref} needs your decision: ${t.question?.text || ''}`, { todoIds: [t.id], topicId });
    else if (t.phase === 'failed') this.say(cn ? `${ref} 失败了：${t.error || ''}` : `${ref} failed: ${t.error || ''}`, { todoIds: [t.id], error: true, topicId });
    else if (t.phase === 'done' && from === 'review') {
      const open = this.store.data.todos.filter((x) => !['done', 'closed'].includes(x.phase)).length;
      if (!open) this.say(zh(t.title) ? '全部任务都完成了。' : 'Everything is done.', { topicId });
    }
  }
}

const UNITS = [
  [/(?:分钟|minutes?|mins?)/i, 1, '分钟', 'minutes'],
  [/(?:小时|hours?|hrs?)/i, 60, '小时', 'hours'],
  [/(?:天|days?)/i, 1440, '天', 'days'],
];

/** Recognise "every day / 每天 / every 2 hours / 每隔 30 分钟 / hourly / weekly". Returns { minutes, label, rest } or null. */
export function parseEvery(text) {
  const cn = zh(text);
  const fixed = [
    [/(?:every\s*day|daily|each\s*day|每天|每日)/i, 1440, '天', 'day'],
    [/(?:every\s*hour|hourly|每小时|每个小时)/i, 60, '小时', 'hour'],
    [/(?:every\s*week|weekly|每周|每星期)/i, 10080, '周', 'week'],
  ];
  const n = text.match(/(?:every|每隔|每)\s*(\d+)\s*(分钟|小时|天|minutes?|mins?|hours?|hrs?|days?)/i);
  let minutes = 0;
  let label = '';
  let match = '';
  if (n) {
    const u = UNITS.find(([re]) => re.test(n[2]));
    minutes = Number(n[1]) * u[1];
    label = cn ? `${n[1]} ${u[2]}` : `${n[1]} ${u[3]}`;
    match = n[0];
  } else {
    for (const [re, m, zhL, enL] of fixed) {
      const f = text.match(re);
      if (f) {
        minutes = m;
        label = cn ? zhL : enL;
        match = f[0];
        break;
      }
    }
  }
  if (!minutes) return null;
  const rest = text
    .replace(match, ' ')
    .replace(/^\s*(?:please|请|帮我|麻烦)?\s*/i, '')
    .replace(/\s*(?:一次|运行一次|跑一次|run|once)?[\s,，。.!！]*$/i, '')
    .replace(/\s+/g, ' ')
    .trim();
  return { minutes, label, rest };
}

export function newTodo(store, fields) {
  const t = {
    id: id('t'),
    number: store.nextNumber(),
    title: fields.title?.trim() || 'Untitled',
    description: fields.description || '',
    labels: fields.labels || [],
    projectId: fields.projectId || null,
    agentId: fields.agentId || store.data.agents[0]?.id || null,
    phase: 'todo',
    mode: fields.mode || 'run',
    plan: '',
    planApproved: false,
    messages: [],
    live: '',
    createdAt: now(),
    updatedAt: now(),
    scheduleId: fields.scheduleId || null,
  };
  // A reference the person's own tracker uses (AP-041): given, or read from the start of the title.
  const ref = String(fields.ref || refOf(t.title)).trim().slice(0, 60);
  if (ref) t.ref = ref;
  store.data.todos.push(t);
  store.changed();
  return t;
}
