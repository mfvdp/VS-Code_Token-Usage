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
export const MAX_TREE_DEPTH = 6
/**
 * D3 (1.6): the children an opened node shows at first, and how many more each "more" step shows —
 * the page carries only what is open, and of an open node at most this many children at a time.
 */
export const MAX_GROUP_CHILDREN = 50
/** D3: the nodes whose "more" steps are remembered (`ui.agentsMore`); one more forgets the oldest. */
export const MAX_AGENT_MORE = 200
/** D3: the "more" steps one node takes at most — 50 + 10 × 50 of its children. */
export const MAX_MORE_PAGES = 10
/**
 * D3: the most nodes one push of the page carries. A safety cap, not a view: filled with the path
 * to the selected node and the running children first, then in the order the page draws them; an
 * opened node whose children no longer fit ships none and says how many it holds.
 */
export const MAX_PAGE_NODES = 2000
/** Running agents listed above the tree; the rest are counted in `runningMore`. */
export const MAX_RUNNING_LIST = 20
/**
 * How much later than a recorded outcome an agent's transcript may still change before the
 * outcome no longer decides its state (D6): a line written more than this after the parent
 * recorded the end means the agent went on, and its state is inferred from its lines again.
 */
export const RESUMED_AFTER_MS = 60_000
/**
 * N5 (1.6): how long a running agent's transcript may stay unchanged before its row says so —
 * "silent for 4 min", ticking in the page. Below it a pause between two replies is ordinary: a
 * running agent writes a line every 0.6 s at the median, and a tool call of a minute or two is
 * common. The state stays running either way until RUNNING_WINDOW_MS; this only says how long it
 * has been quiet.
 */
export const SILENT_AFTER_MS = 3 * 60_000
/**
 * N6 (1.6): how far back a session's or a run's start is named by its weekday — "Tue 00:19" —
 * rather than its date, "2026-09-01 00:19". Six days, so no two starts a weekday name could
 * stand for lie in the window: the same weekday a week ago is outside it.
 */
export const WEEKDAY_NAMES_WITHIN_MS = 6 * 86_400_000
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
 * L2 (1.6): from how long an agent ran on, its details say what it used per minute. Below a
 * minute a rate is a division by a fraction of a minute — a burst of one reply, not a pace.
 */
export const PER_MINUTE_FROM_MS = 60_000
/**
 * L3 (1.6): the most (type, model) rows the 7-day block "where the agent tokens went" lists, by
 * usage; the rest are counted in one line ("3 other combinations"), and the block's total still
 * holds them.
 */
export const WEEK_ROWS = 10
/** L3: the largest agents of the 7 days the block names below its table — rows that select like the tree's. */
export const TOP_AGENTS = 5
/**
 * O4 (1.6): how long a line of the agent hook's mirror file counts. A wait the hook reported is
 * shown only while it is younger than this, and only while nothing newer happened on the node —
 * a later line of its transcript, a later hook call for it (a stop clears it) — so a wait whose
 * answer the hook never saw does not stand for good.
 */
export const HOOK_MAX_AGE_MS = 30 * 60_000

/**
 * O4 (§0a.13): the hook events the setup document installs, and the mirror file's `event` field —
 * exactly these four. `PostToolUse` is not among them (every tool call would start the script).
 */
export type HookEvent = 'SubagentStart' | 'SubagentStop' | 'Notification' | 'PermissionRequest'
/** O4: what a hook call says an agent or a session waits for — `none` clears a wait. */
export type HookWait = 'none' | 'permission' | 'input'

/**
 * O4 (§0a.13): one line of the agent hook's mirror file, as the reader keeps it — the six fields
 * the script writes, the literal `v` aside, each checked again on the way in. Never stored in the
 * snapshot: the file is read again whenever it changes.
 */
export interface HookEntry {
  /** When the hook ran, ms since the epoch — the script's clock, the same machine's. */
  ts: number
  event: HookEvent
  /** The Claude Code session the call came from. */
  sessionId: string
  /** The agent it came from; null for a call of the session itself — or one Claude Code sent without it. */
  agentId: string | null
  wait: HookWait
}

/**
 * The key of a hook entry: its session and its agent — the latest call per pair counts. `|` is in
 * neither id's alphabet, so no two pairs share a key.
 */
