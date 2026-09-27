// SPDX-FileCopyrightText: 2026 Frederik Marx
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The Codex app-server client.
 *
 * `codex app-server --stdio` speaks line-delimited JSON-RPC and answers
 * `account/rateLimits/read` without any network call of our own — the binary is
 * already signed in. Two lifecycles are supported: a standing connection (1.12 A,
 * `tokenPace.codexAppServer.mode: persistent`, the default since 1.12) that keeps one
 * child and its session, reads over it and receives `account/rateLimits/updated`
 * pushes, and a one-shot spawn per poll — the opt-out, and the fallback while the
 * standing connection is down.
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

/** The arguments every app-server child is started with — the one-shot's and the standing one's. */
export const APP_SERVER_ARGS: readonly string[] = ['app-server', '--stdio']
/** 1.12 §0a.1: the only methods ever sent to an app-server — a test holds the child's stdin to them. */
export const APP_SERVER_METHODS: readonly string[] = ['initialize', 'initialized', 'account/rateLimits/read']
const ALLOWED_METHODS: ReadonlySet<string> = new Set(APP_SERVER_METHODS)
const READ_METHOD = 'account/rateLimits/read'
const RATE_LIMITS_UPDATED = 'account/rateLimits/updated'
/** The id `initialize` is sent with; requests count on from 2. */
const INITIALIZE_ID = 1

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
      child = spawn(bin, [...APP_SERVER_ARGS], { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true, shell: false })
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

/** A timer as the connection uses it: the restart's wait, a request's and `initialize`'s timeout. */
export interface AppServerTimer {
  cancel(): void
}

/**
 * 1.12 A (§2.1): the edges of the standing connection — the one process start, the timers and the
 * clock — injectable, so a test spawns `process.execPath <fixture>`, counts every timer and moves the
 * budget's hour without waiting for it.
 */
export interface AppServerDeps {
  /** The one process start; default: child_process.spawn without a shell, stderr ignored. */
  spawnChild: (bin: string, args: string[]) => ChildProcess
  /** Every timer of the connection goes through here; default setTimeout + unref. */
  setTimer: (fn: () => void, ms: number) => AppServerTimer
  now: () => number
  /** The first restart's wait, doubled per restart in the hour: RESTART_BASE_MS by default; a test passes 20. */
  restartBaseMs: number
}

/**
 * 1.12 A: where the standing connection is. `off` — not started, or stopped by Token Pace; `starting` —
 * the child runs and `initialize` has not been answered yet; `ready` — answered without an error, reads
 * and pushes go over it; `restarting` — it exited (or was ended as broken) and a restart waits;
 * `budgetSpent` — RESTART_BUDGET restarts in the last hour, each fetch starts its own child until the
 * oldest of them leaves the hour (A3 rule 2).
 */
export type AppServerState = 'off' | 'starting' | 'ready' | 'restarting' | 'budgetSpent'

export interface AppServerStatus {
  state: AppServerState
  restartsLastHour: number
  /** `account/rateLimits/updated` notifications received since this connection was made. */
  pushes: number
  /** When the last of them came (ms), or null. */
  lastPushAt: number | null
  /** The running child's pid — for the tests only; the diagnostics print no pid. */
  pid: number | null
}

/** 1.12 A (§2.1): what the poller needs of a live connection. */
export interface CodexConnection {
  /**
   * `account/rateLimits/read` over the connection. Resolves with the answer's `result`, or with
   * `{ error }` in the one-shot path's words when the connection answered with an error, timed out or
   * exited during the read; rejects when there was no connection to ask (not ready within the wait) —
   * the caller then starts its own child once, as the one-shot path does.
   */
  readRateLimits(timeoutMs?: number): Promise<unknown>
  /** Whether a read is worth trying: the connection is ready, or starting and may be ready within the wait. */
  usable(): boolean
}

interface Pending {
  resolve: (v: any) => void
  reject: (e: Error) => void
  timer: AppServerTimer
  method: string
}

