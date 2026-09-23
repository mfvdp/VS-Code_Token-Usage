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
 * every member is closed — what its members came to, and failing both what their clocks say; a
 * run nothing but its launch shows yet runs by the launch's clock (1.6 N4, §3.0 c).
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
  AGENT_RETENTION_DAYS, AgentTally, AgentTreeVm, DetailRow, MAX_GROUP_CHILDREN, MAX_MORE_PAGES, MAX_PAGE_NODES, MAX_ROOTS,
  MAX_RUNNING_LIST, MAX_TREE_DEPTH, MIN_SHORT_ID, NodeDetails, NodeState, RESUMED_AFTER_MS, ROOT_WINDOW_MS, RUNNING_WINDOW_MS,
  RunningItem, SESSION_ACTIVE_MS, SPAN_IN_DAYS_FROM_MS, TreeNode,
} from './agentTree'
import { billable, outcomeOfStatus } from './agg'
import { t } from './i18n'
import { normalizeModel } from './prices'
import { compact, full } from './render'
import { durationText, freshInput, tokens } from './stats'
import { TimeConfig, ageText, dayOf, formatTime } from './time'
import {
  AgentLaunch, AgentRec, Attribution, Bucket, JournalAgent, LaunchStatus, MainRec, RecordedOutcome, RunLaunch, RunRec,
  SessionRec, emptyBucket,
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

/** "14:20" today, "2026-09-01 14:20" on any other day — the Sessions table's own form. */
function stamp(ms: number, now: number, tcfg: TimeConfig): string {
  const time = formatTime(ms, tcfg)
  const day = dayOf(ms, tcfg)
  return day === dayOf(now, tcfg) ? time : `${day} ${time}`
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

function sessionLabel(sessionId: string): string {
  return t('Session {0}', sessionId.slice(0, 8))
}

function workflowLabel(workflowId: string): string {
  return t('Workflow {0}', workflowId.replace(/^wf_/, '').slice(0, 8))
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
function resumedAfter(o: Outcome, r: AgentRec): boolean {
  return o.at !== null && r.lastTs > o.at + RESUMED_AFTER_MS
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
 * outlived; failing both, what its transcript's clock says.
 */
function agentState(
  r: AgentRec, launch: AgentLaunch | null, journal: StateOf | null, now: number, tcfg: TimeConfig,
): StateOf {
  const o = recordedOutcome(r, launch)
  const last = Math.max(r.lastTs, launch ? launch.ts : 0)
  if (o && o.at !== null && resumedAfter(o, r)) {
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
        at, stamp(r.lastTs, now, tcfg)),
      resumed: o,
    }
  }
  if (o) return outcomeState(o, now, tcfg)
  if (journal) return journal
  if (now - last <= RUNNING_WINDOW_MS) {
    return {
      state: 'running',
      stateText: t('Running — inferred: the transcript changed {0} and no result was recorded yet.', ago(last, now)),
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
 * and whether a later attempt of its step superseded it (D7). An agent, a pending launch, or an
 * agent a run's journal started without a counted transcript.
 */
interface Member {
  state: NodeState
  superseded: boolean
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
function tallyInto(tally: AgentTally, m: Member): void {
  tally.started++
  if (m.superseded) tally.retried++
  else if (m.state === 'done' || m.state === 'failed' || m.state === 'stopped' || m.state === 'running') tally[m.state]++
  else tally.unknown++
}

/**
 * The tally of everything below a node (N1), on the whole tree: every agent and launch at any
 * depth, and the members the journal of each run among them started without a counted
 * transcript. The node itself is not counted, whatever it is.
 */
function tallyBelow(e: Entry): AgentTally {
  const out = noTally()
  for (const x of preorder(e)) {
    if (x !== e && isAgentLike(x)) tallyInto(out, x)
    for (const m of x.journalMembers) tallyInto(out, m)
  }
  return out
}

/**
 * "427 started · 112 ✓ · 12 ✕ · 295 ↻ · ~8 ?" — the started agents, then each state at least one
 * of them is in, with the glyph its rows carry: done, failed, retried, stopped, running,
 * unknown. The two inferred states carry the tilde every estimate on the page carries.
 */
function tallyText(n: AgentTally): string {
  const parts = [t('{0} started', full(n.started))]
  const glyphs: Array<[number, string]> = [
    [n.done, `${full(n.done)} ✓`], [n.failed, `${full(n.failed)} ✕`], [n.retried, `${full(n.retried)} ↻`],
    [n.stopped, `${full(n.stopped)} ■`], [n.running, `~${full(n.running)} ●`], [n.unknown, `~${full(n.unknown)} ?`],
  ]
  for (const [count, part] of glyphs) if (count > 0) parts.push(part)
  return parts.join(' · ')
}

/** The tally in words, in the same order — what a screen reader says in place of the glyphs. */
function tallySpoken(n: AgentTally): string {
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

/**
 * The third source of a run's end (§3.0 c): Claude Code's own run record (1.6 L4), which this
 * build does not read yet — so it says nothing, and the run's state is its members'.
 */
function recordRunEnd(run: RunRec | null): StateOf | null {
  void run
  return null
}

/**
 * A workflow run's state (§3.0 c): the end its parent recorded for its latest launch, then — once
 * every member is closed — what they came to (the journal's view, `workflowState`), then Claude
 * Code's run record, then what its members' clocks say. A recorded end does not close a member:
 * one without an outcome of its own keeps its own state and counts so in the tally, so a done run
 * may show an agent still running beside it for up to ten minutes. The parent's end is outlived
 * like an agent's (D6): a member whose last line came more than RESUMED_AFTER_MS after it makes
 * the run's state an inference again, the recorded end kept for the details (`resumed`). A run no
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
  const record = recordRunEnd(run)
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
 * ticks in (`live`), in place of the age written here, which the markdown keeps.
 */
function timeRows(start: number | null, last: number | null, now: number, tcfg: TimeConfig, session = false): DetailRow[] {
  const length = start === null || last === null ? '–' : session ? spanText(last - start) : durationText(last - start)
  return [
    { label: session ? t('Since first line') : t('Started'), value: start === null ? '–' : stamp(start, now, tcfg) },
    { label: session ? t('Span') : t('Duration'), value: length },
    last === null
      ? { label: t('Last activity'), value: '–' }
      : { label: t('Last activity'), value: stamp(last, now, tcfg), note: ago(last, now), live: 'ago' },
  ]
}

/** The row the Copy ID button copies: the whole identifier, which a name only starts. */
function idRow(id: string): DetailRow {
  return { label: t('ID'), value: id, copy: true }
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
 * Turns, the token kinds of the totals table and the tool calls. Nothing counted is a dash
 * throughout — a record without a request has no zero to report. Output is marked as a lower
 * bound when a reply never reached its final line: there is no end marker in an agent's file,
 * so its last reply often stops mid-stream.
 */
function countRows(c: Counters | null): DetailRow[] {
  if (c === null || c.requests === 0) {
    return [t('Turns'), t('Usage'), t('Fresh input'), t('Cache write 5m'), t('Cache write 1h'), t('Cache read'),
      t('Output'), t('Reasoning'), t('Tool calls')].map((label) => ({ label, value: '–' }))
  }
  const b = bucketOf(c, true)
  const output: DetailRow = { label: t('Output'), value: tokens(c.output) }
  if (c.outputFinal < c.requests) output.note = `⚠ ${t('lower bound')}`
  return [
    { label: t('Turns'), value: full(c.requests) },
    { label: t('Usage'), value: compact(billable(b)) },
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
  const r = l?.totals
  if (!r || typeof r !== 'object') return []
  const nums = [r.tokens, r.durationMs, r.toolUses]
  if (!nums.every((n) => typeof n === 'number' && Number.isFinite(n) && n >= 0)) return []
  return [{
    label: t('Report from Claude Code'),
    value: t('context at the end {0} (incl. cache reads and the reply) · {1} from the start · {2} tool calls',
      compact(r.tokens), durationText(r.durationMs), full(r.toolUses)),
    note: t("Claude Code's own figure for this agent, never added to a total"),
    kind: 'sentence',
  }]
}

function depthText(v: unknown): string {
  return typeof v === 'number' && Number.isInteger(v) && v >= 1 ? String(v) : '–'
}

// ---------------------------------------------------------------------------
// The forest
// ---------------------------------------------------------------------------

interface Entry {
  key: string
  kind: TreeNode['kind']
  label: string
  sub: string | null
  state: NodeState
  stateText: string
  usage: string
  /** D5: a session's agents' usage, beside its own; null for every other node and a session without agents. */
  usageAgents: string | null
  lowerBound: boolean
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
   * A workflow run's members its journal started and no transcript of which was counted (D2):
   * counted in the run's state and in every agent count above it, with no row of their own
   * (their collector comes with D4). Empty for every other node.
   */
  journalOnly: JournalAgent[]
  /**
   * The states of those journal-only members, as the run's state rule and every tally above
   * the run count them (N1). Empty for every other node.
   */
  journalMembers: Member[]
  /** N1: the tally of the members below the node, where it carries one; null elsewhere. */
  tally: AgentTally | null
  /** Built on demand: only the selected node's rows are ever needed. */
  rows: () => DetailRow[]
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
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

function byStart(a: Entry, b: Entry): number {
  const x = a.startTs ?? Infinity
  const y = b.startTs ?? Infinity
  return x < y ? -1 : x > y ? 1 : cmp(a.key, b.key)
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

/** The agents and launches below a node, its runs' journal-only members included — what its count says. */
function membersBelow(e: Entry): number {
  let n = 0
  for (const x of preorder(e)) {
    if (x !== e && isAgentLike(x)) n++
    n += x.journalOnly.length
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
  const agents = (input.agents ?? []).filter((r) => validAgent(r) && r.lastTs >= since)
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
    })
    for (const e of preorder(root)) if (!byKey.has(e.key)) byKey.set(e.key, e)
    roots.push(root)
  }
  const order = new Map(roots.map((r) => [r, r.lastTs ?? latest(r)]))
  roots.sort((x, y) => (order.get(y) ?? 0) - (order.get(x) ?? 0) || cmp(x.key, y.key))
  return { roots, byKey, anyMain: mains.length > 0 }
}

interface RootEnv {
  now: number
  tcfg: TimeConfig
  attribution: Attribution
  project: string | null
  launchOf: (r: AgentRec) => AgentLaunch | null
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
  const root: Entry = {
    key: fitKey('s:', a.sessionId),
    kind: 'session',
    label: sessionLabel(a.sessionId),
    // Attribution off: no project names anywhere, and the tree does not make an exception.
    sub: env.attribution !== 'none' ? env.project : null,
    ...sessionState(main, now, tcfg),
    usage: mainCounters ? usageText(mainCounters) : '–',
    usageAgents,
    lowerBound: mainCounters ? mainCounters.outputFinal < mainCounters.requests : false,
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
    journalOnly: [],
    journalMembers: [],
    tally: null,
    rows: () => [],
  }
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
    ...countRows(mainCounters),
    { label: t('Agents'), value: full(membersBelow(root)) },
    idRow(a.sessionId),
  ]

  const workflows = new Map<string, Entry>()
  const workflowOf = (wf: string): Entry => {
    let w = workflows.get(wf)
    if (!w) {
      w = {
        key: fitKey('w:', `${a.sessionId}|${wf}`),
        kind: 'workflow',
        label: workflowLabel(wf),
        sub: null,
        state: 'unknown',
        stateText: '',
        usage: '–',
        usageAgents: null,
        lowerBound: false,
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
        journalOnly: [],
        journalMembers: [],
        tally: null,
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
  /** Who launched a node, by name: an agent of this session, the session itself, or '–'. */
  const spawnedBy = (file: string | null): string => {
    if (file === null) return '–'
    const id = agentIdOf(file)
    if (id !== null) return byAgent.get(id)?.label ?? '–'
    const place = sessionOfPath(file)
    return place !== null && place.main && place.sessionId === a.sessionId ? root.label : '–'
  }
  for (const r of ordered) {
    const launch = env.launchOf(r)
    const c = countersOf(r)
    const first = firstOf(r)
    const models = modelsOf(r.models)
    const wf = text(r.workflowId)
    const type = text(r.meta?.agentType) ?? text(launch?.typeHint)
    const alias = text(r.meta?.model) ?? text(launch?.modelHint)
    const lastModel = models.length > 0 ? normalizeModel(models[models.length - 1]) : ''
    // The journal's view of a run's agent, joined by id within its run (D2, D7).
    const view = wf !== null ? a.runs.get(wf) ?? null : null
    const journal = view?.byAgent.get(r.agentId) ?? null
    const next = journal !== null ? text(journal.supersededBy) : null
    const st = agentState(r, launch, journal ? journalState(journal, next !== null ? shortOf(next) : null) : null, now, tcfg)
    const step = journal !== null && typeof journal.step === 'number' && Number.isInteger(journal.step) ? journal.step : 0
    const attempts = step > 0 ? view?.attempts.get(step) ?? 0 : 0
    const e: Entry = {
      key: fitKey('a:', r.agentId),
      kind: 'agent',
      label: `${type ?? t('Agent')} · ${lastModel || alias || '–'} · ${shortOf(r.agentId)}`,
      sub: null,
      state: st.state,
      stateText: st.stateText,
      usage: usageText(c),
      usageAgents: null,
      lowerBound: c.outputFinal < c.requests,
      duration: durationText(r.lastTs - first),
      startTs: first,
      lastTs: r.lastTs,
      id: r.agentId,
      parent: null,
      children: [],
      waiting: false,
      workflowId: wf,
      counters: c,
      superseded: next !== null,
      journalOnly: [],
      journalMembers: [],
      tally: null,
      rows: () => [],
    }
    e.rows = () => [
      { label: t('Type'), value: type ?? '–' },
      { label: t('Models'), value: models.join(', ') || alias || '–' },
      idRow(r.agentId),
      { label: t('Depth'), value: depthText(r.meta?.spawnDepth) },
      ...timeRows(e.startTs, e.lastTs, now, tcfg),
      ...recordedRows(st.resumed, now, tcfg),
      ...countRows(c),
      { label: t('Spawned by'), value: spawnedBy(spawnerFileOf.get(e) ?? null) },
      { label: t('Workflow run'), value: wf !== null ? workflowLabel(wf) : '–' },
      // D7: which attempt at its step this agent is, where the journal started the step more than once.
      ...(attempts >= 2 && journal !== null && Number.isInteger(journal.attempt) && journal.attempt >= 1
        ? [{ label: t('Attempt'), value: t('{0} of {1} of this step', full(journal.attempt), full(attempts)) }]
        : []),
      ...reportRows(launch),
    ]
    byAgent.set(r.agentId, e)
    spawnerFileOf.set(e, text(r.spawnerFile) ?? text(launch?.file))
  }

  // Each agent under the agent that spawned it, when that agent is in this session's tree. A
  // run's agents stay inside the run: a spawner outside it would scatter one workflow.
  const up = new Map<Entry, Entry | null>()
  for (const e of byAgent.values()) {
    const file = spawnerFileOf.get(e) ?? null
    const id = file !== null ? agentIdOf(file) : null
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
    const e: Entry = {
      key: fitKey('l:', l.toolUseId),
      kind: 'pending',
      label: t('{0} · {1} · launched', text(l.typeHint) ?? t('Agent'), text(l.modelHint) ?? '–'),
      sub: null,
      ...pendingState(l, now, tcfg),
      // No transcript, so nothing was counted: dashes, never zeros.
      usage: '–',
      usageAgents: null,
      lowerBound: false,
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
      journalOnly: [],
      journalMembers: [],
      tally: null,
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
  // all the same. A run with nothing but such members is a run of the session too.
  for (const [wf, view] of a.runs) {
    const recorded = new Set(a.agents.filter((r) => text(r.workflowId) === wf).map((r) => r.agentId))
    const only = [...view.byAgent.values()].filter((j) => !recorded.has(j.agentId))
    if (only.length === 0) continue
    workflowOf(wf).journalOnly = only
  }
  // N4: a run its parent launched is a run of the session from the launch on — before any agent
  // of it has written a line, or its journal one.
  for (const wf of a.runLaunches.keys()) workflowOf(wf)

  // A run is summed from the agents inside it, on the whole tree: a closed run, or one showing
  // fifty of its agents at a time, hides some of them from the page, but that does not change
  // what the run used. Its state is the one function of its members' tally (§3.0 a), so the
  // row's glyph and the tally beside it always agree.
  for (const [wf, w] of workflows) {
    const members = [...preorder(w)].filter(isAgentLike)
    const sum = noCounters()
    let first: number | null = null
    let last: number | null = null
    for (const m of members) {
      if (m.counters) addInto(sum, m.counters)
      if (m.startTs !== null && (first === null || m.startTs < first)) first = m.startTs
      if (m.lastTs !== null && (last === null || m.lastTs > last)) last = m.lastTs
    }
    // N4: the launches of the run, a resume being one more. The latest decides the parent's end.
    const launches = a.runLaunches.get(wf) ?? []
    const latest = latestLaunch(launches)
    const run = a.runs.get(wf)?.run ?? null
    const siblingRuns = members.some((m) => m.state === 'running')
    const only: Member[] = run === null ? [] : w.journalOnly.map((j) => ({
      state: journalOnlyState(j, run, siblingRuns, now), superseded: text(j.supersededBy) !== null,
    }))
    if (only.some((m) => m.state === 'running')) anyRunning = true
    w.journalMembers = only
    const tally = tallyBelow(w)
    // The members' last line, before the launches fill in for a run nobody has written to yet.
    const st = runState(tally, latest, run, last, now, tcfg)
    w.state = st.state
    w.stateText = st.stateText
    w.counters = sum
    w.usage = usageText(sum)
    w.lowerBound = sum.outputFinal < sum.requests
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
    const dropped = run !== null && typeof run.agentsDropped === 'number' && Number.isInteger(run.agentsDropped)
      && run.agentsDropped > 0 ? run.agentsDropped : 0
    // A run whose agents nobody has seen yet has no count to state: '–', never an invented 0.
    const agentsValue = tally.started > 0 ? full(tally.started) : '–'
    const agentsRow: DetailRow = dropped > 0
      ? {
        label: t('Agents'), value: agentsValue,
        note: t('{0} further agents not listed', full(dropped)), kind: 'sentence',
      }
      : { label: t('Agents'), value: agentsValue }
    // N4: a resumed run was launched more than once — the ends of the earlier launches are its
    // history, and only the latest launch's decides the run.
    const launchesRow: DetailRow[] = launches.length >= 2
      ? [{ label: t('Launches'), value: t('{0} — resumed {1} time(s)', full(launches.length), full(launches.length - 1)) }]
      : []
    w.rows = () => [
      agentsRow,
      ...launchesRow,
      ...timeRows(w.startTs, w.lastTs, now, tcfg),
      ...recordedRows(st.resumed, now, tcfg),
      ...countRows(sum),
      idRow(wf),
    ]
  }
  // A session whose agents do the work while its own transcript waits is in use all the same.
  if (anyRunning && root.state !== 'active') {
    root.state = 'active'
    root.stateText = t('Active — inferred: an agent of this session is running.')
  }

  // N1: what the agents below each session, run and agent came to, every state final by now —
  // the roll-up's waiting agents included. A node with no agent below it has no tally, so a
  // session without agents claims no "0 started", and a leaf agent none at all.
  for (const e of preorder(root)) {
    if (e.kind !== 'session' && e.kind !== 'workflow' && e.kind !== 'agent') continue
    const tally = tallyBelow(e)
    e.tally = tally.started > 0 ? tally : null
  }

  for (const e of preorder(root)) e.children.sort(byStart)
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
 * draws them, with the child on the path to the selected node and every running child pinned
 * into those places — each taking the place of the last child that is not pinned, so the ones
 * shown keep their order. Only when the pinned children alone are more than `limit` does one
 * of them go: the path to the selection first, then the running children in order. A node with
 * no more children than `limit` shows them all.
 */
function windowOf(e: Entry, limit: number, onPath: ReadonlySet<Entry>): Entry[] {
  if (e.children.length <= limit) return e.children
  const pinned: Entry[] = []
  const toSelected = e.children.find((c) => onPath.has(c))
  if (toSelected) pinned.push(toSelected)
  for (const c of e.children) if (c !== toSelected && c.state === 'running') pinned.push(c)
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
    key: e.key, title: e.label, state: e.state, derived: derivedOf(e.state), stateText: e.stateText,
    lastTs: e.lastTs, id: e.id, rows: e.rows(),
  }
}

/**
 * The agents and pending launches below a node — what its tally counts — for every node at
 * once, on the whole tree: open or closed, inside a node's window or past it.
 */
function agentCounts(roots: Entry[]): Map<Entry, number> {
  const out = new Map<Entry, number>()
  // A run's journal-only members (D2) count where its drawn agents do.
  const count = (e: Entry): number => {
    let n = e.journalOnly.length
    for (const c of e.children) n += count(c) + (isAgentLike(c) ? 1 : 0)
    out.set(e, n)
    return n
  }
  for (const r of roots) count(r)
  return out
}

/**
 * Where a running node sits, in the words of the nodes above it: its session, the run it
 * belongs to if any, and the session's project while attribution names one (`sub` is null
 * otherwise, see buildRoot).
 */
function contextOf(e: Entry): string {
  let root = e
  let run: Entry | null = null
  for (let p = e.parent; p !== null; p = p.parent) {
    if (run === null && p.kind === 'workflow') run = p
    root = p
  }
  return [root.label, run?.label ?? null, root.sub].filter((s): s is string => !!s).join(' · ')
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
 * Every agent and pending launch in state running, from all roots — listed or not, open or
 * closed, inside a window or past it: whoever watches the list came to see exactly these,
 * wherever the tree put them. One entry per key.
 */
function runningOf(roots: Entry[]): Entry[] {
  const seen = new Set<string>()
  const out: Entry[] = []
  for (const r of roots) {
    for (const e of preorder(r)) {
      if (!isAgentLike(e) || e.state !== 'running' || seen.has(e.key)) continue
      seen.add(e.key)
      out.push(e)
    }
  }
  return out.sort(byStartThenKey)
}

function runningItem(e: Entry): RunningItem {
  return {
    key: e.key,
    kind: e.kind === 'pending' ? 'pending' : 'agent',
    label: e.label,
    context: contextOf(e),
    // A launch nobody has read a line of has nothing counted; the builder already says '–'.
    usage: e.kind === 'pending' ? '–' : e.usage,
    // Nearly always true for a running agent: it is mid-reply. The row does not mark it (the
    // details do); the line under the tree and the markdown's running line need to know.
    lowerBound: e.kind === 'pending' ? false : e.lowerBound,
    startTs: e.startTs,
    lastTs: e.lastTs,
    waiting: e.waiting,
  }
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
 * The tree for the view model (1.6 D3): at most MAX_ROOTS sessions, most recent first; of them
 * only what is open — in `page` mode a node carries its children only while the reader opened
 * it, at most MAX_GROUP_CHILDREN of them and as many again per "more" step, with the path to
 * the selected node and the running children pinned in, the whole payload at most
 * MAX_PAGE_NODES nodes; in `text` mode every node is open, MAX_GROUP_CHILDREN children each.
 * Every node says, open or not, whether it has children, how many, and what the agents below it
 * came to, counted on the whole tree. Then the running agents of every session, and the details
 * of `input.selected` while its row is on the page — in the tree, or in the running list, which
 * may name a node of a session the tree does not list; `text` mode prints every node, so it
 * has the details of the selected node wherever it sits.
 */
export function buildAgentTree(input: AgentTreeInput, now: number): AgentTreeVm {
  const forest = buildForest(input, now)
  const whole = input.mode === 'text'
  const shown = forest.roots.slice(0, MAX_ROOTS)
  const selectedKey = text(input.selected)
  const selected = selectedKey !== null ? forest.byKey.get(selectedKey) ?? null : null
  // Every root, listed or not: the host polls while anything runs, wherever it sits.
  let running = 0
  for (const r of forest.roots) for (const e of preorder(r)) if (isAgentLike(e) && e.state === 'running') running++
  const live = runningOf(forest.roots)
  const listed = live.slice(0, MAX_RUNNING_LIST)
  const listedKeys = new Set(listed.map((e) => e.key))
  const counts = agentCounts(forest.roots)
  const opened = new Set(Array.isArray(input.expanded) ? input.expanded.filter((k) => typeof k === 'string') : [])
  const pages = whole ? new Map<string, number>() : pagesFrom(input.more)
  const isOpen = (e: Entry): boolean => whole || opened.has(e.key)
  const limitOf = (e: Entry): number => MAX_GROUP_CHILDREN * (1 + (pages.get(e.key) ?? 0))
  const payload = payloadOf(shown, isOpen, limitOf, selected, live, MAX_PAGE_NODES)

  const toNode = (e: Entry): TreeNode => {
    const kids = payload.shipped.get(e) ?? []
    return {
      key: e.key,
      kind: e.kind,
      label: e.label,
      sub: e.sub,
      state: e.state,
      derived: derivedOf(e.state),
      usage: e.usage,
      usageAgents: e.usageAgents,
      lowerBound: e.lowerBound,
      duration: e.duration,
      startTs: e.startTs,
      lastTs: e.lastTs,
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

  // A selected node is reachable while its session is listed, or while the running list names
  // it — that list holds running agents of sessions beyond MAX_ROOTS too; anything else — its
  // session not listed and itself not running, or gone from the records — gets the note, since
  // a stored selection that opens nothing would otherwise look like a panel that failed. A
  // reachable node gets its details while its row is on the page: in the payload, or in the
  // running list. One inside a closed branch has no row there and gets no panel and no note —
  // opening the branch brings the panel back, and nothing on the page could close a panel that
  // stood for a row nobody sees. The markdown prints every node, so it always has the row.
  let top: Entry | null = selected
  while (top !== null && top.parent !== null) top = top.parent
  const reachable = selected !== null && ((top !== null && shown.includes(top)) || listedKeys.has(selected.key))
  const onPage = selected !== null && (whole || payload.emitted.has(selected) || listedKeys.has(selected.key))
  const details = selected !== null && reachable && onPage ? detailsOf(selected) : null
  let note: string | null = null
  if (forest.roots.length === 0) {
    // A session that is older than a day and never ran an agent is not in the tree; saying
    // there was no session at all would then be untrue.
    note = forest.anyMain
      ? t('No agent in the last {0} days, and no Claude Code session in the last {1} hours.',
        AGENT_RETENTION_DAYS, ROOT_WINDOW_MS / HOUR_MS)
      : t('No Claude Code session in the last 7 days.')
  } else if (selectedKey !== null && !reachable) {
    note = t('The selected node is no longer in the tree.')
  }
  return {
    roots: shown.map(toNode),
    selected: details,
    running,
    runningNow: listed.map(runningItem),
    runningMore: Math.max(0, live.length - MAX_RUNNING_LIST),
    omittedRoots: Math.max(0, forest.roots.length - MAX_ROOTS),
    note,
  }
}

/**
 * The details of any node of the whole tree by its key — cap and root limit left aside — or
 * null when no node has that key.
 */
export function agentDetails(input: AgentTreeInput, now: number, key: string): NodeDetails | null {
  const e = buildForest(input, now).byKey.get(key)
  return e ? detailsOf(e) : null
}
