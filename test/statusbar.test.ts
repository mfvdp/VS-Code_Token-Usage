// SPDX-FileCopyrightText: 2026 Frederik Marx
// SPDX-License-Identifier: AGPL-3.0-or-later

import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { Config, sanitize } from '../src/config'
import {
  autoExplain, buildItems, footerLine, itemModel, makeContext, previewItems, problemText,
  problemTooltip, quotaTooltip, selectWindows, StatusTextInput, tokenTooltip, UsageSource,
} from '../src/statusText'
import { emptyBucket, Forecast, ProblemKind, QuotaState, QuotaWindow } from '../src/types'
import type { ViewModel } from '../src/viewModel'

/** 2026-09-03 12:00 UTC — every expectation below is relative to this instant. */
const NOW = Date.UTC(2026, 8, 3, 12, 0, 0)
const HOUR = 3_600_000
/** A 5 h window that resets in 3.5 h: 30 % of its own clock has run. */
const RESETS = NOW + 3.5 * HOUR

function cfg(over: Record<string, unknown> = {}): Config {
  // Through the real validator, so the fixtures cannot drift from the manifest defaults.
  return sanitize({ 'tokenPace.timezone': 'utc', 'tokenPace.resetHourCycle': 'h23', ...over })
}

function win(p: Partial<QuotaWindow> = {}): QuotaWindow {
  return {
    id: 'session:300', kind: 'session', label: '5 h', shortLabel: '5h', model: null,
    percent: 25, resetsAt: RESETS, windowMinutes: 300, limitReached: false, unlimited: false, ...p,
  }
}

function state(p: Partial<QuotaState> = {}): QuotaState {
  return {
    source: 'claude', ok: true, origin: 'poll', fetchedAt: Math.floor(NOW / 1000) - 60,
    planType: 'max20', windows: [win()], ...p,
  }
}

function fakeAgg(): UsageSource {
  const b = emptyBucket('claude', 'claude-opus-4-6', false, 'standard', 'd', null, '2026-09-03')
  b.input = 1_200_000
  b.cacheWrite = 300_000
  b.cacheWrite1h = 40_000
  b.cacheRead = 12_400_000
  b.output = 210_000
  b.reasoning = 45_000
  b.requests = 320
  b.outputFinal = 320
  return {
    sum: () => ({ ...b }),
    cost: () => ({
      usd: 1.23, listUsd: 1.23, unpricedTokens: 0, unpricedModels: [], fastUnpricedTokens: 0,
      familyPriced: [], custom: false,
    }),
  }
}

function input(p: Partial<StatusTextInput> = {}): StatusTextInput {
  return {
    quotas: [state()], agg: fakeAgg(), cfg: cfg(), now: NOW, forecasts: new Map(),
    role: 'single', scanning: false, consent: 'granted', ...p,
  }
}

function textsOf(p: Partial<StatusTextInput> = {}): string[] {
  return buildItems(input(p)).map((m) => m.text)
}

// ---------------------------------------------------------------------------
// Item text per density and display state
// ---------------------------------------------------------------------------

test('full density renders label, bar with clock marker, percent and countdown', () => {
  const items = buildItems(input())
  const quota = items[0]
  assert.equal(quota.text, 'CC 5h ██┃▁▁▁▁▁ 25% · resets 3h30m')
  assert.equal(quota.id, 'tokenPace.quota.claude.session.300')
  assert.equal(quota.name, 'Claude Code — 5 h')
  assert.equal(quota.colorId, 'tokenPace.paceOk')
  assert.equal(quota.alarm, false)
  // Priority descends with the position so the entries stay together and in order.
  assert.equal(quota.priorityKey, '1000')
  assert.equal(items[1].priorityKey, '999')
})

test('the window id becomes the item id, colons and all', () => {
  const w = win({ id: 'weekly_scoped:10080:fable', kind: 'weekly', label: '7 d · Fable', shortLabel: 'Fable 7d' })
  const items = buildItems(input({ quotas: [state({ windows: [w] })] }))
  assert.equal(items[0].id, 'tokenPace.quota.claude.weekly_scoped.10080.fable')
  assert.equal(items[0].name, 'Claude Code — 7 d · Fable')
})

test('exhausted: alarm background, warning glyph, the countdown is named', () => {
  const q = state({ windows: [win({ percent: 100, resetsAt: NOW + 47 * 60_000 })] })
  const m = buildItems(input({ quotas: [q] }))[0]
  // The clock marker stays put: at 100 % it is the only thing that still moves.
  assert.equal(m.text, '$(warning) CC 5h ██████┃█ 100% exhausted · resets 47m')
  assert.equal(m.alarm, true)
  // A background replaces the foreground, so no colour may be set alongside it.
  assert.equal(m.colorId, null)
})

test('overflow keeps the real figure, limitReached and unlimited get their own glyphs', () => {
  const over = buildItems(input({ quotas: [state({ windows: [win({ percent: 111 })] })] }))[0]
  assert.ok(over.text.includes('111%'), over.text)
  assert.equal(over.alarm, false)
  assert.equal(over.colorId, 'charts.red')

  const clamped = buildItems(input({
    quotas: [state({ windows: [win({ percent: 111 })] })],
    cfg: cfg({ 'tokenPace.overflowDisplay': 'clamp' }),
  }))[0]
  assert.ok(clamped.text.includes('100%'), clamped.text)

  const stop = buildItems(input({ quotas: [state({ windows: [win({ percent: 100, limitReached: true })] })] }))[0]
  assert.ok(stop.text.startsWith('⛔ CC 5h'), stop.text)
  assert.equal(stop.alarm, true)

  const inf = buildItems(input({ quotas: [state({ windows: [win({ unlimited: true })] })] }))[0]
  assert.equal(inf.text, 'CC 5h ∞ · resets 3h30m')
})

