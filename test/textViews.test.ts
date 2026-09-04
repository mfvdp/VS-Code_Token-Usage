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
import { SOURCE_TITLE, ViewModel, buildViewModel } from '../src/viewModel'
import {
  FINGERPRINT, NOW, buildAgg, fillHistory, makeConfig, makeHistory, makeInput, state, win,
} from './fixtures/viewFixtures'
import { deltaBadge } from '../src/render'
import { toolAgg } from './helpers/toolAgg'

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
  // Seven, not eight: the selected 30-day range is the fixed "Last 30 days" row, and one
  // table must never print the same label twice.
  assert.equal(total, vm.totals.length * 7)
})

test('every KPI appears once in both renderings', () => {
  const vm = fullVm()
  const items = quickPickItems(vm)
  const md = markdownDocument(vm)
  const figures = rowsOf(md, '## Key figures')
  assert.equal(figures.length, vm.kpis.length)
  for (const k of vm.kpis) {
    assert.equal(items.filter((i) => i.label.startsWith(`${k.label}: `)).length, 1, k.label)
    // Inside its own section: "Today" is also a period label in the token tables, and the
    // two are the same word about two different figures.
    assert.equal(figures.filter((l) => l.startsWith(`| ${k.label} |`)).length, 1, k.label)
  }
})

