// SPDX-FileCopyrightText: 2026 Frederik Marx
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Every word the status bar says, as pure functions.
 *
 * `statusbar.ts` only creates items and copies fields onto them; every decision — which
 * windows are shown, what a state is called, which repair a broken state offers, how a
 * tooltip reads — lives here. That keeps the whole surface testable without an extension
 * host, and it gives `docs/status-bar-states.md` exactly one implementation to mirror.
 *
 * No `vscode` import, ever: this module is loaded by the test bundle.
 */

import { LABEL, SOURCES, SOURCE_TITLE as TITLE, USAGE_PAGE } from './adapters'
import { billable, BucketFilter, CostSummary } from './agg'
import { BudgetRow, worstBudget } from './budget'
import { Config, contextNote, oneLine, planNameOf, readPaceConfig, readTimeConfig } from './config'
import { lockoutText } from './forecast'
import { t } from './i18n'
import { paceVerdict, windowDisplay, WindowDisplay, windowElapsed } from './pace'
import { isCustomPricing, PricingOptions } from './prices'
import { promptCacheText } from './promptCache'
// Type only: this module renders, it never reads a file, and `quotaSources` does.
import type { ContextReading, PromptCacheReading } from './quotaSources'
import {
  ageMinutes, BarOptions, compact, estimate, extraUsageText, full, originName, percentOf,
  percentText, renderBar, usd,
} from './render'
import { ageText, formatReset, formatTime, lastDays, relativeShort, TimeConfig } from './time'
import {
  Bucket, emptyBucket, Forecast, PaceLevel, PaceVerdict, ProblemKind, QuotaState,
  QuotaWindow, Source,
} from './types'

// ---------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------

/**
 * The provider vocabulary all comes from the registry: the terse prefix `LABEL`
 * (`tokenPace.labels` overrides it), the full `TITLE`, and the provider's own usage page.
 * `USAGE_PAGE` is re-exported because the command that opens the page must link to exactly
 * the address the tooltip shows.
 */
export { USAGE_PAGE }

/**
 * Foreground per pace level. The first three ids are contributed by this extension with a
 * default for all four theme variants; `error` borrows `charts.red`, which the workbench
 * registers everywhere — an exhausted window normally carries the alarm background instead,
 * so this colour only ever shows on overflow.
 */
const PACE_COLOR: Record<PaceLevel, string> = {
  ok: 'tokenPace.paceOk',
  warn: 'tokenPace.paceWarn',
  warn2: 'tokenPace.paceAhead',
  error: 'charts.red',
}
const STALE_COLOR = 'tokenPace.stale'
const EXTRA_COLOR = 'charts.blue'

/** VS Code's alarm background; the item text carries `$(warning)` as well, because high
 *  contrast themes do not register every status bar background colour. */
export const ALARM_BACKGROUND = 'statusBarItem.errorBackground'

export type Role = 'leader' | 'follower' | 'single'
export type ConsentState = 'granted' | 'denied' | 'unasked'

// ---------------------------------------------------------------------------
// Input and output shapes
// ---------------------------------------------------------------------------

/**
 * The two `Aggregator` methods the status bar needs, as a structural type: tests pass a
 * hand-made object, the extension passes the real aggregator, and this module does not
 * have to know about either.
 */
export interface UsageSource {
  sum(from: string, to: string, tcfg: TimeConfig, filter?: BucketFilter): Bucket
  cost(from: string, to: string, tcfg: TimeConfig, pricing: PricingOptions, filter?: BucketFilter): CostSummary
}

export interface StatusTextInput {
  quotas: QuotaState[]
  agg: UsageSource
  cfg: Config
  now: number
  /** Key `${source}:${window.id}` → forecast, computed by the caller. Absent = none. */
  forecasts: Map<string, Forecast>
  role: Role
  scanning: boolean
  consent: ConsentState
  /**
   * The Claude context window the status line last reported, or null. One session, not the
   * account — absent when the bridge is not connected, and never derived from anything else.
   */
  context?: ContextReading | null
  /**
   * The prompt cache the status line last reported, or null. One row of the Claude tooltip
   * while the bridge delivers it; absent otherwise, never estimated.
   */
  promptCache?: PromptCacheReading | null
  /**
   * The budget rows of the last view-model build. Optional, because every caller that only
   * renders quota (the preview, most tests) has none — and an absent list is no entry, not a
   * zero: a budget nobody configured is not a budget at 0 %.
   */
  budgets?: BudgetRow[]
}

/** One status bar entry, fully decided. The vscode layer copies these fields verbatim. */
export interface ItemModel {
  /** Stable, content-bound id: VS Code remembers per-id visibility across restarts. */
  id: string
  text: string
  /** Theme colour id for the foreground, or null for the default (and always null when
   *  `alarm` is set — a background replaces the foreground). */
  colorId: string | null
  /** Draw with `statusBarItem.errorBackground`. */
  alarm: boolean
  /** Markdown source; empty string means "no tooltip" (`tokenPace.tooltip: off`). */
  tooltipMarkdown: string
  command: string | null
  commandArgs?: unknown[]
  /** Human-readable name for the status bar's own context menu. */
  name: string
  /** The priority as a string, highest first — 1000 minus the item's position. */
  priorityKey: string
}

export type ItemSpec =
  | { kind: 'window'; q: QuotaState; w: QuotaWindow }
  | { kind: 'problem'; q: QuotaState }
  | { kind: 'extra'; q: QuotaState }
  | { kind: 'forecast'; q: QuotaState }
  | { kind: 'compact'; q: QuotaState }
  | { kind: 'summary'; sources: Source[] }
  | { kind: 'context'; c: ContextReading }
  | { kind: 'budget'; b: BudgetRow }
  | { kind: 'tokens' }
  | { kind: 'cost' }

export interface RenderContext extends StatusTextInput {
  tcfg: TimeConfig
  pricing: PricingOptions
  /** Synthetic data: the preview must never look like a reading. */
  preview: boolean
}

export function makeContext(input: StatusTextInput, preview = false): RenderContext {
  return {
    ...input,
    tcfg: readTimeConfig(input.cfg),
    pricing: {
      overrides: input.cfg.customPrices,
      multiplier: input.cfg.pricing.multiplier,
      unknownModel: input.cfg.unknownModelPricing,
    },
    preview,
  }
}

// ---------------------------------------------------------------------------
// Small helpers — every one of them refuses to render a number it does not have
// ---------------------------------------------------------------------------

function finite(n: number | null | undefined): n is number {
  return typeof n === 'number' && Number.isFinite(n)
}

function fetchedMs(q: QuotaState): number | null {
  return finite(q.fetchedAt) && q.fetchedAt > 0 ? q.fetchedAt * 1000 : null
}

export function isStale(q: QuotaState, cfg: Config, now: number): boolean {
  const age = ageMinutes(q.fetchedAt, now)
  return age !== null && age > cfg.staleAfterMinutes
}

/** Age of a reading in status bar shorthand: "12m", "3h", "2d". Null when unknown. */
export function ageShort(fetchedAtSec: number | null, now: number): string | null {
  if (!finite(fetchedAtSec) || fetchedAtSec <= 0) return null
  const min = (now - fetchedAtSec * 1000) / 60000
  // A reading from the future is a clock problem, not an age; saying nothing beats lying.
  if (!Number.isFinite(min) || min < 0) return null
  if (min < 1) return '<1m'
  if (min < 60) return `${Math.round(min)}m`
  const h = min / 60
  if (h < 48) return `${Math.round(h)}h`
  return `${Math.round(h / 24)}d`
}

function spanText(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '0 min'
  const min = Math.round(ms / 60000)
  if (min < 90) return `${min} min`
  const h = ms / 3_600_000
  if (h < 48) return `${h < 10 ? Math.round(h * 10) / 10 : Math.round(h)} h`
  return `${Math.round(h / 24)} d`
}

/**
 * A token count, or a dash when there is nothing. `stats.ts` applies the same rule to the
 * identical figures for the dashboard and the markdown view — "0" would claim a measurement
 * where there is none, and the cost item next to it already dashes on exact zero.
 * Counts (requests) keep their literal 0: a count of nothing is a measurement.
 */
function tokenText(n: number): string {
  return n > 0 ? compact(n) : '–'
}

/** Truncates a label we derived from provider data; user-set labels are left alone. */
function clip(s: string, max: number): string {
  if (!Number.isFinite(max) || max <= 0 || s.length <= max) return s
  return s.slice(0, Math.max(1, max - 1)) + '…'
}

export function providerLabel(source: Source, cfg: Config): string {
  const own = cfg.labels[source]
  return own !== undefined ? own : LABEL[source]
}

export function windowLabel(w: QuotaWindow, cfg: Config): string {
  const own = cfg.labels[w.id]
  return own !== undefined ? own : clip(w.shortLabel ?? '', cfg.labelMaxChars)
}

