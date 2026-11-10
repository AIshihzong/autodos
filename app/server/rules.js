// Rules: "when this happens (an event or a time), give this work to that agent, in that project".
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { id, now } from './store.js';
import { childEnv } from './runtimes.js';

// ---------- cron (minute hour day-of-month month day-of-week) ----------
function field(spec, min, max) {
  const set = new Set();
  for (const part of String(spec).split(',')) {
    const [range, stepS] = part.split('/');
    const step = stepS ? Number(stepS) : 1;
    let [a, b] = range === '*' ? [min, max] : range.split('-').map(Number);
    if (b === undefined) b = stepS ? max : a;
    if (![a, b, step].every(Number.isInteger) || a < min || b > max || a > b || step < 1) throw new Error(`Bad cron field "${spec}"`);
    for (let v = a; v <= b; v += step) set.add(v);
  }
  return set;
}

export function parseCron(expr) {
  const f = String(expr).trim().split(/\s+/);
  if (f.length !== 5) throw new Error('Cron needs 5 fields: minute hour day month weekday');
  // Weekday accepts 0-7 (both 0 and 7 are Sunday); map 7 after the range is expanded.
  const dow = new Set([...field(f[4], 0, 7)].map((v) => (v === 7 ? 0 : v)));
  return { m: field(f[0], 0, 59), h: field(f[1], 0, 23), dom: field(f[2], 1, 31), mon: field(f[3], 1, 12), dow, anyDom: f[2] === '*', anyDow: f[4] === '*' };
}

/** Next time strictly after `from` that matches the cron expression (local time). Steps by day, so rare dates (Feb 29) are found. */
export function nextCron(expr, from = new Date()) {
  const c = parseCron(expr);
  const start = new Date(from);
  start.setSeconds(0, 0);
  start.setMinutes(start.getMinutes() + 1);
  const hours = [...c.h].sort((a, b) => a - b);
  const mins = [...c.m].sort((a, b) => a - b);
  const day = new Date(start);
  day.setHours(0, 0, 0, 0);
  for (let i = 0; i < 366 * 9; i++) {
    const domOk = c.dom.has(day.getDate());
    const dowOk = c.dow.has(day.getDay());
    // Standard cron: when both day fields are restricted, either may match.
    const dayOk = c.anyDom && c.anyDow ? true : c.anyDom ? dowOk : c.anyDow ? domOk : domOk || dowOk;
    if (c.mon.has(day.getMonth() + 1) && dayOk) {
      for (const h of hours)
        for (const m of mins) {
          const d = new Date(day);
          d.setHours(h, m, 0, 0);
          if (d >= start) return d;
        }
    }
    day.setDate(day.getDate() + 1);
  }
  throw new Error('Cron expression never fires');
}

export function nextRun(rule, from = new Date()) {
  const w = rule.when || {};
  if (w.cron) return nextCron(w.cron, from).toISOString();
  if (w.every) return new Date(from.getTime() + Number(w.every) * 60000).toISOString();
  return null;
}

