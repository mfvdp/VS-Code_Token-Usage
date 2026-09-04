// SPDX-FileCopyrightText: 2026 Frederik Marx
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Budgets: the user's own limit, measured against the local buckets.
 *
 * The rules under test are the ones that keep a budget honest — an unusable entry is
 * dropped whole rather than repaired, a period without local data has no share at all,
 * dollars and tokens are never mixed, and the projection stays silent until it has
 * something to extrapolate from.
 */

import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { Aggregator } from '../src/agg'
import {
  BudgetSpec, budgetRows, defaultBudgetLabel, periodBounds, sanitizeBudgets, worstBudget,
} from '../src/budget'
import { MIN_PROJECTION_DAYS, StatsCtx } from '../src/stats'
import { addDays } from '../src/time'
import { Bucket, STATE_VERSION, Snapshot, emptyBucket } from '../src/types'
import { NOW, TODAY, makeConfig, timeConfig } from './fixtures/viewFixtures'

const cfg = makeConfig()
const tcfg = timeConfig(cfg)

/** The supported road into an aggregator: a snapshot, exactly as the store writes one. */
function fromBuckets(buckets: Bucket[]): Aggregator {
  const snap: Snapshot = {
    version: STATE_VERSION, buckets, cursors: {}, pending: {}, sessions: {}, attribution: 'none',
    rollup: { lastRun: 0, hourRetentionDays: 0, retentionDays: 0 }, firstIngest: NOW - 90 * 86_400_000,
  }
  return Aggregator.fromSnapshot(snap, 'none')
}

function bucket(over: Partial<Bucket> & { day: string }): Bucket {
  return {
    ...emptyBucket(over.source ?? 'claude', over.model ?? 'claude-sonnet-4-5', false, 'standard', 'd', null, over.day),
    ...over,
  }
}

function ctxOf(agg: Aggregator, over: Partial<StatsCtx> = {}): StatsCtx {
  return {
    agg,
    tcfg,
    pricing: { overrides: {}, multiplier: 1, unknownModel: 'strict' },
    now: NOW,
    sources: ['claude', 'codex'],
    models: [],
    showCost: true,
    ...over,
  }
}

function spec(over: Partial<BudgetSpec> = {}): BudgetSpec {
  return { scope: 'total', period: 'month', unit: 'tokens', limit: 1_000_000, ...over }
}

// ---------------------------------------------------------------------------
// Sanitising
// ---------------------------------------------------------------------------

test('an unusable budget entry is dropped whole, never repaired', () => {
  const out = sanitizeBudgets([
    { scope: 'total', period: 'month', unit: 'usd', limit: 50 },
    { scope: 'nope', period: 'month', unit: 'usd', limit: 50 },
    { scope: 'claude', period: 'fortnight', unit: 'usd', limit: 50 },
    { scope: 'claude', period: 'month', unit: 'euro', limit: 50 },
    { scope: 'claude', period: 'month', unit: 'usd', limit: 0 },
    { scope: 'claude', period: 'month', unit: 'usd', limit: -5 },
    { scope: 'claude', period: 'month', unit: 'usd', limit: Number.NaN },
    { scope: 'claude', period: 'month', unit: 'usd', limit: Number.POSITIVE_INFINITY },
    { scope: 'claude', period: 'month', unit: 'usd', limit: '50' },
    { scope: 'claude', period: 'month', unit: 'usd' },
    'not an object',
    null,
  ])
  assert.deepEqual(out, [{ scope: 'total', period: 'month', unit: 'usd', limit: 50 }])
})

test('budgets keep the user’s order, trim the label and collapse duplicate subjects', () => {
  const out = sanitizeBudgets([
    { scope: 'codex', period: 'day', unit: 'tokens', limit: 5, label: `  ${'x'.repeat(60)}  ` },
    { scope: 'claude', period: 'day', unit: 'tokens', limit: 7, label: '   ' },
    // Same scope × period × unit as the first: it would share an alert identity.
    { scope: 'codex', period: 'day', unit: 'tokens', limit: 9 },
  ])
  assert.equal(out.length, 2)
  assert.equal(out[0].scope, 'codex')
  assert.equal(out[0].limit, 5)
  assert.equal(out[0].label, 'x'.repeat(40))
  assert.equal(out[1].label, undefined, 'a blank label is no label, not an empty string')
})

test('a non-array budget setting is no budget at all', () => {
  assert.deepEqual(sanitizeBudgets(undefined), [])
  assert.deepEqual(sanitizeBudgets({ scope: 'total' }), [])
  assert.deepEqual(sanitizeBudgets('total'), [])
})

// ---------------------------------------------------------------------------
// Period bounds
// ---------------------------------------------------------------------------

