// SPDX-FileCopyrightText: 2026 Frederik Marx
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * 1.8 B2 (spec §3 B2, §0c): the guards of the opt-in keep-warm line — whether Token Pace may type
 * KEEP_WARM_LINE into the VS Code terminal that runs a Claude Code session and press Enter, so that
 * Claude Code itself sends a request that re-reads the session's one-hour prompt cache before it
 * expires. It is the one auto-action Token Pace has (§0c), and it is allowed only inside these
 * bounds; every one of them is a guard below, checked when the countdown starts (`arm`) and all of
 * them again, with fresh facts, when it ends (`send`).
 *
 * Frederik's threshold (§7a Q19): the line is due once the status-line bridge says the cache has
 * KEEPWARM_LEAD_MS (3 minutes) or less of warmth left; a visible KEEPWARM_COUNTDOWN_MS (60 s)
 * countdown with a one-click cancel comes first, so the line goes at about 2 minutes left, and never
 * later than KEEPWARM_SEND_MARGIN_MS before the stated expiry. The transcript's estimate never arms
 * it: a line is typed on a measured fact, not on a `~`.
 *
 * What the probe showed (§7c, P-1…P-6) and the guards rest on: Claude Code writes an assistant line
 * that calls a tool only when the tool has completed, so while a permission dialog or a question
 * stands open the transcript's newest message line is the user's (`LastRequest.replyPending`) — G4
 * blocks on it, not on the stop reason alone. A half-typed draft in Claude Code's input line is sent
 * together with the line (confirmed); no API reads a terminal's input, so no guard here can see it —
 * the countdown and its cancel are the only protection, and the consent says so.
 *
 * A terminal is linked to a folder, not to a session (1.8 P12, §7c): another Claude Code session of the
 * same project directory — in the Claude Code panel, in another window, or the one the terminal runs
 * instead — could take the line. G13 therefore asks which session the terminal runs: the one whose
 * first counted reply came after its `claude` started and that is the newest of the folder's; and it
 * keeps the line back while any other session of the folder is not idle by G4's and G5's tests —
 * unless that session has been left behind (1.9 D): no agent of it running, and its newest message
 * line — a prompt that never got its reply, an interrupted reply, a window closed mid-turn — written
 * before the terminal's `claude` started and at least KEEPWARM_SIBLING_LEFT_MS ago. A reply under way or
 * a dialog open lives in the process that wrote the session's newest line, and a line older than this
 * terminal's `claude` cannot be that process's; the two hours are the backstop for that inference
 * (Claude Code documents no such rule). In 1.8 such a session held the folder back for as long as its
 * transcript was kept, seven days; the bound only ever lets the line go where 1.8 kept it back.
 *
 * Pure: no clock, no I/O, no `vscode`. The facts come in as values — the host (keepWarmHost.ts,
 * 1.8 P10) gathers them from the watch, the aggregator's record, the running list, the agent hook,
 * the window's terminals and its own idle-phase bookkeeping —, and the decision is a function of
 * them and `now`. What the host may take of a terminal is what `claudeExecutionMatches` takes: a
 * shell execution's command line, its confidence and its working directory, tested and never kept
 * (§0a.6); never a terminal's name (Claude Code sets it to a summary of the conversation), its output
 * or its environment.
 */

import type { HookEntry } from './agentTree'
import type { CacheWatchEntry } from './cacheWatch'
import type { PromptCacheReading } from './quotaSources'
import type { MainRec, StopReason } from './types'

/**
 * The line Token Pace types (§0a.8) — Frederik's words (§7a Q8), a text for the model, never
 * translated: one line, ASCII, no line break inside it, not starting with `/`, `!`, `@`, `#` or `?`,
 * which Claude Code's input line would read as a command, a shell escape, a mention, a memory or a
 * help request (research consequence 6).
 */
export const KEEP_WARM_LINE = 'Ignore this message. No action. No response.'

/**
 * §7a Q19 (Frederik: „Ist er 3 Minuten oder weniger warm, dann wird er angestubst"): the line is due
 * — the countdown may start — once the bridge's `expires_at` is this close or closer. Replaces the
 * spec's 4-minute KEEPWARM_SEND_BEFORE_MS; the cooling warning (A) still starts at 5 minutes.
 */
