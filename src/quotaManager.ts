// SPDX-FileCopyrightText: 2026 Frederik Marx
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Scheduling around the quota sources: when to fetch, when not to, and what to
 * do with the answer.
 *
 * Everything expensive or irreversible happens here and nowhere else — the one
 * network request, the write-back of the external cache file, the history
 * samples, the persistent app-server child. Each of them has a gate in front of
 * it (mode, consent, leader, focus), and every gate can be named, so the status
 * bar can always say why there is no figure instead of showing a made-up one.
 */

import * as fs from 'fs'
import { SOURCES } from './adapters'
import { PersistentAppServer, findCodexBinary as realFindCodexBinary } from './appServer'
import { detectClaudeVersion as realDetectClaudeVersion, PollFn, PollOptions, poll as realPoll } from './poller'
import { codexStateFromBody, quotaFileFor, writeQuotaCacheFile } from './quota'
import { fingerprintFor } from './quotaHistory'
import {
  bestState, Candidate, ClaudeSourceId, CodexSourceId, ContextReading, QuotaMode, SourceExtras, SourceInputs,
} from './quotaSources'
import { CodexRateLimitsSnapshot, ProblemKind, QuotaState, Source } from './types'

export type QuotaSource = QuotaMode

export interface QuotaOptions {
  mode: QuotaMode
  intervalMinutes: number
  claudeDir?: string
  codexBinary?: string
  claudeOrder: ClaudeSourceId[]
  codexOrder: CodexSourceId[]
  keychain: boolean
  userAgent: 'claudeCode' | 'honest'
  writeQuotaCache: boolean
  appServerMode: 'oneShot' | 'persistent'
  pollOnlyWhenFocused: boolean
}

export interface QuotaFiles {
  stateFile: string
  historyFile: string
  mirrorFile: string
  claudeJsonFile: string
  /** Overrides for the external cache files; default to the configured paths. */
  claudeCacheFile?: string
  codexCacheFile?: string
}

/** What the manager needs from the history — a fake is enough for tests. */
export interface HistorySink {
  add(state: QuotaState, fingerprint: string, now: number): number
  save(): void
}

export interface Scheduled {
  cancel(): void
}

/**
 * Injectable edges. Everything that talks to the network, the clock or a child
 * process is reachable through here, so the scheduling logic can be tested
 * without any of them.
 */
export interface QuotaDeps {
  poll?: PollFn
  now?: () => number
  random?: () => number
  schedule?: (fn: () => void, delayMs: number) => Scheduled
  detectClaudeVersion?: () => Promise<string | null>
  extVersion?: string
  writeCache?: (file: string, source: Source, body: unknown, fetchedAtSec: number, writer: string) => boolean
  findCodexBinary?: (override?: string) => string | null
  createAppServer?: (bin: string, log: (m: string) => void) => PersistentAppServer
}

/** Why a fetch did not happen — so the caller can say something useful. */
export type Blocked = 'mode' | 'consent' | 'follower' | null

const MINUTE_MS = 60_000
const HOUR_MS = 3_600_000
/** Wait this long past the announced reset before asking — servers round, too. */
const RESET_DELAY_MS = 5_000
/** Spread of the reset re-poll: several windows must not knock at the same second. */
const RESET_JITTER_MS = 10_000
/** A reading this close before the reset already reflects it — clocks differ. */
const RESET_SKEW_MS = 60_000
/** Below this the window stays quiet; beyond it a refocus triggers a freshness check. */
const UNFOCUSED_GRACE_MS = 10 * MINUTE_MS
/**
 * How long a `current()` answer may be replayed before the files are read again.
 *
 * The status bar ticks every second and every tick asks for the current reading;
 * without this the two cache files, the status-line mirror and `~/.claude.json`
 * would be parsed once a second for a number that changes every few minutes.
 * Anything that can make the answer wrong calls `invalidate()`, so the memo only
 * ever hides a change nobody told us about — and that for at most five seconds.
 */
