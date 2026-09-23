// SPDX-FileCopyrightText: 2026 Frederik Marx
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * A workflow run's own end (1.6 §0a.3, §3 N4, §3.0 c, and D7 for runs): the `Workflow` tool call
 * that launches a run, the tool result that names it — its `runId` — and the task notification
 * that ends it, as the aggregator keeps them (`RunLaunch`) and the tree reads them. Of the call
 * only its `id` is read, never its input, which holds the workflow's script; of the result only
 * `runId` and `status`, never its summary, its paths or its names. The lines are the shape Claude
 * Code writes (checked 2026-09-23): every other key carries fixture text.
 *
 * The precedence of a run's end: the parent's end for its latest launch, then — every member
 * closed — what the members came to, then Claude Code's run record (1.6 L4, not read yet: it
 * says nothing), then what the members' clocks say. A recorded end never closes a member, and is
 * outlived like an agent's when a member writes on more than a minute after it.
 */

import { strict as assert } from 'node:assert'
import { after, test } from 'node:test'
import * as fs from 'fs'
import * as path from 'path'
import { AGENT_RETENTION_DAYS, NodeDetails, RESUMED_AFTER_MS, RUNNING_WINDOW_MS, TreeNode } from '../src/agentTree'
import { AGENT_TABLES_REVISION, Aggregator, cleanRunId } from '../src/agg'
import { configureRoots } from '../src/discover'
import { toCsv, toJson, toolsCsv } from '../src/exporter'
import { setBundle, setLocale } from '../src/i18n'
import { agentReplayFiles, replayAgents, scan } from '../src/scan'
import { markdownDocument } from '../src/textViews'
import { TimeConfig } from '../src/time'
import { RunLaunch, Snapshot } from '../src/types'
import { agentTreeFor, buildViewModel, defaultUiState } from '../src/viewModel'
import {
  CLAUDE_ROOT, CLAUDE_SLUG, claudeLine, ctxFor, journalLine, queueOperationLine, tmpDir, workflowResultLine,
  workflowToolUseLine,
} from './fixtures/helpers'
import { everyParent } from './fixtures/agentWorld'
import { NOW, makeConfig, makeInput } from './fixtures/viewFixtures'
import { ROOT } from './helpers/nls'

/** Roots are module state; the next test file must not inherit a scratch directory. */
after(() => { configureRoots() })

const MIN = 60_000
const DAY = 86_400_000
const utc: TimeConfig = { zone: 'utc', dayBoundaryHour: 0, startOfWeek: 'monday', hourCycle: 'h23' }

const SESSION = '4a11c0de-5e6f-4a7b-8c9d-0e1f2a3b4c5d'
/** A run id in Claude Code's shape: `wf_`, 8 hex, `-`, 3 hex. */
const RUN = 'wf_5eed1234-abc'
const SLUG_DIR = path.join(CLAUDE_ROOT, CLAUDE_SLUG)
const MAIN = path.join(SLUG_DIR, `${SESSION}.jsonl`)
const RUN_DIR = path.join(SLUG_DIR, SESSION, 'subagents', 'workflows', RUN)
const JOURNAL = path.join(RUN_DIR, 'journal.jsonl')
const MAIN_CTX = ctxFor({ file: MAIN })
const JOURNAL_CTX = ctxFor({ file: JOURNAL, isSub: true })
const RUN_KEY = `w:${SESSION}|${RUN}`

/** Agent ids in Claude Code's `a` + 16 hex shape. */
const A1 = 'a1b2c3d4e5f6a7b8c'
const A2 = 'a2c3d4e5f6a7b8c9d'

/** 11:55 and the like: the stamp of a time of NOW's day. */
function clock(ms: number): string {
  return new Date(ms).toISOString().slice(11, 16)
}

/** A `Workflow` call at `ts` and the result that names its run a second later. */
function launchRun(agg: Aggregator, toolUseId: string, ts: number, o: { runId?: unknown; resume?: string; status?: string } = {}): void {
  agg.addClaudeLine(workflowToolUseLine({ id: `m-${toolUseId}`, ts, toolUseId, resumeFromRunId: o.resume }), MAIN_CTX)
  agg.addClaudeLine(workflowResultLine({ ts: ts + 1000, toolUseId, runId: o.runId ?? RUN, status: o.status }), MAIN_CTX)
}

/** The task notification of a `Workflow` call: how the run's end reaches the parent. */
function notify(agg: Aggregator, toolUseId: string, ts: number, status: string): boolean {
  return agg.addClaudeLine(queueOperationLine({ ts, toolUseId, status, summary: 'Workflow "synthetic run" finished' }), MAIN_CTX)
}

/** One counted line of a run's agent, in the run's directory. */
function agentLine(agg: Aggregator, id: string, n: number, ts: number): void {
  const file = path.join(RUN_DIR, `agent-${id.slice(1)}.jsonl`)
  agg.addClaudeLine(claudeLine({ id: `${id}-${n}`, ts, agentId: id.slice(1), usage: { input: 5, output: 3 }, final: true }),
    ctxFor({ file, isSub: true }))
}

/** A journal line of the run: the agent's start, or its end. */
function journal(agg: Aggregator, type: 'started' | 'result' | 'failed', id: string, mtime: number): void {
  agg.addWorkflowJournalLine(journalLine({ type, agentId: id.slice(1), step: id }), JOURNAL_CTX)
  agg.noteJournalRead(JOURNAL, mtime)
}

