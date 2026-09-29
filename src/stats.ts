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

import { SOURCES, SOURCE_TITLE, maybeAdapterFor } from './adapters'
import { AGENT_RETENTION_DAYS, SESSION_ACTIVE_MS } from './agentTree'
import { Aggregator, BucketFilter, HourQuery, Metric, SESSION_CAP, billable } from './agg'
import { rangeArrow } from './bidi'
import { listOf, locale, t } from './i18n'
// Type only: the chart carries the setting's value, not the module that reads settings.
import type { ChartModelStyle } from './config'
import { PRICES_AS_OF, PricingOptions, costOfBucket, isCustomPricing, priceOf } from './prices'
import { OTHER_PROJECTS, UNATTRIBUTED, projectLabel } from './project'
import { Provenance, compact, decimalText, deltaBadge, estimate, full, percentOf, usd } from './render'
import {
  DayRange, TimeConfig, Zone, addDays, calendarDayOf, clockStamp, dayCount, dayOf, dayOfHour, daysBetween, formatTime,
  localHourOfDay, weekdayOf,
} from './time'
import { AgentRec, Attribution, Bucket, MainRec, ProjectLabel, SessionRec, Source, Tier, emptyBucket } from './types'

// ---------------------------------------------------------------------------
// Shapes the view model hands on unchanged (it re-exports these types).
// ---------------------------------------------------------------------------

/**
 * Which direction is the good one for this figure. The renderers colour a delta from this
 * and from nothing else: "more" is bad for usage and for money, good for a cache hit rate,
 * and neither for a count of days — a green arrow on a rising bill is a lie in one colour.
 */
export type KpiPolarity = 'upGood' | 'upBad' | 'neutral'

/**
 * What a card counts, in the words all three views share.
 *
 * A figure with no denominator on it invites the reader to invent one: "cache hit 61 %" of
 * what, over which days, against which comparison. Every sentence here is built where the
 * number is built, so the explanation cannot say one thing while the figure counts another —
 * and every one of them is text, never a formula the views would have to evaluate again.
 */
export interface KpiExplain {
  /** What the figure is, in one sentence. */
  what: string
  /** How it is computed — the formula the code above actually applies. */
  how: string
  /** Which days it covers, with the dates. */
  period: string
  /** The comparison the delta badge states, or nothing when there is no period before it. */
  compare: { against: string; previous: string } | null
  /** The same figure per provider, or nothing when the filter holds only one of them. */
  split: { claude: string; codex: string } | null
  /** Measured, derived or estimated, spelled out rather than as a one-word badge. */
  provenance: string
  /** What the sparkline beside the figure plots. */
  sparkNote: string
}

export interface Kpi {
  key: string
  label: string
  value: string
  provenance: Provenance
  // The badge's own type, so a hand-written badge cannot reintroduce a glyph the renderers
  // would print beside the text ("new new").
  delta: ReturnType<typeof deltaBadge> | null
  /** What a rise means. Never a colour: the three views each pick their own. */
  polarity: KpiPolarity
  spark: number[]
  note: string | null
  /** The card's own explanation; the views show it, they do not write it. */
  explain: KpiExplain
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
  /**
   * The oldest hours of this row's span have already been rolled up into day totals, so every
   * figure in it is a lower bound and carries `≈`. Only the two window rows can set it: a row
   * bounded by whole days is summed from the day buckets, which are never rolled away.
   */
  approx: boolean
  /** The span behind the row, for the tooltip: '2026-09-01 → 2026-09-03' or '13:00 → now'. */
  spanText: string
}

/**
 * One model of the range.
 *
 * The counted fields are the same fields `TotalRow` carries, formatted by the same helpers:
 * one model's row read against the totals row is a column-by-column comparison, and for a
 * range with a single model in it the two are identical. The `…N` fields are the raw counts
 * behind those strings — a compacted "1.2M" cannot be sorted on without reading a number
 * back out of a rounded label.
 */
export interface ModelRow {
  model: string
  source: Source
  isSub: boolean
  tier: Tier
  usage: number
  usageText: string
  freshInput: string
  cacheWrite5m: string
  cacheWrite1h: string
  cacheRead: string
  output: string
  reasoning: string
  requests: string
  perRequest: string
  freshInputN: number
  cacheWrite5mN: number
  cacheWrite1hN: number
  cacheReadN: number
  outputN: number
  reasoningN: number
  requestsN: number
  perRequestN: number
  cost: number
  costText: string
  listCost: string | null
  cacheHit: string
  /** The share behind `cacheHit`, 0..1; -1 when there was no denominator to divide by. */
  cacheHitN: number
  share: string
  costShare: string
  priced: 'exact' | 'family' | 'custom' | 'none'
  price: string
  turnAvg: string | null
  turnP90: string | null
}

/**
 * 1.14 §3 A4 rule 2: one row of the Projects table — the range's buckets of one project key, under the provider switch,
 * the model chips and the project chips.
 */
export interface ProjectRow {
  /** The project key (project.ts `PROJECT_KEY_RE` or `OTHER_PROJECTS`): the chip's `data-project`, the row's identity — never shown. */
  key: string
  /** `projectLabel`: the folder's name under `showProjectNames: basename`, else `p:` + the key; `(no project)`, `other projects`. */
  project: string
  usage: string
  /** The priced sum of the buckets (`costOfBucketOn`) with `showCost`, else '–'. */
  cost: string
  /**
   * A bucket of the project has no price on file (none, or a fast rate unknown): `cost` is the priced part, a lower bound
   * (⚠ and the footnote). Only beside a figure — a dash already says no cost is known.
   */
  costLowerBound: boolean
  /** A bucket was priced from a related model (the family fallback) — the models table's mark; only beside a figure. */
  costFamily: boolean
  requests: string
  cacheHit: string
  /** Already formatted ("42 %") — of the range's usage in the view —, and '–' when there is no denominator to divide by. */
  share: string
  /** The main sessions whose activity overlaps the range (§3 A4 rule 3): a count, or '⚠ 12' when it is a lower bound. */
  sessions: string
  /** The range starts on or before the day the session records' horizon falls on: `sessions` is at least that many. */
  sessionsLowerBound: boolean
  /** `clockStamp` of the project's newest counted line ever (§7a Q22: a fact of the project, not of the range), or '–'. */
  lastActive: string
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
  /**
   * The weekday × four-hour cells. `value` is what was measured in that cell, `samples` how
   * many distinct days it came from; `value` is null only for a cell no day ever touched,
   * which the views hatch.
   */
  grid: { weekday: number; block: number; value: number | null; samples: number }[]
  /**
   * What the grid stands on, and the one sentence every view prints with it. Below three
   * weeks the sentence says so itself, so a fortnight is not read as a routine.
   */
  basis: { weeks: number; days: number; text: string }
  /** Row labels of the grid, already rotated to `startOfWeek`. */
  weekdayLabels: string[]
  zone: 'local' | 'utc'
  days: number
  note: string | null
}

/** One line of a Records table. `cost` is '–' wherever a per-row cost cannot be derived. */
export interface RecordEntry {
  label: string
  /** The second, quieter half of the label: the provider, the project, the session count. */
  detail: string | null
  usage: string
  share: string
  cost: string
}

/**
 * The extremes of a range: its busiest day, its longest run of days with usage, and the
 * three top-N tables. Every figure here is the range's own — nothing is compared against a
 * limit, because none of these numbers has one.
 */
export interface RecordsData {
  /**
   * `cost` follows `TotalRow`: a day holding a model with no price prints the priced part
   * and sets `costPartial`, so a view can mark it with ⚠ instead of passing a silent lower
   * bound off as the day's cost. A day with no priced bucket at all prints '–'.
   */
  peakDay: { day: string; usage: string; cost: string; costPartial: boolean } | null
  /** Longest run of consecutive days with usage inside this range and inside coverage. */
  streak: { days: number; from: string; to: string } | null
  topModels: RecordEntry[]
  topProjects: RecordEntry[]
  topSessions: RecordEntry[]
  /** False when attribution is off — the two lower tables are then empty by consent, not by chance. */
  attributionOn: boolean
  /** Rolled-up months that carry no day any more: named, never silently dropped. */
  note: string | null
  /** Why a project or session row can carry tokens from outside the range. */
  sessionNote: string | null
  /**
   * 1.11 B1: the range's days by their priced cost, highest first — at most `topN`. Empty with `showCost`
   * off (a line of `recordNotes` says why) and while `reading`.
   */
  costDays: CostDayRecord[]
  /**
   * 1.11 B2: the Claude Code sessions of the Agents section's index that are no longer active, by the time
   * from their first counted line to their last and by their usage — at most `topN` each. Claude Code only:
   * empty under a provider view without it (a line of `recordNotes` says so).
   */
  longestSessions: SessionRecord[]
  largestSessions: SessionRecord[]
  /** 1.11 B3: the hours with the most cache written, from the hour buckets — at most `topN`. */
  cacheHours: CacheHourRecord[]
  /**
   * 1.11 B4: "Reading history…" while the host is still reading the transcripts (`VmInput.settled` false) —
   * then every record above is empty: the peak day and the streak null, every table empty, no note.
   */
  reading: string | null
  /**
   * 1.11: the new tables' notes, in this order — the ⚠ legend, the sessions' basis, the active sessions not
   * ranked, the cache sentence (or the empty cache table's line), the hour horizon, `showCost` off, Claude
   * Code only. Each only where it applies.
   */
  recordNotes: string[]
}

/** 1.11 B1: one of the most expensive days of a range. */
export interface CostDayRecord {
  /** The ISO day in the configured zone (`dayOfBucket`). */
  day: string
  /** `costText` of the day's priced part, at the configured rates. */
  cost: string
  /** `tokens` of the day's billable usage, priced or not. */
  usage: string
  /** ⚠: a lower bound — the day holds usage without a price on file, or it is the first day of coverage. */
  floor: boolean
}

/** 1.11 B2: one Claude Code session of the Agents section's index, as the Records rank it. */
export interface SessionRecord {
  /** Never shown whole: `name` carries its first eight characters. */
  sessionId: string
  /** The Agents tree's name of the session — "Session Tue 14:20 · 9d0eb37a" (agentTreeBuild.ts `sessionName`). */
  name: string
  /** When its first counted line was written — `clockStamp`, the Sessions table's form. */
  start: string
  /** From its first counted line to its last, pauses included — the tree's span (agentTreeBuild.ts `spanText`). */
  time: string
  /** `tokens` of its own billable usage and its agents'. */
  usage: string
}

/** 1.11 B3: one hour of the hour buckets, by the cache it wrote. */
export interface CacheHourRecord {
  /** The hour's start as a clock reading in the configured zone — "2026-09-25 14:00". */
  hour: string
  /** `tokens` of the cache writes of the hour — every provider, model and tier of the range's filter. */
  written: string
  /** `tokens` of the part of them with the 1-hour lifetime; '–' when none. */
  written1h: string
  /** `costText` of those writes at the configured rates; '–' without a priced write or with `showCost` off. */
  cost: string
  /** ⚠: a lower bound — a write of the hour has no price on file (only while a cost is shown). */
  floor: boolean
  /** The models that wrote, the largest writer first, at most two, then how many more. */
  models: string
}

/**
 * 1.11 B2, B3: what `records()` needs besides the context for the session tables and the hour horizon. The
 * session's name and span are the Agents tree's own words (agentTreeBuild.ts `sessionName`, `spanText`) and
 * come in from the caller: agentTreeBuild.ts imports this module, and an import the other way would be the
 * first cycle between the modules. Without them the two session tables stay empty and the horizon is unsaid.
 */
export interface RecordsWords {
  sessionName: (sessionId: string, start: number | null, now: number, tcfg: TimeConfig) => string
  spanText: (ms: number) => string
  /** `tokenPace.hourRetentionDays`: how long the hour buckets the cache table ranks are kept. */
  hourRetentionDays: number
}

/** A band's place among its provider's bands: 0 is the largest model, 'other' the fold. */
export type ChartRank = 0 | 1 | 2 | 3 | 4 | 'other'

/**
 * One band of the stack: one model under one provider, a model used under both providers
 * giving two. `key` (`<source>:<model>`, or `<source>:other` for the fold) is the identity a
 * view styles by, `label` the word the legend and the tooltips print, and `rank` the band's
 * place within its provider — so a view can vary the provider's one hue by rank instead of
 * needing a palette as long as the model list.
 *
 * 1.6 O2: split by main session and subagent (`ChartData.split === 'agents'`), a provider has at
 * most two bands — `<source>:main`, rank 0, "Claude Code · main sessions", and `<source>:sub`,
 * rank 1, "Claude Code · subagents" — so the main sessions keep the plain hue and the subagents
 * wear the first pattern (or shade) of every style, whichever of the two is the larger.
 */
export interface ChartSeries {
  key: string
  label: string
  source: Source
  rank: ChartRank
  values: number[]
}

/**
 * 1.6 O2: what a column is split into — its provider's models (every build before 1.6), or its
 * provider's main sessions and subagents, from the buckets' own `isSub` dimension.
 */
