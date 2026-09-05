// SPDX-FileCopyrightText: 2026 Frederik Marx
// SPDX-License-Identifier: AGPL-3.0-or-later

import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { CYCLE_DROP_POINTS, RESET_JITTER_MS, resetMoved, turnedOver } from '../src/resetRule'
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
  // 0 % is what marks the turn. (A window that never reached five points leaves no mark;
  // there is nothing on it to judge either way.)
  const next = sample(T + 244_000 + 5 * H + 120_000, 0, T + 244_000 + 10 * H + 120_000)
  assert.equal(resetMoved(pinned, next), false)
  assert.equal(turnedOver(pinned, next), true)
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
