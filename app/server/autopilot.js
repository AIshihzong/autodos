// What keeps a project moving without the person: taking in changes from origin and from an upstream
// repository, filing work from the repository's own backlog file, and reading the project's settings
// from autodos.json. Everything it merges goes through the same checks as a todo; whatever it cannot
// merge cleanly becomes a todo for an agent.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { id, now } from './store.js';
import { git, baseOf, baseRef, fastForward, validBranch, isGitRepo, refOf, WHO } from './git.js';
import { runCheck, runChecks, fixPrompt, CONFIG_FILE } from './quality.js';
import { pickAgent } from './chief.js';

const OPEN = (t) => !['done', 'closed'].includes(t.phase);
const okUrl = (u) => /^(https:\/\/|ssh:\/\/|git@|file:\/\/|\/)[^\s]+$/.test(String(u || ''));
const okFile = (f) => !!f && !path.isAbsolute(f) && !f.startsWith('-') && !f.split(/[\\/]/).includes('..') && !/[\0\n:]/.test(f);

/**
 * Unchecked and checked items of a Markdown checklist. Indented lines under an item are its description.
 * Each item has a stable key (its reference, else a hash of its wording) so it is filed only once.
 */
export function parseBacklog(text) {
  const items = [];
  let cur = null;
  for (const line of String(text || '').split('\n')) {
    const indent = line.match(/^\s*/)[0].length;
    const m = line.match(/^\s*[-*]\s+\[( |x|X)\]\s+(.+?)\s*$/);
    if (m && !(cur && indent > cur.indent)) {
      cur = { indent, done: m[1] !== ' ', title: m[2], body: [] };
      items.push(cur);
    } else if (cur && (line.trim() === '' || indent > cur.indent)) cur.body.push(line.trim());
    else cur = null;
  }
  return items.map(({ done, title, body }) => {
    const ref = refOf(title);
    return { done, title: title.slice(0, 200), description: body.join('\n').trim(), ref, key: ref ? ref.toLowerCase() : crypto.createHash('sha1').update(title).digest('hex').slice(0, 12) };
  });
}

/** Read and check autodos.json. Returns only fields this version understands; anything else is reported. */
export function parseConfig(text) {
  let raw;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    throw new Error(`${CONFIG_FILE} is not valid JSON: ${e.message}`);
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(`${CONFIG_FILE} must be a JSON object`);
  const out = {};
  const warnings = [];
  const str = (v, max = 4000) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
  const list = (v, max = 50) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string' && x.trim()).map((x) => x.trim().slice(0, 1000)).slice(0, max) : []);
  const num = (v, min, max, dflt) => (Number.isFinite(Number(v)) && v !== null && v !== '' ? Math.max(min, Math.min(max, Number(v))) : dflt);
  for (const [k, v] of Object.entries(raw)) {
    switch (k) {
      case 'baseBranch':
      case 'branchTemplate':
      case 'prTitle':
      case 'setup':
      case 'preview':
        out[k] = str(v, k === 'setup' ? 4000 : 300);
        break;
      case 'checks':
      case 'protectedPaths':
        out[k] = list(v);
        break;
      case 'delivery':
        out.delivery = v === 'pr' ? 'pr' : 'merge';
        break;
      case 'pushBase':
        out.pushBase = !!v;
        break;
      case 'upstream':
        if (!v) out.upstream = null;
        else if (!okUrl(v.url)) warnings.push('upstream.url is not a git URL; upstream left unchanged');
        else out.upstream = { url: str(v.url, 500), branch: str(v.branch, 200) || 'main', every: num(v.every, 0, 10080, 60), mirror: !!v.mirror };
        break;
      case 'autopilot':
        out.autopilot = v ? { accept: !!v.accept, review: v.review !== false, maxFiles: num(v.maxFiles, 0, 100000, 0) } : null;
        break;
      case 'backlog':
        if (!v) out.backlog = null;
        else if (!okFile(str(v.file, 300))) warnings.push('backlog.file must be a path inside the repository; backlog left unchanged');
        else out.backlog = { file: str(v.file, 300), every: num(v.every, 1, 10080, 5), maxOpen: num(v.maxOpen, 1, 20, 1), prompt: str(v.prompt), agent: str(v.agent, 80), tell: ['gates', 'never'].includes(v.tell) ? v.tell : 'gates' };
        break;
      case 'memory':
        out.memory = { decisions: list(v?.decisions, 100), declined: list(v?.declined, 100) };
        break;
      case 'lead':
        out.lead = v ? { decide: v === true || !!v.decide, ownerPaths: list(v.ownerPaths, 100), maxRounds: num(v.maxRounds, 1, 20, 6) } : null;
        break;
      case 'analyst':
        out.analyst = !!v;
        break;
      case 'knowledge': {
        const files = list(v, 40);
        const bad = files.filter((f) => !okFile(f.replace(/\/$/, '')));
        if (bad.length) warnings.push(`knowledge: ${bad.join(', ')} must be paths inside the repository; left out`);
        out.knowledge = files.filter((f) => !bad.includes(f));
        break;
      }
      case 'rules':
        out.rules = (Array.isArray(v) ? v : [])
          .filter((r) => r && typeof r === 'object' && str(r.name, 80))
          .slice(0, 30)
          .map((r) => ({
            name: str(r.name, 80),
            when: str(r.cron, 100) ? { cron: str(r.cron, 100) } : { every: num(r.every, 1, 525600, 1440) },
            title: str(r.title, 200),
            prompt: str(r.prompt, 8000),
            agent: str(r.agent, 80),
            mode: r.mode === 'plan' ? 'plan' : 'run',
            tell: ['gates', 'never'].includes(r.tell) ? r.tell : 'gates',
            maxOpen: num(r.maxOpen, 0, 50, 1),
            enabled: r.enabled !== false,
          }));
        break;
      default:
        if (!k.startsWith('$') && !k.startsWith('_')) warnings.push(`Unknown setting "${k}" ignored`);
    }
  }
  return { config: out, warnings };
}

