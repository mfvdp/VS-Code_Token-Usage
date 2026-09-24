// SPDX-FileCopyrightText: 2026 Frederik Marx
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The extension's side of the opt-in agent hook (1.6 O4, spec §0a.13): the reader of the mirror
 * file the hook script writes, the copy of the script into globalStorage, and the setup document
 * that tells the user what to add to Claude Code's settings — the extension never writes those
 * settings, and never runs the script.
 *
 * The mirror is `<globalStorage>/agent-hook.jsonl`, one JSON line per hook call with six fields.
 * The reader takes at most the last HOOK_TAIL_BYTES of it, a line of at most HOOK_LINE_MAX_BYTES,
 * and checks every one of the six again, as the script did — a line that fails any check, or holds
 * any other key, counts as none. Of what is left, the latest line per (session, agent) is the one
 * the tree reads, while it is younger than HOOK_MAX_AGE_MS. Nothing of it is stored: the file is
 * read again when it changes.
 *
 * No vscode import: the command and the document provider live in extension.ts.
 */

import * as fs from 'fs'
import * as path from 'path'
import { cleanAgentId } from './agg'
import { HOOK_MAX_AGE_MS, HookEntry, HookEvent, HookWait, hookKey } from './agentTree'
import {
  HOOK_EVENTS, HOOK_KEEP_LINES, HOOK_LINE_VERSION, HOOK_MIRROR_NAME, HOOK_ROTATE_BYTES, HOOK_SCRIPT_NAME,
  HOOK_WAITS,
} from './agentHookScript'
import { t } from './i18n'

export { HOOK_MIRROR_NAME, HOOK_SCRIPT_NAME }

/** The most of the mirror file one read takes: its end, where the newest lines are. */
export const HOOK_TAIL_BYTES = 256 * 1024
/** The longest line the reader parses; the script's are well under 300 bytes. */
export const HOOK_LINE_MAX_BYTES = 1024
/**
 * How far ahead of the reader's clock a line may be and still count — the script and the extension
 * read the same machine's clock, so anything further ahead is not a line the script wrote.
 */
export const HOOK_FUTURE_MS = 60_000

/** Which waits each event may carry: a line that pairs them otherwise was not written by the script. */
const WAITS_OF: Readonly<Record<HookEvent, readonly HookWait[]>> = {
  SubagentStart: ['none'],
  SubagentStop: ['none'],
  PermissionRequest: ['permission'],
  Notification: ['none', 'permission', 'input'],
}

/**
 * One mirror line through the six allow-lists of §0a.13, or null: an object of exactly six keys, `v`
 * the literal 1, `ts` a whole number of ms that is neither older than HOOK_MAX_AGE_MS nor more than
 * HOOK_FUTURE_MS ahead of `now`, `event` one of the four events, `sessionId` an id and `agentId` an
 * id or null (the aggregator's own `cleanAgentId`), `wait` one of three and one its event can carry.
 */
export function cleanHookLine(raw: string, now: number): HookEntry | null {
  if (typeof raw !== 'string' || raw.length === 0 || Buffer.byteLength(raw, 'utf8') > HOOK_LINE_MAX_BYTES) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
  const o = parsed as Record<string, unknown>
  // Only the script's lines: six keys, nothing beside them.
  if (Object.keys(o).length !== 6) return null
  if (o.v !== HOOK_LINE_VERSION) return null
  const ts = o.ts
  if (typeof ts !== 'number' || !Number.isInteger(ts) || ts <= 0) return null
  if (now - ts > HOOK_MAX_AGE_MS || ts - now > HOOK_FUTURE_MS) return null
  const event = o.event
  if (typeof event !== 'string' || !(HOOK_EVENTS as readonly string[]).includes(event)) return null
  const sessionId = cleanAgentId(o.sessionId)
  if (sessionId === null) return null
  const agent = o.agentId
  const agentId = agent === null ? null : cleanAgentId(agent)
  if (agent !== null && agentId === null) return null
  const wait = o.wait
  if (typeof wait !== 'string' || !(HOOK_WAITS as readonly string[]).includes(wait)) return null
  if (!WAITS_OF[event as HookEvent].includes(wait as HookWait)) return null
  return { ts, event: event as HookEvent, sessionId, agentId, wait: wait as HookWait }
}

/**
 * The entries of a mirror's text, by `hookKey`: every line through `cleanHookLine`, the latest per
 * (session, agent) kept — the later line of two with the same time. What the tree reads.
 */
export function parseHookMirror(text: string, now: number): Map<string, HookEntry> {
  const out = new Map<string, HookEntry>()
  for (const line of text.split('\n')) {
    const e = cleanHookLine(line.endsWith('\r') ? line.slice(0, -1) : line, now)
    if (e === null) continue
    const key = hookKey(e.sessionId, e.agentId)
    const prev = out.get(key)
    if (!prev || e.ts >= prev.ts) out.set(key, e)
  }
  return out
}

