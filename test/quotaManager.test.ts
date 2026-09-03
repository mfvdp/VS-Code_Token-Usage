// SPDX-FileCopyrightText: 2026 Frederik Marx
// SPDX-License-Identifier: AGPL-3.0-or-later

import { strict as assert } from 'node:assert'
import * as fs from 'node:fs'
import { createRequire } from 'node:module'
import * as path from 'node:path'
import { test } from 'node:test'
import { PollOptions, PollResult } from '../src/poller'
import {
  HistorySink, QuotaDeps, QuotaFiles, QuotaManager, QuotaOptions, Scheduled,
} from '../src/quotaManager'
import { QuotaState, Source } from '../src/types'
import { scratchDir } from './fixtures/helpers'

const BASE = 1_700_000_000_000
const MIN = 60_000

function flush(): Promise<void> {
  return new Promise((r) => setImmediate(() => setImmediate(() => r())))
}

const OPTIONS: QuotaOptions = {
  mode: 'poll',
  intervalMinutes: 30,
  claudeOrder: ['cacheFile', 'statusline', 'claudeJson', 'poll'],
  codexOrder: ['cacheFile', 'transcript', 'poll'],
  keychain: false,
  userAgent: 'honest',
  writeQuotaCache: false,
  appServerMode: 'oneShot',
  pollOnlyWhenFocused: true,
}

interface Harness {
  mgr: QuotaManager
  dir: string
  files: QuotaFiles
  polls: Array<{ source: Source; opts: PollOptions }>
  scheduled: Array<{ delay: number; fn: () => void }>
  added: Array<{ state: QuotaState; fingerprint: string }>
  logs: string[]
  setNow(v: number): void
  now(): number
  writeClaudeCache(fetchedAtSec: number, percent: number, resetsAt: string | null, extra?: unknown): void
}

function claudeState(fetchedAtSec: number, percent = 50): QuotaState {
  return {
    source: 'claude', ok: true, origin: 'poll', fetchedAt: fetchedAtSec, planType: 'max',
    windows: [{
      id: 'session:300', kind: 'session', label: '5 h', shortLabel: '5h', model: null,
      percent, resetsAt: null, windowMinutes: 300, limitReached: false, unlimited: false,
    }],
  }
}

function harness(
  optOver: Partial<QuotaOptions> = {},
  depOver: Partial<QuotaDeps> = {},
  consented: () => boolean = () => true,
  pollResult: (source: Source) => PollResult = (source) =>
    (source === 'claude'
      ? { state: claudeState(BASE / 1000), retryAfterSeconds: null, raw: { limits: [] } }
      : { state: null, retryAfterSeconds: null, problem: 'no binary', problemKind: 'noBinary' }),
): Harness {
  const dir = scratchDir('qmgr')
  let current = BASE
  const polls: Harness['polls'] = []
  const scheduled: Harness['scheduled'] = []
  const added: Harness['added'] = []
  const logs: string[] = []
  const files: QuotaFiles = {
    stateFile: path.join(dir, 'quota.json'),
    historyFile: path.join(dir, 'quotaHistory.json'),
    mirrorFile: path.join(dir, 'mirror.json'),
    claudeJsonFile: path.join(dir, 'claude.json'),
    claudeCacheFile: path.join(dir, 'claude-cache.json'),
    codexCacheFile: path.join(dir, 'codex-cache.json'),
  }
  const history: HistorySink = {
    add(state, fingerprint) {
      added.push({ state, fingerprint })
      return state.windows.length
    },
    save() { /* nothing to persist in the test */ },
  }
  const deps: QuotaDeps = {
    now: () => current,
    random: () => 0.5,
    detectClaudeVersion: async () => '9.9.9',
    extVersion: '1.0.0',
    findCodexBinary: () => null,
    schedule: (fn, delay): Scheduled => {
      scheduled.push({ delay, fn })
      return { cancel: () => { /* nothing to cancel in the test */ } }
    },
    poll: async (source, _failCount, opts) => {
      polls.push({ source, opts })
      return pollResult(source)
    },
    ...depOver,
  }
  const mgr = new QuotaManager(
    { ...OPTIONS, ...optOver }, files, (m) => logs.push(m), consented, () => [], history, deps,
  )
  return {
    mgr, dir, files, polls, scheduled, added, logs,
    setNow: (v) => { current = v },
    now: () => current,
    writeClaudeCache(fetchedAtSec, percent, resetsAt, extra) {
      fs.writeFileSync(files.claudeCacheFile!, JSON.stringify({
        schema_version: 1, fetched_at: fetchedAtSec, fail_count: 0, blocked_until: 0,
        body: {
          limits: [{
            kind: 'session', group: 'session', percent, severity: 'normal', resets_at: resetsAt, scope: null,
          }],
          ...(extra ?? {}),
        },
      }))
    },
  }
}