export const KEEPWARM_LEAD_MS = 3 * 60_000
/** The visible countdown before every line, cancellable with one click (§0c). */
export const KEEPWARM_COUNTDOWN_MS = 60_000
/**
 * G3's 60 seconds: a line starts at least this long before the stated expiry — the request must be
 * on its way well before the entry goes —, and no later than this long after the countdown's
 * intended end. A window that slept past the moment sends nothing late.
 */
export const KEEPWARM_SEND_MARGIN_MS = 60_000
/** Collect #2: the session's newest counted reply at least this old (G4). */
export const KEEPWARM_IDLE_MIN_MS = 60_000
/** A line not answered by a counted request of its session within this time stops the idle phase (G11). */
export const KEEPWARM_VERIFY_MS = 120_000
/** Lines per idle phase of a session (G9; research consequence 10: "default a few hours"). */
export const KEEPWARM_MAX_PER_IDLE = 3
/** No line while a Claude quota window of the current reading stands at or above this share, or is reached (G10). */
export const KEEPWARM_QUOTA_STOP_PERCENT = 90
/**
 * 1.9 D (§7a Q12): a session of the folder whose newest message line is at least this old — and older
 * than the terminal's `claude` — is left behind, and no longer holds G13 (b) shut. Twice the one-hour
 * cache the line keeps warm.
 */
export const KEEPWARM_SIBLING_LEFT_MS = 2 * 3_600_000

/**
 * A shell execution that runs Claude Code: `claude`, a path ending in it, `claude.exe` — then a
 * space or the end. `claude-dev`, `npx claude`, `claude.cmd` do not match. Tested, never kept
 * (§0a.6). No `g` flag: `test` keeps no state between calls.
 */
export const CLAUDE_COMMAND_RE = /^\s*(?:\S*[\\/])?claude(?:\.exe)?(?:\s|$)/i
/** Of a command line only its start can name the program; the rest is never looked at. */
export const COMMAND_LINE_TESTED_CHARS = 1024
/**
 * VS Code's `TerminalShellExecutionCommandLineConfidence.Medium` (Low 0, Medium 1, High 2 in
 * `@types/vscode` 1.106.1): G7 takes a command line only at this confidence or above.
 */
export const COMMAND_CONFIDENCE_MEDIUM = 1

/** Why no line goes — one word per guard outcome, for the log and the card notes (P10). */
export type KeepWarmBlock =
  | 'off' | 'consent' | 'restricted' | 'noBridge' | 'notDue' | 'tooLate' | 'notIdle' | 'openTool' | 'agentRunning'
  | 'hookWait' | 'noTerminal' | 'ambiguousTerminal' | 'typedSince' | 'unknownFocus' | 'cap' | 'quota' | 'cancelled'
  | 'unanswered' | 'otherSession'

/** The guard of §3 B2's table each block belongs to — compiler-complete: a new block needs its guard. */
export const KEEPWARM_GUARD_OF: Readonly<Record<KeepWarmBlock, `G${number}`>> = Object.freeze({
  off: 'G1', consent: 'G1', restricted: 'G1',
  noBridge: 'G2',
  notDue: 'G3', tooLate: 'G3',
  notIdle: 'G4', openTool: 'G4',
  agentRunning: 'G5',
  hookWait: 'G6',
  noTerminal: 'G7', ambiguousTerminal: 'G7',
  typedSince: 'G8', unknownFocus: 'G8',
  cap: 'G9',
  quota: 'G10',
  unanswered: 'G11',
  cancelled: 'G12',
  otherSession: 'G13',
})

/**
 * G13 (1.8 P12): another main session of the watched session's project directory — what the aggregator
 * keeps of it already (`MainRec`, §0a.2, §0a.5) and whether an agent of it runs (the Agents tree). Times,
 * a stop reason and flags; never a text of the session.
 */
export interface KeepWarmSibling {
  /** `MainRec.firstTs`: the time of the session's first counted reply. */
  firstAt: number
  /** `MainRec.lastTs`: the time of its newest counted reply. */
  lastTs: number
  /** `MainRec.lastRequest.stop`, or null without a request of the cache on the record. */
  stop: StopReason | null
  /** `MainRec.lastRequest.replyPending`, or null without a request of the cache on the record. */
  replyPending: boolean | null
  /** An agent of the session is in the running list (as G5 asks it). */
  running: boolean
  /** 1.9 §0a.1: `MainRec.lastUserAt` — the time of the session's newest `user` line —, or null. */
  lastUserAt: number | null
}