const MEMO_MS = 5_000
const STATE_FILE_VERSION = 1

/**
 * Whether the mode permits a fetch of our own.
 *
 * Only `poll` does, on every platform. `auto` reads the local sources and offers
 * once to switch — it deliberately does not start using the access token by
 * itself. `cache` is the same minus the offer, for anyone who wants the question
 * settled for good.
 */
export function pollsItself(mode: QuotaMode): boolean {
  return mode === 'poll'
}

function defaultSchedule(fn: () => void, delayMs: number): Scheduled {
  const t = setTimeout(fn, delayMs)
  t.unref?.()
  return { cancel: () => clearTimeout(t) }
}

const NO_HISTORY: HistorySink = {
  // Callers that do not pass a history get none; nothing is silently invented.
  add: () => 0,
  save: () => { /* nothing to save */ },
}

export class QuotaManager {
  private files: QuotaFiles
  private deps: Required<Omit<QuotaDeps, 'createAppServer'>> & { createAppServer: NonNullable<QuotaDeps['createAppServer']> }

  private polled: Partial<Record<Source, QuotaState>> = {}
  private problem: Partial<Record<Source, { text: string; kind: ProblemKind }>> = {}
  private failCount: Record<Source, number> = { claude: 0, codex: 0 }
  private nextPollAt: Record<Source, number> = { claude: 0, codex: 0 }
  private inFlight: Partial<Record<Source, boolean>> = {}
  /** Sources with a forced fetch pending — skips the freshness check. */
  private forced = new Set<Source>()

  private lastStates: Partial<Record<Source, QuotaState>> = {}
  private lastCandidates: Record<Source, Candidate[]> = { claude: [], codex: [] }
  /** What the status line knew beyond the windows; only Claude ever has one. */
  private lastExtras: Partial<Record<Source, SourceExtras | null>> = {}
  /** The last `current()` answer, replayed for MEMO_MS. Null means "read the files". */
  private memo: { at: number; states: QuotaState[] } | null = null
  private identityHint: Partial<Record<Source, string | null>> = {}
  /** Last `fetchedAt` handed to the history, per source and origin. */
  private historyAt = new Map<string, number>()

  private leader = true
  private focused = true
  private unfocusedSince: number | null = null
  private onUpdate: () => void = () => { /* set by tick/forcePoll */ }

  private resetTriggered = new Map<string, number>()
  private resetTimers = new Set<Scheduled>()

  private appServer: PersistentAppServer | null = null
  private pushSub: { dispose(): void } | null = null
  private claudeVersion: string | null = null
  private versionAsked = false

  constructor(
    private opts: QuotaOptions,
    files: QuotaFiles | string,
    private log: (msg: string) => void,
    /** Second gate: the mode may allow a fetch, the user still has to have agreed. */
    private consented: () => boolean = () => true,
    private transcriptSnapshots: () => CodexRateLimitsSnapshot[] = () => [],
    private history: HistorySink = NO_HISTORY,
    deps: QuotaDeps = {},
  ) {
    this.files = typeof files === 'string'
      ? { stateFile: files, historyFile: '', mirrorFile: '', claudeJsonFile: '' }
      : files
    this.deps = {
      poll: deps.poll ?? realPoll,
      now: deps.now ?? (() => Date.now()),
      random: deps.random ?? Math.random,
      schedule: deps.schedule ?? defaultSchedule,
      detectClaudeVersion: deps.detectClaudeVersion ?? realDetectClaudeVersion,
      extVersion: deps.extVersion ?? (typeof __EXT_VERSION__ === 'string' ? __EXT_VERSION__ : '0.0.0'),
      writeCache: deps.writeCache ?? writeQuotaCacheFile,
      findCodexBinary: deps.findCodexBinary ?? realFindCodexBinary,
      createAppServer: deps.createAppServer ?? ((bin, l) => new PersistentAppServer(bin, l)),
    }
    this.restore()
  }

  // ------------------------------------------------------------------ gates

