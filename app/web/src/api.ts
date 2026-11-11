import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';

export type Phase = 'todo' | 'queued' | 'planning' | 'confirm' | 'building' | 'asking' | 'review' | 'merging' | 'shipping' | 'done' | 'failed' | 'closed';
export interface Message { hidden?: boolean; id: string; role: 'user' | 'agent' | 'system' | 'event'; text: string; at: string; agentId?: string; kind?: string; error?: boolean; durationMs?: number; pending?: boolean; lead?: boolean }
export interface Todo {
  id: string; number: number; title: string; description: string; labels: string[]; projectId: string | null; agentId: string | null;
  phase: Phase; mode: 'plan' | 'run'; plan: string; planApproved: boolean; messages: Message[]; live: string; runtime?: string;
  worktree?: string | null; branch?: string; diffStat?: string; diff?: string; stage?: 'setup' | 'verifying' | 'fixing' | 'reviewing' | null; base?: string; ref?: string; files?: string[] | null;
  question?: { text: string; options: string[]; at: string; recommend?: string } | null; leadPending?: { gate: string; at: string } | null; leadAsk?: { text: string; options: string[]; recommend: string; why: string; blocks?: string[] } | null; ruleId?: string | null; parentId?: string | null; depth?: number;
  pr?: { number: number; url: string; base: string; state?: string } | null; event?: { source: string; type: string; url: string; text: string } | null;
  checks?: { results: CheckResult[]; passed: boolean; fixes: number; at: string } | null; review?: { reviewer: string; summary: string; findings: Finding[]; at: string } | null; error?: string | null; createdAt: string; updatedAt: string; scheduleId?: string | null;
}
export interface CheckResult { command: string; ok: boolean; code: number; durationMs: number; output: string }
export interface Finding { severity: 'high' | 'medium' | 'low'; file: string; line: number; title: string; detail: string; fix: 'auto' | 'ask'; fixed?: boolean }
export interface MemoryItem { text: string; at: string; todo?: number }
export interface Rule {
  id: string; name: string; enabled: boolean; when: { cron?: string; every?: number; source?: string; types?: string[] };
  agentId?: string | null; projectId?: string | null; mode: 'run' | 'plan'; title: string; prompt: string; tell: 'gates' | 'never';
  nextAt?: string | null; lastAt?: string; runs?: number; pausedUntil?: string; pauseReason?: string; maxOpen?: number; skippedAt?: string | null; fromConfig?: string;
}
export interface Source { id: string; name: string; kind: 'webhook' | 'github' | 'github-poll'; repo?: string; everyMinutes?: number; lastPollAt?: string; lastError?: string | null; createdAt: string; hasKey: boolean }
export interface EventRec { id: string; source: string; sourceName: string; type: string; title: string; url?: string; at: string; todoIds: string[] }
export interface Channel { id: string; name: string; kind: string; url: string; enabled: boolean; hasSecret: boolean; lastError?: string | null; lastSentAt?: string }
export interface Agent { id: string; name: string; role: string; runtime: string; model: string; color: string; machine?: string }
export interface Worker { id: string; name: string; capacity: number; online: boolean; running: number; queued: number; lastSeen?: string; host?: string; runtimes?: string[]; doctor?: { ready: boolean; at: string; items: DoctorItem[] } }
export interface Feishu { bound: boolean; appId: string; brand: 'feishu' | 'lark'; chatId: string; chatName: string; botName: string; status: 'off' | 'connecting' | 'on' | 'error'; error: string; pending: { url: string; expireAt: string } | null }
export type CheckId = 'node' | 'git' | 'claude' | 'codex' | 'gh';
export interface DoctorItem { id: CheckId; need: 'required' | 'agent' | 'optional'; ok: boolean; installed: boolean; signedIn?: boolean; version?: string; account?: string; problem?: string; fix: 'install' | 'login' | null }
export interface FixJob { running: boolean; ok: boolean | null; log: string; command: string }
export interface Doctor { ready: boolean; agent: boolean; items: DoctorItem[]; platform: string; host: string; at: string; jobs: Record<string, FixJob> }
export type FixResult = { kind: 'run' | 'terminal' | 'manual' | 'none'; command?: string } | { kind: 'link'; url: string };
export interface Retro { days: number; created: number; done: number; open: number; runs: number; failedRuns: number; agentMs: number; usd: number; unpricedRuns: number; tokens: number; reworkRate: number; checksFirstPass: number | null; findings: { high: number; medium: number; low: number }; conflicts: number; medianLeadMs: number | null; reworked: { number: number; title: string; rounds: number }[]; failures: { text: string; count: number }[] }
export interface Upstream { url: string; branch: string; every: number; mirror?: boolean; lastAt?: string; lastResult?: string; lastError?: string | null; lastTodo?: number }
export interface Project {
  id: string; name: string; path: string; git?: boolean; checks?: string[]; preview?: string; delivery?: 'merge' | 'pr'; memory?: { decisions: MemoryItem[]; declined: MemoryItem[] };
  baseBranch?: string; branchTemplate?: string; prTitle?: string; setup?: string; pushBase?: boolean; protectedPaths?: string[];
  autopilot?: { accept: boolean; review?: boolean; maxFiles?: number } | null; upstream?: Upstream | null;
  lead?: { decide: boolean; ownerPaths?: string[]; maxRounds?: number } | null; report?: { every?: number; branch?: string; file?: string; last?: string; lastError?: string | null } | null; proof?: { paths?: string[]; how?: string; required?: boolean } | null; analyst?: boolean; confirmRequirements?: boolean; knowledge?: string[]; leadLog?: { at: string; todo: number; title: string; gate: string; decision: string; why: string }[];
  backlog?: { file: string; every?: number; maxOpen?: number; left?: number; lastError?: string | null } | null; configAt?: string; configStale?: boolean; pullError?: string | null;
}
export interface Schedule { id: string; title: string; description: string; projectId?: string | null; agentId?: string | null; everyMinutes: number; enabled: boolean; mode: 'plan' | 'run'; nextAt?: string; lastAt?: string }
export interface ChiefMessage { id: string; role: 'user' | 'chief'; text: string; at: string; todoIds?: string[]; error?: boolean; topicId?: string; requirementId?: string }
export interface Requirement { id: string; number: number; projectId?: string | null; topicId?: string; title: string; problem?: string; scope?: string[]; outOfScope?: string[]; acceptance?: string[]; assumptions?: string[]; todos?: { title: string; agent?: string }[]; todoIds?: string[]; status: 'discussing' | 'confirm' | 'building' | 'done' | 'dropped'; createdAt: string; updatedAt: string }
export interface Topic { id: string; title: string; archived: boolean; createdAt: string; updatedAt: string }
export interface FileEntry { name: string; dir: boolean; path: string }
export interface Commit { hash: string; author: string; date: string; subject: string }
export interface Run { id: string; todoId: string; number: number; agentId?: string; runtime: string; kind: string; ok: boolean; startedAt: string; durationMs: number; inputTokens: number; outputTokens: number; costUsd: number; costKnown?: boolean }
export interface Runtime { id: string; name: string; available: boolean; version: string }
export interface Settings { concurrency: number; defaultRuntime: string; chiefRuntime: string; claudePermissionMode: string; codexSandbox?: string; useWorktrees: boolean; autoStart: boolean; planFirst: boolean; verify: boolean; verifyAttempts: number; reviewer: string; reviewAutoFix: boolean; budgetMinutes: number; budgetUsd: number; publicUrl?: string; delegateDepth: number; delegateChildren: number; steer?: boolean; selfUpdate?: boolean }
export interface UpdateStatus { possible: boolean; enabled: boolean; checkedAt: string; current: string; available: string; count: number; waiting: boolean; error: string; skipped: string; updatedAt: string; from: string; checking?: boolean }
export interface State {
  settings: Settings; projects: Project[]; agents: Agent[]; todos: Todo[]; chief: ChiefMessage[]; requirements?: Requirement[]; chiefBusy: boolean; topics: Topic[]; mcpPath: string;
  workers: Worker[]; pairings: { code: string; words: string[]; host: string; name: string }[]; previews: { todoId: string; url: string; ready: boolean }[]; rules: Rule[]; sources: Source[]; events: EventRec[]; channels: Channel[]; runs: Run[]; runtimes: Runtime[]; dataDir: string; feishu: Feishu;
}

