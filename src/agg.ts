// SPDX-FileCopyrightText: 2026 Frederik Marx
// SPDX-License-Identifier: AGPL-3.0-or-later

import { createHash } from 'crypto'
import * as path from 'path'
// Value import, and safe: `adapters` imports this module for types only, so the cycle is erased.
import { isKnownSource } from './adapters'
import { AGENT_RETENTION_DAYS } from './agentTree'
import { PricingOptions, costOfBucket, isCustomPricing } from './prices'
import { SYSTEM_TIME_CONFIG, TimeConfig, addDays, dayOf, dayOfHour, hourIndex, monthOf } from './time'
import {
  AgentLaunch, AgentMeta, AgentRec, Attribution, Bucket, MainRec, CodexRateLimitsSnapshot, Cursor, PendingMessage, Resolution, SessionRec,
  Snapshot, Source, Tier, ToolStat, bucketKey, emptyBucket, READABLE_STATE_VERSIONS, STATE_VERSION,
  TOOL_IDS_PER_MESSAGE, TOOL_NAME_CAP, TOOL_NAME_MAX_CHARS, toolDayKey, toolKey,
} from './types'

/** Per-file context the scanner hands to every ingest call. */
export interface IngestContext {
  isSub: boolean
  file: string
  attribution: Attribution
  projectSalt: string
  hashProjects: boolean
  /** Replay: touch only agents/launches/mains/journal, never buckets, pending, sessions, tools or cursors. */
  agentsOnly?: boolean
}

export interface BucketFilter {
  source?: Source
  models?: string[]
  isSub?: boolean
  tier?: Tier
}

/**
 * What the tool side table can be asked. It is keyed by source, day, model and name only:
 * subagent and tier are bucket dimensions the table does not carry, and answering them
 * would mean inventing a split, so they are not offered here.
 */
export interface ToolFilter {
  source?: Source
  models?: string[]
}

export interface ToolQuery {
  /** Copies, sorted by day, source, name, model — the caller may not mutate the table. */
  rows: ToolStat[]
  /** A day inside the answer hit `TOOL_NAME_CAP`: its list of names is incomplete. */
  truncated: boolean
  /** Earliest day with a row in the answer — the "counted since" a view has to state. */
  firstDay: string | null
}

export type Metric = 'usage' | 'output' | 'cacheRead' | 'requests' | 'reasoning' | 'cost'

export interface CostSummary {
  usd: number
  listUsd: number
  /** Billable tokens of models with no price at all. */
  unpricedTokens: number
  unpricedModels: string[]
  /** Billable tokens of fast-mode requests whose model has no published fast rate. */
  fastUnpricedTokens: number
  familyPriced: string[]
  custom: boolean
}

/** Local day (not UTC!) as YYYY-MM-DD in the machine zone. Codex rollouts are UTC; on late
 *  evenings in UTC+2 that would put up to 495M tokens on the wrong day. Used at ingest so the
 *  `day` of hour buckets stays monotone with their `hour`. */
export function localDay(ms: number): string {
  const d = new Date(ms)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/** The figure that actually means "usage": fresh input plus output. Cache reads
 *  otherwise dominate by a factor of ~1000 and make any total unreadable. */
export function billable(b: Bucket): number {
  const fresh = b.source === 'codex' ? Math.max(0, b.input - b.cacheRead) : b.input
  return fresh + b.cacheWrite + b.output
}

const MS_HOUR = 3_600_000
/** Eight days of per-session hour slices — one day more than the longest quota window. */
const SESSION_HOUR_KEEP = 8 * 24

/**
 * How far back the tool side table is kept, whatever `retentionDays` says.
 *
 * A day bucket past the horizon is folded into a month bucket — a handful of rows survive
 * a year. A tool row cannot be: it is keyed day × model × name, so keeping it for the
 * default 400 days would leave tens of thousands of rows in a snapshot that is
 * JSON.stringify'd on every save and synchronously on shutdown (400 days × 3 models ×
 * 40 names is already megabytes). Ninety days answers every range the views offer without
 * that weight, and `ToolQuery.firstDay` makes the shorter horizon self-describing:
 * the section states "tool calls counted since <firstDay>".
 */
const TOOL_KEEP_DAYS = 90

/** Turn gaps per session are a bounded sample, not a log — 200 is enough for a P90. */
const TURN_GAP_CAP = 200

/** Recent Codex tool call ids kept for dedup; a few thousand span far more than one scan. */
const TOOL_CALL_MEMORY = 4000

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null
}

/** Fast mode and US-only inference are independent surcharges, hence four tiers. */
function tierOf(speed: unknown, geo: unknown): Tier {
  const fast = speed === 'fast'
  const us = geo === 'us'
  if (fast && us) return 'fast-us'
  if (fast) return 'fast'
  if (us) return 'us'
  return 'standard'
}

function timeKey(cfg: TimeConfig): string {
  return `${cfg.zone}|${cfg.dayBoundaryHour}`
}

/** First and last calendar day of a YYYY-MM month, so a month bucket can be range-checked. */
function monthBounds(month: string): { first: string; last: string } {
  const first = `${month}-01`
  const y = Number(month.slice(0, 4))
  const m = Number(month.slice(5, 7))
  const days = Number.isFinite(y) && Number.isFinite(m) ? new Date(Date.UTC(y, m, 0)).getUTCDate() : 31
  return { first, last: `${month}-${String(days).padStart(2, '0')}` }
}

/**
 * A pseudonym for a project that survives renames of nothing but is stable for one path:
 * the salt is per installation, so two people with the same checkout path do not share it.
 */
function projectHashOf(salt: string, full: string): string {
  return createHash('sha256').update(salt + full).digest('hex').slice(0, 12)
}

/**
 * Reads the rate-limit block Codex writes into token_count events. Both the snake_case
 * schema of the rollouts and the camelCase one of the app-server are accepted, because
 * the block moved between the two across versions. Anything not a finite number is
 * dropped rather than clamped: a window with an unusable percentage is no window.
 */
export function parseCodexRateLimits(rl: unknown, t: number): CodexRateLimitsSnapshot | null {
  if (!rl || typeof rl !== 'object') return null
  const r = rl as Record<string, unknown>
  const pick = (a: string, b: string): unknown => (r[a] !== undefined ? r[a] : r[b])
  const window = (w: unknown): CodexRateLimitsSnapshot['primary'] => {
    if (!w || typeof w !== 'object') return null
    const o = w as Record<string, unknown>
    const used = o.used_percent !== undefined ? o.used_percent : o.usedPercent
    if (typeof used !== 'number' || !Number.isFinite(used) || used < 0) return null
    const mins = o.window_minutes !== undefined ? o.window_minutes : o.windowMinutes
    const reset = o.resets_at !== undefined ? o.resets_at : o.resetsAt
    let resetsAt: number | null = null
    if (typeof reset === 'number' && Number.isFinite(reset) && reset > 0) {
      // Rollouts write epoch seconds; anything that already looks like milliseconds is kept.
      resetsAt = reset < 1e12 ? Math.round(reset * 1000) : Math.round(reset)
    }
    return {
      usedPercent: used,
      windowMinutes: typeof mins === 'number' && Number.isFinite(mins) && mins > 0 ? mins : null,
      resetsAt,
    }
  }
  const creditsRaw = r.credits
  let credits: CodexRateLimitsSnapshot['credits'] = null
  if (creditsRaw && typeof creditsRaw === 'object') {
    const c = creditsRaw as Record<string, unknown>
    const bal = c.balance
    credits = {
      hasCredits: (c.has_credits !== undefined ? c.has_credits : c.hasCredits) === true,
      unlimited: c.unlimited === true,
      balance: typeof bal === 'string' ? bal : typeof bal === 'number' && Number.isFinite(bal) ? String(bal) : null,
    }
  }
  const reached = pick('rate_limit_reached_type', 'rateLimitReachedType')
  return {
    t,
    // The account-wide limit carries no id in older rollouts; "codex" is what the
    // app-server names it, so both schemas end up under one key.
    limitId: str(pick('limit_id', 'limitId')) ?? 'codex',
    limitName: str(pick('limit_name', 'limitName')),
    planType: str(pick('plan_type', 'planType')),
    primary: window(r.primary),
    secondary: window(r.secondary),
    credits,
    limitReached: reached !== null && reached !== undefined,
  }
}

// ---------------------------------------------------------------------------
// Agents: what the tables take from a transcript, and how
// ---------------------------------------------------------------------------

/**
 * Caps for the free strings the agent tables take from a transcript or a sidecar. Every one
 * of them is an identifier — a type, a model, a tool_use id — and is held to a small
 * alphabet on the way in. A value that does not fit is dropped whole rather than trimmed into
 * a string nobody wrote; the tree shows the absence as "–".
 */
export const AGENT_NAME_MAX_CHARS = 40
export const AGENT_ID_MAX_CHARS = 64
/** Real model ids (`message.model`) run longer than the aliases a launch or a sidecar names. */
export const AGENT_MODEL_MAX_CHARS = 64
/** Distinct model ids kept per agent or main session record. */
export const AGENT_MODELS_MAX = 8
/** No build spawns agents this deep; a larger "depth" is not one and is dropped. */
const MAX_SPAWN_DEPTH = 99
const MS_DAY = 86_400_000

const NAME_ALPHABET = /^[A-Za-z0-9_.:@/-]+$/
const ID_ALPHABET = /^[A-Za-z0-9_-]+$/

/** An agent type or a model: `[A-Za-z0-9_.:@/-]`, 1 to `max` characters; anything else is null. */
export function cleanAgentName(v: unknown, max = AGENT_NAME_MAX_CHARS): string | null {
  return typeof v === 'string' && v.length > 0 && v.length <= max && NAME_ALPHABET.test(v) ? v : null
}

/** A tool_use id, an agent id, a workflow id: `[A-Za-z0-9_-]`, 1 to 64 characters; else null. */
export function cleanAgentId(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 && v.length <= AGENT_ID_MAX_CHARS && ID_ALPHABET.test(v) ? v : null
}

function cleanDepth(v: unknown): number | null {
  return typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= MAX_SPAWN_DEPTH ? v : null
}

/**
 * A name a record cannot do without: the session id above `subagents`, or a main transcript's
 * file name. A Claude Code session id is a UUID and passes unchanged; anything else is cut down
 * to the id alphabet and cap instead of dropped. The path it comes from is the record's key
 * anyway, so the clipped name reveals nothing the key does not.
 */
function clipId(v: string): string {
  return v.replace(/[^A-Za-z0-9_-]/g, '').slice(0, AGENT_ID_MAX_CHARS)
}

/** The four identity fields, each through its sanitiser; null when none of them is usable. */
function cleanMeta(v: unknown): AgentMeta | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null
  const o = v as Record<string, unknown>
  const meta: AgentMeta = {
    agentType: cleanAgentName(o.agentType),
    model: cleanAgentName(o.model),
    spawnDepth: cleanDepth(o.spawnDepth),
    toolUseId: cleanAgentId(o.toolUseId),
  }
  return meta.agentType === null && meta.model === null && meta.spawnDepth === null && meta.toolUseId === null
    ? null
    : meta
}

