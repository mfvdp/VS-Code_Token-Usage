// SPDX-FileCopyrightText: 2026 Frederik Marx
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * 1.10 A (spec §2.5, §3 A1, A3, §0a.1, §0a.4): the host side of the prompt list — the store, what the Prompts
 * section is built from, and the send.
 *
 *  • The store (`PromptStore`, §0a.1). `<globalStorage>/prompts.json`, read when the Prompts section is
 *    listed (a `stat` per view-model build, parsed again only when its size, time or inode changed) and
 *    before every operation (read again, uncached: another window's change made in between is kept). Written
 *    only by an operation the reader asked for — whole and atomically, `<file>.tmp-<pid>` then `rename` —,
 *    never at activation, by a build or when nothing changed: a reader who never edits has no file. An
 *    unreadable file (not JSON, not the shape, larger than 512 KiB, an I/O error) or a newer build's is
 *    never overwritten: the list shows the three shipped entries and every operation is refused, and the
 *    log says so once per state change.
 *  • The log names an operation's kind and whether the entry is a shipped or a user one — `Prompts: saved a
 *    user prompt` —, an error's code, a file state's kind; never a title or a text, never an id beyond its
 *    class. The texts are user data (§0a.1).
 *  • The section (`PromptsHost.vmInput`): the store as read now, where a prompt would go now (the target
 *    line's facts), and the last operation's refusal or the last send's outcome for PROMPT_FLASH_MS — the
 *    view model says it in words.
 *  • The send (P4, §3 A3, §0a.4). Only on the reader's own action on that entry at that moment, one flow at
 *    a time and at most one per PROMPT_SEND_MIN_GAP_MS: the terminal — the active one when it runs Claude
 *    Code or Codex, else the one the reader picks among exactly those —, the decision (`promptSendDecision`,
 *    §3 A4) on facts gathered now, *Send anyway* where the transcript cannot tell work from a dialog and the
 *    decision once more after it, then the text of the entry read now (never a text of the page's) typed
 *    by `typePrompt`: the text, and PROMPT_ENTER_DELAY_MS later the Enter alone. A keep-warm countdown for
 *    that terminal ends first (`yieldTo`). Nothing is read back from the terminal; the log names the
 *    program, the terminal's place and a block's code — never a title, a text, a folder or a terminal's name.
 */

import * as crypto from 'crypto'
import * as fs from 'fs'
import * as path from 'path'
import type * as vscode from 'vscode'
import { SOURCE_TITLE } from './adapters'
import { t } from './i18n'
import {
  applyPromptOp, cleanPromptText, PROMPTS_FILE_MAX_BYTES, PROMPTS_FILE_NAME, parsePromptsText, promptFieldProblem, PromptFieldProblem,
  PromptOp, PromptOpFailure, PromptOpResult, PromptsRead, promptTextOf, shippedOf, userIdFrom,
} from './prompts'
import { PromptSendBlock, PromptSession, PromptVerdict, promptBlockText, promptSendDecision } from './promptSend'
import type { AgentKind, AgentTerminal, TerminalWatch } from './terminalWatch'
import type { PromptSentFlash, PromptsVmInput, PromptTargetInput } from './viewModel'

/** §3 A3 rule 9: how long the section shows the last operation's (or send's) outcome. */
export const PROMPT_FLASH_MS = 10_000
/**
 * §3 A3 rule 7: at most one send per this many milliseconds per window — a key held down, a triple click or
 * a second click while the Enter is still to come sends once.
 */
export const PROMPT_SEND_MIN_GAP_MS = 1000
/**
 * §7a's probe (binding): the Enter goes this long after the text, as a write of its own. One write of a long
 * text and its Enter does not submit it in Claude Code — a large chunk is taken as pasted text and the Enter
 * kept as a line break (seen with a 100- and a 119-character prompt; 7 and 54 characters went) —; two
 * writes do.
 */
export const PROMPT_ENTER_DELAY_MS = 200

export interface PromptsLog {
  info(m: string): void
  debug(m: string): void
  warn(m: string): void
}

/** What an operation came to — `PromptOpResult`, or why the store refused it before or after the change. */
export interface PromptApplied {
  result: PromptOpResult | 'readOnly' | 'notWritten'
  /** `restored`: how many shipped entries came back. */
  restored: number
  /** `invalid` of a save: which rule refused it. */
  problem: PromptFieldProblem | null
  /**
   * `notWritten`: the error's code (`EACCES`, `ENOSPC` …, `tooLarge`), never its message — that holds a path;
   * `readOnly`: the file's state (`json`, `shape`, `tooLarge`, `io`, `newer`).
   */
  error: string | null
}

/** A new entry's id from the system's random source — `u-` and eight of `[a-z0-9]`. */
export function newPromptId(): string {
  for (;;) {
    const id = userIdFrom(crypto.randomBytes(16))
    if (id !== null) return id
  }
}

/** The kind of a file state, for the log's "once per state change". */
function stateKey(r: PromptsRead): string {
  return r.state === 'unreadable' ? `unreadable:${r.kind}` : r.state
}

/** `a shipped prompt` / `a user prompt` — all the log may say of an entry. */
function classOf(id: string | null): string {
  return id !== null && shippedOf(id) !== null ? 'a shipped prompt' : 'a user prompt'
}

/** §0a.1: `<globalStorage>/prompts.json` — read by its shape, written whole and atomically, one change at a time. */
export class PromptStore {
  private cache: { mtimeMs: number; size: number; ino: number; read: PromptsRead } | null = null
  /** The state the log last named, so a state is said once (the first read of a readable file says nothing). */
  private logged: string | null = null

  constructor(private readonly file: string, private readonly log: PromptsLog) {}

  /** The file as it is now: a `stat`, and a parse only when its size, time or inode changed since the last one. */
  read(): PromptsRead {
    return this.load(true)
  }

  /**
   * §3 A1 rule 4: one change by id on the file as it is on disk now — read again first, uncached, so a change
   * another window made in between is kept —, written whole and atomically. Nothing is written on a refusal,
   * on `unchanged`, or while the file is unreadable or newer (then its bytes stay as the reader left them).
   */
  apply(op: PromptOp): PromptApplied {
    const read = this.load(false)
    const what = op.op === 'save' ? (op.id === null ? 'add' : 'save') : op.op
    if (read.state === 'unreadable' || read.state === 'newer') {
      this.log.info(`Prompts: not changed (${what}) — prompts.json is read-only in this state.`)
      return { result: 'readOnly', restored: 0, problem: null, error: read.state === 'newer' ? 'newer' : read.kind }
    }
    const { file, result, restored } = applyPromptOp(read, op, newPromptId)
    if (file === null) {
      const problem = result === 'invalid' && op.op === 'save' ? promptFieldProblem(op.title, op.text) : null
      this.log.debug(`Prompts: nothing written (${what}: ${result}${problem !== null ? `, ${problem}` : ''}).`)
      return { result, restored: 0, problem, error: null }
    }
    const text = JSON.stringify(file, null, 2) + '\n'
    // Every entry at its caps still fits, but a text of escaped characters could not: a file this build would
    // read back as `tooLarge` is not written.
    if (Buffer.byteLength(text, 'utf8') > PROMPTS_FILE_MAX_BYTES) {
      this.log.warn('Prompts: prompts.json could not be written (tooLarge).')
      return { result: 'notWritten', restored: 0, problem: null, error: 'tooLarge' }
    }
    const tmp = `${this.file}.tmp-${process.pid}`
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true })
      fs.writeFileSync(tmp, text)
      fs.renameSync(tmp, this.file)
    } catch (err) {
      try { fs.rmSync(tmp, { force: true }) } catch { /* nothing left to tidy */ }
      const code = errorCode(err)
      this.log.warn(`Prompts: prompts.json could not be written (${code}).`)
      this.cache = null
      return { result: 'notWritten', restored: 0, problem: null, error: code }
    }
    this.cache = null
    const subject = op.op === 'restore' ? `${restored} shipped prompt(s)` : classOf(op.id)
    this.log.info(`Prompts: ${result} ${subject}.`)
    return { result, restored, problem: null, error: null }
  }

  /** *Clear Stored Data…* deleted the file: nothing held of it is kept; the list is the three shipped entries again. */
  forget(): void {
    this.cache = null
    this.logged = null
  }

  private load(cached: boolean): PromptsRead {
    let st: fs.Stats
    try {
      st = fs.statSync(this.file)
    } catch (err) {
      this.cache = null
      return this.said(errorCode(err) === 'ENOENT' ? { state: 'absent' } : { state: 'unreadable', kind: 'io' })
    }
    if (!st.isFile()) return this.said({ state: 'unreadable', kind: 'io' })
    const c = this.cache
    if (cached && c !== null && c.mtimeMs === st.mtimeMs && c.size === st.size && c.ino === st.ino) return c.read
    let read: PromptsRead
    if (st.size > PROMPTS_FILE_MAX_BYTES) {
      // Not even read: a file this large is no list this build wrote.
      read = { state: 'unreadable', kind: 'tooLarge' }
    } else {
      try {
        read = parsePromptsText(fs.readFileSync(this.file, 'utf8'))
      } catch {
        read = { state: 'unreadable', kind: 'io' }
      }
    }
    this.cache = { mtimeMs: st.mtimeMs, size: st.size, ino: st.ino, read }
    return this.said(read)
  }

  /** Logs a state that keeps the file from being changed, once per change of state. */
  private said(read: PromptsRead): PromptsRead {
    const key = stateKey(read)
    if (key !== this.logged) {
      if (read.state === 'unreadable') this.log.warn(`Prompts: prompts.json could not be read (${read.kind}); nothing is written.`)
      if (read.state === 'newer') this.log.warn('Prompts: prompts.json could not be read (newer); nothing is written.')
      this.logged = key
    }
    return read
  }
}

function errorCode(err: unknown): string {
  const code = (err as NodeJS.ErrnoException | null)?.code
  return typeof code === 'string' && /^[A-Z0-9_]{1,32}$/.test(code) ? code : 'error'
}

/** The store's file name in `globalStorage` — re-exported for the wiring, beside the keep-warm file's. */
export { PROMPTS_FILE_NAME }

/** The slice of `vscode.window` the send flow uses — the real one in the extension, a fake in the tests. */
export interface PromptsWindow {
  readonly terminals: readonly vscode.Terminal[]
  readonly activeTerminal: vscode.Terminal | undefined
  showQuickPick<T extends vscode.QuickPickItem>(items: readonly T[], options?: vscode.QuickPickOptions): Thenable<T | undefined>
  showInformationMessage(message: string, ...items: string[]): Thenable<string | undefined>
  showWarningMessage(message: string, options: vscode.MessageOptions, ...items: string[]): Thenable<string | undefined>
}

/**
 * §0a.5: what a decision reads beside the terminal — gathered by the extension when it is asked for, fresh
 * for every decision: the workspace's trust, whether the transcripts are being read (G14), and every main
 * session of a folder with its agent-hook permission wait (`folderSessions` + `hookPermissionOpen`).
 */
export interface PromptHostFacts {
  trusted: boolean
  settled: boolean
  sessions(projectDir: string): PromptSession[]
}

/** The timer the Enter waits on — `setTimeout`'s in the extension, a fake in the tests. */
export interface PromptTimers {
  set(fn: () => void, ms: number): unknown
  clear(handle: unknown): void
}

const REAL_TIMERS: PromptTimers = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
}

/**
 * 1.10 P5 (§3 A7's smoke test): what a send of an entry would do now, as `PromptsHost.check` answers it — a hard or
 * soft block of §3 A4 (a code, never its words), `pick` (the reader would be asked for a terminal), `send` (it would
 * go without a question), or `notFound` (the list holds no such entry).
 */
export type PromptSendCheck = PromptSendBlock | 'pick' | 'send' | 'notFound'

/** The keep-warm host's one method the send uses (§3 A3 rule 8). */
export interface PromptsKeepWarm {
  yieldTo(terminal: vscode.Terminal): boolean
}

/**
 * §0a.4 (§7a's probe, binding): the one write of a prompt into another program's input — the text without
 * Enter, then, PROMPT_ENTER_DELAY_MS later, the Enter alone. Of the terminal only `sendText`; nothing is read
 * back. Called only by the send flow, after the reader's click (and *Send anyway* where it asks first).
 */
async function typePrompt(terminal: vscode.Terminal, text: string, wait: (ms: number) => Promise<void>): Promise<void> {
  terminal.sendText(text, false)
  await wait(PROMPT_ENTER_DELAY_MS)
  terminal.sendText('', true)
}

/** An error's `name` for the log — never its message, which can hold a path or a text. */
function errorName(err: unknown): string {
  const name = (err as { name?: unknown } | null)?.name
  return typeof name === 'string' && /^[A-Za-z0-9_]{1,40}$/.test(name) ? name : 'error'
}

/**
 * §3 A3 rule 4: what a *Send anyway* risks in that terminal — Claude Code's dialogs, or a Codex approval —,
 * and that an unsent draft goes with the prompt.
 */
function riskText(kind: AgentKind): string {
  return kind === 'codex'
    ? t('If Codex is waiting for an approval there, the text and Enter would answer it. Text typed in that terminal and not sent yet goes with it.')
    : t('If Claude Code is showing a permission dialog or a question there, the text and Enter would answer it. Text typed in that terminal and not sent yet goes with it.')
}

/**
 * §3 A1 (P3) and §3 A3 (P4): what the Prompts section is built from, the operations the page and the command
 * ask for, and the send.
 */
export class PromptsHost {
  private readonly store: PromptStore
  private readonly window: PromptsWindow
  private readonly watch: TerminalWatch
  private readonly keepWarm: PromptsKeepWarm
  private readonly log: PromptsLog
  private readonly clock: () => number
  private readonly timers: PromptTimers
  /** The last outcome the section shows for PROMPT_FLASH_MS: an operation's refusal, or a send's outcome. */
  private flash: { op: { failure: PromptOpFailure; error: string | null } | null; sent: PromptSentFlash | null; at: number } | null = null
  /** A send flow is open — its terminal pick, its modal, or its Enter still to come (§3 A3 rule 7). */
  private busy = false
  /** When the last send flow began (rule 7's gap). */
  private lastSendAt: number | null = null
  /** The Enter writes still to come, so that a window that goes takes them with it. */
  private readonly pending = new Set<{ handle: unknown; reject: (err: Error) => void }>()
  private disposed = false

  constructor(opts: {
    store: PromptStore
    window: PromptsWindow
    watch: TerminalWatch
    keepWarm: PromptsKeepWarm
    log: PromptsLog
    clock?: () => number
    timers?: PromptTimers
  }) {
    this.store = opts.store
    this.window = opts.window
    this.watch = opts.watch
    this.keepWarm = opts.keepWarm
    this.log = opts.log
    this.clock = opts.clock ?? Date.now
    this.timers = opts.timers ?? REAL_TIMERS
  }

  /**
   * What the section shows now — the store as read, where a prompt would go (§3 A3 rule 6), and the last
   * refused operation's reason or the last send's outcome for PROMPT_FLASH_MS.
   */
  vmInput(now: number, facts: PromptHostFacts): PromptsVmInput {
    const f = this.flash
    const shown = f !== null && now >= f.at && now - f.at < PROMPT_FLASH_MS
    if (f !== null && !shown && now - f.at >= PROMPT_FLASH_MS) this.flash = null
    return {
      read: this.store.read(),
      flash: shown ? f.op : null,
      sent: shown ? f.sent : null,
      target: this.targetOf(facts, now),
    }
  }

  /**
   * §3 A1 rule 4: save / delete / move / restore on the store; a refusal the reader has to know of is the
   * section's flash (`Not saved: …`). A `notFound` (another window deleted the entry) and an `unchanged` say
   * nothing: the next push shows the list as it is. Either way the last send's flash gives way.
   */
  apply(op: PromptOp): PromptApplied {
    const r = this.store.apply(op)
    const failure: PromptOpFailure | null = r.result === 'readOnly' ? 'readOnly'
      : r.result === 'notWritten' ? 'notWritten'
        : r.result === 'full' ? 'full'
          : r.result === 'invalid' && (r.problem === 'titleEmpty' || r.problem === 'textEmpty' || r.problem === 'textBang') ? r.problem
            : null
    this.flash = failure === null ? null : { op: { failure, error: r.error }, sent: null, at: this.clock() }
    return r
  }

  /**
   * §3 A3: the send flow for the entry `id` — only ever on the reader's own action on it (the page's
   * `promptSend`, which carries no text). Dropped while another flow is open or the last one began less than
   * PROMPT_SEND_MIN_GAP_MS ago, and for an id the list does not hold. `facts` is asked again for every
   * decision: the one before the terminal pick, the one after it, and the one after *Send anyway*.
   */
  async send(id: string, facts: () => PromptHostFacts): Promise<void> {
    if (this.disposed) return
    const now = this.clock()
    if (this.busy || (this.lastSendAt !== null && now >= this.lastSendAt && now - this.lastSendAt < PROMPT_SEND_MIN_GAP_MS)) {
      this.log.info('Prompts: a send was dropped (another one is under way)')
      return
    }
    const entry = promptTextOf(this.store.read(), id)
    if (entry === null) {
      this.log.info('Prompts: not sent (no such prompt)')
      return
    }
    this.busy = true
    this.lastSendAt = now
    try {
      await this.flow(id, entry.title, facts)
    } catch (err) {
      if (!this.disposed) this.log.warn(`Prompts: the send failed (${errorName(err)})`)
    } finally {
      this.busy = false
    }
  }

  /**
   * 1.10 P5 (§3 A7's smoke test): the decisions `send` takes before its first question to the reader, on the facts
   * of now — Restricted Mode or a reading under way, no terminal, the terminal pick, the active terminal's verdict —
   * and nothing else: nothing is typed, nothing is asked, shown or logged, no flash is set and the gap rule is not
   * touched. A code, never a word of the entry. The one send there is stays the reader's click on the page.
   */
  check(id: string, f: PromptHostFacts): PromptSendCheck {
    if (promptTextOf(this.store.read(), id) === null) return 'notFound'
    const o = this.opening(f)
    if ('block' in o) return o.block
    if (o.active === null) return 'pick'
    const v = this.verdictOf(o.active, f, this.clock())
    return v.send ? 'send' : v.block
  }

  /** *Clear Stored Data…* deleted the file. */
  forget(): void {
    this.store.forget()
    this.flash = null
  }

  /** The window goes: an Enter still to come is not typed, and no flow acts any more. */
  dispose(): void {
    this.disposed = true
    for (const p of this.pending) {
      this.timers.clear(p.handle)
      p.reject(new Error('disposed'))
    }
    this.pending.clear()
  }

  // ------------------------------------------------------------------ the send flow

  /**
   * The flow's first steps, shared with `check`: Restricted Mode and a reading under way are said before any
   * terminal is offered (rules 1 and 2 of A4), then no candidate is `noTerminal`; otherwise the candidates and the
   * active terminal when it is one of them (rule 3).
   */
  private opening(f: PromptHostFacts): { block: PromptSendBlock } | { candidates: AgentTerminal[]; active: AgentTerminal | null } {
    const early = promptSendDecision({ trusted: f.trusted, settled: f.settled, target: null, sessions: [] }, this.clock())
    if (!early.send && (early.block === 'restricted' || early.block === 'reading')) return { block: early.block }
    const candidates = this.watch.agentTerminals()
    if (candidates.length === 0) return { block: 'noTerminal' }
    const active = this.window.activeTerminal
    return { candidates, active: active === undefined ? null : candidates.find((c) => c.terminal === active) ?? null }
  }

  /** §3 A3 rules 3–5: the terminal, the decision, the question, the write. */
  private async flow(id: string, title: string, facts: () => PromptHostFacts): Promise<void> {
    const f = facts()
    const o = this.opening(f)
    if ('block' in o) return this.refuse(o.block)
    // Rule 3: the active terminal when it is a candidate — no question; otherwise the reader picks one.
    let terminal: vscode.Terminal | null = o.active === null ? null : o.active.terminal
    if (terminal === null) {
      terminal = await this.pick(title, o.candidates, f)
      if (this.disposed) return
      if (terminal === null) {
        this.log.debug('Prompts: not sent (no terminal was picked)')
        return
      }
    }
    // Rule 4: the decision on facts gathered now.
    let d = this.decide(terminal, facts())
    if (!d.verdict.send && !d.verdict.soft) return this.refuse(d.verdict.block)
    if (!d.verdict.send) {
      const block = d.verdict.block
      const sendAnyway = t('Send anyway')
      const answer = await this.window.showWarningMessage(t('Send “{0}” anyway?', title),
        { modal: true, detail: `${promptBlockText(block)}\n\n${riskText(d.candidate?.kind ?? 'claude')}` }, sendAnyway)
      if (this.disposed) return
      if (answer !== sendAnyway) {
        this.log.info(`Prompts: not sent (${block})`)
        return
      }
      // Again, on the facts of this moment: hard now is refused as a hard block; soft or clear goes.
      d = this.decide(terminal, facts())
      if (!d.verdict.send && !d.verdict.soft) return this.refuse(d.verdict.block)
    }
    if (d.candidate === null) return this.refuse('noTerminal')
    await this.typeInto(id, d.candidate)
  }

  /**
   * §3 A3 rule 3: a Quick Pick of exactly the terminals that run Claude Code or Codex, in their order, each
   * named by its place in the window — never by its name — with its verdict word and its reason.
   */
  private async pick(title: string, candidates: AgentTerminal[], f: PromptHostFacts): Promise<vscode.Terminal | null> {
    const count = this.window.terminals.length
    const now = this.clock()
    const items = candidates.map((c, at) => {
      const v = this.verdictOf(c, f, now)
      return {
        // The product name as the registry has it — never translated (§3 A6).
        label: t('{0} — terminal {1} of {2}', SOURCE_TITLE[c.kind], c.index, count),
        description: v.send ? t('ready') : v.soft ? t('sending asks first') : t('not now'),
        detail: v.send ? undefined : promptBlockText(v.block),
        at,
      }
    })
    const chosen = await this.window.showQuickPick(items, {
      title: t('Send “{0}” to …', title),
      placeHolder: t('Pick the terminal that runs Claude Code or Codex'),
    })
    return chosen === undefined ? null : candidates[chosen.at]?.terminal ?? null
  }

  /** The decision for one terminal on `f`: the terminal as a candidate now (null — no longer one), and the verdict. */
  private decide(terminal: vscode.Terminal, f: PromptHostFacts): { candidate: AgentTerminal | null; verdict: PromptVerdict } {
    const candidate = this.watch.agentTerminals().find((c) => c.terminal === terminal) ?? null
    return { candidate, verdict: this.verdictOf(candidate, f, this.clock()) }
  }

  /** §3 A4 for one candidate (or none): its program, its start and its folder, and — for Claude Code — its folder's sessions. */
  private verdictOf(c: AgentTerminal | null, f: PromptHostFacts, now: number): PromptVerdict {
    const sessions = c !== null && c.kind === 'claude' && c.projectDir !== null ? f.sessions(c.projectDir) : []
    return promptSendDecision({
      trusted: f.trusted,
      settled: f.settled,
      target: c === null ? null : { kind: c.kind, startedAt: c.startedAt, projectDir: c.projectDir },
      sessions,
    }, now)
  }

  /** A hard block: the information message, the flash, the log's code — nothing typed. */
  private refuse(block: PromptSendBlock): void {
    this.log.info(`Prompts: not sent (${block})`)
    this.flash = { op: null, sent: { ok: false, block }, at: this.clock() }
    void this.window.showInformationMessage(t('Token Pace: the prompt was not sent. {0}', promptBlockText(block)))
  }

  /**
   * §3 A3 rule 5: the terminal still in the window; the text of the id read now — the stored words, or the
   * shipped ones in the language of now, KEEP_WARM_LINE for the keep-warm entry —, cleaned once more; a
   * keep-warm countdown for that terminal ended (rule 8); the text and the Enter typed; the terminal shown,
   * the focus kept on the dashboard; the flash and the log line.
   */
  private async typeInto(id: string, c: AgentTerminal): Promise<void> {
    const terminal = c.terminal
    if (!this.window.terminals.includes(terminal)) return this.refuse('noTerminal')
    const entry = promptTextOf(this.store.read(), id)
    const text = entry === null ? null : cleanPromptText(entry.text)
    if (text === null) {
      this.log.info('Prompts: not sent (no such prompt)')
      return
    }
    this.keepWarm.yieldTo(terminal)
    const count = this.window.terminals.length
    try {
      await typePrompt(terminal, text, (ms) => this.wait(ms))
    } catch (err) {
      if (this.disposed) return
      this.log.warn(`Prompts: not sent (the terminal did not take it: ${errorName(err)})`)
      this.flash = { op: null, sent: { ok: false, block: 'failed' }, at: this.clock() }
      return
    }
    if (this.disposed) return
    terminal.show(true)
    this.flash = { op: null, sent: { ok: true, kind: c.kind, index: c.index, count }, at: this.clock() }
    this.log.info(`Prompts: sent a prompt to ${SOURCE_TITLE[c.kind]} in terminal ${c.index} of ${count}`)
  }

  /** PROMPT_ENTER_DELAY_MS on the host's timers — a window that goes meanwhile rejects it (`dispose`). */
  private wait(ms: number): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const p = { handle: null as unknown, reject }
      this.pending.add(p)
      p.handle = this.timers.set(() => {
        this.pending.delete(p)
        resolve()
      }, ms)
    })
  }

  // ------------------------------------------------------------------ the target line

  /** §3 A3 rule 6: where a prompt goes now — Restricted Mode, no terminal, the active one with its verdict, or a pick. */
  private targetOf(f: PromptHostFacts, now: number): PromptTargetInput {
    if (f.trusted !== true) return { state: 'restricted' }
    const candidates = this.watch.agentTerminals()
    if (candidates.length === 0) return { state: 'none' }
    const active = this.window.activeTerminal
    const c = active === undefined ? undefined : candidates.find((x) => x.terminal === active)
    if (c === undefined) return { state: 'pick', candidates: candidates.length }
    return { state: 'active', kind: c.kind, index: c.index, count: this.window.terminals.length, verdict: this.verdictOf(c, f, now) }
  }
}
