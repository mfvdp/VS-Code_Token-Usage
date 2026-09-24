// SPDX-FileCopyrightText: 2026 Frederik Marx
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * 1.8 A: the prompt-cache watch — which source describes a session, the phases and their bounds, the
 * order and the caps, the words of every phase and source, the cost comparison with its factors
 * taken from the price table (never from a literal), and the Codex line. Synthetic records and
 * readings throughout; no transcript, no mirror file.
 */

import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { buildAgentTree } from '../src/agentTreeBuild'
import {
  BRIDGE_SKEW_MS, CACHE_COLD_SHOWN_MS, CACHE_COOLING_LEAD_MS, CACHE_TEXT_MAX, CODEX_RETENTION_MS, CacheWatchEntry, TTL_MS,
  WatchInput, cacheCostText, cacheLineText, cacheMoreText, cachePhase, codexCacheText, codexRetentionKnown, factorText,
  watchCaches,
} from '../src/cacheWatch'
import { setBundle, setLocale } from '../src/i18n'
import { PRICES, PricingOptions, priceOf } from '../src/prices'
import type { PromptCacheReading } from '../src/quotaSources'
import { TimeConfig, dayOf } from '../src/time'
import { LastRequest, MainRec } from '../src/types'
import { ROOT } from './helpers/nls'

/** 2026-09-24 14:47:50 UTC, a Thursday: a cache that expires at 14:52 has 4 m 10 s left. */
const NOW = Date.UTC(2026, 8, 24, 14, 47, 50)
const EXPIRY = Date.UTC(2026, 8, 24, 14, 52, 0)
const MIN = 60_000
const HOUR = 60 * MIN
const tcfg: TimeConfig = { zone: 'utc', dayBoundaryHour: 0, startOfWeek: 'monday', hourCycle: 'h23' }
const S1 = '9d0eb37a-0000-4000-8000-000000000001'

const GERMAN = JSON.parse(readFileSync(join(ROOT, 'l10n', 'bundle.l10n.de.json'), 'utf8')) as Record<string, string>

function german<T>(run: () => T): T {
  try {
    setBundle(GERMAN)
    setLocale('de')
    return run()
  } finally {
    setBundle(undefined)
    setLocale(undefined)
  }
}

/** A bridge reading of S1: a 1 h cache, warm, expiring at EXPIRY, read a minute ago, 152 300 tokens to re-cache on Opus 5.5. */
function reading(over: Partial<PromptCacheReading> = {}): PromptCacheReading {
  return {
    warm: true, ttl: '1h', expiresAt: EXPIRY, hitRatio: 0.9, readAt: Math.floor((NOW - MIN) / 1000),
    sessionId: S1, recacheIfCold: 152_300, model: 'claude-opus-5-5', ...over,
  }
}

function lastRequest(over: Partial<LastRequest> = {}): LastRequest {
  return { at: EXPIRY - HOUR, ttl: '1h', context: 152_300, model: 'claude-opus-5-5', stop: 'end_turn', replyPending: false, ...over }
}

/** A main session of S1 that started at 14:20 two days ago (Tue), its newest cache request `lastRequest`. */
function main(over: Partial<MainRec> = {}): MainRec {
  return {
    source: 'claude', sessionId: S1, firstTs: Date.UTC(2026, 8, 22, 14, 20), lastTs: EXPIRY - HOUR, models: ['claude-opus-5-5'],
    input: 1000, cacheWrite: 500, cacheWrite1h: 500, cacheRead: 90_000, output: 2000, reasoning: 0,
    requests: 12, outputFinal: 12, toolCalls: 3, ccVersion: null, permissionMode: null, compactions: 0, lastCompaction: null,
    lastRequest: lastRequest(), ...over,
  }
}

function watch(o: { readings?: readonly PromptCacheReading[]; mains?: readonly MainRec[] }, now = NOW, max?: number): CacheWatchEntry[] {
  const input: WatchInput = {
    readings: o.readings ?? [],
    mains: (o.mains ?? []).map((m) => [`/p/${m.sessionId}.jsonl`, m] as const),
    tcfg,
  }
  return max === undefined ? watchCaches(input, now) : watchCaches(input, now, max)
}