// The desktop app passes its server address in the URL hash; the web build talks to its own origin.
const BASE = new URLSearchParams(location.hash.slice(1)).get('api') || '';

export async function api<T = any>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(BASE + '/api' + path, {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data as T;
}

// ---- a tiny global store fed by server-sent events ----
const doctorListeners = new Set<() => void>();
let state: State | null = null;
let online = false;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());
const liveListeners = new Set<(todoId: string, text: string) => void>();

let refreshing: Promise<void> | null = null;
let again = false;
async function refresh() {
  if (refreshing) {
    again = true;
    return;
  }
  refreshing = api<State>('GET', '/state')
    .then((s) => {
      // A snapshot can be older than live text already streamed in; keep the longer live output.
      for (const t of s.todos) {
        const old = state?.todos.find((x) => x.id === t.id);
        if (old && old.phase === t.phase && old.live && old.live.length > (t.live || '').length && old.live.startsWith(t.live || '')) t.live = old.live;
      }
      state = s;
      emit();
    })
    .catch(() => {})
    .finally(() => {
      refreshing = null;
      if (again) {
        again = false;
        refresh();
      }
    });
}

function connect() {
  const es = new EventSource(BASE + '/api/events');
  es.addEventListener('open', () => {
    online = true;
    emit();
  });
  es.addEventListener('state', () => refresh());
  es.addEventListener('doctor', () => doctorListeners.forEach((l) => l()));
  es.addEventListener('delta', (e) => {
    const { todoId, text } = JSON.parse((e as MessageEvent).data);
    if (state) {
      const t = state.todos.find((x) => x.id === todoId);
      if (t) t.live = (t.live || '') + text;
    }
    liveListeners.forEach((l) => l(todoId, text));
  });
  es.addEventListener('error', () => {
    online = false;
    emit();
  });
}
connect();
refresh();

