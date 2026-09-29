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
  /**
   * 1.14 §0a.6: the project key (project.ts `PROJECT_KEY_RE` or `OTHER_PROJECTS`) — absent, not '', while
   * `tokenPace.attribution` is none, so a none bucket and its key are byte for byte 1.13's. With attribution on,
   * two projects active in one hour are two buckets of that hour; their sum is the one bucket of none.
   */
  project?: string
}

/**
 * The key a bucket is kept under. 1.14 §0a.6: `|<project>` is appended when the bucket carries a project, so a
 * none bucket's key is 1.13's string — and a build that does not know the field would fold two projects' buckets
 * of one hour onto one key, which is why STATE_VERSION is 9.
 */
export function bucketKey(
  b: Pick<Bucket, 'source' | 'res' | 'hour' | 'day' | 'model' | 'isSub' | 'tier' | 'project'>,
): string {
  const base = `${b.source}|${b.res}|${b.res === 'h' ? b.hour : b.day}|${b.model}|${b.isSub ? 1 : 0}|${b.tier}`
  return b.project === undefined ? base : `${base}|${b.project}`
}

export function emptyBucket(
  source: Source,
  model: string,
  isSub: boolean,
  tier: Tier,
  res: Resolution,
  hour: number | null,
  day: string,
  project?: string,
): Bucket {
  const b: Bucket = {
    source, model, isSub, tier, res, hour, day,
    input: 0, cacheWrite: 0, cacheWrite1h: 0, cacheRead: 0, output: 0, reasoning: 0,
    requests: 0, outputFinal: 0, webSearch: 0, webFetch: 0,
  }
  // Only with a project: a none bucket gains no key at all (§3 A2 rule 5).
  if (project !== undefined) b.project = project
  return b
}

/**
 * 1.14 §0a.6: what the label table keeps of a project, by its key (`Snapshot.projects`) — only while
 * `tokenPace.attribution` is not none.
 */
export interface ProjectLabel {
  /** The newest line of the project (ms) — pruning (§3 A3) and the table's "Last activity". */
  lastTs: number
  /** §0a.2: the folder's name, project.ts `cleanProjectName`'d — only while `showProjectNames` is basename. */
  name?: string
  /**
   * §3 A3 rule 1: on the label of OTHER_PROJECTS only — how many projects have folded into it (a project that
   * folds, comes back and folds again counts twice), for "{0} projects folded into other projects".
   */
  folded?: number
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
  /**
   * 1.14 §3 A2 rule 1: the project key of the bucket the message's first line opened, when attribution is on —
   * a later line of the message grows that bucket, whichever file it is in.
   */
  project?: string
  /**
   * The agent transcript this message was credited to, by its file name without `.jsonl`
   * (`agent-<id>`); `main` names the main session's transcript the same way (its session
   * id). They play the part `session` plays for the session table: a later line of the
   * message adds its growth to that record, and a line of the same id in another file adds
   * nothing to it. A name rather than the path, because every open message carries one:
   * 4000 paths would add most of a megabyte to a snapshot that is written every few seconds.
   * Optional — an entry from a version 6 snapshot has neither and is linked by its next line.
   */
  agent?: string
  main?: string
  /**
   * Tool calls already counted for this message, per tool name. Claude writes one content
   * block per line under a repeated `message.id`, so the counter has to survive across
   * lines; only the increase over this record is ever added, the same max-per-key rule the
   * token fields use. Optional so version 5 snapshots still load.
   */
  tools?: Record<string, number>
  /**
   * Ids of the `tool_use` blocks already counted for this message (capped). They are what
   * makes two parallel calls of the *same* tool two calls instead of one, while a re-read
   * of a line stays a no-op. Ids only — a block's input is never read.
   */
  toolIds?: string[]
  /**
   * 1.8 §0a.2: the time (ms) of the message's first line — so that a later line of the newest
   * message grows its `lastRequest.context`, and a late line of an older message changes nothing.
   * Set for a main transcript's messages only. Absent in a 1.7 snapshot: such a message never grows
   * a `lastRequest`.
   */
  firstAt?: number
}

