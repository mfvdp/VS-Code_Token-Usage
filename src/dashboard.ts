// SPDX-FileCopyrightText: 2026 Frederik Marx
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The dashboard webview.
 *
 * Three things this file is careful about. Everything it renders comes from the view model —
 * no number is computed here, so the webview cannot drift away from the QuickPick and the
 * markdown view. Everything the webview sends back goes through `parseWebviewMessage`: it is
 * the only untrusted input the extension has, and it may ask for a range, a fold, the
 * settings of one named section or one of eleven named commands, never for a path or a
 * setting id of its own. And updates are per section, so a one-second refresh cannot reset
 * a sort order or throw away the scroll position.
 *
 * No external resource of any kind: the CSP allows exactly the nonced inline style and
 * script of this file. The chart, the heatmap and the sparklines are CSS and inline SVG.
 */

import * as vscode from 'vscode'
import { SOURCE_TITLE } from './adapters'
import { WebviewMessage, parseWebviewMessage } from './viewModel'
import type { ViewModel } from './viewModel'

/**
 * What a section is rebuilt from. A field of the UI state may be named as `ui.<field>`: the
 * fragment then still carries the whole `ui` object — the webview merges a payload field by
 * field — but the section is only rebuilt when that one field changes. Listing the whole
 * `ui` where a single switch is meant replaced the body on every sort, drill and fold, and
 * with it the sideways scroll position of the tables inside it.
 */
type SectionField = keyof ViewModel | `ui.${keyof ViewModel['ui']}`

/** Section keys the webview renders, in the order `dashboard.sections` gives them. */
const SECTION_FIELDS: Record<string, SectionField[]> = {
  summary: ['digest'],
  quota: ['quotas'],
  context: ['context'],
  kpis: ['kpis'],
  // The cache switch above the composition bars decides which parts are drawn, so the
  // section follows it — and nothing else the reader may do to the view state.
  tokens: ['totals', 'composition', 'cacheEconomy', 'calendar', 'planFactor', 'ui.compositionCache'],
  chart: ['chart'],
  models: ['models'],
  heatmap: ['heatmap'],
  hours: ['hours'],
  records: ['records'],
  tools: ['tools'],
  budget: ['budgets'],
  history: ['retro'],
  projects: ['projects'],
  sessions: ['sessions'],
  dataQuality: ['dataQuality'],
  drill: ['drill'],
  // Chrome that is always present. `footer` carries the generated-at line, which changes on
  // every tick — keeping it in its own node is what stops a full re-render every minute.
  notices: ['firstRun', 'preview'],
  controls: ['range', 'ui', 'models'],
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
      void view.webview.postMessage({ type: 'section', key, payload: payloadOf(vm, fields) })
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

const LAYOUT_FIELDS: SectionField[] = ['sections', 'showCost']

const UI_FIELD = 'ui.'

/** The one field of the UI state a `ui.<field>` dependency names. */
function uiField(f: SectionField): string {
  return f.slice(UI_FIELD.length)
}

/**
 * What a section's fragment carries. A `ui.<field>` dependency ships the whole `ui` object:
 * the webview assigns a payload's fields onto its view model, so half a `ui` there would
 * throw the provider chips and the model filter away.
 */
function payloadOf(vm: ViewModel, fields: SectionField[]): Record<string, unknown> {
  const o: Record<string, unknown> = {}
  for (const f of fields) {
    if (f.startsWith(UI_FIELD)) o.ui = vm.ui
    else o[f] = vm[f as keyof ViewModel]
  }
  return o
}

/** What a section is compared by: a `ui.<field>` dependency compares that one field. */
function serialise(vm: ViewModel, fields: SectionField[]): string {
  const o: Record<string, unknown> = {}
  for (const f of fields) {
    o[f] = f.startsWith(UI_FIELD)
      // A payload from a build that had no UI state is a view like any other here: the
      // provider states an absence, it does not throw the panel away over one field.
      ? (vm.ui as unknown as Record<string, unknown> | undefined)?.[uiField(f)]
      : vm[f as keyof ViewModel]
  }
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
  /* Mixed from the foreground, not taken from a theme colour: editorWidget.background is the
     sidebar background itself in the light themes, and a track that equals the page is no
     track at all. A share of the foreground contrasts by construction in either theme. */
  --track: color-mix(in srgb, var(--vscode-foreground) 14%, transparent);
  /* The same reasoning for the hairlines: panel.border is #e5e5e5 on white. */
  --rule: color-mix(in srgb, var(--vscode-foreground) 28%, transparent);
  --line: var(--vscode-panel-border, rgba(127,127,127,.3));
  --dim: var(--vscode-descriptionForeground);
  --bg: var(--vscode-sideBar-background, var(--vscode-editor-background, transparent));
}
body {
  font-family: var(--vscode-font-family); font-size: var(--vscode-font-size);
  color: var(--vscode-foreground); padding: 10px 12px 24px; margin: 0;
  /* A path or an id with no break opportunity ("~/.cache/codex-usage/state.json") must break
     rather than widen the page: the real host showed a sidebar scrolling sideways by the width
     of one such token in the data-quality list. Only tokens that would overflow are affected. */
  overflow-wrap: anywhere;
}
h2 { font-size: 11px; text-transform: uppercase; letter-spacing: .08em; color: var(--dim);
     margin: 20px 0 8px; font-weight: 600; }
h2:first-child { margin-top: 0; }
/* The page's rhythm lives on the sections, not on the headings inside them: a hairline and a
   fixed gap above every section, which is also the gap a folded one keeps — the sections used
   to run into each other, and a folded Summary glued itself to the filter bar. */
section { margin-top: 22px; padding-top: 10px; border-top: 1px solid var(--line); }
/* A section head is a <summary>: the fold is the browser's, which means it is keyboard
   reachable and announced as expandable without a word of ARIA from us. It is a flex row of
   its own so the chevron, the heading and the gear at its right end sit on one centre line
   and the row keeps a hand-sized height whatever the heading says. */
summary { list-style: none; cursor: pointer; display: flex; align-items: center; gap: 6px;
          min-height: 24px; }
summary::-webkit-details-marker { display: none; }
summary h2 { display: flex; align-items: center; gap: 6px; margin: 0; flex: 1 1 auto; }
/* Only while the body is there: a folded section's own margin is the whole gap. */
details[open] summary { margin-bottom: 8px; }
/* The twisty is drawn, not typed: a glyph in the markup would end up in the copied text. */
summary h2::before { content: "▾"; font-size: 9px; line-height: 1; opacity: .7; }
details:not([open]) summary h2::before { content: "▸"; }
summary:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: 1px; }
/* The gear at the end of a section header: quiet until it is wanted, and never a reason for
   the header to grow. 24 x 24 of target around the 16 px icon, because the whole summary row
   is the fold and a click three pixels off the gear would close the section instead of
   opening its settings; the negative margin keeps the header at its own height. */
.gear { background: none; border: none; padding: 4px; margin: -4px -2px; line-height: 0;
        color: inherit; opacity: .6; flex: none; }
.gear:hover, .gear:focus-visible { opacity: 1; background: none; }
.gear svg { display: block; }
p { margin: 6px 0; }
.empty { color: var(--dim); font-style: italic; }
.dim { color: var(--dim); }
.meta { color: var(--dim); font-size: 11px; }
.meta.warn { color: var(--warn); }
.card { margin-bottom: 14px; }
/* The two provider cards ran into one another; a hairline says where one ends. Scoped to the
   quota body, because a "card" elsewhere on the page is a row of a list that needs no rule. */
[data-body="quota"] .card + .card { border-top: 1px solid var(--line); padding-top: 10px; }
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
/* The popup of a <select> is drawn by the browser, not by this page, and it took its colours
   from the system rather than from the theme: light option text on a light system menu, which
   is a dropdown nobody could read. The options are given the theme's own dropdown colours, and
   the colour scheme is declared as well — that is the one thing the browser reads when it
   paints the popup's chrome. VS Code stamps the theme kind on the body; the high-contrast
   light class comes second on purpose, because the host sets it next to vscode-high-contrast
   and the later rule is the one that wins. */
body.vscode-dark, body.vscode-high-contrast { color-scheme: dark; }
body.vscode-light, body.vscode-high-contrast-light { color-scheme: light; }
select {
  background: var(--vscode-dropdown-background);
  color: var(--vscode-dropdown-foreground);
  border: 1px solid var(--vscode-dropdown-border, var(--line));
}
select option {
  background: var(--vscode-dropdown-background);
  color: var(--vscode-dropdown-foreground);
}
button[aria-pressed="true"] {
  background: var(--vscode-button-background, var(--track));
  color: var(--vscode-button-foreground, inherit);
  border-color: var(--vscode-button-background, var(--line));
}
input[type=date] { cursor: text; }
/* The filter bar is a labelled grid: one column for the row labels, one for the chips, so the
   chips of all three rows start at the same x and the bar reads as three lines rather than as
   a paragraph of buttons. A tinted block with a hairline around it, because it governs the
   sections below it instead of belonging to any one of them. */
.bar { display: grid; grid-template-columns: minmax(62px, max-content) 1fr auto;
       gap: 6px 8px; align-items: center; margin: 10px 0; padding: 8px;
       background: color-mix(in srgb, var(--vscode-foreground) 4%, transparent);
       border: 1px solid var(--line); border-radius: 4px; }
/* A row with nothing in the third column takes the width the refresh button leaves. */
.bar .span2 { grid-column: 2 / 4; }
/* The date fields are a line of their own, directly under the range they belong to. */
.bar .full { grid-column: 1 / 4; }
/* The caption ends the range row; a little air keeps it apart from the last chip. */
.bar .cap { margin-left: 2px; }
.icon { display: inline-flex; align-items: center; justify-content: center; line-height: 0;
        padding: 3px 5px; justify-self: end; }
.icon svg { display: block; }
.track { position: relative; height: 8px; border-radius: 4px; background: var(--track); }
.fill { height: 100%; border-radius: 4px; transition: width .3s ease; }
.fill.ok { background: var(--ok); }
.fill.warn { background: var(--warn); }
.fill.warn2 { background: var(--warn2); }
.fill.error { background: var(--error); }
.fill.extra { background: var(--claude); }
.fill.neutral { background: var(--dim); }
/* The pace gap, drawn into the bar itself. The elapsed marker stays where it is; what changes
   is the paint on either side of it. Fill beyond the marker is consumption ahead of the clock
   and wears the level's colour darkened, so the excess reads as a band even where the marker
   is hard to make out; track between the end of the fill and the marker is time the window
   still has in hand and is a stronger grey than the rest of the track — more foreground mixed
   in, which reads lighter on a dark theme and darker on a light one. */
.fill.over { position: absolute; top: 0; left: 0; border-radius: 0 4px 4px 0; }
.fill.over.ok { background: color-mix(in srgb, var(--ok) 65%, black); }
.fill.over.warn { background: color-mix(in srgb, var(--warn) 65%, black); }
.fill.over.warn2 { background: color-mix(in srgb, var(--warn2) 65%, black); }
.fill.over.error { background: color-mix(in srgb, var(--error) 65%, black); }
.slack { position: absolute; top: 0; left: 0; height: 100%; border-radius: 0 4px 4px 0;
         background: color-mix(in srgb, var(--vscode-foreground) 30%, transparent); }
.mark { position: absolute; top: -3px; bottom: -3px; width: 2px; margin-left: -1px;
        background: var(--vscode-foreground); opacity: .6; border-radius: 1px; }
