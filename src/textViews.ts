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

import { t } from './i18n'
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

/** "1 day" / "5 days" — two whole phrases, because a count governs the noun. */
function dayCount(days: number): string {
  return days === 1 ? t('{0} day', days) : t('{0} days', days)
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
 *
 * A function rather than a table: the translation bundle is installed at activation, so a
 * table built at module load would stay English for the whole session.
 */
function forecastWord(state: Forecast['state']): string {
  switch (state) {
    case 'measuring': return t('measuring')
    case 'idle': return t('idle')
    case 'resetsFirst': return t('resets first')
    case 'eta': return t('projected')
    case 'stale': return t('stale')
    case 'full': return t('full')
    default: return ''
  }
}

/** The forecast sentence, or the bare state in words; '' when there is nothing to say. */
function forecastText(f: Forecast): string {
  return f.text || forecastWord(f.state)
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
 * one caveat, worded once, so the two views cannot explain the mark differently. It says
 * "lower bound" rather than "approximate": what is missing from such a row is whole hours
 * of usage, which can only make the figure too small, never too large.
 */
export function approxNote(): string {
  return t('≈ marks a lower bound: the oldest hours of the span are already rolled up into day totals')
}

/** True when the text is one of the segments already printed, compared whole and case-blind. */
function repeats(text: string, said: (string | null | undefined)[]): boolean {
  const want = text.trim().toLowerCase()
  return said.some((s) => typeof s === 'string' && s.trim().toLowerCase() === want)
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

/**
 * The first `n` lines of a window's explanation, or all of them. A payload from a build
 * that predates the field yields nothing rather than a sentence of this view's own.
 */
function explainLines(w: WindowVmOf, n = Infinity): string[] {
  const e = w.explain
  if (!e || !Array.isArray(e.lines)) return []
  return e.lines.filter((l) => typeof l === 'string' && l !== '').slice(0, n)
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
    label: t('Open dashboard'),
    description: `${vm.range.label} · ${vm.range.from} → ${vm.range.to}`,
    detail: t('generated {0}', vm.generatedAt),
    command: 'tokenPace.showDashboard',
  })

  group(t('Quota'))
  for (const q of vm.quotas) {
    const meta = [
      // `planText` is the whole fragment, "(as configured)" included: a name from a settings
      // file and a name from the provider must not read the same.
      q.planText,
      q.origin ? t('via {0}', q.origin) : null,
      q.ageText ? t('updated {0}', q.ageText) : null,
      q.stale ? t('stale') : null,
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
        // The reset as a clock time, once — a window whose reset has passed says "reset due"
        // in the description already and gets no time here — then why the bar has its colour:
        // the first two lines of the explanation the dashboard shows on hover, because a list
        // without a card has no other place to put them.
        detail: [
          w.resetAbsolute && w.display !== 'resetDue' ? t('reset at {0}', w.resetAbsolute) : null,
          ...explainLines(w, 2),
        ].filter(Boolean).join(' · ') || undefined,
      })
    }
    // The bridge's prompt-cache line, word for word as the card prints it. Only ever present
    // on the Claude card, and only while the status line delivered one.
    if (q.promptCache) add({ label: q.promptCache.text, description: q.promptCache.note })
    if (q.extra) {
      add({
        label: t('Extra usage: {0}', q.extra.text),
        description: q.extra.billed ? t('billed') : q.extra.enabled ? t('enabled') : t('off'),
      })
    }
    // The provider reported no window; this is what was counted locally instead. The sentence
    // is the view model's own, word for word in all three views — a second phrasing of "this
    // is not the provider's window" is a second promise.
    if (q.localBlock) add({ label: q.localBlock.text, description: q.title })
  }

  group(t('Summary'))
  for (const s of vm.digest) add({ label: s })

  group(t('Context window'))
  if (vm.context) {
    add({
      label: t('Context window: {0}', vm.context.text),
      description: vm.context.note,
      detail: [
        vm.context.ageText ? t('updated {0}', vm.context.ageText) : null,
        vm.context.fresh ? null : t('stale'),
      ].filter(Boolean).join(' · ') || undefined,
    })
  }

  group(t('Key figures'))
  for (const k of vm.kpis) {
    add({
      label: `${k.label}: ${k.value}`,
      description: k.delta ? [k.delta.glyph, k.delta.text].filter(Boolean).join(' ') : undefined,
      // What the figure is and what it stands on — the same sentence the dashboard shows on
      // hover, because a list without a card has no other place to put it.
      detail: [k.explain.what, k.explain.provenance].filter(Boolean).join(' · '),
    })
  }

  group(t('Tokens'))
  for (const table of vm.totals) {
    for (const r of table.rows) {
      add({
        label: `${table.title} · ${r.label}: ${r.usage}`,
        description: `${t('{0} req', r.requests)} · ${r.cost}${r.costPartial ? ' ⚠' : ''}`,
        detail: t('fresh {0} · write5m {1} · write1h {2} · read {3} · output {4} · reasoning {5} · hit {6} · {7}/req',
          r.freshInput, r.cacheWrite5m, r.cacheWrite1h, r.cacheRead, r.output, r.reasoning,
          r.cacheHit, r.perRequest)
          + (r.incomplete ? ` · ${t('output is a lower bound')}` : ''),
      })
    }
  }

  group(t('Cache'))
  for (const c of vm.cacheEconomy) {
    add({
      label: t('Cache economy {0}: {1}', withSource(c.source, ''), c.hitRate),
      description: t('saved {0} · blended {1}', c.savedUsd, c.blendedPerM),
      detail: c.note + (c.partial ? ` · ${t('some models unpriced')}` : ''),
    })
  }

  group(t('Reset history'))
  for (const r of retroWorthShowing(vm)) {
    add({ label: t('Reset history {0}', withSource(r.source, r.label)), description: r.text })
  }

  group(t('Models'))
  for (const m of vm.models.rows) {
    add({
      label: `${m.model}${m.isSub ? ` ${t('(sub)')}` : ''}: ${m.usageText}`,
      description: t('{0} · {1} of usage · hit {2}', m.costText, m.share, m.cacheHit),
      detail: `${m.price}${m.turnAvg ? ` · ${t('Avg turn {0}', m.turnAvg)}` : ''}`
        + `${m.turnP90 ? ` · ${t('P90 {0}', m.turnP90)}` : ''}`,
    })
  }
  if (vm.models.hidden > 0) {
    add({
      label: t('{0} more model rows', vm.models.hidden),
      description: t('raise tokenPace.dashboard.modelRows to see them'),
      command: 'tokenPace.openSettings',
    })
  }

  group(t('Records'))
  for (const row of recordLines(vm)) add(row)

  group(t('Tools'))
  for (const row of toolLines(vm)) add(row)

  group(t('Budgets'))
  for (const row of budgetLines(vm)) add(row)

  group(t('Projects'))
  for (const p of vm.projects.rows) {
    add({
      label: t('Project {0}: {1}', p.project, p.usage),
      description: t('{0} session(s) · hit {1}', p.sessions, p.cacheHit),
    })
  }
  group(t('Sessions'))
  for (const s of vm.sessions.rows) {
    add({
      label: t('Session {0}: {1}', s.session, s.usage),
      description: `${s.project} · ${s.duration} · ${t('{0} req', s.requests)}`,
      detail: [s.models, s.cacheState].filter(Boolean).join(' · '),
    })
  }

  group(t('Data quality'))
  for (const line of dataQualityLines(vm)) add({ label: line })

  group(t('Actions'))
  for (const a of [
    { label: t('Fetch quota now'), command: 'tokenPace.refreshQuota' },
    { label: t('Re-read token history'), command: 'tokenPace.rescan' },
    { label: t('Show log'), command: 'tokenPace.showOutput' },
    { label: t('Open settings'), command: 'tokenPace.openSettings' },
    { label: t('Export CSV…'), command: 'tokenPace.exportCsv' },
    { label: t('Export JSON…'), command: 'tokenPace.exportJson' },
    { label: t('Copy usage summary'), command: 'tokenPace.copySummary' },
  ]) add(a)

  group(t('Notes'))
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
    label: t('Record peak day: {0}', r.peakDay ? `${r.peakDay.day} — ${r.peakDay.usage}` : '–'),
    description: r.peakDay && r.peakDay.cost !== '–'
      ? `${r.peakDay.cost}${r.peakDay.costPartial ? ' ⚠' : ''}`
      : undefined,
  })
  out.push({
    label: t('Record streak: {0}', r.streak ? dayCount(r.streak.days) : '–'),
    description: r.streak ? `${r.streak.from} → ${r.streak.to}` : undefined,
  })
  // The heading is passed in whole, never assembled from "Top" plus a noun: a language that
  // inflects the noun after "Top" cannot be served by a phrase glued together here.
  const table = (label: (row: string, usage: string) => string, rows: ViewModel['records']['topModels']): void => {
    for (const e of rows) {
      out.push({
        label: label(e.label, e.usage),
        description: [t('{0} of usage', e.share), e.cost === '–' ? null : e.cost].filter(Boolean).join(' · '),
        detail: e.detail ?? undefined,
      })
    }
  }
  table((row, usage) => t('Top model {0}: {1}', row, usage), r.topModels)
  table((row, usage) => t('Top project {0}: {1}', row, usage), r.topProjects)
  table((row, usage) => t('Top session {0}: {1}', row, usage), r.topSessions)
  if (!r.attributionOn) {
    out.push({ label: t('Top projects and sessions need tokenPace.attribution'), command: 'tokenPace.openSettings' })
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
  const tools = vm.tools
  const out: PickItem[] = []
  for (const r of tools.rows) {
    out.push({
      label: t('Tool {0}: {1}', r.name, r.callsText),
      description: t('{0} of calls · {1}', r.share, r.models),
      detail: r.sources || undefined,
    })
  }
  if (tools.hidden > 0) {
    out.push({
      label: t('{0} more tool row(s)', tools.hidden),
      description: t('raise tokenPace.dashboard.topN to see them'),
      command: 'tokenPace.openSettings',
    })
  }
  for (const n of tools.notes) out.push({ label: n })
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
      b.partial ? `⚠ ${t('lower bound')}` : null,
      b.over ? t('over budget') : null,
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
  // Asked of the retrospective itself, not of the sentence it produced: `text` is translated,
  // and a search for the English words would keep every row in every other language.
  const known = vm.retro.some((r) => r.retro.enough)
  return known ? vm.retro : []
}

