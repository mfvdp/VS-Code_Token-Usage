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
import { setBundle, setLocale } from '../src/i18n'

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
 * test here reads, so it is put back whatever happens.
 */
function germanPage(): string {
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
  // Shade: lightness steps of the hue against the track, the largest model the full hue.
  for (const [rank, mix] of [['r0', '100%'], ['r1', '78%'], ['r2', '58%'], ['r3', '42%'], ['r4', '30%'], ['rother', '22%']]) {
    assert.match(STYLE, new RegExp('\\.' + rank + ' \\{ --mix: ' + mix + '; \\}'))
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
  // The faint end of the shade ramp gets an edge of its own: two mixes a few percent apart
  // are not two colours at 4 px, and the last of them is barely there against the plot.
  assert.match(STYLE, /\.st-shade\.r3, \.st-shade\.r4, \.st-shade\.rother \{ box-shadow: inset 0 0 0 1px var\(--hue\); \}/)
  // A provider label in the legend is a heading, so it takes a line of its own; wrapped into
  // the middle of one it read as one more swatch entry.
  assert.match(STYLE, /\.legend > span\.meta \{ flex-basis: 100%; \}/)
  // The chart's swatches are big enough for a pattern to be read; the other legends keep 8 px.
  assert.match(STYLE, /\.legend \.dot\.band \{ width: 14px; height: 14px; \}/)
  assert.match(STYLE, /\.dot \{ display: inline-block; width: 8px; height: 8px;/)
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
  // of its own — the script has no timer at all.
  const bare = render('sQuota()', {
    quotas: [card({ promptCache: { text: 'prompt cache – · expires in – (– TTL) · hit ratio –', note: 'n' } })],
  })
  assert.ok(bare.indexOf('prompt cache – · expires in – (– TTL) · hit ratio –') >= 0, bare)
  assert.equal(/setInterval|setTimeout/.test(SCRIPT + SOURCE), false)
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
  const calls = ['sQuota()', 'sHistory()', 'sChart()', 'sHours()', 'sHeatmap()',
    'sFooter()', 'controls()']
  for (const call of calls) {
    const h = render(call)
    assert.equal(/undefined|NaN|Infinity|\[object Object\]/.test(h), false, call + ': ' + h)
  }
})

test('the message hooks the extension parses are all still in the page', () => {
  for (const act of ['range', 'customRange', 'customDates', 'refresh', 'cmd', 'sort', 'provider',
    'model', 'clearModels', 'moreModels', 'moreRanges', 'section', 'sectionSettings',
    'heatmapMetric', 'hourZone', 'drill', 'costLine', 'metric', 'compositionCache']) {
    assert.ok(SOURCE.indexOf('data-act="' + act + '"') >= 0, act)
  }
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
