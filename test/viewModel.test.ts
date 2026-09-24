// SPDX-FileCopyrightText: 2026 Frederik Marx
// SPDX-License-Identifier: AGPL-3.0-or-later

import { strict as assert } from 'node:assert'
import * as path from 'node:path'
import { test } from 'node:test'
import { Aggregator } from '../src/agg'
import { DEFAULT_FORECAST_CONFIG } from '../src/forecast'
import { dayOf, rangeFor } from '../src/time'
import { SOURCES } from '../src/adapters'
import { budgetRows } from '../src/budget'
import { StatsCtx, cacheEconomy, calendar, composition, planFactors, totalsFor } from '../src/stats'
import { AgentLaunch, AgentRec, MainRec, ProblemKind, QuotaSample, QuotaState, QuotaWindow, TOOL_NAME_CAP } from '../src/types'
import { paceVerdict, windowElapsed } from '../src/pace'
import { QuotaHistory, THIN_RECENT_DAYS, THIN_RECENT_SLOT_MS } from '../src/quotaHistory'
import { RESET_JITTER_MS } from '../src/resetRule'
import { EARLIER_KEY, MAX_AGENT_MORE, MAX_MORE_PAGES } from '../src/agentTree'
import {
  AGENT_SELECTED_IN, DASHBOARD_SECTION_KEYS, isAgentSelectedIn, MAX_AGENT_EXPANDED, MAX_AGENT_KEY_CHARS, problemActions, SOURCE_TITLE, SPARK_DAYS,
  SPARK_SLOTS, SPARK_SLOT_MS, WEBVIEW_COMMANDS, WindowVm, agentShareOf, agentTreeFor, applyMessage, buildViewModel, defaultUiState,
  forecastsFor, SparkVm, parseWebviewMessage, pricingOf, providerViewOf, sparkOf, viewSources,
} from '../src/viewModel'
import {
  CLAUDE_FILE, FINGERPRINT, NOW, SHARE_AGENTS, TODAY, agentShareAgg, buildAgg, daysAgo, fillHistory, makeConfig, makeHistory,
  makeInput, state, timeConfig, win,
} from './fixtures/viewFixtures'
import { claudeLine, ctxFor } from './fixtures/helpers'
import { markdownDocument } from '../src/textViews'
import { toolAgg } from './helpers/toolAgg'
import { ROOT, rawManifest } from './helpers/nls'
import { readFileSync } from 'node:fs'
import { resetTimeMemos } from '../src/time'
import { resetPriceMemos } from '../src/prices'

const cfg = makeConfig()
const tcfg = timeConfig(cfg)

// ---------------------------------------------------------------------------
// buildViewModel
// ---------------------------------------------------------------------------

test('the view model is built from the aggregator, the history and the quota states', () => {
  const history = makeHistory()
  fillHistory(history)
  const vm = buildViewModel(makeInput({ history }))

  assert.equal(vm.now, NOW)
  assert.deepEqual(vm.sections, cfg.dashboard.sections)
  assert.equal(vm.range.preset, '30d')
  assert.equal(vm.range.to, TODAY)
  assert.ok(vm.range.previous)
  assert.equal(vm.range.presets.length, 10)

  assert.equal(vm.quotas.length, 2)
  assert.equal(vm.quotas[0].title, 'Claude Code')
  assert.equal(vm.quotas[0].windows.length, 2)
  assert.equal(vm.quotas[0].problem, null)
  assert.equal(vm.quotas[0].usagePageUrl, 'https://claude.ai/settings/usage')

  // The two running windows, today, 7d, 30d, this week, this month, all time — fixed periods
  // only: the table sits above the filter bar and follows no chip, so there is no selected
  // range and no previous period in it.
  for (const t of vm.totals) assert.equal(t.rows.length, 8)
  // The windows the provider reported, held against the same bounds the quota card draws.
  assert.deepEqual(vm.totals[0].rows.slice(0, 2).map((r) => r.label),
    ['Current 5 h window', 'Current 7 d window'])
  assert.equal(vm.totals[0].rows[2].label, 'Today')
  // Six figures over the range plus the "today" tile that opens the row.
  assert.equal(vm.kpis.length, 7)
  assert.equal(vm.kpis[0].key, 'today')
  assert.ok(vm.digest.length >= 3 && vm.digest.length <= 5)
  assert.equal(vm.chart.days.length, 30)
  assert.equal(vm.heatmap.weeks.length, 53)
  assert.equal(vm.hours.profile.length, 24)
  assert.ok(vm.footnotes.length >= 3)
  assert.equal(vm.firstRun, null)
  assert.equal(vm.preview, false)
})

test('a window carries its verdict, its clock and its accessibility text', () => {
  const vm = buildViewModel(makeInput())
  const w = vm.quotas[0].windows[0]
  assert.equal(w.percentText, '40%')
  assert.equal(w.elapsed, 60)
  assert.equal(w.verdict.text, '20 % of the window still spare')
  assert.equal(w.level, 'ok')
  assert.equal(w.display, 'normal')
  assert.equal(w.reset, '2h')
  assert.ok(w.resetAbsolute.length > 0)
  assert.deepEqual(w.aria, { now: 40, max: 100, text: '5 h: 40% used, 20 % of the window still spare' })
  // The "keeps it to the reset" rate is gone from every view, and with it from the model.
  assert.equal('sustainable' in w, false)
})

test('an unreadable quota names its cause and offers exactly one repair step', () => {
  const broken = state('claude', {
    ok: false, problem: 'no OAuth token found', problemKind: 'noToken', windows: [],
    nextAttemptAt: NOW + 12 * 60_000,
  })
  const vm = buildViewModel(makeInput({ quotas: [broken] }))
  const card = vm.quotas[0]
  assert.equal(card.problem, 'no OAuth token found')
  assert.equal(card.problemKind, 'noToken')
  assert.equal(card.problemAction?.command, 'tokenPace.showOutput')
  assert.ok(WEBVIEW_COMMANDS.includes(card.problemAction?.command as never))
  assert.equal(card.freshness.nextRefresh, '12m')
})

// 1.7 W1: our own fetch failed after the reading a card shows — one sentence on the card.
const FAILED_429 = { at: NOW - 20 * 60_000, problem: 'HTTP 429 — backing off before the next attempt', kind: 'retry' as const }

test('a card whose reading outlived a failed fetch of ours carries the sentence; no other card does (1.7 W1)', () => {
  const failed = state('claude', { fetchedAt: Math.round((NOW - 2 * 3_600_000) / 1000), lastFailure: FAILED_429, nextAttemptAt: NOW + 72 * 60_000 })
  const vm = buildViewModel(makeInput({ quotas: [failed, state('codex')] }))
  assert.equal(vm.quotas[0].lastFailure,
    'Last attempt at 11:40 failed: HTTP 429 — backing off before the next attempt · next attempt in 1h12m')
  assert.equal(vm.quotas[0].stale, true)
  assert.equal(vm.quotas[0].problem, null)
  assert.equal(vm.quotas[0].freshness.nextRefresh, '1h12m')
  assert.equal(vm.quotas[1].lastFailure, null)
  // The same world without the failure: the card is the 1.6 card, the new field null.
  const plain = buildViewModel(makeInput())
  assert.equal(plain.quotas[0].lastFailure, null)
  // A card without a reading says the failure as its problem, never twice.
  const broken = state('claude', { ok: false, problem: 'HTTP 429 — backing off before the next attempt', problemKind: 'retry', windows: [], lastFailure: FAILED_429 })
  const card = buildViewModel(makeInput({ quotas: [broken] })).quotas[0]
  assert.equal(card.lastFailure, null)
  assert.equal(card.problem, 'HTTP 429 — backing off before the next attempt')
  // Held for focus: the sentence ends so.
  const held = state('claude', { lastFailure: FAILED_429, nextAttemptAt: NOW - 60_000, attemptHeld: 'focus' })
  assert.equal(buildViewModel(makeInput({ quotas: [held] })).quotas[0].lastFailure,
    'Last attempt at 11:40 failed: HTTP 429 — backing off before the next attempt · next attempt waiting for focus')
})

test('a permanent cause beside a reading gives no card a sentence; a transient one does (1.7 P4b, Review 1 #2)', () => {
  const at = { fetchedAt: Math.round((NOW - 2 * 3_600_000) / 1000), nextAttemptAt: NOW + 72 * 60_000 }
  const sentence = (kind: ProblemKind): string | null => buildViewModel(makeInput({ quotas: [
    state('claude', { ...at, lastFailure: { ...FAILED_429, kind } }), state('codex'),
  ] })).quotas[0].lastFailure
  for (const kind of ['retry', 'offline', 'unknown'] as const) {
    assert.equal(sentence(kind), 'Last attempt at 11:40 failed: HTTP 429 — backing off before the next attempt · next attempt in 1h12m', kind)
  }
  for (const kind of ['noToken', 'tokenExpired', 'unauthorized', 'forbidden', 'noBinary', 'empty', 'paused', 'noFile',
    'consentPending', 'modeCache', 'quotaOff', 'follower'] as const) {
    assert.equal(sentence(kind), null, kind)
  }
  // A kind no build knows — a state from anywhere else — is no transient one either.
  assert.equal(sentence('teapot' as ProblemKind), null)
  // The Codex case of Review 1: no binary beside its transcript reading — the card is the card without it.
  const plain = buildViewModel(makeInput({ quotas: [state('claude'), state('codex', { origin: 'transcript' })] }))
  const noBinary = buildViewModel(makeInput({ quotas: [state('claude'), state('codex', { origin: 'transcript',
    lastFailure: { at: NOW - 20 * 60_000, problem: 'codex executable not found', kind: 'noBinary' } })] }))
  assert.deepEqual(noBinary.quotas, plain.quotas)
  assert.equal(markdownDocument(noBinary).includes('Last attempt'), false)
})

test('the freshness block\'s next refresh is an attempt: a countdown, due, waiting for focus — never "reset due" (1.7 W2)', () => {
  const next = (over: Partial<QuotaState>): string | null =>
    buildViewModel(makeInput({ quotas: [state('claude', over)] })).quotas[0].freshness.nextRefresh
  assert.equal(next({ nextAttemptAt: NOW + 72 * 60_000 }), '1h12m')
  assert.equal(next({ nextAttemptAt: NOW - 1 }), 'due')
  assert.equal(next({ nextAttemptAt: NOW }), 'due')
  assert.equal(next({ nextAttemptAt: NOW - 1, attemptHeld: 'focus' }), 'waiting for focus')
  assert.equal(next({ nextAttemptAt: null }), null)
  assert.equal(next({ nextAttemptAt: NaN }), null)
  for (let m = -120; m <= 120; m += 7) assert.notEqual(next({ nextAttemptAt: NOW + m * 60_000 }), 'reset due', `${m} min`)
})

test('the freshness block reports five different clocks', () => {
  const history = makeHistory()
  fillHistory(history)
  const vm = buildViewModel(makeInput({ history }))
  const f = vm.quotas[0].freshness
  assert.equal(f.lastCheck, '5 min ago')
  assert.equal(f.lastData, 'just now')
  assert.equal(f.lastEvent, '2 h ago')
  assert.equal(f.snapshotAge, TODAY)
  // Codex has no samples of its own — that is a dash, not a borrowed timestamp.
  assert.equal(vm.quotas[1].freshness.lastData, null)
})

test('the data-quality section reports coverage, sources, drift and retention', () => {
  const history = makeHistory()
  fillHistory(history)
  const vm = buildViewModel(makeInput({ history }))
  const d = vm.dataQuality
  assert.deepEqual(d.roots, ['~/.claude', '~/.codex'])
  assert.equal(d.files, 2)
  assert.equal(d.oldestDay, '2026-07-20')
  assert.equal(d.newestDay, TODAY)
  assert.equal(d.buckets.hour > 0, true)
  assert.equal(d.snapshotBytes, 40960)
  assert.deepEqual(d.unpricedModels, ['claude-experimental-x'])
  assert.equal(d.quota[0].drift[0], 'spend.used.amount_minor')
  assert.equal(d.quota[0].candidates.length, 2)
  assert.equal(d.consent, 'network access granted')
  assert.equal(d.leader, 'leader')
  assert.deepEqual(d.retention, { hourDays: 45, days: 400, historyDays: 30 })
  assert.equal(d.history.samples, 9)
  assert.equal(d.attribution, 'none')
  assert.deepEqual(d.calibration, [])
})

test('the calibration factor appears only when it was switched on', () => {
  const history = makeHistory()
  fillHistory(history)
  const vm = buildViewModel(makeInput({
    history, cfg: makeConfig({ 'tokenPace.calibration.show': true }),
  }))
  assert.ok(vm.dataQuality.calibration.length > 0)
  for (const c of vm.dataQuality.calibration) {
    assert.ok(c.text === 'not enough data' || c.text.startsWith('~'))
  }
})

test('an empty install gets a first-run card instead of a wall of dashes', () => {
  const empty = buildViewModel(makeInput({ agg: new Aggregator(), quotas: [] }))
  assert.ok(empty.firstRun)
  assert.equal(empty.firstRun?.scanning, false)
  assert.match(String(empty.firstRun?.text), /No transcripts found/)

  const scanning = buildViewModel({ ...makeInput({ agg: new Aggregator(), quotas: [] }), scanning: true })
  assert.equal(scanning.firstRun?.scanning, true)
  assert.equal(scanning.firstRun?.text, 'Reading history…')
})

test('the totals table gets the windows of its own provider, and nobody else\u2019s', () => {
  // Claude reports both windows, Codex reports none: the first table holds its rows against
  // the reported bounds, the second falls back to a trailing span and says so in its label.
  const vm = buildViewModel(makeInput({
    quotas: [state('claude'), state('codex', { ok: false, problem: 'no token', windows: [] })],
  }))
  const claude = vm.totals.find((t) => t.source === 'claude')
  const codex = vm.totals.find((t) => t.source === 'codex')
  assert.deepEqual(claude?.rows.slice(0, 2).map((r) => r.label),
    ['Current 5 h window', 'Current 7 d window'])
  assert.deepEqual(codex?.rows.slice(0, 2).map((r) => r.label), ['Last 5 h', 'Last 7 d'])
  // The window row's span is the window's own, not the range's.
  assert.equal(claude?.rows[0].spanText, '09:00 \u2192 now')
})

test('projects and sessions stay empty until attribution is switched on', () => {
  const off = buildViewModel(makeInput())
  assert.equal(off.projects.enabled, false)
  assert.deepEqual(off.projects.rows, [])
  assert.deepEqual(off.sessions.rows, [])

  const on = buildViewModel(makeInput({
    cfg: makeConfig({ 'tokenPace.attribution': 'project' }),
    agg: buildAgg('project'),
  }))
  assert.equal(on.projects.enabled, true)
  assert.ok(on.projects.rows.length >= 1)
  assert.ok(on.sessions.rows.length >= 1)
})

test('the price date is stated once, in the footnote that needs it', () => {
  const vm = buildViewModel(makeInput())
  const dated = vm.footnotes.filter((f) => f.includes('Prices as of'))
  assert.equal(dated.length, 1)
  assert.ok(dated[0].startsWith('API cost is hypothetical'))
  assert.ok(dated[0].endsWith(`Prices as of ${vm.pricing.asOf}.`))
  // Configured rates are a separate statement and stay beside it.
  const custom = buildViewModel(makeInput({
    cfg: makeConfig({ 'tokenPace.customPrices': { 'claude-opus-4-6': { input: 1, output: 2 } } }),
  }))
  assert.equal(custom.pricing.custom, true)
  assert.equal(custom.footnotes.filter((f) => f.includes('Prices as of')).length, 1)
  assert.equal(custom.footnotes.filter((f) => f.includes('configured rates')).length, 1)
})

// 1.7 F1 (pinned and changed): 1.6's provider chips stopped at the Tokens section, which showed every
// provider whatever they said. The provider switch stands above the whole page, so it reaches the
// Tokens section too; the model chips still do not.
test('the model filter and the provider switch reach every filtered section; the switch reaches the Tokens section and the model filter does not (1.7 F1)', () => {
  const only = buildViewModel(makeInput({ ui: { providers: ['codex'], models: ['gpt-5.3-codex'] } }))
  assert.deepEqual(only.models.rows.map((r) => r.model), ['gpt-5.3-codex'])
  assert.equal(only.chart.series.length, 1)
  // The Tokens section is fixed periods of every model of the provider the switch shows — a table
  // up there that quietly narrowed to a model chip would be read as the provider's whole.
  const whole = buildViewModel(makeInput())
  const codex = buildViewModel(makeInput({ ui: { providers: ['codex'] } }))
  assert.equal(only.totals.length, 1)
  assert.deepEqual(only.totals.map((t) => t.source), ['codex'])
  // The model chip does not reach it: the same tables as the switch alone gives.
  assert.deepEqual(only.totals, codex.totals)
  assert.deepEqual(only.composition, codex.composition)
  assert.deepEqual(only.cacheEconomy, codex.cacheEconomy)
  assert.deepEqual(only.calendar, codex.calendar)
  assert.deepEqual(only.planFactor, codex.planFactor)
  // And they are the Codex part of All's, figure for figure: the switch hides, it recomputes nothing.
  assert.deepEqual(only.totals, whole.totals.filter((t) => t.source === 'codex'))
  assert.deepEqual(only.composition, whole.composition.filter((c) => c.source === 'codex'))
  assert.deepEqual(only.cacheEconomy, whole.cacheEconomy.filter((c) => c.source === 'codex'))
  assert.equal(only.cacheEconomy.length, 1)
  // The calendar periods are one sum over the view's providers: Codex's alone is less than both.
  assert.notDeepEqual(only.calendar, whole.calendar)
})

test('the chart is stacked by provider and model and carries the configured style', () => {
  const vm = buildViewModel(makeInput())
  assert.equal(vm.chart.modelStyle, 'pattern')
  assert.ok(vm.chart.series.length > 1)
  assert.equal(vm.chart.series.every((s) => s.key === `${s.source}:${s.label}`), true)
  // No stacking by provider to switch any more: neither the chart nor the UI state carries one.
  // (1.6 O2's split by main session and subagent is `split` / `chartSplit`, by model by default.)
  assert.equal('stack' in vm.chart, false)
  assert.equal('chartStack' in vm.ui, false)
  assert.deepEqual([vm.chart.split, vm.ui.chartSplit], ['model', 'model'])
  const shaded = buildViewModel(makeInput({ cfg: makeConfig({ 'tokenPace.chart.modelStyle': 'shade' }) }))
  assert.equal(shaded.chart.modelStyle, 'shade')
})

test('the drill-down opens one day and nothing else', () => {
  const vm = buildViewModel(makeInput({ ui: { drillDay: TODAY } }))
  assert.equal(vm.drill?.day, TODAY)
  assert.ok((vm.drill?.models.length ?? 0) >= 2)
  assert.equal(buildViewModel(makeInput()).drill, null)
})

// ---------------------------------------------------------------------------
// forecasts and sparklines
// ---------------------------------------------------------------------------

test('forecastsFor keys every window of every source', () => {
  const history = makeHistory()
  fillHistory(history)
  const map = forecastsFor(
    [state('claude'), state('codex')], history, { claude: FINGERPRINT, codex: FINGERPRINT },
    DEFAULT_FORECAST_CONFIG, NOW, cfg.pace, tcfg,
  )
  assert.deepEqual([...map.keys()].sort(), [
    'claude:session:300', 'claude:weekly_all:10080', 'codex:session:300', 'codex:weekly_all:10080',
  ])
  // Nine readings rising three points every quarter hour: a real slope, and the window
  // resets before it could run empty.
  assert.equal(map.get('claude:session:300')?.state, 'resetsFirst')
  assert.equal(map.get('claude:weekly_all:10080')?.state, 'none')
})

