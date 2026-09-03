// SPDX-FileCopyrightText: 2026 Frederik Marx
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Analytics over the bucket store: KPIs with period-over-period deltas, token composition,
 * cache economics, calendar periods, model tables, heatmap, hour profile and drill-downs.
 *
 * Everything here is pure and free of vscode, because these are the numbers three different
 * views (webview, QuickPick, markdown) and the exporter all have to agree on. Deriving them
 * twice is how three renderings start telling three different stories.
 *
 * Two rules run through the whole file. Absence is a dash, never a zero — a period without
 * data has no cache hit rate, and printing "0 %" would state something we did not measure.
 * And no denominator is ever invented: a division whose divisor is zero yields '–', not a
 * number that looks measured.
 */

import { Aggregator, BucketFilter, Metric, billable } from './agg'
import { PRICES_AS_OF, PricingOptions, costOfBucket, priceOf } from './prices'
import { Provenance, compact, deltaBadge, estimate, percentOf, usd } from './render'
import {
  DayRange, TimeConfig, addDays, dayCount, dayOf, dayOfHour, daysBetween, formatTime,
  localHourOfDay, weekdayOf,
} from './time'
import { Bucket, SessionRec, Source, Tier } from './types'

// ---------------------------------------------------------------------------
// Shapes the view model hands on unchanged (it re-exports these types).
// ---------------------------------------------------------------------------

export interface Kpi {
  key: string
  label: string
  value: string
  provenance: Provenance
  delta: { glyph: string; text: string } | null
  spark: number[]
  note: string | null
}

export interface TotalRow {
  label: string
  from: string
  to: string
  usage: string
  freshInput: string
  cacheWrite5m: string
  cacheWrite1h: string
  cacheRead: string
  output: string
  reasoning: string
  requests: string
  cost: string
  listCost: string | null
  costPartial: boolean
  incomplete: boolean
  cacheHit: string
  perRequest: string
  costPerRequest: string
  outputShare: string
  provenance: Provenance
}

export interface ModelRow {
  model: string
  source: Source
  isSub: boolean
  tier: Tier
  usage: number
  usageText: string
  output: string
  requests: string
  cost: number
  costText: string
  listCost: string | null
  cacheHit: string
  share: string
  costShare: string
  priced: 'exact' | 'family' | 'custom' | 'none'
  price: string
  turnAvg: string | null
  turnP90: string | null
}

export interface ProjectRow {
  project: string
  usage: string
  cost: string
  requests: string
  cacheHit: string
  /** Already formatted ("42 %"), and '–' when there is no denominator to divide by. */
  share: string
  sessions: number
}

export interface SessionRow {
  session: string
  project: string
  source: Source
  isSub: boolean
  started: string
  duration: string
  usage: string
  cost: string
  requests: string
  models: string
  cacheHit: string
  cacheState: string | null
}

/** One calendar period of the calendar section. */
export interface PeriodRow {
  label: string
  from: string
  to: string
  usage: string
  cost: string
  requests: string
  activeDays: number
  avgPerDay: string
}

export interface CompositionPart {
  key: 'freshInput' | 'cacheWrite5m' | 'cacheWrite1h' | 'cacheRead' | 'output' | 'reasoning'
  tokens: number
  text: string
}

export interface CompositionEntry {
  source: Source
  parts: CompositionPart[]
}

export interface CacheEconomyRow {
  source: Source
  hitRate: string
  /** The same rate as a number 0..100, or null without a denominator — for the digest rules. */
  hitValue: number | null
  savedUsd: string
  blendedPerM: string
  note: string
  partial: boolean
}

export interface PlanFactorRow {
  source: Source
  text: string
  partial: boolean
}

export interface CalendarRows {
  thisWeek: PeriodRow
  thisMonth: PeriodRow & { projection: string | null; projectionBasis: string | null }
  lastMonth: PeriodRow
  year: PeriodRow
}

export interface HeatmapDay {
  day: string
  level: 0 | 1 | 2 | 3 | 4 | null
  value: number
  text: string
}

export interface HeatmapData {
  weeks: { days: HeatmapDay[] }[]
  metric: 'usage' | 'cost'
  streak: number
  longestStreak: number
  activeDays: number
  peakDay: { day: string; text: string } | null
  variability: { cv: string; spikyDays: number } | null
  firstDay: string | null
}

export interface HoursData {
  profile: { hour: number; value: number; text: string }[]
  peakHour: number | null
  grid: { weekday: number; block: number; value: number | null; samples: number }[]
  /** Row labels of the grid, already rotated to `startOfWeek`. */
  weekdayLabels: string[]
  zone: 'local' | 'utc'
  days: number
  note: string | null
}

export interface ChartData {
  days: string[]
  labels: string[]
  series: { source: Source; values: number[] }[]
  metric: Metric
  max: number
  ticks: number[]
  weekly: boolean
  costLine: number[] | null
}

export interface WindowUsageRow {
  source: Source
  windowId: string
  label: string
  usage: string
  cost: string
  requests: string
  complete: boolean
}

export interface AttributionRows {
  rows: { label: string; share: string; usage: string }[]
  unexplained: string
}

export interface DrillData {
  day: string
  models: ModelRow[]
  sessions: SessionRow[]
}

export const MODEL_SORT_KEYS = ['model', 'usage', 'output', 'requests', 'cost', 'cacheHit'] as const
export type ModelSortKey = (typeof MODEL_SORT_KEYS)[number]

export interface ModelSort {
  key: ModelSortKey
  dir: 'asc' | 'desc'
}

/** Everything the analytics need that is not the question itself. */
export interface StatsCtx {
  agg: Aggregator
  tcfg: TimeConfig
  pricing: PricingOptions
  now: number
  /** Providers the user left switched on; an empty list means "nothing selected". */
  sources: Source[]
  /** Model filter; empty means every model. */
  models: string[]
  showCost: boolean
}

const MS_HOUR = 3_600_000
/** Beyond this many columns a daily chart is a comb — the data is condensed to weeks. */
export const WEEKLY_CHART_DAYS = 120
/** A sparkline is a shape, not a table; fourteen points is what fits next to a KPI. */
export const SPARK_POINTS = 14
/** Below this many active days a month projection would extrapolate from noise. */
export const MIN_PROJECTION_DAYS = 5
/** A weekday × 4-hour cell needs this many distinct days behind it before it says anything. */
export const MIN_GRID_SAMPLES = 3
/** A P90 over fewer turn samples than this is the maximum with extra steps. */
export const MIN_P90_SAMPLES = 20
/** Streaks and variability need at least a week of active days to mean anything. */
export const MIN_VARIABILITY_DAYS = 7

