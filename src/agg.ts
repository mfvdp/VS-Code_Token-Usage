// SPDX-FileCopyrightText: 2026 Frederik Marx
// SPDX-License-Identifier: AGPL-3.0-or-later

import * as path from 'path'
// Value import, and safe: `adapters` imports this module for types only, so the cycle is erased.
import { isKnownSource } from './adapters'
import { AGENT_RETENTION_DAYS, MAX_RUN_AGENTS } from './agentTree'
import { PricingOptions, costOfBucket, isCustomPricing } from './prices'
import {
  OTHER_PROJECTS, PROJECT_CAP, UNATTRIBUTED, cleanProjectName, isProjectKey, projectKeyOf, projectLabel, slugOf,
} from './project'
import { cleanRunRecord, cleanRunRecordStat } from './runRecord'
import { SYSTEM_TIME_CONFIG, TimeConfig, Zone, addDays, dayOf, dayOfHour, hourIndex, monthOf } from './time'
import {
  AgentLaunch, AgentMeta, AgentRec, ApiErrorKind, Attribution, Bucket, CacheMissKind, MainRec, CodexRateLimitsSnapshot, CodexTurn, CompactionRec,
  Cursor, Effort, JournalAgent, LastRequest, LaunchStatus, PendingMessage, PermissionMode, ProjectLabel, RateLimitKind, RecordedOutcome, RejectedRequest,
  Resolution, RunLaunch, RunRec, RunRecordStat, SessionRec, Snapshot, Source, StopReason, Tier, ToolStat, bucketKey, emptyBucket, READABLE_STATE_VERSIONS,
  STATE_VERSION, TOOL_IDS_PER_MESSAGE, TOOL_NAME_CAP, TOOL_NAME_MAX_CHARS, toolDayKey, toolKey,
} from './types'

/** Per-file context the scanner hands to every ingest call. */
export interface IngestContext {
  isSub: boolean
  file: string
  attribution: Attribution
  projectSalt: string
  hashProjects: boolean
  /** Replay: touch only agents/launches/mains/runs, never buckets, pending, sessions, tools or cursors. */
  agentsOnly?: boolean
}

export interface BucketFilter {
  source?: Source
  models?: string[]
  isSub?: boolean
  tier?: Tier
}

/** One sum of hour buckets over `[fromMs, toMs)`, as `Aggregator.sumHours` takes it — a query of `sumHoursMany`. */
export interface HourQuery {
  fromMs: number
  toMs: number
  filter?: BucketFilter
}

/**
 * 1.6 L5: what the reads since the host last asked have changed (`Aggregator.takeChanges`). `buckets`
 * is every table a counted line writes besides the agent tables — the buckets, and the session and
 * tool tables written with them —, `agents` the agent tables: agents, launches, main sessions, runs
 * and their launches. Either can be set without the other: a journal line or a parent's result
 * writes only the agent tables, a Codex line only the buckets.
 */
export interface IngestChanges {
  buckets: boolean
  agents: boolean
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

/**
 * 1.14 §3 A3 rule 3 (§7a Q12): at most this many session records — the newest kept. One record per transcript file,
 * every subagent and workflow agent included, each with up to TURN_GAP_CAP gap numbers: 255 of them in four days on
 * the measuring machine (≈ 64 a day), so 2000 is about 45 days of that pace with room; beside the cap, a record whose
 * last line is older than `hourRetentionDays` goes at the roll-up.
 */
export const SESSION_CAP = 2000

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

/**
 * 1.9 L-8: the options a cost series without pricing is priced with — the empty options, one object
 * for the process, so `priceOf` keeps one memo for them (it keeps one per options object) rather than
 * a new one, a miss and garbage for every bucket. Frozen: every such series shares it, none may write.
 */
const NO_PRICING: PricingOptions = Object.freeze({})

/** First and last calendar day of a YYYY-MM month, so a month bucket can be range-checked. */
function monthBounds(month: string): { first: string; last: string } {
  const first = `${month}-01`
  const y = Number(month.slice(0, 4))
  const m = Number(month.slice(5, 7))
  const days = Number.isFinite(y) && Number.isFinite(m) ? new Date(Date.UTC(y, m, 0)).getUTCDate() : 31
  return { first, last: `${month}-${String(days).padStart(2, '0')}` }
}

// ------------------------------------------------------------- Attribution (1.14 §0a.1–§0a.4)

/**
 * §0a.1: a Claude transcript's project key — of where the file lies, never of a line: the directory directly below
 * the projects root, which `claudePlacement` returns as its `slug` for a main transcript, a subagent and a workflow
 * agent alike (the session's directory). So the key is known before the first line is parsed, the same for every
 * line of the file and for every file of a session — a worktree's agent counts to the folder its session was
 * started in. The segment goes into the hash and nowhere else. '' without a salt or a slug.
 */
function claudeProjectOf(place: ClaudePlacement, ctx: IngestContext): string {
  return projectKeyOf(ctx.projectSalt, place.slug)
}

/**
 * §0a.2: a folder's name, of a main transcript's counted line — only under `showProjectNames: basename`, and only
 * when the line's `cwd` slugs to the transcript's directory: the working directory is the project folder itself, not
 * a worktree or a subdirectory a session moved to. Under hash, off, or for a subagent it returns before the line is
 * looked at. The `cwd` does not outlive the call.
 */
function claudeProjectName(d: any, slug: string, ctx: IngestContext): string | null {
  if (ctx.attribution === 'none' || ctx.hashProjects || ctx.isSub) return null
  const cwd = str(d.cwd)
  if (cwd === null || slugOf(cwd) !== slug) return null
  return cleanProjectName(path.basename(cwd))
}

/** §0a.4: a Claude line's session id — `[A-Za-z0-9_-]`, at most 64 characters, else the file's name. */
function claudeSessionOf(d: any, file: string): string {
  return cleanAgentId(d.sessionId) ?? path.basename(file, '.jsonl')
}

/** What a Codex rollout's `session_meta` line gives (§0a.3, §0a.4). */
interface CodexMetaFacts {
  /** The rollout is a fork or a subagent's thread: its copied history is skipped (read since 1.2). */
  forked: boolean
  forkedFrom: string | null
  /** With attribution on: the session id, the project key ('' without a `cwd`), with names on the folder's name. */
  attributed: { sessionId: string; key: string; name: string | null } | null
}

/**
 * §0a.3: a rollout's `session_meta` payload — of it `forked_from_id` and `thread_source` for the counting (since
 * 1.2), and with attribution on `id` and `cwd`: the key is `projectKeyOf(salt, slugOf(cwd))`, so a Codex session
 * started in a folder and a Claude Code session started there share one key; under basename the folder's name too.
 * A payload without `cwd` is unattributed (key '') — never its day directory (§7a Q15). The `cwd` does not outlive
 * the call.
 */
function codexSessionMeta(p: any, file: string, ctx: IngestContext): CodexMetaFacts {
  const forkedFrom = str(p.forked_from_id)
  const forked = forkedFrom !== null || p.thread_source === 'subagent'
  if (ctx.attribution === 'none') return { forked, forkedFrom, attributed: null }
  const sessionId = cleanAgentId(p.id) ?? path.basename(file, '.jsonl')
  const cwd = str(p.cwd)
  if (cwd === null) return { forked, forkedFrom, attributed: { sessionId, key: UNATTRIBUTED, name: null } }
  return {
    forked, forkedFrom,
    attributed: {
      sessionId,
      key: projectKeyOf(ctx.projectSalt, slugOf(cwd)),
      name: ctx.hashProjects ? null : cleanProjectName(path.basename(cwd)),
    },
  }
}

/**
 * 1.14 §3 A2 rule 4: whether a stored snapshot is one this build does not read under the given attribution because
 * it predates the project key — a version 5–8 snapshot under project or session. The host re-reads the transcripts
 * then, and its log says why once. Under none a version 5–8 snapshot is read as it stands and saved as 9.
 */
export function needsProjectReread(s: Snapshot | undefined, attribution: Attribution): boolean {
  return s !== undefined && s !== null && attribution !== 'none'
    && READABLE_STATE_VERSIONS.includes(s.version) && s.version < STATE_VERSION
}

/**
 * A stored session record (version 9, attribution on): its project key checked (§0a.6 — anything else is the
 * unattributed key), and 1.0–1.13's `projectHash` and `hourUsage` left behind (§3 A3 rule 4). Null for no record.
 */
function restoreSession(v: unknown): SessionRec | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null
  const rec = { ...(v as SessionRec & { projectHash?: unknown; hourUsage?: unknown }) }
  delete rec.projectHash
  delete rec.hourUsage
  rec.project = storedProjectKey(rec.project) ?? UNATTRIBUTED
  return rec
}

/** A project key as stored, or null for anything this build does not accept (§0a.6's allow-list). */
function storedProjectKey(v: unknown): string | null {
  return isProjectKey(v) ? v : null
}

/**
 * §0a.6: a label as stored — `lastTs` a finite number, `name` exactly what `cleanProjectName` gives (else dropped),
 * and only with `names` on.
 */
function restoreProjectLabel(key: string, v: unknown, names: boolean): ProjectLabel | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null
  const o = v as Record<string, unknown>
  const label: ProjectLabel = { lastTs: typeof o.lastTs === 'number' && Number.isFinite(o.lastTs) && o.lastTs > 0 ? o.lastTs : 0 }
  if (names && key !== UNATTRIBUTED && key !== OTHER_PROJECTS && typeof o.name === 'string' && cleanProjectName(o.name) === o.name) label.name = o.name
  if (key === OTHER_PROJECTS && typeof o.folded === 'number' && Number.isInteger(o.folded) && o.folded > 0) label.folded = o.folded
  return label
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

/**
 * A workflow run's id as a `Workflow` tool result names it (1.6 §0a.3): `wf_` and 1 to 61
 * characters of `[A-Za-z0-9_-]`, 64 at most — the name of the run's directory. Observed: 212 of
 * 212 results, all `wf_` + 8 hex + `-` + 3 hex.
 */
const RUN_ID_RE = /^wf_[A-Za-z0-9_-]{1,61}$/

/** A run id through its allow-list, or null. */
export function cleanRunId(v: unknown): string | null {
  return typeof v === 'string' && RUN_ID_RE.test(v) ? v : null
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

/**
 * The five identity fields, each through its sanitiser; null when none of them is usable. 1.6 O3
 * (§0a.11): the fifth, `parentAgentId`, is the spawning agent's id, through the id alphabet.
 */
function cleanMeta(v: unknown): AgentMeta | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null
  const o = v as Record<string, unknown>
  const meta: AgentMeta = {
    agentType: cleanAgentName(o.agentType),
    model: cleanAgentName(o.model),
    spawnDepth: cleanDepth(o.spawnDepth),
    toolUseId: cleanAgentId(o.toolUseId),
    parentAgentId: cleanAgentId(o.parentAgentId),
  }
  return meta.agentType === null && meta.model === null && meta.spawnDepth === null && meta.toolUseId === null
    && meta.parentAgentId === null
    ? null
    : meta
}

/** Whether two run record stats say the same size and time. */
function sameStat(a: RunRecordStat | null, b: RunRecordStat | null): boolean {
  if (a === null || b === null) return a === b
  return a.size === b.size && a.mtimeMs === b.mtimeMs
}

/** Whether two identities say the same, field by field. */
function sameMeta(a: AgentMeta | null, b: AgentMeta | null): boolean {
  if (a === null || b === null) return a === b
  return a.agentType === b.agentType && a.model === b.model && a.spawnDepth === b.spawnDepth
    && a.toolUseId === b.toolUseId && a.parentAgentId === b.parentAgentId
}

/**
 * The identity an `agent-<id>.meta.json` gives its transcript: `agentType`, `model`,
 * `spawnDepth`, `toolUseId` and — since 1.6 O3 (§0a.11) — `parentAgentId`, each through its
 * sanitiser, and nothing else. The sidecar also holds the agent's description and its whole
 * prompt, and beside them how it was asked (`requestShape`), its workflow phase and its worktree's
 * path and branch; those are content or paths, and the parsed object that holds them does not
 * outlive this call. Null when the text is no JSON object or none of the five fields is usable.
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
 * The head of a workflow journal line (1.6 §0a.1): its `type`, its `key` and its `agentId`, in the
 * order Claude Code writes them — `{"type":…,"key":…,"agentId":…` on every line of the measuring
 * machine — matched at the start of the raw line. The rest of the line — an agent's `result`, a
 * step's `label` and `phase` — is never parsed. A key outside its allow-list makes the key group
 * fail and the agentId group with it; such a line has no head (see `journalHead`).
 */
export const JOURNAL_HEAD_RE = /^\{"type":"(started|result|failed|launched)"(?:,"key":"(v[0-9]{1,2}:[0-9a-f]{64})")?(?:,"agentId":"([A-Za-z0-9_-]{1,64})")?(?=[,}])/
/** A journal key: Claude Code writes `v2:` and 64 hex digits; `v1:` is accepted too, and nothing else. */
const JOURNAL_KEY_RE = /^v[0-9]{1,2}:[0-9a-f]{64}$/
/**
 * A journal line without the head is parsed only up to this size (`journalFallback`); a longer
 * one is skipped and counted, never read. Observed: no line needs the fallback at all.
 */
export const JOURNAL_PARSE_MAX = 16 * 1024

