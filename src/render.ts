// SPDX-FileCopyrightText: 2026 Frederik Marx
// SPDX-License-Identifier: AGPL-3.0-or-later

/** Pure presentation helpers, with no dependency on vscode. */

import {
  lastDays as lastDaysIn, SYSTEM_TIME_CONFIG,
} from './time'
import { paceVerdict } from './pace'

/** Left-aligned eighth blocks U+258F..U+2589 for the partial fill of the last cell. */
const EIGHTHS = ['', '▏', '▎', '▍', '▌', '▋', '▊', '▉']
const FULL = '█'

/**
 * Glyph for the empty part. `line` (U+2581, a thin baseline) is the quiet option:
 * it shows the bar's extent without competing with the filled part. `shade`
 * (U+2591) has more contrast but looks grainy at small font sizes.
 */
export type BarStyle = 'line' | 'shade' | 'none'
const EMPTY: Record<BarStyle, string> = { line: '▁', shade: '░', none: ' ' }

/**
 * Which characters the bar is drawn with. `blocks` is the default because it is
 * the only set that can show a partial cell; the others exist because block
 * elements are not reliably shipped in the default status bar font on every
 * platform (Windows in particular), and a bar that falls back to tofu is worse
 * than a coarser one that renders.
 */
export type BarGlyphs = 'blocks' | 'shapes' | 'dots' | 'pie'

/** How the elapsed share of the window is drawn next to the usage bar. */
export type TimeProgressStyle = 'marker' | 'bar' | 'none'

export interface BarOptions {
  width: number
  style: BarStyle
  glyphs: BarGlyphs
  /** Elapsed share of the window, 0..100, or null when the window has no clock. */
  marker: number | null
  markerStyle: TimeProgressStyle
  /** Battery metaphor: draw what is left instead of what is used. */
  remaining: boolean
}

export const DEFAULT_BAR: BarOptions = {
  width: 8, style: 'line', glyphs: 'blocks', marker: null, markerStyle: 'none', remaining: false,
}

/** Pie glyphs by quintile — the one set that survives a width of zero. */
const PIE = ['○', '◔', '◑', '◕', '●']
/** One glyph per cell: filled, empty. */
const PAIRS: Record<'shapes' | 'dots', [string, string]> = {
  shapes: ['■', '□'],
  dots: ['●', '○'],
}
/** Vertical bar marking the position of the window clock inside the usage bar. */
const MARKER = '┃'
const TIME_FILLED = '▔'
const TIME_EMPTY = '▁'

function share(percent: number): number {
  if (!Number.isFinite(percent)) return 0
  return Math.max(0, Math.min(100, percent)) / 100
}

/**
 * A bar made from the Unicode "Block Elements" range (U+2580..U+259F).
 * Deliberately a single Unicode block: glyphs from different blocks can come
 * from different fallback fonts and then render at different widths, which
 * makes the bar jitter on every update. The alternative glyph sets each stay
 * inside one block for the same reason (Geometric Shapes, U+25A0..U+25FF).
 */
function blocksBar(percent: number, width: number, style: BarStyle): string {
  const exact = share(percent) * width
  let used = Math.min(Math.floor(exact), width)
  let bar = FULL.repeat(used)
  const idx = Math.round((exact - Math.floor(exact)) * 8)
  if (used < width && idx > 0) {
    bar += idx === 8 ? FULL : EIGHTHS[idx]
    used += 1
  }
  // Deliberately without brackets: the partial block ▏ would be indistinguishable from one.
  return bar + EMPTY[style].repeat(Math.max(0, width - used))
}

function pairBar(percent: number, width: number, style: BarStyle, glyphs: 'shapes' | 'dots'): string {
  const [on, off] = PAIRS[glyphs]
  const used = Math.min(width, Math.max(0, Math.round(share(percent) * width)))
  // With one glyph per cell the style can only decide whether the empty part is
  // drawn at all; 'line' and 'shade' would mix two Unicode blocks in one bar.
  const rest = style === 'none' ? ' ' : off
  return on.repeat(used) + rest.repeat(width - used)
}

function pieGlyph(percent: number): string {
  const q = Math.min(4, Math.floor(share(percent) * 5))
  return PIE[q]
}

function mirror(s: string): string {
  return Array.from(s).reverse().join('')
}

function timeBar(marker: number, width: number): string {
  const used = Math.min(width, Math.max(0, Math.round(share(marker) * width)))
  return TIME_FILLED.repeat(used) + TIME_EMPTY.repeat(width - used)
}

