// dsh-autodos-core — the Autodos ledger and status board as a DeepSeek Harness plugin.
//
// Step 1 of the move to DSH, plus the first working loop: tasks dispatched through Paseo,
// followed in the background, and answered from the panel.
// Step 1 of the move to DSH (see the design doc): one append-only event log in SQLite, the objects
// folded from it (goals, projects, staff, machines, tasks, threads, outputs, decisions), a one-time
// read-only import of the current Autodos board, a "Tasks" panel in the DSH sidebar, and tools the
// chief of staff can call to read the board and a task's timeline.
//
// Host half: plain ESM, no build step, no dependencies beyond the Node that runs DSH.
import path from 'node:path';
import os from 'node:os';
import { Ledger } from './lib/store.js';
import { importAutodosFile, autodosDataFile } from './lib/import.js';
import { board, boardText, taskDetail } from './lib/board.js';
import { Autodos } from './lib/actions.js';
import { createPaseo } from './lib/paseo.js';

export const name = 'autodos-core';
export const inject = ['tools'];

/** Where the ledger lives: config.dataDir, else $AUTODOS_DSH_HOME, else <DSH_HOME>/plugins/autodos. */
export function dataDir(config = {}, env = process.env) {
  if (config.dataDir) return config.dataDir;
  if (env.AUTODOS_DSH_HOME) return env.AUTODOS_DSH_HOME;
  return path.join(env.DSH_HOME || path.join(os.homedir(), '.dsh'), 'plugins', 'autodos');
}

const OBJECT = { type: 'object', additionalProperties: true };
const asText = (value) => [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }];
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });

/** Open the ledger and, the first time, import the old board. Exported for tests and the CLI. */
export function openLedger(config = {}, { log = () => {} } = {}) {
  const ledger = new Ledger(path.join(dataDir(config), 'autodos.db'));
  if (!ledger.meta('imported') && config.importAutodos !== false) {
    const file = config.autodosData || autodosDataFile();
    try {
      const counts = importAutodosFile(ledger, file);
      if (counts) log(`imported the Autodos board from ${file}: ${counts.task} tasks, ${counts.project} projects, ${counts.message + counts.chat} messages`);
    } catch (e) {
      log(`could not import ${file}: ${e.message}`);
    }
  }
  return ledger;
}

const clean = (v) => JSON.parse(JSON.stringify(v ?? null));
const str = { type: 'string' };

/** The tools the chief of staff (any DSH agent) can call. Exported for tests. Permission requests are not among them. */
export function tools(ledger, autodos = new Autodos(ledger)) {
  const brief = (t) => ({ id: t.id, number: t.number, title: t.title, state: t.state, branch: t.branch || null, waitingFor: t.waitingFor || null });
  return [
    {
      name: 'autodos_board',
      description:
        'Read the Autodos status board: every open task with who is on it (machine · staff), its state, where it is stuck, ' +
        'what it waits on the person for, when it last moved and what it delivered. Tasks waiting on the person come first. ' +
        'Use it before answering "what is going on", before starting new work, and before reporting.',
      parameters: {
        type: 'object',
        properties: {
          projectId: { type: 'string', description: 'Only this project.' },
          goalId: { type: 'string', description: 'Only this goal.' },
          all: { type: 'boolean', description: 'Include finished, failed and dropped tasks.' },
        },
        additionalProperties: false,
      },
      output: { schema: OBJECT, render: (_args, value) => asText(value.text) },
      async execute(args = {}) {
        const b = board(ledger, { open: !args.all, projectId: args.projectId, goalId: args.goalId });
        return JSON.parse(JSON.stringify({ ...b, text: boardText(b) }));
      },
    },
    {
      name: 'autodos_task',
      description:
        'Everything known about one Autodos task: its fields, the threads it ran in (machine, session, worktree, branch), ' +
        'what it delivered, open and past decisions, and its full timeline of events (messages, state changes, who and why).',
      parameters: {
        type: 'object',
        properties: { task: { type: 'string', description: 'Task id, or its number like "#123".' } },
        required: ['task'],
        additionalProperties: false,
      },
      output: { schema: OBJECT, render: (_args, value) => asText(value) },
      async execute(args = {}) {
        const d = taskDetail(ledger, String(args.task || '').trim());
        if (!d) throw new Error(`No task ${args.task}`);
        return JSON.parse(JSON.stringify({ ...d, timeline: d.timeline.slice(-200) }));
      },
    },
    {
      name: 'autodos_projects',
      description: 'List the Autodos projects (name, repository path) and staff, to pick where a new task goes.',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      output: { schema: OBJECT, render: (_args, value) => asText(value) },
      async execute() {
        return clean({ projects: ledger.list('project').map((p) => ({ id: p.id, name: p.name, path: p.path || null })), staff: ledger.list('staff').map((s) => ({ id: s.id, name: s.name, role: s.role || null, runtime: s.runtime || null })) });
      },
    },
    {
      name: 'autodos_create_project',
      description: 'Add a project: a name and the absolute path of its git repository on this machine.',
      parameters: { type: 'object', properties: { name: str, path: { type: 'string', description: 'Absolute path of the git repository.' }, description: str }, required: ['name', 'path'], additionalProperties: false },
      output: { schema: OBJECT, render: (_args, value) => asText(value) },
      async execute(args = {}) {
        return clean(autodos.createProject(args, { actor: 'lead' }));
      },
    },
    {
      name: 'autodos_create_task',
      description:
        'File a task in a project. With start (the default), an agent (Claude Code unless provider says otherwise) starts on it ' +
        'at once in its own worktree and branch autodos/<number>; it commits there and never pushes or merges. ' +
        'Write the description as the brief the agent will work from: the goal, the constraints, how to check it.',
      parameters: {
        type: 'object',
        properties: {
          title: str,
          description: str,
          project: { type: 'string', description: 'Project id or name.' },
          provider: { type: 'string', description: 'claude (default) or codex.' },
          start: { type: 'boolean', description: 'Start an agent now (default true).' },
        },
        required: ['title', 'project'],
        additionalProperties: false,
      },
      output: { schema: OBJECT, render: (_args, value) => asText(`#${value.number} ${value.title}: ${value.state}${value.branch ? ` on ${value.branch}` : ''}`) },
      async execute(args = {}) {
        return clean(brief(await autodos.createTask(args, { actor: 'lead', reason: 'filed by the chief of staff' })));
      },
    },
    {
      name: 'autodos_reply',
      description: 'Send a message on a task. The agent working on it receives it. Use it to answer the agent or redirect it.',
      parameters: { type: 'object', properties: { task: { type: 'string', description: 'Task id or "#123".' }, text: str }, required: ['task', 'text'], additionalProperties: false },
      output: { schema: OBJECT, render: (_args, value) => asText(value.sent ? 'Sent to the agent.' : 'Recorded on the task (no agent is running on it).') },
      async execute(args = {}) {
        const r = await autodos.reply(args.task, args.text, { actor: 'lead' });
        return clean({ sent: r.sent, task: brief(r.task) });
      },
    },
    {
      name: 'autodos_retry',
      description: 'Try a stuck or failed task again: nudge its agent, or start a fresh one on the same branch.',
      parameters: { type: 'object', properties: { task: { type: 'string', description: 'Task id or "#123".' }, note: { type: 'string', description: 'What to do differently.' } }, required: ['task'], additionalProperties: false },
      output: { schema: OBJECT, render: (_args, value) => asText(`#${value.number}: ${value.state}`) },
      async execute(args = {}) {
        return clean(brief(await autodos.retry(args.task, { actor: 'lead', note: args.note })));
      },
    },
  ];
}

