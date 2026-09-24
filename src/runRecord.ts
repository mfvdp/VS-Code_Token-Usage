// SPDX-FileCopyrightText: 2026 Frederik Marx
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Claude Code's run record (1.6 L4, spec §0a.12): `<projects>/<slug>/<sessionId>/workflows/<runId>.json`,
 * the file Claude Code keeps of every workflow run beside the run's directory under `subagents/`.
 *
 * Of it seven top-level fields are read — `status`, `startTime`, `durationMs`, `agentCount`,
 * `totalTokens`, `totalToolCalls` and `defaultModel` — and nothing else. The rest of the file is the
 * run's content: its `script`, its `logs`, its `phases` and `workflowProgress`, its `result`, its
 * `summary`, its `args`, an `error`. A record is up to a few megabytes (observed: 60 KB at the median,
 * 2.39 MB at most) and not pretty-printed, and the seven fields lie beyond its first 64 KB in most
 * of them, so it is not parsed: a **streaming key-picker** walks its bytes in 64 KB chunks through a
 * state machine that knows only where a string, an object and an array start and end. At the top
 * level of the object it decodes a key only while the key is at most RUN_RECORD_SCALAR_MAX bytes,
 * and a value only when its key is one of the seven and the value is a scalar of at most as many
 * bytes. Every other byte is stepped over: no other key, no other value — a script, a log line, a
 * result — ever becomes a JavaScript string. A key given twice counts as the last one given, as
 * `JSON.parse` would have it; a file that ends before its top-level object closes is no record — one
 * being written is read again at its next change.
 *
 * The file is opened like the sidecars: `lstat` first, never through a link (`O_NOFOLLOW` where the
 * platform has it), a regular file of at most RUN_RECORD_MAX_BYTES — a larger one is read as absent.
 * Which file, and whether it lies below a configured Claude root, `scan.ts` decides (`runRecordFile`).
 * The format is undocumented: every field that is missing or of another shape is none, `–`.
 */

import * as fs from 'fs'
import { RunRecordFields, RunRecordStat, RunRecordStatus } from './types'

/** A run record larger than this is read as absent. The largest on the measuring machine was 2.39 MB. */
export const RUN_RECORD_MAX_BYTES = 4 * 1024 * 1024
/** The picker reads a record in chunks of this size. */
export const RUN_RECORD_CHUNK_BYTES = 64 * 1024
/** A top-level key, and a value of one of the seven, is decoded only up to this many bytes; a longer one never is. */
export const RUN_RECORD_SCALAR_MAX = 64

/** The seven top-level fields of a run record that are read; no other key's value is ever decoded. */
export const RUN_RECORD_KEYS = ['status', 'startTime', 'durationMs', 'agentCount', 'totalTokens', 'totalToolCalls', 'defaultModel'] as const
type RunRecordKey = (typeof RUN_RECORD_KEYS)[number]
const WANTED: ReadonlySet<string> = new Set<string>(RUN_RECORD_KEYS)

/** The words a record's `status` may be (observed: completed 104, killed 3); any other is none. */
export const RUN_RECORD_STATUSES: readonly RunRecordStatus[] = ['completed', 'failed', 'killed', 'stopped', 'cancelled', 'running']
/** The status words that end a run; `running` is none. */
const ENDS: ReadonlySet<string> = new Set(['completed', 'failed', 'killed', 'stopped', 'cancelled'])
/** A model id, with an optional bracketed suffix Claude Code adds (`claude-fable-5-1[1m]`). */
const DEFAULT_MODEL_RE = /^[A-Za-z0-9_.:@/-]{1,64}(\[[0-9a-z]{1,8}\])?$/

function positive(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null
}

function nonNegative(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null
}

function whole(v: unknown): number | null {
  return typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : null
}

/**
 * The seven fields, each through its allow-list: a status word of the six, a start time in ms since
 * the epoch, a duration, a token figure and two whole counts of at least 0, a model id. Anything else
 * — a string where a number belongs, a negative count, NaN, an object — is none. Null when none of
 * the seven is usable. Used on what the picker decoded, on a snapshot's copy, and by the tree.
 */
export function cleanRunRecord(v: unknown): RunRecordFields | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null
  const o = v as Record<string, unknown>
  const status = typeof o.status === 'string' && (RUN_RECORD_STATUSES as readonly string[]).includes(o.status)
    ? o.status as RunRecordStatus : null
  const model = o.defaultModel
  const fields: RunRecordFields = {
    status,
    startTime: positive(o.startTime),
    durationMs: nonNegative(o.durationMs),
    agentCount: whole(o.agentCount),
    totalTokens: nonNegative(o.totalTokens),
    totalToolCalls: whole(o.totalToolCalls),
    defaultModel: typeof model === 'string' && model.length <= RUN_RECORD_SCALAR_MAX && DEFAULT_MODEL_RE.test(model) ? model : null,
  }
  return Object.values(fields).every((x) => x === null) ? null : fields
}

