// SPDX-FileCopyrightText: 2026 Frederik Marx
// SPDX-License-Identifier: AGPL-3.0-or-later

import { test } from 'node:test'
import * as assert from 'node:assert/strict'

import {
  PRICES,
  PRICES_AS_OF,
  PRICE_SOURCES,
  US_INFERENCE_MULTIPLIER,
  WEB_SEARCH_USD_PER_1K,
  PriceRule,
  PricingOptions,
  costOfBucket,
  isCustomPricing,
  normalizeModel,
  priceOf,
  priceTableSummary,
  ruleForDay,
} from '../src/prices'
import { Bucket, Source, Tier, emptyBucket } from '../src/types'

const M = 1_000_000

function close(actual: number, expected: number, what = 'value'): void {
  assert.ok(
    Math.abs(actual - expected) < 1e-9,
    `${what}: expected ${expected}, got ${actual}`,
  )
}

interface BucketParts {
  model: string
  source?: Source
  tier?: Tier
  day?: string
  input?: number
  cacheWrite?: number
  cacheWrite1h?: number
  cacheRead?: number
  output?: number
  webSearch?: number
  webFetch?: number
}

function bucket(p: BucketParts): Bucket {
  const b = emptyBucket(p.source ?? 'claude', p.model, false, p.tier ?? 'standard', 'd', null, p.day ?? PRICES_AS_OF)
  b.input = p.input ?? 0
  b.cacheWrite = p.cacheWrite ?? 0
  b.cacheWrite1h = p.cacheWrite1h ?? 0
  b.cacheRead = p.cacheRead ?? 0
  b.output = p.output ?? 0
  b.webSearch = p.webSearch ?? 0
  b.webFetch = p.webFetch ?? 0
  b.requests = 1
  return b
}

function costOf(b: Bucket, opts?: PricingOptions): { usd: number; listUsd: number } {
  const c = costOfBucket(b, opts)
  assert.ok(c, `expected a price for ${b.model}`)
  assert.equal(c.unpriced, false)
  return c
}

// ---------------------------------------------------------------- normalizeModel

test('normalizeModel strips date suffix, context suffix, vendor prefix and case', () => {
  assert.equal(normalizeModel('claude-haiku-4-5-20251001'), 'claude-haiku-4-5')
  assert.equal(normalizeModel('claude-opus-5[1m]'), 'claude-opus-5')
  assert.equal(normalizeModel('  claude-sonnet-5  '), 'claude-sonnet-5')
  assert.equal(normalizeModel('Claude-Opus-4-6'), 'claude-opus-4-6')
  assert.equal(normalizeModel('anthropic/claude-opus-4-6'), 'claude-opus-4-6')
  assert.equal(normalizeModel('openai/GPT-5.6-Sol'), 'gpt-5.6-sol')
  assert.equal(normalizeModel('openrouter/anthropic/claude-3-opus'), 'claude-3-opus')
  assert.equal(normalizeModel('claude-sonnet-4-5-20250929[1m]'), 'claude-sonnet-4-5')
  assert.equal(normalizeModel(''), '')
})

// ---------------------------------------------------------------- dated rules

const OLD: PriceRule = {
  input: 2, output: 10, cacheRead: 0.2, cacheWrite5m: 2.5, cacheWrite1h: 4,
  from: '2025-01-01', until: '2026-06-01', source: 'test',
}
const NEW: PriceRule = {
  input: 4, output: 20, cacheRead: 0.4, cacheWrite5m: 5, cacheWrite1h: 8,
  from: '2026-06-01', source: 'test',
}

test('ruleForDay picks the rule in force on the day', () => {
  const rules = [NEW, OLD]
  assert.equal(ruleForDay(rules, '2026-07-01')?.rule.input, 4)
  assert.equal(ruleForDay(rules, '2026-05-31')?.rule.input, 2)
  // `until` is exclusive: the successor owns its own first day.
  assert.equal(ruleForDay(rules, '2026-06-01')?.rule.input, 4)
  assert.equal(ruleForDay(rules, '2026-07-01')?.approximate, false)
  assert.equal(ruleForDay(rules, '2026-05-31')?.approximate, false)
})

