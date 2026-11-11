// While the team has work, the Mac it runs on stays awake. A Mac that goes to sleep at night stops every
// turn, timer and merge with it, and nothing moves until someone touches it. On macOS Autodos holds a
// `caffeinate -i` assertion (idle sleep only: the display may still sleep, and closing a laptop lid still
// sleeps it) for as long as something is running, queued, waiting for a usage limit or with the lead,
// and lets go as soon as there is nothing left. Settings: "Keep this Mac awake while the team works".
import { spawn } from 'node:child_process';

const OPEN = new Set(['queued', 'planning', 'building', 'merging', 'shipping']);

/** Whether anything is under way or will carry on by itself. */
export function hasWork(data) {
  return data.todos.some((t) => OPEN.has(t.phase) || t.leadPending || t.completing);
}

export class KeepAwake {
  constructor(store, { platform = process.platform, every = 30_000, start } = {}) {
    this.store = store;
    this.platform = platform;
    this.start = start || (() => spawn('caffeinate', ['-i', '-w', String(process.pid)], { stdio: 'ignore', windowsHide: true }));
    this.child = null;
    this.timer = setInterval(() => this.check(), every);
    this.timer.unref?.();
    setImmediate(() => this.check());
  }

  get wanted() {
    return this.platform === 'darwin' && this.store.data.settings.keepAwake !== false && hasWork(this.store.data);
  }

  check() {
    if (this.wanted && !this.child) {
      try {
        const c = this.start();
        c.once?.('exit', () => this.child === c && (this.child = null));
        c.once?.('error', () => this.child === c && (this.child = null));
        this.child = c;
      } catch {
        this.child = null;
      }
    } else if (!this.wanted && this.child) this.stop();
    return !!this.child;
  }

  stop() {
    const c = this.child;
    this.child = null;
    try {
      c?.kill?.();
    } catch {}
  }

  close() {
    clearInterval(this.timer);
    this.stop();
  }
}