/** What one read of the mirror saw of the file: enough to tell a changed file from the same one. */
export interface HookStat { size: number; mtimeMs: number; ino: number }

/**
 * The last HOOK_TAIL_BYTES of the mirror — a regular file, never through a link — as text, whole
 * lines only; null when there is no such file or it cannot be read.
 */
export function readHookTail(file: string): { text: string; stat: HookStat } | null {
  let fd: number | null = null
  try {
    const c = fs.constants as Record<string, number | undefined>
    fd = fs.openSync(file, fs.constants.O_RDONLY | (typeof c.O_NOFOLLOW === 'number' ? c.O_NOFOLLOW : 0))
    const st = fs.fstatSync(fd)
    if (!st.isFile()) return null
    const want = Math.min(st.size, HOOK_TAIL_BYTES)
    const buf = Buffer.alloc(want)
    let got = 0
    while (got < want) {
      const n = fs.readSync(fd, buf, got, want - got, st.size - want + got)
      if (n <= 0) break
      got += n
    }
    let text = buf.subarray(0, got).toString('utf8')
    // Read from the middle: the first line is a part of one, and not a line to trust.
    if (want < st.size) text = text.slice(text.indexOf('\n') + 1)
    return { text, stat: { size: st.size, mtimeMs: st.mtimeMs, ino: st.ino } }
  } catch {
    return null
  } finally {
    if (fd !== null) {
      try { fs.closeSync(fd) } catch { /* already closed */ }
    }
  }
}

/**
 * The mirror as the host keeps it: the entries of its last read, and the file's size, time and
 * inode then, so `refresh` reads it again only when one of them changed — a watcher event and the
 * agent poll's pass cost one `lstat` otherwise. A missing file is no entry at all.
 */
export class HookMirror {
  private stat: HookStat | null = null
  private map: Map<string, HookEntry> = new Map()

  constructor(readonly file: string) {}

  /** The entries of the last read, by `hookKey`. */
  entries(): ReadonlyMap<string, HookEntry> {
    return this.map
  }

  /** Reads the file again when it changed; true when the entries may differ from the last ones. */
  refresh(now: number): boolean {
    let st: fs.Stats
    try {
      st = fs.lstatSync(this.file)
    } catch {
      return this.clear()
    }
    if (!st.isFile()) return this.clear()
    const same = this.stat !== null && this.stat.size === st.size && this.stat.mtimeMs === st.mtimeMs && this.stat.ino === st.ino
    if (same) return false
    const read = readHookTail(this.file)
    if (read === null) return this.clear()
    this.stat = read.stat
    this.map = parseHookMirror(read.text, now)
    return true
  }

  /** Forgets every entry; true when there were any, or a file was read before. */
  clear(): boolean {
    const had = this.stat !== null || this.map.size > 0
    this.stat = null
    this.map = new Map()
    return had
  }
}

// ---------------------------------------------------------------------------
// The script's copy in globalStorage
// ---------------------------------------------------------------------------

/** The file operations the copy uses, injected so a test can see every write. */
export interface CopyFs {
  statSync(file: string): { size: number; mtimeMs: number; isFile(): boolean }
  copyFileSync(from: string, to: string): void
  renameSync(from: string, to: string): void
  unlinkSync(file: string): void
}

/**
 * Copies the shipped script (`dist/agent-hook.js`) to `<globalStorage>/agent-hook.js` through a
 * temporary file beside it and a rename, so Claude Code never starts half a script. The only writes
 * are inside `storage`; the directory itself is the extension's and exists. Returns the path of the
 * copy; throws when the bundle is missing or the copy failed.
 */
export function installHookScript(bundle: string, storage: string, io: CopyFs = fs): string {
  if (!io.statSync(bundle).isFile()) throw new Error('the hook script is not a file')
  const target = path.join(storage, HOOK_SCRIPT_NAME)
  const tmp = `${target}.${process.pid}.tmp`
  try {
    io.copyFileSync(bundle, tmp)
    io.renameSync(tmp, target)
  } catch (err) {
    try { io.unlinkSync(tmp) } catch { /* never written */ }
    throw err
  }
  return target
}

/**
 * At activation: the copy in globalStorage is replaced by the shipped script when it is there and
 * older than it — or of another size, a copy of another build —, so an update reaches a hook the
 * user installed before it. Nothing is written when there is no copy: only the setup command makes
 * one. True when it copied.
 */
export function refreshHookScript(bundle: string, storage: string, io: CopyFs = fs): boolean {
  const target = path.join(storage, HOOK_SCRIPT_NAME)
  let have: { size: number; mtimeMs: number; isFile(): boolean }
  let ship: { size: number; mtimeMs: number; isFile(): boolean }
  try {
    have = io.statSync(target)
    ship = io.statSync(bundle)
  } catch {
    return false
  }
  if (!have.isFile() || !ship.isFile()) return false
  if (have.mtimeMs >= ship.mtimeMs && have.size === ship.size) return false
  installHookScript(bundle, storage, io)
  return true
}

