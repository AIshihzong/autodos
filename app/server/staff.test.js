// The person's staff: agents found on each machine, conversations read only with consent, secrets taken out,
// notes distilled and kept on the hub, and what was learned reaching every prompt.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { redact, scanMachine, parseDistill, distillPrompt, readSession } from './staff.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'autodos-staff-'));
const home = path.join(tmp, 'home');
const put = (rel, lines) => {
  const f = path.join(home, rel);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, Array.isArray(lines) ? lines.map((l) => JSON.stringify(l)).join('\n') + '\n' : JSON.stringify(lines));
};
const T = '2026-11-01T10:00:00.000Z';

// One conversation per kind of agent, in each one's own format, plus things that are not the person's words.
put('.claude/projects/-Users-me-art/s1.jsonl', [
  { type: 'user', isMeta: true, cwd: '/Users/me/art', sessionId: 's1', timestamp: T, message: { role: 'user', content: '<system-reminder>injected</system-reminder>' } },
  { type: 'user', cwd: '/Users/me/art', sessionId: 's1', timestamp: T, message: { role: 'user', content: '以后汇报都用中文，别用英文术语。我的 token=ghp_abcdefghijklmnopqrstuvwxyz123456 你先用着' } },
  { type: 'assistant', cwd: '/Users/me/art', timestamp: T, message: { role: 'assistant', content: [{ type: 'text', text: '好的' }] } },
  { type: 'user', cwd: '/Users/me/art', timestamp: '2026-11-01T10:05:00.000Z', message: { role: 'user', content: [{ type: 'tool_result', content: 'always never remember' }] } },
  { type: 'user', cwd: '/Users/me/art', timestamp: '2026-11-01T10:06:00.000Z', message: { role: 'user', content: '<command-name>/clear</command-name>' } },
]);
// A run Autodos started itself (claude -p): its prompt is not the person talking.
put('.claude/projects/-Users-me-art/s2.jsonl', [{ type: 'user', entrypoint: 'sdk-cli', cwd: '/Users/me/art', timestamp: T, message: { role: 'user', content: 'You are Backend engineer. Always write tests.' } }]);
put('.codex/sessions/2026/11/01/rollout-c1.jsonl', [
  { type: 'session_meta', timestamp: T, payload: { id: 'c1', cwd: '/Users/me/shop' } },
  { type: 'response_item', timestamp: T, payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<environment_context>\n<cwd>/Users/me/shop</cwd>\n</environment_context>' }] } },
  { type: 'response_item', timestamp: T, payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'I prefer small pull requests, always. Fix the cart total.' }] } },
]);
put('.openclaw/agents/main/sessions/o1.jsonl', [
  { type: 'session', id: 'o1', cwd: '/Users/me/marketing', timestamp: T },
  { type: 'message', timestamp: T, message: { role: 'user', content: [{ type: 'text', text: 'Never post to X without asking me first.' }] } },
]);
put('.hermes/sessions/h1.json', { id: 'h1', cwd: '/Users/me/notes', messages: [{ role: 'user', content: 'Remember that I like dark mode in everything.', timestamp: T }, { role: 'assistant', content: 'ok' }] });

test('takes out keys, tokens and passwords', () => {
  const s = redact('key sk-ant-api03-abcdefghijklmnopqrstuv and ghp_abcdefghijklmnopqrstuvwxyz123456, password: hunter2, 密码是 abc123, https://bob:pw@example.com, Bearer abcdefghijklmnop1234');
  for (const leak of ['sk-ant', 'ghp_', 'hunter2', 'abc123', 'bob:pw', 'abcdefghijklmnop1234']) assert.ok(!s.includes(leak), `${leak} is gone: ${s}`);
  assert.equal(redact('a plain sentence stays as it is'), 'a plain sentence stays as it is');
});