// ---------------------------------------------------------------------------
// Markdown
// ---------------------------------------------------------------------------

function dataQualityLines(vm: ViewModel): string[] {
  const d = vm.dataQuality
  const out: string[] = [
    t('Roots: {0} · {1} file(s)', d.roots.length > 0 ? d.roots.join(', ') : t('none'), d.files),
    t('Coverage: {0} → {1} · {2} hour / {3} day / {4} month buckets · snapshot {5} KB',
      d.oldestDay ?? '–', d.newestDay ?? '–', d.buckets.hour, d.buckets.day, d.buckets.month,
      Math.round(d.snapshotBytes / 1024)),
    t('Lower bound share: {0}', d.lowerBoundShare)
    + (d.unpricedModels.length > 0 ? ` · ${t('unpriced: {0}', d.unpricedModels.join(', '))}` : '')
    + (d.familyPriced.length > 0 ? ` · ${t('family-priced: {0}', d.familyPriced.join(', '))}` : ''),
    t('Retention: {0} d hourly · {1} d daily · {2} d quota history',
      d.retention.hourDays, d.retention.days, d.retention.historyDays),
    t('Quota history: {0} samples · {1} KB · oldest {2}',
      d.history.samples, Math.round(d.history.bytes / 1024), d.history.oldest ?? '–'),
    t('Consent: {0} · {1} · attribution {2} · v{3}', d.consent, d.leader, d.attribution, d.version),
  ]
  for (const q of d.quota) {
    const cands = q.candidates.length > 0
      ? q.candidates.map((c) => `${c.id} ${c.ok ? `${c.ageSec === null ? t('ok') : t('{0} min', Math.round(c.ageSec / 60))}` : (c.problem ?? t('unavailable'))}`).join(' · ')
      : t('no source answered')
    out.push(t('Quota sources {0}: {1}', q.source, cands))
    if (q.drift.length > 0) out.push(t('Unrendered fields {0}: {1}', q.source, q.drift.join(', ')))
  }
  for (const c of d.calibration) out.push(t('Calibration {0} {1}: {2}', c.source, c.windowId, c.text))
  if (d.bridge) out.push(t('Status line: {0}', d.bridge))
  return out
}

