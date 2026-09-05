// SPDX-FileCopyrightText: 2026 Frederik Marx
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The two views that need no webview: a QuickPick list and a markdown document.
 *
 * Both read the same `ViewModel` the webview renders, which is the point — in a remote
 * session, a locked-down host or a screen reader, the numbers must be the same numbers, and
 * "same" only survives if it is one derivation and a test that counts the rows.
 *
 * Pure: no vscode. `nativeViews.ts` turns these lists and strings into commands.
 */

import { DEFAULT_BAR, renderBar } from './render'
import type { Forecast, Source } from './types'
import { SOURCE_TITLE } from './viewModel'
import type { ViewModel } from './viewModel'

export interface PickItem {
  label: string
  description?: string
  detail?: string
  /** A command the item runs when picked; only our own argument-less commands appear here. */
  command?: string
  args?: unknown[]
  /**
   * A group heading rather than a row: `nativeViews.ts` turns it into a
   * `QuickPickItemKind.Separator`, which carries no command and cannot be selected. A flat
   * list of a hundred rows is a haystack; the headings are what make it a document.
   */
  separator?: boolean
}

/** Wide enough to read a quarter from a half, narrow enough for a QuickPick line. */
const BAR_WIDTH = 10

function bar(percent: number, elapsed: number | null): string {
  return renderBar(percent, {
    ...DEFAULT_BAR, width: BAR_WIDTH, marker: elapsed, markerStyle: elapsed === null ? 'none' : 'marker',
  })
}

/** A table cell: pipes would split the column, newlines would end the row. */
function cell(s: string | null | undefined): string {
  if (s === null || s === undefined || s === '') return '–'
  return s.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ')
}

/**
 * "5 h" alone is ambiguous the moment both providers report a window of that length, and a
 * flat list has no card around a row to say which account it belongs to. The dashboard
 * prefixes the provider for exactly this reason; the fallback views do the same.
 */
function withSource(source: Source, label: string): string {
  const title = SOURCE_TITLE[source]
  if (!title) return label
  return label ? `${title} · ${label}` : title
}

/**
 * The forecast states in words. No fallback on purpose: an unknown state prints nothing
 * rather than leaking an identifier like "resetsFirst" into a sentence.
 */
const FORECAST_WORD: Record<Forecast['state'], string> = {
  none: '',
  measuring: 'measuring',
  idle: 'idle',
  resetsFirst: 'resets first',
  eta: 'projected',
  stale: 'stale',
  full: 'full',
}

/** The forecast sentence, or the bare state in words; '' when there is nothing to say. */
function forecastText(f: Forecast): string {
  return f.text || (FORECAST_WORD[f.state] ?? '')
}

type WindowVmOf = ViewModel['quotas'][number]['windows'][number]

/**
 * A forecast built on a reading older than the reset is not about the window on screen: a
 * `resetDue` window is "full" only in the cycle that has already ended. The dashboard drops
 * that line for the same reason, and the three views may not disagree about one window.
 */
function trustedForecast(w: WindowVmOf): Forecast | null {
  const f = w.forecast
  if (!f) return null
  return w.display === 'resetDue' && f.state === 'full' ? null : f
}

/**
 * Why a figure carries `≈`. The same sentence the dashboard prints under its totals table —
 * one caveat, worded once, so the two views cannot explain the mark differently.
 */
export const APPROX_NOTE = '≈ marks a span whose oldest hours are already rolled up into day totals'

/** True when the text is one of the segments already printed, compared whole and case-blind. */
function repeats(text: string, said: (string | null | undefined)[]): boolean {
  const t = text.trim().toLowerCase()
  return said.some((s) => typeof s === 'string' && s.trim().toLowerCase() === t)
}

/**
 * The verdict as the views print it: '' while the window is still measuring. A pace that
 * cannot be judged yet is not a fact about the window, and "measuring · window just reset"
 * beside a bar that has barely started said so at length in every view.
 */
function verdictText(w: WindowVmOf): string {
  return w.verdict.measuring ? '' : w.verdict.text
}