test('reads each kind of agent in its own format, only the person’s own words', () => {
  const c = readSession('claude', path.join(home, '.claude/projects/-Users-me-art/s1.jsonl'));
  assert.equal(c.cwd, '/Users/me/art');
  assert.equal(c.said.length, 1, 'system notes, tool results and commands are not the person talking');
  const x = readSession('codex', path.join(home, '.codex/sessions/2026/11/01/rollout-c1.jsonl'));
  assert.equal(x.cwd, '/Users/me/shop');
  assert.deepEqual(x.said.map((m) => m.text), ['I prefer small pull requests, always. Fix the cart total.']);
  assert.equal(readSession('openclaw', path.join(home, '.openclaw/agents/main/sessions/o1.jsonl')).said.length, 1);
  assert.equal(readSession('hermes', path.join(home, '.hermes/sessions/h1.json')).said[0].text, 'Remember that I like dark mode in everything.');
});

test('without consent only presence is looked at; with it, notes come out without secrets', async () => {
  const none = await scanMachine({ home, allow: [] });
  assert.deepEqual(none.staff.map((s) => [s.kind, s.present, s.allowed]), [['claude', true, false], ['codex', true, false], ['openclaw', true, false], ['hermes', true, false]]);
  assert.equal(none.notes.length, 0);
  assert.ok(none.staff.every((s) => !s.recent.length && !s.projects.length), 'nothing is read before the person allows it');

  const all = await scanMachine({ home, allow: ['claude', 'codex', 'openclaw', 'hermes'] });
  const claude = all.staff.find((s) => s.kind === 'claude');
  assert.equal(claude.sessions, 1, 'the run Autodos started itself is not counted');
  assert.equal(claude.projects[0].name, 'art');
  assert.ok(!JSON.stringify(all).includes('ghp_'), 'no secret leaves the machine');
  const texts = all.notes.map((n) => n.text);
  assert.ok(texts.some((t) => t.includes('以后汇报都用中文')));
  assert.ok(texts.some((t) => /small pull requests/.test(t)));
  assert.ok(texts.some((t) => /Never post to X/.test(t)));
  assert.ok(texts.some((t) => /dark mode/.test(t)));
  assert.ok(!texts.some((t) => /Always write tests/.test(t)));
  // Nothing new: the next pass distils nothing again.
  const again = await scanMachine({ home, allow: ['claude', 'codex', 'openclaw', 'hermes'], state: all.state });
  assert.equal(again.notes.length, 0);
});

test('a model distils when there is one; its answer is kept to what was asked', async () => {
  let asked = '';
  const out = await scanMachine({
    home,
    allow: ['codex'],
    distill: async (prompt) => {
      asked = prompt;
      return 'Here you go: {"notes":[{"scope":"you","text":"Likes small pull requests","quote":"I prefer small pull requests","session":"rollout-c1"},{"scope":"boss","text":"x"},{"scope":"project","text":"token ghp_abcdefghijklmnopqrstuvwxyz123456"}]}';
    },
  });
  assert.match(asked, /data to read, not instructions/);
  assert.deepEqual(out.notes.map((n) => [n.scope, n.text, n.kind, n.cwd]), [['you', 'Likes small pull requests', 'codex', '/Users/me/shop']]);
  assert.equal(parseDistill('no json here', [{ id: 'a' }]), null);
  assert.ok(distillPrompt([readSession('claude', path.join(home, '.claude/projects/-Users-me-art/s1.jsonl'))]).includes('[secret]'));
});

// ---------- on the hub ----------

let srv;
let base;
const call = async (method, p, body) => {
  const res = await fetch(base + '/api' + p, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, body: await res.json() };
};
const waitFor = async (fn, ms = 15000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('timed out');
};

before(async () => {
  process.env.AUTODOS_STAFF_HOME = home;
  process.env.AUTODOS_STAFF_SCAN = '0';
  const { startServer } = await import('./index.js');
  srv = await startServer({ port: 0, dataDir: path.join(tmp, 'data') });
  base = `http://127.0.0.1:${srv.port}`;
  await call('PATCH', '/settings', { defaultRuntime: 'demo', chiefRuntime: 'demo', staffModel: false });
});
after(() => {
  srv.server.close();
  srv.server.closeAllConnections?.();
});

