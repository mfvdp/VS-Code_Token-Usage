// SPDX-FileCopyrightText: 2026 Frederik Marx
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Typed, validated reader for every `tokenPace.*` setting.
 *
 * Settings are hand-edited far more often than the settings UI suggests, and a single
 * `"10m"` where a number belongs used to be enough to poison a timer or a backoff for the
 * rest of the session. So nothing here trusts the value it gets: numbers must be finite and
 * are clamped to the range the manifest advertises, enums fall back to their default,
 * arrays keep only known members (in the user's order, which *is* the display order), and
 * objects are rebuilt field by field. An unusable value never becomes NaN downstream — it
 * becomes the default, which is a state we can reason about.
 *
 * The validating half (`sanitize`) is deliberately free of any top-level `vscode` import so
 * the test suite can exercise it without an extension host; only `readConfig` pulls the API
 * in, lazily.
 */

/**
 * The one import this file makes.
 *
 * `budget.ts` owns the shape of a budget *and* the rules that make one usable, and those
 * rules are the sanitising rules — a second copy here is exactly the drift the CONFIG_KEYS
 * parity test exists to catch. It is a pure module (no vscode, no fs, no clock) and it does
 * not import this file, so nothing circular follows from it.
 */
import { BudgetSpec, sanitizeBudgets } from './budget'

export type { BudgetSpec }

/** Every key this module reads, exactly as it appears in `contributes.configuration`. */
export const CONFIG_KEYS: string[] = [
  // General
  'tokenPace.statusBar.show',
  'tokenPace.windowSelect',
  'tokenPace.windows',
  'tokenPace.density',
  'tokenPace.clickAction',
  'tokenPace.usagePageLinks',
  'tokenPace.alignment',
  'tokenPace.staleAfterMinutes',
  'tokenPace.timezone',
  'tokenPace.dayBoundaryHour',
  'tokenPace.keybindings',
  'tokenPace.planName',
  // Pace
  'tokenPace.pace.sensitivity',
  'tokenPace.pace.tolerancePoints',
  'tokenPace.pace.minElapsedPercent',
  'tokenPace.pace.levels',
  // Status bar
  'tokenPace.barWidth',
  'tokenPace.barStyle',
  'tokenPace.barGlyphs',
  'tokenPace.timeProgressStyle',
  'tokenPace.indicator',
  'tokenPace.colorMode',
  'tokenPace.percentMode',
  'tokenPace.overflowDisplay',
  'tokenPace.resetFormat',
  'tokenPace.resetHourCycle',
  'tokenPace.showAgeInItem',
  'tokenPace.labels',
  'tokenPace.labelMaxChars',
  'tokenPace.summary.period',
  'tokenPace.summary.scope',
  'tokenPace.tooltip',
  'tokenPace.tooltipExplanations',
  // Dashboard
  'tokenPace.dashboard.sections',
  'tokenPace.dashboard.defaultRange',
  'tokenPace.dashboard.modelRows',
  'tokenPace.dashboard.topN',
  'tokenPace.dashboard.mode',
  'tokenPace.startOfWeek',
  'tokenPace.planPriceUsd',
  'tokenPace.calibration.show',
  // Cost
  'tokenPace.showCost',
  'tokenPace.customPrices',
  'tokenPace.pricing.multiplier',
  'tokenPace.pricing.showListPrice',
  'tokenPace.unknownModelPricing',
  'tokenPace.budgets',
  // Quota sources
  'tokenPace.quotaSource',
  'tokenPace.pollIntervalMinutes',
  'tokenPace.claudeQuotaSources',
  'tokenPace.codexQuotaSources',
  'tokenPace.claudeQuotaFile',
  'tokenPace.codexQuotaFile',
  'tokenPace.writeQuotaCache',
  'tokenPace.codexAppServer.mode',
  'tokenPace.codexBinary',
  'tokenPace.userAgent',
  'tokenPace.credentials.keychain',
  'tokenPace.pollOnlyWhenFocused',
  'tokenPace.leaderElection',
  // Paths
  'tokenPace.claudeDir',
  'tokenPace.codexDir',
  // Data & privacy
  'tokenPace.hourRetentionDays',
  'tokenPace.retentionDays',
  'tokenPace.quotaHistoryDays',
  'tokenPace.attribution',
  'tokenPace.showProjectNames',
  // Alerts
  'tokenPace.alerts.thresholds',
  'tokenPace.alerts.basis',
  'tokenPace.alerts.requireAhead',
  'tokenPace.alerts.minRemainingMinutes',
  'tokenPace.alerts.useItLoseIt',
  'tokenPace.alerts.forecastLeadMinutes',
  'tokenPace.alerts.onPaceFast',
  'tokenPace.alerts.windowCondition',
  'tokenPace.alerts.budgetPercent',
  // Diagnostics
  'tokenPace.debug',
  'tokenPace.debugLogFile',
  'tokenPace.diagnostics.includeNetworkSetup',
]

// ---------------------------------------------------------------------------
// Value domains — the single place where the allowed members of every enum and
// array live. `sanitize` filters against these, the manifest repeats them.
// ---------------------------------------------------------------------------

export type StatusBarEntry =
  | 'claudeQuota' | 'codexQuota' | 'extra' | 'context' | 'tokens' | 'cost' | 'forecast'
  | 'budget'
export type WindowSelect = 'all' | 'leading' | 'worstPace' | 'session' | 'weekly' | 'auto'
export type LegacyWindows = 'all' | 'leading'
export type Density = 'full' | 'compact' | 'minimal'
export type ClickAction = 'dashboard' | 'menu' | 'refresh' | 'openWebsite'
export type Alignment = 'left' | 'right'

export type Sensitivity = 'relaxed' | 'normal' | 'strict' | 'custom'
export type PaceLevels = 'binary' | 'graded'

export type BarStyle = 'line' | 'shade' | 'none'
export type BarGlyphs = 'blocks' | 'shapes' | 'dots' | 'pie'
export type TimeProgressStyle = 'marker' | 'bar' | 'none'
export type Indicator = 'color' | 'glyph' | 'both' | 'none'
export type ColorMode = 'theme' | 'monochrome'
export type PercentMode = 'used' | 'remaining'
export type OverflowDisplay = 'clamp' | 'actual'
export type ResetFormat = 'none' | 'relative' | 'absolute' | 'both'
export type HourCycle = 'auto' | 'h12' | 'h23'
export type ShowAgeInItem = 'never' | 'whenStale' | 'always'
export type SummaryPeriod = 'today' | '7d' | '30d'
export type SummaryScope = 'both' | 'claude' | 'codex'
export type TooltipMode = 'full' | 'compact' | 'off'

export type DashboardSection =
  | 'summary' | 'quota' | 'context' | 'kpis' | 'tokens' | 'chart' | 'models' | 'heatmap'
  | 'hours' | 'records' | 'tools' | 'budget' | 'forecast' | 'history' | 'projects'
  | 'sessions' | 'dataQuality'
export type DefaultRange =
  | 'today' | '7d' | '30d' | '90d' | 'thisWeek' | 'thisMonth' | 'lastMonth' | 'year' | 'all'
export type DashboardMode = 'webview' | 'quickPick' | 'markdown'
export type StartOfWeek =
  | 'monday' | 'tuesday' | 'wednesday' | 'thursday' | 'friday' | 'saturday' | 'sunday'

export type UnknownModelPricing = 'strict' | 'family'

export type QuotaSource = 'auto' | 'poll' | 'cache'
export type ClaudeSourceId = 'cacheFile' | 'statusline' | 'claudeJson' | 'poll'
export type CodexSourceId = 'cacheFile' | 'transcript' | 'poll'
export type AppServerMode = 'oneShot' | 'persistent'
export type UserAgentMode = 'claudeCode' | 'honest'

export type Attribution = 'none' | 'project' | 'session'
export type ProjectNameMode = 'basename' | 'hash'

export type AlertBasis = 'used' | 'remaining'
export type AlertWindowCondition = 'any' | 'sessionOnly' | 'weeklyOnly'

const STATUS_BAR_ENTRIES: readonly StatusBarEntry[] = [
  'claudeQuota', 'codexQuota', 'extra', 'context', 'tokens', 'cost', 'forecast', 'budget',
]
const WINDOW_SELECTS: readonly WindowSelect[] = ['all', 'leading', 'worstPace', 'session', 'weekly', 'auto']
const LEGACY_WINDOWS: readonly LegacyWindows[] = ['all', 'leading']
const DENSITIES: readonly Density[] = ['full', 'compact', 'minimal']
const CLICK_ACTIONS: readonly ClickAction[] = ['dashboard', 'menu', 'refresh', 'openWebsite']
const ALIGNMENTS: readonly Alignment[] = ['left', 'right']
const SENSITIVITIES: readonly Sensitivity[] = ['relaxed', 'normal', 'strict', 'custom']
const PACE_LEVELS: readonly PaceLevels[] = ['binary', 'graded']
const BAR_STYLES: readonly BarStyle[] = ['line', 'shade', 'none']
const BAR_GLYPHS: readonly BarGlyphs[] = ['blocks', 'shapes', 'dots', 'pie']
const TIME_PROGRESS_STYLES: readonly TimeProgressStyle[] = ['marker', 'bar', 'none']
const INDICATORS: readonly Indicator[] = ['color', 'glyph', 'both', 'none']
const COLOR_MODES: readonly ColorMode[] = ['theme', 'monochrome']
const PERCENT_MODES: readonly PercentMode[] = ['used', 'remaining']
const OVERFLOW_DISPLAYS: readonly OverflowDisplay[] = ['clamp', 'actual']
const RESET_FORMATS: readonly ResetFormat[] = ['none', 'relative', 'absolute', 'both']
const HOUR_CYCLES: readonly HourCycle[] = ['auto', 'h12', 'h23']
const SHOW_AGE: readonly ShowAgeInItem[] = ['never', 'whenStale', 'always']
const SUMMARY_PERIODS: readonly SummaryPeriod[] = ['today', '7d', '30d']
const SUMMARY_SCOPES: readonly SummaryScope[] = ['both', 'claude', 'codex']
const TOOLTIP_MODES: readonly TooltipMode[] = ['full', 'compact', 'off']
const DASHBOARD_SECTIONS: readonly DashboardSection[] = [
  'summary', 'quota', 'context', 'kpis', 'tokens', 'chart', 'models', 'heatmap',
  'hours', 'records', 'tools', 'budget', 'forecast', 'history', 'projects', 'sessions',
  'dataQuality',
]
const DEFAULT_RANGES: readonly DefaultRange[] = [
  'today', '7d', '30d', '90d', 'thisWeek', 'thisMonth', 'lastMonth', 'year', 'all',
]
const DASHBOARD_MODES: readonly DashboardMode[] = ['webview', 'quickPick', 'markdown']
const START_OF_WEEK: readonly StartOfWeek[] = [
  'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday',
]
const UNKNOWN_MODEL_PRICING: readonly UnknownModelPricing[] = ['strict', 'family']
const QUOTA_SOURCES: readonly QuotaSource[] = ['auto', 'poll', 'cache']
const CLAUDE_SOURCE_IDS: readonly ClaudeSourceId[] = ['cacheFile', 'statusline', 'claudeJson', 'poll']
const CODEX_SOURCE_IDS: readonly CodexSourceId[] = ['cacheFile', 'transcript', 'poll']
const APP_SERVER_MODES: readonly AppServerMode[] = ['oneShot', 'persistent']
const USER_AGENT_MODES: readonly UserAgentMode[] = ['claudeCode', 'honest']
const ATTRIBUTIONS: readonly Attribution[] = ['none', 'project', 'session']
const PROJECT_NAME_MODES: readonly ProjectNameMode[] = ['basename', 'hash']
const ALERT_BASES: readonly AlertBasis[] = ['used', 'remaining']
const ALERT_WINDOW_CONDITIONS: readonly AlertWindowCondition[] = ['any', 'sessionOnly', 'weeklyOnly']

const DEFAULT_STATUS_BAR: readonly StatusBarEntry[] = ['claudeQuota', 'codexQuota', 'tokens']
const DEFAULT_SECTIONS: readonly DashboardSection[] = [
  'summary', 'quota', 'kpis', 'tokens', 'chart', 'models', 'heatmap', 'hours', 'forecast', 'dataQuality',
]
const DEFAULT_CLAUDE_SOURCES: readonly ClaudeSourceId[] = ['cacheFile', 'statusline', 'claudeJson', 'poll']
const DEFAULT_CODEX_SOURCES: readonly CodexSourceId[] = ['cacheFile', 'transcript', 'poll']
/** One threshold out of the box: 90 % is late enough to be rare and early enough to act on. */
const DEFAULT_THRESHOLDS: readonly number[] = [90]

/**
 * Per-model price override, in USD per 1M tokens. Every field is optional and merges
 * field-wise over the built-in table, so a user can correct a single rate without having to
 * restate a whole price row (and without accidentally zeroing the ones they omitted).
 */
export interface CustomPrice {
  input?: number
  output?: number
  cacheRead?: number
  cacheWrite5m?: number
  cacheWrite1h?: number
  /** Fast-mode rates (input/output); both required, because a half-stated pair is not a price. */
  fast?: { input: number; output: number }
}

const PRICE_FIELDS: readonly ('input' | 'output' | 'cacheRead' | 'cacheWrite5m' | 'cacheWrite1h')[] = [
  'input', 'output', 'cacheRead', 'cacheWrite5m', 'cacheWrite1h',
]

// ---------------------------------------------------------------------------
// The Config shape
// ---------------------------------------------------------------------------

export interface Config {
  statusBar: { show: StatusBarEntry[] }
  windowSelect: WindowSelect
  /** Raw value of the deprecated `tokenPace.windows`; already folded into `windowSelect`. */
  windows: LegacyWindows
  density: Density
  clickAction: ClickAction
  usagePageLinks: boolean
  alignment: Alignment
  staleAfterMinutes: number
  /** Whether the manifest's one keybinding is active; read by VS Code, not by us. */
  keybindings: boolean
  /** Display-only plan names, per provider. Never a limit and never a denominator. */
  planName: { claude?: string; codex?: string }

  pace: {
    sensitivity: Sensitivity
    tolerancePoints: number
    minElapsedPercent: number
    levels: PaceLevels
  }

  barWidth: number
  barStyle: BarStyle
  barGlyphs: BarGlyphs
  timeProgressStyle: TimeProgressStyle
  indicator: Indicator
  colorMode: ColorMode
  percentMode: PercentMode
  overflowDisplay: OverflowDisplay
  resetFormat: ResetFormat
  resetHourCycle: HourCycle
  showAgeInItem: ShowAgeInItem
  labels: Record<string, string>
  labelMaxChars: number
  summary: { period: SummaryPeriod; scope: SummaryScope }
  tooltip: TooltipMode
  tooltipExplanations: boolean

  dashboard: {
    sections: DashboardSection[]
    defaultRange: DefaultRange
    modelRows: number
    /** Rows per Records table. A cap on a top list, never on what is counted. */
    topN: number
    mode: DashboardMode
  }
  timezone: string
  dayBoundaryHour: number
  startOfWeek: StartOfWeek
  planPriceUsd: { claude?: number; codex?: number }
  calibration: { show: boolean }

  showCost: boolean
  customPrices: Record<string, CustomPrice>
  pricing: { multiplier: number; showListPrice: boolean }
  unknownModelPricing: UnknownModelPricing
  /** The user's own limits, already cleaned; an unusable entry was dropped whole. */
  budgets: BudgetSpec[]

  quotaSource: QuotaSource
  pollIntervalMinutes: number
  claudeQuotaSources: ClaudeSourceId[]
  codexQuotaSources: CodexSourceId[]
  claudeQuotaFile: string
  codexQuotaFile: string
  writeQuotaCache: boolean
  codexAppServer: { mode: AppServerMode }
  codexBinary: string
  userAgent: UserAgentMode
  credentials: { keychain: boolean }
  pollOnlyWhenFocused: boolean
  leaderElection: boolean

  /** Normalised to a list of trimmed, non-empty paths; empty means "use the defaults". */
  claudeDir: string[]
  codexDir: string[]

  hourRetentionDays: number
  retentionDays: number
  quotaHistoryDays: number
  attribution: Attribution
  showProjectNames: ProjectNameMode

  alerts: {
    thresholds: number[]
    basis: AlertBasis
    requireAhead: boolean
    minRemainingMinutes: number
    useItLoseIt: boolean
    forecastLeadMinutes: number
    onPaceFast: boolean
    windowCondition: AlertWindowCondition
    /** Percentage of a budget at which one notification is shown; `0` is off. */
    budgetPercent: number
  }

  debug: boolean
  debugLogFile: string
  diagnostics: { includeNetworkSetup: boolean }
}

// ---------------------------------------------------------------------------
// Structural configs handed to the pure modules. Declared here rather than
// imported so that config.ts stays independent of time.ts / pace.ts / alerts.ts;
// the shapes are those of spec §3.1, §3.2 and §3.16.
// ---------------------------------------------------------------------------

export interface TimeConfig {
  zone: string
  dayBoundaryHour: number
  startOfWeek: StartOfWeek
  hourCycle: HourCycle
}

export interface PaceConfig {
  sensitivity: Sensitivity
  tolerancePoints: number
  minElapsedPercent: number
  levels: PaceLevels
}

export interface AlertConfig {
  thresholds: number[]
  basis: AlertBasis
  requireAhead: boolean
  minRemainingMinutes: number
  useItLoseIt: boolean
  forecastLeadMinutes: number
  onPaceFast: boolean
  windowCondition: AlertWindowCondition
}

// ---------------------------------------------------------------------------
// Validators
// ---------------------------------------------------------------------------

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** Finite numbers only, clamped to the manifest range; `"10m"`, NaN and ∞ give the default. */
function num(raw: unknown, def: number, min: number, max: number): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return def
  return Math.min(max, Math.max(min, raw))
}