/** An entry as the watch makes it, for the word and cost tests. */
function entry(over: Partial<CacheWatchEntry> = {}): CacheWatchEntry {
  return {
    sessionId: S1, name: 'Session Tue 14:20 · 9d0eb37a', source: 'bridge', ttl: '1h', expiresAt: EXPIRY,
    phase: 'cooling', recache: 152_300, model: 'claude-opus-5-5', ...over,
  }
}

const NO_PRICING: PricingOptions = {}

// ---------------------------------------------------------------------------
// §3 A2 · the phases (A8 test 6)
// ---------------------------------------------------------------------------

test('the phases: warm until the lead, cooling from it to the expiry, cold for an hour after, then not listed', () => {
  const L = CACHE_COOLING_LEAD_MS
  assert.equal(L, 5 * MIN)
  assert.equal(CACHE_COLD_SHOWN_MS, 60 * MIN)
  assert.equal(TTL_MS['1h'], HOUR)
  assert.equal(cachePhase(EXPIRY, EXPIRY - L - 1), 'warm')
  // Mutation check (§3 A8 test 6): `<=` for `<` at the lead's boundary makes this one warm.
  assert.equal(cachePhase(EXPIRY, EXPIRY - L), 'cooling')
  assert.equal(cachePhase(EXPIRY, EXPIRY - 1), 'cooling')
  assert.equal(cachePhase(EXPIRY, EXPIRY), 'cold')
  assert.equal(cachePhase(EXPIRY, EXPIRY + CACHE_COLD_SHOWN_MS - 1), 'cold')
  assert.equal(cachePhase(EXPIRY, EXPIRY + CACHE_COLD_SHOWN_MS), null)
  // The same bounds for either source, through the watch.
  for (const [what, o] of [['bridge', { readings: [reading()] }], ['transcript', { mains: [main()] }]] as const) {
    const at = (now: number): string | null => watch(o, now)[0]?.phase ?? null
    assert.equal(at(EXPIRY - L - 1), 'warm', what)
    assert.equal(at(EXPIRY - L), 'cooling', what)
    assert.equal(at(EXPIRY), 'cold', what)
    assert.equal(at(EXPIRY + CACHE_COLD_SHOWN_MS), null, what)
    assert.equal(watch(o, EXPIRY - L)[0].source, what)
  }
})

test('only a 1 h cache is watched: a 5 m cache, a missing TTL and an empty size never are, at any time', () => {
  for (let now = EXPIRY - 70 * MIN; now <= EXPIRY + 70 * MIN; now += MIN) {
    assert.deepEqual(watch({ readings: [reading({ ttl: '5m' })] }, now), [], `a 5 m reading at ${now}`)
    assert.deepEqual(watch({ readings: [reading({ ttl: null })] }, now), [], `a reading without a TTL at ${now}`)
    assert.deepEqual(watch({ mains: [main({ lastRequest: lastRequest({ ttl: '5m' }) })] }, now), [], `a 5 m request at ${now}`)
    assert.deepEqual(watch({ mains: [main({ lastRequest: lastRequest({ ttl: null }) })] }, now), [], `a request before a write at ${now}`)
    assert.deepEqual(watch({ mains: [main({ lastRequest: lastRequest({ context: 0 }) })] }, now), [], `a request of no size at ${now}`)
    assert.deepEqual(watch({ mains: [main({ lastRequest: null })] }, now), [], `no request at ${now}`)
  }
  // A reading without an expiry says nothing about when it cools.
  assert.deepEqual(watch({ readings: [reading({ expiresAt: null })] }), [])
})

