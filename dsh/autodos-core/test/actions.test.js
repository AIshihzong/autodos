import test from 'node:test';
import assert from 'node:assert/strict';
import { Ledger } from '../lib/store.js';
import { Autodos, newText } from '../lib/actions.js';
import { createPaseo } from '../lib/paseo.js';
import { board } from '../lib/board.js';
import * as plugin from '../index.js';

/** A stand-in for the Paseo daemon: one agent whose status and output the test moves along. */
function fakePaseo() {
  const calls = [];
  const agents = new Map();
  let n = 0;
  return {
    calls,
    agents,
    async dispatch(a) {
      calls.push(['dispatch', a]);
      const id = `ag-${++n}`;
      agents.set(id, { status: 'running', pendingPermissions: [], activity: '', usage: { CostUsd: 0 }, cwd: `/w/${a.branch}` });
      return { agentId: id, status: 'running', provider: a.provider };
    },
    async send(a) {
      calls.push(['send', a]);
      agents.get(a.agentId).status = 'running';
    },
    async status({ agentId }) {
      const a = agents.get(agentId);
      return { agentId, model: 'opus', ...a };
    },
    async permit(a) {
      calls.push(['permit', a]);
      agents.get(a.agentId).pendingPermissions = [];
      agents.get(a.agentId).status = 'running';
    },
    async stop(a) {
      calls.push(['stop', a]);
      agents.get(a.agentId).status = 'stopped';
    },
  };
}

function setup() {
  const l = new Ledger(':memory:');
  const paseo = fakePaseo();
  const a = new Autodos(l, { paseo });
  const p = a.createProject({ name: 'Demo', path: '/repos/demo' });
  return { l, paseo, a, p };
}

test('a task goes from chat to an agent, through a permission, to an accepted result', async () => {
  const { l, paseo, a } = setup();
  const t = await a.createTask({ title: 'Add a footer', description: 'Put the year in it.', project: 'demo' }, { actor: 'lead' });
  assert.equal(t.state, 'working');
  assert.equal(t.number, 1);
  assert.equal(t.branch, 'autodos/1');
  const [, run] = paseo.calls[0];
  assert.equal(run.cwd, '/repos/demo');
  assert.equal(run.branch, 'autodos/1');
  assert.match(run.prompt, /Add a footer[\s\S]*Put the year in it[\s\S]*Do not push/);

  const agentId = l.get('thread', t.threadId).agentId;
  const ag = paseo.agents.get(agentId);
  ag.activity = 'Reading the layout\nEditing footer.tsx';
  await a.sync();
  ag.activity = 'Task #1: Add a footer\nPut the year in it.\nEditing footer.tsx\nRunning npm test';
  ag.pendingPermissions = [{ id: 'perm-1', tool: 'Bash', description: 'Run npm test' }];
  await a.sync();
  let row = board(l).rows[0];
  assert.equal(row.state, 'waiting_you');
  assert.equal(row.waitingKind, 'permission');
  assert.equal(row.waitingFor, 'Run npm test');
  assert.equal(row.decision.reversible, false);
  await a.sync(); // still pending: no second decision
  const perms = a.openDecisions(t.id, 'permission');
  assert.equal(perms.length, 1);
  assert.equal(l.get('thread', t.threadId).status, 'permission');

  await a.decide(perms[0].id, 'Allow');
  assert.deepEqual(paseo.calls.at(-1), ['permit', { agentId, requestId: 'perm-1', allow: true }]);
  assert.equal(l.get('task', t.id).state, 'working');

  ag.status = 'idle';
  ag.activity = 'Running npm test\nAll 12 tests pass. Committed "Add footer".';
  ag.usage = { CostUsd: 0.42 };
  await a.sync();
  row = board(l).rows[0];
  assert.equal(row.waitingKind, 'result');
  assert.equal(row.waitingFor, 'Look at the result');
  assert.equal(l.get('thread', t.threadId).costUsd, 0.42);

  const result = a.openDecisions(t.id, 'result')[0];
  await assert.rejects(a.decide(result.id, 'Keep working'), /Say what to change/);
  await a.decide(result.id, 1, { note: 'Use a smaller font.' });
  assert.deepEqual(paseo.calls.at(-1), ['send', { agentId, text: 'Use a smaller font.' }]);
  assert.equal(l.get('task', t.id).state, 'working');

  ag.status = 'idle';
  await a.sync();
  await a.decide(a.openDecisions(t.id, 'result')[0].id, 'Accept');
  const done = l.get('task', t.id);
  assert.equal(done.state, 'done');
  assert.equal(l.get('thread', t.threadId).active, false);
  assert.equal(l.list('output', { where: (o) => o.taskId === t.id })[0].ref, 'autodos/1');

  const types = l.timeline(t.id).map((e) => e.type);
  assert.equal(types.filter((x) => x === 'thread.activity').length, 3);
  const acts = l.timeline(t.id).filter((e) => e.type === 'thread.activity').map((e) => e.data.text);
  assert.deepEqual(acts.slice(0, 2), ['Reading the layout\nEditing footer.tsx', 'Running npm test']);
  assert.ok(l.timeline(t.id).some((e) => e.type === 'thread.message' && e.actor === 'you' && e.data.text === 'Use a smaller font.'));
});