export type KeepWarmStage = 'arm' | 'send'
export type KeepWarmVerdict = { go: true } | { go: false; block: KeepWarmBlock }

/**
 * Everything the guards look at, for one session at one moment — gathered by the host, fresh for
 * each stage. Nothing here is a text of the session: ids, times, counts and flags.
 */
export interface KeepWarmFacts {
  /** G1: `tokenPace.cacheKeepWarm`. */
  enabled: boolean
  /** G1: the consent record (`tokenPace.keepWarmConsent`). */
  consent: 'granted' | 'denied' | 'unasked'
  /** G1: the workspace is trusted — never in Restricted Mode. */
  trusted: boolean
  /** A's entry of the session (`watchCaches`). */
  entry: CacheWatchEntry
  /** G2, G3: the session's bridge reading — the one the entry rests on —, or null. */
  reading: PromptCacheReading | null
  /** G4, G6: the session's main record — `lastTs` and `lastRequest` (its `stop` and `replyPending`, §0a.5) —, or null. */
  main: MainRec | null
  /** G5: an agent of the session is in the running list. */
  running: boolean
  /** G6: the agent hook's newest session-level entry for the session, if the hook is installed and has one. */
  hook: HookEntry | null
  /**
   * G7, G8: `matching` — how many terminals of this window have an open shell execution for which
   * `claudeExecutionMatches` holds; `touchedSince` — whether that terminal was the active terminal of
   * the focused window since the session's newest counted reply (`unknown`: this window started later).
   */
  terminals: { matching: number; touchedSince: 'no' | 'yes' | 'unknown' }
  /** G9: lines typed for the session in this idle phase. */
  sentThisPhase: number
  /** G11: the previous line of this idle phase got no answer within KEEPWARM_VERIFY_MS. */
  lastUnanswered: boolean
  /** G12: the user cancelled a countdown in this idle phase. */
  cancelled: boolean
  /** G10: the highest window of the current Claude quota reading, or null without a reading (not blocked). */
  quotaMax: { percent: number; reached: boolean } | null
  /**
   * G13 (a): when the shell execution G7 found started — the time of its start event on the host's
   * clock (of several matching executions of that terminal, the newest) —, or null without one.
   */
  executionStartedAt: number | null
  /**
   * G13: every other main session of the project directory that holds the watched session's transcript
   * (every root's `projects/` alike) — each once per transcript, whatever its age.
   */
  siblings: readonly KeepWarmSibling[]
}

function finite(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v)
}

function block(b: KeepWarmBlock): KeepWarmVerdict {
  return { go: false, block: b }
}

/**
 * G13 (b): another session of the folder is idle by G4's test — its newest counted reply at least
 * KEEPWARM_IDLE_MIN_MS old, the newest message line not the user's, the reply ended its turn — and has
 * no agent running (G5). Strict like every fact here: anything else is not idle.
 */
function siblingIdle(s: KeepWarmSibling, now: number): boolean {
  return finite(s.lastTs) && s.lastTs <= now - KEEPWARM_IDLE_MIN_MS && s.replyPending === false && s.stop === 'end_turn' && s.running === false
}

/**
 * 1.9 D: the time of another session's newest message line, or null when it cannot be known. With the
 * user's line newest (`replyPending` true) it is that line's — `lastUserAt`, which must then be known —
 * or the newest counted reply's, whichever is later; otherwise the later of the newest counted reply and
 * the newest user line, if one is known. Strict: a flag or a time of another shape is unknown — the
 * reply time first of all (`Math.max(null, -Infinity)` would read as 0, the dawn of time).
 */
function siblingNewestAt(s: KeepWarmSibling): number | null {
  if (!finite(s.lastTs)) return null
  const user = s.lastUserAt
  if (user !== null && !finite(user)) return null
  if (s.replyPending === true) return user === null ? null : knownMax(user, s.lastTs)
  if (s.replyPending !== false && s.replyPending !== null) return null
  return knownMax(s.lastTs, user ?? -Infinity)
}

