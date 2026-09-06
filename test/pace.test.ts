// SPDX-FileCopyrightText: 2026 Frederik Marx
// SPDX-License-Identifier: AGPL-3.0-or-later

import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import {
  DEFAULT_PACE, MEASURING_CAP_POINTS, PaceConfig, effectivePace, gradedThreshold, paceVerdict,
  SENSITIVITY_PRESETS, severityOf, windowDisplay, windowElapsed,
} from '../src/pace'
import { QuotaWindow } from '../src/types'

const normal: PaceConfig = {
  sensitivity: 'normal', tolerancePoints: 0, minElapsedPercent: 3, levels: 'binary',
}
const graded: PaceConfig = { ...normal, levels: 'graded' }
/** Someone who asked for a band: five points of grace before the colour flips. */
const banded: PaceConfig = { ...normal, tolerancePoints: 5 }

function win(p: Partial<QuotaWindow>): QuotaWindow {
  return {
    id: 'session:300', kind: 'session', label: '5 h', shortLabel: '5h', model: null,
    percent: 0, resetsAt: null, windowMinutes: 300, limitReached: false, unlimited: false, ...p,
  }
}

test('the three sensitivity presets pick the elapsed share only; the band is one setting', () => {
  assert.deepEqual(SENSITIVITY_PRESETS.relaxed, { minElapsedPercent: 5 })
  assert.deepEqual(SENSITIVITY_PRESETS.normal, { minElapsedPercent: 3 })
  assert.deepEqual(SENSITIVITY_PRESETS.strict, { minElapsedPercent: 1 })
  // No band by default: a card that says "4 % ahead of pace" is yellow, not green.
  assert.deepEqual(DEFAULT_PACE,
    { sensitivity: 'normal', tolerancePoints: 0, minElapsedPercent: 3, levels: 'binary' })
  assert.equal(MEASURING_CAP_POINTS, 10)
})

