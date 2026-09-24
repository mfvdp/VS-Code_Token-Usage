// SPDX-FileCopyrightText: 2026 Frederik Marx
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The status-line bridge script — bundled to `dist/statusline-bridge.js` and
 * run by Claude Code, not by the extension host. No vscode import, no
 * dependencies, no network.
 *
 * Claude Code pipes a JSON document into its `statusLine.command` on every
 * refresh. That document is the only official, network-free source for the
 * quota percentages, the context window, the prompt cache and the running cost.
 * This script mirrors it into a file the extension reads and then either hands
 * the same bytes to the status-line command that was there before us, or prints
 * a minimal line of its own.
 *
 * Two rules outrank everything else here:
 *  • It must never break someone's status line. Every failure path still passes
 *    stdin through and exits 0.
 *  • It must never log the payload. The mirror file is written, nothing else.
 *
 * 1.8 (§7a Q11): the mirror holds only what the extension reads of the payload —
 * `MIRROR_KEEP`, the fields of `quota.ts`'s status-line reader and nothing else. The
 * session's name, its working directory, its transcript's path, the workspace and
 * everything else Claude Code pipes in never reach the file. 1.3 to 1.7 mirrored the
 * payload whole; the next write of this script replaces such a file.
 *
 * 1.8 (§7a Q16): Claude Code runs the copy of this script in the extension's storage,
 * `<globalStorage>/statusline-bridge.js` (`BRIDGE_SCRIPT_NAME`), not the file inside
 * the versioned extension folder — an update removes that folder (bridge.ts).
 */

import { spawn as nodeSpawn } from 'child_process'
import * as fs from 'fs'
import * as path from 'path'

/** Schema of the mirror file; `quota.ts` refuses anything else. */
export const MIRROR_SCHEMA_VERSION = 1

/**
 * 1.8 §7a Q16: the file name of the script — of the bundle (`dist/statusline-bridge.js`) and of
 * its copy in globalStorage, which the installed `statusLine.command` names.
 */
export const BRIDGE_SCRIPT_NAME = 'statusline-bridge.js'

/**
 * What one key of the payload may hold in the mirror: `'value'` a string, a finite number, a
 * boolean or null — never an object or an array —; a map an object, narrowed to its keys the
 * same way; a list the first of its alternatives that the value fits.
 */
export type MirrorKeep = 'value' | { readonly [key: string]: MirrorKeep } | readonly MirrorKeep[]

const V = 'value' as const
/** `statuslineWindow` (quota.ts): a rate-limit window's share and its reset. */
const KEEP_WINDOW = { used_percentage: V, usedPercentage: V, utilization: V, resets_at: V, resetsAt: V }
/** The spend limit's share. */
const KEEP_SPEND = { used_percentage: V, usedPercentage: V }
const KEEP_RATE_LIMITS = {
  five_hour: KEEP_WINDOW, fiveHour: KEEP_WINDOW, seven_day: KEEP_WINDOW, sevenDay: KEEP_WINDOW,
  spend_limit: KEEP_SPEND, spendLimit: KEEP_SPEND,
}
const KEEP_CONTEXT = {
  total_input_tokens: V, totalInputTokens: V, total_output_tokens: V, totalOutputTokens: V,
  context_window_size: V, contextWindowSize: V, used_percentage: V, usedPercentage: V,
}
/** `promptCacheOf` (quota.ts), with 1.8's `recache_tokens_if_cold`. */
const KEEP_PROMPT_CACHE = {
  warm: V, ttl: V, expires_at: V, expiresAt: V, hit_ratio: V, hitRatio: V,
  recache_tokens_if_cold: V, recacheTokensIfCold: V,
}
/** `planLabel` (quota.ts): a plan is a name, or an object holding one. */
const KEEP_PLAN: readonly MirrorKeep[] = [V, { name: V, display_name: V, displayName: V, type: V }]

/**
 * 1.8 §7a Q11: every key the mirror keeps, in both spellings the reader takes — exactly the
 * fields `quota.ts` reads of the payload (`claudeStateFromStatusline` and the helpers it calls),
 * which the read contract of scripts/check-privacy.mjs lists and test/privacy.test.ts ties to
 * this table. Anything else of the payload is dropped before the file is written.
 */
export const MIRROR_KEEP: { readonly [key: string]: MirrorKeep } = {
  session_id: V, sessionId: V,
  model: { id: V, display_name: V, displayName: V },
  plan: KEEP_PLAN, subscription: KEEP_PLAN,
  rate_limits: KEEP_RATE_LIMITS, rateLimits: KEEP_RATE_LIMITS,
  context_window: KEEP_CONTEXT, contextWindow: KEEP_CONTEXT,
  cost: { total_cost_usd: V, totalCostUsd: V },
  prompt_cache: KEEP_PROMPT_CACHE, promptCache: KEEP_PROMPT_CACHE,
}