export class Autopilot {
  constructor(store, runner, rules, newTodo) {
    this.store = store;
    this.runner = runner;
    this.rules = rules;
    this.newTodo = newTodo;
    this.busy = new Set();
    this.last = new Map(); // `${projectId}:${what}` -> ms of the last attempt
    runner.autopilot = this;
    // A backlog item finished or stalled: look for the next one right away instead of waiting for the timer.
    runner.on('phase', (t) => {
      if (t.backlogKey && ['done', 'closed', 'review', 'failed', 'asking'].includes(t.phase)) this.last.delete(`${t.projectId}:backlog`);
    });
    this.timer = setInterval(() => this.tick().catch(() => {}), 20_000);
    setTimeout(() => this.tick().catch(() => {}), 3000).unref?.();
  }

  close() {
    clearInterval(this.timer);
  }

  #due(project, what, minutes) {
    const key = `${project.id}:${what}`;
    if (Date.now() - (this.last.get(key) || 0) < minutes * 60_000) return false;
    this.last.set(key, Date.now());
    return true;
  }

  /** One job at a time per project; a second request while one runs is dropped. */
  async #once(project, fn) {
    if (this.busy.has(project.id)) return { state: 'busy' };
    this.busy.add(project.id);
    try {
      return await fn();
    } finally {
      this.busy.delete(project.id);
      this.store.changed();
    }
  }

  async tick() {
    for (const project of this.store.data.projects) {
      if (!project.path || !fs.existsSync(project.path) || this.busy.has(project.id)) continue;
      const u = project.upstream;
      const wantsPull = project.pushBase || u?.url || project.backlog?.file;
      if (!wantsPull && !project.configSha) continue;
      if (!(await isGitRepo(project.path))) continue;
      if (project.pushBase && this.#due(project, 'pull', 5)) await this.pull(project).catch((e) => (project.pullError = String(e.message).slice(0, 300)));
      if (u?.url && Number(u.every) > 0 && Date.now() - (Date.parse(u.lastAt || 0) || 0) >= Number(u.every) * 60_000) await this.sync(project).catch(() => {});
      if (project.backlog?.file && this.#due(project, 'backlog', Number(project.backlog.every) || 5)) await this.backlog(project).catch((e) => (project.backlog.lastError = String(e.message).slice(0, 300)));
      if (project.configSha && this.#due(project, 'config', 2)) await this.#configChanged(project).catch(() => {});
    }
  }

  // ---------- merging what others pushed ----------

  /**
   * Merge one commit into the project's base. If only they moved, the base fast-forwards. If both moved,
   * the merge is tried and checked in a scratch worktree, away from everyone's checkout, and lands only
   * when it is clean and the checks pass.
   */
  async #mergeIn(project, base, theirs, what) {
    const repo = project.path;
    const inside = (a, b) => git(repo, ['merge-base', '--is-ancestor', a, b]).then(() => true, () => false);
    const ours = await git(repo, ['rev-parse', baseRef(base)]);
    if (await inside(theirs, ours)) return { state: 'current' };
    if (await inside(ours, theirs)) {
      const ok = await this.runner.landing(project.id, async () => {
        if ((await git(repo, ['rev-parse', baseRef(base)])) !== ours) return false;
        await fastForward(repo, base, theirs, ours);
        return true;
      });
      return ok ? { state: 'merged', sha: theirs } : { state: 'moved' };
    }
    const dir = path.join(this.store.dir, 'sync', project.id);
    const drop = async () => {
      await git(repo, ['worktree', 'remove', '--force', dir]).catch(() => {});
      fs.rmSync(dir, { recursive: true, force: true });
      await git(repo, ['worktree', 'prune']).catch(() => {});
    };
    await drop();
    fs.mkdirSync(path.dirname(dir), { recursive: true });
    await git(repo, ['worktree', 'add', '--quiet', '--detach', dir, ours]);
    try {
      try {
        await git(dir, [...WHO, 'merge', '--no-ff', '-m', `Merge ${what} into ${base}`, theirs]);
      } catch {
        return { state: 'conflict', reason: 'it does not merge cleanly' };
      }
      const commands = (project.checks || []).filter(Boolean);
      if (commands.length && this.store.data.settings.verify !== false) {
        if (String(project.setup || '').trim()) {
          const s = await runCheck(dir, project.setup, { timeoutMs: 30 * 60_000 });
          if (!s.ok) return { state: 'red', reason: 'the setup command fails on the merged code', results: [s] };
        }
        const results = await runChecks(dir, commands, {});
        if (results.some((r) => !r.ok)) return { state: 'red', reason: `the checks fail on the merged code (${results.filter((r) => !r.ok).map((r) => r.command).join(', ')})`, results };
      }
      const merged = await git(dir, ['rev-parse', 'HEAD']);
      const ok = await this.runner.landing(project.id, async () => {
        if ((await git(repo, ['rev-parse', baseRef(base)])) !== ours) return false;
        await fastForward(repo, base, merged, ours);
        return true;
      });
      return ok ? { state: 'merged', sha: merged } : { state: 'moved' }; // the base moved while we checked: the next round tries again
    } finally {
      await drop();
    }
  }

  /** A merge that needs thought goes to an agent as an ordinary todo, once. */
  #mergeTodo(project, base, theirs, what, fetch, result) {
    const d = this.store.data;
    const open = d.todos.find((t) => t.projectId === project.id && t.syncOf === what && OPEN(t));
    if (open) return open;
    const failed = (result.results || []).filter((r) => !r.ok);
    const t = this.newTodo(this.store, {
      title: `Merge ${what} into ${base}`,
      description: [
        `${what} has moved to ${theirs.slice(0, 12)}, and ${result.reason}.`,
        `In this worktree run \`git merge ${theirs}\` (if git does not know that commit here, first run \`${fetch}\`). Resolve every conflict keeping the intent of both sides, make sure no conflict markers remain, get the project checks passing, and commit the merge. Do not rebase, and do not drop either side's changes to make it easier. Never push anywhere yourself.`,
        failed.length ? fixPrompt(failed) : '',
        'Finish with a summary of what conflicted or broke and how you resolved it.',
      ]
        .filter(Boolean)
        .join('\n\n'),
      labels: ['upstream'],
      projectId: project.id,
      agentId: pickAgent(d.agents, 'merge conflicts build tests')?.id,
      mode: 'run',
    });
    t.syncOf = what;
    t.syncSha = theirs;
    this.runner.start(t);
    return t;
  }

  /** Take in what was pushed to the project's own base on origin (the person editing on GitHub, another machine). */
  pull(project) {
    return this.#once(project, async () => {
      const repo = project.path;
      const base = await baseOf(repo, project);
      if (base === 'HEAD') return { state: 'current' };
      const fetched = await git(repo, ['fetch', '--quiet', 'origin', `+refs/heads/${base}:refs/remotes/origin/${base}`]).then(() => true, () => false);
      const theirs = fetched ? await git(repo, ['rev-parse', '-q', '--verify', `refs/remotes/origin/${base}`]).catch(() => '') : '';
      project.pullError = null;
      if (!theirs) {
        // Origin does not have the base yet: a project that shares its base creates it there.
        if (project.pushBase) await git(repo, ['push', '--quiet', 'origin', `refs/heads/${base}:refs/heads/${base}`]).catch((e) => (project.pullError = String(e.message).slice(0, 300)));
        return { state: 'current' };
      }
      const r = await this.#mergeIn(project, base, theirs, `origin/${base}`);
      if (r.state === 'conflict' || r.state === 'red') r.todo = this.#mergeTodo(project, base, theirs, `origin/${base}`, `git fetch origin ${base}`, r).number;
      // Whatever is here and not there yet (an earlier push that was refused, the merge just made) goes out now.
      else if (project.pushBase && (await git(repo, ['rev-parse', baseRef(base)])) !== theirs) await git(repo, ['push', '--quiet', 'origin', `refs/heads/${base}:refs/heads/${base}`]).catch((e) => (project.pullError = String(e.message).slice(0, 300)));
      return r;
    });
  }

  /** One-way sync from an upstream repository: fetch it, merge it into the base, never push to it. */
  sync(project) {
    return this.#once(project, async () => {
      const u = project.upstream;
      if (!u?.url) throw new Error('This project has no upstream repository set');
      const repo = project.path;
      const branch = u.branch || 'main';
      const done = (state, extra = {}) => {
        Object.assign(u, { lastAt: now(), lastResult: state, lastError: null, ...extra });
        return { state, ...extra };
      };
      try {
        if (!okUrl(u.url)) throw new Error(`"${u.url}" is not a git URL`);
        if (!(await validBranch(repo, branch))) throw new Error(`"${branch}" is not a valid branch name`);
        const cur = await git(repo, ['remote', 'get-url', 'upstream']).catch(() => '');
        if (!cur) await git(repo, ['remote', 'add', 'upstream', u.url]);
        else if (cur !== u.url) await git(repo, ['remote', 'set-url', 'upstream', u.url]);
        // Upstream is read-only from here: a push to it fails before it leaves this machine.
        await git(repo, ['remote', 'set-url', '--push', 'upstream', 'autodos-never-pushes-upstream']);
        await git(repo, ['fetch', '--quiet', '--no-tags', 'upstream', `+refs/heads/${branch}:refs/remotes/upstream/${branch}`]);
        const theirs = await git(repo, ['rev-parse', `refs/remotes/upstream/${branch}`]);
        // Keep a copy on origin, so other machines and GitHub show where upstream is.
        if (u.mirror && theirs !== u.mirrored) await git(repo, ['push', '--quiet', 'origin', `${theirs}:refs/heads/upstream/${branch}`]).then(() => (u.mirrored = theirs), (e) => (u.mirrorError = String(e.message).slice(0, 200)));
        const base = await baseOf(repo, project);
        const what = `upstream ${branch}`;
        const r = await this.#mergeIn(project, base, theirs, what);
        if (r.state === 'merged') await this.runner.pushBase(project, base).catch((e) => (u.pushError = String(e.message).slice(0, 200)));
        if (r.state === 'conflict' || r.state === 'red') r.todo = this.#mergeTodo(project, base, theirs, what, `git fetch ${u.url} ${branch}`, r).number;
        return done(r.state, { lastSha: theirs, ...(r.todo ? { lastTodo: r.todo } : {}) });
      } catch (e) {
        Object.assign(u, { lastAt: now(), lastResult: 'error', lastError: String(e.message).slice(0, 300) });
        throw e;
      }
    });
  }

  // ---------- work from the repository's backlog ----------

  /** File a todo for the next unchecked items of the backlog file on the base branch, a few at a time. */
  async backlog(project) {
    const b = project.backlog;
    const d = this.store.data;
    if (!b?.file || !okFile(b.file)) return [];
    const base = await baseOf(project.path, project);
    const text = await git(project.path, ['show', `${baseRef(base)}:${b.file}`]).catch(() => null);
    if (text === null) {
      b.lastError = `${b.file} is not on ${base}`;
      return [];
    }
    b.lastError = null;
    b.lastAt = now();
    const items = parseBacklog(text);
    b.left = items.filter((i) => !i.done).length;
    const mine = d.todos.filter((t) => t.projectId === project.id && t.backlogKey);
    const known = new Set(mine.map((t) => t.backlogKey));
    let open = mine.filter(OPEN).length;
    const max = Math.max(1, Number(b.maxOpen) || 1);
    const filed = [];
    for (const item of items) {
      if (open >= max) break;
      if (item.done || known.has(item.key)) continue;
      const agent = (b.agent && d.agents.find((a) => a.name.toLowerCase() === b.agent.toLowerCase())) || pickAgent(d.agents, `${item.title} ${item.description}`);
      const t = this.newTodo(this.store, {
        title: item.title.slice(0, 120),
        description: [
          item.description,
          b.prompt || '',
          `This is an item from ${b.file}: "${item.title}". When the work is finished, tick it there (\`- [x]\`) as part of the same change. Follow-up work you notice that is out of scope goes into ${b.file} as a new unchecked item, not into this change.`,
        ]
          .filter(Boolean)
          .join('\n\n'),
        labels: ['backlog'],
        projectId: project.id,
        agentId: agent?.id,
        mode: 'run',
        ref: item.ref,
      });
      t.backlogKey = item.key;
      t.tell = b.tell || 'gates';
      this.runner.start(t);
      known.add(item.key);
      open++;
      filed.push(t);
    }
    if (filed.length) this.store.changed();
    return filed;
  }

  // ---------- settings kept in the repository ----------

  async #configText(project) {
    const repo = project.path;
    if (await isGitRepo(repo)) {
      const base = await baseOf(repo, project).catch(() => 'HEAD');
      const sha = await git(repo, ['rev-parse', '-q', '--verify', `${baseRef(base)}:${CONFIG_FILE}`]).catch(() => '');
      if (sha) return { text: await git(repo, ['cat-file', 'blob', sha]), sha, from: base };
    }
    const file = path.join(repo, CONFIG_FILE);
    if (fs.existsSync(file)) return { text: fs.readFileSync(file, 'utf8'), sha: '', from: 'the project folder' };
    throw new Error(`There is no ${CONFIG_FILE} in this project`);
  }

  /** The file changed on the base since it was loaded: say so, but never apply it without the person. */
  async #configChanged(project) {
    const { sha } = await this.#configText(project);
    const stale = !!sha && sha !== project.configSha;
    if (stale !== !!project.configStale) {
      project.configStale = stale;
      this.store.changed();
    }
  }

  /**
   * Apply autodos.json to the project. Only ever on the person's request: the file sets what runs on this
   * machine and what may land unattended, so a change to it must not take effect by itself.
   */
  async loadConfig(project) {
    const { text, sha, from } = await this.#configText(project);
    const { config: c, warnings } = parseConfig(text);
    const d = this.store.data;
    for (const k of ['baseBranch', 'branchTemplate', 'prTitle', 'setup', 'preview', 'checks', 'protectedPaths', 'delivery', 'pushBase', 'autopilot', 'lead', 'analyst', 'knowledge']) if (k in c) project[k] = c[k];
    if ('upstream' in c) project.upstream = c.upstream ? { ...(project.upstream?.url === c.upstream.url ? project.upstream : {}), ...c.upstream } : null;
    if ('backlog' in c) project.backlog = c.backlog ? { ...(project.backlog || {}), ...c.backlog } : null;
    if (c.memory) {
      project.memory ||= { decisions: [], declined: [] };
      for (const kind of ['decisions', 'declined']) {
        project.memory[kind] ||= [];
        for (const line of c.memory[kind]) if (!project.memory[kind].some((m) => m.text === line)) project.memory[kind].push({ text: line, at: now(), todo: null });
      }
    }
    if (c.rules) {
      // Rules from the file belong to it: update them by name, and drop the ones it no longer lists.
      const names = new Set(c.rules.map((r) => r.name));
      d.rules = d.rules.filter((r) => r.fromConfig !== project.id || names.has(r.name));
      for (const r of c.rules) {
        const { agent, ...fields } = r;
        const agentId = (agent && d.agents.find((a) => a.name.toLowerCase() === agent.toLowerCase())?.id) || pickAgent(d.agents, `${r.title} ${r.prompt}`)?.id || null;
        if (agent && !d.agents.some((a) => a.name.toLowerCase() === agent.toLowerCase())) warnings.push(`Rule "${r.name}": there is no agent named "${agent}", so the best match does it`);
        let rule = d.rules.find((x) => x.fromConfig === project.id && x.name === r.name);
        try {
          const next = this.rules.normalize({ ...(rule || {}), ...fields, agentId, projectId: project.id, fromConfig: project.id });
          if (rule) Object.assign(rule, next);
          else d.rules.push({ id: id('ru'), runs: 0, ...next });
        } catch (e) {
          warnings.push(`Rule "${r.name}" skipped: ${e.message}`);
        }
      }
    }
    project.configSha = sha;
    project.configAt = now();
    project.configStale = false;
    this.last.delete(`${project.id}:backlog`);
    this.store.changed();
    // A lead that was just switched on takes over what is waiting for the person right now.
    const taken = project.lead?.decide ? this.runner.lead?.sweep(project) || [] : [];
    return { from, applied: Object.keys(c), rules: (c.rules || []).length, warnings, lead: taken };
  }
}
