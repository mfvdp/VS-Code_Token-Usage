// SPDX-FileCopyrightText: 2026 Frederik Marx
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The agent hook's script (1.6 O4, spec §0a.13) — bundled to `dist/agent-hook.js`, copied into the
 * extension's globalStorage by *Set Up the Agent Hook…*, and run by Claude Code, never by the
 * extension. Claude Code starts it for every hook event the user put into its settings — the setup
 * document names `SubagentStart`, `SubagentStop`, `Notification` and `PermissionRequest` — with the
 * event's JSON on stdin; the script appends one line to the mirror file it is given and exits.
 *
 * Built on Node's `fs` and `path` alone: no network module, no child process, no worker — a check
 * of `scripts/check-privacy.mjs` holds the bundle to that. Four rules outrank everything else here:
 *  • It reads four keys of its input and nothing else: `hook_event_name`, `session_id`, `agent_id`
 *    and `notification_type` — never `message`, `tool_input`, `tool_response`, `prompt`,
 *    `transcript_path`, `cwd`, `last_assistant_message` or any other. The line it writes holds six
 *    fields, each checked against its allow-list: `v`, `ts`, `event`, `sessionId`, `agentId`, `wait`.
 *  • It writes one file only: the path it is given, and only when that path's last part is
 *    `agent-hook.jsonl` and it has no `..` part. It creates no directory.
 *  • It must never get in Claude Code's way: whatever happens it exits with code 0 and prints
 *    nothing — a hook that prints on a permission request could be read as a decision, and one that
 *    fails is an error line in the session.
 *  • It never logs its input.
 */

import * as fs from 'fs'
import * as path from 'path'

/** The only file name the script writes to: the mirror in the extension's globalStorage. */
export const HOOK_MIRROR_NAME = 'agent-hook.jsonl'
/** The script's own name there, beside the mirror. */
export const HOOK_SCRIPT_NAME = 'agent-hook.js'
/** The most of stdin the script reads; a longer input is dropped whole, and nothing is written. */
export const HOOK_STDIN_MAX_BYTES = 1024 * 1024
/** Over this size the mirror file is cut down to its newest HOOK_KEEP_LINES lines. */
export const HOOK_ROTATE_BYTES = 256 * 1024
/** The lines a cut keeps — the newest. */
export const HOOK_KEEP_LINES = 1000
/**
 * How long the script waits for its input before it gives up and exits: Claude Code closes stdin
 * right after writing it, so this is only ever reached by a pipe that never ends.
 */
export const HOOK_STDIN_WAIT_MS = 5000
/** The literal `v` of every mirror line. */
export const HOOK_LINE_VERSION = 1

/** The events the setup document installs, and the mirror line's `event` (§0a.13). Anything else is dropped. */
export const HOOK_EVENTS = ['SubagentStart', 'SubagentStop', 'Notification', 'PermissionRequest'] as const
export type HookEventName = typeof HOOK_EVENTS[number]
/** What a line says the agent or the session waits for (§0a.13). */
export const HOOK_WAITS = ['none', 'permission', 'input'] as const
export type HookWaitName = typeof HOOK_WAITS[number]

/**
 * The `notification_type` values Claude Code documents (hooks reference, read 2026-09-23), and what
 * each says about a wait: a permission dialog; a question, an idle prompt or a form waiting for the
 * user; anything else — a login that went through, an agent that finished, the quota's automatic
 * resume — clears it. A value outside the list drops the whole line.
 */
export const NOTIFICATION_WAITS: Readonly<Record<string, HookWaitName>> = {
  permission_prompt: 'permission',
  idle_prompt: 'input',
  agent_needs_input: 'input',
  elicitation_dialog: 'input',
  elicitation_url_dialog: 'input',
  auth_success: 'none',
  elicitation_complete: 'none',
  elicitation_response: 'none',
  agent_completed: 'none',
  quota_auto_resume_fired: 'none',
  quota_auto_resume_stale: 'none',
  quota_auto_resume_disabled: 'none',
}

/**
 * The id alphabet and cap of the aggregator's `cleanAgentId` — at most 64 characters of
 * `[A-Za-z0-9_-]` — repeated here rather than imported, so the script carries nothing of the
 * extension but itself; a test holds the two to the same answers. Claude Code's session ids are
 * UUIDs, its agent ids `a` and 16 hex characters: both fit.
 */
const HOOK_ID_RE = /^[A-Za-z0-9_-]{1,64}$/

/** An id through the alphabet, or null. */
export function hookId(v: unknown): string | null {
  return typeof v === 'string' && HOOK_ID_RE.test(v) ? v : null
}

