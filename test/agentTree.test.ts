// SPDX-FileCopyrightText: 2026 Frederik Marx
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The agent tree: session roots → workflow runs → agents → nested agents.
 *
 * Built from records shaped exactly like the aggregator's (§3.1 of the build spec), so the
 * rules are pinned before the aggregator fills them from real transcripts. The rules that
 * matter most are the ones that keep a state honest: done and failed only when something
 * recorded it, running only while the transcript is fresh, unknown otherwise — never an
 * invented "done" for a file that merely went quiet, and never a zero for a launch nobody
 * has counted anything of.
 */

import { strict as assert } from 'node:assert'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import * as path from 'node:path'
import { test } from 'node:test'
import {
  AgentTreeVm, DetailRow, EARLIER_KEY, MAX_GROUP_CHILDREN, MAX_MORE_PAGES, MAX_PAGE_NODES, MAX_ROOTS, MAX_RUNNING_LIST, MAX_TREE_DEPTH, MIN_SHORT_ID, NodeState,
  PER_MINUTE_FROM_MS,
  RESUMED_AFTER_MS, SPAN_IN_DAYS_FROM_MS, TOP_AGENTS, TreeNode, WEEK_ROWS, WEEKDAY_NAMES_WITHIN_MS,
} from '../src/agentTree'
import {
  AgentTreeInput, agentDetails, agentRecordViews, buildAgentTree, byNewestFirst, medianOf, mostAtOnce, shortIdsOf, spanText,
} from '../src/agentTreeBuild'
import { setBundle, setLocale } from '../src/i18n'
import { compact } from '../src/render'
import { TimeConfig, clockStamp } from '../src/time'
import { AgentLaunch, AgentRec, JournalAgent, MainRec, RunLaunch, RunRec, SessionRec } from '../src/types'
import { durationText } from '../src/stats'
import { MAX_AGENT_KEY_CHARS } from '../src/viewModel'
import { AGENT_TABLES_REVISION } from '../src/agg'
import { ROOT } from './helpers/nls'

/** 2026-09-22 12:00 UTC, a Tuesday. */
const NOW = Date.UTC(2026, 8, 22, 12, 0, 0)
const MIN = 60_000
const HOUR = 60 * MIN
const DAY = 24 * HOUR
const tcfg: TimeConfig = { zone: 'utc', dayBoundaryHour: 0, startOfWeek: 'monday', hourCycle: 'h23' }

const PROJ = path.join(path.sep, 'home', 't', '.claude', 'projects', '-home-t-alpha')
const S1 = '9d0eb37a-71d8-4832-9deb-36dcbfb5985b'
const S2 = '5f1c2d3e-0000-4000-8000-000000000002'
const WF = 'wf_cfe7718d-3c2a-4f00'

function sessionFile(session = S1): string {
  return path.join(PROJ, `${session}.jsonl`)
}

function agentFile(id: string, session = S1, wf: string | null = null): string {
  return path.join(PROJ, session, 'subagents', ...(wf ? ['workflows', wf] : []), `agent-${id}.jsonl`)
}

function main(over: Partial<MainRec> = {}): MainRec {
  return {
    source: 'claude', sessionId: S1, firstTs: NOW - 2 * HOUR, lastTs: NOW - 2 * MIN, models: ['claude-opus-5'],
    input: 1000, cacheWrite: 500, cacheWrite1h: 100, cacheRead: 90_000, output: 2000, reasoning: 300,
    requests: 12, outputFinal: 12, toolCalls: 9,
    ccVersion: null, permissionMode: null, compactions: 0, lastCompaction: null, lastRequest: null, lastUserAt: null,
    ...over,
  }
}

/** A subagent that was launched from the main transcript half an hour ago and wrote a minute ago. */
function rec(id: string, over: Partial<AgentRec> = {}): AgentRec {
  const session = over.sessionId ?? S1
  return {
    source: 'claude', agentId: id, sessionId: session, sessionFile: sessionFile(session), workflowId: null,
    meta: { agentType: 'Explore', model: 'opus', spawnDepth: 1, toolUseId: `toolu_${id}`, parentAgentId: null },
    metaTries: 1, spawnerFile: sessionFile(session),
    firstTs: NOW - 30 * MIN, lastTs: NOW - 1 * MIN, models: ['claude-opus-5'],
    input: 300, cacheWrite: 200, cacheWrite1h: 0, cacheRead: 5000, output: 700, reasoning: 50,
    requests: 5, outputFinal: 5, toolCalls: 3, outcome: null, outcomeTs: null, outcomeStatus: null, rejected: null,
    lastTool: null, lastToolTs: null, effort: null, efforts: [], lastContext: null,
    toolErrors: 0, cacheMisses: {}, cacheMissedTokens: 0, ccVersion: null, permissionMode: null, compactions: 0, lastCompaction: null,
    ...over,
  }
}

/** A workflow agent: its own sidecar type, no spawner the tree can see. */
function wfRec(id: string, over: Partial<AgentRec> = {}): AgentRec {
  return rec(id, {
    workflowId: WF, spawnerFile: null,
    meta: { agentType: 'workflow-subagent', model: null, spawnDepth: 1, toolUseId: null, parentAgentId: null },
    ...over,
  })
}

/** An agent as the run's journal records it: a step of its own, the first attempt, no end yet. */
function jagent(id: string, over: Partial<JournalAgent> = {}): JournalAgent {
  return { agentId: id, step: 0, attempt: 1, outcome: null, supersededBy: null, ...over }
}

/** The run WF of session S1 as its journal records it; the journal last changed half an hour ago. */
function run(agents: JournalAgent[], over: Partial<RunRec> = {}): RunRec {
  return {
    source: 'claude', sessionId: S1, workflowId: WF,
    journalFile: path.join(PROJ, S1, 'subagents', 'workflows', WF, 'journal.jsonl'),
    agents, agentsDropped: 0, steps: new Set(agents.map((a) => a.step).filter((n) => n > 0)).size, lastTs: NOW - 30 * MIN,
    record: null, recordStat: null,
    ...over,
  }
}

function launch(id: string, over: Partial<AgentLaunch> = {}): AgentLaunch {
  return {
    toolUseId: `toolu_${id}`, file: sessionFile(), ts: NOW - 31 * MIN, agentId: id,
    typeHint: 'Explore', modelHint: 'opus', background: false, outcome: null, outcomeTs: null, outcomeStatus: null,
    totals: null,
    ...over,
  }
}

/**
 * 1.14 P5 (pinned and changed: a session record holds its project's key, the tree names it by the label table —
 * §3 A4 rule 12): the key of the fixture's project, whose label table (`input`'s default) names it `alpha`.
 */
const ALPHA_KEY = 'a1a1a1a1a1a1'

function sessionRec(over: Partial<SessionRec> = {}): SessionRec {
  return {
    source: 'claude', sessionId: S1, project: ALPHA_KEY, isSub: false, parent: null,
    firstTs: NOW - 2 * HOUR, lastTs: NOW - 2 * MIN, models: ['claude-opus-5'],
    input: 0, cacheWrite: 0, cacheWrite1h: 0, cacheRead: 0, output: 0, reasoning: 0, requests: 0, outputFinal: 0,
    lastCacheTtl: null, lastCacheWriteTs: null, turnGapsMs: [],
    ...over,
  }
}

/**
 * The builder's input. The rules of states, names and places are pinned on the whole tree, so
 * the tests build the markdown's `text` mode — every node open, fifty children each (1.6 D3) —
 * unless a test is about the dashboard's payload, which carries only what the reader opened
 * and says `mode: 'page'` (see `page` below).
 */
function input(over: Partial<AgentTreeInput> = {}): AgentTreeInput {
  return {
    agents: [], launches: [], mains: [main()], sessions: [], attribution: 'none', selected: null, mode: 'text', tcfg,
    // 1.14 P5: the label table and the label mode (names on) — the fixture's project reads `alpha`.
    projectLabels: { [ALPHA_KEY]: { lastTs: NOW, name: 'alpha' } }, projectNames: true,
    ...over,
  }
}

/** The dashboard's payload: only the nodes in `expanded` carry their children. */
function page(over: Partial<AgentTreeInput> = {}, now = NOW): AgentTreeVm {
  return buildAgentTree(input({ expanded: [], ...over, mode: 'page' }), now)
}

function build(over: Partial<AgentTreeInput> = {}, now = NOW): AgentTreeVm {
  return buildAgentTree(input(over), now)
}

/** Every node, depth first. */
function all(nodes: TreeNode[]): TreeNode[] {
  return nodes.flatMap((n) => [n, ...all(n.children)])
}

function node(vm: AgentTreeVm, key: string): TreeNode {
  const n = all(vm.roots).find((x) => x.key === key)
  assert.ok(n, `no node ${key} in ${all(vm.roots).map((x) => x.key).join(', ')}`)
  return n
}

/**
 * 1.7 F2: every session the tree lists — the active roots, then the earlier ones the group of
 * earlier sessions holds (a group ships its sessions while it is open, and the `text` mode opens
 * every node).
 */
function sessionsOf(vm: AgentTreeVm): TreeNode[] {
  return vm.roots.flatMap((r) => (r.kind === 'group' ? r.children : [r]))
}

/**
 * 1.7 F2: `n` sessions, every one of them active — the newest first, ten seconds apart, so the
 * oldest of MAX_ROOTS + 5 is still within SESSION_ACTIVE_MS — for the tests of a session beyond
 * MAX_ROOTS among the active ones. (A minute apart, as 1.6's tests had them, the eleventh is idle
 * and sits in the group of earlier sessions since 1.7.)
 */
function activeMains(n: number): MainRec[] {
  return Array.from({ length: n }, (_, i) =>
    main({ sessionId: `${String(i).padStart(8, '0')}-s`, lastTs: NOW - (i + 1) * 10_000, firstTs: NOW - HOUR }))
}

/** Distance from the root; the root itself is 0. */
function depths(vm: AgentTreeVm): Map<string, number> {
  const out = new Map<string, number>()
  const walk = (n: TreeNode, d: number): void => {
    out.set(n.key, d)
    for (const c of n.children) walk(c, d + 1)
  }
  for (const r of vm.roots) walk(r, 0)
  return out
}

function parentOf(vm: AgentTreeVm, key: string): TreeNode | null {
  return all(vm.roots).find((n) => n.children.some((c) => c.key === key)) ?? null
}

function stateText(over: Partial<AgentTreeInput>, key: string): string | undefined {
  return agentDetails(input(over), NOW, key)?.stateText
}

/** Node keys are the records' identifiers, whatever directory the transcripts sit in. */
const rootKey = `s:${S1}`
const agentKey = (id: string): string => `a:${id}`
const wfKey = `w:${S1}|${WF}`
/** 1.6 D4: the collector of run WF — its agents without a counted reply. */
const collectorKey = `n:${S1}|${WF}`

// ---------------------------------------------------------------------------
// §4.4 · states
// ---------------------------------------------------------------------------

test('an agent the parent recorded is done or failed, and the sentence names who recorded it and when', () => {
  const over: Partial<AgentTreeInput> = {
    agents: [
      // The last line comes with the result: a transcript that went on after it is D6's case.
      rec('aaaa0001', { outcome: 'completed', outcomeTs: NOW - 5 * MIN, lastTs: NOW - 5 * MIN }),
      rec('aaaa0002', { outcome: 'failed', outcomeTs: NOW - 26 * HOUR, firstTs: NOW - 27 * HOUR, lastTs: NOW - 26 * HOUR }),
    ],
    launches: [
      launch('aaaa0001', { outcome: 'completed', outcomeTs: NOW - 5 * MIN }),
      launch('aaaa0002', { outcome: 'failed', outcomeTs: NOW - 26 * HOUR, ts: NOW - 27 * HOUR }),
    ],
  }
  const vm = build(over)
  const done = node(vm, agentKey('aaaa0001'))
  assert.equal(done.state, 'done')
  assert.equal(done.derived, false, 'a recorded result is not an inference')
  const failed = node(vm, agentKey('aaaa0002'))
  assert.equal(failed.state, 'failed')
  assert.equal(failed.derived, false)
  assert.equal(stateText(over, done.key), 'Completed — the parent recorded the result at 11:55.')
  // Another day carries its date: "since 10:00" alone would name a time that has not come yet today.
  assert.equal(stateText(over, failed.key), 'Failed — the parent recorded the failure at 2026-09-21 10:00.')
})

// 1.7 W1: the tree's time stamps come from time.ts's `clockStamp` now — the failed quota attempt's
// sentence takes the same form. No output of the tree changes: the day boundary included, as `dayOf`
// has always counted it.
test('the tree\'s stamps are clockStamp\'s, and print exactly what they printed before (1.7 W1)', () => {
  const over = (cfg: TimeConfig): Partial<AgentTreeInput> => ({
    tcfg: cfg,
    agents: [
      rec('aaaa0001', { outcome: 'completed', outcomeTs: NOW - 5 * MIN, lastTs: NOW - 5 * MIN }),
      rec('aaaa0002', { outcome: 'failed', outcomeTs: NOW - 26 * HOUR, firstTs: NOW - 27 * HOUR, lastTs: NOW - 26 * HOUR }),
      // 02:30 today: with a boundary at 06:00 the day before, as dayOf counts it.
      rec('aaaa0003', { outcome: 'failed', outcomeTs: Date.UTC(2026, 8, 22, 2, 30), firstTs: NOW - 11 * HOUR, lastTs: Date.UTC(2026, 8, 22, 2, 30) }),
    ],
    launches: [
      launch('aaaa0001', { outcome: 'completed', outcomeTs: NOW - 5 * MIN }),
      launch('aaaa0002', { outcome: 'failed', outcomeTs: NOW - 26 * HOUR, ts: NOW - 27 * HOUR }),
      launch('aaaa0003', { outcome: 'failed', outcomeTs: Date.UTC(2026, 8, 22, 2, 30), ts: NOW - 11 * HOUR }),
    ],
  })
  const text = (cfg: TimeConfig, id: string): string | undefined => agentDetails(input(over(cfg)), NOW, agentKey(id))?.stateText
  assert.equal(text(tcfg, 'aaaa0001'), 'Completed — the parent recorded the result at 11:55.')
  assert.equal(text(tcfg, 'aaaa0002'), 'Failed — the parent recorded the failure at 2026-09-21 10:00.')
  assert.equal(text(tcfg, 'aaaa0003'), 'Failed — the parent recorded the failure at 02:30.')
  const late: TimeConfig = { ...tcfg, dayBoundaryHour: 6 }
  assert.equal(text(late, 'aaaa0003'), 'Failed — the parent recorded the failure at 2026-09-21 02:30.')
  assert.equal(text(late, 'aaaa0003'), `Failed — the parent recorded the failure at ${clockStamp(Date.UTC(2026, 8, 22, 2, 30), NOW, late)}.`)
  const berlin: TimeConfig = { ...tcfg, zone: 'Europe/Berlin' }
  assert.equal(text(berlin, 'aaaa0001'), `Completed — the parent recorded the result at ${clockStamp(NOW - 5 * MIN, NOW, berlin)}.`)
  assert.equal(text(berlin, 'aaaa0001'), 'Completed — the parent recorded the result at 13:55.')
})

// 1.6 P2b (§3 D2): pinned 1.5's journal, whose result came on the agent's own record — with a
// time, where a journal line had one. The journal's view is its run's now (`RunRec`), joined by
// agent id, and carries no time; a workflow agent's own outcome is the parent's.
test('a workflow agent completed or failed by the journal says so, without a time — the journal writes none', () => {
  const over: Partial<AgentTreeInput> = {
    agents: [
      wfRec('bbbb0001', { lastTs: NOW - 30 * MIN, firstTs: NOW - 40 * MIN }),
      wfRec('bbbb0002', { lastTs: NOW - 30 * MIN, firstTs: NOW - 40 * MIN }),
      wfRec('bbbb0005', { outcome: 'completed', outcomeTs: NOW - 4 * MIN, lastTs: NOW - 4 * MIN }),
      rec('bbbb0003', { outcome: 'completed', outcomeTs: null }),
      rec('bbbb0004', { outcome: 'failed', outcomeTs: null }),
    ],
    runs: [run([jagent('bbbb0001', { outcome: 'completed' }), jagent('bbbb0002', { outcome: 'failed' }), jagent('bbbb0005')])],
  }
  const vm = build(over)
  assert.deepEqual(['bbbb0001', 'bbbb0002'].map((id) => [node(vm, agentKey(id)).state, node(vm, agentKey(id)).derived]),
    [['done', false], ['failed', false]])
  assert.equal(stateText(over, agentKey('bbbb0001')), 'Completed — the workflow journal recorded the result.')
  assert.equal(stateText(over, agentKey('bbbb0002')), 'Failed — the workflow journal recorded the failure.')
  // A workflow agent's own outcome came from its parent — a launch, a notification — and says so.
  assert.equal(stateText(over, agentKey('bbbb0005')), 'Completed — the parent recorded the result at 11:56.')
  assert.equal(stateText(over, agentKey('bbbb0003')), 'Completed — the parent recorded the result.')
  assert.equal(stateText(over, agentKey('bbbb0004')), 'Failed — the parent recorded the failure.')
  // Without the run, the same records have no journal to take an outcome from.
  assert.equal(node(build({ ...over, runs: [] }), agentKey('bbbb0001')).state, 'unknown')
})

test('an outcome the parent recorded before the agent record carried it is still an outcome', () => {
  // The result line can be read before the agent's own file is; the launch has it first.
  const over: Partial<AgentTreeInput> = {
    agents: [rec('cccc0001', { lastTs: NOW - 40 * MIN, firstTs: NOW - 50 * MIN })],
    launches: [launch('cccc0001', { outcome: 'completed', outcomeTs: NOW - 3 * MIN })],
  }
  const n = node(build(over), agentKey('cccc0001'))
  assert.equal(n.state, 'done')
  assert.equal(stateText(over, n.key), 'Completed — the parent recorded the result at 11:57.')
  // An asynchronous launch is not a result: the agent still runs or is unknown by its own clock.
  const bg = build({
    agents: [rec('cccc0002', { lastTs: NOW - 40 * MIN, firstTs: NOW - 50 * MIN })],
    launches: [launch('cccc0002', { outcome: 'launched', background: true })],
  })
  assert.equal(node(bg, agentKey('cccc0002')).state, 'unknown')
})

test('without a recorded result an agent runs while its transcript is fresh and is unknown after ten silent minutes', () => {
  const over: Partial<AgentTreeInput> = {
    agents: [
      rec('dddd0001', { lastTs: NOW - 2 * MIN }),
      rec('dddd0002', { lastTs: NOW - 10 * MIN }),
      rec('dddd0003', { lastTs: NOW - 11 * MIN }),
      // Silent for twenty minutes, but launched again three minutes ago: the launch is activity.
      rec('dddd0004', { lastTs: NOW - 20 * MIN, firstTs: NOW - 40 * MIN }),
    ],
    launches: [launch('dddd0004', { ts: NOW - 3 * MIN })],
  }
  const vm = build(over)
  const states = ['dddd0001', 'dddd0002', 'dddd0003', 'dddd0004'].map((id) => node(vm, agentKey(id)))
  assert.deepEqual(states.map((n) => n.state), ['running', 'running', 'unknown', 'running'])
  assert.ok(states.every((n) => n.derived), 'running and unknown are inferences')
  assert.equal(stateText(over, states[0].key),
    'Running — inferred: the transcript changed 2 min ago and no result was recorded yet.')
  assert.equal(stateText(over, states[2].key),
    'Unknown — inferred: no result was recorded and the transcript has been silent since 11:49; the agent may have been stopped.')
  assert.equal(stateText(over, states[3].key),
    'Running — inferred: the transcript changed 3 min ago and no result was recorded yet.')
})

test('a launch whose transcript was never seen is a pending node under whoever launched it', () => {
  const over: Partial<AgentTreeInput> = {
    agents: [
      // Linked by its sidecar only: the launch does not name the agent yet.
      rec('aaaa0001'),
      // Linked by the launch naming it; the sidecar is missing.
      rec('aaaa0002', { meta: null, spawnerFile: null, firstTs: NOW - 25 * MIN }),
    ],
    launches: [
      launch('aaaa0001', { agentId: null }),
      launch('aaaa0002'),
      launch('pppp0001', { agentId: null, typeHint: 'Plan', modelHint: 'sonnet', ts: NOW - 2 * MIN }),
      launch('pppp0002', { agentId: null, typeHint: null, modelHint: null, ts: NOW - 20 * MIN }),
      launch('pppp0003', { agentId: 'dddd9999', ts: NOW - 40 * MIN, outcome: 'completed', outcomeTs: NOW - 35 * MIN }),
      launch('pppp0004', { agentId: null, file: agentFile('aaaa0001'), ts: NOW - 1 * MIN, outcome: 'launched', background: true }),
    ],
  }
  const vm = build(over)
  const keys = all(vm.roots).map((n) => n.key)
  assert.equal(keys.includes('l:toolu_aaaa0001'), false, 'a launch its agent accounts for is not a node of its own')
  assert.equal(keys.includes('l:toolu_aaaa0002'), false)

  const fresh = node(vm, 'l:toolu_pppp0001')
  assert.equal(fresh.kind, 'pending')
  assert.equal(fresh.label, 'Plan · sonnet · launched')
  assert.equal(fresh.state, 'running')
  assert.equal(fresh.derived, true)
  // Nothing of it was counted: dashes, never a zero and never a lower bound.
  assert.deepEqual([fresh.usage, fresh.duration, fresh.lowerBound], ['–', '–', false])
  assert.equal(fresh.startTs, NOW - 2 * MIN)
  assert.equal(parentOf(vm, fresh.key)?.key, rootKey)
  assert.equal(stateText(over, fresh.key),
    "Running — inferred: the parent recorded the launch 2 min ago and no result yet; the agent's transcript has not been seen yet.")

  const stale = node(vm, 'l:toolu_pppp0002')
  assert.equal(stale.label, 'Agent · – · launched')
  assert.equal(stale.state, 'unknown')
  assert.equal(stateText(over, stale.key),
    "Unknown — inferred: the parent recorded the launch at 11:40 but no result, and the agent's transcript was never seen; the agent may have been stopped.")

  // A named agent whose transcript never arrived, completed by the parent's record.
  const reported = node(vm, 'l:toolu_pppp0003')
  assert.equal(reported.state, 'done')
  assert.equal(reported.derived, false)
  assert.equal(stateText(over, reported.key), 'Completed — the parent recorded the result at 11:25.')

  // Launched by an agent: under that agent, not under the session.
  const nested = node(vm, 'l:toolu_pppp0004')
  assert.equal(parentOf(vm, nested.key)?.key, agentKey('aaaa0001'))
  assert.equal(nested.state, 'running')

  const d = agentDetails(input(over), NOW, fresh.key)
  assert.deepEqual(d?.rows.map((r) => [r.label, r.value]), [
    // 1.6 N6: who launched it by the name its row carries — the session by its first line, then its id.
    ['Type', 'Plan'], ['Models', 'sonnet'], ['ID', 'toolu_pppp0001'], ['Started', '11:58'], ['Spawned by', 'Session Tue 10:00 · 9d0eb37a'],
  ])
  // What Copy ID copies for a launch: its tool_use id, the one the ID row shows.
  assert.equal(d?.id, 'toolu_pppp0001')
  assert.deepEqual(d?.rows.find((r) => r.label === 'ID'), { label: 'ID', value: 'toolu_pppp0001', copy: true })
  // The two agents of the session share their first seven characters, so each name carries eight.
  assert.deepEqual(agentDetails(input(over), NOW, nested.key)?.rows.find((r) => r.label === 'Spawned by')?.value,
    'Explore · claude-opus-5 · aaaa0001')
  assert.deepEqual(agentDetails(input(over), NOW, stale.key)?.rows.slice(0, 2).map((r) => r.value), ['–', '–'])
})

test('a session is active while its transcript changed within ten minutes and idle after, and says so', () => {
  const activeOver = { mains: [main({ lastTs: NOW - 2 * MIN })] }
  const active = build(activeOver).roots[0]
  assert.deepEqual([active.kind, active.state, active.derived], ['session', 'active', true])
  assert.equal(stateText(activeOver, active.key), 'Active — inferred: the session transcript changed 2 min ago.')

  const idleOver = { mains: [main({ lastTs: NOW - 30 * MIN })] }
  // 1.7 F2 (pinned and changed): an idle session is no root of its own — it sits in the group of
  // earlier sessions, the tree's only root here.
  const idleVm = build(idleOver)
  assert.deepEqual(idleVm.roots.map((r) => r.kind), ['group'])
  const idle = idleVm.roots[0].children[0]
  assert.deepEqual([idle.kind, idle.state, idle.derived], ['session', 'idle', true])
  assert.equal(stateText(idleOver, idle.key), 'Idle — inferred: the session transcript has been silent since 11:30.')
})

test('agents whose session transcript was never read still get their session, which claims nothing', () => {
  // Silent agents: a running one would make the session active through it (see the roll-up).
  const over = { mains: [], agents: [rec('aaaa0001', { lastTs: NOW - 30 * MIN, firstTs: NOW - 40 * MIN })] }
  const vm = build(over)
  // 1.7 F2 (pinned and changed): a session in state unknown is an earlier one — in the group.
  assert.deepEqual(vm.roots.map((r) => r.kind), ['group'])
  assert.equal(sessionsOf(vm).length, 1)
  const root = sessionsOf(vm)[0]
  assert.equal(root.key, rootKey)
  assert.equal(root.label, 'Session 9d0eb37a')
  assert.deepEqual([root.state, root.derived, root.usage, root.duration, root.startTs, root.lastTs],
    ['unknown', true, '–', '–', null, null])
  assert.equal(stateText(over, root.key),
    "Unknown — inferred: the session's own transcript has not been read; only its agents were.")
  assert.deepEqual(root.children.map((c) => c.key), [agentKey('aaaa0001')])
})

// 1.6 P2b (§3.0 a): pinned 1.5's rule that one failure makes a run failed. A run is failed now only
// when every member is closed and none completed; one completion makes it done, and the failures
// beside it are the tally's to show (P2c).
test('a workflow run is running, failed, done or unknown from its agents', () => {
  const run = (agents: AgentRec[]): { vm: AgentTreeVm; w: TreeNode; text: string | undefined } => {
    const vm = build({ agents })
    return { vm, w: node(vm, wfKey), text: stateText({ agents }, wfKey) }
  }
  // An outcome is the parent's record, and its last line comes with it (D6: one that goes on after
  // the record is inferred again). 1.6 P2b: a completion on the record is the parent's too — 1.5
  // took a run agent's completion for the journal's, which is never outlived.
  const done = (id: string): AgentRec => wfRec(id, { outcome: 'completed', outcomeTs: NOW - 5 * MIN, lastTs: NOW - 5 * MIN })
  const failed = (id: string): AgentRec => wfRec(id, { outcome: 'failed', outcomeTs: NOW - 5 * MIN, lastTs: NOW - 5 * MIN })
  const silent = (id: string): AgentRec => wfRec(id, { lastTs: NOW - 30 * MIN, firstTs: NOW - 40 * MIN })

  const running = run([wfRec('eeee0001'), failed('eeee0002')])
  assert.equal(running.w.kind, 'workflow')
  // 1.6 N6 (pinned and changed): a run is named by when it started — its first agent's first line.
  assert.equal(running.w.label, 'Workflow run Tue 11:30 · cfe7718d')
  assert.deepEqual([running.w.state, running.w.derived], ['running', true])
  assert.equal(running.text, 'Running — inferred: at least one agent of this run is running.')
  assert.equal(parentOf(running.vm, running.w.key)?.key, rootKey)
  assert.deepEqual(running.w.children.map((c) => c.key).sort(),
    [agentKey('eeee0001'), agentKey('eeee0002')].sort())

  const one = run([done('eeee0001'), failed('eeee0002')])
  assert.deepEqual([one.w.state, one.w.derived], ['done', false], 'one failure beside a completion does not fail the run')
  assert.equal(one.text, 'Done — every agent of this run has a recorded outcome, and at least one completed.')

  const f = run([failed('eeee0001'), failed('eeee0002')])
  assert.deepEqual([f.w.state, f.w.derived], ['failed', false])
  assert.equal(f.text, 'Failed — every agent of this run has a recorded outcome, and none completed.')

  const d = run([done('eeee0001'), done('eeee0002')])
  assert.deepEqual([d.w.state, d.w.derived], ['done', false])
  assert.equal(d.text, 'Done — every agent of this run has a recorded outcome, and at least one completed.')

  const u = run([done('eeee0001'), silent('eeee0002')])
  assert.deepEqual([u.w.state, u.w.derived], ['unknown', true])
  // 1.6 §7c (P4): the run's unknown sentence says "outcome", as the run's other sentences do.
  assert.equal(u.text, 'Unknown — inferred: not every agent of this run has a recorded outcome, and none is running.')

  // The run's figures are its agents' figures: 2 × (300 + 200 + 700), from its first start to
  // its last line.
  assert.equal(u.w.usage, '2.4K')
  assert.equal(u.w.startTs, NOW - 40 * MIN)
  assert.equal(u.w.lastTs, NOW - 5 * MIN)
  assert.equal(u.w.duration, '35 min 00 s')
})

// ---------------------------------------------------------------------------
// 1.6 D7 · a stop is not a failure
// ---------------------------------------------------------------------------

test('a stop the parent recorded is stopped — recorded, in the parent\'s own word — and never failed', () => {
  // 1.14 P2 (pinned and changed: the German „um {n}" before a clock stamp → a label or brackets — „aufgezeichnet (11:55)" — §3 B2 rule 3).
  // killed, cancelled and stopped are a stop; failed, error and timeout a failure, as before.
  const stop = (id: string, word: AgentRec['outcomeStatus'], outcomeTs: number | null = NOW - 5 * MIN): Partial<AgentTreeInput> => ({
    agents: [rec(id, { outcome: 'stopped', outcomeStatus: word, outcomeTs, lastTs: NOW - 5 * MIN })],
    launches: [launch(id, { outcome: 'stopped', outcomeStatus: word, outcomeTs })],
  })
  for (const word of ['killed', 'cancelled', 'stopped'] as const) {
    const over = stop('aaaa0001', word)
    const n = node(build(over), agentKey('aaaa0001'))
    assert.deepEqual([n.state, n.derived], ['stopped', false], word)
    assert.equal(stateText(over, n.key), `Stopped — the parent recorded ‘${word}’ at 11:55.`)
    const d = agentDetails(input(over), NOW, n.key)
    assert.deepEqual([d?.state, d?.derived], ['stopped', false], word)
  }
  // Without a time the sentence says none, rather than inventing one.
  assert.equal(stateText(stop('aaaa0002', 'killed', null), agentKey('aaaa0002')), 'Stopped — the parent recorded ‘killed’.')
  // The launch alone carries the stop when the record has none yet (a cold scan's order).
  const fromLaunch: Partial<AgentTreeInput> = {
    agents: [rec('aaaa0003', { lastTs: NOW - 40 * MIN, firstTs: NOW - 50 * MIN })],
    launches: [launch('aaaa0003', { outcome: 'stopped', outcomeStatus: 'cancelled', outcomeTs: NOW - 3 * MIN })],
  }
  assert.equal(node(build(fromLaunch), agentKey('aaaa0003')).state, 'stopped')
  assert.equal(stateText(fromLaunch, agentKey('aaaa0003')), 'Stopped — the parent recorded ‘cancelled’ at 11:57.')
  // failed, error and timeout keep the failure's sentence of 1.5, whichever word it was.
  for (const word of ['failed', 'error', 'timeout'] as const) {
    const over: Partial<AgentTreeInput> = {
      agents: [rec('aaaa0004', { outcome: 'failed', outcomeStatus: word, outcomeTs: NOW - 5 * MIN, lastTs: NOW - 5 * MIN })],
      launches: [launch('aaaa0004', { outcome: 'failed', outcomeStatus: word, outcomeTs: NOW - 5 * MIN })],
    }
    assert.equal(node(build(over), agentKey('aaaa0004')).state, 'failed', word)
    assert.equal(stateText(over, agentKey('aaaa0004')), 'Failed — the parent recorded the failure at 11:55.', word)
  }
  // A stop without its word — no record this build writes — is no recorded outcome: the state is
  // inferred from the transcript, as for an agent nothing was recorded for.
  const wordless: Partial<AgentTreeInput> = {
    agents: [rec('aaaa0005', { outcome: 'stopped', outcomeStatus: null, outcomeTs: NOW - 5 * MIN, lastTs: NOW - 30 * MIN })],
  }
  assert.deepEqual([node(build(wordless), agentKey('aaaa0005')).state, node(build(wordless), agentKey('aaaa0005')).derived],
    ['unknown', true])
  // Nor is a word that says another outcome.
  const crossed: Partial<AgentTreeInput> = {
    agents: [rec('aaaa0006', { outcome: 'stopped', outcomeStatus: 'failed', outcomeTs: NOW - 5 * MIN, lastTs: NOW - 30 * MIN })],
  }
  assert.equal(node(build(crossed), agentKey('aaaa0006')).state, 'unknown')
  // A launch whose transcript never came, stopped by its parent.
  const pending: Partial<AgentTreeInput> = {
    launches: [launch('pppp0001', { agentId: null, ts: NOW - 40 * MIN, outcome: 'stopped', outcomeStatus: 'killed', outcomeTs: NOW - 20 * MIN })],
  }
  const p = node(build(pending), 'l:toolu_pppp0001')
  assert.deepEqual([p.kind, p.state, p.derived], ['pending', 'stopped', false])
  assert.equal(stateText(pending, p.key), 'Stopped — the parent recorded ‘killed’ at 11:40.')
  // In German, with the word verbatim.
  assert.equal(german(() => stateText(stop('aaaa0001', 'killed'), agentKey('aaaa0001'))),
    'Gestoppt — der Elternprozess hat ‚killed‘ aufgezeichnet (11:55).')
  assert.equal(german(() => stateText(stop('aaaa0002', 'cancelled', null), agentKey('aaaa0002'))),
    'Gestoppt — der Elternprozess hat ‚cancelled‘ aufgezeichnet.')
})

test('a run whose agents all ended is done while one completed, and stopped when every one was stopped', () => {
  const run = (agents: AgentRec[]): { w: TreeNode; text: string | undefined } =>
    ({ w: node(build({ agents }), wfKey), text: stateText({ agents }, wfKey) })
  const done = (id: string): AgentRec => wfRec(id, { outcome: 'completed', outcomeTs: NOW - 5 * MIN, lastTs: NOW - 5 * MIN })
  const stopped = (id: string): AgentRec =>
    wfRec(id, { outcome: 'stopped', outcomeStatus: 'killed', outcomeTs: NOW - 5 * MIN, lastTs: NOW - 5 * MIN })
  const failed = (id: string): AgentRec => wfRec(id, { outcome: 'failed', outcomeTs: NOW - 5 * MIN, lastTs: NOW - 5 * MIN })

  const mixed = run([done('eeee0001'), stopped('eeee0002')])
  assert.deepEqual([mixed.w.state, mixed.w.derived], ['done', false])
  // 1.6 P2b: the done sentence of §3 D2 replaces 1.5's "… has a recorded result."
  assert.equal(mixed.text, 'Done — every agent of this run has a recorded outcome, and at least one completed.')
  const all = run([stopped('eeee0001'), stopped('eeee0002')])
  assert.deepEqual([all.w.state, all.w.derived], ['stopped', false])
  assert.equal(all.text,
    'Stopped — every agent of this run has a recorded outcome, and none completed: the last attempt of each step was stopped.')
  // A stop is no failure; with nothing completed, a failure beside it fails the run (§3.0 a).
  assert.equal(run([stopped('eeee0001'), failed('eeee0002')]).w.state, 'failed')
  assert.equal(run([stopped('eeee0001'), wfRec('eeee0002')]).w.state, 'running')
  assert.equal(german(() => run([stopped('eeee0001')]).text),
    'Gestoppt — für jeden Agenten dieses Laufs ist ein Ausgang aufgezeichnet, und keiner wurde abgeschlossen: Der letzte Versuch jedes Schritts wurde gestoppt.')
})

