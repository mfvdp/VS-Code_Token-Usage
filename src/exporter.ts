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

import { Aggregator, billable, cleanAgentId, cleanAgentName } from './agg'
import { AGENT_RETENTION_DAYS } from './agentTree'
import { AgentRecordView, agentRecordViews } from './agentTreeBuild'
import { Config } from './config'
import { t } from './i18n'
import { PRICES_AS_OF, PricingOptions, costOfBucket, isCustomPricing } from './prices'
import { viewTitle } from './textViews'
import { TimeConfig, dayOfHour, dayOf as dayOfInstant } from './time'
import { Bucket, TOOL_NAME_CAP } from './types'
import type { ViewModel } from './viewModel'

/**
 * 2 added `tools[]` and `toolsTruncated`; 3 (1.6 O2) added `agents[]`. Everything an earlier
 * version carried is still there and still means the same thing, so a reader written for 1 or 2
 * keeps working.
 */
export const EXPORT_SCHEMA_VERSION = 3

/**
 * The agents file's columns (1.6 O2) — the fields of a JSON `agents[]` row, in their order, with
 * Claude Code's report as three columns. What the Agents section shows of an agent and nothing
 * else: ids, its type and model, its state, its counts and its times — never a path, never a word
 * of what it was asked or answered.
 */
export const AGENTS_CSV_COLUMNS = [
  'agentId', 'sessionId', 'workflowId', 'type', 'model', 'models', 'effort', 'state', 'derived',
  'outcome', 'outcomeStatus', 'attempt', 'firstTs', 'lastTs', 'requests', 'outputFinal',
  'input', 'cacheWrite5m', 'cacheWrite1h', 'cacheRead', 'output', 'reasoning', 'usage',
  'toolCalls', 'toolErrors', 'spawnedBy', 'reportTokens', 'reportDurationMs', 'reportToolUses',
] as const

/** The tool table's file beside the chosen one: `export.csv` → `export.tools.csv`. */
export const TOOLS_FILE_SUFFIX = '.tools.csv'
/** The agents file beside the chosen one (1.6 O2): `export.csv` → `export.agents.csv`. */
export const AGENTS_FILE_SUFFIX = '.agents.csv'

/**
 * Where a companion file goes: the chosen path with its extension replaced by the suffix —
 * `…/export.csv` + `.tools.csv` → `…/export.tools.csv`; a name without a dot just gains it, and a
 * dot in a directory's name is no extension.
 */
export function companionPath(path: string, suffix: string): string {
  const cut = path.lastIndexOf('.')
  const slash = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  return (cut > slash ? path.slice(0, cut) : path) + suffix
}

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
  for (const row of q.rows) {
    lines.push([row.day, row.source, row.model, row.name, row.calls].map(csvCell).join(','))
    total += row.calls
  }
  lines.push(['TOTAL', '', '', '', total].map(csvCell).join(','))
  // The cap is a fact about the data, not about the export, so it travels with it.
  if (q.truncated) {
    lines.push(['TRUNCATED', '', '', `more than ${TOOL_NAME_CAP} distinct tools on at least one day`, ''].map(csvCell).join(','))
  }
  return lines.join('\n') + '\n'
}

/** One agent row of the export, as `agents[]` writes it; the agents file flattens `report`. */
export interface AgentExportRow {
  agentId: string
  sessionId: string
  workflowId: string | null
  type: string | null
  model: string | null
  models: string[]
  effort: string | null
  state: string
  derived: boolean
  outcome: string | null
  outcomeStatus: string | null
  attempt: number | null
  firstTs: string
  lastTs: string
  requests: number
  outputFinal: number
  input: number
  cacheWrite5m: number
  cacheWrite1h: number
  cacheRead: number
  output: number
  reasoning: number
  usage: number
  toolCalls: number
  toolErrors: number | null
  spawnedBy: string | null
  report: { tokens: number; durationMs: number; toolUses: number } | null
}

/** The longest model id or type an agent row carries — the length the agent tables keep a model id to. */
const AGENT_EXPORT_NAME_MAX = 64

/**
 * One record as the tree reads it, checked once more on the way out: an id outside the ids'
 * alphabet drops the row — no record the aggregator makes carries one —, a name outside the names'
 * alphabet is null. So the file holds identifiers, words of a fixed set and numbers, whatever a
 * snapshot from elsewhere held.
 */