/** One line of the mirror file: the six fields, nothing else. */
export interface MirrorLine {
  v: typeof HOOK_LINE_VERSION
  ts: number
  event: HookEventName
  sessionId: string
  agentId: string | null
  wait: HookWaitName
}

/**
 * The mirror line for one hook call, or null when the call is not one to record — an event
 * outside HOOK_EVENTS, a session id outside the id alphabet, an `agent_id` that is there but no
 * id, a notification of a type outside NOTIFICATION_WAITS. Four keys of the input are read and no
 * other; a value too long for its field drops the line rather than being cut into an id nobody
 * wrote. `PermissionRequest` is a wait for approval whatever tool asked; `SubagentStart` and
 * `SubagentStop` record no wait, so a stop clears the agent's.
 */
export function hookLineOf(input: unknown, now: number): MirrorLine | null {
  if (!input || typeof input !== 'object' || Array.isArray(input) || !Number.isFinite(now) || now <= 0) return null
  const j = input as Record<string, unknown>
  const event = j.hook_event_name
  if (typeof event !== 'string' || !(HOOK_EVENTS as readonly string[]).includes(event)) return null
  const sessionId = hookId(j.session_id)
  if (sessionId === null) return null
  // Absent inside the session itself; there but not an id → not a line to attach anywhere.
  const rawAgent = j.agent_id
  const agentId = rawAgent === undefined || rawAgent === null ? null : hookId(rawAgent)
  if (agentId === null && rawAgent !== undefined && rawAgent !== null) return null
  let wait: HookWaitName = 'none'
  if (event === 'PermissionRequest') wait = 'permission'
  else if (event === 'Notification') {
    const kind = j.notification_type
    if (typeof kind !== 'string' || !Object.prototype.hasOwnProperty.call(NOTIFICATION_WAITS, kind)) return null
    wait = NOTIFICATION_WAITS[kind]
  }
  return { v: HOOK_LINE_VERSION, ts: Math.floor(now), event: event as HookEventName, sessionId, agentId, wait }
}

/**
 * The mirror file the script may write, from its first argument: an absolute path whose last part
 * is `agent-hook.jsonl` and none of whose parts is `..` — either separator counts as one, so a
 * Windows path cannot slip a `..` past the check. Anything else is null, and the script writes
 * nothing: a bare file name would be written into the directory Claude Code runs in, the
 * project's.
 */
export function acceptedMirrorPath(arg: unknown): string | null {
  if (typeof arg !== 'string' || arg.length === 0 || arg.length > 4096 || arg.includes('\u0000')) return null
  if (arg.split(/[\\/]+/).some((part) => part === '..')) return null
  if (!path.isAbsolute(arg) || path.basename(arg) !== HOOK_MIRROR_NAME) return null
  return path.normalize(arg)
}

/** The file operations the script uses, injected so a test can watch every one of them. */
export interface HookFs {
  openSync(file: string, flags: number, mode?: number): number
  writeSync(fd: number, text: string): number
  fstatSync(fd: number): { size: number; isFile(): boolean }
  closeSync(fd: number): void
  readSync(fd: number, buf: Buffer, offset: number, length: number, position: number): number
  writeFileSync(file: string, text: string, options: { mode: number; flag: string }): void
  renameSync(from: string, to: string): void
  unlinkSync(file: string): void
}

/** `O_NOFOLLOW` where the platform has one: the mirror is never written through a link. */
function noFollow(): number {
  const c = fs.constants as Record<string, number | undefined>
  return typeof c.O_NOFOLLOW === 'number' ? c.O_NOFOLLOW : 0
}

/**
 * Appends one line to the mirror with `O_APPEND` — two hooks writing at the same moment each land
 * a whole line — creating the file (mode 0600) but never its directory. Over HOOK_ROTATE_BYTES
 * afterwards, the file is rewritten to its newest HOOK_KEEP_LINES lines through a temporary file
 * in the same directory and a rename, so a reader never sees half a file; a line another hook
 * appends between the read and the rename is lost, which a marker that the next call renews can
 * afford. Throws on any failure — the caller swallows it.
 */
export function appendMirrorLine(file: string, line: string, io: HookFs = fs as unknown as HookFs): void {
  const flags = fs.constants.O_WRONLY | fs.constants.O_APPEND | fs.constants.O_CREAT | noFollow()
  const fd = io.openSync(file, flags, 0o600)
  let size = 0
  try {
    const st = io.fstatSync(fd)
    // A directory, a device or a pipe of that name is not the mirror.
    if (!st.isFile()) return
    io.writeSync(fd, `${line}\n`)
    size = io.fstatSync(fd).size
  } finally {
    io.closeSync(fd)
  }
  if (size > HOOK_ROTATE_BYTES) rotateMirror(file, io)
}

