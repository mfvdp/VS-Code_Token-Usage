// SPDX-FileCopyrightText: 2026 Frederik Marx
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The Codex app-server client.
 *
 * `codex app-server --stdio` speaks line-delimited JSON-RPC and answers
 * `account/rateLimits/read` without any network call of our own — the binary is
 * already signed in. Two lifecycles are supported: a one-shot spawn per poll
 * (the default, no long-lived child) and a persistent connection that also
 * receives `account/rateLimits/updated` pushes.
 */

import { ChildProcess, spawn } from 'child_process'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

const APP_SERVER_TIMEOUT_MS = 20_000
const RESTART_BASE_MS = 5_000
const RESTART_MAX_MS = 300_000
/** More than this in an hour means the binary is broken, not the connection. */
const RESTART_BUDGET = 5
const HOUR_MS = 3_600_000

/** The extension version is a build-time define; tests load the module without it. */
function extVersion(): string {
  return typeof __EXT_VERSION__ === 'string' ? __EXT_VERSION__ : '0.0.0'
}

function initializeParams(): unknown {
  return {
    clientInfo: { name: 'vscode-token-pace', title: 'Token Pace', version: extVersion() },
    capabilities: { experimentalApi: true },
  }
}

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
  for (const root of [
    path.join(os.homedir(), '.vscode', 'extensions'),
    path.join(os.homedir(), '.vscode-server', 'extensions'),
  ]) {
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

/**
 * One spawn, one answer, then SIGKILL.
 *
 * The child is killed rather than asked to exit: an app-server that did not
 * answer within the timeout is not going to shut down politely either, and a
 * stuck child would outlive the window.
 */
export function readRateLimitsOnce(
  bin: string, timeoutMs = APP_SERVER_TIMEOUT_MS,
): Promise<any | { error: string }> {
  const request =
    `${JSON.stringify({ id: 1, method: 'initialize', params: initializeParams() })}\n`
    + `${JSON.stringify({ method: 'initialized', params: {} })}\n`
    + `${JSON.stringify({ id: 2, method: 'account/rateLimits/read', params: null })}\n`

  return new Promise<any | { error: string }>((resolve) => {
    let child: ChildProcess
    try {
      child = spawn(bin, ['app-server', '--stdio'], { stdio: ['pipe', 'pipe', 'ignore'] })
    } catch (e) {
      resolve({ error: `app-server could not start: ${(e as Error).message}` })
      return
    }
    let buf = ''
    let done = false
    const finish = (v: any) => {
      if (done) return
      done = true
      clearTimeout(timer)
      child.kill('SIGKILL')
      resolve(v)
    }
    const timer = setTimeout(() => finish({ error: 'Timed out waiting for app-server' }), timeoutMs)
    timer.unref?.()

    child.on('error', (e) => finish({ error: `app-server could not start: ${e.message}` }))
    child.on('exit', () => finish({ error: 'app-server exited without answering' }))
    child.stdout?.on('data', (chunk: Buffer) => {
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
    child.stdin?.on('error', () => {
      /* child already gone — the exit handler takes over */
    })
    child.stdin?.write(request)
  })
}

type NotificationCb = (method: string, params: any) => void

interface Pending {
  resolve: (v: any) => void
  reject: (e: Error) => void
  timer: NodeJS.Timeout
  method: string
}

/**
 * A long-lived app-server connection with push notifications.
 *
 * Opt-in (`codexAppServer.mode`), because it keeps a child process per VS Code
 * window. `account/rateLimits/updated` then arrives as data — not as a trigger
 * for a second read — and the fallback timer is reset instead of stacked.
 */
export class PersistentAppServer {
  private child: ChildProcess | null = null
  private buf = ''
  private nextId = 3
  private pending = new Map<number, Pending>()
  /** One in-flight request per method: a second caller joins the first. */
  private inFlight = new Map<string, Promise<any>>()
  private listeners = new Set<NotificationCb>()
  private restarts: number[] = []
  private restartTimer: NodeJS.Timeout | null = null
  private stopped = true
  private exitHook: (() => void) | null = null
  private budgetLogged = false

  constructor(private readonly bin: string, private readonly log: (m: string) => void) {}

  get alive(): boolean {
    return this.child !== null && this.child.exitCode === null && !this.child.killed
  }

  start(): void {
    this.stopped = false
    if (this.child) return
    // A restart is already on its way; starting now would leave two children.
    if (this.restartTimer) return
    let child: ChildProcess
    try {
      child = spawn(this.bin, ['app-server', '--stdio'], { stdio: ['pipe', 'pipe', 'ignore'] })
    } catch (e) {
      this.log(`codex app-server could not start: ${(e as Error).message}`)
      this.scheduleRestart()
      return
    }
    this.child = child
    this.buf = ''
    // Orphan safety: a child that outlives the extension host would keep a
    // signed-in process running invisibly.
    this.exitHook = () => {
      try { child.kill('SIGKILL') } catch { /* already gone */ }
    }
    process.on('exit', this.exitHook)

    child.on('error', (e) => {
      this.log(`codex app-server error: ${e.message}`)
      this.handleExit()
    })
    child.on('exit', () => this.handleExit())
    child.stdout?.on('data', (chunk: Buffer) => this.onData(chunk))
    child.stdin?.on('error', () => { /* the exit handler takes over */ })

    this.send({ id: 1, method: 'initialize', params: initializeParams() })
    this.send({ method: 'initialized', params: {} })
  }

  stop(): void {
    this.stopped = true
    if (this.restartTimer) {
      clearTimeout(this.restartTimer)
      this.restartTimer = null
    }
    this.detach()
    const child = this.child
    this.child = null
    if (child) {
      try { child.kill('SIGKILL') } catch { /* already gone */ }
    }
    this.failPending('app-server stopped')
    this.inFlight.clear()
  }

  /** Single-flight per method: a concurrent caller shares the pending answer. */
  request(method: string, params: any, timeoutMs = APP_SERVER_TIMEOUT_MS): Promise<any> {
    const running = this.inFlight.get(method)
    if (running) return running
    const p = new Promise<any>((resolve, reject) => {
      if (!this.alive) {
        reject(new Error('app-server is not running'))
        return
      }
      const id = this.nextId++
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`Timed out waiting for ${method}`))
      }, timeoutMs)
      timer.unref?.()
      this.pending.set(id, { resolve, reject, timer, method })
      this.send({ id, method, params })
    }).finally(() => {
      this.inFlight.delete(method)
    })
    this.inFlight.set(method, p)
    return p
  }

  onNotification(cb: NotificationCb): { dispose(): void } {
    this.listeners.add(cb)
    return { dispose: () => { this.listeners.delete(cb) } }
  }

  private send(msg: unknown): void {
    try {
      this.child?.stdin?.write(`${JSON.stringify(msg)}\n`)
    } catch {
      /* a dead pipe surfaces as the exit event */
    }
  }

  private onData(chunk: Buffer): void {
    this.buf += chunk.toString('utf8')
    let nl: number
    while ((nl = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, nl)
      this.buf = this.buf.slice(nl + 1)
      if (!line.trim()) continue
      let msg: any
      try {
        msg = JSON.parse(line)
      } catch {
        continue
      }
      if (typeof msg?.id === 'number' && this.pending.has(msg.id)) {
        const p = this.pending.get(msg.id)!
        this.pending.delete(msg.id)
        clearTimeout(p.timer)
        if (msg.error) p.reject(new Error(String(msg.error?.message ?? 'app-server error')))
        else p.resolve(msg.result ?? {})
        continue
      }
      if (typeof msg?.method === 'string' && msg.id === undefined) {
        for (const cb of [...this.listeners]) {
          try {
            cb(msg.method, msg.params)
          } catch {
            /* a listener must not take the connection down */
          }
        }
      }
    }
  }

  private handleExit(): void {
    this.detach()
    this.child = null
    this.failPending('app-server exited')
    if (!this.stopped) this.scheduleRestart()
  }

  private detach(): void {
    if (this.exitHook) {
      process.removeListener('exit', this.exitHook)
      this.exitHook = null
    }
  }

  private failPending(reason: string): void {
    for (const [, p] of this.pending) {
      clearTimeout(p.timer)
      p.reject(new Error(reason))
    }
    this.pending.clear()
  }

  /**
   * Exponential backoff with an hourly budget: a binary that dies immediately
   * must not be respawned in a loop for the rest of the session.
   */
  private scheduleRestart(): void {
    if (this.stopped || this.restartTimer) return
    const now = Date.now()
    this.restarts = this.restarts.filter((t) => now - t < HOUR_MS)
    if (this.restarts.length >= RESTART_BUDGET) {
      if (!this.budgetLogged) {
        this.budgetLogged = true
        this.log('codex app-server restarted too often — staying off until the mode changes')
      }
      return
    }
    const delay = Math.min(RESTART_BASE_MS * 2 ** this.restarts.length, RESTART_MAX_MS)
    this.restarts.push(now)
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null
      if (!this.stopped) this.start()
    }, delay)
    this.restartTimer.unref?.()
  }
}
