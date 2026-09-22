// SPDX-FileCopyrightText: 2026 Frederik Marx
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The Agents section as a tree: session roots → workflow runs → agents → nested agents.
 *
 * Pure, like the view model it feeds: the records come in, `now` comes in, the tree comes
 * out, and nothing here reads a file or a clock. Every state is decided here and nowhere
 * else — the webview and the markdown only print it — and every state carries the sentence
 * that says what it rests on, because a "running" nobody can check is a claim, not a reading:
 *  - an agent is done or failed only when its parent (or the workflow journal) recorded it;
 *  - it is running while its transcript changed within RUNNING_WINDOW_MS and nothing was
 *    recorded yet;
 *  - anything else is unknown, never done: Claude Code writes no end marker into an agent's
 *    transcript, so a silent file is not a finished one.
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
  AGENT_RETENTION_DAYS, AgentTreeVm, DetailRow, MAX_NODES, MAX_ROOTS, MAX_TREE_DEPTH, NodeDetails,
  NodeState, ROOT_WINDOW_MS, RUNNING_WINDOW_MS, SESSION_ACTIVE_MS, TreeNode,
} from './agentTree'
import { billable } from './agg'
import { t } from './i18n'
import { normalizeModel } from './prices'
import { compact, full } from './render'
import { durationText, freshInput, tokens } from './stats'
import { TimeConfig, ageText, dayOf, formatTime } from './time'
import { AgentLaunch, AgentRec, Attribution, Bucket, MainRec, SessionRec, emptyBucket } from './types'