/** The forecast sentence the views print: '' while the forecast itself is still measuring. */
function forecastSentence(f: Forecast | null): string {
  return f && f.state !== 'measuring' ? f.text : ''
}

function windowLine(w: WindowVmOf): string {
  const parts = [verdictText(w)].filter(Boolean)
  // `stateText` and `resetLine` arrive already de-duplicated against each other and against
  // the verdict, so appending them cannot repeat a word the line already carries.
  if (w.stateText) parts.push(w.stateText)
  if (w.resetLine) parts.push(w.resetLine)
  const ft = forecastSentence(trustedForecast(w))
  // A forecast that only repeats a segment already on the line ("reset due" beside "reset
  // due") is not a second fact — compared segment for segment, never as a substring, so a
  // real sentence that merely contains one of the words is kept.
  if (ft && !repeats(ft, parts)) parts.push(ft)
  return parts.join(' · ')
}

// ---------------------------------------------------------------------------
// QuickPick
// ---------------------------------------------------------------------------

/**
 * The whole view model as a flat list. Every quota window, every totals row and every KPI
 * gets exactly one item — the parity test counts them against the markdown renderer.
 */
export function quickPickItems(vm: ViewModel): PickItem[] {
  const items: PickItem[] = []
  // A heading is only worth a line when something follows it, so it is held back until the
  // next row actually arrives; a group that turns out to be empty leaves no stray divider.
  let pending: string | null = null
  const add = (i: PickItem): void => {
    if (pending !== null) {
      items.push({ label: pending, separator: true })
      pending = null
    }
    items.push(i)
  }
  const group = (label: string): void => {
    pending = label
  }

  add({
    label: 'Open dashboard',
    description: `${vm.range.label} · ${vm.range.from} → ${vm.range.to}`,
    detail: `generated ${vm.generatedAt}`,
    command: 'tokenPace.showDashboard',
  })

  group('Quota')
  for (const q of vm.quotas) {
    const meta = [
      // `planText` is the whole fragment, "(as configured)" included: a name from a settings
      // file and a name from the provider must not read the same.
      q.planText,
      q.origin ? `via ${q.origin}` : null,
      q.ageText ? `updated ${q.ageText}` : null,
      q.stale ? 'stale' : null,
    ].filter(Boolean).join(' · ')
    add({
      label: q.title,
      description: meta,
      detail: q.problem ? `⚠ ${q.problem}` : undefined,
      command: q.problemAction?.command,
    })
    for (const w of q.windows) {
      add({
        label: `${w.label} ${bar(w.percent, w.elapsed)} ${w.percentText}`,
        description: windowLine(w),
        // The reset as a clock time, once: a window whose reset has passed says "reset due" in
        // the description already and gets no time here.
        detail: w.resetAbsolute && w.display !== 'resetDue' ? `reset at ${w.resetAbsolute}` : undefined,
      })
    }
    if (q.extra) {
      add({
        label: `Extra usage: ${q.extra.text}`,
        description: q.extra.billed ? 'billed' : q.extra.enabled ? 'enabled' : 'off',
      })
    }
    // The provider reported no window; this is what was counted locally instead. The sentence
    // is the view model's own, word for word in all three views — a second phrasing of "this
    // is not the provider's window" is a second promise.
    if (q.localBlock) add({ label: q.localBlock.text, description: q.title })
  }

  group('Summary')
  for (const s of vm.digest) add({ label: s })

  group('Context window')
  if (vm.context) {
    add({
      label: `Context window: ${vm.context.text}`,
      description: vm.context.note,
      detail: [
        vm.context.ageText ? `updated ${vm.context.ageText}` : null,
        vm.context.fresh ? null : 'stale',
      ].filter(Boolean).join(' · ') || undefined,
    })
  }

  group('Key figures')
  for (const k of vm.kpis) {
    add({
      label: `${k.label}: ${k.value}`,
      description: k.delta ? [k.delta.glyph, k.delta.text].filter(Boolean).join(' ') : undefined,
      detail: [k.note, k.provenance].filter(Boolean).join(' · '),
    })
  }

  group('Tokens')
  for (const t of vm.totals) {
    for (const r of t.rows) {
      add({
        label: `${t.title} · ${r.label}: ${r.usage}`,
        description: `${r.requests} req · ${r.cost}${r.costPartial ? ' ⚠' : ''}`,
        detail: `fresh ${r.freshInput} · write5m ${r.cacheWrite5m} · write1h ${r.cacheWrite1h} · `
          + `read ${r.cacheRead} · output ${r.output} · reasoning ${r.reasoning} · `
          + `hit ${r.cacheHit} · ${r.perRequest}/req${r.incomplete ? ' · output is a lower bound' : ''}`,
      })
    }
  }

  group('Cache')
  for (const c of vm.cacheEconomy) {
    add({
      label: `Cache economy ${withSource(c.source, '')}: ${c.hitRate}`,
      description: `saved ${c.savedUsd} · blended ${c.blendedPerM}`,
      detail: c.note + (c.partial ? ' · some models unpriced' : ''),
    })
  }

  group('Reset history')
  for (const r of retroWorthShowing(vm)) {
    add({ label: `Reset history ${withSource(r.source, r.label)}`, description: r.text })
  }

  group('Models')
  for (const m of vm.models.rows) {
    add({
      label: `${m.model}${m.isSub ? ' (sub)' : ''}: ${m.usageText}`,
      description: `${m.costText} · ${m.share} of usage · hit ${m.cacheHit}`,
      detail: `${m.price}${m.turnAvg ? ` · Avg turn ${m.turnAvg}` : ''}${m.turnP90 ? ` · P90 ${m.turnP90}` : ''}`,
    })
  }
  if (vm.models.hidden > 0) {
    add({
      label: `${vm.models.hidden} more model rows`,
      description: 'raise tokenPace.dashboard.modelRows to see them',
      command: 'tokenPace.openSettings',
    })
  }

  group('Records')
  for (const row of recordLines(vm)) add(row)

  group('Tools')
  for (const row of toolLines(vm)) add(row)

  group('Budgets')
  for (const row of budgetLines(vm)) add(row)

  group('Projects')
  for (const p of vm.projects.rows) {
    add({
      label: `Project ${p.project}: ${p.usage}`,
      description: `${p.sessions} session(s) · hit ${p.cacheHit}`,
    })
  }
  group('Sessions')
  for (const s of vm.sessions.rows) {
    add({
      label: `Session ${s.session}: ${s.usage}`,
      description: `${s.project} · ${s.duration} · ${s.requests} req`,
      detail: [s.models, s.cacheState].filter(Boolean).join(' · '),
    })
  }

  group('Data quality')
  for (const line of dataQualityLines(vm)) add({ label: line })

  group('Actions')
  for (const a of [
    { label: 'Fetch quota now', command: 'tokenPace.refreshQuota' },
    { label: 'Re-read token history', command: 'tokenPace.rescan' },
    { label: 'Show log', command: 'tokenPace.showOutput' },
    { label: 'Open settings', command: 'tokenPace.openSettings' },
    { label: 'Export CSV…', command: 'tokenPace.exportCsv' },
    { label: 'Export JSON…', command: 'tokenPace.exportJson' },
    { label: 'Copy usage summary', command: 'tokenPace.copySummary' },
  ]) add(a)

  group('Notes')
  for (const f of vm.footnotes) add({ label: f })
  return items
}