function agentRowOf(v: AgentRecordView): AgentExportRow | null {
  const agentId = cleanAgentId(v.agentId)
  const sessionId = cleanAgentId(v.sessionId)
  if (agentId === null || sessionId === null) return null
  const name = (x: unknown): string | null => cleanAgentName(x, AGENT_EXPORT_NAME_MAX)
  const spawnedBy = v.spawnedBy === 'session' ? 'session' : cleanAgentId(v.spawnedBy)
  return {
    agentId,
    sessionId,
    workflowId: cleanAgentId(v.workflowId),
    type: name(v.type),
    model: name(v.model),
    models: v.models.map(name).filter((m): m is string => m !== null),
    effort: v.effort,
    state: v.state,
    derived: v.derived,
    outcome: v.outcome,
    outcomeStatus: v.outcomeStatus,
    attempt: v.attempt,
    firstTs: new Date(v.firstTs).toISOString(),
    lastTs: new Date(v.lastTs).toISOString(),
    requests: v.requests,
    outputFinal: v.outputFinal,
    input: v.input,
    cacheWrite5m: Math.max(0, v.cacheWrite - v.cacheWrite1h),
    cacheWrite1h: v.cacheWrite1h,
    cacheRead: v.cacheRead,
    output: v.output,
    reasoning: v.reasoning,
    usage: v.usage,
    toolCalls: v.toolCalls,
    toolErrors: v.toolErrors,
    spawnedBy,
    report: v.report,
  }
}

/**
 * The agents of the export (1.6 O2): the agent records whose activity — from the first line to the
 * last — touches a day of the range, within the agent tables' retention, each as the Agents section
 * shows it at `now`: its state is the tree's, inferred where `derived` says so. Every session's
 * agents, not only the sessions the dashboard lists; the first to start first.
 */
export function agentRows(agg: Aggregator, range: ExportRange, cfg: Config, tcfg: TimeConfig, now = Date.now()): AgentExportRow[] {
  const views = agentRecordViews({
    agents: agg.agents(),
    launches: agg.launches(),
    mains: agg.mains(),
    runs: agg.runs(),
    runLaunches: agg.runLaunches(),
    sessions: agg.sessions(),
    attribution: cfg.attribution,
    selected: null,
    tcfg,
  }, now)
  const out: AgentExportRow[] = []
  for (const v of views) {
    if (dayOfInstant(v.firstTs, tcfg) > range.to || dayOfInstant(v.lastTs, tcfg) < range.from) continue
    const row = agentRowOf(v)
    if (row) out.push(row)
  }
  return out
}

/**
 * The agents file (1.6 O2): one line per agent row, the columns of AGENTS_CSV_COLUMNS — the models
 * joined by a space, an absent value empty, never 0. No TOTAL line: an agent's tokens are the same
 * tokens the bucket rows with `isSub` true count, hour by hour, and a sum under them would invite
 * adding the two. An empty table still gets its header row.
 */