test('ruleForDay falls back to the nearest rule and says so', () => {
  const rules = [NEW, OLD]
  const before = ruleForDay(rules, '2024-12-31')
  assert.equal(before?.rule.input, 2, 'oldest rule for a day before the table')
  assert.equal(before?.approximate, true)
  // A closed rule with no successor: the day is after `until`, still approximate.
  const orphan = ruleForDay([OLD], '2026-08-01')
  assert.equal(orphan?.rule.input, 2)
  assert.equal(orphan?.approximate, true)
  assert.equal(ruleForDay([], '2026-08-01'), null)
})

test('priceOf marks days the table does not cover', () => {
  const exact = priceOf('claude-opus-5', PRICES_AS_OF)
  assert.ok(exact)
  assert.equal(exact.confidence, 'exact')
  assert.equal(exact.approximate, false)
  assert.equal(exact.rule?.from, PRICES_AS_OF)
  close(exact.price.input, 5, 'input')
  close(exact.price.output, 25, 'output')
  close(exact.price.cacheRead, 0.5, 'cacheRead')
  close(exact.price.cacheWrite5m, 6.25, 'cacheWrite5m')
  close(exact.price.cacheWrite1h, 10, 'cacheWrite1h')

  const older = priceOf('claude-opus-5', '2026-01-15')
  assert.ok(older)
  assert.equal(older.confidence, 'exact', 'the rate itself is the published one')
  assert.equal(older.approximate, true, 'but the day predates the check')
  close(older.price.input, 5)

  // Rolled-up month buckets carry "YYYY-MM" and are dated to the first of the month.
  assert.equal(priceOf('claude-opus-5', '2026-09')?.approximate, true)
  assert.equal(priceOf('claude-opus-5', '2026-10')?.approximate, false)
})

test('legacy Anthropic rows are priced with their own check date', () => {
  const haiku = priceOf('claude-3-5-haiku', '2026-08-20')
  assert.ok(haiku)
  assert.equal(haiku.approximate, false)
  close(haiku.price.input, 0.8, 'input')
  close(haiku.price.output, 4, 'output')
  close(haiku.price.cacheRead, 0.08, 'cacheRead')
  close(haiku.price.cacheWrite1h, 1.6, 'cacheWrite1h')
  close(priceOf('claude-opus-4-1', '2026-08-20')!.price.input, 15)
  close(priceOf('claude-3-opus', '2026-08-20')!.price.output, 75)
  close(priceOf('claude-3-haiku', '2026-08-20')!.price.input, 0.25)
  assert.equal(priceOf('claude-3-5-haiku', '2026-01-01')?.approximate, true)
})

// ---------------------------------------------------------------- fast mode

test('Opus 4.6 is the only model with published fast rates', () => {
  const p = priceOf('claude-opus-4-6', PRICES_AS_OF)
  assert.deepEqual(p?.price.fast, { input: 30, output: 150 })
  const withFast = Object.entries(PRICES)
    .filter(([, rules]) => rules.some((r) => r.fast))
    .map(([model]) => model)
  assert.deepEqual(withFast, ['claude-opus-4-6'])
})

test('fast turns of Opus 4.6 are billed at 30/150', () => {
  const c = costOf(bucket({ model: 'claude-opus-4-6', tier: 'fast', input: M, output: M }))
  close(c.usd, 180, 'fast usd')
  close(c.listUsd, 180, 'fast list usd')
  // The standard bucket of the same size costs a sixth.
  close(costOf(bucket({ model: 'claude-opus-4-6', input: M, output: M })).usd, 30)
  // Cache rates follow the input rate, so they carry the same factor.
  close(costOf(bucket({ model: 'claude-opus-4-6', tier: 'fast', cacheRead: M })).usd, 3, 'fast cacheRead')
})

test('fast turns of a model without fast rates are unpriced, not silently standard', () => {
  const c = costOfBucket(bucket({ model: 'claude-opus-5', tier: 'fast', input: M, output: M }))
  assert.ok(c, 'the tokens are known, so the bucket is reported, not dropped')
  assert.equal(c.unpriced, true)
  assert.equal(c.reason, 'fast rate unknown')
  assert.equal(c.usd, 0)
  assert.equal(c.listUsd, 0)
  assert.equal(c.confidence, 'exact')
  // fast-us behaves the same way.
  assert.equal(costOfBucket(bucket({ model: 'claude-sonnet-5', tier: 'fast-us', input: M }))?.reason, 'fast rate unknown')
})

