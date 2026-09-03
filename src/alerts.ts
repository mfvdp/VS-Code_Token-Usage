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
 *  • Several thresholds broken at once become one message per provider.
 *
 * The class has no vscode import: the notifier is injected, which is also what
 * makes the whole rule set testable.
 */

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

export type AlertKind = 'threshold' | 'pace' | 'useItLoseIt' | 'forecast'

export interface AlertDecision {
  kind: AlertKind
  source: Source
  /** Identities covered — more than one when thresholds were consolidated. */
  identities: string[]
  windowIds: string[]
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

/** Entries older than this are dropped: their cycle cannot come back. */
const ENTRY_TTL_MS = 14 * 24 * 60 * 60 * 1000
const MAX_ENTRIES = 200
const DEFAULT_STALE_MS = 20 * 60 * 1000

/** Next local midnight — "not today" means this calendar day in the user's zone. */
export function nextLocalMidnight(now: number): number {
  const d = new Date(now)
  d.setHours(0, 0, 0, 0)
  return d.getTime() + 24 * 60 * 60 * 1000
}

function providerName(source: Source): string {
  return source === 'claude' ? 'Claude' : 'Codex'
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

export class Alerts {
  private staleAfterMs: number

  constructor(
    private memento: MementoLike,
    private cfg: AlertConfig,
    private log: (msg: string) => void,
    private notify: Notify = defaultNotify,
    opts: { staleAfterMs?: number } = {},
  ) {
    this.staleAfterMs = opts.staleAfterMs ?? DEFAULT_STALE_MS
  }

  setConfig(cfg: AlertConfig): void {
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
   */
  async evaluate(
    states: QuotaState[],
    verdicts: Map<string, PaceVerdict>,
    forecasts: Map<string, Forecast>,
    now: number,
  ): Promise<AlertDecision[]> {
    if (!this.enabled()) return []
    const state = this.load()
    if (state.snoozedUntil !== undefined && state.snoozedUntil > now) return []

    const candidates = this.candidatesOf(states, verdicts, forecasts, now)
    if (candidates.length === 0) return []

    const pending: AlertDecision[] = []
    const announced = new Set<string>()

    this.thresholdDecisions(candidates, state, now, pending, announced)
    this.paceDecisions(candidates, state, now, pending, announced)
    this.forecastDecisions(candidates, state, now, pending, announced)
    this.useItDecisions(candidates, state, now, pending, announced)

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
    const bySource = new Map<Source, { parts: string[]; identities: string[]; windowIds: string[] }>()

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

      const group = bySource.get(c.source) ?? { parts: [], identities: [], windowIds: [] }
      group.parts.push(this.thresholdPart(c.window, breached))
      group.identities.push(c.identity)
      group.windowIds.push(c.window.id)
      bySource.set(c.source, group)
    }

    for (const [source, group] of bySource) {
      out.push({
        kind: 'threshold',
        source,
        identities: group.identities,
        windowIds: group.windowIds,
        level: 'warning',
        message: `${providerName(source)} quota: ${group.parts.join(' · ')}`,
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
      out.push({
        kind: 'pace',
        source: c.source,
        identities: [c.identity],
        windowIds: [c.window.id],
        level: 'warning',
        message: `${providerName(c.source)} · ${c.window.label}: ${v.text} (${pct(c.window.percent)} used).`,
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
      out.push({
        kind: 'forecast',
        source: c.source,
        identities: [c.identity],
        windowIds: [c.window.id],
        level: 'warning',
        message: `${providerName(c.source)} · ${c.window.label}: on this pace it runs out ${when}${reset}.`,
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
      out.push({
        kind: 'useItLoseIt',
        source: c.source,
        identities: [c.identity],
        windowIds: [w.id],
        level: 'info',
        message: `${providerName(c.source)} · ${w.label}: only ${pct(w.percent)} used and the window resets in ${relativeShort(w.resetsAt, now)} — unused allowance does not carry over.`,
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