test('an expiry more than one lifetime away rests on a clock ahead of this one, and is not watched', () => {
  // A transcript dated five minutes in the future, a status line stating an expiry 61 minutes out.
  assert.deepEqual(watch({ mains: [main({ lastRequest: lastRequest({ at: NOW + 5 * MIN }) })] }), [])
  assert.deepEqual(watch({ readings: [reading({ expiresAt: NOW + HOUR + MIN })] }), [])
  // Within the slack it is the hour it says.
  const soon = watch({ mains: [main({ lastRequest: lastRequest({ at: NOW + 5000 }) })] })
  assert.deepEqual(soon.map((e) => [e.phase, cacheLineText(e, NOW, tcfg)]),
    [['warm', 'Session Tue 14:20 · 9d0eb37a · prompt cache warm · cools in ~1 h 0 m (1 h TTL, estimated from the transcript)']])
  assert.equal(watch({ readings: [reading({ expiresAt: NOW + HOUR + BRIDGE_SKEW_MS })] })[0].phase, 'warm')
})

test('a bridge reading that is not warm before its stated expiry is not watched, and the transcript does not bring it back', () => {
  // The status line ran after the newest request the transcript counted, so the bridge describes the session.
  const older = main({ lastRequest: lastRequest({ at: NOW - 30 * MIN }) })
  for (const expiresAt of [EXPIRY, null]) {
    assert.deepEqual(watch({ readings: [reading({ warm: false, expiresAt })] }), [], String(expiresAt))
    assert.deepEqual(watch({ readings: [reading({ warm: false, expiresAt })], mains: [older] }), [], `with a record, ${expiresAt}`)
  }
  // Past its stated expiry a cache that went cold is cold, whatever `warm` said of the last response.
  const cold = watch({ readings: [reading({ warm: false, expiresAt: NOW - MIN })] })
  assert.deepEqual(cold.map((e) => [e.phase, e.source]), [['cold', 'bridge']])
  // Nothing is inferred from the hit ratio: a warm reading with no ratio is watched, a ratio of 1 changes nothing.
  assert.equal(watch({ readings: [reading({ hitRatio: null })] })[0].phase, 'cooling')
  assert.deepEqual(watch({ readings: [reading({ warm: false, hitRatio: 1 })] }), [])
})

// ---------------------------------------------------------------------------
// §3 A1 · which source describes a session (A8 test 7)
// ---------------------------------------------------------------------------

test('precedence: the bridge while it ran after the newest request, the transcript once a request is newer than BRIDGE_SKEW_MS', () => {
  const readAt = Math.floor((NOW - 10 * MIN) / 1000)
  const r = reading({ readAt })
  // Written after the request the transcript knows: the bridge's, with its own figures.
  const after = watch({ readings: [r], mains: [main({ lastRequest: lastRequest({ at: readAt * 1000 - MIN }) })] })
  assert.deepEqual(after.map((e) => [e.source, e.expiresAt, e.recache, e.model]), [['bridge', EXPIRY, 152_300, 'claude-opus-5-5']])
  // A request 9 s after the reading is within the slack: still the bridge.
  assert.equal(watch({ readings: [r], mains: [main({ lastRequest: lastRequest({ at: readAt * 1000 + BRIDGE_SKEW_MS - 1000 }) })] })[0].source, 'bridge')
  // Mutation check (§3 A8 test 7): "always the bridge" fails here — a request 11 s after the
  // reading is one the status line has not seen, and the transcript's estimate describes the session.
  const newer = readAt * 1000 + BRIDGE_SKEW_MS + 1000
  const late = watch({ readings: [r], mains: [main({ lastRequest: lastRequest({ at: newer, context: 160_000, model: 'claude-fable-5-1' }) })] }, NOW)
  assert.deepEqual(late.map((e) => [e.source, e.expiresAt, e.recache, e.model]), [['transcript', newer + HOUR, 160_000, 'claude-fable-5-1']])
  // A reading without a time never wins over a request the transcript knows the time of.
  assert.equal(watch({ readings: [reading({ readAt: null })], mains: [main()] })[0].source, 'transcript')
  // A reading of a session no record knows stands alone, named by its id.
  const alone = watch({ readings: [reading()] })
  assert.deepEqual(alone.map((e) => [e.source, e.name]), [['bridge', 'Session 9d0eb37a']])
  // …and a record without a reading is the transcript's, named as the Agents tree names it.
  assert.deepEqual(watch({ mains: [main()] }).map((e) => [e.source, e.name]), [['transcript', 'Session Tue 14:20 · 9d0eb37a']])
})

