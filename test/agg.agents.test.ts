// SPDX-FileCopyrightText: 2026 Frederik Marx
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The agent tables: what the aggregator takes from a Claude transcript for the Agents section,
 * and what it never takes. The paths are laid out the way Claude Code writes them — an agent
 * at `<projects>/<slug>/<sessionId>/subagents/agent-<id>.jsonl`, a workflow run's agents one
 * level deeper under `subagents/workflows/<wf>/` beside the run's `journal.jsonl`.
 */

import { strict as assert } from 'node:assert'
import { after, test } from 'node:test'
import * as fs from 'fs'
import * as path from 'path'
import { adapterFor } from '../src/adapters'
import { AGENT_RETENTION_DAYS } from '../src/agentTree'
import {
  AGENT_ID_MAX_CHARS, AGENT_MODEL_MAX_CHARS, AGENT_MODELS_MAX, AGENT_NAME_MAX_CHARS, Aggregator,
  IngestContext, claudePlacement, cleanAgentId, cleanAgentName, parseAgentMeta,
} from '../src/agg'
import { agentTranscriptsOf, configureRoots } from '../src/discover'
import { AGENT_META_MAX_BYTES, agentReplayFiles, readAgentMeta, replayAgents, scan } from '../src/scan'
import { newCursor } from '../src/tail'
import { TimeConfig } from '../src/time'
import { AgentLaunch, AgentRec, Snapshot, STATE_VERSION } from '../src/types'
import {
  CLAUDE_ROOT, CLAUDE_SLUG, agentResultLine, agentToolUseLine, claudeLine, ctxFor, iso, journalLine,
  metaJson, queueOperationLine, tmpDir,
} from './fixtures/helpers'

/** Roots are module state; the next test file must not inherit a scratch directory. */
after(() => { configureRoots() })

const DAY = 86_400_000
const T0 = Date.UTC(2026, 8, 20, 10, 0, 0)
const utc: TimeConfig = { zone: 'utc', dayBoundaryHour: 0, startOfWeek: 'monday', hourCycle: 'h23' }

const SESSION = '5e551011-0a1b-4c2d-8e3f-000000000001'
const WF = 'wf_0a1b2c3d-123'
const SLUG_DIR = path.join(CLAUDE_ROOT, CLAUDE_SLUG)
const MAIN = path.join(SLUG_DIR, `${SESSION}.jsonl`)
const AGENT = path.join(SLUG_DIR, SESSION, 'subagents', 'agent-abc123.jsonl')
const NESTED = path.join(SLUG_DIR, SESSION, 'subagents', 'agent-0ff1ce.jsonl')
const WF_AGENT = path.join(SLUG_DIR, SESSION, 'subagents', 'workflows', WF, 'agent-def456.jsonl')
const JOURNAL = path.join(SLUG_DIR, SESSION, 'subagents', 'workflows', WF, 'journal.jsonl')

const MAIN_CTX = ctxFor({ file: MAIN })
const AGENT_CTX = ctxFor({ file: AGENT, isSub: true })
const NESTED_CTX = ctxFor({ file: NESTED, isSub: true })
const WF_CTX = ctxFor({ file: WF_AGENT, isSub: true })
const JOURNAL_CTX = ctxFor({ file: JOURNAL, isSub: true })

const TOTALS = { tokens: 12_345, durationMs: 28_000, toolUses: 3 }

function agentOf(agg: Aggregator, file: string): AgentRec {
  const rec = new Map(agg.agentEntries()).get(file)
  assert.ok(rec, `no agent record for ${file}`)
  return rec
}

function launchOf(agg: Aggregator, toolUseId: string): AgentLaunch {
  const launch = agg.launches().find((l) => l.toolUseId === toolUseId)
  assert.ok(launch, `no launch ${toolUseId}`)
  return launch
}

/** Everything the counting side owns in a snapshot — what an agents-only pass may not change. */
function counting(agg: Aggregator): string {
  const s = agg.toSnapshot()
  return JSON.stringify({
    buckets: s.buckets, cursors: s.cursors, pending: s.pending, sessions: s.sessions,
    attribution: s.attribution, rollup: s.rollup, firstIngest: s.firstIngest,
    tools: s.tools, toolsTruncated: s.toolsTruncated,
  })
}

function agentTables(agg: Aggregator): Pick<Snapshot, 'agents' | 'launches' | 'mains' | 'journalResults'> {
  const s = JSON.parse(JSON.stringify(agg.toSnapshot())) as Snapshot
  return { agents: s.agents, launches: s.launches, mains: s.mains, journalResults: s.journalResults }
}

// ---------------------------------------------------------------------------
// Placement
// ---------------------------------------------------------------------------

test('claudePlacement anchors on the nearest subagents directory, at both depths', () => {
  assert.deepEqual(claudePlacement(MAIN, false), { slug: CLAUDE_SLUG, parent: null, sessionFile: null, workflowId: null })
  assert.deepEqual(claudePlacement(AGENT, true), { slug: CLAUDE_SLUG, parent: SESSION, sessionFile: MAIN, workflowId: null })
  // One level deeper: counting levels up would take `workflows` for the session here.
  assert.deepEqual(claudePlacement(WF_AGENT, true), { slug: CLAUDE_SLUG, parent: SESSION, sessionFile: MAIN, workflowId: WF })
  assert.equal(claudePlacement(JOURNAL, true).workflowId, WF)
  // A file directly in `workflows/` belongs to no run.
  const loose = path.join(SLUG_DIR, SESSION, 'subagents', 'workflows', 'agent-abc123.jsonl')
  assert.deepEqual(claudePlacement(loose, true), { slug: CLAUDE_SLUG, parent: SESSION, sessionFile: MAIN, workflowId: null })
  // Without a `subagents` directory the reading stays what it always was.
  const odd = path.join(SLUG_DIR, SESSION, 'elsewhere', 'agent-abc123.jsonl')
  assert.deepEqual(claudePlacement(odd, true), { slug: CLAUDE_SLUG, parent: SESSION, sessionFile: null, workflowId: null })
})

test('a workflow agent\'s session record names its real session and project', () => {
  const agg = new Aggregator()
  const ctx = ctxFor({ file: WF_AGENT, isSub: true, attribution: 'session' })
  agg.addClaudeLine(claudeLine({ id: 'w1', ts: T0, cwd: null, sessionId: null, agentId: 'def456', usage: { input: 1 } }), ctx)
  const rec = agg.sessions()[0]
  // Before the fix these were "workflows" and "subagents".
  assert.equal(rec.parent, SESSION)
  assert.equal(rec.project, CLAUDE_SLUG)
  assert.equal(rec.isSub, true)
})

// ---------------------------------------------------------------------------
// Agent and main session records
// ---------------------------------------------------------------------------

test('an agent transcript gets its record on the first counted line, with the dedupe the buckets use', () => {
  const agg = new Aggregator()
  // The prompt that opens an agent's transcript is not counted and makes no record.
  const prompt = JSON.stringify({
    parentUuid: null, isSidechain: true, agentId: 'abc123', type: 'user',
    message: { role: 'user', content: 'synthetic agent prompt' }, timestamp: iso(T0 - 100),
  })
  assert.equal(agg.addClaudeLine(prompt, AGENT_CTX), false)
  assert.equal(agg.agents().length, 0)

  const base = { input: 100, cacheWrite: 2000, cacheWrite1h: 500, cacheRead: 5000 }
  agg.addClaudeLine(claudeLine({ id: 'msg_1', ts: T0, agentId: 'abc123', usage: { ...base, output: 5, thinking: 1 } }), AGENT_CTX)
  agg.addClaudeLine(claudeLine({ id: 'msg_1', ts: T0 + 400, agentId: 'abc123', usage: { ...base, output: 40, thinking: 3 }, final: true }), AGENT_CTX)
  // A snapshot that shrinks must not subtract, a line read twice must not add.
  agg.addClaudeLine(claudeLine({ id: 'msg_1', ts: T0 + 500, agentId: 'abc123', usage: { ...base, output: 30 } }), AGENT_CTX)
  agg.addClaudeLine(claudeLine({ id: 'msg_1', ts: T0 + 400, agentId: 'abc123', usage: { ...base, output: 40, thinking: 3 }, final: true }), AGENT_CTX)
  agg.addClaudeLine(claudeLine({ id: 'msg_2', ts: T0 + 60_000, model: 'claude-sonnet-4-6', agentId: 'abc123', usage: { input: 7, output: 3 } }), AGENT_CTX)

  assert.deepEqual(agentOf(agg, AGENT), {
    source: 'claude',
    agentId: 'abc123',
    sessionId: SESSION,
    sessionFile: MAIN,
    workflowId: null,
    meta: null,
    metaTries: 0,
    spawnerFile: null,
    firstTs: T0,
    lastTs: T0 + 60_000,
    models: ['claude-opus-4-6', 'claude-sonnet-4-6'],
    input: 107, cacheWrite: 2000, cacheWrite1h: 500, cacheRead: 5000,
    output: 43, reasoning: 3, requests: 2, outputFinal: 1, toolCalls: 0,
    outcome: null,
    outcomeTs: null,
  })
  // The buckets hold the same figures: the record follows them, it does not count on its own.
  const sub = agg.all().filter((b) => b.isSub)
  assert.equal(sub.reduce((s, b) => s + b.output, 0), 43)
  assert.equal(sub.reduce((s, b) => s + b.requests, 0), 2)
  assert.equal(sub.reduce((s, b) => s + b.outputFinal, 0), 1)
})

