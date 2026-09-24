// SPDX-FileCopyrightText: 2026 Frederik Marx
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The Agents section as a tree: session roots → workflow runs → agents → nested agents.
 *
 * Pure, like the view model it feeds: the records come in, `now` comes in, the tree comes
 * out, and nothing here reads a file or a clock. Every state is decided here and nowhere
 * else — the webview and the markdown only print it — and every state carries the sentence
 * that says what it rests on, because a "running" nobody can check is a claim, not a reading:
 *  - an agent is done, failed or stopped only when its parent or its run's workflow journal
 *    recorded it — the parent's record first, and only while its transcript did not go on more
 *    than RESUMED_AFTER_MS after it, which makes its state an inference again; a stop the parent
 *    recorded (`killed`, `cancelled`, `stopped`) is an end of its own, never a failure, and so is
 *    an attempt the journal replaced by starting its step again before it recorded anything;
 *  - it is running while its transcript changed within RUNNING_WINDOW_MS and nothing was
 *    recorded yet;
 *  - anything else is unknown, never done: Claude Code writes no end marker into an agent's
 *    transcript, so a silent file is not a finished one.
 * A workflow run's end is what its parent recorded for its latest `Workflow` launch, then — once
 * every member is closed — what its members came to, then what Claude Code's own run record says
 * (1.6 L4), and failing all three what their clocks say; a run nothing but its launch shows yet runs
 * by the launch's clock (1.6 N4, §3.0 c).
 *
 * A node is keyed by the identifiers its records carry — `s:<sessionId>`,
 * `w:<sessionId>|<workflowId>` (a run belongs to its session), `a:<agentId>`,
 * `l:<toolUseId>` — and never by a path. A key goes to the page, comes back in a message and
 * is kept with the stored view state, and a transcript path spells out the project's
 * directory, which the tree does not even name when attribution is off. The identifiers are
 * unique on one machine — a session id is its transcript's UUID, agent and tool_use ids are
 * random — and the aggregator holds each to 64 characters, so a key is short by construction.
 * A key is only ever used to find its node again.
 */

import {
  AGENT_RETENTION_DAYS, AgentTally, AgentTreeVm, AgentWeek, AgentWeekRow, AgentWeekTop, DetailRow, EARLIER_KEY, HOOK_MAX_AGE_MS, HookEntry,
  HookWait, MAX_GROUP_CHILDREN, MAX_MORE_PAGES, MAX_PAGE_NODES, MAX_ROOTS, MAX_RUNNING_LIST, MAX_TREE_DEPTH, MIN_SHORT_ID, MixPart,
  NodeDetails, NodeState, PER_MINUTE_FROM_MS, RESUMED_AFTER_MS, ROOT_WINDOW_MS, RUNNING_WINDOW_MS, RunningItem, SESSION_ACTIVE_MS,
  SPAN_IN_DAYS_FROM_MS, TOP_AGENTS, TreeNode, WEEK_ROWS, WEEKDAY_NAMES_WITHIN_MS, hookKey,
} from './agentTree'
import { billable, outcomeOfStatus } from './agg'
import { t } from './i18n'
import { PricingOptions, costOfBucket, normalizeModel } from './prices'
import { compact, full } from './render'
import { cleanRunRecord } from './runRecord'
import { costText, durationText, freshInput, tokens } from './stats'
import { TimeConfig, ageText, calendarDayOf, calendarWeekdayOf, clockStamp, dayOf, formatTime, weekdayWords } from './time'
import {
  AgentLaunch, AgentRec, Attribution, Bucket, CompactionRec, Effort, JournalAgent, LaunchStatus, MainRec, RecordedOutcome,
  RejectedRequest, RunLaunch, RunRec, RunRecordFields, SessionRec, emptyBucket,
} from './types'

/** Everything the tree is built from. The view model fills it from the aggregator. */
export interface AgentTreeInput {
  agents: readonly AgentRec[]
  launches: readonly AgentLaunch[]
  mains: readonly MainRec[]
  /** The attribution table — the only place a session's project label comes from. */
  sessions: readonly SessionRec[]
  attribution: Attribution
  /**
   * The workflow runs as their journals record them (1.6 D2, D7): which agents each started, and
   * what the journal says of their ends. Absent means none.
   */
  runs?: readonly RunRec[]
  /**
   * The `Workflow` tool calls the transcripts recorded (1.6 N4): the run each launched, and the
   * end the parent recorded for it. Absent means none.
   */
  runLaunches?: readonly RunLaunch[]
  /** `ui.agentSelected`: the node whose details are open, or null. */
  selected: string | null
  /**
   * `ui.agentsExpanded` (1.6 D3): the nodes the reader opened. In `page` mode only these carry
   * their children; absent means none is open. A key whose node has no children is ignored.
   */
  expanded?: readonly string[]
  /**
   * `ui.agentsMore` (D3): the opened nodes the reader asked to show more children of, and how
   * many "more" steps each took (1…MAX_MORE_PAGES). Absent means none.
   */
  more?: ReadonlyArray<{ key: string; pages: number }>
  /**
   * `page` (the default): the dashboard's payload — only what is open, at most MAX_GROUP_CHILDREN
   * children per open node and its "more" steps, at most MAX_PAGE_NODES nodes. `text`: the
   * markdown document's tree — every node open, MAX_GROUP_CHILDREN children per node, the "more"
   * steps left aside; the details of the selected node wherever it sits.
   */
  mode?: 'page' | 'text'
  /**
   * `ui.agentsWeekOpen` (1.6 L3): whether the 7-day block "where the agent tokens went" is open —
   * the only time it is built. Absent means closed.
   */
  weekOpen?: boolean
  /**
   * L3: the rates the block's costs are taken at — only while `tokenPace.showCost` is on; null or
   * absent, the block names no cost at all.
   */
  pricing?: PricingOptions | null
  /**
   * O4 (1.6): the agent hook's mirror as the host last read it — the latest call per (session,
   * agent), by `hookKey` (src/agentHook.ts). Absent or empty while the hook is not installed:
   * then no node carries a marker.
   */
  hook?: ReadonlyMap<string, HookEntry>
  /**
   * 1.7 F2: `false` lists every session as a root of its own, as 1.6 did — no group of earlier
   * sessions. Absent (the default) splits them. Only the tests pass it, to hold what the split must
   * not change — the running list, the tallies, the export — equal with and without it; the view
   * model never does.
   */
  split?: boolean
  tcfg: TimeConfig
}

const DAY_MS = 86_400_000
const HOUR_MS = 3_600_000

/**
 * The longest key the webview may send back — `MAX_AGENT_KEY_CHARS` in viewModel.ts, which
 * cannot be imported here without a cycle. No key made of the aggregator's records comes near
 * it (two identifiers of at most 64 characters and a prefix); the cut is the safety net for
 * records that did not come through its sanitisers, because a node whose key the parser drops
 * could never be selected or folded. It keeps the tail, the end of the identifier.
 */
const MAX_KEY_CHARS = 200

function fitKey(prefix: string, body: string): string {
  const key = prefix + body
  if (key.length <= MAX_KEY_CHARS) return key
  return `${prefix}…${body.slice(body.length - (MAX_KEY_CHARS - prefix.length - 1))}`
}

// ---------------------------------------------------------------------------
// Reading the records defensively
// ---------------------------------------------------------------------------

/**
 * The counters a transcript record carries. A snapshot written by another build may carry
 * anything in them; a non-number counts as nothing rather than as NaN in every sum after it.
 */
interface Counters {
  input: number; cacheWrite: number; cacheWrite1h: number; cacheRead: number
  output: number; reasoning: number; requests: number; outputFinal: number; toolCalls: number
}

const COUNTER_KEYS = [
  'input', 'cacheWrite', 'cacheWrite1h', 'cacheRead', 'output', 'reasoning', 'requests',
  'outputFinal', 'toolCalls',
] as const

function amount(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0
}

function countersOf(r: object): Counters {
  const src = r as Partial<Record<keyof Counters, unknown>>
  const out = {} as Counters
  for (const k of COUNTER_KEYS) out[k] = amount(src[k])
  return out
}

function noCounters(): Counters {
  return countersOf({})
}

function addInto(sum: Counters, c: Counters): void {
  for (const k of COUNTER_KEYS) sum[k] += c[k]
}

/**
 * The record in bucket shape, so `billable` and `freshInput` apply exactly as they do to the
 * tables: the tree's usage is the same definition, not a second opinion of it.
 */
function bucketOf(c: Counters, isSub: boolean): Bucket {
  return {
    ...emptyBucket('claude', '*', isSub, 'standard', 'd', null, ''),
    input: c.input, cacheWrite: c.cacheWrite, cacheWrite1h: c.cacheWrite1h, cacheRead: c.cacheRead,
    output: c.output, reasoning: c.reasoning, requests: c.requests, outputFinal: c.outputFinal,
  }
}

/** A time stamp, or null for anything that is not one. */
function stampOf(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null
}

function text(v: unknown): string | null {
  return typeof v === 'string' && v !== '' ? v : null
}

function firstOf(r: { firstTs: number; lastTs: number }): number {
  const first = stampOf(r.firstTs)
  return first === null ? r.lastTs : Math.min(first, r.lastTs)
}

function validAgent(r: AgentRec): boolean {
  return !!r && text(r.agentId) !== null && text(r.sessionId) !== null && text(r.sessionFile) !== null
    && stampOf(r.lastTs) !== null
}

function validLaunch(l: AgentLaunch): boolean {
  return !!l && text(l.toolUseId) !== null && text(l.file) !== null && stampOf(l.ts) !== null
}

function validMain(m: MainRec): boolean {
  return !!m && text(m.sessionId) !== null && stampOf(m.lastTs) !== null
}

function validRun(r: RunRec): boolean {
  return !!r && text(r.sessionId) !== null && text(r.workflowId) !== null && Array.isArray(r.agents)
}

/** A run launch the tree can place: its call, its transcript, its time, and the run the result named. */
function validRunLaunch(l: RunLaunch): boolean {
  return !!l && text(l.toolUseId) !== null && text(l.file) !== null && stampOf(l.ts) !== null && text(l.runId) !== null
}

function validJournalAgent(j: JournalAgent): boolean {
  return !!j && typeof j === 'object' && text(j.agentId) !== null
}

/** The journal's outcome of an agent, or null: a stop is a replacement, and only ever one with the attempt that replaced it. */
function journalOutcome(j: JournalAgent): JournalAgent['outcome'] {
  if (j.outcome === 'completed' || j.outcome === 'failed') return j.outcome
  return j.outcome === 'stopped' && text(j.supersededBy) !== null ? 'stopped' : null
}

/**
 * One run's journal, as the tree reads it: its agents by id, and how many attempts each step had
 * — the `Attempt` row names both numbers.
 */
interface RunView {
  run: RunRec
  byAgent: Map<string, JournalAgent>
  attempts: Map<number, number>
}

function runView(run: RunRec): RunView {
  const byAgent = new Map<string, JournalAgent>()
  const attempts = new Map<number, number>()
  for (const j of run.agents) {
    if (!validJournalAgent(j) || byAgent.has(j.agentId)) continue
    byAgent.set(j.agentId, j)
    const step = typeof j.step === 'number' && Number.isInteger(j.step) && j.step > 0 ? j.step : 0
    if (step > 0) attempts.set(step, (attempts.get(step) ?? 0) + 1)
  }
  return { run, byAgent, attempts }
}

/**
 * The real model ids of a record, in the order they were first seen. `<synthetic>` is Claude
 * Code's placeholder for a line no model wrote; the ingest never counts one, and a label must
 * not name one either.
 */
function modelsOf(v: unknown): string[] {
  if (!Array.isArray(v)) return []
  return [...new Set(v.filter((m): m is string => typeof m === 'string' && m !== '' && !m.startsWith('<')))]
    .slice(0, 8)
}

/**
 * What an agent's name is made of: its type — the sidecar's, else the one its launch asked for — and
 * its model: the last real model id its replies were written with, through the model-name helper,
 * else the alias the sidecar or the launch named. Null where none is known. The row, the details and
 * the export (1.6 O2) read the same two.
 */
