import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Ledger } from '../lib/store.js';
import { importAutodos, importAutodosFile } from '../lib/import.js';
import { board, boardText, taskDetail, taskState } from '../lib/board.js';
import * as plugin from '../index.js';

/** A small Autodos db.json with one todo in each interesting phase. */
function fixture() {
  const at = (h) => `2026-11-1${h < 10 ? 3 : 4}T${String(h % 24).padStart(2, '0')}:00:00.000Z`;
  return {
    version: 1,
    settings: { concurrency: 3, budgetUsd: 3 },
    projects: [{ id: 'p_art', name: 'Artist crew', path: '/Users/x/projects/artist-crew', createdAt: at(1) }],
    agents: [
      { id: 'ag_frontend', name: 'Frontend engineer', role: 'UI', runtime: 'claude' },
      { id: 'ag_backend', name: 'Backend engineer', role: 'APIs', runtime: 'codex' },
    ],
    workers: [{ id: 'studio', name: 'studio', capacity: 2, createdAt: at(2) }],
    requirements: [{ id: 'r1', number: 1, title: 'Gallery', state: 'confirmed' }],
    todos: [
      { id: 't1', number: 101, title: 'Gallery page', projectId: 'p_art', agentId: 'ag_frontend', phase: 'building', runtime: 'claude', sessionId: 's-1', worktree: '/w/t1', branch: 'autodos/101', createdAt: at(3), updatedAt: at(5),
        messages: [{ role: 'user', text: 'Make the gallery responsive', at: at(3) }, { role: 'agent', text: 'On it', at: at(4) }] },
      { id: 't2', number: 102, title: 'Pricing copy', projectId: 'p_art', agentId: 'ag_frontend', phase: 'asking', question: 'Monthly or yearly first?', createdAt: at(2), updatedAt: at(6), messages: [] },
      { id: 't3', number: 103, title: 'Upload API', projectId: 'p_art', agentId: 'ag_backend', phase: 'review', sessionMachine: 'studio', branch: 'autodos/103', pr: { number: 7, url: 'https://github.test/pr/7' }, gateReason: 'Changes the database', createdAt: at(1), updatedAt: at(7) },
      { id: 't4', number: 104, title: 'Old spike', projectId: 'p_art', phase: 'done', branch: 'autodos/104', mergeLanded: true, evidence: [{ kind: 'image', file: 'shot.png' }], createdAt: at(1), updatedAt: at(2) },
      { id: 't5', number: 105, title: 'Flaky build', projectId: 'p_art', phase: 'queued', error: 'npm test failed\nat line 3', createdAt: at(1), updatedAt: at(4) },
      { id: 't6', number: 106, title: 'Dropped', phase: 'closed', createdAt: at(1), updatedAt: at(1) },
    ],
    chief: [{ id: 'c1', role: 'user', text: 'Ship the gallery this week', at: at(1) }, { id: 'c2', role: 'assistant', text: 'Filed #101', at: at(2) }],
    rules: [{ id: 'ru1', name: 'nightly', cron: '0 3 * * *' }],
  };
}

test('phases map to board states', () => {
  assert.equal(taskState({ phase: 'building' }), 'working');
  assert.equal(taskState({ phase: 'confirm' }), 'waiting_you');
  assert.equal(taskState({ phase: 'queued', error: 'x' }), 'stuck');
  assert.equal(taskState({ phase: 'merging' }), 'landing');
  assert.equal(taskState({ phase: 'closed' }), 'dropped');
  assert.equal(taskState({ phase: 'building', leadHold: true }), 'waiting_you');
});

test('the Autodos board imports completely, once', () => {
  const l = new Ledger(':memory:');
  const counts = importAutodos(l, fixture(), { source: 'fixture' });
  assert.deepEqual(counts, { project: 1, staff: 2, machine: 2, requirement: 1, task: 6, thread: 3, output: 3, decision: 2, message: 2, chat: 2, rule: 1 });
  assert.equal(l.list('task').length, 6);
  assert.equal(l.get('settings', 'autodos').budgetUsd, 3);
  assert.equal(l.get('machine', 'studio').name, 'studio');
  assert.throws(() => importAutodos(l, fixture()), /already imported/);

  const t3 = l.get('task', 't3');
  assert.equal(t3.state, 'waiting_you');
  assert.equal(t3.machine, 'studio');
  assert.equal(t3.waitingFor, 'Changes the database');
  const d = taskDetail(l, '#101');
  assert.equal(d.task.id, 't1');
  assert.equal(d.threads[0].sessionId, 's-1');
  assert.deepEqual(d.timeline.filter((e) => e.type === 'thread.message').map((e) => [e.actor, e.data.text]), [['you', 'Make the gallery responsive'], ['staff:ag_frontend', 'On it']]);
  assert.equal(l.since(0).filter((e) => e.type === 'chat.message').length, 2);
});