test('the period is the user’s own day, week and month', () => {
  const ctx = ctxOf(fromBuckets([]))
  assert.deepEqual(periodBounds('day', TODAY, ctx), { from: TODAY, last: TODAY })
  // 2026-09-03 is a Thursday; the default week starts on Monday.
  assert.deepEqual(periodBounds('week', TODAY, ctx), { from: '2026-08-31', last: '2026-09-06' })
  assert.deepEqual(periodBounds('month', TODAY, ctx), { from: '2026-09-01', last: '2026-09-30' })

  const sunday = ctxOf(fromBuckets([]), { tcfg: { ...tcfg, startOfWeek: 'sunday' } })
  assert.deepEqual(periodBounds('week', TODAY, sunday), { from: '2026-08-30', last: '2026-09-05' })
})

test('February keeps its own length', () => {
  const ctx = ctxOf(fromBuckets([]))
  assert.equal(periodBounds('month', '2024-02-11', ctx).last, '2024-02-29')
  assert.equal(periodBounds('month', '2026-02-11', ctx).last, '2026-02-28')
})

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

test('a token budget counts the local buckets of its period', () => {
  const agg = fromBuckets([
    bucket({ day: TODAY, input: 400_000, output: 100_000 }),
    bucket({ day: '2026-08-31', input: 999_000 }), // last month — outside a month budget
  ])
  const rows = budgetRows(ctxOf(agg), [spec({ period: 'month', limit: 1_000_000 })], NOW)
  assert.equal(rows.length, 1)
  assert.equal(rows[0].used, 500_000)
  assert.equal(rows[0].usedText, '500K')
  assert.equal(rows[0].limitText, '1M')
  assert.equal(rows[0].share, 50)
  assert.equal(rows[0].shareText, '50 %')
  assert.equal(rows[0].over, false)
  assert.equal(rows[0].covered, true)
  assert.equal(rows[0].from, '2026-09-01')
  assert.equal(rows[0].to, TODAY)
  assert.equal(rows[0].last, '2026-09-30')
  assert.equal(rows[0].identity, 'budget:total:month:tokens:2026-09-01')
  assert.equal(rows[0].key, 'total:month:tokens')
})

test('a budget past its limit says so, it is not clamped', () => {
  const agg = fromBuckets([bucket({ day: TODAY, input: 3_000_000 })])
  const rows = budgetRows(ctxOf(agg), [spec({ period: 'day', limit: 1_000_000 })], NOW)
  assert.equal(rows[0].over, true)
  assert.equal(rows[0].shareText, '300 %')
})

test('a period without local buckets has no share — "0 %" would claim a measurement', () => {
  const agg = fromBuckets([bucket({ day: '2026-08-02', input: 500_000 })])
  const rows = budgetRows(ctxOf(agg), [spec({ period: 'month' })], NOW)
  assert.equal(rows[0].covered, false)
  assert.equal(rows[0].share, null)
  assert.equal(rows[0].shareText, '–')
  assert.equal(rows[0].usedText, '–')
  assert.equal(rows[0].projected, null)
})

test('a money budget is the hypothetical API equivalent, marked as an estimate', () => {
  const agg = fromBuckets([bucket({ day: TODAY, model: 'claude-sonnet-4-5', input: 1_000_000, output: 200_000 })])
  const rows = budgetRows(ctxOf(agg), [spec({ period: 'day', unit: 'usd', limit: 100 })], NOW)
  assert.equal(rows.length, 1)
  assert.ok(rows[0].used > 0)
  assert.match(rows[0].usedText, /^~\$/, 'money is never printed as a bill')
  assert.equal(rows[0].partial, false)
})

test('an unpriced model makes a money budget a lower bound', () => {
  const agg = fromBuckets([
    bucket({ day: TODAY, model: 'claude-sonnet-4-5', input: 1_000_000 }),
    bucket({ day: TODAY, model: 'a-model-nobody-has-priced', input: 5_000_000 }),
  ])
  const rows = budgetRows(ctxOf(agg), [spec({ period: 'day', unit: 'usd', limit: 100 })], NOW)
  assert.equal(rows[0].partial, true, 'the used figure is a floor, and the share with it')
  // The token budget over the same buckets is complete: tokens are counted, not priced.
  const tokens = budgetRows(ctxOf(agg), [spec({ period: 'day', unit: 'tokens', limit: 100 })], NOW)
  assert.equal(tokens[0].partial, false)
})

