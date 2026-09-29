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
import { sessionShortName, spanText } from '../src/agentTreeBuild'
import { toCsv, toJson, toMarkdownSummary } from '../src/exporter'
import { costOfBucket } from '../src/prices'
import { LOCAL_BLOCK_HOURS, RecordsWords, StatsCtx, localBlock, records } from '../src/stats'
import { markdownDocument, quickPickItems } from '../src/textViews'
import { DayRange, rangeFor } from '../src/time'
import { projectKeyOf, slugOf } from '../src/project'
import { AgentRec, Bucket, MainRec, SessionRec, Snapshot, emptyBucket } from '../src/types'
import { buildViewModel } from '../src/viewModel'
import { NOW, TODAY, buildAgg, makeConfig, makeInput, timeConfig } from './fixtures/viewFixtures'

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
  assert.equal(plain.peakDay?.costPartial, false)
})

test("the peak day's cost says when it is only a lower bound", () => {
  // One priced and one unpriced bucket on the same day: the figure is real but incomplete,
  // so it is published exactly like a TotalRow — the value, plus the flag a view marks.
  const priced = day(TODAY, 500_000)
  const unpriced = day(TODAY, 500_000, 'claude-experimental-x')
  const r = records(ctxOf(fromBuckets([priced, unpriced]), { sources: ['claude'] }), range('30d'), 5, '2026-07-01')
  assert.equal(r.peakDay?.day, TODAY)
  assert.match(String(r.peakDay?.cost), /^~\$/)
  assert.equal(r.peakDay?.costPartial, true, 'an unpriced bucket makes the day a floor')
  // The same day priced throughout carries no flag.
  const whole = records(ctxOf(fromBuckets([priced]), { sources: ['claude'] }), range('30d'), 5, '2026-07-01')
  assert.equal(whole.peakDay?.costPartial, false)
  // Nothing priced at all is a dash, and a dash needs no qualifier.
  const none = records(ctxOf(fromBuckets([unpriced]), { sources: ['claude'] }), range('30d'), 5, '2026-07-01')
  assert.equal(none.peakDay?.cost, '–')
  assert.equal(none.peakDay?.costPartial, false)
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
  // And with attribution on there are rows, the sessions with the caveat that they are lifetimes. 1.14 P5 (pinned and
  // changed: the top projects are the range's buckets — no session count beside them, §3 A4 rule 4 —, named by their
  // label: the folder's name with names on, the pseudonym without; the note speaks of sessions only).
  const on = records(ctxOf(buildAgg('project'), { attribution: 'project', projectNames: true }), range('30d'), 5, '2026-07-01')
  assert.equal(on.attributionOn, true)
  assert.deepEqual(on.topProjects.map((p) => p.label), ['alpha', 'beta'])
  assert.deepEqual(on.topProjects.map((p) => p.detail), [null, null])
  assert.deepEqual(on.topSessions.map((s) => [s.label, s.detail]), [['sess-alpha', 'alpha'], ['thread-1', 'beta']])
  assert.match(String(on.sessionNote), /^sessions count each session’s whole lifetime/)
  const hashed = records(ctxOf(buildAgg('project'), { attribution: 'project' }), range('30d'), 5, '2026-07-01')
  for (const e of [...hashed.topProjects.map((p) => p.label), ...hashed.topSessions.map((s) => String(s.detail))]) {
    assert.match(e, /^p:[0-9a-f]{12}$/)
  }
})

