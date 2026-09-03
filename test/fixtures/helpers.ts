// SPDX-FileCopyrightText: 2026 Frederik Marx
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Builders for synthetic transcript lines. They reproduce the *shape* Claude Code
 * and Codex write (top-level keys, nesting, field names) with invented ids, models
 * and numbers — no line here was ever part of a real transcript.
 */

import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { IngestContext } from '../../src/agg'

/** A fresh scratch directory; TOKEN_PACE_TEST_TMP relocates it (CI sandboxes, local scratchpads). */
export function tmpDir(prefix: string): string {
  const base = process.env.TOKEN_PACE_TEST_TMP || os.tmpdir()
  fs.mkdirSync(base, { recursive: true })
  return fs.mkdtempSync(path.join(base, `${prefix}-`))
}

export function iso(ms: number): string {
  return new Date(ms).toISOString()
}

export const CLAUDE_ROOT = path.join('/virtual', 'claude', 'projects')
export const CODEX_ROOT = path.join('/virtual', 'codex', 'sessions')
export const CLAUDE_SLUG = '-home-tester-proj-alpha'
export const CLAUDE_MAIN = path.join(CLAUDE_ROOT, CLAUDE_SLUG, 'sess-0001.jsonl')
export const CLAUDE_SUB = path.join(CLAUDE_ROOT, CLAUDE_SLUG, 'sess-0001', 'subagents', 'agent-a1.jsonl')
export const CODEX_FILE = path.join(CODEX_ROOT, '2026', '03', '10', 'rollout-2026-03-10T09-00-00-thread-0001.jsonl')

export function ctxFor(over: Partial<IngestContext> = {}): IngestContext {
  return { isSub: false, file: CLAUDE_MAIN, attribution: 'none', projectSalt: '', hashProjects: false, ...over }
}

export interface ClaudeUsage {
  input?: number
  cacheWrite?: number
  cacheWrite1h?: number
  cacheRead?: number
  output?: number
  thinking?: number
  webSearch?: number
  webFetch?: number
  speed?: 'standard' | 'fast' | null
  geo?: 'us' | 'not_available' | null
}

export interface ClaudeLineOpts {
  id: string
  ts: number
  model?: string
  usage?: ClaudeUsage
  final?: boolean
  sessionId?: string | null
  cwd?: string | null
  synthetic?: boolean
  error?: boolean
  type?: string
}

/** One assistant line as Claude Code writes it, one content block per line. */
export function claudeLine(o: ClaudeLineOpts): string {
  const u = o.usage ?? {}
  const cacheWrite = u.cacheWrite ?? 0
  const cacheWrite1h = u.cacheWrite1h ?? 0
  const usage: Record<string, unknown> = {
    input_tokens: u.input ?? 0,
    cache_creation_input_tokens: cacheWrite,
    cache_read_input_tokens: u.cacheRead ?? 0,
    output_tokens: u.output ?? 0,
    output_tokens_details: { thinking_tokens: u.thinking ?? 0 },
    server_tool_use: { web_search_requests: u.webSearch ?? 0, web_fetch_requests: u.webFetch ?? 0 },
    service_tier: 'standard',
    cache_creation: { ephemeral_1h_input_tokens: cacheWrite1h, ephemeral_5m_input_tokens: cacheWrite - cacheWrite1h },
    inference_geo: u.geo === undefined ? 'not_available' : u.geo,
    iterations: [{ type: 'message', input_tokens: u.input ?? 0, output_tokens: u.output ?? 0 }],
    speed: u.speed === undefined ? 'standard' : u.speed,
  }
  const line: Record<string, unknown> = {
    parentUuid: 'uuid-parent-0000',
    isSidechain: false,
    message: {
      model: o.synthetic ? '<synthetic>' : (o.model ?? 'claude-opus-4-6'),
      id: o.id,
      type: 'message',
      role: 'assistant',
      content: [{ type: 'text', text: 'synthetic fixture text' }],
      stop_reason: o.final ? 'end_turn' : null,
      stop_sequence: null,
      stop_details: null,
      usage,
    },
    requestId: `req_${o.id}`,
    type: o.type ?? 'assistant',
    uuid: `uuid-${o.id}-${Math.floor(o.ts / 1000)}`,
    timestamp: iso(o.ts),
    effort: 'high',
    userType: 'external',
    entrypoint: 'cli',
    version: '9.9.9',
    gitBranch: 'main',
  }
  if (o.cwd !== null) line.cwd = o.cwd ?? '/home/tester/proj-alpha'
  if (o.sessionId !== null) line.sessionId = o.sessionId ?? 'sess-0001'
  if (o.error) line.isApiErrorMessage = true
  return JSON.stringify(line)
}

