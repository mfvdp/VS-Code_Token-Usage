// SPDX-FileCopyrightText: 2026 Frederik Marx
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * 1.6 O3 — further metadata without content (spec §0a.6–0a.11): an agent's tool errors, counted on
 * the raw line; why its cache missed; the Claude Code version that wrote a transcript; the
 * permission mode a prompt line names, matched on the raw line; the compactions of a transcript;
 * and the sidecar's fifth field, the spawning agent's id. Each is read by one reader through an
 * allow-list, and each has its leak test here: the text beside the field — a tool's output, a
 * prompt, a compaction's summary, a sidecar's paths — never reaches a record, the snapshot, the view
 * model, the page, the markdown or an export. The lines are synthetic, in the shapes counted on the
 * measuring machine (key names only).
 */

import { strict as assert } from 'node:assert'
import { after, test } from 'node:test'
import * as fs from 'fs'
import * as path from 'path'
import * as nodeVm from 'node:vm'
import {
  AGENT_ID_MAX_CHARS, AGENT_TABLES_REVISION, Aggregator, PENDING_MODE_MAX, PERMISSION_MODE_RE, TOOL_ERROR_LITERAL, cacheMissOf,
  compactionOf, permissionModeOf, toolErrorsOf, versionOf,
} from '../src/agg'
import { EARLIER_KEY } from '../src/agentTree'
import { configureRoots } from '../src/discover'
import { agentRows, agentsCsv, toCsv, toJson } from '../src/exporter'
import { agentReplayFiles, replayAgents, scan } from '../src/scan'
import { markdownDocument } from '../src/textViews'
import { TimeConfig } from '../src/time'
import { AgentRec, MainRec, Snapshot } from '../src/types'
import { UiState, ViewModel, agentTreeFor, buildViewModel } from '../src/viewModel'
import {
  CLAUDE_ROOT, CLAUDE_SLUG, ClaudeLineOpts, agentResultLine, agentToolUseLine, apiErrorLine, claudeLine, compactBoundaryLine,
  compactSummaryLine, ctxFor, metaJson, promptLine, tmpDir, toolResultLine,
} from './fixtures/helpers'
import { NOW as VNOW, makeConfig, makeInput } from './fixtures/viewFixtures'

/** Roots are module state; the next test file must not inherit a scratch directory. */
after(() => { configureRoots() })

const T0 = Date.UTC(2026, 8, 20, 10, 0, 0)
const utc: TimeConfig = { zone: 'utc', dayBoundaryHour: 0, startOfWeek: 'monday', hourCycle: 'h23' }

const SESSION = '5e551011-0a1b-4c2d-8e3f-000000000001'
const SLUG_DIR = path.join(CLAUDE_ROOT, CLAUDE_SLUG)
const MAIN = path.join(SLUG_DIR, `${SESSION}.jsonl`)
const AGENT = path.join(SLUG_DIR, SESSION, 'subagents', 'agent-abc123.jsonl')
const MAIN_CTX = ctxFor({ file: MAIN })
const AGENT_CTX = ctxFor({ file: AGENT, isSub: true })

function agentOf(agg: Aggregator, file: string): AgentRec {
  const rec = new Map(agg.agentEntries()).get(file)
  assert.ok(rec, `no agent record for ${file}`)
  return rec
}

function mainOf(agg: Aggregator, file: string): MainRec {
  const rec = new Map(agg.mainEntries()).get(file)
  assert.ok(rec, `no main record for ${file}`)
  return rec
}

/** Everything the counting side owns in a snapshot — what the replay may not change. */
function counting(agg: Aggregator): string {
  const s = agg.toSnapshot()
  return JSON.stringify({ buckets: s.buckets, cursors: s.cursors, pending: s.pending, sessions: s.sessions, tools: s.tools })
}

/** The texts `JSON.parse` was handed while `run` ran — how a test proves a line was never parsed. */
function parsedDuring(run: () => void): string[] {
  const original = JSON.parse
  const seen: string[] = []
  JSON.parse = function (text: string, reviver?: (this: unknown, key: string, value: unknown) => unknown): unknown {
    seen.push(String(text))
    return original.call(JSON, text, reviver)
  } as typeof JSON.parse
  try { run() } finally { JSON.parse = original }
  return seen
}

/** An agent reply that counts, so the transcript has a record the gated lines can go to. */
function reply(id: string, ts: number, over: Partial<ClaudeLineOpts> = {}): string {
  return claudeLine({ id, ts, agentId: 'abc123', usage: { input: 5, output: 2 }, final: true, ...over })
}

// ---------------------------------------------------------------------------
// The raw-line gates (§0a.6, §0a.9)
// ---------------------------------------------------------------------------

test('the raw-line gates open on the unescaped literal only — a tool\'s output, a prompt or a line quoted in a string never opens them (1.6 §0a.6, §0a.9)', () => {
  assert.equal(TOOL_ERROR_LITERAL, '"is_error":true')
  // Two of four results marked, one marked false, one without the key.
  const marked = toolResultLine({ ts: T0, agentId: 'abc123', results: [
    { toolUseId: 'toolu_1', isError: true }, { toolUseId: 'toolu_2', isError: true }, { toolUseId: 'toolu_3', isError: false }, { toolUseId: 'toolu_4' },
  ] })
  assert.equal(toolErrorsOf(marked), 2)
  // A tool's output that quotes the key — a grep over a transcript: inside a string, its quotes are escaped.
  const quoting = toolResultLine({ ts: T0, agentId: 'abc123', results: [{ toolUseId: 'toolu_5', text: 'grep "is_error":true → {"type":"tool_result","is_error":true}' }] })
  assert.ok(quoting.includes('\\"is_error\\":true'), 'the fixture lost its escaped literal')
  assert.equal(toolErrorsOf(quoting), 0)
  // A line quoted twice, a JSON line inside a string inside a string: still escaped.
  const twice = toolResultLine({ ts: T0, agentId: 'abc123', results: [{ toolUseId: 'toolu_6', text: JSON.stringify({ line: JSON.stringify({ is_error: true }) }) }] })
  assert.equal(toolErrorsOf(twice), 0)
  // The literal as Claude Code writes it — no space after the colon.
  assert.equal(toolErrorsOf('{"is_error": true}'), 0)
  assert.equal(toolErrorsOf(''), 0)

  for (const mode of ['default', 'acceptEdits', 'bypassPermissions', 'plan', 'auto']) {
    assert.equal(permissionModeOf(promptLine({ ts: T0, permissionMode: mode })), mode)
  }
  // Another value, no key, a prompt that spells the key out — escaped —, a tool's output quoting it.
  assert.equal(permissionModeOf(promptLine({ ts: T0, permissionMode: 'turbo' })), null)
  assert.equal(permissionModeOf(promptLine({ ts: T0, permissionMode: null })), null)
  const spelled = promptLine({ ts: T0, permissionMode: null, text: 'set "permissionMode":"plan" in the settings' })
  assert.ok(spelled.includes('\\"permissionMode\\":\\"plan\\"'), 'the fixture lost its escaped key')
  assert.equal(permissionModeOf(spelled), null)
  assert.equal(permissionModeOf(toolResultLine({ ts: T0, results: [{ toolUseId: 'toolu_7', text: '{"permissionMode":"auto"}' }] })), null)
  assert.equal(PERMISSION_MODE_RE.test('"permissionMode": "plan"'), false)
})

