// The Lead: one standing conversation that turns requests into todos and reports back.
import { id, now } from './store.js';
import { runtimes, resolveRuntime } from './runtimes.js';
import { memoryBlock } from './quality.js';
import { refOf } from './git.js';
import { nextRun } from './rules.js';
import { retroStats, retroText } from './retro.js';

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

export class Chief {
  constructor(store, runner) {
    this.store = store;
    this.runner = runner;
    this.busy = false;
    this.listeners = []; // called with every message the lead says (Feishu forwards them)
    runner.on('phase', (t, from) => this.#onPhase(t, from));
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
  async handle(text, { projectId, topicId, canApprove = true } = {}) {
    const d = this.store.data;
    const tp = this.topic(topicId);
    if (!tp.title) tp.title = text.replace(/\s+/g, ' ').slice(0, 48);
    tp.archived = false;
    tp.updatedAt = now();
    topicId = tp.id;
    d.chief.push({ id: id('c'), role: 'user', text, at: now(), topicId });
    this.store.changed();
    const cn = zh(text);
    const say = (msg, extra = {}) => this.say(msg, { ...extra, topicId });

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

    this.busy = true;
    this.store.changed();
    try {
      const plan = await this.#split(text, projectId);
      // A question or small talk gets an answer, not a todo.
      if (!plan.todos?.length) return say(plan.reply || this.#intro(cn));
      const created = plan.todos.map((p) => this.#create(p, projectId, topicId));
      const list = created.map((t) => `#${t.number} ${t.title} → ${this.store.agent(t.agentId)?.name || '—'}`).join('\n');
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

  async #split(text, projectId) {
    const d = this.store.data;
    const runtimeId = resolveRuntime(d.settings.chiefRuntime);
    if (runtimeId === 'demo') return isChat(text) ? { todos: [] } : { todos: splitRequest(text) };
    const agents = d.agents.map((a) => `- ${a.name}: ${a.role}`).join('\n');
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
