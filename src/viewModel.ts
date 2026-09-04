// SPDX-FileCopyrightText: 2026 Frederik Marx
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The one typed snapshot every view renders.
 *
 * The webview, the QuickPick, the markdown document, the status-bar tooltips and the
 * markdown export all read this object and nothing else. That is the only way three
 * renderings of the same numbers stay the same numbers; a second derivation is a second
 * opinion waiting to happen.
 *
 * Pure by contract: no vscode, no fs, no clock of its own — `now` comes in as a parameter,
 * so the whole model is reproducible in a test.
 */

import { Aggregator, Metric, billable } from './agg'
import { Config, readPaceConfig, readTimeConfig } from './config'
import { digest } from './digest'
import {
  Calibration, ForecastConfig, calibration, forecast, lockoutText, resetForecast, retrospective,
  Retro,
} from './forecast'
import { PaceConfig, effectivePace, paceVerdict, sustainableRate, windowDisplay, WindowDisplay } from './pace'
import { PRICES_AS_OF, PricingOptions, isCustomPricing } from './prices'
import { ageMinutes, estimate, extraUsageText, percentOf, percentText } from './render'
import { QuotaHistory } from './quotaHistory'
import {
  AttributionRows, CacheEconomyRow, CalendarRows, ChartData, CompositionEntry, DrillData,
  HeatmapData, HoursData, Kpi, ModelRow, ModelSort, ModelSortKey, MODEL_SORT_KEYS, PeriodRow,
  PlanFactorRow, ProjectRow, SOURCE_TITLE, SessionRow, StatsCtx, TotalRow, WindowUsageRow,
  attributionInWindow, cacheEconomy, cacheStates, calendar, chart, composition,
  drill as drillStats, filterFor, heatmap, hours, kpis, modelTable, planFactors, projectRows,
  sessionRows, totalsFor, windowUsage,
} from './stats'
import {
  DayRange, RangePreset, TimeConfig, addDays, ageText, dayCount, dayOf, formatReset, formatTime,
  isDay, previousRange, relativeShort,
} from './time'
import {
  Attribution, Forecast, PaceLevel, PaceVerdict, ProblemKind, QuotaOrigin, QuotaSample,
  QuotaState, QuotaWindow, Source,
} from './types'

export type {
  CacheEconomyRow, CalendarRows, ChartData, CompositionEntry, DrillData, HeatmapData, HoursData,
  Kpi, ModelRow, ModelSort, ModelSortKey, PeriodRow, PlanFactorRow, ProjectRow, SessionRow,
  TotalRow, WindowUsageRow,
}

/**
 * The provider titles, re-exported so the text views name a window's provider from the same
 * table the cards do: "5 h" alone is ambiguous the moment both providers report one.
 */
export { SOURCE_TITLE }

// ---------------------------------------------------------------------------
// UI state and the webview message protocol
// ---------------------------------------------------------------------------

export interface UiState {
  range: RangePreset | { from: string; to: string }
  sort: { key: string; dir: 'asc' | 'desc' }
  providers: Source[]
  models: string[]
  metric: Metric
  heatmapMetric: 'usage' | 'cost'
  hourZone: 'local' | 'utc'
  drillDay: string | null
}

/** The commands the webview may ask for. Nothing outside this list is ever executed. */
export const WEBVIEW_COMMANDS = [
  'tokenPace.refreshQuota',
  'tokenPace.rescan',
  'tokenPace.showOutput',
  'tokenPace.openSettings',
  'tokenPace.exportCsv',
  'tokenPace.exportJson',
  'tokenPace.copySummary',
  'tokenPace.copyDiagnostics',
  'tokenPace.clearStoredData',
] as const
export type WebviewCommandId = (typeof WEBVIEW_COMMANDS)[number]

export type WebviewMessage =
  | { type: 'setRange'; preset: RangePreset }
  | { type: 'setRange'; from: string; to: string }
  | { type: 'setSort'; key: ModelSortKey; dir: 'asc' | 'desc' }
  | { type: 'setFilter'; providers: Source[]; models: string[] }
  | { type: 'setMetric'; metric: Metric }
  | { type: 'setHeatmapMetric'; metric: 'usage' | 'cost' }
  | { type: 'setHourZone'; zone: 'local' | 'utc' }
  | { type: 'drill'; day: string | null }
  | { type: 'refresh' }
  | { type: 'command'; id: WebviewCommandId }

export const RANGE_PRESETS: RangePreset[] = [
  'today', 'yesterday', '7d', '30d', '90d', 'thisWeek', 'thisMonth', 'lastMonth', 'year', 'all',
]
const METRICS: Metric[] = ['usage', 'output', 'cacheRead', 'requests', 'reasoning', 'cost']
const SOURCES: Source[] = ['claude', 'codex']
/** Five years of days is already an absurd table; beyond it a custom range is a fuzz attempt. */
const MAX_CUSTOM_DAYS = 1826
const MAX_MODEL_FILTER = 50
const MAX_MODEL_CHARS = 80

/**
 * A real calendar day, not just something shaped like one: `2026-13-01` parses fine and
 * silently becomes January 2027, which would move a range without saying so. The round trip
 * through the calendar is the cheapest way to reject it.
 */
