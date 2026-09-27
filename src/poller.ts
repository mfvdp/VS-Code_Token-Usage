// SPDX-FileCopyrightText: 2026 Frederik Marx
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The only place in this extension that touches the network.
 *
 * Fetches the quota directly from the provider when no external poller supplies
 * a fresh cache file. Two rules are not negotiable:
 *  - The access token is ONLY read, and is sent exclusively to the hard-coded
 *    api.anthropic.com URL below. It is never refreshed: rotating it from here
 *    would invalidate Claude Code's own session.
 *  - Neither the token nor any request header may appear in a log line or an
 *    error message. Every problem text below is a fixed string plus, at most, an
 *    HTTP status code — never the exception message of a failed request.
 */

import { execFile as nodeExecFile } from 'child_process'
import * as fs from 'fs'
import * as path from 'path'
import { CodexConnection, findCodexBinary, readRateLimitsOnce } from './appServer'
import { isCredentialsError, loadCredentials } from './credentials'
import { t } from './i18n'
import { claudeStateFromBody, codexStateFromBody } from './quota'
import { ProblemKind, QuotaState, Source } from './types'

const CLAUDE_USAGE_URL = 'https://api.anthropic.com/api/oauth/usage'
/**
 * Without a claude-code user agent the call lands in an aggressively
 * rate-limited bucket and gets a permanent 429. The version is detected from the
 * installed CLI, else (1.7 W3, §0a.1) taken from the newest main-session transcript;
 * this constant is only the fallback when neither knows one.
 */
export const CLAUDE_VERSION_FALLBACK = '2.1.257'
const HTTP_TIMEOUT_MS = 20_000
const VERSION_TIMEOUT_MS = 3_000

const BACKOFF_RATE_BASE_S = 600
const BACKOFF_RATE_MAX_S = 7200
const BACKOFF_NET_BASE_S = 60
const BACKOFF_NET_MAX_S = 1800

export interface PollResult {
  state: QuotaState | null
  /** Seconds until the next attempt; null = regular interval. */
  retryAfterSeconds: number | null
  problem?: string
  problemKind?: ProblemKind
  /** The parsed provider response — for the drift scan and the cache write-back. */
  raw?: unknown
  /**
   * 1.12 A2 rule 3: how Codex was asked — over the standing connection, or by a child of its own
   * (`readRateLimitsOnce`). Absent for Claude.
   */
  via?: 'connection' | 'oneShot'
}

export interface PollOptions {
  claudeDir?: string
  codexBinary?: string
  keychain: boolean
  userAgent: 'claudeCode' | 'honest'
  /** Version of this extension, for the honest user agent. */
  extVersion: string
  /**
   * The Claude Code version for the user agent: the installed CLI's, else (1.7 W3, §0a.1) the one the
   * newest main session wrote into its transcript; null when neither is known (the fallback is sent).
   */
  claudeVersion: string | null
  /**
   * 1.12 A2 rule 3: the standing app-server connection, when there is one (the manager fills it in
   * `persistent` mode on the leader); null or absent = a child per poll.
   */
  codexConnection?: CodexConnection | null
}

export type PollFn = (source: Source, failCount: number, opts: PollOptions) => Promise<PollResult>

function backoff(failCount: number, base: number, max: number): number {
  const delay = Math.min(base * 2 ** Math.max(0, failCount - 1), max)
  // Jitter keeps several clients from knocking again in lockstep.
  return Math.round(delay * (0.85 + Math.random() * 0.3))
}

export function userAgentFor(opts: PollOptions): string {
  return opts.userAgent === 'honest'
    ? `token-pace/${opts.extVersion}`
    : `claude-code/${opts.claudeVersion ?? CLAUDE_VERSION_FALLBACK}`
}

let versionProbe: Promise<string | null> | null = null

/**
 * 1.7 W3: the edges of the version probe — the platform, the `PATH`, the one existence check and
 * the one process start — injectable, so no test starts a process or reads a real `PATH`.
 */