/** At most this many `toolIds` per message; beyond it the plain max-per-name rule decides. */
export const TOOL_IDS_PER_MESSAGE = 64

/**
 * One day of one tool's calls, for one source and model.
 *
 * A side table, not a bucket dimension: a tool axis would multiply the buckets by
 * models × tiers × hours and would make `bucketKey`, the CSV export and every existing
 * sum ambiguous. Day resolution, names and counts only — a tool's input is content and
 * is never read, let alone stored.
 */
export interface ToolStat {
  source: Source
  /** Local calendar day YYYY-MM-DD at ingest, like the `day` of a rolled-up bucket. */
  day: string
  model: string
  /** The name as the transcript spells it: "Bash", "mcp__server__tool", "exec". */
  name: string
  calls: number
}

export function toolKey(t: Pick<ToolStat, 'source' | 'day' | 'model' | 'name'>): string {
  return `${t.source}|${t.day}|${t.model}|${t.name}`
}

/** Key of the (source, day) pair the distinct-name cap and its truncation flag apply to. */
export function toolDayKey(source: Source, day: string): string {
  return `${source}|${day}`
}

/**
 * Distinct tool names kept per source and day. Names come from the transcript, so a
 * generated or per-call name would grow the state file without bound; beyond the cap
 * further names are dropped and the day is flagged, so a view can say the list is
 * incomplete instead of quietly showing a short one.
 */
export const TOOL_NAME_CAP = 100

/** A tool name longer than this is stored cut to this length — display hygiene, nothing else. */
export const TOOL_NAME_MAX_CHARS = 100

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
  /**
   * Attribution: the session id and, since 1.14, the project key of this file (§0a.1, §0a.3) — for a Codex rollout
   * taken from its `session_meta` line, which is read once, so a tail that resumes after a restart still files the
   * later lines; for a Claude transcript the key of its directory, kept so it is hashed once per file.
   */
  sessionId?: string
  project?: string
  /** Timestamp (ms) of the last counted line, for turn-duration and cache-TTL estimates. */
  lastTs?: number
}

/** Opt-in per-session record (tokenPace.attribution !== 'none'). Keyed by transcript path. */
export interface SessionRec {
  source: Source
  sessionId: string
  /**
   * 1.14 §0a.6: the project key (project.ts `PROJECT_KEY_RE` or `OTHER_PROJECTS`) — was a basename or the hash.
   * 1.0–1.13's `projectHash` and `hourUsage` (written, never read since 1.2.2) are gone.
   */
  project: string
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
}

export type Attribution = 'none' | 'project' | 'session'

/**
 * A recorder's own word for how a launch or run ended — one of the allow-listed status values
 * of a tool result or a task notification, never free text. Kept beside the outcome it maps to,
 * so a sentence can quote it ("the parent recorded ‘killed’").
 */
export type LaunchStatus = 'completed' | 'failed' | 'error' | 'timeout' | 'killed' | 'cancelled' | 'stopped'
/**
 * What a recorded end means for the tree: `completed`; `failed` for failed, error and timeout;
 * `stopped` (new in 1.6, D7) for killed, cancelled and stopped — a stop is not a failure.
 */
export type RecordedOutcome = 'completed' | 'failed' | 'stopped'

/**
 * The `error` of an API error line (1.6 §0a.2), through its allow-list — the kinds Claude Code
 * writes there. Any other value is no kind (null).
 */
export type ApiErrorKind =
  | 'rate_limit' | 'server_error' | 'invalid_request' | 'authentication_failed' | 'max_output_tokens' | 'overloaded'
/** The `quotaLimits.rateLimitType` of a rejected request (1.6 §0a.2): which limit refused it. */
export type RateLimitKind = 'five_hour' | 'seven_day' | 'seven_day_opus' | 'seven_day_sonnet'
/**
 * The top-level `effort` of an assistant line in an agent's transcript (1.6 N8, §0a.4), through its
 * allow-list — the five levels Claude Code writes there. Any other value is no effort (null).
 */