test('a broken quota state contributes no forecast at all', () => {
  const history = makeHistory()
  fillHistory(history)
  const map = forecastsFor(
    [state('claude', { ok: false, problem: 'offline', windows: [] })], history,
    { claude: FINGERPRINT, codex: FINGERPRINT }, DEFAULT_FORECAST_CONFIG, NOW, cfg.pace,
  )
  assert.equal(map.size, 0)
})

const MIN = 60_000
const DAY = 24 * 3_600_000
const sample = (t: number, p: number, r: number | null = null): QuotaSample =>
  ({ s: 'claude', w: 'w', t, p, r, o: 'poll', f: FINGERPRINT })

test('the sparkline grid is seven days of quarter hours ending in the slot that holds now', () => {
  assert.equal(SPARK_SLOT_MS, 15 * MIN)
  assert.equal(SPARK_DAYS, 7)
  assert.equal(SPARK_SLOTS, 672)
  // The history thins to the same grid, so one stored sample is one slot.
  assert.equal(THIN_RECENT_SLOT_MS, SPARK_SLOT_MS)
  assert.equal(THIN_RECENT_DAYS, SPARK_DAYS)
  const vm = sparkOf([], NOW, 300, cfg.pace, tcfg)
  assert.equal(vm.slots, SPARK_SLOTS)
  assert.equal(vm.to - vm.from, SPARK_DAYS * DAY)
  assert.ok(vm.from <= NOW && NOW < vm.to, 'now lies inside the grid')
  assert.equal(vm.to, Math.floor(NOW / SPARK_SLOT_MS) * SPARK_SLOT_MS + SPARK_SLOT_MS, 'slots are aligned to the quarter hour')
  assert.ok(NOW - vm.from >= (SPARK_SLOTS - 1) * SPARK_SLOT_MS, 'at most one partial slot is missing from the seven days')
  assert.deepEqual(vm.points, [])
  // An unaligned now still ends in the slot that contains it.
  const odd = sparkOf([sample(NOW + 7 * MIN, 10)], NOW + 7 * MIN, 300, cfg.pace, tcfg)
  assert.equal(odd.points[0].i, SPARK_SLOTS - 1)
  assert.ok(odd.from <= NOW + 7 * MIN - (SPARK_SLOTS - 1) * SPARK_SLOT_MS)
})

test('samples land in the slot their time falls into; older than the grid they are dropped', () => {
  const { from } = sparkOf([], NOW, 300, cfg.pace, tcfg)
  const vm = sparkOf([
    sample(from - 1, 5),               // one millisecond before the grid: gone, not stretched
    sample(from, 10),                  // start of the grid (seven days less one slot before now)
    sample(NOW - 15 * MIN, 40),        // one slot before the slot of now
    sample(NOW, 42),                   // the slot of now is the last one
    sample(NOW - 3 * DAY, 30),
  ], NOW, 300, cfg.pace, tcfg)
  assert.deepEqual(vm.points.map((p) => [p.i, p.p]), [
    [0, 10], [SPARK_SLOTS - 1 - 3 * 96, 30], [SPARK_SLOTS - 2, 40], [SPARK_SLOTS - 1, 42],
  ])
  // Older than the whole window: nothing at all rather than a line from nowhere.
  assert.deepEqual(sparkOf([sample(NOW - 40 * DAY, 90)], NOW, 300, cfg.pace, tcfg).points, [])
  // Ascending, unique, inside the grid — the renderer relies on it.
  const ids = vm.points.map((p) => p.i)
  assert.deepEqual(ids, [...new Set(ids)].sort((a, b) => a - b))
  assert.ok(ids.every((i) => i >= 0 && i < SPARK_SLOTS))
})

test('the last reading of a slot wins', () => {
  const t0 = Math.floor(NOW / SPARK_SLOT_MS) * SPARK_SLOT_MS - SPARK_SLOT_MS
  const vm = sparkOf([sample(t0 + 9 * MIN, 30), sample(t0 + MIN, 10), sample(t0 + 5 * MIN, 20)], NOW, 300, cfg.pace, tcfg)
  assert.deepEqual(vm.points.map((p) => [p.i, p.p]), [[SPARK_SLOTS - 2, 30]])
})

test('every point carries the pace level the bar would have shown at that time', () => {
  const r = NOW + 2 * 3_600_000
  const t = NOW - 30 * MIN
  const vm = sparkOf([sample(t, 70, r), sample(NOW, 20, r)], NOW, 300, cfg.pace, tcfg)
  const expected = paceVerdict(70, windowElapsed(r, 300, t), cfg.pace)
  assert.equal(expected.level, 'warn', 'the fixture is ahead of pace, or the test proves nothing')
  assert.equal(vm.points[0].level, 'warn')
  assert.equal(vm.points[1].level, paceVerdict(20, windowElapsed(r, 300, NOW), cfg.pace).level)
  assert.equal(vm.points[1].level, 'ok')
  // No clock: no verdict — from the sample's side or from the window's.
  assert.equal(sparkOf([sample(t, 70, null)], NOW, 300, cfg.pace, tcfg).points[0].level, null)
  assert.equal(sparkOf([sample(t, 70, r)], NOW, null, cfg.pace, tcfg).points[0].level, null)
  // Except nothing used, which is on pace by any clock — an idle window reports no reset
  // time, and a neutral stroke along the floor would read as a reset that never happened.
  assert.equal(sparkOf([sample(t, 0, null)], NOW, 300, cfg.pace, tcfg).points[0].level, 'ok')
  assert.equal(sparkOf([sample(t, 0, r)], NOW, null, cfg.pace, tcfg).points[0].level, 'ok')
  // Exhausted is a fact, not a pace: 'error' with or without a clock, like the bar.
  assert.equal(sparkOf([sample(t, 100, r)], NOW, 300, cfg.pace, tcfg).points[0].level, 'error')
  assert.equal(sparkOf([sample(t, 99.5, null)], NOW, null, cfg.pace, tcfg).points[0].level, 'error')
})

test('a young window heavy with usage is judged by every view, not left measuring', () => {
  // Half a minute into a five-hour window with 60 % of it already spent: the clock has barely
  // run, but the reading is far too big to be an artefact of that. Bar colour, verdict
  // sentence, accessibility text and the sparkline all read the one verdict, so they turn
  // together — there is no second rule anywhere.
  const resetsAt = NOW + 5 * 3_600_000 - 30_000
  const vm = buildViewModel(makeInput({
    quotas: [state('claude', { windows: [win({ percent: 60, resetsAt, windowMinutes: 300 })] })],
  }))
  const w = vm.quotas[0].windows[0]
  assert.equal(w.verdict.measuring, false)
  assert.equal(w.level, 'warn')
  assert.equal(w.verdict.text, '60 % ahead of pace')
  assert.equal(w.aria.text, '5 h: 60% used, 60 % ahead of pace')
  assert.equal(sparkOf([sample(NOW, 60, resetsAt)], NOW, 300, cfg.pace, tcfg).points[0].level, 'warn')
  // A small bill in the same young window still gets the benefit of the doubt.
  const small = buildViewModel(makeInput({
    quotas: [state('claude', { windows: [win({ percent: 6, resetsAt, windowMinutes: 300 })] })],
  })).quotas[0].windows[0]
  assert.equal(small.verdict.measuring, true)
  assert.equal(small.level, 'ok')
  assert.equal(small.aria.text, '5 h: 6% used')
  assert.equal(sparkOf([sample(NOW, 6, resetsAt)], NOW, 300, cfg.pace, tcfg).points[0].level, 'ok')
})

test('a reading the window turned over before is flagged so its stroke can stay neutral', () => {
  const r1 = NOW + 3_600_000
  const r2 = NOW + 6 * 3_600_000
  const at = (slotsAgo: number) => NOW - slotsAgo * SPARK_SLOT_MS
  const flags = (vm: SparkVm) => vm.points.map((p) => p.reset)
  const vm = sparkOf([
    sample(at(3), 80, r1), sample(at(2), 90, r1), sample(at(1), 5, r2), sample(at(0), 12, r2),
  ], NOW, 300, cfg.pace, tcfg)
  assert.deepEqual(flags(vm), [undefined, undefined, true, undefined])
  // The first point of the whole line never carries it: there is no stroke leading into it.
  assert.equal(sparkOf([sample(at(1), 5, r2)], NOW, 300, cfg.pace, tcfg).points[0].reset, undefined)
  // The reset history's rule, plus a fall: a moved reset time the value ROSE across — a new
  // window already in use when it was first read — turned over, but there is no drop to
  // draw, so its stroke stays an ordinary one in the pace colour. A fall of five points
  // without a moved reset is a reset the provider did not announce.
  const rose = sparkOf([sample(at(1), 2, r1), sample(at(0), 22, r2)], NOW, 300, cfg.pace, tcfg)
  assert.deepEqual(flags(rose), [undefined, undefined])
  const fell = sparkOf([sample(at(1), 20, r1), sample(at(0), 4, r1)], NOW, 300, cfg.pace, tcfg)
  assert.deepEqual(flags(fell), [undefined, true])
  const dipped = sparkOf([sample(at(1), 20, r1), sample(at(0), 16, r1)], NOW, 300, cfg.pace, tcfg)
  assert.deepEqual(flags(dipped), [undefined, undefined], 'a four-point dip is a correction')
  // A missing reset time says nothing: appearing or vanishing is not a turn of the window.
  const appears = sparkOf([sample(at(1), 5, null), sample(at(0), 6, r2)], NOW, 300, cfg.pace, tcfg)
  assert.deepEqual(flags(appears), [undefined, undefined])
  const vanishes = sparkOf([sample(at(1), 5, r2), sample(at(0), 6, null)], NOW, 300, cfg.pace, tcfg)
  assert.deepEqual(flags(vanishes), [undefined, undefined])
  // Claude Code's usage cache writes the reset time with sub-second jitter: not a reset. The
  // whole line was neutral once because every reading looked like one.
  const jitter = sparkOf([
    sample(at(3), 20, r1), sample(at(2), 25, r1 - 114), sample(at(1), 30, r1 + 18), sample(at(0), 35, r1 + RESET_JITTER_MS),
  ], NOW, 300, cfg.pace, tcfg)
  assert.deepEqual(flags(jitter), [undefined, undefined, undefined, undefined])
  // An idle rolling window reports "now + window length": the reset time rides along with
  // the clock, and that is not a reset either.
  const riding = sparkOf([
    sample(at(2), 0, at(2) + 5 * 3_600_000), sample(at(1), 0, at(1) + 5 * 3_600_000 + 1000),
    sample(at(0), 0, at(0) + 5 * 3_600_000),
  ], NOW, 300, cfg.pace, tcfg)
  assert.deepEqual(flags(riding), [undefined, undefined, undefined])
  // A stretch without readings changes nothing: the flag is about the two readings either
  // side of it, and the renderer draws the stroke across whatever lies between them.
  const hole = sparkOf([sample(at(9), 20, r1), sample(at(2), 25, r1)], NOW, 300, cfg.pace, tcfg)
  assert.deepEqual(flags(hole), [undefined, undefined])
  const dark = sparkOf([sample(at(9), 20, r1), sample(at(2), 3, r2)], NOW, 300, cfg.pace, tcfg)
  assert.deepEqual(flags(dark), [undefined, true])
})

test('every point carries its time, its reset clock and a label with the day, the clock and the percentage', () => {
  const r = NOW + 2 * 3_600_000
  const t = NOW - 30 * MIN
  const [pt] = sparkOf([sample(t, 37.4, r)], NOW, 300, cfg.pace, tcfg).points
  assert.equal(pt.t, t)
  assert.equal(pt.r, r)
  // The fixture's clock: UTC, 24 hours; NOW is a Thursday noon. The percentage is rounded
  // to the whole percent every other view prints.
  assert.equal(pt.label, 'Thu 3 Sep · 11:30 · 37 %')
  // The label follows the configured hour cycle and zone exactly as the reset times do.
  assert.equal(sparkOf([sample(t, 37.4, r)], NOW, 300, cfg.pace, { ...tcfg, hourCycle: 'h12' }).points[0].label,
    'Thu 3 Sep · 11:30 AM · 37 %')
  assert.equal(sparkOf([sample(t, 37.4, r)], NOW, 300, cfg.pace, { ...tcfg, zone: 'Europe/Berlin' }).points[0].label,
    'Thu 3 Sep · 13:30 · 37 %')
  // A day boundary in the zone: 23:30 UTC is already Friday in Berlin.
  const late = NOW + 11.5 * 3_600_000
  assert.equal(sparkOf([sample(late, 5)], late, 300, cfg.pace, { ...tcfg, zone: 'Europe/Berlin' }).points[0].label,
    'Fri 4 Sep · 01:30 · 5 %')
  // No reset time stays null — never a 0, never a clock invented for the drop to stand at.
  assert.equal(sparkOf([sample(t, 1)], NOW, 300, cfg.pace, tcfg).points[0].r, null)
  assert.equal(sparkOf([sample(t, 1, NaN)], NOW, 300, cfg.pace, tcfg).points[0].r, null)
  // A flagged reading says so.
  const r2 = NOW + 6 * 3_600_000
  const flagged = sparkOf([sample(NOW - 15 * MIN, 80, r), sample(NOW, 5, r2)], NOW, 300, cfg.pace, tcfg).points
  assert.equal(flagged[1].reset, true)
  assert.equal(flagged[1].label, 'Thu 3 Sep · 12:00 · 5 % · reset')
  assert.equal(flagged[0].label, 'Thu 3 Sep · 11:45 · 80 %')
})

test('the line is described in words for the screen reader', () => {
  const r = NOW + 2 * 3_600_000
  assert.equal(sparkOf([], NOW, 300, cfg.pace, tcfg).aria, 'quota sparkline, 7 days, no readings')
  assert.equal(sparkOf([sample(NOW, 5, r)], NOW, 300, cfg.pace, tcfg).aria,
    'quota sparkline, 7 days, 1 reading, peak 5 %')
  assert.equal(sparkOf([sample(NOW - 30 * MIN, 70.4, r), sample(NOW, 20, r)], NOW, 300, cfg.pace, tcfg).aria,
    'quota sparkline, 7 days, 2 readings, peak 70 %')
})

test('a pinned Codex window that ends under five points is flagged where it dropped', () => {
  // Fixed at 4 % for its five hours; when it ended the value fell to 0 and the reset clock
  // rode along with the time again. resetMoved cannot see that, and the fall is under five
  // points — the passed reset with the fall after it is the mark (resetRule.resetPassed).
  const at = (slotsAgo: number) => NOW - slotsAgo * SPARK_SLOT_MS
  const pinned = sample(at(24), 4, at(24) + 5 * 3_600_000)
  const ended = sample(at(2), 0, at(2) + 5 * 3_600_000)
  const vm = sparkOf([pinned, ended], NOW, 300, cfg.pace, tcfg)
  assert.deepEqual(vm.points.map((p) => p.reset), [undefined, true])
  assert.equal(vm.points[1].label.endsWith(' · reset'), true)
  // The reset the drop stands at is carried on the point before it.
  assert.equal(vm.points[0].r, at(24) + 5 * 3_600_000)
})

test('the quota card carries the sparkline and its own gap count', () => {
  const history = makeHistory()
  fillHistory(history)
  const vm = buildViewModel(makeInput({ history }))
  const card = vm.quotas[0].windows.find((w) => w.id === 'session:300') as WindowVm
  assert.equal(card.spark.points.length, 9, 'nine readings a quarter hour apart: nine slots')
  assert.equal(card.spark.points[8].i, SPARK_SLOTS - 1)
  // Readings a quarter hour apart leave no hole between them.
  assert.equal(card.gaps, 0)
  // A window with no series at all has no reading to count a gap against.
  const bare = vm.quotas[0].windows.find((w) => w.id === 'weekly_all:10080') as WindowVm
  assert.equal(bare.gaps, 0)

  // One reading ten hours before the series is a stretch nobody measured, and the exporter's
  // footnote counts it off the card.
  const holed = makeHistory()
  holed.add(
    { source: 'claude', ok: true, origin: 'poll', fetchedAt: Math.round((NOW - 10 * 3_600_000) / 1000), planType: null, windows: [win({ percent: 5 })] },
    FINGERPRINT,
    NOW - 10 * 3_600_000,
  )
  fillHistory(holed)
  const gapped = buildViewModel(makeInput({ history: holed }))
  const w5 = gapped.quotas[0].windows.find((w) => w.id === 'session:300') as WindowVm
  assert.equal(w5.gaps, 1)
})

// ---------------------------------------------------------------------------
// message protocol
// ---------------------------------------------------------------------------

test('parseWebviewMessage accepts the rendered acknowledgement only with a sane count', () => {
  assert.deepEqual(parseWebviewMessage({ type: 'rendered', sections: 3 }), { type: 'rendered', sections: 3 })
  assert.deepEqual(parseWebviewMessage({ type: 'rendered', sections: 2.9 }), { type: 'rendered', sections: 2 })
  for (const bad of ['3', -1, Number.NaN, Number.POSITIVE_INFINITY, undefined, null]) {
    assert.equal(parseWebviewMessage({ type: 'rendered', sections: bad }), null, String(bad))
  }
})

test('parseWebviewMessage accepts exactly the documented shapes', () => {
  assert.deepEqual(parseWebviewMessage({ type: 'setRange', preset: '7d' }), { type: 'setRange', preset: '7d' })
  assert.deepEqual(parseWebviewMessage({ type: 'setRange', from: '2026-01-01', to: '2026-01-31' }),
    { type: 'setRange', from: '2026-01-01', to: '2026-01-31' })
  assert.deepEqual(parseWebviewMessage({ type: 'setSort', key: 'cost', dir: 'asc' }),
    { type: 'setSort', key: 'cost', dir: 'asc' })
  assert.deepEqual(parseWebviewMessage({ type: 'setFilter', providers: ['claude'], models: ['a'] }),
    { type: 'setFilter', providers: ['claude'], models: ['a'] })
  assert.deepEqual(parseWebviewMessage({ type: 'setMetric', metric: 'cacheRead' }),
    { type: 'setMetric', metric: 'cacheRead' })
  assert.deepEqual(parseWebviewMessage({ type: 'setCompositionCache', mode: 'noCache' }),
    { type: 'setCompositionCache', mode: 'noCache' })
  assert.deepEqual(parseWebviewMessage({ type: 'setCompositionCache', mode: 'all' }),
    { type: 'setCompositionCache', mode: 'all' })
  assert.deepEqual(parseWebviewMessage({ type: 'setHeatmapMetric', metric: 'cost' }),
    { type: 'setHeatmapMetric', metric: 'cost' })
  assert.deepEqual(parseWebviewMessage({ type: 'setHourZone', zone: 'utc' }), { type: 'setHourZone', zone: 'utc' })
  assert.deepEqual(parseWebviewMessage({ type: 'drill', day: '2026-09-01' }), { type: 'drill', day: '2026-09-01' })
  assert.deepEqual(parseWebviewMessage({ type: 'drill', day: null }), { type: 'drill', day: null })
  assert.deepEqual(parseWebviewMessage({ type: 'refresh' }), { type: 'refresh' })
  assert.deepEqual(parseWebviewMessage({ type: 'command', id: 'tokenPace.rescan' }),
    { type: 'command', id: 'tokenPace.rescan' })
  assert.deepEqual(parseWebviewMessage({ type: 'openSectionSettings', key: 'quota' }),
    { type: 'openSectionSettings', key: 'quota' })
})