test('an agent lists at most eight real model ids, in the order it used them', () => {
  const agg = new Aggregator()
  for (let i = 0; i < AGENT_MODELS_MAX + 4; i++) {
    agg.addClaudeLine(claudeLine({ id: `m${i}`, ts: T0 + i, model: `claude-test-${i}`, agentId: 'abc123', usage: { input: 1 } }), AGENT_CTX)
  }
  const rec = agentOf(agg, AGENT)
  assert.equal(rec.models.length, AGENT_MODELS_MAX)
  assert.deepEqual(rec.models.slice(0, 2), ['claude-test-0', 'claude-test-1'])
  assert.equal(rec.requests, AGENT_MODELS_MAX + 4)
  // A model string outside the alphabet is no model id; the line still counts.
  const other = new Aggregator()
  other.addClaudeLine(claudeLine({ id: 'x', ts: T0, model: 'claude <b>opus</b>', agentId: 'abc123', usage: { input: 1 } }), AGENT_CTX)
  assert.deepEqual(agentOf(other, AGENT).models, [])
  assert.equal(agentOf(other, AGENT).requests, 1)
})

test('no record for a file below subagents that is no agent, nor from a line without a time', () => {
  const agg = new Aggregator()
  const notes = path.join(SLUG_DIR, SESSION, 'subagents', 'notes.jsonl')
  assert.equal(agg.addClaudeLine(claudeLine({ id: 'n1', ts: T0, usage: { input: 1 } }), ctxFor({ file: notes, isSub: true })), true)
  const upper = path.join(SLUG_DIR, SESSION, 'subagents', 'agent-ABC.jsonl')
  agg.addClaudeLine(claudeLine({ id: 'n2', ts: T0, usage: { input: 1 } }), ctxFor({ file: upper, isSub: true }))
  assert.equal(agg.agents().length, 0)
  assert.equal(agg.all().reduce((s, b) => s + b.requests, 0), 2)

  // A record's times are the lines' own: without one there is no record, only the count.
  const raw = JSON.parse(claudeLine({ id: 'late', ts: T0, agentId: 'abc123', usage: { input: 9 } })) as Record<string, unknown>
  delete raw.timestamp
  const timeless = new Aggregator()
  assert.equal(timeless.addClaudeLine(JSON.stringify(raw), AGENT_CTX), true)
  assert.equal(timeless.agents().length, 0)
  assert.equal(timeless.all()[0].input, 9)
})

test('an agent\'s tool calls are the increments the tool table gets: streamed duplicates count once', () => {
  const agg = new Aggregator()
  // Two parallel Reads on two lines of one message; the stream repeats the second line.
  agg.addClaudeLine(claudeLine({ id: 'm1', ts: T0, agentId: 'abc123', usage: { input: 5 }, tools: [{ name: 'Read', id: 'toolu_r1' }] }), AGENT_CTX)
  agg.addClaudeLine(claudeLine({ id: 'm1', ts: T0 + 10, agentId: 'abc123', usage: { input: 5 }, tools: [{ name: 'Read', id: 'toolu_r2' }] }), AGENT_CTX)
  agg.addClaudeLine(claudeLine({ id: 'm1', ts: T0 + 20, agentId: 'abc123', usage: { input: 5 }, tools: [{ name: 'Read', id: 'toolu_r2' }] }), AGENT_CTX)
  // Blocks without an id: the max-per-name rule.
  agg.addClaudeLine(claudeLine({ id: 'm2', ts: T0 + 30, agentId: 'abc123', usage: { input: 5 }, tools: [{ name: 'Bash', id: null }, { name: 'Bash', id: null }] }), AGENT_CTX)
  agg.addClaudeLine(claudeLine({ id: 'm2', ts: T0 + 40, agentId: 'abc123', usage: { input: 5 }, tools: [{ name: 'Bash', id: null }] }), AGENT_CTX)
  assert.equal(agentOf(agg, AGENT).toolCalls, 4)
  assert.equal(agg.tools().rows.reduce((s, t) => s + t.calls, 0), 4)
})

test('a main transcript keeps a session record for the tree, whatever attribution says', () => {
  const agg = new Aggregator()
  agg.addClaudeLine(claudeLine({ id: 'm1', ts: T0, usage: { input: 10, cacheRead: 90, output: 5 } }), MAIN_CTX)
  agg.addClaudeLine(claudeLine({ id: 'm1', ts: T0 + 300, usage: { input: 10, cacheRead: 90, output: 25 }, final: true, tools: [{ name: 'Read', id: 'toolu_1' }] }), MAIN_CTX)
  agg.addClaudeLine(claudeLine({ id: 'm2', ts: T0 + 90_000, model: 'claude-sonnet-4-6', usage: { input: 4, output: 2 } }), MAIN_CTX)
  assert.equal(agg.sessions().length, 0, 'attribution is off: no session table')
  assert.deepEqual(agg.mainEntries(), [[MAIN, {
    source: 'claude',
    sessionId: SESSION,
    firstTs: T0,
    lastTs: T0 + 90_000,
    models: ['claude-opus-4-6', 'claude-sonnet-4-6'],
    input: 14, cacheWrite: 0, cacheWrite1h: 0, cacheRead: 90,
    output: 27, reasoning: 0, requests: 2, outputFinal: 1, toolCalls: 1,
  }]])
  assert.equal(agg.agents().length, 0)
  // The open message knows which record holds it — by name, not by path.
  const snap = agg.toSnapshot()
  assert.equal(snap.pending.m1.main, SESSION)
  assert.equal(snap.pending.m1.agent, undefined)
})

test('an open message from a version 6 snapshot is linked by its next line and adds its growth', () => {
  const agg = new Aggregator()
  agg.addClaudeLine(claudeLine({ id: 'a1', ts: T0, agentId: 'abc123', usage: { input: 50, output: 10 } }), AGENT_CTX)
  const snap = JSON.parse(JSON.stringify(agg.toSnapshot())) as Snapshot
  // What a version 6 build left: the counting, and no agent tables or links.
  snap.version = 6
  delete snap.pending.a1.agent
  const old = Aggregator.fromSnapshot(snap)
  assert.equal(old.agents().length, 0)
  old.addClaudeLine(claudeLine({ id: 'a1', ts: T0 + 500, agentId: 'abc123', usage: { input: 50, output: 30 }, final: true }), AGENT_CTX)
  const rec = agentOf(old, AGENT)
  // The growth only: the part before is the replay's to rebuild, never counted twice.
  assert.equal(rec.output, 20)
  assert.equal(rec.input, 0)
  assert.equal(rec.requests, 0)
  assert.equal(rec.outputFinal, 1)
  assert.equal(old.toSnapshot().pending.a1.agent, 'agent-abc123')
  // A message held by another transcript adds nothing here.
  old.addClaudeLine(claudeLine({ id: 'a1', ts: T0 + 600, agentId: 'abc123', usage: { input: 50, output: 60 } }), NESTED_CTX)
  assert.equal(new Map(old.agentEntries()).has(NESTED), false)
  assert.equal(rec.output, 20)
})

// ---------------------------------------------------------------------------
// Launches, results, notifications
// ---------------------------------------------------------------------------

test('an Agent or Task tool_use is a launch, made once however often the stream repeats it', () => {
  const agg = new Aggregator()
  const line = agentToolUseLine({ id: 'msg_l', ts: T0, toolUseId: 'toolu_01A', subagentType: 'Explore', model: 'haiku', background: true, final: false })
  assert.equal(agg.addClaudeLine(line, MAIN_CTX), true)
  agg.addClaudeLine(line, MAIN_CTX)
  agg.addClaudeLine(agentToolUseLine({ id: 'msg_l', ts: T0 + 300, toolUseId: 'toolu_01A', subagentType: 'Explore', model: 'haiku', background: true }), MAIN_CTX)
  agg.addClaudeLine(agentToolUseLine({ id: 'msg_t', ts: T0 + 1000, toolUseId: 'toolu_01B', name: 'Task', model: null }), MAIN_CTX)
  // Any other tool is no launch.
  agg.addClaudeLine(claudeLine({ id: 'msg_b', ts: T0 + 2000, tools: [{ name: 'Bash', id: 'toolu_bash' }] }), MAIN_CTX)

  assert.deepEqual(agg.launches(), [
    {
      toolUseId: 'toolu_01A', file: MAIN, ts: T0, agentId: null, typeHint: 'Explore', modelHint: 'haiku',
      background: true, outcome: null, outcomeTs: null, totals: null,
    },
    {
      toolUseId: 'toolu_01B', file: MAIN, ts: T0 + 1000, agentId: null, typeHint: null, modelHint: null,
      background: false, outcome: null, outcomeTs: null, totals: null,
    },
  ])
  // The launching message is one request with one tool call, however often it was read.
  const main = agg.mains()[0]
  assert.equal(main.requests, 3)
  assert.equal(main.toolCalls, 3)
  assert.deepEqual(agg.tools().rows.map((t) => [t.name, t.calls]), [['Agent', 1], ['Bash', 1], ['Task', 1]])
})

