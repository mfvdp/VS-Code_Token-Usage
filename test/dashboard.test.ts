// SPDX-FileCopyrightText: 2026 Frederik Marx
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * What the dashboard webview actually writes into the page.
 *
 * The webview is a CSS and a JavaScript string inside `dashboard.ts`, so there is nothing to
 * import and call. Both are taken out of the very HTML the provider hands to VS Code: the
 * script is then evaluated in a `node:vm` context with a stub for the three globals it
 * touches on load, which makes its section renderers callable with a view model of our own.
 * That is as close to the rendered page as a test without a browser gets — everything below
 * asserts on the markup a real render would produce, not on a re-implementation of it.
 *
 * The layout itself (what collides at 396 px, what is clipped) needs a browser and is checked
 * by hand; what is checked here is the wording, the markup and the CSS rules the layout hangs
 * on, all of which have gone wrong silently before.
 */

import { strict as assert } from 'node:assert'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import * as nodeVm from 'node:vm'
import { test } from 'node:test'
import { EARLIER_KEY, MAX_GROUP_CHILDREN, MAX_MORE_PAGES, SILENT_AFTER_MS, TreeNode } from '../src/agentTree'
import { tallySpoken, tallyText } from '../src/agentTreeBuild'
import { setBundle, setLang, setLocale, t } from '../src/i18n'
import { agentTreeFor, buildViewModel, parseWebviewMessage } from '../src/viewModel'
import { AGENT_WORLD, agentNode as agentNodeOf, agentWorld, everyParent, treeNodes } from './fixtures/agentWorld'
import { NOW, addCacheSession, buildAgg, makeConfig, makeInput } from './fixtures/viewFixtures'
import { codexMeta, codexTokenCount, codexTurnContext, ctxFor } from './fixtures/helpers'
import type { PromptCacheReading } from '../src/quotaSources'

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

/**
 * `dashboard.ts` imports `vscode`, which the test bundle marks external; the module is
 * therefore required lazily behind the same stub the status-bar test uses.
 */
function loadDashboard(): typeof import('../src/dashboard') {
  const mod = require('node:module')
  if (!mod._load.stubbed) {
    const original = mod._load
    const load = function (this: unknown, request: string, parent: unknown, isMain: boolean): unknown {
      if (request === 'vscode') return { commands: { executeCommand: () => undefined } }
      return original.call(this, request, parent, isMain)
    }
    load.stubbed = true
    mod._load = load
  }
  return require('../src/dashboard')
}

function fakeView(html: { value: string }): any {
  return {
    visible: true,
    webview: {
      options: {},
      set html(v: string) { html.value = v },
      get html(): string { return html.value },
      onDidReceiveMessage: () => ({ dispose: () => undefined }),
      postMessage: () => Promise.resolve(true),
      cspSource: '',
    },
    onDidChangeVisibility: () => ({ dispose: () => undefined }),
    onDidDispose: () => ({ dispose: () => undefined }),
    show: () => undefined,
  }
}

/** The page as the provider builds it, script, style and all. */
function page(): string {
  const { DashboardProvider } = loadDashboard()
  const html = { value: '' }
  const p = new DashboardProvider(() => undefined)
  p.resolveWebviewView(fakeView(html))
  return html.value
}

const PAGE = page()

function between(s: string, open: RegExp, close: string): string {
  const m = open.exec(s)
  assert.ok(m, 'the page has no ' + String(open))
  const from = (m as RegExpExecArray).index + (m as RegExpExecArray)[0].length
  const to = s.indexOf(close, from)
  assert.ok(to > from, 'unterminated ' + close)
  return s.slice(from, to)
}

const STYLE = between(PAGE, /<style nonce="[A-Za-z0-9]+">/, '</style>')

/**
 * The selectors of every rule the page takes out of a forced-colours theme's adjustment (1.6 P16).
 * 1.7 D-B: read from the stylesheet without its comments — a comment right in front of a rule is no
 * part of its selector.
 */
function adjustedOut(): string[] {
  const css = STYLE.replace(/\/\*[\s\S]*?\*\//g, '')
  return [...css.matchAll(/([^{}\n][^{}]*?)\s*\{[^{}]*forced-color-adjust:\s*none[^{}]*\}/g)].map((m) => m[1].trim())
    .concat(css.split('forced-color-adjust').length - 1 > [...css.matchAll(/forced-color-adjust:\s*none/g)].length ? ['(another forced-color-adjust)'] : [])
}
/**
 * 1.7 D-B: what the page takes out of a forced-colours theme's adjustment — a pressed chip (1.6 P16) and a band of the chart by model.
 * 1.8 L-5 (pinned and changed: those two): and a subagents' band of the split drawn under 4 px tall, striped.
 * 1.9 A6 (pinned and changed: those three): and a flag of the language picker — a picture, not a colour code.
 */
const ADJUSTED_OUT = ['button[aria-pressed="true"]:not(.ag-row)', '.flag:not(.flag-auto)', '.band:not(.sp-main, .sp-sub)', '.band.sp-sub.band-thin']
const SCRIPT = between(PAGE, /<script nonce="[A-Za-z0-9]+">/, '</script>')

/**
 * The script's source, for the assertions that describe how a piece of the webview is
 * written rather than what it does.
 *
 * `SCRIPT` is what the page ships: the built module, reprinted by esbuild, so its quotes,
 * its whitespace and its comments are the printer's and not the author's. Behaviour is
 * checked against that text — it is the one that runs — and the rules that must hold of the
 * shipped page (no URL, no external resource, no timer) are checked against both.
 */
const SOURCE = readFileSync(join(__dirname, '..', 'src', 'webview', 'main.ts'), 'utf8')

/**
 * A context for the webview script. On load it takes the VS Code API and registers four
 * listeners; nothing else runs until a section renderer is called by name. A function,
 * because the German page below is a second script that needs a second context.
 */
function makeContext(): nodeVm.Context {
  return nodeVm.createContext({
    acquireVsCodeApi: () => ({ postMessage: () => undefined }),
    document: {
      addEventListener: () => undefined,
      getElementById: () => null,
      querySelector: () => null,
      querySelectorAll: () => [],
    },
    window: { addEventListener: () => undefined },
    console,
  })
}

const ctx = makeContext()
nodeVm.runInContext(SCRIPT, ctx)

/** The heading markup `srcLabel` writes: one unbreakable span per part, one separator. */
function heading(...parts: string[]): string {
  return parts.map(p => '<span class="nobr">' + p + '</span>').join(' \u00b7 ')
}

/**
 * 1.10 B5 rule 3: a text as the page prints it on the quota card — each number kept with its unit by a no-break space.
 * The page's glue() restated for the pins of the prompt-cache block and the keep-warm notes below (rewritten for it:
 * they pinned the bare spaces); the rule itself is tested on the page's own function ("a number stays with its unit").
 */
const glued = (s: string): string => s.replace(/(\d) (%|min|h|d|s|m|K|M|G)(?!\p{L})/gu, '$1\u00a0$2')

/** Calls one renderer against a view model built from the defaults plus `over`. */
function render(call: string, over: Record<string, unknown> = {}): string {
  ;(ctx as Record<string, unknown>).fixture = model(over)
  return String(nodeVm.runInContext('vm = fixture; ' + call, ctx))
}

// ---------------------------------------------------------------------------
// Fixtures — the shapes the view model guarantees, never more than a renderer reads
// ---------------------------------------------------------------------------

function win(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'session:300', label: '5 h', percent: 61, percentText: '61 %', display: 'normal',
    level: 'ok', verdict: { text: 'on pace', level: 'ok' }, elapsed: 30, reset: '3h20m',
    resetAbsolute: '14:00', forecast: null, spark: [],
    aria: { now: 61, max: 100, text: '61 %' }, ...over,
  }
}

function card(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    source: 'claude', title: 'Claude Code', planType: 'max20', planSource: 'provider',
    planText: 'plan max20', problem: null, problemKind: null,
    problemAction: null, ageText: '2 min ago', stale: false, origin: 'poll',
    freshness: {
      lastCheck: '2 min ago', lastData: '2 min ago', lastEvent: '1 min ago',
      nextRefresh: 'in 3 min', snapshotAge: '1 min ago',
    },
    windows: [win()], extra: null, usagePageUrl: null, localBlock: null, ...over,
  }
}

function model(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    generatedAt: '2026-09-03 12:00',
    now: 0,
    sections: ['quota', 'history'],
    showCost: true,
    pricing: { asOf: '2026-09-02', later: null, custom: false, showList: false },
    range: { from: '2026-08-05', to: '2026-09-03', label: 'Last 30 days', preset: '30d', presets: ['7d', '30d'] },
    ui: { providers: ['claude', 'codex'], models: [], metric: 'usage', collapsed: [] },
    quotas: [card()],
    context: null,
    digest: [],
    kpis: [],
    composition: [],
    totals: [],
    cacheEconomy: [],
    calendar: null,
    planFactor: [],
    chart: {
      days: ['2026-09-01', '2026-09-02', '2026-09-03'],
      labels: ['09-01', '09-02', '09-03'],
      series: [{ key: 'claude:claude-opus-4-6', label: 'claude-opus-4-6', source: 'claude', rank: 0, values: [10, 20, 30] }],
      metric: 'usage', modelStyle: 'pattern', max: 30, ticks: [10, 20, 30, 40], weekly: false, costLine: null,
    },
    models: { rows: [], total: 0, hidden: 0, sort: { key: 'usage', dir: 'desc' } },
    records: null,
    tools: null,
    budgets: [],
    heatmap: {
      weeks: [{ days: [{ level: 0, text: '2026-09-01: none' }] }], metric: 'usage', streak: 1,
      longestStreak: 2, activeDays: 3, peakDay: null, variability: null, firstDay: '2026-07-21',
    },
    hours: {
      profile: Array.from({ length: 24 }, (_, h) => ({ hour: h, value: h === 9 ? 100 : 0, text: 'none' })),
      peakHour: 9,
      // One week of mornings: the cells that were worked in carry a value, the rest none.
      grid: Array.from({ length: 7 }, (_, weekday) => ({ weekday, block: 2, value: 11000, samples: 1 })),
      basis: { weeks: 1, days: 7, text: 'based on 1 week — a record, not a habit' },
      weekdayLabels: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'],
      zone: 'local', days: 7, note: null,
    },
    retro: [{ source: 'claude', windowId: 'session:300', label: '5 h', retro: null, text: 'peaked at 61 %' }],
    projects: { rows: [], enabled: false },
    sessions: { rows: [], enabled: false, cacheStates: [] },
    dataQuality: null,
    unpricedModels: [],
    familyPriced: [],
    lowerBound: false,
    drill: null,
    firstRun: null,
    footnotes: ['Prices as of 2026-09-02.'],
    preview: false,
    ...over,
  }
}

// ---------------------------------------------------------------------------
// Style rules the layout depends on
// ---------------------------------------------------------------------------

test('the stacked layout prefixes only the cells that carry a header', () => {
  // 1.10 D10 (rewritten: it pinned `attr(data-h) ": "`): the label is data-hl — the column name in the language's
  // own "{0}:" — and a space; data-h stays the plain name (the harness and the tests read it).
  assert.match(STYLE, /td\[data-h\]::before \{ content: attr\(data-hl\) " "; color: var\(--dim\); \}/)
  assert.equal(/attr\(data-h\) ": "/.test(STYLE), false, STYLE)
  // A bare `td::before` would put ": " in front of every sub-row and drill line.
  assert.equal(/[^\]]td::before/.test(STYLE), false, STYLE)
})

test('the stacked layout lets a long cell wrap instead of running off the card', () => {
  // A table cell is `white-space: nowrap` so real columns cannot break mid-figure. Once the
  // narrow breakpoint turns the cells into blocks, that rule turns a long value — the tools
  // section's model list is the first one long enough to see it — into text past the card
  // edge, readable only by scrolling sideways through a layout that exists to avoid exactly
  // that. The block must therefore release it.
  const narrow = between(STYLE, /@media \(max-width: 320px\) \{/, '\n}')
  assert.match(narrow, /td \{[^}]*white-space: normal/)
  // And the base rule still holds outside it, where the columns are real columns.
  assert.match(STYLE.slice(0, STYLE.indexOf('@media (max-width: 320px)')), /^td \{[^}]*white-space: nowrap/m)
})

test('the track and the hairlines are mixed from the foreground, not from a theme surface', () => {
  // editorWidget.background is the sidebar background itself in the light themes.
  assert.equal(/--track: var\(--vscode-editorWidget-background/.test(STYLE), false)
  assert.match(STYLE, /--track: color-mix\(in srgb, var\(--vscode-foreground\)/)
  assert.match(STYLE, /--rule: color-mix\(in srgb, var\(--vscode-foreground\)/)
  assert.match(STYLE, /\.plot \{[^}]*border-bottom: 1px solid var\(--rule\)/)
  assert.match(STYLE, /\.grid \{[^}]*border-top: 1px dashed var\(--rule\)/)
})

test('tick labels sit in a gutter beside the plot, never on top of a bar', () => {
  assert.match(STYLE, /\.grid \{[^}]*z-index: 2/)
  const span = /\.grid span \{([^}]*)\}/.exec(STYLE)
  assert.ok(span)
  const rule = (span as RegExpExecArray)[1]
  // A negative top puts the 100 % label outside the plot, over the buttons above it.
  assert.equal(/top: -/.test(rule), false, rule)
  // Outside the plotted area: `left: 100%` puts it past the right edge, and with nothing
  // beneath it the opaque chip that used to cut the newest columns into pieces is gone.
  assert.match(rule, /left: 100%/)
  assert.equal(/background/.test(rule), false, rule)
  // The gutter it moves into, and the same gutter on the axis so the day labels stay put.
  const plot = /\.plot \{([^}]*)\}/.exec(STYLE)
  const axis = /\.plot \+ \.axis \{([^}]*)\}/.exec(STYLE)
  assert.ok(plot && axis)
  const gutter = /margin-right: (\d+)px/.exec((plot as RegExpExecArray)[1])
  assert.ok(gutter, (plot as RegExpExecArray)[1])
  assert.match((axis as RegExpExecArray)[1], new RegExp('margin-right: ' + gutter[1] + 'px'))
})

test('axis labels never wrap to a second line', () => {
  assert.match(STYLE, /\.axis span \{[^}]*white-space: nowrap/)
})

test('a label wider than its slot spills to both sides, not over its neighbour', () => {
  // text-align centres a line box that fits and leaves one that does not at the slot's start,
  // which paints the value of one column over the column beside it. A centring flex container
  // overflows symmetrically, so the label stays on the bar it belongs to.
  for (const sel of ['\\.col \\.vlabel', '\\.axis span']) {
    const rule = new RegExp(sel + ' \\{([^}]*)\\}').exec(STYLE)
    assert.ok(rule, sel + ' has no rule')
    const body = (rule as RegExpExecArray)[1]
    assert.match(body, /display: flex/)
    assert.match(body, /justify-content: center/)
    assert.equal(/text-align/.test(body), false, sel + ': ' + body)
  }
  // The thinning still works: an explicit display would otherwise beat the browser's rule
  // for the hidden attribute, and every value label would stay on the page.
  assert.match(STYLE, /\.col \.vlabel\[hidden\] \{ display: none/)
  assert.match(SOURCE, /el\.hidden = \(Number\(el\.dataset\.i\) % vEvery\)/)
  // And the axis text is written into the centred element, never over it.
  assert.match(SOURCE, /const inner = el\.firstElementChild \|\| el;/)
})

test('the cost line stays inside the plot instead of drawing across the page below it', () => {
  // An inline SVG is a replaced element: with `inset: 0` and no size of its own the browser
  // took the width from the box and the height from the viewBox's 1:1 ratio, which painted a
  // plot-wide cost line straight over the model table and the heatmap underneath.
  const rule = /\.costline \{([^}]*)\}/.exec(STYLE)
  assert.ok(rule, 'the cost line has no rule')
  const body = (rule as RegExpExecArray)[1]
  assert.match(body, /position: absolute/)
  assert.match(body, /width: 100%/)
  assert.match(body, /height: 100%/)
  // The box it is measured against, and the one it may not clip: the tick labels live in the
  // gutter outside the plot, so an overflow rule here would cut every one of them off.
  assert.match(STYLE, /\.plot \{[^}]*position: relative/)
  assert.equal(/\.plot \{[^}]*overflow: hidden/.test(STYLE), false, STYLE)
  // And the overlay is drawn with an explicit viewBox that the sizing above stretches to it.
  assert.match(SOURCE, /svg class="costline" viewBox="0 0 100 100"/)
  // The series is mapped onto the whole box, so the maximum sits at y = 0 and a zero at
  // y = 100: with the browser's own rule for an inline SVG the marker dot at the peak would
  // be cut in half and the apex of the line squared off.
  assert.match(body, /overflow: visible/)
})

test('the plot is tall enough for a stack of six bands', () => {
  const plot = /\.plot \{([^}]*)\}/.exec(STYLE)
  assert.ok(plot, 'the plot has no rule')
  // 120 px made every model but the largest a hairline once a column was split six ways.
  assert.match((plot as RegExpExecArray)[1], /height: 240px/)
})

test('a dropdown is painted by the theme, its popup included', () => {
  // The popup is drawn by the browser, not by the page: light option text on the light system
  // menu is what a select looked like before the theme colours and the colour scheme were set.
  const sel = /\nselect \{([^}]*)\}/.exec(STYLE)
  const opt = /select option \{([^}]*)\}/.exec(STYLE)
  assert.ok(sel, 'select has no rule of its own')
  assert.ok(opt, 'option has no rule')
  for (const rule of [(sel as RegExpExecArray)[1], (opt as RegExpExecArray)[1]]) {
    assert.match(rule, /background: var\(--vscode-dropdown-background\)/)
    assert.match(rule, /color: var\(--vscode-dropdown-foreground\)/)
  }
  assert.match((sel as RegExpExecArray)[1], /border: 1px solid var\(--vscode-dropdown-border/)
  // The classes VS Code stamps on the body, both kinds of each theme.
  assert.match(STYLE, /body\.vscode-dark, body\.vscode-high-contrast \{ color-scheme: dark; \}/)
  assert.match(STYLE, /body\.vscode-light, body\.vscode-high-contrast-light \{ color-scheme: light; \}/)
})

test('a heading breaks at its separator, never inside the window label', () => {
  assert.match(STYLE, /\.nobr \{ white-space: nowrap/)
  // "Claude Code · 7 d" at 300 px used to wrap between the "7" and the "d".
  const h = render('sHistory()', {
    retro: [
      { source: 'claude', windowId: 'weekly:10080', label: '7 d', retro: null, text: 'x' },
      { source: 'codex', windowId: 'weekly:10080', label: '7 d', retro: null, text: 'y' },
    ],
  })
  assert.ok(h.indexOf('<b>' + heading('Claude Code', '7 d') + '</b>') >= 0, h)
  assert.ok(h.indexOf('<b>' + heading('Codex', '7 d') + '</b>') >= 0, h)
  // Both parts of both headings are unbreakable; nothing else in the block is.
  assert.equal(h.split('class="nobr"').length - 1, 4, h)
})

test('no composition slice borrows a colour that already means something else', () => {
  // Purple is Codex, green and orange are the pace verdicts one card above; a slice in any
  // of them claims a provider or a verdict it does not mean.
  const taken = ['--codex', '--ok', '--warn', '--warn2', '--error']
  const seen: string[] = []
  for (let i = 1; i <= 6; i++) {
    const rule = new RegExp('\\.cs\\.c' + i + ', \\.dot\\.c' + i + ' \\{([^}]*)\\}').exec(STYLE)
    assert.ok(rule, 'no rule for .cs.c' + i)
    const body = (rule as RegExpExecArray)[1].replace(/\s+/g, ' ').trim()
    for (const v of taken) {
      assert.equal(body.indexOf('var(' + v + ')'), -1, '.cs.c' + i + ' uses ' + v + ': ' + body)
    }
    // Six parts, six fills: two slices that paint the same cannot be read apart in the bar.
    assert.equal(seen.indexOf(body), -1, '.cs.c' + i + ' repeats an earlier fill: ' + body)
    seen.push(body)
  }
})

/** The six composition parts of one provider, with the numbers a test wants to see again. */
function comp(source = 'claude'): Record<string, unknown> {
  return {
    source,
    parts: [
      { key: 'freshInput', tokens: 1000, text: 'Fresh input' },
      { key: 'cacheWrite5m', tokens: 2000, text: 'Cache write 5m' },
      { key: 'cacheWrite1h', tokens: 500, text: 'Cache write 1h' },
      { key: 'cacheRead', tokens: 96_000, text: 'Cache read' },
      { key: 'output', tokens: 500, text: 'Output' },
      { key: 'reasoning', tokens: 200, text: 'Reasoning (of output)' },
    ],
  }
}

/** A view model with a composition bar and the calendar block `sTokens` reads after it. */
function tokensVm(over: Record<string, unknown> = {}): Record<string, unknown> {
  const period = { label: 'p', usage: '1K', cost: '~$1', requests: '1', activeDays: 1, avgPerDay: '1K' }
  return {
    totals: [],
    composition: [comp()],
    cacheEconomy: [],
    calendar: {
      thisWeek: period,
      thisMonth: { ...period, projection: null, projectionBasis: null },
      lastMonth: period,
      year: period,
    },
    planFactor: [],
    ...over,
  }
}

test('the cache chips sit above the composition bars and say which mode is on', () => {
  const h = render('sTokens()', tokensVm())
  const chips = h.indexOf('data-act="compositionCache"')
  const bar = h.indexOf('class="compbar"')
  assert.ok(chips >= 0, h)
  assert.ok(chips < bar, 'the switch is above the bar it governs')
  assert.ok(h.indexOf('<span class="meta">cache</span>') >= 0, h)
  assert.ok(h.indexOf('data-act="compositionCache" data-mode="all" aria-pressed="true">shown') >= 0, h)
  assert.ok(h.indexOf('data-act="compositionCache" data-mode="noCache" aria-pressed="false">hidden') >= 0, h)

  const off = render('sTokens()', tokensVm({
    ui: { providers: ['claude'], models: [], collapsed: [], compositionCache: 'noCache' },
  }))
  assert.ok(off.indexOf('data-act="compositionCache" data-mode="noCache" aria-pressed="true">hidden') >= 0, off)
})

test('hiding the cache drops its parts, rescales the rest and says what is missing', () => {
  const all = render('sTokens()', tokensVm())
  // Every counted part is drawn, reasoning excepted — it is a subset of output.
  assert.equal(all.split('class="cs ').length - 1, 5, all)
  assert.ok(all.indexOf('Cache read: 96,000 · 96 %') >= 0, all)
  assert.ok(all.indexOf('without cache') === -1, all)

  const off = render('sTokens()', tokensVm({
    ui: { providers: ['claude'], models: [], collapsed: [], compositionCache: 'noCache' },
  }))
  assert.equal(off.split('class="cs ').length - 1, 2, off)
  assert.equal(off.indexOf('Cache read'), -1, off)
  assert.equal(off.indexOf('Cache write 5m'), -1, off)
  assert.equal(off.indexOf('Cache write 1h'), -1, off)
  // 1000 of the 1500 tokens still on screen: the share is a share of what is drawn.
  assert.ok(off.indexOf('Fresh input: 1,000 · 67 %') >= 0, off)
  assert.ok(off.indexOf('without cache · 96,000 tokens cache read and 2,500 cache write not shown') >= 0, off)
})

test('the cache switch outlives the mode it sets', () => {
  // A range whose only counted tokens are cache tokens draws no bar at all once the cache is
  // hidden. The chips are what switches it back on, so they cannot go with the bar.
  const cacheOnly = { source: 'claude', parts: [{ key: 'cacheRead', tokens: 96_000, text: 'Cache read' }] }
  const off = render('sTokens()', tokensVm({
    composition: [cacheOnly],
    ui: { providers: ['claude'], models: [], collapsed: [], compositionCache: 'noCache' },
  }))
  assert.equal(off.indexOf('class="compbar"'), -1, off)
  assert.ok(off.indexOf('data-act="compositionCache" data-mode="all" aria-pressed="false">shown') >= 0, off)
  // Nothing to compose at all is still no switch: there is no bar it could ever govern.
  const nothing = render('sTokens()', tokensVm({ composition: [{ source: 'claude', parts: [] }] }))
  assert.equal(nothing.indexOf('data-act="compositionCache"'), -1, nothing)
})

test('the caption names the cache halves that were really set aside, never a zero', () => {
  const noWrites = render('sTokens()', tokensVm({
    composition: [{ source: 'codex', parts: [
      { key: 'freshInput', tokens: 1000, text: 'Fresh input' },
      { key: 'cacheRead', tokens: 179_000, text: 'Cache read' },
      { key: 'cacheWrite5m', tokens: 0, text: 'Cache write 5m' },
    ] }],
    ui: { providers: ['codex'], models: [], collapsed: [], compositionCache: 'noCache' },
  }))
  // The table beside it prints a dash for a figure a provider never reports; the caption
  // must not print "and 0 cache write" for the same absence.
  assert.ok(noWrites.indexOf('without cache · 179,000 tokens cache read not shown') >= 0, noWrites)
  const noReads = render('sTokens()', tokensVm({
    composition: [{ source: 'claude', parts: [
      { key: 'freshInput', tokens: 1000, text: 'Fresh input' },
      { key: 'cacheWrite5m', tokens: 2500, text: 'Cache write 5m' },
    ] }],
    ui: { providers: ['claude'], models: [], collapsed: [], compositionCache: 'noCache' },
  }))
  assert.ok(noReads.indexOf('without cache · 2,500 tokens cache write not shown') >= 0, noReads)
})

test('the two window rows carry their span as the tooltip of the label', () => {
  const row = (over: Record<string, unknown>): Record<string, unknown> => ({
    label: 'Current 5 h window', usage: '1.5K', freshInput: '1K', cacheWrite5m: '–',
    cacheWrite1h: '–', cacheRead: '–', output: '500', reasoning: '–', requests: '1',
    cacheHit: '–', perRequest: '1.5K', cost: '~$0.01', costPartial: false, incomplete: false,
    approx: false, spanText: '09:00 → now', ...over,
  })
  const h = render('sTokens()', tokensVm({
    totals: [{ source: 'claude', title: 'Claude Code', rows: [row({}), row({ label: 'Today', spanText: '2026-09-03', approx: false })] }],
  }))
  // 1.10 D10 (rewritten: the cell carries data-hl beside data-h now).
  assert.ok(h.indexOf('<td data-h="Period" data-hl="Period:" title="09:00 → now">Current 5 h window</td>') >= 0, h)
  assert.ok(h.indexOf('<td data-h="Period" data-hl="Period:" title="2026-09-03">Today</td>') >= 0, h)
  // Nothing is approximate, so the caveat is not printed.
  assert.equal(h.indexOf('rolled up into day totals'), -1, h)

  const approx = render('sTokens()', tokensVm({
    totals: [{
      source: 'claude',
      title: 'Claude Code',
      rows: [row({ approx: true, usage: '≈1.5K' }), row({ label: 'Today' })],
    }],
  }))
  // Once per table, however many rows carry the mark.
  assert.equal(approx.split('rolled up into day totals').length - 1, 1, approx)
  assert.ok(approx.indexOf('≈ marks a lower bound: the oldest hours of the span are already rolled up into day totals') >= 0, approx)
})

test('the cost line wears no colour a stacked band wears', () => {
  // One yellow meaning "API cost" over a yellow band meaning "the fourth model" was the same
  // mark twice; the line takes the foreground, which no band and no verdict uses.
  const line = /\.costline polyline \{([^}]*)\}/.exec(STYLE)
  assert.ok(line, 'the cost line has no stroke rule')
  const stroke = /stroke: ([^;]+);/.exec((line as RegExpExecArray)[1])
  assert.ok(stroke, 'no stroke')
  const colour = (stroke as RegExpExecArray)[1].trim()
  assert.equal(colour, 'var(--vscode-charts-foreground, var(--vscode-foreground))')
  for (const v of ['--ok', '--warn', '--warn2', '--error', '--claude', '--codex', 'charts-yellow']) {
    assert.equal(colour.indexOf(v), -1, 'the cost line uses ' + v)
  }
  // And no band rule wears the line's colour: the hues are the two provider colours, and every
  // ground and stroke is mixed from the hue and the track.
  const bandRules = STYLE.slice(STYLE.indexOf('.hue-claude {'), STYLE.indexOf('.costline {'))
  assert.ok(bandRules.length > 0, 'the band rules are missing')
  assert.equal(bandRules.indexOf('charts-foreground'), -1, bandRules)
  assert.equal(bandRules.indexOf('var(--vscode-foreground)'), -1, bandRules)
  for (const hue of ['--claude', '--codex']) assert.ok(bandRules.indexOf('var(' + hue + ')') >= 0, hue)
})

test('an empty hour is the shortest mark in the strip, never taller than a used one', () => {
  assert.match(STYLE, /\.hours \{[^}]*border-bottom: 1px solid var\(--rule\)/)
  const bar = /\.hours \.hb \{([^}]*)\}/.exec(STYLE)
  const none = /\.hours \.hb\.none \{([^}]*)\}/.exec(STYLE)
  assert.ok(bar && none, STYLE)
  const floor = (rule: string): number => {
    const m = /min-height: (\d+)px/.exec(rule)
    assert.ok(m, rule)
    return Number((m as RegExpExecArray)[1])
  }
  const empty = floor((none as RegExpExecArray)[1])
  const used = floor((bar as RegExpExecArray)[1])
  // The bug this replaces: an empty hour was 2 px and a used hour's floor 1 px, so the
  // emptiest hours of the day were the tallest marks on the strip.
  assert.ok(empty < used, 'empty ' + empty + 'px is not shorter than used ' + used + 'px')
  // One pixel of a 14 % tint on top of the baseline is not there in either theme; the marker
  // is mixed from the foreground, and never in the colour that means usage.
  assert.match((none as RegExpExecArray)[1], /color-mix\(in srgb, var\(--vscode-foreground\)/)
  assert.equal(/var\(--claude\)/.test((none as RegExpExecArray)[1]), false, none![1])
})

test('the page stays self-contained: one nonce, no external resource', () => {
  assert.match(PAGE, /default-src 'none'; base-uri 'none'; form-action 'none'; style-src 'nonce-[A-Za-z0-9]{32}'; script-src 'nonce-[A-Za-z0-9]{32}'/)
  // Both texts: what the page ships, and the module it was built from — a URL that a build
  // step happened to drop would be just as much of a promise broken as one that shipped.
  assert.equal(/https?:\/\//.test(STYLE + SCRIPT + SOURCE), false)
  assert.equal(/<link|<img|@import|url\(/.test(STYLE + SCRIPT + SOURCE), false)
})

test('the page ships the built webview module, not a template string', () => {
  // The script is src/webview/main.ts as esbuild printed it, with the two provider consts in
  // front of it: the registry is Node code, so its facts are written into the page rather
  // than bundled into a browser script.
  assert.match(SCRIPT, /^\n\/\*\* The provider titles[^\n]*\nconst SRC_TITLE = \{"claude":"Claude Code"/)
  assert.match(SCRIPT, /\nconst SRC_IDS = \["claude","codex"\];\n/)
  assert.ok(SCRIPT.indexOf('const vscode = acquireVsCodeApi();') >= 0, 'the module is missing')
  assert.ok(SOURCE.indexOf('const vscode = acquireVsCodeApi();') >= 0, 'the source is missing')
  // A webview has no module loader: nothing may be left for one to resolve.
  assert.equal(/^\s*(?:import|export)\b/m.test(SCRIPT), false, 'the script is not self-contained')
  // And dashboard.ts no longer carries a copy of the script of its own.
  const dashboard = readFileSync(join(__dirname, '..', 'src', 'dashboard.ts'), 'utf8')
  assert.ok(dashboard.indexOf("import script from 'webview:script'") >= 0)
  assert.equal(dashboard.indexOf('acquireVsCodeApi'), -1)
})

// ---------------------------------------------------------------------------
// The page's own words
// ---------------------------------------------------------------------------

/** The dictionary the page ships, read back out of the very context the script ran in. */
const DICT = nodeVm.runInContext('L10N', ctx) as Record<string, string>

/** Every `tr('…')` literal in src/webview/main.ts, with the line it stands on. */
function trCalls(): Array<{ key: string; line: number }> {
  const out: Array<{ key: string; line: number }> = []
  SOURCE.split('\n').forEach((text, i) => {
    for (const m of text.matchAll(/\btr\(\s*'((?:[^'\\]|\\.)*)'/g)) {
      out.push({ key: m[1].replace(/\\(['\\])/g, '$1'), line: i + 1 })
    }
  })
  return out
}

test('every string the webview translates is a key of the dictionary the page ships', () => {
  // The extract script does not read src/webview — the module imports no seam of its own —
  // so a `tr()` with no entry in `webviewWords()` is a string that can never be translated,
  // and nothing else in the build would say so.
  const calls = trCalls()
  assert.ok(calls.length > 150, `only ${calls.length} tr() call(s) found in main.ts`)
  for (const { key, line } of calls) {
    assert.ok(Object.prototype.hasOwnProperty.call(DICT, key),
      `src/webview/main.ts:${line}: tr(${JSON.stringify(key)}) has no entry in webviewWords()`)
  }
  // The other direction: an entry nobody calls would sit in the German bundle for good, and
  // the bundle's own orphan check cannot see it — from src/ it looks like a used t() key.
  const used = new Set(calls.map((c) => c.key))
  const orphans = Object.keys(DICT).filter((k) => !used.has(k))
  assert.deepEqual(orphans, [], `in webviewWords() but never asked for: ${orphans.join(', ')}`)
})

test('the dictionary stands in front of the module, is English without a bundle, and carries no markup', () => {
  // The third const of the page, after the provider registry's two.
  assert.match(SCRIPT, /\nconst SRC_IDS = \["claude","codex"\];\n\/\*\*[^\n]*\nconst L10N = \{/)
  for (const [key, value] of Object.entries(DICT)) {
    // With no bundle every entry is its own key: the English page is exactly what it was.
    assert.equal(value, key, `the empty bundle changed ${JSON.stringify(key)}`)
    // The values are concatenated into markup, in text and inside attributes alike.
    assert.equal(/[<>"&]/.test(value), false, `markup character in ${JSON.stringify(value)}`)
  }
})

test('no shipped bundle puts markup into one of the page\'s words', () => {
  // The rule above is about the value a reader gets, and that comes from a bundle: the loop
  // has just insisted every value is its own key, so on its own it can only ever re-read the
  // English. The files a translator, a patch or a distribution edits are held to it here.
  const dir = join(__dirname, '..', 'l10n')
  const bundles = readdirSync(dir).filter((f) => /^bundle\.l10n\..+\.json$/.test(f))
  assert.ok(bundles.length > 0, 'no l10n/bundle.l10n.<lang>.json to check')
  for (const file of bundles) {
    const bundle = JSON.parse(readFileSync(join(dir, file), 'utf8')) as Record<string, string>
    for (const key of Object.keys(DICT)) {
      const value = bundle[key]
      if (typeof value !== 'string') continue
      assert.equal(/[<>"&]/.test(value), false,
        `${file}: markup character in the translation of ${JSON.stringify(key)}: ${JSON.stringify(value)}`)
    }
  }
})

/**
 * The page as it is built with a bundle in place. The seam is module state that every other
 * test here reads, so it is put back whatever happens. `extra` is for a test that needs a
 * word this bundle does not carry; it is merged over the entries below.
 */
function germanPage(extra: Record<string, string> = {}): string {
  try {
    // 1.9 A3.5: the page's `lang` is the words' language (`setLang`), which the host installs with
    // the bundle — no longer derived from the formatters' locale.
    setLocale('de')
    setLang('de')
    setBundle({
      'Loading …': 'Wird geladen …',
      'Range': 'Zeitraum',
      'Providers': 'Anbieter',
      'Models': 'Modelle',
      'Refresh': 'Aktualisieren',
      'today': 'heute',
      'custom…': 'benutzerdefiniert…',
      'Not enough data for a summary yet.': 'Noch nicht genug Daten für eine Zusammenfassung.',
      'Usage': 'Verbrauch',
      'Period': 'Zeitraum',
      ...extra,
    })
    return page()
  } finally {
    setBundle(undefined)
    setLocale(undefined)
    setLang(undefined)
  }
}

test('the page\'s lang is the language its words are in, region kept: pt-BR, zh-TW, en — never the formatters\' tag (1.9 A3.5, A7 test 5)', () => {
  // The three resolved languages of §3 A2 rule 2, as applyLanguage installs them: the words' tag
  // (setLang) beside the Intl tag (setLocale). An English page under VS Code's `hu` keeps `en`.
  const cases: Array<[string, string, string]> = [['pt-BR', 'pt-BR', 'pt-BR'], ['zh-TW', 'zh-TW', 'zh-TW'], ['en', 'hu', 'en'],
    ['de', 'de-ch', 'de'], ['zh-CN', 'zh-CN', 'zh-CN']]
  try {
    for (const [words, intl, expected] of cases) {
      setLang(words)
      setLocale(intl)
      assert.match(page(), new RegExp(`<html lang="${expected}">`), `${words} / ${intl}`)
    }
    // A tag that is no tag never reaches the attribute: `setLang` keeps English.
    setLang('x y"><script>')
    assert.match(page(), /<html lang="en">/)
  } finally {
    setLang(undefined)
    setLocale(undefined)
  }
  assert.match(PAGE, /<html lang="en">/)
})

test('a German bundle reaches the page, the script inside it and the language of the markup', () => {
  const html = germanPage()
  // The markup says which language it is in: a German page announced as English is read out
  // in the wrong accent and hyphenated by the wrong rules.
  assert.match(html, /<html lang="de">/)
  assert.match(PAGE, /<html lang="en">/)
  assert.ok(html.indexOf('Wird geladen …') >= 0, 'the loading line is still English')

  const de = makeContext()
  nodeVm.runInContext(between(html, /<script nonce="[A-Za-z0-9]+">/, '</script>'), de)
  ;(de as Record<string, unknown>).fixture = model(tokensVm({
    range: { from: '2026-08-05', to: '2026-09-03', label: 'Letzte 30 Tage', preset: '30d',
             presets: ['today', '7d', '30d'] },
    // One model, so the bar draws the row that is labelled with it.
    models: { rows: [{ model: 'claude-opus-4-6' }], total: 1, hidden: 0, sort: { key: 'usage', dir: 'desc' } },
  }))
  const bar = String(nodeVm.runInContext('vm = fixture; controls()', de))
  for (const word of ['Zeitraum', 'Modelle', 'Aktualisieren', 'heute', 'benutzerdefiniert…']) {
    assert.ok(bar.indexOf(word) >= 0, `${word} is missing from ${bar}`)
  }
  // 1.7 F1 (pinned and changed: the bar's providers' row said „Anbieter"): the bar has no such row
  // any more; the word names the provider switch's group at the top of the page. 1.9 A3.1 (pinned and
  // changed: the group was the block's whole markup): the group stands in the page's top row.
  assert.equal(bar.indexOf('Anbieter'), -1, bar)
  const sw = String(nodeVm.runInContext('vm = fixture; sProvider()', de))
  assert.ok(sw.startsWith('<div class="top"><div class="pv" role="group" aria-label="Anbieter">'), sw)
  // A section renderer, and with it the tables: the heading and the stacked-layout prefix are
  // the same word, so both have to be the German one.
  const tokens = String(nodeVm.runInContext('vm = fixture; sTokens()', de))
  assert.ok(tokens.indexOf('<th>Verbrauch</th>') >= 0, tokens)
  assert.ok(tokens.indexOf('data-h="Verbrauch"') >= 0, tokens)
  assert.equal(tokens.indexOf('data-h="Usage"'), -1, tokens)
  const summary = String(nodeVm.runInContext('vm = fixture; sSummary()', de))
  assert.ok(summary.indexOf('Noch nicht genug Daten') >= 0, summary)
  // A key this bundle does not carry stays English rather than going blank, and a preset
  // that is a figure rather than a word is a figure in every language.
  assert.ok(bar.indexOf('title="Rebuild from the transcripts and fetch the quota"') >= 0, bar)
  assert.ok(bar.indexOf('>7d</button>') >= 0, bar)

  // The page's own numbers are counted in the page's own language. A chart axis in "2.8M"
  // beside a table in "2,8M" is not two styles, it is two values.
  // 1.9 A3.4 (pinned and changed: a const): a `let`, which the whole push after a language switch sets anew.
  assert.match(html, /\nlet LOCALE = "de";\n/)
  ;(de as Record<string, unknown>).fixture = model({
    chart: {
      days: ['2026-09-05'], labels: ['09-05'],
      series: [{ key: 'claude:claude-opus-4-6', label: 'claude-opus-4-6', source: 'claude', rank: 0, values: [2_800_000] }],
      metric: 'usage', modelStyle: 'pattern', max: 2_800_000,
      ticks: [700_000, 1_400_000, 2_100_000, 2_800_000], weekly: false, costLine: null,
    },
  })
  const chart = String(nodeVm.runInContext('vm = fixture; sChart()', de))
  assert.ok(chart.indexOf('2,8M') >= 0, chart)
  assert.equal(chart.indexOf('2.8M'), -1, chart)
  assert.equal(chart.indexOf('2,800,000'), -1, chart)
  assert.ok(chart.indexOf('2.800.000') >= 0, chart)

  // And the English page every other test reads is untouched by all of this.
  assert.ok(render('sSummary()').indexOf('Not enough data for a summary yet.') >= 0)
})

test('the German page keeps the two reset prepositions apart', () => {
  // "in" for a countdown, "um" for a time of day: the card's fallback picks between two
  // messages precisely because one slot cannot carry both, and a page that shipped only the
  // relative one would word every window "Reset in 14:20". The strings come out of the
  // shipped bundle rather than being typed here, so what this asserts is the German a reader
  // really gets; changing either of them is a deliberate act.
  const bundle = JSON.parse(
    readFileSync(join(__dirname, '..', 'l10n', 'bundle.l10n.de.json'), 'utf8'),
  ) as Record<string, string>
  assert.equal(bundle['resets at {0}'], 'Reset um {0}')
  assert.equal(bundle['resets {0}'], 'Reset in {0}')

  const de = makeContext()
  const html = germanPage({
    'resets at {0}': bundle['resets at {0}'], 'resets {0}': bundle['resets {0}'],
  })
  nodeVm.runInContext(between(html, /<script nonce="[A-Za-z0-9]+">/, '</script>'), de)
  const line = (reset: unknown): string => {
    ;(de as Record<string, unknown>).fixture = win({ reset })
    return String(nodeVm.runInContext('fbResetLine(fixture)', de))
  }
  assert.equal(line('14:20'), 'Reset um 14:20')
  assert.equal(line('3h20m'), 'Reset in 3h20m')
  // The word the card writes into the header row, in the language of the page.
  ;(de as Record<string, unknown>).fixture = model({
    quotas: [card({ windows: [win({ reset: '14:20', verdict: { text: 'on pace', level: 'ok' } })] })],
  })
  const card14 = String(nodeVm.runInContext('vm = fixture; sQuota()', de))
  assert.ok(card14.indexOf('5 h · Reset um 14:20') >= 0, card14)
  assert.equal(card14.indexOf('Reset in 14:20'), -1, card14)
})

// ---------------------------------------------------------------------------
// Wording
// ---------------------------------------------------------------------------

const DISPLAYS = ['normal', 'exhausted', 'overflow', 'unlimited', 'limitReached', 'resetDue']

test('no window can print "resets reset due" or a raw display state', () => {
  for (const display of DISPLAYS) {
    for (const reset of ['3h20m', 'reset due', '14:00 (reset due)', '']) {
      const h = render('sQuota()', {
        quotas: [card({ windows: [win({ display, reset, verdict: { text: 'on pace', level: 'ok' } })] })],
      })
      const why = display + '/' + reset + ': ' + h
      assert.equal(h.indexOf('resets reset due'), -1, why)
      assert.equal(h.indexOf('resetDue'), -1, why)
      assert.equal(h.indexOf('limitReached'), -1, why)
      if (display === 'resetDue') {
        // Once, in the header, whatever the relative text said: the state word beside the
        // verdict used to print it a second time in the same card.
        assert.equal(h.split('reset due').length - 1, 1, why)
        assert.ok(h.indexOf('· reset due') >= 0, why)
        assert.equal(h.indexOf('resets'), -1, why)
      } else if (reset.indexOf('reset due') >= 0) {
        assert.ok(h.indexOf('· ' + reset) >= 0, why)
        assert.equal(h.indexOf('resets'), -1, why)
      } else if (reset) {
        assert.ok(h.indexOf('· resets ' + reset) >= 0, why)
      } else {
        assert.equal(h.indexOf('resets'), -1, why)
      }
    }
  }
})

test('every display state reaches the reader in words', () => {
  const words: Record<string, string> = {
    exhausted: 'exhausted', overflow: 'over the limit', unlimited: 'unlimited',
    limitReached: 'limit reached', resetDue: 'reset due',
  }
  for (const display of Object.keys(words)) {
    const h = render('sQuota()', {
      quotas: [card({ windows: [win({ display, verdict: { text: 'on pace', level: 'ok' } })] })],
    })
    assert.ok(h.indexOf(words[display]) >= 0, display + ': ' + h)
  }
  const normal = render('sQuota()', { quotas: [card({ windows: [win({ display: 'normal' })] })] })
  assert.ok(normal.indexOf('on pace ·') < 0, normal)
})

test('the header and the state take their wording from the view model', () => {
  // One source of wording: the card prints resetLine and stateText and adds nothing of its
  // own, so the QuickPick, the markdown view and this card cannot say a window differently.
  const one = render('sQuota()', {
    quotas: [card({ windows: [win({
      display: 'resetDue', reset: '3h20m', resetLine: 'reset due', stateText: '',
      verdict: { text: 'on pace', level: 'ok' },
    })] })],
  })
  assert.ok(one.indexOf('5 h · reset due') >= 0, one)
  assert.equal(one.split('reset due').length - 1, 1, one)
  assert.equal(one.indexOf('3h20m'), -1, one)
  const over = render('sQuota()', {
    quotas: [card({ windows: [win({
      display: 'overflow', level: 'error', resetLine: 'resets 20m', stateText: 'over the limit',
      verdict: { text: 'ahead of pace', level: 'error' },
    })] })],
  })
  assert.ok(over.indexOf('5 h · resets 20m') >= 0, over)
  assert.ok(over.indexOf('▲ ahead of pace · over the limit') >= 0, over)
  // An empty string is an answer — "nothing to add here" — not a missing field.
  const quiet = render('sQuota()', {
    quotas: [card({ windows: [win({
      display: 'exhausted', level: 'error', resetLine: '', stateText: '',
      verdict: { text: 'exhausted', level: 'error' },
    })] })],
  })
  assert.equal(quiet.indexOf('resets'), -1, quiet)
  assert.ok(quiet.indexOf('<span>5 h</span>') >= 0, quiet)
  assert.equal(/exhausted[^<]*exhausted/.test(quiet), false, quiet)
})

test('the local fallback words a window exactly as the view model would', () => {
  // A payload from a build that predates the two fields still gets one reset line and one
  // state word, in the same words and in the same two places.
  const rows = [
    { display: 'resetDue', reset: '3h20m', header: '5 h · reset due', state: '' },
    { display: 'overflow', reset: '20m', header: '5 h · resets 20m', state: 'over the limit' },
    { display: 'limitReached', reset: '', header: '5 h<', state: 'limit reached' },
    { display: 'normal', reset: '', header: '5 h<', state: '' },
  ]
  for (const r of rows) {
    const h = render('sQuota()', {
      quotas: [card({ windows: [win({
        display: r.display, reset: r.reset, level: 'ok',
        verdict: { text: 'on pace', level: 'ok' },
      })] })],
    })
    assert.ok(h.indexOf(r.header) >= 0, r.display + ': ' + h)
    // The verdict and the state share one span in the header row.
    assert.ok(h.indexOf('on pace' + (r.state ? ' · ' + r.state : '') + '</span>') >= 0,
      r.display + ': ' + h)
  }
})

test('a payload with no reset line reads a clock time as a time and a countdown as a countdown', () => {
  // The same fallback, asked the one question the view model's own wording never has to
  // answer: what kind of text it was handed. A countdown and a time of day take different
  // prepositions in most languages — "resets 3h20m" against "resets at 14:20", "Reset in
  // 3h20m" against "Reset um 14:20" — so there are two messages, and a payload from a build
  // that sent a clock time in this field must reach the right one of them.
  const line = (over: Record<string, unknown>): string => {
    ;(ctx as Record<string, unknown>).fixture = win(over)
    return String(nodeVm.runInContext('fbResetLine(fixture)', ctx))
  }
  // Every shape `formatReset` can hand over that leads with a clock: both hour cycles, the
  // weekday a reset more than a day away carries, and the `both` format's bracketed
  // countdown behind it.
  assert.equal(line({ reset: '14:20' }), 'resets at 14:20')
  assert.equal(line({ reset: '2:05 PM' }), 'resets at 2:05 PM')
  assert.equal(line({ reset: 'Mo 14:20' }), 'resets at Mo 14:20')
  assert.equal(line({ reset: '14:20 (in 3h20m)' }), 'resets at 14:20 (in 3h20m)')
  // A countdown keeps the relative wording — it has no clock in it at any length.
  assert.equal(line({ reset: '3h20m' }), 'resets 3h20m')
  assert.equal(line({ reset: '45m' }), 'resets 45m')
  assert.equal(line({ reset: '2d 5h' }), 'resets 2d 5h')
  // "reset due" is a whole sentence: no verb is hung in front of it, not even when the text
  // it stands in also carries a clock time.
  assert.equal(line({ display: 'resetDue' }), 'reset due')
  assert.equal(line({ display: 'resetDue', reset: '14:20' }), 'reset due')
  assert.equal(line({ reset: 'reset due' }), 'reset due')
  assert.equal(line({ reset: '14:20 (reset due)' }), '14:20 (reset due)')
  // No reset text is silence, never a reset at zero.
  assert.equal(line({ reset: '' }), '')
  assert.equal(line({ reset: null }), '')
  assert.equal(line({ reset: undefined }), '')
  // And the card prints the line once, in the header row beside the label.
  const h = render('sQuota()', {
    quotas: [card({ windows: [win({ reset: '14:20', verdict: { text: 'on pace', level: 'ok' } })] })],
  })
  assert.ok(h.indexOf('<span>5 h · resets at 14:20</span>') >= 0, h)
  assert.equal(h.split('resets at').length - 1, 1, h)
})

test('a forecast that only repeats what the card already printed is dropped', () => {
  const same = (over: Record<string, unknown>, text: string): string => render('sQuota()', {
    quotas: [card({ windows: [win({
      level: 'error', forecast: {
        state: 'full', ratePerHour: null, etaMs: null, endPercent: null,
        sustainablePerHour: null, confidence: null, basis: null, text,
      }, ...over,
    })] })],
  })
  // Once beside the verdict as the state, and not again as the forecast below it.
  const state = same(
    { display: 'exhausted', stateText: 'exhausted', verdict: { text: 'ahead of pace', level: 'error' } },
    'exhausted',
  )
  assert.equal(state.split('exhausted').length - 1, 1, state)
  // The same for a word the reset line has already used.
  const reset = same(
    { display: 'normal', resetLine: 'resets 20m', verdict: { text: 'on pace', level: 'ok' } },
    'resets 20m',
  )
  assert.equal(reset.split('resets 20m').length - 1, 1, reset)
  // A forecast that says something new is still printed.
  const news = same(
    { display: 'exhausted', stateText: 'exhausted', verdict: { text: 'ahead of pace', level: 'error' } },
    'full until the reset',
  )
  assert.ok(news.indexOf('full until the reset') >= 0, news)
})

test('the verdict stands in the header row between the label and the figure', () => {
  const h = render('sQuota()', {
    quotas: [card({ windows: [win({
      level: 'warn', percent: 70, percentText: '70 %', elapsed: 61,
      verdict: { text: '9 % ahead of pace', level: 'warn' },
    })] })],
  })
  const from = h.indexOf('<div class="win-top">')
  const top = h.slice(from, h.indexOf('</div>', from))
  // 1.10 B5 rule 1 (rewritten: the verdict and the figure were two children of the row): the label, then one box
  // (`.vf`) holding the verdict and then the figure — the two wrap together, so a narrow sidebar never leaves the
  // figure alone on a line; the verdict's number kept with its unit (glue).
  assert.equal(top, '<div class="win-top"><span>5 h · resets 3h20m</span><span class="vf">'
    + '<span class="verdict warn">▲ 9\u00a0% ahead of pace</span><b>70 %</b></span>', top)
  // Once, and above the bar — nothing below it repeats the verdict.
  assert.equal(h.split('class="verdict').length - 1, 1, h)
  assert.ok(h.indexOf('class="verdict') < h.indexOf('class="track"'), h)
  // The state word joins the verdict in the same span.
  const state = render('sQuota()', {
    quotas: [card({ windows: [win({
      display: 'exhausted', level: 'error', stateText: 'limit reached',
      verdict: { text: 'exhausted', level: 'error' },
    })] })],
  })
  assert.ok(state.indexOf('<span class="vf"><span class="verdict error">▲ exhausted · limit reached</span><b>61 %</b></span>') >= 0, state)
  // The row wraps in a narrow sidebar; it never clips or ellipsises.
  const row = STYLE.match(/\.win-top \{[^}]*\}/)
  assert.ok(row, 'the header row rule is missing')
  assert.ok(row[0].includes('flex-wrap: wrap'), row[0])
  assert.equal(/nowrap|text-overflow|overflow: hidden/.test(row[0]), false, row[0])
  assert.match(STYLE, /\.verdict \{[^}]*overflow-wrap: anywhere/)
  // 1.10 B5 rule 1: the label takes the room and wraps inside itself; the verdict and the figure are one box that is
  // never shrunk and never wraps inside between them — at most the row wide, the figure on the verdict's last line.
  assert.match(STYLE, /\n\.win-top > span:first-child \{ flex: 1 1 auto; \}/)
  const vf = STYLE.match(/\n\.vf \{[^}]*\}/)
  assert.ok(vf, 'the .vf rule is missing')
  for (const decl of ['display: inline-flex', 'flex: none', 'flex-wrap: nowrap', 'align-items: last baseline', 'margin-left: auto',
    'min-width: 0', 'max-width: 100%']) assert.ok(vf[0].includes(decl), decl + ' — ' + vf[0])
  assert.match(STYLE, /\n\.vf \.verdict \{ min-width: 0; \}/)
  assert.match(STYLE, /\n\.vf b \{ flex: none; \}/)
  assert.match(STYLE, /\n\.win-top\.solo \{ flex-wrap: nowrap; align-items: last baseline; \}/)
})

test('a window whose reset has passed is not judged in colour either', () => {
  // The reading predates the reset — the bar is neutral and the explanation is titled "Why
  // grey" — so the verdict beside them must not contradict both in red.
  const h = render('sQuota()', {
    quotas: [card({ windows: [win({
      display: 'resetDue', level: 'error', percent: 99.8, percentText: '100 %',
      resetLine: 'reset due', stateText: '', verdict: { text: 'exhausted', level: 'error' },
    })] })],
  })
  assert.ok(h.indexOf('<span class="verdict">exhausted</span>') >= 0, h)
  assert.equal(h.indexOf('▲'), -1, h)
  assert.ok(h.indexOf('<div class="fill neutral"') >= 0, h)
})

test('a limit the provider reports as reached wears the alarm colour, whatever the pace said', () => {
  // The status bar paints the alarm for this state at any percentage; a green bar beside a
  // red status-bar item is one window with two colours.
  const h = render('sQuota()', {
    quotas: [card({ windows: [win({
      display: 'limitReached', level: 'ok', percent: 40, percentText: '40 %',
      stateText: 'limit reached', verdict: { text: '20 % of the window still spare', level: 'ok' },
    })] })],
  })
  assert.ok(h.indexOf('<div class="fill error"') >= 0, h)
  assert.equal(h.indexOf('<div class="fill ok"'), -1, h)
})

test('the chip over that bar is red as well, and only a judged window wears the arrow', () => {
  // The bar is red for this state whatever the pace said; the chip in the header row above it
  // is the same window, so a green "20 % of the window still spare" over a red bar would be
  // the card arguing with itself. The arrow follows the chip's colour, so it is there too,
  // although the pace level underneath is 'ok'.
  const reached = render('sQuota()', {
    quotas: [card({ windows: [win({
      display: 'limitReached', level: 'ok', percent: 40, percentText: '40 %',
      stateText: 'limit reached', verdict: { text: '20 % of the window still spare', level: 'ok' },
    })] })],
  })
  assert.ok(reached.indexOf(
    '<span class="verdict error">▲ 20\u00a0% of the window still spare · limit reached</span>') >= 0, reached)
  // The same reading at the same pace level, which no provider has called reached, keeps the
  // pace colour and stays arrow-less: the red is the provider's word about the limit, not a
  // rule the card has invented for 40 %.
  const spare = render('sQuota()', {
    quotas: [card({ windows: [win({
      display: 'normal', level: 'ok', percent: 40, percentText: '40 %',
      verdict: { text: '20 % of the window still spare', level: 'ok' },
    })] })],
  })
  // 1.10 B5 rule 3 (rewritten: the verdict's "20 %" is glued now).
  assert.ok(spare.indexOf('<span class="verdict ok">20\u00a0% of the window still spare</span>') >= 0, spare)
  assert.equal(spare.indexOf('▲'), -1, spare)
  // And a window whose stated reset has passed is judged by nothing at all — the reading
  // belongs to the window before it — so its chip wears no level and no arrow even at 'error'.
  const due = render('sQuota()', {
    quotas: [card({ windows: [win({
      display: 'resetDue', level: 'error', percent: 99.8, percentText: '100 %',
      verdict: { text: 'exhausted', level: 'error' },
    })] })],
  })
  assert.ok(due.indexOf('<span class="verdict">exhausted</span>') >= 0, due)
  assert.equal(due.indexOf('▲'), -1, due)
})

test('a measuring window prints neither its verdict nor its forecast, and no sustainable rate', () => {
  const measuring = {
    state: 'measuring', ratePerHour: null, etaMs: null, endPercent: null, sustainablePerHour: 20,
    confidence: null, basis: { samples: 1, spanMs: 0 }, text: 'measuring · 1 reading over 0 min',
  }
  const h = render('sQuota()', {
    quotas: [card({ windows: [win({
      percent: 3, percentText: '3 %', elapsed: 1,
      verdict: { text: 'measuring · window just reset', level: 'ok', measuring: true },
      forecast: measuring, aria: { now: 3, max: 100, text: '5 h: 3 % used' },
    })] })],
  })
  assert.equal(/measuring/i.test(h), false, h)
  assert.equal(/keeps it to the reset|%\/h/.test(h), false, h)
  assert.equal(h.indexOf('class="verdict'), -1, h)
  // 1.10 B5 rule 1 (rewritten: the figure followed the label directly): without a verdict the row is `solo` — it
  // does not wrap, the label wraps inside itself and the figure, alone in its box, keeps to the label's last line.
  assert.ok(h.indexOf('<div class="win-top solo"><span>5 h · resets 3h20m</span><span class="vf"><b>3 %</b></span></div>') >= 0, h)
  // A measuring forecast is skipped even when the verdict has a pace to report.
  const paced = render('sQuota()', { quotas: [card({ windows: [win({ forecast: measuring })] })] })
  assert.equal(/measuring/.test(paced), false, paced)
  assert.ok(paced.indexOf('>on pace<') >= 0, paced)
  // The sustainable line is gone even from a payload that still carries the field.
  const legacy = render('sQuota()', {
    quotas: [card({ windows: [win({ sustainable: '~17.9 %/h keeps it to the reset' })] })],
  })
  assert.equal(legacy.indexOf('keeps it'), -1, legacy)
})

test('the bar paints the pace gap on whichever side of the marker it lies', () => {
  const ahead = render('sQuota()', {
    quotas: [card({ windows: [win({
      percent: 70, elapsed: 30, level: 'warn', verdict: { text: '40 % ahead of pace', level: 'warn' },
    })] })],
  })
  // Beyond the marker, from the elapsed share to the percentage, in the darkened level colour.
  assert.match(ahead, /<span class="fill over warn" data-x="30\.00" data-w="40\.00"/)
  assert.equal(ahead.indexOf('class="slack"'), -1, ahead)
  // The marker itself is untouched and is drawn after the band, so it stays on top.
  assert.match(ahead, /<i class="mark" data-x="30\.00" title="time elapsed in this window">/)
  assert.ok(ahead.indexOf('fill over') < ahead.indexOf('class="mark"'), ahead)
  // Behind the marker, from the percentage to the elapsed share, as a lighter track.
  const behind = render('sQuota()', { quotas: [card({ windows: [win({ percent: 20, elapsed: 55 })] })] })
  assert.match(behind, /<span class="slack" data-x="20\.00" data-w="35\.00"/)
  assert.equal(behind.indexOf('fill over'), -1, behind)
  assert.match(behind, /<i class="mark" data-x="55\.00"/)
  // Exactly on the clock: no band either way. Over 100 %: the band ends at the bar's edge.
  const even = render('sQuota()', { quotas: [card({ windows: [win({ percent: 30, elapsed: 30 })] })] })
  assert.equal(/fill over|class="slack"/.test(even), false, even)
  const full = render('sQuota()', {
    quotas: [card({ windows: [win({ percent: 130, elapsed: 60, level: 'error' })] })],
  })
  assert.match(full, /<span class="fill over error" data-x="60\.00" data-w="40\.00"/)
  // No clock, a window that has just reset, and an unlimited window have no gap to show.
  const noClock = render('sQuota()', { quotas: [card({ windows: [win({ elapsed: null })] })] })
  assert.equal(/fill over|class="slack"|class="mark"/.test(noClock), false, noClock)
  for (const display of ['resetDue', 'unlimited']) {
    const h = render('sQuota()', { quotas: [card({ windows: [win({ display, percent: 70, elapsed: 30 })] })] })
    assert.equal(/fill over|class="slack"/.test(h), false, display + ': ' + h)
  }
  // The accessibility attributes still describe the bar, not the bands.
  assert.match(ahead, /role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="61" aria-valuetext="61 %"/)
  assert.equal(ahead.split('role="progressbar"').length - 1, 1, ahead)
  // Theme colours only: the level colour mixed toward black, the track's grey lifted.
  for (const level of ['ok', 'warn', 'warn2', 'error']) {
    assert.match(STYLE, new RegExp('\\.fill\\.over\\.' + level + ' \\{ background: color-mix\\(in srgb, var\\(--' + level + '\\) 65%, black\\); \\}'))
  }
  assert.match(STYLE, /\.slack \{[^}]*color-mix\(in srgb, var\(--vscode-foreground\) 30%, transparent\)/)
  assert.match(STYLE, /\.fill\.over \{[^}]*position: absolute/)
})

test('the card keeps its short age but neither the freshness row nor the official page', () => {
  const h = render('sQuota()', { quotas: [card({ usagePageUrl: 'https://claude.ai/settings/usage' })] })
  assert.equal(h.indexOf('official page'), -1, h)
  assert.equal(h.indexOf('https://'), -1, h)
  assert.equal(/last check|last data|last local event|next refresh|snapshot/.test(h), false, h)
  // 1.10 B5 rule 3 (rewritten: the header's meta line is glued — "2 min" never broken between the figure and its unit).
  assert.ok(h.indexOf('<span class="meta">plan max20 · poll · 2\u00a0min ago</span>') >= 0, h)
})

// 1.7 W1: our own fetch failed after the reading the card shows — one dim line directly under the
// card's header row, no glyph, in the view model's words; none without one.
test('a card whose reading outlived a failed fetch says so in one dim line directly under its header (1.7 W1)', () => {
  const sentence = 'Last attempt at 11:40 failed: HTTP 429 — backing off before the next attempt · next attempt in 1h12m'
  const h = render('sQuota()', { quotas: [card({ stale: true, ageText: '2 h ago', lastFailure: sentence }), card({ source: 'codex', title: 'Codex' })] })
  const line = '<div class="meta lastfail">' + sentence + '</div>'
  assert.equal(h.split('class="meta lastfail"').length - 1, 1, h)
  // Directly after the header row, before every window of the card.
  const head = h.indexOf('⚠ stale</span></div>')
  assert.ok(head > 0, h)
  assert.equal(h.indexOf(line), head + '⚠ stale</span></div>'.length, h)
  assert.ok(h.indexOf(line) < h.indexOf('role="progressbar"'), h)
  // No glyph of its own: the header's "⚠ stale" is the one warning.
  assert.equal(/lastfail">[⚠$]/.test(h), false, h)
  // Escaped like every word the model hands over; absent, empty or not a string: no line.
  const odd = render('sQuota()', { quotas: [card({ lastFailure: 'failed: <img src=x onerror=alert(1)>' })] })
  assert.ok(odd.indexOf('<div class="meta lastfail">failed: &lt;img src=x onerror=alert(1)&gt;</div>') >= 0, odd)
  for (const lastFailure of [null, undefined, '', 42, { text: 'x' }]) {
    const none = render('sQuota()', { quotas: [card({ lastFailure })] })
    assert.equal(none.indexOf('lastfail'), -1, JSON.stringify(lastFailure) + ': ' + none)
  }
  // The line from a real view model: the failed reading's card carries it, the other card none.
  const vmHtml = render('sQuota()', buildViewModel(makeInput({ quotas: [
    { source: 'claude', ok: true, origin: 'poll', fetchedAt: Math.round((NOW - 2 * 3_600_000) / 1000), planType: 'max20',
      windows: [], nextAttemptAt: NOW + 72 * 60_000,
      lastFailure: { at: NOW - 20 * 60_000, problem: 'HTTP 429 — backing off before the next attempt', kind: 'retry' } },
  ] })) as unknown as Record<string, unknown>)
  assert.ok(vmHtml.indexOf(line) >= 0, vmHtml)
})

// 1.6 N7: the subagent share of what this machine counted over a window — a dim line under the
// bar (after the forecast, before the sparkline), in the view model's words; no line without one.
test('a window carries its subagent share as a dim line under the bar, and none without one', () => {
  const share = 'Subagents 5.5K of 7K counted here (79 %)'
  const h = render('sQuota()', {
    quotas: [card({ windows: [win({ agentShare: share, agentShareParts: { sub: '5.5K', total: '7K', share: '79 %' },
      forecast: { state: 'eta', text: '~empty in 3 h' }, spark: { points: [], slots: 672, from: 0, to: 1 } })] })],
  })
  // The percent kept whole: a narrow sidebar broke "79 %" between the figure and its unit.
  const line = '<div class="meta agshare">Subagents 5.5K of 7K counted here (<span class="nobr">79 %</span>)</div>'
  assert.equal(h.split('class="meta agshare"').length - 1, 1, h)
  const at = h.indexOf(line)
  assert.ok(at > h.indexOf('role="progressbar"'), h)
  assert.ok(at > h.indexOf('~empty in 3 h'), 'the share comes after the forecast line: ' + h)
  // The figure in the header is the provider's, untouched by it.
  assert.ok(h.indexOf('<b>61 %</b>') >= 0, h)
  assert.ok(h.indexOf('<b>61 %</b>') < at, h)
  assert.match(STYLE, /\n\.meta \{ color: var\(--dim\); font-size: 11px; \}/)
  // Escaped like every word the model hands over; absent, empty or not a string: no line.
  const odd = render('sQuota()', { quotas: [card({ windows: [win({ agentShare: '<img src=x onerror=alert(1)>' })] })] })
  assert.ok(odd.indexOf('<div class="meta agshare">&lt;img src=x onerror=alert(1)&gt;</div>') >= 0, odd)
  // The share is found in the escaped line and escaped itself: "<1 %" stays text.
  const tiny = render('sQuota()', { quotas: [card({ windows: [win({ agentShare: 'Subagents 2K of 1M counted here (<1 %)',
    agentShareParts: { sub: '2K', total: '1M', share: '<1 %' } })] })] })
  assert.ok(tiny.indexOf('<div class="meta agshare">Subagents 2K of 1M counted here (<span class="nobr">&lt;1 %</span>)</div>') >= 0, tiny)
  // Parts that are not in the line, or not strings, wrap nothing.
  for (const agentShareParts of [null, { share: 'x %' }, { share: 5 }, 'parts']) {
    const plain = render('sQuota()', { quotas: [card({ windows: [win({ agentShare: share, agentShareParts })] })] })
    assert.ok(plain.indexOf('<div class="meta agshare">' + share + '</div>') >= 0, JSON.stringify(agentShareParts) + ': ' + plain)
  }
  for (const agentShare of [null, undefined, '', 42, { text: 'x' }]) {
    const none = render('sQuota()', { quotas: [card({ windows: [win({ agentShare })] })] })
    assert.equal(none.indexOf('agshare'), -1, JSON.stringify(agentShare) + ': ' + none)
  }
})

/** 1.6 N7: a data-quality block as the view model builds it, with `over` on top. */
function dataQualityOf(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    roots: ['~/.claude'], files: 2, oldestDay: '2026-08-01', newestDay: '2026-09-03',
    buckets: { hour: 10, day: 5, month: 0 }, snapshotBytes: 4096, lowerBoundShare: '3 %',
    unpricedModels: [], familyPriced: [], quota: [], consent: 'network access granted', leader: 'leader',
    retention: { hourDays: 45, days: 400, historyDays: 30 }, history: { samples: 3, bytes: 2048, oldest: null },
    calibration: [], bridge: null, attribution: 'none', version: '1.6.0', agents: null, ...over,
  }
}

// 1.10 B2 D6 (pinned and changed: "Agent records, last 7 days" and "a record keeps a whole agent"): an agent's data is
// an entry — "record" is a personal best of the Records section.
test('the data-quality list holds the agent entries against the subagent hour buckets, with its note (1.6 N7)', () => {
  const agents = { records: '7.5K', buckets: '≈5.5K', note: 'The two differ by construction: an agent entry keeps a whole agent, a bucket the hour of each reply.' }
  const h = render('sDataQuality()', { dataQuality: dataQualityOf({ agents }) })
  const item = '<li>Agent entries, last 7 days: 7.5K · Subagent tokens in the hour buckets, last 7 days: ≈5.5K'
    + '<div class="meta agnote">' + agents.note + '</div></li>'
  assert.ok(h.indexOf(item) >= 0, h)
  // After the lower-bound line, before the retention, as the markdown lists it.
  // 1.10 B5 rule 3 (rewritten: the list's lines are glued — "3 %", "45 d" kept with their units).
  assert.ok(h.indexOf('Lower bound share 3\u00a0%') < h.indexOf(item), h)
  assert.ok(h.indexOf(item) < h.indexOf('Retention 45\u00a0d hourly'), h)
  // The view model's words and figures, escaped; only the two labels are the page's.
  const odd = render('sDataQuality()', { dataQuality: dataQualityOf({ agents: { records: '<b>', buckets: '&', note: '<i>n</i>' } }) })
  assert.ok(odd.indexOf('Agent entries, last 7 days: &lt;b&gt; · Subagent tokens in the hour buckets, last 7 days: &amp;'
    + '<div class="meta agnote">&lt;i&gt;n&lt;/i&gt;</div>') >= 0, odd)
  for (const x of [null, undefined, { records: 1, buckets: '2', note: 'n' }, 'agents']) {
    const none = render('sDataQuality()', { dataQuality: dataQualityOf({ agents: x }) })
    assert.equal(none.indexOf('Agent entries'), -1, JSON.stringify(x) + ': ' + none)
  }
  // The labels are the page's words, German on a German page; the old label is none of them.
  for (const k of ['Agent entries, last 7 days', 'Subagent tokens in the hour buckets, last 7 days']) {
    assert.ok(Object.prototype.hasOwnProperty.call(DICT, k), k)
  }
  assert.equal(Object.prototype.hasOwnProperty.call(DICT, 'Agent records, last 7 days'), false)
  const bundle = JSON.parse(readFileSync(join(__dirname, '..', 'l10n', 'bundle.l10n.de.json'), 'utf8')) as Record<string, string>
  assert.equal(bundle['Agent entries, last 7 days'], 'Agent-Einträge, letzte 7 Tage')
  assert.equal(bundle['Subagent tokens in the hour buckets, last 7 days'], 'Subagent-Token in den Stunden-Buckets, letzte 7 Tage')
  const de = makeContext()
  nodeVm.runInContext(between(germanPage({ 'Agent entries, last 7 days': bundle['Agent entries, last 7 days'] }), /<script nonce="[A-Za-z0-9]+">/, '</script>'), de)
  ;(de as Record<string, unknown>).fixture = model({ dataQuality: dataQualityOf({ agents }) })
  assert.ok(String(nodeVm.runInContext('vm = fixture; sDataQuality()', de)).indexOf('<li>Agent-Einträge, letzte 7 Tage: 7.5K · ') >= 0)
})

test('the calendar table\'s column counts days and says so — Active days, Aktive Tage — and Active is no word of the page any more: a session\'s state (1.10 B2 D2)', () => {
  const h = render('sTokens()', tokensVm())
  const heads = [...h.matchAll(/<th[^>]*>([^<]*)<\/th>/g)].map((m) => m[1])
  assert.ok(heads.includes('Active days'), heads.join(' | '))
  assert.equal(heads.includes('Active'), false, heads.join(' | '))
  // The stacked cell names the same head (the ≤320 px layout prints it before the value).
  assert.ok(h.indexOf('<td data-h="Active days" data-hl="Active days:">1</td>') >= 0, h)
  assert.equal(Object.prototype.hasOwnProperty.call(DICT, 'Active days'), true)
  assert.equal(Object.prototype.hasOwnProperty.call(DICT, 'Active'), false, 'Active is a session\'s state, the text views\' word — not the page\'s')
  // German: the model part's "Aktive Tage", copied into the page's words — one translation in both parts.
  const bundle = JSON.parse(readFileSync(join(__dirname, '..', 'l10n', 'bundle.l10n.de.json'), 'utf8')) as Record<string, string>
  assert.equal(bundle['Active days'], 'Aktive Tage')
  assert.equal(bundle['Active'], 'Aktiv')
  const de = makeContext()
  nodeVm.runInContext(between(germanPage({ 'Active days': bundle['Active days'] }), /<script nonce="[A-Za-z0-9]+">/, '</script>'), de)
  ;(de as Record<string, unknown>).fixture = model(tokensVm())
  const deHtml = String(nodeVm.runInContext('vm = fixture; sTokens()', de))
  assert.ok(deHtml.indexOf('<th>Aktive Tage</th>') >= 0, deHtml)
  assert.equal(deHtml.indexOf('<th>Aktiv</th>'), -1, deHtml)
})

test('a model\'s turn line names what its figures are — Avg turn time, Ø Turn-Dauer — with and without the P90 (1.10 B2 D5)', () => {
  const rows = (turnP90: string | null): Record<string, unknown> => ({
    models: { rows: [modelRow({ turnAvg: '42 s', turnP90 })], total: 1, hidden: 0, sort: { key: 'usage', dir: 'desc' } },
  })
  // 1.10 P20 (rewritten: the turn line is glued — §3 B5 rule 3; "42 s", "1 min", "10 s" kept with their units).
  assert.ok(render('sModels()', rows('1 min 10 s')).indexOf('<td colspan="99" class="meta">' + glued('Avg turn time 42 s · P90 1 min 10 s') + '</td>') >= 0)
  assert.ok(render('sModels()', rows(null)).indexOf('<td colspan="99" class="meta">' + glued('Avg turn time 42 s') + '</td>') >= 0)
  assert.equal(Object.keys(DICT).some((k) => k.startsWith('Avg turn {')), false)
  const bundle = JSON.parse(readFileSync(join(__dirname, '..', 'l10n', 'bundle.l10n.de.json'), 'utf8')) as Record<string, string>
  assert.equal(bundle['Avg turn time {0}'], 'Ø Turn-Dauer {0}')
  assert.equal(bundle['Avg turn time {0} · P90 {1}'], 'Ø Turn-Dauer {0} · P90 {1}')
  const de = makeContext()
  nodeVm.runInContext(between(germanPage({
    'Avg turn time {0}': bundle['Avg turn time {0}'], 'Avg turn time {0} · P90 {1}': bundle['Avg turn time {0} · P90 {1}'],
  }), /<script nonce="[A-Za-z0-9]+">/, '</script>'), de)
  ;(de as Record<string, unknown>).fixture = model(rows('1 min 10 s'))
  assert.ok(String(nodeVm.runInContext('vm = fixture; sModels()', de)).indexOf('>' + glued('Ø Turn-Dauer 42 s · P90 1 min 10 s') + '</td>') >= 0)
  // 1.10 P20: the durations the model writes ("~18 h 46 min") never break between a figure and its unit — the line a
  // longer translation wraps at 260 px (it, pt-br, ja, ru in the harness) holds no plain space before a unit.
  const long = String(render('sModels()', {
    models: { rows: [modelRow({ turnAvg: '~12 h 05 min', turnP90: '~18 h 46 min' })], total: 1, hidden: 0, sort: { key: 'usage', dir: 'desc' } },
  }))
  const line = /<td colspan="99" class="meta">([^<]*)<\/td>/.exec(long)
  assert.ok(line, long)
  assert.equal(line[1], 'Avg turn time ~12\u00a0h 05\u00a0min · P90 ~18\u00a0h 46\u00a0min')
  assert.equal(/\d (min|h|s)(?!\p{L})/u.test(line[1]), false, line[1])
})

test('the state is dropped when the verdict already says the same word', () => {
  const h = render('sQuota()', {
    quotas: [card({
      windows: [win({
        display: 'exhausted', level: 'error', verdict: { text: 'exhausted', level: 'error' },
      })],
    })],
  })
  assert.equal(/exhausted[^<]*exhausted/.test(h), false, h)
  assert.ok(h.indexOf('▲ exhausted') >= 0, h)
})

test('an unknown display state prints nothing rather than its identifier', () => {
  const h = render('sQuota()', { quotas: [card({ windows: [win({ display: 'somethingNew' })] })] })
  assert.equal(h.indexOf('somethingNew'), -1, h)
  // And a key that every object answers must not turn into markup.
  for (const display of ['constructor', 'toString', '__proto__']) {
    const odd = render('sQuota()', { quotas: [card({ windows: [win({ display })] })] })
    assert.equal(/function|\[object/.test(odd), false, display + ': ' + odd)
  }
  const src = render('sHistory()', {
    retro: [{ source: 'constructor', windowId: 'x', label: '5 h', retro: null, text: 'x' }],
  })
  assert.equal(/function|\[object/.test(src), false, src)
})

test('a window whose reset has passed is not told it is full', () => {
  // The bar is painted neutral because the percentage predates the reset; a forecast built
  // on the same percentage must not assert it as a fact one line below.
  const h = render('sQuota()', {
    quotas: [card({
      windows: [win({
        display: 'resetDue', percentText: '100 %', percent: 100,
        verdict: { text: 'on pace', level: 'ok' },
        forecast: {
          state: 'full', ratePerHour: null, etaMs: null, endPercent: null,
          sustainablePerHour: null, confidence: null, basis: null, text: 'full',
        },
      })],
    })],
  })
  assert.equal(/<div class="meta">full<\/div>/.test(h), false, h)
  assert.ok(h.indexOf('reset due') >= 0, h)
  // A window that is genuinely full still says it.
  const full = render('sQuota()', {
    quotas: [card({
      windows: [win({
        display: 'exhausted', level: 'error', verdict: { text: 'exhausted', level: 'error' },
        forecast: {
          state: 'full', ratePerHour: null, etaMs: null, endPercent: null,
          sustainablePerHour: null, confidence: null, basis: null,
          text: 'full until the reset in 3 h',
        },
      })],
    })],
  })
  // 1.10 B5 rule 3 (rewritten: the forecast line is glued).
  assert.ok(full.indexOf('<div class="meta">full until the reset in 3\u00a0h</div>') >= 0, full)
})

test('the footer prints "Prices as of" exactly once, whichever side carries it', () => {
  const withNote = render('sFooter()')
  assert.equal(withNote.split('Prices as of').length - 1, 1, withNote)
  // 1.10 B5 rule 2 (rewritten: the day stood bare): the day in a .nobr span.
  assert.ok(withNote.indexOf('Generated <span class="nobr">2026-09-03</span> 12:00') >= 0, withNote)
  // A model that has no such footnote still gets the sentence, once.
  const without = render('sFooter()', { footnotes: ['Local numbers are what this machine saw.'] })
  assert.equal(without.split('Prices as of').length - 1, 1, without)
  // 1.8 P11: a row read after the table's check is named with its own day there too, escaped.
  const later = render('sFooter()', {
    footnotes: ['Local numbers are what this machine saw.'],
    pricing: { asOf: '2026-09-02', later: 'claude-opus-5-5 (2026-09-24)', custom: false, showList: false },
  })
  assert.equal(later.split('Prices as of').length - 1, 1, later)
  // 1.10 B5 rule 2 (rewritten: the days stood bare): each day in a .nobr span.
  assert.ok(later.includes('<li>Prices as of <span class="nobr">2026-09-02</span>; checked later: claude-opus-5-5 (<span class="nobr">2026-09-24</span>).</li>'), later)
  const laterCustom = render('sFooter()', {
    footnotes: [], pricing: { asOf: '2026-09-02', later: '<b>x</b> (2026-09-24)', custom: true, showList: false },
  })
  assert.ok(laterCustom.includes('Prices as of <span class="nobr">2026-09-02</span>; checked later: &lt;b&gt;x&lt;/b&gt; (<span class="nobr">2026-09-24</span>) · your configured rates.'), laterCustom)
})

// ---------------------------------------------------------------------------
// Telling the two providers apart
// ---------------------------------------------------------------------------

test('every window that stands on its own says whose window it is', () => {
  const claude = heading('Claude Code', '5 h')
  const h = render('sHistory()', {
    retro: [
      { source: 'claude', windowId: 'session:300', label: '5 h', retro: null, text: 'peaked at 61 %' },
      { source: 'codex', windowId: 'session:300', label: '5 h', retro: null, text: 'peaked at 12 %' },
    ],
  })
  assert.ok(h.indexOf('<b>' + claude + '</b>') >= 0, h)
  assert.ok(h.indexOf('<b>' + heading('Codex', '5 h') + '</b>') >= 0, h)
  // The heading is the label, never the internal id.
  assert.equal(h.indexOf('session:300'), -1, h)
})

test('the provider is named, not keyed, wherever the reader sees it', () => {
  // 1.7 F1 (pinned and changed: the filter bar's provider chips named them): the names moved to the
  // provider switch at the top of the page, and the bar names no provider at all.
  const chips = render('sProvider()')
  assert.ok(chips.indexOf('data-src="claude"') >= 0, chips)
  assert.ok(chips.indexOf('>Claude Code</button>') >= 0, chips)
  assert.ok(chips.indexOf('>Codex</button>') >= 0, chips)
  assert.equal(/>(claude|codex)</.test(chips), false, chips)
  const bar = render('controls()')
  assert.equal(/data-src=|Claude Code|Codex/.test(bar), false, bar)
  const chart = render('sChart()', {
    chart: {
      days: ['2026-09-01', '2026-09-02', '2026-09-03'],
      labels: ['09-01', '09-02', '09-03'],
      series: [{ key: 'claude:claude-opus-4-6', label: 'claude-opus-4-6', source: 'claude', rank: 0, values: [10, 20, 30] },
        { key: 'codex:gpt-5.3-codex', label: 'gpt-5.3-codex', source: 'codex', rank: 0, values: [1, 2, 3] }],
      metric: 'usage', modelStyle: 'pattern', max: 30, ticks: [10, 20, 30, 40], weekly: false, costLine: null,
    },
  })
  // The legend groups the bands under the provider's name, and the tooltip of a band names
  // the provider the same way: a legend that says "Claude Code" over a title that says
  // "claude" is two names for one series.
  assert.ok(chart.indexOf('<span class="meta">Claude Code</span>') >= 0, chart)
  assert.ok(chart.indexOf('<span class="meta">Codex</span>') >= 0, chart)
  assert.ok(chart.indexOf('title="claude-opus-4-6 \u00b7 Claude Code \u00b7 10 \u00b7') >= 0, chart)
  assert.ok(chart.indexOf('title="gpt-5.3-codex \u00b7 Codex \u00b7 3 \u00b7') >= 0, chart)
  assert.ok(chart.indexOf('\u00b7 Claude Code total 10"') >= 0, chart)
  assert.equal(/\u00b7 (claude|codex)( |")/.test(chart), false, chart)
})

test('every band wears its provider hue and its rank, and the legend groups them by provider', () => {
  const bands = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
    days: ['2026-09-01', '2026-09-02', '2026-09-03'],
    labels: ['09-01', '09-02', '09-03'],
    series: [
      { key: 'claude:claude-opus-4-6', label: 'claude-opus-4-6', source: 'claude', rank: 0, values: [10, 20, 30] },
      { key: 'claude:claude-sonnet-4-6', label: 'claude-sonnet-4-6', source: 'claude', rank: 1, values: [4, 4, 4] },
      { key: 'claude:other', label: 'other', source: 'claude', rank: 'other', values: [1, 1, 1] },
      { key: 'codex:gpt-5.3-codex', label: 'gpt-5.3-codex', source: 'codex', rank: 0, values: [5, 4, 3] },
    ],
    metric: 'usage', modelStyle: 'pattern', max: 40, ticks: [10, 20, 30, 40], weekly: false, costLine: null,
    ...over,
  })
  const chart = render('sChart()', { chart: bands() })
  // The classes name the provider, the rank and the style: the hue is the provider's, the
  // rank varies it, and the fold is a rank of its own.
  assert.ok(chart.indexOf('<div class="seg band s-claude-0 hue-claude r0 st-pattern"') >= 0, chart)
  assert.ok(chart.indexOf('<div class="seg band s-claude-1 hue-claude r1 st-pattern"') >= 0, chart)
  assert.ok(chart.indexOf('<div class="seg band s-claude-other hue-claude rother st-pattern"') >= 0, chart)
  assert.ok(chart.indexOf('<div class="seg band s-codex-0 hue-codex r0 st-pattern"') >= 0, chart)
  // One legend entry per band with exactly the band's classes, grouped under the provider,
  // the model names verbatim and the fold named as what it is.
  const legend = chart.slice(chart.indexOf('<div class="legend">'))
  assert.ok(legend.indexOf('<span class="meta">Claude Code</span><span><i class="dot band s-claude-0 hue-claude r0 st-pattern"></i>claude-opus-4-6</span>') >= 0, legend)
  assert.ok(legend.indexOf('<i class="dot band s-claude-1 hue-claude r1 st-pattern"></i>claude-sonnet-4-6</span>') >= 0, legend)
  assert.ok(legend.indexOf('<i class="dot band s-claude-other hue-claude rother st-pattern"></i>other</span>'
    + '<span class="meta">Codex</span><span><i class="dot band s-codex-0 hue-codex r0 st-pattern"></i>gpt-5.3-codex</span>') >= 0, legend)
  assert.equal(legend.split('class="meta"').length - 1, 2, legend)
  // The tooltip: model, provider, value, share of the column, and the provider's column total.
  assert.ok(chart.indexOf('title="claude-opus-4-6 · Claude Code · 10 · 50 % of the day · Claude Code total 15"') >= 0, chart)
  assert.ok(chart.indexOf('title="gpt-5.3-codex · Codex · 3 · 7.9 % of the day · Codex total 3"') >= 0, chart)
  // The column is still the day's drill, and there is no stacking to switch any more.
  assert.ok(chart.indexOf('data-act="drill" data-day="2026-09-01"') >= 0, chart)
  assert.equal(chart.indexOf('data-act="chartStack"'), -1, chart)
  assert.equal(chart.indexOf('by provider'), -1, chart)

  // The style is the setting's word, on bands and swatches alike — twelve bands and four
  // swatches here — and a word the page has no rules for falls back to the pattern rather
  // than to an unstyled band.
  for (const [style, cls] of [['shade', 'st-shade'], ['both', 'st-both'], ['neon', 'st-pattern']]) {
    const h = render('sChart()', { chart: bands({ modelStyle: style }) })
    assert.equal(h.split(' ' + cls + '"').length - 1, 16, style + ': ' + h)
    for (const other of ['st-pattern', 'st-shade', 'st-both']) {
      if (other !== cls) assert.equal(h.indexOf(other), -1, style + ' also wears ' + other)
    }
  }
  // Weekly bars share a week, not a day.
  const weekly = render('sChart()', { chart: bands({ weekly: true }) })
  assert.ok(weekly.indexOf('% of the week ·') >= 0, weekly)
  // One function hands the classes out, to bands and swatches alike; nothing else decides.
  assert.equal(SOURCE.split('function bandStyle(').length - 1, 1)
  assert.equal(SOURCE.indexOf('segClass'), -1)
  assert.ok(SOURCE.indexOf('class="seg \' + bandStyle(') >= 0)
  assert.ok(SOURCE.indexOf('class="dot \' + bandStyle(') >= 0)
})

test('split by main session and subagent, the chart draws two bands per provider under a pressed chip, and its legend names each (1.6 O2)', () => {
  const split = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
    days: ['2026-09-01', '2026-09-02', '2026-09-03'],
    labels: ['09-01', '09-02', '09-03'],
    series: [
      { key: 'claude:main', label: 'Claude Code · main sessions', source: 'claude', rank: 0, values: [10, 20, 30] },
      { key: 'claude:sub', label: 'Claude Code · subagents', source: 'claude', rank: 1, values: [30, 20, 10] },
      { key: 'codex:main', label: 'Codex · main sessions', source: 'codex', rank: 0, values: [5, 4, 3] },
    ],
    metric: 'usage', modelStyle: 'pattern', split: 'agents', max: 60, ticks: [15, 30, 45, 60], weekly: false, costLine: null,
    ...over,
  })
  const h = render('sChart()', { chart: split() })
  // The chip beside the metric, pressed while the chart is split; the cost line's button after it.
  const row = h.slice(0, h.indexOf('<div class="plot">'))
  assert.ok(row.indexOf('</select><button data-act="chartSplit" aria-pressed="true">subagents</button>') >= 0, row)
  const byModel = render('sChart()', { chart: split({ split: 'model', costLine: [1, 2, 3] }) })
  assert.ok(byModel.indexOf('</select><button data-act="chartSplit" aria-pressed="false">subagents</button>'
    + '<button data-act="costLine"') >= 0, byModel)
  // A chart without the field — an older payload — is the split by model, the chip not pressed.
  const { split: _s, ...older } = split()
  assert.ok(render('sChart()', { chart: older }).indexOf('aria-pressed="false">subagents</button>') >= 0)
  // Each band wears its rank and its part: the main sessions the plain hue, the subagents the
  // first pattern — and the part is what a forced-colours theme paints them by.
  assert.ok(h.indexOf('<div class="seg band s-claude-0 hue-claude r0 st-pattern sp-main"') >= 0, h)
  assert.ok(h.indexOf('<div class="seg band s-claude-1 hue-claude r1 st-pattern sp-sub"') >= 0, h)
  assert.ok(h.indexOf('<div class="seg band s-codex-0 hue-codex r0 st-pattern sp-main"') >= 0, h)
  // The legend: no provider headings — each label names its provider — every swatch its band's classes.
  const legend = h.slice(h.indexOf('<div class="legend">'))
  assert.equal(legend.indexOf('class="meta"'), -1, legend)
  assert.ok(legend.startsWith('<div class="legend"><span><i class="dot band s-claude-0 hue-claude r0 st-pattern sp-main"></i>Claude Code · main sessions</span>'
    + '<span><i class="dot band s-claude-1 hue-claude r1 st-pattern sp-sub"></i>Claude Code · subagents</span>'
    + '<span><i class="dot band s-codex-0 hue-codex r0 st-pattern sp-main"></i>Codex · main sessions</span>'), legend)
  // The tooltip names the provider once — in the label — then the value, the share and the provider's total.
  assert.ok(h.indexOf('title="Claude Code · subagents · 30 · 66.7 % of the day · Claude Code total 40"') >= 0, h)
  assert.ok(h.indexOf('title="Codex · main sessions · 5 · 11.1 % of the day · Codex total 5"') >= 0, h)
  assert.ok(render('sChart()', { chart: split({ weekly: true }) }).indexOf('title="Claude Code · subagents · 30 · 66.7 % of the week · Claude Code total 40"') >= 0)
  // Split by model nothing of the split is drawn: no part class, the headings back.
  assert.equal(/sp-(main|sub)/.test(byModel), false, byModel)
  assert.ok(byModel.indexOf('<span class="meta">Claude Code</span>') >= 0, byModel)
  // A style is a style in the split too: the shade and both styles name their part alike.
  const shade = render('sChart()', { chart: split({ modelStyle: 'shade' }) })
  assert.ok(shade.indexOf('<div class="seg band s-claude-1 hue-claude r1 st-shade sp-sub"') >= 0, shade)
  // Everything the payload names is escaped on the way in.
  const evil = render('sChart()', { chart: split({ series: [{ key: 'claude:main', label: '<b>x</b>', source: 'claude', rank: 0, values: [1, 1, 1] }] }) })
  assert.equal(evil.indexOf('<b>'), -1, evil)
})

test('the "subagents" chip asks for the other split, and the page redraws only what the host pushes (1.6 O2)', () => {
  const a = agentCtx()
  const pageWith = (split: string): void => a.fire('window:message', {
    origin: '', data: { type: 'data', payload: model({ sections: ['chart'], chart: { ...(model().chart as Record<string, unknown>), split } }) },
  })
  const chip = { tagName: 'BUTTON', dataset: { act: 'chartSplit' } }
  const click = (): void => a.fire('document:click', { target: { closest: () => chip }, stopPropagation: () => undefined, preventDefault: () => undefined })
  pageWith('model')
  a.posted.length = 0
  click()
  assert.deepEqual(a.posted, [{ type: 'setChartSplit', split: 'agents' }])
  pageWith('agents')
  a.posted.length = 0
  click()
  assert.deepEqual(a.posted, [{ type: 'setChartSplit', split: 'model' }])
  // Every message the chip posts is one the host's parser takes.
  const { parseWebviewMessage } = require('../src/viewModel') as typeof import('../src/viewModel')
  for (const m of [{ type: 'setChartSplit', split: 'agents' }, { type: 'setChartSplit', split: 'model' }]) {
    assert.deepEqual(parseWebviewMessage(m), m)
  }
})

test('a forced-colours theme keeps the two parts of a split column apart, in its own colours and with its adjustment on (1.6 O2)', () => {
  // The one forced-colours block of the page (1.6 N9's): the main sessions solid in the text
  // colour, the subagents the page colour ringed inside by the text colour — the theme removes
  // every gradient and gives every other background the page's own, which would paint both away.
  const forced = STYLE.slice(STYLE.indexOf('@media (forced-colors: active) {'))
  const block = forced.slice(0, forced.indexOf('\n}') + 2)
  assert.equal(STYLE.split('@media (forced-colors: active) {').length - 1, 1, 'a second forced-colours block')
  assert.match(block, /\n {2}\.band\.sp-main \{ background: CanvasText; \}\n/)
  assert.match(block, /\n {2}\.band\.sp-sub \{ background: Canvas; outline: 1px solid CanvasText; outline-offset: -1px; \}\n/)
  // No gradient in the split's two rules — the theme would take it — and the theme's own adjustment
  // left on for them. 1.7 D-B (pinned and changed: 1.6 drew no gradient in the block at all and took
  // nothing but a pressed chip out of the adjustment): the bands by model are taken out and drawn as
  // patterns of the theme's two colours (the D-B test below), and `:not(.sp-main, .sp-sub)` keeps
  // every one of those rules off the split's two parts, which carry a rank class too.
  // 1.8 L-5 (pinned and changed: the split had two rules, both in the adjustment): a subagents' band drawn
  // under 4 px tall has a third, striped and taken out of the adjustment for it (the test below).
  const split = block.split('\n').filter((l) => /\.sp-(main|sub)/.test(l) && !/:not\(/.test(l))
  assert.deepEqual(split.map((l) => l.trim().slice(0, l.trim().indexOf(' {'))), ['.band.sp-main', '.band.sp-sub', '.band.sp-sub.band-thin'], block)
  assert.equal(split.slice(0, 2).some((l) => /gradient|forced-color-adjust/.test(l)), false, split.join('\n'))
  // 1.7 P7b (pinned and changed: one `:not`): the ring is a rule of its own, kept off a thin band too.
  assert.ok(block.split('\n').filter((l) => /^ {2}\.band/.test(l)).every((l) => /\.sp-(main|sub)(\.band-thin)? \{/.test(l) || /:not\(\.sp-main, \.sp-sub(?:, \.band-thin)?\) \{/.test(l)), block)
  assert.deepEqual(adjustedOut(), ADJUSTED_OUT)
  // The block stands after every band rule, so at the same specificity it is the one that wins.
  assert.ok(STYLE.indexOf('@media (forced-colors: active) {') > STYLE.indexOf('.st-pattern.rother, .st-both.rother'))
  assert.ok(STYLE.indexOf('@media (forced-colors: active) {') > STYLE.indexOf('.band.r0 { background: var(--hue); }'))
})

// 1.7 D-B: split by model, a forced-colours theme painted all eight distinct band paints as the page
// colour (1.6 P12b's note): it removes every gradient and gives every other background the page's own.
test('a forced-colours theme draws the chart\'s bands by model as patterns of its own two colours, ringed by the page colour, and leaves the split\'s two parts their rules (1.7 D-B)', () => {
  const forced = STYLE.slice(STYLE.indexOf('@media (forced-colors: active) {'))
  const block = forced.slice(0, forced.indexOf('\n}') + 2)
  assert.equal(STYLE.split('@media (forced-colors: active) {').length - 1, 1, 'a second forced-colours block')
  // The nine rules, in the one forced-colours block, in this order: the band taken out of the
  // theme's adjustment, then ringed 1 px inside by the page colour, then its paint by rank — the rank
  // as the pattern style draws it, in the text colour on the page colour. 1.7 P7b (pinned and changed:
  // the ring stood in the first rule, seven rules): the ring is a rule of its own, kept off a band
  // drawn under 4 px tall (`band-thin`), which it would cover whole; and on such a band the dots of
  // `other` stand in its middle, where a band under 2 px still has them.
  const not = ':not(.sp-main, .sp-sub)'
  const want = [
    '.band' + not + ' { forced-color-adjust: none; background: Canvas; }',
    '.band:not(.sp-main, .sp-sub, .band-thin) { outline: 1px solid Canvas; outline-offset: -1px; }',
    '.band.r0' + not + ' { background: CanvasText; }',
    '.band.r1' + not + ' { background: repeating-linear-gradient(45deg, CanvasText 0 2px, Canvas 2px 4px); }',
    '.band.r2' + not + ' { background: repeating-linear-gradient(135deg, CanvasText 0 2px, Canvas 2px 4px); }',
    '.band.r3' + not + ' { background: repeating-linear-gradient(45deg, CanvasText 0 1px, transparent 1px 4px), '
      + 'repeating-linear-gradient(135deg, CanvasText 0 1px, Canvas 1px 4px); }',
    '.band.r4' + not + ' { background: repeating-linear-gradient(0deg, CanvasText 0 2px, Canvas 2px 4px); }',
    '.band.rother' + not + ' { background: radial-gradient(CanvasText 1px, Canvas 1.2px); background-size: 4px 4px; }',
    '.band.band-thin.rother' + not + ' { background-position: 0 50%; }',
  ]
  const got = [...block.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/\n {2}(\.band[^{]*:not\(\.sp-main, \.sp-sub(?:, \.band-thin)?\) \{[^}]*\})/g)]
    .map((m) => m[1].replace(/\s+/g, ' '))
  assert.deepEqual(got, want, block)
  // System colours only — the text's and the page's, and nothing between the lines of the cross-hatch —
  // never a theme variable, a literal or a mix: the theme's two colours are all a forced palette has.
  const words = new Set(got.join(' ').replace(/^[^{]*\{|\}[^{]*\{/g, ' ').match(/[A-Za-z][A-Za-z-]*/g) ?? [])
  const colours = [...words].filter((x) => !['forced-color-adjust', 'none', 'outline', 'solid', 'outline-offset', 'background', 'background-size',
    'background-position', 'repeating-linear-gradient', 'radial-gradient', 'px', 'deg'].includes(x)).sort()
  assert.deepEqual(colours, ['Canvas', 'CanvasText', 'transparent'], [...words].join(' '))
  assert.equal(/var\(|#[0-9a-f]{3}|rgb|hsl|color-mix/i.test(got.join('\n')), false, got.join('\n'))
  // Every rank the page hands out has its rule, the plain rank the solid one — the classes bandStyle
  // writes for a band and for its legend swatch alike.
  const src = readFileSync(join(__dirname, '..', 'src', 'webview', 'main.ts'), 'utf8')
  assert.ok(src.includes("return 'band s-' + s + '-' + r + ' hue-' + s + ' r' + r + ' st-' + st"), 'the band classes moved')
  // Specificity: each rank's rule outranks the plain band's and every rule outside the mode.
  assert.ok(STYLE.indexOf('@media (forced-colors: active) {') > STYLE.indexOf('.st-pattern.rother, .st-both.rother'))
  // The split's two rules follow them unchanged, without the :not, in the adjustment. 1.7 P7b (pinned and
  // changed: they followed the `other` rule directly): after the thin band's `other` rule. 1.8 L-5 (pinned
  // and changed: the block ended on them): then the thin subagents' band's stripes (the L-5 test).
  assert.match(block.replace(/\n {2}\/\*[\s\S]*?\*\//g, ''), /\.band\.rother:not\(\.sp-main, \.sp-sub\) \{[^}]*\}\n {2}\.band\.band-thin\.rother:not\(\.sp-main, \.sp-sub\) \{ background-position: 0 50%; \}\n {2}\.band\.sp-main \{ background: CanvasText; \}\n {2}\.band\.sp-sub \{ background: Canvas; outline: 1px solid CanvasText; outline-offset: -1px; \}\n {2}\.band\.sp-sub\.band-thin \{[^}]*\}\n\}/)
  // Taken out of the adjustment beside the pressed chip — and, 1.8 L-5, a thin subagents' band — and nothing else is.
  assert.deepEqual(adjustedOut(), ADJUSTED_OUT)
})

// 1.7 P7b (the lead's decision on P5's D-B question): the 1 px ring of the page colour, drawn inside a
// band at its top and at its bottom, covers a band under 4 px tall whole — a gap in the column where a
// band is. So the page measures every band of the chart as the browser drew it and hands such a band
// `band-thin`, and the forced-colours block keeps the ring off it: its pattern or its solid paint alone.
test('a band of the chart drawn under 4 px tall wears band-thin, measured as drawn, and a forced-colours theme draws it without the ring (1.7 P7b)', () => {
  const a = agentCtx()
  const doc = (a.c as Record<string, unknown>).document as Record<string, unknown>
  const band = (height: number, was: string[] = []) => {
    const cls = new Set<string>(['seg', 'band', ...was])
    const b = {
      height, cls, getBoundingClientRect: () => ({ height: b.height }),
      classList: { contains: (c: string) => cls.has(c), add: (c: string) => { cls.add(c) }, remove: (c: string) => { cls.delete(c) } },
    }
    return b
  }
  // Under 4 px — however little under —, exactly 4 and more; one that wore the class and has grown.
  const bands = [band(0), band(1.008), band(2), band(3.99), band(4), band(4.01), band(16, ['band-thin']), band(3)]
  // 1.8 L-6: an empty list of columns and no width, so the chart's label fit — which the toggle runs as
  // well now — has nothing to thin.
  const chart = { clientHeight: 240, clientWidth: 0, children: [], querySelectorAll: (q: string) => (q === '.seg' ? bands : []) }
  doc.querySelector = (q: string) => (q === '.chart' ? chart : null)
  const thin = (): boolean[] => bands.map((b) => b.cls.has('band-thin'))
  nodeVm.runInContext('fitBands()', a.c)
  assert.deepEqual(thin(), [true, true, true, true, false, false, false, true])
  // Drawn again with other heights — a push with other values —, the class follows the height.
  bands[1].height = 8
  bands[4].height = 3.5
  nodeVm.runInContext('fitBands()', a.c)
  assert.deepEqual(thin(), [true, false, true, true, true, false, false, true])
  // A chart with no height — in a closed section every band measures 0 — keeps what it has …
  chart.clientHeight = 0
  for (const b of bands) b.height = 0
  nodeVm.runInContext('fitBands()', a.c)
  assert.deepEqual(thin(), [true, false, true, true, true, false, false, true])
  // … and is fitted when a section opens (the toggle event, which does not bubble: the capture phase;
  // 1.8 L-6: the one listener, which runs every fit).
  chart.clientHeight = 240
  for (const b of bands) b.height = 16
  nodeVm.runInContext('vm = { sections: [] }', a.c)
  a.fire('document:toggle', {})
  assert.deepEqual(thin(), bands.map(() => false))
  // No chart on the page: nothing to do, and nothing thrown.
  doc.querySelector = () => null
  nodeVm.runInContext('fitBands()', a.c)
  // The page's constant and its wiring: with the page's other fits — after every render and resize —
  // and when a closed section opens (1.8 L-6, pinned and changed: a toggle listener of its own).
  assert.match(SOURCE, /const BAND_THIN_PX = 4;/)
  assert.match(SOURCE, /function applyFits\(\): void \{\s*fitChart\(\);\s*fitBands\(\);/)
  assert.match(SOURCE, /document\.addEventListener\('toggle', \(\) => \{ if \(vm\) applyFits\(\); \}, true\);/)
  // The class is the fit's alone: the renderer's markup carries none, the bands' own classes as before.
  const chartHtml = render('sChart()', {
    chart: {
      days: ['2026-09-01'], labels: ['09-01'],
      series: [
        { key: 'claude:a', label: 'claude-opus-4-6', source: 'claude', rank: 0, values: [1000] },
        { key: 'claude:b', label: 'claude-haiku-4-5', source: 'claude', rank: 1, values: [1] },
      ],
      metric: 'usage', modelStyle: 'pattern', max: 1001, ticks: [250, 500, 750, 1000], weekly: false, costLine: null,
    },
  })
  assert.ok(chartHtml.includes('<div class="seg band s-claude-1 hue-claude r1 st-pattern" data-bh="0.10"'), chartHtml)
  assert.equal(chartHtml.includes('band-thin'), false, chartHtml)
  // In the forced-colours block, and nowhere else: outside the mode the class changes nothing. The
  // ring is a rule of its own, kept off the split's two parts and off a thin band; the rule that takes
  // the band out of the adjustment and gives it the page colour keeps every band, a thin one too.
  const css = STYLE.replace(/\/\*[\s\S]*?\*\//g, '')
  const forced = css.slice(css.indexOf('@media (forced-colors: active) {'))
  const block = forced.slice(0, forced.indexOf('\n}') + 2)
  // 1.8 L-5 (pinned and changed: two rules): and the thin subagents' band's stripes.
  assert.equal(css.split('band-thin').length - 1, 3, 'band-thin in another rule')
  assert.ok(block.includes('\n  .band.sp-sub.band-thin { forced-color-adjust: none; outline: none; background: repeating-linear-gradient(90deg, CanvasText 0 1px, Canvas 1px 3px); }\n'), block)
  assert.ok(block.includes('\n  .band:not(.sp-main, .sp-sub, .band-thin) { outline: 1px solid Canvas; outline-offset: -1px; }\n'), block)
  // On a thin band the dots of `other` stand in its middle: at the top of their 4 px tile, 2 px down,
  // they would miss a band under 2 px, which would be the page colour alone — the gap again.
  assert.ok(block.includes('\n  .band.band-thin.rother:not(.sp-main, .sp-sub) { background-position: 0 50%; }\n'), block)
  assert.ok(block.includes('\n  .band:not(.sp-main, .sp-sub) { forced-color-adjust: none; background: Canvas; }\n'), block)
  assert.equal(block.split('outline: 1px solid Canvas;').length - 1, 1, 'a second ring of the page colour')
  // No rank's rule draws a ring of its own that would come back on a thin band.
  const ranks = block.split('\n').filter((l) => /^ {2}\.band\.r(?:[0-4]|other):not\(/.test(l))
  assert.equal(ranks.length, 6, block)
  assert.equal(ranks.some((l) => /outline/.test(l)), false, ranks.join('\n'))
})

test('a forced-colours theme paints every pressed chip in the highlight colours, its words readable, and leaves the pressed agent rows their outline (1.6 P16)', () => {
  // The theme gives every button the same face and takes the button colours a pressed chip wears
  // (`button[aria-pressed="true"]` above), so without a rule of its own a pressed chip looked
  // exactly like a released one there. One rule, in the page's one forced-colours block.
  const forced = STYLE.slice(STYLE.indexOf('@media (forced-colors: active) {'))
  const block = forced.slice(0, forced.indexOf('\n}') + 2)
  assert.equal(STYLE.split('@media (forced-colors: active) {').length - 1, 1, 'a second forced-colours block')
  const rule = 'button[aria-pressed="true"]:not(.ag-row) { forced-color-adjust: none; background: Highlight; color: HighlightText; border-color: Highlight; outline-color: CanvasText; }'
  assert.ok(block.includes('\n  ' + rule + '\n'), block)
  assert.equal(block.split('aria-pressed="true"]:not').length - 1, 1, 'more than one rule for the pressed chips')
  assert.equal(STYLE.indexOf(rule), STYLE.lastIndexOf(rule), 'the rule outside the forced-colours block too')
  // Taken out of the theme's adjustment — with it on, Chrome paints a backplate of the page colour
  // behind the words, and the highlight text on it cannot be read (the harness's pictures and pixel
  // counts) — and so wearing nothing but the theme's own system colours: every value of the rule is
  // one of them. 1.7 D-B (pinned and changed: the chip was the only element of the page taken out):
  // beside it only the chart's bands by model are.
  const values = rule.slice(rule.indexOf('{') + 1, rule.lastIndexOf('}')).split(';').map((d) => d.trim()).filter(Boolean)
    .map((d) => d.split(':').map((x) => x.trim()) as [string, string])
  assert.deepEqual(values.map(([k]) => k), ['forced-color-adjust', 'background', 'color', 'border-color', 'outline-color'])
  assert.ok(values.slice(1).every(([, v]) => ['Highlight', 'HighlightText', 'CanvasText'].includes(v)), JSON.stringify(values))
  assert.deepEqual(adjustedOut(), ADJUSTED_OUT)
  // It stands after the page's own pressed colours, which it outranks inside the mode.
  assert.ok(STYLE.indexOf(rule) > STYLE.indexOf('button[aria-pressed="true"] {\n  background: var(--vscode-button-background'))
  // Every button the page gives aria-pressed, by the markup of src/webview/main.ts: the chips — a
  // button of the provider switch (1.7 F1, pinned and changed: a provider chip of the filter bar),
  // the range, a model, the custom dates, the cache switch, the chart's split and cost line, the
  // heatmap's metric, the hours' zone — have no class, so the rule reaches each of them; the only
  // others are the agent rows of the running list and the 7-day block, which it leaves out.
  const main = readFileSync(join(__dirname, '..', 'src', 'webview', 'main.ts'), 'utf8')
  const pressable = [...main.matchAll(/aria-pressed="'/g)].map((m) => {
    const head = main.slice(main.lastIndexOf('<button ', m.index), m.index)
    // 1.7 F4 (pinned and changed: the class was the literal `ag-row`): an agent row's class starts with
    // `ag-row`, and the script adds the colour of its state behind it — the first class is what the rule reads.
    return { act: /data-act="([A-Za-z]+)"/.exec(head)?.[1] ?? '?', cls: /class="([^"' ]*)/.exec(head)?.[1] ?? null }
  })
  const acts = ['providerView', 'range', 'model', 'customDates', 'compositionCache', 'chartSplit', 'costLine', 'heatmapMetric', 'hourZone']
  assert.deepEqual(pressable.filter((b) => b.cls === null).map((b) => b.act), acts, JSON.stringify(pressable))
  assert.deepEqual(pressable.filter((b) => b.cls !== null), [{ act: 'agentSelect', cls: 'ag-row' }, { act: 'agentSelect', cls: 'ag-row' }])
  // Those keep the open row's 2 px outline in the highlight colour, as the tree's rows do.
  assert.match(block, /\n {2}\.ag-row\[aria-pressed="true"\], \.agtree \.ag-row\[data-pressed="true"\] \{ outline: 2px solid Highlight; outline-offset: -2px; \}\n/)
})

test('the chart\'s chip and the split\'s tooltips speak German on a German page (1.6 O2)', () => {
  const bundle = JSON.parse(readFileSync(join(__dirname, '..', 'l10n', 'bundle.l10n.de.json'), 'utf8')) as Record<string, string>
  const words = ['subagents', '{0} · {1} · {2} % of the day · {3} total {4}', '{0} · {1} · {2} % of the week · {3} total {4}', 'chart metric']
  const de: Record<string, string> = {}
  for (const w of words) {
    assert.ok(Object.prototype.hasOwnProperty.call(DICT, w), w + ' is not a word of the page')
    assert.equal(typeof bundle[w], 'string', 'no German for ' + w)
    de[w] = bundle[w]
  }
  assert.equal(bundle.subagents, 'Subagenten')
  // The band labels are the view model's words, German there: the page only carries them.
  assert.equal(bundle['{0} · main sessions'], '{0} · Hauptsitzungen')
  assert.equal(bundle['{0} · subagents'], '{0} · Subagenten')
  const c = makeContext()
  nodeVm.runInContext(between(germanPage(de), /<script nonce="[A-Za-z0-9]+">/, '</script>'), c)
  ;(c as Record<string, unknown>).fixture = model({
    chart: {
      days: ['2026-09-01'], labels: ['09-01'],
      series: [
        { key: 'claude:main', label: 'Claude Code · Hauptsitzungen', source: 'claude', rank: 0, values: [1000] },
        { key: 'claude:sub', label: 'Claude Code · Subagenten', source: 'claude', rank: 1, values: [3000] },
      ],
      metric: 'usage', modelStyle: 'pattern', split: 'agents', max: 4000, ticks: [1000, 2000, 3000, 4000], weekly: false, costLine: null,
    },
  })
  const h = String(nodeVm.runInContext('vm = fixture; sChart()', c))
  assert.ok(h.indexOf('aria-pressed="true">Subagenten</button>') >= 0, h)
  assert.ok(h.indexOf('title="Claude Code · Subagenten · 3.000 · 75 % des Tages · Claude Code gesamt 4.000"') >= 0, h)
})

test('the band styles are one provider hue varied by rank, at a fixed 4 px pitch', () => {
  assert.match(STYLE, /\.hue-claude \{ --hue: var\(--claude\); \}/)
  assert.match(STYLE, /\.hue-codex \{ --hue: var\(--codex\); \}/)
  // The ground the patterned styles hatch over. `both` paints it between its strokes, so
  // these six are the pattern styles' business and the shade ramp below does not touch them.
  for (const [rank, mix] of [['r0', '100%'], ['r1', '78%'], ['r2', '58%'], ['r3', '42%'], ['r4', '30%'], ['rother', '22%']]) {
    assert.match(STYLE, new RegExp('\\.' + rank + ' \\{ --mix: ' + mix + '; \\}'))
  }
  // Shade: lightness steps of the hue against the track, the largest model the full hue —
  // its own ramp, spaced by measurement (see the next test) rather than by the ground above.
  for (const [rank, mix] of [['r0', '100%'], ['r1', '82%'], ['r2', '65%'], ['r3', '49%'], ['r4', '33%'], ['rother', '18%']]) {
    assert.match(STYLE, new RegExp('\\.st-shade\\.' + rank + ' \\{ --mix: ' + mix + '; \\}'))
  }
  assert.match(STYLE, /\.st-shade, \.st-both \{ --ground: color-mix\(in srgb, var\(--hue\) var\(--mix\), var\(--track\)\); \}/)
  assert.match(STYLE, /\.band \{ background: var\(--ground\); \}/)
  assert.match(STYLE, /\.band\.r0 \{ background: var\(--hue\); \}/)
  // Pattern: a 35 % ground with strokes in the full hue, 2 px on and 2 px off in CSS pixels,
  // so the hatching is the same on a hairline band and a wide one.
  assert.match(STYLE, /\.st-pattern \{ --ground: color-mix\(in srgb, var\(--hue\) 35%, transparent\); \}/)
  const rule = (rank: string): string => {
    const m = new RegExp('\\.st-pattern\\.' + rank + ', \\.st-both\\.' + rank + ' \\{([^}]*)\\}').exec(STYLE)
    assert.ok(m, 'no stroke rule for ' + rank)
    return (m as RegExpExecArray)[1]
  }
  assert.match(rule('r1'), /background: repeating-linear-gradient\(45deg, var\(--hue\) 0 2px, var\(--ground\) 2px 4px\);/)
  assert.match(rule('r2'), /background: repeating-linear-gradient\(135deg, var\(--hue\) 0 2px, var\(--ground\) 2px 4px\);/)
  assert.match(rule('r3'), /repeating-linear-gradient\(45deg, var\(--hue\) 0 2px, transparent 2px 4px\),/)
  assert.match(rule('r3'), /repeating-linear-gradient\(135deg, var\(--hue\) 0 2px, var\(--ground\) 2px 4px\);/)
  assert.match(rule('r4'), /background: repeating-linear-gradient\(0deg, var\(--hue\) 0 2px, var\(--ground\) 2px 4px\);/)
  assert.match(rule('rother'), /background: radial-gradient\(var\(--hue\) 1px, var\(--ground\) 1\.2px\);/)
  assert.match(rule('rother'), /background-size: 4px 4px;/)
  // No shade band wears an outline. A 1 px inset costs a 4 px band half of its height, which
  // made the paint of a rank depend on how tall its band happened to be — and turned the
  // ladder round, because two rows of the full hue outweigh two rows of a faint fill.
  assert.equal(/\.st-shade[^{]*\{[^}]*box-shadow/.test(STYLE), false, STYLE)
  // A provider label in the legend is a heading, so it takes a line of its own; wrapped into
  // the middle of one it read as one more swatch entry.
  assert.match(STYLE, /\.legend > span\.meta \{ flex-basis: 100%; \}/)
  // The chart's swatches are big enough for a pattern to be read; the other legends keep 8 px.
  assert.match(STYLE, /\.legend \.dot\.band \{ width: 14px; height: 14px; \}/)
  assert.match(STYLE, /\.dot \{ display: inline-block; width: 8px; height: 8px;/)
})

/**
 * The shade ramp, measured rather than eyeballed.
 *
 * A shade band is `color-mix(in srgb, var(--hue) m%, var(--track))` painted over the page, and
 * `--track` is a share of the foreground with nothing behind it, so what the reader sees is
 *
 *     m·hue + (1 − m)·(share·foreground + (1 − share)·background)
 *
 * — a straight line from the provider hue to the track over the page. Chrome agrees to the
 * byte: rank 2 of the dark page measures 52,106,168 and this gives 52.6, 106.5, 168.6.
 *
 * That is why the ramp can be judged here at all. The band's height does not enter the sum:
 * the fill is flat, so a 4 px band paints exactly what a 16 px one paints — which is the point
 * of the ramp having no outline, and the reason this test is enough for all three sizes.
 */
test('the shade ramp keeps every neighbouring rank a visible step apart, at any band height', () => {
  // Read the ramp out of the page rather than restating it: this measures what ships.
  const mixes = ['r0', 'r1', 'r2', 'r3', 'r4', 'rother'].map((rank) => {
    const m = new RegExp('\\.st-shade\\.' + rank + ' \\{ --mix: (\\d+)%; \\}').exec(STYLE)
    assert.ok(m, 'no shade ramp rule for ' + rank)
    return Number((m as RegExpExecArray)[1]) / 100
  })
  const tr = /--track: color-mix\(in srgb, var\(--vscode-foreground\) (\d+)%, transparent\);/.exec(STYLE)
  assert.ok(tr, 'no --track rule')
  const share = Number((tr as RegExpExecArray)[1]) / 100

  // The two default themes, as VS Code ships them: foreground, sidebar background and the two
  // chart colours --claude and --codex resolve to.
  const THEMES = [
    { name: 'Dark Modern', fg: [204, 204, 204], bg: [24, 24, 24],
      hues: { claude: [55, 148, 255], codex: [177, 128, 215] } },
    { name: 'Light Modern', fg: [59, 59, 59], bg: [248, 248, 248],
      hues: { claude: [26, 133, 255], codex: [101, 45, 144] } },
  ]
  /** sRGB → CIE L*a*b* (D65), the space in which a ΔE means anything. */
  const lab = (c: number[]): number[] => {
    const lin = (v: number): number => {
      const x = v / 255
      return x <= 0.04045 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4)
    }
    const [R, G, B] = [lin(c[0]), lin(c[1]), lin(c[2])]
    const xyz = [(0.4124564 * R + 0.3575761 * G + 0.1804375 * B) / 0.95047,
      0.2126729 * R + 0.7151522 * G + 0.0721750 * B,
      (0.0193339 * R + 0.1191920 * G + 0.9503041 * B) / 1.08883]
    const f = (t: number): number => (t > 216 / 24389 ? Math.cbrt(t) : (24389 / 27 * t + 16) / 116)
    const [fx, fy, fz] = xyz.map(f)
    return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)]
  }
  const dE = (a: number[], b: number[]): number => {
    const [p, q] = [lab(a), lab(b)]
    return Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2])
  }

  for (const th of THEMES) {
    const track = th.fg.map((f, i) => share * f + (1 - share) * th.bg[i])
    for (const [hueName, hue] of Object.entries(th.hues)) {
      const where = th.name + ' · ' + hueName
      const ramp = mixes.map((m) => track.map((t, i) => m * hue[i] + (1 - m) * t))
      for (let i = 1; i < ramp.length; i++) {
        const step = dE(ramp[i - 1], ramp[i])
        // Eight is where two fills stop being one colour with a rounding error. The narrowest
        // step of this ramp measures 9.8; the one it replaced fell to 5.0 in the fill alone,
        // and to 0.8 once the outline it leaned on had eaten half of a 4 px band.
        assert.ok(step >= 8, `${where}: ranks ${i - 1} and ${i} are only ΔE ${step.toFixed(1)} apart`)
        // Monotone, so the ladder reads in one direction: rank by rank away from the hue.
        // Which direction that is depends on the theme — towards a dark page or a light one.
        const towards = lab(th.bg)[0] > lab(hue)[0] ? 1 : -1
        assert.ok(towards * (lab(ramp[i])[0] - lab(ramp[i - 1])[0]) > 0,
          `${where}: rank ${i} does not continue the ladder (L* ${lab(ramp[i])[0].toFixed(1)} `
          + `after ${lab(ramp[i - 1])[0].toFixed(1)})`)
      }
      // The faintest rank is still a band, not a stain on the plot.
      const floor = dE(ramp[ramp.length - 1], th.bg)
      assert.ok(floor >= 12, `${where}: the faintest band is only ΔE ${floor.toFixed(1)} off the page`)
    }
    // The two providers must not meet at the faint end either: the 'other' of one sits right
    // above the largest model of the next in a stacked column.
    const faintest = Object.values(th.hues).map((hue) =>
      track.map((t, i) => mixes[5] * hue[i] + (1 - mixes[5]) * t))
    const apart = dE(faintest[0], faintest[1])
    assert.ok(apart >= 8, `${th.name}: the two faintest bands are only ΔE ${apart.toFixed(1)} apart`)
  }
})

test('the cost line runs through the column centres, haloed, with a round dot per column', () => {
  const chartOf = (costs: number[]): Record<string, unknown> => ({
    days: costs.map((_, i) => '2026-09-0' + (i + 1)),
    labels: costs.map((_, i) => '09-0' + (i + 1)),
    series: [{ key: 'claude:claude-opus-4-6', label: 'claude-opus-4-6', source: 'claude', rank: 0, values: costs.map(() => 10) }],
    metric: 'usage', modelStyle: 'pattern', max: 10, ticks: [2.5, 5, 7.5, 10], weekly: false, costLine: costs,
  })
  nodeVm.runInContext('costLine = true', ctx)
  try {
    // x = (i + 0.5) / n of the width: one column is centred, two sit at a quarter and at three
    // quarters, five at every fifth — never on the edges, where the old line started and ended.
    const one = render('sChart()', { chart: chartOf([1]) })
    assert.ok(one.indexOf('<polyline class="halo" points="50.0,0.0"/>') >= 0, one)
    assert.ok(one.indexOf('<polyline class="line" points="50.0,0.0"/>') >= 0, one)
    const two = render('sChart()', { chart: chartOf([1, 2]) })
    assert.ok(two.indexOf('<polyline class="halo" points="25.0,50.0 75.0,0.0"/>') >= 0, two)
    assert.ok(two.indexOf('<polyline class="line" points="25.0,50.0 75.0,0.0"/>') >= 0, two)
    const five = render('sChart()', { chart: chartOf([1, 2, 3, 4, 5]) })
    const line = /<polyline class="line" points="([^"]*)"/.exec(five)
    assert.ok(line, five)
    assert.deepEqual((line as RegExpExecArray)[1].split(' ').map((p) => p.split(',')[0]),
      ['10.0', '30.0', '50.0', '70.0', '90.0'])
    // The halo is drawn first, so the line paints over it, and both sit in the stretched box.
    assert.ok(five.indexOf('class="halo"') < five.indexOf('class="line"'), five)
    assert.match(five, /<svg class="costline" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true"><polyline class="halo"/)
    // The dots: one per point, in a second SVG that is not stretched, placed by percentage of
    // the same box, so they stay round and sit on the line.
    const dots = /<svg class="costline dots"([^>]*)>(.*?)<\/svg>/.exec(five)
    assert.ok(dots, five)
    assert.equal((dots as RegExpExecArray)[1].indexOf('preserveAspectRatio'), -1, five)
    assert.equal((dots as RegExpExecArray)[1].indexOf('viewBox'), -1, five)
    assert.ok((dots as RegExpExecArray)[2].indexOf('<circle cx="10.0%" cy="80.0%" r="2.5"/>') >= 0, five)
    assert.ok((dots as RegExpExecArray)[2].indexOf('<circle cx="90.0%" cy="0.0%" r="2.5"/>') >= 0, five)
    assert.equal((dots as RegExpExecArray)[2].split('<circle ').length - 1, 5, five)
    // The legend's key is the same three marks, not a dash.
    assert.ok(five.indexOf('<svg class="key" viewBox="0 0 22 10" aria-hidden="true"><polyline class="halo"') >= 0, five)
    assert.ok(five.indexOf('<circle cx="8" cy="3" r="2.5"/></svg>API cost (second axis)') >= 0, five)
    assert.equal(five.indexOf('— API cost'), -1, five)
  } finally {
    nodeVm.runInContext('costLine = false', ctx)
  }
  // The strokes: a halo in the page's own background under a 2 px line, both non-scaling, and
  // the dots in the line's colour.
  const halo = /\.costline polyline\.halo \{([^}]*)\}/.exec(STYLE)
  assert.ok(halo, 'the halo has no rule')
  assert.match((halo as RegExpExecArray)[1], /stroke: var\(--vscode-sideBar-background, var\(--vscode-editor-background\)\)/)
  assert.match((halo as RegExpExecArray)[1], /stroke-width: 4/)
  const line = /\.costline polyline \{([^}]*)\}/.exec(STYLE)
  assert.ok(line, 'the line has no rule')
  assert.match((line as RegExpExecArray)[1], /stroke-width: 2;/)
  assert.match((line as RegExpExecArray)[1], /vector-effect: non-scaling-stroke/)
  const dot = /\.costline circle \{([^}]*)\}/.exec(STYLE)
  assert.ok(dot, 'the dots have no rule')
  assert.match((dot as RegExpExecArray)[1], /fill: var\(--vscode-charts-foreground, var\(--vscode-foreground\)\)/)
  // The key shares those rules, so it cannot drift from the line it stands for.
  assert.match(STYLE, /\.key polyline, \.costline polyline \{/)
  assert.match(STYLE, /\.key polyline\.halo, \.costline polyline\.halo \{/)
  assert.match(STYLE, /\.key circle, \.costline circle \{/)
})

// ---------------------------------------------------------------------------
// Chart, hours, heat map, chips
// ---------------------------------------------------------------------------

test('the model chips are deduplicated', () => {
  const row = (model: string, isSub: boolean) => ({
    model, source: 'claude', isSub, tier: 'standard', usage: 1, usageText: '1', output: '1',
    requests: '1', cost: 0, costText: '–', listCost: null, cacheHit: '–', share: '100 %',
    costShare: '–', priced: 'exact', price: '–', turnAvg: null, turnP90: null,
  })
  const h = render('controls()', {
    models: {
      rows: [row('claude-opus-4-6', false), row('claude-opus-4-6', true), row('gpt-5.2', false)],
      total: 3, hidden: 0, sort: { key: 'usage', dir: 'desc' },
    },
  })
  assert.equal(h.split('data-model="claude-opus-4-6"').length - 1, 1, h)
  assert.equal(h.split('data-model="gpt-5.2"').length - 1, 1, h)
})

/** One model row with every field the table reads — the shape `ModelRow` guarantees. */
function modelRow(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    model: 'claude-opus-4-6', source: 'claude', isSub: false, tier: 'standard',
    usage: 9000, usageText: '9.0K', freshInput: '4.0K', cacheWrite5m: '1.5K',
    cacheWrite1h: '500', cacheRead: '90.0K', output: '3.0K', reasoning: '900',
    requests: '4', perRequest: '2.3K', freshInputN: 4000, cacheWrite5mN: 1500,
    cacheWrite1hN: 500, cacheReadN: 90000, outputN: 3000, reasoningN: 900, requestsN: 4,
    perRequestN: 2250, cost: 1.5, costText: '~$1.50', listCost: null, cacheHit: '96 %',
    share: '100 %', costShare: '100 %', priced: 'exact', price: '$15.00 / $75.00 per 1M, list as of 2026-09-02',
    turnAvg: null, turnP90: null, ...over,
  }
}

test('the models table carries every column of the totals table, in its order', () => {
  const h = render('sModels()', {
    models: { rows: [modelRow()], total: 1, hidden: 0, sort: { key: 'usage', dir: 'desc' } },
  })
  const heads = [...h.matchAll(/<th[^>]*>([^<]*)<\/th>/g)].map((m) => m[1]);
  assert.deepEqual(heads, ['Model', 'Usage', 'Fresh in', 'Write 5m', 'Write 1h', 'Cache read',
    'Output', 'Reasoning', 'Req.', 'Hit', 'Per req.', 'API cost', 'Share'])
  // Every cell names its own header, so the ≤320 px layout can stack them.
  for (const [head, value] of [['Fresh in', '4.0K'], ['Write 5m', '1.5K'], ['Write 1h', '500'],
    ['Cache read', '90.0K'], ['Reasoning', '900'], ['Per req.', '2.3K']] as const) {
    // 1.10 D10 (rewritten: a cell carries its stacked label, data-hl, beside its column name).
    assert.ok(h.indexOf('<td data-h="' + head + '" data-hl="' + head + ':">' + value + '</td>') >= 0, head + ': ' + h)
  }
  // Every numeric column is sortable through the one mechanism the extension parses.
  for (const key of ['usage', 'freshInput', 'cacheWrite5m', 'cacheWrite1h', 'cacheRead', 'output',
    'reasoning', 'requests', 'cacheHit', 'perRequest', 'cost', 'share']) {
    assert.ok(h.indexOf('data-act="sort" data-key="' + key + '"') >= 0, key)
  }
  // The table scrolls sideways in a narrow sidebar, the way the totals table does.
  assert.ok(h.startsWith('<div class="scroll">'), h)
  assert.equal(/undefined|NaN|Infinity|\[object Object\]/.test(h), false, h)

  // With the cost switched off the column goes, and the share stays where it was.
  const free = render('sModels()', {
    showCost: false,
    models: { rows: [modelRow()], total: 1, hidden: 0, sort: { key: 'usage', dir: 'desc' } },
  })
  const bare = [...free.matchAll(/<th[^>]*>([^<]*)<\/th>/g)].map((m) => m[1]);
  assert.equal(bare.includes('API cost'), false, free)
  assert.equal(bare[bare.length - 1], 'Share')
})

test('the models table has no Price column, and hangs the provenance on the cost', () => {
  const h = render('sModels()', {
    models: {
      rows: [modelRow(), modelRow({ model: 'claude-haiku-9', priced: 'family', costText: '~$0.30', price: '$1.00 / $5.00 per 1M, borrowed from claude-haiku-4-6' }),
        modelRow({ model: 'claude-experimental-x', priced: 'none', costText: '–', price: 'no price on file' })],
      total: 3, hidden: 0, sort: { key: 'usage', dir: 'desc' },
    },
  })
  assert.equal(h.indexOf('>Price</th>'), -1, h)
  assert.equal(h.indexOf('data-h="Price"'), -1, h)
  assert.equal(h.indexOf('>exact<'), -1, h)
  // The rates still travel with the number they made, and a borrowed rate is marked.
  assert.ok(h.indexOf('title="$15.00 / $75.00 per 1M, list as of 2026-09-02"') >= 0, h)
  assert.ok(h.indexOf('borrowed from claude-haiku-4-6') >= 0, h)
  assert.equal(h.split('family fallback').length - 1, 1, h)
  // An unpriced model keeps its dash — no cost, and no warning about a cost it never had.
  assert.ok(h.indexOf('title="no price on file">–</td>') >= 0, h)
})

test('every axis label carries its text and index, so the browser can thin them', () => {
  const h = render('sChart()')
  assert.match(h, /<span data-i="0" data-l="09-01"><i>09-01<\/i><\/span>/)
  assert.match(h, /<span data-i="2" data-l="09-03"><i>09-03<\/i><\/span>/)
  assert.match(h, /<span class="vlabel" data-i="0"><i>/)
})

test('the hour strip has an axis of its own and marks its empty hours', () => {
  const h = render('sHours()')
  const strip = h.slice(h.indexOf('<div class="hours">'))
  assert.ok(strip.indexOf('class="hb none"') >= 0, strip)
  // Its own axis, right after the bars and before the weekday grid.
  const axis = strip.indexOf('<div class="axis">')
  const grid = strip.indexOf('<div class="hgrid">')
  assert.ok(axis > 0 && grid > axis, strip)
  assert.ok(strip.indexOf('>00</span>') >= 0 && strip.indexOf('>12</span>') >= 0, strip)
  // The four-hour blocks are labelled as belonging to the grid, not to the strip.
  assert.ok(h.indexOf('by weekday and four-hour block') >= 0, h)
})

test('the weekday grid draws the blocks it has, hatches the rest and says what it stands on', () => {
  const h = render('sHours()')
  const grid = h.slice(h.indexOf('<div class="hgrid">'))
  // Seven cells with a level, thirty-five hatched — and nothing claiming a missing sample.
  assert.equal(grid.split('<i class="l').length - 1, 7, grid)
  assert.equal(grid.split('<i class="none"').length - 1, 35, grid)
  assert.ok(grid.indexOf('title="no usage in this block"') >= 0, grid)
  assert.ok(grid.indexOf('11,000 tokens over 1 day(s)') >= 0, grid)
  // The caption carries the basis, and the hatch is named in a legend of its own.
  assert.ok(h.indexOf('by weekday and four-hour block · based on 1 week — a record, not a habit') >= 0, h)
  assert.ok(h.indexOf('hatched: no usage in that block') >= 0, h)
  // Four weeks of days is a habit and drops the qualifier — the same one sentence, no glyphs.
  const long = render('sHours()', {
    hours: { ...(model().hours as Record<string, unknown>), basis: { weeks: 4, days: 26, text: 'based on 4 weeks' } },
  })
  assert.ok(long.indexOf('by weekday and four-hour block · based on 4 weeks') >= 0, long)
  assert.equal(long.indexOf('a record, not a habit'), -1, long)
})

test('a lone sparkline sample is a point, not a stretched dash', () => {
  // The KPI sparks are still plain value lists and take the evenly spaced renderer.
  const h = String(nodeVm.runInContext('sparkSvg([10, -1, 50, -1, 90])', ctx))
  assert.equal(h.indexOf('<circle'), -1, h)
  assert.equal(h.split('class="pt"').length - 1, 3, h)
  assert.match(STYLE, /\.spark path\.pt \{[^}]*vector-effect: non-scaling-stroke/)
})

/** One 15-minute slot of the grid, in ms. */
const SLOT = 15 * 60_000

/** A seven-day spark in the view model's slotted shape. */
function slotted(points: Record<string, unknown>[]): Record<string, unknown> {
  return { slots: 672, from: 0, to: 672 * SLOT, points }
}

function sparkOf(s: Record<string, unknown>): string {
  return String(nodeVm.runInContext('sparkSvg(' + JSON.stringify(s) + ')', ctx))
}

test('the quota sparkline is time-proportional: one unit per slot, holes as wide as their time', () => {
  // Two adjacent slots are one polyline, x is the slot index, y is the inverted percentage.
  const two = sparkOf(slotted([{ i: 10, p: 20, level: 'ok' }, { i: 11, p: 30, level: 'ok' }]))
  assert.match(two, /^<div class="sparkbox"><svg class="spark q" viewBox="0 0 672 100" preserveAspectRatio="none" role="img" tabindex="0" aria-label="quota sparkline, 7 days">/)
  assert.equal(two.split('<polyline').length - 1, 1, two)
  assert.match(two, /<polyline class="ok" points="10,80.0 11,70.0"\/>/)
  // With its time a reading sits where it was taken, not at the start of its slot.
  const exact = sparkOf(slotted([{ i: 10, p: 20, level: 'ok', t: 10.5 * SLOT }, { i: 11, p: 30, level: 'ok', t: 11.25 * SLOT }]))
  assert.match(exact, /<polyline class="ok" points="10.5,80.0 11.25,70.0"\/>/)
  // Slot 0 sits on the left edge, the last slot at slots − 1 — and the week between them is
  // one stroke, drawn across whatever nobody measured.
  const ends = sparkOf(slotted([{ i: 0, p: 0, level: null }, { i: 671, p: 100, level: 'error' }]))
  assert.match(ends, /<polyline class="error" points="0,100.0 671,0.0"\/>/)
  const one = sparkOf(slotted([{ i: 671, p: 100, level: 'error' }]))
  assert.match(one, /<path class="pt error" d="M671 0.0h.01"\/>/)
  // Over 100 % stays on the top edge instead of leaving the box.
  const over = sparkOf(slotted([{ i: 1, p: 140, level: 'error' }, { i: 2, p: 150, level: 'error' }]))
  assert.match(over, /<polyline class="error" points="1,0.0 2,0.0"\/>/)
  // Nothing to draw is nothing, not an empty box.
  assert.equal(sparkOf(slotted([])), '')
  assert.equal(String(nodeVm.runInContext('sparkSvg(null)', ctx)), '')
  assert.equal(String(nodeVm.runInContext('sparkSvg({ slots: 0, points: [{ i: 0, p: 1 }] })', ctx)), '')
  for (const h of [two, ends, over]) assert.equal(/NaN|undefined|Infinity/.test(h), false, h)
  assert.match(STYLE, /\.spark\.q \{ height: 22px; \}/)
})

test('a spark run splits where the pace level changes, each segment wearing the later level', () => {
  const h = sparkOf(slotted([
    { i: 0, p: 10, level: 'ok' }, { i: 1, p: 20, level: 'ok' },
    { i: 2, p: 60, level: 'warn' }, { i: 3, p: 70, level: 'warn' },
  ]))
  assert.match(h, /<polyline class="ok" points="0,90.0 1,80.0"\/><polyline class="warn" points="1,80.0 2,40.0 3,30.0"\/>/)
  assert.equal(h.split('<polyline').length - 1, 2, h)
  // A point without a clock has no level and keeps the provider colour; a level the CSS does
  // not know is not turned into a class either.
  const plain = sparkOf(slotted([{ i: 4, p: 5, level: null }, { i: 5, p: 6, level: 'constructor' }]))
  assert.match(plain, /<polyline points="4,95.0 5,94.0"\/>/)
  for (const level of ['ok', 'warn', 'warn2', 'error']) {
    assert.match(STYLE, new RegExp('\\.spark polyline\\.' + level + ', \\.spark path\\.pt\\.' + level + ' \\{ stroke: var\\(--' + level + '\\); \\}'))
  }
})

test('the stroke into the first reading after a reset is a vertical drop without a pace colour', () => {
  // The window turned over between the two readings: that fall is not a pace anybody kept.
  // The line holds the old value in the old colour up to the drop, the drop itself stands
  // alone in the neutral provider colour, and the coloured run starts again at the new
  // window's first reading. Without a reset time between the readings the drop stands at
  // the new reading, so there is no tail.
  const h = sparkOf(slotted([
    { i: 0, p: 80, level: 'warn' }, { i: 1, p: 90, level: 'warn' },
    { i: 2, p: 5, level: 'ok', reset: true }, { i: 3, p: 12, level: 'ok' },
    { i: 4, p: 20, level: 'ok' },
  ]))
  assert.equal(h.split('<polyline').length - 1, 3, h)
  assert.match(h, /<polyline class="warn" points="0,20.0 1,10.0 2,10.0"\/><polyline points="2,10.0 2,95.0"\/><polyline class="ok" points="2,95.0 3,88.0 4,80.0"\/>/)
  // Two resets in a row keep one drop each rather than melting into one neutral run; the
  // hold between them wears the level of the reading it holds.
  const twice = sparkOf(slotted([
    { i: 0, p: 60, level: 'warn' }, { i: 1, p: 4, level: 'ok', reset: true },
    { i: 2, p: 3, level: 'ok', reset: true }, { i: 3, p: 9, level: 'ok' },
  ]))
  assert.match(twice, /<polyline class="warn" points="0,40.0 1,40.0"\/><polyline points="1,40.0 1,96.0"\/><polyline class="ok" points="1,96.0 2,96.0"\/><polyline points="2,96.0 2,97.0"\/><polyline class="ok" points="2,97.0 3,91.0"\/>/)
  assert.equal(twice.split('<polyline').length - 1, 5, twice)
  // A lone reading is a point, not a stroke: it keeps its own level whatever it reports.
  const lone = sparkOf(slotted([{ i: 2, p: 5, level: 'ok', reset: true }]))
  assert.match(lone, /<path class="pt ok" d="M2 95.0h.01"\/>/)
  // The class-less polyline is the provider stroke the CSS defines.
  assert.match(STYLE, /\.spark polyline \{ fill: none; stroke: var\(--claude\);/)
})

test('a hole in the spark is drawn straight across, in the colour of the reading after it', () => {
  // Four slots without a reading between two readings: one stroke from the one to the other,
  // as wide as the hour it covers, and no hairline dots at its ends.
  const hole = sparkOf(slotted([{ i: 5, p: 50, level: 'ok' }, { i: 9, p: 55, level: 'ok' }]))
  assert.match(hole, /<polyline class="ok" points="5,50.0 9,45.0"\/>/)
  assert.equal(hole.split('<polyline').length - 1, 1, hole)
  assert.equal(hole.indexOf('class="pt'), -1, hole)
  assert.equal(hole.indexOf('<line'), -1, hole)
  // A hole the window turned over in: the old value is held across it and dropped at the
  // first reading after, like any other reset — not sloped down across the hole.
  const dark = sparkOf(slotted([{ i: 5, p: 50, level: 'warn' }, { i: 9, p: 5, level: 'ok', reset: true }, { i: 10, p: 8, level: 'ok' }]))
  assert.match(dark, /<polyline class="warn" points="5,50.0 9,50.0"\/><polyline points="9,50.0 9,95.0"\/><polyline class="ok" points="9,95.0 10,92.0"\/>/)
  // The dashed bridge of 1.2.1 is gone from the stylesheet with the element it styled.
  assert.equal(STYLE.indexOf('bridge'), -1)
  // A stray bridges field from an older view model is ignored, not drawn.
  const stale = sparkOf({ ...slotted([{ i: 1, p: 1, level: 'ok' }, { i: 3, p: 2, level: 'ok' }]), bridges: [{ from: 1, to: 3 }] })
  assert.equal(stale.indexOf('<line'), -1, stale)
})

test('the reset stroke is vertical: a hold in the old colour, a drop, a tail in the new one', () => {
  // The old window's last reading, at slot 100, announced its reset two hours (eight slots)
  // later; the first reading of the new window came twelve hours after that one (VS Code
  // closed over the reset). The line holds the old value to the announced reset, drops
  // there, and runs on at the new value — not a slope from the one reading to the other.
  const t0 = 100 * SLOT
  const h = sparkOf(slotted([
    { i: 100, p: 80, level: 'warn', t: t0, r: t0 + 8 * SLOT, label: 'a' },
    { i: 148, p: 5, level: 'ok', t: t0 + 48 * SLOT, r: t0 + 68 * SLOT, label: 'b', reset: true },
    { i: 150, p: 8, level: 'ok', t: t0 + 50 * SLOT, r: t0 + 68 * SLOT, label: 'c' },
  ]))
  assert.match(h, /<polyline class="warn" points="100,20.0 108,20.0"\/><polyline points="108,20.0 108,95.0"\/><polyline class="ok" points="108,95.0 148,95.0 150,92.0"\/>/)
  assert.equal(h.split('<polyline').length - 1, 3, h)
  // The drop ends at the new reading's value — 5 %, where a rolling window may well sit —
  // never at a 0 nobody measured.
  assert.equal(h.indexOf('108,100.0'), -1, h)
  // Every neutral stroke stands upright: x1 === x2.
  const neutral = [...h.matchAll(/<polyline points="([\d.]+),[\d.]+ ([\d.]+),[\d.]+"\/>/g)]
  assert.equal(neutral.length, 1, h)
  for (const [, x1, x2] of neutral) assert.equal(x1, x2, h)
})

test('without a reset time between the two readings the drop stands at the new reading', () => {
  const t0 = 100 * SLOT
  const at = (r1: number | null, r2: number | null): string => sparkOf(slotted([
    { i: 100, p: 80, level: 'warn', t: t0, r: r1, label: 'a' },
    { i: 148, p: 5, level: 'ok', t: t0 + 48 * SLOT, r: r2, label: 'b', reset: true },
  ]))
  const expected = /<polyline class="warn" points="100,20.0 148,20.0"\/><polyline points="148,20.0 148,95.0"\/><rect/
  // No clock on the old reading …
  assert.match(at(null, t0 + 60 * SLOT), expected)
  // … a reset the old reading was itself already past (a stale reading) …
  assert.match(at(t0 - SLOT, t0 + 60 * SLOT), expected)
  // … or a reset announced beyond the new reading: an unmoved clock with a five-point fall.
  assert.match(at(t0 + 60 * SLOT, t0 + 60 * SLOT), expected)
  // A reset exactly at the new reading's time drops there as well. No tail in any of these:
  // the drop already stands at the reading, and a zero-length stroke would draw nothing.
  assert.match(at(t0 + 48 * SLOT, t0 + 60 * SLOT), expected)
  for (const h of [at(null, null), at(t0 - SLOT, null), at(t0 + 60 * SLOT, null), at(t0 + 48 * SLOT, null)]) {
    assert.equal(h.split('<polyline').length - 1, 2, h)
  }
  // A payload from a build without times falls back to the slot index for the drop too.
  const old = sparkOf(slotted([{ i: 5, p: 50, level: 'warn' }, { i: 9, p: 5, level: 'ok', reset: true }]))
  assert.match(old, /<polyline class="warn" points="5,50.0 9,50.0"\/><polyline points="9,50.0 9,95.0"\/><rect/)
})

test('the quota sparkline can be hovered and reached by keyboard; the KPI sparks cannot', () => {
  const spark = {
    ...slotted([
      { i: 1, p: 10, level: 'ok', t: SLOT, r: null, label: 'Thu 3 Sep · 00:15 · 10 %' },
      { i: 2, p: 30, level: 'ok', t: 2 * SLOT, r: null, label: 'Thu 3 Sep · 00:30 · 30 %' },
    ]),
    aria: 'quota sparkline, 7 days, 2 readings, peak 30 %',
  }
  const h = render('sQuota()', { quotas: [card({ windows: [win({ spark })] })] })
  // The svg is the focusable, labelled element; the provider and the window it belongs to
  // are written on it so the hover finds the readings in the view model, not in a copy.
  assert.match(h, /<div class="sparkbox"><svg class="spark q" viewBox="0 0 672 100" preserveAspectRatio="none" role="img" tabindex="0" aria-label="quota sparkline, 7 days, 2 readings, peak 30 %" data-src="claude" data-win="session:300">/)
  // The overlay takes the pointer, the empty marker waits for a reading, and the label box
  // is the KPI explanation's, hidden until there is something to say.
  assert.match(h, /<rect class="ov" x="0" y="0" width="672" height="100"\/><path class="hov"\/><\/svg><div class="pop" role="tooltip" aria-live="polite" hidden><\/div><\/div>/)
  // No label is written into the markup: the readings stay in the view model.
  assert.equal(h.indexOf('Thu 3 Sep'), -1, h)
  // The KPI sparks stay decoration: hidden from the reader, nothing to hover.
  const k = render('sKpis()', { kpis: [kpiCard({ spark: [1, 2, 3] })] })
  assert.match(k, /<svg class="spark" viewBox="0 0 100 20" preserveAspectRatio="none" aria-hidden="true">/)
  assert.equal(k.indexOf('class="ov"'), -1, k)
  assert.equal(k.indexOf('sparkbox'), -1, k)
  // The hovered reading reuses the explanation's box and its hover-widget colours: one rule
  // for the box, a modifier for the spark's one-line label.
  assert.equal(STYLE.split('--vscode-editorHoverWidget-background').length - 1, 1)
  // 1.10 B5 rule 5 (rewritten: the box had no margin): 3 px between the sparkline and the line above it.
  assert.match(STYLE, /\.sparkbox \{ position: relative; margin-top: 3px; \}/)
  assert.match(STYLE, /\.sparkbox \.pop \{ min-width: 0; white-space: nowrap; \}/)
  assert.match(STYLE, /\.spark rect\.ov \{ fill: transparent; pointer-events: all; \}/)
  assert.match(STYLE, /\.spark path\.hov \{[^}]*vector-effect: non-scaling-stroke;[^}]*pointer-events: none; \}/)
})

test('the hover marks the reading nearest to the pointer and names it from the view model', () => {
  // The geometry the renderer and the hover share: x from the reading's time, the slot index
  // when there is none; the reset clock null unless the reading carries one — never 0.
  const g = nodeVm.runInContext('sparkGeometry(' + JSON.stringify(slotted([
    { i: 1, p: 50, t: 1.5 * SLOT, r: null, label: 'a' }, { i: 7, p: 20, level: 'ok', label: 'b' },
    { i: 9, p: 0, t: 9 * SLOT, r: 9 * SLOT + 3_600_000, label: 'c', reset: true },
  ])) + ')', ctx) as { W: number; pts: Array<Record<string, unknown>> }
  assert.equal(g.W, 672)
  // Through JSON: the arrays were built in the script's own realm, whose Array is not ours.
  assert.deepEqual(JSON.parse(JSON.stringify(g.pts.map((p) => [p.x, p.y, p.r, p.level, p.reset, p.label]))), [
    [1.5, 50, null, '', false, 'a'], [7, 80, null, 'ok', false, 'b'], [9, 100, 9 * SLOT + 3_600_000, '', true, 'c'],
  ])
  assert.equal(nodeVm.runInContext('sparkGeometry({ slots: 672, points: [] })', ctx), null)
  // Nearest by x; a tie goes to the earlier reading.
  assert.equal(nodeVm.runInContext('sparkNearest([{ x: 0 }, { x: 10 }, { x: 20 }], 12)', ctx), 1)
  assert.equal(nodeVm.runInContext('sparkNearest([{ x: 0 }, { x: 10 }, { x: 20 }], 5)', ctx), 0)
  assert.equal(nodeVm.runInContext('sparkNearest([{ x: 0 }, { x: 10 }, { x: 20 }], 99)', ctx), 2)
  // The readings are looked up in the view model by the two names on the svg.
  ;(ctx as Record<string, unknown>).fixture = model({
    quotas: [card({ windows: [win({ spark: slotted([{ i: 3, p: 40, level: 'ok', t: 3 * SLOT, r: null, label: 'three' }]) })] })],
  })
  const found = nodeVm.runInContext(
    'vm = fixture; sparkData({ getAttribute: (k) => k === "data-src" ? "claude" : "session:300" })', ctx,
  ) as { pts: Array<{ label: string }> } | null
  assert.equal(found?.pts[0].label, 'three')
  assert.equal(nodeVm.runInContext('sparkData({ getAttribute: (k) => k === "data-src" ? "codex" : "session:300" })', ctx), null)
})

test('showing a reading sets the marker and the label; hiding clears both', () => {
  const dot: Record<string, unknown> = {}
  const pop = { hidden: true, textContent: '', style: {} as Record<string, string> }
  const svg = {
    querySelector: (sel: string) => (sel === 'path.hov'
      ? { setAttribute: (k: string, v: string) => { dot[k] = v }, removeAttribute: (k: string) => { delete dot[k] } }
      : null),
    parentNode: { querySelector: (sel: string) => (sel === '.pop' ? pop : null) },
  }
  ;(ctx as Record<string, unknown>).probeSvg = svg
  ;(ctx as Record<string, unknown>).probeSpark = slotted([
    { i: 10, p: 20, level: 'ok', t: 10 * SLOT, r: null, label: 'first' },
    { i: 336, p: 30, level: 'ok', t: 336 * SLOT, r: null, label: 'middle' },
  ])
  nodeVm.runInContext('sparkShow(probeSvg, sparkGeometry(probeSpark), 1)', ctx)
  assert.equal(dot.d, 'M336 70h.01')
  assert.equal(pop.textContent, 'middle')
  assert.equal(pop.hidden, false)
  // Half-way along the axis the box is centred on the reading: its anchor slides with it.
  assert.equal(pop.style.left, '50.00%')
  assert.equal(pop.style.transform, 'translateX(-50.00%)')
  // Stepping past the ends stays at the ends.
  nodeVm.runInContext('sparkShow(probeSvg, sparkGeometry(probeSpark), -5)', ctx)
  assert.equal(pop.textContent, 'first')
  assert.equal(dot.d, 'M10 80h.01')
  nodeVm.runInContext('sparkHide()', ctx)
  assert.equal(dot.d, undefined)
  assert.equal(pop.hidden, true)
  assert.equal(nodeVm.runInContext('sparkMark', ctx), null)
  // The pointer follows mousemove, the arrow keys step, Escape and blur hide — and no element
  // is created at hover time, so the script names no namespace URL.
  assert.match(SOURCE, /addEventListener\('mousemove', \(ev\) => \{/)
  assert.match(SOURCE, /ev\.key === 'ArrowLeft' \? -1 : ev\.key === 'ArrowRight' \? 1 : 0/)
  assert.match(SOURCE, /if \(ev\.key === 'Escape'\) \{ sparkHide\(\); return; \}/)
  assert.match(SOURCE, /if \(sparkMark && ev\.target === sparkMark\.svg\) sparkHide\(\);\n\}, true\)/)
  assert.equal(SOURCE.indexOf('createElementNS'), -1)
})

test('the quota card draws the slotted spark and captions its span once', () => {
  const h = render('sQuota()', {
    quotas: [card({ windows: [
      win({ spark: slotted([{ i: 1, p: 1, level: null }, { i: 2, p: 2, level: null }]) }),
      win({ id: 'weekly_all:10080', label: '7 d', spark: slotted([{ i: 1, p: 1, level: null }]) }),
    ] })],
  })
  assert.equal(h.split('<svg class="spark q"').length - 1, 2, h)
  assert.equal(h.split('last 7 days').length - 1, 1, h)
  // A payload that still sends the 24-hour list is drawn the old way and gets no caption
  // that would misstate its span; a window with nothing to draw gets no box.
  const old = render('sQuota()', { quotas: [card({ windows: [win({ spark: [1, 2, 3] })] })] })
  assert.ok(old.indexOf('<svg class="spark"') >= 0, old)
  assert.equal(old.indexOf('last 7 days'), -1, old)
  const none = render('sQuota()', { quotas: [card({ windows: [win({ spark: slotted([]) })] })] })
  assert.equal(none.indexOf('<svg'), -1, none)
  assert.equal(none.indexOf('last 7 days'), -1, none)
})

test('the script scrolls the drill panel into view', () => {
  assert.match(SOURCE, /scrollIntoView\(\{ block: 'nearest' \}\)/)
})

/** A context whose only element is one heat strip, with the two widths that decide it. */
function heatCtx(): { c: nodeVm.Context; heat: Record<string, unknown> } {
  const heat: Record<string, unknown> = {
    dataset: {}, scrollWidth: 701, clientWidth: 420, scrollLeft: 0,
  }
  const c = nodeVm.createContext({
    acquireVsCodeApi: () => ({ postMessage: () => undefined }),
    document: {
      addEventListener: () => undefined,
      getElementById: () => null,
      querySelector: () => null,
      querySelectorAll: (sel: string) => (sel === '.heat' ? [heat] : []),
    },
    window: { addEventListener: () => undefined },
    console,
  })
  nodeVm.runInContext(SCRIPT, c)
  return { c, heat }
}

test('the heat map stays pinned to its newest week across a resize', () => {
  const { c, heat } = heatCtx()
  const pin = (): void => { nodeVm.runInContext('scrollHeat();', c) }
  pin()
  assert.equal(heat.scrollLeft, 281)
  // Dragging the sidebar narrower: the browser leaves the offset where it is while the
  // scrollable width grows underneath it, which used to leave the strip in mid-spring.
  heat.clientWidth = 300
  pin()
  assert.equal(heat.scrollLeft, 401)
  // Dragging it wider again: the browser clamps to the new right end, which is still the end.
  heat.clientWidth = 420
  heat.scrollLeft = 281
  pin()
  assert.equal(heat.scrollLeft, 281)
  // A reader who scrolled back into the spring is left there — on a re-render and a resize.
  heat.scrollLeft = 40
  pin()
  assert.equal(heat.scrollLeft, 40)
  heat.clientWidth = 300
  pin()
  assert.equal(heat.scrollLeft, 40)
  // A strip that fits its box has nowhere to go and is not touched either.
  heat.clientWidth = 701
  heat.scrollLeft = 0
  pin()
  assert.equal(heat.scrollLeft, 0)
})

/**
 * A context of its own with just enough DOM for `renderAll` and `renderSection` to run, so
 * the drill panel's one side effect — moving the page — can be counted.
 */
function drillCtx(): { ctx: nodeVm.Context; scrolls: () => number } {
  let n = 0
  const node = (extra: Record<string, unknown> = {}) => ({
    innerHTML: '', dataset: {}, scrollWidth: 0, clientWidth: 0, style: {}, ...extra,
  })
  const root = node()
  const body = node()
  const sec = node({ scrollIntoView: () => { n++ } })
  const c = nodeVm.createContext({
    acquireVsCodeApi: () => ({ postMessage: () => undefined }),
    document: {
      addEventListener: () => undefined,
      getElementById: () => root,
      querySelector: (s: string) =>
        s === '[data-body="drill"]' ? body : s === '[data-sec="drill"]' ? sec : null,
      querySelectorAll: () => [],
    },
    window: { addEventListener: () => undefined },
    console,
  })
  nodeVm.runInContext(SCRIPT, c)
  return { ctx: c, scrolls: () => n }
}

function drill(day: string): Record<string, unknown> {
  return { day, models: [{ model: 'opus', usageText: '1.0M', requests: '3', costText: '$1' }], sessions: [] }
}

test('the drill panel is scrolled to only when the day changes, never on a refresh', () => {
  const { ctx: c, scrolls } = drillCtx()
  const set = (over: Record<string, unknown>) => { (c as Record<string, unknown>).fixture = model(over) }
  set({ sections: [], drill: drill('2026-09-03') })
  // Opening the view with a day already selected writes the whole page, drill panel and all.
  nodeVm.runInContext('vm = fixture; renderAll();', c)
  assert.equal(scrolls(), 0)
  // A push that only refreshes that same table must leave the reader where they are.
  nodeVm.runInContext('renderSection("drill");', c)
  assert.equal(scrolls(), 0)
  // A day the reader just clicked is worth going to — once.
  set({ sections: [], drill: drill('2026-09-02') })
  nodeVm.runInContext('vm = fixture; renderSection("drill");', c)
  assert.equal(scrolls(), 1)
  nodeVm.runInContext('renderSection("drill");', c)
  assert.equal(scrolls(), 1)
})

// ---------------------------------------------------------------------------
// Folds, chips and the empty quota state
// ---------------------------------------------------------------------------

/** A context whose root node keeps whatever `renderAll` writes into it. */
function pageCtx(): { c: nodeVm.Context; html: () => string } {
  const root = { innerHTML: '', dataset: {}, style: {} }
  const c = nodeVm.createContext({
    acquireVsCodeApi: () => ({ postMessage: () => undefined }),
    document: {
      addEventListener: () => undefined,
      getElementById: () => root,
      querySelector: () => null,
      querySelectorAll: () => [],
    },
    window: { addEventListener: () => undefined },
    console,
  })
  nodeVm.runInContext(SCRIPT, c)
  return { c, html: () => String(root.innerHTML) }
}

function renderPage(over: Record<string, unknown> = {}): string {
  const { c, html } = pageCtx()
  ;(c as Record<string, unknown>).fixture = model(over)
  nodeVm.runInContext('vm = fixture; renderAll();', c)
  return html()
}

test('every section is a fold the keyboard can reach, open unless the reader closed it', () => {
  const open = renderPage({ sections: ['quota', 'history'] })
  // A native <details>: focusable, announced as expandable, and toggled with Enter or Space
  // without a line of ARIA from us. The gear at the end of the header is part of the summary.
  assert.ok(open.indexOf('<details open><summary data-act="section" data-key="quota"><h2>Quota</h2>'
    + '<button class="gear" data-act="sectionSettings" data-key="quota"') >= 0, open)
  assert.equal(open.split('<details').length - 1, 2)

  const folded = renderPage({ sections: ['quota', 'history'], ui: { providers: ['claude'], models: [], collapsed: ['quota'] } })
  assert.ok(folded.indexOf('<details><summary data-act="section" data-key="quota"') >= 0, folded)
  // Folded, not dropped: the body is still in the document, so a section update writes into
  // it whether the reader has it open or not.
  assert.ok(folded.indexOf('<div data-body="quota">') >= 0, folded)
  assert.ok(folded.indexOf('<details open><summary data-act="section" data-key="history"') >= 0, folded)
})

/** The page's blocks in document order, by their `data-sec`. */
function orderOf(html: string): string[] {
  const out: string[] = []
  const re = /data-sec="([a-zA-Z]+)"/g
  for (let m = re.exec(html); m; m = re.exec(html)) out.push(m[1])
  return out
}

test('the filter bar sits below the quota cards and above the first section it filters', () => {
  const order = orderOf
  // 1.7 F1 (pinned and changed: the notices led the page): the provider switch stands above
  // everything — it governs every section — and the bar keeps its own rule below it.
  // The default order: quota first, then the statistics — the chips go between them.
  assert.deepEqual(order(renderPage({ sections: ['quota', 'summary', 'kpis'] })),
    ['provider', 'notices', 'quota', 'controls', 'summary', 'kpis', 'drill', 'footer'])
  // A context card leads the same way; the bar waits for the first section it applies to.
  assert.deepEqual(order(renderPage({ sections: ['quota', 'context', 'kpis'] })),
    ['provider', 'notices', 'quota', 'context', 'controls', 'kpis', 'drill', 'footer'])
  // The Tokens section is fixed periods and follows no chip, so it leads the same way — and
  // where it is listed after a filtered section it stays below the bar: the order is the
  // reader's, the bar only marks where the chips start to apply.
  assert.deepEqual(order(renderPage({ ...tokensVm(), sections: ['quota', 'tokens', 'summary', 'kpis'] })),
    ['provider', 'notices', 'quota', 'tokens', 'controls', 'summary', 'kpis', 'drill', 'footer'])
  assert.deepEqual(order(renderPage({ ...tokensVm(), sections: ['quota', 'summary', 'tokens'] })),
    ['provider', 'notices', 'quota', 'controls', 'summary', 'tokens', 'drill', 'footer'])
  // A reader who puts the statistics first gets the chips at the top, as before — under the switch.
  assert.deepEqual(order(renderPage({ sections: ['summary', 'quota'] })),
    ['provider', 'notices', 'controls', 'summary', 'quota', 'drill', 'footer'])
  // Nothing to filter: the bar is still in the page (the range label and the refresh button
  // live there), after the cards.
  assert.deepEqual(order(renderPage({ sections: ['quota'] })),
    ['provider', 'notices', 'quota', 'controls', 'drill', 'footer'])
  // A preview banner qualifies every figure, so it stands above the quota cards — directly under
  // the switch, which is the page's first element.
  const preview = renderPage({ sections: ['quota', 'kpis'], preview: true })
  assert.ok(preview.indexOf('Preview data') < preview.indexOf('data-sec="quota"'), preview)
  // 1.9 A3.1 (pinned and changed: the switch's group was the block's first and only child): the block is
  // the page's top row, the group first in it.
  assert.ok(preview.startsWith('<div data-sec="provider" data-body="provider"><div class="top"><div class="pv" role="group"'), preview)
  assert.ok(preview.indexOf('</div></div></div><div data-sec="notices" data-body="notices"><div class="box" role="status">Preview data') > 0, preview)
  // Wherever it lands, the bar is one block of its own rather than loose rows of buttons.
  assert.ok(preview.indexOf('<div data-sec="controls" data-body="controls"><div class="bar">') >= 0, preview)
})

test('a payload without the fold list renders every section open', () => {
  // An older extension build sends no `collapsed`; the page may not fold everything away.
  const html = renderPage({ sections: ['quota'], ui: { providers: ['claude'], models: [] } })
  assert.ok(html.indexOf('<details open>') >= 0, html)
})

test('the fold is posted, and a summary is not toggled twice by one key press', () => {
  assert.match(SOURCE, /post\(\{ type: 'toggleSection', key: el\.dataset\.key \}\)/)
  // The keydown fallback exists for the elements that are not natively activatable; a
  // <summary> is, and acting on both events would fold and unfold in one press.
  assert.match(SOURCE, /el\.tagName !== 'SUMMARY'/)
})

test('a delta is coloured by what the figure means, never by the arrow alone', () => {
  const kpi = (over: Record<string, unknown>) => ({
    key: 'k', label: 'L', value: '1', provenance: 'measured', spark: [], note: null,
    delta: { glyph: '▲', text: '+5%' }, polarity: 'upBad', ...over,
  })
  const cls = (over: Record<string, unknown>): string => {
    const h = render('sKpis()', { kpis: [kpi(over)] })
    const m = /<span class="d ([a-z]+)"/.exec(h)
    return m ? m[1] : h
  }
  // More usage is a warning, less of it is good; a cache hit rate reads the other way round.
  assert.equal(cls({}), 'bad')
  assert.equal(cls({ delta: { glyph: '▼', text: '-5%' } }), 'good')
  assert.equal(cls({ polarity: 'upGood' }), 'good')
  assert.equal(cls({ polarity: 'upGood', delta: { glyph: '▼', text: '-5%' } }), 'bad')
  // Neither direction is a verdict for a count of days, and "new" is not a direction at all.
  assert.equal(cls({ polarity: 'neutral' }), 'neutral')
  assert.equal(cls({ delta: { glyph: '', text: 'new' } }), 'neutral')
  assert.equal(cls({ delta: { glyph: '•', text: '+0.1%' } }), 'neutral')
  // The colours themselves are the theme's, and the old arrow-only rules are gone.
  assert.match(STYLE, /\.kpi \.d\.good \{ color: var\(--ok\); \}/)
  assert.match(STYLE, /\.kpi \.d\.bad \{ color: var\(--warn\); \}/)
  assert.match(STYLE, /\.kpi \.d\.neutral \{ color: var\(--dim\); \}/)
  assert.equal(/\.kpi \.d\.(up|down) \{/.test(STYLE), false)
})

/** A KPI with the explanation the view model now builds for every card. */
function kpiCard(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    key: 'usage', label: 'Usage', value: '1.2M', provenance: 'measured', spark: [1, 2],
    note: 'fresh input + cache write + output', delta: { glyph: '▲', text: '+5%' },
    polarity: 'upBad',
    explain: {
      what: 'All tokens the selected range processed',
      how: 'fresh input + cache write + output',
      period: 'last 30 days · 2026-08-05 → 2026-09-03',
      compare: { against: 'previous 30 days · 2026-07-06 → 2026-08-04', previous: '900K' },
      split: { claude: '1M', codex: '200K' },
      provenance: 'measured',
      sparkNote: 'last 14 days · one point per day',
    },
    ...over,
  }
}

test('a key figure explains itself in a popover instead of a native tooltip', () => {
  const h = render('sKpis()', { kpis: [kpiCard()] })
  // A title attribute would be a second tooltip over the same card, and one no keyboard
  // and no screen reader can reach.
  assert.equal(/<div class="kpi"[^>]*title=/.test(h), false, h)
  assert.ok(h.indexOf('<div class="kpi" tabindex="0" data-explain aria-describedby="pop-usage">') >= 0, h)
  assert.ok(h.indexOf('<div class="pop" role="tooltip" id="pop-usage" hidden>') >= 0, h)
  // Labelled lines, in the order the card is read.
  for (const line of [
    '<b>What</b> All tokens the selected range processed',
    '<b>How</b> fresh input + cache write + output',
    // 1.10 B5 rule 2 (rewritten: the days stood bare): each day of an explanation in a .nobr span.
    '<b>Period</b> last 30 days · <span class="nobr">2026-08-05</span> → <span class="nobr">2026-09-03</span>',
    '<b>Compared with</b> previous 30 days · <span class="nobr">2026-07-06</span> → <span class="nobr">2026-08-04</span> · 900K',
    '<b>Basis</b> measured',
    '<b>Spark</b> last 14 days · one point per day',
  ]) {
    assert.ok(h.indexOf(line) >= 0, line + ' missing from ' + h)
  }
  // The providers are named by the registry, the same way every other heading names them.
  assert.ok(h.indexOf('<b>Split</b> Claude Code 1M · Codex 200K') >= 0, h)
  // The popover is inside the card it explains: the card is its containing block, and a
  // pointer moving onto it never leaves the card.
  assert.ok(h.indexOf('class="pop"') > h.indexOf('class="kpi"'), h)
  assert.ok(h.indexOf('</div></div>', h.indexOf('class="pop"')) > 0, h)
})

test('a line of the explanation that has nothing to say is not written at all', () => {
  // No period before the selected one, one provider in the filter: two labels with nothing
  // behind them would announce a comparison and a split that were never made.
  const h = render('sKpis()', {
    kpis: [kpiCard({ explain: { ...(kpiCard().explain as Record<string, unknown>), compare: null, split: null } })],
  })
  assert.equal(h.indexOf('Compared with'), -1, h)
  assert.equal(h.indexOf('Split'), -1, h)
  assert.ok(h.indexOf('<b>What</b>') >= 0, h)
})

test('the explanation opens on hover and on focus, and closes on Escape', () => {
  // mouseenter, focus and blur do not bubble; only a capture-phase listener sees them.
  assert.match(SOURCE, /addEventListener\('mouseenter', \(ev\) => \{[\s\S]*?\}, true\)/)
  assert.match(SOURCE, /addEventListener\('mouseleave', \(ev\) => \{[\s\S]*?\}, true\)/)
  assert.match(SOURCE, /addEventListener\('focus', \(ev\) => \{[\s\S]*?\}, true\)/)
  assert.match(SOURCE, /addEventListener\('blur', \(ev\) => \{[\s\S]*?\}, true\)/)
  assert.match(SOURCE, /ev\.key === 'Escape'/)
  // The block itself, never one of its children: crossing onto the sparkline is not a leave.
  // Found by the attribute every explained block carries, so a quota window and a key figure
  // are one mechanism rather than two copies of it.
  assert.match(SOURCE, /hasAttribute\('data-explain'\)/)
  assert.equal(/classList\.contains\('kpi'\)/.test(SOURCE), false)
  assert.match(STYLE, /\.kpi \{[^}]*position: relative;/)
  assert.match(STYLE, /\.pop \{ position: absolute; top: 100%; left: 0; z-index: 5;/)
  assert.match(STYLE, /\.pop\.right \{ left: auto; right: 0; \}/)
  // The hover-widget colours, with the page's own tokens behind them.
  assert.match(STYLE, /--vscode-editorHoverWidget-background/)
  assert.match(STYLE, /--vscode-editorHoverWidget-border/)
})

test('an explanation on the right of the grid hangs from the right edge of its card', () => {
  const moves: string[] = []
  const pop = {
    hidden: true,
    classList: { add: (c: string) => moves.push('add:' + c), remove: (c: string) => moves.push('remove:' + c) },
  }
  const cardAt = (left: number) => ({
    querySelector: () => pop,
    getBoundingClientRect: () => ({ left, width: 100 }),
  })
  const open = (left: number): string[] => {
    moves.length = 0
    ;(ctx as Record<string, unknown>).probe = cardAt(left)
    nodeVm.runInContext('window.innerWidth = 400; showPop(probe);', ctx)
    return moves
  }
  // A card whose middle is left of the panel's middle keeps the default anchor …
  assert.deepEqual(open(10), ['remove:right'])
  assert.equal(pop.hidden, false)
  // … one on the right side would run off the page and is anchored the other way.
  assert.deepEqual(open(280), ['add:right'])
  nodeVm.runInContext('hidePop();', ctx)
  assert.equal(pop.hidden, true)
})

/** A window with the explanation the view model builds for every bar. */
function explained(over: Record<string, unknown> = {}): Record<string, unknown> {
  return win({
    level: 'warn', percent: 70, percentText: '70 %', elapsed: 30,
    verdict: { text: '40 % ahead of pace', level: 'warn' },
    explain: {
      title: 'Why yellow',
      lines: [
        'Used 70 % of the window; 30 % of its time has passed → 40 % ahead of pace.',
        'Yellow as soon as the reading is ahead of pace; green at or behind.',
      ],
    },
    ...over,
  })
}

test('a quota window explains its colour in the same popover the key figures use', () => {
  const h = render('sQuota()', { quotas: [card({ windows: [explained()] })] })
  // Focusable and pointing at its own panel, like a key figure; no title attribute beside it.
  assert.ok(h.indexOf('<div class="win" tabindex="0" data-explain aria-describedby="pop-q-claude-session-300">') >= 0, h)
  assert.equal(/<div class="win"[^>]*title=/.test(h), false, h)
  // The title names the colour; every line is the view model's, in its order.
  assert.ok(h.indexOf('<div class="pop" role="tooltip" id="pop-q-claude-session-300" hidden>'
    + '<div><b>Why yellow</b></div>'
    + '<div>Used 70 % of the window; 30 % of its time has passed → 40 % ahead of pace.</div>'
    + '<div>Yellow as soon as the reading is ahead of pace; green at or behind.</div></div>') >= 0, h)
  // Inside the block it explains, after the bar, so hovering the panel keeps the block
  // hovered — and the block is the panel's containing block.
  const pop = h.indexOf('class="pop"')
  assert.ok(pop > h.indexOf('<div class="win"') && pop > h.indexOf('class="track"'), h)
  assert.ok(h.indexOf('</div></div>', pop) > 0, h)
  assert.match(STYLE, /\.win \{[^}]*position: relative;/)
  // The id is safe for aria-describedby whatever the window id contains.
  const odd = render('sQuota()', { quotas: [card({ windows: [explained({ id: 'codex_bengalfox:300' })] })] })
  assert.ok(odd.indexOf('aria-describedby="pop-q-claude-codex_bengalfox-300"') >= 0, odd)
  // Two windows, two panels, each with an id of its own.
  const two = render('sQuota()', {
    quotas: [card({ windows: [explained(), explained({ id: 'weekly_all:10080', label: '7 d' })] })],
  })
  assert.equal(two.split('class="pop"').length - 1, 2, two)
  assert.ok(two.indexOf('id="pop-q-claude-weekly_all-10080"') >= 0, two)
  // Markup in a line is text, never markup.
  const sharp = render('sQuota()', {
    quotas: [card({ windows: [explained({ explain: { title: '<b>x</b>', lines: ['a < b & "c"'] } })] })],
  })
  assert.ok(sharp.indexOf('<b>&lt;b&gt;x&lt;/b&gt;</b>') >= 0, sharp)
  assert.ok(sharp.indexOf('<div>a &lt; b &amp; &quot;c&quot;</div>') >= 0, sharp)
})

test('a window opens its own explanation, not the sparkline\'s hover label', () => {
  // A window with history carries two popovers inside the same explained block: the
  // sparkline's hover label, written first and empty until the pointer is on the spark, and
  // the explanation, written last. A lookup for `.pop` alone finds the sparkline's — which is
  // why the explanation is looked up as the block's own child.
  const spark = slotted([
    { i: 1, p: 10, level: 'ok', t: SLOT, r: null, label: 'Thu 3 Sep · 00:15 · 10 %' },
    { i: 2, p: 40, level: 'warn', t: 2 * SLOT, r: null, label: 'Thu 3 Sep · 00:30 · 40 %' },
  ])
  const h = render('sQuota()', { quotas: [card({ windows: [explained({ spark })] })] })
  const block = between(h, /<div class="win" tabindex="0" data-explain[^>]*>/, '<div class="legend">')
  // The sparkline's label really is the first `.pop` in the block, and the explanation the
  // second: the order this guards against.
  const ids = block.split('<div class="pop"').slice(1)
    .map((part) => (/^ role="tooltip" id="([^"]+)"/.exec(part) ?? [])[1] ?? '')
  assert.deepEqual(ids, ['', 'pop-q-claude-session-300'], block)
  // Only the explanation is a child of the block; the sparkline's label sits in .sparkbox.
  assert.ok(block.indexOf('<div class="sparkbox">') < block.indexOf('<div class="pop" role="tooltip" id='), block)
  // The node showPop picks, with the block's two popovers behind the two selectors it may
  // use. The one it opens must be the explanation the block points at with aria-describedby.
  const make = (id: string): { id: string; hidden: boolean; classList: { add: () => void; remove: () => void } } => ({
    id, hidden: true, classList: { add: () => undefined, remove: () => undefined },
  })
  const sparkLabel = make('')
  const explanation = make('pop-q-claude-session-300')
  ;(ctx as Record<string, unknown>).probe = {
    // A descendant lookup answers in document order; a child lookup skips the .sparkbox.
    querySelector: (sel: string) => (sel.indexOf(':scope >') === 0 ? explanation : sparkLabel),
    getBoundingClientRect: () => ({ left: 10, width: 100 }),
  }
  nodeVm.runInContext('window.innerWidth = 400; showPop(probe);', ctx)
  assert.equal(nodeVm.runInContext('openPop.id', ctx), 'pop-q-claude-session-300')
  assert.equal(explanation.hidden, false)
  assert.equal(sparkLabel.hidden, true)
  nodeVm.runInContext('hidePop();', ctx)
})

test('a window without an explanation gets neither the attributes nor an empty panel', () => {
  // A payload from a build that predates the field: nothing to show, so nothing to focus.
  const h = render('sQuota()', { quotas: [card({ windows: [win()] })] })
  assert.ok(h.indexOf('<div class="win"><div class="win-top">') >= 0, h)
  assert.equal(h.indexOf('data-explain'), -1, h)
  assert.equal(h.indexOf('class="pop"'), -1, h)
  assert.equal(h.indexOf('tabindex'), -1, h)
})

test('one explanation mechanism: any block with data-explain, key figure or window', () => {
  assert.match(SOURCE, /hasAttribute\('data-explain'\)/)
  assert.ok(render('sKpis()', { kpis: [kpiCard()] }).indexOf('<div class="kpi" tabindex="0" data-explain ') >= 0)
  assert.ok(render('sQuota()', { quotas: [card({ windows: [explained()] })] })
    .indexOf('<div class="win" tabindex="0" data-explain ') >= 0)
})

test('an open explanation and the focus on its block survive a refresh of the section', () => {
  // The quota section is rewritten every few seconds while the prompt-cache countdown ticks.
  // The panel a reader is looking at, and the focus a keyboard user placed on its block, are
  // put back on the nodes that replace them — by id, because the old nodes are gone.
  const focused: string[] = []
  const looked: string[] = []
  const popOf = (card: Record<string, unknown>, id: string): Record<string, unknown> =>
    ({ id, hidden: true, classList: { add: () => undefined, remove: () => undefined }, closest: () => card })
  const cardOf = (name: string, id: string): Record<string, unknown> => {
    const card: Record<string, unknown> = {
      getBoundingClientRect: () => ({ left: 10, width: 100 }),
      focus: () => { focused.push(name) },
    }
    card.pop = popOf(card, id)
    card.querySelector = () => card.pop
    return card
  }
  const before = cardOf('before', 'pop-q-claude-session-300')
  const after = cardOf('after', 'pop-q-claude-session-300')
  const elsewhere = cardOf('elsewhere', 'pop-usage')
  const body = { innerHTML: '', dataset: {}, style: {}, contains: (el: unknown) => el === before.pop }
  // The page body is what is active when nothing is focused, and it contains every panel.
  const pageBody = { contains: () => true }
  const doc: Record<string, unknown> = {
    addEventListener: () => undefined,
    getElementById: (id: string) => { looked.push(id); return id === 'pop-q-claude-session-300' ? after.pop : null },
    querySelector: (s: string) => (s === '[data-body="quota"]' ? body : null),
    querySelectorAll: () => [],
    activeElement: pageBody,
  }
  const c = nodeVm.createContext({
    acquireVsCodeApi: () => ({ postMessage: () => undefined }),
    document: doc,
    window: { addEventListener: () => undefined, innerWidth: 400 },
    console,
  })
  nodeVm.runInContext(SCRIPT, c)
  Object.assign(c, { fixture: model({ quotas: [card({ windows: [explained()] })] }), before, after, elsewhere })
  nodeVm.runInContext('vm = fixture; showPop(before);', c)
  assert.equal((before.pop as { hidden: boolean }).hidden, false)

  // Hovered, not focused: the panel comes back, and no focus is invented for it.
  nodeVm.runInContext('renderSection("quota");', c)
  assert.equal((after.pop as { hidden: boolean }).hidden, false)
  assert.equal(nodeVm.runInContext('openPop === after.pop', c), true)
  assert.deepEqual(focused, [])
  assert.deepEqual(looked, ['pop-q-claude-session-300'])

  // Focused on the block: the panel comes back and so does the focus.
  nodeVm.runInContext('showPop(before);', c)
  doc.activeElement = { hasAttribute: (a: string) => a === 'data-explain', contains: (el: unknown) => el === before.pop }
  nodeVm.runInContext('renderSection("quota");', c)
  assert.equal(nodeVm.runInContext('openPop === after.pop', c), true)
  assert.deepEqual(focused, ['after'])
  assert.deepEqual(looked, ['pop-q-claude-session-300', 'pop-q-claude-session-300'])
  doc.activeElement = pageBody

  // A panel open outside the refreshed section is left exactly as it is, and nothing is
  // looked up for it.
  nodeVm.runInContext('showPop(elsewhere); renderSection("quota");', c)
  assert.equal((elsewhere.pop as { hidden: boolean }).hidden, false)
  assert.equal(nodeVm.runInContext('openPop === elsewhere.pop', c), true)
  assert.deepEqual(looked, ['pop-q-claude-session-300', 'pop-q-claude-session-300'])
  assert.deepEqual(focused, ['after'])
  // With nothing open a refresh restores nothing.
  nodeVm.runInContext('hidePop(); renderSection("quota");', c)
  assert.deepEqual(looked, ['pop-q-claude-session-300', 'pop-q-claude-session-300'])
  assert.equal(nodeVm.runInContext('openPop', c), null)

  // The spark hover marks an svg by reference, and that svg is one of the nodes the refresh
  // replaces. A mark inside the refreshed body is dropped; one outside it is left alone.
  const inside = { querySelector: () => null, parentNode: null }
  const outside = { querySelector: () => null, parentNode: null }
  Object.assign(c, { inside, outside })
  body.contains = (el: unknown) => el === inside
  nodeVm.runInContext('sparkMark = { svg: inside, g: null, k: 0 }; renderSection("quota");', c)
  assert.equal(nodeVm.runInContext('sparkMark', c), null)
  nodeVm.runInContext('sparkMark = { svg: outside, g: null, k: 0 }; renderSection("quota");', c)
  assert.equal(nodeVm.runInContext('sparkMark && sparkMark.svg === outside', c), true)
})

test('the prompt-cache line is the last line of the Claude card, and only with a reading', () => {
  const line = 'prompt cache warm · expires in 3 m 40 s (5 min TTL) · hit ratio 82 %'
  const h = render('sQuota()', {
    quotas: [card({ promptCache: { text: line, note: 'current session, via the status line', expired: false } })],
  })
  // 1.10 B5 rule 3 (rewritten: the line is glued on the page — "3 m 40 s", "5 min", "82 %" kept with their units).
  assert.ok(h.indexOf('<div class="meta" title="current session, via the status line">' + glued(line) + '</div></div>') >= 0, h)
  // Last: after the sparkline caption, the extra usage and any local block.
  const withExtra = render('sQuota()', {
    quotas: [card({
      promptCache: { text: line, note: 'n', expired: false },
      extra: { text: '$12 of $50', utilization: 24, enabled: true, billed: true },
    })],
  })
  assert.ok(withExtra.indexOf(glued(line)) > withExtra.indexOf('Extra usage'), withExtra)
  assert.ok(withExtra.indexOf(glued(line)) > withExtra.indexOf('class="track"'), withExtra)
  // Without a reading nothing is drawn — not a dash line, not an estimate.
  const none = render('sQuota()', { quotas: [card({ promptCache: null })] })
  assert.equal(none.indexOf('prompt cache'), -1, none)
  // An odd payload with an empty text draws nothing either.
  const empty = render('sQuota()', { quotas: [card({ promptCache: { text: '', note: 'n' } })] })
  assert.equal(empty.indexOf('prompt cache'), -1, empty)
  // Every word is the model's: a dash in the text stays a dash, and the line ticks on nothing
  // of its own. The page has exactly one interval, and it moves the agent tree's live spans —
  // this line carries none. 1.10 P5 (pinned and changed: no setTimeout at all): the Prompts section's
  // own timeouts — the single click's delay, a draw after the focus moved or the pointer came up, the
  // page's sentence in its flash line — each inside a prompt function, none of them near this line.
  const bare = render('sQuota()', {
    quotas: [card({ promptCache: { text: 'prompt cache – · expires in – (– TTL) · hit ratio –', note: 'n' } })],
  })
  assert.ok(bare.indexOf('prompt cache – · expires in – (– TTL) · hit ratio –') >= 0, bare)
  assert.equal(bare.indexOf('data-live'), -1, bare)
  assert.equal((SOURCE.match(/setInterval\(/g) ?? []).length, 1)
  assert.deepEqual(timeoutsBy(), ['promptDrawLater', 'promptSay', 'promptEditClick', 'promptPointerUp'])
})

test('the prompt-cache line carries its own age, and an old reading is marked as one', () => {
  // The header's age belongs to whichever source won the quota race; this line was read from
  // the status-line mirror, so it says when *that* was.
  const line = 'prompt cache warm · expires in 3 m 40 s (5 min TTL) · hit ratio 82 %'
  const old = render('sQuota()', {
    quotas: [card({ promptCache: { text: line, note: 'n', expired: false, ageText: '3 d ago', fresh: false } })],
  })
  // 1.10 B5 rule 3 (rewritten: the line and its age glued).
  assert.ok(old.indexOf('<div class="meta warn" title="n">' + glued(line + ' · updated 3 d ago') + ' · ⚠ stale</div>') >= 0, old)
  const fresh = render('sQuota()', {
    quotas: [card({ promptCache: { text: line, note: 'n', expired: false, ageText: '1 min ago', fresh: true } })],
  })
  assert.ok(fresh.indexOf('<div class="meta" title="n">' + glued(line + ' · updated 1 min ago') + '</div>') >= 0, fresh)
  // A payload from a build without the fields is marked neither fresh nor stale.
  const older = render('sQuota()', {
    quotas: [card({ promptCache: { text: line, note: 'n', expired: false } })],
  })
  assert.ok(older.indexOf('<div class="meta" title="n">' + glued(line) + '</div>') >= 0, older)
  assert.equal(older.indexOf('stale'), -1, older)
})

test('with no quota card at all the section says how to get one, and invents nothing', () => {
  const h = render('sQuota()', { quotas: [] })
  assert.equal(/\d ?%/.test(h), false, h)
  // Both ways out, each as a button the webview is allowed to send.
  assert.ok(h.indexOf('data-id="tokenPace.refreshQuota"') >= 0, h)
  assert.ok(h.indexOf('data-id="tokenPace.connectStatusLine"') >= 0, h)
  assert.ok(h.indexOf('status line') >= 0, h)
  // A card that exists but cannot be read keeps its own problem box instead.
  const broken = render('sQuota()', {
    quotas: [card({ problem: 'offline', problemKind: 'offline', windows: [],
      problemAction: { label: 'Fetch quota now', command: 'tokenPace.refreshQuota' } })],
  })
  assert.equal(broken.indexOf('tokenPace.connectStatusLine') >= 0, false, broken)
})

test('a card per provider with nothing in it is the same state as no card at all', () => {
  // The quota manager builds one card per provider whatever happens, so "vm.quotas is
  // empty" is not the state a user is ever in: what they see is two cards with no window
  // in them. Both reach the invitation, and the reason each provider gave is kept.
  const waiting = [
    card({ problem: 'network access not granted yet', problemKind: 'consentPending', windows: [],
      problemAction: { label: 'Fetch quota now', command: 'tokenPace.refreshQuota' } }),
    card({ source: 'codex', title: 'Codex', problem: 'quota reading is switched off',
      problemKind: 'quotaOff', windows: [], problemAction: null }),
  ]
  const h = render('sQuota()', { quotas: waiting })
  assert.ok(h.indexOf('No quota reading yet.') >= 0, h)
  assert.ok(h.indexOf('data-id="tokenPace.connectStatusLine"') >= 0, h)
  assert.ok(h.indexOf('Claude Code: network access not granted yet') >= 0, h)
  assert.ok(h.indexOf('Codex: quota reading is switched off') >= 0, h)
  assert.equal(/\d ?%/.test(h), false, h)
  // One provider that does have a reading, and the cards win: there is something to show.
  const half = render('sQuota()', { quotas: [waiting[0], card({ source: 'codex', title: 'Codex' })] })
  assert.equal(half.indexOf('No quota reading yet.') >= 0, false, half)
  // A kind neither exit repairs keeps its own box, even with no window on the card.
  const offline = render('sQuota()', {
    quotas: [card({ problem: 'offline', problemKind: 'offline', windows: [] }),
      card({ source: 'codex', title: 'Codex', problem: 'offline', problemKind: 'offline', windows: [] })],
  })
  assert.equal(offline.indexOf('No quota reading yet.') >= 0, false, offline)
})

test('the model row is one chip until it is asked for, once there are more than four', () => {
  const row = (m: string) => ({
    model: m, source: 'claude', isSub: false, tier: 'standard', usage: 1, usageText: '1',
    output: '1', requests: '1', cost: 0, costText: '–', listCost: null, cacheHit: '–',
    share: '100 %', costShare: '–', priced: 'exact', price: '–', turnAvg: null, turnP90: null,
  })
  const names = ['a', 'b', 'c', 'd', 'e', 'f']
  const all = { rows: names.map(row), total: 6, hidden: 0, sort: { key: 'usage', dir: 'desc' } }
  const h = render('controls()', { models: all })
  // Six model names are the widest thing on the bar, so the row folds to its own count chip.
  assert.equal(h.split('data-act="model"').length - 1, 0, h)
  assert.ok(h.indexOf('<button data-act="moreModels">models (6) ▾</button>') >= 0, h)
  assert.ok(h.indexOf('<span class="meta">Models</span>') >= 0, h)
  // A model that is being filtered on is never folded away: a chip the reader cannot see is
  // a filter they cannot switch off.
  const filtered = render('controls()', {
    models: all, ui: { providers: ['claude'], models: ['f'], collapsed: [] },
  })
  assert.ok(filtered.indexOf('data-model="f"') >= 0, filtered)
  assert.equal(filtered.split('data-act="model"').length - 1, 1, filtered)
  // And the way out of the filter is beside it, folded row or not.
  assert.ok(filtered.indexOf('<button data-act="clearModels">clear</button>') >= 0, filtered)
  // Opened, the row shows every chip, the way out of the filter and the way back.
  ;(ctx as Record<string, unknown>).fixture = model({
    models: all, ui: { providers: ['claude'], models: ['f'], collapsed: [] },
  })
  const opened = String(nodeVm.runInContext('vm = fixture; (function () { allModels = true;'
    + ' var h = controls(); allModels = false; return h; })()', ctx))
  for (const n of names) assert.ok(opened.indexOf('data-model="' + n + '"') >= 0, n + ': ' + opened)
  assert.ok(opened.indexOf('<button data-act="clearModels">clear</button>') >= 0, opened)
  assert.ok(opened.indexOf('<button data-act="moreModels">fewer ▴</button>') >= 0, opened)
  // Four or fewer and there is nothing to fold.
  const few = render('controls()', {
    models: { rows: names.slice(0, 3).map(row), total: 3, hidden: 0, sort: { key: 'usage', dir: 'desc' } },
  })
  assert.equal(few.indexOf('data-act="moreModels"') >= 0, false, few)
  assert.equal(few.split('data-act="model"').length - 1, 3, few)
})

test('a model filtered down to nothing keeps its chip and the way back', () => {
  // The model table is filtered by these very chips, so a filter on a model with no bucket
  // in the range empties the table the chip names are read from. Dropping the row then would
  // leave the reader with every section saying "no data" and nothing to switch off.
  const h = render('controls()', {
    models: { rows: [], total: 0, hidden: 0, sort: { key: 'usage', dir: 'desc' } },
    ui: { providers: ['claude', 'codex'], models: ['claude-opus-4-6'], collapsed: [] },
  })
  assert.ok(h.indexOf('<span class="meta">Models</span>') >= 0, h)
  assert.ok(h.indexOf('data-act="model" data-model="claude-opus-4-6" aria-pressed="true"') >= 0, h)
  assert.ok(h.indexOf('<button data-act="clearModels">clear</button>') >= 0, h)
  // With no filter and no rows there is nothing to say, and the row is not drawn.
  const empty = render('controls()', {
    models: { rows: [], total: 0, hidden: 0, sort: { key: 'usage', dir: 'desc' } },
  })
  assert.equal(empty.indexOf('<span class="meta">Models</span>'), -1, empty)
})

test('the date fields stay out of the way until the range is a custom one', () => {
  const preset = render('controls()')
  assert.equal(preset.indexOf('data-role="from"') >= 0, false, preset)
  assert.ok(preset.indexOf('data-act="customDates"') >= 0, preset)
  for (const p of ['custom', 'all']) {
    const h = render('controls()', {
      range: { from: '2026-08-05', to: '2026-09-03', label: 'Custom', preset: p, presets: ['7d', '30d'] },
    })
    assert.ok(h.indexOf('data-role="from"') >= 0, p)
    assert.ok(h.indexOf('data-role="to"') >= 0, p)
    assert.ok(h.indexOf('data-act="customRange"') >= 0, p)
  }
})

test('a clipped table is announced once the browser has measured it', () => {
  assert.match(SOURCE, /scrollWidth > el\.clientWidth/)
  assert.match(SOURCE, /class="meta scrollhint"/)
})

test('the filter bar is a labelled grid: one row per thing it filters', () => {
  const models = { rows: [modelRow()], total: 1, hidden: 0, sort: { key: 'usage', dir: 'desc' } }
  const h = render('controls()', { models })
  // One block, not a run of button rows: the labels share a column, so the chips of both rows
  // start at the same x. 1.7 F1 (pinned and changed: three rows, the providers' one of them): the
  // providers left the bar for the switch at the top of the page, and the bar filters the range
  // and the models.
  assert.ok(h.startsWith('<div class="bar">'), h)
  for (const label of ['Range', 'Models']) {
    assert.equal(h.split('<span class="meta">' + label + '</span>').length - 1, 1, label + ': ' + h)
  }
  assert.equal(h.indexOf('Providers'), -1, h)
  assert.equal(h.indexOf('data-act="provider'), -1, h)
  assert.equal(h.split('<span class="meta">').length - 1, 2, h)
  // Every row's label is followed by the cell that carries its chips.
  assert.ok(h.indexOf('<span class="meta">Models</span><div class="wrap span2">'
    + '<button data-act="model"') >= 0, h)
  // The range in words ends the range row instead of taking a line of its own …
  // 1.10 B5 rule 2 (rewritten: the two days stood bare): each ISO day whole, never broken at its hyphen.
  assert.ok(h.indexOf('<span class="meta cap">Last 30 days · <span class="nobr">2026-08-05</span> → <span class="nobr">2026-09-03</span></span></div>') >= 0, h)
  // … and the refresh button is the last thing in that row, an icon with a name of its own.
  assert.ok(h.indexOf('</span></div><button class="icon" data-act="refresh" aria-label="Refresh"'
    + ' title="Rebuild from the transcripts and fetch the quota"><svg') >= 0, h)
  // Inline SVG, never an icon font or a file: the page loads nothing from anywhere.
  assert.equal(/<img|@font-face|url\(/.test(h), false, h)
  assert.ok(h.indexOf('stroke="currentColor"') >= 0, h)
  // The date fields are a line of their own, directly under the range they belong to.
  const dates = render('controls()', {
    models,
    range: { from: '2026-08-05', to: '2026-09-03', label: 'Custom', preset: 'custom', presets: ['7d', '30d'] },
  })
  assert.ok(dates.indexOf('</button><div class="wrap full"><label class="meta" for="tp-from">') >= 0, dates)
  assert.ok(dates.indexOf('data-act="customRange">apply</button></div><span class="meta">Models</span>') >= 0, dates)

  // The grid itself: a first column wide enough for the longest label, a tinted block with a
  // hairline around it, and the row gap the three rows breathe by.
  const bar = /\.bar \{([^}]*)\}/.exec(STYLE)
  assert.ok(bar, 'the filter bar has no rule')
  const rule = (bar as RegExpExecArray)[1]
  assert.match(rule, /display: grid/)
  assert.match(rule, /grid-template-columns: minmax\(62px, max-content\) 1fr auto/)
  assert.match(rule, /gap: 6px 8px/)
  assert.match(rule, /background: color-mix\(in srgb, var\(--vscode-foreground\) 4%, transparent\)/)
  assert.match(rule, /border: 1px solid var\(--line\)/)
  assert.match(rule, /border-radius: 4px/)
  assert.match(rule, /padding: 8px/)
  // The rows that have no icon take the width the refresh button leaves.
  assert.match(STYLE, /\.bar \.span2 \{ grid-column: 2 \/ 4; \}/)
  assert.match(STYLE, /\.bar \.full \{ grid-column: 1 \/ 4; \}/)
  assert.match(STYLE, /\.icon \{[^}]*justify-self: end/)
})

test('the range row keeps three presets and folds the rest away', () => {
  const presets = ['today', 'yesterday', '7d', '30d', '90d', 'thisWeek', 'thisMonth',
    'lastMonth', 'year', 'all']
  const range = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
    range: { from: '2026-08-05', to: '2026-09-03', label: 'Last 30 days', preset: '30d', presets, ...over },
  })
  const h = render('controls()', range())
  for (const p of ['today', '7d', '30d']) {
    assert.ok(h.indexOf('data-preset="' + p + '"') >= 0, p + ': ' + h)
  }
  for (const p of ['yesterday', '90d', 'thisWeek', 'year', 'all']) {
    assert.equal(h.indexOf('data-preset="' + p + '"') >= 0, false, p + ': ' + h)
  }
  assert.ok(h.indexOf('<button data-act="moreRanges">more ▾</button>') >= 0, h)
  // A selected preset that the fold would hide stays on the bar: a chip the reader cannot
  // see is a range they cannot leave.
  const year = render('controls()', range({ preset: 'year', label: 'This year' }))
  assert.ok(year.indexOf('data-preset="year" aria-pressed="true"') >= 0, year)
  // Unfolded: every preset, and the way back.
  ;(ctx as Record<string, unknown>).fixture = model(range())
  const opened = String(nodeVm.runInContext('vm = fixture; (function () { allRanges = true;'
    + ' var h = controls(); allRanges = false; return h; })()', ctx))
  for (const p of presets) assert.ok(opened.indexOf('data-preset="' + p + '"') >= 0, p + ': ' + opened)
  assert.ok(opened.indexOf('<button data-act="moreRanges">fewer ▴</button>') >= 0, opened)
  assert.equal(opened.indexOf('more ▾') >= 0, false, opened)
})

test('sections are set apart from each other and from the bar', () => {
  // They used to run into one another, and a folded section glued itself to the filter bar.
  // The rhythm is on the section, not on the heading, so a fold changes nothing about it.
  assert.match(STYLE, /section \{ margin-top: 22px; padding-top: 10px; border-top: 1px solid var\(--line\); \}/)
  const summary = /summary \{([^}]*)\}/.exec(STYLE)
  assert.ok(summary, 'the section head has no rule')
  const head = (summary as RegExpExecArray)[1]
  assert.match(head, /min-height: 24px/)
  assert.match(head, /display: flex/)
  assert.match(head, /align-items: center/)
  // The heading no longer carries the gap; the row it sits in does.
  assert.match(STYLE, /summary h2 \{[^}]*margin: 0/)
  assert.match(STYLE, /details\[open\] summary \{ margin-bottom: 8px; \}/)
  assert.match(STYLE, /\.kpis \{[^}]*margin-bottom: 8px/s)
  // Two provider cards in one section are told apart by a hairline, and only there.
  assert.match(STYLE,
    /\[data-body="quota"\] \.card \+ \.card \{ border-top: 1px solid var\(--line\); padding-top: 10px; \}/)
  assert.match(STYLE, /\.legend \{[^}]*margin-top: 6px/)
})

test('every section header carries a gear that opens its own settings', () => {
  const html = renderPage({ sections: ['quota', 'summary', 'kpis'] })
  for (const key of ['quota', 'summary', 'kpis']) {
    assert.ok(html.indexOf('<button class="gear" data-act="sectionSettings" data-key="' + key
      + '" aria-label="Settings for this section" title="Settings for this section">') >= 0,
    key + ': ' + html)
  }
  // Inside the summary, at its right end, and drawn rather than typed.
  assert.ok(html.indexOf('<h2>Quota</h2><button class="gear"') >= 0, html)
  assert.equal(html.split('</svg></button></summary>').length - 1, 3, html)
  assert.match(STYLE, /summary h2 \{[^}]*flex: 1 1 auto/)
  assert.match(STYLE, /\.gear \{[^}]*opacity: \.6/s)
  // 24 x 24 around the 16 px icon: the whole summary row folds the section, so a click three
  // pixels off the gear must not close what it was meant to open.
  assert.match(STYLE, /\.gear \{[^}]*padding: 4px; margin: -4px -2px/s)
  assert.match(STYLE, /\.gear:hover, \.gear:focus-visible \{ opacity: 1/)
  // The fold is the summary's default action: without both of these, opening the settings
  // would close the section on the way out — with the mouse and with the keyboard.
  assert.match(SOURCE, /if \(el\.dataset\.act === 'sectionSettings'\) \{ ev\.stopPropagation\(\); ev\.preventDefault\(\); \}/)
  assert.match(SOURCE, /post\(\{ type: 'openSectionSettings', key: el\.dataset\.key \}\)/)
  const keydown = SOURCE.slice(SOURCE.indexOf("document.addEventListener('keydown'"))
  assert.match(keydown, /el\.dataset\.act === 'sectionSettings'[\s\S]{0,160}ev\.stopPropagation\(\);\s*ev\.preventDefault\(\);\s*act\(el\);/)
})

// ---------------------------------------------------------------------------
// Nothing invented, nothing broken
// ---------------------------------------------------------------------------

test('no renderer invents a number or leaks an undefined', () => {
  // The plain fixture carries no agent tree at all, which is a payload an older build sends.
  const calls = ['sQuota()', 'sAgents()', 'sHistory()', 'sChart()', 'sHours()', 'sHeatmap()',
    'sFooter()', 'controls()']
  for (const call of calls) {
    const h = render(call)
    assert.equal(/undefined|NaN|Infinity|\[object Object\]/.test(h), false, call + ': ' + h)
  }
})

test('the message hooks the extension parses are all still in the page', () => {
  // 1.7 F1 (pinned and changed: the filter bar's `provider` chips posted `setFilter`): the provider
  // switch's buttons are `providerView`, and they post `setProvider`, which the host parses.
  for (const act of ['range', 'customRange', 'customDates', 'refresh', 'cmd', 'sort', 'providerView',
    'model', 'clearModels', 'moreModels', 'moreRanges', 'section', 'sectionSettings',
    'heatmapMetric', 'hourZone', 'drill', 'costLine', 'metric', 'compositionCache',
    'agentToggle', 'agentSelect', 'agentMore']) {
    assert.ok(SOURCE.indexOf('data-act="' + act + '"') >= 0, act)
  }
  assert.equal(SOURCE.indexOf('data-act="provider"'), -1)
  assert.equal(/a === 'provider'\)/.test(SOURCE), false)
  assert.ok(SOURCE.indexOf("post({ type: 'setProvider', provider: s });") >= 0)
  for (const provider of ['all', 'claude', 'codex']) {
    assert.deepEqual(parseWebviewMessage({ type: 'setProvider', provider }), { type: 'setProvider', provider })
  }
  // 1.5.0's fold is gone from the page as it is from the host's allow-list.
  assert.equal(SOURCE.indexOf('agentFold'), -1)
  assert.equal(SCRIPT.indexOf('agentFold'), -1)
  for (const role of ['from', 'to']) {
    assert.ok(SOURCE.indexOf('data-role="' + role + '"') >= 0, role)
  }
})

test('long tokens break instead of widening the page, and a window header wraps instead of clipping', () => {
  // The real host at 270 px scrolled sideways by the width of one unbreakable path in the
  // data-quality list, and cut "…resets 4h59m" out of a long window header. Chrome breaks
  // paths at slashes on its own; the webview host did not.
  const css = STYLE
  assert.match(css, /body \{[^}]*overflow-wrap: anywhere/s)
  const winTop = css.match(/\.win-top span \{[^}]*\}/)
  assert.ok(winTop, 'the header label rule is missing')
  assert.equal(winTop[0].includes('text-overflow'), false, winTop[0])
  assert.equal(winTop[0].includes('nowrap'), false, winTop[0])
})

// ---------------------------------------------------------------------------
// Context window
// ---------------------------------------------------------------------------

function contextCard(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    used: 128_000, size: 200_000, percentText: '64 %', text: '128,000 / 200,000 · 64 %',
    ageText: '2 min ago', fresh: true, note: 'current session, via the status line', ...over,
  }
}

test('the context card names the session it describes and prints the figure once', () => {
  const h = render('sContext()', { context: contextCard() })
  assert.ok(h.includes('Context window'), h)
  assert.ok(h.includes('128,000 / 200,000 · 64 %'), h)
  assert.ok(h.includes('current session, via the status line'), h)
  // One conversation, not an account: no verdict, no pace, no forecast on this card.
  assert.equal(/pace|verdict|forecast|resets/i.test(h), false, h)
  assert.ok(h.includes('<div class="track"'), h)
})

test('a context reading without a window size gets tokens and no bar at all', () => {
  const h = render('sContext()', {
    context: contextCard({ size: null, percentText: '–', text: '128,000 tokens' }),
  })
  assert.ok(h.includes('128,000 tokens'), h)
  // A share needs a denominator: no size, no percentage and no bar to imply one.
  assert.equal(h.includes('%'), false, h)
  assert.equal(h.includes('<div class="track"'), false, h)
})

test('a stale context reading is marked, a fresh one is not', () => {
  const stale = render('sContext()', { context: contextCard({ fresh: false, ageText: '3 h ago' }) })
  assert.ok(stale.includes('⚠ stale'), stale)
  assert.ok(stale.includes('updated 3 h ago'), stale)
  assert.equal(render('sContext()', { context: contextCard() }).includes('stale'), false)
})

test('without a reading the context section offers the bridge instead of a number', () => {
  const h = render('sContext()', { context: null })
  assert.equal(/\d/.test(h), false, h)
  assert.ok(h.includes('data-id="tokenPace.connectStatusLine"'), h)
})

test('a plan name from the settings says so on the quota card', () => {
  const configured = render('sQuota()', {
    quotas: [card({ planType: 'Max 20x', planSource: 'configured', planText: 'plan Max 20x (as configured)' })],
  })
  assert.ok(configured.includes('plan Max 20x (as configured)'), configured)
  // And a name the provider stated carries no such qualifier.
  const provided = render('sQuota()')
  assert.ok(provided.includes('plan max20'), provided)
  assert.equal(provided.includes('as configured'), false, provided)
})

// ---------------------------------------------------------------------------
// Records and the local five-hour estimate
// ---------------------------------------------------------------------------

function entry(over: Record<string, unknown> = {}): Record<string, unknown> {
  return { label: 'claude-opus-4-6', detail: 'Claude Code', usage: '412k', share: '61 %', cost: '~$1.20', ...over }
}

function recordsData(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    peakDay: { day: '2026-09-03', usage: '412k', cost: '~$1.20', costPartial: false },
    streak: { days: 3, from: '2026-09-01', to: '2026-09-03' },
    topModels: [entry()],
    topProjects: [entry({ label: 'token-pace', detail: '2 sessions', cost: '–' })],
    topSessions: [entry({ label: 'sess-alpha', detail: 'token-pace', cost: '–' })],
    attributionOn: true,
    note: null,
    sessionNote: null,
    ...over,
  }
}

test('the records section prints the peak day, the streak and the three tables', () => {
  const h = render('sRecords()', { records: recordsData() })
  // 1.10 B5 rule 2 (rewritten: the days stood bare): each ISO day in a .nobr span of its own.
  assert.ok(h.includes('Peak day <span class="nobr">2026-09-03</span> · 412k'), h)
  assert.ok(h.includes('Longest streak 3 days · <span class="nobr">2026-09-01</span> → <span class="nobr">2026-09-03</span>'), h)
  for (const label of ['claude-opus-4-6', 'token-pace', 'sess-alpha']) {
    assert.ok(h.includes(label), `${label} is missing from ${h}`)
  }
  // A record is a fact about the range, never a state to be warned about: no bar, no verdict,
  // no pace and no limit anywhere in it.
  assert.equal(h.includes('<div class="track"'), false, h)
  // ("token-pace" is a project name in the fixture, so the word "pace" is matched with its
  // sentence around it rather than on its own.)
  assert.equal(/verdict|no limit|on pace|forecast/i.test(h), false, h)
})

test('a missing record is a dash, and the record tables need attribution to exist', () => {
  const bare = render('sRecords()', {
    records: recordsData({ peakDay: null, streak: null, topProjects: [], topSessions: [], attributionOn: false }),
  })
  assert.ok(bare.includes('Peak day –'), bare)
  assert.ok(bare.includes('Longest streak –'), bare)
  assert.ok(bare.includes('tokenPace.attribution'), bare)
  // The models table comes from the buckets and stays.
  assert.ok(bare.includes('claude-opus-4-6'), bare)
})

test('the records section states the buckets it had to leave out', () => {
  const h = render('sRecords()', {
    records: recordsData({ note: '2 rolled-up month buckets in this range have no day left' }),
  })
  assert.ok(h.includes('2 rolled-up month buckets'), h)
})

function toolsData(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    rows: [
      { name: 'Read', calls: 3, callsText: '3', share: '43 %', models: 'claude-opus-4-6', sources: 'Claude Code' },
      { name: 'exec', calls: 1, callsText: '1', share: '14 %', models: 'gpt-5.4', sources: 'Codex' },
    ],
    total: 7, totalText: '7', distinct: 4, hidden: 2, since: '2026-09-02', truncated: false,
    notes: ['Tool calls counted since 2026-09-02.'],
    ...over,
  }
}

test('the tools section lists the calls, the share and the models, and no limit', () => {
  const h = render('sTools()', { tools: toolsData() })
  // 1.10 D10 (rewritten: data-hl beside data-h).
  assert.ok(h.includes('data-h="Tool" data-hl="Tool:">Read <span class="meta">Claude Code</span>'), h)
  assert.ok(h.includes('data-h="Calls" data-hl="Calls:">3<'), h)
  assert.ok(h.includes('data-h="Share" data-hl="Share:">43 %<'), h)
  assert.ok(h.includes('claude-opus-4-6'), h)
  assert.ok(h.includes('7 call(s) · 4 distinct tool(s) · 2 more not listed'), h)
  // 1.10 B5 rule 2 (rewritten: the day stood bare).
  assert.ok(h.includes('Tool calls counted since <span class="nobr">2026-09-02</span>.'), h)
  // A tool call has no limit, so nothing here may look like one.
  assert.equal(h.includes('<div class="track"'), false, h)
  assert.equal(/verdict|forecast|limit/i.test(h), false, h)
})

test('an empty tool table says it is empty and still states since when it counts', () => {
  const h = render('sTools()', {
    tools: toolsData({ rows: [], total: 0, totalText: '–', distinct: 0, hidden: 0, since: null,
      notes: ['No tool call has been counted yet — counting starts with the next transcript read.'] }),
  })
  assert.ok(h.includes('No tool call counted in this range.'), h)
  assert.ok(h.includes('No tool call has been counted yet'), h)
  assert.equal(h.includes('<table>'), false, h)
})

test('a truncated tool day is stated in the section, not silently dropped', () => {
  const h = render('sTools()', {
    tools: toolsData({ truncated: true, notes: ['More than 100 distinct tools were used on at least one day; the rarest names of that day are not counted.'] }),
  })
  assert.ok(h.includes('More than 100 distinct tools'), h)
})

test('a card without a window carries the local estimate, and no window ever does', () => {
  const text = 'Local estimate — 412k tokens in the last 5 h, first counted at 09:00. '
    + 'Not the provider’s window; no limit is known.'
  const h = render('sQuota()', {
    quotas: [card({
      windows: [], problem: 'no token', problemKind: 'noToken',
      problemAction: { label: 'Show log', command: 'tokenPace.showOutput' },
      localBlock: { source: 'claude', hours: 5, usage: '412k', cost: '~$1.20', requests: '30', firstAt: '09:00', complete: true, text },
    })],
  })
  assert.ok(h.includes(text), h)
  // The sentence and nothing around it: no bar, no percentage, no pace beside a local count.
  assert.equal(h.includes('<div class="track"'), false, h)
  assert.equal(h.includes('%'), false, h)

  // A card that has a window prints no local estimate — the view model never builds one there.
  assert.equal(render('sQuota()').includes('Local estimate'), false)
})

function budgetRow(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    key: 'total:month:usd', identity: 'budget:total:month:usd:2026-09-01',
    label: 'All providers · this month', scope: 'total', period: 'month', unit: 'usd',
    from: '2026-09-01', to: '2026-09-03', last: '2026-09-30',
    limit: 200, limitText: '$200.00', used: 84, usedText: '~$84.00',
    share: 42, shareText: '42 %', over: false, partial: false, covered: true,
    projected: 620, projectedText: '~$620.00', projectionBasis: 'so far ~$84.00 · Avg ~$28.00/day · 27 days left',
    projectedOver: true, unmeasurable: null,
    text: 'All providers · this month: ~$84.00 of $200.00 · 42 %', ...over,
  }
}

test('a budget is drawn against the reader’s own limit, with its period on the card', () => {
  const h = render('sBudget()', { budgets: [budgetRow()] })
  assert.ok(h.includes('All providers · this month'), h)
  assert.ok(h.includes('~$84.00 of $200.00'), h)
  assert.ok(h.includes('42 %'), h)
  assert.ok(h.includes('2026-09-01 → 2026-09-30'), h)
  assert.ok(h.includes('<div class="track"'), h)
  assert.ok(h.includes('projected ~$620.00 by 2026-09-30'), h)
  assert.ok(h.includes('so far ~$84.00'), h)
  // The limit is the reader's. Nothing here may borrow the vocabulary of a provider window.
  assert.equal(/verdict|on pace|resets|quota/i.test(h), false, h)
})

test('a budget with no local data for the period gets a dash and no bar', () => {
  const h = render('sBudget()', {
    budgets: [budgetRow({ share: null, shareText: '–', covered: false, projected: null, projectedText: null, projectionBasis: null })],
  })
  assert.ok(h.includes('–'), h)
  // A full-width bar would claim the period is spent, an empty one that it is untouched.
  assert.equal(h.includes('<div class="track"'), false, h)
  assert.equal(/\b0 %/.test(h), false, h)
})

test('a budget over its own limit is marked, and a lower bound says it is one', () => {
  const over = render('sBudget()', { budgets: [budgetRow({ share: 118, shareText: '118 %', over: true })] })
  assert.ok(over.includes('118 %'), over)
  assert.ok(over.includes('· over'), over)
  assert.ok(over.includes('fill warn'), over)
  const partial = render('sBudget()', { budgets: [budgetRow({ partial: true })] })
  assert.ok(partial.includes('All providers · this month ⚠'), partial)
})

test('no budget configured is an invitation, never a row with an invented limit', () => {
  const h = render('sBudget()', { budgets: [] })
  assert.ok(h.includes('No budget configured'), h)
  assert.ok(h.includes('tokenPace.budgets'), h)
  assert.equal(h.includes('<div class="track"'), false, h)
})

test('a budget nothing can measure keeps its card and names the setting in the way', () => {
  // "No budget configured" is a statement about the reader's settings file, and it may only
  // be made when that file configures none. A money budget with the cost column switched off
  // configures one — so the card stands, with dashes where the figures would be.
  const h = render('sBudget()', {
    budgets: [budgetRow({
      unmeasurable: 'not measured while tokenPace.showCost is off',
      used: 0, usedText: '–', share: null, shareText: '–', covered: false, over: false,
      projected: null, projectedText: null, projectionBasis: null, projectedOver: false,
      text: 'All providers · this month: – of $200.00 · not measured while tokenPace.showCost is off',
    })],
  })
  assert.equal(h.includes('No budget configured'), false, h)
  assert.ok(h.includes('All providers · this month'), h)
  assert.ok(h.includes('not measured while tokenPace.showCost is off'), h)
  assert.ok(h.includes('– of $200.00'), h)
  // No bar and no invented zero behind the dash.
  assert.equal(h.includes('<div class="track"'), false, h)
  assert.equal(/\b0 %/.test(h), false, h)
})

test('the budget section says what a dollar budget is not', () => {
  const h = render('sBudget()', { budgets: [budgetRow()] })
  assert.ok(h.includes('not a bill'), h)
})

// ---------------------------------------------------------------------------
// Hostile payloads
// ---------------------------------------------------------------------------

/** Every string of a payload poisoned with markup, quotes and a backtick; numbers untouched. */
function poisoned(v: unknown, mark: string): unknown {
  if (typeof v === 'string') return mark + v
  if (Array.isArray(v)) return v.map((x) => poisoned(x, mark))
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {}
    for (const k of Object.keys(v as Record<string, unknown>)) out[k] = poisoned((v as Record<string, unknown>)[k], mark)
    return out
  }
  return v
}

test('a payload full of markup renders as text: no section lets a string become an element', () => {
  const MARK = '<img src=x onerror=alert(1)>"\'&`'
  const base = { ...model({}), ...tokensVm() } as Record<string, unknown>
  const ALL = '[...RENDER.keys()].map(k => { try { return RENDER.get(k)() } catch (e) { return "THROW:" + k + ":" + e } }).join("\\n")'
  // Sections the plain fixture cannot render (it carries no data for them) are not the
  // subject here; every other section must render the poison, not choke on it.
  ;(ctx as Record<string, unknown>).fixture = base
  const clean = String(nodeVm.runInContext('vm = fixture; ' + ALL, ctx))
  const unrenderable = new Set((clean.match(/THROW:(\w+):/g) ?? []).map((m) => m.split(':')[1]))
  const hostile = poisoned(base, MARK) as Record<string, unknown>
  // The section list has to stay usable, or nothing would render at all.
  hostile.sections = base.sections
  ;(ctx as Record<string, unknown>).fixture = hostile
  const out = String(nodeVm.runInContext('vm = fixture; ' + ALL, ctx))
  const threw = (out.match(/THROW:(\w+):[^\n]*/g) ?? []).filter((m) => !unrenderable.has(m.split(':')[1]))
  assert.deepEqual(threw, [], threw.join('; '))
  assert.equal(out.indexOf('<img'), -1, 'a poisoned string became an element')
  // The escaped text still reads "onerror=" — what must not exist is the attribute form.
  assert.equal(/\s+onerror=/.test(out.replace(/&lt;img src=x onerror=alert\(1\)&gt;/g, '')), false, 'a poisoned string became an attribute')
  assert.ok(out.indexOf('&lt;img src=x onerror=alert(1)&gt;&quot;&#39;&amp;`') >= 0, 'the poison is not on the page as text')
  // And nothing but the nonced module runs: the page carries no second script.
  assert.equal(/<script/i.test(out), false)
})

test('a poisoned section key or part key is dropped, never looked up on the prototype', () => {
  const h = render('sTokens()', { ...tokensVm(), sections: ['constructor', '__proto__', 'tokens'] })
  assert.ok(h.length > 0)
  const all = String(nodeVm.runInContext(
    'vm = Object.assign({}, fixture, { sections: ["constructor", "__proto__", "quota"] }); renderer("constructor") === null && renderer("__proto__") === null && typeof renderer("quota") === "function"',
    ctx,
  ))
  assert.equal(all, 'true')
})

// ---------------------------------------------------------------------------
// The agent tree
// ---------------------------------------------------------------------------

/** 2026-09-22 12:00 UTC — the clock every agent-tree test reads. */
const AG_NOW = Date.UTC(2026, 8, 22, 12, 0, 0)

/** Node keys shaped the way the tree builder makes them. */
const AK = {
  s1: 's:/p/-home-u-repo/9d0eb37a.jsonl',
  wf: 'w:/p/-home-u-repo/9d0eb37a.jsonl|wf_cfe7718d',
  a1: 'a:/p/-home-u-repo/9d0eb37a/subagents/workflows/wf_cfe7718d/agent-a94f.jsonl',
  a2: 'a:/p/-home-u-repo/9d0eb37a/subagents/workflows/wf_cfe7718d/agent-b1c2.jsonl',
  a3: 'a:/p/-home-u-repo/9d0eb37a/subagents/agent-c3d4.jsonl',
  l1: 'l:toolu_01ABCDEF',
  s2: 's:/p/-home-u-repo/1234abcd.jsonl',
  // 1.6 D4: the run's collector.
  n1: 'n:9d0eb37a|wf_cfe7718d',
}

/**
 * One TreeNode of src/agentTree.ts, its figures already formatted as the view model does. Whether
 * it has children and how many follow the children given (1.6 D3), unless `over` says otherwise —
 * a closed node's payload carries none of them.
 */
function treeNode(key: string, state: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  const kids = Array.isArray(over.children) ? over.children.length : 0
  return {
    // 1.6 N6: the row's name has the model short, `fullLabel` the whole id; N9: the clock times.
    key, kind: 'agent', label: 'Explore · opus-5 · a94f',
    fullLabel: over.fullLabel ?? (typeof over.label === 'string' ? over.label : 'Explore · claude-opus-5 · a94f'),
    startClock: '11:59', lastClock: '11:59', sub: null, state,
    derived: state !== 'done' && state !== 'failed', usage: '12.3K', lowerBound: false,
    duration: '40.0 s', startTs: AG_NOW - 42_000, lastTs: AG_NOW - 5_000, agentCount: 0,
    hasChildren: kids > 0, childrenTotal: kids, childrenMore: 0,
    tally: null, tallyText: null, tallySpoken: null, children: [], ...over,
  }
}

/**
 * A node's tally (1.6 N1) as the tree builder writes it: the counts, the row's text with the
 * glyphs, and the same in words — started first, then each state with at least one agent.
 */
function tallyOf(n: { done?: number; failed?: number; retried?: number; stopped?: number; running?: number; unknown?: number }): Record<string, unknown> {
  const c = { done: 0, failed: 0, retried: 0, stopped: 0, running: 0, unknown: 0, ...n }
  const started = c.done + c.failed + c.retried + c.stopped + c.running + c.unknown
  const glyphs: Array<[number, string, string]> = [
    [c.done, `${c.done} ✓`, `${c.done} done`], [c.failed, `${c.failed} ✕`, `${c.failed} failed`],
    [c.retried, `${c.retried} ↻`, `${c.retried} retried`], [c.stopped, `${c.stopped} ■`, `${c.stopped} stopped`],
    [c.running, `~${c.running} ●`, `about ${c.running} running`], [c.unknown, `~${c.unknown} ?`, `about ${c.unknown} unknown`],
  ]
  const on = glyphs.filter(([k]) => k > 0)
  // 1.7 F4: the parts as the builder sends them beside the text, each with the state it counts.
  const tones = ['done', 'failed', 'retried', 'stopped', 'running', 'unknown']
  return {
    agentCount: started,
    tally: { started, ...c },
    tallyText: [`${started} started`, ...on.map((g) => g[1])].join(' · '),
    tallySpoken: [`${started} started`, ...on.map((g) => g[2])].join(', '),
    tallyParts: [{ label: `${started} started`, tone: 'started' },
      ...glyphs.map((g, i) => ({ label: g[1], tone: tones[i], n: g[0] })).filter((g) => g.n > 0).map(({ label, tone }) => ({ label, tone }))],
  }
}

/** The session's, the run's and the failed agent's tallies of agentTree() below. */
const T_S1 = tallyOf({ done: 1, failed: 1, running: 1, unknown: 1 })
const T_WF = tallyOf({ done: 1, running: 1 })
const T_A3 = tallyOf({ unknown: 1 })

// 1.6 N6: a row is two lines — its name, then its figures under it.
/**
 * 1.6 P10a (L3): the disclosure of the 7-day block at the end of the running block's first line,
 * closed — the heading's, or the line's that says nothing runs. Pinned into every test that pins
 * that line (they pinned it without one: the line carries it now).
 */
const WEEK_TOGGLE = '<button class="ag-wkbtn" data-act="agentsWeek" aria-expanded="false">Last 7 days</button>'
/** The separator between two parts of a name: a part of its own, which never gives way. */
const DOT = '<span class="ag-dot"> · </span>'
/**
 * An agent's first line as the page writes it (1.6 P7b), titled with the whole name: its type,
 * which never gives way, its model, which gives way first — its dot with it —, and its short id
 * in the dim tone, which never gives way either. A launch has its last word in the id's place,
 * whole, and not dimmed.
 */
function albl(title: string, type: string, model: string, id: string, launch = false): string {
  return '<span class="ag-label" title="' + title + '"><span class="ag-np ag-type">' + type + '</span>'
    + '<span class="ag-np ag-model"> · ' + model + '</span>' + DOT
    + (launch ? '<span class="ag-np ag-end">' + id + '</span>' : '<span class="ag-sid">' + id + '</span>') + '</span>'
}
/**
 * A session's or a run's first line (1.6 P7b): its prefix word and the time it is named by — the
 * space in front of the time with it —, which stay whole, then its short id in the dim tone,
 * which gives way (`ag-give`) after a session's project and before the prefix word.
 */
function slbl(title: string, pre: string, when: string, id: string, proj = ''): string {
  return '<span class="ag-label" title="' + title + '"><span class="ag-np ag-pre">' + pre + '</span>'
    + '<span class="ag-np ag-when"> ' + when + '</span>' + DOT + '<span class="ag-sid ag-give">' + id + '</span>'
    + (proj ? '<span class="ag-proj"> · ' + proj + '</span>' : '') + '</span>'
}
/** A name of one part — a collector's words — on an ellipsis where it has no room. */
function olbl(title: string, name: string): string {
  return '<span class="ag-label" title="' + title + '"><span class="ag-np">' + name + '</span></span>'
}
/** The separator in front of every part of a figures' line but the first, hidden from a screen reader. */
const SEP = '<span aria-hidden="true"> · </span>'
/** One figure of a row, unbreakable. */
const fig = (v: string): string => '<span class="nobr">' + v + '</span>'
/**
 * 1.7 D-A: the page's mark of a lower bound behind a figure, as the page writes it — the ⚠ hidden
 * from a screen reader, titled with why for the mouse, then the words, text of the line at no size
 * (`.ag-lbw`), which a screen reader reads where they stand.
 */
const lbMark = (title: string, words = 'lower bound'): string =>
  ' <span class="ag-lb" aria-hidden="true" title="' + title + '">⚠</span><span class="ag-lbw">' + words + '</span>'
/**
 * A row's second line: its parts, each an `ag-fp` with the separator in front of it but the first,
 * and anything the page writes between them (a silence) where `between` puts it.
 */
function figs(...parts: string[]): string {
  return '<span class="ag-fig">' + parts.map((p, i) => '<span class="ag-fp">' + (i ? SEP : '') + p + '</span>').join('') + '</span>'
}
/** A tree row's live clock in the duration's place (N6), and the words that stand still for a screen reader (N9). */
function clockFig(ts: number, text: string, since: string | null): string {
  const eye = '<span class="nobr"><span data-live="since" data-ts="' + ts + '">' + text + '</span></span>'
  return since === null ? eye : '<span aria-hidden="true">' + eye + '</span><span class="sr">since ' + since + '</span>'
}
/** The same in the running list, which says what it counts: "running for 42 s". */
function runFig(ts: number, text: string, since: string | null): string {
  const eye = '<span class="nobr">running for <span data-live="since" data-ts="' + ts + '">' + text + '</span></span>'
  return since === null ? eye : '<span aria-hidden="true">' + eye + '</span><span class="sr">since ' + since + '</span>'
}
/**
 * A tally's parts on the figures' line: the glyphs for the eye, hidden from a screen reader. 1.6 L1
 * (pinned and changed: P2c wrote the words once after the last part): the words end the name of
 * the row's tree item instead, which a screen reader announces on it — in the line as well, they
 * would be read twice, once in the name and once in the figures its item describes itself by.
 */
function tallyFigs(t: Record<string, unknown>): string[] {
  // 1.7 F4: each part wears the state it counts (`ag-tt-<tone>`), where the node sends its parts;
  // a node that sends none (a payload of another build) has its text split, in the figures' tone.
  if (Array.isArray(t.tallyParts)) {
    return (t.tallyParts as Array<{ label: string; tone: string }>)
      .map((p) => '<span class="ag-t ag-tt-' + p.tone + '" aria-hidden="true">' + p.label + '</span>')
  }
  return String(t.tallyText).split(' · ').map((p) => '<span class="ag-t" aria-hidden="true">' + p + '</span>')
}
/** The end of a figures' line that ends on a tally, after other parts: the tally's parts and the line's end. */
const tallyEnd = (t: Record<string, unknown>): string => tallyFigs(t).map((p) => '<span class="ag-fp">' + SEP + p + '</span>').join('') + '</span>'
/**
 * 1.6 P7b: the end of a session's or a run's figures' line: the tally's parts, then its span or
 * duration — the part the fit takes off first — and the line's end.
 */
const tallyThen = (t: Record<string, unknown>, last: string): string => tallyFigs(t).concat([last])
  .map((p) => '<span class="ag-fp">' + SEP + p + '</span>').join('') + '</span>'
/** The busy session's span and the running run's clock of agentTree() below: the last parts of their lines. */
const S1_SPAN = fig('<span title="span from the first to the last line">1 h 05 min</span>')
const WF_CLOCK = clockFig(AG_NOW - 42_000, '42 s', '11:40')

/** One RunningItem of src/agentTree.ts: the running agent of the tree below, where it sits. */
function runningItem(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    key: AK.a1, kind: 'agent', label: 'Explore · opus-5 · a94f',
    fullLabel: over.fullLabel ?? (typeof over.label === 'string' ? over.label : 'Explore · claude-opus-5 · a94f'),
    startClock: '11:59', lastClock: '11:59', context: 'Session 9d0eb37a · Workflow run cfe7718d · repo',
    usage: '12.3K', lowerBound: false, startTs: AG_NOW - 42_000, lastTs: AG_NOW - 5_000, waiting: false, running: 1, ...over,
  }
}

/**
 * An AgentTreeVm with every state a node can be in, seven nodes: an active session holding a
 * running workflow run (one agent running, one done) and a failed agent whose own launch has
 * no transcript yet, and an idle session. Every parent counts the agents below it and carries
 * their tally, the idle session with none has neither, and the running agent is the one item
 * of the running list, as the builder would make them.
 */
function agentTree(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    roots: [
      // 1.6 P7b: a session's and a run's clock time is the one its name ends on — the page finds the
      // time it is named by from it.
      treeNode(AK.s1, 'active', {
        kind: 'session', label: 'Session Tue 10:55 · 9d0eb37a', sub: 'repo', usage: '1.2M', usageAgents: '434.6K', duration: '1 h 05 min',
        startClock: '10:55', ...T_S1,
        children: [
          treeNode(AK.wf, 'running', {
            kind: 'workflow', label: 'Workflow run Tue 11:40 · cfe7718d', usage: '410K', startClock: '11:40', ...T_WF,
            children: [
              treeNode(AK.a1, 'running'),
              treeNode(AK.a2, 'done', { label: 'Plan · opus-5 · b1c2', lowerBound: true }),
            ],
          }),
          treeNode(AK.a3, 'failed', {
            label: 'general-purpose · sonnet-5 · c3d4', ...T_A3,
            children: [
              treeNode(AK.l1, 'unknown', {
                kind: 'pending', label: 'Explore · – · launched', usage: '–', duration: '–',
                startTs: AG_NOW - 900_000, lastTs: null,
              }),
            ],
          }),
        ],
      }),
      treeNode(AK.s2, 'idle', { kind: 'session', label: 'Session Mon 09:00 · 1234abcd', usage: '–', duration: '–', startClock: '2026-09-21 09:00' }),
    ],
    selected: null, running: 1, runningNow: [runningItem()], runningMore: 0,
    omittedRoots: 0, note: null,
    ...over,
  }
}

/** Every node of agentTree() that has children: the view state of a reader who opened them all. */
const OPEN = [AK.s1, AK.wf, AK.a3]

function agentUi(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    providers: ['claude', 'codex'], models: [], metric: 'usage', collapsed: [],
    agentsExpanded: [], agentSelected: null, ...over,
  }
}

/** The view state with every node of the tree opened — what the 1.5.0 tests saw by default. */
function openUi(over: Record<string, unknown> = {}): Record<string, unknown> {
  return agentUi({ agentsExpanded: OPEN, ...over })
}

/**
 * 1.6 L1: a tree item's start tag as the page writes it — its node's key, its `tabindex` (0 on the
 * tree's one stop of the Tab key, −1 on every other), its level, its place among its siblings and
 * how many they are, whether it is open (a node with children only) and selected, its name in
 * words, and its figures' line, by id, as its description.
 */
function itemTag(key: string, o: { kind?: string; sup?: boolean; tab?: boolean; level?: number; size: number; pos: number;
  expanded?: boolean; selected?: boolean; label: string }): string {
  return '<li role="treeitem" class="ag-k-' + (o.kind ?? 'agent') + (o.sup === true ? ' ag-sup' : '') + '" data-key="' + key
    + '" tabindex="' + (o.tab === true ? '0' : '-1') + '" aria-level="' + (o.level ?? 1) + '" aria-setsize="' + o.size
    + '" aria-posinset="' + o.pos + '"' + (o.expanded === undefined ? '' : ' aria-expanded="' + o.expanded + '"')
    + ' aria-selected="' + (o.selected === true) + '" aria-label="' + o.label + '" aria-describedby="agf-' + key + '">'
}
/** 1.6 L1: a node's toggle — the mouse's target, hidden from a screen reader, which hears the item open or closed. */
const foldOf = (key: string): string => '<span class="ag-fold" data-act="agentToggle" data-key="' + key + '" aria-hidden="true"></span>'
/**
 * 1.6 L1: a tree row — the mouse's target that selects — and whether the details stand under it.
 * 1.7 F4: the state whose colour its name wears (`ag-c-<state>`), for an agent's, a launch's, a
 * run's and a collector's row in state done, unknown, failed or running that nothing superseded.
 */
const rowOf = (key: string, pressed = false, colour = ''): string =>
  '<span class="ag-row' + (colour ? ' ag-c-' + colour : '') + '" data-act="agentSelect" data-key="' + key + '" data-pressed="' + pressed + '">'
/** A tree row's second line (1.6 N6), carrying the id its item's description names (1.6 L1). */
function figsOf(key: string, ...parts: string[]): string {
  return figs(...parts).replace('<span class="ag-fig">', '<span class="ag-fig" id="agf-' + key + '">')
}

/** The tree part of a rendered section: from the tree's own frame on, the running list left out. */
function treePart(h: string): string {
  const at = h.indexOf('<div class="agtree"')
  assert.ok(at >= 0, 'no tree in ' + h)
  return h.slice(at)
}

/**
 * The details panel of a rendered section, from its opening tag to its own end — its one list
 * closes it — wherever it stands (1.6 N2: inside the entry of the row it belongs to).
 */
function panelOf(h: string): string {
  const at = h.indexOf('<div class="ag-details"')
  assert.ok(at >= 0, 'no details panel in ' + h)
  const end = h.indexOf('</dl></div>', at)
  assert.ok(end > at, 'an unterminated panel in ' + h)
  return h.slice(at, end + '</dl></div>'.length)
}

/**
 * The NodeDetails the view model builds for AK.a1, with a row of every kind of absence; its
 * `derived` and `lastTs` are the node's own, as the builder gives them.
 */
function detailsOf(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    key: AK.a1, title: 'Explore · claude-opus-5 · a94f', state: 'running', derived: true, lastTs: AG_NOW - 5_000,
    stateText: 'Running — inferred: the transcript changed 5 s ago and no result was recorded yet.',
    rows: [
      { label: 'Type', value: 'Explore' },
      { label: 'Model', value: 'claude-opus-5' },
      { label: 'ID', value: 'a94f3c2e10b7d5e19', copy: true },
      { label: 'Depth', value: '' },
      { label: 'Last activity', value: '11:59:55', note: '5 s ago', live: 'ago' },
      { label: 'Output', value: '1.2K', note: '⚠ lower bound' },
      { label: 'Spawned by', value: '–' },
      { label: 'Workflow run', value: null },
      { label: 'Report from Claude Code', value: 'context at the end 12K (incl. cache reads and the reply) · 40.0 s from the start · 3 tool calls',
        note: "Claude Code's own figure for this agent, never added to a total", kind: 'sentence' },
    ],
    ...over,
  }
}

interface AgentCtx {
  c: nodeVm.Context
  posted: unknown[]
  root: { innerHTML: string }
  intervals: Array<{ fn: () => void; ms: number }>
  clock: { t: number }
  fire: (type: string, ev: Record<string, unknown>) => void
  /** 1.8 L-6: every listener the script registered, by scope and type (`document:toggle:capture`). */
  listeners: Record<string, Array<(ev: unknown) => void>>
}

/**
 * A context with everything the Agents section touches: a root that keeps what renderAll
 * writes, the listeners the script registers (keyed `document:click`, `window:message`, …),
 * the messages it posts, the intervals it starts and a clock the test moves. A query for the
 * live spans answers with `spans`.
 */
function agentCtx(spans: Array<Record<string, unknown>> = [], script = SCRIPT, silent: Array<Record<string, unknown>> = []): AgentCtx {
  const posted: unknown[] = []
  const listeners: Record<string, Array<(ev: unknown) => void>> = {}
  const intervals: Array<{ fn: () => void; ms: number }> = []
  const root = { innerHTML: '', dataset: {}, style: {} }
  const clock = { t: AG_NOW }
  // A listener for the capture phase is kept apart and runs first, as a browser runs it for an
  // event on a node inside the document.
  const on = (scope: string) => (type: string, fn: (ev: unknown) => void, capture?: unknown): void => {
    (listeners[scope + type + (capture === true ? ':capture' : '')] ??= []).push(fn)
  }
  const c = nodeVm.createContext({
    // Copied out of the script's realm, so a posted message compares like any other value.
    acquireVsCodeApi: () => ({ postMessage: (m: unknown) => { posted.push(JSON.parse(JSON.stringify(m))) } }),
    document: {
      addEventListener: on('document:'),
      getElementById: () => root,
      querySelector: () => null,
      querySelectorAll: (sel: string) => (sel === '[data-live="since"]' ? spans : sel === '[data-live="silent"]' ? silent : []),
    },
    window: {
      addEventListener: on('window:'),
      setInterval: (fn: () => void, ms: number) => { intervals.push({ fn, ms }); return intervals.length },
    },
    console,
    clock,
  })
  nodeVm.runInContext(script, c)
  nodeVm.runInContext('Date.now = function () { return clock.t; };', c)
  const fire = (type: string, ev: Record<string, unknown>): void => {
    for (const fn of [...(listeners[type + ':capture'] ?? []), ...(listeners[type] ?? [])]) fn(ev)
  }
  return { c, posted, root, intervals, clock, fire, listeners }
}

/** The section as sAgents writes it, from the tree above plus `over`. */
function agentsHtml(a: AgentCtx, over: Record<string, unknown> = {}): string {
  ;(a.c as Record<string, unknown>).fixture = model({
    sections: ['quota', 'agents'], agents: agentTree(), ui: agentUi(), ...over,
  })
  return String(nodeVm.runInContext('vm = fixture; sAgents()', a.c))
}

/** A start tag exactly as the renderers write one: lower-case names, double-quoted values. */
const TAG_RE = /<([a-z][a-z0-9]*)((?:\s[a-z][a-z0-9-]*(?:="[^"]*")?)*)>/g

function tagsOf(html: string): Array<{ name: string; attrs: string[] }> {
  return [...html.matchAll(TAG_RE)].map((m) => ({
    name: m[1],
    attrs: [...m[2].matchAll(/\s([a-z][a-z0-9-]*)(?:="[^"]*")?/g)].map((x) => x[1]),
  }))
}

/** What a browser hands back for an attribute value this page escaped. */
function unescapeHtml(s: string): string {
  return s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
}

test('the agent tree draws every state with a glyph of its own and marks each inferred one', () => {
  const a = agentCtx()
  // Every node opened, so every state is on screen; the running list above it is its own test.
  const h = treePart(agentsHtml(a, { ui: openUi() }))
  assert.ok(h.startsWith('<div class="agtree" role="tree" aria-label="Agents"><ul role="none">'
    + '<li role="treeitem" class="ag-k-session"'), h)
  const glyphs = [...h.matchAll(/<span class="ag-st ag-([a-z]+)" role="img" aria-label="([^"]*)" title="([^"]*)"><\/span>/g)]
  // One glyph per node, all six states among them.
  assert.deepEqual(glyphs.map((m) => m[1]), ['active', 'running', 'running', 'done', 'failed', 'unknown', 'idle'])
  for (const m of glyphs) {
    // The tilde on everything the tree builder inferred, none on what the parent recorded.
    assert.equal(m[3].startsWith('~'), m[1] !== 'done' && m[1] !== 'failed', m[0])
    // 1.6 N9 (pinned and changed: 1.5 read the title out): a screen reader hears the state in
    // words — "running, derived" — without the tilde, which it would read as a sign.
    assert.equal(m[2], m[3].replace(/^~/, '').replace(/ · (derived|recorded)$/, ', $1'), m[0])
    assert.equal(m[2].includes('~'), false, m[0])
  }
  assert.deepEqual([...new Set(glyphs.map((m) => m[3]))], [
    '~active session · derived', '~running · derived', 'done · recorded', 'failed · recorded',
    '~unknown · derived', '~idle session · derived',
  ])
  // The node's flag decides, not its state: a done the builder only inferred says so, and a
  // node that does not say which it is is never called recorded.
  assert.ok(agentsHtml(a, { agents: agentTree({ roots: [treeNode(AK.a2, 'done', { derived: true })] }) })
    .indexOf('title="~done · derived"') >= 0)
  assert.ok(agentsHtml(a, { agents: agentTree({ roots: [treeNode(AK.a3, 'failed', { derived: undefined })] }) })
    .indexOf('title="~failed · derived"') >= 0)
  // A state or kind this build does not know is drawn as unknown and never becomes a class.
  const odd = agentsHtml(a, { agents: agentTree({ roots: [treeNode(AK.a1, 'exploded', { kind: 'rocket' })] }) })
  assert.ok(odd.indexOf('<li role="treeitem" class="ag-k-agent"') >= 0, odd)
  assert.ok(odd.indexOf('<span class="ag-st ag-unknown"') >= 0, odd)
  assert.equal(/exploded|rocket/.test(odd), false, odd)
  // Each glyph is the stylesheet's, drawn from the class in a colour of the page.
  for (const s of ['running', 'done', 'failed', 'stopped', 'unknown', 'active', 'idle']) {
    assert.match(STYLE, new RegExp('\\.ag-' + s + '::before \\{ content: "[^"]+"; color: var\\(--[a-zA-Z-]+\\); \\}'), s)
  }
  // 1.6 D7: a stop the parent recorded is a state of its own — ■ in the dim tone, recorded, no
  // tilde — and never drawn as a failure.
  assert.match(STYLE, /\.ag-stopped::before \{ content: "■"; color: var\(--dim\); \}/)
  const stopped = agentsHtml(a, { agents: agentTree({ roots: [treeNode(AK.a3, 'stopped', { derived: false })] }) })
  assert.ok(stopped.indexOf('<span class="ag-st ag-stopped" role="img" aria-label="stopped, recorded" title="stopped · recorded">') >= 0,
    stopped)
  assert.equal(/ag-failed|~stopped/.test(stopped), false, stopped)
})

test('an attempt the workflow journal superseded keeps its glyph and state, dimmed, and says why — in either language', () => {
  // 1.6 D7 (P2b): a failure retried, a run replaced, a step re-run — its own state stays, the row
  // is dimmed, and the glyph's title and label say what the dimming means.
  const a = agentCtx()
  const tree = agentTree({
    roots: [treeNode(AK.s1, 'active', {
      kind: 'session', label: 'Session Tue 10:55 · 9d0eb37a', agentCount: 2,
      children: [
        treeNode(AK.a2, 'failed', { derived: false, superseded: true, label: 'workflow-subagent · opus-5 · b1c2' }),
        treeNode(AK.a1, 'running', { superseded: false }),
      ],
    })],
  })
  const h = treePart(agentsHtml(a, { agents: tree, ui: agentUi({ agentsExpanded: [AK.s1] }) }))
  const title = 'failed · recorded · superseded by a later attempt'
  // 1.6 L1: the item says it too, in words, as the start of its name after its own.
  assert.ok(h.indexOf(itemTag(AK.a2, { sup: true, level: 2, size: 2, pos: 1,
    label: 'workflow-subagent · opus-5 · b1c2, failed, recorded, superseded by a later attempt' })) >= 0, h)
  assert.ok(h.indexOf('<span class="ag-st ag-failed" role="img" aria-label="failed, recorded, superseded by a later attempt" title="'
    + title + '">') >= 0, h)
  // Only the superseded one: the running agent beside it is drawn as ever.
  assert.equal(h.split('ag-sup').length - 1, 1, h)
  assert.ok(h.indexOf('aria-label="running, derived" title="~running · derived"') >= 0, h)
  // The dimming is the stylesheet's, no new colour: 1.6 P7 (pinned and changed, the lead's call on
  // the pictures) fades the name to .65 — at .8, and the name in the dim tone, the row was hardly
  // dimmed on the dark theme; the short id and the figures are dim already and stay so. 1.6 P7b
  // (pinned and changed, the lead's call: P7 faded the glyph too): only the name — every part of
  // it, the type and the model —; the glyph is the mark of the state and keeps its full strength.
  assert.match(STYLE, /\n\.ag-sup > \.ag-line > \.ag-row \.ag-np \{ opacity: \.65; \}/)
  assert.equal(/\.ag-sup[^{]*\.ag-st/.test(STYLE), false, 'the glyph of a superseded row is faded')
  assert.equal(/\.ag-sup[^{]*\{[^}]*color:/.test(STYLE), false, 'a superseded row has a colour of its own')
  assert.ok(h.indexOf(albl('workflow-subagent · opus-5 · b1c2', 'workflow-subagent', 'opus-5', 'b1c2')) >= 0, h)
  // A payload that does not say `true` is not dimmed.
  const plain = treePart(agentsHtml(a, { agents: agentTree({ roots: [treeNode(AK.a2, 'failed', { superseded: 'yes' })] }) }))
  assert.equal(plain.indexOf('ag-sup'), -1, plain)
  assert.equal(plain.indexOf('superseded'), -1, plain)
  // The word is the page's, and German on a German page.
  assert.ok(Object.prototype.hasOwnProperty.call(DICT, 'superseded by a later attempt'))
  const bundle = JSON.parse(readFileSync(join(__dirname, '..', 'l10n', 'bundle.l10n.de.json'), 'utf8')) as Record<string, string>
  assert.equal(bundle['superseded by a later attempt'], 'durch einen späteren Versuch ersetzt')
})

// 1.6 N6 (pinned and changed): a row is two lines — the name, then the figures under it, in the
// dim tone — where 1.5 put the figures beside the name and let them wrap. The live clock takes the
// duration's place; a launch shows dashes on its second line rather than no line at all. 1.6 D10
// (the lead's call, §7a Q5): the rows carry their ⚠ now, the page ships with ROW_LOWER_BOUND_MARK on.
test('a row is two lines: its name, then the usage and duration it was given — while it runs, a live clock in the duration\'s place', () => {
  const a = agentCtx()
  // Every node opened; the running list's own row of the running agent is left out of the counts.
  const h = treePart(agentsHtml(a, { ui: openUi() }))
  // The glyph in a column of its own, the two lines beside it in theirs: the name — the short id
  // dimmed, the whole name its title — and under it the figures, each part whole.
  // 1.6 L1 (pinned and changed: P7 wrote the row as a button): the row is the mouse's target inside
  // its tree item, which is what takes the focus; its figures' line is that item's description.
  // 1.7 F4 (pinned and changed): the running agent's name wears the running colour.
  assert.ok(h.indexOf(rowOf(AK.a1, false, 'running')
    + '<span class="ag-st ag-running" role="img" aria-label="running, derived" title="~running · derived"></span>'
    + '<span class="ag-text">' + albl('Explore · claude-opus-5 · a94f', 'Explore', 'opus-5', 'a94f')
    + figsOf(AK.a1, fig('12.3K'), clockFig(AG_NOW - 42_000, '42 s', '11:59')) + '</span></span>') >= 0, h)
  assert.match(STYLE, /\.ag-row \{[^}]*display: flex; align-items: baseline;/)
  assert.equal(/\.ag-row \{[^}]*flex-wrap/.test(STYLE), false, 'the glyph would wrap away from its name')
  assert.match(STYLE, /\.ag-text \{[^}]*display: flex; flex-direction: column; \}/)
  // Neither line wraps: a row is two lines at any width.
  assert.match(STYLE, /\.ag-label \{ position: relative; display: flex; min-width: 0; overflow: hidden; \}/)
  assert.match(STYLE, /\.ag-fig \{[^}]*overflow: hidden; white-space: nowrap; text-overflow: ellipsis;[^}]*color: var\(--dim\);/)
  // The workflow run and its running agent tick; done, failed, unknown and the sessions do not.
  assert.equal(h.split('data-live="since"').length - 1, 2, h)
  // 1.6 P7b (pinned and changed: P7 put the tally last): a run's tally before its clock or
  // duration, which the fit takes off first.
  assert.ok(h.indexOf(slbl('Workflow run Tue 11:40 · cfe7718d', 'Workflow run', 'Tue 11:40', 'cfe7718d')
    + figsOf(AK.wf, fig('410K'), ...tallyFigs(T_WF), clockFig(AG_NOW - 42_000, '42 s', '11:40'))) >= 0, h)
  // A lower bound without its reason is not marked — a mark nobody can ask about says less than
  // none; with its reason it is (see the ⚠ test below), and no line under the tree speaks of it.
  assert.ok(h.indexOf(albl('Plan · opus-5 · b1c2', 'Plan', 'opus-5', 'b1c2') + figsOf(AK.a2, fig('12.3K'), fig('40.0 s'))) >= 0, h)
  assert.equal(h.indexOf('⚠'), -1, h)
  assert.ok(h.endsWith('</ul></div>'), h.slice(-120))
  const rootMark = agentTree({ roots: [treeNode(AK.s2, 'idle', { kind: 'session', label: 'Session Mon 09:00 · 1234abcd', lowerBound: true,
    lowerBoundText: '⚠ lower bound — 1 of 9 replies unfinished', usage: '12K' })] })
  // 1.7 D-A (pinned and changed: 1.6 D10 wrote the ⚠ as an image named "lower bound"): the ⚠ hidden
  // from a screen reader, the words in the line after it.
  assert.ok(agentsHtml(a, { agents: rootMark }).indexOf(fig('own 12K' + lbMark('⚠ lower bound — 1 of 9 replies unfinished'))) >= 0)
  // Absence is a dash, never a zero: the quiet session, and a launch nobody has counted yet —
  // here it is not running, so not even a clock, and its second line is dashes.
  assert.ok(h.indexOf(albl('Explore · – · launched', 'Explore', '–', 'launched', true) + figsOf(AK.l1, fig('–'), fig('–')) + '</span></span>') >= 0, h)
  // A session's figures name what they are (D5), the name first — a figure in front of
  // "agents" would read as a number of agents, beside a tally that counts them: its own
  // transcript's usage, its agents' — never added to it, and not shown for a session without
  // agents — and its span, whose title says so.
  const span = (v: string): string => '<span title="span from the first to the last line">' + v + '</span>'
  assert.ok(h.indexOf(slbl('Session Mon 09:00 · 1234abcd', 'Session', 'Mon 09:00', '1234abcd') + figsOf(AK.s2, fig('own –'), fig(span('–')))) >= 0, h)
  // The project a session belongs to, when attribution names one, after its id on the name's
  // line, then — on the second — its figures and the tally of its agents (1.6 N1), which an opened
  // session keeps, before its span (1.6 P7b).
  assert.ok(h.indexOf(slbl('Session Tue 10:55 · 9d0eb37a · repo', 'Session', 'Tue 10:55', '9d0eb37a', 'repo')
    + figsOf(AK.s1, fig('own 1.2M'), fig('agents 434.6K'), ...tallyFigs(T_S1), fig(span('1 h 05 min')))) >= 0, h)
  // The sum of the two is no figure of the page.
  assert.equal(h.indexOf('1.6M'), -1, h)
  // A launch whose transcript has not been seen yet reads as the hint it is.
  assert.ok(h.indexOf(itemTag(AK.l1, { kind: 'pending', level: 3, size: 1, pos: 1, label: 'Explore · – · launched, unknown, derived' })) >= 0, h)
  assert.match(STYLE, /\.ag-k-pending > \.ag-line \.ag-label \{ font-style: italic; \}/)
  // A running node without a start gets no clock rather than one counting from 1970 — in the
  // tree, and in the running list — and keeps its duration.
  const nostart = agentsHtml(a, {
    agents: agentTree({ roots: [treeNode(AK.a1, 'running', { startTs: null })], runningNow: [runningItem({ startTs: null })] }),
  })
  assert.equal(nostart.indexOf('data-live'), -1, nostart)
  assert.ok(nostart.indexOf(figsOf(AK.a1, fig('12.3K'), fig('40.0 s'))) >= 0, nostart)
  // Without the view model's clock time the clock stays readable: no words to stand in for it.
  const noclock = treePart(agentsHtml(a, { agents: agentTree({ roots: [treeNode(AK.a1, 'running', { startClock: null })] }) }))
  assert.ok(noclock.indexOf(figsOf(AK.a1, fig('12.3K'), clockFig(AG_NOW - 42_000, '42 s', null))) >= 0, noclock)
  // A node with nothing in it is dashes, on both lines.
  const bare = agentsHtml(a, { agents: agentTree({ roots: [{ key: AK.a1 }] }) })
  assert.ok(bare.indexOf('<span class="ag-label"><span class="ag-np">–</span></span>' + figsOf(AK.a1, fig('–'), fig('–'))) >= 0, bare)
  assert.equal(/undefined|NaN|null|\[object Object\]/.test(h + nostart + bare), false)
})

test('by default the tree is closed: only the sessions, each parent collapsed and saying what its agents came to', () => {
  const a = agentCtx()
  const h = treePart(agentsHtml(a))
  // The two sessions and nothing under them: no run, no agent, no launch is written.
  assert.deepEqual([...h.matchAll(/data-act="agentSelect" data-key="([^"]*)"/g)].map((m) => m[1]), [AK.s1, AK.s2])
  for (const k of [AK.wf, AK.a1, AK.a2, AK.a3, AK.l1]) assert.equal(h.indexOf('data-key="' + k + '"'), -1, k)
  assert.equal(h.indexOf('<ul role="group">'), -1, h)
  // The session with children is collapsed — its item says so, and its toggle is the mouse's —, and
  // the second line of its row (1.6 N6) says what its agents came to (1.6 N1) — the glyphs for the
  // eye, each a part of the line, hidden from a screen reader, which would read them as shapes —,
  // after its usage and before its span (1.6 P7b, pinned and changed: P7 ended the line on the
  // tally); the session with none is a leaf, and has no tally at all rather than "0 started". 1.6 L1
  // (pinned and changed: 1.5 made the toggle a button named "Expand …", P2c wrote the tally's words
  // after its glyphs): the item is the tree's first and so its one stop of the Tab key, and its name
  // says the rest in words — the whole name, the project, the state, the tally.
  assert.ok(h.indexOf(itemTag(AK.s1, { kind: 'session', tab: true, size: 2, pos: 1, expanded: false, label: 'Session Tue 10:55 · 9d0eb37a · repo, active session, derived, 4 started, 1 done, 1 failed, about 1 running, about 1 unknown' })
    + '<div class="ag-line">' + foldOf(AK.s1) + rowOf(AK.s1)) >= 0, h)
  assert.ok(h.indexOf(slbl('Session Tue 10:55 · 9d0eb37a · repo', 'Session', 'Tue 10:55', '9d0eb37a', 'repo')
    + '<span class="ag-fig" id="agf-' + AK.s1 + '"><span class="ag-fp"><span class="nobr">own 1.2M</span></span>'
    + '<span class="ag-fp">' + SEP + '<span class="nobr">agents 434.6K</span></span>'
    // 1.7 F4 (pinned and changed: the parts had no class of their own): each part wears the state it counts.
    + '<span class="ag-fp">' + SEP + '<span class="ag-t ag-tt-started" aria-hidden="true">4 started</span></span>'
    + '<span class="ag-fp">' + SEP + '<span class="ag-t ag-tt-done" aria-hidden="true">1 ✓</span></span>'
    + '<span class="ag-fp">' + SEP + '<span class="ag-t ag-tt-failed" aria-hidden="true">1 ✕</span></span>'
    + '<span class="ag-fp">' + SEP + '<span class="ag-t ag-tt-running" aria-hidden="true">~1 ●</span></span>'
    + '<span class="ag-fp">' + SEP + '<span class="ag-t ag-tt-unknown" aria-hidden="true">~1 ?</span></span>'
    + '<span class="ag-fp">' + SEP + '<span class="nobr"><span title="span from the first to the last line">1 h 05 min</span></span></span></span>') >= 0, h)
  assert.ok(h.indexOf(itemTag(AK.s2, { kind: 'session', size: 2, pos: 2, label: 'Session Mon 09:00 · 1234abcd, idle session, derived' })
    + '<div class="ag-line"><span class="ag-pad"></span>' + rowOf(AK.s2)) >= 0, h)
  assert.equal(h.indexOf('<span class="sr">4 started'), -1, h)
  assert.equal(h.split(/class="ag-t[" ]/).length - 1, 5, h)
  assert.equal(/started|agent\(s\)/.test(h.slice(h.indexOf('data-key="' + AK.s2 + '"'))), false, h)
  assert.equal(h.indexOf('aria-expanded="true"'), -1, h)
  // The screen reader's words are out of sight and still read: the page's visually hidden rule.
  assert.match(STYLE, /\.sr \{ position: absolute; width: 1px; height: 1px; margin: -1px; padding: 0; border: 0;\s+overflow: hidden; clip-path: inset\(50%\); white-space: nowrap; \}/)
})

test('an opened node shows its children closed in turn, each with its tally; a session and a run keep theirs open, an agent drops its own', () => {
  const a = agentCtx()
  // The reader opened the busy session: its run and its failed agent show, closed.
  const one = treePart(agentsHtml(a, { ui: agentUi({ agentsExpanded: [AK.s1] }) }))
  assert.ok(one.indexOf(itemTag(AK.s1, { kind: 'session', tab: true, size: 2, pos: 1, expanded: true, label: 'Session Tue 10:55 · 9d0eb37a · repo, active session, derived, 4 started, 1 done, 1 failed, about 1 running, about 1 unknown' })
    + '<div class="ag-line">' + foldOf(AK.s1)) >= 0, one)
  // Opened, the session still names its project and shows its tally (1.6 N1) — before its span
  // (1.6 P7b) —: what failed or is still unknown among its agents is not something to count off the
  // rows once they show.
  assert.ok(one.indexOf('<span class="ag-proj"> · repo</span></span>') >= 0, one)
  assert.ok(one.indexOf(tallyThen(T_S1, S1_SPAN)) >= 0, one)
  assert.ok(one.indexOf(itemTag(AK.wf, { kind: 'workflow', level: 2, size: 2, pos: 1, expanded: false, label: 'Workflow run Tue 11:40 · cfe7718d, running, derived, 2 started, 1 done, about 1 running' })
    + '<div class="ag-line">' + foldOf(AK.wf)) >= 0, one)
  assert.ok(one.indexOf(tallyThen(T_WF, WF_CLOCK)) >= 0, one)
  // A closed agent with an agent below it ends its figures on its tally too.
  assert.ok(one.indexOf('<span class="ag-sid">c3d4</span></span>' + figsOf(AK.a3, fig('12.3K'), fig('40.0 s'), ...tallyFigs(T_A3))) >= 0, one)
  assert.ok(one.indexOf(itemTag(AK.a3, { level: 2, size: 2, pos: 2, expanded: false,
    label: 'general-purpose · sonnet-5 · c3d4, failed, recorded, 1 started, about 1 unknown' })) >= 0, one)
  // The children of the closed ones are not written at all.
  for (const k of [AK.a1, AK.a2, AK.l1]) assert.equal(one.indexOf('data-key="' + k + '"'), -1, k)
  assert.equal(one.split('<ul role="group">').length - 1, 1, one)

  // Everything opened: three groups, every parent says it is open; the session and the run keep
  // their tallies, the opened agent shows its child's glyph instead of its own tally.
  const open = treePart(agentsHtml(a, { ui: openUi() }))
  assert.ok(open.indexOf(itemTag(AK.wf, { kind: 'workflow', level: 2, size: 2, pos: 1, expanded: true, label: 'Workflow run Tue 11:40 · cfe7718d, running, derived, 2 started, 1 done, about 1 running' })
    + '<div class="ag-line">' + foldOf(AK.wf)) >= 0, open)
  // A leaf has no toggle and keeps its place in the column with an empty slot.
  assert.ok(open.indexOf(itemTag(AK.a1, { level: 3, size: 2, pos: 1, label: 'Explore · claude-opus-5 · a94f, running, derived' })
    + '<div class="ag-line"><span class="ag-pad"></span>' + rowOf(AK.a1, false, 'running')) >= 0, open)
  assert.equal(open.split('aria-expanded="true"').length - 1, 3, open)
  assert.equal(open.indexOf('aria-expanded="false"'), -1, open)
  assert.equal(open.split('<ul role="group">').length - 1, 3, open)
  assert.ok(open.indexOf(tallyThen(T_S1, S1_SPAN)) >= 0, open)
  assert.ok(open.indexOf(tallyThen(T_WF, WF_CLOCK)) >= 0, open)
  assert.ok(open.indexOf('<span class="ag-sid">c3d4</span></span>' + figsOf(AK.a3, fig('12.3K'), fig('40.0 s')) + '</span></span>') >= 0, open)
  // Its item's name drops the tally with the row: open, its children say it with their own glyphs.
  assert.ok(open.indexOf(itemTag(AK.a3, { level: 2, size: 2, pos: 2, expanded: true,
    label: 'general-purpose · sonnet-5 · c3d4, failed, recorded' })) >= 0, open)
  assert.equal(open.split(/class="ag-t[" ]/).length - 1, 5 + 3, open)
  assert.equal(open.indexOf('agent(s)'), -1, open)

  // Opening a node below a closed one shows nothing of it: the session decides first.
  const deep = treePart(agentsHtml(a, { ui: agentUi({ agentsExpanded: [AK.wf] }) }))
  for (const k of [AK.wf, AK.a1, AK.a2]) assert.equal(deep.indexOf('data-key="' + k + '"'), -1, k)
  // A tally the view model did not give — none, empty, nonsense — prints nothing, never a 0; the
  // count alone is no tally. Words missing, the glyphs are read out rather than nothing.
  for (const tallyText of [undefined, '', 7, null, {}, ['4 started']]) {
    const odd = agentTree({ roots: [treeNode(AK.s1, 'active', {
      kind: 'session', label: 'Session Tue 10:55 · 9d0eb37a', agentCount: 4, tallyText, tallySpoken: '4 started', children: [treeNode(AK.a1, 'running')],
    })] })
    const oh = treePart(agentsHtml(a, { agents: odd }))
    assert.equal(/class="ag-t[" ]/.test(oh), false, String(tallyText))
    assert.equal(/started|agent\(s\)|>0</.test(oh), false, oh)
  }
  const mute = agentTree({ roots: [treeNode(AK.s1, 'active', {
    kind: 'session', label: 'Session Tue 10:55 · 9d0eb37a', tallyText: '2 started · 2 ✓', tallySpoken: null, children: [treeNode(AK.a1, 'running')],
  })] })
  const mh = treePart(agentsHtml(a, { agents: mute }))
  assert.ok(mh.indexOf(tallyFigs({ tallyText: '2 started · 2 ✓', tallySpoken: '2 started · 2 ✓' })
    .map((p) => '<span class="ag-fp">' + SEP + p + '</span>').join('')) >= 0)
  assert.ok(mh.indexOf(' aria-label="Session Tue 10:55 · 9d0eb37a, active session, derived, 2 started · 2 ✓"') >= 0, mh)
  // The tally is the view model's text, and like every text of it, it is escaped.
  const hostile = agentTree({ roots: [treeNode(AK.s1, 'active', {
    kind: 'session', label: 'Session Tue 10:55 · 9d0eb37a', tallyText: '<b>1</b> started', tallySpoken: '"1" <started>', children: [treeNode(AK.a1, 'running')],
  })] })
  const hh = treePart(agentsHtml(a, { agents: hostile }))
  assert.ok(hh.indexOf('<span class="ag-t" aria-hidden="true">&lt;b&gt;1&lt;/b&gt; started</span>') >= 0, hh)
  assert.ok(hh.indexOf(' aria-label="Session Tue 10:55 · 9d0eb37a, active session, derived, &quot;1&quot; &lt;started&gt;"') >= 0, hh)
  // The twisty is drawn, not typed, and turns with the attribute.
  assert.match(STYLE, /\.ag-fold::before \{ content: "▾";/)
  assert.match(STYLE, /\[aria-expanded="false"\] > \.ag-line > \.ag-fold::before \{ content: "▸"; \}/)
  assert.equal(/[▾▸]/.test(open + one), false)
})

test('the selected node is the one pressed row, and only a selection opens the details', () => {
  const a = agentCtx()
  const none = agentsHtml(a, { ui: openUi() })
  assert.equal(none.indexOf('aria-pressed="true"'), -1, none)
  assert.equal(none.indexOf('data-pressed="true"'), -1, none)
  assert.equal(none.indexOf('ag-details'), -1, none)
  const h = treePart(agentsHtml(a, { agents: agentTree({ selected: detailsOf() }), ui: openUi({ agentSelected: AK.a1 }) }))
  // 1.6 L1 (pinned and changed: the row was a button, pressed by aria-pressed): the row is no
  // control of its own, and a state of a button on it would say it is one — `data-pressed` marks it.
  const pressed = [...h.matchAll(/data-act="agentSelect" data-key="([^"]*)" data-pressed="true"/g)].map((m) => m[1])
  assert.deepEqual(pressed, [AK.a1])
  assert.equal(h.split('data-pressed="false"').length - 1, 6, h)
  assert.equal(h.indexOf('aria-pressed'), -1, h)
  // The tree says the same to a screen reader.
  assert.equal(h.split('aria-selected="true"').length - 1, 1, h)
  // The selected item, whose row is drawn, is the tree's one stop of the Tab key.
  assert.equal(h.split('tabindex="0"').length - 1, 1, h)
  assert.ok(h.indexOf(' data-key="' + AK.a1 + '" tabindex="0"') >= 0, h)
  // Quieter than a pressed chip: the track's tint and the focus colour's edge.
  assert.match(STYLE, /\.ag-row\[aria-pressed="true"\], \.agtree \.ag-row\[data-pressed="true"\] \{ background: var\(--track\);/)
})

test('selecting a node opens nothing: with its tree row in a closed branch, the details open under its running row', () => {
  const a = agentCtx()
  // The running agent, selected from the running list: its tree row is inside a closed branch.
  const h = agentsHtml(a, {
    agents: agentTree({ selected: detailsOf() }), ui: agentUi({ agentSelected: AK.a1, agentSelectedIn: 'now' }),
  })
  const tree = treePart(h)
  assert.equal(tree.indexOf('data-key="' + AK.a1 + '"'), -1, 'the selection opened the branch')
  assert.equal(tree.indexOf('aria-expanded="true"'), -1, tree)
  // 1.6 N2: the details open inside the running row's item, right under its button — not under
  // the tree — with the live age of the node's last line.
  const panel = panelOf(h)
  const row = h.indexOf('data-key="' + AK.a1 + '" data-list="now"')
  assert.ok(row >= 0 && h.indexOf('</button>' + panel + '</li>', row) > row, h)
  assert.ok(h.indexOf(panel) < h.indexOf('<div class="agtree"'), h)
  assert.equal(tree.indexOf('ag-details'), -1, tree)
  assert.ok(panel.indexOf('<span data-live="since" data-ts="' + (AG_NOW - 5_000) + '">5 s</span> ago') >= 0, panel)
  // Its running row is the one pressed row; the tree has none on screen.
  assert.deepEqual([...h.matchAll(/data-key="([^"]*)" data-list="now" aria-pressed="true"/g)].map((m) => m[1]), [AK.a1])
  assert.equal(h.split('aria-pressed="true"').length - 1, 1, h)
  // A selection made in the tree finds its tree row hidden by the closed branch just the same:
  // its row in the running list is the one on the page, and the details go there.
  const fromTree = agentsHtml(a, { agents: agentTree({ selected: detailsOf() }), ui: agentUi({ agentSelected: AK.a1 }) })
  assert.equal(fromTree, h)
  // A node of a session the tree does not list is found in the running list for its clock.
  const far = 'a:ffff0001'
  const beyond = agentsHtml(a, {
    agents: agentTree({
      runningNow: [runningItem({ key: far, lastTs: AG_NOW - 7_000 })],
      selected: detailsOf({ key: far, rows: [] }),
    }),
    ui: agentUi({ agentSelected: far }),
  })
  const farPanel = panelOf(beyond)
  assert.ok(beyond.indexOf('data-key="' + far + '" data-list="now" aria-pressed="true"') >= 0, beyond)
  assert.ok(farPanel.indexOf('<dt>Last activity</dt><dd><span class="nobr"><span data-live="since" data-ts="'
    + (AG_NOW - 7_000) + '">7 s</span> ago</span></dd>') >= 0, farPanel)
  assert.ok(farPanel.indexOf('aria-label="running, derived" title="~running · derived"') >= 0, farPanel)
})

test('the details open inside the entry of the row that was clicked, after its line and before its children, once a page', () => {
  // 1.6 N2: in the tree, the panel stands in the selected node's <li role="treeitem">: its line
  // (toggle and row), then the panel, then the group of its children — and it steps back out of
  // the levels above it, so it takes the tree's whole width at any depth.
  const a = agentCtx()
  const h = agentsHtml(a, {
    agents: agentTree({ selected: detailsOf({ key: AK.a3, title: 'general-purpose · sonnet-5 · c3d4', state: 'failed', derived: false }) }),
    ui: openUi({ agentSelected: AK.a3 }),
  })
  const panel = panelOf(h)
  assert.ok(panel.startsWith('<div class="ag-details" data-ind="1" role="region" aria-label="Details">'), panel)
  const entry = h.indexOf(itemTag(AK.a3, { tab: true, level: 2, size: 2, pos: 2, expanded: true, selected: true,
    label: 'general-purpose · sonnet-5 · c3d4, failed, recorded' }))
  assert.ok(entry >= 0, h)
  const line = h.indexOf('<div class="ag-line">', entry)
  const group = h.indexOf('<ul role="group">', entry)
  assert.ok(line > entry && h.indexOf(panel, line) > line && h.indexOf(panel, line) < group, h)
  assert.ok(h.indexOf('</span></span></div>' + panel + '<ul role="group">', entry) > entry, h)
  // Only its row is pressed; the panel is drawn once, and nowhere after the tree.
  assert.deepEqual([...h.matchAll(/data-key="([^"]*)" data-pressed="true"/g)].map((m) => m[1]), [AK.a3])
  assert.equal(h.split('<div class="ag-details"').length - 1, 1, h)
  // 1.6 D10: nothing after the tree — the line about the lower bound is gone.
  assert.ok(h.endsWith('</ul></div>'), h.slice(-200))
  // A session's panel stands at the tree's own edge: no level to step out of.
  const top = agentsHtml(a, { agents: agentTree({ selected: detailsOf({ key: AK.s1, rows: [] }) }), ui: agentUi({ agentSelected: AK.s1 }) })
  assert.ok(panelOf(top).startsWith('<div class="ag-details" role="region" aria-label="Details">'), top)
  assert.ok(top.indexOf('data-pressed="true">') < top.indexOf(panelOf(top)), top)
  // The level the panel steps out of comes from the page's own stylesheet, through the CSSOM
  // (the page's CSP allows no style attribute): one indent of the tree per level.
  assert.match(STYLE, /\.ag-details \{ margin: 4px 0 6px calc\(var\(--ag-ind, 0\) \* -16px\);/)
  // 1.7 F6 (pinned and changed: the step was the literal `padding-left: 16px`): the indent is the tree's
  // --ag-step, 16 px, which the guide lines measure their places by.
  assert.match(STYLE, /\.agtree ul ul \{ padding-left: var\(--ag-step\); \}/)
  assert.match(STYLE, /\.agtree \{ --ag-step: 16px;/)
  assert.match(SCRIPT, /querySelectorAll\("\[data-ind\]"\)\.forEach\(\(el\) => \{\s*el\.style\.setProperty\("--ag-ind", el\.dataset\.ind\);/)
  // In the running list the panel is an item's second line, the whole width of the list.
  assert.match(STYLE, /\.ag-now li \{ display: flex; flex-wrap: wrap; \}/)
  assert.match(STYLE, /\.ag-now li > \.ag-details \{ flex: 1 1 100%; min-width: 0; \}/)
})

test('with both of a running node\'s rows on the page the details open under the one the reader clicked', () => {
  // 1.6 N2: `ui.agentSelectedIn` — the `from` of the message — decides; the other row stays
  // unpressed, while the tree still says which node is selected.
  const a = agentCtx()
  const tree = agentsHtml(a, { agents: agentTree({ selected: detailsOf() }), ui: openUi({ agentSelected: AK.a1, agentSelectedIn: 'tree' }) })
  const now = agentsHtml(a, { agents: agentTree({ selected: detailsOf() }), ui: openUi({ agentSelected: AK.a1, agentSelectedIn: 'now' }) })
  // 1.6 L1: a tree row says it by `data-pressed`, a running list's button by `aria-pressed`.
  const pressed = (h: string): string[] => [...h.matchAll(/data-key="([^"]*)"(?:( data-list="now") aria-pressed| data-pressed)="true"/g)]
    .map((m) => m[1] + (m[2] ? '@now' : '@tree'))
  assert.deepEqual(pressed(tree), [AK.a1 + '@tree'])
  assert.deepEqual(pressed(now), [AK.a1 + '@now'])
  assert.ok(tree.indexOf(panelOf(tree)) > tree.indexOf('<div class="agtree"'), tree)
  assert.ok(now.indexOf(panelOf(now)) < now.indexOf('<div class="agtree"'), now)
  for (const h of [tree, now]) {
    assert.equal(h.split('<div class="ag-details"').length - 1, 1, h)
    assert.equal(treePart(h).split('aria-selected="true"').length - 1, 1, h)
  }
  // A place the page does not know is the tree's; a running row that is gone hands the details to
  // the tree row, and a tree row that is hidden to the running row. 1.6 P10a (L3, pinned and
  // changed: 'week' was the unknown place here): the 7-day block's row is a place now — while the
  // block is closed it has no row, and the tree's takes the details.
  for (const place of ['rocket', 'week']) {
    const odd = agentsHtml(a, { agents: agentTree({ selected: detailsOf() }), ui: openUi({ agentSelected: AK.a1, agentSelectedIn: place }) })
    assert.deepEqual(pressed(odd), [AK.a1 + '@tree'], place)
  }
  const ended = agentsHtml(a, {
    agents: agentTree({ runningNow: [], selected: detailsOf() }), ui: openUi({ agentSelected: AK.a1, agentSelectedIn: 'now' }),
  })
  assert.deepEqual(pressed(ended), [AK.a1 + '@tree'])
  assert.ok(ended.indexOf(panelOf(ended)) > ended.indexOf('<div class="agtree"'), ended)
})

test('details for a node with no row on the page are drawn nowhere, and say nothing is gone', () => {
  // 1.6 §3.0 b: the view model sends details only for a node whose row is on the page. A payload
  // that holds them all the same — a node the tree does not draw and the running list does not
  // name — gets no panel: there is no row for it to stand under.
  const a = agentCtx()
  for (const [over, ui] of [
    [{ selected: detailsOf({ key: 'a:ffff0002' }), runningNow: [], omittedRoots: 1 }, agentUi({ agentSelected: 'a:ffff0002' })],
    // In the payload, under a node that is closed.
    [{ selected: detailsOf({ key: AK.a2 }) }, agentUi({ agentSelected: AK.a2 })],
    [{ selected: { key: 'x' } }, agentUi()],
    [{ selected: { key: '' } }, openUi()],
    [{ selected: 'details' }, openUi({ agentSelected: AK.a1 })],
  ] as Array<[Record<string, unknown>, Record<string, unknown>]>) {
    const h = agentsHtml(a, { agents: agentTree(over), ui })
    assert.equal(h.indexOf('ag-details'), -1, h)
    assert.equal(h.indexOf('aria-pressed="true"'), -1, h)
    assert.equal(h.indexOf('The selected node is no longer in the tree.'), -1, h)
  }
})

test('a sentence row of the details breaks between its words, never between a figure and its unit (1.6 P13b)', () => {
  // Claude Code's run record (L4): seven figures in one sentence, a narrow panel wraps it — "40" is
  // never left at the end of a line with its "s" on the next. Each figure with its unit gets a span
  // that does not break; the words stay the view model's, character for character. A row laid out
  // as a figure, and a name that only has digits in it, are left as they were.
  const a = agentCtx()
  const value = 'running · started 11:40 · 6 agents · 142.3K tokens · 11 tool calls · 15 min 40 s · default model claude-opus-4-6[1m]'
  const h = agentsHtml(a, {
    agents: agentTree({
      selected: detailsOf({
        rows: [
          { label: "Claude Code's run record", value, note: "Claude Code's own figures, never added to a total", kind: 'sentence' },
          { label: 'Duration', value: '15 min 40 s' },
          { label: 'Share', value: '76 % · 1 h 05 min', kind: 'sentence' },
        ],
      }),
    }),
    ui: agentUi({ agentSelected: AK.a1 }),
  })
  const panel = panelOf(h)
  assert.ok(panel.indexOf('<dt class="ag-wide">Claude Code&#39;s run record</dt><dd class="ag-wide">running · started 11:40 · 6 agents · '
    + '<span class="nobr">142.3K</span> tokens · 11 tool calls · <span class="nobr">15 min</span> <span class="nobr">40 s</span> · '
    + 'default model claude-opus-4-6[1m] · <span class="meta">Claude Code&#39;s own figures, never added to a total</span></dd>') >= 0, panel)
  assert.ok(panel.indexOf('<dt>Duration</dt><dd>15 min 40 s</dd>') >= 0, panel)
  assert.ok(panel.indexOf('<dd class="ag-wide"><span class="nobr">76 %</span> · <span class="nobr">1 h</span> <span class="nobr">05 min</span></dd>') >= 0, panel)
  // The words, without the tags, are the row's.
  const dd = panel.slice(panel.indexOf('run record</dt><dd class="ag-wide">') + 'run record</dt><dd class="ag-wide">'.length)
  assert.equal(dd.slice(0, dd.indexOf(' · <span class="meta">')).replace(/<[^>]+>/g, ''), value)
})

test('the details print the view model\'s rows, a dash for each absence, and a live last activity', () => {
  const a = agentCtx()
  const h = agentsHtml(a, { agents: agentTree({ selected: detailsOf() }), ui: agentUi({ agentSelected: AK.a1 }) })
  // Under the node's row — here its row in the running list, the tree being closed (1.6 N2).
  assert.ok(h.indexOf('data-list="now" aria-pressed="true"') < h.indexOf('<div class="ag-details"')
    && h.indexOf('<div class="ag-details"') < h.indexOf('<div class="agtree"'), h)
  const panel = panelOf(h)
  assert.ok(panel.startsWith('<div class="ag-details" role="region" aria-label="Details">'
    + '<div class="name">Explore · claude-opus-5 · a94f</div><dl>'
    + '<dt class="ag-wide">State</dt><dd class="ag-wide"><span class="ag-st ag-running" role="img" '
    + 'aria-label="running, derived" title="~running · derived"></span> '
    + 'Running — inferred: the transcript changed 5 s ago and no result was recorded yet.</dd>'
    + '<dt>Type</dt><dd>Explore</dd><dt>Model</dt><dd>claude-opus-5</dd>'), panel)
  // Absent is a dash, whether the model sent an empty text, a dash or nothing at all.
  assert.ok(panel.indexOf('<dt>Depth</dt><dd>–</dd>') >= 0, panel)
  assert.ok(panel.indexOf('<dt>Spawned by</dt><dd>–</dd>') >= 0, panel)
  assert.ok(panel.indexOf('<dt>Workflow run</dt><dd>–</dd>') >= 0, panel)
  assert.ok(panel.indexOf('<dt>Output</dt><dd>1.2K <span class="meta">⚠ lower bound</span></dd>') >= 0, panel)
  // The row the model marks live keeps its time and gains the clock — once, in place of the age
  // the view model wrote beside it: one age per row, never two. 1.6 N9: the ticking age is for the
  // eye alone; the row's own time beside it is what a screen reader reads.
  assert.ok(panel.indexOf('<dt>Last activity</dt><dd>11:59:55 · <span aria-hidden="true"><span class="nobr"><span data-live="since" data-ts="'
    + (AG_NOW - 5_000) + '">5 s</span> ago</span></span></dd>') >= 0, panel)
  assert.equal(panel.split('Last activity').length - 1, 1, panel)
  assert.equal(panel.indexOf('<span class="meta">5 s ago</span>'), -1, panel)
  // Claude Code's report is a sentence, not a figure, because the row says so (kind): it takes
  // the whole width under its label, its note set off by the separator the page uses between
  // clauses. 1.6 P13b (pinned and changed): a sentence breaks between its words, never between a
  // figure and its unit — each figure with its unit in a span of its own, the words unchanged.
  assert.ok(panel.indexOf('<dt class="ag-wide">Report from Claude Code</dt><dd class="ag-wide">context at the end '
    + '<span class="nobr">12K</span> (incl. cache reads and the reply) · <span class="nobr">40.0 s</span> from the start · 3 tool calls · '
    + '<span class="meta">Claude Code&#39;s own figure for this agent, never added to a total</span></dd>') >= 0, panel)
  // D11: the ID row, the whole id, and beside it the one button that asks the host to copy it.
  assert.ok(panel.indexOf('<dt>ID</dt><dd><span class="ag-id">a94f3c2e10b7d5e19</span> '
    + '<button class="ag-copy" data-act="cmd" data-id="tokenPace.copyAgentId">Copy ID</button></dd>') >= 0, panel)
  assert.equal(panel.split('data-id="tokenPace.copyAgentId"').length - 1, 1, panel)
  // A model without a live row gets a row of the page's own, right under the state.
  const own = agentsHtml(a, {
    agents: agentTree({ selected: detailsOf({ rows: [{ label: 'Type', value: 'Explore' }] }) }),
    ui: agentUi({ agentSelected: AK.a1 }),
  })
  assert.ok(own.indexOf('yet.</dd><dt>Last activity</dt><dd><span class="nobr"><span data-live="since" data-ts="'
    + (AG_NOW - 5_000) + '">5 s</span> ago</span></dd><dt>Type</dt><dd>Explore</dd></dl></div>') >= 0, own)
  // R5: the layout and the clock are the rows' own say, never a guess from their words. A row
  // labelled "Last activity" that is not marked live keeps its note and gets no clock (the
  // page adds its own row); a note that is a clause does not make a figure a sentence; a
  // sentence whose note is a ⚠ stays a sentence; a second copy row gets no second button.
  const said = agentsHtml(a, {
    agents: agentTree({
      selected: detailsOf({
        rows: [
          { label: 'Last activity', value: '11:59:55', note: '5 s ago' },
          { label: 'Report', value: '12K', note: 'a clause of its own' },
          { label: 'Output', value: '1.2K', note: '⚠ lower bound', kind: 'sentence' },
          { label: 'ID', value: 'a1', copy: true },
          { label: 'ID', value: 'a2', copy: true },
          // 1.6 P9 (pinned and changed): `bar` is a kind this build draws (L2); an unknown one is another.
          { label: 'Chart', value: 'x', kind: 'chart' },
        ],
      }),
    }),
    ui: agentUi({ agentSelected: AK.a1 }),
  })
  const saidPanel = said.slice(said.indexOf('<div class="ag-details"'))
  assert.ok(saidPanel.indexOf('yet.</dd><dt>Last activity</dt><dd><span class="nobr"><span data-live="since"') >= 0, saidPanel)
  assert.ok(saidPanel.indexOf('<dt>Last activity</dt><dd>11:59:55 <span class="meta">5 s ago</span></dd>') >= 0, saidPanel)
  assert.ok(saidPanel.indexOf('<dt>Report</dt><dd>12K <span class="meta">a clause of its own</span></dd>') >= 0, saidPanel)
  assert.ok(saidPanel.indexOf('<dt class="ag-wide">Output</dt><dd class="ag-wide"><span class="nobr">1.2K</span> · <span class="meta">⚠ lower bound</span></dd>') >= 0, saidPanel)
  assert.equal(saidPanel.split('data-id="tokenPace.copyAgentId"').length - 1, 1, saidPanel)
  assert.ok(saidPanel.indexOf('<dt>ID</dt><dd>a2</dd>') >= 0, saidPanel)
  // A kind this build does not know is laid out as a figure.
  assert.ok(saidPanel.indexOf('<dt>Chart</dt><dd>x</dd>') >= 0, saidPanel)
  // A node without a last activity gets no clock: the launch nobody has seen a line of.
  const pending = agentsHtml(a, {
    agents: agentTree({ selected: detailsOf({ key: AK.l1, title: 'Explore · – · launched', state: 'unknown', lastTs: null, rows: [] }) }),
    ui: openUi({ agentSelected: AK.l1 }),
  })
  const pendingPanel = pending.slice(pending.indexOf('<div class="ag-details"'))
  assert.equal(pendingPanel.indexOf('data-live'), -1, pendingPanel)
  assert.ok(pendingPanel.indexOf('aria-label="unknown, derived"') >= 0, pendingPanel)
  // A recorded state is no estimate in the panel either.
  const done = agentsHtml(a, {
    agents: agentTree({ selected: detailsOf({ key: AK.a2, state: 'done', derived: false, stateText: 'Completed — the parent recorded the result at 11:59.' }) }),
    ui: openUi({ agentSelected: AK.a2 }),
  })
  assert.ok(done.indexOf('<dt class="ag-wide">State</dt><dd class="ag-wide"><span class="ag-st ag-done" role="img" '
    + 'aria-label="done, recorded" title="done · recorded"></span> Completed — the parent recorded the result at 11:59.</dd>') >= 0, done)
  // A details payload with nothing in it but the key of a row on the page is dashes — and the
  // clock of the node its row is, the one thing the page adds.
  const empty = agentsHtml(a, { agents: agentTree({ selected: { key: AK.s1 } }), ui: agentUi({ agentSelected: AK.s1 }) })
  assert.equal(panelOf(empty),
    '<div class="ag-details" role="region" aria-label="Details"><div class="name">–</div><dl>'
    + '<dt class="ag-wide">State</dt><dd class="ag-wide"><span class="ag-st ag-unknown" role="img" '
    + 'aria-label="unknown, derived" title="~unknown · derived"></span> –</dd>'
    + '<dt>Last activity</dt><dd><span class="nobr"><span data-live="since" data-ts="' + (AG_NOW - 5_000) + '">5 s</span> ago</span></dd>'
    + '</dl></div>')
  // Two columns at every width; the sentences span both.
  assert.match(STYLE, /\.ag-details dl \{ display: grid; grid-template-columns: max-content minmax\(0, 1fr\);/)
  assert.equal(/\.ag-details dl \{ grid-template-columns: 1fr;/.test(STYLE), false, 'the details still stack somewhere')
  assert.match(STYLE, /\.ag-details \.ag-wide \{ grid-column: 1 \/ -1; \}/)
})

test('an agent\'s details: the line under its state, and its token mix as one bar whose parts the CSSOM sizes, with its words under it', () => {
  // 1.6 L2 (P9).
  const a = agentCtx()
  const mix = {
    label: 'Token mix', value: 'fresh 2 % · cache write 18 % · cache read 76 % · output 4 %', kind: 'bar',
    parts: [
      { part: 'fresh', share: 0.02, label: 'fresh 2 %' }, { part: 'cacheWrite', share: 0.18, label: 'cache write 18 %' },
      { part: 'cacheRead', share: 0.76, label: 'cache read 76 %' }, { part: 'output', share: 0.04, label: 'output 4 %' },
    ],
  }
  const h = agentsHtml(a, {
    agents: agentTree({ selected: detailsOf({ overview: '1.2K in 29 min 00 s · 5 requests · <3> tool calls', rows: [mix, { label: 'Type', value: 'Explore' }] }) }),
    ui: agentUi({ agentSelected: AK.a1 }),
  })
  const panel = panelOf(h)
  // Right under the state, across the whole width; its label a screen reader's alone; escaped; each
  // clause kept whole, so a narrow panel breaks between two of them, never inside "29 min".
  assert.ok(panel.indexOf('no result was recorded yet.</dd><dt class="sr">Summary</dt>'
    + '<dd class="ag-wide ag-overview"><span class="nobr">1.2K in 29 min 00 s</span> · <span class="nobr">5 requests</span> · '
    + '<span class="nobr">&lt;3&gt; tool calls</span></dd>') >= 0, panel)
  // The bar across the whole width, a part per kind in the Tokens section's colours, each as wide
  // as its share — through data-w, which applyStyles writes with the CSSOM, never an inline style
  // the page's CSP would refuse —, its words under it; the bar itself hidden from a screen reader.
  assert.ok(panel.indexOf('<dt class="ag-wide">Token mix</dt><dd class="ag-wide"><span class="ag-mix" aria-hidden="true">'
    + '<i class="cs c1" data-w="2.00" title="fresh 2 %"></i><i class="cs c2" data-w="18.00" title="cache write 18 %"></i>'
    + '<i class="cs c4" data-w="76.00" title="cache read 76 %"></i><i class="cs c5" data-w="4.00" title="output 4 %"></i></span>'
    + '<span class="ag-mixtext"><span class="nobr">fresh 2 %</span> · <span class="nobr">cache write 18 %</span> · '
    + '<span class="nobr">cache read 76 %</span> · <span class="nobr">output 4 %</span></span></dd><dt>Type</dt>') >= 0, panel)
  assert.equal(/\sstyle=/.test(panel), false, panel)
  assert.match(SCRIPT, /querySelectorAll\("\[data-w\]"\)\.forEach\(\(el\) => \{\s*el\.style\.width = el\.dataset\.w \+ "%";/)
  // A part this page cannot draw is left out: a share that is no number, outside 0…1, a kind it
  // does not know; a bar with no part left is its words alone, still across the width.
  const odd = agentsHtml(a, {
    agents: agentTree({
      selected: detailsOf({
        overview: null,
        rows: [{
          label: 'Token mix', value: 'x', kind: 'bar',
          parts: [{ part: 'fresh', share: Number.NaN, label: 'a' }, { part: 'cacheRead', share: 1.5, label: 'b' },
            { part: '__proto__', share: 0.5, label: 'c' }, { part: 'output', share: 0.5, label: '"d"' }],
        }, { label: 'Token mix', value: 'y', kind: 'bar', parts: 'none' }],
      }),
    }),
    ui: agentUi({ agentSelected: AK.a1 }),
  })
  const oddPanel = panelOf(odd)
  assert.ok(oddPanel.indexOf('<dd class="ag-wide"><span class="ag-mix" aria-hidden="true"><i class="cs c5" data-w="50.00" title="&quot;d&quot;"></i></span>'
    + '<span class="ag-mixtext"><span class="nobr">x</span></span></dd>') >= 0, oddPanel)
  assert.ok(oddPanel.indexOf('<dt class="ag-wide">Token mix</dt><dd class="ag-wide"><span class="nobr">y</span></dd>') >= 0, oddPanel)
  // No overview, no line and no hidden label.
  assert.equal(oddPanel.indexOf('ag-overview'), -1, oddPanel)
  assert.equal(oddPanel.indexOf('<dt class="sr">'), -1, oddPanel)
  // The bar's own rules: a flex row of the track's colour, its parts full height.
  assert.match(STYLE, /\.ag-mix \{ display: flex; height: 8px;[^}]*overflow: hidden; background: var\(--track\); \}/)
  assert.match(STYLE, /\.ag-mix > i \{ display: block; height: 100%; \}/)
})

test('details under a row of the running list say themselves whether the state was recorded, and keep their clock', () => {
  const a = agentCtx()
  // A row of the running list says nothing of whether a state was recorded, and one of a
  // session the tree does not list is the only row its node has. An agent that ended between
  // the list and the details — the details say done — is described by its details, never
  // guessed to be an estimate; and its clock ticks from their last activity when the row has none.
  const far = 'a:ffff0002'
  const only = runningItem({ key: far, lastTs: null })
  const cases: Array<[string, string, string]> = [
    ['done', 'Completed — the parent recorded the result at 11:58.', 'done · recorded'],
    ['failed', 'Failed — the parent recorded the failure at 11:58.', 'failed · recorded'],
  ]
  for (const [state, stateText, title] of cases) {
    const h = agentsHtml(a, {
      agents: agentTree({
        runningNow: [only], omittedRoots: 1,
        selected: detailsOf({
          key: far, state, derived: false, stateText, lastTs: AG_NOW - 65_000,
          rows: [{ label: 'Last activity', value: '11:58:55', note: '1 min ago', live: 'ago' }],
        }),
      }),
      ui: agentUi({ agentSelected: far }),
    })
    assert.equal(treePart(h).indexOf('data-key="' + far + '"'), -1, 'the node has a tree row on the page after all')
    const panel = panelOf(h)
    assert.ok(h.indexOf('data-key="' + far + '" data-list="now" aria-pressed="true"') < h.indexOf(panel), h)
    assert.ok(panel.indexOf('<dd class="ag-wide"><span class="ag-st ag-' + state + '" role="img" aria-label="'
      + title.replace(' · ', ', ') + '" title="' + title + '"></span> ' + stateText + '</dd>') >= 0, panel)
    assert.equal(panel.indexOf('~' + state), -1, panel)
    // The clock ticks from the details' own last activity, in place of the note, once.
    assert.ok(panel.indexOf('<dt>Last activity</dt><dd>11:58:55 · <span aria-hidden="true"><span class="nobr"><span data-live="since" data-ts="'
      + (AG_NOW - 65_000) + '">1 min 05 s</span> ago</span></span></dd>') >= 0, panel)
    assert.equal(panel.indexOf('1 min ago'), -1, panel)
  }
  // An inferred state says so the same way, and details that say nothing — a payload from a
  // build before the flag — are never called recorded, whatever state they name.
  const running = agentsHtml(a, { agents: agentTree({ runningNow: [only], selected: detailsOf({ key: far }) }), ui: agentUi({ agentSelected: far }) })
  assert.ok(panelOf(running).indexOf('aria-label="running, derived"') >= 0, running)
  const unsaid = agentsHtml(a, {
    agents: agentTree({ runningNow: [only], selected: detailsOf({ key: far, state: 'done', derived: 'no', lastTs: 'soon' }) }),
    ui: agentUi({ agentSelected: far }),
  })
  assert.ok(panelOf(unsaid).indexOf('aria-label="done, derived"') >= 0, unsaid)
  assert.equal(panelOf(unsaid).indexOf('data-live'), -1, unsaid)
  // A row of the tree says what the panel says: the node's flag and clock come first.
  const onPage = agentsHtml(a, {
    agents: agentTree({ selected: detailsOf({ key: AK.a2, state: 'done', derived: true, lastTs: AG_NOW - 99_000 }) }),
    ui: openUi({ agentSelected: AK.a2 }),
  })
  const onPagePanel = panelOf(onPage)
  assert.ok(onPagePanel.indexOf('aria-label="done, recorded"') >= 0, onPagePanel)
  assert.ok(onPagePanel.indexOf('data-ts="' + (AG_NOW - 5_000) + '"') >= 0, onPagePanel)
  assert.equal(onPagePanel.indexOf('data-ts="' + (AG_NOW - 99_000) + '"'), -1, onPagePanel)
})

// 1.6 P6 (§3 D10): pinned "the ⚠ line counts the running list" — the line under the tree ("Output
// figures in the details marked ⚠ are lower bounds.") is gone; a row marks its own lower bound.
// 1.6 P7 (pinned and changed, the lead's call on the pictures, §7a Q5): the page ships with the
// rows marked — P6 pinned the running list's row unmarked while the mark was off.
test('no line under the tree speaks of the lower bound, and the running list\'s row marks its own', () => {
  const a = agentCtx()
  // The default page: every agent inside a closed branch, the running agent's list row a lower bound.
  const why = '⚠ lower bound — 2 of 41 replies unfinished'
  const bound = agentsHtml(a, { agents: agentTree({ runningNow: [runningItem({ lowerBound: true, lowerBoundText: why })] }) })
  assert.equal(treePart(bound).indexOf('data-key="' + AK.a1 + '"'), -1, 'the running agent\'s tree row is on screen')
  assert.equal(bound.split('⚠').length - 1, 2, bound)
  // 1.7 D-A (pinned and changed): the ⚠ hidden from a screen reader, "lower bound" in the line.
  assert.ok(bound.indexOf(fig('12.3K' + lbMark(why))) >= 0, bound)
  assert.equal(/marked ⚠|lower bounds\./.test(bound), false, bound)
  assert.ok(bound.endsWith('</ul></div>'), bound.slice(-120))
  // The word is out of the page's dictionary, and out of the script.
  assert.equal('Output figures in the details marked ⚠ are lower bounds.' in DICT, false)
  assert.equal(SCRIPT.includes('Output figures in the details'), false)
})

/**
 * The page without the rows' ⚠ — the alternative the lead decided against (1.6 D10, §7a Q5; on
 * since P7): the one line of the script that decides it, turned off — the shipped script says
 * `true`, exactly once.
 */
function unmarkedScript(): string {
  const on = 'const ROW_LOWER_BOUND_MARK = true;'
  assert.equal(SCRIPT.split(on).length - 1, 1, 'the shipped page decides the row mark in one line, and ships it on')
  assert.equal(SOURCE.split('const ROW_LOWER_BOUND_MARK: boolean = true;').length - 1, 1)
  return SCRIPT.replace(on, 'const ROW_LOWER_BOUND_MARK = false;')
}

// 1.6 P7 (pinned and changed): P6 pinned this with the mark turned on by hand and the shipped page
// unmarked; the page ships marked now, and turned off it marks nothing.
test('a lower bound carries one ⚠ inside its usage figure, titled with its reason — as shipped — and none with the mark off', () => {
  const a = agentCtx()
  const why = '⚠ lower bound — 2 of 41 replies unfinished'
  // 1.7 D-A (pinned and changed: 1.6 D10 wrote an image named "lower bound"): the ⚠ hidden from a
  // screen reader, its words in the line after it.
  const mark = (title: string): string => lbMark(title)
  const tree = agentTree({
    roots: [
      treeNode(AK.s1, 'active', {
        kind: 'session', label: 'Session Tue 10:55 · 9d0eb37a', usage: '1.2M', usageAgents: '434.6K', duration: '1 h 05 min', ...T_S1,
        lowerBound: true, lowerBoundText: '⚠ lower bound — 1 of 30 replies unfinished',
        children: [
          treeNode(AK.a1, 'running', { lowerBound: true, lowerBoundText: why }),
          treeNode(AK.a2, 'done', { label: 'Plan · opus-5 · b1c2' }),
          // A flag without its reason is no mark: nobody could ask what it means.
          treeNode(AK.a3, 'failed', { label: 'general-purpose · sonnet-5 · c3d4', lowerBound: true, lowerBoundText: null }),
        ],
      }),
    ],
    runningNow: [runningItem({ lowerBound: true, lowerBoundText: why })],
  })
  const h = agentsHtml(a, { agents: tree, ui: agentUi({ agentsExpanded: [AK.s1] }) })
  const tp = treePart(h)
  // The running agent's tree row: the ⚠ inside the usage figure's own unbreakable span, the first
  // part of the figures' line (1.6 N6), which always stays on it.
  assert.ok(tp.indexOf('<span class="ag-fig" id="agf-' + AK.a1 + '"><span class="ag-fp">' + fig('12.3K' + mark(why)) + '</span><span class="ag-fp">' + SEP
    + clockFig(AG_NOW - 42_000, '42 s', '11:59') + '</span></span>') >= 0, tp)
  // A session's is its own transcript's: on its own figure.
  assert.ok(tp.indexOf(fig('own 1.2M' + mark('⚠ lower bound — 1 of 30 replies unfinished'))) >= 0, tp)
  // The done agent is no lower bound, the failed one has no reason: neither is marked.
  assert.equal(tp.split('⚠</span>').length - 1, 2, tp)
  // The running list's row, marked as its tree row is.
  const now = h.slice(0, h.indexOf('<div class="agtree"'))
  assert.ok(now.indexOf(fig('12.3K' + mark(why))) >= 0, now)
  assert.equal(now.split('⚠</span>').length - 1, 1, now)
  // Still no line under the tree.
  assert.ok(h.endsWith('</ul></div>'), h.slice(-120))
  // Escaped like everything else: a reason is the view model's text, not markup.
  const odd = agentsHtml(a, { agents: agentTree({ runningNow: [runningItem({ lowerBound: true, lowerBoundText: '"><b>x' })] }) })
  assert.ok(odd.indexOf('title="&quot;&gt;&lt;b&gt;x"') >= 0, odd)
  // The alternative, the page's one line turned off: the same tree marks nothing.
  assert.equal(agentsHtml(agentCtx([], unmarkedScript()), { agents: tree, ui: agentUi({ agentsExpanded: [AK.s1] }) }).indexOf('⚠'), -1)
})

// 1.7 D-A: 1.6 D10 wrote the ⚠ as an image named "lower bound" by its aria-label, and Chrome sets a
// name taken from an attribute apart with a space of its own — "12.3K lower bound , since 11:59" (1.6
// P10c). The ⚠ is hidden now, and the words are text of the line, at no size, read where they stand.
test('every ⚠ of a lower bound is hidden from a screen reader and followed by its words in the line, at no size — in English and in German (1.7 D-A)', () => {
  const bundle = JSON.parse(readFileSync(join(__dirname, '..', 'l10n', 'bundle.l10n.de.json'), 'utf8')) as Record<string, string>
  const cost = 'not every agent has a price: the sum is a lower bound'
  assert.equal(bundle['lower bound'], 'Untergrenze')
  assert.equal(typeof bundle[cost], 'string')
  assert.equal(DICT['lower bound'], 'lower bound')
  const why = '⚠ lower bound — 2 of 41 replies unfinished'
  // Every place the page marks a lower bound: a session's own figure and an agent's usage on the
  // tree, the running list's row, the 7-day block's cost of all agents.
  const tree = agentTree({
    roots: [
      treeNode(AK.s1, 'active', {
        kind: 'session', label: 'Session Tue 10:55 · 9d0eb37a', usage: '1.2M', usageAgents: '434.6K', duration: '1 h 05 min', ...T_S1,
        lowerBound: true, lowerBoundText: '⚠ lower bound — 1 of 30 replies unfinished',
        children: [treeNode(AK.a1, 'running', { lowerBound: true, lowerBoundText: why }), treeNode(AK.a2, 'done', { label: 'Plan · opus-5 · b1c2' })],
      }),
    ],
    runningNow: [runningItem({ lowerBound: true, lowerBoundText: why })],
    week: weekOf(),
  })
  const ui = agentUi({ agentsExpanded: [AK.s1], agentsWeekOpen: true })
  const german = between(germanPage({ 'lower bound': bundle['lower bound'], [cost]: bundle[cost] }), /<script nonce="[A-Za-z0-9]+">/, '</script>')
  for (const [script, words] of [[SCRIPT, 'lower bound'], [german, 'Untergrenze']] as const) {
    const h = agentsHtml(agentCtx([], script), { agents: tree, ui })
    const marks = [...h.matchAll(/<span class="ag-lb"([^>]*)>⚠<\/span>/g)]
    assert.equal(marks.length, 4, h)
    assert.equal(h.split('class="ag-lb"').length - 1, marks.length, h)
    // No image any more: nothing names the ⚠ — the words do, where they stand.
    assert.equal(/<[^>]*class="ag-lb"[^>]*role=/.test(h), false, h)
    assert.equal(/aria-label="(lower bound|Untergrenze)"/.test(h), false, h)
    for (const m of marks) {
      assert.match(m[1], /^ aria-hidden="true" title="[^"<>]+"$/, m[0])
      const after = h.slice((m.index as number) + m[0].length)
      assert.ok(after.startsWith('<span class="ag-lbw">' + words + '</span>'), after.slice(0, 80))
    }
    assert.equal(h.split('class="ag-lbw"').length - 1, marks.length, h)
    // The title keeps the reason for the mouse, in the page's language for the cost.
    assert.ok(h.indexOf('aria-hidden="true" title="' + (script === SCRIPT ? cost : bundle[cost]) + '">⚠</span>') >= 0, h)
    assert.ok(h.indexOf('aria-hidden="true" title="' + why + '">⚠</span>') >= 0, h)
  }
  // At no size wherever it stands — a figures' line, a cell of the 7-day block — the technique of a
  // part taken off a figures' line (1.6 P10c); the ⚠ keeps its forced-colours rule.
  assert.match(STYLE, /\n\.ag-fig \.ag-lbw, \.ag-week \.ag-lbw \{ font-size: 0; \}\n/)
  assert.match(STYLE, /\n\.ag-fig \.ag-gone \{ font-size: 0; \}\n/)
  assert.match(STYLE, /\n {2}\.ag-st::before, \.ag-lb \{ color: CanvasText; \}\n/)
  // The words are written in two places only: this mark, and the quota card's partial line — the quota
  // and Tokens sections' own ⚠ marks, which D-A leaves as they were.
  assert.equal(SOURCE.split("tr('lower bound')").length - 1, 2, 'the words of a lower bound are written in one more place')
})

test('a running agent that is not waiting says how long it has been silent, from three minutes on, by the page clock', () => {
  const a = agentCtx()
  // 1.6 N6: a part of the figures' line of its own, its dot inside it; N9: the ticking minutes for
  // the eye, "silent since 11:59" — the view model's lastClock — for a screen reader.
  const span = (ts: number, due: string | null): string => '<span class="ag-fp ag-silent" data-live="silent" data-ts="' + ts + '"'
    + (due === null ? ' hidden' : '') + '>' + SEP + '<span aria-hidden="true"><span class="nobr">silent for <span class="ag-for">'
    + (due ?? '') + '</span></span></span><span class="sr">silent since 11:59</span></span>'
  const at = (lastTs: number, over: Record<string, unknown> = {}) => agentTree({
    roots: [treeNode(AK.s1, 'active', {
      kind: 'session', label: 'Session Tue 10:55 · 9d0eb37a', usage: '1.2M', usageAgents: '434.6K', duration: '1 h 05 min', ...T_S1,
      children: [treeNode(AK.a1, 'running', { lastTs, silence: true, ...over })],
    })],
    runningNow: [runningItem({ lastTs, silence: true, ...over })],
  })
  const open = agentUi({ agentsExpanded: [AK.s1] })
  // Written for the node the view model says may be silent — hidden until it is due, then shown:
  // 2:59 is not yet three minutes, 3:00 is. After the clock, before any tally.
  const early = agentsHtml(a, { agents: at(AG_NOW - 179_000), ui: open })
  assert.ok(treePart(early).indexOf(span(AG_NOW - 179_000, null) + '</span>') >= 0, early)
  const due = agentsHtml(a, { agents: at(AG_NOW - 180_000), ui: open })
  assert.ok(treePart(due).indexOf(clockFig(AG_NOW - 42_000, '42 s', '11:59') + '</span>'
    + span(AG_NOW - 180_000, '3 min') + '</span>') >= 0, due)
  // In the running list too, after its figures.
  const list = due.slice(0, due.indexOf('<div class="agtree"'))
  assert.ok(list.indexOf(runFig(AG_NOW - 42_000, '42 s', '11:59') + '</span>' + span(AG_NOW - 180_000, '3 min') + '</span>') >= 0, list)
  // Minutes only, then hours and minutes.
  assert.ok(agentsHtml(a, { agents: at(AG_NOW - 65 * 60_000 - 30_000), ui: open }).indexOf('<span class="ag-for">1 h 05 min</span>') >= 0)
  // Without the view model's clock time there are no static words: the minutes stay readable.
  const mute = agentsHtml(a, { agents: at(AG_NOW - 180_000, { lastClock: null }), ui: open })
  assert.ok(treePart(mute).indexOf('<span class="ag-fp ag-silent" data-live="silent" data-ts="' + (AG_NOW - 180_000) + '">' + SEP
    + '<span class="nobr">silent for <span class="ag-for">3 min</span></span></span>') >= 0, mute)
  // A node the view model does not call silent — waiting on an agent below it, a launch, a finished
  // one — gets no such span, whatever its clock says; nor does a flag that is not `true`.
  for (const silence of [false, undefined, 'true', 1]) {
    assert.equal(agentsHtml(a, { agents: at(AG_NOW - 9 * 60_000, { silence }), ui: open }).indexOf('data-live="silent"'), -1, String(silence))
  }
  // No colour of its own: the rule set gives the silence none.
  assert.equal(/\.ag-silent\s*\{/.test(STYLE), false)
  assert.equal(DICT['silent for {0}'], 'silent for {0}')
  assert.equal(DICT['silent since {0}'], 'silent since {0}')
})

test('the agent hook\'s marker stands right after the usage on the row and in the running list, in the figures\' tone, escaped (1.6 O4)', () => {
  const a = agentCtx()
  const mark = (w: string): string => '<span class="nobr ag-hook">' + w + '</span>'
  const tree = (wait: unknown, sWait: unknown = null) => agentTree({
    roots: [treeNode(AK.s1, 'active', {
      kind: 'session', label: 'Session Tue 10:55 · 9d0eb37a', usage: '1.2M', usageAgents: '434.6K', duration: '1 h 05 min', startClock: '10:55',
      hookWait: sWait, ...T_S1,
      children: [treeNode(AK.a1, 'running', { hookWait: wait, silence: false })],
    })],
    runningNow: [runningItem({ hookWait: wait, silence: false })],
  })
  const open = agentUi({ agentsExpanded: [AK.s1] })
  const h = agentsHtml(a, { agents: tree('waiting for approval'), ui: open })
  // The tree's row: the usage, the marker, then the clock.
  const row = '<span class="ag-fp"><span class="nobr">12.3K</span></span><span class="ag-fp">' + SEP + mark('waiting for approval')
    + '</span><span class="ag-fp">' + SEP + clockFig(AG_NOW - 42_000, '42 s', '11:59') + '</span>'
  assert.ok(treePart(h).indexOf(row) >= 0, treePart(h))
  // The running list's row: the usage, the marker, then "running for".
  const list = h.slice(0, h.indexOf('<div class="agtree"'))
  assert.ok(list.indexOf(figs(fig('12.3K'), mark('waiting for approval'), runFig(AG_NOW - 42_000, '42 s', '11:59'))) >= 0, list)
  // A session's own wait: after its two figures, before its tally and its span.
  const s = agentsHtml(a, { agents: tree(null, 'waiting for input'), ui: open })
  assert.ok(treePart(s).indexOf('<span class="ag-fp">' + SEP + fig('agents 434.6K') + '</span><span class="ag-fp">' + SEP + mark('waiting for input')
    + '</span>' + tallyThen(T_S1, S1_SPAN)) >= 0, treePart(s))
  // Nothing without one — null, empty, not a string —, and the view model's words escaped.
  for (const wait of [null, undefined, '', 1, true]) {
    assert.equal(agentsHtml(a, { agents: tree(wait), ui: open }).indexOf('ag-hook'), -1, String(wait))
  }
  const odd = agentsHtml(a, { agents: tree('"><b>x'), ui: open })
  assert.ok(odd.indexOf(mark('&quot;&gt;&lt;b&gt;x')) >= 0, odd)
  assert.equal(odd.indexOf('<b>x'), -1)
  // No colour and no rule of its own: a marker, not an alarm — only the rule that cuts its words
  // where a line has no room for all of them (fitAgentFigures), which sets no colour either.
  assert.equal(/\.ag-hook\s*[{,]/.test(STYLE), false)
  const cutRule = STYLE.slice(STYLE.indexOf('.ag-fig .ag-hook-cut {'), STYLE.indexOf('}', STYLE.indexOf('.ag-fig .ag-hook-cut {')))
  assert.match(cutRule, /display: inline-block; overflow: hidden; vertical-align: top;/)
  assert.equal(/color|background|font-weight|font-style/.test(cutRule), false, cutRule)
})

test('a figures line too narrow for the agent hook\'s marker takes the parts behind it off first, then cuts its words — or takes it off with too little room (1.6 O4)', () => {
  const a = agentCtx()
  const doc = (a.c as Record<string, unknown>).document as Record<string, unknown>
  // A part holding the marker: its words start at `left` (after the dot), the part ends at `right`.
  const hookPart = (left: number, right: number) => {
    const part = fakePart(right)
    const cls = new Set<string>(['nobr', 'ag-hook'])
    const el = {
      style: { maxWidth: '' }, getBoundingClientRect: () => ({ left, right }),
      classList: { contains: (c: string) => cls.has(c), add: (c: string) => { cls.add(c) }, remove: (c: string) => { cls.delete(c) } }, cls,
    }
    return Object.assign(part, { querySelector: (q: string) => (q === '.ag-hook' ? el : null), hook: el })
  }
  const lineOf = (parts: Array<ReturnType<typeof fakePart>>, clientWidth: number, scrollWidth: number) => {
    const cls = new Set<string>()
    const hooks = parts.map((p) => (p as { hook?: { cls: Set<string> } }).hook).filter(Boolean) as Array<{ cls: Set<string> }>
    return {
      parts, clientWidth, scrollWidth, children: parts, cls,
      getBoundingClientRect: () => ({ left: 0, right: clientWidth }),
      classList: { contains: (c: string) => cls.has(c), add: (c: string) => { cls.add(c) }, remove: (c: string) => { cls.delete(c) } },
      querySelectorAll: (q: string) => (q === '.ag-gone' ? parts.filter((p) => p.classList.has.has('ag-gone'))
        : q === '.ag-hook-cut' ? hooks.filter((h) => h.cls.has('ag-hook-cut')) : []),
    }
  }
  // 120 px: room for the ellipsis leaves 104.6 px; the marker's words start at 58 px — 46.6 px of
  // room, more than AGENT_HOOK_ROOM_EM (4 × 11 px): the clock goes, the marker stays, cut at 46 px.
  const wide = hookPart(58, 160)
  const cut = lineOf([fakePart(50), wide, fakePart(220)], 120, 220)
  // 100 px: 26.6 px of room is less than that — the marker goes whole, the usage stays.
  const tight = hookPart(58, 160)
  const off = lineOf([fakePart(50), tight, fakePart(220)], 100, 220)
  // Room for the whole marker, not for the clock behind it: the marker is whole, not cut.
  const whole = hookPart(58, 100)
  const fitsHook = lineOf([fakePart(50), whole, fakePart(220)], 130, 220)
  doc.querySelectorAll = (q: string) => (q === '.ag-fig' ? [cut, off, fitsHook] : [])
  nodeVm.runInContext('fitAgentFigures()', a.c)
  const gone = (l: { parts: Array<ReturnType<typeof fakePart>> }): boolean[] => l.parts.map((p) => p.classList.has.has('ag-gone'))
  assert.equal(nodeVm.runInContext('AGENT_HOOK_ROOM_EM', a.c), 4)
  assert.deepEqual([gone(cut), cut.cls.has('ag-cut'), wide.hook.cls.has('ag-hook-cut'), wide.hook.style.maxWidth], [[false, false, true], true, true, '46px'])
  assert.deepEqual([gone(off), off.cls.has('ag-cut'), tight.hook.cls.has('ag-hook-cut'), tight.hook.style.maxWidth], [[false, true, true], true, false, ''])
  assert.deepEqual([gone(fitsHook), whole.hook.cls.has('ag-hook-cut')], [[false, false, true], false])
  // Fitted again with room for everything, the cut is undone.
  cut.clientWidth = 300
  cut.scrollWidth = 220
  nodeVm.runInContext('fitAgentFigures()', a.c)
  assert.deepEqual([gone(cut), cut.cls.has('ag-cut'), wide.hook.cls.has('ag-hook-cut'), wide.hook.style.maxWidth], [[false, false, false], false, false, ''])
})

test('the page clock shows a silence the second it reaches three minutes, and counts it in minutes', () => {
  const last = AG_NOW - 170_000
  const min = { textContent: '' }
  const el = { dataset: { ts: String(last) }, hidden: true, querySelector: (q: string) => (q === '.ag-for' ? min : null) }
  const a = agentCtx([], SCRIPT, [el])
  // The one timer, started with the first payload.
  a.fire('window:message', { origin: '', data: { type: 'data', payload: model({ sections: ['agents'], agents: agentTree(), ui: agentUi() }) } })
  assert.equal(a.intervals.length, 1)
  const tick = (t: number): void => { a.clock.t = t; a.intervals[0].fn() }
  tick(last + 179_999)
  assert.deepEqual([el.hidden, min.textContent], [true, ''])
  tick(last + 180_000)
  assert.deepEqual([el.hidden, min.textContent], [false, '3 min'])
  tick(last + 4 * 60_000 + 59_000)
  assert.equal(min.textContent, '4 min')
  tick(last + 65 * 60_000)
  assert.equal(min.textContent, '1 h 05 min')
  // A new line — the push that moves the stamp — hides it again at the next tick.
  el.dataset.ts = String(a.clock.t - 1000)
  tick(a.clock.t + 1000)
  assert.equal(el.hidden, true)
  // The threshold is src/agentTree.ts's, written into the page.
  assert.equal(nodeVm.runInContext('AGENT_SILENT_MS', ctx), SILENT_AFTER_MS)
})

// 1.6 P3a (§3 D3): pinned "a node whose agents the tree had to cut all away has nothing to open".
// The cut is gone, and a closed node's payload carries no child at all: whether it has any is its
// own `hasChildren`, so it keeps its toggle; a node with nothing to open — a run whose agents no
// transcript shows — is the leaf, and its tally says what is below it all the same.
test('a closed node the payload carries no child of keeps its toggle and its tally; a node with no child is a leaf', () => {
  const a = agentCtx()
  const three = tallyOf({ done: 2, stopped: 1 })
  const closed = agentTree({
    roots: [treeNode(AK.s1, 'active', {
      kind: 'session', label: 'Session Tue 10:55 · 9d0eb37a', startClock: '10:55', ...three, hasChildren: true, childrenTotal: 2, children: [],
    })],
  })
  const h = treePart(agentsHtml(a, { agents: closed }))
  assert.ok(h.indexOf(itemTag(AK.s1, { kind: 'session', tab: true, size: 1, pos: 1, expanded: false,
    label: 'Session Tue 10:55 · 9d0eb37a, active session, derived, 3 started, 2 done, 1 stopped' })
    + '<div class="ag-line">' + foldOf(AK.s1)) >= 0, h)
  assert.ok(h.indexOf(slbl('Session Tue 10:55 · 9d0eb37a', 'Session', 'Tue 10:55', '9d0eb37a') + '<span class="ag-fig" id="agf-' + AK.s1 + '">') >= 0, h)
  // 1.6 P7b: its tally before its span, the part the fit takes off first.
  assert.ok(h.indexOf(tallyThen(three, fig('<span title="span from the first to the last line">40.0 s</span>'))) >= 0, h)
  assert.equal(h.indexOf('<ul role="group">'), -1, 'a closed node wrote a group')
  // A run of journal-only agents: agents below it, no child to open. A leaf, whatever is stored.
  const run = agentTree({
    roots: [treeNode(AK.wf, 'unknown', { kind: 'workflow', label: 'Workflow run Tue 11:40 · cfe7718d', startClock: '11:40', ...three, children: [] })],
  })
  for (const ui of [agentUi(), agentUi({ agentsExpanded: [AK.wf] })]) {
    const leaf = treePart(agentsHtml(a, { agents: run, ui }))
    assert.equal(leaf.indexOf('ag-fold'), -1, leaf)
    assert.equal(leaf.indexOf('aria-expanded'), -1, leaf)
    assert.ok(leaf.indexOf('<div class="ag-line"><span class="ag-pad"></span>' + rowOf(AK.wf, false, 'unknown')) >= 0, leaf)
    assert.ok(leaf.indexOf(tallyThen(three, fig('40.0 s'))) >= 0, leaf)
  }
  // An agent's tally stands while its children are not on screen: closed, or opened with none
  // of them sent (the payload's cap); with its children drawn it has none.
  const agent = (children: unknown[], more = 0): Record<string, unknown> => agentTree({ roots: [treeNode(AK.a3, 'failed', {
    label: 'general-purpose · sonnet-5 · c3d4', ...T_A3, hasChildren: true, childrenTotal: 1, childrenMore: more, children,
  })] })
  assert.ok(treePart(agentsHtml(a, { agents: agent([]) })).indexOf(tallyEnd(T_A3)) >= 0)
  assert.ok(treePart(agentsHtml(a, { agents: agent([], 1), ui: agentUi({ agentsExpanded: [AK.a3] }) })).indexOf(tallyEnd(T_A3)) >= 0)
  const drawn = treePart(agentsHtml(a, { agents: agent([treeNode(AK.l1, 'unknown', { kind: 'pending' })]), ui: agentUi({ agentsExpanded: [AK.a3] }) }))
  assert.equal(/class="ag-t[" ]/.test(drawn), false, drawn)
})

test('an open node with more children than it shows says how many, and offers the next fifty while it can', () => {
  // 1.6 D3: after the last child drawn, one line: "50 more · 377 not shown" — the next step and
  // everything not shown — or "12 more" when the next step shows the rest; a button posting
  // `agentMore` for the node, while another step can be taken; the count alone once it took its
  // last one, or when the payload had no room for any of its children.
  const a = agentCtx()
  const kids = Array.from({ length: 3 }, (_, i) => treeNode(`a:kid${i}`, 'done', { label: `Explore · opus-5 · k${i}` }))
  const run = (more: number, children = kids): Record<string, unknown> => agentTree({
    roots: [treeNode(AK.wf, 'done', {
      kind: 'workflow', label: 'Workflow run Tue 11:40 · cfe7718d', hasChildren: true, childrenTotal: children.length + more, childrenMore: more, children,
    })],
  })
  const open = (over: Record<string, unknown> = {}): Record<string, unknown> => agentUi({ agentsExpanded: [AK.wf], ...over })
  // 1.6 L1 (pinned and changed: the line was a button in an item of its own): the line is an item of
  // the node's group — a level below the node, the next place after its shown children, of as many
  // as the node has — reached with the arrow keys, its words the mouse's target while a step can be
  // taken.
  const line = (words: string, control: boolean, more: number, shown = 3): string => '<li role="treeitem" class="ag-k-more" data-more="'
    + AK.wf + '" tabindex="-1" aria-level="2" aria-setsize="' + (shown + more) + '" aria-posinset="' + (shown + 1) + '"><div class="ag-line">'
    + '<span class="ag-pad"></span>'
    + (control ? '<span class="ag-more" data-act="agentMore" data-key="' + AK.wf + '">' + words + '</span>'
      : '<span class="ag-more">' + words + '</span>')
    + '</div></li>'
  const html = (agents: Record<string, unknown>, ui = open()): string => treePart(agentsHtml(a, { agents, ui }))
  // The line comes after the last child, inside the node's group.
  const many = html(run(377))
  assert.ok(many.indexOf('data-key="a:kid2"') < many.indexOf('class="ag-k-more"'), many)
  assert.ok(many.indexOf(line('50 more · 377 not shown', true, 377) + '</ul>') >= 0, many)
  assert.ok(html(run(1234)).indexOf(line('50 more · 1,234 not shown', true, 1234)) >= 0)
  assert.ok(html(run(50)).indexOf(line('50 more', true, 50)) >= 0)
  assert.ok(html(run(12)).indexOf(line('12 more', true, 12)) >= 0)
  // Nothing more, no line; a closed node, none either — its children are not on the page at all.
  assert.equal(html(run(0)).indexOf('ag-k-more'), -1)
  assert.equal(html(run(377), agentUi()).indexOf('ag-k-more'), -1)
  // The last step taken: the count alone, no control. One step before it, the control.
  assert.ok(html(run(377), open({ agentsMore: [{ key: AK.wf, pages: 10 }] })).indexOf(line('377 not shown', false, 377)) >= 0)
  assert.ok(html(run(377), open({ agentsMore: [{ key: AK.wf, pages: 9 }] })).indexOf(line('50 more · 377 not shown', true, 377)) >= 0)
  // Open, and none of its children sent — the page had no room: the count alone, the first place.
  assert.ok(html(run(380, [])).indexOf('<ul role="group">' + line('380 not shown', false, 380, 0) + '</ul>') >= 0)
  // The node's children say they are three of 380 as well: the ones not shown are counted.
  assert.ok(many.indexOf(' data-key="a:kid0" tabindex="-1" aria-level="2" aria-setsize="380" aria-posinset="1"') >= 0, many)
  assert.ok(many.indexOf(' data-key="a:kid2" tabindex="-1" aria-level="2" aria-setsize="380" aria-posinset="3"') >= 0, many)
  // A payload count that is not one is no line.
  for (const bad of [-1, 0.2, Number.NaN, '377', null]) {
    const tree = run(0)
    ;((tree.roots as Array<Record<string, unknown>>)[0]).childrenMore = bad
    assert.equal(html(tree).indexOf('ag-k-more'), -1, String(bad))
  }
  // The steps are src/agentTree.ts's, written into the page.
  assert.deepEqual(JSON.parse(String(nodeVm.runInContext('JSON.stringify(AGENT_PAGING)', ctx))),
    { groupChildren: MAX_GROUP_CHILDREN, morePages: MAX_MORE_PAGES })
})

// 1.6 P3a (§3 D3): pinned "Tree cut at {0} nodes." under the tree; the cut is gone, and what a node
// leaves out is said on the node (see the test above).
test('an empty tree says so, and a tree says what it left out', () => {
  // A payload without the tree — an older build — and an empty one.
  assert.equal(render('sAgents()'), '<p class="empty">No Claude Code session in the last 7 days.</p>')
  const a = agentCtx()
  assert.equal(agentsHtml(a, { agents: agentTree({ roots: [] }) }),
    '<p class="empty">No Claude Code session in the last 7 days.</p>')
  // The view model's own note, in its words, wins over the page's.
  assert.equal(agentsHtml(a, { agents: agentTree({ roots: [], note: 'Nothing <here>.' }) }),
    '<p class="empty">Nothing &lt;here&gt;.</p>')
  const plain = agentsHtml(a)
  assert.equal(plain.indexOf('<p class="empty">'), -1, plain)
  const left = agentsHtml(a, {
    agents: agentTree({ omittedRoots: 3, note: 'The selected node is no longer in the tree.' }),
  })
  assert.ok(left.indexOf('</ul></div><p class="empty">3 older session(s) not shown.</p>'
    + '<p class="empty">The selected node is no longer in the tree.</p>') >= 0, left)
  // An older payload's cut flag says nothing any more.
  assert.equal(agentsHtml(a, { agents: agentTree({ truncated: true }) }).indexOf('Tree cut'), -1)
  assert.equal(SOURCE.indexOf('Tree cut'), -1)
})

test('a hostile tree renders inert: no element and no handler the renderer did not write', () => {
  const EVIL = '<script>alert(1)</script><img src=x onerror=alert(2)>" onmouseover="alert(3)\' `x` '
  const a = agentCtx()
  // Every string of the tree poisoned — labels, sub texts, keys, the sentences, even the state
  // and the kind, and every string of the running list with them: label, context, usage, key,
  // kind — and the selection and the opened nodes pointing at poisoned keys.
  const agents = poisoned(agentTree({
    selected: detailsOf(), note: 'n', omittedRoots: 2, runningMore: 3,
    runningNow: [runningItem(), runningItem({ key: AK.l1, kind: 'pending', usage: '–', waiting: true })],
  }), EVIL)
  const h = agentsHtml(a, {
    agents, ui: agentUi({ agentSelected: EVIL + AK.a1, agentsExpanded: [EVIL + AK.s1, EVIL + AK.wf] }),
  })
  // Everything was drawn: the poison did not stop the renderer, it is only text.
  assert.ok(h.indexOf('<div class="ag-details"') >= 0, h)
  assert.ok(h.indexOf('<div class="ag-now">') === 0, h)
  assert.equal(/<script/i.test(h), false, h)
  for (const tag of tagsOf(h)) {
    assert.ok(['div', 'ul', 'li', 'button', 'span', 'p', 'dl', 'dt', 'dd'].includes(tag.name), tag.name)
    for (const name of tag.attrs) assert.equal(/^on/.test(name), false, name + ' on <' + tag.name + '>')
  }
  // Every "<" and ">" on the page belongs to a tag the renderer wrote.
  const text = h.replace(TAG_RE, '').replace(/<\/[a-z]+>/g, '')
  assert.equal(/[<>]/.test(text), false, text)
  // The poison is on the page as text — in the labels, the notes and the details alike.
  const shown = '&lt;script&gt;alert(1)&lt;/script&gt;&lt;img src=x onerror=alert(2)&gt;&quot; '
    + 'onmouseover=&quot;alert(3)&#39; `x` '
  // 1.6 P7b: a name from its type on — every node here is an agent's to the page: a poisoned kind
  // is none it knows.
  for (const where of ['<span class="ag-np ag-type">' + shown,
    '<span class="ag-label" title="' + shown, '<p class="empty">' + shown + 'n</p>',
    '<div class="name">' + shown, '<dt>' + shown + 'Type</dt>',
    // The running list's context and usage, as text too.
    '<span class="meta ag-ctx"><span>' + shown + 'Session 9d0eb37a</span>', '<span class="nobr">' + shown + '12.3K</span>']) {
    assert.ok(h.indexOf(where) >= 0, where + ' missing from ' + h)
  }
  // A key survives the attribute exactly: the browser hands the host back what it was given.
  const keys = [...h.matchAll(/data-key="([^"]*)"/g)].map((m) => unescapeHtml(m[1]))
  assert.ok(keys.includes(EVIL + AK.a1), keys.join('\n'))
  // The poisoned selection is still the pressed row — its tree row, where its details stand
  // (1.6 N2: the one row they are under) — and the poisoned opened nodes still open: the agent
  // under them is on screen, the launch under the failed agent, which nobody opened, is only in
  // the running list.
  const pressedKeys = [...h.matchAll(/data-key="([^"]*)"(?:( data-list="now") aria-pressed| data-pressed)="true"/g)]
    .map((m) => unescapeHtml(m[1]) + (m[2] ? '@now' : '@tree'))
  // 1.6 L1: a key with a space in it names no description — the reference would split in two —
  // and the name of its item is escaped like every other attribute.
  assert.equal(h.indexOf('aria-describedby="agf-' + '&lt;script'), -1, h)
  assert.ok(treePart(h).indexOf(' aria-label="' + shown) >= 0, h)
  assert.deepEqual(pressedKeys, [EVIL + AK.a1 + '@tree'])
  assert.ok(treePart(h).indexOf('<div class="ag-details" data-ind="2" role="region"') >= 0, h)
  const treeKeys = [...treePart(h).matchAll(/data-key="([^"]*)"/g)].map((m) => unescapeHtml(m[1]))
  assert.ok(treeKeys.includes(EVIL + AK.a1), treeKeys.join('\n'))
  assert.equal(treeKeys.includes(EVIL + AK.l1), false)
  // An unknown state and kind reach no class, in the tree or in the running list.
  assert.equal(/class="[^"]*(?:script|alert)/.test(h), false, h)
  // 1.7 F4 (pinned and changed): an unknown kind is an agent's row, and the running list's row wears the running colour.
  assert.ok(h.indexOf('<li class="ag-k-agent"><button class="ag-row ag-c-running" data-act="agentSelect"') >= 0, h)
})

test('one timer, started with the first payload, keeps the live spans current without a render', () => {
  const spans: Array<{ dataset: Record<string, string>; textContent: string }> = [
    { dataset: { ts: String(AG_NOW - 42_000) }, textContent: '42 s' },
    { dataset: { ts: 'not a time' }, textContent: 'kept' },
  ]
  const a = agentCtx(spans)
  // Nothing ticks on a page that has not been given anything to show.
  assert.equal(a.intervals.length, 0)
  const payload = model({ sections: ['quota', 'agents'], agents: agentTree(), ui: agentUi() })
  a.fire('window:message', { origin: '', data: { type: 'data', payload } })
  assert.deepEqual(a.intervals.map((x) => x.ms), [1000])
  // The page is drawn from the clock's own time …
  const html = a.root.innerHTML
  assert.ok(html.indexOf('<span data-live="since" data-ts="' + (AG_NOW - 42_000) + '">42 s</span>') >= 0, html)
  // … and a tick rewrites the text of the spans, and nothing else.
  const tick = (t: number): string => { a.clock.t = t; a.intervals[0].fn(); return spans[0].textContent }
  assert.equal(tick(AG_NOW + 1_000), '43 s')
  assert.equal(spans[1].textContent, 'kept')
  assert.equal(tick(AG_NOW + 17 * 60_000 + 18_000), '18 min 00 s')
  assert.equal(tick(AG_NOW - 42_000 + 3_723_000), '1 h 02 min')
  assert.equal(tick(AG_NOW - 42_000 + 2 * 86_400_000 + 3_723_000), '2 d 1 h')
  // In units, never as a clock reading: "12:05" beside a start time reads as a time of day.
  const at = (s: number): string => tick(AG_NOW - 42_000 + s * 1000)
  assert.deepEqual([59, 60, 3599, 3600, 86_399, 86_400].map(at),
    ['59 s', '1 min 00 s', '59 min 59 s', '1 h 00 min', '23 h 59 min', '1 d 0 h'])
  // Two clocks a second apart never make a negative time.
  assert.equal(tick(AG_NOW - 43_000), '0 s')
  assert.equal(a.root.innerHTML, html, 'a tick re-rendered the page')
  // 1.10 P5 (pinned and changed: the acknowledgement names the sections the page drew — none in this fake document).
  assert.deepEqual(a.posted, [{ type: 'rendered', sections: 2, drawn: [] }], 'a tick posted a message')
  // A second payload, and a push of the section itself, start no second timer.
  a.fire('window:message', { origin: '', data: { type: 'data', payload } })
  a.fire('window:message', {
    origin: '', data: { type: 'section', key: 'agents', payload: { agents: agentTree(), ui: agentUi() } },
  })
  assert.equal(a.intervals.length, 1)
  // A page with no live span on it ticks through nothing.
  spans.length = 0
  assert.doesNotThrow(() => a.intervals[0].fn())
})

test('a click on a toggle or a row posts what the host parses, and a second click closes the row', () => {
  const a = agentCtx()
  // The running agent selected in the tree, every node open: its details stand under its tree
  // row, and its row in the running list is on the page too.
  const pageWith = (selectedIn: string): void => a.fire('window:message', {
    origin: '',
    data: { type: 'data', payload: model({ sections: ['agents'], agents: agentTree({ selected: detailsOf() }),
      ui: openUi({ agentSelected: AK.a1, agentSelectedIn: selectedIn }) }) },
  })
  pageWith('tree')
  a.posted.length = 0
  const button = (act: string, key?: string, list?: string): Record<string, unknown> =>
    ({ tagName: 'BUTTON', dataset: { act, ...(key === undefined ? {} : { key }), ...(list === undefined ? {} : { list }) } })
  const event = (el: Record<string, unknown>, extra: Record<string, unknown> = {}): Record<string, unknown> =>
    ({ target: { closest: () => el }, stopPropagation: () => undefined, preventDefault: () => undefined, ...extra })
  a.fire('document:click', event(button('agentToggle', AK.s1)))
  // 1.6 N2: every selection says which row it came from, so the details open under that one.
  a.fire('document:click', event(button('agentSelect', AK.a2)))
  // The row whose details are open under it closes them again.
  a.fire('document:click', event(button('agentSelect', AK.a1)))
  // A row of the running list is the same message from the list: another running agent opens
  // there, and the selected one's running row — its details stand under its tree row — moves
  // them under itself rather than closing them.
  a.fire('document:click', event(button('agentSelect', AK.l1, 'now')))
  a.fire('document:click', event(button('agentSelect', AK.a1, 'now')))
  // 1.6 D3: the "more" line under an open node asks for its next fifty children.
  a.fire('document:click', event(button('agentMore', AK.wf)))
  // A button without a key is not a message worth sending.
  a.fire('document:click', event(button('agentToggle', '')))
  a.fire('document:click', event(button('agentSelect')))
  a.fire('document:click', event(button('agentSelect', '', 'now')))
  a.fire('document:click', event(button('agentMore', '')))
  // Once the host has moved them under the running row, that row closes them and the tree row
  // takes them back.
  pageWith('now')
  // 1.10 P5 (pinned and changed: the acknowledgement names the sections the page drew — none in this fake document).
  assert.deepEqual(a.posted.pop(), { type: 'rendered', sections: 1, drawn: [] })
  a.fire('document:click', event(button('agentSelect', AK.a1, 'now')))
  a.fire('document:click', event(button('agentSelect', AK.a1)))
  const expected = [
    { type: 'agentToggle', key: AK.s1 },
    { type: 'agentSelect', key: AK.a2, from: 'tree' },
    { type: 'agentSelect', key: null },
    { type: 'agentSelect', key: AK.l1, from: 'now' },
    { type: 'agentSelect', key: AK.a1, from: 'now' },
    { type: 'agentMore', key: AK.wf },
    { type: 'agentSelect', key: null },
    { type: 'agentSelect', key: AK.a1, from: 'tree' },
  ]
  assert.deepEqual(a.posted, expected)
  // Every one of them passes the host's allow-list unchanged.
  for (const m of expected) assert.deepEqual(parseWebviewMessage(m), m)
  // Enter and Space on a button are the browser's own click: the keydown fallback leaves both
  // alone, or one key press would open a node and close it again.
  a.fire('document:keydown', event(button('agentToggle', AK.wf), { key: 'Enter' }))
  a.fire('document:keydown', event(button('agentSelect', AK.a2), { key: ' ' }))
  a.fire('document:keydown', event(button('agentSelect', AK.a1, 'now'), { key: 'Enter' }))
  assert.equal(a.posted.length, expected.length)
})

test('Escape in the Agents section closes the details and puts the focus back on their row — after a hover card or a spark tip', () => {
  // 1.6 N2. A page whose details are open under the running agent's tree row, and a section body
  // whose controls the handler looks the row up in: the tree row and, with the same key, the
  // running list's row.
  const a = agentCtx()
  const focused: string[] = []
  const control = (act: string, key: string, name: string, list?: string): Record<string, unknown> =>
    ({ dataset: list === undefined ? { act, key } : { act, key, list }, focus: () => { focused.push(name) } })
  const drawn = [control('agentSelect', AK.a1, 'now-row', 'now'), control('agentToggle', AK.s1, 'toggle'),
    control('agentSelect', AK.a1, 'tree-row'), { dataset: { act: 'cmd', id: 'tokenPace.copyAgentId' }, focus: () => { focused.push('copy') } }]
  // 1.6 L1: in the tree the focus goes to the item — the one of the node, not a "more" line under it.
  const items = [{ dataset: { key: AK.s1 }, focus: () => { focused.push('session-item') } },
    { dataset: { more: AK.a1 }, focus: () => { focused.push('more-item') } },
    { dataset: { key: AK.a1 }, focus: () => { focused.push('tree-item') } }]
  let panel: unknown = { className: 'ag-details' }
  const fold = { open: true }
  const body = { querySelector: (q: string) => (q === '.ag-details' ? panel : null),
    querySelectorAll: (q: string) => (q === '[data-act]' ? drawn : q === '.agtree li[role="treeitem"]' ? items : []) }
  const sec = { querySelector: (q: string) => (q === '[data-body="agents"]' ? body : q === 'details' ? fold : null) }
  const inAgents = { closest: (q: string) => (q === '[data-sec="agents"]' ? sec : null) }
  const elsewhere = { closest: () => null }
  let prevented = 0
  const esc = (target: unknown, key = 'Escape'): void =>
    a.fire('document:keydown', { key, target, preventDefault: () => { prevented++ }, stopPropagation: () => undefined })
  const page = (ui: Record<string, unknown>, over: Record<string, unknown> = {}): void => {
    a.fire('window:message', { origin: '', data: { type: 'data', payload: model({ sections: ['agents'],
      agents: agentTree({ selected: detailsOf(), ...over }), ui }) } })
    a.posted.length = 0
    focused.length = 0
    prevented = 0
  }
  page(openUi({ agentSelected: AK.a1 }))
  // Another key, or an Escape outside the section, is not for the panel.
  esc(inAgents, 'Enter')
  esc(elsewhere)
  assert.deepEqual([a.posted, focused, prevented], [[], [], 0])
  // From anywhere in the section — the Copy ID button inside the panel, say: the details close,
  // and the focus goes to the row they stand under, the tree's — its item, 1.6 L1 (pinned and
  // changed: the row was a button of its own) —, not the running list's.
  esc(inAgents)
  assert.deepEqual(a.posted, [{ type: 'agentSelect', key: null }])
  assert.deepEqual(focused, ['tree-item'])
  assert.equal(prevented, 1)
  // Under the running list's row, it is that row.
  page(agentUi({ agentSelected: AK.a1, agentSelectedIn: 'now' }))
  esc(inAgents)
  assert.deepEqual([a.posted, focused], [[{ type: 'agentSelect', key: null }], ['now-row']])
  // A hover card open — the explanation of a quota card under the pointer — is closed first, by
  // the page's own Escape; only the next Escape closes the details.
  page(openUi({ agentSelected: AK.a1 }))
  const pop = { hidden: true, id: 'pop-1', classList: { add: () => undefined, remove: () => undefined } }
  const card = { hasAttribute: (n: string) => n === 'data-explain', querySelector: (q: string) => (q === ':scope > .pop' ? pop : null) }
  a.fire('document:mouseenter', { target: card })
  assert.equal(pop.hidden, false, 'the hover card did not open')
  esc(inAgents)
  assert.deepEqual([a.posted, focused, pop.hidden], [[], [], true])
  esc(inAgents)
  assert.deepEqual([a.posted, focused], [[{ type: 'agentSelect', key: null }], ['tree-item']])
  // The same for a sparkline's tip.
  page(openUi({ agentSelected: AK.a1 }))
  nodeVm.runInContext('sparkMark = { svg: { querySelector: function () { return null; }, parentNode: null }, g: null, k: 0 };', a.c)
  esc(inAgents)
  assert.deepEqual([a.posted, focused], [[], []])
  assert.equal(nodeVm.runInContext('sparkMark', a.c), null, 'the tip stayed open')
  esc(inAgents)
  assert.deepEqual(a.posted, [{ type: 'agentSelect', key: null }])
  // No panel on the page — nothing selected, a panel not drawn, the section folded away — no message.
  page(openUi(), { selected: null })
  esc(inAgents)
  page(openUi({ agentSelected: AK.a1 }))
  panel = null
  esc(inAgents)
  panel = { className: 'ag-details' }
  fold.open = false
  esc(inAgents)
  assert.deepEqual([a.posted, focused, prevented], [[], [], 0])
  fold.open = true
  // The handler listens in the capture phase: it sees the card before the card's own Escape hides it.
  assert.match(SOURCE, /agentPanelAt\) return;\n  if \(openPop !== null \|\| sparkMark !== null\) return;[\s\S]{0,900}\}, true\);/)
})

// ---------------------------------------------------------------------------
// 1.6 L1: the keyboard of a real tree
// ---------------------------------------------------------------------------

/** The items of a rendered tree that are the stop of the Tab key: a node's key, a "more" line's `more:<key>`. */
function tabStops(h: string): string[] {
  return [...treePart(h).matchAll(/<li role="treeitem" class="[^"]*" data-(key|more)="([^"]*)" tabindex="0"/g)]
    .map((m) => (m[1] === 'more' ? 'more:' : '') + m[2])
}

/** Sets what the page remembers of the keyboard's place in the tree: the item, then the items above it. */
function focusPath(c: nodeVm.Context, path: Array<[string, boolean]>, inTree = false): void {
  nodeVm.runInContext('agentFocusPath = ' + JSON.stringify(path.map(([key, more]) => ({ key, more }))) + '; agentFocusInTree = '
    + inTree + ';', c)
}

test('the tree is one stop of the Tab key: the item the keyboard was last on, else the selected one while its row is drawn, else the first session', () => {
  const a = agentCtx()
  const selected = { agents: agentTree({ selected: detailsOf() }) }
  // Nothing selected, the keyboard never on the tree: the first session, and every other item −1.
  const plain = agentsHtml(a, { ui: openUi() })
  assert.deepEqual(tabStops(plain), [AK.s1])
  assert.equal(treePart(plain).split('<li role="treeitem"').length - 1, 7)
  assert.equal(treePart(plain).split('tabindex="-1"').length - 1, 6, plain)
  // Selected, its row drawn: the selected item. Inside a closed branch: the first session.
  assert.deepEqual(tabStops(agentsHtml(a, { ...selected, ui: openUi({ agentSelected: AK.a1 }) })), [AK.a1])
  assert.deepEqual(tabStops(agentsHtml(a, { ...selected, ui: agentUi({ agentSelected: AK.a1 }) })), [AK.s1])
  // The running list's rows are no items of the tree: they stay buttons, each a stop of its own.
  assert.equal(agentsHtml(a, { ui: openUi() }).slice(0, agentsHtml(a, { ui: openUi() }).indexOf('<div class="agtree"')).indexOf('tabindex'), -1)
  // The keyboard's last item wins over the selection while it is drawn; once it is not, the nearest
  // item above it that is.
  focusPath(a.c, [[AK.a2, false], [AK.wf, false], [AK.s1, false]])
  assert.deepEqual(tabStops(agentsHtml(a, { ...selected, ui: openUi({ agentSelected: AK.a1 }) })), [AK.a2])
  assert.deepEqual(tabStops(agentsHtml(a, { ...selected, ui: agentUi({ agentsExpanded: [AK.s1], agentSelected: AK.a1 }) })), [AK.wf])
  // Nothing of it drawn, the focus elsewhere: the selected item, the first session.
  focusPath(a.c, [['a:/p/gone.jsonl', false]])
  assert.deepEqual(tabStops(agentsHtml(a, { ...selected, ui: openUi({ agentSelected: AK.a1 }) })), [AK.a1])
  // Nothing of it drawn while the focus is in the tree — the push that took the item away: the
  // first session, where restoreFocus puts the focus.
  focusPath(a.c, [['a:/p/gone.jsonl', false]], true)
  assert.deepEqual(tabStops(agentsHtml(a, { ...selected, ui: openUi({ agentSelected: AK.a1 }) })), [AK.s1])
  // A "more" line can be the one.
  const kids = Array.from({ length: 2 }, (_, i) => treeNode(`a:kid${i}`, 'done', { label: `Explore · opus-5 · k${i}` }))
  const paged = agentTree({ roots: [treeNode(AK.wf, 'done', { kind: 'workflow', label: 'Workflow run Tue 11:40 · cfe7718d',
    hasChildren: true, childrenTotal: 60, childrenMore: 58, children: kids })] })
  focusPath(a.c, [[AK.wf, true], [AK.wf, false]])
  assert.deepEqual(tabStops(agentsHtml(a, { agents: paged, ui: agentUi({ agentsExpanded: [AK.wf] }) })), ['more:' + AK.wf])
  // Its node closed: the node.
  assert.deepEqual(tabStops(agentsHtml(a, { agents: paged, ui: agentUi() })), [AK.wf])
  // One stop, whatever the payload: a current item the render does not reach hands it to the first.
  focusPath(a.c, [])
  nodeVm.runInContext('var __current = agentCurrent; agentCurrent = function () { return { key: "a:nowhere", more: false }; };', a.c)
  const lost = agentsHtml(a, { ...selected, ui: openUi({ agentSelected: AK.a1 }) })
  nodeVm.runInContext('agentCurrent = __current;', a.c)
  assert.deepEqual(tabStops(lost), [AK.s1])
  assert.equal(lost.split('<div class="ag-details"').length - 1, 1, lost)
})

test('the Copy ID button of the details is a stop of the Tab key only while its item is the tree\'s current one', () => {
  const a = agentCtx()
  const copy = (h: string): string => { const at = h.indexOf('<button class="ag-copy"'); return h.slice(at, h.indexOf('>', at) + 1) }
  const agents = agentTree({ selected: detailsOf() })
  // The selected item is the current one: its button is reached with Tab from it.
  assert.equal(copy(agentsHtml(a, { agents, ui: openUi({ agentSelected: AK.a1 }) })),
    '<button class="ag-copy" data-act="cmd" data-id="tokenPace.copyAgentId">')
  // The keyboard is on another item: the button is out of the Tab order, the tree one stop of it.
  focusPath(a.c, [[AK.s2, false]])
  assert.equal(copy(agentsHtml(a, { agents, ui: openUi({ agentSelected: AK.a1 }) })),
    '<button class="ag-copy" data-act="cmd" data-id="tokenPace.copyAgentId" tabindex="-1">')
  // Under the running list's row the panel is no part of the tree: a button like the row above it.
  assert.equal(copy(agentsHtml(a, { agents, ui: openUi({ agentSelected: AK.a1, agentSelectedIn: 'now' }) })),
    '<button class="ag-copy" data-act="cmd" data-id="tokenPace.copyAgentId">')
})

test('the tree\'s keys: the arrows, Home and End move the focus, → and ← open and close, Enter and Space select — and focus selects nothing', () => {
  const move = (items: unknown[], i: number, key: string): unknown =>
    JSON.parse(String(nodeVm.runInContext('JSON.stringify(agentKeyMove(' + JSON.stringify(items) + ', ' + i + ', ' + JSON.stringify(key) + ')) || "null"', ctx)))
  const it = (level: number, parent: boolean, open: boolean, more = false): Record<string, unknown> => ({ level, parent, open, more })
  // An open session: its open run with a leaf, a closed agent and a "more" line; a leaf of the
  // session; a second session, closed.
  const items = [it(1, true, true), it(2, true, true), it(3, false, false), it(3, true, false), it(3, false, false, true),
    it(2, false, false), it(1, true, false)]
  // ↓ ↑ Home End: the next, the previous, the first, the last — and no further at either end.
  assert.deepEqual([0, 3, 6].map((i) => move(items, i, 'ArrowDown')), [{ focus: 1 }, { focus: 4 }, { focus: 6 }])
  assert.deepEqual([0, 3, 6].map((i) => move(items, i, 'ArrowUp')), [{ focus: 0 }, { focus: 2 }, { focus: 5 }])
  assert.deepEqual([move(items, 4, 'Home'), move(items, 2, 'End')], [{ focus: 0 }, { focus: 6 }])
  // →: a closed node opens (the focus stays), an open one hands the focus to its first child; a
  // leaf and a "more" line keep it.
  assert.deepEqual([3, 6].map((i) => move(items, i, 'ArrowRight')), [{ act: 'toggle' }, { act: 'toggle' }])
  assert.deepEqual([0, 1].map((i) => move(items, i, 'ArrowRight')), [{ focus: 1 }, { focus: 2 }])
  assert.deepEqual([2, 4, 5].map((i) => move(items, i, 'ArrowRight')), [{ focus: 2 }, { focus: 4 }, { focus: 5 }])
  // An open node whose children the page does not carry has nothing to move to.
  assert.deepEqual(move([it(1, true, true), it(1, false, false)], 0, 'ArrowRight'), { focus: 0 })
  // ←: an open node closes; anything else hands the focus to the item above it — a "more" line to
  // its node —, a root keeps it.
  assert.deepEqual([0, 1].map((i) => move(items, i, 'ArrowLeft')), [{ act: 'toggle' }, { act: 'toggle' }])
  assert.deepEqual([2, 3, 4, 5].map((i) => move(items, i, 'ArrowLeft')), [{ focus: 1 }, { focus: 1 }, { focus: 1 }, { focus: 0 }])
  assert.deepEqual(move(items, 6, 'ArrowLeft'), { focus: 6 })
  // Enter and Space: a node selects (or clears) — the "more" line takes the next step.
  assert.deepEqual([move(items, 2, 'Enter'), move(items, 0, ' '), move(items, 4, 'Enter'), move(items, 4, ' ')],
    [{ act: 'select' }, { act: 'select' }, { act: 'more' }, { act: 'more' }])
  // Any other key is not the tree's; an item that is not there moves nothing.
  for (const key of ['a', 'Tab', 'Escape', 'PageDown', '*']) assert.equal(move(items, 2, key), null, key)
  assert.equal(move(items, 9, 'ArrowDown'), null)
})

/**
 * A fake tree for the keyboard tests: items with the attributes agentNode writes, each with its
 * three targets of the mouse, and what focus() and setAttribute() do to them recorded.
 */
function fakeTree(spec: Array<{ key?: string; more?: string; level: number; expanded?: boolean; control?: boolean; row?: string }>, focused: string[]) {
  const tree: Record<string, unknown> = {}
  const items = spec.map((x) => {
    const attrs: Record<string, string> = { role: 'treeitem', 'aria-level': String(x.level), tabindex: '-1' }
    if (x.expanded !== undefined) attrs['aria-expanded'] = String(x.expanded)
    const name = x.more !== undefined ? 'more:' + x.more : String(x.key)
    const li: Record<string, unknown> = {
      dataset: x.more !== undefined ? { more: x.more } : { key: x.key },
      getAttribute: (n: string) => (n in attrs ? attrs[n] : null),
      setAttribute: (n: string, v: string) => { attrs[n] = v },
      attrs,
      focus: () => { focused.push(name) },
    }
    const target = (act: string): Record<string, unknown> => ({ tagName: 'SPAN', dataset: { act, key: x.more ?? x.key } })
    li.querySelector = (q: string) => (q === ':scope > .ag-line > .ag-fold' && x.expanded !== undefined ? target('agentToggle')
      // 1.7 F2: the group of earlier sessions' row opens and closes it (`row: 'agentToggle'`).
      : q === ':scope > .ag-line > .ag-row' && x.more === undefined ? target(x.row ?? 'agentSelect')
        : q === ':scope > .ag-line > .ag-more' && x.more !== undefined ? (x.control === false ? { dataset: {} } : target('agentMore')) : null)
    li.closest = (q: string) => (q === '.agtree' ? tree : q === 'li[role="treeitem"]' ? li : null)
    return li
  })
  // The item above each one: the nearest one before it with a lower level.
  items.forEach((li, i) => {
    const level = spec[i].level
    let up: unknown = null
    for (let j = i - 1; j >= 0; j--) if (spec[j].level < level) { up = items[j]; break }
    li.parentElement = { closest: (q: string) => (q === '.agtree li[role="treeitem"]' ? up : null) }
  })
  tree.querySelectorAll = (q: string) => (q === 'li[role="treeitem"]' ? items
    : q === 'li[role="treeitem"][tabindex="0"]' ? items.filter((li) => (li.attrs as Record<string, string>).tabindex === '0')
      : q === '.ag-details .ag-copy' ? [] : [])
  return { tree, items }
}

test('a key on a tree item moves the focus, or asks the host through the target a click would use — and nothing else', () => {
  const a = agentCtx()
  a.fire('window:message', { origin: '', data: { type: 'data', payload: model({ sections: ['agents'], agents: agentTree(), ui: openUi() }) } })
  a.posted.length = 0
  const focused: string[] = []
  const { items } = fakeTree([
    { key: AK.s1, level: 1, expanded: true }, { key: AK.wf, level: 2, expanded: true }, { key: AK.a1, level: 3 },
    { more: AK.wf, level: 3 }, { key: AK.a3, level: 2, expanded: false }, { key: AK.s2, level: 1 },
  ], focused)
  let prevented = 0
  const key = (i: number, k: string, mods: Record<string, unknown> = {}): void => a.fire('document:keydown',
    { key: k, target: items[i], preventDefault: () => { prevented++ }, stopPropagation: () => undefined, ...mods })
  // The arrows, Home and End: the focus moves, and no message goes to the host.
  key(0, 'ArrowDown'); key(2, 'ArrowUp'); key(3, 'Home'); key(0, 'End'); key(5, 'ArrowDown'); key(2, 'ArrowLeft'); key(3, 'ArrowLeft')
  key(1, 'ArrowRight')
  assert.deepEqual(focused, [AK.wf, AK.wf, AK.s1, AK.s2, AK.wf, AK.wf, AK.a1])
  assert.deepEqual(a.posted, [])
  // Handled, so the page does not scroll under the tree — the end of the list included.
  assert.equal(prevented, 8)
  // → on a closed node and ← on an open one ask the host to open and close it; Enter and Space
  // select — from the tree —, on the "more" line they ask for the next fifty.
  key(4, 'ArrowRight'); key(1, 'ArrowLeft'); key(2, 'Enter'); key(5, ' '); key(3, 'Enter'); key(3, ' ')
  assert.deepEqual(a.posted, [{ type: 'agentToggle', key: AK.a3 }, { type: 'agentToggle', key: AK.wf },
    { type: 'agentSelect', key: AK.a1, from: 'tree' }, { type: 'agentSelect', key: AK.s2, from: 'tree' },
    { type: 'agentMore', key: AK.wf }, { type: 'agentMore', key: AK.wf }])
  for (const m of a.posted) assert.deepEqual(parseWebviewMessage(m), m)
  // A "more" line at its last step is the count alone: Enter asks for nothing.
  a.posted.length = 0
  const last = fakeTree([{ key: AK.wf, level: 1, expanded: true }, { more: AK.wf, level: 2, control: false }], focused)
  a.fire('document:keydown', { key: 'Enter', target: last.items[1], preventDefault: () => undefined })
  assert.deepEqual(a.posted, [])
  // A key with a modifier is not the tree's; nor is a key on anything but an item — the Copy ID
  // button in its details, a row of the running list.
  focused.length = 0
  prevented = 0
  for (const mod of ['altKey', 'ctrlKey', 'metaKey', 'shiftKey']) key(0, 'ArrowDown', { [mod]: true })
  const copy = { getAttribute: () => null, closest: () => items[2], tagName: 'BUTTON', dataset: { act: 'cmd' } }
  a.fire('document:keydown', { key: 'ArrowDown', target: copy, preventDefault: () => { prevented++ } })
  const outside = { ...items[0], closest: () => null }
  a.fire('document:keydown', { key: 'ArrowDown', target: outside, preventDefault: () => { prevented++ } })
  assert.deepEqual([focused, a.posted, prevented], [[], [], 0])
})

test('the item that takes the focus becomes the tree\'s stop of the Tab key, and its details\' Copy ID button with it', () => {
  const a = agentCtx()
  const focused: string[] = []
  const { tree, items } = fakeTree([{ key: AK.s1, level: 1, expanded: true }, { key: AK.a1, level: 2 }, { key: AK.a2, level: 2 }], focused)
  ;(items[0].attrs as Record<string, string>).tabindex = '0'
  // The Copy ID buttons of two panels: one in the item that takes the focus, one in another item.
  const button = (owner: unknown): Record<string, unknown> => {
    const b: Record<string, unknown> = { attrs: {} as Record<string, string> }
    b.setAttribute = (n: string, v: string) => { (b.attrs as Record<string, string>)[n] = v }
    b.closest = (q: string) => (q === '.ag-details' ? { parentElement: owner } : null)
    return b
  }
  const own = button(items[2])
  const other = button(items[0])
  const all = tree.querySelectorAll as (q: string) => unknown[]
  tree.querySelectorAll = (q: string) => (q === '.ag-details .ag-copy' ? [own, other] : all(q))
  a.fire('document:focusin', { target: items[2] })
  assert.deepEqual(items.map((li) => (li.attrs as Record<string, string>).tabindex), ['-1', '-1', '0'])
  assert.deepEqual([(own.attrs as Record<string, string>).tabindex, (other.attrs as Record<string, string>).tabindex], ['0', '-1'])
  // And the page remembers it, with the items above it, for the next render.
  assert.equal(String(nodeVm.runInContext('JSON.stringify(agentFocusPath)', a.c)),
    JSON.stringify([{ key: AK.a2, more: false }, { key: AK.s1, more: false }]))
  // A focus on the Copy ID button of an item's details makes that item the current one.
  const copy: Record<string, unknown> = { closest: (q: string) => (q === 'li[role="treeitem"]' ? items[1] : q === '.ag-details' ? { parentElement: items[1] } : null) }
  a.fire('document:focusin', { target: copy })
  assert.deepEqual(items.map((li) => (li.attrs as Record<string, string>).tabindex), ['-1', '0', '-1'])
  // Anything else — a row of the running list, the quota section — changes nothing.
  a.fire('document:focusin', { target: { closest: () => null } })
  a.fire('document:focusin', { target: null })
  assert.deepEqual(items.map((li) => (li.attrs as Record<string, string>).tabindex), ['-1', '0', '-1'])
})

/**
 * 1.6 L1: a fake tree item for the focus tests — the parts of an `<li role="treeitem">` the page's
 * focus code reads: its key (or its node's, for a "more" line), the item above it, where it
 * stands, and what its focus() does; `copy`, the Copy ID button of its details, when it has one.
 */
function fakeItem(ref: { key?: string; more?: string }, up: Record<string, unknown> | null, name: string, focused: string[],
  copy = false): Record<string, unknown> {
  const li: Record<string, unknown> = { dataset: ref.more !== undefined ? { more: ref.more } : { key: ref.key }, focus: () => { focused.push(name) } }
  const button: Record<string, unknown> = { dataset: { act: 'cmd', id: 'tokenPace.copyAgentId' }, focus: () => { focused.push(name + ':copy') } }
  const det = { parentElement: li }
  button.closest = (q: string) => (q === 'li[role="treeitem"]' ? li : q === '.ag-details' ? det : null)
  li.closest = (q: string) => (q === 'li[role="treeitem"]' ? li : q === '.agtree' ? {} : q === '.ag-details' ? null : null)
  li.parentElement = { closest: (q: string) => (q === '.agtree li[role="treeitem"]' ? up : null) }
  li.querySelector = (q: string) => (copy && q === ':scope > .ag-details .ag-copy' ? button : null)
  li.copyButton = button
  return li
}

/**
 * A context whose agents body is `body` and whose focus is `doc.activeElement`, for renderSection:
 * the page's tree as agentTree() with every node opened, drawn into a body that answers with the
 * items the test gives it.
 */
function focusCtx(doc: Record<string, unknown>): nodeVm.Context {
  const c = nodeVm.createContext({
    acquireVsCodeApi: () => ({ postMessage: () => undefined }), document: doc,
    window: { addEventListener: () => undefined }, console,
  })
  nodeVm.runInContext(SCRIPT, c)
  ;(c as Record<string, unknown>).fixture = model({ sections: ['quota', 'agents'], agents: agentTree(), ui: openUi() })
  nodeVm.runInContext('vm = fixture;', c)
  return c
}

test('a keyboard user on the tree keeps the focus through a push: on the item with the same key, else the nearest one above it', () => {
  // 1.6 L1 (pinned and changed: 1.5.1 put the focus back on the button that did the same thing to
  // the same node): the item takes the focus, and the push finds it again by its key — or, when it
  // is gone, the nearest item above it that is still drawn, else the first session.
  const focused: string[] = []
  const inside = new Set<unknown>()
  let items: Array<Record<string, unknown>> = []
  const body = {
    innerHTML: '', dataset: {}, style: {},
    contains: (el: unknown) => inside.has(el),
    querySelectorAll: (sel: string) => (sel === '.agtree li[role="treeitem"]' ? items : []),
  }
  const doc: Record<string, unknown> = {
    addEventListener: () => undefined, getElementById: () => null,
    querySelector: (s: string) => (s === '[data-body="agents"]' || s === '[data-body="quota"]' ? body : null),
    querySelectorAll: () => [], activeElement: null,
  }
  const c = focusCtx(doc)
  // The reader is on the running agent, in the run, in the session.
  const s1 = fakeItem({ key: AK.s1 }, null, 's1', focused)
  const wf = fakeItem({ key: AK.wf }, s1, 'wf', focused)
  const a1 = fakeItem({ key: AK.a1 }, wf, 'a1', focused)
  const push = (active: Record<string, unknown> | null, drawn: Array<Record<string, unknown>>, key = 'agents'): string[] => {
    focused.length = 0
    inside.clear()
    if (active) inside.add(active)
    doc.activeElement = active
    items = drawn
    nodeVm.runInContext('renderSection(' + JSON.stringify(key) + ');', c)
    return [...focused]
  }
  const again = (name: string, key: string, up: Record<string, unknown> | null = null): Record<string, unknown> =>
    fakeItem({ key }, up, name, focused)
  // Back on the item with the same key — not on another one, and not on the first.
  assert.deepEqual(push(a1, [again('s1-new', AK.s1), again('wf-new', AK.wf), again('a2-new', AK.a2), again('a1-new', AK.a1)]), ['a1-new'])
  // The item gone — its run was closed — the nearest item above it that is drawn: the run.
  assert.deepEqual(push(a1, [again('s1-new', AK.s1), again('wf-new', AK.wf), again('s2-new', AK.s2)]), ['wf-new'])
  // The run gone too: the session.
  assert.deepEqual(push(a1, [again('s1-new', AK.s1), again('s2-new', AK.s2)]), ['s1-new'])
  // Nothing of its path left: the first session.
  assert.deepEqual(push(a1, [again('s2-new', AK.s2), again('x-new', 's:/p/other.jsonl')]), ['s2-new'])
  // The Copy ID button of the item's details: back on it while the details stand, else on the item.
  const withCopy = fakeItem({ key: AK.a1 }, wf, 'a1', focused, true)
  assert.deepEqual(push(withCopy.copyButton as Record<string, unknown>,
    [again('s1-new', AK.s1), fakeItem({ key: AK.a1 }, wf, 'a1-new', focused, true)]), ['a1-new:copy'])
  assert.deepEqual(push(withCopy.copyButton as Record<string, unknown>, [again('s1-new', AK.s1), again('a1-new', AK.a1)]), ['a1-new'])
  // A focus outside the section, or a refresh of another section, is left to the browser.
  assert.deepEqual(push(null, [again('s1-new', AK.s1)]), [])
  const outside = fakeItem({ key: AK.a1 }, wf, 'a1', focused)
  focused.length = 0
  doc.activeElement = outside
  inside.clear()
  nodeVm.runInContext('renderSection("agents");', c)
  assert.deepEqual(focused, [])
  assert.deepEqual(push(a1, [again('a1-new', AK.a1)], 'quota'), [])
})

test('a keyboard user on a "more" line keeps the focus on it, and on its node once the line is gone', () => {
  // 1.6 D3: a step shows fifty children more and the line counts down; after the last step the
  // line is gone. 1.6 L1 (pinned and changed: the focus went to the node's toggle): the line is an
  // item of the node's group, found again by its node's key, and the item above it is the node's.
  const focused: string[] = []
  const inside = new Set<unknown>()
  let items: Array<Record<string, unknown>> = []
  const body = {
    innerHTML: '', dataset: {}, style: {},
    contains: (el: unknown) => inside.has(el),
    querySelectorAll: (sel: string) => (sel === '.agtree li[role="treeitem"]' ? items : []),
  }
  const doc: Record<string, unknown> = {
    addEventListener: () => undefined, getElementById: () => null,
    querySelector: (q: string) => (q === '[data-body="agents"]' ? body : null),
    querySelectorAll: () => [], activeElement: null,
  }
  const c = focusCtx(doc)
  const s1 = fakeItem({ key: AK.s1 }, null, 's1', focused)
  const wf = fakeItem({ key: AK.wf }, s1, 'wf', focused)
  const line = fakeItem({ more: AK.wf }, wf, 'line', focused)
  const push = (drawn: Array<Record<string, unknown>>): string[] => {
    focused.length = 0
    inside.clear()
    inside.add(line)
    doc.activeElement = line
    items = drawn
    nodeVm.runInContext('renderSection("agents");', c)
    return [...focused]
  }
  // The line again — not another node's line, not the node it belongs to.
  assert.deepEqual(push([fakeItem({ key: AK.wf }, s1, 'wf-new', focused), fakeItem({ more: AK.s1 }, s1, 'other-line', focused),
    fakeItem({ more: AK.wf }, wf, 'line-new', focused)]), ['line-new'])
  // The last step taken: no line for the node any more — the node itself.
  assert.deepEqual(push([fakeItem({ more: AK.s1 }, s1, 'other-line', focused), fakeItem({ key: AK.wf }, s1, 'wf-new', focused)]), ['wf-new'])
})

test('a keyboard user on a row of the running list comes back to that row, not to the same node\'s tree row', () => {
  const focused: string[] = []
  const control = (act: string, key: string, name: string, list?: string): Record<string, unknown> =>
    ({ dataset: list === undefined ? { act, key } : { act, key, list }, focus: () => { focused.push(name) } })
  // What a push draws, in document order: the running list first, then the tree.
  const drawn = [
    control('agentSelect', AK.l1, 'now-other', 'now'),
    control('agentSelect', AK.a1, 'now-row', 'now'),
    control('agentToggle', AK.s1, 'toggle'),
    control('agentSelect', AK.a1, 'tree-row'),
  ]
  const inside = new Set<unknown>()
  const body = {
    innerHTML: '', dataset: {}, style: {},
    contains: (el: unknown) => inside.has(el),
    querySelectorAll: (sel: string) => (sel === '[data-act]' ? drawn : []),
  }
  const doc: Record<string, unknown> = {
    addEventListener: () => undefined,
    getElementById: () => null,
    querySelector: (s: string) => (s === '[data-body="agents"]' ? body : null),
    querySelectorAll: () => [],
    activeElement: null,
  }
  const c = nodeVm.createContext({
    acquireVsCodeApi: () => ({ postMessage: () => undefined }), document: doc,
    window: { addEventListener: () => undefined }, console,
  })
  nodeVm.runInContext(SCRIPT, c)
  ;(c as Record<string, unknown>).fixture = model({ sections: ['agents'], agents: agentTree(), ui: agentUi() })
  nodeVm.runInContext('vm = fixture;', c)
  const push = (active: Record<string, unknown>): string[] => {
    focused.length = 0
    inside.clear()
    inside.add(active)
    doc.activeElement = active
    nodeVm.runInContext('renderSection("agents");', c)
    return [...focused]
  }
  // On the running row: back to the running row, although the tree row comes later.
  assert.deepEqual(push(control('agentSelect', AK.a1, 'was-now', 'now')), ['now-row'])
  // On the tree row: back to the tree row, although the running row with its key comes first.
  assert.deepEqual(push(control('agentSelect', AK.a1, 'was-tree')), ['tree-row'])
  // A running row whose agent has finished is gone from the list: the focus goes nowhere,
  // and least of all to that agent's tree row.
  drawn.splice(1, 1)
  assert.deepEqual(push(control('agentSelect', AK.a1, 'was-now', 'now')), [])
  // The script names the list it came from: the running rows carry data-list, the tree rows not.
  const h = agentsHtml(agentCtx(), { ui: openUi() })
  assert.equal(h.split('data-list="now"').length - 1, 1, h)
  assert.equal(treePart(h).indexOf('data-list'), -1)
})

test('the running glyph pulses only for a reader who allows motion, and the tree has no colour of its own', () => {
  const motion = between(STYLE, /@media \(prefers-reduced-motion: no-preference\) \{/, '\n}')
  assert.match(motion, /\.ag-running::before \{ animation: ag-pulse 2s ease-in-out infinite; \}/)
  assert.equal((STYLE.match(/animation:/g) ?? []).length, 1, 'an animation outside the motion query')
  assert.match(STYLE, /@keyframes ag-pulse \{/)
  // Every rule of the tree and the panel paints with a token of the page or the theme.
  const rules = STYLE.split('}').map((r) => r.replace(/\/\*[\s\S]*?\*\//g, '')).filter((r) => /\.ag-|\.agtree/.test(r))
  assert.ok(rules.length > 15, String(rules.length))
  for (const r of rules) assert.equal(/#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(/.test(r), false, r)
})

test('the agent tree speaks German on a German page', () => {
  const bundle = JSON.parse(readFileSync(join(__dirname, '..', 'l10n', 'bundle.l10n.de.json'), 'utf8')) as Record<string, string>
  const words = ['Agents', 'running', 'done', 'failed', 'stopped', 'unknown', 'active session', 'idle session',
    '{0} · derived', '{0} · recorded', 'running for {0}', '{0} ago', 'State', 'Last activity', 'Details',
    '{0} older session(s) not shown.',
    // 1.6 D3: the line under an open node that shows fifty of its children at a time.
    '{0} more · {1} not shown', '{0} more', '{0} not shown',
    'No Claude Code session in the last 7 days.',
    // 1.6 N5: a running agent's silence; D10: what the row's ⚠ says to a screen reader.
    'silent for {0}', 'lower bound',
    // 1.5.1: the running list.
    'Running now ({0})', 'and {0} more', 'No agent is running.', 'waits for a child agent',
    // 1.6 D4: how many of a collector's agents run.
    '~1 of them running', '~{0} of them running',
    // 1.6 N9: the state and the clocks in words for a screen reader.
    '{0}, derived', '{0}, recorded', 'since {0}', 'silent since {0}',
    // 1.6 P7b: a session's span, the last part of its figures' line.
    'span from the first to the last line',
    // 1.6 P9 (L2): the hidden label of the line under a details panel's state.
    'Summary',
    // 1.6 P10a (L3): the 7-day block's disclosure at the end of the running block's first line.
    'Last 7 days']
  const de: Record<string, string> = {}
  for (const w of words) {
    assert.ok(Object.prototype.hasOwnProperty.call(DICT, w), w + ' is not a word of the page')
    assert.equal(typeof bundle[w], 'string', 'no German for ' + w)
    de[w] = bundle[w]
  }
  const c = makeContext()
  nodeVm.runInContext(between(germanPage(de), /<script nonce="[A-Za-z0-9]+">/, '</script>'), c)
  ;(c as Record<string, unknown>).clock = { t: AG_NOW }
  nodeVm.runInContext('Date.now = function () { return clock.t; };', c)
  const section = (over: Record<string, unknown>): string => {
    ;(c as Record<string, unknown>).fixture = model({ agents: agentTree(), ui: agentUi(), ...over })
    return String(nodeVm.runInContext('vm = fixture; sAgents()', c))
  }
  const h = section({
    agents: agentTree({
      selected: detailsOf({ rows: [], overview: '1.2K in 29 min 00 s · 5 requests · 3 tool calls' }), omittedRoots: 2, runningMore: 3,
      runningNow: [runningItem({ silence: true, lastTs: AG_NOW - 4 * 60_000 }), runningItem({ key: AK.l1, waiting: true })],
    }),
    ui: openUi({ agentSelected: AK.a1 }),
  })
  for (const phrase of [
    'role="tree" aria-label="Agenten"', 'title="~läuft · abgeleitet"', 'title="fertig · aufgezeichnet"',
    'title="fehlgeschlagen · aufgezeichnet"', 'title="~unbekannt · abgeleitet"',
    'title="~Sitzung aktiv · abgeleitet"', 'title="~Sitzung ruht · abgeleitet"',
    '<span class="nobr">läuft seit <span data-live="since"', '<dt class="ag-wide">Zustand</dt>', '<dt>Letzte Aktivität</dt><dd><span class="nobr">vor <span data-live="since"',
    '<p class="empty">2 ältere Sitzung(en) nicht angezeigt.</p>',
    // 1.6 L1: a tree item's name — the view model's words, in this test English, and the page's
    // state words, German (pinned and changed: 1.5 named the toggle „… einklappen“).
    ' aria-expanded="true" aria-selected="false" aria-label="Workflow run Tue 11:40 · cfe7718d, läuft, abgeleitet, 2 started, ',
    ' aria-label="Session Tue 10:55 · 9d0eb37a · repo, Sitzung aktiv, abgeleitet, 4 started, ',
    // 1.6 N5: the silence, in German words and the page's units.
    '<span class="nobr">still seit <span class="ag-for">4 min</span></span>',
    // 1.6 N9: the state and the clocks for a screen reader, in German.
    'aria-label="läuft, abgeleitet" title="~läuft · abgeleitet"', 'aria-label="fertig, aufgezeichnet" title="fertig · aufgezeichnet"',
    '<span class="sr">seit 11:59</span>', '<span class="sr">still seit 11:59</span>',
    // 1.6 L2: the line under the state, its label a screen reader's.
    '<dt class="sr">Zusammenfassung</dt><dd class="ag-wide ag-overview">',
    // The running list: its heading with everything that runs, the waiting clause, the rest counted.
    '<div class="name" role="heading" aria-level="3">Laufen gerade (5)</div>',
    '<span>wartet auf einen untergeordneten Agenten</span>', '<p class="meta">und 3 weitere</p>',
  ]) assert.ok(h.indexOf(phrase) >= 0, phrase + ' missing from ' + h)
  assert.ok(section({ ui: agentUi({ agentsExpanded: [AK.s1] }) })
    .indexOf(' aria-expanded="false" aria-selected="false" aria-label="Workflow run Tue 11:40 · cfe7718d, läuft, abgeleitet, ') >= 0)
  assert.equal(/einklappen|ausklappen/.test(h), false, h)
  // 1.6 D3: the line under an open node that shows fifty of its children at a time, in German
  // words and German digits.
  const paged = (more: number, pages: number): string => section({
    agents: agentTree({ roots: [treeNode(AK.wf, 'done', {
      kind: 'workflow', label: 'Workflow run Tue 11:40 · cfe7718d', hasChildren: true, childrenTotal: more + 1, childrenMore: more,
      children: [treeNode(AK.a2, 'done')],
    })] }),
    ui: agentUi({ agentsExpanded: [AK.wf], agentsMore: pages > 0 ? [{ key: AK.wf, pages }] : [] }),
  })
  assert.ok(paged(1234, 0).indexOf('data-act="agentMore" data-key="' + AK.wf + '">50 weitere · 1.234 nicht gezeigt</span>') >= 0, paged(1234, 0))
  assert.ok(paged(12, 0).indexOf('data-act="agentMore" data-key="' + AK.wf + '">12 weitere</span>') >= 0)
  assert.ok(paged(1234, 10).indexOf('<span class="ag-more">1.234 nicht gezeigt</span>') >= 0)
  // 1.6 D7: a stop, recorded — „gestoppt · aufgezeichnet".
  assert.ok(section({ agents: agentTree({ roots: [treeNode(AK.a3, 'stopped', { derived: false })] }) })
    .indexOf('title="gestoppt · aufgezeichnet"') >= 0)
  // The tree's default: the closed session's tally, in the words the view model wrote — German
  // when it was built in German (1.6 N1); the page translates nothing of it.
  const closed = section({ agents: agentTree({ roots: [treeNode(AK.s1, 'active', {
    kind: 'session', label: 'Session Tue 10:55 · 9d0eb37a', sub: 'repo', usage: '1.2M', duration: '1 h 05 min', agentCount: 4,
    tally: { started: 4, done: 3, failed: 0, retried: 0, stopped: 0, running: 1, unknown: 0 },
    tallyText: '4 gestartet · 3 ✓ · ~1 ●', tallySpoken: '4 gestartet, 3 fertig, etwa 1 laufend',
    children: [treeNode(AK.a1, 'running')],
  })] }) })
  // 1.6 P7b: before the span, whose title is the page's words, German on a German page.
  assert.ok(closed.indexOf(tallyThen({ tallyText: '4 gestartet · 3 ✓ · ~1 ●', tallySpoken: '4 gestartet, 3 fertig, etwa 1 laufend' },
    fig('<span title="Spanne von der ersten bis zur letzten Zeile">1 h 05 min</span>'))) >= 0, closed)
  // 1.6 L1: the item's name — the node's name the view model's (English here), its state the page's
  // words, its tally the view model's (German here) — where 1.5 named the toggle („… ausklappen“).
  assert.ok(closed.indexOf(' aria-expanded="false" aria-selected="false" aria-label="Session Tue 10:55 · 9d0eb37a · repo, '
    + 'Sitzung aktiv, abgeleitet, 4 gestartet, 3 fertig, etwa 1 laufend"') >= 0, closed)
  // 1.6 P10a (L3): with the 7-day block's disclosure at the end of the line, in German too.
  assert.ok(section({ agents: agentTree({ runningNow: [] }) }).indexOf('<div class="ag-now"><p class="meta">Kein Agent läuft gerade.</p>'
    + '<button class="ag-wkbtn" data-act="agentsWeek" aria-expanded="false">Letzte 7 Tage</button></div>') === 0)
  // 1.6 D10: the line about the lower bound is gone in German too.
  assert.equal(h.indexOf('Untergrenzen.'), -1, h)
  assert.equal(section({ agents: agentTree({ roots: [] }) }),
    '<p class="empty">Keine Claude-Code-Sitzung in den letzten 7 Tagen.</p>')
  // 1.6 D4: a collector's entry says in German how many of its agents run, in German digits.
  const collected = (running: number): string => section({ agents: agentTree({ running: running + 1, runningNow: [
    runningItem(), runningItem({ key: AK.n1, kind: 'noreply', label: '1.263 Agent(en) ohne gezählte Antwort', usage: '–',
      startTs: null, lastTs: null, running }),
  ] }) })
  assert.ok(collected(1234).indexOf('<div class="name" role="heading" aria-level="3">Laufen gerade (1235)</div>') >= 0, collected(1234))
  // On its figures' line, in the clock's place (1.6, the lead's note on P5b: no clock for it).
  assert.ok(collected(1234).indexOf('<span class="nobr">~1.234 davon laufen</span>') >= 0, collected(1234))
  assert.ok(collected(1).indexOf('<span class="nobr">~1 davon läuft</span>') >= 0, collected(1))
})

test('the tree the view model builds reaches the page with its dashes, its marks and its derivations', () => {
  // End to end, where the tests above hand the renderer a tree of their own: the records the
  // aggregator filled from the builders' lines (test/fixtures/agentWorld.ts), the tree the view
  // model builds from them, and the markup the page writes for that tree.
  // Every parent opened, as a reader who opened them all would have it: every node on screen —
  // and in the payload, which carries a node's children only while it is open (1.6 D3).
  const { agg } = agentWorld()
  const cfg = makeConfig()
  const opened = everyParent(agg, cfg, NOW)
  const vm = buildViewModel(makeInput({ agg, cfg, ui: { agentsExpanded: opened } }))
  const nodes = treeNodes(vm.agents.roots)
  assert.deepEqual(nodes.filter((n) => n.hasChildren).map((n) => n.key).sort(), [...opened].sort())
  const h = treePart(agentsHtml(agentCtx(), { agents: vm.agents, ui: agentUi({ agentsExpanded: opened }) }))
  // 1.6 L1: the row is the mouse's target inside its item, up to the end of the item's line.
  // 1.7 F4 (pinned and changed: every row was the bare `ag-row`): an agent's, a launch's, a run's and a
  // collector's row wears the colour of a done, unknown, failed or running state nothing superseded.
  const colourOf = (n: TreeNode): string => (['agent', 'pending', 'workflow', 'noreply'].includes(n.kind)
    && ['done', 'unknown', 'failed', 'running'].includes(n.state) && !n.superseded ? n.state : '')
  const rowIn = (n: TreeNode): string => {
    const at = h.indexOf(rowOf(n.key, false, colourOf(n)))
    assert.ok(at >= 0, 'no row for ' + n.key)
    return h.slice(at, h.indexOf('</div>', at))
  }
  const words: Record<string, string> = {
    running: 'running', done: 'done', failed: 'failed', stopped: 'stopped', unknown: 'unknown', active: 'active session',
    idle: 'idle session',
  }
  for (const n of nodes) {
    // 1.7 F2: the group of earlier sessions (the quiet session's) is a container with no state — its
    // row is checked on its own below.
    if (n.kind === 'group') continue
    const row = rowIn(n)
    // The state the builder decided, and whether it inferred it or found it recorded.
    // 1.6 D7: an attempt the journal superseded says why its row is dimmed.
    const title = (n.derived ? '~' + words[n.state] + ' · derived' : words[n.state] + ' · recorded')
      + (n.superseded ? ' · superseded by a later attempt' : '')
    // 1.6 N9: for a screen reader the state in words, without the tilde.
    const spoken = words[n.state] + (n.derived ? ', derived' : ', recorded') + (n.superseded ? ', superseded by a later attempt' : '')
    assert.ok(row.indexOf('<span class="ag-st ag-' + n.state + '" role="img" aria-label="' + spoken + '" title="' + title + '">') >= 0, row)
    // 1.6 N6: the name's line titled with the whole name, the model's whole id.
    assert.ok(row.indexOf('<span class="ag-label" title="' + n.fullLabel + (n.sub ? ' · ' + n.sub : '') + '">') >= 0, row)
    // Its usage first among the figures on the second line — a session's named, "own 23.3K", a
    // launch's a dash — and marked there (1.6 D10, as shipped) exactly when it is a lower bound
    // with its reason, titled with that reason.
    assert.ok(row.indexOf('<span class="ag-fig" id="agf-' + n.key + '"><span class="ag-fp"><span class="nobr">' + (n.kind === 'session' ? 'own ' : '') + n.usage) >= 0, row)
    const marked = n.lowerBound && n.lowerBoundText !== null
    assert.equal(row.split('class="ag-lb"').length - 1, marked ? 1 : 0, row)
    // 1.7 D-A (pinned and changed): the ⚠ hidden from a screen reader, "lower bound" in the line
    // after it, the whole mark the end of the usage figure.
    if (marked) assert.ok(row.indexOf(lbMark(n.lowerBoundText as string) + '</span>') >= 0, row)
    assert.equal(row.split('class="ag-lbw"').length - 1, marked ? 1 : 0, row)
    // 1.6 N1: every node opened, so a session's and a run's tally stand, an agent's does not —
    // its children show their own glyphs — and a node without agents below has none.
    const shows = n.tallyText !== null && n.kind !== 'agent'
    assert.equal(/class="ag-t[" ]/.test(row), shows, row)
    const group = n.kind === 'session' || n.kind === 'workflow'
    // 1.6 P10c (pinned by P7b and changed, the lead's call): a run's collector puts its tally where
    // a run does, before its duration.
    const tallyFirst = group || n.kind === 'noreply'
    if (shows && !tallyFirst) assert.ok(row.indexOf(tallyEnd(n as unknown as Record<string, unknown>)) >= 0, row)
    // 1.6 P7b: a session's and a run's tally before the line's last part — its span, its duration or
    // its clock, the part the fit takes off first.
    if (shows && tallyFirst) {
      const mid = tallyFigs(n as unknown as Record<string, unknown>).map((x) => '<span class="ag-fp">' + SEP + x + '</span>').join('')
      const rest = row.slice(row.indexOf(mid) + mid.length)
      assert.ok(row.indexOf(mid) >= 0 && rest.startsWith('<span class="ag-fp">' + SEP) && rest.split('class="ag-fp"').length === 2
        && (rest.indexOf('data-live="since"') >= 0 || rest.indexOf('>' + n.duration + '</span>') >= 0), row)
    }
    // 1.6 P7b: the builder's names split on the page into what gives way and what does not — a
    // session's and a run's prefix word and the time it is named by, whole, the time ending on the
    // node's own clock time; an agent's type, whole, and its model, which gives way.
    if (group && n.startClock !== null) {
      const clock = n.startClock.replace(/^\d{4}-\d{2}-\d{2} /, '')
      const pre = n.kind === 'session' ? 'Session' : 'Workflow run'
      assert.ok(new RegExp('<span class="ag-np ag-pre">' + pre + '</span><span class="ag-np ag-when"> [A-Z][a-z]{2} ' + clock
        + '</span><span class="ag-dot"> · </span><span class="ag-sid ag-give">').test(row), row)
    }
    if (n.kind === 'agent') {
      const [type, model] = n.label.split(' · ')
      assert.ok(row.indexOf('<span class="ag-np ag-type">' + type + '</span><span class="ag-np ag-model"> · ' + model + '</span>') >= 0, row)
    }
  }
  // 1.6 L1: every item of the tree the builder made — its level, its place among its siblings and
  // how many they are (every child of the forest, shown or not), open or not, selected or not, and
  // its name in words: the whole name (a session's project after it), its state, and — where its
  // row shows one — its tally; its figures its description. One of them is the stop of the Tab key.
  const reKey = (k: string): string => k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const walk = (list: typeof vm.agents.roots, level: number, size: number): void => list.forEach((n, i) => {
    // 1.7 F2: the group of earlier sessions is nothing to select — no `aria-selected` — and its name
    // is its words and its sessions' tally, no state.
    const group = n.kind === 'group'
    const m = new RegExp('<li role="treeitem" class="ag-k-' + n.kind + '(?: ag-sup)?" data-key="' + reKey(n.key)
      + '" tabindex="(0|-1)" aria-level="(\\d+)" aria-setsize="(\\d+)" aria-posinset="(\\d+)"( aria-expanded="(?:true|false)")?'
      + (group ? '' : ' aria-selected="false"') + ' aria-label="([^"]*)"' + (group ? '' : ' aria-describedby="agf-' + reKey(n.key) + '"') + '>').exec(h)
    assert.ok(m, 'no item for ' + n.key)
    const said = (n.derived ? words[n.state] + ', derived' : words[n.state] + ', recorded') + (n.superseded ? ', superseded by a later attempt' : '')
    const tally = n.tallyText !== null && n.kind !== 'agent' ? ', ' + n.tallySpoken : ''
    assert.deepEqual([m[2], m[3], m[4], !!m[5], m[6]], [String(level), String(size), String(i + 1), n.hasChildren,
      group ? n.fullLabel + tally : n.fullLabel + (n.sub ? ' · ' + n.sub : '') + ', ' + said + tally], n.key)
    walk(n.children, level + 1, n.childrenTotal)
  })
  walk(vm.agents.roots, 1, vm.agents.roots.length)
  assert.equal(h.split('tabindex="0"').length - 1, 1, h)
  assert.ok(h.indexOf('<li role="treeitem" class="ag-k-session" data-key="' + vm.agents.roots[0].key + '" tabindex="0"') >= 0, h)
  // 1.7 F2: the quiet session is an earlier one — in the one group of earlier sessions, the tree's
  // last root, opened here with every other parent. Its row opens and closes it (agentToggle, never
  // agentSelect), its glyph column is kept with nothing drawn in it, its name is its words, and its
  // second line is what its sessions' agents came to and nothing else.
  const groups = nodes.filter((n) => n.kind === 'group')
  assert.deepEqual(groups.map((n) => n.key), [EARLIER_KEY])
  assert.equal(vm.agents.roots[vm.agents.roots.length - 1].key, EARLIER_KEY)
  const g = groups[0]
  assert.deepEqual([g.label, g.children.map((c) => c.kind)], ['Earlier sessions (1)', ['session']])
  const gAt = h.indexOf('<span class="ag-row" data-act="agentToggle" data-key="' + EARLIER_KEY + '" data-pressed="false">'
    + '<span class="ag-st ag-none" aria-hidden="true"></span><span class="ag-text">')
  assert.ok(gAt >= 0, h)
  const gRow = h.slice(gAt, h.indexOf('</div>', gAt))
  assert.ok(gRow.indexOf(olbl(g.fullLabel, g.label)) >= 0, gRow)
  assert.ok(gRow.indexOf(figs(...(g.tallyText !== null ? tallyFigs(g as unknown as Record<string, unknown>) : ['–'])) + '</span></span>') >= 0, gRow)
  assert.equal(gRow.indexOf('role="img"'), -1, gRow)
  assert.equal(h.indexOf('data-act="agentSelect" data-key="' + EARLIER_KEY + '"'), -1, h)
  assert.ok(nodes.some((n) => (n.kind === 'session' || n.kind === 'workflow') && n.startClock !== null && n.tallyText !== null))
  assert.ok(nodes.some((n) => n.kind === 'agent' && n.tallyText !== null), 'the world has an agent with agents below it')
  // The payload carries the flag and its reason (1.6 D10); the shipped page marks the rows (P7) and
  // has no line about it under the tree.
  assert.ok(nodes.filter((n) => n.kind === 'agent' && n.lowerBound).length >= 5)
  assert.ok(nodes.every((n) => (n.lowerBoundText !== null) === (n.lowerBound && n.kind !== 'pending' && n.kind !== 'noreply')))
  assert.equal(h.split('class="ag-lb"').length - 1, nodes.filter((n) => n.lowerBoundText !== null).length, h)
  assert.equal(h.indexOf('marked ⚠'), -1, h)
  // A launch nothing was counted of: a dash for its usage on its second line, no mark, and no zero.
  const pending = nodes.filter((n) => n.kind === 'pending')
  assert.equal(pending.length, 1)
  const p = rowIn(pending[0])
  assert.ok(p.indexOf('<span class="ag-fig" id="agf-' + pending[0].key + '"><span class="ag-fp"><span class="nobr">–</span></span>') >= 0, p)
  assert.equal(/>0[ <]|> 0</.test(p), false, p)
})

test('the details the view model builds open under the row that was clicked, and a closed branch takes them away without a word', () => {
  // 1.6 N2 end to end: the world's records, the view model with a selection and the place it
  // came from, and the markup the page writes for them.
  const { agg } = agentWorld()
  const cfg = makeConfig()
  const opened = everyParent(agg, cfg, NOW)
  const whole = agentTreeFor(makeInput({ agg, cfg, ui: {} }), 'text')
  const failed = agentNodeOf(whole.roots, AGENT_WORLD.wfFailed)
  const running = agentNodeOf(whole.roots, AGENT_WORLD.wfRunning)
  const page = (ui: Record<string, unknown>): { vm: ReturnType<typeof buildViewModel>; h: string } => {
    const vm = buildViewModel(makeInput({ agg, cfg, ui }))
    return { vm, h: agentsHtml(agentCtx(), { agents: vm.agents, ui: agentUi({ ...ui }) }) }
  }
  // A finished agent selected in the opened tree: the panel inside its entry, its row pressed.
  const inTree = page({ agentsExpanded: opened, agentSelected: failed.key, agentSelectedIn: 'tree' })
  assert.equal(inTree.vm.agents.selected?.key, failed.key)
  const at = inTree.h.indexOf('data-key="' + failed.key + '" data-pressed="true">')
  assert.ok(at >= 0, inTree.h)
  const panel = panelOf(inTree.h)
  assert.ok(inTree.h.indexOf(panel) > at && inTree.h.indexOf(panel) > inTree.h.indexOf('<div class="agtree"'), inTree.h)
  assert.ok(panel.indexOf('<div class="name">' + failed.fullLabel + '</div>') >= 0, panel)
  // Its run closed: the row is hidden, the running list does not name it — no panel, no note,
  // nothing pressed. Opened again, the panel is back.
  const closed = page({ agentsExpanded: opened.filter((k) => !k.startsWith('w:')), agentSelected: failed.key })
  assert.deepEqual([closed.vm.agents.selected, closed.vm.agents.note], [null, null])
  assert.equal(closed.h.indexOf('ag-details'), -1, closed.h)
  assert.equal(closed.h.indexOf('aria-pressed="true"'), -1, closed.h)
  assert.equal(closed.h.indexOf('data-pressed="true"'), -1, closed.h)
  assert.equal(closed.h.indexOf('The selected node is no longer in the tree.'), -1, closed.h)
  assert.equal(page({ agentsExpanded: opened, agentSelected: failed.key }).h, inTree.h)
  // The running agent, clicked in the running list while its tree row is on the page as well:
  // the panel under the list's row, the list's row pressed, the tree row not — and from the tree
  // row, the other way round.
  const fromNow = page({ agentsExpanded: opened, agentSelected: running.key, agentSelectedIn: 'now' })
  const nowPanel = panelOf(fromNow.h)
  assert.ok(fromNow.h.indexOf('data-key="' + running.key + '" data-list="now" aria-pressed="true">') < fromNow.h.indexOf(nowPanel)
    && fromNow.h.indexOf(nowPanel) < fromNow.h.indexOf('<div class="agtree"'), fromNow.h)
  assert.ok(treePart(fromNow.h).indexOf('data-key="' + running.key + '" data-pressed="false">') >= 0, fromNow.h)
  const fromTree = page({ agentsExpanded: opened, agentSelected: running.key, agentSelectedIn: 'tree' })
  assert.ok(treePart(fromTree.h).indexOf('data-key="' + running.key + '" data-pressed="true">') >= 0, fromTree.h)
  assert.ok(fromTree.h.indexOf('data-key="' + running.key + '" data-list="now" aria-pressed="false">') >= 0, fromTree.h)
  // The view model is the same for both: where the panel stands is the page's say alone.
  assert.deepEqual(fromNow.vm.agents, fromTree.vm.agents)
  for (const x of [inTree, fromNow, fromTree]) assert.equal(x.h.split('<div class="ag-details"').length - 1, 1, x.h)
})

test('the running list the view model builds reaches the page first, the tree closed under it', () => {
  const vm = buildViewModel(makeInput({ agg: agentWorld('session').agg, cfg: makeConfig({ 'tokenPace.attribution': 'session' }) }))
  const items = vm.agents.runningNow
  // The world's running agent, its run's collector (1.6 D4) — one entry for its agents without a
  // counted reply, one of which runs — and its launch waiting for a transcript.
  // The collector last (1.6, the lead's note on P5b, pinned and changed): it has no start of its
  // own, and the list is the longest-running first.
  assert.deepEqual(items.map((r) => [r.kind, r.running]), [['agent', 1], ['pending', 1], ['noreply', 1]])
  const h = agentsHtml(agentCtx(), { agents: vm.agents, ui: agentUi() })
  // First in the section, before the tree: the heading with the count — the running agents, as
  // the view model counts them (1.6 §2.3) —, one row per item, in order.
  assert.equal(vm.agents.running, 3)
  assert.ok(h.startsWith('<div class="ag-now"><div class="name" role="heading" aria-level="3">Running now (3)</div>' + WEEK_TOGGLE + '<ul>'), h)
  assert.ok(h.indexOf('<div class="ag-now">') < h.indexOf('<div class="agtree"'))
  const rows = [...h.slice(0, h.indexOf('<div class="agtree"')).matchAll(/data-key="([^"]*)" data-list="now"/g)].map((m) => m[1])
  assert.deepEqual(rows, items.map((r) => r.key))
  for (const r of items) {
    const at = h.indexOf('data-key="' + r.key + '" data-list="now"')
    const row = h.slice(at, h.indexOf('</button>', at))
    // Its usage — a dash for the launch and the collector, marked where it is a lower bound — then
    // the live clock from its start, with the words for a screen reader; a collector has no start
    // of its own (1.6, the lead's note on P5b) and says how many of its agents run instead.
    // 1.7 D-A (pinned and changed: the row's mark was checked only up to its class): the whole mark —
    // the ⚠ hidden from a screen reader, titled with the item's reason, "lower bound" in the line —
    // the end of the usage figure.
    assert.ok(row.indexOf('<span class="ag-fig"><span class="ag-fp"><span class="nobr">' + r.usage
      + (r.lowerBound ? lbMark(r.lowerBoundText as string) : '') + '</span>') >= 0, row)
    assert.equal(row.split('class="ag-lbw"').length - 1, r.lowerBound ? 1 : 0, row)
    if (r.kind === 'noreply') {
      assert.equal(row.indexOf('data-live="since"'), -1, row)
      assert.ok(row.indexOf(fig('~1 of them running')) >= 0, row)
    } else {
      assert.ok(row.indexOf('<span class="nobr">running for <span data-live="since" data-ts="' + r.startTs + '">') >= 0, row)
      assert.ok(row.indexOf('<span class="sr">since ' + r.startClock + '</span>') >= 0, row)
    }
    // 1.6 N5: a running agent's silence after its figures, a waiting one's, a launch's and a
    // collector's never.
    assert.equal(row.indexOf('<span class="ag-fp ag-silent"') >= 0, r.silence, row)
    assert.equal(r.silence, r.kind === 'agent' && !r.waiting, r.key)
    // Where it sits.
    assert.ok(row.indexOf('<span class="meta ag-ctx"><span>' + r.context.split(' · ').join('</span> · <span>') + '</span></span>') >= 0, row)
    assert.equal(/>0[ <]|> 0</.test(row), false, row)
  }
  assert.equal(items.find((r) => r.kind === 'pending')?.usage, '–')
  assert.equal(items.find((r) => r.kind === 'noreply')?.usage, '–')
  // The tree under it holds the busy session and — 1.7 F2 (pinned and changed) — the closed group of
  // earlier sessions, the quiet one inside it, and nothing else, each saying what its agents came to
  // — the payload carries nothing below them (1.6 D3), and each keeps its toggle.
  assert.deepEqual(vm.agents.roots.map((r) => r.kind), ['session', 'group'])
  assert.ok(vm.agents.roots.every((r) => r.children.length === 0 && r.hasChildren && r.childrenMore === 0))
  const tree = treePart(h)
  assert.deepEqual([...tree.matchAll(/data-act="agent(?:Select|Toggle)" data-key="([^"]*)" data-pressed/g)].map((m) => m[1]),
    vm.agents.roots.map((r) => r.key))
  for (const r of vm.agents.roots) {
    assert.equal(r.tally?.started, r.agentCount, r.label)
    // The group: its sessions' tally is its whole second line.
    if (r.kind === 'group') {
      assert.ok(tree.indexOf(figs(...tallyFigs(r as unknown as Record<string, unknown>)) + '</span></span>') >= 0, r.label)
      continue
    }
    // 1.6 P7b: the tally, then the span — the line's last part — and the line's end.
    const mid = tallyFigs(r as unknown as Record<string, unknown>).map((x) => '<span class="ag-fp">' + SEP + x + '</span>').join('')
    assert.ok(tree.indexOf(mid + '<span class="ag-fp">' + SEP + fig('<span title="span from the first to the last line">' + r.duration
      + '</span>') + '</span></span>') >= 0, r.label)
  }
  assert.equal(tree.indexOf('aria-expanded="true"'), -1, tree)
  // The running agent is mid-reply, so its output is a lower bound — its item carries the flag and
  // the reason (1.6 D10) — and the shipped page marks its row (P7), and no line under the tree.
  assert.deepEqual(items.map((r) => r.lowerBound), [true, false, false])
  assert.deepEqual(items.map((r) => r.lowerBoundText !== null), [true, false, false])
  assert.equal(vm.agents.roots.some((r) => r.lowerBound), false, 'a session row carries the lower bound itself')
  assert.equal(h.split('class="ag-lb"').length - 1, 1, h)
})

// ---------------------------------------------------------------------------
// 1.5.1: the running list
// ---------------------------------------------------------------------------

/**
 * One row of the running list exactly as the page writes it (1.6 N6): the glyph, the name as a tree
 * row writes it — its title the whole name —, the figures under it — the usage, then the live clock
 * with its words for a screen reader, or for a collector how many of its agents run — and where it
 * sits, a line of its own under them.
 */
function nowRow(o: { key: string; kind?: string; title?: string; names: string[]; id?: string | null;
  clock?: { ts: number; text: string; since?: string | null } | null; members?: string;
  usage: string; where: string[]; pressed?: boolean; panel?: string }): string {
  const parts = [fig(o.usage)]
  if (o.clock) parts.push(runFig(o.clock.ts, o.clock.text, o.clock.since === undefined ? '11:59' : o.clock.since))
  if (o.members) parts.push(fig(o.members))
  const title = o.title ?? [...o.names, ...(o.id ? [o.id] : [])].join(' · ')
  // 1.6 P7b: an agent's name as a tree row writes it — the type, the model that gives way, the
  // short id (a launch's last word) — and a name of one part as one.
  const name = o.id ? albl(title, o.names[0], o.names[1], o.id)
    : o.names.length === 3 ? albl(title, o.names[0], o.names[1], o.names[2], true) : olbl(title, o.names.join(' · '))
  // 1.7 F4: every entry of the running list runs, and its name wears the running colour.
  return '<li class="ag-k-' + (o.kind ?? 'agent') + '"><button class="ag-row ag-c-running" data-act="agentSelect" data-key="' + o.key
    + '" data-list="now" aria-pressed="' + (o.pressed === true) + '">'
    + '<span class="ag-st ag-running" role="img" aria-label="running, derived" title="~running · derived"></span>'
    + '<span class="ag-text">' + (title === '' ? name.replace(' title=""', '') : name)
    + figs(...parts)
    + (o.where.length ? '<span class="meta ag-ctx">' + o.where.map((w) => '<span>' + w + '</span>').join(' · ') + '</span>' : '')
    + '</span></button>' + (o.panel ?? '') + '</li>'
}

test('the running list comes first: how many run, then a row each with its clock, its usage and where it sits', () => {
  const a = agentCtx()
  const items = [
    runningItem({ key: 'a:w1', label: 'general-purpose · opus-5 · w1w1', context: 'Session 9d0eb37a',
      usage: '4.1K', startTs: AG_NOW - 600_000, waiting: true }),
    runningItem(),
    runningItem({ key: AK.l1, kind: 'pending', label: 'Plan · sonnet · launched', context: 'Session 9d0eb37a · repo',
      usage: '–', startTs: AG_NOW - 90_000, lastTs: AG_NOW - 90_000 }),
  ]
  const h = agentsHtml(a, { agents: agentTree({ runningNow: items, selected: detailsOf() }), ui: agentUi({ agentSelected: AK.a1 }) })
  const now = h.slice(0, h.indexOf('<div class="agtree"'))
  assert.equal(now, '<div class="ag-now"><div class="name" role="heading" aria-level="3">Running now (3)</div>' + WEEK_TOGGLE + '<ul>'
    // Waiting on the agent below it: the clause says so, after where it sits.
    + nowRow({ key: 'a:w1', names: ['general-purpose', 'opus-5'], id: 'w1w1', clock: { ts: AG_NOW - 600_000, text: '10 min 00 s' },
      usage: '4.1K', where: ['Session 9d0eb37a', 'waits for a child agent'] })
    // The selected one is pressed, and — its tree row inside a closed branch — its details are
    // the second line of its item (1.6 N2). Its title is its whole name, the model's whole id.
    + nowRow({ key: AK.a1, names: ['Explore', 'opus-5'], id: 'a94f', title: 'Explore · claude-opus-5 · a94f',
      clock: { ts: AG_NOW - 42_000, text: '42 s' },
      usage: '12.3K', where: ['Session 9d0eb37a', 'Workflow run cfe7718d', 'repo'], pressed: true, panel: panelOf(h) })
    // A launch nobody has read a line of: a dash for what it used, and its clock.
    + nowRow({ key: AK.l1, kind: 'pending', names: ['Plan', 'sonnet', 'launched'], clock: { ts: AG_NOW - 90_000, text: '1 min 30 s' },
      usage: '–', where: ['Session 9d0eb37a', 'repo'] })
    + '</ul></div>', now)
  // The rows are the first buttons of the section, the tree's after them.
  const acts = [...h.matchAll(/data-act="([a-zA-Z]+)" data-key="([^"]*)"/g)].map((m) => m[2])
  assert.deepEqual(acts.slice(0, 3), ['a:w1', AK.a1, AK.l1])
  // Each part of where it sits keeps together while it fits and breaks inside only when not;
  // the line is one of its own under the name and the figures — the rows' text a column (1.6 N6)
  // —; a launch's name is italic.
  assert.match(STYLE, /\.ag-ctx > span \{ display: inline-block; max-width: 100%; \}/)
  assert.match(STYLE, /\.ag-now li \{ display: flex; flex-wrap: wrap; \}/)
  assert.match(STYLE, /\.ag-now \.ag-k-pending \.ag-label \{ font-style: italic; \}/)
  assert.match(STYLE, /\.ag-now ul \{ list-style: none; margin: 4px 0 0; padding: 0; \}/)
})

test('a run\'s collector is one row in the tree and one in the running list, which says how many of its agents run', () => {
  // 1.6 D4: the agents of a run without a counted reply, in one node — no toggle, dashes for its
  // figures, its tally beside its label — and, while one of them runs, one entry of the running
  // list for all of them; the heading counts the running agents, as the view model does.
  const a = agentCtx()
  const T_N1 = tallyOf({ done: 250, failed: 3, running: 10 })
  const collector = treeNode(AK.n1, 'running', {
    kind: 'noreply', label: '263 agent(s) without a counted reply', usage: '–', duration: '–', startTs: null, lastTs: null, ...T_N1,
  })
  const tree = agentTree({
    roots: [treeNode(AK.wf, 'running', { kind: 'workflow', label: 'Workflow run Tue 11:40 · cfe7718d', ...tallyOf({ done: 250, failed: 3, running: 11 }),
      children: [treeNode(AK.a1, 'running'), collector] })],
    running: 11,
    runningNow: [runningItem(), runningItem({ key: AK.n1, kind: 'noreply', label: '263 agent(s) without a counted reply',
      context: 'Session 9d0eb37a · Workflow run cfe7718d · repo', usage: '–', startTs: null, lastTs: null, running: 10 })],
  })
  const h = agentsHtml(a, { agents: tree, ui: agentUi({ agentsExpanded: [AK.wf] }) })
  const now = h.slice(0, h.indexOf('<div class="agtree"'))
  assert.equal(now, '<div class="ag-now"><div class="name" role="heading" aria-level="3">Running now (11)</div>' + WEEK_TOGGLE + '<ul>'
    + nowRow({ key: AK.a1, names: ['Explore', 'opus-5'], id: 'a94f', title: 'Explore · claude-opus-5 · a94f',
      clock: { ts: AG_NOW - 42_000, text: '42 s' },
      usage: '12.3K', where: ['Session 9d0eb37a', 'Workflow run cfe7718d', 'repo'] })
    // No start of its own (1.6, the lead's note on P5b): no clock, a dash for its usage, and how
    // many of its agents run in the clock's place.
    + nowRow({ key: AK.n1, kind: 'noreply', names: ['263 agent(s) without a counted reply'], clock: null, usage: '–',
      members: '~10 of them running', where: ['Session 9d0eb37a', 'Workflow run cfe7718d', 'repo'] })
    + '</ul></div>', now)
  // With one running member, the words for one.
  const one = agentsHtml(a, { agents: agentTree({ running: 1, runningNow: [runningItem({ key: AK.n1, kind: 'noreply', usage: '–', running: 1 })] }) })
  assert.ok(one.indexOf(fig('~1 of them running')) >= 0 && one.indexOf('Running now (1)') >= 0, one)
  // A start the payload gives a collector anyway runs no clock: it has none of its own.
  const clocked = agentsHtml(a, { agents: agentTree({ running: 1, runningNow: [runningItem({ key: AK.n1, kind: 'noreply', usage: '–', running: 1,
    startTs: AG_NOW - 42_000 })] }) })
  assert.equal(clocked.indexOf('data-live'), -1, clocked)
  // A count the page cannot trust is no clause, and a heading that would count fewer than the
  // rows counts the rows.
  for (const running of [0, -2, 1.5, NaN, '10', null, undefined]) {
    const odd = agentsHtml(a, { agents: agentTree({ running, runningNow: [runningItem({ key: AK.n1, kind: 'noreply', usage: '–', running })] }) })
    assert.equal(odd.indexOf('of them running'), -1, String(running))
    assert.ok(odd.indexOf('Running now (1)') >= 0, String(running))
  }
  // In the tree: a leaf — no toggle, no aria-expanded — its glyph, its label, dashes and its tally.
  // 1.6 P10c (pinned by P5b/P7 and changed, the lead's call): its figures are in a run's order —
  // the usage, the tally, then the duration, the trailing dash the first part to give way.
  const t = treePart(h)
  const at = t.indexOf('<li role="treeitem" class="ag-k-noreply"')
  assert.ok(at >= 0, t)
  const li = t.slice(at, t.indexOf('</li>', at) + 5)
  // 1.6 L1: an item of its run's group like its siblings, the last place of two, its name in words.
  assert.equal(li, itemTag(AK.n1, { kind: 'noreply', level: 2, size: 2, pos: 2,
    label: '263 agent(s) without a counted reply, running, derived, 263 started, 250 done, 3 failed, about 10 running' })
    + '<div class="ag-line"><span class="ag-pad"></span>' + rowOf(AK.n1, false, 'running')
    + '<span class="ag-st ag-running" role="img" aria-label="running, derived" title="~running · derived"></span>'
    + '<span class="ag-text">' + olbl('263 agent(s) without a counted reply', '263 agent(s) without a counted reply')
    + figsOf(AK.n1, fig('–'), ...tallyFigs(T_N1), fig('–')) + '</span></span></div></li>', li)
  // Running, with a start the payload gives it anyway: still no clock in the tree — dashes.
  const started = treePart(agentsHtml(a, { agents: agentTree({ roots: [treeNode(AK.wf, 'running', { kind: 'workflow',
    label: 'Workflow run Tue 11:40 · cfe7718d', startTs: null, children: [{ ...collector, startTs: AG_NOW - 42_000 }] })] }),
  ui: agentUi({ agentsExpanded: [AK.wf] }) }))
  assert.equal(started.indexOf('data-live'), -1, started)
  // Last in its run, after the agents.
  assert.ok(t.indexOf('data-key="' + AK.a1 + '"') < at, t)
})

test('the running list counts what it left out, and an item with nothing in it is dashes, never a zero', () => {
  const a = agentCtx()
  const more = agentsHtml(a, { agents: agentTree({ runningMore: 4 }) })
  assert.ok(more.startsWith('<div class="ag-now"><div class="name" role="heading" aria-level="3">Running now (5)</div>' + WEEK_TOGGLE + '<ul>'), more)
  assert.ok(more.indexOf('</li></ul><p class="meta">and 4 more</p></div><div class="agtree"') >= 0, more)
  // Only left-out ones: the heading and the count, no empty list.
  const only = agentsHtml(a, { agents: agentTree({ runningNow: [], runningMore: 2 }) })
  assert.ok(only.startsWith('<div class="ag-now"><div class="name" role="heading" aria-level="3">Running now (2)</div>'
    + WEEK_TOGGLE + '<p class="meta">and 2 more</p></div>'), only)
  assert.equal(only.indexOf('<ul></ul>'), -1)
  // A count that is none is no line.
  for (const runningMore of [0, -1, 0.4, NaN, Infinity, null, undefined, 'three', '4', true]) {
    const h = agentsHtml(a, { agents: agentTree({ runningMore }) })
    assert.equal(h.indexOf(' more</p>'), -1, String(runningMore))
    assert.ok(h.indexOf('Running now (1)') >= 0, String(runningMore))
  }
  // An item without a label, a usage, a start or a context: dashes, no clock, no empty line —
  // and what is not an item at all is skipped.
  const bare = agentsHtml(a, { agents: agentTree({ runningNow: [{ key: AK.a1 }, null, 7, 'x'] }) })
  assert.ok(bare.startsWith('<div class="ag-now"><div class="name" role="heading" aria-level="3">Running now (1)</div>' + WEEK_TOGGLE + '<ul>'
    + nowRow({ key: AK.a1, names: ['–'], title: '', clock: null, usage: '–', where: [] }) + '</ul></div>'), bare)
  assert.equal(/undefined|NaN|null|\[object Object\]|>0</.test(bare.slice(0, bare.indexOf('<div class="agtree"'))), false, bare)
  // A kind this build does not know reaches no class: it is drawn as an agent.
  const rocket = agentsHtml(a, { agents: agentTree({ runningNow: [runningItem({ kind: 'rocket' })] }) })
  assert.ok(rocket.startsWith('<div class="ag-now"><div class="name" role="heading" aria-level="3">Running now (1)</div>' + WEEK_TOGGLE + '<ul>'
    + '<li class="ag-k-agent">'), rocket)
  assert.equal(rocket.indexOf('rocket'), -1, rocket)
})

test('with nothing running the list is one quiet line and no heading; a payload without the list says nothing', () => {
  const a = agentCtx()
  const quiet = agentsHtml(a, { agents: agentTree({ runningNow: [], runningMore: 0 }) })
  // 1.6 P10a (L3): the one line carries the 7-day block's disclosure at its end (pinned and changed:
  // it was a bare <p class="ag-now meta">).
  assert.ok(quiet.startsWith('<div class="ag-now"><p class="meta">No agent is running.</p>' + WEEK_TOGGLE + '</div><div class="agtree"'), quiet)
  assert.equal(quiet.indexOf('Running now'), -1, quiet)
  assert.equal(quiet.indexOf('data-list'), -1, quiet)
  // An older build's payload carries no list: no line claims that nothing runs.
  for (const runningNow of [undefined, null, 'x', { key: AK.a1 }]) {
    const old = agentsHtml(a, { agents: agentTree({ runningNow }) })
    assert.ok(old.startsWith('<div class="agtree"'), String(runningNow) + ': ' + old)
    assert.equal(old.indexOf('No agent is running.'), -1)
  }
  // With no session at all, the section's one note says it; the list adds nothing to it.
  assert.equal(agentsHtml(a, { agents: agentTree({ roots: [], runningNow: [] }) }),
    '<p class="empty">No Claude Code session in the last 7 days.</p>')
})

// ---------------------------------------------------------------------------
// 1.6 L3: where the agent tokens of the last 7 days went
// ---------------------------------------------------------------------------

/**
 * An AgentWeek of src/agentTree.ts as the tree builder writes it, with costs: two rows — one of
 * them without a price —, a line for the rest, the two largest agents (the tree's running agent
 * and its done Plan agent), and a total that holds only some of its agents' costs.
 */
function weekOf(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    rows: [
      { type: 'workflow-subagent', model: 'claude-opus-5', label: 'workflow-subagent · opus-5', agents: 12, usage: '1.2M',
        share: '62 %', median: '80K', cost: '~$12.40' },
      { type: 'Explore', model: 'claude-sonnet-5', label: 'Explore · sonnet-5', agents: 3, usage: '410K', share: '21 %',
        median: '120K', cost: '–' },
    ],
    other: '3 other combinations',
    top: [
      { key: AK.a1, label: 'Explore · opus-5 · a94f', fullLabel: 'Explore · claude-opus-5 · a94f',
        context: 'Session 9d0eb37a · Workflow run cfe7718d · repo', state: 'running', derived: true, usage: '12.3K', share: '1 %', cost: '~$0.40' },
      { key: AK.a2, label: 'Plan · opus-5 · b1c2', fullLabel: 'Plan · claude-opus-5 · b1c2',
        context: 'Session 9d0eb37a · Workflow run cfe7718d · repo', state: 'done', derived: false, usage: '9.1K', share: '<1 %', cost: '–' },
    ],
    total: '1.9M', totalCost: '~$12.80 ⚠', agents: 18, ...over,
  }
}

/** The 7-day block of a rendered section: from its frame to the tree's. */
function weekPart(h: string): string {
  const at = h.indexOf('<div class="ag-week"')
  assert.ok(at >= 0, 'no 7-day block in ' + h)
  return h.slice(at, h.indexOf('<div class="agtree"'))
}

/** A row of the block's largest agents, as the page writes it — a running list's row, from its own list. */
function weekRow(o: { key: string; state: string; derived: boolean; title: string; names: string[]; id: string; figs: string[];
  where: string[]; pressed?: boolean; panel?: string }): string {
  const spoken = (o.state === 'running' ? 'running' : o.state) + (o.derived ? ', derived' : ', recorded')
  const title = (o.derived ? '~' : '') + (o.state === 'running' ? 'running' : o.state) + (o.derived ? ' · derived' : ' · recorded')
  // 1.7 F4: the name in the colour of its state, as its tree row's.
  const colour = ['done', 'unknown', 'failed', 'running'].includes(o.state) ? ' ag-c-' + o.state : ''
  return '<li class="ag-k-agent"><button class="ag-row' + colour + '" data-act="agentSelect" data-key="' + o.key
    + '" data-list="week" aria-pressed="' + (o.pressed === true) + '">'
    + '<span class="ag-st ag-' + o.state + '" role="img" aria-label="' + spoken + '" title="' + title + '"></span>'
    + '<span class="ag-text">' + albl(o.title, o.names[0], o.names[1], o.id) + figs(...o.figs.map(fig))
    + '<span class="meta ag-ctx">' + o.where.map((w) => '<span>' + w + '</span>').join(' · ') + '</span>'
    + '</span></button>' + (o.panel ?? '') + '</li>'
}

test('the running block\'s first line carries the 7-day block\'s disclosure; open, the block stands between the list and the tree (1.6 L3)', () => {
  const a = agentCtx()
  // Closed, as the section starts: the disclosure at the end of the heading and of the quiet line,
  // no block, even with one in a payload of a view state that has it closed.
  for (const agents of [agentTree(), agentTree({ runningNow: [] }), agentTree({ week: weekOf() })]) {
    const h = agentsHtml(a, { agents })
    assert.ok(h.indexOf(WEEK_TOGGLE) > 0 && h.indexOf(WEEK_TOGGLE) < h.indexOf('<div class="agtree"'), h)
    assert.equal(h.indexOf('ag-week'), -1, h)
  }
  // Open: the disclosure says so and names the block it opens; the block follows the running
  // list, before the tree.
  const h = agentsHtml(a, { agents: agentTree({ week: weekOf() }), ui: agentUi({ agentsWeekOpen: true }) })
  const toggle = '<button class="ag-wkbtn" data-act="agentsWeek" aria-expanded="true" aria-controls="ag-week">Last 7 days</button>'
  assert.ok(h.startsWith('<div class="ag-now"><div class="name" role="heading" aria-level="3">Running now (1)</div>' + toggle + '<ul>'), h)
  const at = h.indexOf('<div class="ag-week"')
  assert.ok(h.indexOf('</ul></div>') < at && at < h.indexOf('<div class="agtree"'), h)
  const w = weekPart(h)
  const heads = ['Type · model', 'Agents', 'Usage', 'Share', 'Median per agent', '~Cost']
  // 1.10 D10 (rewritten: data-hl beside data-h).
  const td = (i: number, v: string): string => '<td data-h="' + heads[i] + '" data-hl="' + heads[i] + ':">' + v + '</td>'
  // 1.7 D-A (pinned and changed: 1.6 L3 wrote an image named "lower bound"): the ⚠ hidden from a
  // screen reader, its words in the cell after it.
  const lb = lbMark('not every agent has a price: the sum is a lower bound')
  assert.equal(w, '<div class="ag-week" id="ag-week" role="region" aria-labelledby="ag-week-h">'
    + '<div class="name" id="ag-week-h" role="heading" aria-level="3">Last 7 days · where the agent tokens went</div>'
    + '<div class="scroll"><table class="ag-wkt"><thead><tr>' + heads.map((x) => '<th>' + x + '</th>').join('') + '</tr></thead><tbody>'
    // A row: its type and model as a row names them, the whole model id its title; its figures the view model's.
    // Each part of the name whole, so a narrow column breaks it between them, never inside the model's id.
    + '<tr>' + td(0, '<span title="workflow-subagent · claude-opus-5">' + fig('workflow-subagent') + ' · ' + fig('opus-5') + '</span>')
    + td(1, '12') + td(2, '1.2M')
    + td(3, '62 %') + td(4, '80K') + td(5, '~$12.40') + '</tr>'
    + '<tr>' + td(0, '<span title="Explore · claude-sonnet-5">' + fig('Explore') + ' · ' + fig('sonnet-5') + '</span>') + td(1, '3') + td(2, '410K')
    + td(3, '21 %') + td(4, '120K') + td(5, '–') + '</tr>'
    // Every agent together: no share of the whole and no median, their cells empty; a cost that
    // holds only some of the agents is a lower bound, marked as the page marks one.
    + '<tr class="ag-wkall"><td>All agents</td>' + td(1, '18') + td(2, '1.9M') + '<td></td><td></td>' + td(5, '~$12.80' + lb) + '</tr>'
    + '</tbody></table></div>'
    + '<p class="meta">3 other combinations</p>'
    + '<div class="name ag-wktop" role="heading" aria-level="4">The 2 largest agents</div><ul>'
    + weekRow({ key: AK.a1, state: 'running', derived: true, title: 'Explore · claude-opus-5 · a94f', names: ['Explore', 'opus-5'], id: 'a94f',
      figs: ['12.3K', '1 %', '~$0.40'], where: ['Session 9d0eb37a', 'Workflow run cfe7718d', 'repo'] })
    + weekRow({ key: AK.a2, state: 'done', derived: false, title: 'Plan · claude-opus-5 · b1c2', names: ['Plan', 'opus-5'], id: 'b1c2',
      figs: ['9.1K', '<1 %', '–'].map((x) => x.replace('<', '&lt;')), where: ['Session 9d0eb37a', 'Workflow run cfe7718d', 'repo'] })
    + '</ul></div>', w)
  // One agent is "the largest agent"; none leaves the heading out.
  const one = weekPart(agentsHtml(a, { agents: agentTree({ week: weekOf({ top: [(weekOf().top as unknown[])[0]] }) }), ui: agentUi({ agentsWeekOpen: true }) }))
  assert.ok(one.indexOf('>The largest agent</div>') >= 0, one)
  const none = weekPart(agentsHtml(a, { agents: agentTree({ week: weekOf({ top: [], other: null }) }), ui: agentUi({ agentsWeekOpen: true }) }))
  assert.equal(none.indexOf('largest'), -1, none)
  assert.equal(none.indexOf('<p class="meta">'), -1, none)
  // No agent with a counted request: one line, no table.
  const empty = weekPart(agentsHtml(a, { agents: agentTree({ week: weekOf({ rows: [], top: [], other: null, total: '–', agents: 0 }) }),
    ui: agentUi({ agentsWeekOpen: true }) }))
  assert.ok(empty.endsWith('<p class="empty">No agent of the last 7 days has a counted request.</p></div>'), empty)
  assert.equal(empty.indexOf('<table'), -1, empty)
  // Open, but a payload without the block (an older build's): the disclosure says open, names no
  // block, and none is drawn.
  const old = agentsHtml(a, { agents: agentTree(), ui: agentUi({ agentsWeekOpen: true }) })
  assert.ok(old.indexOf('<button class="ag-wkbtn" data-act="agentsWeek" aria-expanded="true">Last 7 days</button>') >= 0, old)
  assert.equal(old.indexOf('ag-week"'), -1, old)
  // What the payload carries is escaped, and an item that is none is skipped.
  const poison = weekPart(agentsHtml(a, { agents: agentTree({ week: weekOf({
    rows: [{ type: '<b>', model: '"x"', label: '<img>', agents: 'many', usage: null, share: 7, median: '', cost: '<i>' }, null, 'x'],
    top: [{ key: 'a:<k>', label: '<s>', state: 'rocket', context: '<c>', usage: '<u>', share: '', cost: null }, null, { key: '' }],
    other: '<o>', total: '<t>', totalCost: '<tc> ⚠', agents: -1,
  }) }), ui: agentUi({ agentsWeekOpen: true }) }))
  assert.equal(/<(b|img|i|s|c|u|o|t|tc|k)>/.test(poison), false, poison)
  assert.equal(/undefined|NaN|null|\[object Object\]/.test(poison), false, poison)
  assert.ok(poison.indexOf('title="&lt;b&gt; · &quot;x&quot;"') >= 0, poison)
  assert.equal(poison.split('data-list="week"').length - 1, 1, poison)
  assert.ok(poison.indexOf('class="ag-st ag-unknown"') >= 0, poison)
})

test('without costs the 7-day block names no amount: no cost column, no dollar, no cost on its agents (1.6 L3)', () => {
  const a = agentCtx()
  const rows = (weekOf().rows as Array<Record<string, unknown>>).map((r) => ({ ...r, cost: null }))
  const top = (weekOf().top as Array<Record<string, unknown>>).map((x) => ({ ...x, cost: null }))
  const w = weekPart(agentsHtml(a, { agents: agentTree({ week: weekOf({ rows, top, totalCost: null }) }),
    ui: agentUi({ agentsWeekOpen: true }), showCost: false }))
  assert.equal(w.indexOf('$'), -1, w)
  assert.equal(w.indexOf('Cost'), -1, w)
  assert.equal(w.split('<th>').length - 1, 5, w)
  assert.equal((w.match(/<tr[ >]/g) || []).length, 4, w)
  for (const tr of w.split('<tr').slice(2)) assert.equal((tr.match(/<td/g) || []).length, 5, tr)
  // The largest agents' figures: the usage and the share alone.
  assert.ok(w.indexOf(figs(fig('12.3K'), fig('1 %'))) >= 0, w)
})

test('the details open under the 7-day block\'s row the reader clicked; closed, under the node\'s other row (1.6 L3, N2)', () => {
  const a = agentCtx()
  const pressed = (h: string): string[] => [...h.matchAll(/data-key="([^"]*)"(?:( data-list="(?:now|week)") aria-pressed| data-pressed)="true"/g)]
    .map((m) => m[1] + (m[2] ? '@' + m[2].slice(12, -1) : '@tree'))
  // The running agent is in all three places — the tree (every node open), the running list, the block.
  const page = (selectedIn: string, weekOpen = true): string => agentsHtml(a, {
    agents: agentTree({ selected: detailsOf(), week: weekOf() }),
    ui: openUi({ agentSelected: AK.a1, agentSelectedIn: selectedIn, agentsWeekOpen: weekOpen }),
  })
  const week = page('week')
  assert.deepEqual(pressed(week), [AK.a1 + '@week'])
  assert.equal(week.split('<div class="ag-details"').length - 1, 1, week)
  // Inside the row's item, under its button, in the block.
  const w = weekPart(week)
  assert.ok(w.indexOf('</button>' + panelOf(week) + '</li>') >= 0, w)
  assert.deepEqual(pressed(page('now')), [AK.a1 + '@now'])
  assert.deepEqual(pressed(page('tree')), [AK.a1 + '@tree'])
  // The block closed: its row is gone, and the tree's row takes them — the running list's where
  // the tree has none.
  assert.deepEqual(pressed(page('week', false)), [AK.a1 + '@tree'])
  const noTree = agentsHtml(a, { agents: agentTree({ selected: detailsOf(), week: weekOf() }),
    ui: agentUi({ agentSelected: AK.a1, agentSelectedIn: 'week', agentsWeekOpen: false }) })
  assert.deepEqual(pressed(noTree), [AK.a1 + '@now'])
  // A node the block names alone — its tree row inside a closed session, not running — opens
  // under the block's row whatever place the view state names.
  const only = (selectedIn: string): string => agentsHtml(a, {
    agents: agentTree({ runningNow: [], selected: detailsOf({ key: AK.a2, title: 'Plan · claude-opus-5 · b1c2' }), week: weekOf() }),
    ui: agentUi({ agentSelected: AK.a2, agentSelectedIn: selectedIn, agentsWeekOpen: true }),
  })
  for (const place of ['tree', 'now', 'week']) assert.deepEqual(pressed(only(place)), [AK.a2 + '@week'], place)
})

test('the 7-day block\'s disclosure and its rows post what the host parses; a second click on the row closes it (1.6 L3)', () => {
  const a = agentCtx()
  a.fire('window:message', { origin: '', data: { type: 'data', payload: model({ sections: ['agents'],
    agents: agentTree({ selected: detailsOf(), week: weekOf() }), ui: openUi({ agentSelected: AK.a1, agentSelectedIn: 'week', agentsWeekOpen: true }) }) } })
  a.posted.length = 0
  const button = (act: string, key?: string, list?: string): Record<string, unknown> =>
    ({ tagName: 'BUTTON', dataset: { act, ...(key === undefined ? {} : { key }), ...(list === undefined ? {} : { list }) } })
  const event = (el: Record<string, unknown>): Record<string, unknown> =>
    ({ target: { closest: () => el }, stopPropagation: () => undefined, preventDefault: () => undefined })
  a.fire('document:click', event(button('agentsWeek')))
  // The row the details stand under closes them; another row of the block opens its node under it.
  a.fire('document:click', event(button('agentSelect', AK.a1, 'week')))
  a.fire('document:click', event(button('agentSelect', AK.a2, 'week')))
  // The same node's row of the running list moves them there.
  a.fire('document:click', event(button('agentSelect', AK.a1, 'now')))
  const expected = [
    { type: 'agentsWeek' },
    { type: 'agentSelect', key: null },
    { type: 'agentSelect', key: AK.a2, from: 'week' },
    { type: 'agentSelect', key: AK.a1, from: 'now' },
  ]
  assert.deepEqual(a.posted, expected)
  for (const m of expected) assert.deepEqual(parseWebviewMessage(m), m)
  // Enter and Space on the button are the browser's own click: the keydown fallback leaves them.
  a.fire('document:keydown', { key: 'Enter', target: { closest: () => button('agentsWeek') }, preventDefault: () => undefined })
  assert.equal(a.posted.length, expected.length)
})

test('the 7-day block speaks German on a German page (1.6 L3)', () => {
  const bundle = JSON.parse(readFileSync(join(__dirname, '..', 'l10n', 'bundle.l10n.de.json'), 'utf8')) as Record<string, string>
  const words = ['Last 7 days', 'Last 7 days · where the agent tokens went', 'Type · model', 'Agents', 'Usage', 'Share',
    'Median per agent', '~Cost', 'All agents', 'The {0} largest agents', 'The largest agent',
    'No agent of the last 7 days has a counted request.', 'not every agent has a price: the sum is a lower bound', 'lower bound']
  const de: Record<string, string> = {}
  for (const w of words) {
    assert.ok(Object.prototype.hasOwnProperty.call(DICT, w), w + ' is not a word of the page')
    assert.equal(typeof bundle[w], 'string', 'no German for ' + w)
    de[w] = bundle[w]
  }
  assert.deepEqual([de['Last 7 days'], de['Last 7 days · where the agent tokens went'], de['Type · model'], de['Median per agent'],
    de['~Cost'], de['All agents'], de['The {0} largest agents'], de['The largest agent']],
  ['Letzte 7 Tage', 'Letzte 7 Tage · wohin die Agent-Token gingen', 'Typ · Modell', 'Median je Agent', '~Kosten', 'Alle Agenten',
    'Die {0} größten Agenten', 'Der größte Agent'])
  const c = makeContext()
  nodeVm.runInContext(between(germanPage(de), /<script nonce="[A-Za-z0-9]+">/, '</script>'), c)
  const section = (over: Record<string, unknown>): string => {
    ;(c as Record<string, unknown>).fixture = model({ agents: agentTree(), ui: agentUi(), ...over })
    return String(nodeVm.runInContext('vm = fixture; sAgents()', c))
  }
  const h = section({ agents: agentTree({ week: weekOf() }), ui: agentUi({ agentsWeekOpen: true }) })
  for (const phrase of ['aria-expanded="true" aria-controls="ag-week">Letzte 7 Tage</button>',
    'aria-level="3">Letzte 7 Tage · wohin die Agent-Token gingen</div>',
    '<th>Typ · Modell</th><th>Agenten</th><th>Verbrauch</th><th>Anteil</th><th>Median je Agent</th><th>~Kosten</th>',
    // 1.10 D10 (rewritten: data-hl beside data-h — "{0}:" is German's "{0}:" too, and not in this page's words).
    '<td data-h="Median je Agent" data-hl="Median je Agent:">80K</td>', '<td>Alle Agenten</td>', 'aria-level="4">Die 2 größten Agenten</div>',
    // 1.7 D-A (pinned and changed: the mark was an image named „Untergrenze"): the words in the cell.
    lbMark('nicht jeder Agent hat einen Preis: Die Summe ist eine Untergrenze', 'Untergrenze')]) {
    assert.ok(h.indexOf(phrase) >= 0, phrase + '\n' + h)
  }
  const empty = section({ agents: agentTree({ week: weekOf({ rows: [], top: [] }) }), ui: agentUi({ agentsWeekOpen: true }) })
  assert.ok(empty.indexOf('<p class="empty">Kein Agent der letzten 7 Tage hat eine gezählte Anfrage.</p>') >= 0, empty)
  assert.ok(section({ agents: agentTree({ week: weekOf({ top: [(weekOf().top as unknown[])[0]] }) }), ui: agentUi({ agentsWeekOpen: true }) })
    .indexOf('>Der größte Agent</div>') >= 0)
})

test('the 7-day block\'s rows are rows of the running list\'s kind: the stylesheet stretches them and puts the details under them (1.6 L3)', () => {
  assert.match(STYLE, /\.ag-now \{ display: grid; grid-template-columns: minmax\(0, 1fr\) auto; column-gap: 8px; align-items: center; \}/)
  assert.match(STYLE, /\.ag-now > :not\(:first-child\):not\(\.ag-wkbtn\) \{ grid-column: 1 \/ -1; \}/)
  // A target of 24 px (WCAG 2.5.8); the twisty drawn, silent to a screen reader.
  assert.match(STYLE, /\.ag-wkbtn \{ justify-self: end; min-height: 24px; white-space: nowrap; \}/)
  assert.match(STYLE, /\.ag-wkbtn::after \{ content: "\\00a0▸" \/ ""; font-size: 9px; \}/)
  assert.match(STYLE, /\.ag-wkbtn\[aria-expanded="true"\]::after \{ content: "\\00a0▾" \/ ""; \}/)
  assert.match(STYLE, /\.ag-week li \{ display: flex; flex-wrap: wrap; \}/)
  assert.match(STYLE, /\.ag-week li > \.ag-details \{ flex: 1 1 100%; min-width: 0; \}/)
  // The table's own words break only at a space, the page's "anywhere" left out; stacked, a row is
  // its name, then its figures, as many to a line as fit, the empty cells of the row of all agents not drawn.
  assert.match(STYLE, /\.ag-wkt \{ overflow-wrap: normal; \}/)
  assert.match(STYLE, /\.ag-wkt th, \.ag-wkt td:first-child \{ white-space: normal; \}/)
  assert.match(STYLE, /\.ag-wkt tr\.ag-wkall \{ border-top: 1px solid var\(--line\); \}/)
  assert.match(STYLE, /@media \(max-width: 320px\) \{\n  \.ag-wkt td:first-child::before \{ content: none; \}\n  \.ag-wkt td:not\(:first-child\) \{ display: inline-block; margin-right: 10px; padding: 0; white-space: nowrap; \}\n  \.ag-wkt td:empty \{ display: none; \}\n\}/)
})

interface Rig {
  p: any
  view: any
  posted: any[]
  sections: () => string[]
  live: () => Array<{ at: number; cleared: boolean }>
  advance: (to: number) => void
  setClock: (t: number) => void
  dispose: () => void
}

/**
 * A provider on a clock the test moves, with a view that records what it is sent and hands its
 * dispose handler back. `advance` moves the clock and fires every timer due by then, in the
 * order they fall due — what the event loop would have done in the meantime.
 */
function throttleRig(): Rig {
  const { DashboardProvider } = loadDashboard()
  let now = AG_NOW
  const timers: Array<{ fn: () => void; at: number; cleared: boolean; fired: boolean }> = []
  const clock = {
    now: () => now,
    setTimeout: (fn: () => void, ms: number): unknown => {
      const timer = { fn, at: now + ms, cleared: false, fired: false }
      timers.push(timer)
      return timer
    },
    clearTimeout: (handle: unknown): void => { (handle as { cleared: boolean }).cleared = true },
  }
  const posted: any[] = []
  const disposers: Array<() => void> = []
  const view = {
    visible: true,
    webview: {
      options: {},
      html: '',
      onDidReceiveMessage: () => ({ dispose: () => undefined }),
      postMessage: (m: unknown) => { posted.push(m); return Promise.resolve(true) },
    },
    onDidChangeVisibility: () => ({ dispose: () => undefined }),
    onDidDispose: (fn: () => void) => { disposers.push(fn); return { dispose: () => undefined } },
    show: () => undefined,
  }
  const p = new DashboardProvider(() => undefined, () => undefined, clock)
  const live = (): typeof timers => timers.filter((x) => !x.cleared && !x.fired)
  const advance = (to: number): void => {
    for (;;) {
      const due = live().filter((x) => x.at <= to).sort((x, y) => x.at - y.at)[0]
      if (!due) break
      now = due.at
      due.fired = true
      due.fn()
    }
    now = to
  }
  return {
    p, view, posted, live, advance,
    sections: () => posted.filter((m) => m.type === 'section').map((m) => m.key),
    setClock: (t: number) => { now = t },
    dispose: () => { for (const fn of disposers) fn() },
  }
}

/** A view model with only what the three sections of the rig are built from. */
function flushVm(over: Record<string, unknown> = {}): any {
  return {
    sections: ['quota', 'agents', 'summary'], showCost: true, quotas: [], digest: [],
    agents: flushTree(0), ui: agentUi(), ...over,
  }
}

function flushTree(n: number): Record<string, unknown> {
  return {
    roots: [{ key: 'a:/p/' + n + '.jsonl' }], selected: null, running: 1, omittedRoots: 0,
    truncated: false, note: null,
  }
}

test('the agent tree is pushed at most every two seconds, and no other section waits for it', () => {
  const { SECTION_MIN_INTERVAL_MS } = loadDashboard()
  assert.deepEqual({ ...SECTION_MIN_INTERVAL_MS }, { agents: 2000 })
  const r = throttleRig()
  r.p.update(flushVm({ agents: flushTree(1) }))
  r.p.resolveWebviewView(r.view)
  assert.deepEqual(r.posted.map((m) => m.type), ['data'])

  // Half a second later the tree changed: held back, on one timer, for the rest of the interval.
  r.posted.length = 0
  r.advance(AG_NOW + 500)
  r.p.update(flushVm({ agents: flushTree(2) }))
  assert.deepEqual(r.sections(), [])
  assert.deepEqual(r.live().map((x) => x.at), [AG_NOW + 2000])
  const timer = r.live()[0]

  // The tree again and the summary with it: the summary goes at once, the tree waits — on the
  // same timer, neither a second one nor the first one cleared and set again.
  r.advance(AG_NOW + 600)
  r.p.update(flushVm({ agents: flushTree(3), digest: ['new'] }))
  assert.deepEqual(r.sections(), ['summary'])
  assert.deepEqual(r.live(), [timer])
  assert.equal(timer.cleared, false)

  // The timer flushes again and the tree goes: the newest one, not the one held first.
  r.posted.length = 0
  r.advance(AG_NOW + 2000)
  assert.deepEqual(r.sections(), ['agents'])
  assert.deepEqual(r.posted[0].payload.agents, flushTree(3))
  assert.deepEqual(r.live(), [])

  // A section without an interval of its own is never held, however fast it changes.
  r.posted.length = 0
  r.advance(AG_NOW + 2100)
  r.p.update(flushVm({ agents: flushTree(3), digest: ['newer'] }))
  r.advance(AG_NOW + 2150)
  r.p.update(flushVm({ agents: flushTree(3), digest: ['newest'] }))
  assert.deepEqual(r.sections(), ['summary', 'summary'])
  assert.deepEqual(r.live(), [])
})

test('an unchanged tree is not sent again: two builds five seconds apart from the same records are one payload', () => {
  // 1.6 D12. The tree carried the time it was built at, so every build was a changed section
  // and every push redrew the tree — the throttle's two seconds were the only thing between the
  // page and a redraw per ingest. The records of the world, three hours on (nothing runs any
  // more, nothing is selected), built twice five seconds apart.
  const { agg } = agentWorld()
  const input = makeInput({ agg, cfg: makeConfig() })
  const at = (now: number): any => buildViewModel({ ...input, now }).agents
  const base = input.now + 3 * 3_600_000
  const first = at(base)
  const second = at(base + 5_000)
  assert.equal(first.running, 0)
  assert.equal(first.selected, null)
  assert.ok(first.roots.length > 0)
  // Nothing in the tree is the time it was built at: the two serialise alike.
  assert.equal(JSON.stringify(second), JSON.stringify(first))
  assert.equal('updatedAt' in first, false)
  const r = throttleRig()
  r.p.update(flushVm({ agents: first }))
  r.p.resolveWebviewView(r.view)
  assert.deepEqual(r.posted.map((m) => m.type), ['data'])
  r.posted.length = 0
  r.advance(AG_NOW + 5_000)
  r.p.update(flushVm({ agents: second }))
  assert.deepEqual(r.sections(), [], 'the unchanged tree was sent again')
  assert.deepEqual(r.live(), [], 'a push of it was held for later')
  // A tree that did change still goes, at once after the interval.
  r.p.update(flushVm({ agents: { ...second, running: 1 } }))
  assert.deepEqual(r.sections(), ['agents'])
})

test('an opened node or a selection is answered at once, and the interval counts from that push', () => {
  const r = throttleRig()
  const opened = ['s:/p/1.jsonl']
  r.p.update(flushVm({ agents: flushTree(1) }))
  r.p.resolveWebviewView(r.view)
  // 300 ms after the full push the reader opens a node: nothing about the click waits.
  r.posted.length = 0
  r.advance(AG_NOW + 300)
  r.p.update(flushVm({ agents: flushTree(1), ui: agentUi({ agentsExpanded: opened }) }))
  assert.ok(r.sections().includes('agents'), r.sections().join())
  // The push carries the view state the page draws the tree from.
  const push = r.posted.find((m) => m.type === 'section' && m.key === 'agents')
  assert.deepEqual(push.payload.ui.agentsExpanded, opened)
  // Closing it again is answered at once as well.
  r.posted.length = 0
  r.advance(AG_NOW + 350)
  r.p.update(flushVm({ agents: flushTree(1), ui: agentUi({ agentsExpanded: [] }) }))
  assert.ok(r.sections().includes('agents'), r.sections().join())
  r.posted.length = 0
  r.advance(AG_NOW + 360)
  r.p.update(flushVm({ agents: flushTree(1), ui: agentUi({ agentsExpanded: opened }) }))
  assert.ok(r.sections().includes('agents'), r.sections().join())
  // 1.6 L3: the 7-day block's disclosure is the reader's too, and is answered at once.
  r.posted.length = 0
  r.advance(AG_NOW + 370)
  r.p.update(flushVm({ agents: { ...flushTree(1), week: { rows: [] } }, ui: agentUi({ agentsExpanded: opened, agentsWeekOpen: true }) }))
  assert.ok(r.sections().includes('agents'), r.sections().join())
  assert.equal(r.posted.find((m) => m.type === 'section' && m.key === 'agents').payload.ui.agentsWeekOpen, true)
  r.posted.length = 0
  r.advance(AG_NOW + 380)
  r.p.update(flushVm({ agents: flushTree(1), ui: agentUi({ agentsExpanded: opened }) }))
  assert.ok(r.sections().includes('agents'), r.sections().join())
  // A selection, which changes the details the tree carries as well, goes at once too.
  r.posted.length = 0
  r.advance(AG_NOW + 400)
  const ui = agentUi({ agentsExpanded: opened, agentSelected: 'a:/p/1.jsonl' })
  r.p.update(flushVm({ agents: { ...flushTree(1), selected: { key: 'a:/p/1.jsonl' } }, ui }))
  assert.ok(r.sections().includes('agents'), r.sections().join())
  assert.deepEqual(r.live(), [])
  // Live data a moment later waits out the interval from the click's push.
  r.posted.length = 0
  r.advance(AG_NOW + 500)
  r.p.update(flushVm({ agents: { ...flushTree(2), selected: { key: 'a:/p/1.jsonl' } }, ui }))
  assert.deepEqual(r.sections(), [])
  assert.deepEqual(r.live().map((x) => x.at), [AG_NOW + 2400])
  r.advance(AG_NOW + 2399)
  assert.deepEqual(r.sections(), [])
  r.advance(AG_NOW + 2400)
  assert.deepEqual(r.sections(), ['agents'])
})

test('a held tree waits for nothing once the whole page is pushed, and its timer dies with the view', () => {
  const r = throttleRig()
  const layout = ['agents', 'quota', 'summary']
  r.p.update(flushVm({ agents: flushTree(1) }))
  r.p.resolveWebviewView(r.view)
  r.advance(AG_NOW + 500)
  r.p.update(flushVm({ agents: flushTree(2) }))
  const first = r.live()
  assert.equal(first.length, 1)
  // A layout change forces a full push, which carries the held tree along.
  r.posted.length = 0
  r.p.update(flushVm({ agents: flushTree(2), sections: layout }))
  assert.deepEqual(r.posted.map((m) => m.type), ['data'])
  assert.equal(first[0].cleared, true)
  assert.deepEqual(r.live(), [])
  // Held again, and the view goes away: the timer goes with it.
  r.advance(AG_NOW + 600)
  r.p.update(flushVm({ agents: flushTree(3), sections: layout }))
  const second = r.live()
  assert.equal(second.length, 1)
  r.dispose()
  assert.equal(second[0].cleared, true)
  assert.deepEqual(r.live(), [])
})

test('a held tree dies with the provider too, and a disposed provider arms nothing again', () => {
  const r = throttleRig()
  r.p.update(flushVm({ agents: flushTree(1) }))
  r.p.resolveWebviewView(r.view)
  r.advance(AG_NOW + 500)
  r.p.update(flushVm({ agents: flushTree(2) }))
  const held = r.live()
  assert.equal(held.length, 1)
  // The extension goes while the tree waits: its timer goes with it, and nothing is sent after —
  // not when the interval is over, not for a later model.
  r.posted.length = 0
  r.p.dispose()
  assert.equal(held[0].cleared, true)
  r.advance(AG_NOW + 5000)
  r.p.update(flushVm({ agents: flushTree(3), digest: ['later'] }))
  assert.deepEqual(r.posted, [])
  assert.deepEqual(r.live(), [])
})

test('a clock that went backwards holds nothing back', () => {
  const r = throttleRig()
  r.p.update(flushVm({ agents: flushTree(1) }))
  r.p.resolveWebviewView(r.view)
  // The system clock was set back a minute: an interval counted from the last push would not
  // end for a minute, so the tree goes at once and the interval counts from there.
  r.posted.length = 0
  r.setClock(AG_NOW - 60_000)
  r.p.update(flushVm({ agents: flushTree(2) }))
  assert.deepEqual(r.sections(), ['agents'])
  assert.deepEqual(r.live(), [])
  r.posted.length = 0
  r.setClock(AG_NOW - 59_000)
  r.p.update(flushVm({ agents: flushTree(3) }))
  assert.deepEqual(r.sections(), [])
  assert.deepEqual(r.live().map((x) => x.at), [AG_NOW - 58_000])
})

// ---------------------------------------------------------------------------
// 1.5 fix pass: pushes only for what is on the page, and the marks where they belong
// ---------------------------------------------------------------------------

test('the host pushes a fragment only for a section on the page, or for the chrome around it', () => {
  const r = throttleRig()
  r.p.update(flushVm())
  r.p.resolveWebviewView(r.view)
  assert.deepEqual(r.posted.map((m) => m.type), ['data'])
  r.posted.length = 0
  // Records and tools are not in the list: their changes stay on the host. The summary is, and
  // goes; so does the footer, which every page has.
  r.p.update(flushVm({ records: { changed: 1 }, tools: { changed: 1 }, digest: ['new'], generatedAt: 'later' }))
  assert.deepEqual(r.sections().sort(), ['footer', 'summary'])
  // Once a section is added to the list the layout changed, and that push is a whole page.
  r.posted.length = 0
  r.p.update(flushVm({ sections: ['quota', 'agents', 'summary', 'records'], records: { changed: 2 }, digest: ['new'], generatedAt: 'later' }))
  assert.deepEqual(r.posted.map((m) => m.type), ['data'])
  r.posted.length = 0
  r.p.update(flushVm({ sections: ['quota', 'agents', 'summary', 'records'], records: { changed: 3 }, digest: ['new'], generatedAt: 'later' }))
  assert.deepEqual(r.sections(), ['records'])
})

test('a provider switch pushes the switch and exactly the sections whose fields it changed — never a whole page, the Agents section at once (1.7 F1)', () => {
  const { SECTION_FIELDS } = loadDashboard()
  const { DASHBOARD_SECTION_KEYS } = require('../src/viewModel') as typeof import('../src/viewModel')
  // Every section on the page, and something in each of the per-provider parts.
  const cfg = makeConfig({
    'tokenPace.dashboard.sections': [...DASHBOARD_SECTION_KEYS],
    'tokenPace.attribution': 'session',
    'tokenPace.budgets': [
      { scope: 'total', period: 'month', unit: 'usd', limit: 20 },
      { scope: 'claude', period: 'day', unit: 'tokens', limit: 5_000_000 },
    ],
  })
  const built = (providers: ('claude' | 'codex')[]): any => buildViewModel(makeInput({ cfg, ui: { providers } }))
  const all = built(['claude', 'codex'])
  const codex = built(['codex'])
  // What each section is compared by, as the provider compares it: a `ui.<field>` by that field.
  const field = (vm: any, f: string): unknown => (f.startsWith('ui.') ? vm.ui[f.slice(3)] : vm[f])
  const changed = (a: any, b: any): string[] => Object.entries(SECTION_FIELDS)
    .filter(([, fields]) => JSON.stringify(fields.map((f) => field(a, f))) !== JSON.stringify(fields.map((f) => field(b, f))))
    .map(([key]) => key).sort()
  const r = throttleRig()
  r.p.update(all)
  r.p.resolveWebviewView(r.view)
  assert.deepEqual(r.posted.map((m) => m.type), ['data'])
  r.posted.length = 0
  r.advance(AG_NOW + 10_000)
  r.p.update(codex)
  assert.deepEqual(r.posted.map((m) => m.type).filter((x) => x !== 'section'), [], 'a switch pushed a whole page')
  assert.deepEqual([...r.sections()].sort(), changed(all, codex))
  // By name, so the comparison above cannot agree with a list that forgot one: the switch itself,
  // the sections that follow it, the two Claude Code–only ones going, the bar and the footnote.
  for (const key of ['provider', 'quota', 'agents', 'context', 'tokens', 'summary', 'kpis', 'chart', 'models', 'budget',
    'history', 'dataQuality', 'controls', 'footer']) {
    assert.ok(r.sections().includes(key), `${key} was not pushed: ${r.sections().join()}`)
  }
  // Chrome the switch does not change stays where it is.
  for (const key of ['notices', 'drill']) assert.equal(r.sections().includes(key), false, `${key} was pushed`)
  // The fragments carry what the page draws the switch and the two sections from. 1.9 A3.1 (pinned and
  // changed: the switch alone): the block is the top row, the language picker beside the switch.
  const push = (key: string): any => r.posted.find((m) => m.type === 'section' && m.key === key)
  assert.deepEqual(push('provider').payload, { provider: 'codex', language: codex.language })
  assert.equal(push('agents').payload.claudeOnly, 'Claude Code only — not shown while Codex is selected.')
  assert.equal(push('context').payload.provider, 'codex')
  // Back to All 300 ms later: the Agents section is the reader's own click, answered at once —
  // its two seconds bound live data, not the switch — and it comes back as a fragment again.
  r.posted.length = 0
  r.advance(AG_NOW + 10_300)
  r.p.update(built(['claude', 'codex']))
  assert.deepEqual(r.posted.map((m) => m.type).filter((x) => x !== 'section'), [])
  assert.ok(r.sections().includes('agents'), r.sections().join())
  assert.equal(push('agents').payload.claudeOnly, null)
  assert.deepEqual(r.live(), [], 'a section of the switch was held back')
  assert.deepEqual([...r.sections()].sort(), changed(codex, all))
})

// ---------------------------------------------------------------------------
// 1.7 F1: the provider switch, the page side
// ---------------------------------------------------------------------------

const CLAUDE_ONLY = 'Claude Code only — not shown while Codex is selected.'

/**
 * The switch's markup for the view `shown`: one button per provider of the registry, then All. 1.9 A3.1
 * (pinned and changed: the group was the block's whole markup): the group stands in the page's top row,
 * and `picker` — the language picker's markup, none for a payload without `language` — at its end.
 */
function switchHtml(shown: string, words: { label: string; all: string } = { label: 'Providers', all: 'All' }, picker = ''): string {
  const b = (src: string, name: string): string =>
    '<button data-act="providerView" data-src="' + src + '" aria-pressed="' + (src === shown) + '">' + name + '</button>'
  return '<div class="top"><div class="pv" role="group" aria-label="' + words.label + '">'
    + b('claude', 'Claude Code') + b('codex', 'Codex') + b('all', words.all) + '</div>' + picker + '</div>'
}

/** 1.9 A3.2: the language picker as the page draws it for a whole view model (closed). */
function pickerHtml(vm: Record<string, unknown>): string {
  ;(ctx as Record<string, unknown>).fixture = vm
  const h = String(nodeVm.runInContext('vm = fixture; langOpen = false; sLanguage()', ctx))
  assert.ok(h.startsWith('<div class="lng"><button class="lng-btn"'), h)
  return h
}

/** A real view model of the agent world with a context reading, every section listed, under `providers`. */
function switchVm(providers?: ('claude' | 'codex')[]): Record<string, unknown> {
  const { DASHBOARD_SECTION_KEYS } = require('../src/viewModel') as typeof import('../src/viewModel')
  const { agg } = agentWorld()
  const input = {
    ...makeInput({
      agg,
      cfg: makeConfig({ 'tokenPace.dashboard.sections': [...DASHBOARD_SECTION_KEYS] }),
      ...(providers ? { ui: { providers } } : {}),
    }),
    context: { used: 128_000, size: 200_000, usedPct: 64, fetchedAt: Math.round((NOW - 120_000) / 1000) },
  }
  return JSON.parse(JSON.stringify(buildViewModel(input))) as Record<string, unknown>
}

/** A page context drawn from a whole view model (not the renderers' defaults), and what it wrote. */
function pageOf(vm: Record<string, unknown>, script = SCRIPT): string {
  const root = { innerHTML: '', dataset: {}, style: {} }
  const c = nodeVm.createContext({
    acquireVsCodeApi: () => ({ postMessage: () => undefined }),
    document: { addEventListener: () => undefined, getElementById: () => root, querySelector: () => null, querySelectorAll: () => [] },
    window: { addEventListener: () => undefined },
    console,
  })
  nodeVm.runInContext(script, c)
  ;(c as Record<string, unknown>).fixture = vm
  nodeVm.runInContext('vm = fixture; renderAll();', c)
  return String(root.innerHTML)
}

test('the provider switch is the page\'s first element: a labelled group of the registry\'s providers and All, the shown one pressed (1.7 F1)', () => {
  // First, above the notices and the quota cards — whatever the section order says.
  for (const sections of [['quota', 'summary'], ['summary', 'quota'], ['kpis']]) {
    const h = renderPage({ sections, provider: 'all' })
    assert.deepEqual(orderOf(h).slice(0, 2), ['provider', 'notices'], h)
    assert.ok(h.startsWith('<div data-sec="provider" data-body="provider">' + switchHtml('all') + '</div><div data-sec="notices"'), h)
  }
  // One button per provider of the registry, in its order and by its title, then All; exactly one
  // pressed — the one the view model shows.
  for (const shown of ['all', 'claude', 'codex']) {
    const h = render('sProvider()', { provider: shown })
    assert.equal(h, switchHtml(shown))
    assert.equal(h.split('aria-pressed="true"').length - 1, 1, h)
    assert.equal(h.split('role="group"').length - 1, 1, h)
  }
  // A payload without the field (a build before the switch), or with a view this page does not
  // know, shows every provider — and names nothing it was sent.
  assert.equal(render('sProvider()'), switchHtml('all'))
  const odd = render('sProvider()', { provider: '<b>gemini</b>' })
  assert.equal(odd, switchHtml('all'))
  // The filter bar has no providers' row any more.
  assert.equal(render('controls()').indexOf('data-act="provider'), -1)
  // The block is drawn by the same renderer a fragment for it uses.
  assert.equal(nodeVm.runInContext('renderer("provider") === sProvider', ctx), true)
  // The page's chips on one line, each button at least 24 px square (WCAG 2.5.8); no colour of its
  // own — the pressed one wears the page's pressed-chip colours, and in a forced-colours theme the
  // highlight (the one rule for every pressed chip, which the buttons meet: they carry no class).
  assert.match(STYLE, /\n\.pv \{ display: flex; flex-wrap: nowrap; gap: 4px; align-items: center; \}\n/)
  assert.match(STYLE, /\n\.pv button \{ min-height: 24px; min-width: 24px; white-space: nowrap; \}\n/)
  assert.equal(/\.pv[^{]*\{[^}]*(color|background)/.test(STYLE), false)
})

test('the provider switch speaks German with the shipped bundle: „Anbieter", „Alle" (1.7 F1)', () => {
  const bundle = JSON.parse(readFileSync(join(__dirname, '..', 'l10n', 'bundle.l10n.de.json'), 'utf8')) as Record<string, string>
  assert.equal(bundle.All, 'Alle')
  assert.equal(bundle.Providers, 'Anbieter')
  assert.ok(Object.prototype.hasOwnProperty.call(DICT, 'All'), 'All is not a word of the page')
  const c = makeContext()
  nodeVm.runInContext(between(germanPage({ All: bundle.All }), /<script nonce="[A-Za-z0-9]+">/, '</script>'), c)
  ;(c as Record<string, unknown>).fixture = model({ provider: 'codex' })
  const h = String(nodeVm.runInContext('vm = fixture; sProvider()', c))
  // The product names are never translated.
  assert.equal(h, switchHtml('codex', { label: 'Anbieter', all: 'Alle' }))
})

test('under Codex the Agents and Context sections are left out — no heading, fold, gear or tree, the reason nowhere — the order of the rest unchanged (1.7 F1, §7a Q7)', () => {
  const all = switchVm()
  const codex = switchVm(['codex'])
  const claude = switchVm(['claude'])
  assert.equal(codex.claudeOnly, CLAUDE_ONLY)
  const hAll = pageOf(all), hCodex = pageOf(codex), hClaude = pageOf(claude)
  // Under All and under Claude Code both sections are on the page, the tree and the context card in them.
  for (const h of [hAll, hClaude]) {
    for (const key of ['agents', 'context']) {
      assert.ok(h.indexOf('<section data-sec="' + key + '"><details open><summary data-act="section" data-key="' + key + '">') >= 0, key)
    }
    assert.ok(h.indexOf('role="tree"') >= 0)
    assert.equal(h.indexOf(CLAUDE_ONLY), -1)
  }
  // Under Codex neither: no section, no body, no heading, no gear, no tree, and not the sentence
  // that says why — the view model's reason is no placeholder on the page.
  for (const key of ['agents', 'context']) {
    assert.equal(hCodex.indexOf('data-sec="' + key + '"'), -1, key)
    assert.equal(hCodex.indexOf('data-body="' + key + '"'), -1, key)
    assert.equal(hCodex.indexOf('data-key="' + key + '"'), -1, key)
  }
  assert.equal(hCodex.indexOf('<h2>Agents</h2>'), -1)
  assert.equal(hCodex.indexOf('<h2>Context window</h2>'), -1)
  assert.equal(hCodex.indexOf('role="tree"'), -1)
  assert.equal(hCodex.indexOf(CLAUDE_ONLY), -1)
  assert.equal(hCodex.indexOf('Claude Code only'), -1)
  // Every other block where it stood: the order is the All page's without the two.
  assert.deepEqual(orderOf(hCodex), orderOf(hAll).filter((k) => k !== 'agents' && k !== 'context'))
  assert.deepEqual(orderOf(hClaude), orderOf(hAll))
  // The switch says which view it is, and under one provider the footer carries its footnote.
  // 1.9 A3.1: a real view model carries the language picker, drawn at the end of the top row.
  assert.ok(hCodex.startsWith('<div data-sec="provider" data-body="provider">' + switchHtml('codex', undefined, pickerHtml(codex))), hCodex.slice(0, 400))
  assert.ok(hClaude.startsWith('<div data-sec="provider" data-body="provider">' + switchHtml('claude', undefined, pickerHtml(claude))), hClaude.slice(0, 400))
  const note = 'Showing Codex only — the provider switch at the top of the dashboard; ‘All’ shows every provider.'
  assert.ok(hCodex.indexOf('<li>' + note + '</li>') > hCodex.indexOf('data-sec="footer"'), 'the footnote is not in the footer')
  assert.equal(hAll.indexOf('Showing '), -1)
  // The quota section holds the shown provider's card only.
  const quota = (h: string): string => h.slice(h.indexOf('<section data-sec="quota">'), h.indexOf('</section>', h.indexOf('<section data-sec="quota">')))
  assert.ok(quota(hCodex).indexOf('<span class="name">Codex</span>') >= 0 && quota(hCodex).indexOf('<span class="name">Claude Code</span>') < 0)
  assert.ok(quota(hClaude).indexOf('<span class="name">Claude Code</span>') >= 0 && quota(hClaude).indexOf('<span class="name">Codex</span>') < 0)
})

/**
 * A page whose blocks are fakes that record what the page does to them: `present` the keys whose
 * body is on the page, in their order; a body's section can be taken out (its parent's removeChild)
 * or have a section inserted after it (insertAdjacentHTML), and so can the notices block.
 */
function placeCtx(present: string[]): { c: nodeVm.Context; present: string[]; log: string[]; bodies: Record<string, { innerHTML: string }> } {
  const log: string[] = []
  const bodies: Record<string, { innerHTML: string }> = {}
  const root = { removeChild: (sec: { key: string }) => { log.push('out ' + sec.key); present.splice(present.indexOf(sec.key), 1) } }
  const after = (key: string) => (where: string, html: string): void => {
    const m = /^<section data-sec="([a-zA-Z]+)">/.exec(html)
    log.push('in ' + (m ? m[1] : '?') + ' after ' + key + ' ' + where)
    if (m) present.splice(key === 'notices' ? 0 : present.indexOf(key) + 1, 0, m[1])
    if (m) bodyOf(m[1]).innerHTML = html
  }
  const bodyOf = (key: string): { innerHTML: string } => (bodies[key] ??= Object.assign({ innerHTML: 'drawn before' }, {
    dataset: {}, style: {}, contains: () => false,
    closest: (sel: string) => (sel === 'section' ? { key, parentNode: root, contains: () => false, insertAdjacentHTML: after(key) } : null),
  }))
  const doc = {
    addEventListener: () => undefined, getElementById: () => null, querySelectorAll: () => [], activeElement: null,
    querySelector: (sel: string) => {
      const m = /^\[data-body="([a-zA-Z]+)"\]$/.exec(sel)
      if (m) return present.includes(m[1]) ? bodyOf(m[1]) : null
      return sel === '[data-sec="notices"]' ? { insertAdjacentHTML: after('notices') } : null
    },
  }
  const c = nodeVm.createContext({
    acquireVsCodeApi: () => ({ postMessage: () => undefined }), document: doc,
    window: { addEventListener: () => undefined }, console,
  })
  nodeVm.runInContext(SCRIPT, c)
  return { c, present, log, bodies }
}

test('a switch to Codex takes the Agents and Context sections out as fragments, and the switch back puts them at their place — nothing else rewritten (1.7 F1, §7a Q7)', () => {
  const p = placeCtx(['quota', 'agents', 'context', 'summary'])
  ;(p.c as Record<string, unknown>).fixture = model({ sections: ['quota', 'agents', 'context', 'summary'], agents: agentTree(), ui: agentUi(), provider: 'all', claudeOnly: null })
  nodeVm.runInContext('vm = fixture;', p.c)
  const push = (key: string, payload: Record<string, unknown>): void => {
    ;(p.c as Record<string, unknown>).payload = payload
    nodeVm.runInContext('Object.assign(vm, payload); renderSection(' + JSON.stringify(key) + ');', p.c)
  }
  // The host's fragments for a switch to Codex, in its order: the two sections go, whole.
  push('agents', { agents: agentTree(), ui: agentUi(), provider: 'codex', claudeOnly: CLAUDE_ONLY })
  push('context', { context: null, provider: 'codex', claudeOnly: CLAUDE_ONLY })
  assert.deepEqual(p.log, ['out agents', 'out context'])
  assert.deepEqual(p.present, ['quota', 'summary'])
  // A later push for a section that is left out finds nothing to take out and draws nothing.
  push('agents', { agents: agentTree(), ui: agentUi(), provider: 'codex', claudeOnly: CLAUDE_ONLY })
  assert.deepEqual(p.log, ['out agents', 'out context'])
  // The switch back: each is drawn after the nearest listed section on the page — the Agents
  // section under the quota cards, the context under the Agents section — as renderAll would.
  push('agents', { agents: agentTree(), ui: agentUi(), provider: 'all', claudeOnly: null })
  push('context', { context: null, provider: 'all', claudeOnly: null })
  assert.deepEqual(p.log.slice(2), ['in agents after quota afterend', 'in context after agents afterend'])
  assert.deepEqual(p.present, ['quota', 'agents', 'context', 'summary'])
  // Drawn whole, heading, fold and gear, the tree in it.
  const agents = p.bodies.agents.innerHTML
  assert.ok(agents.startsWith('<section data-sec="agents"><details open><summary data-act="section" data-key="agents"><h2>Agents</h2>'
    + '<button class="gear" data-act="sectionSettings" data-key="agents"'), agents)
  assert.ok(agents.indexOf('</summary><div data-body="agents">') >= 0, agents)
  assert.ok(agents.indexOf('role="tree"') >= 0, agents)
  // Nothing else was rewritten, and a fragment of a section on the page is a fragment as before.
  assert.equal(p.bodies.quota.innerHTML, 'drawn before')
  assert.equal(p.bodies.summary, undefined)
  push('agents', { agents: agentTree(), ui: agentUi(), provider: 'all', claudeOnly: null })
  assert.equal(p.log.length, 4)
  assert.equal(p.bodies.agents.innerHTML.startsWith('<section'), false, p.bodies.agents.innerHTML.slice(0, 80))
  assert.ok(p.bodies.agents.innerHTML.indexOf('role="tree"') >= 0)
  // Listed first, a section comes back directly under the notices; not listed, it comes back nowhere
  // — which sections exist is the layout's, a whole-page push.
  const q = placeCtx(['summary'])
  ;(q.c as Record<string, unknown>).fixture = model({ sections: ['agents', 'summary'], agents: agentTree(), ui: agentUi(), provider: 'all', claudeOnly: null })
  nodeVm.runInContext('vm = fixture; renderSection("agents"); renderSection("context");', q.c)
  assert.deepEqual(q.log, ['in agents after notices afterend'])
  assert.deepEqual(q.present, ['agents', 'summary'])
})

test('the pressed button of the switch keeps the focus across the push that answers it (1.7 F1)', () => {
  const focused: string[] = []
  const inside = new Set<unknown>()
  let drawn: Array<Record<string, unknown>> = []
  const button = (src: string, name: string): Record<string, unknown> =>
    ({ dataset: { act: 'providerView', src }, focus: () => { focused.push(name) } })
  const body = {
    innerHTML: '', dataset: {}, style: {},
    contains: (el: unknown) => inside.has(el),
    querySelectorAll: (sel: string) => (sel === '[data-act]' ? drawn : []),
  }
  const doc: Record<string, unknown> = {
    addEventListener: () => undefined, getElementById: () => null, querySelectorAll: () => [], activeElement: null,
    querySelector: (s: string) => (s === '[data-body="provider"]' || s === '[data-body="quota"]' ? body : null),
  }
  const c = nodeVm.createContext({
    acquireVsCodeApi: () => ({ postMessage: () => undefined }), document: doc,
    window: { addEventListener: () => undefined }, console,
  })
  nodeVm.runInContext(SCRIPT, c)
  ;(c as Record<string, unknown>).fixture = model({ provider: 'codex' })
  nodeVm.runInContext('vm = fixture;', c)
  const push = (active: Record<string, unknown> | null, key = 'provider'): string[] => {
    focused.length = 0
    inside.clear()
    if (active) inside.add(active)
    doc.activeElement = active
    drawn = [button('claude', 'claude-new'), button('codex', 'codex-new'), button('all', 'all-new')]
    nodeVm.runInContext('renderSection(' + JSON.stringify(key) + ');', c)
    return [...focused]
  }
  // The reader pressed Codex; the host's answer rewrites the switch, and the focus is on Codex again.
  assert.deepEqual(push(button('codex', 'codex-old')), ['codex-new'])
  assert.equal(body.innerHTML, switchHtml('codex'))
  assert.deepEqual(push(button('all', 'all-old')), ['all-new'])
  // The switch rewritten while the focus was elsewhere takes it nowhere; another block keeps no focus of the switch's.
  assert.deepEqual(push(null), [])
  assert.deepEqual(push(button('codex', 'codex-old'), 'quota'), [])
})

test('a switch button asks for its view; the pressed one, an unknown one and one without a name ask for nothing (1.7 F1)', () => {
  const a = agentCtx()
  const pageWith = (provider: string): void => a.fire('window:message', {
    origin: '', data: { type: 'data', payload: model({ sections: ['quota'], provider }) },
  })
  const click = (src?: string): void => a.fire('document:click', {
    target: { closest: () => ({ tagName: 'BUTTON', dataset: { act: 'providerView', ...(src === undefined ? {} : { src }) } }) },
    stopPropagation: () => undefined, preventDefault: () => undefined,
  })
  pageWith('all')
  a.posted.length = 0
  const drawn = a.root.innerHTML
  click('claude')
  click('codex')
  click('all')
  click('gemini')
  click('')
  click()
  assert.deepEqual(a.posted, [{ type: 'setProvider', provider: 'claude' }, { type: 'setProvider', provider: 'codex' }])
  // Nothing is drawn before the host answers: a click only asks.
  assert.equal(a.root.innerHTML, drawn)
  pageWith('codex')
  a.posted.length = 0
  click('codex')
  click('all')
  assert.deepEqual(a.posted, [{ type: 'setProvider', provider: 'all' }])
  // Every message a button posts is one the host's parser takes as it is.
  for (const m of [{ type: 'setProvider', provider: 'claude' }, { type: 'setProvider', provider: 'codex' }, { type: 'setProvider', provider: 'all' }]) {
    assert.deepEqual(parseWebviewMessage(m), m)
  }
})

test('a fragment for a section with no body on the page updates the model and rewrites nothing', () => {
  const a = agentCtx()
  a.fire('window:message', { origin: '', data: { type: 'data', payload: model({ sections: ['agents'], agents: agentTree(), ui: agentUi() }) } })
  assert.ok(a.root.innerHTML.length > 0)
  a.root.innerHTML = 'untouched'
  a.posted.length = 0
  a.fire('window:message', { origin: '', data: { type: 'section', key: 'records', payload: { records: { marker: 7 } } } })
  assert.equal(a.root.innerHTML, 'untouched', 'the whole page was rewritten for a section that is not on it')
  assert.deepEqual(a.posted, [])
  assert.equal(nodeVm.runInContext('vm.records.marker', a.c), 7, 'the payload was dropped')
})

// ---------------------------------------------------------------------------
// 1.8 L-1, L-3: push hygiene — no fragment the page drops unread, no second copy of the budgets
// ---------------------------------------------------------------------------

/**
 * 1.8 L-1: the rig's view model under a provider view — All, or Codex with the reason the page leaves
 * the Agents and Context sections out — the tree, the context reading and the quota cards all at
 * build `n`, so every build changes all three.
 */
function viewVm(view: 'all' | 'codex', n: number, over: Record<string, unknown> = {}): any {
  return flushVm({
    sections: ['quota', 'agents', 'context', 'summary'],
    provider: view,
    claudeOnly: view === 'all' ? null : CLAUDE_ONLY,
    agents: flushTree(n),
    context: { used: 1_000 + n },
    quotas: [{ build: n }],
    ...over,
  })
}

/** How many fragments of `key` the rig was sent, and the last one. */
function fragments(r: Rig, key: string): { count: number; last: any } {
  const of = r.posted.filter((m) => m.type === 'section' && m.key === key)
  return { count: of.length, last: of[of.length - 1] }
}

test('under Codex the Agents and Context sections are pushed once — the fragments that take them out — and not again while their data changes; back to All each comes whole with the newest data (1.8 L-1)', () => {
  const r = throttleRig()
  let t = AG_NOW
  r.p.update(viewVm('all', 0))
  r.p.resolveWebviewView(r.view)
  assert.deepEqual(r.posted.map((m) => m.type), ['data'])
  // The switch to Codex ten seconds on: one fragment of each, carrying the view the page takes the
  // section out for (1.7 F1's `placeSection`), nothing held.
  r.posted.length = 0
  t += 10_000
  r.advance(t)
  r.p.update(viewVm('codex', 0))
  assert.equal(fragments(r, 'agents').count, 1, r.sections().join())
  assert.equal(fragments(r, 'context').count, 1, r.sections().join())
  assert.deepEqual([fragments(r, 'agents').last.payload.provider, fragments(r, 'agents').last.payload.claudeOnly], ['codex', CLAUDE_ONLY])
  assert.deepEqual([fragments(r, 'context').last.payload.provider, fragments(r, 'context').last.payload.claudeOnly], ['codex', CLAUDE_ONLY])
  assert.deepEqual(r.live(), [])
  // Ten builds five seconds apart while an agent runs — the view model's rebuild interval: the tree,
  // the context reading and the quota cards change with each. The page would drop every fragment of
  // the two sections unread; none goes, and no timer waits for one. The quota cards go as before.
  r.posted.length = 0
  for (let i = 1; i <= 10; i++) {
    t += 5_000
    r.advance(t)
    r.p.update(viewVm('codex', i))
  }
  assert.equal(fragments(r, 'agents').count, 0, 'an Agents fragment went while the page leaves the section out')
  assert.equal(fragments(r, 'context').count, 0, 'a Context fragment went while the page leaves the section out')
  assert.equal(fragments(r, 'quota').count, 10, r.sections().join())
  assert.deepEqual(r.live(), [], 'a timer was armed for a section the page drops')
  // Back to All, 300 ms after the last build: the reader's own click, answered at once — each section
  // once, whole, with the tenth build's data, the view that puts it back.
  r.posted.length = 0
  t += 300
  r.advance(t)
  r.p.update(viewVm('all', 10))
  assert.equal(fragments(r, 'agents').count, 1, r.sections().join())
  assert.equal(fragments(r, 'context').count, 1, r.sections().join())
  const back = fragments(r, 'agents').last.payload
  assert.deepEqual(back.agents, flushTree(10), 'the tree that came back is not the newest one')
  assert.deepEqual([back.provider, back.claudeOnly], ['all', null])
  assert.deepEqual(back.ui, agentUi(), 'the section came back without the view state it is drawn from')
  assert.deepEqual(fragments(r, 'context').last.payload, { context: { used: 1_010 }, provider: 'all', claudeOnly: null })
  assert.deepEqual(r.live(), [])
  // Under All the section is live again: its next change goes, after its interval as ever.
  r.posted.length = 0
  t += 5_000
  r.advance(t)
  r.p.update(viewVm('all', 11))
  assert.deepEqual(fragments(r, 'agents').last.payload.agents, flushTree(11))
  // And the next switch to Codex takes both out again, one fragment each, then quiet again.
  r.posted.length = 0
  t += 5_000
  r.advance(t)
  r.p.update(viewVm('codex', 12))
  t += 5_000
  r.advance(t)
  r.p.update(viewVm('codex', 13))
  assert.equal(fragments(r, 'agents').count, 1, r.sections().join())
  assert.equal(fragments(r, 'context').count, 1, r.sections().join())
  assert.deepEqual(fragments(r, 'agents').last.payload.agents, flushTree(12))
})

test('a page opened under Codex has the two sections out from its first push, a whole push under Codex changes nothing of that, and a tree held back before a switch is not pushed after it (1.8 L-1)', () => {
  const r = throttleRig()
  let t = AG_NOW
  r.p.update(viewVm('codex', 0))
  r.p.resolveWebviewView(r.view)
  assert.deepEqual(r.posted.map((m) => m.type), ['data'])
  // The whole page carried the view: nothing of the two sections follows it while the view stays.
  r.posted.length = 0
  for (let i = 1; i <= 5; i++) {
    t += 5_000
    r.advance(t)
    r.p.update(viewVm('codex', i))
  }
  assert.deepEqual([fragments(r, 'agents').count, fragments(r, 'context').count, fragments(r, 'quota').count], [0, 0, 5], r.sections().join())
  // A layout change is a whole page, as before — and after it the two sections stay quiet.
  const layout = ['quota', 'summary', 'agents', 'context']
  r.posted.length = 0
  t += 5_000
  r.advance(t)
  r.p.update(viewVm('codex', 6, { sections: layout }))
  assert.deepEqual(r.posted.map((m) => m.type), ['data'])
  assert.deepEqual(r.posted[0].payload.agents, flushTree(6))
  r.posted.length = 0
  for (let i = 7; i <= 9; i++) {
    t += 5_000
    r.advance(t)
    r.p.update(viewVm('codex', i, { sections: layout }))
  }
  assert.deepEqual([fragments(r, 'agents').count, fragments(r, 'context').count], [0, 0], r.sections().join())
  // Back to All: each section once, with the newest data.
  r.posted.length = 0
  t += 5_000
  r.advance(t)
  r.p.update(viewVm('all', 9, { sections: layout }))
  assert.deepEqual([fragments(r, 'agents').count, fragments(r, 'context').count], [1, 1], r.sections().join())
  assert.deepEqual(fragments(r, 'agents').last.payload.agents, flushTree(9))
  // Under All a tree changes 500 ms after that push: held back for its interval, on its timer. The
  // switch to Codex 100 ms later goes at once — the fragment that takes the section out, with the
  // newest tree —; a tree newer still, 100 ms after that, arms nothing, and when the first timer
  // fires, its flush pushes nothing of the section either.
  r.posted.length = 0
  t += 500
  r.advance(t)
  r.p.update(viewVm('all', 10, { sections: layout }))
  assert.equal(fragments(r, 'agents').count, 0)
  const held = r.live()
  assert.equal(held.length, 1)
  t += 100
  r.advance(t)
  r.p.update(viewVm('codex', 11, { sections: layout }))
  assert.equal(fragments(r, 'agents').count, 1, r.sections().join())
  assert.deepEqual(fragments(r, 'agents').last.payload.agents, flushTree(11))
  r.posted.length = 0
  t += 100
  r.advance(t)
  r.p.update(viewVm('codex', 12, { sections: layout }))
  assert.deepEqual(r.live(), held, 'a second timer was armed for a section the page drops')
  r.advance(t + 5_000)
  assert.equal(fragments(r, 'agents').count, 0, 'the held tree went after the page took its section out')
  assert.deepEqual(r.live(), [])
})

test('the whole page goes without the host\'s own fields: under every view no push carries allBudgets, and the view model keeps every budget for the host (1.8 L-3)', () => {
  const { HOST_ONLY_FIELDS, SECTION_FIELDS, pagePayload } = loadDashboard()
  const { DASHBOARD_SECTION_KEYS } = require('../src/viewModel') as typeof import('../src/viewModel')
  assert.deepEqual([...HOST_ONLY_FIELDS], ['allBudgets'])
  // No section is built from a host-only field, so no fragment can carry one.
  for (const [key, fields] of Object.entries(SECTION_FIELDS)) {
    for (const f of fields) assert.equal((HOST_ONLY_FIELDS as readonly string[]).includes(f), false, `${key} is built from ${f}`)
  }
  const cfg = makeConfig({
    'tokenPace.dashboard.sections': [...DASHBOARD_SECTION_KEYS],
    'tokenPace.budgets': [
      { scope: 'total', period: 'month', unit: 'usd', limit: 20 },
      { scope: 'claude', period: 'day', unit: 'tokens', limit: 5_000_000 },
      { scope: 'codex', period: 'week', unit: 'tokens', limit: 9_000_000 },
    ],
  })
  const built = (providers: ('claude' | 'codex')[]): any => buildViewModel(makeInput({ cfg, ui: { providers } }))
  const views: ('claude' | 'codex')[][] = [['claude', 'codex'], ['claude'], ['codex']]
  for (const providers of views) {
    const vm = built(providers)
    // The host keeps every budget whatever the view — the status bar's budget item and the alerts read them.
    assert.deepEqual(vm.allBudgets.map((b: any) => b.scope), ['total', 'claude', 'codex'], providers.join())
    const r = throttleRig()
    r.p.update(vm)
    r.p.resolveWebviewView(r.view)
    assert.deepEqual(r.posted.map((m) => m.type), ['data'])
    const payload = r.posted[0].payload
    assert.equal('allBudgets' in payload, false, `${providers.join()}: the whole page carries the host's budgets`)
    // Every other field goes as it is, the view model's own value — 1.8 P10 (pinned and changed): but the
    // quota cards, a copy whose prompt-cache blocks lose the host's parts (none in this world).
    assert.deepEqual(Object.keys(payload).sort(), Object.keys(vm).filter((k) => k !== 'allBudgets').sort())
    for (const k of Object.keys(payload)) if (k !== 'quotas') assert.equal(payload[k], vm[k], k)
    assert.deepEqual(payload.quotas, vm.quotas)
    assert.deepEqual(payload.budgets, vm.budgets)
    // The view model the host holds keeps the field: the payload is a copy without it.
    assert.equal('allBudgets' in vm, true)
    assert.deepEqual(pagePayload(vm), payload)
    // A switch to each other view is fragments, none of them with the field either.
    let t = AG_NOW
    for (const other of views) {
      t += 10_000
      r.advance(t)
      r.p.update(built(other))
    }
    assert.ok(r.sections().length > 0)
    assert.equal(JSON.stringify(r.posted).includes('"allBudgets"'), false, providers.join())
  }
  // What the page lost is exactly the second copy: under All it was the `budgets` rows again.
  const all = built(['claude', 'codex'])
  assert.equal(JSON.stringify(all).length - JSON.stringify(pagePayload(all)).length,
    JSON.stringify({ allBudgets: all.allBudgets }).length - 1)
})

test('the page never reads the host\'s budgets: the webview source and the shipped script do not name allBudgets (1.8 L-3)', () => {
  assert.equal(/allBudgets/.test(SOURCE), false, 'src/webview/main.ts names allBudgets')
  assert.equal(/allBudgets/.test(SCRIPT), false, 'the shipped script names allBudgets')
})

test('the host holds back exactly the sections the page leaves out: CLAUDE_ONLY_KEYS is the page\'s CLAUDE_ONLY_SECTIONS (1.8 L-1, Review 1)', () => {
  // A key the host held back that the page still drew would leave that section stale under Codex;
  // a key the page leaves out that the host still pushed would cost the bytes L-1 saves.
  const list = (text: string, re: RegExp): string[] => {
    const m = re.exec(text)
    assert.ok(m, String(re))
    return [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1])
  }
  const host = list(readFileSync(join(__dirname, '..', 'src', 'dashboard.ts'), 'utf8'), /const CLAUDE_ONLY_KEYS: readonly string\[\] = \[([^\]]*)\]/)
  const page = list(SOURCE, /const CLAUDE_ONLY_SECTIONS = \[([^\]]*)\];/)
  assert.deepEqual(host, page)
  assert.deepEqual(host, ['agents', 'context'])
})


// 1.6 N6 (pinned and changed): 1.5 let a name wrap between its parts; a row is two lines now, so the
// name is one — no part of it wraps. 1.6 P7b (pinned and changed, the lead's call: P7 let the first
// part — an agent's type, a session's or a run's start — give way first): what gives way is what
// the row can best do without — an agent's model, a session's project, then a session's or a run's
// short id —, and an agent's type and short id, a session's and a run's prefix word and time stay
// whole; only a line too short for those alone cuts the type or the prefix word — never the time.
test('a name is one line: an agent\'s model gives way before its type and its short id; a session\'s project, then its short id, before its time', () => {
  const a = agentCtx()
  const h = treePart(agentsHtml(a, { agents: agentTree({ roots: [treeNode(AK.a1, 'done', { label: 'general-purpose · opus-5 · a94f',
    fullLabel: 'general-purpose · claude-opus-5 · a94f' })] }) }))
  const label = h.slice(h.indexOf('<span class="ag-label"'), h.indexOf('<span class="ag-fig" id="agf-' + AK.a1 + '">'))
  assert.equal(label, albl('general-purpose · claude-opus-5 · a94f', 'general-purpose', 'opus-5', 'a94f'))
  assert.match(STYLE, /\.ag-label \{ position: relative; display: flex; min-width: 0; overflow: hidden; \}/)
  assert.match(STYLE, /\.ag-label > span \{ flex: none; overflow: hidden; white-space: pre; text-overflow: ellipsis; \}/)
  // The order is each part's flex-shrink, a million times the next one's: the project, then the
  // model and a session's or a run's short id, then — the last resort — the type or the prefix
  // word, or a name of one part. The time and an agent's short id have none: they never shrink.
  assert.match(STYLE, /\.ag-label > \.ag-proj \{ flex-shrink: 1000000000000; min-width: 0; color: var\(--dim\); \}/)
  assert.match(STYLE, /\.ag-label > \.ag-model \{ flex-shrink: 1000000; min-width: 0; \}/)
  assert.match(STYLE, /\.ag-label > \.ag-give \{ flex-shrink: 1000000; min-width: 1\.5em; \}/)
  assert.match(STYLE, /\.ag-label > \.ag-type, \.ag-label > \.ag-pre, \.ag-label > \.ag-np:only-child \{ flex-shrink: 1; min-width: 1\.5em; \}/)
  assert.equal(/\.ag-(when|sid|dot|end)\b[^{]*\{[^}]*flex-shrink/.test(STYLE), false, 'a part that never gives way shrinks')
  assert.equal(/\.ag-np:first-child/.test(STYLE), false, 'the first part gives way again')
  // The short id and a session's project in the dim tone.
  assert.match(STYLE, /\.ag-label > \.ag-sid \{ color: var\(--dim\); \}/)
  // A model taken off the name whole (fitAgentNames) is out of sight and still in the page.
  assert.match(STYLE, /\.ag-label > \.ag-gone \{ position: absolute; left: 0; top: 0; width: 1px; height: 1px; clip-path: inset\(50%\); \}/)
  // A session and a run: the prefix word and the time the name ends on — the node's clock time —
  // then the short id that gives way; a session's project after it. German the same.
  const run = treePart(agentsHtml(a, { agents: agentTree({ roots: [treeNode(AK.wf, 'done', { kind: 'workflow',
    label: 'Workflow-Lauf 2026-09-17 11:57 · cfe7718d', startClock: '2026-09-17 11:57' })] }) }))
  assert.ok(run.indexOf(slbl('Workflow-Lauf 2026-09-17 11:57 · cfe7718d', 'Workflow-Lauf', '2026-09-17 11:57', 'cfe7718d')) >= 0, run)
  const de = treePart(agentsHtml(a, { agents: agentTree({ roots: [treeNode(AK.s1, 'idle', { kind: 'session',
    label: 'Sitzung Do 11:10 · 3f9a2c1d', startClock: '11:10' })] }) }))
  assert.ok(de.indexOf(slbl('Sitzung Do 11:10 · 3f9a2c1d', 'Sitzung', 'Do 11:10', '3f9a2c1d')) >= 0, de)
  // A clock of twelve hours, "02:20 PM": the time is its last two words and the weekday before them.
  const pm = treePart(agentsHtml(a, { agents: agentTree({ roots: [treeNode(AK.s1, 'idle', { kind: 'session',
    label: 'Session Tue 02:20 PM · 9d0eb37a', startClock: '02:20 PM', sub: 'repo' })] }) }))
  assert.ok(pm.indexOf(slbl('Session Tue 02:20 PM · 9d0eb37a · repo', 'Session', 'Tue 02:20 PM', '9d0eb37a', 'repo')) >= 0, pm)
  // A name that does not end on the node's clock time — no start, or another build's view model —
  // is one part before its id, which gives way last, as the prefix word does; a name with no id is
  // one part.
  for (const startClock of [null, '11:59', '', 7]) {
    const odd = treePart(agentsHtml(a, { agents: agentTree({ roots: [treeNode(AK.s1, 'idle', { kind: 'session',
      label: 'Session Tue 10:55 · 9d0eb37a', startClock })] }) }))
    assert.ok(odd.indexOf('<span class="ag-label" title="Session Tue 10:55 · 9d0eb37a"><span class="ag-np ag-pre">Session Tue 10:55</span>'
      + DOT + '<span class="ag-sid ag-give">9d0eb37a</span></span>') >= 0, String(startClock) + odd)
  }
  const bare = treePart(agentsHtml(a, { agents: agentTree({ roots: [treeNode(AK.s1, 'idle', { kind: 'session', label: 'Session 9d0eb37a', startClock: null })] }) }))
  assert.ok(bare.indexOf(olbl('Session 9d0eb37a', 'Session 9d0eb37a')) >= 0, bare)
  // A launch: its type, the model it was launched with, which gives way, and its last word, whole and
  // not dimmed — it is no id. A collector's name is words, one part.
  const launch = treePart(agentsHtml(a, { agents: agentTree({ roots: [treeNode(AK.l1, 'running', { kind: 'pending', label: 'Plan · sonnet · launched' })] }) }))
  assert.equal(launch.indexOf('ag-sid'), -1, launch)
  assert.ok(launch.indexOf(albl('Plan · sonnet · launched', 'Plan', 'sonnet', 'launched', true)) >= 0, launch)
  const words = treePart(agentsHtml(a, { agents: agentTree({ roots: [treeNode(AK.n1, 'running', { kind: 'noreply', label: '2 agent(s) without a counted reply' })] }) }))
  assert.ok(words.indexOf(olbl('2 agent(s) without a counted reply', '2 agent(s) without a counted reply')) >= 0, words)
  // Escaped, however the name is split.
  const hostile = treePart(agentsHtml(a, { agents: agentTree({ roots: [treeNode(AK.s1, 'idle', { kind: 'session',
    label: 'Session <b>x Tue 10:55 · 9d0e"b37a', startClock: '10:55' })] }) }))
  assert.equal(/<b>|"b37a/.test(hostile), false, hostile)
})

// 1.6 P7b: an agent's model with less room than its dot and the ellipsis is taken off the name whole
// — a sliver of a dot says nothing —, one with room for them gives way on its ellipsis, and a model
// that fits is left alone; fitted again with more room, it comes back.
test('a model with no room for its dot and an ellipsis is taken off the name whole, and comes back when there is room', () => {
  const a = agentCtx()
  const doc = (a.c as Record<string, unknown>).document as Record<string, unknown>
  const model = (width: number, scrollWidth: number) => {
    const cls = new Set<string>()
    const m = {
      width, clientWidth: Math.floor(width), scrollWidth, cls,
      getBoundingClientRect: () => ({ width: m.width }),
      classList: { contains: (c: string) => cls.has(c), add: (c: string) => { cls.add(c) }, remove: (c: string) => { cls.delete(c) } },
    }
    return m
  }
  // The name's font is 13 px (the stub's getComputedStyle has none: the page takes 13), so the room
  // is 1.9 × 13 = 24.7 px: " · …".
  const sliver = model(7.1, 63), tight = model(24.8, 63), fits = model(62.9, 62), shut = model(0, 0)
  doc.querySelectorAll = (q: string) => (q === '.ag-label > .ag-model' ? [sliver, tight, fits, shut] : [])
  nodeVm.runInContext('fitAgentNames()', a.c)
  assert.deepEqual([sliver, tight, fits, shut].map((m) => m.cls.has('ag-gone')), [true, false, false, false])
  sliver.width = 40
  sliver.clientWidth = 40
  nodeVm.runInContext('fitAgentNames()', a.c)
  assert.equal(sliver.cls.has('ag-gone'), false)
  // The page's constant and its rules: with the page's other fits, and when a closed section opens
  // (1.8 L-6, pinned and changed: a toggle listener of their own — now the one that runs every fit).
  assert.match(SOURCE, /const AGENT_MODEL_ROOM_EM = 1\.9;/)
  assert.match(SOURCE, /function applyFits\(\): void \{[^}]*fitAgentNames\(\);\s*fitAgentFigures\(\);/)
  assert.match(SOURCE, /document\.addEventListener\('toggle', \(\) => \{ if \(vm\) applyFits\(\); \}, true\);/)
})

// ---------------------------------------------------------------------------
// 1.6 P7 · N6 two-line rows, N9 accessibility basics
// ---------------------------------------------------------------------------

/** A fake part of a figures' line: where its right edge is, and the classes the fit gives it. */
function fakePart(right: number, hidden = false): { right: number; hidden: boolean; classList: { contains: (c: string) => boolean; add: (c: string) => void; remove: (c: string) => void; has: Set<string> }; getBoundingClientRect: () => { right: number } } {
  const has = new Set(['ag-fp'])
  return {
    right, hidden, getBoundingClientRect: () => ({ right }),
    classList: { contains: (c: string) => has.has(c), add: (c: string) => { has.add(c) }, remove: (c: string) => { has.delete(c) }, has },
  }
}

test('a figures line with no room for its last parts takes them off whole and ends on an ellipsis; the first part always stays', () => {
  const a = agentCtx()
  const doc = (a.c as Record<string, unknown>).document as Record<string, unknown>
  const lineOf = (parts: ReturnType<typeof fakePart>[], clientWidth: number, scrollWidth: number) => {
    const cls = new Set<string>()
    return {
      parts, clientWidth, scrollWidth, children: parts, cls,
      getBoundingClientRect: () => ({ left: 0, right: clientWidth }),
      classList: { contains: (c: string) => cls.has(c), add: (c: string) => { cls.add(c) }, remove: (c: string) => { cls.delete(c) } },
      querySelectorAll: (q: string) => (q === '.ag-gone' ? parts.filter((p) => p.classList.has.has('ag-gone')) : []),
    }
  }
  // 120 px of room, four parts ending at 50, 100, 150 and 200 px: the ellipsis needs 1.4 × 11 px,
  // so the first two stay and the last two go — whole.
  const cut = lineOf([fakePart(50), fakePart(100), fakePart(150), fakePart(200)], 120, 200)
  // A line that fits is left alone, and so is one inside a closed section (no width at all).
  const fits = lineOf([fakePart(40), fakePart(90)], 120, 90)
  const shut = lineOf([fakePart(0), fakePart(0)], 0, 0)
  // A hidden part (a silence not yet due) is not a part of the line.
  const quiet = lineOf([fakePart(50), fakePart(100), fakePart(300, true)], 120, 130)
  // However narrow, the first part — the usage and its ⚠ — stays.
  const narrow = lineOf([fakePart(80), fakePart(160)], 60, 160)
  doc.querySelectorAll = (q: string) => (q === '.ag-fig' ? [cut, fits, shut, quiet, narrow] : [])
  nodeVm.runInContext('fitAgentFigures()', a.c)
  const gone = (l: { parts: ReturnType<typeof fakePart>[] }): boolean[] => l.parts.map((p) => p.classList.has.has('ag-gone'))
  assert.deepEqual(gone(cut), [false, false, true, true])
  assert.equal(cut.cls.has('ag-cut'), true)
  assert.deepEqual([gone(fits), fits.cls.has('ag-cut')], [[false, false], false])
  assert.deepEqual([gone(shut), shut.cls.has('ag-cut')], [[false, false], false])
  assert.deepEqual([gone(quiet), quiet.cls.has('ag-cut')], [[false, false, false], true])
  assert.deepEqual([gone(narrow), narrow.cls.has('ag-cut')], [[false, true], true])
  // Fitted again with more room — a resize —, the parts come back.
  cut.clientWidth = 300
  cut.scrollWidth = 200
  nodeVm.runInContext('fitAgentFigures()', a.c)
  assert.deepEqual([gone(cut), cut.cls.has('ag-cut')], [[false, false, false, false], false])
  // The page's rules: a part taken off is out of sight and still in the page for a screen reader;
  // the line ends on "…"; the fit runs with the page's other fits, after every render and resize.
  // 1.6 L1 (pinned and changed: the "…" had no text alternative): a screen reader, which the line
  // describes the tree item to, hears no "…", and a comma between two parts — none before a tally's.
  assert.match(STYLE, /\.ag-fig\.ag-cut::after \{ content: "\\00a0…" \/ ""; \}/)
  assert.match(STYLE, /\.ag-fig > \.ag-fp \+ \.ag-fp:not\(:has\(> \.ag-t\)\)::before \{ content: "" \/ ", "; \}/)
  // 1.6 P10c (pinned by P7 and changed, Review 3 #2): out of sight by its text at no size, in the
  // line where it was — not absolute and clipped, which Chrome's accessibility tree reads as a
  // block of its own and gives a space before the next comma.
  assert.match(STYLE, /\.ag-fig \.ag-gone \{ font-size: 0; \}/)
  const goneRule = STYLE.slice(STYLE.indexOf('.ag-fig .ag-gone {'), STYLE.indexOf('}', STYLE.indexOf('.ag-fig .ag-gone {')))
  assert.equal(/position|clip|width|height|display/.test(goneRule), false, goneRule)
  assert.match(SOURCE, /function applyFits\(\): void \{[^}]*fitAgentFigures\(\);/)
})

/** The element that opens at `at` in `h`, to its own end (spans only, as a figures' line is). */
function spanAt(h: string, at: number): string {
  const re = /<span[^>]*>|<\/span>/g
  re.lastIndex = at
  let depth = 0
  for (let m = re.exec(h); m; m = re.exec(h)) {
    depth += m[0].startsWith('</') ? -1 : 1
    if (depth === 0) return h.slice(at, m.index + m[0].length)
  }
  throw new Error('an unterminated span at ' + at)
}

/** A figures' line with its last `k` parts taken off, as fitAgentFigures leaves it. */
function takeOff(line: string, k: number): string {
  const opens: number[] = []
  const re = /<span[^>]*>|<\/span>/g
  let depth = 0
  for (let m = re.exec(line); m; m = re.exec(line)) {
    if (m[0].startsWith('</')) { depth--; continue }
    depth++
    if (depth === 2 && m[0] === '<span class="ag-fp">') opens.push(m.index)
  }
  let out = line
  for (const at of opens.slice(opens.length - k).reverse()) {
    out = out.slice(0, at) + '<span class="ag-fp ag-gone">' + out.slice(at + '<span class="ag-fp">'.length)
  }
  return out
}

/**
 * What a screen reader gets of a figures' line — the item's description (1.6 L1) — by the rules of
 * Chrome's accessibility tree the line's words depend on, as the harness measured them (keys.mjs):
 * what is `aria-hidden` says nothing; every part after the first but a tally's says ", " in front of
 * itself (the stylesheet's generated content); and an element the stylesheet places apart —
 * `position: absolute`: a `.sr` twin, and a part taken off the line while its rule places it so — is
 * a block of its own, with a space before and after it unless one is there already.
 */
function spokenLine(line: string, style: string): string {
  const goneApart = /\.ag-fig \.ag-gone \{[^}]*position: absolute/.test(style)
  const tokens = line.match(/<span[^>]*>|<\/span>|[^<]+/g) ?? []
  const stack: Array<{ hidden: boolean; apart: boolean }> = []
  let out = ''
  let part = -1
  const space = (): void => { if (out !== '' && !out.endsWith(' ')) out += ' ' }
  tokens.forEach((tok, i) => {
    if (tok.startsWith('</')) {
      const top = stack.pop()
      if (top && top.apart) space()
      return
    }
    if (!tok.startsWith('<span')) {
      if (!stack.some((x) => x.hidden)) out += tok
      return
    }
    const cls = (/class="([^"]*)"/.exec(tok)?.[1] ?? '').split(' ')
    const hidden = (stack.length > 0 && stack[stack.length - 1].hidden) || /aria-hidden="true"/.test(tok)
    const apart = !hidden && (cls.includes('sr') || (goneApart && cls.includes('ag-gone')))
    if (apart) space()
    if (stack.length === 1 && cls.includes('ag-fp')) {
      part++
      // Its own tokens, to its end: does the part hold a tally?
      let depth = 0
      let tally = false
      for (let j = i; j < tokens.length; j++) {
        if (tokens[j].startsWith('</')) { if (--depth === 0) break } else if (tokens[j].startsWith('<span')) {
          depth++
          // 1.7 F4: a tally's part is `ag-t` and the tone of what it counts (`ag-tt-<tone>`).
          if (/class="ag-t[" ]/.test(tokens[j])) tally = true
        }
      }
      if (part > 0 && !tally) out += ', '
    }
    stack.push({ hidden, apart })
  })
  return out.trim()
}

test('a part taken off a figures line leaves no space of its own in what a screen reader gets: "own 1.2M, agents 434.6K, 1 h 05 min" (1.6 P10c)', () => {
  // Review 3 #2: a part the fit takes off is still read out, and must be read as if it were on the
  // line — the item's description (its figures' line) the same with every part on it and with any
  // number taken off, "own 32K, agents 166K, 49 min 00 s", never "agents 166K , 49 min 00 s", which
  // Chrome read while such a part was placed apart (absolute, clipped) — a block of its own to it.
  const a = agentCtx()
  const h = treePart(agentsHtml(a, { agents: agentTree(), ui: agentUi({ agentsExpanded: OPEN }) }))
  const lineOf = (key: string): string => spanAt(h, h.indexOf('<span class="ag-fig" id="agf-' + key + '">'))
  const partsOf = (line: string): number => line.split('<span class="ag-fp">').length - 1
  for (const [key, said] of [
    // A session: its two figures, its tally (words for the eye alone — the item's name says them), its span.
    [AK.s1, 'own 1.2M, agents 434.6K, 1 h 05 min'],
    // A running run: its usage, its tally, its clock — for the ear the clock time it started at.
    [AK.wf, '410K, since 11:40'],
  ] as Array<[string, string]>) {
    const line = lineOf(key)
    assert.ok(partsOf(line) >= 3, line)
    for (let k = 0; k < partsOf(line); k++) {
      assert.equal(spokenLine(takeOff(line, k), STYLE), said, key + ' with ' + k + ' part(s) taken off: ' + takeOff(line, k))
    }
  }
  // The rule that made the space, for the record: with a part taken off placed apart — P7's
  // "position: absolute; … clip-path: inset(50%)" — the same session line read with a space before its comma.
  const placedApart = '.ag-fig .ag-gone { position: absolute; left: 0; top: 0; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); }'
  assert.equal(spokenLine(takeOff(lineOf(AK.s1), 1), placedApart), 'own 1.2M, agents 434.6K , 1 h 05 min')
  assert.equal(spokenLine(lineOf(AK.s1), placedApart), 'own 1.2M, agents 434.6K, 1 h 05 min')
})

test('the clock fits its row again when it grows a unit, or a silence appears — and not on every tick', () => {
  const since = { dataset: { ts: String(AG_NOW - 59_000) }, textContent: '59 s' }
  const a = agentCtx([since])
  let fitted = 0
  const doc = (a.c as Record<string, unknown>).document as Record<string, unknown>
  const before = doc.querySelectorAll as (q: string) => unknown[]
  doc.querySelectorAll = (q: string) => { if (q === '.ag-fig') fitted++; return before(q) }
  a.fire('window:message', { origin: '', data: { type: 'data', payload: model({ sections: ['agents'], agents: agentTree(), ui: agentUi() }) } })
  const tick = (t: number): void => { a.clock.t = t; a.intervals[0].fn() }
  fitted = 0
  tick(AG_NOW + 500)
  assert.deepEqual([since.textContent, fitted], ['59 s', 0])
  tick(AG_NOW + 1_000)
  assert.deepEqual([since.textContent, fitted], ['1 min 00 s', 1])
  tick(AG_NOW + 2_000)
  assert.deepEqual([since.textContent, fitted], ['1 min 01 s', 1])
})

test('every ticking clock of a row is hidden from a screen reader, and its words stand still beside it', () => {
  // 1.6 N9: "running for 12 min 05 s" rewritten every second is "since 14:20" to the ear — the
  // view model's startClock; the page formats no time itself.
  const a = agentCtx()
  const h = agentsHtml(a, { ui: openUi() })
  const live = h.split('data-live="since"').length - 1
  assert.equal(live, 3, h)
  assert.equal(h.split('<span aria-hidden="true"><span class="nobr">').length - 1, live, h)
  // The run's clock time is the one its name ends on (1.6 P7b: the fixture's run is "Tue 11:40").
  assert.equal(h.split('<span class="sr">since 11:59</span>').length - 1 + h.split('<span class="sr">since 11:40</span>').length - 1, live, h)
  assert.equal(h.split('<span class="sr">since 11:40</span>').length - 1, 1, h)
  // The glyph's name is the state in words; its title, for the eye, keeps the page's "~running · derived".
  assert.ok(h.indexOf('aria-label="running, derived" title="~running · derived"') >= 0, h)
  assert.ok(h.indexOf('aria-label="done, recorded" title="done · recorded"') >= 0, h)
  assert.equal(/aria-label="~/.test(h), false, h)
  // The words are the page's, and German on a German page.
  for (const w of ['{0}, derived', '{0}, recorded', 'since {0}', 'silent since {0}']) assert.equal(DICT[w], w)
  const bundle = JSON.parse(readFileSync(join(__dirname, '..', 'l10n', 'bundle.l10n.de.json'), 'utf8')) as Record<string, string>
  assert.deepEqual(['{0}, derived', '{0}, recorded', 'since {0}', 'silent since {0}'].map((w) => bundle[w]),
    ['{0}, abgeleitet', '{0}, aufgezeichnet', 'seit {0}', 'still seit {0}'])
})

test('the fold and the row are targets of 24 × 24 px at least, and a forced-colours theme draws the tree in system colours', () => {
  // 1.6 N9, WCAG 2.5.8: the fold 24 px wide and high, the row and the "more" line 24 px high.
  assert.match(STYLE, /\.ag-fold, \.ag-pad \{ flex: none; width: 24px; min-height: 24px; \}/)
  // The arrow on the name's line; the target 24 px high whatever the arrow's line.
  assert.match(STYLE, /\.ag-fold \{[^}]*line-height: 17px;/)
  assert.match(STYLE, /\.ag-row \{[^}]*min-height: 24px;/)
  assert.match(STYLE, /\.ag-more \{[^}]*min-height: 24px;/)
  // Windows High Contrast: glyphs and ⚠ in the text colour, the twisty a button's, the open row a
  // 2 px outline in the highlight colour — its tint and edge are gone in such a theme — and the
  // theme's own adjustment left on.
  const forced = STYLE.slice(STYLE.indexOf('@media (forced-colors: active) {'))
  assert.ok(forced.length > 40, 'no forced-colours block')
  const block = forced.slice(0, forced.indexOf('\n}') + 2)
  assert.match(block, /\.ag-st::before, \.ag-lb \{ color: CanvasText; \}/)
  assert.match(block, /\.ag-fold::before \{ color: ButtonText; \}/)
  // 1.6 L2 (P9, the rule P7 left to it): each part of the details' token mix a border of the text's
  // colour, the theme having taken its fill.
  assert.match(block, /\.ag-mix > i \{ border: 1px solid CanvasText; box-sizing: border-box; \}/)
  assert.match(block, /\.ag-row\[aria-pressed="true"\], \.agtree \.ag-row\[data-pressed="true"\] \{ outline: 2px solid Highlight; outline-offset: -2px; \}/)
  // 1.6 L1: the item the keyboard is on, a ring of the text colour round its line.
  assert.match(block, /\.agtree li\[role="treeitem"\]:focus-visible > \.ag-line \{ outline: 2px solid CanvasText; \}/)
  // The theme's own adjustment stays on for the tree: never a row is taken out of it — 1.7 D-B
  // (pinned and changed: a pressed chip was the one element taken out) a pressed chip (1.6 P16) and
  // a band of the chart by model are.
  assert.deepEqual(adjustedOut(), ADJUSTED_OUT)
})

test('the quota name keeps its nowrap alone, and the running dot never fades below 0.7', () => {
  assert.match(STYLE, /\[data-body="quota"\] \.row > \.name \{ white-space: nowrap; \}/)
  assert.equal(/(^|\n)\.row > \.name \{ white-space: nowrap; \}/.test(STYLE), false, 'the rule reaches every card again')
  assert.match(STYLE, /@keyframes ag-pulse \{ 50% \{ opacity: \.7; \} \}/)
  assert.match(STYLE, /@media \(prefers-reduced-motion: no-preference\) \{\n {2}\.ag-running::before \{ animation: ag-pulse/)
})

// ---------------------------------------------------------------------------
// 1.7 F2 · the group of earlier sessions on the page
// ---------------------------------------------------------------------------

/** 1.7 F2: the group of earlier sessions as the view model sends it — five sessions, 23 agents, closed. */
function earlierNode(over: Record<string, unknown> = {}): Record<string, unknown> {
  const tally = { started: 23, done: 20, failed: 3, retried: 0, stopped: 0, running: 0, unknown: 0 }
  return treeNode(EARLIER_KEY, 'idle', {
    kind: 'group', label: 'Earlier sessions (5)', fullLabel: 'Earlier sessions (5)', usage: '–', usageAgents: null, duration: '–',
    startTs: null, startClock: null, lastTs: AG_NOW - 3_600_000, lastClock: '11:00', agentCount: 23,
    hasChildren: true, childrenTotal: 5, tally, tallyText: tallyText(tally), tallySpoken: tallySpoken(tally), ...over,
  })
}

test('1.7 F2: the group of earlier sessions is the last root — a toggle for a row, its glyph column empty, its name its words and its tally', () => {
  const a = agentCtx()
  const tree = agentTree()
  const roots = [...(tree.roots as Array<Record<string, unknown>>).slice(0, 1), earlierNode()]
  const h = treePart(agentsHtml(a, { agents: agentTree({ roots }) }))
  // The item: the group's class, closed, level 1, the last of the two roots, no aria-selected (it is
  // nothing to select), and its name its words and the tally in words — no state words.
  // Its figures' line is its tally, which its name says in words already: no description either.
  const groupTag = (o: Parameters<typeof itemTag>[1]): string => itemTag(EARLIER_KEY, o)
    .replace(' aria-selected="false"', '').replace(' aria-describedby="agf-' + EARLIER_KEY + '"', '')
  const item = groupTag({ kind: 'group', size: 2, pos: 2, expanded: false, label: 'Earlier sessions (5), 23 started, 20 done, 3 failed' })
  assert.ok(h.indexOf(item) >= 0, h)
  assert.equal(/data-key="g:earlier"[^>]*aria-(selected|describedby)/.test(h), false, h)
  // Its line: the fold, then the row — which opens and closes it, never selects it — with the glyph
  // column kept and nothing in it, the name in one part, and the tally alone on the second line.
  const line = h.slice(h.indexOf(item) + item.length, h.indexOf('</div>', h.indexOf(item)))
  assert.equal(line, '<div class="ag-line">' + foldOf(EARLIER_KEY)
    + '<span class="ag-row" data-act="agentToggle" data-key="' + EARLIER_KEY + '" data-pressed="false">'
    + '<span class="ag-st ag-none" aria-hidden="true"></span><span class="ag-text">' + olbl('Earlier sessions (5)', 'Earlier sessions (5)')
    + figs(...tallyFigs({ tallyText: '23 started · 20 ✓ · 3 ✕' })) + '</span></span>')
  assert.equal(h.indexOf('data-act="agentSelect" data-key="' + EARLIER_KEY + '"'), -1)
  // No state glyph, no state class, no state words.
  assert.equal(line.indexOf('role="img"'), -1, line)
  assert.equal(/ag-idle|idle session|derived/.test(line), false, line)
  // None of its sessions has an agent: a dash on its second line, never "0 started".
  const bare = treePart(agentsHtml(a, { agents: agentTree({ roots: [earlierNode({ tally: null, tallyText: null, tallySpoken: null, agentCount: 0 })] }) }))
  assert.ok(bare.indexOf(figs('–') + '</span></span>') >= 0, bare)
  assert.ok(bare.indexOf('aria-label="Earlier sessions (5)">') >= 0, bare)
  assert.equal(/\b0 started/.test(bare), false, bare)
  // Opened: its sessions one level in, counted among the group's own.
  const kids = [treeNode(AK.s2, 'idle', { kind: 'session', label: 'Session Mon 09:00 · 1234abcd', usage: '–', duration: '–', startClock: '2026-09-21 09:00' })]
  const open = treePart(agentsHtml(a, { agents: agentTree({ roots: [earlierNode({ children: kids })] }), ui: agentUi({ agentsExpanded: [EARLIER_KEY] }) }))
  assert.ok(open.indexOf(groupTag({ kind: 'group', tab: true, size: 1, pos: 1, expanded: true,
    label: 'Earlier sessions (5), 23 started, 20 done, 3 failed' })) >= 0, open)
  assert.ok(open.indexOf('<ul role="group">' + itemTag(AK.s2, { kind: 'session', level: 2, size: 5, pos: 1,
    label: 'Session Mon 09:00 · 1234abcd, idle session, derived' })) >= 0, open)
  // A payload that names it as the selection gets no panel under it.
  const sel = agentsHtml(a, { agents: agentTree({ roots: [earlierNode()], selected: { key: EARLIER_KEY, title: 'x', state: 'idle', derived: true,
    stateText: 'x', lastTs: null, overview: null, id: null, rows: [] } }), ui: agentUi({ agentSelected: EARLIER_KEY }) })
  assert.equal(sel.indexOf('ag-details'), -1, sel)
  // The stylesheet keeps the empty column's width and draws a space that says nothing.
  assert.match(STYLE, /\.ag-none::before \{ content: "\\00a0" \/ ""; \}/)
})

test('1.7 F2: a click on the group\'s row and Enter on its item post agentToggle for it — never agentSelect', () => {
  const a = agentCtx()
  a.fire('window:message', { origin: '', data: { type: 'data', payload: model({ sections: ['agents'],
    agents: agentTree({ roots: [...(agentTree().roots as Array<Record<string, unknown>>), earlierNode()] }), ui: agentUi() }) } })
  a.posted.length = 0
  const event = (el: Record<string, unknown>, extra: Record<string, unknown> = {}): Record<string, unknown> =>
    ({ target: { closest: () => el }, stopPropagation: () => undefined, preventDefault: () => undefined, ...extra })
  // The row's target as the page draws it: data-act="agentToggle", the group's key.
  a.fire('document:click', event({ tagName: 'SPAN', dataset: { act: 'agentToggle', key: EARLIER_KEY } }))
  // The keyboard: Enter and Space on the group's item go through its row — which toggles; → opens it,
  // ← on it open closes it (1.6 L1, as on every parent).
  const focused: string[] = []
  const { items } = fakeTree([
    { key: AK.s1, level: 1, expanded: false }, { key: EARLIER_KEY, level: 1, expanded: false, row: 'agentToggle' },
  ], focused)
  const key = (i: number, k: string): void => a.fire('document:keydown', { key: k, target: items[i], preventDefault: () => undefined, stopPropagation: () => undefined })
  key(1, 'Enter'); key(1, ' '); key(1, 'ArrowRight')
  const opened = fakeTree([{ key: AK.s1, level: 1, expanded: false }, { key: EARLIER_KEY, level: 1, expanded: true, row: 'agentToggle' },
    { key: AK.s2, level: 2, expanded: false }], focused)
  a.fire('document:keydown', { key: 'ArrowLeft', target: opened.items[1], preventDefault: () => undefined })
  a.fire('document:keydown', { key: 'ArrowRight', target: opened.items[1], preventDefault: () => undefined })
  a.fire('document:keydown', { key: 'End', target: opened.items[0], preventDefault: () => undefined })
  const toggle = { type: 'agentToggle', key: EARLIER_KEY }
  assert.deepEqual(a.posted, [toggle, toggle, toggle, toggle, toggle])
  // → on the open group moves into it, End onto the last item; nothing is selected.
  assert.deepEqual(focused, [AK.s2, AK.s2])
  for (const m of a.posted) assert.deepEqual(parseWebviewMessage(m), m)
})

test('1.7 F2: the group\'s words on a German page are the view model\'s — „Frühere Sitzungen (5), 23 gestartet, 20 fertig, 3 fehlgeschlagen"', () => {
  const bundle = JSON.parse(readFileSync(join(__dirname, '..', 'l10n', 'bundle.l10n.de.json'), 'utf8')) as Record<string, string>
  const tally = { started: 23, done: 20, failed: 3, retried: 0, stopped: 0, running: 0, unknown: 0 }
  let label = ''
  let spoken = ''
  let shown = ''
  try {
    setBundle(bundle)
    setLocale('de')
    label = t('Earlier sessions ({0})', '5')
    spoken = tallySpoken(tally)
    shown = tallyText(tally)
  } finally {
    setBundle(undefined)
    setLocale(undefined)
  }
  assert.deepEqual([label, spoken], ['Frühere Sitzungen (5)', '23 gestartet, 20 fertig, 3 fehlgeschlagen'])
  const h = treePart(agentsHtml(agentCtx(), { agents: agentTree({ roots: [earlierNode({ label, fullLabel: label, tallyText: shown, tallySpoken: spoken })] }) }))
  assert.ok(h.indexOf('aria-label="Frühere Sitzungen (5), 23 gestartet, 20 fertig, 3 fehlgeschlagen"') >= 0, h)
})

// ---------------------------------------------------------------------------
// 1.7 F4 · state colours on the row text
// ---------------------------------------------------------------------------

/** 1.7 F4: the classes of every `.ag-row` of a rendered section, by key and list ('tree', 'now', 'week'). */
function rowClasses(h: string): Array<{ key: string; list: string; cls: string[]; pressed: boolean }> {
  return [...h.matchAll(/<(?:span|button) class="(ag-row[^"]*)" data-act="agent(?:Select|Toggle)" data-key="([^"]*)"( data-list="(now|week)")?[^>]*?(?:data-pressed|aria-pressed)="(true|false)"/g)]
    .map((m) => ({ key: unescapeHtml(m[2]), list: m[4] ?? 'tree', cls: m[1].split(' '), pressed: m[5] === 'true' }))
}

test('1.7 F4: an agent\'s, a launch\'s, a run\'s and a collector\'s row wears the colour of a done, unknown, failed or running state — a stop, a superseded attempt, a session and the group none', () => {
  // The Agents world end to end, every parent open, the 7-day block open, a done agent selected — its
  // row the open one.
  const { agg } = agentWorld()
  const cfg = makeConfig()
  const opened = everyParent(agg, cfg, NOW)
  const whole = agentTreeFor(makeInput({ agg, cfg, ui: {} }), 'text')
  const explore = agentNodeOf(whole.roots, AGENT_WORLD.explore)
  const ui = { agentsExpanded: opened, agentsWeekOpen: true, agentSelected: explore.key, agentSelectedIn: 'tree' as const }
  const vm = buildViewModel(makeInput({ agg, cfg, ui }))
  const h = agentsHtml(agentCtx(), { agents: vm.agents, ui: agentUi(ui) })
  const rows = rowClasses(h)
  const nodes = treeNodes(vm.agents.roots)
  assert.equal(rows.filter((r) => r.list === 'tree').length, nodes.length, 'a node without its row')
  const colourOf = (kind: string, state: string, superseded: boolean): string | null =>
    (['agent', 'pending', 'workflow', 'noreply'].includes(kind) && ['done', 'unknown', 'failed', 'running'].includes(state) && !superseded ? state : null)
  for (const n of nodes) {
    const r = rows.find((x) => x.list === 'tree' && x.key === n.key)
    assert.ok(r, n.key)
    const colours = r.cls.filter((c) => c.startsWith('ag-c-'))
    const want = colourOf(n.kind, n.state, n.superseded)
    assert.deepEqual(colours, want === null ? [] : ['ag-c-' + want], `${n.kind} ${n.state}${n.superseded ? ' superseded' : ''} ${n.label}`)
    assert.deepEqual(r.cls.filter((c) => c !== 'ag-row' && !c.startsWith('ag-c-')), [], n.key)
  }
  // The world has each case: a coloured row of each of the four states and of each kind, and the
  // rows that wear none — a stop, a superseded attempt (a failure retried, a stop replaced), the
  // sessions and the group.
  const coloured = nodes.filter((n) => colourOf(n.kind, n.state, n.superseded) !== null)
  assert.deepEqual([...new Set(coloured.map((n) => n.state))].sort(), ['done', 'failed', 'running', 'unknown'])
  assert.deepEqual([...new Set(coloured.map((n) => n.kind))].sort(), ['agent', 'noreply', 'pending', 'workflow'])
  const bare = (id: string): string[] => rows.find((r) => r.list === 'tree' && r.key === agentNodeOf(whole.roots, id).key)?.cls ?? ['missing']
  assert.deepEqual(bare(AGENT_WORLD.stopped), ['ag-row'], 'a stop wears a colour')
  assert.deepEqual(bare(AGENT_WORLD.wfRetryFail), ['ag-row'], 'a superseded failure wears a colour')
  assert.deepEqual(bare(AGENT_WORLD.wfReplaced), ['ag-row'], 'a superseded stop wears a colour')
  assert.ok(nodes.filter((n) => n.kind === 'session' || n.kind === 'group').length >= 3)
  for (const n of nodes.filter((x) => x.kind === 'session' || x.kind === 'group')) {
    assert.deepEqual(rows.find((r) => r.list === 'tree' && r.key === n.key)?.cls, ['ag-row'], n.label)
  }
  // The open row wears its colour as well — the stylesheet neutralises it (below) — and it is pressed.
  const open = rows.find((r) => r.list === 'tree' && r.key === explore.key)
  assert.deepEqual([open?.pressed, open?.cls], [true, ['ag-row', 'ag-c-done']])
  // The running list: every entry runs, and says so in the colour of its name.
  const now = rows.filter((r) => r.list === 'now')
  assert.equal(now.length, vm.agents.runningNow.length)
  assert.ok(now.length >= 2)
  for (const r of now) assert.deepEqual(r.cls, ['ag-row', 'ag-c-running'], r.key)
  // The 7-day block's largest agents, as their tree rows: by state, none for a superseded attempt.
  const week = rows.filter((r) => r.list === 'week')
  const top = vm.agents.week?.top ?? []
  assert.equal(week.length, top.length)
  assert.ok(top.length > 0)
  for (const it of top) {
    const want = colourOf('agent', it.state, it.superseded)
    assert.deepEqual(week.find((r) => r.key === it.key)?.cls, want === null ? ['ag-row'] : ['ag-row', 'ag-c-' + want], it.label)
    assert.equal(it.superseded, agentNodeOf(whole.roots, it.key.slice(2)).superseded, it.key)
  }
  // Every coloured row keeps its glyph and its words: the colour is never alone (§3.0 e).
  for (const n of coloured) {
    const at = h.indexOf('data-key="' + n.key + '" data-pressed=')
    assert.ok(at >= 0, n.key)
    const row = h.slice(at, h.indexOf('</div>', at))
    assert.ok(row.indexOf('<span class="ag-st ag-' + n.state + '" role="img" aria-label="' + ({ done: 'done', failed: 'failed', running: 'running', unknown: 'unknown' } as Record<string, string>)[n.state]) >= 0, row)
  }
  // Each part of a tally wears the state it counts, in the row's order.
  for (const n of nodes.filter((x) => x.tallyParts !== null && x.kind !== 'agent')) {
    // The group's line carries no id (it describes nothing): the first line after its row.
    const at = n.kind === 'group' ? h.indexOf('<span class="ag-fig">', h.indexOf('data-key="' + EARLIER_KEY + '"'))
      : h.indexOf('<span class="ag-fig" id="agf-' + n.key + '">')
    assert.ok(at >= 0, n.key)
    const line = spanAt(h, at)
    const drawn = [...line.matchAll(/<span class="ag-t ag-tt-([a-z]+)" aria-hidden="true">([^<]*)<\/span>/g)].map((m) => ({ tone: m[1], label: m[2] }))
    assert.deepEqual(drawn, (n.tallyParts ?? []).map((p) => ({ tone: p.tone, label: p.label })), n.key)
  }
  // The stylesheet: the open row's name in the foreground and its tally parts in the figures' tone.
  assert.ok(STYLE.includes('\n.ag-row[aria-pressed="true"] :is(.ag-np, .ag-t), .agtree .ag-row[data-pressed="true"] :is(.ag-np, .ag-t) { color: inherit; }\n'),
    'the open row keeps a state colour')
  // … after the rules it outranks where their weight is the same.
  assert.ok(STYLE.indexOf(':is(.ag-np, .ag-t) { color: inherit; }') > STYLE.lastIndexOf('.ag-label > .ag-np { color: var(--ag-c-'))
  assert.ok(STYLE.indexOf(':is(.ag-np, .ag-t) { color: inherit; }') > STYLE.lastIndexOf('.ag-t.ag-tt-'))
})

test('1.7 F4: the stylesheet colours the name\'s own parts and the tally\'s by state, with four tokens mixed from the theme — the ? glyph too — and nothing in forced colours', () => {
  const root = between(STYLE, /\n:root \{\n/, '\n}')
  // The four tokens: the semantic token mixed 60 : 40 with the foreground, the list's text colours first.
  const tokens: Record<string, string> = {
    done: 'var(--ok)', unknown: 'var(--vscode-list-warningForeground, var(--warn))',
    failed: 'var(--vscode-list-errorForeground, var(--error))', running: 'var(--claude)',
  }
  for (const [state, token] of Object.entries(tokens)) {
    assert.ok(root.includes(`\n  --ag-c-${state}: color-mix(in srgb, ${token} 60%, var(--vscode-foreground));`), state)
    // The name's parts and the tally's in that token, nothing else of the row.
    assert.ok(STYLE.includes(`\n.ag-c-${state} .ag-label > .ag-np { color: var(--ag-c-${state}); }\n`), state)
    assert.ok(STYLE.includes(`\n.ag-t.ag-tt-${state} { color: var(--ag-c-${state}); }\n`), state)
  }
  assert.match(root, /--ok: var\(--vscode-charts-green\);/)
  assert.match(root, /--claude: var\(--vscode-charts-blue\);/)
  // No colour for a stop, and none for the tally's started, retried and stopped parts.
  assert.equal(/ag-c-stopped|ag-c-(active|idle)|ag-tt-(started|retried|stopped)/.test(STYLE), false)
  // Only the name's parts: the short id and the project keep the dim tone.
  assert.match(STYLE, /\n\.ag-label > \.ag-sid \{ color: var\(--dim\); \}/)
  assert.match(STYLE, /\n\.ag-label > \.ag-proj \{[^}]*color: var\(--dim\); \}/)
  assert.equal(/ag-c-[a-z]+[^{]*\.ag-(sid|proj|fig|st)/.test(STYLE), false, 'a state colour reaches beyond the name')
  // The ? takes the yellow its name wears (§7a Q12); every other glyph keeps its 1.6 colour.
  assert.match(STYLE, /\n\.ag-unknown::before \{ content: "\?"; color: var\(--ag-c-unknown\); \}/)
  for (const [s, c] of [['running', 'claude'], ['done', 'ok'], ['failed', 'error'], ['stopped', 'dim'], ['idle', 'dim']]) {
    assert.match(STYLE, new RegExp('\\n\\.ag-' + s + '::before \\{ content: "[^"]+"; color: var\\(--' + c + '\\); \\}'), s)
  }
  // Forced colours: the theme gives every word its own colour — no rule of the mode names a state
  // colour, and none takes a name or a tally out of the adjustment; the glyphs keep CanvasText.
  const forced = STYLE.slice(STYLE.indexOf('@media (forced-colors: active) {'))
  const block = forced.slice(0, forced.indexOf('\n}') + 2)
  assert.equal(/ag-c-|ag-tt-|\.ag-np|\.ag-t\b/.test(block), false, block)
  assert.match(block, /\.ag-st::before, \.ag-lb \{ color: CanvasText; \}/)
  assert.deepEqual(adjustedOut(), ADJUSTED_OUT)
})

/** 1.7 F4: the system colours a forced-colours rule may name (CSS Color 4). */
const SYSTEM_COLOURS = ['AccentColor', 'AccentColorText', 'ActiveText', 'ButtonBorder', 'ButtonFace', 'ButtonText', 'Canvas', 'CanvasText',
  'Field', 'FieldText', 'GrayText', 'Highlight', 'HighlightText', 'LinkText', 'Mark', 'MarkText', 'SelectedItem', 'SelectedItemText', 'VisitedText']

/**
 * 1.7 F4 test 3: what a colour value holds once every `var(--…)` in it is taken out — the words and
 * functions left: none but `transparent`, a system colour, a `color-mix` of vars and the words of a
 * gradient, a border or an outline. A hex, `rgb()`, `hsl()` or a colour's name is a literal.
 */
function colourLiterals(value: string): string[] {
  let v = value
  // Innermost first, so a var's fallback that is a var goes with it.
  for (let i = 0; i < 20 && /var\(--[A-Za-z0-9-]+(?:,[^()]*)?\)/.test(v); i++) v = v.replace(/var\(--[A-Za-z0-9-]+(?:,[^()]*)?\)/g, ' ')
  const allowed = new Set(['transparent', 'inherit', 'currentcolor', 'none', 'solid', 'color-mix', 'in', 'srgb',
    'repeating-linear-gradient', 'linear-gradient', 'radial-gradient', 'deg', 'px', ...SYSTEM_COLOURS.map((c) => c.toLowerCase())])
  const bad: string[] = []
  bad.push(...(v.match(/#[0-9a-fA-F]{3,8}\b/g) ?? []))
  for (const w of v.replace(/#[0-9a-fA-F]{3,8}\b/g, ' ').match(/[A-Za-z][A-Za-z-]*/g) ?? []) if (!allowed.has(w.toLowerCase())) bad.push(w)
  return bad
}

test('1.7 F4: every rule of a state colour, a tally tone, the guide lines or a band in forced colours paints with tokens, color-mix of tokens, transparent or system colours — no literal', () => {
  const css = STYLE.replace(/\/\*[\s\S]*?\*\//g, '')
  const forcedAt = css.indexOf('@media (forced-colors: active) {')
  const forcedEnd = css.indexOf('\n}', forcedAt)
  // Every rule, with where it stands: in the forced-colours block or not.
  const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({ sel: m[1].trim(), body: m[2], at: m.index ?? 0 }))
  const inForced = (r: { at: number }): boolean => r.at > forcedAt && r.at < forcedEnd
  const named = rules.filter((r) => /ag-c-|ag-tt-|--ag-guide/.test(r.sel + r.body) || (inForced(r) && /\.band\b/.test(r.sel)))
  const colourProps = /^(color|background|background-color|background-image|border|border-[a-z-]*color|border-(top|right|bottom|left)|outline|outline-color|box-shadow|fill|stroke|--ag-c-[a-z]+|--ag-guide)$/
  let checked = 0
  for (const r of named) {
    for (const decl of r.body.split(';').map((d) => d.trim()).filter(Boolean)) {
      const i = decl.indexOf(':')
      const prop = decl.slice(0, i).trim()
      // On :root only the declarations of these tokens; the other rules whole.
      if (r.sel === ':root' && !/^--ag-(c-|guide)/.test(prop)) continue
      if (!colourProps.test(prop)) continue
      checked++
      assert.deepEqual(colourLiterals(decl.slice(i + 1)), [], `${r.sel} { ${decl} }`)
    }
  }
  // The four tokens, the four name rules, the four tally rules, the ? glyph, the open row, the bands.
  assert.ok(named.filter((r) => inForced(r)).length >= 9, String(named.length))
  assert.ok(checked >= 4 + 4 + 4 + 1 + 1 + 9, String(checked))
  // The check itself: it finds a literal of each kind.
  assert.deepEqual(colourLiterals(' #89d185'), ['#89d185'])
  assert.deepEqual(colourLiterals(' rgb(1, 2, 3)'), ['rgb'])
  assert.deepEqual(colourLiterals(' hsl(1 2% 3%)'), ['hsl'])
  assert.deepEqual(colourLiterals(' green'), ['green'])
  assert.deepEqual(colourLiterals(' color-mix(in srgb, var(--ok) 60%, white)'), ['white'])
  assert.deepEqual(colourLiterals(' var(--vscode-list-warningForeground, #cca700)'), [])
  assert.deepEqual(colourLiterals(' color-mix(in srgb, var(--vscode-list-errorForeground, var(--error)) 60%, var(--vscode-foreground))'), [])
  assert.deepEqual(colourLiterals(' repeating-linear-gradient(45deg, CanvasText 0 2px, Canvas 2px 4px)'), [])
})

test('1.7 F4: a hostile tally part renders inert — a tone the page does not know reaches no class, and parts that do not spell the text are not drawn', () => {
  const a = agentCtx()
  const EVIL = '"><img src=x onerror=alert(1)>'
  const session = (over: Record<string, unknown>): Record<string, unknown> => agentTree({ roots: [treeNode(AK.s1, 'active', {
    kind: 'session', label: 'Session Tue 10:55 · 9d0eb37a', startClock: '10:55', ...T_S1, children: [treeNode(AK.a1, 'running')], ...over,
  })] })
  // A tone it does not know: the part is drawn, in the figures' tone, its words escaped.
  const odd = treePart(agentsHtml(a, { agents: session({ tallyText: '<b>4</b> started · 1 ✓', tallyParts: [{ label: '<b>4</b> started', tone: EVIL }, { label: '1 ✓', tone: 'done' }] }) }))
  assert.ok(odd.indexOf('<span class="ag-t" aria-hidden="true">&lt;b&gt;4&lt;/b&gt; started</span>') >= 0, odd)
  assert.ok(odd.indexOf('<span class="ag-t ag-tt-done" aria-hidden="true">1 ✓</span>') >= 0, odd)
  assert.equal(/<img|onerror=|class="[^"]*(img|alert)/.test(odd), false, odd)
  // Parts that say something else than the text — or are no list of words — are not drawn: the text is, in the figures' tone.
  for (const tallyParts of [[{ label: '9 started', tone: 'started' }], 'x', [null], [{ tone: 'done' }], [{ label: '', tone: 'done' }], {}]) {
    const h = treePart(agentsHtml(a, { agents: session({ tallyParts }) }))
    assert.ok(h.indexOf(tallyThen({ tallyText: T_S1.tallyText }, fig('<span title="span from the first to the last line">40.0 s</span>'))) >= 0,
      JSON.stringify(tallyParts))
    assert.equal(h.indexOf('9 started'), -1, h)
    assert.equal(h.indexOf('ag-tt-'), -1, JSON.stringify(tallyParts))
  }
  // Every kind in every state: the four kinds of a thing with an outcome in the four states wear its
  // colour; a stop, a superseded attempt, a session in any state — an unknown one too — and the group none.
  for (const kind of ['agent', 'pending', 'workflow', 'noreply', 'session', 'group']) {
    for (const state of ['running', 'done', 'failed', 'stopped', 'unknown', 'active', 'idle']) {
      for (const superseded of [false, true]) {
        const h = treePart(agentsHtml(a, { agents: agentTree({ roots: [treeNode(AK.a1, state, { kind, superseded, label: 'x · y · z', fullLabel: 'x · y · z' })] }) }))
        const want = ['agent', 'pending', 'workflow', 'noreply'].includes(kind) && ['running', 'done', 'failed', 'unknown'].includes(state) && !superseded
        assert.deepEqual(h.match(/ag-c-[a-z]+/g) ?? [], want ? ['ag-c-' + state] : [], `${kind} ${state} ${superseded}`)
      }
    }
  }
  // A state or kind the page does not know reaches no colour class either.
  const strange = treePart(agentsHtml(a, { agents: agentTree({ roots: [treeNode(AK.a1, EVIL, { kind: EVIL })] }) }))
  assert.equal(/ag-c-(?!unknown)/.test(strange), false, strange)
  assert.ok(strange.indexOf('<span class="ag-row ag-c-unknown" data-act="agentSelect"') >= 0, strange)
})

// ---------------------------------------------------------------------------
// 1.7 F6 · guide lines
// ---------------------------------------------------------------------------

/** 1.7 F6: the stylesheet without its comments, its white space collapsed — and where the forced-colours block stands in it. */
function flatStyle(): { css: string; forcedAt: number; forcedEnd: number } {
  const raw = STYLE.replace(/\/\*[\s\S]*?\*\//g, '')
  const at = raw.indexOf('@media (forced-colors: active) {')
  const end = raw.indexOf('\n}', at)
  const flat = (s: string): string => s.replace(/\s+/g, ' ')
  const before = flat(raw.slice(0, at))
  const block = flat(raw.slice(at, end))
  return { css: before + block + flat(raw.slice(end)), forcedAt: before.length, forcedEnd: before.length + block.length }
}

/**
 * 1.7 F6: the guide lines' rules as §3 F6 gives them, and the package's three (the item's flow-root, the "more" line's two heights).
 * 1.8 L-4 (pinned and changed: the last rule was the details panel's, opaque and stacked over the lines): the vertical's gap
 * at an open details panel.
 */
const GUIDE_RULES = [
  '.agtree { --ag-step: 16px; --ag-fold-w: 24px; --ag-guide-y: 9px; --ag-guide: var(--vscode-tree-indentGuidesStroke, var(--rule)); }',
  '.agtree ul ul { padding-left: var(--ag-step); }',
  '.agtree ul[role="group"] > li { position: relative; display: flow-root; }',
  '.agtree ul[role="group"] > li::before, .agtree ul[role="group"] > li::after { content: ""; position: absolute; pointer-events: none; left: calc(var(--ag-fold-w) / 2 - var(--ag-step)); }',
  '.agtree ul[role="group"] > li::before { top: 0; bottom: 0; border-left: 1px solid var(--ag-guide); }',
  '.agtree ul[role="group"] > li:last-child::before { bottom: auto; height: var(--ag-guide-y); }',
  '.agtree ul[role="group"] > li::after { top: var(--ag-guide-y); border-top: 1px solid var(--ag-guide); width: calc(var(--ag-step) - var(--ag-fold-w) / 2 + var(--ag-fold-w) - 2px); }',
  '.agtree ul[role="group"] > li:has(> .ag-line > .ag-fold)::after { width: calc(var(--ag-step) - var(--ag-fold-w) / 2 + 7px); }',
  '.agtree ul[role="group"] > li.ag-k-more { --ag-guide-y: 11px; }',
  '.agtree ul[role="group"] > li.ag-k-more:has(> .ag-line > .ag-more:not([data-act])) { --ag-guide-y: 6px; }',
  '.agtree ul[role="group"] > li.ag-gap::before { clip-path: polygon(0 0, 100% 0, 100% var(--ag-gap-t), 0 var(--ag-gap-t), 0 var(--ag-gap-b), 100% var(--ag-gap-b), 100% 100%, 0 100%); }',
]
const GUIDE_FORCED = '.agtree ul[role="group"] > li::before, .agtree ul[role="group"] > li::after { border-color: CanvasText; }'

// 1.8 L-4 (pinned and changed: "the panel over them"): the lines stop at an open panel's edge (the L-4 tests below).
test('1.7 F6: the stylesheet draws the guide lines behind the rows — two pseudo-elements of every item of a group, in the tree\'s indent-guide token, a gap at an open panel, CanvasText in forced colours', () => {
  const { css, forcedAt, forcedEnd } = flatStyle()
  // Exactly these rules, each once, outside the forced-colours block; the forced one once inside it.
  for (const rule of GUIDE_RULES) {
    const at = css.indexOf(rule)
    assert.ok(at >= 0 && at < forcedAt, 'missing: ' + rule)
    assert.equal(css.split(rule).length, 2, 'twice: ' + rule)
  }
  const f = css.indexOf(GUIDE_FORCED)
  assert.ok(f > forcedAt && f < forcedEnd, 'the forced rule is not in the forced-colours block')
  assert.equal(css.split(GUIDE_FORCED).length, 2)
  // The indent step is no longer a number of its own.
  assert.equal(css.indexOf('.agtree ul ul { padding-left: 16px; }'), -1)
  // The token: the workbench's own colour for tree indent guides, the page's hairline where a build has none.
  assert.equal((css.match(/--ag-guide:/g) ?? []).length, 1)
  assert.ok(css.indexOf('--ag-guide: var(--vscode-tree-indentGuidesStroke, var(--rule));') > 0)
  // Every rule that draws a ::before or an ::after on an item draws a guide line of a group's item — none
  // on a root (`ul[role="none"]`), in the running list or in the 7-day block — and every one is decorative:
  // empty generated content, nothing to read, nothing to copy, no pointer.
  const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({ sel: m[1].trim(), body: m[2].trim() }))
  const onItems = rules.filter((r) => /\bli\b[^,{]*::(before|after)/.test(r.sel))
  assert.ok(onItems.length >= 6, String(onItems.length))
  for (const r of onItems) {
    // 1.8 L-4 (pinned and changed: no class on the item): an item whose vertical gives way to a details panel.
    for (const s of r.sel.split(',').map((x) => x.trim())) assert.match(s, /^\.agtree ul\[role="group"\] > li(:last-child|:has\(> \.ag-line > \.ag-fold\)|\.ag-gap)?::(before|after)$/, r.sel)
    assert.equal(/content:\s*"[^"]/.test(r.body), false, r.sel)
  }
  assert.equal(/\.ag-(now|week)[^{,]*li[^{,]*::(before|after)|role="none"\][^{,]*::(before|after)/.test(css), false)
  // The panel keeps its level variable; the lines' names are their own.
  assert.ok(css.indexOf('.ag-details { margin: 4px 0 6px calc(var(--ag-ind, 0) * -16px);') >= 0)
  for (const r of rules.filter((x) => /--ag-(step|fold-w|guide)/.test(x.body))) assert.equal(r.body.indexOf('--ag-ind'), -1, r.sel)
  // The tokens agree with the boxes they stand for: the indent step is the panel's step back out of a
  // level, the fold width the toggle's and the leaf slot's.
  const num = (re: RegExp): number => { const m = re.exec(css); assert.ok(m, String(re)); return Number((m as RegExpExecArray)[1]) }
  const step = num(/--ag-step: (\d+)px;/), fold = num(/--ag-fold-w: (\d+)px;/)
  assert.equal(step, num(/\.ag-details \{ margin: 4px 0 6px calc\(var\(--ag-ind, 0\) \* -(\d+)px\);/))
  assert.equal(fold, num(/\.ag-fold, \.ag-pad \{ flex: none; width: (\d+)px; min-height: 24px; \}/))
  const twisty = num(/\.ag-fold::before \{ content: "▾"; font-size: (\d+)px; \}/)
  // The geometry the rules give (§3 F6), in the frame of the child's item: the vertical at the parent's
  // fold centre, one step back — left of the child's own toggle, inside its parent's column —; a leaf's
  // stub ending 2 px before its row box, which starts where the slot ends; a parent's before its twisty,
  // centred in the fold, as long as the twisty is no wider than its font size, with half a pixel to spare.
  const x = fold / 2 - step
  assert.ok(x < 0 && x > -step, String(x))
  assert.equal(x + (step - fold / 2 + fold - 2), fold - 2)
  assert.ok(x + (step - fold / 2 + 7) <= (fold - twisty) / 2 - 0.5)
  // No line is taken out of the forced-colours adjustment; the panel's background is a token.
  assert.deepEqual(adjustedOut(), ADJUSTED_OUT)
  assert.match(css, /--bg: var\(--vscode-sideBar-background, var\(--vscode-editor-background, transparent\)\);/)
  assert.deepEqual(colourLiterals(' CanvasText'), [])
})

/** 1.7 F6: a small parser for the markup the renderers write — elements with their tag, attributes and children. */
interface El { tag: string; attrs: Record<string, string>; kids: El[]; text: string }
function parseMarkup(html: string): El {
  const root: El = { tag: '#root', attrs: {}, kids: [], text: '' }
  const stack: El[] = [root]
  const VOID = new Set(['br', 'img', 'input', 'hr', 'wbr', 'meta', 'link'])
  const re = /<(\/?)([a-z][a-z0-9]*)((?:\s[a-z][a-z0-9-]*(?:="[^"]*")?)*)\s*\/?>|([^<]+)/g
  for (const m of html.matchAll(re)) {
    const top = stack[stack.length - 1]
    if (m[4] !== undefined) { top.text += m[4]; continue }
    if (m[1] === '/') {
      assert.equal(top.tag, m[2], 'unbalanced </' + m[2] + '>')
      stack.pop()
      continue
    }
    const attrs: Record<string, string> = {}
    for (const a of m[3].matchAll(/\s([a-z][a-z0-9-]*)(?:="([^"]*)")?/g)) attrs[a[1]] = a[2] ?? ''
    const el: El = { tag: m[2], attrs, kids: [], text: '' }
    top.kids.push(el)
    if (!VOID.has(m[2])) stack.push(el)
  }
  assert.equal(stack.length, 1, 'unclosed ' + stack.map((e) => e.tag).join(' > '))
  return root
}
const hasClass = (e: El, c: string): boolean => (e.attrs.class ?? '').split(' ').includes(c)
function walkEls(e: El, fn: (x: El, parent: El | null) => void, parent: El | null = null): void {
  fn(e, parent)
  for (const k of e.kids) walkEls(k, fn, e)
}

test('1.7 F6: the tree\'s markup is the one it was — the lines are the stylesheet\'s alone: every item of a group an li whose line starts with its toggle or its slot, nothing added to draw with', () => {
  // The Agents world end to end, every parent open, the 7-day block open, the Explore agent's details
  // open under its row (a panel between an item's line and its group); and a run with a "more" line.
  const { agg } = agentWorld()
  const cfg = makeConfig()
  const opened = everyParent(agg, cfg, NOW)
  const whole = agentTreeFor(makeInput({ agg, cfg, ui: {} }), 'text')
  const explore = agentNodeOf(whole.roots, AGENT_WORLD.explore)
  const ui = { agentsExpanded: opened, agentsWeekOpen: true, agentSelected: explore.key, agentSelectedIn: 'tree' as const }
  const vm = buildViewModel(makeInput({ agg, cfg, ui }))
  const a = agentCtx()
  const world = agentsHtml(a, { agents: vm.agents, ui: agentUi(ui) })
  const kids = Array.from({ length: 3 }, (_, i) => treeNode(`a:kid${i}`, 'done', { label: `Explore · opus-5 · k${i}` }))
  const big = agentsHtml(a, {
    agents: agentTree({ roots: [treeNode(AK.wf, 'done', { kind: 'workflow', label: 'Workflow run Tue 11:40 · cfe7718d', hasChildren: true, childrenTotal: 380, childrenMore: 377, children: kids })] }),
    ui: agentUi({ agentsExpanded: [AK.wf] }),
  })
  let groups = 0, items = 0, mores = 0, panels = 0
  for (const h of [world, big]) {
    const doc = parseMarkup(h)
    const trees: El[] = []
    walkEls(doc, (e) => { if (hasClass(e, 'agtree')) trees.push(e) })
    assert.equal(trees.length, 1)
    const tree = trees[0]
    assert.deepEqual([tree.tag, tree.attrs.role, tree.kids.length, tree.kids[0].tag, tree.kids[0].attrs.role], ['div', 'tree', 1, 'ul', 'none'])
    // The details panel draws its token mix with empty bars of its own (1.6 L2): not the tree's lines.
    const inPanel = new Set<El>()
    walkEls(tree, (e) => { if (hasClass(e, 'ag-details')) walkEls(e, (x) => { if (x !== e) inPanel.add(x) }) })
    walkEls(tree, (e, parent) => {
      // A list is the roots' (role none, straight under the tree) or a group (role group, straight under an item).
      if (e.tag === 'ul') {
        assert.ok(e.attrs.role === 'none' ? parent === tree : e.attrs.role === 'group' && parent !== null && parent.tag === 'li' && parent.attrs.role === 'treeitem', JSON.stringify(e.attrs))
        if (e.attrs.role === 'group') groups++
        for (const li of e.kids) assert.deepEqual([li.tag, li.attrs.role], ['li', 'treeitem'])
      }
      if (e.tag === 'li') {
        assert.ok(parent !== null && parent.tag === 'ul', 'an item outside a list')
        if (parent?.attrs.role === 'group') items++
        // Its children: its line, then its details (if any), then its group (if any) — nothing else.
        const shape = e.kids.map((k) => (k.tag === 'div' && hasClass(k, 'ag-line') ? 'line' : k.tag === 'div' && hasClass(k, 'ag-details') ? 'details'
          : k.tag === 'ul' && k.attrs.role === 'group' ? 'group' : k.tag + '.' + (k.attrs.class ?? '')))
        assert.match(shape.join(' '), /^line( details)?( group)?$/, e.attrs['data-key'] ?? e.attrs['data-more'])
        if (shape.includes('details')) panels++
        // The line starts with the toggle (a node with children), or the empty slot of a leaf and a "more" line.
        const first = e.kids[0].kids[0]
        const more = hasClass(e, 'ag-k-more')
        if (more) mores++
        assert.ok(first.tag === 'span' && (hasClass(first, 'ag-fold') ? 'aria-expanded' in e.attrs && !more : hasClass(first, 'ag-pad') && !('aria-expanded' in e.attrs)),
          JSON.stringify([e.attrs, first.attrs]))
        assert.equal(e.kids[0].kids[1]?.attrs.class?.split(' ')[0], more ? 'ag-more' : 'ag-row')
      }
      // Nothing drawn with: every empty element of the tree is one of the 1.6 ones — the toggle, the leaf's
      // slot, a state glyph (their marks are generated content) — none a line.
      if (e.kids.length === 0 && e.text === '' && e.tag !== 'br' && !inPanel.has(e)) {
        assert.ok(['ag-fold', 'ag-pad', 'ag-st'].some((c) => hasClass(e, c)), e.tag + ' ' + JSON.stringify(e.attrs))
      }
      assert.equal(/guide|ag-ln\b|ag-vl\b/.test(e.attrs.class ?? ''), false, e.attrs.class)
    })
  }
  // The world held every case: groups at several levels, a panel inside one, a "more" line.
  assert.ok(groups >= 5 && items >= 12 && panels === 1 && mores === 1, JSON.stringify({ groups, items, panels, mores }))
  // 1.8 L-4: the gap at the panel is the fit's alone (fitGuides, on the measured page) — the renderer's
  // markup carries no class and no value of it.
  for (const h of [world, big]) assert.equal(/ag-gap/.test(h), false, h.slice(0, 200))
})

// ---------------------------------------------------------------------------
// 1.8 L-4 · the details panel's gap · L-5 · a thin split band in forced colours · L-6 · fits on open
// ---------------------------------------------------------------------------

/** 1.8 L-4: the rule that clips a vertical at the open details panel, as the stylesheet writes it (white space collapsed). */
const GAP_RULE = '.agtree ul[role="group"] > li.ag-gap::before { clip-path: polygon(0 0, 100% 0, 100% var(--ag-gap-t), 0 var(--ag-gap-t), '
  + '0 var(--ag-gap-b), 100% var(--ag-gap-b), 100% 100%, 0 100%); }'

test('1.8 L-4: the details panel paints no colour of its own and is not stacked over the lines — the verticals give way at its edge, a clip of the stylesheet, CanvasText kept in forced colours', () => {
  const { css, forcedAt, forcedEnd } = flatStyle()
  const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({ sel: m[1].trim(), body: m[2].trim() }))
  // Every rule that reaches the panel itself — the tree's, the running list's, the 7-day block's —: no
  // background, no z-index, no position. Its box, border and padding as before.
  const panel = rules.filter((r) => r.sel.split(',').some((x) => /\.ag-details$/.test(x.trim())))
  assert.ok(panel.length >= 3, panel.map((r) => r.sel).join(' | '))
  for (const r of panel) assert.equal(/(^|;)\s*(background(-color|-image)?|z-index|position)\s*:/.test(r.body), false, r.sel + ' { ' + r.body + ' }')
  assert.ok(css.indexOf('.ag-details { margin: 4px 0 6px calc(var(--ag-ind, 0) * -16px); border: 1px solid var(--line); border-radius: 4px; padding: 6px 8px; }') >= 0)
  assert.equal(css.indexOf('z-index: 1; background: var(--bg)'), -1)
  // The gap: one rule, outside the forced-colours block — the vertical drawn above --ag-gap-t and below
  // --ag-gap-b, and not between — on an item that wears ag-gap; the class and the two values are the
  // script's (fitGuides), no other rule names them.
  const at = css.indexOf(GAP_RULE)
  assert.ok(at >= 0 && at < forcedAt, 'missing: ' + GAP_RULE)
  assert.equal(css.split(GAP_RULE).length, 2)
  assert.equal(css.split('ag-gap').length - 1, 1 + 4)
  assert.equal(css.split('var(--ag-gap-t)').length - 1, 2)
  assert.equal(css.split('var(--ag-gap-b)').length - 1, 2)
  // A clip is no colour: nothing of it in the forced-colours block, the lines' CanvasText rule stays, and
  // nothing of the tree is taken out of the theme's adjustment.
  const forced = css.slice(forcedAt, forcedEnd)
  assert.equal(forced.includes('clip-path'), false)
  assert.ok(forced.includes(GUIDE_FORCED))
  assert.deepEqual(adjustedOut(), ADJUSTED_OUT)
  // The fit runs with the page's others: after every render and resize, and when a section opens.
  assert.match(SOURCE, /function applyFits\(\): void \{\s*fitChart\(\);\s*fitBands\(\);\s*fitScroll\(\);\s*scrollHeat\(\);\s*fitAgentNames\(\);\s*fitAgentFigures\(\);\s*fitGuides\(\);\s*\}/)
  // And when a clock in the open panel grows a unit, which may give the panel a line more.
  assert.match(SOURCE, /if \(grown\) \{ fitAgentFigures\(\); fitGuides\(\); \}/)
})

/** 1.8 L-4: an item of a group as fitGuides reads it — its box, its vertical's computed top and height — and what it writes. */
interface GapItem {
  top: number; bottom: number; vh: number | null; cls: Set<string>; props: Map<string, string>
  getBoundingClientRect: () => { top: number; bottom: number }
  classList: { add: (c: string) => void; remove: (c: string) => void; contains: (c: string) => boolean }
  style: { setProperty: (k: string, v: string) => void; removeProperty: (k: string) => void }
}

test('1.8 L-4: fitGuides gives every item whose vertical crosses the open details panel the gap — the panel\'s top and bottom from the item\'s top, 1 px clear each way — and takes it off every other, all measured first', () => {
  const a = agentCtx()
  const doc = (a.c as Record<string, unknown>).document as Record<string, unknown>
  const log: string[] = []
  const item = (name: string, top: number, bottom: number, vh: number | null, was: string[] = []): GapItem => {
    const cls = new Set<string>(was)
    const props = new Map<string, string>(was.includes('ag-gap') ? [['--ag-gap-t', '1px'], ['--ag-gap-b', '2px']] : [])
    const it: GapItem = {
      top, bottom, vh, cls, props,
      getBoundingClientRect: () => { log.push('read ' + name); return { top: it.top, bottom: it.bottom } },
      classList: { add: (c) => { log.push('write ' + name); cls.add(c) }, remove: (c) => { log.push('write ' + name); cls.delete(c) }, contains: (c) => cls.has(c) },
      style: { setProperty: (k, v) => { log.push('write ' + name); props.set(k, v) }, removeProperty: (k) => { log.push('write ' + name); props.delete(k) } },
    }
    return it
  }
  // A group's items as the page stacks them: one above the panel's owner, the owner's parent (not last:
  // its vertical runs its whole height, past the panel), the owner (not last either), the owner's last
  // child (its vertical down to its stub only), a sibling below, and an item that is the last of its
  // group and holds the panel in its box — its vertical ends at its stub, above the panel.
  const above = item('above', 76, 100, 24)
  const parent = item('parent', 100, 400, 300)
  const owner = item('owner', 124, 380, 256)
  const lastKid = item('lastKid', 380, 400, 9)
  const below = item('below', 400, 424, 24, ['ag-gap'])
  const lastOwner = item('lastOwner', 124, 380, 9)
  const items = [above, parent, owner, lastKid, below, lastOwner]
  let panel: { getBoundingClientRect: () => { top: number; bottom: number } } | null = { getBoundingClientRect: () => ({ top: 150.4, bottom: 250.2 }) }
  doc.querySelectorAll = (q: string) => (q === '.agtree ul[role="group"] > li' ? items : [])
  doc.querySelector = (q: string) => (q === '.agtree .ag-details' ? panel : null)
  ;(a.c as Record<string, unknown>).getComputedStyle = (el: GapItem, pseudo: string) => {
    assert.equal(pseudo, '::before')
    log.push('read ' + items.indexOf(el))
    return { top: '0px', height: el.vh === null ? '' : el.vh + 'px' }
  }
  const gapOf = (x: GapItem): unknown => (x.cls.has('ag-gap') ? [x.props.get('--ag-gap-t'), x.props.get('--ag-gap-b')] : x.props.size ? 'stray' : null)
  nodeVm.runInContext('fitGuides()', a.c)
  assert.deepEqual(items.map(gapOf), [null, ['49.4px', '151.2px'], ['25.4px', '127.2px'], null, null, null])
  // Every read before the first write.
  const firstWrite = log.findIndex((l) => l.startsWith('write'))
  assert.ok(firstWrite > 0 && log.slice(firstWrite).every((l) => l.startsWith('write')), log.join(', '))
  // A vertical whose height the browser does not say runs the item's whole box.
  lastOwner.vh = null
  nodeVm.runInContext('fitGuides()', a.c)
  assert.deepEqual(gapOf(lastOwner), ['25.4px', '127.2px'])
  lastOwner.vh = 9
  // Run again unchanged: the same (the fit is idempotent).
  nodeVm.runInContext('fitGuides()', a.c)
  assert.deepEqual(items.map(gapOf), [null, ['49.4px', '151.2px'], ['25.4px', '127.2px'], null, null, null])
  // The panel closed (its section folded: no height) or gone: every gap comes off, class and values.
  panel = { getBoundingClientRect: () => ({ top: 0, bottom: 0 }) }
  nodeVm.runInContext('fitGuides()', a.c)
  assert.deepEqual(items.map(gapOf), items.map(() => null))
  panel = { getBoundingClientRect: () => ({ top: 150.4, bottom: 250.2 }) }
  nodeVm.runInContext('fitGuides()', a.c)
  panel = null
  nodeVm.runInContext('fitGuides()', a.c)
  assert.deepEqual(items.map(gapOf), items.map(() => null))
  // A page without a group: one query, nothing thrown.
  doc.querySelectorAll = () => []
  nodeVm.runInContext('fitGuides()', a.c)
})

test('1.8 L-5: a forced-colours theme stripes a subagents\' band drawn under 4 px tall — one pixel of the text colour in three across its width, no ring, out of the adjustment for that one rule; a main sessions\' band stays solid', () => {
  const css = STYLE.replace(/\n {2}\/\*[\s\S]*?\*\//g, '').replace(/\/\*[\s\S]*?\*\//g, '')
  const at = css.indexOf('@media (forced-colors: active) {')
  const block = css.slice(at, css.indexOf('\n}', at) + 2)
  const rule = '.band.sp-sub.band-thin { forced-color-adjust: none; outline: none; background: repeating-linear-gradient(90deg, CanvasText 0 1px, Canvas 1px 3px); }'
  // Once, in the one forced-colours block, right after the subagents' own rule — which it outranks by its
  // third class, so its stripes and its missing ring win on a thin band and nowhere else.
  assert.ok(block.includes('\n  .band.sp-sub { background: Canvas; outline: 1px solid CanvasText; outline-offset: -1px; }\n  ' + rule + '\n'), block)
  assert.equal(css.split('.sp-sub.band-thin').length - 1, 1)
  // The main sessions' band keeps its solid paint at every height: no rule of its own for a thin one.
  assert.equal(/\.sp-main\.band-thin|\.band-thin\.sp-main/.test(css), false)
  // The theme's two colours alone — no variable, no literal —, the stripes vertical, a period of 3 px.
  const body = rule.slice(rule.indexOf('{') + 1, rule.lastIndexOf('}'))
  assert.deepEqual(colourLiterals(body.slice(body.indexOf('background:') + 'background:'.length)), [])
  assert.equal(/var\(|#[0-9a-f]{3}|rgb|hsl|color-mix/i.test(body), false)
  // The only thing of the split taken out of the adjustment (the list the other tests hold the page to).
  assert.deepEqual(adjustedOut().filter((x) => /sp-(main|sub)\b(?!,)/.test(x) && !/:not/.test(x)), ['.band.sp-sub.band-thin'])
  // A split band is a `.seg` like every band of the chart, so fitBands gives it `band-thin` under 4 px.
  const h = render('sChart()', {
    chart: {
      days: ['2026-09-01'], labels: ['09-01'], split: 'agents',
      series: [
        { key: 'claude:main', label: 'Claude Code · main sessions', source: 'claude', rank: 0, values: [1000] },
        { key: 'claude:sub', label: 'Claude Code · subagents', source: 'claude', rank: 1, values: [5] },
      ],
      metric: 'usage', modelStyle: 'pattern', max: 1005, ticks: [250, 500, 750, 1000], weekly: false, costLine: null,
    },
  })
  assert.ok(h.includes('<div class="seg band s-claude-1 hue-claude r1 st-pattern sp-sub" data-bh="0.50"'), h)
})

test('1.8 L-6: opening a folded section runs every fit — the script registers one toggle listener, and it calls applyFits: a chart drawn closed has its labels thinned once it opens', () => {
  const a = agentCtx()
  // One listener for the toggle event, in the capture phase (the event does not bubble), none other.
  assert.deepEqual(Object.keys(a.listeners).filter((k) => /toggle/.test(k)), ['document:toggle:capture'])
  assert.equal(a.listeners['document:toggle:capture'].length, 1)
  assert.equal(SOURCE.split("addEventListener('toggle'").length - 1, 1)
  assert.match(SOURCE, /document\.addEventListener\('toggle', \(\) => \{ if \(vm\) applyFits\(\); \}, true\);/)
  // It calls applyFits, once per event, while the page has a view model.
  const c = a.c as Record<string, unknown>
  const real = c.applyFits
  let calls = 0
  c.applyFits = () => { calls++ }
  nodeVm.runInContext('vm = null', a.c)
  a.fire('document:toggle', {})
  assert.equal(calls, 0)
  nodeVm.runInContext('vm = { sections: [] }', a.c)
  a.fire('document:toggle', {})
  assert.equal(calls, 1)
  c.applyFits = real
  // A chart drawn inside a closed section: thirty columns, every value label and every date. Closed, it
  // has no width, and the fit leaves every label; opened, the toggle thins them to the width it has.
  const doc = c.document as Record<string, unknown>
  const values = Array.from({ length: 30 }, (_, i) => ({ dataset: { i: String(i) }, hidden: false }))
  const dates = Array.from({ length: 30 }, (_, i) => {
    const inner = { textContent: '09-' + String(i + 1).padStart(2, '0') }
    return { dataset: { i: String(i), l: inner.textContent }, firstElementChild: inner }
  })
  const chart = { children: { length: 30 }, clientWidth: 0, clientHeight: 0,
    querySelectorAll: (q: string) => (q === '.vlabel' ? values : []) }
  const axis = { querySelectorAll: (q: string) => (q === 'span' ? dates : []) }
  doc.querySelector = (q: string) => (q === '.chart' ? chart : q === '.plot + .axis' ? axis : null)
  doc.querySelectorAll = () => []
  nodeVm.runInContext('applyFits()', a.c)
  assert.equal(values.filter((v) => v.hidden).length, 0)
  assert.equal(dates.filter((d) => d.firstElementChild.textContent === '').length, 0)
  // Opened: 236 px across thirty columns, 5.93 px a column — every sixth value and every sixth date stay.
  chart.clientWidth = 236
  chart.clientHeight = 240
  a.fire('document:toggle', {})
  assert.deepEqual(values.map((v, i) => [i, v.hidden]).filter(([, hid]) => !hid).map(([i]) => i), [0, 6, 12, 18, 24])
  assert.deepEqual(dates.map((d) => d.firstElementChild.textContent).filter(Boolean), ['09-01', '09-07', '09-13', '09-19', '09-25'])
})

// ---------------------------------------------------------------------------
// 1.8 A5, A6, A7: the Claude card's prompt-cache block and the Codex card's line, on the page
// ---------------------------------------------------------------------------

const PC_STATE = 'Session Thu 11:05 · 9d0eb37a · prompt cache cools in 4 m 10 s (1 h TTL)'
const PC_COST = 'A cold start after 12:04 re-writes 152.3K tokens at the 1 h write rate (2× input, ~$1.22) instead of reading them from the cache (0.05× input, ~$0.03).'
const PC_COLD = 'Session Thu 09:40 · aaaa1111 · prompt cache cold since ~11:40 (1 h TTL, estimated from the transcript)'
const PC_COLD_COST = 'The next request re-writes ~152.3K tokens at the 1 h write rate (2× input, ~$1.22) instead of reading them from the cache (0.05× input, ~$0.03).'

/** The Claude card's block as the view model hands it on: `lines` with their cost lines, the count of the rest. */
function cacheBlock(over: Record<string, unknown> = {}): Record<string, unknown> {
  const lines = [
    { shortId: '9d0eb37a', phase: 'cooling', source: 'bridge', text: PC_STATE, cost: PC_COST },
    { shortId: 'aaaa1111', phase: 'cold', source: 'transcript', text: PC_COLD, cost: PC_COLD_COST },
  ]
  return { lines, more: 0, moreText: null, all: lines, allMoreText: null, keepWarm: null, ...over }
}

test('the Claude card lists each cooling or cold session after its windows: the state line, the cost line under it, both dim; the count; the 1.3 line last (1.8 A5)', () => {
  const line13 = 'prompt cache warm · expires in 20 m 0 s (1 h TTL) · hit ratio 90 %'
  const h = render('sQuota()', {
    quotas: [card({
      cacheWatch: cacheBlock({ more: 2, moreText: '2 more sessions with a cooling or cold prompt cache' }),
      promptCache: { text: line13, note: 'n', expired: false },
      extra: { text: '$12 of $50', utilization: 24, enabled: true, billed: true },
    })],
  })
  // 1.10 B5 rule 3 (rewritten): every line of the block and the 1.3 line glued.
  const block = '<div class="meta pc-line">' + glued(PC_STATE) + '</div><div class="meta pc-cost">' + glued(PC_COST) + '</div>'
    + '<div class="meta pc-line">' + glued(PC_COLD) + '</div><div class="meta pc-cost">' + glued(PC_COLD_COST) + '</div>'
    + '<div class="meta pc-more">2 more sessions with a cooling or cold prompt cache</div>'
  assert.ok(h.indexOf(block + '<div class="meta" title="n">' + glued(line13) + '</div></div>') >= 0, h)
  // After the windows and the extra usage: where the 1.3 line has stood since 1.3.
  assert.ok(h.indexOf(block) > h.lastIndexOf('class="win"'), h)
  assert.ok(h.indexOf(block) > h.indexOf('Extra usage'), h)
  // No button of any kind (the keep-warm prompt is not built, §7a Q1), no live region, no glyph.
  const only = h.slice(h.indexOf(block), h.indexOf(block) + block.length)
  assert.equal(/<button|role=|aria-live|tabindex/.test(only), false, only)
  // A line without a cost line has none; nothing to list is no block; a warm-only block draws nothing.
  const bare = render('sQuota()', { quotas: [card({ cacheWatch: cacheBlock({ lines: [{ shortId: '9d0eb37a', phase: 'cooling', source: 'bridge', text: PC_STATE, cost: null }] }) })] })
  assert.ok(bare.indexOf('<div class="meta pc-line">' + glued(PC_STATE) + '</div></div>') >= 0, bare)
  assert.equal(bare.indexOf('pc-cost'), -1, bare)
  for (const cacheWatch of [null, undefined, cacheBlock({ lines: [], all: [{ text: 'x · prompt cache warm · cools in 30 m 0 s (1 h TTL)' }] }), { lines: 'x' }, 42]) {
    const none = render('sQuota()', { quotas: [card({ cacheWatch })] })
    assert.equal(/pc-(line|cost|more)/.test(none), false, JSON.stringify(cacheWatch) + ': ' + none)
    assert.equal(none.indexOf('prompt cache'), -1, none)
  }
  // Escaped like every word the model hands over.
  const odd = render('sQuota()', { quotas: [card({ cacheWatch: cacheBlock({ lines: [{ text: '<img src=x onerror=alert(1)>', cost: '"&' }] }) })] })
  assert.ok(odd.indexOf('<div class="meta pc-line">&lt;img src=x onerror=alert(1)&gt;</div><div class="meta pc-cost">&quot;&amp;</div>') >= 0, odd)
})

test('the Codex card ends with its one prompt-cache line, dim, the view model\'s words; none without one (1.8 A6)', () => {
  const line = 'Codex prompt cache · last request at 11:50 · OpenAI keeps a cached prompt prefix at least 30 minutes after its last use for GPT-5.6 and later — ~until 12:20, perhaps longer.'
  const h = render('sQuota()', { quotas: [card(), card({ source: 'codex', title: 'Codex', codexCache: line })] })
  assert.ok(h.indexOf('<div class="meta pc-codex">' + line + '</div></div>') > h.indexOf('Codex</span>'), h)
  assert.equal(h.split('pc-codex').length - 1, 1, h)
  for (const codexCache of [null, undefined, '', 7]) {
    assert.equal(render('sQuota()', { quotas: [card({ source: 'codex', title: 'Codex', codexCache })] }).indexOf('pc-codex'), -1)
  }
})

test('the prompt-cache lines are dim text with no colour of their own, and the forced-colours block leaves them to the theme (1.8 A7)', () => {
  // 1.8 P10 (pinned and changed): today's keep-warm accounting closes the block with the count's air; a
  // keep-warm note sits right under its entry, as a cost line does.
  assert.match(STYLE, /\.pc-line, \.pc-more, \.pc-codex, \.pc-today \{ margin-top: 4px; \}/)
  const rules = STYLE.replace(/\/\*[\s\S]*?\*\//g, '').split('}').filter((r) => /\.pc-/.test(r))
  assert.equal(rules.length, 1, rules.join('}'))
  assert.equal(/color|background|forced-color-adjust/.test(rules[0]), false, rules[0])
  // The page's script writes them as .meta lines: the card's dim tone, which the harness holds to 4.5:1.
  assert.match(SOURCE, /'<div class="meta pc-line">'/)
  assert.match(SOURCE, /'<div class="meta pc-cost">'/)
  assert.match(SOURCE, /'<div class="meta pc-codex">'/)
})

const PC_S1 = '9d0eb37a-0000-4000-8000-000000000001'
const PC_S2 = '5f1c2d3e-0000-4000-8000-000000000002'
const PC_T1 = 'aaaa1111-0000-4000-8000-000000000004'
const PC_T2 = 'bbbb2222-0000-4000-8000-000000000005'

/** A bridge reading of `sessionId`: a 1 h cache expiring at `expiresAt`, read a minute ago, 152 300 tokens on Opus 5.5. */
function pcReading(sessionId: string, expiresAt: number): PromptCacheReading {
  return { warm: true, ttl: '1h', expiresAt, hitRatio: 0.9, readAt: Math.floor((NOW - 60_000) / 1000), sessionId, recacheIfCold: 152_300, model: 'claude-opus-5-5' }
}

/**
 * A real view model: the fixture's world plus a transcript session cooling (its newest request 56
 * minutes ago), a bridge session cooling with 4 m 10 s left, a bridge session cold for 20 minutes, a
 * transcript session warm with 30 minutes left, and — with `codex` — a GPT-5.6 turn 10 minutes ago.
 */
function cacheWorld(o: { cfg?: Record<string, unknown>; providers?: ('claude' | 'codex')[]; codex?: boolean } = {}): Record<string, unknown> {
  const agg = buildAgg()
  addCacheSession(agg, { sessionId: PC_T1, at: NOW - 56 * 60_000 })
  addCacheSession(agg, { sessionId: PC_T2, at: NOW - 30 * 60_000, model: 'claude-fable-5-1' })
  if (o.codex) {
    const file = join('/virtual', 'codex', 'sessions', 'rollout-cache.jsonl')
    const cur = { offset: 0, size: 0, ino: 91, dev: 1 }
    agg.cursors.set(file, cur)
    const c = ctxFor({ file })
    const at = NOW - 10 * 60_000
    agg.addCodexLine(codexMeta({ ts: at - 60_000, id: 'thread-0091' }), cur, c)
    agg.addCodexLine(codexTurnContext(at - 60_000, 'gpt-5.6-sol'), cur, c)
    agg.addCodexLine(codexTokenCount({ ts: at, total: { input: 900, cached: 600, output: 40, total: 940 } }), cur, c)
  }
  const promptCaches = [pcReading(PC_S1, NOW + 4 * 60_000 + 10_000), pcReading(PC_S2, NOW - 20 * 60_000)]
  const input = {
    ...makeInput({ agg, cfg: makeConfig({ 'tokenPace.dashboard.sections': ['quota'], ...(o.cfg ?? {}) }), ...(o.providers ? { ui: { providers: o.providers } } : {}) }),
    promptCaches, promptCache: promptCaches[0],
  }
  return JSON.parse(JSON.stringify(buildViewModel(input))) as Record<string, unknown>
}

/** The quota cards of a rendered page, each its own markup, by the card's title. */
function cardsOf(html: string): Array<{ title: string; html: string }> {
  return html.split('<div class="card">').slice(1).map((c) => ({ title: (/<span class="name">([^<]*)<\/span>/.exec(c) ?? [])[1] ?? '', html: c }))
}

test('from a real view model: three lines and their costs on the Claude card, none for the warm session, no money with costs off (1.8 A5)', () => {
  const [claude, codex] = cardsOf(pageOf(cacheWorld()))
  assert.equal(claude.title, 'Claude Code')
  const states = [...claude.html.matchAll(/<div class="meta pc-line">([^<]*)<\/div>/g)].map((m) => m[1])
  const costs = [...claude.html.matchAll(/<div class="meta pc-cost">([^<]*)<\/div>/g)].map((m) => m[1])
  // 1.10 B5 rule 3 (rewritten: the lines are glued on the page).
  assert.deepEqual(states, [
    'Session Thu 10:04 · aaaa1111 · prompt cache cools in ~4 m 0 s (1 h TTL, estimated from the transcript)',
    'Session 9d0eb37a · prompt cache cools in 4 m 10 s (1 h TTL)',
    'Session 5f1c2d3e · prompt cache cold since 11:40 (1 h TTL)',
  ].map(glued))
  assert.equal(costs.length, 3)
  assert.ok(costs.every((c) => c.includes('~$')), costs.join('\n'))
  // The warm session is the markdown's; the card says nothing of it. The latest mirror's session is listed, so no 1.3 line.
  assert.equal(claude.html.includes('bbbb2222'), false, claude.html)
  assert.equal(claude.html.includes('hit ratio'), false, claude.html)
  // The block stands after the card's last window.
  assert.ok(claude.html.indexOf('pc-line') > claude.html.lastIndexOf('class="win"'), claude.html)
  // The Codex card has no block: its turns are GPT-5.3 here, for which OpenAI states no minimum.
  assert.equal(/pc-/.test(codex.html), false, codex.html)
  // Costs off: the factors stay, no money anywhere on the card.
  const [plain] = cardsOf(pageOf(cacheWorld({ cfg: { 'tokenPace.showCost': false } })))
  const block = [...plain.html.matchAll(/<div class="meta pc-(?:line|cost|more)">([^<]*)<\/div>/g)].map((m) => m[1]).join('\n')
  assert.ok(block.includes('(2× input)'), block)
  assert.equal(block.includes('$'), false, block)
})

test('the provider switch: under Codex no Claude card and so no block, the Codex line on its card; under Claude Code no Codex line (1.8 §3 A8 test 14)', () => {
  const all = cardsOf(pageOf(cacheWorld({ codex: true })))
  assert.deepEqual(all.map((c) => c.title), ['Claude Code', 'Codex'])
  assert.equal(all[0].html.split('pc-line').length - 1, 3)
  assert.equal(all[0].html.includes('pc-codex'), false)
  const line = 'Codex prompt cache · last request at 11:50 · OpenAI keeps a cached prompt prefix at least 30 minutes after its last use for GPT-5.6 and later — ~until 12:20, perhaps longer.'
  assert.ok(all[1].html.includes('<div class="meta pc-codex">' + line + '</div>'), all[1].html)
  const codex = pageOf(cacheWorld({ codex: true, providers: ['codex'] }))
  assert.deepEqual(cardsOf(codex).map((c) => c.title), ['Codex'])
  assert.equal(/pc-(line|cost|more)|prompt cache cools|prompt cache cold/.test(codex), false, codex)
  assert.equal(codex.split('pc-codex').length - 1, 1, codex)
  const claude = pageOf(cacheWorld({ codex: true, providers: ['claude'] }))
  assert.deepEqual(cardsOf(claude).map((c) => c.title), ['Claude Code'])
  assert.equal(claude.includes('pc-codex') || claude.includes('Codex prompt cache'), false, claude)
  assert.equal(claude.split('pc-line').length - 1, 3)
})

test('one line per session on the page, at any minute: the Claude card names a session once, the 1.3 line only while its session is not listed (1.8 §3 A8 test 11)', () => {
  // The P6 invariant's world: session 9d0eb37a has its transcript's newest cache request and a bridge
  // reading written a minute later — the latest mirror, the 1.3 line —, aaaa1111 its transcript only.
  const T = NOW - 30 * 60_000
  const agg = buildAgg()
  addCacheSession(agg, { sessionId: PC_S1, at: T })
  addCacheSession(agg, { sessionId: PC_T1, at: T + 7 * 60_000 })
  const reading: PromptCacheReading = {
    warm: true, ttl: '1h', expiresAt: T + 3_600_000 + 30_000, hitRatio: 0.9, readAt: Math.floor((T + 60_000) / 1000),
    sessionId: PC_S1, recacheIfCold: 152_300, model: 'claude-opus-5-5',
  }
  const base = makeInput({ agg, cfg: makeConfig({ 'tokenPace.dashboard.sections': ['quota'] }) })
  const names = (html: string, id: string): number => html.split(`· ${id.slice(0, 8)} ·`).length - 1 + html.split(`Session ${id.slice(0, 8)} ·`).length - 1
  let listedMinutes = 0
  for (let now = reading.expiresAt! - 70 * 60_000; now <= reading.expiresAt! + 70 * 60_000; now += 60_000) {
    const vm = JSON.parse(JSON.stringify(buildViewModel({ ...base, now, promptCache: reading, promptCaches: [reading] }))) as Record<string, unknown>
    const claude = cardsOf(pageOf(vm))[0].html
    const old = claude.split('<div class="meta" title=').length - 1 + claude.split('<div class="meta warn" title=').length - 1
    const listed = /<div class="meta pc-line">[^<]*9d0eb37a/.test(claude)
    if (listed) listedMinutes++
    assert.ok(names(claude, PC_S1) + old <= 1, `the card names 9d0eb37a twice at ${now}`)
    assert.ok(names(claude, PC_T1) <= 1, `the card names aaaa1111 twice at ${now}`)
    // Mutation check (§3 A8 test 11): the 1.3 line printed always fails here.
    assert.equal(old === 0, listed, `the 1.3 line at ${now}: listed ${listed}`)
    // Every state line has its cost line right under it.
    assert.equal(claude.split('pc-line').length, claude.split('pc-cost').length, `at ${now}`)
  }
  assert.equal(listedMinutes, 65)
})

// ---------------------------------------------------------------------------
// 1.8 B2 (P10): the keep-warm notes and accounting on the page; §7c wave 2 fact 10: `all` stays in the host
// ---------------------------------------------------------------------------

const KW_ARMED = 'Keep-warm line for this session in 42 s — cancel it in the status bar.'
const KW_NONE = 'Keep-warm cannot reach this session: it does not run in a VS Code terminal of this window.'
const KW_TODAY = 'Keep-warm requests today: 2 · 64 tokens'

test('a keep-warm note stands right under the entry it concerns, today\'s accounting under the block, both dim and escaped (1.8 §3 B2 "Card notes", "Accounting")', () => {
  const h = render('sQuota()', {
    quotas: [card({
      cacheWatch: cacheBlock({
        more: 1, moreText: '1 more session with a cooling or cold prompt cache',
        keepWarm: {
          notes: [{ line: 0, shortId: '9d0eb37a', kind: 'armed', text: KW_ARMED }, { line: 1, shortId: 'aaaa1111', kind: 'noTerminal', text: KW_NONE }],
          today: KW_TODAY,
        },
      }),
    })],
  })
  // 1.10 B5 rule 3 (rewritten): the lines and the notes glued.
  const block = '<div class="meta pc-line">' + glued(PC_STATE) + '</div><div class="meta pc-cost">' + glued(PC_COST) + '</div>'
    + '<div class="meta pc-note">' + glued(KW_ARMED) + '</div>'
    + '<div class="meta pc-line">' + glued(PC_COLD) + '</div><div class="meta pc-cost">' + glued(PC_COLD_COST) + '</div>'
    + '<div class="meta pc-note">' + KW_NONE + '</div>'
    + '<div class="meta pc-more">1 more session with a cooling or cold prompt cache</div>'
    + '<div class="meta pc-today">' + KW_TODAY + '</div>'
  assert.ok(h.indexOf(block) >= 0, h)
  // No button, no link, no live region: the countdown is cancelled in the status bar.
  assert.equal(/<button|<a |role=|aria-live|tabindex/.test(h.slice(h.indexOf(block), h.indexOf(block) + block.length)), false)
  // A note for no listed entry, a broken note, a missing part: nothing drawn of it; the rest as before.
  for (const keepWarm of [null, undefined, 7, { notes: 'x', today: 5 }, { notes: [{ line: 5, text: 'x' }, { line: 0 }, null], today: '' }]) {
    const none = render('sQuota()', { quotas: [card({ cacheWatch: cacheBlock({ keepWarm }) })] })
    assert.equal(/pc-note|pc-today/.test(none), false, JSON.stringify(keepWarm) + ': ' + none)
    assert.equal(none.split('pc-line').length - 1, 2)
  }
  // The accounting line alone, on a block with no line: a day with answered lines keeps it on the card.
  const alone = render('sQuota()', { quotas: [card({ cacheWatch: cacheBlock({ lines: [], all: [], keepWarm: { notes: [], today: KW_TODAY } }) })] })
  assert.ok(alone.includes('<div class="meta pc-today">' + KW_TODAY + '</div></div>'), alone)
  const odd = render('sQuota()', { quotas: [card({ cacheWatch: cacheBlock({ keepWarm: { notes: [{ line: 0, text: '<b>x</b>' }], today: '"&' } }) })] })
  assert.ok(odd.includes('<div class="meta pc-note">&lt;b&gt;x&lt;/b&gt;</div>') && odd.includes('<div class="meta pc-today">&quot;&amp;</div>'), odd)
  // Both are .meta lines: the card's dim tone; the accounting line has the count's air above it.
  assert.match(SOURCE, /'<div class="meta pc-note">'/)
  assert.match(SOURCE, /'<div class="meta pc-today">'/)
})

test('from a real view model with the keep-warm host\'s view: the note under its session\'s lines, the accounting line last in the block (1.8 B2)', () => {
  const agg = buildAgg()
  addCacheSession(agg, { sessionId: PC_T1, at: NOW - 56 * 60_000 })
  const promptCaches = [pcReading(PC_S1, NOW + 2 * 60_000 + 42_000)]
  const input = {
    ...makeInput({ agg, cfg: makeConfig({ 'tokenPace.dashboard.sections': ['quota'] }) }),
    promptCaches, promptCache: promptCaches[0],
    keepWarm: { armed: { sessionId: PC_S1, endsAt: NOW + 42_000 }, noTerminal: [], unanswered: [], today: { requests: 2, tokens: 64 } },
  }
  const vm = JSON.parse(JSON.stringify(buildViewModel(input))) as Record<string, unknown>
  const [claude] = cardsOf(pageOf(vm))
  const lines = [...claude.html.matchAll(/<div class="meta (pc-[a-z]+)">([^<]*)<\/div>/g)].map((m) => [m[1], m[2].slice(0, 40)])
  assert.deepEqual(lines.map((l) => l[0]), ['pc-line', 'pc-cost', 'pc-note', 'pc-line', 'pc-cost', 'pc-today'])
  // 1.10 B5 rule 3 (rewritten: the note is glued).
  assert.ok(claude.html.includes('<div class="meta pc-note">' + glued(KW_ARMED) + '</div>'), claude.html)
  assert.ok(claude.html.includes('<div class="meta pc-today">' + KW_TODAY + '</div>'), claude.html)
  // The note is the bridge session's, under its entry — listed first, its expiry the sooner of the two.
  const block = (vm.quotas as Array<{ cacheWatch: { lines: Array<{ shortId: string }>; keepWarm: { notes: Array<{ line: number; shortId: string }> } } }>)[0].cacheWatch
  assert.equal(block.lines[block.keepWarm.notes[0].line].shortId, '9d0eb37a')
})

test('no push carries a prompt-cache block\'s `all` or `allMoreText` — the whole page or the quota fragment —, the host\'s view model keeps both, and a change of `all` alone pushes nothing (1.8 P10, §7c wave 2 fact 10)', () => {
  const { HOST_ONLY_CACHE_FIELDS, pagePayload, pageQuotas } = loadDashboard()
  assert.deepEqual([...HOST_ONLY_CACHE_FIELDS], ['all', 'allMoreText'])
  const vm = cacheWorld()
  const claude = (vm.quotas as Array<{ cacheWatch: Record<string, unknown> | null }>)[0]
  assert.ok(Array.isArray(claude.cacheWatch?.all) && (claude.cacheWatch?.all as unknown[]).length === 4, 'the world watches four sessions')
  const page = pagePayload(vm as never) as unknown as { quotas: Array<{ cacheWatch: Record<string, unknown> | null }> }
  assert.equal('all' in (page.quotas[0].cacheWatch ?? {}), false)
  assert.equal('allMoreText' in (page.quotas[0].cacheWatch ?? {}), false)
  // Everything else of the block, and of the card, goes as it is; the host's model is not touched.
  const { all, allMoreText, ...rest } = claude.cacheWatch as Record<string, unknown>
  void allMoreText
  assert.deepEqual(page.quotas[0].cacheWatch, rest)
  assert.ok(Array.isArray(all) && (claude.cacheWatch as Record<string, unknown>).all === all)
  assert.deepEqual(pageQuotas([]), [])
  // Through the provider: the whole page and every quota fragment after it.
  const r = throttleRig()
  r.p.update(vm as never)
  r.p.resolveWebviewView(r.view)
  const later = JSON.parse(JSON.stringify(vm)) as typeof vm
  const block = (later.quotas as Array<{ cacheWatch: { lines: Array<{ text: string }> } }>)[0].cacheWatch
  block.lines[0].text += ' ·'
  r.advance(AG_NOW + 10_000)
  r.p.update(later as never)
  assert.deepEqual(r.posted.map((m) => m.type), ['data', 'section'])
  const text = JSON.stringify(r.posted)
  assert.equal(/"all(MoreText)?":/.test(text), false, 'a push carries the block\'s `all`')
  assert.equal(text.includes('bbbb2222'), false, 'a push names the warm session the page never draws')
  // A change of `all` alone — the warm session's countdown — is nothing the page would see: no fragment.
  const warmOnly = JSON.parse(JSON.stringify(later)) as typeof vm
  const wb = (warmOnly.quotas as Array<{ cacheWatch: { all: Array<{ text: string }> } }>)[0].cacheWatch
  wb.all[3].text = wb.all[3].text.replace('30 m 0 s', '29 m 55 s')
  r.posted.length = 0
  r.advance(AG_NOW + 20_000)
  r.p.update(warmOnly as never)
  assert.deepEqual(r.posted, [])
})

test('the page never reads a prompt-cache block\'s `all` or `allMoreText` (1.8 P10, static)', () => {
  const code = SOURCE.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
  assert.equal(/allMoreText/.test(code), false)
  assert.equal(/\b(cw|cacheWatch)\s*(\?\.|\.)\s*all\b/.test(code), false)
  assert.equal(/\[\s*['"]all['"]\s*\]/.test(code), false)
})

// ---------------------------------------------------------------------------
// 1.9 A3, A4, A6: the language picker on the page, and the words push (A7 tests 3–4)
// ---------------------------------------------------------------------------

/** The picker's part of a view model: English shown, German on disk too — `setting` checked. */
function languageVmOf(setting: 'auto' | 'en' | 'de' = 'en', over: Record<string, unknown> = {}): Record<string, unknown> {
  const { resolveLanguage } = require('../src/languages') as typeof import('../src/languages')
  const vm = buildViewModel({ ...makeInput(), language: { resolved: resolveLanguage(setting, 'en', ['en', 'de']), available: ['en', 'de'], vscode: 'en' } })
  return { ...(JSON.parse(JSON.stringify(vm.language)) as Record<string, unknown>), ...over }
}

const LANG_NOTE = "Token Pace's own texts switch at once. The settings, the command titles and the walkthrough follow VS Code's display language (Configure Display Language)."
const LANG_QUALITY = 'The languages beyond English and German were translated by AI agents and checked by tests, not by native speakers.'

test('the top row holds the provider switch as it was and the language picker at its end: a menu button with the shown language\'s flag, its name and the note (1.9 A3.1, A3.2, A7 test 3)', () => {
  const { FLAG_SVG } = require('../src/flags') as typeof import('../src/flags')
  // The page carries the flags as they are drawn in src/flags.ts, and nothing else.
  assert.deepEqual(JSON.parse(JSON.stringify(nodeVm.runInContext('FLAGS', ctx))), JSON.parse(JSON.stringify(FLAG_SVG)))
  assert.match(SCRIPT, /\nconst FLAGS = \{"us":"\\u003csvg class=\\"flag\\" viewBox=\\"0 0 30 20\\"/)
  const h = render('langOpen = false; sProvider()', { provider: 'all', language: languageVmOf('en') })
  const button = '<button class="lng-btn" data-act="langOpen" aria-haspopup="menu" aria-expanded="false" aria-controls="lng-menu"'
    + ' aria-label="Language: English" title="' + LANG_NOTE.replace(/'/g, '&#39;') + '">' + FLAG_SVG.us
    + '<span class="lng-caret" aria-hidden="true">▾</span></button>'
  // The group is unchanged — exactly the switch's buttons —, the picker outside it, at the row's end.
  assert.equal(h, switchHtml('all', undefined, '<div class="lng">' + button + '</div>'))
  assert.equal(h.split('role="group"').length - 1, 1)
  assert.ok(h.indexOf('<div class="lng">') > h.indexOf('</div>'), 'the picker is inside the group')
  // The flag is decoration: hidden, not focusable; the name says what the button is.
  assert.match(FLAG_SVG.us, /^<svg class="flag" viewBox="0 0 30 20" aria-hidden="true" focusable="false">/)
  // Under auto the name says so; the German flag for German; no picker for a payload without it.
  assert.ok(render('langOpen = false; sLanguage()', { language: languageVmOf('auto') }).includes('aria-label="Language: English (automatic)"'))
  const de = render('langOpen = false; sLanguage()', { language: languageVmOf('de', { buttonLabel: 'Sprache: Deutsch' }) })
  assert.ok(de.includes('aria-label="Sprache: Deutsch"') && de.includes(FLAG_SVG.de), de)
  assert.equal(render('sLanguage()', {}), '')
  assert.equal(render('sLanguage()', { language: { options: 'x' } }), '')
  // A flag the page has no drawing for draws nothing, and the words the view model carries are escaped.
  const odd = render('langOpen = false; sLanguage()', { language: languageVmOf('en', { flag: 'constructor', buttonLabel: '<b>"x"</b>' }) })
  assert.ok(odd.includes('aria-label="&lt;b&gt;&quot;x&quot;&lt;/b&gt;"') && !odd.includes('<svg'), odd)
  // The row's rules: wrapping when it must, the picker at the end, the switch's buttons never wrapping.
  assert.match(STYLE, /\n\.top \{ display: flex; flex-wrap: wrap; align-items: center; gap: 4px 8px; \}\n/)
  assert.match(STYLE, /\n\.lng \{ position: relative; margin-inline-start: auto; \}\n/)
  assert.match(STYLE, /\n\.pv \{ display: flex; flex-wrap: nowrap; gap: 4px; align-items: center; \}\n/)
  assert.match(STYLE, /\n\.lng-btn \{ display: flex; align-items: center; gap: 4px; min-width: 24px; min-height: 24px;/)
})

test('the open list: Automatic first, then every language — its flag, its own name in its own lang, the reader\'s name after a hidden comma, one ✓ — and the note and the quality line under it (1.9 A3.3, A4, §7a Q8/Q9)', () => {
  const { FLAG_SVG } = require('../src/flags') as typeof import('../src/flags')
  const h = render('langOpen = true; var __h = sLanguage(); langOpen = false; __h', { language: languageVmOf('en') })
  assert.ok(h.includes('aria-expanded="true"'), h)
  const pop = h.slice(h.indexOf('<div class="lng-pop">'))
  const globe = FLAG_SVG.auto.replace('<svg class="flag"', '<svg class="flag flag-auto"')
  assert.equal(pop, '<div class="lng-pop"><ul id="lng-menu" role="menu" aria-label="Language">'
    + '<li role="menuitemradio" aria-checked="false" tabindex="-1" data-act="lang" data-id="auto">' + globe
    + '<span class="lng-text"><span>Automatic — as VS Code (English)</span></span></li>'
    + '<li role="menuitemradio" aria-checked="true" tabindex="-1" data-act="lang" data-id="en">' + FLAG_SVG.us
    + '<span class="lng-text"><span lang="en">English</span></span><span class="lng-check" aria-hidden="true">✓</span></li>'
    + '<li role="menuitemradio" aria-checked="false" tabindex="-1" data-act="lang" data-id="de">' + FLAG_SVG.de
    + '<span class="lng-text"><span lang="de">Deutsch</span><span class="lng-sep">,</span> <span class="meta">German</span></span></li>'
    + '</ul><p class="meta lng-note">' + LANG_NOTE.replace(/'/g, '&#39;') + '</p><p class="meta lng-note">' + LANG_QUALITY + '</p></div></div>')
  // Every language of the registry, each in its own lang — the Han glyphs of ja, zh-CN and zh-TW are the browser's to pick by it.
  const { resolveLanguage, LANGUAGE_IDS, LANGUAGES } = require('../src/languages') as typeof import('../src/languages')
  const every = buildViewModel({ ...makeInput(), language: { resolved: resolveLanguage('auto', 'en', [...LANGUAGE_IDS]), available: [...LANGUAGE_IDS] } }).language
  const all = render('langOpen = true; var __h = sLanguage(); langOpen = false; __h', { language: JSON.parse(JSON.stringify(every)) })
  assert.equal(all.split('role="menuitemradio"').length - 1, 15)
  assert.equal(all.split('aria-checked="true"').length - 1, 1)
  assert.equal(all.split('lng-check').length - 1, 1)
  for (const e of LANGUAGES) assert.ok(all.includes('data-id="' + e.id + '">' + FLAG_SVG[e.flag] + '<span class="lng-text"><span lang="' + e.locale + '">' + e.native + '</span>'), e.id)
  // The list's rules: never wider than the view, at most min(70vh, 440px) tall and scrolling inside, items
  // of 24 px at least, the menu's own colours with the page's tokens behind them.
  assert.match(STYLE, /\.lng-pop \{[^}]*width: min\(320px, calc\(100vw - 16px\)\); max-height: min\(70vh, 440px\);/)
  assert.match(STYLE, /\.lng-pop \{[^}]*right: 0;[^}]*background: var\(--vscode-menu-background, /)
  assert.match(STYLE, /\.lng-pop \{[^}]*color: var\(--vscode-menu-foreground, var\(--vscode-foreground\)\);/)
  assert.match(STYLE, /\.lng-pop \{[^}]*border: 1px solid var\(--vscode-menu-border, /)
  assert.match(STYLE, /\n\.lng-pop ul \{ list-style: none; margin: 0; padding: 0; overflow-y: auto; min-height: 0; \}\n/)
  assert.match(STYLE, /\n\.lng-pop li \{ display: flex; align-items: center; gap: 8px; min-height: 24px;/)
  assert.match(STYLE, /\.lng-pop li:focus \{ outline: none;\s*background: var\(--vscode-menu-selectionBackground, /)
  // Forced colours (A6): the flags keep their colours and an outline in the text colour — the globe, drawn in
  // currentColor, stays in the adjustment and follows the mode —; the focused item is outlined in the highlight
  // colour; nothing else of the picker is taken out of the adjustment.
  const forced = STYLE.slice(STYLE.indexOf('@media (forced-colors: active) {'))
  const block = forced.slice(0, forced.indexOf('\n}') + 2)
  assert.ok(block.includes('\n  .flag:not(.flag-auto) { forced-color-adjust: none; outline: 1px solid CanvasText; }\n'), block)
  assert.ok(block.includes('\n  .lng-pop li:focus { outline: 2px solid Highlight; outline-offset: -2px; }\n'), block)
  assert.equal(/\.lng[^{]*\{[^}]*forced-color-adjust/.test(block), false)
  // The page's hairline round a flag outside the mode; none round the globe, which is drawn in the text colour.
  assert.match(STYLE, /\n\.flag \{ display: block; flex: none; width: 21px; height: 14px;\s*outline: 1px solid color-mix/)
  assert.match(STYLE, /\n\.flag\.flag-auto \{ outline: none; \}\n/)
  // The comma for a screen reader is text of the line at no size, as the ⚠'s words are (1.7 D-A).
  assert.match(STYLE, /\n\.lng-sep \{ font-size: 0; \}\n/)
})

/** A fake element of the picker: what the script reads of it, and a record of every focus it takes. */
interface PickerEl {
  tagName: string
  dataset: Record<string, string>
  attrs: Record<string, string>
  classList: { contains(c: string): boolean }
  getAttribute(k: string): string | null
  setAttribute(k: string, v: string): void
  focus(): void
  closest(sel: string): unknown
}

/**
 * A page whose provider block is a fake picker: the button, and the list the script inserts — its items
 * made from the markup `languagePop` writes. `focused` is every focus in order (the button, an item's id),
 * `posted` what the page sent the host. The page is drawn from `over` through a real `data` message.
 */
function pickerCtx(over: Record<string, unknown> = {}): {
  c: nodeVm.Context; posted: unknown[]; focused: string[]; active: () => PickerEl | null; btn: PickerEl; items: () => PickerEl[]
  open: () => boolean; fire: (type: string, ev: Record<string, unknown>) => void; key: (key: string, target?: PickerEl | null) => { prevented: boolean }
} {
  const posted: unknown[] = []
  const focused: string[] = []
  const listeners: Record<string, Array<(ev: unknown) => void>> = {}
  let active: PickerEl | null = null
  let items: PickerEl[] = []
  let pop: Record<string, unknown> | null = null
  const on = (scope: string) => (type: string, fn: (ev: unknown) => void, capture?: unknown): void => {
    (listeners[scope + type + (capture === true ? ':capture' : '')] ??= []).push(fn)
  }
  const box: Record<string, unknown> = {}
  const el = (tagName: string, dataset: Record<string, string>, attrs: Record<string, string>, cls: string[], name: string): PickerEl => {
    const e: PickerEl = {
      tagName, dataset, attrs,
      classList: { contains: (c: string) => cls.includes(c) },
      getAttribute: (k: string) => (k in attrs ? attrs[k] : null),
      setAttribute: (k: string, v: string) => { attrs[k] = v },
      focus: () => { active = e; focused.push(name) },
      closest: (sel: string) => (sel === '[data-act]' ? e : sel === '.lng' ? box : sel === '.lng-pop' ? (tagName === 'LI' ? pop : null) : null),
    }
    return e
  }
  const btn = el('BUTTON', { act: 'langOpen' }, { 'aria-expanded': 'false' }, ['lng-btn'], 'button')
  Object.assign(box, {
    querySelector: (sel: string) => (sel === '.lng-btn' ? btn : sel === '.lng-pop' ? pop : null),
    querySelectorAll: (sel: string) => (sel === '[role="menuitemradio"]' ? items : []),
    insertAdjacentHTML: (where: string, html: string) => {
      assert.equal(where, 'beforeend')
      pop = { html, parentNode: { removeChild: () => { if (items.includes(active as PickerEl)) active = null; pop = null; items = [] } } }
      items = [...html.matchAll(/<li role="menuitemradio" aria-checked="(true|false)" tabindex="-1" data-act="lang" data-id="([^"]*)">/g)]
        .map((m) => el('LI', { act: 'lang', id: m[2] }, { role: 'menuitemradio', 'aria-checked': m[1], tabindex: '-1' }, [], m[2]))
    },
  })
  const root = { innerHTML: '', dataset: {}, style: {} }
  const c = nodeVm.createContext({
    acquireVsCodeApi: () => ({ postMessage: (m: unknown) => { posted.push(JSON.parse(JSON.stringify(m))) } }),
    document: {
      addEventListener: on('document:'),
      getElementById: () => root,
      querySelector: (sel: string) => (sel === '[data-sec="provider"] .lng' ? box : sel === '[data-sec="provider"] .lng-btn' ? btn : null),
      querySelectorAll: () => [],
      get activeElement() { return active },
      documentElement: { lang: 'en' },
    },
    window: { addEventListener: on('window:'), setInterval: () => 1 },
    console,
  })
  nodeVm.runInContext(SCRIPT, c)
  const fire = (type: string, ev: Record<string, unknown>): void => {
    for (const fn of [...(listeners[type + ':capture'] ?? []), ...(listeners[type] ?? [])]) fn(ev)
  }
  fire('window:message', { origin: '', data: { type: 'data', payload: model({ sections: ['quota'], provider: 'all', language: languageVmOf('en'), ...over }) } })
  posted.length = 0
  const key = (k: string, target: PickerEl | null = active): { prevented: boolean } => {
    const r = { prevented: false }
    fire('document:keydown', { key: k, target, altKey: false, ctrlKey: false, metaKey: false, shiftKey: false,
      preventDefault: () => { r.prevented = true }, stopPropagation: () => undefined })
    return r
  }
  return { c, posted, focused, active: () => active, btn, items: () => items, open: () => pop !== null, fire, key }
}

test('the picker\'s keys: the button opens the list on the checked item; ↓ ↑ wrap, Home and End; Escape and Tab close it without a choice; Enter on the checked item only closes (1.9 A6, A7 test 3)', () => {
  const p = pickerCtx()
  const ids = (): string[] => p.items().map((i) => i.dataset.id)
  // Enter on the button is its click: the list opens, the focus on the checked item (English).
  p.fire('document:click', { target: p.btn, stopPropagation: () => undefined, preventDefault: () => undefined })
  assert.equal(p.open(), true)
  assert.equal(p.btn.attrs['aria-expanded'], 'true')
  assert.deepEqual(ids(), ['auto', 'en', 'de'])
  assert.equal(p.active()?.dataset.id, 'en')
  assert.equal(nodeVm.runInContext('langOpen', p.c), true)
  // Moving chooses nothing, and every key it handles is kept from scrolling the page.
  const moves: Array<[string, string]> = [['ArrowDown', 'de'], ['ArrowDown', 'auto'], ['ArrowUp', 'de'], ['Home', 'auto'], ['End', 'de'], ['ArrowUp', 'en']]
  for (const [k, want] of moves) {
    assert.equal(p.key(k).prevented, true, k)
    assert.equal(p.active()?.dataset.id, want, k)
  }
  assert.deepEqual(p.posted, [])
  // Enter on the checked item posts nothing and closes, the focus back on the button.
  p.key('Enter')
  assert.equal(p.open(), false)
  assert.equal(p.btn.attrs['aria-expanded'], 'false')
  assert.equal(p.active(), p.btn)
  assert.deepEqual(p.posted, [])
  // ↓ on the button opens it too; Escape closes it, nothing posted, the focus on the button.
  assert.equal(p.key('ArrowDown', p.btn).prevented, true)
  assert.equal(p.open(), true)
  assert.equal(p.active()?.dataset.id, 'en')
  p.key('ArrowDown')
  assert.equal(p.key('Escape').prevented, true)
  assert.equal(p.open(), false)
  assert.equal(p.active(), p.btn)
  assert.deepEqual(p.posted, [])
  // ↑ opens it as well; Tab closes it without a choice and is not prevented: the focus moves on from the button.
  p.key('ArrowUp', p.btn)
  assert.equal(p.open(), true)
  p.key('ArrowDown')
  const tab = p.key('Tab')
  assert.equal(tab.prevented, false)
  assert.equal(p.open(), false)
  assert.equal(p.active(), p.btn)
  assert.deepEqual(p.posted, [])
  // A click on the button while the list is open closes it.
  p.fire('document:click', { target: p.btn, stopPropagation: () => undefined, preventDefault: () => undefined })
  assert.equal(p.open(), true)
  p.fire('document:click', { target: p.btn, stopPropagation: () => undefined, preventDefault: () => undefined })
  assert.equal(p.open(), false)
  // A pointer pressed outside the picker closes it; one inside it does not.
  p.key('ArrowDown', p.btn)
  p.fire('document:pointerdown', { target: p.items()[0] })
  assert.equal(p.open(), true)
  p.fire('document:pointerdown', { target: { closest: () => null } })
  assert.equal(p.open(), false)
  assert.deepEqual(p.posted, [])
  // A key the list does not know, a key with a modifier, a key on something else: nothing.
  p.key('ArrowDown', p.btn)
  const at = p.active()
  assert.equal(p.key('a').prevented, false)
  assert.equal(p.active(), at)
  // The pure rule, for the record: moving wraps, Home/End, Enter and Space choose, Escape and Tab close.
  assert.deepEqual(JSON.parse(String(nodeVm.runInContext('JSON.stringify([langKeyMove(3, 2, "ArrowDown"), langKeyMove(3, 0, "ArrowUp"), langKeyMove(3, 1, "Home"), langKeyMove(3, 1, "End"), langKeyMove(3, 1, " "), langKeyMove(3, 1, "Enter"), langKeyMove(3, 1, "Escape"), langKeyMove(3, 1, "Tab"), langKeyMove(3, 1, "x"), langKeyMove(0, 0, "ArrowDown")])', p.c))),
    [{ focus: 0 }, { focus: 2 }, { focus: 0 }, { focus: 2 }, { choose: true }, { choose: true }, { close: 'button' }, { close: 'tab' }, null, null])
})

test('a choice posts setLanguage once and closes the list; the whole push that answers brings the words, closes nothing more and puts the focus back on the button (1.9 A3.4, A7 tests 3–4)', () => {
  const p = pickerCtx()
  // Enter on German: one message, the host's parser takes it as it is.
  p.key('ArrowDown', p.btn)
  p.key('ArrowDown')
  assert.equal(p.active()?.dataset.id, 'de')
  p.key('Enter')
  assert.deepEqual(p.posted, [{ type: 'setLanguage', id: 'de' }])
  assert.deepEqual(parseWebviewMessage(p.posted[0]), p.posted[0])
  assert.equal(p.open(), false)
  assert.equal(p.active(), p.btn)
  // A click on Automatic: the same, once.
  p.posted.length = 0
  p.fire('document:click', { target: p.btn, stopPropagation: () => undefined, preventDefault: () => undefined })
  p.fire('document:click', { target: p.items()[0], stopPropagation: () => undefined, preventDefault: () => undefined })
  assert.deepEqual(p.posted, [{ type: 'setLanguage', id: 'auto' }])
  // The host's answer: a whole push with the words — the dictionary replaced, the page's lang and LOCALE moved,
  // the list closed, the focus on the button again.
  p.posted.length = 0
  p.fire('document:click', { target: p.btn, stopPropagation: () => undefined, preventDefault: () => undefined })
  assert.equal(nodeVm.runInContext('langOpen', p.c), true)
  const focusBefore = p.focused.length
  p.fire('window:message', { origin: '', data: { type: 'data', payload: model({ sections: ['quota'], language: languageVmOf('de') }),
    words: { lang: 'de', locale: 'de', dict: { Refresh: 'Aktualisieren', Range: 'Zeitraum', broken: 7 } } } })
  assert.equal(nodeVm.runInContext('langOpen', p.c), false)
  assert.deepEqual(p.focused.slice(focusBefore), ['button'])
  assert.deepEqual(JSON.parse(JSON.stringify(nodeVm.runInContext('L10N', p.c))), { Refresh: 'Aktualisieren', Range: 'Zeitraum' })
  assert.equal(nodeVm.runInContext('LOCALE', p.c), 'de')
  assert.equal(nodeVm.runInContext('document.documentElement.lang', p.c), 'de')
  assert.ok(String(nodeVm.runInContext('controls()', p.c)).includes('aria-label="Aktualisieren"'))
  // A push without words (every other one) changes nothing of them, and takes no focus.
  const again = p.focused.length
  p.fire('window:message', { origin: '', data: { type: 'data', payload: model({ sections: ['quota'], language: languageVmOf('de') }) } })
  assert.equal(nodeVm.runInContext('L10N.Refresh', p.c), 'Aktualisieren')
  assert.equal(p.focused.length, again)
  // The reader who moved on before the answer keeps the focus where they put it.
  p.posted.length = 0
  p.key('ArrowDown', p.btn)
  assert.equal(p.active()?.dataset.id, 'de')
  p.key('Home')
  p.key('Enter')
  assert.deepEqual(p.posted, [{ type: 'setLanguage', id: 'auto' }])
  p.fire('document:focusin', { target: { classList: { contains: () => false } } })
  const moved = p.focused.length
  p.fire('window:message', { origin: '', data: { type: 'data', payload: model({ sections: ['quota'], language: languageVmOf('auto') }),
    words: { lang: 'en', locale: 'en-US', dict: {} } } })
  assert.equal(p.focused.length, moved)
})

test('the page takes words only in their shape: a tag for lang and locale, a plain object of strings for the dictionary (1.9 A3.4, A7 test 4)', () => {
  const c = makeContext()
  nodeVm.runInContext(SCRIPT, c)
  const state = (): unknown => JSON.parse(String(nodeVm.runInContext('JSON.stringify({ l: L10N, loc: LOCALE })', c)))
  const before = state() as { l: Record<string, string>; loc: string }
  assert.equal(before.loc, 'en-US')
  const apply = (w: unknown): boolean => {
    ;(c as Record<string, unknown>).words = w
    return nodeVm.runInContext('applyWords(words)', c) as boolean
  }
  for (const bad of [null, 'de', [1], { lang: 'x y', locale: 'de', dict: {} }, { lang: 'de', locale: 'de"><', dict: {} },
    { lang: 'de', locale: 'de', dict: 'Refresh' }, { lang: 'de', locale: 'de', dict: ['Aktualisieren'] }, { lang: 'de', locale: 'de', dict: null },
    { lang: 'de', dict: {} }, { lang: 7, locale: 'de', dict: {} }]) {
    assert.equal(apply(bad), false, JSON.stringify(bad))
    assert.deepEqual(state(), before, JSON.stringify(bad))
  }
  // A valid one replaces the whole dictionary — a key the new one lacks goes, a value that is no string is dropped.
  assert.equal(apply({ lang: 'pt-BR', locale: 'pt-BR', dict: { Refresh: 'Atualizar', Range: 3, __proto__x: 'y' } }), true)
  assert.deepEqual(state(), { l: { Refresh: 'Atualizar', __proto__x: 'y' }, loc: 'pt-BR' })
  assert.equal(nodeVm.runInContext("tr('Range')", c), 'Range')
  assert.equal(nodeVm.runInContext("tr('Refresh')", c), 'Atualizar')
  // A key named like the prototype cannot reach it.
  ;(c as Record<string, unknown>).words = JSON.parse('{"lang":"de","locale":"de","dict":{"__proto__":"x","Refresh":"Aktualisieren"}}')
  assert.equal(nodeVm.runInContext('applyWords(words)', c), true)
  assert.equal(nodeVm.runInContext("Object.getPrototypeOf(L10N) === Object.prototype && tr('Refresh')", c), 'Aktualisieren')
})

test('a Korean page keeps its words whole at a line\'s end, and no other language is touched (1.9 P19, the space rule of Korean)', () => {
  // Chrome ends a line between any two Hangul syllables unless told otherwise ("적습" | "니다" on the ko page at 260 px).
  assert.match(STYLE, /\n:lang\(ko\) \{ word-break: keep-all; \}\n\[lang\]:not\(:lang\(ko\)\) \{ word-break: normal; \}\n/)
  // The only word-break rules of the page: every other language keeps the initial value, Japanese and Chinese included.
  assert.deepEqual([...STYLE.matchAll(/word-break:\s*([a-z-]+)/g)].map((m) => m[1]), ['keep-all', 'normal'])
  // A long token still breaks rather than widening the page (body: overflow-wrap: anywhere).
  assert.match(STYLE, /body \{[^}]*overflow-wrap: anywhere;/)
})

test('the page takes a canonical locale with a Unicode extension — de-de-u-nu-thai — and draws its figures in it (1.9 P19, §7c decision a)', () => {
  const c = makeContext()
  nodeVm.runInContext(SCRIPT, c)
  const apply = (w: unknown): boolean => {
    ;(c as Record<string, unknown>).words = w
    return nodeVm.runInContext('applyWords(words)', c) as boolean
  }
  // The host's locale() is a canonical locale and keeps the extension VS Code reported (`de-DE-u-nu-thai`); the tag rule
  // alone refused it, and the page kept the words it had.
  for (const locale of ['de-de-u-nu-thai', 'de-DE-u-nu-thai', 'en-US-u-hc-h12', 'ja-JP-u-ca-japanese', 'zh-TW']) {
    assert.equal(apply({ lang: 'de', locale, dict: { Refresh: 'Aktualisieren' } }), true, locale)
    assert.equal(nodeVm.runInContext('LOCALE', c), locale)
  }
  apply({ lang: 'de', locale: 'de-DE-u-nu-thai', dict: {} })
  // The figures follow it: Thai digits, the German decimal comma.
  assert.equal(nodeVm.runInContext('(12.5).toLocaleString(LOCALE)', c), (12.5).toLocaleString('de-DE-u-nu-thai'))
  assert.match(String(nodeVm.runInContext('(12.5).toLocaleString(LOCALE)', c)), /^[๐-๙]+,[๐-๙]$/)
  // Still refused: a bare singleton, an extension without a key, an extension in the middle of garbage, markup, a tag
  // Intl does not take, an overlong one.
  const before = nodeVm.runInContext('LOCALE', c)
  for (const locale of ['de-u', 'de-de-u-', 'de-u-nu-thai x', 'de"><img src=x>', 'u-nu-thai', 'de-de-u-nu-thai-', 'de-' + 'a'.repeat(9), 'de-' + 'ab-'.repeat(30) + 'ab']) {
    assert.equal(apply({ lang: 'de', locale, dict: {} }), false, locale)
    assert.equal(nodeVm.runInContext('LOCALE', c), before, locale)
  }
  // lang follows the same rule; the page's lang is the registry's tag in practice.
  assert.equal(apply({ lang: 'x y', locale: 'de', dict: {} }), false)
  assert.equal(apply({ lang: 'pt-BR', locale: 'pt-BR-u-nu-latn', dict: {} }), true)
})

/**
 * 1.9 P19 (§7c decision b): a page whose document the test can read — every element the render writes that carries a
 * `data-act` or an `id` is an object here, rebuilt from the markup on each write, so an element of the old page is gone
 * after a whole render as it is in a browser; `focus()` moves `document.activeElement`.
 */
interface FocusEl { tagName: string; id: string; dataset: Record<string, string>; classList: { contains: (c: string) => boolean }; focus: () => void; closest: () => null; getAttribute: (k: string) => string | null }
function wordsFocusCtx(): { c: nodeVm.Context; fire: (data: unknown) => void; focus: (pick: (e: FocusEl) => boolean) => FocusEl; active: () => FocusEl | 'body' | null; els: () => FocusEl[]; focused: () => number } {
  let els: FocusEl[] = []
  let active: FocusEl | 'body' | null = 'body'
  let focusCalls = 0
  const body = { tagName: 'BODY' }
  const listeners: Array<(ev: unknown) => void> = []
  const parse = (html: string): FocusEl[] => {
    const out: FocusEl[] = []
    for (const m of html.matchAll(/<([a-z]+)\b([^>]*)>/g)) {
      const attrs: Record<string, string> = {}
      for (const a of m[2].matchAll(/([\w-]+)="([^"]*)"/g)) attrs[a[1]] = a[2]
      if (!('data-act' in attrs) && !('id' in attrs)) continue
      const dataset: Record<string, string> = {}
      for (const [k, v] of Object.entries(attrs)) if (k.startsWith('data-')) dataset[k.slice(5).replace(/-([a-z])/g, (_x, ch: string) => ch.toUpperCase())] = v
      const cls = (attrs.class ?? '').split(/\s+/)
      const e: FocusEl = {
        tagName: m[1].toUpperCase(), id: attrs.id ?? '', dataset,
        classList: { contains: (x: string) => cls.includes(x) },
        focus: () => { active = e; focusCalls++ },
        closest: () => null,
        getAttribute: (k: string) => (k in attrs ? attrs[k] : null),
      }
      out.push(e)
    }
    return out
  }
  const root = {
    set innerHTML(h: string) { els = parse(h); if (active !== 'body' && active !== null && !els.includes(active)) active = 'body' },
    get innerHTML(): string { return '' },
    dataset: {}, style: {},
    contains: (el: unknown) => els.includes(el as FocusEl),
    querySelectorAll: (sel: string) => (sel === '[data-act]' ? els.filter((e) => 'act' in e.dataset) : []),
  }
  const c = nodeVm.createContext({
    acquireVsCodeApi: () => ({ postMessage: () => undefined }),
    document: {
      addEventListener: () => undefined,
      getElementById: (id: string) => (id === 'root' ? root : els.find((e) => e.id === id) ?? null),
      querySelector: (sel: string) => (sel === '[data-sec="provider"] .lng-btn' ? els.find((e) => e.classList.contains('lng-btn')) ?? null : null),
      querySelectorAll: () => [],
      get activeElement() { return active === 'body' ? body : active },
      body,
      documentElement: { lang: 'en' },
    },
    window: { addEventListener: (type: string, fn: (ev: unknown) => void) => { if (type === 'message') listeners.push(fn) }, setInterval: () => 1 },
    console,
  })
  nodeVm.runInContext(SCRIPT, c)
  const fire = (data: unknown): void => { for (const fn of listeners) fn({ origin: '', data }) }
  return {
    c, fire,
    focus: (pick) => { const e = els.find(pick); assert.ok(e, 'no such element on the page'); e.focus(); return e },
    active: () => active,
    els: () => els,
    focused: () => focusCalls,
  }
}

test('after a language switch the focus is back where it was — the element with the same id, the same section\'s summary or control — else on the picker\'s button, never on <body> (1.9 P19, §7c decision b)', () => {
  const p = wordsFocusCtx()
  const page = (setting: 'en' | 'de') => model({ sections: ['quota', 'history', 'heatmap'], provider: 'all', language: languageVmOf(setting) })
  const words = (lang: string) => ({ lang, locale: lang, dict: {} })
  p.fire({ type: 'data', payload: page('en') })
  // Nothing on the page had the focus: the switch takes it nowhere.
  assert.equal(p.active(), 'body')
  p.fire({ type: 'data', payload: page('de'), words: words('de') })
  assert.equal(p.active(), 'body')
  assert.equal(p.focused(), 0)
  // On a section's summary: the new page's summary of the same section.
  const was = p.focus((e) => e.dataset.act === 'section' && e.dataset.key === 'history')
  p.fire({ type: 'data', payload: page('en'), words: words('en') })
  const now = p.active()
  assert.ok(now && now !== 'body' && now !== was, 'the focus stayed on the old element or fell to <body>')
  assert.equal((now as FocusEl).dataset.act, 'section')
  assert.equal((now as FocusEl).dataset.key, 'history')
  // On a control that names what it does — a provider button —: the same control of the new page.
  p.focus((e) => e.dataset.act === 'providerView' && e.dataset.src === 'codex')
  p.fire({ type: 'data', payload: page('de'), words: words('de') })
  assert.equal((p.active() as FocusEl).dataset.act, 'providerView')
  assert.equal((p.active() as FocusEl).dataset.src, 'codex')
  // On the picker's button itself (a switch made in the settings UI): the button again.
  p.focus((e) => e.classList.contains('lng-btn'))
  p.fire({ type: 'data', payload: page('en'), words: words('en') })
  assert.ok((p.active() as FocusEl).classList.contains('lng-btn'))
  // On an element with an id — the custom range's first date field, open (page-local state a switch keeps) —: that id again.
  nodeVm.runInContext('showDates = true', p.c)
  p.fire({ type: 'data', payload: page('de') })
  const from = p.focus((e) => e.id === 'tp-from')
  p.fire({ type: 'data', payload: page('en'), words: words('en') })
  assert.equal((p.active() as FocusEl).id, 'tp-from')
  assert.notEqual(p.active(), from, 'the focus stayed on the old element')
  // On a control the new page cannot find again (a chip that names nothing): the picker's button — not <body>.
  p.focus((e) => e.dataset.act === 'range' && e.dataset.preset === '7d')
  p.fire({ type: 'data', payload: page('en'), words: words('en') })
  assert.ok(p.active() !== 'body' && (p.active() as FocusEl).classList.contains('lng-btn'), JSON.stringify(p.active()))
  // A whole push without words (the view shown again) moves nothing: that is not a switch.
  p.focus((e) => e.dataset.act === 'section' && e.dataset.key === 'heatmap')
  const calls = p.focused()
  p.fire({ type: 'data', payload: page('en') })
  assert.equal(p.focused(), calls)
  assert.equal(p.active(), 'body')
})

test('a provider fragment redraws the picker and keeps it open, the focus on the item it was on (1.9 §3.0 a)', () => {
  const focused: string[] = []
  const inside = new Set<unknown>()
  let drawn: Array<Record<string, unknown>> = []
  const item = (id: string, name: string): Record<string, unknown> => ({ dataset: { act: 'lang', id }, focus: () => { focused.push(name) } })
  const body = {
    innerHTML: '', dataset: {}, style: {},
    contains: (el: unknown) => inside.has(el),
    querySelectorAll: (sel: string) => (sel === '[data-act]' ? drawn : []),
  }
  const doc: Record<string, unknown> = {
    addEventListener: () => undefined, getElementById: () => null, querySelectorAll: () => [], activeElement: null,
    querySelector: (s: string) => (s === '[data-body="provider"]' ? body : null),
  }
  const c = nodeVm.createContext({ acquireVsCodeApi: () => ({ postMessage: () => undefined }), document: doc, window: { addEventListener: () => undefined }, console })
  nodeVm.runInContext(SCRIPT, c)
  ;(c as Record<string, unknown>).fixture = model({ provider: 'codex', language: languageVmOf('en') })
  nodeVm.runInContext('vm = fixture; langOpen = true;', c)
  const was = item('de', 'de-old')
  inside.add(was)
  doc.activeElement = was
  drawn = [{ dataset: { act: 'langOpen' }, focus: () => { focused.push('button-new') } }, item('auto', 'auto-new'), item('en', 'en-new'), item('de', 'de-new')]
  nodeVm.runInContext('renderSection("provider");', c)
  assert.deepEqual(focused, ['de-new'])
  assert.ok(body.innerHTML.includes('<div class="lng-pop">'), 'the list closed with the fragment')
  assert.ok(body.innerHTML.includes('aria-expanded="true"'))
  // The button keeps the focus the same way.
  focused.length = 0
  const onButton = { dataset: { act: 'langOpen' }, focus: () => undefined }
  inside.clear()
  inside.add(onButton)
  doc.activeElement = onButton
  nodeVm.runInContext('langOpen = false; renderSection("provider");', c)
  assert.deepEqual(focused, ['button-new'])
})

/** 1.9 A3.4: a provider on a view whose visibility a test can change, and every `html` it was given. */
function wordsRig(): { p: any; view: any; posted: any[]; htmlSets: () => number; setVisible: (v: boolean) => void } {
  const { DashboardProvider } = loadDashboard()
  const posted: any[] = []
  const vis: Array<() => void> = []
  let htmlSets = 0
  let visible = true
  const view = {
    get visible() { return visible },
    webview: {
      options: {},
      set html(_v: string) { htmlSets++ },
      get html(): string { return '' },
      onDidReceiveMessage: () => ({ dispose: () => undefined }),
      postMessage: (m: unknown) => { if (visible) posted.push(m); return Promise.resolve(visible) },
    },
    onDidChangeVisibility: (fn: () => void) => { vis.push(fn); return { dispose: () => undefined } },
    onDidDispose: () => ({ dispose: () => undefined }),
    show: () => undefined,
  }
  const p = new DashboardProvider(() => undefined)
  return { p, view, posted, htmlSets: () => htmlSets, setVisible: (v: boolean) => { visible = v; for (const fn of vis) fn() } }
}

test('after a switch the next whole push carries the words — German\'s dictionary, escaped, its lang and locale — once, a hidden view gets them when it shows, and the document is never reloaded (1.9 A3.4, A7 test 4)', () => {
  const { pagePayload } = loadDashboard()
  const bundle = JSON.parse(readFileSync(join(__dirname, '..', 'l10n', 'bundle.l10n.de.json'), 'utf8')) as Record<string, string>
  const r = wordsRig()
  try {
    const en = buildViewModel(makeInput())
    r.p.update(en)
    r.p.resolveWebviewView(r.view)
    assert.deepEqual(r.posted.map((m) => [m.type, 'words' in m]), [['data', false]])
    // The switch, as extension.ts applies it: the bundle, the locale, the words' tag — then the dashboard is told.
    setBundle(bundle)
    setLocale('de')
    setLang('de')
    r.p.languageChanged()
    const de = buildViewModel(makeInput())
    r.posted.length = 0
    r.p.update(de)
    assert.equal(r.posted.length, 1)
    const m = r.posted[0]
    assert.equal(m.type, 'data')
    assert.deepEqual(m.payload, JSON.parse(JSON.stringify(pagePayload(de))))
    assert.equal(m.words.lang, 'de')
    assert.equal(m.words.locale, 'de')
    assert.equal(m.words.dict.Refresh, 'Aktualisieren')
    assert.equal(m.words.dict.All, 'Alle')
    // Exactly the dictionary a new page would be written with.
    const germanScript = between(page(), /<script nonce="[A-Za-z0-9]+">/, '</script>')
    const dc = makeContext()
    nodeVm.runInContext(germanScript, dc)
    assert.deepEqual(m.words.dict, JSON.parse(JSON.stringify(nodeVm.runInContext('L10N', dc))))
    // The same view model again: nothing; a change: a fragment — never the words.
    r.posted.length = 0
    r.p.update(de)
    assert.equal(r.posted.length, 0, JSON.stringify(r.posted))
    r.p.update({ ...de, generatedAt: 'later' })
    assert.deepEqual(r.posted.map((x) => [x.type, 'words' in x]), [['section', false]])
    // A whole push for another reason — the view shown again — carries none either.
    r.posted.length = 0
    r.setVisible(false)
    r.setVisible(true)
    assert.deepEqual(r.posted.map((x) => [x.type, 'words' in x]), [['data', false]])
    // Back to English while the view is hidden: nothing is posted; the flush that shows it again brings the words.
    r.setVisible(false)
    setBundle(undefined)
    setLocale(undefined)
    setLang(undefined)
    r.p.languageChanged()
    r.posted.length = 0
    r.p.update(en)
    assert.equal(r.posted.length, 0, JSON.stringify(r.posted))
    r.setVisible(true)
    assert.deepEqual(r.posted.map((x) => [x.type, x.words && x.words.lang, x.words && x.words.locale]), [['data', 'en', 'en-US']])
    assert.equal(r.posted[0].words.dict.Refresh, 'Refresh')
    // The markup rule holds on the push path too: a bundle's page word with markup arrives escaped.
    setBundle({ Refresh: '<img src=x>', All: 'a "b" & c' })
    setLang('fr')
    r.p.languageChanged()
    r.posted.length = 0
    r.p.update(en)
    assert.equal(r.posted[0].words.dict.Refresh, '&lt;img src=x&gt;')
    assert.equal(r.posted[0].words.dict.All, 'a &quot;b&quot; &amp; c')
    // A switch that keeps the words' language but moves the formats reaches the page too.
    setBundle(undefined)
    setLang(undefined)
    r.p.languageChanged()
    r.p.update(en)
    setLocale('hu')
    r.p.languageChanged()
    r.posted.length = 0
    r.p.update(en)
    assert.deepEqual(r.posted.map((x) => [x.type, x.words && x.words.lang, x.words && x.words.locale]), [['data', 'en', 'hu']])
    // Through all of it the document was written once: no switch reloads it.
    assert.equal(r.htmlSets(), 1)
  } finally {
    setBundle(undefined)
    setLocale(undefined)
    setLang(undefined)
  }
})

// ---------------------------------------------------------------------------
// 1.10 A2, A5: the Prompts section on the page
// ---------------------------------------------------------------------------

/**
 * 1.10 P5: for every `setTimeout(` in src/webview/main.ts, the top-level function it stands in — the page's
 * timeouts are the Prompts section's own (the single click's delay, a draw after the focus moved or the
 * pointer came up, the page's sentence in the flash line).
 */
function timeoutsBy(): string[] {
  const out: string[] = []
  let fn = '(top level)'
  for (const line of SOURCE.split('\n')) {
    const m = /^(?:async )?function (\w+)/.exec(line)
    if (m) fn = m[1]
    else if (/^\S/.test(line) && !/^[}\])]/.test(line)) fn = '(top level)'
    for (const _ of line.matchAll(/setTimeout\(/g)) out.push(fn)
  }
  return out
}

/** The three shipped entries, one user entry and the keep-warm entry edited to its /loop variant (§3 A7's world). */
function promptsVm(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    items: [
      { id: 's-status', title: 'Status table', text: 'Show the current progress in a clear table. Columns: step/status | description | model | duration | expected to finish.', shipped: true, edited: false, command: false },
      { id: 's-keepwarm', title: 'Keep the cache warm', text: '/loop 30m Ignore this message. No action. No response.', shipped: true, edited: true, command: true },
      { id: 's-stop', title: 'Stop after this task', text: 'Stop after the current task and do not start any new work.', shipped: true, edited: false, command: false },
      { id: 'u-3k9x0a2b', title: 'Review', text: 'Review the last diff for correctness.', shipped: false, edited: false, command: false },
    ],
    intro: 'Double-click a prompt, or press its send button, to type it into the terminal that runs Claude Code or Codex and press Enter. Click a prompt to edit it. Text typed in that terminal and not sent yet goes with it.',
    target: { text: 'Sends to Claude Code in terminal 2 of 3 — ready', level: 'ready' },
    flash: null,
    canAdd: true,
    restorable: 0,
    readOnly: null,
    limits: { title: 80, text: 2000, max: 50 },
    ...over,
  }
}

/** A node of the fake document below: an element, or a text. */
type FNode = FEl | { text: string; parentNode: FEl | null }
const HTML_ENTITY: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'", nbsp: ' ' }
const unEntity = (s: string): string => s.replace(/&(amp|lt|gt|quot|#39|nbsp);/g, (_m, e: string) => HTML_ENTITY[e])
const VOID_TAGS = new Set(['br', 'img', 'input', 'hr', 'wbr', 'meta', 'link'])

/**
 * 1.10 P5: an element of a small document the page's script can work on — parsed from the markup the page writes,
 * with the attributes, the dataset, the text, a field's value and selection, the focus, and the selectors the
 * script asks for (tag, #id, .class, [attr], [attr="v"], :scope, the descendant and the child combinator). What a
 * browser lays out is not here: every box is empty. The harness holds the layout.
 */
class FEl {
  tagName: string
  attrs: Record<string, string>
  nodes: FNode[] = []
  parentNode: FEl | null = null
  value = ''
  selectionStart = 0
  selectionEnd = 0
  hidden = false
  style: Record<string, string> & { setProperty?: (k: string, v: string) => void } = { setProperty: () => undefined } as never
  html = ''
  doc: FakeDoc
  constructor(doc: FakeDoc, tag: string, attrs: Record<string, string> = {}) {
    this.doc = doc
    this.tagName = tag.toUpperCase()
    this.attrs = attrs
    // Out of sight of util.inspect: a failed assert.equal between two elements inspects both at depth 1000 and diffs
    // the two texts — through the document, the tree and the page's listeners that diff ran to gigabytes outside the
    // heap cap (2026-09-26, the OOM kill of 04:57). An element inspects as its tag, attributes and field state.
    for (const k of ['doc', 'nodes', 'parentNode', 'html', 'style']) {
      Object.defineProperty(this, k, { enumerable: false, writable: true, configurable: true, value: (this as Record<string, unknown>)[k] })
    }
  }
  get children(): FEl[] { return this.nodes.filter((n): n is FEl => n instanceof FEl) }
  get firstElementChild(): FEl | null { return this.children[0] ?? null }
  get parentElement(): FEl | null { return this.parentNode }
  get nextElementSibling(): FEl | null {
    const sib = this.parentNode ? this.parentNode.children : []
    return sib[sib.indexOf(this) + 1] ?? null
  }
  get id(): string { return this.attrs.id ?? '' }
  get dataset(): Record<string, string> {
    const d: Record<string, string> = {}
    for (const [k, v] of Object.entries(this.attrs)) {
      if (k.startsWith('data-')) d[k.slice(5).replace(/-([a-z])/g, (_x, ch: string) => ch.toUpperCase())] = v
    }
    return d
  }
  get classList(): { contains: (c: string) => boolean; add: (c: string) => void; remove: (c: string) => void } {
    const list = (): string[] => (this.attrs.class ?? '').split(/\s+/).filter(Boolean)
    return {
      contains: (c: string) => list().includes(c),
      add: (c: string) => { if (!list().includes(c)) this.attrs.class = [...list(), c].join(' ') },
      remove: (c: string) => { this.attrs.class = list().filter((x) => x !== c).join(' ') },
    }
  }
  getAttribute(k: string): string | null { return k in this.attrs ? this.attrs[k] : null }
  setAttribute(k: string, v: string): void { this.attrs[k] = String(v) }
  hasAttribute(k: string): boolean { return k in this.attrs }
  removeAttribute(k: string): void { delete this.attrs[k] }
  get textContent(): string {
    return this.nodes.map((n) => (n instanceof FEl ? n.textContent : n.text)).join('')
  }
  set textContent(v: string) {
    this.detachAll()
    this.nodes = v === '' ? [] : [{ text: String(v), parentNode: this }]
  }
  get innerHTML(): string { return this.html }
  set innerHTML(h: string) {
    this.detachAll()
    this.html = h
    if (++this.doc.writes > PROMPT_PAGE_MAX_WRITES) throw new Error('innerHTML: more than ' + PROMPT_PAGE_MAX_WRITES + ' writes')
    this.nodes = parseFake(this.doc, h, this)
    if (this.doc.active !== null && !this.doc.connected(this.doc.active)) this.doc.active = null
  }
  private detachAll(): void {
    for (const n of this.nodes) n.parentNode = null
  }
  contains(el: unknown): boolean {
    let depth = 0
    for (let x = el as FEl | null; x; x = x.parentNode) {
      if (++depth > PROMPT_PAGE_MAX_DEPTH) throw new Error('contains: a parent chain deeper than ' + PROMPT_PAGE_MAX_DEPTH)
      if (x === this) return true
    }
    return false
  }
  replaceChild(next: FEl, old: FEl): FEl {
    const i = this.nodes.indexOf(old)
    if (i < 0) throw new Error('replaceChild: not a child')
    if (next.parentNode) next.parentNode.nodes = next.parentNode.nodes.filter((n) => n !== next)
    this.nodes[i] = next
    next.parentNode = this
    old.parentNode = null
    return old
  }
  insertAdjacentHTML(): void { throw new Error('insertAdjacentHTML is not part of the fake document') }
  getBoundingClientRect(): Record<string, number> { return { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 } }
  get scrollWidth(): number { return 0 }
  get clientWidth(): number { return 0 }
  setSelectionRange(a: number, b: number): void { this.selectionStart = a; this.selectionEnd = b }
  focus(): void { this.doc.focus(this) }
  scrollIntoView(): void { /* nothing to scroll */ }
  matches(sel: string, scope: FEl | null = null): boolean { return selectorMatches(this, sel, scope) }
  closest(sel: string): FEl | null {
    let depth = 0
    for (let x: FEl | null = this; x; x = x.parentNode) {
      if (++depth > PROMPT_PAGE_MAX_DEPTH) throw new Error('closest: a parent chain deeper than ' + PROMPT_PAGE_MAX_DEPTH)
      if (x.matches(sel)) return x
    }
    return null
  }
  all(): FEl[] {
    const out: FEl[] = []
    const walk = (e: FEl): void => { for (const k of e.children) { out.push(k); walk(k) } }
    walk(this)
    return out
  }
  querySelectorAll(sel: string): FEl[] { return this.all().filter((e) => e.matches(sel, this)) }
  querySelector(sel: string): FEl | null { return this.querySelectorAll(sel)[0] ?? null }
}

/** The markup the page writes, as elements and texts; `<x/>` closes itself (the send button's glyph). */
function parseFake(doc: FakeDoc, html: string, parent: FEl): FNode[] {
  const top: FEl[] = [parent]
  const out: FNode[] = []
  const add = (n: FNode): void => {
    const p = top[top.length - 1]
    n.parentNode = p
    if (p === parent) out.push(n); else p.nodes.push(n)
  }
  const re = /<(\/?)([a-zA-Z][a-zA-Z0-9]*)((?:\s+[a-zA-Z_:][-a-zA-Z0-9_:.]*(?:="[^"]*")?)*)\s*(\/?)>|([^<]+)/g
  for (const m of html.matchAll(re)) {
    if (m[5] !== undefined) { add({ text: unEntity(m[5]), parentNode: null }); continue }
    const tag = m[2].toLowerCase()
    if (m[1] === '/') {
      const at = top[top.length - 1]
      assert.equal(at.tagName.toLowerCase(), tag, 'unbalanced </' + tag + '> in ' + html.slice(0, 200))
      top.pop()
      continue
    }
    const attrs: Record<string, string> = {}
    for (const a of m[3].matchAll(/\s([a-zA-Z_:][-a-zA-Z0-9_:.]*)(?:="([^"]*)")?/g)) attrs[a[1]] = unEntity(a[2] ?? '')
    const el = new FEl(doc, tag, attrs)
    add(el)
    if (!VOID_TAGS.has(tag) && m[4] !== '/') top.push(el)
  }
  assert.equal(top.length, 1, 'unclosed ' + top.map((e) => e.tagName).join(' > '))
  return out
}

/** One compound selector (`li.pr[data-id="x"]`) against one element. */
function compoundMatches(el: FEl, sel: string, scope: FEl | null): boolean {
  const re = /^([a-zA-Z*][a-zA-Z0-9]*)|#([-\w]+)|\.([-\w]+)|\[([-\w]+)(?:="([^"]*)"|='([^']*)')?\]|:scope/g
  let rest = sel
  for (const m of sel.matchAll(re)) {
    rest = rest.replace(m[0], '')
    if (m[1] !== undefined && m[1] !== '*' && el.tagName.toLowerCase() !== m[1].toLowerCase()) return false
    if (m[2] !== undefined && el.id !== m[2]) return false
    if (m[3] !== undefined && !el.classList.contains(m[3])) return false
    if (m[4] !== undefined) {
      if (!el.hasAttribute(m[4])) return false
      const want = m[5] ?? m[6]
      if (want !== undefined && el.getAttribute(m[4]) !== want) return false
    }
    if (m[0] === ':scope' && el !== scope) return false
  }
  // A pseudo-class the fake does not know matches nothing.
  return rest.trim() === ''
}

/** A selector list (`a, b`) with the descendant and the child combinator. */
function selectorMatches(el: FEl, sel: string, scope: FEl | null): boolean {
  return sel.split(/\s*,\s*(?![^[]*\])/).some((one) => {
    const parts = one.trim().replace(/\s*>\s*/g, ' > ').split(/\s+(?![^[]*\])/)
    const matchAt = (e: FEl | null, i: number): boolean => {
      if (!e || !compoundMatches(e, parts[i], scope)) return false
      if (i === 0) return true
      if (parts[i - 1] === '>') return matchAt(e.parentNode, i - 2)
      let depth = 0
      for (let up = e.parentNode; up; up = up.parentNode) {
        if (++depth > PROMPT_PAGE_MAX_DEPTH) throw new Error('selector: a parent chain deeper than ' + PROMPT_PAGE_MAX_DEPTH)
        if (matchAt(up, i - 1)) return true
      }
      return false
    }
    return matchAt(el, parts.length - 1)
  })
}

/** The document the Prompts tests hand the page: a body, the root, the focus, the listeners, a clock and its timers. */
class FakeDoc {
  body: FEl
  root: FEl
  active: FEl | null = null
  writes = 0
  listeners: Record<string, Array<(ev: unknown) => void>> = {}
  constructor() {
    this.body = new FEl(this, 'body')
    this.root = new FEl(this, 'div', { id: 'root' })
    this.root.parentNode = this.body
    this.body.nodes = [this.root]
  }
  /** Events fired and focus moves over the page's life — bounded (PROMPT_PAGE_MAX_EVENTS). */
  events = 0
  connected(el: FEl): boolean {
    let depth = 0
    for (let x: FEl | null = el; x; x = x.parentNode) {
      if (++depth > PROMPT_PAGE_MAX_DEPTH) throw new Error('connected: a parent chain deeper than ' + PROMPT_PAGE_MAX_DEPTH)
      if (x === this.body) return true
    }
    return false
  }
  /** A focus change as the browser makes it: focusout on the element that had it (still in the document), then the new one. */
  focus(el: FEl): void {
    const from = this.active
    if (from === el) return
    if (++this.events > PROMPT_PAGE_MAX_EVENTS) throw new Error('focus: more than ' + PROMPT_PAGE_MAX_EVENTS + ' events and focus moves')
    if (from && this.connected(from)) this.fire('focusout', { target: from, relatedTarget: el })
    this.active = el
  }
  fire(type: string, ev: Record<string, unknown>): { prevented: boolean } {
    if (++this.events > PROMPT_PAGE_MAX_EVENTS) throw new Error('fire(' + type + '): more than ' + PROMPT_PAGE_MAX_EVENTS + ' events and focus moves')
    const r = { prevented: false }
    const full = { key: '', repeat: false, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, isComposing: false, keyCode: 0,
      detail: 0, relatedTarget: null, ...ev, type, preventDefault: () => { r.prevented = true }, stopPropagation: () => undefined }
    for (const fn of [...(this.listeners['document:' + type + ':capture'] ?? []), ...(this.listeners['document:' + type] ?? [])]) fn(full)
    return r
  }
}

/** The bounds of the fake page's timers (every loop of a test helper has one): timers run by one `advance`, … */
const PROMPT_PAGE_MAX_STEPS = 200
/** … timers run one after another at one clock time (a timer re-arming itself at 0 ms), … */
const PROMPT_PAGE_MAX_SAME_TIME = 20
/** … and timers pending at once. */
const PROMPT_PAGE_MAX_TIMERS = 32
/** The fake document's own bounds: events fired and focus moves over one page's life, writes of a body, a parent chain. */
const PROMPT_PAGE_MAX_EVENTS = 2000
const PROMPT_PAGE_MAX_WRITES = 1000
const PROMPT_PAGE_MAX_DEPTH = 100

interface PromptPage {
  c: nodeVm.Context
  doc: FakeDoc
  posted: Array<Record<string, unknown>>
  clock: { t: number }
  /** Runs every timer due by `ms` from now, in order. */
  advance: (ms: number) => void
  /** Every timer still set. */
  timers: () => number
  push: (prompts: Record<string, unknown>) => void
  whole: (over?: Record<string, unknown>) => void
  body: () => FEl
  q: (sel: string) => FEl | null
  entry: (id: string) => FEl
  send: (id: string) => FEl
  field: (role: 'prTitle' | 'prText') => FEl | null
  click: (el: FEl, detail?: number) => void
  dblclick: (el: FEl) => void
  key: (el: FEl, key: string, mods?: Record<string, unknown>) => { prevented: boolean }
  /** A key on a button as the browser gives it: the keydown, and — Enter and Space, not prevented — the button's own click. */
  press: (el: FEl, key: string, mods?: Record<string, unknown>) => void
  type: (el: FEl, text: string) => void
  leave: (to: FEl | null) => void
  tab: (back?: boolean) => FEl
  sends: () => string[]
  saves: () => Array<Record<string, unknown>>
}

/**
 * 1.10 P5: a page drawn through the page's own `data` message into the fake document, with `prompts` (the view
 * model's Prompts part) listed alone or where `sections` puts it; `post` records what the page sends the host,
 * `setTimeout` runs on `clock` (the page's Date.now as well).
 */
function promptPage(prompts: Record<string, unknown> = promptsVm(), o: { sections?: string[]; mac?: boolean; script?: string; over?: Record<string, unknown> } = {}): PromptPage {
  const doc = new FakeDoc()
  const posted: Array<Record<string, unknown>> = []
  const clock = { t: AG_NOW }
  let seq = 0
  const timers: Array<{ id: number; at: number; fn: () => void }> = []
  const on = (scope: string) => (type: string, fn: (ev: unknown) => void, capture?: unknown): void => {
    (doc.listeners[scope + type + (capture === true ? ':capture' : '')] ??= []).push(fn)
  }
  const c = nodeVm.createContext({
    acquireVsCodeApi: () => ({ postMessage: (m: unknown) => { posted.push(JSON.parse(JSON.stringify(m))) } }),
    document: {
      addEventListener: on('document:'),
      getElementById: (id: string) => (id === 'root' ? doc.root : doc.body.all().find((e) => e.id === id) ?? null),
      querySelector: (sel: string) => doc.body.querySelector(sel),
      querySelectorAll: (sel: string) => doc.body.querySelectorAll(sel),
      get activeElement() { return doc.active ?? doc.body },
      get body() { return doc.body },
      documentElement: { lang: 'en' },
    },
    window: {
      addEventListener: on('window:'),
      setInterval: () => 1,
      setTimeout: (fn: () => void, ms: number) => {
        if (timers.length >= PROMPT_PAGE_MAX_TIMERS) throw new Error('setTimeout: more than ' + PROMPT_PAGE_MAX_TIMERS + ' timers pending')
        const id = ++seq
        timers.push({ id, at: clock.t + (ms || 0), fn })
        return id
      },
      clearTimeout: (id: number) => { const i = timers.findIndex((x) => x.id === id); if (i >= 0) timers.splice(i, 1) },
      innerWidth: 420,
      origin: 'vscode-webview://x',
    },
    navigator: o.mac ? { userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) Code/1.139.1' } : undefined,
    console,
  })
  nodeVm.runInContext(o.script ?? SCRIPT, c)
  nodeVm.runInContext('Date.now = function () { return clock.t; };', Object.assign(c, { clock }))
  const sections = o.sections ?? ['prompts']
  let vmNow: Record<string, unknown> = model({ sections, prompts, ...(o.over ?? {}) })
  const fire = (type: string, ev: Record<string, unknown>): void => {
    for (const fn of [...(doc.listeners[type + ':capture'] ?? []), ...(doc.listeners[type] ?? [])]) fn(ev)
  }
  fire('window:message', { origin: '', data: { type: 'data', payload: vmNow } })
  const p: PromptPage = {
    c, doc, posted, clock,
    advance: (ms: number) => {
      // Bounded (the 2026-09-26 04:57 lesson: an unbounded loop here took the machine): at most
      // PROMPT_PAGE_MAX_STEPS timers per call, and at most PROMPT_PAGE_MAX_SAME_TIME in a row at one clock time — a
      // timer that re-arms itself at or before the current time (a setTimeout(fn, 0) inside fn) throws instead of
      // spinning.
      const until = clock.t + ms
      let steps = 0
      let sameTime = 0
      let lastAt = Number.NaN
      for (;;) {
        timers.sort((a, b) => a.at - b.at || a.id - b.id)
        const next = timers[0]
        if (!next || next.at > until) break
        if (++steps > PROMPT_PAGE_MAX_STEPS) throw new Error('advance: more than ' + PROMPT_PAGE_MAX_STEPS + ' timers in one call')
        const at = Math.max(clock.t, next.at)
        sameTime = at === lastAt ? sameTime + 1 : 1
        lastAt = at
        if (sameTime > PROMPT_PAGE_MAX_SAME_TIME) throw new Error('advance: a timer re-armed itself at ' + at + ' more than ' + PROMPT_PAGE_MAX_SAME_TIME + ' times')
        timers.shift()
        clock.t = at
        next.fn()
      }
      clock.t = until
    },
    timers: () => timers.length,
    push: (next: Record<string, unknown>) => {
      vmNow = { ...vmNow, prompts: next }
      fire('window:message', { origin: '', data: { type: 'section', key: 'prompts', payload: { prompts: next } } })
    },
    whole: (over: Record<string, unknown> = {}) => {
      vmNow = { ...vmNow, ...over }
      fire('window:message', { origin: '', data: { type: 'data', payload: vmNow } })
    },
    body: () => doc.root.querySelector('[data-body="prompts"]') as FEl,
    q: (sel: string) => doc.root.querySelector(sel),
    entry: (id: string) => doc.root.querySelector('[data-act="promptEdit"][data-id="' + id + '"]') as FEl,
    send: (id: string) => doc.root.querySelector('[data-act="promptSend"][data-id="' + id + '"]') as FEl,
    field: (role) => doc.root.querySelector('[data-role="' + role + '"]'),
    click: (el: FEl, detail = 1) => {
      doc.fire('pointerdown', { target: el })
      if (el.tagName === 'BUTTON' || el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') el.focus()
      doc.fire('pointerup', { target: el })
      doc.fire('click', { target: el, detail })
    },
    dblclick: (el: FEl) => { doc.fire('dblclick', { target: el, detail: 2 }) },
    key: (el: FEl, key: string, mods: Record<string, unknown> = {}) => doc.fire('keydown', { target: el, key, ...mods }),
    press: (el: FEl, key: string, mods: Record<string, unknown> = {}) => {
      // A key goes to the focused element: the element is focused first (no event when it has the focus already).
      if (el.tagName === 'BUTTON' || el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') el.focus()
      const r = doc.fire('keydown', { target: el, key, ...mods })
      if (!r.prevented && el.tagName === 'BUTTON' && (key === 'Enter' || key === ' ')) doc.fire('click', { target: el, detail: 0 })
    },
    type: (el: FEl, text: string) => {
      el.value = text
      el.selectionStart = el.selectionEnd = text.length
      doc.fire('input', { target: el })
    },
    leave: (to: FEl | null) => {
      const from = doc.active
      if (from && doc.connected(from)) doc.fire('focusout', { target: from, relatedTarget: to })
      doc.active = to
    },
    tab: (back = false) => {
      const stops = doc.root.all().filter((e) => ['BUTTON', 'INPUT', 'TEXTAREA', 'SUMMARY'].includes(e.tagName) || e.getAttribute('tabindex') === '0')
      const at = doc.active ? stops.indexOf(doc.active) : -1
      const to = stops[back ? (at <= 0 ? stops.length - 1 : at - 1) : (at + 1) % stops.length]
      to.focus()
      return to
    },
    sends: () => posted.filter((m) => m.type === 'promptSend').map((m) => String(m.id)),
    saves: () => posted.filter((m) => m.type === 'promptSave'),
  }
  posted.length = 0
  return p
}

test('the Prompts section is a section of the page: its renderer, its heading, free of the range and the models, never Claude-only (1.10 §3 A7 test 1, §3.0 a)', () => {
  const r = JSON.parse(String(nodeVm.runInContext(
    'JSON.stringify({ fn: renderer("prompts") === sPrompts, map: RENDER.get("prompts") === sPrompts, title: titleOf("prompts"), free: RANGE_FREE.indexOf("prompts") >= 0, claude: CLAUDE_ONLY_SECTIONS.indexOf("prompts") >= 0 })', ctx)))
  assert.deepEqual(r, { fn: true, map: true, title: 'Prompts', free: true, claude: false })
  // The filter bar stays below it, as below the quota cards: listed first, the bar comes after it.
  const order = orderOf(renderPage({ sections: ['prompts', 'quota', 'history'], prompts: promptsVm() }))
  assert.deepEqual(order, ['provider', 'notices', 'prompts', 'quota', 'controls', 'history', 'drill', 'footer'])
  // Without its part of the view model (the section not listed) it draws nothing, and throws nothing.
  assert.equal(render('sPrompts()', { prompts: null }), '')
  assert.equal(render('sPrompts()', { prompts: undefined }), '')
})

test('the section\'s markup: the intro, the target line, the flash line, a list named Prompts of two buttons per entry, the footer and the help span (1.10 §3 A2 rules 1, 2)', () => {
  const h = render('sPrompts()', { prompts: promptsVm() })
  assert.ok(h.startsWith('<p class="meta pr-intro">Double-click a prompt, or press its send button, to type it into the terminal that runs Claude Code or Codex and press Enter. Click a prompt to edit it. Text typed in that terminal and not sent yet goes with it.</p>'
    + '<p class="meta pr-target pr-ready">Sends to Claude Code in terminal 2 of 3 — ready</p>'
    + '<p class="meta pr-flash" role="status" aria-live="polite"></p>'
    + '<ul class="pr-list" aria-label="Prompts"><li class="pr" data-id="s-status">'), h)
  assert.ok(h.includes('<button class="pr-main" data-act="promptEdit" data-id="s-status" aria-labelledby="pr-n-s-status" aria-describedby="pr-t-s-status pr-help"'
    + ' title="Show the current progress in a clear table. Columns: step/status | description | model | duration | expected to finish.">'
    + '<span class="pr-title" id="pr-n-s-status">Status table</span>'
    + '<span class="pr-text meta" id="pr-t-s-status">Show the current progress in a clear table. Columns: step/status | description | model | duration | expected to finish.</span></button>'
    + '<button class="pr-send" data-act="promptSend" data-id="s-status" aria-label="Send “Status table”" title="Sends to Claude Code in terminal 2 of 3 — ready">'
    + '<svg viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path d="M4 2l10 6-10 6z" fill="currentColor"/></svg></button></li>'), h)
  // A slash command in the editor's font.
  assert.ok(h.includes('<span class="pr-text meta pr-cmd" id="pr-t-s-keepwarm">/loop 30m Ignore this message. No action. No response.</span>'), h)
  // Two tab stops per entry, no roving (§7a Q27): no tabindex anywhere in the list, no aria-activedescendant.
  const list = h.slice(h.indexOf('<ul'), h.indexOf('</ul>'))
  assert.equal(/tabindex|aria-activedescendant/.test(list), false, list)
  assert.equal((list.match(/<button /g) ?? []).length, 8)
  // The footer and the help span; no restore button while nothing is missing.
  assert.ok(h.endsWith('</ul><div class="wrap pr-foot"><button data-act="promptNew">New prompt</button></div>'
    + '<span class="sr" id="pr-help">Enter edits it, Ctrl+Enter sends it.</span>'), h)
  // A missing shipped entry: the restore button, the palette's command.
  const missing = render('sPrompts()', { prompts: promptsVm({ restorable: 1 }) })
  assert.ok(missing.includes('<button data-act="cmd" data-id="tokenPace.restoreDefaultPrompts">Restore default prompts</button>'), missing)
  assert.deepEqual(parseWebviewMessage({ type: 'command', id: 'tokenPace.restoreDefaultPrompts' }), { type: 'command', id: 'tokenPace.restoreDefaultPrompts' })
  // A full list: New prompt does nothing and says why.
  const full = render('sPrompts()', { prompts: promptsVm({ canAdd: false }) })
  assert.ok(full.includes('<button data-act="promptNew" aria-disabled="true" title="At most 50 prompts.">New prompt</button>'), full)
  // The level is a class and nothing else: the words say it.
  for (const level of ['ready', 'asks', 'no']) {
    const x = render('sPrompts()', { prompts: promptsVm({ target: { text: 'the words', level } }) })
    assert.ok(x.includes('<p class="meta pr-target pr-' + level + '">the words</p>'), x)
  }
  assert.ok(render('sPrompts()', { prompts: promptsVm({ target: { text: 'w', level: 'x" onmouseover="y' } }) }).includes('pr-target pr-no">'))
  // The flash, and the read-only box.
  const f = render('sPrompts()', { prompts: promptsVm({ flash: { text: 'Sent to Claude Code in terminal 2 of 3.', ok: true }, readOnly: 'prompts.json could not be read (json).' }) })
  assert.ok(f.includes('<div class="box pr-ro">prompts.json could not be read (json).</div><p class="meta pr-flash" role="status" aria-live="polite">Sent to Claude Code in terminal 2 of 3.</p>'), f)
})

test('a Mac\'s page names ⌘+Enter, every other page Ctrl+Enter (1.10 §3 A2 rule 1)', () => {
  const mac = promptPage(promptsVm(), { mac: true })
  assert.equal(mac.q('#pr-help')?.textContent, 'Enter edits it, ⌘+Enter sends it.')
  const other = promptPage()
  assert.equal(other.q('#pr-help')?.textContent, 'Enter edits it, Ctrl+Enter sends it.')
})

test('a title or a text with markup is text: in the title, the text, both names, the tooltip, the fields\' group and the delete question — and a field\'s value is never markup (1.10 §3 A2 rule 2)', () => {
  const MARK = '<img src=x onerror=alert(1)>'
  const vm = promptsVm({ items: [{ id: 'u-3k9x0a2b', title: MARK + '"\'&', text: MARK + ' text', shipped: false, edited: false, command: false }] })
  const h = render('sPrompts()', { prompts: vm })
  assert.equal(h.indexOf('<img'), -1, h)
  assert.ok(h.includes('<span class="pr-title" id="pr-n-u-3k9x0a2b">&lt;img src=x onerror=alert(1)&gt;&quot;&#39;&amp;</span>'), h)
  assert.ok(h.includes('aria-label="Send “&lt;img src=x onerror=alert(1)&gt;&quot;&#39;&amp;”"'), h)
  assert.ok(h.includes('title="&lt;img src=x onerror=alert(1)&gt; text"'), h)
  // Opened, and asked: the group's name and the question carry it as text; the values are set as properties.
  const p = promptPage(vm)
  p.press(p.entry('u-3k9x0a2b'), 'Enter')
  const group = p.q('.pr-edit') as FEl
  assert.equal(group.getAttribute('aria-label'), 'Edit “' + MARK + '"\'&”')
  assert.equal(p.field('prTitle')?.value, MARK + '"\'&')
  assert.equal(p.field('prText')?.value, MARK + ' text')
  assert.equal(/value=/.test(p.body().innerHTML), false, 'a value was written into the markup')
  assert.equal(p.body().innerHTML.indexOf('<img'), -1)
  p.press(p.q('[data-act="promptDelete"]') as FEl, 'Enter')
  const ask = p.q('.pr-ask') as FEl
  assert.equal(ask.getAttribute('aria-label'), 'Delete “' + MARK + '"\'&”?')
  assert.equal(ask.querySelector('span')?.textContent, 'Delete “' + MARK + '"\'&”?')
  assert.equal(p.body().innerHTML.indexOf('<img'), -1)
})

test('a single click opens the entry\'s fields after 300 ms, the focus in the text with the caret at its end; nothing is posted (1.10 §3 A2 rules 3, 5)', () => {
  const p = promptPage()
  p.click(p.entry('s-stop'))
  assert.equal(p.q('.pr-edit'), null, 'the fields opened on the first click')
  p.advance(299)
  assert.equal(p.q('.pr-edit'), null)
  p.advance(1)
  const text = p.field('prText') as FEl
  assert.ok(text, 'no fields after 300 ms')
  assert.equal(p.doc.active, text)
  assert.equal(text.value, 'Stop after the current task and do not start any new work.')
  assert.deepEqual([text.selectionStart, text.selectionEnd], [text.value.length, text.value.length])
  assert.equal(p.field('prTitle')?.value, 'Stop after this task')
  // The fields' markup (rule 5): a named group, two labelled fields with their limits, the counter, the error line, the bar.
  const edit = p.q('li.pr.editing[data-id="s-stop"] > .pr-edit') as FEl
  assert.deepEqual([edit.getAttribute('role'), edit.getAttribute('aria-label'), edit.getAttribute('tabindex')], ['group', 'Edit “Stop after this task”', '-1'])
  assert.equal(edit.querySelectorAll('label').length, 2)
  assert.equal(edit.querySelector('label > input[data-role="prTitle"]')?.getAttribute('maxlength'), '80')
  assert.equal(edit.querySelector('label > textarea[data-role="prText"]')?.getAttribute('maxlength'), '2000')
  assert.equal(edit.querySelector('.pr-count')?.textContent, '58 / 2000 characters')
  assert.equal(edit.querySelector('.pr-err')?.getAttribute('role'), 'alert')
  assert.deepEqual(edit.querySelectorAll('.pr-bar > button').map((b) => [b.dataset.act, b.textContent, b.getAttribute('aria-disabled')]),
    [['promptSave', 'Save', null], ['promptCancel', 'Cancel', null], ['promptUp', 'Move up', null], ['promptDown', 'Move down', null], ['promptDelete', 'Delete', null]])
  assert.deepEqual(p.posted, [])
  // The counter follows the text as it is typed.
  p.type(text, 'abc')
  assert.equal(edit.querySelector('.pr-count')?.textContent, '3 / 2000 characters')
})

test('a double-click sends once and never leaves the fields open — two clicks 150 ms apart, the dblclick after them, a third click (1.10 §3 A2 rule 3; §7a Q25)', () => {
  const p = promptPage()
  p.click(p.entry('s-status'), 1)
  p.advance(150)
  p.click(p.entry('s-status'), 2)
  p.dblclick(p.entry('s-status'))
  p.click(p.entry('s-status'), 3)
  p.advance(1000)
  assert.deepEqual(p.sends(), ['s-status'])
  assert.equal(p.q('.pr-edit'), null, 'the fields opened after a double-click')
  assert.equal(p.saves().length, 0)
  assert.equal(p.timers(), 0)
  // The send names the entry and nothing else: the host types what it reads for that id.
  assert.deepEqual(p.posted.filter((m) => m.type === 'promptSend'), [{ type: 'promptSend', id: 's-status' }])
  assert.deepEqual(parseWebviewMessage(p.posted[0]), { type: 'promptSend', id: 's-status' })
  // The next double-click is a new one: it sends again.
  p.advance(2000)
  p.click(p.entry('s-status'), 1)
  p.click(p.entry('s-status'), 2)
  assert.deepEqual(p.sends(), ['s-status', 's-status'])
})

test('a slow double-click: its second press held while the 300 ms pass opens nothing; its click sends (1.10 §3 A2 rule 3)', () => {
  const p = promptPage()
  const main = p.entry('s-status')
  p.click(main, 1)
  p.advance(250)
  // The second press is down when the timer runs out: the element under it stays.
  p.doc.fire('pointerdown', { target: main })
  p.advance(100)
  assert.equal(p.q('.pr-edit'), null)
  assert.equal(p.entry('s-status'), main, 'the entry was drawn again under the pressed pointer')
  p.doc.fire('pointerup', { target: main })
  p.doc.fire('click', { target: main, detail: 2 })
  p.advance(10)
  assert.deepEqual(p.sends(), ['s-status'])
  assert.equal(p.q('.pr-edit'), null)
  // A single click whose press outlasts the 300 ms opens the fields once it comes up.
  p.advance(2000)
  p.click(p.entry('s-stop'), 1)
  p.doc.fire('pointerdown', { target: p.entry('s-stop') })
  p.advance(400)
  assert.equal(p.q('.pr-edit'), null)
  p.doc.fire('pointerup', { target: p.entry('s-stop') })
  p.advance(0)
  assert.ok(p.q('li[data-id="s-stop"] .pr-edit'))
  assert.deepEqual(p.sends(), ['s-status'])
})

test('the grace rule: a dblclick 50 ms after the first click opened the fields closes them unsaved and sends once; 900 ms after, or changed, it is the browser\'s (1.10 §3 A2 rule 3)', () => {
  const p = promptPage()
  p.click(p.entry('s-status'), 1)
  p.advance(300)
  const title = p.field('prTitle') as FEl
  assert.ok(title)
  // The second press lands on the fields (a double-click time longer than 300 ms): its click does nothing …
  p.advance(50)
  p.click(title, 2)
  assert.deepEqual(p.posted, [])
  // … its dblclick sends, and the fields close without a save, the focus on the entry.
  p.dblclick(title)
  assert.equal(p.q('.pr-edit'), null)
  assert.deepEqual(p.sends(), ['s-status'])
  assert.equal(p.saves().length, 0)
  assert.equal(p.doc.active, p.entry('s-status'))
  // 900 ms after opening: the browser's (it selects a word) — nothing posted, the fields stay.
  p.advance(2000)
  p.posted.length = 0
  p.click(p.entry('s-stop'), 1)
  p.advance(300)
  p.advance(900)
  p.dblclick(p.field('prText') as FEl)
  assert.deepEqual(p.posted, [])
  assert.ok(p.q('.pr-edit'))
  // Changed within the grace: the browser's too.
  p.press(p.field('prText') as FEl, 'Escape')
  p.advance(2000)
  p.click(p.entry('s-stop'), 1)
  p.advance(300)
  p.type(p.field('prText') as FEl, 'Stop now.')
  p.advance(100)
  p.dblclick(p.field('prText') as FEl)
  assert.deepEqual(p.posted, [])
  assert.equal(p.field('prText')?.value, 'Stop now.')
  // Fields opened by the keyboard have no grace: a dblclick in them is the browser's.
  p.press(p.field('prText') as FEl, 'Escape')
  p.press(p.entry('s-stop'), 'Enter')
  p.dblclick(p.field('prText') as FEl)
  assert.deepEqual(p.posted, [])
  assert.ok(p.q('.pr-edit'))
})

test('the keys on an entry: Enter and Space open the fields at once, Ctrl+Enter and ⌘+Enter send; Enter on the send button sends; a key held down does nothing more (1.10 §3 A2 rule 4)', () => {
  for (const k of ['Enter', ' ']) {
    const p = promptPage()
    const r = p.key(p.entry('s-stop'), k)
    assert.equal(r.prevented, true, k)
    assert.equal(p.doc.active, p.field('prText'), k)
    assert.equal(p.timers(), 0, k)
    assert.deepEqual(p.posted, [], k)
  }
  for (const mods of [{ ctrlKey: true }, { metaKey: true }]) {
    const p = promptPage()
    p.press(p.entry('s-stop'), 'Enter', mods)
    assert.deepEqual(p.sends(), ['s-stop'], JSON.stringify(mods))
    assert.equal(p.q('.pr-edit'), null)
  }
  const p = promptPage()
  p.press(p.send('u-3k9x0a2b'), 'Enter')
  assert.deepEqual(p.sends(), ['u-3k9x0a2b'])
  // Held down: the repeats post nothing, open nothing — on the entry and on the send button.
  p.posted.length = 0
  for (const [el, mods] of [[p.entry('s-stop'), { ctrlKey: true }], [p.entry('s-stop'), {}], [p.send('s-stop'), {}]] as Array<[FEl, Record<string, unknown>]>) {
    p.press(el, 'Enter', { repeat: true, ...mods })
    p.press(el, ' ', { repeat: true, ...mods })
  }
  assert.deepEqual(p.posted, [])
  assert.equal(p.q('.pr-edit'), null)
  // A click without a pointer (a screen reader's) opens at once: no second click can follow it.
  p.click(p.entry('s-status'), 0)
  assert.ok(p.q('li[data-id="s-status"] .pr-edit'))
  assert.equal(p.timers(), 0)
  // The send button's own double-click sends once.
  const q = promptPage()
  q.click(q.send('s-stop'), 1)
  q.click(q.send('s-stop'), 2)
  assert.deepEqual(q.sends(), ['s-stop'])
})

test('Escape leaves the fields as they were: closed, nothing posted, the focus on the entry (1.10 §3 A2 rule 5)', () => {
  const p = promptPage()
  p.press(p.entry('s-status'), 'Enter')
  p.type(p.field('prText') as FEl, 'changed')
  const r = p.key(p.field('prText') as FEl, 'Escape')
  assert.equal(r.prevented, true)
  assert.equal(p.q('.pr-edit'), null)
  assert.deepEqual(p.posted, [])
  assert.equal(p.doc.active, p.entry('s-status'))
  // Opened again, the entry's own words.
  p.press(p.entry('s-status'), 'Enter')
  assert.equal(p.field('prText')?.value, 'Show the current progress in a clear table. Columns: step/status | description | model | duration | expected to finish.')
})

test('Enter saves once with the cleaned words; the fields close when a push shows them, and stay open with the flash when the host refused (1.10 §3 A2 rule 5)', () => {
  const p = promptPage()
  p.press(p.entry('u-3k9x0a2b'), 'Enter')
  p.type(p.field('prTitle') as FEl, '  Review\tagain ')
  p.type(p.field('prText') as FEl, 'Line one\r\nline two\u0007')
  // Shift+Enter too — a prompt is one line; an input method's Enter is its own; a held key saves once.
  assert.equal(p.key(p.field('prText') as FEl, 'Enter', { isComposing: true }).prevented, false)
  assert.equal(p.saves().length, 0)
  assert.equal(p.key(p.field('prText') as FEl, 'Enter', { shiftKey: true }).prevented, true)
  p.key(p.field('prText') as FEl, 'Enter', { repeat: true })
  p.key(p.field('prTitle') as FEl, 'Enter')
  assert.deepEqual(p.saves(), [{ type: 'promptSave', id: 'u-3k9x0a2b', title: 'Review again', text: 'Line one line two' }])
  assert.deepEqual(parseWebviewMessage(p.saves()[0]), p.saves()[0])
  // Waiting for the push: still open.
  assert.ok(p.q('.pr-edit'))
  // A push that is not the answer (the target line moved) keeps them open, the values as typed.
  p.push(promptsVm({ target: { text: 'No terminal of this window runs Claude Code or Codex.', level: 'no' } }))
  assert.equal(p.field('prText')?.value, 'Line one\r\nline two\u0007')
  // The answer: the entry with the saved words — closed, the focus on the entry.
  const saved = promptsVm()
  ;(saved.items as Array<Record<string, unknown>>)[3] = { id: 'u-3k9x0a2b', title: 'Review again', text: 'Line one line two', shipped: false, edited: false, command: false }
  p.push(saved)
  assert.equal(p.q('.pr-edit'), null)
  assert.equal(p.doc.active, p.entry('u-3k9x0a2b'))
  // Refused by the host: the flash says why; the fields stay open for the reader.
  p.posted.length = 0
  p.press(p.entry('u-3k9x0a2b'), 'Enter')
  p.type(p.field('prText') as FEl, 'Something else')
  p.press(p.q('[data-act="promptSave"]') as FEl, 'Enter')
  assert.equal(p.saves().length, 1)
  p.push({ ...saved, flash: { text: 'Not saved: prompts.json could not be written (EACCES)', ok: false } })
  assert.ok(p.q('.pr-edit'))
  assert.equal(p.q('.pr-flash')?.textContent, 'Not saved: prompts.json could not be written (EACCES)')
  assert.equal(p.field('prText')?.value, 'Something else')
  // Saving again posts again.
  p.key(p.field('prText') as FEl, 'Enter')
  assert.equal(p.saves().length, 2)
})

test('a save the host refuses again for the same reason is posted again by every Enter, Save or leaving the fields, and the fields stay open; while a save is on its way with no flash yet, the same words are not posted twice (1.10 §3 A2 rule 5, Review 2 F2)', () => {
  const p = promptPage()
  const field = (): FEl => p.field('prText') as FEl
  const save = { type: 'promptSave', id: 'u-3k9x0a2b', title: 'Review', text: 'Something else' }
  p.press(p.entry('u-3k9x0a2b'), 'Enter')
  p.type(field(), 'Something else')
  p.key(field(), 'Enter')
  assert.equal(p.saves().length, 1)
  // On its way, no flash yet: Enter again, the Save button and leaving the fields post nothing more ("Posted
  // already, and nothing changed since").
  p.key(field(), 'Enter')
  p.press(p.q('[data-act="promptSave"]') as FEl, 'Enter')
  field().focus()
  p.leave(p.entry('s-stop'))
  assert.equal(p.saves().length, 1)
  assert.ok(p.q('.pr-edit'), 'the fields closed while the save was on its way')
  // Refused (notWritten, EACCES): the host pushes the flash once. Refused again for the same reason, its fragment is
  // the one it pushed already, and the host pushes nothing (dashboard.ts flush) — so no push answers the next saves.
  const flash = { text: 'Not saved: prompts.json could not be written (EACCES)', ok: false }
  p.push(promptsVm({ flash }))
  assert.equal(p.q('.pr-flash')?.textContent, flash.text)
  field().focus()
  for (let n = 2; n <= 4; n++) {
    p.key(field(), 'Enter')
    assert.equal(p.saves().length, n, `Enter ${n}`)
    assert.ok(p.q('.pr-edit'), `the fields closed after Enter ${n}`)
  }
  // The Save button and leaving the fields post them again as well.
  p.press(p.q('[data-act="promptSave"]') as FEl, 'Enter')
  assert.equal(p.saves().length, 5)
  field().focus()
  p.leave(p.entry('s-stop'))
  assert.equal(p.saves().length, 6)
  assert.ok(p.q('.pr-edit'), 'the fields closed on leaving')
  // The flash ends (the host's push after PROMPT_FLASH_MS carries none): a save posted now waits for its answer
  // again — a second Enter posts nothing —, and a push that leaves the fields open ends the wait, whatever it
  // carries (here only the target line moved).
  p.push(promptsVm())
  assert.ok(p.q('.pr-edit'), 'the fields closed when the flash ended')
  field().focus()
  p.key(field(), 'Enter')
  p.key(field(), 'Enter')
  assert.equal(p.saves().length, 7)
  p.push(promptsVm({ target: { text: 'No terminal of this window runs Claude Code or Codex.', level: 'no' } }))
  field().focus()
  p.key(field(), 'Enter')
  assert.equal(p.saves().length, 8)
  // Every post the same save, the words as typed.
  assert.deepEqual(p.saves().filter((m) => JSON.stringify(m) !== JSON.stringify(save)), [])
  assert.equal(field().value, 'Something else')
  // The answer that saves them still closes the fields — the words are kept while the wait is over —, the focus on
  // the entry.
  const saved = promptsVm()
  ;(saved.items as Array<Record<string, unknown>>)[3] = { id: 'u-3k9x0a2b', title: 'Review', text: 'Something else', shipped: false, edited: false, command: false }
  field().focus()
  p.push(saved)
  assert.ok(p.q('.pr-edit') === null, 'the saved words did not close the fields')
  assert.ok(p.doc.active === p.entry('u-3k9x0a2b'), 'the focus is not on the entry')
})

test('leaving the fields: to a control of their own saves nothing; outside, changed, one save; unchanged, they close; the page\'s check failing keeps them open with its reason (1.10 §3 A2 rule 5)', () => {
  const p = promptPage()
  p.press(p.entry('s-status'), 'Enter')
  p.type(p.field('prText') as FEl, 'Show the table.')
  // To Delete, inside the group: nothing.
  p.leave(p.q('[data-act="promptDelete"]'))
  assert.deepEqual(p.posted, [])
  assert.ok(p.q('.pr-edit'))
  // Outside, changed: one save, and leaving once more while it is on its way saves nothing more.
  p.field('prText')?.focus()
  p.leave(p.entry('s-stop'))
  assert.deepEqual(p.saves(), [{ type: 'promptSave', id: 's-status', title: 'Status table', text: 'Show the table.' }])
  p.field('prText')?.focus()
  p.leave(null)
  assert.equal(p.saves().length, 1)
  // Unchanged: the fields just close — once the focus has moved (drawn after it, on the control it went to).
  const q = promptPage()
  q.press(q.entry('s-stop'), 'Enter')
  q.type(q.field('prText') as FEl, 'Stop after the current task and do not start any new work.  ')
  // (The entry whose fields are open has no send button of its own meanwhile: the focus goes to the one above.)
  assert.equal(q.send('s-stop'), null)
  q.leave(q.send('s-keepwarm'))
  assert.deepEqual(q.posted, [])
  q.advance(0)
  assert.equal(q.q('.pr-edit'), null)
  assert.equal(q.doc.active, q.send('s-keepwarm'), 'the focus did not stay where it went')
  // Invalid: an empty title — nothing posted, the fields open, the reason in the error line.
  const r = promptPage()
  r.press(r.entry('s-stop'), 'Enter')
  r.type(r.field('prTitle') as FEl, '   ')
  r.leave(null)
  assert.deepEqual(r.posted, [])
  assert.ok(r.q('.pr-edit'))
  assert.equal(r.q('.pr-err')?.textContent, 'The title is empty.')
  // Typing takes the reason away; the text's two reasons.
  r.type(r.field('prTitle') as FEl, 'Stop')
  assert.equal(r.q('.pr-err')?.textContent, '')
  r.type(r.field('prText') as FEl, '')
  r.key(r.field('prText') as FEl, 'Enter')
  assert.equal(r.q('.pr-err')?.textContent, 'The text is empty.')
  r.type(r.field('prText') as FEl, '  !rm -rf /')
  r.key(r.field('prText') as FEl, 'Enter')
  assert.equal(r.q('.pr-err')?.textContent, 'A prompt that starts with an exclamation mark would run a shell command in Claude Code.')
  assert.deepEqual(r.posted, [])
  // A slash command is a prompt like any other.
  r.type(r.field('prText') as FEl, '/loop 30m Ignore this message. No action. No response.')
  r.key(r.field('prText') as FEl, 'Enter')
  assert.equal(r.saves().length, 1)
})

test('the delete question stands in the page: Delete asks, the focus on Keep; Keep or Escape goes back, the focus on Delete; Delete deletes, and the push closes the fields without a word (1.10 §3 A2 rule 6; §7a Q24)', () => {
  const p = promptPage()
  p.press(p.entry('s-stop'), 'Enter')
  p.press(p.q('[data-act="promptDelete"]') as FEl, 'Enter')
  const ask = p.q('li[data-id="s-stop"] .pr-edit > .pr-ask') as FEl
  assert.deepEqual([ask.getAttribute('role'), ask.getAttribute('aria-label')], ['group', 'Delete “Stop after this task”?'])
  assert.equal(ask.querySelector('span')?.textContent, 'Delete “Stop after this task”?')
  assert.deepEqual(ask.querySelectorAll('button').map((b) => [b.dataset.act, b.textContent]), [['promptDeleteYes', 'Delete'], ['promptDeleteNo', 'Keep']])
  assert.equal(p.q('.pr-bar'), null)
  assert.equal(p.doc.active?.dataset.act, 'promptDeleteNo')
  // Keep: the bar again, the focus on Delete.
  p.press(p.doc.active as FEl, 'Enter')
  assert.equal(p.q('.pr-ask'), null)
  assert.equal(p.doc.active?.dataset.act, 'promptDelete')
  // Escape in the question does the same; in the bar it closes the fields.
  p.press(p.doc.active as FEl, 'Enter')
  p.key(p.doc.active as FEl, 'Escape')
  assert.equal(p.doc.active?.dataset.act, 'promptDelete')
  assert.ok(p.q('.pr-edit'))
  assert.deepEqual(p.posted, [])
  // The values typed before the question survive it.
  p.type(p.field('prText') as FEl, 'typed')
  p.press(p.q('[data-act="promptDelete"]') as FEl, 'Enter')
  p.press(p.doc.active as FEl, 'Enter')
  assert.equal(p.field('prText')?.value, 'typed')
  // Delete: one message; the push without the entry closes the fields, no sentence, the focus on the entry that took its place.
  p.press(p.q('[data-act="promptDelete"]') as FEl, 'Enter')
  p.press(p.q('[data-act="promptDeleteYes"]') as FEl, 'Enter')
  p.press(p.q('[data-act="promptDeleteYes"]') as FEl, 'Enter')
  assert.deepEqual(p.posted, [{ type: 'promptDelete', id: 's-stop' }])
  assert.deepEqual(parseWebviewMessage(p.posted[0]), { type: 'promptDelete', id: 's-stop' })
  const after = promptsVm()
  after.items = (after.items as Array<Record<string, unknown>>).filter((x) => x.id !== 's-stop')
  p.push(after)
  assert.equal(p.q('.pr-edit'), null)
  assert.equal(p.q('.pr-flash')?.textContent, '')
  assert.equal(p.doc.active, p.entry('u-3k9x0a2b'))
})

test('Move up and Move down: the fields stay open on the moved entry, the focus on the pressed button; at an end the button does nothing (1.10 §3 A2 rule 7)', () => {
  const p = promptPage()
  p.press(p.entry('s-status'), 'Enter')
  const up = p.q('[data-act="promptUp"]') as FEl
  assert.equal(up.getAttribute('aria-disabled'), 'true')
  p.press(up, 'Enter')
  p.click(up)
  assert.deepEqual(p.posted, [])
  p.type(p.field('prText') as FEl, 'kept')
  const down = p.q('[data-act="promptDown"]') as FEl
  p.press(down, 'Enter')
  assert.deepEqual(p.posted, [{ type: 'promptMove', id: 's-status', dir: 'down' }])
  assert.deepEqual(parseWebviewMessage(p.posted[0]), p.posted[0])
  const moved = promptsVm()
  const items = moved.items as Array<Record<string, unknown>>
  moved.items = [items[1], items[0], items[2], items[3]]
  p.push(moved)
  const lis = p.body().querySelectorAll('.pr-list > li').map((li) => li.dataset.id)
  assert.deepEqual(lis, ['s-keepwarm', 's-status', 's-stop', 'u-3k9x0a2b'])
  assert.ok(p.q('li[data-id="s-status"] .pr-edit'))
  assert.equal(p.doc.active?.dataset.act, 'promptDown')
  assert.equal(p.field('prText')?.value, 'kept')
  assert.equal(p.q('[data-act="promptUp"]')?.getAttribute('aria-disabled'), null)
  // The last entry: Move down does nothing.
  p.press(p.q('[data-act="promptCancel"]') as FEl, 'Enter')
  p.press(p.entry('u-3k9x0a2b'), 'Enter')
  p.posted.length = 0
  p.press(p.q('[data-act="promptDown"]') as FEl, 'Enter')
  assert.deepEqual(p.posted, [])
})

test('New prompt: empty fields at the end of the list, the title\'s placeholder its name; left empty they close without a post; saved, a promptSave without an id (1.10 §3 A2 rule 8)', () => {
  const p = promptPage()
  p.press(p.q('[data-act="promptNew"]') as FEl, 'Enter')
  const li = p.body().querySelectorAll('.pr-list > li')
  assert.equal(li[li.length - 1].dataset.id, '')
  const edit = p.q('li.editing .pr-edit') as FEl
  assert.equal(edit.getAttribute('aria-label'), 'New prompt')
  assert.equal(p.field('prTitle')?.getAttribute('placeholder'), 'New prompt')
  assert.equal(p.field('prTitle')?.value, '')
  assert.equal(p.doc.active, p.field('prTitle'))
  // No move and no delete for an entry that does not exist yet.
  assert.deepEqual(edit.querySelectorAll('button').map((b) => b.dataset.act), ['promptSave', 'promptCancel'])
  // Left empty and untouched: closed, nothing posted, the focus on New prompt when it was in the fields.
  p.press(p.field('prTitle') as FEl, 'Enter')
  assert.equal(p.q('.pr-edit'), null)
  assert.deepEqual(p.posted, [])
  assert.equal(p.doc.active?.dataset.act, 'promptNew')
  // Filled and saved.
  p.press(p.q('[data-act="promptNew"]') as FEl, 'Enter')
  p.type(p.field('prTitle') as FEl, 'Summarise')
  p.type(p.field('prText') as FEl, 'Summarise the conversation so far.')
  p.key(p.field('prText') as FEl, 'Enter')
  assert.deepEqual(p.saves(), [{ type: 'promptSave', id: null, title: 'Summarise', text: 'Summarise the conversation so far.' }])
  assert.deepEqual(parseWebviewMessage(p.saves()[0]), p.saves()[0])
  // The push with the new entry closes the fields, the focus on it.
  const added = promptsVm()
  ;(added.items as Array<Record<string, unknown>>).push({ id: 'u-00000001', title: 'Summarise', text: 'Summarise the conversation so far.', shipped: false, edited: false, command: false })
  p.push(added)
  assert.equal(p.q('.pr-edit'), null)
  assert.equal(p.doc.active, p.entry('u-00000001'))
  // At 50: New prompt does nothing.
  const full = promptPage(promptsVm({ canAdd: false }))
  full.press(full.q('[data-act="promptNew"]') as FEl, 'Enter')
  full.click(full.q('[data-act="promptNew"]') as FEl)
  assert.equal(full.q('.pr-edit'), null)
})

test('the open fields survive pushes: a fragment keeps both values, the field and its selection; a whole render puts the focus back into the field (1.10 §3 A2 rule 9)', () => {
  const p = promptPage()
  p.press(p.entry('s-status'), 'Enter')
  p.type(p.field('prTitle') as FEl, 'Table')
  const text = p.field('prText') as FEl
  p.type(text, 'Show the progress.')
  text.focus()
  text.setSelectionRange(5, 13)
  const writes = p.doc.writes
  p.push(promptsVm({ target: { text: 'Sends to Codex in terminal 1 of 1 — sending asks first: …', level: 'asks' } }))
  assert.ok(p.doc.writes > writes, 'the fragment was not drawn')
  assert.equal(p.field('prTitle')?.value, 'Table')
  assert.equal(p.field('prText')?.value, 'Show the progress.')
  assert.equal(p.doc.active, p.field('prText'))
  assert.deepEqual([p.field('prText')?.selectionStart, p.field('prText')?.selectionEnd], [5, 13])
  // In the title field, a whole render (a language switch, a layout change): the same, and the focus back in it.
  const title = p.field('prTitle') as FEl
  title.focus()
  title.setSelectionRange(1, 3)
  p.whole({ sections: ['quota', 'prompts'] })
  assert.equal(p.field('prTitle')?.value, 'Table')
  assert.equal(p.field('prText')?.value, 'Show the progress.')
  assert.equal(p.doc.active, p.field('prTitle'))
  assert.deepEqual([p.field('prTitle')?.selectionStart, p.field('prTitle')?.selectionEnd], [1, 3])
  // A whole render after words: the language switch's focus rule does not take the focus out of the field.
  const words = { lang: 'de', locale: 'de', dict: { Save: 'Speichern' } }
  ;(p.doc.listeners['window:message'] ?? []).forEach((fn) => fn({ origin: '', data: { type: 'data', payload: model({ sections: ['prompts'], prompts: promptsVm() }), words } }))
  assert.equal(p.doc.active, p.field('prTitle'))
  assert.equal(p.q('[data-act="promptSave"]')?.textContent, 'Speichern')
  // Nothing of the draft was ever posted.
  assert.deepEqual(p.posted.filter((m) => m.type !== 'rendered'), [])
})

test('a push whose list no longer holds the open entry closes its fields and says so in the flash line — for as long as a flash stands (1.10 §3 A2 rule 9)', () => {
  const p = promptPage()
  p.press(p.entry('s-stop'), 'Enter')
  p.type(p.field('prText') as FEl, 'mine')
  const gone = promptsVm()
  gone.items = (gone.items as Array<Record<string, unknown>>).filter((x) => x.id !== 's-stop')
  p.push(gone)
  assert.equal(p.q('.pr-edit'), null)
  assert.equal(p.q('.pr-flash')?.textContent, 'This prompt was deleted in another window; your changes were not saved.')
  assert.deepEqual(p.posted, [])
  // The focus goes to the entry that took its place.
  assert.equal(p.doc.active, p.entry('u-3k9x0a2b'))
  // The sentence stands through the next push, then goes after 10 s.
  p.push(gone)
  assert.equal(p.q('.pr-flash')?.textContent, 'This prompt was deleted in another window; your changes were not saved.')
  p.advance(10_000)
  assert.equal(p.q('.pr-flash')?.textContent, '')
  // The section taken off the list: the fields go with it.
  const q = promptPage(promptsVm(), { sections: ['quota', 'prompts'] })
  q.press(q.entry('s-stop'), 'Enter')
  q.whole({ sections: ['quota'], prompts: null })
  assert.equal(nodeVm.runInContext('promptDraft', q.c), null)
})

test('the flash line is one live region for the page\'s life: a push changes its words, and only a new flash changes them (1.10 §3 A2 rule 1, A5)', () => {
  const p = promptPage()
  const line = p.q('.pr-flash') as FEl
  p.push(promptsVm({ flash: { text: 'Sent to Claude Code in terminal 2 of 3.', ok: true } }))
  assert.equal(p.q('.pr-flash'), line, 'the live region was replaced')
  assert.equal(line.textContent, 'Sent to Claude Code in terminal 2 of 3.')
  assert.deepEqual([line.getAttribute('role'), line.getAttribute('aria-live')], ['status', 'polite'])
  p.push(promptsVm({ flash: null }))
  assert.equal(p.q('.pr-flash'), line)
  assert.equal(line.textContent, '')
  p.whole({})
  assert.equal(p.q('.pr-flash'), line, 'a whole render replaced the live region')
})

test('a push that comes while a pointer is pressed waits for its click: the element pressed is the element clicked (1.10 §3 A2 rule 3)', () => {
  const p = promptPage()
  const send = p.send('s-stop')
  p.doc.fire('pointerdown', { target: send })
  p.push(promptsVm({ target: { text: 'moved', level: 'no' } }))
  assert.equal(p.send('s-stop'), send, 'drawn under the pressed pointer')
  p.doc.fire('pointerup', { target: send })
  p.doc.fire('click', { target: send, detail: 1 })
  assert.deepEqual(p.sends(), ['s-stop'])
  p.advance(0)
  assert.notEqual(p.send('s-stop'), send)
  assert.equal(p.q('.pr-target')?.textContent, 'moved')
})

test('a list that cannot be saved: no fields open, New prompt does nothing, every entry still sends (1.10 §3 A2 rule 10)', () => {
  const ro = promptsVm({ readOnly: 'prompts.json was written by a newer version of Token Pace; the shipped prompts are shown and the file is not changed.', canAdd: false })
  const p = promptPage(ro)
  assert.equal(p.q('[data-act="promptNew"]')?.getAttribute('aria-disabled'), 'true')
  assert.equal(p.q('[data-act="promptNew"]')?.getAttribute('title'), null, 'read-only is no full list')
  p.click(p.entry('s-status'), 1)
  p.advance(400)
  p.press(p.entry('s-status'), 'Enter')
  p.press(p.entry('s-status'), ' ')
  p.click(p.q('[data-act="promptNew"]') as FEl)
  assert.equal(p.q('.pr-edit'), null)
  assert.deepEqual(p.posted, [])
  p.press(p.entry('s-status'), 'Enter', { ctrlKey: true })
  p.advance(2000)
  p.click(p.entry('s-stop'), 1)
  p.click(p.entry('s-stop'), 2)
  p.press(p.send('u-3k9x0a2b'), 'Enter')
  assert.deepEqual(p.sends(), ['s-status', 's-stop', 'u-3k9x0a2b'])
  // Open fields when the file turns unreadable: they close.
  const q = promptPage()
  q.press(q.entry('s-stop'), 'Enter')
  q.push(ro)
  assert.equal(q.q('.pr-edit'), null)
})

test('the keyboard walk of §3 A5: Tab to the entry, Enter, x, Escape, Tab, Enter, Shift+Tab, Ctrl+Enter, Enter, Tab to Delete, Enter, Enter, Escape — two sends, no save (1.10 §3 A5)', () => {
  const p = promptPage()
  // From the section's heading (its settings gear is the heading's last stop): the first entry.
  ;(p.q('[data-act="sectionSettings"][data-key="prompts"]') as FEl).focus()
  assert.equal(p.tab(), p.entry('s-status'))
  p.press(p.doc.active as FEl, 'Enter')
  const text = p.field('prText') as FEl
  assert.equal(p.doc.active, text)
  assert.equal(text.selectionStart, text.value.length)
  p.type(text, text.value + 'x')
  p.key(text, 'Escape')
  assert.equal(p.doc.active, p.entry('s-status'))
  assert.equal(p.tab(), p.send('s-status'))
  p.press(p.doc.active as FEl, 'Enter')
  assert.equal(p.tab(true), p.entry('s-status'))
  p.press(p.doc.active as FEl, 'Enter', { ctrlKey: true })
  p.press(p.doc.active as FEl, 'Enter')
  assert.equal(p.doc.active, p.field('prText'))
  // Save, Cancel, Move up, Move down, Delete.
  for (let i = 0; i < 5; i++) p.tab()
  assert.equal(p.doc.active?.dataset.act, 'promptDelete')
  p.press(p.doc.active as FEl, 'Enter')
  assert.equal(p.doc.active?.dataset.act, 'promptDeleteNo')
  p.press(p.doc.active as FEl, 'Enter')
  assert.equal(p.doc.active?.dataset.act, 'promptDelete')
  p.key(p.doc.active as FEl, 'Escape')
  assert.equal(p.q('.pr-edit'), null)
  assert.equal(p.doc.active, p.entry('s-status'))
  assert.deepEqual(p.posted.map((m) => m.type), ['promptSend', 'promptSend'])
})

test('the acknowledgement of a whole render names the sections the page drew — not a listed key it has nothing for (1.10 P5, Review 1b F7)', () => {
  const p = promptPage(promptsVm(), { sections: ['quota', 'prompts', 'forecast'] })
  p.whole({})
  const ack = p.posted.filter((m) => m.type === 'rendered').pop()
  assert.deepEqual(ack, { type: 'rendered', sections: 3, drawn: ['quota', 'prompts'] })
  assert.deepEqual(parseWebviewMessage(ack), ack)
  // Without its view model the section draws nothing: it is not among them.
  p.whole({ prompts: null })
  assert.deepEqual(p.posted.filter((m) => m.type === 'rendered').pop(), { type: 'rendered', sections: 3, drawn: ['quota'] })
})

test('the German page: the words of the section through the dictionary, the send button named „„…“ senden" (1.10 §3 A5, A6)', () => {
  const de = germanPage({
    'Prompts': 'Prompts', 'Send “{0}”': '„{0}“ senden', 'Edit “{0}”': '„{0}“ bearbeiten', 'New prompt': 'Neuer Prompt',
    'Enter edits it, Ctrl+Enter sends it.': 'Eingabe bearbeitet ihn, Strg+Eingabe sendet ihn.', 'Save': 'Speichern', 'Cancel': 'Abbrechen',
    'Delete “{0}”?': '„{0}“ löschen?', 'Keep': 'Behalten', 'Delete': 'Löschen', 'Move up': 'Nach oben', 'Move down': 'Nach unten',
    'Title': 'Titel', 'Text': 'Text', '{0} / {1} characters': '{0} / {1} Zeichen',
  })
  const script = between(de, /<script nonce="[A-Za-z0-9]+">/, '</script>')
  const german = promptsVm({ items: [{ id: 's-status', title: 'Zwischenstand als Tabelle', text: 'Zeige den aktuellen Zwischenstand in einer übersichtlichen Tabelle an. Spalten: Schritt/Status | Beschreibung | Model | Dauer | voraussichtlich fertig.', shipped: true, edited: false, command: false }] })
  const p = promptPage(german, { script })
  assert.equal(p.send('s-status').getAttribute('aria-label'), '„Zwischenstand als Tabelle“ senden')
  assert.equal(p.q('ul.pr-list')?.getAttribute('aria-label'), 'Prompts')
  assert.equal(p.q('#pr-help')?.textContent, 'Eingabe bearbeitet ihn, Strg+Eingabe sendet ihn.')
  p.press(p.entry('s-status'), 'Enter')
  assert.equal(p.q('.pr-edit')?.getAttribute('aria-label'), '„Zwischenstand als Tabelle“ bearbeiten')
  assert.equal(p.q('.pr-count')?.textContent, '151 / 2000 Zeichen')
  assert.deepEqual(p.body().querySelectorAll('.pr-bar > button').map((b) => b.textContent), ['Speichern', 'Abbrechen', 'Nach oben', 'Nach unten', 'Löschen'])
  p.press(p.q('[data-act="promptDelete"]') as FEl, 'Enter')
  assert.equal(p.q('.pr-ask > span')?.textContent, '„Zwischenstand als Tabelle“ löschen?')
})

test('the section\'s styles: two lines of text at most, a slash command in the editor font, 24 px targets, the fields in the theme\'s field colours, a forced-colours palette of their own (1.10 §3 A2 rule 2, A5)', () => {
  assert.match(STYLE, /\.pr-text \{ display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2; overflow: hidden; \}/)
  assert.match(STYLE, /\.pr-text\.pr-cmd \{ font-family: var\(--vscode-editor-font-family, monospace\); \}/)
  assert.match(STYLE, /\.pr-main \{[^}]*min-height: 24px;/)
  assert.match(STYLE, /\.pr-send \{[^}]*min-width: 24px; min-height: 24px;/)
  assert.match(STYLE, /\.pr-bar button, \.pr-ask button, \.pr-foot button \{ min-height: 24px; \}/)
  assert.match(STYLE, /\.pr-edit input, \.pr-edit textarea \{[^}]*background: var\(--vscode-input-background, transparent\);/)
  // Nothing of the section moves.
  const own = STYLE.split('\n').filter((l) => /\.pr[-.\s{]/.test(l)).join('\n')
  assert.equal(/transition|animation/.test(own), false, own)
  // Forced colours: buttons, fields, the disabled state, the focus ring — and nothing taken out of the adjustment.
  const forced = STYLE.slice(STYLE.indexOf('@media (forced-colors: active)'))
  assert.match(forced, /\.pr-main, \.pr-send, \.pr-bar button, \.pr-ask button, \.pr-foot button \{ background-color: ButtonFace; color: ButtonText; border-color: ButtonText; \}/)
  assert.match(forced, /\.pr-edit input, \.pr-edit textarea \{ background-color: Field; color: FieldText; border: 1px solid CanvasText; \}/)
  assert.match(forced, /\.pr button\[aria-disabled="true"\], \.pr-foot button\[aria-disabled="true"\] \{ color: GrayText;/)
  assert.match(forced, /\.pr-edit input:focus-visible, \.pr-edit textarea:focus-visible \{ outline: 2px solid Highlight; outline-offset: 1px; \}/)
  assert.equal(adjustedOut().some((s) => s.includes('.pr')), false)
})

// ---------------------------------------------------------------------------
// 1.10 P7: decimals through Intl on the page, layout for every language, the stacked colon (§3 B4, B5, D10)
// ---------------------------------------------------------------------------

/** A page in another language: `words` over the German test bundle, its formatters in `locale`. */
function wordsPage(words: Record<string, string>): nodeVm.Context {
  const c = makeContext()
  nodeVm.runInContext(between(germanPage(words), /<script nonce="[A-Za-z0-9]+">/, '</script>'), c)
  return c
}
function renderIn(c: nodeVm.Context, call: string, over: Record<string, unknown> = {}): string {
  ;(c as Record<string, unknown>).fixture = model(over)
  return String(nodeVm.runInContext('vm = fixture; ' + call, c))
}
const DRILL = {
  day: '2026-09-03', models: [{ model: 'claude-opus-4-6', usageText: '1.2K', requests: 3, costText: '~$0.10' }],
  sessions: [{ session: 'abc', project: 'token-pace', usage: '1.2K' }],
}

test('a stacked table cell carries its column\'s name and its label in the language\'s own "{0}:" (1.10 D10, §3 B5 rule 4)', () => {
  const h = render('sDrill()', { drill: DRILL })
  assert.ok(h.includes('<td data-h="Model" data-hl="Model:">claude-opus-4-6</td>'), h)
  assert.ok(h.includes('<td data-h="Usage" data-hl="Usage:">1.2K</td>'), h)
  // The label is the language's pattern, whatever punctuation it puts around the name: a no-break space before the
  // colon (French), a full-width colon (Chinese, Japanese) — and data-h stays the plain name the harness reads.
  const fr = renderIn(wordsPage({ '{0}:': '{0} :', 'Model': 'Modèle' }), 'sDrill()', { drill: DRILL })
  assert.ok(fr.includes('<td data-h="Modèle" data-hl="Modèle :">claude-opus-4-6</td>'), fr)
  const zh = renderIn(wordsPage({ '{0}:': '{0}：', 'Model': '模型' }), 'sDrill()', { drill: DRILL })
  assert.ok(zh.includes('<td data-h="模型" data-hl="模型：">claude-opus-4-6</td>'), zh)
  // German: „{0}:" (§6), from the shipped bundle.
  const bundle = JSON.parse(readFileSync(join(__dirname, '..', 'l10n', 'bundle.l10n.de.json'), 'utf8')) as Record<string, string>
  assert.equal(bundle['{0}:'], '{0}:')
  assert.equal(DICT['{0}:'], '{0}:')
  // Every cell of the page that carries a column name goes through dh(): no header cell without its label.
  assert.equal(/<td data-h="/.test(SOURCE), false, 'a td writes data-h without dh()')
  assert.ok((SOURCE.match(/<td' \+ dh\(/g) ?? []).length >= 40)
  // Every stacked cell of a real page: data-hl is data-h in the pattern.
  const all = pageOf(buildViewModel(makeInput({ cfg: makeConfig({ 'tokenPace.attribution': 'project' }) })) as unknown as Record<string, unknown>)
  const cells = [...all.matchAll(/<td data-h="([^"]*)" data-hl="([^"]*)"/g)]
  assert.ok(cells.length >= 20, String(cells.length))
  for (const m of cells) assert.equal(m[2], m[1] + ':', m[0])
  assert.equal(all.split('<td data-h=').length - 1, cells.length, 'a cell with data-h and no data-hl')
})

test('a number stays with its unit: the page\'s glue() keeps a figure and a following %, min, h, d, s, m, K, M or G on one line (1.10 B5 rule 3)', () => {
  const g = (s: string): string => String(nodeVm.runInContext('glue(' + JSON.stringify(s) + ')', ctx))
  const cases: Array<[string, string]> = [
    ['2 min 전', '2 min 전'], // ko
    ['2 min 前', '2 min 前'], // zh-cn
    ['占 API 等值的 54 %。', '占 API 等值的 54 %。'], // zh-tw's summary: `{2} %`
    ['Claude Code 96 % (doskonała)', 'Claude Code 96 % (doskonała)'], // pl
    ['cools in 4 m 10 s (1 h TTL)', 'cools in 4 m 10 s (1 h TTL)'],
    ['~empty in 3 h · 7 d · 12 K · 1.5 M · 2 G', '~empty in 3 h · 7 d · 12 K · 1.5 M · 2 G'],
    // A word that merely starts with a unit's letter is no unit: the unit ends where no letter follows.
    ['in 2 days, 3 hours, 5 models, 4 Mio., 3 GPT', 'in 2 days, 3 hours, 5 models, 4 Mio., 3 GPT'],
    ['2 минуты', '2 минуты'],
    // Escaped text: an entity ends in ';', never in a digit.
    ['it&#39;s 5 h', 'it&#39;s 5 h'],
    ['', ''],
  ]
  for (const [raw, want] of cases) assert.equal(g(raw), want, raw)
  // Where it is used: the summary, the quota card's meta line, its verdict, its forecast and its prompt-cache lines.
  const sum = render('sSummary()', { digest: ['占 API 等值的 54 %。', 'Today 11 % below the 7-day average.'] })
  assert.ok(sum.includes('<li>占 API 等值的 54 %。</li><li>Today 11 % below the 7-day average.</li>'), sum)
  const q = render('sQuota()', {
    quotas: [card({ ageText: '2 min 전', windows: [win({ verdict: { text: '구간의 37 % 아직 여유', level: 'ok' },
      forecast: { state: 'eta', text: '~39 min 후 소진' } })] })],
  })
  assert.ok(q.includes('<span class="meta">plan max20 · poll · 2 min 전</span>'), q)
  assert.ok(q.includes('<span class="verdict ok">구간의 37 % 아직 여유</span>'), q)
  assert.ok(q.includes('<div class="meta">~39 min 후 소진</div>'), q)
  // Never in an attribute: the figure's own markup and every data-* value keep their plain text.
  assert.ok(q.includes('aria-valuetext="61 %"'), q)
  for (const line of SOURCE.split('\n').filter((l) => /\bglue\(/.test(l) && !/function glue|GLUE_RE/.test(l))) {
    assert.equal(/data-[a-z]+="' \+ glue\(|="' \+ glue\(/.test(line), false, line)
  }
})

test('an ISO day never breaks at its hyphen: every day the page prints stands in a .nobr span (1.10 B5 rule 2)', () => {
  const nb = (d: string): string => '<span class="nobr">' + d + '</span>'
  // The range line and the records are pinned above; the drill, the heat map, the sessions and the data quality here.
  assert.ok(render('sDrill()', { drill: DRILL }).startsWith('<h2>Day ' + nb('2026-09-03') + '</h2>'))
  const heat = render('sHeatmap()', {
    heatmap: { ...(model().heatmap as Record<string, unknown>), peakDay: { day: '2026-09-02', text: '1.2K' }, firstDay: '2026-07-21' },
  })
  assert.ok(heat.includes('peak ' + nb('2026-09-02') + ' (1.2K)'), heat)
  assert.ok(heat.includes('(before ' + nb('2026-07-21') + ')'), heat)
  const sessions = render('sSessions()', { sessions: { enabled: true, cacheStates: [], rows: [
    { session: 'abc', project: 'token-pace', started: '2026-09-03 12:00', duration: '1 h 2 min', usage: '1.2K', requests: 3, cacheState: null, isSub: false },
  ] } })
  assert.ok(sessions.includes('data-hl="Started:">' + nb('2026-09-03') + ' 12:00</td>'), sessions)
  // Its duration glued (1.10 B5 rule 3): a stacked cell wraps.
  assert.ok(sessions.includes('data-hl="Duration:">1\u00a0h 2\u00a0min</td>'), sessions)
  const dq = render('sDataQuality()', { dataQuality: dataQualityOf() })
  assert.ok(dq.includes('Coverage ' + nb('2026-08-01') + ' → ' + nb('2026-09-03')), dq)
  // A day inside a sentence of the summary as well; nothing else of the text is wrapped.
  const sum = render('sSummary()', { digest: ['Peak day 2026-09-02 · 12 % more than 2026-09-01.'] })
  assert.ok(sum.includes('<li>Peak day ' + nb('2026-09-02') + ' · 12 % more than ' + nb('2026-09-01') + '.</li>'), sum)
  // The class keeps its line whole.
  assert.match(STYLE, /\n\.nobr \{ white-space: nowrap; \}/)
})

test('a band\'s share of the day is written to a tenth in the page\'s decimal mark; the chart\'s geometry keeps its \'.\' (1.10 B4)', () => {
  const chart = {
    days: ['2026-09-01', '2026-09-02', '2026-09-03'], labels: ['09-01', '09-02', '09-03'],
    series: [{ key: 'claude:claude-opus-4-6', label: 'claude-opus-4-6', source: 'claude', rank: 0, values: [10, 20, 30] },
      { key: 'codex:gpt-5.3-codex', label: 'gpt-5.3-codex', source: 'codex', rank: 0, values: [1, 2, 3] }],
    metric: 'usage', modelStyle: 'pattern', max: 33, ticks: [10, 20, 30, 40], weekly: false, costLine: null,
  }
  const en = render('sChart()', { chart })
  assert.ok(en.includes(' · 90.9 % of the day · '), en)
  assert.ok(en.includes(' · 9.1 % of the day · '), en)
  const de = renderIn(wordsPage({}), 'sChart()', { chart })
  assert.ok(de.includes(' · 90,9 % of the day · '), de)
  assert.ok(de.includes(' · 9,1 % of the day · '), de)
  // A whole share has no decimals in either language.
  const whole = { ...chart, series: [chart.series[0], { ...chart.series[1], values: [10, 20, 30] }] }
  assert.ok(renderIn(wordsPage({}), 'sChart()', { chart: whole }).includes(' · 50 % of the day · '))
  // Geometry is a CSS value, not a text: a band's height and a bar's width keep their '.' on a German page.
  assert.match(de, /data-bh="30\.30"/)
  const bar = renderIn(wordsPage({}), 'sQuota()', { quotas: [card({ windows: [win({ percent: 61.25 })] })] })
  assert.match(bar, /<div class="fill ok" data-w="61\.25"><\/div>/)
  assert.equal(/data-(w|x|bh)="[^"]*,/.test(de + bar), false)
})
