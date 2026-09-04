// SPDX-FileCopyrightText: 2026 Frederik Marx
// SPDX-License-Identifier: AGPL-3.0-or-later

import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { Aggregator, localDay } from '../src/agg'
import { addDays, dayOf, TimeConfig } from '../src/time'
import { Cursor, Snapshot, STATE_VERSION, TOOL_NAME_CAP, ToolStat } from '../src/types'
import {
  CLAUDE_MAIN, CODEX_FILE, claudeLine, codexExecBegin, codexItemCompleted, codexMcpBegin, codexMeta,
  codexTaskStarted, codexTokenCount, codexToolCall, codexTurnContext, ctxFor,
} from './fixtures/helpers'

const utc: TimeConfig = { zone: 'utc', dayBoundaryHour: 0, startOfWeek: 'monday', hourCycle: 'h23' }
const T0 = Date.UTC(2026, 2, 10, 9, 15, 0)
const DAY0 = localDay(T0)
const CTX = ctxFor()
const CODEX_CTX = ctxFor({ file: CODEX_FILE })
const DAY = 86_400_000

function cursor(over: Partial<Cursor> = {}): Cursor {
  return { offset: 0, size: 0, ino: 1, dev: 1, ...over }
}

/** name → calls, over every row the query returned. */
function byName(rows: ToolStat[]): Record<string, number> {
  const out: Record<string, number> = {}
  for (const r of rows) out[r.name] = (out[r.name] ?? 0) + r.calls
  return out
}

// ---------------------------------------------------------------------- Claude

test('the tool calls of one message arrive on its later lines and are counted there', () => {
  const agg = new Aggregator()
  // Exactly what Claude Code writes: one content block per line, all under one message.id.
  agg.addClaudeLine(claudeLine({ id: 'msg_a', ts: T0, usage: { input: 100, output: 1 } }), CTX)
  agg.addClaudeLine(claudeLine({ id: 'msg_a', ts: T0 + 300, usage: { input: 100, output: 4 }, tools: [{ name: 'Read', id: 'toolu_1' }] }), CTX)
  agg.addClaudeLine(claudeLine({ id: 'msg_a', ts: T0 + 600, usage: { input: 100, output: 9 }, tools: [{ name: 'Read', id: 'toolu_2' }] }), CTX)
  agg.addClaudeLine(claudeLine({ id: 'msg_a', ts: T0 + 900, usage: { input: 100, output: 12 }, tools: [{ name: 'Bash', id: 'toolu_3' }], final: true }), CTX)

  const q = agg.tools()
  // Two parallel Reads are two calls: they are separate blocks with separate ids.
  assert.deepEqual(byName(q.rows), { Read: 2, Bash: 1 })
  assert.equal(q.rows.every((r) => r.source === 'claude' && r.day === DAY0 && r.model === 'claude-opus-4-6'), true)
  assert.equal(q.truncated, false)
  assert.equal(q.firstDay, DAY0)
  // The tokens of the message are untouched by any of this.
  assert.equal(agg.all().length, 1)
  assert.equal(agg.all()[0].requests, 1)
})

test('a line read twice adds nothing; blocks without an id fall back to the max rule', () => {
  const agg = new Aggregator()
  const dup = claudeLine({ id: 'msg_b', ts: T0, usage: { input: 10, output: 2 }, tools: [{ name: 'Edit', id: 'toolu_9' }] })
  agg.addClaudeLine(dup, CTX)
  agg.addClaudeLine(dup, CTX)
  agg.addClaudeLine(dup, CTX)
  assert.deepEqual(byName(agg.tools().rows), { Edit: 1 })

  // Without block ids only the maximum per name can be trusted: repeating one line adds
  // nothing, and a line that carries two blocks lifts the count to two.
  const old = new Aggregator()
  const noId = claudeLine({ id: 'msg_c', ts: T0, usage: { input: 10, output: 2 }, tools: [{ name: 'Grep', id: null }] })
  old.addClaudeLine(noId, CTX)
  old.addClaudeLine(noId, CTX)
  assert.deepEqual(byName(old.tools().rows), { Grep: 1 })
  old.addClaudeLine(claudeLine({
    id: 'msg_c', ts: T0 + 100, usage: { input: 10, output: 5 },
    tools: [{ name: 'Grep', id: null }, { name: 'Grep', id: null }],
  }), CTX)
  assert.deepEqual(byName(old.tools().rows), { Grep: 2 })
})

