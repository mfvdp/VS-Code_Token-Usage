// SPDX-FileCopyrightText: 2026 Frederik Marx
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * Provider list prices, in USD per 1M tokens.
 *
 * IMPORTANT: anyone working through a subscription (Claude Pro/Max, ChatGPT/Codex)
 * does NOT pay these amounts. The figure only answers "what would this same usage
 * have cost through the API" — it has no billing relationship.
 *
 * Sources (as of 2026-09-02):
 *   Anthropic — docs.claude.com model table
 *   OpenAI    — developers.openai.com/api/docs/pricing
 */

export interface ModelPrice {
  input: number
  output: number
  cacheRead: number
  cacheWrite5m: number
  cacheWrite1h: number
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

export const PRICES: Record<string, ModelPrice> = {
  // ---- Anthropic ----
  'claude-fable-5-1': anthropic(10, 50, 0.25),
  // Same tier and per-token price as Fable 5.1, but its cache-read rate was not
  // confirmed at launch — the standard 0.1x applies until it is.
  'claude-mythos-5-1': anthropic(10, 50),
  'claude-fable-5': anthropic(10, 50),
  'claude-mythos-5': anthropic(10, 50),
  'claude-opus-5': anthropic(5, 25),
  'claude-opus-4-8': anthropic(5, 25),
  'claude-opus-4-7': anthropic(5, 25),
  'claude-opus-4-6': anthropic(5, 25),
  'claude-sonnet-5': anthropic(2, 10),
  'claude-sonnet-4-6': anthropic(3, 15),
  'claude-haiku-4-5': anthropic(1, 5),
  // ---- OpenAI ----
  'gpt-5.6-sol': openai(4, 0.4, 20),
  'gpt-5.6-terra': openai(2, 0.2, 12),
  'gpt-5.6-luna': openai(0.2, 0.02, 1.2),
  'gpt-5.6-cyber': openai(12.5, 1.25, 75),
  'gpt-5.5': openai(5, 0.5, 30),
  'gpt-5.5-pro': openai(30, 0, 180),
  'gpt-5.4': openai(2.5, 0.25, 15),
  'gpt-5.4-mini': openai(0.75, 0.075, 4.5),
  'gpt-5.4-nano': openai(0.2, 0.02, 1.25),
  'gpt-5.3-codex': openai(1.75, 0.175, 14),
  'gpt-5.2': openai(1.75, 0.175, 14),
  'gpt-5.1': openai(1.25, 0.125, 10),
  'gpt-5': openai(1.25, 0.125, 10),
  'gpt-5-mini': openai(0.25, 0.025, 2),
  'gpt-5-nano': openai(0.05, 0.005, 0.4),
  'gpt-5-pro': openai(15, 0, 120),
}

/** "claude-haiku-4-5-20251001" -> "claude-haiku-4-5", "claude-opus-5[1m]" -> "claude-opus-5" */
export function normalizeModel(model: string): string {
  return model
    .replace(/\[[^\]]*\]$/, '')
    .replace(/-\d{8}$/, '')
    .trim()
}

export function priceOf(model: string, overrides?: Record<string, ModelPrice>): ModelPrice | null {
  const key = normalizeModel(model)
  return overrides?.[key] ?? PRICES[key] ?? null
}