test('an override can supply the missing fast rates', () => {
  const opts: PricingOptions = { overrides: { 'claude-opus-5': { fast: { input: 10, output: 50 } } } }
  const c = costOf(bucket({ model: 'claude-opus-5', tier: 'fast', input: M, output: M }), opts)
  close(c.usd, 60, 'custom fast usd')
  // No published fast rate to compare against — the list column falls back to the custom figure
  // instead of pretending a discount.
  close(c.listUsd, 60, 'custom fast list usd')
})

test('an input override never rescales the derived fast cache rates', () => {
  // Opus 4.6: list 5/25 in, fast 30/150 — the fast cache rates are the list cache rates
  // times 30/5. A user override of the *standard* input rate must not touch that factor.
  const b = bucket({
    model: 'claude-opus-4-6', tier: 'fast',
    input: M, cacheWrite: M, cacheWrite1h: 0.4 * M, cacheRead: M, output: M,
  })
  const list = costOf(b)
  close(list.usd, 30 + 0.6 * 37.5 + 0.4 * 60 + 3 + 150, 'fast list usd')

  // A cheaper stated input rate cannot make the bill go up (it used to: factor 30/1).
  const cheaper = costOf(b, { overrides: { 'claude-opus-4-6': { input: 1 } } })
  close(cheaper.usd, list.usd, 'fast usd under a cheaper input override')
  close(cheaper.listUsd, list.usd, 'list usd stays the published figure')
  // ...and a dearer one cannot make it go down.
  const dearer = costOf(b, { overrides: { 'claude-opus-4-6': { input: 10 } } })
  close(dearer.usd, list.usd, 'fast usd under a dearer input override')

  // An overridden cache rate is still scaled by the published fast factor, once.
  const cache = costOf(bucket({ model: 'claude-opus-4-6', tier: 'fast', cacheRead: M }), {
    overrides: { 'claude-opus-4-6': { cacheRead: 1 } },
  })
  close(cache.usd, 6, 'overridden cache read at the fast factor')
})

test('a model priced only by an override derives its fast cache rates from that override', () => {
  const opts: PricingOptions = {
    overrides: { 'claude-mystery-9': { input: 2, output: 10, fast: { input: 12, output: 60 } } },
  }
  const c = costOf(bucket({ model: 'claude-mystery-9', tier: 'fast', cacheRead: M, output: M }), opts)
  // cacheRead defaults to 0.1x input (0.2), scaled by the fast factor 12/2 = 6.
  close(c.usd, 1.2 + 60, 'override-only fast usd')
})

// ---------------------------------------------------------------- family fallback

test('family fallback is opt-in, named and marked', () => {
  assert.equal(priceOf('claude-opus-4-9', PRICES_AS_OF), null, 'strict is the default')
  const fam = priceOf('claude-opus-4-9', PRICES_AS_OF, { unknownModel: 'family' })
  assert.ok(fam)
  assert.equal(fam.confidence, 'family')
  assert.equal(fam.family, 'claude-opus-5')
  close(fam.price.input, 5)

  assert.equal(priceOf('claude-sonnet-4-9', PRICES_AS_OF, { unknownModel: 'family' })?.family, 'claude-sonnet-5')
  assert.equal(priceOf('gpt-5.7', PRICES_AS_OF, { unknownModel: 'family' })?.family, 'gpt-5.5')
  assert.equal(priceOf('gpt-5.7-mini', PRICES_AS_OF, { unknownModel: 'family' })?.family, 'gpt-5.4-mini')
  assert.equal(priceOf('gpt-5.7-codex', PRICES_AS_OF, { unknownModel: 'family' })?.family, 'gpt-5.3-codex')
  // No relative, no invention.
  assert.equal(priceOf('llama-4-maverick', PRICES_AS_OF, { unknownModel: 'family' }), null)
  assert.equal(priceOf('', PRICES_AS_OF, { unknownModel: 'family' }), null)
})

test('a family-priced bucket carries the marker into the cost breakdown', () => {
  const c = costOfBucket(bucket({ model: 'claude-opus-4-9', input: M }), { unknownModel: 'family' })
  assert.ok(c)
  assert.equal(c.confidence, 'family')
  assert.equal(c.family, 'claude-opus-5')
  close(c.usd, 5)
  assert.equal(costOfBucket(bucket({ model: 'claude-opus-4-9', input: M })), null, 'strict stays unpriced')
})