test('the section gear names a section, never a setting', () => {
  // The webview may ask for one of the sections it renders; which settings that section is
  // made of is decided in the extension, so a message can never point the settings editor at
  // something the page made up.
  for (const key of DASHBOARD_SECTION_KEYS) {
    assert.deepEqual(parseWebviewMessage({ type: 'openSectionSettings', key }),
      { type: 'openSectionSettings', key })
  }
  for (const raw of [{ type: 'openSectionSettings' },
    { type: 'openSectionSettings', key: 'tokenPace.debug' },
    { type: 'openSectionSettings', key: 'controls' },
    { type: 'openSectionSettings', key: 7 }]) {
    assert.equal(parseWebviewMessage(raw), null, JSON.stringify(raw))
  }
  // Opening the settings changes no view state, so the UI state comes back unchanged — by
  // identity, which is what tells the caller there is nothing to persist.
  const ui = defaultUiState(cfg)
  assert.equal(applyMessage(ui, { type: 'openSectionSettings', key: 'kpis' }), ui)
})

test('parseWebviewMessage drops everything else', () => {
  const bad: unknown[] = [
    null, undefined, 42, 'setRange', [], { }, { type: 'eval' }, { type: 'setRange' },
    { type: 'setRange', preset: 'lastCentury' },
    { type: 'setRange', from: '2026-13-01', to: '2026-13-02' },
    { type: 'setRange', from: '2026-02-01', to: '2026-01-01' },
    // Six years of days: beyond the documented five-year ceiling.
    { type: 'setRange', from: '2020-01-01', to: '2026-01-01' },
    { type: 'setSort', key: 'password', dir: 'desc' },
    { type: 'setSort', key: 'cost', dir: 'sideways' },
    { type: 'setFilter', providers: ['claude', 'evil'], models: [] },
    { type: 'setFilter', providers: [], models: Array.from({ length: 51 }, (_, i) => `m${i}`) },
    { type: 'setFilter', providers: [], models: ['x'.repeat(81)] },
    { type: 'setFilter', providers: [], models: [123] },
    { type: 'setMetric', metric: 'passwords' },
    { type: 'setHeatmapMetric', metric: 'requests' },
    // The stacking message of older pages (by provider / by model, gone since 1.2.2) is nothing —
    // 1.6's split by main session and subagent is a message of its own, `setChartSplit`.
    { type: 'setChartStack', stack: 'model' },
    { type: 'setChartStack', stack: 'provider' },
    { type: 'setChartStack' },
    { type: 'setCompositionCache', mode: 'none' },
    { type: 'setCompositionCache' },
    { type: 'setHourZone', zone: 'mars' },
    { type: 'drill', day: 'yesterday' },
    { type: 'command', id: 'workbench.action.terminal.new' },
    { type: 'command', id: 'tokenPace.disconnectStatusLine' },
    { type: 'toggleSection' },
    { type: 'toggleSection', key: 'passwords' },
    { type: 'toggleSection', key: 42 },
  ]
  for (const raw of bad) assert.equal(parseWebviewMessage(raw), null, JSON.stringify(raw) ?? 'undefined')
})

test('parseWebviewMessage keeps the command allow-list to twelve harmless commands', () => {
  // Eleven, not nine: the empty quota state offers the two ways to get a reading, and both
  // of those commands ask before they act — connecting the status line goes through its own
  // write consent and writes its own backup. Twelve since 1.6 (D11): the details' Copy ID
  // copies the id the panel already shows and takes no argument the page could choose.
  assert.equal(WEBVIEW_COMMANDS.length, 12)
  assert.equal(WEBVIEW_COMMANDS.includes('tokenPace.copyAgentId'), true)
  for (const id of WEBVIEW_COMMANDS) {
    assert.deepEqual(parseWebviewMessage({ type: 'command', id }), { type: 'command', id })
    assert.match(id, /^tokenPace\./)
  }
  // Nothing that undoes a user's setting behind their back.
  assert.equal(WEBVIEW_COMMANDS.includes('tokenPace.disconnectStatusLine' as never), false)
})

test('every repair step a card offers is a command its own view can run', () => {
  for (const [kind, action] of Object.entries(problemActions())) {
    assert.ok(
      WEBVIEW_COMMANDS.includes(action.command as never),
      `${kind}: ${action.command} is offered as a button the webview cannot send`,
    )
  }
})

test('every problem kind names one repair step, and the follower is sent to the dashboard', () => {
  assert.deepEqual(
    Object.fromEntries(Object.entries(problemActions()).map(([k, a]) => [k, a.command])),
    {
      noToken: 'tokenPace.showOutput',
      tokenExpired: 'tokenPace.showOutput',
      consentPending: 'tokenPace.refreshQuota',
      modeCache: 'tokenPace.openSettings',
      retry: 'tokenPace.refreshQuota',
      offline: 'tokenPace.refreshQuota',
      forbidden: 'tokenPace.showOutput',
      unauthorized: 'tokenPace.showOutput',
      noBinary: 'tokenPace.openSettings',
      quotaOff: 'tokenPace.openSettings',
      noFile: 'tokenPace.rescan',
      empty: 'tokenPace.rescan',
      paused: 'tokenPace.refreshQuota',
      follower: 'tokenPace.showDashboard',
      unknown: 'tokenPace.showOutput',
    },
  )
  const labels = new Set(Object.values(problemActions()).map((a) => a.label))
  assert.deepEqual([...labels].sort(),
    ['Fetch quota now', 'Open dashboard', 'Open settings', 'Re-read history', 'Show log'])
})

test('applyMessage folds a message into the UI state and nothing more', () => {
  const ui = defaultUiState(cfg)
  assert.deepEqual(ui, {
    range: '30d',
    sort: { key: 'usage', dir: 'desc' },
    providers: ['claude', 'codex'],
    models: [],
    metric: 'usage',
    compositionCache: 'all',
    heatmapMetric: 'usage',
    hourZone: 'local',
    drillDay: null,
    collapsed: [],
    agentsExpanded: [],
    agentSelected: null,
    agentSelectedIn: 'tree',
    agentsMore: [],
    // 1.6 L3: the 7-day block starts closed.
    agentsWeekOpen: false,
    // 1.6 O2: the chart is split by model until the reader presses its "subagents" chip.
    chartSplit: 'model',
  })

  const drilled = applyMessage(ui, { type: 'drill', day: '2026-09-01' })
  assert.equal(drilled.drillDay, '2026-09-01')
  // A new range closes a drill that the range may no longer cover.
  assert.equal(applyMessage(drilled, { type: 'setRange', preset: 'today' }).drillDay, null)
  assert.deepEqual(applyMessage(ui, { type: 'setRange', from: '2026-01-01', to: '2026-01-02' }).range,
    { from: '2026-01-01', to: '2026-01-02' })
  assert.deepEqual(applyMessage(ui, { type: 'setSort', key: 'cost', dir: 'asc' }).sort,
    { key: 'cost', dir: 'asc' })
  assert.equal(applyMessage(ui, { type: 'setMetric', metric: 'output' }).metric, 'output')
  assert.equal(
    applyMessage(ui, { type: 'setCompositionCache', mode: 'noCache' }).compositionCache, 'noCache')
  assert.equal(applyMessage(ui, { type: 'setHeatmapMetric', metric: 'cost' }).heatmapMetric, 'cost')
  assert.equal(applyMessage(ui, { type: 'setHourZone', zone: 'utc' }).hourZone, 'utc')
  assert.deepEqual(applyMessage(ui, { type: 'setFilter', providers: ['codex'], models: ['m'] }).providers, ['codex'])
  // Switching every provider off would leave a dashboard of dashes: the last one stays.
  assert.deepEqual(applyMessage(ui, { type: 'setFilter', providers: [], models: [] }).providers,
    ['claude', 'codex'])
  // A refresh and a command change nothing, and say so by identity.
  assert.equal(applyMessage(ui, { type: 'refresh' }), ui)
  assert.equal(applyMessage(ui, { type: 'command', id: 'tokenPace.rescan' }), ui)
})

test('the chart\'s split is one of two words, stored in the UI state and drawn by the view model (1.6 O2)', () => {
  // The chip's message carries the split it asks for, and nothing but the two words passes.
  for (const split of ['model', 'agents'] as const) {
    assert.deepEqual(parseWebviewMessage({ type: 'setChartSplit', split }), { type: 'setChartSplit', split })
  }
  for (const raw of [{ type: 'setChartSplit' }, { type: 'setChartSplit', split: 'provider' }, { type: 'setChartSplit', split: 'Agents' },
    { type: 'setChartSplit', split: 1 }, { type: 'setChartSplit', split: null }, { type: 'setChartSplit', split: ['agents'] }]) {
    assert.equal(parseWebviewMessage(raw), null, JSON.stringify(raw))
  }
  const ui = defaultUiState(cfg)
  const split = applyMessage(ui, { type: 'setChartSplit', split: 'agents' })
  assert.equal(split.chartSplit, 'agents')
  assert.equal(ui.chartSplit, 'model', 'the input state was mutated')
  // Asking for the split already drawn changes nothing: the same object, nothing to store.
  assert.equal(applyMessage(split, { type: 'setChartSplit', split: 'agents' }), split)
  assert.equal(applyMessage(split, { type: 'setChartSplit', split: 'model' }).chartSplit, 'model')
  // Only the chart follows it: every other part of the view model is the one the models split builds.
  const byModel = buildViewModel(makeInput())
  const byAgents = buildViewModel(makeInput({ ui: { chartSplit: 'agents' } }))
  assert.equal(byModel.chart.split, 'model')
  assert.equal(byAgents.chart.split, 'agents')
  assert.ok(byAgents.chart.series.length > 0)
  assert.equal(byAgents.chart.series.every((s) => s.key === `${s.source}:main` || s.key === `${s.source}:sub`), true,
    JSON.stringify(byAgents.chart.series.map((s) => s.key)))
  assert.deepEqual(byAgents.chart.days, byModel.chart.days)
  for (let i = 0; i < byModel.chart.days.length; i++) {
    const col = (vm: typeof byModel): number => vm.chart.series.reduce((t, s) => t + s.values[i], 0)
    assert.equal(col(byAgents), col(byModel), byModel.chart.days[i])
  }
  const { chart: _a, ui: _b, ...restModel } = byModel
  const { chart: _c, ui: _d, ...restAgents } = byAgents
  assert.deepEqual(restAgents, restModel)
})

test('the agents section sits directly after quota, in the fold list and in the manifest default', () => {
  assert.equal(DASHBOARD_SECTION_KEYS[0], 'quota')
  assert.equal(DASHBOARD_SECTION_KEYS[1], 'agents')
  const manifest = rawManifest as {
    contributes: { configuration: Array<{ properties?: Record<string, { default?: unknown }> }> }
  }
  let sections: unknown
  for (const group of manifest.contributes.configuration) {
    const p = group.properties?.['tokenPace.dashboard.sections']
    if (p) sections = p.default
  }
  assert.ok(Array.isArray(sections), 'tokenPace.dashboard.sections has no default array')
  const order = sections as string[]
  assert.equal(order.indexOf('agents'), order.indexOf('quota') + 1, order.join(','))
  // The config's own default says the same as the manifest's; the tree starts with nothing open.
  assert.deepEqual(defaultUiState(cfg).agentsExpanded, [])
  assert.equal(cfg.dashboard.sections.indexOf('agents'), cfg.dashboard.sections.indexOf('quota') + 1)
})

test('an agent node toggle opens and closes it, and the selection sets and clears, by identity when nothing changes', () => {
  const ui = defaultUiState(cfg)
  // The tree starts collapsed: nothing is open until the reader opens it.
  assert.deepEqual(ui.agentsExpanded, [])
  const opened = applyMessage(ui, { type: 'agentToggle', key: 's:9d0eb37a' })
  assert.deepEqual(opened.agentsExpanded, ['s:9d0eb37a'])
  assert.deepEqual(ui.agentsExpanded, [], 'the input state was mutated')
  const both = applyMessage(opened, { type: 'agentToggle', key: 'w:9d0eb37a|wf_1' })
  assert.deepEqual(both.agentsExpanded, ['s:9d0eb37a', 'w:9d0eb37a|wf_1'])
  // The same toggle again closes it, and nothing else.
  assert.deepEqual(applyMessage(both, { type: 'agentToggle', key: 's:9d0eb37a' }).agentsExpanded,
    ['w:9d0eb37a|wf_1'])
  assert.deepEqual(applyMessage(applyMessage(opened, { type: 'agentToggle', key: 's:9d0eb37a' }),
    { type: 'agentToggle', key: 's:9d0eb37a' }).agentsExpanded, ['s:9d0eb37a'], 'toggling twice is back where it was')

  // A selection opens the details and nothing else: which nodes are open stays the reader's.
  const selected = applyMessage(ui, { type: 'agentSelect', key: 'l:toolu_01' })
  assert.equal(selected.agentSelected, 'l:toolu_01')
  assert.deepEqual(selected.agentsExpanded, [], 'a selection opened a node')
  assert.deepEqual(applyMessage(both, { type: 'agentSelect', key: 'a:a94f0001' }).agentsExpanded, both.agentsExpanded)
  assert.equal(applyMessage(selected, { type: 'agentSelect', key: 'l:toolu_01' }), selected)
  assert.equal(applyMessage(selected, { type: 'agentSelect', key: null }).agentSelected, null)
  assert.equal(applyMessage(ui, { type: 'agentSelect', key: null }), ui)
  // Over-long keys change nothing even when they reach applyMessage directly.
  const long = 'x'.repeat(MAX_AGENT_KEY_CHARS + 1)
  assert.equal(applyMessage(ui, { type: 'agentToggle', key: long }), ui)
  assert.equal(applyMessage(ui, { type: 'agentToggle', key: '' }), ui)
  assert.equal(applyMessage(ui, { type: 'agentSelect', key: long }), ui)

  // The parser: strings of 1..200 chars, or null for the selection; nothing else — and the
  // 1.5.0 message `agentFold` is no longer a message at all.
  assert.deepEqual(parseWebviewMessage({ type: 'agentToggle', key: 'w:9d0eb37a|wf_1' }),
    { type: 'agentToggle', key: 'w:9d0eb37a|wf_1' })
  assert.deepEqual(parseWebviewMessage({ type: 'agentToggle', key: 'x'.repeat(MAX_AGENT_KEY_CHARS) }),
    { type: 'agentToggle', key: 'x'.repeat(MAX_AGENT_KEY_CHARS) })
  assert.deepEqual(parseWebviewMessage({ type: 'agentSelect', key: null }), { type: 'agentSelect', key: null })
  assert.deepEqual(parseWebviewMessage({ type: 'agentSelect', key: 'x'.repeat(MAX_AGENT_KEY_CHARS) }),
    { type: 'agentSelect', key: 'x'.repeat(MAX_AGENT_KEY_CHARS) })
  for (const raw of [{ type: 'agentToggle' }, { type: 'agentToggle', key: null }, { type: 'agentToggle', key: '' },
    { type: 'agentToggle', key: long }, { type: 'agentToggle', key: 7 }, { type: 'agentToggle', key: ['s:1'] },
    { type: 'agentFold', key: 's:9d0eb37a' }, { type: 'agentFold' }, { type: 'agentSelect' },
    { type: 'agentSelect', key: long }, { type: 'agentSelect', key: ['a'] }]) {
    assert.equal(parseWebviewMessage(raw), null, JSON.stringify(raw))
  }
})

// 1.6 P10a (L3): pinned the two places of P3b — the tree's row and the running list's; the 7-day
// block's largest agents are a third, `week`, which the parser now passes and the reducer keeps.
test('a selection says which row it came from — the tree\'s, the running list\'s or the 7-day block\'s — and the details open under that one', () => {
  // 1.6 N2: `from` of the message becomes `ui.agentSelectedIn`; without one it is the tree.
  assert.deepEqual([...AGENT_SELECTED_IN], ['tree', 'now', 'week'])
  const ui = defaultUiState(cfg)
  assert.equal(ui.agentSelectedIn, 'tree')
  const fromNow = applyMessage(ui, { type: 'agentSelect', key: 'a:a94f0001', from: 'now' })
  assert.deepEqual([fromNow.agentSelected, fromNow.agentSelectedIn], ['a:a94f0001', 'now'])
  assert.equal(ui.agentSelectedIn, 'tree', 'the input state was mutated')
  // The same node from its other row moves the details there; from the same row again, nothing
  // changes, and says so by identity.
  const moved = applyMessage(fromNow, { type: 'agentSelect', key: 'a:a94f0001', from: 'tree' })
  assert.deepEqual([moved.agentSelected, moved.agentSelectedIn], ['a:a94f0001', 'tree'])
  assert.equal(applyMessage(fromNow, { type: 'agentSelect', key: 'a:a94f0001', from: 'now' }), fromNow)
  assert.equal(applyMessage(moved, { type: 'agentSelect', key: 'a:a94f0001' }), moved)
  // Without a place it is the tree's, from the list too; closing the details forgets the place.
  assert.equal(applyMessage(fromNow, { type: 'agentSelect', key: 'a:a94f0002' }).agentSelectedIn, 'tree')
  const closed = applyMessage(fromNow, { type: 'agentSelect', key: null })
  assert.deepEqual([closed.agentSelected, closed.agentSelectedIn], [null, 'tree'])
  assert.equal(applyMessage(ui, { type: 'agentSelect', key: null, from: 'now' }), ui)
  // A selection moves nothing else: the opened nodes stay the reader's.
  assert.deepEqual(fromNow.agentsExpanded, [])
  // The parser passes a place of the list unchanged and drops a message with any other whole.
  for (const m of [
    { type: 'agentSelect', key: 'a:a94f0001', from: 'tree' },
    { type: 'agentSelect', key: 'a:a94f0001', from: 'now' },
    { type: 'agentSelect', key: 'a:a94f0001', from: 'week' },
    { type: 'agentSelect', key: 'a:a94f0001' },
    { type: 'agentSelect', key: null },
  ]) assert.deepEqual(parseWebviewMessage(m), m)
  for (const from of ['Week', 'weeks', 'Now', '', null, 3, ['now'], { now: true }]) {
    assert.equal(parseWebviewMessage({ type: 'agentSelect', key: 'a:a94f0001', from }), null, JSON.stringify(from))
    assert.equal(parseWebviewMessage({ type: 'agentSelect', key: null, from }), null, JSON.stringify(from))
  }
  assert.equal(isAgentSelectedIn('now'), true)
  assert.equal(isAgentSelectedIn('week'), true)
  assert.equal(isAgentSelectedIn('Week'), false)
  // 1.6 L3: from a row of the 7-day block — the same node, moved there from the running list.
  const fromWeek = applyMessage(fromNow, { type: 'agentSelect', key: 'a:a94f0001', from: 'week' })
  assert.deepEqual([fromWeek.agentSelected, fromWeek.agentSelectedIn], ['a:a94f0001', 'week'])
  // The round trip: what the page posts, parsed, folded in, is the state the page is sent back.
  const round = applyMessage(ui, parseWebviewMessage({ type: 'agentSelect', key: 'l:toolu_01', from: 'now' })!)
  assert.deepEqual([round.agentSelected, round.agentSelectedIn], ['l:toolu_01', 'now'])
})

