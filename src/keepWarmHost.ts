// SPDX-FileCopyrightText: 2026 Frederik Marx
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * 1.8 B2 part 2 (spec §3 B2, §0a.6–§0a.8, §0c; §7a Q19; §7c): the vscode side of the opt-in keep-warm
 * line — the one auto-action Token Pace has. keepWarm.ts decides; this file gathers the facts it decides
 * on, shows the countdown, types the line, and counts what came of it.
 *
 *  • Terminals (§0a.6). Which terminal of this window runs Claude Code is learnt from VS Code's shell
 *    integration only, through the window's one TerminalWatch (terminalWatch.ts — since 1.10 the watch
 *    this host held itself, shared with the prompt tool): `onDidStartTerminalShellExecution` /
 *    `onDidEndTerminalShellExecution` hold the executions that are open, and at the moment G7 asks, each
 *    one's command line, its confidence and its working directory are tested (`claudeExecutionMatches`)
 *    — read at the test, kept by no one, never logged, shown or exported. VS Code's own word for what
 *    runs in the terminal (`terminal.state.shell`, `claude` while Claude Code runs — probe P-1) confirms a
 *    match where VS Code reports one and blocks where it names another program; it never stands in for
 *    the event. A terminal's **name is never read** — Claude Code sets it to a summary of the
 *    conversation (§7c) —, nor its output, nor its environment. Of the start event the watch also notes
 *    when it came, on its own clock — the time G13 compares the session's first reply with (1.8 P12).
 *  • The session behind the terminal (G13, 1.8 P12). A terminal runs a folder's `claude`, not a named
 *    session: the other main records of the folder the session's transcript lies in go to the decision
 *    as its siblings — their first and newest reply, the newest reply's stop and whether the user's line
 *    is newest, the time of their newest user line (1.9 §0a.1, for the bound of 1.9 D), and whether an
 *    agent of theirs runs. None of their times is ever logged.
 *  • Focus (G8). When a terminal was the active terminal of the focused window, from
 *    `onDidChangeActiveTerminal` and `onDidChangeWindowState` with the watch's clock; a window that
 *    started watching after a session's newest reply cannot say, and says so (`unknown`).
 *  • The countdown (§0c). One status-bar item of its own, `tokenPace.keepWarm`, shown whatever
 *    `tokenPace.statusBar.show` lists — a line is never typed without it —: 60 seconds counting down,
 *    one click (`tokenPace.cancelKeepWarm`) cancels the line and keep-warm for the rest of the idle
 *    phase. No colour, no alarm. At zero every guard runs again on fresh facts.
 *  • The line (§0a.8): `terminal.sendText(KEEP_WARM_LINE, true)`, once per go, into the terminal the
 *    countdown was armed for — nothing is ever read back from the terminal.
 *  • Verification and accounting (G9, G11, §0a.7). A counted request of the session whose first line
 *    comes within KEEPWARM_VERIFY_MS answers the line: one request and its tokens join today in
 *    `keepwarm.json`. No answer: the card says so and no further line goes in the idle phase. A request
 *    that answers no line is the user's, and starts a new idle phase.
 *
 * 1.10: while the transcripts are read — the cold scan, the agent tables' replay — no countdown starts
 * and none ends with a line (G14, `KeepWarmFrame.settled`); a prompt the reader types into the terminal
 * a countdown is armed for ends that countdown without its line, and keep-warm for the rest of the
 * session's idle phase (`yieldTo`, A3 rule 8, Review 1a F2).
 *
 * Inert while it may not act: with the setting off, without consent or in Restricted Mode keep-warm
 * wants no terminal event (the watch listens only while another user — the prompt tool — wants it) and
 * nothing of a terminal is looked at for keep-warm. The tick is driven by the host's
 * one-second frame (`tick`), and every time comes in as a parameter or from the injected clock; with
 * the setting off and nothing left to finish (`atRest`), the host skips gathering the frame at all.
 */

import * as fs from 'fs'
import * as path from 'path'
import type * as vscode from 'vscode'
import { hookKey } from './agentTree'
import type { AgentTreeVm, HookEntry } from './agentTree'
import type { CacheWatchEntry } from './cacheWatch'
import { t } from './i18n'
import {
  KEEP_WARM_LINE, KEEPWARM_COUNTDOWN_MS, KEEPWARM_VERIFY_MS, KeepWarmBlock, KeepWarmFacts, KeepWarmSibling, keepWarmDecision,
  sameProjectDir,
} from './keepWarm'
import type { PromptCacheReading } from './quotaSources'
import { TerminalWatch, TerminalWindow } from './terminalWatch'
import { TimeConfig, clockStamp, dayOf } from './time'
import type { MainRec, QuotaState } from './types'
import type { KeepWarmVmInput } from './viewModel'

