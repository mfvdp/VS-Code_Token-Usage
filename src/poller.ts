import { spawn } from 'child_process'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { claudeStateFromBody, codexStateFromBody } from './quota'
import { QuotaState, Source } from './types'

/**
 * Fetches the quota directly from the provider when no external poller
 * (e.g. a panel plugin) supplies a fresh cache file.
 *
 * Two rules are not negotiable:
 *  - The access token is ONLY read, and is sent exclusively to api.anthropic.com.
 *    It is never refreshed: rotating it from here would invalidate Claude Code's
 *    own session.
 *  - The token must not appear in any log line or error message.
 */

const CLAUDE_USAGE_URL = 'https://api.anthropic.com/api/oauth/usage'
// Without a claude-code user agent the call lands in an aggressively
// rate-limited bucket and gets a permanent 429.
const USER_AGENT = 'claude-code/2.1.150'
const HTTP_TIMEOUT_MS = 20_000
const APP_SERVER_TIMEOUT_MS = 20_000
const TOKEN_SLACK_MS = 60_000

const BACKOFF_RATE_BASE_S = 600
const BACKOFF_RATE_MAX_S = 7200
const BACKOFF_NET_BASE_S = 60
const BACKOFF_NET_MAX_S = 1800

export interface PollResult {
  state: QuotaState | null
  /** Seconds until the next attempt; null = regular interval. */
  retryAfterSeconds: number | null
  problem?: string
}

function backoff(failCount: number, base: number, max: number): number {
  const delay = Math.min(base * 2 ** Math.max(0, failCount - 1), max)
  // Jitter keeps several clients from knocking again in lockstep.
  return Math.round(delay * (0.85 + Math.random() * 0.3))
}

// ------------------------------------------------------------------ Claude

interface ClaudeCredentials {
  accessToken: string
  expiresAtMs: number | null
}

function credentialsPath(claudeDir?: string): string {
  const base = claudeDir?.trim() || process.env.CLAUDE_CONFIG_DIR?.trim() || path.join(os.homedir(), '.claude')
  return path.join(base, '.credentials.json')
}

function loadCredentials(claudeDir?: string): ClaudeCredentials | { error: string } {
  const file = credentialsPath(claudeDir)
  let raw: string
  try {
    raw = fs.readFileSync(file, 'utf8')
  } catch {
    return { error: `No credentials at ${file}` }
  }
  let d: any
  try {
    d = JSON.parse(raw)
  } catch {
    return { error: 'Credentials are not valid JSON' }
  }
  const oauth = d?.claudeAiOauth
  const token = oauth?.accessToken
  if (typeof token !== 'string' || !token) return { error: 'No accessToken in the credentials' }
  const expiresAtMs = typeof oauth.expiresAt === 'number' ? oauth.expiresAt : null
  return { accessToken: token, expiresAtMs }
}

