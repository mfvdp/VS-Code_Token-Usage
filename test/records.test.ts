// SPDX-FileCopyrightText: 2026 Frederik Marx
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The records tables and the local five-hour block.
 *
 * Both answer a question about a stretch of time with local numbers only, so both are held
 * to the same two rules the rest of the analytics live by: a day nobody watched is not a
 * quiet day, and a figure without a denominator is a dash, never a percentage.
 */

import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { Aggregator } from '../src/agg'
import { LOCAL_BLOCK_HOURS, StatsCtx, localBlock, records } from '../src/stats'
import { DayRange, rangeFor } from '../src/time'
import { Bucket, SessionRec, Snapshot, emptyBucket } from '../src/types'
import { NOW, TODAY, buildAgg, makeConfig, timeConfig } from './fixtures/viewFixtures'

const cfg = makeConfig()
const tcfg = timeConfig(cfg)
const MS_HOUR = 3_600_000

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

function range(preset: 'today' | '7d' | '30d' | 'all' = '30d'): DayRange {
  return rangeFor(preset, NOW, tcfg, '2026-07-01')
}

function custom(from: string, to: string): DayRange {
  return { from, to, label: 'Selected', preset: 'custom' }
}

/** Buckets straight into an aggregator; the snapshot road is the supported one. */
function fromBuckets(buckets: Bucket[], rollup?: Snapshot['rollup']): Aggregator {
  return Aggregator.fromSnapshot({
    version: 5, buckets, cursors: {}, pending: {}, sessions: {}, attribution: 'none',
    rollup: rollup ?? { lastRun: 0, hourRetentionDays: 0, retentionDays: 0 },
    firstIngest: NOW - 86_400_000,
  }, 'none')
}

/** One day bucket of `input` tokens for a Claude model. */
function day(d: string, input: number, model = 'claude-opus-4-6'): Bucket {
  return { ...emptyBucket('claude', model, false, 'standard', 'd', null, d), input, requests: 1, outputFinal: 1 }
}

/** One hour bucket, `n` hours before NOW. */
function hour(n: number, input: number, model = 'claude-opus-4-6'): Bucket {
  const h = Math.floor((NOW - n * MS_HOUR) / MS_HOUR)
  return { ...emptyBucket('claude', model, false, 'standard', 'h', h, TODAY), input, requests: 1, outputFinal: 1 }
}

/** An aggregator whose session table is handed in verbatim. */
function withSessions(agg: Aggregator, list: SessionRec[]): Aggregator {
  const out = Object.create(agg) as Aggregator
  out.sessions = () => list
  return out
}

// ---------------------------------------------------------------------------
// Records
// ---------------------------------------------------------------------------

test('the records name the busiest day and the longest run of days with usage', () => {
  const r = records(ctxOf(buildAgg()), range('30d'), 5, '2026-07-01')
  assert.equal(r.peakDay?.day, TODAY)
  assert.equal(r.peakDay?.usage, '17.6K')
  assert.match(String(r.peakDay?.cost), /^~\$/)
  // The fixture works on 1, 2 and 3 September; 28 August is a day on its own.
  assert.deepEqual(r.streak, { days: 3, from: '2026-09-01', to: '2026-09-03' })
})

test('an idle day inside coverage breaks the run, and the run names its own days', () => {
  const agg = fromBuckets([
    day('2026-08-25', 1000), day('2026-08-26', 1000),
    // 27 August is idle — and watched, so the run ends here.
    day('2026-08-28', 1000), day('2026-08-29', 1000), day('2026-08-30', 1000),
  ])
  const r = records(ctxOf(agg, { sources: ['claude'] }), range('30d'), 5, '2026-08-01')
  assert.deepEqual(r.streak, { days: 3, from: '2026-08-28', to: '2026-08-30' })
})

