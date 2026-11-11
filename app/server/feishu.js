// Feishu / Lark: bind a bot by scanning a QR code, then talk and decide in Feishu.
// - A message to the bot (in its group, or a direct message from the owner) goes to the lead agent.
// - Each request gets its own thread; the lead's replies and one card per todo live in that thread.
// - Cards update in place as the todo moves, with buttons when it waits on you.
// - A reply in the thread continues that todo (or asks the lead when there is no open todo).
// The connection is outgoing (long connection), so this computer needs no public address.
import { createRequire } from 'node:module';
import { id, now } from './store.js';
import { newTodo } from './chief.js';

const zh = (s) => /[一-鿿]/.test(s || '');

async function sdk() {
  // In a checkout the package is installed; the desktop app ships one bundled file instead.
  try {
    return await import('@larksuiteoapi/node-sdk');
  } catch {
    return createRequire(import.meta.url)('./vendor/lark.cjs');
  }
}

// What the app asks for when it is created: read and send messages, see chats, card buttons.
const ADDONS = {
  scopes: {
    tenant: ['im:message', 'im:message:send_as_bot', 'im:message.group_at_msg:readonly', 'im:message.group_msg', 'im:message.p2p_msg:readonly', 'im:chat:readonly', 'im:resource'],
  },
  events: { items: { tenant: ['im.message.receive_v1', 'im.chat.member.bot.added_v1'] } },
  callbacks: { items: ['card.action.trigger'] },
};

const PHASE_ZH = { todo: '待办', queued: '排队中', planning: '规划中', confirm: '等你确认计划', building: '执行中', asking: '有问题要你回答', review: '等你审核', merging: '合并中', shipping: 'PR 已开', done: '已完成', failed: '失败', closed: '已关闭' };
const PHASE_EN = { todo: 'To do', queued: 'Queued', planning: 'Planning', confirm: 'Plan ready to confirm', building: 'Building', asking: 'Has a question for you', review: 'Ready for review', merging: 'Merging', shipping: 'PR open', done: 'Done', failed: 'Failed', closed: 'Closed' };
const COLOR = { confirm: 'orange', asking: 'orange', review: 'orange', failed: 'red', done: 'green', closed: 'grey' };

export class FeishuLink {
  constructor({ store, runner, chief, publicUrl = () => '' }) {
    this.store = store;
    this.runner = runner;
    this.chief = chief;
    this.publicUrl = publicUrl;
    this.channel = null;
    this.status = 'off'; // off | connecting | on | error
    this.error = '';
    this.pending = null; // { url, expireAt } while a QR code waits to be scanned
    this.abort = null;
    runner.on('phase', (t) => this.#card(t).catch((e) => this.#fail(e)));
    chief.listeners.push((m) => this.#forward(m).catch((e) => this.#fail(e)));
    if (this.cfg?.appSecret) this.connect().catch(() => {});
  }

  get cfg() {
    return this.store.data.feishu;
  }

  /** What the UI may see: never the secret. */
  view() {
    const c = this.cfg;
    return {
      bound: !!c?.appSecret,
      appId: c?.appId || '',
      brand: c?.brand || 'feishu',
      chatId: c?.chatId || '',
      chatName: c?.chatName || '',
      botName: c?.botName || '',
      status: this.status,
      error: this.error,
      pending: this.pending,
    };
  }

  #changed() {
    this.store.changed();
  }

  #fail(e) {
    this.error = String(e?.message || e).slice(0, 300);
    this.#changed();
  }

  /** Start the scan: returns at once; the QR link shows up in view().pending. */
  async bind() {
    this.abort?.abort();
    const ctrl = new AbortController();
    this.abort = ctrl;
    this.error = '';
    const lark = await sdk();
    lark
      .registerApp({
        source: 'autodos',
        signal: ctrl.signal,
        // Scanning again after unbinding offers to reuse the earlier app.
        appId: this.cfg?.appId || undefined,
        // Kept short: everything here goes into the QR code, and a longer link makes a denser code.
        appPreset: { name: 'Autodos', desc: 'AI 开发团队' },
        addons: ADDONS,
        onQRCodeReady: ({ url, expireIn }) => {
          this.pending = { url, expireAt: new Date(Date.now() + (expireIn || 600) * 1000).toISOString() };
          this.#changed();
        },
      })
      .then(async (r) => {
        if (ctrl.signal.aborted) return;
        this.pending = null;
        this.store.data.feishu = { ...(this.cfg || {}), appId: r.client_id, appSecret: r.client_secret, brand: r.user_info?.tenant_brand || 'feishu', ownerOpenId: r.user_info?.open_id || this.cfg?.ownerOpenId || '', boundAt: now() };
        this.store.flush();
        await this.connect();
        // Say hello to the person who scanned, with what to do next.
        const owner = this.cfg.ownerOpenId;
        if (owner) await this.channel.send(owner, { markdown: '**Autodos 已连接** ✅\n直接在这里给我发需求，或者把我拉进一个群，在群里 @我 提需求。需要你拍板时，我会发卡片给你。' }).catch(() => {});
      })
      .catch((e) => {
        if (ctrl.signal.aborted) return;
        this.pending = null;
        this.#fail(e.code === 'access_denied' ? 'Scan was declined in Feishu' : e.code === 'expired_token' ? 'The QR code expired' : e);
      });
    return { ok: true };
  }

