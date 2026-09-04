// SPDX-FileCopyrightText: 2026 Frederik Marx
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Threshold, pace and forecast alerts — off by default, and quiet by design.
 *
 * A quota warning is only worth anything if it is rare. The hygiene rules below
 * are what make that true, and each of them exists because the field gets it
 * wrong somewhere:
 *
 *  • Identity is the window *and its reset time*, so a new cycle is a new
 *    subject and the same cycle can never speak twice.
 *  • Only an escalation speaks: a higher threshold than the one already
 *    announced, a pace that just flipped, a one-off notice.
 *  • The state is persisted *before* the notification is shown — a window that
 *    is closed while the popup is open must not produce the popup again.
 *  • Nothing is ever said from a stale reading: an old percentage crossing a
 *    threshold is not news, it is an artefact.
 *  • Everything one provider has to say in one evaluation becomes one message:
 *    several thresholds, several windows on a fast pace, several forecasts. The
 *    first reading after a reset must not queue a chain of popups.
 *  • Budgets follow the same rules with one difference: their subject is the
 *    user's own limit for a period, and their number comes from the local
 *    buckets rather than from a provider reading — so the freshness gate above
 *    does not apply to them and a different one does (see `budgetDecisions`).
 *
 * The class has no vscode import: the notifier is injected, which is also what
 * makes the whole rule set testable.
 */

import { PROVIDER_NAME } from './adapters'
import { BudgetPeriod, BudgetRow } from './budget'
import { AlertConfig } from './config'
import { MementoLike } from './storage'
import { relativeShort } from './time'
import { Forecast, PaceLevel, PaceVerdict, QuotaState, QuotaWindow, Source } from './types'

/** Memento key of the persisted alert state. */
export const ALERTS_KEY = 'tokenPace.alerts'

export const ACTION_DASHBOARD = 'Open Dashboard'
export const ACTION_SNOOZE = 'Not today'

/** The command the caller runs when the user picked the dashboard button. */
export const DASHBOARD_COMMAND = 'tokenPace.showDashboard'

export type AlertKind = 'threshold' | 'pace' | 'useItLoseIt' | 'forecast' | 'budget'

/**
 * Who an alert is about. A budget may span every provider at once, and calling that
 * bundle "claude" would attribute a number to a provider that did not produce all of it.
 */
export type AlertSubject = Source | 'total'

/**
 * The alert settings this module reads. `budgetPercent` is declared optional so that the
 * class keeps compiling — and behaving — before wave 2 adds `tokenPace.alerts.budgetPercent`
 * to `AlertConfig`; absent means zero, and zero means off.
 */
export type AlertCfg = AlertConfig & { budgetPercent?: number }

export interface AlertDecision {
  kind: AlertKind
  source: AlertSubject
  /** Identities covered — more than one when thresholds were consolidated. */
  identities: string[]
  windowIds: string[]
  /** Budget keys (`scope:period:unit`) — empty for every other kind. */
  budgetKeys?: string[]
  level: 'info' | 'warning'
  message: string
  /** Set when the user picked "Open Dashboard"; the caller executes it. */
  command?: string
  /** Set when the user picked "Not today". */
  snoozedUntil?: number
}

/** Per-identity record of what has already been said. */
export interface AlertEntry {
  /** Highest threshold already announced, always in "used" points. */
  level: number | null
  paceWarned: boolean
  useItWarned: boolean
  forecastWarned: boolean
  paceLevel?: PaceLevel
  /** Highest budget percentage already announced for this period. */
  budgetLevel?: number
  /** Last touch (ms) — old cycles are pruned, the memento is not an archive. */
  at: number
}

export interface AlertsState {
  /** Everything stays quiet until this local midnight. */
  snoozedUntil?: number
  entries: Record<string, AlertEntry>
}

export type Notify = (
  message: string,
  actions: string[],
  level: 'info' | 'warning',
) => PromiseLike<string | undefined>

