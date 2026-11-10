// Team (members and machines) and Settings, built from a few shared pieces: Group, Row, Switch, Select.
import { useEffect, useRef, useState } from 'react';
import { actions, Agent, ago, State, Todo } from './api';
import { todoKey } from './Board';
import { Lang, useLang, useT } from './i18n';
import { Avatar, Icon } from './icons';
import { CopyLine, FONT_SIZES, RuntimeSelect, useError } from './pages';
import { Group, Num, Row, Sheet, Switch } from './ui';
import { CheckMark, SetupSection } from './setup';
import { FeishuSection } from './feishu';

// ---------- Team ----------

const RUNNING = ['queued', 'planning', 'building', 'merging', 'shipping'];
const NEEDS = ['confirm', 'asking', 'review', 'failed'];

/** What a member is doing right now, in a few words. */
function Doing({ agent, state }: { agent: Agent; state: State }) {
  const t = useT();
  const mine = state.todos.filter((x) => x.agentId === agent.id);
  const now = mine.find((x) => RUNNING.includes(x.phase)) || mine.find((x) => NEEDS.includes(x.phase));
  if (!now) return <span className="muted">{t.idle}</span>;
  return (
    <span className="doing ellipsis">
      <span className={`dot-live ${RUNNING.includes(now.phase) ? 'run' : 'wait'}`} />
      <span className="num">{todoKey(now, state)}</span> {now.title}
    </span>
  );
}

function runtimeName(agent: Agent, state: State) {
  const id = agent.runtime === 'auto' ? state.settings.defaultRuntime : agent.runtime;
  return state.runtimes.find((r) => r.id === id)?.name.replace(/ \(.*\)$/, '') || id;
}

/** Edit one member in a side sheet. Every change saves on its own. */
function MemberSheet({ agent, state, onClose }: { agent: Agent; state: State; onClose: () => void }) {
  const t = useT();
  const lang = useLang();
  const [a, setA] = useState(agent);
  const { error, guard } = useError();
  const pending = useRef<Partial<Agent>>({});
  const timer = useRef<ReturnType<typeof setTimeout>>();
  const chain = useRef<Promise<unknown>>(Promise.resolve());
  // Send only what changed since the last save, in order, so a slow save can't undo a newer edit.
  const flush = () => {
    clearTimeout(timer.current);
    const patch = pending.current;
    pending.current = {};
    if (!Object.keys(patch).length) return;
    chain.current = chain.current.then(() => guard(() => actions.save('agents', { id: agent.id, ...patch }))());
  };
  const change = (patch: Partial<Agent>, now = false) => {
    setA((x) => ({ ...x, ...patch }));
    pending.current = { ...pending.current, ...patch };
    clearTimeout(timer.current);
    if (now) flush();
    else timer.current = setTimeout(flush, 500);
  };
  const close = () => (flush(), onClose());
  useEffect(() => () => flush(), []); // closing or switching members saves what's left
  const recent = state.todos.filter((x) => x.agentId === agent.id).sort((x, y) => y.updatedAt.localeCompare(x.updatedAt)).slice(0, 5);
  return (
    <Sheet
      title={a.name}
      onClose={close}
      head={
        <>
          <label className="color-pick" title={t.color}>
            <input type="color" value={a.color} onChange={(e) => change({ color: e.target.value })} aria-label={t.color} />
            <Avatar name={a.name} color={a.color} size={40} />
          </label>
          <input className="sheet-title" value={a.name} aria-label={t.name} onChange={(e) => change({ name: e.target.value })} />
        </>
      }
    >
      <Group>
        <div className="g-row stack">
          <label className="g-label" htmlFor="m-role">
            <span>{t.role}</span>
          </label>
          <textarea id="m-role" rows={2} value={a.role} onChange={(e) => change({ role: e.target.value })} />
        </div>
        <Row label={t.runtime}>
          <RuntimeSelect value={a.runtime} state={state} machine={a.machine} onChange={(v) => change({ runtime: v }, true)} />
        </Row>
        <Row label={t.model}>
          <input value={a.model} placeholder={t.modelHint} onChange={(e) => change({ model: e.target.value })} aria-label={t.model} />
        </Row>
        <Row label={t.machine}>
          <select value={a.machine || ''} onChange={(e) => change({ machine: e.target.value }, true)} aria-label={t.machine}>
            <option value="">{t.thisMac}</option>
            {state.workers.map((w) => (
              <option key={w.id} value={w.id}>
                {w.name}
              </option>
            ))}
          </select>
        </Row>
      </Group>
      {recent.length > 0 && (
        <Group title={t.recentWork}>
          {recent.map((x: Todo) => (
            <div key={x.id} className="g-row">
              <span className="g-label">
                <span className="ellipsis">
                  <span className="num">{todoKey(x, state)}</span> {x.title}
                </span>
              </span>
              <span className="g-control muted small">{ago(x.updatedAt, lang)}</span>
            </div>
          ))}
        </Group>
      )}
      {error && <div className="error-line">{error}</div>}
      <button className="btn ghost danger" onClick={guard(async () => (clearTimeout(timer.current), (pending.current = {}), await actions.remove('agents', agent.id), onClose()))}>
        <Icon name="trash" size={14} /> {t.removeMember}
      </button>
    </Sheet>
  );
}

