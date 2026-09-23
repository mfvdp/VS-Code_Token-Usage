// SPDX-FileCopyrightText: 2026 Frederik Marx
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * A workflow run's journal (1.6 §0a.1, §3 D2, D7): what the aggregator takes from
 * `<session>/subagents/workflows/<run>/journal.jsonl` — the `type`, the `key` and the `agentId`
 * at the head of each line — and how it keeps it: the run's agents with their step, their
 * attempt, the journal's outcome and the attempt that superseded them, and the key nowhere but in
 * a map in memory. The lines are the shape Claude Code writes (checked 2026-09-23): the head
 * `{"type":…,"key":…,"agentId":…`, a key of `v2:` and 64 hex digits, a started line's label and
 * phase, a result line's result — content, every one of them, save the three fields of the head.
 */

import { strict as assert } from 'node:assert'
import { after, test } from 'node:test'
import * as fs from 'fs'
import * as path from 'path'
import { MAX_RUN_AGENTS } from '../src/agentTree'
import { AGENT_TABLES_REVISION, Aggregator, JOURNAL_HEAD_RE, JOURNAL_PARSE_MAX } from '../src/agg'
import { configureRoots } from '../src/discover'
import { toCsv, toJson, toolsCsv } from '../src/exporter'
import { agentReplayFiles, rebuildJournal, replayAgents, scan } from '../src/scan'
import { markdownDocument } from '../src/textViews'
import { TimeConfig } from '../src/time'
import { JournalAgent, Snapshot } from '../src/types'
import { buildViewModel } from '../src/viewModel'
import {
  CLAUDE_ROOT, CLAUDE_SLUG, agentResultLine, agentToolUseLine, claudeLine, ctxFor, journalKey, journalLine, tmpDir,
} from './fixtures/helpers'
import { AGENT_WORLD, agentNode, agentWorld } from './fixtures/agentWorld'
import { NOW, makeConfig, makeInput } from './fixtures/viewFixtures'

/** Roots are module state; the next test file must not inherit a scratch directory. */
after(() => { configureRoots() })

const MIN = 60_000
const utc: TimeConfig = { zone: 'utc', dayBoundaryHour: 0, startOfWeek: 'monday', hourCycle: 'h23' }

const SESSION = '7c0ffee0-1a2b-4c3d-8e4f-000000000007'
const WF = 'wf_1a2b3c4d-567'
const WF_DIR = path.join(CLAUDE_ROOT, CLAUDE_SLUG, SESSION, 'subagents', 'workflows', WF)
const JOURNAL = path.join(WF_DIR, 'journal.jsonl')
const JOURNAL_CTX = ctxFor({ file: JOURNAL, isSub: true })

/** Agent ids in Claude Code's `a` + 16 hex shape. */
const A1 = 'a1111aaaa1111aaaa'
const A2 = 'a2222bbbb2222bbbb'
const A3 = 'a3333cccc3333cccc'

function feed(agg: Aggregator, lines: string[], ctx = JOURNAL_CTX): boolean[] {
  return lines.map((l) => agg.addWorkflowJournalLine(l, ctx))
}

/** The run's journal agents, as the snapshot writes them. */
function agentsOf(agg: Aggregator): JournalAgent[] {
  return JSON.parse(JSON.stringify(agg.runs().find((r) => r.workflowId === WF)?.agents ?? [])) as JournalAgent[]
}

function writeLines(file: string, lines: string[]): void {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, lines.map((l) => `${l}\n`).join(''))
}

function appendLines(file: string, lines: string[]): void {
  fs.appendFileSync(file, lines.map((l) => `${l}\n`).join(''))
}

/** A Claude home with one session whose workflow run keeps its journal, configured as the root. */
function journalHome(prefix: string): { home: string; journal: string; dir: string; main: string } {
  const home = tmpDir(prefix)
  const dir = path.join(home, 'projects', CLAUDE_SLUG, SESSION, 'subagents', 'workflows', WF)
  configureRoots([home], [path.join(home, 'codex')])
  return { home, dir, journal: path.join(dir, 'journal.jsonl'), main: path.join(home, 'projects', CLAUDE_SLUG, `${SESSION}.jsonl`) }
}

// ---------------------------------------------------------------------------
// The head
// ---------------------------------------------------------------------------