/**
 * The revision of the agent tables. The host replays the retained transcripts and journals once
 * whenever the snapshot's `agentsRevision` differs (see `Aggregator.agentsRevision`): a build
 * that adds a field only a replay can fill for the transcripts already read raises it by one.
 * 1 = 1.6's runs from the workflow journals; 2 = the `Workflow` launches and their ends (N4); 3 = the
 * rejected requests of the agents (N3); 4 = the records of the agents whose transcript holds
 * nothing but rejected requests (D4); 5 = the last tool call of an agent and its time (N5); 6 = the
 * effort of an agent's replies (N8) and the context of its newest request (L2); 7 = the metadata of O3 —
 * an agent's tool errors and cache misses, the Claude Code version, the permission mode and the
 * compactions of an agent's and a main session's transcript — and the sidecar's `parentAgentId`,
 * which the replay reads the sidecar of an agent again for; 8 = Claude Code's run record of each
 * workflow run (L4), which the replay reads once for every run it keeps; 9 = the newest request of a
 * main session that read or wrote the prompt cache (1.8 A1, §0a.2) — its first line's time, the TTL
 * class of its cache write, its size and its model, with the reply's stop reason and whether the
 * transcript's newest message line is the user's (§0a.5) —, which the replay fills for the transcripts
 * already read: without it a session idle at the update would get its estimate only with its next
 * reply, and that is exactly the session the estimate is for; 10 = the time of a main session's newest
 * user line (1.9 §0a.1, `MainRec.lastUserAt`), which the replay fills for the transcripts already read:
 * without it a session left behind before the update would keep its folder's keep-warm line back until
 * its transcript leaves the retention — the case the bound of G13 (1.9 D) is for.
 */
export const AGENT_TABLES_REVISION = 10

/** Whether a Claude file is a workflow run's journal rather than a transcript. */
export function isWorkflowJournal(file: string): boolean {
  return path.basename(file) === 'journal.jsonl'
}

/** What a journal line says: its type, its key (null without one, or outside the allow-list) and its agent. */
interface JournalHead {
  type: 'started' | 'result' | 'failed' | 'launched'
  key: string | null
  agentId: string | null
}

/**
 * The fallback for a journal line the head does not match, at most JOURNAL_PARSE_MAX: parsed, the
 * same three fields picked through the same allow-lists — a key that fails its pattern is none,
 * which puts the agent at step 0 — and nothing of the parsed object kept.
 */
function journalFallback(raw: string): JournalHead | null {
  let d: any
  try { d = JSON.parse(raw) } catch { return null }
  if (!d || typeof d !== 'object' || Array.isArray(d)) return null
  const type: unknown = d.type
  if (type !== 'started' && type !== 'result' && type !== 'failed' && type !== 'launched') return null
  const key: unknown = d.key
  return { type, key: typeof key === 'string' && JOURNAL_KEY_RE.test(key) ? key : null, agentId: cleanAgentId(d.agentId) }
}

/**
 * The head of a journal line, by the anchored pattern; the fallback for a short line without one;
 * 'skip' for a longer one. A `started`, `result` or `failed` whose head names no agent — its key
 * was outside the allow-list, or it had none of the two — counts as no head.
 */
function journalHead(raw: string): JournalHead | null | 'skip' {
  const m = JOURNAL_HEAD_RE.exec(raw)
  if (m && (m[1] === 'launched' || m[3] !== undefined)) {
    return { type: m[1] as JournalHead['type'], key: m[2] ?? null, agentId: m[3] ?? null }
  }
  if (raw.length > JOURNAL_PARSE_MAX || Buffer.byteLength(raw, 'utf8') > JOURNAL_PARSE_MAX) return 'skip'
  return journalFallback(raw)
}

/**
 * Whether a raw Claude line is worth parsing. Parsing is most of what a scan costs, so a line
 * is looked at first: a response carries "usage" — an API error line an all-zero one (981 of 981
 * on the measuring machine), which is how a rejected request (1.6 N3) is read; an agent's result is a `toolUseResult` with
 * an `agentId` *key* after it, a workflow run's (1.6 N4) one with a `runId` key — a key, because
 * inside a JSON string the quotes around the word would be escaped, so a tool's output that
 * merely mentions it does not pass; a background agent's or run's end is a task notification,
 * and a tool result never is one. Everything else — a tool's output, a prompt, an attachment —
 * is passed over unparsed.
 */
function worthParsing(raw: string): boolean {
  if (raw.indexOf('"usage"') >= 0) return true
  const at = raw.indexOf('"toolUseResult"')
  if (at >= 0) return raw.indexOf('"agentId"', at) >= 0 || raw.indexOf('"runId"', at) >= 0
  return raw.indexOf('task-notification') >= 0
}

/**
 * What a recorded status word means (§0a.0 of the 1.6 spec): `completed`; a failure for
 * `failed`, `error` and `timeout`; a stop — not a failure — for `killed`, `cancelled` and
 * `stopped`. The same map for a tool result and a task notification. Null for any other value,
 * which is no word this build knows.
 */
export function outcomeOfStatus(status: unknown): RecordedOutcome | null {
  switch (status) {
    case 'completed': return 'completed'
    case 'failed':
    case 'error':
    case 'timeout':
      return 'failed'
    case 'killed':
    case 'cancelled':
    case 'stopped':
      return 'stopped'
    default:
      return null
  }
}

/** A launch's recorded end and the parent's own word for it, or "launched" (no word). */
interface LaunchNews {
  outcome: 'launched' | RecordedOutcome
  status: LaunchStatus | null
}

/**
 * What a reported status means for a launch: `async_launched` is a background start, the seven
 * words of `outcomeOfStatus` an end, each kept with its word. A status this build does not know
 * is no result and leaves the launch as it was (undefined).
 */
function launchOutcome(status: unknown): LaunchNews | undefined {
  if (status === 'async_launched') return { outcome: 'launched', status: null }
  const outcome = outcomeOfStatus(status)
  return outcome === null ? undefined : { outcome, status: status as LaunchStatus }
}

/** Where a launch keeps its end — an agent's launch and a run's alike. */
interface LaunchEnd {
  outcome: 'launched' | RecordedOutcome | null
  outcomeTs: number | null
  outcomeStatus: LaunchStatus | null
}

/**
 * An outcome onto a launch, an agent's or a workflow run's. "Launched" never takes back a result
 * — a re-read line or a late copy must not revive a finished agent — and a result already
 * recorded keeps the time and the word it was first recorded with: a notification that repeats a
 * stop in another word ("killed" after "stopped") is the same stop. A word arriving for an
 * outcome that had none (a snapshot written before 1.6) is taken. True when anything changed.
 */
function applyEnd(launch: LaunchEnd, news: LaunchNews, at: number | null): boolean {
  const outcome = news.outcome
  if (outcome === 'launched') {
    if (launch.outcome !== null) return false
    launch.outcome = 'launched'
    return true
  }
  if (launch.outcome !== outcome) {
    launch.outcome = outcome
    launch.outcomeTs = at
    launch.outcomeStatus = news.status
    return true
  }
  let changed = false
  if (launch.outcomeTs === null && at !== null) {
    launch.outcomeTs = at
    changed = true
  }
  if (launch.outcomeStatus === null && news.status !== null) {
    launch.outcomeStatus = news.status
    changed = true
  }
  return changed
}

/**
 * A recorded word as a snapshot carries it, kept only while it is one of the seven and says the
 * outcome it is stored beside — anything else is no word (null).
 */
function restoreStatus(v: unknown, outcome: unknown): LaunchStatus | null {
  const mapped = outcomeOfStatus(v)
  return mapped !== null && mapped === outcome ? v as LaunchStatus : null
}

/** The parent's own report of a finished sync agent — only when all three numbers are there. */
function reportedTotals(r: Record<string, unknown>): AgentLaunch['totals'] {
  const ok = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0
  const tokens = r.totalTokens
  const durationMs = r.totalDurationMs
  const toolUses = r.totalToolUseCount
  return ok(tokens) && ok(durationMs) && ok(toolUses) ? { tokens, durationMs, toolUses } : null
}

/** The `error` values an API error line may give (1.6 §0a.2) — every one Claude Code writes there. */
const API_ERROR_KINDS: readonly ApiErrorKind[] = [
  'rate_limit', 'server_error', 'invalid_request', 'authentication_failed', 'max_output_tokens', 'overloaded',
]
/** The limits a rejected request may name in its `quotaLimits.rateLimitType`. */
const RATE_LIMIT_KINDS: readonly RateLimitKind[] = ['five_hour', 'seven_day', 'seven_day_opus', 'seven_day_sonnet']

/** An HTTP status: a whole number from 100 to 599, or null. */
function httpStatus(v: unknown): number | null {
  return typeof v === 'number' && Number.isInteger(v) && v >= 100 && v <= 599 ? v : null
}

function apiErrorKind(v: unknown): ApiErrorKind | null {
  return typeof v === 'string' && (API_ERROR_KINDS as readonly string[]).includes(v) ? v as ApiErrorKind : null
}

function rateLimitKind(v: unknown): RateLimitKind | null {
  return typeof v === 'string' && (RATE_LIMIT_KINDS as readonly string[]).includes(v) ? v as RateLimitKind : null
}

/**
 * What an API error line says of the request it rejected (1.6 N3, §0a.2): three values, each
 * through its allow-list — the HTTP status `apiErrorStatus`, the `error` kind, and of the
 * `quotaLimits` block, when it is a plain object, the limit that refused it (`rateLimitType`).
 * Nothing else of the line is read: its message holds the error's text, and the block beside the
 * limit an account's reset times and upgrade offers.
 */
export function rejectedOf(d: any): Omit<RejectedRequest, 'at'> {
  const q = d.quotaLimits
  const plain = q !== null && typeof q === 'object' && !Array.isArray(q)
  return {
    status: httpStatus(d.apiErrorStatus),
    error: apiErrorKind(d.error),
    limit: plain ? rateLimitKind(q.rateLimitType) : null,
  }
}

/** A rejected request as a snapshot carries it, every value checked as at ingest; null when its time is not one. */
function restoreRejected(v: unknown): RejectedRequest | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null
  const r = v as Record<string, unknown>
  const at = finiteOrNull(r.at)
  if (at === null || at <= 0) return null
  return { at, status: httpStatus(r.status), error: apiErrorKind(r.error), limit: rateLimitKind(r.limit) }
}

/**
 * The levels an assistant line's top-level `effort` may give (1.6 N8, §0a.4) — every one Claude
 * Code writes there. Observed on this machine's agent transcripts: xhigh, max, high and medium;
 * `low` is Claude Code's fifth.
 */
const EFFORT_LEVELS: readonly Effort[] = ['low', 'medium', 'high', 'xhigh', 'max']
/** The distinct efforts an agent's record lists: at most as many as there are. */
export const AGENT_EFFORTS_MAX = EFFORT_LEVELS.length

function effortLevel(v: unknown): Effort | null {
  return typeof v === 'string' && (EFFORT_LEVELS as readonly string[]).includes(v) ? v as Effort : null
}

/**
 * The effort an assistant line of an agent's transcript was written at (1.6 N8, §0a.4): its
 * top-level `effort`, through its allow-list — one of the five levels, else null. Nothing nested is
 * looked at: a tool's input may carry an `effort` of its own (a proposal's size, say), and an API
 * error line's `perTurnEffort` is another field of another line.
 */
export function effortOf(d: any): Effort | null {
  return effortLevel(d.effort)
}

/** The distinct efforts a snapshot lists, each checked as at ingest, in their order, at most AGENT_EFFORTS_MAX. */
function restoreEfforts(v: unknown): Effort[] {
  if (!Array.isArray(v)) return []
  const out: Effort[] = []
  for (const e of v) {
    const level = effortLevel(e)
    if (level !== null && !out.includes(level) && out.length < AGENT_EFFORTS_MAX) out.push(level)
  }
  return out
}

// ---------------------------------------------------------------------------
// 1.6 O3: further metadata without content (§0a.6–0a.10)
// ---------------------------------------------------------------------------

/** A plain JSON object — not null, not an array. */
function plainObject(v: unknown): v is Record<string, any> {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
}

/** A token figure a line states: a finite number of at least 0, else none. */
function tokenFigure(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null
}

/**
 * 1.6 O3 (§0a.6): the mark of a tool result whose tool failed — Claude Code's own key of a
 * `tool_result` block, `is_error`, set true — counted on the raw line. Inside a JSON string (a
 * tool's output that mentions it, a prompt that quotes it) its quotes are escaped
 * (`\"is_error\":true`), so the unescaped literal can only be the key itself: the line is not
 * parsed for it, and the tool's output is never looked at.
 */
export const TOOL_ERROR_LITERAL = '"is_error":true'

/** How many tool results a raw line marks `is_error` (§0a.6): the count of the literal, nothing parsed. */
export function toolErrorsOf(raw: string): number {
  let n = 0
  for (let at = raw.indexOf(TOOL_ERROR_LITERAL); at >= 0; at = raw.indexOf(TOOL_ERROR_LITERAL, at + TOOL_ERROR_LITERAL.length)) n++
  return n
}

/**
 * 1.6 O3 (§0a.9): the permission mode a user line names at its top level — the key and one of the
 * five modes Claude Code writes, unescaped, matched on the raw line. The line holds the user's
 * prompt or a tool's output and is never parsed for it; a prompt that spells the key out has its
 * quotes escaped and does not match.
 */
export const PERMISSION_MODE_RE = /"permissionMode":"(default|acceptEdits|bypassPermissions|plan|auto)"/

/** The permission mode a raw line names (§0a.9), or null. */
export function permissionModeOf(raw: string): PermissionMode | null {
  const m = PERMISSION_MODE_RE.exec(raw)
  return m === null ? null : m[1] as PermissionMode
}

const PERMISSION_MODES: readonly PermissionMode[] = ['default', 'acceptEdits', 'bypassPermissions', 'plan', 'auto']

function permissionModeValue(v: unknown): PermissionMode | null {
  return typeof v === 'string' && (PERMISSION_MODES as readonly string[]).includes(v) ? v as PermissionMode : null
}

/**
 * The permission modes remembered for transcripts that have no record yet (§0a.9): the prompt
 * line that names one comes before the transcript's first counted reply, which makes the record.
 * Oldest dropped first; not persisted.
 */
