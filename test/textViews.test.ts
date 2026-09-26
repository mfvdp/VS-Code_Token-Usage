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
import { readFileSync } from 'node:fs'
import * as path from 'node:path'
import { test } from 'node:test'
import { Aggregator } from '../src/agg'
import { AgentTreeVm, EARLIER_KEY, MAX_GROUP_CHILDREN, MAX_ROOTS, RunningItem, TreeNode, emptyAgentTree } from '../src/agentTree'
import { tallySpoken, tallyText } from '../src/agentTreeBuild'
import { setBundle, setLocale } from '../src/i18n'
import { PICK_RUNNING_ITEMS, PickItem, markdownDocument, noIcons, quickPickItems } from '../src/textViews'
import { AgentLaunch, AgentRec, MainRec } from '../src/types'
import { SOURCE_TITLE, ViewModel, agentTreeFor, buildViewModel } from '../src/viewModel'
import {
  CLAUDE_FILE, FINGERPRINT, NOW, addCacheSession, agentShareAgg, buildAgg, fillHistory, makeConfig, makeHistory, makeInput, state, win,
} from './fixtures/viewFixtures'
import { deltaBadge } from '../src/render'
import { bestState } from '../src/quotaSources'
import {
  LEAK_SESSION_ID, LEAK_STATUS_SECRETS, codexMeta, codexTokenCount, codexTurnContext, ctxFor, scratchDir, writeLeakyMirror,
} from './fixtures/helpers'
import type { PromptCacheReading } from '../src/quotaSources'
import { ROOT } from './helpers/nls'
import { agentWorld } from './fixtures/agentWorld'
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