.mark.fc { background: var(--warn); opacity: .9; border-radius: 0; width: 2px;
           border-top: 2px solid var(--vscode-foreground); }
/* A window label is one word to the reader: "7 d" must not be broken between the number and
   the unit, and neither must the provider in front of it. The only break left in a heading
   like "Claude Code · 7 d" is the separator itself. */
.nobr { white-space: nowrap; }
.win { margin-top: 8px; }
/* Label and reset on the left, the verdict beside them, the figure on the right — one row
   above the bar, so the card spends no line of its own on the verdict. A narrow sidebar wraps
   the row onto a second line; nothing in it is ever cut. */
.win-top { display: flex; flex-wrap: wrap; justify-content: space-between; align-items: baseline;
           gap: 0 8px; font-size: 11px; color: var(--dim); margin-bottom: 3px; }
/* The label wraps rather than clips: "GPT-5.3-Codex-Spark 5 h · resets 4h59m" cut to "…4h5" in a
   narrow sidebar loses the countdown, which is the one thing the header is for. */
.win-top span { min-width: 0; }
.win-top b { color: var(--vscode-foreground); font-variant-numeric: tabular-nums; flex: none;
             margin-left: auto; }
.verdict { color: var(--dim); overflow-wrap: anywhere; }
.verdict.warn, .verdict.warn2 { color: var(--warn); }
.verdict.error { color: var(--error); }
.scroll { overflow-x: auto; }
/* Only ever shown when the browser has measured a table wider than its box — a hint about
   columns that are all visible would be a lie. */
.scrollhint { margin: 2px 0 6px; }
table { border-collapse: collapse; width: 100%; font-size: 11px; font-variant-numeric: tabular-nums; }
th { text-align: right; font-weight: 500; color: var(--dim); padding: 3px 0 3px 8px;
     white-space: nowrap; border-bottom: 1px solid var(--line); }
th.sortable { cursor: pointer; }
th[aria-sort="ascending"]::after { content: " ▲"; }
th[aria-sort="descending"]::after { content: " ▼"; }
th:first-child, td:first-child { text-align: left; padding-left: 0; }
td { text-align: right; padding: 3px 0 3px 8px; white-space: nowrap; }
tr.more td { color: var(--dim); font-style: italic; text-align: left; }
.kpis { display: grid; grid-template-columns: repeat(auto-fit, minmax(120px, 1fr)); gap: 8px;
        margin-bottom: 8px; }
/* The card is the popover's containing block, so the explanation hangs under the very figure
   it explains. No z-index here on purpose: a stacking context on the card would trap the
   popover behind the cards that follow it in the grid. */
.kpi { border: 1px solid var(--line); border-radius: 4px; padding: 6px 8px; position: relative; }
.kpi .v { font-size: 15px; font-variant-numeric: tabular-nums; }
.kpi .l { font-size: 10px; color: var(--dim); text-transform: uppercase; letter-spacing: .06em; }
/* Deltas are coloured from the figure's polarity, never from the arrow: more usage and more
   money are warnings, a higher cache hit rate is good, and a count of days is neither. A red
   arrow that means "you worked on more days" is a judgement nobody asked for. */
.kpi .d.good { color: var(--ok); }
.kpi .d.bad { color: var(--warn); }
.kpi .d.neutral { color: var(--dim); }
/* What the figure counts, on hover and on focus. A native title would give one line after a
   delay, could not be reached by keyboard and would be unreadable in a screen reader; this is
   a real element, so the card can point at it with aria-describedby.
   The width is capped against the viewport as well as at 320 px: absolutely positioned
   overflow still widens the page, and a 320 px card in a 260 px sidebar is a sideways
   scrollbar over the whole dashboard. */
.pop { position: absolute; top: 100%; left: 0; z-index: 5; margin-top: 4px;
       min-width: 220px; max-width: min(320px, 90vw); padding: 6px 8px; font-size: 11px;
       line-height: 1.5; text-transform: none; letter-spacing: normal; white-space: normal;
       border-radius: 4px;
       background: var(--vscode-editorHoverWidget-background,
                   var(--vscode-editorWidget-background, var(--vscode-editor-background)));
       color: var(--vscode-editorHoverWidget-foreground, var(--vscode-foreground));
       border: 1px solid var(--vscode-editorHoverWidget-border,
               var(--vscode-editorWidget-border, var(--line)));
       box-shadow: 0 2px 8px rgba(0, 0, 0, .3); }
/* Measured at open time: a card in the right half would push its explanation off the page. */
.pop.right { left: auto; right: 0; }
.pop b { color: var(--dim); font-weight: 600; }
.pop div + div { margin-top: 2px; }
.spark { width: 100%; height: 18px; display: block; }
/* The quota sparkline is seven days in 15-minute slots and a little taller than the KPI ones,
   so the pace colours along it can be told apart. */
.spark.q { height: 22px; }
.spark polyline { fill: none; stroke: var(--claude); stroke-width: 1.2; vector-effect: non-scaling-stroke; }
/* Each segment wears the pace level the bar showed at its later point; a point with no clock
   keeps the provider colour, and so does the segment into the first reading after a reset —
   that fall is the window turning over, and colouring it would judge a pace nobody kept. */
.spark polyline.ok, .spark path.pt.ok { stroke: var(--ok); }
.spark polyline.warn, .spark path.pt.warn { stroke: var(--warn); }
.spark polyline.warn2, .spark path.pt.warn2 { stroke: var(--warn2); }
.spark polyline.error, .spark path.pt.error { stroke: var(--error); }
/* A bridge joins two readings with no reset between them across slots that have none — VS
   Code was not running — and is dashed, so it never claims a measurement that was not taken. */
.spark line.bridge { stroke: var(--dim); stroke-width: 1; stroke-dasharray: 3 3; opacity: .6;
                     vector-effect: non-scaling-stroke; }
/* A lone reading between two gaps is drawn as a hair-length stroke with a round cap: the
   viewBox is stretched to the card width, and any shape with a geometric size would be
   stretched with it — a 5 px dash that reads as a line where there is a single point. */
.spark path.pt { fill: none; stroke: var(--claude); stroke-width: 3; stroke-linecap: round;
                 vector-effect: non-scaling-stroke; }
/* The plot keeps a gutter on its right for the tick labels. Inside the plot they either hide
   behind the newest bars or, opaque, cut them into pieces that read as gaps in the data —
   and the newest days are the ones worth reading. Because those labels sit outside the box,
   the plot must not hide its overflow: an overflow rule here would cut every one of them off.
   240 px rather than the 120 px this started at — split six ways, a 120 px column turns every
   model but the largest into a hairline. */
.plot { position: relative; height: 240px; margin-top: 6px; margin-right: 38px;
        border-bottom: 1px solid var(--rule); }
.grid { position: absolute; left: 0; right: 0; border-top: 1px dashed var(--rule); z-index: 2;
        pointer-events: none; }
.grid span { position: absolute; left: 100%; top: 1px; margin-left: 4px; font-size: 9px;
             color: var(--dim); white-space: nowrap; }
.chart { display: flex; align-items: flex-end; gap: 2px; height: 100%; position: relative; }
.col { flex: 1; min-width: 0; height: 100%; display: flex; flex-direction: column;
       justify-content: flex-end; cursor: pointer; }
/* Positioned, so a label that spills into the neighbouring column is painted above that
   column's bar instead of behind it. Centred by a flex container rather than by text-align:
   a label wider than its column overflows to both sides that way, where text-align lets it
   start at the left edge and paint itself over the next column instead. */
.col .vlabel { font-size: 8px; color: var(--dim); white-space: nowrap;
               display: flex; justify-content: center;
               position: relative; text-shadow: 0 0 2px var(--bg), 0 0 2px var(--bg); }
/* An explicit display beats the browser's [hidden] rule, which is how fitChart thins. */
.col .vlabel[hidden] { display: none; }
.col .vlabel i { font-style: normal; }
.seg:first-of-type { border-radius: 2px 2px 0 0; }
/* A band is its provider's hue — Claude blue, Codex purple, the two colours the rest of the
   page uses — varied by the model's rank within that provider, so a column says "how much of
   each provider" at a glance and "which model" on a second look. A colour per model name would
   need a palette as long as the model list and would repeat itself the moment it ran out.
   The pattern style keeps the hue at 35 % as the ground and draws the rank as strokes in the
   full hue; the shade style steps the lightness instead; both draws the strokes over the
   shaded ground. The stroke pitch is 4 px in CSS pixels (2 on, 2 off) whatever the band's
   size, so a hairline band and a wide one hatch alike. The script's bandStyle() hands these
   classes out; nothing else picks a chart colour, and a legend swatch wears exactly the
   classes of its band. */
.hue-claude { --hue: var(--claude); }
.hue-codex { --hue: var(--codex); }
.r0 { --mix: 100%; }
.r1 { --mix: 78%; }
.r2 { --mix: 58%; }
.r3 { --mix: 42%; }
.r4 { --mix: 30%; }
.rother { --mix: 22%; }
.st-pattern { --ground: color-mix(in srgb, var(--hue) 35%, transparent); }
.st-shade, .st-both { --ground: color-mix(in srgb, var(--hue) var(--mix), var(--track)); }
.band { background: var(--ground); }
/* The largest model is the plain hue in every style: it is what the provider colour means. */
.band.r0 { background: var(--hue); }
.st-pattern.r1, .st-both.r1 { background: repeating-linear-gradient(45deg, var(--hue) 0 2px, var(--ground) 2px 4px); }
.st-pattern.r2, .st-both.r2 { background: repeating-linear-gradient(135deg, var(--hue) 0 2px, var(--ground) 2px 4px); }
.st-pattern.r3, .st-both.r3 { background: repeating-linear-gradient(45deg, var(--hue) 0 2px, transparent 2px 4px),
                                          repeating-linear-gradient(135deg, var(--hue) 0 2px, var(--ground) 2px 4px); }
.st-pattern.r4, .st-both.r4 { background: repeating-linear-gradient(0deg, var(--hue) 0 2px, var(--ground) 2px 4px); }
.st-pattern.rother, .st-both.rother { background: radial-gradient(var(--hue) 1px, var(--ground) 1.2px);
                                      background-size: 4px 4px; }
/* The faint end of the shade ramp is a few percent of hue against the plot, and two such
   steps are barely a step apart: a hairline in the full hue gives those bands an edge, so a
   4 px band still says where it starts and which provider it belongs to. Inset, so it costs
   the stack no pixel of height, and only where the fill alone is too weak — the patterned
   styles already draw the full hue across the band. */
.st-shade.r3, .st-shade.r4, .st-shade.rother { box-shadow: inset 0 0 0 1px var(--hue); }
/* Explicit width and height, because this is a replaced element: with inset alone the
   browser took the width from the box and the height from the viewBox's 1:1 ratio, which drew
   a 590 px tall cost line straight over the model table and the heatmap below it. The
   overflow is visible because the series is mapped onto the whole box — the maximum sits at
   y = 0 and a zero at y = 100 — where the browser's own rule for an inline SVG would cut the
   marker dot at the peak in half and square the apex of the line off. The plot does not clip
   either: its tick labels live in the gutter beside it. */
.costline { position: absolute; inset: 0; width: 100%; height: 100%; pointer-events: none;
            overflow: visible; }