function bool(raw: unknown, def: boolean): boolean {
  return typeof raw === 'boolean' ? raw : def
}

function pick<T extends string>(raw: unknown, allowed: readonly T[], def: T): T {
  return typeof raw === 'string' && (allowed as readonly string[]).includes(raw) ? (raw as T) : def
}

/** Keeps the user's order (it is the display order) and drops unknowns and duplicates. */
function list<T extends string>(raw: unknown, allowed: readonly T[], def: readonly T[]): T[] {
  if (!Array.isArray(raw)) return [...def]
  const out: T[] = []
  for (const v of raw) {
    if (typeof v !== 'string') continue
    if (!(allowed as readonly string[]).includes(v)) continue
    if (out.includes(v as T)) continue
    out.push(v as T)
  }
  return out
}

function text(raw: unknown, def = ''): string {
  return typeof raw === 'string' && raw.trim() !== '' ? raw.trim() : def
}

/** A path setting may be a single string or a list of them; the result is always a list. */
function pathList(raw: unknown): string[] {
  const src = Array.isArray(raw) ? raw : [raw]
  const out: string[] = []
  for (const v of src) {
    if (typeof v !== 'string') continue
    const t = v.trim()
    if (t === '' || out.includes(t)) continue
    out.push(t)
  }
  return out
}

