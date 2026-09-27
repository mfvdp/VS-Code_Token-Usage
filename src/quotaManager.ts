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
import {
  AppServerStatus, CodexConnection, PersistentAppServer, findCodexBinary as realFindCodexBinary,
} from './appServer'
import { t } from './i18n'
import {
  CLAUDE_VERSION_FALLBACK, detectClaudeVersion as realDetectClaudeVersion, PollFn, PollOptions, poll as realPoll,
} from './poller'
import { codexStateFromBody, quotaFileFor, writeQuotaCacheFile } from './quota'
import { fingerprintFor } from './quotaHistory'
import {
  bestState, Candidate, ClaudeSourceId, CodexSourceId, ContextReading, PromptCacheReading, QuotaMode, SourceExtras,
  SourceInputs,
} from './quotaSources'
import { CodexRateLimitsSnapshot, isTransientFailure, ProblemKind, QuotaState, Source } from './types'

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
  /**
   * 1.7 W3 (§0a.1): the version the newest main session wrote into its transcript, or null. Asked at
   * every poll of Claude — the cold scan may finish after the first one — and only when the CLI gave
   * none.
   */
  transcriptVersion?: () => string | null
  extVersion?: string
  writeCache?: (file: string, source: Source, body: unknown, fetchedAtSec: number, writer: string) => boolean
  findCodexBinary?: (override?: string) => string | null
  createAppServer?: (bin: string, log: (m: string) => void) => PersistentAppServer
}

/** Why a fetch did not happen — so the caller can say something useful. */
export type Blocked = 'mode' | 'consent' | 'follower' | null

/** 1.12 A (§2.1): the standing connection's status for *Copy Diagnostics* — with the mode and this window's role. */
export type AppServerReport = AppServerStatus & { mode: 'oneShot' | 'persistent'; role: 'leader' | 'follower' }

/** The status of a connection that does not exist (the mode is `oneShot`, a gate is closed, no binary). */
const NO_APP_SERVER: AppServerStatus = { state: 'off', restartsLastHour: 0, pushes: 0, lastPushAt: null, pid: null }

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
/**
 * 1.7 W1 (§0a.3): `quota.json` gained the key `failed` — additive, so the version stays 1 and a 1.6
 * build that reads the file ignores it.
 */
const STATE_FILE_VERSION = 1
/** 1.7 W1: the longest reason `quota.json` keeps for a failed attempt; a longer one is not restored. */
const FAILED_TEXT_MAX = 300
/**
 * Every ProblemKind, as a record so the compiler insists on the whole list: a kind read back from
 * `quota.json` is restored only when it is one of these.
 */
const PROBLEM_KINDS: Record<ProblemKind, true> = {
  noFile: true, paused: true, empty: true, noToken: true, tokenExpired: true, consentPending: true,
  modeCache: true, retry: true, offline: true, forbidden: true, unauthorized: true, noBinary: true,
  quotaOff: true, follower: true, unknown: true,
}

/**
 * 1.7 W3 (§0a.1): the shape a transcript's version must have to reach the user agent — the aggregator's
 * own pattern, asked again here, since whatever answers `transcriptVersion` is not this file's to trust.
 */
const TRANSCRIPT_VERSION_RE = /^\d{1,3}\.\d{1,3}\.\d{1,4}$/

/** 1.7 W3: where the user agent's version came from, in the words of the log line. */
const VERSION_FROM = {
  cli: 'from claude --version',
  transcript: 'from the newest transcript',
  fallback: 'fallback',
} as const

/** Our own last failed attempt of a source: the poller's words, their kind, and when (ms). */
interface OwnFailure {
  text: string
  kind: ProblemKind
  at: number
}

/**
 * 1.7 W1 (§0a.3): the shape a failed attempt has to have to be kept or read back — a finite time not
 * in the future, a known kind, a reason of 1 to 300 characters. Anything else is dropped whole.
 */
