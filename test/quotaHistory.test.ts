// SPDX-FileCopyrightText: 2026 Frederik Marx
// SPDX-License-Identifier: AGPL-3.0-or-later

import * as assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { test } from 'node:test'
import {
  HISTORY_VERSION, QuotaHistory, THIN_OLD_SLOT_MS, THIN_RECENT_DAYS, THIN_RECENT_SLOT_MS, fingerprintFor,
} from '../src/quotaHistory'
import { QuotaOrigin, QuotaState, QuotaWindow } from '../src/types'
import { scratchFile } from './fixtures/helpers'

const FP = 'abcd1234'
const BASE = 1_700_000_000_000
const H = 3_600_000

function tmpFile(name: string): string {
  return scratchFile('qh', name)
}

function win(id: string, percent: number, resetsAt: number | null): QuotaWindow {
  return {
    id, kind: 'session', label: id, shortLabel: id, model: null, percent, resetsAt,
    windowMinutes: 300, limitReached: false, unlimited: false,
  }
}

function state(atMs: number | null, windows: QuotaWindow[], origin: QuotaOrigin = 'poll'): QuotaState {
  return {
    source: 'claude', ok: true, origin, fetchedAt: atMs === null ? null : atMs / 1000,
    planType: null, windows,
  }
}

test('write guard drops a repeated (w, t, f) and unchanged values', () => {
  const h = new QuotaHistory(tmpFile('h.json'), 30)
  h.load()
  assert.equal(h.add(state(BASE, [win('session:300', 10, BASE + 5 * H)]), FP, BASE), 1)
  // Same reading again: identical key.
  assert.equal(h.add(state(BASE, [win('session:300', 10, BASE + 5 * H)]), FP, BASE), 0)
  // New timestamp but the value did not move.
  assert.equal(h.add(state(BASE + H, [win('session:300', 10, BASE + 5 * H)]), FP, BASE + H), 0)
  // A different percent is a real change.
  assert.equal(h.add(state(BASE + 2 * H, [win('session:300', 11, BASE + 5 * H)]), FP, BASE + 2 * H), 1)
  // A different resetsAt is a real change too.
  assert.equal(h.add(state(BASE + 3 * H, [win('session:300', 11, BASE + 9 * H)]), FP, BASE + 3 * H), 1)
  assert.equal(h.samples('claude', 'session:300', FP).length, 3)
})

test('the first reading after a gap over six hours is kept even when unchanged', () => {
  const h = new QuotaHistory(tmpFile('h.json'), 30)
  h.load()
  h.add(state(BASE, [win('w', 42, null)]), FP, BASE)
  assert.equal(h.add(state(BASE + 5 * H, [win('w', 42, null)]), FP, BASE + 5 * H), 0)
  assert.equal(h.add(state(BASE + 12 * H, [win('w', 42, null)]), FP, BASE + 12 * H), 1)
  const list = h.samples('claude', 'w', FP)
  assert.deepEqual(list.map((s) => s.t), [BASE, BASE + 12 * H])
})

test('add ignores failed states, unknown origins and unusable numbers', () => {
  const h = new QuotaHistory(tmpFile('h.json'), 30)
  h.load()
  const bad: QuotaState = { source: 'claude', ok: false, origin: 'poll', fetchedAt: BASE / 1000, planType: null, windows: [win('w', 10, null)] }
  assert.equal(h.add(bad, FP, BASE), 0)
  const noOrigin: QuotaState = { source: 'claude', ok: true, fetchedAt: BASE / 1000, planType: null, windows: [win('w', 10, null)] }
  assert.equal(h.add(noOrigin, FP, BASE), 0)
  // No fetchedAt and not a push: there is no honest point on the time axis.
  assert.equal(h.add(state(null, [win('w', 10, null)], 'cache'), FP, BASE), 0)
  // A push has no timestamp of its own, so it is stamped on arrival.
  assert.equal(h.add(state(null, [win('w', 10, null)], 'push'), FP, BASE + H), 1)
  assert.equal(h.samples('claude', 'w', FP)[0].t, BASE + H)
  assert.equal(h.add(state(BASE + 2 * H, [win('w', Number.NaN, null)]), FP, BASE + 2 * H), 0)
  assert.equal(h.add(state(BASE + 3 * H, [win('w', -5, null)]), FP, BASE + 3 * H), 0)
  assert.equal(h.samples('claude', 'w', FP).length, 1)
})

