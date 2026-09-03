// SPDX-FileCopyrightText: 2026 Frederik Marx
// SPDX-License-Identifier: AGPL-3.0-or-later

import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import {
  effectivePace, PaceConfig, paceVerdict, SENSITIVITY_PRESETS, severityOf, sustainableRate,
  windowDisplay, windowElapsed,
} from '../src/pace'
import { QuotaWindow } from '../src/types'

const normal: PaceConfig = {
  sensitivity: 'normal', tolerancePoints: 5, minElapsedPercent: 3, levels: 'binary',
}
const graded: PaceConfig = { ...normal, levels: 'graded' }

function win(p: Partial<QuotaWindow>): QuotaWindow {
  return {
    id: 'session:300', kind: 'session', label: '5 h', shortLabel: '5h', model: null,
    percent: 0, resetsAt: null, windowMinutes: 300, limitReached: false, unlimited: false, ...p,
  }
}

test('the three sensitivity presets are the documented point bands', () => {
  assert.deepEqual(SENSITIVITY_PRESETS.relaxed, { tolerancePoints: 10, minElapsedPercent: 5 })
  assert.deepEqual(SENSITIVITY_PRESETS.normal, { tolerancePoints: 5, minElapsedPercent: 3 })
  assert.deepEqual(SENSITIVITY_PRESETS.strict, { tolerancePoints: 2, minElapsedPercent: 1 })
})

test('effectivePace: presets win over the raw numbers, custom frees them', () => {
  assert.deepEqual(effectivePace({ ...normal, sensitivity: 'relaxed', tolerancePoints: 99 }),
    { tolerancePoints: 10, minElapsedPercent: 5, levels: 'binary' })
  assert.deepEqual(effectivePace({ sensitivity: 'custom', tolerancePoints: 7, minElapsedPercent: 12, levels: 'graded' }),
    { tolerancePoints: 7, minElapsedPercent: 12, levels: 'graded' })
  // Nonsense in the settings falls back to the normal preset instead of colouring randomly.
  assert.deepEqual(effectivePace({ sensitivity: 'custom', tolerancePoints: NaN, minElapsedPercent: -3, levels: 'binary' }),
    { tolerancePoints: 5, minElapsedPercent: 3, levels: 'binary' })
})

test('windowElapsed needs both ends of the clock', () => {
  const now = 1_000_000_000_000
  assert.equal(windowElapsed(now + 150 * 60_000, 300, now), 50)
  assert.equal(windowElapsed(now, 300, now), 100)
  assert.equal(windowElapsed(now + 300 * 60_000, 300, now), 0)
  assert.equal(windowElapsed(null, 300, now), null)
  assert.equal(windowElapsed(now, null, now), null)
  // Beyond the ends it is clamped, never negative and never above 100.
  assert.equal(windowElapsed(now - 60 * 60_000, 300, now), 100)
})

test('paceVerdict: the tolerance band decides the colour, the number stays exact', () => {
  const v = paceVerdict(50, 40, normal)
  assert.equal(v.level, 'warn')
  assert.equal(v.points, 10)
  assert.equal(v.text, '10 points ahead of the clock')
  assert.equal(v.measuring, false)
  // Inside the band: no colour, but the figure is still reported honestly.
  const inBand = paceVerdict(42, 40, normal)
  assert.equal(inBand.level, 'ok')
  assert.equal(inBand.text, '2 points ahead of the clock')
  const one = paceVerdict(41, 40, normal)
  assert.equal(one.text, '1 point ahead of the clock')
  const onPace = paceVerdict(40.2, 40, normal)
  assert.equal(onPace.text, 'on pace')
  const reserve = paceVerdict(30, 40, normal)
  assert.equal(reserve.level, 'ok')
  assert.equal(reserve.points, -10)
  assert.equal(reserve.text, '10 points in reserve')
  assert.equal(severityOf(reserve), 'ok')
})

test('graded adds a second warning level beyond three times the tolerance', () => {
  assert.equal(paceVerdict(60, 40, graded).level, 'warn2')
  assert.equal(paceVerdict(60, 40, normal).level, 'warn')
  assert.equal(paceVerdict(55, 40, graded).level, 'warn')
})

