// SPDX-FileCopyrightText: 2026 Frederik Marx
// SPDX-License-Identifier: AGPL-3.0-or-later

import { Bucket } from './types'

/**
 * Provider list prices, in USD per 1M tokens, as dated rules.
 *
 * IMPORTANT: anyone working through a subscription (Claude Pro/Max, ChatGPT/Codex)
 * does NOT pay these amounts. The figure only answers "what would this same usage
 * have cost through the API" — it has no billing relationship.
 *
 * Every rule carries the day the rate was read from the published table (`from`) and
 * names that table (`source`). A rate therefore never applies retroactively without
 * being visible as such: for a day that no rule covers, `priceOf` still answers with
 * the nearest known rule but flags the answer `approximate`, so the display layer can
 * mark it. Guessing is never silent — that is the whole point of this module.
 */

/** Day the table below was last checked against the published price lists. */
export const PRICES_AS_OF = '2026-09-02'

/**
 * Legacy Anthropic rows (Claude 4.x and 3.x) come from an older check of the same
 * table. Their `from` day is that check date, NOT the model's launch day — nobody
 * published a price history, so this is the earliest day for which the rate is proven.
 */
const LEGACY_CHECKED = '2026-08-13'

/** Human-readable provenance, shown in the dashboard footer and the cost tooltip. */
export const PRICE_SOURCES = [
  `Anthropic model and pricing table — docs.claude.com (checked ${PRICES_AS_OF}, legacy rows ${LEGACY_CHECKED})`,
  `OpenAI API pricing — developers.openai.com/api/docs/pricing (checked ${PRICES_AS_OF})`,
  `Anthropic web search — $10 per 1,000 searches, docs.claude.com (checked ${PRICES_AS_OF})`,
]

/** Anthropic bills web search per request, not per token; web fetch is free. */
export const WEB_SEARCH_USD_PER_1K = 10

/** Surcharge for requests pinned to US-only inference (`usage.inference_geo === 'us'`). */
export const US_INFERENCE_MULTIPLIER = 1.1

export interface ModelPrice {
  input: number
  output: number
  cacheRead: number
  cacheWrite5m: number
  cacheWrite1h: number
  /**
   * Fast-mode rates, only for models whose fast rates the table actually states.
   * Absent means unknown — such usage is reported as unpriced, never billed at the
   * standard rate (that would understate fast turns by a factor of 2–6).
   */
  fast?: { input: number; output: number }
}

export interface PriceRule extends ModelPrice {
  /** First day (YYYY-MM-DD) this rate is known to apply — the day the table was read. */
  from: string
  /** First day it no longer applies; absent = still current. */
  until?: string
  /** Which table, checked when. */
  source: string
}

/**
 * Anthropic: cache prices are fixed multiples of the input rate — write 1.25x
 * for the 5-minute TTL, 2x for the 1-hour TTL, read 0.1x.
 *
 * `cacheRead` overrides that last multiple, because it is not universal: Fable
 * 5.1 reads cache at a flat $0.25/MTok, a quarter of what the rule would give.
 * Guessing it from the multiple would overstate cache-heavy usage fourfold.
 */
function anthropic(input: number, output: number, cacheRead = input * 0.1): ModelPrice {
  return {
    input,
    output,
    cacheRead,
    cacheWrite5m: input * 1.25,
    cacheWrite1h: input * 2,
  }
}

/** OpenAI: the cached-read rate is stated separately; cache writes are not charged. */
function openai(input: number, cachedInput: number, output: number): ModelPrice {
  return { input, output, cacheRead: cachedInput, cacheWrite5m: 0, cacheWrite1h: 0 }
}

/** One dated rule from the Anthropic table; `from` doubles as the check date. */
function anthropicRule(from: string, price: ModelPrice): PriceRule {
  return { ...price, from, source: `docs.claude.com model table (checked ${from})` }
}

/** One dated rule from the OpenAI pricing page. */
function openaiRule(from: string, price: ModelPrice): PriceRule {
  return { ...price, from, source: `developers.openai.com/api/docs/pricing (checked ${from})` }
}