test('a reset schedules exactly one re-poll per window and cycle, with jitter', async () => {
  const h = harness()
  const resetMs = BASE + 10 * MIN
  h.writeClaudeCache((BASE - 20 * MIN) / 1000, 80, new Date(resetMs).toISOString())

  h.mgr.current(BASE)
  assert.equal(h.scheduled.length, 1)
  const delay = h.scheduled[0].delay
  // resetsAt + 5 s + jitter(0..10 s), measured from now.
  assert.ok(delay >= resetMs + 5_000 - BASE, `delay ${delay} too small`)
  assert.ok(delay <= resetMs + 15_000 - BASE, `delay ${delay} too large`)

  // Reading it again does not stack a second trigger for the same cycle.
  h.mgr.current(BASE + MIN)
  assert.equal(h.scheduled.length, 1)

  // A new cycle (a different resetsAt) gets its own single trigger.
  h.writeClaudeCache((BASE - 19 * MIN) / 1000, 5, new Date(resetMs + 5 * 3_600_000).toISOString())
  h.mgr.current(BASE + 2 * MIN)
  assert.equal(h.scheduled.length, 2)
})

test('the reset trigger fetches once, and not at all when a newer reading arrived', async () => {
  const h = harness()
  const resetMs = BASE + 5 * MIN
  h.writeClaudeCache((BASE - 20 * MIN) / 1000, 80, new Date(resetMs).toISOString())
  h.mgr.current(BASE)
  assert.equal(h.scheduled.length, 1)

  h.setNow(resetMs + 6_000)
  h.scheduled[0].fn()
  await flush()
  assert.deepEqual(h.polls.map((p) => p.source).sort(), ['claude', 'codex'])

  // Once a reading covers that reset, the trigger for it is a no-op — a jumping
  // resets_at must not turn into a poll loop.
  h.polls.length = 0
  h.writeClaudeCache((resetMs + 1_000) / 1000, 3, new Date(resetMs + 5 * 3_600_000).toISOString())
  h.mgr.current(resetMs + 7_000)
  h.setNow(resetMs + 8_000)
  h.scheduled[0].fn()
  await flush()
  assert.equal(h.polls.length, 0)
})

test('a follower reads the files but never fetches; a forced fetch still runs', async () => {
  const h = harness()
  h.writeClaudeCache((BASE - 5 * MIN) / 1000, 42, null)
  h.mgr.setLeader(false)
  assert.equal(h.mgr.blocked(), 'follower')

  h.mgr.tick(() => { /* no update expected */ })
  await flush()
  assert.equal(h.polls.length, 0)
  // The file source is still read, so the window keeps rendering.
  const states = h.mgr.current(BASE)
  assert.equal(states[0].ok, true)
  assert.equal(states[0].windows[0].percent, 42)

  h.mgr.forcePoll(() => { /* the caller takes the lease over first */ })
  await flush()
  assert.deepEqual(h.polls.map((p) => p.source).sort(), ['claude', 'codex'])
})

test('a follower without any reading says so instead of showing nothing', () => {
  const h = harness()
  h.mgr.setLeader(false)
  const states = h.mgr.current(BASE)
  assert.equal(states[0].ok, false)
  assert.equal(states[0].problemKind, 'follower')
  assert.equal(states[0].nextAttemptAt, null)
})

test('mode and consent are named as the reason for a missing figure', () => {
  const cacheMode = harness({ mode: 'cache' })
  assert.equal(cacheMode.mgr.blocked(), 'mode')
  assert.equal(cacheMode.mgr.current(BASE)[0].problemKind, 'noFile')

  const unasked = harness({}, {}, () => false)
  assert.equal(unasked.mgr.blocked(), 'consent')
  const s = unasked.mgr.current(BASE)[0]
  assert.equal(s.problemKind, 'consentPending')
})

