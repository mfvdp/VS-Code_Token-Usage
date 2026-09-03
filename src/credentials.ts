// SPDX-FileCopyrightText: 2026 Frederik Marx
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Finding Claude Code's access token — and nothing else.
 *
 * Three rules hold everywhere in this file, and no caller may weaken them:
 *  - the token is only ever READ. It is never refreshed, never written back and
 *    never stored: rotating it here would log Claude Code itself out.
 *  - it never reaches a log line, an error message or a diagnostics report. The
 *    error texts below therefore name the source, never the value, and the
 *    keychain helpers' stdout is parsed but never printed.
 *  - the helper processes are started with execFile, never through a shell, so
 *    no part of a path can be interpreted as a command.
 */

import { execFile } from 'child_process'
import * as crypto from 'crypto'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

export interface ClaudeCredentials {
  accessToken: string
  expiresAtMs: number | null
  from: 'env' | 'file' | 'keychain' | 'secretTool'
}

export interface CredentialsError {
  error: string
  kind: 'noToken' | 'tokenExpired'
}

export interface CredentialsOptions {
  claudeDir?: string
  /** Whether the OS keychain may be queried at all (it can raise a system dialog). */
  keychain: boolean
}

/** A token that expires within the minute is treated as gone — the request would race it. */
const TOKEN_SLACK_MS = 60_000
/** Keychain helpers are interactive processes; a hung one must not stall the poll. */
const HELPER_TIMEOUT_MS = 5_000
const KEYCHAIN_SERVICE = 'Claude Code-credentials'
export const CREDENTIALS_FILE = '.credentials.json'
/** Debounce for the watcher: a re-login rewrites the file more than once. */
const WATCH_DEBOUNCE_MS = 2_000

/**
 * The directory Claude Code keeps its credentials in.
 *
 * `CLAUDE_SECURESTORAGE_CONFIG_DIR` wins over `CLAUDE_CONFIG_DIR`, and the
 * result is NFC-normalised because a path typed on macOS arrives decomposed and
 * would otherwise not match the file that is really there.
 */
export function credentialsDir(claudeDir?: string): string {
  const base = process.env.CLAUDE_SECURESTORAGE_CONFIG_DIR?.trim()
    || claudeDir?.trim()
    || process.env.CLAUDE_CONFIG_DIR?.trim()
    || path.join(os.homedir(), '.claude')
  return base.normalize('NFC')
}

export function credentialsPath(claudeDir?: string): string {
  return path.join(credentialsDir(claudeDir), CREDENTIALS_FILE)
}

/**
 * Item name of the macOS keychain entry.
 *
 * Claude Code appends a hash of `CLAUDE_CONFIG_DIR` when that variable is set, so
 * that several configurations can live side by side without overwriting one
 * another's entry.
 */
export function keychainService(): string {
  const dir = process.env.CLAUDE_CONFIG_DIR?.trim()
  if (!dir) return KEYCHAIN_SERVICE
  const suffix = crypto.createHash('sha256').update(dir).digest('hex').slice(0, 8)
  return `${KEYCHAIN_SERVICE}-${suffix}`
}

/** Runs a helper without a shell and returns its stdout, or null. Output is never logged. */
function run(cmd: string, args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    try {
      execFile(cmd, args, { timeout: HELPER_TIMEOUT_MS, maxBuffer: 1 << 20, windowsHide: true },
        (err, stdout) => resolve(err ? null : stdout))
    } catch {
      resolve(null)
    }
  })
}

interface Parsed {
  accessToken: string
  expiresAtMs: number | null
}

/**
 * The credentials JSON, in the one shape Claude Code writes.
 *
 * The keychain stores the very same document, so file and keychain share this
 * parser. A bare token string is accepted too, because that is what a hand-made
 * keychain entry usually holds.
 */
function parseCredentials(raw: string): Parsed | null {
  const text = raw.trim()
  if (!text) return null
  let d: any
  try {
    d = JSON.parse(text)
  } catch {
    // A single opaque word cannot be anything but the token itself.
    return /^[\w.\-]{20,}$/.test(text) ? { accessToken: text, expiresAtMs: null } : null
  }
  const oauth = d?.claudeAiOauth ?? d
  const token = oauth?.accessToken
  if (typeof token !== 'string' || !token) return null
  const exp = oauth.expiresAt
  return { accessToken: token, expiresAtMs: typeof exp === 'number' && Number.isFinite(exp) ? exp : null }
}