test('reply, retry and drop', async () => {
  const { l, paseo, a } = setup();
  const t = await a.createTask({ title: 'Fix login', project: 'Demo' });
  const agentId = l.get('thread', t.threadId).agentId;
  assert.equal((await a.reply('#1', 'Check the cookie path too')).sent, true);
  assert.deepEqual(paseo.calls.at(-1), ['send', { agentId, text: 'Check the cookie path too' }]);

  paseo.agents.get(agentId).status = 'error';
  paseo.agents.get(agentId).activity = 'Error: out of tokens';
  await a.sync();
  assert.equal(l.get('task', t.id).state, 'stuck');
  assert.match(l.get('task', t.id).stuck, /stopped \(error\)[\s\S]*out of tokens/);

  const again = await a.retry(t.id, { note: 'Keep the change small.' });
  assert.equal(again.state, 'working');
  assert.notEqual(again.threadId, t.threadId);
  const [, run] = paseo.calls.at(-1);
  assert.match(run.prompt, /Keep the change small[\s\S]*earlier attempt failed/);
  assert.equal(run.branch, 'autodos/1');

  const dropped = await a.drop(t.id);
  assert.equal(dropped.state, 'dropped');
  assert.equal(paseo.calls.at(-1)[0], 'stop');

  const later = await a.createTask({ title: 'Just an idea', project: 'Demo', start: false });
  assert.equal(later.state, 'queued');
  assert.equal(later.number, 2);
  assert.equal((await a.reply(later.id, 'Maybe next week')).sent, false);
  await assert.rejects(a.createTask({ title: 'x', project: 'nope' }), /No project/);
  assert.throws(() => a.createProject({ name: 'demo', path: '/x' }), /already exists/);
});

