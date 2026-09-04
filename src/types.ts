// SPDX-FileCopyrightText: 2026 Frederik Marx
// SPDX-License-Identifier: AGPL-3.0-or-later

export type Source = 'claude' | 'codex'

/** Pricing tier of a request: fast mode and/or US-only inference (both carry surcharges). */
export type Tier = 'standard' | 'fast' | 'us' | 'fast-us'

/** Bucket resolution: one UTC hour, one local day (rolled up), one local month (rolled up). */
export type Resolution = 'h' | 'd' | 'm'

export interface Bucket {
  source: Source
  model: string
  isSub: boolean
  tier: Tier
  res: Resolution
  /** UTC hour index floor(ts / 3_600_000) while res === 'h'; null once rolled up. */
  hour: number | null
  /**
   * Local calendar day YYYY-MM-DD (res h, d) or month YYYY-MM (res m), in the zone active
   * at ingest / roll-up time. For res 'h' the display layer recomputes the day from `hour`
   * in the configured zone; for d/m this string is final.
   */
  day: string
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
  /** server_tool_use counters (Claude); priced per call, not per token. */
  webSearch: number
  webFetch: number
}

export function bucketKey(
  b: Pick<Bucket, 'source' | 'res' | 'hour' | 'day' | 'model' | 'isSub' | 'tier'>,
): string {
  return `${b.source}|${b.res}|${b.res === 'h' ? b.hour : b.day}|${b.model}|${b.isSub ? 1 : 0}|${b.tier}`
}

export function emptyBucket(
  source: Source,
  model: string,
  isSub: boolean,
  tier: Tier,
  res: Resolution,
  hour: number | null,
  day: string,
): Bucket {
  return {
    source, model, isSub, tier, res, hour, day,
    input: 0, cacheWrite: 0, cacheWrite1h: 0, cacheRead: 0, output: 0, reasoning: 0,
    requests: 0, outputFinal: 0, webSearch: 0, webFetch: 0,
  }
}

/** Running state for one Claude message.id that spans several lines. */
export interface PendingMessage {
  hour: number
  day: string
  model: string
  isSub: boolean
  tier: Tier
  input: number
  cacheWrite: number
  cacheWrite1h: number
  cacheRead: number
  output: number
  /** Thinking tokens are a streaming snapshot like output; optional so older snapshots still load. */
  reasoning?: number
  webSearch: number
  webFetch: number
  final: boolean
  /** Session file key, when attribution is on. */
  session?: string
}

/** The rate-limit block Codex writes into every token_count event (snake_case schema). */
export interface CodexRateLimitsSnapshot {
  /** Record timestamp (ms) of the line it came from. */
  t: number
  limitId: string
  limitName: string | null
  planType: string | null
  primary: { usedPercent: number; windowMinutes: number | null; resetsAt: number | null } | null
  secondary: { usedPercent: number; windowMinutes: number | null; resetsAt: number | null } | null
  credits: { hasCredits: boolean; unlimited: boolean; balance: string | null } | null
  limitReached: boolean
}

/** Read position in a file. Detects rotation via (dev, ino) and truncation via size. */
export interface Cursor {
  offset: number
  size: number
  ino: number
  dev: number
  /** mtime (ms) at the last read — sweep pre-filter. */
  mtime?: number
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
  /** Codex: newest rate_limits block seen in this file (network-free quota source). */
  lastRateLimits?: CodexRateLimitsSnapshot
  /** Attribution: session id and project label for this file. */
  sessionId?: string
  project?: string
  /** Timestamp (ms) of the last counted line, for turn-duration and cache-TTL estimates. */
  lastTs?: number
}

/** Opt-in per-session record (tokenPace.attribution !== 'none'). Keyed by transcript path. */
export interface SessionRec {
  source: Source
  sessionId: string
  /** Basename of the working directory, or a salted hash (showProjectNames = hash). */
  project: string
  /** sha256(salt + full path).slice(0, 12) — stable pseudonym. */
  projectHash: string
  isSub: boolean
  parent: string | null
  firstTs: number
  lastTs: number
  models: string[]
  input: number
  cacheWrite: number
  cacheWrite1h: number
  cacheRead: number
  output: number
  reasoning: number
  requests: number
  outputFinal: number
  /** TTL class and time of the last cache write — basis for "cache likely cold in N min". */
  lastCacheTtl: '5m' | '1h' | null
  lastCacheWriteTs: number | null
  /** Gaps between consecutive counted lines (ms), capped reservoir of 200, for turn-duration ≈. */
  turnGapsMs: number[]
  /**
   * Billable tokens per UTC hour index (the key is the index as a string) — the only
   * time slice a session carries, and the basis for attributing usage to a quota window.
   * The lifetime counters above cannot answer "inside this window": a session resumed over
   * days would bring its whole history into a five-hour box. Pruned in `rollup` to the
   * horizon the hour buckets themselves keep, and at most the length of the longest quota
   * window. Absent on records written by older builds — read it as "no slice known".
   */
  hourUsage?: Record<string, number>
}