/**
 * The identity an `agent-<id>.meta.json` gives its transcript: `agentType`, `model`,
 * `spawnDepth` and `toolUseId`, each through its sanitiser, and nothing else. The sidecar also
 * holds the agent's description and its whole prompt; those are content, and the parsed
 * object that holds them does not outlive this call. Null when the text is no JSON object or
 * none of the four fields is usable.
 */
export function parseAgentMeta(text: string): AgentMeta | null {
  let parsed: unknown
  try { parsed = JSON.parse(text) } catch { return null }
  return cleanMeta(parsed)
}

/** Where a Claude transcript sits, and what that says about it. */
export interface ClaudePlacement {
  /** The project directory's name — the fallback project label when a line carries no cwd. */
  slug: string
  /** For a subagent: the id of the session it belongs to; null for a main transcript. */
  parent: string | null
  /** For a transcript below a `subagents` directory: its session's main transcript. */
  sessionFile: string | null
  /** The workflow run, when the file lies under `subagents/workflows/<wf>/`. */
  workflowId: string | null
}

/**
 * Where a Claude transcript sits tells what it is: `<projects>/<slug>/<sessionId>.jsonl` for a
 * main session, `<projects>/<slug>/<sessionId>/subagents/agent-<id>.jsonl` for a subagent, and
 * `…/subagents/workflows/<wf>/agent-<id>.jsonl` for an agent of a workflow run. The nearest
 * directory named `subagents` above the file anchors it: counting a fixed number of levels up
 * took `workflows` for the session and `subagents` for the project at the second depth. A
 * subagent path without such a directory keeps the reading it always had; a main transcript's
 * never changed.
 */
export function claudePlacement(file: string, isSub: boolean): ClaudePlacement {
  const dir = path.dirname(file)
  if (!isSub) return { slug: path.basename(dir), parent: null, sessionFile: null, workflowId: null }
  // The directory names between `subagents` and the file, outermost first.
  const below: string[] = []
  let at = dir
  for (;;) {
    const name = path.basename(at)
    if (name === 'subagents') {
      const sessionDir = path.dirname(at)
      const sessionId = path.basename(sessionDir)
      const slugDir = path.dirname(sessionDir)
      return {
        slug: path.basename(slugDir),
        parent: sessionId,
        sessionFile: path.join(slugDir, `${sessionId}.jsonl`),
        workflowId: below.length >= 2 && below[0] === 'workflows' ? below[1] : null,
      }
    }
    const up = path.dirname(at)
    if (up === at) break
    below.unshift(name)
    at = up
  }
  const sessionDir = path.dirname(dir)
  return {
    slug: path.basename(path.dirname(sessionDir)), parent: path.basename(sessionDir),
    sessionFile: null, workflowId: null,
  }
}

/** An agent transcript's file name, and the agent id it carries. */
const AGENT_FILE_RE = /^agent-([0-9a-f]{1,64})\.jsonl$/

/** The two tags a task notification is read for. Its summary and output path never are. */
const NOTE_TOOL_USE_ID_RE = /<tool-use-id>([A-Za-z0-9_-]{1,64})<\/tool-use-id>/
const NOTE_STATUS_RE = /<status>([a-z_]{1,20})<\/status>/

/**
 * Whether a raw Claude line is worth parsing. Parsing is most of what a scan costs, so a line
 * is looked at first: a response carries "usage"; an agent's result is a `toolUseResult` with
 * an `agentId` *key* after it — a key, because inside a JSON string the quotes around the word
 * would be escaped, so a tool's output that merely mentions it does not pass; a background
 * agent's end is a task notification, and a tool result never is one. Everything else — a
 * tool's output, a prompt, an attachment — is passed over unparsed.
 */
function worthParsing(raw: string): boolean {
  if (raw.indexOf('"usage"') >= 0) return true
  const at = raw.indexOf('"toolUseResult"')
  if (at >= 0) return raw.indexOf('"agentId"', at) >= 0
  return raw.indexOf('task-notification') >= 0
}

/**
 * What a reported status means for a launch. A status this build does not know is no result
 * and leaves the launch as it was (undefined).
 */
function launchOutcome(status: unknown): 'launched' | 'completed' | 'failed' | undefined {
  switch (status) {
    case 'async_launched': return 'launched'
    case 'completed': return 'completed'
    case 'failed':
    case 'error':
    case 'killed':
    case 'cancelled':
    case 'timeout':
      return 'failed'
    default:
      return undefined
  }
}

/** The parent's own report of a finished sync agent — only when all three numbers are there. */
function reportedTotals(r: Record<string, unknown>): AgentLaunch['totals'] {
  const ok = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0
  const tokens = r.totalTokens
  const durationMs = r.totalDurationMs
  const toolUses = r.totalToolUseCount
  return ok(tokens) && ok(durationMs) && ok(toolUses) ? { tokens, durationMs, toolUses } : null
}

/** The tool call a tool result answers: the `tool_use_id` of its first `tool_result` block. */
function toolResultId(message: unknown): string | null {
  const content = message && typeof message === 'object' ? (message as { content?: unknown }).content : undefined
  if (!Array.isArray(content)) return null
  for (const c of content) {
    if (c && typeof c === 'object' && (c as { type?: unknown }).type === 'tool_result') {
      return cleanAgentId((c as { tool_use_id?: unknown }).tool_use_id)
    }
  }
  return null
}