/** The newest HOOK_KEEP_LINES whole lines of the mirror, rewritten in place of it (see appendMirrorLine). */
function rotateMirror(file: string, io: HookFs): void {
  const fd = io.openSync(file, fs.constants.O_RDONLY | noFollow())
  let text: string
  try {
    const size = io.fstatSync(fd).size
    // The newest lines are at most HOOK_KEEP_LINES short lines; twice the rotation size holds them
    // with room to spare, however large the file grew while something else wrote to it.
    const want = Math.min(size, 2 * HOOK_ROTATE_BYTES)
    const buf = Buffer.alloc(want)
    let got = 0
    while (got < want) {
      const n = io.readSync(fd, buf, got, want - got, size - want + got)
      if (n <= 0) break
      got += n
    }
    text = buf.subarray(0, got).toString('utf8')
    // Read from the middle of the file: the first line is a part of one.
    if (want < size) text = text.slice(text.indexOf('\n') + 1)
  } finally {
    io.closeSync(fd)
  }
  const lines = text.split('\n').filter((l) => l.length > 0)
  const kept = lines.slice(-HOOK_KEEP_LINES).join('\n') + '\n'
  const tmp = `${file}.${process.pid}.tmp`
  try {
    io.writeFileSync(tmp, kept, { mode: 0o600, flag: 'w' })
    io.renameSync(tmp, file)
  } catch (err) {
    try { io.unlinkSync(tmp) } catch { /* never written */ }
    throw err
  }
}

/**
 * One hook call: argv is `process.argv` — [node, script, mirrorFile] —, `stdin` what Claude Code
 * piped in, `now` the moment. Writes at most one line and returns 0 whatever happened; a path that
 * is not the mirror's, an input over HOOK_STDIN_MAX_BYTES, one that is no JSON, or a call not to
 * record writes nothing.
 */
export function hookMain(argv: readonly string[], stdin: Buffer | null, now: number, io?: HookFs): number {
  try {
    const file = acceptedMirrorPath(argv[2])
    if (file === null || stdin === null || stdin.length === 0 || stdin.length > HOOK_STDIN_MAX_BYTES) return 0
    let input: unknown
    try {
      input = JSON.parse(stdin.toString('utf8'))
    } catch {
      return 0
    }
    const line = hookLineOf(input, now)
    if (line === null) return 0
    appendMirrorLine(file, JSON.stringify(line), io)
  } catch {
    // A full disk or a storage directory that is gone is no reason to disturb Claude Code.
  }
  return 0
}

/* c8 ignore start — the process wiring is exercised by running the built script itself */

/**
 * The input, at most HOOK_STDIN_MAX_BYTES of it — null once it grew past that, so nothing of an
 * input too large is ever parsed —, or what arrived when the stream ends, fails or does not end in
 * HOOK_STDIN_WAIT_MS.
 */
function readStdin(): Promise<Buffer | null> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = []
    let size = 0
    let done = false
    const finish = (v: Buffer | null): void => {
      if (done) return
      done = true
      resolve(v)
    }
    const stream = process.stdin
    if (stream.isTTY) {
      finish(null)
      return
    }
    const timer = setTimeout(() => finish(null), HOOK_STDIN_WAIT_MS)
    timer.unref()
    stream.on('data', (c: Buffer) => {
      if (done) return
      size += c.length
      if (size > HOOK_STDIN_MAX_BYTES) {
        chunks.length = 0
        finish(null)
        stream.pause()
        return
      }
      chunks.push(c)
    })
    stream.on('end', () => finish(Buffer.concat(chunks)))
    stream.on('error', () => finish(null))
  })
}

/**
 * True only when this file is run as the hook script: the main module, and a file named
 * `agent-hook.js` — not the extension, a test bundle or any other bundle that imports these
 * functions and happens to be the main module of its own process (see the looser guard in
 * statuslineBridge.ts).
 */
function isCliInvocation(): boolean {
  if (typeof require === 'undefined' || typeof module === 'undefined' || require.main !== module) return false
  return path.basename(String(process.argv[1] ?? '')) === HOOK_SCRIPT_NAME
}

if (isCliInvocation()) {
  readStdin()
    .then((buf) => { process.exitCode = hookMain(process.argv, buf, Date.now()) })
    .catch(() => { process.exitCode = 0 })
    // Claude Code waits for the process to end; a stdin left open must not keep it waiting.
    .finally(() => { process.exitCode = 0; process.exit(0) })
}

/* c8 ignore stop */
