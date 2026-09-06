// SPDX-FileCopyrightText: 2026 Frederik Marx
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The pace judgement: is consumption running ahead of the window's own clock?
 *
 * This is the extension's core claim, so it is a separate, vscode-free module
 * with one rule set that the status bar, the tooltip, the dashboard and the
 * alerts all share — a second opinion in a second place would be a bug that
 * nobody can see.
 */

import { PaceLevel, PaceVerdict, QuotaWindow } from './types'

export type Sensitivity = 'relaxed' | 'normal' | 'strict' | 'custom'

export interface PaceConfig {
  sensitivity: Sensitivity
  /**
   * Band in percentage points a window may run ahead of its clock before it is coloured.
   * 0 by default and applied with every sensitivity: a reading ahead of pace is yellow at
   * once, and only someone who asks for a band gets one.
   */
  tolerancePoints: number
  /**
   * Share of the window that must have passed before a small usage is judged. Heavy
   * usage is judged from the first minute — see `paceVerdict`.
   */
  minElapsedPercent: number
  levels: 'binary' | 'graded'
}

/**
 * The presets decide only how long a window counts as "just reset": the share of it that
 * must have run before a small reading is judged. They carried a tolerance band as well
 * until 1.3, which kept a card reading "4 % ahead of pace" green — the number said one
 * thing and the colour another. Now the band is one setting, 0 by default, whatever the
 * sensitivity.
 */
export const SENSITIVITY_PRESETS: Record<Exclude<Sensitivity, 'custom'>, { minElapsedPercent: number }> = {
  relaxed: { minElapsedPercent: 5 },
  normal: { minElapsedPercent: 3 },
  strict: { minElapsedPercent: 1 },
}

/**
 * "Measuring" ends here whatever the tolerance: a young window that has already spent this
 * much is judged like any other. Ten points of a whole window inside its first minutes is
 * a fact, not an artefact of a nearly-zero elapsed share.
 */
export const MEASURING_CAP_POINTS = 10

/** The tolerance a graded second level is scaled from when the configured band is smaller. */
const GRADED_BASE_POINTS = 5

export const DEFAULT_PACE: PaceConfig = {
  sensitivity: 'normal', tolerancePoints: 0, minElapsedPercent: 3, levels: 'binary',
}

function positive(n: number, fallback: number): number {
  return Number.isFinite(n) && n >= 0 ? n : fallback
}

export function effectivePace(
  cfg: PaceConfig,
): { tolerancePoints: number; minElapsedPercent: number; levels: 'binary' | 'graded' } {
  const levels: 'binary' | 'graded' = cfg.levels === 'graded' ? 'graded' : 'binary'
  // The band applies with every sensitivity; a preset only picks the elapsed share.
  const tolerancePoints = positive(cfg.tolerancePoints, DEFAULT_PACE.tolerancePoints)
  if (cfg.sensitivity === 'custom') {
    return {
      tolerancePoints,
      minElapsedPercent: positive(cfg.minElapsedPercent, SENSITIVITY_PRESETS.normal.minElapsedPercent),
      levels,
    }
  }
  const p = SENSITIVITY_PRESETS[cfg.sensitivity] ?? SENSITIVITY_PRESETS.normal
  return { tolerancePoints, minElapsedPercent: p.minElapsedPercent, levels }
}

/**
 * Where the second level of `graded` starts, in points ahead beyond the band: three times
 * the tolerance, and never under three times five — with the default band of 0, "▲▲" at 15
 * points ahead rather than at the very first one.
 */
export function gradedThreshold(tolerancePoints: number): number {
  return 3 * Math.max(positive(tolerancePoints, 0), GRADED_BASE_POINTS)
}

/**
 * How far the window's own clock has run, 0..100.
 *
 * The window started `windowMinutes` before it resets, so this says what share
 * of the period is already gone. Compared against the usage percentage it shows
 * whether consumption is running ahead of or behind the clock. Without both
 * numbers there is no denominator, and inventing one is forbidden.
 */
export function windowElapsed(
  resetsAt: number | null,
  windowMinutes: number | null,
  now = Date.now(),
): number | null {
  if (!resetsAt || !windowMinutes) return null
  if (!Number.isFinite(resetsAt) || !Number.isFinite(windowMinutes)) return null
  const span = windowMinutes * 60_000
  return Math.max(0, Math.min(100, ((now - (resetsAt - span)) / span) * 100))
}

