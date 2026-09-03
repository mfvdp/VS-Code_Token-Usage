// SPDX-FileCopyrightText: 2026 Frederik Marx
// SPDX-License-Identifier: AGPL-3.0-or-later

import { Forecast, ForecastState, QuotaSample, QuotaWindow } from './types'

export interface ForecastConfig {
  /** Fewer readings than this and the slope is noise, not a trend. */
  minSamples: number
  /** Shorter than this and the slope is noise as well. */
  minSpanMs: number
  /** At or below this rate the window counts as idle instead of "empty in 40 days". */
  idleRate: number
  /** Share of the window that must have elapsed before any projection is shown. */
  minElapsedPercent: number
  /** A reading older than this cannot carry a forecast — typically twice the poll interval. */
  staleAfterMs: number
}

export const DEFAULT_FORECAST_CONFIG: ForecastConfig = {
  minSamples: 4,
  minSpanMs: 20 * 60 * 1000,
  idleRate: 0.1,
  minElapsedPercent: 3,
  staleAfterMs: 60 * 60 * 1000,
}

/**
 * Structurally identical to `quotaHistory.Cycle`.
 *
 * `forecast.ts` is a pure module and must not depend on the file-backed history, so the
 * shape is restated here instead of imported. TypeScript compares structurally: a
 * `Cycle[]` from `QuotaHistory.cycles()` is accepted here without conversion.
 */
export interface Cycle {
  start: number
  end: number | null
  resetsAt: number | null
  peak: number
  peakAt: number
  last: number
  complete: boolean
  capped: boolean
  tags: Array<'START' | 'RESET' | 'REBASE'>
  fitStart: number
}

export interface Retro {
  windowId: string
  cycles: Cycle[]
  /** Share of complete cycles that reached the exhausted threshold; null without any. */
  cappedShare: number | null
  /** Mean of (100 − last percent) over complete cycles: capacity left on the table. */
  avgUnused: number | null
  /** Three complete cycles are the minimum before the numbers say anything. */
  enough: boolean
}

export interface Calibration {
  factor: number
  low: number
  high: number
  basisHours: number
}

const HOUR_MS = 3_600_000
/** The display layer's "exhausted" threshold — a full window needs no projection. */
const FULL_PERCENT = 99.5
/** Same discontinuity rules as `quotaHistory.cycles()`; kept in sync by name, not by import. */
const CYCLE_DROP_POINTS = 5
const REBASE_POINTS_PER_HOUR = 60
const REBASE_MIN_POINTS = 5
/** A calibration band is built from at most the three newest qualifying spans. */
const CALIBRATION_SPANS = 3
const CALIBRATION_MIN_SPAN_MS = HOUR_MS
const CALIBRATION_MIN_POINTS = 5

/**
 * Wall-clock time without a date, in the machine's zone.
 *
 * `time.ts` owns zone handling; every entry point here takes an optional formatter so the
 * display layer can pass the configured one. This default exists so the module stays
 * usable (and testable) on its own.
 */
function defaultTime(ms: number): string {
  return new Date(ms).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false })
}

function duration(ms: number): string {
  const min = Math.round(Math.max(0, ms) / 60_000)
  if (min < 90) return `${min} min`
  const hours = ms / HOUR_MS
  if (hours < 48) return `${hours < 10 ? Math.round(hours * 10) / 10 : Math.round(hours)} h`
  return `${Math.round(hours / 24)} d`
}

function percentText(p: number): string {
  return `${Math.round(p)} %`
}

function blank(state: ForecastState, text: string): Forecast {
  return {
    state, ratePerHour: null, etaMs: null, endPercent: null, sustainablePerHour: null,
    confidence: null, basis: null, text,
  }
}

function usable(samples: QuotaSample[]): QuotaSample[] {
  return samples
    .filter((s) => Number.isFinite(s.t) && Number.isFinite(s.p))
    .slice()
    .sort((a, b) => a.t - b.t)
}

interface Segment {
  samples: QuotaSample[]
  fitStart: number
}

