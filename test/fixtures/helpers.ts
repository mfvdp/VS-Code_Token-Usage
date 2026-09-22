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

const madeTempDirs: string[] = []
let sweeperArmed = false

/**
 * The suite makes hundreds of scratch directories per run; nothing in a test can be
 * trusted to delete its own (a failing assertion skips the rest of the test), so they
 * are all swept once at process exit. `force` keeps a directory a test already removed
 * from turning the sweep into an error.
 */
function track(dir: string): string {
  madeTempDirs.push(dir)
  if (!sweeperArmed) {
    sweeperArmed = true
    process.once('exit', () => {
      for (const d of madeTempDirs) {
        try {
          fs.rmSync(d, { recursive: true, force: true })
        } catch {
          // A leftover directory must never change the exit code of the suite.
        }
      }
    })
  }
  return dir
}

/**
 * A fresh scratch directory, removed again when the process exits.
 * TOKEN_PACE_TEST_TMP relocates it (CI sandboxes, local scratchpads); `base` overrides
 * both, for callers that pick their own root.
 */
export function tmpDir(prefix: string, base?: string): string {
  const root = base || process.env.TOKEN_PACE_TEST_TMP || os.tmpdir()
  fs.mkdirSync(root, { recursive: true })
  return track(fs.mkdtempSync(path.join(root, `${prefix}-`)))
}

/**
 * Like tmpDir, but under whatever TOKEN_PACE_TEST_TMP names — a scratchpad, a CI sandbox —
 * and under the OS temp directory otherwise. Never a path baked into this file: one written
 * here is one machine's session directory, and it is gone by the next run.
 */
export function scratchDir(prefix: string): string {
  return tmpDir(prefix, process.env.TOKEN_PACE_TEST_TMP || os.tmpdir())
}

