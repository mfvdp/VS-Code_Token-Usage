// SPDX-FileCopyrightText: 2026 Frederik Marx
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * 1.9 L-7 and L-8: the aggregator's memo of the day an hour bucket falls on, and the one options
 * object a cost series without pricing is priced with. The memo keeps the answers of one zone and one
 * day boundary and compares the two fields directly; every public door that places an hour — `sum`
 * and `cost` (through `inRange` and `costOfBucket`), `series` and `rollup` — is held to `dayOfHour`
 * without any memo, with the zone and the boundary changed between the calls. (`stats.ts`
 * `dayOfBucket`, the memo's twin, is held the same way in test/stats.test.ts.)
 */

import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { Aggregator } from '../src/agg'
import { PricingOptions, costOfBucket, resetPriceMemos } from '../src/prices'
import { TimeConfig, addDays, dayOfHour, resetTimeMemos } from '../src/time'
import { Bucket, STATE_VERSION, Snapshot, emptyBucket } from '../src/types'
import { buildViewModel } from '../src/viewModel'
import { buildAgg, makeConfig, makeInput, timeConfig } from './fixtures/viewFixtures'

const MS_HOUR = 3_600_000

/** The ten zones of 1.8 L-2's test: the system zone (UTC in the runner), and offsets of every kind — ±30 and ±45 minutes, a half-hour DST. */
const MEMO_ZONES = [
  'system', 'UTC', 'Europe/Berlin', 'America/New_York', 'Asia/Kathmandu', 'Australia/Lord_Howe', 'America/St_Johns',
  'Pacific/Chatham', 'Asia/Kolkata', 'America/Sao_Paulo',
] as const
/** Midnight, a late-night boundary and the last hour there is. */
const BOUNDARIES = [0, 4, 23] as const

function cfgOf(zone: string, dayBoundaryHour: number): TimeConfig {
  return { zone, dayBoundaryHour, startOfWeek: 'monday', hourCycle: 'h23' }
}

/** A small seeded generator (mulberry32), so every run draws the same hours. */
function seeded(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let x = Math.imul(a ^ (a >>> 15), 1 | a)
    x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x
    return ((x ^ (x >>> 14)) >>> 0) / 4_294_967_296
  }
}

/** `n` distinct hour indices of 2000–2099, in the order drawn. */
function randomHours(n: number, seed: number): number[] {
  const draw = seeded(seed)
  const from = Date.UTC(2000, 0, 1) / MS_HOUR
  const span = Date.UTC(2100, 0, 1) / MS_HOUR - from
  const seen = new Set<number>()
  const out: number[] = []
  while (out.length < n) {
    const h = from + Math.floor(draw() * span)
    if (seen.has(h)) continue
    seen.add(h)
    out.push(h)
  }
  return out
}

/**
 * Every configuration once: the first five zones zone by zone, each through the three boundaries, then
 * the other five boundary by boundary — consecutive steps change the boundary alone, the zone alone, or
 * both.
 */
function changingOrder(): TimeConfig[] {
  const out: TimeConfig[] = []
  for (const z of MEMO_ZONES.slice(0, 5)) for (const b of BOUNDARIES) out.push(cfgOf(z, b))
  for (const b of BOUNDARIES) for (const z of MEMO_ZONES.slice(5)) out.push(cfgOf(z, b))
  return out
}

/** The day of every hour in every configuration, from `dayOfHour` with the calendar-parts memo off too. */
function referenceDays(hours: readonly number[], cfgs: readonly TimeConfig[]): Map<TimeConfig, string[]> {
  const out = new Map<TimeConfig, string[]>()
  const byKey = new Map<string, string[]>()
  try {
    resetTimeMemos(false)
    for (const cfg of cfgs) {
      const k = `${cfg.zone}|${cfg.dayBoundaryHour}`
      let days = byKey.get(k)
      if (!days) byKey.set(k, days = hours.map((h) => dayOfHour(h, cfg)))
      out.set(cfg, days)
    }
  } finally {
    resetTimeMemos()
  }
  return out
}

/** One Claude hour bucket per hour, each with its own input (its index + 1), in a store read from a snapshot. */
function storeOf(hours: readonly number[]): { agg: Aggregator; buckets: Bucket[] } {
  const buckets = hours.map((h, i): Bucket => ({
    ...emptyBucket('claude', 'claude-opus-4-6', false, 'standard', 'h', h, dayOfHour(h, cfgOf('utc', 0))),
    input: i + 1, output: 2, requests: 1, outputFinal: 1,
  }))
  const snap: Snapshot = {
    version: STATE_VERSION, buckets, cursors: {}, pending: {}, sessions: {}, attribution: 'none',
    rollup: { lastRun: 0, hourRetentionDays: 0, retentionDays: 0 }, firstIngest: hours[0] * MS_HOUR,
  }
  return { agg: Aggregator.fromSnapshot(snap, 'none'), buckets }
}