/**
 * Dated rules per model, newest first. One entry per model is the normal case: a
 * provider publishes today's rate, not a history. A second entry is added only when
 * a rate change is actually documented, with the old rule given an `until` day.
 */
export const PRICES: Record<string, PriceRule[]> = {
  // ---- Anthropic, current table ----
  'claude-fable-5-1': [anthropicRule(PRICES_AS_OF, anthropic(10, 50, 0.25))],
  // Same tier and per-token price as Fable 5.1, but its cache-read rate was not
  // confirmed at launch — the standard 0.1x applies until it is.
  'claude-mythos-5-1': [anthropicRule(PRICES_AS_OF, anthropic(10, 50))],
  'claude-fable-5': [anthropicRule(PRICES_AS_OF, anthropic(10, 50))],
  'claude-mythos-5': [anthropicRule(PRICES_AS_OF, anthropic(10, 50))],
  'claude-opus-5': [anthropicRule(PRICES_AS_OF, anthropic(5, 25))],
  'claude-opus-4-8': [anthropicRule(PRICES_AS_OF, anthropic(5, 25))],
  'claude-opus-4-7': [anthropicRule(PRICES_AS_OF, anthropic(5, 25))],
  // The only model whose fast-mode rates the table states (6x the standard rate).
  // For every other model fast mode counts as unpriced, reason 'fast rate unknown'.
  'claude-opus-4-6': [
    anthropicRule(PRICES_AS_OF, { ...anthropic(5, 25), fast: { input: 30, output: 150 } }),
  ],
  'claude-sonnet-5': [anthropicRule(PRICES_AS_OF, anthropic(2, 10))],
  'claude-sonnet-4-6': [anthropicRule(PRICES_AS_OF, anthropic(3, 15))],
  'claude-haiku-4-5': [anthropicRule(PRICES_AS_OF, anthropic(1, 5))],
  // ---- Anthropic, legacy (still reachable through the API; without these rows the
  // models ran as "unpriced"). Dates are the check date of the table, not the launch. ----
  'claude-opus-4-1': [anthropicRule(LEGACY_CHECKED, anthropic(15, 75))],
  'claude-opus-4': [anthropicRule(LEGACY_CHECKED, anthropic(15, 75))],
  'claude-sonnet-4-5': [anthropicRule(LEGACY_CHECKED, anthropic(3, 15))],
  'claude-sonnet-4': [anthropicRule(LEGACY_CHECKED, anthropic(3, 15))],
  'claude-3-7-sonnet': [anthropicRule(LEGACY_CHECKED, anthropic(3, 15))],
  'claude-3-5-sonnet': [anthropicRule(LEGACY_CHECKED, anthropic(3, 15))],
  'claude-3-5-haiku': [anthropicRule(LEGACY_CHECKED, anthropic(0.8, 4))],
  'claude-3-haiku': [anthropicRule(LEGACY_CHECKED, anthropic(0.25, 1.25))],
  'claude-3-opus': [anthropicRule(LEGACY_CHECKED, anthropic(15, 75))],
  // ---- OpenAI ----
  'gpt-5.6-sol': [openaiRule(PRICES_AS_OF, openai(4, 0.4, 20))],
  'gpt-5.6-terra': [openaiRule(PRICES_AS_OF, openai(2, 0.2, 12))],
  'gpt-5.6-luna': [openaiRule(PRICES_AS_OF, openai(0.2, 0.02, 1.2))],
  'gpt-5.6-cyber': [openaiRule(PRICES_AS_OF, openai(12.5, 1.25, 75))],
  'gpt-5.5': [openaiRule(PRICES_AS_OF, openai(5, 0.5, 30))],
  'gpt-5.5-pro': [openaiRule(PRICES_AS_OF, openai(30, 0, 180))],
  'gpt-5.4': [openaiRule(PRICES_AS_OF, openai(2.5, 0.25, 15))],
  'gpt-5.4-mini': [openaiRule(PRICES_AS_OF, openai(0.75, 0.075, 4.5))],
  'gpt-5.4-nano': [openaiRule(PRICES_AS_OF, openai(0.2, 0.02, 1.25))],
  'gpt-5.3-codex': [openaiRule(PRICES_AS_OF, openai(1.75, 0.175, 14))],
  'gpt-5.2': [openaiRule(PRICES_AS_OF, openai(1.75, 0.175, 14))],
  'gpt-5.1': [openaiRule(PRICES_AS_OF, openai(1.25, 0.125, 10))],
  'gpt-5': [openaiRule(PRICES_AS_OF, openai(1.25, 0.125, 10))],
  'gpt-5-mini': [openaiRule(PRICES_AS_OF, openai(0.25, 0.025, 2))],
  'gpt-5-nano': [openaiRule(PRICES_AS_OF, openai(0.05, 0.005, 0.4))],
  'gpt-5-pro': [openaiRule(PRICES_AS_OF, openai(15, 0, 120))],
}