function launchOf(agg: Aggregator, toolUseId: string): RunLaunch {
  const l = agg.runLaunches().find((x) => x.toolUseId === toolUseId)
  assert.ok(l, `no run launch ${toolUseId}`)
  return l
}

/** The markdown's tree — every node open — and, with `selected`, that node's details. */
function treeOf(agg: Aggregator, now = NOW, selected: string | null = null): ReturnType<typeof agentTreeFor> {
  const cfg = makeConfig()
  return agentTreeFor({ agg, cfg, ui: { ...defaultUiState(cfg), agentSelected: selected }, now }, 'text')
}

function nodes(roots: readonly TreeNode[]): TreeNode[] {
  return roots.flatMap((n) => [n, ...nodes(n.children)])
}

/** The run's node and its details. */
function runOf(agg: Aggregator, now = NOW): { node: TreeNode; details: NodeDetails } {
  const vm = treeOf(agg, now, RUN_KEY)
  const node = nodes(vm.roots).find((n) => n.key === RUN_KEY)
  assert.ok(node, `no run node in ${nodes(vm.roots).map((n) => n.key).join(', ')}`)
  assert.ok(vm.selected, 'no details for the run')
  return { node, details: vm.selected }
}

function row(d: NodeDetails, label: string): string | undefined {
  return d.rows.find((r) => r.label === label)?.value
}

// ---------------------------------------------------------------------------
// The reader
// ---------------------------------------------------------------------------

test('a Workflow call is a run launch — its id alone — and the result that answers it names the run', () => {
  const agg = new Aggregator()
  const ts = NOW - 20 * MIN
  assert.equal(agg.addClaudeLine(workflowToolUseLine({ id: 'm1', ts, toolUseId: 'toolu_wf1' }), MAIN_CTX), true)
  // A streamed message repeats its block on its later lines: one launch, made by the first.
  agg.addClaudeLine(workflowToolUseLine({ id: 'm1', ts: ts + 500, toolUseId: 'toolu_wf1' }), MAIN_CTX)
  assert.deepEqual(agg.runLaunches(), [{
    toolUseId: 'toolu_wf1', file: MAIN, ts, runId: null, outcome: null, outcomeStatus: null, outcomeTs: null,
  }])
  // A run launch is no agent launch: nothing in the agent tables, no pending node for it.
  assert.equal(agg.launches().length, 0)
  assert.equal(agg.agents().length, 0)
  // Until the result names its run, the launch belongs to no run, and the tree has none.
  assert.equal(nodes(treeOf(agg).roots).some((n) => n.kind === 'workflow' || n.kind === 'pending'), false)

  assert.equal(agg.addClaudeLine(workflowResultLine({ ts: ts + 1000, toolUseId: 'toolu_wf1', runId: RUN }), MAIN_CTX), true)
  assert.deepEqual(launchOf(agg, 'toolu_wf1'), {
    toolUseId: 'toolu_wf1', file: MAIN, ts, runId: RUN, outcome: 'launched', outcomeStatus: null, outcomeTs: null,
  })
  // The same result read again changes nothing.
  assert.equal(agg.addClaudeLine(workflowResultLine({ ts: ts + 1000, toolUseId: 'toolu_wf1', runId: RUN }), MAIN_CTX), false)
  // The notification ends it, with its time and its word.
  assert.equal(notify(agg, 'toolu_wf1', NOW - 5 * MIN, 'completed'), true)
  assert.deepEqual(launchOf(agg, 'toolu_wf1'), {
    toolUseId: 'toolu_wf1', file: MAIN, ts, runId: RUN, outcome: 'completed', outcomeStatus: 'completed', outcomeTs: NOW - 5 * MIN,
  })
  // "Launched" never takes an end back: a result read again after it.
  assert.equal(agg.addClaudeLine(workflowResultLine({ ts: ts + 1000, toolUseId: 'toolu_wf1', runId: RUN }), MAIN_CTX), false)
  assert.equal(launchOf(agg, 'toolu_wf1').outcome, 'completed')
})

test('a run id is taken only through its allow-list, and a result without a call stands in for it', () => {
  assert.equal(cleanRunId('wf_cfe7718d-3c2a'), 'wf_cfe7718d-3c2a')
  assert.equal(cleanRunId(`wf_${'a'.repeat(61)}`), `wf_${'a'.repeat(61)}`)
  for (const bad of [`wf_${'a'.repeat(62)}`, 'wf_', 'cfe7718d', 'wf_../x', 'wf_a/b', 'wf_a b', 42, null, undefined, { runId: 'wf_a' }]) {
    assert.equal(cleanRunId(bad), null, String(bad))
  }
  const agg = new Aggregator()
  agg.addClaudeLine(workflowToolUseLine({ id: 'm1', ts: NOW - 10 * MIN, toolUseId: 'toolu_wf1' }), MAIN_CTX)
  const before = JSON.stringify(agg.toSnapshot())
  for (const runId of ['../wf_x', 'wf_', 42, 'wf_a b', `wf_${'b'.repeat(62)}`]) {
    assert.equal(agg.addClaudeLine(workflowResultLine({ ts: NOW - 9 * MIN, toolUseId: 'toolu_wf1', runId }), MAIN_CTX), false, String(runId))
  }
  // No `runId` key at all: the line is passed over unparsed.
  assert.equal(agg.addClaudeLine(workflowResultLine({ ts: NOW - 9 * MIN, toolUseId: 'toolu_wf1' }), MAIN_CTX), false)
  assert.equal(JSON.stringify(agg.toSnapshot()), before)
  // A result whose call lies before what was read: the result stands in for the call, with its time.
  assert.equal(agg.addClaudeLine(workflowResultLine({ ts: NOW - 8 * MIN, toolUseId: 'toolu_wf2', runId: RUN }), MAIN_CTX), true)
  assert.deepEqual(launchOf(agg, 'toolu_wf2'), {
    toolUseId: 'toolu_wf2', file: MAIN, ts: NOW - 8 * MIN, runId: RUN, outcome: 'launched', outcomeStatus: null, outcomeTs: null,
  })
})

