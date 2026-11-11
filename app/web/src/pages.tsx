import { useEffect, useState } from 'react';
import { actions, Agent, ago, Commit, duration, FileEntry, Project, Retro, Rule, State } from './api';
import { Dict, Lang, useLang, useT } from './i18n';
import { Avatar, Icon } from './icons';
import { todoKey } from './Board';
import { EmptyState, Group, Num, PageHead, Row, Sheet, Switch, Tabs } from './ui';

export function useError() {
  const [error, setError] = useState('');
  const guard = (fn: () => Promise<unknown>) => async () => {
    setError('');
    try {
      await fn();
    } catch (e: any) {
      setError(e.message);
    }
  };
  return { error, guard };
}

export function RuntimeSelect({ value, state, onChange, global = false, machine = '' }: { value: string; state: State; onChange: (v: string) => void; global?: boolean; machine?: string }) {
  const t = useT();
  const remote = machine ? state.workers.find((w) => w.id === machine) : null;
  // On another machine, what counts is what that machine reported, not what this Mac has.
  const available = (id: string) => (remote ? !remote.runtimes || remote.runtimes.includes(id) : !!state.runtimes.find((r) => r.id === id)?.available);
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)}>
      <option value="auto">{global ? t.autoBest : t.auto}</option>
      {state.runtimes.map((r) => (
        <option key={r.id} value={r.id} disabled={!available(r.id)}>
          {r.name}
          {available(r.id) ? '' : ` (${t.notInstalled})`}
        </option>
      ))}
    </select>
  );
}

