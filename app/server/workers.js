// Hub side of remote machines. A worker on another computer long-polls the hub for agent turns
// (it connects out, so it needs no open port), runs them on its own checkout, pushes the todo's
// branch to the shared git remote, and reports back.
import { id, now } from './store.js';
import { hashKey } from './rules.js';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { newKey } from './rules.js';

const APP_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const WORDS = 'amber anchor apple arrow aspen atlas basil beacon birch blossom canyon cedar cobalt comet coral cotton daisy delta ember falcon fern fjord forest garnet glacier harbor hazel heron indigo island ivory jasper juniper kelp lagoon lantern lemon lilac linen lotus maple marble meadow mint nectar noble oasis olive onyx orbit orchid otter pebble pepper pine plum polar quartz quill raven reef river robin saffron sage sierra silver spruce stone summit sunset tango thistle tulip velvet violet walnut willow winter yarrow zephyr'.split(' ');

/** Four words both screens show; matching them proves the two ends are talking to each other. */
export function pairWords(code, nonce) {
  const h = crypto.createHash('sha256').update(`${code}:${nonce}`).digest();
  return [0, 1, 2, 3].map((i) => WORDS[h.readUInt16BE(i * 2) % WORDS.length]);
}

const ONLINE_MS = 60_000;

export class Workers {
  constructor(store) {
    this.store = store;
    this.jobs = new Map(); // jobId -> { job, workerId, status, resolve, reject, onText, cancel }
    this.waiters = new Map(); // workerId -> Set<(job) => void>
    this.pairings = new Map(); // code -> { code, expires, status, words, nonce, info, auto, key, waiters }
    this.ssh = new Map(); // workerId -> child process keeping the tunnel and the remote worker up
    store.data.workers ||= [];
    // Machines added over SSH are reconnected when the hub starts.
    setTimeout(() => {
      for (const w of store.data.workers) if (w.ssh) this.connectSsh(w).catch((e) => (w.sshError = e.message));
    }, 1000);
  }

  // ---------- pairing ----------