export function agentsCsv(agg: Aggregator, range: ExportRange, cfg: Config, tcfg: TimeConfig, now = Date.now()): string {
  const lines: string[] = [AGENTS_CSV_COLUMNS.join(',')]
  const cellOf = (v: string | number | boolean | null): string => (v === null ? '' : csvCell(v))
  for (const r of agentRows(agg, range, cfg, tcfg, now)) {
    lines.push([
      r.agentId, r.sessionId, r.workflowId, r.type, r.model, r.models.join(' '), r.effort, r.state, r.derived,
      r.outcome, r.outcomeStatus, r.attempt, r.firstTs, r.lastTs, r.requests, r.outputFinal,
      r.input, r.cacheWrite5m, r.cacheWrite1h, r.cacheRead, r.output, r.reasoning, r.usage,
      r.toolCalls, r.toolErrors, r.spawnedBy,
      r.report?.tokens ?? null, r.report?.durationMs ?? null, r.report?.toolUses ?? null,
    ].map(cellOf).join(','))
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
  /** 1.6 O2 (schema 3). */
  agents: AgentExportRow[]
  sessions?: Array<Record<string, string | number | boolean | string[] | null>>
  notes: string[]
}

export function toJson(agg: Aggregator, range: ExportRange, cfg: Config, tcfg: TimeConfig, now = Date.now()): string {
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
    tools: toolQuery.rows.map((row) => ({
      day: row.day, source: row.source, model: row.model, tool: row.name, calls: row.calls,
    })),
    toolsTruncated: toolQuery.truncated,
    agents: agentRows(agg, range, cfg, tcfg, now),
    notes: [
      'usage = fresh input + cache write + output',
      'costUsd is hypothetical API cost, not a bill; null means the model has no price on file',
      'days without data have no row — gaps are gaps, not zeros',
      'tools[] counts tool calls by name and day; names only, never inputs or results. '
        + `toolsTruncated means a day had more than ${TOOL_NAME_CAP} distinct tools and the rarest were not counted`,
      // §7a Q14 of the 1.6 spec, word for word.
      'agents[] holds the agent records whose activity overlaps the exported range\'s days, within the agent tables\' '
        + `${AGENT_RETENTION_DAYS}-day retention; ids, names and counts only — never a path, a description or a prompt`,
      'an agent row counts the agent whole: the same tokens the buckets with isSub true count hour by hour, so the two are '
        + 'never added; state is the Agents section\'s, inferred where derived is true; report is Claude Code\'s own '
        + 'figure for the agent, never part of a total',
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
  // The backslash first: it is the escape character, so a value that already carries
  // one (`a\|b`) would otherwise come out as `a\\|b` — a literal backslash and a live pipe.
  return s.replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ')
}

/**
 * The clipboard version: quota windows, the token tables, the costs and the footnotes that
 * qualify them. The markers travel with the numbers — a summary that loses its "~" and its
 * "lower bound" is a summary that overstates.
 */
export function toMarkdownSummary(vm: ViewModel): string {
  const L: string[] = []
  // The range bounds are dates, not words: they stay outside the key, which is then the same
  // one the QuickPick titles itself with.
  // 1.7 F1: the summary follows the dashboard's provider switch, as the markdown view does, and its
  // heading names the provider while the switch shows one.
  const shown = viewTitle(vm)
  L.push(`# ${t('Token Pace — {0}', vm.range.label)} (${vm.range.from} → ${vm.range.to})`
    + (shown !== null ? ` · ${t('{0} only', shown)}` : ''))
  L.push('')
  if (vm.preview) L.push(`> **${t('Preview data — not a reading.')}**`, '')

  for (const q of vm.quotas) {
    const meta = [
      // The whole fragment, so a configured name stays marked as one in the clipboard too.
      q.planText,
      q.origin ? t('via {0}', q.origin) : null,
      q.ageText ? t('updated {0}', q.ageText) : null,
      q.stale ? `⚠ ${t('stale')}` : null,
    ].filter(Boolean).join(' · ')
    L.push(`## ${q.title}${meta ? ` — ${meta}` : ''}`, '')
    // 1.7 P4b: our own fetch failed after this reading — the card's sentence, under the heading and in
    // italics, as the markdown document prints it (textViews.ts), so the clipboard says why it is old.
    if (q.lastFailure) L.push(`_${cell(q.lastFailure)}_`, '')
    if (q.problem) L.push(`> ⚠ ${q.problem}`, '')
    if (q.windows.length > 0) {
      L.push(t('| Window | Used | Elapsed | Pace | Resets |'))
      L.push('|---|---|---|---|---|')
      for (const w of q.windows) {
        // The verdict as the three views print it: nothing while the window is still measuring.
        L.push(`| ${cell(w.label)} | ${cell(w.percentText)} | `
          + `${w.elapsed === null ? '–' : `${Math.round(w.elapsed)} %`} | `
          + `${cell(w.verdict.measuring ? '' : w.verdict.text)} | ${cell(w.reset)} |`)
      }
      L.push('')
    }
    if (q.extra) L.push(t('Extra usage: {0}', cell(q.extra.text)), '')
    // Word for word the sentence the three views print. The clipboard must not be the one
    // place where a five-hour figure appears without saying what it is not.
    if (q.localBlock) L.push(q.localBlock.text, '')
  }

  for (const table of vm.totals) {
    L.push(`## ${t('Tokens — {0}', table.title)}`, '')
    L.push(t('| Period | Usage | Cache read | Output | Req. | Cache hit | API cost |'))
    L.push('|---|---|---|---|---|---|---|')
    for (const r of table.rows) {
      L.push(`| ${cell(r.label)} | ${cell(r.usage)} | ${cell(r.cacheRead)} | `
        + `${cell(r.output)}${r.incomplete ? ' ⚠' : ''} | ${cell(r.requests)} | ${cell(r.cacheHit)} | `
        + `${cell(r.cost)}${r.costPartial ? ' ⚠' : ''} |`)
    }
    L.push('')
  }

  if (vm.budgets.length > 0) {
    L.push(`## ${t('Budgets')}`, '')
    // Word for word the line the three views print, so a pasted summary cannot describe a
    // budget differently from the panel it was copied out of.
    for (const b of vm.budgets) L.push(`- ${b.text}${b.partial ? ' ⚠' : ''}`)
    L.push('')
    L.push(`_${t('Your own limits; USD is the hypothetical API equivalent, not a bill.')}_`, '')
  }

  if (vm.cacheEconomy.length > 0) {
    L.push(`## ${t('Cache economy')}`, '')
    for (const c of vm.cacheEconomy) {
      L.push(`- ${t('**{0}**: hit {1} · realised {2} · blended {3} ({4})',
        c.source, c.hitRate, c.savedUsd, c.blendedPerM, c.note)}`)
    }
    L.push('')
  }

  if (vm.digest.length > 0) {
    L.push(`## ${t('Summary')}`, '')
    for (const s of vm.digest) L.push(`- ${s}`)
    L.push('')
  }

  L.push('---', '')
  for (const f of vm.footnotes) L.push(`- ${f}`)
  // Counted off the quota cards themselves: every window carries the gaps of its own series,
  // so the sentence survives a page that no longer prints a forecast list.
  const gaps = vm.quotas.reduce((n, q) => n + q.windows.reduce((m, w) => m + w.gaps, 0), 0)
  if (gaps > 0) {
    L.push(`- ${t('Quota readings have {0} gap(s) in the last 24 h; a hole with no reset inside it is bridged by a dashed line, a hole across a reset stays open.', gaps)}`)
  }
  L.push('')
  return L.join('\n')
}
