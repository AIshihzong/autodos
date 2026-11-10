// Environment check: are the tools Autodos needs installed and signed in, and how to fix each one.
// Fix commands come only from this table; callers name a check, never a command.
import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { childEnv, noteSignIn, which } from './runtimes.js';

// Windows runs .cmd/.bat programs (npm, codex, claude installed by npm) only through a shell.
const winScript = (bin) => process.platform === 'win32' && /\.(cmd|bat)$/i.test(bin);
const run = (bin, args, timeout = 8000) =>
  new Promise((resolve) => {
    execFile(bin, args, { env: childEnv(), timeout, shell: winScript(bin) }, (err, stdout, stderr) => resolve({ ok: !err, out: `${stdout || ''}${stderr || ''}`.trim() }));
  });


// npm sits next to the Node that runs this server, even when it is not on PATH.
function npm() {
  const sibling = path.join(path.dirname(process.execPath), process.platform === 'win32' ? 'npm.cmd' : 'npm');
  return which('npm') || (fs.existsSync(sibling) ? sibling : null);
}
const npmInstall = (pkg) => (npm() ? { kind: 'run', cmd: [npm(), 'install', '-g', pkg] } : { kind: 'link', url: 'https://nodejs.org/' });

const firstLine = (s) => String(s || '').split('\n')[0].trim();
const mac = process.platform === 'darwin';

/**
 * Each check: id, need ('required' | 'agent' | 'optional'), and probe() -> { installed, signedIn?, version, detail }.
 * install / login describe the fix: 'run' runs here in the background, 'terminal' opens a terminal window
 * because the tool asks questions or opens a browser.
 */
const CHECKS = [
  {
    id: 'node',
    need: 'required',
    async probe() {
      const v = process.versions.node;
      const ok = Number(v.split('.')[0]) >= 20;
      return { installed: true, version: `v${v}`, problem: ok ? '' : 'old' };
    },
    install: () => (which('brew') ? { kind: 'run', cmd: ['brew', 'install', 'node'] } : { kind: 'link', url: 'https://nodejs.org/' }),
  },
  {
    id: 'git',
    need: 'required',
    async probe() {
      const bin = which('git');
      if (!bin) return { installed: false };
      const r = await run(bin, ['--version']);
      // On a Mac without the developer tools, /usr/bin/git exists but only offers to install them.
      return r.ok ? { installed: true, version: firstLine(r.out).replace(/^git version /, '') } : { installed: false };
    },
    install: () => (which('brew') ? { kind: 'run', cmd: ['brew', 'install', 'git'] } : mac ? { kind: 'run', cmd: ['xcode-select', '--install'] } : { kind: 'link', url: 'https://git-scm.com/downloads' }),
  },
  {
    id: 'claude',
    need: 'agent',
    async probe() {
      const bin = which('claude');
      if (!bin) return { installed: false };
      const [v, a] = await Promise.all([run(bin, ['--version']), run(bin, ['auth', 'status'])]);
      let signedIn = false;
      try {
        signedIn = !!JSON.parse(a.out).loggedIn;
      } catch {
        signedIn = a.ok && !/not logged in|logged out/i.test(a.out);
      }
      // An API key in the environment works without signing in.
      if (process.env.ANTHROPIC_API_KEY) signedIn = true;
      return { installed: true, signedIn, version: firstLine(v.out).replace(/\s*\(Claude Code\)/, '') };
    },
    install: () => npmInstall('@anthropic-ai/claude-code'),
    login: () => ({ kind: 'terminal', cmd: 'claude auth login' }),
  },
  {
    id: 'codex',
    need: 'agent',
    async probe() {
      const bin = which('codex');
      if (!bin) return { installed: false };
      const [v, a] = await Promise.all([run(bin, ['--version']), run(bin, ['login', 'status'])]);
      const signedIn = (a.ok && /logged in/i.test(a.out) && !/not logged in/i.test(a.out)) || !!process.env.OPENAI_API_KEY;
      return { installed: true, signedIn, version: firstLine(v.out).replace(/^codex-cli\s*/, '') };
    },
    install: () => npmInstall('@openai/codex'),
    login: () => ({ kind: 'terminal', cmd: 'codex login' }),
  },
  {
    id: 'gh',
    need: 'optional',
    async probe() {
      const bin = which('gh');
      if (!bin) return { installed: false };
      const [v, a] = await Promise.all([run(bin, ['--version']), run(bin, ['auth', 'status'])]);
      const account = a.out.match(/account (\S+)/)?.[1] || '';
      return { installed: true, signedIn: a.ok, version: firstLine(v.out).match(/(\d+\.\d+\.\d+)/)?.[1] || '', account };
    },
    install: () => (which('brew') ? { kind: 'run', cmd: ['brew', 'install', 'gh'] } : { kind: 'link', url: 'https://cli.github.com/' }),
    login: () => ({ kind: 'terminal', cmd: 'gh auth login --web --git-protocol https' }),
  },
];