test('exhausted and limitReached are said in words, whatever the colour settings do', () => {
  // `indicator: color` drops the glyph, `colorMode: monochrome` drops the colour, and a
  // high-contrast theme may drop the alarm background — the state has to survive all three.
  const full = state({ windows: [win({ percent: 100, resetsAt: NOW + 47 * 60_000 })] })
  const stop = state({ windows: [win({ percent: 100, limitReached: true })] })
  for (const c of [
    cfg(),
    cfg({ 'tokenPace.indicator': 'color' }),
    cfg({ 'tokenPace.indicator': 'none' }),
    cfg({ 'tokenPace.colorMode': 'monochrome' }),
  ]) {
    assert.ok(textsOf({ quotas: [full], cfg: c })[0].includes('100% exhausted'),
      textsOf({ quotas: [full], cfg: c })[0])
    assert.ok(textsOf({ quotas: [stop], cfg: c })[0].includes('100% limit reached'),
      textsOf({ quotas: [stop], cfg: c })[0])
  }
  // Every other state keeps the bare figure — the word is the state, not decoration.
  assert.equal(textsOf()[0].includes('exhausted'), false)
  const over = textsOf({ quotas: [state({ windows: [win({ percent: 111 })] })] })[0]
  assert.equal(over.includes('exhausted'), false, over)
  // The word travels into the folded densities too.
  const compact = buildItems(input({ quotas: [full], cfg: cfg({ 'tokenPace.density': 'compact' }) }))[0]
  assert.ok(compact.text.includes('100% exhausted'), compact.text)
  const minimal = buildItems(input({ quotas: [full], cfg: cfg({ 'tokenPace.density': 'minimal' }) }))
    .find((m) => m.id === 'tokenPace.summary')
  assert.ok(minimal?.text.includes('100% exhausted'), minimal?.text)
})

test('the tooltip table states the window state once, not once per column', () => {
  const full = state({ windows: [win({ percent: 100, resetsAt: NOW + 47 * 60_000 })] })
  const tip = quotaTooltip(full, makeContext(input({ quotas: [full] })))
  const row = tip.split('\n').find((l) => l.startsWith('| 5 h |')) ?? ''
  // The Pace column carries it, so the value column does not repeat it.
  assert.equal(row.split('exhausted').length - 1, 1, row)
  // Where the verdict says something else, the value keeps the word.
  const stop = state({ windows: [win({ percent: Number.NaN, limitReached: true })] })
  const stopRow = quotaTooltip(stop, makeContext(input({ quotas: [stop] })))
    .split('\n').find((l) => l.startsWith('| 5 h |')) ?? ''
  assert.ok(stopRow.includes('limit reached'), stopRow)
  assert.ok(stopRow.includes('no reading'), stopRow)
})

test('the reset suffix always names itself, so it cannot be read as an age', () => {
  // Both suffixes are bare durations otherwise; only the age carries an icon of its own.
  const q = state({ fetchedAt: Math.floor(NOW / 1000) - 42 * 60 })
  const text = textsOf({ quotas: [q], cfg: cfg({ 'tokenPace.showAgeInItem': 'always' }) })[0]
  assert.equal(text, 'CC 5h ██┃▁▁▁▁▁ 25% · resets 3h30m $(history) 42m')
  // A window without a stated reset still gets nothing invented.
  assert.equal(textsOf({ quotas: [state({ windows: [win({ resetsAt: null })] })] })[0],
    'CC 5h ██▁▁▁▁▁▁ 25%')
})

test('resetDue: no invented percentage, an empty track and the stale colour', () => {
  const q = state({
    fetchedAt: Math.floor((NOW - 2 * HOUR) / 1000),
    windows: [win({ percent: 62, resetsAt: NOW - 5 * 60_000 })],
  })
  const m = buildItems(input({ quotas: [q] }))[0]
  assert.equal(m.text, 'CC 5h ▁▁▁▁▁▁▁▁ reset due $(history) 2h')
  assert.equal(m.colorId, 'tokenPace.stale')
  assert.equal(m.alarm, false)
})

test('stale readings lose the alarm background and turn grey', () => {
  const q = state({
    fetchedAt: Math.floor((NOW - 42 * 60_000) / 1000),
    windows: [win({ percent: 100 })],
  })
  const m = buildItems(input({ quotas: [q] }))[0]
  assert.equal(m.alarm, false)
  assert.equal(m.colorId, 'tokenPace.stale')
  assert.ok(m.text.endsWith(' $(history) 42m'), m.text)
})

