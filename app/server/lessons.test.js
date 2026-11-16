// Lessons (the nightly look back), the red check and the merge record: `npm test`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { applyReview, dayFacts, lessonsBlock, parseReview, parseRevoke, Lessons, archiveStale, dayOf, PROMOTE_AFTER } from './lessons.js';
import { redCheck, redCheckText, isTestFile, mergeMessage, reviewPrompt } from './quality.js';
import { startServer } from './index.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'autodos-lessons-'));

const data = () => ({ projects: [{ id: 'p1', name: 'Shop' }], todos: [], runs: [], lessons: [] });
const at = (day, hh = '10') => new Date(`${day}T${hh}:00:00`).toISOString();

test('a lesson counts each day once and becomes a rule on its third day', () => {
  const d = data();
  const r1 = applyReview(d, 'p1', '2026-11-01', { seen: [], new: [{ rule: 'A fix covers every sibling of the bug', why: 'one was missed', evidence: '#12', scope: 'project' }] });
  assert.equal(r1.added.length, 1);
  const l = d.lessons[0];
  assert.equal(l.ref, 'L1');
  assert.equal(l.status, 'watching');
  // Seen again the same day: still one day.
  applyReview(d, 'p1', '2026-11-01', { seen: [{ ref: 'L1', evidence: '#13' }], new: [] });
  assert.deepEqual(l.seen, ['2026-11-01']);
  // Written again in the same words on another day: the same lesson, not a new one.
  applyReview(d, 'p1', '2026-11-02', { seen: [], new: [{ rule: 'A fix covers every sibling of the bug', why: '', evidence: '#20', scope: 'project' }] });
  assert.equal(d.lessons.length, 1);
  assert.equal(l.seen.length, 2);
  assert.equal(l.status, 'watching');
  const r3 = applyReview(d, 'p1', '2026-11-04', { seen: [{ ref: 'l1', evidence: '#31' }], new: [] });
  assert.equal(PROMOTE_AFTER, 3);
  assert.equal(l.status, 'rule');
  assert.equal(r3.promoted[0], l);
  assert.equal(l.evidence.length, 4);
});

test('a "seen" for a lesson of another project, or a revoked one, changes nothing', () => {
  const d = data();
  d.lessons.push({ id: 'x', ref: 'L7', projectId: 'p2', rule: 'r', seen: ['2026-11-01'], status: 'watching', evidence: [] });
  d.lessons.push({ id: 'y', ref: 'L8', projectId: 'p1', rule: 'q', seen: ['2026-11-01'], status: 'revoked', evidence: [] });
  const r = applyReview(d, 'p1', '2026-11-02', parseReview('{"seen":[{"ref":"L7"},{"ref":"L8"}],"new":[]}'));
  assert.equal(r.seen.length, 0);
});

