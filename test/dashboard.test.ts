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
import { MAX_GROUP_CHILDREN, MAX_MORE_PAGES, SILENT_AFTER_MS } from '../src/agentTree'
import { setBundle, setLocale } from '../src/i18n'
import { agentTreeFor, buildViewModel, parseWebviewMessage } from '../src/viewModel'
import { AGENT_WORLD, agentNode as agentNodeOf, agentWorld, everyParent, treeNodes } from './fixtures/agentWorld'
import { NOW, makeConfig, makeInput } from './fixtures/viewFixtures'

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
    pricing: { asOf: '2026-09-02', custom: false, showList: false },
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
  assert.match(STYLE, /td\[data-h\]::before \{ content: attr\(data-h\)/)
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
  assert.ok(h.indexOf('<td data-h="Period" title="09:00 → now">Current 5 h window</td>') >= 0, h)
  assert.ok(h.indexOf('<td data-h="Period" title="2026-09-03">Today</td>') >= 0, h)
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
    setLocale('de')
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
  }
}

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
  for (const word of ['Zeitraum', 'Anbieter', 'Modelle', 'Aktualisieren', 'heute', 'benutzerdefiniert…']) {
    assert.ok(bar.indexOf(word) >= 0, `${word} is missing from ${bar}`)
  }
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
  assert.match(html, /\nconst LOCALE = "de";\n/)
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
  assert.ok(top.indexOf('<span>5 h · resets 3h20m</span>') >= 0, top)
  const verdict = top.indexOf('<span class="verdict warn">▲ 9 % ahead of pace</span>')
  const figure = top.indexOf('<b>70 %</b>')
  assert.ok(verdict > 0 && figure > verdict, top)
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
  assert.ok(state.indexOf('<span class="verdict error">▲ exhausted · limit reached</span>') >= 0, state)
  // The row wraps in a narrow sidebar; it never clips or ellipsises.
  const row = STYLE.match(/\.win-top \{[^}]*\}/)
  assert.ok(row, 'the header row rule is missing')
  assert.ok(row[0].includes('flex-wrap: wrap'), row[0])
  assert.equal(/nowrap|text-overflow|overflow: hidden/.test(row[0]), false, row[0])
  assert.match(STYLE, /\.verdict \{[^}]*overflow-wrap: anywhere/)
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
    '<span class="verdict error">▲ 20 % of the window still spare · limit reached</span>') >= 0, reached)
  // The same reading at the same pace level, which no provider has called reached, keeps the
  // pace colour and stays arrow-less: the red is the provider's word about the limit, not a
  // rule the card has invented for 40 %.
  const spare = render('sQuota()', {
    quotas: [card({ windows: [win({
      display: 'normal', level: 'ok', percent: 40, percentText: '40 %',
      verdict: { text: '20 % of the window still spare', level: 'ok' },
    })] })],
  })
  assert.ok(spare.indexOf('<span class="verdict ok">20 % of the window still spare</span>') >= 0, spare)
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
  assert.ok(h.indexOf('<span>5 h · resets 3h20m</span><b>3 %</b>') >= 0, h)
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
  assert.ok(h.indexOf('2 min ago') >= 0, h)
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
  assert.ok(full.indexOf('full until the reset in 3 h') >= 0, full)
})

