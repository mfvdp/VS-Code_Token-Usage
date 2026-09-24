// SPDX-FileCopyrightText: 2026 Frederik Marx
// SPDX-License-Identifier: AGPL-3.0-or-later

import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { setBundle, setLocale } from '../src/i18n'
import { relativeShort } from '../src/time'
import { ROOT } from './helpers/nls'
import { readStatuslineMirror } from '../src/quota'
import { LEAK_SESSION_ID, LEAK_STATUS_SECRETS, scratchDir, writeLeakyMirror } from './fixtures/helpers'
import type { BudgetRow } from '../src/budget'
import { Config, sanitize } from '../src/config'
import { RUNNING_WINDOW_MS, RunningItem } from '../src/agentTree'
import {
  AGENTS_TOOLTIP_ITEMS, AgentsReading, autoExplain, buildItems, footerLine, ItemModel, itemModel, makeContext, previewItems, problemText,
  problemTooltip, problemView, quotaTooltip, selectWindows, StatusTextInput, summaryTooltip, tokenTooltip, UsageSource,
} from '../src/statusText'
import { CACHE_WATCH_MAX, CacheWatchEntry, cachePhase, watchCaches } from '../src/cacheWatch'
import { addCacheSession, buildAgg } from './fixtures/viewFixtures'
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