function labelMap(raw: unknown): Record<string, string> {
  const out: Record<string, string> = {}
  if (!isRecord(raw)) return out
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value !== 'string') continue
    const k = key.trim()
    if (k === '') continue
    out[k] = value.slice(0, 40)
  }
  return out
}

function priceMap(raw: unknown): Record<string, CustomPrice> {
  const out: Record<string, CustomPrice> = {}
  if (!isRecord(raw)) return out
  for (const [model, value] of Object.entries(raw)) {
    const name = model.trim()
    if (name === '' || !isRecord(value)) continue
    const price: CustomPrice = {}
    for (const field of PRICE_FIELDS) {
      const n = value[field]
      // A negative or non-finite rate is not a price; leaving it out keeps the built-in
      // value rather than turning the model into a free one.
      if (typeof n === 'number' && Number.isFinite(n) && n >= 0) price[field] = n
    }
    const fast = value.fast
    if (isRecord(fast)) {
      const fi = fast.input
      const fo = fast.output
      if (typeof fi === 'number' && Number.isFinite(fi) && fi >= 0 &&
          typeof fo === 'number' && Number.isFinite(fo) && fo >= 0) price.fast = { input: fi, output: fo }
    }
    if (Object.keys(price).length > 0) out[name] = price
  }
  return out
}

