// SPDX-FileCopyrightText: 2026 Frederik Marx
// SPDX-License-Identifier: AGPL-3.0-or-later

import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { Aggregator } from '../src/agg'
import {
  MIN_GRID_SAMPLES, MIN_P90_SAMPLES, StatsCtx, attributionInWindow, cacheEconomy, cacheHitParts,
  cacheStateOf, calendar, chart, drill, heatmap, hours, kpis, modelTable, niceCeil, planFactors,
  projectRows, sessionRows, totalRow, windowUsage,
} from '../src/stats'
import { DayRange, rangeFor } from '../src/time'
import { Bucket, SessionRec, Snapshot, Source, emptyBucket } from '../src/types'
import { NOW, TODAY, buildAgg, makeConfig, timeConfig } from './fixtures/viewFixtures'
import { claudeLine } from './fixtures/helpers'

const cfg = makeConfig()
const tcfg = timeConfig(cfg)

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

/** A hand-built aggregator: one bucket, exactly the numbers the formula is checked against. */
function single(over: Partial<Bucket>): Aggregator {
  const agg = new Aggregator()
  const b: Bucket = { ...emptyBucket('claude', 'claude-opus-4-6', false, 'standard', 'd', null, TODAY), ...over }
  // The aggregator has no public "add a bucket"; the snapshot road is the supported one.
  return Aggregator.fromSnapshot({
    version: 5,
    buckets: [b],
    cursors: {},
    pending: {},
    sessions: {},
    attribution: 'none',
    rollup: { lastRun: 0, hourRetentionDays: 0, retentionDays: 0 },
    firstIngest: NOW - 86_400_000,
  }, 'none') ?? agg
}

/** The same road as `single`, for a world that needs more than one bucket. */
function fromBuckets(buckets: Bucket[]): Aggregator {
  const snap: Snapshot = {
    version: 5, buckets, cursors: {}, pending: {}, sessions: {}, attribution: 'none',
    rollup: { lastRun: 0, hourRetentionDays: 0, retentionDays: 0 }, firstIngest: NOW - 86_400_000,
  }
  return Aggregator.fromSnapshot(snap, 'none')
}

/** One session record with only the fields a test cares about filled in. */
function session(over: Partial<SessionRec>): SessionRec {
  return {
    source: 'claude', sessionId: 's', project: 'p', projectHash: 'h', isSub: false, parent: null,
    firstTs: NOW, lastTs: NOW, models: [], input: 0, cacheWrite: 0, cacheWrite1h: 0, cacheRead: 0,
    output: 0, reasoning: 0, requests: 0, outputFinal: 0, lastCacheTtl: null,
    lastCacheWriteTs: null, turnGapsMs: [], hourUsage: {}, ...over,
  }
}

/** An aggregator whose session table is handed in verbatim. */
function withSessions(agg: Aggregator, list: SessionRec[]): Aggregator {
  const out = Object.create(agg) as Aggregator
  out.sessions = () => list
  return out
}

test('the cache hit rate uses each provider’s own denominator', () => {
  const claude = { ...emptyBucket('claude', 'm', false, 'standard', 'd', null, TODAY), input: 100, cacheRead: 900 }
  // Claude reports cache reads next to fresh input: 900 of 1000.
  assert.deepEqual(cacheHitParts(claude), { num: 900, den: 1000 })
  const codex = { ...emptyBucket('codex', 'm', false, 'standard', 'd', null, TODAY), input: 1000, cacheRead: 900 }
  // Codex reports them inside input: 900 of 1000, not of 1900.
  assert.deepEqual(cacheHitParts(codex), { num: 900, den: 1000 })
})

test('a cache that is written and never read shows a negative saving', () => {
  const agg = single({ input: 1000, cacheWrite: 20000, cacheWrite1h: 0, cacheRead: 0, output: 100, requests: 1 })
  const rows = cacheEconomy(ctxOf(agg, { sources: ['claude'] }), range('today'))
  assert.equal(rows.length, 1)
  assert.match(rows[0].savedUsd, /^~-\$/)
  assert.equal(rows[0].hitRate, '0 %')
  assert.match(rows[0].note, /counterfactual/)
})