test('compact density is one item per provider, minimal one for all of them', () => {
  const q = state({
    windows: [win(), win({ id: 'weekly_all:10080', kind: 'weekly', label: '7 d', shortLabel: '7d', percent: 69, windowMinutes: 10080, resetsAt: NOW + 6 * 24 * HOUR })],
  })
  // windowSelect defaults to 'worstPace' (one window per tool); this case is about the density,
  // so it asks for every window explicitly.
  const compact = buildItems(input({ quotas: [q], cfg: cfg({ 'tokenPace.density': 'compact', 'tokenPace.windowSelect': 'all' }) }))
  assert.equal(compact[0].id, 'tokenPace.compact.claude')
  assert.equal(compact[0].text, 'CC 25%·3h30m | 69%·6d')

  const minimal = buildItems(input({ quotas: [q], cfg: cfg({ 'tokenPace.density': 'minimal' }) }))
  const summary = minimal.filter((m) => m.id === 'tokenPace.summary')
  assert.equal(summary.length, 1)
  // The worst window decides: 69 % against 60 % elapsed is ahead of the clock.
  assert.equal(summary[0].text, 'TP 69% ▲')
})

test('a problem keeps the provider label visible at every density', () => {
  const q = state({ ok: false, problemKind: 'noToken', windows: [] })
  for (const density of ['full', 'compact', 'minimal']) {
    const items = buildItems(input({ quotas: [q], cfg: cfg({ 'tokenPace.density': density }) }))
    const problem = items.find((m) => m.id === 'tokenPace.quota.claude.problem')
    assert.ok(problem, `no problem item at density ${density}`)
    assert.equal(problem?.text, '$(key) CC no token')
  }
})

// ---------------------------------------------------------------------------
// Problem states
// ---------------------------------------------------------------------------

test('every problem kind has its own text and its own repair command', () => {
  const c = cfg()
  const expected: Array<[ProblemKind, string, string]> = [
    ['noToken', '$(key) CC no token', 'tokenPace.showOutput'],
    ['tokenExpired', '$(warning) CC token expired', 'tokenPace.showOutput'],
    ['consentPending', '$(shield) CC consent', 'tokenPace.refreshQuota'],
    ['retry', '$(clock) CC retry 12m', 'tokenPace.refreshQuota'],
    ['offline', '$(cloud-offline) CC offline', 'tokenPace.refreshQuota'],
    ['quotaOff', '$(circle-slash) CC quota off', 'tokenPace.openSettings'],
    ['modeCache', '$(circle-slash) CC quota off', 'tokenPace.openSettings'],
    ['forbidden', '$(lock) CC 403', 'tokenPace.showOutput'],
    ['unauthorized', '$(key) CC sign in', 'tokenPace.showOutput'],
    ['noFile', 'CC –', 'tokenPace.rescan'],
    ['paused', '$(clock) CC paused', 'tokenPace.showOutput'],
    ['follower', 'CC –', 'tokenPace.showDashboard'],
    ['unknown', 'CC –', 'tokenPace.showOutput'],
  ]
  for (const [kind, text, command] of expected) {
    const q = state({ ok: false, problemKind: kind, windows: [], nextAttemptAt: NOW + 12 * 60_000 })
    assert.equal(problemText(q, c, NOW), text, kind)
    const m = itemModel({ kind: 'problem', q }, makeContext(input({ quotas: [q] })))
    assert.equal(m.command, command, kind)
  }
  const codex = state({ source: 'codex', ok: false, problemKind: 'noBinary', windows: [] })
  assert.equal(problemText(codex, c, NOW), '$(circle-slash) CDX no codex')
  const f = itemModel({ kind: 'problem', q: state({ ok: false, problemKind: 'forbidden', windows: [] }) },
    makeContext(input()))
  // A 403 is explained in the log (the click opens it); the official usage page stays one click
  // away in the tooltip footer, so the item carries no command arguments any more.
  assert.equal(f.command, 'tokenPace.showOutput')
  assert.equal(f.commandArgs, undefined)
})

test('a paused reading names the external poller, not a pause of our own', () => {
  const q = state({ ok: false, problemKind: 'paused', windows: [], problem: 'Poller paused until 3:15:00 PM' })
  const tip = problemTooltip(q, makeContext(input({ quotas: [q] })))
  // The kind is raised only by a cache file in backoff; the focus setting has nothing to do with it.
  assert.equal(tip.includes('pollOnlyWhenFocused'), false, tip)
  assert.ok(tip.includes('external poller'), tip)
  assert.ok(tip.includes('Poller paused until 3:15:00 PM'), tip)
  // A fetch of our own is refused outside `poll`, so only that mode is offered one.
  const cache = itemModel({ kind: 'problem', q }, makeContext(input({ quotas: [q] })))
  assert.equal(cache.command, 'tokenPace.showOutput')
  const poll = itemModel({ kind: 'problem', q },
    makeContext(input({ quotas: [q], cfg: cfg({ 'tokenPace.quotaSource': 'poll' }) })))
  assert.equal(poll.command, 'tokenPace.refreshQuota')
})

test('a retry without a scheduled time never invents a countdown', () => {
  const q = state({ ok: false, problemKind: 'retry', windows: [], nextAttemptAt: null })
  assert.equal(problemText(q, cfg(), NOW), '$(clock) CC retry')
})

// ---------------------------------------------------------------------------
// Formats: reset, age, indicator, colour, remaining
// ---------------------------------------------------------------------------