export function hookKey(sessionId: string, agentId: string | null): string {
  return `${sessionId}|${agentId ?? ''}`
}

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
  /**
   * Agent-like members below the node: agent records, pending launches, and the members of a
   * run's collector (D4) — the agents its journal started without a record, and the ones whose
   * record counted no reply. On a collector, its own members.
   */
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
  /**
   * Stable, never a path: `s:<sessionId>` | `w:<sessionId>|<wfId>` | `a:<agentId>` | `l:<toolUseId>`
   * | `n:<sessionId>|<wfId>` (a run's collector, D4).
   */
  key: string
  /**
   * `pending` = launched, file not seen yet. `noreply` (1.6 D4) = a run's collector: one node for
   * every agent of the run without a counted reply — started by the run's journal with no
   * transcript read, or with a transcript of nothing but rejected requests — always the run's
   * last child, counted, not listed: no children, dashes for its figures, its members in its
   * label, its tally and its state.
   */
  kind: 'session' | 'workflow' | 'agent' | 'pending' | 'noreply'
  /**
   * N6 (1.6): the name the row writes on its first line — "Explore · opus-5 · 94f3", "Session Tue
   * 14:20 · 9d0eb37a", "Workflow run Tue 00:19 · 0133faf9". An agent's last part is its short id:
   * the fewest characters of its id, from MIN_SHORT_ID on, that no other agent of the same session
   * shares — without the leading `a` of Claude Code's `a` + 16 hex; its model is the short form,
   * without the leading `claude-` (the details' Models row keeps the whole id). A session's and a
   * run's last part is the first eight characters of its id, after its start as a weekday and a
   * clock time (WEEKDAY_NAMES_WITHIN_MS), or a date and a clock time; without a known start, the
   * name is the id alone — "Session 9d0eb37a". The page dims the last part of an agent's, a
   * session's and a run's name.
   */
  label: string
  /**
   * N6: the same name with the whole model id — "Explore · claude-opus-5 · 94f3" — for the
   * details' title, the markdown and a screen reader's name of the row; equal to `label` for a
   * session, a run and a collector, whose names carry no model.
   */
  fullLabel: string
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
   * D10 (1.6): why the output is a lower bound, in numbers — "⚠ lower bound — 2 of 41 replies
   * unfinished": the replies whose lines never carried a stop reason, of all the replies counted.
   * On agents and on the sums of runs and sessions (a session's of its own transcript); null when
   * the output is not a lower bound, and on a launch and a collector, which count nothing.
   */
  lowerBoundText: string | null
  /**
   * Formatted, '–' when unknown. A session's is its span from the first line to the last, in
   * days and hours from SPAN_IN_DAYS_FROM_MS on.
   */
  duration: string
  /** Null for a run's collector (1.6 D4, lead note): its members' earliest line is no start of its own. */
  startTs: number | null
  lastTs: number | null
  /**
   * N9 (1.6): `startTs` and `lastTs` as clock times in the configured zone — "14:20" today,
   * "2026-09-01 14:20" on another day, the details' own form — for the static words a screen
   * reader gets in place of a ticking clock ("since 14:20", "silent since 14:21"). The page
   * formats no time itself. Null where the time is.
   */
  startClock: string | null
  lastClock: string | null
  /**
   * N5 (1.6): an agent in state running by its own transcript — not one that only waits on an
   * agent below it, not a launch — whose silence the page may state: from `lastTs` on, once
   * SILENT_AFTER_MS have passed, its row says "silent for 4 min", in the page's own clock. False
   * for every other node.
   */
  silence: boolean
  /**
   * O4 (1.6): the agent hook's marker — "waiting for approval", "waiting for input" — on an agent
   * whose own state is inferred, or on a session, while the hook's latest call for it reported a
   * wait that is younger than HOOK_MAX_AGE_MS and newer than the node's last activity (a session's
   * wait for input only while it is active). A marker, never a state: the node's state stays the
   * one its lines give it. Null for every other node, and while the hook is not installed.
   */
  hookWait: string | null
  /**
   * Agents and pending launches anywhere below this node, counted on the whole tree — open or
   * closed, shown or not — the `started` of its tally, where it has one. 0 for a node with none
   * below it. A run's collector (1.6 D4) counts its members, and so does every node above it: the
   * agents the run's journal started whose transcript was never counted (D2), and the ones whose
   * record counted no reply, are members of the run, though no row of their own is drawn for them.
   */
  agentCount: number
  /**
   * D3: the node has children in the tree, whether this payload carries them or not — the page
   * carries a node's children only while it is open. What decides the toggle.
   */
  hasChildren: boolean
  /** D3: the children the node has in the tree, shown or not. */
  childrenTotal: number
  /**
   * D3: the children this payload does not carry although the node is open — the ones past its
   * window of MAX_GROUP_CHILDREN (and its "more" steps), or all of them when MAX_PAGE_NODES left
   * no room. 0 for a closed node, and for an open one that shows them all.
   */
  childrenMore: number
  /**
   * N1: what the agents below the node came to — on sessions, workflow runs, collectors (D4, their
   * own members) and agents with agents below them, counted on the whole tree, as `agentCount` is
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
  /**
   * The children this payload carries: none while the node is closed (D3), at most its window
   * while it is open — in the order the page draws them: by start, the newest first (N6, lead
   * note "Zeitfolge"), a run's collector last.
   */
  children: TreeNode[]
}