test('samples are kept apart by source, window and fingerprint', () => {
  const h = new QuotaHistory(tmpFile('h.json'), 30)
  h.load()
  h.add(state(BASE, [win('a', 10, null), win('b', 20, null)]), FP, BASE)
  h.add({ ...state(BASE, [win('a', 90, null)]), source: 'codex' }, FP, BASE)
  h.add(state(BASE, [win('a', 55, null)]), 'ffff0000', BASE)
  assert.deepEqual(h.samples('claude', 'a', FP).map((s) => s.p), [10])
  assert.deepEqual(h.samples('claude', 'b', FP).map((s) => s.p), [20])
  assert.deepEqual(h.samples('codex', 'a', FP).map((s) => s.p), [90])
  assert.deepEqual(h.samples('claude', 'a', 'ffff0000').map((s) => s.p), [55])
  assert.equal(h.samples('claude', 'a', FP, BASE + 1).length, 0)
})

test('merge-on-save keeps the samples another window wrote meanwhile', () => {
  const file = tmpFile('h.json')
  const a = new QuotaHistory(file, 30)
  a.load()
  a.add(state(BASE, [win('w', 10, null)]), FP, BASE)
  a.save()

  const b = new QuotaHistory(file, 30)
  b.load()
  b.add(state(BASE + H, [win('w', 20, null)]), FP, BASE + H)
  b.save()

  // `a` never saw b's sample, and must not drop it when it writes its own.
  a.add(state(BASE + 2 * H, [win('w', 30, null)]), FP, BASE + 2 * H)
  a.save()

  const c = new QuotaHistory(file, 30)
  c.load()
  assert.deepEqual(c.samples('claude', 'w', FP).map((s) => s.p), [10, 20, 30])
  const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as { version: number; samples: unknown[] }
  assert.equal(raw.version, 1)
  assert.equal(raw.samples.length, 3)
  assert.equal(fs.readdirSync(path.dirname(file)).filter((f) => f.includes('.tmp-')).length, 0)
})

test('cycles split at reset markers and mark START, RESET, REBASE, complete and capped', () => {
  const h = new QuotaHistory(tmpFile('h.json'), 30)
  h.load()
  const r1 = BASE + 5 * H
  const r2 = BASE + 10 * H
  const r3 = BASE + 15 * H
  const add = (t: number, p: number, r: number | null) => h.add(state(t, [win('w', p, r)]), FP, t)
  add(BASE, 10, r1)
  add(BASE + H, 30, r1)
  add(BASE + 2 * H, 50, r1)
  add(BASE + 5 * H, 5, r2)
  add(BASE + 6 * H, 50, r2)   // 45 points in an hour is steep usage, not a re-basing
  add(BASE + 7 * H, 99.6, r2)
  add(BASE + 10 * H, 2, r3)
  add(BASE + 10.5 * H, 60, r3)
  add(BASE + 11 * H, 65, r3)

  const cycles = h.cycles('claude', 'w', FP)
  assert.equal(cycles.length, 3)

  assert.deepEqual(cycles[0].tags, ['START'])
  assert.equal(cycles[0].start, BASE)
  assert.equal(cycles[0].end, BASE + 2 * H)
  assert.equal(cycles[0].peak, 50)
  assert.equal(cycles[0].last, 50)
  assert.equal(cycles[0].complete, true)
  assert.equal(cycles[0].capped, false)
  assert.equal(cycles[0].fitStart, BASE)

  assert.deepEqual(cycles[1].tags, ['RESET'])
  assert.equal(cycles[1].capped, true)
  assert.equal(cycles[1].peakAt, BASE + 7 * H)
  assert.equal(cycles[1].complete, true)
  assert.equal(cycles[1].resetsAt, r2)

  // 58 points in half an hour is a limit re-basing: same cycle, new fit boundary.
  assert.deepEqual(cycles[2].tags, ['RESET', 'REBASE'])
  assert.equal(cycles[2].fitStart, BASE + 10.5 * H)
  assert.equal(cycles[2].end, null)
  assert.equal(cycles[2].complete, false, 'the running cycle is never complete')
})

