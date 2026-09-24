// SPDX-FileCopyrightText: 2026 Frederik Marx
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * 1.8 A: the prompt-cache watch — which Claude Code sessions' one-hour prompt cache is about to go
 * cold, or went cold within the last hour, and what a cold start would cost against a cache read.
 *
 * Two sources describe a session, and exactly one of them describes it at a time (A1):
 *
 *  • the status-line bridge — `QuotaManager.promptCacheReadings()`, one reading per session id, the
 *    TTL, the expiry and the size a cold start re-caches exactly as Claude Code states them; and
 *  • the session's transcript — `MainRec.lastRequest`, the newest request that read or wrote the
 *    cache: its time plus the TTL is an ESTIMATE of the expiry, its size an estimate of the prefix,
 *    so every figure of it carries `~` and every line of it says "estimated from the transcript".
 *
 * The bridge wins while its reading is not older than the newest request the transcript counted
 * (BRIDGE_SKEW_MS of slack); otherwise the status line has not run since that request and its
 * reading describes an older turn. Nothing is merged across the two: a figure is the bridge's or the
 * transcript's, never a splice. Only a 1-hour cache is watched (Frederik: „Nur den 60 Minuten Cache
 * beachten") — a 5-minute cache would be "cooling" after every reply and keeps the 1.3 line.
 *
 * Every sentence is one whole template per phase and source, so a translator never sees half of one
 * (promptCache.ts's rule). No factor and no price is a literal here: the cost line divides the price
 * table's own rates (`cacheRatesOf`).
 *
 * Pure: `now`, the time configuration and the pricing options come in as parameters.
 */

import { sessionIdName, sessionName } from './agentTreeBuild'
import { locale, t } from './i18n'
import { PricingOptions, cacheRatesOf, normalizeModel } from './prices'
import { countdownText } from './promptCache'
import { STATUSLINE_SESSION_RE } from './quota'
import type { PromptCacheReading } from './quotaSources'
import { estimate } from './render'
import { costText, tokens } from './stats'
import { TimeConfig, clockStamp, dayOf } from './time'
import type { CodexTurn, LastRequest, MainRec } from './types'

/** Frederik: „Falls er 5 Minuten vor Erkalten ist" — the lead before a 1 h cache's expiry at which it counts as cooling. */
export const CACHE_COOLING_LEAD_MS = 5 * 60_000
/** How long a cold 1 h cache stays listed after its expiry. */
export const CACHE_COLD_SHOWN_MS = 60 * 60_000
/** Lines on the card, in the Quick Pick and in a tooltip; the markdown lists up to CACHE_TEXT_MAX. */
export const CACHE_WATCH_MAX = 3
export const CACHE_TEXT_MAX = 10
/** A bridge reading this much older than the transcript's newest request no longer describes that request. */
export const BRIDGE_SKEW_MS = 10_000
export const TTL_MS: Readonly<Record<'5m' | '1h', number>> = Object.freeze({ '5m': 5 * 60_000, '1h': 60 * 60_000 })

export type CachePhase = 'warm' | 'cooling' | 'cold'
export type CacheSource = 'bridge' | 'transcript'

export interface CacheWatchEntry {
  sessionId: string
  /** The Agents tree's name of the session — `sessionName` ("Session Tue 14:20 · 9d0eb37a"), `sessionIdName` without a record. */
  name: string
  source: CacheSource
  /** Always '1h': only a 1 h cache is watched (Frederik, collect #2a). */
  ttl: '1h'
  /** Unix ms — the bridge's `expires_at`, or the transcript's `lastRequest.at + TTL_MS['1h']`. */
  expiresAt: number
  phase: CachePhase
  /** Tokens a cold start re-writes: the bridge's `recache_tokens_if_cold`, or `lastRequest.context`; null when unknown. */
  recache: number | null
  /** Whose prices the cost line takes: the bridge reading's `model.id`, or `lastRequest.model`; null when unknown. */
  model: string | null
}

export interface WatchInput {
  readings: readonly PromptCacheReading[]
  mains: ReadonlyArray<readonly [file: string, rec: MainRec]>
  tcfg: TimeConfig
}

/**
 * The phase of a 1 h cache that expires at `expiresAt` (A2): warm until CACHE_COOLING_LEAD_MS before
 * it, cooling from then to the expiry, cold for CACHE_COLD_SHOWN_MS after it, and null — not listed —
 * after that.
 */
export function cachePhase(expiresAt: number, now: number): CachePhase | null {
  if (!Number.isFinite(expiresAt) || !Number.isFinite(now)) return null
  if (now < expiresAt - CACHE_COOLING_LEAD_MS) return 'warm'
  if (now < expiresAt) return 'cooling'
  if (now < expiresAt + CACHE_COLD_SHOWN_MS) return 'cold'
  return null
}

/** Cooling first, soonest expiry first; then cold, the most recent first; then warm, soonest first. */
const PHASE_RANK: Readonly<Record<CachePhase, number>> = { cooling: 0, cold: 1, warm: 2 }

function byUrgency(a: CacheWatchEntry, b: CacheWatchEntry): number {
  const rank = PHASE_RANK[a.phase] - PHASE_RANK[b.phase]
  if (rank !== 0) return rank
  const when = a.phase === 'cold' ? b.expiresAt - a.expiresAt : a.expiresAt - b.expiresAt
  if (when !== 0) return when
  return a.sessionId < b.sessionId ? -1 : a.sessionId > b.sessionId ? 1 : 0
}

function finite(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v)
}