function nameOf(r: AgentRec, launch: AgentLaunch | null, models: readonly string[]): {
  type: string | null; alias: string | null; model: string | null
} {
  const type = text(r.meta?.agentType) ?? text(launch?.typeHint)
  const alias = text(r.meta?.model) ?? text(launch?.modelHint)
  const lastModel = models.length > 0 ? normalizeModel(models[models.length - 1]) : ''
  return { type, alias, model: lastModel || alias || null }
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

/** The last path segment, whichever separator wrote the path. */
function base(file: string): string {
  return file.slice(Math.max(file.lastIndexOf('/'), file.lastIndexOf('\\')) + 1)
}

function segments(file: string): string[] {
  return file.split(/[\\/]/)
}

/** `agent-<id>.jsonl` → `<id>`; null for any other file. */
function agentIdOf(file: string): string | null {
  const m = /^agent-([A-Za-z0-9_-]+)\.jsonl$/.exec(base(file))
  return m ? m[1] : null
}

/**
 * The session a transcript belongs to, read from where it sits: the directory above the
 * nearest `subagents` for an agent's file, the file name for a main session's.
 */
function sessionOfPath(file: string): { sessionId: string; main: boolean } | null {
  const segs = segments(file)
  const name = segs.pop() ?? ''
  const at = segs.lastIndexOf('subagents')
  if (at > 0) return segs[at - 1] ? { sessionId: segs[at - 1], main: false } : null
  const id = name.replace(/\.jsonl$/, '')
  return id ? { sessionId: id, main: true } : null
}

// ---------------------------------------------------------------------------
// Words
// ---------------------------------------------------------------------------

/** Whether a state is inferred. Only a recorded outcome — done, failed or stopped — is a fact. */
function derivedOf(state: NodeState): boolean {
  return state !== 'done' && state !== 'failed' && state !== 'stopped'
}

/**
 * "14:20" today, "2026-09-01 14:20" on any other day — the Sessions table's own form. Since 1.7 W1
 * the form lives in time.ts (`clockStamp`), where the failed quota attempt's sentence takes it too.
 */
function stamp(ms: number, now: number, tcfg: TimeConfig): string {
  return clockStamp(ms, now, tcfg)
}

/** "3 min ago" / "just now". */
function ago(ms: number, now: number): string {
  return ageText(Math.floor(ms / 1000), now) ?? '–'
}

/**
 * A session's span, from its first line to its last: a duration below SPAN_IN_DAYS_FROM_MS,
 * days and whole hours from it on — "22 d 11 h" in either language, the hours floored, since a
 * session that ran for 22 days and 11 h 59 min has not run for 22 days and 12 hours.
 */
export function spanText(ms: number): string {
  if (!Number.isFinite(ms) || ms < SPAN_IN_DAYS_FROM_MS) return durationText(ms)
  const days = Math.floor(ms / DAY_MS)
  const hours = Math.floor((ms - days * DAY_MS) / HOUR_MS)
  return `${days} d ${hours} h`
}

/**
 * The short id of each agent id of one session: the shortest start of the id, at least
 * MIN_SHORT_ID characters, that no other id of the session starts with — so two agents of a
 * session never carry the same name for want of a character. Claude Code's ids are `a` + 16 hex
 * (every one on this machine), and the leading `a` says nothing; it is left off. Any other id is
 * taken as it is. The longest start an id shares with another is the one it shares with a
 * neighbour in sorted order, so one sort finds every length. An id that is the start of another
 * one, or the same after the `a` is left off, has no start of its own and is shown whole.
 */
export function shortIdsOf(ids: readonly string[]): Map<string, string> {
  const entries = [...new Set(ids)].map((id) => ({ id, hex: /^a([0-9a-f]{16})$/.exec(id)?.[1] ?? id }))
  entries.sort((x, y) => cmp(x.hex, y.hex) || cmp(x.id, y.id))
  const shared = (x: string, y: string): number => {
    let i = 0
    while (i < x.length && i < y.length && x[i] === y[i]) i++
    return i
  }
  const out = new Map<string, string>()
  entries.forEach((e, i) => {
    const near = Math.max(
      i > 0 ? shared(e.hex, entries[i - 1].hex) : 0,
      i + 1 < entries.length ? shared(e.hex, entries[i + 1].hex) : 0,
    )
    const len = Math.max(MIN_SHORT_ID, near + 1)
    out.set(e.id, len >= e.hex.length ? e.hex : e.hex.slice(0, len))
  })
  return out
}

function usageText(c: Counters): string {
  return c.requests > 0 ? compact(billable(bucketOf(c, true))) : '–'
}

/**
 * D10 (1.6): why an output figure is a lower bound — "⚠ lower bound — 2 of 41 replies
 * unfinished": of the replies counted, the ones whose lines never carried a stop reason, so only
 * the output written up to their last line is in the figure. Null when every reply finished, and
 * for nothing counted. The row's mark and the details' Output note say the same, in these words.
 *
 * Measured on this machine (2026-09-23, the last seven days): 293 of 925 agents (32 %) had at
 * least one such reply, 201 of them exactly one; 455 of the 477 such replies were followed by the
 * result of the tool they called — a reply cut off at its tool call, not the agent's last — and
 * only 22 were the file's last reply. So an unfinished reply is no end marker, and most finished
 * agents are not lower bounds at all.
 */
function lowerBoundTextOf(c: Counters | null): string | null {
  if (c === null || c.requests <= 0 || c.outputFinal >= c.requests) return null
  return t('⚠ lower bound — {0} of {1} replies unfinished', full(c.requests - c.outputFinal), full(c.requests))
}

/** A tool name as the aggregator keeps it (§0a.5): its alphabet, at most 100 characters. */
const TOOL_NAME_RE = /^[A-Za-z0-9_.:@/-]{1,100}$/

/**
 * N5 (1.6): the tool an agent's transcript called on its last line — the call it went quiet
 * after — or null: the record names none, or its last call came on a line before the last one,
 * so the silence is not the call's. Checked again, as every value of a record: a snapshot of
 * another build's making may carry anything in it.
 */
function lastCallOf(r: AgentRec, activity: number): string | null {
  const name = typeof r.lastTool === 'string' && TOOL_NAME_RE.test(r.lastTool) ? r.lastTool : null
  return name !== null && stampOf(r.lastToolTs) === activity ? name : null
}

/**
 * N6 (1.6): a model id as a row names it — without the `claude-` every Claude model id starts
 * with, so "claude-opus-5" is "opus-5" on the row. The details' Models row, the markdown and a
 * screen reader's name keep the whole id (`fullLabel`).
 */
function shortModel(id: string): string {
  return id.replace(/^claude-/, '')
}

/**
 * N6: when a session or a run started, as its name says it — "Tue 00:19" within the last
 * WEEKDAY_NAMES_WITHIN_MS, "2026-09-01 00:19" before that — in the configured zone, the day of
 * the clock reading itself (the day boundary is a rule for counting usage, not for naming a time).
 */
function startName(ms: number, now: number, tcfg: TimeConfig): string {
  const time = formatTime(ms, tcfg)
  return now - ms < WEEKDAY_NAMES_WITHIN_MS
    ? `${weekdayWords()[calendarWeekdayOf(ms, tcfg)]} ${time}`
    : `${calendarDayOf(ms, tcfg)} ${time}`
}

/** A session by its id alone — "Session 9d0eb37a": where an agent sits, and the name without a start. */
function sessionIdName(sessionId: string): string {
  return t('Session {0}', sessionId.slice(0, 8))
}

/** N6: "Session Tue 14:20 · 9d0eb37a" — by its first line, then its id; the id alone without a first line. */
function sessionName(sessionId: string, start: number | null, now: number, tcfg: TimeConfig): string {
  return start === null ? sessionIdName(sessionId) : t('Session {0} · {1}', startName(start, now, tcfg), sessionId.slice(0, 8))
}

function runId8(workflowId: string): string {
  return workflowId.replace(/^wf_/, '').slice(0, 8)
}

/** A run by its id alone — "Workflow run cfe7718d": where an agent sits, and the name without a start. */
function runIdName(workflowId: string): string {
  return t('Workflow run {0}', runId8(workflowId))
}

/** N6: "Workflow run Tue 00:19 · cfe7718d" — by its start, then its id; the id alone without a start. */
function runName(workflowId: string, start: number | null, now: number, tcfg: TimeConfig): string {
  return start === null ? runIdName(workflowId) : t('Workflow run {0} · {1}', startName(start, now, tcfg), runId8(workflowId))
}

// ---------------------------------------------------------------------------
// Rejected requests (1.6 N3)
// ---------------------------------------------------------------------------

const API_ERRORS: ReadonlySet<string> = new Set([
  'rate_limit', 'server_error', 'invalid_request', 'authentication_failed', 'max_output_tokens', 'overloaded',
])
const RATE_LIMITS: ReadonlySet<string> = new Set(['five_hour', 'seven_day', 'seven_day_opus', 'seven_day_sonnet'])

/**
 * The request an agent's transcript ended on, when the API rejected it: the record's rejection,
 * while it is no earlier than the transcript's last counted reply — the aggregator clears it when
 * a reply follows, and this says the same of a record that did not come through it. Every value
 * is checked again: a snapshot of another build's making may carry anything in it.
 */
function rejectionOf(r: AgentRec): RejectedRequest | null {
  const x: unknown = r.rejected
  if (!x || typeof x !== 'object') return null
  const v = x as Partial<Record<keyof RejectedRequest, unknown>>
  const at = stampOf(v.at)
  if (at === null || at < r.lastTs) return null
  const status = typeof v.status === 'number' && Number.isInteger(v.status) && v.status >= 100 && v.status <= 599 ? v.status : null
  const error = typeof v.error === 'string' && API_ERRORS.has(v.error) ? v.error as RejectedRequest['error'] : null
  const limit = typeof v.limit === 'string' && RATE_LIMITS.has(v.limit) ? v.limit as RejectedRequest['limit'] : null
  return { at, status, error, limit }
}

/**
 * Why the API rejected a request, as a noun phrase: the limit that refused it — for a rate limit,
 * the only error Claude Code names a limit for — else the kind of error; null when the line named
 * neither.
 */
function rejectionReason(x: RejectedRequest): string | null {
  if (x.error === 'rate_limit' || x.error === null) {
    switch (x.limit) {
      case 'five_hour': return t('5-hour limit')
      case 'seven_day': return t('weekly limit')
      case 'seven_day_opus':
      case 'seven_day_sonnet':
        return t('weekly model limit')
      default: break
    }
    return x.error === 'rate_limit' ? t('usage limit') : null
  }
  switch (x.error) {
    case 'server_error': return t('server error')
    case 'overloaded': return t('overloaded')
    case 'invalid_request': return t('invalid request')
    case 'authentication_failed': return t('authentication failed')
    case 'max_output_tokens': return t('output limit')
    default: return null
  }
}

/**
 * "5-hour limit (HTTP 429)": the reason and the HTTP status the error line gave, each left out
 * when it gave none — "server error", "HTTP 529" — and null when it gave neither.
 */
function rejectionText(x: RejectedRequest): string | null {
  const reason = rejectionReason(x)
  const http = x.status !== null ? `HTTP ${x.status}` : null
  if (reason !== null && http !== null) return `${reason} (${http})`
  return reason ?? http
}

/** The `Last request` row of an agent whose last request was rejected: when, and why. */
function rejectedRows(x: RejectedRequest | null, now: number, tcfg: TimeConfig): DetailRow[] {
  if (x === null) return []
  const at = stamp(x.at, now, tcfg)
  const why = rejectionText(x)
  return [{
    label: t('Last request'),
    value: why === null ? t('rejected at {0}', at) : t('rejected at {0} — {1}', at, why),
    kind: 'sentence',
  }]
}

/**
 * A run's, a session's or a collector's agents that ended on a rejected request, one row per
 * reason — "5-hour limit (HTTP 429): 12" —, the most frequent first: the agents below it and the
 * members of every collector among them (D4), a collector's own members included. A rejection
 * whose line named no reason is counted under `–`. None, no row.
 */
function endedRejectedRows(e: Entry): DetailRow[] {
  const counts = new Map<string, number>()
  const note = (x: RejectedRequest): void => {
    const why = rejectionText(x) ?? '–'
    counts.set(why, (counts.get(why) ?? 0) + 1)
  }
  for (const x of preorder(e)) {
    if (x !== e && x.rejected !== null) note(x.rejected)
    for (const m of x.collected) if (m.rejected !== null) note(m.rejected)
  }
  return [...counts].sort((a, b) => b[1] - a[1] || cmp(a[0], b[0])).map(([why, n]) => ({
    label: t('Ended on a rejected request'), value: `${why}: ${full(n)}`, kind: 'sentence' as const,
  }))
}

interface StateOf {
  state: NodeState
  stateText: string
  /**
   * D6: an outcome the parent recorded, when the transcript went on after it and the state is
   * inferred again — the details keep it in a row of its own. Absent otherwise.
   */
  resumed?: Outcome
}

/**
 * An end the parent recorded: what it was, when, and the parent's own word for it (D7) — a stop is
 * only ever an outcome with its word, since the sentence quotes it. The workflow journal's view
 * of an agent is its run's (`JournalAgent`), and has no time.
 */
type Outcome = { at: number | null } & Ended

/** An end and the word it was recorded with: a completion or a failure may lack one, a stop never does. */
type Ended = { outcome: 'completed' | 'failed'; word: LaunchStatus | null } | { outcome: 'stopped'; word: LaunchStatus }

/**
 * The parent's word, when it is one of the seven the aggregator's status map knows and says this
 * outcome; null otherwise.
 */
function wordOf(v: unknown, outcome: RecordedOutcome): LaunchStatus | null {
  return outcomeOfStatus(v) === outcome ? v as LaunchStatus : null
}

/** An outcome with its word, or null for a stop without one — which the aggregator never records. */
function ended(outcome: RecordedOutcome, word: LaunchStatus | null): Ended | null {
  if (outcome === 'stopped') return word === null ? null : { outcome, word }
  return { outcome, word }
}

function outcomeState(o: Outcome, now: number, tcfg: TimeConfig): StateOf {
  const at = o.at === null ? null : stamp(o.at, now, tcfg)
  if (o.outcome === 'stopped') {
    // D7: the parent's own word, verbatim — ‘killed’, ‘cancelled’ or ‘stopped’.
    return {
      state: 'stopped',
      stateText: at === null
        ? t('Stopped — the parent recorded ‘{0}’.', o.word)
        : t('Stopped — the parent recorded ‘{0}’ at {1}.', o.word, at),
    }
  }
  if (o.outcome === 'failed') {
    return {
      state: 'failed',
      stateText: at === null
        ? t('Failed — the parent recorded the failure.')
        : t('Failed — the parent recorded the failure at {0}.', at),
    }
  }
  return {
    state: 'done',
    stateText: at === null
      ? t('Completed — the parent recorded the result.')
      : t('Completed — the parent recorded the result at {0}.', at),
  }
}

/**
 * A launch's recorded end, with the parent's word. A stop whose word is missing is no outcome:
 * the aggregator never records one without it, so such a record came from somewhere else.
 */
function launchOutcome(l: AgentLaunch | null): Ended | null {
  if (!l || (l.outcome !== 'completed' && l.outcome !== 'failed' && l.outcome !== 'stopped')) return null
  return ended(l.outcome, wordOf(l.outcomeStatus, l.outcome))
}

/**
 * What the parent recorded about an agent. The record's own outcome first; the launch's when the
 * record has none yet — the parent may have written its result before the agent's file was
 * read. Since 1.6 a record's outcome is the parent's alone: the workflow journal's view of the
 * agent is its run's, and `agentState` takes it after this one. A stop only with its word.
 */
function recordedOutcome(r: AgentRec, launch: AgentLaunch | null): Outcome | null {
  const fromLaunch = launchOutcome(launch)
  const same = fromLaunch !== null && fromLaunch.outcome === r.outcome
  if (r.outcome === 'completed' || r.outcome === 'failed' || r.outcome === 'stopped') {
    const own = ended(r.outcome, wordOf(r.outcomeStatus, r.outcome) ?? (same ? fromLaunch.word : null))
    if (own) {
      const at = stampOf(r.outcomeTs) ?? (same ? stampOf(launch?.outcomeTs) : null)
      return { ...own, at }
    }
  }
  if (fromLaunch) return { ...fromLaunch, at: stampOf(launch?.outcomeTs) }
  return null
}

/**
 * Whether the parent's recorded end no longer decides the state: the agent's transcript went on
 * more than RESUMED_AFTER_MS after it. Only an outcome with a time can be outlived — the
 * journal's carries none, so it never is — and a line written in the minute after the result
 * is the tail of the same reply, not a new start.
 */
function resumedAfter(o: Outcome, activity: number): boolean {
  return o.at !== null && activity > o.at + RESUMED_AFTER_MS
}

/**
 * When an agent's transcript last changed: its last counted reply, or the request the API
 * rejected after it (N3) — an error line is a line of the transcript too.
 */
function activityOf(r: AgentRec, rejected: RejectedRequest | null): number {
  return rejected !== null ? Math.max(r.lastTs, rejected.at) : r.lastTs
}

/**
 * What the workflow journal recorded of an agent (D2, D7), with no time — the journal writes
 * none: its result, its failure — retried, when the journal started the same step again — or
 * its replacement, a start of the same step before this attempt recorded anything. `next` is the
 * short id of the attempt that superseded it. Null when the journal recorded no end.
 */
function journalState(j: JournalAgent, next: string | null): StateOf | null {
  const outcome = journalOutcome(j)
  if (outcome === 'completed') {
    return { state: 'done', stateText: t('Completed — the workflow journal recorded the result.') }
  }
  if (outcome === 'failed') {
    return {
      state: 'failed',
      stateText: next !== null
        ? t('Failed, retried — the workflow journal recorded the failure and started the same step again (agent {0}).', next)
        : t('Failed — the workflow journal recorded the failure.'),
    }
  }
  if (outcome === 'stopped' && next !== null) {
    return {
      state: 'stopped',
      stateText: t('Stopped, replaced — the workflow journal started the same step again (agent {0}) before this agent recorded a result.', next),
    }
  }
  return null
}

/**
 * An agent's state: what the parent recorded — with its time, so the agent's own lines can
 * outlive it (D6) — then what the run's journal recorded, which has no time and is never
 * outlived; failing both, what its transcript's clock says. A request the API rejected after the
 * last counted reply (N3) is the transcript's latest line: its time counts as activity, and an
 * inferred state names it — an agent that ended on a rate limit is not one that "may have been
 * stopped".
 */
function agentState(
  r: AgentRec, launch: AgentLaunch | null, journal: StateOf | null, rejected: RejectedRequest | null, now: number,
  tcfg: TimeConfig,
): StateOf {
  const o = recordedOutcome(r, launch)
  const activity = activityOf(r, rejected)
  const last = Math.max(activity, launch ? launch.ts : 0)
  if (o && o.at !== null && resumedAfter(o, activity)) {
    const at = stamp(o.at, now, tcfg)
    if (now - last <= RUNNING_WINDOW_MS) {
      return {
        state: 'running',
        stateText: t('Running — inferred: the transcript changed {0}, after an outcome was recorded at {1}.', ago(last, now), at),
        resumed: o,
      }
    }
    return {
      state: 'unknown',
      stateText: t('Unknown — inferred: the transcript went on after an outcome was recorded at {0}, and has been silent since {1}.',
        at, stamp(activity, now, tcfg)),
      resumed: o,
    }
  }
  if (o) return outcomeState(o, now, tcfg)
  if (journal) return journal
  const why = rejected !== null ? rejectionText(rejected) : null
  if (now - last <= RUNNING_WINDOW_MS) {
    if (rejected !== null) {
      return {
        state: 'running',
        stateText: why === null
          ? t('Running — inferred: the transcript changed {0}; its last request was rejected.', ago(last, now))
          : t('Running — inferred: the transcript changed {0}; its last request was rejected — {1}.', ago(last, now), why),
      }
    }
    return {
      state: 'running',
      stateText: t('Running — inferred: the transcript changed {0} and no result was recorded yet.', ago(last, now)),
    }
  }
  if (rejected !== null) {
    const at = stamp(rejected.at, now, tcfg)
    return {
      state: 'unknown',
      stateText: why === null
        ? t('Unknown — inferred: no result was recorded; the last request, at {0}, was rejected.', at)
        : t('Unknown — inferred: no result was recorded; the last request, at {0}, was rejected — {1}.', at, why),
    }
  }
  // N5: the call the transcript went quiet after, when its last line made one — "after a Bash
  // call" says more than a silence alone about where the agent may have stopped.
  const call = lastCallOf(r, activity)
  if (call !== null) {
    return {
      state: 'unknown',
      stateText: t('Unknown — inferred: no result was recorded and the transcript has been silent since {0}, after a {1} call; the agent may have been stopped.',
        stamp(r.lastTs, now, tcfg), call),
    }
  }
  return {
    state: 'unknown',
    stateText: t('Unknown — inferred: no result was recorded and the transcript has been silent since {0}; the agent may have been stopped.',
      stamp(r.lastTs, now, tcfg)),
  }
}

/** A launch whose agent file was never seen: the launch time is all the activity there is. */
function pendingState(l: AgentLaunch, now: number, tcfg: TimeConfig): StateOf {
  const o = launchOutcome(l)
  if (o) return outcomeState({ ...o, at: stampOf(l.outcomeTs) }, now, tcfg)
  if (now - l.ts <= RUNNING_WINDOW_MS) {
    return {
      state: 'running',
      stateText: t("Running — inferred: the parent recorded the launch {0} and no result yet; the agent's transcript has not been seen yet.",
        ago(l.ts, now)),
    }
  }
  return {
    state: 'unknown',
    stateText: t("Unknown — inferred: the parent recorded the launch at {0} but no result, and the agent's transcript was never seen; the agent may have been stopped.",
      stamp(l.ts, now, tcfg)),
  }
}

function sessionState(main: MainRec | null, now: number, tcfg: TimeConfig): StateOf {
  if (!main) {
    return { state: 'unknown', stateText: t("Unknown — inferred: the session's own transcript has not been read; only its agents were.") }
  }
  if (now - main.lastTs <= SESSION_ACTIVE_MS) {
    return { state: 'active', stateText: t('Active — inferred: the session transcript changed {0}.', ago(main.lastTs, now)) }
  }
  return {
    state: 'idle',
    stateText: t('Idle — inferred: the session transcript has been silent since {0}.', stamp(main.lastTs, now, tcfg)),
  }
}

/**
 * A member below a node as the tally counts it (N1) and a run's state rule reads it: its state,
 * and whether a later attempt of its step superseded it (D7). An agent, a pending launch, or — in
 * a run's collector (D4) — an agent without a counted reply: one the run's journal started whose
 * transcript no record holds, or one whose record counted no request, its transcript nothing but
 * rejected requests.
 */
interface Member {
  /**
   * The agent's id: a collected record's, or the id the journal started a member without a record
   * under — what the export's state of that record is found by (1.6 O2).
   */
  agentId: string
  state: NodeState
  superseded: boolean
  /** N3: the request it ended on, when the API rejected it; null for every other member. */
  rejected: RejectedRequest | null
  /** D4: whether the run's journal recorded its failure — what the collector's all-failed sentence says. */
  journalFailed: boolean
  /** D4: a collected member with a record: its first line and its last activity; null for one without. */
  startTs: number | null
  lastTs: number | null
  /** N8: the effort of its newest reply; null for a member without a record, and for one whose replies carried none. */
  effort: Effort | null
}

function noTally(): AgentTally {
  return { started: 0, done: 0, failed: 0, retried: 0, stopped: 0, running: 0, unknown: 0 }
}

/**
 * One member into a tally, in exactly one field besides `started`: a superseded attempt is
 * retried whatever its own state — it was followed by another — and every other one counts by
 * its state. A member in a state no agent can be in (a snapshot of another build's making) is
 * counted as unknown rather than left out, so the fields still sum to `started`.
 */
function tallyInto(tally: AgentTally, m: Pick<Member, 'state' | 'superseded'>): void {
  tally.started++
  if (m.superseded) tally.retried++
  else if (m.state === 'done' || m.state === 'failed' || m.state === 'stopped' || m.state === 'running') tally[m.state]++
  else tally.unknown++
}

/**
 * The tally of everything below a node (N1), on the whole tree: every agent and launch at any
 * depth, and the members every run's collector among them holds — its agents without a counted
 * reply (D4). The node itself is not counted, whatever it is; a collector's own members are what
 * its tally counts.
 */
function tallyBelow(e: Entry): AgentTally {
  const out = noTally()
  for (const x of preorder(e)) {
    if (x !== e && isAgentLike(x)) tallyInto(out, x)
    for (const m of x.collected) tallyInto(out, m)
  }
  return out
}

/**
 * "427 started · 112 ✓ · 12 ✕ · 295 ↻ · ~8 ?" — the started agents, then each state at least one
 * of them is in, with the glyph its rows carry: done, failed, retried, stopped, running,
 * unknown. The two inferred states carry the tilde every estimate on the page carries. The Quick
 * Pick writes its sessions' tallies together in the same words (1.6 O2).
 */
export function tallyText(n: AgentTally): string {
  const parts = [t('{0} started', full(n.started))]
  const glyphs: Array<[number, string]> = [
    [n.done, `${full(n.done)} ✓`], [n.failed, `${full(n.failed)} ✕`], [n.retried, `${full(n.retried)} ↻`],
    [n.stopped, `${full(n.stopped)} ■`], [n.running, `~${full(n.running)} ●`], [n.unknown, `~${full(n.unknown)} ?`],
  ]
  for (const [count, part] of glyphs) if (count > 0) parts.push(part)
  return parts.join(' · ')
}

/** The tally in words, in the same order — what a screen reader says in place of the glyphs. */
export function tallySpoken(n: AgentTally): string {
  const parts = [t('{0} started', full(n.started))]
  if (n.done > 0) parts.push(t('{0} done', full(n.done)))
  if (n.failed > 0) parts.push(t('{0} failed', full(n.failed)))
  if (n.retried > 0) parts.push(t('{0} retried', full(n.retried)))
  if (n.stopped > 0) parts.push(t('{0} stopped', full(n.stopped)))
  if (n.running > 0) parts.push(t('about {0} running', full(n.running)))
  if (n.unknown > 0) parts.push(t('about {0} unknown', full(n.unknown)))
  return parts.join(', ')
}

/**
 * A workflow run's state from its members' tally (§3.0 a of the 1.6 spec) — its agents with a
 * record, the ones its journal started without one, and the launches inside it — so the run's
 * row and its tally can never disagree. A superseded attempt is closed whatever its own state:
 * the tally has it under retried. Of the others, one running makes the run running; one open —
 * neither recorded nor running — makes it unknown; with every member closed, one completion
 * makes it done, whatever failed beside it (the tally shows the failures; they are not the
 * run's end); else a failure makes it failed; else the last attempt of every step was stopped.
 * One failure among completed agents never fails a run, and a run with no member is unknown.
 */
function workflowState(n: AgentTally): StateOf {
  if (n.running > 0) {
    return { state: 'running', stateText: t('Running — inferred: at least one agent of this run is running.') }
  }
  if (n.started === 0 || n.unknown > 0) {
    return { state: 'unknown', stateText: t('Unknown — inferred: not every agent of this run has a recorded outcome, and none is running.') }
  }
  if (n.done > 0) {
    return { state: 'done', stateText: t('Done — every agent of this run has a recorded outcome, and at least one completed.') }
  }
  if (n.failed > 0) {
    return { state: 'failed', stateText: t('Failed — every agent of this run has a recorded outcome, and none completed.') }
  }
  return {
    state: 'stopped',
    stateText: t('Stopped — every agent of this run has a recorded outcome, and none completed: the last attempt of each step was stopped.'),
  }
}

/**
 * The state of a run's collector (D4), by the rule a run's state follows (§3.0 a), over the members
 * it holds: one running makes it running; one open — neither recorded nor running — unknown; with
 * every one closed, done when one completed that nothing superseded, else failed when one failed,
 * else stopped. When every member failed — the label says so too — its sentence says that the
 * workflow journal recorded each failure, where it did; and when every member was superseded —
 * their later attempts are rows of the run — their own ends decide, since the tally then counts
 * them all as retried.
 */
function collectorState(members: readonly Member[]): StateOf {
  const n = noTally()
  for (const m of members) tallyInto(n, m)
  if (n.running > 0) {
    return { state: 'running', stateText: t('Running — inferred: at least one of these agents is running.') }
  }
  if (n.started === 0 || n.unknown > 0) {
    return {
      state: 'unknown',
      stateText: t('Unknown — inferred: not every one of these agents has a recorded outcome, and none is running.'),
    }
  }
  if (members.every((m) => m.state === 'failed' && m.journalFailed)) {
    return { state: 'failed', stateText: t('Failed — the workflow journal recorded a failure for each of them.') }
  }
  const own = n.retried === n.started
  if (own ? members.some((m) => m.state === 'done') : n.done > 0) {
    return {
      state: 'done',
      stateText: t('Done — every one of these agents has a recorded outcome, and at least one completed.'),
    }
  }
  if (own ? members.some((m) => m.state === 'failed') : n.failed > 0) {
    return { state: 'failed', stateText: t('Failed — every one of these agents has a recorded outcome, and none completed.') }
  }
  return {
    state: 'stopped',
    stateText: t('Stopped — every one of these agents has a recorded outcome, and none completed: the last attempt of each step was stopped.'),
  }
}

/**
 * The label of a run's collector (D4): how many agents it holds, and — when every one of them
 * failed — that they failed before their first reply.
 */
function collectorLabel(members: readonly Member[]): string {
  const n = full(members.length)
  return members.length > 0 && members.every((m) => m.state === 'failed')
    ? t('{0} agent(s) failed before their first reply', n)
    : t('{0} agent(s) without a counted reply', n)
}

/** The latest of a run's launches — a resume is another launch of the same run —, by time, then by id. */
function latestLaunch(launches: readonly RunLaunch[]): RunLaunch | null {
  let out: RunLaunch | null = null
  for (const l of launches) {
    if (out === null || l.ts > out.ts || (l.ts === out.ts && cmp(l.toolUseId, out.toolUseId) > 0)) out = l
  }
  return out
}

/**
 * N4 (§3.0 c, the first source): the end the parent recorded for a workflow run — the task
 * notification, or the tool result, that answered its **latest** launch — with its time and its
 * word. A latest launch still under way (`launched`: a resume in progress) gives none: what an
 * earlier launch recorded is history, which the `Launches` row counts. A stop only with its word.
 */
function parentRunEnd(latest: RunLaunch | null): Outcome | null {
  if (latest === null) return null
  const o = latest.outcome
  if (o !== 'completed' && o !== 'failed' && o !== 'stopped') return null
  const e = ended(o, wordOf(latest.outcomeStatus, o))
  return e === null ? null : { ...e, at: stampOf(latest.outcomeTs) }
}

/** The run's end as the parent recorded it, in the run's own sentence — the time left out when it has none. */
function runOutcomeState(o: Outcome, now: number, tcfg: TimeConfig): StateOf {
  const at = o.at === null ? null : stamp(o.at, now, tcfg)
  if (o.outcome === 'stopped') {
    // D7 for runs: the parent's own word, verbatim — ‘stopped’, ‘killed’ or ‘cancelled’.
    return {
      state: 'stopped',
      stateText: at === null
        ? t('Stopped — the parent recorded ‘{0}’ for this run.', o.word)
        : t('Stopped — the parent recorded ‘{0}’ for this run at {1}.', o.word, at),
    }
  }
  if (o.outcome === 'failed') {
    return {
      state: 'failed',
      stateText: at === null
        ? t('Failed — the parent recorded the failure of this run.')
        : t('Failed — the parent recorded the failure of this run at {0}.', at),
    }
  }
  return {
    state: 'done',
    stateText: at === null
      ? t('Completed — the parent recorded the end of this run.')
      : t('Completed — the parent recorded the end of this run at {0}.', at),
  }
}

/** Claude Code's run record of a run (1.6 L4), each of its seven fields checked again: a snapshot may carry anything. */
function recordOf(run: RunRec | null): RunRecordFields | null {
  return run === null ? null : cleanRunRecord(run.record)
}

/**
 * The third source of a run's end (§3.0 c): Claude Code's own run record (1.6 L4) — its `status`,
 * quoted as it was written: `completed` makes the run done, `failed` failed, and `killed`,
 * `stopped` and `cancelled` stopped; `running`, or no status, is no end. The record states its
 * run's start and length, so its end has a time, and it is outlived as the parent's is: a member
 * whose last line came more than RESUMED_AFTER_MS after it makes the run's state its members' again.
 * A record without both figures has no time and is never outlived, as the journal's ends are not.
 */
function recordRunEnd(record: RunRecordFields | null, lastActivity: number | null): StateOf | null {
  const word = record?.status ?? null
  if (record === null || word === null || word === 'running') return null
  const end = record.startTime !== null && record.durationMs !== null ? record.startTime + record.durationMs : null
  if (end !== null && lastActivity !== null && lastActivity > end + RESUMED_AFTER_MS) return null
  if (word === 'completed') return { state: 'done', stateText: t("Completed — Claude Code's run record says ‘{0}’.", word) }
  if (word === 'failed') return { state: 'failed', stateText: t("Failed — Claude Code's run record says ‘{0}’.", word) }
  return { state: 'stopped', stateText: t("Stopped — Claude Code's run record says ‘{0}’.", word) }
}

/**
 * A workflow run's state (§3.0 c): the end its parent recorded for its latest launch, then — once
 * every member is closed — what they came to (the journal's view, `workflowState`), then Claude
 * Code's run record (`recordRunEnd`), then what its members' clocks say. A recorded end does not
 * close a member: one without an outcome of its own keeps its own state and counts so in the
 * tally, so a done run may show an agent still running beside it for up to ten minutes. The
 * parent's end is outlived like an agent's (D6): a member whose last line came more than
 * RESUMED_AFTER_MS after it makes the run's state an inference again, the recorded end kept for
 * the details (`resumed`); the record's is outlived the same way, its row saying what it said. A run no
 * agent has written to yet — nothing but its launch — is running for ten minutes after the
 * launch, then unknown.
 */
function runState(
  tally: AgentTally, latest: RunLaunch | null, run: RunRec | null, lastActivity: number | null, now: number, tcfg: TimeConfig,
): StateOf {
  const parent = parentRunEnd(latest)
  const outlived = parent !== null && parent.at !== null && lastActivity !== null && lastActivity > parent.at + RESUMED_AFTER_MS
  if (parent !== null && !outlived) return runOutcomeState(parent, now, tcfg)
  if (tally.started > 0 && tally.running === 0 && tally.unknown === 0) return workflowState(tally)
  const record = recordRunEnd(recordOf(run), lastActivity)
  if (record !== null) return record
  if (tally.started === 0 && latest !== null) {
    if (now - latest.ts <= RUNNING_WINDOW_MS) {
      return {
        state: 'running',
        stateText: t('Running — inferred: the parent launched this run {0} and no agent has written yet.', ago(latest.ts, now)),
      }
    }
    return {
      state: 'unknown',
      stateText: t('Unknown — inferred: the parent launched this run at {0}, but no agent of it was ever seen.', stamp(latest.ts, now, tcfg)),
    }
  }
  const st = workflowState(tally)
  if (!outlived || parent === null || parent.at === null) return st
  if (st.state === 'running') {
    return {
      state: 'running',
      stateText: t('Running — inferred: an agent of this run wrote on after the parent recorded its end at {0}.', stamp(parent.at, now, tcfg)),
      resumed: parent,
    }
  }
  return { ...st, resumed: parent }
}

/**
 * The state of an agent its run's journal started but no transcript of which was counted (D2):
 * what the journal recorded; else running while the journal changed within RUNNING_WINDOW_MS or
 * one of the run's other members runs — the run is at work, and this one may be what it waits
 * on —, else unknown. A member of the run, counted in its state and its count; no row of its own.
 */
function journalOnlyState(j: JournalAgent, run: RunRec, siblingRuns: boolean, now: number): NodeState {
  const outcome = journalOutcome(j)
  if (outcome === 'completed') return 'done'
  if (outcome !== null) return outcome
  const last = stampOf(run.lastTs)
  return siblingRuns || (last !== null && now - last <= RUNNING_WINDOW_MS) ? 'running' : 'unknown'
}

// ---------------------------------------------------------------------------
// Detail rows
// ---------------------------------------------------------------------------

/**
 * When a node started, how long it ran and when it last changed. A session's start is its
 * transcript's first line and its length a span (D5): it may run for weeks, and "Started"
 * beside "22 d 11 h" would read as one sitting. The last activity is the row the page's clock
 * ticks in (`live`), in place of the age written here, which the markdown keeps. An agent nothing
 * of which was counted (`measured` false, D4) has no duration: its start and its last line are
 * times, but the length between them is a figure, and it has none.
 */
function timeRows(
  start: number | null, last: number | null, now: number, tcfg: TimeConfig, session = false, measured = true,
): DetailRow[] {
  const length = !measured || start === null || last === null ? '–' : session ? spanText(last - start) : durationText(last - start)
  return [
    { label: session ? t('Since first line') : t('Started'), value: start === null ? '–' : stamp(start, now, tcfg) },
    { label: session ? t('Span') : t('Duration'), value: length },
    last === null
      ? { label: t('Last activity'), value: '–' }
      : { label: t('Last activity'), value: stamp(last, now, tcfg), note: ago(last, now), live: 'ago' },
  ]
}

/**
 * 1.6 L4: Claude Code's run record, in one sentence of all seven fields — its status word as written,
 * when the run started, how many agents it counts, its tokens and its tool calls, how long it took,
 * and its default model —, each part a dash when the record does not state it, and the whole row a
 * dash when there is no record. Claude Code's own figures: they are shown beside the tree's, never
 * added to them.
 */
function recordRow(record: RunRecordFields | null, now: number, tcfg: TimeConfig): DetailRow {
  const label = t("Claude Code's run record")
  if (record === null) return { label, value: '–' }
  const or = <T>(v: T | null, f: (x: T) => string): string => (v === null ? '–' : f(v))
  return {
    label,
    value: t('{0} · started {1} · {2} agents · {3} tokens · {4} tool calls · {5} · default model {6}',
      record.status ?? '–',
      or(record.startTime, (x) => stamp(x, now, tcfg)),
      or(record.agentCount, full),
      or(record.totalTokens, compact),
      or(record.totalToolCalls, full),
      or(record.durationMs, durationText),
      record.defaultModel ?? '–'),
    note: t("Claude Code's own figures, never added to a total"),
    kind: 'sentence',
  }
}

/** The row the Copy ID button copies: the whole identifier, which a name only starts. */
function idRow(id: string): DetailRow {
  return { label: t('ID'), value: id, copy: true }
}

/** O4: no hook installed — no entry, and no node carries a marker. */
const NO_HOOK: ReadonlyMap<string, HookEntry> = new Map()

/** O4: the marker a wait puts on a row — "waiting for approval", "waiting for input" —, none for `none`. */
function hookWaitText(w: HookWait): string | null {
  return w === 'permission' ? t('waiting for approval') : w === 'input' ? t('waiting for input') : null
}

/** O4: the sentence the state line gains — who said so, when, and what. */
function hookSentence(w: HookWait, at: string): string {
  return w === 'permission'
    ? t('The agent hook reported at {0}: waiting for approval.', at)
    : t('The agent hook reported at {0}: waiting for input.', at)
}

/**
 * O4 (spec §3 O4 step 3, §7c "Probe complete" and "Hooks reference"): the wait the agent hook
 * reports for a node, or null. The hook's latest call for the node counts — for an agent the call
 * inside it (its `agent_id`), for a session a call without an agent: a permission request of the
 * session itself, or one Claude Code sent without naming the agent — and only while it
 * reported a wait (a stop, a start or a notification that asks nothing clears it), is younger than
 * HOOK_MAX_AGE_MS and newer than the node's last activity, which answered it. An agent whose end
 * was recorded waits for nothing; a session's wait for input counts only while the session is
 * active — an idle prompt is every finished session's state. A marker, never a state: whatever
 * the hook said, the node keeps the state its lines give it.
 */
function hookOf(e: Entry, sessionId: string, env: RootEnv): HookEntry | null {
  let h: HookEntry | undefined
  if (e.kind === 'agent') {
    if (e.id === null || !derivedOf(e.state)) return null
    h = env.hook.get(hookKey(sessionId, e.id))
  } else if (e.kind === 'session') {
    h = env.hook.get(hookKey(sessionId, null))
  } else {
    return null
  }
  if (!h || (h.wait !== 'permission' && h.wait !== 'input')) return null
  if (typeof h.ts !== 'number' || !Number.isFinite(h.ts) || env.now - h.ts > HOOK_MAX_AGE_MS) return null
  if (e.lastTs !== null && h.ts <= e.lastTs) return null
  if (e.kind === 'session' && h.wait === 'input' && e.state !== 'active') return null
  return h
}

/** O4: the details' row "Agent hook" — the marker and the time of the call, as D6's "done at 14:20" reads. */
function hookRows(e: Entry, now: number, tcfg: TimeConfig): DetailRow[] {
  if (e.hookWait === null || e.hookAt === null) return []
  return [{ label: t('Agent hook'), value: t('{0} at {1}', e.hookWait, stamp(e.hookAt, now, tcfg)) }]
}

/**
 * D6: the outcome the parent recorded for an agent that wrote on after it — the state word and
 * when, "done at 14:20". Only while the state is inferred again; a recorded state says it itself.
 */
function recordedRows(o: Outcome | undefined, now: number, tcfg: TimeConfig): DetailRow[] {
  if (!o || o.at === null) return []
  const word = o.outcome === 'failed' ? t('failed') : o.outcome === 'stopped' ? t('stopped') : t('done')
  return [{ label: t('Recorded'), value: t('{0} at {1}', word, stamp(o.at, now, tcfg)) }]
}

/**
 * Requests — 1.5 called them turns; a request is what the API was asked, and what the overview
 * line counts (L2) —, the token kinds of the totals table and the tool calls. Nothing counted is a
 * dash throughout — a record without a request has no zero to report. Output is a lower bound when
 * a reply never reached a line with a stop reason, and its note says how many of the replies did
 * not (D10, see lowerBoundTextOf) — the same words the row's mark carries. A session leaves out the
 * usage: its `Own transcript` row, first in its details, is that figure already (L2).
 */
function countRows(c: Counters | null, usage = true): DetailRow[] {
  if (c === null || c.requests === 0) {
    return [t('Requests'), ...(usage ? [t('Usage')] : []), t('Fresh input'), t('Cache write 5m'), t('Cache write 1h'),
      t('Cache read'), t('Output'), t('Reasoning'), t('Tool calls')].map((label) => ({ label, value: '–' }))
  }
  const b = bucketOf(c, true)
  const output: DetailRow = { label: t('Output'), value: tokens(c.output) }
  const bound = lowerBoundTextOf(c)
  if (bound !== null) output.note = bound
  return [
    { label: t('Requests'), value: full(c.requests) },
    ...(usage ? [{ label: t('Usage'), value: compact(billable(b)) }] : []),
    { label: t('Fresh input'), value: tokens(freshInput(b)) },
    { label: t('Cache write 5m'), value: tokens(Math.max(0, c.cacheWrite - c.cacheWrite1h)) },
    { label: t('Cache write 1h'), value: tokens(c.cacheWrite1h) },
    { label: t('Cache read'), value: tokens(c.cacheRead) },
    output,
    { label: t('Reasoning'), value: tokens(c.reasoning) },
    { label: t('Tool calls'), value: full(c.toolCalls) },
  ]
}

/**
 * Claude Code's own figures for a sync agent, from the tool result that returns it: its
 * `totalTokens` is the context of the agent's last request with its reply — input, cache write,
 * cache read and output of that one request (measured: a median ratio of 1.000) — not what the
 * agent used (a median 0.83 of our usage), so the row says which figure it is. Its words, never
 * ours, and never added to anything. A sentence, not a figure: it takes the whole width.
 */
function reportRows(l: AgentLaunch | null): DetailRow[] {
  const r = reportOf(l)
  if (r === null) return []
  return [{
    label: t('Report from Claude Code'),
    value: t('context at the end {0} (incl. cache reads and the reply) · {1} from the start · {2} tool calls',
      compact(r.tokens), durationText(r.durationMs), full(r.toolUses)),
    note: t("Claude Code's own figure for this agent, never added to a total"),
    kind: 'sentence',
  }]
}

// ---------------------------------------------------------------------------
// 1.6 O3: further metadata without content
// ---------------------------------------------------------------------------

/** A whole count of at least 0, or null for anything else — a snapshot of another build's making may carry anything. */
function wholeCount(v: unknown): number | null {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : null
}

/** A token figure of at least 0, or null. */
function tokenFigure(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null
}

/**
 * O3 (§0a.6): how many of an agent's tool calls came back marked as an error — "3 of 41 tool calls".
 * Only for an agent that called a tool or had one fail, and only while its record counts them: a
 * record restored from before O3 that the replay could not read again says nothing, never a zero.
 */
function toolErrorRows(r: AgentRec, c: Counters): DetailRow[] {
  const errors = wholeCount(r.toolErrors)
  if (errors === null || c.requests <= 0 || (errors === 0 && c.toolCalls <= 0)) return []
  return [{ label: t('Tool errors'), value: t('{0} of {1} tool calls', full(errors), full(c.toolCalls)) }]
}

/** The six reasons a cache miss may have, in the order the words list them when they are as frequent. */
const CACHE_MISS_ORDER = [
  'previous_message_not_found', 'unavailable', 'messages_changed', 'model_changed', 'tools_changed', 'system_changed',
] as const

/** A reason in the reader's words. A switch rather than a table: `t()` needs a literal message. */
function cacheMissWord(kind: typeof CACHE_MISS_ORDER[number]): string {
  switch (kind) {
    case 'previous_message_not_found': return t('previous message not found')
    case 'unavailable': return t('cache unavailable')
    case 'messages_changed': return t('messages changed')
    case 'model_changed': return t('model changed')
    case 'tools_changed': return t('tools changed')
    default: return t('system prompt changed')
  }
}

/**
 * O3 (§0a.7): why the cache missed on an agent's requests — "model changed 3 · cache unavailable 1",
 * the most frequent reason first — and, as its note, the input tokens those misses state were not
 * read from the cache (Claude Code gives the figure for a changed message, model, tool set or system
 * prompt, not for an unavailable cache or a previous message it could not find): only a stated figure
 * is summed, and no note says "0" for none stated. No miss, no row.
 */
function cacheMissRows(r: AgentRec): DetailRow[] {
  const by: unknown = r.cacheMisses
  if (!by || typeof by !== 'object') return []
  const counts = CACHE_MISS_ORDER
    .map((kind) => [kind, wholeCount((by as Record<string, unknown>)[kind]) ?? 0] as const)
    .filter(([, n]) => n > 0)
    .sort((a, b) => b[1] - a[1])
  if (counts.length === 0) return []
  const tokensMissed = tokenFigure(r.cacheMissedTokens) ?? 0
  return [{
    label: t('Cache misses'),
    value: counts.map(([kind, n]) => `${cacheMissWord(kind)} ${full(n)}`).join(' · '),
    ...(tokensMissed > 0 ? { note: t('{0} tokens not read from the cache', compact(tokensMissed)) } : {}),
    kind: 'sentence',
  }]
}

/**
 * O3 (§0a.10): how often a transcript was compacted, and the last time — "2 · last at 14:20 (manual,
 * 167.2K → 12.4K)": when, whether it was asked for, the context before and after it. No compaction,
 * no row; a part the line did not give is `–`.
 *
 * 1.7 V-A: one whole sentence per trigger — manual, auto, none recorded — so the trigger's word is
 * translated inside its sentence and never as a bare `auto` or `manual`, a word other values share
 * (a permission mode is `auto` too).
 */
function compactionRows(r: AgentRec | MainRec | null, now: number, tcfg: TimeConfig): DetailRow[] {
  const n = r === null ? null : wholeCount(r.compactions)
  if (r === null || n === null || n === 0) return []
  const last: unknown = r.lastCompaction
  const c = last && typeof last === 'object' ? last as Partial<Record<keyof CompactionRec, unknown>> : null
  const at = c !== null ? stampOf(c.at) : null
  if (c === null || at === null) return [{ label: t('Compactions'), value: full(n) }]
  const figure = (v: unknown): string => {
    const x = tokenFigure(v)
    return x === null ? '–' : compact(x)
  }
  const count = full(n)
  const when = stamp(at, now, tcfg)
  const pre = figure(c.preTokens)
  const post = figure(c.postTokens)
  const value = c.trigger === 'manual' ? t('{0} · last at {1} (manual, {2} → {3})', count, when, pre, post)
    : c.trigger === 'auto' ? t('{0} · last at {1} (auto, {2} → {3})', count, when, pre, post)
      : t('{0} · last at {1} (–, {2} → {3})', count, when, pre, post)
  return [{ label: t('Compactions'), value, kind: 'sentence' }]
}

/** A Claude Code version as its lines write it — three numbers — else none. */
const VERSION_SHAPE = /^\d{1,3}\.\d{1,3}\.\d{1,4}$/
const PERMISSION_MODES: ReadonlySet<string> = new Set(['default', 'acceptEdits', 'bypassPermissions', 'plan', 'auto'])

/**
 * O3 (§0a.8, §0a.9): which Claude Code wrote the transcript — its version, a dash where its lines
 * named none — and the permission mode its prompt line named, as Claude Code writes the word, only
 * where one was named (an agent's transcript names none on this machine).
 */
function writerRows(r: AgentRec | MainRec | null): DetailRow[] {
  const version: unknown = r?.ccVersion
  const mode: unknown = r?.permissionMode
  return [
    { label: t('Claude Code version'), value: typeof version === 'string' && VERSION_SHAPE.test(version) ? version : '–' },
    ...(typeof mode === 'string' && PERMISSION_MODES.has(mode) ? [{ label: t('Permission mode'), value: mode }] : []),
  ]
}

/**
 * O3 (§0a.11): the agent that spawned this one, as its sidecar names it — the link when no launch
 * names a spawner. Checked again as an id.
 */
function parentAgentIdOf(r: AgentRec): string | null {
  const v: unknown = r.meta?.parentAgentId
  return typeof v === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(v) && v !== r.agentId ? v : null
}

function depthText(v: unknown): string {
  return typeof v === 'number' && Number.isInteger(v) && v >= 1 ? String(v) : '–'
}

/**
 * L2 (1.6): an agent's line under its state — "1.2K in 29 min 00 s · 5 requests · 3 tool calls": its
 * usage, its duration, its requests and its tool calls. One sentence for each count that is one, so
 * a translator has the whole line each time.
 */
function overviewOf(c: Counters, duration: string): string {
  const usage = usageText(c)
  const requests = full(c.requests)
  const calls = full(c.toolCalls)
  if (c.requests === 1 && c.toolCalls === 1) return t('{0} in {1} · 1 request · 1 tool call', usage, duration)
  if (c.requests === 1) return t('{0} in {1} · 1 request · {2} tool calls', usage, duration, calls)
  if (c.toolCalls === 1) return t('{0} in {1} · {2} requests · 1 tool call', usage, duration, requests)
  return t('{0} in {1} · {2} requests · {3} tool calls', usage, duration, requests, calls)
}

/** "76 %", a whole percent — "<1 %" for a share that is there but rounds to none. */
function shareText(share: number): string {
  return share < 0.005 ? '<1 %' : `${full(Math.round(share * 100))} %`
}

/**
 * L2 (1.6): an agent's token mix — how its tokens split between fresh input, cache write, cache
 * read and output, as a bar and in words: "fresh 2 % · cache write 18 % · cache read 76 % · output
 * 4 %". Of the four together (a share of the usage alone would leave the cache reads out, which is
 * most of what an agent's requests carry); a kind with no token is left out, and the parts' shares
 * sum to 1. Only for an agent with a counted request: nothing counted has no mix.
 */
function mixRows(c: Counters): DetailRow[] {
  if (c.requests <= 0) return []
  const kinds: Array<[MixPart['part'], number]> = [
    ['fresh', freshInput(bucketOf(c, true))], ['cacheWrite', c.cacheWrite], ['cacheRead', c.cacheRead], ['output', c.output],
  ]
  const total = kinds.reduce((sum, [, n]) => sum + n, 0)
  if (!(total > 0)) return []
  // A switch rather than a table: `t()` needs a literal message.
  const words = (part: MixPart['part'], share: string): string => {
    switch (part) {
      case 'fresh': return t('fresh {0}', share)
      case 'cacheWrite': return t('cache write {0}', share)
      case 'cacheRead': return t('cache read {0}', share)
      default: return t('output {0}', share)
    }
  }
  const parts: MixPart[] = kinds.filter(([, n]) => n > 0)
    .map(([part, n]) => ({ part, share: n / total, label: words(part, shareText(n / total)) }))
  return [{ label: t('Token mix'), value: parts.map((p) => p.label).join(' · '), kind: 'bar', parts }]
}

/**
 * L2: the context an agent's newest request carried — its input, cache write and cache read, the
 * running maximum over the lines of that reply (the aggregator's `lastContext`) —, what the next
 * request would have started from. A dash for an agent nothing of which was counted, and for a
 * record that does not say (one from before 1.6, until the replay fills it in).
 */
function contextRows(r: AgentRec, c: Counters): DetailRow[] {
  const v: unknown = r.lastContext
  if (c.requests <= 0 || typeof v !== 'number' || !Number.isFinite(v) || v <= 0) return [{ label: t('Context at the end'), value: '–' }]
  return [{ label: t('Context at the end'), value: compact(v), note: t("the last request's input, cache reads and writes") }]
}

/**
 * L2: what an agent used per minute of its duration — from PER_MINUTE_FROM_MS on; below it a rate
 * is a division by a fraction of a minute, a burst of one reply rather than a pace.
 */
function perMinuteRows(c: Counters, ms: number): DetailRow[] {
  if (c.requests <= 0 || !Number.isFinite(ms) || ms < PER_MINUTE_FROM_MS) return []
  return [{ label: t('Per minute'), value: compact((billable(bucketOf(c, true)) * 60_000) / ms) }]
}

const EFFORT_LEVELS: ReadonlySet<string> = new Set(['low', 'medium', 'high', 'xhigh', 'max'])

/** A level of effort, checked again — a snapshot of another build's making may carry anything — or null. */
function effortLevel(v: unknown): Effort | null {
  return typeof v === 'string' && EFFORT_LEVELS.has(v) ? v as Effort : null
}

/**
 * N8 (1.6): the efforts an agent's replies were written at, in the order first seen, each checked
 * again; the newest reply's alone when the record lists none.
 */
function effortsOf(r: AgentRec): Effort[] {
  const list: Effort[] = []
  for (const e of Array.isArray(r.efforts) ? r.efforts : []) {
    const level = effortLevel(e)
    if (level !== null && !list.includes(level)) list.push(level)
  }
  const last = effortLevel(r.effort)
  return list.length === 0 && last !== null ? [last] : list
}

/** "xhigh", or "high, then xhigh" where the replies' effort changed; '–' where none was recorded. */
function effortText(list: readonly Effort[]): string {
  if (list.length === 0) return '–'
  return list.slice(1).reduce<string>((acc, e) => t('{0}, then {1}', acc, e), list[0])
}

/**
 * N8: the agents below a run or a session by the effort of their newest reply — "xhigh 412 · max 12
 * · – 3", the most frequent first; `–` counts the ones with none recorded: a launch nobody has read
 * a line of, an agent its journal started without a transcript, one whose replies carried none. The
 * members the tally counts, each once (its `started`). None, no row.
 */
function effortCountRows(e: Entry): DetailRow[] {
  const counts = new Map<string, number>()
  const note = (effort: Effort | null): void => {
    const k = effort ?? '–'
    counts.set(k, (counts.get(k) ?? 0) + 1)
  }
  for (const x of preorder(e)) {
    if (x !== e && isAgentLike(x)) note(x.effort)
    for (const m of x.collected) note(m.effort)
  }
  if (counts.size === 0) return []
  const value = [...counts].sort((a, b) => b[1] - a[1] || cmp(a[0], b[0])).map(([k, n]) => `${k} ${full(n)}`).join(' · ')
  return [{ label: t('Agents by effort'), value }]
}

/**
 * The most intervals that share a moment, both ends included — two agents whose lines meet at one
 * millisecond ran at once. A sweep over the starts and the ends, a start before an end at the same
 * time.
 */
export function mostAtOnce(spans: ReadonlyArray<readonly [number, number]>): number {
  const events: Array<[number, number]> = []
  for (const [a, b] of spans) {
    if (!Number.isFinite(a) || !Number.isFinite(b)) continue
    events.push([Math.min(a, b), 1], [Math.max(a, b), -1])
  }
  events.sort((x, y) => x[0] - y[0] || y[1] - x[1])
  let now = 0
  let most = 0
  for (const [, step] of events) {
    now += step
    if (now > most) most = now
  }
  return most
}

/**
 * L2: how many of a run's agents worked at the same time, at most — over each member's first line
 * to its last activity (a collected member with a record included; one its journal started without a
 * transcript has no time to place). A dash for a run none of whose members has one.
 */
function parallelismRows(w: Entry): DetailRow[] {
  const spans: Array<[number, number]> = []
  for (const x of preorder(w)) {
    if (x !== w && x.kind === 'agent' && x.startTs !== null && x.lastTs !== null) spans.push([x.startTs, x.lastTs])
    for (const m of x.collected) if (m.startTs !== null && m.lastTs !== null) spans.push([m.startTs, m.lastTs])
  }
  const most = mostAtOnce(spans)
  return [{ label: t('Parallelism'), value: most > 0 ? t('up to {0} at once', full(most)) : '–' }]
}

/**
 * L2: where a workflow agent stands in its run by usage — "3 of 41 by usage" —, among the run's
 * agents with a counted request (an agent with a bigger usage ranks before it; equal ones share a
 * place). Only in a run of at least two such agents, and only for one of them.
 */
function rankRows(e: Entry, run: Entry | null): DetailRow[] {
  if (run === null || e.counters === null || e.counters.requests <= 0) return []
  const counted = [...preorder(run)].filter((x) => x.kind === 'agent' && x.counters !== null && x.counters.requests > 0)
  if (counted.length < 2) return []
  const used = (x: Entry): number => (x.counters === null ? 0 : billable(bucketOf(x.counters, true)))
  const own = used(e)
  const place = 1 + counted.filter((x) => used(x) > own).length
  return [{ label: t('Rank in run'), value: t('{0} of {1} by usage', full(place), full(counted.length)) }]
}

// ---------------------------------------------------------------------------
// The forest
// ---------------------------------------------------------------------------

interface Entry {
  key: string
  kind: TreeNode['kind']
  /** N6: the row's name, the model in its short form. */
  label: string
  /** N6: the same with the whole model id — details, markdown, a screen reader's name. */
  fullLabel: string
  /**
   * A session's and a run's name by its id alone — "Session 9d0eb37a", "Workflow run cfe7718d" —
   * for the running list's line of where an agent sits; null for every other node.
   */
  idName: string | null
  sub: string | null
  state: NodeState
  stateText: string
  usage: string
  /** D5: a session's agents' usage, beside its own; null for every other node and a session without agents. */
  usageAgents: string | null
  lowerBound: boolean
  /** D10: "⚠ lower bound — 2 of 41 replies unfinished" where `lowerBound`; null elsewhere. */
  lowerBoundText: string | null
  duration: string
  startTs: number | null
  lastTs: number | null
  /** D11: the whole identifier the node stands for — what *Copy ID* copies. */
  id: string | null
  parent: Entry | null
  children: Entry[]
  /**
   * Running only because an agent below it runs: the roll-up made it so, its own transcript
   * did not. False for everything else.
   */
  waiting: boolean
  /** The run an agent belongs to; null for everything that is not a workflow agent. */
  workflowId: string | null
  /** The measured counters behind `usage`, where there are any. */
  counters: Counters | null
  /** D7: an attempt its run's journal started the same step again after. */
  superseded: boolean
  /**
   * N3: an agent's last request, when the API rejected it after the transcript's last counted
   * reply; null for every other node. A run and a session count them (`endedRejectedRows`).
   */
  rejected: RejectedRequest | null
  /**
   * D4: a run's collector's members — the agents of the run without a counted reply, the ones its
   * journal started whose transcript no record holds (D2) and the ones whose record counted no
   * request — each as the tally counts it: in the collector's state and tally, and in every
   * agent count above it, with no row of their own. Empty for every other node.
   */
  collected: Member[]
  /** N1: the tally of the members below the node, where it carries one; null elsewhere. */
  tally: AgentTally | null
  /** N8: an agent's effort, of its newest reply; null for every other node, and for an agent whose replies carried none. */
  effort: Effort | null
  /** L2: the details' line under the state — an agent's with a counted request; null elsewhere. */
  overview: string | null
  /**
   * L3: what the 7-day block reads of an agent with a counted request — its type and model as its
   * name says them (the model in full), the real model ids its replies were written with, and the
   * time of its last counted reply, whose day its price is taken for. Null for every other node.
   */
  week: WeekOf | null
  /**
   * O4: the agent hook's marker — "waiting for approval" — and the time of the call that reported
   * the wait; both null for a node without one (see hookOf).
   */
  hookWait: string | null
  hookAt: number | null
  /** Built on demand: only the selected node's rows are ever needed. */
  rows: () => DetailRow[]
}

/** L3: an agent as the 7-day block groups and prices it (see Entry.week). */
interface WeekOf {
  type: string
  model: string
  models: readonly string[]
  last: number
}

/** One session and everything that belongs to it, before it is a tree. */
interface RootAcc {
  sessionId: string
  main: MainRec | null
  agents: AgentRec[]
  pendings: AgentLaunch[]
  /** Its workflow runs as their journals record them, by run id. */
  runs: Map<string, RunView>
  /** The `Workflow` calls that launched its runs (N4), by run id: one per launch, resumes included. */
  runLaunches: Map<string, RunLaunch[]>
}

interface Forest {
  /** Every root, most recent first. */
  roots: Entry[]
  byKey: Map<string, Entry>
  /** Whether any main session is within the retention at all — the empty note depends on it. */
  anyMain: boolean
  /** The agent records the tree is made of, one per agent id — the export's rows (1.6 O2). */
  records: Map<string, AgentRec>
  /** The launch of a record, as the tree finds it: its sidecar's tool_use id first, then its agent id. */
  launchOf: (r: AgentRec) => AgentLaunch | null
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

/**
 * N6 (1.6, lead note "Zeitfolge"): siblings in plain time order, the newest start first — the
 * children of a session, of a run and of an agent alike, whatever state each is in: the glyph,
 * the word and the tally say that, the order says when. A node without a known start after the
 * others, then by key, so the order is stable; a run's collector (D4) always last, since it
 * stands for agents of every start.
 */
export function byNewestFirst(a: Pick<Entry, 'kind' | 'startTs' | 'key'>, b: Pick<Entry, 'kind' | 'startTs' | 'key'>): number {
  if ((a.kind === 'noreply') !== (b.kind === 'noreply')) return a.kind === 'noreply' ? 1 : -1
  const x = a.startTs ?? -Infinity
  const y = b.startTs ?? -Infinity
  return x > y ? -1 : x < y ? 1 : cmp(a.key, b.key)
}

function* preorder(e: Entry): Generator<Entry> {
  yield e
  for (const c of e.children) yield* preorder(c)
}

function depthOf(e: Entry): number {
  let d = 0
  for (let p = e.parent; p !== null; p = p.parent) d++
  return d
}

function attach(child: Entry, parent: Entry): void {
  child.parent = parent
  parent.children.push(child)
}

function isAgentLike(e: Entry): boolean {
  return e.kind === 'agent' || e.kind === 'pending'
}

/** The agents and launches below a node, the members of its runs' collectors included — what its count says. */
function membersBelow(e: Entry): number {
  let n = 0
  for (const x of preorder(e)) {
    if (x !== e && isAgentLike(x)) n++
    n += x.collected.length
  }
  return n
}

/**
 * The newest activity anywhere below a node — how a session without a record of its own is
 * ordered among the others.
 */
function latest(e: Entry): number {
  let out = 0
  for (const x of preorder(e)) if (x.lastTs !== null && x.lastTs > out) out = x.lastTs
  return out
}

/**
 * The walk up from an agent to the first node that is not an agent, repaired on the way. A
 * spawner met twice closes a cycle, and the edge that closed it is dropped; an agent that
 * would sit deeper than MAX_TREE_DEPTH goes to its run or its session instead. Dropping an
 * edge only ever moves a node up, so a node settled earlier stays within the cap.
 */
function settle(e: Entry, up: Map<Entry, Entry | null>): void {
  for (;;) {
    const seen = new Set<Entry>([e])
    let cur = e
    let hops = 0
    let cycle = false
    for (let p = up.get(cur) ?? null; p !== null; p = up.get(cur) ?? null) {
      if (seen.has(p)) {
        up.set(cur, null)
        cycle = true
        break
      }
      seen.add(p)
      cur = p
      hops++
    }
    if (cycle) continue
    // The topmost agent sits under its run (depth 2) or directly under the session (depth 1).
    if (hops + (cur.workflowId !== null ? 2 : 1) > MAX_TREE_DEPTH) up.set(e, null)
    return
  }
}

function buildForest(input: AgentTreeInput, now: number): Forest {
  const tcfg = input.tcfg
  const since = now - AGENT_RETENTION_DAYS * DAY_MS
  // An agent is in the retention while its transcript is: its last counted reply, or the request
  // the API rejected after it (N3).
  const agents = (input.agents ?? []).filter((r) => validAgent(r) && activityOf(r, rejectionOf(r)) >= since)
  const launches = (input.launches ?? []).filter((l) => validLaunch(l) && l.ts >= since)
  const mains = (input.mains ?? []).filter((m) => validMain(m) && m.lastTs >= since)

  // One record per agent id: two would be one transcript read under two paths.
  const recById = new Map<string, AgentRec>()
  for (const r of agents) {
    const prev = recById.get(r.agentId)
    if (!prev || r.lastTs > prev.lastTs) recById.set(r.agentId, r)
  }
  const launchById = new Map<string, AgentLaunch>()
  const launchByAgent = new Map<string, AgentLaunch>()
  for (const l of launches) {
    if (!launchById.has(l.toolUseId)) launchById.set(l.toolUseId, l)
    const id = text(l.agentId)
    if (id !== null && !launchByAgent.has(id)) launchByAgent.set(id, l)
  }
  // The sidecar's tool_use id first: it names the launch of exactly this transcript.
  const launchOf = (r: AgentRec): AgentLaunch | null => {
    const id = text(r.meta?.toolUseId)
    return (id !== null ? launchById.get(id) : undefined) ?? launchByAgent.get(r.agentId) ?? null
  }
  // A launch accounted for by a record is that record's node, not a node of its own.
  const linked = new Set<string>()
  for (const r of recById.values()) {
    const l = launchOf(r)
    if (l) linked.add(l.toolUseId)
  }
  for (const l of launches) {
    const id = text(l.agentId)
    if (id !== null && recById.has(id)) linked.add(l.toolUseId)
  }

  const projects = new Map<string, string>()
  if (input.attribution !== 'none') {
    for (const s of input.sessions ?? []) {
      if (!s || s.source !== 'claude' || s.isSub) continue
      const id = text(s.sessionId)
      const project = text(s.project)
      if (id !== null && project !== null && !projects.has(id)) projects.set(id, project)
    }
  }

  const accs = new Map<string, RootAcc>()
  const accFor = (sessionId: string): RootAcc => {
    let a = accs.get(sessionId)
    if (!a) {
      a = { sessionId, main: null, agents: [], pendings: [], runs: new Map(), runLaunches: new Map() }
      accs.set(sessionId, a)
    }
    return a
  }
  for (const r of recById.values()) accFor(r.sessionId).agents.push(r)
  // The session a launch belongs to: its agent's, when an agent launched it, else its file's.
  const sessionOfLaunch = (file: string): string | null => {
    const id = agentIdOf(file)
    const r = id !== null ? recById.get(id) : undefined
    return r ? r.sessionId : sessionOfPath(file)?.sessionId ?? null
  }
  // N4: the `Workflow` calls whose result named their run, by the launching transcript's session
  // and the run's id — the parent's view of the run, joined to its journal and its agents by
  // that pair. Kept while the launch or the end the parent recorded for it is within the retention.
  const launchedRuns = new Map<string, RunLaunch[]>()
  for (const l of input.runLaunches ?? []) {
    if (!validRunLaunch(l) || Math.max(l.ts, stampOf(l.outcomeTs) ?? 0) < since) continue
    const sessionId = sessionOfLaunch(l.file)
    if (sessionId === null) continue
    const runId = l.runId as string
    const key = `${sessionId}|${runId}`
    let list = launchedRuns.get(key)
    if (!list) {
      list = []
      launchedRuns.set(key, list)
      accFor(sessionId).runLaunches.set(runId, list)
    }
    if (!list.some((x) => x.toolUseId === l.toolUseId)) list.push(l)
  }
  // A run is in the tree while its journal changed within the retention, or while one of its
  // agents' records or one of its launches is: the journal's view of those agents joins them by id.
  const recordedRuns = new Set<string>(launchedRuns.keys())
  for (const r of recById.values()) {
    const wf = text(r.workflowId)
    if (wf !== null) recordedRuns.add(`${r.sessionId}|${wf}`)
  }
  for (const run of input.runs ?? []) {
    if (!validRun(run)) continue
    const key = `${run.sessionId}|${run.workflowId}`
    const last = stampOf(run.lastTs)
    if (!recordedRuns.has(key) && (last === null || last < since)) continue
    const acc = accFor(run.sessionId)
    if (!acc.runs.has(run.workflowId)) acc.runs.set(run.workflowId, runView(run))
  }
  for (const l of launches) {
    if (linked.has(l.toolUseId)) continue
    const sessionId = sessionOfLaunch(l.file)
    if (sessionId !== null) accFor(sessionId).pendings.push(l)
  }
  for (const m of mains) {
    const a = accFor(m.sessionId)
    if (!a.main || m.lastTs > a.main.lastTs) a.main = m
  }

  const byKey = new Map<string, Entry>()
  const roots: Entry[] = []
  for (const a of accs.values()) {
    const recent = a.main !== null && a.main.lastTs >= now - ROOT_WINDOW_MS
    const journalled = [...a.runs.values()].some((v) => v.byAgent.size > 0)
    if (!recent && a.agents.length === 0 && a.pendings.length === 0 && !journalled && a.runLaunches.size === 0) continue
    const root = buildRoot(a, {
      now, tcfg, attribution: input.attribution, project: projects.get(a.sessionId) ?? null, launchOf,
      hook: input.hook instanceof Map ? input.hook : NO_HOOK,
    })
    for (const e of preorder(root)) if (!byKey.has(e.key)) byKey.set(e.key, e)
    roots.push(root)
  }
  const order = new Map(roots.map((r) => [r, r.lastTs ?? latest(r)]))
  roots.sort((x, y) => (order.get(y) ?? 0) - (order.get(x) ?? 0) || cmp(x.key, y.key))
  return { roots, byKey, anyMain: mains.length > 0, records: recById, launchOf }
}

/**
 * D4: a run's collector — one node for every member of the run without a counted reply: the
 * agents its journal started whose transcript no record holds, and the ones whose record counted
 * no request, their transcript nothing but requests the API rejected. Hundreds of them are no
 * reading anyone can do row by row, and none has a figure to show: they are counted, not listed —
 * in the collector's label and tally, in its state (the rule a run's state follows, over them),
 * and in every count above it. Its figures are dashes; it has no start of its own, so no clock
 * (1.6, lead note); its last activity is the latest line of a member that has a record, and none
 * when none has.
 */
function collectorEntry(sessionId: string, wf: string, members: Member[]): Entry {
  const st = collectorState(members)
  let last: number | null = null
  for (const m of members) {
    if (m.lastTs !== null && (last === null || m.lastTs > last)) last = m.lastTs
  }
  const label = collectorLabel(members)
  const e: Entry = {
    key: fitKey('n:', `${sessionId}|${wf}`),
    kind: 'noreply',
    label,
    fullLabel: label,
    idName: null,
    sub: null,
    state: st.state,
    stateText: st.stateText,
    usage: '–',
    usageAgents: null,
    lowerBound: false,
    lowerBoundText: null,
    duration: '–',
    // No start of its own (lead note on P5b): the earliest first line among its members may be a
    // rejected request of an agent that failed long ago, so no clock runs from it anywhere.
    startTs: null,
    lastTs: last,
    id: null,
    parent: null,
    children: [],
    waiting: false,
    workflowId: wf,
    counters: null,
    superseded: false,
    rejected: null,
    collected: members,
    tally: null,
    effort: null,
    overview: null,
    week: null,
    hookWait: null,
    hookAt: null,
    rows: () => [],
  }
  e.rows = () => {
    const tally = e.tally ?? tallyBelow(e)
    return [
      { label: t('Agents'), value: tallySpoken(tally), kind: 'sentence' },
      {
        label: t('Usage'), value: '–', kind: 'sentence',
        note: t('These agents were started, but none of them wrote a reply that could be counted — their transcripts hold no response, or only rejected requests.'),
      },
      ...endedRejectedRows(e),
    ]
  }
  return e
}

interface RootEnv {
  now: number
  tcfg: TimeConfig
  attribution: Attribution
  project: string | null
  launchOf: (r: AgentRec) => AgentLaunch | null
  /** O4: the agent hook's latest call per (session, agent); empty without the hook. */
  hook: ReadonlyMap<string, HookEntry>
}

function buildRoot(a: RootAcc, env: RootEnv): Entry {
  const { now, tcfg } = env
  const main = a.main
  const mainCounters = main ? countersOf(main) : null
  const start = main ? firstOf(main) : null
  // D5: what the session's agents used, beside what its own transcript used — never added to
  // it. The own figure runs from the transcript's first line, which may be weeks back; the
  // agents' from the records of the last seven days. A sum would add two different spans.
  const agentSum = noCounters()
  for (const r of a.agents) addInto(agentSum, countersOf(r))
  const usageAgents = a.agents.length > 0 ? usageText(agentSum) : null
  const name = sessionName(a.sessionId, start, now, tcfg)
  const root: Entry = {
    key: fitKey('s:', a.sessionId),
    kind: 'session',
    label: name,
    fullLabel: name,
    idName: sessionIdName(a.sessionId),
    // Attribution off: no project names anywhere, and the tree does not make an exception.
    sub: env.attribution !== 'none' ? env.project : null,
    ...sessionState(main, now, tcfg),
    usage: mainCounters ? usageText(mainCounters) : '–',
    usageAgents,
    lowerBound: mainCounters ? mainCounters.outputFinal < mainCounters.requests : false,
    lowerBoundText: lowerBoundTextOf(mainCounters),
    duration: main && start !== null ? spanText(main.lastTs - start) : '–',
    startTs: start,
    lastTs: main ? main.lastTs : null,
    id: a.sessionId,
    parent: null,
    children: [],
    waiting: false,
    workflowId: null,
    counters: mainCounters,
    superseded: false,
    rejected: null,
    collected: [],
    tally: null,
    effort: null,
    overview: null,
    week: null,
    hookWait: null,
    hookAt: null,
    rows: () => [],
  }
  // L2: the session's two figures first (D5) — its own transcript's usage is the first of them,
  // so the counts that follow leave the usage out, which 1.5 printed a second time —, then its
  // agents: how many, how many ended on a rejected request, and by effort (N8).
  root.rows = () => [
    { label: t('Own transcript'), value: root.usage },
    ...(usageAgents !== null
      ? [{
        label: t('Agents, last 7 days'), value: usageAgents,
        note: t('not added to the own figure — the two cover different spans'), kind: 'sentence' as const,
      }]
      : []),
    ...(env.attribution !== 'none' ? [{ label: t('Project'), value: root.sub ?? '–' }] : []),
    { label: t('Models'), value: modelsOf(main?.models).join(', ') || '–' },
    ...timeRows(root.startTs, root.lastTs, now, tcfg, true),
    ...countRows(mainCounters, false),
    // O3: how often its own transcript was compacted.
    ...compactionRows(main, now, tcfg),
    { label: t('Agents'), value: full(membersBelow(root)) },
    ...endedRejectedRows(root),
    ...effortCountRows(root),
    // O3: the Claude Code that wrote its transcript, and the permission mode it ran in.
    ...writerRows(main),
    // O4: what the agent hook reported the session waits for, while it waits.
    ...hookRows(root, now, tcfg),
    idRow(a.sessionId),
  ]

  const workflows = new Map<string, Entry>()
  const workflowOf = (wf: string): Entry => {
    let w = workflows.get(wf)
    if (!w) {
      // Named by its id until its start is known — set below, once its members are in.
      const name = runIdName(wf)
      w = {
        key: fitKey('w:', `${a.sessionId}|${wf}`),
        kind: 'workflow',
        label: name,
        fullLabel: name,
        idName: name,
        sub: null,
        state: 'unknown',
        stateText: '',
        usage: '–',
        usageAgents: null,
        lowerBound: false,
        lowerBoundText: null,
        duration: '–',
        startTs: null,
        lastTs: null,
        id: wf,
        parent: null,
        children: [],
        waiting: false,
        workflowId: wf,
        counters: null,
        superseded: false,
        rejected: null,
        collected: [],
        tally: null,
        effort: null,
        overview: null,
        week: null,
        hookWait: null,
        hookAt: null,
        rows: () => [],
      }
      attach(w, root)
      workflows.set(wf, w)
    }
    return w
  }

  const ordered = [...a.agents].sort((x, y) => firstOf(x) - firstOf(y) || cmp(x.agentId, y.agentId))
  // D11: per session, as few characters of each id as keep it apart from the others — the agents
  // its runs' journals started without a record included, since a sentence names an attempt
  // that superseded another by its short id, and that attempt may have no record yet.
  const journalIds: string[] = []
  for (const v of a.runs.values()) {
    for (const j of v.byAgent.values()) {
      journalIds.push(j.agentId)
      const next = text(j.supersededBy)
      if (next !== null) journalIds.push(next)
    }
  }
  const shortIds = shortIdsOf([...a.agents.map((r) => r.agentId), ...journalIds])
  const shortOf = (id: string): string => shortIds.get(id) ?? id
  const byAgent = new Map<string, Entry>()
  const spawnerFileOf = new Map<Entry, string | null>()
  /** O3 (§0a.11): the spawning agent a sidecar names — the link where no launch names a spawner file. */
  const parentIdOf = new Map<Entry, string | null>()
  /** Who launched a node, by name: an agent of this session, the session itself, or '–'. */
  const spawnedBy = (file: string | null): string => {
    if (file === null) return '–'
    const id = agentIdOf(file)
    if (id !== null) return byAgent.get(id)?.fullLabel ?? '–'
    const place = sessionOfPath(file)
    return place !== null && place.main && place.sessionId === a.sessionId ? root.fullLabel : '–'
  }
  /** Who launched an agent: the transcript its launch or its record names, else the agent its sidecar names. */
  const spawnedByOf = (e: Entry): string => {
    const file = spawnerFileOf.get(e) ?? null
    if (file !== null) return spawnedBy(file)
    const parent = parentIdOf.get(e) ?? null
    return parent !== null ? byAgent.get(parent)?.fullLabel ?? '–' : '–'
  }
  // D4: the agents of each run whose record counted no reply — its transcript nothing but requests
  // the API rejected — by run: members of their run's collector, not nodes of their own.
  const collectedOf = new Map<string, Member[]>()
  for (const r of ordered) {
    const launch = env.launchOf(r)
    const c = countersOf(r)
    const first = firstOf(r)
    const models = modelsOf(r.models)
    const wf = text(r.workflowId)
    const { type, alias, model: named } = nameOf(r, launch, models)
    // The journal's view of a run's agent, joined by id within its run (D2, D7).
    const view = wf !== null ? a.runs.get(wf) ?? null : null
    const journal = view?.byAgent.get(r.agentId) ?? null
    const next = journal !== null ? text(journal.supersededBy) : null
    // N3: the request the transcript ended on, when the API rejected it — activity of its own.
    const rejected = rejectionOf(r)
    const activity = activityOf(r, rejected)
    const st = agentState(r, launch, journal ? journalState(journal, next !== null ? shortOf(next) : null) : null, rejected, now, tcfg)
    if (wf !== null && c.requests === 0) {
      let list = collectedOf.get(wf)
      if (!list) {
        list = []
        collectedOf.set(wf, list)
      }
      list.push({
        agentId: r.agentId,
        state: st.state, superseded: next !== null, rejected, journalFailed: journal !== null && journalOutcome(journal) === 'failed',
        startTs: first, lastTs: activity, effort: effortLevel(r.effort),
      })
      continue
    }
    const step = journal !== null && typeof journal.step === 'number' && Number.isInteger(journal.step) ? journal.step : 0
    const attempts = step > 0 ? view?.attempts.get(step) ?? 0 : 0
    // D4: an agent outside a run whose record counted no reply keeps a node of its own — there are
    // few — with dashes for every figure: nothing of it was counted, its time on the clock included.
    const counted = c.requests > 0
    // N6: the row names the model in its short form, the details and the markdown in full.
    const model = named ?? '–'
    const e: Entry = {
      key: fitKey('a:', r.agentId),
      kind: 'agent',
      label: `${type ?? t('Agent')} · ${shortModel(model)} · ${shortOf(r.agentId)}`,
      fullLabel: `${type ?? t('Agent')} · ${model} · ${shortOf(r.agentId)}`,
      idName: null,
      sub: null,
      state: st.state,
      stateText: st.stateText,
      usage: usageText(c),
      usageAgents: null,
      lowerBound: c.outputFinal < c.requests,
      lowerBoundText: lowerBoundTextOf(c),
      duration: counted ? durationText(activity - first) : '–',
      startTs: first,
      lastTs: activity,
      id: r.agentId,
      parent: null,
      children: [],
      waiting: false,
      workflowId: wf,
      counters: c,
      superseded: next !== null,
      rejected,
      collected: [],
      tally: null,
      effort: effortLevel(r.effort),
      // L2: what it used, how long it ran, how many requests and tool calls it made — the line under
      // its state. An agent nothing of which was counted has none of the four.
      overview: counted ? overviewOf(c, durationText(activity - first)) : null,
      // L3: grouped by the type and the model its name says, priced for the day of its last reply.
      week: counted ? { type: type ?? t('Agent'), model, models, last: r.lastTs } : null,
      hookWait: null,
      hookAt: null,
      rows: () => [],
    }
    // L2 (1.6): the details in the order a reader asks — what the tokens were (the mix), how the
    // agent stands in its run, the context it ended with and its pace, then who it is, when it ran,
    // what it counted, why it ended, where it came from and Claude Code's own report.
    e.rows = () => {
      const by = spawnedByOf(e)
      return [
        ...mixRows(c),
        ...rankRows(e, wf !== null ? workflows.get(wf) ?? null : null),
        ...contextRows(r, c),
        ...perMinuteRows(c, activity - first),
        { label: t('Type'), value: type ?? '–' },
        { label: t('Models'), value: models.join(', ') || alias || '–' },
        // N8: the effort its replies were written at.
        { label: t('Effort'), value: effortText(effortsOf(r)) },
        idRow(r.agentId),
        { label: t('Depth'), value: depthText(r.meta?.spawnDepth) },
        ...timeRows(e.startTs, e.lastTs, now, tcfg, false, counted),
        ...recordedRows(st.resumed, now, tcfg),
        ...countRows(c),
        // O3: what of it went wrong or was redone — its tool errors, its cache misses, its compactions.
        ...toolErrorRows(r, c),
        ...cacheMissRows(r),
        ...compactionRows(r, now, tcfg),
        ...rejectedRows(rejected, now, tcfg),
        // A workflow agent no launch names was started by its run, which the next row names: 1.5's
        // "Spawned by –" on every one of them said nothing.
        ...(wf !== null && by === '–' ? [] : [{ label: t('Spawned by'), value: by }]),
        // The run by the name its row carries (N6): the rows are built once the tree is.
        { label: t('Workflow run'), value: wf !== null ? workflows.get(wf)?.label ?? runIdName(wf) : '–' },
        // D7: which attempt at its step this agent is, where the journal started the step more than once.
        ...(attempts >= 2 && journal !== null && Number.isInteger(journal.attempt) && journal.attempt >= 1
          ? [{ label: t('Attempt'), value: t('{0} of {1} of this step', full(journal.attempt), full(attempts)) }]
          : []),
        // O3: the Claude Code that wrote its transcript, and the permission mode, where it names one.
        ...writerRows(r),
        ...reportRows(launch),
        // O4 (L2's last row): what the agent hook reported it waits for, while it waits.
        ...hookRows(e, now, tcfg),
      ]
    }
    byAgent.set(r.agentId, e)
    spawnerFileOf.set(e, text(r.spawnerFile) ?? text(launch?.file))
    parentIdOf.set(e, parentAgentIdOf(r))
  }

  // Each agent under the agent that spawned it, when that agent is in this session's tree. A
  // run's agents stay inside the run: a spawner outside it would scatter one workflow.
  const up = new Map<Entry, Entry | null>()
  for (const e of byAgent.values()) {
    const file = spawnerFileOf.get(e) ?? null
    // O3 (§0a.11): no transcript named as the spawner — the agent the sidecar names, when it has one.
    const id = file !== null ? agentIdOf(file) : parentIdOf.get(e) ?? null
    let p = id !== null ? byAgent.get(id) ?? null : null
    if (p === e) p = null
    if (p !== null && e.workflowId !== null && p.workflowId !== e.workflowId) p = null
    up.set(e, p)
  }
  for (const e of byAgent.values()) settle(e, up)
  for (const e of byAgent.values()) {
    const p = up.get(e) ?? null
    attach(e, p ?? (e.workflowId !== null ? workflowOf(e.workflowId) : root))
  }

  // Launches whose transcript was never seen, under whoever launched them.
  const pendings = [...a.pendings].sort((x, y) => x.ts - y.ts || cmp(x.toolUseId, y.toolUseId))
  for (const l of pendings) {
    const outcomeAt = stampOf(l.outcomeTs)
    const hint = text(l.modelHint) ?? '–'
    const e: Entry = {
      key: fitKey('l:', l.toolUseId),
      kind: 'pending',
      label: t('{0} · {1} · launched', text(l.typeHint) ?? t('Agent'), shortModel(hint)),
      fullLabel: t('{0} · {1} · launched', text(l.typeHint) ?? t('Agent'), hint),
      idName: null,
      sub: null,
      ...pendingState(l, now, tcfg),
      // No transcript, so nothing was counted: dashes, never zeros.
      usage: '–',
      usageAgents: null,
      lowerBound: false,
      lowerBoundText: null,
      duration: '–',
      startTs: l.ts,
      lastTs: Math.max(l.ts, outcomeAt ?? 0),
      id: l.toolUseId,
      parent: null,
      children: [],
      waiting: false,
      workflowId: null,
      counters: null,
      superseded: false,
      rejected: null,
      collected: [],
      tally: null,
      effort: null,
      overview: null,
      week: null,
      hookWait: null,
      hookAt: null,
      rows: () => [
        { label: t('Type'), value: text(l.typeHint) ?? '–' },
        { label: t('Models'), value: text(l.modelHint) ?? '–' },
        idRow(l.toolUseId),
        { label: t('Started'), value: stamp(l.ts, now, tcfg) },
        { label: t('Spawned by'), value: spawnedBy(l.file) },
        ...reportRows(l),
      ],
    }
    const id = agentIdOf(l.file)
    const host = id !== null ? byAgent.get(id) ?? null : null
    attach(e, host !== null && depthOf(host) < MAX_TREE_DEPTH ? host : root)
  }

  // Waiting is not silence: an agent that launched a child agent and waits on it writes
  // nothing until the child returns, so an agent with no result of its own and a running
  // agent anywhere below it is running too — derived, and its sentence says from what.
  // Children before parents, so a running grandchild carries up through every level.
  const rollUp = (e: Entry): boolean => {
    let below = false
    for (const c of e.children) if (rollUp(c)) below = true
    if (e.kind === 'agent' && below && e.state === 'unknown') {
      e.state = 'running'
      e.stateText = t('Running — inferred: a child agent of this agent is still running.')
      // The running list says so: this one runs by what is below it, not by its own clock.
      e.waiting = true
    }
    return below || (isAgentLike(e) && e.state === 'running')
  }
  let anyRunning = false
  for (const c of root.children) if (rollUp(c)) anyRunning = true

  // The agents a run's journal started whose transcript no record holds (D2): members of the run
  // all the same, in its collector (D4). A run with nothing but such members — or nothing but
  // agents whose record counted no reply — is a run of the session too.
  const journalOnlyOf = new Map<string, JournalAgent[]>()
  for (const [wf, view] of a.runs) {
    const recorded = new Set(a.agents.filter((r) => text(r.workflowId) === wf).map((r) => r.agentId))
    const only = [...view.byAgent.values()].filter((j) => !recorded.has(j.agentId))
    if (only.length === 0) continue
    journalOnlyOf.set(wf, only)
    workflowOf(wf)
  }
  for (const wf of collectedOf.keys()) workflowOf(wf)
  // N4: a run its parent launched is a run of the session from the launch on — before any agent
  // of it has written a line, or its journal one.
  for (const wf of a.runLaunches.keys()) workflowOf(wf)

  // A run is summed from the agents inside it, on the whole tree: a closed run, or one showing
  // fifty of its agents at a time, hides some of them from the page, but that does not change
  // what the run used. Its state is the one function of its members' tally (§3.0 a), so the
  // row's glyph and the tally beside it always agree.
  for (const [wf, w] of workflows) {
    const members = [...preorder(w)].filter(isAgentLike)
    // D4: the run's agents whose record counted no reply; their lines are the run's activity too.
    const recordsOnly = collectedOf.get(wf) ?? []
    const sum = noCounters()
    let first: number | null = null
    let last: number | null = null
    const span = (m: { startTs: number | null; lastTs: number | null }): void => {
      if (m.startTs !== null && (first === null || m.startTs < first)) first = m.startTs
      if (m.lastTs !== null && (last === null || m.lastTs > last)) last = m.lastTs
    }
    for (const m of members) {
      if (m.counters) addInto(sum, m.counters)
      span(m)
    }
    for (const m of recordsOnly) span(m)
    // N4: the launches of the run, a resume being one more. The latest decides the parent's end.
    const launches = a.runLaunches.get(wf) ?? []
    const latest = latestLaunch(launches)
    const run = a.runs.get(wf)?.run ?? null
    const siblingRuns = members.some((m) => m.state === 'running') || recordsOnly.some((m) => m.state === 'running')
    const only: Member[] = run === null ? [] : (journalOnlyOf.get(wf) ?? []).map((j) => ({
      agentId: j.agentId,
      state: journalOnlyState(j, run, siblingRuns, now), superseded: text(j.supersededBy) !== null, rejected: null,
      journalFailed: journalOutcome(j) === 'failed', startTs: null, lastTs: null, effort: null,
    }))
    // D4: every member without a counted reply in one collector, the run's last child.
    const collected = [...recordsOnly, ...only]
    if (collected.some((m) => m.state === 'running')) anyRunning = true
    if (collected.length > 0) attach(collectorEntry(a.sessionId, wf, collected), w)
    const tally = tallyBelow(w)
    // The members' last line, before the launches fill in for a run nobody has written to yet.
    const st = runState(tally, latest, run, last, now, tcfg)
    w.state = st.state
    w.stateText = st.stateText
    w.counters = sum
    w.usage = usageText(sum)
    w.lowerBound = sum.outputFinal < sum.requests
    w.lowerBoundText = lowerBoundTextOf(sum)
    // A run no agent has written to yet: its launch is its start, and the parent's last word on
    // it its last activity. It ran for no time anyone measured, so it has no duration.
    const measured = members.length > 0
    if (!measured) {
      for (const l of launches) {
        const lastOf = Math.max(l.ts, stampOf(l.outcomeTs) ?? 0)
        if (first === null || l.ts < first) first = l.ts
        if (last === null || lastOf > last) last = lastOf
      }
    }
    w.startTs = first
    w.lastTs = last
    w.duration = measured && first !== null && last !== null ? durationText(last - first) : '–'
    // N6: a run is named by when it started — its first member's line, or its launch.
    w.label = runName(wf, first, now, tcfg)
    w.fullLabel = w.label
    const dropped = run !== null && typeof run.agentsDropped === 'number' && Number.isInteger(run.agentsDropped)
      && run.agentsDropped > 0 ? run.agentsDropped : 0
    // L2: the run's details open with its tally, in words — "427 started, 112 done, 12 failed, 295
    // retried, about 8 unknown", as a collector's do. A run whose agents nobody has seen yet has no
    // count to state: '–', never an invented 0.
    const agentsRow: DetailRow = tally.started === 0
      ? { label: t('Agents'), value: '–' }
      : dropped > 0
        ? { label: t('Agents'), value: tallySpoken(tally), note: t('{0} further agents not listed', full(dropped)), kind: 'sentence' }
        : { label: t('Agents'), value: tallySpoken(tally), kind: 'sentence' }
    // N4: a resumed run was launched more than once — the ends of the earlier launches are its
    // history, and only the latest launch's decides the run.
    const launchesRow: DetailRow[] = launches.length >= 2
      ? [{ label: t('Launches'), value: t('{0} — resumed {1} time(s)', full(launches.length), full(launches.length - 1)) }]
      : []
    // L2: the tally, how many of its agents worked at once, its times, its counts, how its agents
    // ended and at what effort, how often it was launched, Claude Code's own record of it (L4), and
    // its ID.
    const record = recordOf(run)
    w.rows = () => [
      agentsRow,
      ...parallelismRows(w),
      ...timeRows(w.startTs, w.lastTs, now, tcfg),
      ...recordedRows(st.resumed, now, tcfg),
      ...countRows(sum),
      ...endedRejectedRows(w),
      ...effortCountRows(w),
      ...launchesRow,
      recordRow(record, now, tcfg),
      idRow(wf),
    ]
  }
  // A session whose agents do the work while its own transcript waits is in use all the same.
  if (anyRunning && root.state !== 'active') {
    root.state = 'active'
    root.stateText = t('Active — inferred: an agent of this session is running.')
  }

  // O4: the agent hook's word, once every state above is settled — a marker beside the state and a
  // sentence after its own, never a state of its own (see hookOf).
  for (const e of preorder(root)) {
    const h = hookOf(e, a.sessionId, env)
    if (h === null) continue
    e.hookWait = hookWaitText(h.wait)
    e.hookAt = h.ts
    e.stateText = `${e.stateText} ${hookSentence(h.wait, stamp(h.ts, now, tcfg))}`
  }

  // N1: what the agents below each session, run, collector and agent came to, every state final
  // by now — the roll-up's waiting agents included. A node with no agent below it has no tally, so
  // a session without agents claims no "0 started", and a leaf agent none at all.
  for (const e of preorder(root)) {
    if (e.kind !== 'session' && e.kind !== 'workflow' && e.kind !== 'agent' && e.kind !== 'noreply') continue
    const tally = tallyBelow(e)
    e.tally = tally.started > 0 ? tally : null
  }

  for (const e of preorder(root)) e.children.sort(byNewestFirst)
  return root
}

// ---------------------------------------------------------------------------
// What goes to the page, and the view-model shape
// ---------------------------------------------------------------------------

/** The node and every node above it, from the node up. */
function pathOf(e: Entry): Entry[] {
  const out: Entry[] = []
  for (let c: Entry | null = e; c !== null; c = c.parent) out.push(c)
  return out
}

/**
 * The children an open node shows (1.6 D3): the first `limit` of them in the order the page
 * draws them, with the child on the path to the selected node, a run's collector (D4) and every
 * running child pinned into those places — each taking the place of the last child that is not
 * pinned, so the ones shown keep their order. Only when the pinned children alone are more than
 * `limit` does one of them go: the path to the selection first, then the collector, which stands
 * for every agent of the run without a counted reply, then the running children in order. A node
 * with no more children than `limit` shows them all.
 */
function windowOf(e: Entry, limit: number, onPath: ReadonlySet<Entry>): Entry[] {
  if (e.children.length <= limit) return e.children
  const pinned: Entry[] = []
  const toSelected = e.children.find((c) => onPath.has(c))
  if (toSelected) pinned.push(toSelected)
  const collector = e.children.find((c) => c.kind === 'noreply')
  if (collector && collector !== toSelected) pinned.push(collector)
  for (const c of e.children) if (c !== toSelected && c !== collector && c.state === 'running') pinned.push(c)
  const chosen = new Set(pinned.slice(0, limit))
  let free = limit - chosen.size
  for (const c of e.children) {
    if (free <= 0) break
    if (chosen.has(c)) continue
    chosen.add(c)
    free--
  }
  return e.children.filter((c) => chosen.has(c))
}

/** What one payload carries: the children each node ships, and every node it has a row for. */
interface Payload {
  /** The children a node ships, by node — only the nodes that ship any. */
  shipped: Map<Entry, Entry[]>
  /** Every node with a row in the payload: the roots and the children shipped below them. */
  emitted: Set<Entry>
}

/**
 * Which children go into the payload. An open node ships its window (see windowOf) or nothing:
 * the whole payload holds at most `cap` nodes, so it is filled with the path to the selected node
 * first, then the paths to the running nodes, then everything else in the order the page draws
 * it — a node whose window no longer fits ships no children and says how many it holds, rather
 * than a part of them in no order anyone chose. A node ships only when its own row is in the
 * payload: a child of a closed node is not on the page, however open it is itself.
 */
function payloadOf(
  roots: readonly Entry[], isOpen: (e: Entry) => boolean, limitOf: (e: Entry) => number,
  selected: Entry | null, running: readonly Entry[], cap: number,
): Payload {
  const onPath = new Set<Entry>(selected ? pathOf(selected) : [])
  const shipped = new Map<Entry, Entry[]>()
  const refused = new Set<Entry>()
  const emitted = new Set<Entry>(roots)
  let budget = cap - roots.length
  const ship = (e: Entry): boolean => {
    if (shipped.has(e)) return true
    if (refused.has(e) || !emitted.has(e) || e.children.length === 0 || !isOpen(e)) return false
    const window = windowOf(e, limitOf(e), onPath)
    if (window.length > budget) {
      refused.add(e)
      return false
    }
    budget -= window.length
    shipped.set(e, window)
    for (const c of window) emitted.add(c)
    return true
  }
  // A path from the top: each node ships once the one above it did.
  const down = (e: Entry): void => {
    for (const x of pathOf(e).reverse()) if (x !== e && !ship(x)) return
  }
  if (selected) down(selected)
  for (const r of running) down(r)
  const visit = (e: Entry): void => {
    if (!ship(e)) return
    for (const c of shipped.get(e) ?? []) visit(c)
  }
  for (const r of roots) visit(r)
  return { shipped, emitted }
}

/**
 * A node's details. The flag and the last activity are the node's own, so the panel can say
 * whether the state was recorded, and keep its clock, from the details alone.
 */
function detailsOf(e: Entry): NodeDetails {
  return {
    key: e.key, title: e.fullLabel, state: e.state, derived: derivedOf(e.state), stateText: e.stateText,
    lastTs: e.lastTs, overview: e.overview, id: e.id, rows: e.rows(),
  }
}

/**
 * The agents and pending launches below a node — what its tally counts — for every node at
 * once, on the whole tree: open or closed, inside a node's window or past it.
 */
function agentCounts(roots: Entry[]): Map<Entry, number> {
  const out = new Map<Entry, number>()
  // A collector's members (D4) count where the drawn agents do: on the collector — the `started`
  // of its tally — and on every node above it.
  const count = (e: Entry): number => {
    let n = e.collected.length
    for (const c of e.children) n += count(c) + (isAgentLike(c) ? 1 : 0)
    out.set(e, n)
    return n
  }
  for (const r of roots) count(r)
  return out
}

/**
 * Where a running node sits, in the words of the nodes above it: its session, the run it
 * belongs to if any — by their ids, "Session 9d0eb37a · Workflow run cfe7718d" (N6: a line of
 * where the agent is, not a second pair of names by start time) — and the session's project
 * while attribution names one (`sub` is null otherwise, see buildRoot).
 */
function contextOf(e: Entry): string {
  let root = e
  let run: Entry | null = null
  // 1.7 F2: an earlier session's node sits in the group of earlier sessions, which is where it is
  // on the page, not where it belongs: the line names its session, never the group.
  for (let p = e.parent; p !== null && p.kind !== 'group'; p = p.parent) {
    if (run === null && p.kind === 'workflow') run = p
    root = p
  }
  return [root.idName ?? root.label, run !== null ? run.idName ?? run.label : null, root.sub]
    .filter((s): s is string => !!s).join(' · ')
}

/** Longest-running first: the earliest start; a node without one last; then by key, so the order is stable. */
function byStartThenKey(a: Entry, b: Entry): number {
  if (a.startTs !== b.startTs) {
    if (a.startTs === null) return 1
    if (b.startTs === null) return -1
    return a.startTs - b.startTs
  }
  return cmp(a.key, b.key)
}

/**
 * The running members a node stands for, as the tally counts them (N1, §2.3 of the 1.6 spec): an
 * agent or a launch in state running is one, unless a later attempt of its step superseded it —
 * the tally has that one under retried —, and a run's collector (D4) is as many as its members
 * that run. Every other node is none. What `AgentTreeVm.running` sums, so the host's poll, the
 * running list and the sessions' tallies say the same number.
 */
function runningMembers(e: Entry): number {
  if (e.kind === 'noreply') return e.collected.filter((m) => m.state === 'running' && !m.superseded).length
  return isAgentLike(e) && e.state === 'running' && !e.superseded ? 1 : 0
}

/**
 * Every agent and pending launch in state running, and every run's collector while one of its
 * members runs (D4) — once, for all of them, never a row per member —, from all roots, listed or
 * not, open or closed, inside a window or past it: whoever watches the list came to see exactly
 * these, wherever the tree put them. An attempt a later one superseded is not among them: the
 * tally counts it as retried. One entry per key.
 */
function runningOf(roots: Entry[]): Entry[] {
  const seen = new Set<string>()
  const out: Entry[] = []
  for (const r of roots) {
    for (const e of preorder(r)) {
      if (runningMembers(e) === 0 || seen.has(e.key)) continue
      seen.add(e.key)
      out.push(e)
    }
  }
  return out.sort(byStartThenKey)
}

/**
 * N5 (1.6): whether the page may say how long a node has been silent — an agent running by its
 * own transcript: not one that runs only because an agent below it runs (it waits, and says so),
 * not one the agent hook says waits for approval or input (O4: its marker says why it is quiet),
 * not a launch nobody has read a line of, not a collector. Its revival after an outcome (D6) and
 * its rejected last request (N3) included: both run by their own lines.
 */
function silenceOf(e: Entry): boolean {
  // O4: an agent the hook says waits for approval or input is quiet for that reason, and its
  // row says so instead.
  return e.kind === 'agent' && e.state === 'running' && !e.waiting && e.hookWait === null
}

function runningItem(e: Entry, now: number, tcfg: TimeConfig): RunningItem {
  // Nothing of a launch nobody has read a line of, or of a collector's agents, was counted: the
  // builder already says '–'.
  const counted = e.kind === 'agent'
  // A collector has no start of its own (its node has none), so no clock runs for it here either.
  const start = e.kind === 'noreply' ? null : e.startTs
  return {
    key: e.key,
    kind: e.kind === 'pending' ? 'pending' : e.kind === 'noreply' ? 'noreply' : 'agent',
    label: e.label,
    fullLabel: e.fullLabel,
    context: contextOf(e),
    usage: counted ? e.usage : '–',
    // As the node, and in the node's words (D10): the markdown's running line marks it, and the
    // page's row does while the page marks the tree's rows (ROW_LOWER_BOUND_MARK in the webview).
    lowerBound: counted ? e.lowerBound : false,
    lowerBoundText: counted ? e.lowerBoundText : null,
    startTs: start,
    lastTs: e.lastTs,
    startClock: clockOf(start, now, tcfg),
    lastClock: clockOf(e.lastTs, now, tcfg),
    waiting: e.waiting,
    silence: silenceOf(e),
    hookWait: e.hookWait,
    running: runningMembers(e),
  }
}

/**
 * N9 (1.6): a node's time as a clock time — "14:20" today, "2026-09-01 14:20" on another day —
 * for the words a screen reader gets in place of a ticking clock; null where the time is.
 */
function clockOf(ms: number | null, now: number, tcfg: TimeConfig): string | null {
  return ms === null ? null : stamp(ms, now, tcfg)
}

// ---------------------------------------------------------------------------
// Where the agent tokens went (1.6 L3)
// ---------------------------------------------------------------------------

/** The median of some numbers: the middle one, or halfway between the two in the middle; NaN for none. */
export function medianOf(xs: readonly number[]): number {
  if (xs.length === 0) return NaN
  const v = [...xs].sort((a, b) => a - b)
  const mid = Math.floor(v.length / 2)
  return v.length % 2 === 1 ? v[mid] : (v[mid - 1] + v[mid]) / 2
}

/**
 * What an agent's tokens would have cost through the API: the rates of its model on the day of
 * its last counted reply, the way the tables price the same tokens — or null when it has no price:
 * its model has none on file, or its replies were written with more than one model (a fallback in
 * the middle of a run), whose tokens its record does not split between them. A record keeps no
 * speed and no web search, so its tokens are priced at the model's standard rate, and nothing else
 * is in the figure.
 */
function agentCost(e: Entry, pricing: PricingOptions, tcfg: TimeConfig): number | null {
  const w = e.week
  if (w === null || e.counters === null || w.models.length !== 1) return null
  const c = costOfBucket({ ...bucketOf(e.counters, true), model: w.models[0], day: dayOf(w.last, tcfg) }, pricing)
  return c !== null && !c.unpriced && Number.isFinite(c.usd) && c.usd >= 0 ? c.usd : null
}

/**
 * The cost of some agents together, as the block writes it: `~` in front, as every cost on the
 * page; '–' when none of them has a price; ` ⚠` behind a sum that holds only some of them — a
 * lower bound, marked as the page marks one.
 */
function costSumText(sum: number, priced: number, of: number): string {
  const text = priced > 0 ? costText(sum) : '–'
  return text !== '–' && priced < of ? `${text} ⚠` : text
}

/**
 * L3 (1.6): where the agent tokens of the last seven days went. Every agent record of the
 * retention with a counted request — whatever session it belongs to, listed in the tree or not —
 * once, at its whole usage (the tree's own figure): grouped by the type and the model its name
 * says, the largest usage first, at most WEEK_ROWS of them and a line for the rest; per group how
 * many agents, their usage, its share of the whole block and the median of one agent's. Then the
 * TOP_AGENTS largest agents themselves, as rows that select their nodes. A cost only with
 * `pricing` — `tokenPace.showCost` on —, and for a group or the whole only of the agents with a
 * price, marked when that is not all of them.
 */
function weekOf(roots: readonly Entry[], pricing: PricingOptions | null, tcfg: TimeConfig): AgentWeek {
  interface Counted { e: Entry; w: WeekOf; usage: number; cost: number | null }
  const counted: Counted[] = []
  for (const r of roots) {
    for (const e of preorder(r)) {
      if (e.kind !== 'agent' || e.week === null || e.counters === null || e.counters.requests <= 0) continue
      counted.push({ e, w: e.week, usage: billable(bucketOf(e.counters, true)), cost: pricing ? agentCost(e, pricing, tcfg) : null })
    }
  }
  const total = counted.reduce((sum, x) => sum + x.usage, 0)
  const shareOf = (n: number): string => (total > 0 ? shareText(n / total) : '–')
  const costOf = (list: readonly Counted[]): string | null => {
    if (pricing === null) return null
    const priced = list.filter((x) => x.cost !== null)
    return costSumText(priced.reduce((sum, x) => sum + (x.cost as number), 0), priced.length, list.length)
  }
  const groups = new Map<string, { type: string; model: string; members: Counted[]; usage: number }>()
  for (const x of counted) {
    // Two strings of their own alphabets; the NUL between them is in neither.
    const k = `${x.w.type}\u0000${x.w.model}`
    let g = groups.get(k)
    if (!g) {
      g = { type: x.w.type, model: x.w.model, members: [], usage: 0 }
      groups.set(k, g)
    }
    g.members.push(x)
    g.usage += x.usage
  }
  const ranked = [...groups.values()].sort((a, b) => b.usage - a.usage || cmp(a.type, b.type) || cmp(a.model, b.model))
  const rows: AgentWeekRow[] = ranked.slice(0, WEEK_ROWS).map((g) => ({
    type: g.type,
    model: g.model,
    label: `${g.type} · ${shortModel(g.model)}`,
    agents: g.members.length,
    usage: compact(g.usage),
    share: shareOf(g.usage),
    median: compact(medianOf(g.members.map((x) => x.usage))),
    cost: costOf(g.members),
  }))
  const rest = ranked.length - rows.length
  const top: AgentWeekTop[] = [...counted].sort((a, b) => b.usage - a.usage || cmp(a.e.key, b.e.key)).slice(0, TOP_AGENTS)
    .map((x) => ({
      key: x.e.key,
      label: x.e.label,
      fullLabel: x.e.fullLabel,
      context: contextOf(x.e),
      state: x.e.state,
      derived: derivedOf(x.e.state),
      usage: x.e.usage,
      share: shareOf(x.usage),
      cost: pricing === null ? null : x.cost === null ? '–' : costText(x.cost),
    }))
  return {
    rows,
    other: rest <= 0 ? null : rest === 1 ? t('1 other combination') : t('{0} other combinations', full(rest)),
    top,
    total: counted.length > 0 ? compact(total) : '–',
    totalCost: costOf(counted),
    agents: counted.length,
  }
}

/**
 * 1.7 F2: the one group of earlier sessions — every root that is not active, most recent first, at
 * most MAX_ROOTS of them (the caller cuts) — as a node of the page's roots, always the last one. A
 * container, not a thing with a state: its label counts the sessions it holds ("Earlier sessions
 * (12)"), its tally is theirs summed field by field — each session's own, taken on the whole
 * forest, so a closed group that ships no child still says what their agents came to — and so is
 * its count of agents; its figures are dashes, its last activity its newest member's, and it has
 * no details, no id and no start (§2.7 of the 1.7 spec). `idle` and derived only because every
 * node has a state; no renderer shows it.
 *
 * The sessions become its children for the page's paths — the payload ships them only while the
 * group is open (1.6 D3), and a node inside it is reachable through it — and nothing else changes:
 * the forest's keys, the running list, the sessions' own tallies and the 7-day block were taken
 * before, and the line of where an agent sits names its session, never the group (contextOf).
 */
function earlierGroup(sessions: readonly Entry[], counts: Map<Entry, number>): Entry {
  const sum = noTally()
  let agents = 0
  let last: number | null = null
  for (const s of sessions) {
    if (s.tally !== null) for (const k of Object.keys(sum) as Array<keyof AgentTally>) sum[k] += s.tally[k]
    agents += counts.get(s) ?? 0
    const at = s.lastTs ?? (latest(s) || null)
    if (at !== null && (last === null || at > last)) last = at
  }
  const label = t('Earlier sessions ({0})', full(sessions.length))
  const g: Entry = {
    key: EARLIER_KEY,
    kind: 'group',
    label,
    fullLabel: label,
    idName: null,
    sub: null,
    state: 'idle',
    stateText: '',
    usage: '–',
    usageAgents: null,
    lowerBound: false,
    lowerBoundText: null,
    duration: '–',
    startTs: null,
    lastTs: last,
    id: null,
    parent: null,
    children: [],
    waiting: false,
    workflowId: null,
    counters: null,
    superseded: false,
    rejected: null,
    collected: [],
    // A group of sessions none of which has an agent claims no "0 started": a dash, as a session's.
    tally: sum.started > 0 ? sum : null,
    effort: null,
    overview: null,
    week: null,
    hookWait: null,
    hookAt: null,
    rows: () => [],
  }
  for (const s of sessions) attach(s, g)
  counts.set(g, agents)
  return g
}

/**
 * The "more" steps of an open node the reader took: a whole number from 0 to MAX_MORE_PAGES.
 * The stored list is the view state's, and was checked on the way in; it is checked again
 * here, since a count out of range would ask for a window nobody can page back from.
 */
function pagesFrom(more: AgentTreeInput['more']): Map<string, number> {
  const out = new Map<string, number>()
  for (const m of Array.isArray(more) ? more : []) {
    if (!m || typeof m.key !== 'string' || typeof m.pages !== 'number' || !Number.isInteger(m.pages)) continue
    out.set(m.key, Math.max(0, Math.min(MAX_MORE_PAGES, m.pages)))
  }
  return out
}

/**
 * The tree for the view model (1.6 D3): at most MAX_ROOTS active sessions, most recent first, then
 * (1.7 F2) one closed group of the earlier ones — every session that is not active, at most
 * MAX_ROOTS of them, most recent first; of them only what is open — in `page` mode a node carries
 * its children only while the reader opened
 * it, at most MAX_GROUP_CHILDREN of them and as many again per "more" step, with the path to
 * the selected node and the running children pinned in, the whole payload at most
 * MAX_PAGE_NODES nodes; in `text` mode every node is open, MAX_GROUP_CHILDREN children each.
 * Every node says, open or not, whether it has children, how many, and what the agents below it
 * came to, counted on the whole tree. Then the running agents of every session, the 7-day block
 * while it is open (1.6 L3), and the details of `input.selected` while its row is on the page — in
 * the tree, in the running list or among the block's largest agents, both of which may name a node
 * of a session the tree does not list; `text` mode prints every node, so it has the details of the
 * selected node wherever it sits.
 */
export function buildAgentTree(input: AgentTreeInput, now: number): AgentTreeVm {
  const forest = buildForest(input, now)
  const whole = input.mode === 'text'
  // 1.7 F2: the roots split, in their order, into the active sessions — an own line within
  // SESSION_ACTIVE_MS, or a running member (the roll-up of buildRoot), so no running node is ever
  // among the others — and the earlier ones, idle or unknown, which the page shows in one group
  // after them. A presentation of the roots, never a filter of the forest: the running list, the
  // tallies, the counts and the 7-day block below are all taken on every root.
  const split = input.split !== false
  const active = split ? forest.roots.filter((r) => r.state === 'active') : forest.roots
  const earlier = split ? forest.roots.filter((r) => r.state !== 'active') : []
  const listedActive = active.slice(0, MAX_ROOTS)
  const inGroup = earlier.slice(0, MAX_ROOTS)
  const selectedKey = text(input.selected)
  const selected = selectedKey !== null ? forest.byKey.get(selectedKey) ?? null : null
  // Every root, listed or not: the host polls while anything runs, wherever it sits — every
  // running member, a collector's included (D4), as the sessions' tallies count them.
  let running = 0
  for (const r of forest.roots) for (const e of preorder(r)) running += runningMembers(e)
  const live = runningOf(forest.roots)
  const listed = live.slice(0, MAX_RUNNING_LIST)
  const listedKeys = new Set(listed.map((e) => e.key))
  const counts = agentCounts(forest.roots)
  const group = inGroup.length > 0 ? earlierGroup(inGroup, counts) : null
  const shown = group !== null ? [...listedActive, group] : listedActive
  const opened = new Set(Array.isArray(input.expanded) ? input.expanded.filter((k) => typeof k === 'string') : [])
  const pages = whole ? new Map<string, number>() : pagesFrom(input.more)
  const isOpen = (e: Entry): boolean => whole || opened.has(e.key)
  const limitOf = (e: Entry): number => MAX_GROUP_CHILDREN * (1 + (pages.get(e.key) ?? 0))
  // The running nodes in the order the page draws them (1.6 N6: the newest first), so the cap —
  // after the selection — keeps the running rows nearest the top, as a window pins its running
  // children in display order; the running list keeps its own order, the longest-running first.
  const drawn = new Map<Entry, number>()
  for (const r of forest.roots) for (const e of preorder(r)) drawn.set(e, drawn.size)
  const liveDrawn = [...live].sort((x, y) => (drawn.get(x) ?? 0) - (drawn.get(y) ?? 0))
  // 1.6 L3: the 7-day block, while the reader has it open. Its largest agents are rows on the page
  // as the running list's are (§3.0 b) — their details open wherever their tree rows are — and the
  // block's rows are rows of the payload too, so the tree has that many fewer places under its cap.
  const week = input.weekOpen === true ? weekOf(forest.roots, input.pricing ?? null, input.tcfg) : null
  const weekKeys = new Set(week !== null ? week.top.map((x) => x.key) : [])
  const cap = MAX_PAGE_NODES - (week !== null ? week.rows.length + week.top.length : 0)
  const payload = payloadOf(shown, isOpen, limitOf, selected, liveDrawn, cap)

  const toNode = (e: Entry): TreeNode => {
    const kids = payload.shipped.get(e) ?? []
    return {
      key: e.key,
      kind: e.kind,
      label: e.label,
      fullLabel: e.fullLabel,
      sub: e.sub,
      state: e.state,
      derived: derivedOf(e.state),
      usage: e.usage,
      usageAgents: e.usageAgents,
      lowerBound: e.lowerBound,
      lowerBoundText: e.lowerBoundText,
      duration: e.duration,
      startTs: e.startTs,
      lastTs: e.lastTs,
      startClock: clockOf(e.startTs, now, input.tcfg),
      lastClock: clockOf(e.lastTs, now, input.tcfg),
      silence: silenceOf(e),
      hookWait: e.hookWait,
      agentCount: counts.get(e) ?? 0,
      hasChildren: e.children.length > 0,
      childrenTotal: e.children.length,
      childrenMore: e.children.length > 0 && isOpen(e) ? e.children.length - kids.length : 0,
      tally: e.tally === null ? null : { ...e.tally },
      tallyText: e.tally === null ? null : tallyText(e.tally),
      tallySpoken: e.tally === null ? null : tallySpoken(e.tally),
      superseded: e.superseded,
      children: kids.map(toNode),
    }
  }

  // A selected node is reachable while its session is listed — among the active roots, or (1.7
  // F2) in the group of earlier sessions, open or closed —, or while the running list or the
  // open 7-day block names it — both hold agents of sessions beyond MAX_ROOTS too; anything else — its
  // session not listed and itself not running, or gone from the records — gets the note, since
  // a stored selection that opens nothing would otherwise look like a panel that failed. A
  // reachable node gets its details while its row is on the page: in the payload, in the running
  // list, or in the block. One inside a closed branch has no row there and gets no panel and no note —
  // opening the branch brings the panel back, and nothing on the page could close a panel that
  // stood for a row nobody sees — a node inside the closed group of earlier sessions (1.7 F2) is such
  // a node. The markdown prints every node, so it always has the row.
  let top: Entry | null = selected
  while (top !== null && top.parent !== null) top = top.parent
  const reachable = selected !== null
    && ((top !== null && shown.includes(top)) || listedKeys.has(selected.key) || weekKeys.has(selected.key))
  const onPage = selected !== null
    && (whole || payload.emitted.has(selected) || listedKeys.has(selected.key) || weekKeys.has(selected.key))
  const details = selected !== null && reachable && onPage ? detailsOf(selected) : null
  let note: string | null = null
  if (forest.roots.length === 0) {
    // A session that is older than a day and never ran an agent is not in the tree; saying
    // there was no session at all would then be untrue.
    note = forest.anyMain
      ? t('No agent in the last {0} days, and no Claude Code session in the last {1} hours.',
        AGENT_RETENTION_DAYS, ROOT_WINDOW_MS / HOUR_MS)
      : t('No Claude Code session in the last 7 days.')
  } else if (selectedKey !== null && !reachable && selectedKey !== EARLIER_KEY) {
    // 1.7 F2: the group has no details, and a stored selection of it — none can be made — is a
    // node without details: no panel, and no note that it is gone.
    note = t('The selected node is no longer in the tree.')
  }
  return {
    roots: shown.map(toNode),
    selected: details,
    running,
    runningNow: listed.map((e) => runningItem(e, now, input.tcfg)),
    runningMore: Math.max(0, live.length - MAX_RUNNING_LIST),
    omittedRoots: (active.length - listedActive.length) + (earlier.length - inGroup.length),
    note,
    week,
  }
}

/**
 * The details of any node of the whole tree by its key — cap and root limit left aside — or
 * null when no node has that key.
 */
export function agentDetails(input: AgentTreeInput, now: number, key: string): NodeDetails | null {
  // 1.7 F2: the group of earlier sessions is a container, not a node with details.
  if (key === EARLIER_KEY) return null
  const e = buildForest(input, now).byKey.get(key)
  return e ? detailsOf(e) : null
}

// ---------------------------------------------------------------------------
// The export's view of the records (1.6 O2)
// ---------------------------------------------------------------------------

/**
 * One agent record as the tree reads it, for the export: what its row and its details show of it
 * and nothing else — ids, its type and model, its state, its counts, its times, who launched it and
 * Claude Code's own report. Never a path (the record's own and its launch's `file` stay here), never
 * a word of what it was asked or answered: the records hold none.
 */
export interface AgentRecordView {
  agentId: string
  sessionId: string
  /** The run it belongs to, or null for an agent outside a workflow run. */
  workflowId: string | null
  /** As its name says it; null where neither the sidecar nor the launch named one. */
  type: string | null
  model: string | null
  /** The real model ids its replies were written with, in the order first seen. */
  models: string[]
  /** The effort of its newest reply (N8), or null. */
  effort: Effort | null
  /** The state its row shows — a run's collector member's own (D4) —, and whether it was inferred. */
  state: NodeState
  derived: boolean
  /** What the parent recorded — its tool result or a task notification —, with its own word; null when it recorded nothing. */
  outcome: RecordedOutcome | null
  outcomeStatus: LaunchStatus | null
  /** Which start of its workflow step it is (D7), as the run's journal numbers them; null outside a run or without a step. */
  attempt: number | null
  /** Its first line and its last activity — a request the API rejected after its last counted reply included (N3). */
  firstTs: number
  lastTs: number
  input: number; cacheWrite: number; cacheWrite1h: number; cacheRead: number
  output: number; reasoning: number; requests: number; outputFinal: number; toolCalls: number
  /** Billable tokens, as its row's usage counts them. */
  usage: number
  /** The tool results marked as errors (O3), where the record counts them; null until it does. */
  toolErrors: number | null
  /** Who launched it: an agent of its session by id, 'session' for the session's own transcript, null when neither is known. */
  spawnedBy: string | null
  /** Claude Code's own report for it (D9), never added to anything; null without one. */
  report: { tokens: number; durationMs: number; toolUses: number } | null
}

/**
 * Every agent record the tree holds, as its rows and details read it (1.6 O2) — every session's, not
 * only the MAX_ROOTS the page lists, a run's collector members (D4) included, each at the state the
 * tree gives it; the records the tree leaves out (older than the retention, or not whole) are not
 * among them. The first line first.
 */
export function agentRecordViews(input: AgentTreeInput, now: number): AgentRecordView[] {
  const forest = buildForest(input, now)
  const states = new Map<string, NodeState>()
  for (const root of forest.roots) {
    for (const e of preorder(root)) {
      if (e.kind === 'agent' && e.id !== null) states.set(e.id, e.state)
      for (const m of e.collected) if (!states.has(m.agentId)) states.set(m.agentId, m.state)
    }
  }
  // The journal of each run, as the tree joins a run's agents to it: the first one of each run.
  const journals = new Map<string, RunView>()
  for (const run of input.runs ?? []) {
    if (!validRun(run)) continue
    const key = `${run.sessionId}|${run.workflowId}`
    if (!journals.has(key)) journals.set(key, runView(run))
  }
  const out: AgentRecordView[] = []
  for (const [id, r] of forest.records) {
    const state = states.get(id)
    if (state === undefined) continue
    const launch = forest.launchOf(r)
    const models = modelsOf(r.models)
    const name = nameOf(r, launch, models)
    const wf = text(r.workflowId)
    const journal = wf !== null ? journals.get(`${r.sessionId}|${wf}`)?.byAgent.get(id) ?? null : null
    const step = journal !== null && typeof journal.step === 'number' && Number.isInteger(journal.step) ? journal.step : 0
    const attempt = step > 0 && journal !== null && Number.isInteger(journal.attempt) && journal.attempt >= 1 ? journal.attempt : null
    const recorded = recordedOutcome(r, launch)
    const c = countersOf(r)
    out.push({
      agentId: id,
      sessionId: r.sessionId,
      workflowId: wf,
      type: name.type,
      model: name.model,
      models,
      effort: effortLevel(r.effort),
      state,
      derived: derivedOf(state),
      outcome: recorded?.outcome ?? null,
      outcomeStatus: recorded?.word ?? null,
      attempt,
      firstTs: firstOf(r),
      lastTs: activityOf(r, rejectionOf(r)),
      ...c,
      usage: billable(bucketOf(c, true)),
      toolErrors: wholeCount(r.toolErrors),
      spawnedBy: spawnerOf(r, launch, forest.records),
      report: reportOf(launch),
    })
  }
  return out.sort((x, y) => x.firstTs - y.firstTs || cmp(x.agentId, y.agentId))
}

/**
 * Who launched an agent, as its details' "Spawned by" row names it: an agent of the same session by
 * its id, or the session's own transcript; null when the launching transcript is neither — or unknown.
 * No launching transcript known: the agent the sidecar names as its parent (O3, §0a.11), when it is
 * one of the same session.
 */
function spawnerOf(r: AgentRec, launch: AgentLaunch | null, records: ReadonlyMap<string, AgentRec>): string | null {
  const file = text(r.spawnerFile) ?? text(launch?.file)
  if (file === null) {
    const parent = parentAgentIdOf(r)
    return parent !== null && records.get(parent)?.sessionId === r.sessionId ? parent : null
  }
  const id = agentIdOf(file)
  if (id !== null) return id !== r.agentId && records.get(id)?.sessionId === r.sessionId ? id : null
  const place = sessionOfPath(file)
  return place !== null && place.main && place.sessionId === r.sessionId ? 'session' : null
}

/** Claude Code's report for an agent, as the details' row takes it: three figures, all of them, or none. */
function reportOf(l: AgentLaunch | null): AgentRecordView['report'] {
  const r = l?.totals
  if (!r || typeof r !== 'object') return null
  const nums = [r.tokens, r.durationMs, r.toolUses]
  if (!nums.every((n) => typeof n === 'number' && Number.isFinite(n) && n >= 0)) return null
  return { tokens: r.tokens, durationMs: r.durationMs, toolUses: r.toolUses }
}