/* The overlay is one line over a stack of coloured bands, so it wears none of their hues: the
   foreground is the one colour no band uses. It is drawn twice — a halo in the page's own
   background under a 2 px line — so it stays readable over a band of any hue or pattern, and
   both strokes are non-scaling, so their widths hold under the stretched viewBox. The dots sit
   in a second, unstretched SVG and take the line's colour. The legend's key for the line is
   the same three marks at swatch size, so it shares the rules. */
.key polyline, .costline polyline { fill: none; stroke: var(--vscode-charts-foreground, var(--vscode-foreground));
                     stroke-width: 2; vector-effect: non-scaling-stroke; }
.key polyline.halo, .costline polyline.halo { stroke: var(--vscode-sideBar-background, var(--vscode-editor-background));
                                             stroke-width: 4; }
.key circle, .costline circle { fill: var(--vscode-charts-foreground, var(--vscode-foreground)); }
.legend svg.key { width: 22px; height: 10px; overflow: visible; vertical-align: -1px; margin-right: 4px; }
.axis { display: flex; gap: 2px; font-size: 9px; color: var(--dim); margin-top: 3px; }
/* The chart's own axis shares the plot's gutter, so every day label stays under its column;
   the hour strip below has no gutter and keeps the plain rule. */
.plot + .axis { margin-right: 38px; }
/* Every slot keeps its width so the labels stay under their columns; the ones that are
   shown may spill into the empty slots beside them rather than wrap to a second line. The
   spill is centred on the slot — a label aligned to the slot's start ends up under its
   neighbour once it outgrows the slot, which is the column it does not describe. */
.axis span { flex: 1; min-width: 0; overflow: visible; white-space: nowrap;
             display: flex; justify-content: center; }
.axis span i { font-style: normal; white-space: nowrap; }
.legend { display: flex; flex-wrap: wrap; gap: 12px; font-size: 11px; color: var(--dim); margin-top: 6px; }
/* A group heading — the provider a run of swatches belongs to — takes a line of its own.
   Wrapped into the middle of a line it read as one more entry instead of as the label of
   the entries after it. Only the chart's legend has such a child. */
.legend > span.meta { flex-basis: 100%; }
.dot { display: inline-block; width: 8px; height: 8px; border-radius: 2px; margin-right: 4px; }
/* A chart swatch is bigger than the others: at 8 px a 4 px stripe pitch is two strokes, and
   two strokes are not a pattern anyone can match against a band. */
.legend .dot.band { width: 14px; height: 14px; }
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
/* Neutral by construction, because every hue on this page is already spoken for: blue is
   Claude, purple is Codex, and green/orange are the pace verdicts one card above. The
   remaining parts are told apart by weight and by texture instead of by borrowing one. */
.cs.c4, .dot.c4 { background: color-mix(in srgb, var(--vscode-foreground) 65%, transparent); }
.cs.c5, .dot.c5 { background: color-mix(in srgb, var(--vscode-foreground) 38%, transparent); }
.cs.c6, .dot.c6 { background: repeating-linear-gradient(45deg,
                  color-mix(in srgb, var(--vscode-foreground) 65%, transparent),
                  color-mix(in srgb, var(--vscode-foreground) 65%, transparent) 2px,
                  transparent 2px, transparent 4px); }
/* An explicit baseline, so an hour with no usage can be a gap rather than a 1 px rule that
   reads as one. */
.hours { display: flex; align-items: flex-end; gap: 2px; height: 60px;
         border-bottom: 1px solid var(--rule); }
.hours .hb { flex: 1; background: var(--claude); min-height: 3px; border-radius: 2px 2px 0 0; }
/* The marker for an hour with nothing in it has to be the shortest thing in the strip, or
   the emptiest hours read as the busiest ones: it is 1 px against a used hour's floor of
   3 px. Mixed from the foreground rather than taken from --track, because at one pixel a
   14 % tint on top of the baseline is not there at all in either theme. */
.hours .hb.none { background: color-mix(in srgb, var(--vscode-foreground) 45%, transparent);
                  min-height: 1px; border-radius: 0; }
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
  /* A stacked cell is a block of its own width, so the base "white-space: nowrap" (which keeps
     a real table's columns from breaking) turns a long value — the tools section's model list
     is the first one long enough to notice — into text running past the card. Nothing is lost,
     the wrapper still scrolls, but needing a sideways scroll to read one "label: value" line is
     exactly what the stacked layout exists to avoid. */
  td { text-align: left; padding: 1px 0; white-space: normal; }
  /* Only cells that carry a header: the sub-rows and the drill lines span the whole table
     and would otherwise be prefixed with a bare ": ". */
  td[data-h]::before { content: attr(data-h) ": "; color: var(--dim); }
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
/** Model chips beyond the first four, shown on request. Local: a chip is not a setting. */
let allModels = false;
/** The range presets beyond today / 7d / 30d, shown on request. Local for the same reason. */
let allRanges = false;
/** The two date fields, opened by the "custom…" chip. Also local — the range itself is not. */
let showDates = false;
/** The day the drill panel was last scrolled to, so a refresh of the same day stays put. */
let shownDrill = null;
const esc = (s) => String(s === null || s === undefined ? '' : s)
  .replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const post = (m) => vscode.postMessage(m);
const has = (k) => vm.sections.indexOf(k) >= 0;

function pct(v) { return Math.max(0, Math.min(100, Number(v) || 0)); }

/**
 * A bar with its marks. the gap flag paints the pace gap into it — the fill beyond the elapsed
 * marker darker, the track between the fill and the marker a stronger grey — and is only asked for by
 * a quota window that has a clock and a limit to compare against: a window that has just
 * reset, or one with no limit, has no gap to show. The marker itself never moves.
 */
function bar(percent, cls, elapsed, forecastEnd, aria, gap) {
  let h = '<div class="track" role="progressbar" aria-valuemin="0" aria-valuemax="'
    + (aria ? aria.max : 100) + '" aria-valuenow="' + (aria ? aria.now : Math.round(percent))
    + '" aria-valuetext="' + esc(aria ? aria.text : '') + '">'
    + '<div class="fill ' + cls + '" data-w="' + pct(percent).toFixed(2) + '"></div>';
  const clock = elapsed !== null && elapsed !== undefined;
  if (clock && gap) {
    const p = pct(percent), e = pct(elapsed);
    if (p > e) {
      h += '<span class="fill over ' + cls + '" data-x="' + e.toFixed(2) + '" data-w="'
        + (p - e).toFixed(2) + '" title="used beyond the elapsed share"></span>';
    } else if (e > p) {
      h += '<span class="slack" data-x="' + p.toFixed(2) + '" data-w="' + (e - p).toFixed(2)
        + '" title="elapsed share not yet used"></span>';
    }
  }
  if (clock) {
    h += '<i class="mark" data-x="' + pct(elapsed).toFixed(2) + '" title="time elapsed in this window"></i>';
  }
  if (forecastEnd !== null && forecastEnd !== undefined) {
    h += '<i class="mark fc" data-x="' + pct(forecastEnd).toFixed(2) + '" title="projected at the reset"></i>';
  }
  return h + '</div>';
}

/** The pace levels a sparkline segment can wear; anything else keeps the provider colour. */
var SPARK_LEVELS = ['ok', 'warn', 'warn2', 'error'];

function sparkLevel(pt) {
  return SPARK_LEVELS.indexOf(pt.level) >= 0 ? pt.level : '';
}

/** True when there is a line to draw: two array values, or one point of a slotted spark. */
function hasSpark(s) {
  if (Array.isArray(s)) return s.length > 1;
  return !!(s && Array.isArray(s.points) && s.points.length > 0);
}

/**
 * Seven days of one window, time-proportional: the viewBox is one unit per 15-minute slot,
 * so a stretch without readings is exactly as wide as the time it covers. Runs of adjacent
 * slots become polylines, split wherever the pace level changes — the segment between two
 * points wears the level of the later one, except into a point the view model marked as the
 * first reading of a new window, which is a neutral two-point stroke — and a bridge across
 * slots with no reading is a dashed line. A lone reading is the round-cap hairline.
 * Percentages above 100 sit on the top edge rather than leaving the box. A plain array (the
 * KPI sparks) takes the older renderer.
 */
function sparkSvg(spark) {
  if (Array.isArray(spark)) return sparkArraySvg(spark);
  if (!spark || !Array.isArray(spark.points)) return '';
  const W = Number(spark.slots);
  const pts = spark.points.filter(function (pt) {
    return !!pt && Number.isFinite(Number(pt.i)) && Number.isFinite(Number(pt.p));
  });
  if (!(W > 0) || !pts.length) return '';
  const H = 100;
  const xOf = pt => String(Math.round(Number(pt.i)));
  const yOf = pt => (H - pct(pt.p)).toFixed(1);
  const poly = (seg, cls) => '<polyline' + (cls ? ' class="' + cls + '"' : '') + ' points="'
    + seg.map(pt => xOf(pt) + ',' + yOf(pt)).join(' ') + '"/>';
  let body = '';
  let run = [];
  const flush = () => {
    if (run.length === 1) {
      const cls = sparkLevel(run[0]);
      body += '<path class="pt' + (cls ? ' ' + cls : '') + '" d="M' + xOf(run[0]) + ' '
        + yOf(run[0]) + 'h.01"/>';
    } else if (run.length > 1) {
      // One stroke per pair of neighbours, wearing the level of the later point, so equal
      // neighbours share a polyline. A stroke into the first reading of a new window stands
      // alone and wears no level: the drop is the reset, and the coloured run starts again
      // at that reading.
      const segs = [];
      for (let k = 1; k < run.length; k++) {
        const isReset = !!run[k].reset;
        const cls = isReset ? '' : sparkLevel(run[k]);
        const last = segs.length ? segs[segs.length - 1] : null;
        if (last && !last.reset && !isReset && last.cls === cls) last.pts.push(run[k]);
        else segs.push({ cls: cls, reset: isReset, pts: [run[k - 1], run[k]] });
      }
      for (const sg of segs) body += poly(sg.pts, sg.cls);
    }
    run = [];
  };
  for (const pt of pts) {
    if (run.length && Number(pt.i) - Number(run[run.length - 1].i) !== 1) flush();
    run.push(pt);
  }
  flush();
  const byI = Object.create(null);
  for (const pt of pts) byI[Number(pt.i)] = pt;
  for (const b of Array.isArray(spark.bridges) ? spark.bridges : []) {
    const a = b ? byI[Number(b.from)] : null;
    const z = b ? byI[Number(b.to)] : null;
    if (!a || !z) continue;
    body += '<line class="bridge" x1="' + xOf(a) + '" y1="' + yOf(a) + '" x2="' + xOf(z)
      + '" y2="' + yOf(z) + '"/>';
  }
  return '<svg class="spark q" viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="none" '
    + 'aria-hidden="true">' + body + '</svg>';
}

/** A list of 0..100 values evenly spaced, with -1 for a break: the KPI sparks. */
function sparkArraySvg(values) {
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
    ? '<path class="pt" d="M' + s[0].split(',')[0] + ' ' + s[0].split(',')[1] + 'h.01"/>'
    : '<polyline points="' + s.join(' ') + '"/>').join('');
  return '<svg class="spark" viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="none" '
    + 'aria-hidden="true">' + body + '</svg>';
}

// -- words ------------------------------------------------------------------

/** The provider titles, interpolated from the registry so the webview cannot drift from it. */
const SRC_TITLE = ${JSON.stringify(SOURCE_TITLE)};

