// Browser half of dsh-autodos-core: a "Tasks" item in the DSH sidebar that opens the status board.
// DSH loads this file through its module loader (not plain ESM); React comes from the shell.
window.__ModuleLoader__.load({
  id: 'dsh-autodos-core',
  factory: (require) => {
    const React = require('react');
    const h = React.createElement;
    const { useEffect, useState, useCallback } = React;
    const module = { exports: {} };

    const NS = 'autodos';
    const PANEL = 'autodos-tasks';
    const DICT = {
      zh: {
        panel: '任务',
        title: '状态总表',
        empty: '没有进行中的任务。',
        all: '显示已结束的',
        refresh: '刷新',
        loading: '加载中…',
        who: '谁在做',
        state: '状态',
        needs: '等你',
        stuck: '卡在',
        moved: '最后进展',
        outputs: '成果',
        back: '← 返回总表',
        timeline: '时间线',
        threads: '在哪跑',
        decisions: '决定',
        imported: '已从 Autodos 导入',
        s_waiting_you: '等你',
        s_stuck: '卡住',
        s_working: '进行中',
        s_review: '评审中',
        s_queued: '排队',
        s_landing: '合并中',
        s_done: '完成',
        s_failed: '失败',
        s_dropped: '已关闭',
        none: '无',
        more: '另 {0} 项',
        w_confirm_plan: '确认计划',
        w_confirm_start: '开工前确认',
        w_answer: '回答一个问题',
        w_review: '评审改动',
        w_lead_hold: '负责人在等你决定',
        w_retry: '回复或重试',
        w_result: '看结果：通过或说要改什么',
        w_permission: '允许或拒绝一个操作',
        w_budget: '预算用完：加预算或关闭',
        'o_Add budget': '加预算继续',
        o_Close: '关闭任务',
        spent: '已花',
        new_task: '新建任务',
        f_title: '标题',
        f_desc: '说明（交给 agent 的任务描述）',
        f_project: '项目',
        f_start: '立刻开工',
        create: '创建',
        cancel: '取消',
        reply: '回复',
        reply_ph: '对 agent 说点什么…',
        send: '发送',
        retry: '重试',
        start: '开工',
        drop: '关闭任务',
        note_ph: '要改什么（选“继续改”时必填）',
        o_Allow: '允许',
        o_Deny: '拒绝',
        o_Accept: '通过并合并',
        'o_Keep working': '继续改',
        irreversible: '这一步可能无法撤销',
        no_exec: '执行层（Paseo）没有配置，只能看不能派工。',
        working_on: '处理中…',
      },
      en: {
        panel: 'Tasks',
        title: 'Status board',
        empty: 'No open tasks.',
        all: 'Show finished',
        refresh: 'Refresh',
        loading: 'Loading…',
        who: 'Who',
        state: 'State',
        needs: 'Needs you',
        stuck: 'Stuck',
        moved: 'Last moved',
        outputs: 'Delivered',
        back: '← Back to the board',
        timeline: 'Timeline',
        threads: 'Where it ran',
        decisions: 'Decisions',
        imported: 'Imported from Autodos',
        s_waiting_you: 'Needs you',
        s_stuck: 'Stuck',
        s_working: 'Working',
        s_review: 'In review',
        s_queued: 'Queued',
        s_landing: 'Landing',
        s_done: 'Done',
        s_failed: 'Failed',
        s_dropped: 'Closed',
        none: 'none',
        more: '{0} more',
        w_confirm_plan: 'Confirm the plan',
        w_confirm_start: 'Confirm before it starts',
        w_answer: 'Answer a question',
        w_review: 'Review the change',
        w_lead_hold: 'The lead is holding it for you',
        w_retry: 'Reply or retry',
        w_result: 'Look at the result: accept, or say what to change',
        w_permission: 'Allow or deny an action',
        w_budget: 'Budget reached: add more or close',
        'o_Add budget': 'Add budget and continue',
        o_Close: 'Close the task',
        spent: 'Spent',
        new_task: 'New task',
        f_title: 'Title',
        f_desc: 'Description (the brief the agent works from)',
        f_project: 'Project',
        f_start: 'Start now',
        create: 'Create',
        cancel: 'Cancel',
        reply: 'Reply',
        reply_ph: 'Say something to the agent…',
        send: 'Send',
        retry: 'Retry',
        start: 'Start',
        drop: 'Close task',
        note_ph: 'What to change (needed for “Keep working”)',
        o_Allow: 'Allow',
        o_Deny: 'Deny',
        o_Accept: 'Accept and merge',
        'o_Keep working': 'Keep working',
        irreversible: 'This may not be undoable',
        no_exec: 'No execution layer (Paseo) is configured: read only.',
        working_on: 'Working…',
      },
    };

    async function getJson(url) {
      const res = await fetch(url, { credentials: 'same-origin' });
      const body = await res.json().catch(() => undefined);
      if (!res.ok || body?.ok !== true) throw new Error(body?.error || `HTTP ${res.status}`);
      return body;
    }

    async function act(body) {
      const res = await fetch('/api/autodos/action', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      const out = await res.json().catch(() => undefined);
      if (!res.ok || out?.ok !== true) throw new Error(out?.error || `HTTP ${res.status}`);
      return out.result;
    }

    // Run an action, show "working" while it runs and the error if it fails, then refresh.
    function useAction(after) {
      const [busy, setBusy] = useState(false);
      const [error, setError] = useState('');
      const run = useCallback(async (body) => {
        setBusy(true);
        setError('');
        try {
          const r = await act(body);
          after?.(r);
          return r;
        } catch (e) {
          setError(e.message);
        } finally {
          setBusy(false);
        }
      }, [after]);
      return { busy, error, run };
    }

    const ago = (iso) => {
      const s = (Date.now() - Date.parse(iso)) / 1000;
      if (!isFinite(s)) return '';
      if (s < 90) return `${Math.max(1, Math.round(s))}s`;
      if (s < 5400) return `${Math.round(s / 60)}m`;
      if (s < 129600) return `${Math.round(s / 3600)}h`;
      return `${Math.round(s / 86400)}d`;
    };
    // What the task waits on you for: the translated kind first ("评审改动"), then the task's own words, if any.
    const needs = (t, r) => {
      const note = typeof r.waitingFor === 'string' && r.waitingFor && r.waitingFor !== DICT.en[`w_${r.waitingKind}`] && r.waitingFor !== 'Needs you' ? r.waitingFor : '';
      const label = r.waitingKind ? t(`w_${r.waitingKind}`) : r.state === 'waiting_you' && !note ? t('needs') : '';
      return { label, note };
    };
    const Needs = ({ t, r }) => {
      const { label, note } = needs(t, r);
      if (!label && !note) return null;
      return h('div', null, label ? h('div', null, label) : null, note ? h('div', { style: { opacity: 0.65, fontSize: 12 } }, note) : null);
    };
    const fill = (s, n) => String(s).replace('{0}', n);
    const tone = { waiting_you: '#c2410c', stuck: '#b91c1c', working: '#1d4ed8', landing: '#047857', done: '#047857', failed: '#b91c1c' };
    const MAX_OUTPUTS = 3;

    const css = {
      page: { padding: '20px 24px', overflow: 'auto', height: '100%', boxSizing: 'border-box', fontSize: 13 },
      head: { display: 'flex', alignItems: 'center', gap: 12, marginBottom: 12, flexWrap: 'wrap' },
      h1: { fontSize: 18, fontWeight: 600, margin: 0, flex: 1 },
      muted: { opacity: 0.65 },
      row: { display: 'grid', gridTemplateColumns: 'minmax(180px,2fr) minmax(120px,1fr) 90px minmax(160px,2fr) 70px', gap: 12, padding: '10px 4px', borderTop: '1px solid rgba(127,127,127,.2)', cursor: 'pointer', alignItems: 'start' },
      th: { fontWeight: 600, cursor: 'default' },
      pill: (s) => ({ display: 'inline-block', padding: '1px 8px', borderRadius: 10, fontSize: 12, border: `1px solid ${tone[s] || 'rgba(127,127,127,.5)'}`, color: tone[s] || 'inherit' }),
      btn: { padding: '4px 10px', borderRadius: 6, border: '1px solid rgba(127,127,127,.4)', background: 'transparent', color: 'inherit', cursor: 'pointer' },
      input: { width: '100%', boxSizing: 'border-box', padding: '6px 8px', borderRadius: 6, border: '1px solid rgba(127,127,127,.4)', background: 'transparent', color: 'inherit', font: 'inherit' },
      primary: { padding: '4px 12px', borderRadius: 6, border: '1px solid #1d4ed8', background: '#1d4ed8', color: '#fff', cursor: 'pointer' },
      card: { border: '1px solid rgba(127,127,127,.3)', borderRadius: 8, padding: 12, margin: '12px 0' },
      err: { color: '#b91c1c', margin: '6px 0' },
      ev: { padding: '6px 0', borderTop: '1px solid rgba(127,127,127,.15)', whiteSpace: 'pre-wrap', wordBreak: 'break-word' },
    };

    function NewTask({ t, onDone, onCancel }) {
      const [projects, setProjects] = useState(null);
      const [exec, setExec] = useState(true);
      const [f, setF] = useState({ title: '', description: '', project: '', start: true });
      const { busy, error, run } = useAction(onDone);
      useEffect(() => {
        getJson('/api/autodos/projects').then((d) => {
          setProjects(d.projects);
          setExec(d.execution);
          setF((x) => ({ ...x, project: x.project || d.projects.find((p) => p.path)?.id || '' }));
        }, () => setProjects([]));
      }, []);
      const set = (k) => (e) => setF({ ...f, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value });
      return h('div', { style: css.card },
        h('div', { style: { display: 'grid', gap: 8 } },
          h('input', { style: css.input, placeholder: t('f_title'), value: f.title, onChange: set('title'), autoFocus: true }),
          h('textarea', { style: { ...css.input, minHeight: 90 }, placeholder: t('f_desc'), value: f.description, onChange: set('description') }),
          h('div', { style: { display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' } },
            h('label', null, `${t('f_project')} `,
              h('select', { style: { ...css.input, width: 'auto' }, value: f.project, onChange: set('project') },
                h('option', { value: '' }, t('none')),
                (projects || []).map((p) => h('option', { key: p.id, value: p.id }, p.name)))),
            h('label', { style: { display: 'flex', gap: 4, alignItems: 'center' } }, h('input', { type: 'checkbox', checked: f.start && exec, disabled: !exec, onChange: set('start') }), t('f_start')),
            h('span', { style: { flex: 1 } }),
            h('button', { style: css.btn, onClick: onCancel }, t('cancel')),
            h('button', { style: css.primary, disabled: busy || !f.title.trim(), onClick: () => run({ action: 'create_task', title: f.title.trim(), description: f.description, project: f.project || undefined, start: f.start && exec && Boolean(f.project) }) }, busy ? t('working_on') : t('create')))),
        !exec ? h('div', { style: css.muted }, t('no_exec')) : null,
        error ? h('div', { style: css.err }, error) : null);
    }

    function Board({ t, onOpen }) {
      const [data, setData] = useState(null);
      const [error, setError] = useState('');
      const [all, setAll] = useState(false);
      const [adding, setAdding] = useState(false);
      const load = useCallback(() => getJson(`/api/autodos/board${all ? '?all=1' : ''}`).then((d) => (setData(d), setError('')), (e) => setError(e.message)), [all]);
      useEffect(() => {
        load();
        const timer = setInterval(load, 5000);
        return () => clearInterval(timer);
      }, [load]);
      return h('div', { style: css.page },
        h('div', { style: css.head },
          h('h1', { style: css.h1 }, t('title')),
          data && h('span', { style: css.muted }, `${data.total}`),
          h('label', { style: { display: 'flex', gap: 4, alignItems: 'center' } }, h('input', { type: 'checkbox', checked: all, onChange: (e) => setAll(e.target.checked) }), t('all')),
          h('button', { style: css.btn, onClick: load }, t('refresh')),
          h('button', { style: css.primary, onClick: () => setAdding(true) }, t('new_task'))),
        adding ? h(NewTask, { t, onCancel: () => setAdding(false), onDone: (task) => { setAdding(false); load(); if (task?.id) onOpen(task.id); } }) : null,
        error && h('div', { style: { color: '#b91c1c', marginBottom: 8 } }, error),
        !data ? h('div', { style: css.muted }, t('loading')) : !data.rows.length ? h('div', { style: css.muted }, t('empty')) :
          h('div', null,
            h('div', { style: { ...css.row, ...css.th } }, h('div', null, '#'), h('div', null, t('who')), h('div', null, t('state')), h('div', null, `${t('needs')} / ${t('stuck')}`), h('div', null, t('moved'))),
            data.rows.map((r) => h('div', { key: r.id, style: css.row, onClick: () => onOpen(r.id) },
              h('div', null,
                h('div', { style: { fontWeight: 500 } }, `${r.number ? `#${r.number} ` : ''}${r.title}`),
                h('div', { style: css.muted }, r.goal?.name || r.project?.name || ''),
                r.outputs.length ? h('div', { style: { ...css.muted, fontSize: 12 } },
                  `${t('outputs')}: ${r.outputs.slice(0, MAX_OUTPUTS).map((o) => o.title).join(', ')}${r.outputs.length > MAX_OUTPUTS ? `, ${fill(t('more'), r.outputs.length - MAX_OUTPUTS)}` : ''}`) : null),
              h('div', null, [r.who.machine, r.who.staff].filter(Boolean).join(' · ') || t('none')),
              h('div', null, h('span', { style: css.pill(r.state) }, t(`s_${r.state}`))),
              h('div', null,
                h(Needs, { t, r }),
                r.stuck ? h('div', { style: { color: tone.stuck } }, `${t('stuck')}: ${r.stuck.split('\n')[0].slice(0, 200)}`) : null),
              h('div', { style: css.muted, title: r.lastProgressAt }, ago(r.lastProgressAt))))),
        data?.imported && h('div', { style: { ...css.muted, marginTop: 16, fontSize: 12 } }, `${t('imported')} · ${data.imported.at}`));
    }

    function Decision({ t, d, onDone }) {
      const [note, setNote] = useState('');
      const { busy, error, run } = useAction(onDone);
      const options = d.options || [];
      return h('div', { style: css.card },
        h('div', { style: { fontWeight: 500, marginBottom: 6 } }, d.kind === 'permission' ? `${t('w_permission')}${d.tool ? ` · ${d.tool}` : ''}` : d.kind === 'result' ? t('w_result') : d.kind === 'budget' ? t('w_budget') : d.question),
        d.kind ? h('div', { style: { whiteSpace: 'pre-wrap', marginBottom: 6 } }, d.question) : null,
        d.reversible === false ? h('div', { style: { ...css.muted, fontSize: 12, marginBottom: 6 } }, t('irreversible')) : null,
        d.kind === 'result' ? h('textarea', { style: { ...css.input, minHeight: 50, marginBottom: 6 }, placeholder: t('note_ph'), value: note, onChange: (e) => setNote(e.target.value) }) : null,
        h('div', { style: { display: 'flex', gap: 8 } },
          options.map((o, i) => h('button', { key: o, style: i === 0 ? css.primary : css.btn, disabled: busy, onClick: () => run({ action: 'decide', decision: d.id, choice: o, note: note.trim() || undefined }) }, t(`o_${o}`) || o))),
        error ? h('div', { style: css.err }, error) : null);
    }

    function Detail({ t, id, onBack }) {
      const [d, setD] = useState(null);
      const [error, setError] = useState('');
      const [text, setText] = useState('');
      const load = useCallback(() => getJson(`/api/autodos/task?id=${encodeURIComponent(id)}`).then((x) => (setD(x), setError('')), (e) => setError(e.message)), [id]);
      useEffect(() => {
        load();
        const timer = setInterval(load, 4000);
        return () => clearInterval(timer);
      }, [load]);
      const { busy, error: actError, run } = useAction(load);
      if (error && !d) return h('div', { style: css.page }, h('button', { style: css.btn, onClick: onBack }, t('back')), h('p', null, error));
      if (!d) return h('div', { style: css.page }, t('loading'));
      const task = d.task;
      const thread = d.threads.find((x) => x.id === task.threadId);
      const finished = ['done', 'dropped'].includes(task.state);
      const open = d.decisions.filter((x) => x.open);
      return h('div', { style: css.page },
        h('button', { style: { ...css.btn, marginBottom: 12 }, onClick: onBack }, t('back')),
        h('h1', { style: css.h1 }, `${task.number ? `#${task.number} ` : ''}${task.title}`),
        h('p', null, h('span', { style: css.pill(task.state) }, t(`s_${task.state}`)), thread?.costUsd != null ? h('span', { style: { ...css.muted, marginLeft: 8 } }, `$${Number(thread.costUsd).toFixed(2)}`) : null),
        h(Needs, { t, r: task }),
        task.stuck ? h('pre', { style: { whiteSpace: 'pre-wrap', color: tone.stuck } }, task.stuck) : null,
        open.map((x) => h(Decision, { key: x.id, t, d: x, onDone: load })),
        !finished ? h('div', { style: css.card },
          h('textarea', { style: { ...css.input, minHeight: 60 }, placeholder: t('reply_ph'), value: text, onChange: (e) => setText(e.target.value) }),
          h('div', { style: { display: 'flex', gap: 8, marginTop: 6 } },
            h('button', { style: css.primary, disabled: busy || !text.trim(), onClick: () => run({ action: 'reply', task: task.id, text: text.trim() }).then((r) => r && setText('')) }, t('send')),
            !thread?.active && task.projectId ? h('button', { style: css.btn, disabled: busy, onClick: () => run({ action: task.threadId || task.stuck || task.state === 'failed' ? 'retry' : 'dispatch', task: task.id }) }, task.threadId || task.stuck || task.state === 'failed' ? t('retry') : t('start')) : null,
            thread?.active && (task.stuck || task.state === 'failed') ? h('button', { style: css.btn, disabled: busy, onClick: () => run({ action: 'retry', task: task.id }) }, t('retry')) : null,
            h('span', { style: { flex: 1 } }),
            h('button', { style: css.btn, disabled: busy, onClick: () => run({ action: 'drop', task: task.id }) }, t('drop'))),
          actError ? h('div', { style: css.err }, actError) : null) : null,
        task.description ? h('p', { style: { whiteSpace: 'pre-wrap' } }, task.description) : null,
        d.threads.length ? h('div', null, h('h3', null, t('threads')), d.threads.map((th) => h('div', { key: th.id, style: css.muted }, [th.active ? '●' : null, th.machine, th.runtime, th.model, th.status, th.branch, th.worktree].filter(Boolean).join(' · ')))) : null,
        d.outputs.length ? h('div', null, h('h3', null, t('outputs')), d.outputs.map((o) => h('div', { key: o.id }, o.url ? h('a', { href: o.url, target: '_blank', rel: 'noreferrer' }, o.title) : o.title))) : null,
        d.decisions.length > open.length ? h('div', null, h('h3', null, t('decisions')), d.decisions.filter((x) => !x.open).map((x) => h('div', { key: x.id, style: css.muted }, `${x.question} → ${x.choice ?? ''}`))) : null,
        h('h3', null, `${t('timeline')} (${d.timeline.length})`),
        d.timeline.slice(-300).reverse().map((e) => h('div', { key: e.id, style: css.ev },
          h('span', { style: css.muted }, `${e.at.replace('T', ' ').slice(0, 16)} · ${e.actor} · ${e.type}${e.reason ? ` · ${e.reason}` : ''}`),
          e.data?.text ? h('div', null, (typeof e.data.text === 'string' ? e.data.text : JSON.stringify(e.data.text)).slice(0, 4000)) : null)));
    }

    function TasksPage({ t }) {
      const [open, setOpen] = useState(null);
      return open ? h(Detail, { t, id: open, onBack: () => setOpen(null) }) : h(Board, { t, onOpen: setOpen });
    }

    const Icon = ({ size = 18 }) => h('svg', { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round' },
      h('rect', { x: 3, y: 4, width: 18, height: 16, rx: 2 }),
      h('path', { d: 'M7 9h4M7 13h7M7 17h5' }),
      h('path', { d: 'M15 8.5l1.2 1.2L18.5 7.5' }));

    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, DICT), 'autodos: dictionaries');
      const t = ctx.locale.bind(NS);
      ctx.slots.inject('main', function* () {
        yield ctx.slots.register({ name: 'main', key: PANEL, locale: NS }, (props) => h(TasksPage, { ...props, t }));
      });
      ctx.slots.inject('sidebar.panellist', () =>
        ctx.slots.register({ name: 'sidebar.panellist', id: PANEL, order: 14, label: () => t('panel'), locale: NS }, Icon));
    }

    module.exports.apply = apply;
    module.exports.inject = ['slots', 'locale'];
    return module.exports;
  },
});
