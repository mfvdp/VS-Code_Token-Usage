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
  AgentTreeVm, MAX_NODES, MAX_ROOTS, MAX_TREE_DEPTH, TreeNode,
} from '../src/agentTree'
import { AgentTreeInput, agentDetails, buildAgentTree } from '../src/agentTreeBuild'
import { setBundle, setLocale } from '../src/i18n'
import { TimeConfig } from '../src/time'
import { AgentLaunch, AgentRec, MainRec, SessionRec } from '../src/types'
import { MAX_AGENT_KEY_CHARS } from '../src/viewModel'
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
    ...over,
  }
}

/** A subagent that was launched from the main transcript half an hour ago and wrote a minute ago. */
function rec(id: string, over: Partial<AgentRec> = {}): AgentRec {
  const session = over.sessionId ?? S1
  return {
    source: 'claude', agentId: id, sessionId: session, sessionFile: sessionFile(session), workflowId: null,
    meta: { agentType: 'Explore', model: 'opus', spawnDepth: 1, toolUseId: `toolu_${id}` },
    metaTries: 1, spawnerFile: sessionFile(session),
    firstTs: NOW - 30 * MIN, lastTs: NOW - 1 * MIN, models: ['claude-opus-5'],
    input: 300, cacheWrite: 200, cacheWrite1h: 0, cacheRead: 5000, output: 700, reasoning: 50,
    requests: 5, outputFinal: 5, toolCalls: 3, outcome: null, outcomeTs: null,
    ...over,
  }
}

/** A workflow agent: its own sidecar type, no spawner the tree can see. */
function wfRec(id: string, over: Partial<AgentRec> = {}): AgentRec {
  return rec(id, {
    workflowId: WF, spawnerFile: null,
    meta: { agentType: 'workflow-subagent', model: null, spawnDepth: 1, toolUseId: null },
    ...over,
  })
}

function launch(id: string, over: Partial<AgentLaunch> = {}): AgentLaunch {
  return {
    toolUseId: `toolu_${id}`, file: sessionFile(), ts: NOW - 31 * MIN, agentId: id,
    typeHint: 'Explore', modelHint: 'opus', background: false, outcome: null, outcomeTs: null, totals: null,
    ...over,
  }
}

function sessionRec(over: Partial<SessionRec> = {}): SessionRec {
  return {
    source: 'claude', sessionId: S1, project: 'alpha', projectHash: 'abc123def456', isSub: false, parent: null,
    firstTs: NOW - 2 * HOUR, lastTs: NOW - 2 * MIN, models: ['claude-opus-5'],
    input: 0, cacheWrite: 0, cacheWrite1h: 0, cacheRead: 0, output: 0, reasoning: 0, requests: 0, outputFinal: 0,
    lastCacheTtl: null, lastCacheWriteTs: null, turnGapsMs: [],
    ...over,
  }
}

