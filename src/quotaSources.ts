// SPDX-FileCopyrightText: 2026 Frederik Marx
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The source cascade: which reading of a provider's quota wins.
 *
 * Every source answers the same question with a different age and a different
 * price. The rule is therefore the simplest honest one — the freshest complete
 * reading wins, ties go to the configured order — and fields are never merged
 * across sources: two readings can belong to two accounts, and a spliced state
 * would be a figure that never existed anywhere.
 */

import {
  readClaudeJsonUtilization, readClaudeQuota, readCodexQuota, readStatuslineMirror, codexStateFromTranscript,
  CLAUDE_QUOTA_FILE, CODEX_QUOTA_FILE,
} from './quota'
import { CodexRateLimitsSnapshot, QuotaState, Source } from './types'

export type ClaudeSourceId = 'cacheFile' | 'statusline' | 'claudeJson' | 'poll'
export type CodexSourceId = 'cacheFile' | 'transcript' | 'poll'
export type SourceId = ClaudeSourceId | CodexSourceId
export type QuotaMode = 'auto' | 'poll' | 'cache'

export interface Candidate {
  id: string
  ok: boolean
  /** Age of the reading in seconds; null when the source never named a time. */
  ageSec: number | null
  problem?: string
}

export interface SourceInputs {
  claudeOrder: ClaudeSourceId[]
  codexOrder: CodexSourceId[]
  /** States this process fetched itself (origin poll or push). */
  polled: Partial<Record<Source, QuotaState>>
  transcript: () => CodexRateLimitsSnapshot[]
  mirrorFile: string
  claudeJsonFile: string
  /** Cache file overrides; default to the configured module-level paths. */
  claudeCacheFile?: string
  codexCacheFile?: string
  mode: QuotaMode
}

export interface BestState {
  state: QuotaState
  candidates: Candidate[]
  /** Non-secret account marker of the winning source, when it carries one. */
  identityHint: string | null
}

interface Reading {
  id: SourceId
  state: QuotaState
  identityHint: string | null
}

function ageSec(state: QuotaState, now: number): number | null {
  const at = state.fetchedAt
  return typeof at === 'number' && Number.isFinite(at) ? now / 1000 - at : null
}

/**
 * Whether a source may be consulted at all.
 *
 * `cache` never asks our own poll — that is the whole point of the mode, and the
 * question is not even put. `auto` shows a poll result that already exists (a
 * forced fetch, a push) but never treats the poll as a standing source.
 */
function enabled(id: SourceId, mode: QuotaMode, polled: QuotaState | undefined): boolean {
  if (id !== 'poll') return true
  if (mode === 'cache') return false
  if (mode === 'auto') return polled !== undefined
  return true
}

function readClaude(id: ClaudeSourceId, inputs: SourceInputs, now: number): Reading {
  switch (id) {
    case 'cacheFile':
      return { id, state: readClaudeQuota(inputs.claudeCacheFile ?? CLAUDE_QUOTA_FILE, now), identityHint: null }
    case 'statusline': {
      const r = readStatuslineMirror(inputs.mirrorFile)
      return { id, state: r.state, identityHint: r.identityHint }
    }
    case 'claudeJson': {
      const r = readClaudeJsonUtilization(inputs.claudeJsonFile, now)
      return { id, state: r.state, identityHint: r.identityHint }
    }
    case 'poll':
      return { id, state: inputs.polled.claude ?? missing('claude'), identityHint: null }
  }
}

function readCodex(id: CodexSourceId, inputs: SourceInputs, now: number): Reading {
  switch (id) {
    case 'cacheFile':
      return { id, state: readCodexQuota(inputs.codexCacheFile ?? CODEX_QUOTA_FILE, now), identityHint: null }
    case 'transcript':
      return { id, state: codexStateFromTranscript(inputs.transcript()), identityHint: null }
    case 'poll':
      return { id, state: inputs.polled.codex ?? missing('codex'), identityHint: null }
  }
}

function missing(source: Source): QuotaState {
  return {
    source, ok: false, fetchedAt: null, planType: null, windows: [],
    problem: 'No fetch of our own yet', problemKind: 'unknown',
  }
}

/**
 * The best available state plus every candidate with its age.
 *
 * The candidate list is what the data-quality section shows ("cache file 3 min ·
 * claude.json 41 min · transcript 2 h"), so it also names the sources that
 * failed — an absent source is a stated absence, not a gap in the list.
 */
export function bestState(source: Source, inputs: SourceInputs, now: number): BestState {
  const order: SourceId[] = source === 'claude' ? inputs.claudeOrder : inputs.codexOrder
  const readings: Reading[] = []
  const candidates: Candidate[] = []
  for (const id of order) {
    if (!enabled(id, inputs.mode, inputs.polled[source])) continue
    const r = source === 'claude'
      ? readClaude(id as ClaudeSourceId, inputs, now)
      : readCodex(id as CodexSourceId, inputs, now)
    readings.push(r)
    const c: Candidate = { id, ok: r.state.ok, ageSec: ageSec(r.state, now) }
    if (r.state.problem) c.problem = r.state.problem
    candidates.push(c)
  }

  let best: Reading | null = null
  let bestAt = Number.NEGATIVE_INFINITY
  for (const r of readings) {
    if (!r.state.ok) continue
    const at = typeof r.state.fetchedAt === 'number' && Number.isFinite(r.state.fetchedAt)
      ? r.state.fetchedAt
      : Number.NEGATIVE_INFINITY
    // Strictly greater: the configured order decides a tie, because the readings
    // are then equally current and the user said which they trust.
    if (best === null || at > bestAt) {
      best = r
      bestAt = at
    }
  }
  // The identity marker is not tied to the winner: only `~/.claude.json` carries
  // one, and the history fingerprint should use it whenever it is readable.
  const hint = (r: Reading[]) => r.map((x) => x.identityHint).find((h) => h !== null) ?? null
  if (best) return { state: best.state, candidates, identityHint: best.identityHint ?? hint(readings) }

  // Nothing worked: report the highest-ranked source's reason rather than the
  // last one tried, so the repair step matches what the user configured first.
  const first = readings[0]
  if (first) return { state: first.state, candidates, identityHint: hint(readings) }
  return {
    state: {
      source, ok: false, fetchedAt: null, planType: null, windows: [],
      problem: 'No quota source is enabled', problemKind: 'quotaOff',
    },
    candidates,
    identityHint: null,
  }
}
