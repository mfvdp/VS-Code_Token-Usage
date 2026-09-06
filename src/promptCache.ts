// SPDX-FileCopyrightText: 2026 Frederik Marx
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The prompt-cache line of the Claude card.
 *
 * Claude Code's status line reports whether the running session's prompt cache is warm,
 * which TTL it has, when it expires and how much of the input it served. This module turns
 * that reading into the one line every view prints — the card, the markdown report, the
 * Quick Pick and the status-bar tooltip — and nothing here is derived: a part the payload
 * did not carry prints a dash, an expired cache is reported as what the last reading said,
 * and no view ever estimates any of it from the transcripts. The token buckets know what
 * was read from the cache, not whether the cache is still alive.
 *
 * Pure: `now` and the time formatter come in as parameters, so the countdown is whatever
 * the caller's render clock says and a test can pin it.
 */

import { t } from './i18n'
import type { PromptCacheReading } from './quotaSources'

export interface PromptCacheLine {
  text: string
  /** The stated expiry lies in the past: the line reports the last reading, not a live state. */
  expired: boolean
}

/** The TTL classes the payload names, as the line spells them. */
const TTL_WORD: Record<'5m' | '1h', string> = { '5m': '5 min', '1h': '1 h' }

/**
 * A countdown with seconds, because the whole cache lives for minutes: "3 m 40 s", "12 s",
 * and "1 h 2 m" should a longer TTL ever arrive.
 */
export function countdownText(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  if (h > 0) return `${h} h ${m} m`
  if (m > 0) return `${m} m ${s} s`
  return `${s} s`
}

/**
 * The hit ratio as a percentage, or null. The payload states a share of one (0.82); a
 * number outside that range is not a ratio anybody can check, so it is treated as absent
 * rather than printed as "8200 %".
 */
function hitRatioText(ratio: number | null): string | null {
  if (ratio === null || !Number.isFinite(ratio) || ratio < 0 || ratio > 1) return null
  return `${Math.round(ratio * 100)} %`
}

export function promptCacheText(
  r: PromptCacheReading,
  now: number,
  formatTime: (ms: number) => string,
): PromptCacheLine {
  const ratio = hitRatioText(r.hitRatio)
  const expires = r.expiresAt !== null && Number.isFinite(r.expiresAt) ? r.expiresAt : null
  // Past the stated expiry the "warm" of the payload is history: the line says when it
  // ended and that this is the last thing the status line reported, not a live state.
  // Each spelling of the line is one whole message: a sentence a translator only ever sees
  // in halves cannot be put into another language's word order.
  if (expires !== null && now >= expires) {
    const at = formatTime(expires)
    return {
      text: ratio
        ? t('prompt cache · expired at {0} (last reading) · hit ratio {1}', at, ratio)
        : t('prompt cache · expired at {0} (last reading)', at),
      expired: true,
    }
  }
  if (r.warm === false) {
    return {
      text: ratio ? t('prompt cache cold · hit ratio {0}', ratio) : t('prompt cache cold'),
      expired: false,
    }
  }
  // Warm, or a payload that did not say: every part of the line is printed, and every part
  // the payload left out is a dash — never a value inferred from the others.
  const countdown = expires === null ? '–' : countdownText(expires - now)
  const ttl = r.ttl !== null && r.ttl in TTL_WORD ? TTL_WORD[r.ttl] : '–'
  const hit = ratio ?? '–'
  return {
    text: r.warm === true
      ? t('prompt cache warm · expires in {0} ({1} TTL) · hit ratio {2}', countdown, ttl, hit)
      : t('prompt cache – · expires in {0} ({1} TTL) · hit ratio {2}', countdown, ttl, hit),
    expired: false,
  }
}
