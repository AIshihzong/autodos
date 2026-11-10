// Minimal git helpers for per-todo worktrees.
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { childEnv } from './runtimes.js';

export function git(cwd, args) {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, env: childEnv(), maxBuffer: 20 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error((stderr || err.message).trim()));
      else resolve(stdout.trim());
    });
  });
}

export async function isGitRepo(dir) {
  try {
    if (!fs.existsSync(dir)) return false;
    await git(dir, ['rev-parse', 'HEAD']);
    return true;
  } catch {
    return false;
  }
}

/** Create (or reuse) a worktree for a todo. Returns { dir, branch } or null if not a git repo. */
export async function ensureWorktree(repo, baseDir, number) {
  if (!(await isGitRepo(repo))) return null;
  const branch = `autodos/todo-${number}`;
  const dir = path.join(baseDir, `todo-${number}`);
  if (fs.existsSync(dir)) return { dir, branch };
  fs.mkdirSync(baseDir, { recursive: true });
  const exists = await git(repo, ['branch', '--list', branch]);
  await git(repo, exists ? ['worktree', 'add', dir, branch] : ['worktree', 'add', '-b', branch, dir]);
  return { dir, branch };
}

/** Commit anything the agent left uncommitted in the worktree. Returns true if a commit was made. */
export async function commitAll(dir, message) {
  await git(dir, ['add', '-A']);
  const status = await git(dir, ['status', '--porcelain']);
  if (!status) return false;
  await git(dir, ['-c', 'user.name=Autodos', '-c', 'user.email=autodos@localhost', 'commit', '-m', message]);
  return true;
}

/** Full unified diff of the todo branch against the main checkout's branch, capped in size. */
export async function diffText(repo, branch, limit = 100_000) {
  try {
    const base = await git(repo, ['rev-parse', '--abbrev-ref', 'HEAD']);
    const out = await git(repo, ['diff', '--no-color', '--no-ext-diff', `${base}...${branch}`]);
    return out.length > limit ? out.slice(0, limit) + '\n… (diff truncated)' : out;
  } catch {
    return '';
  }
}

export async function diffStat(repo, branch) {
  try {
    const base = await git(repo, ['rev-parse', '--abbrev-ref', 'HEAD']);
    return await git(repo, ['diff', '--stat', `${base}...${branch}`]);
  } catch {
    return '';
  }
}

const mergeInProgress = (repo) =>
  git(repo, ['rev-parse', '-q', '--verify', 'MERGE_HEAD']).then(
    () => true,
    () => false,
  );

/** Merge the todo branch into whatever the main checkout has checked out. Never touches a merge it did not start. */
export async function mergeBranch(repo, branch, message) {
  if (await mergeInProgress(repo)) throw new Error('The project already has a merge in progress. Finish or abort it first.');
  try {
    await git(repo, ['-c', 'user.name=Autodos', '-c', 'user.email=autodos@localhost', 'merge', '--no-ff', '-m', message, branch]);
  } catch (e) {
    // Abort only a merge that is ours: MERGE_HEAD must point at the todo branch we just tried to merge.
    const [head, ours] = await Promise.all([git(repo, ['rev-parse', '-q', '--verify', 'MERGE_HEAD']).catch(() => ''), git(repo, ['rev-parse', branch]).catch(() => '-')]);
    if (head && head === ours) await git(repo, ['merge', '--abort']).catch(() => {});
    throw e;
  }
}

export async function removeWorktree(repo, dir, branch, deleteBranch) {
  await git(repo, ['worktree', 'remove', '--force', dir]).catch(() => {});
  if (deleteBranch) await git(repo, ['branch', '-D', branch]).catch(() => {});
}
