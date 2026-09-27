// SPDX-FileCopyrightText: 2026 Frederik Marx
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * 1.12 A6: the standing app-server connection against a real child — the stand-in of
 * test/helpers/fakeAppServer.ts, started as `process.execPath <fixture>`, never the real `codex` binary.
 *
 * Every test that starts a child ends every child it started in a `finally` and asserts its pid gone
 * (§0b.10): no test leaves a process behind. Restarts wait `restartBaseMs` 20 ms; every test has its own
 * timeout of at most 10 s and no wait inside one is longer than 5 s.
 */

import { strict as assert } from 'node:assert'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { test } from 'node:test'
import { APP_SERVER_ARGS, APP_SERVER_METHODS, AppServerTimer, PersistentAppServer } from '../src/appServer'
import { buildDiagnostics, codexConnectionDiag, DiagnosticsInput } from '../src/diagnostics'
import { pollCodex, PollResult } from '../src/poller'
import { QuotaManager, QuotaOptions, Scheduled } from '../src/quotaManager'
import { buildViewModel } from '../src/viewModel'
import { scratchDir } from './fixtures/helpers'
import { makeInput } from './fixtures/viewFixtures'
import {
  FakeAppServer, fakeAppServer, FakeFlag, LEAK_ACCOUNT, LEAK_EMAIL, pgrepCount, pidAlive, pidGone, PUSH_PERCENT,
  READ_PERCENT, waitFor,
} from './helpers/fakeAppServer'

const BASE = 1_700_000_000_000
const MIN = 60_000
const HOUR = 3_600_000
/** A real child test's own bound (node:test's timeout). */
const TEST_TIMEOUT = { timeout: 10_000 }
/** The longest a test waits for the child to do something (ms). */
const WAIT = 4_000

/** The body a one-shot read would bring — its own percentage, so a reading tells which path it came by. */
const ONE_SHOT_PERCENT = 17
const ONE_SHOT_BODY = {
  rateLimits: { planType: 'plus' },
  rateLimitsByLimitId: {
    codex: { limitId: 'codex', primary: { usedPercent: ONE_SHOT_PERCENT, windowDurationMins: 300, resetsAt: null } },
  },
}

/** Counts every timer the connection sets and lets go — "no timer is left" (A6 test 3). */
function timerSpy(): { setTimer: (fn: () => void, ms: number) => AppServerTimer; active: Set<number> } {
  const active = new Set<number>()
  let next = 0
  return {
    active,
    setTimer(fn, ms) {
      const id = next++
      active.add(id)
      const t = setTimeout(() => {
        active.delete(id)
        fn()
      }, ms)
      t.unref?.()
      return { cancel: () => { active.delete(id); clearTimeout(t) } }
    },
  }
}

/** Ends every child of `fake` and asserts each gone — the `finally` of every test here. */
async function endAll(fake: FakeAppServer): Promise<void> {
  fake.killAll()
  for (const c of fake.children) {
    if (typeof c.pid === 'number') assert.ok(await pidGone(c.pid, 2000), `the fixture's child ${c.pid} is still running`)
  }
}

interface Real {
  mgr: QuotaManager
  fake: FakeAppServer
  logs: string[]
  dir: string
  stateFile: string
  /** Codex polls started by the manager, in order, with the path each came by. */
  codexPolls: PollResult[]
  /** The binaries a one-shot read was asked of (the spy in place of `readRateLimitsOnce`). */
  oneShots: string[]
  setNow(v: number): void
  now(): number
  setConsent(v: boolean): void
  opts: QuotaOptions
}

const REAL_OPTIONS: QuotaOptions = {
  mode: 'poll',
  intervalMinutes: 30,
  claudeOrder: ['poll'],
  codexOrder: ['poll'],
  keychain: false,
  userAgent: 'honest',
  writeQuotaCache: false,
  appServerMode: 'persistent',
  pollOnlyWhenFocused: true,
}

/**
 * A QuotaManager whose app-server is a real child of the fixture (through `createAppServer`), whose Codex
 * polls are the real `pollCodex` — over the connection when it is usable — and whose one-shot read is a
 * spy. Claude answers without a reading; nothing reaches the network.
 */