test('a run\'s end is the parent\'s word for its launch: completed, failed, or a stop — never a failure', () => {
  const cases: Array<[string, string, string]> = [
    ['completed', 'done', `Completed — the parent recorded the end of this run at ${clock(NOW - 5 * MIN)}.`],
    ['failed', 'failed', `Failed — the parent recorded the failure of this run at ${clock(NOW - 5 * MIN)}.`],
    ['error', 'failed', `Failed — the parent recorded the failure of this run at ${clock(NOW - 5 * MIN)}.`],
    ['timeout', 'failed', `Failed — the parent recorded the failure of this run at ${clock(NOW - 5 * MIN)}.`],
    // D7 for runs: a stop keeps the parent's word, verbatim.
    ['killed', 'stopped', `Stopped — the parent recorded ‘killed’ for this run at ${clock(NOW - 5 * MIN)}.`],
    ['cancelled', 'stopped', `Stopped — the parent recorded ‘cancelled’ for this run at ${clock(NOW - 5 * MIN)}.`],
    ['stopped', 'stopped', `Stopped — the parent recorded ‘stopped’ for this run at ${clock(NOW - 5 * MIN)}.`],
  ]
  for (const [status, state, sentence] of cases) {
    const agg = new Aggregator()
    launchRun(agg, 'toolu_wf1', NOW - 20 * MIN)
    // One agent, completed by the journal: the members alone would make the run done.
    agentLine(agg, A1, 1, NOW - 19 * MIN)
    journal(agg, 'started', A1, NOW - 19 * MIN)
    journal(agg, 'result', A1, NOW - 15 * MIN)
    assert.equal(notify(agg, 'toolu_wf1', NOW - 5 * MIN, status), true, status)
    assert.equal(launchOf(agg, 'toolu_wf1').outcomeStatus, status)
    const { node, details } = runOf(agg)
    assert.deepEqual([node.state, node.derived], [state, false], status)
    assert.equal(details.stateText, sentence, status)
    assert.equal(details.id, RUN)
    assert.equal(row(details, 'ID'), RUN)
  }
  // A status this build does not know is no end; a notification for a call nobody recorded is
  // someone else's task.
  const agg = new Aggregator()
  launchRun(agg, 'toolu_wf1', NOW - 20 * MIN)
  assert.equal(notify(agg, 'toolu_wf1', NOW - 5 * MIN, 'paused'), false)
  assert.equal(notify(agg, 'toolu_unknown', NOW - 5 * MIN, 'completed'), false)
  assert.equal(launchOf(agg, 'toolu_wf1').outcome, 'launched')
  // A notification without a time: the end without one, in its timeless sentence.
  const timeless = new Aggregator()
  launchRun(timeless, 'toolu_wf1', NOW - 20 * MIN)
  const note = JSON.parse(queueOperationLine({ ts: NOW, toolUseId: 'toolu_wf1', status: 'killed' })) as Record<string, unknown>
  delete note.timestamp
  assert.equal(timeless.addClaudeLine(JSON.stringify(note), MAIN_CTX), true)
  assert.equal(runOf(timeless).details.stateText, 'Stopped — the parent recorded ‘killed’ for this run.')
})

test('a resumed run: the latest launch decides, and the earlier ones are history in the Launches row', () => {
  const agg = new Aggregator()
  agentLine(agg, A1, 1, NOW - 44 * MIN)
  journal(agg, 'started', A1, NOW - 44 * MIN)
  launchRun(agg, 'toolu_wf1', NOW - 45 * MIN)
  notify(agg, 'toolu_wf1', NOW - 30 * MIN, 'stopped')
  let run = runOf(agg)
  assert.equal(run.details.stateText, `Stopped — the parent recorded ‘stopped’ for this run at ${clock(NOW - 30 * MIN)}.`)
  // One launch: no Launches row.
  assert.equal(row(run.details, 'Launches'), undefined)
  // The run is resumed — the same run id — and completes.
  launchRun(agg, 'toolu_wf2', NOW - 20 * MIN, { resume: RUN })
  agentLine(agg, A2, 1, NOW - 19 * MIN)
  journal(agg, 'started', A2, NOW - 19 * MIN)
  notify(agg, 'toolu_wf2', NOW - 10 * MIN, 'completed')
  run = runOf(agg)
  assert.deepEqual([run.node.state, run.node.derived], ['done', false])
  assert.equal(run.details.stateText, `Completed — the parent recorded the end of this run at ${clock(NOW - 10 * MIN)}.`)
  assert.equal(row(run.details, 'Launches'), '2 — resumed 1 time(s)')
  // Resumed again, and under way: no end from the parent. The members decide — one of them is
  // writing now, so the run is running, inferred.
  launchRun(agg, 'toolu_wf3', NOW - 2 * MIN, { resume: RUN })
  agentLine(agg, A2, 2, NOW - 1 * MIN)
  run = runOf(agg)
  assert.deepEqual([run.node.state, run.node.derived], ['running', true])
  assert.equal(run.details.stateText, 'Running — inferred: at least one agent of this run is running.')
  assert.equal(row(run.details, 'Launches'), '3 — resumed 2 time(s)')
})

