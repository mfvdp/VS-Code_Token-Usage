// SPDX-FileCopyrightText: 2026 Frederik Marx
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The anti-fake rules of §0.4, asserted on the rendered view model rather than on the
 * helpers that produce it — the rules are only worth anything at the surface a person reads.
 */

import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import * as path from 'node:path'
import { test } from 'node:test'
import { Aggregator } from '../src/agg'
import type { TreeNode } from '../src/agentTree'
import { toMarkdownSummary } from '../src/exporter'
import { setBundle, setLocale } from '../src/i18n'
import { StatsCtx, calendar, heatmap, totalRow } from '../src/stats'
import { markdownDocument, quickPickItems } from '../src/textViews'
import { Attribution, Snapshot } from '../src/types'
import { ViewModel, agentTreeFor, buildViewModel, defaultUiState } from '../src/viewModel'
import { QuotaHistory } from '../src/quotaHistory'
import {
  AGENT_CONTENT, AGENT_WORLD, agentNode, agentWorld, agentWorldFile, everyParent, treeNodes,
} from './fixtures/agentWorld'
import {
  FINGERPRINT, NOW, TODAY, buildAgg, fillHistory, makeConfig, makeHistory, makeInput, state,
  timeConfig, win,
} from './fixtures/viewFixtures'
import { ROOT } from './helpers/nls'
import { toolAgg } from './helpers/toolAgg'

const cfg = makeConfig()
const tcfg = timeConfig(cfg)

const emptyCtx: StatsCtx = {
  agg: new Aggregator(),
  tcfg,
  pricing: {},
  now: NOW,
  sources: ['claude', 'codex'],
  models: [],
  showCost: true,
}

test('absence is a dash — never 0 %, never $0.00', () => {
  const vm = buildViewModel(makeInput({ agg: new Aggregator(), quotas: [] }))
  const texts = [
    ...vm.kpis.map((k) => k.value),
    ...vm.totals.flatMap((t) => t.rows.flatMap((r) => [
      r.usage, r.freshInput, r.cacheWrite5m, r.cacheWrite1h, r.cacheRead, r.output, r.reasoning,
      r.requests, r.cost, r.cacheHit, r.perRequest, r.costPerRequest, r.outputShare,
    ])),
    ...vm.cacheEconomy.flatMap((c) => [c.hitRate, c.savedUsd, c.blendedPerM]),
    ...[vm.calendar.thisWeek, vm.calendar.thisMonth, vm.calendar.lastMonth, vm.calendar.year]
      .flatMap((p) => [p.usage, p.cost, p.requests, p.avgPerDay]),
  ]
  for (const t of texts) {
    assert.notEqual(t, '0 %', 'a missing rate must not read as zero')
    assert.notEqual(t, '$0.00', 'a missing amount must not read as zero')
    assert.notEqual(t, '~$0.00')
    assert.notEqual(t, '0')
  }
  // Active days is a count of days, not a measurement of usage — "0 of 30" is the truth.
  assert.equal(vm.kpis.find((k) => k.key === 'usage')?.value, '–')
  assert.equal(vm.kpis.find((k) => k.key === 'cacheHit')?.value, '–')
  // A day with nothing on it is a dash and has no change to report: "±0%" would compare two
  // measurements that were never taken.
  const today = vm.kpis.find((k) => k.key === 'today')
  assert.equal(today?.value, '–')
  assert.equal(today?.delta, null)
})

test('a division without a denominator yields a dash in every rendering', () => {
  const row = totalRow({ ...emptyCtx, sources: ['claude'] }, 'Today', TODAY, TODAY, 'claude')
  assert.equal(row.cacheHit, '–')
  assert.equal(row.perRequest, '–')
  assert.equal(row.costPerRequest, '–')
  assert.equal(row.outputShare, '–')
})

test('every hypothetical amount carries the estimate marker', () => {
  const vm = buildViewModel(makeInput())
  const money = [
    ...vm.totals.flatMap((t) => t.rows.map((r) => r.cost)),
    ...vm.cacheEconomy.map((c) => c.blendedPerM),
    ...vm.models.rows.map((m) => m.costText),
    vm.kpis.find((k) => k.key === 'cost')?.value ?? '–',
  ]
  for (const m of money) {
    if (m === '–') continue
    assert.match(m, /^~/, `${m} is a hypothetical amount and must be marked`)
  }
  assert.equal(vm.kpis.find((k) => k.key === 'cost')?.provenance, 'estimated')
  assert.equal(vm.kpis.find((k) => k.key === 'usage')?.provenance, 'measured')
  assert.equal(vm.kpis.find((k) => k.key === 'cacheHit')?.provenance, 'derived')
  // The legend that explains the marker travels with the numbers.
  assert.ok(vm.footnotes.some((f) => f.includes('~ = estimate')))
})

test('a cost that cannot be complete is labelled a lower bound wherever it is shown', () => {
  const vm = buildViewModel(makeInput())
  assert.equal(vm.lowerBound, true)
  assert.ok(vm.unpricedModels.length > 0)
  assert.ok(vm.footnotes.some((f) => f.includes('lower bound')))
  assert.ok(toMarkdownSummary(vm).includes('lower bound'))
  assert.ok(vm.totals.some((t) => t.rows.some((r) => r.costPartial)))
})

test('a window without a clock gets no pace, no elapsed and no projected end', () => {
  const vm = buildViewModel(makeInput({
    quotas: [state('claude', {
      windows: [win({ id: 'other:0', kind: 'other', label: 'unknown window', resetsAt: null, windowMinutes: null })],
    })],
  }))
  const w = vm.quotas[0].windows[0]
  assert.equal(w.elapsed, null)
  assert.equal(w.verdict.points, null)
  assert.equal(w.verdict.ratio, null)
  assert.equal(w.verdict.text, 'no clock for this window')
  assert.equal(w.reset, '')
  assert.equal(w.resetAbsolute, '')
  // No reset time, so no projected end and no sustainable rate can exist.
  assert.equal(w.forecast?.endPercent, null)
  assert.equal(w.forecast?.sustainablePerHour, null)
})