export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max'
/**
 * Why the cache missed on an agent's request (1.6 O3, §0a.7): the `type` of a response's
 * `message.diagnostics.cache_miss_reason`, through its allow-list — the six reasons Claude Code
 * writes there. Any other value is no reason (not counted).
 */
export type CacheMissKind =
  | 'previous_message_not_found' | 'unavailable' | 'messages_changed' | 'model_changed' | 'tools_changed' | 'system_changed'
/**
 * The permission mode a transcript's prompt line was written under (1.6 O3, §0a.9) — the five modes
 * Claude Code names in a user line's top-level `permissionMode`, matched on the raw line.
 */
export type PermissionMode = 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan' | 'auto'
/**
 * The `status` of Claude Code's run record (1.6 L4, §0a.12), through its allow-list — the words
 * Claude Code writes there for a workflow run. Any other value is no status (null).
 */
export type RunRecordStatus = 'completed' | 'failed' | 'killed' | 'stopped' | 'cancelled' | 'running'

/**
 * The last compaction of a transcript (1.6 O3, §0a.10): the time of its `compact_boundary` line,
 * whether it was asked for (`manual`) or Claude Code's own (`auto`), and the context before and
 * after it — each through its allow-list, null when absent. Never the summary it left behind.
 */
export interface CompactionRec {
  at: number
  trigger: 'manual' | 'auto' | null
  preTokens: number | null
  postTokens: number | null
}

/**
 * The last rejected request of an agent's transcript (1.6 N3, §0a.2): the time of its error line
 * and three values of it, each through its allow-list — never the error's text. A later counted
 * reply of the same transcript clears it.
 */
export interface RejectedRequest {
  at: number
  /** `apiErrorStatus`, an integer 100..599. */
  status: number | null
  error: ApiErrorKind | null
  /** `quotaLimits.rateLimitType`. */
  limit: RateLimitKind | null
}

/** Identity of a subagent transcript, from `agent-<id>.meta.json`. Five fields; nothing else is read. */
export interface AgentMeta {
  /** ≤ 40 chars, alphabet [A-Za-z0-9_.:@/-]. */
  agentType: string | null
  /** ≤ 40 chars, same alphabet. */
  model: string | null
  /** Integer ≥ 1. */
  spawnDepth: number | null
  /** ≤ 64 chars, alphabet [A-Za-z0-9_-]. */
  toolUseId: string | null
  /**
   * 1.6 O3 (§0a.11): the id of the agent that spawned this one, as an agent id (≤ 64 chars of
   * [A-Za-z0-9_-]) — the spawner link when `toolUseId` names no launch.
   */
  parentAgentId: string | null
}