test('a launch takes its hints only when they fit the alphabet and the cap', () => {
  const agg = new Aggregator()
  agg.addClaudeLine(agentToolUseLine({
    id: 'm1', ts: T0, toolUseId: 'toolu_hint', subagentType: 'Explore <img src=x onerror=alert(1)>', model: 'o'.repeat(AGENT_NAME_MAX_CHARS + 1),
  }), MAIN_CTX)
  agg.addClaudeLine(agentToolUseLine({ id: 'm2', ts: T0, toolUseId: 'toolu_<script>' }), MAIN_CTX)
  agg.addClaudeLine(agentToolUseLine({ id: 'm3', ts: T0, toolUseId: 'toolu_ok', subagentType: 'plugin:reviewer@v2', model: 'claude-opus-4-6' }), MAIN_CTX)
  assert.deepEqual(agg.launches().map((l) => [l.toolUseId, l.typeHint, l.modelHint]), [
    ['toolu_hint', null, null],
    ['toolu_ok', 'plugin:reviewer@v2', 'claude-opus-4-6'],
  ])
})

test('the parent\'s result names the agent and maps its status', () => {
  const cases: Array<[string, AgentLaunch['outcome']]> = [
    ['async_launched', 'launched'],
    ['completed', 'completed'],
    ['failed', 'failed'],
    ['error', 'failed'],
    ['killed', 'failed'],
    ['cancelled', 'failed'],
    ['timeout', 'failed'],
    ['paused', null],
    ['', null],
  ]
  for (const [status, want] of cases) {
    const agg = new Aggregator()
    agg.addClaudeLine(agentToolUseLine({ id: 'm', ts: T0, toolUseId: 'toolu_s' }), MAIN_CTX)
    agg.addClaudeLine(agentResultLine({ ts: T0 + 5000, toolUseId: 'toolu_s', agentId: 'abc123', status, totals: TOTALS }), MAIN_CTX)
    const launch = launchOf(agg, 'toolu_s')
    assert.equal(launch.agentId, 'abc123', status)
    assert.equal(launch.outcome, want, status)
    assert.equal(launch.outcomeTs, want === 'completed' || want === 'failed' ? T0 + 5000 : null, status)
    // The parent's report is kept for a completed sync agent only.
    assert.deepEqual(launch.totals, want === 'completed' ? TOTALS : null, status)
  }
  // A report missing one of its three numbers is no report.
  const partial = new Aggregator()
  partial.addClaudeLine(agentResultLine({ ts: T0, toolUseId: 'toolu_p', agentId: 'abc123', totals: { tokens: 5, durationMs: -1, toolUses: 1 } }), MAIN_CTX)
  assert.equal(launchOf(partial, 'toolu_p').totals, null)
  assert.equal(launchOf(partial, 'toolu_p').outcome, 'completed')
})

test('a result without its launch line stands in for it; the usage it reports is never counted', () => {
  const agg = new Aggregator()
  assert.equal(agg.addClaudeLine(agentResultLine({ ts: T0, toolUseId: 'toolu_x', agentId: 'abc123', totals: TOTALS }), MAIN_CTX), true)
  assert.equal(agg.addClaudeLine(agentResultLine({ ts: T0 + 10, toolUseId: 'toolu_y', agentId: 'def456', status: 'async_launched' }), MAIN_CTX), true)
  assert.deepEqual(launchOf(agg, 'toolu_x'), {
    toolUseId: 'toolu_x', file: MAIN, ts: T0, agentId: 'abc123', typeHint: null, modelHint: null,
    background: false, outcome: 'completed', outcomeTs: T0, totals: TOTALS,
  })
  assert.equal(launchOf(agg, 'toolu_y').background, true)
  // The agent's own usage summary rides on the result; it was counted in the agent's transcript.
  assert.equal(agg.all().length, 0)
  assert.equal(agg.mains().length, 0)
  // Read again, the same result changes nothing.
  assert.equal(agg.addClaudeLine(agentResultLine({ ts: T0, toolUseId: 'toolu_x', agentId: 'abc123', totals: TOTALS }), MAIN_CTX), false)
})

test('a result reaches the agent record in either order, and brings the spawner', () => {
  const launch = agentToolUseLine({ id: 'm', ts: T0, toolUseId: 'toolu_s' })
  const agentLine = claudeLine({ id: 's1', ts: T0 + 1000, agentId: 'abc123', usage: { input: 1 } })
  const result = agentResultLine({ ts: T0 + 9000, toolUseId: 'toolu_s', agentId: 'abc123', totals: TOTALS })
  // The agent's transcript first — a sync agent is done before its parent writes the result.
  const live = new Aggregator()
  live.addClaudeLine(launch, MAIN_CTX)
  live.addClaudeLine(agentLine, AGENT_CTX)
  live.addClaudeLine(result, MAIN_CTX)
  // The parent's transcript read whole first — the order of a cold scan.
  const cold = new Aggregator()
  cold.addClaudeLine(launch, MAIN_CTX)
  cold.addClaudeLine(result, MAIN_CTX)
  cold.addClaudeLine(agentLine, AGENT_CTX)
  for (const agg of [live, cold]) {
    const rec = agentOf(agg, AGENT)
    assert.equal(rec.outcome, 'completed')
    assert.equal(rec.outcomeTs, T0 + 9000)
    assert.equal(rec.spawnerFile, MAIN)
  }
})

test('a task notification ends a background launch; an unknown id is someone else\'s task', () => {
  const agg = new Aggregator()
  agg.addClaudeLine(agentToolUseLine({ id: 'm', ts: T0, toolUseId: 'toolu_bg', background: true }), MAIN_CTX)
  agg.addClaudeLine(agentResultLine({ ts: T0 + 100, toolUseId: 'toolu_bg', agentId: 'abc123', status: 'async_launched' }), MAIN_CTX)
  agg.addClaudeLine(claudeLine({ id: 's1', ts: T0 + 1000, agentId: 'abc123', usage: { input: 1 } }), AGENT_CTX)
  assert.equal(launchOf(agg, 'toolu_bg').outcome, 'launched')
  assert.equal(agentOf(agg, AGENT).outcome, null)

  // A background shell task reports the same way; its tool call is no launch of an agent.
  assert.equal(agg.addClaudeLine(queueOperationLine({ ts: T0 + 2000, toolUseId: 'toolu_bash', status: 'completed' }), MAIN_CTX), false)
  assert.equal(agg.addClaudeLine(queueOperationLine({ ts: T0 + 2000, toolUseId: null, status: 'completed' }), MAIN_CTX), false)
  // Taking the notification off the queue repeats its text and says nothing new.
  assert.equal(agg.addClaudeLine(queueOperationLine({ ts: T0 + 3000, toolUseId: 'toolu_bg', operation: 'remove' }), MAIN_CTX), false)
  // A status this build does not know is no result.
  assert.equal(agg.addClaudeLine(queueOperationLine({ ts: T0 + 4000, toolUseId: 'toolu_bg', status: 'paused' }), MAIN_CTX), false)
  assert.equal(launchOf(agg, 'toolu_bg').outcome, 'launched')

  assert.equal(agg.addClaudeLine(queueOperationLine({ ts: T0 + 5000, toolUseId: 'toolu_bg', status: 'completed' }), MAIN_CTX), true)
  assert.equal(launchOf(agg, 'toolu_bg').outcome, 'completed')
  assert.equal(launchOf(agg, 'toolu_bg').outcomeTs, T0 + 5000)
  assert.equal(launchOf(agg, 'toolu_bg').totals, null, 'a notification carries no report')
  assert.equal(agentOf(agg, AGENT).outcome, 'completed')
  assert.equal(agentOf(agg, AGENT).outcomeTs, T0 + 5000)
  // A launch report read again does not revive a finished agent.
  assert.equal(agg.addClaudeLine(agentResultLine({ ts: T0 + 100, toolUseId: 'toolu_bg', agentId: 'abc123', status: 'async_launched' }), MAIN_CTX), false)
  assert.equal(launchOf(agg, 'toolu_bg').outcome, 'completed')

  const failing = new Aggregator()
  failing.addClaudeLine(agentToolUseLine({ id: 'm', ts: T0, toolUseId: 'toolu_f', background: true }), MAIN_CTX)
  failing.addClaudeLine(queueOperationLine({ ts: T0 + 700, toolUseId: 'toolu_f', status: 'failed' }), MAIN_CTX)
  assert.equal(launchOf(failing, 'toolu_f').outcome, 'failed')
  assert.equal(launchOf(failing, 'toolu_f').outcomeTs, T0 + 700)
})

// ---------------------------------------------------------------------------
// Workflow journal
// ---------------------------------------------------------------------------