// ---------------------------------------------------------------- overrides

test('overrides merge field-wise and mark the price custom', () => {
  const p = priceOf('claude-opus-5', PRICES_AS_OF, { overrides: { 'claude-opus-5': { input: 1 } } })
  assert.ok(p)
  assert.equal(p.confidence, 'custom')
  close(p.price.input, 1, 'overridden input')
  close(p.price.output, 25, 'untouched output')
  close(p.price.cacheWrite5m, 6.25, 'untouched cacheWrite5m')
})

test('override keys are normalized like model names', () => {
  const p = priceOf('claude-opus-5[1m]', PRICES_AS_OF, {
    overrides: { 'Claude-Opus-5-20260101': { output: 3 } },
  })
  close(p!.price.output, 3)
  assert.equal(p!.confidence, 'custom')
})

test('a bare override prices an unknown model only with input and output', () => {
  const claude = priceOf('claude-mystery-9', PRICES_AS_OF, {
    overrides: { 'claude-mystery-9': { input: 2, output: 8 } },
  })
  assert.ok(claude)
  assert.equal(claude.confidence, 'custom')
  close(claude.price.cacheRead, 0.2, 'anthropic read multiple')
  close(claude.price.cacheWrite5m, 2.5, 'anthropic 5m multiple')
  close(claude.price.cacheWrite1h, 4, 'anthropic 1h multiple')

  const other = priceOf('mistral-large', PRICES_AS_OF, {
    overrides: { 'mistral-large': { input: 2, output: 8 } },
  })
  assert.ok(other)
  close(other.price.cacheRead, 0.2)
  close(other.price.cacheWrite5m, 0, 'no cache-write charge outside Anthropic')
  close(other.price.cacheWrite1h, 0)

  // Half an override is no price.
  assert.equal(priceOf('zzz-model', PRICES_AS_OF, { overrides: { 'zzz-model': { input: 2 } } }), null)
})

test('non-finite and negative override values are discarded, not clamped', () => {
  const p = priceOf('claude-opus-5', PRICES_AS_OF, {
    overrides: { 'claude-opus-5': { input: -3, output: Number.NaN, cacheRead: Number.POSITIVE_INFINITY } },
  })
  assert.ok(p)
  close(p.price.input, 5)
  close(p.price.output, 25)
  close(p.price.cacheRead, 0.5)
})

// ---------------------------------------------------------------- multiplier vs list price

test('the multiplier scales the cost while listUsd keeps the list price visible', () => {
  const b = bucket({ model: 'claude-opus-5', input: M })
  close(costOf(b).usd, 5, 'list')
  const discounted = costOf(b, { multiplier: 0.5 })
  close(discounted.usd, 2.5, 'discounted')
  close(discounted.listUsd, 5, 'list stays visible')

  const custom = costOf(b, { overrides: { 'claude-opus-5': { input: 1 } } })
  close(custom.usd, 1)
  close(custom.listUsd, 5)

  const both = costOf(b, { multiplier: 0.5, overrides: { 'claude-opus-5': { input: 1 } } })
  close(both.usd, 0.5)
  close(both.listUsd, 5)

  // An invalid multiplier is ignored rather than turning the cost into 0 or NaN.
  close(costOf(b, { multiplier: Number.NaN }).usd, 5)
  close(costOf(b, { multiplier: 0 }).usd, 5)
})

test('isCustomPricing flags every deviation from the list price', () => {
  assert.equal(isCustomPricing(), false)
  assert.equal(isCustomPricing({}), false)
  assert.equal(isCustomPricing({ multiplier: 1 }), false)
  assert.equal(isCustomPricing({ overrides: {} }), false)
  assert.equal(isCustomPricing({ multiplier: 0.85 }), true)
  assert.equal(isCustomPricing({ overrides: { 'claude-opus-5': { input: 1 } } }), true)
  assert.equal(isCustomPricing({ unknownModel: 'family' }), false, 'a fallback is not a custom rate')
})

// ---------------------------------------------------------------- tiers and server tools

