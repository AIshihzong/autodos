// Pull-request delivery: Done pushes the todo branch and opens a PR with the gh CLI; CI failures and
// review comments come back to the same todo as outside events until the PR is merged or closed.
import { execFile } from 'node:child_process';
import { childEnv } from './runtimes.js';
import { git, commitAll, removeWorktree, baseOf } from './git.js';

export function gh(cwd, args) {
  return new Promise((resolve, reject) => {
    execFile('gh', args, { cwd, env: childEnv(), timeout: 60_000, maxBuffer: 10 * 1024 * 1024 }, (err, out, errOut) => {
      if (err) reject(new Error((errOut || err.message).trim().split('\n').slice(-3).join(' ')));
      else resolve(out.trim());
    });
  });
}

// A cancelled run (a newer push replaced it, someone stopped it) says nothing about the code.
const FAILED = new Set(['FAILURE', 'ERROR', 'TIMED_OUT', 'ACTION_REQUIRED', 'STARTUP_FAILURE']);

/** The title a pull request gets: the project's template ({ref}, {number}, {title}), else the todo's title. */
export function prTitle(template, t) {
  const out = String(template || '{title}').replace(/\{title\}/g, t.title).replace(/\{number\}/g, t.number).replace(/\{ref\}/g, t.ref || `#${t.number}`).replace(/\s+/g, ' ').trim();
  return (out || t.title).slice(0, 240);
}

/** New feedback in a PR view: failing checks and review comments we haven't passed on yet. */
export function prFeedback(view, seen = []) {
  const known = new Set(seen);
  const items = [];
  for (const c of view.statusCheckRollup || []) {
    const verdict = c.conclusion || c.state || '';
    if (!FAILED.has(String(verdict).toUpperCase())) continue;
    const key = `check:${c.name || c.context}:${c.completedAt || c.startedAt || verdict}`;
    if (known.has(key)) continue;
    const link = c.detailsUrl || c.targetUrl || '';
    items.push({ key, text: `CI check "${c.name || c.context}" ${String(verdict).toLowerCase()}${link ? ` (${link})` : ''}`, run: link.match(/\/actions\/runs\/(\d+)/)?.[1] || '' });
  }
  for (const r of view.reviews || []) {
    if (!r.body?.trim() && r.state !== 'CHANGES_REQUESTED') continue;
    const key = `review:${r.id || `${r.author?.login}:${r.submittedAt}`}`;
    if (known.has(key)) continue;
    items.push({ key, text: `Review by ${r.author?.login || 'someone'} (${String(r.state || '').toLowerCase().replace('_', ' ')}):\n${r.body || ''}` });
  }
  for (const c of view.reviewComments || []) {
    if (!c.body?.trim()) continue;
    const key = `line:${c.id}`;
    if (known.has(key)) continue;
    items.push({ key, text: `Comment by ${c.user?.login || 'someone'} on ${c.path}${c.line || c.original_line ? `:${c.line || c.original_line}` : ''}:\n${c.body}` });
  }
  for (const c of view.comments || []) {
    if (!c.body?.trim()) continue;
    const key = `comment:${c.id || `${c.author?.login}:${c.createdAt}`}`;
    if (known.has(key)) continue;
    items.push({ key, text: `Comment by ${c.author?.login || 'someone'}:\n${c.body}` });
  }
  return items;
}

export class Delivery {
  constructor(store, runner) {
    this.store = store;
    this.runner = runner;
    this.busy = new Set();
    this.timer = setInterval(() => this.pollAll().catch(() => {}), 60_000);
  }

  close() {
    clearInterval(this.timer);
  }

