// SPDX-FileCopyrightText: 2026 Frederik Marx
// SPDX-License-Identifier: AGPL-3.0-or-later

import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { Aggregator } from '../src/agg'
import { AGENT_RETENTION_DAYS } from '../src/agentTree'
import {
  AGENTS_CSV_COLUMNS, AGENTS_FILE_SUFFIX, CSV_COLUMNS, EXPORT_SCHEMA_VERSION, TOOLS_CSV_COLUMNS, TOOLS_FILE_SUFFIX, agentRows,
  agentsCsv, companionPath, toCsv, toJson, toMarkdownSummary, toolsCsv,
} from '../src/exporter'
import { agentTreeFor, buildViewModel } from '../src/viewModel'
import { AGENT_WORLD, agentNode, agentWorld, treeNodes } from './fixtures/agentWorld'
import {
  FINGERPRINT, NOW, TODAY, buildAgg, fillHistory, makeConfig, makeHistory, makeInput, state, timeConfig, win,
} from './fixtures/viewFixtures'
import { markdownDocument } from '../src/textViews'
import { toolAgg } from './helpers/toolAgg'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { setBundle, setLang, setLocale } from '../src/i18n'
import { SOURCES } from '../src/adapters'
import { OPUS_5_5_CHECKED, PRICES_AS_OF, PRICES_CHECKED_LATER, PRICE_SOURCE_PAGES } from '../src/prices'
import { Bucket, emptyBucket } from '../src/types'

const cfg = makeConfig()
const tcfg = timeConfig(cfg)
const range = { from: '2026-08-25', to: TODAY, label: 'Last 10 days', preset: 'custom' }

function csvRows(text: string): string[][] {
  return text.trim().split('\n').map((l) => l.split(','))
}

test('the CSV header is the documented column list', () => {
  const rows = csvRows(toCsv(buildAgg(), range, cfg, tcfg))
  assert.deepEqual(rows[0], [...CSV_COLUMNS])
  // 1.11 P5 (rewritten: 18 → 21 columns, §3 C4): the three price columns are appended after `priced`, so the
  // eighteen of schema 1–3 keep their positions.
  assert.equal(rows[0].length, 21)
  assert.deepEqual(rows[0].slice(0, 18), ['day', 'hour', 'source', 'model', 'isSub', 'tier', 'res', 'input', 'cacheWrite5m',
    'cacheWrite1h', 'cacheRead', 'output', 'reasoning', 'requests', 'outputFinal', 'webSearch', 'costUsd', 'priced'])
  assert.deepEqual(rows[0].slice(18), ['listCostUsd', 'priceFrom', 'priceApproximate'])
})

test('every row is one stored bucket, in calendar order', () => {
  const rows = csvRows(toCsv(buildAgg(), range, cfg, tcfg)).slice(1, -1)
  assert.ok(rows.length >= 5)
  const days = rows.map((r) => r[0])
  assert.deepEqual(days, [...days].sort())
  for (const r of rows) {
    assert.match(r[0], /^\d{4}-\d{2}-\d{2}$/)
    assert.ok(['claude', 'codex'].includes(r[2]))
    assert.ok(['h', 'd', 'm'].includes(r[6]))
  }
})

test('days without data produce no row — gaps stay gaps', () => {
  const days = new Set(csvRows(toCsv(buildAgg(), range, cfg, tcfg)).slice(1, -1).map((r) => r[0]))
  // The fixture is idle on 26 August; a zero row there would claim it measured nothing used.
  assert.equal(days.has('2026-08-26'), false)
  assert.equal(days.has('2026-08-28'), true)
})

test('the TOTAL row sums every counter and flags a partial cost', () => {
  const rows = csvRows(toCsv(buildAgg(), range, cfg, tcfg))
  const body = rows.slice(1, -1)
  const total = rows[rows.length - 1]
  assert.equal(total[0], 'TOTAL')
  for (const i of [1, 2, 3, 4, 5, 6]) assert.equal(total[i], '')
  const sumAt = (i: number): number => body.reduce((s, r) => s + Number(r[i]), 0)
  for (const i of [7, 8, 9, 10, 11, 12, 13, 14, 15]) assert.equal(Number(total[i]), sumAt(i))
  // The unpriced model makes the total a lower bound, and the column says so.
  assert.equal(total[17], 'lowerBound')
})

test('an unpriced bucket leaves the cost cell empty instead of writing zero', () => {
  const rows = csvRows(toCsv(buildAgg(), range, cfg, tcfg)).slice(1, -1)
  const unpriced = rows.find((r) => r[3] === 'claude-experimental-x')
  assert.ok(unpriced)
  assert.equal(unpriced?.[16], '')
  assert.equal(unpriced?.[17], 'none')
  const priced = rows.find((r) => r[3] === 'claude-opus-4-6')
  assert.match(String(priced?.[16]), /^\d+\.\d{6}$/)
  assert.equal(priced?.[17], 'exact')
})

test('hour buckets carry their UTC hour index and their day in the configured zone', () => {
  const rows = csvRows(toCsv(buildAgg(), range, cfg, tcfg)).slice(1, -1)
  for (const r of rows) {
    if (r[6] !== 'h') continue
    assert.match(r[1], /^\d+$/)
    // The hour index resolves back to the day the row claims.
    const hourMs = Number(r[1]) * 3_600_000
    assert.equal(new Date(hourMs).toISOString().slice(0, 10), r[0])
  }
})

test('an empty range exports a header and a TOTAL row, nothing else', () => {
  const text = toCsv(new Aggregator(), range, cfg, tcfg)
  const rows = csvRows(text)
  assert.equal(rows.length, 2)
  assert.equal(rows[1][0], 'TOTAL')
  assert.equal(rows[1][16], '0.000000')
  assert.equal(rows[1][17], '')
})

