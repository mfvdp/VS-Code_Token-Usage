// SPDX-FileCopyrightText: 2026 Frederik Marx
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Budgets — a limit the *user* states, measured against the local buckets.
 *
 * A budget is the one number in this extension that nobody has to look up: the user types
 * it, so it is never a guess about a plan, a quota or a bill. Everything else here follows
 * from that:
 *
 *  • A budget is only ever compared with itself. A USD budget and a token budget are two
 *    different questions and are never added, averaged or ranked by their raw values —
 *    only their shares (a dimensionless fraction of the user's own limit) can be compared.
 *  • USD is the hypothetical API equivalent, not a bill, so a money budget carries the
 *    same `~` and the same `partial` lower-bound flag as every other cost in the views.
 *    Unpriced models make the used figure a *lower* bound, so the share is one too.
 *  • Absence is a dash. A period with no local buckets has no share, no projection and no
 *    alert — a budget at "0 %" would claim we measured a quiet week when we may simply not
 *    have read it yet.
 *  • The projection is the same rule as the month projection on the calendar card: the
 *    average per *elapsed* day, silent below `MIN_PROJECTION_DAYS` active days, and silent
 *    on the last day of the period. It is an extrapolation and says so with `~`.
 *
 * Pure: no vscode, no fs, no clock of its own — `now` is handed in, like everywhere else.
 */

import { billable } from './agg'
import { compact, estimate, percentOf, usd } from './render'
import {
  MIN_PROJECTION_DAYS, SOURCE_TITLE, StatsCtx, bucketsIn, costText, dayOfBucket, filterFor,
} from './stats'
import { addDays, dayCount, dayOf, weekdayOf } from './time'
import { Source } from './types'

// ---------------------------------------------------------------------------
// The spec the user configures
// ---------------------------------------------------------------------------

/** Which providers the budget covers. `total` means every provider the user left switched on. */
export type BudgetScope = 'total' | 'claude' | 'codex'
export type BudgetPeriod = 'day' | 'week' | 'month'
export type BudgetUnit = 'usd' | 'tokens'

export const BUDGET_SCOPES: readonly BudgetScope[] = ['total', 'claude', 'codex']
export const BUDGET_PERIODS: readonly BudgetPeriod[] = ['day', 'week', 'month']
export const BUDGET_UNITS: readonly BudgetUnit[] = ['usd', 'tokens']

export interface BudgetSpec {
  scope: BudgetScope
  period: BudgetPeriod
  unit: BudgetUnit
  /** The user's own number. Finite and above zero, or the entry is dropped whole. */
  limit: number
  label?: string
}

/** A list this long is a configuration mistake, and a view that long is unreadable. */
export const MAX_BUDGETS = 20
const MAX_LABEL = 40

// ---------------------------------------------------------------------------
// The row every view renders
// ---------------------------------------------------------------------------

export interface BudgetRow {
  /** Stable per spec: one budget per scope × period × unit. */
  key: string
  /** Alert subject: a new period is a new subject, so "once per period" falls out of it. */
  identity: string
  label: string
  scope: BudgetScope
  period: BudgetPeriod
  unit: BudgetUnit
  /** Period bounds and the day counted up to (today), all in the configured zone. */
  from: string
  to: string
  last: string
  limit: number
  limitText: string
  used: number
  usedText: string
  /** Percentage points of the limit, or null when the period has no local data at all. */
  share: number | null
  shareText: string
  over: boolean
  /** USD only: unpriced models make `used` — and therefore the share — a lower bound. */
  partial: boolean
  /**
   * Local buckets exist for this period. This is the budget's staleness gate: the figure
   * comes from the transcripts we ingested, not from a provider reading, so the freshness
   * of a quota response says nothing about it.
   */
  covered: boolean
  projected: number | null
  projectedText: string | null
  projectionBasis: string | null
  projectedOver: boolean
  /** One line the three views share, so they cannot tell three different stories. */
  text: string
}

// ---------------------------------------------------------------------------
// Sanitising
// ---------------------------------------------------------------------------

function str(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined
  const s = v.trim().slice(0, MAX_LABEL).trim()
  return s.length > 0 ? s : undefined
}

function oneOf<T extends string>(v: unknown, allowed: readonly T[]): T | null {
  return typeof v === 'string' && (allowed as readonly string[]).includes(v) ? (v as T) : null
}

/**
 * The configured list, cleaned.
 *
 * An unusable entry is dropped *whole* rather than repaired: a budget with a guessed scope
 * or a defaulted limit would be a number the extension invented and then warned about.
 * Duplicates by scope × period × unit collapse to the first, because two budgets on one
 * subject would share an alert identity and silence each other.
 */
export function sanitizeBudgets(raw: unknown): BudgetSpec[] {
  if (!Array.isArray(raw)) return []
  const out: BudgetSpec[] = []
  const seen = new Set<string>()
  for (const item of raw) {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) continue
    const o = item as Record<string, unknown>
    const scope = oneOf(o.scope, BUDGET_SCOPES)
    const period = oneOf(o.period, BUDGET_PERIODS)
    const unit = oneOf(o.unit, BUDGET_UNITS)
    const limit = o.limit
    if (scope === null || period === null || unit === null) continue
    if (typeof limit !== 'number' || !Number.isFinite(limit) || limit <= 0) continue
    const key = `${scope}:${period}:${unit}`
    if (seen.has(key)) continue
    seen.add(key)
    const label = str(o.label)
    out.push(label === undefined ? { scope, period, unit, limit } : { scope, period, unit, limit, label })
    if (out.length >= MAX_BUDGETS) break
  }
  return out
}

