// SPDX-FileCopyrightText: 2026 Frederik Marx
// SPDX-License-Identifier: AGPL-3.0-or-later

import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import * as path from 'path'
import { Aggregator, parseCodexRateLimits } from '../src/agg'
import { hourIndex } from '../src/time'
import { Cursor, Snapshot } from '../src/types'
import {
  CODEX_FILE, CODEX_ROOT, camelRateLimits, codexMeta, codexTaskStarted, codexTokenCount, codexTurnContext, ctxFor,
  snakeRateLimits,
} from './fixtures/helpers'

const T0 = Date.UTC(2026, 2, 10, 9, 0, 0)
const CTX = ctxFor({ file: CODEX_FILE })

function cursor(): Cursor {
  return { offset: 0, size: 0, ino: 1, dev: 1 }
}

/** Feeds lines through one cursor the way scan() does. */
function feed(agg: Aggregator, cur: Cursor, lines: string[], ctx = CTX): number {
  let n = 0
  for (const l of lines) if (agg.addCodexLine(l, cur, ctx)) n++
  return n
}

test('cumulative totals: only the positive increase counts, duplicates and drops are ignored', () => {
  const agg = new Aggregator()
  const cur = cursor()
  const n = feed(agg, cur, [
    codexMeta({ ts: T0 }),
    codexTurnContext(T0, 'gpt-5.4'),
    codexTokenCount({ ts: T0 + 10_000, total: { input: 80, output: 20, total: 100 } }),
    codexTokenCount({ ts: T0 + 20_000, total: { input: 200, cached: 50, output: 50, total: 250 }, last: { input: 120, cached: 50, output: 30, reasoning: 7, total: 150 } }),
    codexTokenCount({ ts: T0 + 21_000, total: { input: 200, cached: 50, output: 50, total: 250 }, last: { input: 120, cached: 50, output: 30, reasoning: 7, total: 150 } }),
    // Post-compaction marker: the total falls; nothing is counted, the baseline stays.
    codexTokenCount({ ts: T0 + 30_000, total: { input: 40, output: 10, total: 50 }, last: { input: 40, output: 10, total: 50 } }),
    codexTokenCount({ ts: T0 + 40_000, total: { input: 300, output: 100, total: 400 }, last: { input: 100, output: 50, total: 150 } }),
  ])
  assert.equal(n, 3)
  const all = agg.all()
  assert.equal(all.length, 1)
  const b = all[0]
  assert.equal(b.source, 'codex')
  assert.equal(b.model, 'gpt-5.4')
  assert.equal(b.isSub, false)
  assert.equal(b.tier, 'standard')
  assert.equal(b.input, 80 + 120 + 100)
  assert.equal(b.cacheRead, 50)
  assert.equal(b.output, 20 + 30 + 50)
  assert.equal(b.reasoning, 7)
  assert.equal(b.requests, 3)
  assert.equal(b.outputFinal, 3)
  assert.equal(b.hour, hourIndex(T0))
  assert.equal(cur.lastTotal, 400)
  assert.equal(cur.lastTs, T0 + 40_000)
  assert.equal(cur.model, 'gpt-5.4')
  assert.equal(agg.firstIngest, T0 + 10_000)
})

test('first real event inherits its baseline: total − last is context, not usage', () => {
  const agg = new Aggregator()
  const cur = cursor()
  feed(agg, cur, [
    codexMeta({ ts: T0 }),
    codexTurnContext(T0, 'gpt-5.4'),
    codexTokenCount({ ts: T0 + 60_000, total: { input: 4800, output: 200, total: 5000 }, last: { input: 250, output: 50, total: 300 } }),
  ])
  const b = agg.all()[0]
  assert.equal(b.input, 250)
  assert.equal(b.output, 50)
  assert.equal(b.requests, 1)
  assert.equal(cur.lastTotal, 5000)
})

