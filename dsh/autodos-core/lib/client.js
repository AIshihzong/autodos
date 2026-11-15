// Browser half of dsh-autodos-core: a "任务 / Tasks" item in the DSH sidebar.
// Three views of the same board: 待处理 (what waits on you), 看板 (columns by state), 列表 (one line per task).
// A task opens in a drawer on the right: what it waits for first, then where it runs, what it delivered,
// and its timeline; replying and acting stay pinned at the bottom.
// Colours come from DSH's own theme variables (--dsw-alias-*), so light and dark mode follow DSH.
// The visual approach (theme tokens, columns, cards, drawer) follows dsh-super-kanban (MIT, TopMindSpace).
// DSH loads this file through its module loader (not plain ESM); React comes from the shell.
window.__ModuleLoader__.load({
  id: 'dsh-autodos-core',
  factory: (require) => {
    const React = require('react');
    const h = React.createElement;
    const { useEffect, useState, useCallback, useMemo, useRef } = React;
    const module = { exports: {} };

    const NS = 'autodos';
    const PANEL = 'autodos-tasks';
    const DICT = {
      zh: {
        panel: 'Autodos',
        title: '任务',
        brand_sub: '大总管',
        sec_tasks: '任务',
        sec_staff: '员工',
        sec_machines: '机器',
        sec_agents: 'Agent',
        powered: '由 DeepSeek Harness 驱动',
        staff_prefer: '优先用哪种 agent',
        staff_pin: '固定人选（可不选）',
        staff_pin_none: '不固定，派活时自动挑',
        staff_note: '员工是岗位，不绑机器。派活时会挑一个有空、有额度的 agent 来做，优先用你选的那种。',
        staff_hint: '员工是岗位：谁负责什么。具体谁来干，派活时自动挑 agent。',
        staff_always: '固定：{0}',
        staff_prefers: '优先：{0}',
        m_has: '这台机器装了',
        a_ready: '可用',
        a_off: '已停用',
        a_limited: '额度用完，{0} 恢复',
        a_missing: '没装',
        a_cannot: '暂不能接活',
        a_cannot_note: 'Paseo 还不能启动它，先在这里列出来',
        a_declared: '手动添加',
        a_clear: '手动恢复',
        a_cap: '同时',
        a_turn_on: '启用',
        a_turn_off: '停用',
        a_none: '这台机器还没有 agent',
        a_add: '添加 agent',
        a_notinst: '没装：{0}',
        w_agent: '等空闲的 agent',
        add_staff: '添加员工',
        add_machine: '添加机器',
        edit: '编辑',
        remove: '删除',
        remove_confirm: '确定删除？',
        save: '保存',
        staff_name: '名字',
        staff_name_ph: '比如：前端工程师',
        staff_role: '负责什么',
        staff_role_ph: '比如：页面、交互和样式',
        staff_runtime: '用哪个 agent',
        staff_machine: '在哪台机器干活',
        staff_instr: '工作说明',
        staff_instr_ph: '每次派活都会带上，比如代码规范、注意事项',
        staff_empty: '还没有员工。添加一个，派活时就能指定谁来做。',
        rt_claude: 'Claude Code',
        rt_codex: 'Codex',
        rt_auto: '自动',
        m_name: '名字',
        m_name_ph: '比如：工作室 Mac',
        m_host: 'Paseo 地址',
        m_host_ph: '比如 192.168.1.20:6767',
        m_capacity: '同时最多跑几个',
        m_notes: '备注',
        m_local: '本机',
        m_running: '正在跑',
        m_agents: '装了的 agent',
        m_used: '用过',
        m_none_found: '没找到',
        m_staff: '在这台机器的员工',
        m_remote_note: '另一台机器要先装好 Paseo 并启动 daemon，项目在那台机器上也要有一份代码。',
        c_count_working: '进行中',
        c_count_waiting: '等你',
        c_count_stuck: '卡住',
        c_count_queued: '排队',
        c_count_done: '完成',
        f_staff: '谁来做',
        f_staff_any: '不指定',
        empty: '这里没有任务。',
        empty_inbox: '没有等你处理的任务。',
        all: '显示已结束的',
        refresh: '刷新',
        loading: '加载中…',
        who: '谁在做',
        state: '状态',
        needs: '等你',
        stuck: '卡在',
        moved: '最后进展',
        outputs: '交付物',
        back: '返回',
        close: '关闭',
        timeline: '时间线',
        threads: '在哪跑',
        decisions: '已做的决定',
        waiting: '等你处理',
        description: '说明',
        imported: '已从 Autodos 导入',
        v_inbox: '待处理',
        v_board: '看板',
        v_list: '列表',
        search: '搜索任务、项目、编号',
        all_projects: '全部项目',
        s_waiting_you: '等你',
        s_stuck: '卡住',
        s_working: '进行中',
        s_review: '评审中',
        s_queued: '排队',
        s_landing: '合并中',
        s_done: '完成',
        s_failed: '失败',
        s_dropped: '已关闭',
        c_waiting: '等你',
        c_trouble: '卡住 / 失败',
        c_working: '进行中',
        c_queued: '排队',
        c_finished: '已结束',
        none: '无',
        unassigned: '未分配',
        more: '另 {0} 项',
        show_more: '展开',
        show_less: '收起',
        w_confirm_plan: '确认计划',
        w_confirm_start: '开工前确认',
        w_answer: '回答一个问题',
        w_review: '评审改动',
        w_lead_hold: '负责人在等你决定',
        w_retry: '回复或重试',
        w_result: '看结果：通过，或说要改什么',
        w_permission: '允许或拒绝一个操作',
        w_budget: '预算用完：加预算或关闭',
        new_task: '新建',
        new_task_title: '新建任务',
        f_title: '标题',
        f_title_ph: '要做什么，一句话',
        f_desc: '说明',
        f_desc_ph: '交给 agent 的任务描述：目标、限制、怎么验收',
        f_project: '项目',
        f_start: '立刻开工',
        create: '创建',
        cancel: '取消',
        reply_ph: '对 agent 说点什么…（⌘/Ctrl + Enter 发送）',
        send: '发送',
        retry: '重试',
        start: '开工',
        drop: '关闭任务',
        drop_confirm: '确定关闭？',
        note_ph: '要改什么（选“继续改”时必填）',
        o_Allow: '允许',
        allow_tool: '允许使用 {0}？',
        o_Deny: '拒绝',
        o_Accept: '通过并合并',
        'o_Keep working': '继续改',
        'o_Add budget': '加预算继续',
        o_Close: '关闭任务',
        irreversible: '这一步可能无法撤销',
        no_exec: '执行层（Paseo）没有配置，只能看不能派工。',
        working_on: '处理中…',
        spent: '已花',
        e_message: '消息',
        e_activity: 'agent 输出',
        e_state: '状态变化',
        e_check: '检查',
        e_landing: '合并',
        e_decision: '决定',
        e_other: '记录',
      },
      en: {
        panel: 'Autodos',
        title: 'Tasks',
        brand_sub: 'Chief of staff',
        sec_tasks: 'Tasks',
        sec_staff: 'Staff',
        sec_machines: 'Machines',
        sec_agents: 'Agents',
        powered: 'Powered by DeepSeek Harness',
        staff_prefer: 'Preferred agent',
        staff_pin: 'Always use (optional)',
        staff_pin_none: 'Not fixed: pick one per task',
        staff_note: 'Staff are roles, not machines. Each task goes to a free agent with quota left, the preferred kind first.',
        staff_hint: 'Staff are roles: who is responsible for what. The agent doing the work is picked per task.',
        staff_always: 'Always: {0}',
        staff_prefers: 'Prefers: {0}',
        m_has: 'Installed there',
        a_ready: 'Ready',
        a_off: 'Off',
        a_limited: 'Out of quota until {0}',
        a_missing: 'Not installed',
        a_cannot: 'Cannot take tasks yet',
        a_cannot_note: 'Paseo cannot start it yet; listed for now',
        a_declared: 'added by hand',
        a_clear: 'Mark as back',
        a_cap: 'At once',
        a_turn_on: 'Turn on',
        a_turn_off: 'Turn off',
        a_none: 'No agents on this machine yet',
        a_add: 'Add agent',
        a_notinst: 'Not installed: {0}',
        w_agent: 'Waiting for a free agent',
        add_staff: 'Add staff',
        add_machine: 'Add machine',
        edit: 'Edit',
        remove: 'Remove',
        remove_confirm: 'Remove it?',
        save: 'Save',
        staff_name: 'Name',
        staff_name_ph: 'e.g. Frontend engineer',
        staff_role: 'Responsible for',
        staff_role_ph: 'e.g. pages, interaction and styles',
        staff_runtime: 'Agent',
        staff_machine: 'Works on machine',
        staff_instr: 'Instructions',
        staff_instr_ph: 'Sent with every task, e.g. coding rules and things to watch',
        staff_empty: 'No staff yet. Add someone to choose who does a task.',
        rt_claude: 'Claude Code',
        rt_codex: 'Codex',
        rt_auto: 'Auto',
        m_name: 'Name',
        m_name_ph: 'e.g. Studio Mac',
        m_host: 'Paseo address',
        m_host_ph: 'e.g. 192.168.1.20:6767',
        m_capacity: 'At most at once',
        m_notes: 'Notes',
        m_local: 'This machine',
        m_running: 'Running',
        m_agents: 'Agents installed',
        m_used: 'used',
        m_none_found: 'none found',
        m_staff: 'Staff on this machine',
        m_remote_note: 'The other machine needs Paseo installed with its daemon running, and its own checkout of the project.',
        c_count_working: 'working',
        c_count_waiting: 'needs you',
        c_count_stuck: 'stuck',
        c_count_queued: 'queued',
        c_count_done: 'done',
        f_staff: 'Who does it',
        f_staff_any: 'Anyone',
        empty: 'No tasks here.',
        empty_inbox: 'Nothing is waiting on you.',
        all: 'Show finished',
        refresh: 'Refresh',
        loading: 'Loading…',
        who: 'Who',
        state: 'State',
        needs: 'Needs you',
        stuck: 'Stuck',
        moved: 'Last moved',
        outputs: 'Delivered',
        back: 'Back',
        close: 'Close',
        timeline: 'Timeline',
        threads: 'Where it ran',
        decisions: 'Past decisions',
        waiting: 'Waiting on you',
        description: 'Description',
        imported: 'Imported from Autodos',
        v_inbox: 'Inbox',
        v_board: 'Board',
        v_list: 'List',
        search: 'Search tasks, projects, numbers',
        all_projects: 'All projects',
        s_waiting_you: 'Needs you',
        s_stuck: 'Stuck',
        s_working: 'Working',
        s_review: 'In review',
        s_queued: 'Queued',
        s_landing: 'Landing',
        s_done: 'Done',
        s_failed: 'Failed',
        s_dropped: 'Closed',
        c_waiting: 'Needs you',
        c_trouble: 'Stuck / failed',
        c_working: 'Working',
        c_queued: 'Queued',
        c_finished: 'Finished',
        none: 'none',
        unassigned: 'unassigned',
        more: '{0} more',
        show_more: 'More',
        show_less: 'Less',
        w_confirm_plan: 'Confirm the plan',
        w_confirm_start: 'Confirm before it starts',
        w_answer: 'Answer a question',
        w_review: 'Review the change',
        w_lead_hold: 'The lead is holding it for you',
        w_retry: 'Reply or retry',
        w_result: 'Look at the result: accept, or say what to change',
        w_permission: 'Allow or deny an action',
        w_budget: 'Budget reached: add more or close',
        new_task: 'New',
        new_task_title: 'New task',
        f_title: 'Title',
        f_title_ph: 'What to do, in one line',
        f_desc: 'Description',
        f_desc_ph: 'The brief the agent works from: goal, constraints, how to check it',
        f_project: 'Project',
        f_start: 'Start now',
        create: 'Create',
        cancel: 'Cancel',
        reply_ph: 'Say something to the agent… (⌘/Ctrl + Enter to send)',
        send: 'Send',
        retry: 'Retry',
        start: 'Start',
        drop: 'Close task',
        drop_confirm: 'Close it?',
        note_ph: 'What to change (needed for “Keep working”)',
        o_Allow: 'Allow',
        allow_tool: 'Allow {0}?',
        o_Deny: 'Deny',
        o_Accept: 'Accept and merge',
        'o_Keep working': 'Keep working',
        'o_Add budget': 'Add budget and continue',
        o_Close: 'Close the task',
        irreversible: 'This may not be undoable',
        no_exec: 'No execution layer (Paseo) is configured: read only.',
        working_on: 'Working…',
        spent: 'Spent',
        e_message: 'Message',
        e_activity: 'Agent output',
        e_state: 'State',
        e_check: 'Check',
        e_landing: 'Merge',
        e_decision: 'Decision',
        e_other: 'Note',
      },
    };

    // ---------------------------------------------------------------- styles

    const CSS = `
.ad-page,.ad-overlay{--ad-line:var(--dsw-alias-border-l2,rgba(0,0,0,.10));--ad-line-soft:var(--dsw-alias-border-l1,rgba(0,0,0,.05));
  --ad-line-strong:var(--dsw-alias-border-l3,rgba(0,0,0,.14));--ad-surface:var(--dsw-alias-bg-layer-1,#fff);
  --ad-base:var(--dsw-alias-bg-base,#fff);
  --ad-surface-2:color-mix(in srgb,var(--dsw-alias-bg-module-platform,#f5f6f7) 55%,var(--ad-base));
  --ad-col:color-mix(in srgb,var(--dsw-alias-bg-module-platform,#f5f6f7) 36%,var(--ad-base));
  --ad-ink:var(--dsw-alias-label-primary,#0f1115);--ad-ink-2:var(--dsw-alias-label-secondary,#61666b);
  --ad-ink-3:var(--dsw-alias-label-tertiary,#81858c);--ad-ink-4:var(--dsw-alias-label-caption,#adb2b8);
  --ad-primary:var(--dsw-alias-button-primary-fill,#0f1115);--ad-primary-hover:var(--dsw-alias-button-primary-hover,#43454a);
  --ad-on-primary:var(--dsw-alias-label-primary-foreground,#fff);
  --ad-blue:var(--dsw-alias-state-business-primary,#4176e6);--ad-green:var(--dsw-alias-state-success-primary,#22c55e);
  --ad-amber:var(--dsw-alias-state-warn-primary,#f59e0b);--ad-red:var(--dsw-alias-state-error-primary,#ec1313);
  --ad-hover:var(--dsw-alias-interactive-bg-hover,rgba(38,49,72,.06));
  --ad-lift:0 0 0 .5px color-mix(in srgb,var(--ad-ink) 9%,transparent),0 6px 18px rgba(0,0,0,.07);
  --ad-mask:color-mix(in srgb,var(--dsw-alias-bg-mask-3,#0000007a) 46%,transparent);
  --ad-ease:cubic-bezier(.4,0,.2,1);
  --ad-brand:#0e8a7c;--ad-brand-hover:#0b7569;--ad-brand-soft:rgba(14,138,124,.10);--ad-on-brand:#fff;
  font-family:var(--dsh-font-family-text-default,-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif);
  color:var(--ad-ink);font-size:13px;line-height:1.45;-webkit-font-smoothing:antialiased}
@media (prefers-color-scheme:dark){.ad-page,.ad-overlay{--ad-brand:#3cc2b1;--ad-brand-hover:#5fd0c2;--ad-brand-soft:rgba(60,194,177,.13);--ad-on-brand:#06201d}}
.ad-page *,.ad-overlay *{box-sizing:border-box}
.ad-brand{display:flex;align-items:center;gap:10px;flex:none}
.ad-brand svg{flex:none;border-radius:8px}
.ad-brand b{font-size:17px;font-weight:700;letter-spacing:-.01em}
.ad-brand span{font-size:11.5px;color:var(--ad-ink-3);padding-left:10px;border-left:1px solid var(--ad-line)}
.ad-nav{display:flex;gap:4px;margin-left:8px}
.ad-nav button{cursor:pointer;border:none;background:transparent;color:var(--ad-ink-2);height:30px;padding:0 12px;border-radius:8px;font-size:13px;font-weight:560;display:inline-flex;gap:6px;align-items:center}
.ad-nav button:hover{background:var(--ad-hover);color:var(--ad-ink)}
.ad-nav button.on{background:var(--ad-brand-soft);color:var(--ad-brand)}
.ad-nav .n{min-width:18px;height:17px;padding:0 5px;border-radius:9px;background:var(--ad-amber);color:#fff;font-size:10px;display:inline-flex;align-items:center;justify-content:center}
.ad-topline{display:flex;align-items:center;gap:12px;flex-wrap:wrap;padding-bottom:12px;border-bottom:1px solid var(--ad-line-soft)}
.ad-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:12px;align-items:start}
.ad-person{border:1px solid var(--ad-line);border-radius:14px;background:var(--ad-surface);padding:14px;display:flex;flex-direction:column;gap:10px}
.ad-person-head{display:flex;gap:10px;align-items:center}
.ad-avatar{width:36px;height:36px;border-radius:11px;display:grid;place-items:center;font-weight:700;font-size:15px;color:#fff;background:var(--tone,var(--ad-brand));flex:none}
.ad-person-head b{font-size:14px}
.ad-chips{display:flex;gap:6px;flex-wrap:wrap}
.ad-chip{display:inline-flex;align-items:center;gap:4px;height:22px;padding:0 8px;border-radius:7px;font-size:11px;background:var(--ad-surface-2);color:var(--ad-ink-2);border:1px solid var(--ad-line-soft);white-space:nowrap}
.ad-chip.ok{color:var(--ad-brand);background:var(--ad-brand-soft);border-color:transparent}
.ad-chip.off{color:var(--ad-ink-4)}
.ad-powered{font-size:11px;color:var(--ad-ink-4);white-space:nowrap}
@media (max-width:640px){.ad-powered{display:none}}
.ad-chip.pick{cursor:pointer;height:28px;padding:0 12px;font-size:12px}
.ad-chip.st-ready{color:var(--ad-brand);background:var(--ad-brand-soft);border-color:transparent}
.ad-chip.st-limited{color:var(--ad-amber);background:color-mix(in srgb,var(--ad-amber) 12%,transparent);border-color:transparent}
.ad-chip.st-off,.ad-chip.st-missing,.ad-chip.st-cannot{color:var(--ad-ink-4)}
.ad-stack{display:flex;flex-direction:column;gap:14px;max-width:980px}
.ad-machine{border:1px solid var(--ad-line);border-radius:14px;background:var(--ad-surface);padding:14px;display:flex;flex-direction:column;gap:4px}
.ad-machine-head{display:flex;gap:10px;align-items:center;padding-bottom:10px;margin-bottom:4px;border-bottom:1px solid var(--ad-line-soft)}
.ad-machine-head b{font-size:14px}
.ad-machine-foot{display:flex;gap:8px;align-items:center;flex-wrap:wrap;font-size:12px;padding-top:6px}
.ad-agent{display:flex;flex-direction:column;gap:4px;padding:8px 4px;border-radius:10px}
.ad-agent+.ad-agent{border-top:1px dashed var(--ad-line-soft)}
.ad-agent.dim .ad-avatar{opacity:.55}
.ad-agent-main{display:flex;gap:10px;align-items:center;flex-wrap:wrap}
.ad-agent-name{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.ad-agent-name b{font-size:13.5px}
.ad-agent-acts{display:flex;gap:6px;align-items:center;flex-wrap:wrap}
.ad-cap{display:inline-flex;gap:6px;align-items:center;font-size:12px}
.ad-cap .ad-select{width:auto;height:30px;padding:0 24px 0 8px}
.ad-avatar.sm{width:28px;height:28px;border-radius:8px;font-size:13px}
.ad-stats{display:flex;gap:12px;flex-wrap:wrap;font-size:12px;color:var(--ad-ink-3)}
.ad-stats b{color:var(--ad-ink);font-variant-numeric:tabular-nums;margin-right:3px}
.ad-mini{display:flex;flex-direction:column;gap:2px}
.ad-mini button{cursor:pointer;text-align:left;border:none;background:transparent;color:var(--ad-ink-2);font-size:12px;padding:3px 6px;border-radius:6px;display:flex;gap:6px;align-items:center;min-width:0}
.ad-mini button:hover{background:var(--ad-hover);color:var(--ad-ink)}
.ad-mini button span:last-child{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ad-page button,.ad-page input,.ad-page textarea,.ad-page select,.ad-overlay button,.ad-overlay input,.ad-overlay textarea,.ad-overlay select{font-family:inherit}
.ad-page{height:100%;display:flex;flex-direction:column;gap:12px;overflow:hidden;background:var(--ad-base);
  padding:calc(var(--dsh-frame-top-clearance,0px) + 22px) 26px 16px}
.ad-page :focus-visible,.ad-overlay :focus-visible{outline:2px solid color-mix(in srgb,var(--ad-blue) 55%,transparent);outline-offset:2px}
.ad-page ::-webkit-scrollbar,.ad-overlay ::-webkit-scrollbar{width:6px;height:6px}
.ad-page ::-webkit-scrollbar-thumb,.ad-overlay ::-webkit-scrollbar-thumb{background:var(--dsw-alias-scrollbar-bg-l1,#e5e5e5);border-radius:99px}
@keyframes adPulse{0%,100%{opacity:1}50%{opacity:.35}}
@keyframes adFade{from{opacity:0}to{opacity:1}}
@keyframes adSlide{from{transform:translateX(32px);opacity:.55}to{transform:none;opacity:1}}
@keyframes adPop{from{transform:scale(.98) translateY(6px);opacity:0}to{transform:none;opacity:1}}

.ad-head{display:flex;align-items:center;gap:12px;flex-wrap:wrap}
.ad-head h1{margin:0;font-size:20px;font-weight:650;letter-spacing:-.01em}
.ad-sum{display:flex;gap:10px;flex-wrap:wrap;font-size:11.5px;color:var(--ad-ink-3)}
.ad-sum span{display:inline-flex;align-items:center;gap:5px;white-space:nowrap}
.ad-grow{flex:1}
.ad-bar{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.ad-dot{width:7px;height:7px;border-radius:99px;background:var(--tone,var(--ad-ink-4));flex:none;display:inline-block}
.ad-dot.live{animation:adPulse 1.6s ease-in-out infinite}

.ad-btn{cursor:pointer;display:inline-flex;align-items:center;justify-content:center;gap:6px;height:32px;border:1px solid var(--ad-line);
  background:var(--ad-surface);color:var(--ad-ink);border-radius:9px;padding:0 12px;font-size:12px;font-weight:500;line-height:1;white-space:nowrap;
  transition:background .18s var(--ad-ease),border-color .18s,color .18s,transform .12s}
.ad-btn:hover{background:var(--ad-hover);border-color:var(--ad-line-strong)}
.ad-btn:active{transform:translateY(.5px)}
.ad-btn.primary{background:var(--ad-brand);border-color:transparent;color:var(--ad-on-brand);font-weight:600;box-shadow:0 1px 2px rgba(0,0,0,.12)}
.ad-btn.primary:hover{background:var(--ad-brand-hover)}
.ad-btn.ghost{background:transparent;border-color:transparent;color:var(--ad-ink-2)}
.ad-btn.ghost:hover{background:var(--ad-hover);color:var(--ad-ink)}
.ad-btn.icon{padding:0;width:32px}
.ad-btn.danger{color:var(--ad-red);border-color:color-mix(in srgb,var(--ad-red) 28%,transparent)}
.ad-btn.danger:hover{background:color-mix(in srgb,var(--ad-red) 9%,transparent)}
.ad-btn:disabled{opacity:.45;cursor:not-allowed;transform:none}

.ad-tabs{display:inline-flex;gap:2px;padding:3px;border:1px solid var(--ad-line);border-radius:10px;background:var(--ad-surface)}
.ad-tabs button{cursor:pointer;border:none;background:transparent;color:var(--ad-ink-2);height:26px;padding:0 11px;border-radius:7px;font-size:12px;display:inline-flex;gap:5px;align-items:center}
.ad-tabs button:hover{background:var(--ad-hover);color:var(--ad-ink)}
.ad-tabs button.on{background:var(--ad-brand-soft);color:var(--ad-brand);font-weight:620}
.ad-tabs .n{font-size:10.5px;color:var(--ad-ink-3);font-variant-numeric:tabular-nums}

.ad-input,.ad-textarea,.ad-select{width:100%;height:32px;border:1px solid var(--ad-line);border-radius:9px;background:var(--ad-surface);
  color:var(--ad-ink);padding:0 10px;font-size:12.5px;outline:none;transition:border-color .15s,box-shadow .15s}
.ad-input:hover,.ad-textarea:hover,.ad-select:hover{border-color:var(--ad-line-strong)}
.ad-input:focus,.ad-textarea:focus,.ad-select:focus{border-color:color-mix(in srgb,var(--ad-blue) 55%,var(--ad-line));box-shadow:0 0 0 3px color-mix(in srgb,var(--ad-blue) 11%,transparent)}
.ad-textarea{height:auto;min-height:64px;padding:8px 10px;line-height:1.55;resize:vertical}
.ad-select{width:auto;padding-right:24px;appearance:none;cursor:pointer;color:var(--ad-ink-2);
  background-image:linear-gradient(45deg,transparent 50%,var(--ad-ink-4) 50%),linear-gradient(135deg,var(--ad-ink-4) 50%,transparent 50%);
  background-position:calc(100% - 12px) 52%,calc(100% - 8px) 52%;background-size:4px 4px;background-repeat:no-repeat}
.ad-search{width:min(280px,100%)}
.ad-err{color:var(--ad-red);font-size:12px;white-space:pre-wrap}
.ad-muted{color:var(--ad-ink-3)}
.ad-empty{margin:24px auto;text-align:center;font-size:12px;color:var(--ad-ink-4);padding:28px 16px;border:1px dashed color-mix(in srgb,var(--ad-ink-4) 40%,transparent);border-radius:12px;max-width:420px}

.ad-scroll{flex:1;min-height:0;overflow:auto}
.ad-cols{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:12px;min-height:100%;align-items:start}
.ad-col{display:flex;flex-direction:column;border:1px solid var(--ad-line-soft);border-radius:14px;background:var(--ad-col);position:relative;overflow:hidden;min-width:0}
.ad-col::before{content:"";position:absolute;left:0;right:0;top:0;height:2px;background:linear-gradient(90deg,color-mix(in srgb,var(--tone,var(--ad-ink-3)) 60%,transparent),transparent 62%)}
.ad-col-head{display:flex;align-items:center;gap:7px;padding:12px 12px 8px 14px}
.ad-col-head b{font-size:12px;font-weight:620}
.ad-col-n{min-width:20px;height:18px;display:inline-flex;align-items:center;justify-content:center;padding:0 6px;border-radius:6px;
  background:var(--ad-surface-2);border:1px solid var(--ad-line-soft);color:var(--ad-ink-3);font-size:10px;font-weight:600}
.ad-col-body{display:flex;flex-direction:column;gap:8px;padding:2px 8px 10px}
.ad-col-empty{font-size:11px;color:var(--ad-ink-4);text-align:center;padding:16px 8px}

.ad-card{cursor:pointer;text-align:left;width:100%;border:1px solid var(--ad-line);border-radius:12px;background:var(--ad-surface);color:inherit;
  padding:10px 12px 9px;display:flex;flex-direction:column;gap:5px;transition:box-shadow .16s var(--ad-ease),transform .16s var(--ad-ease),border-color .16s}
.ad-card:hover{transform:translateY(-1px);border-color:var(--ad-line-strong);box-shadow:var(--ad-lift)}
.ad-card.sel{border-color:color-mix(in srgb,var(--ad-blue) 55%,var(--ad-line))}
.ad-card-title{display:flex;gap:7px;align-items:baseline;font-weight:600;font-size:13px;line-height:1.4}
.ad-card-title .ad-dot{transform:translateY(-1px)}
.ad-card-title span{min-width:0;overflow-wrap:anywhere}
.ad-meta{display:flex;flex-wrap:wrap;gap:4px 8px;font-size:11px;color:var(--ad-ink-3);align-items:center}
.ad-meta .sep{color:var(--ad-ink-4)}
.ad-meta>span{max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ad-need{font-size:12px;color:var(--ad-ink-2);display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;overflow-wrap:anywhere}
.ad-need b{color:var(--tone,var(--ad-ink));font-weight:600}
.ad-stuck{font-size:11.5px;color:var(--ad-red);display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;overflow-wrap:anywhere}
.ad-tag{display:inline-flex;align-items:center;gap:4px;height:20px;padding:0 7px;border-radius:6px;font-size:11px;font-weight:560;
  color:var(--tone,var(--ad-ink-2));background:color-mix(in srgb,var(--tone,var(--ad-ink-3)) 10%,transparent);border:1px solid color-mix(in srgb,var(--tone,var(--ad-ink-3)) 26%,transparent);white-space:nowrap}

.ad-list{display:flex;flex-direction:column;border:1px solid var(--ad-line-soft);border-radius:12px;overflow:hidden;background:var(--ad-surface)}
.ad-row{cursor:pointer;display:grid;grid-template-columns:minmax(200px,2.2fr) minmax(120px,1fr) 96px minmax(160px,2fr) 56px;gap:12px;align-items:start;
  padding:10px 14px;border:none;border-top:1px solid var(--ad-line-soft);background:transparent;color:inherit;text-align:left;font-size:12.5px}
.ad-row:first-child{border-top:none}
.ad-row:hover{background:var(--ad-hover)}
.ad-row.th{cursor:default;font-size:11px;color:var(--ad-ink-3);font-weight:600;background:var(--ad-surface-2)}
.ad-row.th:hover{background:var(--ad-surface-2)}
@media (max-width:720px){.ad-row{grid-template-columns:1fr 90px}.ad-row>:nth-child(2),.ad-row>:nth-child(4),.ad-row>:nth-child(5){display:none}}

.ad-mask{position:fixed;inset:0;background:var(--ad-mask);z-index:60;animation:adFade .18s var(--ad-ease);backdrop-filter:blur(1.5px)}
.ad-drawer{position:fixed;top:0;right:0;bottom:0;width:min(620px,96vw);z-index:61;display:flex;flex-direction:column;background:var(--ad-surface);
  border-left:1px solid var(--ad-line-strong);border-radius:14px 0 0 14px;box-shadow:-14px 0 48px rgba(0,0,0,.16);animation:adSlide .24s cubic-bezier(.22,.7,.3,1);overflow:hidden}
.ad-drawer-head{padding:calc(var(--dsh-frame-top-clearance,0px) + 14px) 18px 12px 22px;border-bottom:1px solid var(--ad-line-soft);display:flex;flex-direction:column;gap:8px}
.ad-drawer-title{display:flex;align-items:flex-start;gap:10px}
.ad-drawer-title h2{flex:1;margin:0;font-size:17px;font-weight:650;line-height:1.35;overflow-wrap:anywhere}
.ad-drawer-body{flex:1;overflow-y:auto;padding:4px 22px 26px}
.ad-sec{padding:14px 0;border-top:1px solid var(--ad-line-soft);display:flex;flex-direction:column;gap:8px}
.ad-sec:first-child{border-top:none}
.ad-sec>h3{margin:0;font-size:11.5px;font-weight:620;color:var(--ad-ink-3);letter-spacing:.01em;display:flex;gap:6px;align-items:center}
.ad-pre{margin:0;white-space:pre-wrap;overflow-wrap:anywhere;font-size:12.5px;line-height:1.6;color:var(--ad-ink-2)}
.ad-pre.err{color:var(--ad-red);font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11.5px;background:color-mix(in srgb,var(--ad-red) 5%,transparent);border-radius:8px;padding:8px 10px}
.ad-decision{border:1px solid color-mix(in srgb,var(--tone,var(--ad-amber)) 40%,var(--ad-line));background:color-mix(in srgb,var(--tone,var(--ad-amber)) 6%,var(--ad-surface));
  border-radius:12px;padding:12px;display:flex;flex-direction:column;gap:8px}
.ad-decision b{font-size:13px}
.ad-actions{display:flex;gap:8px;flex-wrap:wrap}
.ad-kv{display:flex;flex-direction:column;gap:4px;font-size:12px;color:var(--ad-ink-2)}
.ad-kv a{color:var(--ad-blue);text-decoration:none}
.ad-kv a:hover{text-decoration:underline}
.ad-ev{display:flex;gap:9px;padding:7px 0;border-top:1px dashed var(--ad-line-soft)}
.ad-ev:first-child{border-top:none}
.ad-ev-icon{flex:none;width:22px;height:22px;border-radius:7px;display:grid;place-items:center;background:var(--ad-surface-2);color:var(--tone,var(--ad-ink-3));font-size:11px;font-weight:700}
.ad-ev-body{min-width:0;flex:1;display:flex;flex-direction:column;gap:3px}
.ad-ev-meta{display:flex;gap:6px;flex-wrap:wrap;font-size:10.5px;color:var(--ad-ink-4)}
.ad-ev-meta .who{color:var(--ad-ink-3);font-weight:560}
.ad-ev-text{margin:0;font-size:12px;line-height:1.6;color:var(--ad-ink-2);white-space:pre-wrap;overflow-wrap:anywhere;display:-webkit-box;-webkit-line-clamp:5;-webkit-box-orient:vertical;overflow:hidden}
.ad-ev-text.open{display:block}
.ad-link{cursor:pointer;background:none;border:none;color:var(--ad-blue);font-size:11px;padding:0;text-align:left}
.ad-link:hover{text-decoration:underline}
.ad-drawer-foot{border-top:1px solid var(--ad-line-soft);padding:10px 18px 12px 22px;display:flex;flex-direction:column;gap:8px;background:color-mix(in srgb,var(--ad-surface) 94%,var(--ad-surface-2))}
.ad-drawer-foot .ad-textarea{min-height:44px;max-height:180px}

.ad-modal-mask{position:fixed;inset:0;background:var(--ad-mask);z-index:70;display:grid;place-items:center;padding:24px;animation:adFade .18s var(--ad-ease);backdrop-filter:blur(2px)}
.ad-modal{width:min(560px,94vw);max-height:86vh;overflow:auto;border-radius:16px;border:1px solid var(--ad-line-strong);background:var(--ad-surface);
  box-shadow:0 24px 72px rgba(0,0,0,.26);padding:22px;display:flex;flex-direction:column;gap:14px;animation:adPop .2s cubic-bezier(.2,.8,.3,1)}
.ad-modal h3{margin:0;font-size:15px;font-weight:650}
.ad-field{display:flex;flex-direction:column;gap:5px}
.ad-field label{font-size:11px;color:var(--ad-ink-3)}
.ad-check{display:inline-flex;gap:6px;align-items:center;font-size:12px;color:var(--ad-ink-2);cursor:pointer}
@media (prefers-reduced-motion:reduce){.ad-dot.live,.ad-drawer,.ad-modal,.ad-mask,.ad-modal-mask{animation:none!important}.ad-card:hover{transform:none}}
`;

    function ensureStyle() {
      const id = 'dsh-autodos-core/style.css';
      if (document.querySelector(`style[data-plugin-css="${id}"]`)) return;
      const tag = document.createElement('style');
      tag.dataset.plugin = 'dsh-autodos-core';
      tag.dataset.pluginCss = id;
      tag.textContent = CSS;
      document.head.appendChild(tag);
    }

    // ---------------------------------------------------------------- data

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

    // Run an action: busy while it runs, its error if it fails, then `after`.
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

    const store = {
      get(k, d) {
        try {
          return localStorage.getItem(`autodos:${k}`) ?? d;
        } catch {
          return d;
        }
      },
      set(k, v) {
        try {
          localStorage.setItem(`autodos:${k}`, v);
        } catch {
          /* private window: fine */
        }
      },
    };

    // Close the top overlay on Escape.
    function useEscape(fn) {
      const ref = useRef(fn);
      ref.current = fn;
      useEffect(() => {
        const on = (e) => e.key === 'Escape' && ref.current?.();
        window.addEventListener('keydown', on);
        return () => window.removeEventListener('keydown', on);
      }, []);
    }

    // ---------------------------------------------------------------- helpers

    const TONE = {
      waiting_you: 'var(--ad-amber)', stuck: 'var(--ad-red)', failed: 'var(--ad-red)', working: 'var(--ad-blue)', review: 'var(--ad-blue)',
      queued: 'var(--ad-ink-4)', landing: 'var(--ad-green)', done: 'var(--ad-green)', dropped: 'var(--ad-ink-4)',
    };
    const COLUMNS = [
      { key: 'c_waiting', states: ['waiting_you'], tone: TONE.waiting_you },
      { key: 'c_trouble', states: ['stuck', 'failed'], tone: TONE.stuck },
      { key: 'c_working', states: ['working', 'review', 'landing'], tone: TONE.working },
      { key: 'c_queued', states: ['queued'], tone: 'var(--ad-ink-3)' },
      { key: 'c_finished', states: ['done', 'dropped'], tone: TONE.done, finished: true },
    ];
    const INBOX = new Set(['waiting_you', 'stuck', 'failed']);

    const ago = (iso) => {
      const s = (Date.now() - Date.parse(iso)) / 1000;
      if (!isFinite(s)) return '';
      if (s < 90) return `${Math.max(1, Math.round(s))}s`;
      if (s < 5400) return `${Math.round(s / 60)}m`;
      if (s < 129600) return `${Math.round(s / 3600)}h`;
      return `${Math.round(s / 86400)}d`;
    };
    const when = (iso) => String(iso || '').replace('T', ' ').slice(0, 16);
    const fill = (s, n) => String(s).replace('{0}', n);
    const text = (v) => (typeof v === 'string' ? v : v == null ? '' : JSON.stringify(v));

    // What a task waits on you for: the translated kind first ("评审改动"), then the task's own words.
    const needs = (t, r) => {
      const note = typeof r.waitingFor === 'string' && r.waitingFor && r.waitingFor !== DICT.en[`w_${r.waitingKind}`] && r.waitingFor !== 'Needs you' ? r.waitingFor : '';
      const label = r.waitingKind ? t(`w_${r.waitingKind}`) : r.state === 'waiting_you' && !note ? t('needs') : '';
      return { label, note };
    };

    const Dot = ({ state }) => h('span', { className: `ad-dot${state === 'working' || state === 'landing' ? ' live' : ''}`, style: { '--tone': TONE[state] } });
    const Tag = ({ t, state }) => h('span', { className: 'ad-tag', style: { '--tone': TONE[state] } }, h(Dot, { state }), t(`s_${state}`));
    const host = (m) => (m ? String(m).replace(/\.local$/, '') : m);
    // Who, with what, where: "后端工程师 · Claude Code @ Mac-mini".
    const whoText = (w) => [w.staff, w.agent && w.machine ? `${w.agent} @ ${host(w.machine)}` : host(w.machine)].filter(Boolean).join(' · ');
    const num = (r) => (r.number != null ? `#${r.number}` : '');

    const Icon = {
      refresh: () => h('svg', { width: 15, height: 15, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round' }, h('path', { d: 'M20 11a8 8 0 1 0-2.3 5.7' }), h('path', { d: 'M20 4v7h-7' })),
      close: () => h('svg', { width: 16, height: 16, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round' }, h('path', { d: 'M6 6l12 12M18 6L6 18' })),
      plus: () => h('svg', { width: 14, height: 14, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round' }, h('path', { d: 'M12 5v14M5 12h14' })),
    };

    // ---------------------------------------------------------------- board

    function Card({ t, r, onOpen, selected }) {
      const { label, note } = needs(t, r);
      const who = whoText(r.who);
      return h('button', { className: `ad-card${selected ? ' sel' : ''}`, onClick: () => onOpen(r.id), style: { '--tone': TONE[r.state] } },
        h('div', { className: 'ad-card-title' }, h(Dot, { state: r.state }), h('span', null, r.title)),
        h('div', { className: 'ad-meta' },
          num(r) ? h('span', null, num(r)) : null,
          r.goal?.name || r.project?.name ? h('span', null, r.goal?.name || r.project?.name) : null,
          who ? h('span', null, who) : null,
          h('span', { title: r.lastProgressAt }, ago(r.lastProgressAt))),
        label || note ? h('div', { className: 'ad-need' }, label ? h('b', null, label) : null, label && note ? ' · ' : '', note) : null,
        r.stuck ? h('div', { className: 'ad-stuck' }, r.stuck.split('\n')[0]) : null,
        r.outputs.length ? h('div', { className: 'ad-meta' }, `${t('outputs')} ${r.outputs.length}`) : null);
    }

    function Columns({ t, rows, all, onOpen, selected }) {
      return h('div', { className: 'ad-cols' },
        COLUMNS.filter((c) => all || !c.finished).map((c) => {
          const list = rows.filter((r) => c.states.includes(r.state));
          return h('section', { key: c.key, className: 'ad-col', style: { '--tone': c.tone } },
            h('div', { className: 'ad-col-head' }, h('span', { className: 'ad-dot', style: { '--tone': c.tone } }), h('b', null, t(c.key)), h('span', { className: 'ad-col-n' }, list.length)),
            h('div', { className: 'ad-col-body' },
              list.length ? list.map((r) => h(Card, { key: r.id, t, r, onOpen, selected: selected === r.id })) : h('div', { className: 'ad-col-empty' }, t('empty'))));
        }));
    }

    function Inbox({ t, rows, onOpen, selected }) {
      const list = rows.filter((r) => INBOX.has(r.state));
      if (!list.length) return h('div', { className: 'ad-empty' }, t('empty_inbox'));
      return h('div', { style: { display: 'grid', gap: 8, gridTemplateColumns: 'repeat(auto-fill,minmax(340px,1fr))', alignItems: 'start' } }, list.map((r) => h(Card, { key: r.id, t, r, onOpen, selected: selected === r.id })));
    }

    function List({ t, rows, onOpen }) {
      if (!rows.length) return h('div', { className: 'ad-empty' }, t('empty'));
      return h('div', { className: 'ad-list' },
        h('div', { className: 'ad-row th' }, h('div', null, '#'), h('div', null, t('who')), h('div', null, t('state')), h('div', null, `${t('needs')} / ${t('stuck')}`), h('div', null, t('moved'))),
        rows.map((r) => {
          const { label, note } = needs(t, r);
          return h('button', { key: r.id, className: 'ad-row', onClick: () => onOpen(r.id) },
            h('div', null, h('div', { style: { fontWeight: 560 } }, `${num(r)} ${r.title}`), h('div', { className: 'ad-muted', style: { fontSize: 11 } }, r.goal?.name || r.project?.name || '')),
            h('div', { className: 'ad-muted' }, whoText(r.who) || t('unassigned')),
            h('div', null, h(Tag, { t, state: r.state })),
            h('div', null, label || note ? h('div', { className: 'ad-need' }, label ? h('b', null, label) : null, label && note ? ' · ' : '', note) : null, r.stuck ? h('div', { className: 'ad-stuck' }, r.stuck.split('\n')[0]) : null),
            h('div', { className: 'ad-muted', title: r.lastProgressAt }, ago(r.lastProgressAt)));
        }));
    }

    function TasksPage({ t, open, setOpen, onCounts }) {
      const [data, setData] = useState(null);
      const [error, setError] = useState('');
      const [view, setViewState] = useState(() => store.get('view', 'inbox'));
      const [all, setAll] = useState(() => store.get('all', '0') === '1');
      const [query, setQuery] = useState('');
      const [project, setProject] = useState(() => store.get('project', ''));
      const [adding, setAdding] = useState(false);
      const setView = (v) => (setViewState(v), store.set('view', v));

      const load = useCallback(() => getJson(`/api/autodos/board${all || view === 'list' ? '?all=1' : ''}`).then((d) => (setData(d), setError('')), (e) => setError(e.message)), [all, view]);
      useEffect(() => {
        load();
        const timer = setInterval(load, 5000);
        return () => clearInterval(timer);
      }, [load]);

      const projects = useMemo(() => {
        const m = new Map();
        for (const r of data?.rows || []) if (r.project) m.set(r.project.id, r.project.name);
        return [...m];
      }, [data]);
      const rows = useMemo(() => {
        const q = query.trim().toLowerCase();
        return (data?.rows || []).filter((r) =>
          (!project || r.project?.id === project) &&
          (all || view !== 'list' || !['done', 'dropped'].includes(r.state)) &&
          (!q || [r.title, r.project?.name, r.goal?.name, num(r), r.who.staff, r.waitingFor].filter(Boolean).join(' ').toLowerCase().includes(q)));
      }, [data, query, project, all, view]);
      const count = (states) => (data?.rows || []).filter((r) => states.includes(r.state)).length;
      const inboxN = count(['waiting_you', 'stuck', 'failed']);
      useEffect(() => onCounts?.(inboxN), [inboxN, onCounts]);

      return h(React.Fragment, null,
        h('div', { className: 'ad-head' },
          data ? h('div', { className: 'ad-sum' },
            COLUMNS.filter((c) => !c.finished).map((c) => h('span', { key: c.key }, h('span', { className: 'ad-dot', style: { '--tone': c.tone } }), `${count(c.states)} ${t(c.key)}`))) : null,
          h('span', { className: 'ad-grow' }),
          h('input', { className: 'ad-input ad-search', placeholder: t('search'), value: query, onChange: (e) => setQuery(e.target.value) }),
          h('button', { className: 'ad-btn icon ghost', title: t('refresh'), 'aria-label': t('refresh'), onClick: load }, h(Icon.refresh)),
          h('button', { className: 'ad-btn primary', onClick: () => setAdding(true) }, h(Icon.plus), t('new_task'))),
        h('div', { className: 'ad-bar' },
          h('div', { className: 'ad-tabs', role: 'tablist' },
            [['inbox', inboxN], ['board'], ['list']].map(([v, n]) => h('button', { key: v, role: 'tab', 'aria-selected': view === v, className: view === v ? 'on' : '', onClick: () => setView(v) }, t(`v_${v}`), n ? h('span', { className: 'n' }, n) : null))),
          h('span', { className: 'ad-grow' }),
          projects.length > 1 ? h('select', { className: 'ad-select', value: project, onChange: (e) => (setProject(e.target.value), store.set('project', e.target.value)) },
            h('option', { value: '' }, t('all_projects')), projects.map(([id, name]) => h('option', { key: id, value: id }, name))) : null,
          view !== 'inbox' ? h('label', { className: 'ad-check' }, h('input', { type: 'checkbox', checked: all, onChange: (e) => (setAll(e.target.checked), store.set('all', e.target.checked ? '1' : '0')) }), t('all')) : null),
        error ? h('div', { className: 'ad-err' }, error) : null,
        h('div', { className: 'ad-scroll' },
          !data ? h('div', { className: 'ad-muted' }, t('loading'))
            : view === 'board' ? h(Columns, { t, rows, all, onOpen: setOpen, selected: open })
            : view === 'list' ? h(List, { t, rows, onOpen: setOpen })
            : h(Inbox, { t, rows, onOpen: setOpen, selected: open })),
        data?.imported ? h('div', { className: 'ad-muted', style: { fontSize: 11 } }, `${t('imported')} · ${when(data.imported.at)}`) : null,
        adding ? h(NewTask, { t, onCancel: () => setAdding(false), onDone: (task) => { setAdding(false); load(); if (task?.id) setOpen(task.id); } }) : null);
    }

    // ---------------------------------------------------------------- brand and shell

    // The Autodos mark: three bars of work getting shorter as it lands.
    const Logo = ({ size = 28 }) => h('svg', { width: size, height: size, viewBox: '0 0 64 64', 'aria-hidden': true },
      h('rect', { width: 64, height: 64, rx: 14, fill: '#15171a' }),
      h('rect', { x: 12, y: 14, width: 11, height: 36, rx: 3, fill: '#2bb3a3' }),
      h('rect', { x: 27, y: 14, width: 11, height: 24, rx: 3, fill: '#2bb3a3', opacity: 0.7 }),
      h('rect', { x: 42, y: 14, width: 11, height: 14, rx: 3, fill: '#2bb3a3', opacity: 0.45 }));

    function AutodosPage({ t }) {
      useEffect(ensureStyle, []);
      const [section, setSectionState] = useState(() => ({ machines: 'agents' })[store.get('section', 'tasks')] || store.get('section', 'tasks'));
      const setSection = (v) => (setSectionState(v), store.set('section', v));
      const [open, setOpen] = useState(null);
      const [inboxN, setInboxN] = useState(0);
      const [tick, setTick] = useState(0);
      return h('div', { className: 'ad-page' },
        h('div', { className: 'ad-topline' },
          h('div', { className: 'ad-brand' }, h(Logo), h('b', null, 'Autodos'), h('span', null, t('brand_sub'))),
          h('nav', { className: 'ad-nav' },
            ['tasks', 'staff', 'agents'].map((v) => h('button', { key: v, className: section === v ? 'on' : '', 'aria-current': section === v ? 'page' : undefined, onClick: () => setSection(v) },
              t(`sec_${v}`), v === 'tasks' && inboxN ? h('span', { className: 'n' }, inboxN) : null))),
          h('span', { className: 'ad-grow' }),
          h('span', { className: 'ad-powered' }, t('powered'))),
        section === 'staff' ? h(StaffPage, { t, onOpen: setOpen, tick })
          : section === 'agents' ? h(AgentsPage, { t, onOpen: setOpen, tick })
          : h(TasksPage, { t, open, setOpen, onCounts: setInboxN, key: tick }),
        open ? h(Drawer, { t, id: open, onClose: () => setOpen(null), onChanged: () => setTick((x) => x + 1) }) : null);
    }

    // ---------------------------------------------------------------- staff and machines

    function useTeam() {
      const [data, setData] = useState(null);
      const [error, setError] = useState('');
      const load = useCallback(() => getJson('/api/autodos/team').then((d) => (setData(d), setError('')), (e) => setError(e.message)), []);
      useEffect(() => {
        load();
        const timer = setInterval(load, 8000);
        return () => clearInterval(timer);
      }, [load]);
      return { data, error, load };
    }

    const PALETTE = ['#0e8a7c', '#3b6fd8', '#c27a12', '#9b51e0', '#d6457a', '#2f9a5c', '#6b6b70'];
    const colorOf = (s) => s.color || PALETTE[[...String(s.name || s.id)].reduce((a, c) => a + c.charCodeAt(0), 0) % PALETTE.length];

    function TaskMini({ t, tasks, onOpen }) {
      if (!tasks?.length) return null;
      return h('div', { className: 'ad-mini' }, tasks.slice(0, 6).map((x) => h('button', { key: x.id, onClick: () => onOpen(x.id) }, h(Dot, { state: x.state }), h('span', null, `#${x.number} ${x.title}`))),
        tasks.length > 6 ? h('div', { className: 'ad-muted', style: { fontSize: 11, paddingLeft: 6 } }, fill(t('more'), tasks.length - 6)) : null);
    }

    function Confirmable({ t, onConfirm, busy }) {
      const [ask, setAsk] = useState(false);
      return ask
        ? h(React.Fragment, null, h('button', { className: 'ad-btn danger', disabled: busy, onClick: onConfirm }, t('remove_confirm')), h('button', { className: 'ad-btn ghost', onClick: () => setAsk(false) }, t('cancel')))
        : h('button', { className: 'ad-btn ghost', onClick: () => setAsk(true) }, t('remove'));
    }

    function Modal({ t, title, children, onCancel, onSave, busy, canSave, error, note }) {
      useEscape(onCancel);
      return h('div', { className: 'ad-overlay' },
        h('div', { className: 'ad-modal-mask', onMouseDown: (e) => e.target === e.currentTarget && onCancel() },
          h('div', { className: 'ad-modal', role: 'dialog', 'aria-modal': true, onKeyDown: (e) => (e.metaKey || e.ctrlKey) && e.key === 'Enter' && canSave && onSave() },
            h('h3', null, title), children,
            note ? h('div', { className: 'ad-muted', style: { fontSize: 12 } }, note) : null,
            error ? h('div', { className: 'ad-err' }, error) : null,
            h('div', { className: 'ad-actions', style: { justifyContent: 'flex-end' } },
              h('button', { className: 'ad-btn ghost', onClick: onCancel }, t('cancel')),
              h('button', { className: 'ad-btn primary', disabled: busy || !canSave, onClick: onSave }, busy ? t('working_on') : t('save'))))));
    }

    const Field = ({ label, children }) => h('div', { className: 'ad-field' }, h('label', null, label), children);

    const PREFS = ['auto', 'claude', 'codex'];
    const prefText = (t, s) => (s.agentName ? fill(t('staff_always'), s.agentName) : fill(t('staff_prefers'), t(`rt_${PREFS.includes(s.prefer || s.runtime) ? s.prefer || s.runtime : 'auto'}`)));

    function StaffForm({ t, staff, agents, onDone, onCancel }) {
      const [f, setF] = useState(() => ({ name: staff?.name || '', role: staff?.role || '', prefer: PREFS.includes(staff?.runtime) ? staff.runtime : 'auto', agent: staff?.agent || '', instructions: staff?.instructions || '' }));
      const { busy, error, run } = useAction(onDone);
      const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
      const save = () => run(staff ? { action: 'update_staff', staff: staff.id, ...f } : { action: 'create_staff', ...f });
      const pickable = (agents || []).filter((a) => a.status !== 'cannot' && a.status !== 'missing');
      return h(Modal, { t, title: staff ? `${t('edit')} · ${staff.name}` : t('add_staff'), onCancel, onSave: save, busy, canSave: Boolean(f.name.trim()), error, note: t('staff_note') },
        h(Field, { label: t('staff_name') }, h('input', { className: 'ad-input', value: f.name, placeholder: t('staff_name_ph'), onChange: set('name'), autoFocus: true })),
        h(Field, { label: t('staff_role') }, h('input', { className: 'ad-input', value: f.role, placeholder: t('staff_role_ph'), onChange: set('role') })),
        h('div', { className: 'ad-bar' },
          h(Field, { label: t('staff_prefer') }, h('select', { className: 'ad-select', value: f.prefer, disabled: Boolean(f.agent), onChange: set('prefer') }, PREFS.map((r) => h('option', { key: r, value: r }, t(`rt_${r}`))))),
          h(Field, { label: t('staff_pin') }, h('select', { className: 'ad-select', value: f.agent, onChange: set('agent') },
            h('option', { value: '' }, t('staff_pin_none')), pickable.map((a) => h('option', { key: a.id, value: a.id }, a.name))))),
        h(Field, { label: t('staff_instr') }, h('textarea', { className: 'ad-textarea', style: { minHeight: 100 }, value: f.instructions, placeholder: t('staff_instr_ph'), onChange: set('instructions') })));
    }

    function StaffPage({ t, onOpen, tick }) {
      const { data, error, load } = useTeam();
      const [editing, setEditing] = useState(null);
      const { busy, error: actError, run } = useAction(load);
      useEffect(() => void load(), [tick, load]);
      const done = () => (setEditing(null), load());
      return h(React.Fragment, null,
        h('div', { className: 'ad-head' },
          data ? h('div', { className: 'ad-sum' }, h('span', null, `${data.staff.length} ${t('sec_staff')}`), h('span', { className: 'ad-muted' }, t('staff_hint'))) : null,
          h('span', { className: 'ad-grow' }),
          h('button', { className: 'ad-btn primary', onClick: () => setEditing('new') }, h(Icon.plus), t('add_staff'))),
        error || actError ? h('div', { className: 'ad-err' }, error || actError) : null,
        h('div', { className: 'ad-scroll' },
          !data ? h('div', { className: 'ad-muted' }, t('loading'))
            : !data.staff.length ? h('div', { className: 'ad-empty' }, t('staff_empty'))
            : h('div', { className: 'ad-grid' }, data.staff.map((s) => h('article', { key: s.id, className: 'ad-person' },
              h('div', { className: 'ad-person-head' },
                h('div', { className: 'ad-avatar', style: { '--tone': colorOf(s) } }, String(s.name || '?').slice(0, 1)),
                h('div', { style: { minWidth: 0, flex: 1 } }, h('b', null, s.name), s.role ? h('div', { className: 'ad-muted', style: { fontSize: 12 } }, s.role) : null)),
              h('div', { className: 'ad-chips' },
                h('span', { className: 'ad-chip ok' }, prefText(t, s)),
                s.spentUsd ? h('span', { className: 'ad-chip' }, `${t('spent')} $${s.spentUsd.toFixed(2)}`) : null),
              h('div', { className: 'ad-stats' }, ['working', 'waiting', 'stuck', 'queued', 'done'].map((k) => h('span', { key: k }, h('b', null, s.counts[k]), t(`c_count_${k}`)))),
              h(TaskMini, { t, tasks: s.tasks, onOpen }),
              s.instructions ? h('div', { className: 'ad-need', title: s.instructions }, s.instructions) : null,
              h('div', { className: 'ad-actions' },
                h('button', { className: 'ad-btn', onClick: () => setEditing(s) }, t('edit')),
                h('span', { className: 'ad-grow' }),
                h(Confirmable, { t, busy, onConfirm: () => run({ action: 'remove_staff', staff: s.id }) })))))),
        editing ? h(StaffForm, { t, staff: editing === 'new' ? null : editing, agents: data?.agents, onDone: done, onCancel: () => setEditing(null) }) : null);
    }

    const KINDS = ['claude', 'codex', 'openclaw', 'hermes'];
    const KIND_TONE = { claude: '#c96442', codex: '#2b2b2f', openclaw: '#d6457a', hermes: '#7b5cd6' };
    const hhmm = (iso) => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

    function MachineForm({ t, machine, onDone, onCancel }) {
      const [f, setF] = useState(() => ({ name: machine?.name || '', paseoHost: machine?.paseoHost || '', capacity: machine?.capacity || 2, notes: machine?.notes || '', agents: ['claude'] }));
      const { busy, error, run } = useAction(onDone);
      const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
      const local = machine?.local;
      const toggle = (k) => setF({ ...f, agents: f.agents.includes(k) ? f.agents.filter((x) => x !== k) : [...f.agents, k] });
      const { agents: _a, ...fields } = f;
      const save = () => run(machine ? { action: 'update_machine', machine: machine.id, ...fields, ...(local ? { paseoHost: undefined } : {}) } : { action: 'create_machine', ...f });
      return h(Modal, { t, title: machine ? `${t('edit')} · ${host(machine.name)}` : t('add_machine'), onCancel, onSave: save, busy, canSave: Boolean(f.name.trim() && (local || f.paseoHost.trim())), error, note: local ? null : t('m_remote_note') },
        h(Field, { label: t('m_name') }, h('input', { className: 'ad-input', value: f.name, placeholder: t('m_name_ph'), onChange: set('name'), autoFocus: true })),
        local ? null : h(Field, { label: t('m_host') }, h('input', { className: 'ad-input', value: f.paseoHost, placeholder: t('m_host_ph'), onChange: set('paseoHost') })),
        machine ? null : h(Field, { label: t('m_has') }, h('div', { className: 'ad-chips' }, ['claude', 'codex'].map((k) => h('button', { key: k, type: 'button', className: `ad-chip pick${f.agents.includes(k) ? ' ok' : ''}`, onClick: () => toggle(k) }, `${f.agents.includes(k) ? '✓ ' : ''}${t(`rt_${k}`)}`)))),
        h(Field, { label: t('m_capacity') }, h('input', { className: 'ad-input', type: 'number', min: 1, max: 32, value: f.capacity, onChange: set('capacity'), style: { width: 120 } })),
        h(Field, { label: t('m_notes') }, h('textarea', { className: 'ad-textarea', value: f.notes, onChange: set('notes') })));
    }

    function AgentRow({ t, a, busy, run, onOpen }) {
      const st = a.status;
      const stText = st === 'limited' ? fill(t('a_limited'), hhmm(a.limitedUntil)) : t(`a_${st}`);
      const cap = Number(a.capacity) || 2;
      return h('div', { className: `ad-agent${st === 'ready' ? '' : ' dim'}` },
        h('div', { className: 'ad-agent-main' },
          h('div', { className: 'ad-avatar sm', style: { '--tone': KIND_TONE[a.kind] || '#6b6b70' } }, (a.kindName || a.kind).slice(0, 1)),
          h('div', { style: { minWidth: 0, flex: 1 } },
            h('div', { className: 'ad-agent-name' }, h('b', null, a.kindName), h('span', { className: `ad-chip st-${st}` }, stText)),
            h('div', { className: 'ad-muted', style: { fontSize: 12 } },
              st === 'cannot' ? t('a_cannot_note')
                : [`${a.running} / ${cap} ${t('m_running')}`, a.spentUsd ? `$${a.spentUsd.toFixed(2)} ${t('spent')}` : null, a.lastActiveAt ? ago(a.lastActiveAt) : null, a.detected === false ? t('a_declared') : null].filter(Boolean).join(' · '))),
          st === 'cannot' ? null : h('div', { className: 'ad-agent-acts' },
            st === 'limited' ? h('button', { className: 'ad-btn ghost', disabled: busy, onClick: () => run({ action: 'update_agent', agent: a.id, clearLimit: true }) }, t('a_clear')) : null,
            h('label', { className: 'ad-muted ad-cap', title: t('a_cap') }, t('a_cap'),
              h('select', { className: 'ad-select', value: cap, disabled: busy, onChange: (e) => run({ action: 'update_agent', agent: a.id, capacity: Number(e.target.value) }) }, [1, 2, 3, 4, 6, 8].map((n) => h('option', { key: n, value: n }, n)))),
            h('button', { className: 'ad-btn', disabled: busy, onClick: () => run({ action: 'update_agent', agent: a.id, enabled: a.enabled === false }) }, a.enabled === false ? t('a_turn_on') : t('a_turn_off')),
            a.detected === false && !a.running ? h('button', { className: 'ad-btn ghost', disabled: busy, onClick: () => run({ action: 'remove_agent', agent: a.id }) }, t('remove')) : null)),
        st === 'limited' && a.limitNote ? h('div', { className: 'ad-muted', style: { fontSize: 11.5, paddingLeft: 42 } }, a.limitNote) : null,
        a.tasks?.length ? h('div', { style: { paddingLeft: 36 } }, h(TaskMini, { t, tasks: a.tasks, onOpen })) : null);
    }

    function AgentsPage({ t, onOpen, tick }) {
      const { data, error, load } = useTeam();
      const [editing, setEditing] = useState(null);
      const [adding, setAdding] = useState('');
      const { busy, error: actError, run } = useAction(load);
      useEffect(() => void load(), [tick, load]);
      const done = () => (setEditing(null), load());
      const all = data?.agents || [];
      const ready = all.filter((a) => a.status === 'ready').length;
      const running = all.reduce((n, a) => n + a.running, 0);
      return h(React.Fragment, null,
        h('div', { className: 'ad-head' },
          data ? h('div', { className: 'ad-sum' },
            h('span', null, `${all.filter((a) => a.status !== 'cannot').length} Agent`),
            h('span', null, h('span', { className: 'ad-dot', style: { '--tone': 'var(--ad-brand)' } }), `${ready} ${t('a_ready')}`),
            h('span', null, h('span', { className: 'ad-dot live', style: { '--tone': 'var(--ad-blue)' } }), `${running} ${t('m_running')}`),
            h('span', null, `${data.machines.length} ${t('sec_machines')}`)) : null,
          h('span', { className: 'ad-grow' }),
          h('button', { className: 'ad-btn primary', onClick: () => setEditing('new') }, h(Icon.plus), t('add_machine'))),
        error || actError ? h('div', { className: 'ad-err' }, error || actError) : null,
        h('div', { className: 'ad-scroll' },
          !data ? h('div', { className: 'ad-muted' }, t('loading'))
            : h('div', { className: 'ad-stack' }, data.machines.map((m) => {
              const missing = (m.found || []).filter((f) => !f.installed && !f.used && !m.agents.some((a) => a.kind === f.kind)).map((f) => f.name);
              const addable = KINDS.filter((k) => ['claude', 'codex'].includes(k) && !m.agents.some((a) => a.kind === k));
              return h('section', { key: m.id, className: 'ad-machine' },
                h('div', { className: 'ad-machine-head' },
                  h('div', { className: 'ad-avatar', style: { '--tone': m.local ? 'var(--ad-brand)' : '#3b6fd8' } }, h('svg', { width: 18, height: 18, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round' }, h('rect', { x: 3, y: 4, width: 18, height: 12, rx: 2 }), h('path', { d: 'M8 20h8M12 16v4' }))),
                  h('div', { style: { minWidth: 0, flex: 1 } },
                    h('b', null, host(m.name)),
                    h('div', { className: 'ad-muted', style: { fontSize: 12 } }, [m.local ? t('m_local') : m.paseoHost, `${m.running}${m.capacity ? ` / ${m.capacity}` : ''} ${t('m_running')}`, m.spentUsd ? `$${m.spentUsd.toFixed(2)} ${t('spent')}` : null].filter(Boolean).join(' · '))),
                  h('button', { className: 'ad-btn', onClick: () => setEditing(m) }, t('edit')),
                  m.local ? null : h(Confirmable, { t, busy, onConfirm: () => run({ action: 'remove_machine', machine: m.id }) })),
                m.agents.length ? m.agents.map((a) => h(AgentRow, { key: a.id, t, a, busy, run, onOpen }))
                  : h('div', { className: 'ad-muted', style: { padding: '6px 2px' } }, t('a_none')),
                h('div', { className: 'ad-machine-foot' },
                  missing.length ? h('span', { className: 'ad-muted' }, fill(t('a_notinst'), missing.join(', '))) : h('span'),
                  h('span', { className: 'ad-grow' }),
                  !m.local && addable.length ? (adding === m.id
                    ? h(React.Fragment, null, addable.map((k) => h('button', { key: k, className: 'ad-btn', disabled: busy, onClick: () => (setAdding(''), run({ action: 'add_agent', machine: m.id, kind: k })) }, `+ ${t(`rt_${k}`)}`)), h('button', { className: 'ad-btn ghost', onClick: () => setAdding('') }, t('cancel')))
                    : h('button', { className: 'ad-btn ghost', onClick: () => setAdding(m.id) }, h(Icon.plus), t('a_add'))) : null));
            }))),
        editing ? h(MachineForm, { t, machine: editing === 'new' ? null : editing, onDone: done, onCancel: () => setEditing(null) }) : null);
    }

    // ---------------------------------------------------------------- new task

    function NewTask({ t, onDone, onCancel }) {
      const [projects, setProjects] = useState(null);
      const [exec, setExec] = useState(true);
      const [f, setF] = useState({ title: '', description: '', project: '', staff: '', start: true });
      const [staffList, setStaffList] = useState([]);
      const { busy, error, run } = useAction(onDone);
      useEscape(onCancel);
      useEffect(() => {
        getJson('/api/autodos/projects').then((d) => {
          setProjects(d.projects);
          setStaffList(d.staff || []);
          setExec(d.execution);
          setF((x) => ({ ...x, project: x.project || store.get('newProject', '') || d.projects.find((p) => p.path)?.id || '' }));
        }, () => setProjects([]));
      }, []);
      const set = (k) => (e) => setF({ ...f, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value });
      const submit = () => {
        if (busy || !f.title.trim()) return;
        store.set('newProject', f.project);
        run({ action: 'create_task', title: f.title.trim(), description: f.description, project: f.project || undefined, staff: f.staff || undefined, start: f.start && exec && Boolean(f.project) });
      };
      return h('div', { className: 'ad-overlay' },
        h('div', { className: 'ad-modal-mask', onMouseDown: (e) => e.target === e.currentTarget && onCancel() },
          h('div', { className: 'ad-modal', role: 'dialog', 'aria-modal': true, onKeyDown: (e) => (e.metaKey || e.ctrlKey) && e.key === 'Enter' && submit() },
            h('h3', null, t('new_task_title')),
            h('div', { className: 'ad-field' }, h('label', null, t('f_title')), h('input', { className: 'ad-input', placeholder: t('f_title_ph'), value: f.title, onChange: set('title'), autoFocus: true })),
            h('div', { className: 'ad-field' }, h('label', null, t('f_desc')), h('textarea', { className: 'ad-textarea', style: { minHeight: 120 }, placeholder: t('f_desc_ph'), value: f.description, onChange: set('description') })),
            h('div', { className: 'ad-bar' },
              h('div', { className: 'ad-field', style: { flex: 1 } }, h('label', null, t('f_project')),
                h('select', { className: 'ad-select', style: { width: '100%' }, value: f.project, onChange: set('project') },
                  h('option', { value: '' }, t('none')), (projects || []).map((p) => h('option', { key: p.id, value: p.id }, p.name)))),
              h('div', { className: 'ad-field', style: { flex: 1 } }, h('label', null, t('f_staff')),
                h('select', { className: 'ad-select', style: { width: '100%' }, value: f.staff, onChange: set('staff') },
                  h('option', { value: '' }, t('f_staff_any')), staffList.map((x) => h('option', { key: x.id, value: x.id }, x.role ? `${x.name} · ${x.role}` : x.name)))),
              h('label', { className: 'ad-check', style: { alignSelf: 'flex-end', height: 32 } }, h('input', { type: 'checkbox', checked: f.start && exec, disabled: !exec, onChange: set('start') }), t('f_start'))),
            !exec ? h('div', { className: 'ad-muted', style: { fontSize: 12 } }, t('no_exec')) : null,
            error ? h('div', { className: 'ad-err' }, error) : null,
            h('div', { className: 'ad-actions', style: { justifyContent: 'flex-end' } },
              h('button', { className: 'ad-btn ghost', onClick: onCancel }, t('cancel')),
              h('button', { className: 'ad-btn primary', disabled: busy || !f.title.trim(), onClick: submit }, busy ? t('working_on') : t('create'))))));
    }

    // ---------------------------------------------------------------- task drawer

    function Decision({ t, d, onDone }) {
      const [note, setNote] = useState('');
      const { busy, error, run } = useAction(onDone);
      const tone = d.kind === 'permission' ? 'var(--ad-amber)' : d.kind === 'budget' ? 'var(--ad-red)' : 'var(--ad-blue)';
      const head = d.kind === 'permission' ? `${t('w_permission')}${d.tool ? ` · ${d.tool}` : ''}` : d.kind === 'result' ? t('w_result') : d.kind === 'budget' ? t('w_budget') : d.question;
      return h('div', { className: 'ad-decision', style: { '--tone': tone } },
        h('b', null, head),
        d.kind ? h('p', { className: 'ad-pre' }, d.kind === 'permission' && d.tool ? String(d.question).replace(`Allow ${d.tool}?`, fill(t('allow_tool'), d.tool)) : d.question) : null,
        d.reversible === false ? h('div', { className: 'ad-muted', style: { fontSize: 11 } }, t('irreversible')) : null,
        d.kind === 'result' ? h('textarea', { className: 'ad-textarea', style: { minHeight: 48 }, placeholder: t('note_ph'), value: note, onChange: (e) => setNote(e.target.value) }) : null,
        h('div', { className: 'ad-actions' },
          (d.options || []).map((o, i) => h('button', { key: o, className: `ad-btn${i === 0 ? ' primary' : ''}`, disabled: busy, onClick: () => run({ action: 'decide', decision: d.id, choice: o, note: note.trim() || undefined }) }, t(`o_${o}`) || o))),
        error ? h('div', { className: 'ad-err' }, error) : null);
    }

    const EVENT = (e) => {
      if (e.type === 'thread.message' || e.type === 'chat.message') return ['e_message', '✉', 'var(--ad-blue)'];
      if (e.type === 'thread.activity') return ['e_activity', '›', 'var(--ad-ink-3)'];
      if (e.type === 'task.check') return ['e_check', e.data?.ok ? '✓' : '✕', e.data?.ok ? 'var(--ad-green)' : 'var(--ad-red)'];
      if (e.type === 'task.landing') return ['e_landing', e.data?.ok ? '⇢' : '!', e.data?.ok ? 'var(--ad-green)' : 'var(--ad-amber)'];
      if (e.type.startsWith('decision.')) return ['e_decision', '?', 'var(--ad-amber)'];
      if (e.type === 'task.updated' && e.data?.state) return ['e_state', '●', TONE[e.data.state] || 'var(--ad-ink-3)'];
      return ['e_other', '·', 'var(--ad-ink-4)'];
    };

    function Event({ t, e }) {
      const [open, setOpen] = useState(false);
      const [kind, icon, tone] = EVENT(e);
      const body = e.data?.text != null ? text(e.data.text) : e.type === 'task.updated' && e.data?.state ? t(`s_${e.data.state}`) : '';
      const long = body.length > 320 || body.split('\n').length > 5;
      return h('div', { className: 'ad-ev' },
        h('div', { className: 'ad-ev-icon', style: { '--tone': tone } }, icon),
        h('div', { className: 'ad-ev-body' },
          h('div', { className: 'ad-ev-meta' }, h('span', { className: 'who' }, e.actor), h('span', null, t(kind)), h('span', null, when(e.at)), e.reason ? h('span', null, e.reason) : null),
          body ? h('p', { className: `ad-ev-text${open ? ' open' : ''}` }, body.slice(0, 8000)) : null,
          long ? h('button', { className: 'ad-link', onClick: () => setOpen(!open) }, open ? t('show_less') : t('show_more')) : null));
    }

    function Drawer({ t, id, onClose, onChanged }) {
      const [d, setD] = useState(null);
      const [error, setError] = useState('');
      const [reply, setReply] = useState('');
      const [confirmDrop, setConfirmDrop] = useState(false);
      const [eventsShown, setEventsShown] = useState(40);
      useEscape(onClose);
      const load = useCallback(() => getJson(`/api/autodos/task?id=${encodeURIComponent(id)}`).then((x) => (setD(x), setError('')), (e) => setError(e.message)), [id]);
      useEffect(() => {
        setD(null);
        load();
        const timer = setInterval(load, 4000);
        return () => clearInterval(timer);
      }, [load]);
      const after = useCallback(() => (load(), onChanged?.()), [load, onChanged]);
      const { busy, error: actError, run } = useAction(after);

      const task = d?.task;
      const thread = task ? d.threads.find((x) => x.id === task.threadId) : null;
      const finished = task ? ['done', 'dropped'].includes(task.state) : true;
      const open = d ? d.decisions.filter((x) => x.open) : [];
      const past = d ? d.decisions.filter((x) => !x.open) : [];
      // Bookkeeping events with nothing to read (a thread's status tick, an id set) stay out of the timeline.
      const events = d ? d.timeline.filter((e) => EVENT(e)[0] !== 'e_other' || e.data?.text != null || e.reason).slice().reverse() : [];
      const spent = d ? d.threads.reduce((s, x) => s + (Number(x.costUsd) || 0), 0) : 0;
      const { label, note } = task ? needs(t, task) : {};
      const send = () => reply.trim() && !busy && run({ action: 'reply', task: task.id, text: reply.trim() }).then((r) => r && setReply(''));
      const again = task && (task.threadId || task.stuck || task.state === 'failed' || task.landPending);

      return h('div', { className: 'ad-overlay' },
        h('div', { className: 'ad-mask', onClick: onClose }),
        h('aside', { className: 'ad-drawer', role: 'dialog', 'aria-modal': true },
          h('div', { className: 'ad-drawer-head' },
            h('div', { className: 'ad-drawer-title' },
              h('h2', null, task ? `${num(task)} ${task.title}` : t('loading')),
              h('button', { className: 'ad-btn icon ghost', title: t('close'), 'aria-label': t('close'), onClick: onClose }, h(Icon.close))),
            task ? h('div', { className: 'ad-meta' },
              h(Tag, { t, state: task.state }),
              d.task.projectId ? h('span', null, d.project?.name || '') : null,
              thread ? h('span', null, [thread.runtime, thread.model, thread.branch].filter(Boolean).join(' · ')) : null,
              spent ? h('span', null, `${t('spent')} $${spent.toFixed(2)}`) : null,
              h('span', null, ago(task.lastProgressAt))) : null),
          h('div', { className: 'ad-drawer-body' },
            error && !d ? h('div', { className: 'ad-err' }, error) : null,
            task ? h(React.Fragment, null,
              open.length || label || note || task.stuck ? h('section', { className: 'ad-sec' },
                h('h3', null, t('waiting')),
                !open.length && (label || note) ? h('div', { className: 'ad-need', style: { WebkitLineClamp: 'unset', display: 'block' } }, label ? h('b', null, label) : null, label && note ? ' · ' : '', note) : null,
                open.map((x) => h(Decision, { key: x.id, t, d: x, onDone: after })),
                task.stuck ? h('pre', { className: 'ad-pre err' }, task.stuck) : null) : null,
              task.description ? h('section', { className: 'ad-sec' }, h('h3', null, t('description')), h('p', { className: 'ad-pre' }, task.description)) : null,
              d.threads.length ? h('section', { className: 'ad-sec' }, h('h3', null, t('threads')),
                h('div', { className: 'ad-kv' }, d.threads.slice().reverse().map((th) => h('div', { key: th.id }, h('span', { className: 'ad-dot', style: { '--tone': th.active ? 'var(--ad-blue)' : 'var(--ad-ink-4)', marginRight: 6 } }),
                  [th.machine, th.runtime, th.model, th.status, th.branch, th.worktree, th.costUsd != null ? `$${Number(th.costUsd).toFixed(2)}` : null].filter(Boolean).join(' · '))))) : null,
              d.outputs.length ? h('section', { className: 'ad-sec' }, h('h3', null, `${t('outputs')} · ${d.outputs.length}`),
                h('div', { className: 'ad-kv' }, d.outputs.slice(0, 50).map((o) => h('div', { key: o.id }, o.url ? h('a', { href: o.url, target: '_blank', rel: 'noreferrer' }, o.title) : o.title, o.commit ? h('span', { className: 'ad-muted' }, ` · ${String(o.commit).slice(0, 8)}`) : null)),
                  d.outputs.length > 50 ? h('div', { className: 'ad-muted' }, fill(t('more'), d.outputs.length - 50)) : null)) : null,
              past.length ? h('section', { className: 'ad-sec' }, h('h3', null, t('decisions')),
                h('div', { className: 'ad-kv' }, past.slice(-10).map((x) => h('div', { key: x.id }, `${text(x.question).split('\n')[0]} → `, h('b', null, x.choice ? t(`o_${x.choice}`) || x.choice : ''))))) : null,
              h('section', { className: 'ad-sec' }, h('h3', null, `${t('timeline')} · ${d.timeline.length}`),
                h('div', null, events.slice(0, eventsShown).map((e) => h(Event, { key: e.id, t, e }))),
                events.length > eventsShown ? h('button', { className: 'ad-link', onClick: () => setEventsShown(eventsShown + 80) }, fill(t('more'), events.length - eventsShown)) : null)) : null),
          task && !finished ? h('div', { className: 'ad-drawer-foot' },
            h('textarea', { className: 'ad-textarea', placeholder: t('reply_ph'), value: reply, onChange: (e) => setReply(e.target.value), onKeyDown: (e) => (e.metaKey || e.ctrlKey) && e.key === 'Enter' && send() }),
            h('div', { className: 'ad-actions' },
              h('button', { className: 'ad-btn primary', disabled: busy || !reply.trim(), onClick: send }, busy ? t('working_on') : t('send')),
              !thread?.active && task.projectId ? h('button', { className: 'ad-btn', disabled: busy, onClick: () => run({ action: again ? 'retry' : 'dispatch', task: task.id }) }, again ? t('retry') : t('start')) : null,
              thread?.active && (task.stuck || task.state === 'failed') ? h('button', { className: 'ad-btn', disabled: busy, onClick: () => run({ action: 'retry', task: task.id }) }, t('retry')) : null,
              h('span', { className: 'ad-grow' }),
              confirmDrop
                ? h(React.Fragment, null, h('span', { className: 'ad-muted', style: { fontSize: 12, alignSelf: 'center' } }, t('drop_confirm')),
                  h('button', { className: 'ad-btn danger', disabled: busy, onClick: () => run({ action: 'drop', task: task.id }) }, t('drop')),
                  h('button', { className: 'ad-btn ghost', onClick: () => setConfirmDrop(false) }, t('cancel')))
                : h('button', { className: 'ad-btn ghost', disabled: busy, onClick: () => setConfirmDrop(true) }, t('drop'))),
            actError ? h('div', { className: 'ad-err' }, actError) : null) : null));
    }

    // ---------------------------------------------------------------- registration

    // The Autodos mark in the sidebar's own line style: three bars, shorter as work lands.
    const SideIcon = ({ size = 18 }) => h('svg', { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round' },
      h('rect', { x: 4, y: 4, width: 4, height: 15, rx: 1.2 }),
      h('rect', { x: 10, y: 4, width: 4, height: 10, rx: 1.2 }),
      h('rect', { x: 16, y: 4, width: 4, height: 6, rx: 1.2 }));

    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, DICT), 'autodos: dictionaries');
      const t = ctx.locale.bind(NS);
      ctx.slots.inject('main', function* () {
        yield ctx.slots.register({ name: 'main', key: PANEL, locale: NS }, (props) => h(AutodosPage, { ...props, t }));
      });
      ctx.slots.inject('sidebar.panellist', () =>
        ctx.slots.register({ name: 'sidebar.panellist', id: PANEL, order: 14, label: () => t('panel'), locale: NS }, SideIcon));

      // Autodos is the product, DeepSeek Harness the engine underneath: the app's own brand
      // seats (sidebar mark and name, the empty-session hero) carry the Autodos mark.
      ctx.slots.inject('sidebar.brand.mark', () =>
        ctx.slots.inject('sidebar.brand.name', function* () {
          yield ctx.slots.register({ name: 'sidebar.brand.mark' }, ({ size = 24 }) => h(Logo, { size }));
          yield ctx.slots.register({ name: 'sidebar.brand.name', locale: NS }, () => h(BrandName, { t }));
        }));
      ctx.slots.inject('conversation.hero.brand.mark', () =>
        ctx.slots.register({ name: 'conversation.hero.brand.mark' }, ({ size = 34, className }) => h('span', { className }, h(Logo, { size }))));
      ctx.effect(() => brandDocument(), 'autodos: title and icon');
      if (ctx.layout) openOnStart(ctx);
      else if (typeof ctx.inject === 'function') ctx.inject(['layout'], (c) => openOnStart(c));
    }

    function BrandName({ t }) {
      return h('span', { style: { display: 'inline-flex', alignItems: 'baseline', gap: 7, whiteSpace: 'nowrap' } },
        h('b', { style: { fontSize: 16, fontWeight: 700, letterSpacing: '-.01em' } }, 'Autodos'),
        h('span', { style: { fontSize: 11.5, opacity: 0.6 } }, t('brand_sub')));
    }

    const ICON = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="#15171a"/><rect x="12" y="14" width="11" height="36" rx="3" fill="#2bb3a3"/><rect x="27" y="14" width="11" height="24" rx="3" fill="#2bb3a3" opacity=".7"/><rect x="42" y="14" width="11" height="14" rx="3" fill="#2bb3a3" opacity=".45"/></svg>');

    // Browser tab: the Autodos name and icon. The shell sets the title itself (session titles,
    // its build name as fallback), so only the build name is swapped and an empty title filled.
    function brandDocument() {
      if (typeof document === 'undefined') return () => {};
      const fix = () => {
        const cur = document.title || '';
        const next = !cur.trim() ? 'Autodos' : cur.replace(/DeepSeek Harness|DSH\b|本地构建|Local build/gi, 'Autodos');
        if (next !== cur) document.title = next;
        let link = document.querySelector('link[rel~="icon"]');
        if (!link) { link = document.createElement('link'); link.rel = 'icon'; document.head.appendChild(link); }
        if (link.href !== ICON) { link.type = 'image/svg+xml'; link.href = ICON; }
      };
      fix();
      const obs = new MutationObserver(fix);
      obs.observe(document.head, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['href'] });
      return () => obs.disconnect();
    }

    // Open on the Autodos page when the app starts at its home, not when a session link was opened.
    let opened = false;
    function openOnStart(c) {
      if (opened || typeof location === 'undefined') return;
      if (location.pathname !== '/' && location.pathname !== '') return;
      if (store.get('home', 'autodos') !== 'autodos') return;
      opened = true;
      let tries = 0;
      const go = () => {
        try { c.layout.selectPanel(PANEL); } catch { if (++tries < 20) setTimeout(go, 150); }
      };
      setTimeout(go, 0);
    }

    module.exports.apply = apply;
    module.exports.inject = ['slots', 'locale'];
    return module.exports;
  },
});