// ---------------------------------------------------------------------------
// Period bounds
// ---------------------------------------------------------------------------

/** Last calendar day of the month a `YYYY-MM-DD` day belongs to. */
function monthLastDay(day: string): string {
  const y = Number(day.slice(0, 4))
  const m = Number(day.slice(5, 7))
  const days = Number.isFinite(y) && Number.isFinite(m) ? new Date(Date.UTC(y, m, 0)).getUTCDate() : 31
  return `${day.slice(0, 8)}${String(days).padStart(2, '0')}`
}

export interface PeriodBounds {
  from: string
  last: string
}

/** The period containing `today`, in the user's own week and zone configuration. */
export function periodBounds(period: BudgetPeriod, today: string, ctx: StatsCtx): PeriodBounds {
  if (period === 'day') return { from: today, last: today }
  if (period === 'week') {
    const from = addDays(today, -weekdayOf(today, ctx.tcfg))
    return { from, last: addDays(from, 6) }
  }
  const from = `${today.slice(0, 8)}01`
  return { from, last: monthLastDay(today) }
}

const PERIOD_TITLE: Record<BudgetPeriod, string> = {
  day: 'today',
  week: 'this week',
  month: 'this month',
}

function scopeTitle(scope: BudgetScope): string {
  return scope === 'total' ? 'All providers' : SOURCE_TITLE[scope]
}

export function defaultBudgetLabel(spec: BudgetSpec): string {
  return `${scopeTitle(spec.scope)} · ${PERIOD_TITLE[spec.period]}`
}

// ---------------------------------------------------------------------------
// Facts
// ---------------------------------------------------------------------------

interface BudgetFacts {
  used: number
  partial: boolean
  activeDays: number
  covered: boolean
}

/**
 * What the local buckets say about one scope over one period.
 *
 * The sum runs per provider so that each one is filtered — and, for tokens, counted — by
 * its own rule; `billable` treats Codex's cached input differently from Claude's, and a
 * single unfiltered sum would apply one provider's arithmetic to the other's numbers.
 */
function factsOf(ctx: StatsCtx, spec: BudgetSpec, from: string, to: string, sources: Source[]): BudgetFacts {
  let used = 0
  let partial = false
  let covered = false
  const activeDays = new Set<string>()
  for (const source of sources) {
    if (spec.unit === 'usd') {
      const c = ctx.agg.cost(from, to, ctx.tcfg, ctx.pricing, filterFor(ctx, source))
      used += c.usd
      if (c.unpricedTokens > 0 || c.fastUnpricedTokens > 0) partial = true
    } else {
      used += billable(ctx.agg.sum(from, to, ctx.tcfg, filterFor(ctx, source)))
    }
    for (const b of bucketsIn(ctx, from, to, source)) {
      covered = true
      if (billable(b) > 0) activeDays.add(dayOfBucket(b, ctx.tcfg))
    }
  }
  return { used, partial, activeDays: activeDays.size, covered }
}

// ---------------------------------------------------------------------------
// Projection
// ---------------------------------------------------------------------------

interface Projection {
  value: number | null
  text: string | null
  basis: string | null
}

/**
 * End-of-period projection — the same rule as the calendar card's month projection.
 *
 * The average is per *elapsed* day, not per active day: a period is projected over its
 * calendar, and dividing by active days only would project a rate nobody keeps up. Below
 * `MIN_PROJECTION_DAYS` active days it stays silent rather than extrapolating from a
 * weekend, which also means a one-day budget never projects — and that is correct, since
 * "today" has no elapsed days to average over.
 *
 * W1c is factoring the month projection out of `stats.projectMonth` as
 * `projectPeriod(ctx, from, today, last)` while this file is being written; that export
 * returns the *cost text* for the calendar card over `ctx.sources`, so it cannot serve a
 * per-scope token budget. The rule is therefore restated here, in the one shape both units
 * need (a number, plus its wording). If the two ever drift, this is the copy to delete.
 */
