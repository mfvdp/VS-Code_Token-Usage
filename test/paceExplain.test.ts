// SPDX-FileCopyrightText: 2026 Frederik Marx
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The words behind a window's colour, built from the real verdict of `paceVerdict` so the
 * explanation and the bar it explains are read off one rule. Every line variant is pinned:
 * ahead, behind, on pace, a configured band, graded levels, measuring, exhausted, no clock,
 * a passed reset, no limit, a stale reading.
 */

import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { PaceConfig, paceVerdict, WindowDisplay, windowElapsed } from '../src/pace'
import { EffectivePace, ExplainInput, explainWindow, paceThresholds } from '../src/paceExplain'

/** 2026-09-06 12:00 UTC. */
const NOW = Date.UTC(2026, 8, 6, 12, 0, 0)
const HOUR = 3_600_000
/** "HH:MM" in UTC — the view model hands in the configured formatter; here it is fixed. */
const fmt = (ms: number): string => new Date(ms).toISOString().slice(11, 16)

/** No band: yellow from the first whole percent ahead — the 1.3 default. */
const NO_BAND: EffectivePace = { tolerancePoints: 0, minElapsedPercent: 3, levels: 'binary' }
/** A configured band of five points, the pre-1.3 "normal" preset. */
const BAND: EffectivePace = { tolerancePoints: 5, minElapsedPercent: 3, levels: 'binary' }

function cfgOf(pace: EffectivePace): PaceConfig {
  return { sensitivity: 'custom', ...pace }
}

/**
 * One five-hour window `hoursToReset` before its reset, judged by the real rule. `display`
 * follows the percentage the way `windowDisplay` would for a fresh reading.
 */
function explain(
  percent: number,
  hoursToReset: number | null,
  pace: EffectivePace = NO_BAND,
  over: Partial<ExplainInput> = {},
): ReturnType<typeof explainWindow> {
  const resetsAt = hoursToReset === null ? null : NOW + hoursToReset * HOUR
  const windowMinutes = hoursToReset === null ? null : 300
  const elapsed = windowElapsed(resetsAt, windowMinutes, NOW)
  const verdict = paceVerdict(percent, elapsed, cfgOf(pace))
  const display: WindowDisplay = !Number.isFinite(percent) ? 'normal'
    : percent > 100.5 ? 'overflow' : percent >= 99.5 ? 'exhausted' : 'normal'
  return explainWindow({
    percent, elapsed, verdict, display, pace, resetsAt, windowMinutes, now: NOW,
    ageMinutes: 2, staleAfterMinutes: 20, formatTime: fmt, ...over,
  })
}

/** Resets in 3.35 h of 5 h: 33 % of the window's own time has passed. */
const THIRD = 3.35

test('ahead of pace: the facts line, the gap in the verdict\'s words, and the colour named', () => {
  const e = explain(37, THIRD)
  assert.equal(e.title, 'Why yellow')
  assert.equal(e.lines[0], 'Used 37 % of the window; 33 % of its time has passed → 4 % ahead of pace.')
  assert.equal(e.lines[1], 'Yellow as soon as the reading is ahead of pace; green at or behind.')
  assert.equal(e.lines.length, 2)
})

test('behind pace and on pace are green, and say so in the same words as the header', () => {
  const behind = explain(27, THIRD)
  assert.equal(behind.title, 'Why green')
  assert.equal(behind.lines[0], 'Used 27 % of the window; 33 % of its time has passed → 6 % behind pace.')
  const even = explain(33, THIRD)
  assert.equal(even.title, 'Why green')
  assert.equal(even.lines[0], 'Used 33 % of the window; 33 % of its time has passed → on pace.')
  // The same rounding as the printed verdict: a gap that rounds to nothing is "on pace",
  // never "0 % ahead" — a header saying "on pace" over a line saying "ahead" is two opinions.
  const hair = explain(33.4, THIRD)
  assert.ok(hair.lines[0].endsWith('→ on pace.'), hair.lines[0])
})