const glob = (pattern, value) => new RegExp('^' + pattern.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$').test(value);

export function matches(rule, ev) {
  const w = rule.when || {};
  if (!w.source || w.source !== ev.source) return false;
  return !w.types?.length || w.types.some((p) => glob(p, ev.type));
}

const fill = (tpl, ev) => String(tpl || '').replace(/\{(\w+)\}/g, (_, k) => (ev[k] ?? '').toString());

// ---------- sources ----------
export const hashKey = (key) => crypto.createHash('sha256').update(key).digest('hex');
export const newKey = () => 'cbk_' + crypto.randomBytes(24).toString('base64url');

/** Turn a GitHub webhook delivery into an event. */
export function fromGitHub(name, body) {
  const action = body.action ? `.${body.action}` : '';
  const item = body.issue || body.pull_request || body.discussion || null;
  const repo = body.repository?.full_name || '';
  return {
    type: `${name}${action}`,
    title: item?.title || body.head_commit?.message?.split('\n')[0] || `${name}${action} in ${repo}`,
    body: item?.body || body.comment?.body || '',
    url: item?.html_url || body.comment?.html_url || body.compare || '',
    key: item ? `${repo}#${item.number}` : `${repo}:${name}`,
    data: { repo, number: item?.number, sender: body.sender?.login },
  };
}

export function verifyGitHub(secret, raw, signature) {
  if (!signature) return false;
  const expect = 'sha256=' + crypto.createHmac('sha256', secret).update(raw).digest('hex');
  const a = Buffer.from(expect);
  const b = Buffer.from(String(signature));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** Poll GitHub with the `gh` CLI, so no public URL or webhook is needed. */
function ghIssues(repo) {
  return new Promise((resolve, reject) => {
    execFile('gh', ['issue', 'list', '--repo', repo, '--state', 'open', '--limit', '100', '--json', 'number,title,body,url,createdAt,author'], { env: childEnv(), timeout: 30000 }, (err, out, errOut) => {
      if (err) return reject(new Error((errOut || err.message).trim().split('\n')[0]));
      try {
        resolve(JSON.parse(out));
      } catch (e) {
        reject(e);
      }
    });
  });
}

export class Rules {
  constructor(store, runner, newTodo, notify) {
    this.store = store;
    this.runner = runner;
    this.newTodo = newTodo;
    this.notify = notify;
    this.polling = new Set();
    // Older data: interval schedules become rules.
    const d = store.data;
    d.rules ||= [];
    d.sources ||= [];
    d.events ||= [];
    if (d.schedules?.length) {
      for (const s of d.schedules) {
        d.rules.push({ id: s.id, name: s.title, enabled: s.enabled, when: { every: s.everyMinutes }, agentId: s.agentId, projectId: s.projectId, mode: s.mode, title: s.title, prompt: s.description || '', tell: 'gates', nextAt: s.nextAt, lastAt: s.lastAt, runs: 0 });
      }
      d.schedules = [];
      store.changed();
    }
    this.timer = setInterval(() => this.tick().catch(() => {}), 15000);
    setTimeout(() => this.tick().catch(() => {}), 2000);
  }

  close() {
    clearInterval(this.timer);
  }

  normalize(rule) {
    if (rule.when?.cron) parseCron(rule.when.cron); // throws on a bad expression
    if (rule.when?.every && !(Number(rule.when.every) >= 1)) throw new Error('Interval must be at least 1 minute');
    if (!rule.when?.cron && !rule.when?.every && !rule.when?.source) throw new Error('A rule needs a time (cron or interval) or an event source');
    if (rule.maxOpen !== undefined) rule.maxOpen = Math.max(0, Math.min(50, Math.floor(Number(rule.maxOpen) || 0)));
    rule.nextAt = nextRun(rule);
    return rule;
  }

  /** Start one rule's work now. ev is the triggering event, or a time tick. */
  fire(rule, ev = null) {
    const d = this.store.data;
    // Same object again (e.g. a new comment on the same issue): continue its open todo instead of a new one.
    if (ev?.key) {
      const open = d.todos.find((t) => t.ruleId === rule.id && t.eventKey === ev.key && !['done', 'closed'].includes(t.phase));
      if (open) {
        // Recorded as an outside event, never as the person: it cannot answer a question or approve a gate.
        this.runner.eventNote(open, `${ev.type}: ${ev.title}\n${String(ev.body || '').slice(0, 4000)}`);
        return open;
      }
    }
    // A rule with a limit waits while that many of its todos are still open, so a slow or stuck run never piles up.
    const limit = Number(rule.maxOpen) || 0;
    if (limit > 0 && d.todos.filter((t) => t.ruleId === rule.id && !['done', 'closed'].includes(t.phase)).length >= limit) {
      rule.skippedAt = now();
      rule.skips = (rule.skips || 0) + 1;
      this.store.changed();
      return null;
    }
    // Event text may fill the short title, but never the rule's instructions: those stay the person's own words.
    const title = (ev ? fill(rule.title, { title: ev.title, type: ev.type, source: ev.source }) || ev.title : rule.title || rule.name).replace(/\s+/g, ' ').slice(0, 120);
    const t = this.newTodo(this.store, {
      title,
      description: rule.prompt ? String(rule.prompt).replace(/\{(\w+)\}/g, '(see the event)') : '',
      labels: ev ? [ev.source] : ['scheduled'],
      projectId: rule.projectId || null,
      agentId: rule.agentId || d.agents[0]?.id,
      mode: rule.mode || 'run',
      scheduleId: rule.id,
    });
    t.ruleId = rule.id;
    t.eventKey = ev?.key || null;
    if (ev) t.event = { source: ev.source, type: ev.type, url: ev.url || '', text: String(ev.body || ev.title || '').slice(0, 6000) };
    t.tell = rule.tell || 'gates';
    rule.lastAt = now();
    rule.skippedAt = null;
    rule.runs = (rule.runs || 0) + 1;
    this.runner.start(t);
    this.store.changed();
    return t;
  }

  /** An event arrived from a source: record it and hand it to every matching rule. */
  ingest(source, ev) {
    const d = this.store.data;
    if (ev.deliveryId && d.events.some((e) => e.deliveryId === ev.deliveryId)) return { duplicate: true };
    const rec = { id: id('ev'), source: source.id, sourceName: source.name, at: now(), ...ev, body: String(ev.body || '').slice(0, 8000), todoIds: [] };
    for (const rule of d.rules) {
      if (!rule.enabled || this.paused(rule) || !matches(rule, { ...rec, source: source.id })) continue;
      const t = this.fire(rule, rec);
      if (t) rec.todoIds.push(t.id);
    }
    d.events.push(rec);
    if (d.events.length > 500) d.events.splice(0, d.events.length - 500);
    this.store.changed();
    return { event: rec.id, todoIds: rec.todoIds };
  }

  paused(rule) {
    if (!rule.pausedUntil) return false;
    if (rule.pausedUntil !== 'forever' && Date.parse(rule.pausedUntil) <= Date.now()) {
      delete rule.pausedUntil;
      delete rule.pauseReason;
      return false;
    }
    return true;
  }

  async tick() {
    const d = this.store.data;
    const t0 = Date.now();
    for (const r of d.rules) {
      if (!r.enabled || this.paused(r) || !r.nextAt || Date.parse(r.nextAt) > t0) continue;
      r.nextAt = nextRun(r, new Date());
      this.fire(r);
    }
    for (const s of d.sources) if (s.kind === 'github-poll') await this.poll(s).catch(() => {});
  }

  async poll(s, force = false) {
    if (this.polling.has(s.id)) return;
    if (!force && s.lastPollAt && Date.now() - Date.parse(s.lastPollAt) < (Number(s.everyMinutes) || 5) * 60000) return;
    this.polling.add(s.id);
    try {
      const issues = await ghIssues(s.repo);
      const seen = new Set(s.seen || []);
      // Only issues opened after the source was added count; older ones are history, not work.
      const since = Date.parse(s.createdAt || 0);
      for (const i of issues.sort((a, b) => a.number - b.number)) {
        if (seen.has(i.number)) continue;
        seen.add(i.number);
        if (Date.parse(i.createdAt) >= since) this.ingest(s, { type: 'issues.opened', title: i.title, body: i.body, url: i.url, key: `${s.repo}#${i.number}`, deliveryId: `${s.id}:${i.number}`, data: { repo: s.repo, number: i.number, author: i.author?.login } });
      }
      s.seen = [...seen].slice(-500);
      s.lastError = null;
    } catch (e) {
      s.lastError = e.message;
    } finally {
      s.lastPollAt = now();
      this.polling.delete(s.id);
      this.store.changed();
    }
  }
}