export function useAppState() {
  return useSyncExternalStore(
    (cb) => (listeners.add(cb), () => listeners.delete(cb)),
    () => state,
  );
}
export function useOnline() {
  return useSyncExternalStore(
    (cb) => (listeners.add(cb), () => listeners.delete(cb)),
    () => online,
  );
}

/** Live output of a running todo, updated on every streamed chunk. */
export function useLive(todo: Todo | undefined) {
  const [text, setText] = useState(todo?.live || '');
  // Resync from every new snapshot too (e.g. after a reconnect), not just when the todo changes.
  useEffect(() => setText(todo?.live || ''), [todo]);
  useEffect(() => {
    if (!todo) return;
    const l = (id: string) => id === todo.id && setText(state?.todos.find((x) => x.id === id)?.live || '');
    liveListeners.add(l);
    return () => void liveListeners.delete(l);
  }, [todo?.id, todo?.phase]);
  return text;
}

/**
 * The environment check. Re-runs when asked, when a background fix ends, when the window gets focus
 * (you may have just signed in from a terminal), and every few seconds while `watching` is true.
 */
export function useDoctor(watching = false) {
  const [doctor, setDoctor] = useState<Doctor | null>(null);
  const [checking, setChecking] = useState(false);
  // Only a check the person asked for shows "Checking…"; background re-checks stay quiet.
  const run = useCallback(async (shown: boolean) => {
    if (shown) setChecking(true);
    try {
      setDoctor(await api<Doctor>('GET', '/doctor'));
    } catch {
    } finally {
      if (shown) setChecking(false);
    }
  }, []);
  const check = useCallback(() => run(true), [run]);
  const quiet = useCallback(() => run(false), [run]);
  useEffect(() => {
    check();
    doctorListeners.add(quiet);
    window.addEventListener('focus', quiet);
    return () => (doctorListeners.delete(quiet), window.removeEventListener('focus', quiet));
  }, [check, quiet]);
  const busy = watching || Object.values(doctor?.jobs || {}).some((j) => j.running);
  useEffect(() => {
    if (!busy) return;
    const timer = setInterval(quiet, 3000);
    return () => clearInterval(timer);
  }, [busy, quiet]);
  return { doctor, checking, check, refresh: quiet };
}