/** Two session records, enough to prove the attribution gate is the setting and not the data. */
function sessionsOf(): SessionRec[] {
  return [{
    source: 'claude', sessionId: 's1', project: 'alpha', isSub: false, parent: null,
    firstTs: NOW - 3_600_000, lastTs: NOW, models: ['claude-opus-4-6'], input: 1000, cacheWrite: 0,
    cacheWrite1h: 0, cacheRead: 0, output: 100, reasoning: 0, requests: 1, outputFinal: 1,
    lastCacheTtl: null, lastCacheWriteTs: null, turnGapsMs: [],
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

// ---------------------------------------------------------------------------
// 1.11 B: the most expensive days, the longest and largest sessions, the hours with the most cache
// written, and no record while the history is being read (§3 B8 1–5, §0a.2's leak test)
// ---------------------------------------------------------------------------

/** What the view model hands `records()`: the Agents tree's own words, and the hour buckets' horizon. */
const WORDS: RecordsWords = { sessionName: sessionShortName, spanText, hourRetentionDays: 45 }
const MS_MIN = 60_000

/** One day bucket of `input` tokens and nothing else — its cost is `input` at the model's input rate. */
function priced(d: string, input: number, model = 'claude-opus-4-6'): Bucket {
  return day(d, input, model)
}

test('1.11 B1: the most expensive days — the priced days by cost, an unpriced-only day none; ties by the newer day; topN caps them', () => {
  const agg = fromBuckets([
    // Sonnet is the cheaper model: 3M of it cost less than 2M of Opus, so usage and cost disagree on the order.
    priced('2026-09-01', 3_000_000, 'claude-sonnet-4-6'),
    priced('2026-09-02', 2_000_000),
    priced('2026-08-30', 1_000_000),
    // The most usage of all, and no price on file: no record.
    priced('2026-08-31', 9_000_000, 'claude-experimental-x'),
  ])
  const r = records(ctxOf(agg, { sources: ['claude'] }), range('30d'), 5, '2026-08-01', true, WORDS)
  assert.deepEqual(r.costDays.map((d) => [d.day, d.cost, d.usage, d.floor]), [
    ['2026-09-02', '~$10.00', '2M', false],
    ['2026-09-01', '~$9.00', '3M', false],
    ['2026-08-30', '~$5.00', '1M', false],
  ])
  assert.equal(r.recordNotes.some((n) => n.startsWith('⚠ = a lower bound')), false, 'no row is marked, so no legend')
  // Equal costs: the newer day first.
  const tie = records(ctxOf(fromBuckets([priced('2026-09-01', 1_000_000), priced('2026-09-02', 1_000_000)]), { sources: ['claude'] }),
    range('30d'), 5, '2026-08-01', true, WORDS)
  assert.deepEqual(tie.costDays.map((d) => d.day), ['2026-09-02', '2026-09-01'])
  // N = 2: two rows.
  assert.deepEqual(records(ctxOf(agg, { sources: ['claude'] }), range('30d'), 2, '2026-08-01', true, WORDS).costDays.map((d) => d.day),
    ['2026-09-02', '2026-09-01'])
})

test('1.11 B1: ⚠ on a day with an unpriced bucket and on the first day of coverage, with its legend; a day before coverage and a month bucket are no row', () => {
  const month: Bucket = {
    ...emptyBucket('claude', 'claude-opus-4-6', false, 'standard', 'm', null, '2026-07'), input: 50_000_000, requests: 9, outputFinal: 9,
  }
  const agg = fromBuckets([
    month,
    // Before coverage: the costliest day of all, and not watched.
    priced('2026-08-10', 8_000_000),
    // The first day of coverage: the transcripts on disk begin that day.
    priced('2026-08-20', 1_000_000),
    // A priced and an unpriced bucket on one day: the cost is a floor.
    priced('2026-09-02', 2_000_000), priced('2026-09-02', 500_000, 'claude-experimental-x'),
    priced('2026-09-03', 3_000_000),
  ])
  const r = records(ctxOf(agg, { sources: ['claude'] }), custom('2026-07-01', TODAY), 5, '2026-08-20', true, WORDS)
  assert.deepEqual(r.costDays.map((d) => [d.day, d.floor]), [['2026-09-03', false], ['2026-09-02', true], ['2026-08-20', true]])
  // The floor day's usage counts the unpriced bucket too; its cost only the priced one.
  assert.deepEqual([r.costDays[1].cost, r.costDays[1].usage], ['~$10.00', '2.5M'])
  assert.equal(r.recordNotes[0], '⚠ = a lower bound: the day or the hour holds usage without a price on file, or the transcripts on disk begin that day.')
  assert.equal(r.note, '1 rolled-up month bucket in this range has no day left and is not in these records')
})

test('1.11 B1: with the costs switched off there is no expensive day, and one line says why', () => {
  const agg = fromBuckets([priced('2026-09-02', 2_000_000)])
  const r = records(ctxOf(agg, { sources: ['claude'], showCost: false }), range('30d'), 5, '2026-08-01', true, WORDS)
  assert.deepEqual(r.costDays, [])
  assert.ok(r.recordNotes.includes('The most expensive days need tokenPace.showCost.'), r.recordNotes.join('\n'))
  const on = records(ctxOf(agg, { sources: ['claude'] }), range('30d'), 5, '2026-08-01', true, WORDS)
  assert.equal(on.recordNotes.includes('The most expensive days need tokenPace.showCost.'), false)
})

/** A main session record, its own usage `input` + `output` — invented figures. */
function mainRec(sessionId: string, firstTs: number, lastTs: number, input: number, over: Partial<MainRec> = {}): MainRec {
  return {
    source: 'claude', sessionId, firstTs, lastTs, models: ['claude-opus-4-6'],
    input, cacheWrite: 0, cacheWrite1h: 0, cacheRead: 0, output: 0, reasoning: 0, requests: 3, outputFinal: 3, toolCalls: 0,
    ccVersion: null, permissionMode: null, compactions: 0, lastCompaction: null, lastRequest: null, lastUserAt: null, ...over,
  }
}

/** An agent record of `sessionId` whose transcript sits at `sessionFile`'s folder. */
function agentRec(agentId: string, sessionId: string, lastTs: number, input: number, sessionFile = `/virtual/claude/projects/-home-t-alpha/${sessionId}.jsonl`): AgentRec {
  return {
    source: 'claude', agentId, sessionId, sessionFile, workflowId: null, meta: null, metaTries: 3, spawnerFile: null,
    firstTs: lastTs - 10 * MS_MIN, lastTs, models: ['claude-opus-4-6'],
    input, cacheWrite: 0, cacheWrite1h: 0, cacheRead: 0, output: 0, reasoning: 0, requests: 2, outputFinal: 2, toolCalls: 0,
    outcome: 'completed', outcomeTs: lastTs, outcomeStatus: 'completed', rejected: null, lastTool: null, lastToolTs: null,
    effort: null, efforts: [], lastContext: null, toolErrors: 0, cacheMisses: {}, cacheMissedTokens: 0,
    ccVersion: null, permissionMode: null, compactions: 0, lastCompaction: null,
  } as AgentRec
}

/** An aggregator whose main and agent records are handed in verbatim. */
function withRecords(mains: MainRec[], agents: AgentRec[] = [], base: Aggregator = new Aggregator()): Aggregator {
  const out = Object.create(base) as Aggregator
  out.mains = () => mains
  out.agents = () => agents
  return out
}

const H = 3_600_000
/** The session world of B8 2: three idle sessions, an active one, a twin record, one broken, one out of range. */
function sessionWorld(): Aggregator {
  return withRecords([
    // 3 h 12 min, 12K of its own and 25K of its two agents'.
    mainRec('aaaa1111-0000', NOW - 4 * H, NOW - 4 * H + 3 * H + 12 * MS_MIN, 12_000),
    // 49 min, 100K of its own: the largest.
    mainRec('bbbb2222-0000', NOW - 2 * 24 * H, NOW - 2 * 24 * H + 49 * MS_MIN, 100_000),
    // Active: its last line five minutes ago — its time and tokens are still growing.
    mainRec('cccc3333-0000', NOW - 2 * H, NOW - 5 * MS_MIN, 500_000),
    // One session under two paths: the newer record (1 h) is the session, not the older (10 h).
    mainRec('dddd4444-0000', NOW - 3 * 24 * H - 10 * H, NOW - 3 * 24 * H, 1_000),
    mainRec('dddd4444-0000', NOW - 3 * H, NOW - 2 * H, 2_000),
    // No first line: no span, no session (anti-fake).
    mainRec('eeee5555-0000', Number.NaN, NOW - H, 900_000),
    // Six days back: in the index, outside a range of the last three days.
    mainRec('ffff6666-0000', NOW - 6 * 24 * H - 5 * H, NOW - 6 * 24 * H, 50_000),
  ], [
    agentRec('a0000000000000001', 'aaaa1111-0000', NOW - 2 * H, 20_000),
    agentRec('a0000000000000002', 'aaaa1111-0000', NOW - H, 5_000),
  ])
}

test('1.11 B2: the longest and the largest sessions — only ended ones, named as the Agents tree names them, own usage plus the agents\', one row per id', () => {
  const r = records(ctxOf(sessionWorld(), { sources: ['claude'] }), custom('2026-08-31', TODAY), 5, '2026-07-01', true, WORDS)
  assert.deepEqual(r.longestSessions.map((s) => [s.name, s.time, s.usage, s.start]), [
    ['Thu 08:00 · aaaa1111', '3 h 12 min', '37K', '08:00'],
    ['Thu 09:00 · dddd4444', '1 h 00 min', '2K', '09:00'],
    ['Tue 12:00 · bbbb2222', '49 min 00 s', '100K', '2026-09-01 12:00'],
  ])
  assert.deepEqual(r.largestSessions.map((s) => [s.sessionId, s.usage, s.time]), [
    ['bbbb2222-0000', '100K', '49 min 00 s'], ['aaaa1111-0000', '37K', '3 h 12 min'], ['dddd4444-0000', '2K', '1 h 00 min'],
  ])
  // The name and the time are the tree's own (agentTreeBuild.ts), not a second form of them — the name without the word
  // "Session" (the lead's 1.11 pre-freeze fix: the column head and the Quick Pick key already say it).
  const a = r.longestSessions[0]
  assert.equal(a.name, sessionShortName('aaaa1111-0000', NOW - 4 * H, NOW, tcfg))
  assert.equal(a.name, 'Thu 08:00 · aaaa1111')
  assert.equal(a.time, spanText(3 * H + 12 * MS_MIN))
  // The active one is not ranked, and the note counts it; the basis note stands with the rows.
  assert.equal([...r.longestSessions, ...r.largestSessions].some((s) => s.sessionId.startsWith('cccc')), false)
  assert.ok(r.recordNotes.includes('1 active session(s) not ranked yet: their time and tokens are still growing.'), r.recordNotes.join('\n'))
  assert.ok(r.recordNotes.includes('Claude Code sessions of the last 7 days that are no longer active — the Agents section keeps a '
    + 'session for 7 days after its last line. Time runs from its first counted line to its last, pauses included; usage is its own and '
    + 'its agents\'.'), r.recordNotes.join('\n'))
  // The broken record and the one before the range are absent; the whole index holds seven records.
  assert.equal([...r.longestSessions, ...r.largestSessions].some((s) => /^(eeee|ffff)/.test(s.sessionId)), false)
  // A range of every day takes the six-day-old one in.
  const all = records(ctxOf(sessionWorld(), { sources: ['claude'] }), range('30d'), 5, '2026-07-01', true, WORDS)
  assert.ok(all.longestSessions.some((s) => s.sessionId === 'ffff6666-0000'))
  // N = 1.
  const one = records(ctxOf(sessionWorld(), { sources: ['claude'] }), range('30d'), 1, '2026-07-01', true, WORDS)
  assert.deepEqual([one.longestSessions.length, one.largestSessions.length], [1, 1])
})

test('1.11 B2: a session whose agent wrote a minute ago is still active; the model chips keep a session by its models; beyond the retention none', () => {
  const agg = withRecords([mainRec('aaaa1111-0000', NOW - 4 * H, NOW - 2 * H, 12_000)], [agentRec('a0000000000000001', 'aaaa1111-0000', NOW - MS_MIN, 20_000)])
  const r = records(ctxOf(agg, { sources: ['claude'] }), range('30d'), 5, '2026-07-01', true, WORDS)
  assert.deepEqual([r.longestSessions, r.largestSessions], [[], []])
  assert.ok(r.recordNotes.includes('1 active session(s) not ranked yet: their time and tokens are still growing.'))
  const chips = records(ctxOf(sessionWorld(), { sources: ['claude'], models: ['claude-sonnet-4-6'] }), range('30d'), 5, '2026-07-01', true, WORDS)
  assert.deepEqual([chips.longestSessions, chips.largestSessions], [[], []])
  // Eight days after its last line the Agents section has let it go, and so have the Records.
  const old = withRecords([mainRec('aaaa1111-0000', NOW - 9 * 24 * H, NOW - 8 * 24 * H, 12_000)])
  assert.deepEqual(records(ctxOf(old, { sources: ['claude'] }), range('30d'), 5, '2026-07-01', true, WORDS).longestSessions, [])
})

test('1.11 B2 (§3.0 c): under Codex the session tables are empty and the section says they are Claude Code\'s', () => {
  const r = records(ctxOf(sessionWorld(), { sources: ['codex'] }), range('30d'), 5, '2026-07-01', true, WORDS)
  assert.deepEqual([r.longestSessions, r.largestSessions], [[], []])
  assert.equal(r.recordNotes.at(-1), 'Claude Code only — not shown while Codex is selected.')
  assert.equal(r.recordNotes.some((n) => n.startsWith('Claude Code sessions of the last') || n.includes('active session(s)')), false)
  // Under both providers the line is not there.
  const both = records(ctxOf(sessionWorld()), range('30d'), 5, '2026-07-01', true, WORDS)
  assert.equal(both.recordNotes.some((n) => n.startsWith('Claude Code only')), false)
})

/** One hour bucket `n` hours before NOW that wrote `write` tokens to the cache, `write1h` of them for an hour. */
function written(n: number, write: number, write1h = 0, model = 'claude-opus-4-6'): Bucket {
  const h = Math.floor((NOW - n * MS_HOUR) / MS_HOUR)
  return {
    ...emptyBucket('claude', model, false, 'standard', 'h', h, TODAY),
    input: 1000, output: 500, cacheRead: 40_000, cacheWrite: write, cacheWrite1h: write1h, requests: 1, outputFinal: 1,
  }
}

test('1.11 B3: the hours with the most cache written — by tokens, the 1-hour part, the writers, the cost of the writes alone', () => {
  const opus = written(3, 1_000_000)
  const agg = fromBuckets([
    opus, written(3, 400_000, 400_000, 'claude-sonnet-4-6'),
    written(5, 2_000_000),
    // Three writers: two named, the third counted.
    written(1, 300_000, 0, 'claude-sonnet-4-6'), written(1, 200_000), written(1, 100_000, 0, 'claude-haiku-4-5'),
    // A day bucket's writes have no hour: no row.
    { ...emptyBucket('claude', 'claude-opus-4-6', false, 'standard', 'd', null, '2026-09-02'), cacheWrite: 9_000_000, requests: 1, outputFinal: 1 },
  ])
  const r = records(ctxOf(agg, { sources: ['claude'] }), range('30d'), 5, '2026-07-01', true, WORDS)
  assert.deepEqual(r.cacheHours.map((h) => [h.hour, h.written, h.written1h, h.models, h.floor]), [
    ['2026-09-03 07:00', '2M', '–', 'claude-opus-4-6', false],
    ['2026-09-03 09:00', '1.4M', '400K', 'claude-opus-4-6, claude-sonnet-4-6', false],
    ['2026-09-03 11:00', '600K', '–', 'claude-sonnet-4-6, claude-opus-4-6 +1 more', false],
  ])
  // 1M five-minute writes of claude-opus-4-6 at $6.25/M, by hand — and the same as costOfBucket on the write-only copy.
  const alone = records(ctxOf(fromBuckets([opus]), { sources: ['claude'] }), range('30d'), 5, '2026-07-01', true, WORDS)
  assert.equal(alone.cacheHours[0].cost, '~$6.25')
  const copy = costOfBucket({ ...opus, input: 0, cacheRead: 0, output: 0, reasoning: 0, webSearch: 0, webFetch: 0 }, { overrides: {}, multiplier: 1, unknownModel: 'strict' })
  assert.equal(copy?.usd, 6.25)
  // Sonnet's 400K one-hour writes at $6/M beside it: $2.40 more.
  assert.equal(r.cacheHours[1].cost, '~$8.65')
  assert.ok(r.recordNotes.includes('A large cache write is usually a cold start — a conversation\'s prefix written to the cache again after it '
    + 'expired —, a new conversation or a compaction; one hour can hold several.'), r.recordNotes.join('\n'))
  // N = 2.
  assert.equal(records(ctxOf(agg, { sources: ['claude'] }), range('30d'), 2, '2026-07-01', true, WORDS).cacheHours.length, 2)
})

test('1.11 B3: an hour with an unpriced write is a floor while its cost is shown; the costs off, a dash; a Codex range, the empty line; the horizon named where the range reaches past it', () => {
  const agg = fromBuckets([written(2, 100_000), written(2, 50_000, 0, 'claude-experimental-x')])
  const r = records(ctxOf(agg, { sources: ['claude'] }), range('30d'), 5, '2026-07-01', true, WORDS)
  assert.deepEqual([r.cacheHours[0].cost, r.cacheHours[0].floor], ['~$0.63', true])
  const off = records(ctxOf(agg, { sources: ['claude'], showCost: false }), range('30d'), 5, '2026-07-01', true, WORDS)
  assert.deepEqual([off.cacheHours[0].cost, off.cacheHours[0].floor, off.cacheHours[0].written], ['–', false, '150K'])
  // Codex writes no billed cache: no hour, the line in place of the table.
  const codex = records(ctxOf(buildAgg(), { sources: ['codex'] }), range('30d'), 5, '2026-07-01', true, WORDS)
  assert.deepEqual(codex.cacheHours, [])
  assert.ok(codex.recordNotes.includes('No cache write counted in this range.'))
  // The horizon: a 30-day range lies inside 45 kept days, a range from July does not.
  assert.equal(r.recordNotes.some((n) => n.startsWith('Hour buckets are kept')), false)
  const july = records(ctxOf(agg, { sources: ['claude'] }), custom('2026-07-01', TODAY), 5, '2026-07-01', true, WORDS)
  assert.ok(july.recordNotes.includes('Hour buckets are kept for 45 day(s) (tokenPace.hourRetentionDays); earlier hours are not ranked.'))
})

test('1.11 B4: while the history is being read there is no record at all — the one sentence instead', () => {
  const agg = sessionWorld()
  const ctx = ctxOf(buildAgg('project'), { attribution: 'project' })
  const settledOne = records(ctx, range('30d'), 5, '2026-07-01', true, WORDS)
  assert.ok(settledOne.peakDay && settledOne.streak && settledOne.topModels.length > 0 && settledOne.topSessions.length > 0)
  const r = records(ctx, range('30d'), 5, '2026-07-01', false, WORDS)
  assert.equal(r.reading, 'Reading history…')
  assert.deepEqual(
    [r.peakDay, r.streak, r.topModels, r.topProjects, r.topSessions, r.costDays, r.longestSessions, r.largestSessions, r.cacheHours, r.recordNotes, r.note, r.sessionNote],
    [null, null, [], [], [], [], [], [], [], [], null, null],
  )
  assert.equal(r.attributionOn, true, 'the setting is a fact, not a record')
  assert.equal(records(ctxOf(agg, { sources: ['claude'] }), range('30d'), 5, '2026-07-01', false, WORDS).longestSessions.length, 0)
  // Settled (the default) has no sentence.
  assert.equal(records(ctx, range('30d'), 5, '2026-07-01').reading, null)
})

/** A version-8 snapshot with one long, large session and one costly day, its session keyed by a path under `project`. */
function recordSnapshot(project: string): Snapshot {
  const file = `/home/u/${project}/9d0eb37a-1111-4222-8333-944445555666.jsonl`
  const main = mainRec('9d0eb37a-1111-4222-8333-944445555666', NOW - 5 * H, NOW - H, 400_000)
  const agent = agentRec('a0000000000000009', main.sessionId, NOW - 2 * H, 30_000, file)
  return {
    version: 8, buckets: [priced('2026-09-02', 4_000_000), written(3, 1_000_000)], cursors: {}, pending: {}, sessions: {}, attribution: 'none',
    rollup: { lastRun: 0, hourRetentionDays: 0, retentionDays: 0 }, firstIngest: NOW - 30 * 24 * H,
    agents: { [`/home/u/${project}/9d0eb37a-1111-4222-8333-944445555666/subagents/agent-a0000000000000009.jsonl`]: agent },
    mains: { [file]: main },
  } as unknown as Snapshot
}

test('1.11 B8 5: nothing is invented across a rescan — the records are built from what the aggregator holds, and it holds none of them', () => {
  const before = Aggregator.fromSnapshot(recordSnapshot('synthetic-project-123'), 'none')
  const r = records(ctxOf(before, { sources: ['claude'] }), range('30d'), 5, '2026-07-01', true, WORDS)
  assert.equal(r.costDays[0]?.day, '2026-09-02')
  assert.equal(r.longestSessions[0]?.sessionId, '9d0eb37a-1111-4222-8333-944445555666')
  assert.equal(r.largestSessions[0]?.usage, '430K')
  assert.equal(r.cacheHours[0]?.written, '1M')
  // The snapshot the aggregator writes carries no record of the Records.
  const snap = before.toSnapshot() as unknown as Record<string, unknown>
  assert.equal(Object.keys(snap).some((k) => /record|costDay|longest|largest|cacheHour/i.test(k)), false, Object.keys(snap).join(', '))
  // A rescan that reads less: its aggregator, from a snapshot without the session and the day, shows neither.
  const after = Aggregator.fromSnapshot({ ...before.toSnapshot(), buckets: [], mains: {}, agents: {} } as Snapshot, 'none')
  const again = records(ctxOf(after, { sources: ['claude'] }), range('30d'), 5, '2026-07-01', true, WORDS)
  assert.deepEqual([again.costDays, again.longestSessions, again.largestSessions, again.cacheHours], [[], [], [], []])
})

test('1.11 §0a.2 leak test: the session is ranked by its name, and its path — the project folder — reaches no record, no flat view and no export', () => {
  const SECRET = 'synthetic-project-123'
  const agg = Aggregator.fromSnapshot(recordSnapshot(SECRET), 'none')
  // The path is in the aggregator — the index is keyed by it — and the fixture is live.
  assert.ok(agg.mainEntries().some(([file]) => file.includes(SECRET)))
  assert.ok(agg.agents().some((a) => a.sessionFile.includes(SECRET)))
  const cfg = makeConfig({ 'tokenPace.dashboard.sections': ['quota', 'records'] })
  const vm = buildViewModel(makeInput({ agg, cfg }))
  assert.deepEqual(vm.records.longestSessions.map((s) => s.name), ['Thu 07:00 · 9d0eb37a'])
  assert.equal(JSON.stringify(vm.records).includes(SECRET), false, 'vm.records')
  assert.equal(JSON.stringify(quickPickItems(vm)).includes(SECRET), false, 'the Quick Pick')
  assert.ok(quickPickItems(vm).some((i) => i.label.startsWith('Longest session Thu 07:00 · 9d0eb37a')))
  assert.equal(markdownDocument(vm).includes(SECRET), false, 'the markdown document')
  assert.equal(toMarkdownSummary(vm).includes(SECRET), false, 'Copy Usage Summary')
  const exportRange = { from: '2026-08-01', to: TODAY }
  assert.equal(toCsv(agg, exportRange, cfg, tcfg).includes(SECRET), false, 'the CSV')
  assert.equal(toJson(agg, exportRange, cfg, tcfg, NOW).includes(SECRET), false, 'the JSON')
})

test('1.11 B1/B3 (Review 2 F4): the ⚠ legend stands whenever an hour is a floor, even with no priced day to mark', () => {
  // The hour with the unpriced write lies on a cheap day; with N = 1 the cost table shows only the expensive priced day,
  // so no day carries the ⚠ — the hour still does, and the legend must explain it (Review 2 F4).
  const agg = fromBuckets([
    written(2, 100_000), written(2, 50_000, 0, 'claude-experimental-x'),
    { ...emptyBucket('claude', 'claude-opus-4-6', false, 'standard', 'd', null, '2026-09-02'), input: 5_000_000, output: 100_000, requests: 1, outputFinal: 1 },
  ])
  const r = records(ctxOf(agg, { sources: ['claude'] }), range('30d'), 1, '2026-07-01', true, WORDS)
  assert.deepEqual(r.costDays.map((d) => [d.day, d.floor]), [['2026-09-02', false]])
  assert.equal(r.cacheHours.length, 1)
  assert.equal(r.cacheHours[0].floor, true)
  assert.equal(r.recordNotes[0], '⚠ = a lower bound: the day or the hour holds usage without a price on file, or the transcripts on disk begin that day.')
  // Without a floor anywhere the legend is not written.
  const plain = records(ctxOf(fromBuckets([written(2, 500_000)]), { sources: ['claude'] }), range('30d'), 5, '2026-07-01', true, WORDS)
  assert.equal(plain.cacheHours[0].floor, false)
  assert.equal(plain.recordNotes.some((n) => n.startsWith('⚠ = a lower bound')), false, plain.recordNotes.join('\n'))
})

// ---------------------------------------------------------------------------
// 1.14 §3 A4 rule 4 (P5): the top projects from the range's buckets, the sessions of the project filter
// ---------------------------------------------------------------------------

/** buildAgg's two projects: the Claude folder /home/t/alpha and the Codex rollout started in /home/t/beta (salt 'salt'). */
const ALPHA = projectKeyOf('salt', '-home-t-alpha')
const BETA = projectKeyOf('salt', slugOf('/home/t/beta'))

test('1.14 §3 A4 rule 4: the top projects are the range\'s buckets — the usage and share of the range, the priced cost by the models\' rule —, and a project chip narrows every table of the records to it', () => {
  const agg = buildAgg('project')
  const ctx = ctxOf(agg, { attribution: 'project', projectNames: true })
  const all = records(ctx, range('30d'), 5, '2026-07-01')
  const byLabel = new Map(all.topModels.map((m) => [m.label, m]))
  assert.ok(byLabel.size > 0)
  // Alpha is Claude's usage of the range, beta Codex's: the same figures the top models add up to per provider.
  assert.deepEqual(all.topProjects.map((p) => p.label), ['alpha', 'beta'])
  const shareSum = all.topProjects.reduce((n, p) => n + parseInt(p.share, 10), 0)
  assert.ok(shareSum >= 99 && shareSum <= 101, String(shareSum))
  // Alpha has a bucket with no price (claude-experimental-x): a dash, as its top model has; beta's cost is priced.
  assert.equal(all.topProjects[0].cost, '–')
  assert.match(all.topProjects[1].cost, /^~\$/)
  assert.equal(all.topProjects[1].cost, all.topModels.find((m) => m.label === 'gpt-5.3-codex')?.cost)
  // Under beta's chip: its buckets only — top models, peak day, top projects, top sessions.
  const beta = records(ctxOf(agg, { attribution: 'project', projectNames: true, projects: [BETA] }), range('30d'), 5, '2026-07-01')
  assert.deepEqual(beta.topProjects.map((p) => [p.label, p.share]), [['beta', '100 %']])
  assert.deepEqual(beta.topModels.map((m) => m.label), ['gpt-5.3-codex'])
  assert.deepEqual(beta.topSessions.map((s) => [s.label, s.detail]), [['thread-1', 'beta']])
  // The peak day is Codex's larger day (2 September: 3K fresh + 3K output), not Claude's today.
  assert.deepEqual([beta.peakDay?.day, beta.peakDay?.usage], ['2026-09-02', '6K'])
  assert.notEqual(all.peakDay?.day, '2026-09-02')
  // Both chips: the two again; a chip of a project without usage: nothing.
  assert.deepEqual(records(ctxOf(agg, { attribution: 'project', projects: [ALPHA, BETA] }), range('30d'), 5, '2026-07-01').topProjects.length, 2)
  const none = records(ctxOf(agg, { attribution: 'project', projects: ['0123456789ab'] }), range('30d'), 5, '2026-07-01')
  assert.deepEqual([none.peakDay, none.topModels, none.topProjects, none.topSessions, none.sessionNote], [null, [], [], [], null])
})

test('1.14 §3 A4 rule 4: under a project chip the longest and largest sessions are the chosen project\'s — an Agents-table session by its main transcript\'s record; one without a record is in no project', () => {
  const base = sessionWorld()
  const rec = (sessionId: string, project: string): SessionRec => ({
    source: 'claude', sessionId, project, isSub: false, parent: null, firstTs: NOW - H, lastTs: NOW, models: ['claude-opus-4-6'],
    input: 0, cacheWrite: 0, cacheWrite1h: 0, cacheRead: 0, output: 0, reasoning: 0, requests: 0, outputFinal: 0,
    lastCacheTtl: null, lastCacheWriteTs: null, turnGapsMs: [],
  })
  const agg = Object.create(base) as Aggregator
  agg.sessions = () => [rec('aaaa1111-0000', ALPHA), rec('bbbb2222-0000', BETA), rec('dddd4444-0000', ALPHA)]
  const ids = (projects: string[]): string[] => records(ctxOf(agg, { sources: ['claude'], attribution: 'project', projects }),
    custom('2026-08-31', TODAY), 5, '2026-07-01', true, WORDS).longestSessions.map((s) => s.sessionId).sort()
  assert.deepEqual(ids([]), ['aaaa1111-0000', 'bbbb2222-0000', 'dddd4444-0000'])
  assert.deepEqual(ids([ALPHA]), ['aaaa1111-0000', 'dddd4444-0000'])
  assert.deepEqual(ids([BETA]), ['bbbb2222-0000'])
  assert.deepEqual(ids(['0123456789ab']), [])
})
