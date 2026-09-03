// SPDX-FileCopyrightText: 2026 Frederik Marx
// SPDX-License-Identifier: AGPL-3.0-or-later

import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { Aggregator } from '../src/agg'
import { addDays, dayOf, dayOfHour, daysBetween, hourIndex, TimeConfig } from '../src/time'
import { Bucket } from '../src/types'
import { claudeLine, ctxFor } from './fixtures/helpers'

const utc: TimeConfig = { zone: 'utc', dayBoundaryHour: 0, startOfWeek: 'monday', hourCycle: 'h23' }
const berlin: TimeConfig = { ...utc, zone: 'Europe/Berlin' }
const CTX = ctxFor()
const DAY = 86_400_000
/** 2026-09-03 12:00 UTC. */
const NOW = Date.UTC(2026, 8, 3, 12, 0)

const COUNTERS: Array<keyof Bucket> = [
  'input', 'cacheWrite', 'cacheWrite1h', 'cacheRead', 'output', 'reasoning', 'requests', 'outputFinal', 'webSearch', 'webFetch',
]

function totals(buckets: Bucket[]): Record<string, number> {
  const out: Record<string, number> = {}
  for (const k of COUNTERS) out[k] = buckets.reduce((s, b) => s + (b[k] as number), 0)
  return out
}

let seq = 0
function add(agg: Aggregator, ts: number, model = 'claude-opus-4-6', output = 10): string {
  const id = `msg_${++seq}`
  agg.addClaudeLine(claudeLine({
    id, ts, model,
    usage: { input: 100, cacheWrite: 40, cacheWrite1h: 15, cacheRead: 900, output, thinking: 3, webSearch: 1 },
    final: true,
  }), CTX)
  return id
}

test('rollup folds old hours into days and old days into months, sums preserved, idempotent', () => {
  const agg = new Aggregator()
  add(agg, NOW - 3_600_000)               // recent → stays an hour bucket
  add(agg, NOW - 50 * DAY)                // → day bucket
  add(agg, NOW - 50 * DAY + 3_600_000)    // same day, other hour → same day bucket
  add(agg, NOW - 60 * DAY, 'claude-sonnet-4-6')
  add(agg, NOW - 500 * DAY)               // → month bucket
  const before = totals(agg.all())
  assert.equal(agg.all().length, 5)

  const r = agg.rollup(NOW, 45, 400, utc)
  assert.deepEqual(r, { hoursMerged: 4, daysMerged: 1 })
  const after = agg.all()
  assert.deepEqual(totals(after), before)
  assert.deepEqual(after.map((b) => b.res).sort(), ['d', 'd', 'h', 'm'])
  const st = agg.stats()
  assert.equal(st.hourBuckets, 1)
  assert.equal(st.dayBuckets, 2)
  assert.equal(st.monthBuckets, 1)

  const day = after.find((b) => b.res === 'd' && b.model === 'claude-opus-4-6')!
  assert.equal(day.hour, null)
  assert.equal(day.day, dayOf(NOW - 50 * DAY, utc))
  assert.equal(day.requests, 2)
  const month = after.find((b) => b.res === 'm')!
  assert.equal(month.day, dayOf(NOW - 500 * DAY, utc).slice(0, 7))
  assert.equal(st.oldestDay, `${month.day}-01`)

  // A second run changes nothing.
  assert.deepEqual(agg.rollup(NOW, 45, 400, utc), { hoursMerged: 0, daysMerged: 0 })
  assert.deepEqual(totals(agg.all()), before)
  const snap = agg.toSnapshot()
  assert.deepEqual(snap.rollup, { lastRun: NOW, hourRetentionDays: 45, retentionDays: 400 })
  // Restored state carries the horizon along.
  const back = Aggregator.fromSnapshot(JSON.parse(JSON.stringify(snap)))
  assert.deepEqual(back.rollup(NOW, 45, 400, utc), { hoursMerged: 0, daysMerged: 0 })
})

test('rollup with a zone: the day bucket is named by the configured calendar', () => {
  const agg = new Aggregator()
  const ts = Date.UTC(2026, 0, 1, 23, 30) // 2026-01-02 00:30 in Berlin
  add(agg, ts)
  agg.rollup(NOW, 45, 400, berlin)
  const b = agg.all()[0]
  assert.equal(b.res, 'd')
  assert.equal(b.day, '2026-01-02')
  // Once folded, the day string is final — a UTC query still finds it on the Berlin day.
  assert.equal(agg.sum('2026-01-02', '2026-01-02', utc).input, 100)
  assert.equal(agg.sum('2026-01-01', '2026-01-01', utc).input, 0)
})