test('the footer prints "Prices as of" exactly once, whichever side carries it', () => {
  const withNote = render('sFooter()')
  assert.equal(withNote.split('Prices as of').length - 1, 1, withNote)
  assert.ok(withNote.indexOf('Generated 2026-09-03 12:00') >= 0, withNote)
  // A model that has no such footnote still gets the sentence, once.
  const without = render('sFooter()', { footnotes: ['Local numbers are what this machine saw.'] })
  assert.equal(without.split('Prices as of').length - 1, 1, without)
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
  const chips = render('controls()')
  assert.ok(chips.indexOf('data-src="claude"') >= 0, chips)
  assert.ok(chips.indexOf('>Claude Code</button>') >= 0, chips)
  assert.ok(chips.indexOf('>Codex</button>') >= 0, chips)
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
    assert.ok(h.indexOf('<td data-h="' + head + '">' + value + '</td>') >= 0, head + ': ' + h)
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
  assert.match(STYLE, /\.sparkbox \{ position: relative; \}/)
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

test('the filter bar sits below the quota cards and above the first section it filters', () => {
  const order = (html: string): string[] => {
    const out: string[] = []
    const re = /data-sec="([a-zA-Z]+)"/g
    for (let m = re.exec(html); m; m = re.exec(html)) out.push(m[1])
    return out
  }
  // The default order: quota first, then the statistics — the chips go between them.
  assert.deepEqual(order(renderPage({ sections: ['quota', 'summary', 'kpis'] })),
    ['notices', 'quota', 'controls', 'summary', 'kpis', 'drill', 'footer'])
  // A context card leads the same way; the bar waits for the first section it applies to.
  assert.deepEqual(order(renderPage({ sections: ['quota', 'context', 'kpis'] })),
    ['notices', 'quota', 'context', 'controls', 'kpis', 'drill', 'footer'])
  // The Tokens section is fixed periods of everything and follows no chip, so it leads the
  // same way — and where it is listed after a filtered section it stays below the bar: the
  // order is the reader's, the bar only marks where the chips start to apply.
  assert.deepEqual(order(renderPage({ ...tokensVm(), sections: ['quota', 'tokens', 'summary', 'kpis'] })),
    ['notices', 'quota', 'tokens', 'controls', 'summary', 'kpis', 'drill', 'footer'])
  assert.deepEqual(order(renderPage({ ...tokensVm(), sections: ['quota', 'summary', 'tokens'] })),
    ['notices', 'quota', 'controls', 'summary', 'tokens', 'drill', 'footer'])
  // A reader who puts the statistics first gets the chips at the top, as before.
  assert.deepEqual(order(renderPage({ sections: ['summary', 'quota'] })),
    ['notices', 'controls', 'summary', 'quota', 'drill', 'footer'])
  // Nothing to filter: the bar is still in the page (the range label and the refresh button
  // live there), after the cards.
  assert.deepEqual(order(renderPage({ sections: ['quota'] })),
    ['notices', 'quota', 'controls', 'drill', 'footer'])
  // A preview banner qualifies every figure, so it stands above the quota cards.
  const preview = renderPage({ sections: ['quota', 'kpis'], preview: true })
  assert.ok(preview.indexOf('Preview data') < preview.indexOf('data-sec="quota"'), preview)
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
    '<b>Period</b> last 30 days · 2026-08-05 → 2026-09-03',
    '<b>Compared with</b> previous 30 days · 2026-07-06 → 2026-08-04 · 900K',
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
  assert.ok(h.indexOf('<div class="meta" title="current session, via the status line">' + line + '</div></div>') >= 0, h)
  // Last: after the sparkline caption, the extra usage and any local block.
  const withExtra = render('sQuota()', {
    quotas: [card({
      promptCache: { text: line, note: 'n', expired: false },
      extra: { text: '$12 of $50', utilization: 24, enabled: true, billed: true },
    })],
  })
  assert.ok(withExtra.indexOf(line) > withExtra.indexOf('Extra usage'), withExtra)
  assert.ok(withExtra.indexOf(line) > withExtra.indexOf('class="track"'), withExtra)
  // Without a reading nothing is drawn — not a dash line, not an estimate.
  const none = render('sQuota()', { quotas: [card({ promptCache: null })] })
  assert.equal(none.indexOf('prompt cache'), -1, none)
  // An odd payload with an empty text draws nothing either.
  const empty = render('sQuota()', { quotas: [card({ promptCache: { text: '', note: 'n' } })] })
  assert.equal(empty.indexOf('prompt cache'), -1, empty)
  // Every word is the model's: a dash in the text stays a dash, and the line ticks on nothing
  // of its own. The page has exactly one timer, and it moves the agent tree's live spans —
  // this line carries none.
  const bare = render('sQuota()', {
    quotas: [card({ promptCache: { text: 'prompt cache – · expires in – (– TTL) · hit ratio –', note: 'n' } })],
  })
  assert.ok(bare.indexOf('prompt cache – · expires in – (– TTL) · hit ratio –') >= 0, bare)
  assert.equal(bare.indexOf('data-live'), -1, bare)
  assert.equal(/setTimeout/.test(SCRIPT + SOURCE), false)
  assert.equal((SOURCE.match(/setInterval\(/g) ?? []).length, 1)
})

test('the prompt-cache line carries its own age, and an old reading is marked as one', () => {
  // The header's age belongs to whichever source won the quota race; this line was read from
  // the status-line mirror, so it says when *that* was.
  const line = 'prompt cache warm · expires in 3 m 40 s (5 min TTL) · hit ratio 82 %'
  const old = render('sQuota()', {
    quotas: [card({ promptCache: { text: line, note: 'n', expired: false, ageText: '3 d ago', fresh: false } })],
  })
  assert.ok(old.indexOf('<div class="meta warn" title="n">' + line + ' · updated 3 d ago · ⚠ stale</div>') >= 0, old)
  const fresh = render('sQuota()', {
    quotas: [card({ promptCache: { text: line, note: 'n', expired: false, ageText: '1 min ago', fresh: true } })],
  })
  assert.ok(fresh.indexOf('<div class="meta" title="n">' + line + ' · updated 1 min ago</div>') >= 0, fresh)
  // A payload from a build without the fields is marked neither fresh nor stale.
  const older = render('sQuota()', {
    quotas: [card({ promptCache: { text: line, note: 'n', expired: false } })],
  })
  assert.ok(older.indexOf('<div class="meta" title="n">' + line + '</div>') >= 0, older)
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
  const h = render('controls()', {
    models: { rows: [modelRow()], total: 1, hidden: 0, sort: { key: 'usage', dir: 'desc' } },
  })
  // One block, not a run of button rows: the labels share a column, so the chips of all
  // three rows start at the same x.
  assert.ok(h.startsWith('<div class="bar">'), h)
  for (const label of ['Range', 'Providers', 'Models']) {
    assert.equal(h.split('<span class="meta">' + label + '</span>').length - 1, 1, label + ': ' + h)
  }
  // Every row's label is followed by the cell that carries its chips.
  assert.ok(h.indexOf('<span class="meta">Providers</span><div class="wrap span2">'
    + '<button data-act="provider"') >= 0, h)
  assert.ok(h.indexOf('<span class="meta">Models</span><div class="wrap span2">'
    + '<button data-act="model"') >= 0, h)
  // The range in words ends the range row instead of taking a line of its own …
  assert.ok(h.indexOf('<span class="meta cap">Last 30 days · 2026-08-05 → 2026-09-03</span></div>') >= 0, h)
  // … and the refresh button is the last thing in that row, an icon with a name of its own.
  assert.ok(h.indexOf('</span></div><button class="icon" data-act="refresh" aria-label="Refresh"'
    + ' title="Rebuild from the transcripts and fetch the quota"><svg') >= 0, h)
  // Inline SVG, never an icon font or a file: the page loads nothing from anywhere.
  assert.equal(/<img|@font-face|url\(/.test(h), false, h)
  assert.ok(h.indexOf('stroke="currentColor"') >= 0, h)
  // The date fields are a line of their own, directly under the range they belong to.
  const dates = render('controls()', {
    range: { from: '2026-08-05', to: '2026-09-03', label: 'Custom', preset: 'custom', presets: ['7d', '30d'] },
  })
  assert.ok(dates.indexOf('</button><div class="wrap full"><label class="meta" for="tp-from">') >= 0, dates)
  assert.ok(dates.indexOf('data-act="customRange">apply</button></div><span class="meta">Providers</span>') >= 0, dates)

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
  for (const act of ['range', 'customRange', 'customDates', 'refresh', 'cmd', 'sort', 'provider',
    'model', 'clearModels', 'moreModels', 'moreRanges', 'section', 'sectionSettings',
    'heatmapMetric', 'hourZone', 'drill', 'costLine', 'metric', 'compositionCache',
    'agentToggle', 'agentSelect', 'agentMore']) {
    assert.ok(SOURCE.indexOf('data-act="' + act + '"') >= 0, act)
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
  assert.ok(h.includes('Peak day 2026-09-03 · 412k'), h)
  assert.ok(h.includes('Longest streak 3 days · 2026-09-01 → 2026-09-03'), h)
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
  assert.ok(h.includes('data-h="Tool">Read <span class="meta">Claude Code</span>'), h)
  assert.ok(h.includes('data-h="Calls">3<'), h)
  assert.ok(h.includes('data-h="Share">43 %<'), h)
  assert.ok(h.includes('claude-opus-4-6'), h)
  assert.ok(h.includes('7 call(s) · 4 distinct tool(s) · 2 more not listed'), h)
  assert.ok(h.includes('Tool calls counted since 2026-09-02.'), h)
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
  return {
    agentCount: started,
    tally: { started, ...c },
    tallyText: [`${started} started`, ...on.map((g) => g[1])].join(' · '),
    tallySpoken: [`${started} started`, ...on.map((g) => g[2])].join(', '),
  }
}

/** The session's, the run's and the failed agent's tallies of agentTree() below. */
const T_S1 = tallyOf({ done: 1, failed: 1, running: 1, unknown: 1 })
const T_WF = tallyOf({ done: 1, running: 1 })
const T_A3 = tallyOf({ unknown: 1 })

// 1.6 N6: a row is two lines — its name, then its figures under it.
/** The separator between two parts of a name: a part of its own, which never gives way. */
const DOT = '<span class="ag-dot"> · </span>'
/**
 * A row's first line as the page writes it: the parts of the name — only the first one may give
 * way — then, for an agent, a session and a run, the short id in the dim tone, and a session's
 * project; titled with the whole name.
 */
function lbl(title: string, names: string[], id: string | null = null, proj = ''): string {
  return '<span class="ag-label" title="' + title + '">'
    + names.map((p, i) => (i ? DOT : '') + '<span class="ag-np">' + p + '</span>').join('')
    + (id !== null ? DOT + '<span class="ag-sid">' + id + '</span>' : '')
    + (proj ? '<span class="ag-proj"> · ' + proj + '</span>' : '') + '</span>'
}
/** The separator in front of every part of a figures' line but the first, hidden from a screen reader. */
const SEP = '<span aria-hidden="true"> · </span>'
/** One figure of a row, unbreakable. */
const fig = (v: string): string => '<span class="nobr">' + v + '</span>'
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
/** A tally's parts on the figures' line: the glyphs for the eye, the words once, after the last. */
function tallyFigs(t: Record<string, unknown>): string[] {
  const parts = String(t.tallyText).split(' · ').map((p) => '<span class="ag-t" aria-hidden="true">' + p + '</span>')
  parts[parts.length - 1] += '<span class="sr">' + String(t.tallySpoken) + '</span>'
  return parts
}
/** The end of a figures' line that ends on a tally, after other parts: the tally's parts and the line's end. */
const tallyEnd = (t: Record<string, unknown>): string => tallyFigs(t).map((p) => '<span class="ag-fp">' + SEP + p + '</span>').join('') + '</span>'

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
      treeNode(AK.s1, 'active', {
        kind: 'session', label: 'Session Tue 10:55 · 9d0eb37a', sub: 'repo', usage: '1.2M', usageAgents: '434.6K', duration: '1 h 05 min',
        ...T_S1,
        children: [
          treeNode(AK.wf, 'running', {
            kind: 'workflow', label: 'Workflow run Tue 11:40 · cfe7718d', usage: '410K', ...T_WF,
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
      treeNode(AK.s2, 'idle', { kind: 'session', label: 'Session Mon 09:00 · 1234abcd', usage: '–', duration: '–' }),
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
  return { c, posted, root, intervals, clock, fire }
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
  assert.ok(h.indexOf('<li role="treeitem" class="ag-k-agent ag-sup" aria-selected="false">') >= 0, h)
  assert.ok(h.indexOf('<span class="ag-st ag-failed" role="img" aria-label="failed, recorded, superseded by a later attempt" title="'
    + title + '">') >= 0, h)
  // Only the superseded one: the running agent beside it is drawn as ever.
  assert.equal(h.split('ag-sup').length - 1, 1, h)
  assert.ok(h.indexOf('aria-label="running, derived" title="~running · derived"') >= 0, h)
  // The dimming is the stylesheet's, no new colour: 1.6 P7 (pinned and changed, the lead's call on
  // the pictures) fades the glyph and the name to .65 — at .8, and the name in the dim tone, the row
  // was hardly dimmed on the dark theme; the short id and the figures are dim already and stay so.
  assert.match(STYLE, /\.ag-sup > \.ag-line > \.ag-row > \.ag-st, \.ag-sup > \.ag-line > \.ag-row \.ag-np \{ opacity: \.65; \}/)
  assert.equal(/\.ag-sup[^{]*\{[^}]*color:/.test(STYLE), false, 'a superseded row has a colour of its own')
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
  assert.ok(h.indexOf('<button class="ag-row" data-act="agentSelect" data-key="' + AK.a1 + '" aria-pressed="false">'
    + '<span class="ag-st ag-running" role="img" aria-label="running, derived" title="~running · derived"></span>'
    + '<span class="ag-text">' + lbl('Explore · claude-opus-5 · a94f', ['Explore', 'opus-5'], 'a94f')
    + figs(fig('12.3K'), clockFig(AG_NOW - 42_000, '42 s', '11:59')) + '</span></button>') >= 0, h)
  assert.match(STYLE, /\.ag-row \{[^}]*display: flex; align-items: baseline;/)
  assert.equal(/\.ag-row \{[^}]*flex-wrap/.test(STYLE), false, 'the glyph would wrap away from its name')
  assert.match(STYLE, /\.ag-text \{[^}]*display: flex; flex-direction: column; \}/)
  // Neither line wraps: a row is two lines at any width.
  assert.match(STYLE, /\.ag-label \{ display: flex; min-width: 0; overflow: hidden; \}/)
  assert.match(STYLE, /\.ag-fig \{[^}]*overflow: hidden; white-space: nowrap; text-overflow: ellipsis;[^}]*color: var\(--dim\);/)
  // The workflow run and its running agent tick; done, failed, unknown and the sessions do not.
  assert.equal(h.split('data-live="since"').length - 1, 2, h)
  assert.ok(h.indexOf(lbl('Workflow run Tue 11:40 · cfe7718d', ['Workflow run Tue 11:40'], 'cfe7718d')
    + figs(fig('410K'), clockFig(AG_NOW - 42_000, '42 s', '11:59'), ...tallyFigs(T_WF))) >= 0, h)
  // A lower bound without its reason is not marked — a mark nobody can ask about says less than
  // none; with its reason it is (see the ⚠ test below), and no line under the tree speaks of it.
  assert.ok(h.indexOf(lbl('Plan · opus-5 · b1c2', ['Plan', 'opus-5'], 'b1c2') + figs(fig('12.3K'), fig('40.0 s'))) >= 0, h)
  assert.equal(h.indexOf('⚠'), -1, h)
  assert.ok(h.endsWith('</ul></div>'), h.slice(-120))
  const rootMark = agentTree({ roots: [treeNode(AK.s2, 'idle', { kind: 'session', label: 'Session Mon 09:00 · 1234abcd', lowerBound: true,
    lowerBoundText: '⚠ lower bound — 1 of 9 replies unfinished', usage: '12K' })] })
  assert.ok(agentsHtml(a, { agents: rootMark }).indexOf(fig('own 12K <span class="ag-lb" role="img" aria-label="lower bound" '
    + 'title="⚠ lower bound — 1 of 9 replies unfinished">⚠</span>')) >= 0)
  // Absence is a dash, never a zero: the quiet session, and a launch nobody has counted yet —
  // here it is not running, so not even a clock, and its second line is dashes.
  assert.ok(h.indexOf(lbl('Explore · – · launched', ['Explore', '–', 'launched']) + figs(fig('–'), fig('–')) + '</span></button>') >= 0, h)
  // A session's figures name what they are (D5), the name first — a figure in front of
  // "agents" would read as a number of agents, beside a tally that counts them: its own
  // transcript's usage, its agents' — never added to it, and not shown for a session without
  // agents — and its span, whose title says so.
  const span = (v: string): string => '<span title="span from the first to the last line">' + v + '</span>'
  assert.ok(h.indexOf(lbl('Session Mon 09:00 · 1234abcd', ['Session Mon 09:00'], '1234abcd') + figs(fig('own –'), fig(span('–')))) >= 0, h)
  // The project a session belongs to, when attribution names one, after its id on the name's
  // line, then — on the second — its figures and the tally of its agents (1.6 N1), which an opened
  // session keeps.
  assert.ok(h.indexOf(lbl('Session Tue 10:55 · 9d0eb37a · repo', ['Session Tue 10:55'], '9d0eb37a', 'repo')
    + figs(fig('own 1.2M'), fig('agents 434.6K'), fig(span('1 h 05 min')), ...tallyFigs(T_S1))) >= 0, h)
  // The sum of the two is no figure of the page.
  assert.equal(h.indexOf('1.6M'), -1, h)
  // A launch whose transcript has not been seen yet reads as the hint it is.
  assert.ok(h.indexOf('<li role="treeitem" class="ag-k-pending" aria-selected="false">') >= 0, h)
  assert.match(STYLE, /\.ag-k-pending > \.ag-line \.ag-label \{ font-style: italic; \}/)
  // A running node without a start gets no clock rather than one counting from 1970 — in the
  // tree, and in the running list — and keeps its duration.
  const nostart = agentsHtml(a, {
    agents: agentTree({ roots: [treeNode(AK.a1, 'running', { startTs: null })], runningNow: [runningItem({ startTs: null })] }),
  })
  assert.equal(nostart.indexOf('data-live'), -1, nostart)
  assert.ok(nostart.indexOf(figs(fig('12.3K'), fig('40.0 s'))) >= 0, nostart)
  // Without the view model's clock time the clock stays readable: no words to stand in for it.
  const noclock = treePart(agentsHtml(a, { agents: agentTree({ roots: [treeNode(AK.a1, 'running', { startClock: null })] }) }))
  assert.ok(noclock.indexOf(figs(fig('12.3K'), clockFig(AG_NOW - 42_000, '42 s', null))) >= 0, noclock)
  // A node with nothing in it is dashes, on both lines.
  const bare = agentsHtml(a, { agents: agentTree({ roots: [{ key: AK.a1 }] }) })
  assert.ok(bare.indexOf('<span class="ag-label"><span class="ag-np">–</span></span>' + figs(fig('–'), fig('–'))) >= 0, bare)
  assert.equal(/undefined|NaN|null|\[object Object\]/.test(h + nostart + bare), false)
})

test('by default the tree is closed: only the sessions, each parent collapsed and saying what its agents came to', () => {
  const a = agentCtx()
  const h = treePart(agentsHtml(a))
  // The two sessions and nothing under them: no run, no agent, no launch is written.
  assert.deepEqual([...h.matchAll(/data-act="agentSelect" data-key="([^"]*)"/g)].map((m) => m[1]), [AK.s1, AK.s2])
  for (const k of [AK.wf, AK.a1, AK.a2, AK.a3, AK.l1]) assert.equal(h.indexOf('data-key="' + k + '"'), -1, k)
  assert.equal(h.indexOf('<ul role="group">'), -1, h)
  // The session with children is collapsed, its toggle says it opens it, and the second line of
  // its row (1.6 N6) ends on what its agents came to (1.6 N1) — the glyphs for the eye, each a
  // part of the line, and the same in words once for a screen reader, which would read the glyphs
  // as shapes; the session with none is a leaf, and has no tally at all rather than "0 started".
  assert.ok(h.indexOf('<li role="treeitem" class="ag-k-session" aria-expanded="false" aria-selected="false">'
    + '<div class="ag-line"><button class="ag-fold" data-act="agentToggle" data-key="' + AK.s1
    + '" aria-label="Expand Session Tue 10:55 · 9d0eb37a"></button>') >= 0, h)
  assert.ok(h.indexOf(lbl('Session Tue 10:55 · 9d0eb37a · repo', ['Session Tue 10:55'], '9d0eb37a', 'repo')
    + '<span class="ag-fig"><span class="ag-fp"><span class="nobr">own 1.2M</span></span>'
    + '<span class="ag-fp">' + SEP + '<span class="nobr">agents 434.6K</span></span>'
    + '<span class="ag-fp">' + SEP + '<span class="nobr"><span title="span from the first to the last line">1 h 05 min</span></span></span>'
    + '<span class="ag-fp">' + SEP + '<span class="ag-t" aria-hidden="true">4 started</span></span>'
    + '<span class="ag-fp">' + SEP + '<span class="ag-t" aria-hidden="true">1 ✓</span></span>'
    + '<span class="ag-fp">' + SEP + '<span class="ag-t" aria-hidden="true">1 ✕</span></span>'
    + '<span class="ag-fp">' + SEP + '<span class="ag-t" aria-hidden="true">~1 ●</span></span>'
    + '<span class="ag-fp">' + SEP + '<span class="ag-t" aria-hidden="true">~1 ?</span>'
    + '<span class="sr">4 started, 1 done, 1 failed, about 1 running, about 1 unknown</span></span></span>') >= 0, h)
  assert.ok(h.indexOf('<li role="treeitem" class="ag-k-session" aria-selected="false"><div class="ag-line">'
    + '<span class="ag-pad"></span><button class="ag-row" data-act="agentSelect" data-key="' + AK.s2 + '"') >= 0, h)
  assert.equal(h.split('class="ag-t"').length - 1, 5, h)
  assert.equal(/started|agent\(s\)/.test(h.slice(h.indexOf('data-key="' + AK.s2 + '"'))), false, h)
  assert.equal(h.indexOf('aria-expanded="true"'), -1, h)
  // The screen reader's words are out of sight and still read: the page's visually hidden rule.
  assert.match(STYLE, /\.sr \{ position: absolute; width: 1px; height: 1px; margin: -1px; padding: 0; border: 0;\s+overflow: hidden; clip-path: inset\(50%\); white-space: nowrap; \}/)
})

test('an opened node shows its children closed in turn, each with its tally; a session and a run keep theirs open, an agent drops its own', () => {
  const a = agentCtx()
  // The reader opened the busy session: its run and its failed agent show, closed.
  const one = treePart(agentsHtml(a, { ui: agentUi({ agentsExpanded: [AK.s1] }) }))
  assert.ok(one.indexOf('<li role="treeitem" class="ag-k-session" aria-expanded="true" aria-selected="false">'
    + '<div class="ag-line"><button class="ag-fold" data-act="agentToggle" data-key="' + AK.s1
    + '" aria-label="Collapse Session Tue 10:55 · 9d0eb37a"></button>') >= 0, one)
  // Opened, the session still names its project and ends its figures on its tally (1.6 N1): what
  // failed or is still unknown among its agents is not something to count off the rows once they show.
  assert.ok(one.indexOf('<span class="ag-proj"> · repo</span></span>') >= 0, one)
  assert.ok(one.indexOf(tallyEnd(T_S1)) >= 0, one)
  assert.ok(one.indexOf('<li role="treeitem" class="ag-k-workflow" aria-expanded="false" aria-selected="false">'
    + '<div class="ag-line"><button class="ag-fold" data-act="agentToggle" data-key="' + AK.wf
    + '" aria-label="Expand Workflow run Tue 11:40 · cfe7718d"></button>') >= 0, one)
  assert.ok(one.indexOf(tallyEnd(T_WF)) >= 0, one)
  // A closed agent with an agent below it ends its figures on its tally too.
  assert.ok(one.indexOf('<span class="ag-sid">c3d4</span></span>' + figs(fig('12.3K'), fig('40.0 s'), ...tallyFigs(T_A3))) >= 0, one)
  // The children of the closed ones are not written at all.
  for (const k of [AK.a1, AK.a2, AK.l1]) assert.equal(one.indexOf('data-key="' + k + '"'), -1, k)
  assert.equal(one.split('<ul role="group">').length - 1, 1, one)

  // Everything opened: three groups, every parent says it is open; the session and the run keep
  // their tallies, the opened agent shows its child's glyph instead of its own tally.
  const open = treePart(agentsHtml(a, { ui: openUi() }))
  assert.ok(open.indexOf('<li role="treeitem" class="ag-k-workflow" aria-expanded="true" aria-selected="false">'
    + '<div class="ag-line"><button class="ag-fold" data-act="agentToggle" data-key="' + AK.wf
    + '" aria-label="Collapse Workflow run Tue 11:40 · cfe7718d"></button>') >= 0, open)
  // A leaf has no toggle and keeps its place in the column with an empty slot.
  assert.ok(open.indexOf('<li role="treeitem" class="ag-k-agent" aria-selected="false"><div class="ag-line">'
    + '<span class="ag-pad"></span><button class="ag-row" data-act="agentSelect" data-key="' + AK.a1 + '"') >= 0, open)
  assert.equal(open.split('aria-expanded="true"').length - 1, 3, open)
  assert.equal(open.indexOf('aria-expanded="false"'), -1, open)
  assert.equal(open.split('<ul role="group">').length - 1, 3, open)
  assert.ok(open.indexOf(tallyEnd(T_S1)) >= 0, open)
  assert.ok(open.indexOf(tallyEnd(T_WF)) >= 0, open)
  assert.ok(open.indexOf('<span class="ag-sid">c3d4</span></span>' + figs(fig('12.3K'), fig('40.0 s')) + '</span></button>') >= 0, open)
  assert.equal(open.split('class="ag-t"').length - 1, 5 + 3, open)
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
    assert.equal(oh.indexOf('ag-t"'), -1, String(tallyText))
    assert.equal(/started|agent\(s\)|>0</.test(oh), false, oh)
  }
  const mute = agentTree({ roots: [treeNode(AK.s1, 'active', {
    kind: 'session', label: 'Session Tue 10:55 · 9d0eb37a', tallyText: '2 started · 2 ✓', tallySpoken: null, children: [treeNode(AK.a1, 'running')],
  })] })
  assert.ok(treePart(agentsHtml(a, { agents: mute })).indexOf(tallyFigs({ tallyText: '2 started · 2 ✓', tallySpoken: '2 started · 2 ✓' })
    .map((p) => '<span class="ag-fp">' + SEP + p + '</span>').join('')) >= 0)
  // The tally is the view model's text, and like every text of it, it is escaped.
  const hostile = agentTree({ roots: [treeNode(AK.s1, 'active', {
    kind: 'session', label: 'Session Tue 10:55 · 9d0eb37a', tallyText: '<b>1</b> started', tallySpoken: '"1" <started>', children: [treeNode(AK.a1, 'running')],
  })] })
  const hh = treePart(agentsHtml(a, { agents: hostile }))
  assert.ok(hh.indexOf('<span class="ag-t" aria-hidden="true">&lt;b&gt;1&lt;/b&gt; started</span>') >= 0, hh)
  assert.ok(hh.indexOf('<span class="sr">&quot;1&quot; &lt;started&gt;</span>') >= 0, hh)
  // The twisty is drawn, not typed, and turns with the attribute.
  assert.match(STYLE, /\.ag-fold::before \{ content: "▾";/)
  assert.match(STYLE, /\[aria-expanded="false"\] > \.ag-line > \.ag-fold::before \{ content: "▸"; \}/)
  assert.equal(/[▾▸]/.test(open + one), false)
})

test('the selected node is the one pressed row, and only a selection opens the details', () => {
  const a = agentCtx()
  const none = agentsHtml(a, { ui: openUi() })
  assert.equal(none.indexOf('aria-pressed="true"'), -1, none)
  assert.equal(none.indexOf('ag-details'), -1, none)
  const h = treePart(agentsHtml(a, { agents: agentTree({ selected: detailsOf() }), ui: openUi({ agentSelected: AK.a1 }) }))
  const pressed = [...h.matchAll(/data-act="agentSelect" data-key="([^"]*)" aria-pressed="true"/g)].map((m) => m[1])
  assert.deepEqual(pressed, [AK.a1])
  assert.equal(h.split('aria-pressed="false"').length - 1, 6, h)
  // The tree says the same to a screen reader.
  assert.equal(h.split('aria-selected="true"').length - 1, 1, h)
  // Quieter than a pressed chip: the track's tint and the focus colour's edge.
  assert.match(STYLE, /\.ag-row\[aria-pressed="true"\] \{ background: var\(--track\);/)
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
  const entry = h.indexOf('<li role="treeitem" class="ag-k-agent" aria-expanded="true" aria-selected="true">')
  assert.ok(entry >= 0, h)
  const line = h.indexOf('<div class="ag-line">', entry)
  const group = h.indexOf('<ul role="group">', entry)
  assert.ok(line > entry && h.indexOf(panel, line) > line && h.indexOf(panel, line) < group, h)
  assert.ok(h.indexOf('</button></div>' + panel + '<ul role="group">', entry) > entry, h)
  // Only its row is pressed; the panel is drawn once, and nowhere after the tree.
  assert.deepEqual([...h.matchAll(/data-key="([^"]*)" aria-pressed="true"/g)].map((m) => m[1]), [AK.a3])
  assert.equal(h.split('<div class="ag-details"').length - 1, 1, h)
  // 1.6 D10: nothing after the tree — the line about the lower bound is gone.
  assert.ok(h.endsWith('</ul></div>'), h.slice(-200))
  // A session's panel stands at the tree's own edge: no level to step out of.
  const top = agentsHtml(a, { agents: agentTree({ selected: detailsOf({ key: AK.s1, rows: [] }) }), ui: agentUi({ agentSelected: AK.s1 }) })
  assert.ok(panelOf(top).startsWith('<div class="ag-details" role="region" aria-label="Details">'), top)
  assert.ok(top.indexOf('aria-pressed="true">') < top.indexOf(panelOf(top)), top)
  // The level the panel steps out of comes from the page's own stylesheet, through the CSSOM
  // (the page's CSP allows no style attribute): one indent of the tree per level.
  assert.match(STYLE, /\.ag-details \{ margin: 4px 0 6px calc\(var\(--ag-ind, 0\) \* -16px\);/)
  assert.match(STYLE, /\.agtree ul ul \{ padding-left: 16px; \}/)
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
  const pressed = (h: string): string[] => [...h.matchAll(/data-key="([^"]*)"( data-list="now")? aria-pressed="true"/g)].map((m) => m[1] + (m[2] ? '@now' : '@tree'))
  assert.deepEqual(pressed(tree), [AK.a1 + '@tree'])
  assert.deepEqual(pressed(now), [AK.a1 + '@now'])
  assert.ok(tree.indexOf(panelOf(tree)) > tree.indexOf('<div class="agtree"'), tree)
  assert.ok(now.indexOf(panelOf(now)) < now.indexOf('<div class="agtree"'), now)
  for (const h of [tree, now]) {
    assert.equal(h.split('<div class="ag-details"').length - 1, 1, h)
    assert.equal(treePart(h).split('aria-selected="true"').length - 1, 1, h)
  }
  // A place the page does not know is the tree's; a running row that is gone hands the details to
  // the tree row, and a tree row that is hidden to the running row.
  const odd = agentsHtml(a, { agents: agentTree({ selected: detailsOf() }), ui: openUi({ agentSelected: AK.a1, agentSelectedIn: 'week' }) })
  assert.deepEqual(pressed(odd), [AK.a1 + '@tree'])
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
  // clauses.
  assert.ok(panel.indexOf('<dt class="ag-wide">Report from Claude Code</dt><dd class="ag-wide">context at the end 12K '
    + '(incl. cache reads and the reply) · 40.0 s from the start · 3 tool calls · '
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
          { label: 'Bar', value: 'x', kind: 'bar' },
        ],
      }),
    }),
    ui: agentUi({ agentSelected: AK.a1 }),
  })
  const saidPanel = said.slice(said.indexOf('<div class="ag-details"'))
  assert.ok(saidPanel.indexOf('yet.</dd><dt>Last activity</dt><dd><span class="nobr"><span data-live="since"') >= 0, saidPanel)
  assert.ok(saidPanel.indexOf('<dt>Last activity</dt><dd>11:59:55 <span class="meta">5 s ago</span></dd>') >= 0, saidPanel)
  assert.ok(saidPanel.indexOf('<dt>Report</dt><dd>12K <span class="meta">a clause of its own</span></dd>') >= 0, saidPanel)
  assert.ok(saidPanel.indexOf('<dt class="ag-wide">Output</dt><dd class="ag-wide">1.2K · <span class="meta">⚠ lower bound</span></dd>') >= 0, saidPanel)
  assert.equal(saidPanel.split('data-id="tokenPace.copyAgentId"').length - 1, 1, saidPanel)
  assert.ok(saidPanel.indexOf('<dt>ID</dt><dd>a2</dd>') >= 0, saidPanel)
  // A kind this build does not know is laid out as a figure.
  assert.ok(saidPanel.indexOf('<dt>Bar</dt><dd>x</dd>') >= 0, saidPanel)
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
  assert.ok(bound.indexOf(fig('12.3K <span class="ag-lb" role="img" aria-label="lower bound" title="' + why + '">⚠</span>')) >= 0, bound)
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
  const mark = (title: string): string =>
    ' <span class="ag-lb" role="img" aria-label="lower bound" title="' + title + '">⚠</span>'
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
  assert.ok(tp.indexOf('<span class="ag-fig"><span class="ag-fp">' + fig('12.3K' + mark(why)) + '</span><span class="ag-fp">' + SEP
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
      kind: 'session', label: 'Session Tue 10:55 · 9d0eb37a', ...three, hasChildren: true, childrenTotal: 2, children: [],
    })],
  })
  const h = treePart(agentsHtml(a, { agents: closed }))
  assert.ok(h.indexOf('<li role="treeitem" class="ag-k-session" aria-expanded="false" aria-selected="false">'
    + '<div class="ag-line"><button class="ag-fold" data-act="agentToggle" data-key="' + AK.s1
    + '" aria-label="Expand Session Tue 10:55 · 9d0eb37a"></button>') >= 0, h)
  assert.ok(h.indexOf(lbl('Session Tue 10:55 · 9d0eb37a', ['Session Tue 10:55'], '9d0eb37a') + '<span class="ag-fig">') >= 0, h)
  assert.ok(h.indexOf(tallyEnd(three)) >= 0, h)
  assert.equal(h.indexOf('<ul role="group">'), -1, 'a closed node wrote a group')
  // A run of journal-only agents: agents below it, no child to open. A leaf, whatever is stored.
  const run = agentTree({
    roots: [treeNode(AK.wf, 'unknown', { kind: 'workflow', label: 'Workflow run Tue 11:40 · cfe7718d', ...three, children: [] })],
  })
  for (const ui of [agentUi(), agentUi({ agentsExpanded: [AK.wf] })]) {
    const leaf = treePart(agentsHtml(a, { agents: run, ui }))
    assert.equal(leaf.indexOf('ag-fold'), -1, leaf)
    assert.equal(leaf.indexOf('aria-expanded'), -1, leaf)
    assert.ok(leaf.indexOf('<div class="ag-line"><span class="ag-pad"></span><button class="ag-row" data-act="agentSelect" data-key="'
      + AK.wf + '"') >= 0, leaf)
    assert.ok(leaf.indexOf(tallyEnd(three)) >= 0, leaf)
  }
  // An agent's tally stands while its children are not on screen: closed, or opened with none
  // of them sent (the payload's cap); with its children drawn it has none.
  const agent = (children: unknown[], more = 0): Record<string, unknown> => agentTree({ roots: [treeNode(AK.a3, 'failed', {
    label: 'general-purpose · sonnet-5 · c3d4', ...T_A3, hasChildren: true, childrenTotal: 1, childrenMore: more, children,
  })] })
  assert.ok(treePart(agentsHtml(a, { agents: agent([]) })).indexOf(tallyEnd(T_A3)) >= 0)
  assert.ok(treePart(agentsHtml(a, { agents: agent([], 1), ui: agentUi({ agentsExpanded: [AK.a3] }) })).indexOf(tallyEnd(T_A3)) >= 0)
  const drawn = treePart(agentsHtml(a, { agents: agent([treeNode(AK.l1, 'unknown', { kind: 'pending' })]), ui: agentUi({ agentsExpanded: [AK.a3] }) }))
  assert.equal(drawn.indexOf('ag-t"'), -1, drawn)
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
  const line = (words: string, control: boolean): string => '<li role="treeitem" class="ag-k-more"><div class="ag-line">'
    + '<span class="ag-pad"></span>'
    + (control ? '<button class="ag-more" data-act="agentMore" data-key="' + AK.wf + '">' + words + '</button>'
      : '<span class="ag-more">' + words + '</span>')
    + '</div></li>'
  const html = (agents: Record<string, unknown>, ui = open()): string => treePart(agentsHtml(a, { agents, ui }))
  // The line comes after the last child, inside the node's group.
  const many = html(run(377))
  assert.ok(many.indexOf('data-key="a:kid2"') < many.indexOf('class="ag-k-more"'), many)
  assert.ok(many.indexOf(line('50 more · 377 not shown', true) + '</ul>') >= 0, many)
  assert.ok(html(run(1234)).indexOf(line('50 more · 1,234 not shown', true)) >= 0)
  assert.ok(html(run(50)).indexOf(line('50 more', true)) >= 0)
  assert.ok(html(run(12)).indexOf(line('12 more', true)) >= 0)
  // Nothing more, no line; a closed node, none either — its children are not on the page at all.
  assert.equal(html(run(0)).indexOf('ag-k-more'), -1)
  assert.equal(html(run(377), agentUi()).indexOf('ag-k-more'), -1)
  // The last step taken: the count alone, no control. One step before it, the control.
  assert.ok(html(run(377), open({ agentsMore: [{ key: AK.wf, pages: 10 }] })).indexOf(line('377 not shown', false)) >= 0)
  assert.ok(html(run(377), open({ agentsMore: [{ key: AK.wf, pages: 9 }] })).indexOf(line('50 more · 377 not shown', true)) >= 0)
  // Open, and none of its children sent — the page had no room: the count alone.
  assert.ok(html(run(380, [])).indexOf('<ul role="group">' + line('380 not shown', false) + '</ul>') >= 0)
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
  for (const where of ['<span class="ag-np">' + shown, '<span class="ag-label" title="' + shown, '<p class="empty">' + shown + 'n</p>',
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
  const pressedKeys = [...h.matchAll(/data-key="([^"]*)"( data-list="now")? aria-pressed="true"/g)]
    .map((m) => unescapeHtml(m[1]) + (m[2] ? '@now' : '@tree'))
  assert.deepEqual(pressedKeys, [EVIL + AK.a1 + '@tree'])
  assert.ok(treePart(h).indexOf('<div class="ag-details" data-ind="2" role="region"') >= 0, h)
  const treeKeys = [...treePart(h).matchAll(/data-key="([^"]*)"/g)].map((m) => unescapeHtml(m[1]))
  assert.ok(treeKeys.includes(EVIL + AK.a1), treeKeys.join('\n'))
  assert.equal(treeKeys.includes(EVIL + AK.l1), false)
  // An unknown state and kind reach no class, in the tree or in the running list.
  assert.equal(/class="[^"]*(?:script|alert)/.test(h), false, h)
  assert.ok(h.indexOf('<li class="ag-k-agent"><button class="ag-row" data-act="agentSelect"') >= 0, h)
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
  assert.deepEqual(a.posted, [{ type: 'rendered', sections: 2 }], 'a tick posted a message')
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
  assert.deepEqual(a.posted.pop(), { type: 'rendered', sections: 1 })
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
  let panel: unknown = { className: 'ag-details' }
  const fold = { open: true }
  const body = { querySelector: (q: string) => (q === '.ag-details' ? panel : null), querySelectorAll: (q: string) => (q === '[data-act]' ? drawn : []) }
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
  // and the focus goes to the row they stand under, the tree row, not the running list's.
  esc(inAgents)
  assert.deepEqual(a.posted, [{ type: 'agentSelect', key: null }])
  assert.deepEqual(focused, ['tree-row'])
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
  assert.deepEqual([a.posted, focused], [[{ type: 'agentSelect', key: null }], ['tree-row']])
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

test('a keyboard user on the tree keeps the focus through a push of the section', () => {
  const focused: string[] = []
  const control = (act: string, key: string, name: string): Record<string, unknown> =>
    ({ dataset: { act, key }, focus: () => { focused.push(name) } })
  const before = control('agentSelect', AK.a1, 'before')
  const drawn = [control('agentToggle', AK.a1, 'fold'), control('agentSelect', AK.a2, 'other'),
    control('agentSelect', AK.a1, 'after')]
  const inside = new Set<unknown>([before])
  const body = {
    innerHTML: '', dataset: {}, style: {},
    contains: (el: unknown) => inside.has(el),
    querySelectorAll: (sel: string) => (sel === '[data-act]' ? drawn : []),
  }
  const doc: Record<string, unknown> = {
    addEventListener: () => undefined,
    getElementById: () => null,
    querySelector: (s: string) => (s === '[data-body="agents"]' || s === '[data-body="quota"]' ? body : null),
    querySelectorAll: () => [],
    activeElement: before,
  }
  const c = nodeVm.createContext({
    acquireVsCodeApi: () => ({ postMessage: () => undefined }), document: doc,
    window: { addEventListener: () => undefined }, console,
  })
  nodeVm.runInContext(SCRIPT, c)
  ;(c as Record<string, unknown>).fixture = model({ sections: ['quota', 'agents'], agents: agentTree(), ui: agentUi() })
  nodeVm.runInContext('vm = fixture; renderSection("agents");', c)
  // The row the reader was on, found again by what it does and whom it names — not the fold
  // beside it, and not another row.
  assert.deepEqual(focused, ['after'])
  // A control that is gone takes the focus nowhere, and nothing else is focused instead.
  focused.length = 0
  const gone = control('agentSelect', 'a:/p/gone.jsonl', 'gone')
  inside.add(gone)
  doc.activeElement = gone
  nodeVm.runInContext('renderSection("agents");', c)
  assert.deepEqual(focused, [])
  // A focus outside the section, or a refresh of another section, is left to the browser.
  doc.activeElement = before
  inside.clear()
  nodeVm.runInContext('renderSection("agents");', c)
  inside.add(before)
  nodeVm.runInContext('renderSection("quota");', c)
  assert.deepEqual(focused, [])
})

test('a keyboard user on a "more" line keeps the focus on it, and on its node\'s toggle once the line is gone', () => {
  // 1.6 D3: a step shows fifty children more and the line counts down; after the last step the
  // line is gone, and the focus goes to the toggle of the node it belonged to rather than nowhere.
  const focused: string[] = []
  const control = (act: string, key: string, name: string): Record<string, unknown> =>
    ({ dataset: { act, key }, focus: () => { focused.push(name) } })
  const before = control('agentMore', AK.wf, 'before')
  let drawn = [control('agentToggle', AK.wf, 'toggle'), control('agentMore', AK.s1, 'other'), control('agentMore', AK.wf, 'after')]
  const inside = new Set<unknown>([before])
  const body = {
    innerHTML: '', dataset: {}, style: {},
    contains: (el: unknown) => inside.has(el),
    querySelectorAll: (sel: string) => (sel === '[data-act]' ? drawn : []),
  }
  const doc: Record<string, unknown> = {
    addEventListener: () => undefined,
    getElementById: () => null,
    querySelector: (q: string) => (q === '[data-body="agents"]' ? body : null),
    querySelectorAll: () => [],
    activeElement: before,
  }
  const c = nodeVm.createContext({
    acquireVsCodeApi: () => ({ postMessage: () => undefined }), document: doc,
    window: { addEventListener: () => undefined }, console,
  })
  nodeVm.runInContext(SCRIPT, c)
  ;(c as Record<string, unknown>).fixture = model({ sections: ['agents'], agents: agentTree(), ui: agentUi() })
  nodeVm.runInContext('vm = fixture; renderSection("agents");', c)
  assert.deepEqual(focused, ['after'])
  // The last step taken: no line for the node any more — its toggle, not another node's line.
  focused.length = 0
  drawn = [control('agentMore', AK.s1, 'other'), control('agentToggle', AK.wf, 'toggle')]
  nodeVm.runInContext('renderSection("agents");', c)
  assert.deepEqual(focused, ['toggle'])
  // A selection row that is gone still takes the focus nowhere.
  focused.length = 0
  const gone = control('agentSelect', AK.wf, 'gone')
  inside.add(gone)
  doc.activeElement = gone
  drawn = [control('agentToggle', AK.wf, 'toggle')]
  nodeVm.runInContext('renderSection("agents");', c)
  assert.deepEqual(focused, [])
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
    'Collapse {0}', 'Expand {0}', '{0} older session(s) not shown.',
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
    '{0}, derived', '{0}, recorded', 'since {0}', 'silent since {0}']
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
      selected: detailsOf({ rows: [] }), omittedRoots: 2, runningMore: 3,
      runningNow: [runningItem({ silence: true, lastTs: AG_NOW - 4 * 60_000 }), runningItem({ key: AK.l1, waiting: true })],
    }),
    ui: openUi({ agentSelected: AK.a1 }),
  })
  for (const phrase of [
    'role="tree" aria-label="Agenten"', 'title="~läuft · abgeleitet"', 'title="fertig · aufgezeichnet"',
    'title="fehlgeschlagen · aufgezeichnet"', 'title="~unbekannt · abgeleitet"',
    'title="~Sitzung aktiv · abgeleitet"', 'title="~Sitzung ruht · abgeleitet"',
    '<span class="nobr">läuft seit <span data-live="since"', '<dt class="ag-wide">Zustand</dt>', '<dt>Letzte Aktivität</dt><dd><span class="nobr">vor <span data-live="since"',
    'aria-label="Workflow run Tue 11:40 · cfe7718d einklappen"', '<p class="empty">2 ältere Sitzung(en) nicht angezeigt.</p>',
    // 1.6 N5: the silence, in German words and the page's units.
    '<span class="nobr">still seit <span class="ag-for">4 min</span></span>',
    // 1.6 N9: the state and the clocks for a screen reader, in German.
    'aria-label="läuft, abgeleitet" title="~läuft · abgeleitet"', 'aria-label="fertig, aufgezeichnet" title="fertig · aufgezeichnet"',
    '<span class="sr">seit 11:59</span>', '<span class="sr">still seit 11:59</span>',
    // The running list: its heading with everything that runs, the waiting clause, the rest counted.
    '<div class="name" role="heading" aria-level="3">Laufen gerade (5)</div>',
    '<span>wartet auf einen untergeordneten Agenten</span>', '<p class="meta">und 3 weitere</p>',
  ]) assert.ok(h.indexOf(phrase) >= 0, phrase + ' missing from ' + h)
  assert.ok(section({ ui: agentUi({ agentsExpanded: [AK.s1] }) }).indexOf('aria-label="Workflow run Tue 11:40 · cfe7718d ausklappen"') >= 0)
  // 1.6 D3: the line under an open node that shows fifty of its children at a time, in German
  // words and German digits.
  const paged = (more: number, pages: number): string => section({
    agents: agentTree({ roots: [treeNode(AK.wf, 'done', {
      kind: 'workflow', label: 'Workflow run Tue 11:40 · cfe7718d', hasChildren: true, childrenTotal: more + 1, childrenMore: more,
      children: [treeNode(AK.a2, 'done')],
    })] }),
    ui: agentUi({ agentsExpanded: [AK.wf], agentsMore: pages > 0 ? [{ key: AK.wf, pages }] : [] }),
  })
  assert.ok(paged(1234, 0).indexOf('>50 weitere · 1.234 nicht gezeigt</button>') >= 0, paged(1234, 0))
  assert.ok(paged(12, 0).indexOf('>12 weitere</button>') >= 0)
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
  assert.ok(closed.indexOf(tallyEnd({ tallyText: '4 gestartet · 3 ✓ · ~1 ●', tallySpoken: '4 gestartet, 3 fertig, etwa 1 laufend' })) >= 0,
    closed)
  // The toggle's words are the page's; the node's name is the view model's (English here).
  assert.ok(closed.indexOf('aria-label="Session Tue 10:55 · 9d0eb37a ausklappen"') >= 0, closed)
  assert.ok(section({ agents: agentTree({ runningNow: [] }) }).indexOf('<p class="ag-now meta">Kein Agent läuft gerade.</p>') === 0)
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
  const rowOf = (key: string): string => {
    const at = h.indexOf('<button class="ag-row" data-act="agentSelect" data-key="' + key + '"')
    assert.ok(at >= 0, 'no row for ' + key)
    return h.slice(at, h.indexOf('</button>', at))
  }
  const words: Record<string, string> = {
    running: 'running', done: 'done', failed: 'failed', stopped: 'stopped', unknown: 'unknown', active: 'active session',
    idle: 'idle session',
  }
  for (const n of nodes) {
    const row = rowOf(n.key)
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
    assert.ok(row.indexOf('<span class="ag-fig"><span class="ag-fp"><span class="nobr">' + (n.kind === 'session' ? 'own ' : '') + n.usage) >= 0, row)
    const marked = n.lowerBound && n.lowerBoundText !== null
    assert.equal(row.split('class="ag-lb"').length - 1, marked ? 1 : 0, row)
    if (marked) assert.ok(row.indexOf('<span class="ag-lb" role="img" aria-label="lower bound" title="' + n.lowerBoundText + '">⚠</span>') >= 0, row)
    // 1.6 N1: every node opened, so a session's and a run's tally stand, an agent's does not —
    // its children show their own glyphs — and a node without agents below has none.
    const shows = n.tallyText !== null && n.kind !== 'agent'
    assert.equal(row.indexOf('class="ag-t"') >= 0, shows, row)
    if (shows) assert.ok(row.indexOf(tallyEnd(n as unknown as Record<string, unknown>)) >= 0, row)
  }
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
  const p = rowOf(pending[0].key)
  assert.ok(p.indexOf('<span class="ag-fig"><span class="ag-fp"><span class="nobr">–</span></span>') >= 0, p)
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
  const at = inTree.h.indexOf('data-key="' + failed.key + '" aria-pressed="true">')
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
  assert.equal(closed.h.indexOf('The selected node is no longer in the tree.'), -1, closed.h)
  assert.equal(page({ agentsExpanded: opened, agentSelected: failed.key }).h, inTree.h)
  // The running agent, clicked in the running list while its tree row is on the page as well:
  // the panel under the list's row, the list's row pressed, the tree row not — and from the tree
  // row, the other way round.
  const fromNow = page({ agentsExpanded: opened, agentSelected: running.key, agentSelectedIn: 'now' })
  const nowPanel = panelOf(fromNow.h)
  assert.ok(fromNow.h.indexOf('data-key="' + running.key + '" data-list="now" aria-pressed="true">') < fromNow.h.indexOf(nowPanel)
    && fromNow.h.indexOf(nowPanel) < fromNow.h.indexOf('<div class="agtree"'), fromNow.h)
  assert.ok(treePart(fromNow.h).indexOf('data-key="' + running.key + '" aria-pressed="false">') >= 0, fromNow.h)
  const fromTree = page({ agentsExpanded: opened, agentSelected: running.key, agentSelectedIn: 'tree' })
  assert.ok(treePart(fromTree.h).indexOf('data-key="' + running.key + '" aria-pressed="true">') >= 0, fromTree.h)
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
  assert.ok(h.startsWith('<div class="ag-now"><div class="name" role="heading" aria-level="3">Running now (3)</div><ul>'), h)
  assert.ok(h.indexOf('<div class="ag-now">') < h.indexOf('<div class="agtree"'))
  const rows = [...h.slice(0, h.indexOf('<div class="agtree"')).matchAll(/data-key="([^"]*)" data-list="now"/g)].map((m) => m[1])
  assert.deepEqual(rows, items.map((r) => r.key))
  for (const r of items) {
    const at = h.indexOf('data-key="' + r.key + '" data-list="now"')
    const row = h.slice(at, h.indexOf('</button>', at))
    // Its usage — a dash for the launch and the collector, marked where it is a lower bound — then
    // the live clock from its start, with the words for a screen reader; a collector has no start
    // of its own (1.6, the lead's note on P5b) and says how many of its agents run instead.
    assert.ok(row.indexOf('<span class="ag-fig"><span class="ag-fp"><span class="nobr">' + r.usage
      + (r.lowerBound ? ' <span class="ag-lb"' : '</span>')) >= 0, row)
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
  // The tree under it holds the two sessions and nothing else, each saying what its agents came to
  // — the payload carries nothing below them (1.6 D3), and each keeps its toggle.
  assert.ok(vm.agents.roots.every((r) => r.children.length === 0 && r.hasChildren && r.childrenMore === 0))
  const tree = treePart(h)
  assert.deepEqual([...tree.matchAll(/data-act="agentSelect" data-key="([^"]*)"/g)].map((m) => m[1]),
    vm.agents.roots.map((r) => r.key))
  for (const r of vm.agents.roots) {
    assert.equal(r.tally?.started, r.agentCount, r.label)
    assert.ok(tree.indexOf(tallyEnd(r as unknown as Record<string, unknown>)) >= 0, r.label)
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
  return '<li class="ag-k-' + (o.kind ?? 'agent') + '"><button class="ag-row" data-act="agentSelect" data-key="' + o.key
    + '" data-list="now" aria-pressed="' + (o.pressed === true) + '">'
    + '<span class="ag-st ag-running" role="img" aria-label="running, derived" title="~running · derived"></span>'
    + '<span class="ag-text">' + (title === '' ? '<span class="ag-label">' + o.names.map((p) => '<span class="ag-np">' + p + '</span>').join('')
      + '</span>' : lbl(title, o.names, o.id ?? null))
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
  assert.equal(now, '<div class="ag-now"><div class="name" role="heading" aria-level="3">Running now (3)</div><ul>'
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
  assert.equal(now, '<div class="ag-now"><div class="name" role="heading" aria-level="3">Running now (11)</div><ul>'
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
  // In the tree: a leaf — no toggle, no aria-expanded — its glyph, its label, its tally, dashes.
  const t = treePart(h)
  const at = t.indexOf('<li role="treeitem" class="ag-k-noreply"')
  assert.ok(at >= 0, t)
  const li = t.slice(at, t.indexOf('</li>', at) + 5)
  assert.equal(li, '<li role="treeitem" class="ag-k-noreply" aria-selected="false"><div class="ag-line"><span class="ag-pad"></span>'
    + '<button class="ag-row" data-act="agentSelect" data-key="' + AK.n1 + '" aria-pressed="false">'
    + '<span class="ag-st ag-running" role="img" aria-label="running, derived" title="~running · derived"></span>'
    + '<span class="ag-text">' + lbl('263 agent(s) without a counted reply', ['263 agent(s) without a counted reply'])
    + figs(fig('–'), fig('–'), ...tallyFigs(T_N1)) + '</span></button></div></li>', li)
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
  assert.ok(more.startsWith('<div class="ag-now"><div class="name" role="heading" aria-level="3">Running now (5)</div><ul>'), more)
  assert.ok(more.indexOf('</li></ul><p class="meta">and 4 more</p></div><div class="agtree"') >= 0, more)
  // Only left-out ones: the heading and the count, no empty list.
  const only = agentsHtml(a, { agents: agentTree({ runningNow: [], runningMore: 2 }) })
  assert.ok(only.startsWith('<div class="ag-now"><div class="name" role="heading" aria-level="3">Running now (2)</div>'
    + '<p class="meta">and 2 more</p></div>'), only)
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
  assert.ok(bare.startsWith('<div class="ag-now"><div class="name" role="heading" aria-level="3">Running now (1)</div><ul>'
    + nowRow({ key: AK.a1, names: ['–'], title: '', clock: null, usage: '–', where: [] }) + '</ul></div>'), bare)
  assert.equal(/undefined|NaN|null|\[object Object\]|>0</.test(bare.slice(0, bare.indexOf('<div class="agtree"'))), false, bare)
  // A kind this build does not know reaches no class: it is drawn as an agent.
  const rocket = agentsHtml(a, { agents: agentTree({ runningNow: [runningItem({ kind: 'rocket' })] }) })
  assert.ok(rocket.startsWith('<div class="ag-now"><div class="name" role="heading" aria-level="3">Running now (1)</div><ul>'
    + '<li class="ag-k-agent">'), rocket)
  assert.equal(rocket.indexOf('rocket'), -1, rocket)
})

test('with nothing running the list is one quiet line and no heading; a payload without the list says nothing', () => {
  const a = agentCtx()
  const quiet = agentsHtml(a, { agents: agentTree({ runningNow: [], runningMore: 0 }) })
  assert.ok(quiet.startsWith('<p class="ag-now meta">No agent is running.</p><div class="agtree"'), quiet)
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

// 1.6 N6 (pinned and changed): 1.5 let a name wrap between its parts; a row is two lines now, so the
// name is one — no part of it wraps, and where it has no room its first part gives way, never the
// model id or the short id.
test('a name is one line: its parts never wrap, only its first part gives way, and the model id and the short id never', () => {
  const a = agentCtx()
  const h = treePart(agentsHtml(a, { agents: agentTree({ roots: [treeNode(AK.a1, 'done', { label: 'general-purpose · opus-5 · a94f',
    fullLabel: 'general-purpose · claude-opus-5 · a94f' })] }) }))
  const label = h.slice(h.indexOf('<span class="ag-label"'), h.indexOf('<span class="ag-fig">'))
  assert.equal(label, lbl('general-purpose · claude-opus-5 · a94f', ['general-purpose', 'opus-5'], 'a94f'))
  assert.match(STYLE, /\.ag-label > span \{ flex: none; overflow: hidden; white-space: pre; text-overflow: ellipsis; \}/)
  assert.match(STYLE, /\.ag-label > \.ag-np:first-child \{ flex-shrink: 1; min-width: 1\.5em; \}/)
  // The short id and a session's project in the dim tone; the project gives way first.
  assert.match(STYLE, /\.ag-label > \.ag-sid \{ color: var\(--dim\); \}/)
  assert.match(STYLE, /\.ag-label > \.ag-proj \{ flex-shrink: 1000000; min-width: 0; color: var\(--dim\); \}/)
  // A launch's last word is no id, and a collector's name is words: nothing of either is dimmed.
  const launch = treePart(agentsHtml(a, { agents: agentTree({ roots: [treeNode(AK.l1, 'running', { kind: 'pending', label: 'Plan · sonnet · launched' })] }) }))
  assert.equal(launch.indexOf('ag-sid'), -1, launch)
  const words = treePart(agentsHtml(a, { agents: agentTree({ roots: [treeNode(AK.n1, 'running', { kind: 'noreply', label: '2 agent(s) without a counted reply' })] }) }))
  assert.ok(words.indexOf(lbl('2 agent(s) without a counted reply', ['2 agent(s) without a counted reply'])) >= 0, words)
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
  assert.match(STYLE, /\.ag-fig\.ag-cut::after \{ content: "\\00a0…"; \}/)
  assert.match(STYLE, /\.ag-fig \.ag-gone \{ position: absolute; left: 0; top: 0; width: 1px; height: 1px; overflow: hidden;\s+clip-path: inset\(50%\); \}/)
  assert.match(SOURCE, /function applyFits\(\): void \{[^}]*fitAgentFigures\(\);/)
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
  assert.equal(h.split('<span class="sr">since 11:59</span>').length - 1, live, h)
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
  assert.match(block, /\.ag-row\[aria-pressed="true"\] \{ outline: 2px solid Highlight; outline-offset: -2px; \}/)
  assert.equal(/forced-color-adjust/.test(STYLE), false)
})

test('the quota name keeps its nowrap alone, and the running dot never fades below 0.7', () => {
  assert.match(STYLE, /\[data-body="quota"\] \.row > \.name \{ white-space: nowrap; \}/)
  assert.equal(/(^|\n)\.row > \.name \{ white-space: nowrap; \}/.test(STYLE), false, 'the rule reaches every card again')
  assert.match(STYLE, /@keyframes ag-pulse \{ 50% \{ opacity: \.7; \} \}/)
  assert.match(STYLE, /@media \(prefers-reduced-motion: no-preference\) \{\n {2}\.ag-running::before \{ animation: ag-pulse/)
})