/** A size and a modification time, both finite and at least 0; null otherwise. */
export function cleanRunRecordStat(v: unknown): RunRecordStat | null {
  if (!v || typeof v !== 'object') return null
  const s = v as Record<string, unknown>
  const size = whole(s.size)
  const mtimeMs = nonNegative(s.mtimeMs)
  return size === null || mtimeMs === null ? null : { size, mtimeMs }
}

/** Whether a record states that its run ended — `running` does not. */
export function runRecordEnded(r: RunRecordFields | null | undefined): boolean {
  return !!r && typeof r.status === 'string' && ENDS.has(r.status)
}

// ---------------------------------------------------------------------------
// The streaming key-picker
// ---------------------------------------------------------------------------

const QUOTE = 0x22
const BACKSLASH = 0x5c
const LBRACE = 0x7b
const RBRACE = 0x7d
const LBRACKET = 0x5b
const RBRACKET = 0x5d
const COLON = 0x3a
const COMMA = 0x2c

function space(c: number): boolean {
  return c === 0x20 || c === 0x0a || c === 0x0d || c === 0x09
}

/** Where the picker stands at the top level of the object. */
const BEFORE = 0     // before the object's `{`
const FIRST_KEY = 1  // after `{`: a key, or `}` for an empty object
const KEY = 2        // after `,`: a key
const COLON_NEXT = 3 // after a key
const VALUE = 4      // after `:`
const COMMA_NEXT = 5 // after a value: `,` or `}`
const DONE = 6       // the object closed
const BAD = 7        // not a JSON object

/**
 * The key-picker: bytes in, in chunks of any size (`push`), the seven fields out once the top-level
 * object closed (`result`). It holds nothing of the file but the state it stands in and at most
 * RUN_RECORD_SCALAR_MAX bytes of the one key or value it is reading, in a buffer of that size — and
 * only that buffer is ever decoded, never a chunk.
 */
export class RunRecordPicker {
  private state = BEFORE
  /** 0 before the object, 1 inside it, more inside one of its values. */
  private depth = 0
  private inString = false
  private escaped = false
  /** A bare top-level value — a number, `true`, `false`, `null` — is being read. */
  private scalar = false
  /** Whether the bytes of the key or value being read are kept: a top-level key, or a value of one of the seven. */
  private keeping = false
  /** The one of the seven whose value comes next, or null. */
  private wanted: RunRecordKey | null = null
  private readonly buf = Buffer.alloc(RUN_RECORD_SCALAR_MAX)
  private len = 0
  /** The key or value being kept ran past RUN_RECORD_SCALAR_MAX bytes: it is never decoded. */
  private over = false
  /** The seven as decoded, the last one given of a key given twice; `undefined` for a value of no usable shape. */
  private readonly picked = new Map<RunRecordKey, unknown>()

  /** The object closed, or the bytes are no JSON object: nothing further changes the result. */
  get done(): boolean {
    return this.state === DONE || this.state === BAD
  }

  /** Reads one chunk; true once the picker needs no more. */
  push(chunk: Uint8Array): boolean {
    const n = chunk.length
    let i = 0
    while (i < n && !this.done) {
      if (this.inString && !this.keeping && !this.escaped) {
        // Inside a string nobody reads — a script, a log line: straight to its next quote or backslash.
        while (i < n && chunk[i] !== QUOTE && chunk[i] !== BACKSLASH) i++
        if (i >= n) break
      }
      this.step(chunk[i++])
    }
    return this.done
  }

  /** The seven fields once the object closed; null for a file that ended before it did, or no object at all. */
  result(): RunRecordFields | null {
    if (this.state !== DONE) return null
    return cleanRunRecord(Object.fromEntries(this.picked))
  }

  private step(c: number): void {
    if (this.inString) {
      if (this.escaped) {
        this.escaped = false
        this.keep(c)
      } else if (c === BACKSLASH) {
        this.escaped = true
        this.keep(c)
      } else if (c === QUOTE) {
        this.inString = false
        this.endString()
      } else {
        this.keep(c)
      }
      return
    }
    if (this.depth > 1) {
      // Inside a value of the object: only where it ends matters.
      if (c === QUOTE) this.begin(false)
      else if (c === LBRACE || c === LBRACKET) this.depth++
      else if ((c === RBRACE || c === RBRACKET) && --this.depth === 1) this.endValue(undefined)
      return
    }
    if (this.depth === 0) {
      if (space(c)) return
      if (c === LBRACE) {
        this.depth = 1
        this.state = FIRST_KEY
      } else {
        this.state = BAD
      }
      return
    }
    if (this.scalar) {
      if (c !== COMMA && c !== RBRACE && !space(c)) {
        this.keep(c)
        return
      }
      this.scalar = false
      this.endValue(this.decode(false))
    }
    if (space(c)) return
    switch (this.state) {
      case FIRST_KEY:
      case KEY:
        if (c === QUOTE) this.begin(true)
        else this.state = c === RBRACE && this.state === FIRST_KEY ? DONE : BAD
        return
      case COLON_NEXT:
        this.state = c === COLON ? VALUE : BAD
        return
      case VALUE:
        if (c === QUOTE) this.begin(this.wanted !== null)
        else if (c === LBRACE || c === LBRACKET) this.depth = 2
        else if (c === COMMA || c === RBRACE || c === RBRACKET || c === COLON) this.state = BAD
        else {
          this.scalar = true
          this.start(this.wanted !== null)
          this.keep(c)
        }
        return
      case COMMA_NEXT:
        this.state = c === COMMA ? KEY : c === RBRACE ? DONE : BAD
        return
      default:
        this.state = BAD
    }
  }

