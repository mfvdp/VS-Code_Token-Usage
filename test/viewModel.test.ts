// SPDX-FileCopyrightText: 2026 Frederik Marx
// SPDX-License-Identifier: AGPL-3.0-or-later

import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { Aggregator } from '../src/agg'
import { DEFAULT_FORECAST_CONFIG } from '../src/forecast'
import { rangeFor } from '../src/time'
import { QuotaSample, QuotaWindow, TOOL_NAME_CAP } from '../src/types'
import { paceVerdict, windowElapsed } from '../src/pace'
import { THIN_RECENT_DAYS, THIN_RECENT_SLOT_MS } from '../src/quotaHistory'
import {
  DASHBOARD_SECTION_KEYS, PROBLEM_ACTION, SOURCE_TITLE, SPARK_DAYS, SPARK_SLOTS, SPARK_SLOT_MS,
  WEBVIEW_COMMANDS, WindowVm, applyMessage, buildViewModel, defaultUiState, forecastsFor,
  parseWebviewMessage, sparkOf,
} from '../src/viewModel'
import {
  FINGERPRINT, NOW, TODAY, buildAgg, fillHistory, makeConfig, makeHistory, makeInput, state,
  timeConfig, win,
} from './fixtures/viewFixtures'
import { claudeLine, ctxFor } from './fixtures/helpers'
import { toolAgg } from './helpers/toolAgg'

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

  // Range, previous, the two running windows, today, 7d, 30d, this week, this month, all
  // time — minus the fixed row the selected 30-day range already is, which would otherwise
  // appear twice.
  for (const t of vm.totals) assert.equal(t.rows.length, 9)
  // The windows the provider reported, held against the same bounds the quota card draws.
  assert.deepEqual(vm.totals[0].rows.slice(2, 4).map((r) => r.label),
    ['Current 5 h window', 'Current 7 d window'])
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
  assert.deepEqual(claude?.rows.slice(2, 4).map((r) => r.label),
    ['Current 5 h window', 'Current 7 d window'])
  assert.deepEqual(codex?.rows.slice(2, 4).map((r) => r.label), ['Last 5 h', 'Last 7 d'])
  // The window row's span is the window's own, not the range's.
  assert.equal(claude?.rows[2].spanText, '09:00 \u2192 now')
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

test('the model filter and the provider filter reach every section', () => {
  const only = buildViewModel(makeInput({ ui: { providers: ['codex'], models: ['gpt-5.3-codex'] } }))
  assert.equal(only.totals.length, 1)
  assert.equal(only.totals[0].source, 'codex')
  assert.deepEqual(only.models.rows.map((r) => r.model), ['gpt-5.3-codex'])
  assert.equal(only.chart.series.length, 1)
  assert.equal(only.cacheEconomy.length, 1)
})

test('the chart is stacked by provider and model and carries the configured style', () => {
  const vm = buildViewModel(makeInput())
  assert.equal(vm.chart.modelStyle, 'pattern')
  assert.ok(vm.chart.series.length > 1)
  assert.equal(vm.chart.series.every((s) => s.key === `${s.source}:${s.label}`), true)
  // No stacking to switch any more: neither the chart nor the UI state carries one.
  assert.equal('stack' in vm.chart, false)
  assert.equal('chartStack' in vm.ui, false)
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
  const vm = sparkOf([], NOW, 300, cfg.pace)
  assert.equal(vm.slots, SPARK_SLOTS)
  assert.equal(vm.to - vm.from, SPARK_DAYS * DAY)
  assert.ok(vm.from <= NOW && NOW < vm.to, 'now lies inside the grid')
  assert.equal(vm.to, Math.floor(NOW / SPARK_SLOT_MS) * SPARK_SLOT_MS + SPARK_SLOT_MS, 'slots are aligned to the quarter hour')
  assert.ok(NOW - vm.from >= (SPARK_SLOTS - 1) * SPARK_SLOT_MS, 'at most one partial slot is missing from the seven days')
  assert.deepEqual(vm.points, [])
  assert.deepEqual(vm.bridges, [])
  // An unaligned now still ends in the slot that contains it.
  const odd = sparkOf([sample(NOW + 7 * MIN, 10)], NOW + 7 * MIN, 300, cfg.pace)
  assert.equal(odd.points[0].i, SPARK_SLOTS - 1)
  assert.ok(odd.from <= NOW + 7 * MIN - (SPARK_SLOTS - 1) * SPARK_SLOT_MS)
})

