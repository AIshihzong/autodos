import { useEffect, useState } from 'react';
import { actions, ago, COLUMNS, Phase, State, Todo } from './api';
import { Dict, useLang, useT } from './i18n';
import { Avatar, Icon } from './icons';
import { useDialog } from './ui';

export function PhaseBadge({ phase }: { phase: Phase }) {
  const t = useT();
  return <span className={`phase phase-${phase}`}>{t[`ph_${phase}` as keyof Dict]}</span>;
}

/** A short key per todo, like an issue tracker: the project's initials and the number. */
export function todoKey(todo: Todo, state: State) {
  const name = state.projects.find((p) => p.id === todo.projectId)?.name || '';
  const prefix = (name.replace(/[^A-Za-z0-9]/g, '').slice(0, 4) || 'CB').toUpperCase();
  return `${prefix}-${todo.number}`;
}

/** Column / status glyph: dashed = not started, half = moving, ring = needs you, check = done. */
export function StatusIcon({ phase, size = 14 }: { phase: Phase | 'backlog' | 'progress' | 'needs'; size?: number }) {
  const kind = ['todo', 'backlog'].includes(phase) ? 'backlog' : ['queued', 'planning', 'building', 'merging', 'shipping', 'progress'].includes(phase) ? 'progress' : ['done'].includes(phase) ? 'done' : phase === 'closed' ? 'closed' : phase === 'failed' ? 'failed' : 'needs';
  const r = 6;
  return (
    <svg className={`status-icon si-${kind}`} width={size} height={size} viewBox="0 0 16 16" aria-hidden="true">
      {kind === 'backlog' && <circle cx="8" cy="8" r={r} fill="none" stroke="currentColor" strokeWidth="1.5" strokeDasharray="2 2.2" />}
      {kind === 'progress' && (
        <>
          <circle cx="8" cy="8" r={r} fill="none" stroke="currentColor" strokeWidth="1.5" />
          <path d={`M8 8 L8 ${8 - r + 2.5} A${r - 2.5} ${r - 2.5} 0 0 1 8 ${8 + r - 2.5} Z`} fill="currentColor" />
        </>
      )}
      {kind === 'needs' && (
        <>
          <circle cx="8" cy="8" r={r} fill="none" stroke="currentColor" strokeWidth="1.5" />
          <circle cx="8" cy="8" r="2.4" fill="currentColor" />
        </>
      )}
      {kind === 'failed' && (
        <>
          <circle cx="8" cy="8" r={r + 0.75} fill="currentColor" />
          <path d="M8 4.8v3.6M8 10.6v.2" stroke="var(--panel)" strokeWidth="1.6" strokeLinecap="round" />
        </>
      )}
      {kind === 'done' && (
        <>
          <circle cx="8" cy="8" r={r + 0.75} fill="currentColor" />
          <path d="M5.3 8.2l1.8 1.8 3.6-3.8" fill="none" stroke="var(--panel)" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
        </>
      )}
      {kind === 'closed' && <circle cx="8" cy="8" r={r} fill="none" stroke="currentColor" strokeWidth="1.5" />}
    </svg>
  );
}

function Card({ todo, state, onOpen }: { todo: Todo; state: State; onOpen: (id: string) => void }) {
  const lang = useLang();
  const t = useT();
  const agent = state.agents.find((a) => a.id === todo.agentId);
  const running = ['planning', 'building'].includes(todo.phase) || !!todo.stage;
  const attention = !['todo', 'done', 'closed'].includes(todo.phase);
  const flagged = todo.phase === 'review' && ((todo.checks && !todo.checks.passed) || todo.review?.findings.some((f) => !(f as any).fixed && f.severity !== 'low'));
  return (
    <article
      className={`card ${running ? 'running' : ''}`}
      draggable
      tabIndex={0}
      onDragStart={(e) => e.dataTransfer.setData('text/todo', todo.id)}
      onClick={() => onOpen(todo.id)}
      onKeyDown={(e) => e.key === 'Enter' && onOpen(todo.id)}
    >
      <div className="card-key">
        <span>{todoKey(todo, state)}</span>
        {todo.pr && <Icon name="branch" size={12} />}
        {flagged && <span className="flag" title={t.checks}>!</span>}
      </div>
      <div className="card-title">{todo.title}</div>
      {attention && (
        <div className="card-foot">
          <Avatar name={agent?.name} color={agent?.color} size={18} />
          <span className="ellipsis">{agent?.name}</span>
          <span className="grow" />
          <span className="muted">{todo.leadPending ? t.leadDeciding : todo.stage ? t[`stage_${todo.stage}` as keyof Dict] : todo.phase === 'asking' || todo.phase === 'failed' ? t[`ph_${todo.phase}` as keyof Dict] : ago(todo.updatedAt, lang)}</span>
        </div>
      )}
      {running && <div className="progress-bar" />}
    </article>
  );
}