test('a non-finite percentage is discarded, not clamped to a number', () => {
  const vm = buildViewModel(makeInput({
    quotas: [state('claude', { windows: [win({ percent: Number.NaN })] })],
  }))
  const w = vm.quotas[0].windows[0]
  assert.equal(w.percentText, '–')
  assert.equal(w.verdict.text, 'no reading')
  assert.equal(w.aria.now, 0)
  assert.equal(w.forecast?.state, 'none')
})

test('a passed reset is reported as due — never simulated as a fresh window', () => {
  const vm = buildViewModel(makeInput({
    quotas: [state('claude', {
      fetchedAt: Math.round((NOW - 3 * 3_600_000) / 1000),
      windows: [win({ percent: 87, resetsAt: NOW - 60_000 })],
    })],
  }))
  const w = vm.quotas[0].windows[0]
  assert.equal(w.display, 'resetDue')
  // The old percentage stays visible: we did not see a reading of zero.
  assert.equal(w.percent, 87)
  assert.equal(w.percentText, '87%')
  assert.ok(w.aria.text.includes('reset due'))
})

test('the month projection stays silent until it has five active days', () => {
  assert.equal(calendar({ ...emptyCtx, agg: buildAgg() }).thisMonth.projection, null)
})

test('heatmap days before the coverage are null, not zero', () => {
  const h = heatmap({ ...emptyCtx, agg: buildAgg() }, 'usage', '2026-08-01')
  const outside = h.weeks.flatMap((w) => w.days).filter((d) => d.level === null)
  assert.ok(outside.length > 0)
  for (const d of outside) assert.equal(d.text, 'outside coverage')
  // Days inside the coverage without usage are level 0 with a stated "no usage".
  const idle = h.weeks.flatMap((w) => w.days).find((d) => d.level === 0)
  assert.match(String(idle?.text), /no usage$/)
})

test('with nothing ingested the heatmap claims no coverage rather than a year of idleness', () => {
  // Quota polling can work while no transcript was ever found: there is no first day, and
  // a year of "no usage" would be a measurement of days nobody watched.
  const h = heatmap(emptyCtx, 'usage', null)
  const days = h.weeks.flatMap((w) => w.days)
  assert.ok(days.length > 360)
  for (const d of days) {
    assert.equal(d.level, null)
    assert.equal(d.text, 'outside coverage')
  }
  assert.equal(h.activeDays, 0)
  assert.equal(h.streak, 0)
})

test('preview data is flagged everywhere it is rendered and never merged into a reading', () => {
  const vm = buildViewModel({ ...makeInput(), preview: true })
  assert.equal(vm.preview, true)
  assert.ok(markdownDocument(vm).includes('Preview data — not a reading.'))
  assert.ok(toMarkdownSummary(vm).includes('Preview data — not a reading.'))
  assert.equal(buildViewModel(makeInput()).preview, false)
})

test('nothing in the rendered views prints a zero where a measurement is missing', () => {
  const vm = buildViewModel(makeInput({ agg: new Aggregator(), quotas: [] }))
  const md = markdownDocument(vm)
  assert.equal(md.includes('$0.00'), false)
  assert.equal(/\|\s0 %\s\|/.test(md), false)
  for (const i of quickPickItems(vm)) {
    assert.equal(i.label.includes('$0.00'), false)
  }
})

/**
 * Three complete cycles before the running one: four readings each, then a fall that no
 * `resetsAt` announced — the only other honest evidence that a window turned over. Without
 * them the retrospective says "not enough data" and asserts nothing about its wording.
 */
function fillCycles(history: QuotaHistory): void {
  let t = NOW - 12 * 3_600_000
  for (let cycle = 0; cycle < 3; cycle++) {
    for (const percent of [20, 40, 60, 80]) {
      history.add(
        {
          source: 'claude',
          ok: true,
          origin: 'poll',
          fetchedAt: Math.round(t / 1000),
          planType: null,
          windows: [win({ percent })],
        },
        FINGERPRINT,
        t,
      )
      t += 30 * 60_000
    }
  }
}

test('the pace unit is percent of the window — no view ever says "points"', () => {
  // "Points" reads as a score on a scale of its own; the figure above every one of these
  // sentences is a percentage, so the sentences say "%" too. This is a rule about what
  // reaches the reader, so it is asserted on the three rendered views, not on the helpers.
  const history = makeHistory()
  fillCycles(history)
  fillHistory(history)
  const vm = buildViewModel(makeInput({
    history, cfg: makeConfig({ 'tokenPace.calibration.show': true }),
  }))
  // The sentences that used to carry the word must actually have been rendered, or the
  // assertion below would pass on a view that said nothing at all.
  assert.ok(vm.retro.some((r) => r.text.includes('unused at the reset')), JSON.stringify(vm.retro))
  assert.ok(vm.quotas.some((q) => q.windows.some((w) => (w.forecast?.text ?? '').includes('reset'))),
    JSON.stringify(vm.quotas.flatMap((q) => q.windows.map((w) => w.forecast?.text ?? ''))))
  const texts = [
    markdownDocument(vm),
    toMarkdownSummary(vm),
    ...vm.retro.map((r) => r.text),
    ...vm.dataQuality.calibration.map((c) => c.text),
    ...vm.quotas.flatMap((q) => q.windows.map((w) => w.forecast?.text ?? '')),
    ...vm.quotas.flatMap((q) => q.windows.map((w) => w.verdict.text)),
    ...quickPickItems(vm).flatMap((i) => [i.label, i.description ?? '', i.detail ?? '']),
  ]
  for (const t of texts) assert.doesNotMatch(t, /\bpoints\b/i, t)
})