  private start(keeping: boolean): void {
    this.keeping = keeping
    this.len = 0
    this.over = false
  }

  /** A string starts; its bytes are kept when it is a top-level key or a wanted value. */
  private begin(keeping: boolean): void {
    this.inString = true
    this.start(keeping)
  }

  private keep(c: number): void {
    if (!this.keeping) return
    if (this.len < RUN_RECORD_SCALAR_MAX) this.buf[this.len++] = c
    else this.over = true
  }

  /** The kept bytes as the JSON value they spell — a string's content in quotes — or undefined. */
  private decode(quoted: boolean): unknown {
    if (!this.keeping || this.over) return undefined
    const text = this.buf.toString('utf8', 0, this.len)
    try {
      return JSON.parse(quoted ? `"${text}"` : text)
    } catch {
      return undefined
    }
  }

  /** A string closed: a top-level key names the value that follows, a top-level value ends; a nested one changes nothing. */
  private endString(): void {
    if (this.depth > 1) return
    const text = this.decode(true)
    this.keeping = false
    if (this.state === FIRST_KEY || this.state === KEY) {
      this.wanted = typeof text === 'string' && WANTED.has(text) ? text as RunRecordKey : null
      this.state = COLON_NEXT
      return
    }
    this.endValue(text)
  }

  private endValue(value: unknown): void {
    if (this.wanted !== null) this.picked.set(this.wanted, value)
    this.wanted = null
    this.keeping = false
    this.state = COMMA_NEXT
  }
}

/** The seven fields of a record held in memory, fed to the picker a chunk at a time as a file read would. */
export function pickRunRecord(bytes: Uint8Array): RunRecordFields | null {
  const picker = new RunRecordPicker()
  for (let at = 0; at < bytes.length && !picker.done; at += RUN_RECORD_CHUNK_BYTES) {
    picker.push(bytes.subarray(at, Math.min(bytes.length, at + RUN_RECORD_CHUNK_BYTES)))
  }
  return picker.result()
}

// ---------------------------------------------------------------------------
// The file
// ---------------------------------------------------------------------------

/** Opening without following a link, where the platform can refuse one (not on Windows). */
const NO_FOLLOW = fs.constants.O_NOFOLLOW ?? 0

/** What a read of a record file gave: its seven fields (null: none usable, or too large) and its size and time. */
export interface RunRecordRead {
  fields: RunRecordFields | null
  stat: RunRecordStat
}

/**
 * Reads a run record: null when there is no regular file (none, a link, a directory), `unchanged`
 * when its size and modification time are the ones `known` holds — then it is not opened at all —,
 * else what the picker found, with the file's size and time. A file larger than
 * RUN_RECORD_MAX_BYTES is not read: its fields are none. Asked again of the handle that is read, as
 * the file can change between the check and the open. No byte of it is logged.
 */
export async function readRunRecord(file: string, known: RunRecordStat | null = null): Promise<RunRecordRead | 'unchanged' | null> {
  let entry: fs.Stats
  try {
    entry = await fs.promises.lstat(file)
  } catch {
    return null
  }
  if (!entry.isFile()) return null
  if (known !== null && entry.size === known.size && entry.mtimeMs === known.mtimeMs) return 'unchanged'
  if (entry.size > RUN_RECORD_MAX_BYTES) return { fields: null, stat: { size: entry.size, mtimeMs: entry.mtimeMs } }
  let fh: fs.promises.FileHandle
  try {
    fh = await fs.promises.open(file, fs.constants.O_RDONLY | NO_FOLLOW)
  } catch {
    return null
  }
  try {
    const st = await fh.stat()
    if (!st.isFile()) return null
    const stat: RunRecordStat = { size: st.size, mtimeMs: st.mtimeMs }
    if (st.size > RUN_RECORD_MAX_BYTES) return { fields: null, stat }
    const picker = new RunRecordPicker()
    const chunk = Buffer.alloc(Math.max(1, Math.min(RUN_RECORD_CHUNK_BYTES, st.size)))
    let pos = 0
    while (pos < st.size && !picker.done) {
      const { bytesRead } = await fh.read(chunk, 0, Math.min(chunk.length, st.size - pos), pos)
      if (bytesRead <= 0) break
      picker.push(chunk.subarray(0, bytesRead))
      pos += bytesRead
    }
    return { fields: picker.result(), stat }
  } catch {
    return null
  } finally {
    await fh.close()
  }
}