test('never one session\'s reading for another: a reading without a usable id is not watched, and each session appears once', () => {
  for (const sessionId of [null, '', '../../etc', 'x'.repeat(65), 'a b']) {
    assert.deepEqual(watch({ readings: [reading({ sessionId: sessionId as string | null })] }), [], String(sessionId))
  }
  // Two readings of one session: the newer one; two records of one session id: the one with the newer request.
  const one = watch({
    readings: [reading({ readAt: Math.floor((NOW - 5 * MIN) / 1000), expiresAt: EXPIRY - 30 * MIN }), reading()],
    mains: [main(), main({ lastRequest: lastRequest({ at: NOW - 50 * MIN }) })],
  })
  assert.equal(one.length, 1)
  assert.equal(one[0].expiresAt, EXPIRY)
  const twoMains = watch({ mains: [main({ lastRequest: lastRequest({ at: NOW - 50 * MIN }) }), main()] })
  assert.deepEqual(twoMains.map((e) => e.expiresAt), [NOW - 50 * MIN + HOUR])
})

test('the name is the Agents tree\'s own name of the session, start and id', () => {
  const rec = main({ lastTs: NOW - 2 * MIN })
  const tree = buildAgentTree({ agents: [], launches: [], mains: [rec], sessions: [], attribution: 'none', selected: null, mode: 'text', tcfg }, NOW)
  assert.equal(watch({ mains: [rec] })[0].name, tree.roots[0].label)
  assert.equal(tree.roots[0].label, 'Session Tue 14:20 · 9d0eb37a')
  german(() => assert.equal(watch({ mains: [rec] })[0].name, 'Sitzung Di 14:20 · 9d0eb37a'))
})

// ---------------------------------------------------------------------------
// §3 A2 · the order and the caps (A8 test 8)
// ---------------------------------------------------------------------------

test('the order: cooling by expiry, then cold with the most recent first, then warm by expiry; ties by session id; at most CACHE_TEXT_MAX', () => {
  const id = (n: number): string => `s${String(n).padStart(2, '0')}-0000`
  const r = (n: number, expiresAt: number): PromptCacheReading => reading({ sessionId: id(n), expiresAt, readAt: Math.floor(NOW / 1000) })
  const readings = [
    // five cooling, two of them at the same expiry
    r(1, NOW + 4 * MIN), r(2, NOW + 1 * MIN), r(3, NOW + 3 * MIN), r(5, NOW + 2 * MIN), r(4, NOW + 2 * MIN),
    // three cold
    r(6, NOW - 30 * MIN), r(7, NOW - 1 * MIN), r(8, NOW - 50 * MIN),
    // four warm
    r(9, NOW + 40 * MIN), r(10, NOW + 10 * MIN), r(11, NOW + 20 * MIN), r(12, NOW + 30 * MIN),
  ]
  const every = watch({ readings }, NOW, Infinity)
  assert.deepEqual(every.map((e) => e.sessionId), [2, 4, 5, 3, 1, 7, 6, 8, 10, 11, 12, 9].map(id))
  assert.deepEqual(every.map((e) => e.phase), [...Array(5).fill('cooling'), ...Array(3).fill('cold'), ...Array(4).fill('warm')])
  const capped = watch({ readings })
  assert.equal(CACHE_TEXT_MAX, 10)
  assert.deepEqual(capped.map((e) => e.sessionId), every.slice(0, CACHE_TEXT_MAX).map((e) => e.sessionId))
})

// ---------------------------------------------------------------------------
// §3 A3 · the words
// ---------------------------------------------------------------------------

