// SPDX-FileCopyrightText: 2026 Frederik Marx
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * 1.12 A6: a stand-in `codex app-server` for the tests that start a real child — never the real binary.
 *
 * The script is a string here, because `build.mjs --tests` bundles only `test/**\/*.test.ts`: a separate
 * `.cjs` would not reach `out-test/`. Each test writes it into its own scratch directory and starts it as
 * `process.execPath <dir>/fake-codex-app-server.cjs <marker> <record file> [flags…]` through the injected
 * `spawnChild` — no shell, so the same on the Windows runner.
 *
 * It speaks the three methods over stdio lines: `initialize` (answered with a result, or with an error
 * under `refuse-init`), `initialized` (a notification, no answer) and `account/rateLimits/read` (answered
 * with RATE_LIMITS_BODY, or never under `no-read-answer`). Every JSON line it receives is appended to the
 * record file, so a test can hold the child's stdin to §0a.1's allow-list and count the reads. A line
 * that is not JSON is a command from the test: `push` sends an `account/rateLimits/updated` notification,
 * `exit <code>` ends the process. `trap-sigterm` ignores SIGTERM, so only SIGKILL ends it; `leak` carries
 * synthetic strings under the neighbouring keys of every answer and push, and a line that is not JSON.
 * It ends itself when its stdin closes (what a well-behaved stdio server does) and, as a last resort,
 * after FAKE_MAX_LIFE_MS — no test run can leave one behind for longer.
 */

import { ChildProcess, execFileSync, spawn } from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'

/** The fixture's file name — `pgrep -f fake-codex-app-server` after a run must print nothing (§5). */
export const FAKE_APP_SERVER_FILE = 'fake-codex-app-server.cjs'

/** The account string of the fixture's `initialize` answer — never in a log, a report, a file or a view (§0a.1). */
export const LEAK_ACCOUNT = 'synthetic-account-123'
/** The address beside the rate limits of a `leak` push and answer — never anywhere of ours (§0a.1). */
export const LEAK_EMAIL = 'synthetic-email@example.invalid'

/** The last-resort end of a fixture no test ended (ms). */
export const FAKE_MAX_LIFE_MS = 60_000

/** The percentages of the fixture's answer and of its pushes (pushes count up from PUSH_PERCENT). */
export const READ_PERCENT = 42
export const PUSH_PERCENT = 61

export const FAKE_APP_SERVER_SOURCE = String.raw`'use strict'
const fs = require('fs')
const [marker, record, ...flags] = process.argv.slice(2)
const has = (f) => flags.includes(f)
if (has('trap-sigterm')) process.on('SIGTERM', () => { /* only SIGKILL ends this one */ })
const leak = has('leak')
const LEAK_ACCOUNT = ${JSON.stringify(LEAK_ACCOUNT)}
const LEAK_EMAIL = ${JSON.stringify(LEAK_EMAIL)}
let pushes = 0
function limits(percent) {
  const body = {
    rateLimits: { planType: 'plus' },
    rateLimitsByLimitId: {
      codex: { limitId: 'codex', primary: { usedPercent: percent, windowDurationMins: 300, resetsAt: null } },
    },
  }
  if (leak) { body.account = { email: LEAK_EMAIL, id: LEAK_ACCOUNT }; body.rateLimits.note = LEAK_EMAIL }
  return body
}
function out(msg) { process.stdout.write(JSON.stringify(msg) + '\n') }
function command(line) {
  if (line === 'push') { out({ method: 'account/rateLimits/updated', params: limits(${PUSH_PERCENT} + pushes++) }); return }
  const m = /^exit (\d+)$/.exec(line)
  if (m) process.exit(Number(m[1]))
}
function onMessage(msg) {
  fs.appendFileSync(record, JSON.stringify({ marker, method: msg.method, id: msg.id === undefined ? null : msg.id }) + '\n')
  if (msg.method === 'initialize') {
    if (leak) process.stdout.write('not json ' + LEAK_EMAIL + ' ' + LEAK_ACCOUNT + ' {\n')
    if (has('refuse-init')) out({ id: msg.id, error: { code: -32600, message: 'synthetic refusal ' + LEAK_ACCOUNT } })
    else out({ id: msg.id, result: { userAgent: LEAK_ACCOUNT + '/0.0.0', account: { id: LEAK_ACCOUNT, email: LEAK_EMAIL } } })
    return
  }
  if (msg.method === 'account/rateLimits/read' && !has('no-read-answer')) out({ id: msg.id, result: limits(${READ_PERCENT}) })
}
let buf = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  buf += chunk
  let nl
  while ((nl = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, nl).trim()
    buf = buf.slice(nl + 1)
    if (!line) continue
    let msg
    try { msg = JSON.parse(line) } catch { command(line); continue }
    onMessage(msg)
  }
})
process.stdin.on('end', () => process.exit(0))
setTimeout(() => process.exit(0), ${FAKE_MAX_LIFE_MS})
`