// ---------------------------------------------------------------------------
// §0a.6 · Tool errors
// ---------------------------------------------------------------------------

test('an agent\'s tool errors are counted on the raw line, never parsed; before its first reply or in a main session nothing is kept (1.6 §0a.6)', () => {
  const agg = new Aggregator()
  // Before the transcript's first counted reply there is no record to count onto.
  assert.equal(agg.addClaudeLine(toolResultLine({ ts: T0 - 10, agentId: 'abc123', results: [{ toolUseId: 'toolu_0', isError: true }] }), AGENT_CTX), false)
  agg.addClaudeLine(reply('m1', T0, { tools: [{ name: 'Bash', id: 'toolu_1' }] }), AGENT_CTX)
  agg.addClaudeLine(reply('m2', T0 + 10, { tools: [{ name: 'Read', id: 'toolu_2' }] }), AGENT_CTX)
  assert.equal(agentOf(agg, AGENT).toolErrors, 0)
  const line = toolResultLine({ ts: T0 + 100, agentId: 'abc123', results: [
    { toolUseId: 'toolu_1', isError: true, text: 'SYNTHETIC-TOOL-ERROR-OUTPUT' }, { toolUseId: 'toolu_2', isError: false, text: 'SYNTHETIC-TOOL-OUTPUT' },
  ] })
  const parsed = parsedDuring(() => assert.equal(agg.addClaudeLine(line, AGENT_CTX), true))
  assert.deepEqual(parsed, [], 'the tool result line was parsed')
  assert.equal(agentOf(agg, AGENT).toolErrors, 1)
  assert.equal(agentOf(agg, AGENT).toolCalls, 2)
  // A tool's output that quotes the literal counts nothing and changes nothing.
  const quoting = toolResultLine({ ts: T0 + 200, agentId: 'abc123', results: [{ toolUseId: 'toolu_3', text: 'grep "is_error":true' }] })
  assert.equal(agg.addClaudeLine(quoting, AGENT_CTX), false)
  assert.equal(agentOf(agg, AGENT).toolErrors, 1)
  assert.equal(JSON.stringify(agg.toSnapshot()).includes('SYNTHETIC-TOOL'), false)

  // Two results marked on one line — two tool calls answered in one message — count two, not one
  // per line (review 4: `+= 1` in place of the count passed every test).
  const pair = new Aggregator()
  pair.addClaudeLine(reply('p1', T0, { tools: [{ name: 'Bash', id: 'toolu_p1' }, { name: 'Read', id: 'toolu_p2' }] }), AGENT_CTX)
  assert.equal(pair.addClaudeLine(toolResultLine({ ts: T0 + 10, agentId: 'abc123', results: [
    { toolUseId: 'toolu_p1', isError: true }, { toolUseId: 'toolu_p2', isError: true },
  ] }), AGENT_CTX), true)
  assert.equal(agentOf(pair, AGENT).toolErrors, 2)

  // A main session's tool errors: its record keeps none. 1.9 P17 (§0a.1, pinned and changed): the line
  // is a user line, whose time raises the record's `lastUserAt` — that, and nothing of the error.
  agg.addClaudeLine(claudeLine({ id: 'x1', ts: T0, usage: { input: 3 }, final: true }), MAIN_CTX)
  assert.equal(agg.addClaudeLine(toolResultLine({ ts: T0 + 5, results: [{ toolUseId: 'toolu_x', isError: true }] }), MAIN_CTX), true)
  assert.equal('toolErrors' in mainOf(agg, MAIN), false)
  assert.equal(mainOf(agg, MAIN).lastUserAt, T0 + 5)

  // The count survives a snapshot round trip; a record from before O3 does not count them — null,
  // and a later error line leaves it so: a count that missed the earlier ones is none.
  const snap = JSON.parse(JSON.stringify(agg.toSnapshot())) as Snapshot
  assert.equal(agentOf(Aggregator.fromSnapshot(snap), AGENT).toolErrors, 1)
  for (const bad of [undefined, -1, 1.5, '3', Number.NaN, null]) {
    const edited = JSON.parse(JSON.stringify(snap)) as Snapshot
    const rec = (edited.agents as unknown as Record<string, Record<string, unknown>>)[AGENT]
    if (bad === undefined) delete rec.toolErrors
    else rec.toolErrors = bad
    const old = Aggregator.fromSnapshot(edited)
    assert.equal(agentOf(old, AGENT).toolErrors, null, String(bad))
    old.addClaudeLine(toolResultLine({ ts: T0 + 300, agentId: 'abc123', results: [{ toolUseId: 'toolu_1', isError: true }] }), AGENT_CTX)
    assert.equal(agentOf(old, AGENT).toolErrors, null, String(bad))
  }
})

// ---------------------------------------------------------------------------
// §0a.9 · Permission mode
// ---------------------------------------------------------------------------

test('the permission mode: a prompt line before the first reply waits for the record, a later one overwrites, the line is never parsed (1.6 §0a.9)', () => {
  const agg = new Aggregator()
  const prompt = promptLine({ ts: T0 - 100, permissionMode: 'plan', text: 'SYNTHETIC-PROMPT-TEXT' })
  const parsed = parsedDuring(() => assert.equal(agg.addClaudeLine(prompt, MAIN_CTX), false))
  assert.deepEqual(parsed, [], 'the prompt line was parsed')
  assert.equal(agg.mains().length, 0, 'a prompt makes no record')
  assert.equal(JSON.stringify(agg.toSnapshot()).includes('plan'), false, 'a waiting mode is not persisted')
  agg.addClaudeLine(claudeLine({ id: 'm1', ts: T0, usage: { input: 3 }, final: true }), MAIN_CTX)
  assert.equal(mainOf(agg, MAIN).permissionMode, 'plan')
  // A later prompt overwrites it; the same mode again changes nothing. 1.9 P17 (§0a.1, pinned and
  // changed): the prompts below come at the moment of the one before — a later one raises the record's
  // `lastUserAt`, which is a change of its own —, so what they say is the mode's rule alone.
  assert.equal(agg.addClaudeLine(promptLine({ ts: T0 + 100, permissionMode: 'bypassPermissions' }), MAIN_CTX), true)
  assert.equal(mainOf(agg, MAIN).permissionMode, 'bypassPermissions')
  assert.equal(mainOf(agg, MAIN).lastUserAt, T0 + 100)
  assert.equal(agg.addClaudeLine(promptLine({ ts: T0 + 100, permissionMode: 'bypassPermissions' }), MAIN_CTX), false)
  // A prompt that spells the key out, or names a mode Claude Code does not write: nothing.
  assert.equal(agg.addClaudeLine(promptLine({ ts: T0 + 100, permissionMode: null, text: '"permissionMode":"plan"' }), MAIN_CTX), false)
  assert.equal(agg.addClaudeLine(promptLine({ ts: T0 + 100, permissionMode: 'turbo' }), MAIN_CTX), false)
  assert.equal(mainOf(agg, MAIN).permissionMode, 'bypassPermissions')
  assert.equal(JSON.stringify(agg.toSnapshot()).includes('SYNTHETIC-PROMPT'), false)

  // An agent's transcript follows the same rule — its record takes the mode its prompt named.
  agg.addClaudeLine(promptLine({ ts: T0, agentId: 'abc123', permissionMode: 'acceptEdits' }), AGENT_CTX)
  agg.addClaudeLine(reply('a1', T0 + 10), AGENT_CTX)
  assert.equal(agentOf(agg, AGENT).permissionMode, 'acceptEdits')
  // Below subagents, a file that is no agent's transcript is not remembered.
  const notes = path.join(SLUG_DIR, SESSION, 'subagents', 'notes.jsonl')
  assert.equal(agg.addClaudeLine(promptLine({ ts: T0, permissionMode: 'auto' }), ctxFor({ file: notes, isSub: true })), false)

  // Not persisted: a restart between the prompt and the first reply leaves the record without one.
  const early = new Aggregator()
  early.addClaudeLine(prompt, MAIN_CTX)
  const back = Aggregator.fromSnapshot(JSON.parse(JSON.stringify(early.toSnapshot())) as Snapshot)
  back.addClaudeLine(claudeLine({ id: 'm1', ts: T0, usage: { input: 3 } }), MAIN_CTX)
  assert.equal(mainOf(back, MAIN).permissionMode, null)
})

