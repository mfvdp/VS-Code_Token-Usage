// SPDX-FileCopyrightText: 2026 Frederik Marx
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The anti-fake rules of §0.4, asserted on the rendered view model rather than on the
 * helpers that produce it — the rules are only worth anything at the surface a person reads.
 */

import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { Aggregator } from '../src/agg'
import { toMarkdownSummary } from '../src/exporter'
import { StatsCtx, calendar, heatmap, totalRow } from '../src/stats'
import { markdownDocument, quickPickItems } from '../src/textViews'
import { buildViewModel } from '../src/viewModel'
import {
  NOW, TODAY, buildAgg, makeConfig, makeInput, state, timeConfig, win,
} from './fixtures/viewFixtures'

const cfg = makeConfig()
const tcfg = timeConfig(cfg)

const emptyCtx: StatsCtx = {
  agg: new Aggregator(),
  tcfg,
  pricing: {},
  now: NOW,
  sources: ['claude', 'codex'],
  models: [],
  showCost: true,
}

test('absence is a dash — never 0 %, never $0.00', () => {
  const vm = buildViewModel(makeInput({ agg: new Aggregator(), quotas: [] }))
  const texts = [
    ...vm.kpis.map((k) => k.value),
    ...vm.totals.flatMap((t) => t.rows.flatMap((r) => [
      r.usage, r.freshInput, r.cacheWrite5m, r.cacheWrite1h, r.cacheRead, r.output, r.reasoning,
      r.requests, r.cost, r.cacheHit, r.perRequest, r.costPerRequest, r.outputShare,
    ])),
    ...vm.cacheEconomy.flatMap((c) => [c.hitRate, c.savedUsd, c.blendedPerM]),
    ...[vm.calendar.thisWeek, vm.calendar.thisMonth, vm.calendar.lastMonth, vm.calendar.year]
      .flatMap((p) => [p.usage, p.cost, p.requests, p.avgPerDay]),
  ]
  for (const t of texts) {
    assert.notEqual(t, '0 %', 'a missing rate must not read as zero')
    assert.notEqual(t, '$0.00', 'a missing amount must not read as zero')
    assert.notEqual(t, '~$0.00')
    assert.notEqual(t, '0')
  }
  // Active days is a count of days, not a measurement of usage — "0 of 30" is the truth.
  assert.equal(vm.kpis.find((k) => k.key === 'usage')?.value, '–')
  assert.equal(vm.kpis.find((k) => k.key === 'cacheHit')?.value, '–')
})

test('a division without a denominator yields a dash in every rendering', () => {
  const row = totalRow({ ...emptyCtx, sources: ['claude'] }, 'Today', TODAY, TODAY, 'claude')
  assert.equal(row.cacheHit, '–')
  assert.equal(row.perRequest, '–')
  assert.equal(row.costPerRequest, '–')
  assert.equal(row.outputShare, '–')
})

test('every hypothetical amount carries the estimate marker', () => {
  const vm = buildViewModel(makeInput())
  const money = [
    ...vm.totals.flatMap((t) => t.rows.map((r) => r.cost)),
    ...vm.cacheEconomy.map((c) => c.blendedPerM),
    ...vm.models.rows.map((m) => m.costText),
    vm.kpis.find((k) => k.key === 'cost')?.value ?? '–',
  ]
  for (const m of money) {
    if (m === '–') continue
    assert.match(m, /^~/, `${m} is a hypothetical amount and must be marked`)
  }
  assert.equal(vm.kpis.find((k) => k.key === 'cost')?.provenance, 'estimated')
  assert.equal(vm.kpis.find((k) => k.key === 'usage')?.provenance, 'measured')
  assert.equal(vm.kpis.find((k) => k.key === 'cacheHit')?.provenance, 'derived')
  // The legend that explains the marker travels with the numbers.
  assert.ok(vm.footnotes.some((f) => f.includes('~ = estimate')))
})

test('a cost that cannot be complete is labelled a lower bound wherever it is shown', () => {
  const vm = buildViewModel(makeInput())
  assert.equal(vm.lowerBound, true)
  assert.ok(vm.unpricedModels.length > 0)
  assert.ok(vm.footnotes.some((f) => f.includes('lower bound')))
  assert.ok(toMarkdownSummary(vm).includes('lower bound'))
  assert.ok(vm.totals.some((t) => t.rows.some((r) => r.costPartial)))
})

