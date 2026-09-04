// SPDX-FileCopyrightText: 2026 Frederik Marx
// SPDX-License-Identifier: AGPL-3.0-or-later

import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { Aggregator } from '../src/agg'
import { CSV_COLUMNS, EXPORT_SCHEMA_VERSION, TOOLS_CSV_COLUMNS, toCsv, toJson, toMarkdownSummary, toolsCsv } from '../src/exporter'
import { buildViewModel } from '../src/viewModel'
import { NOW, TODAY, buildAgg, makeConfig, makeInput, state, timeConfig } from './fixtures/viewFixtures'
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