export function Board({ state, filter, projectId, onOpen, only, onCreate }: { state: State; filter: string; projectId: string | null; onOpen: (id: string) => void; only?: (t: Todo) => boolean; onCreate?: () => void }) {
  const t = useT();
  const [over, setOver] = useState<string | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    if (!error) return;
    const h = setTimeout(() => setError(''), 6000);
    return () => clearTimeout(h);
  }, [error]);
  const q = filter.trim().toLowerCase();
  const todos = state.todos
    .filter((x) => !projectId || x.projectId === projectId)
    .filter((x) => !only || only(x))
    .filter((x) => !q || `${todoKey(x, state)} ${x.title} ${x.labels.join(' ')} ${state.agents.find((a) => a.id === x.agentId)?.name || ''}`.toLowerCase().includes(q))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const weekAgo = Date.now() - 7 * 864e5;

  const drop = async (col: (typeof COLUMNS)[number], id: string) => {
    setOver(null);
    const todo = state.todos.find((x) => x.id === id);
    if (!todo || col.phases.includes(todo.phase)) return;
    try {
      setError('');
      await actions.act(id, 'phase', { phase: col.drop });
    } catch (e: any) {
      setError(e.message);
    }
  };

  return (
    <div className="board-wrap">
      {error && (
        <div className="toast err" role="status" aria-live="polite" onClick={() => setError('')}>
          {error}
        </div>
      )}
      <div className="board">
        {COLUMNS.map((col) => {
          // A todo the project's lead is deciding on is still the team's, not yours.
          let items = todos.filter((x) => (x.leadPending ? col.key === 'progress' : col.phases.includes(x.phase)));
          if (col.key === 'done') items = items.filter((x) => Date.parse(x.updatedAt) > weekAgo);
          return (
            <section
              key={col.key}
              className={`column col-${col.key} ${over === col.key ? 'over' : ''}`}
              onDragOver={(e) => {
                e.preventDefault();
                setOver(col.key);
              }}
              onDragLeave={() => setOver(null)}
              onDrop={(e) => drop(col, e.dataTransfer.getData('text/todo'))}
            >
              <header>
                <StatusIcon phase={col.key as any} />
                <span>{t[`col_${col.key}` as keyof Dict]}</span>
                <span className="count">{items.length}</span>
                <span className="grow" />
                {col.key === 'backlog' && onCreate && (
                  <button className="icon-btn small" title={t.newTodo} onClick={onCreate}>
                    <Icon name="plus" size={15} />
                  </button>
                )}
              </header>
              <div className="cards">
                {col.key === 'backlog' && items.length === 0 && onCreate && (
                  <button className="empty-add" onClick={onCreate}>
                    <Icon name="plus" size={15} /> {t.newTodo}
                  </button>
                )}
                {items.map((x) => (
                  <Card key={x.id} todo={x} state={state} onOpen={onOpen} />
                ))}
              </div>
            </section>
          );
        })}
      </div>
    </div>
  );
}

export function NewTodo({ state, projectId, onClose, onCreated }: { state: State; projectId: string | null; onClose: () => void; onCreated: (id: string) => void }) {
  const t = useT();
  const [form, setForm] = useState({
    title: '',
    description: '',
    agentId: '',
    projectId: projectId || state.projects[0]?.id || '',
    mode: state.settings.planFirst ? 'plan' : 'run',
    labels: '',
    start: true,
  });
  const ref = useDialog<HTMLFormElement>(onClose);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const set = (k: string, v: any) => setForm((f) => ({ ...f, [k]: v }));
  const submit = async () => {
    if (!form.title.trim() || busy) return;
    setBusy(true);
    try {
      const labels = form.labels.split(/[,，\s]+/).filter(Boolean);
      const todo = await actions.createTodo({ title: form.title, description: form.description, agentId: form.agentId || undefined, projectId: form.projectId || null, labels, mode: form.mode as 'plan' | 'run', start: form.start } as any);
      onCreated(todo.id);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };
  // Compose like an issue tracker: a big title, a quiet description, properties as a row of chips.
  return (
    <div className="modal-back top" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <form
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-label={t.newTodo}
        className="modal compose"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <div className="compose-crumb small muted">
          <Icon name="work" size={14} /> {state.projects.find((p) => p.id === form.projectId)?.name || t.noProject} › {t.newTodo}
        </div>
        <input
          autoFocus
          className="compose-title"
          aria-label={t.title}
          placeholder={t.title}
          value={form.title}
          onChange={(e) => set('title', e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && (e.metaKey || e.ctrlKey) && (e.preventDefault(), submit())}
        />
        <textarea className="compose-desc" aria-label={t.description} placeholder={t.description} rows={4} value={form.description} onChange={(e) => set('description', e.target.value)} />
        <div className="compose-props">
          <select className="chip-select" aria-label={t.agent} value={form.agentId} onChange={(e) => set('agentId', e.target.value)}>
            <option value="">{t.agent}: {t.auto}</option>
            {state.agents.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
          <select className="chip-select" aria-label={t.project} value={form.projectId} onChange={(e) => set('projectId', e.target.value)}>
            <option value="">{t.noProject}</option>
            {state.projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
          <select className="chip-select" aria-label={t.mode} value={form.mode} onChange={(e) => set('mode', e.target.value)}>
            <option value="run">{t.runNow}</option>
            <option value="plan">{t.planFirst}</option>
          </select>
          <input className="chip-input" aria-label={t.labels} placeholder={`${t.labels}…`} value={form.labels} onChange={(e) => set('labels', e.target.value)} />
        </div>
        {error && (
          <div className="error-line" role="alert">
            {error}
          </div>
        )}
        <div className="compose-foot">
          <label className="inline-row small muted">
            <input type="checkbox" checked={form.start} onChange={(e) => set('start', e.target.checked)} /> {t.startNow}
          </label>
          <span className="grow" />
          <kbd>⌘ ⏎</kbd>
          <button type="submit" className="btn primary" disabled={!form.title.trim() || busy}>
            {busy ? <span className="spinner" /> : null} {t.create}
          </button>
        </div>
      </form>
    </div>
  );
}