test('a day before coverage takes no part in the day records, but its tokens still count', () => {
  const agg = fromBuckets([day('2026-08-20', 100_000), day('2026-09-02', 1000), day('2026-09-03', 2000)])
  const ctx = ctxOf(agg, { sources: ['claude'] })
  const r = records(ctx, range('30d'), 5, '2026-09-01')
  // The biggest day of the range is outside coverage, so it is not the peak day and the
  // eleven idle days behind it are not zeros that could break a run.
  assert.equal(r.peakDay?.day, '2026-09-03')
  assert.deepEqual(r.streak, { days: 2, from: '2026-09-02', to: '2026-09-03' })
  // Coverage shapes the day records only: the model table still counts every bucket.
  assert.equal(r.topModels[0].usage, '103K')
  assert.equal(r.topModels[0].share, '100 %')
})

test('rolled-up months are left out of the records and said to be', () => {
  const month: Bucket = {
    ...emptyBucket('claude', 'claude-opus-4-6', false, 'standard', 'm', null, '2026-08'),
    input: 500_000, requests: 9, outputFinal: 9,
  }
  const r = records(
    ctxOf(fromBuckets([month, day('2026-09-03', 1000)]), { sources: ['claude'] }),
    custom('2026-08-01', TODAY), 5, '2026-07-01',
  )
  assert.equal(r.peakDay?.day, TODAY)
  assert.equal(r.peakDay?.usage, '1K')
  assert.equal(r.note, '1 rolled-up month bucket in this range has no day left and is not in these records')
  // Left out of every figure, so all of them stand on the same buckets.
  assert.equal(r.topModels.length, 1)
  assert.equal(r.topModels[0].usage, '1K')

  const two = records(
    ctxOf(fromBuckets([month, { ...month, day: '2026-07' }]), { sources: ['claude'] }),
    custom('2026-07-01', TODAY), 5, '2026-07-01',
  )
  assert.match(String(two.note), /^2 rolled-up month buckets /)
  assert.equal(two.peakDay, null)
})

test('the top models are shares of the range, and an unpriced model shows no cost', () => {
  const r = records(ctxOf(buildAgg()), range('30d'), 5, '2026-07-01')
  assert.deepEqual(r.topModels.map((m) => m.label),
    ['claude-opus-4-6', 'gpt-5.3-codex', 'claude-sonnet-4-6', 'claude-experimental-x'])
  assert.deepEqual(r.topModels.map((m) => m.share), ['53 %', '29 %', '15 %', '3 %'])
  assert.deepEqual(r.topModels.map((m) => m.detail),
    ['Claude Code', 'Codex', 'Claude Code', 'Claude Code'])
  // The experimental model has no price on file: a partial total is not a cost.
  assert.equal(r.topModels[3].cost, '–')
  // Without costs no row claims one.
  const plain = records(ctxOf(buildAgg(), { showCost: false }), range('30d'), 5, '2026-07-01')
  for (const m of plain.topModels) assert.equal(m.cost, '–')
  assert.equal(plain.peakDay?.cost, '–')
})

test('topN caps every table, and an unusable topN shows all of them', () => {
  const ctx = ctxOf(buildAgg('project'), { attribution: 'project' })
  const two = records(ctx, range('30d'), 2, '2026-07-01')
  assert.equal(two.topModels.length, 2)
  assert.ok(two.topProjects.length <= 2)
  assert.ok(two.topSessions.length <= 2)
  assert.equal(records(ctx, range('30d'), 0, '2026-07-01').topModels.length, 4)
  assert.equal(records(ctx, range('30d'), Number.NaN, '2026-07-01').topModels.length, 4)
})