test('the workflow journal records a result, and holds it when it comes before the agent', () => {
  const agg = new Aggregator()
  agg.addClaudeLine(claudeLine({ id: 'w1', ts: T0, agentId: 'def456', usage: { input: 1 } }), WF_CTX)
  assert.equal(agentOf(agg, WF_AGENT).workflowId, WF)
  assert.equal(agg.addWorkflowJournalLine(journalLine({ type: 'started', agentId: 'def456' }), JOURNAL_CTX), false)
  assert.equal(agg.addWorkflowJournalLine(journalLine({ type: 'result', agentId: 'def456' }), JOURNAL_CTX), true)
  // Journal lines carry no time: the result's time is unknown, not "now".
  assert.equal(agentOf(agg, WF_AGENT).outcome, 'completed')
  assert.equal(agentOf(agg, WF_AGENT).outcomeTs, null)
  assert.equal(agg.addWorkflowJournalLine(journalLine({ type: 'result', agentId: 'def456' }), JOURNAL_CTX), false)
  // A line that does carry its own time supplies the missing one.
  assert.equal(agg.addWorkflowJournalLine(journalLine({ type: 'result', agentId: 'def456', ts: T0 + 70 }), JOURNAL_CTX), true)
  assert.equal(agentOf(agg, WF_AGENT).outcomeTs, T0 + 70)

  // The ordering race: the journal was read before the agent's transcript.
  const race = new Aggregator()
  assert.equal(race.addWorkflowJournalLine(journalLine({ type: 'started', agentId: 'def456' }), JOURNAL_CTX), false)
  assert.equal(race.addWorkflowJournalLine(journalLine({ type: 'result', agentId: 'def456', ts: T0 + 500 }), JOURNAL_CTX), true)
  assert.equal(race.agents().length, 0, 'a journal line makes no agent record')
  assert.deepEqual(race.toSnapshot().journalResults, { def456: T0 + 500 })
  race.addClaudeLine(claudeLine({ id: 'w1', ts: T0, agentId: 'def456', usage: { input: 1 } }), WF_CTX)
  assert.equal(agentOf(race, WF_AGENT).outcome, 'completed')
  assert.equal(agentOf(race, WF_AGENT).outcomeTs, T0 + 500)
  assert.deepEqual(race.toSnapshot().journalResults, {})

  // Waiting without a time, it is 0 — and the record's time stays unknown.
  const timeless = new Aggregator()
  timeless.addWorkflowJournalLine(journalLine({ type: 'result', agentId: 'def456' }), JOURNAL_CTX)
  assert.deepEqual(timeless.toSnapshot().journalResults, { def456: 0 })
  timeless.addClaudeLine(claudeLine({ id: 'w1', ts: T0, agentId: 'def456', usage: { input: 1 } }), WF_CTX)
  assert.equal(agentOf(timeless, WF_AGENT).outcomeTs, null)

  // Nothing else in a journal is a result.
  for (const raw of ['{"type":"result"', '{"type":"result","agentId":"<b>x</b>"}', '{"type":"other","agentId":"def456","result":1}', '[]']) {
    assert.equal(agg.addWorkflowJournalLine(raw, JOURNAL_CTX), false, raw)
  }
})

test('the Claude adapter reads a journal as a journal, never as a transcript', () => {
  const claude = adapterFor('claude')
  const agg = new Aggregator()
  const cur = newCursor()
  // A line that would count if it were a transcript line counts nothing in a journal.
  assert.equal(claude.ingest(claudeLine({ id: 'j1', ts: T0, usage: { input: 100 } }), cur, JOURNAL_CTX, agg), false)
  assert.equal(claude.ingest(journalLine({ type: 'result', agentId: 'def456' }), cur, JOURNAL_CTX, agg), true)
  assert.equal(agg.all().length, 0)
  assert.deepEqual(agg.toSnapshot().journalResults, { def456: 0 })
  // Every other file goes on to the transcript reader.
  assert.equal(claude.ingest(claudeLine({ id: 'j2', ts: T0, agentId: 'def456', usage: { input: 1 } }), cur, WF_CTX, agg), true)
  assert.equal(agentOf(agg, WF_AGENT).outcome, 'completed')
})

// ---------------------------------------------------------------------------
// The sidecar and the links it makes
// ---------------------------------------------------------------------------

test('the sidecar links an agent to its launch, in either order', () => {
  const agg = new Aggregator()
  agg.addClaudeLine(agentToolUseLine({ id: 'm', ts: T0, toolUseId: 'toolu_bg', background: true }), MAIN_CTX)
  agg.addClaudeLine(queueOperationLine({ ts: T0 + 900, toolUseId: 'toolu_bg', status: 'completed' }), MAIN_CTX)
  agg.addClaudeLine(claudeLine({ id: 's1', ts: T0 + 100, agentId: 'abc123', usage: { input: 1 } }), AGENT_CTX)
  // No result named the agent, so nothing ties it to the launch yet.
  assert.equal(agentOf(agg, AGENT).spawnerFile, null)
  assert.equal(agentOf(agg, AGENT).outcome, null)
  assert.equal(agg.needsAgentMeta(AGENT), true)
  agg.setAgentMeta(AGENT, { agentType: 'Explore', model: 'haiku', spawnDepth: 1, toolUseId: 'toolu_bg' })
  const rec = agentOf(agg, AGENT)
  assert.deepEqual(rec.meta, { agentType: 'Explore', model: 'haiku', spawnDepth: 1, toolUseId: 'toolu_bg' })
  assert.equal(rec.metaTries, 1)
  assert.equal(rec.spawnerFile, MAIN)
  assert.equal(launchOf(agg, 'toolu_bg').agentId, 'abc123')
  // The launch's result goes to a record that had none.
  assert.equal(rec.outcome, 'completed')
  assert.equal(rec.outcomeTs, T0 + 900)
  assert.equal(agg.needsAgentMeta(AGENT), false)

  // A nested agent: its sidecar is read before the launch in its parent agent's transcript.
  const nested = new Aggregator()
  nested.addClaudeLine(claudeLine({ id: 'n1', ts: T0 + 200, agentId: '0ff1ce', usage: { input: 1 } }), NESTED_CTX)
  nested.setAgentMeta(NESTED, { agentType: 'Plan', model: null, spawnDepth: 2, toolUseId: 'toolu_nested' })
  assert.equal(agentOf(nested, NESTED).spawnerFile, null)
  nested.addClaudeLine(agentToolUseLine({ id: 'p1', ts: T0 + 150, toolUseId: 'toolu_nested', agentId: 'abc123', subagentType: 'Plan' }), AGENT_CTX)
  assert.equal(agentOf(nested, NESTED).spawnerFile, AGENT)
  assert.equal(launchOf(nested, 'toolu_nested').file, AGENT)
  assert.equal(launchOf(nested, 'toolu_nested').agentId, '0ff1ce')
})

test('a sidecar is asked for three times at most; what it holds is sanitised again on the way in', () => {
  const agg = new Aggregator()
  // No record, no sidecar.
  assert.equal(agg.needsAgentMeta(AGENT), false)
  agg.setAgentMeta(AGENT, { agentType: 'Explore', model: null, spawnDepth: 1, toolUseId: null })
  assert.equal(agg.agents().length, 0)

  agg.addClaudeLine(claudeLine({ id: 's1', ts: T0, agentId: 'abc123', usage: { input: 1 } }), AGENT_CTX)
  for (let i = 1; i <= 3; i++) {
    assert.equal(agg.needsAgentMeta(AGENT), true, `try ${i}`)
    agg.setAgentMeta(AGENT, null)
    assert.equal(agentOf(agg, AGENT).metaTries, i)
  }
  assert.equal(agg.needsAgentMeta(AGENT), false)
  assert.equal(agentOf(agg, AGENT).meta, null)

  const dirty = new Aggregator()
  dirty.addClaudeLine(claudeLine({ id: 's1', ts: T0, agentId: 'abc123', usage: { input: 1 } }), AGENT_CTX)
  dirty.setAgentMeta(AGENT, { agentType: 'T'.repeat(41), model: 'opus', spawnDepth: 0, toolUseId: 'toolu bad' })
  assert.deepEqual(agentOf(dirty, AGENT).meta, { agentType: null, model: 'opus', spawnDepth: null, toolUseId: null })
  // Nothing usable at all is a try, not an identity.
  const empty = new Aggregator()
  empty.addClaudeLine(claudeLine({ id: 's1', ts: T0, agentId: 'abc123', usage: { input: 1 } }), AGENT_CTX)
  empty.setAgentMeta(AGENT, { agentType: '<x>', model: '', spawnDepth: 1.5, toolUseId: '' })
  assert.equal(agentOf(empty, AGENT).meta, null)
  assert.equal(agentOf(empty, AGENT).metaTries, 1)
})

// ---------------------------------------------------------------------------
// Sanitisers
// ---------------------------------------------------------------------------

test('the sanitisers hold every free string to its alphabet and cap, and drop the rest whole', () => {
  for (const ok of ['general-purpose', 'Explore', 'plugin:reviewer@v2/x.y', 'claude-opus-4-6', 'a'.repeat(AGENT_NAME_MAX_CHARS)]) {
    assert.equal(cleanAgentName(ok), ok)
  }
  assert.equal(cleanAgentName('a'.repeat(AGENT_NAME_MAX_CHARS + 1)), null)
  assert.equal(cleanAgentName('m'.repeat(AGENT_MODEL_MAX_CHARS), AGENT_MODEL_MAX_CHARS), 'm'.repeat(AGENT_MODEL_MAX_CHARS))
  assert.equal(cleanAgentName('m'.repeat(AGENT_MODEL_MAX_CHARS + 1), AGENT_MODEL_MAX_CHARS), null)
  const hostile: unknown[] = [
    '', 'two words', '<script>', 'quote"', "it's", 'tab\there', 'new\nline', 'ümlaut', 'semi;colon', 'a&b', 'a[1m]',
    null, undefined, 7, {}, ['Explore'],
  ]
  for (const bad of hostile) {
    assert.equal(cleanAgentName(bad), null, JSON.stringify(bad))
    assert.equal(cleanAgentId(bad), null, JSON.stringify(bad))
  }
  for (const ok of ['toolu_01AbC-9', 'abc123', 'wf_0a1b2c3d-123', 'x'.repeat(AGENT_ID_MAX_CHARS)]) assert.equal(cleanAgentId(ok), ok)
  for (const bad of ['x'.repeat(AGENT_ID_MAX_CHARS + 1), 'a.b', 'a:b', 'a/b', 'a@b']) assert.equal(cleanAgentId(bad), null, bad)
})