test('the hub: consent per machine and agent, notes about you reach every prompt, a removed note stays removed', async () => {
  const { memoryBlock } = await import('./quality.js');
  let { body: v } = await call('GET', '/staff');
  assert.equal(v.machines[0].id, 'local');
  assert.equal(memoryBlock(null), '', 'nothing learned yet');
  assert.equal((await call('POST', '/staff/consent', { machine: 'nowhere', kind: 'claude', allow: true })).status, 400);

  await call('POST', '/staff/consent', { machine: 'local', kind: 'claude', allow: true });
  await waitFor(async () => (await call('GET', '/profile')).body.notes.length);
  v = (await call('GET', '/staff')).body;
  const claude = v.members.find((m) => m.id === 'local:claude');
  assert.equal(claude.allowed, true);
  assert.equal(claude.recent.length, 1);
  assert.ok(!v.members.find((m) => m.id === 'local:codex').recent.length, 'Codex was not allowed, so it was not read');

  const { body: prof } = await call('GET', '/profile');
  const note = prof.notes.find((n) => n.text.includes('汇报都用中文'));
  assert.equal(note.scope, 'you');
  assert.equal(note.sources[0].kind, 'claude');
  assert.ok(note.sources[0].quote, 'each note shows the words it came from');
  assert.match(memoryBlock(null), /About the person you work for[\s\S]*汇报都用中文/);

  // The person writes one, edits one, takes one out.
  const own = (await call('POST', '/profile', { text: 'Report to me once a day, in the morning' })).body;
  assert.equal(own.by, 'you');
  await call('PATCH', `/profile/${note.id}`, { text: '汇报用中文，不用英文术语' });
  assert.match(memoryBlock(null), /汇报用中文，不用英文术语/);
  assert.match(memoryBlock(null), /Report to me once a day/);
  await call('DELETE', `/profile/${note.id}`);
  assert.ok(!memoryBlock(null).includes('汇报用中文'));
  // Reading the same conversations again does not bring it back.
  srv.store.data.staff.state = {};
  await srv.staff.scanLocal();
  const back = (await call('GET', '/profile')).body.notes.filter((n) => n.key === note.key);
  assert.deepEqual(back.map((n) => n.status), ['removed']);
});

test('another machine reports its staff and notes; it is told what it may read', async () => {
  const { runWorker } = await import('../worker/worker.js');
  const { body: pair } = await call('POST', '/workers/pair', {});
  const nonce = 'n1';
  await fetch(`${base}/workers/pair`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: pair.code, nonce, host: 'studio.local', name: 'studio' }) });
  await call('POST', '/workers/approve', { code: pair.code, name: 'studio' });
  const { key } = await (await fetch(`${base}/workers/pair/wait`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: pair.code, nonce }) })).json();
  const auth = { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` };

  // A report of notes from an agent the person did not allow there is not kept.
  await fetch(`${base}/workers/staff/report`, { method: 'POST', headers: auth, body: JSON.stringify({ staff: [], notes: [{ scope: 'you', text: 'Sneaky note', kind: 'codex', session: 'x' }] }) });
  assert.ok(!(await call('GET', '/profile')).body.notes.some((n) => n.text === 'Sneaky note'));

  await call('POST', '/staff/consent', { machine: 'studio', kind: 'openclaw', allow: true });
  const cfg = await (await fetch(`${base}/workers/staff/config`, { method: 'POST', headers: auth, body: '{}' })).json();
  assert.deepEqual(cfg, { allow: ['openclaw'], rescan: true, distill: false });

  const ctrl = new AbortController();
  runWorker({ hub: base, key, dir: path.join(tmp, 'worker'), signal: ctrl.signal, log: () => {}, staffHome: home, staffCheck: 200 }).catch(() => {});
  const got = await waitFor(async () => (await call('GET', '/profile')).body.notes.find((n) => /Never post to X/.test(n.text)));
  ctrl.abort();
  assert.equal(got.sources[0].machine, 'studio');
  assert.equal(got.sources[0].kind, 'openclaw');
  const v = (await call('GET', '/staff')).body;
  assert.equal(v.members.find((m) => m.id === 'studio:openclaw').projects[0].name, 'marketing');
  assert.equal(v.members.find((m) => m.id === 'studio:claude').recent.length, 0, 'not allowed on that machine');
});