/** The countdown's status-bar item — its id, which VS Code remembers the visibility of. */
export const KEEPWARM_ITEM_ID = 'tokenPace.keepWarm'
/** The one-click cancel: the item's command, and the palette's. */
export const KEEPWARM_CANCEL_COMMAND = 'tokenPace.cancelKeepWarm'
/** §0a.7: the accounting file in the extension's storage. */
export const KEEPWARM_FILE_NAME = 'keepwarm.json'
/** §0a.7: the days the file keeps — today and the thirty before it. */
export const KEEPWARM_DAYS_KEPT = 31
/** How long the item says "keep-warm line sent" after the line went. */
export const KEEPWARM_SENT_SHOWN_MS = 10_000
/**
 * How much longer than KEEPWARM_VERIFY_MS a window waits for the answer to be counted before it calls a
 * line unanswered: the answer is judged by its first line's time, which the ingest (and, in a window that
 * follows another, the leader's snapshot) brings a few seconds later.
 */
export const KEEPWARM_VERIFY_GRACE_MS = 15_000
/** An answer's first line may be dated this much before the moment the line was typed (clock rounding). */
const ANSWER_SLACK_MS = 1_000
/** The item stands before every other Token Pace item (theirs count down from 1000). */
export const KEEPWARM_ITEM_PRIORITY = 1001

/**
 * The slice of `vscode.window` the host uses — the real one in the extension, a fake in the tests: the
 * watch's terminal members (1.10: TerminalWindow, moved) and the countdown's item.
 */
export interface KeepWarmWindow extends TerminalWindow {
  createStatusBarItem(id: string, alignment?: vscode.StatusBarAlignment, priority?: number): vscode.StatusBarItem
}

export interface KeepWarmLog {
  info(m: string): void
  debug(m: string): void
  warn(m: string): void
}

export interface KeepWarmHostOptions {
  window: KeepWarmWindow
  /** `<globalStorage>/keepwarm.json`. */
  file: string
  log: KeepWarmLog
  /** The host's clock, for the times of the terminal and focus events. */
  clock?: () => number
  /**
   * 1.10 A3 rule 1: the window's one terminal watch, shared with the prompt tool (the extension makes it).
   * Absent: the host makes its own on `window` and `clock`, and disposes it with itself (the tests).
   */
  watch?: TerminalWatch
}

/** Everything one frame knows — fresh each second, from the host's own readers. */
export interface KeepWarmFrame {
  now: number
  /** `tokenPace.cacheKeepWarm`. */
  enabled: boolean
  /** `tokenPace.keepWarmConsent`. */
  consent: 'granted' | 'denied' | 'unasked'
  /** `vscode.workspace.isTrusted`. */
  trusted: boolean
  /** G14 (1.10 B7): no cold scan and no agent replay under way — extension.ts `!(scanning || replayRun !== null)`. */
  settled: boolean
  /** Every watched session, most urgent first (`watchCaches`, uncapped). */
  entries: readonly CacheWatchEntry[]
  /** Every session's newest bridge reading (`QuotaManager.promptCacheReadings`). */
  readings: readonly PromptCacheReading[]
  /** The aggregator's main records by transcript (`Aggregator.mainEntries`). */
  mains: ReadonlyArray<readonly [file: string, rec: MainRec]>
  /** The newest Agents tree, or null before the first one (G5 then assumes an agent runs). */
  tree: AgentTreeVm | null
  /** The agent hook's entries by `hookKey`; empty while the hook is not installed. */
  hook: ReadonlyMap<string, HookEntry>
  /** The current quota readings (G10 takes the Claude one). */
  quotas: readonly QuotaState[]
  tcfg: TimeConfig
  /** `vscode.StatusBarAlignment` of the configured side. */
  alignment: vscode.StatusBarAlignment
}

/** One day of `keepwarm.json`. */
export interface KeepWarmDay {
  requests: number
  tokens: number
}

/** A session's idle phase, as this window has seen it. Memory only. */
interface Phase {
  /** `MainRec.requests` when last looked at — a counted request since moves the phase. */
  requests: number | null
  /** Lines typed in this phase (G9). */
  sent: number
  /** The user cancelled a countdown in this phase (G12). */
  cancelled: boolean
  /** The last line of this phase got no answer (G11). */
  unanswered: boolean
  /** The line waiting for its answer: when it went, and the record's figures then. */
  awaiting: { at: number; requests: number; billable: number } | null
}

interface Countdown {
  sessionId: string
  /** The session's name as the card writes it ("Session Tue 14:20 · 9d0eb37a"). */
  name: string
  terminal: vscode.Terminal
  endsAt: number
  expiresAt: number
}