/** A path inside a fresh scratch directory, for tests that need one named file. */
export function scratchFile(prefix: string, name: string): string {
  return path.join(scratchDir(prefix), name)
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

/** A `tool_use` content block. `id: null` reproduces the (older) shape without a block id. */
export interface ClaudeToolBlock {
  name: string
  id?: string | null
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
  /** Content blocks of this line. Claude Code writes exactly one block per line. */
  tools?: ClaudeToolBlock[]
  /** Raw content blocks instead of `tools`, for a block whose input matters (an agent launch). */
  content?: unknown[]
  /** A line of an agent's own transcript: it names the agent and sits on the side chain. */
  agentId?: string
  /** What a final line gives as its stop reason; `end_turn` unless said otherwise. */
  stopReason?: string
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
  const content = o.content ?? (o.tools
    ? o.tools.map((t, i) => {
      const block: Record<string, unknown> = { type: 'tool_use', name: t.name, input: {} }
      if (t.id !== null) block.id = t.id ?? `toolu_${o.id}_${i}`
      return block
    })
    : [{ type: 'text', text: 'synthetic fixture text' }])
  const line: Record<string, unknown> = {
    parentUuid: 'uuid-parent-0000',
    isSidechain: o.agentId !== undefined,
  }
  if (o.agentId !== undefined) line.agentId = o.agentId
  Object.assign(line, {
    message: {
      model: o.synthetic ? '<synthetic>' : (o.model ?? 'claude-opus-4-6'),
      id: o.id,
      type: 'message',
      role: 'assistant',
      content,
      stop_reason: o.final ? (o.stopReason ?? 'end_turn') : null,
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
  })
  if (o.cwd !== null) line.cwd = o.cwd ?? '/home/tester/proj-alpha'
  if (o.sessionId !== null) line.sessionId = o.sessionId ?? 'sess-0001'
  if (o.error) line.isApiErrorMessage = true
  return JSON.stringify(line)
}

// ---------------------------------------------------------------------------
// Agents. The shapes are what Claude Code writes for a subagent (checked 2026-09-22):
// the launch and the answer in the parent's transcript, the task notification of a
// background agent, the workflow journal, the identity sidecar. Every description, prompt,
// summary and answer below is fixture text a record must never hold.
// ---------------------------------------------------------------------------

export interface AgentToolUseOpts {
  /** The assistant message id. */
  id: string
  ts: number
  toolUseId: string
  /** `Agent` in current builds, `Task` in older ones. */
  name?: 'Agent' | 'Task'
  /** `input.subagent_type`; absent by default, as for a general-purpose launch. */
  subagentType?: string
  /** `input.model`; `opus` unless null (then absent). */
  model?: string | null
  /** `input.run_in_background`; absent unless given. */
  background?: boolean
  description?: string
  prompt?: string
  usage?: ClaudeUsage
  /** The launch sits in this agent's own transcript (a nested agent). */
  agentId?: string
  final?: boolean
}

/** An assistant line whose one content block launches an agent. */
export function agentToolUseLine(o: AgentToolUseOpts): string {
  const input: Record<string, unknown> = { description: o.description ?? 'synthetic launch description' }
  if (o.subagentType !== undefined) input.subagent_type = o.subagentType
  if (o.model !== null) input.model = o.model ?? 'opus'
  if (o.background !== undefined) input.run_in_background = o.background
  input.prompt = o.prompt ?? 'synthetic launch prompt'
  return claudeLine({
    id: o.id,
    ts: o.ts,
    usage: o.usage ?? { input: 10, output: 20 },
    final: o.final ?? true,
    stopReason: 'tool_use',
    agentId: o.agentId,
    content: [{ type: 'tool_use', id: o.toolUseId, name: o.name ?? 'Agent', input, caller: { type: 'direct' } }],
  })
}

export interface AgentResultOpts {
  ts: number
  toolUseId: string
  agentId: string
  /** `async_launched` for a background launch; `completed`, `failed`, … for a sync one. */
  status?: string
  /** The parent's own report of a finished sync agent. */
  totals?: { tokens: number; durationMs: number; toolUses: number }
  description?: string
  prompt?: string
  /** The agent's answer, as the tool result's text. */
  answer?: string
  /** The line sits in this agent's own transcript (the answer to a nested launch). */
  inAgent?: string
}

/**
 * The user line that answers an agent launch: a `tool_result` block for the tool_use id and,
 * beside it, the `toolUseResult` object. A finished sync agent's result also carries the
 * agent's own usage summary — a report, which must never be counted as tokens.
 */
export function agentResultLine(o: AgentResultOpts): string {
  const status = o.status ?? 'completed'
  const answer = o.answer ?? 'synthetic agent answer'
  const result: Record<string, unknown> = status === 'async_launched'
    ? {
      isAsync: true, status, agentId: o.agentId, description: o.description ?? 'synthetic result description',
      resolvedModel: 'claude-opus-4-6', prompt: o.prompt ?? 'synthetic result prompt',
      outputFile: `/tmp/synthetic/tasks/${o.agentId}.output`, canReadOutputFile: true,
    }
    : {
      status, prompt: o.prompt ?? 'synthetic result prompt', agentId: o.agentId, agentType: 'general-purpose',
      content: [{ type: 'text', text: answer }], resolvedModel: 'claude-opus-4-6',
      usage: { input_tokens: 777, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 555 },
    }
  if (o.totals) {
    result.totalDurationMs = o.totals.durationMs
    result.totalTokens = o.totals.tokens
    result.totalToolUseCount = o.totals.toolUses
  }
  const line: Record<string, unknown> = { parentUuid: 'uuid-parent-0000', isSidechain: o.inAgent !== undefined, promptId: 'prompt-0000' }
  if (o.inAgent !== undefined) line.agentId = o.inAgent
  Object.assign(line, {
    type: 'user',
    message: {
      role: 'user',
      content: [{ tool_use_id: o.toolUseId, type: 'tool_result', content: [{ type: 'text', text: answer }] }],
    },
    uuid: `uuid-result-${o.toolUseId}`,
    timestamp: iso(o.ts),
    toolUseResult: result,
    sourceToolAssistantUUID: 'uuid-assistant-0000',
    userType: 'external',
    entrypoint: 'cli',
    cwd: '/home/tester/proj-alpha',
    sessionId: 'sess-0001',
    version: '9.9.9',
    gitBranch: 'main',
  })
  return JSON.stringify(line)
}

export interface QueueOperationOpts {
  ts: number
  /** Null leaves the tag out, as for a notification without a tool call behind it. */
  toolUseId?: string | null
  status?: string
  operation?: 'enqueue' | 'dequeue' | 'remove'
  summary?: string
  outputFile?: string
  /** The raw content, instead of a built notification. */
  content?: string
}

/** A queue operation carrying a background task's notification, one tag per line. */
export function queueOperationLine(o: QueueOperationOpts): string {
  const tags = ['<task-notification>', '<task-id>b0c1d2e3f</task-id>']
  if (o.toolUseId !== null) tags.push(`<tool-use-id>${o.toolUseId ?? 'toolu_synthetic'}</tool-use-id>`)
  tags.push(`<output-file>${o.outputFile ?? '/tmp/synthetic/tasks/b0c1d2e3f.output'}</output-file>`)
  tags.push(`<status>${o.status ?? 'completed'}</status>`)
  tags.push(`<summary>${o.summary ?? 'Agent "synthetic summary" completed'}</summary>`)
  tags.push('</task-notification>')
  return JSON.stringify({
    type: 'queue-operation',
    operation: o.operation ?? 'enqueue',
    timestamp: iso(o.ts),
    sessionId: 'sess-0001',
    content: o.content ?? tags.join('\n'),
  })
}

/**
 * One line of a workflow run's `journal.jsonl`. Journal lines carry no time today; `ts`
 * adds one, for the rule that a line's own time wins when there is one.
 */
export function journalLine(o: { type: 'started' | 'result'; agentId: string; result?: unknown; ts?: number }): string {
  const line: Record<string, unknown> = { type: o.type, key: `synthetic-journal-key-${o.agentId}`, agentId: o.agentId }
  if (o.type === 'result') line.result = o.result ?? { summary: 'synthetic journal summary', changedFiles: ['src/x.ts'] }
  if (o.ts !== undefined) line.timestamp = iso(o.ts)
  return JSON.stringify(line)
}

export interface MetaOpts {
  /** Null leaves a field out, as older or other sidecars do. */
  agentType?: string | null
  model?: string | null
  spawnDepth?: number | null
  toolUseId?: string | null
  description?: string
  prompt?: string
  parentAgentId?: string
  /** Any further key a sidecar carries (requestShape, worktreePath, …). */
  extra?: Record<string, unknown>
}

/** An `agent-<id>.meta.json` sidecar. Its description and prompt are content; only four fields may be read. */
export function metaJson(o: MetaOpts = {}): string {
  const meta: Record<string, unknown> = {}
  if (o.agentType !== null) meta.agentType = o.agentType ?? 'general-purpose'
  meta.description = o.description ?? 'synthetic meta description'
  if (o.toolUseId !== null) meta.toolUseId = o.toolUseId ?? 'toolu_synthetic'
  if (o.parentAgentId !== undefined) meta.parentAgentId = o.parentAgentId
  if (o.spawnDepth !== null) meta.spawnDepth = o.spawnDepth ?? 1
  if (o.model !== null) meta.model = o.model ?? 'opus'
  if (o.prompt !== undefined) meta.prompt = o.prompt
  Object.assign(meta, o.extra)
  return JSON.stringify(meta)
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

/**
 * A tool call as the current Codex builds record it: a `response_item` whose payload
 * carries the tool `name` and a `call_id`. `custom` picks the `custom_tool_call` shape
 * (what a shell call looks like) over the `function_call` one.
 */
export function codexToolCall(o: { ts: number; name: string; callId?: string; custom?: boolean; id?: string }): string {
  const callId = o.callId ?? `call_${o.name}`
  const payload: Record<string, unknown> = o.custom
    ? { type: 'custom_tool_call', id: o.id ?? `item_${callId}`, status: 'completed', call_id: callId, name: o.name, input: '{"cmd":"synthetic"}' }
    : { type: 'function_call', id: o.id ?? `item_${callId}`, name: o.name, namespace: null, arguments: '{"a":1}', call_id: callId }
  return JSON.stringify({ timestamp: iso(o.ts), type: 'response_item', payload })
}

/** The begin event older Codex builds write for a shell call. */
export function codexExecBegin(o: { ts: number; callId?: string }): string {
  return JSON.stringify({
    timestamp: iso(o.ts),
    type: 'event_msg',
    payload: { type: 'exec_command_begin', call_id: o.callId ?? 'call_exec', command: ['bash', '-lc', 'echo synthetic'], cwd: '/home/tester/proj-beta' },
  })
}

/** The begin event older Codex builds write for an MCP tool call. */
export function codexMcpBegin(o: { ts: number; server: string; tool: string; callId?: string }): string {
  return JSON.stringify({
    timestamp: iso(o.ts),
    type: 'event_msg',
    payload: {
      type: 'mcp_tool_call_begin',
      call_id: o.callId ?? `call_${o.server}_${o.tool}`,
      invocation: { server: o.server, tool: o.tool, arguments: { q: 'synthetic' } },
    },
  })
}

/** The `item_completed` echo of a call — the same call, reported a second time. */
export function codexItemCompleted(o: { ts: number; itemType: string; callId?: string }): string {
  return JSON.stringify({
    timestamp: iso(o.ts),
    type: 'event_msg',
    payload: {
      type: 'item_completed',
      thread_id: 'thread-0001',
      turn_id: 'turn-0001',
      item: { type: o.itemType, id: o.callId ?? 'call_exec', command: ['bash', '-lc', 'echo synthetic'], status: 'completed' },
      started_at_ms: o.ts,
      completed_at_ms: o.ts + 10,
    },
  })
}