test('at most PENDING_MODE_MAX transcripts wait with a mode, the oldest dropped first; a sighting again makes one the newest (1.6 §0a.9)', () => {
  const agg = new Aggregator()
  const file = (i: number): string => path.join(SLUG_DIR, `s-${i}.jsonl`)
  const ctx = (i: number) => ctxFor({ file: file(i) })
  for (let i = 0; i <= PENDING_MODE_MAX; i++) {
    agg.addClaudeLine(promptLine({ ts: T0, permissionMode: 'plan' }), ctx(i))
    // The first file is sighted again after the second: the second is then the oldest.
    if (i === 1) agg.addClaudeLine(promptLine({ ts: T0, permissionMode: 'auto' }), ctx(0))
  }
  for (const i of [0, 1, 2, PENDING_MODE_MAX]) agg.addClaudeLine(claudeLine({ id: `c${i}`, ts: T0 + 1, usage: { input: 1 } }), ctx(i))
  assert.deepEqual([0, 1, 2, PENDING_MODE_MAX].map((i) => mainOf(agg, file(i)).permissionMode), ['auto', null, 'plan', 'plan'])
})

// ---------------------------------------------------------------------------
// §0a.7 · Cache misses
// ---------------------------------------------------------------------------

test('a cache miss is counted once per message by its reason, with the tokens it states — an agent\'s only, nothing else of the diagnostics (1.6 §0a.7)', () => {
  const diag = (type: unknown, tokens?: unknown): Record<string, unknown> => ({
    cache_miss_reason: { type, ...(tokens === undefined ? {} : { cache_missed_input_tokens: tokens }), synthetic_reason: 'SYNTHETIC-REASON' },
    synthetic_detail: 'SYNTHETIC-DIAGNOSTICS',
  })
  const agg = new Aggregator()
  agg.addClaudeLine(reply('m1', T0, { final: false, diagnostics: diag('model_changed', 48_000) }), AGENT_CTX)
  // The message's later lines repeat it: counted once, on its first line.
  agg.addClaudeLine(reply('m1', T0 + 100, { diagnostics: diag('model_changed', 48_000) }), AGENT_CTX)
  agg.addClaudeLine(reply('m2', T0 + 1000, { diagnostics: diag('unavailable') }), AGENT_CTX)
  agg.addClaudeLine(reply('m3', T0 + 2000, { diagnostics: diag('model_changed', 210) }), AGENT_CTX)
  // A reason outside the six, a reason that is no object, diagnostics that are no object: nothing.
  agg.addClaudeLine(reply('m4', T0 + 3000, { diagnostics: diag('weather_changed', 99) }), AGENT_CTX)
  agg.addClaudeLine(reply('m5', T0 + 4000, { diagnostics: { cache_miss_reason: 'model_changed' } }), AGENT_CTX)
  agg.addClaudeLine(reply('m6', T0 + 5000, { diagnostics: [diag('model_changed', 5)] }), AGENT_CTX)
  agg.addClaudeLine(reply('m7', T0 + 6000, { diagnostics: null }), AGENT_CTX)
  // A figure that is no count: the reason counts, the figure does not.
  agg.addClaudeLine(reply('m8', T0 + 7000, { diagnostics: diag('tools_changed', -5) }), AGENT_CTX)
  agg.addClaudeLine(reply('m9', T0 + 8000, { diagnostics: diag('system_changed', '77') }), AGENT_CTX)
  const rec = agentOf(agg, AGENT)
  assert.deepEqual(rec.cacheMisses, { model_changed: 2, unavailable: 1, tools_changed: 1, system_changed: 1 })
  assert.equal(rec.cacheMissedTokens, 48_210)
  // Never part of a usage total: the reply's usage is what its usage says.
  assert.equal(rec.input, 9 * 5)
  // A main session's misses are not kept.
  agg.addClaudeLine(claudeLine({ id: 'x1', ts: T0, usage: { input: 3 }, diagnostics: diag('system_changed', 5) }), MAIN_CTX)
  assert.equal('cacheMisses' in mainOf(agg, MAIN), false)
  assert.equal(/SYNTHETIC-(REASON|DIAGNOSTICS)|synthetic_(reason|detail)/.test(JSON.stringify(agg.toSnapshot())), false)
  // The reader: of the message only its diagnostics' reason.
  assert.deepEqual(cacheMissOf({ diagnostics: diag('messages_changed', 12) }), { kind: 'messages_changed', tokens: 12 })
  assert.equal(cacheMissOf({ diagnostics: diag('Model_Changed', 12) }), null)
  assert.equal(cacheMissOf({}), null)

  // A round trip keeps them; a hand-edited snapshot only the six reasons with whole counts.
  const snap = JSON.parse(JSON.stringify(agg.toSnapshot())) as Snapshot
  assert.deepEqual(agentOf(Aggregator.fromSnapshot(snap), AGENT).cacheMisses, rec.cacheMisses)
  const r = (snap.agents as unknown as Record<string, Record<string, unknown>>)[AGENT]
  r.cacheMisses = { model_changed: 2.5, unavailable: -1, weather_changed: 3, tools_changed: 4, system_changed: '1' }
  r.cacheMissedTokens = -9
  const edited = agentOf(Aggregator.fromSnapshot(snap), AGENT)
  assert.deepEqual([edited.cacheMisses, edited.cacheMissedTokens], [{ tools_changed: 4 }, 0])
})

// ---------------------------------------------------------------------------
// §0a.8 · Claude Code version
// ---------------------------------------------------------------------------