function realManager(o: { flags?: FakeFlag[]; flagsFor?: (n: number) => FakeFlag[]; over?: Partial<QuotaOptions> } = {}): Real {
  const dir = scratchDir('appsrv')
  const fake = fakeAppServer(dir, o.flags ?? [], o.flagsFor)
  let current = BASE
  let consent = true
  const logs: string[] = []
  const codexPolls: PollResult[] = []
  const oneShots: string[] = []
  const stateFile = path.join(dir, 'quota.json')
  const opts = { ...REAL_OPTIONS, ...o.over }
  const mgr = new QuotaManager(
    opts,
    { stateFile, historyFile: '', mirrorFile: path.join(dir, 'mirror.json'), claudeJsonFile: path.join(dir, 'claude.json'),
      claudeCacheFile: path.join(dir, 'claude-cache.json'), codexCacheFile: path.join(dir, 'codex-cache.json') },
    (m) => logs.push(m),
    () => consent,
    () => [],
    undefined,
    {
      now: () => current,
      random: () => 0.5,
      detectClaudeVersion: async () => null,
      extVersion: '1.0.0',
      schedule: (): Scheduled => ({ cancel: () => { /* no reset re-poll here */ } }),
      findCodexBinary: () => process.execPath,
      createAppServer: (bin, log) => new PersistentAppServer(bin, log, {
        spawnChild: fake.spawnChild, restartBaseMs: 20, now: () => current,
      }),
      poll: async (source, failCount, pollOpts) => {
        if (source === 'claude') return { state: null, retryAfterSeconds: null, problem: 'no token', problemKind: 'noToken' }
        const r = await pollCodex(failCount, {
          binary: process.execPath,
          connection: pollOpts.codexConnection ?? null,
          readOnce: async (bin) => { oneShots.push(bin); return ONE_SHOT_BODY },
        })
        codexPolls.push(r)
        return r
      },
    },
  )
  return {
    mgr, fake, logs, dir, stateFile, codexPolls, oneShots, opts,
    setNow: (v) => { current = v },
    now: () => current,
    setConsent: (v) => { consent = v },
  }
}

const noop = (): void => { /* no view to update */ }

/** Ticks and waits until the connection is ready and its first read is applied. */
async function readyAndRead(h: Real, reads = 1): Promise<number> {
  h.mgr.tick(noop)
  assert.ok(await waitFor(() => h.mgr.appServerStatus().state === 'ready', WAIT), `not ready: ${h.logs.join(' | ')}`)
  assert.ok(await waitFor(() => h.codexPolls.length >= reads, WAIT), `no read applied: ${h.logs.join(' | ')}`)
  const pid = h.mgr.appServerStatus().pid
  assert.equal(typeof pid, 'number')
  return pid as number
}

function codexPercent(h: Real): number | null {
  h.mgr.invalidate()
  const codex = h.mgr.current(h.now()).find((s) => s.source === 'codex')
  return codex?.ok ? codex.windows[0].percent : null
}

// ---------------------------------------------------------------------------
// 1 · the session, and §0a.1's allow-list
// ---------------------------------------------------------------------------

test('a session: start, ready on the answer to initialize, a read over it — and the child hears the three methods only (1.12 A6 test 1, §0a.1)', TEST_TIMEOUT, async () => {
  const dir = scratchDir('appsrv')
  const fake = fakeAppServer(dir)
  const logs: string[] = []
  const srv = new PersistentAppServer(process.execPath, (m) => logs.push(m), { spawnChild: fake.spawnChild, restartBaseMs: 20 })
  try {
    assert.equal(srv.status().state, 'off')
    srv.start()
    assert.equal(srv.status().state, 'starting')
    assert.equal(srv.usable(), true)
    await srv.ready()
    assert.equal(srv.status().state, 'ready')
    assert.ok(logs.includes('codex: app-server ready'), logs.join(' | '))
    const body = await srv.readRateLimits() as { rateLimitsByLimitId: { codex: { primary: { usedPercent: number } } } }
    assert.equal(body.rateLimitsByLimitId.codex.primary.usedPercent, READ_PERCENT)
    assert.deepEqual(fake.argsSeen, [[...APP_SERVER_ARGS]])
    assert.deepEqual(fake.received().map((r) => r.method), ['initialize', 'initialized', 'account/rateLimits/read'])
    assert.deepEqual([...APP_SERVER_METHODS], ['initialize', 'initialized', 'account/rateLimits/read'])
    // A method beyond the list is refused before it reaches the child.
    await assert.rejects(srv.request('account/logout', null), /not allowed/)
    await new Promise((r) => setTimeout(r, 50))
    assert.equal(fake.received().length, 3, 'a method beyond the allow-list reached the child')
    assert.equal(srv.status().pid, fake.children[0].pid)
  } finally {
    srv.stop()
    await endAll(fake)
  }
})