test('cache reads that beat their write cost show a positive saving, Codex without a write term', () => {
  const claude = single({ input: 1000, cacheWrite: 1000, cacheRead: 500_000, output: 100, requests: 1 })
  const saved = cacheEconomy(ctxOf(claude, { sources: ['claude'] }), range('today'))[0]
  assert.match(saved.savedUsd, /^~\$/)
  const codexAgg = Aggregator.fromSnapshot({
    version: 5,
    buckets: [{ ...emptyBucket('codex', 'gpt-5.3-codex', false, 'standard', 'd', null, TODAY), input: 10_000, cacheRead: 8_000, cacheWrite: 4_000, output: 500, requests: 1 }],
    cursors: {}, pending: {}, sessions: {}, attribution: 'none',
    rollup: { lastRun: 0, hourRetentionDays: 0, retentionDays: 0 }, firstIngest: NOW,
  }, 'none')
  const codex = cacheEconomy(ctxOf(codexAgg, { sources: ['codex'] }), range('today'))[0]
  // No write term: the saving is exactly the read discount, so it cannot go negative here.
  assert.match(codex.savedUsd, /^~\$/)
  assert.match(codex.note, /no cache write/)
})

test('the blended rate divides the cost by every priced token', () => {
  const agg = single({ input: 1_000_000, cacheRead: 0, cacheWrite: 0, output: 0, requests: 1 })
  const row = cacheEconomy(ctxOf(agg, { sources: ['claude'] }), range('today'))[0]
  // One million input tokens of a $5/1M model: $5 over 1M tokens is $5 per 1M.
  assert.equal(row.blendedPerM, '~$5.00')
})

test('a fast-mode bucket without a published fast rate is left out of the blend and flagged', () => {
  // One million standard input tokens at $5/1M, plus a million fast-mode tokens whose model
  // publishes no fast rate. Pricing those at the standard rate would halve the blended rate.
  const agg = fromBuckets([
    { ...emptyBucket('claude', 'claude-opus-4-6', false, 'standard', 'd', null, TODAY), input: 1_000_000, requests: 1, outputFinal: 1 },
    { ...emptyBucket('claude', 'claude-sonnet-4-6', false, 'fast', 'd', null, TODAY), input: 1_000_000, requests: 1, outputFinal: 1 },
  ])
  const row = cacheEconomy(ctxOf(agg, { sources: ['claude'] }), range('today'))[0]
  assert.equal(row.blendedPerM, '~$5.00')
  assert.equal(row.partial, true)
})

test('the saving stays on the same rate basis as the blended rate', () => {
  const buckets: Bucket[] = [{
    ...emptyBucket('claude', 'claude-opus-4-6', false, 'standard', 'd', null, TODAY),
    input: 1000, cacheRead: 1_000_000, requests: 1, outputFinal: 1,
  }]
  const list = cacheEconomy(ctxOf(fromBuckets(buckets), { sources: ['claude'] }), range('today'))[0]
  // A contract discount moves both columns, not just one of them.
  const half = cacheEconomy(
    ctxOf(fromBuckets(buckets), { sources: ['claude'], pricing: { multiplier: 0.5 } }),
    range('today'),
  )[0]
  const value = (t: string): number => Number(t.replace(/[^0-9.]/g, ''))
  assert.ok(value(list.savedUsd) > 0)
  assert.ok(Math.abs(value(half.savedUsd) - value(list.savedUsd) / 2) < 0.01)
  assert.ok(Math.abs(value(half.blendedPerM) - value(list.blendedPerM) / 2) < 0.01)
})

test('an absent denominator is a dash, never a zero percent', () => {
  const agg = new Aggregator()
  const row = totalRow(ctxOf(agg), 'Today', TODAY, TODAY, 'claude')
  assert.equal(row.cacheHit, '–')
  assert.equal(row.usage, '–')
  assert.equal(row.perRequest, '–')
  assert.equal(row.cost, '–')
})

test('heatmap levels come from the quantiles of the active days', () => {
  const h = heatmap(ctxOf(buildAgg()), 'usage', '2026-07-01')
  assert.equal(h.weeks.length, 53)
  for (const w of h.weeks) assert.equal(w.days.length, 7)
  const levels = h.weeks.flatMap((w) => w.days).filter((d) => d.level !== null && d.level > 0)
  assert.ok(levels.length >= 4)
  // The busiest day must land in the top level, the quietest active day must not.
  const sorted = [...levels].sort((a, b) => b.value - a.value)
  assert.equal(sorted[0].level, 4)
  assert.ok((sorted[sorted.length - 1].level ?? 0) < 4)
})