function isLeaf(v: unknown): boolean {
  return v === null || typeof v === 'string' || typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v))
}

/** One value as `keep` allows it, or undefined when it may not be kept at all. */
function narrowValue(v: unknown, keep: MirrorKeep): unknown {
  if (keep === 'value') return isLeaf(v) ? v : undefined
  if (Array.isArray(keep)) {
    for (const alt of keep) {
      const r = narrowValue(v, alt)
      if (r !== undefined) return r
    }
    return undefined
  }
  const o = obj(v)
  if (o === null) return undefined
  const out: Record<string, unknown> = {}
  for (const [k, sub] of Object.entries(keep as { readonly [key: string]: MirrorKeep })) {
    if (!Object.prototype.hasOwnProperty.call(o, k)) continue
    const r = narrowValue(o[k], sub)
    if (r !== undefined) out[k] = r
  }
  return out
}

/**
 * 1.8 §7a Q11: the payload as the mirror keeps it — the keys of `MIRROR_KEEP`, each narrowed to
 * what the reader takes of it; every other key, and every value of the wrong shape, left out. A
 * payload that is not an object yields an empty object. Pure.
 */
export function narrowPayload(payload: unknown): Record<string, unknown> {
  return (narrowValue(payload, MIRROR_KEEP) as Record<string, unknown> | undefined) ?? {}
}

export interface SpawnResult {
  code: number
  stdout: Buffer
  stderr: Buffer
}

/** The two effects the script has, injected so the logic can be tested. */
export interface BridgeIo {
  write(stream: 'stdout' | 'stderr', chunk: Buffer): void
  spawn(command: string, args: string[], stdin: Buffer): Promise<SpawnResult>
}

/**
 * Writes the mirror atomically: temp file in the same directory, then rename.
 * The temp name carries the pid because two Claude Code sessions can refresh
 * their status line at the same moment, and two writers sharing one temp file
 * would produce a spliced document that renames cleanly over the good one.
 */