export const SOURCE_TITLE: Record<Source, string> = { claude: 'Claude Code', codex: 'Codex' }

const WEEKDAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const WEEK_START_INDEX: Record<string, number> = {
  sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6,
}

/** Weekday names in the user's own week order — `weekdayOf` returns 0 for their first day. */
export function weekdayLabels(tcfg: TimeConfig): string[] {
  const start = WEEK_START_INDEX[tcfg.startOfWeek] ?? 1
  return Array.from({ length: 7 }, (_, i) => WEEKDAY_NAMES[(start + i) % 7])
}

// ---------------------------------------------------------------------------
// Bucket helpers
// ---------------------------------------------------------------------------

export function filterFor(ctx: StatsCtx, source?: Source): BucketFilter {
  const f: BucketFilter = {}
  if (source) f.source = source
  if (ctx.models.length > 0) f.models = ctx.models
  return f
}

/** The day a bucket belongs to in the configured zone — the same mapping the aggregator uses. */
export function dayOfBucket(b: Bucket, tcfg: TimeConfig): string {
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

/**
 * Buckets of a range, with the same placement rules as `Aggregator.sum`: hour buckets by the
 * configured zone, day buckets as stored, and a month bucket only when the whole month lies
 * inside — its days cannot be told apart any more, and splitting it would invent them.
 */
export function bucketsIn(ctx: StatsCtx, from: string, to: string, source?: Source): Bucket[] {
  const out: Bucket[] = []
  const models = ctx.models.length > 0 ? new Set(ctx.models) : null
  for (const b of ctx.agg.all()) {
    if (source ? b.source !== source : !ctx.sources.includes(b.source)) continue
    if (models && !models.has(b.model)) continue
    if (b.res === 'm') {
      if (`${b.day}-01` < from || monthLast(b.day) > to) continue
    } else {
      const day = dayOfBucket(b, ctx.tcfg)
      if (day < from || day > to) continue
    }
    out.push(b)
  }
  return out
}

/** Cost of one bucket at the price of the day it belongs to in the configured zone. */
export function costOfBucketOn(b: Bucket, ctx: StatsCtx) {
  const day = dayOfBucket(b, ctx.tcfg)
  return costOfBucket(day === b.day ? b : { ...b, day }, ctx.pricing)
}

/** Fresh input: Codex reports cached tokens inside `input_tokens`, Claude reports them apart. */
export function freshInput(b: Bucket): number {
  return b.source === 'codex' ? Math.max(0, b.input - b.cacheRead) : b.input
}

/**
 * Every token that carries a price, for the blended rate. Cache reads are counted once —
 * for Codex they are already part of `input`, so adding them again would deflate the rate.
 */
export function allTokens(b: Bucket): number {
  return freshInput(b) + b.cacheWrite + b.cacheRead + b.output
}

/**
 * Numerator and denominator of the cache hit rate, kept apart so several buckets can be
 * combined without averaging averages. Claude counts cache reads next to fresh input,
 * Codex counts them inside it — one formula for both would be wrong for one of them.
 */
export function cacheHitParts(b: Bucket): { num: number; den: number } {
  return b.source === 'codex'
    ? { num: b.cacheRead, den: b.input }
    : { num: b.cacheRead, den: b.input + b.cacheRead }
}

function sumParts(list: Bucket[]): { num: number; den: number } {
  let num = 0
  let den = 0
  for (const b of list) {
    const p = cacheHitParts(b)
    num += p.num
    den += p.den
  }
  return { num, den }
}

/** A token count, or a dash when there is nothing — "0" would claim a measurement. */
function tokens(n: number): string {
  return n > 0 ? compact(n) : '–'
}

/** A hypothetical API amount. Marked as an estimate, never as a bill. */
export function costText(n: number): string {
  const s = usd(n)
  return s === '–' ? s : estimate(s)
}

function ratePerM(usdTotal: number, tokenCount: number): string {
  if (tokenCount <= 0 || usdTotal <= 0) return '–'
  return estimate(usd((usdTotal / tokenCount) * 1e6))
}

// ---------------------------------------------------------------------------
// Totals
// ---------------------------------------------------------------------------

export function totalRow(
  ctx: StatsCtx,
  label: string,
  from: string,
  to: string,
  source: Source,
  showListPrice = false,
): TotalRow {
  const b = ctx.agg.sum(from, to, ctx.tcfg, filterFor(ctx, source))
  const c = ctx.agg.cost(from, to, ctx.tcfg, ctx.pricing, filterFor(ctx, source))
  const use = billable(b)
  const hit = cacheHitParts({ ...b, source })
  const fresh = freshInput({ ...b, source })
  return {
    label,
    from,
    to,
    usage: tokens(use),
    freshInput: tokens(fresh),
    cacheWrite5m: tokens(Math.max(0, b.cacheWrite - b.cacheWrite1h)),
    cacheWrite1h: tokens(b.cacheWrite1h),
    cacheRead: tokens(b.cacheRead),
    output: tokens(b.output),
    reasoning: tokens(b.reasoning),
    requests: tokens(b.requests),
    cost: ctx.showCost ? costText(c.usd) : '–',
    listCost: ctx.showCost && showListPrice && c.listUsd > 0 ? costText(c.listUsd) : null,
    costPartial: c.unpricedTokens > 0 || c.fastUnpricedTokens > 0,
    incomplete: b.requests > 0 && b.outputFinal < b.requests,
    cacheHit: percentOf(hit.num, hit.den),
    perRequest: b.requests > 0 ? compact(use / b.requests) : '–',
    costPerRequest: ctx.showCost && b.requests > 0 ? costText(c.usd / b.requests) : '–',
    outputShare: percentOf(b.output, use),
    // The token side is read from the transcripts; the cost column carries its own '~'.
    provenance: 'measured',
  }
}

/** The eight rows of the token section, per provider. */
export function totalsFor(
  ctx: StatsCtx,
  source: Source,
  range: DayRange,
  previous: DayRange | null,
  firstDay: string | null,
  showListPrice = false,
): TotalRow[] {
  const today = dayOf(ctx.now, ctx.tcfg)
  const rows: TotalRow[] = [totalRow(ctx, range.label, range.from, range.to, source, showListPrice)]
  if (previous) {
    rows.push(totalRow(ctx, previous.label, previous.from, previous.to, source, showListPrice))
  }
  rows.push(totalRow(ctx, 'Today', today, today, source, showListPrice))
  rows.push(totalRow(ctx, 'Last 7 days', addDays(today, -6), today, source, showListPrice))
  rows.push(totalRow(ctx, 'Last 30 days', addDays(today, -29), today, source, showListPrice))
  rows.push(totalRow(ctx, 'This week', addDays(today, -weekdayOf(today, ctx.tcfg)), today, source, showListPrice))
  rows.push(totalRow(ctx, 'This month', `${today.slice(0, 8)}01`, today, source, showListPrice))
  rows.push(totalRow(ctx, 'All time', firstDay ?? today, today, source, showListPrice))
  return rows
}

// ---------------------------------------------------------------------------
// KPIs
// ---------------------------------------------------------------------------

function seriesOf(ctx: StatsCtx, days: string[], metric: Metric): number[] {
  const out = new Array<number>(days.length).fill(0)
  for (const s of ctx.sources) {
    const v = ctx.agg.series(days, ctx.tcfg, filterFor(ctx, s), metric, ctx.pricing)
    for (let i = 0; i < out.length; i++) out[i] += v[i]
  }
  return out
}

function lastDaysEndingAt(day: string, n: number): string[] {
  const out: string[] = []
  for (let i = n - 1; i >= 0; i--) out.push(addDays(day, -i))
  return out
}

function activeDaysIn(values: number[]): number {
  let n = 0
  for (const v of values) if (v > 0) n++
  return n
}

interface RangeFacts {
  usage: number
  cost: number
  requests: number
  hit: { num: number; den: number }
  activeDays: number
  days: string[]
  daily: number[]
}

function factsFor(ctx: StatsCtx, from: string, to: string): RangeFacts {
  const days = daysBetween(from, to)
  const daily = seriesOf(ctx, days, 'usage')
  let usage = 0
  let cost = 0
  let requests = 0
  const list = bucketsIn(ctx, from, to)
  for (const b of list) {
    usage += billable(b)
    requests += b.requests
    const c = costOfBucketOn(b, ctx)
    if (c && !c.unpriced) cost += c.usd
  }
  return { usage, cost, requests, hit: sumParts(list), activeDays: activeDaysIn(daily), days, daily }
}

/**
 * The KPI row: one figure per card, its change against the equally long previous period, and
 * a fourteen-day shape. A missing previous period yields "new" rather than an infinite rise.
 */
export function kpis(ctx: StatsCtx, range: DayRange, previous: DayRange | null): Kpi[] {
  const cur = factsFor(ctx, range.from, range.to)
  const prev = previous ? factsFor(ctx, previous.from, previous.to) : null
  const sparkDays = lastDaysEndingAt(range.to, SPARK_POINTS)
  const usageSpark = seriesOf(ctx, sparkDays, 'usage')
  const costSpark = ctx.showCost ? seriesOf(ctx, sparkDays, 'cost') : usageSpark.map(() => 0)
  const reqSpark = seriesOf(ctx, sparkDays, 'requests')
  const len = dayCount(range.from, range.to)

  const delta = (c: number, p: number | null): { glyph: string; text: string } => deltaBadge(c, p)
  const hitRate = cur.hit.den > 0 ? cur.hit.num / cur.hit.den : null
  const prevHit = prev && prev.hit.den > 0 ? prev.hit.num / prev.hit.den : null
  const avg = cur.activeDays > 0 ? cur.usage / cur.activeDays : null
  const prevAvg = prev && prev.activeDays > 0 ? prev.usage / prev.activeDays : null

  const out: Kpi[] = [
    {
      key: 'usage',
      label: 'Usage',
      value: tokens(cur.usage),
      provenance: 'measured',
      delta: prev ? delta(cur.usage, prev.usage) : { glyph: 'new', text: 'new' },
      spark: usageSpark,
      note: 'fresh input + cache write + output',
    },
    {
      key: 'requests',
      label: 'Requests',
      value: tokens(cur.requests),
      provenance: 'measured',
      delta: prev ? delta(cur.requests, prev.requests) : { glyph: 'new', text: 'new' },
      spark: reqSpark,
      note: 'a Codex token_count event is not necessarily one turn',
    },
    {
      key: 'cacheHit',
      label: 'Cache hit',
      value: percentOf(cur.hit.num, cur.hit.den),
      provenance: 'derived',
      delta: hitRate === null ? null : prevHit === null ? { glyph: 'new', text: 'new' } : delta(hitRate, prevHit),
      spark: seriesOf(ctx, sparkDays, 'cacheRead'),
      note: 'cache reads ÷ input',
    },
    {
      key: 'activeDays',
      label: 'Active days',
      value: len > 0 ? `${cur.activeDays} of ${len}` : '–',
      provenance: 'measured',
      delta: prev ? delta(cur.activeDays, prev.activeDays) : { glyph: 'new', text: 'new' },
      spark: usageSpark.map((v) => (v > 0 ? 1 : 0)),
      note: null,
    },
    {
      key: 'avgPerActiveDay',
      label: 'Ø per active day',
      value: avg === null ? '–' : compact(avg),
      provenance: 'derived',
      delta: avg === null ? null : prevAvg === null ? { glyph: 'new', text: 'new' } : delta(avg, prevAvg),
      spark: usageSpark,
      note: null,
    },
  ]
  if (ctx.showCost) {
    out.splice(1, 0, {
      key: 'cost',
      label: 'API equivalent',
      value: costText(cur.cost),
      provenance: 'estimated',
      delta: prev ? delta(cur.cost, prev.cost) : { glyph: 'new', text: 'new' },
      spark: costSpark,
      note: 'hypothetical: what this usage would have cost through the API',
    })
  }
  return out
}

// ---------------------------------------------------------------------------
// Composition and cache economy
// ---------------------------------------------------------------------------

export function composition(ctx: StatsCtx, range: DayRange): CompositionEntry[] {
  const out: CompositionEntry[] = []
  for (const source of ctx.sources) {
    const b = ctx.agg.sum(range.from, range.to, ctx.tcfg, filterFor(ctx, source))
    const parts: CompositionPart[] = [
      { key: 'freshInput', tokens: freshInput({ ...b, source }), text: 'Fresh input' },
      { key: 'cacheWrite5m', tokens: Math.max(0, b.cacheWrite - b.cacheWrite1h), text: 'Cache write 5m' },
      { key: 'cacheWrite1h', tokens: b.cacheWrite1h, text: 'Cache write 1h' },
      { key: 'cacheRead', tokens: b.cacheRead, text: 'Cache read' },
      { key: 'output', tokens: b.output, text: 'Output' },
      { key: 'reasoning', tokens: b.reasoning, text: 'Reasoning (of output)' },
    ]
    out.push({ source, parts })
  }
  return out
}

/**
 * What one bucket's cache reads saved, as the difference between two priced buckets: the
 * same tokens once as fresh input and once as they were actually billed.
 *
 * Going through the cost function rather than through the rate table keeps the saving on
 * exactly the same basis as the blended rate next to it — fast-mode rates, the US surcharge
 * and a configured contract multiplier all apply to both sides or to neither.
 */
function cacheSavingOf(b: Bucket, ctx: StatsCtx, actualUsd: number): number {
  if (b.cacheRead <= 0 && b.cacheWrite <= 0) return 0
  const asFresh = costOfBucketOn(
    { ...b, input: freshInput(b) + b.cacheRead, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0 },
    ctx,
  )
  if (!asFresh || asFresh.unpriced) return 0
  return asFresh.usd - actualUsd
}

/**
 * What the prompt cache actually bought, per provider.
 *
 * The saving is counterfactual: it compares the cache reads against what the same tokens
 * would have cost as fresh input, minus what was paid to write the cache. It can be
 * negative — a cache that is written and never read is a surcharge, and that is exactly the
 * case worth seeing. Codex has no separate write rate, so it has no write term.
 */
export function cacheEconomy(ctx: StatsCtx, range: DayRange): CacheEconomyRow[] {
  const out: CacheEconomyRow[] = []
  for (const source of ctx.sources) {
    const list = bucketsIn(ctx, range.from, range.to, source)
    const hit = sumParts(list)
    let saved = 0
    let cost = 0
    let priced = 0
    let unpricedTokens = 0
    for (const b of list) {
      const c = costOfBucketOn(b, ctx)
      // A fast-mode bucket whose model has no published fast rate comes back `unpriced`,
      // not null. Its tokens are known and its price is not, so it belongs on the unpriced
      // side of both figures — pricing it at the standard rate is exactly the invention
      // the fast tier exists to avoid.
      if (!c || c.unpriced) {
        unpricedTokens += billable(b)
        continue
      }
      cost += c.usd
      priced += allTokens(b)
      saved += cacheSavingOf(b, ctx, c.usd)
    }
    const savedText = saved === 0 ? '–' : estimate(saved < 0 ? `-${usd(-saved)}` : usd(saved))
    out.push({
      source,
      hitRate: percentOf(hit.num, hit.den),
      hitValue: hit.den > 0 ? (hit.num / hit.den) * 100 : null,
      savedUsd: ctx.showCost ? savedText : '–',
      blendedPerM: ctx.showCost ? ratePerM(cost, priced) : '–',
      note: source === 'claude'
        ? 'counterfactual: cache reads at the input rate, minus what the writes cost'
        : 'counterfactual: cache reads at the input rate (Codex bills no cache write)',
      partial: unpricedTokens > 0,
    })
  }
  return out
}

// ---------------------------------------------------------------------------
// Calendar periods and the month projection
// ---------------------------------------------------------------------------

function periodRow(ctx: StatsCtx, label: string, from: string, to: string): PeriodRow {
  const f = factsFor(ctx, from, to)
  return {
    label,
    from,
    to,
    usage: tokens(f.usage),
    cost: ctx.showCost ? costText(f.cost) : '–',
    requests: tokens(f.requests),
    activeDays: f.activeDays,
    avgPerDay: f.activeDays > 0 ? compact(f.usage / f.activeDays) : '–',
  }
}

export function calendar(ctx: StatsCtx): CalendarRows {
  const today = dayOf(ctx.now, ctx.tcfg)
  const weekFrom = addDays(today, -weekdayOf(today, ctx.tcfg))
  const monthFrom = `${today.slice(0, 8)}01`
  const lastMonthEnd = addDays(monthFrom, -1)
  const thisMonth = periodRow(ctx, 'This month', monthFrom, today)
  const projected = projectMonth(ctx, monthFrom, today)
  return {
    thisWeek: periodRow(ctx, 'This week', weekFrom, today),
    thisMonth: { ...thisMonth, ...projected },
    lastMonth: periodRow(ctx, 'Last month', `${lastMonthEnd.slice(0, 8)}01`, lastMonthEnd),
    year: periodRow(ctx, 'This year', `${today.slice(0, 4)}-01-01`, today),
  }
}

/**
 * End-of-month projection with its derivation spelled out.
 *
 * The average is per elapsed day, not per active day: a month is projected over its
 * calendar, and dividing by active days only would project a rate nobody keeps up. Below
 * five active days the projection stays silent rather than extrapolating from a weekend.
 */
function projectMonth(
  ctx: StatsCtx,
  from: string,
  today: string,
): { projection: string | null; projectionBasis: string | null } {
  if (!ctx.showCost) return { projection: null, projectionBasis: null }
  const f = factsFor(ctx, from, today)
  if (f.activeDays < MIN_PROJECTION_DAYS) return { projection: null, projectionBasis: null }
  const elapsed = dayCount(from, today)
  if (elapsed <= 0) return { projection: null, projectionBasis: null }
  const last = monthLast(from.slice(0, 7))
  const remaining = dayCount(today, last) - 1
  if (remaining <= 0) return { projection: null, projectionBasis: null }
  const perDay = f.cost / elapsed
  const total = f.cost + perDay * remaining
  return {
    projection: costText(total),
    projectionBasis: `so far ${usd(f.cost)} · Ø ${usd(perDay)}/day · ${remaining} days left`,
  }
}

/**
 * How the month's hypothetical API cost compares to what the plan costs.
 *
 * Only shown when the user stated a plan price — guessing one would be an invented number,
 * and plan prices differ per country, currency and contract.
 */
export function planFactors(
  ctx: StatsCtx,
  planPriceUsd: { claude?: number; codex?: number },
): PlanFactorRow[] {
  if (!ctx.showCost) return []
  const today = dayOf(ctx.now, ctx.tcfg)
  const from = `${today.slice(0, 8)}01`
  const out: PlanFactorRow[] = []
  for (const source of ctx.sources) {
    const plan = planPriceUsd[source]
    if (typeof plan !== 'number' || !Number.isFinite(plan) || plan <= 0) continue
    const c = ctx.agg.cost(from, today, ctx.tcfg, ctx.pricing, filterFor(ctx, source))
    const partial = c.unpricedTokens > 0 || c.fastUnpricedTokens > 0
    const factor = c.usd / plan
    out.push({
      source,
      text: c.usd > 0
        ? `${estimate(usd(c.usd))} API equivalent this month ÷ ${usd(plan)} plan = ×${factor.toFixed(1)}`
        : `no priced usage this month against the ${usd(plan)} plan`,
      partial,
    })
  }
  return out
}

// ---------------------------------------------------------------------------
// Model table
// ---------------------------------------------------------------------------

interface TurnStats {
  avg: number | null
  p90: number | null
}

/** Turn gaps of the sessions that used a model — only available with attribution on. */
function turnStats(sessions: SessionRec[], source: Source, model: string): TurnStats {
  const gaps: number[] = []
  for (const s of sessions) {
    if (s.source !== source || !s.models.includes(model)) continue
    for (const g of s.turnGapsMs) if (Number.isFinite(g) && g > 0) gaps.push(g)
  }
  if (gaps.length === 0) return { avg: null, p90: null }
  const avg = gaps.reduce((a, b) => a + b, 0) / gaps.length
  if (gaps.length < MIN_P90_SAMPLES) return { avg, p90: null }
  const sorted = [...gaps].sort((a, b) => a - b)
  return { avg, p90: sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.9))] }
}