/** A record's `lastRequest` as the watch may use it — checked again, as every value of a record is. */
function lastRequestOf(rec: MainRec | null): LastRequest | null {
  const r = rec?.lastRequest
  if (!r || typeof r !== 'object') return null
  return finite(r.at) && r.at > 0 && finite(r.context) && r.context >= 0 ? r : null
}

/** The start the Agents tree names a session by (agentTreeBuild's `firstOf`), or null. */
function startOf(rec: MainRec): number | null {
  const last = finite(rec.lastTs) && rec.lastTs > 0 ? rec.lastTs : null
  if (last === null) return null
  return finite(rec.firstTs) && rec.firstTs > 0 ? Math.min(rec.firstTs, last) : last
}

/** Of two records of one session id (one transcript moved or copied), the one with the newer request. */
function newerMain(a: MainRec, b: MainRec): boolean {
  const at = (r: MainRec): number => lastRequestOf(r)?.at ?? (finite(r.lastTs) ? r.lastTs : -Infinity)
  return at(a) > at(b)
}

/**
 * A1 rule 3: the bridge describes the session when the transcript counted no cache request of it, or
 * when the status line ran after the newest one (less BRIDGE_SKEW_MS). A reading without a time is
 * never taken over a request the transcript knows the time of.
 */
function bridgeDescribes(reading: PromptCacheReading, last: LastRequest | null): boolean {
  if (last === null) return true
  return finite(reading.readAt) && reading.readAt * 1000 >= last.at - BRIDGE_SKEW_MS
}

function entryOf(
  sessionId: string, reading: PromptCacheReading | null, main: MainRec | null, now: number, tcfg: TimeConfig,
): CacheWatchEntry | null {
  const last = lastRequestOf(main)
  let source: CacheSource
  let expiresAt: number
  let recache: number | null
  let model: string | null
  if (reading !== null && bridgeDescribes(reading, last)) {
    // The bridge knows the newest request: whatever it says is the session's state, and the
    // transcript does not override it (A1 rule 5) — a 5-minute cache, no TTL, no expiry, or a
    // cache it calls not warm before its stated expiry is not watched.
    if (reading.ttl !== '1h' || !finite(reading.expiresAt)) return null
    if (reading.warm === false && reading.expiresAt > now) return null
    source = 'bridge'
    expiresAt = reading.expiresAt
    recache = finite(reading.recacheIfCold) && reading.recacheIfCold >= 0 ? reading.recacheIfCold : null
    model = typeof reading.model === 'string' && reading.model !== '' ? reading.model : null
  } else if (last !== null) {
    if (last.ttl !== '1h' || !(last.context > 0)) return null
    source = 'transcript'
    expiresAt = last.at + TTL_MS['1h']
    recache = last.context
    model = typeof last.model === 'string' && last.model !== '' ? last.model : null
  } else {
    return null
  }
  // A one-hour cache has at most an hour left. An expiry further out than that (BRIDGE_SKEW_MS of
  // slack) rests on a clock ahead of this one — a transcript dated in the future, a copied directory —
  // and says nothing about the cache now: not watched, rather than "cools in 3 h 14 m".
  if (expiresAt - now > TTL_MS['1h'] + BRIDGE_SKEW_MS) return null
  const phase = cachePhase(expiresAt, now)
  if (phase === null) return null
  const start = main ? startOf(main) : null
  return {
    sessionId,
    // A reading whose id no transcript here knows (a remote host, a relocated root) stands alone,
    // named by its id: "Session 9d0eb37a".
    name: main ? sessionName(sessionId, start, now, tcfg) : sessionIdName(sessionId),
    source,
    ttl: '1h',
    expiresAt,
    phase,
    recache,
    model,
  }
}