test('an unnamed problem is blamed on the cache mode only when that mode is set', () => {
  // `auto` is the default and also does not fetch by itself, so "we do not poll"
  // must not be turned into "the mode is cache" — the advice would be to switch to
  // the mode that is already configured, and the real cause would go unsaid.
  const stale = (h: Harness): void => {
    fs.writeFileSync(h.files.claudeJsonFile, JSON.stringify({
      cachedUsageUtilization: { fetchedAtMs: BASE - 48 * 3_600_000, utilization: { limits: [] } },
    }))
  }

  const auto = harness({ mode: 'auto', claudeOrder: ['claudeJson'] })
  stale(auto)
  const a = auto.mgr.current(BASE)[0]
  assert.equal(a.ok, false)
  assert.equal(a.problemKind, 'unknown')
  assert.ok(a.problem?.includes('older than 24 h'), `unexpected problem text: ${a.problem}`)

  // With `cache` the label is accurate, and the source's own reason still wins.
  const cache = harness({ mode: 'cache', claudeOrder: ['claudeJson'] })
  stale(cache)
  assert.equal(cache.mgr.current(BASE)[0].problemKind, 'modeCache')

  const noFile = harness({ mode: 'cache', claudeOrder: ['cacheFile'] })
  assert.equal(noFile.mgr.current(BASE)[0].problemKind, 'noFile')
})

test('a window that is unfocused for over ten minutes stops polling until it returns', async () => {
  const h = harness()
  h.mgr.setFocused(false)
  h.setNow(BASE + 11 * MIN)
  h.mgr.tick(() => { /* nothing */ })
  await flush()
  assert.equal(h.polls.length, 0, 'no scheduled poll while the window is in the background')

  // Regaining focus after a long absence runs a freshness check straight away.
  h.mgr.setFocused(true, () => { /* nothing */ })
  await flush()
  assert.deepEqual(h.polls.map((p) => p.source).sort(), ['claude', 'codex'])
})

test('a short absence does not stop the interval', async () => {
  const h = harness()
  h.mgr.setFocused(false)
  h.setNow(BASE + 2 * MIN)
  h.mgr.tick(() => { /* nothing */ })
  await flush()
  assert.equal(h.polls.length, 2)
})

test('history gets one sample per moved fetchedAt, never per redraw', async () => {
  const h = harness()
  h.writeClaudeCache((BASE - 5 * MIN) / 1000, 42, null)
  h.mgr.current(BASE)
  h.mgr.current(BASE + 1_000)
  h.mgr.current(BASE + 2_000)
  assert.equal(h.added.length, 1)
  assert.equal(h.added[0].state.origin, 'cache')
  assert.equal(h.added[0].fingerprint.length, 8)

  h.writeClaudeCache((BASE - 1 * MIN) / 1000, 44, null)
  // The file changed behind the manager's back; in the editor a watcher says so.
  h.mgr.invalidate()
  h.mgr.current(BASE + 3_000)
  assert.equal(h.added.length, 2)

  // Our own poll is a reading too, and lands under its own origin.
  h.mgr.forcePoll(() => { /* nothing */ })
  await flush()
  assert.equal(h.added.length, 3)
  assert.equal(h.added[2].state.origin, 'poll')
})

test('a follower does not write into the shared history', () => {
  const h = harness()
  h.writeClaudeCache((BASE - 5 * MIN) / 1000, 42, null)
  h.mgr.setLeader(false)
  h.mgr.current(BASE)
  assert.equal(h.added.length, 0)
})