// ---------------------------------------------------------------------------
// 2 · kill and restart, with the first reading over the new connection
// ---------------------------------------------------------------------------

test('a killed child is restarted after the backoff, and the new connection\'s first reading goes over it (1.12 A6 test 2, A2 rule 2, A3)', TEST_TIMEOUT, async () => {
  const h = realManager()
  try {
    const pid1 = await readyAndRead(h)
    assert.equal(h.fake.reads(), 1)
    assert.equal(h.codexPolls[0].via, 'connection')
    assert.ok(h.logs.includes('codex: quota fetched over the connection'), h.logs.join(' | '))

    process.kill(pid1, 'SIGKILL')
    assert.ok(await waitFor(() => h.logs.includes('codex: app-server exited — restart in 20 ms'), WAIT), h.logs.join(' | '))
    const restartedAt = Date.now()
    assert.ok(await waitFor(() => {
      const s = h.mgr.appServerStatus()
      return s.state === 'ready' && s.pid !== null && s.pid !== pid1
    }, WAIT), `no new ready child: ${h.logs.join(' | ')}`)
    // 2 × restartBaseMs plus a Node start — generous for a loaded runner, far below the 5 s restart of 1.x.
    assert.ok(Date.now() - restartedAt < 3_000, `the restart took ${Date.now() - restartedAt} ms`)
    assert.equal(h.mgr.appServerStatus().restartsLastHour, 1)
    // A2 rule 2: the new connection's first reading.
    assert.ok(await waitFor(() => h.fake.reads() === 2 && h.codexPolls.length === 2, WAIT), `reads ${h.fake.reads()}`)
    assert.equal(h.codexPolls[1].via, 'connection')
    assert.equal(h.oneShots.length, 0)
    assert.equal(pidAlive(pid1), false)
  } finally {
    h.mgr.dispose()
    await endAll(h.fake)
  }
})

// ---------------------------------------------------------------------------
// 3 · no process after stop — SIGKILL, even for a child that ignores SIGTERM
// ---------------------------------------------------------------------------

test('stop() ends the child with SIGKILL — a child that ignores SIGTERM is gone within 2 s, no timer is left, a second stop is harmless (1.12 A6 test 3, A4)', TEST_TIMEOUT, async () => {
  const dir = scratchDir('appsrv')
  const fake = fakeAppServer(dir, ['trap-sigterm'])
  const timers = timerSpy()
  const srv = new PersistentAppServer(process.execPath, () => undefined, {
    spawnChild: fake.spawnChild, restartBaseMs: 20, setTimer: timers.setTimer,
  })
  try {
    srv.start()
    await srv.ready()
    await srv.readRateLimits()
    const pid = srv.status().pid as number
    assert.equal(typeof pid, 'number')
    const before = pgrepCount(fake.marker)
    if (before !== null) assert.equal(before, 1)

    srv.stop()
    assert.equal(srv.status().state, 'off')
    assert.equal(srv.status().pid, null)
    assert.ok(await pidGone(pid, 2000), 'the child outlived stop() — it was not sent SIGKILL')
    const after = pgrepCount(fake.marker)
    if (after !== null) assert.equal(after, 0)
    assert.equal(timers.active.size, 0, 'a timer was left behind')
    // No restart follows a stop of ours.
    await new Promise((r) => setTimeout(r, 100))
    assert.equal(fake.children.length, 1)
    srv.stop()
    assert.equal(srv.status().state, 'off')
    await assert.rejects(srv.ready(), /not running/)
    await assert.rejects(srv.readRateLimits(), /not ready/)
  } finally {
    srv.stop()
    await endAll(fake)
  }
})

// ---------------------------------------------------------------------------
// 4 · the manager ends it — every end of A4 rule 1
// ---------------------------------------------------------------------------