test('the journal head: type, key and agentId at the start of the raw line, and nothing after them', () => {
  const key = journalKey(1)
  const started = journalLine({ type: 'started', agentId: A1, step: 1 })
  assert.ok(started.startsWith(`{"type":"started","key":"${key}","agentId":"${A1}"`), started)
  const m = JOURNAL_HEAD_RE.exec(started)
  assert.deepEqual(m && [m[1], m[2], m[3]], ['started', key, A1])

  const agg = new Aggregator()
  assert.deepEqual(feed(agg, [started]), [true])
  // A result whose result holds keys of the same names: the head is the line's own, and the rest
  // is never parsed.
  const tricky = `{"type":"result","key":"${key}","agentId":"${A1}","result":{"agentId":"${A2}","type":"failed","key":"${journalKey(9)}"}}`
  assert.deepEqual(feed(agg, [tricky]), [true])
  assert.deepEqual(agentsOf(agg), [{ agentId: A1, step: 1, attempt: 1, outcome: 'completed', supersededBy: null }])
  // `launched` carries its type alone, and changes nothing — but a journal is in memory from its
  // first line on, whatever the line says, so one without keys is not read again for them.
  assert.deepEqual(feed(agg, [journalLine({ type: 'launched' })]), [false])
  const fresh = new Aggregator()
  assert.equal(fresh.journalInMemory(JOURNAL), false)
  assert.deepEqual(feed(fresh, [journalLine({ type: 'launched' })]), [false])
  assert.equal(fresh.journalInMemory(JOURNAL), true)
  assert.equal(fresh.runs().length, 0, 'a launch makes no run')
  // A `v1:` key is a key too; a line read again changes nothing.
  assert.deepEqual(feed(agg, [journalLine({ type: 'started', agentId: A2, key: `v1:${'0'.repeat(64)}` }), started]), [true, false])
  assert.equal(agentsOf(agg)[1].step, 2)
})

test('a line without a head of its own falls back to a parse of three fields, and a long one is skipped and counted', () => {
  const agg = new Aggregator()
  // Keys in another order: no head, so the line is parsed for the same three fields.
  const reordered = JSON.stringify({ agentId: A1, label: 'synthetic journal label', type: 'started', key: journalKey(1) })
  // A key outside its allow-list: the head names no agent, and the fallback drops the key — step 0.
  const oddKey = journalLine({ type: 'started', agentId: A2, key: 'synthetic-journal-key' })
  // The agent before the key: the head reads the agent, with no key.
  const agentFirst = `{"type":"started","agentId":"${A3}","key":"${journalKey(1)}"}`
  assert.deepEqual(feed(agg, [reordered, oddKey, agentFirst]), [true, true, true])
  assert.deepEqual(agentsOf(agg).map((a) => [a.agentId, a.step, a.attempt, a.supersededBy]),
    [[A1, 1, 1, null], [A2, 0, 1, null], [A3, 0, 1, null]])
  assert.equal(agg.journalSkipped, 0)
  // Beyond JOURNAL_PARSE_MAX, a line without the head is not parsed: skipped, and counted.
  const long = JSON.stringify({ label: 'x'.repeat(JOURNAL_PARSE_MAX), type: 'failed', agentId: A1, key: journalKey(1) })
  assert.ok(long.length > JOURNAL_PARSE_MAX)
  assert.deepEqual(feed(agg, [long]), [false])
  assert.equal(agg.journalSkipped, 1)
  assert.equal(agentsOf(agg)[0].outcome, null)
  // With its head, a long line is read — the head is all that is read of it.
  const headed = journalLine({ type: 'result', agentId: A1, step: 1, result: { summary: 'x'.repeat(JOURNAL_PARSE_MAX) } })
  assert.deepEqual(feed(agg, [headed]), [true])
  assert.equal(agentsOf(agg)[0].outcome, 'completed')
  // Nothing that is no journal line is one.
  for (const raw of ['', 'not json', '{"type":"started"}', '{"type":"other","agentId":"a1"}', '[1,2]', 'null']) {
    assert.equal(agg.addWorkflowJournalLine(raw, JOURNAL_CTX), false, raw)
  }
  // A journal that lies in no run directory belongs to no run.
  const loose = ctxFor({ file: path.join(CLAUDE_ROOT, CLAUDE_SLUG, SESSION, 'subagents', 'journal.jsonl'), isSub: true })
  assert.equal(agg.addWorkflowJournalLine(journalLine({ type: 'started', agentId: A1 }), loose), false)
})