function finite(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v)
}

/** A session id as the log names it: its first eight characters, as every view does. */
function shortId(sessionId: string): string {
  return sessionId.slice(0, 8)
}

/** The billable tokens of a record — fresh input, cache write and output, the page's "usage". */
function billableOf(rec: MainRec): number {
  const n = (v: unknown): number => (finite(v) && v > 0 ? v : 0)
  return n(rec.input) + n(rec.cacheWrite) + n(rec.output)
}

/** §0a.8: the one write into another program's input — the fixed line, and Enter. */
function typeLine(terminal: vscode.Terminal): void {
  terminal.sendText(KEEP_WARM_LINE, true)
}

/**
 * §0a.7: `keepwarm.json` as read — `{ v: 1, days: { "<YYYY-MM-DD>": { requests, tokens } } }` and nothing
 * else: a file with another key, another version, a day that is not a date, or a count that is not a
 * whole number of at least 0 is read as empty (null). At most KEEPWARM_DAYS_KEPT days are taken, the
 * newest.
 */
export function cleanKeepWarmFile(raw: unknown): Record<string, KeepWarmDay> | null {
  const plain = (x: unknown): x is Record<string, unknown> =>
    typeof x === 'object' && x !== null && !Array.isArray(x) && Object.getPrototypeOf(x) === Object.prototype
  if (!plain(raw)) return null
  const o = raw
  const keys = Object.keys(o).sort()
  if (keys.length !== 2 || keys[0] !== 'days' || keys[1] !== 'v' || o.v !== 1 || !plain(o.days)) return null
  const count = (x: unknown): x is number => typeof x === 'number' && Number.isSafeInteger(x) && x >= 0
  const out: Record<string, KeepWarmDay> = {}
  for (const [day, value] of Object.entries(o.days)) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !plain(value)) return null
    const d = value
    const fields = Object.keys(d).sort()
    if (fields.length !== 2 || fields[0] !== 'requests' || fields[1] !== 'tokens') return null
    if (!count(d.requests) || !count(d.tokens)) return null
    out[day] = { requests: d.requests, tokens: d.tokens }
  }
  return keepNewest(out)
}

/** The newest KEEPWARM_DAYS_KEPT days of a day map, in date order. */
function keepNewest(days: Record<string, KeepWarmDay>): Record<string, KeepWarmDay> {
  const kept = Object.keys(days).sort().slice(-KEEPWARM_DAYS_KEPT)
  const out: Record<string, KeepWarmDay> = {}
  for (const day of kept) out[day] = { requests: days[day].requests, tokens: days[day].tokens }
  return out
}

/**
 * G5: whether an agent of the session may be running. A session with a running member is always among
 * the tree's active roots (1.7 F2), so its root says; a session the tree lists nowhere is taken as
 * running while anything runs and the tree leaves sessions out. No tree yet: cannot tell — running.
 */
export function sessionRunning(tree: AgentTreeVm | null, sessionId: string): boolean {
  if (tree === null || typeof tree !== 'object' || !Array.isArray(tree.roots)) return true
  const root = tree.roots.find((r) => r && r.key === `s:${sessionId}`)
  if (root) return (root.tally?.running ?? 0) > 0
  return tree.omittedRoots > 0 && tree.running > 0
}

/**
 * G10: the highest window of the current Claude reading — its share, and whether a window is reached —,
 * or null without a reading (not blocked).
 */
export function claudeQuotaMax(quotas: readonly QuotaState[]): { percent: number; reached: boolean } | null {
  const q = quotas.find((x) => x && x.source === 'claude' && x.ok && Array.isArray(x.windows) && x.windows.length > 0)
  if (!q) return null
  let percent = -Infinity
  let reached = false
  for (const w of q.windows) {
    if (w.unlimited) continue
    if (w.limitReached) reached = true
    if (finite(w.percent)) percent = Math.max(percent, w.percent)
  }
  if (percent === -Infinity) return reached ? { percent: 100, reached } : null
  return { percent, reached: reached || percent >= 100 }
}

/** The name of the directory that holds a transcript — the folder G7 compares a terminal's with. */
function projectDirOf(file: string): string {
  return path.basename(path.dirname(file))
}

/**
 * G13's siblings (1.8 P12): every main record of another session whose transcript lies in the project
 * directory `projectDir` — under any root, whatever its age —, with what the decision tests of it. A
 * record without a request of the cache gives null for the two facts of that request: not idle. 1.9 D:
 * with the time of its newest user line (`MainRec.lastUserAt`), by which the decision tells a session
 * left behind from one that may still be at work.
 */