test('a limit-reached window whose reset has passed says "reset due" once, never "resets reset due"', () => {
  // exhausted / limitReached outrank resetDue as the display, so the countdown — which reads
  // "reset due" for a time in the past — is printed next to the state word; it must not be
  // hung behind "resets" like a duration would be.
  for (const w of [
    win({ percent: 100, limitReached: true, resetsAt: NOW - 5 * 60_000 }),
    win({ percent: 100, resetsAt: NOW - 5 * 60_000 }),
  ]) {
    const text = textsOf({ quotas: [state({ windows: [w] })] })[0]
    assert.ok(text.includes('· reset due'), text)
    assert.ok(!text.includes('resets reset'), text)
    assert.equal(text.split('reset due').length, 2, text)
  }
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
  const row = tip.split('\n').find((l) => l.startsWith('| `5 h` |')) ?? ''
  // The Pace column carries it, so the value column does not repeat it.
  assert.equal(row.split('exhausted').length - 1, 1, row)
  // Where the verdict says something else, the value keeps the word.
  const stop = state({ windows: [win({ percent: Number.NaN, limitReached: true })] })
  const stopRow = quotaTooltip(stop, makeContext(input({ quotas: [stop] })))
    .split('\n').find((l) => l.startsWith('| `5 h` |')) ?? ''
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
    // A clock time takes a different preposition from a countdown, so it is a second
    // message — one English message can only ever carry one translation.
    ['absolute', 'CC 5h ██┃▁▁▁▁▁ 25% · resets at 15:30'],
    ['both', 'CC 5h ██┃▁▁▁▁▁ 25% · resets at 15:30 (in 3h30m)'],
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

test('the tooltip carries the forecast, the lockout time and the basis, but no sustainable rate', () => {
  const tip = quotaTooltip(state(), makeContext(input({
    forecasts: new Map([['claude:session:300', FORECAST]]),
  })))
  assert.ok(tip.includes('$(graph) `5h`: ~empty in 40 min'), tip)
  assert.ok(tip.includes('locks 12:40'), tip)
  assert.ok(tip.includes('based on 7 readings over 2 h'), tip)
  // The "allowed x %/h" rate went with the dashboard's "keeps it to the reset" line.
  assert.equal(/allowed|%\/h/.test(tip), false, tip)
  // Every projection is marked as an estimate.
  assert.ok(tip.includes('~empty'))
})

test('the tooltip prints no measuring sentence: a dash in the pace column, no forecast line', () => {
  const measuring: Forecast = {
    state: 'measuring', ratePerHour: null, etaMs: null, endPercent: null, sustainablePerHour: 20,
    confidence: null, basis: { samples: 1, spanMs: 0 }, text: 'measuring · 1 reading over 0 min',
  }
  // Thirty seconds into a five-hour window: the verdict measures as well as the forecast.
  const fresh = state({ windows: [win({ percent: 2, resetsAt: NOW + 5 * HOUR - 30_000 })] })
  const tip = quotaTooltip(fresh, makeContext(input({
    forecasts: new Map([['claude:session:300', measuring]]),
  })))
  assert.equal(/measuring|reading over/.test(tip), false, tip)
  assert.ok(tip.includes('| 0 % | – |'), tip)
  // The freshness line and the official page stay where they were.
  assert.ok(tip.includes('Updated '), tip)
  assert.ok(tip.startsWith('**[Claude Code](https://claude.ai/settings/usage)**'), tip)
  // A forecast that measures under a verdict that does not is still not a line.
  const paced = quotaTooltip(state(), makeContext(input({
    forecasts: new Map([['claude:session:300', measuring]]),
  })))
  assert.equal(/measuring|reading over|\$\(graph\)/.test(paced), false, paced)
})

test('a young window heavy with usage is coloured, not excused as measuring', () => {
  // Half a minute into a five-hour window, 60 % of it already spent. Item colour, glyph and
  // the tooltip's pace column all come from the one verdict, so they say the same thing.
  const young = state({ windows: [win({ percent: 60, resetsAt: NOW + 5 * HOUR - 30_000 })] })
  const m = buildItems(input({ quotas: [young] }))[0]
  assert.equal(m.colorId, 'tokenPace.paceWarn')
  assert.ok(m.text.includes('60% ▲'), m.text)
  assert.ok(quotaTooltip(young, makeContext(input())).includes('| 0 % | 60 % ahead of pace |'))
  // The same young window with a small bill keeps the benefit of the doubt: green, no glyph,
  // and the absence marker where the sentence would be.
  const quiet = state({ windows: [win({ percent: 6, resetsAt: NOW + 5 * HOUR - 30_000 })] })
  const q = buildItems(input({ quotas: [quiet] }))[0]
  assert.equal(q.colorId, 'tokenPace.paceOk')
  assert.equal(q.text.includes('▲'), false, q.text)
  assert.ok(quotaTooltip(quiet, makeContext(input())).includes('| 0 % | – |'))
})

test('the tooltip title links the official usage page unless the setting says otherwise', () => {
  const linked = quotaTooltip(state(), makeContext(input()))
  assert.ok(linked.startsWith('**[Claude Code](https://claude.ai/settings/usage)** · plan `max20`'), linked)
  const plain = quotaTooltip(state(), makeContext(input({ cfg: cfg({ 'tokenPace.usagePageLinks': false }) })))
  assert.ok(plain.startsWith('**Claude Code** · plan `max20`'), plain)
  const codex = quotaTooltip(state({ source: 'codex' }), makeContext(input()))
  assert.match(codex, /https:\/\/chatgpt\.com\/codex\/settings\/usage(?![\w./-])/, codex)
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
  // 1.8 A7: what StatusBar.update touches besides the window's createStatusBarItem (barStub below). Here
  // from the start, because the bundle's module object sees only the keys its first require found.
  StatusBarAlignment: { Left: 1, Right: 2 },
  ThemeColor: class { constructor(readonly id: string) {} },
  MarkdownString: class { isTrusted: unknown = false; supportThemeIcons = false; supportHtml = false; constructor(public value = '') {} },
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

test('a sort or a fold does not replace the tokens body under the reader', () => {
  // The tokens section follows one field of the UI state — the cache switch above its
  // composition bars. It used to follow the whole of it, so every sort, drill and fold
  // replaced its tables and threw away how far they had been scrolled sideways.
  const { DashboardProvider } = loadDashboard()
  const ui = (over: Record<string, unknown>): Record<string, unknown> => ({
    providers: ['claude', 'codex'], models: [], collapsed: [], compositionCache: 'all',
    sort: { key: 'usage', dir: 'desc' }, ...over,
  })
  const vm = (over: Record<string, unknown>): ViewModel => ({
    sections: ['tokens'], showCost: true, totals: [], composition: [], cacheEconomy: [],
    calendar: null, planFactor: [], ui: ui({}), ...over,
  } as unknown as ViewModel)

  const posted: unknown[] = []
  const p = new DashboardProvider(() => undefined)
  p.update(vm({}))
  p.resolveWebviewView(fakeView(posted))
  const keys = (): string[] => posted.filter((m: any) => m.type === 'section').map((m: any) => m.key)

  posted.length = 0
  p.update(vm({ ui: ui({ sort: { key: 'cost', dir: 'asc' }, collapsed: ['chart'] }) }))
  assert.equal(keys().includes('tokens'), false, JSON.stringify(keys()))
  // The switch itself still reaches it — and the fragment carries the whole UI state, or the
  // page would lose the providers the provider switch stored and its model filter with the
  // assignment.
  posted.length = 0
  p.update(vm({ ui: ui({ compositionCache: 'noCache' }) }))
  // The filter bar follows the whole UI state and redraws with it; the tokens body follows
  // this one switch, and it is what the switch is for.
  assert.deepEqual(keys().sort(), ['controls', 'tokens'])
  const fragment = posted.find((m: any) => m.type === 'section' && m.key === 'tokens') as any
  assert.deepEqual(fragment.payload.ui.providers, ['claude', 'codex'])
  assert.equal(fragment.payload.ui.compositionCache, 'noCache')
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
  assert.ok(tip.includes('$(graph) `5h`: ~empty in 40 min'), tip)
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

// ---------------------------------------------------------------------------
// Context window entry
// ---------------------------------------------------------------------------

const CONTEXT = { used: 128_000, size: 200_000, usedPct: 64, fetchedAt: Math.floor(NOW / 1000) - 120 }

test('the context entry appears only when it is asked for and a reading exists', () => {
  const on = cfg({ 'tokenPace.statusBar.show': ['context'] })
  assert.deepEqual(textsOf({ cfg: on, context: CONTEXT }), ['ctx 64%'])
  // No reading, no entry: there is no second way to learn a context window, so nothing is
  // shown rather than a dash that suggests one could be fetched.
  assert.deepEqual(textsOf({ cfg: on, context: null }), [])
  assert.deepEqual(textsOf({ cfg: on }), [])
  // Off by default.
  assert.equal(textsOf({ context: CONTEXT }).some((t) => t.startsWith('ctx')), false)
})

test('the context entry shows tokens when the payload named no window size', () => {
  const on = cfg({ 'tokenPace.statusBar.show': ['context'] })
  const [text] = textsOf({ cfg: on, context: { ...CONTEXT, size: null, usedPct: null } })
  assert.equal(text, 'ctx 128K')
  // A percentage with nothing to be a share of is exactly what this entry may not print.
  assert.equal(text.includes('%'), false)
})

test('a stale context reading carries its age, a fresh one does not', () => {
  const on = cfg({ 'tokenPace.statusBar.show': ['context'] })
  const old = { ...CONTEXT, fetchedAt: Math.floor(NOW / 1000) - 90 * 60 }
  assert.deepEqual(textsOf({ cfg: on, context: old }), ['ctx 64% $(history) 2h'])
  assert.deepEqual(textsOf({ cfg: on, context: CONTEXT }), ['ctx 64%'])
})

test('the context tooltip says whose window it is and never calls it a quota', () => {
  const on = cfg({ 'tokenPace.statusBar.show': ['context'] })
  const tip = buildItems(input({ cfg: on, context: CONTEXT }))[0].tooltipMarkdown
  assert.ok(tip.includes('**Context window**'), tip)
  assert.ok(tip.includes('128,000 of 200,000 tokens · 64 %'), tip)
  assert.ok(tip.includes('current session, via the status line'), tip)
  assert.ok(tip.includes('not an account figure'), tip)
  assert.ok(tip.includes('Status line updated 2 min ago'), tip)
})

test('a configured plan name reaches the tooltip title, marked as configured', () => {
  const configured = cfg({ 'tokenPace.planName': { claude: 'Max 20x' } })
  const tip = quotaTooltip(state({ planType: null }), makeContext(input({ cfg: configured })))
  assert.ok(tip.startsWith('**[Claude Code](https://claude.ai/settings/usage)** · plan `Max 20x` (as configured)'), tip)
  // What the provider itself said needs no such qualifier — and still wins over the setting.
  const stated = quotaTooltip(state(), makeContext(input({ cfg: configured })))
  assert.ok(stated.includes('· plan `max20`'), stated)
  assert.equal(stated.includes('as configured'), false, stated)
})

test('a plan name never reaches the tooltip as markup', () => {
  // The tooltip is a trusted MarkdownString with HTML enabled, and the name is a provider
  // field or a settings string — so it is printed inside a code span, the same way every
  // other borrowed string in this file is, and cannot bold or link anything around it.
  const shouty = cfg({ 'tokenPace.planName': { claude: '**[x](http://e.example)**' } })
  const tip = quotaTooltip(state({ planType: null }), makeContext(input({ cfg: shouty })))
  assert.ok(tip.includes('plan `**[x](http://e.example)**` (as configured)'), tip)
})

test('a backtick in the plan name cannot close the code span it is printed in', () => {
  // The reported defect: `tokenPace.planName` is printed inside a code span, so a name that
  // contains a backtick ended the span and the rest of the tooltip — the windows, the ages,
  // the footnotes — was rendered as the user's own markup. `sanitize` now takes backticks
  // and control characters out of the name, so the span the tooltip opens is the span it
  // closes.
  const ticked = cfg({ 'tokenPace.planName': { claude: 'Max `20x` **bold**' } })
  const tip = quotaTooltip(state({ planType: null }), makeContext(input({ cfg: ticked })))
  assert.ok(tip.includes('plan `Max 20x **bold**` (as configured)'), tip)
  assert.equal((tip.match(/`/g) ?? []).length % 2, 0, tip)
  // A name spanning two lines would break the tooltip's row layout just as thoroughly.
  const wrapped = cfg({ 'tokenPace.planName': { claude: 'Max\n20x' } })
  const two = quotaTooltip(state({ planType: null }), makeContext(input({ cfg: wrapped })))
  assert.ok(two.includes('plan `Max 20x` (as configured)'), two)
})

test('the preview shows both context shapes and neither invents a share', () => {
  const texts = previewItems(cfg({}), NOW).map((m) => m.text).filter((t) => t.includes('ctx '))
  assert.deepEqual(texts, ['[preview] ctx 64%', '[preview] ctx 128K'])
})

// ---------------------------------------------------------------------------
// Budget entry
// ---------------------------------------------------------------------------

function budget(over: Partial<BudgetRow> = {}): BudgetRow {
  return {
    key: 'total:month:usd', identity: 'budget:total:month:usd:2026-09-01',
    label: 'All providers · this month', scope: 'total', period: 'month', unit: 'usd',
    from: '2026-09-01', to: '2026-09-03', last: '2026-09-30',
    limit: 200, limitText: '$200.00', used: 84, usedText: '~$84.00',
    share: 42, shareText: '42 %', over: false, partial: false, covered: true,
    projected: null, projectedText: null, projectionBasis: null, projectedOver: false,
    unmeasurable: null,
    text: 'All providers · this month: ~$84.00 of $200.00 · 42 %', ...over,
  }
}

test('the budget entry appears only when it is asked for and a budget exists', () => {
  const on = cfg({ 'tokenPace.statusBar.show': ['budget'] })
  assert.deepEqual(textsOf({ cfg: on, budgets: [budget()] }), ['budget ~42 %'])
  // Nobody stated a limit, so there is nothing to be a share of — and no entry at all.
  assert.deepEqual(textsOf({ cfg: on, budgets: [] }), [])
  assert.deepEqual(textsOf({ cfg: on }), [])
  // Off by default.
  assert.equal(textsOf({ budgets: [budget()] }).some((t) => t.startsWith('budget')), false)
})

test('the bar shows the budget closest to its own limit, comparing shares and never values', () => {
  const on = cfg({ 'tokenPace.statusBar.show': ['budget'] })
  const money = budget({ share: 42, shareText: '42 %' })
  // Far more tokens than dollars, and a much smaller share of the user's own limit: the
  // raw numbers are of two different kinds and may not decide which one is shown.
  const tokens = budget({
    key: 'claude:day:tokens', unit: 'tokens', label: 'Claude Code · today',
    limit: 5_000_000, limitText: '5M', used: 400_000, usedText: '400K',
    share: 8, shareText: '8 %', text: 'Claude Code · today: 400K of 5M · 8 %',
  })
  assert.deepEqual(textsOf({ cfg: on, budgets: [tokens, money] }), ['budget ~42 %'])
  // A token budget keeps its plain share: only a hypothetical amount carries the marker.
  assert.deepEqual(textsOf({ cfg: on, budgets: [tokens] }), ['budget 8 %'])
})

test('a budget over its own limit says so, and one with no data at all shows a dash', () => {
  const on = cfg({ 'tokenPace.statusBar.show': ['budget'] })
  assert.deepEqual(
    textsOf({ cfg: on, budgets: [budget({ share: 118, shareText: '118 %', over: true })] }),
    ['budget ~118 % over'],
  )
  // Never "0 %": an unread period is not a quiet one, so a row without a share cannot win
  // the comparison — and a lone row without one prints the dash rather than a number.
  assert.deepEqual(textsOf({ cfg: on, budgets: [budget({ share: null, shareText: '–', covered: false })] }), [])
  assert.equal(
    itemModel({ kind: 'budget', b: budget({ share: null, shareText: '–', covered: false }) },
      makeContext(input({ cfg: on }))).text,
    'budget –',
  )
})

test('the budget tooltip lists every budget and says what a dollar figure is not', () => {
  const on = cfg({ 'tokenPace.statusBar.show': ['budget'] })
  const rows = [budget({ partial: true }), budget({ key: 'claude:day:tokens', label: 'Daily cap' })]
  const tip = buildItems(input({ cfg: on, budgets: rows }))[0].tooltipMarkdown
  assert.ok(tip.includes('**Budgets**'), tip)
  for (const r of rows) assert.ok(tip.includes(r.text), r.text)
  assert.ok(tip.includes('not a bill'), tip)
  assert.ok(tip.includes('lower bound'), tip)
  // A budget is not a quota: nothing here may name a window, a plan or a reset.
  assert.equal(/\b(quota|plan|reset)\b/.test(tip), false, tip)
})

test('the preview shows a budget under and over its limit, and colours neither', () => {
  const items = previewItems(cfg({}), NOW).filter((m) => m.text.includes('budget '))
  assert.deepEqual(items.map((m) => m.text), ['[preview] budget ~38 %', '[preview] budget ~118 % over'])
  for (const m of items) {
    assert.equal(m.colorId, null)
    assert.equal(m.alarm, false)
  }
})

// ---------------------------------------------------------------------------
// Prompt-cache row
// ---------------------------------------------------------------------------

const CACHE = {
  warm: true, ttl: '5m' as const, expiresAt: NOW + 220_000, hitRatio: 0.82,
  readAt: Math.floor(NOW / 1000) - 60, sessionId: null, recacheIfCold: null, model: null,
}
const CACHE_ROW = '$(database) prompt cache warm · expires in 3 m 40 s (5 min TTL) · hit ratio 82 %'
  + ' · updated 1 min ago'

test('a mirror with text under every neighbouring key reaches no item and no tooltip of the bar (1.8 §0a.1 leak test)', () => {
  const file = join(scratchDir('sb-leak'), 'statusline-mirror.json')
  writeLeakyMirror(file, NOW - 60_000, NOW)
  const r = readStatuslineMirror(file)
  assert.ok(r.promptCache !== null && r.context !== null)
  const promptCache = { ...r.promptCache, readAt: r.state.fetchedAt, sessionId: r.sessionId, model: r.model?.id ?? null }
  const items = buildItems(input({ promptCache }))
  assert.ok(items[0].tooltipMarkdown.includes('prompt cache warm'), items[0].tooltipMarkdown)
  const text = JSON.stringify(items)
  for (const secret of LEAK_STATUS_SECRETS) assert.equal(text.includes(secret), false, `the bar holds ${secret}`)
  assert.equal(text.includes(LEAK_SESSION_ID.slice(8)), false, 'the bar holds the session id')
})

test('the prompt-cache row is in the Claude tooltip only while the bridge delivers a reading', () => {
  const tip = buildItems(input({ promptCache: CACHE }))[0].tooltipMarkdown
  assert.ok(tip.includes(`\n${CACHE_ROW}\n`), tip)
  // Once, below the window table and above the freshness line.
  assert.equal(tip.split('prompt cache').length - 1, 1, tip)
  assert.ok(tip.indexOf(CACHE_ROW) > tip.indexOf('| 5 h |'), tip)
  assert.ok(tip.indexOf(CACHE_ROW) < tip.indexOf('Updated '), tip)
  // No reading, no row — never a dash line that suggests one could be had.
  assert.equal(buildItems(input())[0].tooltipMarkdown.includes('prompt cache'), false)
  assert.equal(buildItems(input({ promptCache: null }))[0].tooltipMarkdown.includes('prompt cache'), false)
  // Codex has no status line: its tooltip never carries the row, reading or not.
  const codex = buildItems(input({
    quotas: [state({ source: 'codex' })], promptCache: CACHE,
    cfg: cfg({ 'tokenPace.statusBar.show': ['codexQuota'] }),
  }))[0].tooltipMarkdown
  assert.equal(codex.includes('prompt cache'), false, codex)
})

test('the prompt-cache row keeps out of the compact tooltip and reaches the summary one', () => {
  const compact = buildItems(input({ promptCache: CACHE, cfg: cfg({ 'tokenPace.tooltip': 'compact' }) }))[0].tooltipMarkdown
  assert.equal(compact.includes('prompt cache'), false, compact)
  assert.ok(compact.split('\n').length <= 12)
  const summary = buildItems(input({ promptCache: CACHE, cfg: cfg({ 'tokenPace.density': 'minimal' }) }))[0].tooltipMarkdown
  assert.ok(summary.includes(CACHE_ROW), summary)
  // Past the expiry the row reports the last reading; a part the payload left out is a dash.
  const gone = buildItems(input({ promptCache: CACHE, now: NOW + 300_000 }))[0].tooltipMarkdown
  assert.ok(gone.includes('$(database) prompt cache · expired at 12:03 (last reading) · hit ratio 82 %'), gone)
  // The age of the reading travels with every spelling of the line, and a reading older than
  // tokenPace.staleAfterMinutes is marked: the freshness row below belongs to the quota
  // state, which may come from a much newer source.
  const old = buildItems(input({ promptCache: { ...CACHE, readAt: Math.floor(NOW / 1000) - 3600 } }))[0].tooltipMarkdown
  assert.ok(old.includes('· updated 1 h ago · $(warning) **stale**'), old)
  const bare = buildItems(input({ promptCache: { ...CACHE, ttl: null, hitRatio: null } }))[0].tooltipMarkdown
  assert.ok(bare.includes('prompt cache warm · expires in 3 m 40 s (– TTL) · hit ratio –'), bare)
})

test('a hostile window label, model name or problem text stays inside a code span of the tooltip', () => {
  const evil = '**bold**|<b>x</b>`'
  const s = state({ windows: [win({ label: evil, shortLabel: evil })], problem: evil })
  const tip = quotaTooltip(s, makeContext(input({ quotas: [s] })))
  // The span holds the markup as text and the backtick that would end it is gone.
  assert.ok(tip.includes('`**bold**|<b>x</b>`'), tip)
  assert.equal(tip.includes('| **bold**'), false, 'the label reached the table raw')
  assert.equal(tip.includes('``'), false, 'an empty span: a backtick from the value survived')
})

// ---------------------------------------------------------------------------
// Running agents (1.6 O1)
// ---------------------------------------------------------------------------

function running(n: number, over: Partial<RunningItem> = {}): RunningItem {
  return {
    key: `a:a${String(n).padStart(16, '0')}`, kind: 'agent',
    label: `Explore · opus-5 · ${1000 + n}`, fullLabel: `Explore · claude-opus-5 · ${1000 + n}`,
    context: 'Session 9d0eb37a · Workflow run cfe7718d', usage: '12K', lowerBound: false, lowerBoundText: null,
    startTs: NOW - (n + 1) * 60_000, lastTs: NOW - 20_000, startClock: '11:5' + n, lastClock: '11:59',
    waiting: false, silence: false, hookWait: null, running: 1, ...over,
  }
}

function agents(items: RunningItem[], over: Partial<AgentsReading> = {}): AgentsReading {
  return { running: items.reduce((sum, i) => sum + i.running, 0), now: items, more: 0, ...over }
}

const AGENTS_ON = { 'tokenPace.statusBar.show': ['claudeQuota', 'agents', 'tokens'] }

test('the agents entry counts the running agents, one word for one and one for many', () => {
  const on = cfg(AGENTS_ON)
  const three = agents([running(1), running(2), running(3)])
  assert.deepEqual(textsOf({ cfg: on, agents: three }).filter((t) => t.includes('running')), ['~3 running'])
  assert.deepEqual(textsOf({ cfg: on, agents: agents([running(1)]) }).filter((t) => t.includes('running')), ['~1 running'])
  // The count is the tree's — a collector's running members included —, not the list's rows.
  const collector = running(9, { key: 'n:s|wf', kind: 'noreply', running: 10, startTs: null })
  assert.deepEqual(textsOf({ cfg: on, agents: agents([running(1), collector]) }).filter((t) => t.includes('running')), ['~11 running'])
  // Its place is where statusBar.show puts it, with the priorities of that order.
  const items = buildItems(input({ cfg: on, agents: three }))
  assert.deepEqual(items.map((m) => m.id), ['tokenPace.quota.claude.session.300', 'tokenPace.agents', 'tokenPace.tokens'])
  assert.deepEqual(items.map((m) => m.priorityKey), ['1000', '999', '998'])
  assert.equal(items[1].name, 'Token Pace — running agents')
})

test('the agents entry is hidden while nothing runs, without a tree, and when it is not asked for', () => {
  const on = cfg(AGENTS_ON)
  const has = (p: Partial<StatusTextInput>): boolean => buildItems(input(p)).some((m) => m.id === 'tokenPace.agents')
  assert.equal(has({ cfg: on, agents: agents([]) }), false, 'no "~0 running" (1.6 §7a Q6)')
  assert.equal(has({ cfg: on, agents: agents([], { running: 0, more: 0 }) }), false)
  assert.equal(has({ cfg: on, agents: null }), false, 'no tree, no entry')
  assert.equal(has({ cfg: on }), false)
  assert.equal(has({ cfg: on, agents: { running: Number.NaN, now: [], more: 0 } }), false)
  // Off by default: the default list does not name it.
  assert.equal(has({ agents: agents([running(1)]) }), false)
  assert.equal(has({ cfg: on, agents: agents([running(1)]) }), true)
})

test('the agents entry has no colour, no alarm and no word for done, and clicks as configured', () => {
  for (const colorMode of ['theme', 'monochrome']) {
    const m = buildItems(input({ cfg: cfg({ ...AGENTS_ON, 'tokenPace.colorMode': colorMode }), agents: agents([running(1), running(2)]) }))
      .find((i) => i.id === 'tokenPace.agents')
    assert.ok(m)
    assert.equal(m.colorId, null)
    assert.equal(m.alarm, false)
    assert.doesNotMatch(`${m.text}\n${m.tooltipMarkdown}`, /\bdone\b|\bfinished\b|\$\(warning\)|\$\(error\)/)
  }
  const of = (action: string) => buildItems(input({ cfg: cfg({ ...AGENTS_ON, 'tokenPace.clickAction': action }), agents: agents([running(1)]) }))
    .find((i) => i.id === 'tokenPace.agents')!
  assert.equal(of('dashboard').command, 'tokenPace.showDashboard')
  assert.equal(of('menu').command, 'tokenPace.menu')
  assert.equal(of('refresh').command, 'tokenPace.refreshQuota')
  // No provider to open the page of: the chooser, as the other entries without one do.
  assert.equal(of('openWebsite').command, 'tokenPace.openUsagePage')
  assert.equal(of('openWebsite').commandArgs, undefined)
})

test('the agents tooltip says what running means, names at most five entries and counts the rest', () => {
  const on = cfg(AGENTS_ON)
  const seven = [1, 2, 3, 4, 5, 6, 7].map((n) => running(n))
  const tip = buildItems(input({ cfg: on, agents: agents(seven) })).find((m) => m.id === 'tokenPace.agents')!.tooltipMarkdown
  const lines = tip.split('\n')
  assert.equal(lines[0], 'Agents running now — inferred from their transcripts (changed within the last 10 minutes, no result recorded).')
  // The sentence's ten minutes are the running window's.
  assert.equal(RUNNING_WINDOW_MS, 10 * 60_000)
  const listed = lines.filter((l) => l.startsWith('- '))
  assert.equal(AGENTS_TOOLTIP_ITEMS, 5)
  assert.deepEqual(listed, seven.slice(0, 5).map((r) => `- \`${r.fullLabel} · ${r.context}\``))
  assert.ok(lines.includes('and 2 more'), tip)
  assert.ok(tip.includes('[Dashboard](command:tokenPace.showDashboard)'), 'the action footer')
  // The entries beyond the running list's own cap count too.
  const capped = buildItems(input({ cfg: on, agents: agents(seven, { more: 3, running: 10 }) })).find((m) => m.id === 'tokenPace.agents')!
  assert.equal(capped.text, '~10 running')
  assert.ok(capped.tooltipMarkdown.split('\n').includes('and 5 more'), capped.tooltipMarkdown)
  // Five or fewer: no "more".
  const five = buildItems(input({ cfg: on, agents: agents(seven.slice(0, 5)) })).find((m) => m.id === 'tokenPace.agents')!
  assert.doesNotMatch(five.tooltipMarkdown, /more/)
  // A collector says how many of its agents run, as the markdown's running line does.
  const collector = running(9, { key: 'n:s|wf', kind: 'noreply', running: 10, startTs: null,
    label: '263 agent(s) without a counted reply', fullLabel: '263 agent(s) without a counted reply' })
  const withCollector = buildItems(input({ cfg: on, agents: agents([running(1), collector]) })).find((m) => m.id === 'tokenPace.agents')!
  assert.ok(withCollector.tooltipMarkdown.includes(`- \`${collector.fullLabel} · ${collector.context}\` (~10 of them running)`), withCollector.tooltipMarkdown)
  // tokenPace.tooltip: off leaves no tooltip at all.
  const off = buildItems(input({ cfg: cfg({ ...AGENTS_ON, 'tokenPace.tooltip': 'off' }), agents: agents([running(1)]) }))
  assert.equal(off.find((m) => m.id === 'tokenPace.agents')!.tooltipMarkdown, '')
})

test('a hostile agent type or project name stays inside a code span of the agents tooltip', () => {
  // The type comes from a sidecar and the project from a directory name: borrowed strings, which
  // the trusted, HTML-enabled tooltip must print and not obey.
  const evil = running(1, { fullLabel: '**x**|<img src=x>`[y](command:tokenPace.rescan)', context: 'Session 9d0eb37a · <b>p</b>`' })
  const tip = buildItems(input({ cfg: cfg(AGENTS_ON), agents: agents([evil]) })).find((m) => m.id === 'tokenPace.agents')!.tooltipMarkdown
  assert.ok(tip.includes('- `**x**|<img src=x>[y](command:tokenPace.rescan) · Session 9d0eb37a · <b>p</b>`'), tip)
  assert.equal(tip.includes('``'), false, tip)
})

test('the preview shows the running agents as many and as one, and colours neither', () => {
  const items = previewItems(cfg({}), NOW).filter((m) => m.text.includes(' running'))
  assert.deepEqual(items.map((m) => m.text), ['[preview] ~3 running', '[preview] ~1 running'])
  for (const m of items) {
    assert.equal(m.colorId, null)
    assert.equal(m.alarm, false)
    assert.ok(m.tooltipMarkdown.includes('Agents running now'), m.tooltipMarkdown)
    assert.doesNotMatch(m.tooltipMarkdown, /NaN|undefined/)
  }
})

// ---------------------------------------------------------------------------
// 1.7 W1: the failed attempt beside a stale reading; W2: due and waiting for focus
// ---------------------------------------------------------------------------

/** The bundle the extension ships, installed for the length of `run`. */
function german<T>(run: () => T): T {
  const bundle = JSON.parse(readFileSync(join(ROOT, 'l10n', 'bundle.l10n.de.json'), 'utf8')) as Record<string, string>
  try {
    setBundle(bundle)
    setLocale('de')
    return run()
  } finally {
    setBundle(undefined)
    setLocale(undefined)
  }
}

const RETRY_WORDS = 'HTTP 429 — backing off before the next attempt'

/** The Claude reading two hours old, our own fetch failed twenty minutes ago, the next attempt in 1 h 12 min. */
function failedReading(p: Partial<QuotaState> = {}): QuotaState {
  return state({
    fetchedAt: Math.floor(NOW / 1000) - 2 * 3600,
    lastFailure: { at: NOW - 20 * 60_000, problem: RETRY_WORDS, kind: 'retry' },
    nextAttemptAt: NOW + 72 * 60_000,
    ...p,
  })
}

test('the retry state never says "reset due" of an attempt: a sweep from −2 h to +2 h, English and German (1.7 W2)', () => {
  const sweep = (): Array<[number, string]> => {
    const out: Array<[number, string]> = []
    for (let m = -120; m <= 120; m++) {
      const q = state({ ok: false, problemKind: 'retry', windows: [], nextAttemptAt: NOW + m * 60_000 })
      out.push([m, problemText(q, cfg(), NOW)])
    }
    return out
  }
  for (const [m, text] of sweep()) {
    assert.doesNotMatch(text, /reset due/, `${m} min: ${text}`)
    if (m <= 0) assert.equal(text, '$(clock) CC retry due', `${m} min`)
    else assert.equal(text, `$(clock) CC retry ${relativeShort(NOW + m * 60_000, NOW)}`, `${m} min`)
  }
  for (const [m, text] of german(sweep)) {
    assert.doesNotMatch(text, /Reset fällig|reset due/, `${m} min: ${text}`)
    if (m <= 0) assert.equal(text, '$(clock) CC neuer Versuch fällig', `${m} min`)
    else assert.match(text, /^\$\(clock\) CC neuer Versuch in (<1m|\d+h\d*m?|\d+m)$/, `${m} min: ${text}`)
  }
})

test('a due retry held for focus says so, and its tooltip says why (1.7 W2)', () => {
  const q = state({ ok: false, problemKind: 'retry', windows: [], nextAttemptAt: NOW - 60_000, attemptHeld: 'focus' })
  assert.equal(problemText(q, cfg(), NOW), '$(clock) CC retry waiting for focus')
  const p = problemView(q, cfg(), NOW)
  assert.equal(p.explain, 'The last attempt failed; the next one is scheduled after a backoff. This window has been in the background for more than ten minutes; with tokenPace.pollOnlyWhenFocused on, the attempt waits until it is focused.')
  assert.ok(problemTooltip(q, makeContext(input({ quotas: [q] }))).includes('with tokenPace.pollOnlyWhenFocused on, the attempt waits until it is focused.'))
  // Not held: the explanation is the 1.6 one, word for word.
  const due = problemView(state({ ok: false, problemKind: 'retry', windows: [], nextAttemptAt: NOW - 60_000 }), cfg(), NOW)
  assert.equal(due.message, 'retry due')
  assert.equal(due.explain, 'The last attempt failed; the next one is scheduled after a backoff.')
  assert.equal(german(() => problemText(q, cfg(), NOW)), '$(clock) CC neuer Versuch wartet auf Fokus')
  assert.ok(german(() => problemView(q, cfg(), NOW).explain).endsWith(
    'Dieses Fenster ist seit mehr als zehn Minuten im Hintergrund; mit tokenPace.pollOnlyWhenFocused wartet der Versuch, bis es den Fokus hat.'))
})

test('a stale reading whose own fetch failed says the next attempt after its age — words, no colour of its own (1.7 W1)', () => {
  const q = failedReading()
  const m = buildItems(input({ quotas: [q] }))[0]
  assert.equal(m.text, 'CC 5h ██┃▁▁▁▁▁ 25% · resets 3h30m $(history) 2h · $(clock) retry 1h12m')
  assert.equal(m.colorId, 'tokenPace.stale')
  assert.equal(m.alarm, false)
  // The other forms of the next attempt.
  assert.ok(textsOf({ quotas: [failedReading({ nextAttemptAt: NOW - 1 })] })[0].endsWith(' $(history) 2h · $(clock) retry due'))
  assert.ok(textsOf({ quotas: [failedReading({ nextAttemptAt: NOW - 1, attemptHeld: 'focus' })] })[0]
    .endsWith(' $(history) 2h · $(clock) retry waiting for focus'))
  assert.ok(textsOf({ quotas: [failedReading({ nextAttemptAt: null })] })[0].endsWith(' $(history) 2h · $(clock) retry'))
  // German: the existing "retry {0}" and W2's words.
  assert.ok(german(() => textsOf({ quotas: [q] })[0]).endsWith(' · $(clock) neuer Versuch in 1h12m'))
  assert.ok(german(() => textsOf({ quotas: [failedReading({ nextAttemptAt: NOW - 1 })] })[0]).endsWith(' · $(clock) neuer Versuch fällig'))
  assert.ok(german(() => textsOf({ quotas: [failedReading({ nextAttemptAt: NOW - 1, attemptHeld: 'focus' })] })[0])
    .endsWith(' · $(clock) neuer Versuch wartet auf Fokus'))
  // The compact item carries it where its age stands, too.
  const compactItem = buildItems(input({ quotas: [q], cfg: cfg({ 'tokenPace.density': 'compact' }) }))[0]
  assert.ok(compactItem.text.endsWith(' $(history) 2h · $(clock) retry 1h12m'), compactItem.text)
  assert.equal(compactItem.colorId, 'tokenPace.stale')
  // An exhausted window read two hours ago: stale takes the alarm, the failure adds none.
  const full = buildItems(input({ quotas: [failedReading({ windows: [win({ percent: 100 })] })] }))[0]
  assert.equal(full.alarm, false)
  assert.equal(full.colorId, 'tokenPace.stale')
  // With the age switched off the suffix still says why the figure is old.
  assert.ok(textsOf({ quotas: [q], cfg: cfg({ 'tokenPace.showAgeInItem': 'never' }) })[0].endsWith('resets 3h30m · $(clock) retry 1h12m'))
})

test('a fresh reading beside a failed fetch keeps its text; the tooltip names the failure either way (1.7 W1)', () => {
  const fresh = failedReading({ fetchedAt: Math.floor(NOW / 1000) - 60, lastFailure: { at: NOW - 30_000, problem: RETRY_WORDS, kind: 'retry' } })
  const m = buildItems(input({ quotas: [fresh] }))[0]
  assert.equal(m.text, 'CC 5h ██┃▁▁▁▁▁ 25% · resets 3h30m')
  assert.equal(m.colorId, 'tokenPace.paceOk')
  assert.ok(m.tooltipMarkdown.includes(
    '$(clock) Last attempt at 11:59 failed: `HTTP 429 — backing off before the next attempt` · next attempt in 1h12m'), m.tooltipMarkdown)
  // The line stands after the freshness line, as a paragraph of its own.
  const lines = m.tooltipMarkdown.split('\n')
  const at = lines.findIndex((l) => l.startsWith('$(clock) Last attempt'))
  assert.ok(lines[at - 2].startsWith('Updated '), lines.slice(at - 3, at + 1).join('\n'))
  assert.equal(lines[at - 1], '')
  // Stale without a failure: no suffix and no line.
  const stale = state({ fetchedAt: Math.floor(NOW / 1000) - 2 * 3600 })
  const plain = buildItems(input({ quotas: [stale] }))[0]
  assert.equal(plain.text, 'CC 5h ██┃▁▁▁▁▁ 25% · resets 3h30m $(history) 2h')
  assert.equal(plain.tooltipMarkdown.includes('$(clock)'), false)
  // The stale item's tooltip, the compact tooltip and the collective item's tooltip carry the sentence.
  const q = failedReading()
  const sentence = '$(clock) Last attempt at 11:40 failed: `HTTP 429 — backing off before the next attempt` · next attempt in 1h12m'
  assert.ok(quotaTooltip(q, makeContext(input({ quotas: [q] }))).includes(sentence))
  assert.ok(quotaTooltip(q, makeContext(input({ quotas: [q], cfg: cfg({ 'tokenPace.tooltip': 'compact' }) }))).includes(sentence))
  assert.ok(summaryTooltip(['claude'], makeContext(input({ quotas: [q] }))).includes(sentence))
  // German, the poller's words as the poller wrote them.
  const de = german(() => quotaTooltip(failedReading({
    lastFailure: { at: NOW - 20 * 60_000, problem: 'HTTP 429 — Wartezeit vor dem nächsten Versuch', kind: 'retry' },
  }), makeContext(input())))
  assert.ok(de.includes('$(clock) Letzter Versuch um 11:40 fehlgeschlagen: `HTTP 429 — Wartezeit vor dem nächsten Versuch` · nächster Versuch in 1h12m'), de)
})

test('a due attempt held for focus is a tooltip line of its own when nothing failed (1.7 W2)', () => {
  const held = state({ nextAttemptAt: NOW - 60_000, attemptHeld: 'focus' })
  const tip = quotaTooltip(held, makeContext(input({ quotas: [held] })))
  assert.ok(tip.split('\n').includes('$(clock) next attempt waiting for focus'), tip)
  assert.ok(german(() => quotaTooltip(held, makeContext(input({ quotas: [held] })))).split('\n')
    .includes('$(clock) nächster Versuch wartet auf Fokus'))
  // Due but not held, or held nowhere: no line — the item says nothing new either.
  for (const q of [state({ nextAttemptAt: NOW - 60_000 }), state({ nextAttemptAt: NOW + 60_000, attemptHeld: 'focus' })]) {
    assert.equal(quotaTooltip(q, makeContext(input({ quotas: [q] }))).includes('$(clock)'), false)
  }
  // With a failure the sentence already ends so; the line is not said twice.
  const both = failedReading({ nextAttemptAt: NOW - 60_000, attemptHeld: 'focus' })
  const tip2 = quotaTooltip(both, makeContext(input({ quotas: [both] })))
  assert.equal(tip2.split('\n').filter((l) => l.includes('waiting for focus')).length, 1, tip2)
  assert.ok(tip2.includes('· next attempt waiting for focus'))
})

test('the failed attempt\'s words stay inside a code span of the tooltip (1.7 W1)', () => {
  const evil = '**bold**|<img src=x onerror=alert(1)>`'
  const q = failedReading({ lastFailure: { at: NOW - 20 * 60_000, problem: evil, kind: 'retry' } })
  const tip = quotaTooltip(q, makeContext(input({ quotas: [q] })))
  assert.ok(tip.includes('failed: `**bold**|<img src=x onerror=alert(1)>` · next attempt'), tip)
  assert.equal(tip.includes('``'), false, tip)
})

// ---------------------------------------------------------------------------
// 1.7 P4b (Review 1 #2): only a transient failure is said beside a reading
// ---------------------------------------------------------------------------

test('a permanent cause beside a reading adds no suffix and no tooltip line; a transient one does (1.7 P4b)', () => {
  // Every kind, written out: the record in types.ts must give each its verdict, and only these three are transient.
  const every: ProblemKind[] = [
    'noFile', 'paused', 'empty', 'noToken', 'tokenExpired', 'consentPending', 'modeCache',
    'retry', 'offline', 'forbidden', 'unauthorized', 'noBinary', 'quotaOff', 'follower', 'unknown',
  ]
  const transient: ProblemKind[] = ['retry', 'offline', 'unknown']
  for (const kind of every) {
    const q = failedReading({ lastFailure: { at: NOW - 20 * 60_000, problem: `synthetic ${kind} words`, kind } })
    const m = buildItems(input({ quotas: [q] }))[0]
    const tip = quotaTooltip(q, makeContext(input({ quotas: [q] })))
    if (transient.includes(kind)) {
      assert.ok(m.text.endsWith(' $(history) 2h · $(clock) retry 1h12m'), `${kind}: ${m.text}`)
      assert.ok(tip.includes(`$(clock) Last attempt at 11:40 failed: \`synthetic ${kind} words\` · next attempt in 1h12m`), `${kind}: ${tip}`)
    } else {
      // The stale reading as 1.6 showed it: its age, and nothing of the permanent cause.
      assert.equal(m.text, 'CC 5h ██┃▁▁▁▁▁ 25% · resets 3h30m $(history) 2h', kind)
      assert.equal(tip.includes('Last attempt'), false, `${kind}: ${tip}`)
      assert.equal(tip.includes(`synthetic ${kind} words`), false, `${kind}: ${tip}`)
      // The compact item and the collective item's tooltip neither.
      const compactItem = buildItems(input({ quotas: [q], cfg: cfg({ 'tokenPace.density': 'compact' }) }))[0]
      assert.equal(compactItem.text.includes('retry'), false, `${kind}: ${compactItem.text}`)
      assert.equal(summaryTooltip(['claude'], makeContext(input({ quotas: [q] }))).includes('Last attempt'), false, kind)
    }
    assert.equal(m.colorId, 'tokenPace.stale', kind)
    assert.equal(m.alarm, false, kind)
  }
  // A permanent cause and a due attempt held for focus: the failure is not said, so the focus line is.
  const held = failedReading({ lastFailure: { at: NOW - 20 * 60_000, problem: 'codex executable not found', kind: 'noBinary' },
    nextAttemptAt: NOW - 60_000, attemptHeld: 'focus' })
  const tip = quotaTooltip(held, makeContext(input({ quotas: [held] })))
  assert.ok(tip.split('\n').includes('$(clock) next attempt waiting for focus'), tip)
  assert.equal(tip.includes('codex executable not found'), false, tip)
  // German: nothing of it either.
  assert.equal(german(() => buildItems(input({ quotas: [failedReading({
    lastFailure: { at: NOW - 20 * 60_000, problem: 'Anmeldedaten abgelehnt', kind: 'unauthorized' } })] }))[0].text).includes('neuer Versuch'), false)
})

// ---------------------------------------------------------------------------
// 1.8 A5, A7 (§3 A8 test 13): the `cache` entry, its tooltip, the Claude quota tooltip's rows
// ---------------------------------------------------------------------------

const CACHE_ON = { 'tokenPace.statusBar.show': ['claudeQuota', 'cache', 'tokens'] }
const S_BRIDGE = '9d0eb37a-0000-4000-8000-000000000001'
const S_TX = 'aaaa1111-0000-4000-8000-000000000002'

/** A watched session as `watchCaches` hands it on: its phase at NOW from its expiry `left` ms away. */
function watched(o: { id?: string; left: number; source?: 'bridge' | 'transcript'; name?: string; recache?: number | null }): CacheWatchEntry {
  const expiresAt = NOW + o.left
  const phase = cachePhase(expiresAt, NOW)
  assert.ok(phase !== null, `nothing is watched ${o.left} ms from its expiry`)
  const id = o.id ?? S_BRIDGE
  return {
    sessionId: id, name: o.name ?? `Session Thu 11:05 · ${id.slice(0, 8)}`, source: o.source ?? 'bridge', ttl: '1h',
    expiresAt, phase, recache: o.recache === undefined ? 152_300 : o.recache, model: 'claude-opus-5-5',
  }
}
const COOL = 4 * 60_000 + 10_000

function cacheItem(entries: CacheWatchEntry[] | null | undefined, over: Record<string, unknown> = {}): ItemModel | undefined {
  return buildItems(input({ cfg: cfg({ ...CACHE_ON, ...over }), cacheWatch: entries })).find((m) => m.id === 'tokenPace.cache')
}

test('the cache entry is offered and not switched on: not in the default, and only where the list names it (1.8 A5)', () => {
  assert.equal(sanitize({}).statusBar.show.includes('cache'), false)
  assert.deepEqual(sanitize({ 'tokenPace.statusBar.show': ['cache'] }).statusBar.show, ['cache'])
  const cooling = [watched({ left: COOL })]
  // The default bar: no entry, whatever cools.
  assert.equal(buildItems(input({ cacheWatch: cooling })).some((m) => m.id === 'tokenPace.cache'), false)
  // Asked for: where the list puts it, between the quota window and the tokens.
  const items = buildItems(input({ cfg: cfg(CACHE_ON), cacheWatch: cooling }))
  assert.deepEqual(items.map((m) => m.id), ['tokenPace.quota.claude.session.300', 'tokenPace.cache', 'tokenPace.tokens'])
  assert.equal(items[1].priorityKey, '999')
  assert.equal(items[1].name, 'Token Pace — prompt cache')
})

test('the cache entry shows only while a watched cache is cooling: none while warm, cold or unwatched (1.8 A5, §3 A8 test 13)', () => {
  // Mutation check (§3 A8 test 13): an entry drawn from warm caches too fails the first case here.
  assert.equal(cacheItem([watched({ left: 5 * 60_000 + 1 })]), undefined, 'a warm cache is not news')
  assert.equal(cacheItem([watched({ left: 30 * 60_000 }), watched({ id: S_TX, left: 50 * 60_000, source: 'transcript' })]), undefined)
  assert.equal(cacheItem([watched({ left: -20 * 60_000 })]), undefined, 'a cold cache is the card\'s to say')
  assert.equal(cacheItem([watched({ left: 0 })]), undefined, 'at its expiry the cache is cold')
  for (const none of [[], null, undefined]) assert.equal(cacheItem(none), undefined, JSON.stringify(none))
  // The lead's boundary: five minutes before the expiry it cools.
  assert.equal(cacheItem([watched({ left: 5 * 60_000 })])?.text, '$(watch) cache 5m')
  // A cooling session among warm and cold ones: the entry, and it counts the cooling ones alone.
  const mixed = [watched({ left: 2 * 60_000 }), watched({ id: S_TX, left: -10 * 60_000 }), watched({ id: '7a7a7a7a-0000', left: 20 * 60_000 })]
  assert.equal(cacheItem(mixed)?.text, '$(watch) cache 2m')
})

test('the cache entry\'s text: the countdown in minutes, the seconds under a minute, `~` for an estimate, `+1` for another cooling session (1.8 A5)', () => {
  assert.equal(cacheItem([watched({ left: COOL })])?.text, '$(watch) cache 4m')
  assert.equal(cacheItem([watched({ left: COOL, source: 'transcript' })])?.text, '$(watch) cache ~4m')
  assert.equal(cacheItem([watched({ left: 45_000 })])?.text, '$(watch) cache 45s')
  assert.equal(cacheItem([watched({ left: 45_000, source: 'transcript' })])?.text, '$(watch) cache ~45s')
  assert.equal(cacheItem([watched({ left: 59_999 })])?.text, '$(watch) cache 59s')
  assert.equal(cacheItem([watched({ left: 60_000 })])?.text, '$(watch) cache 1m')
  // The session whose cache expires first speaks; the others are counted.
  assert.equal(cacheItem([watched({ left: COOL }), watched({ id: S_TX, left: 4.5 * 60_000, source: 'transcript' })])?.text, '$(watch) cache 4m +1')
  assert.equal(cacheItem([watched({ left: 30_000, source: 'transcript' }), watched({ id: S_TX, left: COOL }), watched({ id: '7a7a7a7a-0000', left: COOL })])?.text,
    '$(watch) cache ~30s +2')
  // The order is the watch list's: the real one, cooling by expiry.
  const readings = [S_BRIDGE, S_TX].map((sessionId, i) => ({
    warm: true, ttl: '1h' as const, expiresAt: NOW + (i === 0 ? COOL : 90_000), hitRatio: 0.9, readAt: Math.floor(NOW / 1000) - 60,
    sessionId, recacheIfCold: 152_300, model: 'claude-opus-5-5',
  }))
  const list = watchCaches({ readings, mains: [], tcfg: { zone: 'utc', dayBoundaryHour: 0, startOfWeek: 'monday', hourCycle: 'h23' } }, NOW, Infinity)
  assert.equal(cacheItem(list)?.text, '$(watch) cache 1m +1')
  // German: the word is the bundle's, the countdown the same in both languages.
  assert.equal(german(() => cacheItem([watched({ left: COOL })])?.text), '$(watch) Cache 4m')
  assert.equal(german(() => cacheItem([watched({ left: COOL, source: 'transcript' })])?.text), '$(watch) Cache ~4m')
  assert.equal(german(() => cacheItem([watched({ left: 45_000 })])?.text), '$(watch) Cache 45s')
  assert.equal(german(() => cacheItem([watched({ left: COOL }), watched({ id: S_TX, left: 4.5 * 60_000 })])?.text), '$(watch) Cache 4m +1')
  assert.equal(german(() => cacheItem([watched({ left: COOL })])?.name), 'Token Pace — Prompt-Cache')
})

test('the cache entry has no colour and no alarm in any mode, and clicks as configured (1.8 §0b.6)', () => {
  for (const over of [{}, { 'tokenPace.colorMode': 'monochrome' }, { 'tokenPace.indicator': 'color' }, { 'tokenPace.indicator': 'none' }]) {
    const m = cacheItem([watched({ left: 30_000 })], over)
    assert.ok(m, JSON.stringify(over))
    assert.equal(m.colorId, null, JSON.stringify(over))
    assert.equal(m.alarm, false, JSON.stringify(over))
  }
  const of = (action: string): ItemModel => cacheItem([watched({ left: COOL })], { 'tokenPace.clickAction': action })!
  assert.equal(of('dashboard').command, 'tokenPace.showDashboard')
  assert.equal(of('menu').command, 'tokenPace.menu')
  assert.equal(of('refresh').command, 'tokenPace.refreshQuota')
  // Not a provider's item: the usage page it opens is the menu's choice, as for context and agents.
  assert.equal(of('openWebsite').command, 'tokenPace.openUsagePage')
  assert.equal(of('openWebsite').commandArgs, undefined)
})

test('the cache entry says in words what its short text means, for a screen reader; no other item has words of its own (1.8 A7)', () => {
  assert.equal(cacheItem([watched({ left: COOL })])?.ariaLabel, 'Prompt cache of Session Thu 11:05 · 9d0eb37a cools in 4 m 10 s')
  assert.equal(cacheItem([watched({ left: COOL, source: 'transcript' })])?.ariaLabel,
    'Prompt cache of Session Thu 11:05 · 9d0eb37a cools in about 4 m 10 s (estimated)')
  assert.equal(cacheItem([watched({ left: 45_000 }), watched({ id: S_TX, left: COOL, source: 'transcript' })])?.ariaLabel,
    'Prompt cache of Session Thu 11:05 · 9d0eb37a cools in 45 s, and 1 more')
  assert.equal(cacheItem([watched({ left: 45_000, source: 'transcript' }), watched({ id: S_TX, left: COOL }), watched({ id: '7a7a7a7a-0000', left: COOL })])?.ariaLabel,
    'Prompt cache of Session Thu 11:05 · 9d0eb37a cools in about 45 s (estimated), and 2 more')
  assert.equal(german(() => cacheItem([watched({ left: COOL, name: 'Sitzung Do 11:05 · 9d0eb37a' })])?.ariaLabel),
    'Prompt-Cache von Sitzung Do 11:05 · 9d0eb37a kühlt in 4 m 10 s ab')
  assert.equal(german(() => cacheItem([watched({ left: COOL, source: 'transcript', name: 'Sitzung Do 11:05 · 9d0eb37a' })])?.ariaLabel),
    'Prompt-Cache von Sitzung Do 11:05 · 9d0eb37a kühlt in etwa 4 m 10 s ab (geschätzt)')
  assert.equal(german(() => cacheItem([watched({ left: COOL, name: 'Sitzung Do 11:05 · 9d0eb37a' }), watched({ id: S_TX, left: 4.5 * 60_000 })])?.ariaLabel),
    'Prompt-Cache von Sitzung Do 11:05 · 9d0eb37a kühlt in 4 m 10 s ab und 1 weitere')
  // Every other entry is read by its text.
  const all = buildItems(input({
    cfg: cfg({ 'tokenPace.statusBar.show': ['claudeQuota', 'context', 'tokens', 'cost', 'cache'] }),
    context: { used: 1000, size: 2000, usedPct: 50, fetchedAt: Math.floor(NOW / 1000) }, cacheWatch: [watched({ left: COOL })],
  }))
  assert.deepEqual(all.filter((m) => m.ariaLabel !== undefined).map((m) => m.id), ['tokenPace.cache'])
})

test('the cache entry\'s tooltip: the cooling sessions, each its state and its cost, at most three, then the count and the action row (1.8 A5)', () => {
  const tip = cacheItem([watched({ left: COOL }), watched({ id: S_TX, left: 4.5 * 60_000, source: 'transcript', name: 'Session Thu 10:04 · aaaa1111' })])!
    .tooltipMarkdown
  const lines = tip.split('\n')
  assert.equal(lines[0], '**Prompt cache cooling**')
  assert.deepEqual(lines.slice(1, 10), [
    '', '$(watch) `Session Thu 11:05 · 9d0eb37a` · prompt cache cools in 4 m 10 s (1 h TTL)',
    '', '_A cold start after 12:04 re-writes 152.3K tokens at the 1 h write rate (2× input, ~$1.22) instead of reading them from the cache (0.05× input, ~$0.03)._',
    '', '$(watch) `Session Thu 10:04 · aaaa1111` · prompt cache cools in ~4 m 30 s (1 h TTL, estimated from the transcript)',
    '', '_A cold start after ~12:04 re-writes ~152.3K tokens at the 1 h write rate (2× input, ~$1.22) instead of reading them from the cache (0.05× input, ~$0.03)._',
    '',
  ])
  assert.equal(lines[10], footerLine(makeContext(input({ cfg: cfg(CACHE_ON) }))))
  assert.equal(lines.length, 11)
  // Four cooling sessions: three rows and the count of the fourth.
  const four = cacheItem([30_000, 60_000, 90_000, 120_000].map((left, i) => watched({ id: `${i}0000000-0000`, left })))!.tooltipMarkdown
  assert.equal(four.split('\n').filter((l) => l.startsWith('$(watch) ')).length, 3)
  assert.ok(four.split('\n').includes('and 1 more'), four)
  // Costs off: the rates variant; an unknown size: no cost line.
  const plain = cacheItem([watched({ left: COOL })], { 'tokenPace.showCost': false })!.tooltipMarkdown
  assert.ok(plain.includes('_A cold start after 12:04 re-writes 152.3K tokens at the 1 h write rate (2× input) instead of reading them from the cache (0.05× input)._'), plain)
  assert.equal(plain.includes('$1'), false, plain)
  assert.equal(cacheItem([watched({ left: COOL, recache: null })])!.tooltipMarkdown.includes('cold start'), false)
  // Compact keeps the rows, not the cost lines; off is no tooltip.
  const compactTip = cacheItem([watched({ left: COOL })], { 'tokenPace.tooltip': 'compact' })!.tooltipMarkdown
  assert.ok(compactTip.includes('prompt cache cools in 4 m 10 s'), compactTip)
  assert.equal(compactTip.includes('cold start'), false, compactTip)
  assert.ok(compactTip.split('\n').length <= 12)
  assert.equal(cacheItem([watched({ left: COOL })], { 'tokenPace.tooltip': 'off' })!.tooltipMarkdown, '')
  // German: the heading and the rows in the bundle's words.
  const de = german(() => cacheItem([watched({ left: COOL, name: 'Sitzung Do 11:05 · 9d0eb37a' })])!.tooltipMarkdown)
  assert.ok(de.startsWith('**Prompt-Cache kühlt ab**\n\n$(watch) `Sitzung Do 11:05 · 9d0eb37a` · Prompt-Cache kühlt in 4 m 10 s ab (1 h TTL)'), de)
  assert.ok(de.includes('\n_Ein Kaltstart nach 12:04 schreibt 152,3K Token zum 1-h-Schreibpreis neu (2× Eingabe, ~$1,22), statt sie aus dem Cache zu lesen (0,05× Eingabe, ~$0,03)._\n'), de)
})

test('a session name stays inside a code span of the tooltips, whatever it holds (1.8 A5)', () => {
  const evil = watched({ left: COOL, name: 'Session **x**|<img src=x onerror=alert(1)>`' })
  const q = state()
  const ctx = makeContext(input({ cfg: cfg(CACHE_ON), cacheWatch: [evil] }))
  for (const tip of [cacheItem([evil])!.tooltipMarkdown, quotaTooltip(q, ctx)]) {
    assert.ok(tip.includes('`Session **x**|<img src=x onerror=alert(1)>` · prompt cache cools in 4 m 10 s (1 h TTL)'), tip)
    assert.equal(tip.includes('``'), false, tip)
  }
})

/** The window's createStatusBarItem for StatusBar.update, recording every item it creates. */
function barStub(): { items: Array<Record<string, any>>; restore(): void } {
  const items: Array<Record<string, any>> = []
  const saved = VSCODE_STUB.window
  VSCODE_STUB.window = {
    ...saved,
    createStatusBarItem: (id: string, alignment: number, priority: number) => {
      const it: Record<string, any> = { id, alignment, priority, disposed: false, visible: false,
        show() { this.visible = true }, dispose() { this.disposed = true; this.visible = false } }
      items.push(it)
      return it
    },
  }
  return { items, restore: () => { VSCODE_STUB.window = saved } }
}

test('the bar hands the entry\'s words to VS Code as its accessibility label, keeps its name, and links only its own commands (1.8 A7)', () => {
  const { StatusBar } = loadStatusBar()
  const stub = barStub()
  try {
    const bar = new StatusBar()
    const agg = fakeAgg() as unknown as Parameters<typeof bar.update>[0]['agg']
    bar.update({ ...input({ cfg: cfg(CACHE_ON), cacheWatch: [watched({ left: COOL })] }), agg })
    const live = stub.items.filter((i) => !i.disposed)
    const item = live.find((i) => i.id === 'tokenPace.cache')
    assert.ok(item, 'no cache item on the bar')
    assert.deepEqual(item.accessibilityInformation, { label: 'Prompt cache of Session Thu 11:05 · 9d0eb37a cools in 4 m 10 s' })
    assert.equal(item.name, 'Token Pace — prompt cache')
    assert.equal(item.text, '$(watch) cache 4m')
    assert.equal(item.color, undefined)
    assert.equal(item.backgroundColor, undefined)
    // Every other item is read by its text.
    for (const other of live.filter((i) => i.id !== 'tokenPace.cache')) assert.equal(other.accessibilityInformation, undefined, other.id)
    // The tooltip links only the commands the bar trusts, and every one it links is trusted.
    const trusted: string[] = item.tooltip.isTrusted.enabledCommands
    const linked = [...String(item.tooltip.value).matchAll(/\(command:([A-Za-z.]+)[^)]*\)/g)].map((m) => m[1])
    assert.ok(linked.length >= 4, String(item.tooltip.value))
    for (const id of linked) assert.ok(trusted.includes(id), `the tooltip links ${id}, which the bar does not trust`)
    assert.ok(trusted.every((id) => /^tokenPace\.[A-Za-z]+$/.test(id)), trusted.join())
    // The cache warms again (a request): the entry goes.
    bar.update({ ...input({ cfg: cfg(CACHE_ON), cacheWatch: [] }), agg })
    assert.equal(item.disposed, true)
    bar.dispose()
  } finally {
    stub.restore()
  }
})

test('the Claude quota tooltip lists the cooling and cold sessions as the card does, and the 1.3 row only for a session it does not list (1.8 A5, §3.0 b)', () => {
  const reading = {
    warm: true, ttl: '1h' as const, expiresAt: NOW + COOL, hitRatio: 0.9, readAt: Math.floor(NOW / 1000) - 60,
    sessionId: S_BRIDGE, recacheIfCold: 152_300, model: 'claude-opus-5-5',
  }
  const cold = watched({ id: S_TX, left: -20 * 60_000, source: 'transcript', name: 'Session Thu 09:40 · aaaa1111' })
  const tip = buildItems(input({ promptCache: reading, cacheWatch: [watched({ left: COOL }), cold, watched({ id: '7a7a7a7a-0000', left: 20 * 60_000 })] }))[0]
    .tooltipMarkdown
  const lines = tip.split('\n')
  const at = lines.indexOf('$(database) `Session Thu 11:05 · 9d0eb37a` · prompt cache cools in 4 m 10 s (1 h TTL)')
  assert.ok(at > 0, tip)
  assert.deepEqual(lines.slice(at, at + 7), [
    '$(database) `Session Thu 11:05 · 9d0eb37a` · prompt cache cools in 4 m 10 s (1 h TTL)', '',
    '_A cold start after 12:04 re-writes 152.3K tokens at the 1 h write rate (2× input, ~$1.22) instead of reading them from the cache (0.05× input, ~$0.03)._', '',
    '$(database) `Session Thu 09:40 · aaaa1111` · prompt cache cold since ~11:40 (1 h TTL, estimated from the transcript)', '',
    '_The next request re-writes ~152.3K tokens at the 1 h write rate (2× input, ~$1.22) instead of reading them from the cache (0.05× input, ~$0.03)._',
  ])
  // Below the window table, above the freshness line; the warm session is not a row; the latest
  // mirror's session is listed, so its 1.3 row gives way.
  assert.ok(tip.indexOf('$(database)') > tip.indexOf('| 5 h |'), tip)
  assert.ok(tip.lastIndexOf('$(database)') < tip.indexOf('Updated '), tip)
  assert.equal(tip.includes('7a7a7a7a'), false, tip)
  assert.equal(tip.includes('$(database) prompt cache'), false, tip)
  // A session the rows do not list keeps the 1.3 row: here the latest mirror is a warm session's.
  const warm = { ...reading, sessionId: '7a7a7a7a-0000', expiresAt: NOW + 20 * 60_000 }
  const both = buildItems(input({ promptCache: warm, cacheWatch: [watched({ left: COOL }), watched({ id: '7a7a7a7a-0000', left: 20 * 60_000 })] }))[0].tooltipMarkdown
  assert.ok(both.includes('$(database) `Session Thu 11:05 · 9d0eb37a` · prompt cache cools'), both)
  assert.ok(both.includes('$(database) prompt cache warm · expires in 20 m 0 s (1 h TTL) · hit ratio 90 %'), both)
  // More than three: three rows and the card's count.
  const five = buildItems(input({ cacheWatch: [30_000, 60_000, 90_000, 120_000, 150_000].map((left, i) => watched({ id: `${i}0000000-0000`, left })) }))[0]
    .tooltipMarkdown
  assert.equal(five.split('\n').filter((l) => l.startsWith('$(database) ')).length, 3)
  assert.ok(five.split('\n').includes('2 more sessions with a cooling or cold prompt cache'), five)
  // The collective item carries the rows too; the compact tooltip, the Codex item and a bare bar none.
  assert.ok(buildItems(input({ cacheWatch: [cold], cfg: cfg({ 'tokenPace.density': 'minimal' }) }))[0].tooltipMarkdown.includes('prompt cache cold since ~11:40'))
  assert.equal(buildItems(input({ cacheWatch: [cold], cfg: cfg({ 'tokenPace.tooltip': 'compact' }) }))[0].tooltipMarkdown.includes('prompt cache'), false)
  const codex = buildItems(input({ quotas: [state({ source: 'codex' })], cacheWatch: [cold], cfg: cfg({ 'tokenPace.statusBar.show': ['codexQuota'] }) }))[0]
  assert.equal(codex.tooltipMarkdown.includes('prompt cache'), false, codex.tooltipMarkdown)
  assert.equal(buildItems(input({ cacheWatch: null }))[0].tooltipMarkdown.includes('prompt cache'), false)
  // German rows.
  const de = german(() => buildItems(input({ cacheWatch: [{ ...cold, name: 'Sitzung Do 09:40 · aaaa1111' }] }))[0].tooltipMarkdown)
  assert.ok(de.includes('$(database) `Sitzung Do 09:40 · aaaa1111` · Prompt-Cache kalt seit ~11:40 (1 h TTL, geschätzt aus dem Transkript)'), de)
})

test('one row per session in the tooltips, at any minute: the Claude quota tooltip and the cache entry\'s name a session once, the 1.3 row only while its session is not listed (1.8 §3 A8 test 11)', () => {
  // The P6 invariant's world, through the status bar: session 9d0eb37a has its transcript's newest cache
  // request and a bridge reading a minute later — the latest mirror, the 1.3 row —, aaaa1111 its transcript only.
  const T = NOW - 30 * 60_000
  const agg = buildAgg()
  addCacheSession(agg, { sessionId: S_BRIDGE, at: T })
  addCacheSession(agg, { sessionId: S_TX, at: T + 7 * 60_000 })
  const reading = {
    warm: true, ttl: '1h' as const, expiresAt: T + 3_600_000 + 30_000, hitRatio: 0.9, readAt: Math.floor((T + 60_000) / 1000),
    sessionId: S_BRIDGE, recacheIfCold: 152_300, model: 'claude-opus-5-5',
  }
  const tcfg = { zone: 'utc', dayBoundaryHour: 0, startOfWeek: 'monday', hourCycle: 'h23' } as const
  const mentions = (lines: string[], id: string): number => lines.filter((l) => l.includes(`· ${id.slice(0, 8)}\``)).length
  let listedMinutes = 0, oldMinutes = 0, coolingMinutes = 0
  for (let now = reading.expiresAt - 70 * 60_000; now <= reading.expiresAt + 70 * 60_000; now += 60_000) {
    const cacheWatch = watchCaches({ readings: [reading], mains: agg.mainEntries(), tcfg }, now, Infinity)
    const quota = state({ fetchedAt: Math.floor(now / 1000) - 60 })
    const items = buildItems(input({ quotas: [quota], now, promptCache: reading, cacheWatch, cfg: cfg(CACHE_ON) }))
    const tip = items[0].tooltipMarkdown.split('\n')
    const old = tip.filter((l) => l.startsWith('$(database) prompt cache')).length
    const listed = cacheWatch.filter((e) => e.phase !== 'warm').slice(0, CACHE_WATCH_MAX).some((e) => e.sessionId === S_BRIDGE)
    assert.ok(mentions(tip, S_BRIDGE) + old <= 1, `the quota tooltip names 9d0eb37a twice at ${now}`)
    assert.ok(mentions(tip, S_TX) <= 1, `the quota tooltip names aaaa1111 twice at ${now}`)
    // Mutation check (§3 A8 test 11): a 1.3 row printed always fails here.
    assert.equal(old === 0, listed, `the 1.3 row at ${now}: listed ${listed}`)
    assert.equal(mentions(tip, S_BRIDGE), listed ? 1 : 0, `at ${now}`)
    if (listed) listedMinutes++
    else oldMinutes++
    const bar = items.find((m) => m.id === 'tokenPace.cache')
    if (bar) {
      coolingMinutes++
      const lines = bar.tooltipMarkdown.split('\n')
      assert.ok(mentions(lines, S_BRIDGE) <= 1 && mentions(lines, S_TX) <= 1, `the cache tooltip names a session twice at ${now}`)
      assert.equal(lines.some((l) => l.startsWith('$(database)')), false, 'the cache tooltip carries the 1.3 row')
    }
    assert.equal(!!bar, cacheWatch.some((e) => e.phase === 'cooling'), `the entry at ${now}`)
  }
  assert.equal(listedMinutes, 65)
  assert.ok(oldMinutes > 0 && coolingMinutes >= 5, JSON.stringify({ oldMinutes, coolingMinutes }))
})

test('a mirror with text under every neighbouring key reaches neither the cache entry, its words nor its tooltip — of the id only its first eight characters (1.8 §0a.1 leak test)', () => {
  const file = join(scratchDir('sb-leak-cache'), 'statusline-mirror.json')
  writeLeakyMirror(file, NOW - 60_000, NOW)
  const r = readStatuslineMirror(file)
  assert.ok(r.promptCache !== null)
  const reading = { ...r.promptCache, readAt: r.state.fetchedAt, sessionId: r.sessionId, model: r.model?.id ?? null }
  // 46 minutes on, the reading's one-hour cache has four minutes left: it cools.
  const now = NOW + 46 * 60_000
  const cacheWatch = watchCaches({ readings: [reading], mains: [], tcfg: { zone: 'utc', dayBoundaryHour: 0, startOfWeek: 'monday', hourCycle: 'h23' } }, now, Infinity)
  const items = buildItems(input({ now, promptCache: reading, cacheWatch, cfg: cfg(CACHE_ON), quotas: [state({ fetchedAt: Math.floor(now / 1000) - 60 })] }))
  const item = items.find((m) => m.id === 'tokenPace.cache')
  assert.ok(item && item.ariaLabel?.includes('Session 9d0eb37a'), JSON.stringify(item))
  const text = JSON.stringify(items)
  for (const secret of LEAK_STATUS_SECRETS) assert.equal(text.includes(secret), false, `the bar holds ${secret}`)
  assert.equal(text.includes(LEAK_SESSION_ID.slice(8)), false, 'the bar holds the session id past its first eight characters')
})

test('the preview shows the prompt cache cooling, measured with a second session and estimated under a minute, in no colour (1.8 A5)', () => {
  const items = previewItems(cfg({}), NOW).filter((m) => m.text.includes('$(watch)'))
  assert.deepEqual(items.map((m) => m.text), ['[preview] $(watch) cache 4m +1', '[preview] $(watch) cache ~45s'])
  for (const m of items) {
    assert.equal(m.colorId, null)
    assert.equal(m.alarm, false)
    assert.ok(m.ariaLabel?.startsWith('[preview] Prompt cache of Session 9d0eb37a cools in '), m.ariaLabel)
    assert.ok(m.tooltipMarkdown.startsWith('**Prompt cache cooling**'), m.tooltipMarkdown)
    assert.doesNotMatch(`${m.tooltipMarkdown}${m.ariaLabel}`, /NaN|undefined/)
  }
})
