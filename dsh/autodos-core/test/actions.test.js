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

// ---- landing, with a real git repository ----
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createGit, runCheck } from '../lib/land.js';

function repo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'autodos-land-'));
  const g = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@x', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@x' } }).trim();
  g('init', '-q', '-b', 'main');
  g('config', 'user.name', 't');
  g('config', 'user.email', 't@x');
  fs.writeFileSync(path.join(dir, 'README.md'), 'hi\n');
  g('add', '.');
  g('commit', '-qm', 'init');
  return { dir, g };
}

/** What an agent would do in its worktree: a branch with one commit. */
function agentCommits(r, branch, file, text) {
  const wt = `${r.dir}-${branch.replace(/\W/g, '-')}`;
  if (!fs.existsSync(wt)) r.g('worktree', 'add', '-q', '-b', branch, wt, 'main');
  fs.writeFileSync(path.join(wt, file), text);
  execFileSync('git', ['add', '.'], { cwd: wt });
  execFileSync('git', ['commit', '-qm', `edit ${file}`], { cwd: wt });
  return wt;
}

async function finished(a, l, paseo, task, wt) {
  const thread = l.get('thread', l.get('task', task.id).threadId);
  const ag = paseo.agents.get(thread.agentId);
  ag.cwd = wt;
  ag.status = 'idle';
  await a.sync();
  return a.openDecisions(task.id, 'result')[0];
}