/**
 * An own-property lookup with a string result. A bare map[key] answers "constructor" with a
 * function, and a stray key must never turn into markup.
 */
function word(map, key) {
  return typeof map[key] === 'string' ? map[key] : '';
}

/** The provider as the reader knows it; an unknown source keeps whatever it is called. */
function srcName(source) {
  return word(SRC_TITLE, source) || String(source === null || source === undefined ? '' : source);
}

/**
 * "5 h" alone is ambiguous the moment both providers have one. The title goes in front of
 * every window label that stands on its own — cards, list items, table rows — and each part
 * is its own unbreakable span, so a 300 px sidebar breaks such a heading at the separator
 * rather than between the "7" and the "d" of the label itself.
 */
function srcLabel(source, label) {
  const l = label === null || label === undefined ? '' : String(label);
  const t = word(SRC_TITLE, source);
  const parts = [];
  if (t) parts.push(t);
  if (l) parts.push(l);
  return parts.map(p => '<span class="nobr">' + esc(p) + '</span>').join(' · ');
}

/**
 * The window states in words, for the fallback below and nowhere else. The map has no
 * fallback of its own on purpose — an unknown state prints nothing rather than leaking an
 * identifier into the sentence — and "resetDue" is deliberately absent from it: the reset
 * line is the one place that says a window has reset, and a card that said it twice, once in
 * its header and once beside the verdict, is what this pair of helpers exists to prevent.
 */
const DISPLAY_WORD = {
  normal: '', exhausted: 'exhausted', overflow: 'over the limit', unlimited: 'unlimited',
  limitReached: 'limit reached',
};

/**
 * resetLine and stateText are worded once, in the view model, so this card, the QuickPick
 * and the markdown view cannot say the same window differently. The two functions below are
 * only the fallback for a payload from a build that predates those fields; they follow the
 * same rules and say nothing the view model would not.
 */
function fbResetLine(w) {
  if (w.display === 'resetDue') return 'reset due';
  const r = w.reset === null || w.reset === undefined ? '' : String(w.reset);
  if (!r) return '';
  // A reset text that already says the window has reset is a sentence, not a duration.
  return r.indexOf('reset due') >= 0 ? r : 'resets ' + r;
}

function fbStateText(w) {
  const s = word(DISPLAY_WORD, w.display);
  if (!s) return '';
  const said = w.verdict && typeof w.verdict.text === 'string' ? w.verdict.text : '';
  return said.toLowerCase().indexOf(s) >= 0 ? '' : s;
}

/** A string the view model carries, or the fallback when this payload has none. */
function orElse(value, fallback) {
  return typeof value === 'string' ? value : fallback;
}

// -- controls ---------------------------------------------------------------

/** Chips beyond this many are folded away; four is what fits a sidebar on one line. */
const MODEL_CHIPS = 4;
/** The ranges that are always on the bar. The rest are one chip away. */
const RANGE_CHIPS = ['today', '7d', '30d'];

/**
 * The two icons the bar draws. Inline SVG on purpose: the page loads nothing from anywhere,
 * so an icon font is not an option — and a glyph typed into the markup would end up in the
 * copied text of the page.
 */
const ICON_REFRESH = '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" focusable="false">'
  + '<path fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" d="M11.2 4.2A5 5 0 0 1 6.8 12.9"/>'
  + '<path fill="currentColor" d="M5.5 12.3L6.4 14.6L7.2 11.1Z"/>'
  + '<path fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" d="M4.8 11.8A5 5 0 0 1 9.2 3.1"/>'
  + '<path fill="currentColor" d="M10.5 3.7L9.6 1.4L8.8 4.9Z"/></svg>';
const ICON_GEAR = '<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" focusable="false">'
  + '<path fill="currentColor" fill-rule="evenodd" d="M14.8 6.4L14.8 9.6L12.9 9.6L12.5 10.3'
  + 'L13.9 11.7L11.7 13.9L10.3 12.5L9.6 12.9L9.6 14.8L6.4 14.8L6.4 12.9L5.7 12.5L4.3 13.9'
  + 'L2.1 11.7L3.5 10.3L3.1 9.6L1.2 9.6L1.2 6.4L3.1 6.4L3.5 5.7L2.1 4.3L4.3 2.1L5.7 3.5'
  + 'L6.4 3.1L6.4 1.2L9.6 1.2L9.6 3.1L10.3 3.5L11.7 2.1L13.9 4.3L12.5 5.7L12.9 6.4Z'
  + 'M5.7 8A2.3 2.3 0 1 0 10.3 8A2.3 2.3 0 1 0 5.7 8Z"/></svg>';

/** The gear that opens the settings this section is made of. */
function gear(key) {
  return '<button class="gear" data-act="sectionSettings" data-key="' + esc(key)
    + '" aria-label="Settings for this section" title="Settings for this section">'
    + ICON_GEAR + '</button>';
}

/**
 * The filter bar: a labelled grid of three rows — range, providers, models — with the labels
 * in a column of their own, so the chips line up under each other instead of running on as
 * one paragraph of buttons. Everything it decides is view state; nothing here is a setting.
 */
function controls() {
  const r = vm.range;
  // A selected preset is never folded away, the way a filtered-on model is not: a chip the
  // reader cannot see is a range they cannot leave.
  const presets = r.presets.filter(p => allRanges || RANGE_CHIPS.indexOf(p) >= 0 || r.preset === p);
  const restRanges = r.presets.length - presets.length;
  const chips = presets.map(p => '<button data-act="range" data-preset="' + p + '" aria-pressed="'
    + (r.preset === p) + '">' + esc(p) + '</button>').join('');
  const providers = ['claude', 'codex'].map(s => '<button data-act="provider" data-src="' + s
    + '" aria-pressed="' + (vm.ui.providers.indexOf(s) >= 0) + '">' + esc(srcName(s))
    + '</button>').join('');
  // The table splits main and sub-agent rows per model; the filter does not, so the same
  // name would otherwise appear twice as two chips that toggle the same thing.
  const names = [];
  for (const m of vm.models.rows || []) {
    if (names.indexOf(m.model) < 0) names.push(m.model);
    if (names.length >= 12) break;
  }
  // The table is filtered by the very chips this row draws, so a model filtered down to
  // nothing in this range has no row to take its name from. Its chip is added anyway: a
  // filter with no chip is a filter the reader cannot see and cannot switch off, and the
  // sections would go on saying "no data in this range" about a range that has plenty.
  for (const n of vm.ui.models) if (names.indexOf(n) < 0) names.push(n);
  // Beyond four the row is one chip until it is asked for — a dozen model names is the widest
  // thing on the bar. A filtered-on model stays visible whatever the fold says.
  const many = names.length > MODEL_CHIPS;
  const openRow = !many || allModels;
  const shown = names.filter(n => openRow || vm.ui.models.indexOf(n) >= 0);
  const models = (openRow ? '' : '<button data-act="moreModels">models (' + names.length + ') ▾</button>')
    + shown.map(name => '<button data-act="model" data-model="'
      + esc(name) + '" aria-pressed="' + (vm.ui.models.indexOf(name) >= 0) + '">'
      + esc(name) + '</button>').join('')
    + (vm.ui.models.length ? '<button data-act="clearModels">clear</button>' : '')
    + (openRow && many ? '<button data-act="moreModels">fewer ▴</button>' : '');
  // The two date fields are the rarest control on the page and the widest; they stay folded
  // until the range is one they belong to, or until the reader asks for them.
  const custom = r.preset === 'custom' || r.preset === 'all' || showDates;
  const dates = custom
    ? '<div class="wrap full"><label class="meta" for="tp-from">from</label>'
      + '<input id="tp-from" type="date" data-role="from" value="' + esc(r.from) + '">'
      + '<label class="meta" for="tp-to">to</label>'
      + '<input id="tp-to" type="date" data-role="to" value="' + esc(r.to) + '">'
      + '<button data-act="customRange">apply</button></div>'
    : '';
  return '<div class="bar">'
    + '<span class="meta">Range</span>'
    + '<div class="wrap">' + chips
    + '<button data-act="customDates" aria-pressed="' + custom + '">custom…</button>'
    + (restRanges > 0 ? '<button data-act="moreRanges">more ▾</button>' : '')
    + (allRanges && r.presets.length > RANGE_CHIPS.length
       ? '<button data-act="moreRanges">fewer ▴</button>' : '')
    // The range in words ends the row it belongs to rather than taking a line of its own.
    + '<span class="meta cap">' + esc(r.label) + ' · ' + esc(r.from) + ' → ' + esc(r.to)
    + '</span></div>'
    + '<button class="icon" data-act="refresh" aria-label="Refresh"'
    + ' title="Rebuild from the transcripts and fetch the quota">' + ICON_REFRESH + '</button>'
    + dates
    + '<span class="meta">Providers</span><div class="wrap span2">' + providers + '</div>'
    + (names.length ? '<span class="meta">Models</span><div class="wrap span2">' + models + '</div>' : '')
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
    // planText already carries the word "plan" and, for a name out of the settings, the
    // "(as configured)" that keeps it apart from something a provider said.
    + [q.planText ? esc(q.planText) : '', q.origin ? esc(q.origin) : '',
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
    const reset = orElse(w.resetLine, fbResetLine(w));
    const state = orElse(w.stateText, fbStateText(w));
    // A window still measuring has no pace to report; the sentence that said so at length
    // ("measuring · window just reset") is not printed anywhere.
    const said = w.verdict && !w.verdict.measuring && typeof w.verdict.text === 'string'
      ? w.verdict.text : '';
    const verdict = [said ? (w.level === 'ok' ? '' : '▲ ') + esc(said) : '', esc(state)]
      .filter(Boolean).join(' · ');
    // The verdict goes into the header row, between the label and the figure, so the card
    // spends no line of its own on it; the elapsed marker and the darker fill beyond it say
    // the same thing in the bar underneath.
    h += '<div class="win"><div class="win-top"><span>' + esc(w.label)
      + (reset ? ' · ' + esc(reset) : '') + '</span>'
      + (verdict ? '<span class="verdict ' + esc(w.level) + '">' + verdict + '</span>' : '')
      + '<b>' + esc(w.percentText) + '</b></div>'
      + bar(w.percent, w.display === 'resetDue' ? 'neutral' : w.level, w.elapsed, end, w.aria,
            w.display !== 'resetDue' && w.display !== 'unlimited');
    // A forecast that only repeats a word the card has already printed — in the verdict, in
    // the state beside it or in the reset line — is not a second fact. A "full" forecast on a
    // window that has just reset is dropped for a second reason: the reading it is built on
    // belongs to the window before the reset, which is why the bar is neutral, not red. A
    // forecast still measuring has nothing to say about the window yet and is not a line.
    const trusted = !(w.display === 'resetDue' && f && f.state === 'full')
      && !(f && f.state === 'measuring');
    // Word for word against each line already on the card, never as a substring: a forecast
    // that merely contains a word said above it is still a sentence of its own.
    const printed = [said.toLowerCase(), state.toLowerCase(), reset.toLowerCase()];
    if (f && f.text && trusted && printed.indexOf(f.text.toLowerCase()) < 0) {
      h += '<div class="meta">' + esc(f.text) + '</div>';
    }
    if (hasSpark(w.spark)) h += sparkSvg(w.spark);
    h += '</div>';
  }
  // The sparklines' span, said once per card rather than under each of them. Only the slotted
  // spark covers seven days; a payload from a build that still sends the 24-hour list gets no
  // caption that would misstate it.
  if (q.windows.some(w => w.spark && !Array.isArray(w.spark) && hasSpark(w.spark))) {
    h += '<div class="meta">sparkline: last 7 days</div>';
  }
  if (q.extra) {
    h += '<div class="win"><div class="win-top"><span>Extra usage'
      + (q.extra.billed ? ' (billed)' : '') + '</span><b>' + esc(q.extra.text) + '</b></div>'
      + (q.extra.utilization === null ? ''
         : bar(q.extra.utilization, 'extra', null, null,
               { now: Math.round(q.extra.utilization), max: 100, text: q.extra.text }))
      + '</div>';
  }
  // Only ever present when the provider reported no window at all. It is a count, not a
  // window: no bar, no percentage, no pace — the sentence itself says what it is not.
  if (q.localBlock) h += '<div class="box info" role="status">' + esc(q.localBlock.text) + '</div>';
  // The card header already says how old the reading is; the full freshness row and the
  // official page stay in the markdown view, where there is room for them, and the tooltip
  // links the official page from the provider name.
  return h + '</div>';
}