/** "1.4 s" / "2 min 05 s" — turn gaps span three orders of magnitude. */
function durationText(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '–'
  if (ms < 1000) return `${Math.round(ms)} ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`
  const m = Math.floor(ms / 60_000)
  const s = Math.round((ms % 60_000) / 1000)
  if (m < 60) return `${m} min ${String(s).padStart(2, '0')} s`
  return `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')} min`
}

/** Why a group carries no cost — the Price column says which of the two it is. */
function unpricedText(reason: 'no price' | 'fast rate unknown' | null): string {
  return reason === 'fast rate unknown'
    ? 'fast rate unknown — no rate on file for this tier'
    : 'no price on file'
}

function priceTextFor(model: string, day: string, ctx: StatsCtx): { priced: ModelRow['priced']; text: string } {
  const p = priceOf(model, day, ctx.pricing)
  if (!p) return { priced: 'none', text: 'no price on file' }
  const rates = `${usd(p.price.input)} / ${usd(p.price.output)} per 1M`
  if (p.confidence === 'custom') return { priced: 'custom', text: `${rates}, your configured rates` }
  if (p.confidence === 'family') {
    return { priced: 'family', text: `${rates}, borrowed from ${p.family ?? 'a related model'}` }
  }
  return { priced: 'exact', text: `${rates}, list as of ${PRICES_AS_OF}` }
}