function isCalendarDay(v: unknown): v is string {
  return typeof v === 'string' && isDay(v) && addDays(v, 0) === v
}

function strings(v: unknown, max: number, maxChars: number): string[] | null {
  if (!Array.isArray(v) || v.length > max) return null
  const out: string[] = []
  for (const item of v) {
    if (typeof item !== 'string' || item.length === 0 || item.length > maxChars) return null
    out.push(item)
  }
  return out
}

/**
 * The webview is the only untrusted input this extension has. Every message is checked
 * against an allow-list of shapes and value ranges; anything that does not match is dropped
 * whole rather than repaired, because a half-understood message is a guess about intent.
 */
export function parseWebviewMessage(raw: unknown): WebviewMessage | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const m = raw as Record<string, unknown>
  switch (m.type) {
    case 'setRange': {
      if (typeof m.preset === 'string') {
        return (RANGE_PRESETS as string[]).includes(m.preset)
          ? { type: 'setRange', preset: m.preset as RangePreset }
          : null
      }
      const from = m.from
      const to = m.to
      if (!isCalendarDay(from) || !isCalendarDay(to)) return null
      const len = dayCount(from, to)
      if (len <= 0 || len > MAX_CUSTOM_DAYS) return null
      return { type: 'setRange', from, to }
    }
    case 'setSort': {
      if (typeof m.key !== 'string' || !(MODEL_SORT_KEYS as readonly string[]).includes(m.key)) return null
      if (m.dir !== 'asc' && m.dir !== 'desc') return null
      return { type: 'setSort', key: m.key as ModelSortKey, dir: m.dir }
    }
    case 'setFilter': {
      const providers = strings(m.providers, SOURCES.length, 16)
      const models = strings(m.models, MAX_MODEL_FILTER, MAX_MODEL_CHARS)
      if (!providers || !models) return null
      if (providers.some((p) => !(SOURCES as string[]).includes(p))) return null
      const seen = new Set(providers)
      return { type: 'setFilter', providers: [...seen] as Source[], models: [...new Set(models)] }
    }
    case 'setMetric':
      return typeof m.metric === 'string' && (METRICS as string[]).includes(m.metric)
        ? { type: 'setMetric', metric: m.metric as Metric }
        : null
    case 'setHeatmapMetric':
      return m.metric === 'usage' || m.metric === 'cost'
        ? { type: 'setHeatmapMetric', metric: m.metric }
        : null
    case 'setHourZone':
      return m.zone === 'local' || m.zone === 'utc' ? { type: 'setHourZone', zone: m.zone } : null
    case 'drill':
      if (m.day === null) return { type: 'drill', day: null }
      return isCalendarDay(m.day) ? { type: 'drill', day: m.day } : null
    case 'refresh':
      return { type: 'refresh' }
    case 'command':
      return typeof m.id === 'string' && (WEBVIEW_COMMANDS as readonly string[]).includes(m.id)
        ? { type: 'command', id: m.id as WebviewCommandId }
        : null
    default:
      return null
  }
}

export function defaultUiState(cfg: Config): UiState {
  return {
    range: cfg.dashboard.defaultRange as RangePreset,
    sort: { key: 'usage', dir: 'desc' },
    providers: ['claude', 'codex'],
    models: [],
    metric: 'usage',
    heatmapMetric: 'usage',
    hourZone: 'local',
    drillDay: null,
  }
}

/**
 * Folds one message into the UI state. Messages that do not change the view (a refresh, a
 * command) return the very same object, so the caller can tell "nothing to persist" from
 * "state changed" by identity.
 */
export function applyMessage(ui: UiState, m: WebviewMessage): UiState {
  switch (m.type) {
    case 'setRange':
      // A drilled day from the old range would keep a table open that the range no longer
      // covers, so the drill closes with the range.
      return 'preset' in m
        ? { ...ui, range: m.preset, drillDay: null }
        : { ...ui, range: { from: m.from, to: m.to }, drillDay: null }
    case 'setSort':
      return { ...ui, sort: { key: m.key, dir: m.dir } }
    case 'setFilter':
      // Switching every provider off would leave a dashboard of dashes that looks broken;
      // the last one stays on.
      return {
        ...ui,
        providers: m.providers.length > 0 ? m.providers : [...SOURCES],
        models: m.models,
      }
    case 'setMetric':
      return { ...ui, metric: m.metric }
    case 'setHeatmapMetric':
      return { ...ui, heatmapMetric: m.metric }
    case 'setHourZone':
      return { ...ui, hourZone: m.zone }
    case 'drill':
      return { ...ui, drillDay: m.day }
    default:
      return ui
  }
}

// ---------------------------------------------------------------------------
// View-model shapes
// ---------------------------------------------------------------------------

/** One source that could have answered, and what it had to say — the data-quality list. */
export interface Candidate {
  id: string
  ok: boolean
  ageSec: number | null
  problem?: string
}