test('the words: one whole sentence per phase and source; a transcript line marks its time ~ and says it is an estimate', () => {
  const cases: Array<[CacheWatchEntry, number, string, string]> = [
    [entry({ phase: 'warm', expiresAt: NOW + 42 * MIN + 5000 }), NOW,
      'Session Tue 14:20 · 9d0eb37a · prompt cache warm · cools in 42 m 5 s (1 h TTL)',
      'Session Tue 14:20 · 9d0eb37a · Prompt-Cache warm · kühlt in 42 m 5 s ab (1 h TTL)'],
    [entry(), NOW,
      'Session Tue 14:20 · 9d0eb37a · prompt cache cools in 4 m 10 s (1 h TTL)',
      'Session Tue 14:20 · 9d0eb37a · Prompt-Cache kühlt in 4 m 10 s ab (1 h TTL)'],
    [entry({ phase: 'cold' }), NOW + 20 * MIN,
      'Session Tue 14:20 · 9d0eb37a · prompt cache cold since 14:52 (1 h TTL)',
      'Session Tue 14:20 · 9d0eb37a · Prompt-Cache kalt seit 14:52 (1 h TTL)'],
    [entry({ phase: 'warm', source: 'transcript', expiresAt: NOW + 30 * MIN }), NOW,
      'Session Tue 14:20 · 9d0eb37a · prompt cache warm · cools in ~30 m 0 s (1 h TTL, estimated from the transcript)',
      'Session Tue 14:20 · 9d0eb37a · Prompt-Cache warm · kühlt in ~30 m 0 s ab (1 h TTL, geschätzt aus dem Transkript)'],
    [entry({ source: 'transcript' }), NOW,
      'Session Tue 14:20 · 9d0eb37a · prompt cache cools in ~4 m 10 s (1 h TTL, estimated from the transcript)',
      'Session Tue 14:20 · 9d0eb37a · Prompt-Cache kühlt in ~4 m 10 s ab (1 h TTL, geschätzt aus dem Transkript)'],
    [entry({ phase: 'cold', source: 'transcript' }), NOW + 20 * MIN,
      'Session Tue 14:20 · 9d0eb37a · prompt cache cold since ~14:52 (1 h TTL, estimated from the transcript)',
      'Session Tue 14:20 · 9d0eb37a · Prompt-Cache kalt seit ~14:52 (1 h TTL, geschätzt aus dem Transkript)'],
  ]
  for (const [e, now, en, de] of cases) {
    assert.equal(cacheLineText(e, now, tcfg), en)
    // The German name comes from the German build of the entry; the rest of the sentence from the template.
    assert.equal(german(() => cacheLineText({ ...e, name: 'Session Tue 14:20 · 9d0eb37a' }, now, tcfg)), de)
  }
  // A cold cache of another day names its day.
  assert.equal(cacheLineText(entry({ phase: 'cold', expiresAt: EXPIRY - 24 * HOUR }), NOW, tcfg),
    'Session Tue 14:20 · 9d0eb37a · prompt cache cold since 2026-09-23 14:52 (1 h TTL)')
  // The line after the capped ones, a whole sentence per number.
  assert.equal(cacheMoreText(0), null)
  assert.equal(cacheMoreText(1), '1 more session with a cooling or cold prompt cache')
  assert.equal(cacheMoreText(5), '5 more sessions with a cooling or cold prompt cache')
  german(() => {
    assert.equal(cacheMoreText(1), '1 weitere Sitzung mit abkühlendem oder kaltem Prompt-Cache')
    assert.equal(cacheMoreText(5), '5 weitere Sitzungen mit abkühlendem oder kaltem Prompt-Cache')
  })
})

// ---------------------------------------------------------------------------
// §3 A4 · the cost comparison (A8 tests 9 and 10)
// ---------------------------------------------------------------------------

