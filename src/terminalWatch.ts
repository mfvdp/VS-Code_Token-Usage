// SPDX-FileCopyrightText: 2026 Frederik Marx
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * 1.10 A3 rules 1–2 (spec §0a.3, §2.2): the one watch of this window's terminals — what the keep-warm host
 * of 1.8 held itself, moved here so that the keep-warm line (1.8 B2) and the prompt tool (1.10 A) read the
 * same facts and neither copies the other's.
 *
 *  • What it listens to. VS Code's shell integration and the window: `onDidStartTerminalShellExecution` /
 *    `onDidEndTerminalShellExecution` (the executions that are open in each terminal, each with when its
 *    start event came on this watch's clock), `onDidCloseTerminal`, `onDidChangeActiveTerminal` and
 *    `onDidChangeWindowState` (when a terminal stopped being the focused window's active one — G8). It
 *    subscribes while at least one user wants it (`want`): keep-warm while it may act (the setting on,
 *    consent granted, the workspace trusted — 1.8's inertness), the prompt tool while its section is
 *    listed and the workspace is trusted. With no user it listens to nothing and holds nothing.
 *  • What it reads (§0a.6 of 1.8, §0a.3 of 1.10). Of an open execution its command line — the text and
 *    VS Code's confidence in it — and the working directory the shell reported (`executionFacts`); of a
 *    terminal VS Code's word for what runs in it (`state.shell`: `claude` while Claude Code runs — probe
 *    P-1 —, `codex` for Codex by VS Code's own table); and, for a terminal whose shell is `claude` or
 *    `codex` but whose program started before the watch listened (a window reload), the folder VS Code's
 *    shell integration reports for it (`reportedCwd`) — read when a check runs, compared, and kept by no
 *    one: never logged, shown, stored or exported. A terminal's **name is never read** — Claude Code sets
 *    it to a summary of the conversation —, nor its output, its environment, its creation options or its
 *    process.
 *  • What it answers. G7 for keep-warm (`claudeTerminals`, as 1.8 P10 computed it), G8 (`touchedSince`),
 *    and for the prompt tool every terminal of the window that runs Claude Code or Codex
 *    (`agentTerminals`), named by its place in `window.terminals`, never by its name.
 */

import type * as vscode from 'vscode'
import {
  CLAUDE_COMMAND_RE, COMMAND_CONFIDENCE_MEDIUM, COMMAND_LINE_TESTED_CHARS, ShellExecutionFacts, claudeExecutionMatches,
  projectDirName,
} from './keepWarm'

/** The two programs the prompt tool types into (1.10 A). */
export type AgentKind = 'claude' | 'codex'

/**
 * §0a.3: a shell execution that runs Codex — `codex`, a path ending in it, `codex.exe` — then a space or
 * the end. `codex-mini`, `npx codex`, `codex.cmd` do not match. Tested, never kept. No `g` flag: `test`
 * keeps no state between calls.
 */
export const CODEX_COMMAND_RE = /^\s*(?:\S*[\\/])?codex(?:\.exe)?(?:\s|$)/i

/** At most this many open executions are held per terminal — a shell that never reports an end cannot grow it. */
const EXECUTIONS_PER_TERMINAL_MAX = 8
/** The shell VS Code reports for a terminal while Claude Code runs in it (probe P-1). */
const CLAUDE_SHELL = 'claude'

function finite(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v)
}

/**
 * Which program an open execution runs: `claude` by CLAUDE_COMMAND_RE, `codex` by CODEX_COMMAND_RE, on
 * the command line's start, reported with Medium or High confidence — else null. Nothing of the
 * execution outlives the call.
 */
export function agentExecutionKind(e: ShellExecutionFacts): AgentKind | null {
  if (!e || typeof e.commandLine !== 'string') return null
  if (!(finite(e.confidence) && e.confidence >= COMMAND_CONFIDENCE_MEDIUM)) return null
  const start = e.commandLine.slice(0, COMMAND_LINE_TESTED_CHARS)
  if (CLAUDE_COMMAND_RE.test(start)) return 'claude'
  if (CODEX_COMMAND_RE.test(start)) return 'codex'
  return null
}

/**
 * 1.8 §0a.6: of an open shell execution, what the checks test — its command line with the confidence VS
 * Code gives it, and the working directory the shell reported. Read at the test and handed on; this is
 * the only place an execution is read.
 */
function executionFacts(execution: vscode.TerminalShellExecution): ShellExecutionFacts {
  const line = execution.commandLine
  const dir = execution.cwd
  return {
    commandLine: typeof line?.value === 'string' ? line.value : '',
    confidence: typeof line?.confidence === 'number' ? line.confidence : -1,
    cwd: typeof dir?.fsPath === 'string' ? dir.fsPath : null,
  }
}

/**
 * 1.8 §7c (probe P-1): VS Code's word for what runs in a terminal — `claude` while Claude Code runs,
 * `codex` while Codex does —, or undefined where it has none. Its name, which Claude Code sets to a
 * summary of the conversation, is never read.
 */
function shellOf(terminal: vscode.Terminal): string | undefined {
  const s = terminal.state as { shell?: unknown } | undefined
  return typeof s?.shell === 'string' ? s.shell : undefined
}

/**
 * 1.10 §0a.3: the working directory VS Code's shell integration reports for a terminal, or null. Read only
 * for a terminal whose shell is `claude` or `codex` and in which the watch saw no open execution of it —
 * a program started before the watch listened —, only to compute its project-directory name and compare
 * it; never kept past that. That the shell's folder is the one the program started in is an inference: a
 * shell cannot change its folder while a program runs in its foreground.
 */
function reportedCwd(terminal: vscode.Terminal): string | null {
  const si = terminal.shellIntegration
  const dir = si?.cwd
  return typeof dir?.fsPath === 'string' && dir.fsPath !== '' ? dir.fsPath : null
}

/** The slice of `vscode.window` the watch uses — the real one in the extension, a fake in the tests. */
export interface TerminalWindow {
  readonly terminals: readonly vscode.Terminal[]
  readonly activeTerminal: vscode.Terminal | undefined
  readonly state: vscode.WindowState
  onDidStartTerminalShellExecution: vscode.Event<vscode.TerminalShellExecutionStartEvent>
  onDidEndTerminalShellExecution: vscode.Event<vscode.TerminalShellExecutionEndEvent>
  onDidChangeActiveTerminal: vscode.Event<vscode.Terminal | undefined>
  onDidChangeWindowState: vscode.Event<vscode.WindowState>
  onDidCloseTerminal: vscode.Event<vscode.Terminal>
}

/** §3 A3 rule 2: a terminal of this window that runs Claude Code or Codex. */
export interface AgentTerminal {
  terminal: vscode.Terminal
  kind: AgentKind
  /** 1-based index in `window.terminals` — the only way the page and the Quick Pick name it (never its name). */
  index: number
  /** When the matching execution's start event came (the newest of that terminal's), or null when the watch saw none. */
  startedAt: number | null
  /**
   * `projectDirName` of the matching execution's `cwd`; for a terminal the watch saw no execution in, of the
   * folder VS Code's shell integration reports for it (§0a.3); else null.
   */
  projectDir: string | null
}

/** Who wants the watch: the keep-warm line (while it may act) and the prompt tool (while its section is listed). */
export type WatchUser = 'keepWarm' | 'prompts'

export class TerminalWatch {
  private readonly window: TerminalWindow
  private readonly clock: () => number
  /** The users that want the watch now; it listens while this is not empty. */
  private readonly users = new Set<WatchUser>()
  private disposed = false
  /** When listening began: a session's newest reply before it is one this window cannot judge G8 for. */
  private startedListening = 0
  private subs: vscode.Disposable[] = []
  /**
   * The open shell executions of each terminal (started, not ended) — references, never their values —,
   * each with when its start event came on this watch's clock (G13, 1.10 A4 rule 8).
   */
  private open = new Map<vscode.Terminal, Map<vscode.TerminalShellExecution, number>>()
  private active: vscode.Terminal | undefined = undefined
  private focused = false
  /** Per terminal, when it last stopped being the focused window's active terminal. */
  private touchedAt = new Map<vscode.Terminal, number>()
  private changeListeners: Array<(e: void) => unknown> = []

  constructor(window: TerminalWindow, clock?: () => number) {
    this.window = window
    this.clock = clock ?? Date.now
  }

  /**
   * A terminal closed, became active, or started or ended an execution — what the Prompts section's
   * target line says may change. Fires only while the watch listens.
   */
  readonly onDidChange: vscode.Event<void> = (listener, thisArgs?, disposables?) => {
    const bound = thisArgs === undefined ? listener : listener.bind(thisArgs)
    this.changeListeners.push(bound)
    const d: vscode.Disposable = {
      dispose: () => {
        const at = this.changeListeners.indexOf(bound)
        if (at >= 0) this.changeListeners.splice(at, 1)
      },
    } as vscode.Disposable
    if (Array.isArray(disposables)) disposables.push(d)
    return d
  }

  /**
   * One user wants the watch, or no longer does. The first user's want subscribes to the five events
   * (and notes `now` as the moment listening began); the last one's release drops them and everything
   * held. A second want of the same user changes nothing.
   */
  want(user: WatchUser, on: boolean, now: number): void {
    if (this.disposed) return
    const had = this.users.size > 0
    if (on === true) this.users.add(user)
    else this.users.delete(user)
    const wanted = this.users.size > 0
    if (wanted && !had) this.startTracking(now)
    else if (!wanted && had) this.stopTracking()
  }

  /** Whether the events are subscribed to — some user wants the watch. */
  isTracking(): boolean {
    return this.users.size > 0
  }

  /** When listening began (G8's `unknown`: a reply before it is one this window cannot judge). */
  since(): number {
    return this.startedListening
  }

  /**
   * G7 (moved verbatim from 1.8's KeepWarmHost.claudeTerminals): the terminals of this window with an open
   * execution of Claude Code in the folder whose project-directory name is `projectDir`, and whose shell
   * — where VS Code reports one — is Claude Code; each with when its matching execution started (G13 — of
   * several, the newest: the one that runs now).
   */
  claudeTerminals(projectDir: string): Array<{ terminal: vscode.Terminal; startedAt: number }> {
    const out: Array<{ terminal: vscode.Terminal; startedAt: number }> = []
    if (projectDir === '') return out
    const present = this.window.terminals
    for (const [terminal, executions] of this.open) {
      if (!present.includes(terminal)) continue
      const shell = shellOf(terminal)
      if (shell !== undefined && shell !== CLAUDE_SHELL) continue
      let startedAt: number | null = null
      for (const [execution, at] of executions) {
        if (claudeExecutionMatches(executionFacts(execution), projectDir) && (startedAt === null || at > startedAt)) startedAt = at
      }
      if (startedAt !== null) out.push({ terminal, startedAt })
    }
    return out
  }

  /**
   * §3 A3 rule 2: every terminal of this window that runs Claude Code or Codex, in the order of
   * `window.terminals`. A terminal is one (i) with an open execution of `claude` or `codex` (Medium
   * confidence or more) whose shell VS Code does not report or reports as that program — of several such
   * executions, the newest decides; or else (ii) whose shell VS Code reports as `claude` or `codex` — a
   * program started before the watch listened, whose folder is then the one the shell integration reports.
   * A terminal whose shell VS Code names as anything else never is, whatever an old execution said. While
   * no user wants the watch, nothing of a terminal is looked at: none.
   */
  agentTerminals(): AgentTerminal[] {
    const out: AgentTerminal[] = []
    if (!this.isTracking()) return out
    const terminals = this.window.terminals
    for (let i = 0; i < terminals.length; i++) {
      const terminal = terminals[i]
      const shell = shellOf(terminal)
      let found: { kind: AgentKind; startedAt: number; cwd: string | null } | null = null
      for (const [execution, at] of this.open.get(terminal) ?? []) {
        const facts = executionFacts(execution)
        const kind = agentExecutionKind(facts)
        if (kind === null || (shell !== undefined && shell !== kind)) continue
        if (found === null || at > found.startedAt) found = { kind, startedAt: at, cwd: facts.cwd }
      }
      if (found !== null) {
        const projectDir = found.cwd !== null && found.cwd !== '' ? projectDirName(found.cwd) : null
        out.push({ terminal, kind: found.kind, index: i + 1, startedAt: found.startedAt, projectDir })
      } else if (shell === 'claude' || shell === 'codex') {
        const cwd = reportedCwd(terminal)
        out.push({ terminal, kind: shell, index: i + 1, startedAt: null, projectDir: cwd === null ? null : projectDirName(cwd) })
      }
    }
    return out
  }

  /** G8 for one terminal since `lastTs`: touched, not touched, or not known to this window. */
  touchedSince(terminal: vscode.Terminal, lastTs: number | undefined): 'no' | 'yes' | 'unknown' {
    if (!finite(lastTs) || this.startedListening > lastTs) return 'unknown'
    if (this.focused && this.active === terminal) return 'yes'
    const at = this.touchedAt.get(terminal)
    return at !== undefined && at >= lastTs ? 'yes' : 'no'
  }

  dispose(): void {
    this.users.clear()
    this.stopTracking()
    this.changeListeners = []
    this.disposed = true
  }

  // ------------------------------------------------------------------ listening

  private startTracking(now: number): void {
    this.startedListening = now
    this.active = this.window.activeTerminal
    this.focused = this.window.state?.focused === true
    this.subs.push(
      this.window.onDidStartTerminalShellExecution((e) => {
        if (!e || !e.terminal || !e.execution) return
        const executions = this.open.get(e.terminal) ?? new Map<vscode.TerminalShellExecution, number>()
        if (executions.size >= EXECUTIONS_PER_TERMINAL_MAX) executions.delete(executions.keys().next().value as vscode.TerminalShellExecution)
        // When it started, on this watch's clock: G13 and the prompt tool compare the sessions' times with it.
        executions.set(e.execution, this.clock())
        this.open.set(e.terminal, executions)
        this.changed()
      }),
      this.window.onDidEndTerminalShellExecution((e) => {
        if (!e || !e.terminal) return
        const executions = this.open.get(e.terminal)
        if (!executions) return
        executions.delete(e.execution)
        if (executions.size === 0) this.open.delete(e.terminal)
        this.changed()
      }),
      this.window.onDidCloseTerminal((terminal) => {
        this.open.delete(terminal)
        this.touchedAt.delete(terminal)
        if (this.active === terminal) this.active = undefined
        this.changed()
      }),
      this.window.onDidChangeActiveTerminal((terminal) => {
        this.closeTouch(this.clock())
        this.active = terminal
        this.changed()
      }),
      this.window.onDidChangeWindowState((s) => {
        this.closeTouch(this.clock())
        this.focused = s?.focused === true
      }),
    )
  }

  private stopTracking(): void {
    for (const d of this.subs.splice(0)) {
      try { d.dispose() } catch { /* a listener that is gone is gone */ }
    }
    this.open.clear()
    this.touchedAt.clear()
    this.active = undefined
    this.focused = false
  }

  /** The focused window's active terminal stops being so now (a change of either is coming). */
  private closeTouch(now: number): void {
    if (this.focused && this.active !== undefined) this.touchedAt.set(this.active, now)
  }

  private changed(): void {
    for (const l of [...this.changeListeners]) {
      try { l() } catch { /* a listener's failure is its own */ }
    }
  }
}