export function writeMirror(file: string, payload: unknown, now: number): void {
  const dir = path.dirname(file)
  fs.mkdirSync(dir, { recursive: true })
  const tmp = `${file}.${process.pid}.tmp`
  const body = JSON.stringify({ schema_version: MIRROR_SCHEMA_VERSION, written_at: now, payload })
  try {
    fs.writeFileSync(tmp, body, 'utf8')
    fs.renameSync(tmp, file)
  } catch (e) {
    try { fs.unlinkSync(tmp) } catch { /* the temp file may never have been created */ }
    throw e
  }
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

function obj(v: unknown): Record<string, unknown> | null {
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null
}

/**
 * The fallback status line: `Opus · 5h 25% · 7d 61%`.
 *
 * Only what is actually in the payload is printed — a missing figure is left
 * out rather than shown as 0 %, and a payload with neither a model nor limits
 * prints nothing at all instead of a lonely separator.
 */
export function minimalLine(payload: unknown): string {
  const root = obj(payload)
  if (root === null) return ''
  const parts: string[] = []
  const model = obj(root.model)
  const name = model === null ? null : (model.display_name ?? model.displayName)
  if (typeof name === 'string' && name.length > 0) parts.push(name)
  const limits = obj(root.rate_limits) ?? obj(root.rateLimits)
  if (limits !== null) {
    const five = obj(limits.five_hour) ?? obj(limits.fiveHour)
    const seven = obj(limits.seven_day) ?? obj(limits.sevenDay)
    const fivePct = five === null ? null : num(five.used_percentage ?? five.usedPercentage)
    const sevenPct = seven === null ? null : num(seven.used_percentage ?? seven.usedPercentage)
    if (fivePct !== null) parts.push(`5h ${Math.round(fivePct)}%`)
    if (sevenPct !== null) parts.push(`7d ${Math.round(sevenPct)}%`)
  }
  return parts.join(' · ')
}

/**
 * How the previous command is started. It was written as one shell command in
 * settings.json, so it is handed back to a shell — anything else would break
 * pipes, quoting and `$VARIABLES` that worked before we came along.
 *
 * The command arrives as one string and stays one string. Splitting it into
 * argv and re-joining it with spaces would lose exactly what the user wrote:
 * `--style "compact box"` would become two arguments, and a `;` or `$(…)` that
 * was safely inside quotes would turn into live syntax in this second shell.
 */
export function shellFor(command: string, platform: string = process.platform): { command: string; args: string[] } {
  if (platform === 'win32') {
    return { command: process.env.ComSpec || 'cmd.exe', args: ['/d', '/s', '/c', command] }
  }
  return { command: '/bin/sh', args: ['-c', command] }
}

/**
 * argv is `process.argv`: [node, script, mirrorFile, '--', previousCommand].
 *
 * The previous command is exactly one argument — the installer shell-quotes it
 * for the platform (see `shellQuote` in bridge.ts), so whatever the shell that
 * started us stripped off, `argv[4]` holds the original command line again,
 * byte for byte. Anything after it is ignored rather than glued back on.
 *
 * Returns the exit code. Errors are swallowed on purpose: a broken mirror write
 * or a missing shell must not take Claude Code's status line down with it.
 */
export async function bridgeMain(argv: string[], stdin: Buffer, io: BridgeIo): Promise<number> {
  const mirrorFile = typeof argv[2] === 'string' && argv[2].length > 0 && argv[2] !== '--' ? argv[2] : null
  const previous = argv[3] === '--' && typeof argv[4] === 'string' && argv[4].length > 0 ? argv[4] : null

  let payload: unknown
  try {
    const text = stdin.toString('utf8').trim()
    if (text.length > 0) payload = JSON.parse(text)
  } catch {
    // Not JSON — nothing to mirror, but the pass-through below still runs.
    payload = undefined
  }

  if (mirrorFile !== null && obj(payload) !== null) {
    try {
      // 1.8 §7a Q11: only the fields the extension reads — never the whole payload.
      writeMirror(mirrorFile, narrowPayload(payload), Date.now())
    } catch {
      // A read-only or full disk is not a reason to break the status line.
    }
  }

  if (previous !== null) {
    try {
      const { command, args } = shellFor(previous)
      const result = await io.spawn(command, args, stdin)
      if (result.stdout.length > 0) io.write('stdout', result.stdout)
      if (result.stderr.length > 0) io.write('stderr', result.stderr)
      return Number.isInteger(result.code) ? result.code : 0
    } catch {
      return 0
    }
  }

  try {
    const line = minimalLine(payload)
    if (line.length > 0) io.write('stdout', Buffer.from(`${line}\n`, 'utf8'))
  } catch {
    // Nothing printed is a valid status line; a crash is not.
  }
  return 0
}

/* c8 ignore start — the process wiring is exercised by running the script itself */

function readStdin(): Promise<Buffer> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = []
    const stream = process.stdin
    if (stream.isTTY) {
      resolve(Buffer.alloc(0))
      return
    }
    stream.on('data', (c: Buffer) => chunks.push(c))
    stream.on('end', () => resolve(Buffer.concat(chunks)))
    stream.on('error', () => resolve(Buffer.concat(chunks)))
  })
}

const processIo: BridgeIo = {
  write(stream, chunk) {
    if (stream === 'stdout') process.stdout.write(chunk)
    else process.stderr.write(chunk)
  },
  spawn(command, args, stdin) {
    return new Promise<SpawnResult>((resolve) => {
      const out: Buffer[] = []
      const err: Buffer[] = []
      const done = (code: number) => resolve({ code, stdout: Buffer.concat(out), stderr: Buffer.concat(err) })
      const child = nodeSpawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'] })
      child.stdout?.on('data', (c: Buffer) => out.push(c))
      child.stderr?.on('data', (c: Buffer) => err.push(c))
      // A command that cannot be started is reported as success: the user's
      // status line was already broken, and we must not add an error of ours.
      child.on('error', () => done(0))
      child.on('close', (code) => done(typeof code === 'number' ? code : 0))
      child.stdin?.on('error', () => { /* the child may not read stdin at all */ })
      child.stdin?.end(stdin)
    })
  },
}

/**
 * True only when this file is being run as the status-line script.
 *
 * The bundler inlines this module into every test bundle, and a test file is
 * `main` in its own process — `require.main === module` alone would therefore
 * start the CLI inside the test runner and wait forever on a stdin that never
 * ends.
 */
function isCliInvocation(): boolean {
  if (typeof require === 'undefined' || typeof module === 'undefined' || require.main !== module) return false
  if (typeof process.env.NODE_TEST_CONTEXT === 'string') return false
  // 1.8: the extension's own bundle imports this module too (bridge.ts); only a file named as
  // the script — the bundle or its copy in globalStorage — is ever run as the script.
  return path.basename(String(process.argv[1] ?? '')) === BRIDGE_SCRIPT_NAME
}

if (isCliInvocation()) {
  readStdin()
    .then((buf) => bridgeMain(process.argv, buf, processIo))
    .then((code) => { process.exitCode = code })
    .catch(() => { process.exitCode = 0 })
}

/* c8 ignore stop */