test('web search costs one cent per request, web fetch is free', () => {
  close(costOf(bucket({ model: 'claude-sonnet-5', webSearch: 1 })).usd, WEB_SEARCH_USD_PER_1K / 1000)
  close(costOf(bucket({ model: 'claude-sonnet-5', webSearch: 1 })).usd, 0.01)
  close(costOf(bucket({ model: 'claude-sonnet-5', webSearch: 250 })).usd, 2.5)
  close(costOf(bucket({ model: 'claude-sonnet-5', webSearch: 1, webFetch: 99 })).usd, 0.01)
  // The discount applies to tool calls too.
  close(costOf(bucket({ model: 'claude-sonnet-5', webSearch: 100 }), { multiplier: 0.5 }).usd, 0.5)
})

test('US-only inference multiplies token cost by 1.1, not the tool calls', () => {
  close(costOf(bucket({ model: 'claude-opus-5', tier: 'us', input: M })).usd, 5 * US_INFERENCE_MULTIPLIER)
  close(costOf(bucket({ model: 'claude-opus-5', tier: 'us', input: M, webSearch: 1 })).usd, 5 * 1.1 + 0.01)
  close(costOf(bucket({ model: 'claude-opus-4-6', tier: 'fast-us', input: M })).usd, 30 * 1.1)
})

test('Claude cache writes split by TTL', () => {
  // 1M writes of which 400k have the 1-hour TTL: 600k at 1.25x, 400k at 2x the input rate.
  const c = costOf(bucket({ model: 'claude-opus-5', cacheWrite: M, cacheWrite1h: 400_000 }))
  close(c.usd, (600_000 * 6.25 + 400_000 * 10) / M)
})

// ---------------------------------------------------------------- Codex

test('Codex input already contains the cached tokens', () => {
  const b = bucket({ model: 'gpt-5', source: 'codex', input: M, cacheRead: 400_000, output: 0 })
  close(costOf(b).usd, (600_000 * 1.25 + 400_000 * 0.125) / M)
  // Cache writes and a stray web-search counter cost nothing on Codex.
  const noisy = bucket({ model: 'gpt-5', source: 'codex', input: M, cacheRead: 400_000, cacheWrite: M, webSearch: 1000 })
  close(costOf(noisy).usd, costOf(b).usd)
  // Never negative when the cached count exceeds the reported input.
  close(costOf(bucket({ model: 'gpt-5', source: 'codex', input: 100, cacheRead: 500 })).usd, (500 * 0.125) / M)
})

// ---------------------------------------------------------------- table hygiene

test('unknown models stay unpriced', () => {
  assert.equal(costOfBucket(bucket({ model: 'some-unknown-model', input: M })), null)
  assert.equal(costOfBucket(bucket({ model: '', input: M })), null)
})

test('priceTableSummary reports the table and its sources', () => {
  const s = priceTableSummary()
  assert.equal(s.models, Object.keys(PRICES).length)
  assert.equal(s.asOf, PRICES_AS_OF)
  assert.equal(s.asOf, '2026-09-02')
  assert.deepEqual(s.sources, PRICE_SOURCES)
  assert.ok(s.models >= 25, 'current and legacy rows')
  s.sources.push('mutation')
  assert.equal(priceTableSummary().sources.length, PRICE_SOURCES.length, 'summary hands out a copy')
})

test('every rule is dated, sourced and newest first', () => {
  for (const [model, rules] of Object.entries(PRICES)) {
    assert.ok(rules.length > 0, `${model} has no rule`)
    for (let i = 1; i < rules.length; i++) {
      assert.ok(rules[i - 1].from > rules[i].from, `${model} is not ordered newest first`)
    }
    for (const r of rules) {
      assert.match(r.from, /^\d{4}-\d{2}-\d{2}$/, `${model} has no check date`)
      assert.ok(r.from <= PRICES_AS_OF, `${model} is dated after the table check`)
      assert.ok(r.source.length > 0, `${model} names no source`)
      assert.ok(!r.source.includes('://'), 'sources stay free of URLs (privacy scan)')
      for (const rate of [r.input, r.output, r.cacheRead, r.cacheWrite5m, r.cacheWrite1h]) {
        assert.ok(Number.isFinite(rate) && rate >= 0, `${model} has an impossible rate`)
      }
    }
  }
})