export interface VersionProbeDeps {
  platform: NodeJS.Platform
  pathEnv: string | undefined
  isFile: (p: string) => boolean
  execFile: (file: string, args: string[], opts: { timeout: number; windowsHide: boolean; shell: false },
    cb: (err: Error | null, stdout: string) => void) => void
}

/**
 * 1.7 W3 (§0a.2): the only file name looked for on Windows. An npm install puts a `claude.cmd` shim
 * (beside a `claude` shell script and a `claude.ps1`) on the `PATH`; a `.cmd` or `.bat` only runs
 * through `cmd.exe` and a `.ps1` only through PowerShell, and neither is ever started from here.
 */
const WINDOWS_CANDIDATES: readonly string[] = ['claude.exe']
/** 1.7 W3 (§0a.2): at most this many `PATH` entries are looked at, … */
const PATH_MAX_ENTRIES = 64
/** … and an entry longer than this is skipped, not cut. */
const PATH_ENTRY_MAX_CHARS = 1024

/**
 * 1.7 W3 (§0a.2): an absolute Windows directory of a `PATH` entry, or null. Quotes are stripped
 * (Windows ignores them there too), and only a directory that names its drive (`C:\…`) or a share
 * (`\\server\share\…`) counts: a relative entry — `.`, `.\bin`, `bin` — would make the current
 * directory choose what runs, and a rooted one without a drive (`\bin`) the current drive.
 */
