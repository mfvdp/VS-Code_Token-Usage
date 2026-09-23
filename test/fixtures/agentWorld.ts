// SPDX-FileCopyrightText: 2026 Frederik Marx
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * A world for the Agents section, written line by line through the agent builders of
 * `helpers.ts` into the real aggregator, in the order a live tail reads it, every sidecar
 * through the aggregator's own parser — so the records the tree is built from are the records
 * the extension would hold, not hand-made ones. On `viewFixtures`' clock (NOW = 12:00 UTC):
 *
 *   Session 3f9a2c1d — active: its transcript changed a minute ago
 *     Explore · haiku           done, with the parent's report; its last reply unfinished
 *       Plan · sonnet           depth 2, launched from the Explore agent's own transcript: done
 *     Agent · sonnet            launched in the background, no sidecar, silent since 11:38: unknown
 *     Explore · sonnet          launched in the background, stopped: a task notification says `killed`
 *     Workflow cfe7718d         running — launched by a `Workflow` call whose result names the run, no end recorded yet
 *       workflow-subagent       done — the workflow journal recorded it, at no time of its own
 *       workflow-subagent       failed — a task notification recorded it, after the API rejected its last
 *                               request on the 5-hour limit (1.6 N3)
 *       workflow-subagent       failed, retried — the journal recorded the failure and started its step again
 *       workflow-subagent       done — that retry, completed by the journal
 *       workflow-subagent       stopped, replaced — the journal started its step again before it recorded anything
 *       workflow-subagent       running — its transcript changed 25 s ago; the attempt that replaced the one above
 *     Plan · sonnet · launched  a background launch two minutes ago, no transcript yet
 *   Session 8e1d4b7a — idle since 09:20
 *     claude-code-guide         done in 48 s, its last reply finished
 *
 * Every launch, result, notification, journal line and sidecar carries the description,
 * prompt, summary, answer and output path the builders write (`AGENT_CONTENT`) — a journal line
 * its key, label, phase and result too, the `Workflow` call its script and the result that
 * answers it its summary, paths and names, the rejected request the error's text and the quota block
 * beside its limit — which is content no view may hold. Nearly every agent
 * transcript ends on a line whose reply was never marked finished, as Claude Code's do, so nearly
 * every agent's output is a lower bound.
 */

import * as path from 'path'
import { Aggregator, parseAgentMeta } from '../../src/agg'
import type { TreeNode } from '../../src/agentTree'
import type { Config } from '../../src/config'
import { Attribution } from '../../src/types'
import { agentTreeFor, defaultUiState } from '../../src/viewModel'
import {
  CLAUDE_ROOT, ClaudeUsage, agentResultLine, agentToolUseLine, apiErrorLine, claudeLine, ctxFor, journalKey, journalLine, metaJson,
  queueOperationLine, workflowResultLine, workflowToolUseLine,
} from './helpers'

/**
 * Invented ids in Claude Code's shapes: a session's label shows eight characters, an agent's its
 * short id — four characters, since no two agents of a session here share their first four, and
 * without the leading `a` of an id in Claude Code's own `a` + 16 hex shape (the explore agent's).
 */
export const AGENT_WORLD = {
  session: '3f9a2c1d-7b4e-4c8a-9e21-5d6f7a8b9c0d',
  quiet: '8e1d4b7a-2c3f-4a5b-8c6d-7e8f9a0b1c2d',
  workflow: 'wf_cfe7718d-3c2a-4f00',
  explore: 'a94f3c2e10b7d5e19',
  plan: 'b1c24e6f8a0d3b5c7',
  silent: 'c3d45f7a9b1e2c4d6',
  // 1.6 D7: a stop the parent recorded — not a failure.
  stopped: '2c3d4e5f6a7b8c9d0',
  wfDone: 'd4e56a8b0c2f4e6a8',
  wfFailed: 'e5f67b9c1d3a5f7b9',
  wfRunning: 'f6a78c0d2e4b6a8c0',
  // 1.6 D2, D7: a failure the journal retried, the retry, and an attempt it replaced.
  wfRetryFail: '7a8b9c0d1e2f3a4b5',
  wfRetry: '8b9c0d1e2f3a4b5c6',
  wfReplaced: '9c0d1e2f3a4b5c6d7',
  pending: '0a1b2c3d4e5f6a7b8',
  guide: '1b2c3d4e5f6a7b8c9',
} as const

