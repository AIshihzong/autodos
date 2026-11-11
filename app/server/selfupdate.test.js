// Autodos updating itself: what counts as an update, when it switches, and how it is taken out again.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { findUpdate, install, settle, rollback, discard, SelfUpdate } from './selfupdate.js';
import { KeepAwake } from './awake.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'autodos-update-test-'));
const sh = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { cwd, encoding: 'utf8' }).trim();
const write = (dir, files) => {
  for (const [f, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
    fs.writeFileSync(path.join(dir, f), text);
  }
};
const commit = (dir, files, msg) => (write(dir, files), sh(dir, 'add', '-A'), sh(dir, 'commit', '-qm', msg), sh(dir, 'rev-parse', 'HEAD'));

/** An origin, a checkout that "runs", and a second checkout that pushes new versions. */
function world(name) {
  const origin = path.join(tmp, `${name}-origin.git`);
  const dev = path.join(tmp, `${name}-dev`);
  const live = path.join(tmp, `${name}-live`);
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin]);
  execFileSync('git', ['clone', '-q', origin, dev], { stdio: 'ignore' });
  sh(dev, 'checkout', '-q', '-B', 'main');
  const v1 = commit(dev, { 'app/server/index.js': '// v1\n', 'app/package-lock.json': '{}\n', '.gitignore': 'app/dist/\napp/dist.old/\n' }, 'v1');
  sh(dev, 'push', '-q', '-u', 'origin', 'main');
  execFileSync('git', ['clone', '-q', origin, live], { stdio: 'ignore' });
  const publish = (files, msg) => {
    const sha = commit(dev, files, msg);
    sh(dev, 'push', '-q', 'origin', 'main');
    return sha;
  };
  return { origin, dev, live, v1, publish };
}
const fakeStore = () => ({ dir: tmp, data: { settings: { selfUpdate: true }, todos: [] }, changed() {}, flush() {} });

test('self-update: only a plain fast-forward of a clean checkout counts as an update', async () => {
  const w = world('find');
  assert.deepEqual(await findUpdate(w.live), { current: w.v1, branch: 'main' });
  const v2 = w.publish({ 'app/server/index.js': '// v2\n' }, 'v2');
  assert.deepEqual(await findUpdate(w.live), { current: w.v1, branch: 'main', to: v2, count: 1, lock: false });
  const v3 = w.publish({ 'app/package-lock.json': '{"v":3}\n' }, 'v3');
  assert.deepEqual(await findUpdate(w.live), { current: w.v1, branch: 'main', to: v3, count: 2, lock: true });
  // Untracked files are not in the way; a changed tracked file is.
  write(w.live, { 'notes.txt': 'mine\n' });
  assert.equal((await findUpdate(w.live)).to, v3);
  write(w.live, { 'app/server/index.js': '// edited here\n' });
  assert.match((await findUpdate(w.live)).skip, /local changes/);
  sh(w.live, 'checkout', '-q', '--', 'app/server/index.js');
  const mine = commit(w.live, { 'local.txt': 'x\n' }, 'local work');
  assert.deepEqual(await findUpdate(w.live), { current: mine, branch: 'main', skip: 'this checkout has commits its remote does not have' });
  sh(w.live, 'checkout', '-q', '--detach', w.v1);
  assert.match((await findUpdate(w.live)).skip, /not on a branch/);
});

test('self-update: built files go in with the commit, and both come out again when the new version does not come up', async () => {
  const w = world('swap');
  write(w.live, { 'app/dist/index.html': 'old page\n' });
  const v2 = w.publish({ 'app/server/index.js': '// v2\n' }, 'v2');
  const u = await findUpdate(w.live);
  // What prepare() leaves behind: a worktree at the new commit with its built files.
  const dir = fs.mkdtempSync(path.join(tmp, 'prepared-'));
  sh(w.live, 'worktree', 'add', '--detach', '--quiet', path.join(dir, 'src'), v2);
  write(path.join(dir, 'src'), { 'app/dist/index.html': 'new page\n' });
  const swaps = await install(w.live, u, dir);
  assert.deepEqual(swaps, ['dist']);
  assert.equal(sh(w.live, 'rev-parse', 'HEAD'), v2);
  assert.equal(fs.readFileSync(path.join(w.live, 'app/dist/index.html'), 'utf8'), 'new page\n');
  assert.equal(fs.readFileSync(path.join(w.live, 'app/dist.old/index.html'), 'utf8'), 'old page\n');
  await discard(w.live, dir);
  assert.ok(!fs.existsSync(dir));
  await rollback(w.live, w.v1, swaps);
  assert.equal(sh(w.live, 'rev-parse', 'HEAD'), w.v1);
  assert.equal(sh(w.live, 'rev-parse', '--abbrev-ref', 'HEAD'), 'main');
  assert.equal(fs.readFileSync(path.join(w.live, 'app/dist/index.html'), 'utf8'), 'old page\n');
  assert.ok(!fs.existsSync(path.join(w.live, 'app/dist.old')));
  assert.equal(sh(w.live, 'status', '--porcelain', '--untracked-files=no'), '');
  // And when it does come up, the previous files go.
  const dir2 = fs.mkdtempSync(path.join(tmp, 'prepared-'));
  sh(w.live, 'worktree', 'add', '--detach', '--quiet', path.join(dir2, 'src'), v2);
  write(path.join(dir2, 'src'), { 'app/dist/index.html': 'new page\n' });
  settle(w.live, await install(w.live, await findUpdate(w.live), dir2));
  assert.ok(!fs.existsSync(path.join(w.live, 'app/dist.old')));
  // A checkout that moved while the update was being prepared is left alone.
  await assert.rejects(install(w.live, u, dir2), /moved while the update was being prepared/);
});