test('days before the first ingest are outside coverage, not zero', () => {
  const h = heatmap(ctxOf(buildAgg()), 'usage', '2026-08-01')
  const before = h.weeks.flatMap((w) => w.days).filter((d) => d.day < '2026-08-01')
  assert.ok(before.length > 0)
  for (const d of before) {
    assert.equal(d.level, null)
    assert.equal(d.text, 'outside coverage')
  }
})

test('streaks count the run that is still alive', () => {
  const h = heatmap(ctxOf(buildAgg()), 'usage', '2026-07-01')
  // The fixture works on 1, 2 and 3 September — three days in a row up to today.
  assert.equal(h.streak, 3)
  assert.ok(h.longestStreak >= 3)
  assert.equal(h.activeDays, 5)
  assert.equal(h.peakDay?.day, TODAY)
})

test('variability stays silent below a week of active days', () => {
  assert.equal(heatmap(ctxOf(buildAgg()), 'usage', '2026-07-01').variability, null)
})

test('the hour profile switches zone without moving the tokens', () => {
  const ctx = ctxOf(buildAgg())
  const local = hours(ctx, range('30d'), 'local')
  const utc = hours(ctx, range('30d'), 'utc')
  const sum = (h: ReturnType<typeof hours>): number => h.profile.reduce((a, b) => a + b.value, 0)
  assert.equal(sum(local), sum(utc))
  // The fixture zone is UTC, so both views agree; the shape is the same array of 24.
  assert.equal(local.profile.length, 24)
  assert.equal(utc.profile.length, 24)
  assert.equal(utc.zone, 'utc')

  const nyCtx = ctxOf(buildAgg(), { tcfg: { ...tcfg, zone: 'America/New_York' } })
  const ny = hours(nyCtx, rangeFor('all', NOW, { ...tcfg, zone: 'America/New_York' }, '2026-07-01'), 'local')
  const nyUtc = hours(nyCtx, rangeFor('all', NOW, { ...tcfg, zone: 'America/New_York' }, '2026-07-01'), 'utc')
  assert.notDeepEqual(ny.profile.map((p) => p.value), nyUtc.profile.map((p) => p.value))
})

test('the hour profile names how many days it stands on', () => {
  const h = hours(ctxOf(buildAgg()), range('30d'), 'local')
  assert.equal(h.days, 4)
  assert.equal(h.peakHour, 9)
  assert.equal(h.note, null)
  assert.equal(h.weekdayLabels[0], 'Mon')
})

test('a weekday × 4-hour cell stays empty below the sample threshold', () => {
  const grid = hours(ctxOf(buildAgg()), range('30d'), 'local').grid
  assert.equal(grid.length, 42)
  const filled = grid.filter((c) => c.value !== null)
  // The fixture has at most one day per cell, well below the threshold.
  assert.equal(filled.length, 0)
  for (const c of grid) assert.ok(c.samples < MIN_GRID_SAMPLES)
})

test('rolled-up buckets are named as missing from the hour profile', () => {
  const agg = single({ input: 1000, output: 100, requests: 1 })
  const h = hours(ctxOf(agg), range('today'), 'local')
  assert.match(String(h.note), /rolled-up/)
})

test('turn P90 needs enough samples, the average does not', () => {
  const sessions = (n: number): SessionRec[] => ([{
    source: 'claude' as Source,
    sessionId: 's1',
    project: 'alpha',
    projectHash: 'h',
    isSub: false,
    parent: null,
    firstTs: NOW - 3_600_000,
    lastTs: NOW,
    models: ['claude-opus-4-6'],
    input: 0, cacheWrite: 0, cacheWrite1h: 0, cacheRead: 0, output: 0, reasoning: 0,
    requests: 0, outputFinal: 0,
    lastCacheTtl: null, lastCacheWriteTs: null,
    turnGapsMs: Array.from({ length: n }, (_, i) => 1000 + i * 10),
  }])
  const agg = buildAgg()
  const withFew = Object.create(agg) as Aggregator
  withFew.sessions = () => sessions(MIN_P90_SAMPLES - 1)
  const few = modelTable(ctxOf(withFew), range('30d'), { key: 'usage', dir: 'desc' }, 20).rows
    .find((r) => r.model === 'claude-opus-4-6')
  assert.ok(few?.turnAvg)
  assert.equal(few?.turnP90, null)

  const withMany = Object.create(agg) as Aggregator
  withMany.sessions = () => sessions(MIN_P90_SAMPLES)
  const many = modelTable(ctxOf(withMany), range('30d'), { key: 'usage', dir: 'desc' }, 20).rows
    .find((r) => r.model === 'claude-opus-4-6')
  assert.ok(many?.turnP90)
})