test('a stopped agent that wrote on after its stop is inferred again, and its Recorded row says stopped', () => {
  // 1.14 P2 (pinned and changed: the German „um {n}" before a clock stamp → a label or brackets — „gestoppt (11:50)" — §3 B2 rule 3).
  const over: Partial<AgentTreeInput> = {
    agents: [rec('aaaa0001', { outcome: 'stopped', outcomeStatus: 'killed', outcomeTs: NOW - 10 * MIN, lastTs: NOW - 8 * MIN })],
    launches: [launch('aaaa0001', { outcome: 'stopped', outcomeStatus: 'killed', outcomeTs: NOW - 10 * MIN })],
    selected: agentKey('aaaa0001'),
  }
  const n = node(build(over), agentKey('aaaa0001'))
  assert.deepEqual([n.state, n.derived], ['running', true])
  assert.equal(build(over).selected?.rows.find((r) => r.label === 'Recorded')?.value, 'stopped at 11:50')
  assert.deepEqual(german(() => build(over).selected?.rows.find((r) => r.label === 'Aufgezeichnet')?.value), 'gestoppt (11:50)')
})

// ---------------------------------------------------------------------------
// 1.6 D2, D7 · the workflow journal: failures, retries, replacements
// ---------------------------------------------------------------------------

/** Ids in Claude Code's `a` + 16 hex shape, so the short ids the sentences name are four characters. */
const J1 = 'a1f2e3d4c5b6a7980'
const J2 = 'a2e3d4c5b6a798001'
const J3 = 'a3d4c5b6a79800112'
const J4 = 'a4c5b6a7980011223'
const silentWf = (id: string, over: Partial<AgentRec> = {}): AgentRec =>
  wfRec(id, { lastTs: NOW - 30 * MIN, firstTs: NOW - 40 * MIN, ...over })

test('a failed line of the journal makes its agent failed, recorded, in the journal\'s words — even two minutes after its last line', () => {
  // The mutation the spec names: without the failed branch this agent, silent for two minutes,
  // would read running for eight more.
  const over: Partial<AgentTreeInput> = {
    agents: [wfRec(J1, { lastTs: NOW - 2 * MIN, firstTs: NOW - 12 * MIN })],
    runs: [run([jagent(J1, { step: 1, outcome: 'failed' })])],
  }
  const n = node(build(over), agentKey(J1))
  assert.deepEqual([n.state, n.derived, n.superseded], ['failed', false, false])
  assert.equal(stateText(over, n.key), 'Failed — the workflow journal recorded the failure.')
  // Alone in its run, a failure fails the run: every member is closed and none completed.
  assert.deepEqual([node(build(over), wfKey).state, stateText(over, wfKey)],
    ['failed', 'Failed — every agent of this run has a recorded outcome, and none completed.'])
})

test('one failure among completed agents leaves the run done; every member failed fails it', () => {
  const agents = [silentWf(J1), silentWf(J2), silentWf(J3)]
  const mixed: Partial<AgentTreeInput> = {
    agents,
    runs: [run([jagent(J1, { step: 1, outcome: 'completed' }), jagent(J2, { step: 2, outcome: 'failed' }),
      jagent(J3, { step: 3, outcome: 'completed' })])],
  }
  assert.equal(node(build(mixed), agentKey(J2)).state, 'failed')
  assert.deepEqual([node(build(mixed), wfKey).state, node(build(mixed), wfKey).derived], ['done', false])
  assert.equal(stateText(mixed, wfKey), 'Done — every agent of this run has a recorded outcome, and at least one completed.')
  const all: Partial<AgentTreeInput> = {
    agents,
    runs: [run([jagent(J1, { step: 1, outcome: 'failed' }), jagent(J2, { step: 2, outcome: 'failed' }),
      jagent(J3, { step: 3, outcome: 'failed' })])],
  }
  assert.deepEqual([node(build(all), wfKey).state, stateText(all, wfKey)],
    ['failed', 'Failed — every agent of this run has a recorded outcome, and none completed.'])
  // One member still open — no record of an end, silent — keeps the run unknown, whatever failed.
  const open: Partial<AgentTreeInput> = {
    agents,
    runs: [run([jagent(J1, { step: 1, outcome: 'failed' }), jagent(J2, { step: 2, outcome: 'completed' }), jagent(J3, { step: 3 })])],
  }
  assert.equal(node(build(open), wfKey).state, 'unknown')
})

test('a failure the journal retried is failed, superseded and dimmed, and names the attempt that followed it', () => {
  const over: Partial<AgentTreeInput> = {
    agents: [silentWf(J1), silentWf(J2, { lastTs: NOW - 20 * MIN })],
    runs: [run([
      jagent(J1, { step: 1, attempt: 1, outcome: 'failed', supersededBy: J2 }),
      jagent(J2, { step: 1, attempt: 2, outcome: 'completed' }),
    ])],
    selected: agentKey(J1),
  }
  const vm = build(over)
  const first = node(vm, agentKey(J1))
  // It keeps its own state — a failure is a failure — and only the flag says a retry followed.
  assert.deepEqual([first.state, first.derived, first.superseded], ['failed', false, true])
  assert.equal(stateText(over, first.key),
    'Failed, retried — the workflow journal recorded the failure and started the same step again (agent 2e3d).')
  const second = node(vm, agentKey(J2))
  assert.deepEqual([second.state, second.superseded], ['done', false])
  // The retry completed: the run is done, and its failed first attempt is no final failure.
  assert.equal(node(vm, wfKey).state, 'done')
  // Which attempt each is, in the details, where the step was started more than once.
  assert.deepEqual(vm.selected?.rows.find((r) => r.label === 'Attempt'), { label: 'Attempt', value: '1 of 2 of this step' })
  assert.equal(build({ ...over, selected: agentKey(J2) }).selected?.rows.find((r) => r.label === 'Attempt')?.value,
    '2 of 2 of this step')
  // The row sits after the workflow run.
  const labels = vm.selected?.rows.map((r) => r.label) ?? []
  assert.equal(labels.indexOf('Attempt'), labels.indexOf('Workflow run') + 1, labels.join(', '))
  // A retried failure whose retry failed as well: the run failed, on its last attempt.
  const twice: Partial<AgentTreeInput> = {
    ...over,
    runs: [run([
      jagent(J1, { step: 1, attempt: 1, outcome: 'failed', supersededBy: J2 }),
      jagent(J2, { step: 1, attempt: 2, outcome: 'failed' }),
    ])],
  }
  assert.equal(node(build(twice), wfKey).state, 'failed')
})

test('an attempt the journal replaced before it recorded anything is stopped — replaced — and not "?"', () => {
  const over: Partial<AgentTreeInput> = {
    agents: [silentWf(J1), wfRec(J2)],
    runs: [run([
      jagent(J1, { step: 4, attempt: 1, outcome: 'stopped', supersededBy: J2 }),
      jagent(J2, { step: 4, attempt: 2 }),
    ], { steps: 4 })],
  }
  const vm = build(over)
  const replaced = node(vm, agentKey(J1))
  assert.deepEqual([replaced.state, replaced.derived, replaced.superseded], ['stopped', false, true])
  assert.equal(stateText(over, replaced.key),
    'Stopped, replaced — the workflow journal started the same step again (agent 2e3d) before this agent recorded a result.')
  // The replacement runs by its own clock, and the run with it.
  assert.deepEqual([node(vm, agentKey(J2)).state, node(vm, agentKey(J2)).superseded], ['running', false])
  assert.equal(node(vm, wfKey).state, 'running')
  // Every attempt of every step closed, the last one of each stopped: the run is stopped.
  const stoppedRun: Partial<AgentTreeInput> = {
    agents: [silentWf(J1), silentWf(J2)],
    runs: [run([
      jagent(J1, { step: 1, attempt: 1, outcome: 'failed', supersededBy: J2 }),
      jagent(J2, { step: 1, attempt: 2, outcome: 'stopped', supersededBy: J3 }),
      jagent(J3, { step: 1, attempt: 3, outcome: 'stopped', supersededBy: J4 }),
      jagent(J4, { step: 1, attempt: 4, outcome: 'stopped', supersededBy: 'a9999999999999999' }),
    ])],
  }
  const sv = build(stoppedRun)
  // J3 and J4 have no record: counted in the run, not drawn — and J4's replacement neither.
  assert.equal(node(sv, wfKey).agentCount, 4)
  // Every member superseded here — a hand-made run: nothing is open, nothing completed or failed
  // for good, so the run is stopped.
  assert.equal(node(sv, wfKey).state, 'stopped')
  // In German.
  assert.equal(german(() => stateText(over, replaced.key)),
    'Gestoppt, ersetzt — das Workflow-Journal hat denselben Schritt erneut gestartet (Agent 2e3d), bevor dieser Agent ein Ergebnis aufgezeichnet hat.')
})

test('the parent\'s record beats the journal\'s, and the journal\'s end is never outlived', () => {
  const over: Partial<AgentTreeInput> = {
    agents: [
      wfRec(J1, { outcome: 'completed', outcomeTs: NOW - 5 * MIN, lastTs: NOW - 5 * MIN }),
      // Written a minute ago, and the journal recorded its result: done, never revived.
      wfRec(J2, { lastTs: NOW - MIN }),
    ],
    runs: [run([jagent(J1, { step: 1, outcome: 'failed', supersededBy: J3 }), jagent(J3, { step: 1, attempt: 2 }),
      jagent(J2, { step: 2, outcome: 'completed' })])],
  }
  const vm = build(over)
  // The parent's outcome and sentence; the journal's supersession still dims the row.
  assert.deepEqual([node(vm, agentKey(J1)).state, node(vm, agentKey(J1)).superseded], ['done', true])
  assert.equal(stateText(over, agentKey(J1)), 'Completed — the parent recorded the result at 11:55.')
  assert.deepEqual([node(vm, agentKey(J2)).state, node(vm, agentKey(J2)).derived], ['done', false])
  assert.equal(agentDetails(input(over), NOW, agentKey(J2))?.rows.some((r) => r.label === 'Recorded'), false)
  // A step started once has no Attempt row, nor has an agent without a key (step 0).
  assert.equal(agentDetails(input(over), NOW, agentKey(J2))?.rows.some((r) => r.label === 'Attempt'), false)
  const keyless: Partial<AgentTreeInput> = { agents: [silentWf(J1)], runs: [run([jagent(J1, { step: 0 }), jagent(J2, { step: 0 })])] }
  assert.equal(agentDetails(input(keyless), NOW, agentKey(J1))?.rows.some((r) => r.label === 'Attempt'), false)
})

// 1.6 P5b (§3 D4): pinned "counted, in its state, not drawn" (P2b); the journal-only members are
// drawn now — in one collector, the run's last child — and counted as before.
test('an agent the journal started without a counted transcript is a member of its run: counted, in its state, in the collector', () => {
  const journalOnly = [jagent(J2, { step: 2 }), jagent(J3, { step: 3, outcome: 'failed' }), jagent(J4, { step: 4, outcome: 'completed' })]
  const quiet: Partial<AgentTreeInput> = {
    agents: [silentWf(J1)],
    runs: [run([jagent(J1, { step: 1, outcome: 'completed' }), ...journalOnly], { lastTs: NOW - 30 * MIN })],
  }
  const vm = build(quiet)
  const w = node(vm, wfKey)
  // Four members, one drawn as an agent, three in the collector: the count says so on the run
  // and on its session.
  assert.deepEqual(w.children.map((c) => c.key), [agentKey(J1), collectorKey])
  assert.equal(node(vm, collectorKey).agentCount, 3)
  assert.equal(w.agentCount, 4)
  assert.equal(node(vm, rootKey).agentCount, 4)
  // 1.6 P9 (L2, pinned and changed): a run's Agents row is its tally in words, the started first —
  // it was the bare count; a session's stays the count.
  assert.equal(agentDetails(input(quiet), NOW, wfKey)?.rows.find((r) => r.label === 'Agents')?.value,
    '4 started, 2 done, 1 failed, about 1 unknown')
  assert.equal(agentDetails(input(quiet), NOW, rootKey)?.rows.find((r) => r.label === 'Agents')?.value, '4')
  // J2 has no end and the journal has been quiet for half an hour: unknown — so is the run.
  assert.equal(w.state, 'unknown')
  // A journal written within the ten minutes makes its open member running, and the run with it.
  const fresh: Partial<AgentTreeInput> = { ...quiet, runs: [run(quiet.runs![0].agents, { lastTs: NOW - 2 * MIN })] }
  assert.equal(node(build(fresh), wfKey).state, 'running')
  // So does a sibling that runs by its own transcript.
  const sibling: Partial<AgentTreeInput> = { ...quiet, agents: [wfRec(J1)], runs: [run([jagent(J1, { step: 1 }), ...journalOnly])] }
  assert.equal(node(build(sibling), wfKey).state, 'running')
  // Every journal-only member closed, one completion: done.
  const closed: Partial<AgentTreeInput> = {
    ...quiet, runs: [run([jagent(J1, { step: 1, outcome: 'completed' }), jagent(J2, { step: 2, outcome: 'failed' })])],
  }
  assert.equal(node(build(closed), wfKey).state, 'done')
  // The running one is in the running list through its collector — one entry, never a row of its own.
  assert.deepEqual(build(fresh).runningNow.map((r) => [r.key, r.kind, r.running]), [[collectorKey, 'noreply', 1]])
  assert.equal(build(fresh).running, 1)
})

test('a run its journal knows and no record of which was counted is still a node of its session', () => {
  const over: Partial<AgentTreeInput> = {
    mains: [main({ lastTs: NOW - 3 * DAY, firstTs: NOW - 3 * DAY - HOUR })],
    runs: [run([jagent(J1, { step: 1, outcome: 'completed' }), jagent(J2, { step: 2 })], { lastTs: NOW - 2 * DAY })],
  }
  const vm = build(over)
  // The session is older than a day and has no agent record: its run brings it into the tree.
  const w = node(vm, wfKey)
  // 1.6 P5b (D4): pinned no child (P2b); its two members are its collector's now.
  assert.deepEqual([w.children.map((c) => c.key), w.agentCount, w.state], [[collectorKey], 2, 'unknown'])
  assert.deepEqual([w.usage, w.duration], ['–', '–'], 'nothing of it was counted: dashes, never zeros')
  // A run whose journal is older than the retention is not.
  assert.equal(build({ ...over, runs: [run(over.runs![0].agents, { lastTs: NOW - 8 * DAY })] }).roots.length, 0)
})

test('a run beyond MAX_RUN_AGENTS says how many agents it did not list', () => {
  const over: Partial<AgentTreeInput> = {
    agents: [silentWf(J1)],
    runs: [run([jagent(J1, { step: 1, outcome: 'completed' })], { agentsDropped: 12 })],
    selected: wfKey,
  }
  // 1.6 P9 (L2, pinned and changed): the tally in words, where it was the bare count.
  assert.deepEqual(build(over).selected?.rows.find((r) => r.label === 'Agents'),
    { label: 'Agents', value: '1 started, 1 done', note: '12 further agents not listed', kind: 'sentence' })
  assert.deepEqual(german(() => build(over).selected?.rows.find((r) => r.label === 'Agenten')?.note), '12 weitere Agenten nicht aufgeführt')
})

test('a short id keeps apart the agents the journal names without a record, too', () => {
  // J1 and a journal-only agent share their first four hex: both names — and the sentence that
  // names the next attempt — carry five.
  const twin = 'a1f2e9d4c5b6a7980'
  const over: Partial<AgentTreeInput> = {
    agents: [silentWf(J1)],
    runs: [run([jagent(J1, { step: 1, outcome: 'failed', supersededBy: twin }), jagent(twin, { step: 1, attempt: 2 })])],
  }
  const n = node(build(over), agentKey(J1))
  assert.ok(n.label.endsWith(' · 1f2e3'), n.label)
  assert.equal(stateText(over, n.key),
    'Failed, retried — the workflow journal recorded the failure and started the same step again (agent 1f2e9).')
})

test('the journal and run sentences, the Attempt row and the dimmed rows speak German', () => {
  const over: Partial<AgentTreeInput> = {
    agents: [silentWf(J1), silentWf(J2)],
    runs: [run([jagent(J1, { step: 1, outcome: 'failed', supersededBy: J2 }), jagent(J2, { step: 1, attempt: 2, outcome: 'failed' })])],
    selected: agentKey(J1),
  }
  assert.equal(german(() => stateText(over, agentKey(J1))),
    'Fehlgeschlagen, wiederholt — das Workflow-Journal hat den Fehlschlag aufgezeichnet und denselben Schritt erneut gestartet (Agent 2e3d).')
  assert.equal(german(() => stateText({ ...over, runs: [run([jagent(J1, { outcome: 'failed' })])] }, agentKey(J1))),
    'Fehlgeschlagen — das Workflow-Journal hat den Fehlschlag aufgezeichnet.')
  assert.deepEqual(german(() => build(over).selected?.rows.find((r) => r.label === 'Versuch')?.value), '1 von 2 dieses Schritts')
  assert.equal(german(() => stateText(over, wfKey)),
    'Fehlgeschlagen — für jeden Agenten dieses Laufs ist ein Ausgang aufgezeichnet, und keiner wurde abgeschlossen.')
  const done: Partial<AgentTreeInput> = { ...over, agents: [silentWf(J1)], runs: [run([jagent(J1, { outcome: 'completed' })])] }
  assert.equal(german(() => stateText(done, wfKey)),
    'Fertig — für jeden Agenten dieses Laufs ist ein Ausgang aufgezeichnet, und mindestens einer wurde abgeschlossen.')
})

test('a session with nothing but a journal-only member at work is active through it', () => {
  const over: Partial<AgentTreeInput> = {
    mains: [main({ lastTs: NOW - 30 * MIN })],
    agents: [silentWf(J1)],
    runs: [run([jagent(J1, { step: 1, outcome: 'completed' }), jagent(J2, { step: 2 })], { lastTs: NOW - MIN })],
  }
  const root = build(over).roots[0]
  assert.deepEqual([root.state, root.derived], ['active', true])
  assert.equal(stateText(over, root.key), 'Active — inferred: an agent of this session is running.')
  // Every node that is no superseded attempt says so.
  for (const n of all(build(over).roots)) assert.equal(n.superseded, false, n.key)
})

// ---------------------------------------------------------------------------
// 1.6 N1 · the tally
// ---------------------------------------------------------------------------

/** One agent id per member of the tally world: `a` + 16 hex, apart in their first four. */
const T = {
  done: 'a1000000000000001', failed: 'a2000000000000002', retryFail: 'a3000000000000003', retry: 'a4000000000000004',
  replaced: 'a5000000000000005', replacement: 'a6000000000000006', onlyOpen: 'a7000000000000007', onlyDone: 'a8000000000000008',
  killed: 'a9000000000000009', silent: 'ab00000000000000b', waiting: 'ac00000000000000c',
}

/**
 * Every state an agent below a session can be in, once: in a workflow run a completion, a
 * final failure, a failure the journal retried and its completed retry, an attempt the journal
 * replaced and the replacement that runs, and two agents the journal started without a counted
 * transcript — one open (running beside the replacement), one completed; beside the run an agent
 * the parent recorded as killed, one gone silent, and one that waits on the launch it made a
 * minute ago, whose transcript has not appeared yet.
 */
function tallyWorld(): Partial<AgentTreeInput> {
  return {
    agents: [
      silentWf(T.done), silentWf(T.failed), silentWf(T.retryFail), silentWf(T.retry), silentWf(T.replaced),
      wfRec(T.replacement, { lastTs: NOW - MIN }),
      rec(T.killed, { outcome: 'stopped', outcomeStatus: 'killed', outcomeTs: NOW - 20 * MIN, lastTs: NOW - 20 * MIN }),
      rec(T.silent, { firstTs: NOW - 40 * MIN, lastTs: NOW - 30 * MIN }),
      rec(T.waiting, { firstTs: NOW - 40 * MIN, lastTs: NOW - 30 * MIN }),
    ],
    launches: [launch('pppp0001', { agentId: null, file: agentFile(T.waiting), ts: NOW - MIN })],
    runs: [run([
      jagent(T.done, { step: 1, outcome: 'completed' }),
      jagent(T.failed, { step: 2, outcome: 'failed' }),
      jagent(T.retryFail, { step: 3, outcome: 'failed', supersededBy: T.retry }),
      jagent(T.retry, { step: 3, attempt: 2, outcome: 'completed' }),
      jagent(T.replaced, { step: 4, outcome: 'stopped', supersededBy: T.replacement }),
      jagent(T.replacement, { step: 4, attempt: 2 }),
      jagent(T.onlyOpen, { step: 5 }),
      jagent(T.onlyDone, { step: 6, outcome: 'completed' }),
    ])],
  }
}

test('a tally counts every attempt below a node once, under the state its row shows — a superseded one as retried', () => {
  const vm = build(tallyWorld())
  const root = node(vm, rootKey)
  // Twelve members: nine records, the launch, and the run's two journal-only agents.
  assert.deepEqual(root.tally, { started: 12, done: 3, failed: 1, retried: 2, stopped: 1, running: 4, unknown: 1 })
  assert.equal(root.tallyText, '12 started · 3 ✓ · 1 ✕ · 2 ↻ · 1 ■ · ~4 ● · ~1 ?')
  assert.equal(root.tallySpoken, '12 started, 3 done, 1 failed, 2 retried, 1 stopped, about 4 running, about 1 unknown')
  // The run: its six records and its two journal-only members; the retried failure and the
  // replaced attempt are retried, not failed and not stopped; the open journal-only member runs
  // beside the replacement.
  const w = node(vm, wfKey)
  assert.deepEqual(w.tally, { started: 8, done: 3, failed: 1, retried: 2, stopped: 0, running: 2, unknown: 0 })
  assert.equal(w.tallyText, '8 started · 3 ✓ · 1 ✕ · 2 ↻ · ~2 ●')
  assert.equal(w.tallySpoken, '8 started, 3 done, 1 failed, 2 retried, about 2 running')
  // An agent with an agent below it counts that one — its launch — and never itself.
  const waiting = node(vm, agentKey(T.waiting))
  assert.deepEqual([waiting.state, waiting.tally], ['running', { started: 1, done: 0, failed: 0, retried: 0, stopped: 0, running: 1, unknown: 0 }])
  assert.equal(waiting.tallyText, '1 started · ~1 ●')
  assert.equal(waiting.tallySpoken, '1 started, about 1 running')
  // 1.6 P5b (D4): the run's two journal-only members are its collector's — which carries their
  // tally, one completed, one running beside the replacement.
  const collector = node(vm, collectorKey)
  assert.deepEqual(collector.tally, { started: 2, done: 1, failed: 0, retried: 0, stopped: 0, running: 1, unknown: 0 })
  assert.equal(collector.tallyText, '2 started · 1 ✓ · ~1 ●')
  // Every node without an agent below it has no tally at all: no "0 started" claimed anywhere.
  for (const n of all(vm.roots)) {
    const has = n.key === rootKey || n.key === wfKey || n.key === waiting.key || n.key === collectorKey
    assert.equal(n.tally !== null, has, n.key)
    assert.equal(n.tallyText !== null, has, n.key)
    assert.equal(n.tallySpoken !== null, has, n.key)
    if (n.tally) {
      const t = n.tally
      assert.equal(t.done + t.failed + t.retried + t.stopped + t.running + t.unknown, t.started, n.key)
      assert.equal(t.started, n.agentCount, n.key)
    }
  }
  assert.deepEqual([build().roots[0].tally, build().roots[0].tallyText, build().roots[0].tallySpoken], [null, null, null],
    'a session without agents')
  // The run's Agents row says the tally — 1.6 P9 (L2, pinned and changed): in words, where it was
  // the started alone — journal-only members included.
  assert.deepEqual(agentDetails(input(tallyWorld()), NOW, wfKey)?.rows.find((r) => r.label === 'Agents'),
    { label: 'Agents', value: '8 started, 3 done, 1 failed, 2 retried, about 2 running', kind: 'sentence' })
})

test('a tally names only the states it has, and only the inferred ones carry the estimate mark', () => {
  // All done: the started agents and the one state, nothing else.
  const done: Partial<AgentTreeInput> = {
    agents: [silentWf(J1), silentWf(J2)],
    runs: [run([jagent(J1, { step: 1, outcome: 'completed' }), jagent(J2, { step: 2, outcome: 'completed' })])],
  }
  assert.equal(node(build(done), wfKey).tallyText, '2 started · 2 ✓')
  assert.equal(node(build(done), wfKey).tallySpoken, '2 started, 2 done')
  // Unknown alone: the estimate mark, and "about" in words.
  const quiet: Partial<AgentTreeInput> = { agents: [rec(J1, { firstTs: NOW - 40 * MIN, lastTs: NOW - 30 * MIN })] }
  assert.equal(build(quiet).roots[0].tallyText, '1 started · ~1 ?')
  assert.equal(build(quiet).roots[0].tallySpoken, '1 started, about 1 unknown')
  // A stop nothing replaced is stopped, recorded: no mark.
  const stopped: Partial<AgentTreeInput> = { agents: [rec(J1, { outcome: 'stopped', outcomeStatus: 'cancelled', outcomeTs: NOW - 20 * MIN, lastTs: NOW - 20 * MIN })] }
  assert.equal(build(stopped).roots[0].tallyText, '1 started · 1 ■')
  // The mark is on running and unknown only, on every node of the tally world.
  for (const n of all(build(tallyWorld()).roots)) {
    if (n.tallyText === null) continue
    for (const part of n.tallyText.split(' · ').slice(1)) assert.equal(part.startsWith('~'), /[●?]$/.test(part), part)
    assert.equal(/\b0 /.test(n.tallyText), false, n.tallyText)
  }
})

test('a run\'s state is the one function of its tally, so its row and its tally never disagree', () => {
  // Runs of every make-up, drawn by a fixed-seed generator: records and journal-only members,
  // open or ended by the journal or stopped by the parent, superseded or not, fresh or silent.
  // Whatever the members, the
  // run's state is §3.0 (a) read off its tally — running, then unknown, then done, failed,
  // stopped — and the tally holds every member once.
  let seed = 7
  const rand = (): number => {
    seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648
    return seed / 2_147_483_648
  }
  const pick = <V>(xs: readonly V[]): V => xs[Math.floor(rand() * xs.length)]
  const ruled = new Set<string>()
  for (let i = 0; i < 300; i++) {
    const size = 1 + Math.floor(rand() * 6)
    const ids = Array.from({ length: size }, (_, k) => `a${String(i).padStart(4, '0')}${String(k).padStart(12, '0')}`)
    const journal: JournalAgent[] = []
    const agents: AgentRec[] = []
    ids.forEach((id, k) => {
      const next = k + 1 < size && rand() < 0.35 ? ids[k + 1] : null
      const outcome = next !== null ? pick(['failed', 'stopped', 'completed'] as const) : pick([null, null, 'completed', 'failed'] as const)
      journal.push(jagent(id, { step: next !== null || (k > 0 && journal[k - 1].supersededBy === id) ? 1 : k + 2, outcome, supersededBy: next }))
      if (rand() < 0.6) {
        const r = rand()
        agents.push(wfRec(id, r < 0.2
          // A stop the parent recorded, which beats whatever the journal says of the agent.
          ? { outcome: 'stopped', outcomeStatus: 'killed', outcomeTs: NOW - 20 * MIN, firstTs: NOW - 40 * MIN, lastTs: NOW - 20 * MIN }
          : r < 0.45 ? { lastTs: NOW - MIN } : { firstTs: NOW - 40 * MIN, lastTs: NOW - 30 * MIN }))
      }
    })
    const vm = build({ agents, runs: [run(journal, { lastTs: rand() < 0.2 ? NOW - 2 * MIN : NOW - 30 * MIN })] })
    const w = node(vm, wfKey)
    const t = w.tally
    assert.ok(t, `run ${i}`)
    assert.equal(t.started, size, `run ${i}`)
    assert.equal(t.retried, journal.filter((j) => j.supersededBy !== null).length, `run ${i}`)
    const want = t.running > 0 ? 'running' : t.unknown > 0 ? 'unknown' : t.done > 0 ? 'done' : t.failed > 0 ? 'failed' : 'stopped'
    assert.equal(w.state, want, `run ${i}: ${w.tallyText}`)
    ruled.add(want)
  }
  assert.deepEqual([...ruled].sort(), ['done', 'failed', 'running', 'stopped', 'unknown'], 'every rule was reached')
})

// 1.6 P3a (§3 D3): the MAX_NODES cut is gone; what a node shows is its window of fifty, and the
// tally still counts every agent, shown or not — and closed, where the page carries none.
test('a tally is taken on the whole tree — a window shows rows, not agents — in the reader\'s digits', () => {
  const many = Array.from({ length: 400 }, (_, i) => rec(`c${String(i).padStart(7, '0')}`, {
    firstTs: NOW - 5 * HOUR + i * 1000, lastTs: NOW - 2 * HOUR, outcome: 'completed', outcomeTs: NOW - 2 * HOUR,
  }))
  const cut = build({ agents: many })
  assert.equal(cut.roots[0].children.length, MAX_GROUP_CHILDREN)
  assert.equal(cut.roots[0].childrenMore, 400 - MAX_GROUP_CHILDREN)
  assert.deepEqual(cut.roots[0].tally, { started: 400, done: 400, failed: 0, retried: 0, stopped: 0, running: 0, unknown: 0 })
  const closed = page({ agents: many })
  assert.deepEqual([closed.roots[0].children.length, closed.roots[0].childrenMore], [0, 0])
  assert.deepEqual(closed.roots[0].tally, cut.roots[0].tally)
  // Twelve hundred agents of a run's journal, none of them a row: grouped as the page groups figures.
  const big: Partial<AgentTreeInput> = {
    runs: [run(Array.from({ length: 1200 }, (_, i) => jagent(`a${String(i).padStart(16, '0')}`, { step: i + 1, outcome: 'completed' })))],
  }
  assert.equal(node(build(big), wfKey).tallyText, '1,200 started · 1,200 ✓')
  assert.equal(german(() => node(build(big), wfKey).tallyText), '1.200 gestartet · 1.200 ✓')
})

// ---------------------------------------------------------------------------
// 1.7 F4 · the tally part by part, each part with the state it counts
// ---------------------------------------------------------------------------

/** The tones of a tally's parts in the order the row writes them (§2.7 of the 1.7 spec). */
const TONE_ORDER = ['started', 'done', 'failed', 'retried', 'stopped', 'running', 'unknown'] as const

/**
 * 1.7 F4 test 1: a node's `tallyParts` are its `tallyText` part by part — the same words, joined by
 * " · " — each with the state it counts: started first, then only the states with an agent, in the
 * row's order, `~` on running and unknown and on nothing else, each part's number that field of the
 * tally; null with the tally.
 */
function partsHold(n: TreeNode, lang: 'en' | 'de' = 'en'): void {
  if (n.tally === null) {
    assert.deepEqual([n.tallyText, n.tallyParts], [null, null], n.key)
    return
  }
  const parts = n.tallyParts
  assert.ok(Array.isArray(parts) && parts.length > 0, n.key)
  assert.equal(parts.map((p) => p.label).join(' · '), n.tallyText, n.key)
  // Every part is words and a tone of the seven, nothing else.
  for (const p of parts) assert.deepEqual(Object.keys(p).sort(), ['label', 'tone'], n.key)
  // Started first, then the tones with a count, in the row's order, none with zero.
  const tally = n.tally
  assert.deepEqual(parts.map((p) => p.tone), TONE_ORDER.filter((k) => k === 'started' || tally[k] > 0), n.key)
  for (const p of parts) {
    // Only the two inferred states carry the estimate mark — the part as the row draws it.
    assert.equal(p.label.startsWith('~'), p.tone === 'running' || p.tone === 'unknown', `${n.key}: ${p.label}`)
    // Its number is that field of the tally, in the reader's digits.
    const digits = Number(p.label.replace(/^~/, '').split(' ')[0].replace(/[.,]/g, ''))
    assert.equal(digits, tally[p.tone], `${n.key}: ${p.label}`)
    const glyph = { started: lang === 'de' ? 'gestartet' : 'started', done: '✓', failed: '✕', retried: '↻', stopped: '■', running: '●', unknown: '?' }[p.tone]
    assert.ok(p.label.endsWith(' ' + glyph), `${n.key}: ${p.label}`)
  }
}

test('1.7 F4: a tally\'s parts are its text part by part, each with the state it counts — started, then the states it has, ~ on the inferred ones', () => {
  const vm = build(tallyWorld())
  const root = node(vm, rootKey)
  // Every state once at the root: the seven tones, in the row's order.
  assert.deepEqual(root.tallyParts, [
    { label: '12 started', tone: 'started' }, { label: '3 ✓', tone: 'done' }, { label: '1 ✕', tone: 'failed' },
    { label: '2 ↻', tone: 'retried' }, { label: '1 ■', tone: 'stopped' }, { label: '~4 ●', tone: 'running' },
    { label: '~1 ?', tone: 'unknown' },
  ])
  assert.deepEqual(node(vm, wfKey).tallyParts?.map((p) => p.tone), ['started', 'done', 'failed', 'retried', 'running'])
  for (const n of all(vm.roots)) partsHold(n)
  // Closed, as the page starts: the same parts on the node that ships no child.
  const shut = page(tallyWorld()).roots[0]
  assert.deepEqual([shut.children, shut.tallyParts], [[], root.tallyParts])
  // The runs of every make-up (the generator of the run-state test, a seed of its own): every node's parts hold.
  let seed = 11
  const rand = (): number => {
    seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648
    return seed / 2_147_483_648
  }
  for (let i = 0; i < 120; i++) {
    const size = 1 + Math.floor(rand() * 6)
    const ids = Array.from({ length: size }, (_, k) => `a${String(i).padStart(4, '0')}${String(k).padStart(12, '0')}`)
    const journal: JournalAgent[] = ids.map((id, k) => jagent(id, {
      step: k + 1, outcome: ([null, 'completed', 'failed', 'stopped'] as const)[Math.floor(rand() * 4)],
      supersededBy: k + 1 < size && rand() < 0.3 ? ids[k + 1] : null,
    }))
    const agents = ids.filter(() => rand() < 0.6).map((id) => wfRec(id, rand() < 0.5 ? { lastTs: NOW - MIN } : { firstTs: NOW - 40 * MIN, lastTs: NOW - 30 * MIN }))
    for (const n of all(build({ agents, runs: [run(journal)] }).roots)) partsHold(n)
  }
  // Twelve hundred of them: the reader's digits in the part as in the text.
  const big: Partial<AgentTreeInput> = {
    runs: [run(Array.from({ length: 1200 }, (_, i) => jagent(`a${String(i).padStart(16, '0')}`, { step: i + 1, outcome: 'completed' })))],
  }
  assert.deepEqual(node(build(big), wfKey).tallyParts, [{ label: '1,200 started', tone: 'started' }, { label: '1,200 ✓', tone: 'done' }])
  // German: the words the text has, the tones the same.
  const de = german(() => build(tallyWorld()))
  for (const n of all(de.roots)) partsHold(n, 'de')
  assert.deepEqual(node(de, rootKey).tallyParts?.map((p) => p.label),
    ['12 gestartet', '3 ✓', '1 ✕', '2 ↻', '1 ■', '~4 ●', '~1 ?'])
  assert.deepEqual(german(() => node(build(big), wfKey).tallyParts), [{ label: '1.200 gestartet', tone: 'started' }, { label: '1.200 ✓', tone: 'done' }])
  // A session without agents: no parts, as no tally and no text.
  assert.deepEqual([build().roots[0].tally, build().roots[0].tallyText, build().roots[0].tallyParts], [null, null, null])
})