/**
 * One entry of the "Running now" list above the tree: an agent or a pending launch in state
 * running, wherever it sits — a closed branch, a session beyond MAX_ROOTS, a node past its
 * group's window — or a run's collector (1.6 D4) while one of its members runs: one entry for
 * all of them, never a row per member.
 */
export interface RunningItem {
  /** The node key — selecting it opens the same details as the tree row. */
  key: string
  kind: 'agent' | 'pending' | 'noreply'
  /** The node's name, as its tree row writes it (N6: the short model). */
  label: string
  /** The node's `fullLabel`: the whole model id, for the markdown and a screen reader. */
  fullLabel: string
  /**
   * "Session 9d0eb37a · Workflow run 8a71f8cc", plus " · <project>" when attribution allows a
   * label: the id-only names of the session and the run, not the names by start time the tree's
   * rows carry (N6) — a line of where the agent sits, not a second name for it.
   */
  context: string
  /** As the node: '–' when nothing was counted; a pending launch is always '–'. */
  usage: string
  /** As the node: the output is a lower bound (outputFinal < requests). Never for a pending launch or a collector. */
  lowerBound: boolean
  /** D10, as the node: "⚠ lower bound — 2 of 41 replies unfinished", or null. */
  lowerBoundText: string | null
  /**
   * As the node. Null for a collector (1.6 D4, lead note): the earliest first line among its
   * members may be a rejected request of an agent that failed long ago, and a clock from it
   * would claim a precision nobody has — its entry says how many of them run instead.
   */
  startTs: number | null
  lastTs: number | null
  /** N9, as the node: the clock times of `startTs` and `lastTs` for the static screen-reader words. */
  startClock: string | null
  lastClock: string | null
  /** Running only because an agent below it runs (the roll-up), not by its own transcript. */
  waiting: boolean
  /** N5, as the node: the page may say how long the agent has been silent, from `lastTs` on. */
  silence: boolean
  /** O4, as the node: the agent hook's marker ("waiting for approval"), or null. */
  hookWait: string | null
  /**
   * The running agents the entry stands for: 1 for an agent or a launch, a collector's members that
   * run (D4). What `AgentTreeVm.running` sums over every entry, listed or not.
   */
  running: number
}

/**
 * One part of an agent's token mix (1.6 L2): which kind of token, its share of the four together,
 * and its words — "cache read 76 %", the part's title on the page.
 */
export interface MixPart {
  part: 'fresh' | 'cacheWrite' | 'cacheRead' | 'output'
  /** Of fresh input, cache write, cache read and output together; the parts' shares sum to 1. */
  share: number
  label: string
}

/**
 * One row of the details panel, pre-formatted. How the page lays it out is the row's own say,
 * never a guess from its words: a figure beside its label (the default), a sentence that takes
 * the whole width under it, or a bar across that width with its words under it. `live` marks the
 * row the page's clock ticks in, `copy` the row whose value *Copy ID* copies.
 */