// ---------------------------------------------------------------------------
// §3.0 c: notification > journal > record > derived
// ---------------------------------------------------------------------------

test('the precedence of a run\'s end: the parent\'s, then its members\' closed ends, then their clocks', () => {
  const build = (o: { note?: string; members: Array<'result' | 'failed' | 'open' | 'silent'>; launched?: boolean }): TreeNode & { text: string } => {
    const agg = new Aggregator()
    if (o.note !== undefined || o.launched) launchRun(agg, 'toolu_wf1', NOW - 40 * MIN)
    const ids = ['a0a0a0a0a0a0a0a01', 'a0a0a0a0a0a0a0a02', 'a0a0a0a0a0a0a0a03']
    o.members.forEach((m, i) => {
      const id = ids[i]
      // An open member writes a minute before NOW; a silent one last wrote half an hour ago.
      agentLine(agg, id, 1, m === 'open' ? NOW - 1 * MIN : NOW - 38 * MIN)
      journal(agg, 'started', id, NOW - 38 * MIN)
      if (m === 'result' || m === 'failed') journal(agg, m, id, NOW - 37 * MIN)
    })
    if (o.note !== undefined) notify(agg, 'toolu_wf1', NOW - 36 * MIN, o.note)
    const run = runOf(agg)
    return { ...run.node, text: run.details.stateText }
  }
  // The parent's end alone: a run nothing but its launch shows.
  const note = build({ note: 'completed', members: [] })
  assert.deepEqual([note.state, note.derived, note.text],
    ['done', false, `Completed — the parent recorded the end of this run at ${clock(NOW - 36 * MIN)}.`])
  // The members' ends alone — every member closed: what they came to.
  const closed = build({ members: ['result', 'failed'] })
  assert.deepEqual([closed.state, closed.derived, closed.text],
    ['done', false, 'Done — every agent of this run has a recorded outcome, and at least one completed.'])
  const allFailed = build({ members: ['failed', 'failed'] })
  assert.deepEqual([allFailed.state, allFailed.text],
    ['failed', 'Failed — every agent of this run has a recorded outcome, and none completed.'])
  // Their clocks alone: running, else unknown.
  const running = build({ members: ['result', 'open'] })
  assert.deepEqual([running.state, running.derived, running.text],
    ['running', true, 'Running — inferred: at least one agent of this run is running.'])
  const unknown = build({ members: ['result', 'silent'] })
  assert.deepEqual([unknown.state, unknown.derived, unknown.text],
    ['unknown', true, 'Unknown — inferred: not every agent of this run has a recorded outcome, and none is running.'])
  // The parent over the members' ends: a stop recorded for a run whose agents all completed.
  const overClosed = build({ note: 'killed', members: ['result', 'result'] })
  assert.deepEqual([overClosed.state, overClosed.derived, overClosed.text],
    ['stopped', false, `Stopped — the parent recorded ‘killed’ for this run at ${clock(NOW - 36 * MIN)}.`])
  // The parent over the members' clocks: a silent member stays unknown — a run's end closes no
  // member — and the run is done all the same, the tally saying what is open.
  const overSilent = build({ note: 'completed', members: ['result', 'silent'] })
  assert.deepEqual([overSilent.state, overSilent.derived], ['done', false])
  assert.equal(overSilent.tally?.unknown, 1)
  assert.equal(overSilent.tally?.done, 1)
  // Launched and nothing recorded yet: the members decide, closed or not.
  const launchedClosed = build({ launched: true, members: ['result'] })
  assert.deepEqual([launchedClosed.state, launchedClosed.text],
    ['done', 'Done — every agent of this run has a recorded outcome, and at least one completed.'])
  const launchedOpen = build({ launched: true, members: ['open'] })
  assert.deepEqual([launchedOpen.state, launchedOpen.text], ['running', 'Running — inferred: at least one agent of this run is running.'])
  // Claude Code's run record (1.6 L4) is not read yet: no run here has one, and none of the
  // answers above came from it.
})

test('a recorded end does not close a member: it keeps running beside a done run, and is counted so', () => {
  const agg = new Aggregator()
  launchRun(agg, 'toolu_wf1', NOW - 20 * MIN)
  agentLine(agg, A1, 1, NOW - 19 * MIN)
  journal(agg, 'started', A1, NOW - 19 * MIN)
  // The member's last line comes before the end; the end two minutes ago; the member is within
  // its ten-minute window.
  agentLine(agg, A1, 2, NOW - 3 * MIN)
  notify(agg, 'toolu_wf1', NOW - 2 * MIN, 'completed')
  const vm = treeOf(agg)
  const run = nodes(vm.roots).find((n) => n.key === RUN_KEY)
  assert.ok(run)
  assert.deepEqual([run.state, run.derived], ['done', false])
  assert.equal(run.tally?.running, 1)
  assert.equal(run.tallyText, '1 started · ~1 ●')
  const agent = nodes(vm.roots).find((n) => n.key === `a:${A1.slice(1)}`)
  assert.deepEqual([agent?.state, agent?.derived], ['running', true])
  // The host keeps its poll on for it.
  assert.equal(vm.running, 1)
})