function windowsPathDir(entry: string): string | null {
  if (entry.length > PATH_ENTRY_MAX_CHARS) return null
  const dir = entry.replace(/"/g, '').trim()
  if (dir === '' || !path.win32.isAbsolute(dir)) return null
  return /^[A-Za-z]:[\\/]/.test(dir) || /^[\\/]{2}[^\\/]/.test(dir) ? dir : null
}

/**
 * 1.7 W3 (§0a.2): the first `claude.exe` in a directory of `PATH` — existence only, through
 * `isFile`; nothing is read from any file. Null when there is none. Never a `.cmd`, `.bat` or
 * `.ps1`. `path.win32` throughout, so the lookup is the same on every test runner.
 */
export function findWindowsClaudeExe(pathEnv: string | undefined, isFile: (p: string) => boolean): string | null {
  if (typeof pathEnv !== 'string' || pathEnv === '') return null
  for (const entry of pathEnv.split(';', PATH_MAX_ENTRIES)) {
    const dir = windowsPathDir(entry)
    if (dir === null) continue
    for (const name of WINDOWS_CANDIDATES) {
      const file = path.win32.join(dir, name)
      let found = false
      try {
        found = isFile(file)
      } catch {
        found = false
      }
      if (found) return file
    }
  }
  return null
}

/** The existence check of the lookup: a regular file (a link is followed), nothing read from it. */
export function isRegularFile(p: string): boolean {
  try {
    return fs.statSync(p).isFile()
  } catch {
    return false
  }
}

/** The one process start of the probe, never through a shell. */
function runFile(file: string, args: string[], opts: { timeout: number; windowsHide: boolean; shell: false },
  cb: (err: Error | null, stdout: string) => void): void {
  nodeExecFile(file, args, opts, (err, stdout) => cb(err, String(stdout)))
}

/**
 * Reads the installed Claude CLI's version once per session.
 *
 * A frozen constant in the source is how the user agent drifted to a version
 * that had not existed for months. `claude --version` prints something like
 * "2.1.257 (Claude Code)"; anything else, or no CLI at all, leaves the fallback
 * in place. Never through a shell.
 *
 * 1.7 W3: on Windows only a `claude.exe` found in a `PATH` directory is started, by its absolute
 * path (`findWindowsClaudeExe`) — without one, nothing is started and the answer is null. Without
 * a shell Node resolves a bare `claude` there to a `.com` or `.exe` only (the current directory
 * first), and it refuses a `.cmd` or `.bat` named outright (CVE-2024-27980): for an npm install,
 * whose `PATH` holds only the shim `claude.cmd`, the bare name never answered. Elsewhere `claude`
 * as before, `shell: false` said explicitly.
 */
export function detectClaudeVersion(deps: Partial<VersionProbeDeps> = {}): Promise<string | null> {
  if (versionProbe) return versionProbe
  const platform = deps.platform ?? process.platform
  const pathEnv = 'pathEnv' in deps ? deps.pathEnv : (process.env.PATH ?? process.env.Path)
  const isFile = deps.isFile ?? isRegularFile
  const run = deps.execFile ?? runFile
  versionProbe = new Promise<string | null>((resolve) => {
    try {
      const file = platform === 'win32' ? findWindowsClaudeExe(pathEnv, isFile) : 'claude'
      if (file === null) {
        resolve(null)
        return
      }
      run(file, ['--version'], { timeout: VERSION_TIMEOUT_MS, windowsHide: true, shell: false },
        (err, stdout) => {
          if (err) {
            resolve(null)
            return
          }
          const m = /(\d+\.\d+\.\d+[\w.-]*)/.exec(String(stdout))
          resolve(m ? m[1] : null)
        })
    } catch {
      resolve(null)
    }
  })
  return versionProbe
}

/** Test seam: forget the cached probe. */
export function resetClaudeVersionProbe(): void {
  versionProbe = null
}

interface NetworkFailure {
  problem: string
  kind: ProblemKind
}

/**
 * Classifies a failed fetch without quoting the exception.
 *
 * Corporate networks are a standard case, so a TLS interception and a plain
 * outage get different words: the repair steps differ.
 */
function classify(err: unknown): NetworkFailure {
  const e = err as { name?: string; code?: string; message?: string; cause?: { code?: string; message?: string } }
  if (e?.name === 'TimeoutError' || e?.name === 'AbortError') {
    return { problem: t('timeout while fetching'), kind: 'offline' }
  }
  const code = String(e?.code ?? e?.cause?.code ?? '')
  const message = `${e?.message ?? ''} ${e?.cause?.message ?? ''}`
  if (/CERT|TLS|SSL|self.signed|UNABLE_TO_VERIFY/i.test(`${code} ${message}`)) {
    return { problem: t('TLS error — possibly a proxy intercepting TLS'), kind: 'offline' }
  }
  if (['ENOTFOUND', 'ECONNREFUSED', 'EAI_AGAIN', 'ECONNRESET', 'ENETUNREACH', 'EHOSTUNREACH'].includes(code)) {
    return { problem: t('network error while fetching'), kind: 'offline' }
  }
  // Unclassified failures are reported as unreachable rather than guessed at: the
  // exception text may not be shown, so a wrong cause would be worse than none.
  return { problem: t('fetch failed — provider not reachable'), kind: 'offline' }
}

export async function pollClaude(failCount: number, opts: PollOptions): Promise<PollResult> {
  const cred = await loadCredentials({ claudeDir: opts.claudeDir, keychain: opts.keychain })
  if (isCredentialsError(cred)) {
    // Deliberately NO refresh: rotating the token from here would lock Claude
    // Code itself out. The user renews it simply by using Claude Code.
    return { state: null, retryAfterSeconds: null, problem: cred.error, problemKind: cred.kind }
  }

  let res: Response
  try {
    res = await fetch(CLAUDE_USAGE_URL, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${cred.accessToken}`,
        'anthropic-beta': 'oauth-2025-04-20',
        'Content-Type': 'application/json',
        'User-Agent': userAgentFor(opts),
      },
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    })
  } catch (err) {
    const f = classify(err)
    return {
      state: null,
      retryAfterSeconds: backoff(failCount + 1, BACKOFF_NET_BASE_S, BACKOFF_NET_MAX_S),
      problem: f.problem,
      problemKind: f.kind,
    }
  }

  if (res.status === 401) {
    return {
      state: null,
      retryAfterSeconds: null,
      problem: t('credentials rejected — sign in to Claude Code again'),
      problemKind: 'unauthorized',
    }
  }
  if (res.status === 403) {
    // A guess, and phrased as one: Team and Enterprise accounts answer this way,
    // and the token counting from the transcripts is unaffected either way.
    return {
      state: null,
      retryAfterSeconds: null,
      problem: t('HTTP 403 — may mean a Team/Enterprise account without a usage endpoint; token counts keep working'),
      problemKind: 'forbidden',
    }
  }
  if (res.status === 407) {
    return {
      state: null,
      retryAfterSeconds: backoff(failCount + 1, BACKOFF_NET_BASE_S, BACKOFF_NET_MAX_S),
      problem: t('proxy requires authentication (HTTP 407)'),
      problemKind: 'offline',
    }
  }
  if (res.status === 429 || res.status >= 500) {
    const header = Number(res.headers.get('retry-after'))
    const wait = Number.isFinite(header) && header > 0
      ? header
      : backoff(failCount + 1, BACKOFF_RATE_BASE_S, BACKOFF_RATE_MAX_S)
    return {
      state: null,
      retryAfterSeconds: wait,
      problem: t('HTTP {0} — backing off before the next attempt', res.status),
      problemKind: 'retry',
    }
  }
  if (!res.ok) {
    return {
      state: null,
      retryAfterSeconds: backoff(failCount + 1, BACKOFF_NET_BASE_S, BACKOFF_NET_MAX_S),
      problem: `HTTP ${res.status}`,
      problemKind: 'unknown',
    }
  }

  let body: unknown
  try {
    body = await res.json()
  } catch {
    return {
      state: null, retryAfterSeconds: null, problem: t('Response is not valid JSON'), problemKind: 'empty',
    }
  }
  const state = claudeStateFromBody(body, Math.floor(Date.now() / 1000), 'poll')
  return state.ok
    ? { state, retryAfterSeconds: null, raw: body }
    : {
      state: null,
      retryAfterSeconds: null,
      problem: t('Response contained no quota windows'),
      problemKind: 'empty',
      raw: body,
    }
}

/**
 * The Codex read. 1.12 A2 rule 3: over the standing connection when it is usable (ready, or starting and
 * ready within the read's wait) — the same method and the same parser as the one-shot path, `via:
 * 'connection'`; otherwise, and when the connection was not there to ask after all, one child of its own
 * (`readRateLimitsOnce`, `via: 'oneShot'`). Never two children for one read. `readOnce` is a test seam.
 */
export async function pollCodex(
  failCount: number,
  opts: {
    binary?: string
    connection?: CodexConnection | null
    readOnce?: (bin: string) => Promise<unknown>
  },
): Promise<PollResult> {
  const conn = opts.connection ?? null
  if (conn !== null && conn.usable()) {
    let body: unknown
    let asked = true
    try {
      body = await conn.readRateLimits()
    } catch {
      // The connection did not become ready within the wait: this read starts its own child.
      asked = false
    }
    if (asked) return codexResult(body, failCount, 'connection')
  }
  const bin = findCodexBinary(opts.binary)
  if (!bin) {
    return {
      state: null, retryAfterSeconds: null, problem: t('codex executable not found'), problemKind: 'noBinary',
    }
  }
  const body = await (opts.readOnce ?? readRateLimitsOnce)(bin)
  return codexResult(body, failCount, 'oneShot')
}

/** One app-server answer — the connection's or a one-shot child's — as a poll result. */
function codexResult(body: unknown, failCount: number, via: 'connection' | 'oneShot'): PollResult {
  if (body && typeof body === 'object' && 'error' in body) {
    return {
      state: null,
      retryAfterSeconds: backoff(failCount + 1, BACKOFF_NET_BASE_S, BACKOFF_NET_MAX_S),
      problem: String((body as { error: string }).error),
      problemKind: 'retry',
      via,
    }
  }
  const state = codexStateFromBody(body, Math.floor(Date.now() / 1000), 'poll')
  return state.ok
    ? { state, retryAfterSeconds: null, raw: body, via }
    : {
      state: null,
      retryAfterSeconds: null,
      problem: t('app-server returned no quota windows'),
      problemKind: 'empty',
      raw: body,
      via,
    }
}

export const poll: PollFn = (source, failCount, opts) =>
  source === 'claude'
    ? pollClaude(failCount, opts)
    : pollCodex(failCount, { binary: opts.codexBinary, connection: opts.codexConnection ?? null })