export function siblingsOf(sessionId: string, projectDir: string, mains: KeepWarmFrame['mains'], tree: AgentTreeVm | null): KeepWarmSibling[] {
  const out: KeepWarmSibling[] = []
  if (projectDir === '') return out
  for (const pair of mains) {
    const rec = pair?.[1]
    if (!rec || rec.sessionId === sessionId || typeof pair[0] !== 'string' || projectDirOf(pair[0]) !== projectDir) continue
    out.push(sessionFacts(rec, tree))
  }
  return out
}

/** What G13 — and the prompt tool's decision (1.10 A4) — takes of one main record: times, a stop reason, flags. */
function sessionFacts(rec: MainRec, tree: AgentTreeVm | null): KeepWarmSibling {
  const last = rec.lastRequest
  return {
    firstAt: rec.firstTs,
    lastTs: rec.lastTs,
    stop: last ? last.stop : null,
    replyPending: last ? last.replyPending : null,
    running: sessionRunning(tree, rec.sessionId),
    lastUserAt: rec.lastUserAt,
  }
}

/**
 * 1.10 A4 (§0a.5): every main session of a folder — `siblingsOf`'s body without the exclusion —, with its
 * id, for the prompt tool's decision. `projectDir` is the name a terminal's working directory gives
 * (`projectDirName`), compared with each transcript's folder as G7 compares them (`sameProjectDir`: a
 * Windows drive letter in either case). Every root's `projects/<folder>` alike; each once per transcript,
 * whatever its age. Times, a stop reason and flags — never a text of the session, and none of it logged.
 */
export function folderSessions(projectDir: string, mains: KeepWarmFrame['mains'], tree: AgentTreeVm | null): Array<KeepWarmSibling & { sessionId: string }> {
  const out: Array<KeepWarmSibling & { sessionId: string }> = []
  if (typeof projectDir !== 'string' || projectDir === '') return out
  for (const pair of mains) {
    const rec = pair?.[1]
    if (!rec || typeof rec.sessionId !== 'string' || typeof pair[0] !== 'string' || !sameProjectDir(projectDirOf(pair[0]), projectDir)) continue
    out.push({ sessionId: rec.sessionId, ...sessionFacts(rec, tree) })
  }
  return out
}

/** The newest main record of a session and its transcript, as the watch picks it (cacheWatch.ts `newerMain`). */
function mainOf(sessionId: string, mains: KeepWarmFrame['mains']): { rec: MainRec; file: string } | null {
  let best: { rec: MainRec; file: string } | null = null
  const at = (r: MainRec): number => (r.lastRequest && finite(r.lastRequest.at) ? r.lastRequest.at : finite(r.lastTs) ? r.lastTs : -Infinity)
  for (const pair of mains) {
    const rec = pair?.[1]
    if (!rec || rec.sessionId !== sessionId || typeof pair[0] !== 'string') continue
    if (best === null || at(rec) > at(best.rec)) best = { rec, file: pair[0] }
  }
  return best
}

/**
 * The keep-warm host of one window. `tick` once per frame; `cancel` for the command; `view` for the view
 * model; `dispose` with the extension.
 */
export class KeepWarmHost {
  private readonly window: KeepWarmWindow
  private readonly file: string
  private readonly log: KeepWarmLog
  private readonly clock: () => number
  /** The window's terminal watch (1.10 A3 rule 1) — the extension's, or this host's own. */
  private readonly watch: TerminalWatch
  /** Whether this host made the watch, and so disposes it. */
  private readonly ownWatch: boolean

  /** Whether keep-warm wants the terminal and focus events — only while it may act. */
  private tracking = false

  private phases = new Map<string, Phase>()
  private countdown: Countdown | null = null
  private sentUntil: number | null = null
  private item: vscode.StatusBarItem | null = null
  private itemAlignment: vscode.StatusBarAlignment | null = null
  /** Cooling bridge sessions no terminal of this window runs (G7) — the card's note. */
  private noTerminal = new Set<string>()
  /** The last block logged per session, so that a block is logged once, not every second. */
  private blockLogged = new Map<string, string>()
  /** `keepwarm.json` as last read: its stat and its days. */
  private fileCache: { mtimeMs: number; size: number; days: Record<string, KeepWarmDay> } | null = null

  constructor(opts: KeepWarmHostOptions) {
    this.window = opts.window
    this.file = opts.file
    this.log = opts.log
    this.clock = opts.clock ?? Date.now
    this.ownWatch = opts.watch === undefined
    this.watch = opts.watch ?? new TerminalWatch(this.window, this.clock)
  }

  /** Whether keep-warm wants the terminal events (for the tests: inert while it may not act). */
  isTracking(): boolean {
    return this.tracking
  }