test('the model table sorts, caps and reports what it hid', () => {
  const ctx = ctxOf(buildAgg())
  const all = modelTable(ctx, range('30d'), { key: 'usage', dir: 'desc' }, 0)
  assert.equal(all.hidden, 0)
  assert.ok(all.rows.length >= 4)
  const desc = all.rows.map((r) => r.usage)
  assert.deepEqual(desc, [...desc].sort((a, b) => b - a))

  const asc = modelTable(ctx, range('30d'), { key: 'usage', dir: 'asc' }, 0).rows.map((r) => r.usage)
  assert.deepEqual(asc, [...desc].sort((a, b) => a - b))

  const capped = modelTable(ctx, range('30d'), { key: 'usage', dir: 'desc' }, 2)
  assert.equal(capped.rows.length, 2)
  assert.equal(capped.hidden, all.rows.length - 2)
})

test('a model without a price is marked, not costed', () => {
  const row = modelTable(ctxOf(buildAgg()), range('30d'), { key: 'usage', dir: 'desc' }, 0).rows
    .find((r) => r.model === 'claude-experimental-x')
  assert.equal(row?.priced, 'none')
  assert.equal(row?.price, 'no price on file')
  assert.equal(row?.costText, '–')
})

test('a fast-mode row is not labelled with rates that were never applied to it', () => {
  const agg = fromBuckets([{
    ...emptyBucket('claude', 'claude-sonnet-4-6', false, 'fast', 'd', null, TODAY),
    input: 1_000_000, output: 500_000, requests: 1, outputFinal: 1,
  }])
  const row = modelTable(ctxOf(agg), range('today'), { key: 'usage', dir: 'desc' }, 0).rows[0]
  assert.equal(row.tier, 'fast')
  assert.equal(row.costText, '–')
  assert.equal(row.priced, 'none')
  assert.equal(row.price, 'fast rate unknown — no rate on file for this tier')
  assert.doesNotMatch(row.price, /per 1M/)
})

test('the price column names the date the list price was checked', () => {
  const row = modelTable(ctxOf(buildAgg()), range('30d'), { key: 'usage', dir: 'desc' }, 0).rows
    .find((r) => r.model === 'claude-opus-4-6')
  assert.match(String(row?.price), /per 1M, list as of \d{4}-\d{2}-\d{2}/)
})

test('the month projection stays silent below five active days and speaks above it', () => {
  const quiet = calendar(ctxOf(buildAgg())).thisMonth
  assert.equal(quiet.projection, null)
  assert.equal(quiet.projectionBasis, null)

  // Five active days in a month that still has days left to project over.
  const buckets: Bucket[] = []
  for (let d = 1; d <= 5; d++) {
    buckets.push({
      ...emptyBucket('claude', 'claude-opus-4-6', false, 'standard', 'd', null, `2026-09-0${d}`),
      input: 200_000, output: 10_000, requests: 4, outputFinal: 4,
    })
  }
  const agg = Aggregator.fromSnapshot({
    version: 5, buckets, cursors: {}, pending: {}, sessions: {}, attribution: 'none',
    rollup: { lastRun: 0, hourRetentionDays: 0, retentionDays: 0 }, firstIngest: Date.UTC(2026, 8, 1),
  }, 'none')
  // Twenty days into the month: five active days, and days left to project over.
  const loud = calendar(ctxOf(agg, { now: Date.UTC(2026, 8, 20, 12, 0, 0) })).thisMonth
  assert.ok(loud.projection?.startsWith('~$'))
  assert.match(String(loud.projectionBasis), /^so far \$.* · Ø \$.*\/day · \d+ days left$/)
})

test('the plan factor appears only when a plan price was stated', () => {
  const ctx = ctxOf(buildAgg())
  assert.deepEqual(planFactors(ctx, {}), [])
  const rows = planFactors(ctx, { claude: 100 })
  assert.equal(rows.length, 1)
  assert.equal(rows[0].source, 'claude')
  assert.match(rows[0].text, /API equivalent this month ÷ \$100 plan = ×/)
  assert.equal(rows[0].partial, true)
})