/**
 * Entries older than this are dropped: their cycle cannot come back.
 *
 * It has to outlast the longest budget period, not just the longest quota window: a
 * month budget's "once per period" lives entirely in its entry, so a 31-day period
 * whose entry is pruned on day 15 would announce itself a second time. Forty-five days
 * clears every period the settings allow; the count stays bounded by MAX_ENTRIES.
 */
const ENTRY_TTL_MS = 45 * 24 * 60 * 60 * 1000
const MAX_ENTRIES = 200
const DEFAULT_STALE_MS = 20 * 60 * 1000

/** Next local midnight — "not today" means this calendar day in the user's zone. */
export function nextLocalMidnight(now: number): number {
  const d = new Date(now)
  d.setHours(0, 0, 0, 0)
  return d.getTime() + 24 * 60 * 60 * 1000
}

function providerName(source: AlertSubject): string {
  return source === 'total' ? 'All providers' : PROVIDER_NAME[source]
}

function pct(value: number): string {
  return `${Math.round(value)} %`
}

function emptyState(): AlertsState {
  return { entries: {} }
}

function entryOf(state: AlertsState, identity: string): AlertEntry {
  const found = state.entries[identity]
  if (found && typeof found === 'object') {
    return {
      level: typeof found.level === 'number' && Number.isFinite(found.level) ? found.level : null,
      paceWarned: found.paceWarned === true,
      useItWarned: found.useItWarned === true,
      forecastWarned: found.forecastWarned === true,
      paceLevel: found.paceLevel,
      budgetLevel: typeof found.budgetLevel === 'number' && Number.isFinite(found.budgetLevel)
        ? found.budgetLevel
        : undefined,
      at: typeof found.at === 'number' ? found.at : 0,
    }
  }
  return { level: null, paceWarned: false, useItWarned: false, forecastWarned: false, at: 0 }
}

/** Identity of one window in one cycle. A new reset time is a new subject. */
export function identityOf(source: Source, w: QuotaWindow): string {
  return `${source}:${w.id}:${w.resetsAt ?? 'none'}`
}

/**
 * Configured thresholds as "used" percentages, ascending and deduplicated.
 *
 * With `basis: 'remaining'` a threshold of 20 means "20 % left", which is the
 * same statement as "80 % used" — converting here keeps one comparison in the
 * rest of the module instead of two.
 */
export function usedThresholds(cfg: AlertConfig): number[] {
  const out = new Set<number>()
  for (const raw of cfg.thresholds) {
    if (typeof raw !== 'number' || !Number.isFinite(raw)) continue
    const used = cfg.basis === 'remaining' ? 100 - raw : raw
    if (used < 0 || used > 100) continue
    out.add(used)
  }
  return [...out].sort((a, b) => a - b)
}

interface Candidate {
  source: Source
  window: QuotaWindow
  identity: string
  verdict: PaceVerdict | undefined
  forecast: Forecast | undefined
}

/** What one provider has to say about one kind of alert in this evaluation. */
interface Grouped {
  parts: string[]
  identities: string[]
  windowIds: string[]
}

/** What one period has to say about its budgets in this evaluation. */
interface BudgetGroup {
  parts: string[]
  identities: string[]
  keys: string[]
  scopes: Set<BudgetRow['scope']>
}

const PERIOD_TITLE: Record<BudgetPeriod, string> = {
  day: 'today',
  week: 'this week',
  month: 'this month',
}

/** Adds one window's sentence fragment to its provider's group. */
function collect(bySource: Map<Source, Grouped>, c: Candidate, part: string): void {
  const group = bySource.get(c.source) ?? { parts: [], identities: [], windowIds: [] }
  group.parts.push(part)
  group.identities.push(c.identity)
  group.windowIds.push(c.window.id)
  bySource.set(c.source, group)
}

export class Alerts {
  private staleAfterMs: number