export function codexMeta(o: { ts: number; id?: string; cwd?: string | null; forkedFrom?: string; threadSource?: string }): string {
  const payload: Record<string, unknown> = { id: o.id ?? 'thread-0001', originator: 'codex_cli_rs', cli_version: '0.0.0' }
  if (o.cwd !== null) payload.cwd = o.cwd ?? '/home/tester/proj-beta'
  if (o.forkedFrom) payload.forked_from_id = o.forkedFrom
  if (o.threadSource) payload.thread_source = o.threadSource
  return JSON.stringify({ timestamp: iso(o.ts), type: 'session_meta', payload })
}

export function codexTurnContext(ts: number, model: string): string {
  return JSON.stringify({ timestamp: iso(ts), type: 'turn_context', payload: { model, cwd: '/home/tester/proj-beta' } })
}

export function codexTaskStarted(ts: number): string {
  return JSON.stringify({ timestamp: iso(ts), type: 'event_msg', payload: { type: 'task_started', turn_id: 'turn-0001' } })
}

export interface CodexUsage {
  input?: number
  cached?: number
  output?: number
  reasoning?: number
  total: number
}

function usageBlock(u: CodexUsage): Record<string, number> {
  return {
    input_tokens: u.input ?? 0,
    cached_input_tokens: u.cached ?? 0,
    output_tokens: u.output ?? 0,
    reasoning_output_tokens: u.reasoning ?? 0,
    total_tokens: u.total,
  }
}

export function snakeRateLimits(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    limit_id: 'codex',
    limit_name: 'Codex',
    primary: { used_percent: 12.5, window_minutes: 300, resets_at: 1773140000 },
    secondary: { used_percent: 40, window_minutes: 10080, resets_at: 1773500000 },
    credits: { has_credits: true, unlimited: false, balance: '12.50' },
    individual_limit: true,
    spend_control_reached: false,
    plan_type: 'pro',
    rate_limit_reached_type: null,
    ...over,
  }
}

export function camelRateLimits(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    limitId: 'codex_zeta',
    limitName: 'Zeta',
    primary: { usedPercent: 3, windowMinutes: 300, resetsAt: 1773140000 },
    secondary: null,
    credits: { hasCredits: false, unlimited: false, balance: null },
    planType: 'plus',
    rateLimitReachedType: 'primary',
    ...over,
  }
}

/**
 * One token_count event. `rateLimits` may be an object (snake or camel case), `null`
 * (written by newer Codex builds when nothing is known) or 'absent' (key missing);
 * `camel` puts the block under `rateLimits` instead of `rate_limits`.
 */
export function codexTokenCount(o: {
  ts: number
  total: CodexUsage
  last?: CodexUsage
  rateLimits?: Record<string, unknown> | null | 'absent'
  camel?: boolean
}): string {
  const payload: Record<string, unknown> = {
    type: 'token_count',
    info: {
      total_token_usage: usageBlock(o.total),
      last_token_usage: usageBlock(o.last ?? o.total),
      model_context_window: 400000,
    },
  }
  if (o.rateLimits !== 'absent') payload[o.camel ? 'rateLimits' : 'rate_limits'] = o.rateLimits ?? null
  return JSON.stringify({ timestamp: iso(o.ts), type: 'event_msg', payload })
}
