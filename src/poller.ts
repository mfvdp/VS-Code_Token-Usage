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

import { execFile } from 'child_process'
import { findCodexBinary, readRateLimitsOnce } from './appServer'
import { isCredentialsError, loadCredentials } from './credentials'
import { claudeStateFromBody, codexStateFromBody } from './quota'
import { ProblemKind, QuotaState, Source } from './types'

const CLAUDE_USAGE_URL = 'https://api.anthropic.com/api/oauth/usage'
/**
 * Without a claude-code user agent the call lands in an aggressively
 * rate-limited bucket and gets a permanent 429. The version is detected from the
 * installed CLI; this constant is only the fallback when that fails.
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
}

export interface PollOptions {
  claudeDir?: string
  codexBinary?: string
  keychain: boolean
  userAgent: 'claudeCode' | 'honest'
  /** Version of this extension, for the honest user agent. */
  extVersion: string
  /** Version of the installed Claude CLI, or null when it could not be detected. */
  claudeVersion: string | null
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
 * Reads the installed Claude CLI's version once per session.
 *
 * A frozen constant in the source is how the user agent drifted to a version
 * that had not existed for months. `claude --version` prints something like
 * "2.1.257 (Claude Code)"; anything else, or no CLI at all, leaves the fallback
 * in place. Never through a shell.
 */
export function detectClaudeVersion(): Promise<string | null> {
  if (versionProbe) return versionProbe
  versionProbe = new Promise<string | null>((resolve) => {
    try {
      execFile('claude', ['--version'], { timeout: VERSION_TIMEOUT_MS, windowsHide: true },
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
    return { problem: 'timeout while fetching', kind: 'offline' }
  }
  const code = String(e?.code ?? e?.cause?.code ?? '')
  const message = `${e?.message ?? ''} ${e?.cause?.message ?? ''}`
  if (/CERT|TLS|SSL|self.signed|UNABLE_TO_VERIFY/i.test(`${code} ${message}`)) {
    return { problem: 'TLS error — possibly a proxy intercepting TLS', kind: 'offline' }
  }
  if (['ENOTFOUND', 'ECONNREFUSED', 'EAI_AGAIN', 'ECONNRESET', 'ENETUNREACH', 'EHOSTUNREACH'].includes(code)) {
    return { problem: 'network error while fetching', kind: 'offline' }
  }
  // Unclassified failures are reported as unreachable rather than guessed at: the
  // exception text may not be shown, so a wrong cause would be worse than none.
  return { problem: 'fetch failed — provider not reachable', kind: 'offline' }
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
      problem: 'credentials rejected — sign in to Claude Code again',
      problemKind: 'unauthorized',
    }
  }
  if (res.status === 403) {
    // A guess, and phrased as one: Team and Enterprise accounts answer this way,
    // and the token counting from the transcripts is unaffected either way.
    return {
      state: null,
      retryAfterSeconds: null,
      problem: 'HTTP 403 — may mean a Team/Enterprise account without a usage endpoint; token counts keep working',
      problemKind: 'forbidden',
    }
  }
  if (res.status === 407) {
    return {
      state: null,
      retryAfterSeconds: backoff(failCount + 1, BACKOFF_NET_BASE_S, BACKOFF_NET_MAX_S),
      problem: 'proxy requires authentication (HTTP 407)',
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
      problem: `HTTP ${res.status} — backing off before the next attempt`,
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
      state: null, retryAfterSeconds: null, problem: 'Response is not valid JSON', problemKind: 'empty',
    }
  }
  const state = claudeStateFromBody(body, Math.floor(Date.now() / 1000), 'poll')
  return state.ok
    ? { state, retryAfterSeconds: null, raw: body }
    : {
      state: null,
      retryAfterSeconds: null,
      problem: 'Response contained no quota windows',
      problemKind: 'empty',
      raw: body,
    }
}

export async function pollCodex(failCount: number, opts: { binary?: string }): Promise<PollResult> {
  const bin = findCodexBinary(opts.binary)
  if (!bin) {
    return {
      state: null, retryAfterSeconds: null, problem: 'codex executable not found', problemKind: 'noBinary',
    }
  }
  const body = await readRateLimitsOnce(bin)
  if (body && typeof body === 'object' && 'error' in body) {
    return {
      state: null,
      retryAfterSeconds: backoff(failCount + 1, BACKOFF_NET_BASE_S, BACKOFF_NET_MAX_S),
      problem: String((body as { error: string }).error),
      problemKind: 'retry',
    }
  }
  const state = codexStateFromBody(body, Math.floor(Date.now() / 1000), 'poll')
  return state.ok
    ? { state, retryAfterSeconds: null, raw: body }
    : {
      state: null,
      retryAfterSeconds: null,
      problem: 'app-server returned no quota windows',
      problemKind: 'empty',
      raw: body,
    }
}

export const poll: PollFn = (source, failCount, opts) =>
  source === 'claude' ? pollClaude(failCount, opts) : pollCodex(failCount, { binary: opts.codexBinary })