test('a window without a clock gets no pace, no elapsed and no projected end', () => {
  const vm = buildViewModel(makeInput({
    quotas: [state('claude', {
      windows: [win({ id: 'other:0', kind: 'other', label: 'unknown window', resetsAt: null, windowMinutes: null })],
    })],
  }))
  const w = vm.quotas[0].windows[0]
  assert.equal(w.elapsed, null)
  assert.equal(w.verdict.points, null)
  assert.equal(w.verdict.ratio, null)
  assert.equal(w.verdict.text, 'no clock for this window')
  assert.equal(w.reset, '')
  assert.equal(w.resetAbsolute, '')
  assert.equal(w.sustainable, null)
  // No reset time, so no projected end and no sustainable rate can exist.
  assert.equal(w.forecast?.endPercent, null)
  assert.equal(w.forecast?.sustainablePerHour, null)
  assert.equal(vm.windowUsage.length, 0)
})

test('a non-finite percentage is discarded, not clamped to a number', () => {
  const vm = buildViewModel(makeInput({
    quotas: [state('claude', { windows: [win({ percent: Number.NaN })] })],
  }))
  const w = vm.quotas[0].windows[0]
  assert.equal(w.percentText, '–')
  assert.equal(w.verdict.text, 'no reading')
  assert.equal(w.aria.now, 0)
  assert.equal(w.forecast?.state, 'none')
})

test('a passed reset is reported as due — never simulated as a fresh window', () => {
  const vm = buildViewModel(makeInput({
    quotas: [state('claude', {
      fetchedAt: Math.round((NOW - 3 * 3_600_000) / 1000),
      windows: [win({ percent: 87, resetsAt: NOW - 60_000 })],
    })],
  }))
  const w = vm.quotas[0].windows[0]
  assert.equal(w.display, 'resetDue')
  // The old percentage stays visible: we did not see a reading of zero.
  assert.equal(w.percent, 87)
  assert.equal(w.percentText, '87%')
  assert.ok(w.aria.text.includes('reset due'))
})

test('the month projection stays silent until it has five active days', () => {
  assert.equal(calendar({ ...emptyCtx, agg: buildAgg() }).thisMonth.projection, null)
})

test('heatmap days before the coverage are null, not zero', () => {
  const h = heatmap({ ...emptyCtx, agg: buildAgg() }, 'usage', '2026-08-01')
  const outside = h.weeks.flatMap((w) => w.days).filter((d) => d.level === null)
  assert.ok(outside.length > 0)
  for (const d of outside) assert.equal(d.text, 'outside coverage')
  // Days inside the coverage without usage are level 0 with a stated "no usage".
  const idle = h.weeks.flatMap((w) => w.days).find((d) => d.level === 0)
  assert.match(String(idle?.text), /no usage$/)
})

test('with nothing ingested the heatmap claims no coverage rather than a year of idleness', () => {
  // Quota polling can work while no transcript was ever found: there is no first day, and
  // a year of "no usage" would be a measurement of days nobody watched.
  const h = heatmap(emptyCtx, 'usage', null)
  const days = h.weeks.flatMap((w) => w.days)
  assert.ok(days.length > 360)
  for (const d of days) {
    assert.equal(d.level, null)
    assert.equal(d.text, 'outside coverage')
  }
  assert.equal(h.activeDays, 0)
  assert.equal(h.streak, 0)
})

test('the shown share of a window is a share of local tokens, never of the server figure', () => {
  const vm = buildViewModel(makeInput({
    cfg: makeConfig({ 'tokenPace.attribution': 'project' }),
    agg: buildAgg('project'),
  }))
  for (const a of vm.attributionInWindow) {
    assert.equal(a.unexplained, 'server % cannot be split — shown share is of local tokens only')
    assert.doesNotMatch(a.unexplained, /\d+ ?%/)
  }
})

test('preview data is flagged everywhere it is rendered and never merged into a reading', () => {
  const vm = buildViewModel({ ...makeInput(), preview: true })
  assert.equal(vm.preview, true)
  assert.ok(markdownDocument(vm).includes('Preview data — not a reading.'))
  assert.ok(toMarkdownSummary(vm).includes('Preview data — not a reading.'))
  assert.equal(buildViewModel(makeInput()).preview, false)
})

test('nothing in the rendered views prints a zero where a measurement is missing', () => {
  const vm = buildViewModel(makeInput({ agg: new Aggregator(), quotas: [] }))
  const md = markdownDocument(vm)
  assert.equal(md.includes('$0.00'), false)
  assert.equal(/\|\s0 %\s\|/.test(md), false)
  for (const i of quickPickItems(vm)) {
    assert.equal(i.label.includes('$0.00'), false)
  }
})