function sortRows(rows: ModelRow[], sort: ModelSort): ModelRow[] {
  const dir = sort.dir === 'asc' ? 1 : -1
  const key = sort.key
  return [...rows].sort((a, b) => {
    let d = 0
    if (key === 'model') d = a.model.localeCompare(b.model)
    else if (key === 'cost') d = a.cost - b.cost
    else if (key === 'usage') d = a.usage - b.usage
    else if (key === 'output') d = numOf(a.output) - numOf(b.output)
    else if (key === 'requests') d = numOf(a.requests) - numOf(b.requests)
    else d = numOf(a.cacheHit) - numOf(b.cacheHit)
    // A stable tie-break keeps rows from swapping places on every one-second redraw.
    return d !== 0 ? d * dir : a.model.localeCompare(b.model)
  })
}

/** Reads the number back out of a formatted cell; a dash sorts as "no value", below zero. */
function numOf(text: string): number {
  const m = /-?\d+(\.\d+)?/.exec(text.replace(/,/g, ''))
  if (!m) return -1
  const v = Number(m[0])
  if (!Number.isFinite(v)) return -1
  if (text.endsWith('K')) return v * 1e3
  if (text.endsWith('M')) return v * 1e6
  if (text.endsWith('G')) return v * 1e9
  return v
}