test('at most MAX_AGENT_EXPANDED nodes are kept open; at the cap an open forgets the oldest, and closing always works', () => {
  assert.equal(MAX_AGENT_EXPANDED, 200)
  let ui = defaultUiState(cfg)
  for (let i = 0; i < MAX_AGENT_EXPANDED; i++) ui = applyMessage(ui, { type: 'agentToggle', key: `a:${i}` })
  assert.equal(ui.agentsExpanded.length, MAX_AGENT_EXPANDED)
  // Nothing prunes the key of a node that has left the tree, so a full list is mostly such
  // keys after a while. The 201st open still opens: the key opened longest ago gives way, and
  // the list stays at the cap.
  const full = ui
  const more = applyMessage(full, { type: 'agentToggle', key: 'a:extra' })
  assert.notEqual(more, full, 'an open at the cap did nothing')
  assert.equal(more.agentsExpanded.length, MAX_AGENT_EXPANDED)
  assert.equal(more.agentsExpanded[MAX_AGENT_EXPANDED - 1], 'a:extra')
  assert.equal(more.agentsExpanded.includes('a:0'), false, 'the oldest key was kept')
  assert.deepEqual(more.agentsExpanded.slice(0, 2), ['a:1', 'a:2'])
  assert.deepEqual(full.agentsExpanded.slice(0, 1), ['a:0'], 'the input state was mutated')
  // Every further open takes the next oldest, however many there are.
  let many = more
  for (let i = 0; i < 3 * MAX_AGENT_EXPANDED; i++) many = applyMessage(many, { type: 'agentToggle', key: `s:new-${i}` })
  assert.equal(many.agentsExpanded.length, MAX_AGENT_EXPANDED)
  assert.equal(many.agentsExpanded[MAX_AGENT_EXPANDED - 1], `s:new-${3 * MAX_AGENT_EXPANDED - 1}`)
  assert.equal(new Set(many.agentsExpanded).size, MAX_AGENT_EXPANDED)
  // Closing one works at the cap, and makes room for one more without forgetting any.
  const closed = applyMessage(full, { type: 'agentToggle', key: 'a:7' })
  assert.equal(closed.agentsExpanded.length, MAX_AGENT_EXPANDED - 1)
  assert.equal(closed.agentsExpanded.includes('a:7'), false)
  const again = applyMessage(closed, { type: 'agentToggle', key: 'a:extra' })
  assert.equal(again.agentsExpanded.length, MAX_AGENT_EXPANDED)
  assert.equal(again.agentsExpanded[0], 'a:0', 'a key was forgotten below the cap')
  assert.equal(again.agentsExpanded[MAX_AGENT_EXPANDED - 1], 'a:extra')
  // An open node closes again, at the cap as anywhere.
  assert.equal(applyMessage(again, { type: 'agentToggle', key: 'a:extra' }).agentsExpanded.includes('a:extra'), false)
})

// ---------------------------------------------------------------------------
// The agent tree
// ---------------------------------------------------------------------------

/**
 * The fixture's aggregator with agent records laid over it, in the shapes the aggregator
 * hands out: the fixture's session `sess-alpha` with one running subagent and one launch whose
 * file was not seen yet. The session table underneath is the fixture's own, project `alpha`.
 */
function withAgents(attribution: 'none' | 'project' = 'project'): { agg: Aggregator; agentKey: string } {
  const agg = buildAgg(attribution)
  const dir = path.dirname(CLAUDE_FILE)
  const sessionFile = path.join(dir, 'sess-alpha.jsonl')
  const counts = {
    input: 300, cacheWrite: 200, cacheWrite1h: 0, cacheRead: 5000, output: 700, reasoning: 0,
    requests: 5, outputFinal: 5, toolCalls: 3,
  }
  const main: MainRec = {
    source: 'claude', sessionId: 'sess-alpha', firstTs: NOW - 3 * 3_600_000, lastTs: NOW - 45 * 60_000,
    models: ['claude-opus-4-6'], ...counts, ccVersion: null, permissionMode: null, compactions: 0, lastCompaction: null,
  }
  const agent: AgentRec = {
    source: 'claude', agentId: 'a94f0001', sessionId: 'sess-alpha', sessionFile, workflowId: null,
    meta: { agentType: 'Explore', model: 'opus', spawnDepth: 1, toolUseId: 'toolu_01', parentAgentId: null }, metaTries: 1,
    spawnerFile: sessionFile, firstTs: NOW - 20 * 60_000, lastTs: NOW - 60_000, models: ['claude-opus-4-6'],
    ...counts, outcome: null, outcomeTs: null, outcomeStatus: null, rejected: null, lastTool: null, lastToolTs: null, effort: null, efforts: [], lastContext: null, toolErrors: 0, cacheMisses: {}, cacheMissedTokens: 0, ccVersion: null, permissionMode: null, compactions: 0, lastCompaction: null,
  }
  const pending: AgentLaunch = {
    toolUseId: 'toolu_02', file: sessionFile, ts: NOW - 2 * 60_000, agentId: null, typeHint: 'Plan',
    modelHint: null, background: true, outcome: 'launched', outcomeTs: null, outcomeStatus: null, totals: null,
  }
  agg.mains = () => [main]
  agg.agents = () => [agent]
  agg.launches = () => [pending]
  return { agg, agentKey: 'a:a94f0001' }
}

test('the view model carries the agent tree of the aggregator, with the selection, the attribution and its clock', () => {
  const { agg, agentKey } = withAgents()
  // The session opened: the page carries a node's children only while it is open (1.6 D3).
  const vm = buildViewModel(makeInput({
    agg, cfg: makeConfig({ 'tokenPace.attribution': 'project' }), ui: { agentSelected: agentKey, agentsExpanded: ['s:sess-alpha'] },
  }))
  const tree = vm.agents
  // The clock is the builder's input, never part of the tree (D12).
  assert.equal('updatedAt' in tree, false)
  assert.equal(tree.roots.length, 1)
  const root = tree.roots[0]
  // 1.6 N6: named by its first line in the configured zone, then its id.
  assert.equal(root.label, 'Session Thu 09:00 · sess-alp')
  // The project label comes from the attribution table — the same one the Sessions table reads.
  assert.equal(root.sub, 'alpha')
  // Quiet itself for 45 minutes, but its agent and its launch run: active, through them.
  assert.equal(root.state, 'active')
  // The newest first (1.6 N6): the launch came after the agent started.
  assert.deepEqual(root.children.map((c) => [c.kind, c.state]), [['pending', 'running'], ['agent', 'running']])
  assert.equal(tree.running, 2)
  // A closed session says what it holds: the agent and the launch below it.
  assert.equal(root.agentCount, 2)
  assert.deepEqual(root.children.map((c) => c.agentCount), [0, 0])
  assert.equal(tree.selected?.key, agentKey)
  assert.equal(tree.selected?.title, 'Explore · claude-opus-4-6 · a94f')
  assert.equal(tree.note, null)
  // The running list: both, the one that started first on top, each with where it sits — the
  // project too, while attribution names one — and a launch with nothing counted as a dash.
  assert.deepEqual(tree.runningNow.map((r) => [r.kind, r.key, r.label, r.context, r.usage, r.waiting]), [
    // 1.6 N6: the row's name has the model short; `fullLabel` keeps the whole id.
    ['agent', agentKey, 'Explore · opus-4-6 · a94f', 'Session sess-alp · alpha', '1.2K', false],
    ['pending', 'l:toolu_02', 'Plan · – · launched', 'Session sess-alp · alpha', '–', false],
  ])
  assert.deepEqual(tree.runningNow.map((r) => r.startTs), [NOW - 20 * 60_000, NOW - 2 * 60_000])
  assert.equal(tree.runningNow[0].fullLabel, 'Explore · claude-opus-4-6 · a94f')
  assert.equal(tree.runningMore, 0)

  // Attribution off: the same tree without a project name, in the running list as well.
  const off = buildViewModel(makeInput({ agg: withAgents('none').agg, ui: { agentSelected: agentKey } }))
  assert.equal(off.agents.roots[0].sub, null)
  assert.equal(off.agents.selected?.key, agentKey)
  assert.deepEqual(off.agents.runningNow.map((r) => r.context), ['Session sess-alp', 'Session sess-alp'])

  // Range-free and chip-free: the tree is the Claude sessions of the last days, whatever the
  // table below is filtered to.
  const filtered = buildViewModel(makeInput({
    agg, cfg: makeConfig({ 'tokenPace.attribution': 'project' }),
    ui: { agentSelected: agentKey, agentsExpanded: ['s:sess-alpha'], providers: ['codex'], models: ['gpt-5.3-codex'], range: '7d' },
  }))
  assert.deepEqual(filtered.agents, tree)

  // As the tree starts: the session closed, nothing below it in the payload, the same counts —
  // and the running agent's details, since the running list has a row for it.
  const closed = buildViewModel(makeInput({
    agg, cfg: makeConfig({ 'tokenPace.attribution': 'project' }), ui: { agentSelected: agentKey },
  })).agents
  assert.deepEqual([closed.roots[0].children, closed.roots[0].hasChildren, closed.roots[0].childrenTotal, closed.roots[0].agentCount],
    [[], true, 2, 2])
  assert.equal(closed.selected?.key, agentKey)
  assert.deepEqual(closed.runningNow, tree.runningNow)
  // The markdown's tree opens every node, whatever the page has open.
  const text = agentTreeFor(makeInput({ agg, cfg: makeConfig({ 'tokenPace.attribution': 'project' }), ui: {} }), 'text')
  assert.deepEqual(text.roots[0].children.map((c) => c.key), tree.roots[0].children.map((c) => c.key))
})

test('the 7-day block is built only while it is open, its costs only while costs are shown, and its message toggles it (1.6 L3)', () => {
  const { agg, agentKey } = withAgents()
  const shown = (over: Record<string, unknown>, ui: Record<string, unknown>) =>
    buildViewModel(makeInput({ agg, cfg: makeConfig({ 'tokenPace.attribution': 'project', ...over }), ui })).agents
  // Closed — the default — there is no block, and the page is not burdened with one.
  assert.equal(shown({}, {}).week, null)
  assert.equal(defaultUiState(cfg).agentsWeekOpen, false)
  // Open: the one agent with a counted request, one row, its largest agent — the session's is no
  // agent, the launch nobody read a line of counted nothing.
  const open = shown({}, { agentsWeekOpen: true }).week
  assert.ok(open)
  assert.deepEqual(open.rows.map((r) => [r.type, r.model, r.label, r.agents, r.usage, r.share, r.median]),
    [['Explore', 'claude-opus-4-6', 'Explore · opus-4-6', 1, '1.2K', '100 %', '1.2K']])
  assert.deepEqual(open.top.map((x) => [x.key, x.context, x.usage, x.share]), [[agentKey, 'Session sess-alp · alpha', '1.2K', '100 %']])
  assert.deepEqual([open.agents, open.total, open.other], [1, '1.2K', null])
  // Costs are shown by default: an API estimate, marked `~`, on the row, the agent and the total.
  assert.match(open.rows[0].cost ?? '', /^~\$\d/)
  assert.equal(open.top[0].cost, open.rows[0].cost)
  assert.equal(open.totalCost, open.rows[0].cost)
  // With costs off the block names no amount anywhere.
  const noCost = shown({ 'tokenPace.showCost': false }, { agentsWeekOpen: true }).week
  assert.ok(noCost)
  assert.deepEqual([noCost.rows[0].cost, noCost.top[0].cost, noCost.totalCost], [null, null, null])
  assert.equal(JSON.stringify(noCost).includes('$'), false, JSON.stringify(noCost))
  // The markdown's tree carries the block too, while it is open.
  const text = agentTreeFor(makeInput({ agg, cfg: makeConfig({ 'tokenPace.attribution': 'project' }), ui: { agentsWeekOpen: true } }), 'text')
  assert.deepEqual(text.week, open)
  // The disclosure's message carries nothing; it opens a closed block and closes an open one.
  assert.deepEqual(parseWebviewMessage({ type: 'agentsWeek' }), { type: 'agentsWeek' })
  assert.deepEqual(parseWebviewMessage({ type: 'agentsWeek', open: 'yes' }), { type: 'agentsWeek' })
  const ui = defaultUiState(cfg)
  const opened = applyMessage(ui, { type: 'agentsWeek' })
  assert.equal(opened.agentsWeekOpen, true)
  assert.equal(ui.agentsWeekOpen, false, 'the input state was mutated')
  assert.equal(applyMessage(opened, { type: 'agentsWeek' }).agentsWeekOpen, false)
  // A selection made from one of its rows stays what it is when the block closes.
  const picked = applyMessage(opened, { type: 'agentSelect', key: agentKey, from: 'week' })
  assert.deepEqual([picked.agentSelected, picked.agentSelectedIn], [agentKey, 'week'])
  const closed = applyMessage(picked, { type: 'agentsWeek' })
  assert.deepEqual([closed.agentsWeekOpen, closed.agentSelected, closed.agentSelectedIn], [false, agentKey, 'week'])
})

test('a "more" step raises an open node by one, up to MAX_MORE_PAGES; closing the node forgets it; the list keeps the newest', () => {
  const open = applyMessage(defaultUiState(cfg), { type: 'agentToggle', key: 'w:s|wf_1' })
  const once = applyMessage(open, { type: 'agentMore', key: 'w:s|wf_1' })
  assert.deepEqual(once.agentsMore, [{ key: 'w:s|wf_1', pages: 1 }])
  assert.deepEqual(open.agentsMore, [], 'the input state was mutated')
  let ui = once
  for (let i = 0; i < 20; i++) ui = applyMessage(ui, { type: 'agentMore', key: 'w:s|wf_1' })
  assert.deepEqual(ui.agentsMore, [{ key: 'w:s|wf_1', pages: MAX_MORE_PAGES }])
  // At the last step nothing changes, and says so by identity.
  assert.equal(applyMessage(ui, { type: 'agentMore', key: 'w:s|wf_1' }), ui)
  // A node that is not open has no "more" line: its step is no step.
  assert.equal(applyMessage(open, { type: 'agentMore', key: 's:other' }), open)
  assert.equal(applyMessage(open, { type: 'agentMore', key: '' }), open)
  assert.equal(applyMessage(open, { type: 'agentMore', key: 'x'.repeat(MAX_AGENT_KEY_CHARS + 1) }), open)
  // Closing the node forgets its steps: opened again, it shows its first fifty.
  const shut = applyMessage(ui, { type: 'agentToggle', key: 'w:s|wf_1' })
  assert.deepEqual([shut.agentsExpanded, shut.agentsMore], [[], []])
  const reopened = applyMessage(shut, { type: 'agentToggle', key: 'w:s|wf_1' })
  assert.deepEqual(reopened.agentsMore, [])
  // At most MAX_AGENT_MORE nodes keep their steps; one more forgets the one raised longest ago,
  // and a node raised again is the newest.
  assert.equal(MAX_AGENT_MORE, 200)
  let many = defaultUiState(cfg)
  for (let i = 0; i <= MAX_AGENT_MORE; i++) {
    many = applyMessage(many, { type: 'agentToggle', key: `w:s|wf_${i}` })
    many = applyMessage(many, { type: 'agentMore', key: `w:s|wf_${i}` })
  }
  assert.equal(many.agentsMore.length, MAX_AGENT_MORE)
  assert.equal(many.agentsMore.some((e) => e.key === 'w:s|wf_0'), false, 'the 201st kept the oldest')
  assert.equal(many.agentsMore[MAX_AGENT_MORE - 1].key, `w:s|wf_${MAX_AGENT_MORE}`)
  const raised = applyMessage(many, { type: 'agentMore', key: 'w:s|wf_1' })
  assert.deepEqual(raised.agentsMore[MAX_AGENT_MORE - 1], { key: 'w:s|wf_1', pages: 2 })
  assert.equal(raised.agentsMore.length, MAX_AGENT_MORE)
  // The parser: a key of 1..200 characters, nothing else.
  assert.deepEqual(parseWebviewMessage({ type: 'agentMore', key: 'w:s|wf_1' }), { type: 'agentMore', key: 'w:s|wf_1' })
  for (const raw of [{ type: 'agentMore' }, { type: 'agentMore', key: null }, { type: 'agentMore', key: '' },
    { type: 'agentMore', key: 'x'.repeat(MAX_AGENT_KEY_CHARS + 1) }, { type: 'agentMore', key: 3 }, { type: 'agentMore', key: ['k'] }]) {
    assert.equal(parseWebviewMessage(raw), null, JSON.stringify(raw))
  }
})

test('a session without agents is keyed by its id, never by the transcript path the aggregator holds a cursor for', () => {
  const agg = buildAgg()
  agg.mains = () => [{
    source: 'claude', sessionId: 's1', firstTs: NOW - 3_600_000, lastTs: NOW - 30 * 60_000, models: [],
    input: 0, cacheWrite: 0, cacheWrite1h: 0, cacheRead: 0, output: 0, reasoning: 0, requests: 0,
    outputFinal: 0, toolCalls: 0, ccVersion: null, permissionMode: null, compactions: 0, lastCompaction: null,
  }]
  // 1.7 F2 (pinned and changed): half an hour quiet, the session is an earlier one — inside the
  // group of earlier sessions, which the reader opens to see it.
  const vm = buildViewModel(makeInput({ agg, ui: { agentsExpanded: [EARLIER_KEY] } }))
  assert.deepEqual(vm.agents.roots.map((r) => r.key), [EARLIER_KEY])
  assert.equal(vm.agents.roots[0].children[0].key, 's:s1')
  assert.equal(vm.agents.roots[0].children[0].usage, '–')
})

// ---------------------------------------------------------------------------
// 1.6 N7: the subagent share of each quota window, and the records against the buckets
// ---------------------------------------------------------------------------

test('each Claude window says how much of what was counted over its own bounds came from subagents (1.6 N7)', () => {
  const vm = buildViewModel(makeInput({ agg: agentShareAgg() }))
  const [five, seven] = vm.quotas[0].windows
  // By hand (viewFixtures.agentShareAgg): 5 h = 1.5K main + 4.5K + 1K of agents; 7 d adds 4K of main.
  assert.equal(five.agentShare, 'Subagents 5.5K of 7K counted here (79 %)')
  assert.deepEqual(five.agentShareParts, { sub: '5.5K', total: '7K', share: '79 %' })
  assert.equal(seven.agentShare, 'Subagents 5.5K of 11K counted here (50 %)')
  // The bounds are the totals row's: its "Current … window" usage is the line's whole figure.
  const rows = vm.totals.find((t) => t.source === 'claude')?.rows ?? []
  assert.equal(rows[0].label, 'Current 5 h window')
  assert.equal(rows[0].usage, five.agentShareParts?.total)
  assert.equal(rows[1].usage, seven.agentShareParts?.total)
  // Codex: never — its card has tokens in the same hours, and still no line.
  const codex = vm.quotas.find((q) => q.source === 'codex')
  assert.ok(codex && codex.windows.length > 0)
  for (const w of codex.windows) {
    assert.equal(w.agentShare, null)
    assert.equal(w.agentShareParts, null)
  }
  // A share of tokens, never of the quota: no figure of the card is in the line, and the line is
  // in no sentence of the card.
  for (const w of vm.quotas[0].windows) {
    const said = [w.percentText, w.verdict.text, w.stateText, w.resetLine, w.aria.text, ...w.explain.lines.map(String)].join(' | ')
    assert.equal(said.includes('Subagents'), false, said)
    assert.equal(said.includes('counted here'), false, said)
  }
})

test('the subagent share leaves every figure of the quota card as it was (1.6 N7)', () => {
  // The same tokens in the same hours, once from two agents and once from the main session: the
  // provider's percentage, its verdict, its explanation and its forecast cannot move.
  const quotas = [state('claude'), state('codex')]
  const history = makeHistory()
  fillHistory(history)
  const withAgents = buildViewModel(makeInput({ agg: agentShareAgg(), quotas, history }))
  const noAgents = buildViewModel(makeInput({ agg: agentShareAgg({ asMain: true }), quotas, history }))
  const strip = (w: WindowVm): Record<string, unknown> => {
    const { agentShare, agentShareParts, ...rest } = w
    return rest
  }
  assert.deepEqual(withAgents.quotas.map((q) => q.windows.map(strip)), noAgents.quotas.map((q) => q.windows.map(strip)))
  // 1.6 P10c (pinned by P10b and changed, the lead's call on P10b Q1): the same tokens without an
  // agent anywhere — no agent record, no subagent bucket in the seven days — have no share line at
  // all, rather than "Subagents 0 of 7K counted here (0 %)" on every card.
  assert.equal(noAgents.quotas[0].windows[0].agentShare, null)
  assert.equal(noAgents.quotas[0].windows[0].agentShareParts, null)
  assert.notEqual(withAgents.quotas[0].windows[0].agentShare, noAgents.quotas[0].windows[0].agentShare)
})