test('samples land in the slot their time falls into; older than the grid they are dropped', () => {
  const { from } = sparkOf([], NOW, 300, cfg.pace)
  const vm = sparkOf([
    sample(from - 1, 5),               // one millisecond before the grid: gone, not stretched
    sample(from, 10),                  // start of the grid (seven days less one slot before now)
    sample(NOW - 15 * MIN, 40),        // one slot before the slot of now
    sample(NOW, 42),                   // the slot of now is the last one
    sample(NOW - 3 * DAY, 30),
  ], NOW, 300, cfg.pace)
  assert.deepEqual(vm.points.map((p) => [p.i, p.p]), [
    [0, 10], [SPARK_SLOTS - 1 - 3 * 96, 30], [SPARK_SLOTS - 2, 40], [SPARK_SLOTS - 1, 42],
  ])
  // Older than the whole window: nothing at all rather than a line from nowhere.
  assert.deepEqual(sparkOf([sample(NOW - 40 * DAY, 90)], NOW, 300, cfg.pace).points, [])
  // Ascending, unique, inside the grid — the renderer relies on it.
  const ids = vm.points.map((p) => p.i)
  assert.deepEqual(ids, [...new Set(ids)].sort((a, b) => a - b))
  assert.ok(ids.every((i) => i >= 0 && i < SPARK_SLOTS))
})

test('the last reading of a slot wins', () => {
  const t0 = Math.floor(NOW / SPARK_SLOT_MS) * SPARK_SLOT_MS - SPARK_SLOT_MS
  const vm = sparkOf([sample(t0 + 9 * MIN, 30), sample(t0 + MIN, 10), sample(t0 + 5 * MIN, 20)], NOW, 300, cfg.pace)
  assert.deepEqual(vm.points.map((p) => [p.i, p.p]), [[SPARK_SLOTS - 2, 30]])
})

test('every point carries the pace level the bar would have shown at that time', () => {
  const r = NOW + 2 * 3_600_000
  const t = NOW - 30 * MIN
  const vm = sparkOf([sample(t, 70, r), sample(NOW, 20, r)], NOW, 300, cfg.pace)
  const expected = paceVerdict(70, windowElapsed(r, 300, t), cfg.pace)
  assert.equal(expected.level, 'warn', 'the fixture is ahead of pace, or the test proves nothing')
  assert.equal(vm.points[0].level, 'warn')
  assert.equal(vm.points[1].level, paceVerdict(20, windowElapsed(r, 300, NOW), cfg.pace).level)
  assert.equal(vm.points[1].level, 'ok')
  // No clock: no verdict — from the sample's side or from the window's.
  assert.equal(sparkOf([sample(t, 70, null)], NOW, 300, cfg.pace).points[0].level, null)
  assert.equal(sparkOf([sample(t, 70, r)], NOW, null, cfg.pace).points[0].level, null)
  // Exhausted is a fact, not a pace: 'error' with or without a clock, like the bar.
  assert.equal(sparkOf([sample(t, 100, r)], NOW, 300, cfg.pace).points[0].level, 'error')
  assert.equal(sparkOf([sample(t, 99.5, null)], NOW, null, cfg.pace).points[0].level, 'error')
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
  assert.equal(sparkOf([sample(NOW, 60, resetsAt)], NOW, 300, cfg.pace).points[0].level, 'warn')
  // A small bill in the same young window still gets the benefit of the doubt.
  const small = buildViewModel(makeInput({
    quotas: [state('claude', { windows: [win({ percent: 6, resetsAt, windowMinutes: 300 })] })],
  })).quotas[0].windows[0]
  assert.equal(small.verdict.measuring, true)
  assert.equal(small.level, 'ok')
  assert.equal(small.aria.text, '5 h: 6% used')
  assert.equal(sparkOf([sample(NOW, 6, resetsAt)], NOW, 300, cfg.pace).points[0].level, 'ok')
})

test('a hole without a reset inside is bridged; a hole across a reset stays a hole', () => {
  const r1 = NOW + 3_600_000
  const r2 = NOW + 6 * 3_600_000
  const at = (slotsAgo: number) => NOW - slotsAgo * SPARK_SLOT_MS
  // Same resetsAt, usage rose: the readings simply stopped for a while.
  const same = sparkOf([sample(at(10), 20, r1), sample(at(2), 25, r1)], NOW, 300, cfg.pace)
  assert.deepEqual(same.bridges, [{ from: SPARK_SLOTS - 11, to: SPARK_SLOTS - 3 }])
  // Both without a reset time: also a bridge.
  const nulls = sparkOf([sample(at(10), 20), sample(at(2), 20)], NOW, 300, cfg.pace)
  assert.equal(nulls.bridges.length, 1)
  // The provider announced a new reset in between: the window turned over in the dark.
  const reset = sparkOf([sample(at(10), 20, r1), sample(at(2), 25, r2)], NOW, 300, cfg.pace)
  assert.deepEqual(reset.bridges, [])
  // A fall of more than a point without a new reset is a reset too.
  const fell = sparkOf([sample(at(10), 20, r1), sample(at(2), 18, r1)], NOW, 300, cfg.pace)
  assert.deepEqual(fell.bridges, [])
  // A fall of exactly one point is rounding, not a reset.
  const rounding = sparkOf([sample(at(10), 20, r1), sample(at(2), 19, r1)], NOW, 300, cfg.pace)
  assert.equal(rounding.bridges.length, 1)
  // Adjacent slots are joined by the line itself, not by a bridge.
  const adjacent = sparkOf([sample(at(3), 20, r1), sample(at(2), 21, r1)], NOW, 300, cfg.pace)
  assert.deepEqual(adjacent.bridges, [])
})

