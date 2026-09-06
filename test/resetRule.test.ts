// SPDX-FileCopyrightText: 2026 Frederik Marx
// SPDX-License-Identifier: AGPL-3.0-or-later

import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { CYCLE_DROP_POINTS, RESET_JITTER_MS, resetMoved, resetPassed, turnedOver } from '../src/resetRule'
import { QuotaSample } from '../src/types'

const T = 1_700_000_000_000
const H = 3_600_000
const sample = (t: number, p: number, r: number | null): QuotaSample =>
  ({ s: 'claude', w: 'w', t, p, r, o: 'cache', f: 'abcd1234' })

test('a reset time that only jitters is the same reset', () => {
  // The cache origin, as observed: ±0.1 s from one read to the next, ±1 s between origins.
  const r = T + 5 * H
  assert.equal(resetMoved(sample(T, 20, r), sample(T + 930_000, 25, r - 114)), false)
  assert.equal(resetMoved(sample(T, 20, r), sample(T + 930_000, 25, r + 1000)), false)
  assert.equal(resetMoved(sample(T, 20, r), sample(T + 930_000, 25, r + RESET_JITTER_MS)), false)
  assert.equal(resetMoved(sample(T, 20, r), sample(T + 930_000, 25, r)), false)
  // A whole window later is a reset, whichever way the value went.
  assert.equal(resetMoved(sample(T, 2, r), sample(T + 930_000, 22, r + 5 * H)), true)
  assert.equal(resetMoved(sample(T, 90, r), sample(T + 930_000, 3, r + 5 * H)), true)
  assert.equal(resetMoved(sample(T, 90, r), sample(T + 930_000, 3, r - 5 * H)), true)
})

test('an idle rolling window whose reset time rides along with the clock has not reset', () => {
  // Codex with nothing used reports "now + window length" on every read.
  const a = sample(T, 0, T + 5 * H)
  const b = sample(T + 122_000, 0, T + 122_000 + 5 * H + 1000)
  assert.equal(resetMoved(a, b), false)
  assert.equal(turnedOver(a, b), false)
  // Once a request pins the window, the clock stops riding — still not a reset.
  const pinned = sample(T + 244_000, 8, T + 244_000 + 5 * H)
  assert.equal(resetMoved(b, pinned), false)
  // When that window ends and the clock rides again, the reset time has moved by exactly the
  // time since the pin — the reset time alone cannot tell this from riding, and the fall to
  // 0 % is what marks the turn. (A window that never reached five points turns over by the
  // passed reset with the fall after it — the next test.)
  const next = sample(T + 244_000 + 5 * H + 120_000, 0, T + 244_000 + 10 * H + 120_000)
  assert.equal(resetMoved(pinned, next), false)
  assert.equal(turnedOver(pinned, next), true)
})

test('a pinned rolling window that ends under five points turns over on its own clock', () => {
  // Codex: a request pins the window (reset = pin + 5 h) and the reading stays at 4 %. When
  // the window ends the value drops to 0 and the reset time rides along with the clock again
  // — moved by exactly the time between the readings, so `resetMoved` is right not to count
  // it — and the fall is under CYCLE_DROP_POINTS. The passed reset with the fall after it is
  // the evidence, and without it the window ended and nothing recorded it.
  const pinned = sample(T, 4, T + 5 * H)
  const ended = sample(T + 5 * H + 120_000, 0, T + 10 * H + 120_000)
  assert.equal(resetMoved(pinned, ended), false)
  assert.equal(resetPassed(pinned, ended), true)
  assert.equal(turnedOver(pinned, ended), true)
  // Read an hour before the window ended, the same value has not turned over …
  const before = sample(T + 4 * H, 4, T + 5 * H)
  assert.equal(resetPassed(pinned, before), false)
  assert.equal(turnedOver(pinned, before), false)
  // … and neither has a reading after it that still announces the passed reset: that is a
  // stale view of the old window, and a small fall inside it is rounding, not a reset.
  const stale = sample(T + 5 * H + 120_000, 3.5, T + 5 * H)
  assert.equal(resetPassed(pinned, stale), false)
  assert.equal(turnedOver(pinned, stale), false)
  // A rise after the passed reset is no fall: a new window already in use, judged by the
  // usual rules — and a missing reset time on the later reading says nothing, as always.
  assert.equal(resetPassed(pinned, sample(T + 5 * H + 120_000, 6, T + 10 * H + 120_000)), false)
  assert.equal(resetPassed(pinned, sample(T + 5 * H + 120_000, 0, null)), false)
  assert.equal(turnedOver(pinned, sample(T + 5 * H + 120_000, 0, null)), false)
  // A reset the earlier reading itself was already past (a stale reading) is not "between".
  assert.equal(resetPassed(sample(T, 4, T - 60_000), sample(T + H, 0, T + 6 * H)), false)
})

test('an idle rolling window riding along with the clock is never flagged, however sparse the readings', () => {
  // r = t + 5 h on every read, 0 % throughout: the earlier reset passes between two readings
  // six hours apart, but nothing fell, so nothing turned over.
  const idle = [0, 2, 6, 30, 31].map((h) => sample(T + h * H, 0, T + h * H + 5 * H))
  for (let k = 1; k < idle.length; k++) {
    assert.equal(resetPassed(idle[k - 1], idle[k]), false, `reading ${k}`)
    assert.equal(turnedOver(idle[k - 1], idle[k]), false, `reading ${k}`)
  }
})

test('a missing reset time says nothing; a fall of five points is a reset on its own', () => {
  assert.equal(resetMoved(sample(T, 5, null), sample(T + H, 6, T + 5 * H)), false)
  assert.equal(resetMoved(sample(T, 5, T + 5 * H), sample(T + H, 6, null)), false)
  assert.equal(resetMoved(sample(T, 5, null), sample(T + H, 6, null)), false)
  assert.equal(turnedOver(sample(T, 20, null), sample(T + H, 15, null)), true)
  assert.equal(turnedOver(sample(T, 20, null), sample(T + H, 16, null)), false)
  assert.equal(CYCLE_DROP_POINTS, 5)
  // Same reset time, a fall of five: the provider did not announce it, the fall did.
  const r = T + 5 * H
  assert.equal(turnedOver(sample(T, 20, r), sample(T + H, 15, r)), true)
})
