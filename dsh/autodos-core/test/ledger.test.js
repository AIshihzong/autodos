import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Ledger } from '../lib/store.js';

const tmp = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'autodos-ledger-')), 'ledger.db');

test('objects are folded from events, and the timeline keeps every change', () => {
  const l = new Ledger(':memory:');
  const seen = [];
  l.subscribe((ev) => seen.push(ev.type));
  const t = l.create('task', { title: 'Add tests', state: 'queued', labels: ['qa'] }, { actor: 'you', reason: 'asked in chat' });
  assert.equal(t.title, 'Add tests');
  assert.ok(t.id.startsWith('ta_'));
  l.update('task', t.id, { state: 'working', staffId: 'st_1' }, { actor: 'lead' });
  l.update('task', t.id, { state: 'working' }); // no change: no event
  l.update('task', t.id, { staffId: null }, { actor: 'lead', reason: 'reassigned' });
  l.record('thread.message', { text: 'started' }, { actor: 'staff:st_1', task: t.id });
  const now = l.get('task', t.id);
  assert.equal(now.state, 'working');
  assert.equal('staffId' in now, false);
  const tl = l.timeline(t.id);
  assert.deepEqual(tl.map((e) => e.type), ['task.created', 'task.updated', 'task.updated', 'thread.message']);
  assert.equal(tl[0].reason, 'asked in chat');
  assert.equal(tl[1].actor, 'lead');
  assert.deepEqual(tl[1].data, { state: 'working', staffId: 'st_1' });
  assert.deepEqual(tl[2].was, { staffId: 'st_1' });
  assert.deepEqual(seen, ['task.created', 'task.updated', 'task.updated', 'thread.message']);
  l.remove('task', t.id, { actor: 'you' });
  assert.equal(l.get('task', t.id), null);
  assert.equal(l.get('task', t.id, { removed: true }).removed, true);
  assert.equal(l.list('task').length, 0);
});

test('a failed transaction leaves nothing behind', () => {
  const l = new Ledger(':memory:');
  l.create('project', { id: 'p1', name: 'Artist' });
  assert.throws(() =>
    l.transaction(() => {
      l.create('task', { id: 't1', title: 'one' });
      l.create('project', { id: 'p1', name: 'again' }); // already exists
    }),
  );
  assert.equal(l.get('task', 't1'), null);
  assert.equal(l.counts().events, 1);
  assert.throws(() => l.update('task', 'nope', { a: 1 }), /does not exist/);
});

test('the current state can be rebuilt from the events alone, and survives a reopen', () => {
  const file = tmp();
  const l = new Ledger(file);
  const g = l.create('goal', { name: 'Launch the artist app' });
  const t = l.create('task', { title: 'Landing page', goalId: g.id, state: 'queued' });
  l.update('task', t.id, { state: 'done' });
  l.create('output', { taskId: t.id, type: 'pull-request', url: 'https://example.test/pr/1' }, { task: t.id });
  const before = { task: l.get('task', t.id), goal: l.get('goal', g.id) };
  l.db.exec("UPDATE objects SET data = '{}'"); // corrupt the state on purpose
  assert.equal(l.rebuild(), 3);
  assert.deepEqual(l.get('task', t.id), before.task);
  l.meta('imported', { source: 'x' });
  l.close();
  const again = new Ledger(file);
  assert.deepEqual(again.get('goal', g.id), before.goal);
  assert.equal(again.meta('imported').source, 'x');
  assert.equal(again.since(0).length, 4);
  assert.equal(again.lastSeq(), 4);
  again.close();
});
