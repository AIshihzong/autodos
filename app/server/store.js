// JSON-file store with change notifications. Small, synchronous, crash-safe (write tmp + rename).
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { EventEmitter } from 'node:events';
import crypto from 'node:crypto';

export const id = (prefix) => `${prefix}_${crypto.randomBytes(5).toString('hex')}`;
export const now = () => new Date().toISOString();

const AGENT_COLORS = ['#5b8def', '#e0864b', '#3fb68b', '#b07cf0', '#e05a8a', '#d9b44a'];

export function defaultData() {
  return {
    version: 1,
    seq: 100,
    settings: {
      concurrency: 3,
      defaultRuntime: 'auto',
      chiefRuntime: 'auto',
      claudePermissionMode: 'acceptEdits',
      codexSandbox: 'workspace-write',
      useWorktrees: true,
      autoStart: true,
      planFirst: false,
      verify: true,
      verifyAttempts: 2,
      reviewer: 'auto',
      reviewAutoFix: true,
      mergeAutoResolve: true,
      steer: true,
      delegateDepth: 2,
      delegateChildren: 5,
      budgetMinutes: 30,
      budgetUsd: 3,
    },
    projects: [],
    agents: [
      { id: 'ag_frontend', name: 'Frontend engineer', role: 'UI, pages, styling, components, accessibility, mobile layout', runtime: 'auto', model: '', color: AGENT_COLORS[0] },
      { id: 'ag_backend', name: 'Backend engineer', role: 'APIs, data, server logic, parsing, performance, tests', runtime: 'auto', model: '', color: AGENT_COLORS[1] },
      { id: 'ag_devops', name: 'DevOps engineer', role: 'build, CI, deploy, infrastructure, domains, docker', runtime: 'auto', model: '', color: AGENT_COLORS[2] },
    ],
    todos: [],
    chief: [],
    topics: [],
    rules: [],
    sources: [],
    events: [],
    channels: [],
    runs: [],
  };
}

/** Where the board lives: AUTODOS_DATA, else ~/.autodos. A board from before the rename (~/.crewboard) stays where it is. */
export function defaultDataDir() {
  const env = process.env.AUTODOS_DATA || process.env.CREWBOARD_DATA;
  if (env) return env;
  const cur = path.join(os.homedir(), '.autodos');
  const old = path.join(os.homedir(), '.crewboard');
  return !fs.existsSync(path.join(cur, 'db.json')) && fs.existsSync(path.join(old, 'db.json')) ? old : cur;
}

export class Store extends EventEmitter {
  constructor(dir = defaultDataDir()) {
    super();
    this.dir = dir;
    this.file = path.join(dir, 'db.json');
    fs.mkdirSync(dir, { recursive: true });
    this.data = this.#load();
    this.timer = null;
  }

  #load() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      const base = defaultData();
      const data = { ...base, ...raw, settings: { ...base.settings, ...(raw.settings || {}) } };
      // Older data had one conversation: give it a topic.
      if (!data.topics.length && data.chief.length) {
        data.topics.push({ id: 'tp_main', title: (data.chief.find((m) => m.role === 'user')?.text || '').slice(0, 48), archived: false, createdAt: data.chief[0].at, updatedAt: now() });
        for (const m of data.chief) m.topicId = m.topicId || 'tp_main';
      }
      return data;
    } catch {
      return defaultData();
    }
  }

  /** Mutate data via fn, then persist (debounced) and notify listeners. */
  update(fn) {
    const result = fn(this.data);
    this.changed();
    return result;
  }

  changed() {
    this.emit('change');
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), 150);
  }

  flush() {
    clearTimeout(this.timer);
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2));
    fs.renameSync(tmp, this.file);
  }

  nextNumber() {
    this.data.seq += 1;
    return this.data.seq;
  }

  todo(idOrNumber) {
    return this.data.todos.find((t) => t.id === idOrNumber || String(t.number) === String(idOrNumber).replace(/^#/, ''));
  }

  agent(agentId) {
    return this.data.agents.find((a) => a.id === agentId);
  }

  project(projectId) {
    return this.data.projects.find((p) => p.id === projectId);
  }

  nextColor() {
    return AGENT_COLORS[this.data.agents.length % AGENT_COLORS.length];
  }
}
