// Landing: run the project's check in the task's worktree, then merge the task branch into its base.
// Merges never touch a working tree that has uncommitted changes, and never force anything:
// a dirty base checkout or a conflict stops and says why.
import { execFile } from 'node:child_process';

export function createGit({ exec = execFile, timeoutMs = 120_000 } = {}) {
  const run = (cwd, args, { ok = [0] } = {}) =>
    new Promise((resolve) => {
      exec('git', args, { cwd, timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 }, (error, stdout = '', stderr = '') => {
        const code = error ? (typeof error.code === 'number' ? error.code : 1) : 0;
        resolve({ code, ok: ok.includes(code), out: String(stdout).trim(), err: String(stderr).trim() });
      });
    });

  async function currentBranch(cwd) {
    const r = await run(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']);
    return r.ok && r.out && r.out !== 'HEAD' ? r.out : null;
  }

  /** Which worktree, if any, has `branch` checked out. */
  async function checkoutOf(repo, branch) {
    const r = await run(repo, ['worktree', 'list', '--porcelain']);
    if (!r.ok) return null;
    let path = null;
    for (const line of r.out.split('\n')) {
      if (line.startsWith('worktree ')) path = line.slice(9);
      else if (line === `branch refs/heads/${branch}`) return path;
    }
    return null;
  }

  /**
   * Merge `branch` into `base` in repository `repo`.
   * @returns {{ok: true, commit: string, how: string} | {ok: false, reason: 'missing'|'dirty'|'conflict'|'error', detail: string}}
   */
  async function merge({ repo, branch, base, message }) {
    for (const b of [branch, base]) {
      const v = await run(repo, ['rev-parse', '--verify', '--quiet', `refs/heads/${b}`]);
      if (!v.ok) return { ok: false, reason: 'missing', detail: `branch ${b} does not exist` };
    }
    const ahead = await run(repo, ['rev-list', '--count', `${base}..${branch}`]);
    if (ahead.ok && ahead.out === '0') return { ok: false, reason: 'missing', detail: `${branch} has no commits that ${base} lacks` };
    const msg = message || `Merge ${branch} into ${base}`;
    const at = await checkoutOf(repo, base);
    if (at) {
      const dirty = await run(at, ['status', '--porcelain', '--untracked-files=no']);
      if (!dirty.ok) return { ok: false, reason: 'error', detail: dirty.err };
      if (dirty.out) return { ok: false, reason: 'dirty', detail: `${base} is checked out at ${at} with uncommitted changes:\n${dirty.out.slice(0, 1000)}` };
      const m = await run(at, ['merge', '--no-ff', '--no-edit', '-m', msg, branch]);
      if (!m.ok) {
        await run(at, ['merge', '--abort']);
        return { ok: false, reason: 'conflict', detail: (m.out + '\n' + m.err).trim().slice(-2000) };
      }
      const head = await run(at, ['rev-parse', 'HEAD']);
      return { ok: true, commit: head.out, how: `merged in ${at}` };
    }
    // Base is not checked out anywhere: build the merge commit without a working tree.
    const tree = await run(repo, ['merge-tree', '--write-tree', base, branch], { ok: [0, 1] });
    if (tree.code === 1) return { ok: false, reason: 'conflict', detail: tree.out.split('\n').slice(1).join('\n').slice(0, 2000) };
    if (!tree.ok) return { ok: false, reason: 'error', detail: tree.err || tree.out };
    const oldBase = (await run(repo, ['rev-parse', base])).out;
    const oldBranch = (await run(repo, ['rev-parse', branch])).out;
    const commit = await run(repo, ['commit-tree', tree.out.split('\n')[0], '-p', oldBase, '-p', oldBranch, '-m', msg]);
    if (!commit.ok) return { ok: false, reason: 'error', detail: commit.err };
    const upd = await run(repo, ['update-ref', `refs/heads/${base}`, commit.out, oldBase]);
    if (!upd.ok) return { ok: false, reason: 'error', detail: upd.err };
    return { ok: true, commit: commit.out, how: 'merged without a checkout' };
  }

  return { run, currentBranch, checkoutOf, merge };
}

/** Run a project's check command (e.g. "npm test") in a directory. */
export function runCheck({ cwd, command, timeoutMs = 10 * 60_000, exec = execFile }) {
  return new Promise((resolve) => {
    exec('/bin/sh', ['-c', command], { cwd, timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024, env: process.env }, (error, stdout = '', stderr = '') => {
      const output = `${stdout}${stderr ? `\n${stderr}` : ''}`.trim();
      resolve({ ok: !error, code: error ? error.code ?? 1 : 0, output: output.slice(-6000) });
    });
  });
}