export interface WindowVm {
  id: string
  label: string
  percent: number
  percentText: string
  display: WindowDisplay
  level: PaceLevel
  verdict: PaceVerdict
  elapsed: number | null
  reset: string
  resetAbsolute: string
  /**
   * The reset in words: 'reset due', 'resets <countdown>', or '' when the provider stated no
   * reset. The only place in the whole extension that writes the verb — a view that prefixed
   * its own would sooner or later print "resets reset due".
   */
  resetLine: string
  /**
   * `display` as a sentence fragment, already de-duplicated against the verdict and against
   * `resetLine`, or '' when neither adds anything. Views print this instead of the enum.
   */
  stateText: string
  forecast: Forecast | null
  sustainable: string | null
  spark: number[]
  aria: { now: number; max: number; text: string }
}

export interface QuotaCard {
  source: Source
  title: string
  planType: string | null
  problem: string | null
  problemKind: ProblemKind | null
  problemAction: { label: string; command: string } | null
  ageText: string | null
  stale: boolean
  origin: QuotaOrigin | null
  freshness: {
    lastCheck: string | null
    lastData: string | null
    lastEvent: string | null
    nextRefresh: string | null
    snapshotAge: string | null
  }
  windows: WindowVm[]
  extra: { text: string; utilization: number | null; enabled: boolean; billed: boolean } | null
  usagePageUrl: string | null
}

export interface DataQuality {
  roots: string[]
  files: number
  oldestDay: string | null
  newestDay: string | null
  buckets: { hour: number; day: number; month: number }
  snapshotBytes: number
  lowerBoundShare: string
  unpricedModels: string[]
  familyPriced: string[]
  quota: { source: Source; candidates: Candidate[]; drift: string[] }[]
  consent: string
  leader: 'leader' | 'follower' | 'single'
  retention: { hourDays: number; days: number; historyDays: number }
  history: { samples: number; bytes: number; oldest: string | null }
  calibration: { source: Source; windowId: string; text: string }[]
  bridge: string | null
  attribution: Attribution
  version: string
}

export interface VmInput {
  quotas: QuotaState[]
  agg: Aggregator
  history: QuotaHistory
  cfg: Config
  now: number
  range: DayRange
  ui: UiState
  leader: boolean
  candidates: Record<Source, Candidate[]>
  drift: Record<Source, string[]>
  dataFiles: { roots: string[]; files: number }
  snapshotBytes: number
  consent: 'granted' | 'denied' | 'unasked'
  bridge: { installed: boolean; shadowed: boolean; mirrorAge: number | null } | null
  fingerprints: Record<Source, string>
  preview?: boolean
  /** Forecast tuning; the status bar and the dashboard must not disagree about a projection. */
  forecastCfg: ForecastConfig
  /** A cold scan is still running — the first-run card says "reading history" instead of "empty". */
  scanning?: boolean
}

export interface ViewModel {
  generatedAt: string
  now: number
  sections: string[]
  showCost: boolean
  pricing: { asOf: string; custom: boolean; showList: boolean }
  range: DayRange & { previous: DayRange | null; presets: RangePreset[] }
  ui: UiState
  quotas: QuotaCard[]
  digest: string[]
  kpis: Kpi[]
  composition: CompositionEntry[]
  totals: { source: Source; title: string; rows: TotalRow[] }[]
  cacheEconomy: CacheEconomyRow[]
  calendar: CalendarRows
  planFactor: PlanFactorRow[]
  chart: ChartData
  models: { rows: ModelRow[]; total: number; hidden: number; sort: ModelSort }
  heatmap: HeatmapData
  hours: HoursData
  forecasts: {
    source: Source
    windowId: string
    label: string
    forecast: Forecast
    sustainable: string | null
    lockout: string | null
    resetForecast: string | null
    spark: number[]
    gaps: number
  }[]
  retro: { source: Source; windowId: string; label: string; retro: Retro; text: string }[]
  windowUsage: WindowUsageRow[]
  projects: { rows: ProjectRow[]; enabled: boolean }
  sessions: { rows: SessionRow[]; enabled: boolean; cacheStates: { session: string; text: string }[] }
  /**
   * Per-window project split. `source` and `label` travel with the rows because two
   * providers can both report a "5 h" window: a block headed by the raw id, or by a label
   * with no provider, cannot be told apart from its twin.
   */
  attributionInWindow: {
    source: Source
    windowId: string
    label: string
    rows: AttributionRows['rows']
    unexplained: string
  }[]
  dataQuality: DataQuality
  unpricedModels: string[]
  familyPriced: string[]
  lowerBound: boolean
  drill: DrillData | null
  /** Nothing ingested and no quota — the empty state carries its own explanation. */
  firstRun: { scanning: boolean; text: string } | null
  footnotes: string[]
  preview: boolean
}

// ---------------------------------------------------------------------------
// Sparklines
// ---------------------------------------------------------------------------

/** A break in the series. Percentages are never negative, so this cannot collide with data. */
export const SPARK_GAP = -1
/** Longer than this without a reading is a hole in the coverage, not a flat line. */
const SPARK_GAP_MS = 90 * 60_000
const SPARK_WINDOW_MS = 24 * 60 * 60_000
const SPARK_MAX_POINTS = 60