/** One subagent transcript, keyed by its path. Kept for AGENT_RETENTION_DAYS after its last line. */
export interface AgentRec {
  source: 'claude'
  /** From the file name `agent-<id>.jsonl`; fallback the line's `agentId`. */
  agentId: string
  /** Directory name above `subagents`. */
  sessionId: string
  /** `<slugDir>/<sessionId>.jsonl` — the tree root key. */
  sessionFile: string
  /** `wf_…` when under `subagents/workflows/<wf>/`. */
  workflowId: string | null
  /** Null until the sidecar was read. */
  meta: AgentMeta | null
  /** Attempts so far; stop after 3. */
  metaTries: number
  /** Transcript that issued the tool_use (meta.toolUseId ↔ launches). */
  spawnerFile: string | null
  firstTs: number
  lastTs: number
  /** Real model ids seen, in order of first appearance, ≤ 8. */
  models: string[]
  input: number; cacheWrite: number; cacheWrite1h: number; cacheRead: number
  output: number; reasoning: number; requests: number; outputFinal: number; toolCalls: number
  /**
   * Recorded by the parent only — its tool result or a task notification. The workflow
   * journal's view of a run's agent lives in `RunRec` since 1.6 and is joined at view time.
   */
  outcome: RecordedOutcome | null
  outcomeTs: number | null
  /**
   * The parent's own word for the end (§0a.0), for the sentence; null when the outcome came
   * without one — from a snapshot written before 1.6. A `stopped` outcome always has one.
   */
  outcomeStatus: LaunchStatus | null
  /**
   * 1.6 N3: the last request of the transcript that the API rejected — a rate limit, a server
   * error — when no counted reply came after it; a later counted reply clears it. Its time is
   * activity of the transcript too, which `lastTs` (the last counted reply) does not include.
   */
  rejected: RejectedRequest | null
  /**
   * 1.6 N5 (§0a.5): the name of the last `tool_use` block of the transcript — through the tool
   * names' own alphabet, `[A-Za-z0-9_.:@/-]` and at most TOOL_NAME_MAX_CHARS, else null — and the
   * time of its line. What the tree names when an agent went quiet after a call ("after a Bash
   * call"); never the call's input. Null for a transcript without a tool call.
   */
  lastTool: string | null
  lastToolTs: number | null
  /**
   * 1.6 N8 (§0a.4): the top-level `effort` of the transcript's newest counted reply, through its
   * allow-list, and every distinct one its replies carried, in the order first seen — at most five,
   * as there are five. Never a nested `effort` (a tool's input carries some), never the
   * `perTurnEffort` of an error line. Null and empty for a transcript whose replies carry none.
   */
  effort: Effort | null
  efforts: Effort[]
  /**
   * 1.6 L2: the context of the transcript's newest request — its input, cache write and cache read,
   * the running maximum over the lines of that reply, as every counter of a reply is. What the
   * details call "Context at the end"; null until a counted reply came.
   */
  lastContext: number | null
  /**
   * 1.6 O3 (§0a.6): the tool results of the transcript marked `is_error` — counted on the raw line,
   * by the literal `"is_error":true`, which only Claude Code's own key of a `tool_result` block can
   * be (inside a string its quotes are escaped); the result itself is never read. Null for a record
   * that does not count them: one restored from a snapshot written before 1.6 O3 that the replay
   * could not read again (its transcript gone) — a zero there would be one nobody counted.
   */
  toolErrors: number | null
  /**
   * 1.6 O3 (§0a.7): the requests whose cache missed, by the reason the response's diagnostics give —
   * once per message, on its first line — and the input tokens those reasons state were not read
   * from the cache (Claude Code gives the figure for a changed message, model, tool set or system
   * prompt, not for an unavailable cache). Never part of a usage total.
   */
  cacheMisses: Partial<Record<CacheMissKind, number>>
  cacheMissedTokens: number
  /** 1.6 O3 (§0a.8, §0a.9, §0a.10): as `MainRec`'s. */
  ccVersion: string | null
  permissionMode: PermissionMode | null
  compactions: number
  lastCompaction: CompactionRec | null
}

/** A launch the parent transcript recorded; the bridge from tool_use id to agent. */
export interface AgentLaunch {
  /** ≤ 64 chars. */
  toolUseId: string
  /** The transcript holding the tool_use (main or agent). */
  file: string
  ts: number
  /** Known once the tool result (or a journal line) named it. */
  agentId: string | null
  /** `input.subagent_type`, sanitised like AgentMeta.agentType. */
  typeHint: string | null
  /** `input.model`, sanitised. */
  modelHint: string | null
  background: boolean
  outcome: 'launched' | RecordedOutcome | null
  outcomeTs: number | null
  /** The parent's word for the end (§0a.0); null while launched, and for a snapshot before 1.6. */
  outcomeStatus: LaunchStatus | null
  /** Claude Code's own report for a sync agent — shown as "Report from Claude Code", never summed. */
  totals: { tokens: number; durationMs: number; toolUses: number } | null
}

/**
 * 1.8 §0a.5: the values of a reply's `stop_reason` that are kept — the Messages API's documented
 * ones. Any other value is kept as null, which the keep-warm guard reads as "not idle".
 */