export function modelTable(
  ctx: StatsCtx,
  range: DayRange,
  sort: ModelSort,
  limit: number,
  showListPrice = false,
): { rows: ModelRow[]; total: number; hidden: number; sort: ModelSort } {
  const list = bucketsIn(ctx, range.from, range.to)
  const sessions = ctx.agg.sessions()
  const groups = new Map<string, {
    model: string; source: Source; isSub: boolean; tier: Tier
    usage: number; output: number; requests: number; cost: number; listUsd: number
    hit: { num: number; den: number }; unpriced: boolean; unpricedReason: 'no price' | 'fast rate unknown' | null
  }>()
  let totalUsage = 0
  let totalCost = 0
  for (const b of list) {
    const key = `${b.source}|${b.model}|${b.isSub ? 1 : 0}|${b.tier}`
    let g = groups.get(key)
    if (!g) {
      g = {
        model: b.model, source: b.source, isSub: b.isSub, tier: b.tier,
        usage: 0, output: 0, requests: 0, cost: 0, listUsd: 0,
        hit: { num: 0, den: 0 }, unpriced: false, unpricedReason: null,
      }
      groups.set(key, g)
    }
    g.usage += billable(b)
    g.output += b.output
    g.requests += b.requests
    const parts = cacheHitParts(b)
    g.hit.num += parts.num
    g.hit.den += parts.den
    const c = costOfBucketOn(b, ctx)
    if (!c || c.unpriced) {
      g.unpriced = true
      // 'no price' loses to nothing: a group that has both is unpriced for the plainer reason.
      if (g.unpricedReason !== 'no price') g.unpricedReason = c?.reason ?? 'no price'
    }
    if (c && !c.unpriced) {
      g.cost += c.usd
      g.listUsd += c.listUsd
    }
    totalUsage += billable(b)
    totalCost += c && !c.unpriced ? c.usd : 0
  }

  const rows: ModelRow[] = [...groups.values()].map((g) => {
    const price = priceTextFor(g.model, range.to, ctx)
    const turns = turnStats(sessions, g.source, g.model)
    return {
      model: g.model,
      source: g.source,
      isSub: g.isSub,
      tier: g.tier,
      usage: g.usage,
      usageText: tokens(g.usage),
      output: tokens(g.output),
      requests: tokens(g.requests),
      cost: g.cost,
      costText: ctx.showCost ? costText(g.cost) : '–',
      listCost: ctx.showCost && showListPrice && g.listUsd > 0 ? costText(g.listUsd) : null,
      cacheHit: percentOf(g.hit.num, g.hit.den),
      share: percentOf(g.usage, totalUsage),
      costShare: ctx.showCost ? percentOf(g.cost, totalCost) : '–',
      // The list rates belong to a bucket that was billed at them. A fast-mode group whose
      // model has no published fast rate was not, so it is 'none' with the reason named —
      // quoting the standard rates next to a dashed-out cost would attribute a price to it.
      priced: g.unpriced ? 'none' : price.priced,
      price: g.unpriced ? unpricedText(g.unpricedReason) : price.text,
      turnAvg: turns.avg === null ? null : estimate(durationText(turns.avg)),
      turnP90: turns.p90 === null ? null : estimate(durationText(turns.p90)),
    }
  })

  const sorted = sortRows(rows, sort)
  const cap = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : sorted.length
  return {
    rows: sorted.slice(0, cap),
    total: sorted.length,
    hidden: Math.max(0, sorted.length - cap),
    sort,
  }
}

