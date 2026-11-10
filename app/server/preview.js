// One live preview per todo: the project's dev server, started in the todo's own worktree on a free port.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { childEnv } from './runtimes.js';

const MAX_LIVE = 3;

/** Suggest a preview command; {port} is replaced with a free port (also passed as $PORT). */
export function detectPreview(dir) {
  const has = (f) => fs.existsSync(path.join(dir, f));
  if (has('package.json')) {
    let scripts = {};
    try {
      scripts = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).scripts || {};
    } catch {}
    const pm = has('pnpm-lock.yaml') ? 'pnpm' : has('yarn.lock') ? 'yarn' : has('bun.lockb') || has('bun.lock') ? 'bun' : 'npm';
    if (scripts.dev) return /\bnext\b/.test(scripts.dev) ? `${pm} run dev -- -p {port}` : `${pm} run dev -- --port {port}`;
    if (scripts.start) return `${pm} start`;
  }
  if (has('index.html')) return 'python3 -m http.server {port} --bind 127.0.0.1';
  return '';
}

const freePort = () =>
  new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });

const listening = (port) =>
  new Promise((resolve) => {
    const sock = net.connect(port, '127.0.0.1');
    sock.once('connect', () => (sock.destroy(), resolve(true)));
    sock.once('error', () => resolve(false));
  });

export class Previews {
  constructor() {
    this.live = new Map(); // todoId -> { child, port, url, startedAt, log }
  }

  list() {
    return [...this.live.entries()].map(([todoId, p]) => ({ todoId, url: p.url, port: p.port, startedAt: p.startedAt, ready: p.ready }));
  }

  async start(t, project, requireWorktree = true) {
    const command = (project?.preview || '').trim();
    if (!command) throw new Error('Set a preview command for this project first (Projects → the project → Settings).');
    const hasWorktree = t.worktree && fs.existsSync(t.worktree);
    if (project.git && requireWorktree && !hasWorktree) throw new Error('This todo has no worktree yet, so there is nothing of its own to preview. Run it first.');
    const cwd = hasWorktree ? t.worktree : project.path;
    this.stop(t.id);
    // Keep a few running at most; the oldest goes first.
    while (this.live.size >= MAX_LIVE) this.stop([...this.live.entries()].sort((a, b) => a[1].startedAt.localeCompare(b[1].startedAt))[0][0]);
    const port = await freePort();
    const child = spawn('/bin/sh', ['-c', command.replaceAll('{port}', String(port))], { cwd, env: { ...childEnv(), PORT: String(port), BROWSER: 'none' }, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const p = { child, port, url: `http://localhost:${port}`, startedAt: new Date().toISOString(), log: '', ready: false, exited: null };
    const keep = (d) => (p.log = (p.log + d.toString()).slice(-4000));
    child.stdout.on('data', keep);
    child.stderr.on('data', keep);
    child.on('exit', (code) => (p.exited = code ?? -1));
    this.live.set(t.id, p);
    // Ready when something answers on the port (dev servers can take a while on first build).
    for (let i = 0; i < 120 && p.exited === null; i++) {
      if (await listening(port)) {
        p.ready = true;
        return { url: p.url };
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    this.stop(t.id);
    throw new Error(`The preview did not start${p.exited !== null ? ` (exited with ${p.exited})` : ' within 60 s'}:\n${p.log.trim().split('\n').slice(-8).join('\n')}`);
  }

  stop(todoId) {
    const p = this.live.get(todoId);
    if (!p) return false;
    this.live.delete(todoId);
    try {
      process.kill(-p.child.pid, 'SIGTERM');
      setTimeout(() => {
        try {
          process.kill(-p.child.pid, 'SIGKILL');
        } catch {}
      }, 3000).unref();
    } catch {}
    return true;
  }

  stopAll() {
    for (const id of [...this.live.keys()]) this.stop(id);
  }
}