test('the Claude Code version is the newest line\'s, through its pattern; an older line or another value keeps it (1.6 §0a.8)', () => {
  const agg = new Aggregator()
  agg.addClaudeLine(reply('m1', T0, { version: '2.1.280' }), AGENT_CTX)
  assert.equal(agentOf(agg, AGENT).ccVersion, '2.1.280')
  agg.addClaudeLine(reply('m2', T0 + 1000, { version: '2.1.281' }), AGENT_CTX)
  assert.equal(agentOf(agg, AGENT).ccVersion, '2.1.281')
  // A late line of an older reply, a later line without a version or with another value: kept.
  agg.addClaudeLine(reply('m1', T0 + 500, { version: '2.0.0' }), AGENT_CTX)
  agg.addClaudeLine(reply('m3', T0 + 2000, { version: null }), AGENT_CTX)
  agg.addClaudeLine(reply('m4', T0 + 3000, { version: 'synthetic' }), AGENT_CTX)
  assert.equal(agentOf(agg, AGENT).ccVersion, '2.1.281')
  // An error line is the transcript's newest and Claude Code wrote it too (the fixture's 9.9.9).
  agg.addClaudeLine(apiErrorLine({ id: 'e1', ts: T0 + 4000, agentId: 'abc123' }), AGENT_CTX)
  assert.equal(agentOf(agg, AGENT).ccVersion, '9.9.9')
  // A main session keeps its own.
  agg.addClaudeLine(claudeLine({ id: 'x1', ts: T0, usage: { input: 3 }, version: '2.1.279' }), MAIN_CTX)
  assert.equal(mainOf(agg, MAIN).ccVersion, '2.1.279')
  // A transcript whose lines name no version this pattern takes has none.
  const other = new Aggregator()
  other.addClaudeLine(reply('s1', T0, { version: 'synthetic' }), AGENT_CTX)
  assert.equal(agentOf(other, AGENT).ccVersion, null)
  for (const [v, want] of [['1.2.3', '1.2.3'], ['123.456.7890', '123.456.7890'], ['1234.1.1', null], ['1.2', null], ['v1.2.3', null],
    ['1.2.3-beta', null], ['1.2.3\n', null], [7, null], [null, null]] as const) {
    assert.equal(versionOf({ version: v }), want, String(v))
  }
  // A round trip keeps it; a hand-edited one only through the pattern.
  const snap = JSON.parse(JSON.stringify(agg.toSnapshot())) as Snapshot
  assert.equal(agentOf(Aggregator.fromSnapshot(snap), AGENT).ccVersion, '9.9.9')
  ;(snap.mains as unknown as Record<string, Record<string, unknown>>)[MAIN].ccVersion = '<b>1.2.3</b>'
  assert.equal(mainOf(Aggregator.fromSnapshot(snap), MAIN).ccVersion, null)
})

// ---------------------------------------------------------------------------
// §0a.10 · Compactions
// ---------------------------------------------------------------------------

test('a compaction is counted and the last one kept with its trigger and figures; its summary line is never parsed (1.6 §0a.10)', () => {
  const agg = new Aggregator()
  // Before the transcript's first counted reply: nothing to count onto (never observed).
  assert.equal(agg.addClaudeLine(compactBoundaryLine({ ts: T0 - 10 }), MAIN_CTX), false)
  agg.addClaudeLine(claudeLine({ id: 'm1', ts: T0, usage: { input: 3 }, final: true }), MAIN_CTX)
  assert.equal(agg.addClaudeLine(compactBoundaryLine({ ts: T0 + 1000, trigger: 'manual', preTokens: 167_200, postTokens: 12_400,
    preserved: 'SYNTHETIC-PRESERVED' }), MAIN_CTX), true)
  assert.deepEqual([mainOf(agg, MAIN).compactions, mainOf(agg, MAIN).lastCompaction],
    [1, { at: T0 + 1000, trigger: 'manual', preTokens: 167_200, postTokens: 12_400 }])
  // Its summary line: never parsed, whatever it mentions. 1.9 P17 (§0a.1, pinned and changed): it is a
  // user line, and its time — matched on the raw line — raises the record's `lastUserAt`; nothing else.
  const summary = compactSummaryLine({ ts: T0 + 1001,
    summary: 'SYNTHETIC-SUMMARY: the <task-notification> and "usage" and "subtype":"compact_boundary" of it' })
  const parsed = parsedDuring(() => assert.equal(agg.addClaudeLine(summary, MAIN_CTX), true))
  assert.deepEqual(parsed, [], 'the summary line was parsed')
  assert.deepEqual([mainOf(agg, MAIN).lastUserAt, mainOf(agg, MAIN).compactions], [T0 + 1001, 1])
  // An automatic one with figures that are no counts, and one without a metadata block.
  agg.addClaudeLine(compactBoundaryLine({ ts: T0 + 5000, trigger: 'auto', preTokens: -1, postTokens: '12' }), MAIN_CTX)
  assert.deepEqual([mainOf(agg, MAIN).compactions, mainOf(agg, MAIN).lastCompaction],
    [2, { at: T0 + 5000, trigger: 'auto', preTokens: null, postTokens: null }])
  agg.addClaudeLine(compactBoundaryLine({ ts: T0 + 6000, trigger: 'sometimes' }), MAIN_CTX)
  agg.addClaudeLine(compactBoundaryLine({ ts: T0 + 7000, metadata: null }), MAIN_CTX)
  assert.deepEqual([mainOf(agg, MAIN).compactions, mainOf(agg, MAIN).lastCompaction],
    [4, { at: T0 + 7000, trigger: null, preTokens: null, postTokens: null }])
  // One read late — an older line — is counted, but does not replace the last.
  agg.addClaudeLine(compactBoundaryLine({ ts: T0 + 2000, trigger: 'manual' }), MAIN_CTX)
  assert.deepEqual([mainOf(agg, MAIN).compactions, mainOf(agg, MAIN).lastCompaction?.at], [5, T0 + 7000])
  // A reply whose tool input names the subtype as an object's value opens the gate, and is read as a
  // reply — nothing of it is a compaction.
  const requests = mainOf(agg, MAIN).requests
  agg.addClaudeLine(claudeLine({ id: 'g1', ts: T0 + 8000, usage: { input: 3 }, content: [{
    type: 'tool_use', id: 'toolu_g', name: 'Grep', input: { type: 'system', subtype: 'compact_boundary', pattern: 'SYNTHETIC-GREP' },
  }] }), MAIN_CTX)
  assert.deepEqual([mainOf(agg, MAIN).compactions, mainOf(agg, MAIN).requests], [5, requests + 1])
  // An agent's transcript is compacted too.
  agg.addClaudeLine(reply('a1', T0), AGENT_CTX)
  agg.addClaudeLine(compactBoundaryLine({ ts: T0 + 100, agentId: 'abc123', trigger: 'auto', preTokens: 90_000, postTokens: 8000 }), AGENT_CTX)
  assert.deepEqual([agentOf(agg, AGENT).compactions, agentOf(agg, AGENT).lastCompaction?.trigger], [1, 'auto'])
  assert.equal(/SYNTHETIC-(PRESERVED|SUMMARY|GREP)|preserved|cumulativeDropped|durationMs/.test(JSON.stringify(agg.toSnapshot())), false)
  // The reader: of the line its type, subtype and the metadata's three.
  assert.equal(compactionOf({ type: 'user', subtype: 'compact_boundary', compactMetadata: { trigger: 'manual' } }, T0), null)
  assert.equal(compactionOf({ type: 'system', subtype: 'api_error' }, T0), null)
  // A round trip keeps them; a hand-edited one only what this build writes.
  const snap = JSON.parse(JSON.stringify(agg.toSnapshot())) as Snapshot
  assert.deepEqual(mainOf(Aggregator.fromSnapshot(snap), MAIN).lastCompaction, mainOf(agg, MAIN).lastCompaction)
  const m = (snap.mains as unknown as Record<string, Record<string, unknown>>)[MAIN]
  m.compactions = -3
  m.lastCompaction = { at: 'yesterday', trigger: 'manual', preTokens: 1, postTokens: 1 }
  assert.deepEqual([mainOf(Aggregator.fromSnapshot(snap), MAIN).compactions, mainOf(Aggregator.fromSnapshot(snap), MAIN).lastCompaction], [0, null])
  m.lastCompaction = { at: T0, trigger: 'forced', preTokens: Number.NaN, postTokens: 5, preservedSegment: 'SYNTHETIC' }
  assert.deepEqual(mainOf(Aggregator.fromSnapshot(snap), MAIN).lastCompaction, { at: T0, trigger: null, preTokens: null, postTokens: 5 })
})