export function summaryLabel(cfg: Config): string {
  const own = cfg.labels.summary
  return own !== undefined ? own : 'TP'
}

// ---------------------------------------------------------------------------
// Window selection
// ---------------------------------------------------------------------------

const LEVEL_RANK: Record<PaceLevel, number> = { ok: 0, warn: 1, warn2: 2, error: 3 }

/** Below this, `windowSelect: auto` considers the session quiet enough to show the week. */
export const AUTO_SESSION_QUIET_PERCENT = 30

export interface WindowView {
  w: QuotaWindow
  display: WindowDisplay
  /** Share of the window's own clock already gone, 0..100; null without a length. */
  elapsed: number | null
  verdict: PaceVerdict
  level: PaceLevel
}

export function viewOf(q: QuotaState, w: QuotaWindow, cfg: Config, now: number): WindowView {
  const elapsed = windowElapsed(w.resetsAt, w.windowMinutes, now)
  const verdict = paceVerdict(w.percent, elapsed, readPaceConfig(cfg))
  return { w, display: windowDisplay(w, fetchedMs(q), now), elapsed, verdict, level: verdict.level }
}

/**
 * Which of a provider's windows reach the status bar.
 *
 * Every filter falls back to the full list rather than to nothing: a user who asked for
 * "session only" against a provider that reports no session window is better served by the
 * windows that exist than by an empty bar they cannot explain.
 */
export function selectWindows(q: QuotaState, cfg: Config, now: number): QuotaWindow[] {
  const ws = q.windows.filter((w) => w && typeof w.id === 'string')
  if (ws.length === 0) return []
  switch (cfg.windowSelect) {
    case 'leading': {
      let best = ws[0]
      for (const w of ws) if (finite(w.percent) && (!finite(best.percent) || w.percent > best.percent)) best = w
      return [best]
    }
    case 'worstPace': {
      let best = ws[0]
      let bestRank = -1
      let bestPercent = -1
      for (const w of ws) {
        const v = viewOf(q, w, cfg, now)
        const rank = LEVEL_RANK[v.level]
        const p = finite(w.percent) ? w.percent : -1
        if (rank > bestRank || (rank === bestRank && p > bestPercent)) {
          best = w
          bestRank = rank
          bestPercent = p
        }
      }
      return [best]
    }
    case 'session': {
      const list = ws.filter((w) => w.kind === 'session')
      return list.length > 0 ? list : ws
    }
    case 'weekly': {
      const list = ws.filter((w) => w.kind === 'weekly')
      return list.length > 0 ? list : ws
    }
    case 'auto': {
      const sessions = ws.filter((w) => w.kind === 'session')
      if (sessions.length === 0) return ws
      return autoQuiet(sessions) ? ws : sessions
    }
    default:
      return ws
  }
}

function autoQuiet(sessions: QuotaWindow[]): boolean {
  return sessions.every((w) => finite(w.percent) && w.percent < AUTO_SESSION_QUIET_PERCENT)
}

/** The sentence that explains what `windowSelect: auto` decided, for the tooltip. */
export function autoExplain(q: QuotaState, cfg: Config): string | null {
  if (cfg.windowSelect !== 'auto') return null
  const sessions = q.windows.filter((w) => w.kind === 'session')
  if (sessions.length === 0) return t('auto: showing every window — this provider reports no session window')
  return autoQuiet(sessions)
    ? t('auto: showing every window — every session window is below {0} %', AUTO_SESSION_QUIET_PERCENT)
    : t('auto: showing session windows only — a session window is at or above {0} %', AUTO_SESSION_QUIET_PERCENT)
}

/** The window that decides the colour of a collective item: worst level, then highest use. */
export function worstView(views: WindowView[]): WindowView | null {
  let best: WindowView | null = null
  for (const v of views) {
    if (best === null) { best = v; continue }
    const rank = LEVEL_RANK[v.level] - LEVEL_RANK[best.level]
    if (rank > 0) { best = v; continue }
    if (rank === 0 && finite(v.w.percent) && (!finite(best.w.percent) || v.w.percent > best.w.percent)) best = v
  }
  return best
}

// ---------------------------------------------------------------------------
// Item text
// ---------------------------------------------------------------------------

/** State glyphs that stay in the text at every density — they are the state, not decoration. */
function statePrefix(display: WindowDisplay): string {
  if (display === 'exhausted') return '$(warning) '
  if (display === 'limitReached') return '⛔ '
  return ''
}

/**
 * The two states that must survive every channel being switched off. `$(warning)` is an
 * icon, `⛔` is an emoji and the alarm background is a colour — `indicator: color`,
 * `colorMode: monochrome` and high-contrast themes each remove one of them, so the state is
 * said in plain words as well. The wording is the one `viewModel.ts` uses.
 */
export function stateWord(display: WindowDisplay): string | null {
  if (display === 'exhausted') return t('exhausted')
  if (display === 'limitReached') return t('limit reached')
  return null
}

/**
 * The figure plus, where there is one, the state in words: `25%`, `100% exhausted`, `∞`.
 *
 * `state: false` drops the word for a caller that already prints it in a column of its own;
 * "100% exhausted … exhausted" is one fact stated twice, not two facts.
 */
export function windowValue(view: WindowView, cfg: Config, opts: { state?: boolean } = {}): string {
  if (view.display === 'unlimited') return '∞'
  if (view.display === 'resetDue') return t('reset due')
  const figure = percentText(view.w.percent, cfg.percentMode, cfg.overflowDisplay)
  const word = stateWord(view.display)
  return word === null || opts.state === false ? figure : `${figure} ${word}`
}

function barFor(view: WindowView, cfg: Config): string {
  // The pie glyph set ignores the width, so a width of 0 still has something to draw.
  if (cfg.barWidth <= 0 && cfg.barGlyphs !== 'pie') return ''
  if (cfg.barStyle === 'none' && cfg.barGlyphs === 'blocks' && cfg.barWidth <= 0) return ''
  if (view.display === 'unlimited') return ''
  const due = view.display === 'resetDue'
  const opts: BarOptions = {
    width: cfg.barWidth,
    style: cfg.barStyle,
    glyphs: cfg.barGlyphs,
    // A window whose reset has passed gets an empty track: the old fill would be a claim
    // about a window that no longer exists.
    marker: due || cfg.timeProgressStyle === 'none' ? null : view.elapsed,
    markerStyle: due ? 'none' : cfg.timeProgressStyle,
    remaining: cfg.percentMode === 'remaining',
  }
  const bar = renderBar(due ? 0 : view.w.percent, opts)
  return bar === '' ? '' : ` ${bar}`
}

/**
 * The non-colour half of the pace signal. Suppressed where a state glyph already says the
 * same thing, so the text never reads "$(warning) … 100% !".
 */
function indicatorGlyph(view: WindowView, cfg: Config): string {
  if (cfg.indicator !== 'glyph' && cfg.indicator !== 'both') return ''
  if (view.display === 'unlimited' || view.display === 'resetDue') return ''
  if (statePrefix(view.display) !== '') return ''
  switch (view.level) {
    case 'warn': return ' ▲'
    case 'warn2': return ' ▲▲'
    case 'error': return ' !'
    default: return ''
  }
}

function resetSuffix(view: WindowView, cfg: Config, now: number, tcfg: TimeConfig): string {
  if (view.display === 'resetDue') return ''
  const text = formatReset(view.w.resetsAt, now, cfg.resetFormat, tcfg)
  if (text === '') return ''
  // A window the provider still calls exhausted or limit-reached keeps that display even
  // once its reset time has passed, and the countdown then reads "reset due" — a sentence of
  // its own, not a duration to hang "resets" in front of. Asked of the clock rather than of
  // the rendered words: "reset due" is itself translated, and a search for the English
  // phrase would stop matching in every other language.
  const due = finite(view.w.resetsAt) && (view.w.resetsAt as number) <= now && cfg.resetFormat !== 'absolute'
  if (due) return ` · ${text}`
  // Always named. A bare "· 42m" next to a percentage is unreadable beside the stale-age
  // suffix, which is also a bare duration — one of the two has to say what it counts, and
  // the age already carries `$(history)`, so the reset carries the word.
  //
  // Two messages, not one with a slot: a countdown and a time of day take different
  // prepositions in most languages ("in 3h44m" against "um 15:30"), and the seam keys a
  // translation by its English message, so one message can only carry one of them.
  return cfg.resetFormat === 'relative'
    ? ` · ${t('resets {0}', text)}`
    : ` · ${t('resets at {0}', text)}`
}

function ageSuffix(q: QuotaState, stale: boolean, cfg: Config, now: number): string {
  if (cfg.showAgeInItem === 'never') return ''
  if (cfg.showAgeInItem === 'whenStale' && !stale) return ''
  const a = ageShort(q.fetchedAt, now)
  return a === null ? '' : ` $(history) ${a}`
}