/** The steps of the world's run: each journal line carries the key of one of them. */
const STEPS = ['done', 'retry', 'run'] as const

/**
 * The content the builders put into the world's lines and sidecars. The world is only worth
 * testing against if it really carries every one of them — `agentWorld` returns its raw text
 * so a test can say so. The journal's keys are content too: they are compared, never kept.
 */
export const AGENT_CONTENT = [
  'synthetic launch description', 'synthetic launch prompt', 'synthetic result description',
  'synthetic result prompt', 'synthetic agent answer', 'synthetic summary', '/tmp/synthetic/tasks',
  'synthetic journal summary', 'synthetic journal label', 'synthetic journal phase', 'synthetic meta description',
  'synthetic meta prompt', ...STEPS.map((step) => journalKey(step)),
  // 1.6 N4: the `Workflow` call's input and the result that answers it.
  'synthetic workflow script', 'synthetic workflow args', 'synthetic workflow description', 'synthetic workflow summary',
  'synthetic workflow answer', 'synthetic-workflow-name', '/tmp/synthetic/workflows', '/tmp/synthetic/transcripts',
  // 1.6 N3: a rejected request's text, its details and what its quota block holds beside the limit.
  'synthetic API error text', 'synthetic API error details', 'synthetic upgrade path', 'synthetic overage reason',
  'synthetic-overage-status',
]

const SLUG = path.join(CLAUDE_ROOT, '-home-t-alpha')
const MAIN = path.join(SLUG, `${AGENT_WORLD.session}.jsonl`)
const QUIET = path.join(SLUG, `${AGENT_WORLD.quiet}.jsonl`)
const WF_DIR = path.join(SLUG, AGENT_WORLD.session, 'subagents', 'workflows', AGENT_WORLD.workflow)

/** The short id an agent's name ends with (1.6 D11), for the ids of this world. */
export function shortIdOf(id: string): string {
  return (/^a[0-9a-f]{16}$/.test(id) ? id.slice(1) : id).slice(0, 4)
}

/** Where an agent's transcript lies: under its session's `subagents`, a run's one level deeper. */
export function agentWorldFile(id: string): string {
  const W = AGENT_WORLD
  if ([W.wfDone, W.wfFailed, W.wfRunning, W.wfRetryFail, W.wfRetry, W.wfReplaced].includes(id as typeof W.wfDone)) {
    return path.join(WF_DIR, `agent-${id}.jsonl`)
  }
  const session = id === AGENT_WORLD.guide ? AGENT_WORLD.quiet : AGENT_WORLD.session
  return path.join(SLUG, session, 'subagents', `agent-${id}.jsonl`)
}

/** 2026-09-03 at a clock time, UTC — the day of viewFixtures' NOW. */
const at = (h: number, m: number, s = 0): number => Date.UTC(2026, 8, 3, h, m, s)

const TU = {
  explore: 'toolu_01XkP4mQ7rT2vW9yB3nC6dF8',
  plan: 'toolu_01Hc5jL8pS1uV4xZ7aD0eG3k',
  silent: 'toolu_01Mw2qR5tY8bE1hK4nP7sU0x',
  stopped: 'toolu_01Sk8vN2qW5zA8dG1jM4pT7y',
  wfFailed: 'toolu_01Ga6kN9qT2wZ5cF8jM1pS4v',
  pending: 'toolu_01Rb3fJ6mV9yC2gL5oR8uX1a',
  guide: 'toolu_01Ld7hP0sW3zD6iM9qT2xB5e',
  // 1.6 N4: the `Workflow` call that launched the run.
  workflow: 'toolu_01Wf4kR7nT0wC3fJ6mP9sV2y',
} as const