// ---------------------------------------------------------------------------
// The gated lines change something now (pinned by P4 as "changes nothing")
// ---------------------------------------------------------------------------

test('a gated user line and a compaction line change the agent tables, and say so (1.6 O3)', () => {
  const agg = new Aggregator()
  agg.addClaudeLine(claudeLine({ id: 'm1', ts: T0, usage: { input: 3 }, final: true }), MAIN_CTX)
  agg.addClaudeLine(reply('a1', T0, { tools: [{ name: 'Bash', id: 'toolu_1' }] }), AGENT_CTX)
  agg.takeChanges()
  const before = JSON.stringify(agg.toSnapshot())
  assert.equal(agg.addClaudeLine(toolResultLine({ ts: T0 + 1, agentId: 'abc123', results: [{ toolUseId: 'toolu_1', isError: true }] }), AGENT_CTX), true)
  assert.deepEqual(agg.takeChanges(), { buckets: false, agents: true })
  assert.equal(agg.addClaudeLine(promptLine({ ts: T0 + 2, permissionMode: 'plan' }), MAIN_CTX), true)
  assert.deepEqual(agg.takeChanges(), { buckets: false, agents: true })
  assert.equal(agg.addClaudeLine(compactBoundaryLine({ ts: T0 + 3 }), MAIN_CTX), true)
  assert.deepEqual(agg.takeChanges(), { buckets: false, agents: true })
  assert.notEqual(JSON.stringify(agg.toSnapshot()), before)
})

// ---------------------------------------------------------------------------
// §0a.11 · parentAgentId, and the replay the revision asks for
// ---------------------------------------------------------------------------

function writeLines(file: string, lines: string[]): void {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, lines.map((l) => `${l}\n`).join(''))
}

function writeSidecar(file: string, text: string): void {
  fs.writeFileSync(file.replace(/\.jsonl$/, '.meta.json'), text)
}

interface O3World { home: string; main: string; agent: string; nested: string }

/**
 * One session on disk with every O3 field, each beside synthetic content that carries `secret`: the
 * session's prompts (two modes, one prompt that spells a third out), its replies (two versions), a
 * compaction with what it preserved and its summary line; a background agent whose replies carry a
 * cache miss each (with extra keys under the diagnostics), a tool error with its output, a tool
 * output quoting the literal, a compaction and a version that is none; a nested agent its sidecar
 * links by its parent, next to its workflow phase and its worktree's path — and whose lines name no
 * version the pattern takes.
 */
function o3World(secret: string): O3World {
  const home = tmpDir('o3')
  const dir = path.join(home, 'projects', CLAUDE_SLUG)
  const main = path.join(dir, `${SESSION}.jsonl`)
  const agent = path.join(dir, SESSION, 'subagents', 'agent-abc123.jsonl')
  const nested = path.join(dir, SESSION, 'subagents', 'agent-0ff1ce.jsonl')
  const at = (min: number): number => VNOW - min * 60_000
  writeLines(main, [
    promptLine({ ts: at(50), permissionMode: 'plan', text: `${secret}-prompt: set "permissionMode":"auto"` }),
    claudeLine({ id: 'm1', ts: at(49), sessionId: SESSION, usage: { input: 10, output: 5 }, final: true, version: '2.1.280' }),
    agentToolUseLine({ id: 'm2', ts: at(48), toolUseId: 'toolu_bg', background: true, description: `${secret}-launch-description`,
      prompt: `${secret}-launch-prompt` }),
    agentResultLine({ ts: at(47), toolUseId: 'toolu_bg', agentId: 'abc123', status: 'async_launched', prompt: `${secret}-result-prompt` }),
    compactBoundaryLine({ ts: at(40), trigger: 'manual', preTokens: 167_200, postTokens: 12_400, preserved: `${secret}-preserved` }),
    compactSummaryLine({ ts: at(40) + 1, summary: `${secret}-summary <task-notification> "is_error":true "permissionMode":"auto"` }),
    promptLine({ ts: at(30), permissionMode: 'bypassPermissions', text: `${secret}-second-prompt` }),
    claudeLine({ id: 'm3', ts: at(29), sessionId: SESSION, usage: { input: 20, output: 5 }, final: true, version: '2.1.281' }),
  ])
  writeLines(agent, [
    promptLine({ ts: at(47), agentId: 'abc123', permissionMode: null, text: `${secret}-agent-prompt` }),
    claudeLine({ id: 'a1', ts: at(46), agentId: 'abc123', usage: { input: 5, output: 2 }, final: true, tools: [{ name: 'Bash', id: 'toolu_a1' }],
      version: '2.1.281', diagnostics: {
        cache_miss_reason: { type: 'model_changed', cache_missed_input_tokens: 48_210, synthetic_reason: `${secret}-reason` },
        synthetic_detail: `${secret}-diagnostics`,
      } }),
    toolResultLine({ ts: at(45), agentId: 'abc123', results: [{ toolUseId: 'toolu_a1', isError: true, text: `${secret}-tool-error-output` }] }),
    claudeLine({ id: 'a2', ts: at(44), agentId: 'abc123', usage: { input: 5, output: 2 }, final: true, tools: [{ name: 'Read', id: 'toolu_a2' }],
      version: `synthetic-${secret}`, diagnostics: { cache_miss_reason: { type: 'unavailable' } } }),
    toolResultLine({ ts: at(43), agentId: 'abc123', results: [{ toolUseId: 'toolu_a2', text: `${secret}-quoting {"is_error":true}` }] }),
    compactBoundaryLine({ ts: at(41), agentId: 'abc123', trigger: 'auto', preTokens: 90_000, postTokens: 8000, preserved: `${secret}-agent-preserved` }),
    claudeLine({ id: 'a3', ts: at(20), agentId: 'abc123', usage: { input: 5, output: 2 }, final: true, version: '2.1.281' }),
  ])
  writeSidecar(agent, metaJson({ agentType: 'general-purpose', model: 'opus', toolUseId: 'toolu_bg', description: `${secret}-meta-description` }))
  writeLines(nested, [claudeLine({ id: 'n1', ts: at(21), agentId: '0ff1ce', usage: { input: 7, output: 2 }, final: true, version: 'synthetic' })])
  writeSidecar(nested, metaJson({
    agentType: 'Plan', model: null, spawnDepth: 2, toolUseId: null, parentAgentId: 'abc123', description: `${secret}-nested-description`,
    extra: { workflowPhase: `${secret}-phase`, worktreePath: `/home/tester/${secret}-worktree`, worktreeBranch: `${secret}-branch`,
      requestShape: `${secret}-shape`, stoppedByUser: false },
  }))
  // An empty Codex home of its own, so a scan never wanders into the machine's real one.
  configureRoots([home], [path.join(home, 'codex')])
  return { home, main, agent, nested }
}