function finiteOrNull(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

/** A line's own time: an ISO `timestamp` as transcripts write it, or a numeric `ts` in ms. */
function lineTime(d: { timestamp?: unknown; ts?: unknown }): number | null {
  if (typeof d.timestamp === 'string') {
    const t = Date.parse(d.timestamp)
    if (Number.isFinite(t)) return t
  }
  return typeof d.ts === 'number' && Number.isFinite(d.ts) && d.ts > 0 ? d.ts : null
}

/** How an open message names the record that holds it (see `PendingMessage.agent`). */
function ownerKey(file: string): string {
  return path.basename(file, '.jsonl')
}

/** The token figures of a message, or of the growth of one. */
interface TokenFigures {
  input: number
  cacheWrite: number
  cacheWrite1h: number
  cacheRead: number
  output: number
  reasoning: number
}

function creditTokens(rec: AgentRec | MainRec, v: TokenFigures): void {
  rec.input += v.input
  rec.cacheWrite += v.cacheWrite
  rec.cacheWrite1h += v.cacheWrite1h
  rec.cacheRead += v.cacheRead
  rec.output += v.output
  rec.reasoning += v.reasoning
}

/** A counted line's time and model onto its record. Only a real model id is listed. */
function touchRecord(rec: AgentRec | MainRec, at: number, model: unknown): void {
  if (at < rec.firstTs) rec.firstTs = at
  if (at > rec.lastTs) rec.lastTs = at
  const id = cleanAgentName(model, AGENT_MODEL_MAX_CHARS)
  if (id && rec.models.length < AGENT_MODELS_MAX && !rec.models.includes(id)) rec.models.push(id)
}

/** A launch's recorded result onto an agent record that has none yet. */
function adoptOutcome(rec: AgentRec, launch: AgentLaunch): boolean {
  if (rec.outcome !== null || (launch.outcome !== 'completed' && launch.outcome !== 'failed')) return false
  rec.outcome = launch.outcome
  rec.outcomeTs = launch.outcomeTs
  return true
}

// Restoring: a snapshot is a file a user can edit and another build can have written, so every
// record is rebuilt from the fields this build knows, each checked as it was at ingest. A field
// nobody wrote here — a description, say — does not survive the round trip.

function restoreModels(v: unknown): string[] {
  if (!Array.isArray(v)) return []
  const out: string[] = []
  for (const m of v) {
    const id = cleanAgentName(m, AGENT_MODEL_MAX_CHARS)
    if (id && out.length < AGENT_MODELS_MAX && !out.includes(id)) out.push(id)
  }
  return out
}

function restoreAgent(v: unknown): AgentRec | null {
  if (!v || typeof v !== 'object') return null
  const r = v as Record<string, unknown>
  const agentId = cleanAgentId(r.agentId)
  const firstTs = finiteOrNull(r.firstTs)
  const lastTs = finiteOrNull(r.lastTs)
  if (r.source !== 'claude' || agentId === null || firstTs === null || lastTs === null) return null
  if (typeof r.sessionFile !== 'string' || !r.sessionFile) return null
  return {
    source: 'claude',
    agentId,
    sessionId: typeof r.sessionId === 'string' ? clipId(r.sessionId) : '',
    sessionFile: r.sessionFile,
    workflowId: cleanAgentId(r.workflowId),
    meta: cleanMeta(r.meta),
    metaTries: num(r.metaTries),
    spawnerFile: typeof r.spawnerFile === 'string' && r.spawnerFile ? r.spawnerFile : null,
    firstTs,
    lastTs,
    models: restoreModels(r.models),
    input: num(r.input), cacheWrite: num(r.cacheWrite), cacheWrite1h: num(r.cacheWrite1h),
    cacheRead: num(r.cacheRead), output: num(r.output), reasoning: num(r.reasoning),
    requests: num(r.requests), outputFinal: num(r.outputFinal), toolCalls: num(r.toolCalls),
    outcome: r.outcome === 'completed' || r.outcome === 'failed' ? r.outcome : null,
    outcomeTs: finiteOrNull(r.outcomeTs),
  }
}

function restoreLaunch(v: unknown): AgentLaunch | null {
  if (!v || typeof v !== 'object') return null
  const r = v as Record<string, unknown>
  const toolUseId = cleanAgentId(r.toolUseId)
  const ts = finiteOrNull(r.ts)
  if (toolUseId === null || ts === null || typeof r.file !== 'string' || !r.file) return null
  const outcome = r.outcome === 'launched' || r.outcome === 'completed' || r.outcome === 'failed' ? r.outcome : null
  const totals = r.totals && typeof r.totals === 'object' ? r.totals as Record<string, unknown> : null
  return {
    toolUseId,
    file: r.file,
    ts,
    agentId: cleanAgentId(r.agentId),
    typeHint: cleanAgentName(r.typeHint),
    modelHint: cleanAgentName(r.modelHint),
    background: r.background === true,
    outcome,
    outcomeTs: finiteOrNull(r.outcomeTs),
    totals: totals
      ? reportedTotals({ totalTokens: totals.tokens, totalDurationMs: totals.durationMs, totalToolUseCount: totals.toolUses })
      : null,
  }
}

function restoreMain(v: unknown): MainRec | null {
  if (!v || typeof v !== 'object') return null
  const r = v as Record<string, unknown>
  const firstTs = finiteOrNull(r.firstTs)
  const lastTs = finiteOrNull(r.lastTs)
  if (r.source !== 'claude' || typeof r.sessionId !== 'string' || firstTs === null || lastTs === null) return null
  return {
    source: 'claude',
    sessionId: clipId(r.sessionId),
    firstTs,
    lastTs,
    models: restoreModels(r.models),
    input: num(r.input), cacheWrite: num(r.cacheWrite), cacheWrite1h: num(r.cacheWrite1h),
    cacheRead: num(r.cacheRead), output: num(r.output), reasoning: num(r.reasoning),
    requests: num(r.requests), outputFinal: num(r.outputFinal), toolCalls: num(r.toolCalls),
  }
}

/**
 * Collects token counts from both tools.
 *
 * Claude: one API response is written as N lines (one per content block). Dedup
 * runs on message.id and takes the maximum per field, because output_tokens is a
 * streaming snapshot. The bucket is corrected by delta so that lines of the same
 * id arriving later are not counted twice.
 *
 * Codex: total_token_usage is cumulative and is inherited as a baseline on forks.
 * Only the positive increase over the previous event is counted.
 *
 * Buckets are keyed per UTC hour while young, and folded into local days and
 * months by `rollup()`. Ingest and roll-up never overlap: the aggregator is
 * single-threaded, and the extension runs the roll-up between scans, so a line
 * can only ever see a consistent set of buckets.
 *
 * Beside the counting, Claude lines feed four agent tables for the Agents section: one
 * record per agent transcript and per main session (the same dedupe as the buckets), the
 * launches a parent recorded, and workflow journal results that came in before their agent.
 * They hold identifiers, times and counts — never a description, a prompt or a result.
 */
export class Aggregator {
  private buckets = new Map<string, Bucket>()
  private pending = new Map<string, PendingMessage>()
  private sessionMap = new Map<string, SessionRec>()
  /** Agent transcripts, keyed by path. */
  private agentMap = new Map<string, AgentRec>()
  /** Agent launches, keyed by tool_use id. */
  private launchMap = new Map<string, AgentLaunch>()
  /** Main Claude sessions, keyed by path: the tree's roots, kept whatever `attribution` says. */
  private mainMap = new Map<string, MainRec>()
  /** Workflow journal results that arrived before their agent's transcript: agentId → ts (0 unknown). */
  private journalResultMap = new Map<string, number>()
  /**
   * Lookups between the agent tables, derived from them and rebuilt on restore: an agent's
   * file by its id and by the tool_use id its sidecar names; a launch by the agent the
   * parent's result named.
   */
  private agentFileById = new Map<string, string>()
  private agentFileByToolUse = new Map<string, string>()
  private launchByAgent = new Map<string, string>()
  /** A replay's own open messages. `pending` belongs to the counting and a replay never touches it. */
  private replayPending = new Map<string, PendingMessage>()
  /** What a replay keeps of the records it rebuilds (identity, spawner, outcome), keyed by path. */
  private replayKept = new Map<string, AgentRec>()
  /** Tool side table, keyed `source|day|model|name`. */
  private toolStats = new Map<string, ToolStat>()
  /** Distinct names per `source|day`, for the cap; rebuilt from the rows on restore. */
  private toolNames = new Map<string, Set<string>>()
  /** `source|day` pairs whose name list is incomplete. */
  private toolsTruncated = new Set<string>()
  /**
   * Codex tool call ids already counted. Bounded and not persisted: the cursors keep a
   * region from being read twice within a run, so this only has to survive one scan.
   */
  private seenToolCalls = new Set<string>()
  cursors = new Map<string, Cursor>()
  attribution: Attribution = 'none'
  firstIngest: number | null = null
  /** Zone used to address late lines into rolled-up buckets and to map hours to days. */
  timeConfig: TimeConfig = SYSTEM_TIME_CONFIG
  private rollupState = { lastRun: 0, hourRetentionDays: 0, retentionDays: 0 }
  /** Whether the one-time agent replay has run; persisted with the snapshot. */
  private agentsReplayedFlag = false
  /** dayOfHour goes through Intl and is hit for every bucket on every query — memoised. */
  private dayMemoKey = ''
  private dayMemo = new Map<number, string>()

  // ---------------------------------------------------------------- Buckets

  private dayOfHourMemo(hour: number, cfg: TimeConfig): string {
    const key = timeKey(cfg)
    if (key !== this.dayMemoKey) {
      this.dayMemoKey = key
      this.dayMemo.clear()
    }
    let d = this.dayMemo.get(hour)
    if (d === undefined) {
      d = dayOfHour(hour, cfg)
      this.dayMemo.set(hour, d)
    }
    return d
  }

  private get(source: Source, res: Resolution, hour: number | null, day: string, model: string, isSub: boolean, tier: Tier): Bucket {
    const k = bucketKey({ source, res, hour, day, model, isSub, tier })
    let b = this.buckets.get(k)
    if (!b) {
      b = emptyBucket(source, model, isSub, tier, res, hour, day)
      this.buckets.set(k, b)
    }
    return b
  }

  /** Hour index below which hour buckets have been folded into days; null before any roll-up. */
  private hourHorizon(): number | null {
    const r = this.rollupState
    if (r.lastRun <= 0) return null
    return hourIndex(r.lastRun) - r.hourRetentionDays * 24
  }

  /** Day below which day buckets have been folded into months; null before any roll-up. */
  private dayHorizon(): string | null {
    const r = this.rollupState
    if (r.lastRun <= 0) return null
    return addDays(dayOf(r.lastRun, this.timeConfig), -r.retentionDays)
  }

  /**
   * The bucket a line belongs to. Normally the hour bucket; but a late line for an hour
   * that the roll-up has already folded away must land in the day (or month) bucket that
   * now holds that hour — otherwise the roll-up would silently resurrect hour buckets and
   * the next roll-up would fold them again, double-shifting nothing but confusing sums.
   */
  bucketFor(source: Source, hour: number, day: string, model: string, isSub: boolean, tier: Tier): Bucket {
    const hh = this.hourHorizon()
    if (hh === null || hour >= hh) return this.get(source, 'h', hour, day, model, isSub, tier)
    const rolledDay = this.dayOfHourMemo(hour, this.timeConfig)
    const dh = this.dayHorizon()
    if (dh === null || rolledDay >= dh) return this.get(source, 'd', null, rolledDay, model, isSub, tier)
    return this.get(source, 'm', null, monthOf(rolledDay), model, isSub, tier)
  }

  private noteIngest(ts: number): void {
    if (this.firstIngest === null || ts < this.firstIngest) this.firstIngest = ts
  }

  // --------------------------------------------------------------- Sessions

  private sessionFor(file: string, ctx: IngestContext, make: () => SessionRec): SessionRec {
    let s = this.sessionMap.get(file)
    if (!s) {
      s = make()
      this.sessionMap.set(file, s)
    }
    // The snapshot records the setting its session table was collected under.
    this.attribution = ctx.attribution
    return s
  }

  private newSession(
    source: Source, sessionId: string, label: string, full: string, isSub: boolean,
    parent: string | null, ts: number, ctx: IngestContext,
  ): SessionRec {
    const projectHash = projectHashOf(ctx.projectSalt, full)
    return {
      source, sessionId,
      project: ctx.hashProjects ? projectHash : label,
      projectHash,
      isSub, parent,
      firstTs: ts, lastTs: ts,
      models: [],
      input: 0, cacheWrite: 0, cacheWrite1h: 0, cacheRead: 0, output: 0, reasoning: 0,
      requests: 0, outputFinal: 0,
      lastCacheTtl: null, lastCacheWriteTs: null,
      turnGapsMs: [],
      hourUsage: {},
    }
  }

  /**
   * Credits one hour of a session with the tokens it was billed for.
   *
   * The lifetime counters cannot be sliced afterwards, so the slice is kept while the line
   * is read. It is the same billable definition and the same UTC hour index the buckets use,
   * so a per-window attribution and the window's own usage row add up to the same tokens.
   */
  private noteSessionHour(s: SessionRec, hour: number, tokens: number): void {
    if (!Number.isFinite(hour) || !(tokens > 0)) return
    const map = s.hourUsage ?? (s.hourUsage = {})
    const k = String(hour)
    map[k] = (map[k] ?? 0) + tokens
  }

  /** A new request in a session: its distance to the previous one approximates a turn. */
  private noteTurn(s: SessionRec, ts: number, model: string): void {
    if (ts > s.lastTs) {
      s.turnGapsMs.push(ts - s.lastTs)
      if (s.turnGapsMs.length > TURN_GAP_CAP) s.turnGapsMs.splice(0, s.turnGapsMs.length - TURN_GAP_CAP)
      s.lastTs = ts
    }
    if (ts < s.firstTs) s.firstTs = ts
    if (!s.models.includes(model)) s.models.push(model)
  }

  private noteCacheWrite(s: SessionRec, cacheWrite: number, cacheWrite1h: number, ts: number): void {
    if (cacheWrite <= 0) return
    s.lastCacheTtl = cacheWrite1h > 0 ? '1h' : '5m'
    s.lastCacheWriteTs = ts
  }

  // ------------------------------------------------------------------ Tools

  /**
   * Credits `n` calls of one tool to a day.
   *
   * The cap counts distinct names per (source, day) across models: names come from the
   * transcript and a generator that invents one per call would otherwise grow the state
   * file without bound. Names beyond the cap are dropped and the day is flagged, because
   * a short list that does not say it is short is a wrong list.
   */
  private addTool(source: Source, day: string, model: string, name: string, n: number): void {
    if (!(n > 0) || !name || !day) return
    const clean = name.length > TOOL_NAME_MAX_CHARS ? name.slice(0, TOOL_NAME_MAX_CHARS) : name
    const k = toolKey({ source, day, model, name: clean })
    const have = this.toolStats.get(k)
    if (have) {
      have.calls += n
      return
    }
    const dayKey = toolDayKey(source, day)
    let names = this.toolNames.get(dayKey)
    if (!names) {
      names = new Set<string>()
      this.toolNames.set(dayKey, names)
    }
    if (!names.has(clean) && names.size >= TOOL_NAME_CAP) {
      this.toolsTruncated.add(dayKey)
      return
    }
    names.add(clean)
    this.toolStats.set(k, { source, day, model, name: clean, calls: n })
  }

  /** True the first time a tool call id is seen; keeps the memory bounded (oldest first). */
  private firstSightOfCall(id: string): boolean {
    if (this.seenToolCalls.has(id)) return false
    this.seenToolCalls.add(id)
    if (this.seenToolCalls.size > TOOL_CALL_MEMORY) {
      const drop = this.seenToolCalls.size - TOOL_CALL_MEMORY
      let i = 0
      for (const k of this.seenToolCalls) {
        this.seenToolCalls.delete(k)
        if (++i >= drop) break
      }
    }
    return true
  }

  /**
   * Counts the `tool_use` blocks of one Claude line onto its message, and returns how many
   * calls that added — the figure an agent's or a session's record takes as its tool calls.
   *
   * Claude writes one content block per line under a repeated `message.id`, so a message
   * with two parallel `Read` calls arrives as two lines. Counting by block id makes those
   * two calls, while a line read twice stays one; a block without an id falls back to the
   * max-per-name rule, which never double counts but folds parallel calls of one tool into
   * a single call. `p.day`/`p.model` place the count on the message, not on the late line.
   * With `toTable` false (a replay) the side table is left alone; only the message's own
   * memory of what it counted moves, and that memory belongs to the replay.
   */
  private countClaudeTools(p: PendingMessage, content: unknown, toTable = true): number {
    if (!Array.isArray(content)) return 0
    let added = 0
    const counts = new Map<string, number>()
    for (const c of content) {
      if (!c || typeof c !== 'object') continue
      // Only real tool calls: a `server_tool_use` block is already counted as webSearch /
      // webFetch on the bucket, and listing it here would report the same call twice.
      if ((c as { type?: unknown }).type !== 'tool_use') continue
      const name = str((c as { name?: unknown }).name)
      if (!name) continue
      const id = str((c as { id?: unknown }).id)
      if (id) {
        const ids = p.toolIds ?? (p.toolIds = [])
        if (ids.includes(id)) continue
        if (ids.length < TOOL_IDS_PER_MESSAGE) ids.push(id)
        const tools = p.tools ?? (p.tools = {})
        tools[name] = (tools[name] ?? 0) + 1
        if (toTable) this.addTool('claude', p.day, p.model, name, 1)
        added += 1
        continue
      }
      counts.set(name, (counts.get(name) ?? 0) + 1)
    }
    if (counts.size === 0) return added
    const tools = p.tools ?? (p.tools = {})
    for (const [name, cand] of counts) {
      const prev = tools[name] ?? 0
      if (cand <= prev) continue
      tools[name] = cand
      if (toTable) this.addTool('claude', p.day, p.model, name, cand - prev)
      added += cand - prev
    }
    return added
  }

  // ---------------------------------------------------------------- Claude

  /**
   * Processes one line of a Claude transcript. Returns true when anything changed: a counted
   * response, or an agent's record — a launch, a result, a notification.
   */
  addClaudeLine(raw: string, ctx: IngestContext): boolean {
    if (!worthParsing(raw)) return false
    let d: any
    try { d = JSON.parse(raw) } catch { return false }
    if (!d || typeof d !== 'object') return false
    if (d.type === 'assistant') return this.claudeResponse(d, ctx)
    if (d.type === 'user') return this.agentResult(d, ctx)
    if (d.type === 'queue-operation') return this.agentNotification(d)
    return false
  }

  /** One assistant line: its tokens onto buckets, session and agent tables, and its launches. */
  private claudeResponse(d: any, ctx: IngestContext): boolean {
    const m = d.message
    if (!m || typeof m !== 'object') return false
    // Placeholder and error lines carry all-zero usage and would only inflate the request count.
    if (m.model === '<synthetic>' || d.isApiErrorMessage) return false
    const parsed = Date.parse(d.timestamp ?? '')
    // The agent tables take a line's own time or nothing: a record dated "now" would show an
    // agent that finished last week as running. The buckets keep the fallback they always had.
    const at = Number.isFinite(parsed) ? parsed : null
    const launched = at !== null && this.noteLaunches(m.content, at, ctx)
    const u = m.usage
    if (!u || typeof u !== 'object') return launched
    const id = m.id
    if (typeof id !== 'string' || !id) return launched

    const ts = at ?? Date.now()
    const hour = hourIndex(ts)
    const day = localDay(ts)
    const model = typeof m.model === 'string' ? m.model : 'unknown'
    const final = m.stop_reason != null
    const isSub = ctx.isSub
    // A replay rebuilds the agent tables and nothing else. It keeps open messages of its own,
    // so the counting side's are neither read nor written, and nothing that counts is touched.
    const replay = ctx.agentsOnly === true
    const pending = replay ? this.replayPending : this.pending

    const cand = {
      input: num(u.input_tokens),
      cacheWrite: num(u.cache_creation_input_tokens),
      // The 1h variant costs 2x input instead of 1.25x and must be tracked separately.
      cacheWrite1h: num(u.cache_creation?.ephemeral_1h_input_tokens),
      cacheRead: num(u.cache_read_input_tokens),
      // iterations[] is already the total and must not be added on top.
      output: num(u.output_tokens),
      // Thinking tokens are a subset of output: reported alongside, never added to it.
      reasoning: num(u.output_tokens_details?.thinking_tokens),
      webSearch: num(u.server_tool_use?.web_search_requests),
      webFetch: num(u.server_tool_use?.web_fetch_requests),
    }

    const cur = replay ? undefined : this.cursors.get(ctx.file)
    if (cur) cur.lastTs = ts
    if (!replay) this.noteIngest(ts)

    const prev = pending.get(id)
    if (!prev) {
      const tier = tierOf(u.speed, u.inference_geo)
      const p: PendingMessage = { hour, day, model, isSub, tier, ...cand, final }
      const tools = this.countClaudeTools(p, m.content, !replay)
      if (!replay) {
        const b = this.bucketFor('claude', hour, day, model, isSub, tier)
        b.input += cand.input
        b.cacheWrite += cand.cacheWrite
        b.cacheWrite1h += cand.cacheWrite1h
        b.cacheRead += cand.cacheRead
        b.output += cand.output
        b.reasoning += cand.reasoning
        b.webSearch += cand.webSearch
        b.webFetch += cand.webFetch
        b.requests += 1
        if (final) b.outputFinal += 1
      }

      if (!replay && ctx.attribution !== 'none') {
        const place = claudePlacement(ctx.file, isSub)
        const cwd = str(d.cwd)
        const s = this.sessionFor(ctx.file, ctx, () => this.newSession(
          'claude',
          str(d.sessionId) ?? path.basename(ctx.file, '.jsonl'),
          cwd ? path.basename(cwd) : place.slug,
          cwd ?? place.slug,
          isSub, place.parent, ts, ctx,
        ))
        if (cur) { cur.sessionId = s.sessionId; cur.project = s.project }
        this.noteTurn(s, ts, model)
        s.input += cand.input
        s.cacheWrite += cand.cacheWrite
        s.cacheWrite1h += cand.cacheWrite1h
        s.cacheRead += cand.cacheRead
        s.output += cand.output
        s.reasoning += cand.reasoning
        s.requests += 1
        if (final) s.outputFinal += 1
        this.noteCacheWrite(s, cand.cacheWrite, cand.cacheWrite1h, ts)
        this.noteSessionHour(s, hour, cand.input + cand.cacheWrite + cand.output)
        p.session = ctx.file
      }

      if (at !== null) this.creditMessage(p, cand, final, tools, at, m.model, ctx)
      pending.set(id, p)
      this.trimPending(pending)
      return true
    }

    // Known id: only add the difference to the running maximum. Claude puts each content
    // block on its own line, so the tool calls of a message arrive on the *later* lines of
    // its id: counting them only in the branch above would miss them.
    const tools = this.countClaudeTools(prev, m.content, !replay)
    const prevReasoning = prev.reasoning ?? 0
    const next = {
      input: Math.max(prev.input, cand.input),
      cacheWrite: Math.max(prev.cacheWrite, cand.cacheWrite),
      cacheWrite1h: Math.max(prev.cacheWrite1h, cand.cacheWrite1h),
      cacheRead: Math.max(prev.cacheRead, cand.cacheRead),
      output: Math.max(prev.output, cand.output),
      reasoning: Math.max(prevReasoning, cand.reasoning),
      webSearch: Math.max(prev.webSearch, cand.webSearch),
      webFetch: Math.max(prev.webFetch, cand.webFetch),
    }
    const delta = {
      input: next.input - prev.input,
      cacheWrite: next.cacheWrite - prev.cacheWrite,
      cacheWrite1h: next.cacheWrite1h - prev.cacheWrite1h,
      cacheRead: next.cacheRead - prev.cacheRead,
      output: next.output - prev.output,
      reasoning: next.reasoning - prevReasoning,
      webSearch: next.webSearch - prev.webSearch,
      webFetch: next.webFetch - prev.webFetch,
    }
    const newlyFinal = final && !prev.final
    if (!replay) {
      // Looked up by the message's own hour, so a late line follows its message into a
      // rolled-up bucket.
      const b = this.bucketFor('claude', prev.hour, prev.day, prev.model, prev.isSub, prev.tier)
      b.input += delta.input
      b.cacheWrite += delta.cacheWrite
      b.cacheWrite1h += delta.cacheWrite1h
      b.cacheRead += delta.cacheRead
      b.output += delta.output
      b.reasoning += delta.reasoning
      b.webSearch += delta.webSearch
      b.webFetch += delta.webFetch
      if (newlyFinal) b.outputFinal += 1
    }

    const s = !replay && prev.session ? this.sessionMap.get(prev.session) : undefined
    if (s) {
      s.input += delta.input
      s.cacheWrite += delta.cacheWrite
      s.cacheWrite1h += delta.cacheWrite1h
      s.cacheRead += delta.cacheRead
      s.output += delta.output
      s.reasoning += delta.reasoning
      if (newlyFinal) s.outputFinal += 1
      if (ts > s.lastTs) s.lastTs = ts
      this.noteCacheWrite(s, delta.cacheWrite, delta.cacheWrite1h, ts)
      // The message's hour, not the late line's: the bucket above follows the same rule.
      this.noteSessionHour(s, prev.hour, delta.input + delta.cacheWrite + delta.output)
    }

    this.creditGrowth(prev, delta, newlyFinal, tools, at, m.model, ctx)

    prev.input = next.input
    prev.cacheWrite = next.cacheWrite
    prev.cacheWrite1h = next.cacheWrite1h
    prev.cacheRead = next.cacheRead
    prev.output = next.output
    prev.reasoning = next.reasoning
    prev.webSearch = next.webSearch
    prev.webFetch = next.webFetch
    prev.final = prev.final || final
    return true
  }

  /** Keeps a map of open messages small; Map preserves insertion order, so the oldest goes first. */
  private trimPending(map: Map<string, PendingMessage> = this.pending, limit = 4000): void {
    if (map.size <= limit) return
    const drop = map.size - limit
    let i = 0
    for (const k of map.keys()) {
      map.delete(k)
      if (++i >= drop) break
    }
  }

  // ---------------------------------------------------------------- Agents

  /**
   * A message's first line in an agent or a main transcript: its figures onto that file's
   * record, which the first counted line makes. `p` remembers which record holds the
   * message — as `session` does for the session table — so its later lines add their growth
   * there and nowhere else.
   */
  private creditMessage(
    p: PendingMessage, v: TokenFigures, final: boolean, tools: number, at: number, model: unknown,
    ctx: IngestContext,
  ): void {
    const rec = ctx.isSub ? this.agentFor(ctx.file, at) : this.mainFor(ctx.file, at)
    if (!rec) return
    creditTokens(rec, v)
    rec.requests += 1
    if (final) rec.outputFinal += 1
    rec.toolCalls += tools
    touchRecord(rec, at, model)
    if (ctx.isSub) p.agent = ownerKey(ctx.file)
    else p.main = ownerKey(ctx.file)
  }

  /**
   * A later line of a known message: its growth onto the record that holds the message. An
   * open message from before the agent tables (a version 6 snapshot) names no record; its next
   * line links it to this file and credits the growth from there on — the part before is the
   * replay's to rebuild, and crediting it here as well would count it twice.
   */
  private creditGrowth(
    p: PendingMessage, v: TokenFigures, newlyFinal: boolean, tools: number, at: number | null,
    model: unknown, ctx: IngestContext,
  ): void {
    const key = ownerKey(ctx.file)
    const owner = ctx.isSub ? p.agent : p.main
    const other = ctx.isSub ? p.main : p.agent
    // Held by another transcript, or by the other kind of record: counted there, not here.
    if (owner !== undefined && owner !== key) return
    if (owner === undefined && other !== undefined) return
    let rec: AgentRec | MainRec | null | undefined = ctx.isSub ? this.agentMap.get(ctx.file) : this.mainMap.get(ctx.file)
    if (!rec) {
      if (at === null) return
      rec = ctx.isSub ? this.agentFor(ctx.file, at) : this.mainFor(ctx.file, at)
      if (!rec) return
    }
    if (owner === undefined) {
      if (ctx.isSub) p.agent = key
      else p.main = key
    }
    creditTokens(rec, v)
    if (newlyFinal) rec.outputFinal += 1
    rec.toolCalls += tools
    if (at !== null) touchRecord(rec, at, model)
  }

  /**
   * The record of an agent transcript, made by its first counted line: its identity from the
   * file name, its session and workflow run from where it sits (`claudePlacement`). Null for a
   * file below `subagents` that is no agent transcript. What was recorded before the
   * transcript came in — the parent's result, the workflow journal — joins it here.
   */
  private agentFor(file: string, at: number): AgentRec | null {
    const have = this.agentMap.get(file)
    if (have) return have
    const name = AGENT_FILE_RE.exec(path.basename(file))
    if (!name) return null
    const place = claudePlacement(file, true)
    if (place.sessionFile === null || place.parent === null) return null
    // A replay carries over what the lines cannot rebuild: the sidecar, the spawner, a result.
    const kept = this.replayKept.get(file)
    if (kept) this.replayKept.delete(file)
    const rec: AgentRec = {
      source: 'claude',
      agentId: name[1],
      sessionId: clipId(place.parent),
      sessionFile: place.sessionFile,
      workflowId: cleanAgentId(place.workflowId),
      meta: kept?.meta ?? null,
      metaTries: kept?.metaTries ?? 0,
      spawnerFile: kept?.spawnerFile ?? null,
      firstTs: at,
      lastTs: at,
      models: [],
      input: 0, cacheWrite: 0, cacheWrite1h: 0, cacheRead: 0,
      output: 0, reasoning: 0, requests: 0, outputFinal: 0, toolCalls: 0,
      outcome: kept?.outcome ?? null,
      outcomeTs: kept?.outcomeTs ?? null,
    }
    this.agentMap.set(file, rec)
    this.agentFileById.set(rec.agentId, file)
    this.linkAgent(file, rec)
    return rec
  }

  /** Joins a new agent record to what was recorded about it before its transcript was read. */
  private linkAgent(file: string, rec: AgentRec): void {
    // The parent's result named this agent: its launch is the spawner.
    const toolUseId = this.launchByAgent.get(rec.agentId)
    const launch = toolUseId !== undefined ? this.launchMap.get(toolUseId) : undefined
    if (launch) {
      if (rec.spawnerFile === null) rec.spawnerFile = launch.file
      adoptOutcome(rec, launch)
    }
    // A record a replay rebuilds keeps its sidecar, and with it the link that names.
    this.linkMeta(file, rec)
    // The workflow journal recorded the result before the transcript was read.
    const journal = this.journalResultMap.get(rec.agentId)
    if (journal !== undefined) {
      this.journalResultMap.delete(rec.agentId)
      rec.outcome = 'completed'
      rec.outcomeTs = journal > 0 ? journal : null
    }
  }

  /** The link a sidecar's tool_use id makes: the launch it names is the agent's spawner. */
  private linkMeta(file: string, rec: AgentRec): void {
    const toolUseId = rec.meta?.toolUseId
    if (!toolUseId) return
    this.agentFileByToolUse.set(toolUseId, file)
    const launch = this.launchMap.get(toolUseId)
    if (!launch) return
    rec.spawnerFile = launch.file
    if (launch.agentId === null) {
      launch.agentId = rec.agentId
      this.launchByAgent.set(rec.agentId, toolUseId)
    }
    adoptOutcome(rec, launch)
  }

  /** The record of a main transcript, made by its first counted line. */
  private mainFor(file: string, at: number): MainRec {
    let rec = this.mainMap.get(file)
    if (!rec) {
      rec = {
        source: 'claude',
        sessionId: clipId(path.basename(file, '.jsonl')),
        firstTs: at,
        lastTs: at,
        models: [],
        input: 0, cacheWrite: 0, cacheWrite1h: 0, cacheRead: 0,
        output: 0, reasoning: 0, requests: 0, outputFinal: 0, toolCalls: 0,
      }
      this.mainMap.set(file, rec)
    }
    return rec
  }

  /**
   * The agent launches on one assistant line: `tool_use` blocks named `Agent` (or `Task`, as
   * older builds call it). A streamed message repeats its block on later lines, so a launch is
   * made once, by the first. Three fields of the input are read and no more — its description
   * and prompt are content.
   */
  private noteLaunches(content: unknown, at: number, ctx: IngestContext): boolean {
    if (!Array.isArray(content)) return false
    let changed = false
    for (const c of content) {
      if (!c || typeof c !== 'object') continue
      const block = c as { type?: unknown; name?: unknown; id?: unknown; input?: unknown }
      if (block.type !== 'tool_use' || (block.name !== 'Agent' && block.name !== 'Task')) continue
      const toolUseId = cleanAgentId(block.id)
      if (toolUseId === null || this.launchMap.has(toolUseId)) continue
      const input = block.input && typeof block.input === 'object'
        ? block.input as { subagent_type?: unknown; model?: unknown; run_in_background?: unknown }
        : undefined
      const launch: AgentLaunch = {
        toolUseId,
        file: ctx.file,
        ts: at,
        agentId: null,
        typeHint: cleanAgentName(input?.subagent_type),
        modelHint: cleanAgentName(input?.model),
        background: input?.run_in_background === true,
        outcome: null,
        outcomeTs: null,
        totals: null,
      }
      this.launchMap.set(toolUseId, launch)
      // An agent whose sidecar was read first already names this launch.
      const file = this.agentFileByToolUse.get(toolUseId)
      const rec = file !== undefined ? this.agentMap.get(file) : undefined
      if (file !== undefined && rec) this.linkMeta(file, rec)
      changed = true
    }
    return changed
  }

  /**
   * A tool result that names an agent: the parent's record of what became of its launch. Five
   * fields of the result are read — `agentId`, `status` and the three totals — because it also
   * carries the agent's prompt and its answer. The tool_use id comes from the message's own
   * `tool_result` block.
   */
  private agentResult(d: any, ctx: IngestContext): boolean {
    const r = d.toolUseResult
    if (!r || typeof r !== 'object' || Array.isArray(r)) return false
    const agentId = cleanAgentId(r.agentId)
    if (agentId === null) return false
    const toolUseId = toolResultId(d.message)
    if (toolUseId === null) return false
    const at = lineTime(d)
    const status: unknown = r.status
    let changed = false
    let launch = this.launchMap.get(toolUseId)
    if (!launch) {
      // The launch's own line was not read (it lies before what this build has seen): the
      // result stands in for it, with its own time as the latest the launch can have been.
      if (at === null) return false
      launch = {
        toolUseId, file: ctx.file, ts: at, agentId: null, typeHint: null, modelHint: null,
        background: status === 'async_launched', outcome: null, outcomeTs: null, totals: null,
      }
      this.launchMap.set(toolUseId, launch)
      changed = true
    }
    if (launch.agentId !== agentId) {
      if (launch.agentId !== null && this.launchByAgent.get(launch.agentId) === toolUseId) {
        this.launchByAgent.delete(launch.agentId)
      }
      launch.agentId = agentId
      changed = true
    }
    this.launchByAgent.set(agentId, toolUseId)
    const outcome = launchOutcome(status)
    if (outcome) changed = this.applyOutcome(launch, outcome, at, outcome === 'completed' ? reportedTotals(r) : null) || changed
    return this.propagateOutcome(launch) || changed
  }

  /**
   * A queued task notification: how a background agent's end reaches the parent. Two tags are
   * read — `<tool-use-id>` and `<status>` — and never the summary or the output path. A
   * notification for a tool call that is no known launch (a background shell task reports
   * the same way) changes nothing.
   */
  private agentNotification(d: any): boolean {
    if (d.operation !== 'enqueue' || typeof d.content !== 'string') return false
    const text: string = d.content
    if (text.indexOf('task-notification') < 0) return false
    const id = NOTE_TOOL_USE_ID_RE.exec(text)
    const launch = id ? this.launchMap.get(id[1]) : undefined
    if (!launch) return false
    const status = NOTE_STATUS_RE.exec(text)
    const outcome = status ? launchOutcome(status[1]) : undefined
    if (!outcome) return false
    const changed = this.applyOutcome(launch, outcome, lineTime(d), null)
    return this.propagateOutcome(launch) || changed
  }

  /**
   * An outcome onto a launch. "Launched" never takes back a result — a re-read line or a late
   * copy must not revive a finished agent — and a result already recorded keeps the time it
   * was first recorded at.
   */
  private applyOutcome(
    launch: AgentLaunch, outcome: 'launched' | 'completed' | 'failed', at: number | null,
    totals: AgentLaunch['totals'],
  ): boolean {
    if (outcome === 'launched') {
      if (launch.outcome !== null) return false
      launch.outcome = 'launched'
      return true
    }
    let changed = false
    if (launch.outcome !== outcome) {
      launch.outcome = outcome
      launch.outcomeTs = at
      changed = true
    } else if (launch.outcomeTs === null && at !== null) {
      launch.outcomeTs = at
      changed = true
    }
    const t = launch.totals
    if (totals && (!t || t.tokens !== totals.tokens || t.durationMs !== totals.durationMs || t.toolUses !== totals.toolUses)) {
      launch.totals = totals
      changed = true
    }
    return changed
  }

  /** A launch's result onto the agent it named, and the spawner an agent without one lacks. */
  private propagateOutcome(launch: AgentLaunch): boolean {
    if (launch.agentId === null) return false
    const file = this.agentFileById.get(launch.agentId)
    const rec = file !== undefined ? this.agentMap.get(file) : undefined
    if (!rec) return false
    let changed = false
    if ((launch.outcome === 'completed' || launch.outcome === 'failed')
      && (rec.outcome !== launch.outcome || rec.outcomeTs !== launch.outcomeTs)) {
      rec.outcome = launch.outcome
      rec.outcomeTs = launch.outcomeTs
      changed = true
    }
    if (rec.spawnerFile === null) {
      rec.spawnerFile = launch.file
      changed = true
    }
    return changed
  }

  /**
   * One line of a workflow's `journal.jsonl`. Two fields are read — `type` and `agentId` — and
   * never the workflow's key or the agent's result. Only a `result` changes anything (a
   * `started` line is followed by the agent's own transcript): the agent is recorded as
   * completed, or — when its transcript was not read yet — the result waits for it. Journal
   * lines carry no time of their own today; the result's time is then unknown, never "now".
   */
  addWorkflowJournalLine(raw: string, ctx: IngestContext): boolean {
    if (raw.indexOf('"result"') < 0) return false
    let d: any
    try { d = JSON.parse(raw) } catch { return false }
    if (!d || typeof d !== 'object' || d.type !== 'result') return false
    const agentId = cleanAgentId(d.agentId)
    if (agentId === null) return false
    const at = lineTime(d) ?? finiteOrNull(this.cursors.get(ctx.file)?.lastTs)
    const file = this.agentFileById.get(agentId)
    const rec = file !== undefined ? this.agentMap.get(file) : undefined
    if (!rec) {
      const v = at ?? 0
      if (this.journalResultMap.get(agentId) === v) return false
      this.journalResultMap.set(agentId, v)
      return true
    }
    if (rec.outcome === 'completed') {
      if (rec.outcomeTs !== null || at === null) return false
      rec.outcomeTs = at
      return true
    }
    rec.outcome = 'completed'
    rec.outcomeTs = at
    return true
  }

  /** Whether the agent file has a record whose sidecar is still unread (fewer than 3 tries). */
  needsAgentMeta(file: string): boolean {
    const rec = this.agentMap.get(file)
    return rec !== undefined && rec.meta === null && rec.metaTries < 3
  }

  /**
   * The sidecar's four fields, or null for "tried, nothing usable". Every call is a try; a
   * sidecar that names a tool_use id links the agent to its launch. The fields are sanitised
   * again here, so a caller cannot put anything into the table the reader would not have.
   */
  setAgentMeta(file: string, meta: AgentMeta | null): void {
    const rec = this.agentMap.get(file)
    if (!rec) return
    rec.metaTries += 1
    const clean = cleanMeta(meta)
    if (!clean) return
    rec.meta = clean
    this.linkMeta(file, rec)
  }

  /** Subagent transcripts, in the order they were first counted. */
  agents(): AgentRec[] { return [...this.agentMap.values()] }
  /** Agent launches the parent transcripts recorded. */
  launches(): AgentLaunch[] { return [...this.launchMap.values()] }
  /** Main Claude sessions, the tree's roots. */
  mains(): MainRec[] { return [...this.mainMap.values()] }

  /**
   * The agent records with the path each is keyed by. The tree needs it: a node's key is the
   * agent's file, and `spawnerFile` names a file, not a record.
   */
  agentEntries(): Array<[file: string, rec: AgentRec]> { return [...this.agentMap] }
  /** The main session records with their path — the key every agent's `sessionFile` names. */
  mainEntries(): Array<[file: string, rec: MainRec]> { return [...this.mainMap] }

  get agentsReplayed(): boolean { return this.agentsReplayedFlag }
  set agentsReplayed(v: boolean) { this.agentsReplayedFlag = v }

  /**
   * Starts a replay over `files` (`replayAgents` in scan.ts): what these transcripts gave the
   * agent tables is taken out, so reading them again from the start rebuilds it instead of
   * adding to it. What the lines cannot give back — an agent's sidecar, its spawner, a
   * recorded result — is kept aside and carried into the rebuilt record.
   */
  beginAgentReplay(files: Iterable<string>): void {
    this.replayPending.clear()
    this.replayKept.clear()
    const set = new Set(files)
    for (const file of set) {
      const rec = this.agentMap.get(file)
      if (rec) {
        this.replayKept.set(file, rec)
        this.dropAgent(file, rec)
      }
      this.mainMap.delete(file)
    }
    for (const [id, launch] of this.launchMap) if (set.has(launch.file)) this.dropLaunch(id, launch)
  }

  /** Ends a replay: its open messages are forgotten, and a kept record nothing rebuilt is gone. */
  endAgentReplay(): void {
    this.replayPending.clear()
    this.replayKept.clear()
  }

  private dropAgent(file: string, rec: AgentRec): void {
    this.agentMap.delete(file)
    if (this.agentFileById.get(rec.agentId) === file) this.agentFileById.delete(rec.agentId)
    const toolUseId = rec.meta?.toolUseId
    if (toolUseId && this.agentFileByToolUse.get(toolUseId) === file) this.agentFileByToolUse.delete(toolUseId)
  }

  private dropLaunch(id: string, launch: AgentLaunch): void {
    this.launchMap.delete(id)
    if (launch.agentId !== null && this.launchByAgent.get(launch.agentId) === id) this.launchByAgent.delete(launch.agentId)
  }

  /**
   * Drops what the agent tables hold beyond their retention: an agent or a main session whose
   * last line, a launch whose last news, and a waiting journal result older than `horizon`. A
   * journal result of unknown time counts as old — it can only have waited since before.
   */
  private pruneAgents(horizon: number): void {
    for (const [file, rec] of this.agentMap) {
      if (Math.max(rec.lastTs, rec.outcomeTs ?? 0) < horizon) this.dropAgent(file, rec)
    }
    for (const [id, launch] of this.launchMap) {
      if (Math.max(launch.ts, launch.outcomeTs ?? 0) < horizon) this.dropLaunch(id, launch)
    }
    for (const [file, rec] of this.mainMap) if (rec.lastTs < horizon) this.mainMap.delete(file)
    for (const [id, ts] of this.journalResultMap) if (ts < horizon) this.journalResultMap.delete(id)
  }

  /** The lookups between the agent tables, from the tables themselves (after a restore). */
  private reindexAgents(): void {
    this.agentFileById.clear()
    this.agentFileByToolUse.clear()
    this.launchByAgent.clear()
    for (const [file, rec] of this.agentMap) {
      this.agentFileById.set(rec.agentId, file)
      if (rec.meta?.toolUseId) this.agentFileByToolUse.set(rec.meta.toolUseId, file)
    }
    for (const [id, launch] of this.launchMap) if (launch.agentId !== null) this.launchByAgent.set(launch.agentId, id)
  }

  // ----------------------------------------------------------------- Codex

  /**
   * Processes one line of a Codex rollout, advancing `cur` as it goes: startTs/forked
   * drive replay-prefix detection, lastTotal drives delta computation.
   *
   * Replay prefix of a forked file: the parent's history is copied in, complete with its
   * token_count events. Preferred signal is the first `task_started` event — everything
   * before it is replay and only sets the baseline. Rollouts written by versions that do
   * not persist that marker fall back to the timestamp heuristic: replayed events sit
   * within 2 s of the file's first record. Without look-ahead the two cannot be told
   * apart on a single line, so a token_count that is neither at the fork point nor
   * preceded by a marker is treated as real; the known cost is that a marker-less fork
   * whose first real turn lands inside those 2 s loses that one turn to the baseline.
   */
  addCodexLine(raw: string, cur: Cursor, ctx: IngestContext): boolean {
    let d: any
    try { d = JSON.parse(raw) } catch { return false }
    const parsed = Date.parse(d?.timestamp ?? '')
    const ts = Number.isFinite(parsed) ? parsed : NaN
    if (cur.startTs === undefined && Number.isFinite(ts)) cur.startTs = ts

    const type = d?.type
    const p = d?.payload

    if (type === 'session_meta') {
      // A forked thread carries the parent thread's complete history with it.
      const forkedFrom = p ? str(p.forked_from_id) : null
      if (p && (forkedFrom || p.thread_source === 'subagent')) cur.forked = true
      if (ctx.attribution !== 'none' && p && typeof p === 'object') {
        const cwd = str(p.cwd)
        const sessionId = str(p.id) ?? path.basename(ctx.file, '.jsonl')
        const at = Number.isFinite(ts) ? ts : Date.now()
        const s = this.sessionFor(ctx.file, ctx, () => this.newSession(
          'codex', sessionId,
          cwd ? path.basename(cwd) : path.basename(path.dirname(ctx.file)),
          cwd ?? ctx.file,
          !!cur.forked, forkedFrom, at, ctx,
        ))
        cur.sessionId = s.sessionId
        cur.project = s.project
      }
      return false
    }
    if (type === 'turn_context') {
      if (p && typeof p.model === 'string') cur.model = p.model
      return false
    }
    if (type === 'response_item') {
      // How the current builds record a tool call. `name` is a tool identifier
      // ("exec", "send_message", an MCP tool); `arguments` is content and is not read.
      if (p && typeof p === 'object' && (p.type === 'function_call' || p.type === 'custom_tool_call')) {
        this.noteCodexTool(cur, ts, str(p.name), str(p.call_id) ?? str(p.id))
      }
      // A line that only names a tool is not a counted line: nothing about tokens changed.
      return false
    }
    if (type !== 'event_msg' || !p || typeof p !== 'object') return false

    if (p.type === 'task_started') {
      // The first turn of this file begins here; whatever came before was copied history.
      cur.replayDone = true
      return false
    }
    // The begin events of older builds. `item_completed` is deliberately not read: it
    // repeats the call the response item above already carried, and would double it.
    if (p.type === 'exec_command_begin') {
      // The command line is the user's content and is never read; every shell call is
      // "exec", which is also the name the current builds put on the response item.
      this.noteCodexTool(cur, ts, 'exec', str(p.call_id))
      return false
    }
    if (p.type === 'mcp_tool_call_begin') {
      const inv = p.invocation
      const server = inv && typeof inv === 'object' ? str(inv.server) : null
      const tool = inv && typeof inv === 'object' ? str(inv.tool) : null
      this.noteCodexTool(cur, ts, server && tool ? `${server}.${tool}` : tool ?? server, str(p.call_id))
      return false
    }
    if (p.type !== 'token_count') return false

    // The rate-limit block is a reading in its own right, worth keeping even when the
    // token figures of the line are a duplicate or replay.
    const rl = parseCodexRateLimits(p.rate_limits ?? p.rateLimits, Number.isFinite(ts) ? ts : Date.now())
    if (rl && (!cur.lastRateLimits || rl.t >= cur.lastRateLimits.t)) cur.lastRateLimits = rl

    const info = p.info
    if (!info || typeof info !== 'object') return false
    const total = info.total_token_usage
    const last = info.last_token_usage
    if (!total || typeof total !== 'object') return false

    const totalTokens = num(total.total_tokens)

    if (!cur.replayDone) {
      // Replay prefix without a marker: leading events whose timestamp sits at the fork point.
      const atStart =
        cur.startTs !== undefined && Number.isFinite(ts) && Math.abs(ts - cur.startTs) <= 2000
      if (cur.forked && atStart) {
        cur.lastTotal = totalTokens // remember as baseline, do not count
        return false
      }
      cur.replayDone = true
    }
    if (cur.lastTotal === undefined) {
      // First real event: the difference total-last is the inherited baseline.
      const lastTotalTokens = last && typeof last === 'object' ? num(last.total_tokens) : 0
      cur.lastTotal = Math.max(0, totalTokens - lastTotalTokens)
    }

    const prevTotal = cur.lastTotal
    if (totalTokens <= prevTotal) return false // duplicate or post-compaction marker
    cur.lastTotal = totalTokens

    // When total rises, the delta is field-wise identical to last_token_usage.
    const src = last && typeof last === 'object' ? last : total
    const at = Number.isFinite(ts) ? ts : Date.now()
    const model = cur.model || 'unknown'
    const isSub = !!cur.forked
    const b = this.bucketFor('codex', hourIndex(at), localDay(at), model, isSub, 'standard')
    const add = {
      input: num(src.input_tokens),
      cacheRead: num(src.cached_input_tokens),
      cacheWrite: num(src.cache_write_input_tokens),
      output: num(src.output_tokens),
      reasoning: num(src.reasoning_output_tokens),
    }
    b.input += add.input
    b.cacheRead += add.cacheRead
    b.cacheWrite += add.cacheWrite
    b.output += add.output
    b.reasoning += add.reasoning
    b.requests += 1
    b.outputFinal += 1 // Codex reports final values, not a streaming snapshot
    cur.lastTs = at
    this.noteIngest(at)

    if (ctx.attribution !== 'none') {
      const s = this.sessionFor(ctx.file, ctx, () => this.newSession(
        'codex', path.basename(ctx.file, '.jsonl'), path.basename(path.dirname(ctx.file)),
        ctx.file, isSub, null, at, ctx,
      ))
      if (cur.sessionId === undefined) { cur.sessionId = s.sessionId; cur.project = s.project }
      this.noteTurn(s, at, model)
      s.input += add.input
      s.cacheRead += add.cacheRead
      s.cacheWrite += add.cacheWrite
      s.output += add.output
      s.reasoning += add.reasoning
      s.requests += 1
      s.outputFinal += 1
      this.noteCacheWrite(s, add.cacheWrite, 0, at)
      // Codex reports cached tokens inside input_tokens; only the fresh part is billable.
      this.noteSessionHour(
        s, hourIndex(at), Math.max(0, add.input - add.cacheRead) + add.cacheWrite + add.output,
      )
    }
    return true
  }

  /**
   * Counts one Codex tool call. Two rules keep it honest: the replay prefix of a forked
   * rollout carries the parent's calls and is skipped exactly as its token_count events
   * are, and a call id is counted once, so a build that writes both a begin event and a
   * response item for the same call still reports one call.
   */
  private noteCodexTool(cur: Cursor, ts: number, name: string | null, callId: string | null): void {
    if (!name) return
    if (cur.forked && !cur.replayDone) return
    if (callId && !this.firstSightOfCall(`codex|${callId}`)) return
    const at = Number.isFinite(ts) ? ts : Date.now()
    this.addTool('codex', localDay(at), cur.model || 'unknown', name, 1)
  }

  /** Newest rate-limit reading per limit id across every rollout — the network-free Codex quota. */
  codexRateLimits(): CodexRateLimitsSnapshot[] {
    const best = new Map<string, CodexRateLimitsSnapshot>()
    for (const cur of this.cursors.values()) {
      const s = cur.lastRateLimits
      if (!s) continue
      const have = best.get(s.limitId)
      if (!have || s.t > have.t) best.set(s.limitId, s)
    }
    return [...best.values()].sort((a, b) => a.limitId.localeCompare(b.limitId))
  }

  // ----------------------------------------------------------- Persistence

  toSnapshot(): Snapshot {
    return {
      version: STATE_VERSION,
      buckets: [...this.buckets.values()],
      cursors: Object.fromEntries(this.cursors),
      pending: Object.fromEntries(this.pending),
      sessions: Object.fromEntries(this.sessionMap),
      attribution: this.attribution,
      rollup: { ...this.rollupState },
      firstIngest: this.firstIngest,
      tools: [...this.toolStats.values()],
      toolsTruncated: [...this.toolsTruncated],
      agents: Object.fromEntries(this.agentMap),
      launches: Object.fromEntries(this.launchMap),
      mains: Object.fromEntries(this.mainMap),
      journalResults: Object.fromEntries(this.journalResultMap),
      agentsReplayed: this.agentsReplayedFlag,
    }
  }

  /**
   * Restores a snapshot for the given attribution setting. A schema mismatch yields an
   * empty aggregator, which is the signal for a cold scan. The same happens when the
   * setting now asks for session records the snapshot was never collecting (none →
   * project/session): those can only come from a re-read. The other direction just
   * drops the table; project and session share one record shape and switch freely.
   *
   * Versions 5 and 6 are read as well: each lacks one table that simply starts empty —
   * the tool side table (5), the agent tables (6) — and a cold re-read of every transcript
   * would be a steep price for tables that have no history yet either way. A 6 also says
   * the agent replay has not run, so the host rebuilds the agent tables once.
   */
  static fromSnapshot(s: Snapshot | undefined, attribution: Attribution = 'none'): Aggregator {
    const a = new Aggregator()
    a.attribution = attribution
    if (!s || !READABLE_STATE_VERSIONS.includes(s.version)) return a
    const stored: Attribution = s.attribution ?? 'none'
    if (attribution !== 'none' && stored === 'none') return a
    for (const b of s.buckets ?? []) {
      // The source has to be a provider this build knows, not merely a non-empty string: the
      // snapshot is a file a user can edit and another build can have written, and everything
      // downstream looks the source up in the registry to decide how to read the bucket.
      if (!b || typeof b !== 'object' || !isKnownSource(b.source) || !b.res) continue
      a.buckets.set(bucketKey(b), b)
    }
    for (const [k, v] of Object.entries(s.cursors ?? {})) a.cursors.set(k, v)
    for (const [k, v] of Object.entries(s.pending ?? {})) a.pending.set(k, v)
    for (const t of s.tools ?? []) {
      if (!t || typeof t !== 'object' || !isKnownSource(t.source)) continue
      if (typeof t.day !== 'string' || typeof t.name !== 'string') continue
      const row: ToolStat = {
        source: t.source,
        day: t.day,
        model: typeof t.model === 'string' && t.model ? t.model : 'unknown',
        name: t.name,
        calls: num(t.calls),
      }
      const k = toolKey(row)
      const have = a.toolStats.get(k)
      // A file edited by hand can hold the same key twice; folding beats letting one win.
      if (have) { have.calls += row.calls; continue }
      a.toolStats.set(k, row)
      const dayKey = toolDayKey(row.source, row.day)
      let names = a.toolNames.get(dayKey)
      if (!names) { names = new Set<string>(); a.toolNames.set(dayKey, names) }
      names.add(row.name)
    }
    for (const k of s.toolsTruncated ?? []) if (typeof k === 'string' && k) a.toolsTruncated.add(k)
    if (attribution !== 'none') {
      for (const [k, v] of Object.entries(s.sessions ?? {})) a.sessionMap.set(k, v)
    } else {
      a.dropSessionFields()
    }
    if (s.rollup && typeof s.rollup === 'object') {
      a.rollupState = {
        lastRun: num(s.rollup.lastRun),
        hourRetentionDays: num(s.rollup.hourRetentionDays),
        retentionDays: num(s.rollup.retentionDays),
      }
    }
    a.firstIngest = typeof s.firstIngest === 'number' && Number.isFinite(s.firstIngest) ? s.firstIngest : null
    // The agent tables came with version 7. They do not depend on `attribution`: the tree's
    // roots are kept whatever the session table is set to.
    if (s.version >= 7) {
      for (const [file, v] of Object.entries(s.agents ?? {})) {
        const rec = restoreAgent(v)
        if (file && rec) a.agentMap.set(file, rec)
      }
      for (const v of Object.values(s.launches ?? {})) {
        const launch = restoreLaunch(v)
        if (launch) a.launchMap.set(launch.toolUseId, launch)
      }
      for (const [file, v] of Object.entries(s.mains ?? {})) {
        const rec = restoreMain(v)
        if (file && rec) a.mainMap.set(file, rec)
      }
      for (const [id, v] of Object.entries(s.journalResults ?? {})) {
        const agentId = cleanAgentId(id)
        if (agentId !== null && typeof v === 'number' && Number.isFinite(v) && v >= 0) a.journalResultMap.set(agentId, v)
      }
      a.reindexAgents()
      a.agentsReplayedFlag = s.agentsReplayed === true
    }
    return a
  }

  /** Drops per-session data (attribution switched off). */
  clearSessions(): void {
    this.sessionMap.clear()
    this.attribution = 'none'
    this.dropSessionFields()
  }

  /** Session identifiers also live on cursors and open messages; off means gone everywhere. */
  private dropSessionFields(): void {
    for (const c of this.cursors.values()) { delete c.sessionId; delete c.project }
    for (const p of this.pending.values()) delete p.session
  }

  all(): Bucket[] { return [...this.buckets.values()] }

  sessions(): SessionRec[] { return [...this.sessionMap.values()] }

  /**
   * The tool side table over an inclusive local-day range; both bounds are optional and
   * an omitted one is open. The days are the ones stored at ingest, so no zone mapping
   * happens here — unlike hour buckets, a tool row has no hour left to re-address.
   */
  tools(from?: string, to?: string, filter?: ToolFilter): ToolQuery {
    const rows: ToolStat[] = []
    let firstDay: string | null = null
    let truncated = false
    for (const t of this.toolStats.values()) {
      if (from && t.day < from) continue
      if (to && t.day > to) continue
      if (filter?.source && t.source !== filter.source) continue
      if (filter?.models && filter.models.length && !filter.models.includes(t.model)) continue
      rows.push({ ...t })
      if (firstDay === null || t.day < firstDay) firstDay = t.day
    }
    // The flag is per (source, day); a model filter cannot narrow it, so a filtered answer
    // may call itself incomplete when the dropped names belonged to another model. Saying
    // "incomplete" once too often is the harmless direction.
    for (const k of this.toolsTruncated) {
      const cut = k.indexOf('|')
      const source = k.slice(0, cut)
      const day = k.slice(cut + 1)
      if (from && day < from) continue
      if (to && day > to) continue
      if (filter?.source && source !== filter.source) continue
      truncated = true
      break
    }
    rows.sort((a, b) =>
      a.day.localeCompare(b.day) || a.source.localeCompare(b.source) ||
      a.name.localeCompare(b.name) || a.model.localeCompare(b.model))
    return { rows, truncated, firstDay }
  }

  stats(): {
    buckets: number; files: number; oldestDay: string | null; newestDay: string | null
    hourBuckets: number; dayBuckets: number; monthBuckets: number
  } {
    let oldest: string | null = null
    let newest: string | null = null
    let h = 0, d = 0, m = 0
    for (const b of this.buckets.values()) {
      if (b.res === 'h') h++
      else if (b.res === 'd') d++
      else m++
      const day = b.res === 'm' ? monthBounds(b.day) : { first: b.day, last: b.day }
      if (oldest === null || day.first < oldest) oldest = day.first
      if (newest === null || day.last > newest) newest = day.last
    }
    return {
      buckets: this.buckets.size, files: this.cursors.size, oldestDay: oldest, newestDay: newest,
      hourBuckets: h, dayBuckets: d, monthBuckets: m,
    }
  }

  // ---------------------------------------------------------------- Roll-up

  /**
   * Folds hour buckets older than `hourRetentionDays` into local-day buckets and day
   * buckets older than `retentionDays` into month buckets. Sums are preserved exactly;
   * running it twice changes nothing. The zone given here becomes the aggregator's
   * `timeConfig`, so late lines are addressed with the same calendar the fold used.
   *
   * Must not run while a scan is feeding lines — the extension schedules it between
   * scans; the worker never calls it.
   */
  rollup(
    now: number, hourRetentionDays: number, retentionDays: number, tcfg: TimeConfig,
  ): { hoursMerged: number; daysMerged: number } {
    this.timeConfig = tcfg
    const hourHorizon = hourIndex(now) - Math.max(0, Math.floor(hourRetentionDays)) * 24
    const dayHorizon = addDays(dayOf(now, tcfg), -Math.max(0, Math.floor(retentionDays)))
    let hoursMerged = 0
    let daysMerged = 0

    for (const [k, b] of [...this.buckets]) {
      if (b.res !== 'h' || b.hour === null || b.hour >= hourHorizon) continue
      const day = this.dayOfHourMemo(b.hour, tcfg)
      this.buckets.delete(k)
      mergeInto(this.get(b.source, 'd', null, day, b.model, b.isSub, b.tier), b)
      hoursMerged++
    }
    for (const [k, b] of [...this.buckets]) {
      if (b.res !== 'd' || b.day >= dayHorizon) continue
      this.buckets.delete(k)
      mergeInto(this.get(b.source, 'm', null, monthOf(b.day), b.model, b.isSub, b.tier), b)
      daysMerged++
    }
    // The tool table has day resolution and no month step: folding tool names into months
    // would keep a list of names for years, and no view asks for one. It also gets its own,
    // shorter horizon (see TOOL_KEEP_DAYS): day × model × name cannot be carried as far as a
    // rolled-up month bucket without turning the snapshot into megabytes of names. A
    // retention shorter than the cap still wins — the table is never kept longer than buckets.
    const toolHorizon = addDays(
      dayOf(now, tcfg),
      -Math.min(Math.max(0, Math.floor(retentionDays)), TOOL_KEEP_DAYS),
    )
    for (const [k, t] of [...this.toolStats]) {
      if (t.day >= toolHorizon) continue
      this.toolStats.delete(k)
      this.toolNames.delete(toolDayKey(t.source, t.day))
      this.toolsTruncated.delete(toolDayKey(t.source, t.day))
    }
    for (const k of [...this.toolsTruncated]) {
      // `source|day` — a flag whose day is gone has nothing left to qualify.
      if (k.slice(k.indexOf('|') + 1) < toolHorizon) this.toolsTruncated.delete(k)
    }

    // The per-session hour slices exist for the quota windows only, and the longest of those
    // is a week. Keeping them for the full hour-bucket retention would store months of them.
    const sessionHorizon = Math.max(hourHorizon, hourIndex(now) - SESSION_HOUR_KEEP)
    for (const s of this.sessionMap.values()) {
      if (!s.hourUsage) continue
      for (const k of Object.keys(s.hourUsage)) {
        if (Number(k) < sessionHorizon) delete s.hourUsage[k]
      }
    }

    // The agent tables serve a tree of what ran lately, not the history: they keep
    // AGENT_RETENTION_DAYS, whatever the bucket retention says. No setting — the tree has
    // nothing to show for older agents, and the snapshot would carry them on every save.
    this.pruneAgents(now - AGENT_RETENTION_DAYS * MS_DAY)

    this.rollupState = {
      lastRun: now,
      hourRetentionDays: Math.max(0, Math.floor(hourRetentionDays)),
      retentionDays: Math.max(0, Math.floor(retentionDays)),
    }
    return { hoursMerged, daysMerged }
  }

  // ---------------------------------------------------------------- Queries

  private matches(b: Bucket, f?: BucketFilter): boolean {
    if (!f) return true
    if (f.source && b.source !== f.source) return false
    if (f.isSub !== undefined && b.isSub !== f.isSub) return false
    if (f.tier && b.tier !== f.tier) return false
    if (f.models && f.models.length && !f.models.includes(b.model)) return false
    return true
  }

  /**
   * Whether a bucket lies inside an inclusive local-day range. Hour buckets are placed
   * by the configured zone; day buckets are final; a month bucket counts only when the
   * whole month is inside — its days cannot be told apart any more, so a partial month
   * would be a guess. Month buckets are at least `retentionDays` old, so the usual
   * 7/30/90-day ranges never meet one.
   */
  private inRange(b: Bucket, from: string, to: string, tcfg: TimeConfig): boolean {
    if (b.res === 'h') {
      const day = this.dayOfHourMemo(b.hour ?? 0, tcfg)
      return day >= from && day <= to
    }
    if (b.res === 'd') return b.day >= from && b.day <= to
    const m = monthBounds(b.day)
    return m.first >= from && m.last <= to
  }

  /** Sums over an inclusive local-day range; uses the time config to map hour buckets to days. */
  sum(from: string, to: string, tcfg: TimeConfig, filter?: BucketFilter): Bucket {
    const out = emptyBucket(filter?.source ?? 'claude', '*', false, 'standard', 'd', null, from)
    for (const b of this.buckets.values()) {
      if (!this.matches(b, filter) || !this.inRange(b, from, to, tcfg)) continue
      mergeInto(out, b)
    }
    return out
  }

  /**
   * Hypothetical API cost for a period. Computed per bucket, because rates differ by
   * model, day and tier. Tokens that could not be priced are reported, never folded
   * into the total — a silently low figure is worse than a marked gap.
   */
  cost(from: string, to: string, tcfg: TimeConfig, pricing: PricingOptions, filter?: BucketFilter): CostSummary {
    const out: CostSummary = {
      usd: 0, listUsd: 0, unpricedTokens: 0, unpricedModels: [], fastUnpricedTokens: 0,
      familyPriced: [], custom: isCustomPricing(pricing),
    }
    const unpriced = new Set<string>()
    const family = new Set<string>()
    for (const b of this.buckets.values()) {
      if (!this.matches(b, filter) || !this.inRange(b, from, to, tcfg)) continue
      const c = this.costOfBucket(b, tcfg, pricing)
      if (c === null) {
        unpriced.add(b.model)
        out.unpricedTokens += billable(b)
        continue
      }
      if (c.unpriced) {
        out.fastUnpricedTokens += billable(b)
        continue
      }
      out.usd += c.usd
      out.listUsd += c.listUsd
      if (c.confidence === 'family') family.add(b.model)
      if (c.confidence === 'custom') out.custom = true
    }
    out.unpricedModels = [...unpriced].sort()
    out.familyPriced = [...family].sort()
    return out
  }

  /** The dated price rule is chosen by the bucket's day in the configured zone. */
  private costOfBucket(b: Bucket, tcfg: TimeConfig, pricing: PricingOptions) {
    const day = b.res === 'h' ? this.dayOfHourMemo(b.hour ?? 0, tcfg) : b.res === 'm' ? `${b.day}-01` : b.day
    return costOfBucket(day === b.day ? b : { ...b, day }, pricing)
  }

  /**
   * One value per day, ascending, for charts. `days` is a contiguous ascending list.
   * A month bucket whose month lies inside the list is shown on the month's first day:
   * its daily distribution no longer exists and spreading it evenly would invent one.
   */
  series(days: string[], tcfg: TimeConfig, filter?: BucketFilter, metric: Metric = 'usage', pricing?: PricingOptions): number[] {
    const out = new Array<number>(days.length).fill(0)
    if (days.length === 0) return out
    const idx = new Map(days.map((d, i) => [d, i]))
    const from = days[0]
    const to = days[days.length - 1]
    for (const b of this.buckets.values()) {
      if (!this.matches(b, filter)) continue
      let day: string
      if (b.res === 'h') day = this.dayOfHourMemo(b.hour ?? 0, tcfg)
      else if (b.res === 'd') day = b.day
      else {
        const m = monthBounds(b.day)
        if (m.first < from || m.last > to) continue
        day = m.first
      }
      const i = idx.get(day)
      if (i === undefined) continue
      out[i] += this.metricOf(b, metric, tcfg, pricing)
    }
    return out
  }

  private metricOf(b: Bucket, metric: Metric, tcfg: TimeConfig, pricing?: PricingOptions): number {
    switch (metric) {
      case 'output': return b.output
      case 'cacheRead': return b.cacheRead
      case 'requests': return b.requests
      case 'reasoning': return b.reasoning
      case 'cost': {
        const c = this.costOfBucket(b, tcfg, pricing ?? {})
        return c && !c.unpriced ? c.usd : 0
      }
      default: return billable(b)
    }
  }

  /**
   * Hour-resolution sums for [fromMs, toMs), hour-rounded outward. Only hour buckets
   * take part; when the interval reaches below the roll-up horizon the answer is
   * flagged incomplete instead of being padded with day-bucket guesses.
   */
  sumHours(fromMs: number, toMs: number, filter?: BucketFilter): { bucket: Bucket; complete: boolean } {
    const out = emptyBucket(filter?.source ?? 'claude', '*', false, 'standard', 'h', null, localDay(fromMs))
    if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || toMs <= fromMs) return { bucket: out, complete: true }
    const fromHour = hourIndex(fromMs)
    const toHour = Math.ceil(toMs / MS_HOUR)
    for (const b of this.buckets.values()) {
      if (b.res !== 'h' || b.hour === null) continue
      if (b.hour < fromHour || b.hour >= toHour) continue
      if (!this.matches(b, filter)) continue
      mergeInto(out, b)
    }
    const hh = this.hourHorizon()
    return { bucket: out, complete: hh === null || fromHour >= hh }
  }
}

/** Adds every counter of `src` onto `dst`; the identity fields of `dst` stay untouched. */
function mergeInto(dst: Bucket, src: Bucket): void {
  dst.input += src.input
  dst.cacheWrite += src.cacheWrite
  dst.cacheWrite1h += src.cacheWrite1h
  dst.cacheRead += src.cacheRead
  dst.output += src.output
  dst.reasoning += src.reasoning
  dst.requests += src.requests
  dst.outputFinal += src.outputFinal
  dst.webSearch += src.webSearch
  dst.webFetch += src.webFetch
}