test('the subagent share marks both figures ≈ once its window reaches below the hour roll-up (1.6 N7)', () => {
  const agg = agentShareAgg()
  // Two days of hour buckets: the 7 d window starts four days back, the 5 h window this morning.
  agg.rollup(NOW, 2, 400, tcfg)
  const [five, seven] = buildViewModel(makeInput({ agg })).quotas[0].windows
  assert.equal(five.agentShare, 'Subagents 5.5K of 7K counted here (79 %)')
  // The main line three days back is in a day bucket now: the rest is what the hours still hold.
  assert.equal(seven.agentShare, 'Subagents ≈5.5K of ≈9K counted here (61 %)')
  assert.deepEqual(seven.agentShareParts, { sub: '≈5.5K', total: '≈9K', share: '61 %' })
})

test('a ≈ on a subagent share or on the buckets alone still brings the legend that explains it (1.6 N7)', () => {
  const legend = '~ = estimate · ≈ = lower bound · measured = read from the provider · derived = computed from measured values.'
  // Eight days of hour buckets: no totals row reaches below the roll-up, nor do the last seven days
  // of the data-quality line — but a ten-day window nine days in does: its share is marked, and so
  // is the page.
  const agg = agentShareAgg()
  agg.rollup(NOW, 8, 400, tcfg)
  const quotas = [state('claude', { windows: [
    win(),
    win({ id: 'weekly_all:10080', kind: 'weekly', label: '7 d', percent: 62, resetsAt: NOW + 3 * 86_400_000, windowMinutes: 10080 }),
    win({ id: 'other:14400', kind: 'other', label: '10 d', percent: 30, resetsAt: NOW + 86_400_000, windowMinutes: 14400 }),
  ] })]
  const vm = buildViewModel(makeInput({ agg, quotas }))
  assert.equal(vm.totals.some((t) => t.rows.some((r) => r.approx)), false)
  assert.equal(vm.dataQuality.agents?.buckets.startsWith('≈'), false)
  assert.equal(vm.quotas[0].windows[1].agentShare?.includes('≈'), false)
  assert.ok(String(vm.quotas[0].windows[2].agentShare).includes('≈'), String(vm.quotas[0].windows[2].agentShare))
  assert.ok(vm.footnotes.includes(legend), vm.footnotes.join('\n'))
  // Without any ≈ the legend does not mention it.
  const plain = buildViewModel(makeInput({ agg: agentShareAgg(), quotas }))
  assert.equal(plain.footnotes.some((f) => f.includes('≈')), false, plain.footnotes.join('\n'))
})

test('a window without bounds, one not begun, and one nothing was counted in have no subagent line (1.6 N7)', () => {
  const agg = agentShareAgg()
  for (const w of [
    win({ resetsAt: null, windowMinutes: null }),
    win({ resetsAt: null }),
    win({ windowMinutes: null }),
    win({ resetsAt: Number.NaN }),
    win({ windowMinutes: Number.POSITIVE_INFINITY }),
    win({ windowMinutes: 0 }),
    // Its start is still ahead: five hours that end in eleven.
    win({ resetsAt: NOW + 11 * 3_600_000 }),
  ]) {
    assert.equal(agentShareOf(agg, w, NOW), null, JSON.stringify(w))
    const vm = buildViewModel(makeInput({ agg, quotas: [state('claude', { windows: [w] })] }))
    assert.equal(vm.quotas[0].windows[0].agentShare, null)
    assert.equal(vm.quotas[0].windows[0].agentShareParts, null)
  }
  // Nothing counted in the window: "0 of 0" is not a share.
  assert.equal(agentShareOf(new Aggregator(), win(), NOW), null)
  assert.equal(agentShareOf(agg, win({ resetsAt: daysAgo(20), windowMinutes: 300 }), NOW), null)
  const empty = buildViewModel(makeInput({ agg: new Aggregator() }))
  for (const q of empty.quotas) for (const w of q.windows) assert.equal(w.agentShare, null)
  // A reset that has passed: the window the reading belongs to, up to its reset.
  const due = agentShareOf(agg, win({ resetsAt: Date.UTC(2026, 8, 3, 11, 0), windowMinutes: 300 }), NOW)
  assert.equal(due?.text, 'Subagents 1K of 3K counted here (33 %)')
})

test('no share line on any card where the subagents counted nothing and no agent ran in the seven days; a measured zero stays (1.6 P10c)', () => {
  // The lead's call on P10b Q1: with no agent record and no subagent hour bucket in the last seven
  // days (dataQuality.agents null) a reader has no agents, and a "0 %" under every bar would be a
  // line about agents to him. With agents elsewhere, a window they did not reach says its zero.
  const none = buildViewModel(makeInput({ agg: agentShareAgg({ asMain: true }) }))
  assert.equal(none.dataQuality.agents, null)
  for (const q of none.quotas) for (const w of q.windows) assert.deepEqual([w.agentShare, w.agentShareParts], [null, null], w.label)
  // The same world with its agents: an hour before the 5 h window — main tokens only — is a
  // window the agents did not reach, and it says so.
  const agg = agentShareAgg()
  const early = win({ resetsAt: Date.UTC(2026, 8, 3, 9, 0), windowMinutes: 60 })
  assert.equal(agentShareOf(agg, early, NOW)?.text, 'Subagents 0 of 2K counted here (0 %)')
  const vm = buildViewModel(makeInput({ agg, quotas: [state('claude', { windows: [early] })] }))
  assert.notEqual(vm.dataQuality.agents, null)
  assert.equal(vm.quotas[0].windows[0].agentShare, 'Subagents 0 of 2K counted here (0 %)')
  // The caller's word on the seven days decides a zero, and only a zero: a window the agents did
  // reach says what they counted whatever it is told.
  assert.equal(agentShareOf(agg, early, NOW, false), null)
  assert.equal(agentShareOf(agg, early, NOW, true)?.text, 'Subagents 0 of 2K counted here (0 %)')
  assert.equal(agentShareOf(agg, win(), NOW, false)?.text, 'Subagents 5.5K of 7K counted here (79 %)')
  // Without an agent, the function finds the seven days empty itself.
  assert.equal(agentShareOf(agentShareAgg({ asMain: true }), win(), NOW), null)
  // A subagent bucket alone (no agent record — an old transcript's line) is an agent that ran.
  const bucketOnly = agentShareAgg({ asMain: true })
  const stray = path.join('/virtual', 'claude', 'projects', '-home-t-alpha', 's1', 'subagents', 'a.jsonl')
  bucketOnly.addClaudeLine(claudeLine({ id: 'b-1', ts: daysAgo(2), final: true, usage: { input: 700 } }), ctxFor({ file: stray, isSub: true }))
  assert.notEqual(buildViewModel(makeInput({ agg: bucketOnly })).dataQuality.agents, null)
  assert.equal(agentShareOf(bucketOnly, win(), NOW)?.text, 'Subagents 0 of 7K counted here (0 %)')
})

/**
 * 1.6 P10c: a world of two families in the same hours — Opus and Sonnet, each in a main session and
 * in an agent — plus a Haiku agent, so a model window's figures can be told from the whole's.
 *
 *   main   claude-opus-4-6       10:00   4 000
 *   main   claude-sonnet-4-6     10:10   2 000
 *   agent  claude-opus-5[1m]     10:20   1 000   (the family, whatever the version and the suffix)
 *   agent  claude-3-opus         10:30     500   (the older order of the name)
 *   agent  claude-haiku-4-5      10:40   3 000
 *
 * The 7 d window counts 10.5K with 4.5K of subagents; "7 d Opus" 5.5K with 1.5K.
 */
function familyAgg(): Aggregator {
  const agg = new Aggregator()
  const slug = path.join('/virtual', 'claude', 'projects', '-home-t-alpha')
  const main = path.join(slug, 's1.jsonl')
  const sub = (id: string): string => path.join(slug, 's1', 'subagents', `agent-${id}.jsonl`)
  const put = (file: string, isSub: boolean, id: string, minute: number, model: string, input: number): void => {
    agg.addClaudeLine(claudeLine({ id, ts: Date.UTC(2026, 8, 3, 10, minute), model, final: true, sessionId: 's1', usage: { input } }),
      ctxFor({ file, isSub }))
  }
  put(main, false, 'm-1', 0, 'claude-opus-4-6', 4000)
  put(main, false, 'm-2', 10, 'claude-sonnet-4-6', 2000)
  put(sub('a0000000000000011'), true, 's-1', 20, 'claude-opus-5[1m]', 1000)
  put(sub('a0000000000000012'), true, 's-2', 30, 'claude-3-opus', 500)
  put(sub('a0000000000000013'), true, 's-3', 40, 'claude-haiku-4-5', 3000)
  return agg
}

test('a model window counts only its own family in both figures of its share; nothing of that family, no line (1.6 P10c)', () => {
  const agg = familyAgg()
  const week = win({ id: 'weekly_all:10080', kind: 'weekly', label: '7 d', percent: 62, resetsAt: NOW + 3 * 86_400_000, windowMinutes: 10080 })
  const opus = win({ ...week, id: 'weekly_scoped:10080:opus', label: '7 d · Opus', model: 'Opus' })
  assert.equal(agentShareOf(agg, week, NOW)?.text, 'Subagents 4.5K of 10.5K counted here (43 %)')
  assert.equal(agentShareOf(agg, opus, NOW)?.text, 'Subagents 1.5K of 5.5K counted here (27 %)')
  // However the provider spells the family: its short name, lower case, the whole display name.
  for (const model of ['opus', 'OPUS', 'Claude Opus 4.6', 'claude-opus']) {
    assert.equal(agentShareOf(agg, { ...opus, model }, NOW)?.text, 'Subagents 1.5K of 5.5K counted here (27 %)', model)
  }
  // Sonnet: its main session's tokens, no agent of its own — a measured zero, since agents ran.
  assert.equal(agentShareOf(agg, { ...opus, model: 'Sonnet' }, NOW)?.text, 'Subagents 0 of 2K counted here (0 %)')
  // A family nothing was counted for, a name with no family in it, and a scope that names no
  // model at all (the provider's "7 d Cowork") have no line: a denominator of none is no share.
  for (const model of ['Fable', '4.6', 'Cowork', 'Oauth apps']) {
    assert.equal(agentShareOf(agg, { ...opus, model }, NOW), null, model)
  }
  // A family counted for, but not in the window's own hours: no line either.
  assert.equal(agentShareOf(agg, { ...opus, resetsAt: Date.UTC(2026, 8, 3, 10, 0), windowMinutes: 60 }, NOW), null)
  // A window without a model is every model's, as before; an empty model name is none.
  assert.equal(agentShareOf(agg, { ...opus, model: null }, NOW)?.text, 'Subagents 4.5K of 10.5K counted here (43 %)')
  assert.equal(agentShareOf(agg, { ...opus, model: ' ' }, NOW)?.text, 'Subagents 4.5K of 10.5K counted here (43 %)')
  // On the card, beside the window of every model: the two lines differ, the percent is the provider's.
  const vm = buildViewModel(makeInput({ agg, quotas: [state('claude', { windows: [week, { ...opus, percent: 91 }] })] }))
  const [all, scoped] = vm.quotas[0].windows
  assert.equal(all.agentShare, 'Subagents 4.5K of 10.5K counted here (43 %)')
  assert.deepEqual(scoped.agentShareParts, { sub: '1.5K', total: '5.5K', share: '27 %' })
  assert.equal(scoped.percentText, '91%')
  // And the markdown names the window it belongs to.
  assert.ok(markdownDocument(vm).split('\n').includes('- 7 d · Opus: subagents 1.5K of 5.5K counted here (27 %)'), markdownDocument(vm))
})

test('a model window below the hour roll-up marks both of its figures ≈, as the window of every model does (1.6 P10c)', () => {
  const agg = familyAgg()
  // Ten more days of Opus in a main session, then the hours older than two days rolled up: a
  // ten-day window reaches below them.
  const main = path.join('/virtual', 'claude', 'projects', '-home-t-alpha', 's1.jsonl')
  agg.addClaudeLine(claudeLine({ id: 'm-old', ts: daysAgo(5), model: 'claude-opus-4-6', final: true, sessionId: 's1', usage: { input: 9000 } }),
    ctxFor({ file: main, isSub: false }))
  agg.rollup(NOW, 2, 400, tcfg)
  const opus = win({ id: 'other:14400:opus', kind: 'other', label: '10 d · Opus', model: 'Opus', resetsAt: NOW + 86_400_000, windowMinutes: 14400 })
  assert.equal(agentShareOf(agg, opus, NOW)?.text, 'Subagents ≈1.5K of ≈5.5K counted here (27 %)')
})

test('one view-model build sums its hour spans in one pass, the subagent share sharing the totals rows\' sums (1.6 L5, Review 3)', () => {
  // The totals table's two window rows per provider, each Claude window's two share figures —
  // over the very bounds of its totals row — and the data-quality line's seven days: seven passes
  // over the hour buckets and more until P11, one now. The figures are exactly the ones each
  // pass gave alone.
  const agg = familyAgg()
  const week = win({ id: 'weekly_all:10080', kind: 'weekly', label: '7 d', percent: 62, resetsAt: NOW + 3 * 86_400_000, windowMinutes: 10080 })
  const opus = win({ ...week, id: 'weekly_scoped:10080:opus', label: '7 d · Opus', model: 'Opus' })
  const input = makeInput({ agg, quotas: [state('claude', { windows: [win(), week, opus] }), state('codex')] })
  const alone = buildViewModel(input)
  const sums: string[] = []
  let passes = 0
  const one = agg.sumHours.bind(agg)
  const many = agg.sumHoursMany.bind(agg)
  agg.sumHours = (fromMs, toMs, filter) => { sums.push(`${fromMs}|${toMs}`); return one(fromMs, toMs, filter) }
  agg.sumHoursMany = (queries) => { passes++; return many(queries) }
  const shared = buildViewModel(input)
  assert.equal(passes, 1)
  assert.deepEqual(sums, [], `hour spans summed on their own: ${sums.join(', ')}`)
  assert.deepEqual(JSON.parse(JSON.stringify(shared)), JSON.parse(JSON.stringify(alone)))
  // The shares are the ones `agentShareOf` gives alone, and the totals rows the same numbers.
  assert.equal(shared.quotas[0].windows[1].agentShare, agentShareOf(familyAgg(), week, NOW)?.text)
  assert.equal(shared.quotas[0].windows[2].agentShare, 'Subagents 1.5K of 5.5K counted here (27 %)')
  const claudeRows = shared.totals.find((t) => t.source === 'claude')!.rows
  assert.ok(claudeRows.some((r) => r.label === 'Current 7 d window' && r.usage === '10.5K'), JSON.stringify(claudeRows.map((r) => [r.label, r.usage])))
})

test('sumHoursMany answers every query as sumHours does alone, in one pass', () => {
  const agg = familyAgg()
  agg.rollup(NOW, 0, 400, tcfg)
  const fresh = familyAgg()
  const queries = [
    { fromMs: Date.UTC(2026, 8, 3, 10, 0), toMs: NOW },
    { fromMs: Date.UTC(2026, 8, 3, 10, 0), toMs: NOW, filter: { source: 'claude' as const, isSub: true } },
    { fromMs: Date.UTC(2026, 8, 3, 10, 15), toMs: Date.UTC(2026, 8, 3, 10, 45), filter: { models: ['claude-opus-4-6', 'claude-3-opus'] } },
    { fromMs: NOW, toMs: NOW - 1 },
    { fromMs: Number.NaN, toMs: NOW },
    { fromMs: daysAgo(30), toMs: NOW, filter: { source: 'codex' as const } },
  ]
  for (const a of [agg, fresh]) {
    const got = a.sumHoursMany(queries)
    assert.equal(got.length, queries.length)
    queries.forEach((q, i) => assert.deepEqual(got[i], a.sumHours(q.fromMs, q.toMs, q.filter), JSON.stringify(q)))
  }
  assert.deepEqual(fresh.sumHoursMany([]), [])
})

test('the share is a whole percent, "<1 %" or ">99 %" where rounding would say none or all (1.6 N7)', () => {
  const agg = new Aggregator()
  const main = path.join('/virtual', 'claude', 'projects', '-home-t-alpha', 's1.jsonl')
  const sub = path.join('/virtual', 'claude', 'projects', '-home-t-alpha', 's1', 'subagents', 'agent-a0000000000000009.jsonl')
  const put = (file: string, id: string, input: number, h: number): void => {
    agg.addClaudeLine(claudeLine({ id, ts: Date.UTC(2026, 8, 3, h, 0), final: true, usage: { input } }),
      ctxFor({ file, isSub: file === sub }))
  }
  put(main, 'm-1', 1_000_000, 10)
  put(sub, 's-1', 2_000, 11)
  const five = (): string | null => agentShareOf(agg, win(), NOW)?.parts.share ?? null
  assert.equal(five(), '<1 %')
  put(sub, 's-2', 1_000_000_000, 11)
  assert.equal(five(), '>99 %')
  const only = new Aggregator()
  only.addClaudeLine(claudeLine({ id: 's-3', ts: Date.UTC(2026, 8, 3, 11, 0), final: true, usage: { input: 500 } }),
    ctxFor({ file: sub, isSub: true }))
  assert.equal(agentShareOf(only, win(), NOW)?.text, 'Subagents 500 of 500 counted here (100 %)')
})

test('the data-quality line holds the agent records against the subagent hour buckets of the last 7 days (1.6 N7)', () => {
  const agg = agentShareAgg()
  const d = buildViewModel(makeInput({ agg })).dataQuality
  // The long agent whole in its record (3K, its first line eight days back); in the buckets only
  // the hour of each reply inside the seven days.
  assert.deepEqual(d.agents, {
    records: '7.5K',
    buckets: '5.5K',
    note: 'The two differ by construction: a record keeps a whole agent, a bucket the hour of each reply.',
  })
  // The records are the ones the 7-day block sums, by the same rule.
  const open = buildViewModel(makeInput({ agg, ui: { agentsWeekOpen: true } }))
  assert.equal(open.agents.week?.total, open.dataQuality.agents?.records)
  // The same tokens without an agent: no record, and no subagent bucket either — no line.
  assert.equal(buildViewModel(makeInput({ agg: agentShareAgg({ asMain: true }) })).dataQuality.agents, null)
  assert.equal(buildViewModel(makeInput({ agg: new Aggregator(), quotas: [] })).dataQuality.agents, null)
  // Codex alone has no agent line, whatever its forks.
  assert.equal(buildViewModel(makeInput()).dataQuality.agents, null)
})

test('the data-quality line marks the buckets ≈ below the roll-up and counts a record only in the retention (1.6 N7)', () => {
  const agg = agentShareAgg()
  agg.rollup(NOW, 2, 400, tcfg)
  const d = buildViewModel(makeInput({ agg })).dataQuality.agents
  assert.equal(d?.records, '7.5K')
  assert.equal(d?.buckets, '≈5.5K')
  // An agent whose transcript last changed eight days ago is out of the retention — the record
  // the tree no longer shows is not in the line either — while one read under two paths counts once.
  const old = agentShareAgg()
  const stale = path.join('/virtual', 'claude', 'projects', '-home-t-alpha', 's0', 'subagents', 'agent-a00000000000000aa.jsonl')
  old.addClaudeLine(claudeLine({ id: 'o-1', ts: daysAgo(8), final: true, usage: { input: 90_000 } }), ctxFor({ file: stale, isSub: true }))
  const twice = path.join('/virtual', 'claude', 'projects', '-home-t-beta', 's1', 'subagents', `agent-${SHARE_AGENTS.recent}.jsonl`)
  old.addClaudeLine(claudeLine({ id: 'r-1', ts: Date.UTC(2026, 8, 3, 9, 30), final: true, usage: { input: 40_000 } }),
    ctxFor({ file: twice, isSub: true }))
  // Both are records of the aggregator: the line leaves them out, not the ingest.
  assert.equal(old.agents().filter((r) => r.agentId === SHARE_AGENTS.recent).length, 2)
  assert.ok(old.agents().some((r) => r.agentId === 'a00000000000000aa'))
  const twin = buildViewModel(makeInput({ agg: old })).dataQuality.agents
  // The newer of the two records of one id is its record: the 11:30 one of 4.5K, not the other.
  assert.equal(twin?.records, '7.5K')
  // The buckets hold every reply of the seven days, the second path's included.
  assert.equal(twin?.buckets, '45.5K')
})

