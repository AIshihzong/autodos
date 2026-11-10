// HTTP API + live events + static web app. Used by `npm start` and by the desktop app.
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store, id, now } from './store.js';
import { Runner, PHASES } from './runner.js';
import { Chief, newTodo, pickAgent, labelsFor } from './chief.js';
import { detectRuntimes } from './runtimes.js';
import { diagnose, fix as fixCheck, fixJobs } from './doctor.js';
import { FeishuLink } from './feishu.js';
import { isGitRepo, git } from './git.js';
import { detectChecks } from './quality.js';
import { Rules, hashKey, newKey, fromGitHub, verifyGitHub, nextRun } from './rules.js';
import { attachChannels, send, checkUrl, CHANNEL_KINDS } from './channels.js';
import { Workers } from './workers.js';
import { retroStats } from './retro.js';
import { Previews, detectPreview } from './preview.js';
import { Delivery } from './github.js';
import { serveEvidence } from './evidence.js';
import { Autopilot } from './autopilot.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.join(here, '..', 'dist');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json', '.woff2': 'font/woff2' };

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export function createApp({ dataDir } = {}) {
  const store = new Store(dataDir);
  const runner = new Runner(store);
  const chief = new Chief(store, runner);
  const feishu = new FeishuLink({ store, runner, chief, publicUrl: () => store.data.settings.publicUrl || '' });
  const clients = new Set();

  const broadcast = (event, data) => {
    const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of clients) res.write(msg);
  };
  let pending = null;
  store.on('change', () => {
    if (pending) return;
    pending = setTimeout(() => {
      pending = null;
      broadcast('state', { at: Date.now() });
    }, 60);
  });
  runner.on('delta', (todoId, text) => broadcast('delta', { todoId, text }));

  const rules = new Rules(store, runner, newTodo);
  const workers = new Workers(store);
  const previews = new Previews();
  const delivery = new Delivery(store, runner);
  runner.delivery = delivery;
  // A preview shows the code under review; once it lands, closes or changes hands, it goes away.
  runner.on('phase', (t) => ['done', 'closed', 'merging', 'shipping'].includes(t.phase) && previews.stop(t.id));
  runner.workers = workers;
  const autopilot = new Autopilot(store, runner, rules, newTodo);
  attachChannels(store, runner);

  const snapshot = () => {
    const d = store.data;
    return {
      settings: d.settings,
      projects: d.projects,
      agents: d.agents,
      todos: d.todos,
      chief: d.chief.slice(-600),
      topics: d.topics,
      mcpPath: path.join(here, '..', 'mcp', 'server.js'),
      chiefBusy: chief.busy,
      feishu: feishu.view(),
      workers: workers.list(),
      pairings: workers.pairingsView(),
      previews: previews.list(),
      rules: d.rules,
      sources: d.sources.map(({ keyHash, secret, seen, ...s }) => ({ ...s, hasKey: !!(keyHash || secret) })),
      events: d.events.slice(-100),
      // Never send webhook URLs back: their path or query usually is the credential.
      channels: (d.channels || []).map(({ secret, url, ...c }) => ({ ...c, url: (() => { try { return new URL(url).host; } catch { return ''; } })(), hasSecret: !!secret })),
      runs: d.runs.slice(-1000),
      runtimes: detectRuntimes(),
      dataDir: store.dir,
    };
  };

  const getTodo = (key) => {
    const t = store.todo(key);
    if (!t) throw new HttpError(404, 'No such todo');
    return t;
  };

  const crud = (collection, makeDefaults) => ({
    create(body) {
      const item = { id: id(collection.slice(0, 2)), ...makeDefaults(body), ...pick(body) };
      store.data[collection].push(item);
      store.changed();
      return item;
    },
    update(itemId, body) {
      const item = store.data[collection].find((x) => x.id === itemId);
      if (!item) throw new HttpError(404, 'Not found');
      Object.assign(item, pick(body));
      store.changed();
      return item;
    },
    remove(itemId) {
      store.data[collection] = store.data[collection].filter((x) => x.id !== itemId);
      store.changed();
      return { ok: true };
    },
  });
  const pick = (body) => Object.fromEntries(Object.entries(body || {}).filter(([k]) => k !== 'id'));

  const agents = crud('agents', (b) => ({ name: 'New agent', role: '', runtime: 'auto', model: '', color: store.nextColor() }));
  const projects = crud('projects', (b) => ({ name: path.basename(b.path || 'project'), path: '' }));
  store.data.channels ||= [];
  // Learn which agents are signed in, so "auto" never picks one that would fail.
  diagnose(store.data.settings).catch(() => {});
  const rulesCrud = crud('rules', () => ({ name: 'New rule', agentId: store.data.agents[0]?.id || null, enabled: true, when: { every: 60 }, mode: 'run', title: '', prompt: '', tell: 'gates', runs: 0 }));

  async function route(method, url, body) {
    const p = url.pathname.replace(/\/+$/, '');
    const seg = p.split('/').slice(2); // after /api
    const [res, rid, sub] = seg;

    if (method === 'GET' && res === 'state') return snapshot();
    if (method === 'GET' && res === 'runtimes') return detectRuntimes(true);
    if (res === 'feishu') {
      if (method === 'POST' && rid === 'bind') return feishu.bind();
      if (method === 'DELETE' && rid === 'bind') return (feishu.cancel(), { ok: true });
      if (method === 'POST' && rid === 'test') return feishu.test();
      if (method === 'POST' && rid === 'reconnect') return (await feishu.connect(), feishu.view());
      if (method === 'DELETE' && !rid) return (await feishu.unbind(), { ok: true });
    }
    if (method === 'GET' && res === 'doctor') return { ...(await diagnose(store.data.settings)), jobs: fixJobs() };
    if (method === 'POST' && res === 'doctor' && rid && sub === 'fix')
      // When an install finishes, look for the agents again so the board can use them at once.
      return fixCheck(rid, () => (detectRuntimes(true), broadcast('doctor', { at: Date.now() }), store.changed()), store.data.settings);
    if (method === 'GET' && res === 'retro') return retroStats(store.data, Math.max(1, Math.min(90, Number(url.searchParams.get('days')) || 7)));
    if (method === 'GET' && res === 'check-path') {
      const dir = url.searchParams.get('path') || '';
      return { exists: fs.existsSync(dir) && fs.statSync(dir).isDirectory(), git: await isGitRepo(dir) };
    }
    if (res === 'settings' && method === 'PATCH') {
      Object.assign(store.data.settings, body);
      store.changed();
      runner.pump();
      return store.data.settings;
    }
    if (res === 'chief' && method === 'POST') {
      if (!body.text?.trim()) throw new HttpError(400, 'Empty message');
      chief.handle(body.text.trim(), { projectId: body.projectId, topicId: body.topicId }); // runs in background; progress arrives as events
      return { ok: true };
    }
    if (res === 'topics') {
      if (method === 'POST' && !rid) {
        const tp = { id: id('tp'), title: body.title || '', archived: false, createdAt: now(), updatedAt: now() };
        store.data.topics.push(tp);
        store.changed();
        return tp;
      }
      const tp = store.data.topics.find((x) => x.id === rid);
      if (!tp) throw new HttpError(404, 'No such topic');
      if (method === 'PATCH') {
        if ('title' in body) tp.title = String(body.title).slice(0, 80);
        if ('archived' in body) tp.archived = !!body.archived;
        store.changed();
        return tp;
      }
      if (method === 'DELETE') {
        store.data.topics = store.data.topics.filter((x) => x !== tp);
        store.data.chief = store.data.chief.filter((m) => m.topicId !== tp.id);
        store.changed();
        return { ok: true };
      }
    }
    if (res === 'projects' && rid && sub === 'memory' && (method === 'POST' || method === 'DELETE')) {
      // One entry at a time on the server, so quick successive saves never overwrite each other.
      const project = store.project(rid);
      if (!project) throw new HttpError(404, 'No such project');
      const kind = body.kind === 'declined' ? 'declined' : 'decisions';
      const text = String(body.text || '').trim().slice(0, 1000);
      if (!text) throw new HttpError(400, 'Empty memory');
      project.memory ||= { decisions: [], declined: [] };
      project.memory[kind] ||= [];
      if (method === 'POST' && !project.memory[kind].some((m) => m.text === text)) project.memory[kind].push({ text, at: now(), todo: body.todo || null });
      if (method === 'DELETE') project.memory[kind] = project.memory[kind].filter((m) => m.text !== text);
      store.changed();
      return project.memory;
    }
    if (res === 'projects' && rid && method === 'POST' && ['sync', 'pull', 'backlog', 'load-config'].includes(sub)) {
      const project = store.project(rid);
      if (!project) throw new HttpError(404, 'No such project');
      if (!project.path || !fs.existsSync(project.path)) throw new HttpError(400, 'The project folder does not exist');
      if (sub === 'load-config') return autopilot.loadConfig(project);
      if (sub === 'backlog') return { filed: (await autopilot.backlog(project)).map((t) => t.number), left: project.backlog?.left ?? null, error: project.backlog?.lastError || null };
      return sub === 'sync' ? autopilot.sync(project) : autopilot.pull(project);
    }
    if (res === 'projects' && rid && method === 'GET') {
      const project = store.project(rid);
      if (!project) throw new HttpError(404, 'No such project');
      const root = fs.realpathSync(project.path);
      const inside = (rel = '') => {
        const p = fs.realpathSync(path.resolve(root, rel));
        if (p !== root && !p.startsWith(root + path.sep)) throw new HttpError(400, 'Path is outside the project');
        return p;
      };
      if (sub === 'detect-checks') return detectChecks(root);
      if (sub === 'detect-preview') return { command: detectPreview(root) };
      if (sub === 'files') {
        const dir = inside(url.searchParams.get('dir') || '');
        return fs
          .readdirSync(dir, { withFileTypes: true })
          .filter((e) => !['.git', 'node_modules', '.DS_Store'].includes(e.name))
          .map((e) => ({ name: e.name, dir: e.isDirectory(), path: path.relative(root, path.join(dir, e.name)) }))
          .sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name));
      }
      if (sub === 'file') {
        const file = inside(url.searchParams.get('path') || '');
        const st = fs.statSync(file);
        if (st.isDirectory()) throw new HttpError(400, 'That is a folder');
        const buf = fs.readFileSync(file).subarray(0, 200_000);
        const binary = buf.includes(0);
        return { path: path.relative(root, file), size: st.size, binary, truncated: st.size > buf.length, text: binary ? '' : buf.toString('utf8') };
      }
      if (sub === 'history') {
        if (!(await isGitRepo(root))) return [];
        const out = await git(root, ['log', '-n', '40', '--date=iso-strict', '--pretty=format:%h%x1f%an%x1f%ad%x1f%s']);
        return out.split('\n').filter(Boolean).map((l) => {
          const [hash, author, date, subject] = l.split('\x1f');
          return { hash, author, date, subject };
        });
      }
    }

    if (res === 'todos') {
      if (method === 'GET' && !rid) return store.data.todos;
      if (method === 'POST' && !rid) {
        if (!body.title?.trim()) throw new HttpError(400, 'A todo needs a title');
        // An agent delegating a sub-task: bounded in depth and fan-out, and it shares the parent's budget.
        let parent = null;
        if (body.parent) {
          parent = store.todo(String(body.parent));
          if (!parent) throw new HttpError(400, 'Parent todo not found');
          const s = store.data.settings;
          const depth = (parent.depth || 0) + 1;
          if (depth > (Number(s.delegateDepth) || 0)) throw new HttpError(400, `Delegation limit: sub-tasks may go ${s.delegateDepth} level(s) deep. Do this part yourself.`);
          const siblings = store.data.todos.filter((x) => x.parentId === parent.id).length;
          if (siblings >= (Number(s.delegateChildren) || 0)) throw new HttpError(400, `Delegation limit: #${parent.number} already has ${siblings} sub-tasks. Do this part yourself.`);
          if (body.projectId === undefined) body.projectId = parent.projectId;
        }
        const text = `${body.title} ${body.description || ''}`;
        const t = newTodo(store, {
          ...body,
          labels: body.labels?.length ? body.labels : labelsFor(text),
          agentId: body.agentId || pickAgent(store.data.agents, text)?.id,
          projectId: body.projectId === undefined ? store.data.projects[0]?.id : body.projectId,
        });
        if (parent) {
          t.parentId = parent.id;
          t.depth = (parent.depth || 0) + 1;
          t.budgetRoot = parent.budgetRoot || parent.id;
          t.labels = [...new Set([...(t.labels || []), 'delegated'])];
        }
        if (body.start) runner.start(t, body.mode);
        return t;
      }
      const t = getTodo(rid);
      if (method === 'GET' && !sub) return t;
      if (method === 'PATCH' && !sub) {
        for (const k of ['title', 'description', 'labels', 'agentId', 'projectId', 'mode', 'ref']) if (k in body) t[k] = body[k];
        t.updatedAt = now();
        store.changed();
        return t;
      }
      if (method === 'DELETE' && !sub) {
        previews.stop(t.id);
        runner.stop(t);
        store.data.todos = store.data.todos.filter((x) => x !== t);
        store.changed();
        return { ok: true };
      }
      if (sub === 'preview') {
        if (method === 'POST') {
          const out = await previews.start(t, store.project(t.projectId), store.data.settings.useWorktrees !== false).catch((e) => {
            throw new HttpError(400, e.message);
          });
          store.changed();
          return out;
        }
        if (method === 'DELETE') {
          previews.stop(t.id);
          store.changed();
          return { ok: true };
        }
      }
      if (method === 'POST' && sub === 'messages') {
        if (!body.text?.trim()) throw new HttpError(400, 'Empty message');
        runner.reply(t, body.text.trim());
        return t;
      }
      if (method === 'POST' && sub === 'action') {
        switch (body.action) {
          case 'start':
            runner.start(t, body.mode);
            break;
          case 'confirm':
            runner.confirm(t);
            break;
          case 'done':
            await runner.complete(t, { merge: body.merge !== false });
            break;
          case 'close':
            runner.close(t);
            break;
          case 'stop':
            runner.stop(t);
            break;
          case 'retry':
            if (runner.busy(t)) throw new HttpError(400, 'This todo is already queued or running');
            t.revision = t.mode === 'plan' && !t.planApproved ? 'plan' : null;
            runner.start(t);
            break;
          case 'answer':
            if (t.phase !== 'asking') throw new HttpError(400, 'This todo is not waiting for an answer');
            if (!String(body.text || '').trim()) throw new HttpError(400, 'Empty answer');
            runner.reply(t, `Answer to your question “${t.question?.text || ''}”: ${String(body.text).trim()}`);
            break;
          case 'reopen':
            runner.move(t, t.plan && !t.planApproved ? 'confirm' : 'review');
            break;
          case 'phase': // board drag between columns
            if (!PHASES.includes(body.phase)) throw new HttpError(400, 'Unknown phase');
            if (body.phase === 'done') await runner.complete(t, { merge: body.merge !== false });
            else if (body.phase === 'queued') runner.start(t);
            else if (body.phase === 'todo') runner.stop(t);
            else runner.move(t, body.phase);
            break;
          default:
            throw new HttpError(400, 'Unknown action');
        }
        return t;
      }
    }

    if (res === 'rules' && rid && method === 'POST' && sub === 'run') {
      const r = store.data.rules.find((x) => x.id === rid);
      if (!r) throw new HttpError(404, 'No such rule');
      const t = rules.fire(r);
      if (!t) throw new HttpError(409, `This rule already has ${r.maxOpen} open todo${r.maxOpen > 1 ? 's' : ''}; it runs again when one is done or closed`);
      return t;
    }
    if (res === 'rules' && (method === 'POST' || method === 'PATCH') && !sub) {
      const cur = rid ? store.data.rules.find((x) => x.id === rid) : {};
      if (!cur) throw new HttpError(404, 'No such rule');
      try {
        const merged = rules.normalize({ ...cur, ...pick(body) });
        body.nextAt = merged.nextAt;
      } catch (e) {
        throw new HttpError(400, e.message);
      }
      return rid ? rulesCrud.update(rid, body) : rulesCrud.create(body);
    }
    if (res === 'rules' && method === 'DELETE') return rulesCrud.remove(rid);

    if (res === 'sources') {
      const d = store.data;
      if (method === 'POST' && !rid) {
        const kind = ['webhook', 'github', 'github-poll'].includes(body.kind) ? body.kind : 'webhook';
        if (kind === 'github-poll' && !/^[\w.-]+\/[\w.-]+$/.test(body.repo || '')) throw new HttpError(400, 'Give the repository as owner/name');
        const key = kind === 'github-poll' ? null : newKey();
        const src = { id: (body.name || kind).toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-|-$/g, '').slice(0, 30) || 'source', name: body.name || kind, kind, repo: body.repo || '', everyMinutes: Number(body.everyMinutes) || 5, createdAt: now() };
        while (d.sources.some((x) => x.id === src.id)) src.id += '-2';
        // Generic webhooks keep only a hash of their key; GitHub needs the secret itself to check signatures.
        if (kind === 'webhook') src.keyHash = hashKey(key);
        if (kind === 'github') src.secret = key;
        d.sources.push(src);
        store.changed();
        if (kind === 'github-poll') rules.poll(src, true);
        return { ...src, key, keyHash: undefined, secret: undefined, path: `/hooks/${src.id}` };
      }
      const src = d.sources.find((x) => x.id === rid);
      if (!src) throw new HttpError(404, 'No such source');
      if (method === 'POST' && sub === 'poll') {
        await rules.poll(src, true);
        return { ok: true, lastError: src.lastError };
      }
      if (method === 'DELETE') {
        d.sources = d.sources.filter((x) => x !== src);
        store.changed();
        return { ok: true };
      }
    }
    if (res === 'workers') {
      const d = store.data;
      if (method === 'POST' && rid === 'pair') {
        const p = workers.newPairing({ name: body.name });
        return { code: p.code, expiresAt: new Date(p.expires).toISOString() };
      }
      if (method === 'POST' && rid === 'ssh') {
        return await workers.addSsh(String(body.target || '').trim(), Number(new URL(runner.hubUrl).port)).catch((e) => {
          throw new HttpError(400, e.message);
        });
      }
      if (method === 'POST' && rid === 'approve') return { id: workers.approvePairing(String(body.code), body.name) };
      if (method === 'POST' && rid === 'reject') return (workers.rejectPairing(String(body.code)), { ok: true });
      if (method === 'POST' && !rid) {
        const name = String(body.name || '').trim().slice(0, 40);
        if (!/^[\w.-]+$/.test(name)) throw new HttpError(400, 'Name the machine with letters, digits, "-" or "."');
        if (d.workers.some((w) => w.id === name)) throw new HttpError(400, 'A machine with that name exists');
        const key = newKey();
        d.workers.push({ id: name, name, keyHash: hashKey(key), capacity: Math.max(1, Number(body.capacity) || 2), createdAt: now() });
        store.changed();
        return { id: name, key };
      }
      const w = workers.get(rid);
      if (!w) throw new HttpError(404, 'No such machine');
      if (method === 'PATCH') {
        if (body.capacity) w.capacity = Math.max(1, Math.min(20, Number(body.capacity)));
        store.changed();
        return { ok: true };
      }
      if (method === 'DELETE') {
        workers.remove(w.id);
        d.workers = d.workers.filter((x) => x !== w);
        for (const a of d.agents) if (a.machine === w.id) a.machine = '';
        store.changed();
        return { ok: true };
      }
    }
    if (res === 'channels') {
      const d = store.data;
      if (method === 'POST' && rid && sub === 'test') {
        const ch = d.channels.find((x) => x.id === rid);
        if (!ch) throw new HttpError(404, 'No such channel');
        await send(ch, '🔔 Autodos test message: this channel works.').catch((e) => {
          throw new HttpError(400, e.message);
        });
        return { ok: true };
      }
      if (method === 'POST' && !rid) {
        if (!CHANNEL_KINDS.includes(body.kind)) throw new HttpError(400, 'Unknown channel kind');
        await checkUrl(body.url || '').catch((e) => {
          throw new HttpError(400, e.message);
        });
        const ch = { id: id('ch'), name: body.name || body.kind, kind: body.kind, url: body.url, secret: body.secret || '', enabled: true };
        d.channels.push(ch);
        store.changed();
        return { ok: true, id: ch.id };
      }
      const ch = d.channels.find((x) => x.id === rid);
      if (!ch) throw new HttpError(404, 'No such channel');
      if (method === 'PATCH') {
        if ('enabled' in body) ch.enabled = !!body.enabled;
        if (body.name) ch.name = body.name;
        store.changed();
        return { ok: true };
      }
      if (method === 'DELETE') {
        d.channels = d.channels.filter((x) => x !== ch);
        store.changed();
        return { ok: true };
      }
    }

    for (const [name, c] of [['agents', agents], ['projects', projects]]) {
      if (res !== name) continue;
      if (method === 'POST' && !rid) {
        if (name === 'projects') {
          if (body.create) {
            // New empty project: make the folder, start a git repository with a README.
            if (!body.path || !path.isAbsolute(body.path)) throw new HttpError(400, 'Give an absolute folder path');
            if (fs.existsSync(body.path) && fs.readdirSync(body.path).length) throw new HttpError(400, 'That folder already exists and is not empty');
            fs.mkdirSync(body.path, { recursive: true });
            fs.writeFileSync(path.join(body.path, 'README.md'), `# ${path.basename(body.path)}\n`);
            await git(body.path, ['init', '-q']);
            await git(body.path, ['add', '-A']);
            await git(body.path, ['-c', 'user.name=Autodos', '-c', 'user.email=autodos@localhost', 'commit', '-qm', 'Initial commit']);
            delete body.create;
          }
          if (!body.path || !fs.existsSync(body.path)) throw new HttpError(400, 'That folder does not exist');
          body.git = await isGitRepo(body.path);
        }
        return c.create(body);
      }
      if (method === 'PATCH') return c.update(rid, body);
      if (method === 'DELETE') return c.remove(rid);
    }
    throw new HttpError(404, 'Not found');
  }

  /** Incoming events from outside: authenticated by the source's key, so they may come through a tunnel. */
  async function hook(req, res, sourceId) {
    const reply = (status, obj) => (res.writeHead(status, { 'Content-Type': 'application/json' }), res.end(JSON.stringify(obj)));
    const src = store.data.sources.find((x) => x.id === sourceId && x.kind !== 'github-poll');
    if (req.method !== 'POST' || !src) return reply(404, { error: 'Unknown source' });
    const chunks = [];
    let size = 0;
    for await (const c of req) {
      size += c.length;
      if (size > 1_000_000) return reply(413, { error: 'Too large' });
      chunks.push(c);
    }
    const raw = Buffer.concat(chunks);
    let body;
    try {
      body = JSON.parse(raw.toString('utf8') || '{}');
    } catch {
      return reply(400, { error: 'Body must be JSON' });
    }
    let ev;
    if (src.kind === 'github') {
      if (!verifyGitHub(src.secret, raw, req.headers['x-hub-signature-256'])) return reply(401, { error: 'Bad signature' });
      const name = String(req.headers['x-github-event'] || 'event');
      if (name === 'ping') return reply(200, { ok: true, pong: true });
      ev = { ...fromGitHub(name, body), deliveryId: req.headers['x-github-delivery'] || null };
    } else {
      const key = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
      const a = Buffer.from(hashKey(key));
      const b = Buffer.from(src.keyHash || '');
      if (!key || a.length !== b.length || !crypto.timingSafeEqual(a, b)) return reply(401, { error: 'Bad key' });
      if (!body.type || !body.title) return reply(400, { error: 'An event needs at least "type" and "title"' });
      ev = { type: String(body.type), title: String(body.title).slice(0, 200), body: String(body.body || ''), url: String(body.url || ''), key: body.key ? String(body.key) : null, deliveryId: body.id ? `${src.id}:${body.id}` : null, data: body.data || null };
    }
    return reply(200, rules.ingest(src, ev));
  }

  /** Remote machines: key-authenticated, so (like /hooks) reachable through a tunnel. */
  async function workerApi(req, res, url) {
    const reply = (status, obj) => (res.writeHead(status, { 'Content-Type': 'application/json' }), res.end(JSON.stringify(obj)));
    // Pairing happens before the machine has a key: a one-time code, then the person approves.
    if (url.pathname === '/workers/pair' || url.pathname === '/workers/pair/wait') {
      let raw = '';
      for await (const c of req) {
        raw += c;
        if (raw.length > 10_000) return reply(413, { error: 'Too large' });
      }
      let b = {};
      try {
        b = JSON.parse(raw || '{}');
      } catch {}
      if (url.pathname === '/workers/pair') {
        const out = workers.requestPairing(b.code, b.nonce, b);
        return out ? reply(200, out) : reply(404, { error: 'Unknown or expired code' });
      }
      return reply(200, await workers.waitPairing(b.code, b.nonce));
    }
    const w = workers.auth(req.headers.authorization);
    if (!w) return reply(401, { error: 'Bad machine key' });
    if (req.method !== 'POST') return reply(405, { error: 'POST only' });
    let raw = '';
    for await (const c of req) {
      raw += c;
      if (raw.length > 2_000_000) return reply(413, { error: 'Too large' });
    }
    let body = {};
    try {
      body = raw ? JSON.parse(raw) : {};
    } catch {
      return reply(400, { error: 'Body must be JSON' });
    }
    const m = url.pathname.match(/^\/workers\/(poll|jobs\/([\w-]+)\/(progress|done))$/);
    if (!m) return reply(404, { error: 'Not found' });
    if (m[1] === 'poll') {
      let gone = false;
      req.on('close', () => (gone = true));
      const out = await workers.poll(w, body, Math.min(25_000, Number(url.searchParams.get('wait')) || 25_000));
      // The worker hung up while we held the request: put the job back for its next poll.
      if (gone && out.job) {
        const rec = workers.jobs.get(out.job.id);
        if (rec) rec.status = 'queued';
        return;
      }
      return reply(200, out);
    }
    if (m[3] === 'progress') return reply(200, workers.progress(w, m[2], body.text));
    return reply(200, workers.done(w, m[2], body));
  }

  async function handler(req, res) {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname.startsWith('/workers/')) return workerApi(req, res, url).catch((e) => (res.writeHead(500), res.end(JSON.stringify({ error: e.message }))));
    const hookMatch = url.pathname.match(/^\/hooks\/([\w-]+)$/);
    if (hookMatch) return hook(req, res, hookMatch[1]).catch((e) => (res.writeHead(500), res.end(JSON.stringify({ error: e.message }))));
    // DNS-rebinding guard: the API answers only to loopback host names.
    if (url.pathname.startsWith('/api/')) {
      const hostname = String(req.headers.host || '').replace(/:\d+$/, '').replace(/^\[|\]$/g, '');
      if (!['localhost', '127.0.0.1', '::1'].includes(hostname)) {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'Unexpected Host header' }));
      }
    }
    if (url.pathname === '/api/events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
      res.write('event: state\ndata: {}\n\n');
      clients.add(res);
      const ping = setInterval(() => res.write(': ping\n\n'), 25000);
      req.on('close', () => (clients.delete(res), clearInterval(ping)));
      return;
    }
    const ev = req.method === 'GET' && url.pathname.match(/^\/api\/todos\/([\w#]+)\/evidence\/([^/]+)$/);
    if (ev) {
      let key, name;
      try {
        key = decodeURIComponent(ev[1]);
        name = decodeURIComponent(ev[2]);
      } catch {
        return res.writeHead(400), res.end();
      }
      const t = store.todo(key);
      if (!t || !(t.evidence || []).some((e) => e.name === name)) return res.writeHead(404), res.end();
      return serveEvidence(res, path.join(store.dir, 'evidence', t.id), name);
    }
    if (url.pathname.startsWith('/api/')) {
      let body = {};
      try {
        if (req.method !== 'GET') {
          // This API can start coding agents, so refuse cross-site requests from other web pages.
          const origin = req.headers.origin;
          if (origin && new URL(origin).host !== req.headers.host) throw new HttpError(403, 'Cross-origin request refused');
          // DELETE carries no body (and is never a "simple" cross-site request); everything else must be JSON.
          if (req.method !== 'DELETE' && !String(req.headers['content-type'] || '').startsWith('application/json')) throw new HttpError(415, 'Use application/json');
          const raw = await new Promise((ok) => {
            let s = '';
            req.on('data', (c) => (s += c));
            req.on('end', () => ok(s));
          });
          body = raw ? JSON.parse(raw) : {};
        }
        const out = await route(req.method, url, body);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(out ?? {}));
      } catch (e) {
        res.writeHead(e.status || 400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
      return;
    }
    // Static web app with SPA fallback.
    let file = path.join(DIST, path.normalize(url.pathname).replace(/^(\.\.[/\\])+/, ''));
    if (!file.startsWith(DIST) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(DIST, 'index.html');
    if (!fs.existsSync(file)) {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      return res.end('Web app not built yet. Run `npm run build`, or use `npm run dev` for development.');
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  }

  const server = http.createServer(handler);
  process.once('exit', () => previews.stopAll());
  server.on('close', () => {
    previews.stopAll();
    delivery.close();
    autopilot.close();
    workers.close();
    rules.close();
    store.flush();
  });
  return { server, store, runner, chief, feishu, delivery, previews, workers, rules, autopilot };
}

export function startServer({ port = Number(process.env.PORT) || 4747, host = '127.0.0.1', dataDir } = {}) {
  const app = createApp({ dataDir });
  return new Promise((resolve, reject) => {
    app.server.once('error', reject);
    app.server.listen(port, host, () => {
      app.runner.hubUrl = `http://127.0.0.1:${app.server.address().port}`;
      app.workers.hubPort = app.server.address().port;
      resolve({ ...app, port: app.server.address().port });
    });
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const { port, store } = await startServer();
  console.log(`Autodos is running at http://localhost:${port}  (data: ${store.dir})`);
  const bye = () => (store.flush(), process.exit(0));
  process.on('SIGINT', bye);
  process.on('SIGTERM', bye);
  // Started by the desktop app: stop when the app is gone, even if it was force-quit.
  const parent = Number(process.env.AUTODOS_PARENT_PID);
  if (parent)
    setInterval(() => {
      try {
        process.kill(parent, 0);
      } catch {
        bye();
      }
    }, 2000).unref();
}