  /**
   * Nothing for a frame to do while the setting is off: no terminal listened to, no countdown or "sent"
   * item on screen, no line waiting for its answer. The host then skips the frame (Review 3's early
   * return, 1.8 P12); a line typed before the switch-off keeps the frames coming until it is answered or
   * called unanswered.
   */
  atRest(): boolean {
    if (this.tracking || this.countdown !== null || this.sentUntil !== null || this.item !== null) return false
    for (const p of this.phases.values()) if (p.awaiting !== null) return false
    return true
  }

  /**
   * One frame: the answers to lines sent, then — while keep-warm may act — the countdown, or whether one
   * may start. True when something the dashboard shows changed (a countdown started or ended, a line
   * went, was answered or not), so the host rebuilds the page at once.
   */
  tick(f: KeepWarmFrame): boolean {
    let changed = this.verify(f)
    const want = f.enabled === true && f.consent === 'granted' && f.trusted === true
    if (!want) {
      // G1 at any moment: a countdown under way ends without its line — switched off, consent withdrawn,
      // the workspace no longer trusted.
      if (this.countdown !== null) {
        const block: KeepWarmBlock = f.enabled !== true ? 'off' : f.consent !== 'granted' ? 'consent' : 'restricted'
        this.log.info(`keep-warm: not sent (${block})`)
        this.countdown = null
        changed = true
      }
      if (this.noTerminal.size > 0) changed = true
      if (this.tracking) this.stopTracking()
      this.sentUntil = null
      this.hideItem()
      return changed
    }
    if (!this.tracking) this.startTracking(f.now)
    this.noteReach(f)
    if (this.countdown !== null) {
      if (f.now >= this.countdown.endsAt) changed = this.sendStage(f) || changed
      else this.showCountdown(f.now, f.alignment)
      return changed
    }
    if (this.sentUntil !== null) {
      if (f.now < this.sentUntil) {
        this.showSent(f.alignment)
        return changed
      }
      this.sentUntil = null
      this.hideItem()
    }
    return this.armStage(f) || changed
  }

  /** The command: cancels the countdown, and keep-warm for the rest of the session's idle phase (G12). */
  cancel(): boolean {
    const c = this.countdown
    if (c === null) {
      this.log.info('keep-warm: no countdown to cancel')
      return false
    }
    const phase = this.phaseOf(c.sessionId, null)
    phase.cancelled = true
    this.countdown = null
    this.hideItem()
    this.log.info(`keep-warm: cancelled for session ${shortId(c.sessionId)}; no further line in this idle phase`)
    return true
  }

  /**
   * What the view model shows of keep-warm: the countdown, the two notes — only while keep-warm may act
   * — and today's accounting, which is a record of the day whatever the setting says now.
   */
  view(now: number, tcfg: TimeConfig): KeepWarmVmInput {
    const unanswered: string[] = []
    if (this.tracking) for (const [id, p] of this.phases) if (p.unanswered) unanswered.push(id)
    const day = this.readDays()[dayOf(now, tcfg)] ?? null
    return {
      armed: this.countdown === null ? null : { sessionId: this.countdown.sessionId, endsAt: this.countdown.endsAt },
      noTerminal: this.tracking ? [...this.noTerminal] : [],
      unanswered,
      today: day !== null && day.requests > 0 ? { requests: day.requests, tokens: day.tokens } : null,
    }
  }

  /** *Clear Stored Data…* deleted the file: the next read finds it gone. */
  forgetFile(): void {
    this.fileCache = null
  }

  /**
   * 1.10 A3 rule 8 (§3.0 b): a prompt of the reader's is being typed into `terminal` — a countdown armed
   * for that very terminal ends without its line (a line on top of the prompt would be a second request
   * into a busy composer), its item goes, and the log says so; true when one did. A countdown for another
   * terminal is not touched. Review 1a F2 (the lead's decision, over rule 8's "not marked cancelled"): the
   * session's idle phase is cancelled as a click on the countdown cancels it (G12), so a prompt that writes
   * no line and makes no request — one that answered a dialog, one Claude Code dropped — is not followed by a
   * fresh countdown for the same session; the next counted request of the session starts a new idle phase
   * (`verify`), the prompt's own reply among them.
   */
  yieldTo(terminal: vscode.Terminal): boolean {
    const c = this.countdown
    if (c === null || c.terminal !== terminal) return false
    this.countdown = null
    this.phaseOf(c.sessionId, null).cancelled = true
    this.hideItem()
    this.log.info('keep-warm: not sent (a prompt was typed into its terminal)')
    return true
  }

  dispose(): void {
    this.stopTracking()
    this.countdown = null
    this.sentUntil = null
    if (this.item !== null) {
      this.item.dispose()
      this.item = null
    }
    if (this.ownWatch) this.watch.dispose()
  }