test('a member that writes on more than a minute after the run\'s end makes the run inferred again', () => {
  const end = NOW - 5 * MIN
  const world = (last: number): Aggregator => {
    const agg = new Aggregator()
    launchRun(agg, 'toolu_wf1', NOW - 30 * MIN)
    agentLine(agg, A1, 1, NOW - 29 * MIN)
    journal(agg, 'started', A1, NOW - 29 * MIN)
    notify(agg, 'toolu_wf1', end, 'completed')
    agentLine(agg, A1, 2, last)
    return agg
  }
  // 61 s after the end: running, and the details keep what was recorded.
  let run = runOf(world(end + RESUMED_AFTER_MS + 1000))
  assert.deepEqual([run.node.state, run.node.derived], ['running', true])
  assert.equal(run.details.stateText, `Running — inferred: an agent of this run wrote on after the parent recorded its end at ${clock(end)}.`)
  assert.equal(row(run.details, 'Recorded'), `done at ${clock(end)}`)
  // 59 s after it, and exactly 60 s: the tail of the same work; the end stands, no Recorded row.
  for (const last of [end + RESUMED_AFTER_MS - 1000, end + RESUMED_AFTER_MS]) {
    run = runOf(world(last))
    assert.deepEqual([run.node.state, run.node.derived], ['done', false], String(last - end))
    assert.equal(run.details.stateText, `Completed — the parent recorded the end of this run at ${clock(end)}.`)
    assert.equal(row(run.details, 'Recorded'), undefined)
  }
  // Wrote on, then fell silent past the ten minutes: unknown, the end still in the details.
  const late = world(end + 2 * MIN)
  run = runOf(late, end + 2 * MIN + RUNNING_WINDOW_MS + 1000)
  assert.deepEqual([run.node.state, run.node.derived], ['unknown', true])
  assert.equal(run.details.stateText, 'Unknown — inferred: not every agent of this run has a recorded outcome, and none is running.')
  assert.equal(row(run.details, 'Recorded'), `done at ${clock(end)}`)
  // A journal end carries no time and is never outlived: the members all closed by the journal,
  // one of them writing on long after, and the run is done by its members.
  const journalled = new Aggregator()
  agentLine(journalled, A1, 1, NOW - 29 * MIN)
  journal(journalled, 'started', A1, NOW - 29 * MIN)
  journal(journalled, 'result', A1, NOW - 28 * MIN)
  agentLine(journalled, A1, 2, NOW - 1 * MIN)
  assert.equal(runOf(journalled).node.state, 'done')
})

test('a run nothing but its launch shows is running for ten minutes, then unknown, with dashes for what nobody counted', () => {
  const agg = new Aggregator()
  launchRun(agg, 'toolu_wf1', NOW - 2 * MIN)
  const { node, details } = runOf(agg)
  const vm = treeOf(agg)
  const root = vm.roots.find((r) => r.key === `s:${SESSION}`)
  assert.ok(root)
  assert.ok(root.children.some((c) => c.key === RUN_KEY), 'the run sits under its session')
  assert.deepEqual([node.kind, node.label, node.state, node.derived], ['workflow', 'Workflow 5eed1234', 'running', true])
  assert.equal(details.stateText, 'Running — inferred: the parent launched this run 2 min ago and no agent has written yet.')
  assert.deepEqual([node.hasChildren, node.childrenTotal, node.agentCount, node.tally, node.tallyText], [false, 0, 0, null, null])
  assert.deepEqual([node.usage, node.duration, node.startTs], ['–', '–', NOW - 2 * MIN])
  assert.equal(row(details, 'Agents'), '–', 'no agent counted: a dash, never an invented 0')
  assert.equal(row(details, 'Started'), clock(NOW - 2 * MIN))
  assert.equal(row(details, 'Duration'), '–')
  assert.equal(row(details, 'Usage'), '–')
  assert.equal(row(details, 'ID'), RUN)
  // It is no agent: the running list and the host's count know nothing of it.
  assert.equal(vm.running, 0)
  assert.equal(vm.runningNow.length, 0)
  // Ten minutes after the launch it is still running; a second later unknown.
  assert.equal(runOf(agg, NOW - 2 * MIN + RUNNING_WINDOW_MS).node.state, 'running')
  const later = runOf(agg, NOW - 2 * MIN + RUNNING_WINDOW_MS + 1000)
  assert.deepEqual([later.node.state, later.node.derived], ['unknown', true])
  assert.equal(later.details.stateText,
    `Unknown — inferred: the parent launched this run at ${clock(NOW - 2 * MIN)}, but no agent of it was ever seen.`)
  // Its first agent turns it into a run of members, as any.
  agentLine(agg, A1, 1, NOW - 1 * MIN)
  const joined = runOf(agg)
  assert.deepEqual([joined.node.state, joined.node.agentCount, joined.node.hasChildren], ['running', 1, true])
  assert.equal(joined.details.stateText, 'Running — inferred: at least one agent of this run is running.')
  // The markdown prints the launch-only run like any node, dashes for its figures.
  const bare = new Aggregator()
  launchRun(bare, 'toolu_wf1', NOW - 2 * MIN)
  const cfg = makeConfig()
  const input = makeInput({ agg: bare, cfg })
  const md = markdownDocument(buildViewModel(input), agentTreeFor(input, 'text'))
  assert.match(md, /\[~Running\] Workflow 5eed1234 · – · –/)
})