test('a fall of five points without a new resetsAt starts a cycle as well', () => {
  const h = new QuotaHistory(tmpFile('h.json'), 30)
  h.load()
  const add = (t: number, p: number) => h.add(state(t, [win('w', p, null)]), FP, t)
  add(BASE, 10)
  add(BASE + H, 40)
  add(BASE + 2 * H, 70)
  add(BASE + 3 * H, 5)
  const cycles = h.cycles('claude', 'w', FP)
  assert.equal(cycles.length, 2)
  assert.deepEqual(cycles[1].tags, ['RESET'])
  assert.equal(cycles[0].complete, true)
  // Two readings are not enough to call a cycle complete.
  const short = new QuotaHistory(tmpFile('h.json'), 30)
  short.load()
  short.add(state(BASE, [win('w', 60, null)]), FP, BASE)
  short.add(state(BASE + H, [win('w', 70, null)]), FP, BASE + H)
  short.add(state(BASE + 2 * H, [win('w', 1, null)]), FP, BASE + 2 * H)
  assert.equal(short.cycles('claude', 'w', FP)[0].complete, false)
})

test('gaps lists the stretches without any reading', () => {
  const h = new QuotaHistory(tmpFile('h.json'), 30)
  h.load()
  h.add(state(BASE, [win('w', 10, null)]), FP, BASE)
  h.add(state(BASE + H, [win('w', 20, null)]), FP, BASE + H)
  h.add(state(BASE + 9 * H, [win('w', 30, null)]), FP, BASE + 9 * H)
  const list = h.samples('claude', 'w', FP)
  assert.deepEqual(h.gaps(list, 2 * H), [{ from: BASE + H, to: BASE + 9 * H }])
  assert.deepEqual(h.gaps(list, 10 * H), [])
})

test('prune honours retention and the hard sample cap', () => {
  const file = tmpFile('h.json')
  const h = new QuotaHistory(file, 1)
  h.load()
  const now = BASE + 10 * 24 * H
  h.add(state(now - 3 * 24 * H, [win('w', 10, null)]), FP, now)
  h.add(state(now - 2 * H, [win('w', 20, null)]), FP, now)
  h.prune(now)
  assert.equal(h.size().samples, 1)
  assert.equal(h.samples('claude', 'w', FP)[0].p, 20)

  const capped = new QuotaHistory(tmpFile('h.json'), 30, 2)
  capped.load()
  capped.add(state(BASE, [win('w', 10, null)]), FP, BASE)
  capped.add(state(BASE + H, [win('w', 20, null)]), FP, BASE + H)
  capped.add(state(BASE + 2 * H, [win('w', 30, null)]), FP, BASE + 2 * H)
  capped.prune(BASE + 3 * H)
  assert.deepEqual(capped.samples('claude', 'w', FP).map((s) => s.p), [20, 30])
})

test('a corrupt file is copied aside once and the history starts empty', () => {
  const file = tmpFile('h.json')
  fs.writeFileSync(file, '{ this is not json')
  const h = new QuotaHistory(file, 30)
  h.load()
  assert.equal(h.size().samples, 0)
  const copies = fs.readdirSync(path.dirname(file)).filter((f) => f.includes('.corrupt-'))
  assert.equal(copies.length, 1)
  // The next save replaces the broken file with a valid one.
  h.add(state(BASE, [win('w', 10, null)]), FP, BASE)
  h.save()
  const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as { version: number; samples: unknown[] }
  assert.equal(raw.samples.length, 1)
  assert.equal(fs.readdirSync(path.dirname(file)).filter((f) => f.includes('.corrupt-')).length, 1)
})

