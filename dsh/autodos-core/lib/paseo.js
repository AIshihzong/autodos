// The execution layer: a thin wrapper around the Paseo CLI, which talks to the Paseo daemon on this machine.
// Paseo starts Claude Code / Codex in its own worktree and branch, and reports status, usage and
// pending permission requests. Every call is a short CLI run with --json; nothing here keeps state.
import { execFile } from 'node:child_process';

export function createPaseo(options = {}) {
  const bin = options.bin || process.env.PASEO_BIN || 'paseo';
  const host = options.host || process.env.PASEO_HOST || null;
  const timeoutMs = options.timeoutMs ?? 120_000;
  const exec = options.exec || execFile;

  function run(args, { signal, json = true } = {}) {
    const full = [...args, ...(json ? ['--json'] : []), ...(host ? ['--host', host] : [])];
    return new Promise((resolve, reject) => {
      exec(bin, full, { signal, timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024, env: process.env }, (error, stdout = '', stderr = '') => {
        if (error) {
          if (error.name === 'AbortError') return reject(error);
          const out = String(stdout).trim();
          let msg;
          try {
            const j = JSON.parse(out.slice(out.search(/[[{]/)));
            msg = j.error ? `${j.error.code}: ${j.error.message}` : JSON.stringify(j);
          } catch {
            msg = (out || String(stderr) || error.message).trim().replace(/\s+/g, ' ').slice(-2000);
          }
          return reject(new Error(`paseo ${args[0]} failed: ${msg}`));
        }
        resolve(parseJson(stdout, stderr));
      });
    });
  }

  return {
    bin,
    /** Start an agent. With `branch`, Paseo makes a new worktree on a new branch off `base` (or the current branch). */
    async dispatch({ cwd, prompt, provider, branch, base, title, mode }, signal) {
      const args = ['run', '--no-wait', '--cwd', cwd];
      if (title) args.push('--title', title);
      if (provider) args.push('--provider', provider);
      if (mode) args.push('--mode', mode);
      if (branch) {
        // Paseo cannot always infer a default branch (a repo with no remote): branch off the current HEAD.
        const from = base || (await currentBranch(cwd, exec));
        args.push('--new-workspace', 'worktree', '--worktree-mode', 'branch-off', '--worktree-slug', slug(branch), '--new-branch', branch);
        if (from) args.push('--base', from);
      }
      args.push(prompt);
      const r = await run(args, { signal });
      if (!r || typeof r !== 'object' || !r.agentId) throw new Error(`paseo run gave no agent id: ${JSON.stringify(r).slice(0, 300)}`);
      return r;
    },
    /** Send the agent a follow-up message. */
    send({ agentId, text }, signal) {
      return run(['send', '--no-wait', agentId, '--prompt', text], { signal });
    },
    /** Where an agent is: status, usage, pending permission requests and its recent output. */
    async status({ agentId, tail = 20 }, signal) {
      const info = await run(['inspect', agentId], { signal });
      let activity = '';
      try {
        const logs = await run(['logs', agentId, '--tail', String(tail)], { signal, json: false });
        activity = typeof logs === 'string' ? logs : JSON.stringify(logs);
      } catch (e) {
        activity = '';
      }
      return {
        agentId: info.Id ?? agentId,
        status: String(info.Status || '').toLowerCase(),
        provider: info.Provider ?? null,
        model: info.Model ?? null,
        mode: info.Mode ?? null,
        cwd: info.Cwd ?? null,
        updatedAt: info.UpdatedAt ?? null,
        pendingPermissions: (info.PendingPermissions ?? []).map((p) => ({ id: p.id ?? p.Id, tool: p.tool ?? p.Tool ?? p.name ?? null, description: p.description ?? p.Description ?? null })),
        usage: info.LastUsage ?? null,
        activity: String(activity).slice(-8000),
      };
    },
    /** Answer a permission request. Only the person decides these, from the panel. */
    permit({ agentId, requestId, allow }, signal) {
      return run(['permit', allow ? 'allow' : 'deny', agentId, requestId], { signal });
    },
    /** Stop an agent. */
    stop({ agentId }, signal) {
      return run(['stop', agentId], { signal });
    },
  };
}

const slug = (s) => String(s).replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'task';

function currentBranch(cwd, exec) {
  return new Promise((resolve) => {
    exec('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd, timeout: 10_000 }, (error, stdout) => {
      const name = error ? '' : String(stdout).trim();
      resolve(name && name !== 'HEAD' ? name : undefined);
    });
  });
}

function parseJson(stdout, stderr) {
  const text = String(stdout);
  const start = text.search(/[[{]/);
  if (start >= 0) {
    try {
      return JSON.parse(text.slice(start));
    } catch {
      /* not JSON: fall through */
    }
  }
  return text.trim() || String(stderr).trim();
}