function input(over: Partial<AgentTreeInput> = {}): AgentTreeInput {
  return {
    agents: [], launches: [], mains: [main()], sessions: [], attribution: 'none', selected: null, tcfg,
    ...over,
  }
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

// ---------------------------------------------------------------------------
// §4.4 · states
// ---------------------------------------------------------------------------

test('an agent the parent recorded is done or failed, and the sentence names who recorded it and when', () => {
  const over: Partial<AgentTreeInput> = {
    agents: [
      rec('aaaa0001', { outcome: 'completed', outcomeTs: NOW - 5 * MIN }),
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

test('a workflow agent completed by the journal says so, and a missing time is left out rather than invented', () => {
  const over: Partial<AgentTreeInput> = {
    agents: [
      wfRec('bbbb0001', { outcome: 'completed', outcomeTs: NOW - 4 * MIN }),
      wfRec('bbbb0002', { outcome: 'completed', outcomeTs: null }),
      rec('bbbb0003', { outcome: 'completed', outcomeTs: null }),
      rec('bbbb0004', { outcome: 'failed', outcomeTs: null }),
    ],
  }
  assert.equal(stateText(over, agentKey('bbbb0001')),
    'Completed — the workflow journal recorded the result at 11:56.')
  assert.equal(stateText(over, agentKey('bbbb0002')), 'Completed — the workflow journal recorded the result.')
  assert.equal(stateText(over, agentKey('bbbb0003')), 'Completed — the parent recorded the result.')
  assert.equal(stateText(over, agentKey('bbbb0004')), 'Failed — the parent recorded the failure.')
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
    'Unknown — no result was recorded and the transcript has been silent since 11:49; the agent may have been stopped.')
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
    "Unknown — the parent recorded the launch at 11:40 but no result, and the agent's transcript was never seen; the agent may have been stopped.")

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
    ['Type', 'Plan'], ['Models', 'sonnet'], ['Started', '11:58'], ['Spawned by', 'Session 9d0eb37a'],
  ])
  assert.deepEqual(agentDetails(input(over), NOW, nested.key)?.rows.find((r) => r.label === 'Spawned by')?.value,
    'Explore · claude-opus-5 · aaaa')
  assert.deepEqual(agentDetails(input(over), NOW, stale.key)?.rows.slice(0, 2).map((r) => r.value), ['–', '–'])
})

test('a session is active while its transcript changed within ten minutes and idle after, and says so', () => {
  const activeOver = { mains: [main({ lastTs: NOW - 2 * MIN })] }
  const active = build(activeOver).roots[0]
  assert.deepEqual([active.kind, active.state, active.derived], ['session', 'active', true])
  assert.equal(stateText(activeOver, active.key), 'Active — inferred: the session transcript changed 2 min ago.')

  const idleOver = { mains: [main({ lastTs: NOW - 30 * MIN })] }
  const idle = build(idleOver).roots[0]
  assert.deepEqual([idle.state, idle.derived], ['idle', true])
  assert.equal(stateText(idleOver, idle.key), 'Idle — inferred: the session transcript has been silent since 11:30.')
})

test('agents whose session transcript was never read still get their session, which claims nothing', () => {
  const over = { mains: [], agents: [rec('aaaa0001')] }
  const vm = build(over)
  assert.equal(vm.roots.length, 1)
  const root = vm.roots[0]
  assert.equal(root.key, rootKey)
  assert.equal(root.label, 'Session 9d0eb37a')
  assert.deepEqual([root.state, root.derived, root.usage, root.duration, root.startTs, root.lastTs],
    ['unknown', true, '–', '–', null, null])
  assert.equal(stateText(over, root.key),
    "Unknown — the session's own transcript has not been read; only its agents were.")
  assert.deepEqual(root.children.map((c) => c.key), [agentKey('aaaa0001')])
})

test('a workflow run is running, failed, done or unknown from its agents', () => {
  const run = (agents: AgentRec[]): { vm: AgentTreeVm; w: TreeNode; text: string | undefined } => {
    const vm = build({ agents })
    return { vm, w: node(vm, wfKey), text: stateText({ agents }, wfKey) }
  }
  const done = (id: string): AgentRec => wfRec(id, { outcome: 'completed', outcomeTs: NOW - 5 * MIN })
  const failed = (id: string): AgentRec => wfRec(id, { outcome: 'failed', outcomeTs: NOW - 5 * MIN })
  const silent = (id: string): AgentRec => wfRec(id, { lastTs: NOW - 30 * MIN, firstTs: NOW - 40 * MIN })

  const running = run([wfRec('eeee0001'), failed('eeee0002')])
  assert.equal(running.w.kind, 'workflow')
  assert.equal(running.w.label, 'Workflow cfe7718d')
  assert.deepEqual([running.w.state, running.w.derived], ['running', true])
  assert.equal(running.text, 'Running — inferred: at least one agent of this run is running.')
  assert.equal(parentOf(running.vm, running.w.key)?.key, rootKey)
  assert.deepEqual(running.w.children.map((c) => c.key).sort(),
    [agentKey('eeee0001'), agentKey('eeee0002')].sort())

  const f = run([done('eeee0001'), failed('eeee0002')])
  assert.deepEqual([f.w.state, f.w.derived], ['failed', false])
  assert.equal(f.text, 'Failed — at least one agent of this run has a recorded failure.')

  const d = run([done('eeee0001'), done('eeee0002')])
  assert.deepEqual([d.w.state, d.w.derived], ['done', false])
  assert.equal(d.text, 'Done — every agent of this run has a recorded result.')

  const u = run([done('eeee0001'), silent('eeee0002')])
  assert.deepEqual([u.w.state, u.w.derived], ['unknown', true])
  assert.equal(u.text, 'Unknown — not every agent of this run has a recorded result, and none is running.')

  // The run's figures are its agents' figures: 2 × (300 + 200 + 700), from its first start to
  // its last line.
  assert.equal(u.w.usage, '2.4K')
  assert.equal(u.w.startTs, NOW - 40 * MIN)
  assert.equal(u.w.lastTs, NOW - 1 * MIN)
  assert.equal(u.w.duration, '39 min 00 s')
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
  assert.deepEqual(vm.roots.map((r) => r.label), ['Session aaaa1111', 'Session cccc3333'])
  assert.equal(vm.omittedRoots, 0)
  assert.deepEqual(vm.roots[1].children.map((c) => c.key), [agentKey('aaaa0001')])
})

test('at most MAX_ROOTS sessions are listed, the newest, and the rest is counted', () => {
  const mains = Array.from({ length: MAX_ROOTS + 5 }, (_, i) =>
    main({ sessionId: `${String(i).padStart(8, '0')}-s`, lastTs: NOW - (i + 1) * MIN, firstTs: NOW - HOUR }))
  const vm = build({ mains })
  assert.equal(vm.roots.length, MAX_ROOTS)
  assert.equal(vm.omittedRoots, 5)
  assert.deepEqual(vm.roots.map((r) => r.lastTs), mains.slice(0, MAX_ROOTS).map((m) => m.lastTs))
  assert.equal(vm.truncated, false, 'leaving sessions out is not cutting the tree')
})

// ---------------------------------------------------------------------------
// §4.5 · placement
// ---------------------------------------------------------------------------

test('a nested agent sits under the agent that spawned it, found by its spawner file or its launch', () => {
  const vm = build({
    agents: [
      rec('aaaa0001', { firstTs: NOW - 30 * MIN }),
      rec('aaaa0003', { spawnerFile: null, firstTs: NOW - 10 * MIN, meta: { agentType: 'Plan', model: null, spawnDepth: 2, toolUseId: 'toolu_x3' } }),
      rec('aaaa0002', { spawnerFile: agentFile('aaaa0001'), firstTs: NOW - 20 * MIN }),
    ],
    launches: [launch('x3', { agentId: null, file: agentFile('aaaa0001') })],
  })
  const root = vm.roots[0]
  assert.deepEqual(root.children.map((c) => c.key), [agentKey('aaaa0001')])
  // Children in the order they started, whatever order the records came in.
  assert.deepEqual(root.children[0].children.map((c) => c.key), [agentKey('aaaa0002'), agentKey('aaaa0003')])
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

test('an agent is named by its type, its last model through the model-name helper and four characters of its id', () => {
  const vm = build({
    agents: [
      rec('abcd0001', { models: ['claude-sonnet-5', 'claude-opus-5[1m]'] }),
      rec('bcde0002', { models: ['claude-haiku-4-5-20251001'] }),
      rec('cdef0003', { models: [] }),
      rec('def00004', { models: [], meta: null }),
      rec('ef000005', { models: [], meta: null, spawnerFile: null }),
      rec('f0000006', { models: ['claude-sonnet-5', '<synthetic>'] }),
    ],
    launches: [launch('def00004', { typeHint: 'Plan', modelHint: 'sonnet' })],
  })
  const label = (id: string): string => node(vm, agentKey(id)).label
  assert.equal(label('abcd0001'), 'Explore · claude-opus-5 · abcd')
  // A placeholder no model wrote is not the agent's model.
  assert.equal(label('f0000006'), 'Explore · claude-sonnet-5 · f000')
  assert.equal(label('bcde0002'), 'Explore · claude-haiku-4-5 · bcde')
  // No real model seen yet: the alias the sidecar or the launch asked for.
  assert.equal(label('cdef0003'), 'Explore · opus · cdef')
  assert.equal(label('def00004'), 'Plan · sonnet · def0')
  assert.equal(label('ef000005'), 'Agent · – · ef00')
  assert.equal(vm.roots[0].label, 'Session 9d0eb37a')
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
  assert.deepEqual(on.rows[0], { label: 'Project', value: 'alpha' })

  const off = rowsOf({ attribution: 'none', sessions: [sessionRec()] })
  assert.equal(off.sub, null)
  assert.equal(off.rows.some((r) => r.label === 'Project'), false)

  // A subagent's row or another provider's session with the same id is not this session.
  const others = rowsOf({
    attribution: 'session',
    sessions: [sessionRec({ isSub: true, project: 'sub' }), sessionRec({ source: 'codex', project: 'codex' })],
  })
  assert.equal(others.sub, null)
  assert.deepEqual(others.rows[0], { label: 'Project', value: '–' })
})

// ---------------------------------------------------------------------------
// §4.5 · caps
// ---------------------------------------------------------------------------

test('MAX_NODES cuts the tree but keeps every session, the running agents and the open node', () => {
  const done = Array.from({ length: 400 }, (_, i) => rec(`d${String(i).padStart(7, '0')}`, {
    firstTs: NOW - 5 * HOUR + i * 1000, lastTs: NOW - 2 * HOUR, outcome: 'completed', outcomeTs: NOW - 2 * HOUR,
  }))
  // Started last, so a plain cut in start order would lose exactly the node someone is watching.
  const live = rec('ffffffff', { firstTs: NOW - 2 * MIN })
  const picked = done[350]
  const vm = build({
    agents: [...done, live],
    mains: [main(), main({ sessionId: S2, lastTs: NOW - 5 * MIN })],
    selected: agentKey(picked.agentId),
  })
  assert.equal(vm.truncated, true)
  assert.equal(all(vm.roots).length, MAX_NODES)
  assert.equal(vm.roots.length, 2, 'a cut never drops a session')
  assert.ok(all(vm.roots).some((n) => n.key === agentKey('ffffffff')), 'the running agent was cut')
  assert.equal(vm.selected?.key, agentKey(picked.agentId))
  assert.equal(vm.note, null)
  assert.equal(vm.running, 1)

  const small = build({ agents: done.slice(0, 10) })
  assert.equal(small.truncated, false)
  assert.equal(all(small.roots).length, 11)
})

test('running counts every running agent and launch, also on sessions beyond the list', () => {
  const mains = Array.from({ length: MAX_ROOTS + 1 }, (_, i) =>
    main({ sessionId: `${String(i).padStart(8, '0')}-s`, lastTs: NOW - (i + 1) * MIN, firstTs: NOW - HOUR }))
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

test("an agent's details: every row pre-formatted, dashes for absence, the parent's report only when there is one", () => {
  const over: Partial<AgentTreeInput> = {
    agents: [
      rec('aaaa0001', { outputFinal: 4 }),
      rec('aaaa0002', { meta: null, spawnerFile: null, requests: 0, outputFinal: 0 }),
    ],
    launches: [launch('aaaa0001', { totals: { tokens: 123_456, durationMs: 65_000, toolUses: 7 } })],
  }
  const d = agentDetails(input(over), NOW, agentKey('aaaa0001'))
  assert.ok(d)
  assert.equal(d.title, 'Explore · claude-opus-5 · aaaa')
  assert.equal(d.state, 'running')
  assert.deepEqual(d.rows, [
    { label: 'Type', value: 'Explore' },
    { label: 'Models', value: 'claude-opus-5' },
    { label: 'Depth', value: '1' },
    { label: 'Started', value: '11:30' },
    { label: 'Duration', value: '29 min 00 s' },
    { label: 'Last activity', value: '11:59', note: '1 min ago' },
    { label: 'Turns', value: '5' },
    { label: 'Usage', value: '1.2K' },
    { label: 'Fresh input', value: '300' },
    { label: 'Cache write 5m', value: '200' },
    { label: 'Cache write 1h', value: '–' },
    { label: 'Cache read', value: '5K' },
    { label: 'Output', value: '700', note: '⚠ lower bound' },
    { label: 'Reasoning', value: '50' },
    { label: 'Tool calls', value: '3' },
    { label: 'Spawned by', value: 'Session 9d0eb37a' },
    { label: 'Workflow run', value: '–' },
    { label: "Parent's report", value: '123.5K tokens · 1 min 05 s · 7 tool calls',
      note: "the parent's own count, not added to any total" },
  ])

  // No sidecar, no launch, nothing counted: every figure is a dash, and no report is made up.
  const bare = agentDetails(input(over), NOW, agentKey('aaaa0002'))
  assert.ok(bare)
  const value = (label: string): string | undefined => bare.rows.find((r) => r.label === label)?.value
  assert.deepEqual(['Type', 'Depth', 'Turns', 'Usage', 'Output', 'Tool calls', 'Spawned by'].map(value),
    ['–', '–', '–', '–', '–', '–', '–'])
  assert.equal(bare.rows.some((r) => r.label === "Parent's report"), false)
  assert.equal(bare.rows.some((r) => r.value === '0'), false, 'a zero where nothing was counted')

  // A report whose numbers are not numbers is no report.
  const broken = { ...over, launches: [launch('aaaa0001', { totals: { tokens: NaN, durationMs: 1, toolUses: 1 } })] }
  assert.equal(agentDetails(input(broken), NOW, agentKey('aaaa0001'))?.rows.some((r) => r.label === "Parent's report"), false)
})

test('a session and a run have details of their own', () => {
  const over: Partial<AgentTreeInput> = {
    agents: [rec('aaaa0001'), wfRec('bbbb0001'), wfRec('bbbb0002', { firstTs: NOW - 40 * MIN })],
    launches: [launch('pppp0001', { agentId: null, ts: NOW - MIN })],
  }
  const s = agentDetails(input(over), NOW, rootKey)
  assert.ok(s)
  assert.equal(s.title, 'Session 9d0eb37a')
  assert.deepEqual(s.rows.map((r) => r.label), [
    'Models', 'Started', 'Duration', 'Last activity', 'Turns', 'Usage', 'Fresh input', 'Cache write 5m',
    'Cache write 1h', 'Cache read', 'Output', 'Reasoning', 'Tool calls', 'Agents',
  ])
  const sv = (label: string): string | undefined => s.rows.find((r) => r.label === label)?.value
  // The session's own transcript only: 1 000 + 500 + 2 000; its agents are nodes of their own.
  assert.deepEqual(['Models', 'Started', 'Turns', 'Usage', 'Cache write 5m', 'Tool calls', 'Agents'].map(sv),
    ['claude-opus-5', '10:00', '12', '3.5K', '400', '9', '4'])

  const w = agentDetails(input(over), NOW, wfKey)
  assert.ok(w)
  assert.deepEqual(w.rows.map((r) => r.label), [
    'Agents', 'Started', 'Duration', 'Last activity', 'Turns', 'Usage', 'Fresh input', 'Cache write 5m',
    'Cache write 1h', 'Cache read', 'Output', 'Reasoning', 'Tool calls',
  ])
  const wv = (label: string): string | undefined => w.rows.find((r) => r.label === label)?.value
  assert.deepEqual(['Agents', 'Started', 'Turns', 'Usage', 'Tool calls'].map(wv), ['2', '11:20', '10', '2.4K', '6'])
})

test('the open node gets its details; a node that is gone leaves none and says so', () => {
  const agents = [rec('aaaa0001')]
  const open = build({ agents, selected: agentKey('aaaa0001') })
  assert.equal(open.selected?.key, agentKey('aaaa0001'))
  assert.equal(open.selected?.stateText, 'Running — inferred: the transcript changed 1 min ago and no result was recorded yet.')
  assert.equal(open.note, null)

  const gone = build({ agents, selected: agentKey('ffff0000') })
  assert.equal(gone.selected, null)
  assert.equal(gone.note, 'The selected node is no longer in the tree.')

  // A session beyond the list is not on screen either.
  const mains = Array.from({ length: MAX_ROOTS + 1 }, (_, i) =>
    main({ sessionId: `${String(i).padStart(8, '0')}-s`, lastTs: NOW - (i + 1) * MIN, firstTs: NOW - HOUR }))
  const beyond = build({ mains, selected: `s:${mains[MAX_ROOTS].sessionId}` })
  assert.equal(beyond.selected, null)
  assert.equal(beyond.note, 'The selected node is no longer in the tree.')
  // …while its details can still be asked for directly.
  assert.equal(agentDetails(input({ mains }), NOW, `s:${mains[MAX_ROOTS].sessionId}`)?.title, 'Session 00000020')

  assert.equal(build({ agents }).note, null)
  assert.equal(build({ agents }).selected, null)
})

test('an empty tree says which absence it is', () => {
  const none = build({ mains: [] })
  assert.deepEqual(none.roots, [])
  assert.equal(none.note, 'No Claude Code session in the last 7 days.')
  assert.equal(none.running, 0)
  assert.equal(none.truncated, false)
  assert.equal(none.updatedAt, NOW)

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

  // Where the files lie changes nothing: the cursors' paths — the session's own, an agent's in an
  // odd directory, a namesake under another session — are not what a key is made of.
  const files = [
    sessionFile(), agentFile('aaaa0001'), agentFile('bbbb0001', S1, WF),
    path.join(PROJ, S1, 'subagents', 'nested', 'agent-aaaa0001.jsonl'), agentFile('aaaa0001', S2),
  ]
  assert.deepEqual(keysOf(build({ ...over, files })), keysOf(vm))
  // A session without agents is its id as well, whether a cursor names its transcript or not.
  assert.equal(build().roots[0].key, rootKey)
  assert.equal(build({ files: [sessionFile()] }).roots[0].key, rootKey)

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
  // Two agents whose rows read alike — one type, one model, the same four characters — an id that
  // ends like one of theirs, a run and a launch, all in that deep session.
  const over: Partial<AgentTreeInput> = {
    agents: [long('aaaa0001'), long('aaaa0002', { input: 999 }), long('bbbb0001'), wfRec('cccc0001', { sessionFile: file })],
    launches: [launch('pppp0001', { agentId: null, file, ts: NOW - MIN })],
  }
  const vm = build(over)
  const keys = all(vm.roots).map((n) => n.key)
  assert.equal(keys.length, 1 + 4 + 1 + 1)
  for (const k of keys) assert.ok(k.length <= MAX_AGENT_KEY_CHARS, `${k.length}: ${k}`)
  assert.equal(new Set(keys).size, keys.length, 'two nodes share a key')
  assert.equal(node(vm, agentKey('aaaa0001')).label, node(vm, agentKey('aaaa0002')).label, 'the two rows read alike')

  // Stable: a later build, the records in another order and the cursors' paths give the same keys.
  const again = build({ ...over, agents: [...(over.agents ?? [])].reverse(), files: [file] }, NOW + 3 * MIN)
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
    agents: [rec('aaaa0001', { outputFinal: 4 }), wfRec('bbbb0001', { outcome: 'completed', outcomeTs: NOW - 5 * MIN })],
    launches: [launch('pppp0001', { agentId: null, typeHint: null, modelHint: null, ts: NOW - MIN })],
    selected: agentKey('aaaa0001'),
  }
  const vm = german(() => build(over))
  assert.equal(vm.roots[0].label, 'Sitzung 9d0eb37a')
  assert.equal(node(vm, 'l:toolu_pppp0001').label, 'Agent · – · gestartet')
  assert.equal(node(vm, wfKey).label, 'Workflow cfe7718d')
  assert.equal(vm.selected?.stateText,
    'Läuft — abgeleitet: Das Transkript hat sich vor 1 min geändert, und es wurde noch kein Ergebnis aufgezeichnet.')
  assert.deepEqual(vm.selected?.rows.map((r) => r.label), [
    'Typ', 'Modelle', 'Tiefe', 'Beginn', 'Dauer', 'Letzte Aktivität', 'Turns', 'Verbrauch', 'Frische Eingabe',
    'Cache-Schreiben 5m', 'Cache-Schreiben 1h', 'Cache-Lesen', 'Ausgabe', 'Denkschritte', 'Werkzeugaufrufe',
    'Gestartet von', 'Workflow-Lauf',
  ])
  assert.equal(vm.selected?.rows.find((r) => r.label === 'Ausgabe')?.note, '⚠ Untergrenze')
  // The figures in the reader's number format, too.
  assert.equal(vm.selected?.rows.find((r) => r.label === 'Verbrauch')?.value, '1,2K')
  assert.equal(german(() => agentDetails(input(over), NOW, agentKey('bbbb0001'))?.stateText),
    'Fertig — das Workflow-Journal hat das Ergebnis um 11:55 aufgezeichnet.')
  assert.equal(german(() => build({ ...over, selected: 'l:gone' })).note, 'Der ausgewählte Knoten ist nicht mehr im Baum.')
  assert.equal(german(() => build({ mains: [] })).note, 'Keine Claude-Code-Sitzung in den letzten 7 Tagen.')
})

test('every message of the tree and of its markdown has a German entry, and the sentences are not English', () => {
  const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'l10n-extract.mjs'), '--json'],
    { cwd: ROOT, encoding: 'utf8' })
  assert.equal(r.status, 0, r.stderr)
  const keys = (JSON.parse(r.stdout) as { keys: Record<string, string[]> }).keys
  const ours = Object.keys(keys).filter((k) => keys[k].some((site) => site.startsWith('src/agentTreeBuild.ts:')))
  // The markdown's own words for the tree.
  const text = ['Agents', 'Running', 'Done', 'Failed', 'Unknown', 'Active', 'Idle', 'State', '| Detail | Value |',
    'Tree cut at {0} nodes.', '{0} older session(s) not listed.',
    '⚠ marks a lower bound: for a reply the transcript never marked as finished, only the output reported up to then is counted.']
  assert.ok(ours.length >= 30, `only ${ours.length} keys found in src/agentTreeBuild.ts`)
  // Words German takes over as they are.
  const same = new Set(['Agent', 'Turns', 'Workflow {0}'])
  for (const k of [...ours, ...text]) {
    assert.ok(k in keys, `${JSON.stringify(k)} is not a t() key in src/`)
    const de = GERMAN[k]
    assert.ok(typeof de === 'string' && de.length > 0, `no German for ${JSON.stringify(k)}`)
    if (!same.has(k)) assert.notEqual(de, k, `still English: ${JSON.stringify(k)}`)
  }
})