test('a money budget keeps its row, all dashes, while cost display is off', () => {
  // The row may not vanish: a budget nobody is counting is still a budget the reader
  // configured, and dropping it lets the panel answer "no budget configured" to a settings
  // file that configures one. Every figure is a dash and the reason names the setting.
  const agg = fromBuckets([bucket({ day: TODAY, input: 500_000 })])
  const rows = budgetRows(
    ctxOf(agg, { showCost: false }),
    [spec({ period: 'day', unit: 'usd', limit: 10 }), spec({ period: 'day', unit: 'tokens', limit: 10 })],
    NOW,
  )
  assert.deepEqual(rows.map((r) => r.unit), ['usd', 'tokens'])
  const money = rows[0]
  assert.equal(money.unmeasurable, 'not measured while tokenPace.showCost is off')
  assert.equal(money.usedText, '–')
  assert.equal(money.shareText, '–')
  assert.equal(money.share, null)
  assert.equal(money.used, 0)
  assert.equal(money.covered, false, 'nothing counted it, so no alert and no status-bar entry')
  assert.equal(money.over, false)
  assert.equal(money.projectedText, null)
  assert.match(money.text, /tokenPace\.showCost/)
  // The token budget beside it is untouched.
  assert.equal(rows[1].unmeasurable, null)
  assert.equal(rows[1].covered, true)
})

test('a scope only ever counts its own provider', () => {
  const agg = fromBuckets([
    bucket({ day: TODAY, source: 'claude', input: 300_000 }),
    bucket({ day: TODAY, source: 'codex', model: 'gpt-5-codex', input: 700_000, cacheRead: 200_000 }),
  ])
  const ctx = ctxOf(agg)
  const rows = budgetRows(ctx, [
    spec({ scope: 'claude', period: 'day', limit: 1_000_000 }),
    spec({ scope: 'codex', period: 'day', limit: 1_000_000 }),
    spec({ scope: 'total', period: 'day', limit: 1_000_000 }),
  ], NOW)
  assert.equal(rows[0].used, 300_000)
  // Codex reports cached tokens inside `input`: 700k − 200k is the fresh half.
  assert.equal(rows[1].used, 500_000)
  assert.equal(rows[2].used, 800_000, 'total is the sum of the enabled providers, per their own rules')
})

test('a budget for a switched-off provider is a dash, never a zero', () => {
  const agg = fromBuckets([bucket({ day: TODAY, source: 'claude', input: 300_000 })])
  const ctx = ctxOf(agg, { sources: ['claude'] })
  const rows = budgetRows(ctx, [
    spec({ scope: 'codex', period: 'day', limit: 1_000_000 }),
    spec({ scope: 'total', period: 'day', limit: 1_000_000 }),
  ], NOW)
  assert.deepEqual(rows.map((r) => r.scope), ['codex', 'total'])
  assert.equal(rows[0].unmeasurable, 'not measured while Codex is not selected')
  assert.equal(rows[0].usedText, '–')
  assert.equal(rows[0].share, null)
  assert.equal(rows[1].unmeasurable, null)
  assert.equal(rows[1].used, 300_000, 'total means the providers that are switched on')
})

test('with no provider selected every budget is a row nothing counts', () => {
  const agg = fromBuckets([bucket({ day: TODAY, input: 300_000 })])
  const rows = budgetRows(ctxOf(agg, { sources: [] }), [spec({ period: 'day' })], NOW)
  assert.equal(rows.length, 1)
  assert.equal(rows[0].used, 0)
  assert.equal(rows[0].usedText, '–')
  assert.ok(rows[0].unmeasurable, 'the row states why it has no figure')
})

test('the model filter reaches a budget like every other figure', () => {
  const agg = fromBuckets([
    bucket({ day: TODAY, model: 'claude-opus-4-6', input: 400_000 }),
    bucket({ day: TODAY, model: 'claude-sonnet-4-5', input: 600_000 }),
  ])
  const rows = budgetRows(ctxOf(agg, { models: ['claude-opus-4-6'] }), [spec({ period: 'day', limit: 1_000_000 })], NOW)
  assert.equal(rows[0].used, 400_000)
})

// ---------------------------------------------------------------------------
// Units never mix
// ---------------------------------------------------------------------------

test('a dollar budget and a token budget are never added together', () => {
  const agg = fromBuckets([bucket({ day: TODAY, model: 'claude-sonnet-4-5', input: 1_000_000 })])
  const rows = budgetRows(ctxOf(agg), [
    spec({ period: 'day', unit: 'usd', limit: 10 }),
    spec({ period: 'day', unit: 'tokens', limit: 2_000_000 }),
  ], NOW)
  assert.equal(rows.length, 2)
  assert.equal(rows[0].unit, 'usd')
  assert.equal(rows[1].unit, 'tokens')
  assert.notEqual(rows[0].used, rows[1].used)
  // The only figure the two share is the share of their own limit.
  const worst = worstBudget(rows)
  assert.ok(worst !== null)
  assert.equal(worst.share, Math.max(rows[0].share ?? 0, rows[1].share ?? 0))
})

