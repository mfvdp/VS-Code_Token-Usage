// SPDX-FileCopyrightText: 2026 Frederik Marx
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Builders for synthetic transcript lines. They reproduce the *shape* Claude Code
 * and Codex write (top-level keys, nesting, field names) with invented ids, models
 * and numbers — no line here was ever part of a real transcript.
 */

import { createHash } from 'crypto'
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
  /**
   * 1.6 N8: the line's top-level `effort` — `high` unless said otherwise (Claude Code writes one on
   * every reply line); null leaves the key out.
   */
  effort?: unknown
  /**
   * 1.6 O3 (§0a.7): the message's `diagnostics` — Claude Code writes `cache_miss_reason` there when
   * the cache missed; absent unless given.
   */
  diagnostics?: unknown
  /** 1.6 O3 (§0a.8): the line's top-level `version`; `9.9.9` unless given, left out when null. */
  version?: unknown
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
      ...(o.diagnostics === undefined ? {} : { diagnostics: o.diagnostics }),
    },
    requestId: `req_${o.id}`,
    type: o.type ?? 'assistant',
    uuid: `uuid-${o.id}-${Math.floor(o.ts / 1000)}`,
    timestamp: iso(o.ts),
    ...(o.effort === null ? {} : { effort: o.effort === undefined ? 'high' : o.effort }),
    userType: 'external',
    entrypoint: 'cli',
    ...(o.version === null ? {} : { version: o.version === undefined ? '9.9.9' : o.version }),
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

export interface WorkflowToolUseOpts {
  /** The assistant message id. */
  id: string
  ts: number
  toolUseId: string
  /** The workflow's script — content, as every other key of the input. */
  script?: string
  /** A resume names the run it continues; the result then names the same run id. */
  resumeFromRunId?: string
  /** The call sits in this agent's own transcript (not observed; the shape allows it). */
  agentId?: string
  usage?: ClaudeUsage
}

/**
 * An assistant line whose one content block calls the `Workflow` tool, with every input key
 * Claude Code writes (checked 2026-09-23: `script`, `scriptPath`, `args`, `resumeFromRunId`,
 * `description`, `run_in_background`) carrying fixture text. Of the block only its `id` may be read.
 */
export function workflowToolUseLine(o: WorkflowToolUseOpts): string {
  const input: Record<string, unknown> = {
    script: o.script ?? 'synthetic workflow script',
    scriptPath: '/tmp/synthetic/workflows/synthetic-flow.js',
    args: { goal: 'synthetic workflow args' },
    description: 'synthetic workflow description',
    run_in_background: true,
  }
  if (o.resumeFromRunId !== undefined) input.resumeFromRunId = o.resumeFromRunId
  return claudeLine({
    id: o.id,
    ts: o.ts,
    usage: o.usage ?? { input: 10, output: 20 },
    final: true,
    stopReason: 'tool_use',
    agentId: o.agentId,
    content: [{ type: 'tool_use', id: o.toolUseId, name: 'Workflow', input, caller: { type: 'direct' } }],
  })
}

export interface WorkflowResultOpts {
  ts: number
  toolUseId: string
  /** `wf_` + 8 hex + `-` + 3 hex in Claude Code's own results; anything here, to test the allow-list. */
  runId?: unknown
  /** `async_launched` in every result observed. */
  status?: string
  summary?: string
  /** The line sits in this agent's own transcript. */
  inAgent?: string
}

/**
 * The user line that answers a `Workflow` call: a `tool_result` block for its tool_use id and the
 * `toolUseResult` beside it, with every key Claude Code writes there (checked 2026-09-23: `runId`,
 * `scriptPath`, `status`, `summary`, `taskId`, `taskType`, `transcriptDir`, `workflowName`) — the
 * summary, the paths and the names fixture text. Only `runId` and `status` may be read.
 */