// ---------------------------------------------------------------------------
// Chart
// ---------------------------------------------------------------------------

/** A round number at or above `v`, so the axis labels are readable. */
export function niceCeil(v: number): number {
  if (!Number.isFinite(v) || v <= 0) return 1
  const mag = Math.pow(10, Math.floor(Math.log10(v)))
  const rest = v / mag
  const step = rest <= 1 ? 1 : rest <= 2 ? 2 : rest <= 5 ? 5 : 10
  return step * mag
}

export function chart(ctx: StatsCtx, range: DayRange, metric: Metric): ChartData {
  const days = daysBetween(range.from, range.to)
  const weekly = days.length > WEEKLY_CHART_DAYS
  const perSource = ctx.sources.map((source) => ({
    source,
    values: ctx.agg.series(days, ctx.tcfg, filterFor(ctx, source), metric, ctx.pricing),
  }))
  const costDaily = ctx.showCost && metric !== 'cost'
    ? seriesOf(ctx, days, 'cost')
    : null

  let labels = days.map((d) => d.slice(5))
  let outDays = days
  let series = perSource
  let costLine = costDaily
  if (weekly) {
    // Server-side condensation: beyond four months a per-day bar is a hairline nobody reads.
    const starts: string[] = []
    const groups: number[][] = []
    for (let i = 0; i < days.length; i++) {
      if (i === 0 || weekdayOf(days[i], ctx.tcfg) === 0) {
        starts.push(days[i])
        groups.push([])
      }
      groups[groups.length - 1].push(i)
    }
    outDays = starts
    labels = starts.map((d) => d.slice(5))
    series = perSource.map((s) => ({
      source: s.source,
      values: groups.map((g) => g.reduce((sum, i) => sum + s.values[i], 0)),
    }))
    costLine = costDaily ? groups.map((g) => g.reduce((sum, i) => sum + costDaily[i], 0)) : null
  }

  const totals = outDays.map((_, i) => series.reduce((sum, s) => sum + s.values[i], 0))
  const max = niceCeil(Math.max(0, ...totals))
  return {
    days: outDays,
    labels,
    series,
    metric,
    max,
    ticks: [0.25, 0.5, 0.75, 1].map((f) => max * f),
    weekly,
    costLine,
  }
}

// ---------------------------------------------------------------------------
// Heatmap, streaks, records
// ---------------------------------------------------------------------------

/** Quantile thresholds over the active days; an all-equal series still gets one level. */
function levelsOf(values: number[]): number[] {
  const active = values.filter((v) => v > 0).sort((a, b) => a - b)
  if (active.length === 0) return []
  const at = (q: number): number => active[Math.min(active.length - 1, Math.floor(active.length * q))]
  return [at(0.25), at(0.5), at(0.75)]
}

function levelFor(value: number, thresholds: number[]): 0 | 1 | 2 | 3 | 4 {
  if (value <= 0) return 0
  if (thresholds.length < 3) return 4
  if (value <= thresholds[0]) return 1
  if (value <= thresholds[1]) return 2
  if (value <= thresholds[2]) return 3
  return 4
}

export function heatmap(
  ctx: StatsCtx,
  metric: 'usage' | 'cost',
  firstDay: string | null,
): HeatmapData {
  const today = dayOf(ctx.now, ctx.tcfg)
  // 53 columns, the last one holding today: start at the week start 52 weeks back.
  const lastStart = addDays(today, -weekdayOf(today, ctx.tcfg))
  const from = addDays(lastStart, -52 * 7)
  const days = daysBetween(from, addDays(lastStart, 6))
  const values = seriesOf(ctx, days, metric === 'cost' ? 'cost' : 'usage')
  const thresholds = levelsOf(values.filter((_, i) => days[i] <= today))

  const weeks: { days: HeatmapDay[] }[] = []
  const yesterday = addDays(today, -1)
  let runToday = 0
  let runYesterday = 0
  let longest = 0
  let run = 0
  let active = 0
  let peak: { day: string; text: string } | null = null
  let peakValue = 0
  const activeValues: number[] = []

  for (let i = 0; i < days.length; i++) {
    const day = days[i]
    const value = values[i]
    if (i % 7 === 0) weeks.push({ days: [] })
    // No first day at all means nothing was ever ingested: every cell is outside coverage,
    // never a measured zero. "no usage" is a statement about a day we watched.
    const outside = firstDay === null || day < firstDay || day > today
    const level: HeatmapDay['level'] = outside ? null : levelFor(value, thresholds)
    weeks[weeks.length - 1].days.push({
      day,
      level,
      value,
      text: outside
        ? 'outside coverage'
        : value > 0
          ? `${day}: ${metric === 'cost' ? costText(value) : compact(value)}`
          : `${day}: no usage`,
    })
    if (outside) continue
    if (value > 0) {
      active++
      activeValues.push(value)
      run++
      if (run > longest) longest = run
      if (value > peakValue) {
        peakValue = value
        peak = { day, text: metric === 'cost' ? costText(value) : compact(value) }
      }
    } else {
      run = 0
    }
    if (day === today) runToday = run
    else if (day === yesterday) runYesterday = run
  }
  // The streak that counts is the one still running. Before the first prompt of the day
  // that is yesterday's: a streak does not end because the morning has not started yet.
  const current = runToday > 0 ? runToday : runYesterday

  let variability: HeatmapData['variability'] = null
  if (activeValues.length >= MIN_VARIABILITY_DAYS) {
    const mean = activeValues.reduce((a, b) => a + b, 0) / activeValues.length
    const varSum = activeValues.reduce((a, b) => a + (b - mean) * (b - mean), 0) / activeValues.length
    const sd = Math.sqrt(varSum)
    variability = {
      cv: mean > 0 ? (sd / mean).toFixed(2) : '–',
      spikyDays: activeValues.filter((v) => v > mean + 2 * sd).length,
    }
  }

  return {
    weeks,
    metric,
    streak: current,
    longestStreak: longest,
    activeDays: active,
    peakDay: peak,
    variability,
    firstDay,
  }
}