// ---------------------------------------------------------------------------
// D2 · failed; D7 · replaced and retried
// ---------------------------------------------------------------------------

test('a failed line records the failure, and of two ends the later line wins', () => {
  const agg = new Aggregator()
  feed(agg, [journalLine({ type: 'started', agentId: A1, step: 1 }), journalLine({ type: 'failed', agentId: A1, step: 1 })])
  assert.deepEqual(agentsOf(agg), [{ agentId: A1, step: 1, attempt: 1, outcome: 'failed', supersededBy: null }])
  // Never observed, and taken as it comes: a result after the failure completes it.
  assert.deepEqual(feed(agg, [journalLine({ type: 'result', agentId: A1, step: 1 })]), [true])
  assert.equal(agentsOf(agg)[0].outcome, 'completed')
  assert.deepEqual(feed(agg, [journalLine({ type: 'failed', agentId: A1, step: 1 })]), [true])
  assert.equal(agentsOf(agg)[0].outcome, 'failed')
  // A failure for an agent the journal never started is taken as its start — kept, for D4 to count.
  feed(agg, [journalLine({ type: 'failed', agentId: A2, step: 2 })])
  assert.deepEqual(agentsOf(agg)[1], { agentId: A2, step: 2, attempt: 1, outcome: 'failed', supersededBy: null })
  // The record of an agent is never touched by the journal: it keeps the parent's outcome alone.
  const rec = path.join(WF_DIR, `agent-${A1.slice(1)}.jsonl`)
  agg.addClaudeLine(claudeLine({ id: 'r1', ts: NOW, agentId: A1, usage: { input: 1 } }), ctxFor({ file: rec, isSub: true }))
  feed(agg, [journalLine({ type: 'result', agentId: A1, step: 1 })])
  assert.equal(agg.agents()[0].outcome, null)
})

test('a step started again supersedes the attempt before it: replaced when it had recorded nothing, retried when it had failed', () => {
  const K = 'build'
  // started(K, a1) started(K, a2): a1 recorded nothing — replaced.
  const replaced = new Aggregator()
  feed(replaced, [journalLine({ type: 'started', agentId: A1, step: K }), journalLine({ type: 'started', agentId: A2, step: K })])
  assert.deepEqual(agentsOf(replaced), [
    { agentId: A1, step: 1, attempt: 1, outcome: 'stopped', supersededBy: A2 },
    { agentId: A2, step: 1, attempt: 2, outcome: null, supersededBy: null },
  ])
  // started(K, a1) failed(K, a1) started(K, a2): a failure, retried — it stays a failure.
  const retried = new Aggregator()
  feed(retried, [journalLine({ type: 'started', agentId: A1, step: K }), journalLine({ type: 'failed', agentId: A1, step: K }),
    journalLine({ type: 'started', agentId: A2, step: K }), journalLine({ type: 'result', agentId: A2, step: K })])
  assert.deepEqual(agentsOf(retried), [
    { agentId: A1, step: 1, attempt: 1, outcome: 'failed', supersededBy: A2 },
    { agentId: A2, step: 1, attempt: 2, outcome: 'completed', supersededBy: null },
  ])
  // A completed step run again keeps its completion; it is superseded all the same.
  const rerun = new Aggregator()
  feed(rerun, [journalLine({ type: 'started', agentId: A1, step: K }), journalLine({ type: 'result', agentId: A1, step: K }),
    journalLine({ type: 'started', agentId: A2, step: K }), journalLine({ type: 'started', agentId: A3, step: 'other' })])
  assert.deepEqual(agentsOf(rerun).map((a) => [a.agentId, a.step, a.attempt, a.outcome, a.supersededBy]), [
    [A1, 1, 1, 'completed', A2], [A2, 1, 2, null, null], [A3, 2, 1, null, null],
  ])
  assert.equal(rerun.runs()[0].steps, 2)
  // Without a key there is no step to compare: a start of step 0 supersedes nothing.
  const keyless = new Aggregator()
  feed(keyless, [journalLine({ type: 'started', agentId: A1, key: null }), journalLine({ type: 'failed', agentId: A1, key: null }),
    journalLine({ type: 'started', agentId: A2, key: null })])
  assert.deepEqual(agentsOf(keyless).map((a) => [a.step, a.attempt, a.outcome, a.supersededBy]),
    [[0, 1, 'failed', null], [0, 1, null, null]])
})