  // ------------------------------------------------------------------ tracking

  /** Keep-warm may act: the watch listens for it too (1.10: it may already listen for the prompt tool). */
  private startTracking(now: number): void {
    this.tracking = true
    this.watch.want('keepWarm', true, now)
  }

  /** Keep-warm may not act: the watch no longer listens for it, and keep-warm forgets what it held. */
  private stopTracking(): void {
    this.tracking = false
    this.watch.want('keepWarm', false, this.clock())
    this.countdown = null
    this.noTerminal.clear()
    this.blockLogged.clear()
  }

  /** G8 for one terminal since `lastTs` — the watch's (1.10, moved). */
  private touchedSince(terminal: vscode.Terminal, lastTs: number | undefined): 'no' | 'yes' | 'unknown' {
    return this.watch.touchedSince(terminal, lastTs)
  }

  /** G7 — the watch's (1.10, moved verbatim from here). */
  private claudeTerminals(projectDir: string): Array<{ terminal: vscode.Terminal; startedAt: number }> {
    return this.watch.claudeTerminals(projectDir)
  }

  // ------------------------------------------------------------------ the guards' facts

  private phaseOf(sessionId: string, rec: MainRec | null): Phase {
    let p = this.phases.get(sessionId)
    if (!p) {
      p = { requests: rec && finite(rec.requests) ? rec.requests : null, sent: 0, cancelled: false, unanswered: false, awaiting: null }
      this.phases.set(sessionId, p)
    }
    return p
  }

  /** Every fact of §3 B2's table for one entry, fresh, and the one terminal G7 found (or null). */
  private factsFor(e: CacheWatchEntry, f: KeepWarmFrame): { facts: KeepWarmFacts; terminal: vscode.Terminal | null; rec: MainRec | null } {
    let reading: PromptCacheReading | null = null
    for (const r of f.readings) {
      if (!r || r.sessionId !== e.sessionId) continue
      if (reading === null || (finite(r.readAt) && (!finite(reading.readAt) || r.readAt > reading.readAt))) reading = r
    }
    const main = mainOf(e.sessionId, f.mains)
    const rec = main?.rec ?? null
    // The name of the directory that holds the session's transcript — what the terminal's folder is
    // compared with (G7). A session no transcript here belongs to has none, and no terminal matches.
    const projectDir = main ? projectDirOf(main.file) : ''
    const found = this.claudeTerminals(projectDir)
    const only = found.length === 1 ? found[0] : null
    const terminal = only?.terminal ?? null
    const phase = this.phaseOf(e.sessionId, rec)
    const facts: KeepWarmFacts = {
      enabled: f.enabled,
      consent: f.consent,
      trusted: f.trusted,
      settled: f.settled,
      entry: e,
      reading,
      main: rec,
      running: sessionRunning(f.tree, e.sessionId),
      hook: f.hook.get(hookKey(e.sessionId, null)) ?? null,
      terminals: { matching: found.length, touchedSince: terminal ? this.touchedSince(terminal, rec?.lastTs) : 'no' },
      sentThisPhase: phase.sent,
      lastUnanswered: phase.unanswered,
      cancelled: phase.cancelled,
      quotaMax: claudeQuotaMax(f.quotas),
      executionStartedAt: only?.startedAt ?? null,
      siblings: siblingsOf(e.sessionId, projectDir, f.mains, f.tree),
    }
    return { facts, terminal, rec }
  }

  /** The card's note: every cooling bridge entry no terminal of this window runs (G7 finds none). */
  private noteReach(f: KeepWarmFrame): void {
    const next = new Set<string>()
    for (const e of f.entries) {
      if (e.source !== 'bridge' || e.phase !== 'cooling') continue
      const main = mainOf(e.sessionId, f.mains)
      const projectDir = main ? projectDirOf(main.file) : ''
      if (this.claudeTerminals(projectDir).length === 0) next.add(e.sessionId)
    }
    this.noTerminal = next
  }

  // ------------------------------------------------------------------ the stages

  /** Whether one of the cooling sessions may start a countdown now; the first that may, does. */
  private armStage(f: KeepWarmFrame): boolean {
    for (const e of f.entries) {
      if (e.phase !== 'cooling') continue
      const { facts, terminal } = this.factsFor(e, f)
      const v = keepWarmDecision(facts, f.now, 'arm')
      if (!v.go || terminal === null) {
        const block = v.go ? 'noTerminal' : v.block
        if (this.blockLogged.get(e.sessionId) !== block) {
          this.blockLogged.set(e.sessionId, block)
          this.log.debug(`keep-warm: session ${shortId(e.sessionId)} not armed (${block})`)
        }
        continue
      }
      this.blockLogged.delete(e.sessionId)
      const expiresAt = facts.reading?.expiresAt ?? e.expiresAt
      this.countdown = { sessionId: e.sessionId, name: e.name, terminal, endsAt: f.now + KEEPWARM_COUNTDOWN_MS, expiresAt }
      this.log.info(`keep-warm: countdown started for session ${shortId(e.sessionId)}; the cache expires at ${clockStamp(expiresAt, f.now, f.tcfg)}`)
      this.showCountdown(f.now, f.alignment)
      return true
    }
    return false
  }