test('a context window is only ever a reading — never something we counted', () => {
  // Three days of buckets are on file in this fixture. A context window cannot be derived
  // from them (they count what was sent, not what is still in the conversation), so the
  // absence of the status line has to stay an absence in all three views.
  const vm = buildViewModel(makeInput())
  assert.equal(vm.context, null)
  assert.equal(markdownDocument(vm).includes('Context window'), false)
  assert.equal(quickPickItems(vm).some((i) => i.label.includes('Context window')), false)

  // And with a reading that carries no window size, no view may state a share of it.
  const sizeless = buildViewModel({
    ...makeInput(),
    context: { used: 128_000, size: null, usedPct: 71, fetchedAt: Math.round(NOW / 1000) },
  })
  const card = sizeless.context
  assert.ok(card)
  assert.equal(card.percentText, '–')
  const line = `${card.text} ${card.percentText}`
  assert.equal(/\d\s*%/.test(card.text), false, card.text)
  assert.equal(line.includes('71'), false, line)
  const rendered = quickPickItems(sizeless).find((i) => i.label.startsWith('Context window: '))
  assert.ok(rendered)
  assert.equal(/\d\s*%/.test(rendered.label), false, rendered.label)
})

test('a plan name is a label, never a limit', () => {
  // The setting exists so a card can be titled; nothing downstream may turn it into a
  // window, a denominator or a threshold. A provider that reports no window still reports
  // none once a plan name is configured.
  const vm = buildViewModel(makeInput({
    cfg: makeConfig({ 'tokenPace.planName': { claude: 'Max 20x' } }),
    quotas: [state('claude', { ok: false, planType: null, windows: [], problem: 'no token' })],
  }))
  const card = vm.quotas[0]
  assert.equal(card.planText, 'plan Max 20x (as configured)')
  assert.equal(card.windows.length, 0)
})

test('the local five-hour block is a count, never a window', () => {
  // The whole point of the shape: a reader who sees a percentage beside a five-hour figure
  // reads it as the provider's. There is no limit behind this number, so there is nothing to
  // divide by — and no bar, pace, forecast or alert may appear anywhere it is rendered.
  const vm = buildViewModel(makeInput({
    quotas: [state('claude', { ok: false, problem: 'no token', problemKind: 'noToken', windows: [] })],
  }))
  const card = vm.quotas[0]
  const b = card.localBlock
  assert.ok(b)
  for (const key of ['percent', 'percentText', 'limit', 'level', 'verdict', 'forecast', 'resetsAt', 'display']) {
    assert.equal(Object.prototype.hasOwnProperty.call(b, key), false, `localBlock carries ${key}`)
  }
  assert.equal(/\d\s*%/.test(b.text), false, b.text)
  assert.ok(b.text.includes('no limit is known'), b.text)
  // Nothing else on the view model grew a window out of it either.
  assert.equal(card.windows.length, 0)

  // The same sentence in the flat views, and no percentage next to it in either.
  const item = quickPickItems(vm).find((i) => i.label.startsWith('Local estimate'))
  assert.ok(item)
  assert.equal(item.label, b.text)
  assert.equal(/\d\s*%/.test(`${item.label} ${item.description ?? ''}`), false, item.label)
  const md = markdownDocument(vm)
  const line = md.split('\n').find((l) => l.startsWith('Local estimate'))
  assert.equal(line, b.text)
})

test('a record is a fact about the range, never a share of something unmeasured', () => {
  const vm = buildViewModel(makeInput({
    cfg: makeConfig({ 'tokenPace.attribution': 'session' }),
    agg: buildAgg('session'),
  }))
  const r = vm.records
  // Every share is a percentage of a total that was actually summed here; a row that could
  // not be priced prints a dash rather than a lower bound dressed as a cost.
  for (const e of [...r.topModels, ...r.topProjects, ...r.topSessions]) {
    assert.match(e.share, /^(–|\d+(\.\d+)? %)$/, e.share)
    if (e.cost !== '–') assert.match(e.cost, /^~/, `${e.label}: ${e.cost}`)
  }
  // With attribution off the tables are empty rather than filled from another source.
  const off = buildViewModel(makeInput())
  assert.equal(off.records.attributionOn, false)
  assert.deepEqual(off.records.topProjects, [])
  assert.deepEqual(off.records.topSessions, [])
})

test('a tool count is a count of what was read, never an estimate and never a limit', () => {
  const t = toolAgg(NOW)
  const vm = buildViewModel(makeInput({ agg: t.agg, range: t.range }))
  const tools = vm.tools
  for (const r of tools.rows) {
    // A share of the calls counted here, and nothing else: no "~", no cost, no denominator
    // from a provider — tool calls have no quota to be a share of.
    assert.match(r.share, /^(–|\d+ %)$/, r.share)
    assert.equal(/~/.test(`${r.callsText}${r.models}`), false, r.name)
  }
  // The table says since when it counts. Everything before the upgrade to the tool table has
  // tokens but no tool rows, and a silent zero there would read as a quiet week.
  assert.ok(tools.since)
  assert.ok(tools.notes.some((n) => n.includes(String(tools.since))), tools.notes.join(' | '))

  // Nothing counted: a dash, not a zero, in every rendering.
  const empty = buildViewModel(makeInput({ agg: new Aggregator(), quotas: [] }))
  assert.equal(empty.tools.totalText, '–')
  assert.equal(empty.tools.since, null)
  const md = markdownDocument(empty)
  const section = md.slice(md.indexOf('## Tools'), md.indexOf('## ', md.indexOf('## Tools') + 5))
  assert.equal(/\b0 call/.test(section), false, section)
  assert.equal(quickPickItems(empty).some((i) => /^Tool .+: /.test(i.label)), false)
})