/** Every day from just before 2000 to just after 2099 — the whole span an hour of the test can land on. */
function allDays(): string[] {
  const out: string[] = []
  for (let d = '1999-12-30'; d <= '2100-01-02'; d = addDays(d, 1)) out.push(d)
  return out
}

test('the aggregator places an hour as dayOfHour does: sum, cost, series and rollup over 5000 hours × ten zones × boundary hours 0, 4, 23, the zone and the boundary changed between calls (1.9 L-7)', () => {
  const hours = randomHours(5000, 0x1907)
  const order = changingOrder()
  // The order does what it is for: every setting once, and steps that change the boundary alone, the zone alone, and both.
  assert.equal(new Set(order.map((c) => `${c.zone}|${c.dayBoundaryHour}`)).size, MEMO_ZONES.length * BOUNDARIES.length)
  const steps = order.slice(1).map((c, k) => [c.zone !== order[k].zone, c.dayBoundaryHour !== order[k].dayBoundaryHour])
  assert.ok(steps.filter(([z, b]) => !z && b).length > 5 && steps.filter(([z, b]) => z && !b).length > 5 && steps.some(([z, b]) => z && b))
  const ref = referenceDays(hours, order)
  const days = allDays()
  const at = new Map(days.map((d, i) => [d, i]))
  const { agg, buckets } = storeOf(hours)
  const noPricing: PricingOptions = {}
  const draw = seeded(0x2907)
  let moved = 0
  order.forEach((cfg, k) => {
    const want = ref.get(cfg)!
    const what = `step ${k} (${cfg.zone}, boundary ${cfg.dayBoundaryHour})`
    // What the store should say, bucket by bucket in the store's own order (a cost is a sum of floats).
    const usage = new Array<number>(days.length).fill(0)
    const cost = new Array<number>(days.length).fill(0)
    const byDay = new Map<string, { input: number; usd: number }>()
    buckets.forEach((b, i) => {
      const d = want[i]
      const c = costOfBucket({ ...b, day: d }, noPricing)
      assert.ok(c && !c.unpriced)
      usage[at.get(d)!] += b.input + b.output
      cost[at.get(d)!] += c.usd
      const s = byDay.get(d) ?? { input: 0, usd: 0 }
      s.input += b.input
      s.usd += c.usd
      byDay.set(d, s)
    })
    // The days to ask sum and cost about: where a bucket went and where it came from since the step before —
    // the answers a memo that kept the old table would get wrong — and a few drawn at random.
    const ask = new Set<string>()
    if (k > 0) {
      const before = ref.get(order[k - 1])!
      const changed = want.flatMap((d, i) => (d !== before[i] ? [i] : []))
      moved += changed.length
      for (let n = 0; n < 12 && changed.length > 0; n++) {
        const i = changed[Math.floor(draw() * changed.length)]
        ask.add(want[i])
        ask.add(before[i])
      }
    }
    for (let n = 0; n < 4; n++) ask.add(want[Math.floor(draw() * want.length)])
    const checkSums = (): void => {
      for (const d of ask) {
        const s = byDay.get(d) ?? { input: 0, usd: 0 }
        assert.equal(agg.sum(d, d, cfg).input, s.input, `${what}: sum on ${d}`)
        assert.equal(agg.cost(d, d, cfg, noPricing).usd, s.usd, `${what}: cost on ${d}`)
      }
    }
    const checkSeries = (): void => {
      assert.deepEqual(agg.series(days, cfg), usage, `${what}: series`)
      assert.deepEqual(agg.series(days, cfg, undefined, 'cost'), cost, `${what}: cost series`)
    }
    // Each door in turn is the first to ask right after the change, and the others ask from the memo it filled.
    if (k % 2 === 0) { checkSeries(); checkSums() } else { checkSums(); checkSeries() }
  })
  assert.ok(moved > 5000, `only ${moved} buckets changed day over the whole order`)

  // The roll-up folds each hour into the day of the zone and boundary it is given — right after the store
  // answered a query in the step before, on a fresh store each time, so its memo holds the other table.
  // Every third step, and the one between the two halves: the boundary changed alone, the zone alone, and both.
  let rolled = 0
  order.forEach((cfg, k) => {
    if (k % 3 !== 1 && k !== 15) return
    const want = ref.get(cfg)!
    const store = storeOf(hours)
    store.agg.series(days, order[k - 1])
    const r = store.agg.rollup(Date.UTC(2100, 0, 2), 0, 100_000, cfg)
    assert.equal(r.hoursMerged, hours.length)
    assert.equal(r.daysMerged, 0)
    const expected = new Map<string, number>()
    store.buckets.forEach((b, i) => expected.set(want[i], (expected.get(want[i]) ?? 0) + b.input))
    const got = store.agg.all()
    assert.equal(got.length, expected.size, `rollup step ${k} (${cfg.zone}, boundary ${cfg.dayBoundaryHour}): day buckets`)
    for (const b of got) {
      assert.equal(b.res, 'd')
      assert.equal(b.input, expected.get(b.day), `rollup step ${k} (${cfg.zone}, boundary ${cfg.dayBoundaryHour}): ${b.day}`)
    }
    rolled++
  })
  assert.equal(rolled, 11)
})