/**
 * Splits a window's samples at reset discontinuities, mirroring `quotaHistory.cycles()`.
 *
 * The duplication is deliberate: this module stays free of the file-backed history, and a
 * caller that already filtered to one cycle simply gets that cycle back unchanged.
 */
function splitCycles(list: QuotaSample[]): Segment[] {
  if (list.length === 0) return []
  const out: Segment[] = []
  let cur: Segment = { samples: [list[0]], fitStart: list[0].t }
  for (let i = 1; i < list.length; i++) {
    const prev = list[i - 1]
    const s = list[i]
    const resetChanged = prev.r !== null && s.r !== null && prev.r !== s.r
    const fell = prev.p - s.p >= CYCLE_DROP_POINTS
    if (resetChanged || fell) {
      out.push(cur)
      cur = { samples: [s], fitStart: s.t }
      continue
    }
    const hours = (s.t - prev.t) / HOUR_MS
    const rise = s.p - prev.p
    // A limit re-basing moves the denominator; fitting across it would invent a burn rate.
    if (rise >= REBASE_MIN_POINTS && hours > 0 && rise / hours > REBASE_POINTS_PER_HOUR) cur.fitStart = s.t
    cur.samples.push(s)
  }
  out.push(cur)
  return out
}

/** Least squares over (hours, percent); null when every reading shares one timestamp. */
function slopePerHour(list: QuotaSample[]): number | null {
  const n = list.length
  if (n < 2) return null
  const t0 = list[0].t
  let sx = 0
  let sy = 0
  for (const s of list) {
    sx += (s.t - t0) / HOUR_MS
    sy += s.p
  }
  const mx = sx / n
  const my = sy / n
  let sxy = 0
  let sxx = 0
  for (const s of list) {
    const dx = (s.t - t0) / HOUR_MS - mx
    sxy += dx * (s.p - my)
    sxx += dx * dx
  }
  if (sxx === 0) return null
  const slope = sxy / sxx
  return Number.isFinite(slope) ? slope : null
}

function confidenceOf(samples: number, spanMs: number): 'low' | 'medium' | 'high' {
  if (samples < 6 || spanMs < HOUR_MS) return 'low'
  if (samples < 12 || spanMs < 3 * HOUR_MS) return 'medium'
  return 'high'
}

/** The rate that would just last until the reset. Null without a reset in the future. */
function sustainableOf(percent: number, resetsAt: number | null, now: number): number | null {
  if (resetsAt === null || !Number.isFinite(resetsAt) || resetsAt <= now) return null
  const left = 100 - percent
  if (left < 0) return null
  return left / ((resetsAt - now) / HOUR_MS)
}

/**
 * What an exhausted window has to say. There is nothing to project, but an empty string
 * leaves the views printing a dash where the plainest fact of all belongs. The reset is
 * named only when the provider stated one and it is still ahead — an "until the reset" with
 * no reset behind it would be the invented half of the sentence.
 *
 * Deliberately without a countdown: every view prints the window's own reset countdown right
 * beside this sentence, and the two duration formats ("2h14m" against "2.2 h") disagreed on
 * the same instant, which read as two different resets.
 */
function fullText(resetsAt: number | null, now: number): string {
  if (resetsAt === null || !Number.isFinite(resetsAt) || resetsAt <= now) return 'full'
  return 'full until the reset'
}

/**
 * Burn rate, exhaustion time and end-of-window projection for one quota window.
 *
 * Every answer is a named state, never a bare number: `none` (nothing measured), `full`
 * (already exhausted), `stale` (the newest reading is too old to extrapolate), `measuring`
 * (too few readings, too short a span, or too little of the window elapsed), `idle` (flat
 * or falling), `resetsFirst` (the window resets before it runs out) and `eta`. A forecast
 * that would land after the reset is never emitted — "full in 9 d" against a window that
 * resets in 4 d is noise.
 *
 * The fit uses only the current cycle and only samples at or after its `fitStart`, so
 * neither a reset nor a limit re-basing bends the slope. Samples are read across every
 * client of the account, which is why the text is marked as an estimate.
 *
 * @param elapsed share of the window already gone (0..100), or null when the window has
 *   no length — right after a reset a single prompt would otherwise read as a trend.
 * @param fmtTime formatter for wall-clock times; the display layer passes the configured
 *   zone and hour cycle from `time.ts`.
 */