/**
 * "claude-haiku-4-5-20251001" -> "claude-haiku-4-5", "claude-opus-5[1m]" -> "claude-opus-5",
 * "anthropic/Claude-Opus-5" -> "claude-opus-5". Gateways and routers prefix the vendor and
 * vary the case; the table is keyed on the bare lower-case name.
 */
export function normalizeModel(model: string): string {
  let s = String(model ?? '').trim().toLowerCase()
  // Strip vendor routing prefixes ("anthropic/", "openai/", "openrouter/anthropic/").
  const slash = s.lastIndexOf('/')
  if (slash >= 0) s = s.slice(slash + 1)
  return s
    .replace(/\[[^\]]*\]$/, '')
    .replace(/-\d{8}$/, '')
    .trim()
}

/**
 * Month buckets carry "YYYY-MM". Dating them to the first of the month keeps the older
 * rule in force for the whole month: a rate change mid-month counts from the next one,
 * which under-, never overstates a rise.
 */
function dayKey(day: string): string {
  return /^\d{4}-\d{2}$/.test(day) ? `${day}-01` : day
}

/**
 * The rule in force on `day`. When no rule covers the day — usage older than the first
 * check, or after an `until` with no successor — the nearest known rule is returned with
 * `approximate: true`: the best available approximation, and marked as one.
 *
 * Exported so tests and callers with their own rule list can use the same selection.
 */
export function ruleForDay(
  rules: PriceRule[],
  day: string,
): { rule: PriceRule; approximate: boolean } | null {
  if (!rules.length) return null
  const d = dayKey(day)
  let match: PriceRule | null = null
  let newestBefore: PriceRule | null = null
  let oldest: PriceRule = rules[0]
  for (const r of rules) {
    if (r.from < oldest.from) oldest = r
    if (r.from <= d) {
      if (!newestBefore || r.from > newestBefore.from) newestBefore = r
      const covered = r.until === undefined || d < r.until
      if (covered && (!match || r.from > match.from)) match = r
    }
  }
  if (match) return { rule: match, approximate: false }
  return { rule: newestBefore ?? oldest, approximate: true }
}

/** Drop the bookkeeping fields — consumers price with rates, not with provenance. */
function toPrice(r: PriceRule): ModelPrice {
  const p: ModelPrice = {
    input: r.input,
    output: r.output,
    cacheRead: r.cacheRead,
    cacheWrite5m: r.cacheWrite5m,
    cacheWrite1h: r.cacheWrite1h,
  }
  if (r.fast) p.fast = { ...r.fast }
  return p
}

/**
 * Family of a model name, for the opt-in fallback:
 *   claude-<family>-<version…>  and the older claude-<version…>-<family>  -> "claude-<family>"
 *     ("claude-opus-4-9" and "claude-3-opus" both -> "claude-opus")
 *   gpt-<major>[.<minor>][-<suffix>] -> "gpt-<major>[-<suffix>]"
 *     ("gpt-5.7" -> "gpt-5", "gpt-5.7-mini" -> "gpt-5-mini", "gpt-5.3-codex" -> "gpt-5-codex")
 * Anything else: the name with its trailing version groups removed.
 */