  /** The countdown ended: every guard again, on the facts of this moment; the line, or nothing. */
  private sendStage(f: KeepWarmFrame): boolean {
    const c = this.countdown as Countdown
    this.countdown = null
    const e = f.entries.find((x) => x.sessionId === c.sessionId) ?? null
    let block: KeepWarmBlock | null = null
    let terminal: vscode.Terminal | null = null
    let rec: MainRec | null = null
    if (e === null) {
      // The session is watched no longer: nothing measured describes its cache now.
      block = 'noBridge'
    } else {
      const got = this.factsFor(e, f)
      terminal = got.terminal
      rec = got.rec
      const v = keepWarmDecision(got.facts, f.now, 'send')
      if (!v.go) block = v.block
      // The terminal the countdown was armed for, and no other: one that took its place since is not it.
      else if (terminal !== c.terminal) block = 'noTerminal'
    }
    if (block !== null || terminal === null || rec === null) {
      this.log.info(`keep-warm: not sent (${block ?? 'noTerminal'})`)
      this.hideItem()
      return true
    }
    try {
      typeLine(terminal)
    } catch (err) {
      this.log.warn(`keep-warm: not sent (the terminal did not take the line: ${(err as { name?: string })?.name ?? 'error'})`)
      this.hideItem()
      return true
    }
    const phase = this.phaseOf(c.sessionId, rec)
    phase.sent += 1
    phase.awaiting = { at: f.now, requests: finite(rec.requests) ? rec.requests : 0, billable: billableOf(rec) }
    if (phase.requests === null && finite(rec.requests)) phase.requests = rec.requests
    this.log.info(`keep-warm: line sent to the terminal of session ${shortId(c.sessionId)}; the cache expires at ${clockStamp(c.expiresAt, f.now, f.tcfg)}`)
    this.sentUntil = f.now + KEEPWARM_SENT_SHOWN_MS
    this.showSent(f.alignment)
    return true
  }

  /**
   * The answers (G9, G11): a counted request of a session whose first line came within KEEPWARM_VERIFY_MS
   * of its line answers it — today's accounting grows by one request and its tokens once the reply has
   * ended (or the wait has run out); a request that answers no line is the user's and starts a new idle
   * phase; a line without an answer by then stops keep-warm for the rest of the phase. Runs whatever the
   * setting says: a line typed before it was switched off is still answered, and still counted.
   */
  private verify(f: KeepWarmFrame): boolean {
    let changed = false
    const watched = new Set(f.entries.map((e) => e.sessionId))
    for (const [id, p] of [...this.phases]) {
      const rec = mainOf(id, f.mains)?.rec ?? null
      if (rec !== null && finite(rec.requests)) {
        if (p.requests === null) p.requests = rec.requests
        else if (rec.requests > p.requests) {
          const a = p.awaiting
          const first = rec.lastRequest && finite(rec.lastRequest.at) ? rec.lastRequest.at : null
          const answers = a !== null && first !== null && first >= a.at - ANSWER_SLACK_MS && first <= a.at + KEEPWARM_VERIFY_MS
          if (answers) {
            // Its tokens once the reply has ended — a reply's later lines add to its output.
            const ended = rec.lastRequest?.stop !== null && rec.lastRequest?.stop !== undefined
            if (!ended && f.now <= a.at + KEEPWARM_VERIFY_MS + KEEPWARM_VERIFY_GRACE_MS) continue
            this.account(f, Math.max(0, billableOf(rec) - a.billable))
            this.log.info(`keep-warm: the line to session ${shortId(id)} was answered`)
            p.awaiting = null
          } else {
            if (p.sent > 0 || p.cancelled || p.unanswered) this.log.debug(`keep-warm: a request of session ${shortId(id)} starts a new idle phase`)
            p.sent = 0
            p.cancelled = false
            p.unanswered = false
            p.awaiting = null
          }
          p.requests = rec.requests
          changed = true
        }
      }
      if (p.awaiting !== null && f.now > p.awaiting.at + KEEPWARM_VERIFY_MS + KEEPWARM_VERIFY_GRACE_MS) {
        p.awaiting = null
        p.unanswered = true
        this.log.info(`keep-warm: the line to session ${shortId(id)} got no answer within ${KEEPWARM_VERIFY_MS / 60_000} minutes; no further line in this idle phase`)
        changed = true
      }
      // A session that is watched no longer, and waits for nothing, starts afresh when it is again.
      if (!watched.has(id) && p.awaiting === null && !(this.countdown?.sessionId === id)) this.phases.delete(id)
    }
    return changed
  }

