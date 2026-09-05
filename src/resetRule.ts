// SPDX-FileCopyrightText: 2026 Frederik Marx
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * When did a quota window turn over? One answer for the reset history, the thinning anchors,
 * the forecast's cycle split and the sparkline's neutral stroke — four readers of the same
 * samples that must never disagree about where a window ended.
 */

import { QuotaSample } from './types'

/**
 * Reset times closer than this are the same reset. Claude Code's usage cache writes the time
 * with sub-second jitter from one read to the next, and two origins round it to different
 * seconds; an exact comparison called every reading a new window — which split the reset
 * history into one-sample cycles, kept every sample from thinning and drew the whole
 * sparkline in the neutral colour.
 */
export const RESET_JITTER_MS = 30_000

/** A fall of five points without a new reset time is a reset the provider did not announce. */
export const CYCLE_DROP_POINTS = 5

/**
 * True when the two readings announce different resets. A null on either side says nothing:
 * "the source does not say" is not "the reset time changed". An idle rolling window (Codex
 * with nothing used) reports "now + window length", so its reset time rides along with the
 * clock; moving by the time between the two readings, give or take the jitter, is not a
 * reset either.
 */
export function resetMoved(prev: QuotaSample, s: QuotaSample): boolean {
  if (prev.r === null || s.r === null) return false
  const dr = s.r - prev.r
  if (Math.abs(dr) <= RESET_JITTER_MS) return false
  return Math.abs(dr - (s.t - prev.t)) > RESET_JITTER_MS
}

/**
 * True when the window turned over between the two readings: a moved reset, or a fall of
 * `CYCLE_DROP_POINTS` without one — providers do not always publish the reset, and a fall is
 * the only other honest evidence.
 */
export function turnedOver(prev: QuotaSample, s: QuotaSample): boolean {
  return resetMoved(prev, s) || prev.p - s.p >= CYCLE_DROP_POINTS
}
