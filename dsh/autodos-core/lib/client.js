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
      },
    };

    async function getJson(url) {
      const res = await fetch(url, { credentials: 'same-origin' });
      const body = await res.json().catch(() => undefined);
      if (!res.ok || body?.ok !== true) throw new Error(body?.error || `HTTP ${res.status}`);
      return body;
    }

    const ago = (iso) => {
      const s = (Date.now() - Date.parse(iso)) / 1000;
      if (!isFinite(s)) return '';
      if (s < 90) return `${Math.max(1, Math.round(s))}s`;
      if (s < 5400) return `${Math.round(s / 60)}m`;
      if (s < 129600) return `${Math.round(s / 3600)}h`;
      return `${Math.round(s / 86400)}d`;
    };
    // The task's own words when it has them, else the translated kind ("Review the change").
    const needs = (t, r) => {
      if (typeof r.waitingFor !== 'string') r = { ...r, waitingFor: null };
      if (!r.waitingFor && !r.waitingKind) return '';
      const label = r.waitingKind ? t(`w_${r.waitingKind}`) : '';
      return r.waitingFor && r.waitingFor !== DICT.en[`w_${r.waitingKind}`] ? r.waitingFor : label || r.waitingFor;
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
      ev: { padding: '6px 0', borderTop: '1px solid rgba(127,127,127,.15)', whiteSpace: 'pre-wrap', wordBreak: 'break-word' },
    };

    function Board({ t, onOpen }) {
      const [data, setData] = useState(null);
      const [error, setError] = useState('');
      const [all, setAll] = useState(false);
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
          h('button', { style: css.btn, onClick: load }, t('refresh'))),
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
                needs(t, r) ? h('div', null, needs(t, r)) : null,
                r.stuck ? h('div', { style: { color: tone.stuck } }, `${t('stuck')}: ${r.stuck.split('\n')[0].slice(0, 200)}`) : null),
              h('div', { style: css.muted, title: r.lastProgressAt }, ago(r.lastProgressAt))))),
        data?.imported && h('div', { style: { ...css.muted, marginTop: 16, fontSize: 12 } }, `${t('imported')} · ${data.imported.at}`));
    }

    function Detail({ t, id, onBack }) {
      const [d, setD] = useState(null);
      const [error, setError] = useState('');
      useEffect(() => {
        getJson(`/api/autodos/task?id=${encodeURIComponent(id)}`).then(setD, (e) => setError(e.message));
      }, [id]);
      if (error) return h('div', { style: css.page }, h('button', { style: css.btn, onClick: onBack }, t('back')), h('p', null, error));
      if (!d) return h('div', { style: css.page }, t('loading'));
      const task = d.task;
      return h('div', { style: css.page },
        h('button', { style: { ...css.btn, marginBottom: 12 }, onClick: onBack }, t('back')),
        h('h1', { style: css.h1 }, `${task.number ? `#${task.number} ` : ''}${task.title}`),
        h('p', null, h('span', { style: css.pill(task.state) }, t(`s_${task.state}`)), ' ', needs(t, task)),
        task.stuck ? h('pre', { style: { whiteSpace: 'pre-wrap', color: tone.stuck } }, task.stuck) : null,
        task.description ? h('p', { style: { whiteSpace: 'pre-wrap' } }, task.description) : null,
        d.threads.length ? h('div', null, h('h3', null, t('threads')), d.threads.map((th) => h('div', { key: th.id, style: css.muted }, [th.machine, th.runtime, th.branch, th.worktree].filter(Boolean).join(' · ')))) : null,
        d.outputs.length ? h('div', null, h('h3', null, t('outputs')), d.outputs.map((o) => h('div', { key: o.id }, o.url ? h('a', { href: o.url, target: '_blank', rel: 'noreferrer' }, o.title) : o.title))) : null,
        d.decisions.length ? h('div', null, h('h3', null, t('decisions')), d.decisions.map((x) => h('div', { key: x.id }, `${x.open ? '● ' : ''}${x.question}`))) : null,
        h('h3', null, `${t('timeline')} (${d.timeline.length})`),
        d.timeline.slice(-300).map((e) => h('div', { key: e.id, style: css.ev },
          h('span', { style: css.muted }, `${e.at.replace('T', ' ').slice(0, 16)} · ${e.actor} · ${e.type}`),
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