function Members({ state, open, setOpen }: { state: State; open: string | null; setOpen: (id: string | null) => void }) {
  const t = useT();
  const agent = state.agents.find((a) => a.id === open);
  return (
    <>
      <div className="table-list" role="table">
        {state.agents.map((a) => (
          <button key={a.id} className="tl-row" role="row" onClick={() => setOpen(a.id)}>
            <Avatar name={a.name} color={a.color} size={28} />
            <span className="tl-main">
              <strong className="ellipsis">{a.name}</strong>
              <span className="muted ellipsis">{a.role}</span>
            </span>
            <span className="tl-doing">
              <Doing agent={a} state={state} />
            </span>
            <span className="chip">{runtimeName(a, state)}</span>
            <span className="tl-machine muted">{state.workers.find((w) => w.id === a.machine)?.name || t.thisMac}</span>
          </button>
        ))}
      </div>
      {agent && <MemberSheet key={agent.id} agent={agent} state={state} onClose={() => setOpen(null)} />}
    </>
  );
}

function Machines({ state }: { state: State }) {
  const t = useT();
  const lang = useLang();
  const [code, setCode] = useState('');
  const [ssh, setSsh] = useState('');
  const [busy, setBusy] = useState(false);
  const { error, guard } = useError();
  const hub = state.settings.publicUrl?.replace(/\/$/, '') || 'http://localhost:4747';
  return (
    <>
      {state.pairings.map((p) => (
        <div key={p.code} className="notice">
          <div className="grow">
            <div className="small muted">
              {p.host || p.name} · {t.pairCheck}
            </div>
            <strong className="pair-words">{p.words.join('  ')}</strong>
          </div>
          <button className="btn small ghost" onClick={guard(() => actions.rejectPairing(p.code))}>
            {t.reject}
          </button>
          <button className="btn small primary" onClick={guard(() => actions.approvePairing(p.code))}>
            {t.approve}
          </button>
        </div>
      ))}
      <div className="table-list" role="table">
        <div className="tl-row static" role="row">
          <span className="machine-icon">
            <Icon name="board" size={16} />
          </span>
          <span className="tl-main">
            <strong>{t.thisMac}</strong>
            <span className="muted">{state.runtimes.filter((r) => r.available && r.id !== 'demo').map((r) => r.name).join(', ') || t.notInstalled}</span>
          </span>
          <span className="tl-doing">
            <span className="dot-live run" /> {t.online}
          </span>
          <span className="chip">
            {t.capacity} {state.settings.concurrency}
          </span>
          <span className="tl-machine" />
        </div>
        {state.workers.map((w) => (
          <div key={w.id} className="tl-row static" role="row">
            <span className="machine-icon">
              <Icon name="globe" size={16} />
            </span>
            <span className="tl-main">
              <strong>{w.name}</strong>
              <span className="muted ellipsis">
                {[w.host, (w as any).ssh && `ssh ${(w as any).ssh}`, w.runtimes?.join(', ')].filter(Boolean).join(' · ')}
                {(w as any).sshError ? ` · ${(w as any).sshError}` : ''}
              </span>
              {w.doctor && (
                // The machine's own environment check: one mark per tool, names of what needs fixing.
                <span className="machine-checks small" title={w.doctor.items.map((x) => `${x.id}: ${x.ok ? 'ok' : x.installed ? 'signed out' : 'missing'}`).join('\n')}>
                  {w.doctor.items.map((x) => (
                    <CheckMark key={x.id} item={x} />
                  ))}
                  {!w.doctor.ready && (
                    <span className="warn-text">
                      {t.chkMachineIssues}: {w.doctor.items.filter((x) => !x.ok && x.need !== 'optional').map((x) => x.id).join(', ')}
                    </span>
                  )}
                </span>
              )}
            </span>
            <span className="tl-doing">
              <span className={`dot-live ${w.online ? 'run' : 'off'}`} /> {w.online ? (w.running ? `${w.running} ${t.runningNow}` : t.online) : `${t.machineOffline}${w.lastSeen ? ` · ${ago(w.lastSeen, lang)}` : ''}`}
            </span>
            <span className="chip num-chip">
              {t.capacity}
              <input type="number" min={1} max={20} defaultValue={w.capacity} aria-label={`${t.capacity} ${w.name}`} onBlur={(e) => actions.updateWorker(w.id, Number(e.target.value))} />
            </span>
            <span className="tl-machine">
              <button className="icon-btn" aria-label={`${t.delete} ${w.name}`} title={t.delete} onClick={guard(() => actions.deleteWorker(w.id))}>
                <Icon name="trash" size={14} />
              </button>
            </span>
          </div>
        ))}
      </div>
      <Group title={t.addMachine}>
        <Row label={t.pairMachine}>
          <button type="button" className="btn" onClick={guard(async () => setCode((await actions.pairWorker()).code))}>
            {t.getCode}
          </button>
        </Row>
        {code && (
          <div className="g-row stack">
            <CopyLine text={`node worker/worker.js --hub ${hub} --pair ${code}`} />
          </div>
        )}
        <Row label={t.addOverSsh}>
          <form
            className="inline-row"
            onSubmit={(e) => {
              e.preventDefault();
              guard(async () => {
                setBusy(true);
                try {
                  await actions.sshWorker(ssh.trim());
                  setSsh('');
                } finally {
                  setBusy(false);
                }
              })();
            }}
          >
            <input placeholder="user@host" value={ssh} onChange={(e) => setSsh(e.target.value)} aria-label={t.addOverSsh} />
            <button className="btn" disabled={busy || !/^[\w.@-]+$/.test(ssh.trim())}>
              {busy ? <span className="spinner" /> : t.add}
            </button>
          </form>
        </Row>
      </Group>
      {error && <div className="error-line">{error}</div>}
    </>
  );
}