/**
 * The Records section as flat rows.
 *
 * The two day records are always stated, with a dash where there is none: "no peak day" is a
 * fact about the range, and leaving the row out would look like a rendering that forgot it.
 * The three tables are as long as `dashboard.topN` allows and no longer.
 */
function recordLines(vm: ViewModel): PickItem[] {
  const r = vm.records
  const out: PickItem[] = []
  out.push({
    label: `Record peak day: ${r.peakDay ? `${r.peakDay.day} — ${r.peakDay.usage}` : '–'}`,
    description: r.peakDay && r.peakDay.cost !== '–'
      ? `${r.peakDay.cost}${r.peakDay.costPartial ? ' ⚠' : ''}`
      : undefined,
  })
  out.push({
    label: `Record streak: ${r.streak ? `${r.streak.days} day${r.streak.days === 1 ? '' : 's'}` : '–'}`,
    description: r.streak ? `${r.streak.from} → ${r.streak.to}` : undefined,
  })
  const table = (kind: string, rows: ViewModel['records']['topModels']): void => {
    for (const e of rows) {
      out.push({
        label: `Top ${kind} ${e.label}: ${e.usage}`,
        description: [`${e.share} of usage`, e.cost === '–' ? null : e.cost].filter(Boolean).join(' · '),
        detail: e.detail ?? undefined,
      })
    }
  }
  table('model', r.topModels)
  table('project', r.topProjects)
  table('session', r.topSessions)
  if (!r.attributionOn) {
    out.push({ label: 'Top projects and sessions need tokenPace.attribution', command: 'tokenPace.openSettings' })
  }
  for (const n of [r.note, r.sessionNote]) if (n) out.push({ label: n })
  return out
}

