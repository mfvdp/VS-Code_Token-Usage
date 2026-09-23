// SPDX-FileCopyrightText: 2026 Frederik Marx
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The shape of the Agents section: session roots → workflow runs → agents → nested agents.
 *
 * Types, the limits the tree builder works to, and the empty tree — nothing that reads a file
 * and nothing that imports vscode, so the view model, the text views and the tests can all
 * use it. Every state a node carries is derived at view time from what the transcripts and
 * the parent's records say; `derived` tells an inferred state from a recorded one.
 */

/** How long an agent's records are kept after its last line. */
export const AGENT_RETENTION_DAYS = 7
/** Silence beyond this without an outcome → unknown. */
export const RUNNING_WINDOW_MS = 10 * 60_000
export const SESSION_ACTIVE_MS = 10 * 60_000
/** Sessions without agents appear only if active within this. */
export const ROOT_WINDOW_MS = 24 * 3_600_000
export const MAX_ROOTS = 20
export const MAX_NODES = 300
export const MAX_TREE_DEPTH = 6
/** Running agents listed above the tree; the rest are counted in `runningMore`. */
export const MAX_RUNNING_LIST = 20
/**
 * How much later than a recorded outcome an agent's transcript may still change before the
 * outcome no longer decides its state (D6): a line written more than this after the parent
 * recorded the end means the agent went on, and its state is inferred from its lines again.
 */
export const RESUMED_AFTER_MS = 60_000
/** From this span on a session's span is written in days and hours ("22 d 11 h"), below it as a duration. */
export const SPAN_IN_DAYS_FROM_MS = 48 * 3_600_000
/** The fewest hex characters of an agent id a name shows; more where two agents of a session share them (D11). */
export const MIN_SHORT_ID = 4
/**
 * Journal agents kept per workflow run (D2): a `started` line beyond this is counted in
 * `RunRec.agentsDropped`, not listed. The largest run on the measuring machine had 427.
 */
export const MAX_RUN_AGENTS = 5000

/**
 * `stopped` (1.6 D7): the parent recorded a stop — `killed`, `cancelled` or `stopped` — which is
 * an end, but not a failure.
 */
export type NodeState = 'running' | 'done' | 'failed' | 'stopped' | 'unknown' | 'active' | 'idle'

/**
 * N1 (1.6): the agents below a node by the state their rows show. `started` is the only
 * denominator; every attempt counts once and in exactly one field, so the six after `started`
 * sum to it. A superseded attempt goes to `retried` whatever its own state; every other field
 * counts only attempts that are not superseded.
 */
export interface AgentTally {
  /** Agent-like members below the node: agent records, the agents a run's journal started without one, pending launches. */
  started: number
  /** Completed, not superseded. */
  done: number
  /** Final failures: failed and not superseded by a later attempt. */
  failed: number
  /** Every superseded attempt — failed and retried, replaced, or run again. */
  retried: number
  /** Stopped and not superseded (a stop nothing replaced). */
  stopped: number
  /** Running (derived), not superseded — an agent that runs because an agent below it runs included. */
  running: number
  /** Unknown (derived), not superseded. */
  unknown: number
}

export interface TreeNode {
  /** Stable, never a path: `s:<sessionId>` | `w:<sessionId>|<wfId>` | `a:<agentId>` | `l:<toolUseId>`. */
  key: string
  /** `pending` = launched, file not seen yet. */
  kind: 'session' | 'workflow' | 'agent' | 'pending'
  /**
   * "Explore · claude-opus-5 · 94f3" / "Session 9d0eb37a" / "Workflow cfe7718d". An agent's id
   * part is its short id: the fewest characters of its id, from MIN_SHORT_ID on, that no other
   * agent of the same session shares — without the leading `a` of Claude Code's `a` + 16 hex.
   */
  label: string
  /** Secondary text, e.g. the project label when attribution allows one. */
  sub: string | null
  state: NodeState
  /** True for running/unknown/active/idle (inferred), false for done/failed/stopped (recorded). */
  derived: boolean
  /**
   * Formatted billable tokens, '–' when nothing counted. A session's is its own transcript's
   * alone, since its first line; its agents' are `usageAgents`.
   */
  usage: string
  /**
   * Sessions only: the billable tokens of the session's agent records of the last
   * AGENT_RETENTION_DAYS days; null for a session without one and for every other kind of node.
   * Never added to `usage`: the two cover different spans.
   */
  usageAgents: string | null
  /** outputFinal < requests. */
  lowerBound: boolean
  /**
   * Formatted, '–' when unknown. A session's is its span from the first line to the last, in
   * days and hours from SPAN_IN_DAYS_FROM_MS on.
   */
  duration: string
  startTs: number | null
  lastTs: number | null
  /**
   * Agents and pending launches anywhere below this node, counted on the whole tree before the
   * MAX_NODES cut — the `started` of its tally, where it has one. 0 for a node with none below it. A
   * workflow run's count includes the agents its journal started whose transcript was never
   * counted (1.6 D2): they are members of the run, though no row of their own is drawn for them.
   */
  agentCount: number
  /**
   * N1: what the agents below the node came to — on sessions, workflow runs and agents with
   * agents below them, counted on the whole tree before the MAX_NODES cut, as `agentCount` is
   * (its `started` equals it). Null for every other node, and for a session with no agent.
   */
  tally: AgentTally | null
  /**
   * N1: the tally as the row writes it — "427 started · 112 ✓ · 12 ✕ · 295 ↻ · ~8 ?": the
   * started agents, then each state with at least one agent, in the order done, failed,
   * retried, stopped, running, unknown; the two inferred ones carry `~`. Null with `tally`.
   */
  tallyText: string | null
  /**
   * N1: the same in words, for a screen reader — "427 started, 112 done, 12 failed, 295
   * retried, about 8 unknown". Null with `tally`.
   */
  tallySpoken: string | null
  /**
   * D7: an attempt the workflow journal started its step again after — a failure retried, a
   * run replaced before it recorded anything, or a completed step re-run. It keeps its own state
   * and glyph; the page dims the row. False for every other node.
   */
  superseded: boolean
  children: TreeNode[]
}