/** HTTP routes for the panel, under /api/autodos. Exported for tests. Actions here are the person's own. */
export function routes(ledger, autodos = new Autodos(ledger)) {
  const act = {
    create_project: (b) => autodos.createProject(b),
    create_task: (b) => autodos.createTask(b),
    dispatch: (b) => autodos.dispatch(b.task),
    reply: (b) => autodos.reply(b.task, b.text).then((r) => r.task),
    retry: (b) => autodos.retry(b.task, { note: b.note }),
    decide: (b) => autodos.decide(b.decision, b.choice, { note: b.note }),
    drop: (b) => autodos.drop(b.task),
  };
  return [
    {
      path: '/api/autodos/board',
      methods: ['GET'],
      async fetch(request) {
        const u = new URL(request.url, 'http://local');
        const b = board(ledger, { open: u.searchParams.get('all') !== '1', projectId: u.searchParams.get('project') || undefined, goalId: u.searchParams.get('goal') || undefined });
        return json({ ok: true, ...b, counts: ledger.counts(), imported: ledger.meta('imported') || null });
      },
    },
    {
      path: '/api/autodos/task',
      methods: ['GET'],
      async fetch(request) {
        const u = new URL(request.url, 'http://local');
        const d = taskDetail(ledger, u.searchParams.get('id') || '');
        return d ? json({ ok: true, ...d }) : json({ ok: false, error: 'not found' }, 404);
      },
    },
    {
      path: '/api/autodos/projects',
      methods: ['GET'],
      async fetch() {
        return json({ ok: true, projects: ledger.list('project').map((p) => ({ id: p.id, name: p.name, path: p.path || null })), execution: Boolean(autodos.paseo) });
      },
    },
    {
      path: '/api/autodos/action',
      methods: ['POST'],
      async fetch(request) {
        let body;
        try {
          body = await request.json();
        } catch {
          return json({ ok: false, error: 'expected a JSON body' }, 400);
        }
        const fn = act[body?.action];
        if (!fn) return json({ ok: false, error: `unknown action ${body?.action}` }, 400);
        try {
          const result = await fn(body);
          return json({ ok: true, result: clean(result) });
        } catch (e) {
          return json({ ok: false, error: e.message }, 400);
        }
      },
    },
  ];
}

export function apply(ctx, config = {}) {
  const log = (...a) => console.log('[autodos-core]', ...a);
  const ledger = openLedger(config, { log });
  const paseo = config.paseo === false ? null : createPaseo(config.paseo || {});
  const autodos = new Autodos(ledger, { paseo, provider: config.provider, mode: config.mode, log });
  // Follow the running agents in the background, so the board moves without anyone asking.
  const every = Math.max(2000, Number(config.syncMs) || 5000);
  const timer = paseo ? setInterval(() => autodos.sync().catch((e) => log(`sync: ${e.message}`)), every) : null;
  timer?.unref?.();
  ctx.effect?.(() => () => {
    if (timer) clearInterval(timer);
    ledger.close();
  });

  for (const t of tools(ledger, autodos)) ctx.tools.register(t);

  ctx.inject?.(['connection'], (scope) => {
    const reg = scope.connection?.fetch?.register;
    if (typeof reg !== 'function') return;
    for (const r of routes(ledger, autodos)) {
      const dispose = reg.call(scope.connection.fetch, { ...r, requestBody: 'buffered' });
      if (typeof dispose === 'function') scope.effect?.(() => dispose);
    }
  });

  log(`ledger at ${ledger.file}: ${JSON.stringify(ledger.counts())}`);
}