test('the cost line of every exactly priced Claude model prints the factors the price table gives it — none is a literal', () => {
  const day = dayOf(NOW, tcfg)
  const claude = Object.keys(PRICES).filter((m) => m.startsWith('claude-'))
  assert.ok(claude.length >= 10)
  const seen = new Map<string, [string, string]>()
  for (const model of claude) {
    const lookup = priceOf(model, day)
    if (lookup === null || lookup.confidence !== 'exact' || !lookup.rule) continue
    const rule = lookup.rule
    const write = factorText(rule.cacheWrite1h / rule.input)
    const read = factorText(rule.cacheRead / rule.input)
    seen.set(model, [write, read])
    assert.equal(cacheCostText(entry({ model }), NOW, tcfg, NO_PRICING, false),
      `A cold start after 14:52 re-writes 152.3K tokens at the 1 h write rate (${write}× input) instead of reading them from the cache (${read}× input).`, model)
    assert.equal(cacheCostText(entry({ model, phase: 'cold' }), NOW + MIN, tcfg, NO_PRICING, false),
      `The next request re-writes 152.3K tokens at the 1 h write rate (${write}× input) instead of reading them from the cache (${read}× input).`, model)
  }
  // Mutation check (§3 A8 test 9): a literal 0.1 read factor fails these three.
  assert.deepEqual(seen.get('claude-opus-5-5'), ['2', '0.05'])
  assert.deepEqual(seen.get('claude-fable-5-1'), ['2', '0.025'])
  assert.deepEqual(seen.get('claude-mythos-5-1'), ['2', '0.025'])
  assert.deepEqual(seen.get('claude-sonnet-5'), ['2', '0.1'])
})

test('the Opus 5.5 example of §3 A4 word for word, in English and German, and its money', () => {
  const e = entry()
  assert.equal(cacheCostText(e, NOW, tcfg, NO_PRICING, true),
    'A cold start after 14:52 re-writes 152.3K tokens at the 1 h write rate (2× input, ~$1.22) instead of reading them from the cache (0.05× input, ~$0.03).')
  assert.equal(german(() => cacheCostText(e, NOW, tcfg, NO_PRICING, true)),
    'Ein Kaltstart nach 14:52 schreibt 152,3K Token zum 1-h-Schreibpreis neu (2× Eingabe, ~$1,22), statt sie aus dem Cache zu lesen (0,05× Eingabe, ~$0,03).')
  const cold = entry({ phase: 'cold' })
  assert.equal(cacheCostText(cold, NOW + 10 * MIN, tcfg, NO_PRICING, true),
    'The next request re-writes 152.3K tokens at the 1 h write rate (2× input, ~$1.22) instead of reading them from the cache (0.05× input, ~$0.03).')
  assert.equal(german(() => cacheCostText(cold, NOW + 10 * MIN, tcfg, NO_PRICING, true)),
    'Die nächste Anfrage schreibt 152,3K Token zum 1-h-Schreibpreis neu (2× Eingabe, ~$1,22), statt sie aus dem Cache zu lesen (0,05× Eingabe, ~$0,03).')
  // Costs off: the rates variant, and not one `$`.
  assert.equal(cacheCostText(e, NOW, tcfg, NO_PRICING, false),
    'A cold start after 14:52 re-writes 152.3K tokens at the 1 h write rate (2× input) instead of reading them from the cache (0.05× input).')
  assert.equal(german(() => cacheCostText(cold, NOW + MIN, tcfg, NO_PRICING, false)),
    'Die nächste Anfrage schreibt 152,3K Token zum 1-h-Schreibpreis neu (2× Eingabe), statt sie aus dem Cache zu lesen (0,05× Eingabe).')
  // The contract multiplier scales the money, never the factors.
  assert.equal(cacheCostText(e, NOW, tcfg, { multiplier: 0.5 }, true),
    'A cold start after 14:52 re-writes 152.3K tokens at the 1 h write rate (2× input, ~$0.61) instead of reading them from the cache (0.05× input, ~$0.02).')
})

