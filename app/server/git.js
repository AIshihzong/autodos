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

export const WHO = ['-c', 'user.name=Autodos', '-c', 'user.email=autodos@localhost'];
const sha = (repo, ref) => git(repo, ['rev-parse', '-q', '--verify', ref]).catch(() => '');

/**
 * Put one file on a branch of its own (a tree holding only that file), on top of what the branch has, without
 * touching any checkout. Used for the team report. Never forces: a push that is refused is an error.
 */
export async function commitFileToBranch(repo, branch, file, text, message, { remote = 'origin', push = false } = {}) {
  if (!(await validBranch(repo, branch))) throw new Error(`"${branch}" is not a usable branch name`);
  if (!file || path.isAbsolute(file) || file.split(/[\\/]/).includes('..')) throw new Error('The report file must be a path inside the repository');
  const dir = await git(repo, ['rev-parse', '--absolute-git-dir']);
  const tmp = path.join(dir, `autodos-report-${process.pid}-${Date.now()}`);
  const index = `${tmp}.index`;
  const withIndex = (args) =>
    new Promise((resolve, reject) => {
      execFile('git', args, { cwd: repo, env: { ...childEnv(), GIT_INDEX_FILE: index }, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => (err ? reject(new Error((stderr || err.message).trim())) : resolve(stdout.trim())));
    });
  try {
    fs.writeFileSync(tmp, text);
    const blob = await git(repo, ['hash-object', '-w', tmp]);
    await withIndex(['read-tree', '--empty']);
    await withIndex(['update-index', '--add', '--cacheinfo', `100644,${blob},${file}`]);
    const tree = await withIndex(['write-tree']);
    if (push) await git(repo, ['fetch', '--quiet', remote, `+refs/heads/${branch}:refs/remotes/${remote}/${branch}`]).catch(() => {});
    const parent = (push && (await sha(repo, `refs/remotes/${remote}/${branch}`))) || (await sha(repo, `refs/heads/${branch}`));
    if (parent && (await git(repo, ['rev-parse', `${parent}^{tree}`])) === tree) return { sha: parent, changed: false };
    const commit = await git(repo, [...WHO, 'commit-tree', tree, ...(parent ? ['-p', parent] : []), '-m', message]);
    await git(repo, ['update-ref', `refs/heads/${branch}`, commit]);
    if (push) await git(repo, ['push', '--quiet', remote, `refs/heads/${branch}:refs/heads/${branch}`]);
    return { sha: commit, changed: true };
  } finally {
    for (const f of [tmp, index]) fs.rmSync(f, { force: true });
  }
}

/** A name git accepts for a branch, and that is safe to pass on a command line. */
export async function validBranch(repo, name) {
  if (!name || /^-|\s/.test(name)) return false;
  return git(repo, ['check-ref-format', '--branch', name]).then(
    () => true,
    () => false,
  );
}

/**
 * The branch a project's work starts from and lands on: project.baseBranch, else whatever the main
 * checkout has. A base that only exists on origin so far gets its local branch here.
 */
export async function baseOf(repo, project) {
  const name = String(project?.baseBranch || '').trim();
  if (!name) return git(repo, ['rev-parse', '--abbrev-ref', 'HEAD']);
  if (!(await validBranch(repo, name))) throw new Error(`"${name}" is not a valid base branch name`);
  if (await sha(repo, `refs/heads/${name}`)) return name;
  if (!(await sha(repo, `refs/remotes/origin/${name}`))) await git(repo, ['fetch', '--quiet', 'origin', `+refs/heads/${name}:refs/remotes/origin/${name}`]).catch(() => {});
  if (!(await sha(repo, `refs/remotes/origin/${name}`))) throw new Error(`Base branch "${name}" exists neither in ${repo} nor on its origin`);
  await git(repo, ['branch', '--track', name, `origin/${name}`]);
  return name;
}

/** How git names a base: a branch, or HEAD for a checkout that is on no branch. */
export const baseRef = (base) => (!base || base === 'HEAD' ? 'HEAD' : `refs/heads/${base}`);

const REF = /^\[?([A-Za-z][A-Za-z0-9]*-\d+(?:-\d+)*)\]?(?=[\s:：.，,)]|$)/;
/** A reference like AP-041 or [BUG-12] at the start of a title, or ''. */
export const refOf = (title) => String(title || '').trim().match(REF)?.[1] || '';

/**
 * The branch name for a todo, from the project's template. {number} is the todo number, {ref} its reference
 * (todo-N when it has none), {slug} its title in ASCII without the reference. A title with nothing to slug
 * (Chinese, say) drops {slug} together with the separator in front of it, so names stay tidy.
 */
export function branchName(template, t) {
  const clean = (x, max) => String(x || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, max).replace(/-+$/, '');
  const given = String(t.ref || '').trim();
  const ref = given.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^[-.]+|[-.]+$/g, '') || `todo-${t.number}`;
  const title = String(t.title || '').trim();
  const slug = clean(given && title.toLowerCase().startsWith(given.toLowerCase()) ? title.slice(given.length) : title.replace(/^\[[^\]]*\]/, ''), 40);
  const tpl = String(template || '').trim() || 'autodos/todo-{number}';
  return (slug ? tpl : tpl.replace(/[-_.]?\{slug\}/g, '')).replace(/\{number\}/g, t.number).replace(/\{slug\}/g, slug).replace(/\{ref\}/g, ref).replace(/\/+$/, '') || `autodos/todo-${t.number}`;
}

