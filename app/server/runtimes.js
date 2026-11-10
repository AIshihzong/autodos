// Runtime adapters: each one runs a single agent "turn" and streams text back.
// run({ prompt, cwd, kind, sessionId, model, signal, onText, settings }) -> { text, sessionId, usage }
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// GUI apps on macOS start with a minimal PATH; add the usual install locations.
const home = os.homedir();
const EXTRA_PATH = [
  path.join(home, '.local/bin'),
  path.join(home, '.npm-global/bin'),
  path.join(home, '.bun/bin'),
  path.join(home, '.volta/bin'),
  '/opt/homebrew/bin',
  '/usr/local/bin',
];
export const childEnv = () => ({
  ...process.env,
  PATH: [...new Set([...(process.env.PATH || '').split(path.delimiter), ...EXTRA_PATH])].filter(Boolean).join(path.delimiter),
});

/** Find a program on PATH (on Windows also as .exe/.cmd). */
export function which(bin) {
  const exts = process.platform === 'win32' ? ['', ...(process.env.PATHEXT || '.EXE;.CMD;.BAT').split(';').map((x) => x.toLowerCase())] : [''];
  for (const dir of childEnv().PATH.split(path.delimiter)) {
    for (const ext of exts) {
      const p = path.join(dir, bin + ext);
      try {
        fs.accessSync(p, fs.constants.X_OK);
        if (fs.statSync(p).isFile()) return p;
      } catch {}
    }
  }
  return null;
}

// Agents the environment check found installed but signed out: "auto" skips them.
const signedOut = new Set();
export function noteSignIn(id, signedIn) {
  if (signedIn === false) signedOut.add(id);
  else signedOut.delete(id);
}

function version(bin) {
  try {
    return execFileSync(bin, ['--version'], { env: childEnv(), timeout: 5000 }).toString().trim().split('\n')[0];
  } catch {
    return '';
  }
}

let detected = null;
export function detectRuntimes(force = false) {
  if (detected && !force) return detected;
  const claude = which('claude');
  const codex = which('codex');
  detected = [
    { id: 'claude', name: 'Claude Code', available: !!claude, path: claude, version: claude ? version(claude) : '', signedIn: !signedOut.has('claude') },
    { id: 'codex', name: 'Codex CLI', available: !!codex, path: codex, version: codex ? version(codex) : '', signedIn: !signedOut.has('codex') },
    { id: 'demo', name: 'Demo (simulated)', available: true, path: null, version: 'built-in' },
  ];
  return detected;
}

/** Resolve "auto" to the best installed runtime. */
export function resolveRuntime(name) {
  const list = detectRuntimes();
  if (name && name !== 'auto') {
    const r = list.find((x) => x.id === name);
    if (r?.available) return r.id;
  }
  return (list.find((x) => x.available && x.id !== 'demo' && !signedOut.has(x.id)) || list.find((x) => x.available)).id;
}

function spawnLines(bin, args, { cwd, signal, onLine, onStderr, env }) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error('Stopped'));
    const child = spawn(bin, args, { cwd, env: { ...childEnv(), ...(env || {}) }, stdio: ['ignore', 'pipe', 'pipe'] });
    let buf = '';
    let err = '';
    const abort = () => child.kill('SIGTERM');
    signal?.addEventListener('abort', abort, { once: true });
    child.stdout.on('data', (d) => {
      buf += d.toString();
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        if (line.trim()) onLine(line);
      }
    });
    child.stderr.on('data', (d) => {
      err += d.toString();
      onStderr?.(d.toString());
    });
    child.on('error', reject);
    child.on('close', (code) => {
      signal?.removeEventListener('abort', abort);
      if (buf.trim()) onLine(buf);
      if (signal?.aborted) return reject(new Error('Stopped'));
      if (code !== 0) return reject(new Error(err.trim().split('\n').slice(-5).join('\n') || `exited with code ${code}`));
      resolve();
    });
  });
}

