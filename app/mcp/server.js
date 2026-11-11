#!/usr/bin/env node
// A stdio MCP server so any coding agent (Claude Code, Codex, Cursor...) can read and update the board.
// Add it with:  claude mcp add autodos -- node /path/to/app/mcp/server.js
// It talks to a running Autodos (web or desktop) at AUTODOS_URL, default http://127.0.0.1:4747.
import readline from 'node:readline';

const BASE = (process.env.AUTODOS_URL || 'http://127.0.0.1:4747').replace(/\/$/, '');

async function api(method, path, body) {
  const res = await fetch(BASE + '/api' + path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

const brief = (t) => ({ number: t.number, title: t.title, phase: t.phase, labels: t.labels, agentId: t.agentId, projectId: t.projectId, updatedAt: t.updatedAt });

const tools = [
  {
    name: 'list_todos',
    description: 'List todos on the Autodos board. Phases: todo, queued, planning, confirm, building, review, done, failed, closed.',
    inputSchema: { type: 'object', properties: { phase: { type: 'string', description: 'Only todos in this phase' }, query: { type: 'string', description: 'Text to match in the title' } } },
    run: async ({ phase, query }) => {
      const todos = await api('GET', '/todos');
      return todos.filter((t) => (!phase || t.phase === phase) && (!query || t.title.toLowerCase().includes(query.toLowerCase()))).map(brief);
    },
  },
  {
    name: 'get_todo',
    description: 'Read one todo with its plan and conversation.',
    inputSchema: { type: 'object', properties: { number: { type: 'integer' } }, required: ['number'] },
    run: async ({ number }) => {
      const t = await api('GET', `/todos/${number}`);
      return { ...brief(t), description: t.description, plan: t.plan, branch: t.branch, messages: t.messages.map((m) => ({ role: m.role, text: m.text, at: m.at })) };
    },
  },
  {
    name: 'create_todo',
    description: 'File a new todo. Set start=true to run it right away with the assigned (or best-matching) agent.',
    inputSchema: {
      type: 'object',
      properties: { title: { type: 'string' }, description: { type: 'string' }, labels: { type: 'array', items: { type: 'string' } }, start: { type: 'boolean' }, mode: { type: 'string', enum: ['run', 'plan'] } },
      required: ['title'],
    },
    // Inside a Autodos run the parent todo is known, so delegation limits and the shared budget apply.
    run: async (args) => brief(await api('POST', '/todos', { ...args, parent: process.env.AUTODOS_TODO ? Number(process.env.AUTODOS_TODO) : undefined, start: process.env.AUTODOS_TODO ? true : args.start })),
  },
  {
    name: 'comment_todo',
    description: 'Post a message in a todo conversation. At a Confirm or Review gate this asks the agent for a revision.',
    inputSchema: { type: 'object', properties: { number: { type: 'integer' }, text: { type: 'string' } }, required: ['number', 'text'] },
    run: async ({ number, text }) => brief(await api('POST', `/todos/${number}/messages`, { text })),
  },
  {
    name: 'move_todo',
    description: 'Act on a todo: start, confirm (approve plan), done (accept and merge), close, stop, retry.',
    inputSchema: { type: 'object', properties: { number: { type: 'integer' }, action: { type: 'string', enum: ['start', 'confirm', 'done', 'close', 'stop', 'retry'] }, merge: { type: 'boolean' } }, required: ['number', 'action'] },
    run: async ({ number, action, merge }) => brief(await api('POST', `/todos/${number}/action`, { action, merge })),
  },
  {
    name: 'ask_lead',
    description: 'Send a request to the Lead, which splits it into todos and assigns agents.',
    inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
    run: async ({ text }) => {
      // An agent at work splits work with create_todo (bounded); asking the lead would bypass the limits.
      if (process.env.AUTODOS_TODO) throw new Error('Inside a todo, use create_todo for sub-tasks.');
      await api('POST', '/chief', { text, via: 'mcp' });
      return { ok: true, note: 'The lead is filing todos; call list_todos to see them.' };
    },
  },
];

const send = (msg) => process.stdout.write(JSON.stringify(msg) + '\n');

readline.createInterface({ input: process.stdin }).on('line', async (line) => {
  let req;
  try {
    req = JSON.parse(line);
  } catch {
    return;
  }
  const { id, method, params } = req;
  if (id === undefined) return; // notifications
  try {
    let result;
    if (method === 'initialize') {
      result = { protocolVersion: params?.protocolVersion || '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'autodos', version: '0.1.0' } };
    } else if (method === 'ping') {
      result = {};
    } else if (method === 'tools/list') {
      result = { tools: tools.map(({ run, ...t }) => t) };
    } else if (method === 'tools/call') {
      const tool = tools.find((t) => t.name === params.name);
      if (!tool) throw Object.assign(new Error(`Unknown tool ${params.name}`), { code: -32602 });
      try {
        const out = await tool.run(params.arguments || {});
        result = { content: [{ type: 'text', text: JSON.stringify(out, null, 2) }] };
      } catch (e) {
        result = { content: [{ type: 'text', text: `Error: ${e.message} (is Autodos running at ${BASE}?)` }], isError: true };
      }
    } else {
      throw Object.assign(new Error(`Method not found: ${method}`), { code: -32601 });
    }
    send({ jsonrpc: '2.0', id, result });
  } catch (e) {
    send({ jsonrpc: '2.0', id, error: { code: e.code || -32603, message: e.message } });
  }
});
