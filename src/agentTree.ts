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

export type NodeState = 'running' | 'done' | 'failed' | 'unknown' | 'active' | 'idle'

export interface TreeNode {
  /** Stable, never a path: `s:<sessionId>` | `w:<sessionId>|<wfId>` | `a:<agentId>` | `l:<toolUseId>`. */
  key: string
  /** `pending` = launched, file not seen yet. */
  kind: 'session' | 'workflow' | 'agent' | 'pending'
  /** "Explore · Opus 5 · a94f" / "Session 9d0eb37a" / "Workflow cfe7718d". */
  label: string
  /** Secondary text, e.g. the project label when attribution allows one. */
  sub: string | null
  state: NodeState
  /** True for running/unknown/active/idle (inferred), false for done/failed (recorded). */
  derived: boolean
  /** Formatted billable tokens, '–' when nothing counted. */
  usage: string
  /** outputFinal < requests. */
  lowerBound: boolean
  /** Formatted, '–' when unknown. */
  duration: string
  startTs: number | null
  lastTs: number | null
  /**
   * Agents and pending launches anywhere below this node, counted on the whole tree before the
   * MAX_NODES cut — what a collapsed row says it holds. 0 for a node with none below it.
   */
  agentCount: number
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

export interface DetailRow { label: string; value: string; note?: string }

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
  /** E.g. "No Claude Code session in the last 7 days." */
  note: string | null
  updatedAt: number
}

/** The tree before anything was built: no roots, nothing selected, nothing claimed. */
export function emptyAgentTree(now: number): AgentTreeVm {
  return {
    roots: [],
    selected: null,
    running: 0,
    runningNow: [],
    runningMore: 0,
    omittedRoots: 0,
    truncated: false,
    note: null,
    updatedAt: now,
  }
}