/** The world scanned, its snapshot restored and replayed as a restart with a new revision would. */
async function o3Scanned(secret: string): Promise<{ w: O3World; live: Aggregator; agg: Aggregator }> {
  const w = o3World(secret)
  const live = new Aggregator()
  await scan(live)
  const snap = JSON.parse(JSON.stringify(live.toSnapshot())) as Snapshot
  snap.agentsRevision = AGENT_TABLES_REVISION - 1
  const agg = Aggregator.fromSnapshot(snap)
  await replayAgents(agg, agentReplayFiles(agg, VNOW))
  return { w, live, agg }
}

// The page: the dashboard's own script, as the webview runs it, rendering the Agents section.

function loadDashboard(): typeof import('../src/dashboard') {
  const mod = require('node:module')
  if (!mod._load.stubbed) {
    const original = mod._load
    const load = function (this: unknown, request: string, parent: unknown, isMain: boolean): unknown {
      if (request === 'vscode') return { commands: { executeCommand: () => undefined } }
      return original.call(this, request, parent, isMain)
    }
    load.stubbed = true
    mod._load = load
  }
  return require('../src/dashboard')
}

let pageScript: string | null = null

function pageOf(vm: ViewModel): string {
  if (pageScript === null) {
    const { DashboardProvider } = loadDashboard()
    const html = { value: '' }
    new DashboardProvider(() => undefined).resolveWebviewView({
      visible: true,
      webview: {
        options: {},
        set html(v: string) { html.value = v },
        get html(): string { return html.value },
        onDidReceiveMessage: () => ({ dispose: () => undefined }),
        postMessage: () => Promise.resolve(true),
        cspSource: '',
      },
      onDidChangeVisibility: () => ({ dispose: () => undefined }),
      onDidDispose: () => ({ dispose: () => undefined }),
      show: () => undefined,
    } as never)
    const open = /<script nonce="[A-Za-z0-9]+">/.exec(html.value)
    assert.ok(open, 'the page has no script')
    pageScript = html.value.slice(open.index + open[0].length, html.value.indexOf('</script>', open.index))
  }
  const c = nodeVm.createContext({
    acquireVsCodeApi: () => ({ postMessage: () => undefined }),
    document: { addEventListener: () => undefined, getElementById: () => null, querySelector: () => null, querySelectorAll: () => [] },
    window: { addEventListener: () => undefined },
    console,
  })
  nodeVm.runInContext(pageScript, c)
  ;(c as Record<string, unknown>).fixture = JSON.parse(JSON.stringify(vm))
  return String(nodeVm.runInContext('vm = fixture; sAgents()', c))
}

/** Everything that leaves the aggregator: the snapshot, the view models, the page, the markdown, the exports. */
function outputsOf(agg: Aggregator, live: Aggregator): Array<[string, string]> {
  const cfg = makeConfig()
  // 1.7 F2: the session is quiet by now — an earlier one, in the group, which the reader opens too.
  const ui: Partial<UiState> = { agentsExpanded: [EARLIER_KEY, `s:${SESSION}`, 'a:abc123'], agentSelected: 'a:abc123' }
  const input = makeInput({ agg, cfg, ui })
  const vms = ['a:abc123', 'a:0ff1ce', `s:${SESSION}`].map((key) => buildViewModel({ ...input, ui: { ...input.ui, agentSelected: key } }))
  const range = { from: '2026-09-01', to: '2026-09-03' }
  return [
    ['live snapshot', JSON.stringify(live.toSnapshot())], ['snapshot', JSON.stringify(agg.toSnapshot())],
    ...vms.map((vm, i): [string, string] => [`view model ${i}`, JSON.stringify(vm)]),
    ...vms.map((vm, i): [string, string] => [`page ${i}`, pageOf(vm)]),
    ['markdown', markdownDocument(vms[0], agentTreeFor(input, 'text'))],
    ['json export', toJson(agg, range, cfg, utc, VNOW)], ['csv export', toCsv(agg, range, cfg, utc)],
    ['agents export', agentsCsv(agg, range, cfg, utc, VNOW)],
  ]
}

/** The details rows the view model gives the node, by label. */
function detailsOf(agg: Aggregator, key: string): Map<string, string> {
  const input = makeInput({ agg, cfg: makeConfig(), ui: { agentsExpanded: [EARLIER_KEY, `s:${SESSION}`, 'a:abc123'], agentSelected: key } })
  return new Map((buildViewModel(input).agents.selected?.rows ?? []).map((r) => [r.label, r.note ? `${r.value} | ${r.note}` : r.value]))
}

function assertNowhere(outputs: Array<[string, string]>, secrets: RegExp, what: string): void {
  for (const [where, out] of outputs) assert.equal(secrets.test(out), false, `${where} holds ${what}`)
}

test('§0a.6 leak test: an agent\'s tool errors reach its record, its details and the export as a count — the tool\'s output nowhere', async () => {
  const secret = 'O3-TOOL-6a1f'
  const { w, live, agg } = await o3Scanned(secret)
  assert.ok(fs.readFileSync(w.agent, 'utf8').includes(`${secret}-tool-error-output`), 'the fixture lost its output')
  // One marked result; the output that quotes the literal counts nothing.
  assert.deepEqual([agentOf(live, w.agent).toolErrors, agentOf(agg, w.agent).toolErrors, agentOf(agg, w.agent).toolCalls], [1, 1, 2])
  assert.equal(detailsOf(agg, 'a:abc123').get('Tool errors'), '1 of 2 tool calls')
  assert.equal(agentRows(agg, { from: '2026-09-01', to: '2026-09-03' }, makeConfig(), utc, VNOW).find((r) => r.agentId === 'abc123')?.toolErrors, 1)
  const outputs = outputsOf(agg, live)
  assert.ok(outputs.find(([k]) => k === 'page 0')?.[1].includes('1 of 2 tool calls'), 'the page does not show the tool errors')
  assertNowhere(outputs, new RegExp(`${secret}-(tool-error-output|quoting)|is_error`), 'a tool\'s output or its key')
})