/**
 * The tool table as flat rows.
 *
 * The notes travel with the rows rather than only with the table: in a flat list the sentence
 * that says since when tool calls are counted is the only thing between an empty table and
 * the impression that no tool was ever used.
 */
function toolLines(vm: ViewModel): PickItem[] {
  const t = vm.tools
  const out: PickItem[] = []
  for (const r of t.rows) {
    out.push({
      label: `Tool ${r.name}: ${r.callsText}`,
      description: `${r.share} of calls · ${r.models}`,
      detail: r.sources || undefined,
    })
  }
  if (t.hidden > 0) {
    out.push({
      label: `${t.hidden} more tool row(s)`,
      description: 'raise tokenPace.dashboard.topN to see them',
      command: 'tokenPace.openSettings',
    })
  }
  for (const n of t.notes) out.push({ label: n })
  return out
}

/**
 * The budgets as flat rows.
 *
 * The label is `row.text` and nothing else — the same sentence the dashboard card and the
 * markdown table are built from, so a budget cannot read one way here and another there. The
 * period bounds sit in the description because a share without its period is a number
 * without a question.
 */
function budgetLines(vm: ViewModel): PickItem[] {
  return vm.budgets.map((b) => ({
    label: b.text,
    description: [
      `${b.from} → ${b.last}`,
      // A lower bound, said the way every other lower bound in this extension is said.
      b.partial ? '⚠ lower bound' : null,
      b.over ? 'over budget' : null,
    ].filter(Boolean).join(' · '),
    detail: b.projectionBasis ?? undefined,
  }))
}

/**
 * The reset history, unless every window is still waiting for its first complete cycle.
 *
 * One "not enough data yet" row is a fact worth stating; four of them in a row are a wall
 * that pushes the figures below it out of view, and they say nothing the first one did not.
 * The markdown document keeps them all — it is read by scrolling, not by filtering.
 */
function retroWorthShowing(vm: ViewModel): ViewModel['retro'] {
  const known = vm.retro.some((r) => !r.text.startsWith('not enough data'))
  return known ? vm.retro : []
}

// ---------------------------------------------------------------------------
// Markdown
// ---------------------------------------------------------------------------

function dataQualityLines(vm: ViewModel): string[] {
  const d = vm.dataQuality
  const out: string[] = [
    `Roots: ${d.roots.length > 0 ? d.roots.join(', ') : 'none'} · ${d.files} file(s)`,
    `Coverage: ${d.oldestDay ?? '–'} → ${d.newestDay ?? '–'} · `
    + `${d.buckets.hour} hour / ${d.buckets.day} day / ${d.buckets.month} month buckets · `
    + `snapshot ${Math.round(d.snapshotBytes / 1024)} KB`,
    `Lower bound share: ${d.lowerBoundShare}`
    + (d.unpricedModels.length > 0 ? ` · unpriced: ${d.unpricedModels.join(', ')}` : '')
    + (d.familyPriced.length > 0 ? ` · family-priced: ${d.familyPriced.join(', ')}` : ''),
    `Retention: ${d.retention.hourDays} d hourly · ${d.retention.days} d daily · `
    + `${d.retention.historyDays} d quota history`,
    `Quota history: ${d.history.samples} samples · ${Math.round(d.history.bytes / 1024)} KB · `
    + `oldest ${d.history.oldest ?? '–'}`,
    `Consent: ${d.consent} · ${d.leader} · attribution ${d.attribution} · v${d.version}`,
  ]
  for (const q of d.quota) {
    const cands = q.candidates.length > 0
      ? q.candidates.map((c) => `${c.id} ${c.ok ? `${c.ageSec === null ? 'ok' : `${Math.round(c.ageSec / 60)} min`}` : (c.problem ?? 'unavailable')}`).join(' · ')
      : 'no source answered'
    out.push(`Quota sources ${q.source}: ${cands}`)
    if (q.drift.length > 0) out.push(`Unrendered fields ${q.source}: ${q.drift.join(', ')}`)
  }
  for (const c of d.calibration) out.push(`Calibration ${c.source} ${c.windowId}: ${c.text}`)
  if (d.bridge) out.push(`Status line: ${d.bridge}`)
  return out
}

