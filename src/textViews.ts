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

/** True when the text is one of the segments already printed, compared whole and case-blind. */
function repeats(text: string, said: (string | null | undefined)[]): boolean {
  const t = text.trim().toLowerCase()
  return said.some((s) => typeof s === 'string' && s.trim().toLowerCase() === t)
}

function windowLine(w: WindowVmOf): string {
  const parts = [w.verdict.text]
  // `stateText` and `resetLine` arrive already de-duplicated against each other and against
  // the verdict, so appending them cannot repeat a word the line already carries.
  if (w.stateText) parts.push(w.stateText)
  if (w.resetLine) parts.push(w.resetLine)
  const f = trustedForecast(w)
  // A forecast that only repeats a segment already on the line ("reset due" beside "reset
  // due") is not a second fact — compared segment for segment, never as a substring, so a
  // real sentence that merely contains one of the words is kept.
  if (f && f.text && !repeats(f.text, parts)) parts.push(f.text)
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

  items.push({
    label: 'Open dashboard',
    description: `${vm.range.label} · ${vm.range.from} → ${vm.range.to}`,
    detail: `generated ${vm.generatedAt}`,
    command: 'tokenPace.showDashboard',
  })

  for (const s of vm.digest) items.push({ label: s })

  for (const q of vm.quotas) {
    const meta = [
      q.planType ? `plan ${q.planType}` : null,
      q.origin ? `via ${q.origin}` : null,
      q.ageText ? `updated ${q.ageText}` : null,
      q.stale ? 'stale' : null,
    ].filter(Boolean).join(' · ')
    items.push({
      label: q.title,
      description: meta,
      detail: q.problem ? `⚠ ${q.problem}` : undefined,
      command: q.problemAction?.command,
    })
    for (const w of q.windows) {
      items.push({
        label: `${w.label} ${bar(w.percent, w.elapsed)} ${w.percentText}`,
        description: windowLine(w),
        // The sustainable sentence ends in "…keeps it to the reset", so after it the time alone
        // is the whole statement; a window whose reset has passed says "reset due" in the
        // description already and gets no time here.
        detail: [
          w.sustainable,
          w.resetAbsolute && w.display !== 'resetDue'
            ? (w.sustainable ? `at ${w.resetAbsolute}` : `reset at ${w.resetAbsolute}`)
            : null,
        ].filter(Boolean).join(' · ') || undefined,
      })
    }
    if (q.extra) {
      items.push({
        label: `Extra usage: ${q.extra.text}`,
        description: q.extra.billed ? 'billed' : q.extra.enabled ? 'enabled' : 'off',
      })
    }
  }

  for (const k of vm.kpis) {
    items.push({
      label: `${k.label}: ${k.value}`,
      description: k.delta ? [k.delta.glyph, k.delta.text].filter(Boolean).join(' ') : undefined,
      detail: [k.note, k.provenance].filter(Boolean).join(' · '),
    })
  }

  for (const t of vm.totals) {
    for (const r of t.rows) {
      items.push({
        label: `${t.title} · ${r.label}: ${r.usage}`,
        description: `${r.requests} req · ${r.cost}${r.costPartial ? ' ⚠' : ''}`,
        detail: `fresh ${r.freshInput} · write5m ${r.cacheWrite5m} · write1h ${r.cacheWrite1h} · `
          + `read ${r.cacheRead} · output ${r.output} · reasoning ${r.reasoning} · `
          + `hit ${r.cacheHit} · ${r.perRequest}/req${r.incomplete ? ' · output is a lower bound' : ''}`,
      })
    }
  }

  for (const c of vm.cacheEconomy) {
    items.push({
      label: `Cache economy ${withSource(c.source, '')}: ${c.hitRate}`,
      description: `saved ${c.savedUsd} · blended ${c.blendedPerM}`,
      detail: c.note + (c.partial ? ' · some models unpriced' : ''),
    })
  }

  for (const f of vm.forecasts) {
    items.push({
      label: `Forecast ${withSource(f.source, f.label)}: ${forecastText(f.forecast) || '–'}`,
      description: [f.sustainable, f.lockout, f.resetForecast].filter(Boolean).join(' · '),
      detail: f.forecast.basis
        ? `${f.forecast.basis.samples} readings · ${f.gaps} gap(s) in the last 24 h`
        : undefined,
    })
  }

  for (const r of vm.retro) {
    items.push({ label: `Reset history ${withSource(r.source, r.label)}`, description: r.text })
  }

  for (const u of vm.windowUsage) {
    items.push({
      label: `Local usage in ${withSource(u.source, u.label)}: ${u.usage}`,
      description: `${u.requests} req · ${u.cost}`,
      detail: u.complete ? undefined : 'hour buckets are incomplete for this window',
    })
  }

  for (const a of vm.attributionInWindow) {
    // Named like the markdown heading, so the block cannot be mistaken for a totals row of
    // the provider it starts with.
    const head = `Attribution ${withSource(a.source, a.label)}`
    for (const row of a.rows) {
      items.push({ label: `${head} · ${row.label}: ${row.share}`, description: row.usage })
    }
    items.push({ label: `${head} · unexplained`, description: a.unexplained })
  }

  for (const m of vm.models.rows) {
    items.push({
      label: `${m.model}${m.isSub ? ' (sub)' : ''}: ${m.usageText}`,
      description: `${m.costText} · ${m.share} of usage · hit ${m.cacheHit}`,
      detail: `${m.price}${m.turnAvg ? ` · Ø turn ${m.turnAvg}` : ''}${m.turnP90 ? ` · P90 ${m.turnP90}` : ''}`,
    })
  }
  if (vm.models.hidden > 0) {
    items.push({
      label: `${vm.models.hidden} more model rows`,
      description: 'raise tokenPace.dashboard.modelRows to see them',
      command: 'tokenPace.openSettings',
    })
  }

  for (const p of vm.projects.rows) {
    items.push({
      label: `Project ${p.project}: ${p.usage}`,
      description: `${p.sessions} session(s) · hit ${p.cacheHit}`,
    })
  }
  for (const s of vm.sessions.rows) {
    items.push({
      label: `Session ${s.session}: ${s.usage}`,
      description: `${s.project} · ${s.duration} · ${s.requests} req`,
      detail: [s.models, s.cacheState].filter(Boolean).join(' · '),
    })
  }

  for (const line of dataQualityLines(vm)) items.push({ label: line })

  items.push(
    { label: 'Fetch quota now', command: 'tokenPace.refreshQuota' },
    { label: 'Re-read token history', command: 'tokenPace.rescan' },
    { label: 'Show log', command: 'tokenPace.showOutput' },
    { label: 'Open settings', command: 'tokenPace.openSettings' },
    { label: 'Export CSV…', command: 'tokenPace.exportCsv' },
    { label: 'Export JSON…', command: 'tokenPace.exportJson' },
    { label: 'Copy usage summary', command: 'tokenPace.copySummary' },
  )
  for (const f of vm.footnotes) items.push({ label: f })
  return items
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

  if (vm.digest.length > 0) {
    L.push('## Summary', '')
    for (const s of vm.digest) L.push(`- ${s}`)
    L.push('')
  }

  L.push('## Quota', '')
  if (vm.quotas.length === 0) L.push('_No quota reading._', '')
  for (const q of vm.quotas) {
    const meta = [
      q.planType ? `plan ${q.planType}` : null,
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
        // repeat the Resets or Pace column of the same row.
        const ft = f ? forecastText(f) : ''
        const forecastCell = repeats(ft, [w.reset, w.stateText, w.verdict.text]) ? '' : ft
        L.push(`| ${cell(w.label)} | \`${bar(w.percent, w.elapsed)}\` ${cell(w.percentText)} | `
          + `${w.elapsed === null ? '–' : `${Math.round(w.elapsed)} %`} | `
          + `${cell(w.verdict.text + (w.stateText ? ` · ${w.stateText}` : ''))} | `
          + `${cell(w.reset)} | ${cell(forecastCell)} |`)
      }
      L.push('')
    }
    if (q.extra) {
      L.push(`Extra usage: ${cell(q.extra.text)} (${q.extra.billed ? 'billed' : q.extra.enabled ? 'enabled' : 'off'})`, '')
    }
    const f = q.freshness
    L.push(`Freshness — last check ${cell(f.lastCheck)} · last data ${cell(f.lastData)} · `
      + `last local event ${cell(f.lastEvent)} · next refresh ${cell(f.nextRefresh)} · `
      + `snapshot ${cell(f.snapshotAge)}`)
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
  L.push('| Period | Usage | API cost | Requests | Active days | Ø per active day |')
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
    L.push('| Model | Provider | Usage | Share | Output | Req. | Cache hit | API cost | Cost share | Price |')
    L.push('|---|---|---|---|---|---|---|---|---|---|')
    for (const m of vm.models.rows) {
      L.push(`| ${cell(m.model)}${m.isSub ? ' (sub)' : ''}${m.tier === 'standard' ? '' : ` [${m.tier}]`} | `
        + `${cell(withSource(m.source, ''))} | ${cell(m.usageText)} | ${cell(m.share)} | ${cell(m.output)} | `
        + `${cell(m.requests)} | ${cell(m.cacheHit)} | ${cell(m.costText)} | ${cell(m.costShare)} | `
        + `${cell(m.price)} |`)
    }
    if (vm.models.hidden > 0) {
      L.push('')
      L.push(`_${vm.models.hidden} more — set \`tokenPace.dashboard.modelRows\`._`)
    }
    L.push('')
  }

  L.push('## Forecast', '')
  if (vm.forecasts.length === 0) L.push('_No quota window to project._', '')
  else {
    L.push('| Window | State | Rate | Sustainable | Lockout | At reset | Basis |')
    L.push('|---|---|---|---|---|---|---|')
    for (const f of vm.forecasts) {
      L.push(`| ${cell(withSource(f.source, f.label))} | ${cell(forecastText(f.forecast))} | `
        + `${f.forecast.ratePerHour === null ? '–' : `${f.forecast.ratePerHour.toFixed(1)} pp/h`} | `
        + `${cell(f.sustainable)} | ${cell(f.lockout)} | ${cell(f.resetForecast)} | `
        + `${f.forecast.basis ? `${f.forecast.basis.samples} readings, ${f.gaps} gap(s)` : '–'} |`)
    }
    L.push('')
  }

  if (vm.retro.length > 0) {
    L.push('## Reset history', '')
    for (const r of vm.retro) L.push(`- **${withSource(r.source, r.label)}**: ${r.text}`)
    L.push('')
  }

  if (vm.windowUsage.length > 0) {
    L.push('## Local usage inside the current windows', '')
    L.push('| Window | Usage | Requests | API cost | Complete |')
    L.push('|---|---|---|---|---|')
    for (const u of vm.windowUsage) {
      L.push(`| ${cell(withSource(u.source, u.label))} | ${cell(u.usage)} | ${cell(u.requests)} | ${cell(u.cost)} | `
        + `${u.complete ? 'yes' : 'no — hour buckets rolled up'} |`)
    }
    L.push('')
  }

  for (const a of vm.attributionInWindow) {
    L.push(`### Attribution — ${withSource(a.source, a.label)}`, '')
    L.push('| Project | Share of local tokens | Usage |')
    L.push('|---|---|---|')
    for (const row of a.rows) L.push(`| ${cell(row.label)} | ${cell(row.share)} | ${cell(row.usage)} |`)
    L.push('')
    L.push(`_${a.unexplained}_`, '')
  }

  L.push('## Activity', '')
  L.push(`Streak ${vm.heatmap.streak} day(s) · longest ${vm.heatmap.longestStreak} · `
    + `active ${vm.heatmap.activeDays} · peak ${vm.heatmap.peakDay ? `${vm.heatmap.peakDay.day} (${vm.heatmap.peakDay.text})` : '–'}`
    + (vm.heatmap.variability ? ` · CV ${vm.heatmap.variability.cv} · ${vm.heatmap.variability.spikyDays} spiky day(s)` : ''))
  L.push('')
  const peak = vm.hours.peakHour
  L.push(`Hours (${vm.hours.zone}, ${vm.hours.days} day(s)): peak `
    + `${peak === null ? '–' : `${String(peak).padStart(2, '0')}:00`}`
    + (vm.hours.note ? ` · ${vm.hours.note}` : ''))
  L.push('')
  L.push('| Hour | Usage |')
  L.push('|---|---|')
  for (const h of vm.hours.profile) {
    L.push(`| ${String(h.hour).padStart(2, '0')}:00 | ${cell(h.text)} |`)
  }
  L.push('')

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
