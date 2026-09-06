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

import { t } from './i18n'
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

/**
 * The heading names the colour the bar is wearing — the words the README uses for them.
 *
 * A function, not a table: `t()` needs its message as a literal, and the colour is only ever
 * read as part of the heading, so the whole heading is the key a translator sees.
 */
function colourTitle(level: PaceLevel): string {
  switch (level) {
    case 'ok': return t('Why green')
    case 'warn': return t('Why yellow')
    case 'warn2': return t('Why amber')
    case 'error': return t('Why red')
    default: return t('Why this colour')
  }
}

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
  if (n === 0) return t('on pace')
  return points > 0 ? t('{0} % ahead of pace', n) : t('{0} % behind pace', n)
}

function factsLine(used: number, elapsed: number, verdict: PaceVerdict, percent: number): string {
  const points = verdict.points !== null && Number.isFinite(verdict.points) ? verdict.points : percent - elapsed
  return t('Used {0} % of the window; {1} % of its time has passed → {2}.',
    used, Math.round(elapsed), gapWords(points))
}

function ruleLine(th: PaceThresholds): string {
  let s: string
  if (th.yellowFrom === null) s = t('No reading ahead of pace turns this bar yellow with the configured band.')
  else if (th.yellowFrom <= 1) s = t('Yellow as soon as the reading is ahead of pace; green at or behind.')
  else s = t('Yellow when more than {0} % ahead of pace (your tolerance band); green at or below that.', th.yellowFrom - 1)
  // Two whole sentences joined by a space, never a translated fragment glued into one.
  if (th.amberFrom !== null) s += ` ${t('Amber from {0} % ahead.', th.amberFrom)}`
  return s
}

/**
 * The measuring phase in one sentence.
 *
 * Four spellings rather than one built from pieces: the clock time and the usage cap are
 * each optional, and a sentence a translator only ever sees in halves cannot be put into
 * German word order.
 */
function measuringLine(i: ExplainInput, th: PaceThresholds): string {
  const span = i.windowMinutes !== null && Number.isFinite(i.windowMinutes) && i.windowMinutes > 0
    ? i.windowMinutes * 60_000
    : null
  // The clock time at which the minimum elapsed share is reached: the window started one
  // span before its reset, and the phase ends that share of the span later.
  const at = span !== null && i.resetsAt !== null && Number.isFinite(i.resetsAt)
    ? i.formatTime(i.resetsAt - span + (span * i.pace.minElapsedPercent) / 100)
    : null
  const share = figure(i.pace.minElapsedPercent)
  if (at !== null) {
    return th.measuringCap !== null
      ? t('Measuring until {0} % of the window has passed ({1}); no verdict before that unless usage exceeds {2} %.',
        share, at, th.measuringCap)
      : t('Measuring until {0} % of the window has passed ({1}); no verdict before that.', share, at)
  }
  return th.measuringCap !== null
    ? t('Measuring until {0} % of the window has passed; no verdict before that unless usage exceeds {1} %.',
      share, th.measuringCap)
    : t('Measuring until {0} % of the window has passed; no verdict before that.', share)
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
    ? t('The reading is {0} old (stale after {1} min); the colour may lag.',
      ageWords(i.ageMinutes), i.staleAfterMinutes)
    : null
  const time = (ms: number | null): string | null =>
    (ms !== null && Number.isFinite(ms) ? i.formatTime(ms) : null)

  if (!Number.isFinite(i.percent)) {
    return {
      title: t('Why no colour'),
      lines: [t('The reading carries no usable percentage, so nothing is judged.'), ...(staleLine ? [staleLine] : [])],
    }
  }
  const used = Math.round(i.percent)
  const lines: string[] = []
  // The unlimited verdict is compared against the very message it was built from, so the
  // check holds in every language: both sides come out of the same bundle entry.
  if (i.display === 'unlimited' || i.verdict.text === t('unlimited')) {
    lines.push(t('This window has no limit, so there is no share to judge and no pace.'))
    if (staleLine) lines.push(staleLine)
    return { title: t('Why no colour'), lines }
  }
  if (i.display === 'resetDue') {
    const at = time(i.resetsAt)
    lines.push(at
      ? t('The stated reset ({0}) has passed and no reading since has caught up: the {1} % belongs to the window before it, so the bar stays neutral until a newer reading arrives.',
        at, used)
      : t('The stated reset has passed and no reading since has caught up: the {0} % belongs to the window before it, so the bar stays neutral until a newer reading arrives.',
        used))
    if (staleLine) lines.push(staleLine)
    return { title: t('Why grey'), lines }
  }

  // A limit the provider itself reports as reached is red wherever it is drawn — the status
  // bar paints the alarm background for it whatever the percentage says — so that state names
  // the colour and opens the explanation, and no pace rule is quoted for a colour it did not
  // decide.
  const reached = i.display === 'limitReached'
  const title = reached ? t('Why red') : colourTitle(i.verdict.level)
  const clock = i.elapsed !== null && Number.isFinite(i.elapsed)
  const facts = clock ? factsLine(used, i.elapsed as number, i.verdict, i.percent) : null
  if (reached || i.verdict.level === 'error') {
    const at = time(i.resetsAt)
    if (reached) lines.push(t('The provider reports this limit as reached.'))
    // The state is part of the sentence, not a word dropped into a slot: "over the limit"
    // and "exhausted" take different grammar in another language.
    if (i.verdict.level === 'error') {
      if (i.display === 'overflow') {
        lines.push(at
          ? t('{0} % used — over the limit until the reset at {1}.', used, at)
          : t('{0} % used — over the limit; this window reports no reset time.', used))
      } else {
        lines.push(at
          ? t('{0} % used — exhausted until the reset at {1}.', used, at)
          : t('{0} % used — exhausted; this window reports no reset time.', used))
      }
    }
    if (facts) lines.push(facts)
  } else if (!clock || facts === null) {
    lines.push(t('Used {0} % of the window.', used))
    lines.push(t('This window reports no reset time, so there is no pace; the colour follows the level only.'))
  } else {
    const th = paceThresholds(i.pace)
    lines.push(facts)
    if (i.verdict.measuring) lines.push(measuringLine(i, th))
    lines.push(ruleLine(th))
  }
  if (staleLine) lines.push(staleLine)
  return { title, lines }
}
