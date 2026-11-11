// The switch-over after a self-update (selfupdate.js). The process that was running starts this and exits.
// This one waits for it to be gone, starts the new version the same way the old one was started, and checks
// that it answers. When it does not, the previous commit and its built files go back and that version is
// started instead, with a note of what happened. Either way this process ends within about a minute.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { settle, rollback } from './selfupdate.js';

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function start(job, extra) {
  const env = { ...process.env, ...extra, PORT: String(job.port) };
  delete env.AUTODOS_HANDOVER;
  const child = spawn(job.exec, [...job.execArgv, ...job.argv], { cwd: job.cwd, env, detached: true, stdio: 'inherit', windowsHide: true });
  child.unref();
  return child;
}

/** True once the server answers on its port; false when it exits first or stays silent. */
async function comesUp(child, port, timeout) {
  let exited = false;
  child.once('exit', () => (exited = true));
  const until = Date.now() + timeout;
  while (Date.now() < until && !exited) {
    const ok = await fetch(`http://127.0.0.1:${port}/api/state`, { signal: AbortSignal.timeout(3000) }).then((r) => r.ok, () => false);
    if (ok) return true;
    await sleep(500);
  }
  return false;
}

export async function handover(job, { wait = 60_000 } = {}) {
  for (let i = 0; i < 150 && alive(job.pid); i++) await sleep(200);
  if (alive(job.pid)) process.kill(job.pid, 'SIGTERM');
  for (let i = 0; i < 50 && alive(job.pid); i++) await sleep(200);
  const next = start(job, { AUTODOS_UPDATED_FROM: job.from });
  if (await comesUp(next, job.port, wait)) {
    settle(job.repo, job.swaps);
    return true;
  }
  if (next.exitCode === null) next.kill('SIGTERM');
  for (let i = 0; i < 50 && next.exitCode === null && alive(next.pid); i++) await sleep(200);
  if (alive(next.pid)) next.kill('SIGKILL');
  const why = await rollback(job.repo, job.from, job.swaps).then(() => 'it did not answer after starting', (e) => `it did not answer after starting, and the previous version could not be put back (${String(e.message).slice(0, 200)})`);
  console.error(`Autodos: the update to ${job.to.slice(0, 7)} did not come up; ${why}`);
  start(job, { AUTODOS_UPDATE_FAILED: `${job.to}\n${why}` });
  return false;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]) && process.env.AUTODOS_HANDOVER) {
  const job = JSON.parse(process.env.AUTODOS_HANDOVER);
  await handover(job).catch((e) => console.error(`Autodos: the switch-over failed: ${e.message}`));
  process.exit(0);
}