/** `CC 5h ██┃▁▁▁▁▁ 25% · 2h14m` */
export function windowText(q: QuotaState, view: WindowView, ctx: RenderContext): string {
  const { cfg, now, tcfg } = ctx
  const stale = isStale(q, cfg, now)
  return statePrefix(view.display)
    + `${providerLabel(q.source, cfg)} ${windowLabel(view.w, cfg)}`
    + barFor(view, cfg)
    + ` ${windowValue(view, cfg)}`
    + indicatorGlyph(view, cfg)
    + resetSuffix(view, cfg, now, tcfg)
    + ageSuffix(q, stale, cfg, now)
}

function colorFor(view: WindowView, stale: boolean, cfg: Config): { colorId: string | null; alarm: boolean } {
  // A stale reading may not raise an alarm: the state it describes may be long gone.
  const alarm = (view.display === 'exhausted' || view.display === 'limitReached') && !stale
  if (alarm) return { colorId: null, alarm: true }
  if (cfg.colorMode !== 'theme') return { colorId: null, alarm: false }
  if (stale || view.display === 'resetDue') return { colorId: STALE_COLOR, alarm: false }
  if (cfg.indicator !== 'color' && cfg.indicator !== 'both') return { colorId: null, alarm: false }
  if (view.display === 'unlimited') return { colorId: null, alarm: false }
  return { colorId: PACE_COLOR[view.level], alarm: false }
}

// ---------------------------------------------------------------------------
// Problem states
// ---------------------------------------------------------------------------

export interface ProblemView {
  kind: ProblemKind
  icon: string
  message: string
  command: string
  args?: unknown[]
  /** What the state means, in one sentence. */
  explain: string
  /** The one thing to check — mirrored in docs/status-bar-states.md. */
  check: string
}

/**
 * One row of the state matrix. Every state names a cause and offers the repair that
 * belongs to it; "CC –" is reserved for the causes that genuinely have no name.
 */
export function problemView(q: QuotaState, cfg: Config, now: number): ProblemView {
  const kind: ProblemKind = q.problemKind ?? 'unknown'
  const codex = q.source === 'codex'
  switch (kind) {
    case 'noToken':
      return {
        kind, icon: '$(key)', message: t('no token'), command: 'tokenPace.showOutput',
        explain: t('No credentials were found, so the quota cannot be polled.'),
        check: codex
          ? t('Check: run `codex login`, then fetch again. The log names the lookup that failed.')
          : t('Check: sign in to Claude Code (`claude`), or set `CLAUDE_CODE_OAUTH_TOKEN`. The log names the lookup that failed — it never contains the token itself.'),
      }
    case 'tokenExpired':
      return {
        kind, icon: '$(warning)', message: t('token expired'), command: 'tokenPace.showOutput',
        explain: t('The stored credentials are past their expiry. This extension never refreshes a token.'),
        check: t('Check: sign in again in the CLI; the next poll picks the new token up automatically.'),
      }
    case 'consentPending':
      return {
        kind, icon: '$(shield)', message: t('consent'), command: 'tokenPace.refreshQuota',
        explain: t('Network access has not been granted yet, so no request was made.'),
        check: t('Check: click here — the fetch asks for consent once and remembers the answer.'),
      }
    case 'retry': {
      const at = finite(q.nextAttemptAt) ? relativeShort(q.nextAttemptAt as number, now) : null
      return {
        kind, icon: '$(clock)', message: at ? t('retry {0}', at) : t('retry'),
        command: 'tokenPace.refreshQuota',
        explain: t('The last attempt failed; the next one is scheduled after a backoff.'),
        check: t('Check: the log holds the reason. Clicking here retries immediately.'),
      }
    }
    case 'offline':
      return {
        kind, icon: '$(cloud-offline)', message: t('offline'), command: 'tokenPace.refreshQuota',
        explain: t('The request did not reach the provider (timeout, DNS or proxy).'),
        check: t('Check: connectivity, and `http.proxy` — Copy Diagnostics lists the proxy settings in effect.'),
      }
    case 'quotaOff':
      return {
        kind, icon: '$(circle-slash)', message: t('quota off'), command: 'tokenPace.openSettings',
        explain: t('No quota source is enabled for this provider.'),
        check: t('Check: `tokenPace.claudeQuotaSources` / `tokenPace.codexQuotaSources`.'),
      }
    case 'modeCache':
      return {
        kind, icon: '$(circle-slash)', message: t('quota off'), command: 'tokenPace.openSettings',
        explain: t('`tokenPace.quotaSource` is `cache`: only a local file is read, the network is never used.'),
        check: t('Check: point `tokenPace.claudeQuotaFile` / `tokenPace.codexQuotaFile` at a cache file, or switch the mode to `auto`.'),
      }
    case 'forbidden':
      return {
        kind, icon: '$(lock)', message: '403', command: 'tokenPace.showOutput',
        explain: t('The provider refused the usage endpoint (HTTP 403). This may mean a Team or Enterprise account without a usage endpoint — token counts keep working.'),
        check: t('Check: the official usage page in the browser; if it works there and not here, the endpoint is not available for this account.'),
      }
    case 'unauthorized':
      return {
        kind, icon: '$(key)', message: t('sign in'), command: 'tokenPace.showOutput',
        explain: t('The provider rejected the credentials (HTTP 401).'),
        check: t('Check: sign in again in the CLI. The token is only read, never refreshed.'),
      }
    case 'noBinary':
      return {
        kind, icon: '$(circle-slash)', message: codex ? t('no codex') : t('no binary'),
        command: 'tokenPace.openSettings',
        explain: t('The provider CLI was not found on PATH, so its app-server could not be asked.'),
        check: t('Check: `tokenPace.codexBinary`, or install the CLI.'),
      }
    case 'noFile':
      return {
        kind, icon: '', message: '–', command: 'tokenPace.rescan',
        explain: t('The configured quota cache file does not exist.'),
        check: t('Check: `tokenPace.claudeQuotaFile` / `tokenPace.codexQuotaFile`, or enable another source.'),
      }
    case 'paused':
      // Raised only by a cache file whose `blocked_until` is still in the future: the external
      // poller that owns the file is backing off. Nothing in this extension is paused, and a
      // fetch of our own is refused outside `quotaSource: poll` — so only that mode is offered one.
      return {
        kind, icon: '$(clock)', message: t('paused'),
        command: cfg.quotaSource === 'poll' ? 'tokenPace.refreshQuota' : 'tokenPace.showOutput',
        explain: t('The external poller that writes the quota cache file is in backoff; its reading stands still until the pause ends (the reported reason names the time).'),
        check: t('Check: nothing here is broken. The file is written by that poller, not by this extension — switch `tokenPace.quotaSource` to `poll` to fetch independently of it.'),
      }
    case 'follower':
      return {
        kind, icon: '', message: '–', command: 'tokenPace.showDashboard',
        explain: t('Another VS Code window holds the lease and polls; this one only displays what that window wrote.'),
        check: t('Check: nothing. Set `tokenPace.leaderElection` to false if every window should poll on its own.'),
      }
    case 'empty':
      return {
        kind, icon: '', message: '–', command: 'tokenPace.rescan',
        explain: t('The source answered, but carried no window this build can read.'),
        check: t('Check: the log lists the fields that were seen; unknown window kinds are reported, not dropped.'),
      }
    default:
      return {
        kind: 'unknown', icon: '', message: '–', command: 'tokenPace.showOutput',
        explain: q.problem ? t('The quota could not be read.') : t('No quota reading is available.'),
        check: t('Check: the log holds the raw reason. Clicking here tries again.'),
      }
  }
}

/** `$(key) CC no token` — the label always stays visible, at every density. */
export function problemText(q: QuotaState, cfg: Config, now: number): string {
  const p = problemView(q, cfg, now)
  const label = providerLabel(q.source, cfg)
  return p.icon === '' ? `${label} ${p.message}` : `${p.icon} ${label} ${p.message}`
}

// ---------------------------------------------------------------------------
// Tooltip building blocks
// ---------------------------------------------------------------------------

function colorSpan(colorId: string, text: string): string {
  return `<span style="color:var(--vscode-${colorId.replace(/\./g, '-')});">${text}</span>`
}

/**
 * A borrowed string — a provider's label, a model name, an error text — inside a code span.
 * The tooltip is a trusted MarkdownString with HTML enabled, so a value carrying `**`, `|`,
 * a tag or a backtick would rewrite the markup around it instead of printing; the span
 * neutralises the first three and `oneLine` removes the backtick that would end the span.
 */
function span(s: string): string {
  return `\`${oneLine(String(s))}\``
}