  /** Why `tick` would not fetch, or null if it may. */
  blocked(): Blocked {
    if (!pollsItself(this.opts.mode)) return 'mode'
    if (!this.consented()) return 'consent'
    if (!this.leader) return 'follower'
    return null
  }

  setOptions(opts: QuotaOptions): void {
    const before = this.opts
    this.opts = opts
    // The mode, the order and the paths all decide what `current()` answers.
    this.invalidate()
    // A changed mode or binary means the running child no longer matches the
    // configuration; it is started again on the next tick if still wanted.
    if (before.appServerMode !== opts.appServerMode || before.codexBinary !== opts.codexBinary) {
      this.stopAppServer()
    }
  }

  setLeader(isLeader: boolean): void {
    if (this.leader === isLeader) return
    this.leader = isLeader
    // The role is part of the answer ("another window fetches for this editor").
    this.invalidate()
    // A follower keeps no child process: one app-server per editor, not per window.
    if (!isLeader) this.stopAppServer()
  }

  /**
   * Window focus. A window that has been in the background for more than ten
   * minutes stops its scheduled polls; regaining focus after that runs one
   * freshness check, which is also what catches a machine coming back from
   * standby.
   */
  setFocused(f: boolean, onUpdate?: () => void): void {
    if (f === this.focused) return
    this.focused = f
    if (!f) {
      this.unfocusedSince = this.deps.now()
      return
    }
    const wasLong = this.unfocusedSince !== null
      && this.deps.now() - this.unfocusedSince > UNFOCUSED_GRACE_MS
    this.unfocusedSince = null
    if (wasLong) this.tick(onUpdate ?? this.onUpdate)
  }

  // ----------------------------------------------------------------- state

  /**
   * The current best reading per provider, without touching the network.
   *
   * A window whose reset has passed keeps its percentage: the display layer
   * renders "reset due" from the same facts (`windowDisplay`). Zeroing it here
   * would be a reset we simulated ourselves.
   */
  current(now = this.deps.now()): QuotaState[] {
    const age = this.memo === null ? Infinity : now - this.memo.at
    // A clock that went backwards is not an age — read again rather than guess.
    if (this.memo !== null && age >= 0 && age < MEMO_MS) return [...this.memo.states]
    const out: QuotaState[] = []
    for (const src of SOURCES) {
      const r = bestState(src, this.inputs(), now)
      const state = this.enrich(src, r.state)
      this.lastCandidates[src] = r.candidates
      this.lastExtras[src] = r.extras
      this.lastStates[src] = state
      if (r.identityHint) this.identityHint[src] = r.identityHint
      // Followers read the same files; only the leader writes the shared history.
      if (this.leader) this.addHistory(state, now)
      this.scheduleResetRepolls(state, now)
      out.push(state)
    }
    this.memo = { at: now, states: out }
    return [...out]
  }

  /**
   * Drops the short-lived `current()` memo.
   *
   * Every caller that knows something changed says so here: the file watchers on
   * the two cache files, the mirror and `~/.claude.json`, the end of a fetch, a
   * changed setting, a role change. A memo that outlives the fact it describes is
   * worse than no memo at all, so this is deliberately cheap to call too often.
   */
  invalidate(): void {
    this.memo = null
  }

  candidates(): Record<Source, Candidate[]> {
    return { claude: [...this.lastCandidates.claude], codex: [...this.lastCandidates.codex] }
  }

  /**
   * The context window of the running Claude Code session, when the status-line
   * bridge reported one — otherwise null, never a figure derived from buckets.
   *
   * Like `candidates()` this reports the last `current()` reading rather than
   * re-reading the files, and it stays outside every `QuotaState`: it describes
   * one session, not the account, and only the status line can know it. It is
   * therefore shown even when a fresher source won the quota race — with its own
   * timestamp, so a stale mirror says so instead of borrowing the winner's age.
   */
  contextReading(): ContextReading | null {
    return this.lastExtras.claude?.context ?? null
  }