test('the chart condenses to weekly bars beyond four months', () => {
  const ctx = ctxOf(buildAgg())
  const short = chart(ctx, range('30d'), 'usage')
  assert.equal(short.weekly, false)
  assert.equal(short.days.length, 30)
  assert.equal(short.ticks.length, 4)
  assert.ok(short.max >= Math.max(...short.series.flatMap((s) => s.values)))

  const long = chart(ctx, { from: '2026-01-01', to: TODAY, label: 'long', preset: 'custom' }, 'usage')
  assert.equal(long.weekly, true)
  assert.ok(long.days.length < 60)
  const sum = (values: number[][]): number => values.flat().reduce((a, b) => a + b, 0)
  assert.equal(
    sum(long.series.map((s) => s.values)),
    sum(chart(ctx, { from: '2026-01-01', to: TODAY, label: 'l', preset: 'custom' }, 'usage').series.map((s) => s.values)),
  )
})

test('niceCeil rounds the axis to something a person reads', () => {
  assert.equal(niceCeil(0), 1)
  assert.equal(niceCeil(7), 10)
  assert.equal(niceCeil(12_345), 20_000)
  assert.equal(niceCeil(4_800), 5_000)
})

test('a window without a clock gets no local usage row', () => {
  const ctx = ctxOf(buildAgg())
  assert.equal(windowUsage(ctx, 'claude', { id: 'x', label: 'x', resetsAt: null, windowMinutes: 300 }), null)
  assert.equal(windowUsage(ctx, 'claude', { id: 'x', label: 'x', resetsAt: NOW, windowMinutes: null }), null)
  const row = windowUsage(ctx, 'claude', { id: 'session:300', label: '5 h', resetsAt: NOW + 3_600_000, windowMinutes: 300 })
  assert.ok(row)
  assert.equal(row?.complete, true)
})

test('the KPI row reports "new" when there is no previous period to compare with', () => {
  const list = kpis(ctxOf(buildAgg()), range('30d'), null)
  for (const k of list) assert.equal(k.delta?.text, 'new')
  assert.deepEqual(list.map((k) => k.key),
    ['usage', 'cost', 'requests', 'cacheHit', 'activeDays', 'avgPerActiveDay'])
})

test('the cache TTL countdown is an estimate and expires', () => {
  const base: SessionRec = {
    source: 'claude', sessionId: 's', project: 'p', projectHash: 'h', isSub: false, parent: null,
    firstTs: NOW - 3_600_000, lastTs: NOW, models: [], input: 0, cacheWrite: 0, cacheWrite1h: 0,
    cacheRead: 0, output: 0, reasoning: 0, requests: 0, outputFinal: 0,
    lastCacheTtl: '5m', lastCacheWriteTs: NOW - 60_000, turnGapsMs: [],
  }
  assert.equal(cacheStateOf(base, NOW), '~cache likely cold in 4 min')
  assert.equal(cacheStateOf({ ...base, lastCacheWriteTs: NOW - 10 * 60_000 }, NOW), '~cache likely cold')
  assert.equal(cacheStateOf({ ...base, lastCacheTtl: null, lastCacheWriteTs: null }, NOW), null)
})

test('a session start is printed in the calendar the session is filed under', () => {
  // Berlin is UTC+2 in September: 23:30 UTC is half past one on the next local day.
  const berlin = { ...tcfg, zone: 'Europe/Berlin', hourCycle: 'h23' as const }
  const firstTs = Date.UTC(2026, 8, 2, 23, 30)
  const agg = withSessions(buildAgg(), [session({
    sessionId: 'night', project: 'alpha', firstTs, lastTs: firstTs + 60_000,
  })])
  const ctx = ctxOf(agg, { tcfg: berlin })
  const row = sessionRows(ctx).find((r) => r.session === 'night')
  assert.equal(row?.started, '2026-09-03 01:30')
  // The same calendar the drill-down files the row under — one day, not two.
  const onDay = drill(ctx, '2026-09-03', { key: 'usage', dir: 'desc' }, 0).sessions
  assert.ok(onDay.some((r) => r.session === 'night'))
})