export type ChartSplit = 'model' | 'agents'
export const CHART_SPLITS: readonly ChartSplit[] = ['model', 'agents']

export interface ChartData {
  days: string[]
  labels: string[]
  /**
   * Claude's bands first, then Codex's; within a provider largest first, the fold last — or,
   * split by main session and subagent, the main sessions first and the subagents second.
   */
  series: ChartSeries[]
  metric: Metric
  /**
   * How the webview tells one provider's bands apart — a setting, carried here so the page
   * reads it from the one view model rather than from a second channel.
   */
  modelStyle: ChartModelStyle
  /** 1.6 O2: what the columns are split into, as the reader chose it (`ui.chartSplit`). */
  split: ChartSplit
  max: number
  ticks: number[]
  weekly: boolean
  costLine: number[] | null
}

/**
 * Local tokens over the last few hours — everything we can say when a provider tells us
 * nothing. Deliberately without a percentage, a limit, a pace or a forecast: there is no
 * denominator here, and inventing one would turn an estimate into a fake quota window.
 */
export interface LocalBlockRow {
  source: Source
  /** Length of the span in hours, so the sentence and the number cannot drift apart. */
  hours: number
  usage: string
  cost: string
  requests: string
  /** Clock time of the first hour bucket with usage in the span, or null when there is none. */
  firstAt: string | null
  /** False when the span reaches past the kept hour buckets — every figure then carries '≈'. */
  complete: boolean
  /** The one sentence all three views print, so they cannot phrase it three ways. */
  text: string
}

export interface DrillData {
  day: string
  models: ModelRow[]
  sessions: SessionRow[]
}

/** One key per column of the model table — the header a reader clicks is the key it sends. */
export const MODEL_SORT_KEYS = ['model', 'usage', 'freshInput', 'cacheWrite5m', 'cacheWrite1h',
  'cacheRead', 'output', 'reasoning', 'requests', 'cacheHit', 'perRequest', 'cost',
  'share'] as const
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
  /**
   * 1.14 §3 A4 rule 1 (§0a.8): the project filter — project keys; empty or left out means every project. A bucket
   * predicate beside `models`: every bucket sum of the context follows it (`filterFor`, `bucketsIn`, the hour spans), and
   * so do the session records the context reads (by their key). The sections a project does not reach are handed a
   * context without it (viewModel.ts `projectFilterIgnoredBy`).
   */
  projects?: string[]
  /**
   * 1.14 §3 A1 rule 4: whether a project is shown by its folder's name — `showProjectNames: basename`. Left out, by its
   * pseudonym: the label table holds a name only under basename (§3 A7), and this is the second lock (`projectLabel`).
   */
  projectNames?: boolean
  /**
   * 1.14 §3 A4 rule 3: `tokenPace.hourRetentionDays`, the session records' horizon (§3 A3 rule 3). Left out, a session
   * count is not called a lower bound for the horizon (the record cap still makes one).
   */
  hourRetentionDays?: number
  showCost: boolean
  /**
   * The attribution setting, when the caller states it. Left out it is inferred from the
   * session table, which the aggregator only fills while attribution is on — so a caller
   * that forgets the field loses no rows it was entitled to.
   */
  attribution?: Attribution
  /**
   * 1.6 L5 (Review 3): the hour sums of the view-model build this context belongs to, each span
   * summed once and shared — see `HourSums`. Left out, every hour span is summed on its own.
   */
  hours?: HourSums
  /**
   * 1.7 P-A: the build's one copy of the buckets (`agg.all()`), shared by every table of the build —
   * `bucketsIn`, the hour-span cost, the first used hour — so one build copies the bucket array once
   * instead of once per table. Read only: nothing changes the array or a bucket in it. Left out,
   * each walk takes its own copy, as every caller outside a view-model build does.
   */
  buckets?: readonly Bucket[]
}

/**
 * The hour sums of one view-model build (1.6 L5, Review 3). A build sums the same spans of hour
 * buckets several times over — the totals table's two window rows per provider, each Claude
 * window's subagent share (its subagents and its whole, over the very bounds of the totals row),
 * the data-quality line's last seven days — and each `sumHours` walked every bucket again. Here
 * each span and filter is summed once: the ones the build knows it will ask for together in one
 * pass (`prefetch`), any other on its first request; every later request of it is answered from
 * memory. The answers are exactly `sumHours`' — it is the same rule, asked once. Made for one
 * build and dropped with it: the buckets move on between two builds.
 */
export class HourSums {
  private readonly memo = new Map<string, { bucket: Bucket; complete: boolean }>()
  private readonly modelMemo = new Map<Source, string[]>()

  /**
   * `buckets` (1.7 P-A): the build's one copy of `agg.all()`, which `modelsOf` walks; left out, it
   * takes a copy of its own on its first question.
   */
  constructor(private readonly agg: Aggregator, private readonly buckets?: readonly Bucket[]) {}

  /** Sums every query not answered yet, together in one pass over the buckets. */
  prefetch(queries: readonly HourQuery[]): void {
    const missing = new Map<string, HourQuery>()
    for (const q of queries) {
      const key = hourQueryKey(q)
      if (!this.memo.has(key) && !missing.has(key)) missing.set(key, q)
    }
    if (missing.size === 0) return
    const answers = this.agg.sumHoursMany([...missing.values()])
    let i = 0
    for (const key of missing.keys()) this.memo.set(key, answers[i++])
  }

  /** `sumHours(fromMs, toMs, filter)`, from memory when it was asked before. A copy: the caller may not change the shared sum. */
  get(fromMs: number, toMs: number, filter?: BucketFilter): { bucket: Bucket; complete: boolean } {
    const key = hourQueryKey({ fromMs, toMs, filter })
    let r = this.memo.get(key)
    if (!r) {
      r = this.agg.sumHours(fromMs, toMs, filter)
      this.memo.set(key, r)
    }
    return { bucket: { ...r.bucket }, complete: r.complete }
  }

  /** The distinct model ids the buckets of a source carry, sorted — one pass per build, however often asked. */
  modelsOf(source: Source): string[] {
    let models = this.modelMemo.get(source)
    if (!models) {
      const seen = new Set<string>()
      for (const b of this.buckets ?? this.agg.all()) if (b.source === source) seen.add(b.model)
      models = [...seen].sort()
      this.modelMemo.set(source, models)
    }
    return [...models]
  }
}

/** What makes two hour sums the same one: the bounds and the filter, as `sumHours` reads it. */
function hourQueryKey(q: HourQuery): string {
  const f = q.filter ?? {}
  const models = f.models && f.models.length > 0 ? f.models.join('\u0001') : ''
  // 1.14 §3 A4 rule 1: two project filters are two sums — the memo tells them apart.
  const projects = f.projects && f.projects.length > 0 ? f.projects.join('\u0001') : ''
  return `${q.fromMs}|${q.toMs}|${f.source ?? ''}|${f.isSub === undefined ? '' : String(f.isSub)}|${f.tier ?? ''}|${models}|${projects}`
}

/** An hour sum through the build's shared sums when the context has them, else on its own. */
function sumHoursOf(ctx: StatsCtx, fromMs: number, toMs: number, filter?: BucketFilter): { bucket: Bucket; complete: boolean } {
  return ctx.hours ? ctx.hours.get(fromMs, toMs, filter) : ctx.agg.sumHours(fromMs, toMs, filter)
}

const MS_HOUR = 3_600_000
/** Beyond this many columns a daily chart is a comb — the data is condensed to weeks. */
export const WEEKLY_CHART_DAYS = 120
/** A sparkline is a shape, not a table; fourteen points is what fits next to a KPI. */
export const SPARK_POINTS = 14
/** Below this many active days a month projection would extrapolate from noise. */
export const MIN_PROJECTION_DAYS = 5
/** From this many weeks of usage days on, the weekday grid is a habit rather than a record. */
const GRID_HABIT_WEEKS = 3
/** A P90 over fewer turn samples than this is the maximum with extra steps. */
export const MIN_P90_SAMPLES = 20
/** Streaks and variability need at least a week of active days to mean anything. */
export const MIN_VARIABILITY_DAYS = 7
/** The rolling local block is five hours long, the shortest window every provider has. */
export const LOCAL_BLOCK_HOURS = 5

/** The provider titles, from the registry — re-exported so the views name a row's provider
 * from the same table the model used. */
export { SOURCE_TITLE }

const WEEK_START_INDEX: Record<string, number> = {
  sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6,
}

/**
 * The seven weekday abbreviations, Sunday first.
 *
 * Built on call rather than kept in a module-level table: the translation bundle is only
 * installed at activation, and a table filled before that would stay English for good.
 */
function weekdayNames(): string[] {
  return [t('Sun'), t('Mon'), t('Tue'), t('Wed'), t('Thu'), t('Fri'), t('Sat')]
}

/** Weekday names in the user's own week order — `weekdayOf` returns 0 for their first day. */
export function weekdayLabels(tcfg: TimeConfig): string[] {
  const start = WEEK_START_INDEX[tcfg.startOfWeek] ?? 1
  const names = weekdayNames()
  return Array.from({ length: 7 }, (_, i) => names[(start + i) % 7])
}

// ---------------------------------------------------------------------------
// Bucket helpers
// ---------------------------------------------------------------------------

export function filterFor(ctx: StatsCtx, source?: Source): BucketFilter {
  const f: BucketFilter = {}
  if (source) f.source = source
  if (ctx.models.length > 0) f.models = ctx.models
  if (ctx.projects && ctx.projects.length > 0) f.projects = ctx.projects
  return f
}

/** 1.14 §3 A4 rule 1: the context's project filter as a set, or null for every project. */
function projectSet(ctx: StatsCtx): Set<string> | null {
  return ctx.projects && ctx.projects.length > 0 ? new Set(ctx.projects) : null
}

/**
 * 1.14 §3 A4 rule 1: a bucket or a session record in the project filter — every one while the filter is empty (a none
 * bucket too), else those whose key is in it; a bucket without a key (attribution none) is in no non-empty filter.
 */
function inProjects(set: Set<string> | null, key: string | undefined): boolean {
  return set === null || (key !== undefined && set.has(key))
}

/** 1.14: the session records of the context's project filter. */
function sessionsIn(ctx: StatsCtx): SessionRec[] {
  const set = projectSet(ctx)
  const all = ctx.agg.sessions()
  return set === null ? all : all.filter((s) => inProjects(set, s.project))
}

/**
 * The hour a bucket belongs to costs an `Intl` format to place in a zone, and one view-model
 * rebuild asks that of every hour bucket several times over — once to range-check it, once
 * per table that groups it. The answer depends on nothing but the hour and the two fields of
 * the time config that decide where a day begins, so it is remembered on those — the two kept
 * as they are and compared field by field, no key string built per bucket (1.9 L-7); the
 * aggregator keeps a memo of its own for the same reason. The cap is a bound on the memory,
 * not on the correctness: a cleared memo is refilled from the same inputs.
 */
let dayMemoZone: Zone | null = null
let dayMemoBoundary: number | null = null
const dayMemo = new Map<number, string>()

