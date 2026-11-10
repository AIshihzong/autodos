import { useCallback, useEffect, useRef, useState } from 'react';
import { State, Todo, useAppState, useDoctor, useOnline } from './api';
import { Board, NewTodo, PhaseBadge, StatusIcon, todoKey } from './Board';
import { Chat } from './Chat';
import { Dict, Lang, LangContext, dicts, useLang, useT } from './i18n';
import { Avatar, Icon } from './icons';
import { ProjectsPage, SchedulesPage, UsagePage } from './pages';
import { SettingsPage, TeamPage } from './team-settings';
import { Page, Palette } from './Palette';
import { TodoDrawer } from './TodoDrawer';
import { ago } from './api';

function usePref<T extends string>(key: string, initial: T): [T, (v: T) => void] {
  const [v, setV] = useState<T>(() => {
    try {
      return (localStorage.getItem('autodos.' + key) as T) || initial;
    } catch {
      return initial;
    }
  });
  const set = (x: T) => {
    setV(x);
    try {
      localStorage.setItem('autodos.' + key, x);
    } catch {}
  };
  return [v, set];
}

/** The primary places, in the icon rail. */
const RAIL: { key: Page; icon: string; label: keyof Dict }[] = [
  { key: 'inbox', icon: 'inbox', label: 'inbox' },
  { key: 'workspace', icon: 'work', label: 'work' },
  { key: 'agents', icon: 'agents', label: 'team' },
  { key: 'chat', icon: 'chat', label: 'chat' },
  { key: 'schedules', icon: 'bolt', label: 'autoNav' },
];

export type View = 'all' | 'needs' | 'running';
const NEEDS = ['confirm', 'asking', 'review', 'failed'];
const RUNNING = ['queued', 'planning', 'building', 'merging', 'shipping'];

