// One-time import of the current Autodos board (~/.autodos/db.json) into the ledger.
// The JSON file is only read, never changed, so the old Autodos keeps running beside the plugin.
//
// What becomes what:
//   projects       -> project
//   agents (roles) -> staff (kind: 'role')
//   workers        -> machine
//   requirements   -> requirement
//   todos          -> task, plus its thread (where it ran), outputs (branch, PR, evidence),
//                     an open decision when it waits on the person, and one event per message
//   chief messages -> chat.message events (the main conversation)
//   rules          -> rule
//   settings       -> settings
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { taskState } from './board.js';

/** Where the old board lives: AUTODOS_DATA, else ~/.autodos (or ~/.crewboard from before the rename). */
export function autodosDataFile(env = process.env) {
  const dir = env.AUTODOS_DATA || env.CREWBOARD_DATA;
  if (dir) return path.join(dir, 'db.json');
  const cur = path.join(os.homedir(), '.autodos', 'db.json');
  const old = path.join(os.homedir(), '.crewboard', 'db.json');
  return !fs.existsSync(cur) && fs.existsSync(old) ? old : cur;
}

const pick = (o, keys) => Object.fromEntries(keys.filter((k) => o[k] !== undefined && o[k] !== null && o[k] !== '').map((k) => [k, o[k]]));
const at = (...xs) => xs.find((x) => typeof x === 'string' && x) || new Date(0).toISOString();

/** Text of a todo message, whatever shape it has. */
function messageText(m) {
  if (typeof m === 'string') return m;
  return String(m.text ?? m.content ?? m.body ?? '').slice(0, 20000);
}

/** Who said a message: the person, the lead, an agent, or the system. */
function messageActor(m, task) {
  const r = String(m.role || m.from || m.kind || '').toLowerCase();
  if (r === 'user' || r === 'you' || r === 'human' || r === 'owner') return 'you';
  if (r === 'lead' || r === 'chief') return 'lead';
  if (r === 'system' || r === 'event' || r === 'log') return 'system';
  return task.agentId ? `staff:${task.agentId}` : 'agent';
}

/** What a waiting task waits on the person for, in words. */
export function waitingFor(t) {
  if (t.phase === 'confirm') return t.plan ? 'Confirm the plan' : 'Confirm before it starts';
  if (t.phase === 'asking') return t.question || t.leadAsk || 'Answer a question';
  if (t.phase === 'review') return t.gateReason || 'Review the change';
  if (t.leadHold || t.leadPending) return t.leadAsk || t.question || 'The lead is holding it for you';
  return null;
}

/**
 * Import an Autodos db.json object into an empty ledger.
 * @param {import('./store.js').Ledger} ledger
 * @param {object} data the parsed db.json
 * @param {{source?: string}} opts
 * @returns counts of what was imported
 */
