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
  AgentTreeVm, MAX_NODES, MAX_ROOTS, MAX_RUNNING_LIST, MAX_TREE_DEPTH, MIN_SHORT_ID, RESUMED_AFTER_MS,
  SPAN_IN_DAYS_FROM_MS, TreeNode,
} from '../src/agentTree'
import { AgentTreeInput, agentDetails, buildAgentTree, shortIdsOf, spanText } from '../src/agentTreeBuild'
import { setBundle, setLocale } from '../src/i18n'
import { TimeConfig } from '../src/time'
import { AgentLaunch, AgentRec, MainRec, SessionRec } from '../src/types'
import { durationText } from '../src/stats'
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
    requests: 5, outputFinal: 5, toolCalls: 3, outcome: null, outcomeTs: null, outcomeStatus: null,
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
    typeHint: 'Explore', modelHint: 'opus', background: false, outcome: null, outcomeTs: null, outcomeStatus: null,
    totals: null,
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
    ['Type', 'Plan'], ['Models', 'sonnet'], ['ID', 'toolu_pppp0001'], ['Started', '11:58'], ['Spawned by', 'Session 9d0eb37a'],
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
  const idle = build(idleOver).roots[0]
  assert.deepEqual([idle.state, idle.derived], ['idle', true])
  assert.equal(stateText(idleOver, idle.key), 'Idle — inferred: the session transcript has been silent since 11:30.')
})

test('agents whose session transcript was never read still get their session, which claims nothing', () => {
  // Silent agents: a running one would make the session active through it (see the roll-up).
  const over = { mains: [], agents: [rec('aaaa0001', { lastTs: NOW - 30 * MIN, firstTs: NOW - 40 * MIN })] }
  const vm = build(over)
  assert.equal(vm.roots.length, 1)
  const root = vm.roots[0]
  assert.equal(root.key, rootKey)
  assert.equal(root.label, 'Session 9d0eb37a')
  assert.deepEqual([root.state, root.derived, root.usage, root.duration, root.startTs, root.lastTs],
    ['unknown', true, '–', '–', null, null])
  assert.equal(stateText(over, root.key),
    "Unknown — inferred: the session's own transcript has not been read; only its agents were.")
  assert.deepEqual(root.children.map((c) => c.key), [agentKey('aaaa0001')])
})

test('a workflow run is running, failed, done or unknown from its agents', () => {
  const run = (agents: AgentRec[]): { vm: AgentTreeVm; w: TreeNode; text: string | undefined } => {
    const vm = build({ agents })
    return { vm, w: node(vm, wfKey), text: stateText({ agents }, wfKey) }
  }
  const done = (id: string): AgentRec => wfRec(id, { outcome: 'completed', outcomeTs: NOW - 5 * MIN })
  // A failure is the parent's record, and its last line comes with it (D6: one that goes on after
  // the record is inferred again).
  const failed = (id: string): AgentRec => wfRec(id, { outcome: 'failed', outcomeTs: NOW - 5 * MIN, lastTs: NOW - 5 * MIN })
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
  assert.equal(u.text, 'Unknown — inferred: not every agent of this run has a recorded result, and none is running.')

  // The run's figures are its agents' figures: 2 × (300 + 200 + 700), from its first start to
  // its last line.
  assert.equal(u.w.usage, '2.4K')
  assert.equal(u.w.startTs, NOW - 40 * MIN)
  assert.equal(u.w.lastTs, NOW - 1 * MIN)
  assert.equal(u.w.duration, '39 min 00 s')
})

// ---------------------------------------------------------------------------
// 1.6 D7 · a stop is not a failure
// ---------------------------------------------------------------------------

test('a stop the parent recorded is stopped — recorded, in the parent\'s own word — and never failed', () => {
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
    'Gestoppt — der Elternprozess hat ‚killed‘ um 11:55 aufgezeichnet.')
  assert.equal(german(() => stateText(stop('aaaa0002', 'cancelled', null), agentKey('aaaa0002'))),
    'Gestoppt — der Elternprozess hat ‚cancelled‘ aufgezeichnet.')
})