test('writeQuotaCache is off by default and never overwrites a newer file', async () => {
  const off = harness()
  off.mgr.forcePoll(() => { /* nothing */ })
  await flush()
  assert.equal(fs.existsSync(off.files.claudeCacheFile!), false)

  const on = harness({ writeQuotaCache: true })
  // A foreign writer was here first, and its reading is newer than ours.
  fs.writeFileSync(on.files.claudeCacheFile!, JSON.stringify({
    schema_version: 1, fetched_at: BASE / 1000 + 600, fail_count: 0, body: { limits: [] },
  }))
  on.mgr.forcePoll(() => { /* nothing */ })
  await flush()
  const kept = JSON.parse(fs.readFileSync(on.files.claudeCacheFile!, 'utf8'))
  assert.equal(kept.fetched_at, BASE / 1000 + 600)
  assert.ok(on.logs.some((l) => l.includes('cache file left alone')))

  const fresh = harness({ writeQuotaCache: true })
  fresh.mgr.forcePoll(() => { /* nothing */ })
  await flush()
  const written = JSON.parse(fs.readFileSync(fresh.files.claudeCacheFile!, 'utf8'))
  assert.equal(written.schema_version, 1)
  assert.equal(written.source, 'claude')
  assert.equal(written.writer, 'token-pace/1.0.0')
  assert.equal(written.fetched_at, BASE / 1000)
})

test('the drift report and the candidate list come from the last reading', () => {
  const h = harness()
  h.writeClaudeCache((BASE - MIN) / 1000, 42, null, {
    spend: { used: { amount_minor: 1250, exponent: 2 }, percent: 25 },
  })
  h.mgr.current(BASE)
  const drift = h.mgr.driftReport()
  assert.ok(drift.claude.includes('spend.used.amount_minor'))
  assert.ok(drift.claude.includes('spend.percent'))
  assert.deepEqual(drift.codex, [])
  const cands = h.mgr.candidates()
  assert.deepEqual(cands.claude.map((c) => c.id), ['cacheFile', 'statusline', 'claudeJson', 'poll'])
  assert.equal(cands.claude[0].ok, true)
})

test('the fingerprints identify the account without ever touching the token', () => {
  const h = harness()
  h.writeClaudeCache((BASE - MIN) / 1000, 42, null)
  fs.writeFileSync(h.files.claudeJsonFile, JSON.stringify({
    cachedUsageUtilization: {
      fetchedAtMs: BASE - 10 * MIN, accountUuid: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      utilization: { limits: [] },
    },
  }))
  h.mgr.current(BASE)
  const fp = h.mgr.fingerprints()
  assert.equal(fp.claude.length, 8)
  assert.equal(fp.codex.length, 8)
  assert.notEqual(fp.claude, fp.codex)
})

test('a failed poll keeps its own problem kind and a visible next attempt', async () => {
  const h = harness({}, {}, () => true, () => ({
    state: null, retryAfterSeconds: 900, problem: 'HTTP 429 — backing off before the next attempt',
    problemKind: 'retry',
  }))
  h.mgr.forcePoll(() => { /* nothing */ })
  await flush()
  const s = h.mgr.current(BASE)[0]
  assert.equal(s.ok, false)
  assert.equal(s.problemKind, 'retry')
  assert.equal(s.nextAttemptAt, BASE + 900_000)
})

test('a fresh foreign reading suppresses a fetch of our own', async () => {
  const h = harness()
  h.writeClaudeCache((BASE - 2 * MIN) / 1000, 42, null)
  h.mgr.tick(() => { /* nothing */ })
  await flush()
  assert.deepEqual(h.polls.map((p) => p.source), ['codex'])
})

test('the polled state and the next attempt survive a restart', async () => {
  const h = harness()
  h.mgr.forcePoll(() => { /* nothing */ })
  await flush()
  const again = new QuotaManager(OPTIONS, h.files, () => { /* silent */ }, () => true, () => [], undefined, {
    now: () => BASE + MIN,
    findCodexBinary: () => null,
    poll: async () => ({ state: null, retryAfterSeconds: null }),
  })
  const s = again.current(BASE + MIN)[0]
  assert.equal(s.ok, true)
  assert.equal(s.origin, 'poll')
  // A restart does not fetch immediately: the interval is carried over.
  assert.equal(s.nextAttemptAt, BASE + 30 * MIN)
})