function familyOf(normalized: string): string | null {
  if (!normalized) return null
  const parts = normalized.split('-')
  if (parts[0] === 'claude') {
    const name = parts.slice(1).find((p) => p.length > 0 && !/^\d/.test(p))
    return name ? `claude-${name}` : null
  }
  if (parts[0] === 'gpt') {
    const major = (parts[1] ?? '').split('.')[0]
    if (!/^\d+$/.test(major)) return null
    const suffix = parts.slice(2).filter((p) => p.length > 0 && !/^\d/.test(p))
    return ['gpt', major, ...suffix].join('-')
  }
  const stripped = normalized.replace(/(?:-\d+(?:\.\d+)*)+$/, '')
  return stripped || null
}

/** Version tuple for "newest wins": "gpt-5.6-sol" -> [5,6], "claude-opus-4-8" -> [4,8]. */
function versionOf(normalized: string): number[] {
  const groups = normalized.match(/\d+(?:\.\d+)*/g) ?? []
  return groups.join('.').split('.').filter((s) => s.length > 0).map(Number)
}

function newerVersion(a: number[], b: number[]): boolean {
  const n = Math.max(a.length, b.length)
  for (let i = 0; i < n; i++) {
    const x = a[i] ?? 0
    const y = b[i] ?? 0
    if (x !== y) return x > y
  }
  return false
}

/** Newest priced model of the same family, or null. Never used unless opted in. */
function familyMatch(key: string): string | null {
  const fam = familyOf(key)
  if (!fam) return null
  let best: string | null = null
  let bestVersion: number[] = []
  for (const candidate of Object.keys(PRICES)) {
    if (candidate === key || familyOf(candidate) !== fam) continue
    const v = versionOf(candidate)
    if (!best || newerVersion(v, bestVersion)) {
      best = candidate
      bestVersion = v
    }
  }
  return best
}

export interface PricingOptions {
  /** Per-model partial rates, keyed by model name (normalized on lookup). */
  overrides?: Record<string, Partial<ModelPrice>>
  /** Contract discount factor applied to token and web-search cost; 1 = list price. */
  multiplier?: number
  /** What to do with a model the table does not know. Default: nothing ('strict'). */
  unknownModel?: 'strict' | 'family'
}

export interface PriceLookup {
  price: ModelPrice
  confidence: 'exact' | 'family' | 'custom'
  /** The model whose list price was borrowed (unknownModel: 'family'). */
  family?: string
  /** The dated rule the list price came from; absent when only an override priced it. */
  rule?: PriceRule
  /** No rule covers `day`; the nearest known rule was applied. Display layers mark it. */
  approximate: boolean
}

/** Take the numeric fields an override actually states — NaN, negatives and Infinity are dropped, not clamped. */
function usable(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0
}

function findOverride(
  key: string,
  overrides?: Record<string, Partial<ModelPrice>>,
): Partial<ModelPrice> | null {
  if (!overrides) return null
  const direct = overrides[key]
  if (direct) return direct
  // Users write what they see in the transcript ("claude-opus-5[1m]", "Anthropic/GPT-5");
  // normalizing their keys too is cheaper than making them guess ours.
  for (const k of Object.keys(overrides)) {
    if (normalizeModel(k) === key) return overrides[k]
  }
  return null
}

function mergeOverride(base: ModelPrice, o: Partial<ModelPrice>): ModelPrice {
  const merged: ModelPrice = { ...base }
  if (usable(o.input)) merged.input = o.input
  if (usable(o.output)) merged.output = o.output
  if (usable(o.cacheRead)) merged.cacheRead = o.cacheRead
  if (usable(o.cacheWrite5m)) merged.cacheWrite5m = o.cacheWrite5m
  if (usable(o.cacheWrite1h)) merged.cacheWrite1h = o.cacheWrite1h
  if (o.fast && usable(o.fast.input) && usable(o.fast.output)) {
    merged.fast = { input: o.fast.input, output: o.fast.output }
  }
  if (base.fast && !merged.fast) merged.fast = { ...base.fast }
  return merged
}