test('team lessons apply to every project; prompts get rules and recent lessons, the reviewer only rules', () => {
  const d = data();
  applyReview(d, 'p1', '2026-11-01', { seen: [], new: [{ rule: 'Run every check, not the ones you think you touched', why: 'guard tests live elsewhere', evidence: '#1', scope: 'team' }, { rule: 'Keep prices in cents', why: '', evidence: '#2', scope: 'project' }] });
  assert.equal(d.lessons[0].projectId, null);
  const other = lessonsBlock(d, 'p9');
  assert.match(other, /Run every check/);
  assert.doesNotMatch(other, /cents/);
  assert.equal(lessonsBlock(d, 'p1', { forReview: true }), '', 'no rules yet, nothing for the reviewer');
  d.lessons[1].status = 'rule';
  const build = lessonsBlock(d, 'p1');
  assert.match(build, /team's rules[\s\S]*L2: Keep prices in cents/);
  assert.match(build, /Recent lessons[\s\S]*L1/);
  const review = lessonsBlock(d, 'p1', { forReview: true });
  assert.match(review, /L2: Keep prices in cents/);
  assert.doesNotMatch(review, /L1/);
  const prompt = reviewPrompt({ number: 5, title: 'x' }, 'diff', review);
  assert.match(prompt, /a change that breaks one is a finding/);
});

test('a day with nothing worth learning from costs no model call; a busy day does', async () => {
  const d = data();
  d.settings = {};
  const day = '2026-11-03';
  d.todos.push({ id: 't1', number: 41, projectId: 'p1', title: 'Calm', phase: 'done', messages: [{ role: 'system', text: 'Checks passed', at: at(day) }] });
  const store = { data: d, changed() {} };
  const prompts = [];
  const said = [];
  const lessons = new Lessons(store, { say: (x) => said.push(x), think: async (p) => (prompts.push(p), '{"seen":[],"new":[{"rule":"Reproduce the reported case first","why":"#42 came back twice","evidence":"#42"}]}') });
  clearInterval(lessons.timer);
  const quiet = await lessons.review(d.projects[0], day);
  assert.equal(quiet.quiet, true);
  assert.equal(prompts.length, 0);
  d.todos.push({ id: 't2', number: 42, projectId: 'p1', title: 'Fix login', phase: 'review', messages: [{ role: 'system', text: 'Checks fail on top of the latest main: npm test', error: true, at: at(day) }, { role: 'user', text: 'Still broken on Safari', at: at(day, '11') }] });
  d.runs.push({ todoId: 't2', kind: 'build', startedAt: at(day) }, { todoId: 't2', kind: 'build', startedAt: at(day, '12') });
  const facts = dayFacts(d, 'p1', day);
  assert.equal(facts.length, 1);
  assert.equal(facts[0].todo, 42);
  assert.equal(facts[0].buildRounds, 2);
  assert.deepEqual(facts[0].personSaid, ['Still broken on Safari']);
  const res = await lessons.review(d.projects[0], day);
  assert.equal(prompts.length, 1);
  assert.match(prompts[0], /Still broken on Safari/);
  assert.equal(res.added.length, 1);
  assert.match(said[0], /L1 Reproduce the reported case first/);
  assert.match(said[0], /revoke L1/);
  assert.equal(d.lessonState.p1.lastDay, day);
});

test('the nightly tick reviews yesterday once, after the hour', async () => {
  const d = data();
  d.settings = { lessonsHour: 3 };
  let calls = 0;
  const lessons = new Lessons({ data: d, changed() {} }, { think: async () => (calls++, '{}') });
  clearInterval(lessons.timer);
  const morning = new Date(2026, 10, 5, 2, 0).getTime();
  assert.deepEqual(await lessons.tick(morning), []);
  const later = new Date(2026, 10, 5, 4, 0).getTime();
  const done = await lessons.tick(later);
  assert.equal(done.length, 1);
  assert.equal(done[0].day, '2026-11-04');
  assert.equal((await lessons.tick(later + 3600e3)).length, 0, 'not twice for the same day');
  d.settings.lessons = false;
  assert.deepEqual(await lessons.tick(new Date(2026, 10, 6, 4, 0).getTime()), []);
  assert.equal(calls, 0, 'quiet days only');
});

test('a lesson that stopped coming up is put away after a month; rules stay', () => {
  const d = data();
  d.lessons.push({ ref: 'L1', status: 'watching', seen: ['2026-09-01'] }, { ref: 'L2', status: 'rule', seen: ['2026-09-01', '2026-09-02', '2026-09-03'] }, { ref: 'L3', status: 'watching', seen: ['2026-11-01'] });
  const put = archiveStale(d, '2026-11-05');
  assert.deepEqual(put.map((l) => l.ref), ['L1']);
  assert.equal(d.lessons[1].status, 'rule');
});

test('revoke commands', () => {
  assert.equal(parseRevoke('撤销 L3'), 'L3');
  assert.equal(parseRevoke('撤销规则 l12'), 'L12');
  assert.equal(parseRevoke('revoke lesson L4'), 'L4');
  assert.equal(parseRevoke('撤销这个功能'), '');
  assert.equal(dayOf(new Date(2026, 0, 2, 23, 59).getTime()), '2026-01-02');
});

// ---------- red check ----------

const repoWith = (name) => {
  const repo = path.join(tmp, name);
  fs.mkdirSync(path.join(repo, 'test'), { recursive: true });
  const g = (...a) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd: repo }).toString().trim();
  g('init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(repo, 'add.js'), 'export const add = (a, b) => a - b;\n');
  fs.writeFileSync(path.join(repo, 'test', 'old.test.js'), "import assert from 'node:assert';\nassert.equal(1, 1);\n");
  g('add', '.');
  g('commit', '-qm', 'init');
  g('checkout', '-qb', 'todo');
  return { repo, g };
};
const CHECK = ['for f in test/*.test.js; do node "$f" || exit 1; done'];