  newPairing({ auto = false, name = '' } = {}) {
    let code = '';
    for (let i = 0; i < 8; i++) code += CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)];
    const p = { code, name, expires: Date.now() + 10 * 60_000, status: 'waiting', auto, waiters: new Set() };
    this.pairings.set(code, p);
    setTimeout(() => this.pairings.delete(code), 11 * 60_000).unref();
    return p;
  }

  pairingsView() {
    return [...this.pairings.values()].filter((p) => p.status === 'requested' && Date.now() < p.expires).map((p) => ({ code: p.code, words: p.words, host: p.info?.host || '', name: p.name || p.info?.name || '' }));
  }

  /** A worker presents a code. Returns the four words to show on its screen. */
  requestPairing(code, nonce, info) {
    const p = this.pairings.get(String(code || '').toUpperCase());
    if (!p || Date.now() > p.expires || p.status !== 'waiting' || !nonce) return null;
    p.status = 'requested';
    p.nonce = String(nonce).slice(0, 100);
    p.words = pairWords(p.code, p.nonce);
    p.info = { host: String(info?.host || '').slice(0, 80), name: String(info?.name || '').slice(0, 40) };
    if (p.auto) this.approvePairing(p.code);
    this.store.changed();
    return { words: p.words };
  }

  approvePairing(code, name) {
    const p = this.pairings.get(code);
    if (!p || p.status !== 'requested') throw new Error('No pairing request with that code');
    let id = String(name || p.name || p.info?.name || p.info?.host || 'machine').toLowerCase().replace(/[^a-z0-9.-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'machine';
    while (this.get(id)) id += '-2';
    const key = newKey();
    this.store.data.workers.push({ id, name: id, keyHash: hashKey(key), capacity: 2, createdAt: now(), host: p.info?.host || '', ...(p.sshTarget ? { ssh: p.sshTarget } : {}) });
    p.status = 'approved';
    p.key = key;
    p.workerId = id;
    for (const w of p.waiters) w();
    this.store.changed();
    return id;
  }

  rejectPairing(code) {
    const p = this.pairings.get(code);
    if (p) {
      p.status = 'rejected';
      for (const w of p.waiters) w();
    }
  }

  /** The worker waits here until the person approves; it gets its key once. */
  waitPairing(code, nonce, waitMs = 25_000) {
    const p = this.pairings.get(String(code || '').toUpperCase());
    if (!p || p.nonce !== String(nonce)) return Promise.resolve({ status: 'unknown' });
    const answer = () => {
      if (p.status === 'approved' && p.key) {
        const out = { status: 'approved', key: p.key, id: p.workerId };
        p.key = null; // handed out once
        this.pairings.delete(p.code);
        return out;
      }
      return { status: p.status };
    };
    if (p.status !== 'requested') return Promise.resolve(answer());
    return new Promise((resolve) => {
      const done = () => (clearTimeout(timer), p.waiters.delete(done), resolve(answer()));
      const timer = setTimeout(done, waitMs);
      p.waiters.add(done);
    });
  }

  // ---------- machines over SSH ----------

  /**
   * Add a machine you can already reach with ssh: copy the worker over, then keep one ssh session
   * open that runs it with a reverse tunnel back to this hub. No port is opened anywhere.
   */
  async addSsh(target, hubPort) {
    if (!/^[\w.@-]+$/.test(target) || target.startsWith('-')) throw new Error('Give the machine as user@host or a host from your ssh config');
    const p = this.newPairing({ auto: true });
    p.sshTarget = target;
    const w = { id: `ssh-${target}`, ssh: target, pending: p.code };
    await this.#installWorker(target);
    await this.connectSsh(w, hubPort, p.code);
    return { code: p.code };
  }

  #sshRun(target, args, input) {
    return new Promise((resolve, reject) => {
      const child = spawn('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15', target, ...args], { stdio: ['pipe', 'pipe', 'pipe'] });
      let err = '';
      child.stderr.on('data', (d) => (err += d));
      child.on('error', reject);
      child.on('close', (c) => (c === 0 ? resolve() : reject(new Error(err.trim().split('\n').pop() || `ssh exited ${c}`))));
      if (input) input.pipe(child.stdin);
      else child.stdin.end();
    });
  }

  async #installWorker(target) {
    await this.#sshRun(target, ['command -v node >/dev/null || { echo "node is not installed on this machine" >&2; exit 3; }; mkdir -p ~/.autodos-worker/app']);
    // Only what the worker needs: itself, the runtime adapters and the git helpers.
    const tar = spawn('tar', ['-cz', '-C', APP_DIR, 'worker/worker.js', 'server/runtimes.js', 'server/git.js', 'server/doctor.js', 'server/staff.js']);
    await this.#sshRun(target, ['cd ~/.autodos-worker/app && tar -xz && printf \'{"type":"module"}\' > package.json'], tar.stdout);
  }

  async connectSsh(w, hubPort = this.hubPort, code = null) {
    if (this.ssh.has(w.id)) return;
    const remotePort = 40000 + crypto.randomInt(9000);
    const args = ['-o', 'BatchMode=yes', '-o', 'ServerAliveInterval=30', '-o', 'ExitOnForwardFailure=yes', '-R', `${remotePort}:127.0.0.1:${hubPort}`, w.ssh];
    const cmd = code ? `cd ~/.autodos-worker/app && exec node worker/worker.js --hub http://127.0.0.1:${remotePort} --pair ${code}` : `cd ~/.autodos-worker/app && exec node worker/worker.js --hub http://127.0.0.1:${remotePort}`;
    const child = spawn('ssh', [...args, cmd], { stdio: ['ignore', 'pipe', 'pipe'] });
    this.ssh.set(w.id, child);
    let log = '';
    child.stderr.on('data', (d) => (log = (log + d).slice(-2000)));
    child.on('close', () => {
      this.ssh.delete(w.id);
      const saved = this.get(w.id) || this.store.data.workers.find((x) => x.ssh === w.ssh);
      if (saved) {
        saved.sshError = log.trim().split('\n').pop() || null;
        this.store.changed();
        // Keep it connected: try again in a minute unless the machine was removed.
        if (!this.closed) setTimeout(() => this.get(saved.id) && this.connectSsh(saved).catch(() => {}), 60_000).unref();
      }
    });
  }

  /** Forget a machine: close its SSH session if it has one. */
  remove(id) {
    const c = this.ssh.get(id);
    if (c) {
      this.ssh.delete(id);
      c.kill();
    }
  }

  close() {
    this.closed = true;
    for (const c of this.ssh.values()) c.kill();
  }

  list() {
    return this.store.data.workers.map(({ keyHash, ...w }) => ({
      ...w,
      online: !!w.lastSeen && Date.now() - Date.parse(w.lastSeen) < ONLINE_MS,
      running: [...this.jobs.values()].filter((j) => j.workerId === w.id && j.status === 'running').length,
      queued: [...this.jobs.values()].filter((j) => j.workerId === w.id && j.status === 'queued').length,
    }));
  }

  get(workerId) {
    return this.store.data.workers.find((w) => w.id === workerId);
  }

  /** Is this machine full? Used by the runner's queue so a busy machine's todos wait. */
  full(workerId) {
    const w = this.get(workerId);
    if (!w) return false;
    return [...this.jobs.values()].filter((j) => j.workerId === workerId && !j.settled).length >= (Number(w.capacity) || 2);
  }

  auth(header) {
    const key = String(header || '').replace(/^Bearer\s+/i, '');
    if (!key) return null;
    const h = Buffer.from(hashKey(key));
    return this.store.data.workers.find((w) => {
      const b = Buffer.from(w.keyHash || '');
      return b.length === h.length && crypto.timingSafeEqual(b, h);
    });
  }

  /** Send one agent turn to a worker; resolves with { text, sessionId, usage } like a local runtime. */
  run(workerId, job, { signal, onText }) {
    return new Promise((resolve, reject) => {
      const rec = { job: { ...job, id: id('job') }, workerId, status: 'queued', resolve, reject, onText, cancel: false };
      this.jobs.set(rec.job.id, rec);
      const stop = () => {
        rec.cancel = true;
        if (rec.status === 'queued') {
          // Not picked up yet: nothing runs remotely.
          this.jobs.delete(rec.job.id);
          rec.settled = true;
          return reject(new Error('Stopped'));
        }
        // Running: the worker learns on its next progress call. Keep waiting until it reports back
        // (the todo stays busy meanwhile), so the next turn can't touch the branch while this one runs.
        rec.giveUp = setTimeout(() => {
          if (rec.settled) return;
          rec.settled = true;
          this.jobs.delete(rec.job.id);
          reject(new Error('Stopped (the machine did not confirm in time)'));
        }, 120_000);
        rec.giveUp.unref?.();
      };
      if (signal?.aborted) return stop();
      signal?.addEventListener('abort', stop, { once: true });
      this.#offer(workerId);
    });
  }

  #offer(workerId) {
    const waiting = this.waiters.get(workerId);
    if (!waiting?.size) return;
    const rec = [...this.jobs.values()].find((j) => j.workerId === workerId && j.status === 'queued');
    if (!rec) return;
    const [give] = waiting;
    waiting.delete(give);
    rec.status = 'running';
    rec.startedAt = Date.now();
    give(rec.job);
  }

  /** A worker asks for work: answer now if a job waits, else hold the request up to `waitMs`. */
  poll(worker, info = {}, waitMs = 25_000) {
    worker.lastSeen = now();
    if (Array.isArray(info.runtimes)) worker.runtimes = info.runtimes.filter((r) => r.available).map((r) => r.id);
    if (info.version) worker.version = String(info.version).slice(0, 20);
    if (info.host) worker.host = String(info.host).slice(0, 80);
    // The machine's own environment check: keep only the fields the Machines tab shows.
    if (info.doctor && Array.isArray(info.doctor.items))
      worker.doctor = {
        ready: !!info.doctor.ready,
        at: String(info.doctor.at || '').slice(0, 40),
        items: info.doctor.items.slice(0, 10).map((x) => ({ id: String(x.id).slice(0, 20), ok: !!x.ok, installed: !!x.installed, signedIn: x.signedIn, version: String(x.version || '').slice(0, 40), need: String(x.need || '').slice(0, 10), fix: x.fix ? String(x.fix).slice(0, 10) : null })),
      };
    // A job we handed out that the worker no longer has (it restarted mid-run) goes back in the queue.
    if (Array.isArray(info.running)) {
      for (const rec of this.jobs.values()) {
        if (rec.workerId === worker.id && rec.status === 'running' && !info.running.includes(rec.job.id) && Date.now() - rec.startedAt > 15_000) rec.status = 'queued';
      }
    }
    this.store.changed();
    return new Promise((resolve) => {
      const set = this.waiters.get(worker.id) || new Set();
      this.waiters.set(worker.id, set);
      const give = (job) => (clearTimeout(timer), resolve({ job }));
      const timer = setTimeout(() => (set.delete(give), resolve({ job: null })), waitMs);
      set.add(give);
      this.#offer(worker.id);
    });
  }

  progress(worker, jobId, text) {
    const rec = this.jobs.get(jobId);
    if (!rec || rec.workerId !== worker.id) return { cancel: true };
    worker.lastSeen = now();
    if (text) rec.onText?.(String(text).slice(0, 20000));
    return { cancel: rec.cancel };
  }

  done(worker, jobId, result) {
    const rec = this.jobs.get(jobId);
    if (!rec || rec.workerId !== worker.id) return { ok: false };
    this.jobs.delete(jobId);
    worker.lastSeen = now();
    if (rec.settled) return { ok: true };
    rec.settled = true;
    clearTimeout(rec.giveUp);
    if (rec.cancel) rec.reject(new Error('Stopped'));
    else if (result.ok) rec.resolve({ text: String(result.text || ''), sessionId: result.sessionId || null, usage: result.usage || null });
    else rec.reject(new Error(`On ${worker.name}: ${String(result.error || 'the run failed').slice(0, 2000)}`));
    return { ok: true };
  }
}