test('§0a.7 leak test: an agent\'s cache misses reach its record and its details as reasons and a figure — nothing else of the diagnostics', async () => {
  const secret = 'O3-MISS-7b2e'
  const { w, live, agg } = await o3Scanned(secret)
  assert.deepEqual([agentOf(agg, w.agent).cacheMisses, agentOf(agg, w.agent).cacheMissedTokens], [{ model_changed: 1, unavailable: 1 }, 48_210])
  assert.deepEqual([agentOf(live, w.agent).cacheMisses, agentOf(live, w.agent).cacheMissedTokens], [{ model_changed: 1, unavailable: 1 }, 48_210])
  // As frequent as each other: in the order Claude Code's reasons are listed.
  assert.equal(detailsOf(agg, 'a:abc123').get('Cache misses'), 'cache unavailable 1 · model changed 1 | 48.2K tokens not read from the cache')
  // A main session keeps none: its details have no such row.
  assert.equal(detailsOf(agg, `s:${SESSION}`).has('Cache misses'), false)
  const outputs = outputsOf(agg, live)
  assert.ok(outputs.find(([k]) => k === 'page 0')?.[1].includes('cache unavailable 1 · model changed 1'), 'the page does not show the misses')
  assertNowhere(outputs, new RegExp(`${secret}-(reason|diagnostics)|synthetic_(reason|detail)|cache_miss_reason`), 'the diagnostics beside the reason')
})

test('§0a.8 leak test: the version that wrote a transcript reaches its record and its details — another value is none', async () => {
  const secret = 'O3-VERSION-8c3d'
  const { w, live, agg } = await o3Scanned(secret)
  // The agent's newest line with a version the pattern takes; the nested agent's lines name none.
  assert.deepEqual([agentOf(agg, w.agent).ccVersion, agentOf(agg, w.nested).ccVersion, mainOf(agg, w.main).ccVersion], ['2.1.281', null, '2.1.281'])
  assert.equal(agentOf(live, w.agent).ccVersion, '2.1.281')
  assert.deepEqual([detailsOf(agg, 'a:abc123').get('Claude Code version'), detailsOf(agg, 'a:0ff1ce').get('Claude Code version'),
    detailsOf(agg, `s:${SESSION}`).get('Claude Code version')], ['2.1.281', '–', '2.1.281'])
  assertNowhere(outputsOf(agg, live), new RegExp(`synthetic-${secret}|"synthetic"`), 'a version that is none')
})

test('§0a.9 leak test: the permission mode a prompt named reaches the session\'s record and its details — the prompt nowhere', async () => {
  const secret = 'O3-MODE-9d4c'
  const { w, live, agg } = await o3Scanned(secret)
  // The replay reads the prompt again before the first reply, the later prompt after it: the later mode.
  assert.deepEqual([mainOf(live, w.main).permissionMode, mainOf(agg, w.main).permissionMode], ['bypassPermissions', 'bypassPermissions'])
  // The agent's prompt names none; the one the session's prompt spelled out is not a mode.
  assert.equal(agentOf(agg, w.agent).permissionMode, null)
  assert.equal(detailsOf(agg, `s:${SESSION}`).get('Permission mode'), 'bypassPermissions')
  assert.equal(detailsOf(agg, 'a:abc123').has('Permission mode'), false)
  const outputs = outputsOf(agg, live)
  assert.ok(outputs.find(([k]) => k === 'page 2')?.[1].includes('bypassPermissions'), 'the page does not show the mode')
  // The prompt's own words nowhere, and the mode it only spelled out on no record.
  assertNowhere(outputs, new RegExp(`${secret}-(prompt|second-prompt|agent-prompt)|"permissionMode":"auto"`), 'a prompt or a mode it spelled out')
  assert.deepEqual([...detailsOf(agg, `s:${SESSION}`).values()].filter((v) => v === 'auto' || v === 'plan'), [])
})

test('§0a.10 leak test: a compaction reaches the record and the details as a count, a trigger and two figures — what it preserved and its summary nowhere', async () => {
  const secret = 'O3-COMPACT-0e5b'
  const { w, live, agg } = await o3Scanned(secret)
  assert.deepEqual([mainOf(agg, w.main).compactions, mainOf(agg, w.main).lastCompaction?.trigger, agentOf(agg, w.agent).compactions],
    [1, 'manual', 1])
  assert.deepEqual(mainOf(live, w.main).lastCompaction, mainOf(agg, w.main).lastCompaction)
  assert.equal(detailsOf(agg, `s:${SESSION}`).get('Compactions'), '1 · last at 11:20 (manual, 167.2K → 12.4K)')
  assert.equal(detailsOf(agg, 'a:abc123').get('Compactions'), '1 · last at 11:19 (auto, 90K → 8K)')
  const outputs = outputsOf(agg, live)
  // 1.6 P13b (pinned and changed): a sentence row keeps each figure with its unit in a span of its
  // own, so the page's words are read without its tags.
  assert.ok(outputs.find(([k]) => k === 'page 2')?.[1].replace(/<[^>]+>/g, '').includes('1 · last at 11:20 (manual, 167.2K → 12.4K)'),
    'the page does not show the compaction')
  assertNowhere(outputs, new RegExp(`${secret}-(preserved|agent-preserved|summary)|preservedSegment|preservedMessages|preCompactDiscoveredTools|isCompactSummary|mcp__synthetic`),
    'what a compaction preserved or its summary')
})

test('§0a.11 leak test: the sidecar\'s parent links the nested agent to its spawner — its workflow phase and its worktree nowhere', async () => {
  const secret = 'O3-PARENT-1f6a'
  const { w, live, agg } = await o3Scanned(secret)
  assert.equal(agentOf(agg, w.nested).meta?.parentAgentId, 'abc123')
  assert.equal(agentOf(agg, w.nested).spawnerFile, null, 'no launch names its spawner: the sidecar does')
  // In the tree it hangs under the agent that spawned it, and its details name that agent.
  const input = makeInput({ agg, cfg: makeConfig(), ui: { agentsExpanded: [EARLIER_KEY, `s:${SESSION}`, 'a:abc123'], agentSelected: 'a:0ff1ce' } })
  const vm = buildViewModel(input)
  // 1.7 F2: the session, quiet by now, is the first the group of earlier sessions holds.
  const bg = vm.agents.roots[0].children[0].children.find((c) => c.key === 'a:abc123')
  assert.deepEqual(bg?.children.map((c) => c.key), ['a:0ff1ce'])
  assert.equal(vm.agents.selected?.rows.find((r) => r.label === 'Spawned by')?.value, bg?.fullLabel)
  assert.equal(agentRows(agg, { from: '2026-09-01', to: '2026-09-03' }, makeConfig(), utc, VNOW).find((r) => r.agentId === '0ff1ce')?.spawnedBy, 'abc123')
  assertNowhere(outputsOf(agg, live), new RegExp(`${secret}-(phase|worktree|branch|shape|nested-description|meta-description)|workflowPhase|worktreePath|requestShape`),
    'a sidecar\'s other fields')
})