test('the board puts what waits on you first and says who, where and why', () => {
  const l = new Ledger(':memory:');
  importAutodos(l, fixture());
  const b = board(l);
  assert.deepEqual(b.rows.map((r) => r.number), [103, 102, 105, 101]);
  assert.deepEqual(b.byState, { waiting_you: 2, stuck: 1, working: 1 });
  const [review, ask, stuck, working] = b.rows;
  assert.equal(review.waitingFor, 'Changes the database');
  assert.equal(review.who.machine, 'studio');
  assert.equal(review.who.staff, 'Backend engineer');
  assert.equal(review.outputs[0].url, 'https://github.test/pr/7');
  assert.equal(review.decision.reversible, false);
  assert.equal(ask.waitingFor, 'Monthly or yearly first?');
  assert.equal(stuck.stuck, 'npm test failed\nat line 3');
  assert.equal(working.project.name, 'Artist crew');
  assert.equal(board(l, { open: false }).total, 6);
  const text = boardText(b);
  assert.match(text, /WAITING ON YOU\] #103 Upload API/);
  assert.match(text, /needs: Monthly or yearly first\?/);
});

test('the plugin imports on first open, then serves tools and routes', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'autodos-dsh-'));
  const db = path.join(dir, 'db.json');
  fs.writeFileSync(db, JSON.stringify(fixture()));
  const before = fs.readFileSync(db, 'utf8');
  const config = { dataDir: path.join(dir, 'ledger'), autodosData: db };
  const logs = [];
  const l = plugin.openLedger(config, { log: (m) => logs.push(m) });
  assert.match(logs[0], /6 tasks, 1 projects, 4 messages/);
  assert.equal(fs.readFileSync(db, 'utf8'), before, 'the old board is never written');
  assert.equal(importAutodosFile(l, path.join(dir, 'missing.json')), null);

  const [boardTool, taskTool] = plugin.tools(l);
  const b = await boardTool.execute({});
  assert.equal(b.total, 4);
  assert.match(boardTool.output.render({}, b)[0].text, /4 open task/);
  const all = await boardTool.execute({ all: true });
  assert.equal(all.total, 6);
  const d = await taskTool.execute({ task: '#103' });
  assert.equal(d.task.title, 'Upload API');
  await assert.rejects(taskTool.execute({ task: '#999' }), /No task/);

  const [boardRoute, taskRoute] = plugin.routes(l);
  const res = await boardRoute.fetch(new Request('http://dsh.local/api/autodos/board'));
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.rows.length, 4);
  assert.equal(body.counts.task, 6);
  assert.equal(body.imported.counts.task, 6);
  const miss = await taskRoute.fetch(new Request('http://dsh.local/api/autodos/task?id=nope'));
  assert.equal(miss.status, 404);
  l.close();

  // Reopening does not import again.
  const again = plugin.openLedger(config, { log: (m) => logs.push(m) });
  assert.equal(logs.length, 1);
  assert.equal(again.list('task').length, 6);
  again.close();
});

test('apply registers the tools, the routes and closes the ledger on dispose', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'autodos-dsh-'));
  const registered = [];
  const routes = [];
  const effects = [];
  const ctx = {
    tools: { register: (t) => registered.push(t.name) },
    effect: (fn) => effects.push(fn()),
    inject: (names, cb) => cb({ connection: { fetch: { register(r) { routes.push(r); return () => {}; } } }, effect: (fn) => effects.push(fn()) }),
  };
  plugin.apply(ctx, { dataDir: path.join(dir, 'l'), autodosData: path.join(dir, 'none.json') });
  assert.deepEqual(registered, ['autodos_board', 'autodos_task']);
  assert.deepEqual(routes.map((r) => r.path), ['/api/autodos/board', '/api/autodos/task']);
  assert.ok(routes.every((r) => r.requestBody === 'buffered'));
  for (const dispose of effects) if (typeof dispose === 'function') dispose();
});