export async function pollClaude(failCount: number, claudeDir?: string): Promise<PollResult> {
  const cred = loadCredentials(claudeDir)
  if ('error' in cred) {
    return { state: null, retryAfterSeconds: null, problem: cred.error }
  }
  if (cred.expiresAtMs !== null && cred.expiresAtMs < Date.now() + TOKEN_SLACK_MS) {
    // Deliberately NO refresh: rotating the token from here would lock Claude
    // Code itself out. The user renews it simply by using Claude Code.
    return {
      state: null,
      retryAfterSeconds: null,
      problem: 'Access token expired — use Claude Code once and the credentials renew themselves',
    }
  }

  let res: Response
  try {
    res = await fetch(CLAUDE_USAGE_URL, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${cred.accessToken}`,
        'anthropic-beta': 'oauth-2025-04-20',
        'Content-Type': 'application/json',
        'User-Agent': USER_AGENT,
      },
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    })
  } catch (err) {
    // Error text deliberately generic — it must not carry anything from the request.
    const kind = (err as Error)?.name === 'TimeoutError' ? 'Timeout' : 'Network error'
    return {
      state: null,
      retryAfterSeconds: backoff(failCount + 1, BACKOFF_NET_BASE_S, BACKOFF_NET_MAX_S),
      problem: `${kind} while fetching`,
    }
  }

  if (res.status === 429 || res.status >= 500) {
    const header = Number(res.headers.get('retry-after'))
    const wait = Number.isFinite(header) && header > 0
      ? header
      : backoff(failCount + 1, BACKOFF_RATE_BASE_S, BACKOFF_RATE_MAX_S)
    return { state: null, retryAfterSeconds: wait, problem: `HTTP ${res.status} — backing off before the next attempt` }
  }
  if (res.status === 401 || res.status === 403) {
    return { state: null, retryAfterSeconds: null, problem: `HTTP ${res.status} — credentials rejected` }
  }
  if (!res.ok) {
    return {
      state: null,
      retryAfterSeconds: backoff(failCount + 1, BACKOFF_NET_BASE_S, BACKOFF_NET_MAX_S),
      problem: `HTTP ${res.status}`,
    }
  }

  let body: any
  try {
    body = await res.json()
  } catch {
    return { state: null, retryAfterSeconds: null, problem: 'Response is not valid JSON' }
  }
  const state: QuotaState = { ...claudeStateFromBody(body, Math.floor(Date.now() / 1000)), origin: 'poll' }
  return state.ok
    ? { state, retryAfterSeconds: null }
    : { state: null, retryAfterSeconds: null, problem: 'Response contained no quota windows' }
}

// ------------------------------------------------------------------- Codex

/** Locate the codex binary: setting/env, PATH, then the bundled IDE extension. */
export function findCodexBinary(override?: string): string | null {
  const candidates: string[] = []
  if (override?.trim()) candidates.push(override.trim())
  if (process.env.CODEX_CLI_PATH?.trim()) candidates.push(process.env.CODEX_CLI_PATH.trim())

  const exe = process.platform === 'win32' ? 'codex.exe' : 'codex'
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    if (dir) candidates.push(path.join(dir, exe))
  }
  // The official IDE extension ships the binary, often without putting it on PATH.
  for (const root of [path.join(os.homedir(), '.vscode', 'extensions'), path.join(os.homedir(), '.vscode-server', 'extensions')]) {
    let entries: string[]
    try {
      entries = fs.readdirSync(root)
    } catch {
      continue
    }
    for (const e of entries.filter((n) => n.startsWith('openai.chatgpt'))) {
      const bin = path.join(root, e, 'bin')
      let archs: string[]
      try {
        archs = fs.readdirSync(bin)
      } catch {
        continue
      }
      for (const a of archs) candidates.push(path.join(bin, a, exe))
    }
  }

  for (const c of candidates) {
    try {
      fs.accessSync(c, fs.constants.X_OK)
      return c
    } catch {
      /* keep looking */
    }
  }
  return null
}

export async function pollCodex(failCount: number, override?: string): Promise<PollResult> {
  const bin = findCodexBinary(override)
  if (!bin) {
    return { state: null, retryAfterSeconds: null, problem: 'codex executable not found' }
  }

  const request =
    JSON.stringify({
      id: 1,
      method: 'initialize',
      params: {
        clientInfo: { name: 'vscode-token-pace', title: 'Token Pace', version: __EXT_VERSION__ },
        capabilities: { experimentalApi: true },
      },
    }) +
    '\n' +
    JSON.stringify({ method: 'initialized', params: {} }) +
    '\n' +
    JSON.stringify({ id: 2, method: 'account/rateLimits/read', params: null }) +
    '\n'

  const body = await new Promise<any | { error: string }>((resolve) => {
    const child = spawn(bin, ['app-server', '--stdio'], { stdio: ['pipe', 'pipe', 'ignore'] })
    let buf = ''
    let done = false
    const finish = (v: any) => {
      if (done) return
      done = true
      clearTimeout(timer)
      child.kill('SIGKILL')
      resolve(v)
    }
    const timer = setTimeout(() => finish({ error: 'Timed out waiting for app-server' }), APP_SERVER_TIMEOUT_MS)

    child.on('error', (e) => finish({ error: `app-server could not start: ${e.message}` }))
    child.on('exit', () => finish({ error: 'app-server exited without answering' }))
    child.stdout.on('data', (chunk: Buffer) => {
      buf += chunk.toString('utf8')
      let nl: number
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl)
        buf = buf.slice(nl + 1)
        if (!line.trim()) continue
        let msg: any
        try {
          msg = JSON.parse(line)
        } catch {
          continue
        }
        if (msg?.id === 2) {
          if (msg.error) finish({ error: `app-server reported: ${msg.error?.message ?? 'error'}` })
          else finish(msg.result ?? {})
          return
        }
      }
    })
    child.stdin.on('error', () => {
      /* child already gone — the exit handler takes over */
    })
    child.stdin.write(request)
  })

  if (body && typeof body === 'object' && 'error' in body) {
    return {
      state: null,
      retryAfterSeconds: backoff(failCount + 1, BACKOFF_NET_BASE_S, BACKOFF_NET_MAX_S),
      problem: String(body.error),
    }
  }
  const state: QuotaState = { ...codexStateFromBody(body, Math.floor(Date.now() / 1000)), origin: 'poll' }
  return state.ok
    ? { state, retryAfterSeconds: null }
    : { state: null, retryAfterSeconds: null, problem: 'app-server returned no quota windows' }
}

export function poll(source: Source, failCount: number, opt?: string): Promise<PollResult> {
  return source === 'claude' ? pollClaude(failCount, opt) : pollCodex(failCount, opt)
}