/**
 * The plan names, trimmed and cut at 40 characters like `labels` — the same rule, because it
 * is the same kind of value: a word the user chose that we print beside a provider title.
 */
function planNames(raw: unknown): { claude?: string; codex?: string } {
  const out: { claude?: string; codex?: string } = {}
  if (!isRecord(raw)) return out
  for (const key of ['claude', 'codex'] as const) {
    const v = raw[key]
    if (typeof v !== 'string') continue
    const t = v.trim().slice(0, 40)
    if (t !== '') out[key] = t
  }
  return out
}

function planPrices(raw: unknown): { claude?: number; codex?: number } {
  const out: { claude?: number; codex?: number } = {}
  if (!isRecord(raw)) return out
  for (const key of ['claude', 'codex'] as const) {
    const n = raw[key]
    if (typeof n === 'number' && Number.isFinite(n) && n > 0) out[key] = n
  }
  return out
}

/**
 * A non-array (an unset setting, a hand-edited string) yields the manifest default; an
 * explicit empty array stays empty, because "no notifications at all" is a choice.
 */
function alertThresholds(raw: unknown): number[] {
  if (!Array.isArray(raw)) return [...DEFAULT_THRESHOLDS]
  const out: number[] = []
  for (const v of raw) {
    if (typeof v !== 'number' || !Number.isFinite(v)) continue
    if (v <= 0 || v > 200) continue
    const rounded = Math.round(v * 10) / 10
    if (!out.includes(rounded)) out.push(rounded)
  }
  return out.sort((a, b) => a - b)
}