test('a budget without a share can never be the worst one', () => {
  const agg = fromBuckets([bucket({ day: '2026-01-02', input: 500_000 })])
  const rows = budgetRows(ctxOf(agg), [spec({ period: 'month' })], NOW)
  assert.equal(rows[0].share, null)
  assert.equal(worstBudget(rows), null)
  assert.equal(worstBudget([]), null)
})

// ---------------------------------------------------------------------------
// Projection
// ---------------------------------------------------------------------------

/** One day-bucket per day, starting at `from` — the days a projection averages over. */
function days(from: string, count: number, perDay: number): Bucket[] {
  const out: Bucket[] = []
  for (let i = 0; i < count; i++) out.push(bucket({ day: addDays(from, i), input: perDay }))
  return out
}

/** Well inside September, so a month budget has both elapsed and remaining days. */
const LATE = Date.UTC(2026, 8, 20, 12, 0, 0)

test('a projection needs enough active days, and says how it was derived', () => {
  const few = fromBuckets(days('2026-09-01', MIN_PROJECTION_DAYS - 1, 100_000))
  const thin = budgetRows(ctxOf(few, { now: LATE }), [spec({ period: 'month', limit: 10_000_000 })], LATE)
  assert.equal(thin[0].projected, null, 'below five active days a projection extrapolates noise')
  assert.equal(thin[0].projectionBasis, null)

  const many = fromBuckets(days('2026-09-01', MIN_PROJECTION_DAYS + 2, 100_000))
  const rows = budgetRows(ctxOf(many, { now: LATE }), [spec({ period: 'month', limit: 10_000_000 })], LATE)
  // 700k over 20 elapsed days is 35k/day, and 10 days of September are still to run.
  assert.equal(rows[0].used, 700_000)
  assert.equal(rows[0].projected, 700_000 + (700_000 / 20) * 10)
  assert.match(rows[0].projectedText ?? '', /^~/, 'a projection is an extrapolation and says so')
  assert.match(rows[0].projectionBasis ?? '', /^so far .* · Avg .*\/day · 10 days left$/)
  assert.match(rows[0].text, /projected ~1\.1M by 2026-09-30/)
})

test('a one-day budget never projects — today has no elapsed days to average over', () => {
  const agg = fromBuckets(days('2026-09-01', MIN_PROJECTION_DAYS + 2, 100_000))
  const rows = budgetRows(ctxOf(agg, { now: LATE }), [spec({ period: 'day', limit: 1_000_000 })], LATE)
  assert.equal(rows[0].projected, null)
})

test('the last day of a period projects nothing: there is nothing left to project', () => {
  const agg = fromBuckets(days('2026-09-01', MIN_PROJECTION_DAYS + 2, 100_000))
  const endOfMonth = Date.UTC(2026, 8, 30, 12, 0, 0)
  const rows = budgetRows(ctxOf(agg, { now: endOfMonth }), [spec({ period: 'month', limit: 10_000_000 })], endOfMonth)
  assert.equal(rows[0].to, '2026-09-30')
  assert.equal(rows[0].projected, null)
})

test('a projection past the limit is flagged without changing the measured share', () => {
  const agg = fromBuckets(days('2026-09-01', MIN_PROJECTION_DAYS + 2, 1_000_000))
  const rows = budgetRows(ctxOf(agg, { now: LATE }), [spec({ period: 'month', limit: 8_000_000 })], LATE)
  assert.equal(rows[0].used, 7_000_000)
  assert.equal(rows[0].over, false, 'the limit is not reached yet')
  assert.equal(rows[0].projectedOver, true, 'but it will be, on this pace')
  assert.equal(rows[0].shareText, '88 %', 'the share stays the measured one')
})

// ---------------------------------------------------------------------------
// Wording
// ---------------------------------------------------------------------------

test('the shared one-liner carries the label, both figures and the share', () => {
  const agg = fromBuckets([bucket({ day: TODAY, input: 500_000 })])
  const rows = budgetRows(ctxOf(agg), [spec({ period: 'day', limit: 1_000_000, label: 'Daily cap' })], NOW)
  assert.equal(rows[0].label, 'Daily cap')
  assert.equal(rows[0].text, 'Daily cap: 500K of 1M · 50 %')
})

test('a budget without a label names its own subject', () => {
  assert.equal(defaultBudgetLabel(spec({ scope: 'total', period: 'month' })), 'All providers · this month')
  assert.equal(defaultBudgetLabel(spec({ scope: 'claude', period: 'day' })), 'Claude Code · today')
  assert.equal(defaultBudgetLabel(spec({ scope: 'codex', period: 'week' })), 'Codex · this week')
})
