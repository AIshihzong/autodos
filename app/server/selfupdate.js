// Autodos keeps itself up to date when it runs from a git checkout and the person turned this on
// (Settings, or AUTODOS_SELF_UPDATE=1). Nobody has to reach the machine to ship a fix to the team that works on it.
//
// It only ever fast-forwards the branch it is on to what that branch's remote has. The new version is first
// built and started on the side (its own worktree, its own empty data folder, its own port); the running one
// is replaced only after that copy answered, and only while no turn, merge or decision is under way: once an
// update is ready no new turn starts, the ones under way finish, then it switches. A small separate process
// (handover.js) does the switch-over: it starts the new version, and when that does not come up it puts the
// previous commit and its built files back and starts that instead. An update that failed is tried three
// times at most, then left until there is a newer one.
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { now } from './store.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const NPM = process.platform === 'win32' ? 'npm.cmd' : 'npm';

const run = (cmd, args, { cwd, timeout = 120_000, env } = {}) =>
  new Promise((resolve, reject) => {
    execFile(cmd, args, { cwd, timeout, env: env || process.env, maxBuffer: 16 << 20, windowsHide: true }, (err, stdout, stderr) => {
      if (err) reject(new Error(`${cmd} ${args.slice(0, 3).join(' ')}: ${String(stderr || err.message).trim().split('\n').slice(-6).join(' | ').slice(0, 600)}`));
      else resolve(String(stdout).trim());
    });
  });
const git = (cwd, ...args) => run('git', args, { cwd });

const freePort = () =>
  new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });

/**
 * Where this checkout stands against its remote. Returns { current } when there is nothing to do,
 * { current, skip } when an update would not be a plain fast-forward of a clean tree, or
 * { current, to, branch, count, lock } for an update that can be taken.
 */
