#!/usr/bin/env node
// Autodos worker: runs agent turns for a Autodos hub on this machine.
// It connects out to the hub (no open port needed), checks out each todo's branch from the
// project's shared git remote, runs Claude Code / Codex here, and pushes the branch back.
//
//   node worker/worker.js --hub https://your-hub.example --key cbk_…
//
// Needs: git with access to the project's remote, and the agent CLIs (claude, codex) logged in.
import fs from 'node:fs';
import os from 'node:os';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runtimes, resolveRuntime, detectRuntimes } from '../server/runtimes.js';
import { git, commitAll } from '../server/git.js';
import { diagnose } from '../server/doctor.js';

// This machine's environment check, sent with every poll and refreshed every 10 minutes.
let doctor = null;
const recheck = () => diagnose().then((d) => (doctor = d)).catch(() => {});
recheck();
setInterval(recheck, 10 * 60_000).unref();

/** ~/.autodos-worker, or ~/.crewboard-worker for a machine paired before the rename. */
function workerDir() {
  const cur = path.join(os.homedir(), '.autodos-worker');
  const old = path.join(os.homedir(), '.crewboard-worker');
  return !fs.existsSync(path.join(cur, 'config.json')) && fs.existsSync(path.join(old, 'config.json')) ? old : cur;
}

const safe = (s) => String(s).replace(/[^\w.-]+/g, '_').slice(0, 60);
// One folder per exact repository URL: a hash keeps similar-looking URLs apart.
const repoKey = (url) => `${safe(url.split('/').slice(-1)[0] || 'repo')}-${crypto.createHash('sha256').update(url).digest('hex').slice(0, 16)}`;

export async function runWorker({ hub, key, dir = workerDir(), capacity = 2, signal, log = console.log } = {}) {
  hub = hub.replace(/\/$/, '');
  const running = new Map(); // jobId -> AbortController
  const call = async (p, body, timeoutMs = 35_000) => {
    const res = await fetch(hub + p, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify(body || {}),
      signal: AbortSignal.any([AbortSignal.timeout(timeoutMs), ...(signal ? [signal] : [])]),
    });
    const out = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(out.error || `HTTP ${res.status}`);
    return out;
  };

  async function checkout(job) {
    if (!/^(https:\/\/|ssh:\/\/|git@|file:\/\/|\/)[^\s]+$/.test(job.repo)) throw new Error(`Refusing repository URL ${job.repo}`);
    if (!/^autodos\/todo-\d+$/.test(job.branch)) throw new Error(`Refusing branch ${job.branch}`);
    const repoDir = path.join(dir, 'repos', repoKey(job.repo));
    if (!fs.existsSync(repoDir)) {
      fs.mkdirSync(path.dirname(repoDir), { recursive: true });
      await git(path.dirname(repoDir), ['clone', '--quiet', '--', job.repo, repoDir]);
    }
    const origin = await git(repoDir, ['remote', 'get-url', 'origin']);
    if (origin !== job.repo) throw new Error(`Checkout at ${repoDir} belongs to ${origin}, not ${job.repo}`);
    await git(repoDir, ['fetch', '--quiet', 'origin', job.branch]);
    const wt = path.join(dir, 'worktrees', repoKey(job.repo), safe(job.branch));
    if (fs.existsSync(wt)) {
      await git(wt, ['reset', '--hard', `origin/${job.branch}`]);
      await git(wt, ['clean', '-fd']);
    } else {
      fs.mkdirSync(path.dirname(wt), { recursive: true });
      await git(repoDir, ['worktree', 'add', '-B', job.branch, wt, `origin/${job.branch}`]);
    }
    return wt;
  }

  const branchLocks = new Map(); // repo#branch -> promise of the job using it
  async function execute(job) {
    const lockKey = `${job.repo}#${job.branch}`;
    const before = branchLocks.get(lockKey) || Promise.resolve();
    let release;
    branchLocks.set(lockKey, new Promise((r) => (release = r)));
    await before;
    try {
      return await executeLocked(job);
    } finally {
      release();
      if (branchLocks.get(lockKey)) branchLocks.delete(lockKey);
    }
  }

  async function executeLocked(job) {
    const ctrl = new AbortController();
    running.set(job.id, ctrl);
    let buf = '';
    let misses = 0;
    // Reports output and learns about cancels. If the hub stays unreachable, stop: nobody is waiting.
    const flush = async () => {
      const text = buf;
      buf = '';
      try {
        const r = await call(`/workers/jobs/${job.id}/progress`, { text });
        misses = 0;
        if (r.cancel) ctrl.abort();
      } catch {
        if (++misses >= 20) ctrl.abort();
      }
    };
    const ticker = setInterval(() => flush(), 1500);
    try {
      log(`#${job.todo} ${job.kind}: ${job.title}`);
      const cwd = await checkout(job);
      const rt = resolveRuntime(job.runtimeId);
      const res = await runtimes[rt].run({
        prompt: job.prompt,
        cwd,
        kind: job.kind,
        title: job.title,
        sessionId: rt === 'claude' ? job.sessionId : null,
        model: job.model,
        signal: ctrl.signal,
        settings: job.settings || {},
        onText: (c) => (buf += c),
        env: job.env || undefined,
      });
      clearInterval(ticker);
      await flush(); // last chance to hear about a cancel before anything is pushed
      if (ctrl.signal.aborted) throw new Error('Stopped');
      await commitAll(cwd, `#${job.todo} ${job.title}`).catch(() => {});
      // Lease on the commit the hub handed us, so a newer branch is never overwritten.
      await git(cwd, ['push', `--force-with-lease=refs/heads/${job.branch}:${job.startSha || ''}`, 'origin', `HEAD:refs/heads/${job.branch}`]);
      await call(`/workers/jobs/${job.id}/done`, { ok: true, text: res.text, sessionId: res.sessionId, usage: res.usage });
      log(`#${job.todo} done`);
    } catch (e) {
      clearInterval(ticker);
      await call(`/workers/jobs/${job.id}/done`, { ok: false, error: e.message }).catch(() => {});
      log(`#${job.todo} failed: ${e.message}`);
    } finally {
      running.delete(job.id);
    }
  }

  log(`Autodos worker connected to ${hub} (up to ${capacity} at once)`);
  let backoff = 1000;
  while (!signal?.aborted) {
    if (running.size >= capacity) {
      await new Promise((r) => setTimeout(r, 500));
      continue;
    }
    try {
      const { job } = await call('/workers/poll?wait=25000', { runtimes: detectRuntimes(), running: [...running.keys()], host: os.hostname(), version: '0.1.0', doctor });
      backoff = 1000;
      if (job) execute(job);
    } catch (e) {
      if (signal?.aborted) break;
      log(`Hub unreachable (${e.message}); retrying in ${Math.round(backoff / 1000)}s`);
      await new Promise((r) => setTimeout(r, backoff));
      backoff = Math.min(60_000, backoff * 2);
    }
  }
  for (const c of running.values()) c.abort();
}