test('a file of an unknown schema version is not overwritten silently', () => {
  const file = tmpFile('h.json')
  fs.writeFileSync(file, JSON.stringify({ version: 99, samples: [{ s: 'claude', w: 'w', t: BASE, p: 5, r: null, o: 'poll', f: FP }] }))
  const h = new QuotaHistory(file, 30)
  h.load()
  assert.equal(h.size().samples, 0)
  assert.equal(fs.readdirSync(path.dirname(file)).filter((f) => f.includes('.corrupt-')).length, 1)
})

test('single unusable entries are skipped without declaring the file corrupt', () => {
  const file = tmpFile('h.json')
  fs.writeFileSync(file, JSON.stringify({
    version: 1,
    samples: [
      { s: 'claude', w: 'w', t: BASE, p: 5, r: null, o: 'poll', f: FP },
      { s: 'claude', w: 'w', t: BASE + H, p: Number.NaN, r: null, o: 'poll', f: FP },
      { s: 'martian', w: 'w', t: BASE + 2 * H, p: 5, r: null, o: 'poll', f: FP },
    ],
  }))
  const h = new QuotaHistory(file, 30)
  h.load()
  assert.equal(h.size().samples, 1)
  assert.equal(fs.readdirSync(path.dirname(file)).filter((f) => f.includes('.corrupt-')).length, 0)
})

test('size and clear report and drop the stored series', () => {
  const file = tmpFile('h.json')
  const h = new QuotaHistory(file, 30)
  h.load()
  h.add(state(BASE, [win('w', 10, null)]), FP, BASE)
  h.add(state(BASE + H, [win('w', 20, null)]), FP, BASE + H)
  h.save()
  const size = h.size()
  assert.equal(size.samples, 2)
  assert.equal(size.oldest, BASE)
  assert.ok(size.bytes > 0)
  h.clear()
  assert.equal(h.size().samples, 0)
  assert.equal(fs.existsSync(file), false)
})

test('fingerprintFor is stable, short and identity-bound', () => {
  const a = fingerprintFor('claude', 'max-20x')
  assert.equal(a, fingerprintFor('claude', 'max-20x'))
  assert.match(a, /^[0-9a-f]{8}$/)
  assert.notEqual(a, fingerprintFor('codex', 'max-20x'))
  assert.notEqual(a, fingerprintFor('claude', null))
  assert.equal(fingerprintFor('claude', null), fingerprintFor('claude', 'unknown'))
})

// ---------------------------------------------------------------------------
// Thinning — a write rule, not a file format
// ---------------------------------------------------------------------------

const MIN = 60_000
const DAY = 24 * H
/** A quarter-hour boundary near BASE, so "the same slot" in a test means what it says. */
const SLOT0 = Math.floor(BASE / THIN_RECENT_SLOT_MS) * THIN_RECENT_SLOT_MS

test('the thinning grid is the sparkline grid', () => {
  assert.equal(THIN_RECENT_SLOT_MS, 15 * MIN)
  assert.equal(THIN_RECENT_DAYS, 7)
  assert.equal(THIN_OLD_SLOT_MS, H)
})

test('ten readings in one quarter hour leave the newest and the anchors of the stretch', () => {
  const h = new QuotaHistory(tmpFile('h.json'), 30)
  h.load()
  for (let k = 0; k < 10; k++) {
    const t = SLOT0 + k * MIN
    assert.equal(h.add(state(t, [win('w', 10 + k, null)]), FP, t), 1, 'every changed reading is accepted')
  }
  const list = h.samples('claude', 'w', FP)
  // The first reading of the stream and the newest are anchors, and a stretch of three or more
  // readings keeps a third one so a cycle that had three readings still has them: `complete`
  // may not depend on how many quarter hours the cycle happened to span.
  assert.deepEqual(list.map((s) => s.p), [10, 11, 19])
  assert.equal(list[list.length - 1].t, SLOT0 + 9 * MIN)
  // The next slot gets its own sample; the previous one is untouched.
  h.add(state(SLOT0 + 16 * MIN, [win('w', 20, null)]), FP, SLOT0 + 16 * MIN)
  assert.deepEqual(h.samples('claude', 'w', FP).map((s) => s.p), [10, 11, 19, 20])
})