  // ------------------------------------------------------------------ keepwarm.json

  /** The file's days, read again whenever its size or time changed; empty when absent or not its shape. */
  private readDays(): Record<string, KeepWarmDay> {
    let st: fs.Stats
    try {
      st = fs.statSync(this.file)
    } catch {
      this.fileCache = null
      return {}
    }
    const c = this.fileCache
    if (c !== null && c.mtimeMs === st.mtimeMs && c.size === st.size) return c.days
    let days: Record<string, KeepWarmDay> = {}
    try {
      days = cleanKeepWarmFile(JSON.parse(fs.readFileSync(this.file, 'utf8'))) ?? {}
    } catch {
      days = {}
    }
    this.fileCache = { mtimeMs: st.mtimeMs, size: st.size, days }
    return days
  }

  /** One answered line and its tokens onto today — the file written whole, atomically, 31 days at most. */
  private account(f: KeepWarmFrame, tokens: number): void {
    const today = dayOf(f.now, f.tcfg)
    this.fileCache = null
    const days = { ...this.readDays() }
    const had = days[today] ?? { requests: 0, tokens: 0 }
    days[today] = { requests: had.requests + 1, tokens: had.tokens + Math.round(tokens) }
    const oldest = dayOf(f.now - (KEEPWARM_DAYS_KEPT - 1) * 86_400_000, f.tcfg)
    for (const day of Object.keys(days)) if (day < oldest) delete days[day]
    const text = JSON.stringify({ v: 1, days: keepNewest(days) })
    const tmp = `${this.file}.tmp-${process.pid}`
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true })
      fs.writeFileSync(tmp, text)
      fs.renameSync(tmp, this.file)
    } catch (err) {
      try { fs.rmSync(tmp, { force: true }) } catch { /* nothing left to tidy */ }
      this.log.warn(`keep-warm: ${KEEPWARM_FILE_NAME} could not be written (${(err as NodeJS.ErrnoException)?.code ?? 'error'})`)
    }
    this.fileCache = null
  }

  // ------------------------------------------------------------------ the item

  private itemFor(alignment: vscode.StatusBarAlignment): vscode.StatusBarItem {
    // Alignment and priority are fixed when an item is made: another side needs another item.
    if (this.item !== null && this.itemAlignment !== alignment) {
      this.item.dispose()
      this.item = null
    }
    if (this.item === null) {
      this.item = this.window.createStatusBarItem(KEEPWARM_ITEM_ID, alignment, KEEPWARM_ITEM_PRIORITY)
      this.itemAlignment = alignment
    }
    return this.item
  }

  /** "$(watch) keep warm in 42 s · cancel" — every second, no colour, no alarm, a click cancels. */
  private showCountdown(now: number, alignment: vscode.StatusBarAlignment): void {
    const c = this.countdown
    if (c === null) return
    const secs = Math.max(0, Math.ceil((c.endsAt - now) / 1000))
    const item = this.itemFor(alignment)
    item.name = t('Token Pace — keep-warm countdown')
    item.text = `$(watch) ${t('keep warm in {0} s · cancel', secs)}`
    item.tooltip = t('Token Pace will type “{0}” into the terminal that runs {1} and press Enter, so that its prompt cache stays warm. Click to cancel.',
      KEEP_WARM_LINE, c.name)
    // 1.10 D8: the verb a person uses for a control — "press", never "activate".
    item.accessibilityInformation = { label: t('Keep-warm line for {0} in {1} seconds, press to cancel', c.name, secs) }
    item.command = KEEPWARM_CANCEL_COMMAND
    item.color = undefined
    item.backgroundColor = undefined
    item.show()
  }

  /** "$(watch) keep-warm line sent", for KEEPWARM_SENT_SHOWN_MS: nothing left to cancel. */
  private showSent(alignment: vscode.StatusBarAlignment): void {
    const item = this.itemFor(alignment)
    item.name = t('Token Pace — keep-warm countdown')
    item.text = `$(watch) ${t('keep-warm line sent')}`
    item.tooltip = undefined
    item.accessibilityInformation = undefined
    item.command = undefined
    item.color = undefined
    item.backgroundColor = undefined
    item.show()
  }

  private hideItem(): void {
    if (this.item !== null) {
      this.item.dispose()
      this.item = null
      this.itemAlignment = null
    }
  }
}