/**
 * A model the table does not know, priced solely by the user's override: input and
 * output are mandatory (without both there is no price at all). The missing cache
 * rates follow the vendor's own rule — Anthropic's fixed multiples for claude-* names,
 * and for everything else OpenAI's shape: no cache-write charge and a cached read at
 * 0.1x input. Documented here because it is an assumption, not a published rate.
 */
function baseForOverride(key: string, o: Partial<ModelPrice>): ModelPrice | null {
  if (!usable(o.input) || !usable(o.output)) return null
  if (key.startsWith('claude-')) return anthropic(o.input, o.output, o.cacheRead ?? o.input * 0.1)
  return openai(o.input, usable(o.cacheRead) ? o.cacheRead : o.input * 0.1, o.output)
}

function listPriceOf(key: string, day: string, unknown: 'strict' | 'family'): PriceLookup | null {
  const rules = PRICES[key]
  if (rules) {
    const picked = ruleForDay(rules, day)
    if (!picked) return null
    return {
      price: toPrice(picked.rule),
      confidence: 'exact',
      rule: picked.rule,
      approximate: picked.approximate,
    }
  }
  if (unknown !== 'family') return null
  const relative = familyMatch(key)
  if (!relative) return null
  const picked = ruleForDay(PRICES[relative], day)
  if (!picked) return null
  return {
    price: toPrice(picked.rule),
    confidence: 'family',
    family: relative,
    rule: picked.rule,
    approximate: picked.approximate,
  }
}

/**
 * The rate for `model` on `day`. `day` selects the dated rule; overrides merge field-wise
 * over the list price and turn the answer 'custom'; an unknown model answers null unless
 * the family fallback is opted in, and then says so via `confidence` and `family`.
 */
export function priceOf(model: string, day: string, opts?: PricingOptions): PriceLookup | null {
  const key = normalizeModel(model)
  if (!key) return null
  const list = listPriceOf(key, day, opts?.unknownModel ?? 'strict')
  const override = findOverride(key, opts?.overrides)
  if (!override) return list
  const base = list ? list.price : baseForOverride(key, override)
  if (!base) return list
  const lookup: PriceLookup = {
    price: mergeOverride(base, override),
    confidence: 'custom',
    approximate: list ? list.approximate : false,
  }
  if (list?.family) lookup.family = list.family
  if (list?.rule) lookup.rule = list.rule
  return lookup
}

/** True as soon as the shown cost is no longer the list price ("at your configured rates"). */
export function isCustomPricing(opts?: PricingOptions): boolean {
  if (!opts) return false
  if (effectiveMultiplier(opts) !== 1) return true
  return Object.keys(opts.overrides ?? {}).length > 0
}

function effectiveMultiplier(opts?: PricingOptions): number {
  const m = opts?.multiplier
  return typeof m === 'number' && Number.isFinite(m) && m > 0 ? m : 1
}

/**
 * Fast mode: the table states input and output only. Anthropic's cache rates are fixed
 * multiples of the input rate, so they are scaled by the same factor the fast input rate
 * carries (6x for Opus 4.6). Stated openly rather than applied silently — and it only ever
 * runs for a model that has published fast rates at all.
 *
 * `baseInput` is the input rate the fast rates were published against, not the one in
 * `p`: a user override may have replaced `p.input` while the cache and fast rates stayed
 * at list level, and dividing by the overridden rate would move the derived cache rates
 * in the opposite direction to the override.
 */
function fastRates(p: ModelPrice, baseInput: number): ModelPrice {
  if (!p.fast) return p
  const factor = Number.isFinite(baseInput) && baseInput > 0 ? p.fast.input / baseInput : 1
  return {
    input: p.fast.input,
    output: p.fast.output,
    cacheRead: p.cacheRead * factor,
    cacheWrite5m: p.cacheWrite5m * factor,
    cacheWrite1h: p.cacheWrite1h * factor,
    fast: { ...p.fast },
  }
}

function isFast(b: Bucket): boolean {
  return b.tier === 'fast' || b.tier === 'fast-us'
}