/**
 * The last 24 hours of one window as a list of percentages, with `SPARK_GAP` wherever the
 * readings stop. Drawing straight through a gap would claim a measurement that was never
 * taken — VS Code is not running all day, and that shows.
 */
export function sparkOf(samples: QuotaSample[], now: number): number[] {
  const recent = samples.filter((s) => s.t >= now - SPARK_WINDOW_MS).sort((a, b) => a.t - b.t)
  const out: number[] = []
  for (let i = 0; i < recent.length; i++) {
    if (i > 0 && recent[i].t - recent[i - 1].t > SPARK_GAP_MS) out.push(SPARK_GAP)
    out.push(recent[i].p)
  }
  return out.length > SPARK_MAX_POINTS ? out.slice(out.length - SPARK_MAX_POINTS) : out
}

// ---------------------------------------------------------------------------
// Forecasts
// ---------------------------------------------------------------------------

function elapsedOf(w: QuotaWindow, now: number): number | null {
  if (w.resetsAt === null || w.windowMinutes === null) return null
  if (!Number.isFinite(w.resetsAt) || !Number.isFinite(w.windowMinutes)) return null
  const span = w.windowMinutes * 60_000
  return Math.max(0, Math.min(100, ((now - (w.resetsAt - span)) / span) * 100))
}

/**
 * One forecast per window, keyed `${source}:${windowId}`.
 *
 * Exported separately so the extension computes them once and hands the same objects to the
 * status bar and to the dashboard: two independent least-squares fits over the same samples
 * would differ in the second the clock ticks between them, and users would see two answers.
 */
export function forecastsFor(
  quotas: QuotaState[],
  history: QuotaHistory,
  fingerprints: Record<Source, string>,
  forecastCfg: ForecastConfig,
  now: number,
  paceCfg: PaceConfig,
  tcfg?: TimeConfig,
): Map<string, Forecast> {
  const out = new Map<string, Forecast>()
  // The user's pace sensitivity also decides how long a window counts as "just reset";
  // a forecast and a verdict that disagree about that would contradict each other.
  const cfg: ForecastConfig = { ...forecastCfg, minElapsedPercent: effectivePace(paceCfg).minElapsedPercent }
  const fmt = tcfg ? (ms: number): string => formatTime(ms, tcfg) : undefined
  for (const q of quotas) {
    if (!q.ok) continue
    const fp = fingerprints[q.source] ?? ''
    for (const w of q.windows) {
      const samples = history.samples(q.source, w.id, fp)
      const f = fmt
        ? forecast(samples, w, now, cfg, elapsedOf(w, now), fmt)
        : forecast(samples, w, now, cfg, elapsedOf(w, now))
      out.set(`${q.source}:${w.id}`, f)
    }
  }
  return out
}

// ---------------------------------------------------------------------------
// Quota cards
// ---------------------------------------------------------------------------

const USAGE_PAGE: Record<Source, string> = {
  claude: 'https://claude.ai/settings/usage',
  codex: 'https://chatgpt.com/codex/settings/usage',
}

/** One repair step per cause — a named problem with no way out is only half a diagnosis. */
const PROBLEM_ACTION: Partial<Record<ProblemKind, { label: string; command: string }>> = {
  noToken: { label: 'Show log', command: 'tokenPace.showOutput' },
  tokenExpired: { label: 'Show log', command: 'tokenPace.showOutput' },
  consentPending: { label: 'Fetch quota now', command: 'tokenPace.refreshQuota' },
  modeCache: { label: 'Open settings', command: 'tokenPace.openSettings' },
  retry: { label: 'Fetch quota now', command: 'tokenPace.refreshQuota' },
  offline: { label: 'Fetch quota now', command: 'tokenPace.refreshQuota' },
  forbidden: { label: 'Show log', command: 'tokenPace.showOutput' },
  unauthorized: { label: 'Show log', command: 'tokenPace.showOutput' },
  noBinary: { label: 'Open settings', command: 'tokenPace.openSettings' },
  quotaOff: { label: 'Open settings', command: 'tokenPace.openSettings' },
  noFile: { label: 'Re-read history', command: 'tokenPace.rescan' },
  empty: { label: 'Re-read history', command: 'tokenPace.rescan' },
  paused: { label: 'Fetch quota now', command: 'tokenPace.refreshQuota' },
  unknown: { label: 'Show log', command: 'tokenPace.showOutput' },
}

/**
 * Every window state in words. `normal` has nothing to add, and `resetDue` is left empty
 * because `resetLine` already says "reset due" — printing both would say it twice in one row.
 */
const DISPLAY_WORD: Record<WindowDisplay, string> = {
  normal: '',
  exhausted: 'exhausted',
  overflow: 'over the limit',
  unlimited: 'unlimited',
  limitReached: 'limit reached',
  resetDue: '',
}

/**
 * The state, unless the verdict standing next to it already contains the word — "exhausted ·
 * exhausted" is not two facts.
 */
function stateTextOf(display: WindowDisplay, verdictText: string): string {
  const w = DISPLAY_WORD[display] ?? ''
  if (!w) return ''
  return verdictText.toLowerCase().includes(w) ? '' : w
}