export type StopReason = 'end_turn' | 'tool_use' | 'max_tokens' | 'stop_sequence' | 'pause_turn' | 'refusal'

/**
 * 1.8 §0a.2: the newest counted request of a main conversation that read or wrote the prompt cache
 * — kept per main session from fields `claudeResponse` already reads (the usage counts, the model,
 * the line's time), for the prompt-cache estimate. Never a field of content.
 */
export interface LastRequest {
  /** The time (ms) of the first line of that message — the earliest moment the transcript knows of the request. */
  at: number
  /**
   * The TTL class of the newest cache write: '1h' when that message wrote `ephemeral_1h_input_tokens`, '5m' when it wrote
   * cache tokens of the 5-minute kind only; a message that only read keeps the class of the write before it. Null before a write.
   */
  ttl: '5m' | '1h' | null
  /** input + cacheWrite + cacheRead + output of that message, the running maximum over its lines (≈ the next request's prefix). */
  context: number
  /** Its model id through `cleanAgentName`, or null. */
  model: string | null
  /**
   * 1.8 §0a.5 (for the keep-warm guards): that reply's `stop_reason` through its allow-list — the value of
   * the message's newest line that states one; null while none does, and for a value outside the list.
   */
  stop: StopReason | null
  /**
   * 1.8 §0a.5, second fact (probe P-6): true when the transcript's newest message line — the newest line
   * whose `type` is `user` or `assistant`; every other line (`attachment`, `system`, `file-history-snapshot`,
   * `last-prompt`, `ai-title`, `mode`, `permission-mode`, …) does not count — is a `user` line: a prompt or a
   * tool result. Claude Code writes a reply that calls a tool only when the tool completes, so while a
   * permission dialog or a question stands open the newest line is the user's. Only the line's top-level
   * `type` decides — a user line is recognised on the raw line and never parsed for it.
   */
  replyPending: boolean
}

/** A main Claude session kept for the tree root regardless of `tokenPace.attribution`. Keyed by path. */
export interface MainRec {
  source: 'claude'
  sessionId: string
  firstTs: number
  lastTs: number
  models: string[]
  input: number; cacheWrite: number; cacheWrite1h: number; cacheRead: number
  output: number; reasoning: number; requests: number; outputFinal: number; toolCalls: number
  /**
   * 1.6 O3 (§0a.8): the Claude Code version that wrote the transcript's newest counted reply — its
   * top-level `version`, `1.2.3`-shaped (at most 3, 3 and 4 digits), else none.
   */
  ccVersion: string | null
  /**
   * 1.6 O3 (§0a.9): the last permission mode a prompt line of the transcript named — matched on the
   * raw line, which is never parsed for it; the line that holds the prompt is never read otherwise.
   */
  permissionMode: PermissionMode | null
  /** 1.6 O3 (§0a.10): how many times the transcript was compacted, and the last compaction. */
  compactions: number
  lastCompaction: CompactionRec | null
  /**
   * 1.8 §0a.2: the newest request that touched the prompt cache; null until one did (and after a restore
   * that fails its allow-lists).
   */
  lastRequest: LastRequest | null
  /**
   * 1.9 §0a.1: the time (ms) of the transcript's newest `user` line — a prompt or a tool's result —, its top-level
   * `timestamp` matched on the raw line (the latest match); null before one was seen and after a restore that fails its
   * shape. A user line before the transcript's first counted reply comes before the record and sets nothing. Kept for
   * one use only: whether another session of the folder has been left behind (the keep-warm line's G13, 1.9 D).
   */
  lastUserAt: number | null
}

/** 1.8 §0a.3: the newest counted turn of a non-forked Codex rollout — its time and its model. */
export interface CodexTurn {
  at: number
  model: string
}