test('a run keeps MAX_RUN_AGENTS journal agents and counts the rest; a start beyond the cap still supersedes', () => {
  const agg = new Aggregator()
  const id = (n: number): string => `a${n.toString(16).padStart(16, '0')}`
  const lines: string[] = []
  for (let n = 0; n < MAX_RUN_AGENTS; n++) lines.push(journalLine({ type: 'started', agentId: id(n), step: n, label: null, phase: null }))
  feed(agg, lines)
  const run = agg.runs()[0]
  assert.equal(run.agents.length, MAX_RUN_AGENTS)
  assert.equal(run.agentsDropped, 0)
  // Two more: one a new step, one the last step started again.
  feed(agg, [journalLine({ type: 'started', agentId: id(MAX_RUN_AGENTS), step: 'new' }),
    journalLine({ type: 'started', agentId: id(MAX_RUN_AGENTS + 1), step: MAX_RUN_AGENTS - 1 })])
  assert.equal(agg.runs()[0].agents.length, MAX_RUN_AGENTS)
  assert.equal(agg.runs()[0].agentsDropped, 2)
  assert.equal(agg.runs()[0].steps, MAX_RUN_AGENTS + 1)
  const last = agg.runs()[0].agents[MAX_RUN_AGENTS - 1]
  assert.deepEqual([last.outcome, last.supersededBy], ['stopped', id(MAX_RUN_AGENTS + 1)])
  // An end for an agent that was counted, not listed, has nowhere to go.
  assert.equal(agg.addWorkflowJournalLine(journalLine({ type: 'result', agentId: id(MAX_RUN_AGENTS), step: 'new' }), JOURNAL_CTX), false)
})

// ---------------------------------------------------------------------------
// The step map after a restart, a rewrite and a replay
// ---------------------------------------------------------------------------

test('after a restart the rebuild pass brings the keys back: a step started again still supersedes', async () => {
  const { journal } = journalHome('journal-restart')
  writeLines(journal, [
    journalLine({ type: 'started', agentId: A1, step: 'k' }),
    journalLine({ type: 'started', agentId: A2, step: 'k' }),
  ])
  const first = new Aggregator()
  await scan(first)
  assert.deepEqual(agentsOf(first).map((a) => [a.agentId, a.outcome, a.supersededBy]), [[A1, 'stopped', A2], [A2, null, null]])
  // The journal's mtime is the run's last activity: lines carry no time.
  assert.equal(first.runs()[0].lastTs, fs.statSync(journal).mtimeMs)

  // A restart: the snapshot holds the run, not the keys.
  const snap = JSON.parse(JSON.stringify(first.toSnapshot())) as Snapshot
  const restored = Aggregator.fromSnapshot(snap)
  assert.equal(restored.journalInMemory(journal), false)
  assert.deepEqual(agentsOf(restored), agentsOf(first))
  // Without the rebuild a third start of the same step would read as a new step: the map is empty.
  const unrebuilt = Aggregator.fromSnapshot(JSON.parse(JSON.stringify(snap)) as Snapshot)
  unrebuilt.addWorkflowJournalLine(journalLine({ type: 'started', agentId: A3, step: 'k' }), ctxFor({ file: journal, isSub: true }))
  assert.deepEqual(agentsOf(unrebuilt).map((a) => [a.agentId, a.step, a.supersededBy]), [[A1, 1, A2], [A2, 1, null], [A3, 2, null]])

  // A scan that finds the journal unchanged has nothing to read on, and needs no keys yet.
  await scan(restored)
  assert.equal(restored.journalInMemory(journal), false)
  // The scan rebuilds the map from the file up to its cursor before it reads on.
  appendLines(journal, [journalLine({ type: 'started', agentId: A3, step: 'k' })])
  await scan(restored)
  assert.equal(restored.journalInMemory(journal), true)
  assert.deepEqual(agentsOf(restored).map((a) => [a.agentId, a.step, a.attempt, a.outcome, a.supersededBy]), [
    [A1, 1, 1, 'stopped', A2], [A2, 1, 2, 'stopped', A3], [A3, 1, 3, null, null],
  ])
  assert.equal(restored.runs()[0].steps, 1)

  // The pass itself is idempotent: run again, it rebuilds the same run.
  const before = JSON.stringify(restored.runs())
  const cur = restored.cursors.get(journal)
  assert.ok(cur)
  assert.equal(await rebuildJournal(restored, journal, cur), 3)
  assert.equal(JSON.stringify(restored.runs()), before)
  // A file that is no longer the one the cursor measured is left to the tail.
  assert.equal(await rebuildJournal(restored, journal, { ...cur, ino: cur.ino + 1 }), 0)
})