test('fork replay by marker: everything before task_started is baseline, the turn right after counts', () => {
  const agg = new Aggregator()
  const cur = cursor()
  const n = feed(agg, cur, [
    codexMeta({ ts: T0, id: 'thread-0002', forkedFrom: 'thread-0001' }),
    codexTurnContext(T0, 'gpt-5.4'),
    // Copied history, re-stamped at the fork time.
    codexTokenCount({ ts: T0 + 100, total: { input: 3000, output: 1000, total: 4000 }, last: { input: 900, output: 100, total: 1000 } }),
    codexTokenCount({ ts: T0 + 200, total: { input: 3500, output: 1100, total: 4600 }, last: { input: 500, output: 100, total: 600 } }),
    codexTaskStarted(T0 + 800),
    // First real turn, still within 2 s of the fork — the heuristic alone would swallow it.
    codexTokenCount({ ts: T0 + 1200, total: { input: 3700, output: 1200, total: 4900 }, last: { input: 200, output: 100, total: 300 } }),
    codexTokenCount({ ts: T0 + 90_000, total: { input: 3900, output: 1300, total: 5200 }, last: { input: 200, output: 100, total: 300 } }),
  ])
  assert.equal(n, 2)
  const b = agg.all()[0]
  assert.equal(b.isSub, true)
  assert.equal(b.input, 400)
  assert.equal(b.output, 200)
  assert.equal(b.requests, 2)
  assert.equal(cur.forked, true)
  assert.equal(cur.replayDone, true)
})

test('fork replay by marker without any replayed token_count (subagent): first event counts fully', () => {
  const agg = new Aggregator()
  const cur = cursor()
  feed(agg, cur, [
    codexMeta({ ts: T0, id: 'thread-0003', threadSource: 'subagent' }),
    codexTurnContext(T0, 'gpt-5.4-mini'),
    codexTaskStarted(T0 + 50),
    codexTokenCount({ ts: T0 + 900, total: { input: 120, output: 30, total: 150 } }),
  ])
  const b = agg.all()[0]
  assert.equal(b.isSub, true)
  assert.equal(b.model, 'gpt-5.4-mini')
  assert.equal(b.input, 120)
  assert.equal(b.requests, 1)
})

test('fork replay by the ±2 s heuristic when the file has no marker', () => {
  const agg = new Aggregator()
  const cur = cursor()
  const n = feed(agg, cur, [
    codexMeta({ ts: T0, id: 'thread-0004', forkedFrom: 'thread-0001' }),
    codexTurnContext(T0, 'gpt-5.4'),
    codexTokenCount({ ts: T0 + 500, total: { input: 3000, output: 1000, total: 4000 }, last: { input: 900, output: 100, total: 1000 } }),
    codexTokenCount({ ts: T0 + 1900, total: { input: 3500, output: 1100, total: 4600 }, last: { input: 500, output: 100, total: 600 } }),
    codexTokenCount({ ts: T0 + 5000, total: { input: 3700, output: 1200, total: 4900 }, last: { input: 200, output: 100, total: 300 } }),
  ])
  assert.equal(n, 1)
  const b = agg.all()[0]
  assert.equal(b.input, 200)
  assert.equal(b.output, 100)
  assert.equal(cur.lastTotal, 4900)
})

test('heuristic limit, pinned: a marker-less fork whose first turn lands inside 2 s loses it to the baseline', () => {
  const agg = new Aggregator()
  const cur = cursor()
  const n = feed(agg, cur, [
    codexMeta({ ts: T0, id: 'thread-0005', forkedFrom: 'thread-0001' }),
    codexTurnContext(T0, 'gpt-5.4'),
    codexTokenCount({ ts: T0 + 100, total: { input: 3000, output: 1000, total: 4000 }, last: { input: 900, output: 100, total: 1000 } }),
    codexTokenCount({ ts: T0 + 1500, total: { input: 3200, output: 1100, total: 4300 }, last: { input: 200, output: 100, total: 300 } }),
    codexTokenCount({ ts: T0 + 9000, total: { input: 3400, output: 1200, total: 4600 }, last: { input: 200, output: 100, total: 300 } }),
  ])
  assert.equal(n, 1)
  assert.equal(agg.all()[0].input, 200)
})

test('a plain (unforked) file never treats its own first events as replay', () => {
  const agg = new Aggregator()
  const cur = cursor()
  const n = feed(agg, cur, [
    codexMeta({ ts: T0 }),
    codexTurnContext(T0, 'gpt-5.4'),
    codexTokenCount({ ts: T0 + 100, total: { input: 80, output: 20, total: 100 } }),
    codexTokenCount({ ts: T0 + 900, total: { input: 160, output: 40, total: 200 }, last: { input: 80, output: 20, total: 100 } }),
  ])
  assert.equal(n, 2)
  assert.equal(agg.all()[0].input, 160)
  assert.equal(agg.all()[0].isSub, false)
})

