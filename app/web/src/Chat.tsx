import { useEffect, useRef, useState } from 'react';
import { actions, State } from './api';
import { todoKey } from './Board';
import { useLang, useT } from './i18n';
import { Icon } from './icons';
import type { Page } from './Palette';

/** Renders text, turning "#123" into links that open that todo. */
export function RichText({ text, state, onOpen }: { text: string; state: State; onOpen: (id: string) => void }) {
  const parts = text.split(/(#\d{1,6}\b|`[^`]+`)/g);
  return (
    <>
      {parts.map((p, i) => {
        if (/^#\d+$/.test(p)) {
          const t = state.todos.find((x) => x.number === Number(p.slice(1)));
          if (t)
            return (
              <button key={i} className="ref" onClick={() => onOpen(t.id)}>
                {todoKey(t, state)}
              </button>
            );
        }
        if (/^`[^`]+`$/.test(p)) return <code key={i}>{p.slice(1, -1)}</code>;
        return <span key={i}>{p}</span>;
      })}
    </>
  );
}

const pref = (k: string) => {
  try {
    return localStorage.getItem('autodos.' + k);
  } catch {
    return null;
  }
};
const setPref = (k: string, v: string) => {
  try {
    localStorage.setItem('autodos.' + k, v);
  } catch {}
};

function Starters({ state, onSend, onGo }: { state: State; onSend: (text: string) => void; onGo: (p: Page) => void }) {
  const t = useT();
  const realRuntime = state.runtimes.some((r) => r.available && r.id !== 'demo');
  const items: { icon: string; label: string; sub: string; run: () => void }[] = [
    { icon: 'folder', label: t.starterImport, sub: t.starterImportSub, run: () => onGo('projects') },
    { icon: 'spark', label: t.starterGame, sub: t.starterGameSub, run: () => onSend(t.starterGamePrompt) },
    { icon: 'clock', label: t.starterDigest, sub: t.starterDigestSub, run: () => onSend(t.starterDigestPrompt) },
  ];
  if (!realRuntime || state.settings.defaultRuntime !== 'demo')
    items.push({ icon: 'play', label: t.starterDemo, sub: t.starterDemoSub, run: () => actions.settings({ defaultRuntime: 'demo', chiefRuntime: 'demo' }) });
  return (
    <div className="starters">
      {items.map((it) => (
        <button key={it.label} className="starter" onClick={it.run}>
          <Icon name={it.icon} size={16} />
          <span>
            <strong>{it.label}</strong>
          </span>
        </button>
      ))}
    </div>
  );
}

export function Chat({ state, projectId, onOpen, onGo }: { state: State; projectId: string | null; onOpen: (id: string) => void; onGo: (p: Page) => void }) {
  const t = useT();
  const lang = useLang();
  const [text, setText] = useState('');
  const [error, setError] = useState('');
  const [topicId, setTopicId] = useState<string | null>(pref('topic'));
  const [showTopics, setShowTopics] = useState(false);
  const [showArchived, setShowArchived] = useState(false);
  const list = useRef<HTMLDivElement>(null);
  const agentByName = Object.fromEntries(state.agents.map((a) => [a.name, a]));

  const open = state.topics.filter((x) => !x.archived).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const archived = state.topics.filter((x) => x.archived);
  // A topic id of "new" means a fresh, not-yet-created topic.
  const topic = topicId === 'new' ? null : state.topics.find((x) => x.id === topicId) || open[0] || null;
  const messages = topic ? state.chief.filter((m) => m.topicId === topic.id) : [];
  const choose = (id: string) => {
    setTopicId(id);
    setPref('topic', id);
    setShowTopics(false);
  };

  useEffect(() => {
    list.current?.scrollTo({ top: list.current.scrollHeight, behavior: 'smooth' });
  }, [messages.length, state.chiefBusy, topic?.id]);

  const send = async (raw = text) => {
    const v = raw.trim();
    if (!v) return;
    setText('');
    setError('');
    try {
      let tid = topic?.id;
      if (!tid) {
        tid = (await actions.newTopic()).id;
        choose(tid);
      }
      await actions.say(v, projectId, tid);
    } catch (e: any) {
      setError(e.message);
      setText(v);
    }
  };

  const fmtDay = (iso: string) => new Date(iso).toLocaleDateString(lang === 'zh' ? 'zh-CN' : undefined, { month: 'short', day: 'numeric' });

  return (
    <section className="chat">
      <header className="panel-head">
        <span className="lead-badge">
          <Icon name="spark" size={14} />
        </span>
        <button className="topic-btn" onClick={() => setShowTopics((s) => !s)} title={t.topics}>
          <strong className="ellipsis">{topic?.title || t.newTopic}</strong>
          <span className="muted">▾</span>
        </button>
        <span className="grow" />
        <button className="icon-btn" title={t.newTopic} onClick={() => choose('new')}>
          <Icon name="plus" size={15} />
        </button>
        {topic && (
          <button className="icon-btn" title={t.archive} onClick={() => actions.updateTopic(topic.id, { archived: true }).then(() => choose(open.find((x) => x.id !== topic.id)?.id || 'new'))}>
            <Icon name="archive" size={15} />
          </button>
        )}
      </header>
      {showTopics && (
        <div className="topic-list">
          <button className="topic-item" onClick={() => choose('new')}>
            <Icon name="plus" size={14} /> {t.newTopic}
          </button>
          {open.map((x) => (
            <button key={x.id} className={`topic-item ${x.id === topic?.id ? 'on' : ''}`} onClick={() => choose(x.id)}>
              <span className="grow ellipsis">{x.title || t.newTopic}</span>
              <span className="muted small">{fmtDay(x.updatedAt)}</span>
            </button>
          ))}
          {archived.length > 0 && (
            <button className="topic-item muted" onClick={() => setShowArchived((s) => !s)}>
              <Icon name="archive" size={14} /> {t.archived} ({archived.length})
            </button>
          )}
          {showArchived &&
            archived.map((x) => (
              <div key={x.id} className="topic-item archived">
                <span className="grow ellipsis">{x.title || t.newTopic}</span>
                <button className="btn ghost small" onClick={() => actions.updateTopic(x.id, { archived: false }).then(() => choose(x.id))}>
                  {t.restore}
                </button>
                <button className="icon-btn" title={t.delete} onClick={() => confirm(`${t.delete}: ${x.title}?`) && actions.deleteTopic(x.id)}>
                  <Icon name="trash" size={14} />
                </button>
              </div>
            ))}
        </div>
      )}
      <div className="chat-list" ref={list}>
        {messages.length === 0 && (
          <div className="chat-empty">
            <span className="lead-badge big">
              <Icon name="spark" size={20} />
            </span>
            <Starters state={state} onSend={send} onGo={onGo} />
          </div>
        )}
        {messages.map((m) => (
          <div key={m.id} className={`bubble ${m.role} ${m.error ? 'err' : ''}`}>
            {m.text.split('\n').map((line, i) => {
              const assigned = line.match(/^(#\d+ .*) → (.*)$/);
              if (assigned) {
                const a = agentByName[assigned[2]];
                return (
                  <div key={i} className="assigned">
                    <span>
                      <RichText text={assigned[1]} state={state} onOpen={onOpen} />
                    </span>
                    <span className="who" style={{ color: a?.color }}>
                      {assigned[2]}
                    </span>
                  </div>
                );
              }
              return (
                <div key={i}>
                  <RichText text={line} state={state} onOpen={onOpen} />
                </div>
              );
            })}
            {(() => {
              // A requirement card that still waits for the customer: they say yes or drop it here.
              const r = m.requirementId && state.requirements?.find((x) => x.id === m.requirementId);
              if (!r || r.status !== 'confirm' || state.chief.some((x) => x.requirementId === r.id && x.at > m.at)) return null;
              return (
                <div className="req-actions">
                  <button className="btn small" onClick={() => actions.confirmRequirement(r.id).catch((e) => setError(e.message))}>
                    {t.reqConfirm}
                  </button>
                  <button className="btn small ghost" onClick={() => actions.dropRequirement(r.id).catch((e) => setError(e.message))}>
                    {t.reqDrop}
                  </button>
                </div>
              );
            })()}
            <time>{new Date(m.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</time>
          </div>
        ))}
        {state.chiefBusy && <div className="bubble chief typing">{t.thinking}</div>}
      </div>
      <form
        className="composer"
        onSubmit={(e) => {
          e.preventDefault();
          send();
        }}
      >
        <textarea
          value={text}
          placeholder={t.askPlaceholder}
          rows={2}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              send();
            }
          }}
        />
        {error && <div className="error-line">{error}</div>}
        <div className="composer-row">
          <span />
          <button className="send" type="submit" disabled={!text.trim()} aria-label={t.send}>
            <Icon name="send" size={15} />
          </button>
        </div>
      </form>
    </section>
  );
}