test('with nothing ingested the agent tree is empty and says which absence it is', () => {
  const vm = buildViewModel(makeInput({ agg: new Aggregator(), quotas: [], ui: { agentSelected: 's:/gone.jsonl' } }))
  assert.deepEqual(vm.agents.roots, [])
  assert.equal(vm.agents.selected, null)
  assert.equal(vm.agents.running, 0)
  assert.deepEqual(vm.agents.runningNow, [])
  assert.equal(vm.agents.runningMore, 0)
  assert.equal(vm.agents.note, 'No Claude Code session in the last 7 days.')
})

test('every section the dashboard can show can also be folded', () => {
  // The other direction of the `satisfies` in the source: a section added to the config and
  // forgotten here would render a summary whose click the parser drops.
  const all = makeConfig({
    'tokenPace.dashboard.sections': [...DASHBOARD_SECTION_KEYS],
  }).dashboard.sections
  assert.deepEqual([...all].sort(), [...DASHBOARD_SECTION_KEYS].sort())
  for (const key of all) {
    assert.deepEqual(parseWebviewMessage({ type: 'toggleSection', key }), { type: 'toggleSection', key })
  }
})

test('a section fold is remembered, and the same click undoes it', () => {
  const ui = defaultUiState(cfg)
  const folded = applyMessage(ui, { type: 'toggleSection', key: 'models' })
  assert.deepEqual(folded.collapsed, ['models'])
  const two = applyMessage(folded, { type: 'toggleSection', key: 'chart' })
  assert.deepEqual(two.collapsed, ['models', 'chart'])
  assert.deepEqual(applyMessage(two, { type: 'toggleSection', key: 'models' }).collapsed, ['chart'])
  // The fold is view state and nothing else: no section is dropped from the model.
  assert.deepEqual(buildViewModel(makeInput({ ui: { collapsed: ['models'] } })).ui.collapsed, ['models'])
  assert.deepEqual(buildViewModel(makeInput({ ui: { collapsed: ['models'] } })).sections,
    cfg.dashboard.sections)
})

test('the default range follows the setting', () => {
  assert.equal(defaultUiState(makeConfig({ 'tokenPace.dashboard.defaultRange': 'thisWeek' })).range, 'thisWeek')
})

test('a custom range from the webview survives into the view model', () => {
  const custom = rangeFor({ from: '2026-09-01', to: '2026-09-02' }, NOW, tcfg)
  const vm = buildViewModel(makeInput({ range: custom, ui: { range: { from: '2026-09-01', to: '2026-09-02' } } }))
  assert.equal(vm.range.preset, 'custom')
  assert.equal(vm.range.from, '2026-09-01')
  assert.equal(vm.chart.days.length, 2)
  assert.equal(vm.range.previous?.from, '2026-08-30')
})

test('an unlimited window is never given a percentage it does not have', () => {
  const vm = buildViewModel(makeInput({
    quotas: [state('codex', { windows: [win({ id: 'codex:0', unlimited: true, percent: 0, resetsAt: null, windowMinutes: null })] })],
  }))
  const w = vm.quotas[0].windows[0]
  assert.equal(w.percentText, '∞')
  assert.equal(w.display, 'unlimited')
  assert.equal(w.forecast?.state, 'none')
})

test('an unlimited window with a stated reset is given no reserve and no budget', () => {
  // Codex really reports this shape: no limit, a percentage of zero, and a reset in two hours.
  // The clock alone used to be enough to turn that zero into "99 points in reserve" beside the
  // "∞", and into a rate that "keeps it to the reset" — a budget for a limit that does not exist.
  const vm = buildViewModel(makeInput({
    quotas: [state('codex', {
      windows: [win({ id: 'codex:10080', label: 'Opus 7 d', unlimited: true, percent: 0, resetsAt: NOW + 2 * 3_600_000, windowMinutes: 10080 })],
    })],
  }))
  const w = vm.quotas[0].windows[0]
  assert.equal(w.percentText, '∞')
  assert.equal(w.verdict.text, 'unlimited')
  assert.equal(w.verdict.points, null)
  assert.equal(w.verdict.ratio, null)
  assert.equal(w.verdict.level, 'ok')
  assert.equal(w.resetLine, 'resets 2h')
  // The verdict is the state, so the state is not said a second time beside it.
  assert.equal(w.stateText, '')
  assert.equal(w.aria.text, 'Opus 7 d: unlimited')
  // No denominator, so no projection either: the card carries a forecast with nothing in it.
  assert.equal(w.forecast?.state, 'none')
})

// ---------------------------------------------------------------------------
// Window wording: resetLine and stateText
// ---------------------------------------------------------------------------

/** Two hours ahead — a reset the provider states and that is still to come. */
const AHEAD = NOW + 2 * 3_600_000
/** Past, but older than the reading (fetchedAt is NOW − 5 min), so the window is not resetDue. */
const GONE = NOW - 10 * 60_000
/** Past and newer than the reading: the percentage belongs to a window that no longer exists. */
const DUE = NOW - 60_000

/** The one window of a one-window card, built through the real pipeline. */
function windowOf(over: Partial<QuotaWindow>): WindowVm {
  const vm = buildViewModel(makeInput({ quotas: [state('claude', { windows: [win(over)] })] }))
  return vm.quotas[0].windows[0]
}

test('a stated reset is given its verb exactly once, and "reset due" keeps none', () => {
  assert.equal(windowOf({ resetsAt: AHEAD }).resetLine, 'resets 2h')
  // The countdown itself never carries the verb, so the two together are the whole line.
  assert.equal(windowOf({ resetsAt: AHEAD }).reset, '2h')

  // A reset that has come and gone is a whole sentence already: " · resets reset due" is not.
  assert.equal(windowOf({ resetsAt: DUE }).display, 'resetDue')
  assert.equal(windowOf({ resetsAt: DUE }).resetLine, 'reset due')
  assert.equal(windowOf({ resetsAt: GONE }).display, 'normal')
  assert.equal(windowOf({ resetsAt: GONE }).resetLine, 'reset due')

  // No stated reset, no countdown, no verb — never an invented one.
  assert.equal(windowOf({ resetsAt: null, windowMinutes: null }).resetLine, '')
})

test('every window state reaches the views as words, over all three reset situations', () => {
  const states: Array<{ over: Partial<QuotaWindow>; display: string; word: string; verdict?: string }> = [
    { over: { percent: 40 }, display: 'normal', word: '' },
    // The verdict for a full window already says "exhausted"; saying it twice is not two facts.
    { over: { percent: 99.7 }, display: 'exhausted', word: '' },
    { over: { percent: 101 }, display: 'overflow', word: 'over the limit' },
    // No denominator, so the pace verdict itself is the state; repeating it is not a fact.
    { over: { unlimited: true }, display: 'unlimited', word: '', verdict: 'unlimited' },
    { over: { limitReached: true }, display: 'limitReached', word: 'limit reached' },
  ]
  const resets: Array<{ name: string; resetsAt: number | null; line: string }> = [
    { name: 'reset known', resetsAt: AHEAD, line: 'resets 2h' },
    { name: 'reset passed', resetsAt: GONE, line: 'reset due' },
    { name: 'no reset', resetsAt: null, line: '' },
  ]
  for (const st of states) {
    for (const r of resets) {
      const w = windowOf({
        ...st.over,
        resetsAt: r.resetsAt,
        ...(r.resetsAt === null ? { windowMinutes: null } : {}),
      })
      const where = `${st.display} · ${r.name}`
      assert.equal(w.display, st.display, where)
      assert.equal(w.stateText, st.word, where)
      assert.equal(w.resetLine, r.line, where)
      if (st.verdict) assert.equal(w.verdict.text, st.verdict, where)
    }
  }

  // The sixth state has no "reset known" or "no reset" variant by construction: resetDue only
  // exists because a stated reset has passed. It says so through resetLine and stays silent.
  const due = windowOf({ resetsAt: DUE })
  assert.equal(due.display, 'resetDue')
  assert.equal(due.stateText, '')
  assert.equal(due.resetLine, 'reset due')
})

test('a window never hands a view an identifier or a doubled word to print', () => {
  const overs: Partial<QuotaWindow>[] = [
    { percent: 40 }, { percent: 99.7 }, { percent: 101 }, { unlimited: true },
    { limitReached: true }, { resetsAt: DUE }, { resetsAt: null, windowMinutes: null },
  ]
  for (const over of overs) {
    const w = windowOf(over)
    const line = [w.verdict.text, w.stateText, w.resetLine].filter(Boolean).join(' · ')
    // 'exhausted' and 'unlimited' are words as well as identifiers; these five are only ever
    // identifiers, so finding one means a raw enum reached the sentence.
    assert.equal(/\b(resetDue|limitReached|overflow|normal|resetsFirst)\b/.test(line), false, line)
    assert.equal(line.includes('resets reset due'), false, line)
    // The verb is written once or not at all — never twice in one line.
    assert.ok(line.split('resets').length <= 2, line)
  }
})

test('the provider titles are exported from the view model for the text views', () => {
  assert.equal(SOURCE_TITLE.claude, 'Claude Code')
  assert.equal(SOURCE_TITLE.codex, 'Codex')
  assert.equal(buildViewModel(makeInput()).quotas[0].title, SOURCE_TITLE.claude)
})

test('a "full" reading from before a passed reset is still a full window ahead of one', () => {
  // A 100 % reading from before a reset that has passed: the card shows "reset due" on a
  // neutral bar, and the view that prints the forecast beside it drops the sentence itself.
  const due = buildViewModel(makeInput({
    quotas: [state('claude', { windows: [win({ percent: 100, resetsAt: DUE })] })],
  }))
  assert.equal(due.quotas[0].windows[0].display, 'resetDue')

  // The mirror image keeps its sentence: the same reading with the reset still ahead is the
  // plainest fact the card has.
  const ahead = buildViewModel(makeInput({
    quotas: [state('claude', { windows: [win({ percent: 100, resetsAt: AHEAD })] })],
  }))
  const w = ahead.quotas[0].windows[0]
  assert.equal(w.forecast?.state, 'full')
  assert.equal(w.forecast?.text, 'full until the reset')
})

test('a window that has just reset hands the card no measuring sentence at all', () => {
  // Verdict and forecast both measure a window that has only just started. The card keeps
  // the forecast's marks but gets no sentence for it, and the accessibility text does not
  // read out the measuring verdict either: no view prints it, and the screen reader is not
  // told what the sighted reader is spared. The state and the basis stay, the sentence does
  // not — no view has a "measuring · …" to print.
  const history = makeHistory()
  fillHistory(history)
  const vm = buildViewModel(makeInput({
    history,
    quotas: [state('claude', { windows: [win({ percent: 3, resetsAt: NOW + 5 * 3_600_000 - 30_000, windowMinutes: 300 })] })],
  }))
  const w = vm.quotas[0].windows[0]
  assert.equal(w.verdict.measuring, true)
  assert.equal(w.forecast?.state, 'measuring')
  assert.equal(w.forecast?.text, '')
  assert.equal(w.aria.text, '5 h: 3% used')
  assert.equal(/measuring/.test(w.aria.text), false)
  assert.ok(w.forecast?.basis && w.forecast.basis.samples >= 1)
  assert.equal(/measuring/.test(JSON.stringify(vm.digest)), false, JSON.stringify(vm.digest))
})

test('a measuring forecast is blanked on the card whatever the verdict says', () => {
  // The forecast measures with too few readings while the verdict, three hours into the
  // window, has a pace to report: the card keeps the verdict and still prints no forecast
  // sentence — "measuring · 1 reading over 0 min" reports on the forecast, not on the quota.
  const history = makeHistory()
  history.add(state('claude'), FINGERPRINT, NOW - 60_000)
  const vm = buildViewModel(makeInput({ history, quotas: [state('claude')] }))
  const w = vm.quotas[0].windows[0]
  assert.equal(w.verdict.measuring, false)
  assert.equal(w.forecast?.state, 'measuring')
  assert.equal(w.forecast?.text, '')
  assert.equal(w.forecast?.basis?.samples, 1)
  assert.equal(/measuring/.test(w.aria.text), false)
})

// ---------------------------------------------------------------------------
// Context window (F1) and plan name (F3)
// ---------------------------------------------------------------------------

const READING = { used: 128_000, size: 200_000, usedPct: 64, fetchedAt: Math.round((NOW - 120_000) / 1000) }

test('the context card is built from the status-line reading and from nothing else', () => {
  const vm = buildViewModel({ ...makeInput(), context: READING })
  const c = vm.context
  assert.ok(c)
  assert.equal(c.used, 128_000)
  assert.equal(c.size, 200_000)
  assert.equal(c.percentText, '64 %')
  assert.equal(c.text, '128,000 / 200,000 · 64 %')
  assert.equal(c.note, 'current session, via the status line')
  assert.equal(c.fresh, true)
  assert.equal(c.ageText, '2 min ago')

  // Three days of ingested tokens are on file in the fixture; none of them may produce a
  // context window. There is no way to derive one, so the absent bridge is an absent card.
  assert.equal(buildViewModel(makeInput()).context, null)
  assert.equal(buildViewModel({ ...makeInput(), context: null }).context, null)
})

test('a context reading without a window size is never given a percentage', () => {
  const vm = buildViewModel({
    ...makeInput(),
    context: { used: 128_000, size: null, usedPct: 40, fetchedAt: READING.fetchedAt },
  })
  const c = vm.context
  assert.ok(c)
  assert.equal(c.size, null)
  // A percentage the payload sent without a denominator cannot be checked against anything.
  assert.equal(c.percentText, '–')
  assert.equal(c.text, '128,000 tokens')
  assert.equal(c.text.includes('%'), false)
})

test('a context reading is stale by the same clock as a quota reading', () => {
  const old = { ...READING, fetchedAt: Math.round((NOW - 90 * 60_000) / 1000) }
  assert.equal(buildViewModel({ ...makeInput(), context: old }).context?.fresh, false)
  // An unknown time is not an old time: nothing has shown the reading to be stale.
  const undated = { ...READING, fetchedAt: null }
  const c = buildViewModel({ ...makeInput(), context: undated }).context
  assert.equal(c?.fresh, true)
  assert.equal(c?.ageText, null)
})

test('the configured plan name fills in for a provider that names none, and says so', () => {
  const cfgWithPlan = makeConfig({ 'tokenPace.planName': { claude: 'Max 20x', codex: '  Plus  ' } })
  const vm = buildViewModel(makeInput({
    cfg: cfgWithPlan,
    quotas: [state('claude', { planType: null }), state('codex', { planType: null })],
  }))
  const claude = vm.quotas[0]
  assert.equal(claude.planType, 'Max 20x')
  assert.equal(claude.planSource, 'configured')
  assert.equal(claude.planText, 'plan Max 20x (as configured)')
  assert.equal(vm.quotas[1].planText, 'plan Plus (as configured)')

  // The provider's own word wins and carries no qualifier.
  const stated = buildViewModel(makeInput({ cfg: cfgWithPlan }))
  assert.equal(stated.quotas[0].planType, 'max20')
  assert.equal(stated.quotas[0].planSource, 'provider')
  assert.equal(stated.quotas[0].planText, 'plan max20')

  // Neither source: no name, and nothing invented in its place.
  const none = buildViewModel(makeInput({ quotas: [state('claude', { planType: null })] }))
  assert.equal(none.quotas[0].planType, null)
  assert.equal(none.quotas[0].planSource, null)
  assert.equal(none.quotas[0].planText, null)
})

// ---------------------------------------------------------------------------
// Records (F2) and the local five-hour block (F5)
// ---------------------------------------------------------------------------

test('the records of the range are on the view model, capped by dashboard.topN', () => {
  const vm = buildViewModel(makeInput({
    cfg: makeConfig({ 'tokenPace.attribution': 'session', 'tokenPace.dashboard.topN': 2 }),
    agg: buildAgg('session'),
  }))
  const r = vm.records
  // The fixture's busiest day is the one with three sessions of work on it.
  assert.equal(r.peakDay?.day, TODAY)
  assert.ok(r.streak && r.streak.days >= 3, JSON.stringify(r.streak))
  assert.equal(r.streak?.to, TODAY)
  assert.ok(r.topModels.length > 0)
  // The cap is a cap on rows, so no table may be longer than it — and the shares are shares
  // of everything in the range, not of the two rows that were listed.
  for (const table of [r.topModels, r.topProjects, r.topSessions]) {
    assert.ok(table.length <= 2, `${table.length} rows survived a topN of 2`)
  }
  assert.equal(r.attributionOn, true)
  assert.ok(r.topProjects.length > 0)
  assert.ok(r.topSessions.length > 0)

  // Rows are sorted by usage, and every figure is text the view prints verbatim.
  const first = r.topModels[0]
  assert.equal(typeof first.usage, 'string')
  assert.match(first.share, /%$/)
})

test('without attribution the two lower record tables are empty by consent, not by chance', () => {
  const vm = buildViewModel(makeInput())
  assert.equal(vm.records.attributionOn, false)
  assert.deepEqual(vm.records.topProjects, [])
  assert.deepEqual(vm.records.topSessions, [])
  // The models table needs no consent — it comes from the buckets.
  assert.ok(vm.records.topModels.length > 0)
})

test('a provider with no window at all gets one local estimate, and no window ever does', () => {
  const vm = buildViewModel(makeInput({
    quotas: [state('claude', { ok: false, problem: 'no token', problemKind: 'noToken', windows: [] })],
  }))
  const card = vm.quotas[0]
  const b = card.localBlock
  assert.ok(b, 'a provider without a window has nothing but the local count')
  assert.equal(b.source, 'claude')
  assert.equal(b.hours, 5)
  // The fixture's Claude work starts at 09:00 UTC, inside the five hours before NOW.
  assert.equal(b.firstAt, '09:00')
  assert.ok(b.text.startsWith('Local estimate — '), b.text)
  assert.ok(b.text.includes('in the last 5 h'), b.text)
  assert.ok(b.text.includes('first counted at 09:00'), b.text)
  assert.ok(b.text.endsWith('Not the provider’s window; no limit is known.'), b.text)
  // Nothing that would make it look like a window.
  assert.equal(/%/.test(b.text), false, b.text)
  assert.equal(Object.prototype.hasOwnProperty.call(b, 'percent'), false)

  // A provider that does report a window keeps its window and gets no second figure beside it.
  assert.equal(buildViewModel(makeInput()).quotas[0].localBlock, null)
})

test('a provider with no window and no local tokens gets no estimate either', () => {
  const vm = buildViewModel(makeInput({
    agg: new Aggregator(),
    quotas: [state('codex', { ok: false, problem: 'no token', problemKind: 'noToken', windows: [] })],
  }))
  // An empty span would state a measured idle five hours; the buckets cannot tell an idle
  // hour from one that was never read.
  assert.equal(vm.quotas[0].localBlock, null)
})