function costWith(b: Bucket, price: ModelPrice, multiplier: number, baseInput: number): number {
  const p = isFast(b) ? fastRates(price, baseInput) : price
  const geo = b.tier === 'us' || b.tier === 'fast-us' ? US_INFERENCE_MULTIPLIER : 1
  const M = 1e6
  let tokens: number
  if (b.source === 'codex') {
    // input_tokens already includes the cached tokens — otherwise they get paid for twice.
    const fresh = Math.max(0, b.input - b.cacheRead)
    tokens = (fresh * p.input + b.cacheRead * p.cacheRead + b.output * p.output) / M
  } else {
    const write5m = Math.max(0, b.cacheWrite - b.cacheWrite1h)
    tokens =
      (b.input * p.input +
        write5m * p.cacheWrite5m +
        b.cacheWrite1h * p.cacheWrite1h +
        b.cacheRead * p.cacheRead +
        b.output * p.output) /
      M
  }
  // Server tools are billed per call: web search per 1,000 searches, web fetch not at all.
  // Codex reports no such counter, so it contributes nothing there.
  const tools = b.source === 'codex' ? 0 : (b.webSearch / 1000) * WEB_SEARCH_USD_PER_1K
  return (tokens * geo + tools) * multiplier
}

export interface CostBreakdown {
  usd: number
  /** The same computation at multiplier 1 and without overrides — makes a discount visible. */
  listUsd: number
  unpriced: boolean
  reason?: 'no price' | 'fast rate unknown'
  confidence: 'exact' | 'family' | 'custom'
  /** Set when the rate was borrowed from another model. */
  family?: string
  /** Set when no dated rule covered the bucket's day. */
  approximate?: boolean
}

/**
 * What one bucket would have cost through the API. Returns null when there is no price
 * at all — the caller records the model as unpriced instead of showing a wrong number.
 *
 * A fast-mode bucket whose model has no published fast rate is NOT null: it comes back
 * `unpriced` with reason 'fast rate unknown' and usd 0, so the caller can still attribute
 * its tokens (they are known, only their price is not).
 */
export function costOfBucket(b: Bucket, opts?: PricingOptions): CostBreakdown | null {
  const lookup = priceOf(b.model, b.day, opts)
  if (!lookup) return null
  if (isFast(b) && !lookup.price.fast) {
    const out: CostBreakdown = {
      usd: 0,
      listUsd: 0,
      unpriced: true,
      reason: 'fast rate unknown',
      confidence: lookup.confidence,
    }
    if (lookup.family) out.family = lookup.family
    if (lookup.approximate) out.approximate = true
    return out
  }
  // The fast-mode cache rates are derived from the published input rate the fast rates
  // belong to; an override of `input` must not rescale them (see `fastRates`).
  const baseInput = lookup.rule ? lookup.rule.input : lookup.price.input
  const usd = costWith(b, lookup.price, effectiveMultiplier(opts), baseInput)
  // The list figure deliberately ignores overrides and the multiplier. Where a model has
  // no list price of its own (priced only by an override), list equals the custom figure —
  // claiming a discount against a price that was never published would be an invention.
  let listUsd = usd
  if (opts?.overrides) {
    const listLookup = priceOf(b.model, b.day, { unknownModel: opts.unknownModel })
    if (listLookup && (!isFast(b) || listLookup.price.fast)) {
      const listBase = listLookup.rule ? listLookup.rule.input : listLookup.price.input
      listUsd = costWith(b, listLookup.price, 1, listBase)
    }
  } else {
    listUsd = costWith(b, lookup.price, 1, baseInput)
  }
  if (!Number.isFinite(usd) || !Number.isFinite(listUsd)) return null
  const out: CostBreakdown = { usd, listUsd, unpriced: false, confidence: lookup.confidence }
  if (lookup.family) out.family = lookup.family
  if (lookup.approximate) out.approximate = true
  return out
}

/** Size and provenance of the table, for the data-quality section. */
export function priceTableSummary(): { models: number; asOf: string; sources: string[] } {
  return { models: Object.keys(PRICES).length, asOf: PRICES_AS_OF, sources: [...PRICE_SOURCES] }
}
