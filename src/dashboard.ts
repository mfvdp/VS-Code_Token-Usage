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
 * script this file writes — the style below, and src/webview/main.ts, built to text at build
 * time. The chart, the heatmap and the sparklines are CSS and inline SVG.
 *
 * The page's words are this file's business too: the script cannot import the localisation
 * seam, so every string it shows is translated here and written in front of it as one
 * dictionary — see `webviewWords()` at the bottom.
 */

import * as vscode from 'vscode'
import script from 'webview:script'
import { SOURCES, SOURCE_TITLE } from './adapters'
import { locale, t } from './i18n'
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

/**
 * The page's language, for the browser and for a screen reader: the primary subtag of the
 * editor's language, so an English build stays `lang="en"` whether the host says 'en' or
 * 'en-US', and a German one says `lang="de"`. A page whose words are German but whose markup
 * claims English is read out in the wrong accent, hyphenated by the wrong rules and quoted
 * with the wrong marks.
 */
function htmlLang(): string {
  const tag = locale()
  const dash = tag.indexOf('-')
  return dash > 0 ? tag.slice(0, dash) : tag
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
<html lang="${htmlLang()}">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy"
      content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style nonce="${nonce}">${CSS}</style>
</head>
<body>
<div id="root"><p class="empty">${t('Loading …')}</p></div>
<script nonce="${nonce}">${scriptText()}</script>
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
/* Positioned for the same reason the KPI card is: the window block is the containing block of
   its own explanation, so the popover hangs under the bar it explains. */
.win { margin-top: 8px; position: relative; }
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
   keeps the provider colour, and so does the vertical drop into a reading the window turned
   over before — that drop is the window turning over, and colouring it would judge a pace
   nobody kept. A stretch without readings is drawn straight across, from the last reading
   before it to the first one after. */
.spark polyline.ok, .spark path.pt.ok { stroke: var(--ok); }
.spark polyline.warn, .spark path.pt.warn { stroke: var(--warn); }
.spark polyline.warn2, .spark path.pt.warn2 { stroke: var(--warn2); }
.spark polyline.error, .spark path.pt.error { stroke: var(--error); }
/* A single reading is drawn as a hair-length stroke with a round cap: the
   viewBox is stretched to the card width, and any shape with a geometric size would be
   stretched with it — a 5 px dash that reads as a line where there is a single point. */
.spark path.pt { fill: none; stroke: var(--claude); stroke-width: 3; stroke-linecap: round;
                 vector-effect: non-scaling-stroke; }
/* The reading under the pointer, or the one stepped to with the arrow keys: the same
   round-capped hairline as a lone reading, only heavier and in the hover widget's text colour
   — a circle element would be stretched with the viewBox into an ellipse. */
.spark path.hov { fill: none; stroke: var(--vscode-editorHoverWidget-foreground, var(--vscode-foreground));
                  stroke-width: 5; stroke-linecap: round; vector-effect: non-scaling-stroke;
                  pointer-events: none; }
/* The hit area. A polyline with no fill is a hairline to the pointer; the transparent
   rectangle over the whole box takes the pointer for it, so any x along the line finds the
   nearest reading. */
.spark rect.ov { fill: transparent; pointer-events: all; }
/* The quota sparkline's hover label hangs under the reading it names, in the box the KPI
   explanation uses. Sized to its one line, and its anchor slides from the left edge to the
   right one with the reading — a box hung from the reading's x alone would leave the card
   on the right half of the axis. */
.sparkbox { position: relative; }
.sparkbox .pop { min-width: 0; white-space: nowrap; }
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

/**
 * The page's script: src/webview/main.ts, built by build.mjs and injected here as text
 * through the virtual module `webview:script` — so the compiler sees every line of it, which
 * it never did while this was a template string.
 *
 * The three consts in front of it are what a browser bundle cannot reach: the provider
 * registry is Node code (fs, os, path), and so is the localisation seam. They are written at
 * the top of the very same <script>, where the module below reads them out of its own scope;
 * src/webview/globals.d.ts declares them for the compiler. A function rather than a const,
 * because `t()` may only run once the host has set the bundle — at render time, not at load.
 * Still a string concatenation, though: rendering a page touches no file.
 */
function scriptText(): string {
  return `
/** The provider titles, interpolated from the registry so the webview cannot drift from it. */
const SRC_TITLE = ${JSON.stringify(SOURCE_TITLE)};
/** The provider ids in registry order — the order of the filter bar's provider chips. */
const SRC_IDS = ${JSON.stringify(SOURCES)};
/** Every string the module below shows, keyed by its English text — see webviewWords(). */
const L10N = ${webviewDictionary()};
${script}`
}

/**
 * The dictionary as it is written into the page.
 *
 * `<` is escaped even though no translation may contain one: it is the single character that
 * could end the <script> element early, and a bundle is a file — one a distribution, a patch
 * or a hand edit could get wrong. `\u003c` is an ordinary escape inside a JSON string, so the
 * value the script reads back is unchanged.
 */
function webviewDictionary(): string {
  return JSON.stringify(webviewWords()).replace(/</g, '\\u003c')
}

/**
 * Every string src/webview/main.ts shows, keyed by the English text `tr()` looks it up with.
 *
 * The list is written out rather than derived: `scripts/l10n-extract.mjs` reads the source of
 * `t()`, not its arguments at run time, and src/webview is not scanned at all (it imports no
 * seam of its own). So this is where a webview string becomes a translatable key — a call to
 * `tr()` with no entry here reaches the reader in English for good, which is what the
 * dictionary test in test/dashboard.test.ts exists to catch.
 *
 * Two rules for the values. They are markup, not text: a translation with `<`, `>`, `&` or a
 * double quote in it would land in an attribute or a tag half-escaped, and the same test
 * refuses one. And a string the view model already delivers — every label, explanation and
 * caption the model builds — is translated there, never a second time here.
 */
function webviewWords(): Record<string, string> {
  return {
    'A budget is your own number. USD is the hypothetical API equivalent, not a bill, and no budget is ever added to another.':
      t('A budget is your own number. USD is the hypothetical API equivalent, not a bill, and no budget is ever added to another.'),
    'API cost': t('API cost'),
    'API cost (second axis)': t('API cost (second axis)'),
    'Active': t('Active'),
    'Activity': t('Activity'),
    'Avg turn {0}': t('Avg turn {0}'),
    'Avg turn {0} · P90 {1}': t('Avg turn {0} · P90 {1}'),
    'Avg/day': t('Avg/day'),
    'Basis': t('Basis'),
    'Blended': t('Blended'),
    'Blended $/1M': t('Blended $/1M'),
    'Budgets': t('Budgets'),
    'CV {0} · {1} spiky day(s)': t('CV {0} · {1} spiky day(s)'),
    'Cache': t('Cache'),
    'Cache read': t('Cache read'),
    'Cache · last 30 days': t('Cache · last 30 days'),
    'Calibration {0} {1}: {2}': t('Calibration {0} {1}: {2}'),
    'Calls': t('Calls'),
    'Chart': t('Chart'),
    'Compared with': t('Compared with'),
    'Connect the status line': t('Connect the status line'),
    'Consent: {0} · {1} · attribution {2} · v{3}': t('Consent: {0} · {1} · attribution {2} · v{3}'),
    'Context window': t('Context window'),
    'Coverage {0} → {1} · {2} hour / {3} day / {4} month buckets · snapshot {5} KB':
      t('Coverage {0} → {1} · {2} hour / {3} day / {4} month buckets · snapshot {5} KB'),
    'Data quality': t('Data quality'),
    'Day {0}': t('Day {0}'),
    'Duration': t('Duration'),
    'Extra usage': t('Extra usage'),
    'Extra usage (billed)': t('Extra usage (billed)'),
    'Fetch quota now': t('Fetch quota now'),
    'Fields reported but not rendered ({0}): {1}': t('Fields reported but not rendered ({0}): {1}'),
    'Fresh in': t('Fresh in'),
    'Generated {0}.': t('Generated {0}.'),
    'Hit': t('Hit'),
    'Hit rate': t('Hit rate'),
    'How': t('How'),
    'Key figures': t('Key figures'),
    'Longest streak {0}': t('Longest streak {0}'),
    'Longest streak {0} day · {1} → {2}': t('Longest streak {0} day · {1} → {2}'),
    'Longest streak {0} days · {1} → {2}': t('Longest streak {0} days · {1} → {2}'),
    'Lower bound share {0}': t('Lower bound share {0}'),
    'Model': t('Model'),
    'Models': t('Models'),
    'No budget configured. tokenPace.budgets takes your own limit per provider, period and unit.':
      t('No budget configured. tokenPace.budgets takes your own limit per provider, period and unit.'),
    'No context reading. The Claude Code status line is what reports it.':
      t('No context reading. The Claude Code status line is what reports it.'),
    'No cycles on file yet.': t('No cycles on file yet.'),
    'No data in this range.': t('No data in this range.'),
    'No model data in this range.': t('No model data in this range.'),
    'No project data yet.': t('No project data yet.'),
    'No quota reading yet. There are two ways to get one: fetch it from the provider, which asks for network access first, or connect the Claude Code status line, which mirrors the figures Claude Code already has on this machine.':
      t('No quota reading yet. There are two ways to get one: fetch it from the provider, which asks for network access first, or connect the Claude Code status line, which mirrors the figures Claude Code already has on this machine.'),
    'No records yet.': t('No records yet.'),
    'No session data yet.': t('No session data yet.'),
    'No tool call counted in this range.': t('No tool call counted in this range.'),
    'No tool calls counted.': t('No tool calls counted.'),
    'Not enough data for a summary yet.': t('Not enough data for a summary yet.'),
    'Open settings': t('Open settings'),
    'Output': t('Output'),
    'Peak day {0}': t('Peak day {0}'),
    'Peak day {0} · {1}': t('Peak day {0} · {1}'),
    'Per req.': t('Per req.'),
    'Period': t('Period'),
    'Preview data — not a reading.': t('Preview data — not a reading.'),
    'Prices as of {0} · your configured rates.': t('Prices as of {0} · your configured rates.'),
    'Prices as of {0}.': t('Prices as of {0}.'),
    'Project': t('Project'),
    'Project attribution is off (tokenPace.attribution).':
      t('Project attribution is off (tokenPace.attribution).'),
    'Projects': t('Projects'),
    'Providers': t('Providers'),
    'Quota': t('Quota'),
    'Quota history {0} samples · {1} KB · oldest {2}': t('Quota history {0} samples · {1} KB · oldest {2}'),
    'Range': t('Range'),
    'Re-read token history': t('Re-read token history'),
    'Realised': t('Realised'),
    'Reasoning': t('Reasoning'),
    'Rebuild from the transcripts and fetch the quota':
      t('Rebuild from the transcripts and fetch the quota'),
    'Records': t('Records'),
    'Refresh': t('Refresh'),
    'Req.': t('Req.'),
    'Reset history': t('Reset history'),
    'Retention {0} d hourly · {1} d daily · {2} d quota history':
      t('Retention {0} d hourly · {1} d daily · {2} d quota history'),
    'Roots: {0} · {1} file(s)': t('Roots: {0} · {1} file(s)'),
    'Session': t('Session'),
    'Session attribution is off (tokenPace.attribution).':
      t('Session attribution is off (tokenPace.attribution).'),
    'Sessions': t('Sessions'),
    'Settings for this section': t('Settings for this section'),
    'Share': t('Share'),
    'Sources {0}: {1}': t('Sources {0}: {1}'),
    'Spark': t('Spark'),
    'Split': t('Split'),
    'Started': t('Started'),
    'Status line: {0}': t('Status line: {0}'),
    'Summary': t('Summary'),
    'Time of day': t('Time of day'),
    'Tokens': t('Tokens'),
    'Tool': t('Tool'),
    'Tools': t('Tools'),
    'Top projects and sessions need tokenPace.attribution.':
      t('Top projects and sessions need tokenPace.attribution.'),
    'Usage': t('Usage'),
    'What': t('What'),
    'Write 1h': t('Write 1h'),
    'Write 5m': t('Write 5m'),
    'all': t('all'),
    'apply': t('apply'),
    'by weekday and four-hour block · {0}': t('by weekday and four-hour block · {0}'),
    'cache': t('cache'),
    'cacheRead': t('cacheRead'),
    'chart metric': t('chart metric'),
    'clear': t('clear'),
    'clear stored data': t('clear stored data'),
    'click a column for that day': t('click a column for that day'),
    'close': t('close'),
    'context window: {0}': t('context window: {0}'),
    'copy diagnostics': t('copy diagnostics'),
    'copy summary': t('copy summary'),
    'cost': t('cost'),
    'cost line': t('cost line'),
    'custom…': t('custom…'),
    'daily bars · {0} columns': t('daily bars · {0} columns'),
    'dotted = outside coverage': t('dotted = outside coverage'),
    'dotted = outside coverage (before {0})': t('dotted = outside coverage (before {0})'),
    'elapsed share not yet used': t('elapsed share not yet used'),
    'exhausted': t('exhausted'),
    'export CSV': t('export CSV'),
    'export JSON': t('export JSON'),
    'family-priced: {0}': t('family-priced: {0}'),
    'fewer ▴': t('fewer ▴'),
    'from': t('from'),
    'hatched: no usage in that block': t('hatched: no usage in that block'),
    'hidden': t('hidden'),
    'lastMonth': t('lastMonth'),
    'less': t('less'),
    'limit reached': t('limit reached'),
    'local': t('local'),
    'lower bound': t('lower bound'),
    'models ({0}) ▾': t('models ({0}) ▾'),
    'month projection {0} · {1}': t('month projection {0} · {1}'),
    'more': t('more'),
    'more ▾': t('more ▾'),
    'no hour data · {0} day(s)': t('no hour data · {0} day(s)'),
    'no source answered': t('no source answered'),
    'no usage in this block': t('no usage in this block'),
    'none': t('none'),
    'ok': t('ok'),
    'output': t('output'),
    'output is a lower bound: some requests had no terminal line':
      t('output is a lower bound: some requests had no terminal line'),
    'over': t('over'),
    'over the limit': t('over the limit'),
    'peak {0} ({1})': t('peak {0} ({1})'),
    'peak {0}:00 · {1} day(s)': t('peak {0}:00 · {1} day(s)'),
    'priced from a related model (family fallback)': t('priced from a related model (family fallback)'),
    'projected at the reset': t('projected at the reset'),
    'projected {0} by {1}': t('projected {0} by {1}'),
    'quota sparkline, 7 days': t('quota sparkline, 7 days'),
    'reasoning': t('reasoning'),
    'requests': t('requests'),
    'reset due': t('reset due'),
    'resets {0}': t('resets {0}'),
    'scroll sideways for the remaining columns →': t('scroll sideways for the remaining columns →'),
    'shown': t('shown'),
    'some models have no price on file': t('some models have no price on file'),
    'sparkline: last 7 days': t('sparkline: last 7 days'),
    'stale': t('stale'),
    'streak {0} · longest {1} · active {2}': t('streak {0} · longest {1} · active {2}'),
    'sub': t('sub'),
    'thisMonth': t('thisMonth'),
    'thisWeek': t('thisWeek'),
    'time elapsed': t('time elapsed'),
    'time elapsed in this window': t('time elapsed in this window'),
    'to': t('to'),
    'today': t('today'),
    'unavailable': t('unavailable'),
    'unlimited': t('unlimited'),
    'unpriced: {0}': t('unpriced: {0}'),
    'updated {0}': t('updated {0}'),
    'usage': t('usage'),
    'used beyond the elapsed share': t('used beyond the elapsed share'),
    'utc': t('utc'),
    'weekly bars · {0} columns': t('weekly bars · {0} columns'),
    'without cache · {0} tokens cache read and {1} cache write not shown':
      t('without cache · {0} tokens cache read and {1} cache write not shown'),
    'without cache · {0} tokens cache read not shown': t('without cache · {0} tokens cache read not shown'),
    'without cache · {0} tokens cache write not shown':
      t('without cache · {0} tokens cache write not shown'),
    'year': t('year'),
    'yesterday': t('yesterday'),
    '{0} call(s) · {1} distinct tool(s)': t('{0} call(s) · {1} distinct tool(s)'),
    '{0} composition · last 30 days': t('{0} composition · last 30 days'),
    '{0} more not listed': t('{0} more not listed'),
    '{0} more — set tokenPace.dashboard.modelRows': t('{0} more — set tokenPace.dashboard.modelRows'),
    '{0} of {1}': t('{0} of {1}'),
    '{0} tokens over {1} day(s)': t('{0} tokens over {1} day(s)'),
    '{0} · {1} · {2} · {3} % of the day · {1} total {4}':
      t('{0} · {1} · {2} · {3} % of the day · {1} total {4}'),
    '{0} · {1} · {2} · {3} % of the week · {1} total {4}':
      t('{0} · {1} · {2} · {3} % of the week · {1} total {4}'),
    '{0}: {1} of {2}': t('{0}: {1} of {2}'),
    '≈ marks a lower bound: the oldest hours of the span are already rolled up into day totals':
      t('≈ marks a lower bound: the oldest hours of the span are already rolled up into day totals'),
  }
}