export async function findUpdate(repo, { fetch = true } = {}) {
  const current = await git(repo, 'rev-parse', 'HEAD');
  const branch = await git(repo, 'rev-parse', '--abbrev-ref', 'HEAD');
  if (branch === 'HEAD') return { current, skip: 'not on a branch' };
  const remote = await git(repo, 'config', '--get', `branch.${branch}.remote`).catch(() => '');
  if (!remote || remote === '.') return { current, branch, skip: 'the branch follows no remote' };
  const theirs = (await git(repo, 'config', '--get', `branch.${branch}.merge`).catch(() => '')).replace(/^refs\/heads\//, '') || branch;
  if (fetch) await run('git', ['fetch', '--quiet', remote, theirs], { cwd: repo, timeout: 180_000 });
  const to = await git(repo, 'rev-parse', fetch ? 'FETCH_HEAD' : `${remote}/${theirs}`);
  if (to === current) return { current, branch };
  const ahead = await git(repo, 'merge-base', '--is-ancestor', current, to).then(() => false, () => true);
  if (ahead) return { current, branch, skip: 'this checkout has commits its remote does not have' };
  if (await git(repo, 'status', '--porcelain', '--untracked-files=no')) return { current, branch, skip: 'this checkout has local changes' };
  const files = (await git(repo, 'diff', '--name-only', current, to)).split('\n').filter(Boolean);
  const count = Number(await git(repo, 'rev-list', '--count', `${current}..${to}`)) || 0;
  return { current, branch, to, count, lock: files.includes('app/package-lock.json') || files.includes('app/package.json') };
}

/**
 * Build the version at `to` beside the running one and start it once on its own port with empty data.
 * Returns the folder that holds it (its app is in <dir>/src/app). Throws when it does not build or answer.
 */
export async function prepare(repo, to, { workDir, lock = false, log = () => {} } = {}) {
  const dir = fs.mkdtempSync(path.join(workDir || os.tmpdir(), 'autodos-update-'));
  const src = path.join(dir, 'src');
  try {
    await git(repo, 'worktree', 'add', '--detach', '--quiet', src, to);
    const app = path.join(src, 'app');
    const live = path.join(repo, 'app', 'node_modules');
    if (lock || !fs.existsSync(live)) {
      log('installing dependencies');
      await run(NPM, ['ci', '--no-audit', '--no-fund'], { cwd: app, timeout: 900_000 });
    } else fs.symlinkSync(live, path.join(app, 'node_modules'), 'junction');
    log('building');
    await run(NPM, ['run', 'build'], { cwd: app, timeout: 900_000 });
    log('starting it once');
    await smoke(app, path.join(dir, 'data'));
    return dir;
  } catch (e) {
    await discard(repo, dir);
    throw e;
  }
}

/** Start the server in `app` with an empty data folder and wait until it serves its page and its state. */
export async function smoke(app, dataDir, { timeout = 45_000 } = {}) {
  const port = await freePort();
  fs.mkdirSync(dataDir, { recursive: true });
  const env = { ...process.env, PORT: String(port), AUTODOS_DATA: dataDir, AUTODOS_SELF_UPDATE: '0' };
  delete env.AUTODOS_PARENT_PID;
  delete env.CREWBOARD_DATA;
  const child = spawn(process.execPath, ['server/index.js'], { cwd: app, env, stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
  let err = '';
  child.stderr.on('data', (b) => (err = (err + b).slice(-2000)));
  const gone = new Promise((resolve) => child.once('exit', (code) => resolve(code ?? 1)));
  try {
    const until = Date.now() + timeout;
    for (;;) {
      const ok = await Promise.race([
        (async () => {
          const state = await fetch(`http://127.0.0.1:${port}/api/state`, { signal: AbortSignal.timeout(3000) });
          const page = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(3000) });
          return state.ok && page.ok && /<div id="root"/.test(await page.text());
        })().catch(() => false),
        gone.then((code) => {
          throw new Error(`the new version stopped right after starting (exit ${code}): ${err.trim().split('\n').slice(-3).join(' | ').slice(0, 400)}`);
        }),
      ]);
      if (ok) return true;
      if (Date.now() > until) throw new Error('the new version did not answer in time');
      await new Promise((r) => setTimeout(r, 500));
    }
  } finally {
    child.kill('SIGTERM');
    await Promise.race([gone, new Promise((r) => setTimeout(r, 5000))]);
    if (child.exitCode === null) child.kill('SIGKILL');
  }
}

export async function discard(repo, dir) {
  if (!dir) return;
  await git(repo, 'worktree', 'remove', '--force', path.join(dir, 'src')).catch(() => {});
  fs.rmSync(dir, { recursive: true, force: true });
  await git(repo, 'worktree', 'prune').catch(() => {});
}

/**
 * Put a prepared version in place of the running checkout. The process still has to be restarted.
 * Returns what was replaced (paths under app/); the previous copies stay beside them as <name>.old
 * until the new version has come up (settle) or has to be taken out again (rollback).
 */
export async function install(repo, update, dir) {
  if ((await git(repo, 'rev-parse', 'HEAD')) !== update.current) throw new Error('the checkout moved while the update was being prepared');
  if (await git(repo, 'status', '--porcelain', '--untracked-files=no')) throw new Error('this checkout has local changes');
  const live = path.join(repo, 'app');
  const made = path.join(dir, 'src', 'app');
  const swaps = [];
  // Built files first, under new names; they only get their real names once everything is there.
  const stage = (rel) => {
    const from = path.join(made, rel);
    if (!fs.existsSync(from) || fs.lstatSync(from).isSymbolicLink()) return;
    const next = path.join(live, `${rel}.next`);
    fs.rmSync(next, { recursive: true, force: true });
    fs.cpSync(from, next, { recursive: true, verbatimSymlinks: true });
    swaps.push(rel);
  };
  stage('dist');
  stage(path.join('server', 'vendor'));
  if (update.lock) stage('node_modules');
  await git(repo, 'merge', '--ff-only', '--quiet', update.to);
  for (const rel of swaps) {
    const at = path.join(live, rel);
    const old = path.join(live, `${rel}.old`);
    fs.rmSync(old, { recursive: true, force: true });
    if (fs.existsSync(at)) fs.renameSync(at, old);
    fs.renameSync(path.join(live, `${rel}.next`), at);
  }
  return swaps;
}

/** The new version came up: the previous built files can go. */
export function settle(repo, swaps) {
  for (const rel of swaps) fs.rmSync(path.join(repo, 'app', `${rel}.old`), { recursive: true, force: true });
}

/** The new version did not come up: back to the commit and the built files that were running before. */
export async function rollback(repo, from, swaps) {
  // --keep refuses instead of discarding anything that is not the update itself.
  await git(repo, 'reset', '--keep', '--quiet', from);
  for (const rel of swaps) {
    const at = path.join(repo, 'app', rel);
    const old = `${at}.old`;
    if (!fs.existsSync(old)) continue;
    fs.rmSync(at, { recursive: true, force: true });
    fs.renameSync(old, at);
  }
}

export class SelfUpdate {
  /**
   * idle(): nothing is under way. hold(on): stop or resume starting new turns. restart(handover): leave the
   * running process to handover.js, given { from, to, swaps }; set by the entry point, absent in tests.
   */
  constructor({ store, idle, hold, restart, repo = path.resolve(here, '..', '..'), every = 10 * 60_000, holdFor = 60 * 60_000, steps = {} } = {}) {
    this.store = store;
    this.repo = repo;
    this.idle = idle || (() => true);
    this.hold = hold || (() => {});
    this.restart = restart;
    this.holdFor = holdFor;
    this.steps = { findUpdate, prepare, install, discard, ...steps };
    this.ready = null; // { update, dir, since }: built and tried, waiting for a quiet moment
    this.working = false;
    const s = this.state;
    // The process that just replaced an older one says so once; so does one that was put back.
    const from = process.env.AUTODOS_UPDATED_FROM;
    const failed = process.env.AUTODOS_UPDATE_FAILED;
    delete process.env.AUTODOS_UPDATED_FROM;
    delete process.env.AUTODOS_UPDATE_FAILED;
    if (from) Object.assign(s, { updatedAt: now(), from, error: '', available: '', failed: null });
    if (failed) {
      const [sha, ...why] = failed.split('\n');
      Object.assign(s, { error: `The update to ${sha.slice(0, 7)} did not come up and was taken out again: ${why.join(' ').slice(0, 400)}`, failed: { sha, tries: 3 }, current: '' });
    }
    if (from || failed) store.changed();
    this.timer = setInterval(() => this.tick().catch(() => {}), every);
    this.timer.unref?.();
    this.first = setTimeout(() => this.tick().catch(() => {}), 60_000);
    this.first.unref?.();
    // An update that is ready switches at the first quiet moment, not only at the next check.
    this.quiet = setInterval(() => this.ready && !this.working && this.tick({ fetch: false }).catch(() => {}), 15_000);
    this.quiet.unref?.();
  }

  get state() {
    return (this.store.data.selfUpdate ||= {});
  }

  get possible() {
    return fs.existsSync(path.join(this.repo, '.git'));
  }

  enabled() {
    if (!this.possible) return false;
    return process.env.AUTODOS_SELF_UPDATE ? process.env.AUTODOS_SELF_UPDATE === '1' : !!this.store.data.settings.selfUpdate;
  }

  close() {
    clearInterval(this.timer);
    clearInterval(this.quiet);
    clearTimeout(this.first);
  }

  /** What Settings shows. */
  status() {
    const s = this.state;
    return { possible: this.possible, enabled: this.enabled(), checkedAt: s.checkedAt || '', current: s.current || '', available: s.available || '', count: s.count || 0, waiting: !!this.ready, error: s.error || '', skipped: s.skipped || '', updatedAt: s.updatedAt || '', from: s.from || '' };
  }

  async #drop() {
    if (!this.ready) return;
    const { dir } = this.ready;
    this.ready = null;
    this.hold(false);
    await this.steps.discard(this.repo, dir);
  }

  /** Look for an update and take it when it is safe to. `force` is the person asking for it now. */
  async tick({ force = false, fetch = true } = {}) {
    if (this.working || !this.possible) return this.status();
    if (!force && !this.enabled()) {
      await this.#drop();
      return this.status();
    }
    this.working = true;
    const s = this.state;
    let trying = '';
    try {
      const u = fetch || !this.ready ? await this.steps.findUpdate(this.repo) : this.ready.update;
      s.checkedAt = now();
      s.current = u.current;
      s.skipped = u.skip || '';
      s.available = u.to || '';
      s.count = u.count || 0;
      if (this.ready && this.ready.update.to !== u.to) await this.#drop();
      if (!u.to) {
        if (!u.skip) s.error = '';
      } else if (s.failed?.sha === u.to && s.failed.tries >= 3 && !force) {
        // This commit did not build or come up; wait for a newer one instead of trying it forever.
      } else {
        trying = u.to;
        if (!this.ready) this.ready = { update: u, dir: await this.steps.prepare(this.repo, u.to, { workDir: this.store.dir, lock: u.lock }), since: Date.now() };
        this.hold(true);
        if (this.idle()) await this.#switch();
        else if (Date.now() - this.ready.since > this.holdFor) {
          // The work under way is taking too long to wait for: let the team carry on and try again at the next check.
          await this.#drop();
        }
      }
    } catch (e) {
      s.error = String(e.message).slice(0, 500);
      if (trying) s.failed = { sha: trying, tries: (s.failed?.sha === trying ? s.failed.tries : 0) + 1 };
      await this.#drop().catch(() => {});
    } finally {
      this.working = false;
      this.store.changed();
    }
    return this.status();
  }

  async #switch() {
    const { update, dir } = this.ready;
    const s = this.state;
    const swaps = await this.steps.install(this.repo, update, dir);
    this.ready = null;
    await this.steps.discard(this.repo, dir);
    s.current = update.to;
    s.available = '';
    s.count = 0;
    s.error = '';
    this.store.changed();
    if (this.restart) await this.restart({ from: update.current, to: update.to, swaps });
    else this.hold(false);
  }
}