test('the panel acts through one route; agent tools cannot answer permissions', async () => {
  const l = new Ledger(':memory:');
  const paseo = fakePaseo();
  const a = new Autodos(l, { paseo });
  const routes = plugin.routes(l, a);
  const action = routes.find((r) => r.path === '/api/autodos/action');
  const post = async (body) => (await action.fetch(new Request('http://dsh.local/api/autodos/action', { method: 'POST', body: JSON.stringify(body) }))).json();
  assert.equal((await post({ action: 'create_project', name: 'Demo', path: '/repos/demo' })).ok, true);
  const made = await post({ action: 'create_task', title: 'Footer', project: 'Demo' });
  assert.equal(made.result.state, 'working');
  const bad = await post({ action: 'decide', decision: 'nope', choice: 0 });
  assert.equal(bad.ok, false);
  assert.match(bad.error, /No decision/);
  assert.equal((await post({ action: 'rm -rf' })).ok, false);
  const projects = await (await routes.find((r) => r.path === '/api/autodos/projects').fetch(new Request('http://dsh.local/api/autodos/projects'))).json();
  assert.equal(projects.projects[0].path, '/repos/demo');

  const tools = plugin.tools(l, a);
  const create = tools.find((t) => t.name === 'autodos_create_task');
  const r = await create.execute({ title: 'Header', project: 'Demo' });
  assert.equal(r.number, 2);
  assert.match(create.output.render({}, r)[0].text, /#2 Header: working on autodos\/2/);
  assert.equal(l.timeline(r.id)[0].actor, 'lead');
});

test('the Paseo wrapper builds the right commands and reads errors', async () => {
  const seen = [];
  const exec = (bin, args, _o, cb) => {
    seen.push([bin, ...args]);
    if (bin === 'git') return cb(null, 'main\n', '');
    if (args[0] === 'run') return cb(null, 'Created workspace\n{"agentId":"a1","status":"running","provider":"claude"}', '');
    if (args[0] === 'inspect') return cb(null, JSON.stringify({ Id: 'a1', Status: 'Idle', PendingPermissions: [{ id: 'p1', tool: 'Bash' }], LastUsage: { CostUsd: 0.1 } }), '');
    if (args[0] === 'logs') return cb(null, 'line 1\nline 2\n', '');
    if (args[0] === 'send') return cb(Object.assign(new Error('exit 1'), { code: 1 }), '{"error":{"code":"NOT_FOUND","message":"no agent a9"}}', '');
    return cb(null, '{}', '');
  };
  const p = createPaseo({ bin: 'paseo', exec });
  const r = await p.dispatch({ cwd: '/repos/demo', prompt: 'do it', provider: 'claude', branch: 'autodos/7', title: '#7 x' });
  assert.equal(r.agentId, 'a1');
  const run = seen.find((s) => s[1] === 'run');
  assert.deepEqual(run.slice(0, 4), ['paseo', 'run', '--no-wait', '--cwd']);
  assert.ok(run.includes('--new-branch') && run.includes('autodos/7') && run.includes('--base') && run.includes('main'));
  assert.equal(run.at(-2), 'do it');
  assert.equal(run.at(-1), '--json');
  const st = await p.status({ agentId: 'a1' });
  assert.equal(st.status, 'idle');
  assert.deepEqual(st.pendingPermissions, [{ id: 'p1', tool: 'Bash', description: null }]);
  assert.match(st.activity, /line 2/);
  await assert.rejects(p.send({ agentId: 'a9', text: 'hi' }), /NOT_FOUND: no agent a9/);
  await p.permit({ agentId: 'a1', requestId: 'p1', allow: false });
  assert.deepEqual(seen.at(-1).slice(1, 5), ['permit', 'deny', 'a1', 'p1']);
});

test('the prompt is not echoed into the timeline, and a permission says what it is for', async () => {
  const { l, paseo, a } = setup();
  const t = await a.createTask({ title: 'Add hello', description: 'Write hello.sh', project: 'Demo' });
  const ag = paseo.agents.get(l.get('thread', t.threadId).agentId);
  ag.activity = '[User] Task #1: Add hello\nWrite hello.sh\n[Shell] ls -la\n[Write] /w/autodos-1/hello.sh';
  ag.pendingPermissions = [{ id: 'p1', tool: 'Write' }];
  await a.sync();
  const acts = l.timeline(t.id).filter((e) => e.type === 'thread.activity').map((e) => e.data.text);
  assert.deepEqual(acts, ['[Shell] ls -la\n[Write] /w/autodos-1/hello.sh']);
  assert.equal(a.openDecisions(t.id, 'permission')[0].question, 'Allow Write?\n[Write] /w/autodos-1/hello.sh');
});

test('only new output is recorded', () => {
  assert.equal(newText('', 'a\nb'), 'a\nb');
  assert.equal(newText('a\nb', 'a\nb'), '');
  assert.equal(newText('a\nb', 'b\nc\nd'), 'c\nd');
  assert.equal(newText('a\nb', 'a\nb\nc'), 'c');
  assert.equal(newText('x', 'y'), 'y');
});
