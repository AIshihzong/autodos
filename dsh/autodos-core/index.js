// dsh-autodos-core — the Autodos ledger and status board as a DeepSeek Harness plugin.
//
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

/** The tools the chief of staff (any DSH agent) can call. Exported for tests. */
export function tools(ledger) {
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
  ];
}

/** HTTP routes for the panel, under /api/autodos. Exported for tests. */
export function routes(ledger) {
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
  ];
}

export function apply(ctx, config = {}) {
  const log = (...a) => console.log('[autodos-core]', ...a);
  const ledger = openLedger(config, { log });
  ctx.effect?.(() => () => ledger.close());

  for (const t of tools(ledger)) ctx.tools.register(t);

  ctx.inject?.(['connection'], (scope) => {
    const reg = scope.connection?.fetch?.register;
    if (typeof reg !== 'function') return;
    for (const r of routes(ledger)) {
      const dispose = reg.call(scope.connection.fetch, { ...r, requestBody: 'buffered' });
      if (typeof dispose === 'function') scope.effect?.(() => dispose);
    }
  });

  log(`ledger at ${ledger.file}: ${JSON.stringify(ledger.counts())}`);
}