/**
 * The gap between consumption and the window's own clock, in words.
 *
 * The unit is percentage points of the window, but "points" reads as a score on a scale
 * nobody was given: the figure standing directly above this sentence in every view is a
 * percentage, so the sentence says "%" as well. "still spare" rather than "in reserve"
 * for the same reason — it names what the number is, allowance that has not been used.
 */
function pointsText(points: number): string {
  const n = Math.round(Math.abs(points))
  if (n === 0) return 'on pace'
  return points > 0 ? `${n} % ahead of pace` : `${n} % of the window still spare`
}

/**
 * The verdict for one window.
 *
 * Order matters: exhaustion outranks everything (a full window is a fact, not a
 * tendency), a window without a clock gets no pace at all, and a window that
 * has barely started is explicitly "measuring" — right after a reset elapsed is
 * near zero, so the very first prompt would otherwise always look too fast.
 *
 * "Measuring" is doubt about the clock, not a blanket pardon: it holds only while
 * the window is young AND consumption is still small — at most `MEASURING_CAP_POINTS`
 * of the whole window. Beyond that the gap is far too large to be an artefact of a
 * nearly-zero elapsed share — 60 % of a window spent in its first minutes is a fact,
 * not a rounding error — so the normal judgement applies and the bar, the header, the
 * status bar and the sparkline all colour together.
 *
 * The colour follows the figure the views print: "ahead" is rounded to whole points
 * exactly as the "N % ahead of pace" sentence rounds it, so a card that says "0 % ahead"
 * is never yellow and one that says "1 % ahead" always is. The band, when someone set
 * one, is taken off before the rounding, so "6 % ahead" with a band of 5 is one point
 * over it and yellow, "5 % ahead" is not.
 */
export function paceVerdict(percent: number, elapsed: number | null, cfg: PaceConfig): PaceVerdict {
  const { tolerancePoints, minElapsedPercent, levels } = effectivePace(cfg)
  if (!Number.isFinite(percent)) {
    return { level: 'ok', points: null, ratio: null, measuring: false, text: 'no reading' }
  }
  const hasClock = elapsed !== null && Number.isFinite(elapsed)
  const points = hasClock ? percent - (elapsed as number) : null
  const ratio = hasClock && (elapsed as number) > 0 ? percent / (elapsed as number) : null
  // 99.5 rather than 100 so the level matches the figure the user sees, which is
  // rounded to whole percent.
  if (percent >= 99.5) {
    return { level: 'error', points, ratio, measuring: false, text: 'exhausted' }
  }
  if (!hasClock) {
    return { level: 'ok', points: null, ratio: null, measuring: false, text: 'no clock for this window' }
  }
  if ((elapsed as number) < minElapsedPercent && percent <= MEASURING_CAP_POINTS) {
    return { level: 'ok', points, ratio, measuring: true, text: 'measuring · window just reset' }
  }
  const p = points as number
  const ahead = Math.round(p - tolerancePoints)
  let level: PaceLevel = 'ok'
  if (ahead >= 1) level = levels === 'graded' && ahead >= gradedThreshold(tolerancePoints) ? 'warn2' : 'warn'
  return { level, points: p, ratio, measuring: false, text: pointsText(p) }
}

export function severityOf(v: PaceVerdict): PaceLevel {
  return v.level
}

export type WindowDisplay =
  | 'normal' | 'exhausted' | 'overflow' | 'unlimited' | 'limitReached' | 'resetDue'

/**
 * Which state a window is in, before any glyph or colour is chosen.
 *
 * `resetDue` is the honest answer for the minutes between a reset and the first
 * reading that reflects it: the old percentage is stale, but a zero we made up
 * ourselves would be worse. An unknown fetch time counts as stale for the same
 * reason — we cannot claim the reading is newer than the reset.
 */
export function windowDisplay(
  w: QuotaWindow,
  fetchedAtMs: number | null,
  now: number,
): WindowDisplay {
  if (w.unlimited) return 'unlimited'
  if (w.limitReached) return 'limitReached'
  if (w.resetsAt !== null && Number.isFinite(w.resetsAt) && w.resetsAt < now
    && (fetchedAtMs === null || !Number.isFinite(fetchedAtMs) || fetchedAtMs < w.resetsAt)) {
    return 'resetDue'
  }
  if (!Number.isFinite(w.percent)) return 'normal'
  if (w.percent > 100.5) return 'overflow'
  if (w.percent >= 99.5) return 'exhausted'
  return 'normal'
}