/**
 * A `Workflow` tool call a transcript recorded (1.6 N4, §0a.3), keyed by its tool_use id: the
 * parent's view of a workflow run, as an `AgentLaunch` is of an agent. Of the call only its `id`
 * is read — never its input, which holds the workflow's script — and of the tool result that
 * answers it the `runId` and the `status`; the task notification of the call gives its end.
 */
export interface RunLaunch {
  /** The `Workflow` block's id, ≤ 64 chars of `[A-Za-z0-9_-]`. */
  toolUseId: string
  /** The transcript holding the tool_use (the session's, or an agent's). */
  file: string
  ts: number
  /**
   * From the tool result: `wf_` and at most 61 characters of `[A-Za-z0-9_-]` — the name of the
   * run's directory under `subagents/workflows/`. Null until the result arrives. A resumed run
   * keeps its id, so one run can have several launches.
   */
  runId: string | null
  /** `launched` for the background start (`async_launched`), an end once the parent recorded one. */
  outcome: 'launched' | RecordedOutcome | null
  /** The parent's word for the end (§0a.0); null while launched. */
  outcomeStatus: LaunchStatus | null
  outcomeTs: number | null
}

/**
 * One agent as its run's journal records it (1.6 D2, D7): its id, which step of the run it
 * works on and which attempt at that step it is, and the outcome the journal gave it. No key, no
 * label, no result — the journal's `key` only ever tells two steps apart, in memory (see
 * `Aggregator.journalSteps`), and never reaches a record.
 */
export interface JournalAgent {
  agentId: string
  /** 1-based ordinal of the journal key within this journal, in order of first sighting; 0 = no key. */
  step: number
  /** 1-based: the how-many-th `started` of its step this agent is. */
  attempt: number
  /**
   * `completed` for a `result` line, `failed` for a `failed` line; `stopped` = replaced: a later
   * start of the same step came before this one recorded anything. Null while the journal says
   * nothing of its end.
   */
  outcome: 'completed' | 'failed' | 'stopped' | null
  /** The next attempt of the same step, when the journal started one. */
  supersededBy: string | null
}

/**
 * The seven fields of Claude Code's run record (1.6 L4, §0a.12) — `<session>/workflows/<runId>.json`,
 * read by the streaming key-picker of `runRecord.ts`, which decodes nothing else of the file (its
 * script, its logs, its result). Each is null when absent or of the wrong shape: the format is
 * undocumented. Claude Code's own figures — shown, never added to a count of this extension's.
 */
export interface RunRecordFields {
  status: RunRecordStatus | null
  /** Ms since the epoch, > 0. */
  startTime: number | null
  /** ≥ 0. */
  durationMs: number | null
  /** A whole number ≥ 0. */
  agentCount: number | null
  /** ≥ 0. */
  totalTokens: number | null
  /** A whole number ≥ 0. */
  totalToolCalls: number | null
  /** A model id of `[A-Za-z0-9_.:@/-]`, with an optional `[…]` suffix (`claude-fable-5-1[1m]`). */
  defaultModel: string | null
}

/** A run record file's size and modification time at its last read — a read is repeated only when they change. */
export interface RunRecordStat {
  size: number
  mtimeMs: number
}

/**
 * A workflow run as its journal records it, keyed `${sessionId}|${workflowId}`. Kept for
 * AGENT_RETENTION_DAYS after the journal last changed, like the agent records.
 */
export interface RunRec {
  source: 'claude'
  sessionId: string
  /** The directory name under `subagents/workflows/`. */
  workflowId: string
  /** The run's `journal.jsonl` — the key its step map is kept under in memory. */
  journalFile: string | null
  /** In the order of their `started` line; at most MAX_RUN_AGENTS. */
  agents: JournalAgent[]
  /** `started` lines beyond MAX_RUN_AGENTS: counted, not listed. */
  agentsDropped: number
  /** Distinct steps (keys) seen. */
  steps: number
  /** The journal file's mtime at the last read — journal lines carry no time (observed: none). 0 until read. */
  lastTs: number
  /**
   * 1.6 L4 (§0a.12): Claude Code's own record of the run, once read; null while there is none — no
   * file, one larger than RUN_RECORD_MAX_BYTES, one that ends before its object does, or nothing
   * usable in it.
   */
  record: RunRecordFields | null
  /** The record file's size and mtime at the last read; null while no file was found. */
  recordStat: RunRecordStat | null
}