export function renderBar(percent: number, opts: BarOptions): string
/** @deprecated compatibility shim, removed in wave 3 */
export function renderBar(percent: number, width: number, style?: BarStyle): string
export function renderBar(
  percent: number,
  optsOrWidth: BarOptions | number,
  style: BarStyle = 'line',
): string {
  const opts: BarOptions = typeof optsOrWidth === 'number'
    ? { ...DEFAULT_BAR, width: optsOrWidth, style }
    : optsOrWidth
  const width = Number.isFinite(opts.width) ? Math.floor(opts.width) : 0
  const hasMarker = opts.marker !== null && Number.isFinite(opts.marker)

  if (opts.glyphs === 'pie') {
    // One glyph, so there is no cell to put a marker in; the elapsed share can
    // only be shown as a second pie next to it.
    const pie = pieGlyph(percent)
    return hasMarker && opts.markerStyle === 'bar'
      ? `${pie} ${pieGlyph(opts.marker as number)}`
      : pie
  }
  if (width <= 0) return ''

  let bar = opts.glyphs === 'shapes' || opts.glyphs === 'dots'
    ? pairBar(percent, width, opts.style, opts.glyphs)
    : blocksBar(percent, width, opts.style)

  // Mirroring keeps the bar in one Unicode block: right-aligned partial blocks
  // live in a different range, so the last cell still fills from its own left.
  if (opts.remaining) bar = mirror(bar)

  if (hasMarker && opts.markerStyle === 'marker' && width >= 6) {
    // The marker overwrites whatever is at that cell — filled or empty — so the
    // clock position stays visible on both sides of the fill. Time always runs
    // left to right, also in `remaining` mode.
    const cells = Array.from(bar)
    const at = Math.round(share(opts.marker as number) * (width - 1))
    cells[Math.min(cells.length - 1, Math.max(0, at))] = MARKER
    bar = cells.join('')
  }
  if (hasMarker && opts.markerStyle === 'bar') {
    bar += ' ' + timeBar(opts.marker as number, width)
  }
  return bar
}

/**
 * The percentage as text.
 *
 * `remaining` is floored and `used` is rounded so that neither mode ever claims
 * a headroom that is not there: 99.6 % used reads "100%" but still "0%" left.
 * Overflow is shown as measured by default — a plan that bills beyond 100 % is
 * a fact the user paid for, and clamping it to "100%" would hide it.
 */
export function percentText(
  percent: number,
  mode: 'used' | 'remaining',
  overflow: 'clamp' | 'actual',
): string {
  if (!Number.isFinite(percent) || percent < 0) return '–'
  if (mode === 'remaining') return `${Math.max(0, Math.floor(100 - percent))}%`
  const p = overflow === 'clamp' ? Math.min(100, percent) : percent
  return `${Math.round(p)}%`
}

/** Marks a figure as an estimate. Idempotent — two tildes would read as a range. */
export function estimate(s: string): string {
  return s.startsWith('~') ? s : `~${s}`
}

/** Where a number comes from: read from the provider, computed by us, or inferred. */
export type Provenance = 'measured' | 'estimated' | 'derived'

export function provenanceBadge(p: Provenance): string {
  return p
}

/** A quotient, or '–' when there is no denominator to divide by (never 0.0). */
export function ratioText(num: number, den: number, digits = 1): string {
  if (!Number.isFinite(num) || !Number.isFinite(den) || den === 0) return '–'
  const v = num / den
  if (!Number.isFinite(v)) return '–'
  return v.toFixed(digits)
}

/** "91 %" — or '–', because a missing denominator is not "0 %". */
export function percentOf(num: number, den: number): string {
  if (!Number.isFinite(num) || !Number.isFinite(den) || den === 0) return '–'
  return `${Math.round((num / den) * 100)} %`
}

/**
 * Change against the previous period.
 *
 * Growth from nothing is reported as "new" rather than as an infinite rise, and
 * a change below half a percentage point gets a neutral dot: a bar chart that
 * flips its arrow on rounding noise trains people to ignore it.
 */
export function deltaBadge(
  cur: number,
  prev: number | null,
): { glyph: '▲' | '▼' | '•' | ''; text: string } {
  if (!Number.isFinite(cur) || (prev !== null && !Number.isFinite(prev))) {
    return { glyph: '•', text: '–' }
  }
  // No glyph: "new" is the whole message, and a glyph that repeats it reads "new new".
  if (prev === null || (prev === 0 && cur > 0)) return { glyph: '', text: 'new' }
  if (prev === 0) return { glyph: '•', text: '±0%' }
  const pct = ((cur - prev) / Math.abs(prev)) * 100
  const abs = Math.abs(pct)
  const digits = abs < 10 ? 1 : 0
  const text = `${pct >= 0 ? '+' : '-'}${abs.toFixed(digits)}%`
  if (abs < 0.5) return { glyph: '•', text }
  return { glyph: pct > 0 ? '▲' : '▼', text }
}