test('a configured band is named with its width, and the reading inside it stays green', () => {
  const e = explain(37, THIRD, BAND)
  assert.equal(e.title, 'Why green', 'four points ahead inside a five-point band is green')
  assert.equal(e.lines[0], 'Used 37 % of the window; 33 % of its time has passed → 4 % ahead of pace.')
  assert.equal(e.lines[1], 'Yellow when more than 5 % ahead of pace (your tolerance band); green at or below that.')
  // Past the band the same sentence explains a yellow bar.
  const over = explain(40, THIRD, BAND)
  assert.equal(over.title, 'Why yellow')
  assert.equal(over.lines[1], e.lines[1])
})

test('the band in the words is where paceVerdict really flips', () => {
  // The threshold is read off the rule, not copied from it: for every band the first whole
  // percent the sentence names as yellow is the first one the verdict colours, and the one
  // before it is not.
  for (const tol of [0, 2, 5, 7.5, 10]) {
    const pace: EffectivePace = { tolerancePoints: tol, minElapsedPercent: 3, levels: 'binary' }
    const t = paceThresholds(pace)
    assert.ok(t.yellowFrom !== null, `band ${tol}`)
    const from = t.yellowFrom as number
    assert.notEqual(paceVerdict(3 + from, 3, cfgOf(pace)).level, 'ok', `band ${tol}: ${from} ahead is yellow`)
    if (from > 1) assert.equal(paceVerdict(3 + from - 1, 3, cfgOf(pace)).level, 'ok', `band ${tol}: ${from - 1} ahead is green`)
    const line = explain(3 + from, 4.85, pace).lines[1]
    assert.ok(from === 1
      ? line.startsWith('Yellow as soon as the reading is ahead of pace')
      : line.startsWith(`Yellow when more than ${from - 1} % ahead of pace`), `band ${tol}: ${line}`)
  }
})

test('graded levels add the amber threshold, at the whole percent the verdict really grades', () => {
  for (const tol of [0, 5]) {
    const pace: EffectivePace = { tolerancePoints: tol, minElapsedPercent: 3, levels: 'graded' }
    // A second, independent search for the flip — the test must not repeat the probe.
    let amber: number | null = null
    for (let k = 1; k < 90; k++) {
      if (paceVerdict(3 + k, 3, cfgOf(pace)).level === 'warn2') { amber = k; break }
    }
    assert.ok(amber !== null, `graded band ${tol} never reaches amber`)
    assert.equal(paceThresholds(pace).amberFrom, amber)
    const line = explain(37, THIRD, pace).lines[1]
    assert.ok(line.endsWith(` Amber from ${amber} % ahead.`), line)
    // Binary levels never mention amber.
    assert.equal(/[Aa]mber/.test(explain(37, THIRD, { ...pace, levels: 'binary' }).lines[1]), false)
  }
  // The bar itself: far enough ahead the title names the graded colour.
  const pace: EffectivePace = { tolerancePoints: 0, minElapsedPercent: 3, levels: 'graded' }
  assert.equal(explain(95, THIRD, pace).title, 'Why amber')
})

