// SPDX-FileCopyrightText: 2026 Frederik Marx
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * CSV, JSON and markdown serialisation of a period.
 *
 * Pure — the save dialogs live in `nativeViews.ts`, so the serialisers can be tested without
 * an extension host. Two rules the export inherits from the display layer: a day without
 * data produces no row at all (a zero row would claim a measurement), and a bucket whose
 * model has no price leaves the cost cell empty instead of writing 0.00. The honesty
 * markers have to survive leaving the extension, because the file is what people paste into
 * a spreadsheet and then argue with.
 */

import { Aggregator, billable } from './agg'
import { Config } from './config'
import { PRICES_AS_OF, PricingOptions, costOfBucket, isCustomPricing } from './prices'
import { TimeConfig, dayOfHour } from './time'
import { Bucket, TOOL_NAME_CAP } from './types'
import type { ViewModel } from './viewModel'

/**
 * 2 added `tools[]` and `toolsTruncated`; everything version 1 carried is still there and
 * still means the same thing, so a reader written for 1 keeps working.
 */
export const EXPORT_SCHEMA_VERSION = 2

/**
 * The tool side table's own columns. A separate file, never a column on a bucket row: the
 * side table is keyed by day and model, a bucket row by day, hour, model, tier and isSub, so
 * any per-row tool number would be an invented split of a figure nobody measured that way.
 */
export const TOOLS_CSV_COLUMNS = ['day', 'source', 'model', 'tool', 'calls'] as const

export const CSV_COLUMNS = [
  'day', 'hour', 'source', 'model', 'isSub', 'tier', 'res',
  'input', 'cacheWrite5m', 'cacheWrite1h', 'cacheRead', 'output', 'reasoning',
  'requests', 'outputFinal', 'webSearch', 'costUsd', 'priced',
] as const

function pricingOf(cfg: Config): PricingOptions {
  return {
    overrides: cfg.customPrices,
    multiplier: cfg.pricing.multiplier,
    unknownModel: cfg.unknownModelPricing,
  }
}

/** The day a bucket is exported under — hour buckets follow the configured zone. */
function dayOf(b: Bucket, tcfg: TimeConfig): string {
  if (b.res === 'h') return dayOfHour(b.hour ?? 0, tcfg)
  if (b.res === 'd') return b.day
  return `${b.day}-01`
}

function monthLast(month: string): string {
  const y = Number(month.slice(0, 4))
  const m = Number(month.slice(5, 7))
  const days = Number.isFinite(y) && Number.isFinite(m) ? new Date(Date.UTC(y, m, 0)).getUTCDate() : 31
  return `${month}-${String(days).padStart(2, '0')}`
}

/** Same placement rules as the aggregator: a month bucket counts only when it fits whole. */
function inRange(b: Bucket, from: string, to: string, tcfg: TimeConfig): boolean {
  if (b.res === 'm') return `${b.day}-01` >= from && monthLast(b.day) <= to
  const day = dayOf(b, tcfg)
  return day >= from && day <= to
}

function rowsOf(agg: Aggregator, from: string, to: string, tcfg: TimeConfig): Bucket[] {
  return agg.all()
    .filter((b) => inRange(b, from, to, tcfg))
    .sort((a, b) => {
      const d = dayOf(a, tcfg).localeCompare(dayOf(b, tcfg))
      if (d !== 0) return d
      const h = (a.hour ?? -1) - (b.hour ?? -1)
      if (h !== 0) return h
      const s = a.source.localeCompare(b.source)
      if (s !== 0) return s
      const m = a.model.localeCompare(b.model)
      if (m !== 0) return m
      return a.tier.localeCompare(b.tier)
    })
}