/** The fixture's aggregator after a roll-up that keeps no hour buckets at all. */
function rolledUp(): Aggregator {
  const snap = buildAgg().toSnapshot()
  return Aggregator.fromSnapshot(
    { ...snap, rollup: { lastRun: NOW, hourRetentionDays: 0, retentionDays: 400 } },
    'none',
  )
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

// 1.7 W1: the failed attempt beside a stale reading, in both text views; W2: the freshness row's words.
test('the failed attempt beside a reading reaches the markdown under the heading and the Quick Pick as the item\'s detail (1.7 W1)', () => {
  const failed = state('claude', {
    fetchedAt: Math.round((NOW - 2 * 3_600_000) / 1000), nextAttemptAt: NOW + 72 * 60_000,
    lastFailure: { at: NOW - 20 * 60_000, problem: 'HTTP 429 — backing off before the next attempt', kind: 'retry' },
  })
  const vm = buildViewModel(makeInput({ quotas: [failed, state('codex')] }))
  const sentence = 'Last attempt at 11:40 failed: HTTP 429 — backing off before the next attempt · next attempt in 1h12m'
  assert.equal(vm.quotas[0].lastFailure, sentence)
  const lines = markdownDocument(vm).split('\n')
  const head = lines.findIndex((l) => l.startsWith('### Claude Code'))
  assert.deepEqual(lines.slice(head + 1, head + 4), ['', `_${sentence}_`, ''])
  assert.equal(lines.filter((l) => l.includes('Last attempt at')).length, 1)
  const items = quickPickItems(vm)
  const claude = items.find((i) => i.label === 'Claude Code')
  assert.equal(claude?.detail, sentence)
  assert.equal(items.find((i) => i.label === 'Codex')?.detail, undefined)
  // No failure: neither view says a word of one.
  const plain = buildViewModel(makeInput())
  assert.equal(markdownDocument(plain).includes('Last attempt'), false)
  assert.equal(quickPickItems(plain).find((i) => i.label === 'Claude Code')?.detail, undefined)
  // A card without a reading keeps its problem as the detail.
  const broken = buildViewModel(makeInput({ quotas: [state('claude', {
    ok: false, problem: 'HTTP 429 — backing off before the next attempt', problemKind: 'retry', windows: [],
    lastFailure: { at: NOW - 20 * 60_000, problem: 'HTTP 429 — backing off before the next attempt', kind: 'retry' },
  })] }))
  assert.equal(quickPickItems(broken).find((i) => i.label === 'Claude Code')?.detail, '⚠ HTTP 429 — backing off before the next attempt')
})

/**
 * VS Code's own reading of a Quick Pick line (`renderLabelWithIcons`): `$(name)` or `$(name~modifier)`
 * becomes an icon, a backslash in front makes it the literal text. Mirrored here, so the test asks what
 * the list would draw rather than how the string is spelt.
 */
function drawnIcons(s: string): { icons: string[]; text: string } {
  const icons: string[] = []
  const text = s.replace(/(\\)?\$\(([A-Za-z0-9-]+(?:~[A-Za-z]+)?)\)/g, (_m, escaped: string | undefined, name: string) => {
    if (escaped) return `$(${name})`
    icons.push(name)
    return ''
  })
  return { icons, text }
}

test('the Quick Pick prints Codex\'s own error string as text: no "$(" becomes an icon (1.7 P4b)', () => {
  // A hostile app-server error: icon syntax, a modified icon, one already escaped, and a "$(" that is no icon.
  const reason = 'rate limited $(alert) $(sync~spin) \\$(x) $( 5 ) $(bad name)'
  const failed = state('codex', {
    fetchedAt: Math.round((NOW - 2 * 3_600_000) / 1000), nextAttemptAt: NOW + 72 * 60_000,
    lastFailure: { at: NOW - 20 * 60_000, problem: reason, kind: 'retry' },
  })
  const vm = buildViewModel(makeInput({ quotas: [state('claude'), failed] }))
  assert.equal(vm.quotas[1].lastFailure, `Last attempt at 11:40 failed: ${reason} · next attempt in 1h12m`)
  const detail = quickPickItems(vm).find((i) => i.label === 'Codex')?.detail as string
  const drawn = drawnIcons(detail)
  assert.deepEqual(drawn.icons, [], detail)
  // What the list shows is the sentence exactly as the card prints it.
  assert.equal(drawn.text, vm.quotas[1].lastFailure)
  // The same string as the problem of a card without a reading.
  const broken = buildViewModel(makeInput({ quotas: [state('codex', { ok: false, problem: reason, problemKind: 'retry', windows: [] })] }))
  const problem = quickPickItems(broken).find((i) => i.label === 'Codex')?.detail as string
  assert.deepEqual(drawnIcons(problem).icons, [], problem)
  assert.equal(drawnIcons(problem).text, `⚠ ${reason}`)
  // Our own words are untouched: a reason without icon syntax is the sentence to the byte.
  assert.equal(noIcons('HTTP 429 — backing off before the next attempt'), 'HTTP 429 — backing off before the next attempt')
  // The icons the item's own label draws are not ours to escape: the label is the provider's title.
  assert.equal(quickPickItems(vm).find((i) => i.label === 'Codex')?.label, 'Codex')
})

// 1.7 P7b (the lead's note on P4b): the provider item's description carries the plan name — the
// provider's own word, for Codex a string of its app-server's — so it goes through noIcons like the detail.
test('the Quick Pick prints a borrowed plan name as text: no "$(" in the provider item\'s description becomes an icon (1.7 P7b)', () => {
  const plan = 'pro $(alert) $(sync~spin) \\$(x) $( 5 ) $(bad name)'
  const vm = buildViewModel(makeInput({ quotas: [state('claude'), state('codex', { planType: plan })] }))
  const card = vm.quotas.find((q) => q.source === 'codex')
  assert.equal(card?.planText, `plan ${plan}`)
  const item = quickPickItems(vm).find((i) => i.label === 'Codex') as PickItem
  const drawn = drawnIcons(item.description as string)
  assert.deepEqual(drawn.icons, [], item.description)
  // What the list shows is the card's own line of words, to the character.
  assert.ok(drawn.text.startsWith(`plan ${plan}`), drawn.text)
  // The configured name is a string of the reader's, and passes the same way.
  const configured = buildViewModel(makeInput({
    cfg: makeConfig({ 'tokenPace.planName': { claude: 'Max $(flame)', codex: '' } }),
    quotas: [state('claude', { planType: null }), state('codex')],
  }))
  const own = quickPickItems(configured).find((i) => i.label === 'Claude Code') as PickItem
  assert.deepEqual(drawnIcons(own.description as string).icons, [], own.description)
  assert.ok(drawnIcons(own.description as string).text.startsWith('plan Max $(flame) (as configured)'), own.description)
  // A description of our own words is untouched.
  const plain = quickPickItems(buildViewModel(makeInput())).find((i) => i.label === 'Claude Code') as PickItem
  assert.equal(plain.description, noIcons(plain.description as string))
  assert.equal(/\\\$\(/.test(plain.description as string), false, plain.description)
})

test('a permanent cause beside a reading reaches neither the markdown nor the Quick Pick (1.7 P4b, Review 1 #2)', () => {
  const permanent = buildViewModel(makeInput({ quotas: [state('claude'), state('codex', {
    origin: 'transcript', fetchedAt: Math.round((NOW - 45 * 60_000) / 1000),
    lastFailure: { at: NOW - 20 * 60_000, problem: 'codex executable not found', kind: 'noBinary' },
  })] }))
  assert.equal(permanent.quotas[1].lastFailure, null)
  assert.equal(markdownDocument(permanent).includes('codex executable not found'), false)
  assert.equal(quickPickItems(permanent).find((i) => i.label === 'Codex')?.detail, undefined)
})

test('the markdown\'s freshness row says a passed attempt is due, and a held one waits for focus (1.7 W2)', () => {
  const row = (over: Parameters<typeof state>[1]): string => {
    const md = markdownDocument(buildViewModel(makeInput({ quotas: [state('claude', over)] })))
    return md.split('\n').find((l) => l.startsWith('Freshness —')) as string
  }
  assert.match(row({ nextAttemptAt: NOW - 60_000 }), / · next refresh due · /)
  assert.match(row({ nextAttemptAt: NOW - 60_000, attemptHeld: 'focus' }), / · next refresh waiting for focus · /)
  assert.match(row({ nextAttemptAt: NOW + 72 * 60_000 }), / · next refresh 1h12m · /)
  assert.match(row({ nextAttemptAt: null }), / · next refresh – · /)
  assert.doesNotMatch(row({ nextAttemptAt: NOW - 60_000 }), /reset due/)
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
  // Six fixed calendar rows — the table follows no chip, so there is no selected-range row
  // and no previous period — plus the two running window rows.
  assert.equal(total, vm.totals.length * 8)
})

test('the running windows lead the fixed rows, and the mark is explained once per table', () => {
  const vm = fullVm()
  const md = markdownDocument(vm)
  for (const t of vm.totals) {
    // The two windows a reader checks against the quota cards lead, then the fixed periods.
    assert.deepEqual(t.rows.slice(0, 3).map((r) => r.label),
      ['Current 5 h window', 'Current 7 d window', 'Today'])
    const rows = rowsOf(md, `## Tokens — ${t.title}`)
    assert.ok(rows[0].startsWith('| Current 5 h window |'), rows[0])
    // Every row of the table reaches the QuickPick too.
    assert.equal(
      quickPickItems(vm).filter((i) => i.label.startsWith(`${t.title} · Current `)).length, 2)
  }
  // The fixture reads whole hours that are still on file, so nothing is marked and the
  // caveat is not printed at all.
  assert.equal(vm.totals.some((t) => t.rows.some((r) => r.approx)), false)
  assert.equal(md.includes('rolled up into day totals'), false)

  // With the hour buckets already folded away, both window rows are lower bounds — and the
  // sentence that explains the mark is printed once per table, not once per row.
  const folded = buildViewModel(makeInput({ agg: rolledUp() }))
  const rolled = markdownDocument(folded)
  assert.ok(folded.totals[0].rows.filter((r) => r.approx).length === 2)
  assert.equal(rolled.split('rolled up into day totals').length - 1, folded.totals.length)
  assert.ok(rolled.includes('_≈ marks a lower bound: the oldest hours of the span are already rolled up into day totals_'))
  // And the glyph legend every view prints names the mark, so the QuickPick — which has no
  // room for the sentence under a table — still says what a figure with it is.
  assert.ok(folded.footnotes.some((f) => f.includes('≈ = lower bound')), JSON.stringify(folded.footnotes))
  assert.equal(vm.footnotes.some((f) => f.includes('≈')), false, JSON.stringify(vm.footnotes))
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

test('every key figure is explained once in both text views', () => {
  const vm = fullVm()
  const md = markdownDocument(vm)
  const items = quickPickItems(vm)
  // One heading, one bullet per figure, in the order the table has them.
  assert.equal(md.split('\n').filter((l) => l === '### Key figures explained').length, 1)
  const all = md.split('\n')
  const start = all.indexOf('### Key figures explained')
  const end = all.findIndex((l, i) => i > start && /^#{2,3} /.test(l))
  const lines = all.slice(start + 1, end).filter((l) => l.startsWith('- **'))
  assert.equal(lines.length, vm.kpis.length)
  for (let i = 0; i < vm.kpis.length; i++) {
    const k = vm.kpis[i]
    assert.equal(lines[i], `- **${k.label}** — ${k.explain.what}. ${k.explain.how}. ${k.explain.period}.`)
    // The QuickPick has no room for the whole card: what the figure is, and what it stands on.
    const item = items.find((x) => x.label.startsWith(`${k.label}: `))
    assert.ok(item, k.label)
    assert.equal(item.detail, `${k.explain.what} · ${k.explain.provenance}`)
  }
  // The list sits after the table, not inside it: the parity count above must stay right.
  assert.ok(start > md.split('\n').indexOf('## Key figures'))
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

test('the Forecast section is gone from both renderings, and the card keeps its forecast', () => {
  const vm = fullVm()
  const items = quickPickItems(vm)
  const md = markdownDocument(vm)
  assert.equal(items.some((i) => i.label.startsWith('Forecast ')), false)
  assert.equal(md.includes('## Forecast'), false)
  assert.equal(md.includes('## Local usage inside the current windows'), false)
  assert.equal(md.includes('### Attribution'), false)
  // The forecast itself still travels with the window and still reaches the window table.
  assert.ok(vm.quotas.some((q) => q.windows.some((w) => w.forecast !== null)))
  assert.ok(md.includes('| Window | Used | Elapsed | Pace | Resets | Forecast |'), md.slice(0, 400))
})

test('cache economy and the digest survive into both renderings', () => {
  const vm = fullVm()
  const items = quickPickItems(vm)
  const md = markdownDocument(vm)
  assert.equal(items.filter((i) => i.label.startsWith('Cache economy ')).length, vm.cacheEconomy.length)
  assert.equal(rowsOf(md, '## Cache economy — last 30 days').length, vm.cacheEconomy.length)
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

test('the markdown prints each window\'s subagent share under the window table, named by its window (1.6 N7)', () => {
  const history = makeHistory()
  fillHistory(history)
  const vm = buildViewModel(makeInput({ agg: agentShareAgg(), history }))
  const lines = markdownDocument(vm).split('\n')
  const claude = lines.findIndex((l) => l.startsWith('### Claude Code'))
  assert.ok(claude >= 0, lines.slice(0, 20).join('\n'))
  const head = lines.indexOf('| Window | Used | Elapsed | Pace | Resets | Forecast |', claude)
  // The table, a blank line, then one line per window with a share, in the table's order.
  let end = head + 2
  while (lines[end].startsWith('| ')) end++
  assert.equal(lines[end], '')
  assert.deepEqual(lines.slice(end + 1, end + 4), [
    '- 5 h: subagents 5.5K of 7K counted here (79 %)',
    '- 7 d: subagents 5.5K of 11K counted here (50 %)',
    '',
  ])
  // Codex: no line — its card is followed by its own table and nothing that names subagents.
  const codex = lines.findIndex((l, i) => i > claude && l.startsWith('### Codex'))
  assert.ok(codex > claude)
  assert.equal(lines.slice(codex).some((l) => l.includes('subagents') && l.includes('counted here')), false)
  // Only a window with a share gets a line: none at all without one.
  const bare = markdownDocument(buildViewModel(makeInput({ agg: new Aggregator() })))
  assert.equal(bare.includes('counted here'), false)
})

// 1.10 B2 D6 (pinned and changed: "Agent records, last 7 days", "a record keeps a whole agent"): an agent's data is an
// entry; a record is a personal best (the Records section).
test('the data-quality line of the subagent tokens and its note reach both renderings (1.6 N7)', () => {
  const vm = buildViewModel(makeInput({ agg: agentShareAgg() }))
  const md = markdownDocument(vm)
  const line = 'Agent entries, last 7 days: 7.5K · Subagent tokens in the hour buckets, last 7 days: 5.5K'
  const note = 'The two differ by construction: an agent entry keeps a whole agent, a bucket the hour of each reply.'
  const dq = md.slice(md.indexOf('## Data quality'))
  const bullets = dq.split('\n').filter((l) => l.startsWith('- '))
  // After the lower-bound line, as the dashboard lists it, the note right under it.
  const at = bullets.indexOf(`- ${line}`)
  assert.ok(at > 0, dq)
  assert.ok(bullets[at - 1].startsWith('- Lower bound share: '), bullets[at - 1])
  assert.equal(bullets[at + 1], `- ${note}`)
  const labels = quickPickItems(vm).map((i) => i.label)
  assert.ok(labels.includes(line), labels.join('\n'))
  assert.ok(labels.includes(note))
  // Nothing to compare, no line.
  const none = markdownDocument(buildViewModel(makeInput()))
  assert.equal(none.includes('Agent entries, last 7 days'), false)
  assert.equal(md.includes('Agent records'), false)
})

test('a model\'s Quick Pick detail names its turn figure a time — Avg turn time, Ø Turn-Dauer (1.10 B2 D5)', () => {
  const vm = fullVm()
  assert.ok(vm.models.rows.length > 0)
  vm.models.rows = [{ ...vm.models.rows[0], turnAvg: '~42 s', turnP90: '~1 min 10 s' }]
  const detail = (): string | undefined => quickPickItems(vm).find((i) => i.label.startsWith(`${vm.models.rows[0].model}`))?.detail
  assert.ok(detail()?.endsWith(' · Avg turn time ~42 s · P90 ~1 min 10 s'), detail())
  const bundle = JSON.parse(readFileSync(path.join(ROOT, 'l10n', 'bundle.l10n.de.json'), 'utf8')) as Record<string, string>
  try {
    setBundle(bundle)
    assert.ok(detail()?.endsWith(' · Ø Turn-Dauer ~42 s · P90 ~1 min 10 s'), detail())
  } finally {
    setBundle(undefined)
  }
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
  for (const want of ['Quota', 'Key figures', 'Tokens', 'Cache', 'Models', 'Data quality', 'Actions']) {
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
  // The rule reads `retro.enough`, not the sentence: the sentence is translated, and a rule
  // that matched English words would keep every row in every other language.
  assert.ok(vm.retro.length > 0)
  assert.ok(vm.retro.every((r) => !r.retro.enough))
  assert.ok(vm.retro.every((r) => r.text.startsWith('not enough data')))
  assert.equal(quickPickItems(vm).some((i) => i.label.startsWith('Reset history ')), false)
  assert.equal(quickPickItems(vm).some((i) => i.separator && i.label === 'Reset history'), false)
  // The markdown document keeps them: it is read by scrolling, not by filtering.
  assert.ok(markdownDocument(vm).includes('## Reset history'))

  // One window with a real retrospective and the whole group comes back, named.
  const answered = {
    ...vm,
    retro: vm.retro.map((r, i) => (i === 0
      ? {
        ...r,
        retro: { ...r.retro, enough: true },
        text: '50 % of the complete cycles hit the limit · Avg 12 % unused at the reset',
      }
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
  for (const heading of ['## Summary', '## Quota', '## Key figures', '## Cache economy — last 30 days',
    '## Calendar', '## Models', '## Activity', '## Data quality']) {
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
  // The detail line is the reset time alone, and says the word once.
  for (const item of quickPickItems(vm)) {
    assert.equal(/reset · reset\b/.test(item.detail ?? ''), false, item.detail)
  }
})

test('a measuring window leaves no sentence in either text view, and the rate line is gone', () => {
  const history = makeHistory()
  fillHistory(history)
  const vm = buildViewModel(makeInput({
    history,
    quotas: [state('claude', { windows: [win({ percent: 3, resetsAt: NOW + 5 * 3_600_000 - 30_000, windowMinutes: 300 })] })],
  }))
  const w = vm.quotas[0].windows[0]
  assert.equal(w.verdict.measuring, true)
  assert.equal(w.forecast?.state, 'measuring')
  const item = quickPickItems(vm).find((i) => /[█▁▏▎▍▌▋▊▉┃]/.test(i.label))
  assert.ok(item)
  assert.equal(/measuring/.test(item.description ?? ''), false, item.description)
  // The reset time still prints, once, as a clock time.
  assert.match(item.detail ?? '', /^reset at \d/)
  assert.equal((item.detail ?? '').split('reset').length - 1, 1, item.detail)
  const md = markdownDocument(vm)
  const row = md.split('\n').find((l) => l.startsWith('|') && l.includes('`')) ?? ''
  assert.equal(/measuring/.test(row), false, row)
  // The pace column is an absent figure, not a sentence about the measuring.
  assert.match(row, /\| – \| 4h59m \|/, row)
  // The markdown keeps the freshness row the dashboard card dropped, and the official page.
  assert.ok(md.includes('Freshness — last check'), md)
  assert.ok(md.includes('\nOfficial page: https://claude.ai/settings/usage\n'), md)
  // Nothing anywhere says "measuring · window just reset" / "measuring · N readings over …".
  // (`pickText` joins label, description and detail with " · ", so "measuring · 9 readings" is
  // the join of two fields, not a sentence — the sentences are matched by their own words.)
  for (const text of [pickText(vm), md]) {
    assert.equal(/measuring · (window|\d+ readings? over)|readings? over|just reset|just started/.test(text), false, text)
  }
  // The "keeps it to the reset" rate is gone from both views.
  for (const text of [pickText(vm), md, pickText(fullVm()), markdownDocument(fullVm())]) {
    assert.equal(text.includes('keeps it to the reset'), false)
    assert.equal(text.includes('Sustainable'), false)
  }
})

test('the official page is a line of the markdown only while the setting allows the link', () => {
  const linked = markdownDocument(buildViewModel(makeInput()))
  assert.ok(linked.includes('Official page: https://claude.ai/settings/usage'), linked)
  const off = markdownDocument(buildViewModel(makeInput({
    cfg: makeConfig({ 'tokenPace.usagePageLinks': false }),
  })))
  assert.equal(off.includes('Official page'), false, off)
  assert.equal(off.includes('settings/usage'), false, off)
})

test('a measuring forecast on a paced window is dropped from the quota rows of both views', () => {
  // One reading only: the forecast measures while the verdict, two hours before the reset,
  // has a pace to report. The verdict stays; the forecast sentence does not appear.
  const history = makeHistory()
  history.add(state('claude'), FINGERPRINT, NOW - 60_000)
  const vm = buildViewModel(makeInput({ history, quotas: [state('claude')] }))
  const w = vm.quotas[0].windows[0]
  assert.equal(w.verdict.measuring, false)
  assert.equal(w.forecast?.state, 'measuring')
  const item = quickPickItems(vm).find((i) => /[█▁▏▎▍▌▋▊▉┃]/.test(i.label))
  assert.ok(item)
  assert.ok((item.description ?? '').includes(w.verdict.text), item.description)
  assert.equal(/measuring|reading/.test(item.description ?? ''), false, item.description)
  const row = markdownDocument(vm).split('\n').find((l) => l.startsWith('|') && l.includes('`')) ?? ''
  assert.ok(row.includes(w.verdict.text), row)
  assert.equal(/measuring|reading/.test(row), false, row)
})

test('every window list that stands on its own names the provider it belongs to', () => {
  const vm = twinVm()
  // The premise: the label alone is ambiguous.
  const fives = vm.quotas.flatMap((q) => q.windows.filter((w) => w.label === '5 h'))
  assert.equal(fives.length, 2)
  assert.notEqual(vm.quotas[0].source, vm.quotas[1].source)

  const named = /(Claude Code|Codex)/
  const md = markdownDocument(vm)
  // The quota window tables sit under a provider heading, so they need no second name; the
  // reset history is the one list whose rows stand on their own.
  const heading = '## Reset history'
  const start = md.indexOf(heading)
  assert.notEqual(start, -1, heading)
  const block = md.slice(start, md.indexOf('\n#', start + 1))
  for (const line of block.split('\n')) {
    if (!line.startsWith('| ') && !line.startsWith('- **')) continue
    if (line.startsWith('| Window') || line.startsWith('|---')) continue
    assert.ok(named.test(line), `${heading}: ${line}`)
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
  for (const heading of ['## Cache economy — last 30 days', '## Composition — last 30 days']) {
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

// ---------------------------------------------------------------------------
// Why this colour, and the prompt-cache line
// ---------------------------------------------------------------------------

/** The Quota part of the document: up to the first heading every document carries after it. */
function quotaPart(md: string): string {
  return md.slice(md.indexOf('## Quota'), md.indexOf('## Key figures'))
}

test('every window\'s explanation reaches both text views, word for word', () => {
  const vm = fullVm()
  const md = markdownDocument(vm)
  const items = quickPickItems(vm)
  const windows = vm.quotas.flatMap((q) => q.windows)
  // One line per window under the table, in the dashboard's words and in the table's order.
  const bullets = quotaPart(md).split('\n').filter((l) => /^- \*\*.+\*\* — Why /.test(l))
  assert.equal(bullets.length, windows.length)
  windows.forEach((w, i) => {
    assert.ok(w.explain.lines.length >= 2, w.label)
    assert.equal(bullets[i], `- **${w.label}** — ${w.explain.title}: ${w.explain.lines.join(' ')}`)
  })
  // The Quick Pick carries the first two lines as the item detail, behind the reset time.
  const bar = /[█▁▏▎▍▌▋▊▉┃]/
  const rows = items.filter((i) => bar.test(i.label))
  assert.equal(rows.length, windows.length)
  windows.forEach((w, i) => {
    const detail = rows[i].detail ?? ''
    // A reset a day or more ahead carries its weekday ("Su 12:00"), a nearer one only a time.
    assert.match(detail, /^reset at ([A-Z][a-z] )?\d/, detail)
    assert.ok(detail.includes(` · ${w.explain.lines[0]} · ${w.explain.lines[1]}`), detail)
    // Two lines, not the whole panel: the stale line and the state stay with the document.
    assert.equal(detail.split(' · ').length, 3, detail)
  })
  // The unit is the header's, here too.
  for (const text of [md, ...items.map((i) => i.detail ?? '')]) assert.doesNotMatch(text, /\bpoints\b/i)
})

test('a window without a clock is explained without a pace in both views', () => {
  const vm = buildViewModel(makeInput({
    quotas: [state('claude', { windows: [win({ resetsAt: null, windowMinutes: null })] })],
  }))
  const item = quickPickItems(vm).find((i) => /[█▁▏▎▍▌▋▊▉┃]/.test(i.label))
  assert.ok(item)
  // No reset time, so the detail is the explanation alone.
  assert.equal(item.detail, 'Used 40 % of the window. · This window reports no reset time, so there is no pace; the colour follows the level only.')
  assert.ok(quotaPart(markdownDocument(vm)).includes('- **5 h** — Why green: Used 40 % of the window. This window reports no reset time'))
})

test('a mirror with text under every neighbouring key reaches neither the view model, the markdown nor the Quick Pick (1.8 §0a.1 leak test)', () => {
  const dir = scratchDir('tv-leak')
  const mirrorFile = path.join(dir, 'statusline-mirror.json')
  writeLeakyMirror(mirrorFile, NOW - 60_000, NOW)
  // The reading as the manager gets it: the adapter over the real reader, the mirror its only source.
  const extras = bestState('claude', {
    claudeOrder: ['statusline'], codexOrder: [], polled: {}, transcript: () => [], mirrorFile,
    claudeJsonFile: path.join(dir, 'none.json'), mode: 'cache',
  }, NOW).extras
  const promptCache = extras?.promptCache ?? null
  assert.equal(promptCache?.sessionId, LEAK_SESSION_ID)
  const vm = buildViewModel({ ...makeInput(), promptCache, context: extras?.context ?? null })
  assert.ok(vm.quotas[0].promptCache !== null, 'the prompt-cache line is missing')
  // 1.8 P6: the same reading watched per session — the mirror's 1 h cache, warm for 50 more minutes,
  // then cooling, then cold: the session is named, by the id's first eight characters and nothing more.
  const watched = [NOW, NOW + 46 * 60_000, NOW + 70 * 60_000].map((now) => buildViewModel({
    ...makeInput(), now, promptCache, promptCaches: promptCache ? [promptCache] : [], context: extras?.context ?? null,
  }))
  assert.deepEqual(watched.map((v) => v.quotas[0].cacheWatch?.all[0]?.phase), ['warm', 'cooling', 'cold'])
  for (const v of [vm, ...watched]) {
    for (const [what, text] of [['view model', JSON.stringify(v)], ['markdown', markdownDocument(v)],
      ['quick pick', JSON.stringify(quickPickItems(v))]] as const) {
      for (const secret of LEAK_STATUS_SECRETS) assert.equal(text.includes(secret), false, `the ${what} holds ${secret}`)
      assert.equal(text.includes(LEAK_SESSION_ID.slice(8)), false, `the ${what} holds the session id`)
    }
  }
  for (const v of watched) assert.ok(markdownDocument(v).includes('Session 9d0eb37a · prompt cache'), 'the watched session is not named')
  assert.ok(quickPickItems(watched[1]).some((i) => i.label.startsWith('Session 9d0eb37a · prompt cache cools in')))
})

test('the prompt-cache line is in both text views only while the bridge delivers it', () => {
  const cache = {
    warm: true, ttl: '5m' as const, expiresAt: NOW + 220_000, hitRatio: 0.82,
    readAt: Math.round((NOW - 60_000) / 1000), sessionId: null, recacheIfCold: null, model: null,
  }
  const vm = buildViewModel({ ...makeInput(), promptCache: cache })
  const text = 'prompt cache warm · expires in 3 m 40 s (5 min TTL) · hit ratio 82 %'
  const item = quickPickItems(vm).find((i) => i.label === text)
  assert.ok(item)
  // Its own age, beside the note: the card header's age belongs to whichever source won the
  // quota race, not to the mirror this line was read from.
  assert.equal(item.description, 'current session, via the status line · updated 1 min ago')
  assert.equal(item.command, undefined)
  const quota = quotaPart(markdownDocument(vm))
  const claude = quota.slice(quota.indexOf('### Claude Code'), quota.indexOf('### Codex'))
  assert.ok(claude.includes(`\n${text} — current session, via the status line · updated 1 min ago\n`), claude)
  // Under the windows and their explanations, before the freshness row — and once.
  assert.ok(claude.indexOf(text) > claude.lastIndexOf('- **7 d**'), claude)
  assert.ok(claude.indexOf(text) < claude.indexOf('Freshness —'), claude)
  assert.equal(quota.split('prompt cache').length - 1, 1, quota)
  // Without a reading nothing — not a dash line, and not a guess from the cache reads on file.
  const none = buildViewModel(makeInput())
  assert.equal(quickPickItems(none).some((i) => i.label.startsWith('prompt cache')), false)
  assert.equal(quotaPart(markdownDocument(none)).includes('prompt cache'), false)
})

test('a backslash before a pipe cannot split a markdown table cell', () => {
  const vm = fullVm()
  const row = vm.models.rows[0] as unknown as Record<string, unknown>
  const key = ['model', 'name', 'label'].find((k) => typeof row[k] === 'string')
  assert.ok(key, 'the model row has no name field')
  row[key!] = 'a\\|b'
  const md = markdownDocument(vm)
  // The backslash is escaped first, so the pipe after it is still escaped: a\\\\\\|b in the text.
  const line = md.split('\n').find((l: string) => l.includes('a\\\\\\|b'))
  assert.ok(line, md.split('\n').filter((l: string) => l.includes('a\\')).join(' / ') || '(no row carries the name)')
})

// ---------------------------------------------------------------------------
// The agent tree
// ---------------------------------------------------------------------------

/**
 * The fixture's session `sess-alpha` with one running subagent and one launch whose file was
 * not seen yet, in the shapes the aggregator hands out — laid over the fixture's aggregator,
 * whose session table names the project `alpha`.
 */
/**
 * A view model with one session, its running agent and a launch — and `text`, the tree the
 * markdown document is handed beside it (1.6 D3): every node open, where the view model's own
 * tree carries only what the dashboard has open, which here is nothing.
 */
function agentVm(select = false, over: Record<string, unknown> = {}): { vm: ViewModel; agentKey: string; text: AgentTreeVm } {
  const agg = buildAgg('project')
  const dir = path.dirname(CLAUDE_FILE)
  const sessionFile = path.join(dir, 'sess-alpha.jsonl')
  const counts = {
    input: 300, cacheWrite: 200, cacheWrite1h: 0, cacheRead: 5000, output: 700, reasoning: 0,
    requests: 5, outputFinal: 5, toolCalls: 3,
  }
  const main: MainRec = {
    source: 'claude', sessionId: 'sess-alpha', firstTs: NOW - 3 * 3_600_000, lastTs: NOW - 45 * 60_000,
    models: ['claude-opus-4-6'], ...counts, ccVersion: null, permissionMode: null, compactions: 0, lastCompaction: null, lastRequest: null,
    lastUserAt: null,
  }
  const agent: AgentRec = {
    source: 'claude', agentId: 'a94f0001', sessionId: 'sess-alpha', sessionFile, workflowId: null,
    meta: { agentType: 'Explore', model: 'opus', spawnDepth: 1, toolUseId: 'toolu_01', parentAgentId: null }, metaTries: 1,
    spawnerFile: sessionFile, firstTs: NOW - 20 * 60_000, lastTs: NOW - 60_000, models: ['claude-opus-4-6'],
    ...counts, outcome: null, outcomeTs: null, outcomeStatus: null, rejected: null, lastTool: null, lastToolTs: null, effort: null, efforts: [], lastContext: null, toolErrors: 0, cacheMisses: {}, cacheMissedTokens: 0, ccVersion: null, permissionMode: null, compactions: 0, lastCompaction: null,
  }
  const pending: AgentLaunch = {
    toolUseId: 'toolu_02', file: sessionFile, ts: NOW - 2 * 60_000, agentId: null, typeHint: 'Plan',
    modelHint: null, background: true, outcome: 'launched', outcomeTs: null, outcomeStatus: null, totals: null,
  }
  agg.mains = () => [main]
  agg.agents = () => [agent]
  agg.launches = () => [pending]
  const agentKey = 'a:a94f0001'
  const { ui: uiOver, ...cfgOver } = over as { ui?: Record<string, unknown> }
  const input = makeInput({
    agg, cfg: makeConfig({ 'tokenPace.attribution': 'project', ...cfgOver }),
    ui: { ...(select ? { agentSelected: agentKey } : {}), ...(uiOver ?? {}) },
  })
  const vm = buildViewModel(input)
  return { vm, agentKey, text: agentTreeFor(input, 'text') }
}

/** The lines of one `## ` section, heading excluded, up to the next `## ` heading. */
function sectionOf(md: string, heading: string): string[] {
  const lines = md.split('\n')
  const start = lines.indexOf(heading)
  assert.notEqual(start, -1, `section missing: ${heading}`)
  const end = lines.findIndex((l, i) => i > start && l.startsWith('## '))
  return lines.slice(start + 1, end === -1 ? undefined : end)
}

test('the agent tree reaches the markdown as an indented list, right after the quota, with the open node as a table', () => {
  const { vm, agentKey, text } = agentVm(true)
  assert.equal(vm.agents.selected?.key, agentKey)
  const md = markdownDocument(vm, text)
  const at = md.indexOf('## Agents')
  assert.ok(at > md.indexOf('## Quota'), 'the agents section comes after the quota')
  assert.ok(at < md.indexOf('## Key figures'))
  if (md.includes('## Summary')) assert.ok(at < md.indexOf('## Summary'), 'the dashboard puts agents before the summary')
  assert.equal(md.split('## Agents').length, 2)

  const lines = sectionOf(md, '## Agents')
  // The running list first, as on the dashboard: the inferred state marked as the tree marks
  // it, then label · where it sits · usage, the agent that started first on top, a launch
  // nothing was counted of as a dash.
  const now = lines.indexOf('### Running now')
  const tree = lines.indexOf('### Sessions and agents')
  assert.ok(now >= 0 && tree > now, lines.join('\n'))
  assert.deepEqual(lines.slice(now, tree).filter((l) => /^\s*- /.test(l)), [
    '- [~Running] Explore · claude-opus-4-6 · a94f · Session sess-alp · alpha · 1.2K',
    '- [~Running] Plan · – · launched · Session sess-alp · alpha · –',
  ])
  // The tree under a heading of its own: without it, a renderer reads the two lists as one.
  // Inferred states carry the estimate mark; its agent and the launch run, so the session,
  // quiet itself, is active through them. The markdown prints every node, open or not — the
  // tree built for it (1.6 D3), while the dashboard's has the session closed. A session names
  // its own figure and its agents' (1.6 D5), never their sum. Names are the tree's (1.6 N6): the
  // session by its first line, an agent with its model's whole id.
  assert.deepEqual(lines.slice(tree).filter((l) => /^\s*- /.test(l)), [
    '- [~Active] Session Thu 09:00 · sess-alp — alpha (2 started · ~2 ●) · own 1.2K · agents 1.2K · 2 h 15 min',
    // The newest first (1.6 N6): the launch came after the agent started.
    '  - [~Running] Plan · – · launched · – · –',
    '  - [~Running] Explore · claude-opus-4-6 · a94f · 1.2K · 19 min 00 s',
  ])
  assert.equal(lines[tree - 1], '', 'the list and the heading run together')
  // Nothing here is a lower bound, so the mark is not explained; nothing waits.
  assert.equal(lines.some((l) => l.includes('lower bound')), false)
  assert.equal(lines.some((l) => l.includes('(waiting)')), false)
  assert.equal(lines.some((l) => l.includes('No agent is running.')), false)

  const d = vm.agents.selected
  assert.ok(d)
  const head = lines.indexOf(`### ${d.title}`)
  assert.notEqual(head, -1, lines.join('\n'))
  assert.equal(lines[head + 2], '| Detail | Value |')
  assert.equal(lines[head + 3], '|---|---|')
  const rows = lines.slice(head + 4).filter((l) => l.startsWith('| '))
  // 1.6 P9 (L2, pinned and changed): the state, the line under it, every row — once each.
  assert.equal(rows.length, 2 + d.rows.length, 'the state, the overview and every row, once')
  assert.equal(rows[0], `| State | ${d.stateText} |`)
  assert.ok(d.overview)
  assert.equal(rows[1], `| Summary | ${d.overview} |`)
  assert.equal(d.overview, '1.2K in 19 min 00 s · 5 requests · 3 tool calls')
  // The token mix is its words in the table; the bar is the page's.
  const mix = d.rows.find((r) => r.kind === 'bar')
  assert.ok(mix)
  assert.ok(rows.includes(`| Token mix | ${mix.value} |`), rows.join('\n'))
  assert.match(mix.value, /^fresh \d+ % · (cache write \d+ % · )?(cache read \d+ % · )?output \d+ %$/)
  assert.ok(rows.includes('| Type | Explore |'), rows.join('\n'))
  assert.ok(rows.includes('| Last activity | 11:59 · 1 min ago |'), rows.join('\n'))
  assert.ok(rows.includes('| Spawned by | Session Thu 09:00 · sess-alp |'), rows.join('\n'))

  // Nothing selected: the lists and no table.
  const quiet = agentVm()
  const plain = markdownDocument(quiet.vm, quiet.text)
  assert.equal(sectionOf(plain, '## Agents').some((l) => detailsHead(l) || l.startsWith('| ')), false)
  // Without the document's own tree the page's is printed: here the closed session alone.
  const page = sectionOf(markdownDocument(vm), '## Agents')
  assert.deepEqual(page.slice(page.indexOf('### Sessions and agents')).filter((l) => /^\s*- /.test(l)),
    ['- [~Active] Session Thu 09:00 · sess-alp — alpha (2 started · ~2 ●) · own 1.2K · agents 1.2K · 2 h 15 min'])
})

test('an agent that ended on a rejected request: its sentence and its Last request row in the table, its session\'s count', () => {
  // 1.6 N3. The markdown prints the details the builder wrote, the sentence first; nothing on the
  // tree's lines — a rejection is a detail, not a figure.
  const agg = buildAgg('project')
  const dir = path.dirname(CLAUDE_FILE)
  const sessionFile = path.join(dir, 'sess-alpha.jsonl')
  const counts = {
    input: 300, cacheWrite: 200, cacheWrite1h: 0, cacheRead: 5000, output: 700, reasoning: 0,
    requests: 5, outputFinal: 5, toolCalls: 3,
  }
  const main: MainRec = {
    source: 'claude', sessionId: 'sess-alpha', firstTs: NOW - 3 * 3_600_000, lastTs: NOW - 45 * 60_000,
    models: ['claude-opus-4-6'], ...counts, ccVersion: null, permissionMode: null, compactions: 0, lastCompaction: null, lastRequest: null,
    lastUserAt: null,
  }
  const agent: AgentRec = {
    source: 'claude', agentId: 'a94f0001', sessionId: 'sess-alpha', sessionFile, workflowId: null,
    meta: { agentType: 'Explore', model: 'opus', spawnDepth: 1, toolUseId: 'toolu_01', parentAgentId: null }, metaTries: 1,
    spawnerFile: sessionFile, firstTs: NOW - 40 * 60_000, lastTs: NOW - 30 * 60_000, models: ['claude-opus-4-6'],
    ...counts, outcome: null, outcomeTs: null, outcomeStatus: null,
    rejected: { at: NOW - 29 * 60_000, status: 429, error: 'rate_limit', limit: 'five_hour' },
    lastTool: null, lastToolTs: null, effort: null, efforts: [], lastContext: null, toolErrors: 0, cacheMisses: {}, cacheMissedTokens: 0, ccVersion: null, permissionMode: null, compactions: 0, lastCompaction: null,
  }
  agg.mains = () => [main]
  agg.agents = () => [agent]
  agg.launches = () => []
  const cfg = makeConfig({ 'tokenPace.attribution': 'project' })
  const doc = (key: string): string[] => {
    const input = makeInput({ agg, cfg, ui: { agentSelected: key } })
    return sectionOf(markdownDocument(buildViewModel(input), agentTreeFor(input, 'text')), '## Agents')
  }
  const lines = doc('a:a94f0001')
  const rows = lines.filter((l) => l.startsWith('| '))
  assert.equal(rows[0], '| Detail | Value |')
  assert.equal(rows[1], '| State | Unknown — inferred: no result was recorded; the last request, at 11:31, was rejected — 5-hour limit (HTTP 429). |')
  assert.ok(rows.includes('| Last request | rejected at 11:31 — 5-hour limit (HTTP 429) |'), rows.join('\n'))
  assert.ok(rows.includes('| Last activity | 11:31 · 29 min ago |'), rows.join('\n'))
  // 1.7 F2 (pinned and changed): the session, three quarters of an hour quiet, is an earlier one —
  // in the group of earlier sessions, a depth-0 item without a state; its agent two levels in.
  assert.ok(lines.includes('- Earlier sessions (1) (1 started · ~1 ?)'), lines.join('\n'))
  assert.ok(lines.includes('    - [~Unknown] Explore · claude-opus-4-6 · a94f · 1.2K · 11 min 00 s'), lines.join('\n'))
  const session = doc('s:sess-alpha').filter((l) => l.startsWith('| '))
  assert.ok(session.includes('| Ended on a rejected request | 5-hour limit (HTTP 429): 1 |'), session.join('\n'))
})

/** A `### ` heading of the Agents section other than its two fixed ones: a details table's. */
function detailsHead(line: string): boolean {
  return line.startsWith('### ') && line !== '### Running now' && line !== '### Sessions and agents'
}

/** One RunningItem, in the shape src/agentTree.ts gives it. */
function runningItem(over: Partial<RunningItem> = {}): RunningItem {
  return {
    // 1.6 N6: the row's name has the model short, `fullLabel` the whole id the markdown prints.
    key: 'a:a94f0001', kind: 'agent', label: 'Explore · opus-5 · a94f',
    fullLabel: over.fullLabel ?? over.label ?? 'Explore · claude-opus-5 · a94f',
    context: 'Session 12345678 · Workflow run cfe7718d',
    usage: '12.3K', lowerBound: false, lowerBoundText: null, startTs: NOW - 300_000, lastTs: NOW - 5_000, startClock: '11:55', lastClock: '11:59',
    waiting: false, silence: true, hookWait: null, running: 1, ...over,
  }
}

test('the running list prints every item, marks the waiting ones and the lower bounds, counts the rest, and escapes what could break the line', () => {
  const { vm } = agentVm()
  const agents: AgentTreeVm = {
    ...vm.agents,
    runningNow: [
      runningItem({ waiting: true, lowerBound: true, label: 'general-purpose · claude-opus-5 · b1c2', key: 'a:b1c2' }),
      runningItem(),
      runningItem({ kind: 'pending', key: 'l:toolu_03', label: 'Plan · sonnet · launched', usage: '–', context: 'Session 12345678' }),
      runningItem({ key: 'a:c3d4', label: 'Explore | a\nb', context: 'Session 12345678 · pro|ject' }),
      // 1.6 D4: a run's collector — one line for its agents without a counted reply, and how many run.
      runningItem({ kind: 'noreply', key: 'n:12345678|wf_cfe7718d', label: '263 agent(s) without a counted reply', usage: '–', running: 10 }),
      runningItem({ kind: 'noreply', key: 'n:12345678|wf_0133faf9', label: '2 agent(s) without a counted reply', usage: '–', running: 1 }),
    ],
    runningMore: 3,
  }
  const lines = sectionOf(markdownDocument({ ...vm, agents }), '## Agents')
  const now = lines.indexOf('### Running now')
  const tree = lines.indexOf('### Sessions and agents')
  assert.ok(now >= 0 && tree > now, lines.join('\n'))
  // Every item is running, which is inferred: the tree's mark, word for word. A usage that is
  // a lower bound carries ⚠ behind it, as on the tree's lines.
  assert.deepEqual(lines.slice(now + 1, tree).filter(Boolean), [
    '- [~Running] general-purpose · claude-opus-5 · b1c2 · Session 12345678 · Workflow run cfe7718d · 12.3K ⚠ (waiting)',
    '- [~Running] Explore · claude-opus-5 · a94f · Session 12345678 · Workflow run cfe7718d · 12.3K',
    '- [~Running] Plan · sonnet · launched · Session 12345678 · –',
    // A pipe and a newline stay text: one item, one line.
    '- [~Running] Explore \\| a b · Session 12345678 · pro\\|ject · 12.3K',
    '- [~Running] 263 agent(s) without a counted reply · Session 12345678 · Workflow run cfe7718d · – (~10 of them running)',
    '- [~Running] 2 agent(s) without a counted reply · Session 12345678 · Workflow run cfe7718d · – (~1 of them running)',
    '_and 3 more_',
  ])
  // The mark is explained under the tree, once, although no line of the tree carries it.
  assert.equal(agents.roots.some(function bound(n): boolean { return n.lowerBound || n.children.some(bound) }), false)
  assert.equal(lines.filter((l) => l.startsWith('_⚠ marks a lower bound')).length, 1, lines.join('\n'))
  // Only what was left out is counted; nothing claims a zero.
  const counted = sectionOf(markdownDocument({ ...vm, agents: { ...agents, runningMore: 0 } }), '## Agents')
  assert.equal(counted.some((l) => l.includes('more_')), false)
  // Everything left out and nothing listed still heads the list and says how many.
  const onlyMore = sectionOf(markdownDocument({ ...vm, agents: { ...agents, runningNow: [], runningMore: 2 } }), '## Agents')
  assert.ok(onlyMore.includes('### Running now') && onlyMore.includes('_and 2 more_'), onlyMore.join('\n'))
  assert.equal(onlyMore.includes('_No agent is running._'), false)
})

test('an agent of a session the tree does not list is on its running line alone, marked, and its ⚠ explained', () => {
  // The oldest of MAX_ROOTS + 1 sessions is not listed; its running agent is mid-reply. Its
  // running line is the only line the document has for it, so that line carries the mark and
  // the note under the tree explains it.
  const agg = buildAgg('project')
  const dir = path.dirname(CLAUDE_FILE)
  // 1.7 F2 (pinned and changed): ten seconds apart, so every one of them is active and the oldest is
  // beyond MAX_ROOTS; a minute apart, the eleventh on would be earlier sessions, in the group.
  const mains: MainRec[] = Array.from({ length: MAX_ROOTS + 1 }, (_, i) => ({
    source: 'claude', sessionId: `${String(i).padStart(8, '0')}-s`, firstTs: NOW - 3_600_000,
    lastTs: NOW - (i + 1) * 10_000, models: ['claude-opus-4-6'], input: 10, cacheWrite: 0, cacheWrite1h: 0,
    cacheRead: 0, output: 5, reasoning: 0, requests: 1, outputFinal: 1, toolCalls: 0,
    ccVersion: null, permissionMode: null, compactions: 0, lastCompaction: null, lastRequest: null, lastUserAt: null,
  }))
  const oldest = mains[MAX_ROOTS].sessionId
  const agent: AgentRec = {
    source: 'claude', agentId: 'f00d0001', sessionId: oldest, sessionFile: path.join(dir, `${oldest}.jsonl`),
    workflowId: null, meta: null, metaTries: 3, spawnerFile: null, firstTs: NOW - 10 * 60_000, lastTs: NOW - 30_000,
    models: ['claude-opus-4-6'], input: 300, cacheWrite: 200, cacheWrite1h: 0, cacheRead: 5000, output: 700,
    reasoning: 0, requests: 5, outputFinal: 4, toolCalls: 3, outcome: null, outcomeTs: null, outcomeStatus: null, rejected: null,
    lastTool: null, lastToolTs: null, effort: null, efforts: [], lastContext: null, toolErrors: 0, cacheMisses: {}, cacheMissedTokens: 0, ccVersion: null, permissionMode: null, compactions: 0, lastCompaction: null,
  }
  agg.mains = () => mains
  agg.agents = () => [agent]
  agg.launches = () => []
  const vm = buildViewModel(makeInput({ agg, cfg: makeConfig({ 'tokenPace.attribution': 'none' }) }))
  assert.equal(vm.agents.omittedRoots, 1)
  const lines = sectionOf(markdownDocument(vm), '## Agents')
  const tree = lines.indexOf('### Sessions and agents')
  assert.ok(tree > 0, lines.join('\n'))
  assert.equal(lines.slice(tree).some((l) => l.includes('f00d')), false, 'the agent is on the tree')
  assert.deepEqual(lines.slice(0, tree).filter((l) => l.startsWith('- ')),
    ['- [~Running] Agent · claude-opus-4-6 · f00d · Session 00000020 · 1.2K ⚠'])
  // No line of the tree is a lower bound: the note is there for the running line.
  assert.equal(lines.slice(tree).some((l) => / ⚠ · /.test(l)), false, lines.join('\n'))
  assert.equal(lines.filter((l) => l.startsWith('_⚠ marks a lower bound')).length, 1, lines.join('\n'))
})

test('with nothing running the markdown says so in one line, and an older model without the list claims nothing', () => {
  const { vm } = agentVm()
  const quiet = sectionOf(markdownDocument({ ...vm, agents: { ...vm.agents, runningNow: [], runningMore: 0 } }), '## Agents')
  assert.ok(quiet.includes('_No agent is running._'), quiet.join('\n'))
  assert.equal(quiet.includes('### Running now'), false, 'a heading over nothing')
  // The tree keeps its heading, under the line.
  assert.ok(quiet.indexOf('### Sessions and agents') > quiet.indexOf('_No agent is running._'), quiet.join('\n'))
  assert.ok(quiet.some((l) => l.startsWith('- [~')), quiet.join('\n'))
  // A tree from a build before the list: no list, no line about one, and the tree as it was.
  const older = { ...vm.agents } as Partial<AgentTreeVm>
  delete older.runningNow
  delete older.runningMore
  const old = sectionOf(markdownDocument({ ...vm, agents: older as AgentTreeVm }), '## Agents')
  assert.equal(old.some((l) => l.startsWith('### ') || l.includes('No agent is running')), false, old.join('\n'))
  assert.ok(old.some((l) => l.startsWith('- [~Active] Session Thu 09:00 · sess-alp')), old.join('\n'))
})

// 1.6 P3a (§3 D3): pinned "Tree cut at {0} nodes." among the notes; there is no cut any more — what
// a node leaves out is said under its children (see the next test).
test('the notes under the tree state the sessions left out, the lower bound and a stale selection', () => {
  const { vm } = agentVm()
  const tree: AgentTreeVm = {
    roots: [{
      key: 's:/p/s.jsonl', kind: 'session', label: 'Session 12345678', fullLabel: 'Session 12345678', sub: null, state: 'done', derived: false,
      usage: '12K', usageAgents: null, lowerBound: true, lowerBoundText: '⚠ lower bound — 1 of 3 replies unfinished', silence: false, hookWait: null, duration: '4 min 05 s', startTs: NOW - 300_000, lastTs: NOW - 60_000,
      startClock: null, lastClock: null,
      agentCount: 0, hasChildren: false, childrenTotal: 0, childrenMore: 0,
      tally: null, tallyText: null, tallySpoken: null, tallyParts: null, superseded: false, children: [],
    }],
    selected: null,
    running: 0,
    runningNow: [],
    runningMore: 0,
    omittedRoots: 3,
    note: 'The selected node is no longer in the tree.',
    week: null,
  }
  const lines = sectionOf(markdownDocument({ ...vm, agents: tree }), '## Agents')
  // A recorded state carries no estimate mark; a lower bound carries ⚠ behind the figure.
  // A session without agents prints its own figure alone, the ⚠ behind it.
  assert.ok(lines.includes('- [Done] Session 12345678 · own 12K ⚠ · 4 min 05 s'), lines.join('\n'))
  for (const note of [
    '_3 older session(s) not listed._',
    // 1.6 D10: the note's words, once at the end.
    '_⚠ marks a lower bound: some replies were never marked finished, and only the output written up to then is counted._',
    '_The selected node is no longer in the tree._',
  ]) assert.ok(lines.includes(note), `${note}\n${lines.join('\n')}`)
  assert.equal(lines.some((l) => l.includes('Tree cut')), false)
  assert.equal(lines.some(detailsHead), false)
})

test('the markdown prints every node of its tree, fifty children a node, and says how many more there are', () => {
  // 1.6 D3: the document is handed the tree with every node open; a node with more than fifty
  // children prints fifty and one line at their depth for the rest — in the reader's digits.
  const agg = buildAgg('none')
  const dir = path.dirname(CLAUDE_FILE)
  const sessionFile = path.join(dir, 'sess-alpha.jsonl')
  const counts = {
    input: 300, cacheWrite: 200, cacheWrite1h: 0, cacheRead: 5000, output: 700, reasoning: 0,
    requests: 5, outputFinal: 5, toolCalls: 3,
  }
  const main: MainRec = {
    source: 'claude', sessionId: 'sess-alpha', firstTs: NOW - 3 * 3_600_000, lastTs: NOW - 45 * 60_000,
    models: ['claude-opus-4-6'], ...counts, ccVersion: null, permissionMode: null, compactions: 0, lastCompaction: null, lastRequest: null,
    lastUserAt: null,
  }
  const agents: AgentRec[] = Array.from({ length: 1234 }, (_, i) => ({
    source: 'claude', agentId: `a${i.toString(16).padStart(16, '0')}`, sessionId: 'sess-alpha', sessionFile, workflowId: null,
    meta: { agentType: 'Explore', model: 'opus', spawnDepth: 1, toolUseId: null, parentAgentId: null }, metaTries: 1,
    spawnerFile: sessionFile, firstTs: NOW - 2 * 3_600_000 + i * 1000, lastTs: NOW - 3_600_000, models: ['claude-opus-4-6'],
    ...counts, outcome: 'completed', outcomeTs: NOW - 3_600_000, outcomeStatus: 'completed', rejected: null,
    lastTool: null, lastToolTs: null, effort: null, efforts: [], lastContext: null, toolErrors: 0, cacheMisses: {}, cacheMissedTokens: 0, ccVersion: null, permissionMode: null, compactions: 0, lastCompaction: null,
  }))
  agg.mains = () => [main]
  agg.agents = () => agents
  agg.launches = () => []
  const input = makeInput({ agg })
  const vm = buildViewModel(input)
  const text = agentTreeFor(input, 'text')
  const lines = (md: string, head: string, tree: string): string[] => {
    const all = sectionOf(md, head)
    return all.slice(Math.max(0, all.indexOf(tree))).filter((l) => /^\s*- /.test(l))
  }
  const printed = lines(markdownDocument(vm, text), '## Agents', '### Sessions and agents')
  // 1.7 F2 (pinned and changed): the idle session is an earlier one, one level in under the group of
  // earlier sessions — the group's line first, its tally the session's; the session's agents two
  // levels in, and so is the line for the rest.
  assert.equal(printed.length, 2 + MAX_GROUP_CHILDREN + 1, printed.slice(0, 3).join('\n'))
  assert.equal(printed[0], '- Earlier sessions (1) (1,234 started · 1,234 ✓)')
  assert.ok(printed[1].startsWith('  - [~Idle] Session Thu 09:00 · sess-alp') && printed[1].includes(' (1,234 started · 1,234 ✓) · '), printed[1])
  assert.ok(printed.slice(2, 2 + MAX_GROUP_CHILDREN).every((l) => l.startsWith('    - [Done] Explore · claude-opus-4-6 · ')), printed[2])
  // The fifty the document prints are the newest fifty (1.6 N6): the last started, agent 1233 (0x4d1), first.
  assert.equal(printed[2], '    - [Done] Explore · claude-opus-4-6 · 00000000000004d1 · 1.2K · 39 min 27 s')
  assert.equal(printed[printed.length - 1], `    - … ${(1234 - MAX_GROUP_CHILDREN).toLocaleString('en-US')} more`)
  // The page's own tree: the group closed, nothing below it, nothing more to say.
  assert.deepEqual(lines(markdownDocument(vm), '## Agents', '### Sessions and agents'), ['- Earlier sessions (1) (1,234 started · 1,234 ✓)'])
  const bundle = JSON.parse(readFileSync(path.join(ROOT, 'l10n', 'bundle.l10n.de.json'), 'utf8')) as Record<string, string>
  let md = ''
  try {
    setBundle(bundle)
    setLocale('de')
    md = markdownDocument(buildViewModel(input), agentTreeFor(input, 'text'))
  } finally {
    setBundle(undefined)
    setLocale(undefined)
  }
  const german = lines(md, '## Agenten', '### Sitzungen und Agenten')
  assert.equal(german[german.length - 1], '    - … 1.184 weitere', german.slice(-2).join('\n'))
  assert.equal(german[0], '- Frühere Sitzungen (1) (1.234 gestartet · 1.234 ✓)')
})

test('the 7-day block reaches the markdown between the running list and the tree while it is open — its cost column only with costs (1.6 L3)', () => {
  // Closed, as the dashboard starts: no block in the document either.
  const closed = agentVm()
  assert.equal(sectionOf(markdownDocument(closed.vm, closed.text), '## Agents').some((l) => l.includes('Last 7 days')), false)
  const { vm, text, agentKey } = agentVm(false, { ui: { agentsWeekOpen: true } })
  const lines = sectionOf(markdownDocument(vm, text), '## Agents')
  const head = lines.indexOf('### Last 7 days · where the agent tokens went')
  assert.ok(head > lines.indexOf('### Running now') && head < lines.indexOf('### Sessions and agents'), lines.join('\n'))
  const block = lines.slice(head, lines.indexOf('### Sessions and agents'))
  const cost = vm.agents.week?.rows[0].cost
  assert.match(cost ?? '', /^~\$/)
  assert.deepEqual(block, [
    '### Last 7 days · where the agent tokens went',
    '',
    '| Type · model | Agents | Usage | Share | Median per agent | ~Cost |',
    '|---|---|---|---|---|---|',
    // The model's whole id, as every line of the document writes it.
    `| Explore · claude-opus-4-6 | 1 | 1.2K | 100 % | 1.2K | ${cost} |`,
    `| All agents | 1 | 1.2K |  |  | ${cost} |`,
    '',
    '#### The largest agent',
    '',
    `- [~Running] Explore · claude-opus-4-6 · a94f · Session sess-alp · alpha · 1.2K · 100 % · ${cost}`,
    '',
  ])
  assert.equal(vm.agents.week?.top[0].key, agentKey)
  // Costs off: no cost column, no amount.
  const off = agentVm(false, { ui: { agentsWeekOpen: true }, 'tokenPace.showCost': false })
  const noCost = sectionOf(markdownDocument(off.vm, off.text), '## Agents')
  const at = noCost.indexOf('### Last 7 days · where the agent tokens went')
  const plain = noCost.slice(at, noCost.indexOf('### Sessions and agents'))
  assert.equal(plain[2], '| Type · model | Agents | Usage | Share | Median per agent |')
  assert.equal(plain[3], '|---|---|---|---|---|')
  assert.equal(plain.join('\n').includes('$'), false, plain.join('\n'))
  assert.equal(plain[9], '- [~Running] Explore · claude-opus-4-6 · a94f · Session sess-alp · alpha · 1.2K · 100 %')
  // The page's tree prints it too, as the dashboard has it.
  assert.ok(sectionOf(markdownDocument(vm), '## Agents').includes('### Last 7 days · where the agent tokens went'))
  // An empty block says so, and a view model without the block prints nothing of it.
  const empty = markdownDocument({ ...vm, agents: { ...vm.agents, week: { rows: [], other: null, top: [], total: '–', totalCost: null, agents: 0 } } })
  assert.ok(sectionOf(empty, '## Agents').includes('_No agent of the last 7 days has a counted request._'), empty)
  const none = markdownDocument({ ...vm, agents: { ...vm.agents, week: null } })
  assert.equal(sectionOf(none, '## Agents').some((l) => l.includes('Last 7 days')), false)
  // In German, with its pipes where the English has them.
  const bundle = JSON.parse(readFileSync(path.join(ROOT, 'l10n', 'bundle.l10n.de.json'), 'utf8')) as Record<string, string>
  let md = ''
  try {
    setBundle(bundle)
    setLocale('de')
    const de = agentVm(false, { ui: { agentsWeekOpen: true } })
    md = markdownDocument(de.vm, de.text)
  } finally {
    setBundle(undefined)
    setLocale(undefined)
  }
  const german = sectionOf(md, '## Agenten')
  const g = german.indexOf('### Letzte 7 Tage · wohin die Agent-Token gingen')
  assert.ok(g >= 0, german.join('\n'))
  assert.equal(german[g + 2], '| Typ · Modell | Agenten | Verbrauch | Anteil | Median je Agent | ~Kosten |')
  assert.ok(german[g + 5].startsWith('| Alle Agenten | 1 | 1,2K |'), german[g + 5])
  assert.equal(german[g + 7], '#### Der größte Agent')
})

test('a stop the parent recorded is printed [Stopped] — a recorded state, no estimate mark — in either language', () => {
  const { vm } = agentVm()
  const node = (key: string, state: TreeNode['state'], derived: boolean): TreeNode => ({
    key, kind: 'agent', label: `Explore · opus-4-6 · ${key.slice(2, 6)}`, fullLabel: `Explore · claude-opus-4-6 · ${key.slice(2, 6)}`,
    startClock: null, lastClock: null, sub: null, state, derived,
    usage: '3.4K', usageAgents: null, lowerBound: false, lowerBoundText: null, silence: false, hookWait: null, duration: '2 min 10 s', startTs: NOW - 300_000, lastTs: NOW - 60_000,
    agentCount: 0, hasChildren: false, childrenTotal: 0, childrenMore: 0,
    tally: null, tallyText: null, tallySpoken: null, tallyParts: null, superseded: false, children: [],
  })
  const tree: AgentTreeVm = {
    roots: [{ ...node('s:sess', 'idle', true), kind: 'session', label: 'Session 12345678', agentCount: 1,
      hasChildren: true, childrenTotal: 1, children: [node('a:beef0001', 'stopped', false)] }],
    selected: null, running: 0, runningNow: [], runningMore: 0, omittedRoots: 0, note: null, week: null,
  }
  const lines = sectionOf(markdownDocument({ ...vm, agents: tree }), '## Agents')
  assert.ok(lines.includes('  - [Stopped] Explore · claude-opus-4-6 · beef · 3.4K · 2 min 10 s'), lines.join('\n'))
  const bundle = JSON.parse(readFileSync(path.join(ROOT, 'l10n', 'bundle.l10n.de.json'), 'utf8')) as Record<string, string>
  let md = ''
  try {
    setBundle(bundle)
    setLocale('de')
    md = markdownDocument({ ...vm, agents: tree })
  } finally {
    setBundle(undefined)
    setLocale(undefined)
  }
  assert.ok(sectionOf(md, '## Agenten').includes('  - [Gestoppt] Explore · claude-opus-4-6 · beef · 3.4K · 2 min 10 s'), md)
})

test('the agent hook\'s marker is printed after the usage on the node\'s line, its running line and its Quick Pick row (1.6 O4)', () => {
  const { vm } = agentVm()
  const node = (key: string, kind: TreeNode['kind'], hookWait: string | null): TreeNode => ({
    key, kind, label: `Explore · opus-4-6 · ${key.slice(2, 6)}`, fullLabel: `Explore · claude-opus-4-6 · ${key.slice(2, 6)}`,
    startClock: null, lastClock: null, sub: null, state: kind === 'session' ? 'active' : 'running', derived: true,
    usage: '3.4K', usageAgents: null, lowerBound: false, lowerBoundText: null, silence: false, hookWait, duration: '2 min 10 s',
    startTs: NOW - 300_000, lastTs: NOW - 60_000, agentCount: 0, hasChildren: false, childrenTotal: 0, childrenMore: 0,
    tally: null, tallyText: null, tallySpoken: null, tallyParts: null, superseded: false, children: [],
  })
  const tree: AgentTreeVm = {
    roots: [{ ...node('s:sess', 'session', 'waiting for input'), label: 'Session 12345678', fullLabel: 'Session 12345678', agentCount: 2,
      hasChildren: true, childrenTotal: 2, children: [node('a:beef0001', 'agent', 'waiting for approval'), node('a:beef0002', 'agent', null)] }],
    selected: null, running: 2,
    runningNow: [runningItem({ key: 'a:beef0001', hookWait: 'waiting for approval', silence: false }), runningItem({ key: 'a:beef0002' })],
    runningMore: 0, omittedRoots: 0, note: null, week: null,
  }
  const lines = sectionOf(markdownDocument({ ...vm, agents: tree }), '## Agents')
  assert.ok(lines.includes('- [~Active] Session 12345678 · own 3.4K · waiting for input · 2 min 10 s'), lines.join('\n'))
  assert.ok(lines.includes('  - [~Running] Explore · claude-opus-4-6 · beef · 3.4K · waiting for approval · 2 min 10 s'), lines.join('\n'))
  assert.ok(lines.includes('  - [~Running] Explore · claude-opus-4-6 · beef · 3.4K · 2 min 10 s'), lines.join('\n'))
  assert.ok(lines.includes('- [~Running] Explore · claude-opus-5 · a94f · Session 12345678 · Workflow run cfe7718d · 12.3K · waiting for approval'),
    lines.join('\n'))
  assert.ok(lines.includes('- [~Running] Explore · claude-opus-5 · a94f · Session 12345678 · Workflow run cfe7718d · 12.3K'), lines.join('\n'))
  const pick = quickPickItems({ ...vm, agents: tree }).filter((i) => i.command === 'tokenPace.showDashboard' && /Explore/.test(i.label))
  assert.deepEqual(pick.map((i) => i.detail), ['Session 12345678 · Workflow run cfe7718d · waiting for approval', 'Session 12345678 · Workflow run cfe7718d'])
})

test('an attempt the workflow journal superseded says so at the end of its line, in either language', () => {
  // 1.6 D7 (P2b): the dashboard dims the row; the markdown has no dim, so the line says it.
  const { vm } = agentVm()
  const node = (key: string, state: TreeNode['state'], superseded: boolean): TreeNode => ({
    key, kind: 'agent', label: `workflow-subagent · opus-4-6 · ${key.slice(2, 6)}`, fullLabel: `workflow-subagent · claude-opus-4-6 · ${key.slice(2, 6)}`,
    startClock: null, lastClock: null, sub: null, state, derived: false,
    usage: '3.4K', usageAgents: null, lowerBound: false, lowerBoundText: null, silence: false, hookWait: null, duration: '2 min 10 s', startTs: NOW - 300_000, lastTs: NOW - 60_000,
    agentCount: 0, hasChildren: false, childrenTotal: 0, childrenMore: 0,
    tally: null, tallyText: null, tallySpoken: null, tallyParts: null, superseded, children: [],
  })
  const tree: AgentTreeVm = {
    roots: [{ ...node('s:sess', 'idle', false), kind: 'session', label: 'Session 12345678', derived: true, agentCount: 2,
      hasChildren: true, childrenTotal: 2, children: [node('a:beef0001', 'failed', true), node('a:beef0002', 'done', false)] }],
    selected: null, running: 0, runningNow: [], runningMore: 0, omittedRoots: 0, note: null, week: null,
  }
  const lines = sectionOf(markdownDocument({ ...vm, agents: tree }), '## Agents')
  assert.ok(lines.includes('  - [Failed] workflow-subagent · claude-opus-4-6 · beef · 3.4K · 2 min 10 s (superseded by a later attempt)'),
    lines.join('\n'))
  assert.ok(lines.includes('  - [Done] workflow-subagent · claude-opus-4-6 · beef · 3.4K · 2 min 10 s'), lines.join('\n'))
  const bundle = JSON.parse(readFileSync(path.join(ROOT, 'l10n', 'bundle.l10n.de.json'), 'utf8')) as Record<string, string>
  let md = ''
  try {
    setBundle(bundle)
    setLocale('de')
    md = markdownDocument({ ...vm, agents: tree })
  } finally {
    setBundle(undefined)
    setLocale(undefined)
  }
  assert.ok(sectionOf(md, '## Agenten')
    .includes('  - [Fehlgeschlagen] workflow-subagent · claude-opus-4-6 · beef · 3.4K · 2 min 10 s (durch einen späteren Versuch ersetzt)'), md)
})

test('the markdown prints a node\'s tally after its name, in brackets, and no tally where the tree has none', () => {
  // 1.6 N1: a session, a run and an agent with agents below it carry the tally of those agents;
  // the markdown prints every node, so each one's tally stands on its line, bracketed so its
  // counts do not run into the figures that follow.
  const { vm } = agentVm()
  const tallied = (text: string, spoken: string, t: Partial<Record<string, number>>) => ({
    tally: { started: 0, done: 0, failed: 0, retried: 0, stopped: 0, running: 0, unknown: 0, ...t }, tallyText: text, tallySpoken: spoken, tallyParts: null,
  })
  const node = (key: string, kind: TreeNode['kind'], label: string, state: TreeNode['state'], over: Partial<TreeNode> = {}): TreeNode => ({
    key, kind, label, fullLabel: label, startClock: null, lastClock: null, sub: null, state, derived: state !== 'done' && state !== 'failed' && state !== 'stopped',
    usage: '3.4K', usageAgents: null, lowerBound: false, lowerBoundText: null, silence: false, hookWait: null, duration: '2 min 10 s', startTs: NOW - 300_000, lastTs: NOW - 60_000,
    agentCount: 0, hasChildren: (over.children ?? []).length > 0, childrenTotal: (over.children ?? []).length, childrenMore: 0,
    tally: null, tallyText: null, tallySpoken: null, tallyParts: null, superseded: false, children: [], ...over,
  })
  const tree: AgentTreeVm = {
    roots: [node('s:sess', 'session', 'Session 12345678', 'active', {
      sub: 'alpha', usageAgents: '6.8K', agentCount: 4,
      ...tallied('4 started · 1 ✓ · 1 ↻ · ~2 ●', '4 started, 1 done, 1 retried, about 2 running', { started: 4, done: 1, retried: 1, running: 2 }),
      children: [
        node('w:sess|wf_cfe7718d', 'workflow', 'Workflow cfe7718d', 'running', {
          agentCount: 2, ...tallied('2 started · 1 ↻ · ~1 ●', '2 started, 1 retried, about 1 running', { started: 2, retried: 1, running: 1 }),
          children: [
            node('a:beef0001', 'agent', 'workflow-subagent · claude-opus-4-6 · beef', 'failed', { superseded: true }),
            node('a:beef0002', 'agent', 'workflow-subagent · claude-opus-4-6 · bee2', 'running'),
          ],
        }),
        node('a:cafe0001', 'agent', 'Explore · claude-opus-4-6 · cafe', 'done', {
          agentCount: 1, ...tallied('1 started · ~1 ●', '1 started, about 1 running', { started: 1, running: 1 }),
          children: [node('l:toolu_x', 'pending', 'Plan · – · launched', 'running', { usage: '–', duration: '–' })],
        }),
      ],
    })],
    selected: null, running: 2, runningNow: [], runningMore: 0, omittedRoots: 0, note: null, week: null,
  }
  const lines = sectionOf(markdownDocument({ ...vm, agents: tree }), '## Agents').filter((l) => /^\s*- /.test(l))
  assert.deepEqual(lines, [
    '- [~Active] Session 12345678 — alpha (4 started · 1 ✓ · 1 ↻ · ~2 ●) · own 3.4K · agents 6.8K · 2 min 10 s',
    '  - [~Running] Workflow cfe7718d (2 started · 1 ↻ · ~1 ●) · 3.4K · 2 min 10 s',
    '    - [Failed] workflow-subagent · claude-opus-4-6 · beef · 3.4K · 2 min 10 s (superseded by a later attempt)',
    '    - [~Running] workflow-subagent · claude-opus-4-6 · bee2 · 3.4K · 2 min 10 s',
    '  - [Done] Explore · claude-opus-4-6 · cafe (1 started · ~1 ●) · 3.4K · 2 min 10 s',
    '    - [~Running] Plan · – · launched · – · –',
  ])
  // The words are the view model's: a tree built in German prints its German tally.
  const bundle = JSON.parse(readFileSync(path.join(ROOT, 'l10n', 'bundle.l10n.de.json'), 'utf8')) as Record<string, string>
  let md = ''
  try {
    setBundle(bundle)
    setLocale('de')
    const de = agentVm()
    md = markdownDocument(de.vm, de.text)
  } finally {
    setBundle(undefined)
    setLocale(undefined)
  }
  assert.ok(sectionOf(md, '## Agenten').includes('- [~Aktiv] Sitzung Do 09:00 · sess-alp — alpha (2 gestartet · ~2 ●) · eigen 1,2K · Agenten 1,2K · 2 h 15 min'), md)
})

test('an empty tree is one sentence; a tree that was never built is no section at all', () => {
  const empty = markdownDocument(buildViewModel(makeInput({ agg: new Aggregator(), quotas: [] })))
  assert.deepEqual(sectionOf(empty, '## Agents').filter(Boolean), ['_No Claude Code session in the last 7 days._'])

  const { vm } = agentVm()
  // No note means nothing was claimed: an unbuilt tree is not an empty one.
  assert.equal(markdownDocument({ ...vm, agents: emptyAgentTree() }).includes('## Agents'), false)
  const without = { ...vm } as Partial<ViewModel>
  delete without.agents
  assert.equal(markdownDocument(without as ViewModel).includes('## Agents'), false)
})

test('the markdown tree speaks German with the shipped bundle', () => {
  const bundle = JSON.parse(readFileSync(path.join(ROOT, 'l10n', 'bundle.l10n.de.json'), 'utf8')) as Record<string, string>
  let md = ''
  try {
    setBundle(bundle)
    setLocale('de')
    const de = agentVm(true)
    md = markdownDocument(de.vm, de.text)
  } finally {
    setBundle(undefined)
    setLocale(undefined)
  }
  const lines = sectionOf(md, '## Agenten')
  assert.ok(lines.includes('- [~Aktiv] Sitzung Do 09:00 · sess-alp — alpha (2 gestartet · ~2 ●) · eigen 1,2K · Agenten 1,2K · 2 h 15 min'), lines.join('\n'))
  assert.ok(lines.includes('  - [~Läuft] Plan · – · gestartet · – · –'), lines.join('\n'))
  // The running list and the tree's heading, German too.
  assert.ok(lines.indexOf('### Laufen gerade') >= 0
    && lines.indexOf('### Sitzungen und Agenten') > lines.indexOf('### Laufen gerade'), lines.join('\n'))
  assert.ok(lines.includes('- [~Läuft] Plan · – · gestartet · Sitzung sess-alp · alpha · –'), lines.join('\n'))
  assert.equal(bundle['(waiting)'], '(wartet)')
  assert.equal(bundle['No agent is running.'], 'Kein Agent läuft gerade.')
  assert.equal(bundle['and {0} more'], 'und {0} weitere')
  assert.ok(lines.includes('| Detail | Wert |'), lines.join('\n'))
  assert.ok(lines.some((l) => l.startsWith('| Zustand | Läuft — abgeleitet: ')), lines.join('\n'))
  assert.ok(lines.includes('| Gestartet von | Sitzung Do 09:00 · sess-alp |'), lines.join('\n'))
})

test('a run\'s collector is one line of the markdown tree, the last under its run: its tally after its label, dashes for its figures', () => {
  // 1.6 D4, on the Agents world's records: its run's two agents without a counted reply — one
  // whose transcript holds only a rejected request, one the journal started with no transcript.
  const { agg } = agentWorld()
  const input = makeInput({ agg, cfg: makeConfig() })
  const print = (): string[] => sectionOf(markdownDocument(buildViewModel(input), agentTreeFor(input, 'text')), '## Agents')
  const lines = print()
  const tree = lines.slice(lines.indexOf('### Sessions and agents'))
  const run = tree.findIndex((l) => l.startsWith('  - [~Running] Workflow run ') && l.includes(' · cfe7718d '))
  assert.ok(run >= 0, tree.join('\n'))
  const under = tree.slice(run + 1).filter((l, i, all) => all.slice(0, i + 1).every((x) => x.startsWith('    - ')))
  assert.equal(under[under.length - 1], '    - [~Running] 2 agent(s) without a counted reply (2 started · 1 ✕ · ~1 ●) · – · –', under.join('\n'))
  assert.equal(under.filter((l) => l.includes('without a counted reply')).length, 1)
  // The running list: one line for both, saying how many of them run.
  assert.ok(lines.includes('- [~Running] 2 agent(s) without a counted reply · Session 3f9a2c1d · Workflow run cfe7718d · – (~1 of them running)'),
    lines.join('\n'))
  // In German.
  const bundle = JSON.parse(readFileSync(path.join(ROOT, 'l10n', 'bundle.l10n.de.json'), 'utf8')) as Record<string, string>
  let de: string[] = []
  try {
    setBundle(bundle)
    setLocale('de')
    de = sectionOf(markdownDocument(buildViewModel(input), agentTreeFor(input, 'text')), '## Agenten')
  } finally {
    setBundle(undefined)
    setLocale(undefined)
  }
  assert.ok(de.includes('    - [~Läuft] 2 Agent(en) ohne gezählte Antwort (2 gestartet · 1 ✕ · ~1 ●) · – · –'), de.join('\n'))
  assert.ok(de.includes('- [~Läuft] 2 Agent(en) ohne gezählte Antwort · Sitzung 3f9a2c1d · Workflow-Lauf cfe7718d · – (~1 davon läuft)'),
    de.join('\n'))
})

// ---------------------------------------------------------------------------
// 1.6 O2: the agents in the Quick Pick
// ---------------------------------------------------------------------------

/** The Quick Pick's Agents group: the rows after its heading, up to the next heading. */
function agentGroup(items: PickItem[], heading = 'Agents'): PickItem[] {
  const at = items.findIndex((i) => i.separator === true && i.label === heading)
  if (at < 0) return []
  const end = items.findIndex((i, n) => n > at && i.separator === true)
  return items.slice(at + 1, end < 0 ? undefined : end)
}

test('the Quick Pick names the running agents right after the quota, then what the sessions\' agents came to (1.6 O2)', () => {
  const { agg } = agentWorld()
  const vm = buildViewModel(makeInput({ agg, cfg: makeConfig() }))
  const items = quickPickItems(vm)
  const heads = items.filter((i) => i.separator === true).map((i) => i.label)
  // After the quota, before the summary — where the dashboard has the section.
  assert.equal(heads.indexOf('Agents'), heads.indexOf('Quota') + 1, heads.join(', '))
  const rows = agentGroup(items)
  // The running list's entries, in its order — the longest-running first — every one a way to
  // the dashboard: the running agent, the launch nobody has written to yet, the run's collector.
  const now = vm.agents.runningNow
  assert.ok(now.length >= 3 && now.length <= PICK_RUNNING_ITEMS, String(now.length))
  assert.deepEqual(rows.slice(0, now.length).map((i) => i.label), [
    '~workflow-subagent · claude-opus-4-6 · f6a7',
    '~Plan · sonnet · launched',
    // A collector's count of agents is exact, so the ~ goes on the ones that run.
    '2 agent(s) without a counted reply (~1 of them running)',
  ])
  for (const [n, r] of now.entries()) {
    const i = rows[n]
    assert.equal(i.description, `${r.usage}${r.lowerBound ? ' ⚠' : ''}`)
    assert.ok(i.detail?.startsWith(r.context), i.detail)
    assert.equal(i.command, 'tokenPace.showDashboard')
  }
  // Where it sits, and — for an output that is a lower bound — the tree's own words why.
  assert.equal(rows[0].detail, 'Session 3f9a2c1d · Workflow run cfe7718d · ⚠ lower bound — 1 of 2 replies unfinished')
  assert.equal(rows[1].detail, 'Session 3f9a2c1d')
  // Then the two sessions' tallies together, in glyphs and in words: 13 agents of the busy one, 1 of the quiet one.
  const tallies = vm.agents.roots.map((r) => r.tally)
  assert.deepEqual(tallies.map((x) => x?.started), [13, 1])
  const last = rows[rows.length - 1]
  assert.equal(rows.length, now.length + 1)
  assert.equal(last.label, 'Last 7 days: 14 started · 5 ✓ · 2 ✕ · 2 ↻ · 1 ■ · ~3 ● · ~1 ?')
  assert.equal(last.detail, '14 started, 5 done, 2 failed, 2 retried, 1 stopped, about 3 running, about 1 unknown')
  assert.equal(last.description, undefined)
  assert.equal(last.command, 'tokenPace.showDashboard')
  // Each field of the sum is the sessions' own, added — the running ones as the tree counts them.
  const sum = (k: 'started' | 'running'): number => tallies.reduce((n, x) => n + (x?.[k] ?? 0), 0)
  assert.equal(sum('started'), 14)
  assert.equal(sum('running'), vm.agents.running)
  // No share of a quota window: the agents are a list of their own (lead note on P10b).
  assert.equal(rows.some((i) => /counted here|%/.test(`${i.label} ${i.description ?? ''} ${i.detail ?? ''}`)), false)
})

test('past five running entries the Quick Pick names five and counts the rest in one row; nothing running, only the tally', () => {
  const { agg } = agentWorld()
  const vm = buildViewModel(makeInput({ agg, cfg: makeConfig() }))
  const one = vm.agents.runningNow[0]
  const many: RunningItem[] = Array.from({ length: 7 }, (_, n) => ({
    ...one, key: `a:x${n}`, label: `Explore · opus-5 · x${n}`, fullLabel: `Explore · claude-opus-5 · x${n}`,
    lowerBound: false, lowerBoundText: null, waiting: n === 1,
  }))
  const rows = agentGroup(quickPickItems({ ...vm, agents: { ...vm.agents, runningNow: many, runningMore: 3 } }))
  assert.equal(PICK_RUNNING_ITEMS, 5)
  assert.deepEqual(rows.slice(0, 5).map((i) => i.label), [0, 1, 2, 3, 4].map((n) => `~Explore · claude-opus-5 · x${n}`))
  // One that runs only because an agent below it does says so, as the running list does.
  assert.deepEqual(rows.slice(0, 3).map((i) => i.detail), [one.context, `${one.context} · waits for a child agent`, one.context])
  // The two listed entries not named here and the three the running list itself left out.
  assert.deepEqual(rows[5], { label: 'and 5 more', command: 'tokenPace.showDashboard' })
  assert.match(rows[6].label, /^Last 7 days: 14 started · /)
  assert.equal(rows.length, 7)
  // Nothing running: no row of the list, no "and 0 more" — the tally alone.
  const quiet = agentGroup(quickPickItems({ ...vm, agents: { ...vm.agents, runningNow: [], runningMore: 0 } }))
  assert.equal(quiet.length, 1)
  assert.match(quiet[0].label, /^Last 7 days: 14 started · .* · ~1 \?$/)
})

test('without a session the Quick Pick says what the tree says; sessions without agents, or no tree, leave no group behind', () => {
  // No session at all: the tree's note, as the section's.
  const empty = buildViewModel(makeInput({ agg: new Aggregator(), quotas: [] }))
  assert.deepEqual(agentGroup(quickPickItems(empty)), [{ label: 'No Claude Code session in the last 7 days.' }])
  // A session with no agent and nothing running has no tally — never "0 started" — and so no group.
  const { vm } = agentVm()
  const bare = vm.agents.roots.map((r) => ({ ...r, tally: null, tallyText: null, tallySpoken: null, tallyParts: null }))
  const none = quickPickItems({ ...vm, agents: { ...vm.agents, roots: bare, runningNow: [], runningMore: 0 } })
  assert.equal(none.some((i) => i.separator === true && i.label === 'Agents'), false)
  assert.equal(none.some((i) => / started/.test(i.label)), false)
  // A tree that was never built claims nothing either way.
  assert.equal(quickPickItems({ ...vm, agents: emptyAgentTree() }).some((i) => i.separator === true && i.label === 'Agents'), false)
  const without = { ...vm } as Partial<ViewModel>
  delete without.agents
  assert.equal(quickPickItems(without as ViewModel).some((i) => i.label === 'Agents'), false)
})

test('past the sessions the tree lists, the Quick Pick\'s tally says whose agents it counts (1.6 O2)', () => {
  const { agg } = agentWorld()
  const vm = buildViewModel(makeInput({ agg, cfg: makeConfig() }))
  const rows = agentGroup(quickPickItems({ ...vm, agents: { ...vm.agents, omittedRoots: 3 } }))
  const last = rows[rows.length - 1]
  // The older sessions' agents are in no tally the view model carries, so the row says so
  // rather than calling the listed sessions' sum the last seven days'.
  assert.equal(last.label, '14 started · 5 ✓ · 2 ✕ · 2 ↻ · 1 ■ · ~3 ● · ~1 ? · the 2 most recent sessions of the last 7 days')
  assert.equal(last.description, '3 older session(s) not counted.')
  assert.ok(MAX_ROOTS > 2)
})

test('the Quick Pick\'s summary names its span first — "Last 7 days: " and then the tally, never as one more part of it (1.6 P16)', () => {
  const { agg } = agentWorld()
  const vm = buildViewModel(makeInput({ agg, cfg: makeConfig() }))
  const tally = agentGroup(quickPickItems(vm)).at(-1)
  assert.ok(tally)
  // The tally's parts are joined by ' · '; the span stands in front of them, set off by a colon, so
  // no part of the label reads as a count that is not one.
  const text = '14 started · 5 ✓ · 2 ✕ · 2 ↻ · 1 ■ · ~3 ● · ~1 ?'
  assert.equal(tally.label, `Last 7 days: ${text}`)
  assert.equal(tally.label.split(' · ').some((p) => /last 7 days/i.test(p) && !p.startsWith('Last 7 days: ')), false, tally.label)
  assert.equal(/ · last 7 days$/.test(tally.label), false)
  // The words beside it are the tally's own, unchanged.
  assert.equal(tally.detail, '14 started, 5 done, 2 failed, 2 retried, 1 stopped, about 3 running, about 1 unknown')
  // Past MAX_ROOTS the row keeps its wording: which sessions it counts is the span there.
  const omitted = agentGroup(quickPickItems({ ...vm, agents: { ...vm.agents, omittedRoots: 1 } })).at(-1)
  assert.equal(omitted?.label, `${text} · the 2 most recent sessions of the last 7 days`)
  // In German through the shipped bundle: „Letzte 7 Tage: {0}", the tally's words German too.
  const bundle = JSON.parse(readFileSync(path.join(ROOT, 'l10n', 'bundle.l10n.de.json'), 'utf8')) as Record<string, string>
  assert.equal(bundle['Last 7 days: {0}'], 'Letzte 7 Tage: {0}')
  assert.equal('{0} · last 7 days' in bundle, false, 'the retired tail is still translated')
  let de: PickItem | undefined
  try {
    setBundle(bundle)
    setLocale('de')
    de = agentGroup(quickPickItems(buildViewModel(makeInput({ agg, cfg: makeConfig() }))), 'Agenten').at(-1)
  } finally {
    setBundle(undefined)
    setLocale(undefined)
  }
  assert.equal(de?.label, 'Letzte 7 Tage: 14 gestartet · 5 ✓ · 2 ✕ · 2 ↻ · 1 ■ · ~3 ● · ~1 ?')
})

test('the Quick Pick\'s agents speak German with the shipped bundle (1.6 O2)', () => {
  const bundle = JSON.parse(readFileSync(path.join(ROOT, 'l10n', 'bundle.l10n.de.json'), 'utf8')) as Record<string, string>
  const { agg } = agentWorld()
  let rows: PickItem[] = []
  let omitted: PickItem[] = []
  try {
    setBundle(bundle)
    setLocale('de')
    const vm = buildViewModel(makeInput({ agg, cfg: makeConfig() }))
    rows = agentGroup(quickPickItems(vm), 'Agenten')
    omitted = agentGroup(quickPickItems({ ...vm, agents: { ...vm.agents, omittedRoots: 3 } }), 'Agenten')
  } finally {
    setBundle(undefined)
    setLocale(undefined)
  }
  assert.ok(rows.length >= 4, rows.map((i) => i.label).join(' / '))
  assert.equal(rows[0].detail, 'Sitzung 3f9a2c1d · Workflow-Lauf cfe7718d · ⚠ Untergrenze — 1 von 2 Antworten unvollständig')
  assert.equal(rows[2].label, '2 Agent(en) ohne gezählte Antwort (~1 davon läuft)')
  const last = rows[rows.length - 1]
  assert.equal(last.label, 'Letzte 7 Tage: 14 gestartet · 5 ✓ · 2 ✕ · 2 ↻ · 1 ■ · ~3 ● · ~1 ?')
  assert.equal(last.detail, '14 gestartet, 5 fertig, 2 fehlgeschlagen, 2 wiederholt, 1 gestoppt, etwa 3 laufend, etwa 1 unbekannt')
  const tail = omitted[omitted.length - 1]
  assert.equal(tail.label, '14 gestartet · 5 ✓ · 2 ✕ · 2 ↻ · 1 ■ · ~3 ● · ~1 ? · die 2 jüngsten Sitzungen der letzten 7 Tage')
  assert.equal(tail.description, '3 ältere Sitzung(en) nicht mitgezählt.')
  assert.equal(bundle['waits for a child agent'], 'wartet auf einen untergeordneten Agenten')
})

// ---------------------------------------------------------------------------
// 1.7 F1: the text views follow the provider switch
// ---------------------------------------------------------------------------

/** A world with agents, a context reading, both providers' history and a budget of each scope, under `providers`. */
function switchWorld(providers?: ('claude' | 'codex')[]): { vm: ViewModel; text: AgentTreeVm } {
  const { agg } = agentWorld()
  const history = makeHistory()
  fillHistory(history)
  fillHistory(history, 'codex')
  const input = {
    ...makeInput({
      agg, history,
      cfg: makeConfig({
        'tokenPace.budgets': [
          { scope: 'total', period: 'month', unit: 'usd', limit: 20 },
          { scope: 'claude', period: 'day', unit: 'tokens', limit: 5_000_000 },
          { scope: 'codex', period: 'month', unit: 'tokens', limit: 1_000_000 },
        ],
        'tokenPace.calibration.show': true,
      }),
      ...(providers ? { ui: { providers } } : {}),
    }),
    context: { used: 128_000, size: 200_000, usedPct: 64, fetchedAt: Math.round((NOW - 120_000) / 1000) },
  }
  return { vm: buildViewModel(input), text: agentTreeFor(input, 'text') }
}

const CLAUDE_ONLY_LINE = 'Claude Code only — not shown while Codex is selected.'

test('under Codex the markdown, the Quick Pick and Copy Summary follow the switch: no Claude line, no Agents or Context part, the provider named once (1.7 F1, §7a Q7)', () => {
  const { toMarkdownSummary } = require('../src/exporter') as typeof import('../src/exporter')
  const all = switchWorld()
  const codex = switchWorld(['codex'])
  assert.equal(codex.vm.claudeOnly, CLAUDE_ONLY_LINE)
  // Under All: every part, and the range line as 1.6 wrote it.
  const mdAll = markdownDocument(all.vm, all.text)
  for (const heading of ['## Agents', '## Context window', '## Tokens — Claude Code', '## Tokens — Codex']) {
    assert.ok(mdAll.includes(heading), `All: ${heading} missing`)
  }
  assert.ok(mdAll.split('\n').some((l) => l.startsWith('### Claude Code')), 'All: the Claude card is missing')
  const rangeAll = mdAll.split('\n')[2]
  assert.ok(rangeAll.startsWith(`*${all.vm.range.label} · `) && !rangeAll.includes(' only'), rangeAll)
  // Under Codex: the Codex figures alone; the two Claude Code–only parts are left out — no heading,
  // no placeholder, the reason nowhere in the text.
  const md = markdownDocument(codex.vm, codex.text)
  assert.equal(md.includes('## Agents'), false, 'the Agents section is in the Codex markdown')
  assert.equal(md.includes('## Context window'), false, 'the Context window section is in the Codex markdown')
  assert.equal(md.includes(CLAUDE_ONLY_LINE), false)
  assert.equal(md.includes('Claude Code'), false, md.split('\n').filter((l) => l.includes('Claude Code')).join('\n'))
  assert.equal(/claude-/.test(md), false, md.split('\n').filter((l) => /claude-/.test(l)).join('\n'))
  assert.ok(md.includes('## Tokens — Codex'))
  assert.ok(md.includes('- Showing Codex only — the provider switch at the top of the dashboard; ‘All’ shows every provider.'))
  const range = md.split('\n')[2]
  assert.ok(range.endsWith(' · Codex only*'), range)
  assert.equal(range, rangeAll.replace(/\*$/, ' · Codex only*'))
  // The Quick Pick: its first line names the provider; no Agents and no Context window group.
  const items = quickPickItems(codex.vm)
  assert.ok(items[0].description?.startsWith('Codex · '), items[0].description)
  assert.equal(items[0].description, `Codex · ${quickPickItems(all.vm)[0].description}`)
  const heads = items.filter((i) => i.separator === true).map((i) => i.label)
  assert.equal(heads.includes('Agents'), false, heads.join(', '))
  assert.equal(heads.includes('Context window'), false, heads.join(', '))
  assert.ok(quickPickItems(all.vm).some((i) => i.separator === true && i.label === 'Agents'))
  const said = items.map((i) => [i.label, i.description ?? '', i.detail ?? ''].join(' | '))
  assert.deepEqual(said.filter((l) => l.includes('Claude Code') || /claude-/.test(l) || l.includes(CLAUDE_ONLY_LINE)), [])
  // Copy Summary: the same view model, its heading naming the provider.
  const summary = toMarkdownSummary(codex.vm)
  assert.ok(summary.split('\n')[0].endsWith(' · Codex only'), summary.split('\n')[0])
  assert.equal(summary.includes('Claude Code'), false)
  assert.equal(toMarkdownSummary(all.vm).split('\n')[0].includes(' only'), false)
})

test('under Claude Code the text views keep the Agents and Context parts and name the provider (1.7 F1)', () => {
  const { toMarkdownSummary } = require('../src/exporter') as typeof import('../src/exporter')
  const claude = switchWorld(['claude'])
  assert.equal(claude.vm.claudeOnly, null)
  const md = markdownDocument(claude.vm, claude.text)
  assert.ok(md.includes('## Agents') && md.includes('## Context window'))
  assert.equal(md.includes('## Tokens — Codex'), false)
  assert.ok(md.split('\n')[2].endsWith(' · Claude Code only*'), md.split('\n')[2])
  const items = quickPickItems(claude.vm)
  assert.ok(items[0].description?.startsWith('Claude Code · '), items[0].description)
  const heads = items.filter((i) => i.separator === true).map((i) => i.label)
  assert.ok(heads.includes('Agents') && heads.includes('Context window'), heads.join(', '))
  assert.ok(toMarkdownSummary(claude.vm).split('\n')[0].endsWith(' · Claude Code only'))
})

test('the switch\'s words in the text views speak German with the shipped bundle (1.7 F1)', () => {
  const bundle = JSON.parse(readFileSync(path.join(ROOT, 'l10n', 'bundle.l10n.de.json'), 'utf8')) as Record<string, string>
  let md = ''
  let first = ''
  let reason: string | null = null
  try {
    setBundle(bundle)
    setLocale('de')
    const codex = switchWorld(['codex'])
    md = markdownDocument(codex.vm, codex.text)
    first = quickPickItems(codex.vm)[0].description ?? ''
    reason = codex.vm.claudeOnly
  } finally {
    setBundle(undefined)
    setLocale(undefined)
  }
  assert.ok(md.split('\n')[2].endsWith(' · nur Codex*'), md.split('\n')[2])
  assert.ok(md.includes('- Nur Codex angezeigt — Anbieterschalter oben im Dashboard; ‚Alle‘ zeigt alle Anbieter.'), md)
  assert.equal(reason, 'Nur Claude Code — ausgeblendet, solange Codex ausgewählt ist.')
  assert.equal(md.includes('## Agenten'), false)
  assert.ok(first.startsWith('Codex · '), first)
})

// ---------------------------------------------------------------------------
// 1.7 F2 · the earlier sessions in the document and the Quick Pick
// ---------------------------------------------------------------------------

/**
 * 1.7 F2: `active` sessions a minute apart and `idle` ones half an hour apart from an hour on, each
 * with one agent — the active ones' running, the idle ones' done, the first idle one's with a nested
 * agent under it — on the fixtures' clock.
 */
function earlierAgg(active: number, idle: number): Aggregator {
  const agg = buildAgg('none')
  const dir = path.dirname(CLAUDE_FILE)
  const counts = { input: 300, cacheWrite: 200, cacheWrite1h: 0, cacheRead: 5000, output: 700, reasoning: 0, requests: 5, outputFinal: 5, toolCalls: 3 }
  const mains: MainRec[] = []
  const agents: AgentRec[] = []
  const agentOf = (id: string, sessionId: string, lastTs: number, over: Partial<AgentRec> = {}): AgentRec => ({
    source: 'claude', agentId: id, sessionId, sessionFile: path.join(dir, `${sessionId}.jsonl`), workflowId: null,
    meta: { agentType: 'Explore', model: 'opus', spawnDepth: 1, toolUseId: null, parentAgentId: null }, metaTries: 1,
    spawnerFile: path.join(dir, `${sessionId}.jsonl`), firstTs: lastTs - 10 * 60_000, lastTs, models: ['claude-opus-4-6'],
    ...counts, outcome: null, outcomeTs: null, outcomeStatus: null, rejected: null,
    lastTool: null, lastToolTs: null, effort: null, efforts: [], lastContext: null, toolErrors: 0, cacheMisses: {}, cacheMissedTokens: 0,
    ccVersion: null, permissionMode: null, compactions: 0, lastCompaction: null, ...over,
  })
  for (let i = 0; i < active + idle; i++) {
    const sessionId = `${i < active ? 'act' : 'idl'}${String(i).padStart(5, '0')}-s`
    const lastTs = i < active ? NOW - (i + 1) * 60_000 : NOW - (60 + 30 * (i - active)) * 60_000
    mains.push({ source: 'claude', sessionId, firstTs: lastTs - 3_600_000, lastTs, models: ['claude-opus-4-6'], ...counts,
      ccVersion: null, permissionMode: null, compactions: 0, lastCompaction: null, lastRequest: null, lastUserAt: null })
    const id = `${String(i).padStart(4, '0')}aaaa`
    agents.push(i < active ? agentOf(id, sessionId, NOW - 30_000)
      : agentOf(id, sessionId, lastTs - 5 * 60_000, { outcome: 'completed', outcomeTs: lastTs - 5 * 60_000, outcomeStatus: 'completed' }))
    if (i === active) {
      agents.push(agentOf(`${String(i).padStart(4, '0')}bbbb`, sessionId, lastTs - 6 * 60_000, {
        spawnerFile: null, outcome: 'completed', outcomeTs: lastTs - 6 * 60_000, outcomeStatus: 'completed',
        meta: { agentType: 'Plan', model: 'opus', spawnDepth: 2, toolUseId: null, parentAgentId: id },
      }))
    }
  }
  agg.mains = () => mains
  agg.agents = () => agents
  agg.launches = () => []
  return agg
}

test('1.7 F2: the document prints the group open — a depth-0 item without a state or a figure, its sessions one level in, each with its subtree', () => {
  const input = makeInput({ agg: earlierAgg(1, 2) })
  const vm = buildViewModel(input)
  const text = agentTreeFor(input, 'text')
  assert.deepEqual(text.roots.map((r) => r.kind), ['session', 'group'])
  const all = sectionOf(markdownDocument(vm, text), '## Agents')
  const tree = all.slice(all.indexOf('### Sessions and agents')).filter((l) => /^\s*- /.test(l))
  assert.deepEqual(tree.map((l) => l.replace(/ · .*$/, '').replace(/ \(.*$/, '')), [
    '- [~Active] Session Thu 10:59',
    '  - [~Running] Explore',
    // (Its count in brackets, cut off here with every bracket; the whole line below.)
    '- Earlier sessions',
    '  - [~Idle] Session Thu 10:00',
    '    - [Done] Explore',
    '      - [Done] Plan',
    '  - [~Idle] Session Thu 09:30',
    '    - [Done] Explore',
  ])
  // The group's line: its words and what its sessions' agents came to — no [state], no figure.
  const g = tree[2]
  assert.equal(g, '- Earlier sessions (2) (3 started · 3 ✓)')
  assert.equal(g.includes('['), false)
  assert.equal(/own |agents |–|\d+\.\dK|min/.test(g), false, g)
  // The page's own tree has the group closed: its line, and nothing under it.
  const page = sectionOf(markdownDocument(vm), '## Agents')
  const shut = page.slice(page.indexOf('### Sessions and agents')).filter((l) => /^\s*- /.test(l))
  assert.deepEqual(shut.slice(-1), ['- Earlier sessions (2) (3 started · 3 ✓)'])
  assert.equal(shut.some((l) => l.startsWith('  - [~Idle]')), false)
  // German: „Frühere Sitzungen (2)".
  const bundle = JSON.parse(readFileSync(path.join(ROOT, 'l10n', 'bundle.l10n.de.json'), 'utf8')) as Record<string, string>
  assert.equal(bundle['Earlier sessions ({0})'], 'Frühere Sitzungen ({0})')
  let md = ''
  try {
    setBundle(bundle)
    setLocale('de')
    md = markdownDocument(buildViewModel(input), agentTreeFor(input, 'text'))
  } finally {
    setBundle(undefined)
    setLocale(undefined)
  }
  assert.ok(md.split('\n').includes('- Frühere Sitzungen (2) (3 gestartet · 3 ✓)'), md)
})

test('1.7 F2: the Quick Pick counts the closed group\'s sessions with its own tally, and past the caps names the sessions it lists', () => {
  // A world where the group is closed, as the dashboard starts: the summary is the 1.6 sum over
  // every listed session — the tree without the group, every session a root — to the digit.
  const input = makeInput({ agg: earlierAgg(3, 4) })
  const vm = buildViewModel(input)
  assert.deepEqual(vm.agents.roots.map((r) => [r.kind, r.children.length]), [['session', 0], ['session', 0], ['session', 0], ['group', 0]])
  const text = agentTreeFor(input, 'text')
  const sessions = text.roots.flatMap((r) => (r.kind === 'group' ? r.children : [r]))
  assert.equal(sessions.length, 7)
  const sum = { started: 0, done: 0, failed: 0, retried: 0, stopped: 0, running: 0, unknown: 0 }
  for (const r of sessions) for (const k of Object.keys(sum) as Array<keyof typeof sum>) sum[k] += r.tally?.[k] ?? 0
  const last = agentGroup(quickPickItems(vm)).at(-1)
  assert.equal(last?.label, `Last 7 days: ${tallyText(sum)}`)
  assert.equal(last?.label, 'Last 7 days: 8 started · 5 ✓ · ~3 ●')
  assert.equal(last?.detail, tallySpoken(sum))
  assert.equal(last?.description, undefined)
  // Twenty-five earlier sessions: the group holds twenty, the note counts five, and the row names
  // the sessions the tree lists — the three active ones and the group's twenty.
  const many = buildViewModel(makeInput({ agg: earlierAgg(3, 25) }))
  assert.equal(many.agents.omittedRoots, 5)
  assert.equal(many.agents.roots[3].childrenTotal, MAX_ROOTS)
  const row = agentGroup(quickPickItems(many)).at(-1)
  assert.match(row?.label ?? '', / · the 23 most recent sessions of the last 7 days$/)
  assert.equal(row?.description, '5 older session(s) not counted.')
  // Counted: the three active sessions' agents and the twenty in the group (the first one's two).
  assert.match(row?.label ?? '', /^24 started · 21 ✓ · ~3 ● · /)
  // The group's own key never reaches a Quick Pick item.
  assert.equal(quickPickItems(many).some((i) => JSON.stringify(i).includes(EARLIER_KEY)), false)
})

// ---------------------------------------------------------------------------
// 1.8 A5, A6: the prompt-cache block and the Codex line in both text views
// ---------------------------------------------------------------------------

const PC_MIN = 60_000

function pcReading(sessionId: string, expiresAt: number, over: Partial<PromptCacheReading> = {}): PromptCacheReading {
  return {
    warm: true, ttl: '1h', expiresAt, hitRatio: 0.9, readAt: Math.floor((NOW - PC_MIN) / 1000),
    sessionId, recacheIfCold: 152_300, model: 'claude-opus-5-5', ...over,
  }
}

/**
 * A transcript session cooling, a bridge session cooling and one cold, a transcript session warm, the
 * latest mirror a warm 1 h cache of a fifth session — and a GPT-5.6 Codex turn ten minutes ago.
 */
function cacheVm(): ViewModel {
  const agg = buildAgg()
  addCacheSession(agg, { sessionId: 'aaaa1111-0000', at: NOW - 56 * PC_MIN })
  addCacheSession(agg, { sessionId: 'bbbb2222-0000', at: NOW - 30 * PC_MIN, model: 'claude-fable-5-1' })
  const file = path.join('/virtual', 'codex', 'sessions', 'rollout-77.jsonl')
  const cur = { offset: 0, size: 0, ino: 77, dev: 1 }
  agg.cursors.set(file, cur)
  const ctx = ctxFor({ file })
  agg.addCodexLine(codexMeta({ ts: NOW - 11 * PC_MIN, id: 'thread-0077' }), cur, ctx)
  agg.addCodexLine(codexTurnContext(NOW - 11 * PC_MIN, 'gpt-5.6-sol'), cur, ctx)
  agg.addCodexLine(codexTokenCount({ ts: NOW - 10 * PC_MIN, total: { input: 900, cached: 600, output: 40, total: 940 } }), cur, ctx)
  const latest = pcReading('7a7a7a7a-0000', NOW + 40 * PC_MIN)
  return buildViewModel({
    ...makeInput({ agg }), promptCache: latest,
    promptCaches: [pcReading('9d0eb37a-0000', NOW + 4 * PC_MIN + 10_000), pcReading('5f1c2d3e-0000', NOW - 20 * PC_MIN), latest],
  })
}

test('the markdown lists every watched session under the Claude card, warm ones too, each with its cost line under it (1.8 A5)', () => {
  const vm = cacheVm()
  const block = vm.quotas[0].cacheWatch
  assert.ok(block)
  const quota = quotaPart(markdownDocument(vm))
  const claude = quota.slice(quota.indexOf('### Claude Code'), quota.indexOf('### Codex'))
  const expected = block.all.flatMap((l) => [`- ${l.text}`, ...(l.cost ? [`  ${l.cost}`] : [])]).join('\n')
  assert.ok(claude.includes(`\n${expected}\n\n`), claude)
  assert.equal(block.all.length, 5)
  assert.ok(claude.includes('- Session Thu 10:30 · bbbb2222 · prompt cache warm · cools in ~30 m 0 s (1 h TTL, estimated from the transcript)\n'
    + '  A cold start after ~12:30 re-writes ~152.3K tokens at the 1 h write rate (2× input, ~$3.05) instead of reading them from the cache (0.025× input, ~$0.04).'), claude)
  // The latest mirror's session is in the list, so its 1.3 line is not printed a second time.
  assert.ok(vm.quotas[0].promptCache?.watched)
  assert.equal(claude.includes('prompt cache warm · expires in'), false, claude)
  assert.equal(claude.split('7a7a7a7a').length - 1, 1, claude)
  // After the windows and their explanations, before the freshness row.
  assert.ok(claude.indexOf(expected) > claude.lastIndexOf('- **7 d**'), claude)
  assert.ok(claude.indexOf(expected) < claude.indexOf('Freshness —'), claude)
  // The Codex card's one line, under the Codex card and nowhere else.
  const codex = quota.slice(quota.indexOf('### Codex'))
  const line = vm.quotas[1].codexCache
  assert.ok(line)
  assert.ok(codex.includes(`\n${line}\n`), codex)
  assert.equal(claude.includes('Codex prompt cache'), false)
})

test('the Quick Pick carries the card\'s lines — state as the label, cost as the description — then the rest\'s count, then the 1.3 line (1.8 A5)', () => {
  const vm = cacheVm()
  const items = quickPickItems(vm)
  const block = vm.quotas[0].cacheWatch
  assert.ok(block && block.lines.length === 3)
  const at = (label: string): number => items.findIndex((i) => i.label === label)
  const lastClaudeWindow = Math.max(...vm.quotas[0].windows.map((w) => items.findIndex((i) => i.label.startsWith(`${w.label} `))))
  const firstCodex = at('Codex')
  for (const [n, l] of block.lines.entries()) {
    const i = at(l.text)
    assert.ok(i > lastClaudeWindow && i < firstCodex, l.text)
    assert.equal(items[i].description, l.cost ?? undefined)
    assert.equal(items[i].command, undefined)
    if (n > 0) assert.ok(i > at(block.lines[n - 1].text))
  }
  // The warm sessions are not on the card, so not in the list; the latest mirror's warm 1 h cache
  // keeps its 1.3 line there.
  assert.equal(items.some((i) => i.label.includes('bbbb2222')), false)
  const oldLine = items.findIndex((i) => i.label.startsWith('prompt cache warm · expires in'))
  assert.ok(oldLine > at(block.lines[2].text) && oldLine < firstCodex)
  // The Codex line after the Codex windows.
  const codex = items.findIndex((i) => i.label === vm.quotas[1].codexCache)
  assert.ok(codex > firstCodex, 'the Codex line is not in the Codex group')
  // The count of the rest, when there is a rest.
  const many = buildViewModel({
    ...makeInput(),
    promptCaches: [1, 2, 3, 4, 5].map((n) => pcReading(`c000000${n}-0000`, NOW + n * PC_MIN)),
  })
  const list = quickPickItems(many)
  const more = list.findIndex((i) => i.label === '2 more sessions with a cooling or cold prompt cache')
  assert.ok(more > list.findIndex((i) => i.label.startsWith('Session c0000003 ·')), 'the count is not after the lines')
})

test('a line of the block goes through cell() in the markdown and through noIcons in the Quick Pick (1.8 A5)', () => {
  const vm = cacheVm()
  const block = vm.quotas[0].cacheWatch
  assert.ok(block)
  const hostile = 'x | y\n## z $(alert) `w`'
  block.lines[0] = { ...block.lines[0], text: hostile, cost: hostile }
  block.all[0] = { ...block.all[0], text: hostile, cost: hostile }
  block.moreText = hostile
  const md = markdownDocument(vm)
  assert.ok(md.includes('- x \\| y ## z $(alert) `w`\n  x \\| y ## z $(alert) `w`\n'), md)
  assert.equal(md.includes('\n## z'), false)
  const items = quickPickItems(vm)
  const item = items.find((i) => i.label.startsWith('x | y'))
  assert.ok(item)
  assert.equal(item.label.includes('\\$(alert)'), true, item.label)
  assert.equal(item.description?.includes('\\$(alert)'), true)
  assert.ok(items.some((i) => i.label === noIcons(hostile) && i.description === undefined), 'the count line is not escaped')
})