const ENDS: Array<[string, (h: Real) => void]> = [
  ['dispose (deactivate)', (h) => h.mgr.dispose()],
  ['setLeader(false) (the lease lost)', (h) => h.mgr.setLeader(false)],
  ['setOptions to oneShot', (h) => h.mgr.setOptions({ ...h.opts, appServerMode: 'oneShot' })],
  ['setOptions to another codex binary', (h) => h.mgr.setOptions({ ...h.opts, codexBinary: '/elsewhere/codex' })],
  ['a tick with the consent reset', (h) => { h.setConsent(false); h.mgr.tick(noop) }],
  ['enforceGates() right after the consent reset', (h) => { h.setConsent(false); h.mgr.enforceGates() }],
  ['a tick with quotaSource auto', (h) => { h.mgr.setOptions({ ...h.opts, mode: 'auto' }); h.mgr.tick(noop) }],
]

for (const [name, end] of ENDS) {
  test(`the manager ends the standing child: ${name} — no process is left (1.12 A6 test 4, A4 rule 1)`, TEST_TIMEOUT, async () => {
    const h = realManager()
    try {
      const pid = await readyAndRead(h)
      const before = pgrepCount(h.fake.marker)
      if (before !== null) assert.equal(before, 1, 'one child per editor')
      end(h)
      assert.ok(await pidGone(pid, 2000), `the child outlived: ${name}`)
      const after = pgrepCount(h.fake.marker)
      if (after !== null) assert.equal(after, 0, `a process with the marker is left after: ${name}`)
      assert.equal(h.mgr.appServerStatus().state, 'off')
      assert.equal(h.mgr.appServerStatus().pid, null)
      // Nothing starts it again while the cause stands (a disposed manager, a follower, oneShot, a closed gate).
      if (name !== 'setOptions to another codex binary') {
        h.mgr.tick(noop)
        await new Promise((r) => setTimeout(r, 100))
        assert.equal(h.fake.children.length, 1, `a child was started again after: ${name}`)
      }
    } finally {
      h.mgr.dispose()
      await endAll(h.fake)
    }
  })
}

test('a gate reopened starts the connection again at the next tick — one child, a new session (1.12 A1, A4)', TEST_TIMEOUT, async () => {
  const h = realManager()
  try {
    const pid1 = await readyAndRead(h)
    h.setConsent(false)
    h.mgr.enforceGates()
    assert.ok(await pidGone(pid1, 2000))
    h.setConsent(true)
    h.mgr.tick(noop)
    assert.ok(await waitFor(() => h.mgr.appServerStatus().state === 'ready', WAIT), h.logs.join(' | '))
    assert.equal(h.fake.children.length, 2)
    const count = pgrepCount(h.fake.marker)
    if (count !== null) assert.equal(count, 1)
  } finally {
    h.mgr.dispose()
    await endAll(h.fake)
  }
})

// ---------------------------------------------------------------------------
// 5 · one child per read
// ---------------------------------------------------------------------------

test('with the connection ready every poll reads over it — no one-shot child; without it, one one-shot child per poll (1.12 A6 test 5, A2 rule 3)', TEST_TIMEOUT, async () => {
  const h = realManager()
  try {
    await readyAndRead(h)
    for (let i = 2; i <= 3; i++) {
      h.mgr.forcePoll(noop)
      assert.ok(await waitFor(() => h.codexPolls.length === i, WAIT), `poll ${i} did not end`)
    }
    assert.equal(h.fake.reads(), 3, 'three polls, three reads over the connection')
    assert.equal(h.oneShots.length, 0, 'a one-shot child was started beside the standing one')
    assert.deepEqual(h.codexPolls.map((r) => r.via), ['connection', 'connection', 'connection'])
    assert.equal(h.fake.children.length, 1)
    assert.equal(codexPercent(h), READ_PERCENT)
  } finally {
    h.mgr.dispose()
    await endAll(h.fake)
  }

  // The opt-out: no standing child, one one-shot read per poll.
  const o = realManager({ over: { appServerMode: 'oneShot' } })
  try {
    o.mgr.tick(noop)
    assert.ok(await waitFor(() => o.codexPolls.length === 1, WAIT))
    for (let i = 2; i <= 3; i++) {
      o.mgr.forcePoll(noop)
      assert.ok(await waitFor(() => o.codexPolls.length === i, WAIT))
    }
    assert.equal(o.oneShots.length, 3)
    assert.deepEqual(o.codexPolls.map((r) => r.via), ['oneShot', 'oneShot', 'oneShot'])
    assert.equal(o.fake.children.length, 0, 'oneShot started a standing child')
    assert.equal(codexPercent(o), ONE_SHOT_PERCENT)
  } finally {
    o.mgr.dispose()
    await endAll(o.fake)
  }
})