/**
 * Every watched session, in the order of A2 — cooling by expiry, then cold with the most recent first,
 * then warm by expiry; ties by session id — at most `max` (CACHE_TEXT_MAX). A session appears once.
 * The view model passes Infinity to count what lies beyond its caps.
 */
export function watchCaches(input: WatchInput, now: number, max: number = CACHE_TEXT_MAX): CacheWatchEntry[] {
  const mains = new Map<string, MainRec>()
  for (const pair of input.mains) {
    const rec = pair?.[1]
    if (!rec || typeof rec.sessionId !== 'string' || rec.sessionId === '') continue
    const have = mains.get(rec.sessionId)
    if (!have || newerMain(rec, have)) mains.set(rec.sessionId, rec)
  }
  const readings = new Map<string, PromptCacheReading>()
  for (const r of input.readings) {
    // Never one session's reading for another: a reading without a usable id is not watched.
    if (!r || typeof r.sessionId !== 'string' || !STATUSLINE_SESSION_RE.test(r.sessionId)) continue
    const have = readings.get(r.sessionId)
    const at = (x: PromptCacheReading): number => (finite(x.readAt) ? x.readAt : -Infinity)
    if (!have || at(r) > at(have)) readings.set(r.sessionId, r)
  }
  const out: CacheWatchEntry[] = []
  for (const id of new Set([...readings.keys(), ...mains.keys()])) {
    const e = entryOf(id, readings.get(id) ?? null, mains.get(id) ?? null, now, input.tcfg)
    if (e !== null) out.push(e)
  }
  out.sort(byUrgency)
  return out.slice(0, Math.max(0, max))
}

/**
 * The state words of A3 — one whole template per phase and source. `{0}` is the session's name,
 * `{1}` the countdown to the expiry ("4 m 10 s") while warm or cooling, and the expiry as a clock
 * time ("14:52", on another day "2026-09-23 14:52") once cold. A transcript line marks its time `~`
 * and says in words that it is an estimate, so the `~` is never alone.
 */
export function cacheLineText(e: CacheWatchEntry, now: number, tcfg: TimeConfig): string {
  const bridge = e.source === 'bridge'
  switch (e.phase) {
    case 'warm': {
      const left = countdownText(e.expiresAt - now)
      return bridge
        ? t('{0} · prompt cache warm · cools in {1} (1 h TTL)', e.name, left)
        : t('{0} · prompt cache warm · cools in ~{1} (1 h TTL, estimated from the transcript)', e.name, left)
    }
    case 'cooling': {
      const left = countdownText(e.expiresAt - now)
      return bridge
        ? t('{0} · prompt cache cools in {1} (1 h TTL)', e.name, left)
        : t('{0} · prompt cache cools in ~{1} (1 h TTL, estimated from the transcript)', e.name, left)
    }
    default: {
      const since = clockStamp(e.expiresAt, now, tcfg)
      return bridge
        ? t('{0} · prompt cache cold since {1} (1 h TTL)', e.name, since)
        : t('{0} · prompt cache cold since ~{1} (1 h TTL, estimated from the transcript)', e.name, since)
    }
  }
}

/**
 * A4: the rates the comparison may print — the table's own (`exact`) or the user's (`custom`); a
 * borrowed price (`family`), a model without a price and an input rate of nothing leave the line
 * without factors and without money.
 */
function comparableRates(
  model: string | null, day: string, pricing: PricingOptions,
): { input: number; write1h: number; read: number } | null {
  if (model === null) return null
  const r = cacheRatesOf(model, day, pricing)
  if (r === null || r.confidence === 'family' || !(r.input > 0)) return null
  return r
}

/**
 * The cost comparison of A4 (every phase; the card shows it for cooling and cold only), or null when
 * the size a cold start re-writes is unknown or nothing. The tokens are the bridge's count or the
 * transcript's estimate (`~`); the factors divide the day's rates of the model — the user's prices
 * merged, the contract multiplier applied, standard speed —; the money is the page's hypothetical API
 * amount, always `~`, and only while costs are shown.
 */