/** The later of two times, or null when that is not a finite time. */
function knownMax(a: number, b: number): number | null {
  const t = Math.max(a, b)
  return finite(t) ? t : null
}

/**
 * 1.9 D (§3 D rule 2): another session of the folder has been left behind — no agent of it running, and
 * its newest message line known, written before the terminal's `claude` started (`started`, finite: G13
 * (a) holds) and at least KEEPWARM_SIBLING_LEFT_MS before `now`. A reply under way or a dialog open lives
 * in the process that wrote that line, and this terminal's process began after it; the two hours are the
 * backstop for that inference.
 */
function siblingLeftBehind(s: KeepWarmSibling, started: number, now: number): boolean {
  if (s.running !== false) return false
  const newest = siblingNewestAt(s)
  return newest !== null && newest < started && newest <= now - KEEPWARM_SIBLING_LEFT_MS
}

/**
 * G2: the entry is the bridge's, and its reading is a measured one-hour cache that is warm and says
 * when it expires — never the transcript's estimate, never another session's reading. The expiry G3
 * reads is this reading's `expiresAt`, as Claude Code stated it.
 */
function measuredExpiry(f: KeepWarmFacts): number | null {
  const e = f.entry
  const r = f.reading
  if (!e || e.source !== 'bridge' || e.ttl !== '1h' || !r) return null
  if (typeof r.sessionId !== 'string' || r.sessionId !== e.sessionId) return null
  if (r.ttl !== '1h' || r.warm !== true || !finite(r.expiresAt)) return null
  return r.expiresAt
}

/**
 * G3's send window: a line started at `t` goes while it is more than KEEPWARM_SEND_MARGIN_MS before
 * the expiry and not more than KEEPWARM_SEND_MARGIN_MS after the countdown's intended end — the
 * moment KEEPWARM_COUNTDOWN_MS after the line fell due. With Q19's numbers both bounds are the same
 * minute (2 min left + 60 s = 1 min left); they part only if the constants do.
 */
function sendWindowOpen(t: number, expiresAt: number): boolean {
  const intendedEnd = expiresAt - KEEPWARM_LEAD_MS + KEEPWARM_COUNTDOWN_MS
  return t < expiresAt - KEEPWARM_SEND_MARGIN_MS && t <= intendedEnd + KEEPWARM_SEND_MARGIN_MS
}

/**
 * The keep-warm decision (§3 B2 "The guards", §7a Q19, §7c): `go` when every guard holds, else the
 * first guard that fails, in the table's order. `arm` asks whether the countdown may start now, `send`
 * whether the line may go now that it ended; both run every guard, each with the facts of its moment.
 *
 *  G1  the setting on, consent granted, the workspace trusted            off · consent · restricted
 *  G2  the bridge's measured 1 h reading of this session, warm, with an expiry — never an estimate
 *                                                                          noBridge
 *  G3  due: KEEPWARM_LEAD_MS or less left; arm: the countdown can end inside the send window; send:
 *      inside it (more than KEEPWARM_SEND_MARGIN_MS before the expiry)  notDue · tooLate
 *  G4  the newest counted reply at least KEEPWARM_IDLE_MIN_MS old, the newest message line not the
 *      user's (a prompt or a tool result — probe P-6: a dialog open), the reply ended its turn
 *                                                                          notIdle · openTool
 *  G5  no agent of the session running                                    agentRunning
 *  G6  no permission wait of the agent hook newer than that reply (an `input` wait passes: G4 holds)
 *                                                                          hookWait
 *  G7  exactly one terminal of this window runs the session             noTerminal · ambiguousTerminal
 *  G8  that terminal was not the focused window's active one since the reply, and that is known
 *                                                                          typedSince · unknownFocus
 *  G9  fewer than KEEPWARM_MAX_PER_IDLE lines in this idle phase        cap
 *  G10 no Claude window at KEEPWARM_QUOTA_STOP_PERCENT or reached (no reading: not blocked)
 *                                                                          quota
 *  G11 the previous line of this idle phase was answered                 unanswered
 *  G12 no cancel in this idle phase                                      cancelled
 *  G13 the terminal runs this session, not another of its folder: the session's first reply came
 *      after the terminal's `claude` started, no other session of the folder started later, and every
 *      other session of the folder is idle (G4's test) with no agent running (G5's) — or left behind
 *      (1.9 D): no agent running, its newest message line older than the terminal's `claude` and at
 *      least KEEPWARM_SIBLING_LEFT_MS old                                  otherSession
 *
 * Every fact is taken strictly — a flag that is not exactly the passing value blocks —, because a
 * wrong fact may only ever keep the line back, never send it.
 */