// ---------------------------------------------------------------------------
// sanitize / readConfig
// ---------------------------------------------------------------------------

/**
 * Turns a raw `{ 'tokenPace.<key>': value }` map into a `Config`. Pure: no vscode, no fs,
 * no clock — which is what makes the validation testable.
 */
export function sanitize(raw: Record<string, unknown>): Config {
  const get = (key: string): unknown => raw[key]

  // The deprecated `tokenPace.windows` only speaks while `windowSelect` is untouched, so an
  // existing "leading" configuration keeps working but never overrides a deliberate choice.
  // The test is presence, not value: since 1.1 the default is 'worstPace', which is also a
  // value people write out by hand, and comparing against it would silently discard theirs.
  const rawSelect = get('tokenPace.windowSelect')
  const selectIsSet = typeof rawSelect === 'string' && (WINDOW_SELECTS as readonly string[]).includes(rawSelect)
  const legacyWindows = pick(get('tokenPace.windows'), LEGACY_WINDOWS, 'all')
  let windowSelect = pick(rawSelect, WINDOW_SELECTS, 'worstPace')
  if (!selectIsSet && legacyWindows === 'leading') windowSelect = 'leading'

  return {
    statusBar: { show: list(get('tokenPace.statusBar.show'), STATUS_BAR_ENTRIES, DEFAULT_STATUS_BAR) },
    windowSelect,
    windows: legacyWindows,
    density: pick(get('tokenPace.density'), DENSITIES, 'full'),
    clickAction: pick(get('tokenPace.clickAction'), CLICK_ACTIONS, 'dashboard'),
    usagePageLinks: bool(get('tokenPace.usagePageLinks'), true),
    alignment: pick(get('tokenPace.alignment'), ALIGNMENTS, 'left'),
    staleAfterMinutes: num(get('tokenPace.staleAfterMinutes'), 20, 1, 1440),
    keybindings: bool(get('tokenPace.keybindings'), true),
    planName: planNames(get('tokenPace.planName')),

    pace: {
      sensitivity: pick(get('tokenPace.pace.sensitivity'), SENSITIVITIES, 'normal'),
      tolerancePoints: num(get('tokenPace.pace.tolerancePoints'), 5, 0, 20),
      minElapsedPercent: num(get('tokenPace.pace.minElapsedPercent'), 3, 0, 20),
      levels: pick(get('tokenPace.pace.levels'), PACE_LEVELS, 'binary'),
    },

    barWidth: num(get('tokenPace.barWidth'), 8, 0, 20),
    barStyle: pick(get('tokenPace.barStyle'), BAR_STYLES, 'line'),
    barGlyphs: pick(get('tokenPace.barGlyphs'), BAR_GLYPHS, 'blocks'),
    timeProgressStyle: pick(get('tokenPace.timeProgressStyle'), TIME_PROGRESS_STYLES, 'marker'),
    indicator: pick(get('tokenPace.indicator'), INDICATORS, 'both'),
    colorMode: pick(get('tokenPace.colorMode'), COLOR_MODES, 'theme'),
    percentMode: pick(get('tokenPace.percentMode'), PERCENT_MODES, 'used'),
    overflowDisplay: pick(get('tokenPace.overflowDisplay'), OVERFLOW_DISPLAYS, 'actual'),
    resetFormat: pick(get('tokenPace.resetFormat'), RESET_FORMATS, 'relative'),
    resetHourCycle: pick(get('tokenPace.resetHourCycle'), HOUR_CYCLES, 'auto'),
    showAgeInItem: pick(get('tokenPace.showAgeInItem'), SHOW_AGE, 'whenStale'),
    labels: labelMap(get('tokenPace.labels')),
    labelMaxChars: num(get('tokenPace.labelMaxChars'), 0, 0, 40),
    summary: {
      period: pick(get('tokenPace.summary.period'), SUMMARY_PERIODS, 'today'),
      scope: pick(get('tokenPace.summary.scope'), SUMMARY_SCOPES, 'both'),
    },
    tooltip: pick(get('tokenPace.tooltip'), TOOLTIP_MODES, 'full'),
    tooltipExplanations: bool(get('tokenPace.tooltipExplanations'), false),

    dashboard: {
      sections: list(get('tokenPace.dashboard.sections'), DASHBOARD_SECTIONS, DEFAULT_SECTIONS),
      defaultRange: pick(get('tokenPace.dashboard.defaultRange'), DEFAULT_RANGES, '30d'),
      modelRows: num(get('tokenPace.dashboard.modelRows'), 12, 0, 500),
      topN: Math.trunc(num(get('tokenPace.dashboard.topN'), 5, 1, 20)),
      mode: pick(get('tokenPace.dashboard.mode'), DASHBOARD_MODES, 'webview'),
    },
    timezone: text(get('tokenPace.timezone'), 'system'),
    dayBoundaryHour: Math.trunc(num(get('tokenPace.dayBoundaryHour'), 0, 0, 23)),
    startOfWeek: pick(get('tokenPace.startOfWeek'), START_OF_WEEK, 'monday'),
    planPriceUsd: planPrices(get('tokenPace.planPriceUsd')),
    calibration: { show: bool(get('tokenPace.calibration.show'), false) },

    showCost: bool(get('tokenPace.showCost'), true),
    customPrices: priceMap(get('tokenPace.customPrices')),
    pricing: {
      multiplier: num(get('tokenPace.pricing.multiplier'), 1, 0.01, 10),
      showListPrice: bool(get('tokenPace.pricing.showListPrice'), false),
    },
    unknownModelPricing: pick(get('tokenPace.unknownModelPricing'), UNKNOWN_MODEL_PRICING, 'strict'),
    budgets: sanitizeBudgets(get('tokenPace.budgets')),

    quotaSource: pick(get('tokenPace.quotaSource'), QUOTA_SOURCES, 'auto'),
    pollIntervalMinutes: num(get('tokenPace.pollIntervalMinutes'), 30, 5, 1440),
    claudeQuotaSources: list(get('tokenPace.claudeQuotaSources'), CLAUDE_SOURCE_IDS, DEFAULT_CLAUDE_SOURCES),
    codexQuotaSources: list(get('tokenPace.codexQuotaSources'), CODEX_SOURCE_IDS, DEFAULT_CODEX_SOURCES),
    claudeQuotaFile: text(get('tokenPace.claudeQuotaFile')),
    codexQuotaFile: text(get('tokenPace.codexQuotaFile')),
    writeQuotaCache: bool(get('tokenPace.writeQuotaCache'), false),
    codexAppServer: { mode: pick(get('tokenPace.codexAppServer.mode'), APP_SERVER_MODES, 'oneShot') },
    codexBinary: text(get('tokenPace.codexBinary')),
    userAgent: pick(get('tokenPace.userAgent'), USER_AGENT_MODES, 'claudeCode'),
    credentials: { keychain: bool(get('tokenPace.credentials.keychain'), true) },
    pollOnlyWhenFocused: bool(get('tokenPace.pollOnlyWhenFocused'), true),
    leaderElection: bool(get('tokenPace.leaderElection'), true),

    claudeDir: pathList(get('tokenPace.claudeDir')),
    codexDir: pathList(get('tokenPace.codexDir')),

    hourRetentionDays: num(get('tokenPace.hourRetentionDays'), 45, 1, 3650),
    retentionDays: num(get('tokenPace.retentionDays'), 400, 60, 36500),
    quotaHistoryDays: num(get('tokenPace.quotaHistoryDays'), 30, 0, 90),
    attribution: pick(get('tokenPace.attribution'), ATTRIBUTIONS, 'none'),
    showProjectNames: pick(get('tokenPace.showProjectNames'), PROJECT_NAME_MODES, 'basename'),

    alerts: {
      thresholds: alertThresholds(get('tokenPace.alerts.thresholds')),
      basis: pick(get('tokenPace.alerts.basis'), ALERT_BASES, 'used'),
      requireAhead: bool(get('tokenPace.alerts.requireAhead'), true),
      minRemainingMinutes: num(get('tokenPace.alerts.minRemainingMinutes'), 60, 0, 10080),
      useItLoseIt: bool(get('tokenPace.alerts.useItLoseIt'), false),
      forecastLeadMinutes: num(get('tokenPace.alerts.forecastLeadMinutes'), 0, 0, 1440),
      onPaceFast: bool(get('tokenPace.alerts.onPaceFast'), false),
      windowCondition: pick(get('tokenPace.alerts.windowCondition'), ALERT_WINDOW_CONDITIONS, 'any'),
      budgetPercent: num(get('tokenPace.alerts.budgetPercent'), 0, 0, 200),
    },

    debug: bool(get('tokenPace.debug'), false),
    debugLogFile: text(get('tokenPace.debugLogFile')),
    diagnostics: { includeNetworkSetup: bool(get('tokenPace.diagnostics.includeNetworkSetup'), true) },
  }
}