test('parseAgentMeta reads four fields of a sidecar and nothing else', () => {
  const text = metaJson({
    agentType: 'Explore', model: 'opus', spawnDepth: 2, toolUseId: 'toolu_x', parentAgentId: 'abc123',
    description: 'SIDECAR-DESCRIPTION', prompt: 'SIDECAR-PROMPT', extra: { requestShape: 'SIDECAR-SHAPE', requestNonInteractive: true },
  })
  const meta = parseAgentMeta(text)
  assert.deepEqual(meta, { agentType: 'Explore', model: 'opus', spawnDepth: 2, toolUseId: 'toolu_x' })
  assert.equal(JSON.stringify(meta).includes('SIDECAR'), false)
  // An older or partial sidecar: what is there, the rest absent.
  assert.deepEqual(parseAgentMeta(metaJson({ agentType: 'Plan', model: null, toolUseId: null })), {
    agentType: 'Plan', model: null, spawnDepth: 1, toolUseId: null,
  })
  for (const depth of [0, -1, 1.5, 100, '2']) {
    assert.equal(parseAgentMeta(metaJson({ spawnDepth: depth as number }))?.spawnDepth, null, String(depth))
  }
  assert.equal(parseAgentMeta(metaJson({ spawnDepth: 99 }))?.spawnDepth, 99)
  for (const junk of ['', 'not json', '[]', '"Explore"', '7', 'null', '{}']) assert.equal(parseAgentMeta(junk), null, junk)
  assert.equal(parseAgentMeta(metaJson({ agentType: null, model: null, spawnDepth: null, toolUseId: null })), null)
})

test('no agent or launch record holds a string longer than its cap', () => {
  const agg = new Aggregator()
  // A session directory far longer than any id, and a workflow directory to match.
  const longSession = 'f'.repeat(80)
  const deep = path.join(SLUG_DIR, longSession, 'subagents', 'workflows', `wf_${'x'.repeat(80)}`, 'agent-abcabc.jsonl')
  const deepCtx = ctxFor({ file: deep, isSub: true })
  agg.addClaudeLine(claudeLine({ id: 'h1', ts: T0, agentId: 'abcabc', model: `claude-${'m'.repeat(100)}`, usage: { input: 1 } }), deepCtx)
  agg.addClaudeLine(claudeLine({ id: 'h2', ts: T0 + 1, agentId: 'abcabc', usage: { input: 1 } }), deepCtx)
  agg.setAgentMeta(deep, { agentType: 'T'.repeat(41), model: 'M'.repeat(41), spawnDepth: 1, toolUseId: 'u'.repeat(65) })
  agg.addClaudeLine(agentToolUseLine({ id: 'h3', ts: T0 + 2, toolUseId: 't'.repeat(64), subagentType: 'S'.repeat(41) }), MAIN_CTX)
  agg.addClaudeLine(agentToolUseLine({ id: 'h4', ts: T0 + 3, toolUseId: 't'.repeat(65) }), MAIN_CTX)
  agg.addClaudeLine(agentResultLine({ ts: T0 + 4, toolUseId: 't'.repeat(64), agentId: 'a'.repeat(65) }), MAIN_CTX)
  agg.addClaudeLine(agentResultLine({ ts: T0 + 5, toolUseId: 'u'.repeat(65), agentId: 'abcabc' }), MAIN_CTX)
  agg.addClaudeLine(queueOperationLine({ ts: T0 + 6, toolUseId: 'q'.repeat(65), status: 'completed' }), MAIN_CTX)
  // A file name whose id is longer than any id is no agent transcript.
  const tooLong = path.join(SLUG_DIR, SESSION, 'subagents', `agent-${'a'.repeat(65)}.jsonl`)
  agg.addClaudeLine(claudeLine({ id: 'h5', ts: T0 + 7, usage: { input: 1 } }), ctxFor({ file: tooLong, isSub: true }))

  const rec = agentOf(agg, deep)
  assert.equal(agg.agents().length, 1)
  assert.equal(rec.sessionId, 'f'.repeat(AGENT_ID_MAX_CHARS))
  assert.equal(rec.workflowId, null)
  assert.deepEqual(rec.models, ['claude-opus-4-6'])
  assert.deepEqual(rec.meta, { agentType: null, model: null, spawnDepth: 1, toolUseId: null })
  assert.deepEqual(agg.launches().map((l) => [l.toolUseId.length, l.typeHint, l.agentId]), [[64, null, null]])

  const capOf: Record<string, number> = {
    agentId: AGENT_ID_MAX_CHARS, sessionId: AGENT_ID_MAX_CHARS, workflowId: AGENT_ID_MAX_CHARS,
    toolUseId: AGENT_ID_MAX_CHARS, typeHint: AGENT_NAME_MAX_CHARS, modelHint: AGENT_NAME_MAX_CHARS,
    agentType: AGENT_NAME_MAX_CHARS, model: AGENT_NAME_MAX_CHARS,
  }
  // Fixed vocabularies, not free strings.
  const enums: Record<string, string[]> = { source: ['claude'], outcome: ['launched', 'completed', 'failed'] }
  // Paths are keys, not free strings: the transcript's own path is what every cursor holds too.
  const paths = new Set(['sessionFile', 'spawnerFile', 'file'])
  const check = (obj: Record<string, unknown>, where: string): void => {
    for (const [k, v] of Object.entries(obj)) {
      if (paths.has(k)) continue
      if (k in enums) {
        assert.ok(v === null || enums[k].includes(v as string), `${where}.${k} is ${String(v)}`)
      } else if (typeof v === 'string') {
        assert.ok(k in capOf, `${where}.${k} is a string field nobody capped`)
        assert.ok(v.length <= capOf[k], `${where}.${k} holds ${v.length} characters`)
      } else if (Array.isArray(v)) {
        for (const m of v) assert.ok(typeof m === 'string' && m.length <= AGENT_MODEL_MAX_CHARS, `${where}.${k}`)
      } else if (v && typeof v === 'object') {
        check(v as Record<string, unknown>, `${where}.${k}`)
      }
    }
  }
  for (const [file, r] of agg.agentEntries()) check(r as unknown as Record<string, unknown>, file)
  for (const l of agg.launches()) check(l as unknown as Record<string, unknown>, l.toolUseId)
  for (const [file, m] of agg.mainEntries()) check(m as unknown as Record<string, unknown>, file)
})

// ---------------------------------------------------------------------------
// The gate
// ---------------------------------------------------------------------------

test('a line that is no response, agent result or notification changes nothing', () => {
  const agg = new Aggregator()
  const lines = [
    // A shell's output mentions the words — inside a string, where the quotes are escaped.
    JSON.stringify({
      type: 'user', timestamp: iso(T0),
      message: { role: 'user', content: [{ tool_use_id: 'toolu_b', type: 'tool_result', content: 'x' }] },
      toolUseResult: { stdout: 'grep "agentId" <task-notification> "usage"', stderr: '' },
    }),
    // A todo list reports statuses, but no agent.
    JSON.stringify({
      type: 'user', timestamp: iso(T0),
      message: { role: 'user', content: [{ tool_use_id: 'toolu_t', type: 'tool_result', content: 'x' }] },
      toolUseResult: { oldTodos: [{ content: 'x', status: 'completed' }], newTodos: [] },
    }),
    // A failed tool's result is a plain string.
    JSON.stringify({ type: 'user', timestamp: iso(T0), toolUseResult: 'Error: agentId', message: { role: 'user', content: [] } }),
    // A notification delivered as the user's message is not the queue's record.
    JSON.stringify({ type: 'user', timestamp: iso(T0), message: { role: 'user', content: '<task-notification><tool-use-id>toolu_bg</tool-use-id><status>completed</status></task-notification>' } }),
    JSON.stringify({ type: 'attachment', timestamp: iso(T0), attachment: { type: 'skill_listing', content: 'x' } }),
    JSON.stringify({ type: 'progress', timestamp: iso(T0), data: { message: { type: 'assistant', message: { id: 'p', usage: { input_tokens: 5 } } } } }),
    '{"toolUseResult": {"agentId": broken',
  ]
  agg.addClaudeLine(agentToolUseLine({ id: 'm', ts: T0 - 1, toolUseId: 'toolu_bg', background: true }), MAIN_CTX)
  const before = JSON.stringify(agg.toSnapshot())
  for (const line of lines) assert.equal(agg.addClaudeLine(line, MAIN_CTX), false, line.slice(0, 60))
  assert.equal(JSON.stringify(agg.toSnapshot()), before)
})

// ---------------------------------------------------------------------------
// agentsOnly
// ---------------------------------------------------------------------------