test('1.7 F4: the group of earlier sessions carries the parts of its summed tally — closed as open — and a dash\'s null without one', () => {
  const E1 = 'eeee0001-0000-4000-8000-000000000000'
  const E2 = 'eeee0002-0000-4000-8000-000000000000'
  const quiet = (sessionId: string, h: number): MainRec => main({ sessionId, lastTs: NOW - h * HOUR, firstTs: NOW - (h + 1) * HOUR })
  const past = (id: string, sessionId: string, over: Partial<AgentRec> = {}): AgentRec =>
    rec(id, { sessionId, firstTs: NOW - 3 * HOUR, lastTs: NOW - 2 * HOUR - 30 * MIN, ...over })
  const over: Partial<AgentTreeInput> = {
    mains: [main(), quiet(E1, 1), quiet(E2, 2)],
    agents: [
      rec('aaaa0001'),
      past('bbbb0001', E1, { outcome: 'completed', outcomeTs: NOW - 2 * HOUR - 30 * MIN }),
      past('bbbb0002', E1, { outcome: 'failed', outcomeTs: NOW - 2 * HOUR - 30 * MIN }),
      past('cccc0001', E2),
    ],
  }
  const g = build(over).roots.find((r) => r.kind === 'group')
  assert.ok(g)
  assert.deepEqual(g.tallyParts, [{ label: '3 started', tone: 'started' }, { label: '1 ✓', tone: 'done' },
    { label: '1 ✕', tone: 'failed' }, { label: '~1 ?', tone: 'unknown' }])
  partsHold(g)
  const shut = page(over).roots.find((r) => r.kind === 'group')
  assert.deepEqual([shut?.children, shut?.tallyParts], [[], g.tallyParts])
  const none = build({ mains: [main(), quiet(E2, 2)] }).roots[1]
  assert.deepEqual([none.kind, none.tallyParts], ['group', null])
  // Every node of the earlier-sessions world, opened.
  for (const n of all(page({ ...earlierWorld().over, expanded: [EARLIER_KEY] }).roots)) partsHold(n)
})

test('the tally speaks German, and its glyphs are the same in every language', () => {
  const vm = german(() => build(tallyWorld()))
  const root = node(vm, rootKey)
  assert.equal(root.tallyText, '12 gestartet · 3 ✓ · 1 ✕ · 2 ↻ · 1 ■ · ~4 ● · ~1 ?')
  assert.equal(root.tallySpoken,
    '12 gestartet, 3 fertig, 1 fehlgeschlagen, 2 wiederholt, 1 gestoppt, etwa 4 laufend, etwa 1 unbekannt')
  assert.equal(node(vm, agentKey(T.waiting)).tallySpoken, '1 gestartet, etwa 1 laufend')
})

// ---------------------------------------------------------------------------
// §4.5 · roots
// ---------------------------------------------------------------------------

test('roots are the sessions of the last day and the sessions with agents in retention, most recent first', () => {
  const vm = build({
    mains: [
      main({ sessionId: 'aaaa1111-recent', lastTs: NOW - 1 * HOUR, firstTs: NOW - 2 * HOUR }),
      main({ sessionId: 'bbbb2222-dayold', lastTs: NOW - 25 * HOUR, firstTs: NOW - 26 * HOUR }),
      main({ sessionId: 'cccc3333-agents', lastTs: NOW - 3 * DAY, firstTs: NOW - 3 * DAY - HOUR }),
      main({ sessionId: 'dddd4444-expired', lastTs: NOW - 8 * DAY, firstTs: NOW - 8 * DAY - HOUR }),
    ],
    agents: [
      rec('aaaa0001', { sessionId: 'cccc3333-agents', firstTs: NOW - 3 * DAY - 10 * MIN, lastTs: NOW - 3 * DAY }),
      rec('aaaa0002', { sessionId: 'dddd4444-expired', firstTs: NOW - 8 * DAY - 10 * MIN, lastTs: NOW - 8 * DAY }),
    ],
  })
  // 1.6 N6: named by the first line, as a weekday and a clock time within six days. 1.7 F2 (pinned
  // and changed): neither is active — an hour and three days quiet —, so both are in the group of
  // earlier sessions, in the same order.
  assert.deepEqual(vm.roots.map((r) => r.label), ['Earlier sessions (2)'])
  assert.deepEqual(sessionsOf(vm).map((r) => r.label), ['Session Tue 10:00 · aaaa1111', 'Session Sat 11:00 · cccc3333'])
  assert.equal(vm.omittedRoots, 0)
  assert.deepEqual(sessionsOf(vm)[1].children.map((c) => c.key), [agentKey('aaaa0001')])
})

test('at most MAX_ROOTS sessions are listed, the newest, and the rest is counted', () => {
  // 1.7 F2 (pinned and changed): the cap on the active sessions — every one of them active; the
  // cap inside the group of earlier sessions is the F2 test's.
  const mains = activeMains(MAX_ROOTS + 5)
  const vm = build({ mains })
  assert.equal(vm.roots.length, MAX_ROOTS)
  assert.equal(vm.omittedRoots, 5)
  assert.deepEqual(vm.roots.map((r) => r.lastTs), mains.slice(0, MAX_ROOTS).map((m) => m.lastTs))
  // Leaving sessions out takes nothing from the sessions that are listed.
  assert.ok(vm.roots.every((r) => r.childrenMore === 0), 'a listed session lost children for the ones left out')
})

// ---------------------------------------------------------------------------
// §4.5 · placement
// ---------------------------------------------------------------------------

test('a nested agent sits under the agent that spawned it, found by its spawner file or its launch', () => {
  const vm = build({
    agents: [
      rec('aaaa0001', { firstTs: NOW - 30 * MIN }),
      rec('aaaa0003', { spawnerFile: null, firstTs: NOW - 10 * MIN, meta: { agentType: 'Plan', model: null, spawnDepth: 2, toolUseId: 'toolu_x3', parentAgentId: null } }),
      rec('aaaa0002', { spawnerFile: agentFile('aaaa0001'), firstTs: NOW - 20 * MIN }),
    ],
    launches: [launch('x3', { agentId: null, file: agentFile('aaaa0001') })],
  })
  const root = vm.roots[0]
  assert.deepEqual(root.children.map((c) => c.key), [agentKey('aaaa0001')])
  // Children by when they started, the newest first (1.6 N6, pinned and changed: 1.5 put the
  // oldest first), whatever order the records came in.
  assert.deepEqual(root.children[0].children.map((c) => c.key), [agentKey('aaaa0003'), agentKey('aaaa0002')])
})

test('a spawner cycle, a self-spawn and a spawner in another session all end at the session, each node once', () => {
  const vm = build({
    agents: [
      rec('bbbb0001', { spawnerFile: agentFile('bbbb0002'), firstTs: NOW - 30 * MIN }),
      rec('bbbb0002', { spawnerFile: agentFile('bbbb0001'), firstTs: NOW - 29 * MIN }),
      rec('cccc0001', { spawnerFile: agentFile('cccc0001'), firstTs: NOW - 28 * MIN }),
      rec('ffff0001', { sessionId: S2 }),
      rec('ffff0002', { spawnerFile: agentFile('ffff0001', S2), firstTs: NOW - 27 * MIN }),
    ],
    mains: [main(), main({ sessionId: S2, lastTs: NOW - 3 * MIN })],
  })
  const keys = all(vm.roots).map((n) => n.key)
  assert.equal(new Set(keys).size, keys.length, 'a node appeared twice')
  assert.equal(keys.length, 2 + 5)
  const s1 = vm.roots.find((r) => r.key === rootKey)
  assert.ok(s1)
  // The cycle is broken at the edge that closed it: one of the two hangs under the other.
  const top = s1.children.filter((c) => c.key === agentKey('bbbb0001') || c.key === agentKey('bbbb0002'))
  assert.equal(top.length, 1)
  assert.equal(top[0].children.length, 1)
  assert.equal(parentOf(vm, agentKey('cccc0001'))?.key, rootKey)
  assert.equal(parentOf(vm, agentKey('ffff0002'))?.key, rootKey)
})

test('no node sits deeper than MAX_TREE_DEPTH; a deeper agent moves up to its session', () => {
  const ids = Array.from({ length: MAX_TREE_DEPTH + 2 }, (_, i) => `dead${String(i).padStart(4, '0')}`)
  const agents = ids.map((id, i) => rec(id, {
    firstTs: NOW - 50 * MIN + i * MIN,
    spawnerFile: i === 0 ? sessionFile() : agentFile(ids[i - 1]),
  }))
  const vm = build({ agents: [...agents].reverse() })
  const d = depths(vm)
  assert.equal(Math.max(...d.values()), MAX_TREE_DEPTH)
  assert.deepEqual(ids.map((id) => d.get(agentKey(id))), [1, 2, 3, 4, 5, 6, 1, 2])
  assert.equal(all(vm.roots).length, 1 + ids.length, 'the cap moves nodes, it drops none')
})

test('a run keeps its own agents, even one another agent launched', () => {
  const vm = build({
    agents: [
      rec('eeee0001'),
      wfRec('eeee0002', { spawnerFile: agentFile('eeee0001') }),
      wfRec('eeee0003', { spawnerFile: agentFile('eeee0002', S1, WF), firstTs: NOW - 20 * MIN }),
    ],
  })
  assert.equal(parentOf(vm, agentKey('eeee0002'))?.key, wfKey)
  // Inside the run, a nested agent still sits under its spawner.
  assert.equal(parentOf(vm, agentKey('eeee0003'))?.key, agentKey('eeee0002'))
  assert.equal(depths(vm).get(agentKey('eeee0003')), 3)
})

// ---------------------------------------------------------------------------
// §4.5 · labels, usage, duration
// ---------------------------------------------------------------------------

// 1.6 N6 (pinned and changed): the row's name carries the model in its short form, without the
// `claude-` every Claude model id starts with; `fullLabel` keeps the whole id for the details, the
// markdown and a screen reader. The session is named by its first line (see the next tests).
test('an agent is named by its type, its last model through the model-name helper — short on the row, whole in full — and its short id', () => {
  const vm = build({
    agents: [
      // Claude Code's own shape, `a` + 16 hex: the `a` every id carries is left off the name.
      rec('a94f3c2e10b7d5e19', { models: ['claude-opus-5'] }),
      rec('abcd0001', { models: ['claude-sonnet-5', 'claude-opus-5[1m]'] }),
      rec('bcde0002', { models: ['claude-haiku-4-5-20251001'] }),
      rec('cdef0003', { models: [] }),
      rec('def00004', { models: [], meta: null }),
      rec('ef000005', { models: [], meta: null, spawnerFile: null }),
      rec('f0000006', { models: ['claude-sonnet-5', '<synthetic>'] }),
    ],
    launches: [launch('def00004', { typeHint: 'Plan', modelHint: 'sonnet' }),
      launch('pppp0001', { agentId: null, typeHint: 'Plan', modelHint: 'claude-sonnet-5', ts: NOW - 2 * MIN })],
  })
  const label = (id: string): string => node(vm, agentKey(id)).label
  const full = (id: string): string => node(vm, agentKey(id)).fullLabel
  assert.equal(label('a94f3c2e10b7d5e19'), 'Explore · opus-5 · 94f3')
  assert.equal(full('a94f3c2e10b7d5e19'), 'Explore · claude-opus-5 · 94f3')
  // Any other id is taken as it is: four characters, since no other id of the session shares them.
  assert.equal(label('abcd0001'), 'Explore · opus-5 · abcd')
  assert.equal(full('abcd0001'), 'Explore · claude-opus-5 · abcd')
  // A placeholder no model wrote is not the agent's model.
  assert.equal(label('f0000006'), 'Explore · sonnet-5 · f000')
  assert.equal(label('bcde0002'), 'Explore · haiku-4-5 · bcde')
  assert.equal(full('bcde0002'), 'Explore · claude-haiku-4-5 · bcde')
  // No real model seen yet: the alias the sidecar or the launch asked for — no prefix to leave off.
  assert.equal(label('cdef0003'), 'Explore · opus · cdef')
  assert.equal(full('cdef0003'), 'Explore · opus · cdef')
  assert.equal(label('def00004'), 'Plan · sonnet · def0')
  assert.equal(label('ef000005'), 'Agent · – · ef00')
  assert.equal(full('ef000005'), 'Agent · – · ef00')
  // A launch's hint the same way: short on the row, whole in full.
  const pending = node(vm, 'l:toolu_pppp0001')
  assert.deepEqual([pending.label, pending.fullLabel], ['Plan · sonnet-5 · launched', 'Plan · claude-sonnet-5 · launched'])
  // The details' title and Models row keep the whole id.
  const d = agentDetails(input({ agents: [rec('a94f3c2e10b7d5e19', { models: ['claude-opus-5'] })] }), NOW, agentKey('a94f3c2e10b7d5e19'))
  assert.equal(d?.title, 'Explore · claude-opus-5 · 94f3')
  assert.equal(d?.rows.find((r) => r.label === 'Models')?.value, 'claude-opus-5')
  assert.equal(vm.roots[0].label, 'Session Tue 10:00 · 9d0eb37a')
  assert.equal(vm.roots[0].fullLabel, vm.roots[0].label)
})

test('usage is the billable tokens of the tables, a dash when nothing was counted, and a lower bound is flagged', () => {
  const vm = build({
    mains: [main({ outputFinal: 11 })],
    agents: [
      rec('aaaa0001'),
      rec('aaaa0002', { requests: 0, outputFinal: 0, input: 0, cacheWrite: 0, output: 0, cacheRead: 0, reasoning: 0 }),
      rec('aaaa0003', { outputFinal: 4 }),
    ],
  })
  const a = node(vm, agentKey('aaaa0001'))
  // 300 fresh input + 200 cache write + 700 output; the 5 000 cache reads are not usage.
  assert.equal(a.usage, '1.2K')
  assert.equal(a.lowerBound, false)
  assert.equal(a.duration, '29 min 00 s')
  assert.deepEqual([a.startTs, a.lastTs], [NOW - 30 * MIN, NOW - 1 * MIN])
  assert.equal(node(vm, agentKey('aaaa0002')).usage, '–')
  assert.equal(node(vm, agentKey('aaaa0003')).lowerBound, true)
  const root = vm.roots[0]
  assert.equal(root.usage, '3.5K')
  assert.equal(root.lowerBound, true)
  assert.equal(root.duration, '1 h 58 min')
})

test('a session carries its project label only while attribution is on and the table knows it', () => {
  const rowsOf = (over: Partial<AgentTreeInput>) => {
    const vm = build(over)
    return { sub: vm.roots[0].sub, rows: agentDetails(input(over), NOW, vm.roots[0].key)?.rows ?? [] }
  }
  const on = rowsOf({ attribution: 'project', sessions: [sessionRec()] })
  assert.equal(on.sub, 'alpha')
  // After the two usage figures of D5, which lead a session's details.
  assert.deepEqual(on.rows.map((r) => r.label).slice(0, 3), ['Own transcript', 'Project', 'Models'])
  assert.deepEqual(on.rows.find((r) => r.label === 'Project'), { label: 'Project', value: 'alpha' })

  const off = rowsOf({ attribution: 'none', sessions: [sessionRec()] })
  assert.equal(off.sub, null)
  assert.equal(off.rows.some((r) => r.label === 'Project'), false)

  // A subagent's row or another provider's session with the same id is not this session.
  const others = rowsOf({
    attribution: 'session',
    sessions: [sessionRec({ isSub: true, project: 'b2b2b2b2b2b2' }), sessionRec({ source: 'codex', project: 'c3c3c3c3c3c3' })],
  })
  assert.equal(others.sub, null)
  assert.deepEqual(others.rows.find((r) => r.label === 'Project'), { label: 'Project', value: '–' })
})

// ---------------------------------------------------------------------------
// §4.5 · caps
// ---------------------------------------------------------------------------

// 1.6 P3a (§3 D3): replaces 1.5's 'MAX_NODES cuts the tree but keeps every session, the running
// agents and the open node'. There is no cut any more: the page carries only what is open, an
// open node at most fifty children at a time, and the payload at most MAX_PAGE_NODES nodes.

/** A Claude Code agent id: `a` and 16 hex digits, the n-th of a series. */
function hexId(n: number): string {
  return `a${n.toString(16).padStart(16, '0')}`
}

/**
 * The ideas round's large run, in one session: 427 agents, 164 of them with a transcript and 263
 * its journal started without one — drawn in one collector, the run's last child (1.6 P5b, D4),
 * so the run has 165 children. The records started a minute
 * apart five hours ago, so they are drawn in the reverse order of their number — the newest first
 * (1.6 N6); 150 completed, 12 failed, 2 open; of the journal-only ones all but 8 completed. `extra`
 * more journal-only agents join the run, completed; `running` lets the first record — the oldest,
 * drawn last — write a minute ago.
 */
function bigWorld(extra = 0, o: { running?: boolean } = {}): { over: Partial<AgentTreeInput>; ids: string[] } {
  const ids = Array.from({ length: 164 }, (_, i) => hexId(i))
  const agents = ids.map((id, i) => wfRec(id, {
    firstTs: NOW - 5 * HOUR + i * MIN,
    lastTs: o.running === true && i === 0 ? NOW - MIN : NOW - 5 * HOUR + i * MIN + 30_000,
  }))
  // With `running`, the first record is open in the journal too, so it runs by its fresh line.
  const journal = [
    ...ids.map((id, i) => jagent(id, { step: i + 1,
      outcome: o.running === true && i === 0 ? null : i < 150 ? 'completed' : i < 162 ? 'failed' : null })),
    ...Array.from({ length: 263 + extra }, (_, j) =>
      jagent(hexId(0x10000 + j), { step: 1000 + j, outcome: j < 8 ? null : 'completed' })),
  ]
  // The journal last changed half an hour ago: its open members are unknown, not running.
  return { over: { agents, runs: [run(journal)] }, ids }
}

test('only what is open goes to the page: a closed run of 427 agents is one session row, however many it gains', () => {
  const { over } = bigWorld()
  const vm = page(over)
  // The session alone — closed, so not even its run is in the payload — and what it holds.
  assert.deepEqual(vm.roots.map((r) => r.key), [rootKey])
  const root = vm.roots[0]
  assert.deepEqual(root.children, [])
  assert.deepEqual([root.hasChildren, root.childrenTotal, root.childrenMore], [true, 1, 0])
  assert.equal(root.agentCount, 427)
  assert.deepEqual(root.tally, { started: 427, done: 405, failed: 12, retried: 0, stopped: 0, running: 0, unknown: 10 })
  assert.equal(root.tallyText, '427 started · 405 ✓ · 12 ✕ · ~10 ?')
  // The ideas round measured 77.8 KB for this run's payload; closed it is the session's row.
  const size = JSON.stringify(vm).length
  assert.ok(size <= 4096, `the closed tree is ${size} bytes`)
  // A hundred more agents in the closed run change its counts, not the payload's size: nothing
  // of the run is in it. (Emitting the children of a closed node fails here.)
  const grown = page(bigWorld(100).over)
  assert.equal(grown.roots[0].tallyText, '527 started · 505 ✓ · 12 ✕ · ~10 ?')
  assert.equal(JSON.stringify(grown).length, size)
  // Opened, the session shows its run — closed in turn, with its own counts: its 164 agents and
  // the collector of its 263 without a counted reply (1.6 P5b, D4: pinned 164 children before).
  const opened = page({ ...over, expanded: [rootKey] })
  const w = node(opened, wfKey)
  assert.deepEqual([w.children.length, w.hasChildren, w.childrenTotal, w.childrenMore, w.agentCount],
    [0, true, 165, 0, 427])
  assert.equal(w.tallyText, root.tallyText)
})

test('an opened run shows fifty agents, the running and the selected one pinned in, and counts the rest', () => {
  const { over, ids } = bigWorld(0, { running: true })
  // 1.6 N6 (pinned and changed): the window takes the children in the page's order, the newest
  // first — so the selected and the running agent are old ones here, far past the first fifty.
  const picked = agentKey(ids[20])
  const live = agentKey(ids[0])
  const vm = page({ ...over, expanded: [rootKey, wfKey], selected: picked })
  const w = node(vm, wfKey)
  assert.equal(w.children.length, MAX_GROUP_CHILDREN)
  assert.equal(w.childrenTotal, 165)
  assert.equal(w.childrenMore, w.childrenTotal - MAX_GROUP_CHILDREN)
  const newest = [...ids].reverse().map(agentKey)
  // The first 47 in the order the page draws them, the three pinned ones in their own places —
  // 1.6 P5b (D4): the collector is pinned too, always last (pinned 48 and the two before).
  assert.deepEqual(w.children.map((c) => c.key), [...newest.slice(0, 47), picked, live, collectorKey])
  assert.equal(node(vm, live).state, 'running')
  assert.equal(vm.selected?.key, picked)
  assert.equal(vm.note, null)
  // The agents shown are leaves here: nothing below them, nothing more to say — nor has the
  // collector, which counts its members and lists none.
  for (const c of w.children) assert.deepEqual([c.hasChildren, c.childrenTotal, c.childrenMore], [false, 0, 0], c.key)
  // Without a selection and nothing running, the window is the first forty-nine and the collector.
  const plain = page({ ...bigWorld().over, expanded: [rootKey, wfKey] })
  assert.deepEqual(node(plain, wfKey).children.map((c) => c.key),
    [...[...ids].reverse().slice(0, MAX_GROUP_CHILDREN - 1).map(agentKey), collectorKey])
})

test('each "more" step shows fifty children more, at most MAX_MORE_PAGES steps; the counts follow', () => {
  const { over, ids } = bigWorld()
  const shown = (pages: number): TreeNode => node(page({ ...over, expanded: [rootKey, wfKey], more: [{ key: wfKey, pages }] }), wfKey)
  // 1.6 P5b (D4): 164 agents and the collector (pinned 64, 14 and 164 before).
  assert.deepEqual([shown(1).children.length, shown(1).childrenMore], [100, 65])
  assert.deepEqual([shown(2).children.length, shown(2).childrenMore], [150, 15])
  assert.deepEqual([shown(3).children.length, shown(3).childrenMore], [165, 0])
  assert.deepEqual(shown(3).children.map((c) => c.key), [...[...ids].reverse().map(agentKey), collectorKey])
  // A group of 600: the last step shows 550, and the rest stays counted.
  const crowd = Array.from({ length: 600 }, (_, i) => rec(hexId(i), {
    firstTs: NOW - 5 * HOUR + i * 1000, lastTs: NOW - 2 * HOUR, outcome: 'completed', outcomeTs: NOW - 2 * HOUR,
  }))
  const at = (pages: number): TreeNode => page({ agents: crowd, expanded: [rootKey], more: [{ key: rootKey, pages }] }).roots[0]
  const last = MAX_GROUP_CHILDREN * (1 + MAX_MORE_PAGES)
  assert.deepEqual([at(MAX_MORE_PAGES).children.length, at(MAX_MORE_PAGES).childrenMore], [last, 600 - last])
  // A stored count beyond the last step is held to it; a broken one counts as none.
  assert.equal(at(MAX_MORE_PAGES + 5).children.length, last)
  for (const pages of [0, -3, 1.5, Number.NaN]) assert.equal(at(pages).children.length, MAX_GROUP_CHILDREN, String(pages))
  // Steps of a closed node show nothing: the node is closed.
  const closed = page({ agents: crowd, expanded: [], more: [{ key: rootKey, pages: 3 }] }).roots[0]
  assert.deepEqual([closed.children.length, closed.childrenMore], [0, 0])
  // The markdown's tree opens every node with fifty children, whatever the steps say.
  const doc = build({ agents: crowd, more: [{ key: rootKey, pages: 3 }] }).roots[0]
  assert.deepEqual([doc.children.length, doc.childrenMore], [MAX_GROUP_CHILDREN, 600 - MAX_GROUP_CHILDREN])
})

test('when the pinned children alone are more than the window, the path to the selection comes first, then the running in order', () => {
  const runningOnes = Array.from({ length: 60 }, (_, i) => rec(hexId(i), { firstTs: NOW - 40 * MIN + i * 1000, lastTs: NOW - MIN }))
  // Started first and finished: in the order — the newest first (1.6 N6) — it would be the 61st.
  const picked = rec(hexId(100), { firstTs: NOW - 50 * MIN, lastTs: NOW - 45 * MIN, outcome: 'completed', outcomeTs: NOW - 45 * MIN })
  const vm = page({ agents: [...runningOnes, picked], expanded: [rootKey], selected: agentKey(picked.agentId) })
  const root = vm.roots[0]
  assert.equal(root.children.length, MAX_GROUP_CHILDREN)
  // The selection's path first, then the running ones in the page's order, the newest of them.
  assert.deepEqual(root.children.map((c) => c.key),
    [...[...runningOnes].reverse().slice(0, MAX_GROUP_CHILDREN - 1).map((r) => agentKey(r.agentId)), agentKey(picked.agentId)])
  assert.equal(root.childrenMore, 61 - MAX_GROUP_CHILDREN)
  assert.equal(vm.selected?.key, agentKey(picked.agentId))
  // The running list still names every running agent the window left out.
  assert.equal(vm.running, 60)
  assert.equal(vm.runningNow.length + vm.runningMore, 60)
})

test('MAX_PAGE_NODES: the selection\'s path and the running first, and an opened node that no longer fits ships none and says so', () => {
  // One session, 42 runs of 50 agents, every node opened: 1 + 42 + 42 × 50 nodes would be 2143.
  const runs = 42
  const wfOf = (i: number): string => `wf_${String(i).padStart(8, '0')}-000`
  const agents = Array.from({ length: runs * 50 }, (_, n) => wfRec(hexId(n), {
    workflowId: wfOf(Math.floor(n / 50)),
    firstTs: NOW - 5 * HOUR + n * 1000, lastTs: NOW - 2 * HOUR, outcome: 'completed', outcomeTs: NOW - 2 * HOUR,
  }))
  const runKey = (i: number): string => `w:${S1}|${wfOf(i)}`
  const expanded = [rootKey, ...Array.from({ length: runs }, (_, i) => runKey(i))]
  const shipped = (vm: AgentTreeVm): number[] => vm.roots[0].children.map((w, i) => (w.children.length > 0 ? i : -1)).filter((i) => i >= 0)
  const vm = page({ agents, expanded })
  assert.ok(all(vm.roots).length <= MAX_PAGE_NODES, String(all(vm.roots).length))
  // In the order the page draws them — the newest run first (1.6 N6): run 41 on top, run 0 at the
  // bottom — 39 runs fit — 1 + 42 + 39 × 50 = 1993 — the last three not: the three oldest.
  assert.deepEqual(shipped(vm), Array.from({ length: 39 }, (_, i) => i))
  assert.equal(vm.roots[0].children[0].key, runKey(41))
  for (const i of [2, 1, 0]) {
    const w = node(vm, runKey(i))
    assert.deepEqual([w.children.length, w.childrenTotal, w.childrenMore, w.hasChildren], [0, 50, 50, true], runKey(i))
  }
  // The selected agent's run is placed first, so the cap never takes the selection away; a
  // running agent's run comes next. The runs the page draws first give way instead. (Both in the
  // oldest runs, drawn last: 41 and 40 in the page's order.)
  const picked = agentKey(hexId(0 * 50 + 7))
  const live = { ...agents[1 * 50 + 3], lastTs: NOW - MIN, outcome: null, outcomeTs: null }
  const both = page({ agents: agents.map((r, n) => (n === 1 * 50 + 3 ? live : r)), expanded, selected: picked })
  assert.ok(all(both.roots).length <= MAX_PAGE_NODES)
  assert.deepEqual(shipped(both), [...Array.from({ length: 37 }, (_, i) => i), 40, 41])
  assert.ok(all(both.roots).some((n) => n.key === picked))
  assert.equal(both.selected?.key, picked)
  assert.ok(all(both.roots).some((n) => n.key === agentKey(live.agentId)), 'the running agent is not on the page')
  // The selection comes before the running agents, too: with a running agent in each of the first
  // 39 runs the page draws, their runs alone would fill the page (1 + 42 + 39 × 50 nodes); the
  // selected agent's run is shipped first, and the last of the running agents' runs in the page's
  // order gives way instead.
  const busy = agents.map((r, n) => (n % 50 === 3 && n >= 3 * 50 ? { ...r, lastTs: NOW - MIN, outcome: null, outcomeTs: null } : r))
  const crowded = page({ agents: busy, expanded, selected: picked })
  assert.ok(all(crowded.roots).length <= MAX_PAGE_NODES)
  assert.deepEqual(shipped(crowded), [...Array.from({ length: 38 }, (_, i) => i), 41])
  assert.equal(crowded.selected?.key, picked)
  assert.equal(crowded.running, 39)
})

test('an opened node without children is ignored; a selected node inside a closed branch has no panel and no note', () => {
  const done = rec('aaaa0001', { outcome: 'completed', outcomeTs: NOW - MIN })
  const nested = rec('aaaa0002', { spawnerFile: agentFile('aaaa0001'), outcome: 'completed', outcomeTs: NOW - MIN })
  const over: Partial<AgentTreeInput> = { agents: [done, nested], selected: agentKey('aaaa0002') }
  // The session closed: the agent's row is nowhere on the page, and the panel waits for it.
  const closed = page(over)
  assert.deepEqual([closed.selected, closed.note], [null, null])
  // Its parent closed too, the session open: still hidden.
  const half = page({ ...over, expanded: [rootKey] })
  assert.deepEqual([half.selected, half.note], [null, null])
  assert.deepEqual(node(half, agentKey('aaaa0001')).children, [])
  // Both open: the row is there, and so is the panel.
  const open = page({ ...over, expanded: [rootKey, agentKey('aaaa0001')] })
  assert.equal(open.selected?.key, agentKey('aaaa0002'))
  // An opened key whose node has no children changes nothing.
  const leaf = page({ ...over, expanded: [rootKey, agentKey('aaaa0001'), agentKey('aaaa0002'), 'a:nothing'] })
  assert.deepEqual(leaf, open)
  const n = node(leaf, agentKey('aaaa0002'))
  assert.deepEqual([n.hasChildren, n.childrenTotal, n.childrenMore, n.children], [false, 0, 0, []])
  // The markdown's tree prints every node, so it has the details wherever the node sits.
  assert.equal(build(over).selected?.key, agentKey('aaaa0002'))
  // A running agent inside a closed branch has a row in the running list, and its panel.
  const running = page({ agents: [rec('aaaa0001')], selected: agentKey('aaaa0001') })
  assert.deepEqual(running.runningNow.map((r) => r.key), [agentKey('aaaa0001')])
  assert.equal(running.selected?.key, agentKey('aaaa0001'))
  // A node gone from the records still says so.
  assert.equal(page({ ...over, selected: agentKey('ffff0000') }).note, 'The selected node is no longer in the tree.')
})

test('running counts every running agent and launch, also on sessions beyond the list', () => {
  // 1.7 F2: every session active, so the oldest is beyond MAX_ROOTS rather than in the group.
  const mains = activeMains(MAX_ROOTS + 1)
  const oldest = mains[mains.length - 1].sessionId
  const vm = build({
    mains,
    agents: [
      rec('aaaa0001', { sessionId: oldest }),
      rec('aaaa0002', { sessionId: oldest, outcome: 'completed', outcomeTs: NOW - MIN }),
    ],
    launches: [launch('pppp0001', { agentId: null, file: sessionFile(mains[0].sessionId), ts: NOW - MIN })],
  })
  // The session with the running agent is the one left off the list, and still counts.
  assert.equal(vm.omittedRoots, 1)
  assert.equal(vm.running, 2)
})

// ---------------------------------------------------------------------------
// §4.5 · details, selection, notes
// ---------------------------------------------------------------------------

test("an agent's details: every row pre-formatted, dashes for absence, Claude Code's report only when there is one", () => {
  const over: Partial<AgentTreeInput> = {
    agents: [
      // 1.6 P9: the context of its newest request, and the two efforts its replies were written at.
      // 1.6 P13a (O3): one of its three tool calls came back as an error; the version that wrote it.
      rec('aaaa0001', { outputFinal: 4, lastContext: 5_480, effort: 'xhigh', efforts: ['high', 'xhigh'], toolErrors: 1, ccVersion: '2.1.281' }),
      rec('aaaa0002', { meta: null, spawnerFile: null, requests: 0, outputFinal: 0 }),
    ],
    launches: [launch('aaaa0001', { totals: { tokens: 123_456, durationMs: 65_000, toolUses: 7 } })],
  }
  const d = agentDetails(input(over), NOW, agentKey('aaaa0001'))
  assert.ok(d)
  // The two agents' ids share seven characters: the name carries the eight that keep them apart.
  assert.equal(d.title, 'Explore · claude-opus-5 · aaaa0001')
  assert.equal(d.state, 'running')
  assert.equal(d.id, 'aaaa0001')
  // 1.6 P9 (L2): the line under its state — what it used, how long, how many requests and calls.
  assert.equal(d.overview, '1.2K in 29 min 00 s · 5 requests · 3 tool calls')
  // Every row says how it is laid out — a figure unless it says otherwise — which row the page's
  // clock ticks in, and which one Copy ID copies: nothing is left to a guess from its words.
  // 1.6 P9 (L2, pinned and changed): the mix, the context it ended with and its pace first, its
  // effort after its models, "Turns" is "Requests".
  const all = 300 + 200 + 5000 + 700
  assert.deepEqual(d.rows, [
    {
      label: 'Token mix', value: 'fresh 5 % · cache write 3 % · cache read 81 % · output 11 %', kind: 'bar',
      parts: [
        { part: 'fresh', share: 300 / all, label: 'fresh 5 %' },
        { part: 'cacheWrite', share: 200 / all, label: 'cache write 3 %' },
        { part: 'cacheRead', share: 5000 / all, label: 'cache read 81 %' },
        { part: 'output', share: 700 / all, label: 'output 11 %' },
      ],
    },
    { label: 'Context at the end', value: '5.5K', note: "the last request's input, cache reads and writes" },
    // 1 200 in 29 minutes.
    { label: 'Per minute', value: '41' },
    { label: 'Type', value: 'Explore' },
    { label: 'Models', value: 'claude-opus-5' },
    // N8: in the order its replies carried them.
    { label: 'Effort', value: 'high, then xhigh' },
    { label: 'ID', value: 'aaaa0001', copy: true },
    { label: 'Depth', value: '1' },
    { label: 'Started', value: '11:30' },
    { label: 'Duration', value: '29 min 00 s' },
    { label: 'Last activity', value: '11:59', note: '1 min ago', live: 'ago' },
    { label: 'Requests', value: '5' },
    { label: 'Usage', value: '1.2K' },
    { label: 'Fresh input', value: '300' },
    { label: 'Cache write 5m', value: '200' },
    { label: 'Cache write 1h', value: '–' },
    { label: 'Cache read', value: '5K' },
    // 1.6 D10: the note says how many replies are unfinished — one of the five here.
    { label: 'Output', value: '700', note: '⚠ lower bound — 1 of 5 replies unfinished' },
    { label: 'Reasoning', value: '50' },
    { label: 'Tool calls', value: '3' },
    // 1.6 P13a (O3, pinned and changed): how many of its tool calls failed, beside them.
    { label: 'Tool errors', value: '1 of 3 tool calls' },
    // 1.6 N6: the session by the name its row carries.
    { label: 'Spawned by', value: 'Session Tue 10:00 · 9d0eb37a' },
    { label: 'Workflow run', value: '–' },
    // 1.6 P13a (O3, pinned and changed): the Claude Code that wrote its transcript; no permission
    // mode, as an agent's transcript names none.
    { label: 'Claude Code version', value: '2.1.281' },
    // D9: Claude Code's own figures, named for what they are — the context of the last request
    // with its reply — and a sentence, which takes the whole width.
    { label: 'Report from Claude Code',
      value: 'context at the end 123.5K (incl. cache reads and the reply) · 1 min 05 s from the start · 7 tool calls',
      note: "Claude Code's own figure for this agent, never added to a total", kind: 'sentence' },
  ])

  // No sidecar, no launch, nothing counted: every figure is a dash, and no report is made up.
  const bare = agentDetails(input(over), NOW, agentKey('aaaa0002'))
  assert.ok(bare)
  const value = (label: string): string | undefined => bare.rows.find((r) => r.label === label)?.value
  assert.deepEqual(['Type', 'Depth', 'Requests', 'Usage', 'Output', 'Tool calls', 'Spawned by', 'Effort', 'Context at the end',
    'Claude Code version'].map(value),
  ['–', '–', '–', '–', '–', '–', '–', '–', '–', '–'])
  // 1.6 P13a (O3): nothing counted, no tool errors — neither a zero nor a dash of a count nobody made.
  assert.equal(bare.rows.some((r) => r.label === 'Tool errors'), false)
  // 1.6 P9: nothing counted, no mix, no pace, no line under the state.
  assert.deepEqual(bare.rows.filter((r) => ['Token mix', 'Per minute', 'Rank in run'].includes(r.label)), [])
  assert.equal(bare.overview, null)
  assert.equal(bare.rows.some((r) => r.label === 'Report from Claude Code'), false)
  assert.equal(bare.rows.some((r) => r.value === '0'), false, 'a zero where nothing was counted')

  // A report whose numbers are not numbers is no report.
  const broken = { ...over, launches: [launch('aaaa0001', { totals: { tokens: NaN, durationMs: 1, toolUses: 1 } })] }
  assert.equal(agentDetails(input(broken), NOW, agentKey('aaaa0001'))?.rows.some((r) => r.label === 'Report from Claude Code'), false)
})