export function keepWarmDecision(f: KeepWarmFacts, now: number, stage: KeepWarmStage): KeepWarmVerdict {
  // G1 · §0c: off by default, its own consent, never in Restricted Mode.
  if (f.enabled !== true) return block('off')
  if (f.consent !== 'granted') return block('consent')
  if (f.trusted !== true) return block('restricted')

  // G2 · a line is typed on a fact, not on a `~`.
  const expiresAt = measuredExpiry(f)
  if (expiresAt === null) return block('noBridge')

  // G3 · §7a Q19: due at 3 minutes or less of warmth — at the send stage too: an expiry that moved
  // out during the countdown (the session sent a request) needs no line.
  if (!finite(now) || !(expiresAt - now <= KEEPWARM_LEAD_MS)) return block('notDue')
  if (!sendWindowOpen(stage === 'arm' ? now + KEEPWARM_COUNTDOWN_MS : now, expiresAt)) return block('tooLate')

  // G4 · idle: the newest counted reply old enough, nothing of a reply pending, the turn ended.
  const main = f.main
  const last = main?.lastRequest ?? null
  if (!main || !last || !finite(main.lastTs) || !(main.lastTs <= now - KEEPWARM_IDLE_MIN_MS)) return block('notIdle')
  // Probe P-6: while a question or a permission dialog stands open, nothing of the reply is on disk
  // and the newest message line is the user's — the previous reply's `end_turn` says nothing then.
  if (last.replyPending !== false) return block('openTool')
  // A reply that called a tool: a tool, a permission dialog or a question may be open — Enter may
  // confirm the highlighted option. Any other stop than `end_turn` (a cut-off reply, a paused turn,
  // none kept) is no idle turn either.
  if (last.stop !== 'end_turn') return block(last.stop === 'tool_use' ? 'openTool' : 'notIdle')

  // G5 · a subagent's end can wake the conversation at any moment.
  if (f.running !== false) return block('agentRunning')

  // G6 · the agent hook, when installed: a permission request after the newest reply is a dialog
  // that may be open. A wait for input passes — after an `end_turn` reply the one documented
  // `input` notification is the idle prompt; the others come during a tool call, which G4 excludes.
  const hook = f.hook
  if (hook && hook.wait === 'permission' && !(finite(hook.ts) && hook.ts <= main.lastTs)) return block('hookWait')

  // G7 · the extension's own panel is out of reach, a terminal without shell integration says
  // nothing, and two candidates are one too many.
  const matching = f.terminals?.matching
  if (!(Number.isInteger(matching) && matching >= 1)) return block('noTerminal')
  if (matching > 1) return block('ambiguousTerminal')

  // G8 · keys reach Claude Code's input line only through a focused terminal; one that was active in
  // a focused window since the reply may hold a draft, and a window that started later cannot know.
  const touched = f.terminals.touchedSince
  if (touched === 'yes') return block('typedSince')
  if (touched !== 'no') return block('unknownFocus')

  // G9 · a few lines per idle phase, then the cache goes as it would have.
  if (!(Number.isInteger(f.sentThisPhase) && f.sentThisPhase >= 0 && f.sentThisPhase < KEEPWARM_MAX_PER_IDLE)) return block('cap')

  // G10 · "plus a stop at the 5-hour or weekly limit": never into a window that is (nearly) used up.
  const q = f.quotaMax
  if (q !== null && q !== undefined && (q.reached !== false || !(q.percent < KEEPWARM_QUOTA_STOP_PERCENT))) return block('quota')

  // G11 · something other than Claude Code's input line got the previous line: stop.
  if (f.lastUnanswered !== false) return block('unanswered')

  // G12 · the one-click cancel holds for the rest of the idle phase.
  if (f.cancelled !== false) return block('cancelled')

  // G13 · G7 links the terminal to a folder, not to a session: another Claude Code session of the same
  // folder — in the panel, in another window, or the one this terminal runs instead — could take the
  // line, and none of that session's dialogs is checked above.
  // (a) Identity: the terminal's own session is the newest one started after its `claude` started —
  // the session's first counted reply came after the execution's start, and no other session of the
  // folder started later (or at the same moment: then none is the newest). `claude --resume` of an
  // older session therefore blocks — the safe side.
  const siblings = Array.isArray(f.siblings) ? f.siblings : null
  if (siblings === null) return block('otherSession')
  const started = f.executionStartedAt
  if (!finite(started) || !finite(main.firstTs) || !(main.firstTs > started)) return block('otherSession')
  for (const s of siblings) if (!s || !finite(s.firstAt) || !(s.firstAt < main.firstTs)) return block('otherSession')
  // (b) Defence in depth where (a) is fooled — a terminal whose `claude` started before the session and
  // that runs an older one of the folder, resumed or begun before it: every other session of the folder
  // idle by G4's test, no agent of it running, so a line that reaches the wrong session never lands in
  // a reply under way or an open dialog. 1.9 D: or left behind — its newest line written before this
  // terminal's `claude` started, so by another process than the one the line goes into, and two hours
  // old — which only ever passes a session 1.8 kept the line back for.
  for (const s of siblings) if (!s || !(siblingIdle(s, now) || siblingLeftBehind(s, started, now))) return block('otherSession')

  return { go: true }
}