export function forecast(
  samples: QuotaSample[],
  w: QuotaWindow,
  now: number,
  cfg: ForecastConfig,
  elapsed: number | null,
  fmtTime: (ms: number) => string = defaultTime,
): Forecast {
  const percent = typeof w.percent === 'number' && Number.isFinite(w.percent) ? w.percent : null
  // No denominator, no projection: an unlimited window cannot run empty.
  if (percent === null || w.unlimited) return blank('none', '')
  const sustainable = sustainableOf(percent, w.resetsAt, now)
  const withRate = (f: Forecast): Forecast => ({ ...f, sustainablePerHour: sustainable })

  if (percent >= FULL_PERCENT) return withRate(blank('full', fullText(w.resetsAt, now)))

  const clean = usable(samples)
  if (clean.length === 0) return withRate(blank('none', ''))

  const newest = clean[clean.length - 1]
  const cycles = splitCycles(clean)
  const current = cycles[cycles.length - 1]
  const fit = current.samples.filter((s) => s.t >= current.fitStart)
  const spanMs = fit.length > 0 ? fit[fit.length - 1].t - fit[0].t : 0
  const basis = { samples: fit.length, spanMs }

  // Stale beats measuring: a series that stopped an hour ago is not being measured.
  if (cfg.staleAfterMs > 0 && now - newest.t > cfg.staleAfterMs) {
    return { ...withRate(blank('stale', 'stale reading')), basis }
  }
  // The reset has passed but the newest reading still predates it: the percentage belongs
  // to a window that no longer exists, so extrapolating it would land an ETA after a reset
  // that already happened. Same rule as `pace.windowDisplay`'s `resetDue`, so the forecast
  // row and the quota card agree; a reading taken after the reset still forecasts.
  if (w.resetsAt !== null && Number.isFinite(w.resetsAt) && w.resetsAt <= now && newest.t < w.resetsAt) {
    return { ...withRate(blank('stale', 'reset due')), basis }
  }
  if (elapsed !== null && Number.isFinite(elapsed) && elapsed < cfg.minElapsedPercent) {
    return { ...withRate(blank('measuring', 'measuring · window just started')), basis }
  }
  if (fit.length < cfg.minSamples || spanMs < cfg.minSpanMs) {
    const noun = fit.length === 1 ? 'reading' : 'readings'
    return { ...withRate(blank('measuring', `measuring · ${fit.length} ${noun} over ${duration(spanMs)}`)), basis }
  }

  const slope = slopePerHour(fit)
  if (slope === null) {
    return { ...withRate(blank('measuring', `measuring · ${fit.length} readings over ${duration(spanMs)}`)), basis }
  }
  const confidence = confidenceOf(fit.length, spanMs)
  if (slope <= cfg.idleRate) {
    return {
      ...withRate(blank('idle', `idle · no change over ${duration(spanMs)}`)),
      ratePerHour: slope, confidence, basis,
    }
  }

  const etaMs = now + ((100 - percent) / slope) * HOUR_MS
  const hoursToReset = w.resetsAt !== null && Number.isFinite(w.resetsAt) && w.resetsAt > now
    ? (w.resetsAt - now) / HOUR_MS
    : null
  const endPercent = hoursToReset === null ? null : percent + slope * hoursToReset

  if (w.resetsAt !== null && hoursToReset !== null && etaMs >= w.resetsAt) {
    return {
      state: 'resetsFirst', ratePerHour: slope, etaMs: null, endPercent,
      sustainablePerHour: sustainable, confidence, basis,
      text: `~ends at ${percentText(endPercent as number)} when it resets`,
    }
  }
  return {
    state: 'eta', ratePerHour: slope, etaMs, endPercent,
    sustainablePerHour: sustainable, confidence, basis,
    text: `~empty in ${duration(etaMs - now)} (${fmtTime(etaMs)}) · ${confidence} confidence`,
  }
}