/**
 * The reset with its verb attached, once, here.
 *
 * `formatReset` deliberately never says "resets"; it answers a countdown, or "reset due" once
 * the stated time has passed. That second answer is already a whole sentence, so it keeps the
 * verb away from it — both for a `resetDue` window and for the minutes after a fresh reading
 * has caught up with a reset that just happened.
 */
function resetLineOf(display: WindowDisplay, reset: string): string {
  if (display === 'resetDue') return 'reset due'
  if (!reset) return ''
  return reset.includes('reset due') ? reset : `resets ${reset}`
}

/**
 * A window with no limit has no denominator, so every figure derived from its percentage is
 * arithmetic on a number that means nothing: "99 points in reserve" beside "∞" is the same
 * sentence contradicting itself, and a rate that "keeps it to the reset" budgets a limit that
 * does not exist. Both are answered here, before the pace maths runs.
 */
function unlimitedVerdict(w: QuotaWindow): PaceVerdict | null {
  if (!w.unlimited) return null
  return { level: 'ok', points: null, ratio: null, measuring: false, text: 'unlimited' }
}

function sustainableText(w: QuotaWindow, now: number): string | null {
  if (w.unlimited) return null
  const r = sustainableRate(w.percent, w.resetsAt, now)
  if (!r) return null
  return estimate(`${r.perHour.toFixed(1)} points/h keeps it to the reset`)
}

/**
 * The forecast as the quota card prints it. A window that has just reset is "measuring" in
 * the verdict already; a forecast that says "measuring · window just started" under it is the
 * same fact in other words, so the card keeps the forecast (its marks and state) but not the
 * sentence. The Forecast section keeps its own row untouched.
 */
function cardForecast(f: Forecast | null, verdict: PaceVerdict): Forecast | null {
  if (!f) return null
  return verdict.measuring && f.state === 'measuring' ? { ...f, text: '' } : f
}

function quotaCard(
  q: QuotaState,
  input: VmInput,
  tcfg: TimeConfig,
  paceCfg: PaceConfig,
  forecasts: Map<string, Forecast>,
  lastEvent: number | null,
  newestDay: string | null,
): QuotaCard {
  const { now, cfg, history } = input
  const fetchedMs = q.fetchedAt !== null && Number.isFinite(q.fetchedAt) ? q.fetchedAt * 1000 : null
  const age = ageMinutes(q.fetchedAt, now)
  const fp = input.fingerprints[q.source] ?? ''
  const windows: WindowVm[] = q.windows.map((w) => {
    const elapsed = elapsedOf(w, now)
    const verdict = unlimitedVerdict(w) ?? paceVerdict(w.percent, elapsed, paceCfg)
    const display = windowDisplay(w, fetchedMs, now)
    // The same rounding rule as the status bar, from the same function — two views that
    // disagree about whether 99.6 % is "100%" or "99%" would look like two readings.
    const pct = percentText(w.percent, cfg.percentMode, cfg.overflowDisplay)
    const text = w.unlimited ? 'unlimited' : display === 'resetDue' ? 'reset due' : `${pct} used`
    const reset = formatReset(w.resetsAt, now, 'relative', tcfg)
    return {
      id: w.id,
      label: w.label,
      percent: w.percent,
      percentText: w.unlimited ? '∞' : pct,
      display,
      level: verdict.level,
      verdict,
      elapsed,
      reset,
      resetAbsolute: formatReset(w.resetsAt, now, 'absolute', tcfg),
      resetLine: resetLineOf(display, reset),
      stateText: stateTextOf(display, verdict.text),
      forecast: cardForecast(forecasts.get(`${q.source}:${w.id}`) ?? null, verdict),
      sustainable: sustainableText(w, now),
      spark: sparkOf(history.samples(q.source, w.id, fp, now - SPARK_WINDOW_MS), now),
      aria: {
        now: Number.isFinite(w.percent) ? Math.round(w.percent) : 0,
        max: 100,
        // "unlimited, unlimited" is the screen reader saying the same word twice: the
        // unlimited verdict IS the state, so it is not repeated after it.
        text: verdict.text === text ? `${w.label}: ${text}` : `${w.label}: ${text}, ${verdict.text}`,
      },
    }
  })

  const extraText = extraUsageText(q.extra)
  return {
    source: q.source,
    title: SOURCE_TITLE[q.source],
    planType: q.planType,
    problem: q.ok ? null : (q.problem ?? 'unavailable'),
    problemKind: q.ok ? null : (q.problemKind ?? 'unknown'),
    problemAction: q.ok ? null : (PROBLEM_ACTION[q.problemKind ?? 'unknown'] ?? null),
    ageText: ageText(q.fetchedAt, now),
    stale: age !== null && age > cfg.staleAfterMinutes,
    origin: q.origin ?? null,
    freshness: {
      lastCheck: ageText(q.fetchedAt, now),
      lastData: newestSampleText(history, q.source, q.windows.map((w) => w.id), fp, now),
      lastEvent: lastEvent === null ? null : ageText(Math.round(lastEvent / 1000), now),
      nextRefresh: typeof q.nextAttemptAt === 'number' && Number.isFinite(q.nextAttemptAt)
        ? relativeShort(q.nextAttemptAt, now)
        : null,
      snapshotAge: newestDay,
    },
    windows,
    extra: extraText === null
      ? null
      : {
        text: extraText,
        utilization: q.extra?.utilization ?? null,
        enabled: q.extra?.enabled === true,
        // Extra usage is money that was actually billed — never an estimate of ours.
        billed: (q.extra?.used ?? null) !== null || (q.extra?.balance ?? null) !== null,
      },
    usagePageUrl: cfg.usagePageLinks ? USAGE_PAGE[q.source] : null,
  }
}