/** Trade a one-time pairing code for a machine key: print the four words, wait for approval, save the key. */
export async function pairWorker({ hub, code, dir = workerDir(), log = console.log }) {
  hub = hub.replace(/\/$/, '');
  const nonce = crypto.randomBytes(16).toString('hex');
  const post = async (p, body) => {
    const r = await fetch(hub + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(35_000) });
    const out = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(out.error || `HTTP ${r.status}`);
    return out;
  };
  const { words } = await post('/workers/pair', { code, nonce, host: os.hostname(), name: os.hostname().split('.')[0] });
  log(`\nCheck that Autodos shows the same four words, then approve there:\n\n    ${words.join('  ')}\n`);
  for (;;) {
    const r = await post('/workers/pair/wait', { code, nonce });
    if (r.status === 'approved') {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ hub, key: r.key, id: r.id }, null, 2), { mode: 0o600 });
      log(`Paired as "${r.id}".`);
      return r.key;
    }
    if (r.status !== 'requested') throw new Error(`Pairing ${r.status}`);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const arg = (n) => {
    const i = process.argv.indexOf(`--${n}`);
    return i > 0 ? process.argv[i + 1] : process.env[`AUTODOS_${n.toUpperCase()}`];
  };
  const dir = workerDir();
  let saved = {};
  try {
    saved = JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'));
  } catch {}
  const hub = arg('hub') || saved.hub;
  let key = arg('key') || (hub === saved.hub ? saved.key : '');
  if (!hub) {
    console.error('Usage: node worker/worker.js --hub <hub url> --pair <code>   (first time)\n       node worker/worker.js                                (afterwards)');
    process.exit(1);
  }
  const ctrl = new AbortController();
  process.on('SIGINT', () => ctrl.abort());
  process.on('SIGTERM', () => ctrl.abort());
  (async () => {
    if (arg('pair')) key = await pairWorker({ hub, code: arg('pair'), dir });
    if (!key) throw new Error('Not paired yet: run with --pair <code> from Autodos → Settings → Machines.');
    await runWorker({ hub, key, capacity: Number(arg('capacity')) || 2, signal: ctrl.signal });
  })().catch((e) => (console.error(e.message), process.exit(1)));
}