/** Reads and validates the current settings. The only function here that touches vscode. */
export function readConfig(): Config {
  // Required lazily so that the validating half of this module stays loadable outside the
  // extension host (tests, and any future non-vscode consumer).
  const vscode = require('vscode') as typeof import('vscode')
  const c = vscode.workspace.getConfiguration()
  const raw: Record<string, unknown> = {}
  for (const key of CONFIG_KEYS) raw[key] = c.get(key)
  return sanitize(raw)
}

/** Structural stand-in for `vscode.ConfigurationChangeEvent`, so this stays vscode-free. */
export interface ConfigurationChangeLike {
  affectsConfiguration(section: string): boolean
}

/** True when the change touches any of `keys` (with or without the `tokenPace.` prefix). */
export function affects(e: ConfigurationChangeLike, keys: string[]): boolean {
  for (const key of keys) {
    const full = key.startsWith('tokenPace.') ? key : `tokenPace.${key}`
    if (e.affectsConfiguration(full)) return true
  }
  return false
}

// ---------------------------------------------------------------------------
// Wording that more than one renderer needs
//
// The view model and the status bar render independently — the bar is deliberately free of
// the view model so it can be built without it — so a sentence both of them say has to live
// somewhere both of them already import. That is this module, and the alternative is two
// copies of one promise drifting apart.
// ---------------------------------------------------------------------------

