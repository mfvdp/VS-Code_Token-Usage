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
 *
 * 1.12 B (§0a.2–§0a.4): on macOS the Keychain item comes before the file, and it is read only under
 * its own consent and the window's `KeychainGate` — never from the background before a user action
 * proved that no macOS dialog stands in the way. The sign-in watcher notices the item's change by
 * its modification date alone (`keychainFingerprint`, the attributes without the secret).
 */

import { execFile } from 'child_process'
import * as crypto from 'crypto'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { t } from './i18n'

export interface ClaudeCredentials {
  accessToken: string
  expiresAtMs: number | null
  from: 'env' | 'file' | 'keychain' | 'secretTool'
}

export interface CredentialsError {
  error: string
  kind: 'noToken' | 'tokenExpired'
}

/** 1.12 B2: why a read happens — a user action may open the Keychain, a background read only through the gate. */
export type KeychainOccasion = 'userAction' | 'background'

/** 1.12 B3: the Keychain consent's three states (memento `networkConsentKeychain`). */
export type KeychainConsentState = 'granted' | 'denied' | 'unasked'

/**
 * 1.12 B2: one helper run — its stdout (null on any failure), how long it took, whether the timeout
 * ended it, and its exit code (null where it did not exit with one). The stdout is parsed and dropped.
 */
export interface HelperResult {
  out: string | null
  ms: number
  timedOut: boolean
  code: number | null
}

export type HelperRun = (cmd: string, args: string[]) => Promise<HelperResult>

export interface CredentialsOptions {
  claudeDir?: string
  /** `tokenPace.credentials.keychain`: whether the OS keychain may be queried at all (it can raise a system dialog). */
  keychain: boolean
  /**
   * 1.12 B3: the Keychain consent (macOS). Absent = granted — a caller that does not ask (the tests of 1.x); the
   * host always passes it. Only `granted` lets the Keychain be read; `unasked` answers a missing token with the
   * words that point at *Fetch Quota Now*, where the question comes.
   */
  keychainConsent?: KeychainConsentState
  /** 1.12 B2: whether this read may open the Keychain — a user action always, a background read through the gate; absent = background. */
  occasion?: KeychainOccasion
  /** 1.12 B2: the window's gate; absent = no gate — the Keychain step runs whatever the occasion (1.x callers, tests). */
  gate?: KeychainGate
  /** Injectable; default `process.platform`. */
  platform?: NodeJS.Platform
  /** Injectable helper runner; default `execFile` without a shell. */
  run?: HelperRun
  /** 1.12 B7: the English, value-free log lines of the Keychain step. */
  log?: (msg: string) => void
}

/** A token that expires within the minute is treated as gone — the request would race it. */
const TOKEN_SLACK_MS = 60_000
/** Keychain helpers are interactive processes; a hung one must not stall the poll. */
export const HELPER_TIMEOUT_MS = 5_000
/**
 * 1.12 B2 rule 3: a user-action Keychain read that brings a token within this many milliseconds opened no
 * dialog, so background reads may follow; a slower one had a dialog waiting and closes the gate (not
 * traced on a Mac — §5 step 4(g) measures both, and this constant is the one line to move).
 */
export const KEYCHAIN_QUIET_MS = 1_000
/** 1.12 §0a.3: `security`'s exit code for an item that is not there (errSecItemNotFound) — not traced on a Mac. */
const SECURITY_ITEM_NOT_FOUND = 44
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

/**
 * Runs a helper without a shell and returns its stdout (null on any failure), its time and whether the
 * timeout ended it. Output is never logged.
 */
export function runHelper(cmd: string, args: string[]): Promise<HelperResult> {
  const started = Date.now()
  return new Promise((resolve) => {
    try {
      execFile(cmd, args, { timeout: HELPER_TIMEOUT_MS, maxBuffer: 1 << 20, windowsHide: true, shell: false },
        (err, stdout) => {
          const e = err as (Error & { killed?: boolean; code?: unknown }) | null
          resolve({
            out: e ? null : String(stdout),
            ms: Date.now() - started,
            timedOut: e?.killed === true,
            code: e ? (typeof e.code === 'number' ? e.code : null) : 0,
          })
        })
    } catch {
      resolve({ out: null, ms: Date.now() - started, timedOut: false, code: null })
    }
  })
}

/**
 * 1.12 B2: the window's gate in front of every Keychain read that nobody asked for. One per window
 * (`extension.ts`), handed down through the quota options to the poll.
 *
 * `untried` until a user action read the Keychain; `open` after a user-action read that brought a token within
 * KEYCHAIN_QUIET_MS (no dialog was waiting); `closed` after a read — either occasion — that timed out, failed,
 * brought no token or took longer. A user action may always read; a background read (the timer, the reset
 * re-poll, the watchers, the lease's takeover) only while the gate is open. The gate never widens what is
 * read: it only decides whether the Keychain step runs for this read (B2 rule 5).
 */