export const PENDING_MODE_MAX = 4000

/**
 * 1.6 O3 (§0a.10): the line Claude Code writes where it compacted a transcript — a `system` line
 * of the subtype `compact_boundary` —, recognised on the raw line by the key and its value,
 * unescaped, before it is parsed. A tool's input or output that merely names the word does not
 * pass: inside a string the quotes around it are escaped.
 */
const COMPACT_BOUNDARY_LITERAL = '"subtype":"compact_boundary"'
/**
 * The user line a compaction leaves its summary on (`isCompactSummary`): the summary is content,
 * and the line is never parsed — whatever it happens to mention (§0a.10).
 */
const COMPACT_SUMMARY_LITERAL = '"isCompactSummary":true'

/**
 * 1.8 §0a.5 (probe P-6): a `user` line of a Claude transcript — a prompt or a tool result —, recognised
 * on the raw line by its top-level `type`, unescaped. The line holds the user's prompt or a tool's
 * output and is never parsed for it (only the lines the aggregator parses for other reasons are, and
 * for them the parsed `type` decides). Inside a string the quotes are escaped, so a prompt that
 * spells the literal out does not match; an object nested in another kind of line that carried the
 * literal (none is known) would count it as a user line — the direction that keeps the keep-warm
 * guard shut, never one that opens it.
 */
export const USER_LINE_LITERAL = '"type":"user"'

/**
 * 1.9 §0a.1: a `timestamp` key of a Claude line, unescaped, in the `Z` form Claude Code writes — only
 * ever a key of an object of the line (the line's own, or one Claude Code nests in it, a
 * `toolUseResult`), never text inside a string: there every quote is escaped, so a prompt or a tool's
 * output that spells the key out does not match. Matched on the raw line of a `user` line, which is
 * never parsed for it; an offset form (`+02:00`) is not matched. `g`: every match of a line counts.
 */
export const USER_LINE_TIME_RE = /"timestamp":"(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z)"/g
/**
 * The copy `userLineTimeOf` walks: `matchAll` starts at its pattern's `lastIndex`, and the exported one
 * is anyone's to call `exec` or `test` on — this one no other code sees, so every walk starts at 0.
 */
const USER_LINE_TIME_SCAN = new RegExp(USER_LINE_TIME_RE.source, 'g')

/**
 * 1.9 §0a.1: the time (ms) a user line gives `MainRec.lastUserAt` — the **latest** of every
 * USER_LINE_TIME_RE match on the raw line whose `Date.parse` is finite and above 0, or null for none.
 * The latest, because a nested key older than the line's own must never make a session look older
 * than it is (the direction that would let the keep-warm line go, 1.9 D); a newer nested key can only
 * make it look newer, which keeps the line back. Nothing of the line but the matched times is looked
 * at, and nothing of it outlives the call.
 */
export function userLineTimeOf(raw: string): number | null {
  if (typeof raw !== 'string') return null
  let best: number | null = null
  for (const m of raw.matchAll(USER_LINE_TIME_SCAN)) {
    const t = Date.parse(m[1])
    if (Number.isFinite(t) && t > 0 && (best === null || t > best)) best = t
  }
  return best
}

/** 1.8 §0a.5: the values of a reply's `stop_reason` kept on `LastRequest.stop` — the Messages API's documented ones. */
export const STOP_REASONS: readonly StopReason[] = ['end_turn', 'tool_use', 'max_tokens', 'stop_sequence', 'pause_turn', 'refusal']

/** A `stop_reason` through its allow-list (§0a.5); any other value, `null` included, is null. */
export function stopReasonOf(v: unknown): StopReason | null {
  return typeof v === 'string' && (STOP_REASONS as readonly string[]).includes(v) ? v as StopReason : null
}

/**
 * The kind of a Claude line for `LastRequest.replyPending` (§0a.5): `user` or `assistant` — a line of
 * a message —, or null for every other line (`attachment`, `system`, `file-history-snapshot`,
 * `last-prompt`, `ai-title`, `mode`, `permission-mode`, `progress`, `queue-operation`, …). A parsed
 * line says it by its `type`; a line the aggregator does not parse is a user line only by the raw
 * literal, and is never an assistant line — a reply is always parsed (it carries `usage`).
 */
function messageKindOf(raw: string, d: unknown): 'user' | 'assistant' | null {
  if (d !== undefined) {
    const type = d && typeof d === 'object' ? (d as { type?: unknown }).type : undefined
    return type === 'user' || type === 'assistant' ? type : null
  }
  return raw.indexOf(USER_LINE_LITERAL) >= 0 ? 'user' : null
}

function compactTrigger(v: unknown): CompactionRec['trigger'] {
  return v === 'manual' || v === 'auto' ? v : null
}

/**
 * A compaction (1.6 O3, §0a.10): of a `system` line of the `subtype` `compact_boundary`, its
 * `compactMetadata` block's `trigger` — `manual` or `auto` — and the context before and after it,
 * `preTokens` and `postTokens`, each through its allow-list, null when absent; with the line's
 * time. Never the segment it preserved, the messages it kept, the tools it had found, the tokens it
 * dropped or how long it took. Null for any other line.
 */
export function compactionOf(d: any, at: number): CompactionRec | null {
  if (d.type !== 'system' || d.subtype !== 'compact_boundary') return null
  const c = d.compactMetadata
  const plain = plainObject(c)
  return {
    at,
    trigger: plain ? compactTrigger(c.trigger) : null,
    preTokens: plain ? tokenFigure(c.preTokens) : null,
    postTokens: plain ? tokenFigure(c.postTokens) : null,
  }
}

/** A compaction as a snapshot carries it, every value checked as at ingest; null when its time is not one. */
function restoreCompaction(v: unknown): CompactionRec | null {
  if (!plainObject(v)) return null
  const at = finiteOrNull(v.at)
  if (at === null || at <= 0) return null
  return { at, trigger: compactTrigger(v.trigger), preTokens: tokenFigure(v.preTokens), postTokens: tokenFigure(v.postTokens) }
}

/** A Claude Code version as its lines write it: three dot-separated numbers of 1–3, 1–3 and 1–4 digits. */
const VERSION_RE = /^\d{1,3}\.\d{1,3}\.\d{1,4}$/

function versionValue(v: unknown): string | null {
  return typeof v === 'string' && VERSION_RE.test(v) ? v : null
}

/**
 * 1.6 O3 (§0a.8): the Claude Code version that wrote a transcript line — its top-level `version`,
 * `1.2.3`-shaped, else none. Nothing else of the line is read for it.
 */
export function versionOf(d: any): string | null {
  return versionValue(d.version)
}

/** The reasons a response's diagnostics may give for a cache miss (1.6 §0a.7) — every one Claude Code writes. */
const CACHE_MISS_KINDS: readonly CacheMissKind[] = [
  'previous_message_not_found', 'unavailable', 'messages_changed', 'model_changed', 'tools_changed', 'system_changed',
]

function cacheMissKind(v: unknown): CacheMissKind | null {
  return typeof v === 'string' && (CACHE_MISS_KINDS as readonly string[]).includes(v) ? v as CacheMissKind : null
}

/** Why a request's cache missed, and the input tokens the response says were not read from it. */
export interface CacheMiss {
  kind: CacheMissKind
  tokens: number | null
}

/**
 * 1.6 O3 (§0a.7): why the cache missed on a response of an agent's transcript — of the message's
 * `diagnostics`, its `cache_miss_reason`: the reason's `type`, one of six, and the
 * `cache_missed_input_tokens` it states (Claude Code gives the figure for a changed message, model,
 * tool set or system prompt). Nothing else of the diagnostics is read. Null for a response without
 * one, or with a reason outside the six.
 */
export function cacheMissOf(m: any): CacheMiss | null {
  const g = m.diagnostics
  if (!plainObject(g)) return null
  const x = g.cache_miss_reason
  if (!plainObject(x)) return null
  const kind = cacheMissKind(x.type)
  return kind === null ? null : { kind, tokens: tokenFigure(x.cache_missed_input_tokens) }
}

/** An agent's cache misses by reason as a snapshot carries them: known reasons with a whole count of at least 1. */
function restoreCacheMisses(v: unknown): Partial<Record<CacheMissKind, number>> {
  const out: Partial<Record<CacheMissKind, number>> = {}
  if (!plainObject(v)) return out
  for (const kind of CACHE_MISS_KINDS) {
    const n = v[kind]
    if (typeof n === 'number' && Number.isInteger(n) && n >= 1) out[kind] = n
  }
  return out
}

/**
 * What a line says beside its token figures, for the record that holds it: the effort it was
 * written at (N8, agents only), the Claude Code version that wrote it (O3), — on a message's
 * first line, in an agent's transcript — why the cache missed (O3), and the line's `stop_reason`
 * as it stands (1.8 §0a.5; a main session's `lastRequest` takes it through its allow-list).
 */
interface LineNotes {
  effort: Effort | null
  version: string | null
  miss: CacheMiss | null
  stop?: unknown
}

/**
 * 1.8 §0a.2 (A1 rule 2): a line of a main message onto its record's `lastRequest`. `firstAt` is the
 * message's first line's time (`PendingMessage.firstAt`), `v` its figures so far — each the running
 * maximum over its lines. A message is the record's newest request once any of its lines shows cache
 * tokens (`cacheWrite > 0 || cacheRead > 0`) and its first line is no older than the request kept: its
 * `at` is that first line's time, its TTL class `1h` when it wrote the 1-hour kind, `5m` when it wrote
 * the 5-minute kind only, and otherwise — a message that only read — the class of the write before it
 * (a read refreshes the entry it read); its size input + cache write + cache read + output, its model
 * through `cleanAgentName`, its stop reason the newest one a line of it states (§0a.5). A late line of
 * an older message changes nothing, and so does a message whose first line's time is not known — one
 * a 1.7 snapshot left open. The line is an assistant line: nothing of the reply is pending any more.
 */
function noteLastRequest(rec: MainRec, firstAt: unknown, v: TokenFigures, model: unknown, stop: unknown): void {
  if (!(v.cacheWrite > 0 || v.cacheRead > 0)) return
  if (typeof firstAt !== 'number' || !Number.isFinite(firstAt) || firstAt <= 0) return
  const prev = rec.lastRequest
  if (prev !== null && firstAt < prev.at) return
  const same = prev !== null && prev.at === firstAt
  const context = v.input + v.cacheWrite + v.cacheRead + v.output
  rec.lastRequest = {
    at: firstAt,
    ttl: v.cacheWrite1h > 0 ? '1h' : v.cacheWrite > 0 ? '5m' : prev?.ttl ?? null,
    context: same ? Math.max(prev.context, context) : context,
    model: cleanAgentName(model, AGENT_MODEL_MAX_CHARS) ?? (same ? prev.model : null),
    // A line that states no stop reason yet (a streamed block) keeps the one an earlier line of the
    // same message stated.
    stop: stop == null && same ? prev.stop : stopReasonOf(stop),
    replyPending: false,
  }
}

/**
 * 1.6 O3 (§0a.8): the version that wrote a record's newest line — the line is no older than the
 * record's last one; a late line of an older reply changes nothing, and a line without a version
 * keeps the one before.
 */
function noteVersion(rec: AgentRec | MainRec, at: number, version: string | null): void {
  if (version !== null && at >= rec.lastTs) rec.ccVersion = version
}

