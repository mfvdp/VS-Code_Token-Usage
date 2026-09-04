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
  /** Dead band in percentage points around the clock, only used with sensitivity 'custom'. */
  tolerancePoints: number
  /** Share of the window that must have passed before any verdict is coloured. */
  minElapsedPercent: number
  levels: 'binary' | 'graded'
}

/**
 * Presets in percentage points, converted from the ratio thresholds the field
 * uses (ratio = (used ÷ limit) ÷ (elapsed ÷ window)): at the middle of a window
 * a ratio of 1.2 / 1.12 / 1.05 is 10 / 6 / 2.5 points ahead; the presets round that to 10 / 5 / 2 so the
 * point bands below are the same judgement expressed in a unit that stays
 * readable near the window edges, where a ratio explodes towards infinity.
 */
export const SENSITIVITY_PRESETS: Record<
  Exclude<Sensitivity, 'custom'>, { tolerancePoints: number; minElapsedPercent: number }
> = {
  relaxed: { tolerancePoints: 10, minElapsedPercent: 5 },
  normal: { tolerancePoints: 5, minElapsedPercent: 3 },
  strict: { tolerancePoints: 2, minElapsedPercent: 1 },
}

export const DEFAULT_PACE: PaceConfig = {
  sensitivity: 'normal', tolerancePoints: 5, minElapsedPercent: 3, levels: 'binary',
}

function positive(n: number, fallback: number): number {
  return Number.isFinite(n) && n >= 0 ? n : fallback
}

export function effectivePace(
  cfg: PaceConfig,
): { tolerancePoints: number; minElapsedPercent: number; levels: 'binary' | 'graded' } {
  const levels: 'binary' | 'graded' = cfg.levels === 'graded' ? 'graded' : 'binary'
  if (cfg.sensitivity === 'custom') {
    return {
      tolerancePoints: positive(cfg.tolerancePoints, SENSITIVITY_PRESETS.normal.tolerancePoints),
      minElapsedPercent: positive(cfg.minElapsedPercent, SENSITIVITY_PRESETS.normal.minElapsedPercent),
      levels,
    }
  }
  const p = SENSITIVITY_PRESETS[cfg.sensitivity] ?? SENSITIVITY_PRESETS.normal
  return { tolerancePoints: p.tolerancePoints, minElapsedPercent: p.minElapsedPercent, levels }
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
  if ((elapsed as number) < minElapsedPercent) {
    return { level: 'ok', points, ratio, measuring: true, text: 'measuring · window just reset' }
  }
  const p = points as number
  let level: PaceLevel = 'ok'
  if (p > tolerancePoints) level = levels === 'graded' && p > tolerancePoints * 3 ? 'warn2' : 'warn'
  return { level, points: p, ratio, measuring: false, text: pointsText(p) }
}

/**
 * The rate that would just last until the reset, in percentage points of the window per
 * hour and per day (the renderers print it as "%/h").
 * Null without a reset time or once the reset has passed: a window whose clock
 * has run out has no remaining hours to spread anything over — and null past 100 %,
 * where the allowance is negative and no rate keeps the window to its reset.
 */
export function sustainableRate(
  percent: number,
  resetsAt: number | null,
  now: number,
): { perHour: number; perDay: number } | null {
  if (resetsAt === null || !Number.isFinite(resetsAt) || !Number.isFinite(percent)) return null
  const hours = (resetsAt - now) / 3_600_000
  if (hours <= 0) return null
  const remaining = 100 - percent
  // An overflowed window has no allowance to spread: a clamped 0 pp/h would read as
  // "0 %/h keeps it to the reset", and nothing keeps an overdrawn window to it.
  if (remaining < 0) return null
  const perHour = remaining / hours
  return { perHour, perDay: perHour * 24 }
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