test('agentsOnly fills the agent tables and touches nothing that counts', () => {
  const lines: Array<[string, IngestContext]> = [
    [claudeLine({ id: 'm1', ts: T0, usage: { input: 10, output: 5 }, final: true }), MAIN_CTX],
    [agentToolUseLine({ id: 'm2', ts: T0 + 1000, toolUseId: 'toolu_s', subagentType: 'Explore' }), MAIN_CTX],
    [claudeLine({ id: 'a1', ts: T0 + 2000, agentId: 'abc123', usage: { input: 50, output: 10 }, tools: [{ name: 'Read', id: 'toolu_r' }] }), AGENT_CTX],
    [claudeLine({ id: 'a1', ts: T0 + 2500, agentId: 'abc123', usage: { input: 50, output: 30 }, final: true }), AGENT_CTX],
    [agentResultLine({ ts: T0 + 9000, toolUseId: 'toolu_s', agentId: 'abc123', totals: TOTALS }), MAIN_CTX],
    [queueOperationLine({ ts: T0 + 9500, toolUseId: 'toolu_s', status: 'completed' }), MAIN_CTX],
  ]
  // Both start from the same counting state, written before any of the lines.
  const seed = (agg: Aggregator): void => {
    agg.cursors.set(MAIN, { offset: 10, size: 10, ino: 1, dev: 1, mtime: 5 })
    agg.addClaudeLine(claudeLine({ id: 'old', ts: T0 - 5000, usage: { input: 3 }, tools: [{ name: 'Bash', id: 'toolu_b' }] }), { ...MAIN_CTX, attribution: 'session' })
  }
  const counted = new Aggregator()
  seed(counted)
  for (const [line, ctx] of lines) counted.addClaudeLine(line, { ...ctx, attribution: 'session' })

  const agg = new Aggregator()
  seed(agg)
  const before = counting(agg)
  for (const [line, ctx] of lines) agg.addClaudeLine(line, { ...ctx, attribution: 'session', agentsOnly: true })
  assert.equal(counting(agg), before, 'buckets, open messages, sessions, tools and cursors are as they were')
  // And the agent tables are exactly what counting the lines made of them.
  assert.deepEqual(agentTables(agg), agentTables(counted))
  assert.equal(agentOf(agg, AGENT).toolCalls, 1)
  assert.equal(agentOf(agg, AGENT).output, 30)
})

// ---------------------------------------------------------------------------
// Scanning real files: sidecars, the replay, privacy
// ---------------------------------------------------------------------------

interface World {
  home: string
  main: string
  agent: string
  sync: string
  nested: string
  wfAgent: string
  journal: string
}

function writeLines(file: string, lines: string[]): void {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, lines.map((l) => `${l}\n`).join(''))
}

function writeSidecar(file: string, text: string): void {
  fs.writeFileSync(file.replace(/\.jsonl$/, '.meta.json'), text)
}

/**
 * One session on disk: a sync agent, a background agent that launches a nested one, and a
 * workflow run with its journal. Every description, prompt, summary and answer carries
 * `secret`, so a test can look for it anywhere it must not be.
 */
function writeWorld(secret: string): World {
  const home = tmpDir('agents')
  const dir = path.join(home, 'projects', CLAUDE_SLUG)
  const sub = path.join(dir, SESSION, 'subagents')
  const w: World = {
    home,
    main: path.join(dir, `${SESSION}.jsonl`),
    agent: path.join(sub, 'agent-abc123.jsonl'),
    sync: path.join(sub, 'agent-feed01.jsonl'),
    nested: path.join(sub, 'agent-0ff1ce.jsonl'),
    wfAgent: path.join(sub, 'workflows', WF, 'agent-def456.jsonl'),
    journal: path.join(sub, 'workflows', WF, 'journal.jsonl'),
  }
  const text = (what: string): string => `${secret}-${what}`
  writeLines(w.main, [
    claudeLine({ id: 'm1', ts: T0, sessionId: SESSION, usage: { input: 10, output: 5 }, final: true }),
    agentToolUseLine({ id: 'm2', ts: T0 + 1000, toolUseId: 'toolu_sync', subagentType: 'Explore', model: 'haiku', description: text('launch-description'), prompt: text('launch-prompt') }),
    agentToolUseLine({ id: 'm3', ts: T0 + 2000, toolUseId: 'toolu_bg', background: true, description: text('bg-description'), prompt: text('bg-prompt') }),
    agentResultLine({ ts: T0 + 2100, toolUseId: 'toolu_bg', agentId: 'abc123', status: 'async_launched', description: text('async-description'), prompt: text('async-prompt') }),
    agentResultLine({ ts: T0 + 30_000, toolUseId: 'toolu_sync', agentId: 'feed01', totals: TOTALS, prompt: text('sync-prompt'), answer: text('sync-answer') }),
    queueOperationLine({ ts: T0 + 60_000, toolUseId: 'toolu_bg', status: 'completed', summary: text('summary'), outputFile: `/tmp/${text('output-file')}` }),
  ])
  writeLines(w.sync, [
    claudeLine({ id: 's1', ts: T0 + 1500, agentId: 'feed01', model: 'claude-haiku-4-5', usage: { input: 40, output: 8 }, final: true }),
  ])
  writeSidecar(w.sync, metaJson({ agentType: 'Explore', model: 'haiku', toolUseId: 'toolu_sync', description: text('sync-meta-description'), prompt: text('sync-meta-prompt') }))
  writeLines(w.agent, [
    claudeLine({ id: 'a1', ts: T0 + 2500, agentId: 'abc123', usage: { input: 50, output: 10 } }),
    agentToolUseLine({ id: 'a2', ts: T0 + 3000, toolUseId: 'toolu_nested', agentId: 'abc123', subagentType: 'Plan', description: text('nested-description'), prompt: text('nested-prompt') }),
    agentResultLine({ ts: T0 + 20_000, toolUseId: 'toolu_nested', agentId: '0ff1ce', inAgent: 'abc123', totals: { tokens: 99, durationMs: 1000, toolUses: 0 }, answer: text('nested-answer') }),
    claudeLine({ id: 'a3', ts: T0 + 50_000, agentId: 'abc123', usage: { input: 5, output: 40 } }),
  ])
  writeSidecar(w.agent, metaJson({ agentType: 'general-purpose', model: 'opus', toolUseId: 'toolu_bg', description: text('meta-description'), prompt: text('meta-prompt'), extra: { requestShape: text('shape') } }))
  writeLines(w.nested, [
    claudeLine({ id: 'n1', ts: T0 + 3500, agentId: '0ff1ce', usage: { input: 7, output: 2 }, final: true }),
  ])
  writeSidecar(w.nested, metaJson({ agentType: 'Plan', model: null, spawnDepth: 2, toolUseId: 'toolu_nested', parentAgentId: 'abc123', description: text('nested-meta-description') }))
  writeLines(w.wfAgent, [
    claudeLine({ id: 'w1', ts: T0 + 4000, agentId: 'def456', model: 'claude-fable-5', usage: { input: 3, output: 1 } }),
  ])
  writeSidecar(w.wfAgent, metaJson({ agentType: 'workflow-subagent', model: 'fable', toolUseId: null, extra: { worktreePath: `/home/tester/${text('worktree')}`, spawnedWithWorktree: true } }))
  writeLines(w.journal, [
    journalLine({ type: 'started', agentId: 'def456' }),
    journalLine({ type: 'result', agentId: 'def456', result: { summary: text('journal-summary'), commit: text('journal-commit') } }),
  ])
  // An empty Codex home of its own, so a scan never wanders into the machine's real one.
  configureRoots([home], [path.join(home, 'codex')])
  return w
}

test('a scan builds the whole tree\'s records from a session on disk', async () => {
  const w = writeWorld('WORLD')
  const agg = new Aggregator()
  await scan(agg)

  const bg = agentOf(agg, w.agent)
  assert.deepEqual(bg.meta, { agentType: 'general-purpose', model: 'opus', spawnDepth: 1, toolUseId: 'toolu_bg' })
  assert.equal(bg.spawnerFile, w.main)
  assert.equal(bg.sessionFile, w.main)
  assert.equal(bg.outcome, 'completed')
  assert.equal(bg.outcomeTs, T0 + 60_000, 'the notification, not the launch report')
  assert.equal(bg.toolCalls, 1)
  assert.equal(bg.requests, 3)

  const sync = agentOf(agg, w.sync)
  assert.equal(sync.outcome, 'completed')
  assert.equal(sync.outcomeTs, T0 + 30_000)
  assert.equal(launchOf(agg, 'toolu_sync').typeHint, 'Explore')
  assert.deepEqual(launchOf(agg, 'toolu_sync').totals, TOTALS)

  // Scanned before its parent agent, the nested agent still finds the launch that made it.
  const nested = agentOf(agg, w.nested)
  assert.equal(nested.meta?.spawnDepth, 2)
  assert.equal(nested.spawnerFile, w.agent)
  assert.equal(nested.outcome, 'completed')
  assert.equal(launchOf(agg, 'toolu_nested').file, w.agent)

  const wf = agentOf(agg, w.wfAgent)
  assert.equal(wf.workflowId, WF)
  assert.equal(wf.sessionFile, w.main)
  assert.equal(wf.outcome, 'completed')
  assert.equal(wf.outcomeTs, null)
  assert.deepEqual(wf.meta, { agentType: 'workflow-subagent', model: 'fable', spawnDepth: 1, toolUseId: null })

  assert.deepEqual(agg.mainEntries().map(([f, m]) => [f, m.requests]), [[w.main, 3]])
  assert.equal(agg.agents().length, 4)
  // Six responses in agent transcripts; the journal is no transcript and counted none.
  assert.equal(agg.all().filter((b) => b.isSub).reduce((s, b) => s + b.requests, 0), 6)
})