test('accepting checks the work and merges it into the base branch', async () => {
  const r = repo();
  const l = new Ledger(':memory:');
  const paseo = fakePaseo();
  const a = new Autodos(l, { paseo, git: createGit(), check: runCheck });
  a.createProject({ name: 'Demo', path: r.dir, check: 'test -f hello.sh' });
  const t = await a.createTask({ title: 'Add hello', project: 'Demo' });
  assert.equal(l.get('task', t.id).base, 'main');
  assert.equal(paseo.calls[0][1].base, 'main');

  // The first try forgets the file the check looks for: the check sends it back.
  let wt = agentCommits(r, 'autodos/1', 'other.txt', 'x\n');
  let d = await finished(a, l, paseo, t, wt);
  assert.match(d.question, /merge autodos\/1 into main/);
  await a.decide(d.id, 'Accept');
  assert.equal(l.get('task', t.id).state, 'working');
  assert.match(paseo.calls.at(-1)[1].text, /The check `test -f hello.sh` failed/);
  assert.equal(l.timeline(t.id).filter((e) => e.type === 'task.check')[0].data.ok, false);

  // Fixed: it merges into main, which is checked out and clean.
  agentCommits(r, 'autodos/1', 'hello.sh', 'echo hello\n');
  d = await finished(a, l, paseo, t, wt);
  const done = await a.decide(d.id, 'Accept');
  assert.equal(done.state, 'done');
  assert.ok(fs.existsSync(path.join(r.dir, 'hello.sh')));
  assert.equal(r.g('rev-parse', 'HEAD'), done.commit);
  assert.match(r.g('log', '-1', '--format=%s'), /Merge #1: Add hello/);
  assert.equal(paseo.calls.at(-1)[0], 'stop');
  assert.equal(l.list('output', { where: (o) => o.taskId === t.id })[0].title, 'autodos/1 → main');
});

test('a dirty base or a conflict stops the merge and says why', async () => {
  const r = repo();
  const l = new Ledger(':memory:');
  const paseo = fakePaseo();
  const a = new Autodos(l, { paseo, git: createGit(), check: runCheck });
  a.createProject({ name: 'Demo', path: r.dir });

  const t = await a.createTask({ title: 'Edit readme', project: 'Demo' });
  const wt = agentCommits(r, 'autodos/1', 'README.md', 'from the agent\n');
  fs.writeFileSync(path.join(r.dir, 'README.md'), 'my own edit\n'); // the person is editing main
  let d = await finished(a, l, paseo, t, wt);
  let after = await a.decide(d.id, 'Accept');
  assert.equal(after.state, 'stuck');
  assert.match(after.stuck, /uncommitted changes[\s\S]*Commit or stash/);
  assert.equal(fs.readFileSync(path.join(r.dir, 'README.md'), 'utf8'), 'my own edit\n', 'the person\'s work is untouched');

  // The person commits their edit, which now conflicts with the agent's; retrying hands the conflict to the agent.
  r.g('commit', '-qam', 'mine');
  after = await a.retry(t.id);
  assert.equal(after.state, 'working');
  assert.match(paseo.calls.at(-1)[1].text, /conflicts[\s\S]*Merge main into your branch/);
  assert.equal(r.g('status', '--porcelain'), '', 'the failed merge was aborted');
  assert.equal(r.g('log', '-1', '--format=%s'), 'mine');
});

test('when the base is not checked out, the merge happens without touching a working tree', async () => {
  const r = repo();
  r.g('checkout', '-q', '-b', 'side');
  const git = createGit();
  agentCommits(r, 'autodos/9', 'a.txt', 'a\n');
  const m = await git.merge({ repo: r.dir, branch: 'autodos/9', base: 'main', message: 'Merge #9' });
  assert.equal(m.ok, true);
  assert.equal(m.how, 'merged without a checkout');
  assert.equal(r.g('rev-parse', 'main'), m.commit);
  assert.equal(r.g('rev-parse', '--abbrev-ref', 'HEAD'), 'side');
  assert.equal(r.g('show', 'main:a.txt'), 'a');
  const again = await git.merge({ repo: r.dir, branch: 'autodos/9', base: 'main' });
  assert.equal(again.reason, 'missing');
});

test('a task stops at its budget and asks before spending more', async () => {
  const { l, paseo, a } = setup();
  a.updateProject('Demo', { budgetUsd: 1 });
  const t = await a.createTask({ title: 'Big refactor', project: 'Demo' });
  const first = l.get('task', t.id).threadId;
  paseo.agents.get(l.get('thread', first).agentId).usage = { CostUsd: 1.2 };
  await a.sync();
  const task = l.get('task', t.id);
  assert.equal(task.state, 'waiting_you');
  assert.equal(task.waitingKind, 'budget');
  assert.match(task.waitingFor, /Spent \$1\.20 of \$1\.00/);
  assert.equal(paseo.calls.at(-1)[0], 'stop');
  assert.equal(l.get('thread', first).active, false);

  const d = a.openDecisions(t.id, 'budget')[0];
  const more = await a.decide(d.id, 'Add budget');
  assert.equal(more.state, 'working');
  assert.equal(more.budgetUsd, 6.2);
  assert.notEqual(more.threadId, first);
  assert.match(paseo.calls.at(-1)[1].prompt, /stopped at its budget/);
  assert.deepEqual(a.budget(more), { limit: 6.2, spent: 1.2 });
});

// ---- the team ----
import { Team, detectAgents } from '../lib/team.js';

test('staff and machines: who runs a task, where, and with what instructions', async () => {
  const l = new Ledger(':memory:');
  const local = fakePaseo();
  const remote = fakePaseo();
  const hosts = [];
  const a = new Autodos(l, { paseo: local, paseoFor: (host) => (hosts.push(host), remote) });
  const team = new Team(l);
  const p = a.createProject({ name: 'Demo', path: '/repos/demo' });
  const fe = team.createStaff({ name: '前端工程师', role: 'UI and pages', runtime: 'codex', instructions: 'Use the design tokens.' });
  assert.throws(() => team.createStaff({ name: '前端工程师' }), /already exists/);
  assert.throws(() => team.createStaff({ name: 'x', runtime: 'gpt' }), /Runtime/);

  const t = await a.createTask({ title: 'Footer', project: 'Demo', staff: '前端工程师' });
  const [, run] = local.calls[0];
  assert.equal(run.provider, 'codex');
  assert.match(run.prompt, /^You are 前端工程师, UI and pages\.\nUse the design tokens\./);
  assert.equal(l.get('thread', t.threadId).staffId, fe.id);

  // A second machine, reached through its own Paseo daemon.
  assert.throws(() => team.createMachine({ name: 'studio' }), /Paseo daemon/);
  const studio = team.createMachine({ name: 'studio', paseoHost: '192.168.1.20:6767', capacity: 3 });
  const be = team.createStaff({ name: '后端工程师', runtime: 'claude', machine: 'studio' });
  await assert.rejects(a.createTask({ title: 'API', project: 'Demo', staff: be.id }), /no checkout on studio/);
  a.updateProject('Demo', {});
  l.update('project', p.id, { paths: { [studio.id]: '/Users/x/demo' } });
  const t2 = await a.createTask({ title: 'API 2', project: 'Demo', staff: be.id });
  assert.deepEqual(hosts, ['192.168.1.20:6767']);
  assert.equal(remote.calls[0][1].cwd, '/Users/x/demo');
  assert.equal(l.get('task', t2.id).machine, studio.id);
  await a.reply(t2.id, 'hello');
  assert.deepEqual(remote.calls.at(-1), ['send', { agentId: l.get('thread', l.get('task', t2.id).threadId).agentId, text: 'hello' }]);

  const r = team.roster();
  const feRow = r.staff.find((s) => s.id === fe.id);
  assert.equal(feRow.counts.working, 1);
  assert.equal(feRow.machineName, l.get('machine', 'local').name);
  const studioRow = r.machines.find((m) => m.id === studio.id);
  assert.equal(studioRow.running, 1);
  assert.deepEqual(studioRow.staff.map((s) => s.name), ['后端工程师']);

  assert.throws(() => team.removeStaff(fe.id), /still has 1 open task/);
  assert.throws(() => team.removeMachine(studio.id), /still runs 1 agent/);
  assert.throws(() => team.removeMachine('local'), /cannot be removed/);
  await a.drop(t.id);
  team.removeStaff(fe.id);
  assert.equal(l.get('staff', fe.id), null);
  team.updateMachine(studio.id, { capacity: 4, name: 'studio-2' });
  assert.equal(l.get('machine', studio.id).name, 'studio-2');
});

test('finding agents looks only at commands and folders', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'autodos-home-'));
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'autodos-bin-'));
  fs.mkdirSync(path.join(home, '.codex'));
  fs.writeFileSync(path.join(bin, 'claude'), '#!/bin/sh\n');
  const found = Object.fromEntries(detectAgents({ home, env: { PATH: bin } }).map((x) => [x.kind, x]));
  assert.equal(found.claude.installed, true);
  assert.equal(found.claude.used, false);
  assert.equal(found.codex.installed, false);
  assert.equal(found.codex.used, true);
  assert.equal(found.hermes.installed, false);
});