// ---------------------------------------------------------------------------
// Tool usage
// ---------------------------------------------------------------------------

function toolVm(over: Record<string, unknown> = {}, opts: { models?: string[]; providers?: ('claude' | 'codex')[] } = {}) {
  const t = toolAgg(NOW)
  return buildViewModel(makeInput({
    agg: t.agg,
    range: t.range,
    cfg: makeConfig(over),
    ui: opts.providers || opts.models
      ? { providers: opts.providers ?? ['claude', 'codex'], models: opts.models ?? [] }
      : undefined,
  }))
}

test('tool calls are grouped by name, busiest first, with the models that made them', () => {
  const t = toolVm().tools
  assert.deepEqual(t.rows.map((r) => r.name), ['Read', 'Bash', 'Edit', 'exec'])
  assert.deepEqual(t.rows.map((r) => r.calls), [3, 2, 1, 1])
  assert.equal(t.rows[0].callsText, '3')
  assert.equal(t.total, 7)
  assert.equal(t.totalText, '7')
  assert.equal(t.distinct, 4)
  assert.equal(t.hidden, 0)
  // The models are named, sorted and de-duplicated — one row can be two models.
  assert.equal(t.rows[0].models, 'claude-opus-4-6')
  assert.equal(t.rows[1].models, 'claude-opus-4-6, claude-sonnet-4-6')
  assert.equal(t.rows[0].sources, SOURCE_TITLE.claude)
  assert.equal(t.rows[3].sources, SOURCE_TITLE.codex)
})

test('a tool share is a share of the calls counted in the range, not of the listed rows', () => {
  const t = toolVm({ 'tokenPace.dashboard.topN': 2 }).tools
  assert.equal(t.rows.length, 2)
  assert.equal(t.hidden, 2)
  assert.equal(t.distinct, 4)
  // 3 of 7, not 3 of the 5 calls the two listed rows hold.
  assert.equal(t.rows[0].share, '43 %')
  assert.equal(t.total, 7)
})

test('the tool table states the day tool counting started, and never invents one', () => {
  const t = toolVm()
  assert.equal(t.tools.since, t.range.from)
  assert.ok(t.tools.notes.some((n) => n === `Tool calls counted since ${t.range.from}.`), t.tools.notes.join(' | '))

  // Nothing counted at all: no day is claimed, and the empty table says why it is empty.
  const empty = buildViewModel(makeInput({ agg: new Aggregator() })).tools
  assert.equal(empty.since, null)
  assert.equal(empty.total, 0)
  assert.equal(empty.totalText, '–')
  assert.deepEqual(empty.rows, [])
  assert.ok(empty.notes.some((n) => n.includes('No tool call has been counted yet')), empty.notes.join(' | '))
})

test('the coverage day survives a range that starts after the first tool call', () => {
  const t = toolAgg(NOW)
  const vm = buildViewModel(makeInput({
    agg: t.agg,
    range: { from: t.days[1], to: t.days[1], label: 'Today', preset: 'today' },
  }))
  // Only the later day is counted, but the table still names the day counting began.
  assert.equal(vm.tools.total, 4)
  assert.equal(vm.tools.since, t.days[0])
})

test('the provider and model filters reach the tool table', () => {
  assert.deepEqual(toolVm({}, { providers: ['codex'] }).tools.rows.map((r) => r.name), ['exec'])
  const sonnet = toolVm({}, { models: ['claude-sonnet-4-6'] }).tools
  assert.deepEqual(sonnet.rows.map((r) => r.name), ['Bash', 'Edit'])
  assert.equal(sonnet.total, 2)
  assert.equal(sonnet.rows[0].share, '50 %')
})

test('a day that hit the tool-name cap says so instead of pretending to be complete', () => {
  const t = toolAgg(NOW)
  for (let i = 0; i < TOOL_NAME_CAP + 5; i++) {
    t.agg.addClaudeLine(claudeLine({
      id: `cap-${i}`, ts: NOW, usage: { input: 1, output: 1 },
      tools: [{ name: `tool_${String(i).padStart(3, '0')}`, id: `toolu_cap_${i}` }],
    }), ctxFor())
  }
  const tools = buildViewModel(makeInput({ agg: t.agg, range: t.range })).tools
  assert.equal(tools.truncated, true)
  assert.ok(tools.notes.some((n) => n.includes(String(TOOL_NAME_CAP))), tools.notes.join(' | '))
})

test('a tool row carries a count and a share, never a limit, a cost or a bar', () => {
  const t = toolVm().tools
  for (const r of t.rows) {
    assert.deepEqual(Object.keys(r).sort(), ['callsText', 'calls', 'models', 'name', 'share', 'sources'].sort())
    assert.equal(/[█▁▏▎▍▌▋▊▉]/.test(JSON.stringify(r)), false, r.name)
    assert.equal(/\$/.test(JSON.stringify(r)), false, r.name)
  }
})

// ---------------------------------------------------------------------------
// Budgets
// ---------------------------------------------------------------------------

const BUDGETS = [
  { scope: 'total', period: 'month', unit: 'usd', limit: 20 },
  { scope: 'claude', period: 'day', unit: 'tokens', limit: 5_000_000 },
]

test('a budget is measured against the number the user typed and nothing else', () => {
  const vm = buildViewModel(makeInput({
    agg: buildAgg(), cfg: makeConfig({ 'tokenPace.budgets': BUDGETS }),
  }))
  assert.equal(vm.budgets.length, 2)
  const [money, tokens] = vm.budgets
  assert.equal(money.limit, 20)
  assert.equal(money.limitText, '$20.00')
  assert.equal(money.unit, 'usd')
  // The month of `now`, not the selected range: a month budget is a question about the month.
  assert.equal(money.from, '2026-09-01')
  assert.equal(money.last, '2026-09-30')
  assert.equal(tokens.from, TODAY)
  assert.equal(tokens.last, TODAY)
  // The share is of the user's own limit; every text is the one the three views print.
  assert.equal(money.shareText, '2 %')
  assert.ok(money.text.startsWith('All providers · this month: ~$'), money.text)
  assert.ok(tokens.text.startsWith('Claude Code · today: '), tokens.text)
})

// 1.7 F1 (pinned and extended): the chips never moved a budget's figures, and the switch does not
// either — it picks the rows: scope `total` and the shown provider's own.
test('the panel filters cannot move a budget; the provider switch only picks its rows (1.7 F1)', () => {
  // A budget is a standing limit. The provider switch and a model chip are a question about the
  // tables below them, and a limit that shrank because one was clicked would be a different
  // question under the same label.
  const cfgWith = makeConfig({ 'tokenPace.budgets': [...BUDGETS, { scope: 'codex', period: 'month', unit: 'tokens', limit: 1_000_000 }] })
  const all = buildViewModel(makeInput({ agg: buildAgg(), cfg: cfgWith }))
  assert.deepEqual(all.budgets.map((b) => b.scope), ['total', 'claude', 'codex'])
  const filtered = buildViewModel(makeInput({
    agg: buildAgg(), cfg: cfgWith, ui: { providers: ['codex'], models: ['gpt-5.3-codex'] },
  }))
  // Under Codex: the total and the Codex budget, the Claude one not shown — every figure All's.
  assert.deepEqual(filtered.budgets.map((b) => b.scope), ['total', 'codex'])
  assert.deepEqual(filtered.budgets, all.budgets.filter((b) => b.scope !== 'claude'))
  assert.deepEqual(filtered.budgets.map((b) => b.used), all.budgets.filter((b) => b.scope !== 'claude').map((b) => b.used))
  // Under Claude Code the other way round.
  const claude = buildViewModel(makeInput({ agg: buildAgg(), cfg: cfgWith, ui: { providers: ['claude'], models: ['claude-opus-4-6'] } }))
  assert.deepEqual(claude.budgets, all.budgets.filter((b) => b.scope !== 'codex'))
  // The status bar and the alerts read every row, whatever the switch shows.
  assert.deepEqual(filtered.allBudgets, all.budgets)
  assert.deepEqual(claude.allBudgets, all.budgets)
  assert.equal(all.allBudgets, all.budgets, 'under All the rows shown are every row')
  // The tables beside them did move, so the filter really was applied.
  assert.notDeepEqual(filtered.models.rows.map((m) => m.model), all.models.rows.map((m) => m.model))
})

test('a budget that cannot be measured keeps its row and says why', () => {
  // A money budget has nothing to measure while the cost column is off — but it is still a
  // budget the reader configured, and a view model that quietly forgets it makes the panel
  // say "No budget configured" about a settings file that plainly configures one.
  const noCost = buildViewModel(makeInput({
    agg: buildAgg(),
    cfg: makeConfig({ 'tokenPace.budgets': BUDGETS, 'tokenPace.showCost': false }),
  }))
  assert.deepEqual(noCost.budgets.map((b) => b.unit), ['usd', 'tokens'])
  assert.equal(noCost.budgets[0].unmeasurable, 'not measured while tokenPace.showCost is off')
  assert.equal(noCost.budgets[0].usedText, '–')
  assert.equal(noCost.budgets[0].share, null)
  assert.equal(noCost.budgets[1].unmeasurable, null)
  // Nothing configured, nothing shown — never a row with an invented limit.
  assert.deepEqual(buildViewModel(makeInput({ agg: buildAgg() })).budgets, [])
})

test('an empty install gives a budget no share at all instead of 0 %', () => {
  const vm = buildViewModel(makeInput({
    agg: new Aggregator(), quotas: [], cfg: makeConfig({ 'tokenPace.budgets': BUDGETS }),
  }))
  for (const b of vm.budgets) {
    assert.equal(b.covered, false)
    assert.equal(b.share, null)
    assert.equal(b.shareText, '–')
    assert.equal(b.projectedText, null)
  }
})

test('budget is a section key the panel can fold', () => {
  assert.ok((DASHBOARD_SECTION_KEYS as readonly string[]).includes('budget'))
  assert.deepEqual(parseWebviewMessage({ type: 'toggleSection', key: 'budget' }),
    { type: 'toggleSection', key: 'budget' })
})

// ---------------------------------------------------------------------------
// Why this colour, and the prompt-cache line
// ---------------------------------------------------------------------------

/** No band and a three-percent measuring phase, stated outright so no preset decides the words. */
const PACE_NO_BAND = {
  'tokenPace.pace.sensitivity': 'custom',
  'tokenPace.pace.tolerancePoints': 0,
  'tokenPace.pace.minElapsedPercent': 3,
}

test('every window explains its colour from the very verdict that coloured it', () => {
  const vm = buildViewModel(makeInput({ cfg: makeConfig(PACE_NO_BAND) }))
  const [five, seven] = vm.quotas[0].windows
  // 40 % used with 60 % of the window gone: green, and the words say by how much.
  assert.equal(five.level, 'ok')
  assert.equal(five.explain.title, 'Why green')
  assert.equal(five.explain.lines[0], 'Used 40 % of the window; 60 % of its time has passed → 20 % behind pace.')
  assert.equal(five.explain.lines[1], 'Yellow as soon as the reading is ahead of pace; green at or behind.')
  // A fresh reading adds no stale line.
  assert.equal(five.explain.lines.length, 2)
  // 62 % used with four of seven days gone: five points ahead, yellow at once without a band —
  // and the gap in the explanation is the gap of the verdict, rounded the same way.
  assert.equal(seven.level, 'warn')
  assert.equal(seven.verdict.text, '5 % ahead of pace')
  assert.equal(seven.explain.title, 'Why yellow')
  assert.equal(seven.explain.lines[0], 'Used 62 % of the window; 57 % of its time has passed → 5 % ahead of pace.')
  // The Codex card explains its windows the same way.
  for (const w of vm.quotas[1].windows) assert.ok(w.explain.lines.length >= 2, w.label)
})

test('the explanation follows the window into every state the card can be in', () => {
  const explainOf = (over: Partial<QuotaWindow>, quota: Parameters<typeof state>[1] = {}) =>
    buildViewModel(makeInput({
      cfg: makeConfig(PACE_NO_BAND),
      quotas: [state('claude', { windows: [win(over)], ...quota })],
    })).quotas[0].windows[0].explain
  // Exhausted: red for that reason, with the reset it waits for, and no yellow rule.
  const full = explainOf({ percent: 100 })
  assert.equal(full.title, 'Why red')
  assert.equal(full.lines[0], '100 % used — exhausted until the reset at 14:00.')
  assert.equal(full.lines.some((l) => l.startsWith('Yellow')), false, JSON.stringify(full.lines))
  // No clock: no pace, and the sentence that says so.
  const noClock = explainOf({ resetsAt: null, windowMinutes: null })
  assert.equal(noClock.title, 'Why green')
  assert.equal(noClock.lines[0], 'Used 40 % of the window.')
  assert.equal(noClock.lines[1], 'This window reports no reset time, so there is no pace; the colour follows the level only.')
  // A passed reset: neutral, and the figure is named as the old window's.
  const due = explainOf({ percent: 62, resetsAt: NOW - 60_000 })
  assert.equal(due.title, 'Why grey')
  assert.ok(due.lines[0].startsWith('The stated reset (11:59) has passed'), due.lines[0])
  assert.equal(due.lines.some((l) => /ahead|behind|on pace/.test(l)), false, JSON.stringify(due.lines))
  // No limit: no share, no pace, no colour.
  assert.equal(explainOf({ unlimited: true, percent: 0 }).title, 'Why no colour')
  // Stale by the same clock as the card's own flag, in the last line.
  const old = buildViewModel(makeInput({
    cfg: makeConfig(PACE_NO_BAND),
    quotas: [state('claude', { fetchedAt: Math.round((NOW - 42 * 60_000) / 1000) })],
  })).quotas[0]
  assert.equal(old.stale, true)
  const lines = old.windows[0].explain.lines
  assert.equal(lines[lines.length - 1], 'The reading is 42 min old (stale after 20 min); the colour may lag.')
})

test('a measuring window is explained by the phase it is in, with the clock time it ends', () => {
  // A five-point band, so the phase holds up to ten percent under either reading of the rule.
  const vm = buildViewModel(makeInput({
    cfg: makeConfig({ ...PACE_NO_BAND, 'tokenPace.pace.tolerancePoints': 5 }),
    quotas: [state('claude', { windows: [win({ percent: 3, resetsAt: NOW + 5 * 3_600_000 - 30_000, windowMinutes: 300 })] })],
  }))
  const w = vm.quotas[0].windows[0]
  assert.equal(w.verdict.measuring, true)
  assert.equal(w.explain.title, 'Why green')
  assert.equal(w.explain.lines[0], 'Used 3 % of the window; 0 % of its time has passed → 3 % ahead of pace.')
  // The window started 30 s ago; three percent of five hours is nine minutes in.
  assert.equal(w.explain.lines[1],
    'Measuring until 3 % of the window has passed (12:08); no verdict before that unless usage exceeds 10 %.')
  assert.equal(w.explain.lines[2], 'Yellow when more than 5 % ahead of pace (your tolerance band); green at or below that.')
  // The accessibility text and the header still say nothing about the measuring — the
  // explanation is where the phase is named, and only there.
  assert.equal(/measuring/i.test(w.aria.text), false)
})

const CACHE = {
  warm: true, ttl: '5m' as const, expiresAt: NOW + 220_000, hitRatio: 0.82,
  readAt: Math.round((NOW - 60_000) / 1000),
}

test('the prompt-cache line is the Claude card\'s, from the bridge and from nothing else', () => {
  const vm = buildViewModel({ ...makeInput(), promptCache: CACHE })
  const c = vm.quotas[0].promptCache
  assert.ok(c)
  assert.equal(c.text, 'prompt cache warm · expires in 3 m 40 s (5 min TTL) · hit ratio 82 %')
  assert.equal(c.expired, false)
  assert.equal(c.readAt, CACHE.readAt)
  assert.equal(c.warm, true)
  assert.equal(c.note, 'current session, via the status line')
  // Codex has no status line, so it never gets one — and without a reading neither does
  // Claude, three days of ingested cache reads notwithstanding: there is no second source.
  assert.equal(vm.quotas[1].promptCache, null)
  assert.equal(buildViewModel(makeInput()).quotas[0].promptCache, null)
  assert.equal(buildViewModel({ ...makeInput(), promptCache: null }).quotas[0].promptCache, null)
})

test('the countdown is as of the model\'s own clock, and past the expiry the line says so', () => {
  const later = buildViewModel({ ...makeInput(), now: NOW + 60_000, promptCache: CACHE }).quotas[0].promptCache
  assert.ok(later?.text.includes('expires in 2 m 40 s'), later?.text)
  const gone = buildViewModel({ ...makeInput(), now: NOW + 300_000, promptCache: CACHE }).quotas[0].promptCache
  assert.equal(gone?.text, 'prompt cache · expired at 12:03 (last reading) · hit ratio 82 %')
  assert.equal(gone?.expired, true)
  // Every part the payload left out is a dash; none is inferred from the others.
  const bare = buildViewModel({
    ...makeInput(), promptCache: { warm: null, ttl: null, expiresAt: null, hitRatio: null, readAt: null },
  }).quotas[0].promptCache
  assert.equal(bare?.text, 'prompt cache – · expires in – (– TTL) · hit ratio –')
  assert.equal(bare?.expired, false)
})

/**
 * A window turning over `cycles` times: four rising readings, then a fall no `resetsAt`
 * announced — the evidence `quotaHistory.cycles()` splits a complete cycle on.
 */
function fillCompleteCycles(history: QuotaHistory, cycles: number): void {
  let t = NOW - 24 * 3_600_000
  for (let c = 0; c <= cycles; c++) {
    for (const percent of [20, 40, 60, 80]) {
      history.add(
        {
          source: 'claude', ok: true, origin: 'poll', fetchedAt: Math.round(t / 1000),
          planType: null, windows: [win({ percent })],
        },
        FINGERPRINT,
        t,
      )
      t += 30 * 60_000
    }
  }
}

test('the retrospective counts complete cycles, and one cycle is not "1 cycles"', () => {
  const one = makeHistory()
  fillCompleteCycles(one, 1)
  const first = buildViewModel(makeInput({ history: one })).retro
    .find((r) => r.windowId === 'session:300')
  assert.equal(first?.text, 'not enough data yet · 1 complete cycle on file')

  const two = makeHistory()
  fillCompleteCycles(two, 2)
  const second = buildViewModel(makeInput({ history: two })).retro
    .find((r) => r.windowId === 'session:300')
  assert.equal(second?.text, 'not enough data yet · 2 complete cycles on file')
})

// ---------------------------------------------------------------------------
// 1.7 P-A · one bucket copy per build
// ---------------------------------------------------------------------------

/** Counts `agg.all()` while `run` builds, and hands back every array it gave out. */
function countingAll<T>(agg: Aggregator, run: () => T): { value: T; calls: number; copies: Array<readonly unknown[]> } {
  const own = Object.prototype.hasOwnProperty.call(agg, 'all')
  const real = agg.all
  const copies: Array<readonly unknown[]> = []
  agg.all = function (this: Aggregator) {
    const copy = real.call(this)
    copies.push(copy)
    return copy
  }
  try {
    return { value: run(), calls: copies.length, copies }
  } finally {
    if (own) agg.all = real
    else delete (agg as unknown as { all?: unknown }).all
  }
}

/**
 * The worlds whose tables walk the buckets: the default one, and ones reaching each other walk —
 * each with what proves it reached it.
 */