test('no borrowed rate: an unpriced model, a family price and a missing model give the words alone; a custom price gives its own factors', () => {
  const words = 'A cold start after 14:52 re-writes 152.3K tokens instead of reading them from the cache.'
  assert.equal(cacheCostText(entry({ model: 'claude-experimental-x' }), NOW, tcfg, NO_PRICING, true), words)
  assert.equal(cacheCostText(entry({ model: null }), NOW, tcfg, NO_PRICING, true), words)
  // The opt-in family fallback prices the dashboard's tables; the comparison does not borrow it.
  const family: PricingOptions = { unknownModel: 'family' }
  assert.equal(priceOf('claude-opus-9', dayOf(NOW, tcfg), family)?.confidence, 'family')
  assert.equal(cacheCostText(entry({ model: 'claude-opus-9' }), NOW, tcfg, family, true), words)
  assert.equal(cacheCostText(entry({ model: 'claude-opus-9', phase: 'cold' }), NOW + MIN, tcfg, family, true),
    'The next request re-writes 152.3K tokens instead of reading them from the cache.')
  // The user's own rates are shown, as the dashboard shows them.
  const custom: PricingOptions = { overrides: { 'claude-opus-5-5': { input: 10, cacheWrite1h: 25, cacheRead: 1 } } }
  assert.equal(cacheCostText(entry(), NOW, tcfg, custom, false),
    'A cold start after 14:52 re-writes 152.3K tokens at the 1 h write rate (2.5× input) instead of reading them from the cache (0.1× input).')
  // An unknown or empty size: no cost line at all.
  assert.equal(cacheCostText(entry({ recache: null }), NOW, tcfg, NO_PRICING, true), null)
  assert.equal(cacheCostText(entry({ recache: 0 }), NOW, tcfg, NO_PRICING, true), null)
})

test('a transcript entry\'s count and time carry ~; a bridge entry\'s do not', () => {
  const t = entry({ source: 'transcript' })
  assert.equal(cacheCostText(t, NOW, tcfg, NO_PRICING, true),
    'A cold start after ~14:52 re-writes ~152.3K tokens at the 1 h write rate (2× input, ~$1.22) instead of reading them from the cache (0.05× input, ~$0.03).')
  assert.equal(cacheCostText({ ...t, phase: 'cold' }, NOW + MIN, tcfg, NO_PRICING, false),
    'The next request re-writes ~152.3K tokens at the 1 h write rate (2× input) instead of reading them from the cache (0.05× input).')
  assert.equal(german(() => cacheCostText(t, NOW, tcfg, NO_PRICING, false)),
    'Ein Kaltstart nach ~14:52 schreibt ~152,3K Token zum 1-h-Schreibpreis neu (2× Eingabe), statt sie aus dem Cache zu lesen (0,05× Eingabe).')
  const b = cacheCostText(entry(), NOW, tcfg, NO_PRICING, false) ?? ''
  assert.equal(b.includes('~'), false, b)
})

test('factorText: three significant digits at most, the locale\'s decimal mark, no trailing zero', () => {
  const cases: Array<[number, string, string]> = [[2, '2', '2'], [1.25, '1.25', '1,25'], [0.1, '0.1', '0,1'],
    [0.05, '0.05', '0,05'], [0.025, '0.025', '0,025'], [2.0000000001, '2', '2'], [0.1 + 0.2, '0.3', '0,3']]
  for (const [n, en, de] of cases) {
    assert.equal(factorText(n), en, String(n))
    assert.equal(german(() => factorText(n)), de, String(n))
  }
  for (const n of [1 / 3, 2 / 3, 123.456, 0.012345, 1234.5, 7 / 9]) {
    const digits = factorText(n).replace(/^0\.0*/, '').replace(/[^0-9]/g, '').replace(/0+$/, '')
    assert.ok(digits.length <= 3, `${n} → ${factorText(n)}`)
  }
  assert.equal(factorText(1 / 3), '0.333')
  assert.equal(factorText(1234.5), '1230')
  assert.equal(factorText(Number.NaN), '–')
})

// ---------------------------------------------------------------------------
// §3 A6 · Codex (A8 test 15)
// ---------------------------------------------------------------------------