export function TeamPage({ state }: { state: State }) {
  const t = useT();
  const [tab, setTab] = useState<'members' | 'machines'>('members');
  const [open, setOpen] = useState<string | null>(null);
  return (
    <div className="page">
      <header className="page-head">
        <h1>{t.team}</h1>
        {tab === 'members' && (
          <button className="btn primary" onClick={async () => setOpen(((await actions.save('agents', { name: t.newMember, role: '' })) as Agent).id)}>
            <Icon name="plus" size={14} /> {t.addMember}
          </button>
        )}
      </header>
      <div className="tabs-line" role="tablist">
        {(['members', 'machines'] as const).map((k) => (
          <button key={k} role="tab" aria-selected={tab === k} className={tab === k ? 'on' : ''} onClick={() => setTab(k)}>
            {k === 'members' ? t.members : t.machines}
            <span className="tab-count">{k === 'members' ? state.agents.length : state.workers.length + 1}</span>
          </button>
        ))}
      </div>
      {tab === 'members' ? <Members state={state} open={open} setOpen={setOpen} /> : <Machines state={state} />}
    </div>
  );
}

// ---------- Settings ----------

type Section = 'setup' | 'feishu' | 'general' | 'agents' | 'quality' | 'notifications' | 'appearance' | 'integrations';
const SECTIONS: { key: Section; icon: string }[] = [
  { key: 'setup', icon: 'bolt' },
  { key: 'feishu', icon: 'chat' },
  { key: 'general', icon: 'gear' },
  { key: 'agents', icon: 'agents' },
  { key: 'quality', icon: 'check' },
  { key: 'notifications', icon: 'inbox' },
  { key: 'appearance', icon: 'sun' },
  { key: 'integrations', icon: 'branch' },
];