test('the weekday grid reads the same clock as the hour axis', () => {
  // Three Mondays at 23:00 UTC — 01:00 on Tuesday in Berlin, so the two calendars disagree.
  const buckets = [0, 7, 14].map((d) => ({
    ...emptyBucket('claude', 'claude-opus-4-6', false, 'standard', 'h',
      Math.floor(Date.UTC(2026, 7, 3 + d, 23, 0) / 3_600_000), `2026-08-${String(3 + d).padStart(2, '0')}`),
    input: 10_000, requests: 1, outputFinal: 1,
  }))
  const berlin = { ...tcfg, zone: 'Europe/Berlin' }
  const ctx = ctxOf(fromBuckets(buckets), { tcfg: berlin })
  const r: DayRange = { from: '2026-08-01', to: TODAY, label: 'august', preset: 'custom' }
  const filled = (zone: 'local' | 'utc'): { weekday: number; block: number }[] =>
    hours(ctx, r, zone).grid.filter((c) => c.value !== null).map((c) => ({ weekday: c.weekday, block: c.block }))
  // Local: Tuesday (index 1 with Monday first), first four-hour block.
  assert.deepEqual(filled('local'), [{ weekday: 1, block: 0 }])
  // UTC: the hour is 23, so the weekday has to be the UTC one — Monday, last block.
  assert.deepEqual(filled('utc'), [{ weekday: 0, block: 5 }])
})

test('a project share without a denominator is a dash, not a zero', () => {
  // A session that was opened but produced no counted turn: no billable tokens anywhere.
  const agg = withSessions(new Aggregator(), [session({ project: 'myproject', requests: 3 })])
  const rows = projectRows(ctxOf(agg))
  assert.equal(rows.length, 1)
  assert.equal(rows[0].usage, '–')
  assert.equal(rows[0].share, '–')
  assert.equal(rows[0].sessions, 1)
})

test('window attribution counts the window’s own hours, not whole session lifetimes', () => {
  const agg = new Aggregator()
  agg.attribution = 'project'
  let n = 0
  const add = (project: string, ts: number, input: number): void => {
    n++
    const file = `/virtual/claude/projects/-home-t-${project}/s.jsonl`
    agg.addClaudeLine(
      claudeLine({ id: `m-${n}`, ts, model: 'claude-opus-4-6', final: true, cwd: `/home/t/${project}`, usage: { input } }),
      { isSub: false, file, attribution: 'project', projectSalt: 'salt', hashProjects: false },
    )
  }
  // "old" has been running for days: ten million tokens outside the window, 100K inside it.
  add('old', NOW - 72 * 3_600_000, 10_000_000)
  add('old', NOW - 3_600_000, 100_000)
  add('new', NOW - 1_800_000, 1_900_000)

  const ctx = ctxOf(agg, { sources: ['claude'] })
  const w = { id: 'session:300', label: '5 h', resetsAt: NOW + 2 * 3_600_000, windowMinutes: 300 }
  const a = attributionInWindow(ctx, 'claude', w)
  assert.ok(a)
  assert.deepEqual(a?.rows, [
    { label: 'new', share: '95 %', usage: '1.9M' },
    { label: 'old', share: '5 %', usage: '100K' },
  ])
  // The same tokens the window usage row reports, from the same hour range.
  assert.equal(windowUsage(ctx, 'claude', w)?.usage, '2M')
  // Everything the window measured is attributed, so nothing is declared unexplained.
  assert.equal(a?.unexplained, 'server % cannot be split — shown share is of local tokens only')
})

test('window attribution names what it cannot attribute instead of rescaling', () => {
  // A record from before per-hour slices existed: lifetime counters, no slice. Its five
  // million tokens must neither enter a row nor be quietly dropped from the caveat.
  const oldRec = session({ sessionId: 'legacy', project: 'legacy', input: 5_000_000, hourUsage: undefined })
  const sliced = session({
    sessionId: 'fresh', project: 'alpha',
    hourUsage: { [String(Math.floor((NOW - 3_600_000) / 3_600_000))]: 1000 },
  })
  const ctx = ctxOf(withSessions(buildAgg('project'), [oldRec, sliced]), { sources: ['claude'] })
  const w = { resetsAt: NOW + 2 * 3_600_000, windowMinutes: 300 }
  const a = attributionInWindow(ctx, 'claude', w)
  assert.deepEqual(a?.rows, [{ label: 'alpha', share: '100 %', usage: '1K' }])
  // The fixture's window holds 13,600 local tokens; only 1,000 of them carry a slice.
  assert.equal(
    a?.unexplained,
    'server % cannot be split — shown share is of local tokens only; '
      + '93 % of this window has no session slice',
  )

  // With no slice at all there is no table to draw, rather than a table of lifetimes.
  const none = attributionInWindow(
    ctxOf(withSessions(buildAgg('project'), [oldRec]), { sources: ['claude'] }), 'claude', w,
  )
  assert.equal(none, null)
})