/**
 * The problem kinds the two exits below actually repair. A card that failed for any other
 * reason — offline, a rejected token, a retry pending — keeps its own problem box: offering
 * "fetch it now" to a window that is already fetching, or the status line to a token the
 * provider refused, would name an exit that leads nowhere.
 */
var INVITE_KINDS = ['consentPending', 'modeCache', 'quotaOff', 'noFile', 'unknown'];

/**
 * No reading at all. The manager always builds one card per provider, so "no cards" is not
 * the state a user is in: what they see is a card per provider with nothing in it. Both are
 * the same situation and both end here — every card carries no window, no extra usage and a
 * problem one of the two exits repairs.
 */
function noReadingYet() {
  if (!vm.quotas.length) return true;
  return vm.quotas.every(function (q) {
    return (!q.windows || !q.windows.length) && !q.extra && !!q.problem
      && INVITE_KINDS.indexOf(q.problemKind || 'unknown') >= 0;
  });
}

/**
 * A state with two exits, and naming them is the whole point: nothing here invents a
 * percentage, it says how one could be read. What each provider is waiting for is kept as a
 * line below, so the reason is not lost with the cards it replaces.
 */
function quotaInvitation() {
  const why = vm.quotas.map(function (q) {
    return q.problem ? esc(q.title) + ': ' + esc(q.problem) : '';
  }).filter(Boolean).join(' · ');
  return '<div class="box info" role="status">'
    + 'No quota reading yet. There are two ways to get one: fetch it from the provider, '
    + 'which asks for network access first, or connect the Claude Code status line, which '
    + 'mirrors the figures Claude Code already has on this machine.'
    + '<br><button data-act="cmd" data-id="tokenPace.refreshQuota">Fetch quota now</button> '
    + '<button data-act="cmd" data-id="tokenPace.connectStatusLine">Connect the status line</button>'
    + (why ? '<div class="meta">' + why + '</div>' : '')
    + '</div>';
}

function sQuota() {
  if (noReadingYet()) return quotaInvitation();
  return vm.quotas.map(quotaCard).join('')
    + '<div class="legend"><span><i class="dot time"></i>time elapsed</span>'
    + '<span><i class="dot fc"></i>projected at the reset</span></div>';
}

/**
 * One Claude Code session's context window.
 *
 * Deliberately not a quota card: no verdict, no pace, no forecast, and a dim bar rather than a
 * coloured one — a full context window is a fact about a conversation, not a warning about an
 * account. Without a window size there is no bar and no percentage at all, only the tokens.
 */
function sContext() {
  const c = vm.context;
  if (!c) {
    return '<p class="empty">No context reading. The Claude Code status line is what reports it.'
      + '<br><button data-act="cmd" data-id="tokenPace.connectStatusLine">'
      + 'Connect the status line</button></p>';
  }
  const age = [c.ageText ? 'updated ' + esc(c.ageText) : '', c.fresh ? '' : '⚠ stale']
    .filter(Boolean).join(' · ');
  let h = '<div class="card"><div class="row"><span class="name">Context window</span>'
    + '<span class="meta' + (c.fresh ? '' : ' warn') + '">' + age + '</span></div>'
    + '<div class="win"><div class="win-top"><span>' + esc(c.note) + '</span><b>'
    + esc(c.text) + '</b></div>';
  // A bar needs a denominator. With none, the tokens stand alone — a full-width bar would
  // claim the conversation is full, an empty one that it is empty.
  if (c.size !== null && c.percentText !== '–') {
    h += bar(pctOf(c), 'neutral', null, null,
      { now: Math.round(pctOf(c)), max: 100, text: 'context window: ' + c.text });
  }
  return h + '</div></div>';
}

/** The share the card draws, read back from the text the view model already rounded. */
function pctOf(c) {
  const n = parseFloat(String(c.percentText));
  return isFinite(n) ? n : 0;
}

/**
 * The colour of a delta, from the figure's polarity and from nothing else. An arrow with no
 * direction to judge — "new", a rounding dot, a figure that is neither good nor bad up — is
 * dim: a colour there would state a verdict the number does not carry.
 */
function deltaClass(k) {
  const p = k.polarity;
  const glyph = k.delta ? k.delta.glyph : '';
  if (p !== 'upGood' && p !== 'upBad') return 'neutral';
  if (glyph === '▲') return p === 'upGood' ? 'good' : 'bad';
  if (glyph === '▼') return p === 'upGood' ? 'bad' : 'good';
  return 'neutral';
}

/**
 * One labelled line of an explanation. An empty text writes nothing at all: a "Compared with"
 * with nothing behind it would announce a comparison that was never made.
 */
function popLine(label, text) {
  const t = text === null || text === undefined ? '' : String(text);
  return t ? '<div><b>' + esc(label) + '</b> ' + esc(t) + '</div>' : '';
}

/**
 * The card's own explanation, every word of it from the view model. The provider names are
 * the registry's, the same ones every other heading uses.
 *
 * Hidden until it is hovered or focused, and it stays in the markup either way: the card
 * points at it with aria-describedby, and an element that is written only on hover has no id
 * to point at.
 */
function kpiPop(k, id) {
  const e = k.explain;
  if (!e) return '';
  return '<div class="pop" role="tooltip" id="' + esc(id) + '" hidden>'
    + popLine('What', e.what)
    + popLine('How', e.how)
    + popLine('Period', e.period)
    + (e.compare ? popLine('Compared with', e.compare.against + ' · ' + e.compare.previous) : '')
    + (e.split
       ? popLine('Split', srcName('claude') + ' ' + e.split.claude + ' · '
         + srcName('codex') + ' ' + e.split.codex)
       : '')
    + popLine('Basis', e.provenance)
    + popLine('Spark', e.sparkNote)
    + '</div>';
}

function sKpis() {
  return '<div class="kpis">' + vm.kpis.map(k => {
    const d = k.delta
      ? '<span class="d ' + deltaClass(k)
        + '">' + [k.delta.glyph, k.delta.text].filter(Boolean).map(esc).join(' ') + '</span>'
      : '';
    // Focusable, because an explanation only a mouse can reach is not an explanation. No
    // title attribute beside it: two tooltips over one card is one of them too many.
    const id = 'pop-' + String(k.key);
    return '<div class="kpi" tabindex="0" aria-describedby="' + esc(id) + '">'
      + '<div class="l">' + esc(k.label) + '</div><div class="v">' + esc(k.value) + '</div>'
      + '<div class="meta">' + d + '</div>' + sparkSvg(normSpark(k.spark))
      + kpiPop(k, id) + '</div>';
  }).join('') + '</div>';
}

/** KPI sparks are absolute values; the shared renderer wants 0..100. */
function normSpark(values) {
  const max = Math.max.apply(null, values.concat([0]));
  return max > 0 ? values.map(v => (v / max) * 100) : values.map(() => 0);
}

/**
 * Why a row is marked. Worded once, here and in the markdown view, because the two views
 * print the same table and a caveat phrased twice is read as two different caveats.
 */
const APPROX_NOTE = '≈ marks a lower bound: the oldest hours of the span are already rolled up into day totals';