test('a session and a run have details of their own', () => {
  const over: Partial<AgentTreeInput> = {
    agents: [
      rec('aaaa0001', { effort: 'xhigh', efforts: ['xhigh'] }),
      wfRec('bbbb0001', { effort: 'xhigh', efforts: ['xhigh'] }),
      wfRec('bbbb0002', { firstTs: NOW - 40 * MIN, effort: 'max', efforts: ['max'] }),
    ],
    launches: [launch('pppp0001', { agentId: null, ts: NOW - MIN })],
  }
  const s = agentDetails(input(over), NOW, rootKey)
  assert.ok(s)
  assert.equal(s.title, 'Session Tue 10:00 · 9d0eb37a')
  // 1.6 P9 (L2): no line under a session's state — it is an agent's.
  assert.equal(s.overview, null)
  // D5: its own figure and its agents' first, a first line and a span in place of a start and a
  // duration; the ID row last. 1.6 P9 (L2, pinned and changed): "Turns" is "Requests", the Usage
  // row that said the own figure a second time is gone, and its agents by effort follow their count.
  // 1.6 P13a (O3, pinned and changed): the Claude Code version that wrote its transcript before its ID —
  // a dash here, as the record names none; no permission mode and no compaction, as it has neither.
  assert.deepEqual(s.rows.map((r) => r.label), [
    'Own transcript', 'Agents, last 7 days', 'Models', 'Since first line', 'Span', 'Last activity', 'Requests',
    'Fresh input', 'Cache write 5m', 'Cache write 1h', 'Cache read', 'Output', 'Reasoning', 'Tool calls', 'Agents', 'Agents by effort',
    'Claude Code version', 'ID',
  ])
  const sv = (label: string): string | undefined => s.rows.find((r) => r.label === label)?.value
  // The session's own transcript only: 1 000 + 500 + 2 000; its agents are nodes of their own,
  // and their three records' 3 × 1 200 a figure of their own beside it, never added to it. N8: the
  // launch nobody has read a line of has no effort recorded.
  assert.deepEqual(['Own transcript', 'Agents, last 7 days', 'Models', 'Since first line', 'Span', 'Requests',
    'Cache write 5m', 'Tool calls', 'Agents', 'Agents by effort', 'ID'].map(sv),
  ['3.5K', '3.6K', 'claude-opus-5', '10:00', '1 h 58 min', '12', '400', '9', '4', 'xhigh 2 · max 1 · – 1', S1])
  assert.deepEqual(s.rows.find((r) => r.label === 'Agents, last 7 days'), {
    label: 'Agents, last 7 days', value: '3.6K', kind: 'sentence',
    note: 'not added to the own figure — the two cover different spans',
  })
  assert.equal(s.id, S1)
  assert.equal(s.rows.filter((r) => r.copy === true).length, 1)

  const w = agentDetails(input(over), NOW, wfKey)
  assert.ok(w)
  // 1.6 P9 (L2, pinned and changed): the tally, how many ran at once, its times and counts, its
  // agents by effort, its ID. 1.6 P13b (L4, pinned and changed): Claude Code's run record before
  // the ID — a dash here, as no journal of this run made a record to read.
  assert.equal(w.overview, null)
  assert.deepEqual(w.rows.map((r) => r.label), [
    'Agents', 'Parallelism', 'Started', 'Duration', 'Last activity', 'Requests', 'Usage', 'Fresh input', 'Cache write 5m',
    'Cache write 1h', 'Cache read', 'Output', 'Reasoning', 'Tool calls', 'Agents by effort', "Claude Code's run record", 'ID',
  ])
  assert.deepEqual(w.rows.find((r) => r.label === "Claude Code's run record"), { label: "Claude Code's run record", value: '–' })
  // A run's id is its directory's name, which the launch's result names too.
  assert.equal(w.id, WF)
  assert.deepEqual(w.rows[w.rows.length - 1], { label: 'ID', value: WF, copy: true })
  const wv = (label: string): string | undefined => w.rows.find((r) => r.label === label)?.value
  assert.deepEqual(['Agents', 'Parallelism', 'Started', 'Requests', 'Usage', 'Tool calls', 'Agents by effort'].map(wv),
    ['2 started, about 2 running', 'up to 2 at once', '11:20', '10', '2.4K', '6', 'max 1 · xhigh 1'])
})

// 1.6 P3a (§3.0 b, D3): pinned "a listed session's finished agent keeps its details, open branch or
// not: its row is in the payload, inside the closed session". A closed branch is not in the
// payload any more: its node gets its panel once the branch is open, and neither a panel nor the
// note before; the markdown's tree, which prints every node, has it wherever it sits.
test('the open node gets its details; a node that is gone leaves none and says so', () => {
  const agents = [rec('aaaa0001')]
  const open = build({ agents, selected: agentKey('aaaa0001') })
  assert.equal(open.selected?.key, agentKey('aaaa0001'))
  assert.equal(open.selected?.stateText, 'Running — inferred: the transcript changed 1 min ago and no result was recorded yet.')
  assert.equal(open.note, null)

  const gone = build({ agents, selected: agentKey('ffff0000') })
  assert.equal(gone.selected, null)
  assert.equal(gone.note, 'The selected node is no longer in the tree.')

  // A session beyond the list has no row on the page — not in the tree, and a session is never
  // in the running list — so its details are not open either: a panel nothing on the page can
  // close, coming back with every reload, is worse than saying why nothing shows.
  // 1.7 F2: every session active, so the oldest is beyond MAX_ROOTS rather than in the group.
  const mains = activeMains(MAX_ROOTS + 1)
  const oldest = mains[MAX_ROOTS].sessionId
  const beyondKey = `s:${oldest}`
  const beyond = build({ mains, selected: beyondKey })
  assert.equal(beyond.roots.some((r) => r.key === beyondKey), false, 'the session beyond the list is listed')
  assert.equal(beyond.selected, null)
  assert.equal(beyond.note, 'The selected node is no longer in the tree.')
  // …while its details can still be asked for directly.
  assert.equal(agentDetails(input({ mains }), NOW, beyondKey)?.title, 'Session Tue 11:00 · 00000020')

  // An agent of that session opens while it runs, because the running list has a row for it;
  // once it has finished it has none, and the panel gives way to the note — it does not stay
  // open with nothing on the page to close it.
  const far = agentKey('aaaa0001')
  const running = build({ mains, agents: [rec('aaaa0001', { sessionId: oldest })], selected: far })
  assert.equal(running.omittedRoots, 1)
  assert.deepEqual(running.runningNow.map((r) => r.key), [far])
  assert.equal(running.selected?.key, far)
  assert.equal(running.note, null)
  for (const outcome of ['completed', 'failed'] as const) {
    const finished = build({
      mains, agents: [rec('aaaa0001', { sessionId: oldest, outcome, outcomeTs: NOW - MIN })], selected: far,
    })
    assert.equal(finished.omittedRoots, 1)
    assert.deepEqual(finished.runningNow, [], outcome)
    assert.equal(finished.selected, null, `a ${outcome} agent of a session beyond the list kept its details`)
    assert.equal(finished.note, 'The selected node is no longer in the tree.', outcome)
  }
  // A listed session's finished agent: the markdown's tree has its details wherever it sits; the
  // page has them while the session is open, and neither the panel nor the note while it is closed.
  const finished: Partial<AgentTreeInput> = { agents: [rec('aaaa0001', { outcome: 'completed', outcomeTs: NOW - MIN })], selected: far }
  const listed = build(finished)
  assert.equal(listed.selected?.key, far)
  assert.equal(listed.selected?.state, 'done')
  assert.equal(listed.note, null)
  const shut = page(finished)
  assert.deepEqual([shut.selected, shut.note], [null, null])
  const opened = page({ ...finished, expanded: [rootKey] })
  assert.deepEqual([opened.selected?.key, opened.selected?.state, opened.note], [far, 'done', null])

  assert.equal(build({ agents }).note, null)
  assert.equal(build({ agents }).selected, null)
})

test('a running agent of a session beyond the list opens only while the running list names it', () => {
  // Every agent of the oldest session runs; the list holds the MAX_RUNNING_LIST that started
  // first, so the last one to start has a row nowhere on the page.
  // 1.7 F2: every session active, so the oldest is beyond MAX_ROOTS rather than in the group.
  const mains = activeMains(MAX_ROOTS + 1)
  const oldest = mains[MAX_ROOTS].sessionId
  const agents = Array.from({ length: MAX_RUNNING_LIST + 1 }, (_, i) =>
    rec(`b${String(i).padStart(7, '0')}`, { sessionId: oldest, firstTs: NOW - 40 * MIN + i * MIN }))
  const first = agentKey(agents[0].agentId)
  const last = agentKey(agents[MAX_RUNNING_LIST].agentId)
  const listedVm = build({ mains, agents, selected: first })
  assert.equal(listedVm.runningMore, 1)
  assert.equal(listedVm.runningNow.some((r) => r.key === last), false)
  assert.equal(listedVm.selected?.key, first)
  const unlisted = build({ mains, agents, selected: last })
  assert.equal(unlisted.selected, null)
  assert.equal(unlisted.note, 'The selected node is no longer in the tree.')
})

test('the details say for themselves whether the state was recorded and when the node last changed', () => {
  // Every kind and state of node: the details carry the node's own flag and last activity, so
  // the panel does not need the node's row to say "recorded" or to keep its clock.
  const over: Partial<AgentTreeInput> = {
    agents: [
      rec('aaaa0001'),
      rec('aaaa0002', { outcome: 'completed', outcomeTs: NOW - MIN }),
      rec('aaaa0003', { outcome: 'failed', outcomeTs: NOW - 2 * MIN }),
      rec('aaaa0004', { lastTs: NOW - 40 * MIN, firstTs: NOW - 50 * MIN }),
      wfRec('bbbb0001', { outcome: 'completed', outcomeTs: NOW - MIN }),
    ],
    launches: [launch('pppp0001', { agentId: null, ts: NOW - MIN })],
    mains: [main(), main({ sessionId: S2, lastTs: NOW - 3 * HOUR, firstTs: NOW - 4 * HOUR })],
  }
  const vm = build(over)
  // 1.7 F2 (pinned and changed): the idle session S2 is in the group of earlier sessions, which
  // is a container with no details of its own — every other node has them.
  assert.equal(vm.roots[vm.roots.length - 1].kind, 'group')
  assert.equal(agentDetails(input(over), NOW, EARLIER_KEY), null)
  const nodes = all(vm.roots).filter((n) => n.kind !== 'group')
  assert.deepEqual([...new Set(nodes.map((n) => n.state))].sort(), ['active', 'done', 'failed', 'idle', 'running', 'unknown'])
  for (const n of nodes) {
    const d = agentDetails(input(over), NOW, n.key)
    assert.ok(d, n.key)
    assert.equal(d.derived, n.derived, `${n.key} ${n.state}`)
    assert.equal(d.derived, n.state !== 'done' && n.state !== 'failed', n.key)
    assert.equal(d.lastTs, n.lastTs, n.key)
    // The same details as the view model's panel for that selection.
    assert.deepEqual(build({ ...over, selected: n.key }).selected, d, n.key)
  }
})

test('an empty tree says which absence it is', () => {
  const none = build({ mains: [] })
  assert.deepEqual(none.roots, [])
  assert.equal(none.note, 'No Claude Code session in the last 7 days.')
  assert.equal(none.running, 0)
  // No time of its own (D12): an unchanged tree is the same tree a push later. No cut either
  // (1.6 D3): every omission is said on the node it was made at.
  assert.equal('updatedAt' in none, false)
  assert.equal('truncated' in none, false)

  // A session two days ago that never ran an agent is not in the tree — but it was a session.
  const quiet = build({ mains: [main({ lastTs: NOW - 2 * DAY, firstTs: NOW - 2 * DAY - HOUR })] })
  assert.deepEqual(quiet.roots, [])
  assert.equal(quiet.note, 'No agent in the last 7 days, and no Claude Code session in the last 24 hours.')

  // With nothing to show the empty note wins over a stale selection.
  assert.equal(build({ mains: [], selected: rootKey }).note, 'No Claude Code session in the last 7 days.')
})

// ---------------------------------------------------------------------------
// Keys
// ---------------------------------------------------------------------------

test('node keys are the identifiers the records carry, in the documented shapes, and never a path', () => {
  const over: Partial<AgentTreeInput> = {
    agents: [rec('aaaa0001'), wfRec('bbbb0001')],
    launches: [launch('pppp0001', { agentId: null, ts: NOW - MIN })],
  }
  const keysOf = (vm: AgentTreeVm): string[] => all(vm.roots).map((n) => n.key).sort()
  const vm = build(over)
  assert.deepEqual(keysOf(vm), ['a:aaaa0001', 'a:bbbb0001', 'l:toolu_pppp0001', `s:${S1}`, `w:${S1}|${WF}`].sort())

  // A session without agents is its id as well.
  assert.equal(build().roots[0].key, rootKey)

  // No key names a directory, so neither the page nor the stored view state ever holds the
  // project's path — which the tree does not even show as a label while attribution is off.
  for (const k of keysOf(vm)) {
    assert.equal(/[\\/]/.test(k), false, k)
    assert.equal(k.includes('alpha'), false, k)
  }
})

test('keys stay short however deep the files lie, stay apart where names share a tail, and do not move', () => {
  const deep = path.join(path.sep, 'home', 'x'.repeat(120), '.claude', 'projects', `-home-${'y'.repeat(60)}`)
  const file = path.join(deep, `${S1}.jsonl`)
  assert.ok(file.length > MAX_AGENT_KEY_CHARS, 'the path alone is longer than any key may be')
  const long = (id: string, over: Partial<AgentRec> = {}): AgentRec =>
    rec(id, { sessionFile: file, spawnerFile: file, ...over })
  // Two agents of one type and one model whose ids start alike — which since 1.6 (D11) makes each
  // name carry as many characters as keep them apart — an id that ends like one of theirs, a run
  // and a launch, all in that deep session.
  const over: Partial<AgentTreeInput> = {
    agents: [long('aaaa0001'), long('aaaa0002', { input: 999 }), long('bbbb0001'), wfRec('cccc0001', { sessionFile: file })],
    launches: [launch('pppp0001', { agentId: null, file, ts: NOW - MIN })],
  }
  const vm = build(over)
  const keys = all(vm.roots).map((n) => n.key)
  assert.equal(keys.length, 1 + 4 + 1 + 1)
  for (const k of keys) assert.ok(k.length <= MAX_AGENT_KEY_CHARS, `${k.length}: ${k}`)
  assert.equal(new Set(keys).size, keys.length, 'two nodes share a key')
  assert.deepEqual([node(vm, agentKey('aaaa0001')).label, node(vm, agentKey('aaaa0002')).label],
    ['Explore · opus-5 · aaaa0001', 'Explore · opus-5 · aaaa0002'], 'the two rows read alike')

  // Stable: a later build and the records in another order give the same keys.
  const again = build({ ...over, agents: [...(over.agents ?? [])].reverse() }, NOW + 3 * MIN)
  assert.deepEqual(all(again.roots).map((n) => n.key).sort(), [...keys].sort())
  // A key selects its own node and no other: the one of the pair with 999 fresh input tokens.
  const picked = build({ ...over, selected: agentKey('aaaa0002') }).selected
  assert.equal(picked?.key, agentKey('aaaa0002'))
  assert.equal(picked?.rows.find((r) => r.label === 'Fresh input')?.value, '999')

  // An identifier that never passed the aggregator's 64-character cap still gets a key the
  // webview takes back, cut to its tail — and two such stay apart by where they differ.
  const huge = (tail: string): AgentRec => rec(`${'f'.repeat(300)}${tail}`)
  const cut = all(build({ agents: [huge('01'), huge('02')] }).roots).map((n) => n.key)
  for (const k of cut) assert.ok(k.length <= MAX_AGENT_KEY_CHARS, `${k.length}: ${k}`)
  assert.equal(new Set(cut).size, cut.length)
  assert.ok(cut.some((k) => k.startsWith('a:…') && k.endsWith('01')), cut.join('\n'))
})

// ---------------------------------------------------------------------------
// Purity and robustness
// ---------------------------------------------------------------------------

test('the tree is built from `now` alone — the builder never reads the clock', () => {
  const over: Partial<AgentTreeInput> = {
    agents: [rec('aaaa0001'), wfRec('bbbb0001')],
    launches: [launch('pppp0001', { agentId: null, ts: NOW - MIN })],
    selected: agentKey('aaaa0001'),
  }
  const withoutClock = <T>(run: () => T): T => {
    const clock = Date.now
    Date.now = () => { throw new Error('the agent tree read the clock') }
    try {
      return run()
    } finally {
      Date.now = clock
    }
  }
  const first = withoutClock(() => build(over))
  assert.ok(withoutClock(() => agentDetails(input(over), NOW, rootKey)))
  assert.deepEqual(build(over), first)
  // A minute later the same records are a minute older, and nothing else changed.
  const later = build(over, NOW + 20 * MIN)
  assert.equal(node(later, agentKey('aaaa0001')).state, 'unknown')
})

test('records a snapshot could carry wrong are skipped or read as nothing — never NaN, never a throw', () => {
  const vm = build({
    agents: [
      { ...rec('aaaa0001'), input: NaN, output: Infinity, models: undefined as unknown as string[] },
      { ...rec('aaaa0002'), lastTs: NaN },
      { ...rec('aaaa0003'), agentId: 42 as unknown as string },
      { ...rec('aaaa0004'), sessionFile: undefined as unknown as string },
      null as unknown as AgentRec,
    ],
    launches: [
      { ...launch('pppp0001', { agentId: null }), file: 7 as unknown as string },
      undefined as unknown as AgentLaunch,
    ],
    mains: [main(), { ...main({ sessionId: S2 }), lastTs: 'yesterday' as unknown as number }],
  })
  const nodes = all(vm.roots)
  assert.deepEqual(nodes.map((n) => n.key), [rootKey, agentKey('aaaa0001')])
  const a = nodes[1]
  // Only the cache write was a number: 200, and the alias stands in for the missing models.
  assert.equal(a.usage, '200')
  assert.equal(a.label, 'Explore · opus · aaaa')
  for (const n of nodes) {
    for (const v of [n.startTs, n.lastTs]) assert.ok(v === null || Number.isFinite(v))
  }
  assert.equal(JSON.stringify(vm).includes('NaN'), false)
})

// ---------------------------------------------------------------------------
// German
// ---------------------------------------------------------------------------

const GERMAN = JSON.parse(readFileSync(path.join(ROOT, 'l10n', 'bundle.l10n.de.json'), 'utf8')) as Record<string, string>

function german<T>(run: () => T): T {
  try {
    setBundle(GERMAN)
    setLocale('de')
    return run()
  } finally {
    setBundle(undefined)
    setLocale(undefined)
  }
}

test('the tree speaks German with the bundle the extension ships', () => {
  const over: Partial<AgentTreeInput> = {
    agents: [
      rec('aaaa0001', { outputFinal: 4, lastContext: 5_480, effort: 'xhigh', efforts: ['high', 'xhigh'] }),
      wfRec('bbbb0001', { lastTs: NOW - 30 * MIN, firstTs: NOW - 40 * MIN, effort: 'max', efforts: ['max'] }),
    ],
    launches: [launch('pppp0001', { agentId: null, typeHint: null, modelHint: null, ts: NOW - MIN })],
    // 1.6 P2b: the journal's result comes from the run, with no time.
    runs: [run([jagent('bbbb0001', { outcome: 'completed' })])],
    selected: agentKey('aaaa0001'),
  }
  const vm = german(() => build(over))
  // 1.6 N6: the German weekday words, the run a „Workflow-Lauf".
  assert.equal(vm.roots[0].label, 'Sitzung Di 10:00 · 9d0eb37a')
  assert.equal(node(vm, 'l:toolu_pppp0001').label, 'Agent · – · gestartet')
  assert.equal(node(vm, wfKey).label, 'Workflow-Lauf Di 11:20 · cfe7718d')
  assert.equal(vm.selected?.stateText,
    'Läuft — abgeleitet: Das Transkript hat sich vor 1 min geändert, und es wurde noch kein Ergebnis aufgezeichnet.')
  // 1.6 P9 (L2, pinned and changed): the mix, the context, the pace and the effort, „Anfragen" for "Turns".
  // 1.6 P13a (O3, pinned and changed): „Tool-Fehler" beside the tool calls, the version at the end.
  assert.deepEqual(vm.selected?.rows.map((r) => r.label), [
    'Token-Mischung', 'Kontext am Ende', 'Pro Minute', 'Typ', 'Modelle', 'Effort', 'ID', 'Tiefe', 'Beginn', 'Dauer',
    'Letzte Aktivität', 'Anfragen', 'Verbrauch', 'Frische Eingabe',
    'Cache-Schreiben 5m', 'Cache-Schreiben 1h', 'Cache-Lesen', 'Ausgabe', 'Denkschritte', 'Tool-Aufrufe', 'Tool-Fehler',
    'Gestartet von', 'Workflow-Lauf', 'Claude-Code-Version',
  ])
  assert.equal(vm.selected?.rows.find((r) => r.label === 'Tool-Fehler')?.value, '0 von 3 Tool-Aufrufen')
  const de = (label: string): DetailRow | undefined => vm.selected?.rows.find((r) => r.label === label)
  assert.equal(vm.selected?.overview, '1,2K in 29 min 00 s · 5 Anfragen · 3 Tool-Aufrufe')
  assert.equal(de('Token-Mischung')?.value, 'frisch 5 % · Cache-Schreiben 3 % · Cache-Lesen 81 % · Ausgabe 11 %')
  assert.deepEqual(de('Token-Mischung')?.parts?.map((p) => p.label), ['frisch 5 %', 'Cache-Schreiben 3 %', 'Cache-Lesen 81 %', 'Ausgabe 11 %'])
  assert.deepEqual([de('Kontext am Ende')?.value, de('Kontext am Ende')?.note], ['5,5K', 'Eingabe, Cache-Lesen und -Schreiben der letzten Anfrage'])
  assert.equal(de('Effort')?.value, 'high, dann xhigh')
  const runDe = german(() => agentDetails(input(over), NOW, wfKey))
  const rv = (label: string): string | undefined => runDe?.rows.find((r) => r.label === label)?.value
  assert.deepEqual([rv('Agenten'), rv('Parallelität'), rv('Agenten nach Effort'), rv('Anfragen')],
    ['1 gestartet, 1 fertig', 'bis zu 1 gleichzeitig', 'max 1', '5'])
  // The rank, in a run of two counted agents: the bigger one first.
  const two = { ...over, agents: [...(over.agents ?? []), wfRec('bbbb0002', { input: 3000 })] }
  assert.equal(german(() => agentDetails(input(two), NOW, agentKey('bbbb0001'))?.rows.find((r) => r.label === 'Platz im Lauf')?.value),
    '2 von 2 nach Verbrauch')
  // 1.6 D10: with how many replies are unfinished — one of the five.
  assert.equal(vm.selected?.rows.find((r) => r.label === 'Ausgabe')?.note, '⚠ Untergrenze — 1 von 5 Antworten unvollständig')
  // The figures in the reader's number format, too.
  assert.equal(vm.selected?.rows.find((r) => r.label === 'Verbrauch')?.value, '1,2K')
  assert.equal(german(() => agentDetails(input(over), NOW, agentKey('bbbb0001'))?.stateText),
    'Fertig — das Workflow-Journal hat das Ergebnis aufgezeichnet.')
  assert.equal(german(() => build({ ...over, selected: 'l:gone' })).note, 'Der ausgewählte Knoten ist nicht mehr im Baum.')
  assert.equal(german(() => build({ mains: [] })).note, 'Keine Claude-Code-Sitzung in den letzten 7 Tagen.')
})

test('the Compactions row writes its trigger inside one whole sentence per trigger, in English and German as 1.6 did (1.7 V-A)', () => {
  // 1.14 P2 (pinned and changed: the German „um {n}" before a clock stamp → a label or brackets — „zuletzt: 11:20" — §3 B2 rule 3).
  // 1.7 V-A: three templates — manual, auto, none recorded — instead of a bare `auto` / `manual`
  // spliced into one; the words on the page are 1.6's, character for character, in both languages.
  const at = NOW - 40 * MIN
  const compaction = (trigger: unknown, over: { preTokens?: number | null; postTokens?: number | null; at?: number } = {}) => ({
    at: over.at ?? at, trigger: trigger as 'manual' | 'auto' | null,
    preTokens: over.preTokens === undefined ? 167_200 : over.preTokens, postTokens: over.postTokens === undefined ? 12_400 : over.postTokens,
  })
  const sessionRow = (trigger: unknown): string | undefined =>
    agentDetails(input({ mains: [main({ compactions: 2, lastCompaction: compaction(trigger) })] }), NOW, rootKey)
      ?.rows.find((r) => r.label === 'Compactions' || r.label === 'Kompaktierungen')?.value
  const agentRow = (): string | undefined =>
    agentDetails(input({ agents: [rec('aaaa0001', {
      compactions: 1, lastCompaction: compaction('auto', { preTokens: 90_000, postTokens: null, at: NOW - 2 * DAY - 40 * MIN }),
    })] }), NOW, agentKey('aaaa0001'))?.rows.find((r) => r.label === 'Compactions' || r.label === 'Kompaktierungen')?.value
  assert.deepEqual(['manual', 'auto', null, 'forced'].map(sessionRow), [
    '2 · last at 11:20 (manual, 167.2K → 12.4K)',
    '2 · last at 11:20 (auto, 167.2K → 12.4K)',
    '2 · last at 11:20 (–, 167.2K → 12.4K)',
    // A trigger no line of Claude Code writes — a snapshot written by hand — is none recorded.
    '2 · last at 11:20 (–, 167.2K → 12.4K)',
  ])
  assert.equal(agentRow(), '1 · last at 2026-09-20 11:20 (auto, 90K → –)')
  assert.deepEqual(german(() => ['manual', 'auto', null, 'forced'].map(sessionRow)), [
    '2 · zuletzt: 11:20 (manuell, 167,2K → 12,4K)',
    '2 · zuletzt: 11:20 (automatisch, 167,2K → 12,4K)',
    '2 · zuletzt: 11:20 (–, 167,2K → 12,4K)',
    '2 · zuletzt: 11:20 (–, 167,2K → 12,4K)',
  ])
  assert.equal(german(agentRow), '1 · zuletzt: 2026-09-20 11:20 (automatisch, 90K → –)')
})

test('every message of the tree and of its markdown has a German entry, and the sentences are not English', () => {
  const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'l10n-extract.mjs'), '--json'],
    { cwd: ROOT, encoding: 'utf8' })
  assert.equal(r.status, 0, r.stderr)
  const keys = (JSON.parse(r.stdout) as { keys: Record<string, string[]> }).keys
  const ours = Object.keys(keys).filter((k) => keys[k].some((site) => site.startsWith('src/agentTreeBuild.ts:')))
  // The markdown's own words for the tree.
  const text = ['Agents', 'Running', 'Done', 'Failed', 'Stopped', 'Unknown', 'Active', 'Idle', 'State', '| Detail | Value |',
    // 1.6 D3: the line under a node the tree printed fifty children of; the cut's note is gone.
    '… {0} more', '{0} older session(s) not listed.',
    // 1.6 D10: the note's new words.
    '⚠ marks a lower bound: some replies were never marked finished, and only the output written up to then is counted.',
    // The running list above the tree, and the tree's own heading under it.
    'Running now', 'Sessions and agents', '(waiting)', 'No agent is running.', 'and {0} more']
  assert.ok(ours.length >= 30, `only ${ours.length} keys found in src/agentTreeBuild.ts`)
  // Words German takes over as they are.
  // 1.6 P9 (N8): "Effort" is German's word for it too (§6); "Turns" is gone ("Requests", „Anfragen").
  const same = new Set(['Agent', 'Effort', 'Workflow {0}', 'ID'])
  for (const k of [...ours, ...text]) {
    assert.ok(k in keys, `${JSON.stringify(k)} is not a t() key in src/`)
    const de = GERMAN[k]
    assert.ok(typeof de === 'string' && de.length > 0, `no German for ${JSON.stringify(k)}`)
    if (!same.has(k)) assert.notEqual(de, k, `still English: ${JSON.stringify(k)}`)
  }
})

// ---------------------------------------------------------------------------
// The roll-up: waiting on a running agent is not silence
// ---------------------------------------------------------------------------

test('an agent waiting on a running child runs, and a session with a running agent is active — both inferred', () => {
  const silent = { firstTs: NOW - 50 * MIN, lastTs: NOW - 40 * MIN }
  const over: Partial<AgentTreeInput> = {
    // The session itself quiet for half an hour.
    mains: [main({ lastTs: NOW - 30 * MIN })],
    agents: [
      // parent → child → grandchild; only the grandchild wrote lately.
      rec('aaaa0001', silent),
      rec('aaaa0002', { ...silent, spawnerFile: agentFile('aaaa0001'), meta: null }),
      rec('aaaa0003', { spawnerFile: agentFile('aaaa0002'), meta: null, lastTs: NOW - 1 * MIN }),
      // A recorded result stays a fact, whatever runs under it.
      rec('bbbb0001', { ...silent, outcome: 'completed', outcomeTs: NOW - 35 * MIN }),
      rec('bbbb0002', { spawnerFile: agentFile('bbbb0001'), meta: null, lastTs: NOW - 1 * MIN }),
      // Silent, with a silent child: unknown, as before.
      rec('cccc0001', silent),
      rec('cccc0002', { ...silent, spawnerFile: agentFile('cccc0001'), meta: null }),
    ],
  }
  const vm = build(over)
  assert.equal(parentOf(vm, agentKey('aaaa0003'))?.key, agentKey('aaaa0002'))
  assert.equal(parentOf(vm, agentKey('aaaa0002'))?.key, agentKey('aaaa0001'))
  const st = (id: string): string => node(vm, agentKey(id)).state
  assert.deepEqual(['aaaa0001', 'aaaa0002', 'aaaa0003', 'bbbb0001', 'bbbb0002', 'cccc0001', 'cccc0002'].map(st),
    ['running', 'running', 'running', 'done', 'running', 'unknown', 'unknown'])
  assert.equal(node(vm, agentKey('aaaa0001')).derived, true)
  const child = 'Running — inferred: a child agent of this agent is still running.'
  assert.equal(stateText(over, agentKey('aaaa0001')), child)
  assert.equal(stateText(over, agentKey('aaaa0002')), child)
  // The one that wrote keeps its own sentence.
  assert.match(stateText(over, agentKey('aaaa0003')) ?? '', /^Running — inferred: the transcript changed 1 min ago/)
  assert.match(stateText(over, agentKey('bbbb0001')) ?? '', /^Completed — /)
  // Four agents run: the host keeps polling for each.
  assert.equal(vm.running, 4)

  const root = vm.roots[0]
  assert.deepEqual([root.state, root.derived], ['active', true])
  assert.equal(stateText(over, rootKey), 'Active — inferred: an agent of this session is running.')
  // A session active on its own keeps its own sentence; one with nothing running stays idle.
  const own = { ...over, mains: [main({ lastTs: NOW - 2 * MIN })] }
  assert.equal(stateText(own, rootKey), 'Active — inferred: the session transcript changed 2 min ago.')
  const quiet = { mains: [main({ lastTs: NOW - 30 * MIN })], agents: [rec('cccc0001', silent)] }
  assert.equal(build(quiet).roots[0].state, 'idle')
  // A launch that runs counts as a running agent below, and a session never read is active
  // through its running agent.
  const launched = { mains: [main({ lastTs: NOW - 30 * MIN })], launches: [launch('pppp0001', { agentId: null, ts: NOW - MIN })] }
  assert.equal(build(launched).roots[0].state, 'active')
  assert.equal(build({ mains: [], agents: [rec('aaaa0003', { lastTs: NOW - MIN })] }).roots[0].state, 'active')
})

test('the roll-up speaks German', () => {
  const over: Partial<AgentTreeInput> = {
    mains: [main({ lastTs: NOW - 30 * MIN })],
    agents: [
      rec('aaaa0001', { firstTs: NOW - 50 * MIN, lastTs: NOW - 40 * MIN }),
      rec('aaaa0002', { spawnerFile: agentFile('aaaa0001'), meta: null, lastTs: NOW - MIN }),
    ],
  }
  german(() => {
    assert.equal(stateText(over, agentKey('aaaa0001')), 'Läuft — abgeleitet: Ein untergeordneter Agent dieses Agenten läuft noch.')
    assert.equal(stateText(over, rootKey), 'Aktiv — abgeleitet: Ein Agent dieser Sitzung läuft.')
  })
})

test('seconds under a minute are written in the page\'s own digits', () => {
  assert.equal(durationText(48_000), '48.0 s')
  assert.equal(durationText(1_450), '1.5 s')
  german(() => {
    assert.equal(durationText(48_000), '48,0 s')
    assert.equal(durationText(1_450), '1,5 s')
    assert.equal(durationText(125_000), '2 min 05 s')
  })
})

// ---------------------------------------------------------------------------
// 1.5.1 · what a closed node holds, and the running list
// ---------------------------------------------------------------------------

/** The keys of a tree's running items, in their order. */
function runningKeys(vm: AgentTreeVm): string[] {
  return vm.runningNow.map((r) => r.key)
}

// 1.6 P3a (§3 D3): pinned "on the tree before the cut"; the counts are taken on the whole tree —
// open or closed, inside a node's window or past it — and every node says whether it has children.
test('every node counts the agents and launches below it — never itself, never a run — on the whole tree', () => {
  const over: Partial<AgentTreeInput> = {
    agents: [
      rec('aaaa0001', { firstTs: NOW - 40 * MIN }),
      rec('aaaa0002', { spawnerFile: agentFile('aaaa0001'), firstTs: NOW - 35 * MIN }),
      wfRec('bbbb0001'),
      wfRec('bbbb0002', { firstTs: NOW - 20 * MIN }),
    ],
    launches: [launch('pppp0001', { agentId: null, file: agentFile('aaaa0001'), ts: NOW - MIN })],
  }
  const vm = build(over)
  const root = vm.roots[0]
  // Five agent-like nodes below the session: two agents, the launch under the first, the run's two.
  assert.equal(root.agentCount, 5)
  assert.equal(node(vm, agentKey('aaaa0001')).agentCount, 2, 'its nested agent and its launch')
  assert.equal(node(vm, wfKey).agentCount, 2)
  for (const k of [agentKey('aaaa0002'), agentKey('bbbb0001'), agentKey('bbbb0002'), 'l:toolu_pppp0001']) {
    assert.equal(node(vm, k).agentCount, 0, k)
  }
  // Whether a node has children and how many is its own, as the tree holds it.
  assert.deepEqual([root.hasChildren, root.childrenTotal], [true, 2], 'the first agent and the run')
  assert.deepEqual([node(vm, agentKey('aaaa0001')).hasChildren, node(vm, agentKey('aaaa0001')).childrenTotal], [true, 2])
  assert.deepEqual([node(vm, agentKey('aaaa0002')).hasChildren, node(vm, agentKey('aaaa0002')).childrenTotal], [false, 0])
  // A session without agents holds none.
  assert.equal(build().roots[0].agentCount, 0)
  assert.equal(build().roots[0].hasChildren, false)
  // The session closed on the page: no child in the payload, the same counts.
  const closed = page(over).roots[0]
  assert.deepEqual([closed.children, closed.agentCount, closed.hasChildren, closed.childrenTotal, closed.childrenMore],
    [[], 5, true, 2, 0])

  // A window of fifty: the payload carries fewer children than the session holds, and the count
  // still says how many there are.
  const many = Array.from({ length: 400 }, (_, i) => rec(`c${String(i).padStart(7, '0')}`, {
    firstTs: NOW - 5 * HOUR + i * 1000, lastTs: NOW - 2 * HOUR, outcome: 'completed', outcomeTs: NOW - 2 * HOUR,
  }))
  const cut = build({ agents: many })
  assert.equal(cut.roots[0].children.length, MAX_GROUP_CHILDREN)
  assert.equal(cut.roots[0].childrenTotal, 400)
  assert.equal(cut.roots[0].agentCount, 400)
})