// ---------------------------------------------------------------------------
// Hour profile and weekday grid
// ---------------------------------------------------------------------------

/**
 * Time-of-day profile, built from hour buckets only.
 *
 * Rolled-up data has no hour left in it; padding the profile with day sums would invent a
 * distribution. The number of days behind the profile is stated so a two-day sample is not
 * mistaken for a habit, and rolled-up days that had to be left out are named.
 */
export function hours(ctx: StatsCtx, range: DayRange, zone: 'local' | 'utc'): HoursData {
  const profile = new Array(24).fill(0).map((_, hour) => ({ hour, value: 0, text: '–' }))
  const cellDays = new Map<string, Set<string>>()
  const cellValue = new Map<string, number>()
  const seenDays = new Set<string>()
  let excluded = 0

  for (const b of bucketsIn(ctx, range.from, range.to)) {
    if (b.res !== 'h' || b.hour === null) {
      excluded++
      continue
    }
    // Weekday and hour have to come from one calendar: in UTC mode the hour is the raw UTC
    // hour, so the day it belongs to is the UTC day, without the configured boundary shift.
    const day = zone === 'utc'
      ? dayOfHour(b.hour, { ...ctx.tcfg, zone: 'utc', dayBoundaryHour: 0 })
      : dayOfHour(b.hour, ctx.tcfg)
    const hour = zone === 'utc' ? ((b.hour % 24) + 24) % 24 : localHourOfDay(b.hour, ctx.tcfg)
    const value = billable(b)
    profile[hour].value += value
    seenDays.add(day)
    const key = `${weekdayOf(day, ctx.tcfg)}|${Math.floor(hour / 4)}`
    cellValue.set(key, (cellValue.get(key) ?? 0) + value)
    let days = cellDays.get(key)
    if (!days) {
      days = new Set()
      cellDays.set(key, days)
    }
    days.add(day)
  }

  let peakHour: number | null = null
  let peakValue = 0
  for (const p of profile) {
    p.text = p.value > 0 ? compact(p.value) : '–'
    if (p.value > peakValue) {
      peakValue = p.value
      peakHour = p.hour
    }
  }

  const grid: HoursData['grid'] = []
  for (let weekday = 0; weekday < 7; weekday++) {
    for (let block = 0; block < 6; block++) {
      const key = `${weekday}|${block}`
      const samples = cellDays.get(key)?.size ?? 0
      grid.push({
        weekday,
        block,
        // Below the sample threshold a cell would be one afternoon pretending to be a habit.
        value: samples >= MIN_GRID_SAMPLES ? (cellValue.get(key) ?? 0) : null,
        samples,
      })
    }
  }

  return {
    profile,
    peakHour,
    grid,
    weekdayLabels: weekdayLabels(ctx.tcfg),
    zone,
    days: seenDays.size,
    note: excluded > 0
      ? `${excluded} rolled-up bucket${excluded === 1 ? '' : 's'} in this range have no hour left and are not in the profile`
      : null,
  }
}

// ---------------------------------------------------------------------------
// Window usage and attribution
// ---------------------------------------------------------------------------

/** Local usage since the window opened — hour buckets only, so the answer can be incomplete. */
export function windowUsage(
  ctx: StatsCtx,
  source: Source,
  w: { id: string; label: string; resetsAt: number | null; windowMinutes: number | null },
): WindowUsageRow | null {
  if (w.resetsAt === null || w.windowMinutes === null) return null
  if (!Number.isFinite(w.resetsAt) || !Number.isFinite(w.windowMinutes)) return null
  const fromMs = w.resetsAt - w.windowMinutes * 60_000
  const toMs = Math.min(ctx.now, w.resetsAt)
  const { bucket, complete } = ctx.agg.sumHours(fromMs, toMs, filterFor(ctx, source))
  const b = { ...bucket, source }
  // sumHours merges across models, so the merged bucket has no model of its own to price.
  // The cost is summed from the individual buckets over exactly the same hour range.
  const fromHour = Math.floor(fromMs / MS_HOUR)
  const toHour = Math.ceil(toMs / MS_HOUR)
  let cost = 0
  for (const one of ctx.agg.all()) {
    if (one.res !== 'h' || one.hour === null || one.source !== source) continue
    if (one.hour < fromHour || one.hour >= toHour) continue
    if (ctx.models.length > 0 && !ctx.models.includes(one.model)) continue
    const c = costOfBucketOn(one, ctx)
    if (c && !c.unpriced) cost += c.usd
  }
  const mark = (s: string): string => (complete || s === '–' ? s : `≈${s}`)
  return {
    source,
    windowId: w.id,
    label: w.label,
    usage: mark(tokens(billable(b))),
    cost: ctx.showCost ? mark(costText(cost)) : '–',
    requests: mark(tokens(b.requests)),
    complete,
  }
}

/**
 * How the tokens counted *inside* the window split across projects.
 *
 * Only the per-hour slices of a session count here, never its lifetime counters: a session
 * resumed over three days would otherwise bring its whole history into a five-hour box and
 * contradict the window usage row printed beside it. The hour range is the one `windowUsage`
 * sums over, so both tables describe the same tokens.
 *
 * The shares are shares of the *locally counted* tokens, never of the server percentage:
 * the server also counts the web app, the desktop client and system prompts, and a
 * percentage of a number we cannot see would be an invention. What the window measured but
 * no session slice explains — records written before this build kept slices, or slices
 * already pruned — is named rather than folded into the shares.
 */