  constructor(
    private memento: MementoLike,
    private cfg: AlertCfg,
    private log: (msg: string) => void,
    private notify: Notify = defaultNotify,
    opts: { staleAfterMs?: number } = {},
  ) {
    this.staleAfterMs = opts.staleAfterMs ?? DEFAULT_STALE_MS
  }

  setConfig(cfg: AlertCfg): void {
    this.cfg = cfg
  }

  /** The status bar's staleness rule is the alert's staleness rule too. */
  setStaleAfterMs(ms: number): void {
    if (Number.isFinite(ms) && ms > 0) this.staleAfterMs = ms
  }

  /** Every trigger switched off means the module does nothing at all. */
  enabled(): boolean {
    const c = this.cfg
    return c.thresholds.length > 0 || c.onPaceFast || c.useItLoseIt || c.forecastLeadMinutes > 0
      || this.budgetPercent() > 0
  }

  /** The configured budget level, or 0 when the setting is absent, unusable or off. */
  private budgetPercent(): number {
    const raw = this.cfg.budgetPercent
    return typeof raw === 'number' && Number.isFinite(raw) && raw > 0 ? raw : 0
  }

  snoozedUntil(): number | null {
    return this.load().snoozedUntil ?? null
  }

  /** Ends a snooze early — used by "Clear Stored Data" and by tests. */
  async clear(): Promise<void> {
    await this.memento.update(ALERTS_KEY, undefined)
  }

  private load(): AlertsState {
    const raw = this.memento.get<AlertsState | undefined>(ALERTS_KEY, undefined)
    if (!raw || typeof raw !== 'object' || typeof raw.entries !== 'object' || raw.entries === null) {
      return emptyState()
    }
    return { snoozedUntil: typeof raw.snoozedUntil === 'number' ? raw.snoozedUntil : undefined, entries: { ...raw.entries } }
  }

  private async save(state: AlertsState, now: number): Promise<void> {
    const keys = Object.keys(state.entries)
    for (const key of keys) {
      if (now - (state.entries[key]?.at ?? 0) > ENTRY_TTL_MS) delete state.entries[key]
    }
    const left = Object.keys(state.entries)
    if (left.length > MAX_ENTRIES) {
      left.sort((a, b) => (state.entries[a].at ?? 0) - (state.entries[b].at ?? 0))
      for (const key of left.slice(0, left.length - MAX_ENTRIES)) delete state.entries[key]
    }
    await this.memento.update(ALERTS_KEY, state)
  }

  /**
   * Judges the current readings and shows at most one message per subject.
   *
   * Returns what it decided, so the caller can execute the button command and
   * the log (and the tests) can see the reasoning without reading popups.
   *
   * `budgets` is optional so the quota-only caller keeps compiling. It must be
   * left empty while a scan is still running: a half-ingested period would put
   * a share on the screen that is only going to rise, and a budget alert from
   * it would be an artefact of the read order.
   */
  async evaluate(
    states: QuotaState[],
    verdicts: Map<string, PaceVerdict>,
    forecasts: Map<string, Forecast>,
    now: number,
    budgets: BudgetRow[] = [],
  ): Promise<AlertDecision[]> {
    if (!this.enabled()) return []
    const state = this.load()
    if (state.snoozedUntil !== undefined && state.snoozedUntil > now) return []

    const candidates = this.candidatesOf(states, verdicts, forecasts, now)
    if (candidates.length === 0 && budgets.length === 0) return []

    const pending: AlertDecision[] = []
    const announced = new Set<string>()

    this.thresholdDecisions(candidates, state, now, pending, announced)
    this.paceDecisions(candidates, state, now, pending, announced)
    this.forecastDecisions(candidates, state, now, pending, announced)
    this.useItDecisions(candidates, state, now, pending, announced)
    this.budgetDecisions(budgets, state, now, pending, announced)

    if (pending.length === 0) return []

    // Persisted before anything is shown: a window closed while the popup is
    // open must not make the same announcement again on the next start.
    await this.save(state, now)

    for (const decision of pending) {
      this.log(`Alert (${decision.kind}): ${decision.message}`)
      const choice = await this.notify(decision.message, [ACTION_DASHBOARD, ACTION_SNOOZE], decision.level)
      if (choice === ACTION_DASHBOARD) decision.command = DASHBOARD_COMMAND
      if (choice === ACTION_SNOOZE) {
        const until = nextLocalMidnight(now)
        decision.snoozedUntil = until
        const fresh = this.load()
        fresh.snoozedUntil = until
        await this.save(fresh, now)
        this.log('Alerts snoozed until the next local midnight.')
        break
      }
    }
    return pending
  }