/**
 * Age of the newest persisted reading of this account.
 *
 * "Last check" is when we last asked; this is when the series last actually moved — the two
 * differ whenever a poll answered with a value we already had.
 */
function newestSampleText(
  history: QuotaHistory,
  source: Source,
  windowIds: string[],
  fp: string,
  now: number,
): string | null {
  let newest: number | null = null
  for (const id of windowIds) {
    for (const s of history.samples(source, id, fp)) {
      if (newest === null || s.t > newest) newest = s.t
    }
  }
  return newest === null ? null : ageText(Math.round(newest / 1000), now)
}

// ---------------------------------------------------------------------------
// buildViewModel
// ---------------------------------------------------------------------------

export function buildViewModel(input: VmInput): ViewModel {
  const { agg, cfg, history, now, quotas, ui } = input
  const tcfg = readTimeConfig(cfg)
  const paceCfg = readPaceConfig(cfg)
  const pricing: PricingOptions = {
    overrides: cfg.customPrices,
    multiplier: cfg.pricing.multiplier,
    unknownModel: cfg.unknownModelPricing,
  }
  const sources: Source[] = ui.providers.length > 0 ? [...ui.providers] : ['claude', 'codex']
  const ctx: StatsCtx = {
    agg, tcfg, pricing, now, sources, models: ui.models, showCost: cfg.showCost,
  }
  const range = input.range
  const previous = previousRange(range)
  const stats = agg.stats()
  const firstDay = agg.firstIngest !== null ? dayOf(agg.firstIngest, tcfg) : stats.oldestDay

  let lastEvent: number | null = null
  for (const cur of agg.cursors.values()) {
    if (typeof cur.lastTs === 'number' && Number.isFinite(cur.lastTs)) {
      if (lastEvent === null || cur.lastTs > lastEvent) lastEvent = cur.lastTs
    }
  }

  const forecasts = forecastsFor(quotas, history, input.fingerprints, input.forecastCfg, now, paceCfg, tcfg)
  const cards = quotas.map((q) => quotaCard(q, input, tcfg, paceCfg, forecasts, lastEvent, stats.newestDay))

  const totals = sources.map((source) => ({
    source,
    title: SOURCE_TITLE[source],
    rows: totalsFor(ctx, source, range, previous, firstDay, cfg.pricing.showListPrice),
  }))

  const costSummary = combinedCost(ctx, range)
  const models = modelTable(
    ctx, range, sortOf(ui.sort), cfg.dashboard.modelRows, cfg.pricing.showListPrice,
  )
  const kpiRow = kpis(ctx, range, previous)
  const cache = cacheEconomy(ctx, range)

  const forecastRows = forecastList(cards, quotas, history, input.fingerprints, forecasts, now, tcfg)
  const retroRows = retroList(quotas, history, input.fingerprints)
  const usageRows: WindowUsageRow[] = []
  const attribution: ViewModel['attributionInWindow'] = []
  for (const q of quotas) {
    if (!sources.includes(q.source)) continue
    for (const w of q.windows) {
      const row = windowUsage(ctx, q.source, w)
      if (row) usageRows.push(row)
      if (cfg.attribution !== 'none') {
        const a = attributionInWindow(ctx, q.source, w)
        if (a) {
          attribution.push({
            source: q.source, windowId: w.id, label: w.label, rows: a.rows, unexplained: a.unexplained,
          })
        }
      }
    }
  }

  const attributionOn = cfg.attribution !== 'none'
  const dq = dataQuality(input, ctx, tcfg, costSummary, stats)
  const empty = stats.buckets === 0
  const noQuota = cards.every((c) => c.problem !== null || c.windows.length === 0)

  const vm: ViewModel = {
    generatedAt: formatTime(now, tcfg),
    now,
    sections: [...cfg.dashboard.sections],
    showCost: cfg.showCost,
    pricing: { asOf: PRICES_AS_OF, custom: isCustomPricing(pricing), showList: cfg.pricing.showListPrice },
    range: { ...range, previous, presets: RANGE_PRESETS },
    ui,
    quotas: cards,
    digest: [],
    kpis: kpiRow,
    composition: composition(ctx, range),
    totals,
    cacheEconomy: cache,
    calendar: calendar(ctx),
    planFactor: planFactors(ctx, cfg.planPriceUsd),
    chart: chart(ctx, range, ui.metric),
    models,
    heatmap: heatmap(ctx, ui.heatmapMetric, firstDay),
    hours: hours(ctx, range, ui.hourZone),
    forecasts: forecastRows,
    retro: retroRows,
    windowUsage: usageRows,
    projects: { rows: attributionOn ? projectRows(ctx) : [], enabled: attributionOn },
    sessions: {
      rows: attributionOn ? sessionRows(ctx) : [],
      enabled: attributionOn,
      cacheStates: attributionOn ? cacheStates(ctx) : [],
    },
    attributionInWindow: attribution,
    dataQuality: dq,
    unpricedModels: costSummary.unpricedModels,
    familyPriced: costSummary.familyPriced,
    lowerBound: costSummary.unpricedTokens > 0 || costSummary.fastUnpricedTokens > 0
      || totals.some((t) => t.rows.some((r) => r.incomplete)),
    drill: ui.drillDay ? drillStats(ctx, ui.drillDay, sortOf(ui.sort), cfg.dashboard.modelRows) : null,
    firstRun: empty && noQuota
      ? {
        scanning: input.scanning === true,
        text: input.scanning === true
          ? 'Reading history…'
          : 'No transcripts found yet. Check that Claude Code or Codex has run on this machine, '
            + 'and that tokenPace.claudeDir / tokenPace.codexDir point at their directories.',
      }
      : null,
    footnotes: [],
    preview: input.preview === true,
  }

  vm.digest = digest(vm)
  vm.footnotes = footnotesFor(vm, cfg)
  return vm
}

