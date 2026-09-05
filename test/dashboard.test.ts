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
import * as nodeVm from 'node:vm'
import { test } from 'node:test'

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
 * The webview script in a context of its own. On load it takes the VS Code API and registers
 * four listeners; nothing else runs until a section renderer is called by name.
 */
const ctx = nodeVm.createContext({
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

function forecastCard(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    source: 'claude', windowId: 'session:300', label: '5 h',
    forecast: {
      state: 'eta', ratePerHour: 4, etaMs: null, endPercent: 90, sustainablePerHour: 3,
      confidence: 'medium', basis: { samples: 9, spanMs: 3600_000 }, text: '~90 % at the reset',
    },
    lockout: null, resetForecast: null, spark: [], gaps: 0, ...over,
  }
}

function model(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    generatedAt: '2026-09-03 12:00',
    now: 0,
    sections: ['quota', 'forecast'],
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
      stack: 'provider',
      series: [{ key: 'claude', label: 'Claude Code', source: 'claude', values: [10, 20, 30] }],
      metric: 'usage', max: 30, ticks: [10, 20, 30, 40], weekly: false, costLine: null,
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
    forecasts: [forecastCard()],
    retro: [{ source: 'claude', windowId: 'session:300', label: '5 h', retro: null, text: 'peaked at 61 %' }],
    windowUsage: [{
      source: 'codex', windowId: 'session:300', label: '5 h', usage: '1.2M', cost: '$1.50',
      requests: '30', complete: true,
    }],
    projects: { rows: [], enabled: false },
    sessions: { rows: [], enabled: false, cacheStates: [] },
    attributionInWindow: [{
      source: 'claude', windowId: 'session:300', label: '5 h',
      rows: [{ label: 'token-pace', share: '80 %', usage: '1.0M' }], unexplained: 'nothing unexplained',
    }],
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
  assert.match(SCRIPT, /el\.hidden = \(Number\(el\.dataset\.i\) % vEvery\)/)
  // And the axis text is written into the centred element, never over it.
  assert.match(SCRIPT, /const inner = el\.firstElementChild \|\| el;/)
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
  assert.match(SCRIPT, /svg class="costline" viewBox="0 0 100 100"/)
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
  const f = render('sForecast()', {
    forecasts: [forecastCard({ label: '7 d' })],
    windowUsage: [{
      source: 'codex', windowId: 'weekly:10080', label: '7 d', usage: '1.2M', cost: '$1.50',
      requests: '30', complete: true,
    }],
    attributionInWindow: [{
      source: 'claude', windowId: 'weekly:10080', label: '7 d',
      rows: [], unexplained: 'nothing unexplained',
    }],
  })
  assert.ok(f.indexOf(heading('Claude Code', '7 d')) >= 0, f)
  assert.ok(f.indexOf(heading('Codex', '7 d')) >= 0, f)
  // Every heading that carries a window label: the forecast card, the usage row and the
  // attribution card from that render, and the reset history from its own.
  assert.equal(f.split('class="nobr"').length - 1, 6, f)
  const h = render('sHistory()', {
    retro: [{ source: 'claude', windowId: 'weekly:10080', label: '7 d', retro: null, text: 'x' }],
  })
  assert.ok(h.indexOf('<b>' + heading('Claude Code', '7 d') + '</b>') >= 0, h)
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
  const bands = ['s0', 's1', 's2', 's3', 's4', 'other']
  for (const b of bands) {
    const rule = new RegExp('\\.seg\\.' + b + ', \\.dot\\.' + b + ' \\{([^}]*)\\}').exec(STYLE)
    assert.ok(rule, 'no rule for .seg.' + b)
    const fill = /background: ([^;]+);/.exec((rule as RegExpExecArray)[1])
    assert.ok(fill, 'no fill for .seg.' + b)
    assert.notEqual((fill as RegExpExecArray)[1].trim(), colour, '.seg.' + b + ' wears the cost line colour')
  }
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
  assert.match(PAGE, /default-src 'none'; style-src 'nonce-[A-Za-z0-9]{32}'; script-src 'nonce-[A-Za-z0-9]{32}'/)
  assert.equal(/https?:\/\//.test(STYLE + SCRIPT), false)
  assert.equal(/<link|<img|@import|url\(/.test(STYLE + SCRIPT), false)
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

test('a full window says so instead of showing a lone dash', () => {
  const full = (text: string): string => render('sForecast()', {
    windowUsage: [], attributionInWindow: [],
    forecasts: [forecastCard({
      forecast: {
        state: 'full', ratePerHour: null, etaMs: null, endPercent: null, sustainablePerHour: null,
        confidence: null, basis: null, text,
      },
    })],
  })
  const h = full('full until the reset')
  assert.ok(h.indexOf('full until the reset') >= 0, h)
  assert.equal(h.indexOf('>–<'), -1, h)
  assert.equal(h.indexOf('—'), -1, h)
  assert.equal(h.indexOf('resetsFirst'), -1, h)
  // A window whose reset time is not known says the shorter sentence, and the card prints
  // that one: the webview has no sentence of its own to fall back on, because the one it
  // had ("Full until the reset.") asserted a reset that may not exist.
  const bare = full('full')
  assert.ok(bare.indexOf('>full<') >= 0, bare)
  assert.equal(bare.indexOf('until the reset'), -1, bare)
  // …and the head does not say the same word over it: one "full" per card.
  assert.equal(bare.split('>full<').length - 1, 1, bare)
  // And with no text at all the state word in the head is the whole statement.
  const silent = full('')
  assert.equal(silent.indexOf('Full until the reset'), -1, silent)
  assert.equal(silent.indexOf('>–<'), -1, silent)
  assert.ok(silent.indexOf('>full</span>') >= 0, silent)
})

test('the Forecast section prints a measuring forecast as its state word, never as a sentence', () => {
  // The model hands the row a measuring forecast with its sentence blanked, exactly as it hands
  // the quota card one; the section prints the state word in the head and no body under it.
  const h = render('sForecast()', {
    windowUsage: [], attributionInWindow: [],
    forecasts: [forecastCard({
      forecast: {
        state: 'measuring', ratePerHour: null, etaMs: null, endPercent: null, sustainablePerHour: 20,
        confidence: null, basis: { samples: 2, spanMs: 60_000 }, text: '',
      },
    })],
  })
  assert.ok(h.indexOf('<span class="meta">measuring</span>') >= 0, h)
  assert.equal((h.match(/measuring/g) || []).length, 1, h)
  assert.equal(/readings? over|just reset|just started|%\/h/.test(h), false, h)
  assert.ok(h.indexOf('2 readings') >= 0, h)
})

test('a forecast with nothing to say still says so', () => {
  // `none` is what an unlimited window and a fresh install both produce, and the state word
  // for it is deliberately empty — so the card would otherwise be a name and a blank line.
  const h = render('sForecast()', {
    windowUsage: [], attributionInWindow: [],
    forecasts: [forecastCard({
      forecast: {
        state: 'none', ratePerHour: null, etaMs: null, endPercent: null, sustainablePerHour: null,
        confidence: null, basis: null, text: '',
      },
    })],
  })
  assert.ok(h.indexOf(heading('Claude Code', '5 h')) >= 0, h)
  assert.ok(h.indexOf('>–<') >= 0, h)
  assert.equal(h.indexOf('none'), -1, h)
  // A state that does have a word carries the statement itself; no dash beside it.
  for (const state of ['measuring', 'idle', 'stale']) {
    const worded = render('sForecast()', {
      windowUsage: [], attributionInWindow: [],
      forecasts: [forecastCard({
        forecast: {
          state, ratePerHour: null, etaMs: null, endPercent: null, sustainablePerHour: null,
          confidence: null, basis: null, text: '',
        },
      })],
    })
    assert.equal(worded.indexOf('>–<'), -1, state + ': ' + worded)
  }
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

test('the forecast meta line never starts with a separator', () => {
  const h = render('sForecast()', {
    forecasts: [forecastCard({
      lockout: null, resetForecast: null, gaps: 0,
      forecast: {
        state: 'measuring', ratePerHour: null, etaMs: null, endPercent: null,
        sustainablePerHour: null, confidence: null, basis: { samples: 9, spanMs: 1 }, text: 'measuring',
      },
    })],
  })
  assert.equal(/"meta">\s*·/.test(h), false, h)
  assert.ok(h.indexOf('9 readings') >= 0, h)
  // Nothing to say at all leaves the line out rather than printing an empty one.
  const bare = render('sForecast()', {
    forecasts: [forecastCard({
      lockout: null, resetForecast: null, gaps: 0,
      forecast: {
        state: 'idle', ratePerHour: 0, etaMs: null, endPercent: null, sustainablePerHour: null,
        confidence: null, basis: null, text: 'idle',
      },
    })],
  })
  assert.equal(/<div class="meta"><\/div>/.test(bare), false, bare)
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
  const f = render('sForecast()', {
    forecasts: [forecastCard(), forecastCard({ source: 'codex' })],
  })
  const claude = heading('Claude Code', '5 h')
  assert.ok(f.indexOf(claude) >= 0, f)
  assert.ok(f.indexOf(heading('Codex', '5 h')) >= 0, f)
  // The window usage table and the attribution heading, from the same render.
  assert.ok(f.indexOf('data-h="Window">' + heading('Codex', '5 h')) >= 0, f)
  assert.ok(f.indexOf('"name">' + claude) >= 0, f)
  // The heading is the label, never the internal id.
  assert.equal(f.indexOf('session:300'), -1, f)
  const h = render('sHistory()')
  assert.ok(h.indexOf('<b>' + claude + '</b>') >= 0, h)
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
      stack: 'provider',
      series: [{ key: 'claude', label: 'Claude Code', source: 'claude', values: [10, 20, 30] },
        { key: 'codex', label: 'Codex', source: 'codex', values: [1, 2, 3] }],
      metric: 'usage', max: 30, ticks: [10, 20, 30, 40], weekly: false, costLine: null,
    },
  })
  assert.ok(chart.indexOf('<i class="dot claude"></i>Claude Code') >= 0, chart)
  assert.ok(chart.indexOf('<i class="dot codex"></i>Codex') >= 0, chart)
  // The tooltip of the bar the legend describes: the legend used to say "Claude Code" while
  // every segment's title still said "claude", which is two names for one series.
  assert.ok(chart.indexOf('title="Claude Code \u00b7 2026-09-01: 10"') >= 0, chart)
  assert.ok(chart.indexOf('title="Codex \u00b7 2026-09-03: 3"') >= 0, chart)
  assert.equal(/title="(claude|codex) /.test(chart), false, chart)
})

test('the model stack colours by position, names every band and still drills into the day', () => {
  const bands = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
    days: ['2026-09-01', '2026-09-02', '2026-09-03'],
    labels: ['09-01', '09-02', '09-03'],
    stack: 'model',
    series: [
      { key: 'claude-opus-4-6', label: 'claude-opus-4-6', source: 'claude', values: [10, 20, 30] },
      { key: 'gpt-5.3-codex', label: 'gpt-5.3-codex', source: 'codex', values: [5, 4, 3] },
      { key: 'other', label: 'other', source: null, values: [1, 1, 1] },
    ],
    metric: 'usage', max: 40, ticks: [10, 20, 30, 40], weekly: false, costLine: null,
    ...over,
  })
  const chart = render('sChart()', { chart: bands() })
  // One legend entry per band, the model names verbatim and the fold named as what it is.
  assert.ok(chart.indexOf('<i class="dot s0"></i>claude-opus-4-6') >= 0, chart)
  assert.ok(chart.indexOf('<i class="dot s1"></i>gpt-5.3-codex') >= 0, chart)
  assert.ok(chart.indexOf('<i class="dot other"></i>other') >= 0, chart)
  // A colour per position, because a model name has none of its own.
  assert.ok(chart.indexOf('<div class="seg s0"') >= 0, chart)
  assert.ok(chart.indexOf('<div class="seg s1"') >= 0, chart)
  assert.ok(chart.indexOf('<div class="seg other"') >= 0, chart)
  // The tooltip says what the legend says, and the column is still the day's drill.
  assert.ok(chart.indexOf('title="claude-opus-4-6 · 2026-09-01: 10"') >= 0, chart)
  assert.ok(chart.indexOf('data-act="drill" data-day="2026-09-01"') >= 0, chart)
  // The selector says which stack is on screen.
  assert.ok(chart.indexOf('<option value="model" selected>by model</option>') >= 0, chart)
  assert.ok(chart.indexOf('<option value="provider">by provider</option>') >= 0, chart)

  // The provider stack keeps its two colours and its own selected option.
  const byProvider = render('sChart()', {
    chart: bands({
      stack: 'provider',
      series: [{ key: 'claude', label: 'Claude Code', source: 'claude', values: [10, 20, 30] }],
    }),
  })
  assert.ok(byProvider.indexOf('<div class="seg claude"') >= 0, byProvider)
  assert.ok(byProvider.indexOf('<i class="dot claude"></i>Claude Code') >= 0, byProvider)
  assert.ok(byProvider.indexOf('<option value="provider" selected>by provider</option>') >= 0, byProvider)
  assert.equal(byProvider.indexOf('class="seg s0"'), -1, byProvider)
})

test('the forecast head prints the confidence only where the sentence has not', () => {
  const head = (over: Record<string, unknown>): string => {
    const h = render('sForecast()', {
      windowUsage: [], attributionInWindow: [],
      forecasts: [forecastCard({ forecast: {
        state: 'eta', ratePerHour: 4, etaMs: null, endPercent: 90, sustainablePerHour: 3,
        confidence: 'medium', basis: null, ...over,
      } })],
    })
    assert.equal(h.split('medium confidence').length - 1, 1, h)
    return h
  }
  // The eta sentence already ends with the confidence; the head beside it says the state only.
  const eta = head({ text: '~empty in 5 h (17:00) \u00b7 medium confidence' })
  assert.ok(eta.indexOf('<span class="meta">projected</span>') >= 0, eta)
  assert.ok(eta.indexOf('~empty in 5 h (17:00) \u00b7 medium confidence') >= 0, eta)
  // A sentence that does not say it — "resets first", "idle" — still gets it from the head.
  const first = head({ state: 'resetsFirst', text: '~ends at 90 % when it resets' })
  assert.ok(first.indexOf('resets first \u00b7 medium confidence') >= 0, first)
})

test('a missing source or label degrades to what is there', () => {
  const h = render('sForecast()', {
    forecasts: [],
    windowUsage: [],
    attributionInWindow: [{
      windowId: 'weekly_opus:10080', rows: [], unexplained: '–',
    }],
  })
  assert.ok(h.indexOf('weekly_opus:10080') >= 0, h)
  assert.equal(h.indexOf('undefined'), -1, h)
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

/** A seven-day spark in the view model's slotted shape. */
function slotted(points: Record<string, unknown>[], bridges: Record<string, unknown>[] = []): Record<string, unknown> {
  return { slots: 672, from: 0, to: 672 * 15 * 60_000, points, bridges }
}

function sparkOf(s: Record<string, unknown>): string {
  return String(nodeVm.runInContext('sparkSvg(' + JSON.stringify(s) + ')', ctx))
}

test('the quota sparkline is time-proportional: one unit per slot, holes as wide as their time', () => {
  // Two adjacent slots are one polyline, x is the slot index, y is the inverted percentage.
  const two = sparkOf(slotted([{ i: 10, p: 20, level: 'ok' }, { i: 11, p: 30, level: 'ok' }]))
  assert.match(two, /^<svg class="spark q" viewBox="0 0 672 100" preserveAspectRatio="none" aria-hidden="true">/)
  assert.equal(two.split('<polyline').length - 1, 1, two)
  assert.match(two, /<polyline class="ok" points="10,80.0 11,70.0"\/>/)
  // Slot 0 sits on the left edge, the last slot at slots − 1.
  const ends = sparkOf(slotted([{ i: 0, p: 0, level: null }, { i: 671, p: 100, level: 'error' }]))
  assert.match(ends, /<path class="pt" d="M0 100.0h.01"\/>/)
  assert.match(ends, /<path class="pt error" d="M671 0.0h.01"\/>/)
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

test('the stroke into the first reading after a reset wears no pace colour', () => {
  // The window turned over between the two readings: that fall is not a pace anybody kept,
  // so the stroke stands alone in the neutral provider colour and the coloured run starts
  // again at the new window's first reading.
  const h = sparkOf(slotted([
    { i: 0, p: 80, level: 'warn' }, { i: 1, p: 90, level: 'warn' },
    { i: 2, p: 5, level: 'ok', reset: true }, { i: 3, p: 12, level: 'ok' },
    { i: 4, p: 20, level: 'ok' },
  ]))
  assert.equal(h.split('<polyline').length - 1, 3, h)
  assert.match(h, /<polyline class="warn" points="0,20.0 1,10.0"\/><polyline points="1,10.0 2,95.0"\/><polyline class="ok" points="2,95.0 3,88.0 4,80.0"\/>/)
  // Two resets in a row keep one stroke each rather than melting into one neutral run.
  const twice = sparkOf(slotted([
    { i: 0, p: 60, level: 'warn' }, { i: 1, p: 4, level: 'ok', reset: true },
    { i: 2, p: 3, level: 'ok', reset: true }, { i: 3, p: 9, level: 'ok' },
  ]))
  assert.match(twice, /<polyline points="0,40.0 1,96.0"\/><polyline points="1,96.0 2,97.0"\/><polyline class="ok" points="2,97.0 3,91.0"\/>/)
  assert.equal(twice.split('<polyline').length - 1, 3, twice)
  // A lone reading is a point, not a stroke: it keeps its own level whatever it reports.
  const lone = sparkOf(slotted([{ i: 2, p: 5, level: 'ok', reset: true }]))
  assert.match(lone, /<path class="pt ok" d="M2 95.0h.01"\/>/)
  // The class-less polyline is the provider stroke the CSS defines.
  assert.match(STYLE, /\.spark polyline \{ fill: none; stroke: var\(--claude\);/)
})

test('a hole in the spark is bridged with a dashed line only where the model says so', () => {
  const pts = [{ i: 5, p: 50, level: null }, { i: 9, p: 55, level: null }]
  const bridged = sparkOf(slotted(pts, [{ from: 5, to: 9 }]))
  assert.match(bridged, /<line class="bridge" x1="5" y1="50.0" x2="9" y2="45.0"\/>/)
  // Both ends stay the lone-point hairline: nothing solid is drawn across the hole.
  assert.equal(bridged.split('class="pt"').length - 1, 2, bridged)
  assert.equal(bridged.indexOf('<polyline'), -1, bridged)
  const hole = sparkOf(slotted(pts))
  assert.equal(hole.indexOf('<line'), -1, hole)
  assert.equal(hole.indexOf('<polyline'), -1, hole)
  // A bridge naming a slot with no point is ignored rather than drawn to nowhere.
  const stray = sparkOf(slotted(pts, [{ from: 5, to: 7 }]))
  assert.equal(stray.indexOf('<line'), -1, stray)
  assert.match(STYLE, /\.spark line\.bridge \{[^}]*stroke: var\(--dim\)[^}]*stroke-dasharray[^}]*opacity: \.6[^}]*vector-effect: non-scaling-stroke/)
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
  assert.match(SCRIPT, /scrollIntoView\(\{ block: 'nearest' \}\)/)
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
  const open = renderPage({ sections: ['quota', 'forecast'] })
  // A native <details>: focusable, announced as expandable, and toggled with Enter or Space
  // without a line of ARIA from us.
  assert.ok(open.indexOf('<details open><summary data-act="section" data-key="quota"><h2>Quota</h2></summary>') >= 0, open)
  assert.equal(open.split('<details').length - 1, 2)

  const folded = renderPage({ sections: ['quota', 'forecast'], ui: { providers: ['claude'], models: [], collapsed: ['quota'] } })
  assert.ok(folded.indexOf('<details><summary data-act="section" data-key="quota"') >= 0, folded)
  // Folded, not dropped: the body is still in the document, so a section update writes into
  // it whether the reader has it open or not.
  assert.ok(folded.indexOf('<div data-body="quota">') >= 0, folded)
  assert.ok(folded.indexOf('<details open><summary data-act="section" data-key="forecast"') >= 0, folded)
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
})

test('a payload without the fold list renders every section open', () => {
  // An older extension build sends no `collapsed`; the page may not fold everything away.
  const html = renderPage({ sections: ['quota'], ui: { providers: ['claude'], models: [] } })
  assert.ok(html.indexOf('<details open>') >= 0, html)
})

test('the fold is posted, and a summary is not toggled twice by one key press', () => {
  assert.match(SCRIPT, /post\(\{ type: 'toggleSection', key: el\.dataset\.key \}\)/)
  // The keydown fallback exists for the elements that are not natively activatable; a
  // <summary> is, and acting on both events would fold and unfold in one press.
  assert.match(SCRIPT, /el\.tagName !== 'SUMMARY'/)
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

test('model chips fold behind a count once there are more than four', () => {
  const row = (m: string) => ({
    model: m, source: 'claude', isSub: false, tier: 'standard', usage: 1, usageText: '1',
    output: '1', requests: '1', cost: 0, costText: '–', listCost: null, cacheHit: '–',
    share: '100 %', costShare: '–', priced: 'exact', price: '–', turnAvg: null, turnP90: null,
  })
  const names = ['a', 'b', 'c', 'd', 'e', 'f']
  const h = render('controls()', {
    models: { rows: names.map(row), total: 6, hidden: 0, sort: { key: 'usage', dir: 'desc' } },
  })
  assert.equal(h.split('data-act="model"').length - 1, 4, h)
  assert.ok(h.indexOf('models (6)') >= 0, h)
  assert.ok(h.indexOf('+2 more') >= 0, h)
  // A model that is being filtered on is never folded away: a chip the reader cannot see is
  // a filter they cannot switch off.
  const filtered = render('controls()', {
    models: { rows: names.map(row), total: 6, hidden: 0, sort: { key: 'usage', dir: 'desc' } },
    ui: { providers: ['claude'], models: ['f'], collapsed: [] },
  })
  assert.ok(filtered.indexOf('data-model="f"') >= 0, filtered)
  // Four or fewer and there is nothing to fold.
  const few = render('controls()', {
    models: { rows: names.slice(0, 3).map(row), total: 3, hidden: 0, sort: { key: 'usage', dir: 'desc' } },
  })
  assert.equal(few.indexOf('more</button>') >= 0, false, few)
  assert.ok(few.indexOf('<span class="meta">models</span>') >= 0, few)
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
  assert.match(SCRIPT, /scrollWidth > el\.clientWidth/)
  assert.match(SCRIPT, /class="meta scrollhint"/)
})

// ---------------------------------------------------------------------------
// Nothing invented, nothing broken
// ---------------------------------------------------------------------------

test('no renderer invents a number or leaks an undefined', () => {
  const calls = ['sQuota()', 'sForecast()', 'sHistory()', 'sChart()', 'sHours()', 'sHeatmap()',
    'sFooter()', 'controls()']
  for (const call of calls) {
    const h = render(call)
    assert.equal(/undefined|NaN|Infinity|\[object Object\]/.test(h), false, call + ': ' + h)
  }
})

test('the message hooks the extension parses are all still in the page', () => {
  for (const act of ['range', 'customRange', 'customDates', 'refresh', 'cmd', 'sort', 'provider',
    'model', 'clearModels', 'moreModels', 'section', 'heatmapMetric', 'hourZone', 'drill',
    'costLine', 'metric', 'chartStack']) {
    assert.ok(SCRIPT.indexOf('data-act="' + act + '"') >= 0, act)
  }
  for (const role of ['from', 'to']) {
    assert.ok(SCRIPT.indexOf('data-role="' + role + '"') >= 0, role)
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