/** The read-only `tokenpace:/usage.md` document — the same figures as tables. */
export function markdownDocument(vm: ViewModel): string {
  const L: string[] = []
  L.push(`# ${t('Token Pace — usage')}`)
  L.push('')
  L.push(`*${vm.range.label} · ${vm.range.from} → ${vm.range.to} · ${t('generated {0}', vm.generatedAt)}*`)
  if (vm.preview) L.push('', `> **${t('Preview data — not a reading.')}**`)
  L.push('')

  if (vm.firstRun) {
    L.push(`## ${t('First run')}`, '', vm.firstRun.text, '')
  }

  L.push(`## ${t('Quota')}`, '')
  if (vm.quotas.length === 0) L.push(`_${t('No quota reading.')}_`, '')
  for (const q of vm.quotas) {
    const meta = [
      q.planText,
      q.origin ? t('via {0}', q.origin) : null,
      q.ageText ? t('updated {0}', q.ageText) : null,
      q.stale ? `⚠ ${t('stale')}` : null,
    ].filter(Boolean).join(' · ')
    L.push(`### ${q.title}${meta ? ` — ${meta}` : ''}`)
    L.push('')
    if (q.problem) {
      L.push(`> ⚠ ${q.problem}${q.problemAction ? ` — ${q.problemAction.label}` : ''}`)
      L.push('')
    }
    if (q.windows.length > 0) {
      L.push(t('| Window | Used | Elapsed | Pace | Resets | Forecast |'))
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
      // Why each bar has its colour, one line per window in the table's order: the dashboard
      // shows this on hover, and a document read without one needs it in the text.
      for (const w of q.windows) {
        const lines = explainLines(w)
        if (lines.length === 0) continue
        L.push(`- **${cell(w.label)}** — ${cell(w.explain.title)}: ${lines.map(cell).join(' ')}`)
      }
      if (q.windows.some((w) => explainLines(w).length > 0)) L.push('')
    }
    // The bridge's prompt-cache line, under the windows it was read beside — the same words
    // as the card, qualified once as the session's rather than the account's.
    if (q.promptCache) L.push(`${cell(q.promptCache.text)} — ${q.promptCache.note}`, '')
    if (q.extra) {
      L.push(t('Extra usage: {0} ({1})', cell(q.extra.text),
        q.extra.billed ? t('billed') : q.extra.enabled ? t('enabled') : t('off')), '')
    }
    if (q.localBlock) L.push(q.localBlock.text, '')
    const f = q.freshness
    L.push(t('Freshness — last check {0} · last data {1} · last local event {2} · next refresh {3} · snapshot {4}',
      cell(f.lastCheck), cell(f.lastData), cell(f.lastEvent), cell(f.nextRefresh), cell(f.snapshotAge)))
    // The one reader of `usagePageUrl` since the card stopped printing it — the same URL the
    // tooltip links from the provider name, null when `tokenPace.usagePageLinks` is off.
    if (q.usagePageUrl) L.push(t('Official page: {0}', q.usagePageUrl))
    L.push('')
  }

  if (vm.digest.length > 0) {
    L.push(`## ${t('Summary')}`, '')
    for (const s of vm.digest) L.push(`- ${s}`)
    L.push('')
  }

  if (vm.context) {
    L.push(`## ${t('Context window')}`, '')
    L.push(`${vm.context.text} — ${vm.context.note}`
      + (vm.context.ageText ? ` · ${t('updated {0}', vm.context.ageText)}` : '')
      + (vm.context.fresh ? '' : ` · ⚠ ${t('stale')}`))
    L.push('')
  }

  L.push(`## ${t('Key figures')}`, '')
  L.push(t('| Figure | Value | Change | Basis |'))
  L.push('|---|---|---|---|')
  for (const k of vm.kpis) {
    L.push(`| ${cell(k.label)} | ${cell(k.value)} | ${k.delta ? cell([k.delta.glyph, k.delta.text].filter(Boolean).join(' ')) : '–'} | `
      + `${cell([k.note, k.provenance].filter(Boolean).join(' · '))} |`)
  }
  L.push('')

  // The dashboard shows this on hover; a document that is read without one needs it in the
  // text, or the table is seven numbers whose denominators the reader has to guess.
  L.push(`### ${t('Key figures explained')}`, '')
  for (const k of vm.kpis) {
    L.push(`- **${cell(k.label)}** — ${cell(k.explain.what)}. ${cell(k.explain.how)}. `
      + `${cell(k.explain.period)}.`)
  }
  L.push('')

  for (const table of vm.totals) {
    L.push(`## ${t('Tokens — {0}', table.title)}`, '')
    L.push(t('| Period | Usage | Fresh input | Write 5m | Write 1h | Cache read | Output | Reasoning | Req. | Cache hit | Per req. | API cost |'))
    L.push('|---|---|---|---|---|---|---|---|---|---|---|---|')
    for (const r of table.rows) {
      L.push(`| ${cell(r.label)} | ${cell(r.usage)} | ${cell(r.freshInput)} | ${cell(r.cacheWrite5m)} | `
        + `${cell(r.cacheWrite1h)} | ${cell(r.cacheRead)} | ${cell(r.output)}${r.incomplete ? ' ⚠' : ''} | `
        + `${cell(r.reasoning)} | ${cell(r.requests)} | ${cell(r.cacheHit)} | ${cell(r.perRequest)} | `
        + `${cell(r.cost)}${r.costPartial ? ' ⚠' : ''} |`)
    }
    L.push('')
    // Once per table, never once per row: the mark is the same caveat wherever it appears.
    if (table.rows.some((r) => r.approx)) L.push(`_${approxNote()}_`, '')
  }

  if (vm.composition.length > 0) {
    L.push(`## ${t('Composition — last 30 days')}`, '')
    L.push(t('| Provider | Part | Tokens |'))
    L.push('|---|---|---|')
    for (const c of vm.composition) {
      for (const p of c.parts) L.push(`| ${cell(withSource(c.source, ''))} | ${cell(p.text)} | ${p.tokens > 0 ? p.tokens.toLocaleString('en-US') : '–'} |`)
    }
    L.push('')
  }

  L.push(`## ${t('Cache economy — last 30 days')}`, '')
  L.push(t('| Provider | Hit rate | Realised saving | Blended $/1M | Basis |'))
  L.push('|---|---|---|---|---|')
  for (const c of vm.cacheEconomy) {
    L.push(`| ${cell(withSource(c.source, ''))} | ${cell(c.hitRate)} | ${cell(c.savedUsd)}${c.partial ? ' ⚠' : ''} | `
      + `${cell(c.blendedPerM)} | ${cell(c.note)} |`)
  }
  L.push('')

  L.push(`## ${t('Calendar')}`, '')
  L.push(t('| Period | Usage | API cost | Requests | Active days | Avg per active day |'))
  L.push('|---|---|---|---|---|---|')
  for (const p of [vm.calendar.thisWeek, vm.calendar.thisMonth, vm.calendar.lastMonth, vm.calendar.year]) {
    L.push(`| ${cell(p.label)} | ${cell(p.usage)} | ${cell(p.cost)} | ${cell(p.requests)} | `
      + `${p.activeDays} | ${cell(p.avgPerDay)} |`)
  }
  if (vm.calendar.thisMonth.projection) {
    L.push('')
    // The basis is typed nullable; interpolated the way the line always did it, so a payload
    // without one renders exactly as before rather than losing the column.
    L.push(t('Month projection: {0} — {1}',
      vm.calendar.thisMonth.projection, `${vm.calendar.thisMonth.projectionBasis}`))
  }
  for (const p of vm.planFactor) {
    L.push('', t('Plan comparison ({0}): {1}', withSource(p.source, ''), p.text)
      + (p.partial ? ` ⚠ ${t('lower bound')}` : ''))
  }
  L.push('')

  if (vm.models.rows.length > 0) {
    L.push(`## ${t('Models')}`, '')
    // The columns of the totals table above, in its order and with its words, so the two can
    // be read against each other. No Price column: the rates are a provenance, not a figure,
    // and they are named in the footnotes and in the QuickPick line for the same row.
    L.push(t('| Model | Provider | Usage | Fresh input | Write 5m | Write 1h | Cache read | Output | Reasoning | Req. | Cache hit | Per req. | API cost | Share | Cost share |'))
    L.push('|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|')
    for (const m of vm.models.rows) {
      L.push(`| ${cell(m.model)}${m.isSub ? ` ${t('(sub)')}` : ''}${m.tier === 'standard' ? '' : ` [${m.tier}]`} | `
        + `${cell(withSource(m.source, ''))} | ${cell(m.usageText)} | ${cell(m.freshInput)} | `
        + `${cell(m.cacheWrite5m)} | ${cell(m.cacheWrite1h)} | ${cell(m.cacheRead)} | ${cell(m.output)} | `
        + `${cell(m.reasoning)} | ${cell(m.requests)} | ${cell(m.cacheHit)} | ${cell(m.perRequest)} | `
        + `${cell(m.costText)}${m.priced === 'family' ? ' ⚠' : ''} | ${cell(m.share)} | `
        + `${cell(m.costShare)} |`)
    }
    if (vm.models.hidden > 0) {
      L.push('')
      L.push(`_${t('{0} more — set `tokenPace.dashboard.modelRows`.', vm.models.hidden)}_`)
    }
    L.push('')
  }

  if (vm.retro.length > 0) {
    L.push(`## ${t('Reset history')}`, '')
    for (const r of vm.retro) L.push(`- **${withSource(r.source, r.label)}**: ${r.text}`)
    L.push('')
  }

  L.push(`## ${t('Activity')}`, '')
  L.push(t('Streak {0} day(s) · longest {1} · active {2} · peak {3}',
    vm.heatmap.streak, vm.heatmap.longestStreak, vm.heatmap.activeDays,
    vm.heatmap.peakDay ? `${vm.heatmap.peakDay.day} (${vm.heatmap.peakDay.text})` : '–')
    + (vm.heatmap.variability
      ? ` · ${t('CV {0} · {1} spiky day(s)', vm.heatmap.variability.cv, vm.heatmap.variability.spikyDays)}`
      : ''))
  L.push('')
  const peak = vm.hours.peakHour
  // The same sentence the dashboard prints under the weekday grid: this document has no grid
  // to draw, but the hours it does print stand on exactly those days.
  L.push(t('Hours ({0}, {1} day(s)): peak {2} · {3}',
    vm.hours.zone, vm.hours.days,
    peak === null ? '–' : `${String(peak).padStart(2, '0')}:00`, vm.hours.basis.text)
    + (vm.hours.note ? ` · ${vm.hours.note}` : ''))
  L.push('')
  L.push(t('| Hour | Usage |'))
  L.push('|---|---|')
  for (const h of vm.hours.profile) {
    L.push(`| ${String(h.hour).padStart(2, '0')}:00 | ${cell(h.text)} |`)
  }
  L.push('')

  L.push(`## ${t('Records')}`, '')
  const rec = vm.records
  L.push(t('Peak day: {0}', rec.peakDay ? `${rec.peakDay.day} — ${rec.peakDay.usage}` : '–')
    + (rec.peakDay && rec.peakDay.cost !== '–'
      ? ` · ${rec.peakDay.cost}${rec.peakDay.costPartial ? ' ⚠' : ''}` : ''))
  L.push('')
  L.push(t('Longest streak: {0}',
    rec.streak ? `${dayCount(rec.streak.days)} · ${rec.streak.from} → ${rec.streak.to}` : '–'))
  L.push('')
  // One key per header row: "Top model" and "Top project" are not the same word with a noun
  // swapped in every language, and a row assembled from parts could not be reordered.
  for (const [header, rows] of [
    [t('| Top model | Detail | Usage | Share | API cost |'), rec.topModels],
    [t('| Top project | Detail | Usage | Share | API cost |'), rec.topProjects],
    [t('| Top session | Detail | Usage | Share | API cost |'), rec.topSessions],
  ] as const) {
    if (rows.length === 0) continue
    L.push(header)
    L.push('|---|---|---|---|---|')
    for (const e of rows) {
      L.push(`| ${cell(e.label)} | ${cell(e.detail)} | ${cell(e.usage)} | ${cell(e.share)} | ${cell(e.cost)} |`)
    }
    L.push('')
  }
  if (!rec.attributionOn) L.push(`_${t('Top projects and sessions need `tokenPace.attribution`.')}_`, '')
  for (const n of [rec.note, rec.sessionNote]) if (n) L.push(`_${n}_`, '')

  L.push(`## ${t('Tools')}`, '')
  const tools = vm.tools
  if (tools.rows.length > 0) {
    L.push(t('| Tool | Provider | Calls | Share | Models |'))
    L.push('|---|---|---|---|---|')
    for (const r of tools.rows) {
      L.push(`| ${cell(r.name)} | ${cell(r.sources)} | ${cell(r.callsText)} | ${cell(r.share)} | `
        + `${cell(r.models)} |`)
    }
    L.push('')
    L.push(t('{0} call(s) · {1} distinct tool(s)', tools.totalText, tools.distinct)
      + (tools.hidden > 0 ? ` · ${t('{0} more not listed', tools.hidden)}` : ''))
    L.push('')
  }
  for (const n of tools.notes) L.push(`_${n}_`, '')

  if (vm.budgets.length > 0) {
    L.push(`## ${t('Budgets')}`, '')
    L.push(t('| Budget | Period | Used | Limit | Share | Projected |'))
    L.push('|---|---|---|---|---|---|')
    for (const b of vm.budgets) {
      L.push(`| ${cell(b.label)}${b.partial ? ' ⚠' : ''} | ${b.from} → ${b.last} | `
        + `${cell(b.usedText)} | ${cell(b.limitText)} | ${cell(b.shareText)}${b.over ? ' ⚠' : ''} | `
        + `${cell(b.projectedText ? t('{0} by {1}', b.projectedText, b.last) : null)} |`)
    }
    L.push('')
    // A row of dashes is a configured budget nothing is counting, not an idle period, so the
    // switch that is in the way is named under the table rather than left to be guessed.
    const unmeasured = vm.budgets.filter((b) => b.unmeasurable !== null)
    if (unmeasured.length > 0) {
      L.push(`_${unmeasured.map((b) => `${b.label} — ${b.unmeasurable}`).join('; ')}._`, '')
    }
    // The one sentence that keeps a budget from being read as a plan limit.
    L.push(`_${t('A budget is your own number; `usd` is the hypothetical API equivalent, not a bill.')}_`, '')
  }

  if (vm.projects.enabled && vm.projects.rows.length > 0) {
    L.push(`## ${t('Projects')}`, '')
    L.push(t('| Project | Usage | Requests | Cache hit | Share | Sessions |'))
    L.push('|---|---|---|---|---|---|')
    for (const p of vm.projects.rows) {
      L.push(`| ${cell(p.project)} | ${cell(p.usage)} | ${cell(p.requests)} | ${cell(p.cacheHit)} | `
        + `${cell(p.share)} | ${p.sessions} |`)
    }
    L.push('')
  }
  if (vm.sessions.enabled && vm.sessions.rows.length > 0) {
    L.push(`## ${t('Sessions')}`, '')
    L.push(t('| Session | Project | Started | Duration | Usage | Req. | Models | Cache |'))
    L.push('|---|---|---|---|---|---|---|---|')
    for (const s of vm.sessions.rows) {
      L.push(`| ${cell(s.session)}${s.isSub ? ` ${t('(sub)')}` : ''} | ${cell(s.project)} | ${cell(s.started)} | `
        + `${cell(s.duration)} | ${cell(s.usage)} | ${cell(s.requests)} | ${cell(s.models)} | `
        + `${cell(s.cacheState)} |`)
    }
    L.push('')
  }

  if (vm.drill) {
    L.push(`## ${t('Drill-down {0}', vm.drill.day)}`, '')
    L.push(t('| Model | Usage | API cost | Req. |'))
    L.push('|---|---|---|---|')
    for (const m of vm.drill.models) {
      L.push(`| ${cell(m.model)} | ${cell(m.usageText)} | ${cell(m.costText)} | ${cell(m.requests)} |`)
    }
    L.push('')
  }

  L.push(`## ${t('Data quality')}`, '')
  for (const line of dataQualityLines(vm)) L.push(`- ${line}`)
  L.push('')

  L.push('---', '')
  for (const f of vm.footnotes) L.push(`- ${f}`)
  L.push('')
  return L.join('\n')
}