  /** Push the branch (lease-protected) and open the PR the first time. */
  async ship(t) {
    const project = this.store.project(t.projectId);
    if (!project || !t.worktree) throw new Error('Pull requests need a git project with a worktree');
    const base = t.pr?.base || t.base || (await baseOf(project.path, project));
    await commitAll(t.worktree, `#${t.number} ${t.title}`);
    const remoteSha = (await git(t.worktree, ['ls-remote', 'origin', `refs/heads/${t.branch}`]).catch(() => '')).split(/\s+/)[0] || '';
    await git(t.worktree, ['push', `--force-with-lease=refs/heads/${t.branch}:${remoteSha}`, 'origin', `HEAD:refs/heads/${t.branch}`]);
    if (t.pr) {
      // A PR that was closed or already merged can't take this work: open a fresh one.
      const state = JSON.parse(await gh(project.path, ['pr', 'view', String(t.pr.number), '--json', 'state'])).state;
      if (state !== 'OPEN') {
        this.runner.addMessage(t, 'system', `${t.pr.url} is ${String(state).toLowerCase()}; opening a new pull request.`);
        t.pr = null;
      }
    }
    if (!t.pr) {
      const body = [
        t.description || '',
        t.checks ? `Checks: ${t.checks.passed ? 'passed' : 'failing'} (${t.checks.results.map((r) => r.command).join(', ')})` : '',
        t.review ? `AI review by ${t.review.reviewer}: ${t.review.summary || ''}` : '',
        `Filed by Autodos as #${t.number}.`,
      ]
        .filter(Boolean)
        .join('\n\n');
      const url = (await gh(project.path, ['pr', 'create', '--head', t.branch, '--base', base, '--title', prTitle(project.prTitle, t), '--body', body])).split('\n').pop();
      const number = Number(url.match(/\/pull\/(\d+)/)?.[1]);
      if (!number) throw new Error(`gh did not return a pull request URL: ${url}`);
      t.pr = { number, url, base, seen: [] };
    }
    this.runner.addMessage(t, 'system', `Pushed ${t.branch} to ${t.pr.url}. Waiting for CI and review.`);
    this.runner.setPhase(t, 'shipping');
    this.store.changed();
  }

  async pollAll() {
    for (const t of this.store.data.todos) if (t.phase === 'shipping' && t.pr) await this.poll(t).catch((e) => (t.prError = e.message));
  }

  async poll(t) {
    if (this.busy.has(t.id)) return;
    this.busy.add(t.id);
    try {
      const project = this.store.project(t.projectId);
      if (!project) return;
      const view = JSON.parse(await gh(project.path, ['pr', 'view', String(t.pr.number), '--json', 'state,url,reviews,comments,statusCheckRollup']));
      // Comments on code lines live in a different API than the conversation.
      view.reviewComments = await gh(project.path, ['api', `repos/{owner}/{repo}/pulls/${t.pr.number}/comments`]).then((x) => JSON.parse(x || '[]'), () => []);
      t.pr.state = view.state;
      t.prError = null;
      if (t.phase !== 'shipping') return;
      if (view.state === 'MERGED') {
        this.runner.addMessage(t, 'system', `${t.pr.url} was merged.`);
        if (t.worktree) await removeWorktree(project.path, t.worktree, t.branch, true);
        t.worktree = null;
        this.runner.setPhase(t, 'done');
      } else if (view.state === 'CLOSED') {
        this.runner.addMessage(t, 'system', `${t.pr.url} was closed without merging.`);
        this.runner.setPhase(t, 'closed');
      } else {
        const fresh = prFeedback(view, t.pr.seen);
        // A failed check alone only says "red": bring the failing part of its log, so the agent can fix it without guessing.
        const logs = new Map();
        for (const f of fresh) {
          if (!f.run || logs.size >= 3) continue;
          if (!logs.has(f.run)) logs.set(f.run, await gh(project.path, ['run', 'view', f.run, '--log-failed']).then((x) => x.slice(-4000), () => ''));
          if (logs.get(f.run)) f.text += `\nThe end of the failing log:\n${logs.get(f.run)}`;
          logs.set(f.run, ''); // one copy per run, even when several of its jobs failed
        }
        if (fresh.length) {
          t.pr.seen = [...t.pr.seen, ...fresh.map((f) => f.key)].slice(-300);
          t.prFeedback = true;
          // From outside the app, so passed on as data; the agent fixes, then the branch is pushed again.
          this.runner.eventNote(t, `Feedback on ${t.pr.url}:\n\n${fresh.map((f) => f.text).join('\n\n')}`);
        }
      }
      this.store.changed();
    } finally {
      this.busy.delete(t.id);
    }
  }
}