  driftReport(): Record<Source, string[]> {
    return {
      claude: [...(this.lastStates.claude?.drift ?? [])],
      codex: [...(this.lastStates.codex?.drift ?? [])],
    }
  }

  /**
   * The account fingerprints the history is keyed by.
   *
   * Never derived from the token: Claude uses the hashed account uuid from
   * `~/.claude.json` when it is there and the plan type otherwise, Codex the plan
   * type plus the set of limit ids.
   */
  fingerprints(): Record<Source, string> {
    return { claude: this.fingerprintOf('claude'), codex: this.fingerprintOf('codex') }
  }

  // ------------------------------------------------------------- scheduling

  /** Kicks off due fetches. Runs in the background; the result lands in `current()`. */
  tick(onUpdate: () => void = this.onUpdate): void {
    this.onUpdate = onUpdate
    const now = this.deps.now()
    // Re-reading the file sources is all a follower does — it renders whatever the
    // leader, or an external poller, has written.
    this.current(now)
    if (this.blocked()) return
    this.ensureAppServer()
    if (this.focusSkips(now)) return
    this.runPolls(now)
  }

  /** Immediate fetch, regardless of the interval. Mode and consent still apply. */
  forcePoll(onUpdate: () => void): void {
    const why = this.blocked()
    if (why === 'mode' || why === 'consent') {
      this.log(why === 'mode'
        ? `No fetch of our own: quotaSource is "${this.opts.mode}". Set it to "poll" to fetch here.`
        : 'No fetch of our own: network access has not been allowed.')
      onUpdate()
      return
    }
    // A follower may still fetch on request: the caller takes the lease over first,
    // and "in doubt, poll yourself" beats showing a stale figure.
    this.onUpdate = onUpdate
    // Deliberately KEEP the previous state: if the forced fetch fails, a slightly
    // older value still beats an empty display.
    this.nextPollAt = { claude: 0, codex: 0 }
    for (const src of SOURCES) this.forced.add(src)
    this.runPolls(this.deps.now())
  }

  /**
   * Forgets everything this process fetched itself.
   *
   * Used after "Clear Stored Data" removed `quota.json`: keeping the in-memory copy would
   * put the deleted figures straight back on screen, and write them out again on the next
   * poll. The file sources are untouched — they are not ours to forget.
   */
  clearPolled(): void {
    this.polled = {}
    this.problem = {}
    this.failCount = { claude: 0, codex: 0 }
    this.nextPollAt = { claude: 0, codex: 0 }
    this.lastStates = {}
    this.lastCandidates = { claude: [], codex: [] }
    this.lastExtras = {}
    this.identityHint = {}
    this.historyAt.clear()
    this.resetTriggered.clear()
    this.invalidate()
  }

  dispose(): void {
    this.stopAppServer()
    for (const t of this.resetTimers) t.cancel()
    this.resetTimers.clear()
  }

  // ---------------------------------------------------------------- internals

  private intervalMs(): number {
    return Math.max(1, this.opts.intervalMinutes) * MINUTE_MS
  }

  private inputs(): SourceInputs {
    return {
      claudeOrder: this.opts.claudeOrder,
      codexOrder: this.opts.codexOrder,
      polled: this.polled,
      transcript: this.transcriptSnapshots,
      mirrorFile: this.files.mirrorFile,
      claudeJsonFile: this.files.claudeJsonFile,
      claudeCacheFile: this.files.claudeCacheFile,
      codexCacheFile: this.files.codexCacheFile,
      mode: this.opts.mode,
    }
  }