test('effectivePace: presets pick the elapsed share, the band applies with every one of them', () => {
  assert.deepEqual(effectivePace({ ...normal, sensitivity: 'relaxed' }),
    { tolerancePoints: 0, minElapsedPercent: 5, levels: 'binary' })
  assert.deepEqual(effectivePace({ ...normal, sensitivity: 'strict' }),
    { tolerancePoints: 0, minElapsedPercent: 1, levels: 'binary' })
  // A band set beside a preset is honoured — it was custom-only once, and a band set with
  // 'normal' silently did nothing.
  assert.deepEqual(effectivePace({ ...normal, sensitivity: 'relaxed', tolerancePoints: 7 }),
    { tolerancePoints: 7, minElapsedPercent: 5, levels: 'binary' })
  assert.deepEqual(effectivePace({ sensitivity: 'custom', tolerancePoints: 7, minElapsedPercent: 12, levels: 'graded' }),
    { tolerancePoints: 7, minElapsedPercent: 12, levels: 'graded' })
  // Nonsense in the settings falls back to the defaults instead of colouring randomly.
  assert.deepEqual(effectivePace({ sensitivity: 'custom', tolerancePoints: NaN, minElapsedPercent: -3, levels: 'binary' }),
    { tolerancePoints: 0, minElapsedPercent: 3, levels: 'binary' })
  assert.deepEqual(effectivePace({ ...normal, tolerancePoints: -1 }),
    { tolerancePoints: 0, minElapsedPercent: 3, levels: 'binary' })
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

test('paceVerdict: ahead of pace is yellow at once, the number stays exact', () => {
  const v = paceVerdict(50, 40, normal)
  assert.equal(v.level, 'warn')
  assert.equal(v.points, 10)
  assert.equal(v.text, '10 % ahead of pace')
  assert.equal(v.measuring, false)
  // No band by default: the first whole point ahead colours the window, and the figure the
  // card prints is the one the colour follows.
  const two = paceVerdict(42, 40, normal)
  assert.equal(two.level, 'warn')
  assert.equal(two.text, '2 % ahead of pace')
  const one = paceVerdict(41, 40, normal)
  assert.equal(one.level, 'warn')
  assert.equal(one.text, '1 % ahead of pace')
  const onPace = paceVerdict(40.2, 40, normal)
  assert.equal(onPace.level, 'ok')
  assert.equal(onPace.text, 'on pace')
  const reserve = paceVerdict(30, 40, normal)
  assert.equal(reserve.level, 'ok')
  assert.equal(reserve.points, -10)
  assert.equal(reserve.text, '10 % of the window still spare')
  assert.equal(severityOf(reserve), 'ok')
})

test('the colour follows the printed figure: "0 % ahead" is never yellow, "1 % ahead" always is', () => {
  // 0.4 points ahead rounds to "on pace" and stays green …
  const under = paceVerdict(40.4, 40, normal)
  assert.equal(under.text, 'on pace')
  assert.equal(under.level, 'ok')
  // … 0.5 rounds to "1 % ahead of pace" and is yellow: the sentence and the colour never
  // contradict each other.
  const over = paceVerdict(40.5, 40, normal)
  assert.equal(over.text, '1 % ahead of pace')
  assert.equal(over.level, 'warn')
  // A band is taken off in the same whole percents: 5.4 ahead with a band of 5 prints
  // "5 % ahead" and stays green, 5.5 prints "6 % ahead" — one point over the band — and is
  // yellow.
  const inBand = paceVerdict(45.4, 40, banded)
  assert.equal(inBand.level, 'ok')
  assert.equal(inBand.text, '5 % ahead of pace')
  const outBand = paceVerdict(45.5, 40, banded)
  assert.equal(outBand.level, 'warn')
  assert.equal(outBand.text, '6 % ahead of pace')
  // The band applies beside a preset as well, not only with 'custom'.
  assert.equal(paceVerdict(45.4, 40, { ...banded, sensitivity: 'strict' }).level, 'ok')
  assert.equal(paceVerdict(45.5, 40, { ...banded, sensitivity: 'relaxed' }).level, 'warn')
})

test('a band typed with a decimal flips where the printed figure changes, not half a point off', () => {
  // 2.5 is settable (the setting is a plain number), and the card only ever prints whole
  // percents: every gap that prints "3 % ahead of pace" must wear the same colour.
  const half: PaceConfig = { ...normal, tolerancePoints: 2.5 }
  const low = paceVerdict(35.6, 33, half)
  assert.equal(low.text, '3 % ahead of pace')
  assert.equal(low.level, 'ok')
  const high = paceVerdict(36.4, 33, half)
  assert.equal(high.text, '3 % ahead of pace')
  assert.equal(high.level, 'ok')
  const over = paceVerdict(36.6, 33, half)
  assert.equal(over.text, '4 % ahead of pace')
  assert.equal(over.level, 'warn')
})

test('graded adds a second warning level from 15 points ahead, or three times a larger band', () => {
  assert.equal(gradedThreshold(0), 15)
  assert.equal(gradedThreshold(5), 15)
  assert.equal(gradedThreshold(7), 21)
  assert.equal(gradedThreshold(NaN), 15)
  assert.equal(paceVerdict(55, 40, graded).level, 'warn2')
  assert.equal(paceVerdict(60, 40, graded).level, 'warn2')
  assert.equal(paceVerdict(60, 40, normal).level, 'warn')
  // The same rounding as the first level: 14.4 ahead prints "14 %" and stays one level, 14.5
  // prints "15 %" and is the second.
  assert.equal(paceVerdict(54.4, 40, graded).level, 'warn')
  assert.equal(paceVerdict(54.5, 40, graded).level, 'warn2')
  // With a band of 7 the second level starts 21 points beyond the band.
  const wide: PaceConfig = { ...graded, tolerancePoints: 7 }
  assert.equal(paceVerdict(67, 40, wide).level, 'warn')
  assert.equal(paceVerdict(68, 40, wide).level, 'warn2')
})

test('minElapsedPercent suppresses the alarm right after a reset', () => {
  const v = paceVerdict(10, 1, normal)
  assert.equal(v.measuring, true)
  assert.equal(v.level, 'ok')
  assert.equal(v.text, 'measuring · window just reset')
  assert.equal(v.points, 9)
  // Above the threshold the same figure is judged.
  assert.equal(paceVerdict(10, 4, normal).level, 'warn')
  assert.equal(paceVerdict(10, 1, { ...normal, sensitivity: 'custom', minElapsedPercent: 0 }).measuring, false)
})

test('measuring needs a young window AND a small bill — the cap is ten points, whatever the band', () => {
  // The doubt is about the clock, not about the reading: 60 % of a window spent in its first
  // minutes is a fact no elapsed share can explain away, so it is judged like any other.
  const heavy = paceVerdict(60, 1, normal)
  assert.equal(heavy.measuring, false)
  assert.equal(heavy.level, 'warn')
  assert.equal(heavy.text, '59 % ahead of pace')
  assert.equal(paceVerdict(60, 1, graded).level, 'warn2')
  // The ceiling is MEASURING_CAP_POINTS, inclusive.
  assert.equal(paceVerdict(10, 1, normal).measuring, true)
  assert.equal(paceVerdict(10.5, 1, normal).measuring, false)
  assert.equal(paceVerdict(10.5, 1, normal).level, 'warn')
  // Neither the preset nor a band moves the cap: the presets differ in the elapsed share only.
  assert.equal(paceVerdict(10, 0.5, { ...normal, sensitivity: 'strict' }).measuring, true)
  assert.equal(paceVerdict(10.5, 0.5, { ...normal, sensitivity: 'strict' }).measuring, false)
  assert.equal(paceVerdict(10, 4, { ...normal, sensitivity: 'relaxed' }).measuring, true)
  assert.equal(paceVerdict(11, 4, { ...normal, sensitivity: 'relaxed' }).measuring, false)
  const custom: PaceConfig = { sensitivity: 'custom', tolerancePoints: 20, minElapsedPercent: 5, levels: 'binary' }
  assert.equal(paceVerdict(10, 1, custom).measuring, true)
  assert.equal(paceVerdict(11, 1, custom).measuring, false)
  // Past the cap the band still has its say in the judgement itself.
  assert.equal(paceVerdict(11, 1, custom).level, 'ok')
  assert.equal(paceVerdict(40, 1, custom).level, 'warn')
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

test('the verdict speaks in percent, never in bare "points"', () => {
  // The figure above the sentence is a percentage in every view; a second unit for the same
  // quantity was the single most confusing thing about the old wording.
  const texts = [
    paceVerdict(50, 40, normal).text,
    paceVerdict(30, 40, normal).text,
    paceVerdict(41, 40, normal).text,
    paceVerdict(40, 40, normal).text,
  ]
  for (const t of texts) {
    assert.equal(/point|in reserve|clock/.test(t), false, t)
  }
  assert.deepEqual(texts, [
    '10 % ahead of pace', '10 % of the window still spare', '1 % ahead of pace', 'on pace',
  ])
})