function failureOf(v: unknown, now: number): OwnFailure | null {
  if (typeof v !== 'object' || v === null) return null
  const f = v as { at?: unknown; kind?: unknown; text?: unknown }
  if (typeof f.at !== 'number' || !Number.isFinite(f.at) || f.at > now) return null
  if (typeof f.kind !== 'string' || !Object.prototype.hasOwnProperty.call(PROBLEM_KINDS, f.kind)) return null
  if (typeof f.text !== 'string' || f.text.length < 1 || f.text.length > FAILED_TEXT_MAX) return null
  return { at: f.at, kind: f.kind as ProblemKind, text: f.text }
}

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

/** 1.8 A1: at most this many sessions' readings are kept; the oldest reading goes first. */
export const CACHE_READINGS_MAX = 16
/** 1.8 A1: a reading older than this (by its readAt) is dropped — a 1 h TTL plus the hour a cold line is shown. */
export const CACHE_READING_KEEP_MS = 2 * 3_600_000

/** 1.8 A1: whether a kept reading is still young enough to keep — its `readAt` (seconds) against now (ms). */
function readingFresh(r: PromptCacheReading, now: number): boolean {
  return r.readAt !== null && now - r.readAt * 1000 <= CACHE_READING_KEEP_MS
}

/** 1.8 A1: newest `readAt` first; a tie by the session id, so the order never depends on the map's. */
function byReadAtDesc(a: PromptCacheReading, b: PromptCacheReading): number {
  const d = (b.readAt ?? 0) - (a.readAt ?? 0)
  if (d !== 0) return d
  const x = a.sessionId ?? ''
  const y = b.sessionId ?? ''
  return x < y ? -1 : x > y ? 1 : 0
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
  /** 1.7 W1: the time of the attempt joins its words, so the display can say when it failed. */
  private problem: Partial<Record<Source, OwnFailure>> = {}
  /** 1.7 W2: whether the focus hold of a due attempt was logged — one line per hold and source. */
  private heldLogged: Partial<Record<Source, boolean>> = {}
  private failCount: Record<Source, number> = { claude: 0, codex: 0 }
  private nextPollAt: Record<Source, number> = { claude: 0, codex: 0 }
  private inFlight: Partial<Record<Source, boolean>> = {}
  /** Sources with a forced fetch pending — skips the freshness check. */
  private forced = new Set<Source>()

  private lastStates: Partial<Record<Source, QuotaState>> = {}
  private lastCandidates: Record<Source, Candidate[]> = { claude: [], codex: [] }
  /** What the status line knew beyond the windows; only Claude ever has one. */
  private lastExtras: Partial<Record<Source, SourceExtras | null>> = {}
  /**
   * 1.8 A1: the newest bridge reading of every session the mirror named since activation, by session id — memory
   * only, never persisted. Filled in `current()` from each read of the mirror; a reading replaces the stored one of its
   * session only when its `readAt` is not older. Cleared by `clearPolled()` (and `clearCacheReadings()`).
   */
  private cacheReadings = new Map<string, PromptCacheReading>()
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
  /** The standing connection's two subscriptions: its pushes and its `ready`. */
  private appServerSubs: Array<{ dispose(): void }> = []
  private claudeVersion: string | null = null
  private versionAsked = false
  /** 1.7 W3: the last user-agent version line logged — a line again only when the version or its source changes. */
  private versionLogged: string | null = null
  /**
   * Set by `dispose`, for good (1.6 R3). A fetch still under way then has nowhere to go: its
   * answer is neither kept, written, sampled nor reported, and nothing starts another one.
   */
  private disposed = false

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
      transcriptVersion: deps.transcriptVersion ?? (() => null),
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
    // 1.12 A4 rule 1: `quotaSource` no longer `poll` ends the standing child at once.
    this.stopWhenBlocked()
  }

  /**
   * 1.12 A4 rule 1: a gate may have closed without a setting changing — the network consent reset by
   * *Reset Network Access Decision*. The caller says so here, and a standing child ends at once instead
   * of at the next tick.
   */
  enforceGates(): void {
    this.stopWhenBlocked()
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
    // 1.7 W2: whether a due attempt is held for focus is part of the answer.
    this.invalidate()
    if (!f) {
      this.unfocusedSince = this.deps.now()
      return
    }
    const wasLong = this.unfocusedSince !== null
      && this.deps.now() - this.unfocusedSince > UNFOCUSED_GRACE_MS
    this.unfocusedSince = null
    // A new hold, after the next absence, gets its own log line.
    this.heldLogged = {}
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
      const state = this.enrich(src, r.state, now)
      this.lastCandidates[src] = r.candidates
      this.lastExtras[src] = r.extras
      // 1.8 A1: the mirror holds one session — the one whose status line ran last —, so each read
      // adds that session's reading to the ones read before.
      if (src === 'claude') this.noteCacheReading(r.extras?.promptCache ?? null, now)
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

  /**
   * The prompt cache of the running Claude Code session, when the status-line
   * bridge reported one — otherwise null. The same rules as `contextReading()`:
   * the last `current()` reading, kept beside the state, with the mirror's own
   * time, and never a figure derived from the transcripts.
   */
  promptCacheReading(): PromptCacheReading | null {
    return this.lastExtras.claude?.promptCache ?? null
  }

  /**
   * 1.8 A1: every kept reading, newest `readAt` first — one per session the status line named since
   * activation, none older than CACHE_READING_KEEP_MS at `now`, at most CACHE_READINGS_MAX. A reading
   * without a session id is never among them (`promptCacheReading()` above still has it).
   */
  promptCacheReadings(now = this.deps.now()): PromptCacheReading[] {
    return [...this.cacheReadings.values()].filter((r) => readingFresh(r, now)).sort(byReadAtDesc)
  }

  /**
   * 1.8 A1: forgets every kept reading — with `clearPolled()`, and when *Clear Stored Data…* deleted the
   * mirror they were read from.
   */
  clearCacheReadings(): void {
    this.cacheReadings.clear()
  }

  /**
   * 1.8 A1: keeps one reading under its session id. An older reading of the session does not replace a
   * newer one (two windows, or a mirror read back after a newer one); a reading without an id or a time,
   * or older than CACHE_READING_KEEP_MS, is not kept; past CACHE_READINGS_MAX the oldest goes.
   */
  private noteCacheReading(r: PromptCacheReading | null, now: number): void {
    for (const [id, kept] of this.cacheReadings) if (!readingFresh(kept, now)) this.cacheReadings.delete(id)
    if (r === null || r.sessionId === null || !readingFresh(r, now)) return
    const kept = this.cacheReadings.get(r.sessionId)
    if (kept !== undefined && (kept.readAt ?? 0) > (r.readAt ?? 0)) return
    this.cacheReadings.set(r.sessionId, r)
    while (this.cacheReadings.size > CACHE_READINGS_MAX) {
      const oldest = [...this.cacheReadings.values()].sort(byReadAtDesc).pop()
      if (oldest?.sessionId == null) break
      this.cacheReadings.delete(oldest.sessionId)
    }
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
    // After `dispose` there is no window to read for, and a fetch started now would outlive it.
    if (this.disposed) return
    this.onUpdate = onUpdate
    const now = this.deps.now()
    // Re-reading the file sources is all a follower does — it renders whatever the
    // leader, or an external poller, has written.
    this.current(now)
    if (this.blocked()) {
      // 1.12 A4 rule 1: a closed gate ends the standing child (1.0.0 left it running until the window closed).
      this.stopWhenBlocked()
      return
    }
    this.ensureAppServer()
    if (this.focusSkips(now)) {
      this.logHeld(now)
      return
    }
    this.runPolls(now)
  }

  /** Immediate fetch, regardless of the interval. Mode and consent still apply. */
  forcePoll(onUpdate: () => void): void {
    // After `dispose`: no fetch, and no report either — the caller's window is gone (1.6 R3).
    if (this.disposed) return
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
    // 1.7 W1: the failed attempts go with the readings — the next persist writes no `failed`.
    this.problem = {}
    this.heldLogged = {}
    this.failCount = { claude: 0, codex: 0 }
    this.nextPollAt = { claude: 0, codex: 0 }
    this.lastStates = {}
    this.lastCandidates = { claude: [], codex: [] }
    this.lastExtras = {}
    // 1.8 A1: the per-session readings go with the rest.
    this.cacheReadings.clear()
    this.identityHint = {}
    this.historyAt.clear()
    this.resetTriggered.clear()
    this.invalidate()
  }

  /**
   * 1.7 P4b: our own last failed attempt per source — its kind and its time (ms), never its words —
   * for *Copy Diagnostics*. Every failure, the permanent ones included, whatever the views say beside
   * a reading; null where the last attempt succeeded or none was made.
   */
  lastFailures(): Record<Source, { kind: ProblemKind; at: number } | null> {
    const of = (src: Source): { kind: ProblemKind; at: number } | null => {
      const f = this.problem[src]
      return f ? { kind: f.kind, at: f.at } : null
    }
    return { claude: of('claude'), codex: of('codex') }
  }

  /**
   * 1.12 A (§2.1): the standing connection for *Copy Diagnostics* — its state, restarts, pushes — with
   * the configured mode and this window's role. `off` where there is none.
   */
  appServerStatus(): AppServerReport {
    const s = this.appServer?.status() ?? NO_APP_SERVER
    return { ...s, mode: this.opts.appServerMode, role: this.leader ? 'leader' : 'follower' }
  }

  dispose(): void {
    this.disposed = true
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
   * Adds the fields the display layer needs but the parsers cannot know: why there is no
   * figure, when the next attempt is due, whether a due attempt waits for focus (1.7 W2), and —
   * beside a reading we still show — that our own fetch after it failed (1.7 W1).
   *
   * 1.7 P4b (Review 1 #1): an attempt is due, or held for focus, only while a fetch is actually
   * wanted — the condition `runPolls` decides by (`answeredBy`). While a fresh reading answers the
   * fetch, the next attempt is not before that reading turns older than the interval, and nothing
   * is said to be due or waiting: a window in the background with a fresh bridge or cache reading
   * is not holding anything back.
   */
  private enrich(src: Source, state: QuotaState, now: number): QuotaState {
    const permitted = this.blocked() === null
    // Zero means "never scheduled"; reporting it as a date would be an invented one.
    const next = this.nextPollAt[src]
    const answered = permitted && next > 0 ? this.answeredBy(src, state, now) : null
    const nextAttemptAt = permitted && next > 0 ? Math.max(next, answered?.until ?? 0) : null
    // 1.7 W2: a scheduled attempt that is due while `tick` skips for focus — said, not left silent.
    const attemptHeld: 'focus' | null = nextAttemptAt !== null && nextAttemptAt <= now && this.focusSkips(now)
      ? 'focus'
      : null
    const own = this.problem[src]
    if (state.ok) {
      // 1.7 W1: the old figure stays on screen after a failed fetch; the failure goes beside it —
      // only while we may fetch at all, and only when it is newer than the reading shown (a foreign
      // reading taken after our failure answers the question the failure left open).
      const fetchedMs = (typeof state.fetchedAt === 'number' && Number.isFinite(state.fetchedAt) ? state.fetchedAt : 0) * 1000
      // 1.7 P4b (Review 1 #2): a transient failure only (`FAILURE_TRANSIENT`) — a permanent cause
      // (no credentials, no binary, a refused endpoint …) stays where no reading exists, as in 1.6.
      // `problem` and `quota.json` keep every failure; only what is said beside a reading filters.
      const lastFailure = permitted && own && isTransientFailure(own.kind) && own.at > fetchedMs
        ? { at: own.at, problem: own.text, kind: own.kind }
        : null
      return { ...state, nextAttemptAt, lastFailure, attemptHeld }
    }
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
        text = t('Network access has not been allowed yet')
      } else if (why === 'follower') {
        kind = 'follower'
        text = t('Another window holds the lease and fetches for this editor')
      } else if (why === 'mode') {
        // Whatever the winning source said beats the mode: the mode only explains
        // why we did not fetch ourselves, not why the local reading is missing.
        const named = state.problemKind && state.problemKind !== 'unknown' ? state.problemKind : null
        // `blocked()` answers 'mode' for the default `auto` as well. Only the
        // explicit `cache` mode may be named as the cause — otherwise the status
        // bar would explain a mode that is not set and advise switching to the
        // one that already is.
        kind = named ?? (this.opts.mode === 'cache' ? 'modeCache' : 'unknown')
        text = state.problem ?? t('No fetch of our own: quotaSource is "{0}"', this.opts.mode)
      } else {
        kind = state.problemKind ?? 'unknown'
        text = state.problem ?? t('No quota reading')
      }
    }
    return { ...state, problem: text, problemKind: kind, nextAttemptAt, attemptHeld }
  }

  private focusSkips(now: number): boolean {
    return this.opts.pollOnlyWhenFocused
      && !this.focused
      && this.unfocusedSince !== null
      && now - this.unfocusedSince > UNFOCUSED_GRACE_MS
  }

  /**
   * 1.7 W2: one English log line per hold and source, when a due attempt waits for focus — 1.7 P4b:
   * only when that attempt is wanted, by the rule `runPolls` would apply (`answeredBy`); a fresh
   * reading from somebody else holds nothing back.
   */
  private logHeld(now: number): void {
    for (const src of SOURCES) {
      const next = this.nextPollAt[src]
      if (this.heldLogged[src] || !(next > 0 && next <= now)) continue
      if (this.answeredBy(src, this.lastStates[src], now) !== null) continue
      this.heldLogged[src] = true
      this.log(`${src}: a due fetch waits for this window to be focused (tokenPace.pollOnlyWhenFocused)`)
    }
  }

  /**
   * 1.7 P4b: whether a fresh reading answers a scheduled fetch of `src`, and until when — somebody
   * else's reading younger than the interval (`best`, the state `current()` picked), else our own; null
   * when none does and a due fetch is wanted. The one condition `runPolls` skips a due fetch by, which
   * `enrich` and `logHeld` ask as well, so no view calls an attempt due or held that would not be made.
   */
  private answeredBy(src: Source, best: QuotaState | undefined, now: number): { by: 'foreign' | 'own'; until: number } | null {
    const interval = this.intervalMs()
    // A fresh reading from somebody else answers the same question for free.
    const foreign = best?.ok && best.origin !== 'poll' && best.origin !== 'push'
    if (foreign && this.ageMs(best, now) < interval) return { by: 'foreign', until: (best.fetchedAt as number) * 1000 + interval }
    const own = this.polled[src]
    if (own?.ok && this.ageMs(own, now) < interval) return { by: 'own', until: (own.fetchedAt ?? 0) * 1000 + interval }
    return null
  }

  private runPolls(now: number): void {
    for (const src of SOURCES) {
      if (this.inFlight[src]) continue
      const forced = this.forced.delete(src)
      if (!forced) {
        if (now < this.nextPollAt[src]) continue
        const answered = this.answeredBy(src, this.lastStates[src], now)
        if (answered !== null) {
          // Somebody else's reading is asked again in a minute — it may be gone by then; our own
          // reading is good until the interval has passed.
          this.nextPollAt[src] = answered.by === 'foreign' ? now + MINUTE_MS : answered.until
          continue
        }
      }
      void this.startPoll(src)
    }
  }

  /**
   * 1.7 W3 (§0a.1, spec §3.0 (i)): the version the Claude request's user agent carries — the CLI's
   * (`claude --version`, asked once per session), else the one the newest main session wrote into its
   * transcript (asked at every poll: the cold scan may finish after the first), else null, which
   * `userAgentFor` sends as `CLAUDE_VERSION_FALLBACK`. Nothing else of a transcript reaches a
   * request. The log names the source once, and again only when the version or its source changes —
   * never under `tokenPace.userAgent: honest`, which sends none of it.
   *
   * 1.7 Review 1: under `honest` the transcripts are not asked at all — §0a.1 allows their version
   * only for the `claude-code/<version>` header, and the honest one carries no Claude Code version.
   * The CLI's answer stays in the options as in 1.6; `userAgentFor` ignores it there.
   */
  private userAgentVersion(): string | null {
    if (this.opts.userAgent !== 'claudeCode') return this.claudeVersion
    let from: keyof typeof VERSION_FROM = 'cli'
    let version = this.claudeVersion
    if (version === null) {
      let seen: string | null = null
      try {
        seen = this.deps.transcriptVersion()
      } catch {
        // A version is a nicety of the header; its lookup failing must not fail the fetch.
        seen = null
      }
      version = typeof seen === 'string' && TRANSCRIPT_VERSION_RE.test(seen) ? seen : null
      from = version === null ? 'fallback' : 'transcript'
    }
    if (this.opts.userAgent === 'claudeCode') {
      const line = `claude: user agent version ${version ?? CLAUDE_VERSION_FALLBACK} (${VERSION_FROM[from]})`
      if (line !== this.versionLogged) {
        this.versionLogged = line
        this.log(line)
      }
    }
    return version
  }

  private ageMs(state: QuotaState | undefined, now: number): number {
    const at = state?.fetchedAt
    return typeof at === 'number' && Number.isFinite(at) ? now - at * 1000 : Infinity
  }

  private async startPoll(src: Source): Promise<void> {
    this.inFlight[src] = true
    // The attempt is no longer held: a later hold in the same absence is a new one (1.7 W2).
    this.heldLogged[src] = false
    try {
      if (src === 'claude' && !this.versionAsked) {
        this.versionAsked = true
        this.claudeVersion = await this.deps.detectClaudeVersion()
        // Disposed while the version was asked: the request is not sent any more.
        if (this.disposed) return
      }
      const opts: PollOptions = {
        claudeDir: this.opts.claudeDir,
        codexBinary: this.opts.codexBinary,
        keychain: this.opts.keychain,
        userAgent: this.opts.userAgent,
        extVersion: this.deps.extVersion,
        claudeVersion: src === 'claude' ? this.userAgentVersion() : this.claudeVersion,
        // 1.12 A2 rule 3: Codex is read over the standing connection when there is one.
        codexConnection: src === 'codex' ? this.codexConnection() : null,
      }
      const r = await this.deps.poll(src, this.failCount[src], opts)
      // 1.6 R3: disposed while the request was under way. The exit has written what there was,
      // and a window that leads next may already fetch for itself: this answer is not kept, not
      // written to `quota.json` or the shared cache file, not sampled into the history and not
      // reported — the one request it cost was already made.
      if (this.disposed) return
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
        this.log(r.via === 'connection' ? `${src}: quota fetched over the connection` : `${src}: quota fetched`)
      } else {
        // The poller's own words are what the display shows; only our fallback is translated,
        // and the log keeps the English so an issue report reads the same on every machine.
        this.problem[src] = { text: r.problem ?? t('Fetch failed'), kind: r.problemKind ?? 'unknown', at: now }
        this.failCount[src] += 1
        // No retry hint means a permanent cause (missing credentials, no binary) —
        // do not keep asking every minute in that case.
        const wait = r.retryAfterSeconds ?? this.intervalMs() / 1000
        this.nextPollAt[src] = now + wait * 1000
        this.persist()
        this.log(`${src}: ${r.problem ?? 'Fetch failed'} — next attempt in ${Math.round(wait / 60)} min`)
      }
    } catch (e) {
      if (this.disposed) return
      const now = this.deps.now()
      // Our own words, never the exception's: its message may carry anything, a header included.
      this.problem[src] = { text: t('Unexpected error while fetching'), kind: 'unknown', at: now }
      this.failCount[src] += 1
      this.nextPollAt[src] = now + this.intervalMs()
      // 1.7 W1: persisted like the other failure path, so a restart still says why the figure is old.
      this.persist()
      this.log(`${src}: ${(e as Error)?.name ?? 'error'} while fetching`)
    } finally {
      this.inFlight[src] = false
      // The result — a state, a problem or a moved backoff — changes the answer; after `dispose`
      // there is nobody left to tell.
      if (!this.disposed) {
        this.invalidate()
        this.onUpdate()
      }
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
    // No timer is armed after `dispose`: it would start a fetch for a window that is gone.
    if (this.disposed || this.blocked()) return
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
    // `dispose` cancels the timers; a scheduler that fires one anyway starts nothing.
    if (this.disposed) return
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

  /**
   * 1.12 A1: the standing connection — on the leader, in `poll` mode after consent (the caller, `tick`,
   * asks `blocked()` first), in `persistent` mode, when the binary is found. One child per editor: a
   * follower keeps none (`setLeader`). A connection already there is asked to start again — nothing
   * while it runs or waits for a restart, the start past the budget's hour after `budgetSpent` (A3 rule 2).
   */
  private ensureAppServer(): void {
    if (this.opts.appServerMode !== 'persistent') {
      this.stopAppServer()
      return
    }
    if (this.appServer) {
      this.appServer.start()
      return
    }
    const bin = this.deps.findCodexBinary(this.opts.codexBinary)
    if (!bin) return
    const srv = this.deps.createAppServer(bin, this.log)
    this.appServer = srv
    this.appServerSubs = [
      srv.onNotification((method, params) => {
        if (method !== 'account/rateLimits/updated') return
        this.applyPush(params)
      }),
      srv.onReady(() => this.firstReading()),
    ]
    srv.start()
    this.log('codex: app-server started as a standing connection')
  }

  /** The connection a Codex poll reads over, or null (1.12 A2 rule 3) — `usable()` decides the rest. */
  private codexConnection(): CodexConnection | null {
    return this.opts.appServerMode === 'persistent' ? this.appServer : null
  }

  /**
   * 1.12 A2 rule 2: on every `ready` — the first and after each restart — one read over the connection,
   * applied exactly as a poll's: pushes may have been missed while the child was down. Not while a
   * Codex poll is under way (it reads over this connection, or brings its own answer), not past a closed
   * gate, and not while the focus holds the polls (A2 rule 7 — a read is a poll).
   */
  private firstReading(): void {
    if (this.disposed || this.blocked() !== null || this.inFlight.codex) return
    if (this.focusSkips(this.deps.now())) return
    void this.startPoll('codex')
  }

  /** 1.12 A4 rule 1: the standing child ends whenever a gate is closed — mode, consent, follower. */
  private stopWhenBlocked(): void {
    if (this.appServer === null) return
    const why = this.blocked()
    if (why === null) return
    this.stopAppServer()
    this.log(`codex: app-server stopped (${why})`)
  }

  private stopAppServer(): void {
    for (const sub of this.appServerSubs) sub.dispose()
    this.appServerSubs = []
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
    // 1.7 W1 (§0a.3): the last failed attempt per source — its time, its kind and the poller's words,
    // nothing else; only what `restore` would read back, and no key at all without one.
    const now = this.deps.now()
    const failed: Partial<Record<Source, { at: number; kind: ProblemKind; text: string }>> = {}
    for (const src of SOURCES) {
      const f = failureOf(this.problem[src], now)
      if (f) failed[src] = { at: f.at, kind: f.kind, text: f.text }
    }
    try {
      fs.writeFileSync(this.files.stateFile, JSON.stringify({
        version: STATE_FILE_VERSION,
        polled: this.polled,
        nextPollAt: this.nextPollAt,
        ...(Object.keys(failed).length > 0 ? { failed } : {}),
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
      // 1.7 W1 (§0a.3): the last failed attempt, by shape only — anything else is dropped whole.
      const failed = failureOf(d?.failed?.[src], this.deps.now())
      if (failed) this.problem[src] = failed
    }
  }
}