/**
 * What the context window is, said wherever it is shown.
 *
 * It describes one Claude Code conversation as the status line reported it: not the account,
 * not comparable to a quota window, and not something Token Pace could count for itself.
 */
export const CONTEXT_NOTE = 'current session, via the status line'

/** Where a plan name came from. A configured one is always labelled as such where it prints. */
export type PlanSource = 'provider' | 'configured'

/**
 * The plan name to show for a provider, and who said it.
 *
 * The provider's own word always wins; `tokenPace.planName` is a fallback the user typed, and
 * it is marked as configured everywhere it appears — a name someone wrote into a settings file
 * is not a reading. Neither kind is ever turned into a limit: no plan name implies a quota
 * here, which is why this returns a label and nothing else.
 *
 * One rule in one place: the quota card, the three views, the export and the status-bar
 * tooltip all print the result of this function, so they cannot disagree about the suffix.
 */
export function planNameOf(
  cfg: Config,
  source: 'claude' | 'codex',
  provided: string | null,
): { name: string; from: PlanSource } | null {
  if (typeof provided === 'string' && provided.trim() !== '') {
    return { name: provided.trim(), from: 'provider' }
  }
  const configured = cfg.planName[source]
  return configured ? { name: configured, from: 'configured' } : null
}

/** `plan Max 20x` or `plan Max 20x (as configured)`; null when no name is known. */
export function planText(plan: { name: string; from: PlanSource } | null): string | null {
  if (plan === null) return null
  return plan.from === 'configured' ? `plan ${plan.name} (as configured)` : `plan ${plan.name}`
}

