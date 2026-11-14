// My staff (every agent on every machine) and About you (what Autodos learned from them).
import { useEffect, useMemo, useState } from 'react';
import { actions, ago, Note, StaffMachine, StaffMember, State } from './api';
import { useLang, useT } from './i18n';
import { Icon } from './icons';
import { useError } from './pages';
import { EmptyState, Group, Switch, Tabs } from './ui';

const fill = (s: string, v: Record<string, string | number>) => s.replace(/\{(\w+)\}/g, (_, k) => String(v[k] ?? ''));

function MemberRow({ m, machine }: { m: StaffMember; machine: StaffMachine }) {
  const t = useT();
  const lang = useLang();
  const [open, setOpen] = useState(false);
  const { error, guard } = useError();
  const sub = !m.present ? t.staffNotHere : [fill(t.staffSessions, { n: m.sessions }), m.lastAt ? fill(t.staffLast, { t: ago(m.lastAt, lang) }) : '', m.allowed && m.notes ? fill(t.staffLearned, { n: m.notes }) : ''].filter(Boolean).join(' · ');
  const more = m.allowed && (m.projects.length > 0 || m.recent.length > 0);
  return (
    <div className="g-row stack">
      <div className="staff-row">
        <button className="staff-name" onClick={() => more && setOpen(!open)} aria-expanded={more ? open : undefined} disabled={!more}>
          <strong>{m.name}</strong>
          <span className="muted small">{sub}</span>
        </button>
        <Switch checked={m.allowed} label={`${t.staffAllow} · ${m.name} · ${machine.name}`} onChange={(v) => guard(() => actions.staffConsent(machine.id, m.kind, v))()} />
      </div>
      {error && <div className="error-line">{error}</div>}
      {open && (
        <div className="staff-more">
          {m.projects.length > 0 && (
            <div>
              <div className="small muted">{t.staffProjects}</div>
              <div className="chips">
                {m.projects.map((p) => (
                  <span key={p.cwd} className={`chip ${p.projectId ? 'ok' : ''}`} title={p.cwd}>
                    {p.name || t.otherFolder} · {p.sessions}
                  </span>
                ))}
              </div>
            </div>
          )}
          {m.recent.length > 0 && (
            <div>
              <div className="small muted">{t.staffRecent}</div>
              {m.recent.map((r) => (
                <div key={r.id} className="staff-recent" title={r.cwd}>
                  <span className="ellipsis">{r.title}</span>
                  <span className="muted small">{r.at ? ago(r.at, lang) : ''}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export function StaffPage({ state }: { state: State }) {
  const t = useT();
  const lang = useLang();
  const { error, guard } = useError();
  const view = state.staff;
  if (!view) return null;
  const status = (m: StaffMachine) =>
    m.scanning ? t.staffScanning : m.pending && !m.local ? t.staffPending : m.scannedAt ? fill(t.staffScanned, { t: ago(m.scannedAt, lang) }) : t.staffNever;
  return (
    <div className="page">
      <header className="page-head">
        <h1>{t.staffTitle}</h1>
        <button className="btn" onClick={guard(() => actions.staffScan())}>
          <Icon name="retry" size={14} /> {t.staffScan}
        </button>
      </header>
      <div className="narrow-col">
        <p className="muted staff-intro">{t.staffIntro}</p>
        {error && <div className="error-line">{error}</div>}
        {view.machines.map((m) => {
          const members = view.kinds.map((k) => view.members.find((x) => x.id === `${m.id}:${k.id}`)).filter(Boolean) as StaffMember[];
          return (
            <Group
              key={m.id}
              title={m.local ? `${m.name} · ${t.thisMac}` : m.name}
              action={
                <span className="muted small">
                  {!m.local && m.online === false ? `${t.staffOffline} · ` : ''}
                  {status(m)}
                  {m.remaining ? ` · ${fill(t.staffRemaining, { n: m.remaining })}` : ''}
                </span>
              }
            >
              {m.error && <div className="g-row error-line">{m.error}</div>}
              {members.length ? members.map((x) => <MemberRow key={x.id} m={x} machine={m} />) : <div className="g-row muted small">{status(m)}</div>}
            </Group>
          );
        })}
        {view.machines.length === 1 && <p className="muted small">{t.staffNoMachines}</p>}
      </div>
    </div>
  );
}

function NoteRow({ n, state }: { n: Note; state: State }) {
  const t = useT();
  const lang = useLang();
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(n.text);
  const [open, setOpen] = useState(false);
  const { error, guard } = useError();
  const kindName = (k: string | null) => state.staff?.kinds.find((x) => x.id === k)?.name || '';
  const src = n.sources[0];
  return (
    <div className="g-row stack">
      <div className="staff-row">
        {editing ? (
          <form
            className="grow note-edit"
            onSubmit={(e) => {
              e.preventDefault();
              guard(async () => (await actions.editNote(n.id, { text }), setEditing(false)))();
            }}
          >
            <input className="ghost-input grow" autoFocus value={text} onChange={(e) => setText(e.target.value)} aria-label={t.edit} />
            <button className="btn small" disabled={!text.trim()}>
              {t.save}
            </button>
          </form>
        ) : (
          <button className={`note-text ${n.status === 'removed' ? 'muted' : ''}`} onClick={() => n.status === 'active' && setEditing(true)} title={n.status === 'active' ? t.edit : ''}>
            {n.text}
          </button>
        )}
        {n.status === 'active' ? (
          <button className="icon-btn" aria-label={t.delete} onClick={guard(() => actions.removeNote(n.id))}>
            <Icon name="x" size={13} />
          </button>
        ) : (
          <button className="btn small ghost" onClick={guard(() => actions.editNote(n.id, { status: 'active' }))}>
            {t.noteRestore}
          </button>
        )}
      </div>
      <div className="note-meta small muted">
        <span>{t[`noteBy_${n.by}` as 'noteBy_you']}</span>
        {n.count > 1 && <span>{fill(t.noteTimes, { n: n.count })}</span>}
        {src && (
          <button className="link-btn" onClick={() => setOpen(!open)} aria-expanded={open}>
            {t.noteFrom} {kindName(src.kind)} · {src.machineName}
            {src.quote ? ` · “${src.quote}”` : ''}
          </button>
        )}
        <span>{ago(src?.at || n.updatedAt, lang)}</span>
      </div>
      {open && (
        <div className="staff-more">
          <div className="small muted">{t.noteSources}</div>
          {n.sources.map((s, i) => (
            <div key={i} className="note-source small">
              <div>
                {kindName(s.kind)} · {s.machineName} · {s.at ? ago(s.at, lang) : ''}
              </div>
              {s.sessionTitle && <div className="muted">{s.sessionTitle}</div>}
              {s.quote && <blockquote>{s.quote}</blockquote>}
              {s.cwd && <div className="muted mono ellipsis">{s.cwd}</div>}
            </div>
          ))}
        </div>
      )}
      {error && <div className="error-line">{error}</div>}
    </div>
  );
}

export function AboutYouPage({ state }: { state: State }) {
  const t = useT();
  const [tab, setTab] = useState<'you' | 'project' | 'agent' | 'removed'>('you');
  const [notes, setNotes] = useState<Note[]>([]);
  const [draft, setDraft] = useState('');
  const { error, guard } = useError();
  const counts = JSON.stringify(state.staff?.notes || {});
  const [tick, setTick] = useState(0);
  useEffect(() => {
    actions.notes().then((r) => setNotes(r.notes), () => {});
  }, [counts, tick]);
  const refresh = () => setTick((x) => x + 1);
  const shown = notes.filter((n) => (tab === 'removed' ? n.status === 'removed' : n.status === 'active' && n.scope === tab));
  // Project and agent notes are grouped under the project or the agent they are about.
  const groups = useMemo(() => {
    if (tab === 'you' || tab === 'removed') return [{ key: '', title: '', items: shown }];
    const by = new Map<string, Note[]>();
    for (const n of shown) {
      const k = tab === 'project' ? n.projectId || n.cwd.split('/').pop() || '' : n.staffId || '';
      by.set(k, [...(by.get(k) || []), n]);
    }
    return [...by.entries()].map(([key, items]) => {
      let title = key || t.otherFolder;
      if (tab === 'project') title = state.projects.find((p) => p.id === key)?.name || title;
      else {
        const m = state.staff?.members.find((x) => x.id === key);
        if (m) title = `${m.name} · ${m.machineName}`;
      }
      return { key, title, items };
    });
  }, [notes, tab, state.projects, state.staff]);
  const count = (k: 'you' | 'project' | 'agent' | 'removed') => notes.filter((n) => (k === 'removed' ? n.status === 'removed' : n.status === 'active' && n.scope === k)).length;
  return (
    <div className="page">
      <header className="page-head">
        <h1>{t.youTitle}</h1>
      </header>
      <Tabs
        value={tab}
        onChange={setTab}
        tabs={[
          { key: 'you', label: t.notesYou, count: count('you') || undefined },
          { key: 'project', label: t.notesProject, count: count('project') || undefined },
          { key: 'agent', label: t.notesAgent, count: count('agent') || undefined },
          { key: 'removed', label: t.notesRemoved, count: count('removed') || undefined },
        ]}
      />
      <div className="narrow-col" onClick={(e) => (e.target as HTMLElement).closest('button') && setTimeout(refresh, 300)}>
        <p className="muted staff-intro">{t.youIntro}</p>
        {error && <div className="error-line">{error}</div>}
        {tab === 'you' && (
          <form
            className="g-row note-add"
            onSubmit={(e) => {
              e.preventDefault();
              if (!draft.trim()) return;
              guard(async () => (await actions.addNote(draft.trim()), setDraft(''), refresh()))();
            }}
          >
            <input className="ghost-input grow" value={draft} placeholder={t.addNoteYou} aria-label={t.addNoteYou} onChange={(e) => setDraft(e.target.value)} />
            <button className="btn small" disabled={!draft.trim()}>
              {t.add}
            </button>
          </form>
        )}
        {shown.length === 0 ? (
          <EmptyState icon="spark" text={t.notesEmpty} />
        ) : (
          groups.map((g) => (
            <Group key={g.key || 'all'} title={g.title || undefined}>
              {g.items.map((n) => (
                <NoteRow key={n.id + n.updatedAt} n={n} state={state} />
              ))}
            </Group>
          ))
        )}
      </div>
    </div>
  );
}