test('a run launched from an agent\'s own transcript belongs to that agent\'s session', () => {
  const agg = new Aggregator()
  const host = path.join(SLUG_DIR, SESSION, 'subagents', 'agent-b1b1b1b1b1b1b1b1.jsonl')
  const hostCtx = ctxFor({ file: host, isSub: true })
  agg.addClaudeLine(claudeLine({ id: 'h1', ts: NOW - 5 * MIN, agentId: 'b1b1b1b1b1b1b1b1', usage: { input: 5 } }), hostCtx)
  agg.addClaudeLine(workflowToolUseLine({ id: 'h2', ts: NOW - 4 * MIN, toolUseId: 'toolu_wf9', agentId: 'b1b1b1b1b1b1b1b1' }), hostCtx)
  agg.addClaudeLine(workflowResultLine({ ts: NOW - 4 * MIN + 1000, toolUseId: 'toolu_wf9', runId: RUN, inAgent: 'b1b1b1b1b1b1b1b1' }), hostCtx)
  assert.equal(launchOf(agg, 'toolu_wf9').file, host)
  const vm = treeOf(agg)
  const root = vm.roots.find((r) => r.key === `s:${SESSION}`)
  assert.ok(root && nodes([root]).some((n) => n.key === RUN_KEY), 'the run is a node of the agent\'s session')
})

test('the run\'s end sentences are German in German', () => {
  const bundle = JSON.parse(fs.readFileSync(path.join(ROOT, 'l10n', 'bundle.l10n.de.json'), 'utf8')) as Record<string, string>
  try {
    setBundle(bundle)
    setLocale('de')
    const texts = (build: (agg: Aggregator) => void, now = NOW): NodeDetails => {
      const agg = new Aggregator()
      build(agg)
      return runOf(agg, now).details
    }
    const at = clock(NOW - 5 * MIN)
    const ended = (status: string): NodeDetails => texts((agg) => {
      launchRun(agg, 'toolu_wf1', NOW - 20 * MIN)
      notify(agg, 'toolu_wf1', NOW - 5 * MIN, status)
    })
    assert.equal(ended('completed').stateText, `Fertig — der Elternprozess hat das Ende dieses Laufs um ${at} aufgezeichnet.`)
    assert.equal(ended('failed').stateText, `Fehlgeschlagen — der Elternprozess hat den Fehlschlag dieses Laufs um ${at} aufgezeichnet.`)
    assert.equal(ended('killed').stateText, `Gestoppt — der Elternprozess hat für diesen Lauf ‚killed‘ um ${at} aufgezeichnet.`)
    const launched = texts((agg) => launchRun(agg, 'toolu_wf1', NOW - 2 * MIN))
    assert.equal(launched.stateText, 'Läuft — abgeleitet: Der Elternprozess hat diesen Lauf vor 2 min gestartet, und noch kein Agent hat geschrieben.')
    const lost = texts((agg) => launchRun(agg, 'toolu_wf1', NOW - 20 * MIN))
    assert.equal(lost.stateText,
      `Unbekannt — abgeleitet: Der Elternprozess hat diesen Lauf um ${clock(NOW - 20 * MIN)} gestartet, aber keiner seiner Agenten wurde je gesehen.`)
    const revived = texts((agg) => {
      launchRun(agg, 'toolu_wf1', NOW - 20 * MIN)
      agentLine(agg, A1, 1, NOW - 19 * MIN)
      journal(agg, 'started', A1, NOW - 19 * MIN)
      notify(agg, 'toolu_wf1', NOW - 5 * MIN, 'completed')
      agentLine(agg, A1, 2, NOW - 1 * MIN)
    })
    assert.equal(revived.stateText,
      `Läuft — abgeleitet: Ein Agent dieses Laufs schrieb weiter, nachdem der Elternprozess um ${at} das Ende des Laufs aufgezeichnet hatte.`)
    const resumed = texts((agg) => {
      launchRun(agg, 'toolu_wf1', NOW - 40 * MIN)
      launchRun(agg, 'toolu_wf2', NOW - 20 * MIN, { resume: RUN })
      launchRun(agg, 'toolu_wf3', NOW - 10 * MIN, { resume: RUN })
    })
    assert.equal(row(resumed, 'Starts'), '3 — 2-mal fortgesetzt')
    const unknown = texts((agg) => {
      agentLine(agg, A1, 1, NOW - 40 * MIN)
      journal(agg, 'started', A1, NOW - 40 * MIN)
    })
    assert.equal(unknown.stateText, 'Unbekannt — abgeleitet: Nicht für jeden Agenten dieses Laufs ist ein Ausgang aufgezeichnet, und keiner läuft.')
  } finally {
    setBundle(undefined)
    setLocale(undefined)
  }
})

// ---------------------------------------------------------------------------
// Kept, pruned, restored, replayed
// ---------------------------------------------------------------------------