test('the running list holds every running agent and launch, longest-running first, and nothing that is not running', () => {
  const over: Partial<AgentTreeInput> = {
    agents: [
      rec('aaaa0001', { firstTs: NOW - 20 * MIN }),
      rec('aaaa0002', { firstTs: NOW - 45 * MIN }),
      // The same start: the key decides, so the order never flickers between two pushes.
      rec('aaaa0004', { firstTs: NOW - 30 * MIN }),
      rec('aaaa0003', { firstTs: NOW - 30 * MIN }),
      rec('dddd0001', { outcome: 'completed', outcomeTs: NOW - MIN }),
      rec('eeee0001', { firstTs: NOW - 50 * MIN, lastTs: NOW - 40 * MIN }),
      wfRec('bbbb0001', { firstTs: NOW - 10 * MIN }),
      wfRec('bbbb0002', { outcome: 'failed', outcomeTs: NOW - 2 * MIN }),
    ],
    launches: [
      launch('pppp0001', { agentId: null, ts: NOW - 3 * MIN, typeHint: 'Plan', modelHint: 'sonnet' }),
      launch('pppp0002', { agentId: null, ts: NOW - 30 * MIN }),
    ],
  }
  const vm = build(over)
  assert.deepEqual(runningKeys(vm), [
    agentKey('aaaa0002'), agentKey('aaaa0003'), agentKey('aaaa0004'), agentKey('aaaa0001'), agentKey('bbbb0001'),
    'l:toolu_pppp0001',
  ])
  // Done, failed, unknown, the run, the session and a launch gone quiet are not in it.
  for (const k of [agentKey('dddd0001'), agentKey('bbbb0002'), agentKey('eeee0001'), 'l:toolu_pppp0002', wfKey, rootKey]) {
    assert.equal(runningKeys(vm).includes(k), false, k)
  }
  // Every item is a running node of the tree, named as the node is, its figures the node's.
  for (const r of vm.runningNow) {
    const n = node(vm, r.key)
    assert.equal(n.state, 'running', r.key)
    assert.deepEqual([r.kind, r.label, r.startTs, r.lastTs], [n.kind, n.label, n.startTs, n.lastTs], r.key)
    assert.equal(r.usage, n.kind === 'pending' ? '–' : n.usage, r.key)
  }
  // A launch nothing was counted of has a dash, never a zero.
  const pending = vm.runningNow.find((r) => r.kind === 'pending')
  assert.ok(pending)
  assert.deepEqual([pending.label, pending.usage], ['Plan · sonnet · launched', '–'])
  // The number the host polls by is the same count: listed plus left out.
  assert.equal(vm.running, vm.runningNow.length + vm.runningMore)
  assert.equal(vm.runningMore, 0)
  // Nothing runs, nothing is listed.
  const quiet = build({ agents: [rec('aaaa0001', { outcome: 'completed', outcomeTs: NOW - MIN })] })
  assert.deepEqual([quiet.runningNow, quiet.runningMore, quiet.running], [[], 0, 0])
  assert.deepEqual([build({ mains: [] }).runningNow, build({ mains: [] }).runningMore], [[], 0])
})

test('the running list stops at MAX_RUNNING_LIST and counts the rest, the longest-running kept', () => {
  const n = MAX_RUNNING_LIST + 5
  const agents = Array.from({ length: n }, (_, i) => rec(`f${String(i).padStart(7, '0')}`, {
    // The last one made started first: the order is the start, not the order of the records.
    firstTs: NOW - (i + 1) * MIN, lastTs: NOW - 30_000,
  }))
  const vm = build({ agents })
  assert.equal(vm.running, n)
  assert.equal(vm.runningNow.length, MAX_RUNNING_LIST)
  assert.equal(vm.runningMore, 5)
  assert.deepEqual(runningKeys(vm), agents.slice().reverse().slice(0, MAX_RUNNING_LIST).map((r) => agentKey(r.agentId)))
})

// 1.6 P3a (§3 D3): pinned "the nodes beyond the cut"; with the cut gone, the nodes the page does not
// carry are those of closed branches and those past a window — the list names them all the same.
test('the running list is taken from every session, those beyond the list, closed branches and full windows included', () => {
  // Beyond MAX_ROOTS: the oldest session is not listed, and its running agent still is.
  // 1.7 F2: every session active, so the oldest is beyond MAX_ROOTS rather than in the group.
  const mains = activeMains(MAX_ROOTS + 1)
  const oldest = mains[MAX_ROOTS].sessionId
  const far = build({ mains, agents: [rec('aaaa0001', { sessionId: oldest })] })
  assert.equal(far.omittedRoots, 1)
  assert.equal(all(far.roots).some((x) => x.key === agentKey('aaaa0001')), false, 'the agent is on the tree')
  assert.deepEqual(far.runningNow.map((r) => [r.key, r.context]), [[agentKey('aaaa0001'), 'Session 00000020']])
  // Its row opens its details like any other.
  const opened = build({ mains, agents: [rec('aaaa0001', { sessionId: oldest })], selected: agentKey('aaaa0001') })
  assert.equal(opened.selected?.key, agentKey('aaaa0001'))
  assert.equal(opened.selected?.stateText, 'Running — inferred: the transcript changed 1 min ago and no result was recorded yet.')
  assert.equal(opened.note, null)

  // A closed branch and a full window: the newer session's three hundred running agents are more
  // than its window holds, and the older session's one, which started first and so leads the
  // list, sits in a session the page has closed.
  const crowd = Array.from({ length: 300 }, (_, i) => rec(`c${String(i).padStart(7, '0')}`, {
    sessionId: S2, firstTs: NOW - 5 * MIN + i * 100, lastTs: NOW - 30_000,
  }))
  const early = rec('eeee0001', { firstTs: NOW - 30 * MIN })
  const over: Partial<AgentTreeInput> = {
    agents: [...crowd, early], mains: [main({ lastTs: NOW - 3 * MIN }), main({ sessionId: S2, lastTs: NOW - MIN })],
  }
  const vm = page({ ...over, expanded: [`s:${S2}`] })
  assert.equal(vm.roots[0].key, `s:${S2}`)
  assert.deepEqual([vm.roots[0].children.length, vm.roots[0].childrenMore], [MAX_GROUP_CHILDREN, 300 - MAX_GROUP_CHILDREN])
  assert.equal(all(vm.roots).some((x) => x.key === agentKey('eeee0001')), false, 'the closed session showed the early agent')
  assert.equal(vm.runningNow[0].key, agentKey('eeee0001'))
  assert.equal(vm.running, 301)
  assert.equal(vm.runningNow.length + vm.runningMore, vm.running)
  // The markdown's tree opens every node, and its list is the same.
  assert.deepEqual(build(over).runningNow, vm.runningNow)
})

test('a running item says where it sits: its session, its run, its project while attribution names one', () => {
  const over: Partial<AgentTreeInput> = {
    agents: [
      rec('aaaa0001', { firstTs: NOW - 20 * MIN }),
      wfRec('bbbb0001', { firstTs: NOW - 10 * MIN }),
      // Nested inside the run: the run is still where it sits.
      wfRec('bbbb0002', { spawnerFile: agentFile('bbbb0001', S1, WF), firstTs: NOW - 5 * MIN }),
    ],
    launches: [launch('pppp0001', { agentId: null, file: agentFile('bbbb0001', S1, WF), ts: NOW - 2 * MIN })],
    sessions: [sessionRec()],
  }
  // 1.6 N6 (pinned and changed): the session and the run by their ids — the id-only names, not the
  // names by start time the rows carry — and a run is a "Workflow run", as its row calls it.
  const contexts = (vm: AgentTreeVm): string[][] => vm.runningNow.map((r) => [r.key, r.context])
  assert.deepEqual(contexts(build({ ...over, attribution: 'project' })), [
    [agentKey('aaaa0001'), 'Session 9d0eb37a · alpha'],
    [agentKey('bbbb0001'), 'Session 9d0eb37a · Workflow run cfe7718d · alpha'],
    [agentKey('bbbb0002'), 'Session 9d0eb37a · Workflow run cfe7718d · alpha'],
    // A launch from inside the run sits in the run.
    ['l:toolu_pppp0001', 'Session 9d0eb37a · Workflow run cfe7718d · alpha'],
  ])
  // Attribution off: no project anywhere, the list included.
  assert.deepEqual(contexts(build({ ...over, attribution: 'none' })), [
    [agentKey('aaaa0001'), 'Session 9d0eb37a'],
    [agentKey('bbbb0001'), 'Session 9d0eb37a · Workflow run cfe7718d'],
    [agentKey('bbbb0002'), 'Session 9d0eb37a · Workflow run cfe7718d'],
    ['l:toolu_pppp0001', 'Session 9d0eb37a · Workflow run cfe7718d'],
  ])
  // In German, the words the tree's own labels use.
  assert.deepEqual(german(() => build({ ...over, attribution: 'none' })).runningNow.map((r) => r.context).slice(0, 2),
    ['Sitzung 9d0eb37a', 'Sitzung 9d0eb37a · Workflow-Lauf cfe7718d'])
})

test('an item waits when the roll-up made it running, and says so; one running by its own transcript does not', () => {
  const silent = { firstTs: NOW - 50 * MIN, lastTs: NOW - 40 * MIN }
  const vm = build({
    mains: [main({ lastTs: NOW - 30 * MIN })],
    agents: [
      // parent → child → grandchild; only the grandchild wrote lately.
      rec('aaaa0001', silent),
      rec('aaaa0002', { firstTs: NOW - 45 * MIN, lastTs: NOW - 40 * MIN, spawnerFile: agentFile('aaaa0001'), meta: null }),
      rec('aaaa0003', { firstTs: NOW - 35 * MIN, spawnerFile: agentFile('aaaa0002'), meta: null, lastTs: NOW - 1 * MIN }),
      // Running by its own clock, with a running child: not waiting.
      rec('cccc0001', { firstTs: NOW - 25 * MIN, lastTs: NOW - 2 * MIN }),
      rec('cccc0002', { firstTs: NOW - 20 * MIN, spawnerFile: agentFile('cccc0001'), meta: null }),
      // A recorded result stays a fact; its running child is listed, the parent is not.
      rec('bbbb0001', { firstTs: NOW - 15 * MIN, lastTs: NOW - 12 * MIN, outcome: 'completed', outcomeTs: NOW - 11 * MIN }),
      rec('bbbb0002', { firstTs: NOW - 14 * MIN, spawnerFile: agentFile('bbbb0001'), meta: null }),
    ],
  })
  assert.deepEqual(vm.runningNow.map((r) => [r.key, r.waiting]), [
    [agentKey('aaaa0001'), true],
    [agentKey('aaaa0002'), true],
    [agentKey('aaaa0003'), false],
    [agentKey('cccc0001'), false],
    [agentKey('cccc0002'), false],
    [agentKey('bbbb0002'), false],
  ])
  // The flag follows the sentence the details print.
  const d = agentDetails(input({
    mains: [main({ lastTs: NOW - 30 * MIN })],
    agents: [rec('aaaa0001', silent), rec('aaaa0002', { spawnerFile: agentFile('aaaa0001'), meta: null, lastTs: NOW - MIN })],
  }), NOW, agentKey('aaaa0001'))
  assert.equal(d?.stateText, 'Running — inferred: a child agent of this agent is still running.')
})

test('the running list carries no field the page does not need, and keys it can send back', () => {
  const vm = build({
    agents: [rec('aaaa0001'), wfRec('bbbb0001')],
    launches: [launch('pppp0001', { agentId: null, ts: NOW - MIN })],
  })
  assert.ok(vm.runningNow.length === 3)
  for (const r of vm.runningNow) {
    // 1.6 P5b (D4): `running`, the running agents an entry stands for — 1 here, a collector's many.
    // 1.6 P6: `lowerBoundText` (D10), the node's reason, and `silence` (N5), as the node's.
    // 1.6 P7: `fullLabel` (N6), the name with the whole model id, and the clock times of its start
    // and last activity for the static screen-reader words (N9). 1.6 P14b: `hookWait` (O4), the
    // agent hook's marker, as the node's — null here, no hook.
    assert.deepEqual(Object.keys(r).sort(),
      ['context', 'fullLabel', 'hookWait', 'key', 'kind', 'label', 'lastClock', 'lastTs', 'lowerBound', 'lowerBoundText', 'running', 'silence',
        'startClock', 'startTs', 'usage', 'waiting'])
    assert.equal(r.hookWait, null)
    assert.ok(r.key.length > 0 && r.key.length <= MAX_AGENT_KEY_CHARS, r.key)
    assert.equal(/[\\/]/.test(r.key + r.context), false, `${r.key} ${r.context}`)
    assert.ok(r.kind === 'agent' || r.kind === 'pending')
    assert.equal(r.running, 1)
    assert.equal(typeof r.waiting, 'boolean')
    assert.equal(typeof r.lowerBound, 'boolean')
  }
})

test("a running item carries its node's lower bound, and a launch nothing was counted of never does", () => {
  // A running agent may be mid-reply, so its output may be a lower bound — and the running list
  // is where it is looked at first.
  // 1.7 F2: every session active, so the oldest is beyond MAX_ROOTS rather than in the group.
  const mains = activeMains(MAX_ROOTS + 1)
  const oldest = mains[MAX_ROOTS].sessionId
  const vm = build({
    mains,
    agents: [
      rec('aaaa0001', { sessionId: mains[0].sessionId, outputFinal: 4 }),
      rec('aaaa0002', { sessionId: mains[0].sessionId, firstTs: NOW - 20 * MIN }),
      // Beyond the list: the running line is the only line this agent has.
      rec('aaaa0003', { sessionId: oldest, outputFinal: 2, firstTs: NOW - 10 * MIN }),
    ],
    launches: [launch('pppp0001', { agentId: null, file: sessionFile(mains[0].sessionId), ts: NOW - MIN })],
  })
  assert.equal(vm.omittedRoots, 1)
  const bounds = Object.fromEntries(vm.runningNow.map((r) => [r.key, r.lowerBound]))
  assert.deepEqual(bounds, {
    [agentKey('aaaa0001')]: true, [agentKey('aaaa0002')]: false, [agentKey('aaaa0003')]: true, 'l:toolu_pppp0001': false,
  })
  // The same flag as the node's, wherever the node is on the tree — and, 1.6 D10, the same reason.
  for (const r of vm.runningNow) {
    const n = all(vm.roots).find((x) => x.key === r.key)
    if (n) assert.deepEqual([r.lowerBound, r.lowerBoundText], [n.lowerBound, n.lowerBoundText], r.key)
  }
  assert.equal(vm.runningNow.find((r) => r.key === agentKey('aaaa0003'))?.lowerBoundText, '⚠ lower bound — 3 of 5 replies unfinished')
  assert.equal(vm.runningNow.find((r) => r.key === 'l:toolu_pppp0001')?.lowerBoundText, null)
})

// ---------------------------------------------------------------------------
// 1.6 P1 · D5 the session's own usage beside its agents', D6 writing on after an outcome,
// D11 short ids and the ID row
// ---------------------------------------------------------------------------

test('a session shows its own usage beside its agents\' — two figures, never their sum', () => {
  // 11.3M + 0.5M + 0.5M of its own; two agents of 68.0M + 0.4M + 0.3M each.
  const big = { input: 68_000_000, cacheWrite: 400_000, output: 300_000, cacheRead: 0, reasoning: 0 }
  const over: Partial<AgentTreeInput> = {
    mains: [main({ input: 11_300_000, cacheWrite: 500_000, output: 500_000 })],
    agents: [rec('aaaa0001', big), wfRec('bbbb0001', big)],
    selected: rootKey,
  }
  const vm = build(over)
  const root = vm.roots[0]
  assert.equal(root.usage, '12.3M')
  assert.equal(root.usageAgents, '137.4M')
  // Only a session carries the second figure.
  for (const n of all(vm.roots).slice(1)) assert.equal(n.usageAgents, null, n.key)
  // Nothing anywhere is the sum of the two: they cover different spans.
  const payload = JSON.stringify(vm)
  assert.equal(payload.includes('149.7M'), false, payload)
  assert.ok(payload.includes('"12.3M"') && payload.includes('"137.4M"'))
  const rows = vm.selected?.rows ?? []
  assert.deepEqual(rows.slice(0, 2), [
    { label: 'Own transcript', value: '12.3M' },
    { label: 'Agents, last 7 days', value: '137.4M', note: 'not added to the own figure — the two cover different spans', kind: 'sentence' },
  ])
  assert.equal(rows.some((r) => r.value === '149.7M'), false)

  // A session without agents has no agents figure — not a dash, none at all.
  const alone = build({ mains: [main()], selected: rootKey })
  assert.equal(alone.roots[0].usageAgents, null)
  assert.equal(alone.selected?.rows.some((r) => r.label === 'Agents, last 7 days'), false)
  // Agents whose records hold nothing counted: a dash, never a zero.
  const zero = { input: 0, cacheWrite: 0, cacheRead: 0, output: 0, reasoning: 0, requests: 0, outputFinal: 0 }
  assert.equal(build({ agents: [rec('aaaa0001', { ...zero, lastTs: NOW - 30 * MIN })] }).roots[0].usageAgents, '–')
  // Only the records of the last seven days are the agents' figure: an older one is gone.
  const old = rec('cccc0001', { ...big, lastTs: NOW - 8 * DAY, firstTs: NOW - 8 * DAY - HOUR })
  assert.equal(build({ ...over, agents: [rec('aaaa0001', big), old] }).roots[0].usageAgents, '68.7M')
})

test('a session\'s span is days and hours from 48 hours on, the hours floored; its details say since and span', () => {
  assert.equal(SPAN_IN_DAYS_FROM_MS, 48 * HOUR)
  assert.equal(spanText(22 * DAY + 11 * HOUR + 59 * MIN), '22 d 11 h')
  assert.equal(spanText(22.5 * DAY), '22 d 12 h')
  assert.equal(spanText(48 * HOUR), '2 d 0 h')
  assert.equal(spanText(48 * HOUR - MIN), '47 h 59 min')
  assert.equal(spanText(90_000), '1 min 30 s')
  assert.equal(spanText(0), '–')
  assert.equal(spanText(NaN), '–')
  const over: Partial<AgentTreeInput> = {
    mains: [main({ firstTs: NOW - (22 * DAY + 11 * HOUR + 59 * MIN) - 2 * MIN })],
    selected: rootKey,
  }
  const vm = build(over)
  assert.equal(vm.roots[0].duration, '22 d 11 h')
  const row = (label: string): string | undefined => vm.selected?.rows.find((r) => r.label === label)?.value
  assert.equal(row('Since first line'), '2026-08-30 23:59')
  assert.equal(row('Span'), '22 d 11 h')
  assert.equal(row('Started'), undefined, 'a session has a first line, not a start')
  assert.equal(row('Duration'), undefined)
  // An agent keeps its start and its duration.
  const a = agentDetails(input({ agents: [rec('aaaa0001')] }), NOW, agentKey('aaaa0001'))
  assert.deepEqual(a?.rows.filter((r) => ['Started', 'Duration'].includes(r.label)).map((r) => r.value), ['11:30', '29 min 00 s'])
})

test('an agent that writes on more than a minute after its recorded outcome is inferred again, and keeps the record', () => {
  // 1.14 P2 (pinned and changed: the German „um {n}" before a clock stamp → a label or brackets — „fertig (11:50)", „aufgezeichnet wurde (11:50)" — §3 B2 rule 3).
  assert.equal(RESUMED_AFTER_MS, 60_000)
  const at = NOW - 10 * MIN
  const after = (ms: number, over: Partial<AgentRec> = {}, lo: Partial<AgentLaunch> = {}): Partial<AgentTreeInput> => ({
    agents: [rec('aaaa0001', { outcome: 'completed', outcomeTs: at, lastTs: at + ms, ...over })],
    launches: [launch('aaaa0001', { outcome: 'completed', outcomeTs: at, ...lo })],
    selected: agentKey('aaaa0001'),
  })
  const state = (over: Partial<AgentTreeInput>): TreeNode => node(build(over), agentKey('aaaa0001'))
  const recorded = (over: Partial<AgentTreeInput>): string | undefined =>
    build(over).selected?.rows.find((r) => r.label === 'Recorded')?.value

  // 61 s after the outcome, within the running window: running, inferred, and it says why.
  const on = after(61_000)
  assert.deepEqual([state(on).state, state(on).derived], ['running', true])
  assert.equal(stateText(on, agentKey('aaaa0001')),
    'Running — inferred: the transcript changed 9 min ago, after an outcome was recorded at 11:50.')
  assert.equal(recorded(on), 'done at 11:50')
  // 59 s, and exactly 60 s: the tail of the same reply — the outcome stands. (A `>=` in place
  // of the `>` would revive the second one.)
  for (const ms of [59_000, 60_000]) {
    const same = after(ms)
    assert.deepEqual([state(same).state, state(same).derived], ['done', false], String(ms))
    assert.equal(stateText(same, agentKey('aaaa0001')), 'Completed — the parent recorded the result at 11:50.')
    assert.equal(recorded(same), undefined, 'a Recorded row without a revival')
  }
  // Written on, then silent past the window: unknown, and it says what was recorded and when.
  const quiet: Partial<AgentTreeInput> = {
    agents: [rec('aaaa0001', { outcome: 'failed', outcomeTs: NOW - 60 * MIN, lastTs: NOW - 50 * MIN, firstTs: NOW - 70 * MIN })],
    launches: [launch('aaaa0001', { outcome: 'failed', outcomeTs: NOW - 60 * MIN })],
    selected: agentKey('aaaa0001'),
  }
  assert.deepEqual([state(quiet).state, state(quiet).derived], ['unknown', true])
  assert.equal(stateText(quiet, agentKey('aaaa0001')),
    'Unknown — inferred: the transcript went on after an outcome was recorded at 11:00, and has been silent since 11:10.')
  assert.equal(recorded(quiet), 'failed at 11:00')
  // The row sits with the times, after the last activity.
  const labels = build(quiet).selected?.rows.map((r) => r.label) ?? []
  assert.equal(labels.indexOf('Recorded'), labels.indexOf('Last activity') + 1, labels.join(', '))

  // The workflow journal's result carries no time and is never outlived (1.6 P2b: it comes from
  // the run now, not from the record — a record's outcome with a time is the parent's, above).
  const journal: Partial<AgentTreeInput> = {
    agents: [wfRec('bbbb0001', { lastTs: NOW - MIN }), wfRec('bbbb0002', { lastTs: NOW - MIN })],
    runs: [run([jagent('bbbb0001', { outcome: 'completed' }), jagent('bbbb0002', { outcome: 'failed' })])],
  }
  for (const [id, state] of [['bbbb0001', 'done'], ['bbbb0002', 'failed']]) {
    assert.equal(node(build(journal), agentKey(id)).state, state, id)
    assert.equal(agentDetails(input(journal), NOW, agentKey(id))?.rows.some((r) => r.label === 'Recorded'), false, id)
  }
  // An outcome recorded without a time cannot be outlived either.
  const timeless = after(10 * MIN, { outcomeTs: null }, { outcomeTs: null })
  assert.equal(state(timeless).state, 'done')
  // In German: the state word and „um".
  assert.deepEqual(german(() => build(on).selected?.rows.find((r) => r.value.endsWith(' (11:50)'))),
    { label: 'Aufgezeichnet', value: 'fertig (11:50)' })
  assert.equal(german(() => stateText(on, agentKey('aaaa0001'))),
    'Läuft — abgeleitet: Das Transkript hat sich vor 9 min geändert, nachdem ein Ausgang aufgezeichnet wurde (11:50).')
})

test('short ids: the fewest characters from four on that no other agent of the session shares, without the leading a', () => {
  assert.equal(MIN_SHORT_ID, 4)
  const A = 'a3f2a1b2c3d4e5f60'
  const B = 'a3f2a7777777777aa'
  const C = 'a9c0d1e2f3a4b5c6d'
  assert.deepEqual([...shortIdsOf([A, B, C, 'bcde0002'])].sort(),
    [[A, '3f2a1'], [B, '3f2a7'], [C, '9c0d'], ['bcde0002', 'bcde']].sort())
  // As many as it takes, and an id that is another's start has none of its own: shown whole.
  assert.deepEqual([...shortIdsOf(['abcd', 'abcd1234', 'abce9'])].sort(),
    [['abcd', 'abcd'], ['abcd1234', 'abcd1'], ['abce9', 'abce']].sort())
  assert.deepEqual([...shortIdsOf(['aaaa0001', 'aaaa0002'])], [['aaaa0001', 'aaaa0001'], ['aaaa0002', 'aaaa0002']])
  assert.deepEqual([...shortIdsOf([])], [])

  // Per session: the same four characters in another session are no collision.
  const over: Partial<AgentTreeInput> = {
    agents: [rec(A), rec(B), rec(C), rec('a3f2a0000000000000'.slice(0, 17), { sessionId: S2 })],
    mains: [main(), main({ sessionId: S2 })],
    selected: agentKey(A),
  }
  const vm = build(over)
  const label = (id: string): string => node(vm, agentKey(id)).label
  assert.equal(label(A), 'Explore · opus-5 · 3f2a1')
  assert.equal(label(B), 'Explore · opus-5 · 3f2a7')
  assert.equal(label(C), 'Explore · opus-5 · 9c0d')
  assert.equal(label('a3f2a000000000000'), 'Explore · opus-5 · 3f2a')
  // Keys stay the full id.
  assert.equal(node(vm, agentKey(A)).key, `a:${A}`)
  // The whole id is in the details, in the row Copy ID copies, and it is what Copy ID copies.
  assert.equal(vm.selected?.id, A)
  assert.deepEqual(vm.selected?.rows.filter((r) => r.copy === true), [{ label: 'ID', value: A, copy: true }])
  // A launch's is its tool_use id.
  const launched = build({ launches: [launch('pppp0001', { agentId: null, ts: NOW - MIN })], selected: 'l:toolu_pppp0001' })
  assert.equal(launched.selected?.id, 'toolu_pppp0001')
  // The running list names an agent as the tree does.
  assert.ok(vm.runningNow.some((r) => r.label === 'Explore · opus-5 · 3f2a1' && r.fullLabel === 'Explore · claude-opus-5 · 3f2a1'),
    JSON.stringify(vm.runningNow))
})

// ---------------------------------------------------------------------------
// 1.6 N3 · why an agent ended: the rejected request
// ---------------------------------------------------------------------------

/** A request the API rejected: 429 on the 5-hour limit unless said otherwise. */
function rejected(at: number, over: Partial<NonNullable<AgentRec['rejected']>> = {}): NonNullable<AgentRec['rejected']> {
  return { at, status: 429, error: 'rate_limit', limit: 'five_hour', ...over }
}

/** One row of a node's details, by its label. */
function detailRow(over: Partial<AgentTreeInput>, key: string, label: string): DetailRow | undefined {
  return agentDetails(input(over), NOW, key)?.rows.find((r) => r.label === label)
}

test('an agent that ended on a rejected request says why — unknown with the reason, running within its ten minutes', () => {
  // Its last counted reply at 11:30, its next request rejected at 11:31: silent since.
  const silent: Partial<AgentTreeInput> = {
    agents: [rec('cccc0001', { lastTs: NOW - 30 * MIN, rejected: rejected(NOW - 29 * MIN) })],
    selected: agentKey('cccc0001'),
  }
  const vm = build(silent)
  const n = node(vm, agentKey('cccc0001'))
  assert.deepEqual([n.state, n.derived], ['unknown', true])
  assert.equal(vm.selected?.stateText,
    'Unknown — inferred: no result was recorded; the last request, at 11:31, was rejected — 5-hour limit (HTTP 429).')
  // The error line is the transcript's last line: its time is the node's last activity.
  assert.equal(n.lastTs, NOW - 29 * MIN)
  assert.equal(n.duration, '1 min 00 s')
  assert.deepEqual(vm.selected?.rows.find((r) => r.label === 'Last request'),
    { label: 'Last request', value: 'rejected at 11:31 — 5-hour limit (HTTP 429)', kind: 'sentence' })
  assert.deepEqual(vm.selected?.rows.find((r) => r.label === 'Last activity')?.value, '11:31')
  // After Tool calls, before Spawned by (1.6 L2's place for it). 1.6 P13a (O3, pinned and changed): the
  // counts of what went wrong — here its tool errors — stand between the tool calls and it.
  const labels = vm.selected?.rows.map((r) => r.label) ?? []
  assert.equal(labels.indexOf('Tool errors'), labels.indexOf('Tool calls') + 1, labels.join(', '))
  assert.equal(labels.indexOf('Last request'), labels.indexOf('Tool errors') + 1, labels.join(', '))
  assert.equal(labels.indexOf('Spawned by'), labels.indexOf('Last request') + 1, labels.join(', '))

  // Within its ten minutes — measured from the rejection, a line of the transcript like any other —
  // it still reads running (§7 Q17), and the sentence names the rejection.
  const fresh: Partial<AgentTreeInput> = {
    agents: [rec('cccc0002', { lastTs: NOW - 15 * MIN, rejected: rejected(NOW - 2 * MIN, { status: 529, error: 'server_error', limit: null }) })],
  }
  assert.deepEqual([node(build(fresh), agentKey('cccc0002')).state], ['running'])
  assert.equal(stateText(fresh, agentKey('cccc0002')),
    'Running — inferred: the transcript changed 2 min ago; its last request was rejected — server error (HTTP 529).')

  // A line that named neither a reason nor a status: the sentences end on "was rejected".
  const bare = { status: null, error: null, limit: null }
  assert.equal(stateText({ agents: [rec('cccc0003', { lastTs: NOW - 30 * MIN, rejected: rejected(NOW - 29 * MIN, bare) })] }, agentKey('cccc0003')),
    'Unknown — inferred: no result was recorded; the last request, at 11:31, was rejected.')
  assert.equal(stateText({ agents: [rec('cccc0004', { lastTs: NOW - 5 * MIN, rejected: rejected(NOW - 3 * MIN, bare) })] }, agentKey('cccc0004')),
    'Running — inferred: the transcript changed 3 min ago; its last request was rejected.')
  assert.equal(detailRow({ agents: [rec('cccc0003', { lastTs: NOW - 30 * MIN, rejected: rejected(NOW - 29 * MIN, bare) })] },
    agentKey('cccc0003'), 'Last request')?.value, 'rejected at 11:31')
  // Each part is left out alone: a status without a reason, a reason without a status.
  assert.equal(detailRow({ agents: [rec('cccc0005', { rejected: rejected(NOW - 30 * 1000, { error: null, limit: null, status: 529 }) })] },
    agentKey('cccc0005'), 'Last request')?.value, 'rejected at 11:59 — HTTP 529')
  assert.equal(detailRow({ agents: [rec('cccc0006', { rejected: rejected(NOW - 30 * 1000, { error: 'invalid_request', limit: null, status: null }) })] },
    agentKey('cccc0006'), 'Last request')?.value, 'rejected at 11:59 — invalid request')
})

test('the "may have been stopped" sentence stays only where no rejection is known, and a recorded end keeps its own', () => {
  const quiet = (over: Partial<AgentRec> = {}): Partial<AgentTreeInput> => ({ agents: [rec('dddd0001', { lastTs: NOW - 30 * MIN, ...over })] })
  const stopped = 'Unknown — inferred: no result was recorded and the transcript has been silent since 11:30; the agent may have been stopped.'
  assert.equal(stateText(quiet(), agentKey('dddd0001')), stopped)
  assert.equal(detailRow(quiet(), agentKey('dddd0001'), 'Last request'), undefined)
  // A rejection before the last counted reply was answered: it is not the transcript's last word.
  assert.equal(stateText(quiet({ rejected: rejected(NOW - 31 * MIN) }), agentKey('dddd0001')), stopped)
  assert.equal(detailRow(quiet({ rejected: rejected(NOW - 31 * MIN) }), agentKey('dddd0001'), 'Last request'), undefined)
  // One that a snapshot of another build's making garbled is none either.
  assert.equal(stateText(quiet({ rejected: { at: 'yesterday' } as unknown as AgentRec['rejected'] }), agentKey('dddd0001')), stopped)
  // An end the parent or the journal recorded keeps its sentence; the details still say what the
  // last request came to — in any state.
  const failed: Partial<AgentTreeInput> = {
    agents: [rec('dddd0002', { lastTs: NOW - 10 * MIN, rejected: rejected(NOW - 9 * MIN), outcome: 'failed', outcomeTs: NOW - 9 * MIN + 5000, outcomeStatus: 'failed' })],
  }
  assert.equal(stateText(failed, agentKey('dddd0002')), 'Failed — the parent recorded the failure at 11:51.')
  assert.equal(detailRow(failed, agentKey('dddd0002'), 'Last request')?.value, 'rejected at 11:51 — 5-hour limit (HTTP 429)')
  const journalled: Partial<AgentTreeInput> = {
    agents: [wfRec('dddd0003', { lastTs: NOW - 40 * MIN, rejected: rejected(NOW - 39 * MIN, { limit: 'seven_day' }) })],
    runs: [run([jagent('dddd0003', { outcome: 'failed' })])],
  }
  assert.equal(stateText(journalled, agentKey('dddd0003')), 'Failed — the workflow journal recorded the failure.')
  assert.equal(detailRow(journalled, agentKey('dddd0003'), 'Last request')?.value, 'rejected at 11:21 — weekly limit (HTTP 429)')
  // A request rejected more than a minute after the parent's recorded end is the transcript going
  // on after it (1.6 D6): the outcome no longer decides the state.
  const after: Partial<AgentTreeInput> = {
    agents: [rec('dddd0004', { lastTs: NOW - 20 * MIN, outcome: 'completed', outcomeTs: NOW - 20 * MIN, outcomeStatus: 'completed', rejected: rejected(NOW - 4 * MIN) })],
  }
  assert.equal(stateText(after, agentKey('dddd0004')), 'Running — inferred: the transcript changed 4 min ago, after an outcome was recorded at 11:40.')
})