  /**
   * The windows that may be judged at all: a fresh, successful reading, a
   * finite percentage, a real limit, and the configured window kind.
   */
  private candidatesOf(
    states: QuotaState[],
    verdicts: Map<string, PaceVerdict>,
    forecasts: Map<string, Forecast>,
    now: number,
  ): Candidate[] {
    const out: Candidate[] = []
    for (const s of states) {
      if (!s.ok) continue
      // No fetch time means we cannot claim the reading is current, and an
      // alert from a reading of unknown age is exactly the kind of noise the
      // hygiene rules exist to prevent.
      if (s.fetchedAt === null || !Number.isFinite(s.fetchedAt)) continue
      if (now - s.fetchedAt * 1000 > this.staleAfterMs) continue
      for (const w of s.windows) {
        if (w.unlimited || !Number.isFinite(w.percent)) continue
        if (this.cfg.windowCondition === 'sessionOnly' && w.kind !== 'session') continue
        if (this.cfg.windowCondition === 'weeklyOnly' && w.kind !== 'weekly') continue
        const key = `${s.source}:${w.id}`
        out.push({
          source: s.source,
          window: w,
          identity: identityOf(s.source, w),
          verdict: verdicts.get(key),
          forecast: forecasts.get(key),
        })
      }
    }
    return out
  }

  private ahead(v: PaceVerdict | undefined): boolean {
    return v !== undefined && (v.level === 'warn' || v.level === 'warn2' || v.level === 'error')
  }

  /** True when the window resets so soon that a threshold is no longer news. */
  private resetsSoon(w: QuotaWindow, now: number): boolean {
    const minutes = this.cfg.minRemainingMinutes
    if (!(minutes > 0) || w.resetsAt === null || !Number.isFinite(w.resetsAt)) return false
    const left = w.resetsAt - now
    return left > 0 && left < minutes * 60_000
  }

  private thresholdDecisions(
    candidates: Candidate[],
    state: AlertsState,
    now: number,
    out: AlertDecision[],
    announced: Set<string>,
  ): void {
    const levels = usedThresholds(this.cfg)
    if (levels.length === 0) return
    const bySource = new Map<Source, Grouped>()

    for (const c of candidates) {
      let breached: number | null = null
      for (const level of levels) if (c.window.percent >= level) breached = level
      if (breached === null) continue
      // Suppressed, not recorded: the reason is a property of this moment, so
      // the same threshold must still be able to speak once it no longer holds.
      if (this.cfg.requireAhead && !this.ahead(c.verdict)) continue
      if (this.resetsSoon(c.window, now)) continue

      const entry = entryOf(state, c.identity)
      if (entry.level !== null && breached <= entry.level) continue
      entry.level = breached
      entry.at = now
      state.entries[c.identity] = entry
      announced.add(c.identity)

      collect(bySource, c, this.thresholdPart(c.window, breached))
    }

    for (const [source, g] of bySource) {
      out.push({
        kind: 'threshold',
        source,
        identities: g.identities,
        windowIds: g.windowIds,
        level: 'warning',
        message: `${providerName(source)} quota: ${g.parts.join(' · ')}`,
      })
    }
  }