test('self-update: waits for a quiet moment without starting new work, gives up on a commit that keeps failing', async () => {
  const w = world('tick');
  const store = fakeStore();
  let busy = true;
  const holds = [];
  const restarts = [];
  let prepared = 0;
  let broken = false;
  const up = new SelfUpdate({
    store,
    repo: w.live,
    idle: () => !busy,
    hold: (on) => holds.push(on),
    restart: (job) => restarts.push(job),
    steps: {
      prepare: async () => {
        prepared += 1;
        if (broken) throw new Error('does not build');
        return fs.mkdtempSync(path.join(tmp, 'fake-'));
      },
      install: async () => ['dist'],
      discard: async (repo, dir) => fs.rmSync(dir, { recursive: true, force: true }),
    },
  });
  try {
    // Nothing new: nothing happens.
    assert.equal((await up.tick()).available, '');
    assert.deepEqual([prepared, holds.length], [0, 0]);
    const v2 = w.publish({ 'app/server/index.js': '// v2\n' }, 'v2');
    // Work is under way: the update is built once, new work is held back, nothing restarts.
    let s = await up.tick();
    assert.deepEqual([s.available, s.waiting, prepared, restarts.length], [v2, true, 1, 0]);
    assert.equal(holds.at(-1), true);
    await up.tick();
    assert.equal(prepared, 1, 'the same commit is not built twice');
    // Quiet: it goes in and the process is handed over.
    busy = false;
    s = await up.tick({ fetch: false });
    assert.deepEqual(restarts, [{ from: w.v1, to: v2, swaps: ['dist'] }]);
    assert.deepEqual([s.waiting, s.current, s.error], [false, v2, '']);

    // A commit that does not build is tried three times, then left alone, and the team works on.
    sh(w.live, 'merge', '-q', '--ff-only', 'origin/main');
    broken = true;
    const v3 = w.publish({ 'app/server/index.js': '// v3\n' }, 'v3');
    for (let i = 0; i < 5; i++) s = await up.tick();
    assert.equal(prepared, 4);
    assert.match(s.error, /does not build/);
    assert.equal(store.data.selfUpdate.failed.sha, v3);
    assert.equal(up.ready, null);
    assert.equal(restarts.length, 1);
    // A newer commit gets a fresh start.
    broken = false;
    const v4 = w.publish({ 'app/server/index.js': '// v4\n' }, 'v4');
    await up.tick();
    assert.equal(restarts.at(-1).to, v4);

    // Switched off: a waiting update is dropped and work resumes.
    sh(w.live, 'merge', '-q', '--ff-only', 'origin/main');
    w.publish({ 'app/server/index.js': '// v5\n' }, 'v5');
    busy = true;
    await up.tick();
    assert.ok(up.ready);
    store.data.settings.selfUpdate = false;
    s = await up.tick();
    assert.deepEqual([s.enabled, s.waiting, holds.at(-1)], [false, false, false]);
  } finally {
    up.close();
  }
});

test('keep awake: a Mac with work stays awake, and is let go when the work is done or the setting is off', () => {
  const store = { data: { settings: {}, todos: [{ phase: 'review' }] } };
  const started = [];
  const start = () => {
    const c = { killed: false, kill() { this.killed = true; }, once() {} };
    started.push(c);
    return c;
  };
  const a = new KeepAwake(store, { platform: 'darwin', start, every: 1e9 });
  try {
    assert.equal(a.check(), false, 'waiting for the person is not work');
    store.data.todos.push({ phase: 'queued', capacity: { until: '2099-01-01T00:00:00Z' } });
    assert.equal(a.check(), true, 'waiting for a usage limit to lift is');
    assert.equal(a.check(), true);
    assert.equal(started.length, 1, 'one assertion at a time');
    store.data.todos[1].phase = 'review';
    store.data.todos[1].leadPending = { at: 'x' };
    assert.equal(a.check(), true, 'the lead looking at it is');
    delete store.data.todos[1].leadPending;
    assert.equal(a.check(), false);
    assert.ok(started[0].killed);
    store.data.todos[1].phase = 'building';
    store.data.settings.keepAwake = false;
    assert.equal(a.check(), false, 'switched off');
    store.data.settings.keepAwake = true;
    assert.equal(a.check(), true);
  } finally {
    a.close();
  }
  assert.ok(started.at(-1).killed);
  const linux = new KeepAwake(store, { platform: 'linux', start, every: 1e9 });
  assert.equal(linux.check(), false, 'only on macOS');
  linux.close();
});