test('projects and sessions stay empty while attribution is off', () => {
  // The setting decides when it is stated — even with a session table in front of us.
  const stated = records(
    ctxOf(withSessions(buildAgg('project'), sessionsOf()), { attribution: 'none' }),
    range('30d'), 5, '2026-07-01',
  )
  assert.equal(stated.attributionOn, false)
  assert.deepEqual(stated.topProjects, [])
  assert.deepEqual(stated.topSessions, [])
  assert.equal(stated.sessionNote, null)
  // Unstated, the empty session table answers for itself.
  const inferred = records(ctxOf(buildAgg()), range('30d'), 5, '2026-07-01')
  assert.equal(inferred.attributionOn, false)
  assert.deepEqual(inferred.topSessions, [])
  // And with attribution on there are rows, each with the caveat that they are lifetimes.
  const on = records(ctxOf(buildAgg('project'), { attribution: 'project' }), range('30d'), 5, '2026-07-01')
  assert.equal(on.attributionOn, true)
  assert.deepEqual(on.topProjects.map((p) => p.label), ['alpha', 'beta'])
  assert.deepEqual(on.topProjects.map((p) => p.detail), ['1 session', '1 session'])
  assert.deepEqual(on.topSessions.map((s) => [s.label, s.detail]), [['sess-alpha', 'alpha'], ['thread-1', 'beta']])
  assert.match(String(on.sessionNote), /whole lifetime/)
})

/** Two session records, enough to prove the attribution gate is the setting and not the data. */
function sessionsOf(): SessionRec[] {
  return [{
    source: 'claude', sessionId: 's1', project: 'alpha', projectHash: 'h', isSub: false, parent: null,
    firstTs: NOW - 3_600_000, lastTs: NOW, models: ['claude-opus-4-6'], input: 1000, cacheWrite: 0,
    cacheWrite1h: 0, cacheRead: 0, output: 100, reasoning: 0, requests: 1, outputFinal: 1,
    lastCacheTtl: null, lastCacheWriteTs: null, turnGapsMs: [], hourUsage: {},
  }]
}

test('a session that never ran inside the range is not listed', () => {
  const ctx = ctxOf(buildAgg('project'), { attribution: 'project' })
  // July: the Claude session was already running, the Codex thread starts in September.
  const july = records(ctx, custom('2026-07-01', '2026-07-25'), 5, '2026-07-01')
  assert.deepEqual(july.topSessions.map((s) => s.label), ['sess-alpha'])
  // Its counters are lifetime counters, so the row can exceed what July measured — which is
  // exactly what the caveat beside it says.
  assert.equal(july.topSessions[0].usage, '30.4K')
  assert.match(String(july.sessionNote), /can reach outside this range/)
})

test('a range with nothing in it invents neither a record nor a percentage', () => {
  const r = records(ctxOf(new Aggregator()), range('30d'), 5, null)
  assert.equal(r.peakDay, null)
  assert.equal(r.streak, null)
  assert.deepEqual(r.topModels, [])
  assert.deepEqual(r.topProjects, [])
  assert.deepEqual(r.topSessions, [])
  assert.equal(r.note, null)
  assert.equal(r.sessionNote, null)
})

test('without a stated coverage the first ingest is the coverage', () => {
  const agg = fromBuckets([day('2026-09-02', 1000), day('2026-09-03', 2000)])
  agg.firstIngest = Date.UTC(2026, 8, 3, 0, 0)
  const r = records(ctxOf(agg, { sources: ['claude'] }), range('30d'), 5)
  // 2 September lies before the first ingest, so it is outside coverage and out of the run.
  assert.deepEqual(r.streak, { days: 1, from: '2026-09-03', to: '2026-09-03' })
})

// ---------------------------------------------------------------------------
// Local five-hour block
// ---------------------------------------------------------------------------

test('the local block sums the last five hours and names the first hour that counted', () => {
  const row = localBlock(ctxOf(buildAgg()), 'claude', NOW)
  assert.ok(row)
  assert.equal(row?.hours, LOCAL_BLOCK_HOURS)
  // The fixture's Claude work today: 09:00, 10:30 and 11:15 UTC.
  assert.equal(row?.usage, '13.6K')
  assert.equal(row?.requests, '3')
  assert.equal(row?.firstAt, '09:00')
  assert.equal(row?.complete, true)
  assert.equal(
    row?.text,
    'Local estimate — 13.6K tokens in the last 5 h, first counted at 09:00. '
      + 'Not the provider’s window; no limit is known.',
  )
})