export type Attribution = 'none' | 'project' | 'session'

export interface Snapshot {
  /** Schema version of the persisted state. */
  version: number
  buckets: Bucket[]
  cursors: Record<string, Cursor>
  pending: Record<string, PendingMessage>
  sessions: Record<string, SessionRec>
  attribution: Attribution
  /** Roll-up bookkeeping: last run (ms) and the retention the run used. */
  rollup: { lastRun: number; hourRetentionDays: number; retentionDays: number }
  /** First ingest (ms) — heatmap days before it are "outside coverage", not zero. */
  firstIngest: number | null
}

export const STATE_VERSION = 5

export type WindowKind = 'session' | 'weekly' | 'other'

export interface QuotaWindow {
  /**
   * Stable key: Claude `${kind}:${minutes}:${modelSlug}` e.g. "session:300", "weekly_all:10080",
   * "weekly_scoped:10080:fable"; Codex `${limitId}:${minutes}` e.g. "codex:10080",
   * "codex_bengalfox:300". Basis for status bar item IDs, labels, alerts and history.
   */
  id: string
  kind: WindowKind
  /** Spelled out, for tooltip and dashboard: "7 d · Fable". */
  label: string
  /** Terse, for the status bar: "7d" or "Fable 7d". */
  shortLabel: string
  /** Model display name for scoped windows, else null. */
  model: string | null
  /** 0..100, may exceed 100 (overflow with credits); never clamped here. */
  percent: number
  /** Unix ms, or null when the provider states none. */
  resetsAt: number | null
  windowMinutes: number | null
  /**
   * Provider says the limit is hit (Codex rate_limit_reached_type, Claude severity "critical"
   * at 100) — an explicit state, not derived from percent alone.
   */
  limitReached: boolean
  /** Window or credits without a limit (Codex "unlimited"). */
  unlimited: boolean
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

export type QuotaOrigin = 'cache' | 'poll' | 'push' | 'transcript' | 'statusline' | 'claudeJson'

/** Why there is no figure — one code per cause so the status bar can name it. */
export type ProblemKind =
  | 'noFile' | 'paused' | 'empty' | 'noToken' | 'tokenExpired' | 'consentPending' | 'modeCache'
  | 'retry' | 'offline' | 'forbidden' | 'unauthorized' | 'noBinary' | 'quotaOff' | 'follower' | 'unknown'

export interface QuotaState {
  source: Source
  ok: boolean
  /** Where the number came from — shown in the tooltip so its origin is traceable. */
  origin?: QuotaOrigin
  /** Unix seconds when the number was fetched / the sample was taken. */
  fetchedAt: number | null
  planType: string | null
  windows: QuotaWindow[]
  extra?: ExtraUsage
  /** Reason, when ok === false. */
  problem?: string
  problemKind?: ProblemKind
  /** Unix ms of the next scheduled attempt (backoff end), when known. */
  nextAttemptAt?: number | null
  /** Numeric fields of the provider response that this build does not render. */
  drift?: string[]
  /** Only part of the sources answered (e.g. windows without extra). */
  partial?: boolean
}

/** One point of the quota time series. Short keys: the file holds thousands. */
export interface QuotaSample {
  s: Source
  /** QuotaWindow.id */
  w: string
  /** Unix ms of the fetch. */
  t: number
  p: number
  /** resetsAt (ms) or null */
  r: number | null
  o: QuotaOrigin
  /** Account fingerprint (8 hex) so streams of different identities never mix. */
  f: string
}

export type PaceLevel = 'ok' | 'warn' | 'warn2' | 'error'

export interface PaceVerdict {
  level: PaceLevel
  /** percent − elapsed, in percentage points; null without a clock. */
  points: number | null
  /** (used/limit) ÷ (elapsed/window); null without a clock. */
  ratio: number | null
  /** Too early in the window to judge (below minElapsedPercent). */
  measuring: boolean
  /** "12 % ahead of pace" / "on pace" / "8 % of the window still spare" / "exhausted" */
  text: string
}

export type ForecastState = 'none' | 'measuring' | 'idle' | 'resetsFirst' | 'eta' | 'stale' | 'full'

export interface Forecast {
  state: ForecastState
  /** Percentage points per hour (least squares), null unless state is eta/idle/resetsFirst. */
  ratePerHour: number | null
  /** Unix ms when 100 % would be reached; only for state 'eta'. */
  etaMs: number | null
  /** Projected percent at resetsAt (may exceed 100); for eta/resetsFirst. */
  endPercent: number | null
  /** (100 − percent) / remaining hours: the rate that would just last until the reset. */
  sustainablePerHour: number | null
  confidence: 'low' | 'medium' | 'high' | null
  basis: { samples: number; spanMs: number } | null
  /** One human line, already marked as an estimate ("~"). */
  text: string
}