export interface Snapshot {
  /** Schema version of the persisted state. */
  version: number
  buckets: Bucket[]
  cursors: Record<string, Cursor>
  pending: Record<string, PendingMessage>
  sessions: Record<string, SessionRec>
  attribution: Attribution
  /**
   * 1.14 §0a.6: the label table — per project key the newest line and, under `showProjectNames: basename`, the
   * folder's name. Written only while attribution is on; absent from a none snapshot (§3 A2 rule 5).
   */
  projects?: Record<string, ProjectLabel>
  /** Roll-up bookkeeping: last run (ms) and the retention the run used. */
  rollup: { lastRun: number; hourRetentionDays: number; retentionDays: number }
  /** First ingest (ms) — heatmap days before it are "outside coverage", not zero. */
  firstIngest: number | null
  /** Tool-call side table. Absent in version 5 snapshots, which load with an empty one. */
  tools?: ToolStat[]
  /** `source|day` pairs that hit `TOOL_NAME_CAP` — shown as truncated, never silently dropped. */
  toolsTruncated?: string[]
  /**
   * Subagent transcripts, keyed by path (version 7). Absent in older snapshots, which load
   * with none — as do the tables below.
   */
  agents?: Record<string, AgentRec>
  /** Agent launches the parent transcripts recorded, keyed by tool_use id. */
  launches?: Record<string, AgentLaunch>
  /** Main Claude sessions for the agent tree's roots, keyed by path. */
  mains?: Record<string, MainRec>
  /**
   * Workflow runs as their journals record them, keyed `${sessionId}|${workflowId}` (version 8).
   * A version 7 snapshot has none: the replay rebuilds them from the journals.
   */
  runs?: Record<string, RunRec>
  /**
   * The `Workflow` tool calls the transcripts recorded, keyed by tool_use id (1.6 N4). A snapshot
   * written before them has none: the replay the revision asks for finds them again.
   */
  runLaunches?: Record<string, RunLaunch>
  /**
   * Which revision of the agent tables the one-time replay last built (`AGENT_TABLES_REVISION`
   * in agg.ts); absent means 0 — never replayed by this build. Replaces 1.5's `agentsReplayed`:
   * a build that adds a field only a replay can fill for the transcripts already read raises the
   * revision, and the host replays once more. Version 7's `journalResults` and `agentsReplayed`
   * are no longer written; a version 7 snapshot is read forward without them.
   */
  agentsRevision?: number
  /**
   * 1.8 §0a.3: the newest counted turn of a non-forked Codex rollout, for the Codex prompt-cache line.
   * Absent before 1.8 (and read as none); additive, so `STATE_VERSION` stays 8.
   */
  codexLast?: CodexTurn | null
}

/**
 * 9 (1.14 §0a.6): a bucket may carry a project key and the snapshot a label table. `fromSnapshot` recomputes every
 * bucket's key, so a build that does not know `project` would fold two projects' buckets of one hour onto one key —
 * 1.13 refuses a version 9 snapshot and re-reads instead. A none snapshot is version 9 too (§7a Q25).
 */
export const STATE_VERSION = 9

/**
 * Snapshot versions this build can load. Each older version lacks a table that simply starts
 * empty, so it maps forward instead of forcing every user into a cold re-read: 5 has no tool
 * side table, 6 no agent tables (agents, launches, main sessions), 7 no workflow runs. Tool
 * counts then start at the next ingest; the agent tables and the runs are rebuilt once from the
 * transcripts and journals still on disk, because none of them states the agent tables' revision.
 * 8 has no project on a bucket: under attribution none it is read as it stands and saved as 9; under
 * project or session it is not read (agg.ts `needsProjectReread`) — the hour split by project cannot be
 * derived from 1.13's lifetime session records, so the transcripts are read once more.
 */