export function cacheCostText(
  e: CacheWatchEntry, now: number, tcfg: TimeConfig, pricing: PricingOptions, showCost: boolean,
): string | null {
  const n = e.recache
  if (n === null || !finite(n) || n <= 0) return null
  const estimated = e.source === 'transcript'
  const count = estimated ? estimate(tokens(n)) : tokens(n)
  const rates = comparableRates(e.model, dayOf(now, tcfg), pricing)
  const write = rates ? factorText(rates.write1h / rates.input) : ''
  const read = rates ? factorText(rates.read / rates.input) : ''
  const coldMoney = rates ? costText((n * rates.write1h) / 1e6) : ''
  const warmMoney = rates ? costText((n * rates.read) / 1e6) : ''
  if (e.phase === 'cold') {
    if (!rates) return t('The next request re-writes {0} tokens instead of reading them from the cache.', count)
    return showCost
      ? t('The next request re-writes {0} tokens at the 1 h write rate ({1}× input, {2}) instead of reading them from the cache ({3}× input, {4}).',
        count, write, coldMoney, read, warmMoney)
      : t('The next request re-writes {0} tokens at the 1 h write rate ({1}× input) instead of reading them from the cache ({2}× input).',
        count, write, read)
  }
  const after = estimated ? estimate(clockStamp(e.expiresAt, now, tcfg)) : clockStamp(e.expiresAt, now, tcfg)
  if (!rates) return t('A cold start after {0} re-writes {1} tokens instead of reading them from the cache.', after, count)
  return showCost
    ? t('A cold start after {0} re-writes {1} tokens at the 1 h write rate ({2}× input, {3}) instead of reading them from the cache ({4}× input, {5}).',
      after, count, write, coldMoney, read, warmMoney)
    : t('A cold start after {0} re-writes {1} tokens at the 1 h write rate ({2}× input) instead of reading them from the cache ({3}× input).',
      after, count, write, read)
}

/** "2", "0.05", "0.025" — at most three significant digits, the locale's decimal mark, no trailing zero. */
export function factorText(n: number): string {
  if (!Number.isFinite(n)) return '–'
  return n.toLocaleString(locale(), { maximumSignificantDigits: 3, useGrouping: false })
}

/**
 * A3: the line after the capped ones — "1 more session with a cooling or cold prompt cache", or null
 * when there is none. Two whole sentences, because the count governs the noun.
 */
export function cacheMoreText(n: number): string | null {
  if (!(n > 0)) return null
  return n === 1
    ? t('1 more session with a cooling or cold prompt cache')
    : t('{0} more sessions with a cooling or cold prompt cache', n)
}

// ---------------------------------------------------------------------------
// A6 · Codex
// ---------------------------------------------------------------------------

/**
 * OpenAI's documented minimum retention of a cached prompt prefix for GPT-5.6 and later: "A cached
 * prefix remains eligible for reuse for 30 minutes after its most recent write or reuse, though
 * OpenAI may retain it longer" — a minimum, not an expiry, so the Codex line has no cooling phase.
 */
export const CODEX_RETENTION_MS = 30 * 60_000

/** gpt-5.6 … gpt-5.99, gpt-6 and later (with or without a minor version), then a suffix or the end. */
const CODEX_RETENTION_RE = /^gpt-(?:5\.(?:[6-9]|[1-9]\d)|(?:[6-9]|[1-9]\d)(?:\.\d+)?)(?:-|$)/

/** GPT-5.6 and later, and GPT-6 — the models OAI-cache documents the 30-minute minimum for. */
export function codexRetentionKnown(model: string): boolean {
  return typeof model === 'string' && CODEX_RETENTION_RE.test(normalizeModel(model))
}

/**
 * A6: the Codex card's one line — when the newest turn was, and until when OpenAI keeps its prefix at
 * least ("~until 14:52, perhaps longer") — or null: no turn, a turn more than CODEX_RETENTION_MS ago,
 * or a model the minimum is not documented for. No cost, no countdown: whether the API's rules hold
 * for Codex traffic on a ChatGPT plan is not known, and a minimum says nothing about the end.
 */
export function codexCacheText(turn: CodexTurn | null, now: number, tcfg: TimeConfig): string | null {
  if (!turn || !finite(turn.at) || turn.at <= 0 || !(now < turn.at + CODEX_RETENTION_MS)) return null
  if (!codexRetentionKnown(turn.model)) return null
  return t('Codex prompt cache · last request at {0} · OpenAI keeps a cached prompt prefix at least 30 minutes after its last use for GPT-5.6 and later — ~until {1}, perhaps longer.',
    clockStamp(turn.at, now, tcfg), clockStamp(turn.at + CODEX_RETENTION_MS, now, tcfg))
}