/**
 * One entry of the "Running now" list above the tree: an agent or a pending launch in state
 * running, wherever it sits — a collapsed branch, a session beyond MAX_ROOTS, a node beyond
 * the MAX_NODES cut.
 */
export interface RunningItem {
  /** The node key — selecting it opens the same details as the tree row. */
  key: string
  kind: 'agent' | 'pending'
  /** The node label. */
  label: string
  /** "Session 9d0eb37a · Workflow 8a71f8cc", plus " · <project>" when attribution allows a label. */
  context: string
  /** As the node: '–' when nothing was counted; a pending launch is always '–'. */
  usage: string
  /** As the node: the output is a lower bound (outputFinal < requests). Never for a pending launch. */
  lowerBound: boolean
  startTs: number | null
  lastTs: number | null
  /** Running only because an agent below it runs (the roll-up), not by its own transcript. */
  waiting: boolean
}

/**
 * One row of the details panel, pre-formatted. How the page lays it out is the row's own say,
 * never a guess from its words: a figure beside its label (the default), or a sentence that
 * takes the whole width under it. `live` marks the row the page's clock ticks in, `copy` the
 * row whose value *Copy ID* copies.
 */
export interface DetailRow {
  label: string
  value: string
  note?: string
  /** Absent means a figure. A sentence's note follows it after " · ", a figure's after a space. */
  kind?: 'figure' | 'sentence'
  /** The row the live "… ago" clock attaches to, in place of its note. */
  live?: 'ago'
  /** The row whose value the Copy ID button copies (D11). */
  copy?: boolean
}

/**
 * The details of one node. `derived` and `lastTs` are the node's own, so the panel says whether
 * its state was recorded and keeps its clock without looking the node up on the page.
 */
export interface NodeDetails {
  key: string
  title: string
  state: NodeState
  /** As the node: true for an inferred state, false for a recorded one. */
  derived: boolean
  stateText: string
  /** As the node: its last activity, null when there is none. */
  lastTs: number | null
  /**
   * What *Copy ID* copies: the agent id, a launch's tool_use id, a run's id, a session's id —
   * the whole identifier the ID row shows. Null when the node has none.
   */
  id: string | null
  rows: DetailRow[]
}

export interface AgentTreeVm {
  roots: TreeNode[]
  selected: NodeDetails | null
  /** Agents in state running (all roots). */
  running: number
  /**
   * The running agents and launches of all roots, longest-running first, at most
   * MAX_RUNNING_LIST of them.
   */
  runningNow: RunningItem[]
  /** Running agents and launches beyond MAX_RUNNING_LIST, not listed. */
  runningMore: number
  /** Roots beyond MAX_ROOTS. */
  omittedRoots: number
  /** MAX_NODES hit. */
  truncated: boolean
  /**
   * E.g. "No Claude Code session in the last 7 days." The tree carries no time of its own: an
   * unchanged tree serialises the same, so the host does not send it again (D12).
   */
  note: string | null
}

/** The tree before anything was built: no roots, nothing selected, nothing claimed. */
export function emptyAgentTree(): AgentTreeVm {
  return {
    roots: [],
    selected: null,
    running: 0,
    runningNow: [],
    runningMore: 0,
    omittedRoots: 0,
    truncated: false,
    note: null,
  }
}