/** The read-only `tokenpace:/usage.md` document — the same figures as tables. */
export function markdownDocument(vm: ViewModel): string {
  const L: string[] = []
  L.push('# Token Pace — usage')
  L.push('')
  L.push(`*${vm.range.label} · ${vm.range.from} → ${vm.range.to} · generated ${vm.generatedAt}*`)
  if (vm.preview) L.push('', '> **Preview data — not a reading.**')
  L.push('')

  if (vm.firstRun) {
    L.push('## First run', '', vm.firstRun.text, '')
  }

  L.push('## Quota', '')
  if (vm.quotas.length === 0) L.push('_No quota reading._', '')
  for (const q of vm.quotas) {
    const meta = [
      q.planText,
      q.origin ? `via ${q.origin}` : null,
      q.ageText ? `updated ${q.ageText}` : null,
      q.stale ? '⚠ stale' : null,
    ].filter(Boolean).join(' · ')
    L.push(`### ${q.title}${meta ? ` — ${meta}` : ''}`)
    L.push('')
    if (q.problem) {
      L.push(`> ⚠ ${q.problem}${q.problemAction ? ` — ${q.problemAction.label}` : ''}`)
      L.push('')
    }
    if (q.windows.length > 0) {
      L.push('| Window | Used | Elapsed | Pace | Resets | Forecast |')
      L.push('|---|---|---|---|---|---|')
      for (const w of q.windows) {
        const f = trustedForecast(w)
        // Same rule as the QuickPick line: the Forecast column stays empty when it would only
        // repeat the Resets or Pace column of the same row, and a forecast still measuring
        // has no sentence to print at all.
        const ft = f && f.state !== 'measuring' ? forecastText(f) : ''
        const verdict = verdictText(w)
        const forecastCell = repeats(ft, [w.reset, w.stateText, verdict]) ? '' : ft
        L.push(`| ${cell(w.label)} | \`${bar(w.percent, w.elapsed)}\` ${cell(w.percentText)} | `
          + `${w.elapsed === null ? '–' : `${Math.round(w.elapsed)} %`} | `
          + `${cell([verdict, w.stateText].filter(Boolean).join(' · '))} | `
          + `${cell(w.reset)} | ${cell(forecastCell)} |`)
      }
      L.push('')
    }
    if (q.extra) {
      L.push(`Extra usage: ${cell(q.extra.text)} (${q.extra.billed ? 'billed' : q.extra.enabled ? 'enabled' : 'off'})`, '')
    }
    if (q.localBlock) L.push(q.localBlock.text, '')
    const f = q.freshness
    L.push(`Freshness — last check ${cell(f.lastCheck)} · last data ${cell(f.lastData)} · `
      + `last local event ${cell(f.lastEvent)} · next refresh ${cell(f.nextRefresh)} · `
      + `snapshot ${cell(f.snapshotAge)}`)
    // The one reader of `usagePageUrl` since the card stopped printing it — the same URL the
    // tooltip links from the provider name, null when `tokenPace.usagePageLinks` is off.
    if (q.usagePageUrl) L.push(`Official page: ${q.usagePageUrl}`)
    L.push('')
  }

  if (vm.digest.length > 0) {
    L.push('## Summary', '')
    for (const s of vm.digest) L.push(`- ${s}`)
    L.push('')
  }

  if (vm.context) {
    L.push('## Context window', '')
    L.push(`${vm.context.text} — ${vm.context.note}`
      + (vm.context.ageText ? ` · updated ${vm.context.ageText}` : '')
      + (vm.context.fresh ? '' : ' · ⚠ stale'))
    L.push('')
  }

  L.push('## Key figures', '')
  L.push('| Figure | Value | Change | Basis |')
  L.push('|---|---|---|---|')
  for (const k of vm.kpis) {
    L.push(`| ${cell(k.label)} | ${cell(k.value)} | ${k.delta ? cell([k.delta.glyph, k.delta.text].filter(Boolean).join(' ')) : '–'} | `
      + `${cell([k.note, k.provenance].filter(Boolean).join(' · '))} |`)
  }
  L.push('')

  for (const t of vm.totals) {
    L.push(`## Tokens — ${t.title}`, '')
    L.push('| Period | Usage | Fresh input | Write 5m | Write 1h | Cache read | Output | Reasoning | Req. | Cache hit | Per req. | API cost |')
    L.push('|---|---|---|---|---|---|---|---|---|---|---|---|')
    for (const r of t.rows) {
      L.push(`| ${cell(r.label)} | ${cell(r.usage)} | ${cell(r.freshInput)} | ${cell(r.cacheWrite5m)} | `
        + `${cell(r.cacheWrite1h)} | ${cell(r.cacheRead)} | ${cell(r.output)}${r.incomplete ? ' ⚠' : ''} | `
        + `${cell(r.reasoning)} | ${cell(r.requests)} | ${cell(r.cacheHit)} | ${cell(r.perRequest)} | `
        + `${cell(r.cost)}${r.costPartial ? ' ⚠' : ''} |`)
    }
    L.push('')
    // Once per table, never once per row: the mark is the same caveat wherever it appears.
    if (t.rows.some((r) => r.approx)) L.push(`_${APPROX_NOTE}_`, '')
  }

  if (vm.composition.length > 0) {
    L.push('## Composition', '')
    L.push('| Provider | Part | Tokens |')
    L.push('|---|---|---|')
    for (const c of vm.composition) {
      for (const p of c.parts) L.push(`| ${cell(withSource(c.source, ''))} | ${cell(p.text)} | ${p.tokens > 0 ? p.tokens.toLocaleString('en-US') : '–'} |`)
    }
    L.push('')
  }

  L.push('## Cache economy', '')
  L.push('| Provider | Hit rate | Realised saving | Blended $/1M | Basis |')
  L.push('|---|---|---|---|---|')
  for (const c of vm.cacheEconomy) {
    L.push(`| ${cell(withSource(c.source, ''))} | ${cell(c.hitRate)} | ${cell(c.savedUsd)}${c.partial ? ' ⚠' : ''} | `
      + `${cell(c.blendedPerM)} | ${cell(c.note)} |`)
  }
  L.push('')

  L.push('## Calendar', '')
  L.push('| Period | Usage | API cost | Requests | Active days | Avg per active day |')
  L.push('|---|---|---|---|---|---|')
  for (const p of [vm.calendar.thisWeek, vm.calendar.thisMonth, vm.calendar.lastMonth, vm.calendar.year]) {
    L.push(`| ${cell(p.label)} | ${cell(p.usage)} | ${cell(p.cost)} | ${cell(p.requests)} | `
      + `${p.activeDays} | ${cell(p.avgPerDay)} |`)
  }
  if (vm.calendar.thisMonth.projection) {
    L.push('')
    L.push(`Month projection: ${vm.calendar.thisMonth.projection} — ${vm.calendar.thisMonth.projectionBasis}`)
  }
  for (const p of vm.planFactor) L.push('', `Plan comparison (${withSource(p.source, '')}): ${p.text}${p.partial ? ' ⚠ lower bound' : ''}`)
  L.push('')

  if (vm.models.rows.length > 0) {
    L.push('## Models', '')
    // The columns of the totals table above, in its order and with its words, so the two can
    // be read against each other. No Price column: the rates are a provenance, not a figure,
    // and they are named in the footnotes and in the QuickPick line for the same row.
    L.push('| Model | Provider | Usage | Fresh input | Write 5m | Write 1h | Cache read | Output '
      + '| Reasoning | Req. | Cache hit | Per req. | API cost | Share | Cost share |')
    L.push('|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|')
    for (const m of vm.models.rows) {
      L.push(`| ${cell(m.model)}${m.isSub ? ' (sub)' : ''}${m.tier === 'standard' ? '' : ` [${m.tier}]`} | `
        + `${cell(withSource(m.source, ''))} | ${cell(m.usageText)} | ${cell(m.freshInput)} | `
        + `${cell(m.cacheWrite5m)} | ${cell(m.cacheWrite1h)} | ${cell(m.cacheRead)} | ${cell(m.output)} | `
        + `${cell(m.reasoning)} | ${cell(m.requests)} | ${cell(m.cacheHit)} | ${cell(m.perRequest)} | `
        + `${cell(m.costText)}${m.priced === 'family' ? ' ⚠' : ''} | ${cell(m.share)} | `
        + `${cell(m.costShare)} |`)
    }
    if (vm.models.hidden > 0) {
      L.push('')
      L.push(`_${vm.models.hidden} more — set \`tokenPace.dashboard.modelRows\`._`)
    }
    L.push('')
  }

  if (vm.retro.length > 0) {
    L.push('## Reset history', '')
    for (const r of vm.retro) L.push(`- **${withSource(r.source, r.label)}**: ${r.text}`)
    L.push('')
  }

  L.push('## Activity', '')
  L.push(`Streak ${vm.heatmap.streak} day(s) · longest ${vm.heatmap.longestStreak} · `
    + `active ${vm.heatmap.activeDays} · peak ${vm.heatmap.peakDay ? `${vm.heatmap.peakDay.day} (${vm.heatmap.peakDay.text})` : '–'}`
    + (vm.heatmap.variability ? ` · CV ${vm.heatmap.variability.cv} · ${vm.heatmap.variability.spikyDays} spiky day(s)` : ''))
  L.push('')
  const peak = vm.hours.peakHour
  // The same sentence the dashboard prints under the weekday grid: this document has no grid
  // to draw, but the hours it does print stand on exactly those days.
  L.push(`Hours (${vm.hours.zone}, ${vm.hours.days} day(s)): peak `
    + `${peak === null ? '–' : `${String(peak).padStart(2, '0')}:00`}`
    + ` · ${vm.hours.basis.text}`
    + (vm.hours.note ? ` · ${vm.hours.note}` : ''))
  L.push('')
  L.push('| Hour | Usage |')
  L.push('|---|---|')
  for (const h of vm.hours.profile) {
    L.push(`| ${String(h.hour).padStart(2, '0')}:00 | ${cell(h.text)} |`)
  }
  L.push('')

  L.push('## Records', '')
  const rec = vm.records
  L.push(`Peak day: ${rec.peakDay ? `${rec.peakDay.day} — ${rec.peakDay.usage}` : '–'}`
    + (rec.peakDay && rec.peakDay.cost !== '–'
      ? ` · ${rec.peakDay.cost}${rec.peakDay.costPartial ? ' ⚠' : ''}` : ''))
  L.push('')
  L.push(`Longest streak: ${rec.streak ? `${rec.streak.days} day${rec.streak.days === 1 ? '' : 's'} · ${rec.streak.from} → ${rec.streak.to}` : '–'}`)
  L.push('')
  for (const [head, rows] of [
    ['Model', rec.topModels], ['Project', rec.topProjects], ['Session', rec.topSessions],
  ] as const) {
    if (rows.length === 0) continue
    L.push(`| Top ${head.toLowerCase()} | Detail | Usage | Share | API cost |`)
    L.push('|---|---|---|---|---|')
    for (const e of rows) {
      L.push(`| ${cell(e.label)} | ${cell(e.detail)} | ${cell(e.usage)} | ${cell(e.share)} | ${cell(e.cost)} |`)
    }
    L.push('')
  }
  if (!rec.attributionOn) L.push('_Top projects and sessions need `tokenPace.attribution`._', '')
  for (const n of [rec.note, rec.sessionNote]) if (n) L.push(`_${n}_`, '')

  L.push('## Tools', '')
  const tools = vm.tools
  if (tools.rows.length > 0) {
    L.push('| Tool | Provider | Calls | Share | Models |')
    L.push('|---|---|---|---|---|')
    for (const r of tools.rows) {
      L.push(`| ${cell(r.name)} | ${cell(r.sources)} | ${cell(r.callsText)} | ${cell(r.share)} | `
        + `${cell(r.models)} |`)
    }
    L.push('')
    L.push(`${tools.totalText} call(s) · ${tools.distinct} distinct tool(s)`
      + (tools.hidden > 0 ? ` · ${tools.hidden} more not listed` : ''))
    L.push('')
  }
  for (const n of tools.notes) L.push(`_${n}_`, '')

  if (vm.budgets.length > 0) {
    L.push('## Budgets', '')
    L.push('| Budget | Period | Used | Limit | Share | Projected |')
    L.push('|---|---|---|---|---|---|')
    for (const b of vm.budgets) {
      L.push(`| ${cell(b.label)}${b.partial ? ' ⚠' : ''} | ${b.from} → ${b.last} | `
        + `${cell(b.usedText)} | ${cell(b.limitText)} | ${cell(b.shareText)}${b.over ? ' ⚠' : ''} | `
        + `${cell(b.projectedText ? `${b.projectedText} by ${b.last}` : null)} |`)
    }
    L.push('')
    // A row of dashes is a configured budget nothing is counting, not an idle period, so the
    // switch that is in the way is named under the table rather than left to be guessed.
    const unmeasured = vm.budgets.filter((b) => b.unmeasurable !== null)
    if (unmeasured.length > 0) {
      L.push(`_${unmeasured.map((b) => `${b.label} — ${b.unmeasurable}`).join('; ')}._`, '')
    }
    // The one sentence that keeps a budget from being read as a plan limit.
    L.push('_A budget is your own number; `usd` is the hypothetical API equivalent, not a bill._', '')
  }

  if (vm.projects.enabled && vm.projects.rows.length > 0) {
    L.push('## Projects', '')
    L.push('| Project | Usage | Requests | Cache hit | Share | Sessions |')
    L.push('|---|---|---|---|---|---|')
    for (const p of vm.projects.rows) {
      L.push(`| ${cell(p.project)} | ${cell(p.usage)} | ${cell(p.requests)} | ${cell(p.cacheHit)} | `
        + `${cell(p.share)} | ${p.sessions} |`)
    }
    L.push('')
  }
  if (vm.sessions.enabled && vm.sessions.rows.length > 0) {
    L.push('## Sessions', '')
    L.push('| Session | Project | Started | Duration | Usage | Req. | Models | Cache |')
    L.push('|---|---|---|---|---|---|---|---|')
    for (const s of vm.sessions.rows) {
      L.push(`| ${cell(s.session)}${s.isSub ? ' (sub)' : ''} | ${cell(s.project)} | ${cell(s.started)} | `
        + `${cell(s.duration)} | ${cell(s.usage)} | ${cell(s.requests)} | ${cell(s.models)} | `
        + `${cell(s.cacheState)} |`)
    }
    L.push('')
  }

  if (vm.drill) {
    L.push(`## Drill-down ${vm.drill.day}`, '')
    L.push('| Model | Usage | API cost | Req. |')
    L.push('|---|---|---|---|')
    for (const m of vm.drill.models) {
      L.push(`| ${cell(m.model)} | ${cell(m.usageText)} | ${cell(m.costText)} | ${cell(m.requests)} |`)
    }
    L.push('')
  }

  L.push('## Data quality', '')
  for (const line of dataQualityLines(vm)) L.push(`- ${line}`)
  L.push('')

  L.push('---', '')
  for (const f of vm.footnotes) L.push(`- ${f}`)
  L.push('')
  return L.join('\n')
}