test('pollCodex: a usable connection is read, a connection that never became ready falls back to one child, none reads one-shot (1.12 A2 rule 3)', async () => {
  const spy: string[] = []
  const readOnce = async (bin: string): Promise<unknown> => { spy.push(bin); return ONE_SHOT_BODY }
  const over = { usable: () => true, readRateLimits: async () => ONE_SHOT_BODY }
  const r1 = await pollCodex(0, { binary: process.execPath, connection: over, readOnce })
  assert.equal(r1.via, 'connection')
  assert.equal(spy.length, 0)
  const failed = { usable: () => true, readRateLimits: async () => ({ error: 'Timed out waiting for app-server' }) }
  const r2 = await pollCodex(0, { binary: process.execPath, connection: failed, readOnce })
  assert.equal(r2.via, 'connection')
  assert.equal(r2.problem, 'Timed out waiting for app-server')
  assert.equal(r2.problemKind, 'retry')
  assert.equal(spy.length, 0, 'a failed read over the connection is reported, not repeated one-shot')
  const notReady = { usable: () => true, readRateLimits: async () => { throw new Error('app-server is not ready') } }
  const r3 = await pollCodex(0, { binary: process.execPath, connection: notReady, readOnce })
  assert.equal(r3.via, 'oneShot')
  assert.equal(spy.length, 1)
  const down = { usable: () => false, readRateLimits: async () => { throw new Error('never asked') } }
  const r4 = await pollCodex(0, { binary: process.execPath, connection: down, readOnce })
  assert.equal(r4.via, 'oneShot')
  const r5 = await pollCodex(0, { binary: process.execPath, connection: null, readOnce })
  assert.equal(r5.via, 'oneShot')
  assert.equal(spy.length, 3)
  assert.equal(r5.state?.windows[0].percent, ONE_SHOT_PERCENT)
})

// ---------------------------------------------------------------------------
// 6 · pushes defer the poll
// ---------------------------------------------------------------------------

test('pushes every half interval keep the poll away for three intervals; when they stop, one poll after an interval (1.12 A6 test 6, A2 rules 4 and 5)', TEST_TIMEOUT, async () => {
  const h = realManager()
  try {
    await readyAndRead(h)
    const polls = h.codexPolls.length
    let t = BASE
    for (let i = 1; i <= 6; i++) {
      t += 15 * MIN
      h.setNow(t)
      h.fake.command('push')
      assert.ok(await waitFor(() => h.mgr.appServerStatus().pushes === i, WAIT), `push ${i} did not arrive`)
      h.mgr.tick(noop)
      await new Promise((r) => setImmediate(r))
      assert.equal(h.codexPolls.length, polls, `a poll ran ${i * 15} min in, with a push ${15} min old`)
      assert.equal(codexPercent(h), PUSH_PERCENT + i - 1)
    }
    const status = h.mgr.appServerStatus()
    assert.equal(status.lastPushAt, t)
    // The pushes stop: after an interval without one, the poll runs — over the connection.
    h.setNow(t + 30 * MIN - 1)
    h.mgr.tick(noop)
    await new Promise((r) => setTimeout(r, 50))
    assert.equal(h.codexPolls.length, polls, 'the poll ran before the interval had passed')
    h.setNow(t + 30 * MIN)
    h.mgr.tick(noop)
    assert.ok(await waitFor(() => h.codexPolls.length === polls + 1, WAIT), 'no poll after an interval without a push')
    assert.equal(h.codexPolls[polls].via, 'connection')
  } finally {
    h.mgr.dispose()
    await endAll(h.fake)
  }
})

// ---------------------------------------------------------------------------
// 7 · the budget and its hour
// ---------------------------------------------------------------------------