const NF = new Intl.NumberFormat('en-US', { maximumFractionDigits: 1 })
const NF0 = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 })

/** Compact token count: 987 · 12.3K · 1.2M · 3.4G */
export function compact(n: number): string {
  const a = Math.abs(n)
  if (a < 1000) return NF0.format(n)
  if (a < 1e6) return NF.format(n / 1e3) + 'K'
  if (a < 1e9) return NF.format(n / 1e6) + 'M'
  return NF.format(n / 1e9) + 'G'
}

export function full(n: number): string {
  return NF0.format(n)
}

export function ageMinutes(fetchedAtSeconds: number | null, now = Date.now()): number | null {
  if (!fetchedAtSeconds) return null
  return (now - fetchedAtSeconds * 1000) / 60000
}

/**
 * Number of decimals for a money amount: cents below $100, whole units at or
 * above it. At three or more digits the cents carry no information anyone acts
 * on, and dropping them keeps the figure short in a status bar or a table cell.
 *
 * The test runs on the already-rounded value, so 99.999 is treated as the 100
 * it will be displayed as rather than falling on the cents side of the line.
 */
function digitsFor(n: number): 0 | 2 {
  return Math.abs(Math.round(n * 100) / 100) >= 100 ? 0 : 2
}

/**
 * Dollar amount: to the cent below $100 so a column of small figures lines up,
 * rounded to whole dollars from $100 up.
 *
 * Exactly zero stays a dash: no usage is a different statement from "$0.00".
 * A non-zero amount below a cent is shown as a bound rather than rounded to
 * "$0.00", which would read as nothing at all.
 */
export function usd(n: number): string {
  if (n === 0) return '–'
  if (n < 0.01) return '<$0.01'
  const d = digitsFor(n)
  return '$' + n.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d })
}

/**
 * Money in the provider's currency, or a plain number when none is stated.
 * Same cents-below-100 rule as {@link usd} so the two never disagree in one view.
 */
export function money(n: number, currency: string | null): string {
  const f = digitsFor(n)
  const d = { minimumFractionDigits: f, maximumFractionDigits: f }
  if (!currency) return n.toLocaleString('en-US', d)
  try {
    return n.toLocaleString('en-US', { style: 'currency', currency, ...d })
  } catch {
    // Unknown ISO code — better a readable fallback than a thrown RangeError.
    return `${n.toLocaleString('en-US', d)} ${currency}`
  }
}

/**
 * One line describing extra/purchased usage, or null when the provider reports
 * nothing at all. A disabled allowance is stated as such rather than drawn as
 * "0 % used", which would read like headroom that is not there.
 */
export function extraUsageText(e: {
  enabled: boolean
  utilization: number | null
  used: number | null
  limit: number | null
  currency: string | null
  balance: string | null
  unlimited: boolean
  spendLimitReached: boolean
  reason: string | null
} | undefined): string | null {
  if (!e) return null
  if (e.unlimited) return 'unlimited'
  if (!e.enabled) return `off${e.reason ? ` (${e.reason})` : ''}`
  const parts: string[] = []
  if (e.used !== null) {
    parts.push(e.limit !== null
      ? `${money(e.used, e.currency)} of ${money(e.limit, e.currency)}`
      : money(e.used, e.currency))
  } else if (e.balance !== null) {
    parts.push(`${e.balance} credits left`)
  }
  if (e.utilization !== null) parts.push(`${e.utilization.toFixed(0)} %`)
  if (e.spendLimitReached) parts.push('spend limit reached')
  return parts.length ? parts.join(' · ') : 'on'
}

// ---------------------------------------------------------------------------
// Compatibility shims for the callers that are rewritten in wave 3.
// ---------------------------------------------------------------------------

/** @deprecated compatibility shim, removed in wave 3 — import from './time'. */
export { relativeTime } from './time'

/** @deprecated compatibility shim, removed in wave 3 — import from './pace'. */
export { windowElapsed } from './pace'

/** @deprecated compatibility shim, removed in wave 3 — use time.lastDays with a TimeConfig. */
export function lastDays(n: number, now = Date.now()): string[] {
  return lastDaysIn(n, now, SYSTEM_TIME_CONFIG)
}

/** @deprecated compatibility shim, removed in wave 3 — use PaceLevel from './pace'. */
export type Severity = 'ok' | 'warn' | 'error'

/** @deprecated compatibility shim, removed in wave 3 — use paceVerdict from './pace'. */
export function severity(percent: number, elapsed: number | null): Severity {
  const v = paceVerdict(percent, elapsed, {
    sensitivity: 'normal', tolerancePoints: 5, minElapsedPercent: 3, levels: 'binary',
  })
  return v.level === 'warn2' ? 'warn' : v.level
}