test('descriptions, prompts, summaries and answers never reach the snapshot', async () => {
  const secret = 'NEVER-STORED-7f3a'
  writeWorld(secret)
  const agg = new Aggregator()
  await scan(agg, { ctx: { attribution: 'session', projectSalt: 'salt', hashProjects: false } })
  const json = JSON.stringify(agg.toSnapshot())
  assert.equal(json.includes(secret), false, 'a description, prompt, summary or answer reached the snapshot')
  for (const word of ['description', 'prompt', 'summary', 'output-file', 'outputFile', 'requestShape', 'worktreePath']) {
    assert.equal(json.includes(`"${word}"`), false, word)
  }
  // The identifiers are all there: the absence above is not an empty snapshot.
  for (const id of ['toolu_bg', 'toolu_sync', 'toolu_nested', 'abc123', 'feed01', '0ff1ce', 'def456', WF]) {
    assert.ok(json.includes(id), id)
  }
})

test('scan reads an agent\'s sidecar after its lines: at most 64 KB, never through a link, three tries', async (t) => {
  const home = tmpDir('sidecar')
  const sub = path.join(home, 'projects', CLAUDE_SLUG, SESSION, 'subagents')
  const file = (id: string): string => path.join(sub, `agent-${id}.jsonl`)
  for (const id of ['a0', 'b16', 'c11', 'd0', 'e1a7e']) {
    writeLines(file(id), [claudeLine({ id: `msg_${id}`, ts: T0, agentId: id, usage: { input: 1 } })])
  }
  writeSidecar(file('a0'), metaJson({ agentType: 'Explore', model: 'haiku', toolUseId: 'toolu_a0' }))
  writeSidecar(file('b16'), metaJson({ agentType: 'Explore', extra: { padding: 'x'.repeat(AGENT_META_MAX_BYTES) } }))
  let linked = true
  try {
    fs.symlinkSync(file('a0').replace(/\.jsonl$/, '.meta.json'), file('c11').replace(/\.jsonl$/, '.meta.json'))
  } catch {
    linked = false
    t.diagnostic('no symlinks here: the link case was not laid out')
  }
  configureRoots([home], [path.join(home, 'codex')])

  const agg = new Aggregator()
  // Five counted lines and one sidecar that gave its record an identity.
  assert.equal(await scan(agg), 6)
  assert.deepEqual(agentOf(agg, file('a0')).meta, { agentType: 'Explore', model: 'haiku', spawnDepth: 1, toolUseId: 'toolu_a0' })
  assert.equal(agentOf(agg, file('b16')).meta, null, 'a sidecar beyond 64 KB is absent')
  if (linked) assert.equal(agentOf(agg, file('c11')).meta, null, 'a sidecar behind a link is absent')
  assert.equal(agentOf(agg, file('d0')).metaTries, 1)
  // The files are unchanged, but the records still waiting ask again; a sidecar that turns up is taken.
  writeSidecar(file('e1a7e'), metaJson({ agentType: 'Plan', toolUseId: null }))
  assert.equal(await scan(agg), 1)
  assert.equal(agentOf(agg, file('e1a7e')).meta?.agentType, 'Plan')
  await scan(agg)
  assert.equal(agentOf(agg, file('d0')).metaTries, 3)
  await scan(agg)
  assert.equal(agentOf(agg, file('d0')).metaTries, 3, 'three tries, then no more')
  assert.equal(agentOf(agg, file('a0')).metaTries, 1, 'a record with its identity asks no more')
  // No sidecar ever became a transcript or a cursor.
  assert.equal([...agg.cursors.keys()].some((k) => k.endsWith('.meta.json')), false)

  assert.equal(await readAgentMeta(path.join(sub, 'nothing-here.jsonl')), null)
  assert.equal(await readAgentMeta(file('a0').replace(/\.jsonl$/, '.txt')), null)
  fs.mkdirSync(file('f0').replace(/\.jsonl$/, '.meta.json'))
  assert.equal(await readAgentMeta(file('f0')), null, 'a directory is no sidecar')
  // 64 KB exactly is still a sidecar; one byte more is not.
  const exact = (size: number): string => {
    const bare = metaJson({ agentType: 'Explore', toolUseId: null, extra: { padding: '' } })
    return metaJson({ agentType: 'Explore', toolUseId: null, extra: { padding: 'x'.repeat(size - bare.length) } })
  }
  writeSidecar(file('ed9e'), exact(AGENT_META_MAX_BYTES))
  assert.equal((await readAgentMeta(file('ed9e')))?.agentType, 'Explore')
  writeSidecar(file('ed9e'), exact(AGENT_META_MAX_BYTES + 1))
  assert.equal(await readAgentMeta(file('ed9e')), null)
})

test('replayAgents rebuilds the agent tables from what was counted, and nothing else', async () => {
  const w = writeWorld('REPLAY')
  const full = new Aggregator()
  await scan(full)
  const expected = agentTables(full)

  // What a version 6 build left behind: the same counting, no agent tables, no links.
  const snap = JSON.parse(JSON.stringify(full.toSnapshot())) as Snapshot
  snap.version = 6
  for (const p of Object.values(snap.pending)) { delete p.agent; delete p.main }
  const agg = Aggregator.fromSnapshot(snap)
  assert.equal(agg.agents().length, 0)
  assert.equal(agg.agentsReplayed, false)
  const before = counting(agg)

  // A line appended since the last scan belongs to the next scan, and a new file too.
  fs.appendFileSync(w.agent, `${claudeLine({ id: 'a4', ts: T0 + 70_000, agentId: 'abc123', usage: { input: 1000 } })}\n`)
  const fresh = path.join(path.dirname(w.agent), 'agent-f4e5.jsonl')
  writeLines(fresh, [claudeLine({ id: 'f1', ts: T0 + 80_000, agentId: 'f4e5', usage: { input: 1 } })])

  const files = agentReplayFiles(agg, Date.now())
  assert.ok(files.includes(w.journal), 'a journal is selected by its modification time')
  assert.ok((await replayAgents(agg, [...files, fresh, path.join(w.home, 'elsewhere.jsonl')])) > 0)
  assert.equal(counting(agg), before, 'no bucket, open message, session, tool or cursor moved')
  assert.deepEqual(agentTables(agg), expected)
  assert.equal(agg.agentsReplayed, false, 'the flag is the host\'s to set once the replay is saved')

  // A second replay rebuilds the same tables rather than doubling them.
  await replayAgents(agg, agentReplayFiles(agg, Date.now()))
  assert.deepEqual(agentTables(agg), expected)

  // The next scan brings the rest, once.
  await scan(agg)
  assert.equal(agentOf(agg, w.agent).input, agentOf(full, w.agent).input + 1000)
  assert.equal(agentOf(agg, fresh).input, 1)
})

test('agentReplayFiles picks the Claude files that changed within the retention', () => {
  const home = tmpDir('pick')
  configureRoots([home], [path.join(home, 'codex')])
  const root = path.join(home, 'projects', CLAUDE_SLUG)
  const now = T0
  const agg = new Aggregator()
  const at = (name: string, cur: { lastTs?: number; mtime?: number }): string => {
    const file = path.join(root, name)
    agg.cursors.set(file, { ...newCursor(), ...cur })
    return file
  }
  const recent = at('recent.jsonl', { lastTs: now - DAY, mtime: now - DAY })
  const journal = at(path.join(SESSION, 'subagents', 'workflows', WF, 'journal.jsonl'), { mtime: now - DAY })
  at('old.jsonl', { lastTs: now - (AGENT_RETENTION_DAYS + 1) * DAY, mtime: now - (AGENT_RETENTION_DAYS + 1) * DAY })
  at('never-read.jsonl', {})
  agg.cursors.set(path.join(home, 'codex', 'sessions', 'rollout-x.jsonl'), { ...newCursor(), lastTs: now, mtime: now })
  assert.deepEqual(agentReplayFiles(agg, now), [recent, journal].sort())
})

test('agentTranscriptsOf lists a session\'s agents and workflow runs, two levels and no links', async () => {
  const w = writeWorld('LIST')
  const stray = path.join(path.dirname(w.agent), 'deeper', 'agent-00.jsonl')
  writeLines(stray, ['{}'])
  assert.deepEqual(await agentTranscriptsOf(w.main), [w.nested, w.agent, w.sync, w.wfAgent, w.journal].sort())
  assert.deepEqual(await agentTranscriptsOf(path.join(w.home, 'none.jsonl')), [])
  assert.deepEqual(await agentTranscriptsOf(w.agent.replace(/\.jsonl$/, '.meta.json')), [])
})

// ---------------------------------------------------------------------------
// Retention and the snapshot
// ---------------------------------------------------------------------------