test('a token budget and a money budget are never combined into one figure', () => {
  // The one rule that makes a budget list readable at all: dollars and tokens answer two
  // different questions, so nothing may add them, average them or rank them by raw value.
  // Only the share — a fraction of the reader's own limit — crosses between the two.
  const vm = buildViewModel(makeInput({
    agg: buildAgg(),
    cfg: makeConfig({
      'tokenPace.budgets': [
        { scope: 'total', period: 'month', unit: 'usd', limit: 20 },
        { scope: 'claude', period: 'day', unit: 'tokens', limit: 5_000_000 },
      ],
    }),
  }))
  const [money, tokens] = vm.budgets
  assert.equal(money.unit, 'usd')
  assert.equal(tokens.unit, 'tokens')
  // Each row's used figure came from its own unit's sum, and neither one is the other's total.
  assert.notEqual(money.used, tokens.used)
  assert.ok(money.usedText.startsWith('~$'), money.usedText)
  assert.equal(/\$/.test(tokens.usedText + tokens.limitText), false, tokens.text)
  // No row, and no view, carries a sum across the two.
  const total = money.used + tokens.used
  const md = markdownDocument(vm)
  for (const text of [md, quickPickItems(vm).map((i) => `${i.label} ${i.description ?? ''}`).join('\n')]) {
    assert.equal(text.includes(String(total)), false, text)
  }
  // The status bar picks by share, so a huge token count cannot outrank a nearly spent budget.
  const worst = [...vm.budgets].sort((a, b) => (b.share ?? -1) - (a.share ?? -1))[0]
  assert.equal(worst.key, money.share! >= tokens.share! ? money.key : tokens.key)
})

test('a budget with no local data for its period is a dash, never 0 %', () => {
  const vm = buildViewModel(makeInput({
    agg: new Aggregator(), quotas: [],
    cfg: makeConfig({ 'tokenPace.budgets': [{ scope: 'total', period: 'month', unit: 'usd', limit: 20 }] }),
  }))
  const b = vm.budgets[0]
  assert.equal(b.share, null)
  assert.equal(b.shareText, '–')
  // And no projection either: an extrapolation from nothing is an invention.
  assert.equal(b.projectedText, null)
  const item = quickPickItems(vm).find((i) => i.label === b.text)
  assert.ok(item)
  assert.equal(/\b0 %/.test(item.label), false, item.label)
})

test('a budget nothing can measure is stated, never quietly forgotten', () => {
  // A money budget has nothing to count while the cost column is off. Dropping the row made
  // all three views describe the reader's own settings wrongly — the panel went as far as
  // "No budget configured" — so the row stays, every figure on it is a dash, and the setting
  // in the way is named. Absence is stated here exactly as it is everywhere else.
  const vm = buildViewModel(makeInput({
    agg: buildAgg(),
    cfg: makeConfig({
      'tokenPace.budgets': [{ scope: 'total', period: 'month', unit: 'usd', limit: 20 }],
      'tokenPace.showCost': false,
    }),
  }))
  assert.equal(vm.budgets.length, 1)
  const b = vm.budgets[0]
  assert.equal(b.unmeasurable, 'not measured while tokenPace.showCost is off')
  assert.equal(b.usedText, '–')
  assert.equal(b.shareText, '–')
  assert.equal(b.share, null)
  assert.equal(b.covered, false, 'no alert and no status-bar entry can stand on it')
  // The markdown keeps the section and says why the row is empty.
  const md = markdownDocument(vm)
  assert.ok(md.includes('## Budgets'), md)
  assert.ok(md.includes('tokenPace.showCost'), md)
  assert.equal(/\$0\.00|\b0 %/.test(md.slice(md.indexOf('## Budgets'), md.indexOf('\n## ', md.indexOf('## Budgets') + 5))), false, md)
  // And so do the Quick Pick and the copied summary.
  assert.ok(quickPickItems(vm).some((i) => i.label === b.text), b.text)
  assert.ok(toMarkdownSummary(vm).includes(b.text), b.text)
})

// ---------------------------------------------------------------------------
// 1.5 · the Agents section
//
// The same rules on the agent tree: asserted on the tree the view model builds from records
// the aggregator filled — through the builders, test/fixtures/agentWorld.ts — and on the
// markdown that prints it, never on the tree builder's helpers.
// ---------------------------------------------------------------------------

/**
 * The Agents world's view model; `select` picks the node whose details are open. The page carries
 * only what is open (1.6 D3), and the rules below hold of every node, so every node with children
 * is opened — unless `closed` asks for the tree as it starts.
 */
function agentsVm(o: { attribution?: Attribution; agg?: Aggregator; select?: (roots: TreeNode[]) => string; closed?: boolean } = {}): ViewModel {
  const attribution = o.attribution ?? 'none'
  const agg = o.agg ?? agentWorld(attribution).agg
  const config = makeConfig({ 'tokenPace.attribution': attribution })
  const agentsExpanded = o.closed === true ? [] : everyParent(agg, config, NOW)
  const first = buildViewModel(makeInput({ agg, cfg: config, ui: { agentsExpanded } }))
  if (!o.select) return first
  return buildViewModel(makeInput({ agg, cfg: config, ui: { agentsExpanded, agentSelected: o.select(first.agents.roots) } }))
}

/** Every node of the tree, each with its own details open — the panel the view model builds for it. */
function everyNodeOpen(attribution: Attribution = 'none', agg = agentWorld(attribution).agg): Array<{ node: TreeNode; vm: ViewModel }> {
  return treeNodes(agentsVm({ attribution, agg }).agents.roots)
    .map((node) => ({ node, vm: agentsVm({ attribution, agg, select: () => node.key }) }))
}