test('red check: a test that fails on the old code is red, and the worktree comes back exactly', async () => {
  const { repo, g } = repoWith('red');
  fs.writeFileSync(path.join(repo, 'add.js'), 'export const add = (a, b) => a + b;\n');
  fs.writeFileSync(path.join(repo, 'helper.js'), 'export const two = 2;\n'); // a file the change adds
  fs.writeFileSync(path.join(repo, 'test', 'add.test.js'), "import assert from 'node:assert';\nimport { add } from '../add.js';\nassert.equal(add(1, 2), 3);\n");
  g('add', '.');
  g('commit', '-qm', 'fix add');
  const rc = await redCheck(repo, 'refs/heads/main', CHECK);
  assert.equal(rc.state, 'red');
  assert.deepEqual(rc.tests, ['test/add.test.js']);
  assert.match(redCheckText(rc), /do test this change/);
  assert.equal(g('status', '--porcelain'), '');
  assert.match(fs.readFileSync(path.join(repo, 'add.js'), 'utf8'), /a \+ b/);
  assert.ok(fs.existsSync(path.join(repo, 'helper.js')));
});

test('red check: a test that passes on the old code too is green', async () => {
  const { repo, g } = repoWith('green');
  fs.writeFileSync(path.join(repo, 'add.js'), 'export const add = (a, b) => a + b;\n');
  fs.writeFileSync(path.join(repo, 'test', 'add.test.js'), "import assert from 'node:assert';\nimport { add } from '../add.js';\nassert.equal(add(2, 0), 2);\n");
  g('add', '.');
  g('commit', '-qm', 'fix add, weak test');
  const rc = await redCheck(repo, 'refs/heads/main', CHECK);
  assert.equal(rc.state, 'green');
  assert.match(redCheckText(rc), /do not show/);
  assert.equal(g('status', '--porcelain'), '');
});

test('red check: no test, only tests, or uncommitted work is not run', async () => {
  const { repo, g } = repoWith('none');
  fs.writeFileSync(path.join(repo, 'add.js'), 'export const add = (a, b) => a + b;\n');
  g('commit', '-qam', 'no test');
  assert.equal((await redCheck(repo, 'refs/heads/main', CHECK)).state, 'no-tests');
  assert.equal((await redCheck(repo, 'refs/heads/main', [])).state, 'not-run');
  fs.writeFileSync(path.join(repo, 'add.js'), 'dirty\n');
  assert.match((await redCheck(repo, 'refs/heads/main', CHECK)).reason, /uncommitted/);
  assert.ok(isTestFile('src/__tests__/a.tsx') && isTestFile('svc/user_test.go') && !isTestFile('src/testing.js'));
});