test('each reason a rejected request gives, in English and in German', () => {
  // 1.14 P2 (pinned and changed: the German „um {n}" before a clock stamp → a label or brackets — „abgelehnt (11:31)", „die letzte Anfrage (11:31)" — §3 B2 rule 3).
  const cases: Array<[Partial<NonNullable<AgentRec['rejected']>>, string, string]> = [
    [{ error: 'rate_limit', limit: 'five_hour' }, '5-hour limit', '5-Stunden-Limit'],
    [{ error: 'rate_limit', limit: 'seven_day' }, 'weekly limit', 'Wochenlimit'],
    [{ error: 'rate_limit', limit: 'seven_day_opus' }, 'weekly model limit', 'wöchentliches Modell-Limit'],
    [{ error: 'rate_limit', limit: 'seven_day_sonnet' }, 'weekly model limit', 'wöchentliches Modell-Limit'],
    [{ error: 'rate_limit', limit: null }, 'usage limit', 'Nutzungslimit'],
    // The limit names a rate limit; a line without an error kind still has one.
    [{ error: null, limit: 'five_hour' }, '5-hour limit', '5-Stunden-Limit'],
    [{ error: 'server_error', limit: null }, 'server error', 'Serverfehler'],
    [{ error: 'overloaded', limit: null }, 'overloaded', 'überlastet'],
    [{ error: 'invalid_request', limit: null }, 'invalid request', 'ungültige Anfrage'],
    [{ error: 'authentication_failed', limit: null }, 'authentication failed', 'Anmeldung fehlgeschlagen'],
    [{ error: 'max_output_tokens', limit: null }, 'output limit', 'Ausgabelimit'],
  ]
  for (const [over, en, de] of cases) {
    const world: Partial<AgentTreeInput> = { agents: [rec('eeee0001', { lastTs: NOW - 30 * MIN, rejected: rejected(NOW - 29 * MIN, over) })] }
    assert.equal(detailRow(world, agentKey('eeee0001'), 'Last request')?.value, `rejected at 11:31 — ${en} (HTTP 429)`, JSON.stringify(over))
    const g = german(() => agentDetails(input(world), NOW, agentKey('eeee0001')))
    assert.equal(g?.rows.find((r) => r.label === 'Letzte Anfrage')?.value, `abgelehnt (11:31) — ${de} (HTTP 429)`, JSON.stringify(over))
    assert.equal(g?.stateText,
      `Unbekannt — abgeleitet: Es wurde kein Ergebnis aufgezeichnet; die letzte Anfrage (11:31) wurde abgelehnt — ${de} (HTTP 429).`)
  }
  // The other three sentences in German.
  const running: Partial<AgentTreeInput> = { agents: [rec('eeee0002', { lastTs: NOW - 5 * MIN, rejected: rejected(NOW - 2 * MIN) })] }
  assert.equal(german(() => stateText(running, agentKey('eeee0002'))),
    'Läuft — abgeleitet: Das Transkript hat sich vor 2 min geändert; seine letzte Anfrage wurde abgelehnt — 5-Stunden-Limit (HTTP 429).')
  const bare = { status: null, error: null, limit: null }
  assert.equal(german(() => stateText({ agents: [rec('eeee0003', { lastTs: NOW - 5 * MIN, rejected: rejected(NOW - 2 * MIN, bare) })] }, agentKey('eeee0003'))),
    'Läuft — abgeleitet: Das Transkript hat sich vor 2 min geändert; seine letzte Anfrage wurde abgelehnt.')
  const quiet: Partial<AgentTreeInput> = { agents: [rec('eeee0004', { lastTs: NOW - 30 * MIN, rejected: rejected(NOW - 29 * MIN, bare) })] }
  assert.equal(german(() => stateText(quiet, agentKey('eeee0004'))),
    'Unbekannt — abgeleitet: Es wurde kein Ergebnis aufgezeichnet; die letzte Anfrage (11:31) wurde abgelehnt.')
  assert.equal(german(() => agentDetails(input(quiet), NOW, agentKey('eeee0004'))?.rows.find((r) => r.label === 'Letzte Anfrage')?.value),
    'abgelehnt (11:31)')
})

test('a run and a session count their agents that ended on a rejected request, one row per reason', () => {
  const over: Partial<AgentTreeInput> = {
    agents: [
      wfRec('ffff0001', { lastTs: NOW - 40 * MIN, rejected: rejected(NOW - 39 * MIN) }),
      wfRec('ffff0002', { lastTs: NOW - 40 * MIN, rejected: rejected(NOW - 38 * MIN) }),
      wfRec('ffff0003', { lastTs: NOW - 40 * MIN, rejected: rejected(NOW - 37 * MIN, { status: 529, error: 'server_error', limit: null }) }),
      // A reply after its rejection: not one that ended on it.
      wfRec('ffff0004', { lastTs: NOW - 30 * MIN, rejected: rejected(NOW - 31 * MIN) }),
      wfRec('ffff0005', { lastTs: NOW - 30 * MIN }),
      // A direct agent of the session, and one whose line named nothing.
      rec('ffff0006', { lastTs: NOW - 40 * MIN, rejected: rejected(NOW - 36 * MIN, { status: null, error: 'invalid_request', limit: null }) }),
      rec('ffff0007', { lastTs: NOW - 40 * MIN, rejected: rejected(NOW - 35 * MIN, { status: null, error: null, limit: null }) }),
    ],
  }
  const rows = (key: string): Array<[string, string, string | undefined]> => (agentDetails(input(over), NOW, key)?.rows ?? [])
    .filter((r) => r.label === 'Ended on a rejected request').map((r) => [r.label, r.value, r.kind])
  const label = 'Ended on a rejected request'
  // The most frequent first, then by the words.
  assert.deepEqual(rows(wfKey), [[label, '5-hour limit (HTTP 429): 2', 'sentence'], [label, 'server error (HTTP 529): 1', 'sentence']])
  // A session counts every agent below it, its runs' included; a line that named nothing is `–`.
  assert.deepEqual(rows(rootKey), [
    [label, '5-hour limit (HTTP 429): 2', 'sentence'], [label, 'invalid request: 1', 'sentence'],
    [label, 'server error (HTTP 529): 1', 'sentence'], [label, '–: 1', 'sentence'],
  ])
  // After the summed counts, before the ID.
  const run = agentDetails(input(over), NOW, wfKey)?.rows.map((r) => r.label) ?? []
  assert.equal(run.indexOf(label), run.indexOf('Tool calls') + 1, run.join(', '))
  assert.equal(run[run.length - 1], 'ID')
  const session = agentDetails(input(over), NOW, rootKey)?.rows.map((r) => r.label) ?? []
  assert.equal(session.indexOf(label), session.indexOf('Agents') + 1, session.join(', '))
  // In German.
  const de = german(() => agentDetails(input(over), NOW, wfKey)?.rows.filter((r) => r.label === 'Endete mit abgelehnter Anfrage').map((r) => r.value))
  assert.deepEqual(de, ['5-Stunden-Limit (HTTP 429): 2', 'Serverfehler (HTTP 529): 1'])
  // No agent ended so: no row, rather than a 0.
  const none = { agents: [wfRec('ffff0005', { lastTs: NOW - 30 * MIN })] }
  assert.equal(agentDetails(input(none), NOW, wfKey)?.rows.some((r) => r.label === label), false)
  assert.equal(agentDetails(input(none), NOW, rootKey)?.rows.some((r) => r.label === label), false)
})

// ---------------------------------------------------------------------------
// 1.6 D4 · agents without a first reply: counted, not listed
// ---------------------------------------------------------------------------

/**
 * An agent of run WF whose transcript holds nothing but requests the API rejected (1.6 D4): the
 * record its first rejection made — no request, no token, its first and last line that
 * rejection's time — and its last rejection, the same one unless said otherwise.
 */
function rejectedOnly(id: string, at: number, over: Partial<AgentRec> = {}): AgentRec {
  return wfRec(id, {
    firstTs: at, lastTs: at, models: [], input: 0, cacheWrite: 0, cacheWrite1h: 0, cacheRead: 0, output: 0, reasoning: 0,
    requests: 0, outputFinal: 0, toolCalls: 0, rejected: rejected(at), ...over,
  })
}

/**
 * The spec's D4 world: one run of 427 agents — 161 with counted replies, all completed; 3 whose
 * transcripts hold nothing but requests rejected on the 5-hour limit, their failure recorded by
 * the journal; and 263 the journal started without a transcript, all completed but 8 still open.
 * The journal last changed half an hour ago and nothing runs.
 */
function collectorWorld(): { over: Partial<AgentTreeInput>; ids: string[]; rejectedIds: string[]; onlyIds: string[] } {
  const ids = Array.from({ length: 161 }, (_, i) => hexId(0x20000 + i))
  const rejectedIds = [0, 1, 2].map((i) => hexId(0x30000 + i))
  const onlyIds = Array.from({ length: 263 }, (_, j) => hexId(0x10000 + j))
  const agents = [
    ...ids.map((id, i) => wfRec(id, { firstTs: NOW - 5 * HOUR + i * MIN, lastTs: NOW - 5 * HOUR + i * MIN + 30_000 })),
    ...rejectedIds.map((id, i) => rejectedOnly(id, NOW - 4 * HOUR + i * MIN)),
  ]
  const journal = [
    ...ids.map((id, i) => jagent(id, { step: i + 1, outcome: 'completed' })),
    ...rejectedIds.map((id, i) => jagent(id, { step: 500 + i, outcome: 'failed' })),
    ...onlyIds.map((id, j) => jagent(id, { step: 1000 + j, outcome: j < 8 ? null : 'completed' })),
  ]
  return { over: { agents, runs: [run(journal)] }, ids, rejectedIds, onlyIds }
}

test('a run\'s agents without a counted reply are one collector, its last child: counted, not listed, dashes for figures', () => {
  const { over, ids, rejectedIds, onlyIds } = collectorWorld()
  // The run opened and every "more" step taken: every child of the run on the page.
  const vm = page({ ...over, expanded: [rootKey, wfKey], more: [{ key: wfKey, pages: 3 }] })
  const w = node(vm, wfKey)
  // 161 agents and one collector — no node for any of the 266 without a counted reply.
  assert.deepEqual([w.children.length, w.childrenTotal, w.childrenMore], [162, 162, 0])
  // The newest first (1.6 N6), the collector last.
  assert.deepEqual(w.children.map((c) => c.key), [...[...ids].reverse().map(agentKey), collectorKey])
  assert.deepEqual(all(vm.roots).filter((n) => n.kind === 'noreply').map((n) => n.key), [collectorKey])
  assert.equal(all(vm.roots).length, 1 + 1 + 162)
  for (const id of [...rejectedIds, ...onlyIds]) assert.equal(all(vm.roots).some((n) => n.key === agentKey(id)), false, id)
  // The collector: its members in its label, its count and its tally; no figure of its own.
  const c = node(vm, collectorKey)
  assert.equal(c.kind, 'noreply')
  assert.equal(c.label, '266 agent(s) without a counted reply')
  assert.deepEqual([c.usage, c.duration, c.usageAgents, c.lowerBound, c.superseded], ['–', '–', null, false, false])
  // No start of its own, so no clock anywhere (1.6, the lead's note on P5b): its members' earliest
  // line may be a rejection of an agent that failed hours ago. Its last line it keeps.
  assert.deepEqual([c.startTs, c.startClock], [null, null])
  assert.equal(c.lastTs, NOW - 4 * HOUR + 2 * MIN)
  assert.deepEqual([c.hasChildren, c.childrenTotal, c.childrenMore, c.children], [false, 0, 0, []])
  assert.equal(c.agentCount, 266)
  assert.deepEqual(c.tally, { started: 266, done: 255, failed: 3, retried: 0, stopped: 0, running: 0, unknown: 8 })
  assert.equal(c.tallyText, '266 started · 255 ✓ · 3 ✕ · ~8 ?')
  assert.deepEqual([c.state, c.derived], ['unknown', true])
  // The run counts all 427 — the 1.5 "Agents 164" is 427 — and so does its session.
  assert.equal(w.agentCount, 427)
  assert.equal(w.tallyText, '427 started · 416 ✓ · 3 ✕ · ~8 ?')
  assert.equal(node(vm, rootKey).agentCount, 427)
  // 1.6 P9 (L2, pinned and changed): the run's row is its tally in words; the session's the count.
  assert.equal(agentDetails(input(over), NOW, wfKey)?.rows.find((r) => r.label === 'Agents')?.value,
    '427 started, 416 done, 3 failed, about 8 unknown')
  assert.equal(agentDetails(input(over), NOW, rootKey)?.rows.find((r) => r.label === 'Agents')?.value, '427')
  // The run and its session count the collector's rejections among theirs.
  for (const key of [wfKey, rootKey]) {
    assert.deepEqual(agentDetails(input(over), NOW, key)?.rows.filter((r) => r.label === 'Ended on a rejected request').map((r) => r.value),
      ['5-hour limit (HTTP 429): 3'], key)
  }
  // No zero anywhere on the collector.
  for (const v of [c.usage, c.duration, c.label, c.tallyText ?? '']) assert.equal(/(^|\s)0(\s|$)/.test(v), false, v)
  // The markdown's tree: fifty children of the run, the collector among them — pinned, and last.
  const text = node(build(over), wfKey)
  assert.equal(text.children.length, MAX_GROUP_CHILDREN)
  assert.equal(text.children[text.children.length - 1].key, collectorKey)
  assert.equal(text.childrenMore, 162 - MAX_GROUP_CHILDREN)
})

test('the collector says in its label when every one of its agents failed before a first reply', () => {
  const failed: Partial<AgentTreeInput> = {
    agents: [silentWf(J1), rejectedOnly(J2, NOW - 40 * MIN), rejectedOnly(J3, NOW - 39 * MIN)],
    runs: [run([jagent(J1, { step: 1, outcome: 'completed' }), jagent(J2, { step: 2, outcome: 'failed' }),
      jagent(J3, { step: 3, outcome: 'failed' }), jagent(J4, { step: 4, outcome: 'failed' })])],
    selected: collectorKey,
  }
  const vm = build(failed)
  const c = node(vm, collectorKey)
  assert.deepEqual([c.label, c.state, c.derived], ['3 agent(s) failed before their first reply', 'failed', false])
  assert.equal(vm.selected?.stateText, 'Failed — the workflow journal recorded a failure for each of them.')
  assert.equal(german(() => node(build(failed), collectorKey).label), '3 Agent(en) vor der ersten Antwort fehlgeschlagen')
  assert.equal(german(() => build(failed).selected?.stateText),
    'Fehlgeschlagen — das Workflow-Journal hat für jeden von ihnen einen Fehlschlag aufgezeichnet.')
  // One of them the parent failed, not the journal: the label stays, the sentence is the run's kind.
  const parent: Partial<AgentTreeInput> = {
    ...failed,
    agents: [silentWf(J1), rejectedOnly(J2, NOW - 40 * MIN, { outcome: 'failed', outcomeStatus: 'failed', outcomeTs: NOW - 39 * MIN }),
      rejectedOnly(J3, NOW - 39 * MIN)],
    runs: [run([jagent(J1, { step: 1, outcome: 'completed' }), jagent(J3, { step: 3, outcome: 'failed' }), jagent(J4, { step: 4, outcome: 'failed' })])],
  }
  assert.equal(node(build(parent), collectorKey).label, '3 agent(s) failed before their first reply')
  assert.equal(build(parent).selected?.stateText, 'Failed — every one of these agents has a recorded outcome, and none completed.')
  // One of them still open: the label counts them all without saying how they ended.
  const open: Partial<AgentTreeInput> = {
    ...failed,
    runs: [run([jagent(J1, { step: 1, outcome: 'completed' }), jagent(J2, { step: 2, outcome: 'failed' }),
      jagent(J3, { step: 3, outcome: 'failed' }), jagent(J4, { step: 4 })])],
  }
  assert.deepEqual([node(build(open), collectorKey).label, node(build(open), collectorKey).state],
    ['3 agent(s) without a counted reply', 'unknown'])
  assert.equal(german(() => node(build(open), collectorKey).label), '3 Agent(en) ohne gezählte Antwort')
})

test('the collector\'s state is its members\' by the run\'s rule, in its own sentences, in English and in German', () => {
  const at = (runs: JournalAgent[], agents: AgentRec[] = [], lastTs = NOW - 30 * MIN): Partial<AgentTreeInput> => ({
    agents: [silentWf(J1), ...agents], runs: [run([jagent(J1, { step: 1, outcome: 'completed' }), ...runs], { lastTs })], selected: collectorKey,
  })
  const cases: Array<[string, Partial<AgentTreeInput>, NodeState, string, string]> = [
    ['one runs', at([jagent(J2, { step: 2 }), jagent(J3, { step: 3, outcome: 'failed' })], [], NOW - 2 * MIN), 'running',
      'Running — inferred: at least one of these agents is running.',
      'Läuft — abgeleitet: Mindestens einer dieser Agenten läuft.'],
    ['one is open', at([jagent(J2, { step: 2 }), jagent(J3, { step: 3, outcome: 'completed' })]), 'unknown',
      'Unknown — inferred: not every one of these agents has a recorded outcome, and none is running.',
      'Unbekannt — abgeleitet: Nicht für jeden dieser Agenten ist ein Ausgang aufgezeichnet, und keiner läuft.'],
    // The journal can close a member that never wrote a transcript: a result…
    ['one completed', at([jagent(J2, { step: 2, outcome: 'completed' }), jagent(J3, { step: 3, outcome: 'failed' })]), 'done',
      'Done — every one of these agents has a recorded outcome, and at least one completed.',
      'Fertig — für jeden dieser Agenten ist ein Ausgang aufgezeichnet, und mindestens einer wurde abgeschlossen.'],
    // …or a replacement: its failure stands, the replaced one is retried.
    ['one failed, one replaced', at([jagent(J2, { step: 2, outcome: 'failed' }), jagent(J3, { step: 3, outcome: 'stopped', supersededBy: J1 })]),
      'failed', 'Failed — every one of these agents has a recorded outcome, and none completed.',
      'Fehlgeschlagen — für jeden dieser Agenten ist ein Ausgang aufgezeichnet, und keiner wurde abgeschlossen.'],
    // A stop the parent recorded for a rejection-only agent that nothing replaced.
    ['stopped', at([jagent(J2, { step: 2 })], [rejectedOnly(J2, NOW - 40 * MIN, { outcome: 'stopped', outcomeStatus: 'killed', outcomeTs: NOW - 39 * MIN })]),
      'stopped', 'Stopped — every one of these agents has a recorded outcome, and none completed: the last attempt of each step was stopped.',
      'Gestoppt — für jeden dieser Agenten ist ein Ausgang aufgezeichnet, und keiner wurde abgeschlossen: Der letzte Versuch jedes Schritts wurde gestoppt.'],
  ]
  for (const [what, over, state, en, de] of cases) {
    const vm = build(over)
    const c = node(vm, collectorKey)
    assert.deepEqual([c.state, c.derived], [state, state === 'running' || state === 'unknown'], what)
    assert.equal(vm.selected?.stateText, en, what)
    assert.equal(german(() => build(over).selected?.stateText), de, what)
    // The run's tally and the collector's agree on every member they share.
    const t = c.tally
    assert.ok(t, what)
    assert.equal(t.done + t.failed + t.retried + t.stopped + t.running + t.unknown, t.started, what)
  }
  // Every member superseded — each attempt followed by a later one, a row of the run: their own
  // ends decide, since the tally counts them all as retried. A completed step run again and a
  // replaced one: done.
  const redone = at([jagent(J2, { step: 1, outcome: 'completed', supersededBy: J1 }), jagent(J3, { step: 3, outcome: 'stopped', supersededBy: J1 })])
  assert.deepEqual([node(build(redone), collectorKey).state, node(build(redone), collectorKey).tallyText], ['done', '2 started · 2 ↻'])
  // A failure retried and a replaced one: failed — none completed — not stopped.
  const retried = at([jagent(J2, { step: 1, outcome: 'failed', supersededBy: J1 }), jagent(J3, { step: 3, outcome: 'stopped', supersededBy: J1 })])
  assert.equal(node(build(retried), collectorKey).state, 'failed')
})

test('a later counted reply moves an agent out of the collector into a node of its own', () => {
  const before: Partial<AgentTreeInput> = {
    agents: [silentWf(J1), rejectedOnly(J2, NOW - 40 * MIN), rejectedOnly(J3, NOW - 39 * MIN)],
    runs: [run([jagent(J1, { step: 1, outcome: 'completed' }), jagent(J2, { step: 2, outcome: 'failed' }), jagent(J3, { step: 3 })])],
  }
  assert.deepEqual(node(build(before), wfKey).children.map((c) => c.key), [agentKey(J1), collectorKey])
  assert.equal(node(build(before), collectorKey).agentCount, 2)
  // J3's retry went through: its first counted reply, which clears its rejection.
  const replied = rejectedOnly(J3, NOW - 39 * MIN, { requests: 1, outputFinal: 1, input: 40, output: 12, lastTs: NOW - 38 * MIN, rejected: null })
  const after: Partial<AgentTreeInput> = { ...before, agents: [silentWf(J1), rejectedOnly(J2, NOW - 40 * MIN), replied] }
  const vm = build(after)
  // The newest first (1.6 N6): J3 started a minute after J1; the collector last.
  assert.deepEqual(node(vm, wfKey).children.map((c) => c.key), [agentKey(J3), agentKey(J1), collectorKey])
  assert.deepEqual([node(vm, collectorKey).agentCount, node(vm, collectorKey).label], [1, '1 agent(s) failed before their first reply'])
  assert.notEqual(node(vm, agentKey(J3)).usage, '–')
  assert.equal(node(vm, wfKey).agentCount, 3)
  // Its last member replied too: no collector.
  const all3: Partial<AgentTreeInput> = { ...before, agents: [silentWf(J1), rejectedOnly(J2, NOW - 40 * MIN, { requests: 2, input: 9, output: 3, rejected: null }), replied] }
  assert.equal(all(build(all3).roots).some((n) => n.kind === 'noreply'), false)
})

test('an agent outside a run whose transcript holds only rejected requests is a node of its own, with dashes for its figures', () => {
  // Rejected first at 11:35, last at 11:40: its record has no request and no token.
  const direct = rec('bbbb0009', {
    firstTs: NOW - 25 * MIN, lastTs: NOW - 25 * MIN, models: [], input: 0, cacheWrite: 0, cacheWrite1h: 0, cacheRead: 0, output: 0,
    reasoning: 0, requests: 0, outputFinal: 0, toolCalls: 0, rejected: rejected(NOW - 20 * MIN),
  })
  const over: Partial<AgentTreeInput> = { agents: [direct], selected: agentKey('bbbb0009') }
  const vm = build(over)
  const n = node(vm, agentKey('bbbb0009'))
  assert.deepEqual([n.kind, n.state, n.usage, n.duration, n.lowerBound], ['agent', 'unknown', '–', '–', false])
  assert.equal(all(vm.roots).some((x) => x.kind === 'noreply'), false)
  assert.equal(vm.selected?.stateText,
    'Unknown — inferred: no result was recorded; the last request, at 11:40, was rejected — 5-hour limit (HTTP 429).')
  const rows = Object.fromEntries((vm.selected?.rows ?? []).map((r) => [r.label, r.value]))
  // 1.6 P9 (L2): "Turns" is "Requests", and the context it ended with a dash too; nothing counted
  // has no mix, no pace and no line under its state.
  for (const label of ['Duration', 'Requests', 'Usage', 'Fresh input', 'Cache write 5m', 'Cache write 1h', 'Cache read', 'Output',
    'Reasoning', 'Tool calls', 'Context at the end']) {
    assert.equal(rows[label], '–', label)
  }
  assert.deepEqual(['Token mix', 'Per minute', 'Rank in run'].filter((label) => label in rows), [])
  assert.equal(vm.selected?.overview, null)
  assert.deepEqual([rows.Started, rows['Last activity'], rows['Last request']], ['11:35', '11:40', 'rejected at 11:40 — 5-hour limit (HTTP 429)'])
  assert.equal((vm.selected?.rows ?? []).some((r) => /^0(\s|$)/.test(r.value)), false)
  // Within its ten minutes it runs, and is listed like any running agent.
  const fresh = build({ agents: [{ ...direct, rejected: rejected(NOW - 2 * MIN) }] })
  assert.deepEqual(fresh.runningNow.map((r) => [r.key, r.kind, r.usage, r.running]), [[agentKey('bbbb0009'), 'agent', '–', 1]])
})

test('running counts a collector\'s running members, and the running list carries the collector once for all of them', () => {
  // A run at work: one agent writing, one rejection-only agent rejected three minutes ago, and two
  // agents the journal started that no transcript shows yet.
  const over: Partial<AgentTreeInput> = {
    agents: [wfRec(J1, { firstTs: NOW - 30 * MIN, lastTs: NOW - MIN }), rejectedOnly(J2, NOW - 3 * MIN)],
    runs: [run([jagent(J1, { step: 1 }), jagent(J2, { step: 2 }), jagent(J3, { step: 3 }), jagent(J4, { step: 4 })], { lastTs: NOW - MIN })],
  }
  const vm = page(over)
  const whole = build(over)
  const c = node(whole, collectorKey)
  // 1.6 (the lead's note on P5b, pinned and changed): no start of its own, so no clock — P5b gave
  // it the earliest first line of a member with a record.
  assert.deepEqual([c.state, c.tally?.running, c.startTs, c.startClock], ['running', 3, null, null])
  // The host's number, the session's tally and the running list say the same: four.
  assert.equal(vm.running, 4)
  assert.equal(vm.roots[0].tally?.running, 4)
  assert.deepEqual(vm.runningNow.map((r) => [r.key, r.kind, r.running]), [[agentKey(J1), 'agent', 1], [collectorKey, 'noreply', 3]])
  assert.equal(vm.runningNow.reduce((s, r) => s + r.running, 0) , vm.running)
  // The collector's entry: its label, its run's context, a dash for its usage, no bound, no wait —
  // and no start (1.6, the lead's note on P5b: the page shows how many of its members run instead
  // of a clock, which an earliest first line would make false precision). Its last line it keeps.
  const item = vm.runningNow[1]
  assert.deepEqual(item, {
    key: collectorKey, kind: 'noreply', label: '3 agent(s) without a counted reply', fullLabel: '3 agent(s) without a counted reply',
    context: 'Session 9d0eb37a · Workflow run cfe7718d',
    usage: '–', lowerBound: false, lowerBoundText: null, startTs: null, lastTs: NOW - 3 * MIN, startClock: null, lastClock: '11:57',
    waiting: false, silence: false, hookWait: null, running: 3,
  })
  // Its row opens its details from the list, the tree closed.
  const picked = page({ ...over, selected: collectorKey })
  assert.equal(picked.selected?.key, collectorKey)
  // Without a member that has a record, it has no start either: last in the list.
  const noRecord: Partial<AgentTreeInput> = { ...over, agents: [wfRec(J1, { firstTs: NOW - 30 * MIN, lastTs: NOW - MIN })] }
  const listed = page(noRecord).runningNow
  assert.deepEqual(listed.map((r) => [r.key, r.startTs, r.running]), [[agentKey(J1), NOW - 30 * MIN, 1], [collectorKey, null, 3]])
  assert.equal(page(noRecord).running, 4)
  // A collector none of whose members runs is not listed.
  const quiet = page({ ...over, agents: [wfRec(J1, { lastTs: NOW - 40 * MIN }), rejectedOnly(J2, NOW - 45 * MIN)],
    runs: [run([jagent(J1, { step: 1 }), jagent(J2, { step: 2 }), jagent(J3, { step: 3 })], { lastTs: NOW - 40 * MIN })] })
  assert.deepEqual([quiet.running, quiet.runningNow], [0, []])
  // A superseded attempt counts where the tally counts it — retried — and is not listed as running.
  const revived: Partial<AgentTreeInput> = {
    agents: [wfRec(J1, { lastTs: NOW - MIN, outcome: 'completed', outcomeStatus: 'completed', outcomeTs: NOW - 20 * MIN }), silentWf(J2)],
    runs: [run([jagent(J1, { step: 1, outcome: 'completed', supersededBy: J2 }), jagent(J2, { step: 1, attempt: 2, outcome: 'completed' })])],
  }
  const r = build(revived)
  assert.deepEqual([node(r, agentKey(J1)).state, node(r, agentKey(J1)).superseded, r.roots[0].tally?.retried], ['running', true, 1])
  assert.deepEqual([r.running, r.runningNow], [0, []])
})

test('the collector\'s details: its tally in words, why it has no figures, and how many of its agents ended on a rejected request', () => {
  const { over } = collectorWorld()
  const d = agentDetails(input(over), NOW, collectorKey)
  assert.ok(d)
  assert.deepEqual([d.key, d.title, d.state, d.derived, d.id], [collectorKey, '266 agent(s) without a counted reply', 'unknown', true, null])
  assert.deepEqual(d.rows, [
    { label: 'Agents', value: '266 started, 255 done, 3 failed, about 8 unknown', kind: 'sentence' },
    {
      label: 'Usage', value: '–', kind: 'sentence',
      note: 'These agents were started, but none of them wrote a reply that could be counted — their transcripts hold no response, or only rejected requests.',
    },
    { label: 'Ended on a rejected request', value: '5-hour limit (HTTP 429): 3', kind: 'sentence' },
  ])
  const de = german(() => agentDetails(input(over), NOW, collectorKey))
  assert.deepEqual(de?.rows.map((r) => [r.label, r.value, r.note]), [
    ['Agenten', '266 gestartet, 255 fertig, 3 fehlgeschlagen, etwa 8 unbekannt', undefined],
    ['Verbrauch', '–', 'Diese Agenten wurden gestartet, aber keiner hat eine zählbare Antwort geschrieben — ihre Transkripte enthalten keine Antwort oder nur abgelehnte Anfragen.'],
    ['Endete mit abgelehnter Anfrage', '5-Stunden-Limit (HTTP 429): 3', undefined],
  ])
  assert.equal(de?.title, '266 Agent(en) ohne gezählte Antwort')
  // Its last activity is the latest line of a member with a record — a rejection here.
  assert.equal(d.lastTs, NOW - 4 * HOUR + 2 * MIN)
})

// ---------------------------------------------------------------------------
// 1.6 P6 · D10 the lower bound's reason, N5 silence
// ---------------------------------------------------------------------------

test('a lower bound says why in numbers — on an agent, on its run\'s and its session\'s sums — and the details say the same (1.6 D10)', () => {
  const over: Partial<AgentTreeInput> = {
    mains: [main({ requests: 12, outputFinal: 10 })],
    agents: [
      rec('aaaa0001', { requests: 5, outputFinal: 4 }),
      // Every reply finished: no lower bound, no reason.
      rec('aaaa0002', { requests: 5, outputFinal: 5, firstTs: NOW - 20 * MIN }),
      wfRec('bbbb0001', { requests: 5, outputFinal: 3 }),
      wfRec('bbbb0002', { requests: 4, outputFinal: 4, firstTs: NOW - 25 * MIN }),
      // A workflow agent without a counted reply: the collector's, which counts nothing.
      wfRec('bbbb0003', { requests: 0, outputFinal: 0, input: 0, cacheWrite: 0, cacheRead: 0, output: 0, reasoning: 0 }),
    ],
    launches: [launch('pppp0001', { agentId: null, ts: NOW - MIN })],
  }
  const vm = build(over)
  const why = (key: string): [boolean, string | null] => [node(vm, key).lowerBound, node(vm, key).lowerBoundText]
  assert.deepEqual(why(agentKey('aaaa0001')), [true, '⚠ lower bound — 1 of 5 replies unfinished'])
  assert.deepEqual(why(agentKey('aaaa0002')), [false, null])
  // The run sums its agents' replies: two of the first one's five unfinished, none of the second's four.
  assert.deepEqual(why(wfKey), [true, '⚠ lower bound — 2 of 9 replies unfinished'])
  // The session's figure is its own transcript's, and so is its reason.
  assert.deepEqual(why(rootKey), [true, '⚠ lower bound — 2 of 12 replies unfinished'])
  // A launch and a collector count nothing, and say nothing of a bound.
  assert.deepEqual(why('l:toolu_pppp0001'), [false, null])
  assert.deepEqual(why(collectorKey), [false, null])
  // The details' Output note is the node's reason, word for word; a finished agent's has none.
  const output = (key: string): DetailRow | undefined => agentDetails(input(over), NOW, key)?.rows.find((r) => r.label === 'Output')
  assert.equal(output(agentKey('aaaa0001'))?.note, '⚠ lower bound — 1 of 5 replies unfinished')
  assert.equal(output(agentKey('aaaa0002'))?.note, undefined)
  assert.equal(output(wfKey)?.note, '⚠ lower bound — 2 of 9 replies unfinished')
  assert.equal(output(rootKey)?.note, '⚠ lower bound — 2 of 12 replies unfinished')
  // Numbers in the reader's format, in German words.
  const big = german(() => build({ agents: [rec('aaaa0001', { requests: 1234, outputFinal: 1 })] }))
  assert.equal(node(big, agentKey('aaaa0001')).lowerBoundText, '⚠ Untergrenze — 1.233 von 1.234 Antworten unvollständig')
  // Every node's flag and its reason come together.
  for (const n of all(vm.roots)) assert.equal(n.lowerBoundText !== null, n.lowerBound, n.key)
})

test('an unknown agent whose transcript went quiet on a tool call names the call; any other keeps its sentence (1.6 N5)', () => {
  // 1.14 P2 (pinned and changed: the German „um {n}" before a clock stamp → a label or brackets — „seit einem Bash-Aufruf (11:30)" — §3 B2 rule 3).
  const quiet = (over: Partial<AgentRec>): string | undefined =>
    stateText({ agents: [rec('aaaa0001', { lastTs: NOW - 30 * MIN, ...over })] }, agentKey('aaaa0001'))
  const withTool = 'Unknown — inferred: no result was recorded and the transcript has been silent since 11:30, after a Bash call; the agent may have been stopped.'
  const without = 'Unknown — inferred: no result was recorded and the transcript has been silent since 11:30; the agent may have been stopped.'
  // The last line made the call.
  assert.equal(quiet({ lastTool: 'Bash', lastToolTs: NOW - 30 * MIN }), withTool)
  assert.equal(quiet({ lastTool: 'mcp__server__tool', lastToolTs: NOW - 30 * MIN }),
    withTool.replace('a Bash call', 'a mcp__server__tool call'))
  // The call came on a line before the last: the silence is not the call's.
  assert.equal(quiet({ lastTool: 'Bash', lastToolTs: NOW - 31 * MIN }), without)
  // No call, a call without a name, a name a snapshot of another build left outside the alphabet.
  assert.equal(quiet({ lastTool: null, lastToolTs: null }), without)
  assert.equal(quiet({ lastTool: null, lastToolTs: NOW - 30 * MIN }), without)
  assert.equal(quiet({ lastTool: 'rm -rf /', lastToolTs: NOW - 30 * MIN }), without)
  // A request the API rejected after it is the transcript's last word: the rejection is named instead.
  assert.equal(quiet({ lastTool: 'Bash', lastToolTs: NOW - 30 * MIN, rejected: { at: NOW - 29 * MIN, status: 429, error: 'rate_limit', limit: 'five_hour' } }),
    'Unknown — inferred: no result was recorded; the last request, at 11:31, was rejected — 5-hour limit (HTTP 429).')
  // A running agent, a recorded end: their own sentences, whatever the last call was.
  assert.equal(stateText({ agents: [rec('aaaa0001', { lastTool: 'Bash', lastToolTs: NOW - MIN })] }, agentKey('aaaa0001')),
    'Running — inferred: the transcript changed 1 min ago and no result was recorded yet.')
  assert.equal(stateText({ agents: [rec('aaaa0001', { lastTool: 'Bash', lastToolTs: NOW - 30 * MIN, lastTs: NOW - 30 * MIN,
    outcome: 'completed', outcomeTs: NOW - 30 * MIN })] }, agentKey('aaaa0001')), 'Completed — the parent recorded the result at 11:30.')
  // In German: the call's name before „-Aufruf", the time after it.
  assert.equal(german(() => quiet({ lastTool: 'Bash', lastToolTs: NOW - 30 * MIN })),
    'Unbekannt — abgeleitet: Es wurde kein Ergebnis aufgezeichnet, und das Transkript hat sich seit einem Bash-Aufruf (11:30) nicht mehr geändert; der Agent wurde möglicherweise abgebrochen.')
})

test('a running agent by its own transcript may say how long it has been silent; a waiting one, a launch, a finished one may not (1.6 N5)', () => {
  const vm = build({
    agents: [
      rec('aaaa0001', { lastTs: NOW - 4 * MIN }),
      // Waits on the agent it launched: it runs by what is below it, and says so.
      rec('aaaa0002', { lastTs: NOW - 30 * MIN, firstTs: NOW - 40 * MIN }),
      rec('aaaa0003', { lastTs: NOW - MIN, spawnerFile: agentFile('aaaa0002'), meta: { agentType: 'Plan', model: 'opus', spawnDepth: 2, toolUseId: null, parentAgentId: null } }),
      // Silent for half an hour: unknown, nothing to count.
      rec('aaaa0004', { lastTs: NOW - 30 * MIN }),
      // Wrote on after its recorded end (D6): running again by its own lines.
      rec('aaaa0005', { outcome: 'completed', outcomeTs: NOW - 8 * MIN, outcomeStatus: 'completed', lastTs: NOW - 5 * MIN }),
      rec('aaaa0006', { outcome: 'completed', outcomeTs: NOW - 3 * MIN, outcomeStatus: 'completed', lastTs: NOW - 3 * MIN }),
      wfRec('bbbb0001', { lastTs: NOW - 2 * MIN }),
    ],
    launches: [launch('pppp0001', { agentId: null, ts: NOW - MIN })],
  })
  const silent = Object.fromEntries(all(vm.roots).map((n) => [n.key, n.silence]))
  assert.deepEqual(silent, {
    [rootKey]: false,
    [agentKey('aaaa0001')]: true,
    [agentKey('aaaa0002')]: false,
    [agentKey('aaaa0003')]: true,
    [agentKey('aaaa0004')]: false,
    [agentKey('aaaa0005')]: true,
    [agentKey('aaaa0006')]: false,
    [wfKey]: false,
    [agentKey('bbbb0001')]: true,
    'l:toolu_pppp0001': false,
  })
  assert.equal(node(vm, agentKey('aaaa0002')).state, 'running')
  assert.equal(node(vm, agentKey('aaaa0005')).state, 'running')
  // The running list says the same of each of its entries, from the same clock: the node's last activity.
  for (const r of vm.runningNow) {
    assert.equal(r.silence, node(vm, r.key).silence, r.key)
    assert.equal(r.lastTs, node(vm, r.key).lastTs, r.key)
  }
  assert.ok(vm.runningNow.some((r) => r.silence) && vm.runningNow.some((r) => !r.silence))
})