function csvCell(v: string | number | boolean): string {
  const s = typeof v === 'string' ? v : String(v)
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

/** Dot decimal, six places, no thousands separator — this is a data file, not a display. */
function amount(n: number): string {
  return n.toFixed(6)
}

export interface ExportRange {
  from: string
  to: string
  label?: string
  preset?: string
}

/**
 * Bucket rows of the range, one line per stored bucket.
 *
 * Days without data are simply absent: a spreadsheet that fills gaps with zeros turns "we
 * were not running" into "nothing was used", and those are different statements.
 */
export function toCsv(agg: Aggregator, range: ExportRange, cfg: Config, tcfg: TimeConfig): string {
  const pricing = pricingOf(cfg)
  const lines: string[] = [CSV_COLUMNS.join(',')]
  const total = {
    input: 0, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0, output: 0, reasoning: 0,
    requests: 0, outputFinal: 0, webSearch: 0, cost: 0, unpriced: false,
  }
  for (const b of rowsOf(agg, range.from, range.to, tcfg)) {
    const day = dayOf(b, tcfg)
    const c = costOfBucket(day === b.day ? b : { ...b, day }, pricing)
    const priced = !c ? 'none' : c.unpriced ? 'none' : c.confidence
    const write5m = Math.max(0, b.cacheWrite - b.cacheWrite1h)
    lines.push([
      day,
      b.res === 'h' && b.hour !== null ? String(b.hour) : '',
      b.source, b.model, b.isSub, b.tier, b.res,
      b.input, write5m, b.cacheWrite1h, b.cacheRead, b.output, b.reasoning,
      b.requests, b.outputFinal, b.webSearch,
      c && !c.unpriced ? amount(c.usd) : '',
      priced,
    ].map(csvCell).join(','))
    total.input += b.input
    total.cacheWrite5m += write5m
    total.cacheWrite1h += b.cacheWrite1h
    total.cacheRead += b.cacheRead
    total.output += b.output
    total.reasoning += b.reasoning
    total.requests += b.requests
    total.outputFinal += b.outputFinal
    total.webSearch += b.webSearch
    if (c && !c.unpriced) total.cost += c.usd
    else total.unpriced = true
  }
  lines.push([
    'TOTAL', '', '', '', '', '', '',
    total.input, total.cacheWrite5m, total.cacheWrite1h, total.cacheRead, total.output,
    total.reasoning, total.requests, total.outputFinal, total.webSearch,
    amount(total.cost),
    // A total over partly unpriced buckets is a lower bound, and says so in its own column.
    total.unpriced ? 'lowerBound' : '',
  ].map(csvCell).join(','))
  return lines.join('\n') + '\n'
}

/**
 * The tool calls of the range, one line per day, provider, model and tool name.
 *
 * Names only — never a tool's input, never its result. An empty table still gets its header
 * row: a file with a header and no data says "nothing was counted", a zero-byte file says
 * "something went wrong".
 */
export function toolsCsv(agg: Aggregator, range: ExportRange): string {
  const lines: string[] = [TOOLS_CSV_COLUMNS.join(',')]
  const q = agg.tools(range.from, range.to)
  let total = 0
  for (const t of q.rows) {
    lines.push([t.day, t.source, t.model, t.name, t.calls].map(csvCell).join(','))
    total += t.calls
  }
  lines.push(['TOTAL', '', '', '', total].map(csvCell).join(','))
  // The cap is a fact about the data, not about the export, so it travels with it.
  if (q.truncated) {
    lines.push(['TRUNCATED', '', '', `more than ${TOOL_NAME_CAP} distinct tools on at least one day`, ''].map(csvCell).join(','))
  }
  return lines.join('\n') + '\n'
}

export interface JsonExport {
  schema_version: number
  generated_at: string
  writer: string
  range: { from: string; to: string; label: string | null; preset: string | null }
  timezone: { zone: string; day_boundary_hour: number; start_of_week: string }
  pricing: { as_of: string; custom: boolean; multiplier: number; unknown_model: string }
  totals: Record<string, number | boolean>
  buckets: Array<Record<string, string | number | boolean | null>>
  tools: Array<Record<string, string | number>>
  toolsTruncated: boolean
  sessions?: Array<Record<string, string | number | boolean | string[] | null>>
  notes: string[]
}

export function toJson(agg: Aggregator, range: ExportRange, cfg: Config, tcfg: TimeConfig): string {
  const pricing = pricingOf(cfg)
  // The tool table is addressed by the day the ingest stored, so it takes the range bounds
  // as they are — there is no hour left in a tool row to re-address in another zone.
  const toolQuery = agg.tools(range.from, range.to)
  const buckets: JsonExport['buckets'] = []
  const totals = {
    usage: 0, input: 0, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0, output: 0,
    reasoning: 0, requests: 0, outputFinal: 0, webSearch: 0, webFetch: 0, costUsd: 0,
    unpricedTokens: 0,
  }
  for (const b of rowsOf(agg, range.from, range.to, tcfg)) {
    const day = dayOf(b, tcfg)
    const c = costOfBucket(day === b.day ? b : { ...b, day }, pricing)
    const write5m = Math.max(0, b.cacheWrite - b.cacheWrite1h)
    buckets.push({
      day,
      hour: b.res === 'h' ? b.hour : null,
      source: b.source,
      model: b.model,
      isSub: b.isSub,
      tier: b.tier,
      res: b.res,
      input: b.input,
      cacheWrite5m: write5m,
      cacheWrite1h: b.cacheWrite1h,
      cacheRead: b.cacheRead,
      output: b.output,
      reasoning: b.reasoning,
      requests: b.requests,
      outputFinal: b.outputFinal,
      webSearch: b.webSearch,
      webFetch: b.webFetch,
      // null, not 0: an unpriced bucket has no cost, it does not have a cost of nothing.
      costUsd: c && !c.unpriced ? Number(amount(c.usd)) : null,
      priced: !c ? 'none' : c.unpriced ? 'none' : c.confidence,
    })
    totals.usage += billable(b)
    totals.input += b.input
    totals.cacheWrite5m += write5m
    totals.cacheWrite1h += b.cacheWrite1h
    totals.cacheRead += b.cacheRead
    totals.output += b.output
    totals.reasoning += b.reasoning
    totals.requests += b.requests
    totals.outputFinal += b.outputFinal
    totals.webSearch += b.webSearch
    totals.webFetch += b.webFetch
    if (c && !c.unpriced) totals.costUsd += c.usd
    else totals.unpricedTokens += billable(b)
  }
  totals.costUsd = Number(amount(totals.costUsd))

  const out: JsonExport = {
    schema_version: EXPORT_SCHEMA_VERSION,
    generated_at: new Date().toISOString(),
    writer: `token-pace/${typeof __EXT_VERSION__ === 'string' ? __EXT_VERSION__ : '0.0.0'}`,
    range: { from: range.from, to: range.to, label: range.label ?? null, preset: range.preset ?? null },
    timezone: {
      zone: tcfg.zone, day_boundary_hour: tcfg.dayBoundaryHour, start_of_week: tcfg.startOfWeek,
    },
    pricing: {
      as_of: PRICES_AS_OF,
      custom: isCustomPricing(pricing),
      multiplier: cfg.pricing.multiplier,
      unknown_model: cfg.unknownModelPricing,
    },
    totals: { ...totals, lowerBound: totals.unpricedTokens > 0 },
    buckets,
    tools: toolQuery.rows.map((t) => ({
      day: t.day, source: t.source, model: t.model, tool: t.name, calls: t.calls,
    })),
    toolsTruncated: toolQuery.truncated,
    notes: [
      'usage = fresh input + cache write + output',
      'costUsd is hypothetical API cost, not a bill; null means the model has no price on file',
      'days without data have no row — gaps are gaps, not zeros',
      'tools[] counts tool calls by name and day; names only, never inputs or results. '
        + `toolsTruncated means a day had more than ${TOOL_NAME_CAP} distinct tools and the rarest were not counted`,
    ],
  }

  if (cfg.attribution !== 'none') {
    // Project labels are exported exactly as they are stored — a basename, or the salted
    // hash when showProjectNames is 'hash'. The save dialog says so before the file exists.
    out.sessions = agg.sessions().map((s) => ({
      sessionId: s.sessionId,
      project: s.project,
      source: s.source,
      isSub: s.isSub,
      parent: s.parent,
      firstTs: new Date(s.firstTs).toISOString(),
      lastTs: new Date(s.lastTs).toISOString(),
      models: s.models,
      input: s.input,
      cacheWrite5m: Math.max(0, s.cacheWrite - s.cacheWrite1h),
      cacheWrite1h: s.cacheWrite1h,
      cacheRead: s.cacheRead,
      output: s.output,
      reasoning: s.reasoning,
      requests: s.requests,
      outputFinal: s.outputFinal,
    }))
    out.notes.push('sessions[] carries project labels as stored (basename or salted hash)')
  }
  return JSON.stringify(out, null, 2) + '\n'
}

// ---------------------------------------------------------------------------
// Markdown summary (Copy Usage Summary)
// ---------------------------------------------------------------------------

function cell(s: string | null | undefined): string {
  if (s === null || s === undefined || s === '') return '–'
  return s.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ')
}

/**
 * The clipboard version: quota windows, the token tables, the costs and the footnotes that
 * qualify them. The markers travel with the numbers — a summary that loses its "~" and its
 * "lower bound" is a summary that overstates.
 */
export function toMarkdownSummary(vm: ViewModel): string {
  const L: string[] = []
  L.push(`# Token Pace — ${vm.range.label} (${vm.range.from} → ${vm.range.to})`)
  L.push('')
  if (vm.preview) L.push('> **Preview data — not a reading.**', '')

  for (const q of vm.quotas) {
    const meta = [
      // The whole fragment, so a configured name stays marked as one in the clipboard too.
      q.planText,
      q.origin ? `via ${q.origin}` : null,
      q.ageText ? `updated ${q.ageText}` : null,
      q.stale ? '⚠ stale' : null,
    ].filter(Boolean).join(' · ')
    L.push(`## ${q.title}${meta ? ` — ${meta}` : ''}`, '')
    if (q.problem) L.push(`> ⚠ ${q.problem}`, '')
    if (q.windows.length > 0) {
      L.push('| Window | Used | Elapsed | Pace | Resets |')
      L.push('|---|---|---|---|---|')
      for (const w of q.windows) {
        // The verdict as the three views print it: nothing while the window is still measuring.
        L.push(`| ${cell(w.label)} | ${cell(w.percentText)} | `
          + `${w.elapsed === null ? '–' : `${Math.round(w.elapsed)} %`} | `
          + `${cell(w.verdict.measuring ? '' : w.verdict.text)} | ${cell(w.reset)} |`)
      }
      L.push('')
    }
    if (q.extra) L.push(`Extra usage: ${cell(q.extra.text)}`, '')
    // Word for word the sentence the three views print. The clipboard must not be the one
    // place where a five-hour figure appears without saying what it is not.
    if (q.localBlock) L.push(q.localBlock.text, '')
  }

  for (const t of vm.totals) {
    L.push(`## Tokens — ${t.title}`, '')
    L.push('| Period | Usage | Cache read | Output | Req. | Cache hit | API cost |')
    L.push('|---|---|---|---|---|---|---|')
    for (const r of t.rows) {
      L.push(`| ${cell(r.label)} | ${cell(r.usage)} | ${cell(r.cacheRead)} | `
        + `${cell(r.output)}${r.incomplete ? ' ⚠' : ''} | ${cell(r.requests)} | ${cell(r.cacheHit)} | `
        + `${cell(r.cost)}${r.costPartial ? ' ⚠' : ''} |`)
    }
    L.push('')
  }

  if (vm.budgets.length > 0) {
    L.push('## Budgets', '')
    // Word for word the line the three views print, so a pasted summary cannot describe a
    // budget differently from the panel it was copied out of.
    for (const b of vm.budgets) L.push(`- ${b.text}${b.partial ? ' ⚠' : ''}`)
    L.push('')
    L.push('_Your own limits; USD is the hypothetical API equivalent, not a bill._', '')
  }

  if (vm.cacheEconomy.length > 0) {
    L.push('## Cache economy', '')
    for (const c of vm.cacheEconomy) {
      L.push(`- **${c.source}**: hit ${c.hitRate} · realised ${c.savedUsd} · blended ${c.blendedPerM} `
        + `(${c.note})`)
    }
    L.push('')
  }

  if (vm.digest.length > 0) {
    L.push('## Summary', '')
    for (const s of vm.digest) L.push(`- ${s}`)
    L.push('')
  }

  L.push('---', '')
  for (const f of vm.footnotes) L.push(`- ${f}`)
  // Counted off the quota cards themselves: every window carries the gaps of its own series,
  // so the sentence survives a page that no longer prints a forecast list.
  const gaps = vm.quotas.reduce((n, q) => n + q.windows.reduce((m, w) => m + w.gaps, 0), 0)
  if (gaps > 0) {
    L.push(`- Quota readings have ${gaps} gap(s) in the last 24 h; a hole with no reset inside it `
      + 'is bridged by a dashed line, a hole across a reset stays open.')
  }
  L.push('')
  return L.join('\n')
}