/** 1.6 O3 (§0a.7): a message's cache miss onto an agent's record — counted by reason, its stated tokens summed. */
function noteCacheMiss(rec: AgentRec | MainRec, miss: CacheMiss | null): void {
  if (miss === null || !('cacheMisses' in rec)) return
  rec.cacheMisses[miss.kind] = (rec.cacheMisses[miss.kind] ?? 0) + 1
  if (miss.tokens !== null) rec.cacheMissedTokens += miss.tokens
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

/**
 * What `countClaudeTools` found on one line: the calls it added to the message, and the name of
 * the line's last `tool_use` block (1.6 N5) — null for a name outside the tool names' alphabet,
 * `undefined` for a line without a tool call.
 */
interface ToolCalls {
  added: number
  last: string | null | undefined
}

/**
 * 1.6 N5 (§0a.5): a line's last tool call onto an agent record — the name and the line's time —
 * unless the record already holds a later one: the transcript's last call is what the tree names
 * when the agent went quiet after it. A main session's record keeps none.
 */
function noteLastTool(rec: AgentRec | MainRec, last: string | null | undefined, at: number): void {
  if (last === undefined || !('lastTool' in rec)) return
  if (rec.lastToolTs !== null && rec.lastToolTs > at) return
  rec.lastTool = last
  rec.lastToolTs = at
}

/**
 * What the newest line of an agent's transcript says of its reply, onto the agent's record — before
 * the line's time moves the record's (`touchRecord`): the reply's context — its input, cache write
 * and cache read so far, the running maximum over its lines (1.6 L2) — and the effort it was
 * written at (N8), while the line is no older than the record's last one; a late line of an older
 * reply changes neither. Every effort a reply carried joins the record's list in the order first
 * seen. A main session's record keeps neither.
 */
function noteNewest(rec: AgentRec | MainRec, at: number, context: number, effort: Effort | null): void {
  if (!('lastContext' in rec)) return
  const newest = at >= rec.lastTs
  if (newest) rec.lastContext = context
  if (effort === null) return
  if (newest) rec.effort = effort
  if (!rec.efforts.includes(effort) && rec.efforts.length < AGENT_EFFORTS_MAX) rec.efforts.push(effort)
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

/**
 * A counted reply at `at` answers the agent's last request: a rejection recorded at that time or
 * before it is no longer the transcript's last word (1.6 N3). A main session's record has none.
 */
function clearRejected(rec: AgentRec | MainRec, at: number): void {
  if ('rejected' in rec && rec.rejected !== null && at >= rec.rejected.at) rec.rejected = null
}

/** Whether a launch's outcome is an end — completed, failed or stopped — and not "launched". */
function isEnd(outcome: AgentLaunch['outcome']): outcome is RecordedOutcome {
  return outcome === 'completed' || outcome === 'failed' || outcome === 'stopped'
}

/** A launch's recorded result onto an agent record that has none yet, with the parent's word. */
function adoptOutcome(rec: AgentRec, launch: AgentLaunch): boolean {
  if (rec.outcome !== null || !isEnd(launch.outcome)) return false
  rec.outcome = launch.outcome
  rec.outcomeTs = launch.outcomeTs
  rec.outcomeStatus = launch.outcomeStatus
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
  // 1.6 (D7): a stop is recorded with the parent's word — the sentence quotes it — so a stop
  // without one is no outcome a snapshot can be trusted with; a completion or a failure written
  // before 1.6 has no word and keeps its outcome.
  const known = r.outcome === 'completed' || r.outcome === 'failed' || r.outcome === 'stopped' ? r.outcome : null
  const outcomeStatus = restoreStatus(r.outcomeStatus, known)
  const outcome = known === 'stopped' && outcomeStatus === null ? null : known
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
    outcome,
    // A stop dropped for want of its word takes its time along.
    outcomeTs: known !== outcome ? null : finiteOrNull(r.outcomeTs),
    outcomeStatus,
    rejected: restoreRejected(r.rejected),
    // 1.6 N5: the last tool call's name through the same alphabet as at ingest, and its time —
    // a name without its time names no moment the tree could compare, and is dropped with it.
    lastTool: finiteOrNull(r.lastToolTs) === null ? null : cleanAgentName(r.lastTool, TOOL_NAME_MAX_CHARS),
    lastToolTs: finiteOrNull(r.lastToolTs),
    // 1.6 N8, L2: the effort through its five levels, the list through the same, and the context
    // of the newest request a count — anything else is none.
    effort: effortLevel(r.effort),
    efforts: restoreEfforts(r.efforts),
    lastContext: typeof r.lastContext === 'number' && Number.isFinite(r.lastContext) && r.lastContext >= 0 ? r.lastContext : null,
    // 1.6 O3: counts as counts, the reasons of a cache miss through their six, the version and the
    // mode through their patterns, the last compaction as at ingest — anything else is none. A
    // snapshot from before 1.6 O3 has none of them, and the replay fills them in.
    toolErrors: typeof r.toolErrors === 'number' && Number.isInteger(r.toolErrors) && r.toolErrors >= 0 ? r.toolErrors : null,
    cacheMisses: restoreCacheMisses(r.cacheMisses),
    cacheMissedTokens: tokenFigure(r.cacheMissedTokens) ?? 0,
    ...restoreWriterFields(r),
  }
}

/** The O3 fields an agent's and a main session's record share, as a snapshot carries them. */
function restoreWriterFields(r: Record<string, unknown>): Pick<MainRec, 'ccVersion' | 'permissionMode' | 'compactions' | 'lastCompaction'> {
  return {
    ccVersion: versionValue(r.ccVersion),
    permissionMode: permissionModeValue(r.permissionMode),
    compactions: count(r.compactions),
    lastCompaction: restoreCompaction(r.lastCompaction),
  }
}

function restoreLaunch(v: unknown): AgentLaunch | null {
  if (!v || typeof v !== 'object') return null
  const r = v as Record<string, unknown>
  const toolUseId = cleanAgentId(r.toolUseId)
  const ts = finiteOrNull(r.ts)
  if (toolUseId === null || ts === null || typeof r.file !== 'string' || !r.file) return null
  const known = r.outcome === 'launched' || r.outcome === 'completed' || r.outcome === 'failed' || r.outcome === 'stopped'
    ? r.outcome : null
  // As for an agent record: a stop keeps its outcome only with the parent's word beside it.
  const outcomeStatus = restoreStatus(r.outcomeStatus, known)
  const outcome = known === 'stopped' && outcomeStatus === null ? null : known
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
    outcomeTs: known !== outcome ? null : finiteOrNull(r.outcomeTs),
    outcomeStatus,
    totals: totals
      ? reportedTotals({ totalTokens: totals.tokens, totalDurationMs: totals.durationMs, totalToolUseCount: totals.toolUses })
      : null,
  }
}

/** A run launch as a snapshot carries it (1.6 N4): the same checks as at ingest. */
function restoreRunLaunch(v: unknown): RunLaunch | null {
  if (!v || typeof v !== 'object') return null
  const r = v as Record<string, unknown>
  const toolUseId = cleanAgentId(r.toolUseId)
  const ts = finiteOrNull(r.ts)
  if (toolUseId === null || ts === null || typeof r.file !== 'string' || !r.file) return null
  const known = r.outcome === 'launched' || r.outcome === 'completed' || r.outcome === 'failed' || r.outcome === 'stopped'
    ? r.outcome : null
  // As for an agent's launch: a stop keeps its outcome only with the parent's word beside it.
  const outcomeStatus = restoreStatus(r.outcomeStatus, known)
  const outcome = known === 'stopped' && outcomeStatus === null ? null : known
  return {
    toolUseId,
    file: r.file,
    ts,
    runId: cleanRunId(r.runId),
    outcome,
    outcomeStatus,
    outcomeTs: known !== outcome ? null : finiteOrNull(r.outcomeTs),
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
    ...restoreWriterFields(r),
    lastRequest: restoreLastRequest(r.lastRequest),
    // 1.9 §0a.1: a time finite and above 0, else none — a 1.8 snapshot has none, and the revision 10
    // replay fills it for the transcripts already read.
    lastUserAt: typeof r.lastUserAt === 'number' && Number.isFinite(r.lastUserAt) && r.lastUserAt > 0 ? r.lastUserAt : null,
  }
}

/**
 * 1.8 §0a.2: a main session's newest cache-touching request, restored by shape — `at` finite and above
 * 0, `ttl` one of '5m', '1h' or null, `context` a finite count of at least 0, `replyPending` a boolean;
 * anything else restores no request at all (a 1.7 snapshot has none either). The model and the stop
 * reason go through the rules they are taken by at ingest: a model outside `cleanAgentName` and a
 * `stop_reason` outside its allow-list are null.
 */
function restoreLastRequest(v: unknown): LastRequest | null {
  if (!v || typeof v !== 'object') return null
  const r = v as Record<string, unknown>
  const at = r.at
  if (typeof at !== 'number' || !Number.isFinite(at) || at <= 0) return null
  const ttl = r.ttl
  if (ttl !== '5m' && ttl !== '1h' && ttl !== null) return null
  const context = r.context
  if (typeof context !== 'number' || !Number.isFinite(context) || context < 0) return null
  if (typeof r.replyPending !== 'boolean') return null
  return {
    at,
    ttl,
    context,
    model: cleanAgentName(r.model, AGENT_MODEL_MAX_CHARS),
    stop: stopReasonOf(r.stop),
    replyPending: r.replyPending,
  }
}

/** 1.8 §0a.3: the newest Codex turn, restored by shape — `at` finite and above 0, a model of the §0 alphabet — or none. */
function restoreCodexTurn(v: unknown): CodexTurn | null {
  if (!v || typeof v !== 'object') return null
  const r = v as Record<string, unknown>
  const at = r.at
  const model = cleanAgentName(r.model, AGENT_MODEL_MAX_CHARS)
  return typeof at === 'number' && Number.isFinite(at) && at > 0 && model !== null ? { at, model } : null
}

function count(v: unknown): number {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : 0
}

function restoreJournalAgent(v: unknown): JournalAgent | null {
  if (!v || typeof v !== 'object') return null
  const r = v as Record<string, unknown>
  const agentId = cleanAgentId(r.agentId)
  if (agentId === null) return null
  const supersededBy = cleanAgentId(r.supersededBy)
  const known = r.outcome === 'completed' || r.outcome === 'failed' || r.outcome === 'stopped' ? r.outcome : null
  return {
    agentId,
    step: count(r.step),
    attempt: typeof r.attempt === 'number' && Number.isInteger(r.attempt) && r.attempt >= 1 ? r.attempt : 1,
    // The journal's stop is a replacement: without the attempt that replaced it, it is none.
    outcome: known === 'stopped' && supersededBy === null ? null : known,
    supersededBy,
  }
}