function sortOf(sort: UiState['sort']): ModelSort {
  const key = (MODEL_SORT_KEYS as readonly string[]).includes(sort.key)
    ? (sort.key as ModelSortKey)
    : 'usage'
  return { key, dir: sort.dir === 'asc' ? 'asc' : 'desc' }
}

function combinedCost(ctx: StatsCtx, range: DayRange) {
  const out = {
    usd: 0, listUsd: 0, unpricedTokens: 0, unpricedModels: [] as string[],
    fastUnpricedTokens: 0, familyPriced: [] as string[], custom: false,
  }
  const unpriced = new Set<string>()
  const family = new Set<string>()
  for (const source of ctx.sources) {
    const c = ctx.agg.cost(range.from, range.to, ctx.tcfg, ctx.pricing, { source, ...(ctx.models.length ? { models: ctx.models } : {}) })
    out.usd += c.usd
    out.listUsd += c.listUsd
    out.unpricedTokens += c.unpricedTokens
    out.fastUnpricedTokens += c.fastUnpricedTokens
    out.custom = out.custom || c.custom
    for (const m of c.unpricedModels) unpriced.add(m)
    for (const m of c.familyPriced) family.add(m)
  }
  out.unpricedModels = [...unpriced].sort()
  out.familyPriced = [...family].sort()
  return out
}

function forecastList(
  cards: QuotaCard[],
  quotas: QuotaState[],
  history: QuotaHistory,
  fingerprints: Record<Source, string>,
  forecasts: Map<string, Forecast>,
  now: number,
  tcfg: TimeConfig,
): ViewModel['forecasts'] {
  const out: ViewModel['forecasts'] = []
  const labels = new Map<string, string>()
  const displays = new Map<string, WindowDisplay>()
  for (const c of cards) {
    for (const w of c.windows) {
      labels.set(`${c.source}:${w.id}`, w.label)
      displays.set(`${c.source}:${w.id}`, w.display)
    }
  }
  for (const q of quotas) {
    const fp = fingerprints[q.source] ?? ''
    for (const w of q.windows) {
      const key = `${q.source}:${w.id}`
      const f = forecasts.get(key)
      if (!f) continue
      // The quota card drops a "full" forecast once the stated reset has passed — the reading
      // it rests on belongs to the window before the reset. The list beside it may not keep
      // stating what the card refuses to; the three views do not disagree about one window.
      if (f.state === 'full' && displays.get(key) === 'resetDue') continue
      const samples = history.samples(q.source, w.id, fp, now - SPARK_WINDOW_MS)
      const rf = resetForecast(f)
      out.push({
        source: q.source,
        windowId: w.id,
        label: labels.get(key) ?? w.label,
        forecast: f,
        sustainable: sustainableText(w, now),
        lockout: lockoutText(f, now, (ms) => formatTime(ms, tcfg)),
        resetForecast: rf === null
          ? null
          : estimate(rf.sign === '+'
            ? `${rf.points.toFixed(0)} points spare at the reset`
            : `${rf.points.toFixed(0)} points over before the reset`),
        spark: sparkOf(samples, now),
        gaps: history.gaps(samples, SPARK_GAP_MS).length,
      })
    }
  }
  return out
}

function retroList(
  quotas: QuotaState[],
  history: QuotaHistory,
  fingerprints: Record<Source, string>,
): ViewModel['retro'] {
  const out: ViewModel['retro'] = []
  for (const q of quotas) {
    const fp = fingerprints[q.source] ?? ''
    for (const w of q.windows) {
      const retro = retrospective(history.cycles(q.source, w.id, fp), w.id)
      out.push({
        source: q.source,
        windowId: w.id,
        label: w.label,
        retro,
        text: retroText(retro),
      })
    }
  }
  return out
}