test('the local block says nothing when nothing was counted in the span', () => {
  // Six hours ago is outside a five-hour block, and an empty row would state a measured
  // idle span — the buckets cannot tell an idle hour from an unread one.
  assert.equal(localBlock(ctxOf(fromBuckets([hour(6, 5000)]), { sources: ['claude'] }), 'claude', NOW), null)
  assert.equal(localBlock(ctxOf(new Aggregator()), 'claude', NOW), null)
  assert.equal(localBlock(ctxOf(buildAgg()), 'claude', Number.NaN), null)
})

test('the local block carries no percent, no limit and no pace', () => {
  const row = localBlock(ctxOf(buildAgg()), 'claude', NOW)
  assert.ok(row)
  // The shape is deliberately too poor to be mistaken for a quota window.
  assert.deepEqual(
    Object.keys(row as unknown as object).sort(),
    ['complete', 'cost', 'firstAt', 'hours', 'requests', 'source', 'text', 'usage'],
  )
  for (const [key, value] of Object.entries(row as unknown as Record<string, unknown>)) {
    if (typeof value !== 'string' || key === 'text') continue
    assert.doesNotMatch(value, /%/)
    assert.doesNotMatch(value, /\b(limit|pace|left|remaining|forecast|ahead|behind|of)\b/i)
  }
  // The one sentence names a limit exactly once, to say there is none.
  assert.doesNotMatch(String(row?.text), /%/)
  assert.doesNotMatch(String(row?.text), /\b(pace|forecast|remaining|ahead|behind|elapsed)\b/i)
  assert.match(String(row?.text), /no limit is known\.$/)
})

test('a span that reaches past the kept hour buckets marks every figure', () => {
  // A roll-up that keeps no hours at all: the block starts below the horizon, so what it
  // sums is a floor, not a total.
  const agg = fromBuckets([hour(1, 4000)], { lastRun: NOW, hourRetentionDays: 0, retentionDays: 30 })
  const row = localBlock(ctxOf(agg, { sources: ['claude'] }), 'claude', NOW)
  assert.equal(row?.complete, false)
  assert.equal(row?.usage, '≈4K')
  assert.match(String(row?.cost), /^≈~\$/)
  assert.equal(row?.requests, '≈1')
})

test('the local block follows the model filter and the cost switch', () => {
  const agg = fromBuckets([hour(1, 4000, 'claude-opus-4-6'), hour(2, 6000, 'claude-sonnet-4-6')])
  const both = localBlock(ctxOf(agg, { sources: ['claude'] }), 'claude', NOW)
  assert.equal(both?.usage, '10K')
  const one = localBlock(ctxOf(agg, { sources: ['claude'], models: ['claude-opus-4-6'] }), 'claude', NOW)
  assert.equal(one?.usage, '4K')
  // The other model is two hours back, so the first counted hour moves with the filter.
  assert.notEqual(one?.firstAt, both?.firstAt)
  const noCost = localBlock(ctxOf(agg, { sources: ['claude'], showCost: false }), 'claude', NOW)
  assert.equal(noCost?.cost, '–')
})

test('each provider gets its own block, and a source without hours gets none', () => {
  const ctx = ctxOf(buildAgg())
  assert.equal(localBlock(ctx, 'codex', NOW)?.usage, '4K')
  assert.equal(localBlock(ctx, 'codex', NOW)?.firstAt, '10:00')
  const claudeOnly = fromBuckets([hour(1, 4000)])
  assert.equal(localBlock(ctxOf(claudeOnly), 'codex', NOW), null)
})
