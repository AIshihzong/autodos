// Weekly retro: what got done, where work bounced back, what it cost.
export function retroStats(data, days = 7, end = Date.now()) {
  const since = end - days * 864e5;
  const inWin = (iso) => iso && Date.parse(iso) >= since && Date.parse(iso) <= end;
  const runs = data.runs.filter((r) => inWin(r.startedAt));
  const todos = data.todos;
  const done = todos.filter((t) => t.phase === 'done' && inWin(t.updatedAt));
  const created = todos.filter((t) => inWin(t.createdAt));
  const builds = new Map();
  for (const r of runs) if (r.kind === 'build') builds.set(r.todoId, (builds.get(r.todoId) || 0) + 1);
  const reworked = [...builds.entries()].filter(([, n]) => n > 1).sort((a, b) => b[1] - a[1]);
  const touched = todos.filter((t) => builds.has(t.id));
  const findings = { high: 0, medium: 0, low: 0 };
  for (const t of touched) for (const f of t.review?.findings || []) findings[f.severity] = (findings[f.severity] || 0) + 1;
  const conflicts = touched.filter((t) => t.messages.some((m) => /conflicts with the latest/i.test(m.text) && inWin(m.at))).length;
  const failures = new Map();
  for (const t of todos)
    for (const m of t.messages)
      if (m.role === 'system' && m.error && inWin(m.at)) {
        const k = m.text.split('\n')[0].replace(/#\d+/g, '#').slice(0, 90);
        failures.set(k, (failures.get(k) || 0) + 1);
      }
  const leadTimes = done.map((t) => Date.parse(t.updatedAt) - Date.parse(t.createdAt)).sort((a, b) => a - b);
  const byAgent = data.agents.map((a) => {
    const rs = runs.filter((r) => r.agentId === a.id);
    return { name: a.name, runs: rs.length, ms: rs.reduce((s, r) => s + r.durationMs, 0), usd: rs.reduce((s, r) => s + (r.costUsd || 0), 0), done: done.filter((t) => t.agentId === a.id).length };
  });
  return {
    days,
    from: new Date(since).toISOString(),
    to: new Date(end).toISOString(),
    created: created.length,
    done: done.length,
    open: todos.filter((t) => !['done', 'closed'].includes(t.phase)).length,
    failedRuns: runs.filter((r) => !r.ok).length,
    runs: runs.length,
    agentMs: runs.reduce((s, r) => s + r.durationMs, 0),
    usd: runs.reduce((s, r) => s + (r.costUsd || 0), 0),
    unpricedRuns: runs.filter((r) => r.costKnown === false).length,
    tokens: runs.reduce((s, r) => s + r.inputTokens + r.outputTokens, 0),
    reworked: reworked.slice(0, 5).map(([id, n]) => ({ number: todos.find((t) => t.id === id)?.number, title: todos.find((t) => t.id === id)?.title, rounds: n })),
    reworkRate: touched.length ? reworked.length / touched.length : 0,
    checksFirstPass: (() => {
      const log = todos.flatMap((t) => (t.checkLog || []).filter((c) => inWin(c.at)));
      return log.length ? log.filter((c) => c.firstTry).length / log.length : null;
    })(),
    findings,
    conflicts,
    medianLeadMs: leadTimes.length ? leadTimes[Math.floor(leadTimes.length / 2)] : null,
    failures: [...failures.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([text, count]) => ({ text, count })),
    byAgent,
    doneTitles: done.slice(-20).map((t) => `#${t.number} ${t.title}`),
  };
}

const pct = (x) => (x == null ? '—' : `${Math.round(x * 100)}%`);
const mins = (ms) => (ms == null ? '—' : ms < 3600e3 ? `${Math.round(ms / 60000)} min` : `${(ms / 3600e3).toFixed(1)} h`);

/** A plain write-up, used when no AI runtime is available for the lead. */
export function retroText(s, cn) {
  if (cn) {
    return [
      `近 ${s.days} 天回顾`,
      `完成 ${s.done} 个任务，新建 ${s.created} 个，还有 ${s.open} 个未完成。`,
      `智能体共运行 ${s.runs} 轮（失败 ${s.failedRuns} 轮），耗时 ${mins(s.agentMs)}，花费 $${s.usd.toFixed(2)}${s.unpricedRuns ? `（另有 ${s.unpricedRuns} 轮未上报费用）` : ''}。`,
      `返工率 ${pct(s.reworkRate)}，检查一次通过率 ${pct(s.checksFirstPass)}，AI 审查发现高 ${s.findings.high} / 中 ${s.findings.medium}，合并冲突 ${s.conflicts} 次，从建任务到完成的中位时间 ${mins(s.medianLeadMs)}。`,
      s.reworked.length ? `返工最多：${s.reworked.map((r) => `#${r.number}（${r.rounds} 轮）`).join('、')}。` : '',
      s.failures.length ? `常见问题：${s.failures.map((f) => `${f.text}（${f.count} 次）`).join('；')}` : '',
    ]
      .filter(Boolean)
      .join('\n');
  }
  return [
    `Retro, last ${s.days} days`,
    `${s.done} todos done, ${s.created} created, ${s.open} still open.`,
    `${s.runs} agent turns (${s.failedRuns} failed), ${mins(s.agentMs)} of agent time, $${s.usd.toFixed(2)}${s.unpricedRuns ? ` (+${s.unpricedRuns} turns without a reported cost)` : ''}.`,
    `Rework rate ${pct(s.reworkRate)}, checks green on first try ${pct(s.checksFirstPass)}, AI review found ${s.findings.high} high / ${s.findings.medium} medium, ${s.conflicts} merge conflicts, median time to done ${mins(s.medianLeadMs)}.`,
    s.reworked.length ? `Most rework: ${s.reworked.map((r) => `#${r.number} (${r.rounds} rounds)`).join(', ')}.` : '',
    s.failures.length ? `Recurring problems: ${s.failures.map((f) => `${f.text} (${f.count}×)`).join('; ')}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}