function titleLine(q: QuotaState, cfg: Config): string {
  const name = TITLE[q.source]
  const head = cfg.usagePageLinks ? `**[${name}](${USAGE_PAGE[q.source]})**` : `**${name}**`
  // Same rule and same wording as the quota card: the provider's word, else the configured
  // name marked as configured. The tooltip is the only place in the bar that says it at all.
  // The name itself goes in a code span, like every other string this file takes from a
  // provider or a settings file: the tooltip is a trusted MarkdownString with HTML enabled,
  // so a name carrying `**`, `|` or a tag would rewrite the markup around it instead of
  // printing. The suffix stays outside the span — it is our word, not theirs.
  const plan = planNameOf(cfg, q.source, q.planType)
  if (plan === null) return head
  const named = plan.from === 'configured'
    ? t('plan {0} (as configured)', span(plan.name))
    : t('plan {0}', span(plan.name))
  return `${head} · ${named}`
}

/** In the tooltip a reset is spelled out; `none` would leave the column empty for no gain. */
function tooltipReset(w: QuotaWindow, cfg: Config, now: number, tcfg: TimeConfig): string {
  const fmt = cfg.resetFormat === 'none' ? 'both' : cfg.resetFormat
  const text = formatReset(w.resetsAt, now, fmt, tcfg)
  return text === '' ? '–' : text
}

function windowRow(view: WindowView, cfg: Config, now: number, tcfg: TimeConfig): string {
  const bar = renderBar(view.display === 'resetDue' ? 0 : view.w.percent, {
    width: 10,
    style: cfg.barStyle,
    glyphs: cfg.barGlyphs,
    marker: view.display === 'resetDue' ? null : view.elapsed,
    markerStyle: cfg.timeProgressStyle === 'none' ? 'none' : 'marker',
    remaining: cfg.percentMode === 'remaining',
  })
  const painted = cfg.colorMode === 'theme' ? colorSpan(PACE_COLOR[view.level], bar) : bar
  const elapsed = view.elapsed === null ? '–' : `${Math.round(view.elapsed)} %`
  // The Pace column stands right beside the value here, so the state word is dropped from
  // the value whenever that column already carries exactly it.
  const value = windowValue(view, cfg, { state: stateWord(view.display) !== view.verdict.text })
  // A window still measuring has no pace to report yet; the column says so with the same
  // dash every other absent figure gets, not with a sentence about the measuring.
  const pace = view.verdict.measuring ? '–' : view.verdict.text
  return `| ${span(view.w.label)} | ${painted} ${value} | ${elapsed} | ${pace} | `
    + `${tooltipReset(view.w, cfg, now, tcfg)} |`
}

function forecastLine(q: QuotaState, w: QuotaWindow, ctx: RenderContext): string | null {
  const f = ctx.forecasts.get(`${q.source}:${w.id}`)
  if (!f) return null
  // A forecast still measuring has nothing to say about the window yet — "measuring · 1
  // reading over 0 min" reports on the forecast, not on the quota — so it is not a line.
  if (f.state !== 'eta' && f.state !== 'resetsFirst' && f.state !== 'idle') return null
  const bits: string[] = []
  // The forecast text already carries its own "~"; estimates are never shown bare.
  if (f.text !== '') bits.push(f.text)
  const lock = lockoutText(f, ctx.now, (ms) => formatTime(ms, ctx.tcfg))
  if (lock !== null) bits.push(lock)
  if (f.basis && f.basis.samples > 0) {
    // Two whole sentences rather than a noun glued into one: the plural of "reading" is not
    // the only thing that changes with the count in every language.
    bits.push(f.basis.samples === 1
      ? t('based on {0} reading over {1}', f.basis.samples, spanText(f.basis.spanMs))
      : t('based on {0} readings over {1}', f.basis.samples, spanText(f.basis.spanMs)))
  }
  if (bits.length === 0) return null
  return `$(graph) ${span(w.shortLabel)}: ${bits.join(' · ')}`
}

function freshnessLine(q: QuotaState, cfg: Config, now: number): string {
  const origin = q.origin ? originName(q.origin) : null
  const age = ageText(q.fetchedAt, now)
  if (age === null) return origin ? t('No reading yet · {0}', origin) : t('No reading yet')
  const suffix = isStale(q, cfg, now) ? ` · $(warning) **${t('stale')}**` : ''
  return `${origin ? t('Updated {0} · {1}', age, origin) : t('Updated {0}', age)}${suffix}`
}

/** Icons outside, sentence inside — the glyph is the same in every language. */
function followerNote(): string {
  return `$(info) ${t('another window polls and writes the data; this one only displays it')}`
}

function scanningNote(): string {
  return `$(sync~spin) ${t('reading history … the token figures below are still growing')}`
}

/**
 * The action row. Only this extension's own argument-less commands are linked; a link that
 * would do nothing in the current state is rendered as plain text instead of lying about it.
 */
export function footerLine(ctx: RenderContext): string {
  const blocked = ctx.consent === 'denied' || ctx.cfg.quotaSource === 'cache' || ctx.role === 'follower'
  const fetchNow = t('Fetch now')
  const fetch = blocked ? `$(sync) ${fetchNow}` : `$(sync) [${fetchNow}](command:tokenPace.refreshQuota)`
  return [
    fetch,
    `$(history) [${t('Re-read')}](command:tokenPace.rescan)`,
    `$(output) [${t('Log')}](command:tokenPace.showOutput)`,
    `$(settings-gear) [${t('Settings')}](command:tokenPace.openSettings)`,
    `$(dashboard) [${t('Dashboard')}](command:tokenPace.showDashboard)`,
  ].join(' · ')
}

// ---------------------------------------------------------------------------
// Usage tables
// ---------------------------------------------------------------------------

const PERIOD_DAYS: Record<Config['summary']['period'], number> = { today: 1, '7d': 7, '30d': 30 }

/** The period in words, asked for when it is printed rather than when this module loads. */
function periodLabel(period: Config['summary']['period']): string {
  if (period === 'today') return t('today')
  return period === '7d' ? t('7 days') : t('30 days')
}

/**
 * The period as the two summary items spell it, beside the figure and inside a bar that has
 * no room for a sentence.
 *
 * "today" is a word and is translated; "7d" and "30d" are the same compact spans the
 * dashboard's range chips print in every language, so a German word for them here alone
 * would give the reader two names for one range. Never the raw setting value for "today",
 * though — that was the one period a reader was left to read in English.
 */
function periodSuffix(period: Config['summary']['period']): string {
  return period === 'today' ? t('today') : period
}

function scopeSources(cfg: Config): Source[] {
  if (cfg.summary.scope === 'claude') return ['claude']
  if (cfg.summary.scope === 'codex') return ['codex']
  return [...SOURCES]
}

function periodRange(ctx: RenderContext): { from: string; to: string } {
  const days = lastDays(PERIOD_DAYS[ctx.cfg.summary.period], ctx.now, ctx.tcfg)
  return { from: days[0], to: days[days.length - 1] }
}

/** Fresh input + cache write + output — the figure that means "usage"; cache reads would swamp it. */
function billableOf(ctx: RenderContext, from: string, to: string, source: Source): number {
  return billable(ctx.agg.sum(from, to, ctx.tcfg, { source }))
}

function usageTable(source: Source, ctx: RenderContext): string[] {
  const days = lastDays(30, ctx.now, ctx.tcfg)
  const today = days[days.length - 1]
  const week = days[Math.max(0, days.length - 7)]
  const withCost = ctx.cfg.showCost
  const out: string[] = [t('{0} — tokens', `**${TITLE[source]}**`), '']
  // A whole header row per key: the pipes are the table, and a column name that travels
  // alone reads differently in a language that has one word for two of them.
  out.push(withCost
    ? t('| Period | Usage | Output | Cache read | Req. | API cost |')
    : t('| Period | Usage | Output | Cache read | Req. |'))
  out.push(withCost ? '|---|---|---|---|---|---|' : '|---|---|---|---|---|')

  const row = (label: string, from: string, to: string): void => {
    const b = ctx.agg.sum(from, to, ctx.tcfg, { source })
    // Without a terminal line the output figure is a floor, not a total.
    const partial = b.requests > 0 && b.outputFinal < b.requests
    let line = `| ${label} | ${tokenText(billable(b))} | ${tokenText(b.output)}${partial ? ' ⚠' : ''} | `
      + `${tokenText(b.cacheRead)} | ${compact(b.requests)} |`
    if (withCost) {
      const c = ctx.agg.cost(from, to, ctx.tcfg, ctx.pricing, { source })
      const money = c.usd === 0 ? '–' : estimate(usd(c.usd))
      line += ` ${money}${c.unpricedTokens > 0 || c.fastUnpricedTokens > 0 ? ' ⚠' : ''} |`
    }
    out.push(line)
  }
  row(t('today'), today, today)
  row(t('7 days'), week, today)
  row(t('30 days'), days[0], today)

  const d = ctx.agg.sum(today, today, ctx.tcfg, { source })
  out.push('')
  out.push(compositionLine(d, source))

  if (d.requests > 0 && d.outputFinal < d.requests) {
    const pct = Math.round((1 - d.outputFinal / d.requests) * 100)
    out.push('')
    out.push(`⚠ ${t("{0} % of today's responses have no terminal line — the output figure is a **lower bound**.", pct)}`)
  }
  if (withCost) {
    const c = ctx.agg.cost(days[0], today, ctx.tcfg, ctx.pricing, { source })
    if (c.unpricedTokens > 0) {
      out.push('')
      out.push(`⚠ ${t('{0} tokens have no price ({1}) — they are missing from the cost, not billed at a guess.', compact(c.unpricedTokens), c.unpricedModels.map(span).join(', ') || t('unknown model'))}`)
    }
    if (c.fastUnpricedTokens > 0) {
      out.push('')
      out.push(`⚠ ${t('{0} fast-mode tokens have no published fast rate and are left out.', compact(c.fastUnpricedTokens))}`)
    }
    if (c.familyPriced.length > 0) {
      out.push('')
      out.push(`⚠ ${t('priced from a family fallback: {0}.', c.familyPriced.map(span).join(', '))}`)
    }
  }
  return out
}