test('a late line puts its tools on the message, not on the line', () => {
  const agg = new Aggregator()
  agg.addClaudeLine(claudeLine({ id: 'msg_d', ts: T0, model: 'claude-opus-4-6', usage: { input: 5, output: 1 } }), CTX)
  // A second message on the next day, then a straggler of the first one.
  agg.addClaudeLine(claudeLine({ id: 'msg_e', ts: T0 + DAY, model: 'claude-sonnet-4-6', usage: { input: 5, output: 1 }, tools: [{ name: 'Task' }] }), CTX)
  agg.addClaudeLine(claudeLine({
    id: 'msg_d', ts: T0 + DAY + 1000, model: 'claude-sonnet-4-6',
    usage: { input: 5, output: 4 }, tools: [{ name: 'WebFetch' }],
  }), CTX)

  const rows = agg.tools().rows
  const web = rows.find((r) => r.name === 'WebFetch')!
  assert.equal(web.day, DAY0, 'the straggler counts on its message’s day')
  assert.equal(web.model, 'claude-opus-4-6', 'and on its message’s model')
  assert.equal(rows.find((r) => r.name === 'Task')!.day, localDay(T0 + DAY))
})

test('server tools are not listed as tool calls — the bucket already counts them', () => {
  const agg = new Aggregator()
  agg.addClaudeLine(claudeLine({ id: 'msg_w', ts: T0, usage: { input: 5, output: 1, webSearch: 2, webFetch: 1 } }), CTX)
  assert.equal(agg.tools().rows.length, 0)
  assert.equal(agg.all()[0].webSearch, 2)
  assert.equal(agg.all()[0].webFetch, 1)
})

test('subagent lines feed the same table: the tool side table has no subagent dimension', () => {
  const agg = new Aggregator()
  const sub = ctxFor({ file: CLAUDE_MAIN, isSub: true })
  agg.addClaudeLine(claudeLine({ id: 'msg_f', ts: T0, usage: { input: 5, output: 1 }, tools: [{ name: 'Read' }] }), sub)
  agg.addClaudeLine(claudeLine({ id: 'msg_g', ts: T0, usage: { input: 5, output: 1 }, tools: [{ name: 'Read' }] }), CTX)
  const rows = agg.tools().rows
  assert.equal(rows.length, 1)
  assert.equal(rows[0].calls, 2)
})

test('at most 100 distinct names per source and day; the rest is dropped and the day says so', () => {
  const agg = new Aggregator()
  for (let i = 0; i < TOOL_NAME_CAP + 5; i++) {
    agg.addClaudeLine(claudeLine({
      id: `msg_cap_${i}`, ts: T0, usage: { input: 1, output: 1 }, tools: [{ name: `tool_${String(i).padStart(3, '0')}` }],
    }), CTX)
  }
  const q = agg.tools()
  assert.equal(q.rows.length, TOOL_NAME_CAP)
  assert.equal(q.truncated, true, 'the shortened list must announce itself')
  // A name that is already known keeps counting after the cap is reached.
  agg.addClaudeLine(claudeLine({ id: 'msg_cap_again', ts: T0, usage: { input: 1, output: 1 }, tools: [{ name: 'tool_000' }] }), CTX)
  assert.equal(byName(agg.tools().rows).tool_000, 2)
  // The next day starts with a clean list of names.
  agg.addClaudeLine(claudeLine({ id: 'msg_next', ts: T0 + DAY, usage: { input: 1, output: 1 }, tools: [{ name: 'fresh' }] }), CTX)
  const later = agg.tools(localDay(T0 + DAY), localDay(T0 + DAY))
  assert.deepEqual(byName(later.rows), { fresh: 1 })
  assert.equal(later.truncated, false)
})

// ----------------------------------------------------------------------- Codex

test('Codex response items are counted by tool name', () => {
  const agg = new Aggregator()
  const cur = cursor()
  const lines = [
    codexMeta({ ts: T0 }),
    codexTurnContext(T0, 'gpt-5.4'),
    codexTaskStarted(T0 + 1000),
    codexToolCall({ ts: T0 + 2000, name: 'exec', callId: 'call_1', custom: true }),
    codexToolCall({ ts: T0 + 3000, name: 'exec', callId: 'call_2', custom: true }),
    codexToolCall({ ts: T0 + 4000, name: 'send_message', callId: 'call_3' }),
    codexTokenCount({ ts: T0 + 5000, total: { input: 100, output: 20, total: 120 } }),
  ]
  let counted = 0
  for (const l of lines) if (agg.addCodexLine(l, cur, CODEX_CTX)) counted++
  // A tool line changes no token counter, so it is not a counted line.
  assert.equal(counted, 1)
  const q = agg.tools()
  assert.deepEqual(byName(q.rows), { exec: 2, send_message: 1 })
  assert.equal(q.rows.every((r) => r.source === 'codex' && r.model === 'gpt-5.4' && r.day === localDay(T0)), true)
})