test('the JSON export states its schema, its range, its zone and its prices', () => {
  const j = JSON.parse(toJson(buildAgg(), range, cfg, tcfg))
  assert.equal(j.schema_version, EXPORT_SCHEMA_VERSION)
  assert.match(j.writer, /^token-pace\//)
  assert.deepEqual(j.range, { from: range.from, to: range.to, label: range.label, preset: 'custom' })
  assert.equal(j.timezone.zone, 'utc')
  assert.equal(j.timezone.start_of_week, 'monday')
  assert.match(j.pricing.as_of, /^\d{4}-\d{2}-\d{2}$/)
  assert.equal(j.pricing.custom, false)
  assert.equal(j.pricing.multiplier, 1)
  assert.ok(j.notes.length >= 3)
})

test('the JSON buckets mirror the CSV rows and null out what has no price', () => {
  const j = JSON.parse(toJson(buildAgg(), range, cfg, tcfg))
  const csv = csvRows(toCsv(buildAgg(), range, cfg, tcfg)).slice(1, -1)
  assert.equal(j.buckets.length, csv.length)
  const unpriced = j.buckets.find((b: { model: string }) => b.model === 'claude-experimental-x')
  assert.equal(unpriced.costUsd, null)
  assert.equal(unpriced.priced, 'none')
  assert.equal(j.totals.lowerBound, true)
  assert.ok(j.totals.unpricedTokens > 0)
  assert.equal(typeof j.totals.usage, 'number')
})

test('session rows are exported only with attribution on, and the notes say what is in them', () => {
  const off = JSON.parse(toJson(buildAgg(), range, cfg, tcfg))
  assert.equal(off.sessions, undefined)

  const onCfg = makeConfig({ 'tokenPace.attribution': 'project' })
  const on = JSON.parse(toJson(buildAgg('project'), range, onCfg, timeConfig(onCfg)))
  assert.ok(Array.isArray(on.sessions))
  assert.ok(on.sessions.length >= 1)
  assert.ok(on.sessions[0].project)
  assert.ok(on.notes.some((n: string) => n.includes('project labels as stored')))
  // Never the working directory itself — only the label the snapshot already holds.
  assert.equal(JSON.stringify(on).includes('/home/t/'), false)
})

test('a field with a comma is quoted, and decimals use a dot', () => {
  const custom = makeConfig({ 'tokenPace.pricing.multiplier': 0.5 })
  const text = toCsv(buildAgg(), range, custom, tcfg)
  assert.equal(text.includes(';'), false)
  for (const line of text.trim().split('\n').slice(1)) {
    const cost = line.split(',')[16]
    if (cost) assert.match(cost, /^\d+\.\d+$/)
  }
})

test('the markdown summary keeps the windows, the totals and the markers', () => {
  const vm = buildViewModel(makeInput())
  const md = toMarkdownSummary(vm)
  for (const q of vm.quotas) {
    assert.ok(md.includes(q.title), q.title)
    for (const w of q.windows) assert.ok(md.includes(`| ${w.label} |`), w.label)
  }
  for (const t of vm.totals) {
    for (const r of t.rows) assert.ok(md.includes(`| ${r.label} |`), r.label)
  }
  // The honesty markers have to survive the trip to the clipboard.
  assert.ok(md.includes('~$'))
  assert.ok(md.includes('lower bound'))
  assert.ok(md.includes('~ = estimate'))
  assert.ok(md.includes('hypothetical'))
})

test('the clipboard summary prints no measuring sentence and describes the gaps as they are drawn', () => {
  // A window that has just reset: the verdict measures. The pace cell is the absence marker,
  // as in the tooltip and the text views — never "measuring · window just reset".
  const history = makeHistory()
  const then = NOW - 4 * 3_600_000
  // One reading four hours ago, then two hours of silence, then the last two hours every 15 min.
  history.add(state('claude', { fetchedAt: Math.round(then / 1000), windows: [win({ percent: 10 })] }), FINGERPRINT, then)
  fillHistory(history)
  const vm = buildViewModel(makeInput({
    history,
    quotas: [state('claude', { windows: [win({ percent: 3, resetsAt: NOW + 5 * 3_600_000 - 30_000, windowMinutes: 300 })] })],
  }))
  assert.equal(vm.quotas[0].windows[0].verdict.measuring, true)
  const md = toMarkdownSummary(vm)
  assert.equal(/measuring|reading over|just reset/.test(md), false, md)
  assert.ok(md.includes('| 5 h | 3% | 0 % | – |'), md)
  // The gap footnote says what the sparkline does with a hole: bridged without a reset inside,
  // open across one — not the "drawn broken" of the old one-notch-per-reading line.
  assert.ok(vm.quotas.some((q) => q.windows.some((w) => w.gaps > 0)), 'the fixture has a gap')
  assert.match(md, /gap\(s\) in the last 24 h; a hole with no reset inside it is bridged by a dashed line, a hole across a reset stays open\./)
  assert.equal(md.includes('drawn broken'), false)
})

test('the clipboard summary says the failed attempt under the provider\'s heading, as the markdown document does (1.7 P4b)', () => {
  const failed = state('claude', {
    fetchedAt: Math.round((NOW - 2 * 3_600_000) / 1000), nextAttemptAt: NOW + 72 * 60_000,
    lastFailure: { at: NOW - 20 * 60_000, problem: 'HTTP 429 — backing off before the next attempt', kind: 'retry' },
  })
  const vm = buildViewModel(makeInput({ quotas: [failed, state('codex')] }))
  const sentence = 'Last attempt at 11:40 failed: HTTP 429 — backing off before the next attempt · next attempt in 1h12m'
  assert.equal(vm.quotas[0].lastFailure, sentence)
  const lines = toMarkdownSummary(vm).split('\n')
  const head = lines.findIndex((l) => l.startsWith('## Claude Code'))
  assert.ok(head >= 0, lines.join('\n'))
  assert.deepEqual(lines.slice(head + 1, head + 4), ['', `_${sentence}_`, ''])
  assert.equal(lines.filter((l) => l.includes('Last attempt at')).length, 1)
  // The line the markdown document prints, word for word.
  assert.ok(markdownDocument(vm).split('\n').includes(`_${sentence}_`))
  // A pipe or a backslash in a borrowed reason cannot break out of the line.
  const odd = buildViewModel(makeInput({ quotas: [state('claude', { ...failed, lastFailure: { ...failed.lastFailure!, problem: 'a|b\\c' } })] }))
  assert.ok(toMarkdownSummary(odd).includes('_Last attempt at 11:40 failed: a\\|b\\\\c · next attempt in 1h12m_'), toMarkdownSummary(odd))
  // Without a failure, or with a permanent cause beside the reading, not a word of one.
  assert.equal(toMarkdownSummary(buildViewModel(makeInput())).includes('Last attempt'), false)
  const permanent = buildViewModel(makeInput({ quotas: [state('claude', { ...failed,
    lastFailure: { at: NOW - 20 * 60_000, problem: 'credentials rejected — sign in to Claude Code again', kind: 'unauthorized' } })] }))
  assert.equal(toMarkdownSummary(permanent).includes('Last attempt'), false)
  assert.equal(toMarkdownSummary(permanent).includes('credentials rejected'), false)
})

test('the clipboard summary keeps a configured plan name marked as configured', () => {
  const provided = toMarkdownSummary(buildViewModel(makeInput()))
  assert.ok(provided.includes('plan max20'), provided.slice(0, 200))
  assert.equal(provided.includes('as configured'), false)

  const configured = toMarkdownSummary(buildViewModel(makeInput({
    cfg: makeConfig({ 'tokenPace.planName': { claude: 'Max 20x' } }),
    quotas: [state('claude', { planType: null })],
  })))
  assert.ok(configured.includes('plan Max 20x (as configured)'), configured.slice(0, 200))
})

test('the clipboard summary carries the local estimate with its caveat, or not at all', () => {
  const vm = buildViewModel(makeInput({
    quotas: [state('claude', { ok: false, problem: 'no token', problemKind: 'noToken', windows: [] })],
  }))
  const text = vm.quotas[0].localBlock?.text
  assert.ok(text)
  const md = toMarkdownSummary(vm)
  assert.ok(md.includes(text), md)
  // Pasted into a chat it must still say what it is not — the caveat travels with the number.
  assert.ok(md.includes('no limit is known'), md)

  // With a real window there is no local figure to confuse it with.
  assert.equal(toMarkdownSummary(buildViewModel(makeInput())).includes('Local estimate'), false)
})

// ---------------------------------------------------------------------------
// Tool calls
// ---------------------------------------------------------------------------

test('the tool table is its own CSV, one row per day, provider, model and name', () => {
  const t = toolAgg(NOW)
  const rows = csvRows(toolsCsv(t.agg, { from: t.range.from, to: t.range.to }))
  assert.deepEqual(rows[0], [...TOOLS_CSV_COLUMNS])
  const body = rows.slice(1, -1)
  // Two groups on the first day, three Claude groups and the Codex call on the second: a
  // name is counted per model, so `Bash` on two models is two rows, never one.
  assert.equal(body.length, 6)
  for (const r of body) {
    assert.match(r[0], /^\d{4}-\d{2}-\d{2}$/)
    assert.ok(['claude', 'codex'].includes(r[1]))
    assert.match(r[4], /^\d+$/)
  }
  const total = rows[rows.length - 1]
  assert.equal(total[0], 'TOTAL')
  assert.equal(Number(total[4]), body.reduce((s, r) => s + Number(r[4]), 0))
  assert.equal(Number(total[4]), 7)
  // The bucket CSV keeps its own columns — a tool number on a bucket row would be a guess.
  assert.equal(CSV_COLUMNS.some((c) => c.includes('tool')), false)
})

test('a range with no tool call still exports a header and a zero total', () => {
  const rows = csvRows(toolsCsv(new Aggregator(), range))
  assert.equal(rows.length, 2)
  assert.deepEqual(rows[0], [...TOOLS_CSV_COLUMNS])
  assert.deepEqual(rows[1], ['TOTAL', '', '', '', '0'])
})

test('the tools CSV keeps a day outside the range out of the file', () => {
  const t = toolAgg(NOW)
  const rows = csvRows(toolsCsv(t.agg, { from: t.days[1], to: t.days[1] })).slice(1, -1)
  assert.equal(rows.every((r) => r[0] === t.days[1]), true)
  assert.equal(rows.length, 4)
})

test('the JSON export carries the tool table and says what it does not contain', () => {
  const t = toolAgg(NOW)
  const j = JSON.parse(toJson(t.agg, { from: t.range.from, to: t.range.to }, cfg, tcfg))
  assert.equal(j.tools.length, 6)
  assert.equal(j.toolsTruncated, false)
  const read = j.tools.filter((x: { tool: string }) => x.tool === 'Read')
  assert.equal(read.reduce((s: number, x: { calls: number }) => s + x.calls, 0), 3)
  assert.deepEqual(Object.keys(j.tools[0]).sort(), ['calls', 'day', 'model', 'source', 'tool'])
  // Names only: no input, no result, no argument of a call anywhere in the file.
  assert.ok(j.notes.some((n: string) => n.includes('names only, never inputs or results')), j.notes.join(' | '))
  // An install that never counted a tool exports the field as an empty list, not as absent.
  const empty = JSON.parse(toJson(buildAgg(), range, cfg, tcfg))
  assert.deepEqual(empty.tools, [])
  assert.equal(empty.toolsTruncated, false)
})

test('the clipboard summary carries every budget with the sentence that qualifies it', () => {
  const vm = buildViewModel(makeInput({
    agg: buildAgg(),
    cfg: makeConfig({
      'tokenPace.budgets': [
        { scope: 'total', period: 'month', unit: 'usd', limit: 20 },
        { scope: 'claude', period: 'day', unit: 'tokens', limit: 5_000_000 },
      ],
    }),
  }))
  const md = toMarkdownSummary(vm)
  assert.ok(md.includes('## Budgets'), md)
  // Word for word the sentence the panel shows; a pasted summary may not reword a limit.
  for (const b of vm.budgets) assert.ok(md.includes(b.text), b.text)
  assert.ok(md.includes('not a bill'), md)

  // Nothing configured, no heading — never an empty section suggesting a budget exists.
  assert.equal(toMarkdownSummary(buildViewModel(makeInput({ agg: buildAgg() }))).includes('## Budgets'), false)
})

// ---------------------------------------------------------------------------
// 1.6 O2: the agents — schema 3, agents[] and the agents file
// ---------------------------------------------------------------------------

/** The Agents world's day, and the view model's clock the world was written against. */
const WORLD_DAY = { from: '2026-09-01', to: TODAY }

/** An agent row's JSON keys, in the order the export writes them — the spec's list (1.6 §3 O2). */
const AGENT_KEYS = [
  'agentId', 'sessionId', 'workflowId', 'type', 'model', 'models', 'effort', 'state', 'derived', 'outcome',
  'outcomeStatus', 'attempt', 'firstTs', 'lastTs', 'requests', 'outputFinal', 'input', 'cacheWrite5m',
  'cacheWrite1h', 'cacheRead', 'output', 'reasoning', 'usage', 'toolCalls', 'toolErrors', 'spawnedBy', 'report',
]

test('the JSON export carries agents[] (schema 3 on): the documented fields, and the note that says what they are', () => {
  // 1.11 P5 (rewritten: schema 3 → 4, §3 C4): 1.11 added the price fields; agents[] is as schema 3 wrote it.
  assert.equal(EXPORT_SCHEMA_VERSION, 4)
  const { agg } = agentWorld()
  const j = JSON.parse(toJson(agg, WORLD_DAY, cfg, tcfg, NOW))
  assert.equal(j.schema_version, 4)
  // Everything version 2 carried is still there.
  for (const k of ['range', 'timezone', 'pricing', 'totals', 'buckets', 'tools', 'toolsTruncated', 'notes']) assert.ok(k in j, k)
  assert.ok(Array.isArray(j.agents) && j.agents.length > 0)
  for (const a of j.agents) assert.deepEqual(Object.keys(a), AGENT_KEYS)
  // The agents file's columns are the same fields, the report as three.
  assert.deepEqual([...AGENTS_CSV_COLUMNS], [
    ...AGENT_KEYS.filter((k) => k !== 'report'), 'reportTokens', 'reportDurationMs', 'reportToolUses',
  ])
  // §7a Q14, word for word, with the retention the tables keep.
  assert.ok(j.notes.includes('agents[] holds the agent records whose activity overlaps the exported range\'s days, within the '
    + `agent tables' ${AGENT_RETENTION_DAYS}-day retention; ids, names and counts only — never a path, a description or a prompt`),
  j.notes.join(' | '))
  // And that an agent's tokens are the isSub buckets' own, never to be added to them.
  assert.ok(j.notes.some((n: string) => n.includes('never added') && n.includes('isSub')), j.notes.join(' | '))
  // An install without agents exports the field as an empty list, not as absent.
  assert.deepEqual(JSON.parse(toJson(buildAgg(), range, cfg, tcfg, NOW)).agents, [])
})

test('every agent record of the tree is a row, with the state, type and model its row shows — a collector\'s member too', () => {
  const { agg } = agentWorld()
  const W = AGENT_WORLD
  const rows = agentRows(agg, WORLD_DAY, cfg, tcfg, NOW)
  // Every record, each once, the first to start first: the launch nobody has written to and the
  // agent the journal started without a transcript have no record, so no row.
  assert.deepEqual(rows.map((r) => r.agentId), [
    W.guide, W.explore, W.plan, W.silent, W.stopped, W.wfDone, W.wfFailed, W.wfRetryFail, W.wfRetry, W.wfReplaced,
    W.wfRunning, W.wfRejected,
  ])
  assert.deepEqual(rows.map((r) => r.firstTs), [...rows.map((r) => r.firstTs)].sort())
  const tree = agentTreeFor(makeInput({ agg, cfg }), 'text')
  for (const r of rows) {
    if (r.agentId === W.wfRejected) continue
    const node = agentNode(tree.roots, r.agentId)
    assert.equal(r.state, node.state, r.agentId)
    assert.equal(r.derived, node.derived, r.agentId)
    // The row's name is its type · its model · its short id.
    assert.equal(node.fullLabel.startsWith(`${r.type ?? 'Agent'} · ${r.model ?? '–'} · `), true, `${node.fullLabel} / ${r.type} / ${r.model}`)
  }
  const by = new Map(rows.map((r) => [r.agentId, r]))
  const row = (id: string): NonNullable<ReturnType<typeof by.get>> => {
    const r = by.get(id)
    assert.ok(r, id)
    return r
  }
  // The member of the run's collector (D4): failed, as the journal recorded it — its record counted nothing.
  assert.deepEqual([row(W.wfRejected).state, row(W.wfRejected).derived, row(W.wfRejected).requests, row(W.wfRejected).usage],
    ['failed', false, 0, 0])
  assert.ok(treeNodes(tree.roots).some((n) => n.kind === 'noreply'), 'the world lost its collector')
  // The inferred states say so; the recorded ones do not.
  assert.deepEqual([row(W.wfRunning).state, row(W.wfRunning).derived], ['running', true])
  assert.deepEqual([row(W.silent).state, row(W.silent).derived, row(W.silent).type], ['unknown', true, null])
  // What the parent recorded, with its own word; the journal's ends are the state's, not the outcome's.
  assert.deepEqual([row(W.stopped).state, row(W.stopped).outcome, row(W.stopped).outcomeStatus], ['stopped', 'stopped', 'killed'])
  assert.deepEqual([row(W.wfFailed).outcome, row(W.wfFailed).outcomeStatus], ['failed', 'failed'])
  assert.deepEqual([row(W.wfDone).state, row(W.wfDone).outcome], ['done', null])
  // The attempts at their step, as the journal numbers them (D7) — none outside a run or without a step.
  assert.deepEqual([W.wfRetryFail, W.wfRetry, W.wfReplaced, W.wfRunning, W.wfDone, W.wfFailed, W.explore].map((id) => row(id).attempt),
    [1, 2, 1, 2, 1, null, null])
  // Who launched it: the session, an agent of the session by id, or nobody known — a run's agent.
  assert.deepEqual([W.explore, W.plan, W.guide, W.wfFailed, W.wfDone].map((id) => row(id).spawnedBy),
    ['session', W.explore, 'session', 'session', null])
  // Claude Code's own report, only where there is one.
  assert.deepEqual(row(W.explore).report, { tokens: 98_400, durationMs: 755_000, toolUses: 4 })
  assert.deepEqual(row(W.plan).report, { tokens: 38_200, durationMs: 575_000, toolUses: 2 })
  assert.equal(row(W.silent).report, null)
  // The counts as the record holds them, the usage as the row counts it, the times in ISO.
  assert.deepEqual(row(W.guide), {
    agentId: W.guide, sessionId: W.quiet, workflowId: null, type: 'claude-code-guide', model: 'claude-haiku-4-5',
    models: ['claude-haiku-4-5'], effort: 'high', state: 'done', derived: false, outcome: 'completed', outcomeStatus: 'completed',
    attempt: null, firstTs: '2026-09-03T08:52:05.000Z', lastTs: '2026-09-03T08:52:53.000Z', requests: 2, outputFinal: 2,
    input: 9, cacheWrite5m: 9400, cacheWrite1h: 0, cacheRead: 8100, output: 1070, reasoning: 0, usage: 9 + 9400 + 1070,
    // 1.6 P13a (O3, pinned and changed): the record counts its tool errors now — none of its one call.
    toolCalls: 1, toolErrors: 0, spawnedBy: 'session', report: { tokens: 18_900, durationMs: 51_000, toolUses: 1 },
  })
  assert.equal(row(W.wfRunning).workflowId, W.workflow)
  // Every session's agents, not only the sessions the page lists: both sessions are here.
  assert.deepEqual([...new Set(rows.map((r) => r.sessionId))].sort(), [W.session, W.quiet].sort())
})

test('the agents of the export are those whose activity touches a day of the range, within the seven days the tables keep', () => {
  const { agg } = agentWorld()
  const ids = (from: string, to: string, now = NOW): string[] => agentRows(agg, { from, to }, cfg, tcfg, now).map((r) => r.agentId)
  assert.equal(ids(TODAY, TODAY).length, 12)
  // Days before or after the world's own export no agent at all.
  assert.deepEqual(ids('2026-08-01', '2026-09-02'), [])
  assert.deepEqual(ids('2026-09-04', '2026-09-30', NOW + 86_400_000), [])
  // A range that holds the day, exported a week and a day later: past the retention, no row.
  assert.deepEqual(ids('2026-08-01', '2026-09-30', NOW + (AGENT_RETENTION_DAYS + 1) * 86_400_000), [])
  // The day an agent is on is the configured zone's: 08:52 UTC is still 2 September at UTC−10.
  const hawaii = makeConfig({ 'tokenPace.timezone': 'Pacific/Honolulu' })
  const early = agentRows(agg, { from: '2026-09-02', to: '2026-09-02' }, hawaii, timeConfig(hawaii), NOW).map((r) => r.agentId)
  assert.ok(early.includes(AGENT_WORLD.guide), early.join(', '))
  assert.equal(early.includes(AGENT_WORLD.wfRunning), false, early.join(', '))
})

test('the agents file has the documented columns, the same rows as agents[], and an empty cell where JSON says null', () => {
  const { agg } = agentWorld()
  const text = agentsCsv(agg, WORLD_DAY, cfg, tcfg, NOW)
  const rows = csvRows(text)
  assert.deepEqual(rows[0], [...AGENTS_CSV_COLUMNS])
  const json = JSON.parse(toJson(agg, WORLD_DAY, cfg, tcfg, NOW)).agents as Array<Record<string, unknown>>
  const body = rows.slice(1)
  assert.equal(body.length, json.length)
  // No TOTAL line: an agent's tokens are the isSub buckets' own.
  assert.equal(body.some((r) => r[0] === 'TOTAL'), false)
  const col = (name: string): number => (AGENTS_CSV_COLUMNS as readonly string[]).indexOf(name)
  for (const [i, r] of body.entries()) {
    const j = json[i]
    assert.equal(r.length, AGENTS_CSV_COLUMNS.length, r.join(','))
    for (const k of AGENT_KEYS.filter((x) => x !== 'report' && x !== 'models')) {
      const v = j[k]
      // Absent is empty — never 0, never "null".
      assert.equal(r[col(k)], v === null ? '' : String(v), `${String(j.agentId)} ${k}`)
    }
    assert.equal(r[col('models')], (j.models as string[]).join(' '))
    const report = j.report as { tokens: number; durationMs: number; toolUses: number } | null
    assert.deepEqual([r[col('reportTokens')], r[col('reportDurationMs')], r[col('reportToolUses')]],
      report === null ? ['', '', ''] : [String(report.tokens), String(report.durationMs), String(report.toolUses)])
  }
  // A range without an agent still has its header.
  assert.equal(agentsCsv(agg, { from: '2026-08-01', to: '2026-08-02' }, cfg, tcfg, NOW), `${AGENTS_CSV_COLUMNS.join(',')}\n`)
  assert.equal(agentsCsv(new Aggregator(), range, cfg, tcfg, NOW), `${AGENTS_CSV_COLUMNS.join(',')}\n`)
})

test('an agent row is identifiers, words of a fixed set and numbers: a record from elsewhere cannot put anything else in', () => {
  // A snapshot of another build's making may hold anything: the export checks once more on the way out.
  const { agg } = agentWorld()
  const records = agg.agents()
  const forged = records.map((r) => (r.agentId === AGENT_WORLD.explore
    ? { ...r, meta: r.meta && { ...r.meta, agentType: 'Explore <script>' }, models: ['claude-haiku-4-5', 'a model, with "quotes"'] }
    : r))
  agg.agents = () => forged
  const row = agentRows(agg, WORLD_DAY, cfg, tcfg, NOW).find((r) => r.agentId === AGENT_WORLD.explore)
  assert.ok(row)
  assert.equal(row.type, null)
  assert.deepEqual(row.models, ['claude-haiku-4-5'])
  const csv = agentsCsv(agg, WORLD_DAY, cfg, tcfg, NOW)
  assert.equal(/script|quotes/.test(csv), false, csv)
  // A record whose id is none of an id's shape is no row at all.
  agg.agents = () => records.map((r) => (r.agentId === AGENT_WORLD.plan ? { ...r, agentId: 'plan/../../etc' } : r))
  assert.equal(agentRows(agg, WORLD_DAY, cfg, tcfg, NOW).some((r) => r.agentId.includes('/')), false)
})

test('a companion file is the chosen name with its extension replaced — the tools file and the agents file side by side', () => {
  assert.equal(TOOLS_FILE_SUFFIX, '.tools.csv')
  assert.equal(AGENTS_FILE_SUFFIX, '.agents.csv')
  const chosen = '/home/t/exports/token-pace-2026-09-01_2026-09-03-20260903-1200.csv'
  assert.equal(companionPath(chosen, TOOLS_FILE_SUFFIX), '/home/t/exports/token-pace-2026-09-01_2026-09-03-20260903-1200.tools.csv')
  assert.equal(companionPath(chosen, AGENTS_FILE_SUFFIX), '/home/t/exports/token-pace-2026-09-01_2026-09-03-20260903-1200.agents.csv')
  // A name without an extension gains the suffix; a dot in a directory's name is no extension.
  assert.equal(companionPath('/home/t/v1.2/export', AGENTS_FILE_SUFFIX), '/home/t/v1.2/export.agents.csv')
  assert.equal(companionPath('C:\\Users\\t\\v1.2\\export.csv', AGENTS_FILE_SUFFIX), 'C:\\Users\\t\\v1.2\\export.agents.csv')
  assert.notEqual(companionPath(chosen, TOOLS_FILE_SUFFIX), companionPath(chosen, AGENTS_FILE_SUFFIX))
})

test('the CSV and JSON exports are byte for byte the same under a German page (1.10 B4, §3.0 h)', () => {
  // The views' decimals follow the language since 1.10; an export is read by a machine and keeps its '.' and its
  // English in every language — the buckets, the tools and the agents file, the JSON with its notes.
  const bundle = JSON.parse(readFileSync(join(__dirname, '..', 'l10n', 'bundle.l10n.de.json'), 'utf8')) as Record<string, string>
  const { agg: agents } = agentWorld()
  const tools = toolAgg(NOW)
  const all = (): string[] => [
    toCsv(buildAgg(), range, cfg, tcfg),
    toJson(buildAgg(), range, cfg, tcfg, NOW),
    toolsCsv(tools.agg, tools.range),
    agentsCsv(agents, WORLD_DAY, cfg, tcfg, NOW),
    toJson(agents, WORLD_DAY, cfg, tcfg, NOW),
  ].map((text) => text.replace(/"generated_at": "[^"]*"/, '"generated_at": "<now>"'))
  const en = all()
  // Decimals are there to compare: the cost columns are written with six decimals and a '.'.
  assert.match(en[0], /,\d+\.\d{6}(,|\n|$)/)
  try {
    setBundle(bundle)
    setLocale('de')
    setLang('de')
    const de = all()
    for (let i = 0; i < en.length; i++) assert.equal(de[i], en[i], `export ${i} changed under de`)
  } finally {
    setBundle(undefined)
    setLocale(undefined)
    setLang(undefined)
  }
})

// ---------------------------------------------------------------------------
// 1.11 C4 (§0a.5): both amounts, the dated rule and "approximate" per bucket — schema 4
// ---------------------------------------------------------------------------

/**
 * A world of four buckets for the price fields and nothing else: a Claude day after the table's check
 * (priced exact), a Claude hour before it (priced from the nearest rule: approximate), a model the table
 * does not know (unpriced) and a Codex day — plus whatever a test adds.
 */
const PRICE_WORLD_RANGE = { from: '2026-09-01', to: '2026-09-10', label: 'Price world', preset: 'custom' }
function priceWorld(extra: Bucket[] = []): Aggregator {
  const agg = new Aggregator()
  const counts = (b: Bucket, c: Partial<Bucket>): Bucket => Object.assign(b, c)
  const hour = Date.UTC(2026, 8, 1, 10) / 3_600_000
  const buckets = [
    counts(emptyBucket('claude', 'claude-opus-4-6', false, 'standard', 'd', null, '2026-09-10'),
      { input: 1_000_000, cacheWrite: 400_000, cacheWrite1h: 100_000, cacheRead: 2_000_000, output: 300_000, webSearch: 3, requests: 4, outputFinal: 4 }),
    counts(emptyBucket('claude', 'claude-sonnet-4-6', false, 'standard', 'h', hour, '2026-09-01'),
      { input: 500_000, output: 100_000, requests: 2, outputFinal: 2 }),
    counts(emptyBucket('claude', 'claude-experimental-x', false, 'standard', 'd', null, '2026-09-02'),
      { input: 200_000, output: 50_000, requests: 1, outputFinal: 1 }),
    counts(emptyBucket('codex', 'gpt-5', false, 'standard', 'd', null, '2026-09-10'),
      { input: 800_000, cacheRead: 300_000, output: 90_000, reasoning: 20_000, requests: 3, outputFinal: 3 }),
    ...extra,
  ]
  agg.all = () => buckets.map((b) => ({ ...b }))
  return agg
}

/** The price world's rows by model, the CSV's cells named by their column. */
function csvByModel(text: string): Map<string, Record<string, string>> {
  const [head, ...body] = csvRows(text)
  const out = new Map<string, Record<string, string>>()
  for (const r of body) out.set(r[3] === '' ? r[0] : r[3], Object.fromEntries(head.map((k, i) => [k, r[i]])))
  return out
}

test('1.11 C4: the CSV carries the list amount, the rule\'s day and "approximate" after priced — by hand, at a multiplier of 0.9', () => {
  const discount = makeConfig({ 'tokenPace.pricing.multiplier': 0.9 })
  const text = toCsv(priceWorld(), PRICE_WORLD_RANGE, discount, timeConfig(discount))
  // One whole row: Opus 4.6 on a day its rule covers — list $16.405 (5 + 1.875 + 1 + 1 + 7.5 for the tokens, $0.03 for three
  // searches), 0.9 of it configured; the rule read on PRICES_AS_OF; not approximate.
  assert.ok(text.split('\n').includes(
    `2026-09-10,,claude,claude-opus-4-6,false,standard,d,1000000,300000,100000,2000000,300000,0,4,4,3,14.764500,exact,16.405000,${PRICES_AS_OF},`), text)
  const rows = csvByModel(text)
  // Sonnet 4.6's hour on 1 September, before its rule's day: priced from the nearest rule, and it says so.
  assert.deepEqual([rows.get('claude-sonnet-4-6')?.costUsd, rows.get('claude-sonnet-4-6')?.listCostUsd, rows.get('claude-sonnet-4-6')?.priceFrom,
    rows.get('claude-sonnet-4-6')?.priceApproximate], ['2.700000', '3.000000', PRICES_AS_OF, 'true'])
  // Codex: the input holds the cached tokens (0.625 + 0.0375 + 0.9 at list).
  assert.deepEqual([rows.get('gpt-5')?.costUsd, rows.get('gpt-5')?.listCostUsd, rows.get('gpt-5')?.priceFrom, rows.get('gpt-5')?.priceApproximate],
    ['1.406250', '1.562500', PRICES_AS_OF, ''])
  // Unpriced: every price cell empty — never 0, never a rule it did not have.
  assert.deepEqual([rows.get('claude-experimental-x')?.costUsd, rows.get('claude-experimental-x')?.priced, rows.get('claude-experimental-x')?.listCostUsd,
    rows.get('claude-experimental-x')?.priceFrom, rows.get('claude-experimental-x')?.priceApproximate], ['', 'none', '', '', ''])
  // TOTAL: the list amounts of the priced buckets summed; a sum has no rule and no day.
  const total = rows.get('TOTAL')
  assert.deepEqual([total?.costUsd, total?.priced, total?.listCostUsd, total?.priceFrom, total?.priceApproximate],
    ['18.870750', 'lowerBound', '20.967500', '', ''])
  const body = [...rows.values()].filter((r) => r.day !== 'TOTAL' && r.listCostUsd !== '')
  assert.equal(Number(total?.listCostUsd), Number(body.reduce((sum, r) => sum + Number(r.listCostUsd), 0).toFixed(6)))
  // At list prices the two amounts are the same figure.
  const list = csvByModel(toCsv(priceWorld(), PRICE_WORLD_RANGE, cfg, tcfg))
  for (const [model, r] of list) if (r.costUsd !== '') assert.equal(r.listCostUsd, r.costUsd, model)
})

test('1.11 C4: a custom price — an override alone has no rule and no list amount of its own; one over a rule keeps the rule\'s day and the list amount', () => {
  const custom = makeConfig({
    'tokenPace.pricing.multiplier': 0.9,
    'tokenPace.customPrices': { 'claude-experimental-x': { input: 2, output: 8 }, 'claude-opus-4-6': { input: 1 } },
  })
  const rows = csvByModel(toCsv(priceWorld(), PRICE_WORLD_RANGE, custom, timeConfig(custom)))
  // Priced by the override alone ($0.40 + $0.40, 0.9 of it): no published rule, so no day and no discount against one.
  const alone = rows.get('claude-experimental-x')
  assert.deepEqual([alone?.priced, alone?.costUsd, alone?.listCostUsd, alone?.priceFrom, alone?.priceApproximate], ['custom', '0.720000', '0.720000', '', ''])
  // An input override over Opus 4.6's rule: $1 instead of $5 for the million input tokens, at 0.9; the list amount is the rule's.
  const over = rows.get('claude-opus-4-6')
  assert.deepEqual([over?.priced, over?.costUsd, over?.listCostUsd, over?.priceFrom], ['custom', '11.164500', '16.405000', PRICES_AS_OF])
  // JSON: the same, the absent rule as null.
  const j = JSON.parse(toJson(priceWorld(), PRICE_WORLD_RANGE, custom, timeConfig(custom), NOW))
  const b = j.buckets.find((x: { model: string }) => x.model === 'claude-experimental-x')
  assert.deepEqual([b.costUsd, b.listCostUsd, b.priceFrom, b.priceApproximate], [0.72, 0.72, null, false])
})

test('1.11 C4: under the family rule the rule is the donor\'s — its day, and "approximate" before it', () => {
  const family = makeConfig({ 'tokenPace.unknownModelPricing': 'family' })
  const opus49 = Object.assign(emptyBucket('claude', 'claude-opus-4-9', false, 'standard', 'd', null, '2026-09-10'), { input: 1_000_000, requests: 1 })
  const rows = csvByModel(toCsv(priceWorld([opus49]), PRICE_WORLD_RANGE, family, timeConfig(family)))
  const r = rows.get('claude-opus-4-9')
  // Opus 5.5's $4 input, read on OPUS_5_5_CHECKED — after 10 September, so the day is priced from the nearest rule.
  assert.deepEqual([r?.priced, r?.costUsd, r?.listCostUsd, r?.priceFrom, r?.priceApproximate], ['family', '4.000000', '4.000000', OPUS_5_5_CHECKED, 'true'])
})

test('1.11 C4: the JSON buckets carry the same three fields — null and false where the CSV is empty — and the totals the list sum', () => {
  const discount = makeConfig({ 'tokenPace.pricing.multiplier': 0.9 })
  const j = JSON.parse(toJson(priceWorld(), PRICE_WORLD_RANGE, discount, timeConfig(discount), NOW))
  assert.equal(j.schema_version, 4)
  const by = new Map<string, Record<string, unknown>>(j.buckets.map((b: Record<string, unknown>) => [b.model as string, b]))
  const facts = (m: string): unknown[] => ['costUsd', 'listCostUsd', 'priceFrom', 'priceApproximate'].map((k) => by.get(m)?.[k])
  assert.deepEqual(facts('claude-opus-4-6'), [14.7645, 16.405, PRICES_AS_OF, false])
  assert.deepEqual(facts('claude-sonnet-4-6'), [2.7, 3, PRICES_AS_OF, true])
  assert.deepEqual(facts('gpt-5'), [1.40625, 1.5625, PRICES_AS_OF, false])
  // Unpriced: null, never 0 — the list amount of a price that does not exist is no amount.
  assert.deepEqual(facts('claude-experimental-x'), [null, null, null, false])
  // The new keys follow `priced`, in the CSV's order.
  assert.deepEqual(Object.keys(by.get('gpt-5') ?? {}).slice(-4), ['priced', 'listCostUsd', 'priceFrom', 'priceApproximate'])
  assert.equal(j.totals.listCostUsd, 20.9675)
  assert.equal(j.totals.costUsd, 18.87075)
  // The CSV and the JSON say the same of every bucket.
  const csv = csvByModel(toCsv(priceWorld(), PRICE_WORLD_RANGE, discount, timeConfig(discount)))
  for (const [model, b] of by) {
    const r = csv.get(model)
    assert.equal(r?.listCostUsd, b.listCostUsd === null ? '' : (b.listCostUsd as number).toFixed(6), model)
    assert.equal(r?.priceFrom, b.priceFrom ?? '', model)
    assert.equal(r?.priceApproximate, b.priceApproximate ? 'true' : '', model)
  }
})

test('1.11 C4: pricing names every provider\'s later-checked rows and the source pages by host, and a note says what the three fields mean', () => {
  const j = JSON.parse(toJson(priceWorld(), PRICE_WORLD_RANGE, cfg, tcfg, NOW))
  // Every provider's, whatever the dashboard shows (§7a Q10): the export follows no view.
  assert.deepEqual(j.pricing.checked_later, PRICES_CHECKED_LATER.map((r) => ({ model: r.model, checked: r.checked })))
  assert.deepEqual(j.pricing.checked_later, [{ model: 'claude-opus-5-5', checked: OPUS_5_5_CHECKED }])
  assert.deepEqual(j.pricing.sources, SOURCES.flatMap((s) => [...PRICE_SOURCE_PAGES[s]]))
  assert.deepEqual(j.pricing.sources, ['docs.claude.com', 'platform.claude.com', 'developers.openai.com'])
  for (const host of j.pricing.sources) assert.match(host, /^[a-z0-9-]+(\.[a-z0-9-]+)+$/, 'a host name, never a URL or a path')
  assert.deepEqual(Object.keys(j.pricing), ['as_of', 'custom', 'multiplier', 'unknown_model', 'checked_later', 'sources'])
  assert.ok(j.notes.includes('listCostUsd is the same usage at the published list price (multiplier 1, no custom price); priceFrom is the day '
    + 'the price rule used was read; priceApproximate means no rule covered that day and the nearest one was used'), j.notes.join(' | '))
})

/**
 * 1.10.0's JSON export (schema 3) of the price world at a multiplier of 0.9 — written by the exporter at 0bff209, the tip
 * before 1.11 P5, without `generated_at` and `writer` (a time and a build). What a reader of schema 3 read.
 */
const SCHEMA_3_PRICE_WORLD = {
  schema_version: 3,
  range: { from: '2026-09-01', to: '2026-09-10', label: 'Price world', preset: 'custom' },
  timezone: { zone: 'utc', day_boundary_hour: 0, start_of_week: 'monday' },
  pricing: { as_of: '2026-09-06', custom: true, multiplier: 0.9, unknown_model: 'strict' },
  totals: { usage: 3140000, input: 2500000, cacheWrite5m: 300000, cacheWrite1h: 100000, cacheRead: 2300000, output: 540000, reasoning: 20000,
    requests: 10, outputFinal: 10, webSearch: 3, webFetch: 0, costUsd: 18.87075, unpricedTokens: 250000, lowerBound: true },
  buckets: [
    { day: '2026-09-01', hour: 496738, source: 'claude', model: 'claude-sonnet-4-6', isSub: false, tier: 'standard', res: 'h', input: 500000, cacheWrite5m: 0,
      cacheWrite1h: 0, cacheRead: 0, output: 100000, reasoning: 0, requests: 2, outputFinal: 2, webSearch: 0, webFetch: 0, costUsd: 2.7, priced: 'exact' },
    { day: '2026-09-02', hour: null, source: 'claude', model: 'claude-experimental-x', isSub: false, tier: 'standard', res: 'd', input: 200000, cacheWrite5m: 0,
      cacheWrite1h: 0, cacheRead: 0, output: 50000, reasoning: 0, requests: 1, outputFinal: 1, webSearch: 0, webFetch: 0, costUsd: null, priced: 'none' },
    { day: '2026-09-10', hour: null, source: 'claude', model: 'claude-opus-4-6', isSub: false, tier: 'standard', res: 'd', input: 1000000, cacheWrite5m: 300000,
      cacheWrite1h: 100000, cacheRead: 2000000, output: 300000, reasoning: 0, requests: 4, outputFinal: 4, webSearch: 3, webFetch: 0, costUsd: 14.7645, priced: 'exact' },
    { day: '2026-09-10', hour: null, source: 'codex', model: 'gpt-5', isSub: false, tier: 'standard', res: 'd', input: 800000, cacheWrite5m: 0,
      cacheWrite1h: 0, cacheRead: 300000, output: 90000, reasoning: 20000, requests: 3, outputFinal: 3, webSearch: 0, webFetch: 0, costUsd: 1.40625, priced: 'exact' },
  ],
  tools: [],
  toolsTruncated: false,
  agents: [],
  notes: [
    'usage = fresh input + cache write + output',
    'costUsd is hypothetical API cost, not a bill; null means the model has no price on file',
    'days without data have no row — gaps are gaps, not zeros',
    'tools[] counts tool calls by name and day; names only, never inputs or results. toolsTruncated means a day had more than 100 distinct tools and the rarest were not counted',
    'agents[] holds the agent records whose activity overlaps the exported range\'s days, within the agent tables\' 7-day retention; ids, names and counts only — never a path, a description or a prompt',
    'an agent row counts the agent whole: the same tokens the buckets with isSub true count hour by hour, so the two are never added; state is the Agents section\'s, inferred where derived is true; report is Claude Code\'s own figure for the agent, never part of a total',
  ],
}

test('1.11 C4: a reader of schema 3 reads the same values from a schema 4 file — every old field unchanged, deep-equal after dropping the new ones', () => {
  const discount = makeConfig({ 'tokenPace.pricing.multiplier': 0.9 })
  const j = JSON.parse(toJson(priceWorld(), PRICE_WORLD_RANGE, discount, timeConfig(discount), NOW))
  assert.equal(typeof j.generated_at, 'string')
  assert.match(j.writer, /^token-pace\//)
  delete j.generated_at
  delete j.writer
  // Drop exactly what schema 4 added: three fields per bucket, one total, two pricing fields, one note — and the version.
  for (const b of j.buckets) {
    for (const k of ['listCostUsd', 'priceFrom', 'priceApproximate']) {
      assert.ok(k in b, k)
      delete b[k]
    }
  }
  assert.ok('listCostUsd' in j.totals)
  delete j.totals.listCostUsd
  assert.ok('checked_later' in j.pricing && 'sources' in j.pricing)
  delete j.pricing.checked_later
  delete j.pricing.sources
  assert.equal(j.notes.filter((n: string) => n.startsWith('listCostUsd is')).length, 1)
  j.notes = j.notes.filter((n: string) => !n.startsWith('listCostUsd is'))
  assert.equal(j.schema_version, 4)
  // The table's day is today's constant, whatever a re-check makes it; everything else is 1.10.0's file as it was.
  assert.deepEqual(j, { ...SCHEMA_3_PRICE_WORLD, schema_version: 4, pricing: { ...SCHEMA_3_PRICE_WORLD.pricing, as_of: PRICES_AS_OF } })
})

test('1.11 §0a.5: the new fields hold amounts, days, true and host names — neither export names a path or a URL', () => {
  const onCfg = makeConfig({ 'tokenPace.attribution': 'session', 'tokenPace.pricing.multiplier': 0.9 })
  const { agg: agents } = agentWorld('session')
  const texts: Array<[string, string]> = [
    ['price world json', toJson(priceWorld(), PRICE_WORLD_RANGE, onCfg, timeConfig(onCfg), NOW)],
    ['price world csv', toCsv(priceWorld(), PRICE_WORLD_RANGE, onCfg, timeConfig(onCfg))],
    ['fixture json', toJson(buildAgg('session'), range, onCfg, timeConfig(onCfg), NOW)],
    ['fixture csv', toCsv(buildAgg('session'), range, onCfg, timeConfig(onCfg))],
    ['agents json', toJson(agents, WORLD_DAY, onCfg, timeConfig(onCfg), NOW)],
  ]
  for (const [what, text] of texts) {
    assert.equal(text.includes('/home/'), false, `${what} names a home directory`)
    assert.equal(text.includes('://'), false, `${what} carries a URL`)
  }
  // Each new value is one of four shapes: a six-place amount, an ISO day, true, or nothing.
  for (const [what, text] of texts.filter(([w]) => w.endsWith('csv'))) {
    const rows = csvRows(text).slice(1)
    assert.ok(rows.length >= 2, what)
    for (const r of rows) {
      assert.equal(r.length, CSV_COLUMNS.length, `${what}: ${r.join(',')}`)
      assert.match(r[18], /^(\d+\.\d{6})?$/, `${what} listCostUsd`)
      assert.match(r[19], /^(\d{4}-\d{2}-\d{2})?$/, `${what} priceFrom`)
      assert.match(r[20], /^(true)?$/, `${what} priceApproximate`)
    }
  }
})
