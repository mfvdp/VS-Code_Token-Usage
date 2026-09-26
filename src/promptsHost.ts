// SPDX-FileCopyrightText: 2026 Frederik Marx
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * 1.10 A (spec §2.5, §3 A1, §0a.1): the host side of the prompt list — the store and what the Prompts
 * section is built from.
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
 *  • The section (`PromptsHost.vmInput`): the store as read now, and the last operation's refusal for
 *    PROMPT_FLASH_MS — the view model says it in words. The send path (the target line, the send, its flash)
 *    comes with P4 (§3 A3).
 */

import * as crypto from 'crypto'
import * as fs from 'fs'
import * as path from 'path'
import {
  applyPromptOp, PROMPTS_FILE_MAX_BYTES, PROMPTS_FILE_NAME, parsePromptsText, promptFieldProblem, PromptFieldProblem, PromptOp,
  PromptOpFailure, PromptOpResult, PromptsRead, shippedOf, userIdFrom,
} from './prompts'
import type { PromptsVmInput } from './viewModel'

/** §3 A3 rule 9: how long the section shows the last operation's (or send's) outcome. */
export const PROMPT_FLASH_MS = 10_000

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

/**
 * §3 A1 (P3): what the Prompts section is built from, and the operations the page and the command ask for.
 * P4 adds the send path — the target line's facts, the send, its flash (§3 A3).
 */
export class PromptsHost {
  private readonly store: PromptStore
  private readonly clock: () => number
  private flash: { failure: PromptOpFailure; error: string | null; at: number } | null = null

  constructor(opts: { store: PromptStore; clock?: () => number }) {
    this.store = opts.store
    this.clock = opts.clock ?? Date.now
  }

  /** What the section shows now — the store as read, and a refused operation's reason for PROMPT_FLASH_MS. */
  vmInput(now: number): PromptsVmInput {
    const f = this.flash
    const flash = f !== null && now >= f.at && now - f.at < PROMPT_FLASH_MS ? { failure: f.failure, error: f.error } : null
    if (f !== null && flash === null && now - f.at >= PROMPT_FLASH_MS) this.flash = null
    return { read: this.store.read(), flash }
  }

  /**
   * §3 A1 rule 4: save / delete / move / restore on the store; a refusal the reader has to know of is the
   * section's flash (`Not saved: …`). A `notFound` (another window deleted the entry) and an `unchanged` say
   * nothing: the next push shows the list as it is.
   */
  apply(op: PromptOp): PromptApplied {
    const r = this.store.apply(op)
    const failure: PromptOpFailure | null = r.result === 'readOnly' ? 'readOnly'
      : r.result === 'notWritten' ? 'notWritten'
        : r.result === 'full' ? 'full'
          : r.result === 'invalid' && (r.problem === 'titleEmpty' || r.problem === 'textEmpty' || r.problem === 'textBang') ? r.problem
            : null
    this.flash = failure === null ? null : { failure, error: r.error, at: this.clock() }
    return r
  }

  /** *Clear Stored Data…* deleted the file. */
  forget(): void {
    this.store.forget()
    this.flash = null
  }
}