// ---------------------------------------------------------------------------
// 1.6 P7 · N6: names by start time, the newest first; N9: the clock times behind the static words
// ---------------------------------------------------------------------------

test('a session and a run are named by when they started — a weekday within six days, a date before — then their id', () => {
  const at = (firstTs: number, over: Partial<AgentTreeInput> = {}): AgentTreeVm =>
    build({ mains: [main({ firstTs })], agents: [wfRec('bbbb0001', { firstTs, lastTs: NOW - MIN })], ...over })
  const names = (vm: AgentTreeVm): string[] => [vm.roots[0].label, node(vm, wfKey).label]
  // NOW is Tuesday 2026-09-22 12:00 UTC.
  assert.deepEqual(names(at(NOW - 2 * HOUR)), ['Session Tue 10:00 · 9d0eb37a', 'Workflow run Tue 10:00 · cfe7718d'])
  assert.deepEqual(names(at(NOW - 3 * DAY - HOUR)), ['Session Sat 11:00 · 9d0eb37a', 'Workflow run Sat 11:00 · cfe7718d'])
  // The window: a minute inside six days is a weekday (Wednesday — the Tuesday a week ago is not in it)…
  assert.deepEqual(names(at(NOW - WEEKDAY_NAMES_WITHIN_MS + MIN)), ['Session Wed 12:01 · 9d0eb37a', 'Workflow run Wed 12:01 · cfe7718d'])
  // …exactly six days back, and before, a date: the same weekday a week ago would read as this one.
  assert.deepEqual(names(at(NOW - WEEKDAY_NAMES_WITHIN_MS)), ['Session 2026-09-16 12:00 · 9d0eb37a', 'Workflow run 2026-09-16 12:00 · cfe7718d'])
  const old = build({ mains: [main({ firstTs: NOW - 22 * DAY - 11 * HOUR })] })
  assert.equal(old.roots[0].label, 'Session 2026-08-31 01:00 · 9d0eb37a')
  // No start known: the id alone — a session whose transcript was never read (1.7 F2: in the group
  // of earlier sessions, its state unknown).
  const bare = build({ mains: [], agents: [rec('aaaa0001', { lastTs: NOW - 30 * MIN, firstTs: NOW - 40 * MIN })] })
  assert.equal(sessionsOf(bare)[0].label, 'Session 9d0eb37a')
  // A run nothing but its launch shows is named by its launch (N4).
  const launched: RunLaunch = {
    toolUseId: 'toolu_wf1', file: sessionFile(), ts: NOW - 2 * MIN, runId: WF, outcome: 'launched', outcomeStatus: null, outcomeTs: null,
  }
  assert.equal(node(build({ runLaunches: [launched] }), wfKey).label, 'Workflow run Tue 11:58 · cfe7718d')
  // The zone is the configured one, and the weekday the calendar's: 23:30 UTC on Monday is
  // Tuesday 01:30 in Berlin; a day boundary at 06:00 does not move the name to the day before.
  const berlin: TimeConfig = { ...tcfg, zone: 'Europe/Berlin', dayBoundaryHour: 6 }
  const late = build({ mains: [main({ firstTs: Date.UTC(2026, 8, 21, 23, 30) })], tcfg: berlin })
  assert.equal(late.roots[0].label, 'Session Tue 01:30 · 9d0eb37a')
  // A name has no model: the full name is the name.
  assert.equal(at(NOW - 2 * HOUR).roots[0].fullLabel, 'Session Tue 10:00 · 9d0eb37a')
  assert.equal(node(at(NOW - 2 * HOUR), wfKey).fullLabel, 'Workflow run Tue 10:00 · cfe7718d')
})

test('the names by start time speak German: „Sitzung", „Workflow-Lauf", the weekday words Mo–So', () => {
  const words = ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa']
  // NOW is a Tuesday; each of the six days before it has its own German word.
  for (let back = 0; back < 6; back++) {
    const firstTs = NOW - back * DAY - HOUR
    const vm = german(() => build({ mains: [main({ firstTs })], agents: [wfRec('bbbb0001', { firstTs, lastTs: NOW - MIN })] }))
    const w = words[new Date(firstTs).getUTCDay()]
    assert.equal(vm.roots[0].label, `Sitzung ${w} 11:00 · 9d0eb37a`)
    assert.equal(node(vm, wfKey).label, `Workflow-Lauf ${w} 11:00 · cfe7718d`)
  }
  const dated = german(() => build({ mains: [main({ firstTs: NOW - 10 * DAY })] }))
  assert.equal(dated.roots[0].label, 'Sitzung 2026-09-12 12:00 · 9d0eb37a')
  const bare = german(() => build({ mains: [], runLaunches: [], agents: [rec('aaaa0001', { lastTs: NOW - 30 * MIN, firstTs: NOW - 40 * MIN })] }))
  // 1.7 F2: in the group of earlier sessions, which speaks German too.
  assert.equal(sessionsOf(bare)[0].label, 'Sitzung 9d0eb37a')
  assert.equal(bare.roots[0].label, 'Frühere Sitzungen (1)')
  // The running list's line of where an agent sits: the ids alone, in German.
  const live = german(() => build({ agents: [wfRec('bbbb0001', { lastTs: NOW - MIN })] }))
  assert.equal(live.runningNow[0].context, 'Sitzung 9d0eb37a · Workflow-Lauf cfe7718d')
})

test('the children of a session, a run and an agent are in plain time order, the newest first, whatever their state; the collector last', () => {
  // One session: a run and direct agents side by side, each in another state, their starts
  // interleaved, one launch whose start is its own; and in the run a collector.
  const over: Partial<AgentTreeInput> = {
    agents: [
      rec('aaaa0001', { firstTs: NOW - 50 * MIN, lastTs: NOW - 45 * MIN, outcome: 'failed', outcomeTs: NOW - 45 * MIN }),
      rec('aaaa0002', { firstTs: NOW - 20 * MIN, lastTs: NOW - MIN }),
      rec('aaaa0003', { firstTs: NOW - 35 * MIN, lastTs: NOW - 30 * MIN, outcome: 'completed', outcomeTs: NOW - 30 * MIN }),
      rec('aaaa0004', { firstTs: NOW - 40 * MIN, lastTs: NOW - 35 * MIN, outcome: 'stopped', outcomeStatus: 'killed', outcomeTs: NOW - 35 * MIN }),
      wfRec('bbbb0001', { firstTs: NOW - 25 * MIN, lastTs: NOW - 24 * MIN, outcome: 'completed', outcomeTs: NOW - 24 * MIN }),
      wfRec('bbbb0002', { firstTs: NOW - 5 * MIN, lastTs: NOW - 4 * MIN, outcome: 'failed', outcomeTs: NOW - 4 * MIN }),
      wfRec('bbbb0003', { firstTs: NOW - 15 * MIN, lastTs: NOW - 2 * MIN }),
      // A nested agent's children the same way: the later one first.
      rec('cccc0001', { firstTs: NOW - 12 * MIN, spawnerFile: agentFile('aaaa0003') }),
      rec('cccc0002', { firstTs: NOW - 9 * MIN, spawnerFile: agentFile('aaaa0003') }),
    ],
    launches: [launch('pppp0001', { agentId: null, ts: NOW - 22 * MIN })],
    // The run's journal started one agent no transcript was read of: the collector.
    runs: [run([jagent('bbbb0001', { step: 1 }), jagent('bbbb0002', { step: 2 }), jagent('bbbb0003', { step: 3 }),
      jagent('dddd0001', { step: 4 })])],
  }
  const vm = build(over)
  // The run started with its first agent, 25 minutes ago: between the launch (22) and 0003 (35).
  assert.deepEqual(vm.roots[0].children.map((c) => c.key), [
    agentKey('aaaa0002'), 'l:toolu_pppp0001', wfKey, agentKey('aaaa0003'), agentKey('aaaa0004'), agentKey('aaaa0001'),
  ])
  // Running, unknown, done, stopped and failed mixed in time order — no state ranks before another
  // (the lead's note withdrew N6's order by state: failed first would have put 0001 on top).
  assert.deepEqual(vm.roots[0].children.map((c) => c.state), ['running', 'unknown', 'running', 'done', 'stopped', 'failed'])
  assert.deepEqual(node(vm, wfKey).children.map((c) => c.key), [agentKey('bbbb0002'), agentKey('bbbb0003'), agentKey('bbbb0001'), collectorKey])
  assert.deepEqual(node(vm, agentKey('aaaa0003')).children.map((c) => c.key), [agentKey('cccc0002'), agentKey('cccc0001')])
  // The page's payload the same, and the order does not depend on the order the records came in.
  const opened = page({ ...over, expanded: [rootKey, wfKey] })
  assert.deepEqual(opened.roots[0].children.map((c) => c.key), vm.roots[0].children.map((c) => c.key))
  const shuffled = build({ ...over, agents: [...(over.agents ?? [])].reverse() })
  assert.deepEqual(all(shuffled.roots).map((n) => n.key), all(vm.roots).map((n) => n.key))
  // Roots stay the most recent first by their last activity. 1.7 F2 (pinned and changed): two
  // active sessions for it — a session quiet for half an hour is an earlier one, in the group after
  // the active ones, whatever its start.
  const two = build({ mains: [main({ lastTs: NOW - 8 * MIN, firstTs: NOW - HOUR }), main({ sessionId: S2, lastTs: NOW - MIN, firstTs: NOW - 5 * HOUR })] })
  assert.deepEqual(two.roots.map((r) => r.key), [`s:${S2}`, rootKey])
  const split = build({ mains: [main({ lastTs: NOW - 30 * MIN, firstTs: NOW - HOUR }), main({ sessionId: S2, lastTs: NOW - MIN, firstTs: NOW - 5 * HOUR })] })
  assert.deepEqual(split.roots.map((r) => r.key), [`s:${S2}`, EARLIER_KEY])
  assert.deepEqual(split.roots[1].children.map((r) => r.key), [rootKey])
})

test('byNewestFirst: the later start first, an unknown start after every known one, then the key; a collector always last', () => {
  const e = (key: string, startTs: number | null, kind: TreeNode['kind'] = 'agent'): { key: string; startTs: number | null; kind: TreeNode['kind'] } =>
    ({ key, startTs, kind })
  const list = [e('a:1', 100), e('n:x', null, 'noreply'), e('a:2', 300), e('a:4', null), e('a:3', 300), e('w:y', 200, 'workflow'), e('a:0', null)]
  assert.deepEqual([...list].sort(byNewestFirst).map((x) => x.key), ['a:2', 'a:3', 'w:y', 'a:1', 'a:0', 'a:4', 'n:x'])
  // A collector with the latest start of all is still last.
  assert.deepEqual([e('n:x', 999, 'noreply'), e('a:1', 1)].sort(byNewestFirst).map((x) => x.key), ['a:1', 'n:x'])
})

test('every node and running item carries its start and last activity as clock times for the static words, and none it has no time for', () => {
  const vm = build({
    mains: [main({ firstTs: NOW - 2 * DAY - 3 * HOUR, lastTs: NOW - 2 * MIN })],
    agents: [rec('aaaa0001', { firstTs: NOW - 30 * MIN, lastTs: NOW - MIN })],
    launches: [launch('pppp0001', { agentId: null, ts: NOW - 2 * MIN })],
  })
  const root = vm.roots[0]
  // Today "HH:MM", another day "YYYY-MM-DD HH:MM" — the details' own form.
  assert.deepEqual([root.startClock, root.lastClock], ['2026-09-20 09:00', '11:58'])
  const a = node(vm, agentKey('aaaa0001'))
  assert.deepEqual([a.startClock, a.lastClock], ['11:30', '11:59'])
  const item = vm.runningNow.find((r) => r.key === agentKey('aaaa0001'))
  assert.deepEqual([item?.startClock, item?.lastClock], ['11:30', '11:59'])
  const p = node(vm, 'l:toolu_pppp0001')
  assert.deepEqual([p.startClock, p.lastClock], ['11:58', '11:58'])
  // A session whose own transcript was never read has no time: no clock either.
  // 1.7 F2: in the group of earlier sessions.
  const bare = sessionsOf(build({ mains: [], agents: [rec('aaaa0001', { lastTs: NOW - 30 * MIN, firstTs: NOW - 40 * MIN })] }))[0]
  assert.deepEqual([bare.startTs, bare.startClock, bare.lastTs, bare.lastClock], [null, null, null, null])
  // In the configured zone.
  const ny = build({ tcfg: { ...tcfg, zone: 'America/New_York' }, agents: [rec('aaaa0001', { firstTs: NOW - 30 * MIN, lastTs: NOW - MIN })] })
  assert.equal(node(ny, agentKey('aaaa0001')).startClock, '07:30')
})

// ---------------------------------------------------------------------------
// 1.6 P9 · L2: the details panel, reordered; N8: effort per agent
// ---------------------------------------------------------------------------

/** The rows of a node's details, by label. */
function rowsOf(over: Partial<AgentTreeInput>, key: string): Map<string, DetailRow> {
  return new Map((agentDetails(input(over), NOW, key)?.rows ?? []).map((r) => [r.label, r]))
}

test('an agent\'s details open with its mix, its rank, its context and its pace, then who it is — in the order L2 gives', () => {
  const over: Partial<AgentTreeInput> = {
    agents: [
      wfRec(J1, { lastContext: 12_000, effort: 'xhigh', efforts: ['xhigh'] }),
      wfRec(J2, { input: 3000, lastContext: 900 }),
    ],
  }
  const labels = agentDetails(input(over), NOW, agentKey(J1))?.rows.map((r) => r.label)
  // A workflow agent that no launch names has no "Spawned by": its run started it, the next row says which.
  // 1.6 P13a (O3, pinned and changed): its tool errors after its tool calls, the version that wrote it last.
  assert.deepEqual(labels, [
    'Token mix', 'Rank in run', 'Context at the end', 'Per minute', 'Type', 'Models', 'Effort', 'ID', 'Depth', 'Started', 'Duration',
    'Last activity', 'Requests', 'Usage', 'Fresh input', 'Cache write 5m', 'Cache write 1h', 'Cache read', 'Output', 'Reasoning',
    'Tool calls', 'Tool errors', 'Workflow run', 'Claude Code version',
  ])
  assert.equal(agentDetails(input(over), NOW, agentKey(J1))?.overview, '1.2K in 29 min 00 s · 5 requests · 3 tool calls')
})

test('the token mix: the four kinds in their order, shares summing to 1, a kind without a token left out, a sliver "<1 %"', () => {
  const mix = (over: Partial<AgentRec>): DetailRow | undefined => rowsOf({ agents: [rec('aaaa0001', over)] }, agentKey('aaaa0001')).get('Token mix')
  const full = mix({})
  assert.ok(full?.parts)
  assert.equal(full.kind, 'bar')
  assert.deepEqual(full.parts.map((p) => p.part), ['fresh', 'cacheWrite', 'cacheRead', 'output'])
  assert.ok(Math.abs(full.parts.reduce((sum, p) => sum + p.share, 0) - 1) < 1e-12)
  // Its words are its parts' words, in the same order: what a screen reader and the markdown get.
  assert.equal(full.value, full.parts.map((p) => p.label).join(' · '))
  // No cache write: three parts; a share below half a percent still says it is there.
  const three = mix({ input: 20, cacheWrite: 0, cacheRead: 9000, output: 980 })
  assert.deepEqual(three?.parts?.map((p) => [p.part, p.label]), [['fresh', 'fresh <1 %'], ['cacheRead', 'cache read 90 %'], ['output', 'output 10 %']])
  assert.ok(Math.abs((three?.parts ?? []).reduce((sum, p) => sum + p.share, 0) - 1) < 1e-12)
  // Requests but not a token: no mix to draw. Nothing counted: none either.
  assert.equal(mix({ input: 0, cacheWrite: 0, cacheRead: 0, output: 0 }), undefined)
  assert.equal(mix({ requests: 0, outputFinal: 0 }), undefined)
})

test('the rank in its run, only in a run of two counted agents or more; equal ones share a place', () => {
  const place = (over: Partial<AgentTreeInput>, id: string): string | undefined => rowsOf(over, agentKey(id)).get('Rank in run')?.value
  // Alone with a collector and a journal-only member: no rank — nothing to rank against.
  const alone: Partial<AgentTreeInput> = {
    agents: [wfRec(J1), rejectedOnly(J2, NOW - 5 * MIN)],
    runs: [run([jagent(J1, { step: 1 }), jagent(J2, { step: 2 }), jagent(J3, { step: 3 })])],
  }
  assert.equal(place(alone, J1), undefined)
  const three: Partial<AgentTreeInput> = {
    agents: [wfRec(J1, { input: 5000 }), wfRec(J2), wfRec(J3), rec('aaaa0001', { input: 90_000 })],
  }
  assert.deepEqual([place(three, J1), place(three, J2), place(three, J3)], ['1 of 3 by usage', '2 of 3 by usage', '2 of 3 by usage'])
  // An agent outside a run has no rank, however big.
  assert.equal(place(three, 'aaaa0001'), undefined)
})

test('usage per minute from a minute on, and the context at the end only where there is one', () => {
  const rows = (over: Partial<AgentRec>): Map<string, DetailRow> => rowsOf({ agents: [rec('aaaa0001', over)] }, agentKey('aaaa0001'))
  // 59 s: a burst, not a pace. 60 s: 1 200 in a minute.
  assert.equal(rows({ firstTs: NOW - MIN - 59_000, lastTs: NOW - MIN }).get('Per minute'), undefined)
  assert.equal(PER_MINUTE_FROM_MS, 60_000)
  assert.deepEqual(rows({ firstTs: NOW - MIN - PER_MINUTE_FROM_MS, lastTs: NOW - MIN }).get('Per minute'), { label: 'Per minute', value: '1.2K' })
  assert.equal(rows({ firstTs: NOW - 11 * MIN, lastTs: NOW - MIN }).get('Per minute')?.value, '120')
  // The context: the newest request's, with what it is; a record that does not say is a dash.
  assert.deepEqual(rows({ lastContext: 48_210 }).get('Context at the end'),
    { label: 'Context at the end', value: '48.2K', note: "the last request's input, cache reads and writes" })
  for (const lastContext of [null, 0, -3, Number.NaN, '5000' as unknown as number]) {
    assert.deepEqual(rows({ lastContext }).get('Context at the end'), { label: 'Context at the end', value: '–' }, String(lastContext))
  }
})

test('the line under an agent\'s state says what it came to, one sentence per count that is one', () => {
  const overview = (over: Partial<AgentRec>): string | null | undefined =>
    agentDetails(input({ agents: [rec('aaaa0001', over)] }), NOW, agentKey('aaaa0001'))?.overview
  assert.equal(overview({}), '1.2K in 29 min 00 s · 5 requests · 3 tool calls')
  assert.equal(overview({ requests: 1, outputFinal: 1 }), '1.2K in 29 min 00 s · 1 request · 3 tool calls')
  assert.equal(overview({ toolCalls: 1 }), '1.2K in 29 min 00 s · 5 requests · 1 tool call')
  assert.equal(overview({ requests: 1, outputFinal: 1, toolCalls: 1 }), '1.2K in 29 min 00 s · 1 request · 1 tool call')
  assert.equal(overview({ toolCalls: 0 }), '1.2K in 29 min 00 s · 5 requests · 0 tool calls')
  assert.equal(german(() => overview({ requests: 1, outputFinal: 1, toolCalls: 1 })), '1,2K in 29 min 00 s · 1 Anfrage · 1 Tool-Aufruf')
  assert.equal(german(() => overview({ requests: 1, outputFinal: 1 })), '1,2K in 29 min 00 s · 1 Anfrage · 3 Tool-Aufrufe')
  assert.equal(german(() => overview({ toolCalls: 1 })), '1,2K in 29 min 00 s · 5 Anfragen · 1 Tool-Aufruf')
})

test('parallelism: the most agents of a run at once, over each one\'s first line to its last activity, both ends included', () => {
  assert.equal(mostAtOnce([]), 0)
  assert.equal(mostAtOnce([[0, 10]]), 1)
  // The crafted overlap: at 15 the second ends as the third runs and the fourth starts — three at once.
  assert.equal(mostAtOnce([[0, 10], [5, 15], [12, 20], [15, 16]]), 3)
  // Touching ends count as one moment; apart by a millisecond they do not.
  assert.equal(mostAtOnce([[0, 10], [10, 20]]), 2)
  assert.equal(mostAtOnce([[0, 10], [11, 20]]), 1)
  assert.equal(mostAtOnce([[0, Number.NaN], [3, 4]]), 1)
  // In a run: J1 11:20–11:59, J2 11:25–11:40, J3 11:45–11:50 — two at a time at most; the rejection-
  // only member at 11:47 is one more then, a journal-only member none (it has no time).
  const over: Partial<AgentTreeInput> = {
    agents: [
      wfRec(J1, { firstTs: NOW - 40 * MIN, lastTs: NOW - MIN }),
      wfRec(J2, { firstTs: NOW - 35 * MIN, lastTs: NOW - 20 * MIN }),
      wfRec(J3, { firstTs: NOW - 15 * MIN, lastTs: NOW - 10 * MIN }),
    ],
    runs: [run([jagent(J1), jagent(J2), jagent(J3), jagent(J4)])],
  }
  assert.equal(rowsOf(over, wfKey).get('Parallelism')?.value, 'up to 2 at once')
  const withRejected = { ...over, agents: [...(over.agents ?? []), rejectedOnly('a5b6a79800112233', NOW - 13 * MIN)] }
  assert.equal(rowsOf(withRejected, wfKey).get('Parallelism')?.value, 'up to 3 at once')
  // A run nobody has written to yet — its launch alone —: nothing to sweep, a dash.
  const launched: Partial<AgentTreeInput> = {
    runLaunches: [{ toolUseId: 'toolu_wf1', file: sessionFile(), ts: NOW - MIN, runId: WF, outcome: 'launched', outcomeStatus: null, outcomeTs: null }],
  }
  assert.deepEqual(rowsOf(launched, wfKey).get('Parallelism'), { label: 'Parallelism', value: '–' })
})

test('effort: the row names its replies\' effort, in the order they changed; runs and sessions count their agents by it, a dash for none', () => {
  const effort = (over: Partial<AgentRec>): string | undefined => rowsOf({ agents: [rec('aaaa0001', over)] }, agentKey('aaaa0001')).get('Effort')?.value
  assert.equal(effort({ effort: 'xhigh', efforts: ['xhigh'] }), 'xhigh')
  assert.equal(effort({ effort: 'max', efforts: ['high', 'xhigh', 'max'] }), 'high, then xhigh, then max')
  assert.equal(effort({}), '–')
  // A snapshot of another build's making: checked again, as the aggregator does.
  assert.equal(effort({ effort: 'turbo' as never, efforts: ['M' as never, 'high', 'high'] }), 'high')
  assert.equal(effort({ effort: 'high', efforts: [] }), 'high')
  assert.equal(effort({ effort: 'M' as never, efforts: 'xhigh' as never }), '–')
  assert.equal(german(() => effort({ effort: 'xhigh', efforts: ['high', 'xhigh'] })), 'high, dann xhigh')
  // A run of five: three at xhigh, one at max, one journal-only member and a rejection-only one
  // with none recorded — the most frequent first, the counts summing to its tally's started.
  const over: Partial<AgentTreeInput> = {
    agents: [
      wfRec(J1, { effort: 'xhigh', efforts: ['xhigh'] }), wfRec(J2, { effort: 'xhigh', efforts: ['high', 'xhigh'] }),
      wfRec(J3, { effort: 'max', efforts: ['max'] }), wfRec(J4, { effort: 'xhigh', efforts: ['xhigh'] }),
      rejectedOnly('a5b6a79800112233', NOW - 5 * MIN),
    ],
    runs: [run([jagent(J1), jagent(J2), jagent(J3), jagent(J4), jagent('a6a7980011223344')])],
    launches: [launch('pppp0001', { agentId: null, ts: NOW - MIN })],
    mains: [main()],
  }
  const vm = build(over)
  assert.equal(rowsOf(over, wfKey).get('Agents by effort')?.value, 'xhigh 3 · – 2 · max 1')
  assert.equal(node(vm, wfKey).tally?.started, 6)
  // The session: the run's six and the launch nobody has read a line of.
  assert.equal(rowsOf(over, rootKey).get('Agents by effort')?.value, 'xhigh 3 · – 3 · max 1')
  assert.equal(node(vm, rootKey).tally?.started, 7)
  const sum = (v: string): number => v.split(' · ').reduce((n, part) => n + Number(part.split(' ').pop()), 0)
  assert.equal(sum(rowsOf(over, rootKey).get('Agents by effort')?.value ?? ''), node(vm, rootKey).tally?.started)
  // Ties: by the word, the dash last.
  const tie: Partial<AgentTreeInput> = { agents: [wfRec(J1, { effort: 'xhigh' }), wfRec(J2, { effort: 'high' }), wfRec(J3)] }
  assert.equal(rowsOf(tie, wfKey).get('Agents by effort')?.value, 'high 1 · xhigh 1 · – 1')
  assert.equal(german(() => rowsOf(tie, wfKey).get('Agenten nach Effort')?.value), 'high 1 · xhigh 1 · – 1')
  // A session without an agent has no such row, and a collector none of its own.
  assert.equal(rowsOf({}, rootKey).has('Agents by effort'), false)
  assert.equal(rowsOf(over, collectorKey).has('Agents by effort'), false)
})

test('who spawned an agent: left out for a workflow agent no launch names, kept where a launch or an agent does and for a direct agent', () => {
  const spawned = (over: Partial<AgentTreeInput>, id: string): string | undefined => rowsOf(over, agentKey(id)).get('Spawned by')?.value
  // Its run started it: the Workflow run row says which. 1.5 wrote "Spawned by –" on every one.
  assert.equal(spawned({ agents: [wfRec(J1)] }, J1), undefined)
  assert.equal(rowsOf({ agents: [wfRec(J1)] }, agentKey(J1)).get('Workflow run')?.value, 'Workflow run Tue 11:30 · cfe7718d')
  // A launch in the session's transcript names it: the session.
  assert.equal(spawned({ agents: [wfRec(J1, { spawnerFile: sessionFile() })] }, J1), 'Session Tue 10:00 · 9d0eb37a')
  // Another agent of the run launched it.
  assert.equal(spawned({ agents: [wfRec(J1), wfRec(J2, { spawnerFile: agentFile(J1, S1, WF) })] }, J2),
    'workflow-subagent · claude-opus-5 · 1f2e')
  // A direct agent keeps the row, a dash where nothing names who launched it.
  assert.equal(spawned({ agents: [rec('aaaa0001', { spawnerFile: null, meta: null })] }, 'aaaa0001'), '–')
})

// ---------------------------------------------------------------------------
// 1.6 L3: where the agent tokens of the last 7 days went
// ---------------------------------------------------------------------------

/** A Claude Code agent id of the week's world: `a` and 16 hex digits ending on `tail`. */
const wkId = (tail: string): string => `a${tail.padStart(16, '0')}`

/**
 * The week's world: agents whose tokens are output alone, so a usage is its output and a cost its
 * output at the model's output rate (claude-opus-5 $25, claude-sonnet-5 $10 per million). Explore on
 * opus-5 three times — one of them in a second session —, two workflow agents on opus-5, a Plan
 * agent on sonnet-5, two general-purpose agents on sonnet-5 — one of them written with two models,
 * whose tokens its record cannot split —, an Explore agent on a model without a price, and three
 * that the block leaves out: an agent without a counted request, one older than the seven days, and
 * a launch nobody read a line of.
 */
function weekWorld(): { over: Partial<AgentTreeInput>; ids: Record<string, string> } {
  const ids = {
    e1: wkId('e1'), e2: wkId('e2'), e3: wkId('e3'), w1: wkId('b1'), w2: wkId('b2'), p1: wkId('c1'), m1: wkId('d1'), m2: wkId('d2'),
    u1: wkId('f1'), none: wkId('f2'), old: wkId('f3'),
  }
  const out = (n: number): Partial<AgentRec> => ({ input: 0, cacheWrite: 0, cacheWrite1h: 0, cacheRead: 0, reasoning: 0, output: n })
  const typed = (type: string, model: string | null = null): Partial<AgentRec> =>
    ({ meta: { agentType: type, model, spawnDepth: 1, toolUseId: null, parentAgentId: null }, spawnerFile: null })
  const agents = [
    rec(ids.e1, { ...out(400_000), firstTs: NOW - 50 * MIN }),
    rec(ids.e2, { ...out(100_000), firstTs: NOW - 40 * MIN }),
    rec(ids.e3, { ...out(200_000), sessionId: S2, sessionFile: sessionFile(S2) }),
    wfRec(ids.w1, out(300_000)),
    wfRec(ids.w2, out(100_000)),
    rec(ids.p1, { ...out(50_000), ...typed('Plan'), models: ['claude-sonnet-5'] }),
    rec(ids.m1, { ...out(30_000), ...typed('general-purpose'), models: ['claude-opus-5', 'claude-sonnet-5'] }),
    rec(ids.m2, { ...out(10_000), ...typed('general-purpose'), models: ['claude-sonnet-5'] }),
    rec(ids.u1, { ...out(20_000), models: ['claude-mystery-1'] }),
    // Left out: nothing counted; older than the seven days; and the launch below.
    rec(ids.none, { ...out(0), requests: 0, outputFinal: 0, toolCalls: 0 }),
    rec(ids.old, { ...out(900_000), firstTs: NOW - 9 * DAY, lastTs: NOW - 8 * DAY }),
  ]
  return {
    over: {
      agents, mains: [main(), main({ sessionId: S2 })],
      launches: [launch('pending1', { agentId: null, ts: NOW - 2 * MIN })],
      weekOpen: true,
    },
    ids,
  }
}

test('the 7-day block groups the agents with a counted request by type and model, the largest first — share, median, the largest agents', () => {
  const { over, ids } = weekWorld()
  const vm = build(over)
  const w = vm.week
  assert.ok(w)
  // By the type and the model their names say, the model in full; the row as a page writes it.
  assert.deepEqual(w.rows.map((r) => [r.type, r.model, r.label, r.agents, r.usage, r.share, r.median]), [
    ['Explore', 'claude-opus-5', 'Explore · opus-5', 3, '700K', '58 %', '200K'],
    // Two agents: the median halfway between them.
    ['workflow-subagent', 'claude-opus-5', 'workflow-subagent · opus-5', 2, '400K', '33 %', '200K'],
    ['Plan', 'claude-sonnet-5', 'Plan · sonnet-5', 1, '50K', '4 %', '50K'],
    // The two-model agent under the model its name says — its last.
    ['general-purpose', 'claude-sonnet-5', 'general-purpose · sonnet-5', 2, '40K', '3 %', '20K'],
    ['Explore', 'claude-mystery-1', 'Explore · mystery-1', 1, '20K', '2 %', '20K'],
  ])
  // Every agent once, the ones without a counted request, older than seven days, or never read left out.
  assert.deepEqual([w.agents, w.total, w.other], [9, '1.2M', null])
  const listed = w.top.map((x) => x.key)
  for (const id of [ids.none, ids.old]) assert.equal(listed.includes(agentKey(id)), false, id)
  // The largest agents, the largest first — a tie by key — as their tree rows name them, where they
  // sit as the running list says it, their state as their rows have it.
  assert.equal(TOP_AGENTS, 5)
  assert.deepEqual(w.top.map((x) => [x.key, x.usage, x.share, x.context]), [
    [agentKey(ids.e1), '400K', '33 %', 'Session 9d0eb37a'],
    [agentKey(ids.w1), '300K', '25 %', 'Session 9d0eb37a · Workflow run cfe7718d'],
    [agentKey(ids.e3), '200K', '17 %', 'Session 5f1c2d3e'],
    [agentKey(ids.w2), '100K', '8 %', 'Session 9d0eb37a · Workflow run cfe7718d'],
    [agentKey(ids.e2), '100K', '8 %', 'Session 9d0eb37a'],
  ])
  const e1 = node(vm, agentKey(ids.e1))
  assert.deepEqual([w.top[0].label, w.top[0].fullLabel, w.top[0].state, w.top[0].derived], [e1.label, e1.fullLabel, e1.state, e1.derived])
  // No pricing, no cost: not a column, not a figure, not a dollar anywhere in the block.
  assert.deepEqual([...w.rows.map((r) => r.cost), ...w.top.map((x) => x.cost), w.totalCost], Array(11).fill(null))
  assert.equal(JSON.stringify(w).includes('$'), false)
  // Nothing of the block is an invented zero.
  assert.equal(/"0( |")/.test(JSON.stringify(w)), false, JSON.stringify(w))
})

test('the 7-day block\'s costs only with pricing: ~ for an estimate, – for no price, ⚠ behind a sum that holds only some', () => {
  const { over, ids } = weekWorld()
  const w = build({ ...over, pricing: {} }).week
  assert.ok(w)
  assert.deepEqual(w.rows.map((r) => r.cost), [
    // 400K + 100K + 200K of output at $25 per million.
    '~$17.50',
    '~$10.00',
    '~$0.50',
    // The two-model agent has no price — its record cannot split its tokens between the models —,
    // so the row's sum holds the other one only, and says so.
    '~$0.10 ⚠',
    // A model without a price on file.
    '–',
  ])
  assert.equal(w.totalCost, '~$28.10 ⚠')
  assert.deepEqual(w.top.map((x) => x.cost), ['~$10.00', '~$7.50', '~$5.00', '~$2.50', '~$2.50'])
  // An agent without a price is a dash among the largest too.
  const u1 = build({ ...over, pricing: {}, agents: (over.agents ?? []).filter((r) => r.agentId === ids.u1) }).week
  assert.deepEqual([u1?.top.map((x) => x.cost), u1?.rows.map((r) => r.cost), u1?.totalCost], [['–'], ['–'], '–'])
  // A custom rate is what the tables take too.
  const custom = build({ ...over, pricing: { multiplier: 0.5 } }).week
  assert.equal(custom?.rows[0].cost, '~$8.75')
})

test('the 7-day block: at most WEEK_ROWS rows, the rest in one line — one other combination, or {0} — in English and in German', () => {
  const many = (n: number): AgentRec[] => Array.from({ length: n }, (_, i) =>
    rec(wkId('9' + i.toString(16)), { meta: { agentType: `type-${String(i).padStart(2, '0')}`, model: null, spawnDepth: 1, toolUseId: null, parentAgentId: null },
      input: 0, cacheWrite: 0, cacheRead: 0, output: 1000 * (n - i) }))
  assert.equal(WEEK_ROWS, 10)
  const twelve = build({ agents: many(12), weekOpen: true }).week
  assert.ok(twelve)
  assert.equal(twelve.rows.length, WEEK_ROWS)
  // The largest first: type-00 used the most.
  assert.deepEqual(twelve.rows.map((r) => r.type), Array.from({ length: 10 }, (_, i) => `type-${String(i).padStart(2, '0')}`))
  assert.equal(twelve.other, '2 other combinations')
  // The block's total and its count hold the rows it does not list.
  assert.deepEqual([twelve.agents, twelve.total], [12, compact(78_000)])
  assert.equal(build({ agents: many(11), weekOpen: true }).week?.other, '1 other combination')
  assert.equal(build({ agents: many(10), weekOpen: true }).week?.other, null)
  const de = german(() => [build({ agents: many(12), weekOpen: true }).week?.other, build({ agents: many(11), weekOpen: true }).week?.other])
  assert.deepEqual(de, ['2 weitere Kombinationen', '1 weitere Kombination'])
  // A record without a type is an "Agent", as its name says it — „Agent" in German as well.
  const bare = build({ agents: [rec(wkId('aa'), { meta: null })], launches: [], weekOpen: true }).week
  assert.deepEqual(bare?.rows.map((r) => [r.type, r.model]), [['Agent', 'claude-opus-5']])
  // No agent with a counted request: an empty block, no invented figure.
  const empty = build({ agents: [rec(wkId('ab'), { requests: 0, output: 0, outputFinal: 0 })], weekOpen: true }).week
  assert.deepEqual(empty, { rows: [], other: null, top: [], total: '–', totalCost: null, agents: 0 })
  assert.deepEqual(build({ agents: [], weekOpen: true, pricing: {} }).week?.totalCost, '–')
})