/** The fields the aggregator collects and nothing else displays. */
function compositionLine(b: Bucket, source: Source): string {
  const fresh = source === 'codex' ? Math.max(0, b.input - b.cacheRead) : b.input
  // Claude reports cache reads against fresh input; Codex counts them inside `input`.
  const hit = source === 'codex'
    ? percentOf(b.cacheRead, b.input)
    : percentOf(b.cacheRead, b.input + b.cacheRead)
  const w1h = b.cacheWrite1h > 0 ? ` (1 h ${compact(b.cacheWrite1h)})` : ''
  // One key for the whole line: six labelled figures whose order a translator may need to
  // change, and the "1 h" parenthesis rides along inside its own placeholder.
  return t('today: fresh {0} · cache write {1}{2} · cache read {3} · output {4} · reasoning {5} · cache hit {6}',
    tokenText(fresh), tokenText(b.cacheWrite), w1h, tokenText(b.cacheRead), tokenText(b.output),
    tokenText(b.reasoning), hit)
}

function provenanceLine(ctx: RenderContext, hasQuota: boolean): string {
  // Whole phrases, not a list assembled from translated words: "measured" governs what
  // follows it, and the two shapes this line can take are worth two keys.
  const parts = [hasQuota ? t('measured: quota, tokens') : t('measured: tokens')]
  if (ctx.cfg.showCost) parts.push(t('estimated: ~API cost'))
  return `_${parts.join(' · ')}_`
}

function explanations(ctx: RenderContext, opts: { quota: boolean; codex: boolean }): string[] {
  if (!ctx.cfg.tooltipExplanations) return []
  const out: string[] = []
  if (opts.quota) {
    out.push('')
    out.push(`_${t('“Elapsed” is how much of the window’s own time has passed. Usage above it means you are ahead of the clock; the verdict names the difference in percent of the window.')}_`)
    out.push('')
    out.push(`_${t('The percentage comes from the provider and covers **all** clients (desktop app and browser included). It cannot be derived from the token counts below.')}_`)
  }
  out.push('')
  out.push(`_${t('“Usage” is fresh input + cache write + output; cache reads are listed separately because they outweigh everything else by orders of magnitude.')}_`)
  if (opts.codex) {
    out.push('')
    out.push(`_${t('For Codex, “Req.” counts `token_count` events — a single turn can produce several, so it is not a message count.')}_`)
  }
  if (ctx.cfg.showCost) {
    out.push('')
    out.push(`_${isCustomPricing(ctx.pricing)
      ? t('API cost is hypothetical and computed **at your configured rates**: what this usage would have cost through the API. On a subscription you do not pay it.')
      : t('API cost is hypothetical: what this usage would have cost through the provider’s API at list prices. On a subscription you do not pay it.')}_`)
  }
  return out
}

// ---------------------------------------------------------------------------
// Tooltips
// ---------------------------------------------------------------------------

/** Compact mode caps the table so the whole tooltip stays inside its twelve-line budget. */
const COMPACT_MAX_ROWS = 4

function quotaBlock(q: QuotaState, ctx: RenderContext, compactMode: boolean): string[] {
  const { cfg, now, tcfg } = ctx
  const out: string[] = [titleLine(q, cfg), '']
  out.push(cfg.percentMode === 'remaining'
    ? t('| Window | Remaining | Elapsed | Pace | Resets |')
    : t('| Window | Used | Elapsed | Pace | Resets |'))
  out.push('|---|---|---|---|---|')
  const windows = compactMode ? q.windows.slice(0, COMPACT_MAX_ROWS) : q.windows
  for (const w of windows) out.push(windowRow(viewOf(q, w, cfg, now), cfg, now, tcfg))
  if (compactMode) return out

  const forecasts: string[] = []
  for (const w of q.windows) {
    const line = forecastLine(q, w, ctx)
    if (line !== null) forecasts.push(line)
  }
  if (forecasts.length > 0) {
    out.push('')
    out.push(forecasts.join('\n\n'))
  }
  // The bridge's prompt-cache line, the same words as the dashboard card: one session's
  // cache, only while the status line reports it, with a dash for every part it left out.
  if (q.source === 'claude' && ctx.promptCache) {
    out.push('')
    const pc = promptCacheText(ctx.promptCache, now, (ms) => formatTime(ms, tcfg), cfg.staleAfterMinutes)
    // The age of the reading, beside the line it built: the freshness row below belongs to
    // the quota state, which may come from a different and much newer source.
    const seen = [pc.ageText ? t('updated {0}', pc.ageText) : null,
      pc.fresh ? null : `$(warning) **${t('stale')}**`].filter(Boolean).join(' · ')
    out.push(`$(database) ${pc.text}${seen ? ` · ${seen}` : ''}`)
  }
  const auto = autoExplain(q, cfg)
  if (auto !== null) {
    out.push('')
    out.push(`_${auto}_`)
  }
  const extra = extraUsageText(q.extra)
  if (extra !== null) {
    out.push('')
    // Purchased usage is a separate pot and is never folded into the plan windows.
    out.push(t('Extra usage: {0}', q.extra?.enabled ? `**${extra}**` : extra))
  }
  if (q.partial === true) {
    out.push('')
    out.push(`$(warning) ${t('partial data: only some sources answered.')}`)
  }
  return out
}

export function quotaTooltip(q: QuotaState, ctx: RenderContext): string {
  const { cfg } = ctx
  if (cfg.tooltip === 'off') return ''
  const compactMode = cfg.tooltip === 'compact'
  const out = quotaBlock(q, ctx, compactMode)
  out.push('')
  out.push(freshnessLine(q, cfg, ctx.now))
  if (compactMode) {
    out.push('')
    out.push(footerLine(ctx))
    return out.join('\n')
  }
  if (ctx.role === 'follower') {
    out.push('')
    out.push(`_${followerNote()}_`)
  }
  if (ctx.scanning) {
    out.push('')
    out.push(`_${scanningNote()}_`)
  }
  out.push('')
  out.push(...usageTable(q.source, ctx))
  out.push('')
  out.push(provenanceLine(ctx, true))
  out.push(...explanations(ctx, { quota: true, codex: q.source === 'codex' }))
  out.push('')
  out.push(footerLine(ctx))
  return out.join('\n')
}

/** Tooltip of the collective item: every provider, then the token tables. */
export function summaryTooltip(sources: Source[], ctx: RenderContext): string {
  const { cfg } = ctx
  if (cfg.tooltip === 'off') return ''
  const compactMode = cfg.tooltip === 'compact'
  const out: string[] = []
  const states = ctx.quotas.filter((q) => sources.includes(q.source))
  for (const q of states) {
    if (out.length > 0) out.push('')
    if (q.ok) {
      out.push(...quotaBlock(q, ctx, compactMode))
      out.push('')
      out.push(freshnessLine(q, cfg, ctx.now))
    } else {
      const p = problemView(q, cfg, ctx.now)
      out.push(`**${t('{0} — quota unavailable', TITLE[q.source])}**`)
      out.push('')
      out.push(p.explain)
    }
  }
  if (compactMode) {
    out.push('')
    out.push(footerLine(ctx))
    return out.join('\n')
  }
  out.push('')
  out.push(...tokenBody(ctx))
  out.push('')
  out.push(provenanceLine(ctx, states.length > 0))
  out.push(...explanations(ctx, { quota: true, codex: sources.includes('codex') }))
  out.push('')
  out.push(footerLine(ctx))
  return out.join('\n')
}

function tokenBody(ctx: RenderContext): string[] {
  const out: string[] = []
  for (const s of scopeSources(ctx.cfg)) {
    if (out.length > 0) out.push('')
    out.push(...usageTable(s, ctx))
  }
  return out
}