  /**
   * Adds the two fields the display layer needs but the parsers cannot know: why
   * there is no figure, and when the next attempt is due.
   */
  private enrich(src: Source, state: QuotaState): QuotaState {
    const permitted = this.blocked() === null
    // Zero means "never scheduled"; reporting it as a date would be an invented one.
    const nextAttemptAt = permitted && this.nextPollAt[src] > 0 ? this.nextPollAt[src] : null
    if (state.ok) return { ...state, nextAttemptAt }
    const own = this.problem[src]
    let kind: ProblemKind
    let text: string
    if (permitted && own) {
      // Our own attempt is the most recent and most actionable evidence.
      kind = own.kind
      text = own.text
    } else {
      const why = this.blocked()
      if (why === 'consent') {
        kind = 'consentPending'
        text = 'Network access has not been allowed yet'
      } else if (why === 'follower') {
        kind = 'follower'
        text = 'Another window holds the lease and fetches for this editor'
      } else if (why === 'mode') {
        // Whatever the winning source said beats the mode: the mode only explains
        // why we did not fetch ourselves, not why the local reading is missing.
        const named = state.problemKind && state.problemKind !== 'unknown' ? state.problemKind : null
        // `blocked()` answers 'mode' for the default `auto` as well. Only the
        // explicit `cache` mode may be named as the cause — otherwise the status
        // bar would explain a mode that is not set and advise switching to the
        // one that already is.
        kind = named ?? (this.opts.mode === 'cache' ? 'modeCache' : 'unknown')
        text = state.problem ?? `No fetch of our own: quotaSource is "${this.opts.mode}"`
      } else {
        kind = state.problemKind ?? 'unknown'
        text = state.problem ?? 'No quota reading'
      }
    }
    return { ...state, problem: text, problemKind: kind, nextAttemptAt }
  }

  private focusSkips(now: number): boolean {
    return this.opts.pollOnlyWhenFocused
      && !this.focused
      && this.unfocusedSince !== null
      && now - this.unfocusedSince > UNFOCUSED_GRACE_MS
  }

  private runPolls(now: number): void {
    for (const src of SOURCES) {
      if (this.inFlight[src]) continue
      const forced = this.forced.delete(src)
      if (!forced) {
        if (now < this.nextPollAt[src]) continue
        // A fresh reading from somebody else answers the same question for free.
        const best = this.lastStates[src]
        const foreign = best?.ok && best.origin !== 'poll' && best.origin !== 'push'
        if (foreign && this.ageMs(best, now) < this.intervalMs()) {
          this.nextPollAt[src] = now + MINUTE_MS
          continue
        }
        const own = this.polled[src]
        if (own?.ok && this.ageMs(own, now) < this.intervalMs()) {
          this.nextPollAt[src] = (own.fetchedAt ?? 0) * 1000 + this.intervalMs()
          continue
        }
      }
      void this.startPoll(src)
    }
  }

  private ageMs(state: QuotaState | undefined, now: number): number {
    const at = state?.fetchedAt
    return typeof at === 'number' && Number.isFinite(at) ? now - at * 1000 : Infinity
  }

  private async startPoll(src: Source): Promise<void> {
    this.inFlight[src] = true
    try {
      if (src === 'claude' && !this.versionAsked) {
        this.versionAsked = true
        this.claudeVersion = await this.deps.detectClaudeVersion()
      }
      const opts: PollOptions = {
        claudeDir: this.opts.claudeDir,
        codexBinary: this.opts.codexBinary,
        keychain: this.opts.keychain,
        userAgent: this.opts.userAgent,
        extVersion: this.deps.extVersion,
        claudeVersion: this.claudeVersion,
      }
      const r = await this.deps.poll(src, this.failCount[src], opts)
      const now = this.deps.now()
      if (r.state) {
        this.polled[src] = r.state
        delete this.problem[src]
        this.failCount[src] = 0
        this.nextPollAt[src] = now + this.intervalMs()
        this.lastStates[src] = r.state
        this.addHistory(r.state, now)
        this.writeBack(src, r.raw, r.state)
        this.persist()
        this.log(`${src}: quota fetched`)
      } else {
        this.problem[src] = { text: r.problem ?? 'Fetch failed', kind: r.problemKind ?? 'unknown' }
        this.failCount[src] += 1
        // No retry hint means a permanent cause (missing credentials, no binary) —
        // do not keep asking every minute in that case.
        const wait = r.retryAfterSeconds ?? this.intervalMs() / 1000
        this.nextPollAt[src] = now + wait * 1000
        this.persist()
        this.log(`${src}: ${this.problem[src]!.text} — next attempt in ${Math.round(wait / 60)} min`)
      }
    } catch (e) {
      this.problem[src] = { text: 'Unexpected error while fetching', kind: 'unknown' }
      this.failCount[src] += 1
      this.nextPollAt[src] = this.deps.now() + this.intervalMs()
      this.log(`${src}: ${(e as Error)?.name ?? 'error'} while fetching`)
    } finally {
      this.inFlight[src] = false
      // The result — a state, a problem or a moved backoff — changes the answer.
      this.invalidate()
      this.onUpdate()
    }
  }