  /** Says it in the unit the user configured — a remaining threshold reads as remaining. */
  private thresholdPart(w: QuotaWindow, usedLevel: number): string {
    if (this.cfg.basis === 'remaining') {
      const left = Math.max(0, 100 - w.percent)
      return `${w.label} has ${pct(left)} left (threshold ${pct(100 - usedLevel)})`
    }
    return `${w.label} at ${pct(w.percent)} (threshold ${pct(usedLevel)})`
  }

  private paceDecisions(
    candidates: Candidate[],
    state: AlertsState,
    now: number,
    out: AlertDecision[],
    announced: Set<string>,
  ): void {
    if (!this.cfg.onPaceFast) return
    const bySource = new Map<Source, Grouped>()
    for (const c of candidates) {
      if (announced.has(c.identity)) continue
      const v = c.verdict
      if (v === undefined || v.measuring) continue
      const entry = entryOf(state, c.identity)
      const fast = v.level !== 'ok'
      const wasOk = entry.paceLevel === undefined || entry.paceLevel === 'ok'
      entry.paceLevel = v.level
      entry.at = now
      state.entries[c.identity] = entry
      if (!fast || !wasOk || entry.paceWarned) continue
      entry.paceWarned = true
      announced.add(c.identity)
      collect(bySource, c, `${c.window.label} — ${v.text} (${pct(c.window.percent)} used)`)
    }
    for (const [source, g] of bySource) {
      out.push({
        kind: 'pace',
        source,
        identities: g.identities,
        windowIds: g.windowIds,
        level: 'warning',
        message: `${providerName(source)} pace: ${g.parts.join(' · ')}`,
      })
    }
  }

  private forecastDecisions(
    candidates: Candidate[],
    state: AlertsState,
    now: number,
    out: AlertDecision[],
    announced: Set<string>,
  ): void {
    const lead = this.cfg.forecastLeadMinutes
    if (!(lead > 0)) return
    const bySource = new Map<Source, Grouped>()
    for (const c of candidates) {
      if (announced.has(c.identity)) continue
      const f = c.forecast
      if (f === undefined || f.state !== 'eta' || f.etaMs === null || !Number.isFinite(f.etaMs)) continue
      if (f.etaMs - now >= lead * 60_000) continue
      // A window that resets before it would run out needs no warning: the
      // limit is never reached, so saying it would be would be an invention.
      if (c.window.resetsAt !== null && f.etaMs >= c.window.resetsAt) continue
      const entry = entryOf(state, c.identity)
      if (entry.forecastWarned) continue
      entry.forecastWarned = true
      entry.at = now
      state.entries[c.identity] = entry
      announced.add(c.identity)
      const reset = c.window.resetsAt !== null
        ? `, before it resets (${relativeShort(c.window.resetsAt, now)})`
        : ''
      const when = f.etaMs > now ? `in ~${relativeShort(f.etaMs, now)}` : 'imminently'
      collect(bySource, c, `${c.window.label} runs out ${when}${reset}`)
    }
    for (const [source, g] of bySource) {
      out.push({
        kind: 'forecast',
        source,
        identities: g.identities,
        windowIds: g.windowIds,
        level: 'warning',
        message: `${providerName(source)} — on this pace: ${g.parts.join(' · ')}`,
      })
    }
  }