test('merge record says what ran, who accepted it, and what was not run', () => {
  const t = {
    number: 7,
    title: 'Fix add',
    description: 'Adding two numbers gives the wrong answer',
    acceptedBy: 'autopilot',
    checks: { passed: true, results: [{ ok: true, command: 'npm test' }] },
    redCheck: { state: 'red', base: 'abc123', tests: ['test/add.test.js'], failed: [{ command: 'npm test' }] },
    review: null,
    messages: [],
  };
  const msg = mergeMessage(t, { base: 'main', baseSha: '0123456789abcdef', commands: ['npm test'] });
  assert.match(msg, /^Merge #7: Fix add\n\n/);
  assert.match(msg, /Asked: Adding two numbers/);
  assert.match(msg, /Accepted by: autopilot/);
  assert.match(msg, /Checks on main at 0123456789 merged in: passed `npm test`/);
  assert.match(msg, /Red check: .* fail/);
  assert.match(msg, /Not run: independent review/);
  const none = mergeMessage({ number: 8, title: 'x', messages: [] }, { commands: [] });
  assert.match(none, /Accepted by: the person/);
  assert.match(none, /Not run: project checks \(the project has none\); red check/);
});

// ---------- end to end ----------

test('the lead lists lessons, the owner revokes one, and Done writes the record into the merge', async () => {
  const srv = await startServer({ port: 0, dataDir: path.join(tmp, 'data') });
  const base = `http://127.0.0.1:${srv.port}`;
  const call = async (method, p, body) => {
    const res = await fetch(base + '/api' + p, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, body: await res.json() };
  };
  const waitFor = async (fn, ms = 30000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      const v = await fn();
      if (v) return v;
      await new Promise((r) => setTimeout(r, 150));
    }
    throw new Error('timed out');
  };
  try {
    clearInterval(srv.lessons.timer);
    await call('PATCH', '/settings', { defaultRuntime: 'demo', chiefRuntime: 'demo' });
    const { repo, g } = repoWith('e2e');
    g('checkout', '-q', 'main');
    const { body: p } = await call('POST', '/projects', { path: repo });
    await call('PATCH', `/projects/${p.id}`, { checks: CHECK });
    applyReview(srv.store.data, p.id, '2026-11-01', { seen: [], new: [{ rule: 'Reproduce the reported case first', why: 'w', evidence: '#1', scope: 'project' }] });
    const listed = (await call('POST', '/chief', { text: '教训', projectId: p.id })).body;
    const said = () => srv.store.data.chief.filter((m) => m.role === 'chief').map((m) => m.text).join('\n');
    await waitFor(() => /L1 Reproduce the reported case first/.test(said()));
    assert.ok(listed);
    await call('POST', '/chief', { text: '撤销 L1', projectId: p.id });
    await waitFor(() => srv.store.data.lessons[0].status === 'revoked');
    assert.equal(lessonsBlock(srv.store.data, p.id), '');
    // The API lists them, and a review can be run by hand (the demo lead learns nothing).
    assert.equal((await call('GET', '/lessons')).body.length, 1);
    assert.equal((await call('POST', '/lessons/review', { projectId: p.id, day: '2026-11-02' })).body.quiet, true);

    const { body: t } = await call('POST', '/todos', { title: 'Record todo', projectId: p.id, start: true });
    const wt = await waitFor(async () => (await call('GET', `/todos/${t.number}`)).body.worktree);
    fs.writeFileSync(path.join(wt, 'b.txt'), 'b'); // stand-in for the agent's edit
    await waitFor(async () => (await call('GET', `/todos/${t.number}`)).body.phase === 'review');
    const at = (await call('GET', `/todos/${t.number}`)).body;
    assert.ok(at.redCheck, 'the red check ran');
    assert.equal((await call('POST', `/todos/${t.number}/action`, { action: 'done' })).status, 200);
    await waitFor(async () => (await call('GET', `/todos/${t.number}`)).body.phase === 'done');
    const msg = g('log', '-1', '--format=%B', 'main');
    assert.match(msg, new RegExp(`^Merge #${t.number}: Record todo`));
    assert.match(msg, /Accepted by: the person/);
    assert.match(msg, /Checks on main at [0-9a-f]{10} merged in: passed/);
  } finally {
    srv.store.flush();
    srv.server.close();
    srv.server.closeAllConnections?.();
  }
});