test('thinning keeps the last sample before a reset and the first one after it', () => {
  const h = new QuotaHistory(tmpFile('h.json'), 30)
  h.load()
  const r1 = SLOT0 + 5 * H
  const r2 = SLOT0 + 10 * H
  const add = (t: number, p: number, r: number | null) => h.add(state(t, [win('w', p, r)]), FP, t)
  for (let k = 0; k < 6; k++) add(SLOT0 + (1 + k) * MIN, 50 + k, r1)   // 55 is the last before the reset
  for (let k = 0; k < 6; k++) add(SLOT0 + (7 + k) * MIN, 2 + k, r2)    // 2 is the first after it, 7 the newest
  assert.deepEqual(h.samples('claude', 'w', FP).map((s) => [s.p, s.r]),
    [[50, r1], [51, r1], [55, r1], [2, r2], [3, r2], [7, r2]])
  const cycles = h.cycles('claude', 'w', FP)
  assert.equal(cycles.length, 2)
  assert.equal(cycles[0].end, SLOT0 + 6 * MIN)
  assert.equal(cycles[0].complete, true, 'six readings before the reset: complete, thinned or not')
  assert.equal(cycles[1].start, SLOT0 + 7 * MIN)
  assert.deepEqual(cycles[1].tags, ['RESET'])

  // An inferred reset — a fall of five points without a new resetsAt — anchors just the same.
  const g = new QuotaHistory(tmpFile('h.json'), 30)
  g.load()
  const addNull = (t: number, p: number) => g.add(state(t, [win('w', p, null)]), FP, t)
  addNull(SLOT0 + 1 * MIN, 70)
  addNull(SLOT0 + 2 * MIN, 72)
  addNull(SLOT0 + 3 * MIN, 3)
  addNull(SLOT0 + 4 * MIN, 6)
  assert.deepEqual(g.samples('claude', 'w', FP).map((s) => s.p), [70, 72, 3, 6])
  assert.equal(g.cycles('claude', 'w', FP).length, 2)
})

test('cycle statistics are the same before and after a prune, however dense the readings were', () => {
  // A dense version-1 file spanning the hourly and the quarter-hour regime: cycles of every
  // length down to two readings, one with a peak before its end, one with a re-basing step.
  const file = tmpFile('h.json')
  const now = SLOT0 + 20 * DAY
  const samples: Array<{ s: string; w: string; t: number; p: number; r: number | null; o: string; f: string }> = []
  const lengths = [300, 11, 7, 480, 45, 3, 600, 2, 25, 90, 5, 700, 13, 8]   // minutes per cycle
  let t = now - 12 * DAY
  for (const [i, len] of lengths.entries()) {
    const r = t + 5 * H
    let p = 1
    for (let m = 0; m < len; m++) {
      if (i === 4 && m === 30) p -= 3          // a dip: the peak lies before the end of the cycle
      else if (i === 6 && m === 200) p += 20   // a re-basing step inside the cycle
      else if (i === 4 && m > 30) p += 0.05
      else p += 0.4
      samples.push({ s: 'claude', w: 'w', t: t + m * MIN, p: Math.min(100, p), r, o: 'poll', f: FP })
    }
    t += len * MIN
  }
  fs.writeFileSync(file, JSON.stringify({ version: 1, samples }))
  const h = new QuotaHistory(file, 30)
  h.load()
  const before = h.cycles('claude', 'w', FP)
  assert.equal(before.length, lengths.length)
  assert.equal(before.filter((c) => c.complete).length, lengths.length - 2, 'every closed cycle with three readings')
  assert.equal(before[7].complete, false, 'two readings are not a complete cycle')
  assert.equal(before[4].peakAt, before[4].start + 29 * MIN, 'the peak lies before the dip')
  assert.deepEqual(before[6].tags, ['RESET', 'REBASE'])
  h.prune(now)
  assert.ok(h.size().samples < samples.length / 3, `${h.size().samples} of ${samples.length} kept`)
  assert.deepEqual(h.cycles('claude', 'w', FP), before)
})