test('the reset suffix follows resetFormat', () => {
  const cases: Array<[string, string]> = [
    ['none', 'CC 5h ██┃▁▁▁▁▁ 25%'],
    ['relative', 'CC 5h ██┃▁▁▁▁▁ 25% · resets 3h30m'],
    ['absolute', 'CC 5h ██┃▁▁▁▁▁ 25% · resets 15:30'],
    ['both', 'CC 5h ██┃▁▁▁▁▁ 25% · resets 15:30 (in 3h30m)'],
  ]
  for (const [fmt, text] of cases) {
    assert.equal(textsOf({ cfg: cfg({ 'tokenPace.resetFormat': fmt }) })[0], text, fmt)
  }
})

test('a window without a stated reset gets no countdown at all', () => {
  const q = state({ windows: [win({ resetsAt: null })] })
  assert.equal(textsOf({ quotas: [q] })[0], 'CC 5h ██▁▁▁▁▁▁ 25%')
})

test('showAgeInItem: never, only when stale, always', () => {
  const fresh = state({ fetchedAt: Math.floor(NOW / 1000) - 12 * 60 })
  assert.equal(textsOf({ quotas: [fresh], cfg: cfg({ 'tokenPace.showAgeInItem': 'never' }) })[0].includes('$(history)'), false)
  assert.equal(textsOf({ quotas: [fresh], cfg: cfg({ 'tokenPace.showAgeInItem': 'whenStale' }) })[0].includes('$(history)'), false)
  assert.ok(textsOf({ quotas: [fresh], cfg: cfg({ 'tokenPace.showAgeInItem': 'always' }) })[0].endsWith(' $(history) 12m'))
  const never = state({ fetchedAt: null })
  // No fetch time, no age — never "0m old".
  assert.equal(textsOf({ quotas: [never], cfg: cfg({ 'tokenPace.showAgeInItem': 'always' }) })[0].includes('$(history)'), false)
})

test('indicator modes decide glyph and colour independently', () => {
  const ahead = state({ windows: [win({ percent: 45 })] })
  const both = buildItems(input({ quotas: [ahead] }))[0]
  assert.ok(both.text.includes('45% ▲'), both.text)
  assert.equal(both.colorId, 'tokenPace.paceWarn')

  const glyph = buildItems(input({ quotas: [ahead], cfg: cfg({ 'tokenPace.indicator': 'glyph' }) }))[0]
  assert.ok(glyph.text.includes('45% ▲'))
  assert.equal(glyph.colorId, null)

  const colour = buildItems(input({ quotas: [ahead], cfg: cfg({ 'tokenPace.indicator': 'color' }) }))[0]
  assert.equal(colour.text.includes('▲'), false)
  assert.equal(colour.colorId, 'tokenPace.paceWarn')

  const none = buildItems(input({ quotas: [ahead], cfg: cfg({ 'tokenPace.indicator': 'none' }) }))[0]
  assert.equal(none.text.includes('▲'), false)
  assert.equal(none.colorId, null)

  const mono = buildItems(input({ quotas: [ahead], cfg: cfg({ 'tokenPace.colorMode': 'monochrome' }) }))[0]
  assert.equal(mono.colorId, null)
  assert.ok(mono.text.includes('▲'), 'monochrome must keep the glyph as the only pace channel')
})

test('graded levels get the second glyph and the second colour', () => {
  const q = state({ windows: [win({ percent: 80 })] })
  const m = buildItems(input({ quotas: [q], cfg: cfg({ 'tokenPace.pace.levels': 'graded' }) }))[0]
  assert.ok(m.text.includes('80% ▲▲'), m.text)
  assert.equal(m.colorId, 'tokenPace.paceAhead')
})

test('remaining mode flips percent, bar direction and the tooltip header', () => {
  const c = cfg({ 'tokenPace.percentMode': 'remaining' })
  // The fill runs from the right, the clock marker still from the left.
  assert.equal(textsOf({ cfg: c })[0], 'CC 5h ▁▁┃▁▁▁██ 75% · resets 3h30m')
  const tip = quotaTooltip(state(), makeContext(input({ cfg: c })))
  assert.ok(tip.includes('| Window | Remaining | Elapsed | Pace | Resets |'), tip)
})

test('labels can be overridden per provider and per window, and derived ones are clipped', () => {
  const w = win({ id: 'weekly_scoped:10080:fable', shortLabel: 'Fable 7d' })
  const q = state({ windows: [w] })
  const named = textsOf({
    quotas: [q],
    cfg: cfg({ 'tokenPace.labels': { claude: 'Claude', 'weekly_scoped:10080:fable': 'F7' } }),
  })[0]
  assert.ok(named.startsWith('Claude F7 '), named)
  const clipped = textsOf({ quotas: [q], cfg: cfg({ 'tokenPace.labelMaxChars': 5 }) })[0]
  assert.ok(clipped.startsWith('CC Fabl… '), clipped)
})

// ---------------------------------------------------------------------------
// Window selection
// ---------------------------------------------------------------------------

function threeWindows(sessionPercent = 25): QuotaState {
  return state({
    windows: [
      win({ percent: sessionPercent }),
      win({ id: 'weekly_all:10080', kind: 'weekly', label: '7 d', shortLabel: '7d', percent: 69, windowMinutes: 10080, resetsAt: NOW + 6 * 24 * HOUR }),
      win({ id: 'weekly_scoped:10080:fable', kind: 'weekly', label: '7 d · Fable', shortLabel: 'Fable 7d', percent: 12, windowMinutes: 10080, resetsAt: NOW + 6 * 24 * HOUR }),
    ],
  })
}