/** The day a bucket belongs to in the configured zone — the same mapping the aggregator uses. */
export function dayOfBucket(b: Bucket, tcfg: TimeConfig): string {
  if (b.res === 'h') {
    if (tcfg.zone !== dayMemoZone || tcfg.dayBoundaryHour !== dayMemoBoundary) {
      dayMemoZone = tcfg.zone
      dayMemoBoundary = tcfg.dayBoundaryHour
      dayMemo.clear()
    }
    const hour = b.hour ?? 0
    let day = dayMemo.get(hour)
    if (day === undefined) {
      if (dayMemo.size > 50_000) dayMemo.clear()
      day = dayOfHour(hour, tcfg)
      dayMemo.set(hour, day)
    }
    return day
  }
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
 * inside — its days cannot be told apart any more, and splitting it would invent them. Walks the
 * build's shared copy when the context has one (1.7 P-A).
 */
export function bucketsIn(ctx: StatsCtx, from: string, to: string, source?: Source): Bucket[] {
  const out: Bucket[] = []
  const models = ctx.models.length > 0 ? new Set(ctx.models) : null
  const projects = projectSet(ctx)
  for (const b of ctx.buckets ?? ctx.agg.all()) {
    if (source ? b.source !== source : !ctx.sources.includes(b.source)) continue
    if (models && !models.has(b.model)) continue
    if (!inProjects(projects, b.project)) continue
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

/**
 * Fresh input: Codex reports cached tokens inside `input_tokens`, Claude reports them apart.
 *
 * Total on purpose. A bucket can come back from a snapshot on disk carrying any string as its
 * source, and every view sits behind a `try`: a throw here would blank the dashboard instead of
 * stating an absence. An unknown provider gets the plain reading, exactly as `agg.billable`
 * treats everything that is not Codex.
 */
export function freshInput(b: Bucket): number {
  const a = maybeAdapterFor(b.source)
  return a ? a.freshInput(b) : b.input
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

/**
 * A token count, or a dash when there is nothing — "0" would claim a measurement. Exported
 * for the agent tree's details, which print the same kinds as the totals table and must not
 * format them a second way.
 */
export function tokens(n: number): string {
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
    // Whole days are summed from the day buckets, which outlive the hour buckets: a row
    // bounded by dates is never a lower bound for want of an hour.
    approx: false,
    // 1.13 (Review 1 F1): the arrow the way the words read (bidi.ts rangeArrow).
    spanText: from === to ? from : `${from}${rangeArrow()}${to}`,
  }
}

/** The two spans the window rows cover, in the words the provider windows use. */
const TOTALS_WINDOW_SPANS: { minutes: number; label: string }[] = [
  { minutes: 300, label: '5 h' },
  { minutes: 10080, label: '7 d' },
]

/** A reported window counts as the span when its length matches to the minute. */
const WINDOW_MINUTES_SLACK = 1

/** The provider's reported quota window, as much of it as the totals rows need. */
export interface TotalsWindow {
  id: string
  label: string
  resetsAt: number | null
  windowMinutes: number | null
}

/**
 * The bounds behind a window row in words: '13:00 → now', or with the date in front when the
 * span started on an earlier day — a bare clock time on a seven-day row would name an hour
 * without saying which day it belongs to.
 */
function spanTextOf(ctx: StatsCtx, fromMs: number, toMs: number): string {
  const today = dayOf(ctx.now, ctx.tcfg)
  const at = (ms: number): string => {
    const day = dayOf(ms, ctx.tcfg)
    return day === today ? formatTime(ms, ctx.tcfg) : `${day} ${formatTime(ms, ctx.tcfg)}`
  }
  return `${at(fromMs)}${rangeArrow()}${toMs >= ctx.now ? t('now') : at(toMs)}`
}

/**
 * One row over a half-open span of hours, for the two window rows of the totals table.
 *
 * Hour buckets are the only resolution that can answer a span which does not start at a day
 * boundary, and they are pruned before the day totals are: once the oldest hours of the span
 * are gone, every figure in the row is a lower bound and says so with `≈`. Zero is printed
 * like any other measurement here — the transcripts were read, and an unused window is a
 * measured absence of usage, not an absence of data.
 */
function hourSpanRow(
  ctx: StatsCtx,
  source: Source,
  label: string,
  fromMs: number,
  toMs: number,
  showListPrice: boolean,
): TotalRow {
  const { bucket, complete } = sumHoursOf(ctx, fromMs, toMs, filterFor(ctx, source))
  const b = { ...bucket, source }
  const c = hourSpanCost(ctx, source, Math.floor(fromMs / MS_HOUR), Math.ceil(toMs / MS_HOUR))
  const use = billable(b)
  const hit = cacheHitParts(b)
  const fresh = freshInput(b)
  const mark = (t: string): string => (complete || t === '–' ? t : `≈${t}`)
  return {
    label,
    from: dayOf(fromMs, ctx.tcfg),
    to: dayOf(Math.max(fromMs, toMs - 1), ctx.tcfg),
    usage: mark(tokens(use)),
    freshInput: mark(tokens(fresh)),
    cacheWrite5m: mark(tokens(Math.max(0, b.cacheWrite - b.cacheWrite1h))),
    cacheWrite1h: mark(tokens(b.cacheWrite1h)),
    cacheRead: mark(tokens(b.cacheRead)),
    output: mark(tokens(b.output)),
    reasoning: mark(tokens(b.reasoning)),
    requests: mark(tokens(b.requests)),
    // The cost cells keep the one mark they already carry: `costText` prefixes `~` because
    // an API cost is an estimate whatever the span, and a second glyph in front of it —
    // "≈~$0.50" — is two caveats on one figure. That the row is a lower bound is said by
    // every other cell in it and by the note under the table.
    cost: ctx.showCost ? costText(c.usd) : '–',
    listCost: ctx.showCost && showListPrice && c.listUsd > 0 ? costText(c.listUsd) : null,
    costPartial: c.partial,
    incomplete: b.requests > 0 && b.outputFinal < b.requests,
    cacheHit: mark(percentOf(hit.num, hit.den)),
    perRequest: mark(b.requests > 0 ? compact(use / b.requests) : '–'),
    costPerRequest: ctx.showCost && b.requests > 0 ? costText(c.usd / b.requests) : '–',
    outputShare: mark(percentOf(b.output, use)),
    provenance: 'measured',
    approx: !complete,
    spanText: spanTextOf(ctx, fromMs, toMs),
  }
}

/**
 * The 5 h and the 7 d row of one provider.
 *
 * Where the provider reports a window of that length with a reset time, the row covers
 * exactly that window — the same bounds the quota card's bar is drawn over, so the two say
 * the same thing about the same hours. Where it does not, the row is a trailing span of the
 * same length ending now, and its label says "Last" rather than "Current": a span nobody
 * reported a reset for is not a window, and it must not be read as one.
 */
function windowRows(
  ctx: StatsCtx,
  source: Source,
  windows: TotalsWindow[],
  showListPrice: boolean,
): TotalRow[] {
  return totalsWindowSpans(ctx.now, windows).map((span) => hourSpanRow(
    ctx, source,
    span.reported ? t('Current {0} window', span.label) : t('Last {0}', span.label),
    span.fromMs, span.toMs, showListPrice,
  ))
}

/**
 * The spans the two window rows of the totals table sum, in their order: a reported window's own
 * bounds where the provider reports one of that length with a reset time, else the trailing span
 * of the same length ending now (see `windowRows`). Exported for the view model, which asks for
 * these sums together with the other hour spans of its build (`HourSums.prefetch`).
 */
export function totalsWindowSpans(
  now: number, windows: TotalsWindow[],
): Array<{ label: string; reported: boolean; fromMs: number; toMs: number }> {
  return TOTALS_WINDOW_SPANS.map((span) => {
    const spanMs = span.minutes * 60_000
    const reported = windows.find((w) =>
      w.windowMinutes !== null && Number.isFinite(w.windowMinutes)
      && Math.abs(w.windowMinutes - span.minutes) <= WINDOW_MINUTES_SLACK
      && w.resetsAt !== null && Number.isFinite(w.resetsAt))
    if (reported && reported.resetsAt !== null && reported.windowMinutes !== null) {
      // The reported length, not the nominal one: the slack above lets a 299-minute window
      // match the 5 h row, and a bound a minute off the card's is a different hour bucket
      // once `sumHours` rounds outward. The nominal span only names the row.
      const fromMs = reported.resetsAt - reported.windowMinutes * 60_000
      const toMs = Math.min(now, reported.resetsAt)
      // A reset further out than the window is long puts the window's start in the future;
      // there is no elapsed span to sum then, and the trailing span below is the honest answer.
      if (toMs > fromMs) return { label: span.label, reported: true, fromMs, toMs }
    }
    return { label: span.label, reported: false, fromMs: now - spanMs, toMs: now }
  })
}

/**
 * The selected range, its predecessor and the fixed comparison rows, per provider.
 *
 * The selected range is frequently one of the fixed rows — "Last 30 days" with the 30 d
 * preset picked. Printing both would put two rows with the same label and the same numbers
 * in one table, which reads as a bug and invites a comparison that cannot differ. The
 * identical twin is therefore dropped; when only the label collides (an "All time" whose
 * first day is not the one the fixed row uses) both rows stay and the selected one says so.
 */
export function totalsFor(
  ctx: StatsCtx,
  source: Source,
  range: DayRange | null,
  previous: DayRange | null,
  firstDay: string | null,
  showListPrice = false,
  windows: TotalsWindow[] = [],
): TotalRow[] {
  const today = dayOf(ctx.now, ctx.tcfg)
  // The same messages `time.rangeFor` labels the presets with, so the twin below still
  // recognises "the selected range is this fixed row" once both are translated.
  const fixed: { label: string; from: string; to: string }[] = [
    { label: t('Today'), from: today, to: today },
    { label: t('Last {0} days', 7), from: addDays(today, -6), to: today },
    { label: t('Last {0} days', 30), from: addDays(today, -29), to: today },
    { label: t('This week'), from: addDays(today, -weekdayOf(today, ctx.tcfg)), to: today },
    { label: t('This month'), from: `${today.slice(0, 8)}01`, to: today },
    { label: t('All time'), from: firstDay ?? today, to: today },
  ]
  // No range: fixed periods only — the dashboard's table, which sits above the filter bar.
  const twin = range ? fixed.find((f) => f.label === range.label) : undefined
  const same = range !== null && twin !== undefined && twin.from === range.from && twin.to === range.to
  const rows: TotalRow[] = []
  if (range) {
    const label = twin !== undefined && !same ? t('Selected range ({0})', range.label) : range.label
    rows.push(totalRow(ctx, label, range.from, range.to, source, showListPrice))
  }
  if (range && previous) {
    rows.push(totalRow(ctx, previous.label, previous.from, previous.to, source, showListPrice))
  }
  // The two running windows lead the fixed rows: they are the spans a reader checks against
  // the quota cards above them, and 'Today' is a calendar day, not a window.
  rows.push(...windowRows(ctx, source, windows, showListPrice))
  for (const f of fixed) {
    if (same && f.label === (range as DayRange).label) continue
    rows.push(totalRow(ctx, f.label, f.from, f.to, source, showListPrice))
  }
  return rows
}

// ---------------------------------------------------------------------------
// KPIs
// ---------------------------------------------------------------------------

function seriesOf(ctx: StatsCtx, days: string[], metric: Metric, source?: Source): number[] {
  const out = new Array<number>(days.length).fill(0)
  for (const s of source ? [source] : ctx.sources) {
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

function factsFor(ctx: StatsCtx, from: string, to: string, source?: Source): RangeFacts {
  const days = daysBetween(from, to)
  const daily = seriesOf(ctx, days, 'usage', source)
  let usage = 0
  let cost = 0
  let requests = 0
  const list = bucketsIn(ctx, from, to, source)
  for (const b of list) {
    usage += billable(b)
    requests += b.requests
    const c = costOfBucketOn(b, ctx)
    if (c && !c.unpriced) cost += c.usd
  }
  return { usage, cost, requests, hit: sumParts(list), activeDays: activeDaysIn(daily), days, daily }
}

/**
 * Provenance as a sentence rather than as a one-word badge, for the card's explanation.
 *
 * A function, like every other little word table in this file: `t()` reads its message from
 * the source, and a table built at module load would be filled before the bundle is
 * installed and would stay English for the rest of the session.
 */
function provenanceText(p: Provenance): string {
  switch (p) {
    case 'derived': return t('derived from measured figures')
    case 'estimated': return t('estimated (~): what this usage would cost through the API')
    default: return t('measured')
  }
}

/** What the fourteen points beside every figure are; one sentence, one place. */
function sparkNote(): string {
  return t('last {0} days · one point per day', SPARK_POINTS)
}

/** The three counted fields behind every token figure — the same words on every card. */
function howUsage(): string {
  return t('fresh input + cache write + output')
}

/**
 * The days of a range; its arrow the way the words read (1.13 Review 1 F1). time.ts's custom label keeps → in every
 * language (Review 2 F2: it is data every outlet shares), so periodOf knows a hand-picked range by that form.
 */
function spanOf(from: string, to: string): string {
  return from === to ? from : `${from}${rangeArrow()}${to}`
}

/**
 * A range as "what it is called · which days it covers", lower case because it is read as a
 * fragment behind a "Period" label. A hand-picked range is already named by its days, and
 * printing the name and the dates would state the same thing twice.
 */
function periodOf(r: DayRange): string {
  const days = spanOf(r.from, r.to)
  // A hand-picked range's label is its days with → in every language (time.ts, Review 2 F2): the days once, the arrow theirs.
  if (r.label === days || r.label === `${r.from} → ${r.to}`) return days
  return `${r.label.charAt(0).toLowerCase()}${r.label.slice(1)} · ${days}`
}

/**
 * The same facts per provider, or nothing.
 *
 * Only when both providers are actually in the filter: with one of them switched off a
 * "split" would print a figure for a provider whose rows the rest of the card excludes.
 */
function splitFactsFor(
  ctx: StatsCtx, from: string, to: string,
): { claude: RangeFacts; codex: RangeFacts } | null {
  if (!ctx.sources.includes('claude') || !ctx.sources.includes('codex')) return null
  return { claude: factsFor(ctx, from, to, 'claude'), codex: factsFor(ctx, from, to, 'codex') }
}

/** Which accounts a figure covers, named the way the cards name them. */
function sourcesText(ctx: StatsCtx): string {
  const titles = ctx.sources.map((s) => SOURCE_TITLE[s] ?? s)
  if (titles.length === 0) return t('no provider selected')
  return titles.length > 1 ? t('both providers') : titles[0]
}

/** The split formatted by the very function that formatted the card's own value. */
function splitWith(
  per: { claude: RangeFacts; codex: RangeFacts } | null,
  format: (f: RangeFacts) => string,
): { claude: string; codex: string } | null {
  return per ? { claude: format(per.claude), codex: format(per.codex) } : null
}

/**
 * The KPI row: one figure per card, its change against the equally long previous period, and
 * a fourteen-day shape. A missing previous period yields "new" rather than an infinite rise.
 *
 * The first tile is deliberately not about the selected range: "today" is the figure someone
 * opens the panel for, and a reader who has switched the range to last month should not have
 * to switch back to see it. Its delta is against yesterday, the only comparison that makes
 * "today" mean anything, and it says so in its note.
 *
 * Every card also carries its own `explain`: the sentence pair, the period with its dates,
 * the comparison, the per-provider split and the basis. It is built here, beside the figure,
 * because an explanation written in a view is an explanation that can drift from the number.
 */
export function kpis(ctx: StatsCtx, range: DayRange, previous: DayRange | null): Kpi[] {
  const cur = factsFor(ctx, range.from, range.to)
  const prev = previous ? factsFor(ctx, previous.from, previous.to) : null
  const sparkDays = lastDaysEndingAt(range.to, SPARK_POINTS)
  const usageSpark = seriesOf(ctx, sparkDays, 'usage')
  const costSpark = ctx.showCost ? seriesOf(ctx, sparkDays, 'cost') : usageSpark.map(() => 0)
  const reqSpark = seriesOf(ctx, sparkDays, 'requests')
  const len = dayCount(range.from, range.to)

  const delta = (c: number, p: number | null): ReturnType<typeof deltaBadge> => deltaBadge(c, p)
  const hitRate = cur.hit.den > 0 ? cur.hit.num / cur.hit.den : null
  const prevHit = prev && prev.hit.den > 0 ? prev.hit.num / prev.hit.den : null
  const avg = cur.activeDays > 0 ? cur.usage / cur.activeDays : null
  const prevAvg = prev && prev.activeDays > 0 ? prev.usage / prev.activeDays : null

  const per = splitFactsFor(ctx, range.from, range.to)
  const period = periodOf(range)
  const against = previous ? periodOf(previous) : null
  /**
   * One card's explanation. `format` is the very function that formatted the card's value,
   * so the previous period and the two providers are printed on the same scale as the
   * figure itself — a raw number beside a compacted one would read as a different quantity.
   */
  const explainOf = (
    what: string,
    how: string,
    provenance: Provenance,
    format: (f: RangeFacts) => string,
  ): KpiExplain => ({
    what,
    how,
    period,
    compare: against !== null && prev !== null ? { against, previous: format(prev) } : null,
    split: splitWith(per, format),
    provenance: provenanceText(provenance),
    sparkNote: sparkNote(),
  })
  const usageText = (f: RangeFacts): string => tokens(f.usage)

  const out: Kpi[] = [
    todayKpi(ctx, delta),
    {
      key: 'usage',
      label: t('Usage'),
      value: tokens(cur.usage),
      provenance: 'measured',
      delta: prev ? delta(cur.usage, prev.usage) : { glyph: '', text: t('new') },
      polarity: 'upBad',
      spark: usageSpark,
      note: howUsage(),
      explain: explainOf(t('All tokens the selected range processed'), howUsage(), 'measured', usageText),
    },
    {
      key: 'requests',
      label: t('Requests'),
      value: tokens(cur.requests),
      provenance: 'measured',
      delta: prev ? delta(cur.requests, prev.requests) : { glyph: '', text: t('new') },
      polarity: 'upBad',
      spark: reqSpark,
      note: t('a Codex token_count event is not necessarily one turn'),
      explain: explainOf(
        t('API requests the transcripts recorded'),
        t('one per assistant turn; a Codex token_count event is not necessarily one turn'),
        'measured',
        (f) => tokens(f.requests),
      ),
    },
    {
      key: 'cacheHit',
      label: t('Cache hit'),
      value: percentOf(cur.hit.num, cur.hit.den),
      provenance: 'derived',
      delta: hitRate === null ? null : prevHit === null ? { glyph: '', text: t('new') } : delta(hitRate, prevHit),
      polarity: 'upGood',
      spark: seriesOf(ctx, sparkDays, 'cacheRead'),
      note: t('cache reads ÷ input'),
      explain: explainOf(
        t('Share of input served from the prompt cache'),
        // The denominator is each provider's own, exactly as `cacheHitParts` computes it:
        // one formula for both would be wrong for one of them.
        t('cache reads ÷ all input — Claude counts cache reads beside fresh input, Codex reports them inside its input'),
        'derived',
        (f) => percentOf(f.hit.num, f.hit.den),
      ),
    },
    {
      key: 'activeDays',
      label: t('Active days'),
      value: len > 0 ? t('{0} of {1}', cur.activeDays, len) : '–',
      provenance: 'measured',
      delta: prev ? delta(cur.activeDays, prev.activeDays) : { glyph: '', text: t('new') },
      // Working on more days is neither good nor bad; it is a habit, not a budget.
      polarity: 'neutral',
      spark: usageSpark.map((v) => (v > 0 ? 1 : 0)),
      note: null,
      explain: explainOf(
        t('Days with any usage in the range'),
        t('days whose usage is above zero'),
        'measured',
        (f) => (len > 0 ? t('{0} of {1}', f.activeDays, len) : '–'),
      ),
    },
    {
      key: 'avgPerActiveDay',
      label: t('Avg per active day'),
      value: avg === null ? '–' : compact(avg),
      provenance: 'derived',
      delta: avg === null ? null : prevAvg === null ? { glyph: '', text: t('new') } : delta(avg, prevAvg),
      // A quotient of two figures that each have their own direction: a rise can be less
      // usage on fewer days. Colouring it would name a winner that the number does not.
      polarity: 'neutral',
      spark: usageSpark,
      note: null,
      explain: explainOf(
        t('Usage per day, counting only active days'),
        t('usage ÷ active days'),
        'derived',
        (f) => (f.activeDays > 0 ? compact(f.usage / f.activeDays) : '–'),
      ),
    },
  ]
  if (ctx.showCost) {
    out.splice(2, 0, {
      key: 'cost',
      label: t('API equivalent'),
      value: costText(cur.cost),
      provenance: 'estimated',
      delta: prev ? delta(cur.cost, prev.cost) : { glyph: '', text: t('new') },
      polarity: 'upBad',
      spark: costSpark,
      note: t('hypothetical: what this usage would have cost through the API'),
      explain: explainOf(
        // 1.11 C3 (Review 2 F2): while custom rates apply the explanation says so — "list prices" would be false.
        isCustomPricing(ctx.pricing)
          ? t('What the same tokens would have cost through the API at your configured rates')
          : t('What the same tokens would have cost through the API at list prices'),
        t('tokens × the price table in effect, per model'),
        'estimated',
        (f) => costText(f.cost),
      ),
    })
  }
  return out
}

/**
 * Today, whatever range is selected — with its hypothetical cost beside it when costs are
 * shown, because those are the two numbers people check first.
 *
 * Absence stays absence: a day with nothing in it is a dash, and with no usage on either day
 * there is no change to report rather than a "±0%" about two measurements nobody took.
 */
function todayKpi(
  ctx: StatsCtx,
  delta: (c: number, p: number | null) => ReturnType<typeof deltaBadge>,
): Kpi {
  const today = dayOf(ctx.now, ctx.tcfg)
  const yesterday = addDays(today, -1)
  const cur = factsFor(ctx, today, today)
  const prev = factsFor(ctx, yesterday, yesterday)
  // Tokens and the amount in one string, so the previous day and the per-provider split are
  // printed exactly as the tile itself is.
  const both = (f: RangeFacts): string => {
    const cost = ctx.showCost ? costText(f.cost) : '–'
    return tokens(f.usage) + (ctx.showCost && cost !== '–' ? ` · ${cost}` : '')
  }
  return {
    key: 'today',
    label: t('Today'),
    value: both(cur),
    provenance: 'measured',
    delta: cur.usage === 0 && prev.usage === 0 ? null : delta(cur.usage, prev.usage),
    polarity: 'upBad',
    spark: seriesOf(ctx, lastDaysEndingAt(today, SPARK_POINTS), 'usage'),
    note: t('since the day boundary · against yesterday'),
    explain: {
      // "both providers" only while both are in the filter: with one switched off the tile
      // counts one account, and saying otherwise would be the invention this file forbids.
      what: t('Tokens processed since the day boundary, {0}', sourcesText(ctx)),
      how: howUsage(),
      period: t('since the day boundary · {0}', today),
      // The one card whose comparison exists whatever range is selected — and the only
      // comparison that makes "today" mean anything.
      compare: { against: t('yesterday'), previous: both(prev) },
      split: splitWith(splitFactsFor(ctx, today, today), both),
      provenance: provenanceText('measured'),
      sparkNote: sparkNote(),
    },
  }
}

// ---------------------------------------------------------------------------
// Composition and cache economy
// ---------------------------------------------------------------------------

export function composition(ctx: StatsCtx, range: DayRange): CompositionEntry[] {
  const out: CompositionEntry[] = []
  for (const source of ctx.sources) {
    const b = ctx.agg.sum(range.from, range.to, ctx.tcfg, filterFor(ctx, source))
    const parts: CompositionPart[] = [
      { key: 'freshInput', tokens: freshInput({ ...b, source }), text: t('Fresh input') },
      { key: 'cacheWrite5m', tokens: Math.max(0, b.cacheWrite - b.cacheWrite1h), text: t('Cache write 5m') },
      { key: 'cacheWrite1h', tokens: b.cacheWrite1h, text: t('Cache write 1h') },
      { key: 'cacheRead', tokens: b.cacheRead, text: t('Cache read') },
      { key: 'output', tokens: b.output, text: t('Output') },
      { key: 'reasoning', tokens: b.reasoning, text: t('Reasoning (of output)') },
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
        ? t('counterfactual: cache reads at the input rate, minus what the writes cost')
        : t('counterfactual: cache reads at the input rate (Codex bills no cache write)'),
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
  const thisMonth = periodRow(ctx, t('This month'), monthFrom, today)
  const projected = projectMonth(ctx, monthFrom, today)
  return {
    thisWeek: periodRow(ctx, t('This week'), weekFrom, today),
    thisMonth: { ...thisMonth, ...projected },
    lastMonth: periodRow(ctx, t('Last month'), `${lastMonthEnd.slice(0, 8)}01`, lastMonthEnd),
    year: periodRow(ctx, t('This year'), `${today.slice(0, 4)}-01-01`, today),
  }
}

/** Which figure a projection extrapolates. Tokens are counted, money is hypothetical. */
export type ProjectionMetric = 'cost' | 'usage'

export interface Projection {
  /** The projected total, already formatted and marked as an estimate — or null. */
  projection: string | null
  /** How it was derived, so the number can be checked rather than believed. */
  projectionBasis: string | null
  /** The same total as a number, for a caller that has to compare it against a limit. */
  total: number | null
  /** Average per elapsed day, the slope the projection runs on. */
  perDay: number | null
  /** Days after `today` up to and including `last`. */
  remaining: number
}

const NO_PROJECTION: Projection = {
  projection: null, projectionBasis: null, total: null, perDay: null, remaining: 0,
}

/**
 * End-of-period projection with its derivation spelled out.
 *
 * The average is per elapsed day, not per active day: a period is projected over its
 * calendar, and dividing by active days only would project a rate nobody keeps up. Below
 * five active days the projection stays silent rather than extrapolating from a weekend.
 *
 * One implementation for the month card and for a budget row — two projections of the same
 * usage that disagreed by a rule would be two different answers to one question. The cost
 * variant follows `showCost`, because a projected bill is still a bill; a token projection
 * does not, because tokens are shown either way.
 */
export function projectPeriod(
  ctx: StatsCtx,
  from: string,
  today: string,
  last: string,
  metric: ProjectionMetric = 'cost',
): Projection {
  if (metric === 'cost' && !ctx.showCost) return NO_PROJECTION
  const f = factsFor(ctx, from, today)
  if (f.activeDays < MIN_PROJECTION_DAYS) return NO_PROJECTION
  const elapsed = dayCount(from, today)
  if (elapsed <= 0) return NO_PROJECTION
  const remaining = dayCount(today, last) - 1
  if (remaining <= 0) return NO_PROJECTION
  const soFar = metric === 'cost' ? f.cost : f.usage
  const perDay = soFar / elapsed
  const total = soFar + perDay * remaining
  const text = (n: number): string => (metric === 'cost' ? usd(n) : compact(n))
  return {
    projection: metric === 'cost' ? costText(total) : estimate(compact(total)),
    projectionBasis: t('so far {0} · Avg {1}/day · {2} days left', text(soFar), text(perDay), remaining),
    total,
    perDay,
    remaining,
  }
}

/** The month card's projection: the general rule, with the month's last day filled in. */
function projectMonth(
  ctx: StatsCtx,
  from: string,
  today: string,
): { projection: string | null; projectionBasis: string | null } {
  const p = projectPeriod(ctx, from, today, monthLast(from.slice(0, 7)))
  return { projection: p.projection, projectionBasis: p.projectionBasis }
}

/**
 * The stated plan price, always to the cent.
 *
 * `usd` drops the cents from $100 up, which would print the same contract as "$200" here and
 * "$20.00" for the smaller plan one line below. A plan price is a figure the user typed, so it
 * is echoed back exactly as typed. This rule is for the plan price only: the month's cost goes
 * through `usd` like every other cost in the view, or the same month would read "so far $1,235"
 * on one line and "~$1,234.50" on the next.
 */
function planUsd(n: number): string {
  if (n > 0 && n < 0.01) return '<$0.01'
  return `$${n.toLocaleString(locale(), { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

/**
 * The plan factor. Two decimals below 0.1, one from 0.1 up: "×0.4" is precise enough to act
 * on, while a single decimal turns every light month into "×0.0" — a zero the user never
 * spent. Below a hundredth the factor is stated as a bound for the same reason.
 */
function factorText(f: number): string {
  if (!Number.isFinite(f) || f <= 0) return '×0'
  // 1.10 B4: the factor and its bound in the reader's decimal mark ("×0,4", "<×0,01" in German).
  if (f < 0.01) return `<×${decimalText(0.01, 2)}`
  return `×${decimalText(f, f < 0.1 ? 2 : 1)}`
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
        ? t('{0} API equivalent this month ÷ {1} plan = {2}',
          estimate(usd(c.usd)), planUsd(plan), factorText(factor))
        : t('no priced usage this month against the {0} plan', planUsd(plan)),
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

/**
 * "1.4 s" / "2 min 05 s" — turn gaps span three orders of magnitude. Exported for the agent
 * tree, whose durations sit beside the Sessions table's and must read the same way.
 *
 * Each form rounds to the unit it prints first and splits the rounded figure after, so a
 * rounding carries into the unit above: 1 199 600 ms is "20 min 00 s", never "19 min 60 s",
 * and 999.6 ms is "1.0 s", never "1000 ms". A figure that rounds up to the next form's
 * threshold is written in that form.
 */
export function durationText(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '–'
  const r = Math.round(ms)
  if (r < 1000) return `${r} ms`
  // Tenths of a second, rounded once: 59 950 ms is 60.0 s, and so a minute.
  const tenths = Math.round(ms / 100) / 10
  // In the page's own digits, like every other figure: "48,0 s" on a German page, not "48.0 s".
  if (tenths < 60) {
    return `${tenths.toLocaleString(locale(), { minimumFractionDigits: 1, maximumFractionDigits: 1 })} s`
  }
  const S = Math.round(ms / 1000)
  const m = Math.floor(S / 60)
  if (m < 60) return `${m} min ${String(S % 60).padStart(2, '0')} s`
  const M = Math.round(ms / 60_000)
  return `${Math.floor(M / 60)} h ${String(M % 60).padStart(2, '0')} min`
}

/** Why a group carries no cost — the Price column says which of the two it is. */
function unpricedText(reason: 'no price' | 'fast rate unknown' | null): string {
  return reason === 'fast rate unknown'
    ? t('fast rate unknown — no rate on file for this tier')
    : t('no price on file')
}

function priceTextFor(model: string, day: string, ctx: StatsCtx): { priced: ModelRow['priced']; text: string } {
  const p = priceOf(model, day, ctx.pricing)
  if (!p) return { priced: 'none', text: t('no price on file') }
  const rates = t('{0} / {1} per 1M', usd(p.price.input), usd(p.price.output))
  if (p.confidence === 'custom') return { priced: 'custom', text: t('{0}, your configured rates', rates) }
  if (p.confidence === 'family') {
    return { priced: 'family', text: t('{0}, borrowed from {1}', rates, p.family ?? t('a related model')) }
  }
  // 1.8 P5: a row read after the table's check (Claude Opus 5.5, OPUS_5_5_CHECKED) names its own day.
  const asOf = p.rule && p.rule.from > PRICES_AS_OF ? p.rule.from : PRICES_AS_OF
  return { priced: 'exact', text: t('{0}, list as of {1}', rates, asOf) }
}

/**
 * The number a numeric column sorts on. Every one of them is the raw count, not the cell:
 * two rows whose usage both print as "1.2M" are still two different numbers.
 *
 * `share` is deliberately the usage: inside one table the share is the usage divided by the
 * same total, so the two columns are one order under two names — deriving a percentage back
 * out of its own label to sort it would only add rounding.
 */
const MODEL_SORT_VALUE: Record<Exclude<ModelSortKey, 'model' | 'cacheHit'>, (r: ModelRow) => number> = {
  usage: (r) => r.usage,
  freshInput: (r) => r.freshInputN,
  cacheWrite5m: (r) => r.cacheWrite5mN,
  cacheWrite1h: (r) => r.cacheWrite1hN,
  cacheRead: (r) => r.cacheReadN,
  output: (r) => r.outputN,
  reasoning: (r) => r.reasoningN,
  requests: (r) => r.requestsN,
  perRequest: (r) => r.perRequestN,
  cost: (r) => r.cost,
  share: (r) => r.usage,
}

function sortRows(rows: ModelRow[], sort: ModelSort): ModelRow[] {
  const dir = sort.dir === 'asc' ? 1 : -1
  const key = sort.key
  return [...rows].sort((a, b) => {
    let d = 0
    if (key === 'model') d = a.model.localeCompare(b.model)
    else if (key === 'cacheHit') d = a.cacheHitN - b.cacheHitN
    else d = MODEL_SORT_VALUE[key](a) - MODEL_SORT_VALUE[key](b)
    // A stable tie-break keeps rows from swapping places on every one-second redraw.
    return d !== 0 ? d * dir : a.model.localeCompare(b.model)
  })
}

export function modelTable(
  ctx: StatsCtx,
  range: DayRange,
  sort: ModelSort,
  limit: number,
  showListPrice = false,
): { rows: ModelRow[]; total: number; hidden: number; sort: ModelSort } {
  const list = bucketsIn(ctx, range.from, range.to)
  // 1.14: the turn figures of the project filter's sessions, as the buckets are the filter's.
  const sessions = sessionsIn(ctx)
  const groups = new Map<string, {
    model: string; source: Source; isSub: boolean; tier: Tier
    usage: number; fresh: number; cacheWrite: number; cacheWrite1h: number; cacheRead: number
    output: number; reasoning: number; requests: number; cost: number; listUsd: number
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
        usage: 0, fresh: 0, cacheWrite: 0, cacheWrite1h: 0, cacheRead: 0,
        output: 0, reasoning: 0, requests: 0, cost: 0, listUsd: 0,
        hit: { num: 0, den: 0 }, unpriced: false, unpricedReason: null,
      }
      groups.set(key, g)
    }
    g.usage += billable(b)
    // The write halves are kept apart and subtracted once at the end, exactly as `totalRow`
    // does it, so the two tables cannot round the same tokens two ways.
    g.fresh += freshInput(b)
    g.cacheWrite += b.cacheWrite
    g.cacheWrite1h += b.cacheWrite1h
    g.cacheRead += b.cacheRead
    g.output += b.output
    g.reasoning += b.reasoning
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
    const write5m = Math.max(0, g.cacheWrite - g.cacheWrite1h)
    return {
      model: g.model,
      source: g.source,
      isSub: g.isSub,
      tier: g.tier,
      usage: g.usage,
      usageText: tokens(g.usage),
      freshInput: tokens(g.fresh),
      cacheWrite5m: tokens(write5m),
      cacheWrite1h: tokens(g.cacheWrite1h),
      cacheRead: tokens(g.cacheRead),
      output: tokens(g.output),
      reasoning: tokens(g.reasoning),
      requests: tokens(g.requests),
      perRequest: g.requests > 0 ? compact(g.usage / g.requests) : '–',
      freshInputN: g.fresh,
      cacheWrite5mN: write5m,
      cacheWrite1hN: g.cacheWrite1h,
      cacheReadN: g.cacheRead,
      outputN: g.output,
      reasoningN: g.reasoning,
      requestsN: g.requests,
      // Zero, not a dash's stand-in: a model with no request sorts below one that has any.
      perRequestN: g.requests > 0 ? g.usage / g.requests : 0,
      cost: g.cost,
      costText: ctx.showCost ? costText(g.cost) : '–',
      listCost: ctx.showCost && showListPrice && g.listUsd > 0 ? costText(g.listUsd) : null,
      cacheHit: percentOf(g.hit.num, g.hit.den),
      // The value the cell was formatted from, not the cell: reading a number back out of a
      // rounded label means parsing digit grouping, and that grouping is the reader's — a
      // German page writes "1.234,5" where an English one writes "1,234.5". A row with no
      // denominator sorts as "no value", below zero, exactly as its dash reads.
      cacheHitN: g.hit.den > 0 ? g.hit.num / g.hit.den : -1,
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

/**
 * One bucket's contribution to a chart metric — the same reading `Aggregator.series` takes,
 * so a chart built from grouped buckets and a series asked of the aggregator cannot disagree.
 * An unpriced bucket contributes no cost rather than a guess.
 */
function metricOfBucket(b: Bucket, metric: Metric, ctx: StatsCtx): number {
  switch (metric) {
    case 'output': return b.output
    case 'cacheRead': return b.cacheRead
    case 'requests': return b.requests
    case 'reasoning': return b.reasoning
    case 'cost': {
      const c = costOfBucketOn(b, ctx)
      return c && !c.unpriced ? c.usd : 0
    }
    default: return billable(b)
  }
}

/** The ranks a provider's named bands can take, largest model first; the rest is the fold. */
const MODEL_RANKS: readonly ChartRank[] = [0, 1, 2, 3, 4]

/**
 * Beyond this many bands per provider a stack is a rainbow nobody can read against a legend,
 * so the rest of that provider's models is folded into one band named 'other' — folded,
 * never dropped: the column total must not change with the way the column is split.
 */
export const CHART_MODEL_SERIES_PER_PROVIDER = MODEL_RANKS.length

/**
 * The bands of a column: one per (provider, model), a model used under both providers giving
 * two. Built from the very buckets the totals count — the names come from `bucketsIn` over
 * the same range and the same filter — so a provider's bands are a split of that provider's
 * own series rather than a second measurement of it. Providers come in registry order, Claude
 * before Codex, each with its largest model first and its fold last: the legend reads in the
 * order the ranks were handed out, and the provider switch — one provider, then All again —
 * cannot reorder it.
 */
function modelSeries(ctx: StatsCtx, days: string[], metric: Metric): ChartSeries[] {
  if (days.length === 0) return []
  const out: ChartSeries[] = []
  const at = new Map(days.map((d, i) => [d, i]))
  for (const source of SOURCES) {
    if (!ctx.sources.includes(source)) continue
    // One grouped pass, the way `modelTable` groups the same buckets: a series per model
    // asked of the aggregator would walk the whole table once per model, and a busy month
    // has a dozen models and ten thousand buckets.
    const byModel = new Map<string, number[]>()
    for (const b of bucketsIn(ctx, days[0], days[days.length - 1], source)) {
      const i = at.get(dayOfBucket(b, ctx.tcfg))
      if (i === undefined) continue
      let values = byModel.get(b.model)
      if (!values) {
        values = new Array<number>(days.length).fill(0)
        byModel.set(b.model, values)
      }
      values[i] += metricOfBucket(b, metric, ctx)
    }
    const built: { model: string; values: number[]; total: number }[] = []
    for (const [model, values] of byModel) {
      const total = values.reduce((a, b) => a + b, 0)
      // A model with buckets in range but nothing in this metric — reasoning tokens a model
      // never emits — would be a swatch in the legend and no band in the chart.
      if (total <= 0) continue
      built.push({ model, values, total })
    }
    // The name breaks a tie, so two equal models do not swap places on every redraw.
    built.sort((a, b) => b.total - a.total || a.model.localeCompare(b.model))
    built.slice(0, CHART_MODEL_SERIES_PER_PROVIDER).forEach((b, i) => {
      out.push({ key: `${source}:${b.model}`, label: b.model, source, rank: MODEL_RANKS[i], values: b.values })
    })
    const rest = built.slice(CHART_MODEL_SERIES_PER_PROVIDER)
    if (rest.length > 0) {
      const other = new Array<number>(days.length).fill(0)
      for (const r of rest) for (let i = 0; i < other.length; i++) other[i] += r.values[i]
      out.push({ key: `${source}:other`, label: t('other'), source, rank: 'other', values: other })
    }
  }
  return out
}

/**
 * 1.6 O2: the bands of a column split by main session and subagent — two per provider at most,
 * from the `isSub` dimension of the very buckets the model split groups: a bucket written by a
 * subagent transcript (Claude Code's `subagents/`, a Codex fork) is the subagents' band, every
 * other bucket the main sessions'. Nothing is estimated and nothing re-measured, so the two bands
 * of a provider sum to exactly what its model bands sum to, day by day and in every metric. A
 * part that counted nothing in the range is no band, as a model that counted nothing is none.
 * The ranks are fixed — the main sessions 0, the subagents 1 — so a band keeps its paint
 * whichever of the two is the larger, and the labels name the provider, since the legend of the
 * split has no provider headings to stand under.
 */
function agentSeries(ctx: StatsCtx, days: string[], metric: Metric): ChartSeries[] {
  if (days.length === 0) return []
  const out: ChartSeries[] = []
  const at = new Map(days.map((d, i) => [d, i]))
  const total = (values: number[]): number => values.reduce((a, b) => a + b, 0)
  for (const source of SOURCES) {
    if (!ctx.sources.includes(source)) continue
    const main = new Array<number>(days.length).fill(0)
    const sub = new Array<number>(days.length).fill(0)
    for (const b of bucketsIn(ctx, days[0], days[days.length - 1], source)) {
      const i = at.get(dayOfBucket(b, ctx.tcfg))
      if (i === undefined) continue
      ;(b.isSub ? sub : main)[i] += metricOfBucket(b, metric, ctx)
    }
    const name = SOURCE_TITLE[source]
    if (total(main) > 0) out.push({ key: `${source}:main`, label: t('{0} · main sessions', name), source, rank: 0, values: main })
    if (total(sub) > 0) out.push({ key: `${source}:sub`, label: t('{0} · subagents', name), source, rank: 1, values: sub })
  }
  return out
}

export function chart(
  ctx: StatsCtx,
  range: DayRange,
  metric: Metric,
  modelStyle: ChartModelStyle = 'pattern',
  split: ChartSplit = 'model',
): ChartData {
  const days = daysBetween(range.from, range.to)
  const weekly = days.length > WEEKLY_CHART_DAYS
  // Anything but the one other word is the split by model: a view state from anywhere draws a chart.
  const by: ChartSplit = split === 'agents' ? 'agents' : 'model'
  const bands = by === 'agents' ? agentSeries(ctx, days, metric) : modelSeries(ctx, days, metric)
  const costDaily = ctx.showCost && metric !== 'cost'
    ? seriesOf(ctx, days, 'cost')
    : null

  let labels = days.map((d) => d.slice(5))
  let outDays = days
  let series = bands
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
    series = bands.map((s) => ({
      ...s,
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
    modelStyle,
    split: by,
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
        ? t('outside coverage')
        : value > 0
          // A date and a figure with a colon between them: no word to translate.
          ? `${day}: ${metric === 'cost' ? costText(value) : compact(value)}`
          : t('{0}: no usage', day),
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
      // 1.10 B4: two decimals in the reader's decimal mark — a sentence of the view, not a machine figure.
      cv: mean > 0 ? decimalText(sd / mean, 2) : '–',
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

/**
 * Whether the per-session tables may be filled.
 *
 * The setting decides when the caller states it. Without it the session table answers for
 * itself: the aggregator only ever writes session records while attribution is on, so an
 * empty table and a switched-off setting are the same world.
 */
function attributionOn(ctx: StatsCtx): boolean {
  if (ctx.attribution !== undefined) return ctx.attribution !== 'none'
  return ctx.agg.sessions().length > 0
}

/** Sorts by usage, then by label — a stable order, so two equal rows do not swap on redraw. */
function byUsageThenLabel(a: { usage: number; label: string }, b: { usage: number; label: string }): number {
  return b.usage - a.usage || a.label.localeCompare(b.label)
}

function topOf(
  list: { label: string; detail: string | null; usage: number; cost: string }[],
  total: number,
  cap: number,
): RecordEntry[] {
  return [...list]
    .sort(byUsageThenLabel)
    .slice(0, cap)
    .map((e) => ({
      label: e.label,
      detail: e.detail,
      usage: tokens(e.usage),
      share: percentOf(e.usage, total),
      cost: e.cost,
    }))
}

/**
 * The records of a range: its busiest day, its longest run, and who did the work.
 *
 * Month buckets are left out of every figure here. A rolled-up month has no day left in it,
 * and placing it on the first of the month would hand the records a peak day nobody worked
 * and a streak nobody kept — the same reason the hour profile leaves rolled-up buckets out.
 * How many were dropped is stated rather than hidden.
 *
 * The streak is the longest run of *consecutive days with usage inside this range*, and a
 * day before coverage began takes no part at all rather than counting as a zero: not having
 * watched a day is not the same as having watched an idle one. That is the heatmap's rule,
 * and it shapes the two day records only — the top tables count every bucket in the range,
 * because a bucket is evidence of usage wherever it lies.
 *
 * 1.11 B: four more tables — the most expensive days (B1), the longest and the largest Claude Code
 * sessions (B2), the hours with the most cache written (B3) — each at most `topN` rows (B5). All of
 * it is computed here, at each build, from what the aggregator holds, and nothing of it is stored: a
 * rescan that reads fewer transcripts shows fewer records, never an old one. While the host is still
 * reading the transcripts (`settled` false, B4) no record is shown at all — a peak day read from a
 * half-read history is as false as a longest session read from a half-replayed index. `words` carries
 * the Agents tree's own names for a session (see `RecordsWords`).
 */
export function records(
  ctx: StatsCtx,
  range: DayRange,
  topN: number,
  firstDay?: string | null,
  settled = true,
  words?: RecordsWords,
): RecordsData {
  if (!settled) {
    return {
      peakDay: null, streak: null, topModels: [], topProjects: [], topSessions: [],
      // A fact about the setting, not a record: the page still knows why the two tables would be empty.
      attributionOn: attributionOn(ctx),
      note: null, sessionNote: null,
      costDays: [], longestSessions: [], largestSessions: [], cacheHours: [],
      reading: t('Reading history…'),
      recordNotes: [],
    }
  }
  const today = dayOf(ctx.now, ctx.tcfg)
  // Stated coverage wins; otherwise the first ingest is the only start we know. Null means
  // "no coverage known", and then every day up to today counts as watched — claiming a day
  // was unwatched without a date for it would be an invention of its own.
  const coverage = firstDay !== undefined
    ? firstDay
    : ctx.agg.firstIngest !== null ? dayOf(ctx.agg.firstIngest, ctx.tcfg) : null

  const usageByDay = new Map<string, number>()
  const costByDay = new Map<string, number>()
  /** Days holding at least one bucket of a model with no price: their cost is a floor. */
  const unpricedDay = new Set<string>()
  const models = new Map<string, { label: string; detail: string | null; usage: number; cost: number; unpriced: boolean }>()
  /** 1.11 B3: the range's hour buckets that wrote to the cache, by their UTC hour. */
  const cacheHourAcc = new Map<number, CacheHourAcc>()
  const on = attributionOn(ctx)
  /**
   * 1.14 §3 A4 rule 4: with attribution on, the range's buckets by project — usage and the priced cost by the models'
   * rule below (a bucket without a price makes the group's cost a dash). No longer the sessions' lifetime sums.
   */
  const projectGroups = new Map<string, { usage: number; cost: number; unpriced: boolean }>()
  let totalUsage = 0
  let excluded = 0
  for (const b of bucketsIn(ctx, range.from, range.to)) {
    if (b.res === 'm') {
      excluded++
      continue
    }
    // Only an hour bucket has an hour: a day bucket's writes take no part in the hours (B3 rule 1).
    if (b.res === 'h' && b.cacheWrite > 0 && typeof b.hour === 'number' && Number.isFinite(b.hour)) {
      addCacheHour(cacheHourAcc, b, ctx)
    }
    const day = dayOfBucket(b, ctx.tcfg)
    const use = billable(b)
    usageByDay.set(day, (usageByDay.get(day) ?? 0) + use)
    totalUsage += use
    const c = costOfBucketOn(b, ctx)
    const priced = c && !c.unpriced ? c.usd : 0
    if (priced > 0) costByDay.set(day, (costByDay.get(day) ?? 0) + priced)
    // Same rule as the model groups below: no price on file counts as unpriced too, so the
    // day's total is missing part of itself. A bucket with nothing in it is missing nothing.
    if (allTokens(b) > 0 && !(c && !c.unpriced)) unpricedDay.add(day)
    const key = `${b.source}|${b.model}`
    let g = models.get(key)
    if (!g) {
      g = { label: b.model, detail: SOURCE_TITLE[b.source], usage: 0, cost: 0, unpriced: false }
      models.set(key, g)
    }
    g.usage += use
    if (c && !c.unpriced) g.cost += c.usd
    else g.unpriced = true
    if (on) {
      const key = b.project ?? UNATTRIBUTED
      let p = projectGroups.get(key)
      if (!p) {
        p = { usage: 0, cost: 0, unpriced: false }
        projectGroups.set(key, p)
      }
      p.usage += use
      if (c && !c.unpriced) p.cost += c.usd
      else p.unpriced = true
    }
  }

  let peakDay: RecordsData['peakDay'] = null
  let peakValue = 0
  let streak: RecordsData['streak'] = null
  let run = 0
  let runFrom = ''
  for (const day of daysBetween(range.from, range.to)) {
    // Same coverage rule as the heatmap: an unwatched day is neither a zero nor a break.
    if (day > today || (coverage !== null && day < coverage)) continue
    const value = usageByDay.get(day) ?? 0
    if (value <= 0) {
      run = 0
      continue
    }
    if (run === 0) runFrom = day
    run++
    if (streak === null || run > streak.days) streak = { days: run, from: runFrom, to: day }
    if (value > peakValue) {
      peakValue = value
      const c = costByDay.get(day) ?? 0
      const shown = ctx.showCost && c > 0
      peakDay = {
        day,
        usage: tokens(value),
        cost: shown ? costText(c) : '–',
        // A dash already says "no cost known"; the flag only qualifies a figure that is shown.
        costPartial: shown && unpricedDay.has(day),
      }
    }
  }

  // An unusable topN caps nothing rather than emptying the tables.
  const cap = (all: number): number => (Number.isFinite(topN) && topN > 0 ? Math.floor(topN) : all)
  const topModels = topOf(
    [...models.values()].map((g) => ({
      label: g.label,
      detail: g.detail,
      usage: g.usage,
      // A group with an unpriced bucket in it would print a total that is missing part of
      // itself; a lower bound is not a cost, so it stays a dash.
      cost: ctx.showCost && !g.unpriced ? costText(g.cost) : '–',
    })),
    totalUsage,
    cap(models.size),
  )

  const sessions: { label: string; detail: string | null; usage: number; cost: string }[] = []
  let sessionTotal = 0
  // 1.14 §3 A1 rule 4: a project by its label — its folder's name only under basename.
  const labels: Readonly<Record<string, ProjectLabel>> = on ? ctx.agg.projects() : {}
  const names = ctx.projectNames === true
  if (on) {
    const filter = ctx.models.length > 0 ? new Set(ctx.models) : null
    const inFilter = projectSet(ctx)
    for (const rec of ctx.agg.sessions()) {
      if (!ctx.sources.includes(rec.source)) continue
      if (filter && !rec.models.some((m) => filter.has(m))) continue
      // 1.14 §3 A4 rule 4: the sessions of the project filter.
      if (!inProjects(inFilter, rec.project)) continue
      // A session is in the range when it was running in it. Its counters are lifetime
      // counters — a session record keeps no per-hour slice — so the row is stated as a
      // lifetime total rather than sliced into a number nobody measured.
      if (dayOf(rec.lastTs, ctx.tcfg) < range.from || dayOf(rec.firstTs, ctx.tcfg) > range.to) continue
      const use = billable(emptySession(rec))
      if (use <= 0) continue
      // No per-day model split on a session record, so a per-session cost would be a guess.
      sessions.push({ label: rec.sessionId, detail: projectLabel(rec.project, labels, names), usage: use, cost: '–' })
      sessionTotal += use
    }
  }

  const note = excluded === 0
    ? null
    : excluded === 1
      ? t('1 rolled-up month bucket in this range has no day left and is not in these records')
      : t('{0} rolled-up month buckets in this range have no day left and are not in these records', excluded)
  return {
    peakDay,
    streak,
    topModels,
    // 1.14 §3 A4 rule 4: the projects are the range's buckets, as the models are — their shares of the same total,
    // their cost priced by the same rule; the Projects table has their sessions.
    topProjects: topOf(
      [...projectGroups.entries()].map(([key, g]) => ({
        label: projectLabel(key, labels, names),
        detail: null,
        usage: g.usage,
        cost: ctx.showCost && !g.unpriced ? costText(g.cost) : '–',
      })),
      totalUsage,
      cap(projectGroups.size),
    ),
    // The sessions' shares are shares of the listed sessions, never of the bucket total: session
    // counters run over a lifetime and bucket sums over the range, and dividing one by the
    // other would invent a percentage of two different things.
    topSessions: topOf(sessions, sessionTotal, cap(sessions.length)),
    attributionOn: on,
    note,
    sessionNote: sessions.length > 0
      ? t('sessions count each session’s whole lifetime, which can reach outside this range')
      : null,
    ...newRecords(ctx, range, cap, words, {
      watched: (day) => !(day > today || (coverage !== null && day < coverage)),
      coverage, today, usageByDay, costByDay, unpricedDay, cacheHourAcc,
    }),
  }
}

const MS_DAY = 86_400_000
/** 1.11 B3: the models a cache hour names before "+n more" — the tools table's two (TOOL_MODELS_SHOWN). */
const CACHE_HOUR_MODELS = 2

/** 1.11 B3: one UTC hour's cache writes as they are summed. */
interface CacheHourAcc {
  written: number
  written1h: number
  /** The priced part of the writes' cost. */
  usd: number
  /** A write of the hour has no price on file (none, or a fast rate unknown). */
  unpriced: boolean
  /** Tokens written per model. */
  models: Map<string, number>
}

/**
 * 1.11 B3 rule 3: the cost of an hour bucket's cache writes — the bucket with every other count taken
 * out, priced as every cost is (`costOfBucketOn`: the day's dated rule, the 5-minute and the 1-hour write
 * rates apart, the tier's surcharges, the multiplier). No rate of its own.
 */
function addCacheHour(acc: Map<number, CacheHourAcc>, b: Bucket, ctx: StatsCtx): void {
  const hour = b.hour as number
  let h = acc.get(hour)
  if (!h) {
    h = { written: 0, written1h: 0, usd: 0, unpriced: false, models: new Map() }
    acc.set(hour, h)
  }
  h.written += b.cacheWrite
  if (b.cacheWrite1h > 0) h.written1h += b.cacheWrite1h
  h.models.set(b.model, (h.models.get(b.model) ?? 0) + b.cacheWrite)
  const c = costOfBucketOn({ ...b, input: 0, cacheRead: 0, output: 0, reasoning: 0, webSearch: 0, webFetch: 0 }, ctx)
  if (c && !c.unpriced) h.usd += c.usd
  else h.unpriced = true
}

/** A time stamp: a finite number of milliseconds after the epoch. */
function isStamp(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0
}

/** Plain code-unit order: the same on every machine, whatever its locale. */
function byCodeUnits(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

/**
 * The billable usage of a main or an agent record — its counters in bucket shape, each finite and positive
 * or nothing (as the Agents tree reads them), through `billable`: the tree's definition, not a second one.
 */
function recordUsage(r: MainRec | AgentRec): number {
  const n = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0)
  return billable({
    ...emptyBucket('claude', '*', false, 'standard', 'd', null, ''),
    input: n(r.input), cacheWrite: n(r.cacheWrite), cacheWrite1h: n(r.cacheWrite1h), cacheRead: n(r.cacheRead),
    output: n(r.output), reasoning: n(r.reasoning), requests: n(r.requests), outputFinal: n(r.outputFinal),
  })
}

/** 1.11 B2: a session the Records may rank — its record, its span and its usage with its agents'. */
interface EndedSession {
  rec: MainRec
  span: number
  usage: number
}

/**
 * 1.11 B2 (§0a.2): the Claude Code sessions of the Agents section's index (`agg.mains()`, the records the
 * tree reads — never their paths) whose last counted line, and their agents' (the tree calls a session
 * active through them), is older than SESSION_ACTIVE_MS; and how many were left out for being active.
 * One record per session id, the newer by `lastTs` (as the tree takes one), within AGENT_RETENTION_DAYS
 * of its last line (as the tree keeps one); a record without a first and a last line, or whose first
 * comes after its last, is no session. It counts when its span touches the range's days (the
 * top-sessions rule) and, under the model chips, when one of its models is chosen. Its usage is its own
 * and its agents' — every agent of the session within the retention, one record per agent id, the newer
 * (as the tree counts them) — which the tree shows apart and the note says is a sum.
 */
function endedSessions(ctx: StatsCtx, range: DayRange): { ended: EndedSession[]; active: number } {
  const since = ctx.now - AGENT_RETENTION_DAYS * MS_DAY
  const byId = new Map<string, MainRec>()
  for (const m of ctx.agg.mains()) {
    if (!m || typeof m.sessionId !== 'string' || m.sessionId === '' || !isStamp(m.lastTs)) continue
    const have = byId.get(m.sessionId)
    if (!have || m.lastTs > have.lastTs) byId.set(m.sessionId, m)
  }
  const agentById = new Map<string, AgentRec>()
  for (const a of ctx.agg.agents()) {
    if (!a || typeof a.agentId !== 'string' || a.agentId === '' || typeof a.sessionId !== 'string') continue
    if (!isStamp(a.lastTs) || a.lastTs < since) continue
    const have = agentById.get(a.agentId)
    if (!have || a.lastTs > have.lastTs) agentById.set(a.agentId, a)
  }
  const agentUsage = new Map<string, number>()
  const agentLast = new Map<string, number>()
  for (const a of agentById.values()) {
    agentUsage.set(a.sessionId, (agentUsage.get(a.sessionId) ?? 0) + recordUsage(a))
    agentLast.set(a.sessionId, Math.max(agentLast.get(a.sessionId) ?? 0, a.lastTs))
  }

  const filter = ctx.models.length > 0 ? new Set(ctx.models) : null
  // 1.14 §3 A4 rule 4: under a project filter, the sessions of the chosen projects — an agent-table session has no key
  // of its own; its main transcript's session record has (a project filter exists only with attribution on, and the
  // records outlive the agent tables: hourRetentionDays against AGENT_RETENTION_DAYS). A session without a record is
  // in no project the filter names.
  const inFilter = projectSet(ctx)
  const projectOf = new Map<string, string>()
  if (inFilter !== null) {
    for (const s of ctx.agg.sessions()) {
      if (s.source === 'claude' && !s.isSub && !projectOf.has(s.sessionId)) projectOf.set(s.sessionId, s.project)
    }
  }
  const ended: EndedSession[] = []
  let active = 0
  for (const m of byId.values()) {
    if (m.lastTs < since || !isStamp(m.firstTs) || m.firstTs > m.lastTs) continue
    if (dayOf(m.lastTs, ctx.tcfg) < range.from || dayOf(m.firstTs, ctx.tcfg) > range.to) continue
    if (filter && !(Array.isArray(m.models) && m.models.some((x) => filter.has(x)))) continue
    if (!inProjects(inFilter, projectOf.get(m.sessionId))) continue
    // Its time and its tokens are still growing: ranked once it is idle (B2 rule 2) — its own transcript
    // and its agents' too, whose usage the row adds to its own.
    if (ctx.now - Math.max(m.lastTs, agentLast.get(m.sessionId) ?? 0) <= SESSION_ACTIVE_MS) {
      active++
      continue
    }
    ended.push({ rec: m, span: m.lastTs - m.firstTs, usage: recordUsage(m) + (agentUsage.get(m.sessionId) ?? 0) })
  }
  return { ended, active }
}

/**
 * 1.11 B1–B3 and their notes, from the day and hour sums `records()` has made. `watched` is the day
 * records' coverage rule: a day before coverage or after today is not a day anybody watched.
 */
function newRecords(
  ctx: StatsCtx,
  range: DayRange,
  cap: (all: number) => number,
  words: RecordsWords | undefined,
  sums: {
    watched: (day: string) => boolean
    coverage: string | null
    today: string
    usageByDay: Map<string, number>
    costByDay: Map<string, number>
    unpricedDay: Set<string>
    cacheHourAcc: Map<number, CacheHourAcc>
  },
): Pick<RecordsData, 'costDays' | 'longestSessions' | 'largestSessions' | 'cacheHours' | 'reading' | 'recordNotes'> {
  // B1: a day with no priced bucket is no record; with the costs switched off there is none.
  const days = ctx.showCost ? [...sums.costByDay.entries()].filter(([day, v]) => v > 0 && sums.watched(day)) : []
  const costDays: CostDayRecord[] = days
    .sort((a, b) => b[1] - a[1] || byCodeUnits(b[0], a[0]))
    .slice(0, cap(days.length))
    .map(([day, v]) => ({
      day,
      cost: costText(v),
      usage: tokens(sums.usageByDay.get(day) ?? 0),
      // The transcripts on disk begin that day: earlier sessions of it may be gone (B1 rule 3).
      floor: sums.unpricedDay.has(day) || day === sums.coverage,
    }))

  // B2: Claude Code's sessions, while the view shows Claude Code — each table by its own figure, a
  // session without one (no span, no usage) left out of that table; equal ones by the session id.
  const claude = ctx.sources.includes('claude')
  const { ended, active } = claude && words ? endedSessions(ctx, range) : { ended: [], active: 0 }
  const ranked = (by: (s: EndedSession) => number): SessionRecord[] => {
    if (words === undefined) return []
    const list = ended.filter((s) => by(s) > 0)
    return list
      .sort((a, b) => by(b) - by(a) || byCodeUnits(a.rec.sessionId, b.rec.sessionId))
      .slice(0, cap(list.length))
      .map((s) => ({
        sessionId: s.rec.sessionId,
        name: words.sessionName(s.rec.sessionId, s.rec.firstTs, ctx.now, ctx.tcfg),
        start: clockStamp(s.rec.firstTs, ctx.now, ctx.tcfg),
        time: words.spanText(s.span),
        usage: tokens(s.usage),
      }))
  }
  const longestSessions = ranked((s) => s.span)
  const largestSessions = ranked((s) => s.usage)

  // B3: the hours by the tokens written, equal ones the newer first.
  const hours = [...sums.cacheHourAcc.entries()]
  const cacheHours: CacheHourRecord[] = hours
    .sort((a, b) => b[1].written - a[1].written || b[0] - a[0])
    .slice(0, cap(hours.length))
    .map(([hour, h]) => {
      const at = hour * MS_HOUR
      const shown = ctx.showCost && h.usd > 0
      const writers = [...h.models.entries()].sort((x, y) => y[1] - x[1] || byCodeUnits(x[0], y[0])).map(([m]) => m)
      const rest = writers.length - CACHE_HOUR_MODELS
      return {
        // A clock reading names the hour: its calendar day, the day boundary left aside (calendarDayOf).
        hour: `${calendarDayOf(at, ctx.tcfg)} ${formatTime(at, ctx.tcfg)}`,
        written: tokens(h.written),
        written1h: tokens(h.written1h),
        cost: shown ? costText(h.usd) : '–',
        // A dash already says "no cost known"; the mark only qualifies a figure that is shown.
        floor: shown && h.unpriced,
        models: listOf(writers.slice(0, CACHE_HOUR_MODELS)) + (rest > 0 ? ` ${t('+{0} more', full(rest))}` : ''),
      }
    })

  const notes: string[] = []
  // Review 2 F4: the hours' ⚠ (an unpriced model in the hour) has the same legend — shown whenever a day or an hour is marked.
  if (costDays.some((d) => d.floor) || cacheHours.some((h) => h.floor)) {
    notes.push(t('⚠ = a lower bound: the day or the hour holds usage without a price on file, or the transcripts on disk begin that day.'))
  }
  if (longestSessions.length > 0 || largestSessions.length > 0) {
    notes.push(t("Claude Code sessions of the last {0} days that are no longer active — the Agents section keeps a session for {0} days after its last line. Time runs from its first counted line to its last, pauses included; usage is its own and its agents'.",
      full(AGENT_RETENTION_DAYS)))
  }
  if (active > 0) notes.push(t('{0} active session(s) not ranked yet: their time and tokens are still growing.', full(active)))
  notes.push(cacheHours.length > 0
    ? t("A large cache write is usually a cold start — a conversation's prefix written to the cache again after it expired —, a new conversation or a compaction; one hour can hold several.")
    : t('No cache write counted in this range.'))
  // Only where the range reaches back to the hours that are kept no longer (B3 rule 1).
  const kept = words ? Math.floor(words.hourRetentionDays) : NaN
  if (Number.isFinite(kept) && kept >= 0 && range.from <= addDays(sums.today, -kept)) {
    notes.push(t('Hour buckets are kept for {0} day(s) (tokenPace.hourRetentionDays); earlier hours are not ranked.', full(kept)))
  }
  if (!ctx.showCost) notes.push(t('The most expensive days need tokenPace.showCost.'))
  if (!claude && ctx.sources.length > 0) {
    notes.push(t('Claude Code only — not shown while {0} is selected.', listOf(ctx.sources.map((s) => SOURCE_TITLE[s] ?? s))))
  }
  return { costDays, longestSessions, largestSessions, cacheHours, reading: null, recordNotes: notes }
}

// ---------------------------------------------------------------------------
// Hour profile and weekday grid
// ---------------------------------------------------------------------------

/**
 * How much the weekday grid stands on, in the one sentence every view prints under it.
 *
 * The honest denominator is the days that actually carry usage, not the length of the range:
 * a 30-day range worked on four days is four days of evidence, and calling that "4 weeks"
 * would sell an observation as a habit. Those days are rounded up to whole weeks because a grid
 * row is a weekday — one Tuesday is one week's worth of Tuesday, whatever else the range
 * contains — and below three of them the sentence says outright what it is (1.12 D7: "a single
 * observation" and "observations" — "record" is only the Records section's personal best).
 */
function gridBasis(days: number): HoursData['basis'] {
  const weeks = Math.ceil(days / 7)
  if (days === 0) return { weeks: 0, days: 0, text: t('no day with usage in this range') }
  // Four whole sentences rather than one built from pieces: the qualifier is part of the
  // sentence, and singular and plural are not the same sentence in every language.
  const thin = weeks < GRID_HABIT_WEEKS
  const one = weeks === 1
  const text = thin
    ? (one
      ? t('based on {0} week — a single observation, not a habit', weeks)
      : t('based on {0} weeks — observations, not yet a habit', weeks))
    : (one ? t('based on {0} week', weeks) : t('based on {0} weeks', weeks))
  return { weeks, days, text }
}

/**
 * Time-of-day profile, built from hour buckets only.
 *
 * Rolled-up data has no hour left in it; padding the profile with day sums would invent a
 * distribution. The number of days behind the profile is stated so a two-day sample is not
 * mistaken for a habit, and rolled-up days that had to be left out are named.
 *
 * The weekday grid draws every cell a day of usage reached, however few days that is, and
 * hatches the ones no day reached; `basis` carries how thin the evidence is, in words. The
 * threshold this used to apply instead hid the whole grid for any range under three weeks —
 * a picture that is blank until week three teaches nothing about weeks one and two.
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
        // What was measured, from however many days there were. A cell no day ever touched
        // has no value at all — it is hatched, not drawn as a zero.
        value: samples > 0 ? (cellValue.get(key) ?? 0) : null,
        samples,
      })
    }
  }

  return {
    profile,
    peakHour,
    grid,
    basis: gridBasis(seenDays.size),
    weekdayLabels: weekdayLabels(ctx.tcfg),
    zone,
    days: seenDays.size,
    note: excluded > 0
      ? (excluded === 1
        ? t('{0} rolled-up bucket in this range has no hour left and is not in the profile', excluded)
        : t('{0} rolled-up buckets in this range have no hour left and are not in the profile', excluded))
      : null,
  }
}

// ---------------------------------------------------------------------------
// Local usage over an hour span
// ---------------------------------------------------------------------------

/**
 * Cost of the hour buckets inside a half-open hour range.
 *
 * `sumHours` merges across models, so the merged bucket has no model of its own to price;
 * the cost is summed from the individual buckets over exactly the same hours instead. The
 * unpriced flag travels with it: a span holding a model the price table does not know is a
 * partial amount, and the totals table marks it exactly as a day-bounded row does.
 */
function hourSpanCost(
  ctx: StatsCtx,
  source: Source,
  fromHour: number,
  toHour: number,
): { usd: number; listUsd: number; partial: boolean } {
  let usd = 0
  let listUsd = 0
  let partial = false
  const projects = projectSet(ctx)
  for (const one of ctx.buckets ?? ctx.agg.all()) {
    if (one.res !== 'h' || one.hour === null || one.source !== source) continue
    if (one.hour < fromHour || one.hour >= toHour) continue
    if (ctx.models.length > 0 && !ctx.models.includes(one.model)) continue
    if (!inProjects(projects, one.project)) continue
    const c = costOfBucketOn(one, ctx)
    if (!c || c.unpriced) {
      if (allTokens(one) > 0) partial = true
      continue
    }
    usd += c.usd
    listUsd += c.listUsd
  }
  return { usd, listUsd, partial }
}

function costOfHourSpan(ctx: StatsCtx, source: Source, fromHour: number, toHour: number): number {
  return hourSpanCost(ctx, source, fromHour, toHour).usd
}

/** The earliest hour bucket with billable tokens in a half-open hour range, or null. */
function firstUsedHour(ctx: StatsCtx, source: Source, fromHour: number, toHour: number): number | null {
  let first: number | null = null
  const projects = projectSet(ctx)
  for (const one of ctx.buckets ?? ctx.agg.all()) {
    if (one.res !== 'h' || one.hour === null || one.source !== source) continue
    if (one.hour < fromHour || one.hour >= toHour) continue
    if (ctx.models.length > 0 && !ctx.models.includes(one.model)) continue
    if (!inProjects(projects, one.project)) continue
    if (billable(one) <= 0) continue
    if (first === null || one.hour < first) first = one.hour
  }
  return first
}

/**
 * What we can say about the last few hours when the provider says nothing at all.
 *
 * This is a count of local tokens and nothing else. It has no denominator — no limit is
 * known for it, and none is guessed — so it carries no percentage, no bar, no pace and no
 * forecast. The shape is deliberately too poor to be mistaken for a quota window: a reader
 * who sees "84 %" beside a five-hour block will read it as the provider's, and that number
 * would be ours. `≈` appears exactly when part of the span is older than the hour buckets
 * still kept, the same rule the window rows use.
 */
export function localBlock(ctx: StatsCtx, source: Source, now: number = ctx.now): LocalBlockRow | null {
  if (!Number.isFinite(now)) return null
  const fromMs = now - LOCAL_BLOCK_HOURS * MS_HOUR
  const { bucket, complete } = sumHoursOf(ctx, fromMs, now, filterFor(ctx, source))
  const b = { ...bucket, source }
  const use = billable(b)
  // Nothing counted is nothing to say. An empty row would state a measured idle span, and
  // the buckets cannot tell an idle hour from an unread one.
  if (use <= 0 && b.requests <= 0) return null
  const fromHour = Math.floor(fromMs / MS_HOUR)
  const toHour = Math.ceil(now / MS_HOUR)
  const cost = costOfHourSpan(ctx, source, fromHour, toHour)
  const first = firstUsedHour(ctx, source, fromHour, toHour)
  const mark = (t: string): string => (complete || t === '–' ? t : `≈${t}`)
  const usage = mark(tokens(use))
  const firstAt = first === null ? null : formatTime(first * MS_HOUR, ctx.tcfg)
  return {
    source,
    hours: LOCAL_BLOCK_HOURS,
    usage,
    cost: ctx.showCost ? mark(costText(cost)) : '–',
    requests: mark(tokens(b.requests)),
    firstAt,
    complete,
    text: firstAt !== null
      ? t('Local estimate — {0} tokens in the last {1} h, first counted at {2}. Not the provider’s window; no limit is known.',
        usage, LOCAL_BLOCK_HOURS, firstAt)
      : t('Local estimate — {0} tokens in the last {1} h. Not the provider’s window; no limit is known.',
        usage, LOCAL_BLOCK_HOURS),
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

/**
 * 1.14 §3 A4 rule 3: the main session records (`isSub` false) per project key whose activity overlaps the range — under
 * the provider switch, the model chips (a session that used a chosen model) and the project filter. Exact while the range
 * starts after the day the records' horizon falls on: records whose last line is older than `hourRetentionDays` are
 * pruned at the roll-up and at most SESSION_CAP are kept, the newest (§3 A3 rule 3) — a range reaching that day or
 * earlier counts at least what it shows (`lowerBound`).
 */
function projectSessions(ctx: StatsCtx, range: DayRange): { counts: Map<string, number>; lowerBound: boolean } {
  const counts = new Map<string, number>()
  const models = ctx.models.length > 0 ? new Set(ctx.models) : null
  const inFilter = projectSet(ctx)
  const all = ctx.agg.sessions()
  let oldest = Infinity
  for (const s of all) {
    if (Number.isFinite(s.lastTs) && s.lastTs < oldest) oldest = s.lastTs
    if (s.isSub || !ctx.sources.includes(s.source)) continue
    if (models && !s.models.some((m) => models.has(m))) continue
    if (!inProjects(inFilter, s.project)) continue
    if (dayOf(s.lastTs, ctx.tcfg) < range.from || dayOf(s.firstTs, ctx.tcfg) > range.to) continue
    counts.set(s.project, (counts.get(s.project) ?? 0) + 1)
  }
  const kept = ctx.hourRetentionDays
  let horizon: number | null = typeof kept === 'number' && Number.isFinite(kept)
    ? ctx.now - Math.max(0, Math.floor(kept)) * MS_DAY
    : null
  // At the cap the records older than the oldest kept one may be gone too.
  if (all.length >= SESSION_CAP && Number.isFinite(oldest)) horizon = horizon === null ? oldest : Math.max(horizon, oldest)
  return { counts, lowerBound: horizon !== null && range.from <= dayOf(horizon, ctx.tcfg) }
}

/**
 * 1.14 §3 A4 rule 5: the project keys of the range's buckets under the context's filters, by usage (highest first, then
 * by key) — the filter row's chips (viewModel.ts, with a context without the project chips).
 */
export function projectUsage(ctx: StatsCtx, range: DayRange): Array<{ key: string; usage: number }> {
  const usage = new Map<string, number>()
  for (const b of bucketsIn(ctx, range.from, range.to)) {
    const key = b.project ?? UNATTRIBUTED
    usage.set(key, (usage.get(key) ?? 0) + billable(b))
  }
  return [...usage.entries()]
    .map(([key, n]) => ({ key, usage: n }))
    .sort((a, b) => b.usage - a.usage || byCodeUnits(a.key, b.key))
}

/** '(no project)' and 'other projects' come after the named projects, whatever their usage (§3 A4 rule 2). */
function unnamedLast(key: string): number {
  return key === UNATTRIBUTED || key === OTHER_PROJECTS ? 1 : 0
}

/**
 * 1.14 §3 A4 rule 2: the Projects table — the range's buckets (`bucketsIn`: the provider switch, the model chips and the
 * project chips applied, as to every table) grouped by their project key; code fact 3's lifetime session sums are gone.
 * Usage, the priced cost (with `showCost`; a bucket without a price makes it a lower bound, a family-priced one carries
 * the models table's mark), requests, cache hit, the share of the range's usage in the view, the sessions (rule 3) and
 * the project's last activity. By usage, highest first; '(no project)' and 'other projects' after the named ones.
 */
export function projectRows(ctx: StatsCtx, range: DayRange): ProjectRow[] {
  const groups = new Map<string, {
    usage: number; requests: number; hit: { num: number; den: number }; usd: number; unpriced: boolean; family: boolean
  }>()
  let total = 0
  for (const b of bucketsIn(ctx, range.from, range.to)) {
    const key = b.project ?? UNATTRIBUTED
    let g = groups.get(key)
    if (!g) {
      g = { usage: 0, requests: 0, hit: { num: 0, den: 0 }, usd: 0, unpriced: false, family: false }
      groups.set(key, g)
    }
    const use = billable(b)
    const parts = cacheHitParts(b)
    g.usage += use
    g.requests += b.requests
    g.hit.num += parts.num
    g.hit.den += parts.den
    const c = costOfBucketOn(b, ctx)
    // The models table's rule: no price on file, or a fast rate unknown, leaves the sum a floor — a bucket with
    // nothing in it is missing nothing.
    if (!c || c.unpriced) {
      if (allTokens(b) > 0) g.unpriced = true
    } else {
      g.usd += c.usd
      if (c.confidence === 'family') g.family = true
    }
    total += use
  }
  const labels = ctx.agg.projects()
  const names = ctx.projectNames === true
  const { counts, lowerBound } = projectSessions(ctx, range)
  const rows = [...groups.entries()].map(([key, g]): { usage: number; row: ProjectRow } => {
    const n = counts.get(key) ?? 0
    const last = Object.prototype.hasOwnProperty.call(labels, key) ? labels[key].lastTs : NaN
    const cost = ctx.showCost ? costText(g.usd) : '–'
    return {
      usage: g.usage,
      row: {
        key,
        project: projectLabel(key, labels, names),
        usage: tokens(g.usage),
        cost,
        // A dash already says "no cost known"; the marks only qualify a figure that is shown (the records' rule).
        costLowerBound: cost !== '–' && g.unpriced,
        costFamily: cost !== '–' && g.family,
        requests: tokens(g.requests),
        cacheHit: percentOf(g.hit.num, g.hit.den),
        // No billable tokens anywhere means no denominator — a dash, like every column
        // beside it. A rendered "0 %" would claim a measured share of nothing.
        share: percentOf(g.usage, total),
        sessions: lowerBound ? `⚠ ${n}` : String(n),
        sessionsLowerBound: lowerBound,
        lastActive: isStamp(last) ? clockStamp(last, ctx.now, ctx.tcfg) : '–',
      },
    }
  })
  return rows
    .sort((a, b) => unnamedLast(a.row.key) - unnamedLast(b.row.key) || b.usage - a.usage
      || byCodeUnits(a.row.project, b.row.project) || byCodeUnits(a.row.key, b.row.key))
    .map((x) => x.row)
}

/**
 * 1.14 §3 A4 rule 6 (§7a Q11): the session records active in the range — their activity overlaps its days, the records'
 * overlap rule — under the provider switch and the project filter, newest first; lifetime counters, as the note says.
 */
export function sessionRows(ctx: StatsCtx, range: DayRange, limit = 50): SessionRow[] {
  const labels = ctx.agg.projects()
  const names = ctx.projectNames === true
  const list = sessionsIn(ctx)
    .filter((s) => ctx.sources.includes(s.source))
    .filter((s) => dayOf(s.lastTs, ctx.tcfg) >= range.from && dayOf(s.firstTs, ctx.tcfg) <= range.to)
    .sort((a, b) => b.lastTs - a.lastTs)
    .slice(0, Math.max(0, limit))
  return list.map((s) => {
    const b = emptySession(s)
    const parts = cacheHitParts(b)
    return {
      session: s.sessionId,
      project: projectLabel(s.project, labels, names),
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
      models: listOf(s.models),
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
  if (left <= 0) return estimate(t('cache likely cold'))
  const minutes = Math.max(1, Math.round(left / 60_000))
  return estimate(t('cache likely cold in {0} min', minutes))
}

export function cacheStates(ctx: StatsCtx): { session: string; text: string }[] {
  const out: { session: string; text: string }[] = []
  for (const s of sessionsIn(ctx)) {
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
  // configured zone, the same calendar the buckets were placed with (sessionRows' overlap rule, the day its range).
  return { day, models, sessions: sessionRows(ctx, range, 500) }
}
