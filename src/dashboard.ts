// SPDX-FileCopyrightText: 2026 Frederik Marx
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The dashboard webview.
 *
 * Three things this file is careful about. Everything it renders comes from the view model —
 * no number is computed here, so the webview cannot drift away from the QuickPick and the
 * markdown view. Everything the webview sends back goes through `parseWebviewMessage`: it is
 * the only untrusted input the extension has, and it may ask for a range or one of nine
 * named commands, never for a path or a setting. And updates are per section, so a
 * one-second refresh cannot reset a sort order or throw away the scroll position.
 *
 * No external resource of any kind: the CSP allows exactly the nonced inline style and
 * script of this file. The chart, the heatmap and the sparklines are CSS and inline SVG.
 */

import * as vscode from 'vscode'
import { WebviewMessage, parseWebviewMessage } from './viewModel'
import type { ViewModel } from './viewModel'

/** Section keys the webview renders, in the order `dashboard.sections` gives them. */
const SECTION_FIELDS: Record<string, (keyof ViewModel)[]> = {
  summary: ['digest'],
  quota: ['quotas'],
  kpis: ['kpis'],
  tokens: ['totals', 'composition', 'cacheEconomy', 'calendar', 'planFactor'],
  chart: ['chart'],
  models: ['models'],
  heatmap: ['heatmap'],
  hours: ['hours'],
  forecast: ['forecasts', 'windowUsage', 'attributionInWindow'],
  history: ['retro'],
  projects: ['projects'],
  sessions: ['sessions'],
  dataQuality: ['dataQuality'],
  drill: ['drill'],
  // Chrome that is always present. `footer` carries the generated-at line, which changes on
  // every tick — keeping it in its own node is what stops a full re-render every minute.
  controls: ['range', 'ui', 'models', 'firstRun', 'preview'],
  footer: ['footnotes', 'pricing', 'generatedAt'],
}

function nonceOf(): string {
  const abc = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
  let s = ''
  for (let i = 0; i < 32; i++) s += abc[Math.floor(Math.random() * abc.length)]
  return s
}