test('a late Claude line for a message whose hour was rolled up lands in the day bucket', () => {
  const agg = new Aggregator()
  const ts = NOW - 50 * DAY
  const id = add(agg, ts)
  add(agg, NOW - 1000)
  assert.deepEqual(agg.rollup(NOW, 45, 400, utc), { hoursMerged: 1, daysMerged: 0 })
  const dayKey = dayOfHour(hourIndex(ts), utc)

  const late = claudeLine({
    id, ts: ts + 2000,
    usage: { input: 100, cacheWrite: 40, cacheWrite1h: 15, cacheRead: 900, output: 25, thinking: 3, webSearch: 1 },
    final: true,
  })
  assert.equal(agg.addClaudeLine(late, CTX), true)
  const all = agg.all()
  assert.equal(all.length, 2, 'no hour bucket was resurrected')
  const d = all.find((b) => b.res === 'd')!
  assert.equal(d.day, dayKey)
  assert.equal(d.output, 25)
  assert.equal(d.requests, 1)
  assert.equal(all.find((b) => b.res === 'h')!.output, 10)
  // And a further roll-up has nothing new to fold.
  assert.deepEqual(agg.rollup(NOW, 45, 400, utc), { hoursMerged: 0, daysMerged: 0 })
})

test('a late line for a message beyond the day horizon lands in the month bucket', () => {
  const agg = new Aggregator()
  const ts = NOW - 10 * DAY
  const id = add(agg, ts)
  assert.deepEqual(agg.rollup(NOW, 1, 2, utc), { hoursMerged: 1, daysMerged: 1 })
  assert.equal(agg.all()[0].res, 'm')
  agg.addClaudeLine(claudeLine({
    id, ts: ts + 500,
    usage: { input: 100, cacheWrite: 40, cacheWrite1h: 15, cacheRead: 900, output: 70, thinking: 3, webSearch: 1 },
  }), CTX)
  const all = agg.all()
  assert.equal(all.length, 1)
  assert.equal(all[0].res, 'm')
  assert.equal(all[0].output, 70)
  assert.equal(all[0].day, dayOf(ts, utc).slice(0, 7))
})

test('a snapshot restored in a worker keeps addressing late lines the same way', () => {
  const agg = new Aggregator()
  const ts = NOW - 50 * DAY
  const id = add(agg, ts)
  agg.rollup(NOW, 45, 400, berlin)
  const worker = Aggregator.fromSnapshot(JSON.parse(JSON.stringify(agg.toSnapshot())))
  worker.timeConfig = berlin
  worker.addClaudeLine(claudeLine({ id, ts: ts + 500, usage: { input: 100, cacheWrite: 40, cacheWrite1h: 15, cacheRead: 900, output: 99, thinking: 3, webSearch: 1 } }), CTX)
  assert.equal(worker.all().length, 1)
  assert.equal(worker.all()[0].res, 'd')
  assert.equal(worker.all()[0].output, 99)
})

test('sum maps hour buckets to days in the configured zone and honours dayBoundaryHour', () => {
  const agg = new Aggregator()
  add(agg, Date.UTC(2026, 0, 1, 23, 30))
  assert.equal(agg.sum('2026-01-01', '2026-01-01', utc).input, 100)
  assert.equal(agg.sum('2026-01-02', '2026-01-02', utc).input, 0)
  assert.equal(agg.sum('2026-01-01', '2026-01-01', berlin).input, 0)
  assert.equal(agg.sum('2026-01-02', '2026-01-02', berlin).input, 100)

  const night = new Aggregator()
  add(night, Date.UTC(2026, 2, 10, 2, 0))
  assert.equal(night.sum('2026-03-10', '2026-03-10', utc).input, 100)
  assert.equal(night.sum('2026-03-09', '2026-03-09', { ...utc, dayBoundaryHour: 6 }).input, 100)
  assert.equal(night.sum('2026-03-10', '2026-03-10', { ...utc, dayBoundaryHour: 6 }).input, 0)

  // Every counter is summed, and the returned bucket names the filtered source.
  const s = agg.sum('2026-01-01', '2026-01-01', utc, { source: 'claude' })
  assert.equal(s.source, 'claude')
  assert.equal(s.cacheWrite1h, 15)
  assert.equal(s.reasoning, 3)
  assert.equal(s.webSearch, 1)
  assert.equal(s.outputFinal, 1)
  assert.equal(agg.sum('2026-01-01', '2026-01-01', utc, { source: 'codex' }).input, 0)
})