test('six kills in an hour spend the budget — polls go one-shot, the diagnostics say budgetSpent — and past the hour the next tick starts it again (1.12 A6 test 7, A3 rule 2)', TEST_TIMEOUT, async () => {
  const h = realManager()
  try {
    let pid = await readyAndRead(h)
    for (let kill = 1; kill <= 5; kill++) {
      process.kill(pid, 'SIGKILL')
      const old = pid
      assert.ok(await waitFor(() => {
        const s = h.mgr.appServerStatus()
        return s.state === 'ready' && s.pid !== null && s.pid !== old
      }, WAIT), `restart ${kill} did not come: ${h.logs.join(' | ')}`)
      pid = h.mgr.appServerStatus().pid as number
    }
    assert.equal(h.mgr.appServerStatus().restartsLastHour, 5)
    process.kill(pid, 'SIGKILL')
    assert.ok(await waitFor(() => h.mgr.appServerStatus().state === 'budgetSpent', WAIT), h.logs.join(' | '))
    assert.equal(h.logs.filter((l) => l === 'codex: app-server restarted too often — fetching one-shot until the hour has passed').length, 1)
    const children = h.fake.children.length
    assert.equal(children, 6)

    // Polls go one-shot while the budget is spent — figures keep coming.
    const polls = h.codexPolls.length
    h.mgr.forcePoll(noop)
    assert.ok(await waitFor(() => h.codexPolls.length === polls + 1, WAIT))
    assert.equal(h.codexPolls[polls].via, 'oneShot')
    assert.equal(h.oneShots.length, 1)
    assert.equal(codexPercent(h), ONE_SHOT_PERCENT)
    const report = buildDiagnostics(diagInput(codexConnectionDiag(h.mgr.appServerStatus(), h.now())))
    assert.ok(report.includes('codex connection — mode persistent · state budgetSpent · restarts 5 in the last hour'), report)

    // Inside the hour a tick starts nothing.
    h.setNow(BASE + HOUR - 1)
    h.mgr.tick(noop)
    await new Promise((r) => setTimeout(r, 100))
    assert.equal(h.fake.children.length, children)
    // Past the oldest restart + 1 h the next tick starts it again.
    h.setNow(BASE + HOUR)
    h.mgr.tick(noop)
    assert.ok(await waitFor(() => h.mgr.appServerStatus().state === 'ready', WAIT), h.logs.join(' | '))
    assert.equal(h.fake.children.length, children + 1)
    assert.ok(h.logs.includes('codex: app-server starting again — the oldest restart has left the hour'))
    assert.equal(h.mgr.appServerStatus().restartsLastHour, 1, 'the start past the hour counts as a restart')
  } finally {
    h.mgr.dispose()
    await endAll(h.fake)
  }
})

// ---------------------------------------------------------------------------
// 8 · initialize refused
// ---------------------------------------------------------------------------

test('an initialize answered with an error is no ready connection: a restart is scheduled, no read is sent before a ready, the error\'s text is not logged (1.12 A6 test 8, A2 rule 1)', TEST_TIMEOUT, async () => {
  const dir = scratchDir('appsrv')
  const fake = fakeAppServer(dir, [], (n) => (n === 0 ? ['refuse-init'] : []))
  const logs: string[] = []
  const srv = new PersistentAppServer(process.execPath, (m) => logs.push(m), { spawnChild: fake.spawnChild, restartBaseMs: 20 })
  try {
    srv.start()
    const readWhileStarting = srv.readRateLimits(3_000)
    await assert.rejects(srv.ready(), /refused initialize/)
    // The read asked while starting was not sent: the connection never became ready.
    await assert.rejects(readWhileStarting, /not ready/)
    assert.ok(logs.includes('codex: app-server refused initialize'), logs.join(' | '))
    assert.equal(logs.some((l) => l.includes('synthetic refusal') || l.includes(LEAK_ACCOUNT)), false, 'the server\'s error text reached the log')
    const first = fake.children[0].pid as number
    assert.ok(await pidGone(first, 2000), 'the refusing child was not ended')
    // The restart: a new child, ready this time.
    assert.ok(await waitFor(() => srv.status().state === 'ready', WAIT), logs.join(' | '))
    await srv.readRateLimits()
    // The refusing child may be ended before it read `initialized`; the read comes after the second initialize only.
    const methods = fake.received().map((r) => r.method)
    assert.equal(methods.filter((m) => m === 'initialize').length, 2, methods.join(', '))
    assert.equal(methods.filter((m) => m === 'account/rateLimits/read').length, 1, methods.join(', '))
    assert.ok(methods.indexOf('account/rateLimits/read') > methods.lastIndexOf('initialize'), methods.join(', '))
    assert.deepEqual(methods.filter((m) => !APP_SERVER_METHODS.includes(m ?? '')), [])
    assert.equal(srv.status().restartsLastHour, 1)
  } finally {
    srv.stop()
    await endAll(fake)
  }
})

