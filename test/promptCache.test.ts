// SPDX-FileCopyrightText: 2026 Frederik Marx
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The prompt-cache line: every state the status line can report, every part it can leave
 * out, and the one rule behind all of them — a dash for what was not said, never a guess.
 */

import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { countdownText, promptCacheText } from '../src/promptCache'
import type { PromptCacheReading } from '../src/quotaSources'

/** 2026-09-06 12:00 UTC. */
const NOW = Date.UTC(2026, 8, 6, 12, 0, 0)
const fmt = (ms: number): string => new Date(ms).toISOString().slice(11, 16)
/** `tokenPace.staleAfterMinutes`, as the views pass it in. */
const STALE = 20

function reading(over: Partial<PromptCacheReading> = {}): PromptCacheReading {
  return {
    warm: true, ttl: '5m', expiresAt: NOW + 220_000, hitRatio: 0.82,
    readAt: Math.round(NOW / 1000) - 60, ...over,
  }
}

test('a warm cache: state, countdown with seconds, TTL and hit ratio on one line', () => {
  const line = promptCacheText(reading(), NOW, fmt, STALE)
  assert.equal(line.text, 'prompt cache warm · expires in 3 m 40 s (5 min TTL) · hit ratio 82 %')
  assert.equal(line.expired, false)
  assert.equal(promptCacheText(reading({ ttl: '1h', expiresAt: NOW + 3_600_000 }), NOW, fmt, STALE).text,
    'prompt cache warm · expires in 1 h 0 m (1 h TTL) · hit ratio 82 %')
})

test('the countdown is as of the clock it is given — it moves with the render, not on its own', () => {
  assert.equal(promptCacheText(reading(), NOW + 60_000, fmt, STALE).text.includes('expires in 2 m 40 s'), true)
  assert.equal(promptCacheText(reading(), NOW + 215_000, fmt, STALE).text.includes('expires in 5 s'), true)
  assert.equal(countdownText(220_000), '3 m 40 s')
  assert.equal(countdownText(12_000), '12 s')
  assert.equal(countdownText(3_720_000), '1 h 2 m')
  assert.equal(countdownText(-5_000), '0 s')
})

test('a cold cache is one word, with the hit ratio beside it when the payload carried one', () => {
  assert.equal(promptCacheText(reading({ warm: false }), NOW, fmt, STALE).text, 'prompt cache cold · hit ratio 82 %')
  assert.equal(promptCacheText(reading({ warm: false, hitRatio: null }), NOW, fmt, STALE).text, 'prompt cache cold')
  // A stated expiry in the future does not talk a cold cache warm.
  assert.equal(promptCacheText(reading({ warm: false }), NOW, fmt, STALE).text.includes('expires'), false)
})

test('past the stated expiry the line reports the last reading, not a live state', () => {
  const gone = promptCacheText(reading(), NOW + 220_000, fmt, STALE)
  assert.equal(gone.text, 'prompt cache · expired at 12:03 (last reading) · hit ratio 82 %')
  assert.equal(gone.expired, true)
  assert.equal(promptCacheText(reading({ hitRatio: null }), NOW + 400_000, fmt, STALE).text,
    'prompt cache · expired at 12:03 (last reading)')
  // Whatever the warm flag says: the expiry is the payload's own statement about itself.
  assert.equal(promptCacheText(reading({ warm: false }), NOW + 400_000, fmt, STALE).expired, true)
  // Without a stated expiry nothing is ever "expired" — that would be an invented clock.
  assert.equal(promptCacheText(reading({ expiresAt: null }), NOW + 400_000, fmt, STALE).expired, false)
})

test('every part the payload left out is a dash — never a value inferred from the others', () => {
  const bare = promptCacheText(reading({ warm: null, ttl: null, expiresAt: null, hitRatio: null }), NOW, fmt, STALE)
  assert.equal(bare.text, 'prompt cache – · expires in – (– TTL) · hit ratio –')
  assert.equal(promptCacheText(reading({ ttl: null }), NOW, fmt, STALE).text,
    'prompt cache warm · expires in 3 m 40 s (– TTL) · hit ratio 82 %')
  assert.equal(promptCacheText(reading({ expiresAt: null }), NOW, fmt, STALE).text,
    'prompt cache warm · expires in – (5 min TTL) · hit ratio 82 %')
  assert.equal(promptCacheText(reading({ hitRatio: null }), NOW, fmt, STALE).text,
    'prompt cache warm · expires in 3 m 40 s (5 min TTL) · hit ratio –')
  // Warm unknown, the rest known: the state is the dash, the rest is printed.
  assert.equal(promptCacheText(reading({ warm: null }), NOW, fmt, STALE).text,
    'prompt cache – · expires in 3 m 40 s (5 min TTL) · hit ratio 82 %')
})

test('a hit ratio is a share of one; anything else is not a ratio and prints as absent', () => {
  assert.ok(promptCacheText(reading({ hitRatio: 1 }), NOW, fmt, STALE).text.endsWith('hit ratio 100 %'))
  assert.ok(promptCacheText(reading({ hitRatio: 0 }), NOW, fmt, STALE).text.endsWith('hit ratio 0 %'))
  assert.ok(promptCacheText(reading({ hitRatio: 0.005 }), NOW, fmt, STALE).text.endsWith('hit ratio 1 %'))
  for (const odd of [82, -0.1, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.ok(promptCacheText(reading({ hitRatio: odd }), NOW, fmt, STALE).text.endsWith('hit ratio –'), String(odd))
  }
})

test('the line carries the age of the reading it was built from, and marks an old one', () => {
  // The line describes one session as the status line saw it, and a cache that was warm an
  // hour ago is not a warm cache now. The card's own age belongs to whichever source won the
  // quota race, so it cannot answer for this reading.
  const now = promptCacheText(reading(), NOW, fmt, STALE)
  assert.equal(now.ageText, '1 min ago')
  assert.equal(now.fresh, true)
  const old = promptCacheText(reading({ readAt: Math.round(NOW / 1000) - 3600 }), NOW, fmt, STALE)
  assert.equal(old.ageText, '1 h ago')
  assert.equal(old.fresh, false)
  // Every spelling of the line carries it: cold, and past the stated expiry.
  assert.equal(promptCacheText(reading({ warm: false, readAt: Math.round(NOW / 1000) - 3600 }), NOW, fmt, STALE).fresh, false)
  assert.equal(promptCacheText(reading({ readAt: Math.round(NOW / 1000) - 3600 }), NOW + 400_000, fmt, STALE).fresh, false)
  // An unknown time is not a stale time: the line then claims nothing about its age.
  const unknown = promptCacheText(reading({ readAt: null }), NOW, fmt, STALE)
  assert.equal(unknown.ageText, null)
  assert.equal(unknown.fresh, true)
})

test('the line never estimates: no tilde, no "about", no session-index guess', () => {
  for (const r of [reading(), reading({ warm: false }), reading({ warm: null, ttl: null, expiresAt: null, hitRatio: null })]) {
    for (const at of [NOW, NOW + 400_000]) {
      const text = promptCacheText(r, at, fmt, STALE).text
      assert.doesNotMatch(text, /~|about|approx|likely|probably|undefined|NaN/, text)
      assert.ok(text.startsWith('prompt cache'), text)
    }
  }
})