test('the roll-up keeps agents, launches, main sessions and waiting results for seven days', () => {
  const now = T0
  const old = now - (AGENT_RETENTION_DAYS + 1) * DAY
  const recent = now - DAY
  const agg = new Aggregator()
  const oldMain = path.join(SLUG_DIR, 'old-session.jsonl')
  const oldAgent = path.join(SLUG_DIR, 'old-session', 'subagents', 'agent-0001d.jsonl')
  const lateAgent = path.join(SLUG_DIR, SESSION, 'subagents', 'agent-1a7e.jsonl')
  agg.addClaudeLine(agentToolUseLine({ id: 'o1', ts: old, toolUseId: 'toolu_old' }), ctxFor({ file: oldMain }))
  agg.addClaudeLine(claudeLine({ id: 'o2', ts: old + 1000, agentId: '0001d', usage: { input: 1 } }), ctxFor({ file: oldAgent, isSub: true }))
  agg.addClaudeLine(agentToolUseLine({ id: 'r1', ts: recent, toolUseId: 'toolu_new' }), MAIN_CTX)
  agg.addClaudeLine(claudeLine({ id: 'r2', ts: recent + 1000, agentId: 'abc123', usage: { input: 1 } }), AGENT_CTX)
  // Its last line is old, but its result came in lately: it stays.
  agg.addClaudeLine(claudeLine({ id: 'l1', ts: old, agentId: '1a7e', usage: { input: 1 } }), ctxFor({ file: lateAgent, isSub: true }))
  agg.addWorkflowJournalLine(journalLine({ type: 'result', agentId: '1a7e', ts: recent }), JOURNAL_CTX)
  // Waiting results: one of unknown time, one recent, one old.
  agg.addWorkflowJournalLine(journalLine({ type: 'result', agentId: 'wait0' }), JOURNAL_CTX)
  agg.addWorkflowJournalLine(journalLine({ type: 'result', agentId: 'wait1', ts: recent }), JOURNAL_CTX)
  agg.addWorkflowJournalLine(journalLine({ type: 'result', agentId: 'wait2', ts: old }), JOURNAL_CTX)
  assert.equal(agg.mains().length, 2)
  const buckets = agg.all().length

  agg.rollup(now, 45, 400, utc)
  assert.deepEqual(agg.agentEntries().map(([f]) => f).sort(), [AGENT, lateAgent].sort())
  assert.deepEqual(agg.launches().map((l) => l.toolUseId), ['toolu_new'])
  assert.deepEqual(agg.mainEntries().map(([f]) => f), [MAIN], 'the old main session is gone')
  assert.deepEqual(agg.toSnapshot().journalResults, { wait1: recent })
  // The buckets keep their own, far longer retention.
  assert.equal(agg.all().length, buckets)
  // The pruned agent is gone from the lookups too: a result for it now waits for a transcript.
  agg.addWorkflowJournalLine(journalLine({ type: 'result', agentId: '0001d', ts: now }), JOURNAL_CTX)
  assert.equal(agg.toSnapshot().journalResults?.['0001d'], now)
  // Running it again changes nothing.
  const once = JSON.stringify(agentTables(agg))
  agg.rollup(now, 45, 400, utc)
  assert.equal(JSON.stringify(agentTables(agg)), once)
})

function sampleAgg(): Aggregator {
  const agg = new Aggregator()
  agg.addClaudeLine(claudeLine({ id: 'm1', ts: T0, usage: { input: 10, output: 5 }, final: true }), MAIN_CTX)
  agg.addClaudeLine(agentToolUseLine({ id: 'm2', ts: T0 + 1000, toolUseId: 'toolu_bg', background: true, subagentType: 'Explore' }), MAIN_CTX)
  agg.addClaudeLine(agentResultLine({ ts: T0 + 1100, toolUseId: 'toolu_bg', agentId: 'abc123', status: 'async_launched' }), MAIN_CTX)
  agg.addClaudeLine(claudeLine({ id: 'a1', ts: T0 + 2000, agentId: 'abc123', usage: { input: 50, output: 10 }, tools: [{ name: 'Read', id: 'toolu_r' }] }), AGENT_CTX)
  agg.setAgentMeta(AGENT, { agentType: 'Explore', model: 'haiku', spawnDepth: 1, toolUseId: 'toolu_bg' })
  agg.addClaudeLine(claudeLine({ id: 'w1', ts: T0 + 3000, agentId: 'def456', usage: { input: 3 } }), WF_CTX)
  agg.addWorkflowJournalLine(journalLine({ type: 'result', agentId: 'c0ffee', ts: T0 + 4000 }), JOURNAL_CTX)
  return agg
}

test('the agent tables survive a snapshot round trip at version 7, lookups included', () => {
  const agg = sampleAgg()
  agg.agentsReplayed = true
  const snap = JSON.parse(JSON.stringify(agg.toSnapshot())) as Snapshot
  assert.equal(snap.version, STATE_VERSION)
  assert.equal(STATE_VERSION, 7)
  assert.deepEqual(Object.keys(snap.agents ?? {}).sort(), [AGENT, WF_AGENT].sort())
  assert.deepEqual(Object.keys(snap.launches ?? {}), ['toolu_bg'])
  assert.deepEqual(Object.keys(snap.mains ?? {}), [MAIN])
  assert.deepEqual(snap.journalResults, { c0ffee: T0 + 4000 })
  assert.equal(snap.agentsReplayed, true)
  assert.equal(snap.pending.a1.agent, 'agent-abc123')

  const back = Aggregator.fromSnapshot(snap)
  assert.deepEqual(JSON.parse(JSON.stringify(back.toSnapshot())), snap)
  assert.equal(back.agentsReplayed, true)
  // The lookups are rebuilt with the tables: the notification finds its launch, the launch its agent…
  assert.equal(back.addClaudeLine(queueOperationLine({ ts: T0 + 9000, toolUseId: 'toolu_bg', status: 'completed' }), MAIN_CTX), true)
  assert.equal(agentOf(back, AGENT).outcome, 'completed')
  // …a journal line its agent by id, and a waiting result the agent that turns up.
  back.addWorkflowJournalLine(journalLine({ type: 'result', agentId: 'def456' }), JOURNAL_CTX)
  assert.equal(agentOf(back, WF_AGENT).outcome, 'completed')
  const waiting = path.join(SLUG_DIR, SESSION, 'subagents', 'workflows', WF, 'agent-c0ffee.jsonl')
  back.addClaudeLine(claudeLine({ id: 'c1', ts: T0 + 5000, agentId: 'c0ffee', usage: { input: 1 } }), ctxFor({ file: waiting, isSub: true }))
  assert.equal(agentOf(back, waiting).outcomeTs, T0 + 4000)
  assert.deepEqual(back.toSnapshot().journalResults, {})
  // The agent's open message goes on after the restore — onto its record, and once.
  back.addClaudeLine(claudeLine({ id: 'a1', ts: T0 + 2500, agentId: 'abc123', usage: { input: 50, output: 30 }, final: true }), AGENT_CTX)
  const rec = agentOf(back, AGENT)
  assert.equal(rec.output, 30)
  assert.equal(rec.requests, 1)
  assert.equal(rec.outputFinal, 1)
})

test('a version 6 or 5 snapshot loads without agent tables and asks for the replay', () => {
  const agg = sampleAgg()
  agg.agentsReplayed = true
  const snap = JSON.parse(JSON.stringify(agg.toSnapshot())) as Snapshot
  for (const version of [6, 5]) {
    // Even with the tables in it: a version 6 build could not have written them.
    const old = Aggregator.fromSnapshot({ ...snap, version })
    assert.equal(old.agents().length, 0, `v${version}`)
    assert.equal(old.launches().length, 0, `v${version}`)
    assert.equal(old.mains().length, 0, `v${version}`)
    assert.deepEqual(old.toSnapshot().journalResults, {}, `v${version}`)
    assert.equal(old.agentsReplayed, false, `v${version}`)
    // The counting loads as before, and is written back as version 7.
    assert.deepEqual(old.all(), agg.all(), `v${version}`)
    assert.equal(old.toSnapshot().version, 7)
  }
  assert.equal(Aggregator.fromSnapshot({ ...snap, version: 8 }).all().length, 0)
})

test('a hand-edited snapshot cannot put a field or a string into the agent tables', () => {
  const snap = JSON.parse(JSON.stringify(sampleAgg().toSnapshot())) as Snapshot
  const raw = snap as unknown as Record<string, Record<string, Record<string, unknown>>>
  raw.agents[AGENT].description = 'EDITED-SECRET'
  raw.agents[AGENT].models = ['claude-opus-4-6', 'EDITED SECRET', 'x'.repeat(65)]
  raw.agents[WF_AGENT].agentId = 'x'.repeat(65)
  raw.agents['/elsewhere/agent-1.jsonl'] = { source: 'codex', agentId: '1', sessionFile: '/x.jsonl', firstTs: 1, lastTs: 1 }
  raw.launches.toolu_bg.typeHint = '<script>alert(1)</script>'
  raw.launches.toolu_bg.prompt = 'EDITED-SECRET'
  raw.launches.junk = 5 as unknown as Record<string, unknown>
  raw.mains[MAIN].summary = 'EDITED-SECRET'
  raw.journalResults['<b>x</b>'] = 1 as unknown as Record<string, unknown>
  raw.journalResults.negative = -5 as unknown as Record<string, unknown>
  const back = Aggregator.fromSnapshot(snap)
  const json = JSON.stringify(back.toSnapshot())
  assert.equal(json.includes('EDITED'), false)
  assert.equal(json.includes('<script>'), false)
  assert.deepEqual(back.agentEntries().map(([f]) => f), [AGENT])
  assert.deepEqual(agentOf(back, AGENT).models, ['claude-opus-4-6'])
  assert.equal(launchOf(back, 'toolu_bg').typeHint, null)
  assert.equal(back.launches().length, 1)
  assert.deepEqual(back.toSnapshot().journalResults, { c0ffee: T0 + 4000 })
})