export function readTimeConfig(cfg: Config): TimeConfig {
  return {
    zone: cfg.timezone,
    dayBoundaryHour: cfg.dayBoundaryHour,
    startOfWeek: cfg.startOfWeek,
    hourCycle: cfg.resetHourCycle,
  }
}

export function readPaceConfig(cfg: Config): PaceConfig {
  return {
    sensitivity: cfg.pace.sensitivity,
    tolerancePoints: cfg.pace.tolerancePoints,
    minElapsedPercent: cfg.pace.minElapsedPercent,
    levels: cfg.pace.levels,
  }
}

/**
 * The alert settings, plus the budget level.
 *
 * `budgetPercent` is not part of `AlertConfig`: that interface describes the quota alerts,
 * which every existing caller builds by hand. The intersection keeps the field required for
 * whoever reads a real configuration and optional for whoever builds one in a test.
 */
export function readAlertConfig(cfg: Config): AlertConfig & { budgetPercent: number } {
  return {
    thresholds: [...cfg.alerts.thresholds],
    basis: cfg.alerts.basis,
    requireAhead: cfg.alerts.requireAhead,
    minRemainingMinutes: cfg.alerts.minRemainingMinutes,
    useItLoseIt: cfg.alerts.useItLoseIt,
    forecastLeadMinutes: cfg.alerts.forecastLeadMinutes,
    onPaceFast: cfg.alerts.onPaceFast,
    windowCondition: cfg.alerts.windowCondition,
    budgetPercent: cfg.alerts.budgetPercent,
  }
}
