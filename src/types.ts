// SPDX-FileCopyrightText: 2026 Frederik Marx
// SPDX-License-Identifier: AGPL-3.0-or-later

export type Source = 'claude' | 'codex'

/** One aggregate bucket: a source, a local day, a model, main or subagent. */
export interface Bucket {
  source: Source
  day: string
  model: string
  isSub: boolean
  input: number
  cacheWrite: number
  /** Subset of cacheWrite with a 1-hour TTL — priced at 2x input instead of 1.25x. */
  cacheWrite1h: number
  cacheRead: number
  output: number
  reasoning: number
  requests: number
  /** How many requests had a terminal line — only then is `output` exact. */
  outputFinal: number
}

export function bucketKey(source: Source, day: string, model: string, isSub: boolean): string {
  return `${source}|${day}|${model}|${isSub ? 1 : 0}`
}

export function emptyBucket(source: Source, day: string, model: string, isSub: boolean): Bucket {
  return {
    source, day, model, isSub,
    input: 0, cacheWrite: 0, cacheWrite1h: 0, cacheRead: 0, output: 0, reasoning: 0,
    requests: 0, outputFinal: 0,
  }
}

/** Running state for one Claude message.id that spans several lines. */
export interface PendingMessage {
  day: string
  model: string
  isSub: boolean
  input: number
  cacheWrite: number
  cacheWrite1h: number
  cacheRead: number
  output: number
  final: boolean
}

/** Read position in a file. Detects rotation via (dev, ino) and truncation via size. */
export interface Cursor {
  offset: number
  size: number
  ino: number
  dev: number
  /** Codex: last seen total_token_usage.total_tokens, for delta computation. */
  lastTotal?: number
  /** Codex: replay prefix already skipped? */
  replayDone?: boolean
  /** Codex: timestamp of the file's first record (ms) — the fork point. */
  startTs?: number
  /** Codex: last seen model. */
  model?: string
  /** Codex: this file came from a fork/subagent. */
  forked?: boolean
}

export interface QuotaWindow {
  /** Stable key, e.g. "session", "weekly_scoped:Fable", "codex:10080". */
  id: string
  /** Spelled out, for tooltip and dashboard: "7 d · Fable". */
  label: string
  /** Terse, for the status bar: "7d" or "Fable 7d". */
  shortLabel: string
  percent: number
  resetsAt: number | null
  windowMinutes: number | null
}

/**
 * Usage beyond the plan: Anthropic's "extra usage" (billed on top, in currency)
 * and OpenAI's prepaid credit balance. Both providers report this even when it
 * is switched off, so `enabled` decides whether a figure is meaningful at all —
 * a disabled allowance must not be drawn as "0 % used".
 */
export interface ExtraUsage {
  enabled: boolean
  /** Share of the monthly allowance, 0..100, when the provider states one. */
  utilization: number | null
  /** Amount already spent, in `currency`. */
  used: number | null
  /** Monthly ceiling, in `currency`. */
  limit: number | null
  currency: string | null
  /** Prepaid balance (Codex), verbatim as reported. */
  balance: string | null
  unlimited: boolean
  spendLimitReached: boolean
  /** Why it is off, when the provider says so. */
  reason: string | null
}

export interface QuotaState {
  source: Source
  ok: boolean
  /** Where the number came from — shown in the tooltip so its origin is traceable. */
  origin?: 'cache' | 'poll'
  /** Unix seconds when the number was fetched. */
  fetchedAt: number | null
  planType: string | null
  windows: QuotaWindow[]
  extra?: ExtraUsage
  /** Reason, when ok === false. */
  problem?: string
}

export interface Snapshot {
  buckets: Bucket[]
  cursors: Record<string, Cursor>
  pending: Record<string, PendingMessage>
  /** Schema version of the persisted state. */
  version: number
}

export const STATE_VERSION = 4
