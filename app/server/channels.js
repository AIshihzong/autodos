// Notification channels: chat-bot webhooks (Feishu/Lark, DingTalk, WeCom, Slack) or any JSON webhook.
import crypto from 'node:crypto';
import dns from 'node:dns/promises';
import net from 'node:net';

export const CHANNEL_KINDS = ['feishu', 'dingtalk', 'wecom', 'slack', 'webhook'];

function payload(ch, text, extra) {
  const ts = Math.floor(Date.now() / 1000);
  switch (ch.kind) {
    case 'feishu': {
      const body = { msg_type: 'text', content: { text } };
      if (ch.secret) {
        // Feishu custom bot signing: HMAC-SHA256 keyed by "timestamp\nsecret" over an empty message.
        body.timestamp = String(ts);
        body.sign = crypto.createHmac('sha256', `${ts}\n${ch.secret}`).update('').digest('base64');
      }
      return { url: ch.url, body };
    }
    case 'dingtalk': {
      let url = ch.url;
      if (ch.secret) {
        const ms = Date.now();
        const sign = crypto.createHmac('sha256', ch.secret).update(`${ms}\n${ch.secret}`).digest('base64');
        url += `${url.includes('?') ? '&' : '?'}timestamp=${ms}&sign=${encodeURIComponent(sign)}`;
      }
      return { url, body: { msgtype: 'text', text: { content: text } } };
    }
    case 'wecom':
      return { url: ch.url, body: { msgtype: 'text', text: { content: text } } };
    case 'slack':
      return { url: ch.url, body: { text } };
    default:
      return { url: ch.url, body: { text, ...extra } };
  }
}

/** Loopback, private, link-local and similar addresses a notification must never reach. */
export function isPrivateAddress(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || a >= 224;
  }
  const v = ip.toLowerCase();
  if (v.startsWith('::ffff:')) return isPrivateAddress(v.slice(7));
  return v === '::' || v === '::1' || v.startsWith('fc') || v.startsWith('fd') || v.startsWith('fe8') || v.startsWith('fe9') || v.startsWith('fea') || v.startsWith('feb') || v.startsWith('ff');
}

/** Only public https endpoints (tests may allow local ones explicitly). */
export async function checkUrl(raw) {
  let u;
  try {
    u = new URL(raw);
  } catch {
    throw new Error('Not a valid URL');
  }
  const local = process.env.AUTODOS_ALLOW_LOCAL_CHANNELS === '1';
  if (u.protocol !== 'https:' && !(local && u.protocol === 'http:')) throw new Error('Channel URL must be https');
  if (u.username || u.password) throw new Error('Put credentials in the secret field, not in the URL');
  if (local) return u;
  const addrs = await dns.lookup(u.hostname.replace(/^\[|\]$/g, ''), { all: true }).catch(() => {
    throw new Error(`Cannot resolve ${u.hostname}`);
  });
  if (!addrs.length || addrs.some((a) => isPrivateAddress(a.address))) throw new Error('Channel URL points at a private or local address');
  return u;
}

export async function send(ch, text, extra = {}) {
  const { url, body } = payload(ch, text, extra);
  await checkUrl(url);
  // No redirects: a 3xx could otherwise forward the request to a local service.
  const res = await fetch(url, { method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(10000) });
  if (res.status >= 300 && res.status < 400) throw new Error(`${ch.kind} answered with a redirect (${res.status}); redirects are not followed`);
  const out = await res.text().catch(() => '');
  // Feishu and DingTalk answer 200 with an error code in the body.
  let code = 0;
  try {
    const j = JSON.parse(out);
    code = j.code ?? j.errcode ?? j.StatusCode ?? 0;
  } catch {}
  // Keep only the status and the platform's error code: response bodies may echo the URL and its token.
  if (!res.ok || code) throw new Error(`${ch.kind} answered ${res.status}${code ? ` with error code ${code}` : ''}`);
  return true;
}

/** Wire the runner's gate events to every enabled channel. */
export function attachChannels(store, runner) {
  const text = (t) => {
    const url = store.data.settings.publicUrl ? `\n${store.data.settings.publicUrl.replace(/\/$/, '')}/#todo=${t.number}` : '';
    const head = `#${t.number} ${t.title}`;
    switch (t.phase) {
      case 'asking':
        return `${head}\n${t.question?.text || ''}${t.question?.options?.length ? '\n' + t.question.options.map((o, i) => `${i + 1}. ${o}`).join('\n') : ''}${url}`;
      case 'confirm':
        return `${head}: plan ready to confirm${url}`;
      case 'review':
        return `${head}: ready for review${t.checks ? (t.checks.passed ? ' · checks passed' : ' · checks failing') : ''}${url}`;
      case 'failed':
        return `${head} failed: ${t.error || ''}${url}`;
      default:
        return null;
    }
  };
  runner.on('phase', (t) => {
    if (t.tell === 'never') return;
    const msg = text(t);
    if (!msg) return;
    for (const ch of store.data.channels || []) {
      if (!ch.enabled) continue;
      send(ch, msg, { todo: t.number, phase: t.phase }).then(
        () => ((ch.lastError = null), (ch.lastSentAt = new Date().toISOString())),
        (e) => (ch.lastError = String(e.message).slice(0, 200)),
      ).finally(() => store.changed());
    }
  });
}