/**
 * Claude Code's project-directory name for a working directory — the name of the directory under
 * `projects/` that holds the session's transcript: every character of the absolute path outside
 * `[A-Za-z0-9-]` becomes `-` (`/home/u/my_proj` → `-home-u-my-proj`, `C:\Users\u\proj` →
 * `C--Users-u-proj`). **An inference** from the names on the build machine; Claude Code documents no
 * such rule. A wrong rule can only keep G7 shut, never point it at another session: the name is
 * compared, never used to find anything. A trailing separator (not a root's) is dropped first — a
 * process's working directory has none. Characters are UTF-16 code units, as JavaScript's `replace`
 * sees them.
 */
export function projectDirName(cwd: string): string {
  if (typeof cwd !== 'string') return ''
  let p = cwd
  while (p.length > 1 && (p.endsWith('/') || p.endsWith('\\')) && !/^[A-Za-z]:[\\/]$/.test(p)) p = p.slice(0, -1)
  return p.replace(/[^A-Za-z0-9-]/g, '-')
}

/**
 * Two project-directory names of one directory. Equal — or, for a Windows path (a drive letter and
 * `--`, which no POSIX path gives: those start with `-`), equal but for the drive letter's case: VS
 * Code's `Uri.fsPath` lower-cases it, a process's working directory need not.
 */
function sameProjectDir(a: string, b: string): boolean {
  if (a === b) return true
  const drive = /^[A-Za-z]--/
  return drive.test(a) && drive.test(b) && a.slice(1) === b.slice(1) && a[0].toLowerCase() === b[0].toLowerCase()
}

/** Of a shell execution, what G7 tests — and all it may take of it (§0a.6). */
export interface ShellExecutionFacts {
  /** `execution.commandLine.value`. */
  commandLine: string
  /** `execution.commandLine.confidence` — VS Code's enum value (Low 0, Medium 1, High 2). */
  confidence: number
  /** `execution.cwd?.fsPath`, or null when the shell did not report one. */
  cwd: string | null
}

/**
 * G7 for one open shell execution: it runs Claude Code (`CLAUDE_COMMAND_RE` on the command line's
 * start, reported with Medium or High confidence) in the working directory whose project-directory
 * name is `projectDir` — the name of the directory that holds the session's transcript. A boolean,
 * and nothing of the execution outlives the call.
 */
export function claudeExecutionMatches(e: ShellExecutionFacts, projectDir: string): boolean {
  if (!e || typeof e.commandLine !== 'string') return false
  if (!CLAUDE_COMMAND_RE.test(e.commandLine.slice(0, COMMAND_LINE_TESTED_CHARS))) return false
  if (!(finite(e.confidence) && e.confidence >= COMMAND_CONFIDENCE_MEDIUM)) return false
  if (typeof e.cwd !== 'string' || e.cwd === '' || typeof projectDir !== 'string' || projectDir === '') return false
  return sameProjectDir(projectDirName(e.cwd), projectDir)
}