function totalsTable(t) {
  const cost = vm.showCost;
  const head = ['Period', 'Usage', 'Fresh in', 'Write 5m', 'Write 1h', 'Cache read', 'Output',
    'Reasoning', 'Req.', 'Hit', 'Per req.'].concat(cost ? ['API cost'] : []);
  const rows = t.rows.map(r => '<tr>'
    // The span is the tooltip of the label, not a column: the two window rows are the only
    // ones whose bounds are not already spelled out by their name.
    + '<td data-h="Period" title="' + esc(r.spanText || '') + '">' + esc(r.label) + '</td>'
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
  const approx = t.rows.some(r => r.approx);
  return '<div class="card"><div class="name">' + esc(t.title) + '</div><div class="scroll"><table>'
    + '<thead><tr>' + head.map(h => '<th>' + esc(h) + '</th>').join('') + '</tr></thead>'
    + '<tbody>' + rows + '</tbody></table></div>'
    + (approx ? '<div class="meta">' + esc(APPROX_NOTE) + '</div>' : '') + '</div>';
}

/** Where the tokens of a period went — the six counted fields as one bar. */
/** A fixed colour per field, so the same part keeps its colour across providers and updates. */
const PART_CLASS = {
  freshInput: 'c1', cacheWrite5m: 'c2', cacheWrite1h: 'c3', cacheRead: 'c4', output: 'c5',
  reasoning: 'c6',
};

/** The three parts the cache chip puts aside; everything else is always drawn. */
const CACHE_PARTS = ['cacheRead', 'cacheWrite5m', 'cacheWrite1h'];

/** A round token count, the way every composition tooltip and caption prints one. */
function fullNum(n) {
  return Math.round(n).toLocaleString('en-US');
}

/** 'noCache' only when the view model says so; anything else is the full mix. */
function cacheMode() {
  return vm.ui && vm.ui.compositionCache === 'noCache' ? 'noCache' : 'all';
}

/**
 * One switch for both bars. Cache reads are an order of magnitude larger than the rest on a
 * normal day, which leaves the other five parts as hairlines; hiding them is the only way to
 * read the mix, and the caption under each bar names what was set aside so the shares cannot
 * be mistaken for shares of everything.
 */
function cacheChips() {
  const mode = cacheMode();
  const chip = (value, label) => '<button data-act="compositionCache" data-mode="' + value
    + '" aria-pressed="' + (mode === value) + '">' + label + '</button>';
  return '<div class="row"><span class="meta">cache</span><span class="wrap">'
    + chip('all', 'shown') + chip('noCache', 'hidden') + '</span></div>';
}

function compositionBar(c) {
  const noCache = cacheMode() === 'noCache';
  // Reasoning is a subset of output; adding it as its own slice would count it twice.
  const counted = c.parts.filter(p => p.key !== 'reasoning' && p.tokens > 0);
  const parts = noCache ? counted.filter(p => CACHE_PARTS.indexOf(p.key) < 0) : counted;
  // The shares are shares of what is drawn. A bar that kept the old denominator would not
  // add up to its own width, which is why the caption below states what is missing.
  const total = parts.reduce((s, p) => s + p.tokens, 0);
  if (!total) return '';
  const cls = (p) => PART_CLASS[p.key] || 'c6';
  const segs = parts.map(p => '<i class="cs ' + cls(p) + '" data-w="'
    + ((p.tokens / total) * 100).toFixed(2) + '" title="' + esc(p.text) + ': '
    + fullNum(p.tokens) + ' · ' + Math.round((p.tokens / total) * 100) + ' %"></i>').join('');
  const sum = (keys) => c.parts.reduce((s, p) => s + (keys.indexOf(p.key) >= 0 ? p.tokens : 0), 0);
  // Only the halves that were really set aside are named: a provider that never writes cache
  // would otherwise be told a "0 cache write" the table beside it prints as a dash.
  const read = sum(['cacheRead']);
  const written = sum(['cacheWrite5m', 'cacheWrite1h']);
  const left = [];
  if (read > 0) left.push(fullNum(read) + ' tokens cache read');
  if (written > 0) left.push(fullNum(written) + (read > 0 ? '' : ' tokens') + ' cache write');
  const caption = noCache && left.length
    ? '<div class="meta">without cache · ' + left.join(' and ') + ' not shown</div>'
    : '';
  return '<div class="meta">' + esc(srcName(c.source)) + ' composition</div>'
    + '<div class="compbar">' + segs + '</div>'
    + '<div class="legend">' + parts.map(p => '<span><i class="dot ' + cls(p) + '"></i>'
      + esc(p.text) + '</span>').join('') + '</div>'
    + caption;
}

function sTokens() {
  let h = vm.totals.map(totalsTable).join('');
  const bars = vm.composition.map(compositionBar).join('');
  // The switch belongs to the bars, but it must outlive the mode it sets: a range whose only
  // counted tokens are cache tokens draws no bar at all in 'hidden', and a switch that came
  // and went with the bars would take the way back with it.
  const anyParts = vm.composition.some(c => c.parts.some(p => p.key !== 'reasoning' && p.tokens > 0));
  if (bars || anyParts) h += cacheChips() + bars;
  if (vm.cacheEconomy.length) {
    h += '<div class="scroll"><table><thead><tr><th>Cache</th><th>Hit rate</th>'
      + '<th>Realised</th><th>Blended $/1M</th></tr></thead><tbody>'
      + vm.cacheEconomy.map(c => '<tr><td data-h="Cache">' + esc(srcName(c.source)) + '</td>'
        + '<td data-h="Hit rate">' + esc(c.hitRate) + '</td><td data-h="Realised">'
        + esc(c.savedUsd) + (c.partial ? ' ⚠' : '') + '</td><td data-h="Blended">'
        + esc(c.blendedPerM) + '</td></tr>').join('')
      + '</tbody></table></div>'
      + '<div class="meta">' + esc(vm.cacheEconomy[0].note) + '</div>';
  }
  const cal = vm.calendar;
  h += '<div class="scroll"><table><thead><tr><th>Period</th><th>Usage</th>'
    + (vm.showCost ? '<th>API cost</th>' : '') + '<th>Req.</th><th>Active</th><th>Avg/day</th>'
    + '</tr></thead><tbody>'
    + [cal.thisWeek, cal.thisMonth, cal.lastMonth, cal.year].map(p => '<tr>'
      + '<td data-h="Period">' + esc(p.label) + '</td><td data-h="Usage">' + esc(p.usage) + '</td>'
      + (vm.showCost ? '<td data-h="API cost">' + esc(p.cost) + '</td>' : '')
      + '<td data-h="Req.">' + esc(p.requests) + '</td><td data-h="Active">' + p.activeDays
      + '</td><td data-h="Avg/day">' + esc(p.avgPerDay) + '</td></tr>').join('')
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

/**
 * The classes one band is painted with: the provider's hue, the model's rank within that
 * provider and the style the setting chose. The one place a chart colour is decided — the
 * bands and the legend swatches call it alike, so a swatch shows exactly the fill of its band.
 */
function bandStyle(source, rank, style) {
  const st = style === 'shade' || style === 'both' ? style : 'pattern';
  return 'band s-' + source + '-' + rank + ' hue-' + source + ' r' + rank + ' st-' + st;
}

/** The legend's key for the cost line: the halo, the line and one dot, at swatch size. */
const COST_KEY = '<svg class="key" viewBox="0 0 22 10" aria-hidden="true">'
  + '<polyline class="halo" points="1,8 8,3 14,6 21,2"/>'
  + '<polyline class="line" points="1,8 8,3 14,6 21,2"/><circle cx="8" cy="3" r="2.5"/></svg>';

function sChart() {
  const c = vm.chart;
  if (!c.days.length) return '<p class="empty">No data in this range.</p>';
  const metrics = ['usage', 'output', 'cacheRead', 'requests', 'reasoning', 'cost'];
  const sel = '<select data-act="metric" aria-label="chart metric">'
    + metrics.map(m => '<option value="' + m + '"' + (c.metric === m ? ' selected' : '') + '>'
      + esc(m) + '</option>').join('') + '</select>';
  const totals = c.days.map((_, i) => c.series.reduce((s, x) => s + x.values[i], 0));
  // A provider's column total, summed from the same bands the column is drawn from.
  const subtotals = {};
  c.series.forEach(s => {
    const sub = subtotals[s.source] || (subtotals[s.source] = c.days.map(() => 0));
    s.values.forEach((v, i) => { sub[i] += v; });
  });
  const unit = c.weekly ? 'week' : 'day';
  const showValues = c.days.length <= 31;
  const cols = c.days.map((d, i) => {
    const segs = c.series.map(s => {
      const v = s.values[i];
      if (v <= 0) return '';
      // The tooltip names the band the way the legend does — model and provider — and reads
      // its share and its provider's total off the very values the bands are drawn from:
      // nothing is measured a second time here, only divided.
      const share = Math.round((v / totals[i]) * 1000) / 10;
      return '<div class="seg ' + bandStyle(s.source, s.rank, c.modelStyle) + '" data-bh="'
        + ((v / c.max) * 100).toFixed(2)
        + '" title="' + esc(s.label + ' · ' + srcName(s.source) + ' · ' + fullNum(v) + ' · ' + share
          + ' % of the ' + unit + ' · ' + srcName(s.source) + ' total ' + fullNum(subtotals[s.source][i]))
        + '"></div>';
    }).join('');
    return '<div class="col" data-act="drill" data-day="' + esc(d) + '" tabindex="0" role="button" '
      + 'title="' + esc(d + ': ' + fullNum(totals[i])) + '">'
      + (showValues && totals[i] > 0
         ? '<span class="vlabel" data-i="' + i + '"><i>' + esc(short(totals[i]))
            + '</i></span>' : '')
      + segs + '</div>';
  }).join('');
  const grids = c.ticks.map((t, i) => '<div class="grid" data-b="' + ((i + 1) * 25)
    + '"><span>' + esc(short(t)) + '</span></div>').join('');
  let overlay = '';
  if (costLine && c.costLine) {
    const cmax = Math.max.apply(null, c.costLine.concat([0])) || 1;
    const n = c.costLine.length;
    // One point per column, at the column's centre. The columns are n equal flex items with a
    // 2 px gap between them, so the centre of column i sits at (i + 0.5) / n of the plot width
    // give or take a fraction of one gap — nothing an eye can see against a 2 px line.
    const xs = c.costLine.map((_, i) => (((i + 0.5) / n) * 100).toFixed(1));
    const ys = c.costLine.map(v => (100 - (v / cmax) * 100).toFixed(1));
    const pts = xs.map((x, i) => x + ',' + ys[i]).join(' ');
    // The line is drawn twice in one stretched viewBox — the halo first, then the line — and
    // the dots go into a second SVG with no viewBox: placed by percentages of the same box, a
    // circle there is measured in pixels and stays round, where the stretched box would
    // squash it into an ellipse.
    overlay = '<svg class="costline" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">'
      + '<polyline class="halo" points="' + pts + '"/>'
      + '<polyline class="line" points="' + pts + '"/></svg>'
      + '<svg class="costline dots" aria-hidden="true">'
      + xs.map((x, i) => '<circle cx="' + x + '%" cy="' + ys[i] + '%" r="2.5"/>').join('')
      + '</svg>';
  }
  // Every label is rendered and carries its own text; which of them survive is decided by
  // fitChart once the browser knows how wide a column actually is.
  const labels = c.labels.map((l, i) => '<span data-i="' + i + '" data-l="' + esc(l) + '"><i>'
    + esc(l) + '</i></span>').join('');
  // The legend is grouped by provider — its name, then its bands in rank order — and every
  // swatch wears the classes of its band, so the pattern in the key is the pattern in the bar.
  let legend = '';
  let group = null;
  c.series.forEach(s => {
    if (s.source !== group) {
      group = s.source;
      legend += '<span class="meta">' + esc(srcName(s.source)) + '</span>';
    }
    legend += '<span><i class="dot ' + bandStyle(s.source, s.rank, c.modelStyle) + '"></i>'
      + esc(s.label) + '</span>';
  });
  return '<div class="row"><span class="meta">' + (c.weekly ? 'weekly bars' : 'daily bars')
    + ' · ' + c.days.length + ' columns</span><span class="wrap">' + sel
    + (c.costLine ? '<button data-act="costLine" aria-pressed="' + costLine + '">cost line</button>' : '')
    + '</span></div>'
    + '<div class="plot">' + grids + '<div class="chart">' + cols + '</div>' + overlay + '</div>'
    + '<div class="axis">' + labels + '</div>'
    + '<div class="legend">' + legend
    + (costLine && c.costLine ? '<span>' + COST_KEY + 'API cost (second axis)</span>' : '')
    + '<span>click a column for that day</span></div>';
}

function short(n) {
  const a = Math.abs(n);
  if (a >= 1e9) return (n / 1e9).toFixed(1) + 'G';
  if (a >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (a >= 1e3) return (n / 1e3).toFixed(1) + 'K';
  return String(Math.round(n * 100) / 100);
}

/**
 * The model table carries the same columns as the totals table, in the same order and with
 * the same words: a reader who has just read "Write 1h" over the whole range wants to know
 * which model wrote it, and a second table with a third of the columns cannot answer that.
 *
 * There is no Price column. What it held is not a figure but a provenance, and it now hangs
 * on the cost it qualifies: the tooltip of the API cost cell names the rates and where they
 * came from, an unpriced model's cost stays a dash, and a borrowed rate is marked ⚠ — the
 * same mark the footnote at the bottom of the page spells out.
 */
function sModels() {
  const m = vm.models;
  if (!m.rows.length) return '<p class="empty">No model data in this range.</p>';
  const cols = [['model', 'Model'], ['usage', 'Usage'], ['freshInput', 'Fresh in'],
    ['cacheWrite5m', 'Write 5m'], ['cacheWrite1h', 'Write 1h'], ['cacheRead', 'Cache read'],
    ['output', 'Output'], ['reasoning', 'Reasoning'], ['requests', 'Req.'], ['cacheHit', 'Hit'],
    ['perRequest', 'Per req.']]
    .concat(vm.showCost ? [['cost', 'API cost']] : []).concat([['share', 'Share']]);
  const head = cols.map(c => '<th class="sortable" data-act="sort" data-key="' + c[0] + '" tabindex="0"'
    + (m.sort.key === c[0] ? ' aria-sort="' + (m.sort.dir === 'asc' ? 'ascending' : 'descending') + '"' : '')
    + '>' + esc(c[1]) + '</th>').join('');
  const rows = m.rows.map(r => '<tr>'
    + '<td data-h="Model">' + esc(r.model) + (r.isSub ? ' <span class="meta">sub</span>' : '')
    + (r.tier !== 'standard' ? ' <span class="meta">' + esc(r.tier) + '</span>' : '') + '</td>'
    + '<td data-h="Usage">' + esc(r.usageText) + '</td>'
    + '<td data-h="Fresh in">' + esc(r.freshInput) + '</td>'
    + '<td data-h="Write 5m">' + esc(r.cacheWrite5m) + '</td>'
    + '<td data-h="Write 1h">' + esc(r.cacheWrite1h) + '</td>'
    + '<td data-h="Cache read">' + esc(r.cacheRead) + '</td>'
    + '<td data-h="Output">' + esc(r.output) + '</td>'
    + '<td data-h="Reasoning">' + esc(r.reasoning) + '</td>'
    + '<td data-h="Req.">' + esc(r.requests) + '</td>'
    + '<td data-h="Hit">' + esc(r.cacheHit) + '</td>'
    + '<td data-h="Per req.">' + esc(r.perRequest) + '</td>'
    + (vm.showCost ? '<td data-h="API cost" title="' + esc(r.price) + '">' + esc(r.costText)
        + (r.priced === 'family'
          ? ' <span title="priced from a related model (family fallback)">⚠</span>' : '')
      + '</td>' : '')
    + '<td data-h="Share">' + esc(r.share) + '</td>'
    + '</tr>' + (r.turnAvg
      ? '<tr><td colspan="99" class="meta">Avg turn ' + esc(r.turnAvg)
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
  const bars = p.profile.map(x => '<div class="hb' + (x.value > 0 ? '' : ' none') + '" data-bh="'
    + (x.value > 0 ? Math.max(1, (x.value / max) * 100).toFixed(2) : '0') + '" title="'
    + esc(String(x.hour).padStart(2, '0') + ':00 · ' + x.text) + '"></div>').join('');
  // The strip needs its own hours: the 00–04 … row below belongs to the weekday grid and is
  // offset by that grid's 28 px label column, so reading it as this axis is off by a block.
  const hourAxis = '<div class="axis">' + p.profile.map((x, i) => '<span>'
    + (i % 6 === 0 ? esc(String(x.hour).padStart(2, '0')) : '') + '</span>').join('') + '</div>';
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
        ? 'no usage in this block'
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
    + '<div class="hours">' + bars + '</div>' + hourAxis
    + (p.note ? '<div class="meta">' + esc(p.note) + '</div>' : '')
    // The caption carries what the grid stands on. A picture whose thin weeks look exactly
    // like its thick ones has to say which it is, in the same line that names it.
    + '<div class="meta">by weekday and four-hour block · ' + esc(p.basis.text) + '</div>'
    + grid
    + '<div class="legend"><span>hatched: no usage in that block</span></div>';
}

/**
 * One Records table. The share is the share of the range, and the detail beside a label is
 * the quieter half of it — the provider of a model, the session count of a project.
 */
function recordTable(head, rows) {
  if (!rows.length) return '';
  const cost = vm.showCost;
  return '<div class="card"><div class="name">' + esc(head) + '</div>'
    + '<div class="scroll"><table><thead><tr><th>' + esc(head) + '</th><th>Usage</th>'
    + '<th>Share</th>' + (cost ? '<th>API cost</th>' : '') + '</tr></thead><tbody>'
    + rows.map(function (r) {
      return '<tr><td data-h="' + esc(head) + '">' + esc(r.label)
        + (r.detail ? ' <span class="meta">' + esc(r.detail) + '</span>' : '')
        + '</td><td data-h="Usage">' + esc(r.usage) + '</td><td data-h="Share">' + esc(r.share)
        + '</td>' + (cost ? '<td data-h="API cost">' + esc(r.cost) + '</td>' : '') + '</tr>';
    }).join('') + '</tbody></table></div></div>';
}

/**
 * The extremes of the selected range.
 *
 * Nothing here is compared against a limit, because none of these figures has one: a peak day
 * is the busiest day *on record*, a streak is a run of days with usage inside the range, and
 * the shares are shares of the range. The two lower tables need attribution, and say so rather
 * than standing empty.
 */
function sRecords() {
  const r = vm.records;
  if (!r) return '<p class="empty">No records yet.</p>';
  let h = '';
  const peak = r.peakDay
    ? 'Peak day ' + esc(r.peakDay.day) + ' · ' + esc(r.peakDay.usage)
      + (vm.showCost && r.peakDay.cost !== '–'
         ? ' · ' + esc(r.peakDay.cost) + (r.peakDay.costPartial ? ' ⚠' : '') : '')
    : 'Peak day –';
  const streak = r.streak
    ? 'Longest streak ' + r.streak.days + ' day' + (r.streak.days === 1 ? '' : 's')
      + ' · ' + esc(r.streak.from) + ' → ' + esc(r.streak.to)
    : 'Longest streak –';
  h += '<div class="card"><div class="row"><span class="name">' + peak + '</span>'
    + '<span class="meta">' + streak + '</span></div></div>';
  h += recordTable('Model', r.topModels);
  if (r.attributionOn) {
    h += recordTable('Project', r.topProjects);
    h += recordTable('Session', r.topSessions);
  } else {
    h += '<p class="empty">Top projects and sessions need tokenPace.attribution.</p>';
  }
  const notes = [r.note, r.sessionNote].filter(Boolean);
  if (notes.length) {
    h += '<ul class="meta">' + notes.map(n => '<li>' + esc(n) + '</li>').join('') + '</ul>';
  }
  return h;
}

/**
 * The tools of the range, busiest first.
 *
 * No bar and no limit: a tool call has neither, and a bar beside a count invites a reading
 * of "how full is it" that nothing here can answer. The share is the share of the calls
 * counted in this range; the notes below say since when that counting has been happening and
 * whether a day hit the per-day name cap.
 */
function sTools() {
  const t = vm.tools;
  if (!t) return '<p class="empty">No tool calls counted.</p>';
  let h = '';
  if (t.rows.length) {
    h += '<div class="scroll"><table><thead><tr><th>Tool</th><th>Calls</th><th>Share</th>'
      + '<th>Models</th></tr></thead><tbody>'
      + t.rows.map(function (r) {
        return '<tr><td data-h="Tool">' + esc(r.name)
          + (r.sources ? ' <span class="meta">' + esc(r.sources) + '</span>' : '')
          + '</td><td data-h="Calls">' + esc(r.callsText) + '</td>'
          + '<td data-h="Share">' + esc(r.share) + '</td>'
          + '<td data-h="Models">' + esc(r.models) + '</td></tr>';
      }).join('') + '</tbody></table></div>';
    h += '<div class="meta">' + esc(t.totalText) + ' call(s) · ' + t.distinct + ' distinct tool(s)'
      + (t.hidden ? ' · ' + t.hidden + ' more not listed' : '') + '</div>';
  } else {
    h += '<p class="empty">No tool call counted in this range.</p>';
  }
  if (t.notes.length) {
    h += '<ul class="meta">' + t.notes.map(n => '<li>' + esc(n) + '</li>').join('') + '</ul>';
  }
  return h;
}

/**
 * The budgets the reader configured.
 *
 * A budget is the one limit in this panel that nobody had to guess: it was typed into the
 * settings. So the bar is drawn against *that* number and against nothing else, the money
 * rows keep the tilde and the warning sign the cost column has (an unpriced model makes a spend a lower
 * bound, and a lower bound makes the share one too), and a period with no local data at all
 * shows a dash — a budget at "0 %" would claim a quiet week when the history may simply not
 * have been read yet. Nothing is summed across rows: dollars and tokens are two questions.
 *
 * "No budget configured" is therefore only ever said about an empty setting: a budget that
 * cannot be measured — money while the cost column is off — still has its row, all dashes,
 * with the responsible setting named under it.
 */
function sBudget() {
  const rows = vm.budgets || [];
  if (!rows.length) {
    return '<p class="empty">No budget configured. tokenPace.budgets takes your own limit '
      + 'per provider, period and unit.'
      + '<br><button data-act="cmd" data-id="tokenPace.openSettings">Open settings</button></p>';
  }
  return rows.map(function (b) {
    const share = b.share === null || b.share === undefined ? null : b.share;
    const cls = b.over ? 'warn' : 'neutral';
    let h = '<div class="card"><div class="row"><span class="name">' + esc(b.label)
      + (b.partial ? ' ⚠' : '') + '</span><span class="meta">' + esc(b.shareText)
      + (b.over ? ' · over' : '') + '</span></div>'
      + '<div class="win"><div class="win-top"><span>' + esc(b.usedText) + ' of '
      + esc(b.limitText) + '</span><b>' + esc(b.from) + ' → ' + esc(b.last) + '</b></div>';
    // No denominator, no bar: a null share is a period we have not read, not an empty one.
    if (share !== null) {
      h += bar(share, cls, null, null,
        { now: Math.round(share), max: 100, text: b.label + ': ' + b.usedText + ' of ' + b.limitText });
    }
    h += '</div>';
    const meta = [
      // Why a row is all dashes: a budget is never dropped for being unmeasurable, so the
      // card has to name the switch that is in the way instead of showing a blank card.
      b.unmeasurable || null,
      b.projectedText ? 'projected ' + b.projectedText + ' by ' + b.last : null,
      b.projectionBasis,
    ].filter(Boolean).join(' · ');
    if (meta) {
      h += '<div class="meta' + (b.projectedOver ? ' warn' : '') + '">' + esc(meta) + '</div>';
    }
    return h + '</div>';
  }).join('')
    + '<div class="meta">A budget is your own number. USD is the hypothetical API '
    + 'equivalent, not a bill, and no budget is ever added to another.</div>';
}

function sHistory() {
  if (!vm.retro.length) return '<p class="empty">No cycles on file yet.</p>';
  return '<ul>' + vm.retro.map(r => '<li><b>' + srcLabel(r.source, r.label) + '</b>: '
    + esc(r.text) + '</li>').join('') + '</ul>';
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
  notices: sNotices, controls: sControls, footer: sFooter, drill: sDrill,
  summary: sSummary, quota: sQuota, context: sContext, kpis: sKpis, tokens: sTokens,
  chart: sChart, models: sModels, heatmap: sHeatmap, hours: sHours, records: sRecords,
  tools: sTools, budget: sBudget,
  history: sHistory, projects: sProjects, sessions: sSessions, dataQuality: sDataQuality,
};
const TITLE = {
  summary: 'Summary', quota: 'Quota', context: 'Context window', kpis: 'Key figures',
  tokens: 'Tokens', chart: 'Chart', models: 'Models', heatmap: 'Activity',
  hours: 'Time of day', records: 'Records', tools: 'Tools', budget: 'Budgets',
  history: 'Reset history',
  projects: 'Projects', sessions: 'Sessions', dataQuality: 'Data quality',
};

// Above everything, quota cards included: a preview banner or the first-run box qualifies
// every figure on the page, not only the statistics the filter bar governs.
function sNotices() {
  let h = '';
  if (vm.firstRun) {
    h += '<div class="box info" role="status">' + esc(vm.firstRun.text)
      + (vm.firstRun.scanning ? '' : '<br><button data-act="cmd" data-id="tokenPace.rescan">'
        + 'Re-read token history</button>') + '</div>';
  }
  if (vm.preview) h += '<div class="box" role="status">Preview data — not a reading.</div>';
  return h;
}

function sControls() {
  return controls();
}

// Sections the range, provider and model chips do not filter: a provider's window is what
// it is whichever week is selected, and the context reading belongs to one live session.
const RANGE_FREE = ['quota', 'context'];

function sFooter() {
  // The footnotes already carry the pricing sentence (and the one about configured rates);
  // the line below is only the fallback for a model that does not, never a second copy.
  const priced = vm.footnotes.some(f => String(f).indexOf('Prices as of') >= 0);
  return '<ul>' + vm.footnotes.map(f => '<li>' + esc(f) + '</li>').join('')
    + (priced ? '' : '<li>Prices as of ' + esc(vm.pricing.asOf)
       + (vm.pricing.custom ? ' · your configured rates' : '') + '.</li>')
    + '<li>Generated ' + esc(vm.generatedAt) + '.</li></ul>';
}

/** Folded away by the reader, as the view model remembers it. */
function collapsed(key) {
  const list = vm.ui && Array.isArray(vm.ui.collapsed) ? vm.ui.collapsed : [];
  return list.indexOf(key) >= 0;
}

function renderAll() {
  let h = '<div data-sec="notices" data-body="notices">' + sNotices() + '</div>';
  // The filter bar sits where its effect starts: below the leading sections it does not
  // apply to, above the first one it does. With the default order that puts the quota cards
  // on top and the chips between them and the statistics.
  let controlsPlaced = false;
  const controlsBlock = '<div data-sec="controls" data-body="controls">' + sControls() + '</div>';
  for (const key of vm.sections) {
    if (!RENDER[key]) continue;
    if (!controlsPlaced && RANGE_FREE.indexOf(key) < 0) { h += controlsBlock; controlsPlaced = true; }
    // A native <details>: the fold is the browser's, so it is keyboard reachable and
    // announced as expandable, and the body stays in the document either way — a section
    // update writes into it whether the reader has it open or not.
    h += '<section data-sec="' + key + '"><details' + (collapsed(key) ? '' : ' open') + '>'
      + '<summary data-act="section" data-key="' + esc(key) + '"><h2>' + esc(TITLE[key] || key)
      + '</h2>' + gear(key) + '</summary>'
      + '<div data-body="' + key + '">' + RENDER[key]() + '</div></details></section>';
  }
  if (!controlsPlaced) h += controlsBlock;
  h += '<div data-sec="drill" data-body="drill">' + sDrill() + '</div>';
  h += '<div class="foot" data-sec="footer" data-body="footer">' + sFooter() + '</div>';
  document.getElementById('root').innerHTML = h;
  applyStyles();
  // The whole page was just written, drill panel included, so the day on screen is the day
  // in hand. Without this every full render leaves the marker empty and the next section
  // update mistakes a plain refresh for a new day — and scrolls away under the reader.
  shownDrill = vm.drill ? vm.drill.day : null;
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
  // A day opened from the chart lands a whole page below it. Only on a new day, so a table
  // that merely refreshes cannot pull the page around under the reader.
  if (key === 'drill') {
    const day = vm.drill ? vm.drill.day : null;
    if (day && day !== shownDrill) {
      const sec = document.querySelector('[data-sec="drill"]');
      if (sec && sec.scrollIntoView) sec.scrollIntoView({ block: 'nearest' });
    }
    shownDrill = day;
  }
}

/** The CSP forbids inline style attributes; values set through the CSSOM are unaffected. */
function applyStyles() {
  document.querySelectorAll('[data-w]').forEach(el => { el.style.width = el.dataset.w + '%'; });
  document.querySelectorAll('[data-bh]').forEach(el => { el.style.height = el.dataset.bh + '%'; });
  document.querySelectorAll('[data-x]').forEach(el => { el.style.left = el.dataset.x + '%'; });
  document.querySelectorAll('[data-b]').forEach(el => { el.style.bottom = el.dataset.b + '%'; });
  applyFits();
}

/**
 * The three decisions that need a measured page rather than a view model: which labels fit,
 * which tables are cut off, and where the heat map should start.
 */
function applyFits() {
  fitChart();
  fitScroll();
  scrollHeat();
}

/**
 * Labels are thinned by the width one column actually has. A label per column is only
 * readable above roughly 30 px; below that every n-th one is shown and the rest keep their
 * slot empty, so the ones that remain still sit over their own column. No number is lost:
 * every column carries its total in the title.
 */
function fitChart() {
  const chart = document.querySelector('.chart');
  if (!chart) return;
  const n = chart.children.length;
  const width = chart.clientWidth;
  if (!n || width <= 0) return;
  const per = (width - (n - 1) * 2) / n;
  const values = chart.querySelectorAll('.vlabel');
  const vEvery = per >= 30 ? 1 : Math.ceil(30 / Math.max(per, 1));
  values.forEach(el => { el.hidden = (Number(el.dataset.i) % vEvery) !== 0; });
  const axis = document.querySelector('.plot + .axis');
  if (!axis) return;
  const aEvery = per >= 34 ? 1 : Math.ceil(34 / Math.max(per, 1));
  axis.querySelectorAll('span').forEach(el => {
    // The text lives in the inner element that centres the overflow; writing it on the slot
    // itself would throw that element away on the first resize.
    const inner = el.firstElementChild || el;
    inner.textContent = (Number(el.dataset.i) % aEvery) === 0 ? (el.dataset.l || '') : '';
  });
}

/**
 * A table wider than its box scrolls, but nothing said so: at sidebar width five of the
 * twelve columns are simply not there. The hint is added only once the browser has measured
 * an overflow, and removed again when there is none.
 */
function fitScroll() {
  document.querySelectorAll('.scroll').forEach(el => {
    const over = el.scrollWidth > el.clientWidth + 1;
    const next = el.nextElementSibling;
    const hint = next && next.classList && next.classList.contains('scrollhint') ? next : null;
    if (hint) { hint.hidden = !over; return; }
    if (!over) return;
    el.insertAdjacentHTML('afterend',
      '<div class="meta scrollhint">scroll sideways for the remaining columns →</div>');
  });
}

/**
 * A year of weeks does not fit a sidebar, and the left end is the oldest — for a fresh
 * install that is a wall of empty squares. Start at the newest week; the strip still scrolls,
 * and a reader who moved it is left alone.
 *
 * Pinning once was not enough. Narrowing the sidebar leaves the scroll offset where it is
 * while the scrollable width grows underneath it, so the strip that was at its newest week
 * ends up in the middle of last spring. The offset we set is remembered instead: as long as
 * the strip is still where we left it — or already at its right end, which is where the
 * browser clamps it when the sidebar is widened — it is pinned again on every render and
 * every resize. Anywhere else is the reader's doing and is not touched.
 */
function scrollHeat() {
  document.querySelectorAll('.heat').forEach(el => {
    const max = el.scrollWidth - el.clientWidth;
    if (max <= 0) { el.dataset.pin = ''; return; }
    const pin = el.dataset.pin;
    const ours = pin === undefined || pin === ''
      || Math.abs(el.scrollLeft - Number(pin)) <= 1 || el.scrollLeft >= max - 1;
    if (!ours) return;
    el.scrollLeft = max;
    // What the element actually took, not what we asked for: a browser that clamps or rounds
    // the offset would otherwise look like a reader on the very next pass.
    el.dataset.pin = String(el.scrollLeft);
  });
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
  } else if (a === 'moreModels') { allModels = !allModels; renderSection('controls'); }
  else if (a === 'moreRanges') { allRanges = !allRanges; renderSection('controls'); }
  else if (a === 'customDates') { showDates = !showDates; renderSection('controls'); }
  else if (a === 'section') post({ type: 'toggleSection', key: el.dataset.key });
  else if (a === 'compositionCache') post({ type: 'setCompositionCache', mode: el.dataset.mode });
  else if (a === 'sectionSettings') post({ type: 'openSectionSettings', key: el.dataset.key });
  else if (a === 'heatmapMetric') post({ type: 'setHeatmapMetric', metric: el.dataset.metric });
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
  if (!el || !vm) return;
  // The gear lives inside the <summary>, whose default action is the fold: without both of
  // these, opening the settings would close the section on the way out.
  if (el.dataset.act === 'sectionSettings') { ev.stopPropagation(); ev.preventDefault(); }
  act(el);
});
document.addEventListener('keydown', (ev) => {
  if (ev.key !== 'Enter' && ev.key !== ' ') return;
  const el = target(ev, '[data-act]');
  if (!el || !vm) return;
  // The same for the keyboard: the key press acts on the gear and stops there, so the press
  // that opens the settings does not fold the section under it.
  if (el.dataset.act === 'sectionSettings') {
    ev.stopPropagation();
    ev.preventDefault();
    act(el);
    return;
  }
  // A <summary> turns Enter and Space into a click of its own; acting here as well would
  // toggle the section twice and leave the fold where it started.
  if (el.tagName !== 'BUTTON' && el.tagName !== 'SELECT' && el.tagName !== 'SUMMARY') {
    ev.preventDefault();
    act(el);
  }
});
document.addEventListener('change', (ev) => {
  const el = target(ev, '[data-act="metric"]');
  if (el && vm) post({ type: 'setMetric', metric: el.value });
});

// -- the KPI explanation ----------------------------------------------------

/** The explanation currently open; opening a second one closes it. */
let openPop = null;

function hidePop() {
  // A re-render can have taken the node out of the document underneath us. Hiding a detached
  // element is harmless, and dropping the reference is what matters.
  if (openPop) openPop.hidden = true;
  openPop = null;
}

/**
 * Opens one card's explanation. Which side it hangs from is measured, not assumed: a card in
 * the right half of the grid would push a left-anchored popover off the page, and the panel
 * is anything from a 260 px sidebar to a full editor column.
 */
function showPop(card) {
  const pop = card.querySelector ? card.querySelector('.pop') : null;
  if (!pop) return;
  hidePop();
  const box = card.getBoundingClientRect ? card.getBoundingClientRect() : null;
  const width = window.innerWidth || 0;
  if (box && width && box.left + box.width / 2 > width / 2) pop.classList.add('right');
  else pop.classList.remove('right');
  pop.hidden = false;
  openPop = pop;
}

/**
 * The card itself, never one of its children: mouseenter and mouseleave fire for the inner
 * elements as well, and a pointer crossing onto the sparkline is not a pointer leaving the
 * card. The popover is a child of the card, so hovering it keeps the card hovered.
 */
function kpiCard(ev) {
  const t = ev.target;
  return t && t.classList && t.classList.contains('kpi') ? t : null;
}

// mouseenter, mouseleave, focus and blur do not bubble; a capture-phase listener sees them
// all the same, so one pair of listeners survives every re-render of the section.
document.addEventListener('mouseenter', (ev) => {
  const card = kpiCard(ev);
  if (card) showPop(card);
}, true);
document.addEventListener('mouseleave', (ev) => { if (kpiCard(ev)) hidePop(); }, true);
document.addEventListener('focus', (ev) => {
  const card = kpiCard(ev);
  if (card) showPop(card);
}, true);
document.addEventListener('blur', (ev) => { if (kpiCard(ev)) hidePop(); }, true);
// Escape closes it wherever the focus is — the way a reader expects to dismiss a hover card.
document.addEventListener('keydown', (ev) => { if (ev.key === 'Escape') hidePop(); });

// Dragging the sidebar wider is exactly the case where more labels fit than did before.
window.addEventListener('resize', () => { if (vm) applyFits(); });

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
