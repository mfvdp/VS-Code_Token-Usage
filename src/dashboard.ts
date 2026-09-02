import * as vscode from 'vscode'
import { Aggregator, billable, costOf } from './agg'
import { ModelPrice } from './prices'
import { compact, extraUsageText, lastDays, relativeTime, severity, usd, windowElapsed } from './render'
import { QuotaState, Source } from './types'

const TITLE: Record<Source, string> = { claude: 'Claude Code', codex: 'Codex' }

interface ViewModel {
  quotas: {
    source: Source
    title: string
    planType: string | null
    problem: string | null
    ageText: string | null
    stale: boolean
    windows: {
      label: string
      percent: number
      sev: string
      reset: string | null
      /** Share of the window's own time already gone, 0..100. */
      elapsed: number | null
      /** Usage is running ahead of the clock. */
      ahead: boolean
    }[]
    /** Extra/purchased usage on top of the plan, already formatted. */
    extra: { text: string; utilization: number | null; enabled: boolean } | null
  }[]
  totals: { source: Source; title: string; today: Row; week: Row; month: Row }[]
  series: { days: string[]; claude: number[]; codex: number[]; max: number }
  models: { model: string; isSub: boolean; usage: string; output: string; requests: string; cost: string }[]
  generatedAt: string
  sections: string[]
  showCost: boolean
  unpricedModels: string[]
}

interface Row {
  usage: string
  output: string
  cacheRead: string
  requests: string
  incomplete: boolean
  cost: string
  /** Part of the tokens have no price on file — the total is a lower bound. */
  costPartial: boolean
}

function row(
  agg: Aggregator,
  from: string,
  to: string,
  source: Source,
  overrides?: Record<string, ModelPrice>,
): Row {
  const b = agg.sum(from, to, source)
  const c = agg.cost(from, to, source, overrides)
  return {
    usage: compact(billable(b)),
    output: compact(b.output),
    cacheRead: compact(b.cacheRead),
    requests: compact(b.requests),
    incomplete: b.requests > 0 && b.outputFinal < b.requests,
    cost: usd(c.usd),
    costPartial: c.unpricedTokens > 0,
  }
}

export function buildViewModel(
  quotas: QuotaState[],
  agg: Aggregator,
  staleAfter: number,
  now = Date.now(),
  showCost = true,
  overrides?: Record<string, ModelPrice>,
  sections: string[] = ['quota', 'tokens', 'chart', 'models'],
): ViewModel {
  const days = lastDays(14, now)
  const days30 = lastDays(30, now)
  const today = days[days.length - 1]

  const claudeSeries = agg.series(days, 'claude')
  const codexSeries = agg.series(days, 'codex')
  const max = Math.max(1, ...days.map((_, i) => claudeSeries[i] + codexSeries[i]))

  const models = agg
    .all()
    .filter((b) => b.day >= days30[0])
    .reduce<Map<string, { model: string; isSub: boolean; usage: number; output: number; requests: number; cost: number }>>(
      (acc, b) => {
        const k = `${b.source}|${b.model}|${b.isSub}`
        const cur = acc.get(k) ?? { model: b.model, isSub: b.isSub, usage: 0, output: 0, requests: 0, cost: 0 }
        cur.usage += billable(b)
        cur.output += b.output
        cur.requests += b.requests
        cur.cost += costOf(b, overrides) ?? 0
        acc.set(k, cur)
        return acc
      },
      new Map(),
    )

  return {
    quotas: quotas.map((q) => {
      const ageMin = q.fetchedAt ? (now - q.fetchedAt * 1000) / 60000 : null
      return {
        source: q.source,
        title: TITLE[q.source],
        planType: q.planType,
        problem: q.ok ? null : (q.problem ?? 'unavailable'),
        ageText:
          ageMin === null
            ? null
            : (ageMin < 1 ? 'just now' : `${Math.round(ageMin)} min ago`) +
              (q.origin === 'poll' ? ' · polled' : q.origin === 'cache' ? ' · cache' : ''),
        stale: ageMin !== null && ageMin > staleAfter,
        windows: q.windows.map((w) => {
          const elapsed = windowElapsed(w.resetsAt, w.windowMinutes, now)
          const sev = severity(w.percent, elapsed)
          return {
            label: w.label,
            percent: w.percent,
            sev,
            reset: w.resetsAt ? relativeTime(w.resetsAt, now) : null,
            elapsed,
            ahead: sev === 'warn',
          }
        }),
        extra: (() => {
          const text = extraUsageText(q.extra)
          return text === null
            ? null
            : { text, utilization: q.extra?.utilization ?? null, enabled: q.extra?.enabled === true }
        })(),
      }
    }),
    totals: (['claude', 'codex'] as Source[]).map((s) => ({
      source: s,
      title: TITLE[s],
      today: row(agg, today, today, s, overrides),
      week: row(agg, days[days.length - 7], today, s, overrides),
      month: row(agg, days30[0], today, s, overrides),
    })),
    series: { days, claude: claudeSeries, codex: codexSeries, max },
    models: [...models.values()]
      .sort((a, b) => b.usage - a.usage)
      .slice(0, 12)
      .map((m) => ({
        model: m.model,
        isSub: m.isSub,
        usage: compact(m.usage),
        output: compact(m.output),
        requests: compact(m.requests),
        cost: usd(m.cost),
      })),
    generatedAt: new Date(now).toLocaleTimeString('en-US'),
    sections,
    showCost,
    unpricedModels: agg.cost(days30[0], today, undefined, overrides).unpricedModels,
  }
}