test('medianOf: the middle one, or halfway between the two in the middle; none is no median', () => {
  assert.equal(medianOf([3]), 3)
  assert.equal(medianOf([5, 1, 3]), 3)
  assert.equal(medianOf([1, 3]), 2)
  assert.equal(medianOf([4, 1, 3, 2]), 2.5)
  assert.ok(Number.isNaN(medianOf([])))
  const xs = [9, 2, 7]
  medianOf(xs)
  assert.deepEqual(xs, [9, 2, 7], 'the input was sorted in place')
})

test('the 7-day block is built only while it is open; the markdown\'s tree carries it too', () => {
  const { over } = weekWorld()
  assert.equal(build({ ...over, weekOpen: false }).week, null)
  assert.equal(build({ ...over, weekOpen: undefined }).week, null)
  assert.equal(page({ ...over, weekOpen: false }).week, null)
  assert.deepEqual(page(over).week, build(over).week)
})

test('the 7-day block\'s largest agents are rows on the page: their details open inside a closed branch and beyond MAX_ROOTS (§3.0 b)', () => {
  const { over, ids } = weekWorld()
  // Finished, so the running list does not name it; the tree closed, so the tree has no row for it.
  const done = (r: AgentRec): AgentRec => {
    const last = Math.min(r.lastTs, NOW - 30 * MIN)
    return { ...r, outcome: 'completed', outcomeTs: last, outcomeStatus: 'completed', lastTs: last, firstTs: Math.min(r.firstTs, last) }
  }
  const agents = (over.agents ?? []).map(done)
  const picked = agentKey(ids.e1)
  const closed = page({ ...over, agents, weekOpen: false, selected: picked })
  assert.equal(closed.runningNow.length, 1, 'only the launch runs')
  assert.equal(closed.selected, null)
  assert.equal(closed.note, null)
  const open = page({ ...over, agents, selected: picked })
  assert.equal(open.selected?.key, picked)
  assert.equal(open.note, null)
  // A session beyond MAX_ROOTS: twenty sessions more recent than the one of the largest agent.
  const recent = Array.from({ length: MAX_ROOTS }, (_, i) => main({ sessionId: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
    lastTs: NOW - MIN }))
  const far = { ...over, agents, mains: [...recent, main({ sessionId: S1, lastTs: NOW - 5 * HOUR })], selected: picked }
  const gone = page({ ...far, weekOpen: false })
  assert.equal(gone.roots.some((r) => r.key === rootKey), false, 'the session is listed')
  assert.equal(gone.selected, null)
  assert.equal(gone.note, 'The selected node is no longer in the tree.')
  const named = page(far)
  assert.equal(named.week?.top[0].key, picked)
  assert.equal(named.selected?.key, picked)
  assert.equal(named.note, null)
})

test('the 7-day block\'s rows count against MAX_PAGE_NODES: the tree has that many fewer places, the selection still first', () => {
  // One session, 42 runs of 50 agents of four types, every node opened: 1 + 42 + 39 × 50 = 1993
  // nodes fit the cap; with the block open — four rows and five largest agents — 1991 places are
  // left, and 38 runs.
  const runs = 42
  const wfOf = (i: number): string => `wf_${String(i).padStart(8, '0')}-000`
  const types = ['workflow-subagent', 'Explore', 'Plan', 'general-purpose']
  const agents = Array.from({ length: runs * 50 }, (_, n) => wfRec(hexId(n), {
    workflowId: wfOf(Math.floor(n / 50)), meta: { agentType: types[n % 4], model: null, spawnDepth: 1, toolUseId: null, parentAgentId: null },
    firstTs: NOW - 5 * HOUR + n * 1000, lastTs: NOW - 2 * HOUR, outcome: 'completed', outcomeTs: NOW - 2 * HOUR,
  }))
  const expanded = [rootKey, ...Array.from({ length: runs }, (_, i) => `w:${S1}|${wfOf(i)}`)]
  const shipped = (vm: AgentTreeVm): number => vm.roots[0].children.filter((w) => w.children.length > 0).length
  const closed = page({ agents, expanded })
  assert.equal(shipped(closed), 39)
  const open = page({ agents, expanded, weekOpen: true })
  assert.deepEqual([open.week?.rows.length, open.week?.top.length], [4, 5])
  assert.equal(shipped(open), 38)
  assert.ok(all(open.roots).length + 9 <= MAX_PAGE_NODES, String(all(open.roots).length))
  // The selection's path is still placed first: a selected agent of the oldest run.
  const picked = agentKey(hexId(7))
  const both = page({ agents, expanded, weekOpen: true, selected: picked })
  assert.equal(node(both, picked).key, picked)
  assert.equal(both.selected?.key, picked)
  assert.ok(all(both.roots).length + 9 <= MAX_PAGE_NODES)
})


// ---------------------------------------------------------------------------
// 1.6 O3 · further metadata without content (§0a.6–0a.11)
// ---------------------------------------------------------------------------

test('an agent\'s details say its tool errors, its cache misses, its compactions, its version and its mode — each only as far as it was counted (1.6 O3)', () => {
  const o3: Partial<AgentRec> = {
    toolCalls: 41, toolErrors: 3,
    cacheMisses: { unavailable: 1, model_changed: 2 }, cacheMissedTokens: 48_210,
    compactions: 2, lastCompaction: { at: NOW - 30 * MIN, trigger: 'auto', preTokens: 167_200, postTokens: 12_400 },
    ccVersion: '2.1.281', permissionMode: 'plan',
  }
  const rows = rowsOf({ agents: [rec('aaaa0001', o3)] }, agentKey('aaaa0001'))
  assert.deepEqual(rows.get('Tool errors'), { label: 'Tool errors', value: '3 of 41 tool calls' })
  // The most frequent reason first; the tokens the misses stated, as the row's note.
  assert.deepEqual(rows.get('Cache misses'), {
    label: 'Cache misses', value: 'model changed 2 · cache unavailable 1', note: '48.2K tokens not read from the cache', kind: 'sentence',
  })
  assert.deepEqual(rows.get('Compactions'), {
    label: 'Compactions', value: '2 · last at 11:30 (auto, 167.2K → 12.4K)', kind: 'sentence',
  })
  assert.deepEqual(rows.get('Claude Code version'), { label: 'Claude Code version', value: '2.1.281' })
  // The word as Claude Code writes it.
  assert.deepEqual(rows.get('Permission mode'), { label: 'Permission mode', value: 'plan' })
  // In the order L2 gives the counts and the identity: what went wrong beside the tool calls, the
  // version and the mode after its run, before Claude Code's report.
  const labels = agentDetails(input({ agents: [rec('aaaa0001', o3)], launches: [launch('aaaa0001', { totals: { tokens: 1, durationMs: 1, toolUses: 1 } })] }),
    NOW, agentKey('aaaa0001'))?.rows.map((r) => r.label) ?? []
  const at = (label: string): number => labels.indexOf(label)
  assert.deepEqual(['Tool calls', 'Tool errors', 'Cache misses', 'Compactions', 'Spawned by', 'Workflow run', 'Claude Code version',
    'Permission mode', 'Report from Claude Code'].map(at), [...Array(9).keys()].map((i) => at('Tool calls') + i), labels.join(', '))

  // Every reason in its words, by frequency, ties in the order Claude Code's reasons are listed.
  const every = rowsOf({ agents: [rec('aaaa0001', { cacheMisses: {
    system_changed: 1, tools_changed: 1, model_changed: 1, messages_changed: 1, unavailable: 1, previous_message_not_found: 1,
  } })] }, agentKey('aaaa0001')).get('Cache misses')
  assert.equal(every?.value, 'previous message not found 1 · cache unavailable 1 · messages changed 1 · model changed 1 · tools changed 1 · system prompt changed 1')
  // No figure stated — an unavailable cache states none —: no note, never "0 tokens".
  assert.equal(rowsOf({ agents: [rec('aaaa0001', { cacheMisses: { unavailable: 4 }, cacheMissedTokens: 0 })] }, agentKey('aaaa0001'))
    .get('Cache misses')?.note, undefined)
  // A compaction whose line gave no trigger and no figures: dashes in their places; one without a time: the count alone.
  assert.equal(rowsOf({ agents: [rec('aaaa0001', { compactions: 1, lastCompaction: { at: NOW - 30 * MIN, trigger: null, preTokens: null, postTokens: null } })] },
    agentKey('aaaa0001')).get('Compactions')?.value, '1 · last at 11:30 (–, – → –)')
  assert.equal(rowsOf({ agents: [rec('aaaa0001', { compactions: 1, lastCompaction: null })] }, agentKey('aaaa0001')).get('Compactions')?.value, '1')
  assert.equal(rowsOf({ agents: [rec('aaaa0001', { compactions: 1, lastCompaction: { at: NOW - 30 * MIN, trigger: 'manual', preTokens: 90_000, postTokens: 8000 } })] },
    agentKey('aaaa0001')).get('Compactions')?.value, '1 · last at 11:30 (manual, 90K → 8K)')

  // Nothing of it recorded: no tool errors row without a tool call, no misses, no compactions, no
  // mode; the version a dash. A record that does not count its tool errors (restored from before
  // O3, never read again) has no row either — a zero there would be one nobody counted.
  const none = rowsOf({ agents: [rec('aaaa0001', { toolCalls: 0 })] }, agentKey('aaaa0001'))
  assert.deepEqual(['Tool errors', 'Cache misses', 'Compactions', 'Permission mode'].map((l) => none.has(l)), [false, false, false, false])
  assert.equal(none.get('Claude Code version')?.value, '–')
  assert.equal(rowsOf({ agents: [rec('aaaa0001')] }, agentKey('aaaa0001')).get('Tool errors')?.value, '0 of 3 tool calls', 'a measured zero')
  assert.equal(rowsOf({ agents: [rec('aaaa0001', { toolErrors: null })] }, agentKey('aaaa0001')).has('Tool errors'), false)
  // A snapshot of another build's making: every value checked again.
  const hostile = rowsOf({ agents: [rec('aaaa0001', {
    toolErrors: -2, cacheMisses: { weather_changed: 3, model_changed: 1.5, unavailable: -1 } as AgentRec['cacheMisses'], cacheMissedTokens: Number.NaN,
    compactions: 2.5, ccVersion: '2.1.281<script>', permissionMode: 'turbo' as AgentRec['permissionMode'],
  })] }, agentKey('aaaa0001'))
  assert.deepEqual(['Tool errors', 'Cache misses', 'Compactions', 'Permission mode'].map((l) => hostile.has(l)), [false, false, false, false])
  assert.equal(hostile.get('Claude Code version')?.value, '–')
  for (const version of ['synthetic', '1.2', '1.2.3.4', '1234.1.1', 7]) {
    assert.equal(rowsOf({ agents: [rec('aaaa0001', { ccVersion: version as string })] }, agentKey('aaaa0001')).get('Claude Code version')?.value, '–', String(version))
  }
})

test('a session\'s details say how often its own transcript was compacted, which Claude Code wrote it and in which permission mode (1.6 O3)', () => {
  const over: Partial<AgentTreeInput> = {
    mains: [main({ ccVersion: '2.1.281', permissionMode: 'bypassPermissions', compactions: 1,
      lastCompaction: { at: NOW - 90 * MIN, trigger: 'manual', preTokens: 180_000, postTokens: 21_000 } })],
    agents: [rec('aaaa0001')],
  }
  const s = agentDetails(input(over), NOW, rootKey)
  assert.ok(s)
  const labels = s.rows.map((r) => r.label)
  assert.deepEqual(labels, [
    'Own transcript', 'Agents, last 7 days', 'Models', 'Since first line', 'Span', 'Last activity', 'Requests',
    'Fresh input', 'Cache write 5m', 'Cache write 1h', 'Cache read', 'Output', 'Reasoning', 'Tool calls', 'Compactions', 'Agents',
    'Agents by effort', 'Claude Code version', 'Permission mode', 'ID',
  ])
  const v = (label: string): DetailRow | undefined => s.rows.find((r) => r.label === label)
  assert.equal(v('Compactions')?.value, '1 · last at 10:30 (manual, 180K → 21K)')
  assert.deepEqual([v('Claude Code version')?.value, v('Permission mode')?.value], ['2.1.281', 'bypassPermissions'])
  // A session's record counts neither tool errors nor cache misses (an agent's do): no such rows.
  assert.equal(labels.includes('Tool errors') || labels.includes('Cache misses'), false)
  // A session without its own record: the version a dash, nothing else of O3.
  const bare = agentDetails(input({ ...over, mains: [] }), NOW, rootKey)?.rows.map((r) => [r.label, r.value]) ?? []
  assert.deepEqual(bare.filter(([l]) => ['Compactions', 'Claude Code version', 'Permission mode'].includes(l)), [['Claude Code version', '–']])
})

test('the O3 rows speak German with the bundle the extension ships (1.6 O3)', () => {
  // 1.14 P2 (pinned and changed: the German „um {n}" before a clock stamp → a label or brackets — „zuletzt: 11:30" — §3 B2 rule 3).
  const over: Partial<AgentTreeInput> = {
    agents: [rec('aaaa0001', {
      toolCalls: 41, toolErrors: 3, cacheMisses: { previous_message_not_found: 2, system_changed: 1, tools_changed: 1, messages_changed: 1 },
      cacheMissedTokens: 1_250, compactions: 2,
      lastCompaction: { at: NOW - 30 * MIN, trigger: 'auto', preTokens: 167_200, postTokens: 12_400 }, ccVersion: '2.1.281',
    })],
    mains: [main({ compactions: 1, lastCompaction: { at: NOW - 90 * MIN, trigger: 'manual', preTokens: 180_000, postTokens: 21_000 }, permissionMode: 'plan' })],
  }
  const de = german(() => rowsOf(over, agentKey('aaaa0001')))
  assert.equal(de.get('Tool-Fehler')?.value, '3 von 41 Tool-Aufrufen')
  assert.deepEqual([de.get('Cache-Fehltreffer')?.value, de.get('Cache-Fehltreffer')?.note],
    ['vorherige Nachricht nicht gefunden 2 · Nachrichten geändert 1 · Tools geändert 1 · Systemprompt geändert 1',
      '1,3K Token nicht aus dem Cache gelesen'])
  assert.equal(de.get('Kompaktierungen')?.value, '2 · zuletzt: 11:30 (automatisch, 167,2K → 12,4K)')
  assert.equal(de.get('Claude-Code-Version')?.value, '2.1.281')
  const models = german(() => rowsOf({ agents: [rec('aaaa0001', { cacheMisses: { model_changed: 1, unavailable: 1 } })] }, agentKey('aaaa0001')))
  assert.equal(models.get('Cache-Fehltreffer')?.value, 'Cache nicht verfügbar 1 · Modell gewechselt 1')
  const session = german(() => new Map((agentDetails(input(over), NOW, rootKey)?.rows ?? []).map((r) => [r.label, r.value])))
  assert.equal(session.get('Kompaktierungen'), '1 · zuletzt: 10:30 (manuell, 180K → 21K)')
  // The mode is Claude Code's own word, in either language.
  assert.equal(session.get('Berechtigungsmodus'), 'plan')
})

test('an agent whose sidecar names its parent hangs under it when no launch names a spawner — never outside its run (1.6 O3, §0a.11)', () => {
  const parent = 'aaaa0001'
  const child = 'aaaa0002'
  const withParent = (id: string, over: Partial<AgentRec> = {}): AgentRec => rec(id, {
    spawnerFile: null, firstTs: NOW - 20 * MIN,
    meta: { agentType: 'Plan', model: 'opus', spawnDepth: 2, toolUseId: null, parentAgentId: parent }, ...over,
  })
  const over: Partial<AgentTreeInput> = { agents: [rec(parent), withParent(child)], expanded: [rootKey, agentKey(parent)], mode: 'page' }
  const vm = build(over)
  assert.deepEqual(node(vm, agentKey(parent)).children.map((c) => c.key), [agentKey(child)])
  assert.equal(rowsOf(over, agentKey(child)).get('Spawned by')?.value, node(vm, agentKey(parent)).fullLabel)
  // The export names it as its spawner too, by id.
  assert.equal(agentRecordViews(input(over), NOW).find((r) => r.agentId === child)?.spawnedBy, parent)
  // A launch that names a spawner wins over the sidecar's parent.
  const launched = { ...over, agents: [rec(parent), withParent(child, { spawnerFile: sessionFile() })] }
  assert.equal(node(build(launched), agentKey(child)).key, agentKey(child))
  assert.deepEqual(build(launched).roots[0].children.map((c) => c.key).sort(), [agentKey(parent), agentKey(child)].sort())
  assert.equal(rowsOf(launched, agentKey(child)).get('Spawned by')?.value, 'Session Tue 10:00 · 9d0eb37a')
  // A parent the session does not hold, or the agent itself: no link — the session holds it, and nobody spawned it that the tree knows.
  for (const id of ['ffff9999', child]) {
    const orphan = { ...over, agents: [rec(parent), withParent(child, { meta: { agentType: 'Plan', model: 'opus', spawnDepth: 2, toolUseId: null, parentAgentId: id } })] }
    assert.ok(build(orphan).roots[0].children.some((c) => c.key === agentKey(child)), id)
    assert.equal(rowsOf(orphan, agentKey(child)).get('Spawned by')?.value, '–', id)
    assert.equal(agentRecordViews(input(orphan), NOW).find((r) => r.agentId === child)?.spawnedBy, null, id)
  }
  // An agent of a workflow run whose parent is outside the run stays in the run; the row still names who spawned it.
  const inRun = { ...over, agents: [rec(parent), wfRec(child, { meta: { agentType: 'workflow-subagent', model: null, spawnDepth: 2, toolUseId: null, parentAgentId: parent } })],
    expanded: [rootKey, wfKey] }
  assert.deepEqual(node(build(inRun), wfKey).children.map((c) => c.key), [agentKey(child)])
  assert.equal(rowsOf(inRun, agentKey(child)).get('Spawned by')?.value, node(build(inRun), agentKey(parent)).fullLabel)
})

// ---------------------------------------------------------------------------
// 1.7 F2 · earlier sessions: one closed group
// ---------------------------------------------------------------------------

/**
 * 1.7 F2: three active sessions — a minute, two and three minutes quiet —, twenty-five idle ones —
 * half an hour apart from half an hour on — and one whose own transcript was never read (state
 * unknown), its agent last seen between the fifth and the sixth idle one.
 */
function earlierWorld(): { over: Partial<AgentTreeInput>; active: string[]; earlier: string[]; unknown: string } {
  const active = [0, 1, 2].map((i) => `act0000${i}-0000-4000-8000-000000000000`)
  const idle = Array.from({ length: 25 }, (_, i) => `idl000${String(i).padStart(2, '0')}-0000-4000-8000-000000000000`)
  const unknown = 'unk00000-0000-4000-8000-000000000000'
  const mains = [
    ...active.map((sessionId, i) => main({ sessionId, lastTs: NOW - (i + 1) * MIN, firstTs: NOW - HOUR })),
    ...idle.map((sessionId, i) => main({ sessionId, lastTs: NOW - (30 + 30 * i) * MIN, firstTs: NOW - (90 + 30 * i) * MIN })),
  ]
  const agents = [rec('dddd0001', { sessionId: unknown, firstTs: NOW - 170 * MIN, lastTs: NOW - 165 * MIN })]
  // By recency: the five idle ones up to 150 min, the unknown one at 165, then the rest.
  const earlier = [...idle.slice(0, 5), unknown, ...idle.slice(5)]
  return { over: { mains, agents }, active, earlier, unknown }
}

test('1.7 F2: the active sessions are the roots, every other one — idle or unknown — is in one group after them, MAX_ROOTS of them', () => {
  const w = earlierWorld()
  const vm = build(w.over)
  // Three sessions and the group, always the last root.
  assert.deepEqual(vm.roots.map((r) => r.kind), ['session', 'session', 'session', 'group'])
  assert.deepEqual(vm.roots.slice(0, 3).map((r) => r.key), w.active.map((s) => `s:${s}`))
  assert.ok(vm.roots.slice(0, 3).every((r) => r.state === 'active'))
  const g = vm.roots[3]
  // Its words count the sessions it holds — MAX_ROOTS of the twenty-six — and the rest are the
  // note's: 26 − 20.
  assert.deepEqual([g.key, g.label, g.fullLabel], [EARLIER_KEY, 'Earlier sessions (20)', 'Earlier sessions (20)'])
  assert.equal(vm.omittedRoots, 6)
  assert.deepEqual([g.hasChildren, g.childrenTotal, g.childrenMore], [true, MAX_ROOTS, 0])
  // The newest first, the unknown session among them by its time — between the fifth and the sixth.
  assert.deepEqual(g.children.map((c) => c.key), w.earlier.slice(0, MAX_ROOTS).map((s) => `s:${s}`))
  assert.deepEqual([g.children[5].key, g.children[5].state], [`s:${w.unknown}`, 'unknown'])
  assert.ok(g.children.every((c) => c.kind === 'session' && c.state !== 'active'))
  // A container: dashes, no start, its newest member's last activity, no marker of any kind.
  assert.deepEqual([g.state, g.derived, g.usage, g.usageAgents, g.duration, g.startTs, g.startClock, g.lastTs, g.lastClock],
    ['idle', true, '–', null, '–', null, null, NOW - 30 * MIN, '11:30'])
  assert.deepEqual([g.hookWait, g.silence, g.superseded, g.lowerBound, g.lowerBoundText, g.sub], [null, false, false, false, null, null])
  // Its tally is the one agent below it — the unknown session's —, and so is its count.
  assert.deepEqual([g.tallyText, g.agentCount], ['1 started · ~1 ?', 1])
  // A session sits in one place only.
  const keys = all(vm.roots).filter((n) => n.kind === 'session').map((n) => n.key)
  assert.equal(new Set(keys).size, keys.length)
  assert.equal(keys.length, 3 + MAX_ROOTS)
  // The page as it starts: the group closed — one row of the payload, what it holds counted.
  const shut = page(w.over)
  assert.deepEqual(shut.roots.map((r) => r.key), vm.roots.map((r) => r.key))
  assert.deepEqual([shut.roots[3].children, shut.roots[3].childrenTotal, shut.roots[3].label], [[], MAX_ROOTS, 'Earlier sessions (20)'])
  assert.equal(all(shut.roots).length, 3 + 1, 'the closed group is one node of the payload')
  // Opened, its sessions come — and count — only then (1.6 D3), each closed itself.
  const opened = page({ ...w.over, expanded: [EARLIER_KEY] })
  assert.equal(all(opened.roots).length, 3 + 1 + MAX_ROOTS)
  assert.deepEqual(opened.roots[3].children.map((c) => c.key), g.children.map((c) => c.key))
  // Past MAX_ROOTS among the active sessions too: those are counted in the same note.
  const many = build({ mains: [...activeMains(MAX_ROOTS + 2), ...(w.over.mains ?? [])], agents: w.over.agents })
  assert.equal(many.roots.filter((r) => r.kind === 'session').length, MAX_ROOTS)
  assert.equal(many.omittedRoots, 2 + 3 + 6)
})

test('1.7 F2: the group counts what its sessions\' agents came to, closed or open — their tallies summed, not the rows it ships', () => {
  const E1 = 'eeee0001-0000-4000-8000-000000000000'
  const E2 = 'eeee0002-0000-4000-8000-000000000000'
  const E3 = 'eeee0003-0000-4000-8000-000000000000'
  const quiet = (sessionId: string, h: number): MainRec => main({ sessionId, lastTs: NOW - h * HOUR, firstTs: NOW - (h + 1) * HOUR })
  const past = (id: string, sessionId: string, over: Partial<AgentRec> = {}): AgentRec =>
    rec(id, { sessionId, firstTs: NOW - 3 * HOUR, lastTs: NOW - 2 * HOUR - 30 * MIN, ...over })
  const over: Partial<AgentTreeInput> = {
    mains: [main(), quiet(E1, 1), quiet(E2, 2), quiet(E3, 3)],
    agents: [
      rec('aaaa0001'),
      past('bbbb0001', E1, { outcome: 'completed', outcomeTs: NOW - 2 * HOUR - 30 * MIN }),
      past('bbbb0002', E1, { outcome: 'failed', outcomeTs: NOW - 2 * HOUR - 30 * MIN }),
      past('bbbb0003', E1, { outcome: 'completed', outcomeTs: NOW - 2 * HOUR - 30 * MIN }),
      past('cccc0001', E2, { outcome: 'stopped', outcomeStatus: 'killed', outcomeTs: NOW - 2 * HOUR - 30 * MIN }),
      past('cccc0002', E2),
    ],
  }
  const vm = build(over)
  const g = vm.roots[vm.roots.length - 1]
  assert.equal(g.kind, 'group')
  assert.deepEqual(g.children.map((c) => c.key), [`s:${E1}`, `s:${E2}`, `s:${E3}`])
  // Field by field the sum of its sessions' own tallies — the one without agents has none.
  assert.equal(g.children[2].tally, null)
  const sum = { started: 0, done: 0, failed: 0, retried: 0, stopped: 0, running: 0, unknown: 0 }
  for (const c of g.children) for (const k of Object.keys(sum) as Array<keyof typeof sum>) sum[k] += c.tally?.[k] ?? 0
  assert.deepEqual(g.tally, sum)
  assert.deepEqual(sum, { started: 5, done: 2, failed: 1, retried: 0, stopped: 1, running: 0, unknown: 1 })
  assert.equal(g.tallyText, '5 started · 2 ✓ · 1 ✕ · 1 ■ · ~1 ?')
  assert.equal(g.tallySpoken, '5 started, 2 done, 1 failed, 1 stopped, about 1 unknown')
  assert.equal(g.agentCount, g.children.reduce((n, c) => n + c.agentCount, 0))
  // Closed, as the page starts, it ships none of them and says the same.
  const shut = page(over).roots[vm.roots.length - 1]
  assert.deepEqual([shut.key, shut.children], [EARLIER_KEY, []])
  assert.deepEqual([shut.tally, shut.tallyText, shut.tallySpoken, shut.agentCount], [g.tally, g.tallyText, g.tallySpoken, g.agentCount])
  // Sessions none of which has an agent: no tally — a dash on the page, never "0 started".
  const none = build({ mains: [main(), quiet(E3, 3)] })
  assert.deepEqual([none.roots[1].kind, none.roots[1].tally, none.roots[1].tallyText, none.roots[1].agentCount], ['group', null, null, 0])
})

test('1.7 F2: a session moves out of the group when an agent of it starts running, and the running list is the same with and without the group', () => {
  const quietSession = main({ lastTs: NOW - 30 * MIN, firstTs: NOW - 2 * HOUR })
  const before: Partial<AgentTreeInput> = { mains: [quietSession], agents: [rec('aaaa0001', { firstTs: NOW - 40 * MIN, lastTs: NOW - 20 * MIN })] }
  const was = build(before)
  assert.deepEqual(was.roots.map((r) => r.key), [EARLIER_KEY])
  assert.deepEqual(was.roots[0].children.map((c) => [c.key, c.state]), [[rootKey, 'idle']])
  // A line a minute ago: the agent runs, the session is active by the roll-up — a root again, and
  // its sentence says why.
  const after: Partial<AgentTreeInput> = { ...before, agents: [rec('aaaa0001', { firstTs: NOW - 40 * MIN, lastTs: NOW - MIN })] }
  const now = build(after)
  assert.deepEqual(now.roots.map((r) => [r.key, r.state]), [[rootKey, 'active']])
  assert.equal(stateText(after, rootKey), 'Active — inferred: an agent of this session is running.')
  // The running list is built before the split: every key, in the same order, with and without it —
  // and no running node is ever inside the group.
  for (const over of [before, after, earlierWorld().over, { ...earlierWorld().over, agents: [...(earlierWorld().over.agents ?? []), rec('ffff0001', { sessionId: 'idl00007-0000-4000-8000-000000000000' })] }]) {
    for (const mode of ['page', 'text'] as const) {
      const split = buildAgentTree(input({ ...over, mode }), NOW)
      const flat = buildAgentTree(input({ ...over, mode, split: false }), NOW)
      assert.deepEqual([split.running, split.runningNow, split.runningMore], [flat.running, flat.runningNow, flat.runningMore], mode)
      const group = split.roots.find((r) => r.kind === 'group')
      if (group) assert.equal(all(group.children).some((n) => n.state === 'running'), false, 'a running node in the group')
      // Without the split every session is a root, as in 1.6.
      assert.equal(flat.roots.some((r) => r.kind === 'group'), false)
    }
  }
})

test('1.7 F2: no earlier session, no group; no active one, the group alone; nothing at all, the 1.6 note', () => {
  const onlyActive = build({ mains: [main(), main({ sessionId: S2, lastTs: NOW - 3 * MIN })] })
  assert.deepEqual(onlyActive.roots.map((r) => r.kind), ['session', 'session'])
  const onlyEarlier = build({ mains: [main({ lastTs: NOW - 3 * HOUR }), main({ sessionId: S2, lastTs: NOW - 2 * HOUR })] })
  assert.deepEqual(onlyEarlier.roots.map((r) => [r.kind, r.label]), [['group', 'Earlier sessions (2)']])
  assert.deepEqual(onlyEarlier.roots[0].children.map((c) => c.key), [`s:${S2}`, rootKey])
  assert.equal(onlyEarlier.note, null)
  const nothing = build({ mains: [] })
  assert.deepEqual([nothing.roots, nothing.note, nothing.omittedRoots], [[], 'No Claude Code session in the last 7 days.', 0])
  // In German, the group's words too.
  assert.equal(german(() => build({ mains: [main({ lastTs: NOW - 3 * HOUR })] })).roots[0].label, 'Frühere Sitzungen (1)')
})

test('1.7 F2: a node inside the closed group has no panel and no note; opened, its details come back; the group itself has none', () => {
  const E1 = 'eeee0001-0000-4000-8000-000000000000'
  const over: Partial<AgentTreeInput> = {
    mains: [main(), main({ sessionId: E1, lastTs: NOW - 2 * HOUR, firstTs: NOW - 3 * HOUR })],
    agents: [rec('bbbb0001', { sessionId: E1, firstTs: NOW - 3 * HOUR, lastTs: NOW - 2 * HOUR - 10 * MIN, outcome: 'completed', outcomeTs: NOW - 2 * HOUR - 10 * MIN })],
  }
  const agent = agentKey('bbbb0001')
  const session = `s:${E1}`
  // Closed: no row for it on the page, so no panel — and no note, since opening the group brings it back.
  const shut = page({ ...over, selected: agent })
  assert.deepEqual([shut.selected, shut.note], [null, null])
  // The group open, the session closed: still inside a closed branch.
  const half = page({ ...over, selected: agent, expanded: [EARLIER_KEY] })
  assert.deepEqual([half.selected, half.note], [null, null])
  // Both open: its details, as anywhere in the tree; the session's own too.
  const opened = page({ ...over, selected: agent, expanded: [EARLIER_KEY, session] })
  assert.deepEqual([opened.selected?.key, opened.selected?.state, opened.note], [agent, 'done', null])
  assert.deepEqual(opened.selected, agentDetails(input(over), NOW, agent))
  assert.equal(page({ ...over, selected: session, expanded: [EARLIER_KEY] }).selected?.key, session)
  // The markdown prints every node, so it has the details wherever the node sits.
  assert.equal(build({ ...over, selected: agent }).selected?.key, agent)
  // The group has no details: a stored selection of it — none can be made — opens none and leaves no note.
  for (const expanded of [[], [EARLIER_KEY]]) {
    const g = page({ ...over, selected: EARLIER_KEY, expanded })
    assert.deepEqual([g.selected, g.note], [null, null], expanded.join())
  }
  assert.deepEqual([build({ mains: [main()], selected: EARLIER_KEY }).selected, build({ mains: [main()], selected: EARLIER_KEY }).note], [null, null])
  assert.equal(agentDetails(input(over), NOW, EARLIER_KEY), null)
  // A selected session that turns idle moves into the group, which stays closed: nothing opens by itself.
  const selectedActive = page({ mains: [main()], selected: rootKey, expanded: [] })
  assert.equal(selectedActive.selected?.key, rootKey)
  const turnedIdle = page({ mains: [main({ lastTs: NOW - 20 * MIN })], selected: rootKey, expanded: [] })
  assert.deepEqual([turnedIdle.roots.map((r) => r.key), turnedIdle.roots[0].children, turnedIdle.selected, turnedIdle.note],
    [[EARLIER_KEY], [], null, null])
})

test('1.7 F2: the export reads the forest — the same agents with and without the group', () => {
  const w = earlierWorld()
  const over: Partial<AgentTreeInput> = {
    ...w.over,
    agents: [...(w.over.agents ?? []), rec('aaaa0001', { sessionId: w.active[0] }),
      rec('bbbb0001', { sessionId: w.earlier[2], firstTs: NOW - 3 * HOUR, lastTs: NOW - 2 * HOUR, outcome: 'completed', outcomeTs: NOW - 2 * HOUR }),
      // In a session past the group's MAX_ROOTS: no row anywhere, a row of the export all the same.
      rec('cccc0001', { sessionId: w.earlier[24], firstTs: NOW - 13 * HOUR, lastTs: NOW - 12 * HOUR - 50 * MIN })],
  }
  assert.equal(build(over).roots.some((r) => r.kind === 'group'), true)
  const views = agentRecordViews(input(over), NOW)
  assert.deepEqual(views, agentRecordViews(input({ ...over, split: false }), NOW))
  assert.deepEqual(views.map((v) => v.agentId).sort(), ['aaaa0001', 'bbbb0001', 'cccc0001', 'dddd0001'])
})

test('1.14 §3 A4 rule 12: a session root names its project by projectLabel of its record\'s key — the folder\'s name with names on, the pseudonym without, (no project) for the unattributed key; a record holding anything but a key names none; no agent table changes', () => {
  const subOf = (over: Partial<AgentTreeInput>): string | null => build({ attribution: 'project', ...over }).roots[0].sub
  assert.equal(subOf({ sessions: [sessionRec()] }), 'alpha')
  assert.equal(subOf({ sessions: [sessionRec()], projectNames: false }), `p:${ALPHA_KEY}`)
  // A name in the table is shown only with names on; a key the table does not hold is its pseudonym.
  assert.equal(subOf({ sessions: [sessionRec()], projectLabels: {} }), `p:${ALPHA_KEY}`)
  assert.equal(subOf({ sessions: [sessionRec({ project: '' })] }), '(no project)')
  assert.equal(subOf({ sessions: [sessionRec({ project: '*' })] }), 'other projects')
  // A record from before 1.14 (a basename, a hash of another shape) or anything else is no key: no project.
  for (const junk of ['alpha', '/home/t/alpha', 'p:a1a1a1a1a1a1', 'A1A1A1A1A1A1', 42]) {
    assert.equal(subOf({ sessions: [sessionRec({ project: junk as string })] }), null, String(junk))
  }
  // The details' Project row says the same; attribution none names nothing, a label table or not.
  const rows = agentDetails(input({ attribution: 'project', sessions: [sessionRec()], projectNames: false }), NOW, build({ attribution: 'project', sessions: [sessionRec()] }).roots[0].key)?.rows ?? []
  assert.deepEqual(rows.find((r) => r.label === 'Project'), { label: 'Project', value: `p:${ALPHA_KEY}` })
  assert.equal(subOf({ attribution: 'none', sessions: [sessionRec()] }), null)
  // The tree reads the label table through its input: its own tables are 1.13's.
  assert.equal(AGENT_TABLES_REVISION, 10)
})