test('the first reading of a new window is flagged so its stroke can stay neutral', () => {
  const r1 = NOW + 3_600_000
  const r2 = NOW + 6 * 3_600_000
  const at = (slotsAgo: number) => NOW - slotsAgo * SPARK_SLOT_MS
  const vm = sparkOf([
    sample(at(3), 80, r1), sample(at(2), 90, r1), sample(at(1), 5, r2), sample(at(0), 12, r2),
  ], NOW, 300, cfg.pace)
  assert.deepEqual(vm.points.map((p) => p.reset), [undefined, undefined, true, undefined])
  // The first point of the whole line never carries it: there is no stroke leading into it.
  assert.equal(sparkOf([sample(at(1), 5, r2)], NOW, 300, cfg.pace).points[0].reset, undefined)
  // A reset time appearing or disappearing is a change as much as a different one is.
  const appears = sparkOf([sample(at(1), 5, null), sample(at(0), 6, r2)], NOW, 300, cfg.pace)
  assert.deepEqual(appears.points.map((p) => p.reset), [undefined, true])
  const vanishes = sparkOf([sample(at(1), 5, r2), sample(at(0), 6, null)], NOW, 300, cfg.pace)
  assert.deepEqual(vanishes.points.map((p) => p.reset), [undefined, true])
  // The flag follows the reported reset, not the fall: a reading that dropped inside the same
  // window is a correction, and its stroke keeps the pace colour.
  const fell = sparkOf([sample(at(1), 20, r1), sample(at(0), 4, r1)], NOW, 300, cfg.pace)
  assert.deepEqual(fell.points.map((p) => p.reset), [undefined, undefined])
  // A bridge never crosses a reset by definition, so a bridged point is never flagged.
  const hole = sparkOf([sample(at(9), 20, r1), sample(at(2), 25, r1)], NOW, 300, cfg.pace)
  assert.equal(hole.bridges.length, 1)
  assert.deepEqual(hole.points.map((p) => p.reset), [undefined, undefined])
})

test('the quota card carries the sparkline and its own gap count', () => {
  const history = makeHistory()
  fillHistory(history)
  const vm = buildViewModel(makeInput({ history }))
  const card = vm.quotas[0].windows.find((w) => w.id === 'session:300') as WindowVm
  assert.equal(card.spark.points.length, 9, 'nine readings a quarter hour apart: nine slots')
  assert.equal(card.spark.points[8].i, SPARK_SLOTS - 1)
  assert.deepEqual(card.spark.bridges, [])
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
    // The chart is always stacked by model; the stacking message of older pages is nothing.
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

test('parseWebviewMessage keeps the command allow-list to eleven harmless commands', () => {
  // Eleven, not nine: the empty quota state offers the two ways to get a reading, and both
  // of those commands ask before they act — connecting the status line goes through its own
  // write consent and writes its own backup.
  assert.equal(WEBVIEW_COMMANDS.length, 11)
  for (const id of WEBVIEW_COMMANDS) {
    assert.deepEqual(parseWebviewMessage({ type: 'command', id }), { type: 'command', id })
    assert.match(id, /^tokenPace\./)
  }
  // Nothing that undoes a user's setting behind their back.
  assert.equal(WEBVIEW_COMMANDS.includes('tokenPace.disconnectStatusLine' as never), false)
})

test('every repair step a card offers is a command its own view can run', () => {
  for (const [kind, action] of Object.entries(PROBLEM_ACTION)) {
    assert.ok(
      WEBVIEW_COMMANDS.includes(action.command as never),
      `${kind}: ${action.command} is offered as a button the webview cannot send`,
    )
  }
})

test('every problem kind names one repair step, and the follower is sent to the dashboard', () => {
  assert.deepEqual(
    Object.fromEntries(Object.entries(PROBLEM_ACTION).map(([k, a]) => [k, a.command])),
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
  const labels = new Set(Object.values(PROBLEM_ACTION).map((a) => a.label))
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

test('the panel filters cannot move a budget', () => {
  // A budget is a standing limit. A provider chip is a question about the table below it,
  // and a limit that shrank because a chip was clicked would be a different question under
  // the same label.
  const cfgWith = makeConfig({ 'tokenPace.budgets': BUDGETS })
  const all = buildViewModel(makeInput({ agg: buildAgg(), cfg: cfgWith }))
  const filtered = buildViewModel(makeInput({
    agg: buildAgg(), cfg: cfgWith, ui: { providers: ['codex'], models: ['gpt-5.3-codex'] },
  }))
  assert.deepEqual(filtered.budgets.map((b) => b.used), all.budgets.map((b) => b.used))
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