test('older Codex builds: exec and MCP begin events, without doubling the item echo', () => {
  const agg = new Aggregator()
  const cur = cursor()
  const lines = [
    codexMeta({ ts: T0 }),
    codexTurnContext(T0, 'gpt-5.4'),
    codexExecBegin({ ts: T0 + 1000, callId: 'call_x' }),
    // Both shapes for one call: the id makes it one call, not two.
    codexToolCall({ ts: T0 + 1100, name: 'exec', callId: 'call_x', custom: true }),
    codexItemCompleted({ ts: T0 + 1200, itemType: 'CommandExecution', callId: 'call_x' }),
    codexMcpBegin({ ts: T0 + 2000, server: 'files', tool: 'read', callId: 'call_y' }),
    // A begin event with an unusable invocation names nothing and is skipped.
    JSON.stringify({ timestamp: new Date(T0 + 2500).toISOString(), type: 'event_msg', payload: { type: 'mcp_tool_call_begin', call_id: 'call_z', invocation: {} } }),
  ]
  for (const l of lines) agg.addCodexLine(l, cur, CODEX_CTX)
  assert.deepEqual(byName(agg.tools().rows), { exec: 1, 'files.read': 1 })
})

test('the replay prefix of a forked rollout brings no tool calls with it', () => {
  const agg = new Aggregator()
  const cur = cursor()
  const lines = [
    codexMeta({ ts: T0, forkedFrom: 'thread-0000' }),
    codexTurnContext(T0, 'gpt-5.4'),
    // Copied history: the parent already counted these.
    codexToolCall({ ts: T0 + 100, name: 'exec', callId: 'parent_1', custom: true }),
    codexToolCall({ ts: T0 + 200, name: 'apply_patch', callId: 'parent_2' }),
    codexTaskStarted(T0 + 5000),
    codexToolCall({ ts: T0 + 6000, name: 'exec', callId: 'own_1', custom: true }),
  ]
  for (const l of lines) agg.addCodexLine(l, cur, CODEX_CTX)
  assert.deepEqual(byName(agg.tools().rows), { exec: 1 })
})

test('a Codex call id is counted once, even across two rollout files', () => {
  const agg = new Aggregator()
  const a = cursor()
  const b = cursor({ ino: 2 })
  agg.addCodexLine(codexTaskStarted(T0), a, CODEX_CTX)
  agg.addCodexLine(codexToolCall({ ts: T0 + 10, name: 'exec', callId: 'call_same', custom: true }), a, CODEX_CTX)
  agg.addCodexLine(codexTaskStarted(T0), b, ctxFor({ file: CODEX_FILE + '.2' }))
  agg.addCodexLine(codexToolCall({ ts: T0 + 20, name: 'exec', callId: 'call_same', custom: true }), b, ctxFor({ file: CODEX_FILE + '.2' }))
  assert.deepEqual(byName(agg.tools().rows), { exec: 1 })
})

// ------------------------------------------------------------------- Queries

test('tools() filters by day range, source and model, and names its first day', () => {
  const agg = new Aggregator()
  const cur = cursor()
  agg.addClaudeLine(claudeLine({ id: 'q1', ts: T0, usage: { input: 1, output: 1 }, tools: [{ name: 'Read' }] }), CTX)
  agg.addClaudeLine(claudeLine({ id: 'q2', ts: T0 + DAY, model: 'claude-sonnet-4-6', usage: { input: 1, output: 1 }, tools: [{ name: 'Bash' }] }), CTX)
  agg.addCodexLine(codexTurnContext(T0 + DAY, 'gpt-5.4'), cur, CODEX_CTX)
  agg.addCodexLine(codexToolCall({ ts: T0 + DAY, name: 'exec', custom: true }), cur, CODEX_CTX)

  const d0 = localDay(T0)
  const d1 = localDay(T0 + DAY)
  assert.deepEqual(byName(agg.tools(d0, d0).rows), { Read: 1 })
  assert.deepEqual(byName(agg.tools(d1, d1).rows), { Bash: 1, exec: 1 })
  assert.deepEqual(byName(agg.tools(undefined, undefined, { source: 'codex' }).rows), { exec: 1 })
  assert.deepEqual(byName(agg.tools(undefined, undefined, { models: ['claude-sonnet-4-6'] }).rows), { Bash: 1 })
  assert.equal(agg.tools().firstDay, d0)
  assert.equal(agg.tools(d1, d1).firstDay, d1)
  assert.equal(agg.tools('2030-01-01', '2030-01-02').firstDay, null)
  // Ascending by day, then source, name, model — a stable order for every view.
  assert.deepEqual(agg.tools().rows.map((r) => `${r.day}|${r.source}|${r.name}`), [
    `${d0}|claude|Read`, `${d1}|claude|Bash`, `${d1}|codex|exec`,
  ])
  // The rows are copies: a caller cannot edit the table by editing its answer.
  agg.tools().rows[0].calls = 999
  assert.equal(byName(agg.tools().rows).Read, 1)
})