function Channels({ state }: { state: State }) {
  const t = useT();
  const [form, setForm] = useState({ kind: 'feishu', url: '', secret: '' });
  const [msg, setMsg] = useState('');
  const { error, guard } = useError();
  const kinds: Record<string, string> = { feishu: '飞书 / Lark', dingtalk: '钉钉 DingTalk', wecom: '企业微信 WeCom', slack: 'Slack', webhook: 'Webhook' };
  return (
    <>
      <Group title={t.channels}>
        {state.channels.map((c) => (
          <Row key={c.id} label={kinds[c.kind] || c.kind} sub={c.lastError ? <span className="error-line">{c.lastError}</span> : c.url}>
            <button className="btn small ghost" onClick={guard(async () => (await actions.testChannel(c.id), setMsg(`${t.sent} · ${kinds[c.kind] || c.kind}`)))}>
              {t.test}
            </button>
            <Switch checked={c.enabled} label={c.name} onChange={() => guard(() => actions.updateChannel(c.id, { enabled: !c.enabled }))()} />
            <button className="icon-btn" aria-label={`${t.delete} ${c.name}`} onClick={guard(() => actions.deleteChannel(c.id))}>
              <Icon name="trash" size={14} />
            </button>
          </Row>
        ))}
        <form
          className="g-row stack"
          onSubmit={(e) => {
            e.preventDefault();
            guard(async () => {
              await actions.addChannel({ ...form, name: kinds[form.kind] });
              setForm({ kind: form.kind, url: '', secret: '' });
            })();
          }}
        >
          <div className="inline-row wrap">
            <select value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value })} aria-label={t.channels}>
              {Object.entries(kinds).map(([k, v]) => (
                <option key={k} value={k}>
                  {v}
                </option>
              ))}
            </select>
            <input className="grow" placeholder={t.webhookUrl} value={form.url} onChange={(e) => setForm({ ...form, url: e.target.value })} aria-label={t.webhookUrl} />
            {['feishu', 'dingtalk'].includes(form.kind) && <input placeholder={t.secretOpt} value={form.secret} onChange={(e) => setForm({ ...form, secret: e.target.value })} aria-label={t.secretOpt} />}
            <button className="btn" disabled={!form.url.startsWith('https://')}>
              {t.add}
            </button>
          </div>
        </form>
      </Group>
      {(error || msg) && (
        <div className={error ? 'error-line' : 'muted small'} role="status">
          {error || msg}
        </div>
      )}
      <Group>
        <Row label={t.publicUrl}>
          <input defaultValue={state.settings.publicUrl || ''} placeholder="https://…" onBlur={(e) => actions.settings({ publicUrl: e.target.value.trim() })} aria-label={t.publicUrl} />
        </Row>
      </Group>
    </>
  );
}