// ---------------- Projects ----------------
function ProjectDetail({ project, state, onBack }: { project: Project; state: State; onBack: () => void }) {
  const t = useT();
  const lang = useLang();
  const [tab, setTab] = useState<'files' | 'history' | 'settings' | 'memory'>('files');
  const [dir, setDir] = useState('');
  const [entries, setEntries] = useState<FileEntry[]>([]);
  const [file, setFile] = useState<{ path: string; text: string; binary: boolean; truncated: boolean } | null>(null);
  const [commits, setCommits] = useState<Commit[]>([]);
  const [error, setError] = useState('');
  useEffect(() => {
    actions.projectFiles(project.id, dir).then(setEntries, (e) => setError(e.message));
  }, [project.id, dir]);
  useEffect(() => {
    if (tab === 'history') actions.projectHistory(project.id).then(setCommits, (e) => setError(e.message));
  }, [project.id, tab, state.todos.filter((x) => x.phase === 'done').length]);
  const crumbs = dir ? dir.split('/') : [];
  const memCount = (project.memory?.decisions.length || 0) + (project.memory?.declined.length || 0);
  return (
    <div className="page wide-page">
      <PageHead
        title={project.name}
        crumb={
          <button className="ref" onClick={onBack}>
            {t.projects}
          </button>
        }
      >
        <span className="chip">{project.git ? t.gitRepo : t.plainFolder}</span>
        <span className="chip">{project.delivery === 'pr' ? t.deliverPr : t.deliverMerge}</span>
      </PageHead>
      <Tabs
        value={tab}
        onChange={setTab}
        tabs={[
          { key: 'files', label: t.files },
          { key: 'history', label: t.history },
          { key: 'settings', label: t.projectSettings },
          { key: 'memory', label: t.memory, count: memCount || undefined },
        ]}
      />
      {error && <div className="error-line">{error}</div>}
      {tab === 'settings' ? (
        <ChecksEditor project={project} />
      ) : tab === 'memory' ? (
        <MemoryEditor project={project} />
      ) : tab === 'files' ? (
        <div className="explorer">
          <div className="file-list">
            <div className="crumbs small">
              <button className="ref" onClick={() => setDir('')}>
                {project.name}
              </button>
              {crumbs.map((c, i) => (
                <span key={i}>
                  {' / '}
                  <button className="ref" onClick={() => setDir(crumbs.slice(0, i + 1).join('/'))}>
                    {c}
                  </button>
                </span>
              ))}
            </div>
            {entries.length === 0 && <p className="empty">{t.emptyFolder}</p>}
            {entries.map((e) => (
              <button
                key={e.path}
                className={`file-row ${file?.path === e.path ? 'on' : ''}`}
                onClick={() => (e.dir ? (setDir(e.path), setFile(null)) : actions.projectFile(project.id, e.path).then(setFile, (er) => setError(er.message)))}
              >
                <Icon name={e.dir ? 'folder' : 'file'} size={14} /> <span className="ellipsis">{e.name}</span>
              </button>
            ))}
          </div>
          <div className="file-view">
            {!file && <EmptyState icon="file" text={t.pickFile} />}
            {file && (
              <>
                <div className="file-view-head mono small">
                  {file.path}
                  {file.truncated && <span className="muted"> · {t.truncatedFile}</span>}
                </div>
                {file.binary ? <p className="muted pad">{t.binaryFile}</p> : <pre className="code">{file.text}</pre>}
              </>
            )}
          </div>
        </div>
      ) : commits.length === 0 ? (
        <EmptyState icon="branch" text={project.git ? t.noCommits : t.notGit} />
      ) : (
        <div className="table-list">
          {commits.map((c) => (
            <div key={c.hash} className="tl-row static simple">
              <span className="num">{c.hash}</span>
              <span className="ellipsis">{c.subject}</span>
              <span className="muted small">{c.author}</span>
              <span className="muted small">{ago(c.date, lang)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function ChecksEditor({ project }: { project: Project }) {
  const t = useT();
  const lines = (x: string) => x.split('\n').map((l) => l.trim()).filter(Boolean);
  const initial = {
    checks: (project.checks || []).join('\n'),
    preview: project.preview || '',
    delivery: project.delivery || 'merge',
    baseBranch: project.baseBranch || '',
    branchTemplate: project.branchTemplate || '',
    setup: project.setup || '',
    pushBase: !!project.pushBase,
    accept: !!project.autopilot?.accept,
    maxFiles: project.autopilot?.maxFiles || 0,
    protectedPaths: (project.protectedPaths || []).join('\n'),
    leadDecide: !!project.lead?.decide,
    ownerPaths: (project.lead?.ownerPaths || []).join('\n'),
    analyst: !!project.analyst,
    knowledge: (project.knowledge || []).join('\n'),
    backlogFile: project.backlog?.file || '',
    backlogOpen: project.backlog?.maxOpen || 1,
    upstreamUrl: project.upstream?.url || '',
    upstreamBranch: project.upstream?.branch || 'main',
    upstreamEvery: project.upstream?.every ?? 60,
  };
  const [v, setV] = useState(initial);
  const [note, setNote] = useState('');
  const { error, guard } = useError();
  const dirty = JSON.stringify(v) !== JSON.stringify(initial);
  // autodos.json was loaded (or something else changed the project): show what is saved now.
  useEffect(() => setV(initial), [JSON.stringify(initial)]);
  const patch = () => ({
    id: project.id,
    checks: lines(v.checks),
    preview: v.preview.trim(),
    delivery: v.delivery,
    baseBranch: v.baseBranch.trim(),
    branchTemplate: v.branchTemplate.trim(),
    setup: v.setup.trim(),
    pushBase: v.pushBase,
    autopilot: { ...(project.autopilot || {}), accept: v.accept, maxFiles: v.maxFiles },
    protectedPaths: lines(v.protectedPaths),
    lead: { ...(project.lead || {}), decide: v.leadDecide, ownerPaths: lines(v.ownerPaths) },
    analyst: v.analyst,
    knowledge: lines(v.knowledge),
    backlog: v.backlogFile.trim() ? { ...(project.backlog || {}), file: v.backlogFile.trim(), maxOpen: v.backlogOpen } : null,
    upstream: v.upstreamUrl.trim() ? { ...(project.upstream || {}), url: v.upstreamUrl.trim(), branch: v.upstreamBranch.trim() || 'main', every: v.upstreamEvery } : null,
  });
  const up = project.upstream;
  return (
    <div className="narrow-col">
      {project.configStale && <div className="error-line">{t.configStale}</div>}
      <Group title={t.checks} action={<button className="btn small ghost" onClick={guard(async () => {
        const [checks, preview] = await Promise.all([actions.detectChecks(project.id), actions.detectPreview(project.id)]);
        setV({ ...v, checks: v.checks || checks.join('\n'), preview: v.preview || preview.command });
      })}>{t.detect}</button>}>
        <div className="g-row stack">
          <textarea className="checks-edit" rows={4} value={v.checks} placeholder={'npm run lint\nnpm test'} onChange={(e) => setV({ ...v, checks: e.target.value })} aria-label={t.checks} />
        </div>
      </Group>
      <Group>
        <Row label={t.previewCmd}>
          <input className="mono" value={v.preview} placeholder="npm run dev -- --port {port}" onChange={(e) => setV({ ...v, preview: e.target.value })} aria-label={t.previewCmd} />
        </Row>
        <Row label={t.delivery}>
          <div className="seg">
            {(['merge', 'pr'] as const).map((k) => (
              <button key={k} className={v.delivery === k ? 'on' : ''} onClick={() => setV({ ...v, delivery: k })}>
                {k === 'merge' ? t.deliverMerge : t.deliverPr}
              </button>
            ))}
          </div>
        </Row>
      </Group>
      {project.git && (
        <Group title={t.branches}>
          <Row label={t.baseBranch} sub={t.baseBranchHint}>
            <input className="mono" value={v.baseBranch} placeholder="main" onChange={(e) => setV({ ...v, baseBranch: e.target.value })} aria-label={t.baseBranch} />
          </Row>
          <Row label={t.branchTemplate} sub={t.branchTemplateHint}>
            <input className="mono" value={v.branchTemplate} placeholder="autodos/todo-{number}" onChange={(e) => setV({ ...v, branchTemplate: e.target.value })} aria-label={t.branchTemplate} />
          </Row>
          <Row label={t.setupCmd} sub={t.setupCmdHint}>
            <input className="mono" value={v.setup} placeholder="npm ci" onChange={(e) => setV({ ...v, setup: e.target.value })} aria-label={t.setupCmd} />
          </Row>
          <Row label={t.pushBase}>
            <Switch checked={v.pushBase} onChange={(x) => setV({ ...v, pushBase: x })} label={t.pushBase} />
          </Row>
        </Group>
      )}
      <Group title={t.teamRoles}>
        <Row label={t.leadDecides} sub={t.leadDecidesHint}>
          <Switch checked={v.leadDecide} onChange={(x) => setV({ ...v, leadDecide: x })} label={t.leadDecides} />
        </Row>
        {v.leadDecide && (
          <div className="g-row stack">
            <label className="g-label">
              <span>{t.ownerPaths}</span>
              <small>{t.ownerPathsHint}</small>
            </label>
            <textarea className="checks-edit" rows={3} value={v.ownerPaths} placeholder={'deploy/*\n*.env\ndatabase/migrations/*'} onChange={(e) => setV({ ...v, ownerPaths: e.target.value })} aria-label={t.ownerPaths} />
          </div>
        )}
        <Row label={t.analystOn} sub={t.analystHint}>
          <Switch checked={v.analyst} onChange={(x) => setV({ ...v, analyst: x })} label={t.analystOn} />
        </Row>
        <div className="g-row stack">
          <label className="g-label">
            <span>{t.knowledge}</span>
            <small>{t.knowledgeHint}</small>
          </label>
          <textarea className="checks-edit" rows={3} value={v.knowledge} placeholder={'docs/PROJECT_BRIEF.md\ndocs/requirements/'} onChange={(e) => setV({ ...v, knowledge: e.target.value })} aria-label={t.knowledge} />
        </div>
        {!!project.leadLog?.length && (
          <div className="g-row stack">
            <label className="g-label">
              <span>{t.leadLog}</span>
            </label>
            {project.leadLog.slice(-8).reverse().map((x, i) => (
              <small key={i} className="muted">
                #{x.todo} {x.title} · {(t as any)[`lead_${x.decision}`] || x.decision}
                {x.why ? `: ${x.why}` : ''}
              </small>
            ))}
          </div>
        )}
      </Group>
      {project.git && (
        <Group
          title={t.unattended}
          action={
            <button
              className="btn small ghost"
              onClick={guard(async () => {
                const r = await actions.loadConfig(project.id);
                setNote([`${t.configLoaded}: ${r.applied.join(', ')}`, ...r.warnings].join(' · '));
              })}
            >
              {t.loadConfig}
            </button>
          }
        >
          <Row label={t.autoAccept} sub={t.autoAcceptHint}>
            <Switch checked={v.accept} onChange={(x) => setV({ ...v, accept: x })} label={t.autoAccept} />
          </Row>
          {v.accept && (
            <Row label={t.maxFiles} sub={t.noLimit}>
              <Num value={v.maxFiles} min={0} max={100000} onChange={(x) => setV({ ...v, maxFiles: x })} unit={t.filesUnit} label={t.maxFiles} />
            </Row>
          )}
          <div className="g-row stack">
            <label className="g-label">
              <span>{t.protectedPaths}</span>
              <small>{t.protectedPathsHint}</small>
            </label>
            <textarea className="checks-edit" rows={3} value={v.protectedPaths} placeholder={'deploy/*\n.github/workflows/*\n*.env'} onChange={(e) => setV({ ...v, protectedPaths: e.target.value })} aria-label={t.protectedPaths} />
          </div>
          <Row label={t.backlogFile} sub={project.backlog?.lastError || (project.backlog?.left != null ? `${project.backlog.left} ${t.backlogLeft}` : t.backlogHint)}>
            <input className="mono" value={v.backlogFile} placeholder="docs/BACKLOG.md" onChange={(e) => setV({ ...v, backlogFile: e.target.value })} aria-label={t.backlogFile} />
          </Row>
          {v.backlogFile.trim() && (
            <Row label={t.backlogOpen}>
              <Num value={v.backlogOpen} min={1} max={20} onChange={(x) => setV({ ...v, backlogOpen: x })} label={t.backlogOpen} />
            </Row>
          )}
          <Row label={t.upstreamRepo} sub={t.upstreamHint}>
            <input className="mono" value={v.upstreamUrl} placeholder="https://github.com/owner/repo" onChange={(e) => setV({ ...v, upstreamUrl: e.target.value })} aria-label={t.upstreamRepo} />
          </Row>
          {v.upstreamUrl.trim() && (
            <>
              <Row label={t.upstreamBranch}>
                <input className="mono" value={v.upstreamBranch} onChange={(e) => setV({ ...v, upstreamBranch: e.target.value })} aria-label={t.upstreamBranch} />
              </Row>
              <Row label={t.upstreamEvery} sub={up?.lastAt ? `${t.lastSync}: ${up.lastResult || ''}${up.lastError ? ` (${up.lastError})` : ''}` : undefined}>
                <Num value={v.upstreamEvery} min={0} max={10080} onChange={(x) => setV({ ...v, upstreamEvery: x })} unit={t.minutesShort} label={t.upstreamEvery} />
                {up?.url && !dirty && (
                  <button className="btn small ghost" onClick={guard(async () => setNote(`${t.lastSync}: ${(await actions.syncUpstream(project.id)).state}`))}>
                    {t.syncNow}
                  </button>
                )}
              </Row>
            </>
          )}
          <div className="g-row">
            <small className="muted">{note || t.configHint}</small>
          </div>
        </Group>
      )}
      <div className="form-foot">
        {error && <span className="error-line">{error}</span>}
        <span className="grow" />
        <button className="btn primary" disabled={!dirty} onClick={guard(() => actions.save('projects', patch()))}>
          {t.save}
        </button>
      </div>
    </div>
  );
}

function MemoryEditor({ project }: { project: Project }) {
  const t = useT();
  const [draft, setDraft] = useState({ decisions: '', declined: '' });
  const { error, guard } = useError();
  const mem = { decisions: project.memory?.decisions || [], declined: project.memory?.declined || [] };
  return (
    <div className="narrow-col">
      {error && <div className="error-line">{error}</div>}
      {(['decisions', 'declined'] as const).map((k) => (
        <Group key={k} title={t[k]}>
          {mem[k].map((m, i) => (
            <div key={i} className="g-row">
              <span className="g-label">
                <span>{m.text}</span>
              </span>
              <button className="icon-btn" aria-label={t.delete} onClick={guard(() => actions.forget(project, k, m.text))}>
                <Icon name="x" size={13} />
              </button>
            </div>
          ))}
          <form
            className="g-row"
            onSubmit={(e) => {
              e.preventDefault();
              const v = draft[k].trim();
              if (!v) return;
              guard(async () => {
                await actions.remember(project, k, v);
                setDraft((d) => ({ ...d, [k]: '' }));
              })();
            }}
          >
            <input className="ghost-input grow" value={draft[k]} placeholder={k === 'decisions' ? t.addDecision : t.addDeclined} onChange={(e) => setDraft((d) => ({ ...d, [k]: e.target.value }))} aria-label={k === 'decisions' ? t.addDecision : t.addDeclined} />
            <button className="btn small" disabled={!draft[k].trim()}>
              {t.add}
            </button>
          </form>
        </Group>
      ))}
    </div>
  );
}

function AddProject({ onClose, onAdded }: { onClose: () => void; onAdded: (id: string) => void }) {
  const t = useT();
  const [mode, setMode] = useState<'import' | 'create'>('import');
  const [path, setPath] = useState('');
  const [check, setCheck] = useState<{ exists: boolean; git: boolean } | null>(null);
  const { error, guard } = useError();
  useEffect(() => {
    if (!path.trim()) return setCheck(null);
    const h = setTimeout(() => actions.checkPath(path.trim()).then(setCheck).catch(() => setCheck(null)), 250);
    return () => clearTimeout(h);
  }, [path]);
  const pickFolder = (window as any).autodos?.pickFolder;
  const ok = mode === 'import' ? !!check?.exists : path.trim().startsWith('/') && !check?.exists;
  return (
    <Sheet title={t.addProject} onClose={onClose}>
      <div className="seg full">
        <button className={mode === 'import' ? 'on' : ''} onClick={() => setMode('import')}>
          {t.importExisting}
        </button>
        <button className={mode === 'create' ? 'on' : ''} onClick={() => setMode('create')}>
          {t.newEmpty}
        </button>
      </div>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          guard(async () => {
            const p: any = await actions.save('projects', { path: path.trim(), create: mode === 'create' });
            if (p?.id) onAdded(p.id);
          })();
        }}
      >
        <Group>
          <div className="g-row stack">
            <label className="g-label" htmlFor="proj-path">
              <span>{mode === 'import' ? t.folder : t.newFolderHint}</span>
            </label>
            <div className="inline-row">
              <input id="proj-path" className="grow mono" autoFocus placeholder={mode === 'import' ? '/Users/you/code/my-app' : '/Users/you/code/new-app'} value={path} onChange={(e) => setPath(e.target.value)} />
              {pickFolder && (
                <button type="button" className="btn" onClick={async () => setPath((await pickFolder()) || path)} aria-label={t.folder}>
                  <Icon name="folder" size={14} />
                </button>
              )}
            </div>
            <span className={`small ${check && !ok ? 'error-line' : 'muted'}`}>
              {!check ? ' ' : mode === 'import' ? (check.exists ? (check.git ? t.gitRepo : t.plainFolder) : t.missingFolder) : check.exists ? t.folderExists : t.willCreate}
            </span>
          </div>
        </Group>
        {error && <div className="error-line">{error}</div>}
        <div className="form-foot">
          <span className="grow" />
          <button className="btn primary" disabled={!ok}>
            {mode === 'import' ? t.addProject : t.newEmpty}
          </button>
        </div>
      </form>
    </Sheet>
  );
}

export function ProjectsPage({ state }: { state: State }) {
  const t = useT();
  const lang = useLang();
  const [openId, setOpenId] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const { error, guard } = useError();
  const opened = state.projects.find((p) => p.id === openId);
  if (opened) return <ProjectDetail project={opened} state={state} onBack={() => setOpenId(null)} />;
  return (
    <div className="page">
      <PageHead title={t.projects}>
        <button className="btn primary" onClick={() => setAdding(true)}>
          <Icon name="plus" size={14} /> {t.addProject}
        </button>
      </PageHead>
      {error && <div className="error-line">{error}</div>}
      {state.projects.length === 0 ? (
        <EmptyState icon="folder" text={t.noProjects} action={<button className="btn" onClick={() => setAdding(true)}>{t.addProject}</button>} />
      ) : (
        <div className="table-list">
          {state.projects.map((p: Project) => {
            const mine = state.todos.filter((x) => x.projectId === p.id);
            const open = mine.filter((x) => !['done', 'closed'].includes(x.phase)).length;
            const last = mine.map((x) => x.updatedAt).sort().pop();
            return (
              <div key={p.id} className="tl-row project-row" role="button" tabIndex={0} onClick={() => setOpenId(p.id)} onKeyDown={(e) => e.key === 'Enter' && setOpenId(p.id)}>
                <span className="project-mark big">{p.name.slice(0, 1).toUpperCase()}</span>
                <span className="tl-main">
                  <strong>{p.name}</strong>
                  <span className="muted ellipsis mono small">{p.path}</span>
                </span>
                <span className="tl-doing muted">
                  {open ? `${open} ${t.openTodos}` : t.noOpenTodos}
                  {last ? ` · ${ago(last, lang)}` : ''}
                </span>
                <span className="chip">{p.git ? t.gitRepo : t.plainFolder}</span>
                <span className="tl-machine">
                  <button
                    className="icon-btn"
                    aria-label={`${t.delete} ${p.name}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      if (confirm(`${t.delete}: ${p.name}?`)) guard(() => actions.remove('projects', p.id))();
                    }}
                  >
                    <Icon name="trash" size={14} />
                  </button>
                </span>
              </div>
            );
          })}
        </div>
      )}
      {adding && <AddProject onClose={() => setAdding(false)} onAdded={(id) => (setAdding(false), setOpenId(id))} />}
    </div>
  );
}

// ---------------- Automation: rules, sources, events ----------------
function whenText(r: Rule, state: State, t: Dict) {
  if (r.when.cron) return `${t.cron} ${r.when.cron}`;
  if (r.when.every) return `${t.every} ${r.when.every} ${t.minutesShort}`;
  const src = state.sources.find((s) => s.id === r.when.source);
  return `${t.onEvent} ${src?.name || r.when.source} · ${r.when.types?.length ? r.when.types.join(', ') : '*'}`;
}

function RuleSheet({ rule, state, onClose }: { rule: Partial<Rule>; state: State; onClose: () => void }) {
  const t = useT();
  const [r, setR] = useState<Partial<Rule>>({ mode: 'run', tell: 'gates', enabled: true, title: '', prompt: '', ...rule, when: { ...(rule.when || { every: 60 }) } });
  const trig = r.when?.source !== undefined ? 'event' : r.when?.cron !== undefined ? 'cron' : 'interval';
  const setTrig = (k: string) => setR({ ...r, when: k === 'event' ? { source: state.sources[0]?.id || '', types: [] } : k === 'cron' ? { cron: '0 9 * * 1-5' } : { every: 60 } });
  const { error, guard } = useError();
  return (
    <Sheet title={rule.id ? r.name || t.edit : t.addRule} onClose={onClose} head={<input className="sheet-title" autoFocus placeholder={t.name} value={r.name || ''} onChange={(e) => setR({ ...r, name: e.target.value })} aria-label={t.name} />}>
      <Group title={t.trigger}>
        <Row label={t.kind}>
          <div className="seg">
            {(['interval', 'cron', 'event'] as const).map((k) => (
              <button key={k} type="button" className={trig === k ? 'on' : ''} onClick={() => setTrig(k)}>
                {t[k]}
              </button>
            ))}
          </div>
        </Row>
        {trig === 'interval' && (
          <Row label={t.every}>
            <Num label={t.every} value={r.when?.every || 60} min={1} max={100000} onChange={(v) => setR({ ...r, when: { every: v } })} unit={t.minutesShort} />
          </Row>
        )}
        {trig === 'cron' && (
          <Row label={t.cron} sub="m h d M w">
            <input className="mono" value={r.when?.cron || ''} onChange={(e) => setR({ ...r, when: { cron: e.target.value } })} aria-label={t.cron} />
          </Row>
        )}
        {trig === 'event' && (
          <>
            <Row label={t.source}>
              <select value={r.when?.source || ''} onChange={(e) => setR({ ...r, when: { ...r.when, source: e.target.value } })} aria-label={t.source}>
                {state.sources.length === 0 && <option value="">—</option>}
                {state.sources.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
            </Row>
            <Row label={t.types}>
              <input placeholder="issues.opened, alert.*" value={(r.when?.types || []).join(', ')} onChange={(e) => setR({ ...r, when: { ...r.when, types: e.target.value.split(/[,\s]+/).filter(Boolean) } })} aria-label={t.types} />
            </Row>
          </>
        )}
      </Group>
      <Group title={t.work}>
        <Row label={t.agent}>
          <select value={r.agentId || ''} onChange={(e) => setR({ ...r, agentId: e.target.value })} aria-label={t.agent}>
            {state.agents.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
        </Row>
        <Row label={t.project}>
          <select value={r.projectId || ''} onChange={(e) => setR({ ...r, projectId: e.target.value || null })} aria-label={t.project}>
            <option value="">{t.noProject}</option>
            {state.projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </Row>
        <Row label={t.mode}>
          <select value={r.mode} onChange={(e) => setR({ ...r, mode: e.target.value as 'run' | 'plan' })} aria-label={t.mode}>
            <option value="run">{t.runNow}</option>
            <option value="plan">{t.planFirst}</option>
          </select>
        </Row>
        <Row label={t.tell}>
          <select value={r.tell} onChange={(e) => setR({ ...r, tell: e.target.value as 'gates' | 'never' })} aria-label={t.tell}>
            <option value="gates">{t.tellGates}</option>
            <option value="never">{t.tellNever}</option>
          </select>
        </Row>
        <Row label={t.ruleMaxOpen} sub={t.ruleMaxOpenHint}>
          <Num value={r.maxOpen || 0} min={0} max={50} onChange={(x) => setR({ ...r, maxOpen: x })} label={t.ruleMaxOpen} />
        </Row>
        <Row label={t.titleTpl}>
          <input value={r.title || ''} placeholder={trig === 'event' ? '{title}' : r.name} onChange={(e) => setR({ ...r, title: e.target.value })} aria-label={t.titleTpl} />
        </Row>
        <div className="g-row stack">
          <label className="g-label" htmlFor="rule-prompt">
            <span>{t.instructions}</span>
          </label>
          <textarea id="rule-prompt" rows={4} value={r.prompt || ''} onChange={(e) => setR({ ...r, prompt: e.target.value })} />
        </div>
      </Group>
      {error && <div className="error-line">{error}</div>}
      <div className="form-foot">
        {rule.id && (
          <button className="btn ghost danger" onClick={guard(async () => (await actions.deleteRule(rule.id!), onClose()))}>
            <Icon name="trash" size={14} /> {t.delete}
          </button>
        )}
        <span className="grow" />
        <button className="btn primary" disabled={!r.name?.trim()} onClick={guard(async () => (await actions.saveRule(r), onClose()))}>
          {t.save}
        </button>
      </div>
    </Sheet>
  );
}

function SourceSheet({ state, onClose }: { state: State; onClose: () => void }) {
  const t = useT();
  const [kind, setKind] = useState('github-poll');
  const [name, setName] = useState('');
  const [repo, setRepo] = useState('');
  const [made, setMade] = useState<{ key: string | null; path: string } | null>(null);
  const { error, guard } = useError();
  const origin = state.settings.publicUrl?.replace(/\/$/, '') || location.origin;
  return (
    <Sheet title={t.addSource} onClose={onClose}>
      {made?.key ? (
        <Group title={t.keyOnce}>
          <div className="g-row stack">
            <CopyLine text={`${origin}${made.path}`} />
            <CopyLine text={made.key} />
          </div>
        </Group>
      ) : (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            guard(async () => {
              const s = await actions.addSource({ kind, name: name || (kind === 'github-poll' ? repo : kind), repo });
              if (s.key) setMade({ key: s.key, path: s.path });
              else onClose();
            })();
          }}
        >
          <Group>
            <Row label={t.source}>
              <select value={kind} onChange={(e) => setKind(e.target.value)} aria-label={t.source}>
                <option value="github-poll">{t.srcGithubPoll}</option>
                <option value="github">{t.srcGithub}</option>
                <option value="webhook">{t.srcWebhook}</option>
              </select>
            </Row>
            {kind === 'github-poll' ? (
              <Row label={t.repo}>
                <input autoFocus placeholder="owner/repo" value={repo} onChange={(e) => setRepo(e.target.value)} aria-label={t.repo} />
              </Row>
            ) : (
              <Row label={t.name}>
                <input autoFocus value={name} onChange={(e) => setName(e.target.value)} aria-label={t.name} />
              </Row>
            )}
          </Group>
          {error && <div className="error-line">{error}</div>}
          <div className="form-foot">
            <span className="grow" />
            <button className="btn primary" disabled={kind === 'github-poll' ? !/^[\w.-]+\/[\w.-]+$/.test(repo) : false}>
              {t.addSource}
            </button>
          </div>
        </form>
      )}
    </Sheet>
  );
}

export function SchedulesPage({ state }: { state: State }) {
  const t = useT();
  const lang = useLang();
  const [tab, setTab] = useState<'rules' | 'sources' | 'events'>('rules');
  const [editing, setEditing] = useState<Partial<Rule> | null>(null);
  const [addingSource, setAddingSource] = useState(false);
  const { error, guard } = useError();
  const paused = (r: Rule) => !!r.pausedUntil && (r.pausedUntil === 'forever' || Date.parse(r.pausedUntil) > Date.now());
  return (
    <div className="page">
      <PageHead title={t.autoNav}>
        {tab === 'rules' && (
          <button className="btn primary" onClick={() => setEditing({ name: '', agentId: state.agents[0]?.id, projectId: state.projects[0]?.id || null })}>
            <Icon name="plus" size={14} /> {t.addRule}
          </button>
        )}
        {tab === 'sources' && (
          <button className="btn primary" onClick={() => setAddingSource(true)}>
            <Icon name="plus" size={14} /> {t.addSource}
          </button>
        )}
      </PageHead>
      <Tabs
        value={tab}
        onChange={setTab}
        tabs={[
          { key: 'rules', label: t.schedules, count: state.rules.length },
          { key: 'sources', label: t.sources, count: state.sources.length },
          { key: 'events', label: t.recentEvents, count: state.events.length },
        ]}
      />
      {error && <div className="error-line">{error}</div>}

      {tab === 'rules' &&
        (state.rules.length === 0 ? (
          <EmptyState icon="bolt" text={t.noRules} action={<button className="btn" onClick={() => setEditing({ name: '', agentId: state.agents[0]?.id })}>{t.addRule}</button>} />
        ) : (
          <div className="table-list">
            {state.rules.map((r) => (
              <div key={r.id} className={`tl-row rule-row ${!r.enabled || paused(r) ? 'dim' : ''}`} role="button" tabIndex={0} onClick={() => setEditing(r)} onKeyDown={(e) => e.key === 'Enter' && setEditing(r)}>
                <span onClick={(e) => e.stopPropagation()}>
                  <Switch label={r.name} checked={r.enabled && !paused(r)} onChange={(v) => guard(() => actions.saveRule(v ? { id: r.id, enabled: true, pausedUntil: null } as any : { id: r.id, pausedUntil: 'forever' }))()} />
                </span>
                <span className="tl-main">
                  <strong className="ellipsis">{r.name}</strong>
                  <span className="muted ellipsis small">
                    {whenText(r, state, t)} → {state.agents.find((a) => a.id === r.agentId)?.name || '—'}
                  </span>
                </span>
                <span className="tl-doing muted small">
                  {paused(r) || !r.enabled ? t.paused : r.nextAt ? `${t.nextRunAt} ${new Date(r.nextAt).toLocaleString(lang === 'zh' ? 'zh-CN' : undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}` : ''}
                </span>
                <span className="chip">
                  {r.runs || 0} {t.ruleRuns}
                </span>
                <span className="tl-machine">
                  <button
                    className="btn small"
                    onClick={(e) => {
                      e.stopPropagation();
                      guard(() => actions.runRule(r.id))();
                    }}
                  >
                    <Icon name="play" size={12} /> {t.runRuleNow}
                  </button>
                </span>
              </div>
            ))}
          </div>
        ))}

      {tab === 'sources' &&
        (state.sources.length === 0 ? (
          <EmptyState icon="globe" text={t.noSources} action={<button className="btn" onClick={() => setAddingSource(true)}>{t.addSource}</button>} />
        ) : (
          <div className="table-list">
            {state.sources.map((s) => (
              <div key={s.id} className="tl-row static">
                <span className="machine-icon">
                  <Icon name={s.kind === 'webhook' ? 'globe' : 'branch'} size={16} />
                </span>
                <span className="tl-main">
                  <strong>{s.name}</strong>
                  <span className="muted mono small ellipsis">{s.kind === 'github-poll' ? `gh · ${s.repo}` : `/hooks/${s.id}`}</span>
                </span>
                <span className="tl-doing small">
                  {s.lastError ? <span className="error-line ellipsis">{s.lastError}</span> : s.kind === 'github-poll' ? <span className="muted">{t.lastPoll} {s.lastPollAt ? ago(s.lastPollAt, lang) : '—'}</span> : null}
                </span>
                <span className="chip">{s.kind === 'github-poll' ? 'GitHub · gh' : s.kind === 'github' ? 'GitHub' : 'Webhook'}</span>
                <span className="tl-machine inline-row">
                  {s.kind === 'github-poll' && (
                    <button className="btn small ghost" onClick={guard(() => actions.pollSource(s.id))}>
                      {t.pollNow}
                    </button>
                  )}
                  <button className="icon-btn" aria-label={`${t.delete} ${s.name}`} onClick={guard(() => actions.deleteSource(s.id))}>
                    <Icon name="trash" size={14} />
                  </button>
                </span>
              </div>
            ))}
          </div>
        ))}

      {tab === 'events' &&
        (state.events.length === 0 ? (
          <EmptyState icon="inbox" text={t.noEvents} />
        ) : (
          <div className="table-list">
            {state.events
              .slice(-50)
              .reverse()
              .map((ev) => (
                <div key={ev.id} className="tl-row static simple">
                  <span className="muted small">{ago(ev.at, lang)}</span>
                  <span className="ellipsis">{ev.url ? <a href={ev.url} target="_blank" rel="noreferrer">{ev.title}</a> : ev.title}</span>
                  <span className="mono small muted">{ev.type}</span>
                  <span className="small muted">{ev.todoIds.map((id) => state.todos.find((x) => x.id === id)).filter(Boolean).map((x) => todoKey(x!, state)).join(' ') || '—'}</span>
                </div>
              ))}
          </div>
        ))}

      {editing && <RuleSheet key={editing.id || 'new'} rule={editing} state={state} onClose={() => setEditing(null)} />}
      {addingSource && <SourceSheet state={state} onClose={() => setAddingSource(false)} />}
    </div>
  );
}

// ---------------- Usage ----------------
function RetroPanel() {
  const t = useT();
  const lang = useLang();
  const [r, setR] = useState<Retro | null>(null);
  const [sent, setSent] = useState(false);
  useEffect(() => {
    actions.retro(7).then(setR, () => {});
  }, []);
  if (!r) return null;
  const pct = (x: number | null) => (x == null ? '—' : `${Math.round(x * 100)}%`);
  return (
    <Group
      title={t.retro}
      action={
        <button className="btn small ghost" disabled={sent} onClick={() => actions.say(lang === 'zh' ? '周回顾' : 'retro').then(() => setSent(true))}>
          <Icon name="spark" size={13} /> {sent ? t.sent : t.retroWrite}
        </button>
      }
    >
      <div className="stats flat">
        {[
          [t.doneN, r.done],
          [t.reworkRate, pct(r.reworkRate)],
          [t.firstPass, pct(r.checksFirstPass)],
          [t.leadTime, r.medianLeadMs == null ? '—' : duration(r.medianLeadMs)],
        ].map(([k, v]) => (
          <div key={String(k)} className="stat">
            <span className="muted small">{k}</span>
            <strong>{v}</strong>
          </div>
        ))}
      </div>
    </Group>
  );
}

export function UsagePage({ state }: { state: State }) {
  const t = useT();
  const lang = useLang();
  const [range, setRange] = useState<7 | 30 | 365>(7);
  const since = Date.now() - range * 864e5;
  const runs = state.runs.filter((r) => Date.parse(r.startedAt) >= since);
  const sum = (f: (r: (typeof runs)[number]) => number, rs = runs) => rs.reduce((s, r) => s + f(r), 0);
  const fmt = (n: number) => new Intl.NumberFormat(lang === 'zh' ? 'zh-CN' : 'en', { notation: 'compact' }).format(n);
  const dur = (ms: number) => (ms ? duration(ms) : '—');
  // One bar per day for 7/30 days, one per month for a year.
  const buckets =
    range === 365
      ? [...Array(12)].map((_, i) => {
          const d = new Date();
          d.setDate(1);
          d.setHours(0, 0, 0, 0);
          d.setMonth(d.getMonth() - (11 - i));
          const end = new Date(d);
          end.setMonth(end.getMonth() + 1);
          return { start: d.getTime(), end: end.getTime(), label: d.toLocaleDateString(lang === 'zh' ? 'zh-CN' : undefined, { month: 'short' }) };
        })
      : [...Array(range)].map((_, i) => {
          const d = new Date();
          d.setHours(0, 0, 0, 0);
          d.setDate(d.getDate() - (range - 1 - i));
          return { start: d.getTime(), end: d.getTime() + 864e5, label: d.toLocaleDateString(lang === 'zh' ? 'zh-CN' : undefined, range === 7 ? { weekday: 'short' } : { day: 'numeric' }) };
        });
  const bars = buckets.map((b) => {
    const rs = runs.filter((r) => Date.parse(r.startedAt) >= b.start && Date.parse(r.startedAt) < b.end);
    return { ...b, ms: sum((r) => r.durationMs, rs), n: rs.length };
  });
  const max = Math.max(1, ...bars.map((d) => d.ms));
  const who = (id?: string) => (id?.startsWith('reviewer:') ? `${t.aiReview} · ${id.slice(9)}` : state.agents.find((a) => a.id === id)?.name || '—');
  return (
    <div className="page">
      <PageHead title={t.usage}>
        <div className="seg">
          {([7, 30, 365] as const).map((r) => (
            <button key={r} className={range === r ? 'on' : ''} onClick={() => setRange(r)}>
              {r === 7 ? t.last7 : r === 30 ? t.last30 : t.lastYear}
            </button>
          ))}
        </div>
      </PageHead>
      <div className="stats">
        {[
          [t.modelCalls, runs.length],
          [t.time, dur(sum((r) => r.durationMs))],
          [t.tokens, fmt(sum((r) => r.inputTokens + r.outputTokens))],
          [t.cost, `$${sum((r) => r.costUsd).toFixed(2)}`],
        ].map(([k, v]) => (
          <div key={String(k)} className="stat">
            <span className="muted small">{k}</span>
            <strong>{v}</strong>
          </div>
        ))}
      </div>
      <Group title={t.time}>
        <div className="chart" role="img" aria-label={t.time}>
          {bars.map(({ start, label, ms, n }) => (
            <div key={start} className="bar-col" title={`${new Date(start).toLocaleDateString()} · ${n} · ${dur(ms)}`}>
              <span className="bar-val">{ms ? dur(ms) : ''}</span>
              <div className={`bar ${ms ? '' : 'zero'}`} style={{ height: `${Math.max(2, (ms / max) * 100)}%` }} />
              <span className="tiny">{label}</span>
            </div>
          ))}
        </div>
      </Group>
      <RetroPanel />
      <Group title={t.byAgent}>
        <div className="g-row usage-row head">
          <span />
          <span className="usage-nums">
            <span>{t.runs}</span>
            <span>{t.time}</span>
            <span>{t.tokens}</span>
            <span>{t.cost}</span>
          </span>
        </div>
        {state.agents.map((a) => {
          const rs = runs.filter((r) => r.agentId === a.id);
          return (
            <div key={a.id} className="g-row usage-row">
              <span className="inline-row">
                <Avatar name={a.name} color={a.color} size={20} /> {a.name}
              </span>
              <span className="usage-nums">
                <span>{rs.length || '—'}</span>
                <span>{dur(sum((r) => r.durationMs, rs))}</span>
                <span>{rs.length ? fmt(sum((r) => r.inputTokens + r.outputTokens, rs)) : '—'}</span>
                <span>{rs.length ? `$${sum((r) => r.costUsd, rs).toFixed(2)}` : '—'}</span>
              </span>
            </div>
          );
        })}
      </Group>
      <Group title={t.recent}>
        {runs.length === 0 && <div className="g-row muted small">{t.noRuns}</div>}
        {runs.length > 0 && (
          <div className="g-row usage-row head">
            <span />
            <span className="usage-nums">
              <span>{t.when}</span>
              <span>{t.time}</span>
              <span>{t.tokens}</span>
              <span>{t.cost}</span>
            </span>
          </div>
        )}
        {runs
          .slice(-30)
          .reverse()
          .map((r) => {
            const todo = state.todos.find((x) => x.id === r.todoId);
            return (
              <div key={r.id} className="g-row usage-row">
                <span className="inline-row ellipsis">
                  <span className="num">{todo ? todoKey(todo, state) : `#${r.number}`}</span>
                  <span className={r.ok ? '' : 'error-line'}>{who(r.agentId)}</span>
                  <span className="muted small">{r.kind} · {r.runtime}</span>
                </span>
                <span className="usage-nums">
                  <span className="muted">{ago(r.startedAt, lang)}</span>
                  <span>{dur(r.durationMs)}</span>
                  <span>{fmt(r.inputTokens + r.outputTokens)}</span>
                  <span>{r.costKnown === false ? '—' : `$${r.costUsd.toFixed(3)}`}</span>
                </span>
              </div>
            );
          })}
      </Group>
    </div>
  );
}

// ---------------- Settings ----------------
export function CopyLine({ text }: { text: string }) {
  const t = useT();
  const [done, setDone] = useState(false);
  return (
    <div className="copy-line">
      <code className="mono">{text}</code>
      <button
        className="btn"
        onClick={() =>
          navigator.clipboard?.writeText(text).then(() => {
            setDone(true);
            setTimeout(() => setDone(false), 1500);
          })
        }
      >
        <Icon name="copy" size={13} /> {done ? t.copied : t.copy}
      </button>
    </div>
  );
}

export const FONT_SIZES = ['90', '100', '110', '120', '135'];