export class KeychainGate {
  private s: 'untried' | 'open' | 'closed' = 'untried'

  constructor(private log: (msg: string) => void = () => { /* no log */ }) {}

  state(): 'untried' | 'open' | 'closed' {
    return this.s
  }

  mayRead(occasion: KeychainOccasion): boolean {
    return occasion === 'userAction' || this.s === 'open'
  }

  /** The outcome of one Keychain read; `ok` = a token came back (fresh or not). */
  note(result: { ok: boolean; ms: number; timedOut: boolean }, occasion: KeychainOccasion): void {
    const quiet = result.ok && !result.timedOut && result.ms <= KEYCHAIN_QUIET_MS
    if (occasion === 'userAction') this.s = quiet ? 'open' : 'closed'
    else if (!quiet) this.s = 'closed'
    if (quiet) return
    // B7: the one line that says why background reads wait — a time and nothing of the read.
    this.log(result.ok && !result.timedOut
      ? `claude: Keychain read took ${Math.round(result.ms)} ms — background reads wait for the next fetch by hand`
      : result.timedOut
        ? `claude: Keychain read timed out after ${Math.round(result.ms)} ms — background reads wait for the next fetch by hand`
        : 'claude: no token from the Keychain — background reads wait for the next fetch by hand')
  }

  /** *Reset Network Access Decision*: the next Keychain read is again a user action's. */
  reset(): void {
    this.s = 'untried'
  }
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
 *
 * 1.12 B1: per platform — macOS `$CLAUDE_CODE_OAUTH_TOKEN` → the Keychain item (with the setting on, under
 * the Keychain consent and the gate) → the credentials file, because Claude Code keeps its credentials in the
 * Keychain there and a file beside it may be another setup's leftover; Linux the variable → the file →
 * `secret-tool` (with the setting on); Windows the variable → the file.
 */
export async function loadCredentials(
  opts: CredentialsOptions, now = Date.now(),
): Promise<ClaudeCredentials | CredentialsError> {
  const platform = opts.platform ?? process.platform
  const run = opts.run ?? runHelper
  const occasion = opts.occasion ?? 'background'
  const log = opts.log ?? (() => { /* no log */ })
  let expired: ClaudeCredentials['from'] | null = null
  /** 1.12 B2 rule 4 / B3 rule 3: the Keychain was wanted but not read — its own words when nothing else answers. */
  let keychainSkipped = false

  const envToken = process.env.CLAUDE_CODE_OAUTH_TOKEN?.trim()
  if (envToken) return { accessToken: envToken, expiresAtMs: null, from: 'env' }

  if (opts.keychain && platform === 'darwin') {
    const consent = opts.keychainConsent ?? 'granted'
    if (consent === 'unasked') {
      keychainSkipped = true
    } else if (consent === 'granted') {
      if (opts.gate && !opts.gate.mayRead(occasion)) {
        keychainSkipped = true
        log('claude: the Keychain was not read (background, gate closed)')
      } else {
        const r = await run('security', ['find-generic-password', '-s', keychainService(), '-w'])
        const c = r.out === null ? null : parseCredentials(r.out)
        opts.gate?.note({ ok: c !== null, ms: r.ms, timedOut: r.timedOut }, occasion)
        if (c) {
          if (fresh(c, now)) {
            log('claude: token from the Keychain')
            return { ...c, from: 'keychain' }
          }
          expired = 'keychain'
        }
      }
    }
  }

  const file = credentialsPath(opts.claudeDir)
  const fromFile = readCredentialsFile(file)
  if (fromFile) {
    if (fresh(fromFile, now)) return { ...fromFile, from: 'file' }
    expired = expired ?? 'file'
  }

  if (opts.keychain && platform === 'linux') {
    // Best effort: most systems do not have secret-tool, and a missing binary is
    // not an error worth reporting.
    const r = await run('secret-tool', ['lookup', 'service', KEYCHAIN_SERVICE])
    const c = r.out === null ? null : parseCredentials(r.out)
    if (c) {
      if (fresh(c, now)) return { ...c, from: 'secretTool' }
      expired = expired ?? 'secretTool'
    }
  }

  if (keychainSkipped) {
    // B2 rule 4: the Keychain was skipped and neither the variable nor the file holds a fresh token — the
    // words say where the token may be and what reads it (an expired file is no answer on macOS).
    return {
      kind: 'noToken',
      error: t('No token without the macOS Keychain, which is read in the background only after you fetched by hand — run "Token Pace: Fetch Quota Now"'),
    }
  }
  if (expired) {
    return {
      kind: 'tokenExpired',
      error: t('Access token expired — use Claude Code once and the credentials renew themselves'),
    }
  }
  return { kind: 'noToken', error: t('No Claude Code credentials at {0}', file) }
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

/** Debounce for the Keychain folder's events — the same two seconds as the file's. */
const KEYCHAIN_WATCH_DEBOUNCE_MS = WATCH_DEBOUNCE_MS

/**
 * 1.12 §0a.3: the Keychain item's modification date as a fingerprint — `mdat:<value>`, `none` when there is no
 * such item, `unknown` for any other outcome (no change is reported for it). The probe is `security
 * find-generic-password -s <item>` WITHOUT `-w` and WITHOUT `-g`: it prints the item's attributes, never its
 * secret (not traced on a Mac: that it raises no dialog — §5 step 4(g)). Of the output only the line of the
 * attribute `"mdat"` is looked at; the account name, the service, the creation date and the keychain's path
 * are never kept.
 */
export async function keychainFingerprint(run: HelperRun = runHelper): Promise<string> {
  let r: HelperResult
  try {
    r = await run('security', ['find-generic-password', '-s', keychainService()])
  } catch {
    return 'unknown'
  }
  if (r.out === null) return r.code === SECURITY_ITEM_NOT_FOUND ? 'none' : 'unknown'
  return mdatOf(r.out)
}

/**
 * The modification date of an attribute block: `"mdat"<timedate>=0x3230…5A00  "20260927120000Z\000"` — the
 * hex form where there is one, else the quoted date; `unknown` without such a line. Nothing else of the block
 * leaves this function.
 */
function mdatOf(out: string): string {
  for (const line of out.split(/\r?\n/)) {
    const m = /^\s*"mdat"<timedate>=(.*)$/.exec(line)
    if (!m) continue
    const hex = /0x([0-9A-Fa-f]{2,64})/.exec(m[1])
    if (hex) return `mdat:0x${hex[1].toUpperCase()}`
    const date = /"(\d{14}Z)/.exec(m[1])
    return date ? `mdat:${date[1]}` : 'unknown'
  }
  return 'unknown'
}

/**
 * 1.12 B5 rule 2 (§0a.3): a sign-in or sign-out through the Keychain, noticed within seconds. `fs.watch` on the
 * folder `~/Library/Keychains` (macOS only; names only): an event for a name starting with `login.keychain` →
 * the debounce → the attribute probe → a changed fingerprint → `onChange()` (the caller's background poll,
 * under the gate). A probe that answers `unknown` reports nothing. Where the folder cannot be watched there
 * is no watcher and no error: the next poll notices.
 */
export function watchKeychain(
  onChange: () => void,
  deps: {
    platform?: NodeJS.Platform
    home?: string
    run?: HelperRun
    watch?: (dir: string, opts: { persistent: boolean }, listener: (event: string, name: string | Buffer | null) => void) => fs.FSWatcher
    debounceMs?: number
  } = {},
): { dispose(): void } {
  const platform = deps.platform ?? process.platform
  if (platform !== 'darwin') return { dispose: () => { /* nothing watched */ } }
  const dir = path.join(deps.home ?? os.homedir(), 'Library', 'Keychains')
  const run = deps.run ?? runHelper
  const watch = deps.watch ?? ((d, o, l) => fs.watch(d, o, l))
  const debounceMs = deps.debounceMs ?? KEYCHAIN_WATCH_DEBOUNCE_MS
  let last: string | null = null
  let timer: NodeJS.Timeout | null = null
  let watcher: fs.FSWatcher | null = null
  let disposed = false
  let probing = false
  let again = false

  const probe = async (report: boolean): Promise<void> => {
    if (probing) {
      again = again || report
      return
    }
    probing = true
    try {
      const now = await keychainFingerprint(run)
      if (disposed || now === 'unknown') return
      const changed = last !== null && now !== last
      last = now
      if (changed && report) onChange()
    } finally {
      probing = false
      if (again && !disposed) {
        again = false
        void probe(true)
      }
    }
  }

  try {
    watcher = watch(dir, { persistent: false }, (_event, changed) => {
      if (disposed) return
      if (changed === null || changed === undefined || !path.basename(String(changed)).startsWith('login.keychain')) return
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => {
        timer = null
        void probe(true)
      }, debounceMs)
      timer.unref?.()
    })
    watcher.on?.('error', () => { /* a vanished folder is not an error worth raising */ })
  } catch {
    return { dispose: () => { /* nothing watched */ } }
  }
  // The baseline: the item's date as it is now, so the first event compares against something.
  void probe(false)

  return {
    dispose(): void {
      disposed = true
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