function Inbox({ state, onOpen }: { state: State; onOpen: (id: string) => void }) {
  const t = useT();
  const lang = useLang();
  const order = ['asking', 'confirm', 'failed', 'review'];
  const items = state.todos.filter((x) => NEEDS.includes(x.phase)).sort((a, b) => order.indexOf(a.phase) - order.indexOf(b.phase) || b.updatedAt.localeCompare(a.updatedAt));
  return (
    <div className="page">
      <header className="page-head">
        <h1>{t.inbox}</h1>
      </header>
      {items.length === 0 && (
        <div className="empty-state">
          <span className="empty-mark">
            <Icon name="inbox" size={22} />
          </span>
          <p>{t.inboxEmpty}</p>
        </div>
      )}
      <div className="list">
        {items.map((x) => {
          const agent = state.agents.find((a) => a.id === x.agentId);
          return (
            <button key={x.id} className="list-row" onClick={() => onOpen(x.id)}>
              <StatusIcon phase={x.phase} />
              <span className="num">{todoKey(x, state)}</span>
              <span className="grow ellipsis">{x.phase === 'asking' && x.question ? x.question.text : x.title}</span>
              <PhaseBadge phase={x.phase} />
              <Avatar name={agent?.name} color={agent?.color} size={18} />
              <span className="tiny muted list-time">{ago(x.updatedAt, lang)}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function WorkNav({ state, view, setView, projectId, setProjectId, onProjects }: { state: State; view: View; setView: (v: View) => void; projectId: string; setProjectId: (p: string) => void; onProjects: () => void }) {
  const t = useT();
  const count = (phases: string[]) => state.todos.filter((x) => phases.includes(x.phase) && (!projectId || x.projectId === projectId)).length;
  const views: { key: View; icon: string; label: string; n?: number }[] = [
    { key: 'all', icon: 'work', label: t.allTodos },
    { key: 'needs', icon: 'inbox', label: t.needsMe, n: count(NEEDS) },
    { key: 'running', icon: 'agents', label: t.agentsWork, n: count(RUNNING) },
  ];
  return (
    <nav className="subnav">
      <h2 className="subnav-title">{t.work}</h2>
      <div className="subnav-head">{t.views}</div>
      {views.map((v) => (
        <button key={v.key} className={`subnav-item ${view === v.key ? 'on' : ''}`} onClick={() => setView(v.key)}>
          <Icon name={v.icon} size={16} />
          <span className="grow">{v.label}</span>
          {!!v.n && <span className="subnav-count">{v.n}</span>}
        </button>
      ))}
      <div className="subnav-head">
        <span className="grow">{t.projects}</span>
        <button className="icon-btn small" title={t.addProject} onClick={onProjects}>
          <Icon name="plus" size={14} />
        </button>
      </div>
      <button className={`subnav-item ${!projectId ? 'on-soft' : ''}`} onClick={() => setProjectId('')}>
        <Icon name="folder" size={16} />
        <span className="grow">{t.allProjects}</span>
      </button>
      {state.projects.map((p) => (
        <button key={p.id} className={`subnav-item ${projectId === p.id ? 'on-soft' : ''}`} onClick={() => setProjectId(p.id)}>
          <span className="project-mark">{p.name.slice(0, 1).toUpperCase()}</span>
          <span className="grow ellipsis">{p.name}</span>
        </button>
      ))}
      {state.projects.length === 0 && (
        <button className="subnav-item muted" onClick={onProjects}>
          <Icon name="plus" size={16} />
          <span>{t.addProject}</span>
        </button>
      )}
    </nav>
  );
}

const WAITING = ['confirm', 'review', 'failed'];

/** In the desktop app: notify when a todo starts waiting on you, and badge the dock icon. */
function useDesktopAlerts(state: State | null, t: Dict) {
  const seen = useRef<Map<string, string> | null>(null);
  useEffect(() => {
    const native = (window as any).autodos;
    if (!native?.notify || !state) return;
    const before = seen.current;
    seen.current = new Map(state.todos.map((x) => [x.id, x.phase]));
    if (document.hasFocus()) return;
    for (const x of state.todos)
      if (before && WAITING.includes(x.phase) && before.get(x.id) !== x.phase) native.notify(`${todoKey(x, state)} ${x.title}`, (t as any)['ph_' + x.phase]);
    native.setBadge(state.todos.filter((x) => WAITING.includes(x.phase)).length);
  }, [state, t]);
  useEffect(() => {
    const native = (window as any).autodos;
    if (!native?.setBadge) return;
    const clear = () => native.setBadge(0);
    window.addEventListener('focus', clear);
    return () => window.removeEventListener('focus', clear);
  }, []);
}

export function App() {
  const state = useAppState();
  const online = useOnline();
  const [lang, setLang] = usePref<Lang>('lang', navigator.language.startsWith('zh') ? 'zh' : 'en');
  const [theme, setTheme] = usePref<string>('theme', 'system');
  const [page, setPageState] = usePref<Page>('page', 'workspace');
  const [projectId, setProjectId] = usePref<string>('project', '');
  const [view, setView] = usePref<View>('view', 'all');
  const [subnav, setSubnav] = usePref<string>('subnav', 'open');
  const [font, setFont] = usePref<string>('font', '100');
  const [chatOpen, setChatOpen] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const [palette, setPalette] = useState(false);
  const [creating, setCreating] = useState(false);
  const [filter, setFilter] = useState('');
  const [filtering, setFiltering] = useState(false);
  const t = dicts[lang];
  useDesktopAlerts(state, t);
  const { doctor } = useDoctor();
  // First launch on a computer that is not ready yet: open Setup once instead of an empty board.
  useEffect(() => {
    if (!doctor || doctor.ready) return;
    try {
      if (localStorage.getItem('autodos.setupShown')) return;
      localStorage.setItem('autodos.setupShown', '1');
    } catch {}
    history.pushState(null, '', '#/settings/setup');
    setPageState('settings');
    window.dispatchEvent(new HashChangeEvent('hashchange')); // an open Settings page switches section too
  }, [doctor?.ready]);

  useEffect(() => {
    document.documentElement.dataset.theme = theme === 'system' ? '' : theme;
    document.documentElement.lang = lang === 'zh' ? 'zh-CN' : 'en';
    (document.body.style as any).zoom = String(Number(font) / 100);
  }, [theme, lang, font]);

  const setPage = useCallback((p: Page) => {
    setPageState(p);
    setOpen(null);
    if (location.hash !== `#/${p}`) history.pushState(null, '', `#/${p}`);
  }, []);
  const openTodo = useCallback((id: string) => {
    setOpen(id);
    const write = (tries: number) => {
      const n = (window as any).__crewTodos?.find((x: Todo) => x.id === id)?.number;
      if (n) history.pushState(null, '', `#/todo/${n}`);
      else if (tries > 0) setTimeout(() => write(tries - 1), 200); // just created: wait for the next state
    };
    write(10);
  }, []);
  const closeTodo = useCallback(() => {
    setOpen(null);
    if (/^#\/todo\//.test(location.hash) || /^#todo=/.test(location.hash)) history.pushState(null, '', `#/${(localStorage.getItem('autodos.page') || 'workspace')}`);
  }, []);
  // Follow the address: #/inbox, #/workspace, #/todo/12 (and #todo=12 from notifications).
  useEffect(() => {
    const read = () => {
      const h = location.hash;
      const todo = h.match(/^#(?:\/todo\/|todo=)(\d+)/);
      if (todo) {
        const x = (window as any).__crewTodos?.find((y: Todo) => String(y.number) === todo[1]);
        if (x) setOpen(x.id);
        return;
      }
      const p = h.match(/^#\/(\w+)/)?.[1] as Page | undefined;
      if (p && ['inbox', 'workspace', 'chat', 'agents', 'projects', 'schedules', 'usage', 'settings'].includes(p)) {
        setPageState(p);
        setOpen(null);
      }
    };
    window.addEventListener('popstate', read);
    window.addEventListener('hashchange', read);
    return () => (window.removeEventListener('popstate', read), window.removeEventListener('hashchange', read));
  }, []);
  // Once the todos are loaded, a deep link to one can open it.
  const loaded = !!state;
  useEffect(() => {
    if (loaded) window.dispatchEvent(new HashChangeEvent('hashchange'));
  }, [loaded]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      const typing = /INPUT|TEXTAREA|SELECT/.test((e.target as HTMLElement).tagName);
      if (mod && e.key.toLowerCase() === 'k') (e.preventDefault(), setPalette((p) => !p));
      else if (mod && e.key.toLowerCase() === 'j') (e.preventDefault(), setChatOpen((c) => !c));
      else if (mod && e.key === ',') (e.preventDefault(), setPage('settings'));
      else if (mod && e.key === '\\') (e.preventDefault(), setSubnav(localStorage.getItem('autodos.subnav') === 'closed' ? 'open' : 'closed'));
      else if (!typing && !mod && e.key === 'n' && !open && !palette) (e.preventDefault(), setPage('workspace'), setCreating(true));
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, palette]);

  (window as any).__crewTodos = state?.todos;
  if (!state) {
    return (
      <div className="boot">
        <span className="spinner" /> Autodos
      </div>
    );
  }
  const project = state.projects.find((p) => p.id === projectId) ? projectId : '';
  const needs = state.todos.filter((x) => NEEDS.includes(x.phase)).length;
  const viewFilter = (x: Todo) => (view === 'needs' ? NEEDS.includes(x.phase) : view === 'running' ? RUNNING.includes(x.phase) : true);
  const viewTitle = view === 'needs' ? t.needsMe : view === 'running' ? t.agentsWork : t.allTodos;

  const railBtn = (key: Page, icon: string, label: string, badge = 0) => (
    <button key={key} className={`rail-btn ${page === key ? 'on' : ''}`} onClick={() => setPage(key)} title={label}>
      <Icon name={icon} size={20} />
      <span>{label}</span>
      {badge > 0 && <span className="pill">{badge}</span>}
    </button>
  );

  return (
    <LangContext.Provider value={lang}>
      <div className="app">
        <nav className="rail">
          <button className="brand" onClick={() => setPalette(true)} title={`${t.search} ⌘K`}>
            <img src="./icon.svg" alt="Autodos" width={22} height={22} />
          </button>
          {RAIL.map((r) => railBtn(r.key, r.icon, t[r.label] as string, r.key === 'inbox' ? needs : 0))}
          <span className="grow" />
          <button className="rail-btn compact" onClick={() => setPalette(true)} title={`${t.search} ⌘K`}>
            <Icon name="search" size={18} />
          </button>
          <button className={`rail-btn compact ${page === 'usage' ? 'on' : ''}`} onClick={() => setPage('usage')} title={t.usage}>
            <Icon name="chart" size={18} />
          </button>
          <button className={`rail-btn compact ${page === 'settings' ? 'on' : ''}`} onClick={() => (doctor && !doctor.ready ? (history.pushState(null, '', '#/settings/setup'), setPageState('settings'), setOpen(null), window.dispatchEvent(new HashChangeEvent('hashchange'))) : setPage('settings'))} title={doctor && !doctor.ready ? `${t.settings} · ${t.sec_setup}` : t.settings}>
            <Icon name="gear" size={18} />
            {doctor && !doctor.ready && <span className="rail-alert" aria-label={t.sec_setup} />}
          </button>
        </nav>

        <div className="frame">
          {!online && <div className="offline">{t.offline}</div>}
          {page === 'workspace' && (
            <div className={`work ${subnav === 'open' ? '' : 'no-subnav'}`}>
              {subnav === 'open' && <WorkNav state={state} view={view} setView={setView} projectId={project} setProjectId={setProjectId} onProjects={() => setPage('projects')} />}
              <section className="board-panel">
                <header className="panel-head">
                  <button className="icon-btn" aria-label={t.toggleNav} title={`${t.toggleNav} ⌘\\`} onClick={() => setSubnav(subnav === 'open' ? 'closed' : 'open')}>
                    <Icon name="sidebar" size={16} />
                  </button>
                  <span className="view-title">
                    <Icon name={view === 'needs' ? 'inbox' : view === 'running' ? 'agents' : 'work'} size={16} />
                    {viewTitle}
                    {project && <span className="muted"> · {state.projects.find((p) => p.id === project)?.name}</span>}
                  </span>
                  {filtering || filter ? (
                    <div className="filter">
                      <Icon name="filter" size={14} />
                      <input autoFocus value={filter} placeholder={t.filter} onChange={(e) => setFilter(e.target.value)} onBlur={() => setFiltering(false)} />
                    </div>
                  ) : (
                    <button className="icon-btn" title={t.filter} onClick={() => setFiltering(true)}>
                      <Icon name="filter" size={16} />
                    </button>
                  )}
                  <span className="grow" />
                  <button className="icon-btn" title={`${t.newTodo} (N)`} onClick={() => setCreating(true)}>
                    <Icon name="compose" size={17} />
                  </button>
                </header>
                <Board state={state} filter={filter} projectId={project || null} onOpen={openTodo} only={viewFilter} onCreate={() => setCreating(true)} />
              </section>
            </div>
          )}
          {page === 'inbox' && <Inbox state={state} onOpen={openTodo} />}
          {page === 'chat' && (
            <div className="chat-page">
              <Chat state={state} projectId={project || null} onOpen={openTodo} onGo={setPage} />
            </div>
          )}
          {page === 'agents' && <TeamPage state={state} />}
          {page === 'projects' && <ProjectsPage state={state} />}
          {page === 'schedules' && <SchedulesPage state={state} />}
          {page === 'usage' && <UsagePage state={state} />}
          {page === 'settings' && <SettingsPage state={state} theme={theme} setTheme={setTheme} lang={lang} setLang={setLang} font={font} setFont={setFont} />}
        </div>

        {page !== 'chat' && (
          <>
            {chatOpen && (
              <aside className="chat-float" aria-label={t.lead}>
                <Chat state={state} projectId={project || null} onOpen={openTodo} onGo={setPage} />
              </aside>
            )}
            <button className={`chat-fab ${chatOpen ? 'on' : ''}`} onClick={() => setChatOpen(!chatOpen)} title={`${t.lead} ⌘J`}>
              <Icon name={chatOpen ? 'x' : 'chat'} size={20} />
              {state.chiefBusy && !chatOpen && <span className="fab-dot" />}
            </button>
          </>
        )}

        {open && <TodoDrawer state={state as State} id={open} onClose={closeTodo} onOpen={openTodo} />}
        {palette && <Palette state={state} onClose={() => setPalette(false)} onOpen={openTodo} onGo={setPage} />}
        {creating && (
          <NewTodo
            state={state}
            projectId={project || null}
            onClose={() => setCreating(false)}
            onCreated={(id) => {
              setCreating(false);
              openTodo(id);
            }}
          />
        )}
      </div>
    </LangContext.Provider>
  );
}