export const READABLE_STATE_VERSIONS: readonly number[] = [5, 6, 7, 8, 9]

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

/**
 * 1.7 P4b (Review 1 #2): which failures of our own fetch are said beside a reading that is still
 * shown — as a record, so the compiler insists on a verdict for every kind.
 *
 * Transient (true): the cause passes by itself and the poller has scheduled another attempt after a
 * backoff — a rate limit or a server error (`retry`, HTTP 429/5xx, Codex's app-server error), no
 * connection (`offline`: timeout, DNS, TLS, proxy), an unclassified HTTP status or an unexpected
 * error (`unknown`). The reading beside it is old *because* of it, so the card, the tooltip, the
 * text views and a stale status-bar item say so.
 *
 * Permanent (false): nothing changes until the user does something — no credentials, an expired or
 * rejected token, a refused endpoint, no `codex` executable, an answer without windows — or the kind
 * never comes from a fetch of ours at all (the file sources' and the gates' kinds). As in 1.6 such a
 * cause is not said beside a reading: the reading stands, and the problem shows where no reading
 * exists. `quota.json` keeps every failure either way (§0a.3); only the display filters.
 */
export const FAILURE_TRANSIENT: Readonly<Record<ProblemKind, boolean>> = {
  retry: true,
  offline: true,
  unknown: true,
  noToken: false,
  tokenExpired: false,
  unauthorized: false,
  forbidden: false,
  noBinary: false,
  empty: false,
  paused: false,
  noFile: false,
  consentPending: false,
  modeCache: false,
  quotaOff: false,
  follower: false,
}

/** 1.7 P4b: true for a transient kind (`FAILURE_TRANSIENT`); false for every other value, a stranger included. */
export function isTransientFailure(kind: unknown): boolean {
  return typeof kind === 'string' && Object.prototype.hasOwnProperty.call(FAILURE_TRANSIENT, kind)
    && FAILURE_TRANSIENT[kind as ProblemKind]
}

/** 1.7 W1: an attempt of our own that failed — when, in the poller's own words, and of what kind. */
export interface QuotaFailure {
  /** Unix ms of the attempt. */
  at: number
  /** The poller's words: a fixed string plus at most an HTTP status (poller.ts), never an exception's text. */
  problem: string
  kind: ProblemKind
}

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
  /**
   * Unix ms of the next scheduled attempt (backoff end), when known. 1.7 P4b: while a fresh reading
   * answers the fetch (`runPolls` then skips it), not before that reading turns older than the
   * interval — the earliest moment a fetch of ours is wanted again.
   */
  nextAttemptAt?: number | null
  /** Numeric fields of the provider response that this build does not render. */
  drift?: string[]
  /** Only part of the sources answered (e.g. windows without extra). */
  partial?: boolean
  /**
   * 1.7 W1: our own last fetch of this source failed after this reading was taken. Set by
   * `QuotaManager.enrich` on an ok state only (a state that is not ok carries the failure as its
   * `problem`, as in 1.6); null or absent when the last attempt succeeded, when none was made, when the
   * reading is newer than the failure, and whenever `blocked()` is not null (mode, consent, follower).
   * 1.7 P4b: and for a permanent kind (`FAILURE_TRANSIENT`) — only a transient failure is said
   * beside a reading; the renderers ask `isTransientFailure` again for a state built elsewhere.
   */
  lastFailure?: QuotaFailure | null
  /**
   * 1.7 W2: a scheduled attempt that is due but held back — 'focus' while `tokenPace.pollOnlyWhenFocused`
   * keeps a window that has been in the background for more than ten minutes from fetching
   * (`QuotaManager.focusSkips`). Null or absent otherwise — 1.7 P4b: also while a fresh reading
   * answers the fetch (the condition `runPolls` decides by), since then no fetch is wanted at all.
   */
  attemptHeld?: 'focus' | null
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
