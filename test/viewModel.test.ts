// SPDX-FileCopyrightText: 2026 Frederik Marx
// SPDX-License-Identifier: AGPL-3.0-or-later

import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { Aggregator } from '../src/agg'
import { DEFAULT_FORECAST_CONFIG } from '../src/forecast'
import { rangeFor } from '../src/time'
import { QuotaSample } from '../src/types'
import {
  SPARK_GAP, WEBVIEW_COMMANDS, applyMessage, buildViewModel, defaultUiState, forecastsFor,
  parseWebviewMessage, sparkOf,
} from '../src/viewModel'
import {
  FINGERPRINT, NOW, TODAY, buildAgg, fillHistory, makeConfig, makeHistory, makeInput, state,
  timeConfig, win,
} from './fixtures/viewFixtures'

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

  // Every totals block carries the eight rows of §3.18: range, previous, today, 7d, 30d,
  // this week, this month, all time.
  for (const t of vm.totals) assert.equal(t.rows.length, 8)
  assert.equal(vm.kpis.length, 6)
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
  assert.equal(w.verdict.text, '20 points in reserve')
  assert.equal(w.level, 'ok')
  assert.equal(w.display, 'normal')
  assert.equal(w.reset, '2h')
  assert.ok(w.resetAbsolute.length > 0)
  assert.deepEqual(w.aria, { now: 40, max: 100, text: '5 h: 40% used, 20 points in reserve' })
  assert.ok(w.sustainable?.startsWith('~'))
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

test('projects and sessions stay empty until attribution is switched on', () => {
  const off = buildViewModel(makeInput())
  assert.equal(off.projects.enabled, false)
  assert.deepEqual(off.projects.rows, [])
  assert.deepEqual(off.sessions.rows, [])
  assert.deepEqual(off.attributionInWindow, [])

  const on = buildViewModel(makeInput({
    cfg: makeConfig({ 'tokenPace.attribution': 'project' }),
    agg: buildAgg('project'),
  }))
  assert.equal(on.projects.enabled, true)
  assert.ok(on.projects.rows.length >= 1)
  assert.ok(on.sessions.rows.length >= 1)
  assert.ok(on.attributionInWindow.length >= 1)
  assert.equal(
    on.attributionInWindow[0].unexplained,
    'server % cannot be split — shown share is of local tokens only',
  )
})

test('the model filter and the provider filter reach every section', () => {
  const only = buildViewModel(makeInput({ ui: { providers: ['codex'], models: ['gpt-5.3-codex'] } }))
  assert.equal(only.totals.length, 1)
  assert.equal(only.totals[0].source, 'codex')
  assert.deepEqual(only.models.rows.map((r) => r.model), ['gpt-5.3-codex'])
  assert.equal(only.chart.series.length, 1)
  assert.equal(only.cacheEconomy.length, 1)
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

test('sparklines break where the readings stop instead of drawing through the gap', () => {
  const s = (t: number, p: number): QuotaSample => ({ s: 'claude', w: 'w', t, p, r: null, o: 'poll', f: FINGERPRINT })
  const values = sparkOf([
    s(NOW - 6 * 3_600_000, 10),
    s(NOW - 5.9 * 3_600_000, 12),
    s(NOW - 60_000, 40),
  ], NOW)
  assert.deepEqual(values, [10, 12, SPARK_GAP, 40])
  // Older than the 24-hour window: not drawn at all rather than stretched.
  assert.deepEqual(sparkOf([s(NOW - 40 * 3_600_000, 90)], NOW), [])
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
  assert.deepEqual(parseWebviewMessage({ type: 'setHeatmapMetric', metric: 'cost' }),
    { type: 'setHeatmapMetric', metric: 'cost' })
  assert.deepEqual(parseWebviewMessage({ type: 'setHourZone', zone: 'utc' }), { type: 'setHourZone', zone: 'utc' })
  assert.deepEqual(parseWebviewMessage({ type: 'drill', day: '2026-09-01' }), { type: 'drill', day: '2026-09-01' })
  assert.deepEqual(parseWebviewMessage({ type: 'drill', day: null }), { type: 'drill', day: null })
  assert.deepEqual(parseWebviewMessage({ type: 'refresh' }), { type: 'refresh' })
  assert.deepEqual(parseWebviewMessage({ type: 'command', id: 'tokenPace.rescan' }),
    { type: 'command', id: 'tokenPace.rescan' })
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
    { type: 'setHourZone', zone: 'mars' },
    { type: 'drill', day: 'yesterday' },
    { type: 'command', id: 'workbench.action.terminal.new' },
    { type: 'command', id: 'tokenPace.connectStatusLine' },
  ]
  for (const raw of bad) assert.equal(parseWebviewMessage(raw), null, JSON.stringify(raw) ?? 'undefined')
})

test('parseWebviewMessage keeps the command allow-list to nine harmless commands', () => {
  assert.equal(WEBVIEW_COMMANDS.length, 9)
  for (const id of WEBVIEW_COMMANDS) {
    assert.deepEqual(parseWebviewMessage({ type: 'command', id }), { type: 'command', id })
  }
})

test('applyMessage folds a message into the UI state and nothing more', () => {
  const ui = defaultUiState(cfg)
  assert.deepEqual(ui, {
    range: '30d',
    sort: { key: 'usage', dir: 'desc' },
    providers: ['claude', 'codex'],
    models: [],
    metric: 'usage',
    heatmapMetric: 'usage',
    hourZone: 'local',
    drillDay: null,
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
  assert.equal(w.sustainable, null)
})