test('a journal rewritten from the start derives its run anew, dropping what the old file said', async () => {
  const { journal } = journalHome('journal-rewrite')
  writeLines(journal, [
    journalLine({ type: 'started', agentId: A1, step: 'k' }),
    journalLine({ type: 'failed', agentId: A1, step: 'k' }),
    journalLine({ type: 'started', agentId: A2, step: 'k' }),
  ])
  const agg = new Aggregator()
  await scan(agg)
  assert.equal(agentsOf(agg).length, 2)
  // Truncated and written anew: shorter than what was read, so the tail reads it from byte 0.
  writeLines(journal, [journalLine({ type: 'started', agentId: A3, step: 'k' })])
  await scan(agg)
  assert.deepEqual(agentsOf(agg), [{ agentId: A3, step: 1, attempt: 1, outcome: null, supersededBy: null }])
  // Replaced by another file (a new inode): the same.
  const next = `${journal}.new`
  fs.writeFileSync(next, [journalLine({ type: 'started', agentId: A1, step: 'j' }), journalLine({ type: 'result', agentId: A1, step: 'j' })]
    .map((l) => `${l}\n`).join('') + 'x'.repeat(64) + '\n')
  fs.renameSync(next, journal)
  await scan(agg)
  assert.deepEqual(agentsOf(agg), [{ agentId: A1, step: 1, attempt: 1, outcome: 'completed', supersededBy: null }])
})