test('a run whose agents all ended is done while one completed, and stopped when every one was stopped', () => {
  const run = (agents: AgentRec[]): { w: TreeNode; text: string | undefined } =>
    ({ w: node(build({ agents }), wfKey), text: stateText({ agents }, wfKey) })
  const done = (id: string): AgentRec => wfRec(id, { outcome: 'completed', outcomeTs: NOW - 5 * MIN })
  const stopped = (id: string): AgentRec =>
    wfRec(id, { outcome: 'stopped', outcomeStatus: 'killed', outcomeTs: NOW - 5 * MIN, lastTs: NOW - 5 * MIN })
  const failed = (id: string): AgentRec => wfRec(id, { outcome: 'failed', outcomeTs: NOW - 5 * MIN, lastTs: NOW - 5 * MIN })

  const mixed = run([done('eeee0001'), stopped('eeee0002')])
  assert.deepEqual([mixed.w.state, mixed.w.derived], ['done', false])
  assert.equal(mixed.text, 'Done — every agent of this run has a recorded result.')
  const all = run([stopped('eeee0001'), stopped('eeee0002')])
  assert.deepEqual([all.w.state, all.w.derived], ['stopped', false])
  assert.equal(all.text,
    'Stopped — every agent of this run has a recorded outcome, and none completed: the last attempt of each step was stopped.')
  // A stop is no failure; a failure beside it still fails the run (P2b's tally replaces this rule).
  assert.equal(run([stopped('eeee0001'), failed('eeee0002')]).w.state, 'failed')
  assert.equal(run([stopped('eeee0001'), wfRec('eeee0002')]).w.state, 'running')
  assert.equal(german(() => run([stopped('eeee0001')]).text),
    'Gestoppt — für jeden Agenten dieses Laufs ist ein Ausgang aufgezeichnet, und keiner wurde abgeschlossen: Der letzte Versuch jedes Schritts wurde gestoppt.')
})