test('Codex: a GPT-5.6 turn within 30 minutes gives the "at least until" line, none after; no cost, no countdown', () => {
  assert.equal(CODEX_RETENTION_MS, 30 * MIN)
  const at = NOW - 10 * MIN
  const line = codexCacheText({ at, model: 'gpt-5.6-sol' }, NOW, tcfg)
  assert.equal(line, 'Codex prompt cache · last request at 14:37 · OpenAI keeps a cached prompt prefix at least 30 minutes after its last use for GPT-5.6 and later — ~until 15:07, perhaps longer.')
  // The minutes the sentence names are the constant's.
  assert.ok(line?.includes(`at least ${CODEX_RETENTION_MS / MIN} minutes`))
  assert.equal(german(() => codexCacheText({ at, model: 'gpt-5.6-sol' }, NOW, tcfg)),
    'Codex-Prompt-Cache · letzte Anfrage um 14:37 · OpenAI hält einen zwischengespeicherten Prompt-Anfang bei GPT-5.6 und neuer mindestens 30 Minuten nach der letzten Nutzung — ~bis 15:07, womöglich länger.')
  for (const word of ['$', '×', 'input', 'cools', 'cold']) assert.equal(line?.includes(word), false, word)
  assert.equal(codexCacheText({ at: NOW - 31 * MIN, model: 'gpt-5.6-sol' }, NOW, tcfg), null)
  assert.equal(codexCacheText({ at: NOW - CODEX_RETENTION_MS, model: 'gpt-5.6-sol' }, NOW, tcfg), null)
  assert.ok(codexCacheText({ at: NOW - CODEX_RETENTION_MS + 1000, model: 'gpt-5.6-sol' }, NOW, tcfg))
  assert.equal(codexCacheText(null, NOW, tcfg), null)
  // Mutation check (§3 A8 test 15): dropping codexRetentionKnown gives this model a line.
  assert.equal(codexCacheText({ at, model: 'gpt-5.5' }, NOW, tcfg), null)
})

test('Codex: a turn dated after now (a clock ahead of this one) gives no line; within BRIDGE_SKEW_MS it does (1.8 P9, §7c wave 2 fact 11)', () => {
  // Without the guard a rollout written 5 minutes ahead read "last request at 14:52 … ~until 15:22"
  // at 14:47 — a request still to come.
  assert.equal(codexCacheText({ at: NOW + 5 * MIN, model: 'gpt-5.6-sol' }, NOW, tcfg), null)
  assert.equal(codexCacheText({ at: NOW + BRIDGE_SKEW_MS + 1, model: 'gpt-5.6-sol' }, NOW, tcfg), null)
  assert.ok(codexCacheText({ at: NOW + BRIDGE_SKEW_MS, model: 'gpt-5.6-sol' }, NOW, tcfg), 'a few seconds of skew are slack, as for the bridge')
  assert.ok(codexCacheText({ at: NOW, model: 'gpt-5.6-sol' }, NOW, tcfg))
  // Nothing else of the line changes: the words of a turn 10 minutes ago are the same.
  assert.equal(codexCacheText({ at: NOW - 10 * MIN, model: 'gpt-5.6-sol' }, NOW, tcfg),
    'Codex prompt cache · last request at 14:37 · OpenAI keeps a cached prompt prefix at least 30 minutes after its last use for GPT-5.6 and later — ~until 15:07, perhaps longer.')
})

test('codexRetentionKnown: GPT-5.6 and later and GPT-6, not the models with another retention', () => {
  for (const m of ['gpt-5.6-sol', 'gpt-5.6-luna', 'gpt-6-astra', 'gpt-6.1', 'gpt-5.6', 'gpt-5.10', 'gpt-7', 'openai/GPT-5.6-Terra', 'gpt-10']) {
    assert.equal(codexRetentionKnown(m), true, m)
  }
  for (const m of ['gpt-5.5', 'gpt-5.4', 'gpt-5', 'gpt-5-mini', 'gpt-5.3-codex', 'gpt-5.5-pro', 'gpt-4.1', 'gpt-5.06', 'claude-opus-5-5', '']) {
    assert.equal(codexRetentionKnown(m), false, m)
  }
})
