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
  children: TreeNode[]
}

export interface DetailRow { label: string; value: string; note?: string }

export interface NodeDetails { key: string; title: string; state: NodeState; stateText: string; rows: DetailRow[] }

export interface AgentTreeVm {
  roots: TreeNode[]
  selected: NodeDetails | null
  /** Agents in state running (all roots). */
  running: number
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
    omittedRoots: 0,
    truncated: false,
    note: null,
    updatedAt: now,
  }
}