export const actions = {
  fixCheck: (id: CheckId) => api<FixResult>('POST', `/doctor/${id}/fix`, {}),
  say: (text: string, projectId?: string | null, topicId?: string | null) => api('POST', '/chief', { text, projectId, topicId }),
  confirmRequirement: (id: string) => api('POST', `/requirements/${id}/confirm`, {}),
  dropRequirement: (id: string) => api('POST', `/requirements/${id}/drop`, {}),
  newTopic: () => api<Topic>('POST', '/topics', {}),
  updateTopic: (id: string, patch: Partial<Topic>) => api<Topic>('PATCH', `/topics/${id}`, patch),
  deleteTopic: (id: string) => api('DELETE', `/topics/${id}`),
  projectFiles: (id: string, dir = '') => api<FileEntry[]>('GET', `/projects/${id}/files?dir=${encodeURIComponent(dir)}`),
  projectFile: (id: string, path: string) => api<{ path: string; size: number; binary: boolean; truncated: boolean; text: string }>('GET', `/projects/${id}/file?path=${encodeURIComponent(path)}`),
  detectPreview: (id: string) => api<{ command: string }>('GET', `/projects/${id}/detect-preview`),
  startPreview: (id: string) => api<{ url: string }>('POST', `/todos/${id}/preview`, {}),
  stopPreview: (id: string) => api('DELETE', `/todos/${id}/preview`),
  detectChecks: (id: string) => api<string[]>('GET', `/projects/${id}/detect-checks`),
  syncUpstream: (id: string) => api<{ state: string; lastTodo?: number }>('POST', `/projects/${id}/sync`, {}),
  updateStatus: () => api<UpdateStatus>('GET', '/update'),
  updateNow: () => api<UpdateStatus>('POST', '/update', {}),
  loadConfig: (id: string) => api<{ from: string; applied: string[]; rules: number; warnings: string[] }>('POST', `/projects/${id}/load-config`, {}),
  remember: (project: Project, kind: 'decisions' | 'declined', text: string, todo?: number) => api('POST', `/projects/${project.id}/memory`, { kind, text, todo }),
  forget: (project: Project, kind: 'decisions' | 'declined', text: string) => api('DELETE', `/projects/${project.id}/memory`, { kind, text }),
  projectHistory: (id: string) => api<Commit[]>('GET', `/projects/${id}/history`),
  createTodo: (t: Partial<Todo> & { start?: boolean }) => api<Todo>('POST', '/todos', t),
  updateTodo: (id: string, patch: Partial<Todo>) => api('PATCH', `/todos/${id}`, patch),
  deleteTodo: (id: string) => api('DELETE', `/todos/${id}`),
  act: (id: string, action: string, extra: Record<string, unknown> = {}) => api('POST', `/todos/${id}/action`, { action, ...extra }),
  reply: (id: string, text: string) => api('POST', `/todos/${id}/messages`, { text }),
  settings: (patch: Partial<Settings>) => api('PATCH', '/settings', patch),
  saveRule: (r: Partial<Rule>) => (r.id ? api<Rule>('PATCH', `/rules/${r.id}`, r) : api<Rule>('POST', '/rules', r)),
  runRule: (id: string) => api('POST', `/rules/${id}/run`, {}),
  deleteRule: (id: string) => api('DELETE', `/rules/${id}`),
  addSource: (s: { kind: string; name: string; repo?: string; everyMinutes?: number }) => api<Source & { key: string | null; path: string }>('POST', '/sources', s),
  pollSource: (id: string) => api('POST', `/sources/${id}/poll`, {}),
  deleteSource: (id: string) => api('DELETE', `/sources/${id}`),
  addChannel: (c: { kind: string; name: string; url: string; secret?: string }) => api('POST', '/channels', c),
  updateChannel: (id: string, patch: Partial<Channel>) => api('PATCH', `/channels/${id}`, patch),
  testChannel: (id: string) => api('POST', `/channels/${id}/test`, {}),
  feishuBind: () => api('POST', '/feishu/bind', {}),
  feishuCancel: () => api('DELETE', '/feishu/bind'),
  feishuTest: () => api('POST', '/feishu/test', {}),
  feishuReconnect: () => api('POST', '/feishu/reconnect', {}),
  feishuUnbind: () => api('DELETE', '/feishu'),
  deleteChannel: (id: string) => api('DELETE', `/channels/${id}`),
  addWorker: (name: string, capacity: number) => api<{ id: string; key: string }>('POST', '/workers', { name, capacity }),
  pairWorker: () => api<{ code: string }>('POST', '/workers/pair', {}),
  sshWorker: (target: string) => api<{ code: string }>('POST', '/workers/ssh', { target }),
  approvePairing: (code: string) => api('POST', '/workers/approve', { code }),
  rejectPairing: (code: string) => api('POST', '/workers/reject', { code }),
  updateWorker: (id: string, capacity: number) => api('PATCH', `/workers/${id}`, { capacity }),
  deleteWorker: (id: string) => api('DELETE', `/workers/${id}`),
  retro: (days = 7) => api<Retro>('GET', `/retro?days=${days}`),
  save: (kind: 'agents' | 'projects' | 'schedules', item: any) => (item.id ? api('PATCH', `/${kind}/${item.id}`, item) : api('POST', `/${kind}`, item)),
  remove: (kind: 'agents' | 'projects' | 'schedules', id: string) => api('DELETE', `/${kind}/${id}`),
  checkPath: (path: string) => api<{ exists: boolean; git: boolean }>('GET', `/check-path?path=${encodeURIComponent(path)}`),
  rescanRuntimes: () => api('GET', '/runtimes').then(refresh),
};