test('minElapsedPercent suppresses the alarm right after a reset', () => {
  const v = paceVerdict(20, 1, normal)
  assert.equal(v.measuring, true)
  assert.equal(v.level, 'ok')
  assert.equal(v.text, 'measuring · window just reset')
  assert.equal(v.points, 19)
  // Above the threshold the same figure is judged.
  assert.equal(paceVerdict(20, 4, normal).level, 'warn')
  assert.equal(paceVerdict(20, 1, { ...normal, sensitivity: 'custom', minElapsedPercent: 0 }).measuring, false)
})

test('exhaustion outranks everything, including measuring', () => {
  assert.equal(paceVerdict(99.5, 1, normal).level, 'error')
  assert.equal(paceVerdict(99.5, 1, normal).text, 'exhausted')
  assert.equal(paceVerdict(99.5, null, normal).level, 'error')
  assert.equal(paceVerdict(120, 90, graded).level, 'error')
  assert.equal(paceVerdict(99.4, 99, normal).level, 'ok')
})

test('without a clock there is no pace at all — and no invented denominator', () => {
  const v = paceVerdict(50, null, normal)
  assert.equal(v.level, 'ok')
  assert.equal(v.points, null)
  assert.equal(v.ratio, null)
  assert.equal(v.text, 'no clock for this window')
  // elapsed 0 gives no ratio either: dividing by zero is not a judgement.
  const zero = paceVerdict(5, 0, { ...normal, sensitivity: 'custom', minElapsedPercent: 0 })
  assert.equal(zero.ratio, null)
  assert.equal(zero.points, 5)
  assert.equal(paceVerdict(NaN, 40, normal).text, 'no reading')
  assert.equal(paceVerdict(NaN, 40, normal).points, null)
})

test('ratio is used ÷ elapsed, the formula the setting description documents', () => {
  assert.equal(paceVerdict(50, 25, normal).ratio, 2)
  assert.equal(paceVerdict(25, 50, normal).ratio, 0.5)
})

test('sustainableRate: null once there is no time left to spread anything over', () => {
  const now = 1_000_000_000_000
  assert.deepEqual(sustainableRate(50, now + 5 * 3_600_000, now), { perHour: 10, perDay: 240 })
  assert.equal(sustainableRate(50, null, now), null)
  assert.equal(sustainableRate(50, now, now), null)
  assert.equal(sustainableRate(50, now - 1000, now), null)
  // Overflow has no sustainable rate at all: a clamped 0 pp/h would print as
  // "~0.0 points/h keeps it to the reset", and nothing keeps an overdrawn window to it.
  assert.equal(sustainableRate(120, now + 2 * 3_600_000, now), null)
  assert.equal(sustainableRate(100.5, now + 2 * 3_600_000, now), null)
  // Exactly empty is still a real answer: zero left, and zero is what may be spent.
  assert.deepEqual(sustainableRate(100, now + 2 * 3_600_000, now), { perHour: 0, perDay: 0 })
})

test('windowDisplay: unlimited and limitReached come before any percentage', () => {
  const now = 2_000_000_000_000
  assert.equal(windowDisplay(win({ unlimited: true, percent: 120 }), now, now), 'unlimited')
  assert.equal(windowDisplay(win({ limitReached: true, percent: 12 }), now, now), 'limitReached')
  assert.equal(windowDisplay(win({ percent: 101 }), now, now), 'overflow')
  assert.equal(windowDisplay(win({ percent: 100.5 }), now, now), 'exhausted')
  assert.equal(windowDisplay(win({ percent: 99.5 }), now, now), 'exhausted')
  assert.equal(windowDisplay(win({ percent: 99.4 }), now, now), 'normal')
})

test('windowDisplay: a passed reset with a stale reading is resetDue, never a made-up 0 %', () => {
  const now = 2_000_000_000_000
  const resetsAt = now - 60_000
  assert.equal(windowDisplay(win({ percent: 80, resetsAt }), resetsAt - 300_000, now), 'resetDue')
  // A reading taken after the reset is trusted, even when it is still high.
  assert.equal(windowDisplay(win({ percent: 80, resetsAt }), resetsAt + 1000, now), 'normal')
  // Unknown fetch time cannot be claimed to be newer than the reset.
  assert.equal(windowDisplay(win({ percent: 80, resetsAt }), null, now), 'resetDue')
  // A reset still in the future says nothing about staleness.
  assert.equal(windowDisplay(win({ percent: 80, resetsAt: now + 1000 }), null, now), 'normal')
})