function retroText(r: Retro): string {
  if (!r.enough) {
    const n = r.cycles.filter((c) => c.complete).length
    return `not enough data yet · ${n} complete cycle${n === 1 ? '' : 's'} on file`
  }
  const capped = r.cappedShare === null ? '–' : `${Math.round(r.cappedShare * 100)} %`
  const unused = r.avgUnused === null ? '–' : `${Math.round(r.avgUnused)} points`
  return `${capped} of the complete cycles hit the limit · Ø ${unused} unused at the reset`
}

function dataQuality(
  input: VmInput,
  ctx: StatsCtx,
  tcfg: TimeConfig,
  cost: ReturnType<typeof combinedCost>,
  stats: ReturnType<Aggregator['stats']>,
): DataQuality {
  const { cfg, agg, history, now } = input
  const totalTokens = ctx.sources.reduce(
    (sum, s) => sum + billable(agg.sum(input.range.from, input.range.to, tcfg, filterFor(ctx, s))),
    0,
  )
  const size = history.size()
  const calib: DataQuality['calibration'] = []
  if (cfg.calibration.show) {
    for (const q of input.quotas) {
      const fp = input.fingerprints[q.source] ?? ''
      for (const w of q.windows) {
        const c = calibration(
          history.samples(q.source, w.id, fp),
          (fromMs, toMs) => {
            const r = agg.sumHours(fromMs, toMs, { source: q.source })
            return r.complete ? billable(r.bucket) : null
          },
          w,
        )
        calib.push({ source: q.source, windowId: w.id, text: calibrationText(c) })
      }
    }
  }
  return {
    roots: input.dataFiles.roots,
    files: input.dataFiles.files,
    oldestDay: stats.oldestDay,
    newestDay: stats.newestDay,
    buckets: { hour: stats.hourBuckets, day: stats.dayBuckets, month: stats.monthBuckets },
    snapshotBytes: input.snapshotBytes,
    lowerBoundShare: percentOf(cost.unpricedTokens + cost.fastUnpricedTokens, totalTokens),
    unpricedModels: cost.unpricedModels,
    familyPriced: cost.familyPriced,
    quota: (['claude', 'codex'] as Source[]).map((source) => ({
      source,
      candidates: input.candidates[source] ?? [],
      drift: input.drift[source] ?? [],
    })),
    consent: input.consent === 'granted'
      ? 'network access granted'
      : input.consent === 'denied'
        ? 'network access denied — local sources only'
        : 'not asked yet — local sources only',
    leader: cfg.leaderElection === false ? 'single' : input.leader ? 'leader' : 'follower',
    retention: {
      hourDays: cfg.hourRetentionDays,
      days: cfg.retentionDays,
      historyDays: cfg.quotaHistoryDays,
    },
    history: {
      samples: size.samples,
      bytes: size.bytes,
      oldest: size.oldest === null ? null : dayOf(size.oldest, tcfg),
    },
    calibration: calib,
    bridge: input.bridge === null
      ? null
      : input.bridge.shadowed
        ? 'status line connected but shadowed by another settings file'
        : input.bridge.installed
          ? `status line connected${input.bridge.mirrorAge === null ? '' : ` · mirror ${ageText(Math.round((now - input.bridge.mirrorAge) / 1000), now) ?? 'unknown age'}`}`
          : 'status line not connected',
    attribution: cfg.attribution,
    version: typeof __EXT_VERSION__ === 'string' ? __EXT_VERSION__ : '0.0.0',
  }
}

function calibrationText(c: Calibration | null): string {
  if (!c) return 'not enough data'
  return estimate(
    `server counts ${c.factor.toFixed(1)} points per 1M local tokens `
    + `(band ${c.low.toFixed(1)}–${c.high.toFixed(1)}, ${c.basisHours.toFixed(1)} h of basis)`,
  )
}

function footnotesFor(vm: ViewModel, cfg: Config): string[] {
  const out: string[] = []
  out.push('“Usage” = fresh input + cache write + output; cache reads are listed apart because '
    + 'they outnumber the rest by orders of magnitude.')
  if (vm.showCost) {
    // The only place the price date is stated. Every view prints these footnotes verbatim, so
    // a second "Prices as of" line anywhere else comes out as the same sentence twice.
    out.push('API cost is hypothetical: what this usage would have cost through the provider API. '
      + `On a subscription you do not pay it. Prices as of ${vm.pricing.asOf}.`)
    if (vm.pricing.custom) out.push('Costs use your configured rates, not the published list prices.')
    if (vm.unpricedModels.length > 0) {
      out.push(`No price on file for: ${vm.unpricedModels.join(', ')} — every cost total is a lower bound.`)
    }
    if (vm.familyPriced.length > 0) {
      out.push(`Priced from a related model (family fallback): ${vm.familyPriced.join(', ')}.`)
    }
  }
  out.push('~ = estimate · measured = read from the provider · derived = computed from measured values.')
  out.push('Quota percentages come from the provider and cover every client of the account; they '
    + 'cannot be derived from the local token counts.')
  if (cfg.attribution === 'none') {
    out.push('Project and session figures are off (tokenPace.attribution).')
  }
  return out
}