test('rate_limits: snake_case parsed on every token_count, newest per file kept', () => {
  const agg = new Aggregator()
  const cur = cursor()
  feed(agg, cur, [
    codexMeta({ ts: T0 }),
    codexTokenCount({ ts: T0 + 1000, total: { input: 10, total: 10 }, rateLimits: snakeRateLimits() }),
    // A duplicate total still carries a newer reading.
    codexTokenCount({ ts: T0 + 2000, total: { input: 10, total: 10 }, rateLimits: snakeRateLimits({ primary: { used_percent: 13, window_minutes: 300, resets_at: 1773140000 } }) }),
  ])
  const rl = cur.lastRateLimits!
  assert.equal(rl.t, T0 + 2000)
  assert.equal(rl.limitId, 'codex')
  assert.equal(rl.limitName, 'Codex')
  assert.equal(rl.planType, 'pro')
  assert.deepEqual(rl.primary, { usedPercent: 13, windowMinutes: 300, resetsAt: 1773140000 * 1000 })
  assert.deepEqual(rl.secondary, { usedPercent: 40, windowMinutes: 10080, resetsAt: 1773500000 * 1000 })
  assert.deepEqual(rl.credits, { hasCredits: true, unlimited: false, balance: '12.50' })
  assert.equal(rl.limitReached, false)
})

test('rate_limits: camelCase schema, limitReached, null and absent blocks tolerated', () => {
  const agg = new Aggregator()
  const cur = cursor()
  feed(agg, cur, [
    codexMeta({ ts: T0 }),
    codexTokenCount({ ts: T0 + 1000, total: { input: 10, total: 10 }, rateLimits: camelRateLimits(), camel: true }),
  ])
  const rl = cur.lastRateLimits!
  assert.equal(rl.limitId, 'codex_zeta')
  assert.equal(rl.limitName, 'Zeta')
  assert.equal(rl.planType, 'plus')
  assert.deepEqual(rl.primary, { usedPercent: 3, windowMinutes: 300, resetsAt: 1773140000 * 1000 })
  assert.equal(rl.secondary, null)
  assert.deepEqual(rl.credits, { hasCredits: false, unlimited: false, balance: null })
  assert.equal(rl.limitReached, true)

  // null / absent: the line still counts, the last reading survives.
  const n = feed(agg, cur, [
    codexTokenCount({ ts: T0 + 2000, total: { input: 20, total: 20 }, last: { input: 10, total: 10 }, rateLimits: null }),
    codexTokenCount({ ts: T0 + 3000, total: { input: 30, total: 30 }, last: { input: 10, total: 10 }, rateLimits: 'absent' }),
  ])
  assert.equal(n, 2)
  assert.equal(cur.lastRateLimits!.t, T0 + 1000)

  // Unusable numbers are dropped, not clamped; a missing id gets the account-wide key.
  const bad = parseCodexRateLimits({
    primary: { used_percent: Number.NaN, window_minutes: 300 },
    secondary: { used_percent: -4 },
    credits: { has_credits: true, unlimited: true, balance: 3 },
  }, 5)
  assert.ok(bad)
  assert.equal(bad!.limitId, 'codex')
  assert.equal(bad!.primary, null)
  assert.equal(bad!.secondary, null)
  assert.deepEqual(bad!.credits, { hasCredits: true, unlimited: true, balance: '3' })
  assert.equal(parseCodexRateLimits(null, 5), null)
  assert.equal(parseCodexRateLimits('x', 5), null)
  // Milliseconds are recognised and kept as they are.
  const ms = parseCodexRateLimits({ primary: { used_percent: 1, resets_at: 1773140000123 } }, 5)
  assert.equal(ms!.primary!.resetsAt, 1773140000123)
})

test('codexRateLimits(): newest per limit id across all files', () => {
  const agg = new Aggregator()
  const fileB = path.join(CODEX_ROOT, '2026', '03', '11', 'rollout-2026-03-11T09-00-00-thread-0009.jsonl')
  const curA = cursor()
  const curB = cursor()
  agg.cursors.set(CODEX_FILE, curA)
  agg.cursors.set(fileB, curB)
  feed(agg, curA, [
    codexTokenCount({ ts: T0 + 5000, total: { input: 1, total: 1 }, rateLimits: snakeRateLimits({ primary: { used_percent: 50, window_minutes: 300, resets_at: 1 } }) }),
  ])
  feed(agg, curB, [
    codexTokenCount({ ts: T0 + 1000, total: { input: 1, total: 1 }, rateLimits: snakeRateLimits({ primary: { used_percent: 10, window_minutes: 300, resets_at: 1 } }) }),
    codexTokenCount({ ts: T0 + 2000, total: { input: 2, total: 2 }, rateLimits: camelRateLimits(), camel: true }),
  ], ctxFor({ file: fileB }))
  const out = agg.codexRateLimits()
  assert.deepEqual(out.map((s) => s.limitId), ['codex', 'codex_zeta'])
  assert.equal(out[0].primary!.usedPercent, 50)
  assert.equal(out[0].t, T0 + 5000)
  assert.equal(out[1].t, T0 + 2000)
  // Survives a snapshot round trip through the cursor.
  const back = Aggregator.fromSnapshot(JSON.parse(JSON.stringify(agg.toSnapshot())))
  assert.equal(back.codexRateLimits().length, 2)
})