test('a stopped agent that wrote on after its stop is inferred again, and its Recorded row says stopped', () => {
  const over: Partial<AgentTreeInput> = {
    agents: [rec('aaaa0001', { outcome: 'stopped', outcomeStatus: 'killed', outcomeTs: NOW - 10 * MIN, lastTs: NOW - 8 * MIN })],
    launches: [launch('aaaa0001', { outcome: 'stopped', outcomeStatus: 'killed', outcomeTs: NOW - 10 * MIN })],
    selected: agentKey('aaaa0001'),
  }
  const n = node(build(over), agentKey('aaaa0001'))
  assert.deepEqual([n.state, n.derived], ['running', true])
  assert.equal(build(over).selected?.rows.find((r) => r.label === 'Recorded')?.value, 'stopped at 11:50')
  assert.deepEqual(german(() => build(over).selected?.rows.find((r) => r.label === 'Aufgezeichnet')?.value), 'gestoppt um 11:50')
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

test('an agent is named by its type, its last model through the model-name helper and its short id', () => {
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
    launches: [launch('def00004', { typeHint: 'Plan', modelHint: 'sonnet' })],
  })
  const label = (id: string): string => node(vm, agentKey(id)).label
  assert.equal(label('a94f3c2e10b7d5e19'), 'Explore · claude-opus-5 · 94f3')
  // Any other id is taken as it is: four characters, since no other id of the session shares them.
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
  // After the two usage figures of D5, which lead a session's details.
  assert.deepEqual(on.rows.map((r) => r.label).slice(0, 3), ['Own transcript', 'Project', 'Models'])
  assert.deepEqual(on.rows.find((r) => r.label === 'Project'), { label: 'Project', value: 'alpha' })

  const off = rowsOf({ attribution: 'none', sessions: [sessionRec()] })
  assert.equal(off.sub, null)
  assert.equal(off.rows.some((r) => r.label === 'Project'), false)

  // A subagent's row or another provider's session with the same id is not this session.
  const others = rowsOf({
    attribution: 'session',
    sessions: [sessionRec({ isSub: true, project: 'sub' }), sessionRec({ source: 'codex', project: 'codex' })],
  })
  assert.equal(others.sub, null)
  assert.deepEqual(others.rows.find((r) => r.label === 'Project'), { label: 'Project', value: '–' })
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

test("an agent's details: every row pre-formatted, dashes for absence, Claude Code's report only when there is one", () => {
  const over: Partial<AgentTreeInput> = {
    agents: [
      rec('aaaa0001', { outputFinal: 4 }),
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
  // Every row says how it is laid out — a figure unless it says otherwise — which row the page's
  // clock ticks in, and which one Copy ID copies: nothing is left to a guess from its words.
  assert.deepEqual(d.rows, [
    { label: 'Type', value: 'Explore' },
    { label: 'Models', value: 'claude-opus-5' },
    { label: 'ID', value: 'aaaa0001', copy: true },
    { label: 'Depth', value: '1' },
    { label: 'Started', value: '11:30' },
    { label: 'Duration', value: '29 min 00 s' },
    { label: 'Last activity', value: '11:59', note: '1 min ago', live: 'ago' },
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
  assert.deepEqual(['Type', 'Depth', 'Turns', 'Usage', 'Output', 'Tool calls', 'Spawned by'].map(value),
    ['–', '–', '–', '–', '–', '–', '–'])
  assert.equal(bare.rows.some((r) => r.label === 'Report from Claude Code'), false)
  assert.equal(bare.rows.some((r) => r.value === '0'), false, 'a zero where nothing was counted')

  // A report whose numbers are not numbers is no report.
  const broken = { ...over, launches: [launch('aaaa0001', { totals: { tokens: NaN, durationMs: 1, toolUses: 1 } })] }
  assert.equal(agentDetails(input(broken), NOW, agentKey('aaaa0001'))?.rows.some((r) => r.label === 'Report from Claude Code'), false)
})

test('a session and a run have details of their own', () => {
  const over: Partial<AgentTreeInput> = {
    agents: [rec('aaaa0001'), wfRec('bbbb0001'), wfRec('bbbb0002', { firstTs: NOW - 40 * MIN })],
    launches: [launch('pppp0001', { agentId: null, ts: NOW - MIN })],
  }
  const s = agentDetails(input(over), NOW, rootKey)
  assert.ok(s)
  assert.equal(s.title, 'Session 9d0eb37a')
  // D5: its own figure and its agents' first, a first line and a span in place of a start and a
  // duration; the ID row last.
  assert.deepEqual(s.rows.map((r) => r.label), [
    'Own transcript', 'Agents, last 7 days', 'Models', 'Since first line', 'Span', 'Last activity', 'Turns', 'Usage',
    'Fresh input', 'Cache write 5m', 'Cache write 1h', 'Cache read', 'Output', 'Reasoning', 'Tool calls', 'Agents', 'ID',
  ])
  const sv = (label: string): string | undefined => s.rows.find((r) => r.label === label)?.value
  // The session's own transcript only: 1 000 + 500 + 2 000; its agents are nodes of their own,
  // and their three records' 3 × 1 200 a figure of their own beside it, never added to it.
  assert.deepEqual(['Own transcript', 'Agents, last 7 days', 'Models', 'Since first line', 'Span', 'Turns', 'Usage',
    'Cache write 5m', 'Tool calls', 'Agents', 'ID'].map(sv),
  ['3.5K', '3.6K', 'claude-opus-5', '10:00', '1 h 58 min', '12', '3.5K', '400', '9', '4', S1])
  assert.deepEqual(s.rows.find((r) => r.label === 'Agents, last 7 days'), {
    label: 'Agents, last 7 days', value: '3.6K', kind: 'sentence',
    note: 'not added to the own figure — the two cover different spans',
  })
  assert.equal(s.id, S1)
  assert.equal(s.rows.filter((r) => r.copy === true).length, 1)

  const w = agentDetails(input(over), NOW, wfKey)
  assert.ok(w)
  assert.deepEqual(w.rows.map((r) => r.label), [
    'Agents', 'Started', 'Duration', 'Last activity', 'Turns', 'Usage', 'Fresh input', 'Cache write 5m',
    'Cache write 1h', 'Cache read', 'Output', 'Reasoning', 'Tool calls', 'ID',
  ])
  // A run's id is its directory's name, which the launch's result names too.
  assert.equal(w.id, WF)
  assert.deepEqual(w.rows[w.rows.length - 1], { label: 'ID', value: WF, copy: true })
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

  // A session beyond the list has no row on the page — not in the tree, and a session is never
  // in the running list — so its details are not open either: a panel nothing on the page can
  // close, coming back with every reload, is worse than saying why nothing shows.
  const mains = Array.from({ length: MAX_ROOTS + 1 }, (_, i) =>
    main({ sessionId: `${String(i).padStart(8, '0')}-s`, lastTs: NOW - (i + 1) * MIN, firstTs: NOW - HOUR }))
  const oldest = mains[MAX_ROOTS].sessionId
  const beyondKey = `s:${oldest}`
  const beyond = build({ mains, selected: beyondKey })
  assert.equal(beyond.roots.some((r) => r.key === beyondKey), false, 'the session beyond the list is listed')
  assert.equal(beyond.selected, null)
  assert.equal(beyond.note, 'The selected node is no longer in the tree.')
  // …while its details can still be asked for directly.
  assert.equal(agentDetails(input({ mains }), NOW, beyondKey)?.title, 'Session 00000020')

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
  // A listed session's finished agent keeps its details, open branch or not: its row is in the
  // payload, inside the closed session.
  const listed = build({ agents: [rec('aaaa0001', { outcome: 'completed', outcomeTs: NOW - MIN })], selected: far })
  assert.equal(listed.selected?.key, far)
  assert.equal(listed.selected?.state, 'done')
  assert.equal(listed.note, null)

  assert.equal(build({ agents }).note, null)
  assert.equal(build({ agents }).selected, null)
})

test('a running agent of a session beyond the list opens only while the running list names it', () => {
  // Every agent of the oldest session runs; the list holds the MAX_RUNNING_LIST that started
  // first, so the last one to start has a row nowhere on the page.
  const mains = Array.from({ length: MAX_ROOTS + 1 }, (_, i) =>
    main({ sessionId: `${String(i).padStart(8, '0')}-s`, lastTs: NOW - (i + 1) * MIN, firstTs: NOW - HOUR }))
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
  const nodes = all(vm.roots)
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
  assert.equal(none.truncated, false)
  // No time of its own (D12): an unchanged tree is the same tree a push later.
  assert.equal('updatedAt' in none, false)

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
    ['Explore · claude-opus-5 · aaaa0001', 'Explore · claude-opus-5 · aaaa0002'], 'the two rows read alike')

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
    'Typ', 'Modelle', 'ID', 'Tiefe', 'Beginn', 'Dauer', 'Letzte Aktivität', 'Turns', 'Verbrauch', 'Frische Eingabe',
    'Cache-Schreiben 5m', 'Cache-Schreiben 1h', 'Cache-Lesen', 'Ausgabe', 'Denkschritte', 'Tool-Aufrufe',
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
  const text = ['Agents', 'Running', 'Done', 'Failed', 'Stopped', 'Unknown', 'Active', 'Idle', 'State', '| Detail | Value |',
    'Tree cut at {0} nodes.', '{0} older session(s) not listed.',
    '⚠ marks a lower bound: for a reply the transcript never marked as finished, only the output reported up to then is counted.',
    // The running list above the tree, and the tree's own heading under it.
    'Running now', 'Sessions and agents', '(waiting)', 'No agent is running.', 'and {0} more']
  assert.ok(ours.length >= 30, `only ${ours.length} keys found in src/agentTreeBuild.ts`)
  // Words German takes over as they are.
  const same = new Set(['Agent', 'Turns', 'Workflow {0}', 'ID'])
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

test('every node counts the agents and launches below it — never itself, never a run — on the tree before the cut', () => {
  const vm = build({
    agents: [
      rec('aaaa0001', { firstTs: NOW - 40 * MIN }),
      rec('aaaa0002', { spawnerFile: agentFile('aaaa0001'), firstTs: NOW - 35 * MIN }),
      wfRec('bbbb0001'),
      wfRec('bbbb0002', { firstTs: NOW - 20 * MIN }),
    ],
    launches: [launch('pppp0001', { agentId: null, file: agentFile('aaaa0001'), ts: NOW - MIN })],
  })
  const root = vm.roots[0]
  // Five agent-like nodes below the session: two agents, the launch under the first, the run's two.
  assert.equal(root.agentCount, 5)
  assert.equal(node(vm, agentKey('aaaa0001')).agentCount, 2, 'its nested agent and its launch')
  assert.equal(node(vm, wfKey).agentCount, 2)
  for (const k of [agentKey('aaaa0002'), agentKey('bbbb0001'), agentKey('bbbb0002'), 'l:toolu_pppp0001']) {
    assert.equal(node(vm, k).agentCount, 0, k)
  }
  // A session without agents holds none.
  assert.equal(build().roots[0].agentCount, 0)

  // Cut at MAX_NODES: the payload carries fewer children than the session holds, and the count
  // still says how many there are.
  const many = Array.from({ length: 400 }, (_, i) => rec(`c${String(i).padStart(7, '0')}`, {
    firstTs: NOW - 5 * HOUR + i * 1000, lastTs: NOW - 2 * HOUR, outcome: 'completed', outcomeTs: NOW - 2 * HOUR,
  }))
  const cut = build({ agents: many })
  assert.equal(cut.truncated, true)
  assert.ok(cut.roots[0].children.length < 400, String(cut.roots[0].children.length))
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

test('the running list is taken from every session, those beyond the list and the nodes beyond the cut included', () => {
  // Beyond MAX_ROOTS: the oldest session is not listed, and its running agent still is.
  const mains = Array.from({ length: MAX_ROOTS + 1 }, (_, i) =>
    main({ sessionId: `${String(i).padStart(8, '0')}-s`, lastTs: NOW - (i + 1) * MIN, firstTs: NOW - HOUR }))
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

  // Beyond the cut: the newer session's three hundred running agents fill the tree before the
  // older session's one, which started first and so leads the list — though the tree left it out.
  const crowd = Array.from({ length: MAX_NODES }, (_, i) => rec(`c${String(i).padStart(7, '0')}`, {
    sessionId: S2, firstTs: NOW - 5 * MIN + i * 100, lastTs: NOW - 30_000,
  }))
  const early = rec('eeee0001', { firstTs: NOW - 30 * MIN })
  const vm = build({ agents: [...crowd, early], mains: [main({ lastTs: NOW - 3 * MIN }), main({ sessionId: S2, lastTs: NOW - MIN })] })
  assert.equal(vm.truncated, true)
  assert.equal(vm.roots[0].key, `s:${S2}`)
  assert.equal(all(vm.roots).some((x) => x.key === agentKey('eeee0001')), false, 'the cut kept the early agent')
  assert.equal(vm.runningNow[0].key, agentKey('eeee0001'))
  assert.equal(vm.running, MAX_NODES + 1)
  assert.equal(vm.runningNow.length + vm.runningMore, vm.running)
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
  const contexts = (vm: AgentTreeVm): string[][] => vm.runningNow.map((r) => [r.key, r.context])
  assert.deepEqual(contexts(build({ ...over, attribution: 'project' })), [
    [agentKey('aaaa0001'), 'Session 9d0eb37a · alpha'],
    [agentKey('bbbb0001'), 'Session 9d0eb37a · Workflow cfe7718d · alpha'],
    [agentKey('bbbb0002'), 'Session 9d0eb37a · Workflow cfe7718d · alpha'],
    // A launch from inside the run sits in the run.
    ['l:toolu_pppp0001', 'Session 9d0eb37a · Workflow cfe7718d · alpha'],
  ])
  // Attribution off: no project anywhere, the list included.
  assert.deepEqual(contexts(build({ ...over, attribution: 'none' })), [
    [agentKey('aaaa0001'), 'Session 9d0eb37a'],
    [agentKey('bbbb0001'), 'Session 9d0eb37a · Workflow cfe7718d'],
    [agentKey('bbbb0002'), 'Session 9d0eb37a · Workflow cfe7718d'],
    ['l:toolu_pppp0001', 'Session 9d0eb37a · Workflow cfe7718d'],
  ])
  // In German, the words the tree's own labels use.
  assert.deepEqual(german(() => build({ ...over, attribution: 'none' })).runningNow.map((r) => r.context).slice(0, 2),
    ['Sitzung 9d0eb37a', 'Sitzung 9d0eb37a · Workflow cfe7718d'])
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
    assert.deepEqual(Object.keys(r).sort(),
      ['context', 'key', 'kind', 'label', 'lastTs', 'lowerBound', 'startTs', 'usage', 'waiting'])
    assert.ok(r.key.length > 0 && r.key.length <= MAX_AGENT_KEY_CHARS, r.key)
    assert.equal(/[\\/]/.test(r.key + r.context), false, `${r.key} ${r.context}`)
    assert.ok(r.kind === 'agent' || r.kind === 'pending')
    assert.equal(typeof r.waiting, 'boolean')
    assert.equal(typeof r.lowerBound, 'boolean')
  }
})

test("a running item carries its node's lower bound, and a launch nothing was counted of never does", () => {
  // A running agent is nearly always mid-reply, so its output nearly always is a lower bound —
  // and the running list is where it is looked at first.
  const mains = Array.from({ length: MAX_ROOTS + 1 }, (_, i) =>
    main({ sessionId: `${String(i).padStart(8, '0')}-s`, lastTs: NOW - (i + 1) * MIN, firstTs: NOW - HOUR }))
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
  // The same flag as the node's, wherever the node is on the tree.
  for (const r of vm.runningNow) {
    const n = all(vm.roots).find((x) => x.key === r.key)
    if (n) assert.equal(r.lowerBound, n.lowerBound, r.key)
  }
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

  // The workflow journal's result carries no time and is never outlived — nor one it was given.
  const journal: Partial<AgentTreeInput> = {
    agents: [wfRec('bbbb0001', { outcome: 'completed', outcomeTs: null, lastTs: NOW - MIN }),
      wfRec('bbbb0002', { outcome: 'completed', outcomeTs: NOW - 20 * MIN, lastTs: NOW - MIN })],
  }
  for (const id of ['bbbb0001', 'bbbb0002']) {
    assert.equal(node(build(journal), agentKey(id)).state, 'done', id)
    assert.equal(agentDetails(input(journal), NOW, agentKey(id))?.rows.some((r) => r.label === 'Recorded'), false, id)
  }
  // An outcome recorded without a time cannot be outlived either.
  const timeless = after(10 * MIN, { outcomeTs: null }, { outcomeTs: null })
  assert.equal(state(timeless).state, 'done')
  // In German: the state word and „um".
  assert.deepEqual(german(() => build(on).selected?.rows.find((r) => r.value.endsWith(' um 11:50'))),
    { label: 'Aufgezeichnet', value: 'fertig um 11:50' })
  assert.equal(german(() => stateText(on, agentKey('aaaa0001'))),
    'Läuft — abgeleitet: Das Transkript hat sich vor 9 min geändert, nachdem um 11:50 ein Ausgang aufgezeichnet wurde.')
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
  assert.equal(label(A), 'Explore · claude-opus-5 · 3f2a1')
  assert.equal(label(B), 'Explore · claude-opus-5 · 3f2a7')
  assert.equal(label(C), 'Explore · claude-opus-5 · 9c0d')
  assert.equal(label('a3f2a000000000000'), 'Explore · claude-opus-5 · 3f2a')
  // Keys stay the full id.
  assert.equal(node(vm, agentKey(A)).key, `a:${A}`)
  // The whole id is in the details, in the row Copy ID copies, and it is what Copy ID copies.
  assert.equal(vm.selected?.id, A)
  assert.deepEqual(vm.selected?.rows.filter((r) => r.copy === true), [{ label: 'ID', value: A, copy: true }])
  // A launch's is its tool_use id.
  const launched = build({ launches: [launch('pppp0001', { agentId: null, ts: NOW - MIN })], selected: 'l:toolu_pppp0001' })
  assert.equal(launched.selected?.id, 'toolu_pppp0001')
  // The running list names an agent as the tree does.
  assert.ok(vm.runningNow.some((r) => r.label === 'Explore · claude-opus-5 · 3f2a1'), JSON.stringify(vm.runningNow))
})