export function tokenTooltip(ctx: RenderContext, what: 'tokens' | 'cost'): string {
  const { cfg } = ctx
  if (cfg.tooltip === 'off') return ''
  const period = periodLabel(cfg.summary.period)
  const head = what === 'tokens'
    ? `**${t('Tokens — {0}', period)}**`
    : `**${t('API cost — {0}', period)}** ${t('(hypothetical)')}`
  const out: string[] = [head]
  if (ctx.scanning) {
    out.push('')
    out.push(`_${scanningNote()}_`)
  }
  if (cfg.tooltip === 'compact') {
    const { from, to } = periodRange(ctx)
    for (const s of scopeSources(cfg)) {
      const b = ctx.agg.sum(from, to, ctx.tcfg, { source: s })
      out.push('')
      out.push(t('{0}: {1} usage · {2} output · {3} req.',
        TITLE[s], tokenText(billable(b)), tokenText(b.output), compact(b.requests)))
    }
    out.push('')
    out.push(footerLine(ctx))
    return out.join('\n')
  }
  out.push('')
  out.push(...tokenBody(ctx))
  if (ctx.role === 'follower') {
    out.push('')
    out.push(`_${followerNote()}_`)
  }
  out.push('')
  out.push(provenanceLine(ctx, false))
  out.push(...explanations(ctx, { quota: false, codex: scopeSources(cfg).includes('codex') }))
  out.push('')
  out.push(footerLine(ctx))
  return out.join('\n')
}

// ---------------------------------------------------------------------------
// Context window — one Claude Code session, straight from the status line
// ---------------------------------------------------------------------------

/**
 * `42%`, or the token count when the payload named no window size.
 *
 * A percentage needs a denominator; without one there is nothing to be a share of, so the
 * item shows what it has — tokens — and says nothing about how full anything is.
 */
export function contextValue(c: ContextReading): string {
  if (c.size !== null && finite(c.usedPct)) return `${Math.round(c.usedPct as number)}%`
  if (c.size !== null) return `${compact(c.used)}/${compact(c.size)}`
  return compact(c.used)
}

/** Same rule as a quota item: the age is shown when the setting asks, or when it is stale. */
function contextAgeSuffix(c: ContextReading, cfg: Config, now: number): string {
  if (cfg.showAgeInItem === 'never') return ''
  const age = ageMinutes(c.fetchedAt, now)
  const stale = age !== null && age > cfg.staleAfterMinutes
  if (cfg.showAgeInItem === 'whenStale' && !stale) return ''
  const a = ageShort(c.fetchedAt, now)
  return a === null ? '' : ` $(history) ${a}`
}

export function contextTooltip(c: ContextReading, ctx: RenderContext): string {
  const { cfg } = ctx
  if (cfg.tooltip === 'off') return ''
  const out: string[] = [`**${t('Context window')}**`, '']
  out.push(c.size === null
    ? t('{0} tokens in the conversation', full(c.used))
    : t('{0} of {1} tokens', full(c.used), full(c.size))
      + (finite(c.usedPct) ? ` · ${Math.round(c.usedPct as number)} %` : ''))
  out.push('')
  // The whole reason this item is safe to show: it is one conversation, not the account, and
  // it is a mirrored reading rather than something we counted.
  out.push(`_${t('This is the {0} — not an account figure, and not comparable to a quota window.', contextNote())}_`)
  const age = ageText(c.fetchedAt, ctx.now)
  if (age !== null) {
    out.push('')
    out.push(t('Status line updated {0}.', age))
  }
  if (cfg.tooltip !== 'compact') {
    out.push('')
    out.push(`_${t('measured: context window')}_`)
  }
  out.push('')
  out.push(footerLine(ctx))
  return out.join('\n')
}

// ---------------------------------------------------------------------------
// Budgets — the reader's own limit, measured against the local buckets
// ---------------------------------------------------------------------------

/**
 * The share of a budget, as the one figure the bar can carry.
 *
 * A money budget's used figure is the hypothetical API equivalent, so the share derived from
 * it is an estimate and says so — in the bar it stands alone, with no `~$12.34` beside it to
 * make that obvious. A period with no local data has no share at all and prints the dash the
 * row already carries.
 */
export function budgetValue(b: BudgetRow): string {
  if (b.share === null || b.shareText === '–') return '–'
  return b.unit === 'usd' ? estimate(b.shareText) : b.shareText
}

/**
 * Every configured budget, not only the one in the bar.
 *
 * The item shows the worst share because a status bar has room for one; the tooltip is where
 * the rest of them are, so a second budget quietly running over cannot hide behind the first.
 */
export function budgetTooltip(rows: BudgetRow[], ctx: RenderContext): string {
  const { cfg } = ctx
  if (cfg.tooltip === 'off') return ''
  const out: string[] = [`**${t('Budgets')}**`, '']
  for (const b of rows) {
    out.push(`- ${b.text}${b.partial ? ' ⚠' : ''}`)
  }
  out.push('')
  // Two sentences that have to travel with the number: where the limit came from, and what
  // a dollar figure here is not.
  out.push(`_${t('Your own limits from `tokenPace.budgets`, measured against the locally counted usage. USD is the hypothetical API equivalent, not a bill.')}_`)
  if (rows.some((b) => b.partial)) {
    out.push('')
    out.push(`_⚠ ${t('Unpriced models make the spend — and the share — a lower bound.')}_`)
  }
  if (cfg.tooltip !== 'compact') {
    out.push('')
    out.push(`_${t('measured: local buckets · limit: your own')}_`)
  }
  out.push('')
  out.push(footerLine(ctx))
  return out.join('\n')
}

export function problemTooltip(q: QuotaState, ctx: RenderContext): string {
  const { cfg } = ctx
  if (cfg.tooltip === 'off') return ''
  const p = problemView(q, cfg, ctx.now)
  const out: string[] = [
    `**${t('{0} — quota unavailable', TITLE[q.source])}**`, '', p.explain, '', `_${p.check}_`,
  ]
  if (q.problem) {
    out.push('')
    out.push(t('Reported: {0}', span(q.problem.slice(0, 200))))
  }
  if (q.fetchedAt !== null) {
    out.push('')
    out.push(t('Last reading: {0}', freshnessLine(q, cfg, ctx.now)))
  }
  if (ctx.role === 'follower') {
    out.push('')
    out.push(`_${followerNote()}_`)
  }
  if (cfg.tooltip !== 'compact') {
    out.push('')
    out.push(...usageTable(q.source, ctx))
    out.push('')
    out.push(provenanceLine(ctx, false))
  }
  out.push('')
  out.push(footerLine(ctx))
  return out.join('\n')
}

// ---------------------------------------------------------------------------
// Item models
// ---------------------------------------------------------------------------

function clickCommand(cfg: Config, source: Source | null): { command: string; args?: unknown[] } {
  switch (cfg.clickAction) {
    case 'dashboard': return { command: 'tokenPace.showDashboard' }
    case 'refresh': return { command: 'tokenPace.refreshQuota' }
    case 'openWebsite':
      return source === null
        ? { command: 'tokenPace.openUsagePage' }
        : { command: 'tokenPace.openUsagePage', args: [source] }
    default: return { command: 'tokenPace.menu' }
  }
}

function idOf(source: Source, windowId: string): string {
  return `tokenPace.quota.${source}.${windowId.replace(/:/g, '.')}`
}