test('a version 7 snapshot is read forward: no runs, the journal\'s completions taken back, and the revision says the replay is due', async () => {
  const { journal, dir, main } = journalHome('journal-v7')
  const agentFile = (id: string): string => path.join(dir, `agent-${id}.jsonl`)
  // Two run agents with transcripts: one only the journal completed, one its parent completed too.
  writeLines(main, [
    claudeLine({ id: 'm1', ts: NOW - 30 * MIN, sessionId: SESSION, usage: { input: 10 } }),
    agentToolUseLine({ id: 'm2', ts: NOW - 29 * MIN, toolUseId: 'toolu_run0001' }),
    agentResultLine({ ts: NOW - 20 * MIN, toolUseId: 'toolu_run0001', agentId: 'b0b0' }),
  ])
  writeLines(agentFile('a0a0'), [claudeLine({ id: 'w1', ts: NOW - 28 * MIN, agentId: 'a0a0', usage: { input: 5 } })])
  writeLines(agentFile('b0b0'), [claudeLine({ id: 'w2', ts: NOW - 27 * MIN, agentId: 'b0b0', usage: { input: 6 } })])
  writeLines(journal, [
    journalLine({ type: 'started', agentId: 'a0a0', step: 1 }), journalLine({ type: 'result', agentId: 'a0a0', step: 1 }),
    journalLine({ type: 'started', agentId: 'b0b0', step: 2 }), journalLine({ type: 'result', agentId: 'b0b0', step: 2 }),
    journalLine({ type: 'started', agentId: 'c0c0', step: 3 }), journalLine({ type: 'failed', agentId: 'c0c0', step: 3 }),
  ])
  const full = new Aggregator()
  await scan(full)
  const expected = JSON.stringify(full.runs())

  // What 1.5.1 left behind: version 7, the journal's result written onto its agent, results that
  // waited in `journalResults`, and "replayed".
  const v7 = JSON.parse(JSON.stringify(full.toSnapshot())) as Snapshot & Record<string, unknown>
  v7.version = 7
  delete v7.runs
  delete v7.agentsRevision
  v7.journalResults = { c0c0: 0 }
  v7.agentsReplayed = true
  for (const rec of Object.values(v7.agents ?? {})) rec.outcome = 'completed'
  const agg = Aggregator.fromSnapshot(v7)
  assert.equal(agg.runs().length, 0)
  assert.equal(agg.agentsRevision, 0, 'a version 7 was replayed by 1.5: the replay is due')
  // The completion no launch carries was the journal's: taken back. The parent's stays.
  const outcome = (id: string): string | null => agg.agents().find((r) => r.agentId === id)?.outcome ?? null
  assert.equal(outcome('a0a0'), null)
  assert.equal(outcome('b0b0'), 'completed')
  assert.equal(JSON.stringify(agg.toSnapshot()).includes('journalResults'), false)

  // The replay rebuilds the runs from the journals, from their first byte.
  assert.ok(agentReplayFiles(agg, NOW).includes(journal))
  assert.ok(await replayAgents(agg, agentReplayFiles(agg, NOW)) > 0)
  assert.equal(JSON.stringify(agg.runs()), expected)
  assert.equal(agg.journalInMemory(journal), true, 'the replay read the keys as well')
  assert.equal(agg.agentsRevision, 0, 'the revision is the host\'s to set once the replay is saved')
  // A second replay rebuilds the same runs rather than doubling them.
  await replayAgents(agg, agentReplayFiles(agg, NOW))
  assert.equal(JSON.stringify(agg.runs()), expected)
  // Written back as version 8 with the revision the host sets, and read back with it.
  agg.agentsRevision = AGENT_TABLES_REVISION
  const back = Aggregator.fromSnapshot(JSON.parse(JSON.stringify(agg.toSnapshot())) as Snapshot)
  assert.equal(back.agentsRevision, AGENT_TABLES_REVISION)
  assert.equal(JSON.stringify(back.runs()), expected)
  // A revision that is no count is 0 — the replay runs again rather than never.
  for (const odd of [-1, 1.5, 'x', null]) {
    const s = { ...back.toSnapshot(), agentsRevision: odd } as unknown as Snapshot
    assert.equal(Aggregator.fromSnapshot(s).agentsRevision, 0, String(odd))
  }
})

test('the tree joins a run\'s journal to its agents by id, and the join survives a snapshot round trip', () => {
  // The world of the Agents tests: a failure the journal retried, the retry, and an attempt it
  // replaced (test/fixtures/agentWorld.ts).
  const { agg } = agentWorld()
  const cfg = makeConfig()
  const vm = buildViewModel(makeInput({ agg, cfg })).agents
  const W = AGENT_WORLD
  const n = (id: string) => agentNode(vm.roots, id)
  assert.deepEqual([n(W.wfRetryFail).state, n(W.wfRetryFail).superseded], ['failed', true])
  assert.deepEqual([n(W.wfRetry).state, n(W.wfRetry).superseded], ['done', false])
  assert.deepEqual([n(W.wfReplaced).state, n(W.wfReplaced).superseded], ['stopped', true])
  assert.deepEqual([n(W.wfRunning).state, n(W.wfRunning).superseded], ['running', false])
  assert.deepEqual([n(W.wfDone).state, n(W.wfDone).superseded], ['done', false])
  const back = Aggregator.fromSnapshot(JSON.parse(JSON.stringify(agg.toSnapshot())) as Snapshot)
  assert.equal(JSON.stringify(buildViewModel(makeInput({ agg: back, cfg })).agents), JSON.stringify(vm))
})

// ---------------------------------------------------------------------------
// §0a.1 · the leak test
// ---------------------------------------------------------------------------