export function SettingsPage({ state, theme, setTheme, lang, setLang, font, setFont }: { state: State; theme: string; setTheme: (v: string) => void; lang: Lang; setLang: (l: Lang) => void; font: string; setFont: (v: string) => void }) {
  const t = useT();
  const s = state.settings;
  const set = (patch: Partial<typeof s>) => actions.settings(patch);
  const [section, setSection] = useState<Section>(() => (location.hash.match(/^#\/settings\/(\w+)/)?.[1] as Section) || 'general');
  const go = (k: Section) => {
    setSection(k);
    history.replaceState(null, '', `#/settings/${k}`);
  };
  // Follow the address when something else points here (e.g. first launch opens #/settings/setup).
  useEffect(() => {
    const read = () => {
      const k = location.hash.match(/^#\/settings\/(\w+)/)?.[1] as Section | undefined;
      if (k && SECTIONS.some((x) => x.key === k)) setSection(k);
    };
    window.addEventListener('hashchange', read);
    window.addEventListener('popstate', read);
    return () => (window.removeEventListener('hashchange', read), window.removeEventListener('popstate', read));
  }, []);
  return (
    <div className="settings-layout">
      <nav className="settings-nav" aria-label={t.settings}>
        <h2 className="subnav-title">{t.settings}</h2>
        {SECTIONS.map((x) => (
          <button key={x.key} className={`subnav-item ${section === x.key ? 'on' : ''}`} onClick={() => go(x.key)}>
            <Icon name={x.icon} size={16} />
            <span>{t[`sec_${x.key}` as 'sec_general']}</span>
          </button>
        ))}
      </nav>
      <div className="settings-body">
        <h1>{t[`sec_${section}` as 'sec_general']}</h1>

        {section === 'setup' && <SetupSection feishu={state.feishu} />}
        {section === 'feishu' && <FeishuSection state={state} />}

        {section === 'general' && (
          <>
            <Group>
              <Row label={t.concurrency}>
                <Num label={t.concurrency} value={s.concurrency} min={1} max={20} onChange={(v) => set({ concurrency: v })} />
              </Row>
              <Row label={t.autoStart}>
                <Switch label={t.autoStart} checked={s.autoStart} onChange={(v) => set({ autoStart: v })} />
              </Row>
              <Row label={t.planFirstDefault}>
                <Switch label={t.planFirstDefault} checked={s.planFirst} onChange={(v) => set({ planFirst: v })} />
              </Row>
              <Row label={t.worktrees}>
                <Switch label={t.worktrees} checked={s.useWorktrees} onChange={(v) => set({ useWorktrees: v })} />
              </Row>
            </Group>
          </>
        )}

        {section === 'agents' && (
          <>
            <Group>
              <Row label={t.defaultRuntime}>
                <RuntimeSelect global value={s.defaultRuntime} state={state} onChange={(v) => set({ defaultRuntime: v })} />
              </Row>
              <Row label={t.leadRuntime}>
                <RuntimeSelect global value={s.chiefRuntime} state={state} onChange={(v) => set({ chiefRuntime: v })} />
              </Row>
              <Row label={t.permission}>
                <select value={s.claudePermissionMode} onChange={(e) => set({ claudePermissionMode: e.target.value })} aria-label={t.permission}>
                  <option value="acceptEdits">{t.permEdit}</option>
                  <option value="bypassPermissions">{t.permAll}</option>
                </select>
              </Row>
              <Row label={t.codexSandbox} sub={t.codexSandboxHint}>
                <select value={s.codexSandbox || 'workspace-write'} onChange={(e) => set({ codexSandbox: e.target.value } as any)} aria-label={t.codexSandbox}>
                  <option value="workspace-write">{t.sandboxWrite}</option>
                  <option value="network">{t.sandboxNetwork}</option>
                  <option value="danger-full-access">{t.sandboxFull}</option>
                </select>
              </Row>
              <Row label={t.steerSetting}>
                <Switch label={t.steerSetting} checked={s.steer !== false} onChange={(v) => set({ steer: v } as any)} />
              </Row>
            </Group>
            <Group title={t.runtimes} action={<button className="btn small ghost" onClick={() => actions.rescanRuntimes()}>{t.rescan}</button>}>
              {state.runtimes.map((r) => (
                <Row key={r.id} label={r.name.replace(/ \(.*\)$/, '')} sub={r.available ? r.version.replace(/\s*\(.*\)$/, '') : undefined}>
                  <span className={`chip ${r.available ? 'ok' : ''}`}>{r.available ? t.installed : t.notInstalled}</span>
                </Row>
              ))}
            </Group>
          </>
        )}

        {section === 'quality' && (
          <>
            <Group title={t.checks}>
              <Row label={t.verifySetting}>
                <Switch label={t.verifySetting} checked={s.verify !== false} onChange={(v) => set({ verify: v })} />
              </Row>
              <Row label={t.verifyAttempts}>
                <Num label={t.verifyAttempts} value={s.verifyAttempts ?? 2} min={0} max={5} onChange={(v) => set({ verifyAttempts: v })} />
              </Row>
            </Group>
            <Group title={t.aiReview}>
              <Row label={t.reviewerSetting}>
                <select value={s.reviewer || 'auto'} onChange={(e) => set({ reviewer: e.target.value })} aria-label={t.reviewerSetting}>
                  <option value="off">{t.reviewOff}</option>
                  <option value="auto">{t.reviewerOther}</option>
                  {state.runtimes.map((r) => (
                    <option key={r.id} value={r.id} disabled={!r.available}>
                      {r.name.replace(/ \(.*\)$/, '')}
                    </option>
                  ))}
                </select>
              </Row>
              <Row label={t.reviewAutoFix}>
                <Switch label={t.reviewAutoFix} checked={s.reviewAutoFix !== false} onChange={(v) => set({ reviewAutoFix: v })} />
              </Row>
            </Group>
            <Group title={t.budget}>
              <Row label={t.budgetTime}>
                <Num label={t.budgetTime} value={s.budgetMinutes ?? 30} min={0} max={600} onChange={(v) => set({ budgetMinutes: v })} unit={t.budgetMinutes} />
              </Row>
              <Row label={t.budgetCost}>
                <Num label={t.budgetCost} value={s.budgetUsd ?? 3} min={0} max={500} step={0.5} onChange={(v) => set({ budgetUsd: v })} unit="USD" />
              </Row>
            </Group>
            <Group title={t.subtasks}>
              <Row label={t.delegateDepth}>
                <Num label={t.delegateDepth} value={s.delegateDepth ?? 2} min={0} max={5} onChange={(v) => set({ delegateDepth: v })} />
              </Row>
              <Row label={t.delegateChildren}>
                <Num label={t.delegateChildren} value={s.delegateChildren ?? 5} min={0} max={20} onChange={(v) => set({ delegateChildren: v })} />
              </Row>
            </Group>
          </>
        )}

        {section === 'notifications' && <Channels state={state} />}

        {section === 'appearance' && (
          <Group>
            <Row label={t.theme}>
              <div className="seg">
                {(['system', 'light', 'dark'] as const).map((k) => (
                  <button key={k} className={theme === k ? 'on' : ''} onClick={() => setTheme(k)}>
                    {t[k]}
                  </button>
                ))}
              </div>
            </Row>
            <Row label={t.language}>
              <div className="seg">
                {(['en', 'zh'] as const).map((k) => (
                  <button key={k} className={lang === k ? 'on' : ''} onClick={() => setLang(k)}>
                    {k === 'en' ? 'English' : '中文'}
                  </button>
                ))}
              </div>
            </Row>
            <Row label={t.fontSize}>
              <div className="seg">
                {FONT_SIZES.map((k) => (
                  <button key={k} className={font === k ? 'on' : ''} onClick={() => setFont(k)} style={{ fontSize: `${(Number(k) / 100) * 12}px` }} aria-label={`${t.fontSize} ${k}%`}>
                    A
                  </button>
                ))}
              </div>
            </Row>
          </Group>
        )}

        {section === 'integrations' && (
          <>
            <Group title={t.mcp}>
              <div className="g-row stack">
                <CopyLine text={`claude mcp add autodos -- node ${state.mcpPath}`} />
                <CopyLine text={`codex mcp add autodos -- node ${state.mcpPath}`} />
              </div>
            </Group>
            <Group title={t.about}>
              <Row label={t.data}>
                <span className="muted small path">{state.dataDir}</span>
              </Row>
            </Group>
          </>
        )}
      </div>
    </div>
  );
}
