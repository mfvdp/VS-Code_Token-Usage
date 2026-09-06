// SPDX-FileCopyrightText: 2026 Frederik Marx
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Why a quota window wears the colour it wears, in words.
 *
 * The bar says how much and whether that is ahead of the clock; it does not say why a card
 * reading "4 % ahead of pace" is still green, why a window that has just reset is not judged
 * at all, or why a full one is red whatever its pace. This module writes those sentences from
 * the very inputs the verdict was made from, so the explanation cannot say one thing while
 * the bar decides another — and it is the one place that writes them: the dashboard popover,
 * the markdown line under the table and the Quick Pick detail all print these lines verbatim.
 *
 * Pure: no vscode, no clock of its own. The time formatter comes in as a parameter, like
 * everywhere else in the view model, so the words honour the reader's zone and hour cycle
 * without this module knowing either.
 *
 * The thresholds are not copied from `pace.ts`. They are read off `paceVerdict` itself, by
 * asking it where the level flips for the configuration in hand: a constant written here
 * would be a second opinion about the rule, and the rule has changed before — an explanation
 * that names a band the verdict no longer applies is worse than none.
 */

import { PaceConfig, paceVerdict, WindowDisplay } from './pace'
import { PaceLevel, PaceVerdict } from './types'

/** The pace configuration once the presets are resolved — the shape `effectivePace` returns. */
export interface EffectivePace {
  tolerancePoints: number
  minElapsedPercent: number
  levels: 'binary' | 'graded'
}

export interface WindowExplain {
  /** "Why green", "Why yellow", … — the colour the bar is wearing, named. */
  title: string
  /**
   * Sentences in reading order. The first two are what a one-line view prints: the facts
   * (used, elapsed, the gap) and whatever decided the colour — the rule, the measuring phase
   * or the exhaustion. State and staleness follow.
   */
  lines: string[]
}

export interface ExplainInput {
  /** The window's usage share, 0..100 and beyond. */
  percent: number
  /** The elapsed share of the window's own clock, or null without one. */
  elapsed: number | null
  /** The verdict the bar was coloured by — the same object, never a second judgement. */
  verdict: PaceVerdict
  display: WindowDisplay
  pace: EffectivePace
  resetsAt: number | null
  windowMinutes: number | null
  now: number
  /** Age of the reading in minutes; null when the source named no time. */
  ageMinutes: number | null
  staleAfterMinutes: number
  formatTime: (ms: number) => string
}

/**
 * Where the verdict flips, in whole percent ahead of pace, for one configuration.
 *
 * Found by probing `paceVerdict` at the edge of the measuring phase — not inside it, where
 * the phase itself would answer — with the usage one whole percent further ahead each time.
 * A whole percent is the resolution the reader sees: every view rounds the gap before it
 * prints it, so "from 6 % ahead" is exactly the figure at which the printed sentence and the
 * colour change together.
 */
export interface PaceThresholds {
  /** Whole percent ahead from which the bar is yellow; null when no reading ahead ever is. */
  yellowFrom: number | null
  /** Whole percent ahead from which the graded level is amber; null when binary or unreachable. */
  amberFrom: number | null
  /**
   * The highest whole usage percent a young window is still "measuring" at; null when the
   * configuration has no measuring phase at all.
   */
  measuringCap: number | null
}

/** Usage at or above this is exhausted before it is anything else — the probe stops there. */
const EXHAUSTED = 99.5

export function paceThresholds(pace: EffectivePace): PaceThresholds {
  const cfg: PaceConfig = {
    sensitivity: 'custom',
    tolerancePoints: pace.tolerancePoints,
    minElapsedPercent: pace.minElapsedPercent,
    levels: pace.levels,
  }
  // Exactly at the minimum elapsed share the window is no longer measuring, and the whole
  // range up to exhaustion is still open to probe.
  const e0 = Number.isFinite(pace.minElapsedPercent) ? Math.min(Math.max(pace.minElapsedPercent, 0), 50) : 0
  let yellowFrom: number | null = null
  let amberFrom: number | null = null
  for (let k = 1; e0 + k < EXHAUSTED; k++) {
    const level = paceVerdict(e0 + k, e0, cfg).level
    if (yellowFrom === null && level !== 'ok') yellowFrom = k
    if (level === 'warn2') {
      amberFrom = k
      break
    }
    if (level === 'error') break
  }
  let measuringCap: number | null = null
  if (pace.minElapsedPercent > 0) {
    // A window whose clock has not run at all: the phase holds as long as the usage is small.
    for (let c = 0; c < EXHAUSTED; c++) {
      if (!paceVerdict(c, 0, cfg).measuring) break
      measuringCap = c
    }
  }
  return { yellowFrom, amberFrom: pace.levels === 'graded' ? amberFrom : null, measuringCap }
}

/** The colours the bar paints per level — the words the README uses for them. */
const COLOUR: Record<PaceLevel, string> = { ok: 'green', warn: 'yellow', warn2: 'amber', error: 'red' }

/** A threshold as the settings show it: whole numbers plain, anything else to one decimal. */
function figure(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(1)
}

/**
 * An age in the units `ageText` uses, without the "ago": "12 min", "2 h", "3 d". The same
 * breakpoints, so the card header and the explanation never disagree about how old a
 * reading is.
 */