test('the default world\'s view model is the same whichever zone and day boundary were built before it (1.9 L-7)', () => {
  // The aggregator's memo lives with the store and stats.ts's with the module: one store asked in one
  // setting after another — the zone changed alone, the boundary changed alone, both — gives each setting
  // the view model a fresh store gives it right after a setting that changes both fields.
  const settings: Array<[string, number]> = [
    ['utc', 0], ['Europe/Berlin', 0], ['Europe/Berlin', 4], ['America/New_York', 4], ['America/New_York', 23],
    ['utc', 23], ['utc', 0], ['Europe/Berlin', 4], ['Europe/Berlin', 0],
  ]
  const cfgOfSetting = ([zone, b]: [string, number]) => makeConfig({ 'tokenPace.timezone': zone, 'tokenPace.dayBoundaryHour': b })
  const fresh = new Map<string, ReturnType<typeof buildViewModel>>()
  for (const s of settings) {
    const key = s.join('|')
    if (fresh.has(key)) continue
    buildViewModel(makeInput({ cfg: cfgOfSetting(['Asia/Kathmandu', 12]) }))
    fresh.set(key, buildViewModel(makeInput({ cfg: cfgOfSetting(s) })))
  }
  const shared = buildAgg()
  const charts = new Set<string>()
  settings.forEach((s, k) => {
    const cfg = cfgOfSetting(s)
    assert.deepEqual([timeConfig(cfg).zone, timeConfig(cfg).dayBoundaryHour], s)
    const vm = buildViewModel(makeInput({ agg: shared, cfg }))
    assert.deepEqual(vm, fresh.get(s.join('|')), `step ${k}: ${s.join(', ')} after ${k > 0 ? settings[k - 1].join(', ') : 'nothing'}`)
    charts.add(JSON.stringify(vm.chart))
  })
  // The settings do move the days: the charts are not all one chart.
  assert.ok(charts.size > 1)
})

test('a cost series without pricing prices through one options object: one memo, the figures unchanged (1.9 L-8)', () => {
  const agg = buildAgg()
  const tcfg = timeConfig(makeConfig())
  const days: string[] = []
  for (let d = agg.stats().oldestDay ?? '2026-08-01'; d <= '2026-09-03'; d = addDays(d, 1)) days.push(d)
  assert.ok(days.length > 1)
  // What 1.8 computed — an empty options object of its own — and what the path without any memo computes.
  const own = agg.series(days, tcfg, undefined, 'cost', {})
  let plain: number[]
  try {
    resetPriceMemos(false)
    plain = agg.series(days, tcfg, undefined, 'cost')
  } finally {
    resetPriceMemos()
  }
  assert.ok(own.filter((v) => v > 0).length > 1, 'the default world prices fewer than two days')
  // `priceOf` keeps a memo per options object in a WeakMap, emptied by the reset above: the series' one
  // options object is set once, where a fresh {} per bucket would set one per bucket.
  const set = WeakMap.prototype.set
  let sets = 0
  let first: number[]
  let again: number[]
  try {
    WeakMap.prototype.set = function (this: WeakMap<object, unknown>, key: object, value: unknown) {
      sets++
      return set.call(this, key, value)
    }
    first = agg.series(days, tcfg, undefined, 'cost')
    assert.equal(sets, 1, 'the first cost series without pricing made more than one options memo')
    again = agg.series(days, tcfg, undefined, 'cost')
    assert.equal(sets, 1, 'a second cost series without pricing made an options memo of its own')
  } finally {
    WeakMap.prototype.set = set
  }
  assert.deepEqual(first, own)
  assert.deepEqual(again, own)
  assert.deepEqual(plain, own)
})