test('a window still measuring says until when, and what usage would end the doubt early', () => {
  // One percent of the window gone, three percent used: measuring under a five-point band,
  // whose cap on the phase is ten percent of the window.
  const e = explain(3, 4.95, BAND)
  assert.equal(e.title, 'Why green')
  assert.equal(e.lines[0], 'Used 3 % of the window; 1 % of its time has passed → 2 % ahead of pace.')
  // The window started three minutes ago; three percent of five hours is nine minutes in.
  assert.equal(e.lines[1], 'Measuring until 3 % of the window has passed (12:06); no verdict before that unless usage exceeds 10 %.')
  assert.equal(e.lines[2], 'Yellow when more than 5 % ahead of pace (your tolerance band); green at or below that.')
  // The cap in the words is the cap of the rule: the last whole percent still measuring.
  const cap = paceThresholds(BAND).measuringCap as number
  assert.equal(paceVerdict(cap, 0, cfgOf(BAND)).measuring, true)
  assert.equal(paceVerdict(cap + 1, 0, cfgOf(BAND)).measuring, false)
  // Without a measuring phase there is nothing to announce, and no cap to name.
  const none: EffectivePace = { tolerancePoints: 5, minElapsedPercent: 0, levels: 'binary' }
  // No window length and no reset: the phase is still named, without a clock time in it.
  const noClock = explain(3, 4.95, BAND, { resetsAt: null, windowMinutes: null })
  assert.equal(noClock.lines[1],
    'Measuring until 3 % of the window has passed; no verdict before that unless usage exceeds 10 %.')
  const noCap = explain(3, 4.95, { ...BAND, minElapsedPercent: 5 },
    { resetsAt: null, windowMinutes: null, verdict: paceVerdict(3, 4.95, cfgOf({ ...BAND, minElapsedPercent: 5 })) })
  assert.equal(noCap.lines.some((l) => l === 'Measuring until 5 % of the window has passed; no verdict before that.'),
    false, JSON.stringify(noCap.lines))

  assert.equal(paceThresholds(none).measuringCap, null)
  assert.equal(explain(3, 4.95, none).lines.some((l) => l.startsWith('Measuring')), false)
})

test('an exhausted window is red for that reason alone, with the reset it waits for', () => {
  const e = explain(100, 2)
  assert.equal(e.title, 'Why red')
  assert.equal(e.lines[0], '100 % used — exhausted until the reset at 14:00.')
  assert.equal(e.lines[1], 'Used 100 % of the window; 60 % of its time has passed → 40 % ahead of pace.')
  // The rule that turns a bar yellow is not what turned this one red.
  assert.equal(e.lines.some((l) => l.startsWith('Yellow')), false, JSON.stringify(e.lines))
  // Beyond the limit the state word follows the display.
  assert.equal(explain(111, 2).lines[0], '111 % used — over the limit until the reset at 14:00.')
  // Without a clock the same fact, and no pace line after it.
  const noClock = explain(100, null)
  assert.deepEqual(noClock.lines, ['100 % used — exhausted; this window reports no reset time.'])
})

test('a window without a clock has no pace to explain, and says why', () => {
  const e = explain(37, null)
  assert.equal(e.title, 'Why green')
  assert.deepEqual(e.lines, [
    'Used 37 % of the window.',
    'This window reports no reset time, so there is no pace; the colour follows the level only.',
  ])
})

test('a stale reading adds its age and the rule it is stale by, last', () => {
  const stale = explain(37, THIRD, NO_BAND, { ageMinutes: 42 })
  assert.equal(stale.lines[stale.lines.length - 1], 'The reading is 42 min old (stale after 20 min); the colour may lag.')
  assert.equal(stale.lines.length, 3)
  // Hours and days in the units the card header uses for the same age.
  const hours = explain(37, THIRD, NO_BAND, { ageMinutes: 130 })
  assert.ok(hours.lines[hours.lines.length - 1].startsWith('The reading is 2 h old'), hours.lines.join(' | '))
  const days = explain(37, THIRD, NO_BAND, { ageMinutes: 3 * 1440 })
  assert.ok(days.lines[days.lines.length - 1].startsWith('The reading is 3 d old'), days.lines.join(' | '))
  // A fresh reading, and one whose age nobody knows, get no such line.
  assert.equal(explain(37, THIRD).lines.some((l) => l.includes('stale')), false)
  assert.equal(explain(37, THIRD, NO_BAND, { ageMinutes: null }).lines.some((l) => l.includes('stale')), false)
})