function ageWords(min: number): string {
  if (min < 60) return `${Math.max(1, Math.round(min))} min`
  const h = min / 60
  if (h < 48) return `${Math.round(h)} h`
  return `${Math.round(h / 24)} d`
}

/**
 * The gap in the words of the verdict: the same rounding as the "N % ahead of pace" the
 * card prints, so an explanation never says "1 % ahead" under a header that says "on pace".
 */
function gapWords(points: number): string {
  const n = Math.round(Math.abs(points))
  if (n === 0) return 'on pace'
  return points > 0 ? `${n} % ahead of pace` : `${n} % behind pace`
}

function factsLine(used: number, elapsed: number, verdict: PaceVerdict, percent: number): string {
  const points = verdict.points !== null && Number.isFinite(verdict.points) ? verdict.points : percent - elapsed
  return `Used ${used} % of the window; ${Math.round(elapsed)} % of its time has passed → ${gapWords(points)}.`
}

function ruleLine(t: PaceThresholds): string {
  let s: string
  if (t.yellowFrom === null) s = 'No reading ahead of pace turns this bar yellow with the configured band.'
  else if (t.yellowFrom <= 1) s = 'Yellow as soon as the reading is ahead of pace; green at or behind.'
  else s = `Yellow when more than ${t.yellowFrom - 1} % ahead of pace (your tolerance band); green at or below that.`
  if (t.amberFrom !== null) s += ` Amber from ${t.amberFrom} % ahead.`
  return s
}

function measuringLine(i: ExplainInput, t: PaceThresholds): string {
  const span = i.windowMinutes !== null && Number.isFinite(i.windowMinutes) && i.windowMinutes > 0
    ? i.windowMinutes * 60_000
    : null
  // The clock time at which the minimum elapsed share is reached: the window started one
  // span before its reset, and the phase ends that share of the span later.
  const at = span !== null && i.resetsAt !== null && Number.isFinite(i.resetsAt)
    ? i.formatTime(i.resetsAt - span + (span * i.pace.minElapsedPercent) / 100)
    : null
  return `Measuring until ${figure(i.pace.minElapsedPercent)} % of the window has passed`
    + `${at ? ` (${at})` : ''}; no verdict before that`
    + `${t.measuringCap !== null ? ` unless usage exceeds ${t.measuringCap} %` : ''}.`
}

/**
 * The explanation of one window's colour.
 *
 * Order matters the way it does in `paceVerdict`: a reset that has passed, a window without
 * a limit and a full window are each explained by that fact alone before any pace is
 * mentioned, because that fact is what coloured the bar. Only a window with a clock and a
 * share gets the facts line, the measuring line while it applies, and the rule.
 */
export function explainWindow(i: ExplainInput): WindowExplain {
  const staleLine = i.ageMinutes !== null && Number.isFinite(i.ageMinutes) && i.ageMinutes > i.staleAfterMinutes
    ? `The reading is ${ageWords(i.ageMinutes)} old (stale after ${i.staleAfterMinutes} min); the colour may lag.`
    : null
  const time = (ms: number | null): string | null =>
    (ms !== null && Number.isFinite(ms) ? i.formatTime(ms) : null)

  if (!Number.isFinite(i.percent)) {
    return {
      title: 'Why no colour',
      lines: ['The reading carries no usable percentage, so nothing is judged.', ...(staleLine ? [staleLine] : [])],
    }
  }
  const used = Math.round(i.percent)
  const lines: string[] = []
  if (i.display === 'unlimited' || i.verdict.text === 'unlimited') {
    lines.push('This window has no limit, so there is no share to judge and no pace.')
    if (staleLine) lines.push(staleLine)
    return { title: 'Why no colour', lines }
  }
  if (i.display === 'resetDue') {
    const at = time(i.resetsAt)
    lines.push(`The stated reset${at ? ` (${at})` : ''} has passed and no reading since has caught up: `
      + `the ${used} % belongs to the window before it, so the bar stays neutral until a newer reading arrives.`)
    if (staleLine) lines.push(staleLine)
    return { title: 'Why grey', lines }
  }

  const title = `Why ${COLOUR[i.verdict.level] ?? 'this colour'}`
  const clock = i.elapsed !== null && Number.isFinite(i.elapsed)
  const facts = clock ? factsLine(used, i.elapsed as number, i.verdict, i.percent) : null
  if (i.verdict.level === 'error') {
    const word = i.display === 'overflow' ? 'over the limit' : 'exhausted'
    const at = time(i.resetsAt)
    lines.push(at
      ? `${used} % used — ${word} until the reset at ${at}.`
      : `${used} % used — ${word}; this window reports no reset time.`)
    if (facts) lines.push(facts)
  } else if (!clock || facts === null) {
    lines.push(`Used ${used} % of the window.`)
    lines.push('This window reports no reset time, so there is no pace; the colour follows the level only.')
  } else {
    const t = paceThresholds(i.pace)
    lines.push(facts)
    if (i.verdict.measuring) lines.push(measuringLine(i, t))
    lines.push(ruleLine(t))
  }
  if (i.display === 'limitReached') lines.push('The provider reports this limit as reached.')
  if (staleLine) lines.push(staleLine)
  return { title, lines }
}