test('the replay the revision asks for fills the O3 fields from the lines and reads a sidecar again for its parent — counting nothing twice', async () => {
  const w = o3World('O3-REPLAY-2a7c')
  const live = new Aggregator()
  await scan(live)
  const full = JSON.parse(JSON.stringify(live.toSnapshot())) as Snapshot
  // What a build before P13a left: no O3 field, a sidecar read for four fields, revision 6.
  const old = JSON.parse(JSON.stringify(full)) as Snapshot
  for (const r of Object.values(old.agents as unknown as Record<string, Record<string, unknown>>)) {
    for (const k of ['toolErrors', 'cacheMisses', 'cacheMissedTokens', 'ccVersion', 'permissionMode', 'compactions', 'lastCompaction']) delete r[k]
    delete (r.meta as Record<string, unknown>).parentAgentId
  }
  for (const m of Object.values(old.mains as unknown as Record<string, Record<string, unknown>>)) {
    for (const k of ['ccVersion', 'permissionMode', 'compactions', 'lastCompaction']) delete m[k]
  }
  old.agentsRevision = 6
  const restored = Aggregator.fromSnapshot(old)
  assert.notEqual(restored.agentsRevision, AGENT_TABLES_REVISION, 'the host replays')
  assert.deepEqual([agentOf(restored, w.agent).toolErrors, agentOf(restored, w.agent).cacheMisses, agentOf(restored, w.nested).meta?.parentAgentId,
    mainOf(restored, w.main).permissionMode, mainOf(restored, w.main).compactions], [null, {}, null, null, 0])
  const counted = counting(restored)
  await replayAgents(restored, agentReplayFiles(restored, VNOW))
  assert.equal(counting(restored), counted)
  // Every record as a scan of this build made it.
  assert.deepEqual(JSON.parse(JSON.stringify(restored.toSnapshot().agents)), full.agents)
  assert.deepEqual(JSON.parse(JSON.stringify(restored.toSnapshot().mains)), full.mains)
  // A second replay rebuilds the same tables.
  await replayAgents(restored, agentReplayFiles(restored, VNOW))
  assert.deepEqual(JSON.parse(JSON.stringify(restored.toSnapshot().agents)), full.agents)

  // A transcript gone before the replay keeps what it had: its tool errors uncounted (null), and the
  // sidecar it can no longer read leaves its identity as it was.
  const gone = Aggregator.fromSnapshot(old)
  fs.rmSync(w.nested)
  fs.rmSync(w.nested.replace(/\.jsonl$/, '.meta.json'))
  await replayAgents(gone, agentReplayFiles(gone, VNOW))
  assert.deepEqual([agentOf(gone, w.nested).toolErrors, agentOf(gone, w.nested).meta?.agentType, agentOf(gone, w.nested).meta?.parentAgentId],
    [null, 'Plan', null])
  assert.equal(agentOf(gone, w.agent).toolErrors, 1)
})

test('parseAgentMeta\'s fifth field holds to the id alphabet on every path in: the sidecar, a caller, a snapshot (1.6 §0a.11)', () => {
  const agg = new Aggregator()
  agg.addClaudeLine(reply('a1', T0), AGENT_CTX)
  agg.setAgentMeta(AGENT, { agentType: 'Plan', model: null, spawnDepth: 2, toolUseId: null, parentAgentId: '../../etc' })
  assert.equal(agentOf(agg, AGENT).meta?.parentAgentId, null)
  const again = new Aggregator()
  again.addClaudeLine(reply('a1', T0), AGENT_CTX)
  again.setAgentMeta(AGENT, { agentType: null, model: null, spawnDepth: null, toolUseId: null, parentAgentId: 'a0ff1ce00000000001' })
  assert.equal(agentOf(again, AGENT).meta?.parentAgentId, 'a0ff1ce00000000001')
  const snap = JSON.parse(JSON.stringify(again.toSnapshot())) as Snapshot
  ;((snap.agents as unknown as Record<string, Record<string, unknown>>)[AGENT].meta as Record<string, unknown>).parentAgentId = 'x'.repeat(AGENT_ID_MAX_CHARS + 1)
  assert.equal(agentOf(Aggregator.fromSnapshot(snap), AGENT).meta, null, 'nothing usable left: no identity')
})

// ---------------------------------------------------------------------------
// The raw-gate count report (counts only)
// ---------------------------------------------------------------------------

test('the raw-gate count report: on the fixtures, the gates open exactly where a parse finds the field — counts only (1.6 O3)', (t) => {
  // Every shape the fixtures write, marked or quoting the marks, in agent and main transcripts.
  const lines: string[] = []
  for (let i = 0; i < 12; i++) {
    lines.push(toolResultLine({ ts: T0 + i, agentId: 'abc123', results: [
      { toolUseId: `toolu_${i}a`, isError: i % 3 === 0 }, { toolUseId: `toolu_${i}b`, isError: i % 4 === 0, text: 'grep "is_error":true' },
    ] }))
    lines.push(toolResultLine({ ts: T0 + i, results: [{ toolUseId: `toolu_${i}c`, isError: i % 2 === 0, text: '{"is_error":true}' }] }))
    lines.push(promptLine({ ts: T0 + i, permissionMode: ['default', 'plan', 'auto', null, 'turbo', 'bypassPermissions'][i % 6],
      text: i % 5 === 0 ? 'the "permissionMode":"plan" key' : 'synthetic prompt' }))
    lines.push(reply(`r${i}`, T0 + i, i % 2 === 0 ? { content: [{ type: 'tool_use', id: `toolu_${i}g`, name: 'Grep', input: { pattern: 'compact_boundary' } }] } : {}))
    if (i % 4 === 0) lines.push(compactBoundaryLine({ ts: T0 + i, trigger: i % 8 === 0 ? 'manual' : 'auto' }))
    if (i % 4 === 0) lines.push(compactSummaryLine({ ts: T0 + i + 1, summary: 'the "subtype":"compact_boundary" and "is_error":true of it' }))
  }
  const COMPACT = '"subtype":"compact_boundary"'
  let rawErrors = 0, rawModes = 0, rawCompacts = 0, parsedErrors = 0, parsedModes = 0, parsedCompacts = 0
  for (const raw of lines) {
    rawErrors += toolErrorsOf(raw)
    if (permissionModeOf(raw) !== null) rawModes++
    const d = JSON.parse(raw)
    if (raw.includes(COMPACT) && compactionOf(d, T0) !== null) rawCompacts++
    for (const b of Array.isArray(d.message?.content) ? d.message.content : []) if (b?.type === 'tool_result' && b.is_error === true) parsedErrors++
    if (d.type === 'user' && ['default', 'acceptEdits', 'bypassPermissions', 'plan', 'auto'].includes(d.permissionMode)) parsedModes++
    if (d.type === 'system' && d.subtype === 'compact_boundary') parsedCompacts++
  }
  t.diagnostic(`raw gates over ${lines.length} fixture lines: is_error ${rawErrors} (parsed ${parsedErrors}), permissionMode ${rawModes} (parsed ${parsedModes}), compactions ${rawCompacts} (parsed ${parsedCompacts})`)
  assert.deepEqual([rawErrors, rawModes, rawCompacts], [parsedErrors, parsedModes, parsedCompacts])
  assert.deepEqual([parsedErrors, parsedModes, parsedCompacts], [4 + 3 + 6, 8, 3])
})