test('thinning never invents a reset: a gradual fall across a slot stays one cycle', () => {
  const h = new QuotaHistory(tmpFile('h.json'), 30)
  h.load()
  const add = (t: number, p: number) => h.add(state(t, [win('w', p, null)]), FP, t)
  add(SLOT0 - 5 * MIN, 52)
  for (const [k, p] of [[1, 50], [2, 47], [3, 44], [4, 41]]) add(SLOT0 + k * MIN, p)
  // No consecutive pair fell five points, so no reset was ever seen — and the thinned series
  // must not show one either, whatever it had to keep for that.
  assert.equal(h.cycles('claude', 'w', FP).length, 1)
  const kept = h.samples('claude', 'w', FP)
  assert.equal(kept[kept.length - 1].p, 41, 'the newest reading is always kept')
  for (let i = 1; i < kept.length; i++) assert.ok(kept[i - 1].p - kept[i].p < 5)
})

test('prune thins samples older than seven days to one per hour and keeps the newest of each', () => {
  const h = new QuotaHistory(tmpFile('h.json'), 30)
  h.load()
  const now = SLOT0 + 20 * DAY
  const old = now - 10 * DAY
  const hourStart = Math.floor(old / H) * H
  // Three hours of readings every five minutes, starting on an hour boundary.
  for (let k = 0; k < 36; k++) {
    const t = hourStart + k * 5 * MIN
    h.add(state(t, [win('w', k, null)]), FP, now)
  }
  // Five readings every five minutes inside the last seven days: thinned to the quarter hour.
  for (let k = 0; k < 5; k++) {
    const t = now - 30 * MIN + k * 5 * MIN
    h.add(state(t, [win('w', 50 + k, null)]), FP, now)
  }
  assert.equal(h.samples('claude', 'w', FP).length, 36 + 2, 'add thins only the recent part; the old part waits for prune')
  h.prune(now)
  const kept = h.samples('claude', 'w', FP)
  const oldKept = kept.filter((s) => s.t < now - 7 * DAY)
  assert.deepEqual(oldKept.map((s) => s.p), [0, 1, 11, 23, 35],
    'the last reading of each hour, plus the anchors of the stream (its first two readings)')
  const recentKept = kept.filter((s) => s.t >= now - 7 * DAY)
  assert.equal(recentKept.length, 2, 'recent samples stay on the quarter-hour grid, not the hourly one')
  assert.equal(recentKept[recentKept.length - 1].p, 54)
})

test('retention and the hard cap still apply after thinning', () => {
  const h = new QuotaHistory(tmpFile('h.json'), 1)
  h.load()
  const now = SLOT0 + 10 * DAY
  h.add(state(now - 3 * DAY, [win('w', 10, null)]), FP, now)
  h.add(state(now - 2 * H, [win('w', 20, null)]), FP, now)
  h.prune(now)
  assert.deepEqual(h.samples('claude', 'w', FP).map((s) => s.p), [20])

  const capped = new QuotaHistory(tmpFile('h.json'), 30, 2)
  capped.load()
  for (let k = 0; k < 4; k++) capped.add(state(SLOT0 + k * H, [win('w', 10 * k, null)]), FP, SLOT0 + k * H)
  capped.prune(SLOT0 + 4 * H)
  assert.deepEqual(capped.samples('claude', 'w', FP).map((s) => s.p), [20, 30])
})