/** Everything the tree is built from. The view model fills it from the aggregator. */
export interface AgentTreeInput {
  agents: readonly AgentRec[]
  launches: readonly AgentLaunch[]
  mains: readonly MainRec[]
  /** The attribution table — the only place a session's project label comes from. */
  sessions: readonly SessionRec[]
  attribution: Attribution
  /** `ui.agentSelected`: the node whose details are open, or null. */
  selected: string | null
  tcfg: TimeConfig
  /**
   * The transcript paths the aggregator holds a cursor for. No longer read: they were the
   * bodies of the node keys, and a key carries no path any more. Accepted so that a caller
   * written against the earlier shape still compiles.
   */
  files?: Iterable<string>
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

/** Whether a state is inferred. Only a recorded outcome is a fact. */
function derivedOf(state: NodeState): boolean {
  return state !== 'done' && state !== 'failed'
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

function usageText(c: Counters): string {
  return c.requests > 0 ? compact(billable(bucketOf(c, true))) : '–'
}

function sessionLabel(sessionId: string): string {
  return t('Session {0}', sessionId.slice(0, 8))
}

function workflowLabel(workflowId: string): string {
  return t('Workflow {0}', workflowId.replace(/^wf_/, '').slice(0, 8))
}

interface StateOf { state: NodeState; stateText: string }

interface Outcome { outcome: 'completed' | 'failed'; at: number | null; by: 'parent' | 'journal' }

function outcomeState(o: Outcome, now: number, tcfg: TimeConfig): StateOf {
  const at = o.at === null ? null : stamp(o.at, now, tcfg)
  if (o.outcome === 'failed') {
    return {
      state: 'failed',
      stateText: at === null
        ? t('Failed — the parent recorded the failure.')
        : t('Failed — the parent recorded the failure at {0}.', at),
    }
  }
  if (o.by === 'journal') {
    return {
      state: 'done',
      stateText: at === null
        ? t('Completed — the workflow journal recorded the result.')
        : t('Completed — the workflow journal recorded the result at {0}.', at),
    }
  }
  return {
    state: 'done',
    stateText: at === null
      ? t('Completed — the parent recorded the result.')
      : t('Completed — the parent recorded the result at {0}.', at),
  }
}

function launchOutcome(l: AgentLaunch | null): 'completed' | 'failed' | null {
  return l && (l.outcome === 'completed' || l.outcome === 'failed') ? l.outcome : null
}

/**
 * What was recorded about an agent, and by whom. The record's own outcome first; the launch's
 * when the record has none yet — the parent may have written its result before the agent's
 * file was read. A completed workflow agent that no launch accounts for was completed by the
 * workflow journal, the only other source that records one.
 */
function recordedOutcome(r: AgentRec, launch: AgentLaunch | null): Outcome | null {
  const fromLaunch = launchOutcome(launch)
  if (r.outcome === 'completed' || r.outcome === 'failed') {
    const byParent = fromLaunch === r.outcome || !(r.workflowId && r.outcome === 'completed')
    const at = stampOf(r.outcomeTs) ?? (fromLaunch === r.outcome ? stampOf(launch?.outcomeTs) : null)
    return { outcome: r.outcome, at, by: byParent ? 'parent' : 'journal' }
  }
  if (fromLaunch) return { outcome: fromLaunch, at: stampOf(launch?.outcomeTs), by: 'parent' }
  return null
}

function agentState(r: AgentRec, launch: AgentLaunch | null, now: number, tcfg: TimeConfig): StateOf {
  const o = recordedOutcome(r, launch)
  if (o) return outcomeState(o, now, tcfg)
  const last = Math.max(r.lastTs, launch ? launch.ts : 0)
  if (now - last <= RUNNING_WINDOW_MS) {
    return {
      state: 'running',
      stateText: t('Running — inferred: the transcript changed {0} and no result was recorded yet.', ago(last, now)),
    }
  }
  return {
    state: 'unknown',
    stateText: t('Unknown — no result was recorded and the transcript has been silent since {0}; the agent may have been stopped.',
      stamp(r.lastTs, now, tcfg)),
  }
}

/** A launch whose agent file was never seen: the launch time is all the activity there is. */
function pendingState(l: AgentLaunch, now: number, tcfg: TimeConfig): StateOf {
  const o = launchOutcome(l)
  if (o) return outcomeState({ outcome: o, at: stampOf(l.outcomeTs), by: 'parent' }, now, tcfg)
  if (now - l.ts <= RUNNING_WINDOW_MS) {
    return {
      state: 'running',
      stateText: t("Running — inferred: the parent recorded the launch {0} and no result yet; the agent's transcript has not been seen yet.",
        ago(l.ts, now)),
    }
  }
  return {
    state: 'unknown',
    stateText: t("Unknown — the parent recorded the launch at {0} but no result, and the agent's transcript was never seen; the agent may have been stopped.",
      stamp(l.ts, now, tcfg)),
  }
}

function sessionState(main: MainRec | null, now: number, tcfg: TimeConfig): StateOf {
  if (!main) {
    return { state: 'unknown', stateText: t("Unknown — the session's own transcript has not been read; only its agents were.") }
  }
  if (now - main.lastTs <= SESSION_ACTIVE_MS) {
    return { state: 'active', stateText: t('Active — inferred: the session transcript changed {0}.', ago(main.lastTs, now)) }
  }
  return {
    state: 'idle',
    stateText: t('Idle — inferred: the session transcript has been silent since {0}.', stamp(main.lastTs, now, tcfg)),
  }
}

/** A workflow run from its agents: one running makes it running, one failure makes it failed. */
function workflowState(states: NodeState[]): StateOf {
  if (states.includes('running')) {
    return { state: 'running', stateText: t('Running — inferred: at least one agent of this run is running.') }
  }
  if (states.includes('failed')) {
    return { state: 'failed', stateText: t('Failed — at least one agent of this run has a recorded failure.') }
  }
  if (states.length > 0 && states.every((s) => s === 'done')) {
    return { state: 'done', stateText: t('Done — every agent of this run has a recorded result.') }
  }
  return { state: 'unknown', stateText: t('Unknown — not every agent of this run has a recorded result, and none is running.') }
}

// ---------------------------------------------------------------------------
// Detail rows
// ---------------------------------------------------------------------------

function timeRows(start: number | null, last: number | null, now: number, tcfg: TimeConfig): DetailRow[] {
  return [
    { label: t('Started'), value: start === null ? '–' : stamp(start, now, tcfg) },
    { label: t('Duration'), value: start === null || last === null ? '–' : durationText(last - start) },
    last === null
      ? { label: t('Last activity'), value: '–' }
      : { label: t('Last activity'), value: stamp(last, now, tcfg), note: ago(last, now) },
  ]
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
 * The parent's own figures for a sync agent — its count, not ours, and never added to one:
 * the parent's total need not follow the definition "Usage" follows.
 */
function reportRows(l: AgentLaunch | null): DetailRow[] {
  const r = l?.totals
  if (!r || typeof r !== 'object') return []
  const nums = [r.tokens, r.durationMs, r.toolUses]
  if (!nums.every((n) => typeof n === 'number' && Number.isFinite(n) && n >= 0)) return []
  return [{
    label: t("Parent's report"),
    value: t('{0} tokens · {1} · {2} tool calls', compact(r.tokens), durationText(r.durationMs), full(r.toolUses)),
    note: t("the parent's own count, not added to any total"),
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
  lowerBound: boolean
  duration: string
  startTs: number | null
  lastTs: number | null
  parent: Entry | null
  children: Entry[]
  /** The run an agent belongs to; null for everything that is not a workflow agent. */
  workflowId: string | null
  /** The measured counters behind `usage`, where there are any. */
  counters: Counters | null
  /** Built on demand: only the selected node's rows are ever needed. */
  rows: () => DetailRow[]
}

/** One session and everything that belongs to it, before it is a tree. */
interface RootAcc {
  sessionId: string
  main: MainRec | null
  agents: AgentRec[]
  pendings: AgentLaunch[]
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

function sizeOf(e: Entry): number {
  return e.children.reduce((n, c) => n + sizeOf(c), 1)
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
      a = { sessionId, main: null, agents: [], pendings: [] }
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
    if (!recent && a.agents.length === 0 && a.pendings.length === 0) continue
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
  const root: Entry = {
    key: fitKey('s:', a.sessionId),
    kind: 'session',
    label: sessionLabel(a.sessionId),
    // Attribution off: no project names anywhere, and the tree does not make an exception.
    sub: env.attribution !== 'none' ? env.project : null,
    ...sessionState(main, now, tcfg),
    usage: mainCounters ? usageText(mainCounters) : '–',
    lowerBound: mainCounters ? mainCounters.outputFinal < mainCounters.requests : false,
    duration: main && start !== null ? durationText(main.lastTs - start) : '–',
    startTs: start,
    lastTs: main ? main.lastTs : null,
    parent: null,
    children: [],
    workflowId: null,
    counters: mainCounters,
    rows: () => [],
  }
  root.rows = () => [
    ...(env.attribution !== 'none' ? [{ label: t('Project'), value: root.sub ?? '–' }] : []),
    { label: t('Models'), value: modelsOf(main?.models).join(', ') || '–' },
    ...timeRows(root.startTs, root.lastTs, now, tcfg),
    ...countRows(mainCounters),
    { label: t('Agents'), value: full([...preorder(root)].filter(isAgentLike).length) },
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
        lowerBound: false,
        duration: '–',
        startTs: null,
        lastTs: null,
        parent: null,
        children: [],
        workflowId: wf,
        counters: null,
        rows: () => [],
      }
      attach(w, root)
      workflows.set(wf, w)
    }
    return w
  }

  const ordered = [...a.agents].sort((x, y) => firstOf(x) - firstOf(y) || cmp(x.agentId, y.agentId))
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
    const e: Entry = {
      key: fitKey('a:', r.agentId),
      kind: 'agent',
      label: `${type ?? t('Agent')} · ${lastModel || alias || '–'} · ${r.agentId.slice(0, 4)}`,
      sub: null,
      ...agentState(r, launch, now, tcfg),
      usage: usageText(c),
      lowerBound: c.outputFinal < c.requests,
      duration: durationText(r.lastTs - first),
      startTs: first,
      lastTs: r.lastTs,
      parent: null,
      children: [],
      workflowId: wf,
      counters: c,
      rows: () => [],
    }
    e.rows = () => [
      { label: t('Type'), value: type ?? '–' },
      { label: t('Models'), value: models.join(', ') || alias || '–' },
      { label: t('Depth'), value: depthText(r.meta?.spawnDepth) },
      ...timeRows(e.startTs, e.lastTs, now, tcfg),
      ...countRows(c),
      { label: t('Spawned by'), value: spawnedBy(spawnerFileOf.get(e) ?? null) },
      { label: t('Workflow run'), value: wf !== null ? workflowLabel(wf) : '–' },
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
      lowerBound: false,
      duration: '–',
      startTs: l.ts,
      lastTs: Math.max(l.ts, outcomeAt ?? 0),
      parent: null,
      children: [],
      workflowId: null,
      counters: null,
      rows: () => [
        { label: t('Type'), value: text(l.typeHint) ?? '–' },
        { label: t('Models'), value: text(l.modelHint) ?? '–' },
        { label: t('Started'), value: stamp(l.ts, now, tcfg) },
        { label: t('Spawned by'), value: spawnedBy(l.file) },
        ...reportRows(l),
      ],
    }
    const id = agentIdOf(l.file)
    const host = id !== null ? byAgent.get(id) ?? null : null
    attach(e, host !== null && depthOf(host) < MAX_TREE_DEPTH ? host : root)
  }

  // A run is summed from the agents inside it, on the whole tree: the cap below may hide some
  // of them, but it does not change what the run used.
  for (const w of workflows.values()) {
    const members = [...preorder(w)].filter(isAgentLike)
    const sum = noCounters()
    let first: number | null = null
    let last: number | null = null
    for (const m of members) {
      if (m.counters) addInto(sum, m.counters)
      if (m.startTs !== null && (first === null || m.startTs < first)) first = m.startTs
      if (m.lastTs !== null && (last === null || m.lastTs > last)) last = m.lastTs
    }
    const st = workflowState(members.map((m) => m.state))
    w.state = st.state
    w.stateText = st.stateText
    w.counters = sum
    w.usage = usageText(sum)
    w.lowerBound = sum.outputFinal < sum.requests
    w.startTs = first
    w.lastTs = last
    w.duration = first !== null && last !== null ? durationText(last - first) : '–'
    w.rows = () => [
      { label: t('Agents'), value: full(members.length) },
      ...timeRows(w.startTs, w.lastTs, now, tcfg),
      ...countRows(sum),
    ]
  }

  for (const e of preorder(root)) e.children.sort(byStart)
  return root
}

// ---------------------------------------------------------------------------
// The cap, and the view-model shape
// ---------------------------------------------------------------------------

/**
 * The nodes that stay when the tree is larger than MAX_NODES. Every root stays; then the open
 * node and the running agents with the nodes above them — what someone watching the tree
 * came to see; then the rest level by level, so every session keeps its top levels before any
 * of them keeps its deepest one.
 */
function keep(roots: Entry[], selected: Entry | null): Set<Entry> {
  const kept = new Set<Entry>(roots)
  let budget = MAX_NODES - kept.size
  const withAncestors = (e: Entry): void => {
    const chain: Entry[] = []
    let c: Entry | null = e
    while (c !== null && !kept.has(c)) {
      chain.push(c)
      c = c.parent
    }
    // A node whose session is not listed has no chain that ends in a kept node.
    if (c === null || chain.length > budget) return
    for (const x of chain) kept.add(x)
    budget -= chain.length
  }
  if (selected) withAncestors(selected)
  for (const r of roots) {
    for (const e of preorder(r)) {
      if (budget <= 0) break
      if (isAgentLike(e) && e.state === 'running') withAncestors(e)
    }
  }
  let level = roots.flatMap((r) => r.children)
  while (budget > 0 && level.length > 0) {
    const next: Entry[] = []
    for (const e of level) {
      if (!kept.has(e)) {
        if (budget <= 0) break
        kept.add(e)
        budget--
      }
      next.push(...e.children)
    }
    level = next
  }
  return kept
}

function detailsOf(e: Entry): NodeDetails {
  return { key: e.key, title: e.label, state: e.state, stateText: e.stateText, rows: e.rows() }
}

/**
 * The tree for the view model: at most MAX_ROOTS sessions, most recent first, cut at
 * MAX_NODES nodes, with the details of `input.selected` when that node is on it.
 */
export function buildAgentTree(input: AgentTreeInput, now: number): AgentTreeVm {
  const forest = buildForest(input, now)
  const shown = forest.roots.slice(0, MAX_ROOTS)
  const selectedKey = text(input.selected)
  const selected = selectedKey !== null ? forest.byKey.get(selectedKey) ?? null : null
  const kept = keep(shown, selected)
  const total = shown.reduce((n, r) => n + sizeOf(r), 0)
  // Every root, listed or not: the host polls while anything runs, wherever it sits.
  let running = 0
  for (const r of forest.roots) for (const e of preorder(r)) if (isAgentLike(e) && e.state === 'running') running++

  const toNode = (e: Entry): TreeNode => ({
    key: e.key,
    kind: e.kind,
    label: e.label,
    sub: e.sub,
    state: e.state,
    derived: derivedOf(e.state),
    usage: e.usage,
    lowerBound: e.lowerBound,
    duration: e.duration,
    startTs: e.startTs,
    lastTs: e.lastTs,
    children: e.children.filter((c) => kept.has(c)).map(toNode),
  })

  const details = selected !== null && kept.has(selected) ? detailsOf(selected) : null
  let note: string | null = null
  if (forest.roots.length === 0) {
    // A session that is older than a day and never ran an agent is not in the tree; saying
    // there was no session at all would then be untrue.
    note = forest.anyMain
      ? t('No agent in the last {0} days, and no Claude Code session in the last {1} hours.',
        AGENT_RETENTION_DAYS, ROOT_WINDOW_MS / HOUR_MS)
      : t('No Claude Code session in the last 7 days.')
  } else if (selectedKey !== null && details === null) {
    note = t('The selected node is no longer in the tree.')
  }
  return {
    roots: shown.map(toNode),
    selected: details,
    running,
    omittedRoots: Math.max(0, forest.roots.length - MAX_ROOTS),
    truncated: kept.size < total,
    note,
    updatedAt: now,
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