test('the day the panel is opened for is the first figure in all three renderings', () => {
  const vm = fullVm()
  const today = vm.kpis[0]
  assert.equal(today.key, 'today')
  // The QuickPick and the markdown table each carry it once, with the same value.
  const item = quickPickItems(vm).find((i) => i.label.startsWith('Today: '))
  assert.ok(item, 'the QuickPick has no today row')
  assert.equal(item.label, `Today: ${today.value}`)
  const row = rowsOf(markdownDocument(vm), '## Key figures')[0]
  assert.ok(row.startsWith('| Today |'), row)
  assert.ok(row.includes(today.value), row)
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

/** The header row of one markdown table, split into its column names. */
function headOf(md: string, heading: string): string[] {
  const lines = md.split('\n')
  const start = lines.indexOf(heading)
  assert.notEqual(start, -1, `section missing: ${heading}`)
  const head = lines.slice(start).find((l) => l.startsWith('| '))
  assert.ok(head, `no table under ${heading}`)
  return head.split('|').slice(1, -1).map((c) => c.trim())
}

test('the models table names the same columns as the totals table, in the same order', () => {
  const vm = fullVm()
  const md = markdownDocument(vm)
  const totals = headOf(md, `## Tokens — ${vm.totals[0].title}`)
  const models = headOf(md, '## Models')
  assert.deepEqual(models, ['Model', 'Provider', 'Usage', 'Fresh input', 'Write 5m', 'Write 1h',
    'Cache read', 'Output', 'Reasoning', 'Req.', 'Cache hit', 'Per req.', 'API cost', 'Share',
    'Cost share'])
  // Column for column the totals table's own words, from "Usage" to "API cost".
  assert.deepEqual(models.slice(2, 13), totals.slice(1))
  // Every row has a cell for every column — a short row would shift the figures one over.
  for (const row of rowsOf(md, '## Models')) {
    assert.equal(row.split('|').slice(1, -1).length, models.length, row)
  }
})

test('neither table has a Price column any more, and no row prints a bare provenance', () => {
  const md = markdownDocument(fullVm())
  assert.equal(headOf(md, '## Models').includes('Price'), false, md)
  for (const row of rowsOf(md, '## Models')) {
    for (const word of ['exact', 'family', 'custom', 'per 1M', 'no price on file']) {
      assert.equal(row.includes(word), false, `${word} is still in ${row}`)
    }
  }
  // The rates stay reachable in the QuickPick, which has no columns to lose them from.
  const priced = quickPickItems(fullVm()).filter((i) => String(i.detail ?? '').includes('per 1M'))
  assert.ok(priced.length > 0, 'the QuickPick lost the price provenance')
})

test('the hour profile states what the picture stands on, in the dashboard’s own words', () => {
  const vm = fullVm()
  const line = markdownDocument(vm).split('\n').find((l) => l.startsWith('Hours ('))
  assert.ok(line, 'the markdown has no hours line')
  assert.ok(line.includes(vm.hours.basis.text), line)
  assert.match(line, / — a record, not a habit/)
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

test('the flat list is grouped by headings that carry no command', () => {
  const items = quickPickItems(fullVm())
  const seps = items.filter((i) => i.separator === true)
  // Every group the reader scrolls past is named, and a heading is never selectable.
  assert.ok(seps.length >= 8, String(seps.length))
  for (const s of seps) {
    assert.equal(s.command, undefined)
    assert.equal(s.description, undefined)
    assert.equal(s.detail, undefined)
  }
  const labels = seps.map((s) => s.label)
  for (const want of ['Quota', 'Key figures', 'Tokens', 'Forecast', 'Data quality', 'Actions']) {
    assert.ok(labels.includes(want), want)
  }
  // A heading is only written when a row follows it: the last item is a row, never a divider.
  assert.equal(items[items.length - 1].separator, undefined)
})

test('an empty group leaves no heading behind', () => {
  const vm = buildViewModel(makeInput({ agg: new Aggregator(), quotas: [] }))
  const items = quickPickItems(vm)
  assert.equal(vm.projects.rows.length, 0)
  assert.equal(items.some((i) => i.separator === true && i.label === 'Projects'), false)
  // Two headings in a row would mean one of them is empty.
  for (let i = 1; i < items.length; i++) {
    assert.equal(items[i].separator === true && items[i - 1].separator === true, false, items[i].label)
  }
})

test('the reset history is dropped from the list only when no window has a cycle yet', () => {
  const vm = fullVm()
  // The fixture has no complete cycle on file, so every row would say the same non-answer.
  assert.ok(vm.retro.length > 0)
  assert.ok(vm.retro.every((r) => r.text.startsWith('not enough data')))
  assert.equal(quickPickItems(vm).some((i) => i.label.startsWith('Reset history ')), false)
  assert.equal(quickPickItems(vm).some((i) => i.separator && i.label === 'Reset history'), false)
  // The markdown document keeps them: it is read by scrolling, not by filtering.
  assert.ok(markdownDocument(vm).includes('## Reset history'))

  // One window with a real retrospective and the whole group comes back, named.
  const answered = {
    ...vm,
    retro: vm.retro.map((r, i) => (i === 0
      ? { ...r, text: '50 % of the complete cycles hit the limit · Avg 12 % unused at the reset' }
      : r)),
  }
  const rows = quickPickItems(answered).filter((i) => i.label.startsWith('Reset history '))
  assert.equal(rows.length, vm.retro.length)
  for (const r of rows) assert.match(r.label, /(Claude Code|Codex)/)
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

// ---------------------------------------------------------------------------
// Wording: no identifiers, no doubled verb, no nameless window
// ---------------------------------------------------------------------------

/**
 * Both providers report a window called "5 h", and the Claude one's stated reset has come and
 * gone while the reading still predates it. That is the exact shape the flat views used to
 * garble: two indistinguishable "5 h" rows, and a "resets reset due".
 */
function twinVm(): ViewModel {
  const history = makeHistory()
  fillHistory(history)
  const claude = state('claude', {
    windows: [
      win({ resetsAt: NOW - 60_000 }),
      win({
        id: 'weekly_all:10080', kind: 'weekly', label: '7 d', shortLabel: '7d', percent: 62,
        resetsAt: NOW + 3 * 86_400_000, windowMinutes: 10080,
      }),
    ],
  })
  return buildViewModel(makeInput({
    history,
    cfg: makeConfig({ 'tokenPace.attribution': 'project', 'tokenPace.calibration.show': true }),
    agg: buildAgg('project'),
    quotas: [claude, state('codex')],
  }))
}

/** Everything a QuickPick actually shows, as one blob. */
function pickText(vm: ViewModel): string {
  return quickPickItems(vm)
    .map((i) => [i.label, i.description, i.detail].filter(Boolean).join(' · '))
    .join('\n')
}

test('neither text view ever prints the verb twice or an internal identifier', () => {
  const vm = twinVm()
  const due = vm.quotas[0].windows[0]
  assert.equal(due.display, 'resetDue')

  for (const [name, text] of [['QuickPick', pickText(vm)], ['markdown', markdownDocument(vm)]]) {
    assert.equal(text.includes('resets reset due'), false, name)
    assert.ok(text.includes('reset due'), name)
    // The enum spellings that could only come from an identifier, never from prose.
    assert.equal(/\b(resetDue|limitReached|resetsFirst)\b/.test(text), false, name)
    assert.equal(/\bnormal\b/.test(text), false, name)
  }
  // The detail line joins the sustainable sentence and the reset time: "…to the reset · reset
  // at 14:00" would say the word twice in a row.
  for (const item of quickPickItems(vm)) {
    assert.equal(/reset · reset\b/.test(item.detail ?? ''), false, item.detail)
  }
})

test('every window row in the flat views names the provider it belongs to', () => {
  const vm = twinVm()
  // The premise: the label alone is ambiguous.
  const fives = vm.forecasts.filter((f) => f.label === '5 h')
  assert.equal(fives.length, 2)
  assert.notEqual(fives[0].source, fives[1].source)

  const named = /(Claude Code|Codex)/
  // Reset history is checked in the markdown block below: with no complete cycle on file the
  // QuickPick leaves those rows out entirely (see the test that follows).
  const prefixes = ['Forecast ', 'Local usage in ']
  const items = quickPickItems(vm)
  for (const p of prefixes) {
    const rows = items.filter((i) => i.label.startsWith(p))
    assert.ok(rows.length >= 2, p)
    for (const r of rows) assert.ok(named.test(r.label), r.label)
  }
  // Attribution items are headed by the window, so they carry the provider as well.
  const attribution = items.filter((i) => i.label.includes(' · unexplained'))
  assert.ok(attribution.length >= 2)
  for (const a of attribution) assert.ok(named.test(a.label), a.label)

  const md = markdownDocument(vm)
  for (const a of vm.attributionInWindow) {
    assert.ok(md.includes(`### Attribution — ${SOURCE_TITLE[a.source]} · ${a.label}`), a.label)
  }
  // The raw window id was what made the two blocks look alike; it is gone from the headings.
  assert.equal(md.includes('### Attribution — session:300'), false)
  for (const heading of ['## Forecast', '## Reset history', '## Local usage inside the current windows']) {
    const start = md.indexOf(heading)
    assert.notEqual(start, -1, heading)
    // To the next heading of any level: the attribution blocks below are `###`.
    const block = md.slice(start, md.indexOf('\n#', start + 1))
    for (const line of block.split('\n')) {
      if (!line.startsWith('| ') && !line.startsWith('- **')) continue
      if (line.startsWith('| Window') || line.startsWith('|---')) continue
      assert.ok(named.test(line), `${heading}: ${line}`)
    }
  }
})

test('a full reading from before the reset is not repeated as a fact about the new window', () => {
  // The provider says the window reset a minute ago, but the newest reading is five minutes
  // old and still reads 100 %. That "full" belongs to the cycle that has ended; the dashboard
  // drops it, so the flat views drop it too — three views, one statement per window.
  const vm = buildViewModel(makeInput({
    quotas: [state('claude', { windows: [win({ percent: 100, resetsAt: NOW - 60_000 })] })],
  }))
  const w = vm.quotas[0].windows[0]
  assert.equal(w.display, 'resetDue')
  assert.equal(w.forecast?.state, 'full')
  assert.equal(w.forecast?.text, 'full')

  const row = quickPickItems(vm).find((i) => i.label.startsWith('5 h '))
  assert.ok(row)
  assert.equal(row.description, 'exhausted · reset due')

  const md = markdownDocument(vm)
  const line = md.split('\n').find((l) => l.startsWith('| 5 h |'))
  assert.ok(line)
  assert.equal(/\bfull\b/.test(line), false, line)
  // The forecast column keeps the dash it would show for any window with nothing to say.
  assert.ok(line.trimEnd().endsWith('| – |'), line)
})

test('a full window that has not reset still says so in both views', () => {
  // The mirror image of the case above: the same reading, a reset still ahead. Dropping the
  // sentence there would lose the plainest fact the card has.
  const vm = buildViewModel(makeInput({
    quotas: [state('claude', { windows: [win({ percent: 100 })] })],
  }))
  const w = vm.quotas[0].windows[0]
  assert.equal(w.display, 'exhausted')
  assert.equal(w.forecast?.text, 'full until the reset')
  const row = quickPickItems(vm).find((i) => i.label.startsWith('5 h '))
  assert.ok(row?.description?.includes('full until the reset'))
  const line = markdownDocument(vm).split('\n').find((l) => l.startsWith('| 5 h |'))
  assert.ok(line?.includes('full until the reset'), line)
})

test('every provider column in the flat views carries the name, not the internal id', () => {
  const vm = fullVm()
  const md = markdownDocument(vm)
  const items = quickPickItems(vm)
  const ids = /(^|\W)(claude|codex)(\W|$)/

  for (const c of vm.cacheEconomy) {
    const title = SOURCE_TITLE[c.source]
    assert.ok(items.some((i) => i.label.startsWith(`Cache economy ${title}: `)), title)
  }
  for (const heading of ['## Cache economy', '## Composition']) {
    const rows = rowsOf(md, heading)
    assert.ok(rows.length > 0, heading)
    for (const r of rows) {
      const provider = r.split('|')[1].trim()
      assert.ok(provider === SOURCE_TITLE.claude || provider === SOURCE_TITLE.codex, `${heading}: ${r}`)
    }
  }
  // The models table heads the same column, and the plan comparison names the account too.
  for (const r of rowsOf(md, '## Models')) {
    const provider = r.split('|')[2].trim()
    assert.ok(provider === SOURCE_TITLE.claude || provider === SOURCE_TITLE.codex, r)
  }
  for (const line of md.split('\n').filter((l) => l.startsWith('Plan comparison'))) {
    assert.equal(ids.test(line.split(':')[0]), false, line)
  }
})

test('a forecast with nothing to say prints a dash, never its state name', () => {
  const vm = buildViewModel(makeInput())
  const bare = vm.forecasts.find((f) => f.forecast.text === '')
  assert.ok(bare, 'the fixture has a window without a series')
  assert.equal(bare.forecast.state, 'none')
  const item = quickPickItems(vm)
    .find((i) => i.label.startsWith(`Forecast ${SOURCE_TITLE[bare.source]} · ${bare.label}:`))
  assert.ok(item)
  assert.ok(item.label.endsWith(': –'), item.label)
})

test('a stale reading after the reset says "reset due" once per row, not per column', () => {
  // Sixty per cent, a reset a minute ago, the newest reading older than that: the window
  // header already says "reset due", and the forecast for that state is the same two words.
  // The forecast needs a series to judge, and the series must end before the stated reset —
  // a reading taken after it would forecast the new window instead.
  const history = makeHistory()
  for (const minutes of [45, 30, 15, 5]) {
    const t = NOW - minutes * 60_000
    history.add(
      state('claude', { fetchedAt: Math.round(t / 1000), windows: [win({ percent: 60 - minutes })] }),
      FINGERPRINT,
      t,
    )
  }
  const vm = buildViewModel(makeInput({
    history,
    quotas: [state('claude', { windows: [win({ percent: 60, resetsAt: NOW - 60_000 })] })],
  }))
  const w = vm.quotas[0].windows[0]
  assert.equal(w.display, 'resetDue')
  assert.equal(w.forecast?.text, 'reset due')

  const row = quickPickItems(vm).find((i) => i.label.startsWith('5 h '))
  assert.ok(row?.description, 'the window row is missing')
  assert.equal(row.description.split('reset due').length - 1, 1, row.description)
  assert.equal(row.description.includes('reset due · reset due'), false, row.description)

  const line = markdownDocument(vm).split('\n').find((l) => l.startsWith('| 5 h |'))
  assert.ok(line)
  assert.equal(line.split('reset due').length - 1, 1, line)
  assert.ok(line.trimEnd().endsWith('| – |'), line)
})

test('growth from nothing is announced as "new", never as "new new"', () => {
  const vm = fullVm()
  vm.kpis = vm.kpis.map((k) => ({ ...k, delta: deltaBadge(5, null) }))
  for (const [name, text] of [['QuickPick', pickText(vm)], ['markdown', markdownDocument(vm)]]) {
    assert.ok(/\bnew\b/.test(text), name)
    assert.equal(/\bnew new\b/.test(text), false, name)
  }
})

test('the context window reaches both flat renderings exactly once, or neither', () => {
  const history = makeHistory()
  fillHistory(history)
  const base = makeInput({ history })
  const vm = buildViewModel({
    ...base,
    context: { used: 128_000, size: 200_000, usedPct: 64, fetchedAt: Math.round((NOW - 120_000) / 1000) },
  })
  const c = vm.context
  assert.ok(c)

  const rows = quickPickItems(vm).filter((i) => i.label.startsWith('Context window: '))
  assert.equal(rows.length, 1)
  assert.equal(rows[0].label, `Context window: ${c.text}`)
  assert.equal(rows[0].description, c.note)

  const md = markdownDocument(vm)
  assert.equal(md.split('## Context window').length, 2)
  assert.ok(md.includes(`${c.text} — ${c.note}`), md)

  // No reading, no row and no heading — an empty section would be a promise of a figure.
  const without = buildViewModel(base)
  assert.equal(quickPickItems(without).some((i) => i.label.startsWith('Context window')), false)
  assert.equal(markdownDocument(without).includes('## Context window'), false)
})

test('a plan name out of the settings is marked as configured in both flat views', () => {
  const vm = buildViewModel(makeInput({
    cfg: makeConfig({ 'tokenPace.planName': { claude: 'Max 20x' } }),
    quotas: [state('claude', { planType: null })],
  }))
  const item = quickPickItems(vm).find((i) => i.label === SOURCE_TITLE.claude)
  assert.ok(item)
  assert.ok((item.description ?? '').startsWith('plan Max 20x (as configured)'), item.description)
  assert.ok(markdownDocument(vm).includes('plan Max 20x (as configured)'))
})

test('every record row reaches both flat renderings exactly once', () => {
  const vm = buildViewModel(makeInput({
    cfg: makeConfig({ 'tokenPace.attribution': 'session', 'tokenPace.dashboard.topN': 3 }),
    agg: buildAgg('session'),
  }))
  const r = vm.records
  assert.ok(r.topModels.length > 0 && r.topProjects.length > 0 && r.topSessions.length > 0)
  const items = quickPickItems(vm)
  const md = markdownDocument(vm)

  assert.equal(items.filter((i) => i.label.startsWith('Record peak day: ')).length, 1)
  assert.equal(items.filter((i) => i.label.startsWith('Record streak: ')).length, 1)
  assert.ok(r.peakDay)
  assert.ok(md.includes(`Peak day: ${r.peakDay.day} — ${r.peakDay.usage}`), md)
  assert.ok(md.includes(`Longest streak: ${r.streak?.days} days`), md)

  for (const [kind, rows] of [
    ['model', r.topModels], ['project', r.topProjects], ['session', r.topSessions],
  ] as const) {
    assert.equal(items.filter((i) => i.label.startsWith(`Top ${kind} `)).length, rows.length)
    assert.equal(rowsOf(md, `## Records`).filter((l) => rows.some((e) => l.startsWith(`| ${e.label} |`))).length,
      rows.length, `${kind} rows are missing from the markdown table`)
  }
  assert.equal(md.split('## Records').length, 2)
})

test('the local five-hour estimate is one sentence, the same one in both flat renderings', () => {
  const vm = buildViewModel(makeInput({
    quotas: [state('claude', { ok: false, problem: 'no token', problemKind: 'noToken', windows: [] })],
  }))
  const text = vm.quotas[0].localBlock?.text
  assert.ok(text)
  const items = quickPickItems(vm).filter((i) => i.label.startsWith('Local estimate'))
  assert.equal(items.length, 1)
  assert.equal(items[0].label, text)
  const md = markdownDocument(vm)
  assert.equal(md.split('Local estimate').length, 2)
  assert.ok(md.includes(text), md)

  // A provider that reports a window gets no such line anywhere.
  const withWindow = buildViewModel(makeInput())
  assert.equal(quickPickItems(withWindow).some((i) => i.label.startsWith('Local estimate')), false)
  assert.equal(markdownDocument(withWindow).includes('Local estimate'), false)
})

test('every tool row reaches both flat renderings exactly once, with its notes', () => {
  const t = toolAgg(NOW)
  const vm = buildViewModel(makeInput({ agg: t.agg, range: t.range }))
  const rows = vm.tools.rows
  assert.ok(rows.length >= 4)

  const items = quickPickItems(vm)
  for (const r of rows) {
    const found = items.filter((i) => i.label === `Tool ${r.name}: ${r.callsText}`)
    assert.equal(found.length, 1, r.name)
    assert.equal(found[0].description, `${r.share} of calls · ${r.models}`)
  }
  assert.equal(items.filter((i) => /^Tool .+: /.test(i.label)).length, rows.length)

  const md = markdownDocument(vm)
  assert.equal(md.split('## Tools').length, 2)
  assert.equal(rowsOf(md, '## Tools').length, rows.length)
  for (const r of rows) assert.ok(md.includes(`| ${r.name} |`), r.name)
  // The sentence that says since when tool calls are counted travels with the table.
  for (const n of vm.tools.notes) {
    assert.ok(items.some((i) => i.label === n), n)
    assert.ok(md.includes(n), n)
  }
})

test('the tool cap is offered as a setting rather than silently swallowing rows', () => {
  const t = toolAgg(NOW)
  const vm = buildViewModel(makeInput({
    agg: t.agg, range: t.range, cfg: makeConfig({ 'tokenPace.dashboard.topN': 1 }),
  }))
  assert.equal(vm.tools.hidden, 3)
  const item = quickPickItems(vm).find((i) => i.label === '3 more tool row(s)')
  assert.ok(item)
  assert.equal(item.command, 'tokenPace.openSettings')
  assert.ok(markdownDocument(vm).includes('3 more not listed'))
})

test('an install with no tool rows says so in both flat renderings', () => {
  const vm = buildViewModel(makeInput({ agg: new Aggregator(), quotas: [] }))
  const note = 'No tool call has been counted yet — counting starts with the next transcript read.'
  assert.ok(quickPickItems(vm).some((i) => i.label === note))
  const md = markdownDocument(vm)
  assert.ok(md.includes(note), md)
  // No table, no invented row, and no "0" pretending to be a count.
  assert.equal(rowsOf(md, '## Tools').length, 0)
})

test('every budget row reaches both flat renderings exactly once', () => {
  const vm = buildViewModel(makeInput({
    agg: buildAgg(),
    cfg: makeConfig({
      'tokenPace.budgets': [
        { scope: 'total', period: 'month', unit: 'usd', limit: 20 },
        { scope: 'claude', period: 'day', unit: 'tokens', limit: 5_000_000 },
      ],
    }),
  }))
  const rows = vm.budgets
  assert.equal(rows.length, 2)

  const items = quickPickItems(vm)
  for (const b of rows) {
    // The label is the view model's own sentence, word for word: a budget may not read one
    // way in the panel and another in the list.
    const found = items.filter((i) => i.label === b.text)
    assert.equal(found.length, 1, b.text)
    assert.equal(found[0].description?.startsWith(`${b.from} → ${b.last}`), true, found[0].description)
  }

  const md = markdownDocument(vm)
  assert.equal(md.split('## Budgets').length, 2)
  assert.equal(rowsOf(md, '## Budgets').length, rows.length)
  for (const b of rows) assert.ok(md.includes(`| ${b.label} |`) || md.includes(`| ${b.label} ⚠ |`), b.label)
  assert.ok(md.includes('not a bill'), md)
})

test('no budget configured leaves no heading and no row behind', () => {
  const vm = buildViewModel(makeInput({ agg: buildAgg() }))
  assert.deepEqual(vm.budgets, [])
  assert.equal(quickPickItems(vm).some((i) => i.label === 'Budgets'), false)
  assert.equal(markdownDocument(vm).includes('## Budgets'), false)
})