interface Deferred {
  promise: Promise<void>
  resolve: () => void
  reject: (e: Error) => void
}

function deferred(): Deferred {
  let resolve: () => void = () => undefined
  let reject: (e: Error) => void = () => undefined
  const promise = new Promise<void>((res, rej) => { resolve = res; reject = rej })
  // A start nobody waited for must not surface as an unhandled rejection when it fails.
  promise.catch(() => undefined)
  return { promise, resolve, reject }
}

function defaultTimer(fn: () => void, ms: number): AppServerTimer {
  const t = setTimeout(fn, ms)
  t.unref?.()
  return { cancel: () => clearTimeout(t) }
}

function defaultSpawn(bin: string, args: string[]): ChildProcess {
  return spawn(bin, args, { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true, shell: false })
}

/** A wait as the log says it: whole seconds, or milliseconds below one. */
function waitText(ms: number): string {
  return ms < 1000 ? `${Math.round(ms)} ms` : `${Math.round(ms / 1000)} s`
}

/** A spawn failure as the log names it: Node's error code only, never a message that may carry a path. */
function codeOf(e: unknown): string {
  const code = (e as { code?: unknown })?.code
  return typeof code === 'string' && /^[A-Z0-9_]{1,32}$/.test(code) ? code : 'error'
}

/**
 * The standing app-server connection (1.12 A): one long-lived `codex app-server --stdio` child, its
 * JSON-RPC session kept.
 *
 * `start()` sends `initialize` (id 1) and `initialized`; the answer to id 1 without an error makes the
 * connection `ready` (A2 rule 1) — nothing of that answer is kept (§0a.1). Reads go over it
 * (`readRateLimits`), and `account/rateLimits/updated` arrives as a push, counted for the diagnostics
 * and handed to the listeners. An exit, an error, a refused or unanswered `initialize` or a read that
 * times out ends the child and schedules a restart with a doubling wait; after RESTART_BUDGET restarts in
 * an hour the connection stays down (`budgetSpent`) until the oldest of them leaves the hour, when the
 * next `start()` starts it again (A3). `stop()` ends it with SIGKILL and schedules nothing (A4).
 *
 * Only three methods are ever sent — APP_SERVER_METHODS, §0a.1's allow-list —, the child's stderr is
 * never read, and no line of its stdout reaches the log.
 */
export class PersistentAppServer {
  private readonly deps: AppServerDeps
  private child: ChildProcess | null = null
  private state: AppServerState = 'off'
  private buf = ''
  private nextId = 2
  private pending = new Map<number, Pending>()
  /** One in-flight request per method: a second caller joins the first. */
  private inFlight = new Map<string, Promise<any>>()
  private listeners = new Set<NotificationCb>()
  private readyListeners = new Set<() => void>()
  /** The current start's wait for the answer to `initialize`, and its timeout. */
  private readyWait: Deferred | null = null
  private initTimer: AppServerTimer | null = null
  /** When each counted restart began (ms) — pruned to the last hour. */
  private restarts: number[] = []
  private restartTimer: AppServerTimer | null = null
  private stopped = true
  private exitHook: (() => void) | null = null
  private budgetLogged = false
  private pushes = 0
  private lastPushAt: number | null = null

  constructor(
    private readonly bin: string,
    private readonly log: (m: string) => void,
    deps: Partial<AppServerDeps> = {},
  ) {
    this.deps = {
      spawnChild: deps.spawnChild ?? defaultSpawn,
      setTimer: deps.setTimer ?? defaultTimer,
      now: deps.now ?? (() => Date.now()),
      restartBaseMs: deps.restartBaseMs ?? RESTART_BASE_MS,
    }
  }

  get alive(): boolean {
    return this.child !== null && this.child.exitCode === null && !this.child.killed
  }