export class DashboardProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'tokenPace.dashboard'
  private view?: vscode.WebviewView
  private latest?: ViewModel

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view
    view.webview.options = { enableScripts: true }
    view.webview.html = this.html()
    // postMessage to an invisible webview is dropped — so push the full state
    // again when it becomes visible.
    view.onDidChangeVisibility(() => { if (view.visible) this.flush() })
    view.onDidDispose(() => { this.view = undefined })
    this.flush()
  }

  update(vm: ViewModel): void {
    this.latest = vm
    this.flush()
  }

  private flush(): void {
    if (this.view?.visible && this.latest) {
      void this.view.webview.postMessage({ type: 'data', payload: this.latest })
    }
  }

  private html(): string {
    const nonce = Array.from({ length: 32 }, () =>
      'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'[Math.floor(Math.random() * 62)],
    ).join('')
    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy"
      content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style nonce="${nonce}">
  :root {
    --ok: var(--vscode-charts-green);
    --warn: var(--vscode-charts-yellow);
    --error: var(--vscode-charts-red);
    --track: var(--vscode-editorWidget-background, rgba(127,127,127,.25));
  }
  body {
    font-family: var(--vscode-font-family); font-size: var(--vscode-font-size);
    color: var(--vscode-foreground); padding: 10px 12px 24px; margin: 0;
  }
  h2 { font-size: 11px; text-transform: uppercase; letter-spacing: .08em;
       color: var(--vscode-descriptionForeground); margin: 20px 0 8px; font-weight: 600; }
  h2:first-child { margin-top: 0; }
  .card { margin-bottom: 14px; }
  .card-head { display: flex; justify-content: space-between; align-items: baseline; gap: 8px; }
  .name { font-weight: 600; }
  .name.tight { margin-bottom: 4px; }
  .meta { color: var(--vscode-descriptionForeground); font-size: 11px; }
  .stale { color: var(--vscode-charts-yellow); }
  .win { margin-top: 7px; }
  .win-top { display: flex; justify-content: space-between; align-items: baseline; gap: 8px;
             font-size: 11px; color: var(--vscode-descriptionForeground); margin-bottom: 2px; }
  .win-top span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
  .win-top b { color: var(--vscode-foreground); font-variant-numeric: tabular-nums;
               white-space: nowrap; flex: none; }
  .win-top b.ahead::after { content: " ▲"; color: var(--vscode-charts-yellow); }
  .track { position: relative; height: 7px; border-radius: 4px; background: var(--track); }
  .fill { height: 100%; border-radius: 4px; transition: width .3s ease; }
  .fill.ok { background: var(--ok); }
  .fill.warn { background: var(--warn); }
  .fill.error { background: var(--error); }
  /* Purchased usage is a separate pot from the plan quota — its own colour keeps
     the two from being read as one budget. */
  .fill.extra { background: var(--vscode-charts-blue); }
  .win-top b.off { color: var(--vscode-descriptionForeground); font-weight: 400; }
  /* Where the window's own clock stands. Sits above the fill so the comparison
     between time and consumption is readable at a glance. */
  .mark { position: absolute; top: -3px; bottom: -3px; width: 2px; margin-left: -1px;
          background: var(--vscode-foreground); opacity: .6; border-radius: 1px; }
  .scroll { overflow-x: auto; }
  table { border-collapse: collapse; width: 100%; font-size: 11px; font-variant-numeric: tabular-nums; }
  th { text-align: right; font-weight: 500; color: var(--vscode-descriptionForeground);
       padding: 3px 0 3px 8px; white-space: nowrap;
       border-bottom: 1px solid var(--vscode-panel-border, rgba(127,127,127,.3)); }
  th:first-child, td:first-child { text-align: left; padding-left: 0; }
  td { text-align: right; padding: 3px 0 3px 8px; white-space: nowrap; }
  .chart { display: flex; align-items: flex-end; gap: 2px; height: 74px; margin-top: 4px; }
  .col { flex: 1; display: flex; flex-direction: column; justify-content: flex-end; min-width: 0; }
  .seg { width: 100%; }
  .seg.c { background: var(--vscode-charts-blue); }
  .seg.x { background: var(--vscode-charts-purple); }
  .seg:first-child { border-radius: 2px 2px 0 0; }
  .axis { display: flex; gap: 2px; font-size: 9px; color: var(--vscode-descriptionForeground); margin-top: 3px; }
  .axis span { flex: 1; text-align: center; min-width: 0; overflow: hidden; }
  .legend { display: flex; gap: 12px; font-size: 11px; color: var(--vscode-descriptionForeground); margin-top: 6px; }
  .dot { display: inline-block; width: 8px; height: 8px; border-radius: 2px; margin-right: 4px; }
  .dot.c { background: var(--vscode-charts-blue); }
  .dot.x { background: var(--vscode-charts-purple); }
  .dot.t { background: var(--vscode-foreground); opacity: .6; width: 2px; border-radius: 1px; }
  .warnbox { background: var(--vscode-inputValidation-warningBackground, rgba(255,200,0,.12));
             border-left: 2px solid var(--vscode-charts-yellow); padding: 6px 8px; font-size: 11px;
             margin-top: 8px; border-radius: 0 3px 3px 0; }
  .empty { color: var(--vscode-descriptionForeground); font-style: italic; }
  .foot { margin-top: 18px; font-size: 10px; color: var(--vscode-descriptionForeground); line-height: 1.5; }
</style>
</head>
<body>
<div id="root"><p class="empty">Loading …</p></div>
<script nonce="${nonce}">
const esc = (s) => String(s).replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
function quotaCard(q) {
  if (q.problem) {
    return '<div class="card"><div class="card-head"><span class="name">' + esc(q.title) + '</span></div>'
      + '<div class="warnbox">Quota unavailable: ' + esc(q.problem) + '</div></div>';
  }
  const wins = q.windows.map(w => {
    const tip = w.elapsed === null ? '' :
      ' title="' + w.elapsed.toFixed(0) + '% of the window has elapsed, ' + w.percent.toFixed(0) + '% used"';
    return '<div class="win"><div class="win-top"><span>' + esc(w.label)
      + (w.reset ? ' · resets ' + esc(w.reset) : '') + '</span>'
      + '<b class="' + (w.ahead ? 'ahead' : '') + '">' + w.percent.toFixed(0) + ' %</b></div>'
      + '<div class="track"' + tip + '><div class="fill ' + esc(w.sev) + '" data-w="' + Math.min(100, w.percent).toFixed(2) + '"></div>'
      + (w.elapsed === null ? '' : '<i class="mark" data-x="' + w.elapsed.toFixed(2) + '"></i>')
      + '</div></div>';
  }).join('');
  const meta = [q.planType ? 'plan ' + esc(q.planType) : null, q.ageText ? 'updated ' + esc(q.ageText) : null]
    .filter(Boolean).join(' · ');
  let extra = '';
  if (q.extra) {
    extra = '<div class="win"><div class="win-top"><span>Extra usage</span>'
      + '<b class="' + (q.extra.enabled ? '' : 'off') + '">' + esc(q.extra.text) + '</b></div>'
      + (q.extra.utilization === null ? ''
         : '<div class="track"><div class="fill extra" data-w="'
           + Math.min(100, q.extra.utilization).toFixed(2) + '"></div></div>')
      + '</div>';
  }
  return '<div class="card"><div class="card-head"><span class="name">' + esc(q.title) + '</span>'
    + '<span class="meta' + (q.stale ? ' stale' : '') + '">' + meta + (q.stale ? ' ⚠' : '') + '</span></div>'
    + wins + extra + '</div>';
}
function totalsTable(t, showCost) {
  const r = (label, x) => '<tr><td>' + label + '</td><td>' + esc(x.usage) + '</td><td>' + esc(x.output)
    + (x.incomplete ? ' <span title="Output is a lower bound">⚠</span>' : '')
    + '</td><td>' + esc(x.cacheRead) + '</td><td>' + esc(x.requests) + '</td>'
    + (showCost ? '<td class="cost">' + esc(x.cost) + (x.costPartial ? ' <span title="Some models have no price on file">⚠</span>' : '') + '</td>' : '')
    + '</tr>';
  return '<div class="card"><div class="name tight">' + esc(t.title) + '</div>'
    + '<div class="scroll"><table><thead><tr><th>Period</th><th>Usage</th><th>Output</th><th>Cache</th><th>Req.</th>'
    + (showCost ? '<th title="What this usage would have cost through the provider API">API cost</th>' : '')
    + '</tr></thead>'
    + '<tbody>' + r('today', t.today) + r('7 days', t.week) + r('30 days', t.month) + '</tbody></table></div></div>';
}
function chart(s) {
  const cols = s.days.map((d, i) => {
    const c = s.claude[i], x = s.codex[i], tot = c + x;
    const h = tot / s.max * 70;
    const hc = tot ? h * c / tot : 0, hx = tot ? h * x / tot : 0;
    return '<div class="col" title="' + esc(d) + ': ' + Math.round(tot).toLocaleString('en-US') + ' tokens">'
      + (hx > 0 ? '<div class="seg x" data-h="' + hx.toFixed(1) + '"></div>' : '')
      + (hc > 0 ? '<div class="seg c" data-h="' + hc.toFixed(1) + '"></div>' : '')
      + '</div>';
  }).join('');
  const labels = s.days.map((d, i) => '<span>' + (i % 3 === 0 ? esc(d.slice(8)) : '') + '</span>').join('');
  return '<div class="chart">' + cols + '</div><div class="axis">' + labels + '</div>'
    + '<div class="legend"><span><i class="dot c"></i>Claude</span>'
    + '<span><i class="dot x"></i>Codex</span></div>';
}
function modelsTable(ms, showCost) {
  if (!ms.length) return '<p class="empty">No data yet.</p>';
  return '<div class="scroll"><table><thead><tr><th>Model</th><th>Usage</th><th>Output</th><th>Req.</th>'
    + (showCost ? '<th>API cost</th>' : '') + '</tr></thead><tbody>'
    + ms.map(m => '<tr><td>' + esc(m.model) + (m.isSub ? ' <span class="meta">sub</span>' : '')
      + '</td><td>' + esc(m.usage) + '</td><td>' + esc(m.output)
      + '</td><td>' + esc(m.requests) + '</td>'
      + (showCost ? '<td class="cost">' + esc(m.cost) + '</td>' : '') + '</tr>').join('')
    + '</tbody></table></div>';
}
window.addEventListener('message', (ev) => {
  if (ev.data?.type !== 'data') return;
  const d = ev.data.payload;
  const on = (s) => d.sections.includes(s);
  const parts = [];
  if (on('quota')) parts.push('<h2>Quota</h2>' + d.quotas.map(quotaCard).join('')
    + '<div class="legend"><span><i class="dot t"></i>time elapsed in the window</span></div>');
  if (on('tokens')) parts.push('<h2>Tokens</h2>' + d.totals.map(t => totalsTable(t, d.showCost)).join(''));
  if (on('chart')) parts.push('<h2>Last 14 days</h2>' + chart(d.series));
  if (on('models')) parts.push('<h2>By model (30 days)</h2>' + modelsTable(d.models, d.showCost));
  if (!parts.length) parts.push('<p class="empty">Every section is hidden — see the '
    + '<code>tokenPace.dashboard.sections</code> setting.</p>');
  document.getElementById('root').innerHTML =
      parts.join('')
    + '<div class="foot">“Usage” = fresh input + cache write + output. Cache reads are listed '
    + 'separately because they dominate the total by a factor of ~1000.<br>'
    + (on('quota') ? 'The tick on each bar marks how much of that window’s own time has passed. ' : '')
    + (on('quota') ? '<b>Green</b>: usage at or below the tick. <b>Yellow</b> (▲): usage ahead of the '
        + 'clock, so the window runs out early. <b>Red</b>: the window is spent.<br>' : '')
    + (d.showCost ? '<b>API cost</b> is hypothetical: what this usage would have cost through the '
        + 'provider API at list prices. On a subscription you do <b>not</b> pay this — there is no '
        + 'billing relationship.'
        + (d.unpricedModels.length ? ' No price on file for: ' + esc(d.unpricedModels.join(', ')) + '.' : '')
        + '<br>' : '')
    + 'The percentages come from each provider’s server and cover <b>all</b> clients — they cannot '
    + 'be derived from the token counts.<br>Generated ' + esc(d.generatedAt) + '</div>';
  // This webview's Content-Security-Policy forbids inline style attributes.
  // Values set through the CSSOM are not affected.
  for (const el of document.querySelectorAll('[data-w]')) el.style.width = el.dataset.w + '%';
  for (const el of document.querySelectorAll('[data-h]')) el.style.height = el.dataset.h + 'px';
  for (const el of document.querySelectorAll('[data-x]')) el.style.left = el.dataset.x + '%';
});
</script>
</body>
</html>`
  }
}