test('run launches survive a snapshot round trip, and a hand-edited one keeps only what this build writes', () => {
  const agg = new Aggregator()
  launchRun(agg, 'toolu_wf1', NOW - 20 * MIN)
  notify(agg, 'toolu_wf1', NOW - 5 * MIN, 'killed')
  launchRun(agg, 'toolu_wf2', NOW - 4 * MIN, { resume: RUN })
  const snap = JSON.parse(JSON.stringify(agg.toSnapshot())) as Snapshot
  assert.deepEqual(Object.keys(snap.runLaunches ?? {}).sort(), ['toolu_wf1', 'toolu_wf2'])
  const back = Aggregator.fromSnapshot(snap)
  assert.deepEqual(JSON.parse(JSON.stringify(back.toSnapshot())), snap)
  // The notification of the restored launch still finds it.
  assert.equal(notify(back, 'toolu_wf2', NOW - 1 * MIN, 'completed'), true)
  assert.equal(launchOf(back, 'toolu_wf2').outcome, 'completed')

  const raw = snap as unknown as { runLaunches: Record<string, Record<string, unknown>> }
  raw.runLaunches.toolu_wf1.summary = 'EDITED-SECRET'
  raw.runLaunches.toolu_wf1.script = 'EDITED-SECRET'
  raw.runLaunches.toolu_wf2.runId = 'EDITED SECRET'
  raw.runLaunches.toolu_wf3 = { toolUseId: 'toolu_wf3', file: MAIN, ts: NOW, runId: RUN, outcome: 'stopped', outcomeStatus: null, outcomeTs: NOW }
  raw.runLaunches.toolu_wf4 = { toolUseId: '<b>x</b>', file: MAIN, ts: NOW, runId: RUN, outcome: 'completed' }
  raw.runLaunches.junk = 5 as unknown as Record<string, unknown>
  const edited = Aggregator.fromSnapshot(snap)
  const json = JSON.stringify(edited.toSnapshot())
  assert.equal(json.includes('EDITED'), false)
  assert.deepEqual(edited.runLaunches().map((l) => l.toolUseId).sort(), ['toolu_wf1', 'toolu_wf2', 'toolu_wf3'])
  assert.equal(launchOf(edited, 'toolu_wf2').runId, null, 'a run id outside the allow-list is none')
  // A stop without its word is no outcome, and takes its time along.
  assert.deepEqual([launchOf(edited, 'toolu_wf3').outcome, launchOf(edited, 'toolu_wf3').outcomeTs], [null, null])
  assert.deepEqual([launchOf(edited, 'toolu_wf1').outcome, launchOf(edited, 'toolu_wf1').outcomeStatus], ['stopped', 'killed'])
})

test('the roll-up keeps a run launch for seven days after its launch or its end', () => {
  const now = NOW
  const old = now - (AGENT_RETENTION_DAYS + 1) * DAY
  const agg = new Aggregator()
  launchRun(agg, 'toolu_old', old)
  launchRun(agg, 'toolu_late', old)
  notify(agg, 'toolu_late', now - DAY, 'completed')
  launchRun(agg, 'toolu_new', now - DAY)
  agg.rollup(now, 45, 400, utc)
  assert.deepEqual(agg.runLaunches().map((l) => l.toolUseId).sort(), ['toolu_late', 'toolu_new'])
  const once = JSON.stringify(agg.toSnapshot().runLaunches)
  agg.rollup(now, 45, 400, utc)
  assert.equal(JSON.stringify(agg.toSnapshot().runLaunches), once)
})

/** A Claude home with one session that launched a run, its agent and its journal, configured as the root. */
function runHome(prefix: string, secret: string): { main: string; journal: string; agent: string } {
  const home = tmpDir(prefix)
  const dir = path.join(home, 'projects', CLAUDE_SLUG, SESSION, 'subagents', 'workflows', RUN)
  configureRoots([home], [path.join(home, 'codex')])
  const main = path.join(home, 'projects', CLAUDE_SLUG, `${SESSION}.jsonl`)
  const agent = path.join(dir, `agent-${A1.slice(1)}.jsonl`)
  const journalFile = path.join(dir, 'journal.jsonl')
  fs.mkdirSync(dir, { recursive: true })
  const lines = (file: string, ls: string[]): void => fs.writeFileSync(file, ls.map((l) => `${l}\n`).join(''))
  lines(main, [
    claudeLine({ id: 'm0', ts: NOW - 30 * MIN, sessionId: SESSION, usage: { input: 10 }, final: true }),
    workflowToolUseLine({ id: 'm1', ts: NOW - 25 * MIN, toolUseId: 'toolu_wf1', script: `${secret}-script` }),
    workflowResultLine({ ts: NOW - 25 * MIN + 1000, toolUseId: 'toolu_wf1', runId: RUN, summary: `${secret}-summary` }),
    queueOperationLine({ ts: NOW - 20 * MIN, toolUseId: 'toolu_wf1', status: 'stopped', summary: `${secret}-note` }),
    workflowToolUseLine({ id: 'm2', ts: NOW - 15 * MIN, toolUseId: 'toolu_wf2', script: `${secret}-resume`, resumeFromRunId: RUN }),
    workflowResultLine({ ts: NOW - 15 * MIN + 1000, toolUseId: 'toolu_wf2', runId: RUN, summary: `${secret}-summary-2` }),
    queueOperationLine({ ts: NOW - 5 * MIN, toolUseId: 'toolu_wf2', status: 'completed', summary: `${secret}-note-2` }),
  ])
  lines(agent, [claudeLine({ id: 'w1', ts: NOW - 14 * MIN, agentId: A1.slice(1), usage: { input: 5 }, final: true })])
  lines(journalFile, [journalLine({ type: 'started', agentId: A1.slice(1), label: `${secret}-label` }),
    journalLine({ type: 'result', agentId: A1.slice(1), result: { summary: `${secret}-result` } })])
  return { main, journal: journalFile, agent }
}