  /**
   * Starts the child unless it runs or a restart is waiting. After the restart budget (`budgetSpent`) it
   * starts again only once the oldest counted restart has left the hour — and that start counts as a
   * restart, so a broken binary is still started at most RESTART_BUDGET times an hour (A3 rule 2).
   */
  start(): void {
    this.stopped = false
    if (this.child) return
    // A restart is already on its way; starting now would leave two children.
    if (this.restartTimer) return
    if (this.state === 'budgetSpent') {
      if (!this.budgetHasRoom()) return
      this.restarts.push(this.deps.now())
      this.budgetLogged = false
      this.log('codex: app-server starting again — the oldest restart has left the hour')
    }
    this.spawn()
  }

  /** Ends the child with SIGKILL (A4 rule 1) and schedules nothing; a second call does nothing more. */
  stop(): void {
    this.stopped = true
    if (this.restartTimer) {
      this.restartTimer.cancel()
      this.restartTimer = null
    }
    const child = this.child
    this.child = null
    this.detach()
    if (child) {
      try { child.kill('SIGKILL') } catch { /* already gone */ }
    }
    this.endStart(new Error('app-server stopped'))
    this.failPending('app-server stopped')
    this.inFlight.clear()
    this.state = 'off'
  }

  /** Resolves when the answer to `initialize` came without an error; rejects on an error, an exit or the timeout. */
  ready(): Promise<void> {
    if (this.state === 'ready') return Promise.resolve()
    if (this.state === 'starting' && this.readyWait) return this.readyWait.promise
    return Promise.reject(new Error('app-server is not running'))
  }

  /** CodexConnection: a read is worth trying while the connection is ready or starting. */
  usable(): boolean {
    return this.state === 'ready' || this.state === 'starting'
  }

  /**
   * `account/rateLimits/read` over the ready connection — the one-shot path's method, and its answer in
   * the one-shot path's shape: the `result`, or `{ error }` in its words. A read asked while `starting`
   * waits for `ready` up to its own timeout and rejects when the connection did not become ready (the
   * caller falls back to one child of its own); a read that times out ends the child as broken and
   * schedules a restart (A2 rule 6).
   */
  async readRateLimits(timeoutMs = APP_SERVER_TIMEOUT_MS): Promise<unknown> {
    if (this.state === 'starting') await this.waitReady(timeoutMs)
    if (this.state !== 'ready') throw new Error('app-server is not ready')
    try {
      return await this.request(READ_METHOD, null, timeoutMs)
    } catch (e) {
      return { error: (e as Error).message }
    }
  }

  status(): AppServerStatus {
    const now = this.deps.now()
    return {
      state: this.state,
      restartsLastHour: this.restarts.filter((t) => now - t < HOUR_MS).length,
      pushes: this.pushes,
      lastPushAt: this.lastPushAt,
      pid: this.child?.pid ?? null,
    }
  }