export function attributionInWindow(
  ctx: StatsCtx,
  source: Source,
  w: { resetsAt: number | null; windowMinutes: number | null },
): AttributionRows | null {
  if (w.resetsAt === null || w.windowMinutes === null) return null
  if (!Number.isFinite(w.resetsAt) || !Number.isFinite(w.windowMinutes)) return null
  const fromMs = w.resetsAt - w.windowMinutes * 60_000
  const toMs = Math.min(ctx.now, w.resetsAt)
  const fromHour = Math.floor(fromMs / MS_HOUR)
  const toHour = Math.ceil(toMs / MS_HOUR)
  const byProject = new Map<string, number>()
  let total = 0
  for (const s of ctx.agg.sessions()) {
    if (s.source !== source) continue
    let use = 0
    for (const [key, value] of Object.entries(s.hourUsage ?? {})) {
      const hour = Number(key)
      if (!Number.isFinite(hour) || hour < fromHour || hour >= toHour) continue
      if (value > 0) use += value
    }
    if (use <= 0) continue
    byProject.set(s.project, (byProject.get(s.project) ?? 0) + use)
    total += use
  }
  if (byProject.size === 0) return null
  // Sessions carry no model dimension, so the rows are never model-filtered and the figure
  // they are held against must not be either — comparing them would invent a gap.
  const { bucket, complete } = ctx.agg.sumHours(fromMs, toMs, { source })
  const measured = billable({ ...bucket, source })
  const mark = (t: string): string => (complete || t === '–' ? t : `≈${t}`)
  const rows = [...byProject.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([label, value]) => ({ label, share: percentOf(value, total), usage: mark(tokens(value)) }))
  // Named only when it rounds to a visible share: "0 % unattributed" is noise, not a caveat.
  const gap = measured - total
  const named = measured > 0 && gap > 0 && Math.round((gap / measured) * 100) >= 1
  return {
    rows,
    unexplained: 'server % cannot be split — shown share is of local tokens only'
      + (named ? `; ${percentOf(gap, measured)} of this window has no session slice` : ''),
  }
}

/** A session record in bucket shape, so the same fresh-input rule applies to both. */
function emptySession(s: SessionRec): Bucket {
  return {
    source: s.source, model: '*', isSub: s.isSub, tier: 'standard', res: 'd', hour: null, day: '',
    input: s.input, cacheWrite: s.cacheWrite, cacheWrite1h: s.cacheWrite1h, cacheRead: s.cacheRead,
    output: s.output, reasoning: s.reasoning, requests: s.requests, outputFinal: s.outputFinal,
    webSearch: 0, webFetch: 0,
  }
}

// ---------------------------------------------------------------------------
// Projects and sessions (attribution opt-in)
// ---------------------------------------------------------------------------

export function projectRows(ctx: StatsCtx): ProjectRow[] {
  const groups = new Map<string, { usage: number; requests: number; hit: { num: number; den: number }; sessions: number }>()
  let total = 0
  for (const s of ctx.agg.sessions()) {
    if (!ctx.sources.includes(s.source)) continue
    let g = groups.get(s.project)
    if (!g) {
      g = { usage: 0, requests: 0, hit: { num: 0, den: 0 }, sessions: 0 }
      groups.set(s.project, g)
    }
    const b = emptySession(s)
    const use = billable(b)
    const parts = cacheHitParts(b)
    g.usage += use
    g.requests += s.requests
    g.hit.num += parts.num
    g.hit.den += parts.den
    g.sessions++
    total += use
  }
  return [...groups.entries()]
    .sort((a, b) => b[1].usage - a[1].usage)
    .map(([project, g]) => ({
      project,
      usage: tokens(g.usage),
      // Sessions carry no per-day model split, so a per-project cost would be a guess.
      cost: '–',
      requests: tokens(g.requests),
      cacheHit: percentOf(g.hit.num, g.hit.den),
      // No billable tokens anywhere means no denominator — a dash, like every column
      // beside it. A rendered "0 %" would claim a measured share of nothing.
      share: percentOf(g.usage, total),
      sessions: g.sessions,
    }))
}

export function sessionRows(ctx: StatsCtx, limit = 50): SessionRow[] {
  const list = ctx.agg.sessions()
    .filter((s) => ctx.sources.includes(s.source))
    .sort((a, b) => b.lastTs - a.lastTs)
    .slice(0, Math.max(0, limit))
  return list.map((s) => {
    const b = emptySession(s)
    const parts = cacheHitParts(b)
    return {
      session: s.sessionId,
      project: s.project,
      source: s.source,
      isSub: s.isSub,
      // The configured calendar, not UTC: `drill` files this session under `dayOf(firstTs)`,
      // and a Started column from a different zone would name another day than the one the
      // row is listed under.
      started: `${dayOf(s.firstTs, ctx.tcfg)} ${formatTime(s.firstTs, ctx.tcfg)}`,
      duration: durationText(Math.max(0, s.lastTs - s.firstTs)),
      usage: tokens(billable(b)),
      cost: '–',
      requests: tokens(s.requests),
      models: s.models.join(', '),
      cacheHit: percentOf(parts.num, parts.den),
      cacheState: cacheStateOf(s, ctx.now),
    }
  })
}

/**
 * "cache likely cold in N min" from the last cache write and its TTL class.
 *
 * An approximation on purpose: it knows nothing about server-side extensions or about
 * parallel sessions writing the same prefix, which is why it says "likely" and carries the
 * estimate marker.
 */
export function cacheStateOf(s: SessionRec, now: number): string | null {
  if (s.lastCacheWriteTs === null || s.lastCacheTtl === null) return null
  const ttl = s.lastCacheTtl === '1h' ? 60 * 60_000 : 5 * 60_000
  const left = s.lastCacheWriteTs + ttl - now
  if (left <= 0) return estimate('cache likely cold')
  const minutes = Math.max(1, Math.round(left / 60_000))
  return estimate(`cache likely cold in ${minutes} min`)
}

export function cacheStates(ctx: StatsCtx): { session: string; text: string }[] {
  const out: { session: string; text: string }[] = []
  for (const s of ctx.agg.sessions()) {
    if (!ctx.sources.includes(s.source)) continue
    const text = cacheStateOf(s, ctx.now)
    if (text) out.push({ session: s.sessionId, text })
  }
  return out.slice(0, 20)
}

// ---------------------------------------------------------------------------
// Drill-down
// ---------------------------------------------------------------------------

export function drill(ctx: StatsCtx, day: string, sort: ModelSort, limit: number): DrillData {
  const range: DayRange = { from: day, to: day, label: day, preset: 'custom' }
  const models = modelTable(ctx, range, sort, limit).rows
  // A session belongs to the day when it was running on it — its span is compared in the
  // configured zone, the same calendar the buckets were placed with.
  const onDay = new Set(
    ctx.agg.sessions()
      .filter((s) => dayOf(s.firstTs, ctx.tcfg) <= day && dayOf(s.lastTs, ctx.tcfg) >= day)
      .map((s) => s.sessionId),
  )
  return { day, models, sessions: sessionRows(ctx, 500).filter((s) => onDay.has(s.session)) }
}
