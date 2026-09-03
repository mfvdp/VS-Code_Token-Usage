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
    resetAbsolute: '14:00', forecast: null, sustainable: null, spark: [],
    aria: { now: 61, max: 100, text: '61 %' }, ...over,
  }
}

function card(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    source: 'claude', title: 'Claude Code', planType: 'max20', problem: null, problemKind: null,
    problemAction: null, ageText: '2 min ago', stale: false, origin: 'poll',
    freshness: {
      lastCheck: '2 min ago', lastData: '2 min ago', lastEvent: '1 min ago',
      nextRefresh: 'in 3 min', snapshotAge: '1 min ago',
    },
    windows: [win()], extra: null, usagePageUrl: null, ...over,
  }
}

function forecastCard(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    source: 'claude', windowId: 'session:300', label: '5 h',
    forecast: {
      state: 'eta', ratePerHour: 4, etaMs: null, endPercent: 90, sustainablePerHour: 3,
      confidence: 'medium', basis: { samples: 9, spanMs: 3600_000 }, text: '~90 % at the reset',
    },
    sustainable: null, lockout: null, resetForecast: null, spark: [], gaps: 0, ...over,
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
    ui: { providers: ['claude', 'codex'], models: [], metric: 'usage' },
    quotas: [card()],
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
      series: [{ source: 'claude', values: [10, 20, 30] }],
      metric: 'usage', max: 30, ticks: [10, 20, 30, 40], weekly: false, costLine: null,
    },
    models: { rows: [], total: 0, hidden: 0, sort: { key: 'usage', dir: 'desc' } },
    heatmap: {
      weeks: [{ days: [{ level: 0, text: '2026-09-01: none' }] }], metric: 'usage', streak: 1,
      longestStreak: 2, activeDays: 3, peakDay: null, variability: null, firstDay: '2026-07-21',
    },
    hours: {
      profile: Array.from({ length: 24 }, (_, h) => ({ hour: h, value: h === 9 ? 100 : 0, text: 'none' })),
      peakHour: 9, grid: [], weekdayLabels: ['Mon'], zone: 'local', days: 7, note: null,
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
    assert.ok(h.indexOf('on pace' + (r.state ? ' · ' + r.state : '') + '</div>') >= 0,
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
      sustainable: null, lockout: null, resetForecast: null, gaps: 0,
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
      sustainable: null, lockout: null, resetForecast: null, gaps: 0,
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
      series: [{ source: 'claude', values: [10, 20, 30] },
        { source: 'codex', values: [1, 2, 3] }],
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

test('a lone sparkline sample is a point, not a stretched dash', () => {
  const h = String(nodeVm.runInContext('sparkSvg([10, -1, 50, -1, 90])', ctx))
  assert.equal(h.indexOf('<circle'), -1, h)
  assert.equal(h.split('class="pt"').length - 1, 3, h)
  assert.match(STYLE, /\.spark path\.pt \{[^}]*vector-effect: non-scaling-stroke/)
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
  for (const act of ['range', 'customRange', 'refresh', 'cmd', 'sort', 'provider', 'model',
    'clearModels', 'heatmapMetric', 'hourZone', 'drill', 'costLine', 'metric']) {
    assert.ok(SCRIPT.indexOf('data-act="' + act + '"') >= 0, act)
  }
  for (const role of ['from', 'to']) {
    assert.ok(SCRIPT.indexOf('data-role="' + role + '"') >= 0, role)
  }
})