/** Waiting for the person: at a gate, and not with the project's lead. */
export const needsYou = (x: Todo) => ['confirm', 'asking', 'review', 'failed'].includes(x.phase) && !x.leadPending;

export const COLUMNS: { key: string; phases: Phase[]; drop: Phase; dot: string }[] = [
  { key: 'backlog', phases: ['todo'], drop: 'todo', dot: 'var(--faint)' },
  { key: 'progress', phases: ['queued', 'planning', 'building', 'merging', 'shipping'], drop: 'queued', dot: 'var(--run)' },
  { key: 'needs', phases: ['confirm', 'asking', 'review', 'failed'], drop: 'review', dot: 'var(--warn)' },
  { key: 'done', phases: ['done', 'closed'], drop: 'done', dot: 'var(--ok)' },
];

export function ago(iso: string, lang: string) {
  const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  const rtf = new Intl.RelativeTimeFormat(lang === 'zh' ? 'zh-CN' : 'en', { numeric: 'auto' });
  if (s < 60) return rtf.format(-Math.round(s), 'second');
  if (s < 3600) return rtf.format(-Math.round(s / 60), 'minute');
  if (s < 86400) return rtf.format(-Math.round(s / 3600), 'hour');
  return rtf.format(-Math.round(s / 86400), 'day');
}

export function duration(ms = 0) {
  if (ms < 1000) return `${ms}ms`;
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}