/** Where a branch is checked out (the main checkout or a worktree), or '' when nowhere. */
export async function checkoutOf(repo, branch) {
  const out = await git(repo, ['worktree', 'list', '--porcelain']);
  let dir = '';
  for (const line of out.split('\n')) {
    if (line.startsWith('worktree ')) dir = line.slice(9);
    else if (line === `branch refs/heads/${branch}`) return dir;
  }
  return '';
}

/**
 * Create (or reuse) a worktree for a todo. Returns { dir, branch, created } or null if not a git repo.
 * `branch` is the name to use for a new one, `base` what it starts from (default: the main checkout's HEAD).
 * `own` says the todo already had this branch; a name that exists but is not its own is never shared.
 */
export async function ensureWorktree(repo, baseDir, number, { branch = `autodos/todo-${number}`, base = '', own = true } = {}) {
  if (!(await isGitRepo(repo))) return null;
  const dir = path.join(baseDir, `todo-${number}`);
  if (fs.existsSync(dir)) {
    // Left from an earlier run: keep whatever branch it is on.
    const cur = await git(dir, ['rev-parse', '--abbrev-ref', 'HEAD']).catch(() => '');
    return { dir, branch: cur && cur !== 'HEAD' ? cur : branch, created: false };
  }
  if (!(await validBranch(repo, branch))) throw new Error(`"${branch}" is not a valid branch name; check the project's branch template`);
  fs.mkdirSync(baseDir, { recursive: true });
  let exists = await sha(repo, `refs/heads/${branch}`);
  if (exists && !own) {
    branch = `${branch}-${number}`;
    exists = await sha(repo, `refs/heads/${branch}`);
  }
  await git(repo, exists ? ['worktree', 'add', dir, branch] : ['worktree', 'add', '-b', branch, dir, ...(base && base !== 'HEAD' ? [base] : [])]);
  return { dir, branch, created: true };
}

/** Commit anything the agent left uncommitted in the worktree. Returns true if a commit was made. */
export async function commitAll(dir, message) {
  await git(dir, ['add', '-A']);
  const status = await git(dir, ['status', '--porcelain']);
  if (!status) return false;
  await git(dir, ['-c', 'user.name=Autodos', '-c', 'user.email=autodos@localhost', 'commit', '-m', message]);
  return true;
}

const DIFF_CUT = '\n… (diff truncated)';
export const diffTruncated = (diff) => String(diff || '').endsWith(DIFF_CUT);

/** Full unified diff of the todo branch against its base (default: the main checkout's branch), capped in size. */
export async function diffText(repo, branch, { base = '', limit = 100_000 } = {}) {
  try {
    const from = base || (await git(repo, ['rev-parse', '--abbrev-ref', 'HEAD']));
    const out = await git(repo, ['diff', '--no-color', '--no-ext-diff', `${from}...${branch}`]);
    return out.length > limit ? out.slice(0, limit) + DIFF_CUT : out;
  } catch {
    return '';
  }
}

export async function diffStat(repo, branch, base = '') {
  try {
    const from = base || (await git(repo, ['rev-parse', '--abbrev-ref', 'HEAD']));
    return await git(repo, ['diff', '--stat', `${from}...${branch}`]);
  } catch {
    return '';
  }
}

/** Every file the todo branch changes against its base (names only, so no size cap cuts it short). Throws if git can't tell. */
export async function diffFiles(repo, branch, base = '') {
  const from = base || (await git(repo, ['rev-parse', '--abbrev-ref', 'HEAD']));
  return (await git(repo, ['diff', '--name-only', `${from}...${branch}`])).split('\n').filter(Boolean);
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

/**
 * Land a commit on the base branch. Where the base is checked out (usually the main checkout) this is an
 * ordinary merge there. A base nobody has checked out is moved directly, and only if it is still at
 * `expect`, so nothing that arrived in between is lost.
 */
export async function landBranch(repo, base, branch, message, expect = '') {
  if (!base || base === 'HEAD') return mergeBranch(repo, branch, message);
  const where = await checkoutOf(repo, base);
  if (where) return mergeBranch(where, branch, message);
  const baseSha = await git(repo, ['rev-parse', `refs/heads/${base}`]);
  if (expect && expect !== baseSha) throw new Error(`${base} moved while this was being checked`);
  const tip = await git(repo, ['rev-parse', `${branch}^{commit}`]);
  const contains = await git(repo, ['merge-base', '--is-ancestor', baseSha, tip]).then(
    () => true,
    () => false,
  );
  if (!contains) throw new Error(`${branch} does not contain the latest ${base}`);
  // The branch already holds the merged result, so its tree is what the merge commit records.
  const commit = await git(repo, [...WHO, 'commit-tree', `${tip}^{tree}`, '-p', baseSha, '-p', tip, '-m', message]);
  await git(repo, ['update-ref', '-m', `autodos: ${message}`, `refs/heads/${base}`, commit, baseSha]);
}

/** Move the base branch forward to a commit that already contains it (no merge commit). */
export async function fastForward(repo, base, commit, expect) {
  const where = await checkoutOf(repo, base);
  if (where) {
    if (await mergeInProgress(where)) throw new Error('The project already has a merge in progress. Finish or abort it first.');
    return git(where, ['merge', '--ff-only', commit]);
  }
  await git(repo, ['update-ref', '-m', 'autodos: fast-forward', `refs/heads/${base}`, commit, expect]);
}

export async function removeWorktree(repo, dir, branch, deleteBranch) {
  await git(repo, ['worktree', 'remove', '--force', dir]).catch(() => {});
  if (deleteBranch) await git(repo, ['branch', '-D', branch]).catch(() => {});
}