/**
 * The wall-clock time the window locks, for the status bar: "locks 15:42".
 *
 * Only an `eta` forecast has one — a window that resets first never locks, and an ETA that
 * already passed is a stale forecast, not a prediction.
 */
export function lockoutText(f: Forecast, now: number, fmtTime: (ms: number) => string = defaultTime): string | null {
  if (f.state !== 'eta' || f.etaMs === null || !Number.isFinite(f.etaMs) || f.etaMs <= now) return null
  return `locks ${fmtTime(f.etaMs)}`
}

/**
 * Buffer or overshoot at the reset, signed: '+' means points left unused, '-' means the
 * window would have been exhausted that far ahead of time.
 */
export function resetForecast(f: Forecast): { sign: '+' | '-'; points: number } | null {
  const end = f.endPercent
  if (end === null || !Number.isFinite(end)) return null
  return end <= 100 ? { sign: '+', points: 100 - end } : { sign: '-', points: end - 100 }
}

/**
 * Look back over finished cycles: how often the window was exhausted, and how much was
 * left over when it reset.
 *
 * Incomplete cycles are ignored for the statistics — VS Code is not running all day, so a
 * cycle observed through a few readings would understate the peak. They stay in `cycles`
 * so the display layer can mark them as incomplete instead of hiding them.
 */
export function retrospective(cycles: Cycle[], windowId: string): Retro {
  const all = [...cycles].sort((a, b) => a.start - b.start)
  const complete = all.filter((c) => c.complete)
  const capped = complete.filter((c) => c.capped).length
  const unused = complete.reduce((sum, c) => sum + (100 - c.last), 0)
  return {
    windowId,
    cycles: all,
    cappedShare: complete.length > 0 ? capped / complete.length : null,
    avgUnused: complete.length > 0 ? unused / complete.length : null,
    enough: complete.length >= 3,
  }
}

function median(sorted: number[]): number {
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

/**
 * How many server percentage points one million locally counted usage tokens cost.
 *
 * Display only. The figure explains the gap between the quota bar and the token table —
 * the server also counts claude.ai, the desktop app, system prompts and tool definitions —
 * and it is a band, not a constant. Applying it as a multiplier to tokens or costs would
 * turn a measured number into an invented one; nothing in this build may do that.
 *
 * A span qualifies when it lies inside one cycle, covers at least an hour, gains at least
 * five percentage points and has local tokens to divide by. The three newest qualifying
 * spans give the band: median as the factor, minimum and maximum as its edges.
 */
export function calibration(
  samples: QuotaSample[],
  localUsageTokens: (fromMs: number, toMs: number) => number | null,
  w: QuotaWindow,
): Calibration | null {
  if (w.unlimited) return null
  const clean = usable(samples)
  if (clean.length < 2) return null
  const factors: number[] = []
  let basisHours = 0
  const cycles = splitCycles(clean)
  for (let c = cycles.length - 1; c >= 0 && factors.length < CALIBRATION_SPANS; c--) {
    const list = cycles[c].samples
    let end = list.length - 1
    while (end > 0 && factors.length < CALIBRATION_SPANS) {
      let start = end - 1
      while (start >= 0 && !qualifies(list[start], list[end])) start--
      if (start < 0) break
      const tokens = localUsageTokens(list[start].t, list[end].t)
      if (tokens !== null && Number.isFinite(tokens) && tokens > 0) {
        factors.push(((list[end].p - list[start].p) * 1e6) / tokens)
        basisHours += (list[end].t - list[start].t) / HOUR_MS
      }
      end = start
    }
  }
  if (factors.length === 0) return null
  const sorted = [...factors].sort((a, b) => a - b)
  return { factor: median(sorted), low: sorted[0], high: sorted[sorted.length - 1], basisHours }
}

function qualifies(a: QuotaSample, b: QuotaSample): boolean {
  return b.t - a.t >= CALIBRATION_MIN_SPAN_MS && b.p - a.p >= CALIBRATION_MIN_POINTS
}