test('a read the connection leaves unanswered is a broken connection: reported as the one-shot path words it, the child ended and restarted (1.12 A2 rule 6)', TEST_TIMEOUT, async () => {
  const dir = scratchDir('appsrv')
  const fake = fakeAppServer(dir, [], (n) => (n === 0 ? ['no-read-answer'] : []))
  const logs: string[] = []
  const srv = new PersistentAppServer(process.execPath, (m) => logs.push(m), { spawnChild: fake.spawnChild, restartBaseMs: 20 })
  try {
    srv.start()
    await srv.ready()
    const pid = srv.status().pid as number
    assert.deepEqual(await srv.readRateLimits(200), { error: 'Timed out waiting for app-server' })
    assert.ok(await pidGone(pid, 2000), 'the unanswering child was not ended')
    assert.ok(await waitFor(() => srv.status().state === 'ready', WAIT), logs.join(' | '))
    assert.notEqual(srv.status().pid, pid)
    assert.ok(logs.includes('codex: app-server did not answer in time — restart in 20 ms'), logs.join(' | '))
  } finally {
    srv.stop()
    await endAll(fake)
  }
})

// ---------------------------------------------------------------------------
// 12 · §0a.1's leak test
// ---------------------------------------------------------------------------

function diagInput(codexConnection: DiagnosticsInput['codexConnection'], quota: DiagnosticsInput['quota'] = []): DiagnosticsInput {
  return {
    extVersion: '1.12.0', vscodeVersion: '1.104.0', platform: 'linux', arch: 'x64', node: '22.15.1', remoteName: null,
    extensionKind: 'workspace', roots: [], fileCount: 0,
    snapshot: { buckets: {}, bytes: 0, oldestDay: null, newestDay: null, firstIngest: null },
    retention: { hourDays: 45, days: 400, historyDays: 30 },
    historySize: { samples: 0, bytes: 0, oldest: null },
    quota, codexConnection, consent: 'granted', role: 'leader', bridge: null,
    http: {
      proxy: { value: '', origin: 'default' }, proxySupport: { value: 'off', origin: 'default' },
      proxyStrictSSL: { value: true, origin: 'default' },
    },
    proxyEnv: [], settings: {}, partialData: false, attribution: 'none',
    language: { setting: 'auto', shown: 'en', vscode: 'en' }, home: '/home/tester',
  }
}

test('nothing of the app-server\'s own answers — the initialize result, a push\'s neighbouring keys, a line that is not JSON — reaches the log, the diagnostics, quota.json or the view model (1.12 A6 test 12, §0a.1)', TEST_TIMEOUT, async () => {
  const h = realManager({ flags: ['leak'] })
  try {
    await readyAndRead(h)
    h.setNow(BASE + MIN)
    h.fake.command('push')
    assert.ok(await waitFor(() => h.mgr.appServerStatus().pushes === 1, WAIT))
    // The push's rate limits reach the reading, as since 1.0.0.
    assert.equal(codexPercent(h), PUSH_PERCENT)
    const states = h.mgr.current(h.now())
    const candidates = h.mgr.candidates()
    const drift = h.mgr.driftReport()
    const report = buildDiagnostics(diagInput(codexConnectionDiag(h.mgr.appServerStatus(), h.now()), (['claude', 'codex'] as const).map((source) => ({
      source,
      candidates: candidates[source].map((c) => ({ id: c.id, ok: c.ok, ageSec: c.ageSec, problem: c.problem ?? null })),
      backoffEndsAt: null,
      drift: drift[source],
    }))))
    const vm = JSON.stringify(buildViewModel({ ...makeInput({ quotas: states }), candidates, drift }))
    const quotaJson = fs.readFileSync(h.stateFile, 'utf8')
    const places: Array<[string, string]> = [
      ['the log', h.logs.join('\n')], ['the diagnostics report', report], ['quota.json', quotaJson], ['the view model', vm],
      ['the quota states', JSON.stringify(states)],
    ]
    for (const [where, text] of places) {
      for (const secret of [LEAK_EMAIL, LEAK_ACCOUNT]) {
        assert.equal(text.includes(secret), false, `${secret} reached ${where}`)
      }
    }
    assert.ok(report.includes('codex connection — mode persistent · state ready · restarts 0 in the last hour · pushes 1 · last push 0 s ago'), report)
    assert.ok(quotaJson.includes(`"percent":${PUSH_PERCENT}`), 'the push did not reach quota.json')
  } finally {
    h.mgr.dispose()
    await endAll(h.fake)
  }
})