test('windowSelect: all, leading, worstPace, session, weekly', () => {
  const q = threeWindows()
  const ids = (select: string): string[] =>
    selectWindows(q, cfg({ 'tokenPace.windowSelect': select }), NOW).map((w) => w.id)
  assert.equal(ids('all').length, 3)
  assert.deepEqual(ids('leading'), ['weekly_all:10080'])
  // 25 % against 30 % elapsed is on pace; the weekly window at 69 % against 14 % is not.
  assert.deepEqual(ids('worstPace'), ['weekly_all:10080'])
  assert.deepEqual(ids('session'), ['session:300'])
  assert.deepEqual(ids('weekly'), ['weekly_all:10080', 'weekly_scoped:10080:fable'])
})

test('windowSelect: a filter that would empty the bar falls back to every window', () => {
  const q = state({ windows: [win({ id: 'codex:10080', kind: 'weekly', shortLabel: '7d' })] })
  assert.equal(selectWindows(q, cfg({ 'tokenPace.windowSelect': 'session' }), NOW).length, 1)
})

test('windowSelect auto: the week appears only while every session window is quiet', () => {
  const quiet = threeWindows(25)
  const busy = threeWindows(55)
  const c = cfg({ 'tokenPace.windowSelect': 'auto' })
  assert.equal(selectWindows(quiet, c, NOW).length, 3)
  assert.deepEqual(selectWindows(busy, c, NOW).map((w) => w.id), ['session:300'])
  assert.ok(autoExplain(quiet, c)?.startsWith('auto: showing every window'))
  assert.ok(autoExplain(busy, c)?.startsWith('auto: showing session windows only'))
  assert.equal(autoExplain(quiet, cfg()), null)
  // The rule is explained where the user can read it.
  const tip = quotaTooltip(busy, makeContext(input({ quotas: [busy], cfg: c })))
  assert.ok(tip.includes('auto: showing session windows only'), tip)
})

// ---------------------------------------------------------------------------
// Tooltips
// ---------------------------------------------------------------------------

const FORECAST: Forecast = {
  state: 'eta', ratePerHour: 20, etaMs: NOW + 40 * 60_000, endPercent: 95,
  sustainablePerHour: 4, confidence: 'high', basis: { samples: 7, spanMs: 2 * HOUR },
  text: '~empty in 40 min (12:40) · high confidence',
}

test('the tooltip carries the forecast, the lockout time, the basis and the sustainable rate', () => {
  const tip = quotaTooltip(state(), makeContext(input({
    forecasts: new Map([['claude:session:300', FORECAST]]),
  })))
  assert.ok(tip.includes('$(graph) 5h: ~empty in 40 min'), tip)
  assert.ok(tip.includes('locks 12:40'), tip)
  assert.ok(tip.includes('based on 7 readings over 2 h'), tip)
  assert.ok(tip.includes('allowed 4.0 %/h'), tip)
  // Every projection is marked as an estimate.
  assert.ok(tip.includes('~empty'))
})

test('the tooltip title links the official usage page unless the setting says otherwise', () => {
  const linked = quotaTooltip(state(), makeContext(input()))
  assert.ok(linked.startsWith('**[Claude Code](https://claude.ai/settings/usage)** · plan `max20`'), linked)
  const plain = quotaTooltip(state(), makeContext(input({ cfg: cfg({ 'tokenPace.usagePageLinks': false }) })))
  assert.ok(plain.startsWith('**Claude Code** · plan `max20`'), plain)
  const codex = quotaTooltip(state({ source: 'codex' }), makeContext(input()))
  assert.ok(codex.includes('https://chatgpt.com/codex/settings/usage'), codex)
})

test('the freshness line names age and origin, and marks a stale reading', () => {
  const fresh = quotaTooltip(state({ origin: 'cache', fetchedAt: Math.floor(NOW / 1000) - 180 }), makeContext(input()))
  assert.ok(fresh.includes('Updated 3 min ago · cache file'), fresh)
  const old = quotaTooltip(state({ origin: 'statusline', fetchedAt: Math.floor(NOW / 1000) - 3600 }), makeContext(input()))
  assert.ok(old.includes('Updated 1 h ago · status line · $(warning) **stale**'), old)
})

test('footer links are plain text wherever they would do nothing', () => {
  const live = footerLine(makeContext(input()))
  assert.ok(live.includes('$(sync) [Fetch now](command:tokenPace.refreshQuota)'), live)
  for (const blocked of [
    input({ consent: 'denied' }),
    input({ cfg: cfg({ 'tokenPace.quotaSource': 'cache' }) }),
    input({ role: 'follower' }),
  ]) {
    const line = footerLine(makeContext(blocked))
    assert.ok(line.includes('$(sync) Fetch now'), line)
    assert.equal(line.includes('command:tokenPace.refreshQuota'), false)
    // The other four keep working in every state.
    assert.ok(line.includes('[Re-read](command:tokenPace.rescan)'))
    assert.ok(line.includes('[Settings](command:tokenPace.openSettings)'))
    assert.ok(line.includes('[Dashboard](command:tokenPace.showDashboard)'))
  }
})

test('a follower says who owns the data; a running scan says the figures are still growing', () => {
  const follower = quotaTooltip(state(), makeContext(input({ role: 'follower' })))
  assert.ok(follower.includes('another window polls and writes the data'), follower)
  const scanning = buildItems(input({ scanning: true })).find((m) => m.id === 'tokenPace.tokens')
  assert.equal(scanning?.text, '$(sync~spin) reading history …')
  assert.ok(scanning?.tooltipMarkdown.includes('reading history'))
})

