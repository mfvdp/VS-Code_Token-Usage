// SPDX-FileCopyrightText: 2026 Frederik Marx
// SPDX-License-Identifier: AGPL-3.0-or-later

import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { Aggregator } from '../src/agg'
import { CSV_COLUMNS, toCsv, toJson, toMarkdownSummary } from '../src/exporter'
import { buildViewModel } from '../src/viewModel'
import { TODAY, buildAgg, makeConfig, makeInput, timeConfig } from './fixtures/viewFixtures'

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
  assert.equal(j.schema_version, 1)
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