// ---------------------------------------------------------------------------
// The setup document
// ---------------------------------------------------------------------------

/**
 * One path as the shell Claude Code runs a hook command in reads it: in double quotes, since a
 * profile path may hold a space ("Application Support"). On Windows with forward slashes — Node
 * takes them, and the shell Claude Code uses there (Git Bash) would read a backslash before some
 * letters as an escape; elsewhere with the four characters a POSIX shell reads inside double quotes
 * escaped.
 */
export function shellPath(p: string, platform: NodeJS.Platform = process.platform): string {
  if (platform === 'win32') return `"${p.replace(/\\/g, '/')}"`
  return `"${p.replace(/(["\\$`])/g, '\\$1')}"`
}

/** The hook command: `node "<globalStorage>/agent-hook.js" "<globalStorage>/agent-hook.jsonl"`. */
export function hookCommand(storage: string, platform: NodeJS.Platform = process.platform): string {
  const join = platform === 'win32' ? path.win32.join : path.posix.join
  return `node ${shellPath(join(storage, HOOK_SCRIPT_NAME), platform)} ${shellPath(join(storage, HOOK_MIRROR_NAME), platform)}`
}

/**
 * The `hooks` block for `~/.claude/settings.json`: the command for each of the four events, no
 * matcher — every subagent, every notification type, every tool's permission request.
 */
export function hookSnippet(storage: string, platform: NodeJS.Platform = process.platform): string {
  const entry = [{ hooks: [{ type: 'command', command: hookCommand(storage, platform) }] }]
  const hooks: Record<string, unknown> = {}
  for (const event of HOOK_EVENTS) hooks[event] = entry
  return JSON.stringify({ hooks }, null, 2)
}

/**
 * The read-only document *Set Up the Agent Hook…* opens, in the editor's language: what the hook
 * does and does not read, what it needs (Node.js on the PATH, no fallback), the snippet with this
 * machine's paths, and how to take it out again. The extension writes nothing into `~/.claude`.
 */
export function hookSetupDocument(storage: string, platform: NodeJS.Platform = process.platform): string {
  const minutes = String(HOOK_MAX_AGE_MS / 60_000)
  const L: string[] = [
    `# ${t('Token Pace — the agent hook')}`,
    '',
    t('The Agents section can mark an agent that waits for your approval — a permission dialog Claude Code shows for one of its tool calls — or for your input. Its transcript does not say so; Claude Code\'s hooks do. This document gives you the hook to add to Claude Code\'s settings.'),
    '',
    t('Token Pace writes nothing into `~/.claude`: you add the hook yourself, and you remove it yourself.'),
    '',
    `## ${t('What it does')}`,
    '',
    t('For the four hook events below, Claude Code starts Token Pace\'s script with `node` and hands it the event as JSON. The script reads four fields of it — `hook_event_name`, `session_id`, `agent_id` and `notification_type` — and appends one line to `agent-hook.jsonl` in Token Pace\'s storage, with six fields: `v`, `ts`, `event`, `sessionId`, `agentId` and `wait`. Nothing else of the event is read: no message, no prompt, no tool input or result, no path.'),
    '',
    t('The script opens no network connection, starts no other program, prints nothing and always exits with 0: it never answers a permission request for you, and it never stops Claude Code. Over {0} KB the file is cut to its newest {1} lines.',
      String(HOOK_ROTATE_BYTES / 1024), String(HOOK_KEEP_LINES)),
    '',
    t('The Agents section reads the file whenever it changes. A permission request inside a subagent names the agent, and its row says ‘waiting for approval’; one without an agent marks the session\'s row. The marker goes when the agent writes its next reply, when it stops, or after {0} minutes. In Claude Code\'s auto mode no permission dialog is shown, so no wait is reported.', minutes),
    '',
    `## ${t('What it needs')}`,
    '',
    t('Node.js on the PATH Claude Code runs its hooks with: the command starts with `node`. Without Node.js the hook does not run, and there is no fallback.'),
    '',
    `## ${t('The snippet')}`,
    '',
    t('Add this to `~/.claude/settings.json`. If the file already has a `hooks` block, add the four events to it; each event takes a list, so a hook of your own stays beside this one.'),
    '',
    '```json',
    hookSnippet(storage, platform),
    '```',
    '',
    t('The first path is the script, which this command has just copied into Token Pace\'s storage; the second is the file it writes. The script accepts no other file.'),
    '',
    `## ${t('Removing it')}`,
    '',
    t('Delete the four entries from `hooks` in `~/.claude/settings.json`. The file then stops growing, and its lines stop counting after {0} minutes.', minutes),
    '',
    t('Remove the entries before you uninstall Token Pace: uninstalling deletes its storage, the script with it, and Claude Code would then report a failing hook command on every event.'),
    '',
  ]
  return L.join('\n')
}