test('tooltip modes: compact stays within twelve lines, off yields nothing', () => {
  const q = threeWindows()
  const compact = quotaTooltip(q, makeContext(input({ quotas: [q], cfg: cfg({ 'tokenPace.tooltip': 'compact' }) })))
  assert.ok(compact.split('\n').length <= 12, `compact tooltip has ${compact.split('\n').length} lines`)
  assert.ok(compact.includes('| Window |'))
  assert.ok(compact.includes('Updated'))
  assert.ok(compact.includes('[Settings](command:tokenPace.openSettings)'))
  // The explanations are the only thing compact drops besides the tables.
  assert.equal(compact.includes('“Elapsed” is how much'), false)

  assert.equal(quotaTooltip(q, makeContext(input({ cfg: cfg({ 'tokenPace.tooltip': 'off' }) }))), '')
  assert.equal(buildItems(input({ cfg: cfg({ 'tokenPace.tooltip': 'off' }) }))[0].tooltipMarkdown, '')
})

test('explanations can be switched off without losing the provenance line or the markers', () => {
  const off = quotaTooltip(state(), makeContext(input({ cfg: cfg({ 'tokenPace.tooltipExplanations': false }) })))
  assert.equal(off.includes('“Elapsed” is how much'), false)
  assert.ok(off.includes('_measured: quota, tokens · estimated: ~API cost_'), off)
  const on = quotaTooltip(state(), makeContext(input({ cfg: cfg({ 'tokenPace.tooltipExplanations': true }) })))
  assert.ok(on.includes('“Elapsed” is how much'))
  assert.ok(on.includes('_measured: quota, tokens · estimated: ~API cost_'))
  // The shipped default is off: the same tooltip without any cfg carries no explanation paragraph.
  const byDefault = quotaTooltip(state(), makeContext(input()))
  assert.equal(byDefault.includes('“Elapsed” is how much'), false, byDefault)
  assert.ok(byDefault.includes('_measured: quota, tokens · estimated: ~API cost_'), byDefault)
})

test('the Codex request column is explained as token_count events', () => {
  const c = cfg({ 'tokenPace.tooltipExplanations': true })
  const codex = quotaTooltip(state({ source: 'codex' }), makeContext(input({ cfg: c })))
  assert.ok(codex.includes('`token_count` events'), codex)
})

// ---------------------------------------------------------------------------
// Token and cost items
// ---------------------------------------------------------------------------

test('the token item follows summary.period and summary.scope', () => {
  const today = buildItems(input()).find((m) => m.id === 'tokenPace.tokens')
  // Both providers, 1.41M billable each (fresh input + cache write + output).
  assert.equal(today?.text, 'Σ 3.4M · today')
  const week = buildItems(input({
    cfg: cfg({ 'tokenPace.summary.period': '7d', 'tokenPace.summary.scope': 'claude' }),
  })).find((m) => m.id === 'tokenPace.tokens')
  assert.equal(week?.text, 'Σ 1.7M · 7d')
  assert.equal(week?.name, 'Token Pace — tokens (7 days)')
})

test('cost is an estimate, zero is a dash, unpriced tokens carry a warning', () => {
  const withCost = cfg({ 'tokenPace.statusBar.show': ['claudeQuota', 'tokens', 'cost'] })
  const cost = buildItems(input({ cfg: withCost })).find((m) => m.id === 'tokenPace.cost')
  assert.equal(cost?.text, '~$2.46 · today')

  const free: UsageSource = {
    ...fakeAgg(),
    cost: () => ({
      usd: 0, listUsd: 0, unpricedTokens: 4_000, unpricedModels: ['mystery-1'],
      fastUnpricedTokens: 0, familyPriced: [], custom: false,
    }),
  }
  const dash = buildItems(input({ cfg: withCost, agg: free })).find((m) => m.id === 'tokenPace.cost')
  assert.equal(dash?.text, '– ⚠ · today')
})

test('custom rates are named in the cost tooltip', () => {
  const c = cfg({ 'tokenPace.pricing.multiplier': 0.8, 'tokenPace.tooltipExplanations': true })
  const tip = tokenTooltip(makeContext(input({ cfg: c })), 'cost')
  assert.ok(tip.includes('at your configured rates'), tip)
})

test('the tooltip surfaces the fields nothing else shows', () => {
  const tip = tokenTooltip(makeContext(input()), 'tokens')
  assert.ok(tip.includes('cache write 300K (1 h 40K)'), tip)
  assert.ok(tip.includes('reasoning 45K'), tip)
  assert.ok(tip.includes('cache hit 91 %'), tip)
})