const claude = {
  async run({ prompt, cwd, kind, sessionId, model, signal, onText, settings, env, onSession }) {
    const args = ['-p', prompt, '--output-format', 'stream-json', '--verbose'];
    const permission = ['plan', 'chief', 'review'].includes(kind) ? 'plan' : settings.claudePermissionMode || 'acceptEdits';
    args.push('--permission-mode', permission);
    if (sessionId) args.push('--resume', sessionId);
    if (model) args.push('--model', model);
    let text = '';
    let result = null;
    let sid = sessionId;
    await spawnLines(detectRuntimes().find((r) => r.id === 'claude').path, args, {
      cwd,
      env,
      signal,
      onLine(line) {
        let ev;
        try {
          ev = JSON.parse(line);
        } catch {
          return;
        }
        if (ev.session_id && ev.session_id !== sid) {
          sid = ev.session_id;
          onSession?.(sid); // known early, so a redirected turn can resume this same session
        }
        if (ev.type === 'assistant') {
          for (const c of ev.message?.content || []) {
            if (c.type === 'text' && c.text) {
              text += (text ? '\n\n' : '') + c.text;
              onText?.(c.text + '\n\n');
            } else if (c.type === 'tool_use') {
              onText?.(`› ${c.name}${toolHint(c.input)}\n`);
            }
          }
        } else if (ev.type === 'result') {
          result = ev;
        }
      },
    });
    if (result?.is_error) throw new Error(result.result || 'Claude Code reported an error');
    return {
      text: (result?.result || text).trim(),
      sessionId: sid,
      usage: {
        inputTokens: (result?.usage?.input_tokens || 0) + (result?.usage?.cache_read_input_tokens || 0) + (result?.usage?.cache_creation_input_tokens || 0),
        outputTokens: result?.usage?.output_tokens || 0,
        costUsd: result?.total_cost_usd || 0,
      },
    };
  },
};

function toolHint(input = {}) {
  const v = input.file_path || input.path || input.command || input.pattern || input.url || '';
  return v ? ` ${String(v).slice(0, 80)}` : '';
}

const codex = {
  async run({ prompt, cwd, kind, model, signal, onText, env }) {
    // A private temp folder per run, so parallel runs never share an output file.
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'autodos-codex-'));
    const out = path.join(tmp, 'last-message.txt');
    const args = ['exec', '--skip-git-repo-check', '--output-last-message', out];
    if (['plan', 'chief', 'review'].includes(kind)) args.push('--sandbox', 'read-only');
    // `codex exec` never stops to ask; workspace-write lets it edit the todo's folder. (--full-auto was removed in newer Codex.)
    else args.push('--sandbox', 'workspace-write');
    if (model) args.push('-m', model);
    args.push(prompt);
    let text = '';
    try {
      await spawnLines(detectRuntimes().find((r) => r.id === 'codex').path, args, {
        cwd,
        env,
        signal,
        onLine: (line) => onText?.(line + '\n'),
      });
      text = fs.existsSync(out) ? fs.readFileSync(out, 'utf8').trim() : '';
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
    return { text, sessionId: null, usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 } };
  },
};

const sleep = (ms, signal) =>
  new Promise((res, rej) => {
    const t = setTimeout(res, ms);
    signal?.addEventListener('abort', () => (clearTimeout(t), rej(new Error('Stopped'))), { once: true });
  });

// Simulated runtime so the app is fully usable without any agent installed.
const demo = {
  async run({ prompt, kind, signal, onText, title = 'the task' }) {
    const lines =
      kind === 'plan'
        ? [`Plan for “${title}”:`, '1. Read the relevant files and find where this belongs.', '2. Make the change in small, reviewable steps.', '3. Add or update a test that covers it.', '4. Run the checks and summarize what changed.']
        : kind === 'chief'
          ? ['{}']
          : /\[ask\]/i.test(title) && !/Answer to your question/.test(prompt)
            ? ['I looked at the code. One choice is yours.', '```ask\nquestion: Keep the old layout or switch to the new one?\n- Keep the old layout\n- Switch to the new one\n```']
          : kind === 'review'
            ? ['{"summary": "Simulated review: no problems found.", "findings": []}']
          : [`› Read project files`, `› Edit 2 files`, `› Run tests (all passing)`, `Done: “${title}”. This is a simulated run, so no files were changed. Install Claude Code or Codex and switch the agent's runtime to run it for real.`];
    let text = '';
    for (const l of lines) {
      await sleep(500 + Math.random() * 700, signal);
      text += l + '\n';
      onText?.(l + '\n');
    }
    const words = prompt.split(/\s+/).length;
    return { text: text.trim(), sessionId: null, usage: { inputTokens: words * 4, outputTokens: text.length / 4, costUsd: 0 }, simulated: true };
  },
};

export const runtimes = { claude, codex, demo };