  /**
   * Single-flight per method: a concurrent caller shares the pending answer. Only a method of
   * APP_SERVER_METHODS is ever sent (§0a.1); an error answer rejects in the one-shot path's words
   * (`app-server reported: …`), a timeout ends the child as broken.
   */
  request(method: string, params: any, timeoutMs = APP_SERVER_TIMEOUT_MS): Promise<any> {
    const running = this.inFlight.get(method)
    if (running) return running
    const p = new Promise<any>((resolve, reject) => {
      if (!ALLOWED_METHODS.has(method)) {
        reject(new Error(`app-server method not allowed: ${method}`))
        return
      }
      const child = this.child
      if (!this.alive || child === null) {
        reject(new Error('app-server is not running'))
        return
      }
      // Nothing but `initialize` and `initialized` goes to a child before it answered the first (A2 rule 1).
      if (this.state !== 'ready') {
        reject(new Error('app-server is not ready'))
        return
      }
      const id = this.nextId++
      const timer = this.deps.setTimer(() => {
        if (!this.pending.has(id)) return
        this.pending.delete(id)
        reject(new Error('Timed out waiting for app-server'))
        this.breakConnection(child, 'did not answer in time')
      }, timeoutMs)
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

  /** Called on every `ready` — the first and after each restart (A2 rule 2's first reading). */
  onReady(cb: () => void): { dispose(): void } {
    this.readyListeners.add(cb)
    return { dispose: () => { this.readyListeners.delete(cb) } }
  }

  // ------------------------------------------------------------------ internals

  private spawn(): void {
    let child: ChildProcess
    try {
      child = this.deps.spawnChild(this.bin, [...APP_SERVER_ARGS])
    } catch (e) {
      this.log(`codex: app-server could not start (${codeOf(e)})`)
      this.scheduleRestart('could not start')
      return
    }
    this.child = child
    this.buf = ''
    this.state = 'starting'
    this.readyWait = deferred()
    // Orphan safety: a child that outlives the extension host would keep a
    // signed-in process running invisibly.
    this.exitHook = () => {
      try { child.kill('SIGKILL') } catch { /* already gone */ }
    }
    process.on('exit', this.exitHook)

    child.on('error', (e) => this.gone(child, `could not start (${codeOf(e)})`))
    child.on('exit', () => this.gone(child, 'exited'))
    child.stdout?.on('data', (chunk: Buffer) => {
      if (this.child === child) this.onData(child, chunk)
    })
    child.stdin?.on('error', () => { /* the exit handler takes over */ })

    // The answer to id 1 is awaited, matched and checked (A2 rule 1) — within the request timeout.
    this.initTimer = this.deps.setTimer(() => {
      this.initTimer = null
      this.endStart(new Error('app-server did not answer initialize'))
      this.breakConnection(child, 'did not answer initialize')
    }, APP_SERVER_TIMEOUT_MS)
    this.send({ id: INITIALIZE_ID, method: 'initialize', params: initializeParams() })
    this.send({ method: 'initialized', params: {} })
  }

  /**
   * The answer to `initialize`: without an error the connection is `ready`; with one it is refused — the
   * child is ended and a restart scheduled. Nothing of the answer is kept (§0a.1), and the error's text,
   * being the server's, is not logged.
   */
  private onInitializeAnswer(child: ChildProcess, refused: boolean): void {
    if (this.child !== child) return
    if (this.initTimer) {
      this.initTimer.cancel()
      this.initTimer = null
    }
    if (refused) {
      this.log('codex: app-server refused initialize')
      this.endStart(new Error('app-server refused initialize'))
      this.breakConnection(child, 'refused initialize')
      return
    }
    this.state = 'ready'
    this.log('codex: app-server ready')
    this.readyWait?.resolve()
    this.readyWait = null
    for (const cb of [...this.readyListeners]) {
      try {
        cb()
      } catch {
        /* a listener must not take the connection down */
      }
    }
  }

  /** Waits for `ready` up to `timeoutMs`; the timer is cancelled either way. */
  private async waitReady(timeoutMs: number): Promise<void> {
    let timer: AppServerTimer | null = null
    try {
      await Promise.race([
        this.ready(),
        new Promise<void>((_res, rej) => {
          timer = this.deps.setTimer(() => rej(new Error('app-server not ready in time')), timeoutMs)
        }),
      ])
    } catch {
      /* the caller reads the state */
    } finally {
      (timer as AppServerTimer | null)?.cancel()
    }
  }

  private send(msg: { method: string } & Record<string, unknown>): void {
    // §0a.1: nothing but the three methods ever reaches the child.
    if (!ALLOWED_METHODS.has(msg.method)) return
    try {
      this.child?.stdin?.write(`${JSON.stringify(msg)}\n`)
    } catch {
      /* a dead pipe surfaces as the exit event */
    }
  }

  /** The start's wait ends without a `ready`: its waiters are told, its timeout cancelled. */
  private endStart(why: Error): void {
    if (this.initTimer) {
      this.initTimer.cancel()
      this.initTimer = null
    }
    this.readyWait?.reject(why)
    this.readyWait = null
  }

  private onData(child: ChildProcess, chunk: Buffer): void {
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
        // Never the line itself: it is the server's text (§0a.1).
        continue
      }
      if (msg?.id === INITIALIZE_ID && this.state === 'starting' && this.initTimer !== null) {
        this.onInitializeAnswer(child, msg.error !== undefined && msg.error !== null)
        if (this.child !== child) return
        continue
      }
      if (typeof msg?.id === 'number' && this.pending.has(msg.id)) {
        const p = this.pending.get(msg.id)!
        this.pending.delete(msg.id)
        p.timer.cancel()
        if (msg.error) p.reject(new Error(`app-server reported: ${String(msg.error?.message ?? 'error')}`))
        else p.resolve(msg.result ?? {})
        continue
      }
      if (typeof msg?.method === 'string' && msg.id === undefined) {
        if (msg.method === RATE_LIMITS_UPDATED) {
          this.pushes += 1
          this.lastPushAt = this.deps.now()
        }
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

  /** The child exited or failed to start: forget it and, unless Token Pace stopped it, restart. */
  private gone(child: ChildProcess, why: string): void {
    // A child already let go (stopped, or ended as broken) — its late events change nothing.
    if (this.child !== child) return
    this.detach()
    this.child = null
    this.endStart(new Error(`app-server ${why}`))
    this.failPending('app-server exited without answering')
    if (this.stopped) {
      this.state = 'off'
      return
    }
    this.scheduleRestart(why)
  }

  /**
   * A connection that refused `initialize` or left a request unanswered is broken (A2 rules 1 and 6):
   * the child is ended with SIGKILL and a restart scheduled at once — its late exit event is ignored.
   */
  private breakConnection(child: ChildProcess, why: string): void {
    if (this.child !== child) return
    this.child = null
    this.detach()
    try { child.kill('SIGKILL') } catch { /* already gone */ }
    this.endStart(new Error(`app-server ${why}`))
    this.failPending('app-server exited without answering')
    this.inFlight.clear()
    if (this.stopped) {
      this.state = 'off'
      return
    }
    this.scheduleRestart(why)
  }

  private detach(): void {
    if (this.exitHook) {
      process.removeListener('exit', this.exitHook)
      this.exitHook = null
    }
  }

  private failPending(reason: string): void {
    for (const [, p] of this.pending) {
      p.timer.cancel()
      p.reject(new Error(reason))
    }
    this.pending.clear()
  }

  /** Prunes the counted restarts to the last hour; whether one more fits the budget. */
  private budgetHasRoom(): boolean {
    const now = this.deps.now()
    this.restarts = this.restarts.filter((t) => now - t < HOUR_MS)
    return this.restarts.length < RESTART_BUDGET
  }

  /**
   * Exponential backoff with an hourly budget: a binary that dies immediately must not be respawned in a
   * loop. Past the budget the connection is `budgetSpent` — fetches start their own child (A2 rule 3) —
   * until the oldest counted restart leaves the hour (A3 rule 2; 1.0.0 stayed off for the session).
   */
  private scheduleRestart(why: string): void {
    if (this.stopped || this.restartTimer) return
    if (!this.budgetHasRoom()) {
      this.state = 'budgetSpent'
      if (!this.budgetLogged) {
        this.budgetLogged = true
        this.log('codex: app-server restarted too often — fetching one-shot until the hour has passed')
      }
      return
    }
    const delay = Math.min(this.deps.restartBaseMs * 2 ** this.restarts.length, RESTART_MAX_MS)
    this.restarts.push(this.deps.now())
    this.state = 'restarting'
    this.log(`codex: app-server ${why} — restart in ${waitText(delay)}`)
    this.restartTimer = this.deps.setTimer(() => {
      this.restartTimer = null
      if (!this.stopped) this.spawn()
    }, delay)
  }
}