function restoreRun(v: unknown): RunRec | null {
  if (!v || typeof v !== 'object') return null
  const r = v as Record<string, unknown>
  const workflowId = cleanAgentId(r.workflowId)
  const sessionId = typeof r.sessionId === 'string' ? clipId(r.sessionId) : ''
  if (r.source !== 'claude' || workflowId === null || sessionId === '') return null
  const agents: JournalAgent[] = []
  const seen = new Set<string>()
  for (const x of Array.isArray(r.agents) ? r.agents : []) {
    if (agents.length >= MAX_RUN_AGENTS) break
    const a = restoreJournalAgent(x)
    if (a && !seen.has(a.agentId)) {
      seen.add(a.agentId)
      agents.push(a)
    }
  }
  const lastTs = finiteOrNull(r.lastTs)
  return {
    source: 'claude',
    sessionId,
    workflowId,
    journalFile: typeof r.journalFile === 'string' && r.journalFile ? r.journalFile : null,
    agents,
    agentsDropped: count(r.agentsDropped),
    steps: count(r.steps),
    lastTs: lastTs !== null && lastTs > 0 ? lastTs : 0,
    // 1.6 L4: the run record's seven fields and the file's size and time, each checked as at the read.
    record: cleanRunRecord(r.record),
    recordStat: cleanRunRecordStat(r.recordStat),
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
 * Beside the counting, Claude lines feed five agent tables for the Agents section: one
 * record per agent transcript and per main session (the same dedupe as the buckets), the
 * launches of agents and of workflow runs a parent recorded, and the workflow runs as their
 * journals record them, with the seven fields of Claude Code's own record of each (1.6 L4). They
 * hold identifiers, times and counts — never a description, a prompt, a script, a result, a
 * journal's key or an API error's text.
 */
export class Aggregator {
  private buckets = new Map<string, Bucket>()
  private pending = new Map<string, PendingMessage>()
  private sessionMap = new Map<string, SessionRec>()
  /**
   * 1.14 §0a.6: the label table — per project key the newest line and, under `showProjectNames: basename`, the
   * folder's name (`Snapshot.projects`). Filled only while attribution is on; '' and OTHER_PROJECTS have entries
   * too, never a name.
   */
  private projectMap = new Map<string, ProjectLabel>()
  /** Agent transcripts, keyed by path. */
  private agentMap = new Map<string, AgentRec>()
  /** Agent launches, keyed by tool_use id. */
  private launchMap = new Map<string, AgentLaunch>()
  /** `Workflow` tool calls — the launches of workflow runs (1.6 N4) — keyed by tool_use id. */
  private runLaunchMap = new Map<string, RunLaunch>()
  /** Main Claude sessions, keyed by path: the tree's roots, kept whatever `attribution` says. */
  private mainMap = new Map<string, MainRec>()
  /** Workflow runs as their journals record them, keyed `${sessionId}|${workflowId}`. */
  private runMap = new Map<string, RunRec>()
  /** A run's journal agents by id, derived from `runMap` (rebuilt on restore). */
  private runAgentIndex = new Map<string, Map<string, JournalAgent>>()
  /**
   * The journal keys, per journal file: key → the step's ordinal and the agent of its latest
   * attempt. The only place a key lives (§0a.1): it is compared with the keys of the same
   * journal to tell a step started again from a new one, and never reaches a record, the
   * snapshot, a view, an export or the log. Not persisted: a journal's map is rebuilt from the
   * file up to its cursor before the file is read on (`rebuildJournal` in scan.ts). An entry —
   * possibly empty — means "in memory".
   */
  private journalSteps = new Map<string, Map<string, { step: number; lastAgent: string }>>()
  /** Journal lines skipped as too long to parse without a head — a count, never a line. */
  journalSkipped = 0
  /**
   * 1.6 O3 (§0a.9): the permission mode a transcript's prompt line named before the transcript had
   * a record — its first counted reply makes one and takes the mode from here (`agentFor`,
   * `mainFor`). By path, at most PENDING_MODE_MAX, oldest dropped; not persisted: a restart between
   * the prompt line and the first reply reads on past the line, and the record goes without the mode
   * until the transcript's next prompt names one — or a replay reads the line again.
   */
  private pendingMode = new Map<string, PermissionMode>()
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
  /** Which revision of the agent tables the replay last built (AGENT_TABLES_REVISION); persisted. */
  private agentsRevisionValue = 0
  /** 1.8 §0a.3: the newest counted turn of a non-forked Codex rollout; persisted (`Snapshot.codexLast`). */
  private codexLastValue: CodexTurn | null = null
  /** 1.6 L5: what was written since `takeChanges` was last asked. Not persisted. */
  private changes: IngestChanges = { buckets: false, agents: false }
  /**
   * dayOfHour goes through Intl and is hit for every bucket on every query — memoised. The answer
   * depends on the hour and on the two fields of the time config that decide where a day begins, so
   * the memo holds the answers of one zone and one boundary hour, and the two are kept as they are
   * and compared field by field (1.9 L-7: with a key string built for every bucket asked about, this
   * function took 28 % of a view-model build's time in Europe/Berlin; 3 % without).
   */
  private dayMemoZone: Zone | null = null
  private dayMemoBoundary: number | null = null
  private dayMemo = new Map<number, string>()

  // ---------------------------------------------------------------- Buckets

  private dayOfHourMemo(hour: number, cfg: TimeConfig): string {
    if (cfg.zone !== this.dayMemoZone || cfg.dayBoundaryHour !== this.dayMemoBoundary) {
      this.dayMemoZone = cfg.zone
      this.dayMemoBoundary = cfg.dayBoundaryHour
      this.dayMemo.clear()
    }
    let d = this.dayMemo.get(hour)
    if (d === undefined) {
      d = dayOfHour(hour, cfg)
      this.dayMemo.set(hour, d)
    }
    return d
  }

  private get(
    source: Source, res: Resolution, hour: number | null, day: string, model: string, isSub: boolean, tier: Tier, project?: string,
  ): Bucket {
    const k = bucketKey({ source, res, hour, day, model, isSub, tier, project })
    let b = this.buckets.get(k)
    if (!b) {
      b = emptyBucket(source, model, isSub, tier, res, hour, day, project)
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
  bucketFor(source: Source, hour: number, day: string, model: string, isSub: boolean, tier: Tier, project?: string): Bucket {
    // Asked for by the counting alone — every ingest that adds to a bucket gets it here (1.6 L5).
    this.changes.buckets = true
    const hh = this.hourHorizon()
    if (hh === null || hour >= hh) return this.get(source, 'h', hour, day, model, isSub, tier, project)
    const rolledDay = this.dayOfHourMemo(hour, this.timeConfig)
    const dh = this.dayHorizon()
    // 1.14 §3 A2 rule 3: a late line takes its project into the day or month that holds its hour.
    if (dh === null || rolledDay >= dh) return this.get(source, 'd', null, rolledDay, model, isSub, tier, project)
    return this.get(source, 'm', null, monthOf(rolledDay), model, isSub, tier, project)
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
    source: Source, sessionId: string, project: string, isSub: boolean, parent: string | null, ts: number,
  ): SessionRec {
    return {
      source, sessionId, project,
      isSub, parent,
      firstTs: ts, lastTs: ts,
      models: [],
      input: 0, cacheWrite: 0, cacheWrite1h: 0, cacheRead: 0, output: 0, reasoning: 0,
      requests: 0, outputFinal: 0,
      lastCacheTtl: null, lastCacheWriteTs: null,
      turnGapsMs: [],
    }
  }

  // --------------------------------------------------------------- Projects

  /**
   * 1.14 §3 A2 rule 2: a line of project `key` — `lastTs` the newest, a name only when the table has none yet (the
   * first name it gets is kept); '' and OTHER_PROJECTS never take a name.
   */
  private noteProject(key: string, ts: number | null, name: string | null): void {
    let label = this.projectMap.get(key)
    if (!label) {
      label = { lastTs: 0 }
      this.projectMap.set(key, label)
    }
    if (ts !== null && Number.isFinite(ts) && ts > label.lastTs) label.lastTs = ts
    if (name !== null && label.name === undefined && key !== UNATTRIBUTED && key !== OTHER_PROJECTS) label.name = name
  }

  /**
   * §0a.1: the key of a Claude transcript, hashed once per file — kept on its cursor (never the segment, which is
   * dropped after the call); a line without a cursor (a test's) is hashed each time.
   */
  private claudeKeyFor(place: ClaudePlacement, ctx: IngestContext, cur: Cursor | undefined): string {
    if (cur && cur.project !== undefined) return cur.project
    const key = claudeProjectOf(place, ctx)
    if (cur) cur.project = key
    return key
  }

  /** 1.14 §0a.6: the label table, a copy — per project key the newest line and, with names on, the folder's name. */
  projects(): Record<string, ProjectLabel> {
    const out: Record<string, ProjectLabel> = {}
    for (const [k, v] of this.projectMap) out[k] = { ...v }
    return out
  }

  /**
   * What a view prints for a project key (project.ts `projectLabel`): the folder's name when the table holds one —
   * it holds names only under `showProjectNames: basename` —, else `p:` + the key; `(no project)`, `other projects`.
   */
  projectLabelOf(key: string): string {
    const label = this.projectMap.get(key)
    return projectLabel(key, label ? { [key]: label } : {}, true)
  }

  /** §3 A7: `showProjectNames` switched to hash — every name leaves the label table at once, no re-read. */
  dropProjectNames(): void {
    for (const label of this.projectMap.values()) delete label.name
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
    // The tool table is one of the tables the whole view model reads, as the buckets are (1.6 L5).
    this.changes.buckets = true
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
   *
   * 1.6 N5 (§0a.5): it also says which tool the line called last — the name of its last
   * `tool_use` block, through the tool names' alphabet (`cleanAgentName`, at most
   * TOOL_NAME_MAX_CHARS), null for a name that does not fit it, and `undefined` for a line that
   * calls none — for the agent record, which keeps the transcript's last call and its time. Of a
   * block only its `type`, `name` and `id` are named; its `input` is never looked at.
   */
  private countClaudeTools(p: PendingMessage, content: unknown, toTable = true): ToolCalls {
    if (!Array.isArray(content)) return { added: 0, last: undefined }
    let added = 0
    let last: string | null | undefined
    const counts = new Map<string, number>()
    for (const c of content) {
      if (!c || typeof c !== 'object') continue
      const b = c as { type?: unknown; name?: unknown; id?: unknown }
      // Only real tool calls: a `server_tool_use` block is already counted as webSearch /
      // webFetch on the bucket, and listing it here would report the same call twice.
      if (b.type !== 'tool_use') continue
      last = cleanAgentName(b.name, TOOL_NAME_MAX_CHARS)
      const name = str(b.name)
      if (!name) continue
      const id = str(b.id)
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
    if (counts.size === 0) return { added, last }
    const tools = p.tools ?? (p.tools = {})
    for (const [name, cand] of counts) {
      const prev = tools[name] ?? 0
      if (cand <= prev) continue
      tools[name] = cand
      if (toTable) this.addTool('claude', p.day, p.model, name, cand - prev)
      added += cand - prev
    }
    return { added, last }
  }

  // ---------------------------------------------------------------- Claude

  /**
   * Processes one line of a Claude transcript. Returns true when anything changed: a counted
   * response, or an agent's record — a launch, a result, a notification.
   */
  addClaudeLine(raw: string, ctx: IngestContext): boolean {
    // 1.6 O3: what is counted on the raw line, before — and for most lines instead of — a parse: the
    // tool results marked as errors (§0a.6) and a prompt line's permission mode (§0a.9).
    let changed = this.rawGates(raw, ctx)
    // A compaction's line is recognised on the raw line too, and then parsed (§0a.10); the line
    // holding a compaction's summary never is, whatever it mentions.
    const compaction = raw.indexOf(COMPACT_BOUNDARY_LITERAL) >= 0
    // `undefined` while the line is not parsed; null for one that does not parse.
    let d: any
    if (raw.indexOf(COMPACT_SUMMARY_LITERAL) < 0 && (compaction || worthParsing(raw))) {
      try { d = JSON.parse(raw) } catch { d = null }
      if (d && typeof d === 'object') {
        const noted = d.type === 'assistant' ? this.claudeResponse(d, ctx)
          : d.type === 'user' ? this.agentResult(d, ctx)
            : d.type === 'queue-operation' ? this.agentNotification(d)
              : d.type === 'system' && compaction ? this.noteCompaction(d, ctx)
                : false
        changed = noted || changed
      }
    }
    // 1.8 §0a.5: whether the main transcript's newest message line is the user's.
    // 1.9 §0a.1: a user line's time, too — matched on the raw line, never parsed for it.
    if (!ctx.isSub) changed = this.noteMessageKind(ctx.file, messageKindOf(raw, d), raw) || changed
    // 1.6 L5: a Claude line that changed anything reached an agent table — the record of the
    // transcript it is in (an agent's, or the main session's the tree roots on), a launch, a run's
    // launch or an outcome. Its buckets, where it has any, mark themselves (`bucketFor`).
    if (changed) this.changes.agents = true
    return changed
  }

  /**
   * 1.8 §0a.5 (probe P-6): the kind of a main transcript's newest message line onto its record's
   * `lastRequest` — a user line (a prompt or a tool result) sets `replyPending`, an assistant line (any
   * reply, an error line and a placeholder included) clears it; every other line leaves it. Lines are
   * taken in the order the file holds them, so the flag is the newest line's. A record without a
   * request that touched the cache has no flag to set. 1.9 §0a.1: a user line also raises the record's
   * `lastUserAt` to the line's time (`userLineTimeOf` on the raw line) — whether or not the record has a
   * request of the cache; an older time never lowers it, and a line without one leaves it. A user line
   * before the transcript's first counted reply finds no record and sets nothing. True when the flag or
   * the time changed.
   */
  private noteMessageKind(file: string, kind: 'user' | 'assistant' | null, raw: string): boolean {
    if (kind === null) return false
    const rec = this.mainMap.get(file)
    if (!rec) return false
    let changed = false
    if (kind === 'user') {
      const at = userLineTimeOf(raw)
      if (at !== null && (rec.lastUserAt === null || !(at <= rec.lastUserAt))) {
        rec.lastUserAt = at
        changed = true
      }
    }
    const last = rec.lastRequest
    if (!last) return changed
    const pending = kind === 'user'
    if (last.replyPending === pending) return changed
    last.replyPending = pending
    return true
  }

  /**
   * 1.6 O3: the two raw-line gates. In an agent's transcript, every `"is_error":true` is a tool
   * result marked as an error (§0a.6), added to the agent's record — a tool result answers a call of
   * a reply that came before it, so the record is there; one before the transcript's first counted
   * reply is not counted. In any Claude transcript, a permission mode (§0a.9) goes to the record, or
   * waits for it in `pendingMode`. Neither line is parsed for it. True when a record changed.
   */
  private rawGates(raw: string, ctx: IngestContext): boolean {
    let changed = false
    if (ctx.isSub) {
      const errors = toolErrorsOf(raw)
      const rec = errors > 0 ? this.agentMap.get(ctx.file) : undefined
      // A record that does not count them (restored from before O3) is left as it is.
      if (rec && rec.toolErrors !== null) {
        rec.toolErrors += errors
        changed = true
      }
    }
    const mode = permissionModeOf(raw)
    if (mode !== null) changed = this.notePermissionMode(ctx, mode) || changed
    return changed
  }

  /**
   * A permission mode onto the transcript's record — a later one overwrites — or, before the record
   * exists, into `pendingMode` for it: the prompt line that names the mode comes before the first
   * counted reply. Below `subagents` only an agent transcript is remembered.
   */
  private notePermissionMode(ctx: IngestContext, mode: PermissionMode): boolean {
    const rec = ctx.isSub ? this.agentMap.get(ctx.file) : this.mainMap.get(ctx.file)
    if (rec) {
      if (rec.permissionMode === mode) return false
      rec.permissionMode = mode
      return true
    }
    if (ctx.isSub && !AGENT_FILE_RE.test(path.basename(ctx.file))) return false
    this.pendingMode.delete(ctx.file)
    this.pendingMode.set(ctx.file, mode)
    if (this.pendingMode.size > PENDING_MODE_MAX) {
      const oldest = this.pendingMode.keys().next()
      if (!oldest.done) this.pendingMode.delete(oldest.value)
    }
    return false
  }

  /** The permission mode waiting for a record that is being made now, taken out of `pendingMode`. */
  private takePendingMode(file: string): PermissionMode | null {
    const mode = this.pendingMode.get(file)
    if (mode === undefined) return null
    this.pendingMode.delete(file)
    return mode
  }

  /**
   * A compaction line (§0a.10) onto its transcript's record: counted, and kept when it is the latest.
   * A transcript compacts after replies it counted, so the record is there; a compaction before the
   * first counted reply (not observed) is not counted.
   */
  private noteCompaction(d: any, ctx: IngestContext): boolean {
    const at = lineTime(d)
    const c = at === null ? null : compactionOf(d, at)
    if (c === null) return false
    const rec = ctx.isSub ? this.agentMap.get(ctx.file) : this.mainMap.get(ctx.file)
    if (!rec) return false
    rec.compactions += 1
    if (rec.lastCompaction === null || c.at >= rec.lastCompaction.at) rec.lastCompaction = c
    return true
  }

  /** One assistant line: its tokens onto buckets, session and agent tables, and its launches. */
  private claudeResponse(d: any, ctx: IngestContext): boolean {
    const m = d.message
    if (!m || typeof m !== 'object') return false
    const parsed = Date.parse(d.timestamp ?? '')
    // The agent tables take a line's own time or nothing: a record dated "now" would show an
    // agent that finished last week as running. The buckets keep the fallback they always had.
    const at = Number.isFinite(parsed) ? parsed : null
    // Placeholder and error lines carry all-zero usage and would only inflate the request count.
    // In an agent's transcript an error line is a request the API rejected (1.6 N3, §0a.2): the
    // agent's record keeps what `rejectedOf` reads of it, and nothing is counted. A main
    // transcript's error lines stay skipped.
    if (d.isApiErrorMessage) {
      return d.isApiErrorMessage === true && ctx.isSub && at !== null
        ? this.noteRejected(ctx.file, at, rejectedOf(d), versionOf(d)) : false
    }
    if (m.model === '<synthetic>') return false
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
    // 1.6 N8 (§0a.4): an agent's transcript only — no main session's record carries an effort.
    // 1.6 O3 (§0a.8): the Claude Code version that wrote the line, for either kind of record.
    const notes: LineNotes = { effort: isSub ? effortOf(d) : null, version: versionOf(d), miss: null }
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

    // 1.14 §0a.1: with attribution on, the key of the folder the transcript lies under — on every bucket its
    // lines open, in the label table and on the session record; a main line may name the folder (§0a.2).
    const attributed = !replay && ctx.attribution !== 'none'
    const place = attributed ? claudePlacement(ctx.file, isSub) : null
    const project = place ? this.claudeKeyFor(place, ctx, cur) : undefined
    if (place && project !== undefined) this.noteProject(project, ts, claudeProjectName(d, place.slug, ctx))

    const prev = pending.get(id)
    if (!prev) {
      const tier = tierOf(u.speed, u.inference_geo)
      const p: PendingMessage = { hour, day, model, isSub, tier, ...cand, final }
      if (project !== undefined) p.project = project
      const tools = this.countClaudeTools(p, m.content, !replay)
      if (!replay) {
        const b = this.bucketFor('claude', hour, day, model, isSub, tier, project)
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

      if (place && project !== undefined) {
        const s = this.sessionFor(ctx.file, ctx, () => this.newSession(
          'claude', claudeSessionOf(d, ctx.file), project, isSub, place.parent, ts,
        ))
        // A record folded into other projects (§3 A3) takes its folder's key back with its next line.
        s.project = project
        if (cur) cur.sessionId = s.sessionId
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
        p.session = ctx.file
      }

      // 1.6 O3 (§0a.7): why the cache missed, on a message's first line only — its later lines repeat it.
      if (isSub) notes.miss = cacheMissOf(m)
      // 1.8 §0a.2: a main message remembers when its first line came — the request's time.
      else if (at !== null) p.firstAt = at
      notes.stop = m.stop_reason
      if (at !== null) this.creditMessage(p, cand, final, tools, at, m.model, notes, ctx)
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
      // rolled-up bucket — and, with attribution on, by the project its first line opened (1.14 §3 A2 rule 1). A
      // message restored without one (a snapshot edited by hand) grows the unattributed bucket.
      const b = this.bucketFor('claude', prev.hour, prev.day, prev.model, prev.isSub, prev.tier,
        attributed ? prev.project ?? UNATTRIBUTED : undefined)
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
    }

    notes.stop = m.stop_reason
    this.creditGrowth(prev, delta, next, newlyFinal, tools, at, m.model, notes, ctx)

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
    p: PendingMessage, v: TokenFigures, final: boolean, tools: ToolCalls, at: number, model: unknown,
    notes: LineNotes, ctx: IngestContext,
  ): void {
    const rec = ctx.isSub ? this.agentFor(ctx.file, at) : this.mainFor(ctx.file, at)
    if (!rec) return
    noteNewest(rec, at, v.input + v.cacheWrite + v.cacheRead, notes.effort)
    noteVersion(rec, at, notes.version)
    noteCacheMiss(rec, notes.miss)
    creditTokens(rec, v)
    rec.requests += 1
    if (final) rec.outputFinal += 1
    rec.toolCalls += tools.added
    touchRecord(rec, at, model)
    clearRejected(rec, at)
    noteLastTool(rec, tools.last, at)
    if (ctx.isSub) p.agent = ownerKey(ctx.file)
    else {
      p.main = ownerKey(ctx.file)
      noteLastRequest(rec as MainRec, p.firstAt, v, model, notes.stop)
    }
  }

  /**
   * A later line of a known message: its growth onto the record that holds the message. An
   * open message from before the agent tables (a version 6 snapshot) names no record; its next
   * line links it to this file and credits the growth from there on — the part before is the
   * replay's to rebuild, and crediting it here as well would count it twice. `totals` are the
   * message's figures with this line, each the running maximum over its lines: its input, cache
   * write and cache read are the context an agent's record keeps (1.6 L2), and all of them with its
   * output the size a main session's `lastRequest` keeps (1.8 §0a.2).
   */
  private creditGrowth(
    p: PendingMessage, v: TokenFigures, totals: TokenFigures, newlyFinal: boolean, tools: ToolCalls, at: number | null,
    model: unknown, notes: LineNotes, ctx: IngestContext,
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
    if (at !== null) {
      noteNewest(rec, at, totals.input + totals.cacheWrite + totals.cacheRead, notes.effort)
      noteVersion(rec, at, notes.version)
    }
    creditTokens(rec, v)
    if (newlyFinal) rec.outputFinal += 1
    rec.toolCalls += tools.added
    if (at !== null) {
      touchRecord(rec, at, model)
      clearRejected(rec, at)
      noteLastTool(rec, tools.last, at)
    }
    if (!ctx.isSub) noteLastRequest(rec as MainRec, p.firstAt, totals, model, notes.stop)
  }

  /**
   * A request the API rejected, in an agent's transcript (1.6 N3, §0a.2): the agent's last
   * rejection, with the error line's time — the latest one, and only while no counted reply of
   * the transcript is later (a counted reply clears it, `clearRejected`). A transcript of nothing
   * but rejections gets its record from its first one (1.6 D4): with no request, no token and no
   * reply counted, its first and last time that line's — the agent was started, and the tree
   * counts it among its run's agents without a counted reply. True when the record changed.
   */
  private noteRejected(file: string, at: number, r: Omit<RejectedRequest, 'at'>, version: string | null): boolean {
    const rec = this.agentFor(file, at)
    if (!rec || at < rec.lastTs) return false
    const prev = rec.rejected
    if (prev !== null) {
      if (prev.at > at) return false
      if (prev.at === at && prev.status === r.status && prev.error === r.error && prev.limit === r.limit) return false
    }
    rec.rejected = { at, status: r.status, error: r.error, limit: r.limit }
    // 1.6 O3 (§0a.8): the error line is the transcript's newest, and Claude Code wrote it too.
    if (version !== null) rec.ccVersion = version
    return true
  }

  /**
   * The record of an agent transcript, made by its first counted line — or by its first rejected
   * request, when that comes first (1.6 D4): its identity from the
   * file name, its session and workflow run from where it sits (`claudePlacement`). Null for a
   * file below `subagents` that is no agent transcript. What the parent recorded before the
   * transcript came in joins it here; the workflow journal's view stays with the run (`runMap`)
   * and is joined by the tree at view time.
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
      outcomeStatus: kept?.outcomeStatus ?? null,
      // The transcript's own lines say it again: a replay reads its rejections anew, its tool calls,
      // its efforts and its newest request's context.
      rejected: null,
      lastTool: null,
      lastToolTs: null,
      effort: null,
      efforts: [],
      lastContext: null,
      // 1.6 O3: counted from the transcript's own lines, as a replay reads them again; the permission
      // mode its prompt line named before this first counted reply, when there was one.
      toolErrors: 0,
      cacheMisses: {},
      cacheMissedTokens: 0,
      ccVersion: null,
      permissionMode: this.takePendingMode(file),
      compactions: 0,
      lastCompaction: null,
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
        // 1.6 O3: the permission mode the session's prompt line named before its first counted reply.
        ccVersion: null,
        permissionMode: this.takePendingMode(file),
        compactions: 0,
        lastCompaction: null,
        // 1.8 §0a.2: set by the first line that touches the cache — this one or a later one.
        lastRequest: null,
        // 1.9 §0a.1: set by the first user line after this one; a prompt before it found no record.
        lastUserAt: null,
      }
      this.mainMap.set(file, rec)
    }
    return rec
  }

  /**
   * The agent launches on one assistant line: `tool_use` blocks named `Agent` (or `Task`, as
   * older builds call it). A streamed message repeats its block on later lines, so a launch is
   * made once, by the first. Three fields of the input are read and no more — its description
   * and prompt are content. A block named `Workflow` launches a workflow run (1.6 N4, §0a.3): of
   * it only the `id` is read — its input, which holds the workflow's script, is never touched.
   */
  private noteLaunches(content: unknown, at: number, ctx: IngestContext): boolean {
    if (!Array.isArray(content)) return false
    let changed = false
    for (const c of content) {
      if (!c || typeof c !== 'object') continue
      const block = c as { type?: unknown; name?: unknown; id?: unknown; input?: unknown }
      if (block.type !== 'tool_use') continue
      if (block.name === 'Workflow') {
        if (this.noteRunLaunch(cleanAgentId(block.id), at, ctx)) changed = true
        continue
      }
      if (block.name !== 'Agent' && block.name !== 'Task') continue
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
        outcomeStatus: null,
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
   * A `Workflow` tool call: a run launch, made once by the first line that carries the block —
   * its id, the transcript and the line's time, nothing else. Which run it launched the tool
   * result says (`runResult`).
   */
  private noteRunLaunch(toolUseId: string | null, at: number, ctx: IngestContext): boolean {
    if (toolUseId === null || this.runLaunchMap.has(toolUseId)) return false
    this.runLaunchMap.set(toolUseId, {
      toolUseId, file: ctx.file, ts: at, runId: null, outcome: null, outcomeStatus: null, outcomeTs: null,
    })
    return true
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
    // A result that names no agent may answer a `Workflow` call (1.6 N4).
    if (agentId === null) return this.runResult(d, r, ctx)
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
        background: status === 'async_launched', outcome: null, outcomeTs: null, outcomeStatus: null, totals: null,
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
    const news = launchOutcome(status)
    if (news) changed = this.applyOutcome(launch, news, at, news.outcome === 'completed' ? reportedTotals(r) : null) || changed
    return this.propagateOutcome(launch) || changed
  }

  /**
   * The tool result that answers a `Workflow` call (1.6 N4, §0a.3): the run it launched and how it
   * went. Two fields of the result are read — `runId`, through its allow-list, and `status`, by
   * the same map as an agent's — and never its `summary`, `scriptPath`, `transcriptDir` (a path),
   * `workflowName`, `taskId` or `taskType`. The tool_use id comes from the message's own
   * `tool_result` block; a result whose call was not read stands in for it, as for an agent.
   */
  private runResult(d: any, r: any, ctx: IngestContext): boolean {
    const runId = cleanRunId(r.runId)
    if (runId === null) return false
    const toolUseId = toolResultId(d.message)
    if (toolUseId === null) return false
    const at = lineTime(d)
    let changed = false
    let launch = this.runLaunchMap.get(toolUseId)
    if (!launch) {
      if (at === null) return false
      launch = { toolUseId, file: ctx.file, ts: at, runId: null, outcome: null, outcomeStatus: null, outcomeTs: null }
      this.runLaunchMap.set(toolUseId, launch)
      changed = true
    }
    if (launch.runId !== runId) {
      launch.runId = runId
      changed = true
    }
    const news = launchOutcome(r.status)
    return (news !== undefined && applyEnd(launch, news, at)) || changed
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
    // A workflow run's end arrives the same way, for its `Workflow` call (1.6 N4).
    const runLaunch = id && !launch ? this.runLaunchMap.get(id[1]) : undefined
    if (!launch && !runLaunch) return false
    const status = NOTE_STATUS_RE.exec(text)
    const news = status ? launchOutcome(status[1]) : undefined
    if (!news) return false
    if (runLaunch) return applyEnd(runLaunch, news, lineTime(d))
    if (!launch) return false
    const changed = this.applyOutcome(launch, news, lineTime(d), null)
    return this.propagateOutcome(launch) || changed
  }

  /**
   * An outcome onto an agent's launch, by the rules of `applyEnd`, and the parent's report of a
   * finished sync agent with it.
   */
  private applyOutcome(launch: AgentLaunch, news: LaunchNews, at: number | null, totals: AgentLaunch['totals']): boolean {
    let changed = applyEnd(launch, news, at)
    if (news.outcome === 'launched') return changed
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
    if (isEnd(launch.outcome)
      && (rec.outcome !== launch.outcome || rec.outcomeTs !== launch.outcomeTs || rec.outcomeStatus !== launch.outcomeStatus)) {
      rec.outcome = launch.outcome
      rec.outcomeTs = launch.outcomeTs
      rec.outcomeStatus = launch.outcomeStatus
      changed = true
    }
    if (rec.spawnerFile === null) {
      rec.spawnerFile = launch.file
      changed = true
    }
    return changed
  }

  /**
   * One line of a workflow's `journal.jsonl` (1.6 §0a.1, D2, D7). Three fields are read — `type`,
   * `key` and `agentId`, through the anchored head (`JOURNAL_HEAD_RE`) — and never the agent's
   * `result`, the step's `label` or its `phase`. A `started` line makes the agent a member of its
   * run: a step's first start is attempt 1, and a start of a step already seen supersedes the
   * attempt before — a previous attempt without an outcome of its own was replaced (`stopped`).
   * `result` records the agent as completed, `failed` as failed; the later line wins. `launched`
   * carries only its type and changes nothing. Journal lines carry no time: the run keeps the
   * journal's mtime instead (`noteJournalRead`). The key is compared within this journal and kept
   * nowhere but `journalSteps`.
   */
  addWorkflowJournalLine(raw: string, ctx: IngestContext): boolean {
    const place = claudePlacement(ctx.file, true)
    const workflowId = cleanAgentId(place.workflowId)
    const sessionId = place.parent === null ? '' : clipId(place.parent)
    if (workflowId === null || sessionId === '') return false
    // The journal's step map is in memory from its first line on, whatever the line says — so a
    // journal whose lines carry no key is not read again for its keys on every tail.
    let steps = this.journalSteps.get(ctx.file)
    if (!steps) {
      steps = new Map()
      this.journalSteps.set(ctx.file, steps)
    }
    const head = journalHead(raw)
    if (head === 'skip') {
      this.journalSkipped++
      return false
    }
    if (head === null || head.type === 'launched' || head.agentId === null) return false
    const runKey = `${sessionId}|${workflowId}`
    let run = this.runMap.get(runKey)
    if (!run) {
      run = {
        source: 'claude', sessionId, workflowId, journalFile: ctx.file, agents: [], agentsDropped: 0, steps: 0, lastTs: 0,
        record: null, recordStat: null,
      }
      this.runMap.set(runKey, run)
      this.changes.agents = true
    }
    run.journalFile = ctx.file
    const index = this.runIndex(runKey, run)
    if (head.type === 'started') {
      const started = this.journalStarted(run, index, steps, head.key, head.agentId)
      if (started) this.changes.agents = true
      return started
    }
    let agent = index.get(head.agentId)
    if (!agent) {
      // Never observed: an end for an agent the journal did not start. Taken as its start — unless
      // the run is full, where it may be one of the agents counted and not listed.
      if (run.agents.length >= MAX_RUN_AGENTS) return false
      if (this.journalStarted(run, index, steps, head.key, head.agentId)) this.changes.agents = true
      agent = index.get(head.agentId)
      if (!agent) return false
    }
    const outcome = head.type === 'result' ? 'completed' : 'failed'
    if (agent.outcome === outcome) return false
    agent.outcome = outcome
    this.changes.agents = true
    return true
  }

  /**
   * A `started` line: the agent joins its run as the next attempt of its step. The attempt before
   * it — the step's latest — is superseded by it, and one that recorded nothing was replaced
   * (D7). A line without a key is step 0, which has no attempts to compare. An agent the run
   * already lists is a line read again and changes nothing; beyond MAX_RUN_AGENTS a start is
   * counted, not listed — it still supersedes the attempt before it.
   */
  private journalStarted(
    run: RunRec, index: Map<string, JournalAgent>, steps: Map<string, { step: number; lastAgent: string }>,
    key: string | null, agentId: string,
  ): boolean {
    if (index.has(agentId)) return false
    let step = 0
    let attempt = 1
    if (key !== null) {
      const seen = steps.get(key)
      if (seen) {
        step = seen.step
        const prev = index.get(seen.lastAgent)
        if (prev) {
          attempt = prev.attempt + 1
          if (prev.outcome === null) prev.outcome = 'stopped'
          prev.supersededBy = agentId
        }
        seen.lastAgent = agentId
      } else {
        // The run's own count, not the map's size: a map that was not rebuilt (a caller that
        // skipped `rebuildJournal`) must not hand out an ordinal the run already uses.
        step = ++run.steps
        steps.set(key, { step, lastAgent: agentId })
      }
    }
    if (run.agents.length >= MAX_RUN_AGENTS) {
      run.agentsDropped++
      return true
    }
    const agent: JournalAgent = { agentId, step, attempt, outcome: null, supersededBy: null }
    run.agents.push(agent)
    index.set(agentId, agent)
    return true
  }

  /** A run's journal agents by id, made on first use. */
  private runIndex(runKey: string, run: RunRec): Map<string, JournalAgent> {
    let index = this.runAgentIndex.get(runKey)
    if (!index) {
      index = new Map(run.agents.map((a) => [a.agentId, a]))
      this.runAgentIndex.set(runKey, index)
    }
    return index
  }

  /** The run a journal file belongs to, by where it sits; its key and record, or null. */
  private runOfJournal(file: string): { key: string; run: RunRec | undefined } | null {
    const place = claudePlacement(file, true)
    const workflowId = cleanAgentId(place.workflowId)
    if (workflowId === null || place.parent === null) return null
    const key = `${clipId(place.parent)}|${workflowId}`
    return { key, run: this.runMap.get(key) }
  }

  /**
   * After a read of a journal: its modification time is the run's last activity, as the
   * journal's lines carry no time of their own. `readNewLines` sets the cursor's mtime only after
   * the lines, so the reader hands it over here (scan.ts, the replay and the rebuild pass alike).
   */
  noteJournalRead(file: string, mtime: number | undefined): void {
    if (typeof mtime !== 'number' || !Number.isFinite(mtime) || mtime <= 0) return
    const run = this.runOfJournal(file)?.run
    if (run && run.lastTs !== mtime) {
      run.lastTs = mtime
      this.changes.agents = true
    }
  }

  /** Whether a journal's step map is in memory — made by its first line, a rebuild or a reset. */
  journalInMemory(file: string): boolean {
    return this.journalSteps.has(file)
  }

  /**
   * 1.6 L4 (§0a.12): what Claude Code's run record gave a run the tables keep — its seven fields,
   * checked again here, so a caller cannot put into the table what the reader would not have, and the
   * file's size and modification time, by which the next pass decides whether to read it again —, or
   * `null` for no record file. A run the tables do not keep (no journal line made it, or the roll-up
   * dropped it) takes nothing. True when the run changed; the tree is told only when the fields did.
   */
  setRunRecord(sessionId: string, workflowId: string, read: { fields: unknown; stat: unknown } | null): boolean {
    const run = this.runMap.get(`${clipId(sessionId)}|${workflowId}`)
    if (!run) return false
    const record = read === null ? null : cleanRunRecord(read.fields)
    const stat = read === null ? null : cleanRunRecordStat(read.stat)
    const fieldsChanged = JSON.stringify(run.record) !== JSON.stringify(record)
    if (!fieldsChanged && sameStat(run.recordStat, stat)) return false
    run.record = record
    run.recordStat = stat
    if (fieldsChanged) this.changes.agents = true
    return true
  }

  /**
   * Before a journal is read from its first byte again — the rebuild pass after a restart, a
   * cursor reset on rotation or truncation, the replay: the run's journal agents and the
   * journal's step map are dropped, so the read derives them anew instead of adding to them.
   * The run itself, and the time of its last read, stay.
   */
  resetJournal(file: string): void {
    const at = this.runOfJournal(file)
    if (at?.run) {
      at.run.agents = []
      at.run.agentsDropped = 0
      at.run.steps = 0
      this.runAgentIndex.delete(at.key)
      this.changes.agents = true
    }
    this.journalSteps.set(file, new Map())
  }

  /** Whether the agent file has a record whose sidecar is still unread (fewer than 3 tries). */
  needsAgentMeta(file: string): boolean {
    const rec = this.agentMap.get(file)
    return rec !== undefined && rec.meta === null && rec.metaTries < 3
  }

  /**
   * The sidecar's five fields, or null for "tried, nothing usable". Every call is a try; a
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
    this.changes.agents = true
  }

  /**
   * 1.6 O3 (§0a.11): whether a replay reads the agent's sidecar again — its identity was read, but
   * names no `parentAgentId`: by a build before the fifth field, or from a sidecar that has none.
   */
  needsAgentMetaRefresh(file: string): boolean {
    const rec = this.agentMap.get(file)
    return rec !== undefined && rec.meta !== null && rec.meta.parentAgentId === null
  }

  /**
   * A sidecar read again by a replay (§0a.11): its five fields, sanitised as at the first read,
   * replace the identity the record kept — a sidecar gone, or with nothing usable, keeps it. No try
   * is counted. True when the identity changed.
   */
  refreshAgentMeta(file: string, meta: AgentMeta | null): boolean {
    const rec = this.agentMap.get(file)
    const clean = cleanMeta(meta)
    if (!rec || !clean || sameMeta(rec.meta, clean)) return false
    const was = rec.meta?.toolUseId
    if (was && was !== clean.toolUseId && this.agentFileByToolUse.get(was) === file) this.agentFileByToolUse.delete(was)
    rec.meta = clean
    this.linkMeta(file, rec)
    this.changes.agents = true
    return true
  }

  /** Subagent transcripts, in the order they were first counted. */
  agents(): AgentRec[] { return [...this.agentMap.values()] }
  /** Agent launches the parent transcripts recorded. */
  launches(): AgentLaunch[] { return [...this.launchMap.values()] }
  /** Main Claude sessions, the tree's roots. */
  mains(): MainRec[] { return [...this.mainMap.values()] }
  /** The `Workflow` tool calls the transcripts recorded (1.6 N4): the parent's view of each run. */
  runLaunches(): RunLaunch[] { return [...this.runLaunchMap.values()] }
  /** Workflow runs as their journals record them. */
  runs(): RunRec[] { return [...this.runMap.values()] }

  /**
   * The agent records with the path each is keyed by. The tree needs it: a node's key is the
   * agent's file, and `spawnerFile` names a file, not a record.
   */
  agentEntries(): Array<[file: string, rec: AgentRec]> { return [...this.agentMap] }
  /** The main session records with their path — the key every agent's `sessionFile` names. */
  mainEntries(): Array<[file: string, rec: MainRec]> { return [...this.mainMap] }

  /**
   * 1.7 W3 (§0a.1): the Claude Code version this machine runs, as its transcripts say it — the
   * `ccVersion` of the main session with the latest `lastTs` whose version has the shape
   * (`VERSION_RE`), or null for none. Only main sessions are asked, never an agent's record. The
   * shape is checked again here: a snapshot another build wrote may carry anything, and the answer
   * goes into a request header (the user agent of the quota fetch, and nowhere else).
   */
  latestClaudeVersion(): string | null {
    let best: MainRec | null = null
    for (const rec of this.mainMap.values()) {
      if (versionValue(rec.ccVersion) === null) continue
      if (best === null || rec.lastTs > best.lastTs) best = rec
    }
    return best === null ? null : best.ccVersion
  }

  /**
   * Which revision of the agent tables the one-time replay last built: 0 for a snapshot this
   * build never replayed (every version before 8, and a version 8 written before its replay).
   * The host replays while it differs from AGENT_TABLES_REVISION and sets it once the replay ran.
   */
  get agentsRevision(): number { return this.agentsRevisionValue }
  set agentsRevision(v: number) { this.agentsRevisionValue = count(v) }

  /**
   * 1.6 L5: what the reads since the last call changed, and a fresh start for the next — reset on
   * read. The host asks after every ingest: a change of the agent tables alone rebuilds the Agents
   * section and nothing else, and a bucket change the whole view model at most every few seconds.
   * Set by the writes themselves — a bucket or tool row the counting adds to, a record, launch, run
   * or sidecar of the agent tables —, never by a query.
   */
  takeChanges(): IngestChanges {
    const out = this.changes
    this.changes = { buckets: false, agents: false }
    return out
  }

  /**
   * Starts a replay over `files` (`replayAgents` in scan.ts): what these transcripts and
   * journals gave the agent tables is taken out, so reading them again from the start rebuilds
   * it instead of adding to it. What the lines cannot give back — an agent's sidecar, its
   * spawner, the parent's recorded result — is kept aside and carried into the rebuilt record.
   */
  beginAgentReplay(files: Iterable<string>): void {
    this.replayPending.clear()
    this.replayKept.clear()
    this.changes.agents = true
    const set = new Set(files)
    for (const file of set) {
      // A mode waiting for a record: the replay reads the prompt line that named it again.
      this.pendingMode.delete(file)
      if (isWorkflowJournal(file)) {
        this.resetJournal(file)
        continue
      }
      const rec = this.agentMap.get(file)
      if (rec) {
        this.replayKept.set(file, rec)
        this.dropAgent(file, rec)
      }
      this.mainMap.delete(file)
    }
    for (const [id, launch] of this.launchMap) if (set.has(launch.file)) this.dropLaunch(id, launch)
    // A run launch is its transcript's lines alone — the call, its result, its notification — so
    // reading them again rebuilds it whole.
    for (const [id, launch] of this.runLaunchMap) if (set.has(launch.file)) this.runLaunchMap.delete(id)
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
   * last line, a launch whose last news, and a run whose journal last changed before `horizon` —
   * the run with its step map.
   */
  private pruneAgents(horizon: number): void {
    for (const [file, rec] of this.agentMap) {
      if (Math.max(rec.lastTs, rec.outcomeTs ?? 0, rec.rejected?.at ?? 0) < horizon) this.dropAgent(file, rec)
    }
    for (const [id, launch] of this.launchMap) {
      if (Math.max(launch.ts, launch.outcomeTs ?? 0) < horizon) this.dropLaunch(id, launch)
    }
    for (const [id, launch] of this.runLaunchMap) {
      if (Math.max(launch.ts, launch.outcomeTs ?? 0) < horizon) this.runLaunchMap.delete(id)
    }
    for (const [file, rec] of this.mainMap) if (rec.lastTs < horizon) this.mainMap.delete(file)
    for (const [key, run] of this.runMap) {
      if (run.lastTs >= horizon) continue
      this.runMap.delete(key)
      this.runAgentIndex.delete(key)
      if (run.journalFile !== null) this.journalSteps.delete(run.journalFile)
    }
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
    this.runAgentIndex.clear()
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
      if (!p || typeof p !== 'object') return false
      const meta = codexSessionMeta(p, ctx.file, ctx)
      // A forked thread carries the parent thread's complete history with it.
      if (meta.forked) cur.forked = true
      const own = meta.attributed
      if (own !== null && !ctx.agentsOnly) {
        const at = Number.isFinite(ts) ? ts : Date.now()
        // 1.14 §0a.3: the key goes onto the cursor — the meta line is read once, and a tail that resumes after a
        // restart still files the later lines under it. A fork takes its own session_meta's `cwd`.
        cur.project = own.key
        this.noteProject(own.key, at, own.name)
        const s = this.sessionFor(ctx.file, ctx, () => this.newSession(
          'codex', own.sessionId, own.key, !!cur.forked, meta.forkedFrom, at,
        ))
        s.project = own.key
        cur.sessionId = s.sessionId
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
    // 1.14 §3 A1 rule 2: the rollout's key from its cursor; a rollout without a session_meta line (or without its
    // `cwd`) is unattributed — '' —, never its day directory (§7a Q15).
    const project = ctx.attribution !== 'none' ? (isProjectKey(cur.project) ? cur.project : UNATTRIBUTED) : undefined
    const b = this.bucketFor('codex', hourIndex(at), localDay(at), model, isSub, 'standard', project)
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
    // 1.8 §0a.3: a turn of the rollout's own — never one of a fork or a subagent's thread.
    if (!isSub) this.noteCodexTurn(ts, cur.model)

    if (project !== undefined) {
      this.noteProject(project, at, null)
      const s = this.sessionFor(ctx.file, ctx, () => this.newSession(
        'codex', path.basename(ctx.file, '.jsonl'), project, isSub, null, at,
      ))
      s.project = project
      if (cur.sessionId === undefined) cur.sessionId = s.sessionId
      this.noteTurn(s, at, model)
      s.input += add.input
      s.cacheRead += add.cacheRead
      s.cacheWrite += add.cacheWrite
      s.output += add.output
      s.reasoning += add.reasoning
      s.requests += 1
      s.outputFinal += 1
      this.noteCacheWrite(s, add.cacheWrite, 0, at)
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

  /**
   * 1.8 §0a.3: a counted turn of a non-forked rollout onto `codexLast` — the event's own time (a
   * line without one is not the newest of anything) and the model `turn_context` named, held to the §0
   * alphabet, at most 64 characters: a turn without a model that fits keeps nothing. The newest turn
   * wins, whichever rollout is read first.
   */
  private noteCodexTurn(at: number, model: unknown): void {
    if (!Number.isFinite(at) || at <= 0) return
    const id = cleanAgentName(model, AGENT_MODEL_MAX_CHARS)
    if (id === null) return
    if (this.codexLastValue !== null && at < this.codexLastValue.at) return
    this.codexLastValue = { at, model: id }
  }

  /** 1.8 A6 (§0a.3): the newest counted Codex turn of a non-forked rollout — its time and model — or null. */
  codexLastTurn(): CodexTurn | null {
    return this.codexLastValue === null ? null : { ...this.codexLastValue }
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
    const snap: Snapshot = {
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
      runs: Object.fromEntries(this.runMap),
      runLaunches: Object.fromEntries(this.runLaunchMap),
      agentsRevision: this.agentsRevisionValue,
      codexLast: this.codexLastValue,
    }
    // 1.14 §3 A2 rule 5: the label table only with attribution on — a none snapshot carries no key of it.
    if (this.attribution !== 'none') snap.projects = this.projects()
    return snap
  }

  /**
   * Restores a snapshot for the given attribution setting. A schema mismatch yields an
   * empty aggregator, which is the signal for a cold scan. The same happens when the
   * setting now asks for session records the snapshot was never collecting (none →
   * project/session): those can only come from a re-read. The other direction just
   * drops the table; project and session share one record shape and switch freely.
   *
   * Versions 5, 6 and 7 are read as well: each lacks a table that simply starts empty — the
   * tool side table (5), the agent tables (6), the workflow runs (7) — and a cold re-read of
   * every transcript would be a steep price for tables that have no history yet either way.
   * None of them states the agent tables' revision, so the host replays them once. A version 7
   * agent record may carry a completion the workflow journal wrote onto it (1.5 did); that one is
   * taken back, as the run rebuilt by the replay holds the journal's view since 1.6.
   */
  static fromSnapshot(s: Snapshot | undefined, attribution: Attribution = 'none', names = false): Aggregator {
    const a = new Aggregator()
    a.attribution = attribution
    if (!s || !READABLE_STATE_VERSIONS.includes(s.version)) return a
    const stored: Attribution = s.attribution ?? 'none'
    if (attribution !== 'none' && stored === 'none') return a
    // 1.14 §3 A2 rule 4: a version 5–8 snapshot has no project on a bucket — under project or session only a
    // re-read can split its hours by folder (a 1.13 session record has lifetime counters only).
    if (needsProjectReread(s, attribution)) return a
    const on = attribution !== 'none'
    for (const b of s.buckets ?? []) {
      // The source has to be a provider this build knows, not merely a non-empty string: the
      // snapshot is a file a user can edit and another build can have written, and everything
      // downstream looks the source up in the registry to decide how to read the bucket.
      if (!b || typeof b !== 'object' || !isKnownSource(b.source) || !b.res) continue
      a.restoreBucket(b, on)
    }
    for (const [k, v] of Object.entries(s.cursors ?? {})) {
      // §0a.6's allow-list: a cursor's project key as stored, or none at all — a Codex rollout's later lines then
      // go to the unattributed key, a Claude transcript's key is hashed again from its path.
      if (on && v && typeof v === 'object' && v.project !== undefined && storedProjectKey(v.project) === null) delete v.project
      a.cursors.set(k, v)
    }
    for (const [k, v] of Object.entries(s.pending ?? {})) {
      if (on && v && typeof v === 'object' && v.project !== undefined && storedProjectKey(v.project) === null) v.project = UNATTRIBUTED
      a.pending.set(k, v)
    }
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
    if (on) {
      for (const [k, v] of Object.entries(s.sessions ?? {})) {
        const rec = restoreSession(v)
        if (k && rec) a.sessionMap.set(k, rec)
      }
      for (const [k, v] of Object.entries(s.projects ?? {})) {
        const label = storedProjectKey(k) === null ? null : restoreProjectLabel(k, v, names)
        if (label) a.projectMap.set(k, label)
      }
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
    // 1.8 §0a.3: absent before 1.8, and restored by shape.
    a.codexLastValue = restoreCodexTurn(s.codexLast)
    // The agent tables came with version 7, the runs with 8. They do not depend on
    // `attribution`: the tree's roots are kept whatever the session table is set to.
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
      if (s.version === 7) a.forwardFromV7()
      if (s.version >= 8) {
        for (const v of Object.values(s.runs ?? {})) {
          const run = restoreRun(v)
          if (run) a.runMap.set(`${run.sessionId}|${run.workflowId}`, run)
        }
        for (const v of Object.values(s.runLaunches ?? {})) {
          const launch = restoreRunLaunch(v)
          if (launch) a.runLaunchMap.set(launch.toolUseId, launch)
        }
        a.agentsRevisionValue = count(s.agentsRevision)
      }
      a.reindexAgents()
    }
    return a
  }

  /**
   * Version 7 → 8: 1.5 wrote the workflow journal's result onto the agent's record; since 1.6 a
   * record's outcome is the parent's alone, and the journal's view lives in the run the replay
   * rebuilds. A workflow agent's completion that no launch of it carries is the journal's, and is
   * taken back. `journalResults` is not read at all: the replay finds those results in the
   * journals again.
   */
  private forwardFromV7(): void {
    const completed = new Set<string>()
    for (const launch of this.launchMap.values()) {
      if (launch.outcome !== 'completed') continue
      if (launch.agentId !== null) completed.add(launch.agentId)
      completed.add(`toolu:${launch.toolUseId}`)
    }
    for (const rec of this.agentMap.values()) {
      if (rec.workflowId === null || rec.outcome !== 'completed') continue
      if (completed.has(rec.agentId) || (rec.meta?.toolUseId && completed.has(`toolu:${rec.meta.toolUseId}`))) continue
      rec.outcome = null
      rec.outcomeTs = null
      rec.outcomeStatus = null
    }
  }

  /**
   * A stored bucket into the table (1.14 §0a.6): under attribution on its project checked — a malformed or missing
   * one goes to the unattributed key —, under none its project folded out. Two stored buckets of one key are added
   * up, never one dropped (a file edited by hand, or the fold). A bucket that changes is copied first: the stored
   * one can be a live bucket of another aggregator (`fromSnapshot(agg.toSnapshot())`).
   */
  private restoreBucket(b: Bucket, on: boolean): void {
    let row = b
    if (on) {
      if (storedProjectKey(b.project) === null) row = { ...b, project: UNATTRIBUTED }
    } else if (b.project !== undefined) {
      row = { ...b }
      delete row.project
    }
    const k = bucketKey(row)
    const have = this.buckets.get(k)
    if (!have) { this.buckets.set(k, row); return }
    const sum = { ...have }
    mergeInto(sum, row)
    this.buckets.set(k, sum)
  }

  /**
   * 1.14 §3 A7 (§7a Q19): attribution switched off — no re-read. Every bucket's project is folded out (the buckets of
   * one coordinate added up, so every sum stays exact), and the label table, the session records and the keys on
   * the cursors and the open messages go.
   */
  clearSessions(): void {
    this.sessionMap.clear()
    this.projectMap.clear()
    this.attribution = 'none'
    this.dropSessionFields()
    const folded = new Map<string, Bucket>()
    for (const b of this.buckets.values()) {
      const row = { ...b }
      delete row.project
      const k = bucketKey(row)
      const have = folded.get(k)
      if (have) mergeInto(have, row)
      else folded.set(k, row)
    }
    this.buckets = folded
    this.changes.buckets = true
  }

  /** Session identifiers and project keys also live on cursors and open messages; off means gone everywhere. */
  private dropSessionFields(): void {
    for (const c of this.cursors.values()) { delete c.sessionId; delete c.project }
    for (const p of this.pending.values()) { delete p.session; delete p.project }
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
      // 1.14 §3 A2 rule 3: an hour of project p folds into p's day, p's day into p's month.
      mergeInto(this.get(b.source, 'd', null, day, b.model, b.isSub, b.tier, b.project), b)
      hoursMerged++
    }
    for (const [k, b] of [...this.buckets]) {
      if (b.res !== 'd' || b.day >= dayHorizon) continue
      this.buckets.delete(k)
      mergeInto(this.get(b.source, 'm', null, monthOf(b.day), b.model, b.isSub, b.tier, b.project), b)
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

    // 1.14 §3 A3: the projects beyond the cap or idle past the day horizon fold into other projects, and the session
    // records are pruned at the hour horizon and capped.
    this.foldProjects(now, retentionDays)
    this.pruneSessions(now, hourRetentionDays)

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

  /**
   * 1.14 §3 A3 rules 1–2 (§7a Q12): a project whose newest line is older than `retentionDays` (the day horizon —
   * past it only its months are left, and a folder's name kept for a project unused for over a year is a personal
   * datum kept for nothing), and beyond `PROJECT_CAP` the least recently active, fold into OTHER_PROJECTS: their
   * buckets merge into the other projects' bucket of the same coordinates (sums exact), their labels go, their
   * session records take the key OTHER_PROJECTS (a session that goes on takes its folder's key back with its next
   * line). The count of folded projects is kept on the other projects' label, for the sentence that says the list is
   * short. Returns how many projects folded now.
   */
  foldProjects(now: number, retentionDays: number): number {
    if (this.projectMap.size === 0) return 0
    const idleBefore = now - Math.max(0, Math.floor(retentionDays)) * MS_DAY
    const fold = new Set<string>()
    const kept: Array<[string, ProjectLabel]> = []
    for (const entry of this.projectMap) {
      if (entry[0] === UNATTRIBUTED || entry[0] === OTHER_PROJECTS) continue
      if (entry[1].lastTs < idleBefore) fold.add(entry[0])
      else kept.push(entry)
    }
    if (kept.length > PROJECT_CAP) {
      // Newest first; a tie by key, so the choice does not depend on the order the lines were read in.
      kept.sort((a, b) => b[1].lastTs - a[1].lastTs || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
      for (const [k] of kept.slice(PROJECT_CAP)) fold.add(k)
    }
    if (fold.size === 0) return 0
    const other = this.projectMap.get(OTHER_PROJECTS) ?? { lastTs: 0 }
    for (const k of fold) {
      other.lastTs = Math.max(other.lastTs, this.projectMap.get(k)?.lastTs ?? 0)
      this.projectMap.delete(k)
    }
    other.folded = (other.folded ?? 0) + fold.size
    this.projectMap.set(OTHER_PROJECTS, other)
    for (const [k, b] of [...this.buckets]) {
      if (b.project === undefined || !fold.has(b.project)) continue
      this.buckets.delete(k)
      mergeInto(this.get(b.source, b.res, b.hour, b.day, b.model, b.isSub, b.tier, OTHER_PROJECTS), b)
    }
    for (const rec of this.sessionMap.values()) if (fold.has(rec.project)) rec.project = OTHER_PROJECTS
    for (const p of this.pending.values()) if (p.project !== undefined && fold.has(p.project)) p.project = OTHER_PROJECTS
    this.changes.buckets = true
    return fold.size
  }

  /**
   * 1.14 §3 A3 rule 3 (§7a Q12): the session records whose newest line is older than `hourRetentionDays` go, and of
   * the rest at most SESSION_CAP are kept, the newest. Returns how many went.
   */
  pruneSessions(now: number, hourRetentionDays: number): number {
    const before = now - Math.max(0, Math.floor(hourRetentionDays)) * MS_DAY
    let gone = 0
    for (const [k, rec] of this.sessionMap) {
      if (rec.lastTs < before) { this.sessionMap.delete(k); gone++ }
    }
    if (this.sessionMap.size > SESSION_CAP) {
      const oldest = [...this.sessionMap.entries()]
        .sort((a, b) => b[1].lastTs - a[1].lastTs || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
        .slice(SESSION_CAP)
      for (const [k] of oldest) { this.sessionMap.delete(k); gone++ }
    }
    return gone
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
        const c = this.costOfBucket(b, tcfg, pricing ?? NO_PRICING)
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

  /**
   * Several `sumHours` in one pass over the buckets (1.6 L5, Review 3): the answer to each query is
   * the one `sumHours` gives it alone — the same hour rounding, the same filter, the same
   * completeness — in the order of the queries. A view-model build asks for a handful of spans
   * (the quota windows' own, for the totals rows and for the subagent share, and the last seven
   * days), and each pass of its own walked every bucket again.
   */
  sumHoursMany(queries: readonly HourQuery[]): Array<{ bucket: Bucket; complete: boolean }> {
    const hh = this.hourHorizon()
    const asked = queries.map((q) => {
      const out = emptyBucket(q.filter?.source ?? 'claude', '*', false, 'standard', 'h', null, localDay(q.fromMs))
      const valid = Number.isFinite(q.fromMs) && Number.isFinite(q.toMs) && q.toMs > q.fromMs
      const fromHour = valid ? hourIndex(q.fromMs) : 0
      const toHour = valid ? Math.ceil(q.toMs / MS_HOUR) : 0
      return { out, valid, fromHour, toHour, filter: q.filter, complete: !valid || hh === null || fromHour >= hh }
    })
    const open = asked.filter((a) => a.valid)
    if (open.length > 0) {
      for (const b of this.buckets.values()) {
        if (b.res !== 'h' || b.hour === null) continue
        for (const a of open) {
          if (b.hour < a.fromHour || b.hour >= a.toHour) continue
          if (!this.matches(b, a.filter)) continue
          mergeInto(a.out, b)
        }
      }
    }
    return asked.map((a) => ({ bucket: a.out, complete: a.complete }))
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