/** One item, fully decided. `buildItems` calls this for every kind. */
export function itemModel(spec: ItemSpec, ctx: RenderContext): ItemModel {
  const { cfg, now } = ctx
  switch (spec.kind) {
    case 'window': {
      const view = viewOf(spec.q, spec.w, cfg, now)
      const stale = isStale(spec.q, cfg, now)
      const { colorId, alarm } = colorFor(view, stale, cfg)
      const click = clickCommand(cfg, spec.q.source)
      return {
        id: idOf(spec.q.source, spec.w.id),
        text: windowText(spec.q, view, ctx),
        colorId, alarm,
        tooltipMarkdown: quotaTooltip(spec.q, ctx),
        command: click.command,
        commandArgs: click.args,
        name: `${TITLE[spec.q.source]} — ${spec.w.label}`,
        priorityKey: '1000',
      }
    }
    case 'problem': {
      const p = problemView(spec.q, cfg, now)
      return {
        id: `tokenPace.quota.${spec.q.source}.problem`,
        text: problemText(spec.q, cfg, now),
        colorId: cfg.colorMode === 'theme' ? STALE_COLOR : null,
        alarm: false,
        tooltipMarkdown: problemTooltip(spec.q, ctx),
        command: p.command,
        commandArgs: p.args,
        name: t('{0} — quota unavailable', TITLE[spec.q.source]),
        priorityKey: '1000',
      }
    }
    case 'extra': {
      const text = extraUsageText(spec.q.extra) ?? '–'
      const on = spec.q.extra?.enabled === true
      const click = clickCommand(cfg, spec.q.source)
      return {
        id: `tokenPace.extra.${spec.q.source}`,
        text: t('{0} extra {1}', providerLabel(spec.q.source, cfg), text),
        colorId: cfg.colorMode === 'theme' ? (on ? EXTRA_COLOR : STALE_COLOR) : null,
        alarm: false,
        tooltipMarkdown: quotaTooltip(spec.q, ctx),
        command: click.command,
        commandArgs: click.args,
        name: t('{0} — extra usage', TITLE[spec.q.source]),
        priorityKey: '1000',
      }
    }
    case 'forecast': {
      const click = clickCommand(cfg, spec.q.source)
      return {
        id: `tokenPace.forecast.${spec.q.source}`,
        text: `${providerLabel(spec.q.source, cfg)} ${forecastItemText(spec.q, ctx) ?? '–'}`,
        colorId: null,
        alarm: false,
        tooltipMarkdown: quotaTooltip(spec.q, ctx),
        command: click.command,
        commandArgs: click.args,
        name: t('{0} — forecast', TITLE[spec.q.source]),
        priorityKey: '1000',
      }
    }
    case 'compact': {
      const views = selectWindows(spec.q, cfg, now).map((w) => viewOf(spec.q, w, cfg, now))
      const worst = worstView(views)
      const stale = isStale(spec.q, cfg, now)
      const paint = worst === null
        ? { colorId: null, alarm: false }
        : colorFor(worst, stale, cfg)
      const body = views.map((v) => {
        const reset = formatReset(v.w.resetsAt, now, cfg.resetFormat, ctx.tcfg)
        return `${windowValue(v, cfg)}${reset === '' ? '' : `·${reset}`}`
      }).join(' | ')
      const prefix = worst === null ? '' : statePrefix(worst.display)
      const click = clickCommand(cfg, spec.q.source)
      return {
        id: `tokenPace.compact.${spec.q.source}`,
        text: `${prefix}${providerLabel(spec.q.source, cfg)} ${body}`
          + ageSuffix(spec.q, stale, cfg, now),
        colorId: paint.colorId,
        alarm: paint.alarm,
        tooltipMarkdown: quotaTooltip(spec.q, ctx),
        command: click.command,
        commandArgs: click.args,
        name: t('{0} — quota', TITLE[spec.q.source]),
        priorityKey: '1000',
      }
    }
    case 'summary': {
      const views: WindowView[] = []
      let stale = false
      for (const q of ctx.quotas) {
        if (!spec.sources.includes(q.source) || !q.ok) continue
        for (const w of selectWindows(q, cfg, now)) views.push(viewOf(q, w, cfg, now))
        if (isStale(q, cfg, now)) stale = true
      }
      const worst = worstView(views)
      const paint = worst === null ? { colorId: null, alarm: false } : colorFor(worst, stale, cfg)
      const value = worst === null ? '–' : windowValue(worst, cfg) + indicatorGlyph(worst, cfg)
      const prefix = worst === null ? '' : statePrefix(worst.display)
      const click = clickCommand(cfg, null)
      return {
        id: 'tokenPace.summary',
        text: `${prefix}${summaryLabel(cfg)} ${value}`,
        colorId: paint.colorId,
        alarm: paint.alarm,
        tooltipMarkdown: summaryTooltip(spec.sources, ctx),
        command: click.command,
        commandArgs: click.args,
        name: t('Token Pace — usage'),
        priorityKey: '1000',
      }
    }
    case 'context': {
      const click = clickCommand(cfg, null)
      return {
        id: 'tokenPace.context',
        text: `${t('ctx {0}', contextValue(spec.c))}${contextAgeSuffix(spec.c, cfg, now)}`,
        colorId: null,
        alarm: false,
        tooltipMarkdown: contextTooltip(spec.c, ctx),
        command: click.command,
        commandArgs: click.args,
        name: t('Token Pace — context window'),
        priorityKey: '1000',
      }
    }
    case 'budget': {
      const click = clickCommand(cfg, null)
      return {
        id: 'tokenPace.budget',
        // No colour and no alarm: a budget is the reader's own number, and painting the bar
        // red for it would put a provider's vocabulary on a private decision. The share and
        // the word "over" are the whole statement.
        text: spec.b.over
          ? t('budget {0} over', budgetValue(spec.b))
          : t('budget {0}', budgetValue(spec.b)),
        colorId: null,
        alarm: false,
        tooltipMarkdown: budgetTooltip(ctx.budgets ?? [spec.b], ctx),
        command: click.command,
        commandArgs: click.args,
        name: t('Token Pace — budget'),
        priorityKey: '1000',
      }
    }
    case 'tokens': {
      const { from, to } = periodRange(ctx)
      let total = 0
      for (const s of scopeSources(cfg)) total += billableOf(ctx, from, to, s)
      // Always printed: "Σ 2.6M" alone is a number without a period, and today is the one
      // period a reader is most likely to assume wrongly.
      const suffix = ` · ${periodSuffix(cfg.summary.period)}`
      const click = clickCommand(cfg, null)
      return {
        id: 'tokenPace.tokens',
        text: ctx.scanning ? `$(sync~spin) ${t('reading history …')}` : `Σ ${tokenText(total)}${suffix}`,
        colorId: null,
        alarm: false,
        tooltipMarkdown: tokenTooltip(ctx, 'tokens'),
        command: click.command,
        commandArgs: click.args,
        name: t('Token Pace — tokens ({0})', periodLabel(cfg.summary.period)),
        priorityKey: '1000',
      }
    }
    default: {
      const { from, to } = periodRange(ctx)
      let usdSum = 0
      let unpriced = 0
      for (const s of scopeSources(cfg)) {
        const c = ctx.agg.cost(from, to, ctx.tcfg, ctx.pricing, { source: s })
        usdSum += c.usd
        unpriced += c.unpricedTokens + c.fastUnpricedTokens
      }
      // Exactly zero is absence, not a bill: '–' rather than '$0.00'.
      const money = usdSum === 0 ? '–' : estimate(usd(usdSum))
      // Same rule as the tokens item: the period is always named, so "today" cannot be mistaken for
      // the range of the dashboard.
      const suffix = ` · ${periodSuffix(cfg.summary.period)}`
      const click = clickCommand(cfg, null)
      return {
        id: 'tokenPace.cost',
        text: `${money}${unpriced > 0 ? ' ⚠' : ''}${suffix}`,
        colorId: null,
        alarm: false,
        tooltipMarkdown: tokenTooltip(ctx, 'cost'),
        command: click.command,
        commandArgs: click.args,
        name: t('Token Pace — API cost ({0})', periodLabel(cfg.summary.period)),
        priorityKey: '1000',
      }
    }
  }
}

/** The most urgent forecast a provider has, or null when nothing is measurable. */
function forecastItemText(q: QuotaState, ctx: RenderContext): string | null {
  let best: { f: Forecast; w: QuotaWindow } | null = null
  for (const w of q.windows) {
    const f = ctx.forecasts.get(`${q.source}:${w.id}`)
    if (!f) continue
    if (f.state === 'eta') {
      if (best === null || best.f.state !== 'eta'
        || (finite(f.etaMs) && finite(best.f.etaMs) && (f.etaMs as number) < (best.f.etaMs as number))) {
        best = { f, w }
      }
      continue
    }
    if (best === null && (f.state === 'resetsFirst' || f.state === 'idle' || f.state === 'measuring')) {
      best = { f, w }
    }
  }
  if (best === null) return null
  const { f, w } = best
  const label = windowLabel(w, ctx.cfg)
  if (f.state === 'eta' && finite(f.etaMs)) {
    return `$(graph) ${t('{0} ~empty in {1}', label, relativeShort(f.etaMs as number, ctx.now))}`
  }
  if (f.state === 'resetsFirst' && finite(f.endPercent)) {
    return `$(graph) ${t('{0} ~ends at {1}%', label, Math.round(f.endPercent as number))}`
  }
  if (f.state === 'idle') return `$(graph) ${t('{0} idle', label)}`
  if (f.state === 'measuring') return `$(graph) ${t('{0} measuring', label)}`
  return null
}

// ---------------------------------------------------------------------------
// The whole bar
// ---------------------------------------------------------------------------

const QUOTA_ENTRY: Record<'claudeQuota' | 'codexQuota', Source> = {
  claudeQuota: 'claude', codexQuota: 'codex',
}

/**
 * Every item, in the order of `tokenPace.statusBar.show`.
 *
 * Densities differ only in how the quota entries collapse: `compact` folds a provider's
 * windows into one item, `minimal` folds every provider into one. Problem states are never
 * folded — a named cause is the whole point of the state matrix, and it must stay readable
 * at every density.
 */