export class DashboardProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'tokenPace.dashboard'
  private view?: vscode.WebviewView
  private latest?: ViewModel
  private sent = new Map<string, string>()
  /** Serialised layout fields of the last push; a change forces a full re-render. */
  private layout?: string
  /** An unparsable message is logged once — a loop of them would be its own denial of service. */
  private warned = false

  constructor(
    private readonly onMessage: (m: WebviewMessage) => void,
    private readonly log: (m: string) => void = () => {},
  ) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view
    // A resolved view is a brand-new document: whatever it was sent before is gone.
    this.sent.clear()
    this.layout = undefined
    view.webview.options = { enableScripts: true, localResourceRoots: [] }
    view.webview.html = this.html()
    view.webview.onDidReceiveMessage((raw: unknown) => {
      const m = parseWebviewMessage(raw)
      if (!m) {
        if (!this.warned) {
          this.warned = true
          this.log('dashboard: ignored a message that did not match the allow-list')
        }
        return
      }
      this.onMessage(m)
    })
    // postMessage to a hidden webview is dropped, and the view is rebuilt from scratch when
    // it comes back — so the next push after a visibility change has to be a full one.
    view.onDidChangeVisibility(() => {
      if (view.visible) {
        this.sent.clear()
        this.flush()
      }
    })
    view.onDidDispose(() => {
      this.view = undefined
      this.sent.clear()
      this.layout = undefined
    })
    this.flush()
  }

  update(vm: ViewModel): void {
    this.latest = vm
    this.flush()
  }

  reveal(): void {
    if (this.view) {
      this.view.show?.(true)
      return
    }
    void vscode.commands.executeCommand(`${DashboardProvider.viewType}.focus`)
  }

  private flush(): void {
    const vm = this.latest
    const view = this.view
    if (!vm || !view || !view.visible) return
    // `sections` and `showCost` govern the layout of every section at once: which ones exist
    // and whether the cost columns are drawn. A per-section fragment cannot express that, so a
    // change to either forces the next push to be a full one.
    const layout = layoutKey(vm)
    if (this.layout !== undefined && this.layout !== layout) this.sent.clear()
    this.layout = layout
    if (this.sent.size === 0) {
      for (const [key, fields] of Object.entries(SECTION_FIELDS)) {
        this.sent.set(key, serialise(vm, fields))
      }
      void view.webview.postMessage({ type: 'data', payload: vm })
      return
    }
    for (const [key, fields] of Object.entries(SECTION_FIELDS)) {
      const next = serialise(vm, fields)
      if (this.sent.get(key) === next) continue
      this.sent.set(key, next)
      const payload: Record<string, unknown> = {}
      for (const f of fields) payload[f] = vm[f]
      void view.webview.postMessage({ type: 'section', key, payload })
    }
  }

  private html(): string {
    const nonce = nonceOf()
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy"
      content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style nonce="${nonce}">${CSS}</style>
</head>
<body>
<div id="root"><p class="empty">Loading …</p></div>
<script nonce="${nonce}">${SCRIPT}</script>
</body>
</html>`
  }
}

/**
 * The fields no fragment carries: they decide which sections exist (`sections`) and whether
 * the cost columns are drawn (`showCost`), so the webview has to re-render as a whole when
 * one of them changes.
 */
export function layoutKey(vm: ViewModel): string {
  return serialise(vm, LAYOUT_FIELDS)
}

const LAYOUT_FIELDS: (keyof ViewModel)[] = ['sections', 'showCost']

function serialise(vm: ViewModel, fields: (keyof ViewModel)[]): string {
  const o: Record<string, unknown> = {}
  for (const f of fields) o[f] = vm[f]
  return JSON.stringify(o)
}

// ---------------------------------------------------------------------------
// Style
// ---------------------------------------------------------------------------

const CSS = `
:root {
  --ok: var(--vscode-charts-green);
  --warn: var(--vscode-charts-yellow);
  --warn2: var(--vscode-charts-orange, var(--vscode-charts-yellow));
  --error: var(--vscode-charts-red);
  --claude: var(--vscode-charts-blue);
  --codex: var(--vscode-charts-purple);
  --track: var(--vscode-editorWidget-background, rgba(127,127,127,.25));
  --line: var(--vscode-panel-border, rgba(127,127,127,.3));
  --dim: var(--vscode-descriptionForeground);
}
body {
  font-family: var(--vscode-font-family); font-size: var(--vscode-font-size);
  color: var(--vscode-foreground); padding: 10px 12px 24px; margin: 0;
}
h2 { font-size: 11px; text-transform: uppercase; letter-spacing: .08em; color: var(--dim);
     margin: 20px 0 8px; font-weight: 600; }
h2:first-child { margin-top: 0; }
p { margin: 6px 0; }
.empty { color: var(--dim); font-style: italic; }
.dim { color: var(--dim); }
.meta { color: var(--dim); font-size: 11px; }
.meta.warn { color: var(--warn); }
.card { margin-bottom: 14px; }
.name { font-weight: 600; }
.row { display: flex; gap: 8px; align-items: baseline; justify-content: space-between; }
.wrap { display: flex; flex-wrap: wrap; gap: 4px; align-items: center; }
button, select, input {
  font-family: inherit; font-size: 11px; color: var(--vscode-foreground);
  background: var(--vscode-button-secondaryBackground, transparent);
  border: 1px solid var(--line); border-radius: 3px; padding: 2px 7px; cursor: pointer;
}
button:hover, select:hover { background: var(--vscode-toolbar-hoverBackground, var(--track)); }
button:focus-visible, select:focus-visible, input:focus-visible, [tabindex]:focus-visible {
  outline: 1px solid var(--vscode-focusBorder); outline-offset: 1px;
}
button[aria-pressed="true"] {
  background: var(--vscode-button-background, var(--track));
  color: var(--vscode-button-foreground, inherit);
  border-color: var(--vscode-button-background, var(--line));
}
input[type=date] { cursor: text; }
.track { position: relative; height: 8px; border-radius: 4px; background: var(--track); }
.fill { height: 100%; border-radius: 4px; transition: width .3s ease; }
.fill.ok { background: var(--ok); }
.fill.warn { background: var(--warn); }
.fill.warn2 { background: var(--warn2); }
.fill.error { background: var(--error); }
.fill.extra { background: var(--claude); }
.fill.neutral { background: var(--dim); }
.mark { position: absolute; top: -3px; bottom: -3px; width: 2px; margin-left: -1px;
        background: var(--vscode-foreground); opacity: .6; border-radius: 1px; }
.mark.fc { background: var(--warn); opacity: .9; border-radius: 0; width: 2px;
           border-top: 2px solid var(--vscode-foreground); }
.win { margin-top: 8px; }
.win-top { display: flex; justify-content: space-between; gap: 8px; font-size: 11px;
           color: var(--dim); margin-bottom: 3px; }
.win-top span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
.win-top b { color: var(--vscode-foreground); font-variant-numeric: tabular-nums; flex: none; }
.verdict { font-size: 11px; margin-top: 3px; color: var(--dim); }
.verdict.warn, .verdict.warn2 { color: var(--warn); }
.verdict.error { color: var(--error); }
.scroll { overflow-x: auto; }
table { border-collapse: collapse; width: 100%; font-size: 11px; font-variant-numeric: tabular-nums; }
th { text-align: right; font-weight: 500; color: var(--dim); padding: 3px 0 3px 8px;
     white-space: nowrap; border-bottom: 1px solid var(--line); }
th.sortable { cursor: pointer; }
th[aria-sort="ascending"]::after { content: " ▲"; }
th[aria-sort="descending"]::after { content: " ▼"; }
th:first-child, td:first-child { text-align: left; padding-left: 0; }
td { text-align: right; padding: 3px 0 3px 8px; white-space: nowrap; }
tr.more td { color: var(--dim); font-style: italic; text-align: left; }
.kpis { display: grid; grid-template-columns: repeat(auto-fit, minmax(120px, 1fr)); gap: 8px; }
.kpi { border: 1px solid var(--line); border-radius: 4px; padding: 6px 8px; }
.kpi .v { font-size: 15px; font-variant-numeric: tabular-nums; }
.kpi .l { font-size: 10px; color: var(--dim); text-transform: uppercase; letter-spacing: .06em; }
.kpi .d.up { color: var(--warn); }
.kpi .d.down { color: var(--ok); }
.spark { width: 100%; height: 18px; display: block; }
.spark polyline { fill: none; stroke: var(--claude); stroke-width: 1.2; vector-effect: non-scaling-stroke; }
.spark circle { fill: var(--claude); }
.plot { position: relative; height: 120px; margin-top: 6px; border-bottom: 1px solid var(--line); }
.grid { position: absolute; left: 0; right: 0; border-top: 1px dashed var(--line); opacity: .5; }
.grid span { position: absolute; right: 0; top: -14px; font-size: 9px; color: var(--dim); }
.chart { display: flex; align-items: flex-end; gap: 2px; height: 100%; position: relative; }
.col { flex: 1; min-width: 0; height: 100%; display: flex; flex-direction: column;
       justify-content: flex-end; cursor: pointer; }
.col .vlabel { font-size: 8px; color: var(--dim); text-align: center; }
.seg.claude { background: var(--claude); }
.seg.codex { background: var(--codex); }
.seg:first-of-type { border-radius: 2px 2px 0 0; }
.costline { position: absolute; inset: 0; pointer-events: none; }
.costline polyline { fill: none; stroke: var(--warn); stroke-width: 1.5;
                     vector-effect: non-scaling-stroke; }
.axis { display: flex; gap: 2px; font-size: 9px; color: var(--dim); margin-top: 3px; }
.axis span { flex: 1; text-align: center; min-width: 0; overflow: hidden; }
.legend { display: flex; flex-wrap: wrap; gap: 12px; font-size: 11px; color: var(--dim); margin-top: 6px; }
.dot { display: inline-block; width: 8px; height: 8px; border-radius: 2px; margin-right: 4px; }
.dot.claude { background: var(--claude); }
.dot.codex { background: var(--codex); }
.dot.time { background: var(--vscode-foreground); opacity: .6; width: 2px; border-radius: 1px; }
.dot.fc { background: var(--warn); width: 2px; border-radius: 0; }
.heat { display: grid; grid-auto-flow: column; grid-template-rows: repeat(7, 9px);
        gap: 2px; overflow-x: auto; padding-bottom: 2px; }
.heat i { width: 9px; height: 9px; border-radius: 2px; background: var(--track); display: block; }
.heat i.l1 { background: color-mix(in srgb, var(--claude) 30%, var(--track)); }
.heat i.l2 { background: color-mix(in srgb, var(--claude) 55%, var(--track)); }
.heat i.l3 { background: color-mix(in srgb, var(--claude) 78%, var(--track)); }
.heat i.l4 { background: var(--claude); }
.heat i.out { background: transparent; border: 1px dotted var(--line); }
.dot.l1 { background: color-mix(in srgb, var(--claude) 30%, var(--track)); }
.dot.l2 { background: color-mix(in srgb, var(--claude) 55%, var(--track)); }
.dot.l3 { background: color-mix(in srgb, var(--claude) 78%, var(--track)); }
.dot.l4 { background: var(--claude); }
.compbar { display: flex; height: 8px; border-radius: 4px; overflow: hidden; background: var(--track); }
.compbar i { display: block; height: 100%; }
.cs.c1, .dot.c1 { background: var(--claude); }
.cs.c2, .dot.c2 { background: color-mix(in srgb, var(--claude) 60%, var(--track)); }
.cs.c3, .dot.c3 { background: color-mix(in srgb, var(--claude) 35%, var(--track)); }
.cs.c4, .dot.c4 { background: var(--codex); }
.cs.c5, .dot.c5 { background: color-mix(in srgb, var(--codex) 55%, var(--track)); }
.cs.c6, .dot.c6 { background: var(--dim); }
.hours { display: flex; align-items: flex-end; gap: 2px; height: 60px; }
.hours .hb { flex: 1; background: var(--claude); min-height: 1px; border-radius: 2px 2px 0 0; }
.hgrid { display: grid; grid-template-columns: 28px repeat(6, 1fr); gap: 2px; font-size: 10px; }
.hgrid i { height: 14px; border-radius: 2px; background: var(--track); display: block; }
.hgrid i.l1 { background: color-mix(in srgb, var(--claude) 30%, var(--track)); }
.hgrid i.l2 { background: color-mix(in srgb, var(--claude) 55%, var(--track)); }
.hgrid i.l3 { background: color-mix(in srgb, var(--claude) 78%, var(--track)); }
.hgrid i.l4 { background: var(--claude); }
.hgrid i.none { background: repeating-linear-gradient(45deg, var(--track), var(--track) 2px,
                transparent 2px, transparent 4px); }
.box { border-left: 2px solid var(--warn); background: var(--vscode-inputValidation-warningBackground,
       rgba(255,200,0,.10)); padding: 6px 8px; font-size: 11px; margin: 8px 0;
       border-radius: 0 3px 3px 0; }
.box.info { border-color: var(--claude);
            background: var(--vscode-textBlockQuote-background, rgba(127,127,127,.12)); }
.box button { margin-top: 6px; }
.foot { margin-top: 18px; font-size: 10px; color: var(--dim); line-height: 1.6; }
.foot li { margin-bottom: 2px; }
ul { margin: 6px 0; padding-left: 18px; }
@media (max-width: 320px) {
  .kpis { grid-template-columns: 1fr; }
  table, thead, tbody, th, td, tr { display: block; }
  thead { display: none; }
  tr { border-bottom: 1px solid var(--line); padding: 4px 0; }
  td { text-align: left; padding: 1px 0; }
  td::before { content: attr(data-h) ": "; color: var(--dim); }
}
@media (prefers-reduced-motion: reduce) { .fill { transition: none; } }
`

// ---------------------------------------------------------------------------
// Webview script
// ---------------------------------------------------------------------------

const SCRIPT = `
const vscode = acquireVsCodeApi();
let vm = null;
let costLine = false;
const esc = (s) => String(s === null || s === undefined ? '' : s)
  .replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const post = (m) => vscode.postMessage(m);
const has = (k) => vm.sections.indexOf(k) >= 0;

function pct(v) { return Math.max(0, Math.min(100, Number(v) || 0)); }

function bar(percent, cls, elapsed, forecastEnd, aria) {
  let h = '<div class="track" role="progressbar" aria-valuemin="0" aria-valuemax="'
    + (aria ? aria.max : 100) + '" aria-valuenow="' + (aria ? aria.now : Math.round(percent))
    + '" aria-valuetext="' + esc(aria ? aria.text : '') + '">'
    + '<div class="fill ' + cls + '" data-w="' + pct(percent).toFixed(2) + '"></div>';
  if (elapsed !== null && elapsed !== undefined) {
    h += '<i class="mark" data-x="' + pct(elapsed).toFixed(2) + '" title="time elapsed in this window"></i>';
  }
  if (forecastEnd !== null && forecastEnd !== undefined) {
    h += '<i class="mark fc" data-x="' + pct(forecastEnd).toFixed(2) + '" title="projected at the reset"></i>';
  }
  return h + '</div>';
}

function sparkSvg(values) {
  const n = values.length;
  if (!n) return '';
  const W = 100, H = 20;
  const segs = []; let cur = [];
  for (let i = 0; i < n; i++) {
    const v = values[i];
    if (v < 0) { if (cur.length) segs.push(cur); cur = []; continue; }
    const x = n <= 1 ? W / 2 : (i / (n - 1)) * W;
    const y = H - (pct(v) / 100) * H;
    cur.push(x.toFixed(1) + ',' + y.toFixed(1));
  }
  if (cur.length) segs.push(cur);
  const body = segs.map(s => s.length === 1
    ? '<circle cx="' + s[0].split(',')[0] + '" cy="' + s[0].split(',')[1] + '" r="1.2"/>'
    : '<polyline points="' + s.join(' ') + '"/>').join('');
  return '<svg class="spark" viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="none" '
    + 'aria-hidden="true">' + body + '</svg>';
}

// -- controls ---------------------------------------------------------------

function controls() {
  const r = vm.range;
  const chips = r.presets.map(p => '<button data-act="range" data-preset="' + p + '" aria-pressed="'
    + (r.preset === p) + '">' + esc(p) + '</button>').join('');
  const providers = ['claude', 'codex'].map(s => '<button data-act="provider" data-src="' + s
    + '" aria-pressed="' + (vm.ui.providers.indexOf(s) >= 0) + '">' + esc(s) + '</button>').join('');
  const models = (vm.models.rows || []).slice(0, 12).map(m => '<button data-act="model" data-model="'
    + esc(m.model) + '" aria-pressed="' + (vm.ui.models.indexOf(m.model) >= 0) + '">'
    + esc(m.model) + '</button>').join('');
  return '<div class="wrap">' + chips
    + '<button data-act="refresh" title="Rebuild from the transcripts and fetch the quota">refresh</button>'
    + '</div>'
    + '<div class="wrap"><label class="meta" for="tp-from">from</label>'
    + '<input id="tp-from" type="date" data-role="from" value="' + esc(r.from) + '">'
    + '<label class="meta" for="tp-to">to</label>'
    + '<input id="tp-to" type="date" data-role="to" value="' + esc(r.to) + '">'
    + '<button data-act="customRange">apply</button>'
    + '<span class="meta">' + esc(r.label) + ' · ' + esc(r.from) + ' → ' + esc(r.to) + '</span></div>'
    + '<div class="wrap"><span class="meta">providers</span>' + providers
    + (models ? '<span class="meta">models</span>' + models : '')
    + (vm.ui.models.length ? '<button data-act="clearModels">clear</button>' : '')
    + '</div>';
}

// -- sections ---------------------------------------------------------------

function sSummary() {
  if (!vm.digest.length) return '<p class="empty">Not enough data for a summary yet.</p>';
  return '<ul>' + vm.digest.map(s => '<li>' + esc(s) + '</li>').join('') + '</ul>';
}

function quotaCard(q) {
  let h = '<div class="card"><div class="row"><span class="name">' + esc(q.title) + '</span>'
    + '<span class="meta' + (q.stale ? ' warn' : '') + '">'
    + [q.planType ? 'plan ' + esc(q.planType) : '', q.origin ? esc(q.origin) : '',
       q.ageText ? esc(q.ageText) : ''].filter(Boolean).join(' · ')
    + (q.stale ? ' ⚠ stale' : '') + '</span></div>';
  if (q.problem) {
    h += '<div class="box" role="status">' + esc(q.problem)
      + (q.problemKind ? ' <span class="meta">(' + esc(q.problemKind) + ')</span>' : '')
      + (q.problemAction ? '<br><button data-act="cmd" data-id="' + esc(q.problemAction.command)
         + '">' + esc(q.problemAction.label) + '</button>' : '')
      + '</div>';
  }
  for (const w of q.windows) {
    const f = w.forecast;
    const end = f && f.endPercent !== null && f.endPercent !== undefined ? f.endPercent : null;
    h += '<div class="win"><div class="win-top"><span>' + esc(w.label)
      + (w.reset ? ' · resets ' + esc(w.reset) : '') + '</span><b>' + esc(w.percentText) + '</b></div>'
      + bar(w.percent, w.display === 'resetDue' ? 'neutral' : w.level, w.elapsed, end, w.aria)
      + '<div class="verdict ' + esc(w.level) + '">'
      + (w.level === 'ok' ? '' : '▲ ') + esc(w.verdict.text)
      + (w.display !== 'normal' ? ' · ' + esc(w.display) : '') + '</div>';
    if (f && f.text) h += '<div class="meta">' + esc(f.text) + '</div>';
    if (w.sustainable) h += '<div class="meta">' + esc(w.sustainable) + '</div>';
    if (w.spark && w.spark.length > 1) h += sparkSvg(w.spark);
    h += '</div>';
  }
  if (q.extra) {
    h += '<div class="win"><div class="win-top"><span>Extra usage'
      + (q.extra.billed ? ' (billed)' : '') + '</span><b>' + esc(q.extra.text) + '</b></div>'
      + (q.extra.utilization === null ? ''
         : bar(q.extra.utilization, 'extra', null, null,
               { now: Math.round(q.extra.utilization), max: 100, text: q.extra.text }))
      + '</div>';
  }
  const f = q.freshness;
  h += '<div class="meta">last check ' + esc(f.lastCheck || '–') + ' · last data '
    + esc(f.lastData || '–') + ' · last local event ' + esc(f.lastEvent || '–')
    + ' · next refresh ' + esc(f.nextRefresh || '–') + ' · snapshot ' + esc(f.snapshotAge || '–')
    + '</div>';
  if (q.usagePageUrl) h += '<div class="meta">official page: ' + esc(q.usagePageUrl) + '</div>';
  return h + '</div>';
}

function sQuota() {
  if (!vm.quotas.length) return '<p class="empty">No quota reading.</p>';
  return vm.quotas.map(quotaCard).join('')
    + '<div class="legend"><span><i class="dot time"></i>time elapsed</span>'
    + '<span><i class="dot fc"></i>projected at the reset</span></div>';
}

function sKpis() {
  return '<div class="kpis">' + vm.kpis.map(k => {
    const d = k.delta
      ? '<span class="d ' + (k.delta.glyph === '▲' ? 'up' : k.delta.glyph === '▼' ? 'down' : '')
        + '">' + esc(k.delta.glyph) + ' ' + esc(k.delta.text) + '</span>'
      : '';
    return '<div class="kpi" title="' + esc([k.note, k.provenance].filter(Boolean).join(' · ')) + '">'
      + '<div class="l">' + esc(k.label) + '</div><div class="v">' + esc(k.value) + '</div>'
      + '<div class="meta">' + d + '</div>' + sparkSvg(normSpark(k.spark)) + '</div>';
  }).join('') + '</div>';
}

/** KPI sparks are absolute values; the shared renderer wants 0..100. */
function normSpark(values) {
  const max = Math.max.apply(null, values.concat([0]));
  return max > 0 ? values.map(v => (v / max) * 100) : values.map(() => 0);
}

function totalsTable(t) {
  const cost = vm.showCost;
  const head = ['Period', 'Usage', 'Fresh in', 'Write 5m', 'Write 1h', 'Cache read', 'Output',
    'Reasoning', 'Req.', 'Hit', 'Per req.'].concat(cost ? ['API cost'] : []);
  const rows = t.rows.map(r => '<tr>'
    + '<td data-h="Period">' + esc(r.label) + '</td>'
    + '<td data-h="Usage">' + esc(r.usage) + '</td>'
    + '<td data-h="Fresh in">' + esc(r.freshInput) + '</td>'
    + '<td data-h="Write 5m">' + esc(r.cacheWrite5m) + '</td>'
    + '<td data-h="Write 1h">' + esc(r.cacheWrite1h) + '</td>'
    + '<td data-h="Cache read">' + esc(r.cacheRead) + '</td>'
    + '<td data-h="Output">' + esc(r.output) + (r.incomplete
        ? ' <span title="output is a lower bound: some requests had no terminal line">⚠</span>' : '')
    + '</td>'
    + '<td data-h="Reasoning">' + esc(r.reasoning) + '</td>'
    + '<td data-h="Req.">' + esc(r.requests) + '</td>'
    + '<td data-h="Hit">' + esc(r.cacheHit) + '</td>'
    + '<td data-h="Per req.">' + esc(r.perRequest) + '</td>'
    + (cost ? '<td data-h="API cost">' + esc(r.cost) + (r.costPartial
        ? ' <span title="some models have no price on file">⚠</span>' : '') + '</td>' : '')
    + '</tr>').join('');
  return '<div class="card"><div class="name">' + esc(t.title) + '</div><div class="scroll"><table>'
    + '<thead><tr>' + head.map(h => '<th>' + esc(h) + '</th>').join('') + '</tr></thead>'
    + '<tbody>' + rows + '</tbody></table></div></div>';
}

/** Where the tokens of a period went — the six counted fields as one bar. */
/** A fixed colour per field, so the same part keeps its colour across providers and updates. */
const PART_CLASS = {
  freshInput: 'c1', cacheWrite5m: 'c2', cacheWrite1h: 'c3', cacheRead: 'c4', output: 'c5',
  reasoning: 'c6',
};

function compositionBar(c) {
  // Reasoning is a subset of output; adding it as its own slice would count it twice.
  const parts = c.parts.filter(p => p.key !== 'reasoning' && p.tokens > 0);
  const total = parts.reduce((s, p) => s + p.tokens, 0);
  if (!total) return '';
  const cls = (p) => PART_CLASS[p.key] || 'c6';
  const segs = parts.map(p => '<i class="cs ' + cls(p) + '" data-w="'
    + ((p.tokens / total) * 100).toFixed(2) + '" title="' + esc(p.text) + ': '
    + Math.round(p.tokens).toLocaleString('en-US') + '"></i>').join('');
  return '<div class="meta">' + esc(c.source) + ' composition</div>'
    + '<div class="compbar">' + segs + '</div>'
    + '<div class="legend">' + parts.map(p => '<span><i class="dot ' + cls(p) + '"></i>'
      + esc(p.text) + '</span>').join('') + '</div>';
}

function sTokens() {
  let h = vm.totals.map(totalsTable).join('');
  h += vm.composition.map(compositionBar).join('');
  if (vm.cacheEconomy.length) {
    h += '<div class="scroll"><table><thead><tr><th>Cache</th><th>Hit rate</th>'
      + '<th>Realised</th><th>Blended $/1M</th></tr></thead><tbody>'
      + vm.cacheEconomy.map(c => '<tr><td data-h="Cache">' + esc(c.source) + '</td>'
        + '<td data-h="Hit rate">' + esc(c.hitRate) + '</td><td data-h="Realised">'
        + esc(c.savedUsd) + (c.partial ? ' ⚠' : '') + '</td><td data-h="Blended">'
        + esc(c.blendedPerM) + '</td></tr>').join('')
      + '</tbody></table></div>'
      + '<div class="meta">' + esc(vm.cacheEconomy[0].note) + '</div>';
  }
  const cal = vm.calendar;
  h += '<div class="scroll"><table><thead><tr><th>Period</th><th>Usage</th>'
    + (vm.showCost ? '<th>API cost</th>' : '') + '<th>Req.</th><th>Active</th><th>Ø/day</th>'
    + '</tr></thead><tbody>'
    + [cal.thisWeek, cal.thisMonth, cal.lastMonth, cal.year].map(p => '<tr>'
      + '<td data-h="Period">' + esc(p.label) + '</td><td data-h="Usage">' + esc(p.usage) + '</td>'
      + (vm.showCost ? '<td data-h="API cost">' + esc(p.cost) + '</td>' : '')
      + '<td data-h="Req.">' + esc(p.requests) + '</td><td data-h="Active">' + p.activeDays
      + '</td><td data-h="Ø/day">' + esc(p.avgPerDay) + '</td></tr>').join('')
    + '</tbody></table></div>';
  if (cal.thisMonth.projection) {
    h += '<div class="meta">month projection ' + esc(cal.thisMonth.projection) + ' · '
      + esc(cal.thisMonth.projectionBasis) + '</div>';
  }
  for (const p of vm.planFactor) {
    h += '<div class="meta">' + esc(p.text) + (p.partial ? ' ⚠ lower bound' : '') + '</div>';
  }
  return h;
}

function sChart() {
  const c = vm.chart;
  if (!c.days.length) return '<p class="empty">No data in this range.</p>';
  const metrics = ['usage', 'output', 'cacheRead', 'requests', 'reasoning', 'cost'];
  const sel = '<select data-act="metric" aria-label="chart metric">'
    + metrics.map(m => '<option value="' + m + '"' + (c.metric === m ? ' selected' : '') + '>'
      + esc(m) + '</option>').join('') + '</select>';
  const totals = c.days.map((_, i) => c.series.reduce((s, x) => s + x.values[i], 0));
  const showValues = c.days.length <= 31;
  const cols = c.days.map((d, i) => {
    const segs = c.series.map(s => {
      const v = s.values[i];
      if (v <= 0) return '';
      return '<div class="seg ' + s.source + '" data-bh="' + ((v / c.max) * 100).toFixed(2)
        + '" title="' + esc(s.source + ' ' + d + ': ' + Math.round(v).toLocaleString('en-US')) + '"></div>';
    }).join('');
    return '<div class="col" data-act="drill" data-day="' + esc(d) + '" tabindex="0" role="button" '
      + 'title="' + esc(d + ': ' + Math.round(totals[i]).toLocaleString('en-US')) + '">'
      + (showValues && totals[i] > 0
         ? '<span class="vlabel">' + esc(short(totals[i])) + '</span>' : '')
      + segs + '</div>';
  }).join('');
  const grids = c.ticks.map((t, i) => '<div class="grid" data-b="' + ((i + 1) * 25)
    + '"><span>' + esc(short(t)) + '</span></div>').join('');
  let overlay = '';
  if (costLine && c.costLine) {
    const cmax = Math.max.apply(null, c.costLine.concat([0])) || 1;
    const n = c.costLine.length;
    const pts = c.costLine.map((v, i) => ((n <= 1 ? 50 : (i / (n - 1)) * 100)).toFixed(1) + ','
      + (100 - (v / cmax) * 100).toFixed(1)).join(' ');
    overlay = '<svg class="costline" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">'
      + '<polyline points="' + pts + '"/></svg>';
  }
  const every = Math.max(1, Math.ceil(c.days.length / 12));
  const labels = c.labels.map((l, i) => '<span>' + (i % every === 0 ? esc(l) : '') + '</span>').join('');
  return '<div class="row"><span class="meta">' + (c.weekly ? 'weekly bars' : 'daily bars')
    + ' · ' + c.days.length + ' columns</span><span class="wrap">' + sel
    + (c.costLine ? '<button data-act="costLine" aria-pressed="' + costLine + '">cost line</button>' : '')
    + '</span></div>'
    + '<div class="plot">' + grids + '<div class="chart">' + cols + '</div>' + overlay + '</div>'
    + '<div class="axis">' + labels + '</div>'
    + '<div class="legend">' + c.series.map(s => '<span><i class="dot ' + s.source + '"></i>'
      + esc(s.source) + '</span>').join('')
    + (costLine && c.costLine ? '<span>— API cost (second axis)</span>' : '')
    + '<span>click a column for that day</span></div>';
}

function short(n) {
  const a = Math.abs(n);
  if (a >= 1e9) return (n / 1e9).toFixed(1) + 'G';
  if (a >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (a >= 1e3) return (n / 1e3).toFixed(1) + 'K';
  return String(Math.round(n * 100) / 100);
}

function sModels() {
  const m = vm.models;
  if (!m.rows.length) return '<p class="empty">No model data in this range.</p>';
  const cols = [['model', 'Model'], ['usage', 'Usage'], ['output', 'Output'], ['requests', 'Req.'],
    ['cacheHit', 'Hit']].concat(vm.showCost ? [['cost', 'API cost']] : []);
  const head = cols.map(c => '<th class="sortable" data-act="sort" data-key="' + c[0] + '" tabindex="0"'
    + (m.sort.key === c[0] ? ' aria-sort="' + (m.sort.dir === 'asc' ? 'ascending' : 'descending') + '"' : '')
    + '>' + esc(c[1]) + '</th>').join('') + '<th>Share</th><th>Price</th>';
  const rows = m.rows.map(r => '<tr>'
    + '<td data-h="Model">' + esc(r.model) + (r.isSub ? ' <span class="meta">sub</span>' : '')
    + (r.tier !== 'standard' ? ' <span class="meta">' + esc(r.tier) + '</span>' : '') + '</td>'
    + '<td data-h="Usage">' + esc(r.usageText) + '</td>'
    + '<td data-h="Output">' + esc(r.output) + '</td>'
    + '<td data-h="Req.">' + esc(r.requests) + '</td>'
    + '<td data-h="Hit">' + esc(r.cacheHit) + '</td>'
    + (vm.showCost ? '<td data-h="API cost">' + esc(r.costText) + '</td>' : '')
    + '<td data-h="Share">' + esc(r.share) + '</td>'
    + '<td data-h="Price" title="' + esc(r.price) + '">' + esc(r.priced) + '</td>'
    + '</tr>' + (r.turnAvg
      ? '<tr><td colspan="99" class="meta">Ø turn ' + esc(r.turnAvg)
        + (r.turnP90 ? ' · P90 ' + esc(r.turnP90) : '') + '</td></tr>' : '')).join('');
  const more = m.hidden > 0
    ? '<tr class="more"><td colspan="99">' + m.hidden
      + ' more — set tokenPace.dashboard.modelRows</td></tr>' : '';
  return '<div class="scroll"><table><thead><tr>' + head + '</tr></thead><tbody>' + rows + more
    + '</tbody></table></div>';
}

function sHeatmap() {
  const h = vm.heatmap;
  const cells = h.weeks.map(w => w.days.map(d => '<i class="'
    + (d.level === null ? 'out' : 'l' + d.level) + '" title="' + esc(d.text) + '"></i>').join('')).join('');
  return '<div class="row"><span class="meta">streak ' + h.streak + ' · longest ' + h.longestStreak
    + ' · active ' + h.activeDays
    + (h.peakDay ? ' · peak ' + esc(h.peakDay.day) + ' (' + esc(h.peakDay.text) + ')' : '')
    + (h.variability ? ' · CV ' + esc(h.variability.cv) + ' · ' + h.variability.spikyDays
       + ' spiky day(s)' : '')
    + '</span><span class="wrap">'
    + ['usage', 'cost'].map(m => '<button data-act="heatmapMetric" data-metric="' + m
      + '" aria-pressed="' + (h.metric === m) + '">' + m + '</button>').join('')
    + '</span></div>'
    + '<div class="heat">' + cells + '</div>'
    + '<div class="legend"><span>less</span><span><i class="dot l1"></i>'
    + '<i class="dot l2"></i><i class="dot l3"></i>'
    + '<i class="dot l4"></i></span><span>more</span>'
    + '<span>dotted = outside coverage'
    + (h.firstDay ? ' (before ' + esc(h.firstDay) + ')' : '') + '</span></div>';
}

function sHours() {
  const p = vm.hours;
  const max = Math.max.apply(null, p.profile.map(x => x.value).concat([0])) || 1;
  const bars = p.profile.map(x => '<div class="hb" data-bh="'
    + Math.max(1, (x.value / max) * 100).toFixed(2) + '" title="'
    + esc(String(x.hour).padStart(2, '0') + ':00 · ' + x.text) + '"></div>').join('');
  const gmax = Math.max.apply(null, p.grid.map(c => c.value || 0).concat([0])) || 1;
  const blocks = ['00–04', '04–08', '08–12', '12–16', '16–20', '20–24'];
  let grid = '<div class="hgrid"><span></span>'
    + blocks.map(b => '<span class="meta">' + b + '</span>').join('');
  for (let d = 0; d < 7; d++) {
    grid += '<span class="meta">' + esc(p.weekdayLabels[d] || String(d + 1)) + '</span>';
    for (let b = 0; b < 6; b++) {
      const cell = p.grid.find(c => c.weekday === d && c.block === b) || { value: null, samples: 0 };
      const lvl = cell.value === null ? 'none'
        : 'l' + Math.max(1, Math.ceil((cell.value / gmax) * 4));
      grid += '<i class="' + lvl + '" title="' + esc(cell.value === null
        ? 'fewer than 3 days of samples (' + cell.samples + ')'
        : Math.round(cell.value).toLocaleString('en-US') + ' tokens over ' + cell.samples + ' day(s)')
        + '"></i>';
    }
  }
  grid += '</div>';
  return '<div class="row"><span class="meta">'
    + (p.peakHour === null ? 'no hour data' : 'peak ' + String(p.peakHour).padStart(2, '0') + ':00')
    + ' · ' + p.days + ' day(s)</span><span class="wrap">'
    + ['local', 'utc'].map(z => '<button data-act="hourZone" data-zone="' + z + '" aria-pressed="'
      + (p.zone === z) + '">' + z + '</button>').join('') + '</span></div>'
    + '<div class="hours">' + bars + '</div>'
    + (p.note ? '<div class="meta">' + esc(p.note) + '</div>' : '')
    + grid;
}

function sForecast() {
  let h = '';
  if (!vm.forecasts.length) h += '<p class="empty">No window to project.</p>';
  for (const f of vm.forecasts) {
    h += '<div class="card"><div class="row"><span class="name">' + esc(f.label) + '</span>'
      + '<span class="meta">' + esc(f.forecast.state)
      + (f.forecast.confidence ? ' · ' + esc(f.forecast.confidence) + ' confidence' : '')
      + '</span></div>'
      + '<div>' + esc(f.forecast.text || '—') + '</div>'
      + '<div class="meta">' + [f.sustainable, f.lockout, f.resetForecast].filter(Boolean)
        .map(esc).join(' · ')
      + (f.forecast.basis ? ' · ' + f.forecast.basis.samples + ' readings' : '')
      + (f.gaps ? ' · ' + f.gaps + ' gap(s)' : '') + '</div>'
      + (f.spark.length > 1 ? sparkSvg(f.spark) : '') + '</div>';
  }
  if (vm.windowUsage.length) {
    h += '<div class="scroll"><table><thead><tr><th>Local usage in window</th><th>Usage</th>'
      + '<th>Req.</th>' + (vm.showCost ? '<th>API cost</th>' : '') + '</tr></thead><tbody>'
      + vm.windowUsage.map(u => '<tr><td data-h="Window">' + esc(u.label)
        + (u.complete ? '' : ' <span title="hour buckets are rolled up for part of this window">≈</span>')
        + '</td><td data-h="Usage">' + esc(u.usage) + '</td><td data-h="Req.">' + esc(u.requests)
        + '</td>' + (vm.showCost ? '<td data-h="API cost">' + esc(u.cost) + '</td>' : '')
        + '</tr>').join('') + '</tbody></table></div>';
  }
  for (const a of vm.attributionInWindow) {
    h += '<div class="card"><div class="name">' + esc(a.windowId) + '</div>'
      + '<div class="scroll"><table><tbody>'
      + a.rows.map(r => '<tr><td>' + esc(r.label) + '</td><td>' + esc(r.share) + '</td><td>'
        + esc(r.usage) + '</td></tr>').join('')
      + '</tbody></table></div><div class="meta">' + esc(a.unexplained) + '</div></div>';
  }
  return h;
}

function sHistory() {
  if (!vm.retro.length) return '<p class="empty">No cycles on file yet.</p>';
  return '<ul>' + vm.retro.map(r => '<li><b>' + esc(r.label) + '</b>: ' + esc(r.text)
    + '</li>').join('') + '</ul>';
}

function sProjects() {
  if (!vm.projects.enabled) {
    return '<p class="empty">Project attribution is off (tokenPace.attribution).</p>';
  }
  if (!vm.projects.rows.length) return '<p class="empty">No project data yet.</p>';
  return '<div class="scroll"><table><thead><tr><th>Project</th><th>Usage</th><th>Req.</th>'
    + '<th>Hit</th><th>Share</th><th>Sessions</th></tr></thead><tbody>'
    + vm.projects.rows.map(p => '<tr><td data-h="Project">' + esc(p.project) + '</td>'
      + '<td data-h="Usage">' + esc(p.usage) + '</td><td data-h="Req.">' + esc(p.requests) + '</td>'
      + '<td data-h="Hit">' + esc(p.cacheHit) + '</td><td data-h="Share">'
      + esc(p.share) + '</td><td data-h="Sessions">' + p.sessions + '</td></tr>').join('')
    + '</tbody></table></div>';
}

function sSessions() {
  if (!vm.sessions.enabled) {
    return '<p class="empty">Session attribution is off (tokenPace.attribution).</p>';
  }
  if (!vm.sessions.rows.length) return '<p class="empty">No session data yet.</p>';
  return '<div class="scroll"><table><thead><tr><th>Session</th><th>Project</th><th>Started</th>'
    + '<th>Duration</th><th>Usage</th><th>Req.</th><th>Cache</th></tr></thead><tbody>'
    + vm.sessions.rows.map(s => '<tr><td data-h="Session">' + esc(s.session)
      + (s.isSub ? ' <span class="meta">sub</span>' : '') + '</td>'
      + '<td data-h="Project">' + esc(s.project) + '</td><td data-h="Started">' + esc(s.started)
      + '</td><td data-h="Duration">' + esc(s.duration) + '</td><td data-h="Usage">' + esc(s.usage)
      + '</td><td data-h="Req.">' + esc(s.requests) + '</td><td data-h="Cache">'
      + esc(s.cacheState || '–') + '</td></tr>').join('')
    + '</tbody></table></div>';
}

function sDataQuality() {
  const d = vm.dataQuality;
  const li = [];
  li.push('Roots: ' + (d.roots.length ? d.roots.map(esc).join(', ') : 'none') + ' · ' + d.files + ' file(s)');
  li.push('Coverage ' + esc(d.oldestDay || '–') + ' → ' + esc(d.newestDay || '–') + ' · '
    + d.buckets.hour + ' hour / ' + d.buckets.day + ' day / ' + d.buckets.month
    + ' month buckets · snapshot ' + Math.round(d.snapshotBytes / 1024) + ' KB');
  li.push('Lower bound share ' + esc(d.lowerBoundShare)
    + (d.unpricedModels.length ? ' · unpriced: ' + d.unpricedModels.map(esc).join(', ') : '')
    + (d.familyPriced.length ? ' · family-priced: ' + d.familyPriced.map(esc).join(', ') : ''));
  li.push('Retention ' + d.retention.hourDays + ' d hourly · ' + d.retention.days + ' d daily · '
    + d.retention.historyDays + ' d quota history');
  li.push('Quota history ' + d.history.samples + ' samples · ' + Math.round(d.history.bytes / 1024)
    + ' KB · oldest ' + esc(d.history.oldest || '–'));
  for (const q of d.quota) {
    li.push('Sources ' + esc(q.source) + ': ' + (q.candidates.length
      ? q.candidates.map(c => esc(c.id) + ' ' + (c.ok
          ? (c.ageSec === null ? 'ok' : Math.round(c.ageSec / 60) + ' min')
          : esc(c.problem || 'unavailable'))).join(' · ')
      : 'no source answered'));
    if (q.drift.length) {
      li.push('Fields reported but not rendered (' + esc(q.source) + '): '
        + q.drift.map(esc).join(', '));
    }
  }
  for (const c of d.calibration) {
    li.push('Calibration ' + esc(c.source) + ' ' + esc(c.windowId) + ': ' + esc(c.text));
  }
  if (d.bridge) li.push('Status line: ' + esc(d.bridge));
  li.push('Consent: ' + esc(d.consent) + ' · ' + esc(d.leader) + ' · attribution '
    + esc(d.attribution) + ' · v' + esc(d.version));
  return '<ul>' + li.map(x => '<li>' + x + '</li>').join('') + '</ul>'
    + '<div class="wrap">'
    + '<button data-act="cmd" data-id="tokenPace.copyDiagnostics">copy diagnostics</button>'
    + '<button data-act="cmd" data-id="tokenPace.exportCsv">export CSV</button>'
    + '<button data-act="cmd" data-id="tokenPace.exportJson">export JSON</button>'
    + '<button data-act="cmd" data-id="tokenPace.copySummary">copy summary</button>'
    + '<button data-act="cmd" data-id="tokenPace.clearStoredData">clear stored data</button>'
    + '</div>';
}

function sDrill() {
  if (!vm.drill) return '';
  return '<h2>Day ' + esc(vm.drill.day) + '</h2>'
    + '<div class="scroll"><table><thead><tr><th>Model</th><th>Usage</th><th>Req.</th>'
    + (vm.showCost ? '<th>API cost</th>' : '') + '</tr></thead><tbody>'
    + vm.drill.models.map(m => '<tr><td data-h="Model">' + esc(m.model) + '</td>'
      + '<td data-h="Usage">' + esc(m.usageText) + '</td><td data-h="Req.">' + esc(m.requests)
      + '</td>' + (vm.showCost ? '<td data-h="API cost">' + esc(m.costText) + '</td>' : '')
      + '</tr>').join('')
    + (vm.drill.sessions.length
       ? vm.drill.sessions.map(s => '<tr><td colspan="99" class="meta">' + esc(s.session) + ' · '
         + esc(s.project) + ' · ' + esc(s.usage) + '</td></tr>').join('') : '')
    + '</tbody></table></div>'
    + '<button data-act="drill" data-day="">close</button>';
}

const RENDER = {
  controls: sControls, footer: sFooter, drill: sDrill,
  summary: sSummary, quota: sQuota, kpis: sKpis, tokens: sTokens, chart: sChart, models: sModels,
  heatmap: sHeatmap, hours: sHours, forecast: sForecast, history: sHistory, projects: sProjects,
  sessions: sSessions, dataQuality: sDataQuality,
};
const TITLE = {
  summary: 'Summary', quota: 'Quota', kpis: 'Key figures', tokens: 'Tokens', chart: 'Chart',
  models: 'Models', heatmap: 'Activity', hours: 'Time of day', forecast: 'Forecast',
  history: 'Reset history', projects: 'Projects', sessions: 'Sessions', dataQuality: 'Data quality',
};

function sControls() {
  let h = controls();
  if (vm.firstRun) {
    h += '<div class="box info" role="status">' + esc(vm.firstRun.text)
      + (vm.firstRun.scanning ? '' : '<br><button data-act="cmd" data-id="tokenPace.rescan">'
        + 'Re-read token history</button>') + '</div>';
  }
  if (vm.preview) h += '<div class="box" role="status">Preview data — not a reading.</div>';
  return h;
}

function sFooter() {
  return '<ul>' + vm.footnotes.map(f => '<li>' + esc(f) + '</li>').join('')
    + '<li>Prices as of ' + esc(vm.pricing.asOf)
    + (vm.pricing.custom ? ' · your configured rates' : '') + '.</li>'
    + '<li>Generated ' + esc(vm.generatedAt) + '.</li></ul>';
}

function renderAll() {
  let h = '<div data-sec="controls" data-body="controls">' + sControls() + '</div>';
  for (const key of vm.sections) {
    if (!RENDER[key]) continue;
    h += '<section data-sec="' + key + '"><h2>' + esc(TITLE[key] || key) + '</h2>'
      + '<div data-body="' + key + '">' + RENDER[key]() + '</div></section>';
  }
  h += '<div data-sec="drill" data-body="drill">' + sDrill() + '</div>';
  h += '<div class="foot" data-sec="footer" data-body="footer">' + sFooter() + '</div>';
  document.getElementById('root').innerHTML = h;
  applyStyles();
}

/**
 * Replaces one section's body and nothing else. Scroll position and the caret in the date
 * inputs live in the untouched part of the document, which is the whole point.
 */
function renderSection(key) {
  const body = document.querySelector('[data-body="' + key + '"]');
  if (!body || !RENDER[key]) { renderAll(); return; }
  body.innerHTML = RENDER[key]();
  applyStyles();
}

/** The CSP forbids inline style attributes; values set through the CSSOM are unaffected. */
function applyStyles() {
  document.querySelectorAll('[data-w]').forEach(el => { el.style.width = el.dataset.w + '%'; });
  document.querySelectorAll('[data-bh]').forEach(el => { el.style.height = el.dataset.bh + '%'; });
  document.querySelectorAll('[data-x]').forEach(el => { el.style.left = el.dataset.x + '%'; });
  document.querySelectorAll('[data-b]').forEach(el => { el.style.bottom = el.dataset.b + '%'; });
}

// -- events -----------------------------------------------------------------

function act(el) {
  const a = el.dataset.act;
  if (a === 'range') post({ type: 'setRange', preset: el.dataset.preset });
  else if (a === 'customRange') {
    const from = document.querySelector('[data-role="from"]');
    const to = document.querySelector('[data-role="to"]');
    if (from && to && from.value && to.value) post({ type: 'setRange', from: from.value, to: to.value });
  } else if (a === 'refresh') post({ type: 'refresh' });
  else if (a === 'cmd') post({ type: 'command', id: el.dataset.id });
  else if (a === 'sort') {
    const key = el.dataset.key;
    const dir = vm.models.sort.key === key && vm.models.sort.dir === 'desc' ? 'asc' : 'desc';
    post({ type: 'setSort', key: key, dir: dir });
  } else if (a === 'provider') {
    const s = el.dataset.src;
    const list = vm.ui.providers.slice();
    const i = list.indexOf(s);
    if (i >= 0) list.splice(i, 1); else list.push(s);
    post({ type: 'setFilter', providers: list, models: vm.ui.models });
  } else if (a === 'model') {
    const m = el.dataset.model;
    const list = vm.ui.models.slice();
    const i = list.indexOf(m);
    if (i >= 0) list.splice(i, 1); else list.push(m);
    post({ type: 'setFilter', providers: vm.ui.providers, models: list });
  } else if (a === 'clearModels') {
    post({ type: 'setFilter', providers: vm.ui.providers, models: [] });
  } else if (a === 'heatmapMetric') post({ type: 'setHeatmapMetric', metric: el.dataset.metric });
  else if (a === 'hourZone') post({ type: 'setHourZone', zone: el.dataset.zone });
  else if (a === 'drill') post({ type: 'drill', day: el.dataset.day || null });
  else if (a === 'costLine') { costLine = !costLine; renderSection('chart'); }
}

function target(ev, sel) {
  const t = ev.target;
  return t && t.closest ? t.closest(sel) : null;
}
document.addEventListener('click', (ev) => {
  const el = target(ev, '[data-act]');
  if (el && vm) act(el);
});
document.addEventListener('keydown', (ev) => {
  if (ev.key !== 'Enter' && ev.key !== ' ') return;
  const el = target(ev, '[data-act]');
  if (el && vm && el.tagName !== 'BUTTON' && el.tagName !== 'SELECT') { ev.preventDefault(); act(el); }
});
document.addEventListener('change', (ev) => {
  const el = target(ev, '[data-act="metric"]');
  if (el && vm) post({ type: 'setMetric', metric: el.value });
});

window.addEventListener('message', (ev) => {
  const msg = ev.data;
  if (!msg) return;
  if (msg.type === 'data') { vm = msg.payload; renderAll(); return; }
  if (msg.type === 'section' && vm) {
    Object.assign(vm, msg.payload);
    renderSection(msg.key);
  }
});
`