/** The lines of the markdown's Agents section, heading included. */
function agentSection(vm: ViewModel): string[] {
  const md = markdownDocument(vm)
  const at = md.indexOf('## Agents\n')
  assert.ok(at >= 0, 'the markdown has no Agents section')
  const end = md.indexOf('\n## ', at)
  return md.slice(at, end < 0 ? undefined : end).split('\n')
}

/**
 * The markdown's lines for the tree: one per node, in the order the tree has them — under the
 * tree's own heading, where there is a running list above it, whose lines carry a state too.
 */
function agentLines(vm: ViewModel): string[] {
  const all = agentSection(vm)
  const head = all.indexOf('### Sessions and agents')
  return all.slice(head < 0 ? 0 : head).filter((l) => /^\s*- \[/.test(l))
}

/** The markdown's running lines: one per item of the running list, in its order. */
function runningLines(vm: ViewModel): string[] {
  const all = agentSection(vm)
  const at = all.indexOf('### Running now')
  const head = all.indexOf('### Sessions and agents')
  return at < 0 ? [] : all.slice(at, head < 0 ? undefined : head).filter((l) => l.startsWith('- '))
}

const GERMAN = JSON.parse(readFileSync(path.join(ROOT, 'l10n', 'bundle.l10n.de.json'), 'utf8')) as Record<string, string>

function inGerman<T>(run: () => T): T {
  try {
    setBundle(GERMAN)
    setLocale('de')
    return run()
  } finally {
    setBundle(undefined)
    setLocale(undefined)
  }
}

test('a launch whose agent was never read shows no figure of its own — dashes, never 0', () => {
  const vm = agentsVm({ select: (roots) => treeNodes(roots).find((n) => n.kind === 'pending')?.key ?? '' })
  const pending = treeNodes(vm.agents.roots).filter((n) => n.kind === 'pending')
  assert.equal(pending.length, 1)
  const [p] = pending
  // Launched two minutes ago: running by the tree's clock, and nothing of it counted yet.
  assert.equal(p.state, 'running')
  assert.deepEqual([p.usage, p.duration, p.lowerBound], ['–', '–', false])
  // Its details have no count to show at all — what was launched, when, and by whom.
  const d = vm.agents.selected
  assert.ok(d)
  assert.equal(d.key, p.key)
  assert.deepEqual(d.rows.map((r) => r.label), ['Type', 'Models', 'ID', 'Started', 'Spawned by'])
  // The markdown prints the same two dashes, and no zero anywhere on the line.
  const line = agentLines(vm).find((l) => l.includes(p.label))
  assert.ok(line, agentLines(vm).join('\n'))
  assert.match(line, / · – · –$/)
  assert.equal(/(^|\s)0(\s|$)/.test(line), false, line)
})

test('an agent whose output is a lower bound says so wherever its figures are, and a finished one does not', () => {
  const { agg } = agentWorld()
  const vm = agentsVm({ agg })
  const lines = agentLines(vm)
  let marked = 0
  // 1.6 D4: an agent of a run without a counted reply has no node — its run's collector counts
  // it, and shows no figure it could mark.
  const counted = agg.agents().filter((rec) => rec.requests > 0 || rec.workflowId === null)
  assert.ok(counted.length < agg.agents().length, 'the world lost its agent without a counted reply')
  for (const rec of counted) {
    const n = agentNode(vm.agents.roots, rec.agentId)
    // The record's own count decides: some reply of it never reached its final line.
    const bound = rec.outputFinal < rec.requests
    assert.equal(n.lowerBound, bound, n.label)
    const d = agentsVm({ agg, select: () => n.key }).agents.selected
    assert.ok(d)
    const output = d.rows.find((r) => r.label === 'Output')
    assert.ok(output, n.label)
    assert.equal(output.note, bound ? '⚠ lower bound' : undefined, n.label)
    const line = lines.find((l) => l.includes(n.label))
    assert.ok(line, n.label)
    assert.equal(/ ⚠ · /.test(line), bound, line)
    if (bound) marked++
  }
  // Claude Code's agents end on an unfinished reply: all but the quick one here, which did not.
  assert.equal(marked, counted.length - 1)
  assert.equal(agentNode(vm.agents.roots, AGENT_WORLD.guide).lowerBound, false)
  // The running list says it too: a running agent is nearly always mid-reply, and the list is
  // the first thing on the page and in the document. A launch nothing was counted of never.
  const running = runningLines(vm)
  assert.equal(running.length, vm.agents.runningNow.length)
  assert.ok(vm.agents.runningNow.some((r) => r.lowerBound), 'no running agent of the world is a lower bound')
  vm.agents.runningNow.forEach((r, i) => {
    const n = treeNodes(vm.agents.roots).find((x) => x.key === r.key)
    assert.ok(n, r.key)
    assert.equal(r.lowerBound, n.lowerBound, r.key)
    assert.equal(/ ⚠( |$)/.test(running[i]), r.lowerBound, running[i])
  })
  // The markdown explains the mark, once.
  assert.equal(markdownDocument(vm).split('⚠ marks a lower bound').length - 1, 1)
})

test('an agent with no counted request is dashes throughout — no figure of it reads 0', () => {
  // The aggregator makes an agent's record on its first counted line, so the record without a
  // request comes from a snapshot: one whose counters another build left at nothing.
  const snap = JSON.parse(JSON.stringify(agentWorld().agg.toSnapshot())) as Snapshot
  const file = agentWorldFile(AGENT_WORLD.silent)
  const stored = snap.agents?.[file]
  assert.ok(stored, Object.keys(snap.agents ?? {}).join('\n'))
  Object.assign(stored, {
    input: 0, cacheWrite: 0, cacheWrite1h: 0, cacheRead: 0, output: 0, reasoning: 0,
    requests: 0, outputFinal: 0, toolCalls: 0,
  })
  const vm = agentsVm({ agg: Aggregator.fromSnapshot(snap), select: (roots) => agentNode(roots, AGENT_WORLD.silent).key })
  const n = agentNode(vm.agents.roots, AGENT_WORLD.silent)
  assert.equal(n.usage, '–')
  assert.equal(n.lowerBound, false, 'no request, so no reply that could have been cut short')
  const d = vm.agents.selected
  assert.ok(d)
  assert.equal(d.key, n.key)
  for (const label of ['Turns', 'Usage', 'Fresh input', 'Cache write 5m', 'Cache write 1h', 'Cache read', 'Output',
    'Reasoning', 'Tool calls']) {
    assert.equal(d.rows.find((r) => r.label === label)?.value, '–', label)
  }
  assert.equal(d.rows.some((r) => /^0(\s|$)/.test(r.value)), false, JSON.stringify(d.rows))
  const line = agentLines(vm).find((l) => l.includes(n.label))
  assert.ok(line)
  assert.equal(/(^|\s)0(\s|$)/.test(line), false, line)
})

test('every inferred state says it was inferred, and no recorded one says so — in English and in German', () => {
  // The glossary's word for it (§4.8, derived → abgeleitet), where the English says "inferred".
  assert.match(GERMAN['Running — inferred: at least one agent of this run is running.'], /abgeleitet/)
  const langs = [
    { lang: 'en', word: 'inferred', build: () => everyNodeOpen() },
    { lang: 'de', word: 'abgeleitet', build: () => inGerman(() => everyNodeOpen()) },
  ]
  for (const { lang, word, build } of langs) {
    const open = build()
    // Every state the tree can show is in the world, so the rule is tried on each of them.
    assert.deepEqual([...new Set(open.map((x) => x.node.state))].sort(),
      ['active', 'done', 'failed', 'idle', 'running', 'stopped', 'unknown'], lang)
    for (const { node, vm } of open) {
      const d = vm.agents.selected
      assert.ok(d, `${lang}: no details for ${node.key}`)
      assert.equal(d.state, node.state)
      const where = `${lang} ${node.kind} ${node.state}: ${d.stateText}`
      const says = d.stateText.includes(word)
      // Every inferred state says so — unknown included — and no recorded one does.
      assert.equal(says, node.derived, where)
    }
    // Only a recorded outcome is a fact, and the tree only calls those three states recorded —
    // 1.6 D7: a stop the parent recorded is the third.
    for (const { node } of open) {
      assert.equal(node.derived, node.state !== 'done' && node.state !== 'failed' && node.state !== 'stopped', node.key)
    }
  }
})

/**
 * The fields §3.2 gives the tree, a node, a details panel and one of its rows, and the fields
 * §9 of the 1.5.1 spec adds — a node's agent count, the running list and its items — nothing else.
 */
const TREE_FIELDS = new Set([
  'roots', 'selected', 'running', 'runningNow', 'runningMore', 'omittedRoots', 'note',
  'key', 'kind', 'label', 'sub', 'state', 'derived', 'usage', 'lowerBound', 'duration', 'startTs', 'lastTs',
  'agentCount', 'children',
  'title', 'stateText', 'rows', 'value',
  'context', 'waiting',
  // 1.6 P1: a session's agents' usage (D5), what Copy ID copies (D11), and a row's own layout,
  // clock and copy marks (R5, D11). `updatedAt` left the tree (D12).
  'usageAgents', 'id', 'live', 'copy',
  // 1.6 P2b: an attempt the workflow journal superseded (D7).
  'superseded',
  // 1.6 P2c: a node's tally (N1) — the object, its seven counts ('running' is the tree's own
  // field name too), and its two texts.
  'tally', 'tallyText', 'tallySpoken', 'started', 'done', 'failed', 'retried', 'stopped', 'unknown',
  // 1.6 P3a: whether a node has children, how many, and how many an open one does not show (D3).
  // `truncated` left the tree with the MAX_NODES cut.
  'hasChildren', 'childrenTotal', 'childrenMore',
  // 1.6 P5b: a running item's `running` — the running agents it stands for, a collector's many
  // (D4) — is the tree's own field name, listed above; the collector node brings no field.
])

test('the running list claims nothing the tree does not: running nodes only, a launch as a dash, never a 0', () => {
  for (const attribution of ['none', 'session'] as const) {
    const vm = agentsVm({ attribution })
    const nodes = treeNodes(vm.agents.roots)
    // 1.6 D4: a run's collector while one of its members runs — one entry for all of them.
    const running = nodes.filter((n) => (n.kind === 'agent' || n.kind === 'pending' || n.kind === 'noreply') && n.state === 'running')
    // The world has a running agent, a running launch and a collector with a running member: all
    // three listed, nothing else.
    assert.ok(running.length >= 3, String(running.length))
    assert.ok(running.some((n) => n.kind === 'noreply'), 'the world lost its running collector')
    assert.deepEqual(vm.agents.runningNow.map((r) => r.key).sort(), running.map((n) => n.key).sort())
    assert.equal(vm.agents.runningMore, 0)
    // 1.6 §2.3: the number the host polls by counts every running member — a collector's as many
    // as run of it — and so does every session's tally; the list's entries add up to it.
    assert.equal(vm.agents.running, vm.agents.runningNow.reduce((sum, r) => sum + r.running, 0))
    assert.equal(vm.agents.running, vm.agents.roots.reduce((sum, r) => sum + (r.tally?.running ?? 0), 0))
    for (const r of vm.agents.runningNow) {
      const n = running.find((x) => x.key === r.key)
      assert.ok(n, r.key)
      assert.equal(r.kind, n.kind, r.key)
      assert.equal(r.running, n.kind === 'noreply' ? n.tally?.running : 1, r.key)
      // The figure is the node's, and a launch nobody read a line of has none — nor a bound — and
      // neither has a collector.
      assert.equal(r.usage, n.kind === 'agent' ? n.usage : '–', r.key)
      assert.equal(r.lowerBound, n.kind === 'agent' ? n.lowerBound : false, r.key)
      assert.equal(/^0(\s|$)/.test(r.usage), false, r.usage)
      // Where it sits, and no project unless attribution names one.
      assert.ok(r.context.startsWith('Session '), r.context)
      assert.equal(/\b(alpha|beta)\b/.test(r.context), attribution !== 'none', `${attribution}: ${r.context}`)
    }
    // The markdown's running lines, in the same order, each marked as the inferred state it is,
    // with no zero either.
    const lines = runningLines(vm)
    assert.ok(lines.length > 0, agentSection(vm).join('\n'))
    assert.deepEqual(lines.map((l) => vm.agents.runningNow.findIndex((r) => l.startsWith(`- [~Running] ${r.label} · `))),
      vm.agents.runningNow.map((_, i) => i))
    for (const l of lines) assert.equal(/(^|\s)0(\s|$)/.test(l), false, l)
  }
})

test('a run\'s collector never shows a figure — dashes for what none of its agents had counted, never a 0', () => {
  // 1.6 D4: the agents of a run without a counted reply are counted in one collector node. Nothing
  // of them was counted, so no figure of the collector may read as one: on its row, in its running
  // entry, in its details, on its markdown lines — in English and in German.
  for (const lang of ['en', 'de']) {
    const build = (): Array<{ node: TreeNode; vm: ViewModel }> => everyNodeOpen('session').filter((x) => x.node.kind === 'noreply')
    const open = lang === 'de' ? inGerman(build) : build()
    assert.equal(open.length, 1, `${lang}: the world lost its collector`)
    for (const { node, vm } of open) {
      assert.deepEqual([node.usage, node.duration, node.usageAgents, node.lowerBound], ['–', '–', null, false], lang)
      assert.deepEqual([node.hasChildren, node.children, node.childrenTotal], [false, [], 0], lang)
      const d = vm.agents.selected
      assert.ok(d, lang)
      assert.equal(d.key, node.key)
      // Its details: its tally in words, its usage a dash with why, the rejections by reason — no
      // token count, no duration, nothing that reads 0.
      const usage = lang === 'de' ? 'Verbrauch' : 'Usage'
      assert.equal(d.rows.find((r) => r.label === usage)?.value, '–', lang)
      for (const r of d.rows) assert.equal(/(^|\s)0(\s|$)|^0/.test(r.value), false, `${lang}: ${r.label} ${r.value}`)
      const item = vm.agents.runningNow.find((r) => r.key === node.key)
      assert.ok(item, `${lang}: its running members, and no entry`)
      assert.deepEqual([item.usage, item.lowerBound], ['–', false], lang)
      const md = agentSection(vm).filter((l) => l.includes(node.label))
      assert.ok(md.length >= 2, md.join('\n'))
      for (const l of md) assert.equal(/(^|\s)0(\s|$)| ⚠/.test(l), false, l)
      assert.ok(md.some((l) => l.endsWith(' · – · –')), md.join('\n'))
    }
  }
})

test('a node\'s tally counts every agent below it once, sums to its started, and marks only the inferred counts', () => {
  // 1.6 N1, in English and in German: the tally is on a session, a run and an agent with agents
  // below it, and nowhere else; its fields sum to `started`, which is the node's agent count;
  // retried is exactly the superseded attempts below it; and only running and unknown — the
  // two derived states — carry the estimate mark, on the row and in the words.
  for (const lang of ['en', 'de']) {
    const vm = lang === 'de' ? inGerman(() => agentsVm()) : agentsVm()
    const nodes = treeNodes(vm.agents.roots)
    const below = (n: TreeNode): TreeNode[] => n.children.flatMap((c) => [...(c.kind === 'agent' || c.kind === 'pending' ? [c] : []), ...below(c)])
    // 1.6 D4: a collector's members are no nodes: its own tally is what it holds.
    const collected = (n: TreeNode): TreeNode[] => [n, ...treeNodes(n.children)].filter((c) => c.kind === 'noreply')
    const inCollectors = (n: TreeNode): number => collected(n).reduce((sum, c) => sum + (c.tally?.started ?? 0), 0)
    for (const n of nodes) {
      const members = below(n)
      const want = members.length + inCollectors(n) > 0
        && (n.kind === 'session' || n.kind === 'workflow' || n.kind === 'agent' || n.kind === 'noreply')
      assert.equal(n.tally !== null, want, `${lang} ${n.label}`)
      assert.equal(n.tallyText !== null, want, `${lang} ${n.label}`)
      assert.equal(n.tallySpoken !== null, want, `${lang} ${n.label}`)
      if (!n.tally || n.tallyText === null || n.tallySpoken === null) continue
      const t = n.tally
      assert.equal(t.done + t.failed + t.retried + t.stopped + t.running + t.unknown, t.started, `${lang} ${n.label}`)
      // Nothing is cut: the payload holds every node — and every collector, which holds its members.
      assert.equal(t.started, n.agentCount, `${lang} ${n.label}`)
      assert.equal(t.started, members.length + inCollectors(n), `${lang} ${n.label}`)
      const of = (f: keyof typeof t): number => collected(n).reduce((sum, c) => sum + (c.tally?.[f] ?? 0), 0)
      assert.equal(t.retried, members.filter((m) => m.superseded).length + of('retried'), `${lang} ${n.label}`)
      for (const st of ['done', 'failed', 'stopped', 'running', 'unknown'] as const) {
        assert.equal(t[st], members.filter((m) => !m.superseded && m.state === st).length + of(st), `${lang} ${n.label} ${st}`)
      }
      const parts = n.tallyText.split(' · ')
      assert.equal(parts[0], lang === 'de' ? `${t.started} gestartet` : `${t.started} started`)
      for (const p of parts.slice(1)) assert.equal(p.startsWith('~'), /[●?]$/.test(p), `${lang}: ${p}`)
      assert.equal(parts.some((p) => /(^|\D)0 /.test(p)), false, n.tallyText)
      const spoken = n.tallySpoken.split(', ')
      assert.equal(spoken.length, parts.length, n.tallySpoken)
      const about = lang === 'de' ? 'etwa ' : 'about '
      assert.equal(spoken.filter((p) => p.startsWith(about)).length, parts.filter((p) => p.startsWith('~')).length, n.tallySpoken)
      assert.equal(/[✓✕↻■●?~]/.test(n.tallySpoken), false, n.tallySpoken)
    }
    // The world holds every kind of member the tally counts, so each field was tried.
    const session = vm.agents.roots.find((r) => r.tally !== null && r.tally.retried > 0)
    assert.ok(session?.tally, `${lang}: no session with a retried attempt`)
    for (const f of ['done', 'failed', 'retried', 'stopped', 'running', 'unknown'] as const) {
      assert.ok(vm.agents.roots.some((r) => (r.tally?.[f] ?? 0) > 0), `${lang}: no session with ${f}`)
    }
  }
})

// 1.6 P3a (§3 D3): pinned the count against the children the page's payload carried, closed
// branches included. The payload carries a closed node's children no more, so the rule is taken
// on the markdown's tree, where every node is open — and the page, closed or open, says the same.
test('a closed node counts the agents below it on the whole tree, and a leaf counts none', () => {
  const agg = agentWorld().agg
  const config = makeConfig({ 'tokenPace.attribution': 'none' })
  const text = agentTreeFor({ agg, cfg: config, ui: defaultUiState(config), now: NOW }, 'text')
  // 1.6 D4: a collector counts its members — its tally's started — and every node above it with them.
  const agentLike = (n: TreeNode): number => n.children.reduce((s, c) => s + agentLike(c)
    + (c.kind === 'agent' || c.kind === 'pending' ? 1 : c.kind === 'noreply' ? c.tally?.started ?? 0 : 0), 0)
  const nodes = treeNodes(text.roots)
  assert.ok(nodes.some((n) => n.kind === 'workflow') && nodes.some((n) => n.kind === 'pending') && nodes.some((n) => n.kind === 'noreply'),
    'the world lost a kind of node')
  for (const n of nodes) {
    // Nothing of this world is past a window: the count is what the tree holds below the node.
    assert.equal(n.childrenMore, 0, n.label)
    assert.deepEqual([n.hasChildren, n.childrenTotal], [n.children.length > 0, n.children.length], n.label)
    if (n.kind === 'noreply') {
      // A leaf that holds members: it counts them, and lists none.
      assert.deepEqual([n.children.length, n.agentCount], [0, n.tally?.started], n.label)
      assert.ok(n.agentCount > 0, n.label)
      continue
    }
    assert.equal(n.agentCount, agentLike(n), n.label)
    if (n.children.length === 0) assert.equal(n.agentCount, 0, n.label)
  }
  // The page as it starts: the sessions alone, each counting what the whole tree holds below it.
  const closed = agentsVm({ closed: true }).agents
  assert.deepEqual(closed.roots.map((r) => r.key), text.roots.map((r) => r.key))
  for (const r of closed.roots) {
    const whole = text.roots.find((x) => x.key === r.key)
    assert.ok(whole)
    assert.deepEqual([r.children, r.childrenMore], [[], 0], r.label)
    assert.deepEqual([r.agentCount, r.hasChildren, r.childrenTotal, r.tallyText],
      [whole.agentCount, whole.hasChildren, whole.childrenTotal, whole.tallyText], r.label)
  }
  // Every node opened, the page is the markdown's tree: what the checks above ask of the page
  // hold of the document's tree as well.
  assert.deepEqual(agentsVm().agents.roots, text.roots)
})

test('the tree the page receives carries no key a transcript\'s content lives under, and none of the content', () => {
  const { agg, raw } = agentWorld('session')
  // Only a test of anything if the lines and sidecars it was read from do carry the content.
  for (const s of AGENT_CONTENT) assert.ok(raw.includes(s), `the fixture lost ${s}`)
  for (const k of ['description', 'prompt', 'summary', 'outputFile', 'content', 'result']) assert.ok(raw.includes(`"${k}"`), k)
  // The tree as each section push carries it: once with every node's details open in turn.
  const open = everyNodeOpen('session', agg)
  const keys = new Set<string>()
  const walk = (v: unknown): void => {
    if (Array.isArray(v)) v.forEach(walk)
    else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) { keys.add(k); walk(x) }
  }
  for (const { vm } of open) walk(JSON.parse(JSON.stringify(vm.agents)))
  for (const k of ['description', 'prompt', 'summary', 'outputFile']) assert.equal(keys.has(k), false, k)
  assert.deepEqual([...keys].filter((k) => !TREE_FIELDS.has(k)), [])
  // Nor the content under any other name — in the whole model, or in the markdown.
  const everything = open.map(({ vm }) => JSON.stringify(vm) + markdownDocument(vm)).join('\n')
  for (const s of AGENT_CONTENT) assert.equal(everything.includes(s), false, s)
  assert.equal(/synthetic/.test(everything), false)
})