  cancel() {
    this.abort?.abort();
    this.abort = null;
    this.pending = null;
    this.#changed();
  }

  async connect() {
    const c = this.cfg;
    if (!c?.appSecret) return;
    // Each connect or unbind starts a new generation; a connection from an older one is closed, not kept.
    const gen = (this.gen = (this.gen || 0) + 1);
    const old = this.channel;
    this.channel = null;
    await old?.disconnect().catch(() => {});
    this.status = 'connecting';
    this.error = '';
    this.#changed();
    const lark = await sdk();
    const ch = lark.createLarkChannel({
      appId: c.appId,
      appSecret: c.appSecret,
      domain: c.brand === 'lark' ? 'https://open.larksuite.com' : undefined,
      transport: 'websocket',
      source: 'autodos',
      handshakeTimeoutMs: 15000,
      loggerLevel: 1,
      policy: this.#policy(),
      // One message is one request: never merge neighbouring messages into one.
      safety: { batch: { text: { delayMs: 0, maxMessages: 1 }, media: { delayMs: 0, maxItems: 1 } } },
    });
    ch.on({
      message: (m) => this.onMessage(m).catch((e) => this.#fail(e)),
      cardAction: (e) => this.onCard(e).catch((err) => this.#fail(err)),
      botAdded: (e) => this.onAdded(e).catch((err) => this.#fail(err)),
      error: (e) => this.#fail(e),
      // Kept in ~/.autodos/desktop.log (ids only, never message text) to see why a message was not handled.
      reject: (e) => console.log(`[feishu] rejected ${e.reason} chat=${e.chatId}`),
      reconnecting: () => this.channel === ch && ((this.status = 'connecting'), this.#changed()),
      reconnected: () => this.channel === ch && ((this.status = 'on'), (this.error = ''), this.#changed()),
    });
    try {
      await ch.connect();
      if (gen !== this.gen) return void ch.disconnect().catch(() => {});
      this.channel = ch;
      this.status = 'on';
      if (ch.botIdentity?.name && ch.botIdentity.name !== c.botName) c.botName = ch.botIdentity.name;
    } catch (e) {
      ch.disconnect().catch(() => {});
      if (gen !== this.gen) return;
      this.status = 'error';
      this.#fail(e);
    }
    this.#changed();
  }

  /** Only the owner may DM the bot; in groups, only the bound group. */
  #policy() {
    const c = this.cfg || {};
    // Until a group is bound every group reaches onMessage, which only lets the owner's @mention through
    // (and binds that group); the "bot added" event is not always delivered, so it cannot be relied on.
    // Mentions are checked there too, so plain replies inside a request thread still arrive.
    return { dmMode: 'allowlist', dmAllowlist: c.ownerOpenId ? [c.ownerOpenId] : ['ou_none'], groupAllowlist: c.chatId ? [c.chatId] : [], requireMention: false };
  }

  async unbind() {
    this.cancel();
    this.gen = (this.gen || 0) + 1;
    await this.channel?.disconnect().catch(() => {});
    this.channel = null;
    this.status = 'off';
    this.error = '';
    delete this.store.data.feishu;
    this.store.flush();
    this.#changed();
  }

  async test() {
    if (!this.channel || this.status !== 'on') throw Object.assign(new Error('Feishu is not connected'), { status: 400 });
    const to = this.cfg.chatId || this.cfg.ownerOpenId;
    await this.channel.send(to, { markdown: zh(this.cfg.chatName || '中') ? '这是一条来自 Autodos 的测试消息 👋' : 'A test message from Autodos 👋' });
    return { ok: true };
  }

  // ---------- incoming ----------

  async onAdded(e) {
    const c = this.cfg;
    // The first group the owner adds the bot to becomes its group.
    if (!c || c.chatId || (c.ownerOpenId && e.operator.openId !== c.ownerOpenId)) return;
    await this.#bindGroup(e.chatId);
  }

  async #bindGroup(chatId) {
    const c = this.cfg;
    c.chatId = chatId;
    c.chatName = (await this.channel.getChatInfo(chatId).catch(() => null))?.name || '';
    this.channel.updatePolicy(this.#policy());
    this.store.flush();
    this.#changed();
    await this.channel.send(chatId, { markdown: '大家好，我是 Autodos 🤖\n在群里 **@我 + 需求** 就会建任务，进度和结果都会回复在那条消息的话题里；在话题里接着回复，就是继续或返工。' });
  }

  async onMessage(m) {
    console.log(`[feishu] message ${m.chatType} chat=${m.chatId} mentioned=${!!m.mentionedBot} thread=${m.rootId || '-'}`);
    const text = String(m.content || '').replace(/@_user_\d+/g, '').trim();
    if (!text) return;
    const d = this.store.data;
    const owner = this.cfg?.ownerOpenId;
    const canApprove = !!owner && m.senderId === owner;
    if (m.chatType === 'group') {
      const bound = this.cfg?.chatId;
      if (bound && m.chatId !== bound) return;
      // No group yet: the owner @-mentioning the bot in a group makes it the bot's group.
      if (!bound) {
        if (!canApprove || !m.mentionedBot) return;
        await this.#bindGroup(m.chatId);
      }
    }
    const root = m.rootId || m.threadId || null;
    // A message in an existing request thread.
    const topic = root && d.topics.find((x) => x.feishu && (x.feishu.rootId === root || (m.threadId && x.feishu.threadId === m.threadId)));
    // In a group, a new request needs an @mention; replies inside a request thread do not.
    if (m.chatType === 'group' && !topic && !m.mentionedBot) return;
    if (topic) {
      const open = d.todos.filter((t) => t.topicId === topic.id && !['done', 'closed'].includes(t.phase));
      const quoted = d.todos.find((t) => t.topicId === topic.id && t.feishu?.cardId && t.feishu.cardId === m.replyToMessageId);
      const target = quoted && !['done', 'closed'].includes(quoted.phase) ? quoted : open.length === 1 ? open[0] : null;
      if (target) {
        this.runner.reply(target, text);
        await this.channel.addReaction(m.messageId, 'OK').catch(() => {});
        return;
      }
      // Finished work that is "still not fixed": a follow-up todo in the same thread.
      const last = quoted || d.todos.filter((t) => t.topicId === topic.id).sort((a, b) => b.number - a.number)[0];
      if (last && ['done', 'closed'].includes(last.phase) && open.length === 0) {
        const t = newTodo(this.store, {
          title: `${zh(text) ? '返工' : 'Follow-up'}: ${last.title}`.slice(0, 120),
          description: `${zh(text) ? '上一版' : 'Earlier work'}: #${last.number} ${last.title}\n${zh(text) ? '反馈' : 'Feedback'}: ${text}`,
          labels: last.labels || [],
          agentId: last.agentId,
          projectId: last.projectId,
          mode: 'run',
        });
        t.topicId = topic.id;
        t.followUpOf = last.id;
        this.runner.start(t);
        await this.channel.addReaction(m.messageId, 'OK').catch(() => {});
        return;
      }
      return this.chief.handle(text, { topicId: topic.id, canApprove });
    }
    // A new request: its own topic, answered in a thread under this message.
    const tp = { id: id('tp'), title: '', archived: false, createdAt: now(), updatedAt: now(), feishu: { chatId: m.chatId, rootId: m.messageId, threadId: m.threadId || null, from: m.senderName || '' } };
    d.topics.push(tp);
    this.#changed();
    await this.channel.addReaction(m.messageId, 'OnIt').catch(() => {});
    return this.chief.handle(text, { topicId: tp.id, canApprove });
  }

  /** A button on a todo card. Only the owner decides. */
  async onCard(e) {
    const c = this.cfg;
    if (c?.ownerOpenId && e.operator.openId !== c.ownerOpenId) return;
    const v = e.action?.value || {};
    const t = this.store.data.todos.find((x) => x.id === v.todo);
    // Only the todo's own card counts, not an old or copied one.
    if (!t || !t.feishu?.cardId || e.messageId !== t.feishu.cardId) return;
    const ok = { confirm: 'confirm', done: 'review', retry: 'failed' }[v.do] === t.phase;
    if (!ok) return this.#card(t); // stale button: just show the current state
    if (v.do === 'confirm') this.runner.confirm(t);
    else if (v.do === 'done') await this.runner.complete(t, { merge: true });
    else if (v.do === 'retry') {
      t.revision = t.mode === 'plan' && !t.planApproved ? 'plan' : null;
      this.runner.start(t);
    }
    this.store.changed();
    await this.#card(t);
  }

  // ---------- outgoing ----------

  #topicOf(topicId) {
    return topicId && this.store.data.topics.find((x) => x.id === topicId && x.feishu);
  }

  /** The lead's replies in a Feishu topic go to that thread. Todo status lines are left to the cards. */
  async #forward(m) {
    const tp = this.#topicOf(m.topicId);
    if (!tp || this.status !== 'on' || m.role !== 'chief') return;
    if (m.todoIds?.length && !m.error) {
      // New todos get their card right away, even before they start; status lines are left to the cards.
      for (const tid of m.todoIds) {
        const t = this.store.data.todos.find((x) => x.id === tid);
        if (t) {
          t.topicId ||= tp.id;
          await this.#card(t);
        }
      }
      return;
    }
    await this.channel.send(tp.feishu.chatId, { markdown: m.text.replace(/#(\d+)/g, '`#$1`') }, { replyTo: tp.feishu.rootId, replyInThread: true });
  }

  /** Create or update the card for a todo that came from Feishu, one update at a time per todo. */
  #card(t) {
    this.cardQueue ||= new Map();
    const next = (this.cardQueue.get(t.id) || Promise.resolve()).catch(() => {}).then(() => this.#cardNow(t));
    this.cardQueue.set(t.id, next);
    next.finally(() => this.cardQueue.get(t.id) === next && this.cardQueue.delete(t.id)).catch(() => {});
    return next;
  }

  async #cardNow(t) {
    const tp = this.#topicOf(t.topicId);
    if (!tp || !this.channel || this.status !== 'on') return;
    const card = this.cardFor(t);
    if (t.feishu?.cardId) return this.channel.updateCard(t.feishu.cardId, card);
    const r = await this.channel.send(tp.feishu.chatId, { card }, { replyTo: tp.feishu.rootId, replyInThread: true });
    t.feishu = { cardId: r.messageId };
    this.store.changed();
  }

  cardFor(t) {
    const cn = true; // Feishu users read Chinese; the board itself follows its own language setting
    const agent = this.store.data.agents.find((a) => a.id === t.agentId);
    const status = (cn ? PHASE_ZH : PHASE_EN)[t.phase] || t.phase;
    const lines = [`**${status}**${agent ? ` · ${agent.name}` : ''}`];
    // The project's lead looks first: no buttons until it passes the todo on.
    const lead = !!t.leadPending;
    if (lead) lines.push('开发主管正在处理，需要你时会再通知。');
    if (!lead && t.leadAsk && (t.leadAsk.text || t.leadAsk.recommend)) lines.push(`主管请你拍板：${t.leadAsk.text || ''}${t.leadAsk.recommend ? `\n主管建议：${t.leadAsk.recommend}` : ''}`);
    if (t.phase === 'confirm' && t.plan) lines.push(String(t.plan).slice(0, 1500));
    if (t.phase === 'asking' && t.question?.text) lines.push(`❓ ${t.question.text}\n在话题里直接回复答案即可。`);
    const said = [...(t.messages || [])].reverse().find((x) => x.role === 'agent' && !x.hidden)?.text;
    if (t.phase === 'review' && said) lines.push(String(said).slice(0, 1500));
    if (t.phase === 'failed' && t.error) lines.push(`原因：${String(t.error).slice(0, 500)}`);
    if (t.checks?.results?.length) lines.push(t.checks.results.map((r) => `${r.ok ? '✅' : '❌'} \`${r.command}\``).join('\n'));
    const url = this.publicUrl();
    if (url) lines.push(`[在 Autodos 中打开](${url.replace(/\/$/, '')}/#/todo/${t.number})`);
    const buttons = [];
    const btn = (label, action, type = 'primary') => buttons.push({ tag: 'button', text: { tag: 'plain_text', content: label }, type, value: { todo: t.id, do: action } });
    if (!lead && t.phase === 'confirm') btn('确认计划', 'confirm');
    if (!lead && t.phase === 'review') btn('合并', 'done');
    if (!lead && t.phase === 'failed') btn('重试', 'retry', 'default');
    const elements = [{ tag: 'div', text: { tag: 'lark_md', content: lines.join('\n\n') } }];
    if (buttons.length) elements.push({ tag: 'action', actions: buttons });
    if (['confirm', 'review'].includes(t.phase)) elements.push({ tag: 'note', elements: [{ tag: 'plain_text', content: '要改的话，在话题里直接回复。' }] });
    return { config: { wide_screen_mode: true, update_multi: true }, header: { template: COLOR[t.phase] || 'blue', title: { tag: 'plain_text', content: `#${t.number} ${t.title}`.slice(0, 100) } }, elements };
  }
}