  /**
   * One history sample per real reading.
   *
   * The guard is the caller contract of `QuotaHistory.add`: a state replayed from
   * memory is not a measurement. Tracking the last `fetchedAt` per source and
   * origin is what tells the two apart.
   */
  private addHistory(state: QuotaState, now: number): void {
    if (!state.ok || !state.origin) return
    const at = typeof state.fetchedAt === 'number' && Number.isFinite(state.fetchedAt)
      ? state.fetchedAt
      : null
    if (at === null) return
    const key = `${state.source}:${state.origin}`
    if (this.historyAt.get(key) === at) return
    this.historyAt.set(key, at)
    try {
      if (this.history.add(state, this.fingerprintOf(state.source), now) > 0) this.history.save()
    } catch {
      /* history is a convenience; losing a sample must not break the poll loop */
    }
  }

  private fingerprintOf(src: Source): string {
    if (src === 'claude') {
      const hint = this.identityHint.claude ?? this.lastStates.claude?.planType ?? null
      return fingerprintFor('claude', hint)
    }
    const st = this.lastStates.codex ?? this.polled.codex
    const ids = [...new Set((st?.windows ?? []).map((w) => w.id.split(':')[0]))].sort()
    return fingerprintFor('codex', `${st?.planType ?? 'unknown'}:${ids.join(',')}`)
  }

  /**
   * Optional write-back of the external cache file.
   *
   * One of exactly two writes outside globalStorage, behind its own consent. The
   * writer never overwrites a newer foreign file, so two pollers converge instead
   * of fighting.
   */
  private writeBack(src: Source, raw: unknown, state: QuotaState): void {
    if (!this.opts.writeQuotaCache || raw === undefined || raw === null) return
    const at = typeof state.fetchedAt === 'number' ? state.fetchedAt : null
    if (at === null) return
    const file = src === 'claude'
      ? this.files.claudeCacheFile ?? quotaFileFor('claude')
      : this.files.codexCacheFile ?? quotaFileFor('codex')
    const wrote = this.deps.writeCache(file, src, raw, at, `token-pace/${this.deps.extVersion}`)
    if (!wrote) this.log(`${src}: cache file left alone — it is not older than our reading`)
  }

  // --------------------------------------------------------- reset rollover

  /**
   * One re-poll per window and reset.
   *
   * The moment a window turns over is the most important one for a pace tool, and
   * the least likely to be caught by a 30-minute interval. The trigger fires once
   * per (window, resetsAt) with jitter, and only when the reading in hand is
   * older than the reset — a jumping `resets_at` must not become a poll loop.
   */
  private scheduleResetRepolls(state: QuotaState, now: number): void {
    if (this.blocked()) return
    const fetchedMs = typeof state.fetchedAt === 'number' ? state.fetchedAt * 1000 : null
    for (const w of state.windows) {
      const r = w.resetsAt
      if (r === null || !Number.isFinite(r)) continue
      // A reset more than an hour in the past is not going to be answered by one
      // more request; the provider has simply stopped updating that window.
      if (r < now - HOUR_MS) continue
      if (fetchedMs !== null && fetchedMs >= r - RESET_SKEW_MS) continue
      const key = `${state.source}:${w.id}:${r}`
      if (this.resetTriggered.has(key)) continue
      this.resetTriggered.set(key, r)
      const delay = Math.max(0, r + RESET_DELAY_MS + Math.floor(this.deps.random() * RESET_JITTER_MS) - now)
      const handle = this.deps.schedule(() => {
        this.resetTimers.delete(handle)
        this.onResetDue(state.source, w.id, r)
      }, delay)
      this.resetTimers.add(handle)
    }
    this.pruneTriggers(now)
  }