test('nothing measured is a dash, in the status bar and in the tooltip; a request count is not', () => {
  const empty: UsageSource = {
    sum: () => emptyBucket('claude', 'claude-opus-4-6', false, 'standard', 'd', null, '2026-09-03'),
    cost: () => ({
      usd: 0, listUsd: 0, unpricedTokens: 0, unpricedModels: [], fastUnpricedTokens: 0,
      familyPriced: [], custom: false,
    }),
  }
  const show = cfg({ 'tokenPace.statusBar.show': ['tokens', 'cost'] })
  const items = buildItems(input({ agg: empty, cfg: show }))
  // '0' would claim a measurement — the same rule stats.ts applies to the identical figure.
  assert.equal(items.find((m) => m.id === 'tokenPace.tokens')?.text, 'Σ – · today')
  assert.equal(items.find((m) => m.id === 'tokenPace.cost')?.text, '– · today')
  const tip = tokenTooltip(makeContext(input({ agg: empty })), 'tokens')
  // Token columns dash; the request column keeps its literal count of nothing.
  assert.ok(tip.includes('| today | – | – | – | 0 |'), tip)
  assert.ok(tip.includes('today: fresh – · cache write – · cache read – · output – · reasoning –'), tip)
  const compactTip = tokenTooltip(makeContext(input({
    agg: empty, cfg: cfg({ 'tokenPace.tooltip': 'compact' }),
  })), 'tokens')
  assert.ok(compactTip.includes('Claude Code: – usage · – output · 0 req.'), compactTip)
})

test('the usage column is explained by the formula it actually uses', () => {
  const c = cfg({ 'tokenPace.tooltipExplanations': true })
  const tip = tokenTooltip(makeContext(input({ cfg: c })), 'tokens')
  assert.ok(tip.includes('“Usage” is fresh input + cache write + output'), tip)
})

// ---------------------------------------------------------------------------
// Order, click action, preview, invariants
// ---------------------------------------------------------------------------

test('statusBar.show decides which entries exist and in which order', () => {
  const items = buildItems(input({
    quotas: [state(), state({ source: 'codex', windows: [win({ id: 'codex:300', shortLabel: '5h' })] })],
    cfg: cfg({ 'tokenPace.statusBar.show': ['tokens', 'codexQuota', 'claudeQuota'] }),
  }))
  assert.deepEqual(items.map((m) => m.id), [
    'tokenPace.tokens', 'tokenPace.quota.codex.codex.300', 'tokenPace.quota.claude.session.300',
  ])
  assert.deepEqual(items.map((m) => m.priorityKey), ['1000', '999', '998'])
})

test('clickAction picks the command; openWebsite passes the provider as an argument', () => {
  const of = (action: string) => buildItems(input({ cfg: cfg({ 'tokenPace.clickAction': action }) }))[0]
  assert.equal(of('menu').command, 'tokenPace.menu')
  assert.equal(of('dashboard').command, 'tokenPace.showDashboard')
  assert.equal(of('refresh').command, 'tokenPace.refreshQuota')
  const web = of('openWebsite')
  assert.equal(web.command, 'tokenPace.openUsagePage')
  assert.deepEqual(web.commandArgs, ['claude'])
})

test('the preview lives in its own id space and marks every item', () => {
  const items = previewItems(cfg(), NOW)
  assert.ok(items.length >= 20, `only ${items.length} preview items`)
  for (const m of items) {
    assert.ok(m.id.startsWith('tokenPace.preview.'), m.id)
    assert.ok(m.text.startsWith('[preview] '), m.text)
    assert.ok(m.name.startsWith('[preview] '), m.name)
    // One click ends the preview, whichever item it lands on.
    assert.equal(m.command, 'tokenPace.previewStatusBar')
  }
  assert.ok(items.some((m) => m.alarm), 'the alarm state must be previewable')
  assert.ok(items.some((m) => m.text.includes('∞')))
  assert.ok(items.some((m) => m.text.includes('reset due')))
  assert.ok(items.some((m) => m.text.includes('$(key)')))
})

test('no item ever renders NaN, undefined or a made-up zero', () => {
  const broken = state({
    fetchedAt: null, planType: null, origin: undefined,
    windows: [win({ percent: Number.NaN, resetsAt: null, windowMinutes: null })],
  })
  const items = buildItems(input({
    quotas: [broken],
    cfg: cfg({ 'tokenPace.statusBar.show': ['claudeQuota', 'extra', 'tokens', 'cost', 'forecast'] }),
  }))
  const all = items.map((m) => `${m.text}\n${m.tooltipMarkdown}`).join('\n')
  assert.equal(/NaN|undefined|Infinity/.test(all), false, all)
  assert.ok(items[0].text.includes('–'), items[0].text)
  for (const m of previewItems(cfg(), NOW)) {
    assert.equal(/NaN|undefined|Infinity/.test(`${m.text}\n${m.tooltipMarkdown}`), false, m.text)
  }
})

// ---------------------------------------------------------------------------
// Dashboard push protocol
//
// `dashboard.ts` is the only module here that imports `vscode`; the test bundle marks that
// import external, so the module is required lazily behind a stub. It lives in this file
// because the fragment protocol decides what the status bar's dashboard actually shows.
// ---------------------------------------------------------------------------

/** The slice of the `vscode` API the two vscode-facing modules below actually touch. */
const VSCODE_STUB: any = {
  commands: { executeCommand: () => undefined },
  window: { showQuickPick: async () => undefined },
  QuickPickItemKind: { Separator: -1 },
}

function stubVscode(): void {
  const mod = require('node:module')
  if (mod._load.stubbed) return
  const original = mod._load
  const load = function (this: unknown, request: string, parent: unknown, isMain: boolean): unknown {
    if (request === 'vscode') return VSCODE_STUB
    return original.call(this, request, parent, isMain)
  }
  load.stubbed = true
  mod._load = load
}

function loadDashboard(): typeof import('../src/dashboard') {
  stubVscode()
  return require('../src/dashboard')
}

