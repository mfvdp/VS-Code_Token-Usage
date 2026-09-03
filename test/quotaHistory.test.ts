// SPDX-FileCopyrightText: 2026 Frederik Marx
// SPDX-License-Identifier: AGPL-3.0-or-later

import * as assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { test } from 'node:test'
import { QuotaHistory, fingerprintFor } from '../src/quotaHistory'
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