  private onResetDue(src: Source, windowId: string, resetsAt: number): void {
    const now = this.deps.now()
    const at = this.lastStates[src]?.fetchedAt
    const fetchedMs = typeof at === 'number' ? at * 1000 : null
    // Loop guard: a reading that already covers the reset makes the trigger moot.
    if (fetchedMs !== null && fetchedMs >= resetsAt - RESET_SKEW_MS) return
    if (this.blocked()) return
    this.log(`${src}: ${windowId} reset — fetching once`)
    this.forced.add(src)
    this.nextPollAt[src] = 0
    this.runPolls(now)
  }

  private pruneTriggers(now: number): void {
    for (const [key, resetsAt] of this.resetTriggered) {
      if (resetsAt < now - 24 * HOUR_MS) this.resetTriggered.delete(key)
    }
  }

  // ------------------------------------------------------------- app-server

  private ensureAppServer(): void {
    if (this.opts.appServerMode !== 'persistent') {
      this.stopAppServer()
      return
    }
    if (this.appServer) return
    const bin = this.deps.findCodexBinary(this.opts.codexBinary)
    if (!bin) return
    const srv = this.deps.createAppServer(bin, this.log)
    this.appServer = srv
    this.pushSub = srv.onNotification((method, params) => {
      if (method !== 'account/rateLimits/updated') return
      this.applyPush(params)
    })
    srv.start()
    this.log('codex: app-server running as a persistent connection')
  }

  private stopAppServer(): void {
    this.pushSub?.dispose()
    this.pushSub = null
    this.appServer?.stop()
    this.appServer = null
  }

  /**
   * A push is data, not a refresh trigger: the payload carries the same shape as
   * the read result, is validated by parsing it, and resets the fallback timer
   * instead of stacking a second one on top of it.
   */
  private applyPush(params: unknown): void {
    const now = this.deps.now()
    const state = codexStateFromBody(params, Math.floor(now / 1000), 'push')
    if (!state.ok) {
      this.log('codex: push carried no usable rate limits — ignored')
      return
    }
    this.polled.codex = state
    this.lastStates.codex = state
    delete this.problem.codex
    this.failCount.codex = 0
    this.nextPollAt.codex = now + this.intervalMs()
    this.addHistory(state, now)
    this.writeBack('codex', params, state)
    this.persist()
    this.invalidate()
    this.onUpdate()
  }

  // ------------------------------------------------------------ persistence

  private persist(): void {
    if (!this.files.stateFile) return
    try {
      fs.writeFileSync(this.files.stateFile, JSON.stringify({
        version: STATE_FILE_VERSION,
        polled: this.polled,
        nextPollAt: this.nextPollAt,
      }))
    } catch {
      /* Losing this is survivable — the next interval fetches again. */
    }
  }

  private restore(): void {
    if (!this.files.stateFile) return
    let d: any
    try {
      d = JSON.parse(fs.readFileSync(this.files.stateFile, 'utf8'))
    } catch {
      return
    }
    // Version 0 is the old file: a bare map of source to state.
    const polled = d?.polled ?? d
    for (const src of SOURCES) {
      const st = polled?.[src]
      if (st?.ok) {
        this.polled[src] = st
        // Do not fetch again immediately after a restart.
        this.nextPollAt[src] = (st.fetchedAt ?? 0) * 1000 + this.intervalMs()
      }
      const saved = d?.nextPollAt?.[src]
      if (typeof saved === 'number' && Number.isFinite(saved)) {
        this.nextPollAt[src] = Math.max(this.nextPollAt[src], saved)
      }
    }
  }
}
