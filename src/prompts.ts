// SPDX-FileCopyrightText: 2026 Frederik Marx
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * 1.10 A (spec §2.1, §3 A1, §0a.1): the reader's own list of prompts — pure. What `prompts.json` may
 * hold and how it is read back (strictly: anything else is unreadable, never repaired), how a title and
 * a text are cleaned, the three prompts Token Pace ships, and the four operations on the list.
 *
 *  • The texts are user data. A title or a text reaches the dashboard page (the reader's own list), the
 *    send flow and the terminal it is typed into — nowhere else: no log line, no export, no report, no
 *    status-bar text. Nothing in this module logs; the host logs an operation's kind and whether the
 *    entry is a shipped or a user one, never its words.
 *  • No file = the three shipped entries. An unedited shipped entry is a reference (`{ "id": "s-status" }`)
 *    whose title and text are `t()` words, built at every call — they follow the language. An edited one
 *    holds the reader's words and does not; the keep-warm entry's text is KEEP_WARM_LINE, English in every
 *    language (1.8 §7a Q8), never a `t()` key.
 *  • One line. `sendText` has no bracketed paste, so a line break inside a text would be a key press and
 *    Claude Code would send the first line on its own: every line break and tab becomes a space, every
 *    other control character goes (an escape sequence typed into a TUI could drive it). A text starting
 *    with `!` is refused — Claude Code's shell escape.
 */

import { t } from './i18n'
import { KEEP_WARM_LINE } from './keepWarm'

/** 1.10 A: the three prompts Token Pace ships, in their order. */
export type ShippedPromptId = 'status' | 'keepWarm' | 'stop'
export const SHIPPED_PROMPTS: readonly ShippedPromptId[] = ['status', 'keepWarm', 'stop']
/** The id a shipped entry has in prompts.json and on the page. */
export const SHIPPED_PROMPT_KEY: Readonly<Record<ShippedPromptId, string>> = {
  status: 's-status',
  keepWarm: 's-keepwarm',
  stop: 's-stop',
}
export const PROMPTS_FILE_NAME = 'prompts.json'
export const PROMPTS_FILE_VERSION = 1
export const PROMPTS_MAX = 50
export const PROMPT_TITLE_MAX_CHARS = 80
export const PROMPT_TEXT_MAX_CHARS = 2000
export const PROMPTS_FILE_MAX_BYTES = 512 * 1024
export const PROMPT_ID_RE = /^(?:s-(?:status|keepwarm|stop)|u-[a-z0-9]{8})$/

/** A new entry's id: `u-` and eight of these. */
const USER_ID_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789'
/** How often a colliding new id is drawn again before the save is refused — a working source never gets near. */
const NEW_ID_DRAWS = 64

/** The shipped entry an id names, or null for a user entry (or no id at all). */
export function shippedOf(id: string): ShippedPromptId | null {
  for (const s of SHIPPED_PROMPTS) if (SHIPPED_PROMPT_KEY[s] === id) return s
  return null
}

/** Whether a value is an entry's id as prompts.json and the page write it. */
export function isPromptId(v: unknown): v is string {
  return typeof v === 'string' && PROMPT_ID_RE.test(v)
}

/**
 * A shipped entry's title in the reader's language — `t()` literals in a switch: the extract script reads
 * literals, and a table built at module load would stay in the language of the moment it was loaded.
 */
export function shippedPromptTitle(id: ShippedPromptId): string {
  switch (id) {
    case 'status': return t('Status table')
    case 'keepWarm': return t('Keep the cache warm')
    default: return t('Stop after this task')
  }
}

/** A shipped entry's text in the reader's language; the keep-warm entry's is KEEP_WARM_LINE in every language. */
export function shippedPromptText(id: ShippedPromptId): string {
  switch (id) {
    // Frederik's words (collect row 1), the table's five columns with their four separators.
    case 'status': return t('Show the current progress in a clear table. Columns: step/status | description | model | duration | expected to finish.')
    case 'keepWarm': return KEEP_WARM_LINE
    default: return t('Stop after the current task and do not start any new work.')
  }
}

export interface StoredPrompt { id: string; title?: string; text?: string }
export interface PromptsFile { v: 1; prompts: StoredPrompt[] }
export type PromptsRead =
  | { state: 'absent' }
  | { state: 'ok'; file: PromptsFile }
  | { state: 'unreadable'; kind: 'tooLarge' | 'json' | 'shape' | 'io' }
  | { state: 'newer'; v: number }

/** Why a save's title or text is refused. The two lengths cannot come from the page (its `maxlength`, the parser). */
export type PromptFieldProblem = 'titleEmpty' | 'titleLong' | 'textEmpty' | 'textLong' | 'textBang'

/** §3 A1 rule 3: one line — every line break and tab one space, every other control character gone —, trimmed. */
function oneLine(raw: string): string {
  return raw
    .replace(/\r\n|[\r\n\u2028\u2029\t]/g, ' ')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001F\u007F-\u009F]/g, '')
    .trim()
}

