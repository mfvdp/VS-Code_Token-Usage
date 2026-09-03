// SPDX-FileCopyrightText: 2026 Frederik Marx
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Field parity between the three renderings.
 *
 * The QuickPick and the markdown document exist because the webview is not always available;
 * the moment one of them quietly drops a window or a row, the fallback stops being the same
 * dashboard. So the counts are asserted, not the prose.
 */

import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { Aggregator } from '../src/agg'
import { markdownDocument, quickPickItems } from '../src/textViews'
import { ViewModel, buildViewModel } from '../src/viewModel'
import { fillHistory, makeConfig, makeHistory, makeInput, buildAgg } from './fixtures/viewFixtures'

function fullVm(): ViewModel {
  const history = makeHistory()
  fillHistory(history)
  return buildViewModel(makeInput({
    history,
    cfg: makeConfig({ 'tokenPace.attribution': 'project', 'tokenPace.calibration.show': true }),
    agg: buildAgg('project'),
    ui: { drillDay: '2026-09-02' },
  }))
}

/** Table rows of one markdown section, without the header row. */
function rowsOf(md: string, heading: string): string[] {
  const lines = md.split('\n')
  const start = lines.indexOf(heading)
  assert.notEqual(start, -1, `section missing: ${heading}`)
  const out: string[] = []
  for (let i = start + 1; i < lines.length; i++) {
    if (/^#{2,3} /.test(lines[i])) break
    if (!lines[i].startsWith('| ')) continue
    if (lines[i + 1]?.startsWith('|---')) continue
    out.push(lines[i])
  }
  return out
}

test('every quota window appears once in both renderings', () => {
  const vm = fullVm()
  const windows = vm.quotas.flatMap((q) => q.windows)
  assert.ok(windows.length >= 4)

  // A window item is the one carrying a bar; nothing else in the list draws one.
  const items = quickPickItems(vm)
  const bar = /[█▁▏▎▍▌▋▊▉┃]/
  assert.equal(items.filter((i) => bar.test(i.label)).length, windows.length)

  const md = markdownDocument(vm)
  assert.equal(md.split('\n').filter((l) => l.startsWith('|') && l.includes('`')).length, windows.length)
  for (const w of windows) assert.ok(md.includes(`| ${w.label} |`), w.label)
})

test('every totals row appears once in both renderings', () => {
  const vm = fullVm()
  const items = quickPickItems(vm)
  const md = markdownDocument(vm)
  let total = 0
  for (const t of vm.totals) {
    total += t.rows.length
    assert.equal(items.filter((i) => i.label.startsWith(`${t.title} · `)).length, t.rows.length)
    assert.equal(rowsOf(md, `## Tokens — ${t.title}`).length, t.rows.length)
  }
  assert.equal(total, vm.totals.length * 8)
})

test('every KPI appears once in both renderings', () => {
  const vm = fullVm()
  const items = quickPickItems(vm)
  const md = markdownDocument(vm)
  assert.equal(rowsOf(md, '## Key figures').length, vm.kpis.length)
  for (const k of vm.kpis) {
    assert.equal(items.filter((i) => i.label.startsWith(`${k.label}: `)).length, 1, k.label)
    assert.equal(md.split('\n').filter((l) => l.startsWith(`| ${k.label} |`)).length, 1, k.label)
  }
})

test('every forecast appears once in both renderings', () => {
  const vm = fullVm()
  const items = quickPickItems(vm)
  const md = markdownDocument(vm)
  assert.ok(vm.forecasts.length >= 4)
  assert.equal(items.filter((i) => i.label.startsWith('Forecast ')).length, vm.forecasts.length)
  assert.equal(rowsOf(md, '## Forecast').length, vm.forecasts.length)
})

test('cache economy, window usage and the digest survive into both renderings', () => {
  const vm = fullVm()
  const items = quickPickItems(vm)
  const md = markdownDocument(vm)
  assert.equal(items.filter((i) => i.label.startsWith('Cache economy ')).length, vm.cacheEconomy.length)
  assert.equal(rowsOf(md, '## Cache economy').length, vm.cacheEconomy.length)
  assert.equal(items.filter((i) => i.label.startsWith('Local usage in ')).length, vm.windowUsage.length)
  assert.equal(rowsOf(md, '## Local usage inside the current windows').length, vm.windowUsage.length)
  for (const s of vm.digest) {
    assert.ok(items.some((i) => i.label === s), s)
    assert.ok(md.includes(`- ${s}`), s)
  }
  assert.equal(rowsOf(md, '## Calendar').length, 4)
  assert.equal(rowsOf(md, '## Models').length, vm.models.rows.length)
})

test('the data-quality lines are identical in both renderings', () => {
  const vm = fullVm()
  const md = markdownDocument(vm)
  const dqItems = quickPickItems(vm).filter((i) => i.label.startsWith('Roots: ')
    || i.label.startsWith('Coverage: ') || i.label.startsWith('Quota sources ')
    || i.label.startsWith('Calibration '))
  assert.ok(dqItems.length >= 4)
  for (const i of dqItems) assert.ok(md.includes(`- ${i.label}`), i.label)
})

test('projects and sessions reach both renderings when attribution is on', () => {
  const vm = fullVm()
  const items = quickPickItems(vm)
  const md = markdownDocument(vm)
  assert.equal(items.filter((i) => i.label.startsWith('Project ')).length, vm.projects.rows.length)
  assert.equal(items.filter((i) => i.label.startsWith('Session ')).length, vm.sessions.rows.length)
  assert.equal(rowsOf(md, '## Projects').length, vm.projects.rows.length)
  assert.equal(rowsOf(md, '## Sessions').length, vm.sessions.rows.length)
})

test('the QuickPick only ever offers our own commands', () => {
  const allowed = new Set([
    'tokenPace.showDashboard', 'tokenPace.refreshQuota', 'tokenPace.rescan', 'tokenPace.showOutput',
    'tokenPace.openSettings', 'tokenPace.exportCsv', 'tokenPace.exportJson', 'tokenPace.copySummary',
  ])
  for (const i of quickPickItems(fullVm())) {
    if (i.command) assert.ok(allowed.has(i.command), i.command)
  }
})

test('the markdown document is a document, not a table dump', () => {
  const md = markdownDocument(fullVm())
  assert.ok(md.startsWith('# Token Pace — usage'))
  for (const heading of ['## Summary', '## Quota', '## Key figures', '## Cache economy',
    '## Calendar', '## Models', '## Forecast', '## Activity', '## Data quality']) {
    assert.ok(md.includes(heading), heading)
  }
  // A pipe inside a value would split the column, so it has to be escaped.
  assert.equal(md.includes('| claude|code |'), false)
})

test('an empty install renders both views without inventing anything', () => {
  const vm = buildViewModel(makeInput({ agg: new Aggregator(), quotas: [] }))
  const items = quickPickItems(vm)
  const md = markdownDocument(vm)
  assert.ok(items.length > 0)
  assert.ok(md.includes('## First run'))
  assert.ok(md.includes('_No quota reading._'))
  assert.equal(md.includes('$0.00'), false)
  assert.equal(md.includes('0 %'), false)
})