test('attribution: session id and project from session_meta, hashed on request, cwd never stored', () => {
  const agg = new Aggregator()
  const cur = cursor()
  agg.cursors.set(CODEX_FILE, cur)
  const ctx = ctxFor({ file: CODEX_FILE, attribution: 'session', projectSalt: 's' })
  feed(agg, cur, [
    codexMeta({ ts: T0, id: 'thread-0001', cwd: '/home/tester/proj-beta' }),
    codexTurnContext(T0, 'gpt-5.4'),
    codexTokenCount({ ts: T0 + 1000, total: { input: 80, cached: 20, output: 20, reasoning: 5, total: 100 } }),
    codexTokenCount({ ts: T0 + 31_000, total: { input: 160, cached: 40, output: 40, reasoning: 9, total: 200 }, last: { input: 80, cached: 20, output: 20, reasoning: 4, total: 100 } }),
  ], ctx)
  const rec = agg.sessions()[0]
  assert.equal(rec.source, 'codex')
  assert.equal(rec.sessionId, 'thread-0001')
  assert.equal(rec.project, 'proj-beta')
  assert.match(rec.projectHash, /^[0-9a-f]{12}$/)
  assert.equal(rec.isSub, false)
  assert.equal(rec.parent, null)
  assert.equal(rec.firstTs, T0)
  assert.equal(rec.lastTs, T0 + 31_000)
  assert.deepEqual(rec.models, ['gpt-5.4'])
  assert.equal(rec.input, 160)
  assert.equal(rec.cacheRead, 40)
  assert.equal(rec.output, 40)
  assert.equal(rec.reasoning, 9)
  assert.equal(rec.requests, 2)
  assert.equal(rec.outputFinal, 2)
  assert.deepEqual(rec.turnGapsMs, [1000, 30_000])
  assert.equal(rec.lastCacheTtl, null)
  assert.equal(cur.sessionId, 'thread-0001')
  assert.equal(cur.project, 'proj-beta')
  assert.equal(JSON.stringify(agg.toSnapshot()).includes('/home/tester/proj-beta'), false)

  const forked = new Aggregator()
  const cur2 = cursor()
  feed(forked, cur2, [
    codexMeta({ ts: T0, id: 'thread-0002', forkedFrom: 'thread-0001' }),
    codexTaskStarted(T0 + 10),
    codexTokenCount({ ts: T0 + 1000, total: { input: 5, total: 5 } }),
  ], ctxFor({ file: CODEX_FILE, attribution: 'project', hashProjects: true }))
  const f = forked.sessions()[0]
  assert.equal(f.isSub, true)
  assert.equal(f.parent, 'thread-0001')
  assert.equal(f.project, f.projectHash)

  // Without session_meta the file name is the id and its directory the label.
  const bare = new Aggregator()
  feed(bare, cursor(), [
    codexTurnContext(T0, 'gpt-5.4'),
    codexTokenCount({ ts: T0 + 1000, total: { input: 5, total: 5 } }),
  ], ctxFor({ file: CODEX_FILE, attribution: 'session' }))
  assert.equal(bare.sessions()[0].sessionId, 'rollout-2026-03-10T09-00-00-thread-0001')
  assert.equal(bare.sessions()[0].project, '10')

  // Attribution off: session_meta leaves no trace.
  const off = new Aggregator()
  const cur3 = cursor()
  feed(off, cur3, [codexMeta({ ts: T0 }), codexTokenCount({ ts: T0 + 1000, total: { input: 5, total: 5 } })])
  assert.equal(off.sessions().length, 0)
  assert.equal(cur3.sessionId, undefined)
})