export type FakeFlag = 'refuse-init' | 'trap-sigterm' | 'leak' | 'no-read-answer'

/** One received JSON-RPC line, as the fixture records it. */
export interface FakeRecord {
  marker: string
  method: string | undefined
  id: number | null
}

export interface FakeAppServer {
  /** The unique argument every child of this fake carries — what `pgrep -f` looks for. */
  marker: string
  /** The file the children append every received JSON line to. */
  record: string
  /** Every child started so far, in order. */
  children: ChildProcess[]
  /** The `spawnChild` edge for PersistentAppServer; `args` are the app-server's, recorded in `argsSeen`. */
  spawnChild: (bin: string, args: string[]) => ChildProcess
  argsSeen: string[][]
  /** The received lines so far. */
  received(): FakeRecord[]
  /** How many `account/rateLimits/read` the children received. */
  reads(): number
  /** A command line to the newest child (`push`, `exit 3`). */
  command(line: string): void
  /** SIGKILL to every child still running — the `finally` of every test that starts one. */
  killAll(): void
}

/**
 * Writes the fixture into `dir` and returns its spawner. `flags` apply to every child it starts;
 * `flagsFor(n)` (0-based) overrides them per start.
 */
export function fakeAppServer(dir: string, flags: FakeFlag[] = [], flagsFor?: (n: number) => FakeFlag[]): FakeAppServer {
  const script = path.join(dir, FAKE_APP_SERVER_FILE)
  fs.writeFileSync(script, FAKE_APP_SERVER_SOURCE)
  const marker = `tp-fake-${process.pid}-${Math.random().toString(36).slice(2, 10)}`
  const record = path.join(dir, `${marker}.record.jsonl`)
  fs.writeFileSync(record, '')
  const children: ChildProcess[] = []
  const argsSeen: string[][] = []
  const fake: FakeAppServer = {
    marker,
    record,
    children,
    argsSeen,
    spawnChild(_bin, args) {
      argsSeen.push([...args])
      const f = flagsFor ? flagsFor(children.length) : flags
      const child = spawn(process.execPath, [script, marker, record, ...f], {
        stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true, shell: false,
      })
      children.push(child)
      return child
    },
    received() {
      return fs.readFileSync(record, 'utf8').split('\n').filter((l) => l.trim() !== '').map((l) => JSON.parse(l) as FakeRecord)
    },
    reads() {
      return fake.received().filter((r) => r.method === 'account/rateLimits/read').length
    },
    command(line) {
      const child = children[children.length - 1]
      child?.stdin?.write(`${line}\n`)
    },
    killAll() {
      for (const c of children) {
        if (c.exitCode === null && c.signalCode === null) {
          try { c.kill('SIGKILL') } catch { /* already gone */ }
        }
      }
    },
  }
  return fake
}

/** Whether a process with `pid` exists — `kill(pid, 0)` answers ESRCH once it is gone and reaped. */
export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return (e as NodeJS.ErrnoException).code !== 'ESRCH'
  }
}

/** Polls until `cond()` holds or `withinMs` passed; whether it held. Bounded: at most withinMs / 10 checks. */
export async function waitFor(cond: () => boolean, withinMs: number): Promise<boolean> {
  const until = Date.now() + withinMs
  for (;;) {
    if (cond()) return true
    if (Date.now() >= until) return false
    await new Promise((r) => setTimeout(r, 10))
  }
}

/** Waits until the process `pid` is gone (ESRCH), at most `withinMs`; whether it went. */
export function pidGone(pid: number, withinMs = 2000): Promise<boolean> {
  return waitFor(() => !pidAlive(pid), withinMs)
}

/**
 * How many processes carry `marker` on their command line (`pgrep -f`), or null where there is no
 * pgrep (Windows) — the tests then rely on the pids alone.
 */
export function pgrepCount(marker: string): number | null {
  if (process.platform === 'win32') return null
  try {
    const out = execFileSync('pgrep', ['-f', marker], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
    return out.split('\n').filter((l) => l.trim() !== '').length
  } catch (e) {
    // pgrep exits 1 when nothing matches; anything else (no pgrep at all) is "cannot tell".
    return (e as { status?: number }).status === 1 ? 0 : null
  }
}