test('month buckets count only when the whole month lies inside the range', () => {
  const agg = new Aggregator()
  const inApril = Date.UTC(2025, 3, 15, 10, 0)
  add(agg, inApril)
  agg.rollup(NOW, 1, 2, utc)
  assert.equal(agg.all()[0].res, 'm')
  assert.equal(agg.all()[0].day, '2025-04')
  assert.equal(agg.sum('2025-04-01', '2025-04-30', utc).input, 100)
  assert.equal(agg.sum('2025-03-01', '2025-05-31', utc).input, 100)
  assert.equal(agg.sum('2025-04-02', '2025-04-30', utc).input, 0)
  assert.equal(agg.sum('2025-04-01', '2025-04-29', utc).input, 0)
  // In a series the month shows on its first day, nowhere else.
  const days = daysBetween('2025-03-31', '2025-05-01')
  const s = agg.series(days, utc)
  assert.equal(s[days.indexOf('2025-04-01')], 100 + 40 + 10)
  assert.equal(s.reduce((a, b) => a + b, 0), 150)
  assert.equal(agg.series(daysBetween('2025-04-02', '2025-04-30'), utc).reduce((a, b) => a + b, 0), 0)
})

test('series: metrics, zone placement and cost', () => {
  const agg = new Aggregator()
  const ts = Date.UTC(2026, 0, 1, 23, 30)
  add(agg, ts, 'claude-opus-4-6', 10)
  add(agg, ts + DAY, 'claude-opus-4-6', 30)
  const days = daysBetween('2026-01-01', '2026-01-03')
  assert.deepEqual(agg.series(days, utc), [150, 170, 0])
  assert.deepEqual(agg.series(days, berlin), [0, 150, 170])
  assert.deepEqual(agg.series(days, utc, undefined, 'output'), [10, 30, 0])
  assert.deepEqual(agg.series(days, utc, undefined, 'cacheRead'), [900, 900, 0])
  assert.deepEqual(agg.series(days, utc, undefined, 'requests'), [1, 1, 0])
  assert.deepEqual(agg.series(days, utc, undefined, 'reasoning'), [3, 3, 0])
  const cost = agg.series(days, utc, undefined, 'cost', {})
  assert.ok(cost[0] > 0 && cost[1] > cost[0] && cost[2] === 0)
  // Without a price the cost series stays at zero rather than guessing.
  const unknown = new Aggregator()
  add(unknown, ts, 'claude-zeta-9')
  assert.deepEqual(unknown.series(days, utc, undefined, 'cost', {}), [0, 0, 0])
  assert.deepEqual(agg.series([], utc), [])
})

test('sumHours: hour-rounded interval, only hour buckets, incomplete below the horizon', () => {
  const agg = new Aggregator()
  const h0 = Date.UTC(2026, 8, 1, 10, 0)
  add(agg, h0 + 600_000)          // 10:10
  add(agg, h0 + 3_600_000 + 60_000) // 11:01
  add(agg, h0 + 2 * 3_600_000)      // 12:00
  const a = agg.sumHours(h0, h0 + 2 * 3_600_000)
  assert.equal(a.bucket.requests, 2)
  assert.equal(a.complete, true)
  // Rounded outward: a start at 10:30 still takes the whole 10:00 hour.
  assert.equal(agg.sumHours(h0 + 1_800_000, h0 + 2 * 3_600_000).bucket.requests, 2)
  assert.equal(agg.sumHours(h0, h0 + 2 * 3_600_000 + 1).bucket.requests, 3)
  assert.equal(agg.sumHours(h0, h0).bucket.requests, 0)
  assert.equal(agg.sumHours(h0, h0, { source: 'codex' }).complete, true)

  const old = new Aggregator()
  add(old, NOW - 50 * DAY)
  add(old, NOW - 1000)
  old.rollup(NOW, 45, 400, utc)
  const r = old.sumHours(NOW - 51 * DAY, NOW)
  assert.equal(r.bucket.requests, 1, 'the folded hour is not counted')
  assert.equal(r.complete, false)
  assert.equal(old.sumHours(NOW - 40 * DAY, NOW).complete, true)
})

test('cost uses the bucket day in the configured zone and the first day of a month', () => {
  const agg = new Aggregator()
  add(agg, Date.UTC(2026, 0, 1, 23, 30))
  assert.ok(agg.cost('2026-01-02', '2026-01-02', berlin, {}).usd > 0)
  assert.equal(agg.cost('2026-01-02', '2026-01-02', utc, {}).usd, 0)
  agg.rollup(NOW, 1, 2, utc)
  assert.equal(agg.all()[0].res, 'm')
  const c = agg.cost('2026-01-01', '2026-01-31', utc, {})
  assert.ok(c.usd > 0)
  assert.deepEqual(c.unpricedModels, [])
  assert.equal(addDays('2026-01-31', 1), '2026-02-01')
})