  /**
   * Budgets: the user's own limit for a period, judged against the local buckets.
   *
   * The staleness rule of `candidatesOf` deliberately does not apply here — there is no
   * provider reading to be stale, and gating a budget on a quota response would tie the
   * user's own number to a network call they may have declined. The gate is instead that
   * the period has local data at all (`row.covered`), plus the caller's promise not to
   * pass rows while a scan is in flight.
   *
   * Only an escalation speaks: the recorded level is the configured percentage that was
   * breached, so raising the setting mid-period can speak again while the same setting
   * never speaks twice. A new period is a new identity, so "once per period" needs no
   * rule of its own. Everything one period has to say becomes one message.
   */
  private budgetDecisions(
    budgets: BudgetRow[],
    state: AlertsState,
    now: number,
    out: AlertDecision[],
    announced: Set<string>,
  ): void {
    const level = this.budgetPercent()
    if (!(level > 0) || budgets.length === 0) return
    const byPeriod = new Map<BudgetPeriod, BudgetGroup>()

    for (const r of budgets) {
      if (!r.covered || r.share === null || !Number.isFinite(r.share)) continue
      if (r.share < level) continue
      const entry = entryOf(state, r.identity)
      if (entry.budgetLevel !== undefined && level <= entry.budgetLevel) {
        // Already announced for this period — but the entry is what keeps it quiet, so it
        // is touched while the period is still running. Without this, a save triggered by
        // any other alert could age it out mid-period and the period would speak twice.
        entry.at = now
        state.entries[r.identity] = entry
        continue
      }
      entry.budgetLevel = level
      entry.at = now
      state.entries[r.identity] = entry
      announced.add(r.identity)

      const group = byPeriod.get(r.period)
        ?? { parts: [], identities: [], keys: [], scopes: new Set<BudgetRow['scope']>() }
      // The lower bound is stated, not rounded away: unpriced models make a money
      // budget's used figure — and therefore its share — a floor, never the whole story.
      group.parts.push(
        `${r.label} — ${r.usedText} of ${r.limitText} (${r.shareText}${r.partial ? ', lower bound' : ''})`,
      )
      group.identities.push(r.identity)
      group.keys.push(r.key)
      group.scopes.add(r.scope)
      byPeriod.set(r.period, group)
    }

    for (const [period, g] of byPeriod) {
      // A message that mixes scopes belongs to no single provider.
      const subject: AlertSubject = g.scopes.size === 1 ? [...g.scopes][0] : 'total'
      out.push({
        kind: 'budget',
        source: subject,
        identities: g.identities,
        windowIds: [],
        budgetKeys: g.keys,
        level: 'warning',
        message: `Budget ${PERIOD_TITLE[period]} — past ${pct(level)}: ${g.parts.join(' · ')}`,
      })
    }
  }

  /** The one friendly notice: a weekly window that will expire barely used. */
  private useItDecisions(
    candidates: Candidate[],
    state: AlertsState,
    now: number,
    out: AlertDecision[],
    announced: Set<string>,
  ): void {
    if (!this.cfg.useItLoseIt) return
    const bySource = new Map<Source, Grouped>()
    for (const c of candidates) {
      if (announced.has(c.identity)) continue
      const w = c.window
      if (w.kind !== 'weekly' || w.percent >= 60) continue
      if (w.resetsAt === null || !Number.isFinite(w.resetsAt)) continue
      const left = w.resetsAt - now
      if (left <= 0 || left >= 2 * 24 * 60 * 60 * 1000) continue
      const entry = entryOf(state, c.identity)
      if (entry.useItWarned) continue
      entry.useItWarned = true
      entry.at = now
      state.entries[c.identity] = entry
      announced.add(c.identity)
      collect(bySource, c, `${w.label} is at ${pct(w.percent)} and resets in ${relativeShort(w.resetsAt, now)}`)
    }
    for (const [source, g] of bySource) {
      out.push({
        kind: 'useItLoseIt',
        source,
        identities: g.identities,
        windowIds: g.windowIds,
        level: 'info',
        message: `${providerName(source)} — unused allowance does not carry over: ${g.parts.join(' · ')}`,
      })
    }
  }
}

/** The editor notification, required lazily so the class itself stays vscode-free. */
const defaultNotify: Notify = (message, actions, level) => {
  const vscode = require('vscode') as typeof import('vscode')
  return level === 'info'
    ? vscode.window.showInformationMessage(message, ...actions)
    : vscode.window.showWarningMessage(message, ...actions)
}