/**
 * The world above, read with `attribution` as the extension would read it (with 'none' no
 * session table is kept), and every raw line and sidecar it was read from.
 */
export function agentWorld(attribution: Attribution = 'none'): { agg: Aggregator; raw: string } {
  const agg = new Aggregator()
  agg.attribution = attribution
  const raw: string[] = []
  const isSub = (file: string): boolean => file.split(path.sep).includes('subagents')
  const ctx = (file: string) => ctxFor({ file, isSub: isSub(file), attribution })
  const read = (file: string, line: string): void => {
    raw.push(line)
    agg.addClaudeLine(line, ctx(file))
  }
  const turn = (file: string, id: string, ts: number, model: string, usage: ClaudeUsage,
    o: { final?: boolean; tools?: string[]; agentId?: string } = {}): void => {
    const session = file.startsWith(path.join(SLUG, AGENT_WORLD.quiet)) ? AGENT_WORLD.quiet : AGENT_WORLD.session
    read(file, claudeLine({
      id, ts, model, usage, final: o.final ?? true, agentId: o.agentId, sessionId: session, cwd: '/home/t/alpha',
      tools: o.tools ? o.tools.map((name) => ({ name })) : undefined,
    }))
  }
  /** The scanner reads a sidecar right after the agent's first counted line; null is none on disk. */
  const sidecar = (id: string, meta: Parameters<typeof metaJson>[0] | null): void => {
    const text = meta === null ? '' : metaJson({ description: 'synthetic meta description', prompt: 'synthetic meta prompt', ...meta })
    raw.push(text)
    agg.setAgentMeta(agentWorldFile(id), text === '' ? null : parseAgentMeta(text))
  }
  /**
   * A journal line, and the journal's mtime after it — the time a scan hands over, as the lines
   * carry none of their own.
   */
  const journal = (type: 'started' | 'result' | 'failed', agentId: string, step: typeof STEPS[number], ts: number): void => {
    const line = journalLine({ type, agentId, step })
    raw.push(line)
    const file = path.join(WF_DIR, 'journal.jsonl')
    agg.addWorkflowJournalLine(line, ctx(file))
    agg.noteJournalRead(file, ts)
  }
  const W = AGENT_WORLD
  const f = agentWorldFile
  const OPUS = 'claude-opus-4-6'
  const SONNET = 'claude-sonnet-4-6'
  const HAIKU = 'claude-haiku-4-5'

  // The quiet session, this morning: one quick agent that finished its last reply.
  turn(QUIET, 'q-1', at(8, 50), OPUS, { input: 1900, cacheWrite: 13000, output: 640 })
  read(QUIET, agentToolUseLine({ id: 'q-2', ts: at(8, 52), toolUseId: TU.guide, subagentType: 'claude-code-guide', model: 'haiku' }))
  turn(f(W.guide), 'g-1', at(8, 52, 5), HAIKU, { input: 6, cacheWrite: 8100, output: 350 }, { agentId: W.guide, tools: ['WebFetch'] })
  sidecar(W.guide, { agentType: 'claude-code-guide', model: 'haiku', spawnDepth: 1, toolUseId: TU.guide })
  turn(f(W.guide), 'g-2', at(8, 52, 53), HAIKU, { input: 3, cacheWrite: 1300, cacheRead: 8100, output: 720 }, { agentId: W.guide })
  read(QUIET, agentResultLine({ ts: at(8, 53), toolUseId: TU.guide, agentId: W.guide, totals: { tokens: 18_900, durationMs: 51_000, toolUses: 1 } }))
  turn(QUIET, 'q-3', at(9, 20), OPUS, { input: 25, cacheWrite: 900, cacheRead: 14700, output: 350 })

  // The busy session.
  turn(MAIN, 'm-1', at(11, 10), OPUS, { input: 2400, cacheWrite: 16000, output: 820, thinking: 240 })
  read(MAIN, agentToolUseLine({ id: 'm-2', ts: at(11, 12), toolUseId: TU.explore, subagentType: 'Explore', model: 'haiku' }))
  turn(f(W.explore), 'x-1', at(11, 12, 5), HAIKU, { input: 6, cacheWrite: 9200, output: 420 }, { agentId: W.explore, tools: ['Read'] })
  sidecar(W.explore, { agentType: 'Explore', model: 'haiku', spawnDepth: 1, toolUseId: TU.explore })
  // The nested launch sits in the Explore agent's own transcript, on a line of its own model —
  // the block `agentToolUseLine` writes, which dates its line to the main session's model.
  read(f(W.explore), claudeLine({
    id: 'x-2', ts: at(11, 14), model: HAIKU, final: true, stopReason: 'tool_use', agentId: W.explore,
    sessionId: AGENT_WORLD.session, cwd: '/home/t/alpha', usage: { input: 4, cacheWrite: 1800, cacheRead: 9200, output: 610 },
    content: [{
      type: 'tool_use', id: TU.plan, name: 'Agent', caller: { type: 'direct' },
      input: { description: 'synthetic launch description', subagent_type: 'Plan', model: 'sonnet', prompt: 'synthetic launch prompt' },
    }],
  }))
  turn(f(W.plan), 'p-1', at(11, 14, 10), SONNET, { input: 8, cacheWrite: 7400, output: 510 }, { agentId: W.plan, tools: ['Read'] })
  sidecar(W.plan, { agentType: 'Plan', model: 'sonnet', spawnDepth: 2, toolUseId: TU.plan })
  turn(f(W.plan), 'p-2', at(11, 19, 40), SONNET, { input: 2, cacheWrite: 1500, cacheRead: 9500, output: 1320 }, { agentId: W.plan, final: false })
  read(f(W.explore), agentResultLine({
    ts: at(11, 19, 45), toolUseId: TU.plan, agentId: W.plan, inAgent: W.explore,
    totals: { tokens: 38_200, durationMs: 575_000, toolUses: 2 },
  }))
  turn(f(W.explore), 'x-3', at(11, 24, 30), HAIKU, { input: 3, cacheWrite: 900, cacheRead: 13400, output: 1250 }, { agentId: W.explore, final: false })
  read(MAIN, agentResultLine({ ts: at(11, 24, 40), toolUseId: TU.explore, agentId: W.explore, totals: { tokens: 98_400, durationMs: 755_000, toolUses: 4 } }))
  // In the background, with no type, no model and — an older build — no sidecar.
  read(MAIN, agentToolUseLine({ id: 'm-3', ts: at(11, 26), toolUseId: TU.silent, model: null, background: true }))
  read(MAIN, agentResultLine({ ts: at(11, 26, 1), toolUseId: TU.silent, agentId: W.silent, status: 'async_launched' }))
  turn(f(W.silent), 's-1', at(11, 26, 5), SONNET, { input: 7, cacheWrite: 8800, output: 460 }, { agentId: W.silent, tools: ['Bash'] })
  sidecar(W.silent, null)
  turn(f(W.silent), 's-2', at(11, 38, 20), SONNET, { input: 2, cacheWrite: 700, cacheRead: 10400, output: 890 }, { agentId: W.silent, final: false })
  // Another background agent, halted: its parent's task notification says `killed` — a stop,
  // recorded, and no failure (1.6 D7). Its transcript ends mid-reply, before the notification.
  read(MAIN, agentToolUseLine({ id: 'm-3s', ts: at(11, 30), toolUseId: TU.stopped, subagentType: 'Explore', model: 'sonnet', background: true }))
  read(MAIN, agentResultLine({ ts: at(11, 30, 1), toolUseId: TU.stopped, agentId: W.stopped, status: 'async_launched' }))
  turn(f(W.stopped), 'k-1', at(11, 30, 5), SONNET, { input: 6, cacheWrite: 7900, output: 380 }, { agentId: W.stopped, tools: ['Grep'] })
  sidecar(W.stopped, { agentType: 'Explore', model: 'sonnet', spawnDepth: 1, toolUseId: TU.stopped })
  turn(f(W.stopped), 'k-2', at(11, 33, 40), SONNET, { input: 3, cacheWrite: 900, cacheRead: 7900, output: 540 }, { agentId: W.stopped, final: false })
  read(MAIN, queueOperationLine({ ts: at(11, 34), toolUseId: TU.stopped, status: 'killed' }))
  // The workflow run: a tool call that launches no agent but the run (1.6 N4) — its result names
  // the run's directory, in the background, and no end has been recorded for it yet — and the
  // agents in the run's directory.
  read(MAIN, workflowToolUseLine({
    id: 'm-4', ts: at(11, 40), toolUseId: TU.workflow, usage: { input: 20, cacheWrite: 1900, cacheRead: 19700, output: 310 },
  }))
  read(MAIN, workflowResultLine({ ts: at(11, 40, 1), toolUseId: TU.workflow, runId: W.workflow }))
  turn(f(W.wfDone), 'wd-1', at(11, 40, 10), OPUS, { input: 9, cacheWrite: 11200, output: 700 }, { agentId: W.wfDone, tools: ['Read'] })
  sidecar(W.wfDone, { agentType: 'workflow-subagent', model: 'opus', spawnDepth: 1, toolUseId: null })
  journal('started', W.wfDone, 'done', at(11, 40, 11))
  // The journal records no failure: a run's agent can only fail through a launch its sidecar names.
  read(MAIN, agentToolUseLine({ id: 'm-5', ts: at(11, 40, 30), toolUseId: TU.wfFailed, subagentType: 'workflow-subagent', model: 'opus', background: true }))
  read(MAIN, agentResultLine({ ts: at(11, 40, 31), toolUseId: TU.wfFailed, agentId: W.wfFailed, status: 'async_launched' }))
  turn(f(W.wfFailed), 'wf-1', at(11, 40, 40), OPUS, { input: 9, cacheWrite: 10400, output: 640 }, { agentId: W.wfFailed, tools: ['Read'] })
  sidecar(W.wfFailed, { agentType: 'workflow-subagent', model: 'opus', spawnDepth: 1, toolUseId: TU.wfFailed })
  // A step that failed and was started again: the journal records the failure, then a second
  // attempt of the same step (the same key), which it completes.
  turn(f(W.wfRetryFail), 'rf-1', at(11, 41), OPUS, { input: 7, cacheWrite: 9800, output: 520 }, { agentId: W.wfRetryFail, tools: ['Read'] })
  sidecar(W.wfRetryFail, { agentType: 'workflow-subagent', model: 'opus', spawnDepth: 1, toolUseId: null })
  journal('started', W.wfRetryFail, 'retry', at(11, 41, 1))
  turn(f(W.wfRetryFail), 'rf-2', at(11, 43), OPUS, { input: 2, cacheWrite: 600, cacheRead: 9800, output: 330 }, { agentId: W.wfRetryFail, final: false })
  journal('failed', W.wfRetryFail, 'retry', at(11, 43, 10))
  turn(f(W.wfRetry), 'ry-1', at(11, 43, 20), OPUS, { input: 8, cacheWrite: 10100, output: 580 }, { agentId: W.wfRetry, tools: ['Read'] })
  sidecar(W.wfRetry, { agentType: 'workflow-subagent', model: 'opus', spawnDepth: 1, toolUseId: null })
  journal('started', W.wfRetry, 'retry', at(11, 43, 21))
  turn(f(W.wfRetry), 'ry-2', at(11, 45), OPUS, { input: 2, cacheWrite: 700, cacheRead: 10100, output: 910 }, { agentId: W.wfRetry, final: false })
  journal('result', W.wfRetry, 'retry', at(11, 45, 10))
  turn(f(W.wfDone), 'wd-2', at(11, 47, 30), OPUS, { input: 3, cacheWrite: 1200, cacheRead: 14500, output: 2100 }, { agentId: W.wfDone, final: false })
  journal('result', W.wfDone, 'done', at(11, 47, 40))
  turn(f(W.wfFailed), 'wf-2', at(11, 49, 50), OPUS, { input: 2, cacheWrite: 800, cacheRead: 12600, output: 410 }, { agentId: W.wfFailed, final: false })
  // 1.6 N3: its next request is rejected on the 5-hour limit — the line Claude Code writes for it,
  // the error's text and the quota block's other values fixture text — and then the parent
  // records the failure.
  read(f(W.wfFailed), apiErrorLine({
    id: 'wf-err', ts: at(11, 50), agentId: W.wfFailed, errorDetails: 'synthetic API error details',
    upgradePaths: ['synthetic upgrade path'],
  }))
  read(MAIN, queueOperationLine({ ts: at(11, 50, 5), toolUseId: TU.wfFailed, status: 'failed' }))
  // An attempt the journal replaced: its step is started again before it recorded anything, by
  // the agent that is running now.
  turn(f(W.wfReplaced), 'rp-1', at(11, 50, 30), OPUS, { input: 6, cacheWrite: 9400, output: 450 }, { agentId: W.wfReplaced, tools: ['Grep'] })
  sidecar(W.wfReplaced, { agentType: 'workflow-subagent', model: 'opus', spawnDepth: 1, toolUseId: null })
  journal('started', W.wfReplaced, 'run', at(11, 50, 31))
  turn(f(W.wfReplaced), 'rp-2', at(11, 51, 10), OPUS, { input: 2, cacheWrite: 500, cacheRead: 9400, output: 280 }, { agentId: W.wfReplaced, final: false })
  turn(f(W.wfRunning), 'wr-1', at(11, 52), OPUS, { input: 8, cacheWrite: 12100, output: 760 }, { agentId: W.wfRunning, tools: ['Read'] })
  sidecar(W.wfRunning, { agentType: 'workflow-subagent', model: 'opus', spawnDepth: 1, toolUseId: null })
  journal('started', W.wfRunning, 'run', at(11, 52, 1))
  // A launch whose agent has not written a line yet.
  read(MAIN, agentToolUseLine({ id: 'm-6', ts: at(11, 58), toolUseId: TU.pending, subagentType: 'Plan', model: 'sonnet', background: true }))
  read(MAIN, agentResultLine({ ts: at(11, 58, 1), toolUseId: TU.pending, agentId: W.pending, status: 'async_launched' }))
  turn(MAIN, 'm-7', at(11, 59), OPUS, { input: 40, cacheWrite: 1400, cacheRead: 21600, output: 260 })
  turn(f(W.wfRunning), 'wr-2', at(11, 59, 35), OPUS, { input: 3, cacheWrite: 1100, cacheRead: 15000, output: 380 }, { agentId: W.wfRunning, final: false })
  return { agg, raw: raw.join('\n') }
}

/** Every node of a tree, depth first. */
export function treeNodes(roots: readonly TreeNode[]): TreeNode[] {
  return roots.flatMap((n) => [n, ...treeNodes(n.children)])
}

/**
 * The key of every node that has children — what a reader who opened them all keeps in
 * `ui.agentsExpanded`. Since 1.6 (D3) the page carries a node's children only while it is open,
 * so a test that looks at every node of the page opens them all first. Read off the markdown's
 * tree, which opens every node; `now` is the clock the view model is built on.
 */
export function everyParent(agg: Aggregator, cfg: Config, now: number): string[] {
  const text = agentTreeFor({ agg, cfg, ui: defaultUiState(cfg), now }, 'text')
  return treeNodes(text.roots).filter((n) => n.hasChildren).map((n) => n.key)
}

/** The node of an agent by its id, found by the four characters its label ends on. */
export function agentNode(roots: readonly TreeNode[], id: string): TreeNode {
  const hit = treeNodes(roots).filter((n) => n.kind === 'agent' && n.label.endsWith(` · ${shortIdOf(id)}`))
  if (hit.length !== 1) throw new Error(`agentWorld: ${hit.length} nodes for agent ${id}`)
  return hit[0]
}