test('the journal key never leaves the comparison', async () => {
  // Two steps, a retry and a replacement, keys `v2:` + sha256 of `synthetic-journal-step-<n>`;
  // every started line with a label and a phase, every result with a result — all content.
  const secret = 'JOURNAL-CONTENT-7e21'
  const { journal, dir, main } = journalHome('journal-leak')
  const keys = [journalKey(1), journalKey(2)]
  const agentFile = (id: string): string => path.join(dir, `agent-${id}.jsonl`)
  const started = (agentId: string, step: number): string =>
    journalLine({ type: 'started', agentId, step, label: `${secret}-label-${agentId}`, phase: `${secret}-phase` })
  const result = (agentId: string, step: number): string =>
    journalLine({ type: 'result', agentId, step, result: { summary: `${secret}-result-${agentId}`, key: keys[0] } })
  writeLines(main, [claudeLine({ id: 'm1', ts: NOW - 20 * MIN, sessionId: SESSION, usage: { input: 10 }, final: true })])
  for (const [i, id] of [A1, A2, A3].entries()) {
    writeLines(agentFile(id.slice(1)), [claudeLine({ id: `w${i}`, ts: NOW - (15 - i) * MIN, agentId: id.slice(1), usage: { input: 5 + i } })])
  }
  const [a1, a2, a3] = [A1, A2, A3].map((id) => id.slice(1))
  writeLines(journal, [
    started(a1, 1), journalLine({ type: 'failed', agentId: a1, step: 1 }), started(a2, 1), result(a2, 1),
    started(a3, 2), started('d4d4', 2),
  ])
  const agg0 = new Aggregator()
  await scan(agg0)
  // A restart — a snapshot round trip — then a line more, which the rebuild pass reads the keys
  // for, and a replay over everything.
  const agg = Aggregator.fromSnapshot(JSON.parse(JSON.stringify(agg0.toSnapshot())) as Snapshot)
  appendLines(journal, [result('d4d4', 2)])
  await scan(agg)
  await replayAgents(agg, agentReplayFiles(agg, NOW))
  // Only a test of anything if the journal really went through: the retry and the replacement.
  assert.deepEqual(agentsOf(agg).map((a) => [a.agentId, a.step, a.attempt, a.outcome, a.supersededBy]), [
    [a1, 1, 1, 'failed', a2], [a2, 1, 2, 'completed', null], [a3, 2, 1, 'stopped', 'd4d4'], ['d4d4', 2, 2, 'completed', null],
  ])
  const raw = fs.readFileSync(journal, 'utf8')
  for (const k of keys) assert.ok(raw.includes(k), 'the fixture lost a key')

  // Everything that leaves the aggregator: the snapshot, the view model with each node's details
  // open, the markdown, the exports.
  const cfg = makeConfig()
  const outputs: Array<[string, string]> = [['snapshot', JSON.stringify(agg.toSnapshot())]]
  const vm = buildViewModel(makeInput({ agg, cfg }))
  const keysOf = (nodes: typeof vm.agents.roots): string[] => nodes.flatMap((n) => [n.key, ...keysOf(n.children)])
  const nodeKeys = keysOf(vm.agents.roots)
  assert.ok(nodeKeys.includes(`a:${a1}`), nodeKeys.join(', '))
  for (const key of nodeKeys) {
    const open = buildViewModel(makeInput({ agg, cfg, ui: { agentSelected: key } }))
    outputs.push([`view model ${key}`, JSON.stringify(open)], [`markdown ${key}`, markdownDocument(open)])
  }
  const range = { from: '2026-09-01', to: '2026-09-03' }
  outputs.push(['json export', toJson(agg, range, cfg, utc)], ['csv export', toCsv(agg, range, cfg, utc)],
    ['tools export', toolsCsv(agg, range)])
  // (The agents CSV comes with 1.6 O2; the log and the diagnostics report are the host's, and
  // test/extension.test.ts holds them to the same rule.)
  // None of the keys, nor any 16-hex run of one of them; nor a label, a phase or a result.
  const runs = keys.flatMap((k) => {
    const hex = k.slice(3)
    return Array.from({ length: hex.length - 15 }, (_, i) => hex.slice(i, i + 16))
  })
  for (const [what, text] of outputs) {
    for (const k of keys) assert.equal(text.includes(k), false, `${what} holds a journal key`)
    const hit = runs.find((r) => text.includes(r))
    assert.equal(hit, undefined, `${what} holds 16 hex digits of a journal key: ${hit}`)
    assert.equal(text.includes(secret), false, `${what} holds a journal line's label, phase or result`)
  }
  // The stored state has no field of those names at all (a view model's nodes do have labels).
  assert.equal(/"(key|label|phase|result)"/.test(outputs[0][1]), false, 'the snapshot holds a journal field')
})