export function workflowResultLine(o: WorkflowResultOpts): string {
  const result: Record<string, unknown> = {
    status: o.status ?? 'async_launched',
    taskId: 'b9c8d7e6f',
    taskType: 'local_workflow',
    workflowName: 'synthetic-workflow-name',
    summary: o.summary ?? 'synthetic workflow summary',
    scriptPath: '/tmp/synthetic/workflows/synthetic-flow.js',
    transcriptDir: '/tmp/synthetic/transcripts/synthetic-run',
  }
  if (o.runId !== undefined) result.runId = o.runId
  const line: Record<string, unknown> = { parentUuid: 'uuid-parent-0000', isSidechain: o.inAgent !== undefined, promptId: 'prompt-0000' }
  if (o.inAgent !== undefined) line.agentId = o.inAgent
  Object.assign(line, {
    type: 'user',
    message: {
      role: 'user',
      content: [{ tool_use_id: o.toolUseId, type: 'tool_result', content: [{ type: 'text', text: 'synthetic workflow answer' }] }],
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

export interface ApiErrorOpts {
  /** The message id — every error line has one of its own. */
  id: string
  ts: number
  /** A line of this agent's own transcript (every rejection 1.6 reads is one). */
  agentId?: string
  /** `apiErrorStatus`; 429 unless given, left out when null (14 of 981 lines have none). */
  status?: unknown
  /** `error`; `rate_limit` unless given, left out when null. */
  error?: unknown
  /** `quotaLimits.rateLimitType`; `five_hour` unless given. */
  rateLimitType?: unknown
  /** The whole `quotaLimits` value instead of the built block; null leaves the key out. */
  quotaLimits?: unknown
  /** The error's text, the line's `message.content[0].text` — content. */
  text?: string
  /** `errorDetails` (a string on 48 lines) and `apiError` (17): content too, left out unless given. */
  errorDetails?: string
  apiError?: string
  /** `quotaLimits.upgradePaths` (280 lines): strings, left out unless given. */
  upgradePaths?: string[]
  /** 1.6 §0a.4: the line's `perTurnEffort` — null unless given; never read (an effort is a reply's). */
  perTurnEffort?: unknown
}

/**
 * The assistant line Claude Code writes for a request the API rejected — `isApiErrorMessage`,
 * a `<synthetic>` message with all-zero usage whose one text block is the error's text, and
 * beside it `apiErrorStatus`, `error` and the `quotaLimits` block (checked 2026-09-23, key names
 * and types only: 852 such lines in agent transcripts, keys in this order). Every string that is
 * not an allow-listed value is fixture text; of the line only `apiErrorStatus`, `error` and
 * `quotaLimits.rateLimitType` may be read.
 */
export function apiErrorLine(o: ApiErrorOpts): string {
  const line: Record<string, unknown> = { parentUuid: 'uuid-parent-0000', isSidechain: o.agentId !== undefined }
  if (o.agentId !== undefined) line.agentId = o.agentId
  const quota: Record<string, unknown> = {
    status: 'rejected',
    resetsAt: Math.floor(o.ts / 1000) + 3600,
    unifiedRateLimitFallbackAvailable: false,
    rateLimitType: o.rateLimitType === undefined ? 'five_hour' : o.rateLimitType,
    overageStatus: 'synthetic-overage-status',
    overageDisabledReason: 'synthetic overage reason',
    isUsingOverage: false,
  }
  if (o.upgradePaths !== undefined) quota.upgradePaths = o.upgradePaths
  Object.assign(line, {
    type: 'assistant',
    uuid: `uuid-${o.id}`,
    timestamp: iso(o.ts),
    message: {
      id: o.id,
      container: null,
      model: '<synthetic>',
      role: 'assistant',
      stop_details: null,
      stop_reason: 'stop_sequence',
      stop_sequence: '',
      type: 'message',
      usage: {
        input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0,
        server_tool_use: { web_search_requests: 0, web_fetch_requests: 0 }, service_tier: null,
        cache_creation: { ephemeral_1h_input_tokens: 0, ephemeral_5m_input_tokens: 0 }, inference_geo: null,
        iterations: null, speed: null, output_tokens_details: null,
      },
      content: [{ type: 'text', text: o.text ?? 'synthetic API error text' }],
      context_management: null,
      diagnostics: null,
    },
    requestId: `req_${o.id}`,
  })
  if (o.quotaLimits !== null) line.quotaLimits = o.quotaLimits === undefined ? quota : o.quotaLimits
  if (o.error !== null) line.error = o.error === undefined ? 'rate_limit' : o.error
  line.isApiErrorMessage = true
  if (o.status !== null) line.apiErrorStatus = o.status === undefined ? 429 : o.status
  if (o.errorDetails !== undefined) line.errorDetails = o.errorDetails
  if (o.apiError !== undefined) line.apiError = o.apiError
  Object.assign(line, {
    perTurnEffort: o.perTurnEffort === undefined ? null : o.perTurnEffort,
    userType: 'external',
    entrypoint: 'cli',
    cwd: '/home/tester/proj-alpha',
    sessionId: 'sess-0001',
    version: '9.9.9',
    gitBranch: 'main',
    slug: 'synthetic-slug',
  })
  return JSON.stringify(line)
}

// ---------------------------------------------------------------------------
// 1.6 O3 (§0a.6–0a.10): the lines the further metadata is read from — key names and order as
// counted on the measuring machine (2026-09-24, key names only). Every text is fixture text a record
// must never hold.
// ---------------------------------------------------------------------------

export interface ToolResultOpts {
  ts: number
  /** A line of this agent's own transcript. */
  agentId?: string
  /** The line's `tool_result` blocks: which call each answers, whether it is marked `is_error`, its output. */
  results: Array<{ toolUseId: string; isError?: boolean; text?: string }>
  /** The line's top-level `toolUseResult`: for a failed tool, Claude Code writes the error's text here. */
  toolUseResult?: unknown
}

/**
 * The user line that returns tool results: `tool_result` blocks keyed `type`, `content`, `is_error`,
 * `tool_use_id` (1360 of 1360 marked blocks) and, for a failed tool, a `toolUseResult` that is the
 * error's text, a string.
 */
export function toolResultLine(o: ToolResultOpts): string {
  const line: Record<string, unknown> = { parentUuid: 'uuid-parent-0000', isSidechain: o.agentId !== undefined, promptId: 'prompt-0000' }
  if (o.agentId !== undefined) line.agentId = o.agentId
  const failed = o.results.find((r) => r.isError === true)
  Object.assign(line, {
    type: 'user',
    message: {
      role: 'user',
      content: o.results.map((r) => {
        const block: Record<string, unknown> = { type: 'tool_result', content: r.text ?? 'synthetic tool output' }
        if (r.isError !== undefined) block.is_error = r.isError
        block.tool_use_id = r.toolUseId
        return block
      }),
    },
    uuid: `uuid-results-${o.results.map((r) => r.toolUseId).join('-')}`,
    timestamp: iso(o.ts),
    toolUseResult: o.toolUseResult !== undefined ? o.toolUseResult
      : failed ? `Error: ${failed.text ?? 'synthetic tool error'}` : { stdout: 'synthetic stdout', stderr: '', interrupted: false },
    sourceToolAssistantUUID: 'uuid-assistant-0000',
    userType: 'external',
    entrypoint: 'cli',
    cwd: '/home/tester/proj-alpha',
    sessionId: 'sess-0001',
    version: '9.9.9',
    gitBranch: 'main',
    slug: 'synthetic-slug',
  })
  return JSON.stringify(line)
}

export interface PromptLineOpts {
  ts: number
  agentId?: string
  /** The prompt — content. */
  text?: string
  /** The line's top-level `permissionMode`; `default` unless given, left out when null. */
  permissionMode?: unknown
  version?: string
}

/**
 * A prompt: the user line that opens a turn, its top-level `permissionMode` after its `timestamp`
 * (1124 of 1124 such lines, all in main transcripts). The prompt is content.
 */
export function promptLine(o: PromptLineOpts): string {
  const line: Record<string, unknown> = { parentUuid: null, isSidechain: o.agentId !== undefined, promptId: 'prompt-0001' }
  if (o.agentId !== undefined) line.agentId = o.agentId
  Object.assign(line, {
    type: 'user',
    message: { role: 'user', content: o.text ?? 'synthetic prompt text' },
    uuid: `uuid-prompt-${Math.floor(o.ts / 1000)}`,
    timestamp: iso(o.ts),
  })
  if (o.permissionMode !== null) line.permissionMode = o.permissionMode === undefined ? 'default' : o.permissionMode
  Object.assign(line, {
    userType: 'external',
    entrypoint: 'cli',
    cwd: '/home/tester/proj-alpha',
    sessionId: 'sess-0001',
    version: o.version ?? '9.9.9',
    gitBranch: 'main',
    slug: 'synthetic-slug',
  })
  return JSON.stringify(line)
}

export interface CompactBoundaryOpts {
  ts: number
  agentId?: string
  /** `manual` unless given; null leaves it out. */
  trigger?: unknown
  preTokens?: unknown
  postTokens?: unknown
  /** The whole `compactMetadata` instead of the built block; null leaves the key out. */
  metadata?: unknown
  /** What the compaction preserved — content. */
  preserved?: string
}

/**
 * The line Claude Code writes where it compacted a transcript: `type: system`, `subtype:
 * compact_boundary`, and a `compactMetadata` block keyed `trigger`, `preTokens`, `durationMs`,
 * `preCompactDiscoveredTools`, `preservedSegment`, `preservedMessages`, `postTokens`,
 * `cumulativeDroppedTokens` (42 of 44). Of it only the trigger and the two token figures may be read.
 */
export function compactBoundaryLine(o: CompactBoundaryOpts): string {
  const preserved = o.preserved ?? 'synthetic preserved segment'
  const meta: Record<string, unknown> = {}
  if (o.trigger !== null) meta.trigger = o.trigger === undefined ? 'manual' : o.trigger
  meta.preTokens = o.preTokens === undefined ? 167_200 : o.preTokens
  Object.assign(meta, {
    durationMs: 41_000,
    preCompactDiscoveredTools: [`mcp__synthetic__${preserved.replace(/[^A-Za-z0-9]/g, '_')}`],
    preservedSegment: { headUuid: 'uuid-head-0000', tailUuid: 'uuid-tail-0000', text: preserved },
    preservedMessages: [{ role: 'user', content: preserved }],
  })
  meta.postTokens = o.postTokens === undefined ? 12_400 : o.postTokens
  meta.cumulativeDroppedTokens = 154_800
  const line: Record<string, unknown> = {
    parentUuid: null, logicalParentUuid: 'uuid-logical-0000', isSidechain: o.agentId !== undefined,
  }
  if (o.agentId !== undefined) line.agentId = o.agentId
  Object.assign(line, {
    type: 'system',
    subtype: 'compact_boundary',
    content: 'Conversation compacted',
    isMeta: false,
    timestamp: iso(o.ts),
    uuid: `uuid-compact-${Math.floor(o.ts / 1000)}`,
    level: 'info',
  })
  if (o.metadata !== null) line.compactMetadata = o.metadata === undefined ? meta : o.metadata
  Object.assign(line, {
    userType: 'external', entrypoint: 'cli', cwd: '/home/tester/proj-alpha', sessionId: 'sess-0001', version: '9.9.9',
    gitBranch: 'main', slug: 'synthetic-slug',
  })
  return JSON.stringify(line)
}

/** The user line a compaction leaves its summary on (`isCompactSummary`): the summary is content. */
export function compactSummaryLine(o: { ts: number; summary?: string; agentId?: string }): string {
  const line: Record<string, unknown> = { parentUuid: 'uuid-compact-0000', isSidechain: o.agentId !== undefined, promptId: 'prompt-0002' }
  if (o.agentId !== undefined) line.agentId = o.agentId
  Object.assign(line, {
    type: 'user',
    message: { role: 'user', content: o.summary ?? 'synthetic compaction summary' },
    isVisibleInTranscriptOnly: true,
    isCompactSummary: true,
    uuid: `uuid-summary-${Math.floor(o.ts / 1000)}`,
    timestamp: iso(o.ts),
    userType: 'external', entrypoint: 'cli', cwd: '/home/tester/proj-alpha', sessionId: 'sess-0001', version: '9.9.9',
    gitBranch: 'main', slug: 'synthetic-slug',
  })
  return JSON.stringify(line)
}

/**
 * A journal key in the shape Claude Code writes — `v2:` and 64 hex digits (5643 of 5643 keys on
 * the measuring machine) — made from a step name: the sha256 of `synthetic-journal-step-<step>`.
 * The same step gives the same key, so a step started again is a retry or a replacement.
 */
export function journalKey(step: string | number, version = 'v2'): string {
  return `${version}:${createHash('sha256').update(`synthetic-journal-step-${step}`).digest('hex')}`
}

export interface JournalLineOpts {
  type: 'started' | 'result' | 'failed' | 'launched'
  /** Absent only on `launched`, which carries its type alone. */
  agentId?: string
  /** The step whose key the line carries; the agent's own id unless given — one step per agent. */
  step?: string | number
  /** The key itself instead of `journalKey(step)`; null leaves it out. */
  key?: string | null
  /** A `result` line's result; synthetic content by default. */
  result?: unknown
  /** A `started` line's label and phase (1405 of 2861 carry them); synthetic content by default. */
  label?: string | null
  phase?: string | null
}

/**
 * One line of a workflow run's `journal.jsonl`, keys in the order Claude Code writes them:
 * `type`, `key`, `agentId`, then — on a started line — `label` and `phase`, on a result line the
 * `result`. Journal lines carry no time. `launched` is `{"type":"launched"}` and nothing else.
 */
export function journalLine(o: JournalLineOpts): string {
  if (o.type === 'launched') return JSON.stringify({ type: 'launched' })
  const line: Record<string, unknown> = { type: o.type }
  const key = o.key !== undefined ? o.key : journalKey(o.step ?? o.agentId ?? 'none')
  if (key !== null) line.key = key
  if (o.agentId !== undefined) line.agentId = o.agentId
  if (o.type === 'started') {
    if (o.label !== null) line.label = o.label ?? 'synthetic journal label'
    if (o.phase !== null) line.phase = o.phase ?? 'synthetic journal phase'
  }
  if (o.type === 'result') line.result = o.result ?? { summary: 'synthetic journal summary', changedFiles: ['src/x.ts'] }
  return JSON.stringify(line)
}

export interface RunRecordOpts {
  runId?: string
  /** The seven fields 1.6 L4 reads; `undefined` gives a default, null leaves the key out. */
  status?: unknown
  startTime?: unknown
  durationMs?: unknown
  agentCount?: unknown
  totalTokens?: unknown
  totalToolCalls?: unknown
  defaultModel?: unknown
  /** The text every content field carries — script, logs, result, summary, args, … */
  secret?: string
  /** Bytes of synthetic script and log text written before the seven fields (a real record's are 60 KB at the median). */
  pad?: number
  /** Further top-level keys, after everything else (a duplicate key, an account id, …). */
  extra?: Record<string, unknown>
}

/**
 * Claude Code's run record of a workflow run, `<session>/workflows/<runId>.json` (1.6 L4, §0a.12), in
 * the shape counted on the measuring machine (key names only): one line, no indentation, the run's
 * content — its `script`, `args`, `phases`, `logs`, `workflowProgress`, `result`, `summary` — before
 * the seven figures a reader may take. Every content field carries fixture text with escaped quotes,
 * braces and a nested object that has keys named like the seven, which a reader must never take.
 */
export function runRecordJson(o: RunRecordOpts = {}): string {
  const secret = o.secret ?? 'synthetic run record'
  const pad = o.pad ?? 0
  const logLine = `${secret} log: said "{\"status\":\"failed\",\"totalTokens\":1}" and {brace} [bracket] \\ `
  const logs: string[] = []
  for (let n = 0, size = 0; size < pad; n++) {
    const entry = `${n} ${logLine}`
    logs.push(entry)
    size += entry.length
  }
  const rec: Record<string, unknown> = {
    runId: o.runId ?? 'wf_5eed1234-abc',
    taskId: `${secret}-task`,
    workflowName: `${secret}-workflow-name`,
    scriptPath: `/tmp/synthetic/workflows/${secret}.js`,
    script: `// ${secret} script\nexport default async function run() { return { status: "failed", "totalTokens": 7 } }`,
    args: { prompt: `${secret} prompt`, files: ['src/a.ts'] },
    timestamp: '2026-09-03T11:00:00.000Z',
    phases: [{ name: `${secret} phase`, status: 'failed', totalTokens: 1, agentCount: 99 }],
    logs,
    workflowProgress: { status: 'failed', durationMs: 5, defaultModel: `${secret}-model`, steps: [{ status: 'killed' }] },
    result: { text: `${secret} result`, status: 'failed', totalToolCalls: 3 },
    summary: `${secret} summary`,
    error: null,
  }
  const put = (key: string, v: unknown, fallback: unknown): void => {
    if (v === null) return
    rec[key] = v === undefined ? fallback : v
  }
  put('status', o.status, 'completed')
  put('startTime', o.startTime, Date.UTC(2026, 8, 3, 11, 0, 0))
  put('agentCount', o.agentCount, 3)
  put('totalTokens', o.totalTokens, 48_210)
  put('totalToolCalls', o.totalToolCalls, 17)
  put('durationMs', o.durationMs, 1_265_000)
  put('defaultModel', o.defaultModel, 'claude-fable-5-1[1m]')
  return JSON.stringify({ ...rec, ...(o.extra ?? {}) })
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

/** An `agent-<id>.meta.json` sidecar. Its description and prompt are content; only five fields may be read (1.6 O3). */
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

// ---------------------------------------------------------------------------
// 1.8 §0a.1: a status-line payload with synthetic text under every neighbouring key
// ---------------------------------------------------------------------------

/** The session id of `leakyStatusPayload`: nothing but its first eight characters may ever be shown. */
export const LEAK_SESSION_ID = '9d0eb37a-0000-4000-8000-000000000001'

/**
 * Every synthetic string `leakyStatusPayload` carries under a key no reader of the status line
 * takes — the session's name, its working directory, its transcript's path, the workspace, the
 * pull request, the worktree, the agent, the prompt id, the miss causes, the version and free text
 * inside the blocks that are read. None of them may reach an output, the mirror included (§7a Q11).
 */
export const LEAK_STATUS_SECRETS = [
  'SL-SESSION-NAME-7c1f', 'SL-PROMPT-ID-7c1f', 'SL-TRANSCRIPT-7c1f', 'SL-CWD-7c1f', 'SL-WORKSPACE-7c1f',
  'SL-PR-URL-7c1f', 'SL-WORKTREE-7c1f', 'SL-AGENT-7c1f', 'SL-MISS-CAUSE-7c1f', 'SL-VERSION-7c1f', 'SL-FREE-TEXT-7c1f',
] as const

/**
 * A status-line payload in the shape Claude Code pipes into its `statusLine.command` (the fields
 * its status-line page documents), with the reader's fields filled — a 1 h prompt cache warm for
 * another 50 minutes that would re-cache 152 300 tokens — and synthetic text everywhere else.
 * Invented throughout; never a payload seen on a machine.
 */
export function leakyStatusPayload(nowMs: number): Record<string, unknown> {
  const sec = Math.floor(nowMs / 1000)
  return {
    session_id: LEAK_SESSION_ID,
    session_name: 'SL-SESSION-NAME-7c1f refactor the login page',
    prompt_id: 'SL-PROMPT-ID-7c1f',
    transcript_path: '/home/tester/.claude/projects/-home-tester-SL-TRANSCRIPT-7c1f/session.jsonl',
    cwd: '/home/tester/SL-CWD-7c1f',
    workspace: { current_dir: '/home/tester/SL-WORKSPACE-7c1f', project_dir: '/home/tester/SL-WORKSPACE-7c1f/app' },
    pr: { url: 'example.invalid/pull/SL-PR-URL-7c1f', number: 7 },
    worktree: { path: '/home/tester/SL-WORKTREE-7c1f', name: 'SL-WORKTREE-7c1f' },
    agent: { name: 'SL-AGENT-7c1f' },
    version: 'SL-VERSION-7c1f',
    output_style: { name: 'SL-FREE-TEXT-7c1f style' },
    effort: 'high',
    fast_mode: false,
    exceeds_200k_tokens: false,
    model: { id: 'claude-opus-5-5', display_name: 'Opus 5.5', note: 'SL-FREE-TEXT-7c1f in the model' },
    rate_limits: {
      five_hour: { used_percentage: 44, resets_at: sec + 3_600, label: 'SL-FREE-TEXT-7c1f in a window' },
      seven_day: { used_percentage: 12, resets_at: sec + 3 * 86_400 },
    },
    context_window: {
      total_input_tokens: 120_000, total_output_tokens: 8_000, context_window_size: 200_000, used_percentage: 64,
      remaining_percentage: 36,
    },
    cost: { total_cost_usd: 1.25, total_duration_ms: 90_000, total_lines_added: 3, total_lines_removed: 1 },
    prompt_cache: {
      warm: true, ttl: '1h', expires_at: sec + 50 * 60, hit_ratio: 0.82, recache_tokens_if_cold: 152_300,
      caching_observed: true, requests: 12, misses: 1, expected_rebuilds: 0, cache_write_tokens: 4_000,
      miss_recache_tokens: 3_000, last_miss_at: sec - 600,
      last_miss_cause: { kind: 'tools_changed', causes: ['SL-MISS-CAUSE-7c1f the tool list changed'] },
      miss_causes: { tools_changed: 1, note: 'SL-MISS-CAUSE-7c1f' },
    },
  }
}

/** A mirror as a 1.3–1.7 bridge wrote it: `leakyStatusPayload` whole, not narrowed. */
export function writeLeakyMirror(file: string, writtenAtMs: number, nowMs: number = writtenAtMs): void {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify({ schema_version: 1, written_at: writtenAtMs, payload: leakyStatusPayload(nowMs) }))
}