test('the replay the revision asks for finds the run launches in the transcripts again', async () => {
  // 2: the run launches (1.6 N4) are a table only a replay can fill for what was already read. (A
  // later package raises the revision again — 3 for the rejected requests, P5a — and pins its own.)
  assert.ok(AGENT_TABLES_REVISION >= 2, String(AGENT_TABLES_REVISION))
  runHome('runs-replay', 'RUN-REPLAY')
  const agg = new Aggregator()
  await scan(agg)
  const live = JSON.stringify(agg.toSnapshot().runLaunches)
  assert.deepEqual(agg.runLaunches().map((l) => [l.toolUseId, l.runId, l.outcome, l.outcomeStatus]),
    [['toolu_wf1', RUN, 'stopped', 'stopped'], ['toolu_wf2', RUN, 'completed', 'completed']])
  // A snapshot of the revision before (1.6 P2b–P3b wrote no run launches) asks for the replay…
  const before = JSON.parse(JSON.stringify(agg.toSnapshot())) as Snapshot
  delete before.runLaunches
  before.agentsRevision = 1
  const restored = Aggregator.fromSnapshot(before)
  assert.equal(restored.runLaunches().length, 0)
  assert.notEqual(restored.agentsRevision, AGENT_TABLES_REVISION, 'the host replays')
  // …which rebuilds them as the live read made them, and again the same.
  await replayAgents(restored, agentReplayFiles(restored, NOW))
  assert.equal(JSON.stringify(restored.toSnapshot().runLaunches), live)
  await replayAgents(restored, agentReplayFiles(restored, NOW))
  assert.equal(JSON.stringify(restored.toSnapshot().runLaunches), live)
  assert.equal(runOf(restored).details.stateText, `Completed — the parent recorded the end of this run at ${clock(NOW - 5 * MIN)}.`)
})

// ---------------------------------------------------------------------------
// §0a.3: the leak test
// ---------------------------------------------------------------------------

test('a Workflow call\'s input and its result\'s summary, paths and names never leave the reader', async () => {
  const secret = 'WORKFLOW-CONTENT-4b19'
  const home = runHome('runs-leak', secret)
  const agg0 = new Aggregator()
  await scan(agg0)
  // A restart — a snapshot round trip — and a replay over everything.
  const agg = Aggregator.fromSnapshot(JSON.parse(JSON.stringify(agg0.toSnapshot())) as Snapshot)
  await replayAgents(agg, agentReplayFiles(agg, NOW))
  // Only a test of anything if the lines went through, and carry what they must not give away.
  assert.equal(agg.runLaunches().length, 2)
  const raw = fs.readFileSync(home.main, 'utf8')
  for (const s of [`${secret}-script`, `${secret}-summary`, 'synthetic workflow args', 'synthetic workflow description',
    '/tmp/synthetic/workflows/', '/tmp/synthetic/transcripts/', 'synthetic-workflow-name', 'local_workflow', 'b9c8d7e6f']) {
    assert.ok(raw.includes(s), `the fixture lost ${s}`)
  }

  const cfg = makeConfig()
  const outputs: Array<[string, string]> = [['snapshot', JSON.stringify(agg.toSnapshot())]]
  const agentsExpanded = everyParent(agg, cfg, NOW)
  const vm = buildViewModel(makeInput({ agg, cfg, ui: { agentsExpanded } }))
  const keys = nodes(vm.agents.roots).map((n) => n.key)
  assert.ok(keys.includes(RUN_KEY), keys.join(', '))
  for (const key of keys) {
    const input = makeInput({ agg, cfg, ui: { agentsExpanded, agentSelected: key } })
    const open = buildViewModel(input)
    outputs.push([`view model ${key}`, JSON.stringify(open)], [`markdown ${key}`, markdownDocument(open, agentTreeFor(input, 'text'))])
  }
  const range = { from: '2026-09-01', to: '2026-09-03' }
  outputs.push(['json export', toJson(agg, range, cfg, utc)], ['csv export', toCsv(agg, range, cfg, utc)],
    ['tools export', toolsCsv(agg, range)])
  const never = [secret, 'synthetic workflow args', 'synthetic workflow description', '/tmp/synthetic',
    'synthetic-workflow-name', 'local_workflow', 'b9c8d7e6f', 'synthetic workflow answer']
  for (const [what, text] of outputs) {
    for (const s of never) assert.equal(text.includes(s), false, `${what} holds ${s}`)
  }
  // The stored state has no field of those names at all.
  assert.equal(/"(script|scriptPath|summary|transcriptDir|workflowName|taskId|taskType|args|resumeFromRunId)"/.test(outputs[0][1]), false,
    'the snapshot holds a field of the call or its result')
})
