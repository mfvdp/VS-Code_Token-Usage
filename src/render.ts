// SPDX-FileCopyrightText: 2026 Frederik Marx
// SPDX-License-Identifier: GPL-3.0-or-later

/** Pure presentation helpers, with no dependency on vscode. */

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
 * A bar made from the Unicode "Block Elements" range (U+2580..U+259F).
 * Deliberately a single Unicode block: glyphs from different blocks can come
 * from different fallback fonts and then render at different widths, which
 * makes the bar jitter on every update.
 */
export function renderBar(percent: number, width: number, style: BarStyle = 'line'): string {
  if (width <= 0) return ''
  const p = Math.max(0, Math.min(100, percent)) / 100
  const exact = p * width
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

export type Severity = 'ok' | 'warn' | 'error'

/**
 * Colour by pace, not by absolute level.
 *
 *   green  — usage is at or below the share of the window that has elapsed
 *   yellow — usage is ahead of the clock, so the window runs out early
 *   red    — the window is exhausted
 *
 * The threshold is 99.5 rather than 100 so that the colour matches the
 * displayed figure, which is rounded to whole percent.
 *
 * `elapsed` is null when a window reports no reset time; without it there is
 * nothing to compare against, so anything short of exhausted counts as fine.
 */
export function severity(percent: number, elapsed: number | null): Severity {
  if (percent >= 99.5) return 'error'
  if (elapsed === null) return 'ok'
  return percent > elapsed ? 'warn' : 'ok'
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

/** "in 2 h 14 min" or "3 min ago" */
export function relativeTime(target: number, now = Date.now()): string {
  const diff = Math.round((target - now) / 1000)
  const past = diff < 0
  let s = Math.abs(diff)
  const h = Math.floor(s / 3600); s -= h * 3600
  const m = Math.floor(s / 60)
  let txt: string
  // Beyond two days, count in days — nobody converts "155 h 22 min" in their head.
  if (h >= 48) txt = `${Math.floor(h / 24)} d ${h % 24} h`
  else if (h > 0) txt = `${h} h ${String(m).padStart(2, '0')} min`
  else txt = `${m} min`
  return past ? `${txt} ago` : `in ${txt}`
}

export function ageMinutes(fetchedAtSeconds: number | null, now = Date.now()): number | null {
  if (!fetchedAtSeconds) return null
  return (now - fetchedAtSeconds * 1000) / 60000
}

/** The last n local days as YYYY-MM-DD, ascending. */
export function lastDays(n: number, now = Date.now()): string[] {
  const out: string[] = []
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(now - i * 86400000)
    const p = (x: number) => String(x).padStart(2, '0')
    out.push(`${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`)
  }
  return out
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
 * How far the window's own clock has run, 0..100.
 *
 * The window started `windowMinutes` before it resets, so this says what share
 * of the period is already gone. Compared against the usage percentage it shows
 * whether consumption is running ahead of or behind the clock.
 */
export function windowElapsed(
  resetsAt: number | null,
  windowMinutes: number | null,
  now = Date.now(),
): number | null {
  if (!resetsAt || !windowMinutes) return null
  const span = windowMinutes * 60_000
  return Math.max(0, Math.min(100, ((now - (resetsAt - span)) / span) * 100))
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