function sharedCopyWorlds(): Array<[string, () => ReturnType<typeof makeInput>, (vm: ReturnType<typeof buildViewModel>) => boolean]> {
  return [
    ['the default world', () => makeInput(), (vm) => vm.models.rows.length > 0 && vm.totals.every((t) => t.rows.length === 8)],
    // Attribution on (the project and session tables), a model chip, one provider, a drilled day,
    // budgets of both units — every context the build spreads from its own.
    ['attribution, chips, a drill and budgets', () => makeInput({
      agg: buildAgg('session'),
      cfg: makeConfig({ 'tokenPace.attribution': 'session', 'tokenPace.budgets': BUDGETS }),
      ui: { providers: ['claude'], models: ['claude-opus-4-6'], drillDay: TODAY },
    }), (vm) => vm.sessions.rows.length > 0 && vm.projects.rows.length > 0 && vm.drill !== null && vm.budgets.length === 2
      && vm.models.rows.every((m) => m.model === 'claude-opus-4-6')],
    // No quota reading: the local 5-hour block sums its cost and its first used hour from the buckets.
    ['no quota reading', () => makeInput({
      quotas: [state('claude', { ok: false, problem: 'no OAuth token found', problemKind: 'noToken', windows: [] }), state('codex')],
    }), (vm) => vm.quotas[0].localBlock !== null && vm.quotas[0].localBlock.firstAt !== null],
    // A model window (1.6 P10c): its share takes its family's model ids from the hour sums' copy.
    ['a model window', () => {
      const week = win({ id: 'weekly_all:10080', kind: 'weekly', label: '7 d', percent: 62, resetsAt: NOW + 3 * 86_400_000, windowMinutes: 10080 })
      const opus = win({ ...week, id: 'weekly_scoped:10080:opus', label: '7 d · Opus', model: 'Opus' })
      return makeInput({ agg: familyAgg(), quotas: [state('claude', { windows: [week, opus] }), state('codex')] })
    }, (vm) => vm.quotas[0].windows[1].agentShare === 'Subagents 1.5K of 5.5K counted here (27 %)'],
  ]
}

test('a view-model build copies the buckets exactly once, and every table reads that one copy (1.7 P-A)', () => {
  for (const [what, make, reached] of sharedCopyWorlds()) {
    const input = make()
    const shared = countingAll(input.agg, () => buildViewModel(input))
    assert.equal(shared.calls, 1, `${what}: agg.all() was called ${shared.calls} times in one build`)
    assert.ok(reached(shared.value), `${what}: the world no longer reaches the tables it is here for`)
    // Read only: the one copy still holds every bucket, in the aggregator's order.
    const [copy] = shared.copies
    const now = input.agg.all()
    assert.equal(copy.length, now.length, `${what}: the shared copy changed length`)
    assert.ok(copy.every((b, i) => b === now[i]), `${what}: the shared copy was reordered or changed`)
    // The path of 1.6 — every table its own copy — gives the very same view model.
    const unshared = countingAll(input.agg, () => buildViewModel(input, { shareBuckets: false }))
    assert.ok(unshared.calls > 1, `${what}: the unshared build made ${unshared.calls} copies; the comparison compares nothing`)
    assert.deepEqual(shared.value, unshared.value, `${what}: the shared copy changed a figure`)
  }
})

// ---------------------------------------------------------------------------
// 1.8 L-2 · the calendar parts and the prices looked up once per key
// ---------------------------------------------------------------------------

/**
 * The four worlds of 1.7 P-A, and one that reaches the memos' other doors: a named zone with a day
 * boundary, configured prices beside the list prices, the family rule, and the Agents tree's 7-day block
 * with its costs.
 */
function memoWorlds(): Array<[string, () => ReturnType<typeof makeInput>]> {
  const { agg } = withAgents()
  return [
    ...sharedCopyWorlds().map(([what, make]): [string, () => ReturnType<typeof makeInput>] => [what, make]),
    ['Berlin, a day boundary, configured prices, the family rule and the 7-day block', () => makeInput({
      agg,
      cfg: makeConfig({
        'tokenPace.timezone': 'Europe/Berlin', 'tokenPace.dayBoundaryHour': 5, 'tokenPace.attribution': 'project',
        'tokenPace.customPrices': { 'claude-sonnet-4-6': { input: 2, output: 9 } }, 'tokenPace.unknownModelPricing': 'family',
        'tokenPace.pricing.multiplier': 0.9, 'tokenPace.pricing.showListPrice': true, 'tokenPace.budgets': BUDGETS,
      }),
      ui: { agentsWeekOpen: true },
    })],
  ]
}

test('a view-model build with the memos equals the build without them, cold and warm, in five worlds (1.8 L-2)', () => {
  try {
    for (const [what, make] of memoWorlds()) {
      const input = make()
      resetTimeMemos(false)
      resetPriceMemos(false)
      const plain = buildViewModel(input)
      resetTimeMemos()
      resetPriceMemos()
      const cold = buildViewModel(input)
      const warm = buildViewModel(input)
      assert.deepEqual(cold, plain, `${what}: the memos changed the view model`)
      assert.deepEqual(warm, plain, `${what}: a warm memo changed the view model`)
      // The memoised builds did keep answers: the comparison compares the two paths, not one with itself.
      assert.ok(resetTimeMemos() > 0, `${what}: no calendar part was kept`)
      assert.ok(resetPriceMemos().models > 0, `${what}: no model name was kept`)
    }
    // The fifth world reaches what it is there for: its costs in the tree, at the configured rates.
    const input = memoWorlds()[4][1]()
    assert.deepEqual([input.cfg.timezone, input.cfg.dayBoundaryHour, input.cfg.pricing.multiplier, input.cfg.pricing.showListPrice,
      input.cfg.unknownModelPricing, Object.keys(input.cfg.customPrices)], ['Europe/Berlin', 5, 0.9, true, 'family', ['claude-sonnet-4-6']])
    const vm = buildViewModel(input)
    assert.match(vm.agents.week?.totalCost ?? '', /^~\$\d/)
    assert.equal(vm.pricing.custom, true)
    assert.ok(vm.models.rows.some((r) => r.priced === 'custom'), 'the fifth world prices no model at configured rates')
  } finally {
    resetTimeMemos()
    resetPriceMemos()
  }
})

test('one pricing options object per build: the Agents tree takes the build\'s own (1.8 L-2)', () => {
  // agentTreeFor prices with the object it is handed …
  const { agg } = withAgents()
  const input = makeInput({ agg, cfg: makeConfig({ 'tokenPace.attribution': 'project' }), ui: { agentsWeekOpen: true } })
  const own = agentTreeFor(input, 'page').week
  const listed = agentTreeFor(input, 'page', pricingOf(input.cfg)).week
  const halved = agentTreeFor(input, 'page', { ...pricingOf(input.cfg), multiplier: 0.5 }).week
  assert.ok(own && listed && halved)
  assert.deepEqual(listed, own, 'the build\'s own object prices the tree as its own did')
  assert.notEqual(halved.totalCost, own.totalCost, 'the object handed in is not the one the tree priced with')
  // … and with costs off with none at all.
  const off = makeInput({ agg, cfg: makeConfig({ 'tokenPace.attribution': 'project', 'tokenPace.showCost': false }), ui: { agentsWeekOpen: true } })
  assert.equal(agentTreeFor(off, 'page', pricingOf(off.cfg)).week?.totalCost, null)
  // buildViewModel builds exactly one options object and hands that one to the tree.
  const src = readFileSync(path.join(ROOT, 'src', 'viewModel.ts'), 'utf8')
  const start = src.indexOf('export function buildViewModel(')
  const body = src.slice(start, src.indexOf('\n}\n', start))
  assert.equal(body.match(/pricingOf\(/g)?.length, 1, 'buildViewModel builds more than one pricing options object')
  assert.ok(body.includes("agentTreeFor(input, 'page', pricing)"), 'buildViewModel no longer hands its pricing to the Agents tree')
})

// ---------------------------------------------------------------------------
// 1.7 F1: the provider switch — one provider, or every one
// ---------------------------------------------------------------------------

/** Budgets of all three scopes, and the calibration and plan prices shown, so every per-provider part has rows. */
const F1_CFG = {
  'tokenPace.budgets': [
    { scope: 'total', period: 'month', unit: 'usd', limit: 20 },
    { scope: 'claude', period: 'day', unit: 'tokens', limit: 5_000_000 },
    { scope: 'codex', period: 'month', unit: 'tokens', limit: 1_000_000 },
  ],
  'tokenPace.planPriceUsd': { claude: 200, codex: 20 },
  'tokenPace.calibration.show': true,
  'tokenPace.attribution': 'project',
}

/** The switch's world: agents (one running), every per-provider part filled, a reading of the prompt cache. */
function f1Input(providers?: ('claude' | 'codex')[]): ReturnType<typeof makeInput> {
  const { agg } = withAgents()
  const history = makeHistory()
  fillHistory(history)
  fillHistory(history, 'codex')
  const input = makeInput({ agg, history, cfg: makeConfig(F1_CFG), ...(providers ? { ui: { providers } } : {}) })
  return { ...input, promptCache: CACHE }
}

const CLAUDE_ONLY_CODEX = 'Claude Code only — not shown while Codex is selected.'
const SHOWING = (title: string): string => `Showing ${title} only — the provider switch at the top of the dashboard; ‘All’ shows every provider.`

test('under All the switch changes nothing 1.6 built from every provider: each field is its stats function over every source, in registry order, whatever order the list was stored in (1.7 F1)', () => {
  const plain = buildViewModel(f1Input())
  for (const order of [['claude', 'codex'], ['codex', 'claude']] as const) {
    const input = f1Input([...order])
    const vm = buildViewModel(input)
    assert.equal(vm.provider, 'all', order.join())
    assert.equal(vm.claudeOnly, null, order.join())
    // The same stats functions, called here with every source as 1.6 called them.
    const cfgX = input.cfg
    const tcfgX = timeConfig(cfgX)
    const ctx: StatsCtx = {
      agg: input.agg, tcfg: tcfgX, pricing: pricingOf(cfgX), now: NOW, sources: [...SOURCES], models: [],
      showCost: cfgX.showCost, attribution: cfgX.attribution,
    }
    const month = rangeFor('30d', NOW, tcfgX)
    const st = input.agg.stats()
    const firstDay = input.agg.firstIngest !== null ? dayOf(input.agg.firstIngest, tcfgX) : st.oldestDay
    const windowsOf = (source: 'claude' | 'codex') => input.quotas.find((q) => q.source === source)?.windows ?? []
    assert.deepEqual(vm.totals, SOURCES.map((source) => ({
      source, title: SOURCE_TITLE[source],
      rows: totalsFor(ctx, source, null, null, firstDay, cfgX.pricing.showListPrice, windowsOf(source)),
    })), `${order.join()}: totals`)
    assert.deepEqual(vm.composition, composition(ctx, month), `${order.join()}: composition`)
    assert.deepEqual(vm.cacheEconomy, cacheEconomy(ctx, month), `${order.join()}: cache economy`)
    assert.deepEqual(vm.calendar, calendar(ctx), `${order.join()}: calendar`)
    assert.deepEqual(vm.planFactor, planFactors(ctx, cfgX.planPriceUsd), `${order.join()}: plan factor`)
    assert.deepEqual(vm.budgets, budgetRows(ctx, cfgX.budgets, NOW), `${order.join()}: budgets`)
    assert.deepEqual(vm.dataQuality.quota, SOURCES.map((source) => ({
      source, candidates: input.candidates[source], drift: input.drift[source],
    })), `${order.join()}: data quality`)
    // Every provider still in every one of them, and the rest as the default list builds it.
    assert.deepEqual(vm.quotas.map((q) => q.source), ['claude', 'codex'])
    assert.deepEqual(vm.totals.map((x) => x.source), ['claude', 'codex'])
    assert.deepEqual(vm.planFactor.map((x) => x.source), ['claude', 'codex'])
    assert.deepEqual([...new Set(vm.retro.map((r) => r.source))], ['claude', 'codex'])
    assert.deepEqual(vm.budgets.map((b) => b.scope), ['total', 'claude', 'codex'])
    for (const field of ['quotas', 'retro', 'dataQuality', 'agents', 'context', 'kpis', 'models', 'chart', 'footnotes'] as const) {
      assert.deepEqual(vm[field], plain[field], `${order.join()}: ${field}`)
    }
    assert.equal(vm.footnotes.some((f) => f.startsWith('Showing ')), false, `${order.join()}: a switch footnote under All`)
  }
})

test('under Codex only Codex is shown — its card, its tokens, its models, its budgets — and the agent tree is still built whole (1.7 F1)', () => {
  const all = buildViewModel(f1Input())
  const vm = buildViewModel(f1Input(['codex']))
  assert.equal(vm.provider, 'codex')
  assert.equal(vm.claudeOnly, CLAUDE_ONLY_CODEX)
  // The quota section: the Codex card alone, the very card All shows.
  assert.deepEqual(vm.quotas.map((q) => q.source), ['codex'])
  assert.deepEqual(vm.quotas, all.quotas.filter((q) => q.source === 'codex'))
  // The Tokens section: Codex only, every model of it, the fixed periods.
  assert.deepEqual(vm.totals.map((x) => x.source), ['codex'])
  assert.deepEqual(vm.totals, all.totals.filter((x) => x.source === 'codex'))
  assert.deepEqual(vm.composition.map((x) => x.source), ['codex'])
  assert.deepEqual(vm.cacheEconomy.map((x) => x.source), ['codex'])
  assert.deepEqual(vm.planFactor.map((x) => x.source), ['codex'])
  // No Claude model anywhere below.
  assert.ok(vm.models.rows.length > 0)
  assert.ok(vm.models.rows.every((r) => r.source === 'codex'), vm.models.rows.map((r) => r.model).join())
  assert.ok(vm.chart.series.length > 0)
  assert.ok(vm.chart.series.every((x) => x.source === 'codex'), vm.chart.series.map((x) => x.key).join())
  assert.deepEqual(toolVm({}, { providers: ['codex'] }).tools.rows.map((r) => r.name), ['exec'])
  // The agent tree is the host's too (the poll, the status bar): whole, the running agent and the
  // launch in it.
  assert.equal(all.agents.running, 2)
  assert.equal(vm.agents.running, all.agents.running)
  assert.deepEqual(vm.agents, all.agents)
  assert.deepEqual(vm.context, all.context)
  // Budgets: the total and the Codex one, not the Claude one — the same figures as under All.
  assert.deepEqual(vm.budgets.map((b) => b.scope), ['total', 'codex'])
  const total = vm.budgets.find((b) => b.scope === 'total')
  assert.equal(total?.used, all.budgets.find((b) => b.scope === 'total')?.used)
  assert.deepEqual(vm.allBudgets, all.budgets)
  // The history and the data quality's per-provider parts: Codex's.
  assert.ok(vm.retro.length > 0)
  assert.ok(vm.retro.every((r) => r.source === 'codex'))
  assert.deepEqual(vm.dataQuality.quota.map((q) => q.source), ['codex'])
  assert.ok(vm.dataQuality.calibration.length > 0)
  assert.ok(vm.dataQuality.calibration.every((c) => c.source === 'codex'))
  assert.notEqual(all.dataQuality.agents, null)
  assert.equal(vm.dataQuality.agents, null)
  // The lines about the machine stay whole.
  for (const key of ['roots', 'files', 'oldestDay', 'newestDay', 'buckets', 'snapshotBytes', 'consent', 'leader', 'retention',
    'history', 'bridge', 'attribution', 'version'] as const) {
    assert.deepEqual(vm.dataQuality[key], all.dataQuality[key], key)
  }
  // The footnote says what the page shows, first, once; All has none.
  assert.equal(vm.footnotes[0], SHOWING('Codex'))
  assert.equal(vm.footnotes.filter((f) => f.startsWith('Showing ')).length, 1)
  assert.equal(all.footnotes.some((f) => f.startsWith('Showing ')), false)
})

test('under Claude Code the Claude card keeps its prompt-cache line and its subagent shares, and nothing is left out (1.7 F1)', () => {
  const all = buildViewModel(f1Input())
  const vm = buildViewModel(f1Input(['claude']))
  assert.equal(vm.provider, 'claude')
  assert.equal(vm.claudeOnly, null)
  assert.deepEqual(vm.quotas.map((q) => q.source), ['claude'])
  assert.deepEqual(vm.quotas, all.quotas.filter((q) => q.source === 'claude'))
  assert.ok(vm.quotas[0].promptCache !== null, 'the prompt-cache line is gone')
  assert.ok(vm.quotas[0].windows.some((w) => w.agentShare !== null), 'the subagent share is gone')
  assert.deepEqual(vm.agents, all.agents)
  assert.ok(vm.agents.roots.length > 0)
  assert.notEqual(vm.dataQuality.agents, null)
  assert.deepEqual(vm.dataQuality.agents, all.dataQuality.agents)
  assert.deepEqual(vm.totals.map((x) => x.source), ['claude'])
  assert.deepEqual(vm.budgets.map((b) => b.scope), ['total', 'claude'])
  assert.equal(vm.footnotes[0], SHOWING('Claude Code'))
  // The subagent share over the same bounds as the Claude totals row: the whole is its usage.
  const rows = vm.totals[0].rows
  assert.equal(rows[0].usage, all.totals[0].rows[0].usage)
})

test('the switch message names one of its states; a new view shows its sources and clears the model chips, the same view is the same object (1.7 F1)', () => {
  for (const provider of ['all', 'claude', 'codex'] as const) {
    assert.deepEqual(parseWebviewMessage({ type: 'setProvider', provider }), { type: 'setProvider', provider })
  }
  for (const provider of ['gemini', null, ['claude'], 'CLAUDE', undefined, 1, '', 'All']) {
    assert.equal(parseWebviewMessage({ type: 'setProvider', provider }), null, JSON.stringify(provider) ?? 'undefined')
  }
  assert.equal(parseWebviewMessage({ type: 'setProvider' }), null)
  const ui = { ...defaultUiState(cfg), models: ['claude-opus-4-6'] }
  // The view shown already: nothing to store, by identity.
  assert.equal(applyMessage(ui, { type: 'setProvider', provider: 'all' }), ui)
  const codex = applyMessage(ui, { type: 'setProvider', provider: 'codex' })
  assert.deepEqual(codex.providers, ['codex'])
  assert.deepEqual(codex.models, [], 'a model chip survived the change of provider')
  assert.deepEqual(ui.models, ['claude-opus-4-6'], 'the input state was mutated')
  assert.equal(applyMessage(codex, { type: 'setProvider', provider: 'codex' }), codex)
  const back = applyMessage({ ...codex, models: ['gpt-5.3-codex'] }, { type: 'setProvider', provider: 'all' })
  assert.deepEqual(back.providers, ['claude', 'codex'])
  assert.deepEqual(back.models, [], 'a change to All kept the model chips')
  assert.deepEqual(applyMessage(ui, { type: 'setProvider', provider: 'claude' }).providers, ['claude'])
  // A value that is no state of the switch changes nothing, even past the parser.
  assert.equal(applyMessage(ui, { type: 'setProvider', provider: 'gemini' as never }), ui)
  // The stored list and the view: exactly one known source is that source, anything else All.
  assert.equal(providerViewOf(['claude']), 'claude')
  assert.equal(providerViewOf(['codex']), 'codex')
  for (const list of [[], ['claude', 'codex'], ['codex', 'claude'], ['claude', 'claude'], ['x'], ['all'], ['claude', 'x']]) {
    assert.equal(providerViewOf(list as never), 'all', JSON.stringify(list))
  }
  assert.deepEqual(viewSources('all'), ['claude', 'codex'])
  assert.deepEqual(viewSources('codex'), ['codex'])
  // So the chips' message can store no other subset either: both, in any order, or none, is All.
  for (const providers of [['codex', 'claude'], [], ['claude', 'codex']] as const) {
    assert.deepEqual(applyMessage(ui, { type: 'setFilter', providers: [...providers], models: [] }).providers, ['claude', 'codex'])
  }
  assert.deepEqual(applyMessage(ui, { type: 'setFilter', providers: ['codex'], models: ['m'] }).models, ['m'],
    'the model chips\' own message cleared the models')
})