test('malformed and irrelevant lines return false without touching the cursor state', () => {
  const agg = new Aggregator()
  const cur = cursor()
  assert.equal(agg.addCodexLine('not json', cur, CTX), false)
  assert.equal(agg.addCodexLine('{"type":"event_msg"}', cur, CTX), false)
  assert.equal(agg.addCodexLine('{"type":"event_msg","payload":{"type":"token_count"}}', cur, CTX), false)
  assert.equal(agg.addCodexLine('{"type":"event_msg","payload":{"type":"token_count","info":{}}}', cur, CTX), false)
  assert.equal(agg.addCodexLine('{"type":"response_item","payload":{"type":"message"}}', cur, CTX), false)
  assert.equal(cur.lastTotal, undefined)
  assert.equal(agg.all().length, 0)
})

// ---------------------------------------------------------------------------
// 1.8 §0a.3 (A6): the newest counted turn of a non-forked rollout, for the Codex prompt-cache line
// ---------------------------------------------------------------------------

const CODEX_B = path.join(path.dirname(CODEX_FILE), 'rollout-2026-03-10T10-00-00-thread-0009.jsonl')

test('codexLastTurn: the newest counted turn of a rollout of its own — its event\'s time and the turn\'s model (1.8 §0a.3)', () => {
  const agg = new Aggregator()
  assert.equal(agg.codexLastTurn(), null, 'no turn, no value')
  feed(agg, cursor(), [
    codexMeta({ ts: T0 }),
    codexTurnContext(T0, 'gpt-5.6-sol'),
    codexTaskStarted(T0 + 10),
    codexTokenCount({ ts: T0 + 60_000, total: { input: 800, cached: 600, output: 40, total: 840 } }),
  ])
  assert.deepEqual(agg.codexLastTurn(), { at: T0 + 60_000, model: 'gpt-5.6-sol' })
  // A later turn moves it; a repeated total is no counted turn, and moves nothing.
  const cur = cursor()
  feed(agg, cur, [
    codexMeta({ ts: T0, id: 'thread-0001' }),
    codexTurnContext(T0, 'gpt-5.6-sol'),
    codexTokenCount({ ts: T0 + 70_000, total: { input: 800, output: 40, total: 840 } }),
    codexTokenCount({ ts: T0 + 90_000, total: { input: 800, output: 40, total: 840 } }),
  ])
  assert.deepEqual(agg.codexLastTurn(), { at: T0 + 70_000, model: 'gpt-5.6-sol' }, 'the duplicate at +90 s counted as a turn')
  // The newest turn wins, whichever rollout is read first; a model change is the turn's own.
  const older = cursor()
  feed(agg, older, [
    codexMeta({ ts: T0 - 3_600_000, id: 'thread-0009' }),
    codexTurnContext(T0 - 3_600_000, 'gpt-6-astra'),
    codexTokenCount({ ts: T0 - 3_000_000, total: { input: 10, output: 1, total: 11 } }),
  ], ctxFor({ file: CODEX_B }))
  assert.deepEqual(agg.codexLastTurn(), { at: T0 + 70_000, model: 'gpt-5.6-sol' }, 'an older rollout read later replaced the newest turn')
  feed(agg, older, [codexTurnContext(T0 + 100_000, 'gpt-6-astra'), codexTokenCount({ ts: T0 + 120_000, total: { input: 20, output: 2, total: 22 } })], ctxFor({ file: CODEX_B }))
  assert.deepEqual(agg.codexLastTurn(), { at: T0 + 120_000, model: 'gpt-6-astra' })
  // What it hands out is a copy.
  agg.codexLastTurn()!.model = 'changed'
  assert.equal(agg.codexLastTurn()?.model, 'gpt-6-astra')
})