test('a push from the persistent app-server is data, and resets the fallback timer', async () => {
  let started = 0
  let stopped = 0
  // A holder rather than a bare variable: the callback is assigned inside a method,
  // which the type checker cannot follow.
  const sink: { cb: ((method: string, params: unknown) => void) | null } = { cb: null }
  const fake = {
    start() { started++ },
    stop() { stopped++ },
    onNotification(cb: (method: string, params: unknown) => void) {
      sink.cb = cb
      return { dispose: () => { sink.cb = null } }
    },
  }
  const h = harness({ appServerMode: 'persistent' }, {
    findCodexBinary: () => '/nowhere/codex',
    createAppServer: () => fake as never,
  })
  h.mgr.tick(() => { /* nothing */ })
  await flush()
  assert.equal(started, 1)
  assert.ok(sink.cb)

  // An unusable payload is ignored rather than turned into a zero.
  sink.cb!('account/rateLimits/updated', { rateLimitsByLimitId: {} })
  assert.equal(h.mgr.current(BASE)[1].ok, false)

  sink.cb!('account/rateLimits/updated', {
    rateLimits: { planType: 'plus' },
    rateLimitsByLimitId: {
      codex: { limitId: 'codex', primary: { usedPercent: 61, windowDurationMins: 300, resetsAt: null } },
    },
  })
  const codex = h.mgr.current(BASE)[1]
  assert.equal(codex.ok, true)
  assert.equal(codex.origin, 'push')
  assert.equal(codex.windows[0].percent, 61)
  // The fallback timer moved instead of a second one being stacked on top.
  assert.equal(codex.nextAttemptAt, BASE + 30 * MIN)
  assert.equal(h.added.filter((a) => a.state.origin === 'push').length, 1)

  h.mgr.dispose()
  assert.equal(stopped, 1)
})

test('leaving the persistent mode stops the child process', async () => {
  let stopped = 0
  const fake = {
    start() { /* nothing */ },
    stop() { stopped++ },
    onNotification() { return { dispose: () => { /* nothing */ } } },
  }
  const h = harness({ appServerMode: 'persistent' }, {
    findCodexBinary: () => '/nowhere/codex',
    createAppServer: () => fake as never,
  })
  h.mgr.tick(() => { /* nothing */ })
  await flush()
  h.mgr.setOptions({ ...OPTIONS, appServerMode: 'oneShot' })
  assert.equal(stopped, 1)
})

test('current() replays its answer for five seconds instead of re-reading the files', () => {
  const h = harness()
  h.writeClaudeCache((BASE - MIN) / 1000, 42, null)

  // The status bar asks once a second; the four files behind `current()` must not
  // be parsed that often. Counting the reads is the only honest proof of that.
  let reads = 0
  const nodeFs = createRequire(__filename)('node:fs') as typeof fs
  const real = nodeFs.readFileSync
  nodeFs.readFileSync = ((file: unknown, opts: unknown) => {
    reads += 1
    return (real as (f: unknown, o: unknown) => unknown)(file, opts)
  }) as typeof fs.readFileSync

  try {
    assert.equal(h.mgr.current(BASE)[0].windows[0].percent, 42)
    const afterFirst = reads
    assert.ok(afterFirst > 0, 'the first reading did not read a single file')

    // A tick one second later is the clock moving, not a new fact.
    h.writeClaudeCache(BASE / 1000, 77, null)
    assert.equal(h.mgr.current(BASE + 1_000)[0].windows[0].percent, 42)
    assert.equal(reads, afterFirst, 'the files were read again inside the memo window')

    // …until somebody who knows better says so.
    h.mgr.invalidate()
    assert.equal(h.mgr.current(BASE + 2_000)[0].windows[0].percent, 77)
    const afterInvalidate = reads
    assert.ok(afterInvalidate > afterFirst, 'invalidate() did not force a re-read')

    // And the memo expires on its own, so a missed event costs five seconds, not a session.
    h.mgr.current(BASE + 4_000)
    assert.equal(reads, afterInvalidate)
    h.mgr.current(BASE + 7_100)
    assert.ok(reads > afterInvalidate, 'the memo outlived its five seconds')
  } finally {
    nodeFs.readFileSync = real
  }
})

test('a changed setting or role is never answered from the memo', () => {
  const h = harness()
  h.writeClaudeCache((BASE - MIN) / 1000, 42, null)
  assert.equal(h.mgr.current(BASE)[0].ok, true)

  // Same second, different configuration: the cache file is no longer consulted.
  h.mgr.setOptions({ ...OPTIONS, claudeOrder: ['claudeJson'] })
  assert.equal(h.mgr.current(BASE + 500)[0].ok, false)

  h.mgr.setLeader(false)
  assert.equal(h.mgr.current(BASE + 900)[0].problemKind, 'follower')
})