function projectBudget(
  spec: BudgetSpec,
  facts: BudgetFacts,
  from: string,
  today: string,
  last: string,
): Projection {
  const silent: Projection = { value: null, text: null, basis: null }
  if (facts.activeDays < MIN_PROJECTION_DAYS || facts.used <= 0) return silent
  const elapsed = dayCount(from, today)
  if (elapsed <= 0) return silent
  const remaining = dayCount(today, last) - 1
  if (remaining <= 0) return silent
  const perDay = facts.used / elapsed
  const value = facts.used + perDay * remaining
  const plain = spec.unit === 'usd' ? usd : compact
  return {
    value,
    text: spec.unit === 'usd' ? costText(value) : estimate(compact(value)),
    basis: `so far ${plain(facts.used)} · Avg ${plain(perDay)}/day · ${remaining} day${remaining === 1 ? '' : 's'} left`,
  }
}

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

function limitText(spec: BudgetSpec): string {
  return spec.unit === 'usd' ? usd(spec.limit) : compact(spec.limit)
}

function usedText(spec: BudgetSpec, used: number): string {
  if (spec.unit === 'usd') return costText(used)
  return used > 0 ? compact(used) : '–'
}

/**
 * One row per configured budget, in the user's order.
 *
 * A budget is dropped — not shown at zero — when it cannot be measured at all: a money
 * budget while cost display is off, or a provider budget for a provider the user switched
 * off. Showing it would put a number on the screen that nobody is counting.
 */
export function budgetRows(ctx: StatsCtx, budgets: BudgetSpec[], now: number = ctx.now): BudgetRow[] {
  const today = dayOf(now, ctx.tcfg)
  const out: BudgetRow[] = []
  for (const spec of budgets) {
    if (spec.unit === 'usd' && !ctx.showCost) continue
    const sources: Source[] = spec.scope === 'total'
      ? [...ctx.sources]
      : ctx.sources.includes(spec.scope) ? [spec.scope] : []
    if (sources.length === 0) continue

    const { from, last } = periodBounds(spec.period, today, ctx)
    // `to` is today, never the end of the period: a budget is measured over what has
    // happened, and counting an empty future would report a share that only falls.
    const to = today < last ? today : last
    const facts = factsOf(ctx, spec, from, to, sources)
    const share = facts.covered ? (facts.used / spec.limit) * 100 : null
    const projection = projectBudget(spec, facts, from, today, last)
    const label = spec.label ?? defaultBudgetLabel(spec)
    const lim = limitText(spec)
    const use = usedText(spec, facts.used)
    const shareText = facts.covered ? percentOf(facts.used, spec.limit) : '–'
    const parts = [`${label}: ${use} of ${lim}`, shareText]
    if (projection.text !== null) parts.push(`projected ${projection.text} by ${last}`)

    out.push({
      key: `${spec.scope}:${spec.period}:${spec.unit}`,
      identity: identityOfBudget(spec, from),
      label,
      scope: spec.scope,
      period: spec.period,
      unit: spec.unit,
      from,
      to,
      last,
      limit: spec.limit,
      limitText: lim,
      used: facts.used,
      usedText: use,
      share,
      shareText,
      over: facts.used > spec.limit,
      partial: facts.partial,
      covered: facts.covered,
      projected: projection.value,
      projectedText: projection.text,
      projectionBasis: projection.basis,
      projectedOver: projection.value !== null && projection.value > spec.limit,
      text: parts.join(' · '),
    })
  }
  return out
}

/** The alert subject: scope, period, unit and the period's first day. */
export function identityOfBudget(spec: BudgetSpec, periodStart: string): string {
  return `budget:${spec.scope}:${spec.period}:${spec.unit}:${periodStart}`
}

/**
 * The budget closest to its own limit.
 *
 * Only the *share* is compared, never the used value: dollars and tokens are different
 * questions, and "the larger number" across the two would be a category error. A row
 * without a share (no local data for the period) cannot win, because it never lost.
 */
export function worstBudget(rows: BudgetRow[]): BudgetRow | null {
  let best: BudgetRow | null = null
  for (const r of rows) {
    if (r.share === null) continue
    if (best === null || r.share > (best.share ?? -1)) best = r
  }
  return best
}