export interface DetailRow {
  label: string
  value: string
  note?: string
  /**
   * Absent means a figure. A sentence's note follows it after " · ", a figure's after a space. A
   * bar (1.6 L2) draws `parts` in their order and prints `value` — the same in words — under it.
   */
  kind?: 'figure' | 'sentence' | 'bar'
  /** L2: a bar's parts — the token mix, the shares summing to 1, drawn in this order. Only on a bar. */
  parts?: MixPart[]
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
   * L2 (1.6): the one line under the state — for an agent with a counted request "1.2K in 29 min
   * 00 s · 5 requests · 3 tool calls": what it used, how long it ran, how many requests and tool
   * calls it made. Null for an agent nothing of which was counted, and for every other node. (The
   * spec's `summary`: a name the tree's payload never carries, since a task notification's and a
   * workflow result's content lives under it.)
   */
  overview: string | null
  /**
   * What *Copy ID* copies: the agent id, a launch's tool_use id, a run's id, a session's id —
   * the whole identifier the ID row shows. Null when the node has none.
   */
  id: string | null
  rows: DetailRow[]
}

/**
 * L3 (1.6): one row of the 7-day block — the agents of one type and one model, as their names say
 * them: the agent records of the last AGENT_RETENTION_DAYS days with at least one counted request.
 */
export interface AgentWeekRow {
  /** The agent type the rows name ("Explore", "workflow-subagent"; "Agent" for a record that names none). */
  type: string
  /** The model id as the details and the markdown write it — the whole id, "claude-opus-5"; '–' for none known. */
  model: string
  /** The two as a row of the page writes them, the model in its short form: "Explore · opus-5". */
  label: string
  /** How many agents: records, each once. */
  agents: number
  /** Their usage together, compact. */
  usage: string
  /** Of the block's total usage — every agent of the 7 days, the rows not listed included: "34 %", "<1 %". */
  share: string
  /** The median usage of one of its agents, compact. */
  median: string
  /**
   * What their tokens would have cost through the API, `~` in front (`costText`) — only with
   * `tokenPace.showCost`, null otherwise. '–' when none of them has a price: its model has none on
   * file, or each agent wrote with more than one model, whose tokens a record cannot split between
   * them; ` ⚠` behind a sum that holds only some of them — a lower bound.
   */
  cost: string | null
}

/** L3 (1.6): one of the largest agents of the 7 days: a row that selects its node, as a tree row does. */
export interface AgentWeekTop {
  /** The node's key — selecting it opens the node's details, under this row (`from: 'week'`). */
  key: string
  /** The node's name as its tree row writes it (the short model). */
  label: string
  /** The node's `fullLabel`: the whole model id, for the markdown and a screen reader. */
  fullLabel: string
  /** Where it sits, as a running item says it: "Session 9d0eb37a · Workflow run cfe7718d" (+ the project). */
  context: string
  /** As the node's state and whether it was inferred — the row's glyph. */
  state: NodeState
  derived: boolean
  usage: string
  /** Of the block's total usage. */
  share: string
  /** As a row's cost: only with `tokenPace.showCost`; '–' for an agent without a price. */
  cost: string | null
}

/**
 * L3 (1.6): where the agent tokens of the last 7 days went — by type and model, and the largest
 * agents. Whole agent records, each at its whole usage: an agent that started eight days ago and
 * wrote on into the seven is counted whole, as its tree row counts it (the hour buckets split the
 * same tokens by the hour of each reply instead).
 */
export interface AgentWeek {
  /** At most WEEK_ROWS, the largest usage first. */
  rows: AgentWeekRow[]
  /** "3 other combinations" — the rows past WEEK_ROWS —, or null when every row is listed. */
  other: string | null
  /** At most TOP_AGENTS, the largest usage first. */
  top: AgentWeekTop[]
  /** Every agent's usage together, compact; '–' when there is none. */
  total: string
  /** Their cost together, as a row's is; null without `tokenPace.showCost`. */
  totalCost: string | null
  /** How many agents the block holds. */
  agents: number
}

export interface AgentTreeVm {
  roots: TreeNode[]
  selected: NodeDetails | null
  /**
   * The running members of all roots (1.6 §2.3): agents and pending launches in state running and
   * the running members of every run's collector (D4) — an attempt a later one superseded not
   * among them — as the sessions' tallies count them; the sum of the running list's `running`,
   * listed or not. What the host's poll and the list's heading read.
   */
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
  /**
   * E.g. "No Claude Code session in the last 7 days." The tree carries no time of its own: an
   * unchanged tree serialises the same, so the host does not send it again (D12).
   */
  note: string | null
  /**
   * L3 (1.6): the 7-day block "where the agent tokens went" — built only while the reader has it
   * open (`ui.agentsWeekOpen`), null otherwise. Its largest agents are rows on the page as the
   * running list's are: their details open, wherever their tree rows are, and the rows of the
   * block count against MAX_PAGE_NODES.
   */
  week: AgentWeek | null
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
    note: null,
    week: null,
  }
}