/** §3 A1 rule 3: a title as stored — or null when it is not a string, empty or longer than 80 code units. */
export function cleanPromptTitle(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const s = oneLine(raw)
  return s.length >= 1 && s.length <= PROMPT_TITLE_MAX_CHARS ? s : null
}

/** §3 A1 rule 3: a text as stored — or null when it is not a string, empty, longer than 2000 code units or starts with `!`. */
export function cleanPromptText(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const s = oneLine(raw)
  return s.length >= 1 && s.length <= PROMPT_TEXT_MAX_CHARS && !s.startsWith('!') ? s : null
}

/** Why a save would be refused — the first problem of title, then text — or null when both clean. */
export function promptFieldProblem(title: unknown, text: unknown): PromptFieldProblem | null {
  if (cleanPromptTitle(title) === null) return typeof title === 'string' && oneLine(title).length > PROMPT_TITLE_MAX_CHARS ? 'titleLong' : 'titleEmpty'
  if (cleanPromptText(text) !== null) return null
  if (typeof text !== 'string') return 'textEmpty'
  const s = oneLine(text)
  return s.length === 0 ? 'textEmpty' : s.length > PROMPT_TEXT_MAX_CHARS ? 'textLong' : 'textBang'
}

function plain(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x) && Object.getPrototypeOf(x) === Object.prototype
}

/**
 * §0a.1: the file as read — strict; never repaired. `raw` is the parsed JSON (the store checks the size
 * before it reads and the syntax before this). Exactly `v` and `prompts`; `v` 1 (a larger whole number is a
 * newer build's file, whatever else it holds); at most PROMPTS_MAX entries, each an `id` of PROMPT_ID_RE,
 * unique, and — for a shipped id — nothing else or both `title` and `text`, for a user id both; a title and a
 * text exactly as the cleaning keeps them. Anything else is `shape`.
 */
export function cleanPromptsFile(raw: unknown): PromptsRead {
  const shape: PromptsRead = { state: 'unreadable', kind: 'shape' }
  if (!plain(raw)) return shape
  const o = raw
  if (typeof o.v === 'number' && Number.isSafeInteger(o.v) && o.v > PROMPTS_FILE_VERSION) return { state: 'newer', v: o.v }
  const keys = Object.keys(o).sort()
  if (keys.length !== 2 || keys[0] !== 'prompts' || keys[1] !== 'v' || o.v !== PROMPTS_FILE_VERSION) return shape
  const list = o.prompts
  if (!Array.isArray(list) || list.length > PROMPTS_MAX) return shape
  const seen = new Set<string>()
  const prompts: StoredPrompt[] = []
  for (const e of list) {
    if (!plain(e)) return shape
    const fields = Object.keys(e).sort().join(',')
    const id = e.id
    if (!isPromptId(id) || seen.has(id)) return shape
    seen.add(id)
    if (fields === 'id' && shippedOf(id) !== null) {
      prompts.push({ id })
      continue
    }
    if (fields !== 'id,text,title') return shape
    const title = e.title
    const text = e.text
    if (typeof title !== 'string' || cleanPromptTitle(title) !== title) return shape
    if (typeof text !== 'string' || cleanPromptText(text) !== text) return shape
    prompts.push({ id, title, text })
  }
  return { state: 'ok', file: { v: 1, prompts } }
}

/** The file's text as read from disk: too large (unparsed), not JSON, or what `cleanPromptsFile` makes of it. */
export function parsePromptsText(text: string): PromptsRead {
  if (Buffer.byteLength(text, 'utf8') > PROMPTS_FILE_MAX_BYTES) return { state: 'unreadable', kind: 'tooLarge' }
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return { state: 'unreadable', kind: 'json' }
  }
  return cleanPromptsFile(raw)
}

export interface PromptEntry {
  id: string
  shipped: ShippedPromptId | null
  /** Unedited shipped entry: its words in the reader's language now; else the stored words. */
  title: string
  text: string
  /** A shipped entry whose words are the reader's own. */
  edited: boolean
}

/** The three shipped entries as references — the list while there is no file. */
function shippedReferences(): StoredPrompt[] {
  return SHIPPED_PROMPTS.map((s) => ({ id: SHIPPED_PROMPT_KEY[s] }))
}

function entryOf(p: StoredPrompt): PromptEntry {
  const shipped = shippedOf(p.id)
  if (shipped !== null && (p.title === undefined || p.text === undefined)) {
    return { id: p.id, shipped, title: shippedPromptTitle(shipped), text: shippedPromptText(shipped), edited: false }
  }
  return { id: p.id, shipped, title: p.title ?? '', text: p.text ?? '', edited: shipped !== null }
}

/**
 * What the list shows: the file's entries, or the three shipped ones when there is no file — or when it
 * cannot be changed (unreadable, newer: read-only, `writable` false). `restorable` counts the shipped
 * entries missing from a file the reader may change.
 */
export function promptEntries(read: PromptsRead): { entries: PromptEntry[]; writable: boolean; restorable: number } {
  if (read.state === 'ok') {
    const ids = new Set(read.file.prompts.map((p) => p.id))
    const restorable = SHIPPED_PROMPTS.filter((s) => !ids.has(SHIPPED_PROMPT_KEY[s])).length
    return { entries: read.file.prompts.map(entryOf), writable: true, restorable }
  }
  return { entries: shippedReferences().map(entryOf), writable: read.state === 'absent', restorable: 0 }
}