// --------------------------------------------------------- Roll-up and state

test('rollup drops tool rows past the day retention, flags included', () => {
  const agg = new Aggregator()
  const now = Date.UTC(2026, 2, 20, 12, 0)
  const oldDay = Date.UTC(2026, 1, 1, 10, 0)
  for (let i = 0; i < TOOL_NAME_CAP + 2; i++) {
    agg.addClaudeLine(claudeLine({
      id: `old_${i}`, ts: oldDay, usage: { input: 1, output: 1 }, tools: [{ name: `t_${String(i).padStart(3, '0')}` }],
    }), CTX)
  }
  agg.addClaudeLine(claudeLine({ id: 'new', ts: now - DAY, usage: { input: 1, output: 1 }, tools: [{ name: 'Read' }] }), CTX)
  assert.equal(agg.tools().truncated, true)

  agg.rollup(now, 2, 7, utc)
  const q = agg.tools()
  assert.deepEqual(byName(q.rows), { Read: 1 })
  assert.equal(q.truncated, false, 'the flag goes with the day it described')
  // Nothing older than the day horizon survives, and a second run changes nothing.
  const horizon = addDays(dayOf(now, utc), -7)
  assert.equal(q.rows.every((r) => r.day >= horizon), true)
  agg.rollup(now, 2, 7, utc)
  assert.deepEqual(byName(agg.tools().rows), { Read: 1 })
})

test('the tool table survives a snapshot round trip; a version 5 snapshot loads empty', () => {
  const agg = new Aggregator()
  agg.addClaudeLine(claudeLine({ id: 's1', ts: T0, usage: { input: 5, output: 1 } }), CTX)
  agg.addClaudeLine(claudeLine({ id: 's1', ts: T0 + 100, usage: { input: 5, output: 3 }, tools: [{ name: 'Read', id: 'toolu_a' }] }), CTX)
  const snap = agg.toSnapshot()
  assert.equal(snap.version, STATE_VERSION)
  assert.equal(STATE_VERSION, 6)
  assert.deepEqual(snap.tools, [{ source: 'claude', day: DAY0, model: 'claude-opus-4-6', name: 'Read', calls: 1 }])
  assert.deepEqual(snap.toolsTruncated, [])
  // Only names, ids and counts are persisted — no argument of a call.
  assert.equal(JSON.stringify(snap).includes('synthetic fixture text'), false)

  const back = Aggregator.fromSnapshot(JSON.parse(JSON.stringify(snap)))
  assert.deepEqual(byName(back.tools().rows), { Read: 1 })
  // The open message keeps its counted blocks, so a straggler of it still does not double.
  back.addClaudeLine(claudeLine({ id: 's1', ts: T0 + 200, usage: { input: 5, output: 6 }, tools: [{ name: 'Read', id: 'toolu_a' }] }), CTX)
  assert.deepEqual(byName(back.tools().rows), { Read: 1 })
  back.addClaudeLine(claudeLine({ id: 's1', ts: T0 + 300, usage: { input: 5, output: 8 }, tools: [{ name: 'Read', id: 'toolu_b' }] }), CTX)
  assert.deepEqual(byName(back.tools().rows), { Read: 2 })

  // Version 5 knew no tools: everything else loads, the table starts empty — no cold re-read.
  const v5 = JSON.parse(JSON.stringify(snap)) as Snapshot
  v5.version = 5
  delete v5.tools
  delete v5.toolsTruncated
  const old = Aggregator.fromSnapshot(v5)
  assert.equal(old.all().length, 1, 'the buckets of a version 5 snapshot are kept')
  assert.equal(old.tools().rows.length, 0)
  assert.equal(old.toSnapshot().version, STATE_VERSION)
  // From here on the table fills again.
  old.addClaudeLine(claudeLine({ id: 's2', ts: T0 + 400, usage: { input: 5, output: 2 }, tools: [{ name: 'Bash' }] }), CTX)
  assert.deepEqual(byName(old.tools().rows), { Bash: 1 })

  // A truncation flag is part of the state, not recomputed from the rows.
  const flagged = new Aggregator()
  for (let i = 0; i < TOOL_NAME_CAP + 1; i++) {
    flagged.addClaudeLine(claudeLine({ id: `f_${i}`, ts: T0, usage: { input: 1, output: 1 }, tools: [{ name: `n_${i}` }] }), CTX)
  }
  const round = Aggregator.fromSnapshot(JSON.parse(JSON.stringify(flagged.toSnapshot())))
  assert.equal(round.tools().truncated, true)
  assert.equal(round.tools().rows.length, TOOL_NAME_CAP)
})
