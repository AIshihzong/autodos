import { useEffect, useRef, useState } from 'react';
import { actions, ago, duration, State, Todo, useLive } from './api';
import { PhaseBadge, todoKey } from './Board';
import { RichText } from './Chat';
import { useDialog } from './ui';
import { Dict, useLang, useT } from './i18n';
import { Avatar, Icon } from './icons';

/** Unified diff, one collapsible block per file. */
export interface LineComment { file: string; line: number; code: string; text: string; old?: boolean }

/** Unified diff, one collapsible block per file; click a line to leave a comment for the agent. */
function DiffView({ diff, comments, setComments }: { diff: string; comments: LineComment[]; setComments: (c: LineComment[]) => void }) {
  const t = useT();
  const files = diff.split(/^(?=diff --git )/m).filter((f) => f.startsWith('diff --git'));
  const [closed, setClosed] = useState<Record<number, boolean>>({});
  const [editing, setEditing] = useState<{ file: string; line: number; code: string } | null>(null);
  const [draft, setDraft] = useState('');
  const save = () => {
    if (editing && draft.trim()) setComments([...comments, { ...editing, text: draft.trim() }]);
    setEditing(null);
    setDraft('');
  };
  return (
    <div className="diff">
      {files.map((f, i) => {
        const lines = f.split('\n');
        const name = lines[0].replace(/^diff --git a\/(.*) b\/.*/, '$1');
        const add = lines.filter((l) => l.startsWith('+') && !l.startsWith('+++')).length;
        const del = lines.filter((l) => l.startsWith('-') && !l.startsWith('---')).length;
        const body = lines.slice(lines.findIndex((l) => l.startsWith('@@')));
        // Track the new-file line number so a comment points at the code as it is now.
        let oldLine = 0;
        let newLine = 0;
        const rows = body.map((l) => {
          const h = l.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)/);
          if (h) {
            oldLine = Number(h[1]) - 1;
            newLine = Number(h[2]) - 1;
            return { l, n: 0, kind: 'hunk' };
          }
          if (l.startsWith('-')) return { l, n: ++oldLine, kind: 'rem' };
          if (l.startsWith('+')) return { l, n: ++newLine, kind: 'ins' };
          ++oldLine;
          return { l, n: ++newLine, kind: '' };
        });
        return (
          <div key={i} className="diff-file">
            <button className="diff-head" onClick={() => setClosed((c) => ({ ...c, [i]: !c[i] }))} aria-expanded={!closed[i]}>
              <span className="muted">{closed[i] ? '▸' : '▾'}</span>
              <span className="mono grow ellipsis">{name}</span>
              <span className="add">+{add}</span>
              <span className="del">−{del}</span>
            </button>
            {!closed[i] && (
              <div className="diff-body" role="table">
                {rows.map((r, j) => {
                  const here = comments.filter((c) => c.file === name && c.line === r.n && r.kind !== 'hunk' && c.code === r.l);
                  const isEditing = editing && editing.file === name && editing.line === r.n && editing.code === r.l;
                  return (
                    <div key={j}>
                      <div className={`diff-line ${r.kind}`}>
                        <span className="ln">{r.kind === 'hunk' ? '' : r.n}</span>
                        <span className="code">{r.l || ' '}</span>
                        {r.kind !== 'hunk' && (
                          <button className="add-comment" aria-label={`${t.comment} ${name}:${r.n}`} onClick={() => (setEditing({ file: name, line: r.n, code: r.l, old: r.kind === 'rem' } as any), setDraft(''))}>
                            +
                          </button>
                        )}
                      </div>
                      {here.map((c, k) => (
                        <div key={k} className="line-comment">
                          <span className="grow">{c.text}</span>
                          <button className="icon-btn small" aria-label={t.delete} onClick={() => setComments(comments.filter((x) => x !== c))}>
                            <Icon name="x" size={12} />
                          </button>
                        </div>
                      ))}
                      {isEditing && (
                        <div className="line-comment editing">
                          <textarea
                            autoFocus
                            rows={2}
                            value={draft}
                            placeholder={t.comment}
                            onChange={(e) => setDraft(e.target.value)}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) (e.preventDefault(), save());
                              if (e.key === 'Escape') (e.stopPropagation(), setEditing(null));
                            }}
                          />
                          <div className="row-inline">
                            <button className="btn small ghost" onClick={() => setEditing(null)}>
                              {t.cancel}
                            </button>
                            <button className="btn small" disabled={!draft.trim()} onClick={save}>
                              {t.addComment}
                            </button>
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

/** Files the agent saved as proof. Images show inline; text opens in a new tab as plain text. */
function Evidence({ todo }: { todo: Todo }) {
  const files = (todo as any).evidence as { name: string; size: number; kind: string }[];
  const url = (n: string) => `/api/todos/${todo.number}/evidence/${encodeURIComponent(n)}`;
  return (
    <div className="evidence">
      {files.map((f) =>
        f.kind === 'image' ? (
          <a key={f.name} className="ev-image" href={url(f.name)} target="_blank" rel="noreferrer">
            <img src={url(f.name)} alt={f.name} loading="lazy" />
            <span className="tiny muted ellipsis">{f.name}</span>
          </a>
        ) : (
          <a key={f.name} className="ev-file" href={url(f.name)} target="_blank" rel="noreferrer">
            <Icon name="file" size={14} />
            <span className="grow ellipsis">{f.name}</span>
            <span className="tiny muted">{f.size < 1024 ? `${f.size} B` : `${Math.round(f.size / 1024)} KB`}</span>
          </a>
        ),
      )}
    </div>
  );
}

/** What the quality gates found: check results and the AI review. */
function Quality({ todo }: { todo: Todo }) {
  const t = useT();
  const [openOut, setOpenOut] = useState<number | null>(null);
  if (!todo.checks && !todo.review) return null;
  return (
    <div className="quality">
      {todo.checks && (
        <div className="q-block">
          <div className={`q-head ${todo.checks.passed ? 'ok' : 'bad'}`}>
            <Icon name={todo.checks.passed ? 'check' : 'x'} size={14} />
            <strong>{todo.checks.passed ? t.checksPassed : t.checksFailed}</strong>
            {todo.checks.fixes > 0 && (
              <span className="muted small">
                · {todo.checks.fixes} {t.fixRounds}
              </span>
            )}
          </div>
          {todo.checks.results.map((r, i) => (
            <div key={i} className="q-row">
              <button className="q-cmd" onClick={() => setOpenOut(openOut === i ? null : i)}>
                <span className={r.ok ? 'ok-dot' : 'bad-dot'} />
                <code>{r.command}</code>
                <span className="muted small grow-right">{duration(r.durationMs)}</span>
              </button>
              {openOut === i && <pre className="live-out">{r.output || '(no output)'}</pre>}
            </div>
          ))}
        </div>
      )}
      {todo.review && (
        <div className="q-block">
          <div className="q-head">
            <Icon name="spark" size={14} />
            <strong>{t.aiReview}</strong>
            <span className="muted small">
              · {t.reviewedBy} {todo.review.reviewer}
            </span>
          </div>
          {todo.review.summary && <p className="small q-summary">{todo.review.summary}</p>}
          {(todo.review as any).attempted?.length > 0 && (
            <div className="small muted">
              {(todo.review as any).attempted.map((f: any, i: number) => (
                <div key={i}>
                  {f.resolved ? '✓' : '…'} {f.title} <span className="tiny">({f.resolved ? t.autoFixed : t.attemptedFix})</span>
                </div>
              ))}
            </div>
          )}
          {todo.review.findings.length === 0 && !todo.review.summary && <p className="muted small">{t.noFindings}</p>}
          {todo.review.findings.map((f, i) => (
            <div key={i} className={`finding sev-${f.severity} ${f.fixed ? 'fixed' : ''}`}>
              <div className="finding-head">
                <span className={`sev sev-${f.severity}`}>{f.severity}</span>
                <strong className="grow">{f.title}</strong>
                {f.fixed && <span className="label label-infra">{t.autoFixed}</span>}
              </div>
              {f.file && (
                <div className="mono tiny muted">
                  {f.file}
                  {f.line ? `:${f.line}` : ''}
                </div>
              )}
              {f.detail && <div className="small">{f.detail}</div>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function PreviewButton({ todo, live, onError }: { todo: Todo; live?: { url: string }; onError: (e: string) => void }) {
  const t = useT();
  const [busy, setBusy] = useState(false);
  if (live)
    return (
      <span className="inline-row" style={{ gap: 2 }}>
        <a className="btn" href={live.url} target="_blank" rel="noreferrer">
          <Icon name="globe" size={13} /> {t.openPreview}
        </a>
        <button className="icon-btn" title={t.stopPreview} onClick={() => actions.stopPreview(todo.id)}>
          <Icon name="x" size={13} />
        </button>
      </span>
    );
  return (
    <button
      className="btn"
      disabled={busy}
      onClick={async () => {
        setBusy(true);
        onError('');
        // Open the tab now (still inside the click) and point it at the server once it answers.
        const tab = window.open('about:blank', '_blank');
        try {
          const { url } = await actions.startPreview(todo.id);
          if (tab) tab.location.href = url;
          else window.open(url, '_blank');
        } catch (e: any) {
          tab?.close();
          onError(e.message);
        } finally {
          setBusy(false);
        }
      }}
    >
      {busy ? <span className="spinner" /> : <Icon name="globe" size={13} />} {t.openPreview}
    </button>
  );
}

function QuestionCard({ todo }: { todo: Todo }) {
  const t = useT();
  const [other, setOther] = useState('');
  const [error, setError] = useState('');
  const answer = (text: string) => actions.act(todo.id, 'answer', { text }).catch((e) => setError(e.message));
  return (
    <div className="question">
      <div className="q-head">
        <Icon name="chat" size={14} /> <strong>{t.question}</strong>
      </div>
      <p>{todo.question!.text}</p>
      {todo.question!.recommend && <p className="muted small">{t.leadSuggests}: {todo.question!.recommend}</p>}
      <div className="q-options">
        {todo.question!.options.map((o) => (
          <button key={o} className="btn" onClick={() => answer(o)}>
            {o}
          </button>
        ))}
      </div>
      <form
        className="add-row"
        onSubmit={(e) => {
          e.preventDefault();
          if (other.trim()) answer(other.trim());
        }}
      >
        <input placeholder={t.answerOther} value={other} onChange={(e) => setOther(e.target.value)} />
        <button className="btn primary" disabled={!other.trim()}>
          {t.answer}
        </button>
      </form>
      {error && <div className="error-line">{error}</div>}
    </div>
  );
}

export function TodoDrawer({ state, id, onClose, onOpen }: { state: State; id: string; onClose: () => void; onOpen: (id: string) => void }) {
  const t = useT();
  const lang = useLang();
  const todo = state.todos.find((x) => x.id === id);
  const live = useLive(todo);
  const [reply, setReply] = useState('');
  const [error, setError] = useState('');
  const [title, setTitle] = useState(todo?.title || '');
  const [tab, setTab] = useState<'thread' | 'changes' | 'evidence'>('thread');
  const [comments, setComments] = useState<LineComment[]>([]);
  useEffect(() => setComments([]), [todo?.id]);
  const sendComments = () =>
    run(async () => {
      const body = comments.map((c, i) => `${i + 1}. ${c.file}:${c.line}${c.old ? ' (removed line, numbered in the old file)' : ''}\n   > ${c.code.slice(0, 200)}\n   ${c.text}`).join('\n\n');
      await actions.reply(todo!.id, `Review comments on the change:\n\n${body}`);
      setComments([]);
      setTab('thread');
    });
  const [note, setNote] = useState('');
  const [pending, setPending] = useState(false);
  const list = useRef<HTMLDivElement>(null);

  useEffect(() => setTitle(todo?.title || ''), [todo?.id, todo?.title]);
  useEffect(() => {
    list.current?.scrollTo({ top: list.current.scrollHeight });
  }, [todo?.messages.length, live]);
  const dialogRef = useDialog<HTMLElement>(onClose);

  if (!todo) return null;
  const agent = state.agents.find((a) => a.id === todo.agentId);
  const project = state.projects.find((p) => p.id === todo.projectId);
  const parent = todo.parentId ? state.todos.find((x) => x.id === todo.parentId) : null;
  const children = state.todos.filter((x) => x.parentId === todo.id);
  const running = todo.phase === 'planning' || todo.phase === 'building';

  const run = async (fn: () => Promise<unknown>) => {
    setError('');
    setPending(true);
    try {
      await fn();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setPending(false);
    }
  };
  const act = (a: string, extra?: Record<string, unknown>) => run(() => actions.act(todo.id, a, extra));
  const send = () => {
    const v = reply.trim();
    if (!v) return;
    setReply('');
    run(() => actions.reply(todo.id, v));
  };

  return (
    <div className="drawer-back" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <aside ref={dialogRef} className="drawer" role="dialog" aria-modal="true" aria-label={todo.title}>
        <header className="drawer-head">
          <span className="num">{todoKey(todo, state)}</span>
          <PhaseBadge phase={todo.phase} />
          {todo.stage && <span className="phase phase-building">{t[`stage_${todo.stage}` as keyof Dict]}</span>}
          <span className="grow" />
          <button className="icon-btn" title={t.delete} onClick={() => confirm(`${t.delete} #${todo.number}?`) && run(async () => (await actions.deleteTodo(todo.id), onClose()))}>
            <Icon name="trash" size={15} />
          </button>
          <button className="icon-btn" onClick={onClose} aria-label={t.closeSheet}>
            <Icon name="x" size={16} />
          </button>
        </header>
        <textarea
          className="title-input"
          rows={1}
          aria-label={t.title}
          value={title}
          ref={(el) => {
            if (el) {
              el.style.height = 'auto';
              el.style.height = `${el.scrollHeight}px`;
            }
          }}
          onChange={(e) => setTitle(e.target.value.replace(/\n/g, ' '))}
          onBlur={() => title.trim() && title !== todo.title && actions.updateTodo(todo.id, { title: title.trim() })}
          onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), (e.target as HTMLTextAreaElement).blur())}
        />
        <div className="drawer-props">
          <label>
            <Avatar name={agent?.name} color={agent?.color} size={18} />
            <select value={todo.agentId || ''} onChange={(e) => actions.updateTodo(todo.id, { agentId: e.target.value })}>
              {state.agents.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            <Icon name="folder" size={15} />
            <select value={todo.projectId || ''} disabled={!!todo.worktree} onChange={(e) => actions.updateTodo(todo.id, { projectId: e.target.value || null })}>
              <option value="">{t.noProject}</option>
              {state.projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>
        </div>

        <div className={`drawer-actions ${pending ? 'pending' : ''}`} aria-busy={pending}>
          {todo.phase === 'todo' && (
            <>
              <button className="btn primary" onClick={() => act('start', { mode: 'run' })}>
                <Icon name="play" size={13} /> {t.runNow}
              </button>
              <button className="btn" onClick={() => act('start', { mode: 'plan' })}>
                {t.planFirst}
              </button>
            </>
          )}
          {todo.phase === 'confirm' && (
            <button className="btn primary" onClick={() => act('confirm')}>
              <Icon name="check" size={14} /> {t.confirm}
            </button>
          )}
          {todo.phase === 'review' && (
            <>
              <button className="btn primary" onClick={() => act('done')}>
                <Icon name="check" size={14} /> {project?.delivery === 'pr' && todo.worktree ? t.deliverPr : t.markDone}
              </button>
              {todo.worktree && (
                <button className="btn" onClick={() => act('done', { merge: false })}>
                  {t.doneNoMerge}
                </button>
              )}
            </>
          )}
          {project?.preview && !running && (!project.git || todo.worktree || state.settings.useWorktrees === false) && !['done', 'closed', 'merging'].includes(todo.phase) && (
            <PreviewButton todo={todo} live={state.previews.find((p) => p.todoId === todo.id)} onError={setError} />
          )}
          {todo.pr && (
            <a className="btn ghost" href={todo.pr.url} target="_blank" rel="noreferrer">
              <Icon name="branch" size={13} /> PR #{todo.pr.number}
            </a>
          )}
          {(running || todo.phase === 'queued') && (
            <button className="btn" onClick={() => act('stop')}>
              <Icon name="stop" size={13} /> {t.stop}
            </button>
          )}
          {todo.phase === 'failed' && (
            <button className="btn primary" onClick={() => act('retry')}>
              <Icon name="retry" size={14} /> {t.retry}
            </button>
          )}
          {(todo.phase === 'done' || todo.phase === 'closed') && (
            <button className="btn" onClick={() => act('start')}>
              <Icon name="retry" size={14} /> {t.reopen}
            </button>
          )}
          {!['done', 'closed'].includes(todo.phase) && (
            <button className="btn ghost" onClick={() => act('close')}>
              {t.close}
            </button>
          )}
        </div>
        {error && (
          <div className="error-line pad-x" role="alert">
            {error}
          </div>
        )}
        {todo.leadPending && (
          <div className="merge-note small">
            <span className="spinner" /> {t.leadDecidingLong}
          </div>
        )}
        {!todo.leadPending && todo.leadAsk && todo.phase !== 'asking' && ['confirm', 'review', 'failed'].includes(todo.phase) && (
          <div className="question">
            <div className="q-head">
              <Icon name="chat" size={14} /> <strong>{t.leadAsks}</strong>
            </div>
            <p>{todo.leadAsk.text || todo.leadAsk.why}</p>
            {todo.leadAsk.recommend && <p className="muted small">{t.leadSuggests}: {todo.leadAsk.recommend}</p>}
            {(todo.leadAsk.blocks || []).map((b) => (
              <p key={b} className="muted small">{b}</p>
            ))}
          </div>
        )}
        {!todo.leadPending && todo.phase === 'asking' && todo.question && <QuestionCard todo={todo} />}
        {todo.phase === 'merging' && (
          <div className="merge-note small">
            <span className="spinner" /> {t.mergeQueue}: {Math.max(1, state.todos.filter((x) => x.phase === 'merging' && x.projectId === todo.projectId && ((x as any).mergeQueuedAt || '') <= ((todo as any).mergeQueuedAt || '')).length)} / {state.todos.filter((x) => x.phase === 'merging' && x.projectId === todo.projectId).length} {t.inQueue}
          </div>
        )}
        {(todo.diff || (todo as any).evidence?.length > 0) && (
          <div className="seg drawer-tabs">
            <button className={tab === 'thread' ? 'on' : ''} onClick={() => setTab('thread')}>
              {t.conversation}
            </button>
            {todo.diff && (
              <button className={tab === 'changes' ? 'on' : ''} onClick={() => setTab('changes')}>
                {t.changes} · {(todo.diff.match(/^diff --git /gm) || []).length}
              </button>
            )}
            {(todo as any).evidence?.length > 0 && (
              <button className={tab === 'evidence' ? 'on' : ''} onClick={() => setTab('evidence')}>
                {t.evidence} · {(todo as any).evidence.length}
              </button>
            )}
          </div>
        )}
        {tab === 'evidence' && (todo as any).evidence?.length ? (
          <div className="thread">
            <Evidence todo={todo} />
          </div>
        ) : tab === 'changes' && todo.diff ? (
          <div className="thread">
            {comments.length > 0 && (
              <div className="comment-bar">
                <span className="grow">
                  {comments.length} {t.commentsPending}
                </span>
                <button className="btn small ghost" onClick={() => setComments([])}>
                  {t.discard}
                </button>
                <button className="btn small primary" onClick={sendComments}>
                  {t.sendToAgent}
                </button>
              </div>
            )}
            <DiffView diff={todo.diff} comments={comments} setComments={setComments} />
          </div>
        ) : (
        <div className="thread" ref={list}>
          {parent && (
            <div className="small muted">
              {t.parentOf} <RichText text={`#${parent.number}`} state={state} onOpen={onOpen} /> {parent.title}
            </div>
          )}
          {todo.description && <div className="desc">{todo.description}</div>}
          {children.length > 0 && (
            <div className="small">
              <span className="muted">{t.subtasks}</span>{' '}
              {children.map((c) => (
                <span key={c.id} className="inline-row" style={{ marginRight: 12 }}>
                  <RichText text={`#${c.number}`} state={state} onOpen={onOpen} /> <PhaseBadge phase={c.phase} />
                </span>
              ))}
            </div>
          )}
          {(todo as any).event && (
            <div className="msg event">
              {(todo as any).event.url ? <a href={(todo as any).event.url} target="_blank" rel="noreferrer">{(todo as any).event.type}</a> : (todo as any).event.type}
              {'\n'}
              {(todo as any).event.text}
            </div>
          )}
          {todo.messages.filter((m) => !m.hidden && !(m.role === 'system' && !running && ((m.kind === 'checks' && todo.checks) || (m.kind === 'review' && todo.review)))).map((m) => {
            const a = state.agents.find((x) => x.id === m.agentId);
            return (
              <div key={m.id} className={`msg ${m.role} ${m.error ? 'err' : ''}`}>
                {m.role === 'agent' && (
                  <div className="msg-head">
                    <Avatar name={a?.name} color={a?.color} size={18} />
                    <strong>{a?.name || 'Agent'}</strong>
                    {m.kind === 'plan' && <span className="label">{t.plan}</span>}
                    {m.durationMs ? <span className="muted small">{duration(m.durationMs)}</span> : null}
                  </div>
                )}
                {m.role === 'user' && m.lead && (
                  <div className="msg-head">
                    <strong>{t.leadName}</strong>
                  </div>
                )}
                <div className="msg-body">
                  <RichText text={m.text} state={state} onOpen={onOpen} />
                </div>
                {m.role === 'user' && !m.lead && project && (
                  <div className="remember">
                    <button onClick={() => run(async () => (await actions.remember(project, 'decisions', m.text, todo.number), setNote(t.remembered)))}>{t.saveDecision}</button>
                    <button onClick={() => run(async () => (await actions.remember(project, 'declined', m.text, todo.number), setNote(t.remembered)))}>{t.saveDeclined}</button>
                  </div>
                )}
              </div>
            );
          })}
          {running && (
            <div className="msg agent live">
              <div className="msg-head">
                <Avatar name={agent?.name} color={agent?.color} size={18} />
                <strong>{agent?.name}</strong>
                <span className="spinner" />
                <span className="muted small">{t.liveOutput}</span>
              </div>
              {live && <pre className="live-out">{live.slice(-4000)}</pre>}
            </div>
          )}
          {!running && <Quality todo={todo} />}
          {note && <div className="muted small">{note}</div>}
          {todo.diffStat && todo.phase === 'review' && (
            <div className="msg system">
              <div className="msg-head">
                <strong>{t.changes}</strong>
              </div>
              <pre className="live-out">{todo.diffStat}</pre>
            </div>
          )}
        </div>
        )}

        <form
          className="composer drawer-composer"
          onSubmit={(e) => {
            e.preventDefault();
            send();
          }}
        >
          <textarea
            rows={2}
            value={reply}
            placeholder={running ? t.steerPlaceholder : t.replyPlaceholder}
            onChange={(e) => setReply(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                send();
              }
            }}
          />
          <div className="composer-row">
            <span className="grow" />
            <button className="send" type="submit" disabled={!reply.trim()} aria-label={t.send}>
              <Icon name="send" size={15} />
            </button>
          </div>
        </form>
      </aside>
    </div>
  );
}