export function importAutodos(ledger, data, { source = 'db.json' } = {}) {
  const done = ledger.meta('imported');
  if (done) throw new Error(`already imported from ${done.source} at ${done.at}`);
  const counts = { project: 0, staff: 0, machine: 0, requirement: 0, task: 0, thread: 0, output: 0, decision: 0, message: 0, chat: 0, rule: 0 };
  const meta = { actor: 'import', reason: `imported from ${source}` };

  ledger.transaction(() => {
    for (const p of data.projects || []) {
      ledger.create('project', { id: p.id, ...p, source: 'autodos' }, { ...meta, at: at(p.createdAt, p.updatedAt) });
      counts.project++;
    }
    for (const a of data.agents || []) {
      ledger.create('staff', { id: a.id, kind: 'role', name: a.name, role: a.role || '', runtime: a.runtime || 'auto', model: a.model || '', color: a.color || '', machine: 'local' }, meta);
      counts.staff++;
    }
    const workers = Array.isArray(data.workers) ? data.workers : Array.isArray(data.machines) ? data.machines : [];
    ledger.create('machine', { id: 'local', name: os.hostname(), local: true, executor: 'autodos' }, meta);
    counts.machine++;
    for (const w of workers) {
      if (!w?.id || w.id === 'local') continue;
      ledger.create('machine', { id: w.id, name: w.name || w.host || w.id, local: false, executor: 'autodos-worker', ...pick(w, ['host', 'platform', 'lastSeenAt', 'runtimes']) }, { ...meta, at: at(w.createdAt, w.lastSeenAt) });
      counts.machine++;
    }
    for (const r of data.requirements || []) {
      ledger.create('requirement', { id: r.id, ...r }, { ...meta, at: at(r.createdAt, r.updatedAt) });
      counts.requirement++;
    }

    for (const t of data.todos || []) {
      const state = taskState(t);
      const machine = t.sessionMachine || t.remoteJob?.workerId || 'local';
      const task = {
        id: t.id,
        number: t.number,
        title: t.title || 'Untitled',
        description: t.description || '',
        projectId: t.projectId || null,
        goalId: null,
        requirementId: t.requirementId || null,
        staffId: t.agentId || null,
        machine,
        runtime: t.runtime || null,
        state,
        phase: t.phase,
        waitingFor: state === 'waiting_you' ? waitingFor(t) : null,
        stuck: t.error ? String(t.error).slice(0, 500) : null,
        labels: t.labels || [],
        ...pick(t, ['ref', 'mode', 'stage', 'revision', 'leadRounds', 'scheduleId', 'ruleId', 'topicId', 'backlogKey']),
        lastProgressAt: at(t.updatedAt, t.movedAt, t.createdAt),
        dependsOn: [],
        source: 'autodos',
      };
      ledger.create('task', task, { ...meta, at: at(t.createdAt) });
      counts.task++;

      if (t.sessionId || t.worktree || t.branch) {
        ledger.create('thread', {
          taskId: t.id,
          machine,
          runtime: t.runtime || null,
          executor: t.remoteJob ? 'autodos-worker' : 'autodos',
          sessionId: t.sessionId || null,
          worktree: t.worktree || null,
          branch: t.branch || null,
          base: t.base || null,
          cost: t.sessionCost ?? null,
          open: !['done', 'failed', 'dropped'].includes(state),
        }, { ...meta, task: t.id, at: at(t.createdAt) });
        counts.thread++;
      }

      const outputs = [];
      if (t.branch && (t.mergeLanded || t.phase === 'done')) outputs.push({ type: 'change', title: `Branch ${t.branch}`, ref: t.branch, landed: !!t.mergeLanded, diffStat: t.diffStat || null });
      const pr = t.pr || t.prUrl || t.prFeedback?.url;
      if (pr) outputs.push({ type: 'pull-request', title: `Pull request for #${t.number}`, url: typeof pr === 'string' ? pr : pr.url || null });
      for (const e of Array.isArray(t.evidence) ? t.evidence : []) outputs.push({ type: 'evidence', title: e.name || e.title || e.file || 'Evidence', ref: e.file || e.path || e.url || null, kind: e.kind || null });
      for (const o of outputs) {
        ledger.create('output', { taskId: t.id, projectId: t.projectId || null, seen: t.phase === 'done', ...o }, { ...meta, task: t.id, at: at(t.updatedAt) });
        counts.output++;
      }

      if (state === 'waiting_you') {
        ledger.create('decision', {
          taskId: t.id,
          question: task.waitingFor,
          options: t.phase === 'confirm' ? ['Go ahead', 'Change the plan'] : t.phase === 'review' ? ['Accept', 'Send back'] : [],
          reversible: t.phase !== 'review',
          open: true,
          decidedBy: null,
        }, { ...meta, task: t.id, at: at(t.updatedAt) });
        counts.decision++;
      }

      for (const m of t.messages || []) {
        const text = messageText(m);
        if (!text) continue;
        ledger.record('thread.message', { text, role: m.role || null, kind: m.kind || null }, { actor: messageActor(m, t), task: t.id, at: at(m.at, m.createdAt, t.createdAt), reason: meta.reason });
        counts.message++;
      }
      ledger.record('task.imported', { phase: t.phase, state }, { ...meta, task: t.id, at: at(t.updatedAt, t.createdAt) });
    }

    for (const m of data.chief || []) {
      const text = messageText(m);
      if (!text) continue;
      ledger.record('chat.message', { text, topicId: m.topicId || null, todoIds: m.todoIds || m.todos || undefined }, { actor: m.role === 'user' ? 'you' : 'lead', at: at(m.at, m.createdAt), reason: meta.reason });
      counts.chat++;
    }
    for (const r of data.rules || []) {
      ledger.create('rule', { id: r.id, ...r }, { ...meta, at: at(r.createdAt) });
      counts.rule++;
    }
    if (data.settings) ledger.create('settings', { id: 'autodos', ...data.settings }, meta);

    ledger.meta('imported', { source, at: new Date().toISOString(), counts });
  });
  return counts;
}

/** Read db.json from disk (read-only) and import it. Returns counts, or null when there is no board. */
export function importAutodosFile(ledger, file = autodosDataFile()) {
  if (!fs.existsSync(file)) return null;
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  return importAutodos(ledger, data, { source: file });
}