function readCredentialsFile(file: string): Parsed | null {
  let raw: string
  try {
    raw = fs.readFileSync(file, 'utf8')
  } catch {
    return null
  }
  return parseCredentials(raw)
}

function fresh(c: Parsed, now: number): boolean {
  return c.expiresAtMs === null || c.expiresAtMs >= now + TOKEN_SLACK_MS
}

/**
 * The cascade, in the order Claude Code's own tooling uses it.
 *
 * An expired token found early does not end the search: another source may hold
 * a current one. Only when every source is exhausted is the expiry reported —
 * with the advice to use Claude Code once, which renews the credentials without
 * this extension ever writing them.
 */
export async function loadCredentials(
  opts: CredentialsOptions, now = Date.now(),
): Promise<ClaudeCredentials | CredentialsError> {
  let expired: ClaudeCredentials['from'] | null = null

  const envToken = process.env.CLAUDE_CODE_OAUTH_TOKEN?.trim()
  if (envToken) return { accessToken: envToken, expiresAtMs: null, from: 'env' }

  const file = credentialsPath(opts.claudeDir)
  const fromFile = readCredentialsFile(file)
  if (fromFile) {
    if (fresh(fromFile, now)) return { ...fromFile, from: 'file' }
    expired = 'file'
  }

  if (opts.keychain && process.platform === 'darwin') {
    const out = await run('security', ['find-generic-password', '-s', keychainService(), '-w'])
    const c = out === null ? null : parseCredentials(out)
    if (c) {
      if (fresh(c, now)) return { ...c, from: 'keychain' }
      expired = expired ?? 'keychain'
    }
  }

  if (opts.keychain && process.platform === 'linux') {
    // Best effort: most systems do not have secret-tool, and a missing binary is
    // not an error worth reporting.
    const out = await run('secret-tool', ['lookup', 'service', KEYCHAIN_SERVICE])
    const c = out === null ? null : parseCredentials(out)
    if (c) {
      if (fresh(c, now)) return { ...c, from: 'secretTool' }
      expired = expired ?? 'secretTool'
    }
  }

  if (expired) {
    return {
      kind: 'tokenExpired',
      error: 'Access token expired — use Claude Code once and the credentials renew themselves',
    }
  }
  return { kind: 'noToken', error: `No Claude Code credentials at ${file}` }
}

export function isCredentialsError(v: ClaudeCredentials | CredentialsError): v is CredentialsError {
  return (v as CredentialsError).kind !== undefined
}

/**
 * Watches the credentials file so a re-login is noticed within seconds instead of
 * at the next interval.
 *
 * The directory is watched rather than the file: an atomic replace (tmp + rename)
 * breaks a file watch on every platform. Only size and mtime are compared — the
 * content is a secret and is not even hashed.
 */
export function watchCredentials(
  claudeDir: string | undefined, onChange: () => void,
): { dispose(): void } {
  const file = credentialsPath(claudeDir)
  const dir = path.dirname(file)
  const name = path.basename(file)
  let last = fingerprint(file)
  let timer: NodeJS.Timeout | null = null
  let watcher: fs.FSWatcher | null = null

  try {
    watcher = fs.watch(dir, { persistent: false }, (_event, changed) => {
      if (changed && path.basename(String(changed)) !== name) return
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => {
        timer = null
        const now = fingerprint(file)
        if (now === last) return
        last = now
        onChange()
      }, WATCH_DEBOUNCE_MS)
      timer.unref?.()
    })
    watcher.on('error', () => { /* a vanished directory is not an error worth raising */ })
  } catch {
    watcher = null
  }

  return {
    dispose(): void {
      if (timer) clearTimeout(timer)
      timer = null
      try { watcher?.close() } catch { /* already closed */ }
      watcher = null
    },
  }
}

function fingerprint(file: string): string {
  try {
    const s = fs.statSync(file)
    return `${s.size}:${s.mtimeMs}`
  } catch {
    return 'none'
  }
}
