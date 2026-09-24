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
import { toolAgg } from './helpers/toolAgg'

const cfg = makeConfig()
const tcfg = timeConfig(cfg)
const range = { from: '2026-08-25', to: TODAY, label: 'Last 10 days', preset: 'custom' }

function csvRows(text: string): string[][] {
  return text.trim().split('\n').map((l) => l.split(','))
}

test('the CSV header is the documented column list', () => {
  const rows = csvRows(toCsv(buildAgg(), range, cfg, tcfg))
  assert.deepEqual(rows[0], [...CSV_COLUMNS])
  assert.equal(rows[0].length, 18)
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

test('the JSON export is schema 3: agents[] of the documented fields, and the note that says what they are', () => {
  assert.equal(EXPORT_SCHEMA_VERSION, 3)
  const { agg } = agentWorld()
  const j = JSON.parse(toJson(agg, WORLD_DAY, cfg, tcfg, NOW))
  assert.equal(j.schema_version, 3)
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