test('a dense version-1 file loads as it is and is thinned by the next prune', () => {
  const file = tmpFile('h.json')
  const samples = []
  for (let k = 0; k < 10; k++) samples.push({ s: 'claude', w: 'w', t: SLOT0 + k * MIN, p: k, r: null, o: 'poll', f: FP })
  fs.writeFileSync(file, JSON.stringify({ version: 1, samples }))
  const h = new QuotaHistory(file, 30)
  h.load()
  assert.equal(h.size().samples, 10, 'loading changes nothing — the schema is the same')
  h.prune(SLOT0 + H)
  assert.deepEqual(h.samples('claude', 'w', FP).map((s) => s.p), [0, 1, 9], 'the anchors and the newest')
  // The save merges the file back in — and must not let the file undo the prune.
  h.save()
  const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as { version: number; samples: unknown[] }
  assert.equal(raw.version, HISTORY_VERSION)
  assert.equal(raw.samples.length, 3)
  assert.equal(h.size().samples, 3)
})

test('a save after a prune keeps the retention the prune applied', () => {
  const file = tmpFile('h.json')
  const now = SLOT0 + 40 * DAY
  const a = new QuotaHistory(file, 30)
  a.load()
  a.add(state(now - 35 * DAY, [win('w', 10, null)]), FP, now)
  a.add(state(now - H, [win('w', 20, null)]), FP, now)
  a.save()
  assert.equal((JSON.parse(fs.readFileSync(file, 'utf8')) as { samples: unknown[] }).samples.length, 2,
    'before any prune a save keeps everything it merged')
  a.prune(now)
  a.save()
  const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as { samples: Array<{ p: number }> }
  assert.deepEqual(raw.samples.map((s) => s.p), [20])
})

test('seven windows for seven days at the quarter-hour cadence stay under 4 800 samples', () => {
  const h = new QuotaHistory(tmpFile('h.json'), 30)
  h.load()
  const windows = ['a', 'b', 'c', 'd', 'e', 'f', 'g']
  const from = SLOT0 - 7 * DAY
  let count = 0
  for (let t = from; t < SLOT0; t += THIN_RECENT_SLOT_MS) {
    count++
    // Every window moves every reading, so nothing is dropped by the value guard alone.
    h.add(state(t, windows.map((w, i) => win(w, (count + i) % 100, null))), FP, t)
  }
  assert.equal(count, 7 * 96)
  assert.ok(h.size().samples <= 4_800, `${h.size().samples} samples`)
  assert.ok(h.size().samples >= windows.length * (7 * 96 - 1), 'nothing beyond the grid was thinned away')
})

test('a jittering or riding reset time neither splits a cycle nor escapes thinning', () => {
  // Claude Code's usage cache writes the reset time with sub-second jitter: every reading
  // once began a cycle of its own, and none of them could be thinned as a repeat.
  const h = new QuotaHistory(tmpFile('h.json'), 30)
  h.load()
  const r = BASE + 5 * H
  const jitter = [0, -114, 18, -34, 16, 0, -11, 5, -9, 84]
  for (const [k, j] of jitter.entries()) {
    h.add(state(BASE + k * 15 * 60_000, [win('w', 10 + Math.floor(k / 2), r + j)], 'cache'), FP, BASE + k * 15 * 60_000)
  }
  const cycles = h.cycles('claude', 'w', FP)
  assert.equal(cycles.length, 1)
  assert.equal(cycles[0].peak, 14)
  // Five values, each read twice: the repeats are thinned as repeats despite the jitter.
  assert.deepEqual(h.samples('claude', 'w', FP).map((s) => s.p), [10, 11, 12, 13, 14])
  // A real reset a whole window later still splits, whichever way the value went.
  h.add(state(BASE + 10 * 15 * 60_000, [win('w', 22, r + 5 * H)], 'cache'), FP, BASE + 10 * 15 * 60_000)
  assert.equal(h.cycles('claude', 'w', FP).length, 2)

  // An idle rolling window: the reset time rides along with the clock, and 0 % stays one
  // reading rather than one sample per poll.
  const g = new QuotaHistory(tmpFile('h.json'), 30)
  g.load()
  for (let k = 0; k < 20; k++) {
    const t = BASE + k * 122_000
    g.add(state(t, [win('w', 0, t + 5 * H)], 'cache'), FP, t)
  }
  assert.equal(g.samples('claude', 'w', FP).length, 1)
  assert.equal(g.cycles('claude', 'w', FP).length, 1)
})