test('a passed reset makes the bar neutral, and the words say whose figure is left on it', () => {
  const e = explain(62, -5 / 60, NO_BAND, { display: 'resetDue' })
  assert.equal(e.title, 'Why grey')
  assert.equal(e.lines[0], 'The stated reset (11:55) has passed and no reading since has caught up: '
    + 'the 62 % belongs to the window before it, so the bar stays neutral until a newer reading arrives.')
  // No pace is claimed for a window that no longer exists.
  assert.equal(e.lines.some((l) => /ahead|behind|on pace/.test(l)), false, JSON.stringify(e.lines))
})

test('no limit and no reading are explained as absences, never as a green pace', () => {
  const unlimited = explainWindow({
    percent: 0, elapsed: 60, display: 'unlimited', pace: NO_BAND, resetsAt: NOW + 2 * HOUR,
    windowMinutes: 300, now: NOW, ageMinutes: 2, staleAfterMinutes: 20, formatTime: fmt,
    verdict: { level: 'ok', points: null, ratio: null, measuring: false, text: 'unlimited' },
  })
  assert.equal(unlimited.title, 'Why no colour')
  assert.deepEqual(unlimited.lines, ['This window has no limit, so there is no share to judge and no pace.'])
  const nan = explain(Number.NaN, THIRD)
  assert.equal(nan.title, 'Why no colour')
  assert.deepEqual(nan.lines, ['The reading carries no usable percentage, so nothing is judged.'])
})

test('a limit the provider reports as reached is red, and no pace rule is quoted for it', () => {
  // The status bar paints the alarm for this state whatever the percentage says, so the
  // popover names that colour rather than a green the pace decided on its own.
  const e = explain(40, THIRD, NO_BAND, { display: 'limitReached' })
  assert.equal(e.title, 'Why red')
  assert.equal(e.lines[0], 'The provider reports this limit as reached.')
  assert.equal(e.lines[1], 'Used 40 % of the window; 33 % of its time has passed → 7 % ahead of pace.')
  // The pace decided nothing here, so the rule that names the colours is not printed.
  assert.equal(e.lines.some((l) => /Yellow|Amber/.test(l)), false, JSON.stringify(e.lines))
  // A full window that is also reported as reached keeps its reset time.
  const full = explain(100, 2, NO_BAND, { display: 'limitReached' })
  assert.equal(full.lines[0], 'The provider reports this limit as reached.')
  assert.ok(full.lines[1].includes('exhausted until the reset at'), full.lines[1])
})

test('the first two lines are the facts and whatever decided the colour', () => {
  // What a one-line view prints: for a measuring window the measuring line, for a full one
  // the exhaustion — never two lines that leave the reason out.
  assert.ok(explain(3, 4.95, BAND).lines.slice(0, 2)[1].startsWith('Measuring'))
  assert.ok(explain(100, 2).lines.slice(0, 2)[0].includes('exhausted'))
  assert.ok(explain(37, THIRD).lines.slice(0, 2)[1].startsWith('Yellow'))
})

test('the words never say "points" and never leak an identifier', () => {
  const all = [
    explain(37, THIRD), explain(27, THIRD), explain(37, THIRD, BAND), explain(3, 4.95, BAND),
    explain(100, 2), explain(111, 2), explain(37, null), explain(37, THIRD, NO_BAND, { ageMinutes: 42 }),
    explain(62, -5 / 60, NO_BAND, { display: 'resetDue' }), explain(40, THIRD, NO_BAND, { display: 'limitReached' }),
    explain(37, THIRD, { tolerancePoints: 0, minElapsedPercent: 3, levels: 'graded' }),
  ]
  for (const e of all) {
    for (const l of [e.title, ...e.lines]) {
      assert.doesNotMatch(l, /\bpoints\b/i, l)
      assert.doesNotMatch(l, /\b(resetDue|limitReached|normal|warn2|undefined|NaN)\b/, l)
    }
  }
})