/** The text an id stands for now — the stored words or the shipped ones in the language of now; null for no such entry. */
export function promptTextOf(read: PromptsRead, id: string): { title: string; text: string } | null {
  const e = promptEntries(read).entries.find((x) => x.id === id)
  return e === undefined ? null : { title: e.title, text: e.text }
}

export type PromptOp =
  | { op: 'save'; id: string | null; title: string; text: string }
  | { op: 'delete'; id: string }
  | { op: 'move'; id: string; dir: 'up' | 'down' }
  | { op: 'restore' }
export type PromptOpResult = 'saved' | 'added' | 'deleted' | 'moved' | 'restored' | 'unchanged' | 'notFound' | 'full' | 'invalid'
/**
 * Why the host did not save what the reader asked for — the section's flash says it (§3 A3 rule 9). A title or
 * a text too long is none of them: the page's `maxlength` and the message parser keep one from arriving, and
 * the cleaning only ever shortens.
 */
export type PromptOpFailure = 'titleEmpty' | 'textEmpty' | 'textBang' | 'full' | 'notWritten' | 'readOnly'

/** A new user id: `u-` and eight characters of `[a-z0-9]` from `bytes` (one byte each, the modulo bias of 256 % 36 dropped). */
export function userIdFrom(bytes: Uint8Array): string | null {
  let id = 'u-'
  for (const b of bytes) {
    if (b >= 252) continue
    id += USER_ID_ALPHABET[b % USER_ID_ALPHABET.length]
    if (id.length === 10) return id
  }
  return null
}

function sameEntry(a: StoredPrompt, b: StoredPrompt): boolean {
  return a.id === b.id && a.title === b.title && a.text === b.text
}

/**
 * §3 A1 rule 4: one change by id on the file as it is now (absent = the three shipped entries as references);
 * pure. `file` is what to write, or null when nothing is to be written: `unchanged`, `notFound`, `full` and
 * `invalid` write nothing — and neither does a file that is unreadable or newer (`invalid`: the host refuses
 * those before it gets here). A save of a shipped id whose cleaned words are the shipped ones in the current
 * language is stored as the reference again (it follows the language again); a save that changes nothing is
 * `unchanged`. Restore appends the missing shipped ids in their order, as many as the list has room for.
 */
export function applyPromptOp(read: PromptsRead, op: PromptOp, newId: () => string): { file: PromptsFile | null; result: PromptOpResult; restored: number } {
  const none = (result: PromptOpResult): { file: null; result: PromptOpResult; restored: number } => ({ file: null, result, restored: 0 })
  if (read.state !== 'ok' && read.state !== 'absent') return none('invalid')
  const list: StoredPrompt[] = read.state === 'ok' ? read.file.prompts.map((p) => ({ ...p })) : shippedReferences()
  const done = (result: PromptOpResult, restored = 0): { file: PromptsFile; result: PromptOpResult; restored: number } =>
    ({ file: { v: 1, prompts: list }, result, restored })
  const at = (id: string): number => list.findIndex((p) => p.id === id)
  switch (op.op) {
    case 'save': {
      const title = cleanPromptTitle(op.title)
      const text = cleanPromptText(op.text)
      if (title === null || text === null) return none('invalid')
      if (op.id === null) {
        if (list.length >= PROMPTS_MAX) return none('full')
        for (let i = 0; i < NEW_ID_DRAWS; i++) {
          const id = newId()
          if (!PROMPT_ID_RE.test(id) || !id.startsWith('u-') || at(id) >= 0) continue
          list.push({ id, title, text })
          return done('added')
        }
        return none('invalid')
      }
      if (!isPromptId(op.id)) return none('invalid')
      const i = at(op.id)
      if (i < 0) return none('notFound')
      const shipped = shippedOf(op.id)
      const next: StoredPrompt = shipped !== null && title === shippedPromptTitle(shipped) && text === shippedPromptText(shipped)
        ? { id: op.id }
        : { id: op.id, title, text }
      if (sameEntry(list[i], next)) return none('unchanged')
      list[i] = next
      return done('saved')
    }
    case 'delete': {
      const i = at(op.id)
      if (i < 0) return none('notFound')
      list.splice(i, 1)
      return done('deleted')
    }
    case 'move': {
      const i = at(op.id)
      if (i < 0) return none('notFound')
      const j = op.dir === 'up' ? i - 1 : i + 1
      if (j < 0 || j >= list.length) return none('unchanged')
      const moved = list[i]
      list[i] = list[j]
      list[j] = moved
      return done('moved')
    }
    default: {
      const missing = SHIPPED_PROMPTS.map((s) => SHIPPED_PROMPT_KEY[s]).filter((id) => at(id) < 0)
      if (missing.length === 0) return none('unchanged')
      const room = Math.max(0, PROMPTS_MAX - list.length)
      if (room === 0) return none('full')
      const back = missing.slice(0, room)
      for (const id of back) list.push({ id })
      return done('restored', back.length)
    }
  }
}