/**
 * Run every check. `ready` means a todo can run for real: Node, Git, and the agent that will be used
 * (the chosen default, or any signed-in one when the default is "auto").
 */
export async function diagnose(settings = {}) {
  const items = await Promise.all(
    CHECKS.map(async (c) => {
      let r;
      try {
        r = await c.probe();
      } catch (e) {
        r = { installed: false, detail: e.message };
      }
      const needsLogin = !!c.login && r.installed && r.signedIn === false;
      const ok = r.installed && !r.problem && !needsLogin;
      const fix = !r.installed || r.problem ? 'install' : needsLogin ? 'login' : null;
      return { id: c.id, need: c.need, ok, ...r, fix };
    }),
  );
  const by = Object.fromEntries(items.map((x) => [x.id, x]));
  for (const id of ['claude', 'codex']) if (by[id].installed) noteSignIn(id, by[id].signedIn);
  const chosen = settings.defaultRuntime;
  const agent = chosen === 'claude' || chosen === 'codex' ? by[chosen].ok : by.claude.ok || by.codex.ok;
  return { ready: by.node.ok && by.git.ok && agent, agent, items, platform: process.platform, host: os.hostname(), at: new Date().toISOString() };
}

/** Open a terminal window running a sign-in command. Returns false when there is no way to do that here. */
function openTerminal(cmd) {
  if (mac) {
    const script = `tell application "Terminal"\nactivate\ndo script ${JSON.stringify(cmd)}\nend tell`;
    spawn('osascript', ['-e', script], { stdio: 'ignore', detached: true }).unref();
    return true;
  }
  for (const term of ['x-terminal-emulator', 'gnome-terminal', 'konsole']) {
    if (which(term)) {
      spawn(term, ['-e', `sh -c '${cmd}; exec $SHELL'`], { env: childEnv(), stdio: 'ignore', detached: true }).unref();
      return true;
    }
  }
  return false;
}

/** Background fixes in progress or just finished, by check id. */
const jobs = new Map();

export function fixJobs() {
  return Object.fromEntries([...jobs].map(([k, v]) => [k, { running: v.running, ok: v.ok, log: v.log.slice(-2000), command: v.command }]));
}

/** Start the fix for one check. Returns what the UI should tell the person. */
export function fix(id, onDone = () => {}, settings = {}) {
  const c = CHECKS.find((x) => x.id === id);
  if (!c) throw Object.assign(new Error('Unknown check'), { status: 404 });
  return diagnose(settings).then((report) => {
    const item = report.items.find((x) => x.id === id);
    const plan = item.fix === 'install' ? c.install?.() : item.fix === 'login' ? c.login?.() : null;
    if (!plan) return { kind: 'none' };
    if (plan.kind === 'link') return plan;
    if (plan.kind === 'terminal') return openTerminal(plan.cmd) ? { kind: 'terminal', command: plan.cmd } : { kind: 'manual', command: plan.cmd };
    if (jobs.get(id)?.running) return { kind: 'run', command: jobs.get(id).command };
    const job = { running: true, ok: null, log: '', command: plan.cmd.map((x, i) => (i ? x : path.basename(x))).join(' ') };
    jobs.set(id, job);
    const [bin, ...args] = plan.cmd;
    // npm's own script starts with `#!/usr/bin/env node`, so this Node must be on its PATH.
    const env = childEnv();
    env.PATH = `${path.dirname(process.execPath)}${path.delimiter}${env.PATH}`;
    const exe = which(bin) || bin;
    const child = spawn(exe, args, { env, stdio: ['ignore', 'pipe', 'pipe'], shell: winScript(exe) });
    const add = (b) => (job.log = (job.log + b.toString()).slice(-8000));
    child.stdout.on('data', add);
    child.stderr.on('data', add);
    const end = (ok) => {
      if (!job.running) return;
      job.running = false;
      job.ok = ok;
      onDone(id, ok);
    };
    child.on('error', (e) => (add(e.message), end(false)));
    child.on('close', (code) => end(code === 0));
    return { kind: 'run', command: job.command };
  });
}