export function buildItems(input: StatusTextInput): ItemModel[] {
  const ctx = makeContext(input)
  const cfg = ctx.cfg
  const out: ItemModel[] = []
  const visible: Source[] = []
  for (const entry of cfg.statusBar.show) {
    if (entry === 'claudeQuota' || entry === 'codexQuota') visible.push(QUOTA_ENTRY[entry])
  }
  const bySource = new Map<Source, QuotaState>()
  for (const q of ctx.quotas) if (!bySource.has(q.source)) bySource.set(q.source, q)

  let summaryDone = false
  for (const entry of cfg.statusBar.show) {
    switch (entry) {
      case 'claudeQuota':
      case 'codexQuota': {
        const source = QUOTA_ENTRY[entry]
        const q = bySource.get(source)
        if (cfg.density === 'minimal') {
          if (q && (!q.ok || q.windows.length === 0)) out.push(itemModel({ kind: 'problem', q }, ctx))
          if (!summaryDone) {
            summaryDone = true
            out.push(itemModel({ kind: 'summary', sources: visible }, ctx))
          }
          break
        }
        if (!q) break
        if (!q.ok || q.windows.length === 0) {
          out.push(itemModel({ kind: 'problem', q }, ctx))
          break
        }
        if (cfg.density === 'compact') {
          out.push(itemModel({ kind: 'compact', q }, ctx))
          break
        }
        for (const w of selectWindows(q, cfg, ctx.now)) out.push(itemModel({ kind: 'window', q, w }, ctx))
        break
      }
      case 'extra': {
        for (const q of ctx.quotas) {
          if (extraUsageText(q.extra) === null) continue
          out.push(itemModel({ kind: 'extra', q }, ctx))
        }
        break
      }
      case 'forecast': {
        for (const q of ctx.quotas) {
          if (!q.ok || forecastItemText(q, ctx) === null) continue
          out.push(itemModel({ kind: 'forecast', q }, ctx))
        }
        break
      }
      case 'context':
        // No reading, no entry: there is no second way to learn a context window, so an
        // absent status line leaves the bar shorter rather than showing a dash.
        if (ctx.context) out.push(itemModel({ kind: 'context', c: ctx.context }, ctx))
        break
      case 'budget': {
        // The one closest to its own limit. A row without a share never wins, because it
        // never lost: no local data for the period is not "0 % used".
        const worst = worstBudget(ctx.budgets ?? [])
        if (worst) out.push(itemModel({ kind: 'budget', b: worst }, ctx))
        break
      }
      case 'tokens':
        out.push(itemModel({ kind: 'tokens' }, ctx))
        break
      case 'cost':
        if (cfg.showCost) out.push(itemModel({ kind: 'cost' }, ctx))
        break
    }
  }
  // Descending priority keeps the entries together and in the configured order.
  return out.map((m, i) => ({ ...m, priorityKey: String(1000 - i) }))
}

// ---------------------------------------------------------------------------
// Preview
// ---------------------------------------------------------------------------

/** The mark every preview item carries; a function, so it is translated at render time. */
function previewMark(): string {
  return t('[preview]')
}

function previewWindow(p: Partial<QuotaWindow>): QuotaWindow {
  return {
    id: 'session:300', kind: 'session', label: '5 h', shortLabel: '5h', model: null,
    percent: 25, resetsAt: null, windowMinutes: 300, limitReached: false, unlimited: false, ...p,
  }
}

function previewState(p: Partial<QuotaState>): QuotaState {
  return { source: 'claude', ok: true, origin: 'poll', fetchedAt: 0, planType: 'max20', windows: [], ...p }
}

/** A stand-in aggregator: fixed figures, no files, no clock. */
function previewUsage(): UsageSource {
  const b = emptyBucket('claude', 'claude-opus-4-6', false, 'standard', 'd', null, '2026-09-03')
  b.input = 1_200_000
  b.cacheWrite = 300_000
  b.cacheWrite1h = 40_000
  b.cacheRead = 12_400_000
  b.output = 210_000
  b.reasoning = 45_000
  b.requests = 320
  b.outputFinal = 300
  const cost: CostSummary = {
    usd: 1.23, listUsd: 1.23, unpricedTokens: 0, unpricedModels: [], fastUnpricedTokens: 0,
    familyPriced: [], custom: false,
  }
  return { sum: () => ({ ...b }), cost: () => ({ ...cost }) }
}

const PREVIEW_KINDS: ProblemKind[] = [
  'noToken', 'tokenExpired', 'consentPending', 'modeCache', 'retry', 'offline', 'forbidden',
  'unauthorized', 'noBinary', 'quotaOff', 'noFile', 'paused', 'follower', 'empty', 'unknown',
]

/**
 * Synthetic renderings of every state, through the very same builders.
 *
 * The preview exists so the format settings can be judged without waiting for a state to
 * happen for real. It is kept strictly apart from the live items: its own id space, its own
 * label, its own timer — it reads no file and writes none.
 */
/** A synthetic budget row; the preview never reads a setting or a bucket. */
function previewBudget(share: number, over: boolean): BudgetRow {
  const label = t('All providers · this month')
  return {
    key: 'total:month:usd', identity: 'preview', label,
    scope: 'total', period: 'month', unit: 'usd',
    from: '2026-09-01', to: '2026-09-12', last: '2026-09-30',
    limit: 200, limitText: '$200', used: share * 2, usedText: `~$${share * 2}`,
    share, shareText: `${share} %`, over, partial: false, covered: true,
    projected: null, projectedText: null, projectionBasis: null, projectedOver: false,
    unmeasurable: null,
    text: t('{0}: {1} of {2} · {3} %', label, `~$${share * 2}`, '$200', share),
  }
}

export function previewItems(cfg: Config, now: number): ItemModel[] {
  const hour = 3_600_000
  const base: StatusTextInput = {
    quotas: [], agg: previewUsage(), cfg, now, forecasts: new Map(),
    role: 'single', scanning: false, consent: 'granted',
  }
  const ctx = makeContext(base, true)
  const fresh = Math.floor(now / 1000) - 60
  const out: ItemModel[] = []

  const push = (spec: ItemSpec): void => {
    out.push(itemModel(spec, ctx))
  }
  const window = (label: string, w: Partial<QuotaWindow>, q: Partial<QuotaState> = {}): void => {
    const win = previewWindow({ ...w, shortLabel: label })
    push({ kind: 'window', q: previewState({ fetchedAt: fresh, windows: [win], ...q }), w: win })
  }

  // On pace, then the two ahead levels: 30 % of the window gone in each case.
  const resets = now + 3.5 * hour
  window('on', { percent: 25, resetsAt: resets })
  window('warn', { percent: 45, resetsAt: resets })
  window('warn2', { percent: 80, resetsAt: resets })
  window('full', { percent: 100, resetsAt: now + 47 * 60_000 })
  window('over', { percent: 111, resetsAt: resets })
  window('inf', { percent: 0, resetsAt: null, unlimited: true })
  window('stop', { percent: 100, resetsAt: resets, limitReached: true })
  window('due', { percent: 62, resetsAt: now - 5 * 60_000 })
  window('old', { percent: 62, resetsAt: resets }, { fetchedAt: Math.floor(now / 1000) - 42 * 60 })

  for (const kind of PREVIEW_KINDS) {
    push({
      kind: 'problem',
      q: previewState({
        source: kind === 'noBinary' ? 'codex' : 'claude',
        ok: false, problemKind: kind, fetchedAt: null,
        nextAttemptAt: now + 12 * 60_000,
        problem: 'synthetic preview state',
      }),
    })
  }

  push({
    kind: 'extra',
    q: previewState({
      fetchedAt: fresh,
      extra: {
        enabled: true, utilization: 24, used: 12, limit: 50, currency: 'USD', balance: null,
        unlimited: false, spendLimitReached: false, reason: null,
      },
    }),
  })
  push({
    kind: 'extra',
    q: previewState({
      fetchedAt: fresh,
      extra: {
        enabled: false, utilization: null, used: null, limit: null, currency: null, balance: null,
        unlimited: false, spendLimitReached: false, reason: 'not enabled',
      },
    }),
  })
  // Both context shapes: with a window size, and without one — the second is the state that
  // must never grow a percentage.
  push({ kind: 'context', c: { used: 128_000, size: 200_000, usedPct: 64, fetchedAt: fresh } })
  push({ kind: 'context', c: { used: 128_000, size: null, usedPct: null, fetchedAt: fresh } })
  // A budget under its limit and one over it — the second is the only state that adds a word.
  push({ kind: 'budget', b: previewBudget(38, false) })
  push({ kind: 'budget', b: previewBudget(118, true) })
  push({ kind: 'tokens' })
  push({ kind: 'cost' })

  // Own id space, own label, one command: clicking any of them ends the preview.
  const mark = previewMark()
  return out.map((m, i) => ({
    ...m,
    id: `tokenPace.preview.${i}`,
    text: `${mark} ${m.text}`,
    name: `${mark} ${m.name}`,
    command: 'tokenPace.previewStatusBar',
    commandArgs: undefined,
    priorityKey: String(1000 - i),
  }))
}
