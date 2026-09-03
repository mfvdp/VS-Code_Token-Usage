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
 */

import { spawn as nodeSpawn } from 'child_process'
import * as fs from 'fs'
import * as path from 'path'

/** Schema of the mirror file; `quota.ts` refuses anything else. */
export const MIRROR_SCHEMA_VERSION = 1

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
      writeMirror(mirrorFile, payload, Date.now())
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
  if (require.main !== module) return false
  if (typeof process.env.NODE_TEST_CONTEXT === 'string') return false
  return !/\.test\.[cm]?js$/.test(String(process.argv[1] ?? ''))
}

if (isCliInvocation()) {
  readStdin()
    .then((buf) => bridgeMain(process.argv, buf, processIo))
    .then((code) => { process.exitCode = code })
    .catch(() => { process.exitCode = 0 })
}

/* c8 ignore stop */