test('codexLastTurn: a forked rollout\'s turns, its replayed prefix and a subagent\'s thread never move it (1.8 §0a.3)', () => {
  const agg = new Aggregator()
  feed(agg, cursor(), [
    codexMeta({ ts: T0 }), codexTurnContext(T0, 'gpt-5.6-luna'), codexTaskStarted(T0 + 1),
    codexTokenCount({ ts: T0 + 1000, total: { input: 50, output: 5, total: 55 } }),
  ])
  const own = agg.codexLastTurn()
  assert.deepEqual(own, { at: T0 + 1000, model: 'gpt-5.6-luna' })
  // A fork: its copied history (the prefix, re-stamped at the fork) and its own turns after the marker.
  const n = feed(agg, cursor(), [
    codexMeta({ ts: T0 + 600_000, id: 'thread-0002', forkedFrom: 'thread-0001' }),
    codexTurnContext(T0 + 600_000, 'gpt-5.6-sol'),
    codexTokenCount({ ts: T0 + 600_100, total: { input: 3000, output: 1000, total: 4000 } }),
    codexTaskStarted(T0 + 600_800),
    codexTokenCount({ ts: T0 + 690_000, total: { input: 3200, output: 1100, total: 4300 }, last: { input: 200, output: 100, total: 300 } }),
  ], ctxFor({ file: CODEX_B }))
  assert.equal(n, 1, 'the fork\'s own turn is counted')
  assert.deepEqual(agg.codexLastTurn(), own, 'a forked rollout moved the newest turn')
  // A subagent's thread is a fork as well.
  feed(agg, cursor(), [
    codexMeta({ ts: T0 + 700_000, id: 'thread-0003', threadSource: 'subagent' }), codexTurnContext(T0 + 700_000, 'gpt-5.6-sol'),
    codexTaskStarted(T0 + 700_050), codexTokenCount({ ts: T0 + 700_900, total: { input: 120, output: 30, total: 150 } }),
  ], ctxFor({ file: CODEX_B.replace('0009', '0010') }))
  assert.deepEqual(agg.codexLastTurn(), own, 'a subagent\'s thread moved the newest turn')
})

test('codexLastTurn: a turn without its own time or without a model of the alphabet keeps nothing; the value survives a snapshot, checked again (1.8 §0a.3)', () => {
  const agg = new Aggregator()
  // No turn_context yet: the bucket says 'unknown', the newest turn keeps nothing.
  feed(agg, cursor(), [codexMeta({ ts: T0 }), codexTokenCount({ ts: T0 + 1000, total: { input: 5, output: 1, total: 6 } })])
  assert.equal(agg.all()[0].model, 'unknown')
  assert.equal(agg.codexLastTurn(), null)
  for (const model of ['gpt 5.6', 'g'.repeat(65), 'gpt-5.6<b>']) {
    const a = new Aggregator()
    feed(a, cursor(), [codexMeta({ ts: T0 }), codexTurnContext(T0, model), codexTokenCount({ ts: T0 + 1000, total: { input: 5, output: 1, total: 6 } })])
    assert.equal(a.all()[0].requests, 1, 'the turn is counted')
    assert.equal(a.codexLastTurn(), null, `a model ${JSON.stringify(model)} was kept`)
  }
  // A token_count without a timestamp is counted (at the time it is read, as always) but is the newest of nothing.
  const timeless = new Aggregator()
  const raw = JSON.parse(codexTokenCount({ ts: T0 + 1000, total: { input: 5, output: 1, total: 6 } })) as Record<string, unknown>
  delete raw.timestamp
  feed(timeless, cursor(), [codexMeta({ ts: T0 }), codexTurnContext(T0, 'gpt-5.6-sol'), JSON.stringify(raw)])
  assert.equal(timeless.all()[0].requests, 1)
  assert.equal(timeless.codexLastTurn(), null)

  const live = new Aggregator()
  feed(live, cursor(), [codexMeta({ ts: T0 }), codexTurnContext(T0, 'gpt-5.6-sol'), codexTokenCount({ ts: T0 + 1000, total: { input: 5, output: 1, total: 6 } })])
  const snap = JSON.parse(JSON.stringify(live.toSnapshot())) as Snapshot
  assert.deepEqual(snap.codexLast, { at: T0 + 1000, model: 'gpt-5.6-sol' })
  assert.deepEqual(Aggregator.fromSnapshot(snap).codexLastTurn(), { at: T0 + 1000, model: 'gpt-5.6-sol' })
  // A snapshot is a file anyone can edit: restored by shape, or not at all.
  for (const bad of [
    { at: T0, model: 'gpt 5.6' }, { at: T0, model: 'g'.repeat(65) }, { at: T0, model: 42 }, { at: 0, model: 'gpt-5.6-sol' },
    { at: String(T0), model: 'gpt-5.6-sol' }, { model: 'gpt-5.6-sol' }, 'gpt-5.6-sol', null,
  ]) {
    assert.equal(Aggregator.fromSnapshot({ ...snap, codexLast: bad as Snapshot['codexLast'] }).codexLastTurn(), null, JSON.stringify(bad))
  }
  // A snapshot written before 1.8 has none.
  const old = { ...snap }
  delete old.codexLast
  assert.equal(Aggregator.fromSnapshot(old).codexLastTurn(), null)
  // A 64-character model is still one.
  const long = 'g'.repeat(64)
  assert.equal(Aggregator.fromSnapshot({ ...snap, codexLast: { at: T0, model: long } }).codexLastTurn()?.model, long)
})