function loadStatusBar(): typeof import('../src/statusbar') {
  stubVscode()
  return require('../src/statusbar')
}

function fakeView(posted: unknown[]): any {
  return {
    visible: true,
    webview: {
      options: {},
      html: '',
      onDidReceiveMessage: () => ({ dispose: () => undefined }),
      postMessage: (m: unknown) => { posted.push(m); return Promise.resolve(true) },
    },
    onDidChangeVisibility: () => ({ dispose: () => undefined }),
    onDidDispose: () => ({ dispose: () => undefined }),
    show: () => undefined,
  }
}

test('a change to sections or showCost re-renders the whole dashboard, not one fragment', () => {
  const { DashboardProvider } = loadDashboard()
  const vm = (over: Record<string, unknown>): ViewModel => ({
    sections: ['summary', 'tokens'], showCost: true, digest: [], ...over,
  } as unknown as ViewModel)

  const posted: unknown[] = []
  const p = new DashboardProvider(() => undefined)
  p.update(vm({}))
  p.resolveWebviewView(fakeView(posted))
  assert.deepEqual(posted.map((m: any) => m.type), ['data'])

  // A section's own payload still travels as a fragment.
  posted.length = 0
  p.update(vm({ digest: ['something new'] }))
  assert.deepEqual(posted.map((m: any) => m.type), ['section'])

  // Layout fields are in no fragment, so they have to force a full push.
  posted.length = 0
  p.update(vm({ digest: ['something new'], sections: ['summary', 'tokens', 'history'] }))
  assert.deepEqual(posted.map((m: any) => m.type), ['data'])
  assert.deepEqual((posted[0] as any).payload.sections, ['summary', 'tokens', 'history'])

  posted.length = 0
  p.update(vm({ digest: ['something new'], sections: ['summary', 'tokens', 'history'], showCost: false }))
  assert.deepEqual(posted.map((m: any) => m.type), ['data'])
  assert.equal((posted[0] as any).payload.showCost, false)
})

test('the token item names its period even when the period is today', () => {
  for (const [period, suffix] of [['today', '· today'], ['7d', '· 7d'], ['30d', '· 30d']]) {
    const m = buildItems(input({ cfg: cfg({ 'tokenPace.summary.period': period }) }))
      .find((x) => x.id === 'tokenPace.tokens')
    assert.ok(m?.text.endsWith(suffix), `${period}: ${m?.text}`)
  }
})

test('with the explanations off the tooltip keeps everything that is a measurement', () => {
  const c = cfg({ 'tokenPace.tooltipExplanations': false })
  const tip = quotaTooltip(state(), makeContext(input({
    cfg: c, forecasts: new Map([['claude:session:300', FORECAST]]),
  })))
  assert.equal(tip.includes('“Elapsed” is how much'), false, tip)
  assert.equal(tip.includes('“Usage” is fresh input'), false, tip)
  assert.equal(tip.includes('API cost is hypothetical'), false, tip)
  // The table, the forecast, the token tables, the provenance line and the actions stay.
  assert.ok(tip.includes('| Window | Used | Elapsed | Pace | Resets |'), tip)
  assert.ok(tip.includes('$(graph) 5h: ~empty in 40 min'), tip)
  assert.ok(tip.includes('| Period | Usage | Output | Cache read | Req. | API cost |'), tip)
  assert.ok(tip.includes('_measured: quota, tokens · estimated: ~API cost_'), tip)
  assert.ok(tip.includes('[Dashboard](command:tokenPace.showDashboard)'), tip)
  assert.ok(tip.includes('[Fetch now](command:tokenPace.refreshQuota)'), tip)
})

// ---------------------------------------------------------------------------
// The QuickPick menu
// ---------------------------------------------------------------------------

async function menuItems(over: Record<string, unknown> = {}): Promise<any[]> {
  const { showMenu } = loadStatusBar()
  let captured: any[] = []
  const previous = VSCODE_STUB.window.showQuickPick
  VSCODE_STUB.window.showQuickPick = async (list: any[]) => { captured = list; return undefined }
  try {
    await showMenu(
      { role: 'single', consent: 'granted', cfg: cfg(over), quotas: [state()] },
      async () => undefined,
    )
  } finally {
    VSCODE_STUB.window.showQuickPick = previous
  }
  return captured
}

test('the menu offers the markdown view directly under the dashboard', async () => {
  const items = await menuItems()
  assert.equal(items[0].command, 'tokenPace.showDashboard')
  assert.equal(items[1].label, '$(markdown) Show Usage as Text (Markdown)')
  assert.equal(items[1].command, 'tokenPace.showUsageMarkdown')
  assert.equal(items[2].command, 'tokenPace.showUsageQuickPick')
  // Every entry that runs something runs one of this extension's own commands.
  for (const it of items) {
    if (it.command !== undefined) assert.ok(String(it.command).startsWith('tokenPace.'), it.command)
  }
})

test('the menu keeps a fetch it cannot perform, and says why', async () => {
  const blocked = await menuItems({ 'tokenPace.quotaSource': 'cache' })
  const fetch = blocked.find((i) => i.command === 'tokenPace.refreshQuota')
  assert.ok(fetch, 'the fetch entry must stay in the list')
  assert.ok(String(fetch.label).startsWith('$(circle-slash)'), fetch.label)
  assert.ok(String(fetch.detail).includes('nothing is fetched over the network'), fetch.detail)
})
