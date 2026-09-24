// SPDX-FileCopyrightText: 2026 Frederik Marx
// SPDX-License-Identifier: AGPL-3.0-or-later

import { strict as assert } from 'node:assert'
import * as fs from 'node:fs'
import { createRequire } from 'node:module'
import * as path from 'node:path'
import { test } from 'node:test'
import { sanitize } from '../src/config'
import { Aggregator } from '../src/agg'
import { CLAUDE_VERSION_FALLBACK, PollOptions, PollResult, userAgentFor } from '../src/poller'
import {
  HistorySink, QuotaDeps, QuotaFiles, QuotaManager, QuotaOptions, Scheduled,
} from '../src/quotaManager'
import { buildItems, makeContext, quotaTooltip, StatusTextInput, UsageSource } from '../src/statusText'
import { attemptWhen } from '../src/time'
import {
  CodexRateLimitsSnapshot, emptyBucket, FAILURE_TRANSIENT, ProblemKind, QuotaState, Snapshot, Source,
} from '../src/types'
import { CLAUDE_MAIN, CLAUDE_SUB, claudeLine, ctxFor, scratchDir } from './fixtures/helpers'

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
  transcript: () => CodexRateLimitsSnapshot[] = () => [],
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
    { ...OPTIONS, ...optOver }, files, (m) => logs.push(m), consented, transcript, history, deps,
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

/**
 * The fingerprint is what keeps two accounts apart, so it must not wobble with
 * the source that happens to win a round: only `~/.claude.json` carries an
 * account marker, and it is rewritten in place often enough that a reading
 * without one is normal. Splitting one account into two streams would empty the
 * sparklines; merging two accounts would be worse, so both directions are pinned.
 */
test('one account keeps one history stream when a reading carries no identity hint', () => {
  const h = harness()
  const claudeJson = (uuid: string): void => {
    fs.writeFileSync(h.files.claudeJsonFile, JSON.stringify({
      cachedUsageUtilization: {
        fetchedAtMs: BASE - 10 * MIN, accountUuid: uuid, utilization: { limits: [] },
      },
    }))
  }

  // The cache file wins the race and carries no marker of its own; the account
  // comes from claude.json beside it.
  claudeJson('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee')
  h.writeClaudeCache((BASE - 5 * MIN) / 1000, 42, null)
  h.mgr.current(BASE)
  const first = h.mgr.fingerprints().claude
  assert.equal(h.added.length, 1)
  assert.equal(h.added[0].state.origin, 'cache')
  assert.equal(h.added[0].fingerprint, first)

  // Same account, same origin, but claude.json is unreadable for a moment — the
  // last known marker is carried forward instead of falling back to "unknown".
  fs.rmSync(h.files.claudeJsonFile)
  h.writeClaudeCache((BASE - 1 * MIN) / 1000, 44, null)
  h.mgr.invalidate()
  h.mgr.current(BASE + 1_000)
  assert.equal(h.added.length, 2)
  assert.equal(h.added[1].state.origin, 'cache')
  assert.equal(h.added[1].fingerprint, first)

  // A different account really is a different account: a new marker is adopted at
  // once, so two identities never end up in one stream.
  claudeJson('11111111-2222-3333-4444-555555555555')
  h.writeClaudeCache(BASE / 1000, 7, null)
  h.mgr.invalidate()
  h.mgr.current(BASE + 2_000)
  assert.equal(h.added.length, 3)
  assert.notEqual(h.added[2].fingerprint, first)
  assert.equal(h.mgr.fingerprints().claude, h.added[2].fingerprint)
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

test('the context reading is the status line\'s, kept beside the state and cleared with the rest', () => {
  const h = harness()
  // A fresher cache file wins the quota; the context still comes from the mirror.
  h.writeClaudeCache((BASE - MIN) / 1000, 42, null)
  fs.writeFileSync(h.files.mirrorFile, JSON.stringify({
    schema_version: 1, written_at: BASE - 8 * MIN,
    payload: {
      rate_limits: { five_hour: { used_percentage: 55, resets_at: null } },
      context_window: { total_input_tokens: 100_000, total_output_tokens: 20_000, context_window_size: 200_000 },
    },
  }))
  // Nothing has been read yet, so there is nothing to report — not a zero.
  assert.equal(h.mgr.contextReading(), null)

  const states = h.mgr.current(BASE)
  const claude = states.find((s) => s.source === 'claude')!
  assert.equal(claude.origin, 'cache')
  assert.equal(claude.windows[0].percent, 42)
  const ctx = h.mgr.contextReading()
  assert.equal(ctx?.used, 120_000)
  assert.equal(ctx?.size, 200_000)
  assert.equal(ctx?.usedPct, 60)
  assert.equal(ctx?.fetchedAt, (BASE - 8 * MIN) / 1000)

  h.mgr.clearPolled()
  assert.equal(h.mgr.contextReading(), null)
})

test('without a status-line mirror there is no context reading at all', () => {
  const h = harness()
  h.writeClaudeCache((BASE - MIN) / 1000, 42, null)
  h.mgr.current(BASE)
  assert.equal(h.mgr.contextReading(), null)
})

test('the prompt cache is the status line\'s, stamped with the mirror\'s time, cleared with the rest', () => {
  const h = harness()
  // A fresher cache file wins the quota; the prompt cache still comes from the mirror, with
  // the mirror's own time rather than the winner's.
  h.writeClaudeCache((BASE - MIN) / 1000, 42, null)
  fs.writeFileSync(h.files.mirrorFile, JSON.stringify({
    schema_version: 1, written_at: BASE - 8 * MIN,
    payload: {
      rate_limits: { five_hour: { used_percentage: 55, resets_at: null } },
      prompt_cache: { warm: true, ttl: '5m', expires_at: (BASE + 3 * MIN) / 1000, hit_ratio: 0.82 },
    },
  }))
  // Nothing has been read yet, so there is nothing to report — not a cold cache.
  assert.equal(h.mgr.promptCacheReading(), null)
  const claude = h.mgr.current(BASE).find((s) => s.source === 'claude')!
  assert.equal(claude.origin, 'cache')
  assert.deepEqual(h.mgr.promptCacheReading(), {
    warm: true, ttl: '5m', expiresAt: BASE + 3 * MIN, hitRatio: 0.82, readAt: (BASE - 8 * MIN) / 1000,
  })
  h.mgr.clearPolled()
  assert.equal(h.mgr.promptCacheReading(), null)
})

test('a mirror without a prompt-cache block yields no reading — never one from the buckets', () => {
  const h = harness()
  fs.writeFileSync(h.files.mirrorFile, JSON.stringify({
    schema_version: 1, written_at: BASE - MIN,
    payload: { rate_limits: { five_hour: { used_percentage: 55, resets_at: null } } },
  }))
  h.mgr.current(BASE)
  assert.equal(h.mgr.promptCacheReading(), null)
})

test('a poll that answers after dispose writes no quota.json and no cache file, samples nothing and reports nothing (1.6 R3)', async () => {
  // Every request held until the test answers it; the answer is the one a live window keeps.
  const answer: PollResult = { state: claudeState(BASE / 1000), retryAfterSeconds: null, raw: { limits: [] } }
  const held = (): { deps: Partial<QuotaDeps>; pending: Array<() => void> } => {
    const pending: Array<() => void> = []
    return { pending, deps: { poll: () => new Promise<PollResult>((r) => { pending.push(() => r(answer)) }) } }
  }

  // The premise, without dispose: the same answer is kept, written, sampled and reported.
  const live = held()
  const kept = harness({ writeQuotaCache: true }, live.deps)
  let liveUpdates = 0
  kept.mgr.forcePoll(() => { liveUpdates++ })
  await flush()
  assert.equal(live.pending.length, 2, 'both requests are out')
  for (const r of live.pending) r()
  await flush()
  assert.equal(fs.existsSync(kept.files.stateFile), true)
  assert.equal(fs.existsSync(kept.files.claudeCacheFile!), true)
  assert.ok(kept.added.length > 0)
  assert.equal(liveUpdates, 2)

  // Disposed while both requests are out: nothing of their answers is kept.
  const late = held()
  const h = harness({ writeQuotaCache: true }, late.deps)
  let updates = 0
  h.mgr.forcePoll(() => { updates++ })
  await flush()
  assert.equal(late.pending.length, 2)
  h.mgr.dispose()
  for (const r of late.pending) r()
  await flush()
  assert.equal(fs.existsSync(h.files.stateFile), false, 'quota.json was written after dispose')
  assert.equal(fs.existsSync(h.files.claudeCacheFile!), false, 'the shared cache file was written after dispose')
  assert.deepEqual(h.added, [], 'a history sample was taken after dispose')
  assert.equal(updates, 0, 'the window that went was told of the answer')
  assert.equal(h.logs.some((l) => l.includes('quota fetched')), false)
  // The answer is not the reading either: the manager reports what it had before.
  assert.equal(h.mgr.current(BASE)[0].origin === 'poll', false)

  // A failed request answered after dispose moves no backoff and says nothing either.
  const failing = harness({}, { poll: () => Promise.reject(new Error('synthetic')) })
  let failedUpdates = 0
  failing.mgr.forcePoll(() => { failedUpdates++ })
  failing.mgr.dispose()
  await flush()
  assert.equal(failedUpdates, 0)
  assert.equal(failing.logs.some((l) => l.includes('while fetching')), false)
})

test('after dispose tick, forcePoll, a refocus and a reset trigger start nothing and report nothing (1.6 R3)', async () => {
  const h = harness()
  const resetMs = BASE + 10 * MIN
  h.writeClaudeCache((BASE - 20 * MIN) / 1000, 80, new Date(resetMs).toISOString())
  h.mgr.current(BASE)
  assert.equal(h.scheduled.length, 1, 'the reset trigger is armed')
  h.mgr.dispose()
  let updates = 0
  h.mgr.tick(() => { updates++ })
  h.mgr.forcePoll(() => { updates++ })
  h.mgr.setFocused(false)
  h.setNow(BASE + 11 * MIN)
  h.mgr.setFocused(true, () => { updates++ })
  // A scheduler that fires a cancelled trigger anyway, and a reading of a new cycle: no fetch, and
  // no timer armed for it.
  h.setNow(resetMs + 6_000)
  h.scheduled[0].fn()
  h.writeClaudeCache((BASE - 19 * MIN) / 1000, 5, new Date(resetMs + 5 * 3_600_000).toISOString())
  h.mgr.invalidate()
  h.mgr.current(resetMs + 7_000)
  await flush()
  assert.deepEqual(h.polls, [], 'a request was made after dispose')
  assert.equal(updates, 0, 'a disposed manager reported to its caller')
  assert.equal(h.scheduled.length, 1, 'a reset trigger was armed after dispose')

  // A request whose first step — the local Claude Code version — is still under way at dispose is
  // not sent once it is answered.
  let version: (v: string | null) => void = () => undefined
  const v = harness({}, { detectClaudeVersion: () => new Promise<string | null>((r) => { version = r }) })
  v.mgr.forcePoll(() => { /* nothing */ })
  await flush()
  // Codex needs no version: its request went out at once.
  assert.deepEqual(v.polls.map((p) => p.source), ['codex'])
  v.mgr.dispose()
  version('9.9.9')
  await flush()
  assert.deepEqual(v.polls.map((p) => p.source), ['codex'], 'the Claude request was sent after dispose')
})

// ---------------------------------------------------------------------------
// 1.7 W1: the last failed attempt beside a stale reading; W2: an attempt held for focus
// ---------------------------------------------------------------------------

const RETRY_429: PollResult = {
  state: null, retryAfterSeconds: 600, problem: 'HTTP 429 — backing off before the next attempt', problemKind: 'retry',
}

/**
 * A harness whose Claude answer the test sets per request (`answer.claude`); Codex answers with a
 * missing binary, as in every other test here. `consent` is a holder so a test can take it back.
 */
function failing(optOver: Partial<QuotaOptions> = {}) {
  const answer: { claude: PollResult } = {
    claude: { state: claudeState(BASE / 1000), retryAfterSeconds: null, raw: { limits: [] } },
  }
  const consent = { ok: true }
  const h = harness(optOver, {}, () => consent.ok, (source) => (source === 'claude'
    ? answer.claude
    : { state: null, retryAfterSeconds: null, problem: 'no binary', problemKind: 'noBinary' }))
  return { ...h, answer, consent }
}

/** A poll at T0 that succeeds, then one at T0 + 30 min that answers 429 with a ten-minute wait. */
async function okThen429(h: ReturnType<typeof failing>): Promise<void> {
  h.mgr.forcePoll(() => { /* nothing */ })
  await flush()
  h.setNow(BASE + 30 * MIN)
  h.answer.claude = RETRY_429
  h.mgr.forcePoll(() => { /* nothing */ })
  await flush()
}

test('a failed fetch after a reading keeps the reading and says when and why it failed (1.7 W1)', async () => {
  const h = failing()
  await okThen429(h)
  const s = h.mgr.current(BASE + 30 * MIN)[0]
  // The T0 reading stays on screen …
  assert.equal(s.ok, true)
  assert.equal(s.fetchedAt, BASE / 1000)
  assert.equal(s.origin, 'poll')
  // … with the failure of our own beside it, and the backoff's end as the next attempt.
  assert.deepEqual(s.lastFailure, { at: BASE + 30 * MIN, problem: 'HTTP 429 — backing off before the next attempt', kind: 'retry' })
  assert.equal(s.nextAttemptAt, BASE + 40 * MIN)
  assert.equal(s.attemptHeld, null)
  // A state without a reading says the failure as its problem, as in 1.6 — no lastFailure on it.
  const codex = h.mgr.current(BASE + 30 * MIN)[1]
  assert.equal(codex.ok, false)
  assert.equal(codex.problemKind, 'noBinary')
  assert.equal(codex.lastFailure, undefined)
})

test('the next successful poll clears the failure (1.7 W1)', async () => {
  const h = failing()
  await okThen429(h)
  h.setNow(BASE + 45 * MIN)
  h.answer.claude = { state: claudeState((BASE + 45 * MIN) / 1000, 55), retryAfterSeconds: null, raw: { limits: [] } }
  h.mgr.forcePoll(() => { /* nothing */ })
  await flush()
  const s = h.mgr.current(BASE + 45 * MIN)[0]
  assert.equal(s.ok, true)
  assert.equal(s.windows[0].percent, 55)
  assert.equal(s.lastFailure, null)
})

test('a foreign reading newer than the failure answers it; an older one does not (1.7 W1)', async () => {
  const h = failing()
  await okThen429(h)
  // A cache file written after our failure: the freshest source wins, and the failure is moot.
  h.writeClaudeCache((BASE + 35 * MIN) / 1000, 61, null)
  h.mgr.invalidate()
  const newer = h.mgr.current(BASE + 36 * MIN)[0]
  assert.equal(newer.origin, 'cache')
  assert.equal(newer.windows[0].percent, 61)
  assert.equal(newer.lastFailure, null)
  // One taken before it — newer than our own T0 reading, so it is the one shown — still stands
  // beside the failure that came after it.
  h.writeClaudeCache((BASE + 20 * MIN) / 1000, 58, null)
  h.mgr.invalidate()
  const older = h.mgr.current(BASE + 36 * MIN)[0]
  assert.equal(older.origin, 'cache')
  assert.equal(older.windows[0].percent, 58)
  assert.deepEqual(older.lastFailure, { at: BASE + 30 * MIN, problem: RETRY_429.problem, kind: 'retry' })
})

test('no failure is reported while we may not fetch: follower, consent withdrawn, mode auto or cache (1.7 W1)', async () => {
  const h = failing()
  await okThen429(h)
  // A reading from before the failure keeps an ok state in every mode below.
  h.writeClaudeCache((BASE + 10 * MIN) / 1000, 44, null)
  h.mgr.invalidate()
  const at = BASE + 31 * MIN
  assert.ok(h.mgr.current(at)[0].lastFailure, 'the premise: a leader in poll mode with consent reports it')

  h.mgr.setLeader(false)
  const follower = h.mgr.current(at)[0]
  assert.equal(follower.ok, true)
  assert.equal(follower.lastFailure, null)
  assert.equal(follower.nextAttemptAt, null)
  h.mgr.setLeader(true)

  h.consent.ok = false
  h.mgr.invalidate()
  const unasked = h.mgr.current(at)[0]
  assert.equal(unasked.ok, true)
  assert.equal(unasked.lastFailure, null)
  h.consent.ok = true

  for (const mode of ['auto', 'cache'] as const) {
    h.mgr.setOptions({ ...OPTIONS, mode })
    const s = h.mgr.current(at)[0]
    assert.equal(s.ok, true, mode)
    assert.equal(s.lastFailure, null, mode)
  }
  h.mgr.setOptions(OPTIONS)
  assert.ok(h.mgr.current(at)[0].lastFailure, 'back in poll mode the failure is said again')
})

test('quota.json keeps the last failed attempt by shape, and forgets it with Clear Stored Data (1.7 W1, §0a.3)', async () => {
  const h = failing()
  await okThen429(h)
  const file = JSON.parse(fs.readFileSync(h.files.stateFile, 'utf8'))
  assert.equal(file.version, 1)
  assert.deepEqual(file.failed.claude, { at: BASE + 30 * MIN, kind: 'retry', text: 'HTTP 429 — backing off before the next attempt' })
  assert.deepEqual(Object.keys(file.failed.claude).sort(), ['at', 'kind', 'text'])

  // A restart during the backoff still says why the figure is old.
  const reopen = (at: number): QuotaState => new QuotaManager(OPTIONS, h.files, () => { /* silent */ }, () => true, () => [], undefined, {
    now: () => at, findCodexBinary: () => null, poll: async () => ({ state: null, retryAfterSeconds: null }),
  }).current(at)[0]
  const again = reopen(BASE + 31 * MIN)
  assert.equal(again.ok, true)
  assert.deepEqual(again.lastFailure, h.mgr.current(BASE + 31 * MIN)[0].lastFailure)
  assert.equal(again.nextAttemptAt, BASE + 40 * MIN)

  // Anything that is not a failed attempt of the right shape is dropped whole.
  const good = { at: BASE + 30 * MIN, kind: 'retry', text: 'HTTP 429 — backing off before the next attempt' }
  const cases: Array<[string, unknown, boolean]> = [
    ['as written', good, true],
    ['300 characters', { ...good, text: 'x'.repeat(300) }, true],
    ['a time in the future', { ...good, at: BASE + 32 * MIN }, false],
    ['no finite time', { ...good, at: null }, false],
    ['an unknown kind', { ...good, kind: 'teapot' }, false],
    ['a kind that is no string', { ...good, kind: 7 }, false],
    ['301 characters', { ...good, text: 'x'.repeat(301) }, false],
    ['an empty text', { ...good, text: '' }, false],
    ['a text that is no string', { ...good, text: { token: 'synthetic' } }, false],
    ['no object', 'HTTP 429', false],
  ]
  for (const [name, failed, kept] of cases) {
    fs.writeFileSync(h.files.stateFile, JSON.stringify({ ...file, failed: { claude: failed } }))
    const s = reopen(BASE + 31 * MIN)
    assert.equal(s.ok, true, name)
    if (kept) assert.equal(s.lastFailure?.at, BASE + 30 * MIN, name)
    else assert.equal(s.lastFailure, null, name)
  }

  // Clear Stored Data: the manager forgets it at once, and the next write carries none for Claude.
  fs.writeFileSync(h.files.stateFile, JSON.stringify(file))
  h.writeClaudeCache((BASE + 10 * MIN) / 1000, 44, null)
  h.mgr.clearPolled()
  const cleared = h.mgr.current(BASE + 31 * MIN)[0]
  assert.equal(cleared.ok, true)
  assert.equal(cleared.lastFailure, null)
  // A fresh foreign reading spares Claude's fetch; Codex's attempt (no binary) is the next write.
  h.writeClaudeCache((BASE + 31 * MIN) / 1000, 44, null)
  h.mgr.invalidate()
  h.mgr.tick(() => { /* nothing */ })
  await flush()
  const after = JSON.parse(fs.readFileSync(h.files.stateFile, 'utf8'))
  assert.equal('claude' in (after.failed ?? {}), false, JSON.stringify(after.failed))
  assert.equal(after.failed?.codex?.kind, 'noBinary')
  // And a successful Claude poll writes no Claude entry — only Codex's missing binary is kept.
  const clean = harness()
  clean.mgr.forcePoll(() => { /* nothing */ })
  await flush()
  const cleanFile = JSON.parse(fs.readFileSync(clean.files.stateFile, 'utf8'))
  assert.deepEqual(Object.keys(cleanFile.failed ?? {}), ['codex'])
})

test('a rejected poll whose error carries a token leaves none of it anywhere (1.7 W1, §0a.3 leak test)', async () => {
  const SECRET = 'synthetic-bearer-token'
  let reject = false
  const h = harness({}, {
    poll: async (source) => {
      if (source === 'claude' && reject) {
        const e = new Error(`request failed: Authorization: Bearer ${SECRET}`)
        ;(e as Error & { headers?: unknown }).headers = { Authorization: `Bearer ${SECRET}` }
        throw e
      }
      // Codex's second request stays out, so the only write of that round is the catch's own.
      if (source === 'codex' && reject) return new Promise<PollResult>(() => { /* never answered */ })
      return source === 'claude'
        ? { state: claudeState(BASE / 1000), retryAfterSeconds: null, raw: { limits: [] } }
        : { state: null, retryAfterSeconds: null, problem: 'no binary', problemKind: 'noBinary' }
    },
  })
  h.mgr.forcePoll(() => { /* nothing */ })
  await flush()
  h.setNow(BASE + 30 * MIN)
  reject = true
  h.mgr.forcePoll(() => { /* nothing */ })
  await flush()

  const s = h.mgr.current(BASE + 30 * MIN)[0]
  // The manager's own words stand for the failure, and they were written through the catch.
  assert.deepEqual(s.lastFailure, { at: BASE + 30 * MIN, problem: 'Unexpected error while fetching', kind: 'unknown' })
  const file = fs.readFileSync(h.files.stateFile, 'utf8')
  assert.deepEqual(JSON.parse(file).failed.claude, { at: BASE + 30 * MIN, kind: 'unknown', text: 'Unexpected error while fetching' })
  const agg: UsageSource = {
    sum: () => emptyBucket('claude', 'claude-opus-4-6', false, 'standard', 'd', null, '2026-09-03'),
    cost: () => ({ usd: 0, listUsd: 0, unpricedTokens: 0, unpricedModels: [], fastUnpricedTokens: 0, familyPriced: [], custom: false }),
  }
  const tip = quotaTooltip(s, makeContext({
    quotas: [s], agg, cfg: sanitize({ 'tokenPace.timezone': 'utc' }), now: BASE + 30 * MIN, forecasts: new Map(),
    role: 'single', scanning: false, consent: 'granted',
  }))
  assert.ok(tip.includes('Unexpected error while fetching'), tip)
  for (const [where, text] of [['quota.json', file], ['the state', JSON.stringify(s)], ['the tooltip', tip], ['the log', h.logs.join('\n')]]) {
    assert.equal(text.includes(SECRET), false, `${where} carries the token`)
    assert.equal(/Bearer|Authorization|request failed/.test(text), false, `${where} carries the exception's text`)
  }
  assert.ok(h.logs.includes('claude: Error while fetching'), h.logs.join('\n'))
})

test('a due attempt held for focus says so, logs it once per hold, and runs on focus (1.7 W2)', async () => {
  const h = harness()
  h.mgr.forcePoll(() => { /* nothing */ })
  await flush()
  const pollsBefore = h.polls.length
  // Background at T0 + 25 min; the scheduled attempt was due at T0 + 30 min.
  h.setNow(BASE + 25 * MIN)
  h.mgr.setFocused(false)
  assert.equal(h.mgr.current(BASE + 25 * MIN)[0].attemptHeld, null, 'not due yet, not held')
  h.setNow(BASE + 36 * MIN)
  for (let i = 0; i < 5; i++) {
    h.setNow(BASE + (36 + i) * MIN)
    h.mgr.tick(() => { /* nothing */ })
    await flush()
  }
  assert.equal(h.polls.length, pollsBefore, 'the held attempt made no request')
  const held = h.mgr.current(BASE + 40 * MIN)[0]
  assert.equal(held.ok, true)
  assert.equal(held.attemptHeld, 'focus')
  assert.equal(held.nextAttemptAt, BASE + 30 * MIN)
  const lines = h.logs.filter((l) => l === 'claude: a due fetch waits for this window to be focused (tokenPace.pollOnlyWhenFocused)')
  assert.equal(lines.length, 1, h.logs.join('\n'))

  // Focus back after more than ten minutes: the freshness check runs, and nothing is held any more.
  h.mgr.setFocused(true, () => { /* nothing */ })
  await flush()
  assert.ok(h.polls.length > pollsBefore, 'regaining focus ran the attempt')
  assert.equal(h.mgr.current(BASE + 40 * MIN)[0].attemptHeld, null)

  // The next hold is a new one and is logged again.
  h.setNow(BASE + 45 * MIN)
  h.mgr.setFocused(false)
  h.setNow(BASE + 80 * MIN)
  h.mgr.tick(() => { /* nothing */ })
  await flush()
  assert.equal(h.logs.filter((l) => l.startsWith('claude: a due fetch waits')).length, 2)
})

test('a focused window, or one without the focus setting, never holds an attempt (1.7 W2)', async () => {
  const focused = harness()
  focused.mgr.forcePoll(() => { /* nothing */ })
  await flush()
  // Long past the scheduled attempt, but focused: due, not held.
  assert.equal(focused.mgr.current(BASE + 90 * MIN)[0].attemptHeld, null)
  assert.equal(focused.mgr.current(BASE + 90 * MIN)[0].nextAttemptAt, BASE + 30 * MIN)

  const ungated = harness({ pollOnlyWhenFocused: false })
  ungated.mgr.forcePoll(() => { /* nothing */ })
  await flush()
  ungated.setNow(BASE + 10 * MIN)
  ungated.mgr.setFocused(false)
  assert.equal(ungated.mgr.current(BASE + 90 * MIN)[0].attemptHeld, null)
  assert.equal(ungated.logs.some((l) => l.includes('waits for this window')), false)
})

// ---------------------------------------------------------------------------
// 1.7 P4b (Review 1): an attempt is due or held only while a fetch is wanted; only a transient
// failure is said beside a reading; Copy Diagnostics gets the kind and the time, never the words
// ---------------------------------------------------------------------------

/** The status bar's input for one state, as the extension hands it over. */
function statusInput(s: QuotaState, now: number): StatusTextInput {
  const agg: UsageSource = {
    sum: () => emptyBucket('claude', 'claude-opus-4-6', false, 'standard', 'd', null, '2026-09-03'),
    cost: () => ({ usd: 0, listUsd: 0, unpricedTokens: 0, unpricedModels: [], fastUnpricedTokens: 0, familyPriced: [], custom: false }),
  }
  return {
    quotas: [s], agg, cfg: sanitize({ 'tokenPace.timezone': 'utc' }), now, forecasts: new Map(),
    role: 'single', scanning: false, consent: 'granted',
  }
}

/** The status-bar tooltip of a state, as the extension renders it. */
function tooltipOf(s: QuotaState, now: number): string {
  return quotaTooltip(s, makeContext(statusInput(s, now)))
}

const HELD_LINE = 'claude: a due fetch waits for this window to be focused (tokenPace.pollOnlyWhenFocused)'

test('a fresh foreign reading in a background window holds nothing: no "due", no "waiting for focus", no log line (1.7 P4b, Review 1 #1)', async () => {
  // Review 1's reproduction: a cache file (the bridge would do the same) keeps the Claude reading
  // fresh, the window has been in the background for more than ten minutes, and `runPolls` would not
  // fetch — so nothing may say that an attempt is due or waits for focus.
  const h = harness()
  h.writeClaudeCache((BASE - 2 * MIN) / 1000, 42, null)
  h.mgr.tick(() => { /* nothing */ })
  await flush()
  assert.equal(h.polls.filter((p) => p.source === 'claude').length, 0, 'the premise: the fresh reading spares the fetch')
  h.mgr.setFocused(false)
  for (let m = 1; m <= 24; m++) {
    const now = BASE + m * MIN
    h.setNow(now)
    // The reading is renewed every ten minutes, as a live source renews it.
    if (m % 10 === 0) h.writeClaudeCache((now - MIN) / 1000, 42 + m, null)
    h.mgr.invalidate()
    h.mgr.tick(() => { /* nothing */ })
    await flush()
    const s = h.mgr.current(now)[0]
    assert.equal(s.origin, 'cache', `${m} min`)
    assert.equal(s.attemptHeld, null, `${m} min: held`)
    const w = attemptWhen(s.nextAttemptAt, s.attemptHeld, now)
    assert.equal(w?.kind, 'in', `${m} min: ${JSON.stringify(w)}`)
    // Not before the reading shown turns older than the interval — when a fetch is wanted again.
    assert.equal(s.nextAttemptAt, (s.fetchedAt as number) * 1000 + 30 * MIN, `${m} min`)
    const tip = tooltipOf(s, now)
    assert.equal(/waiting for focus|next attempt due|retry due/.test(tip), false, `${m} min: ${tip}`)
  }
  assert.equal(h.logs.includes(HELD_LINE), false, h.logs.join('\n'))
  assert.equal(h.polls.filter((p) => p.source === 'claude').length, 0)

  // The reading goes stale (no renewal after minute 20): a fetch is wanted now, and the background
  // window holds it — the words and one log line come back.
  h.setNow(BASE + 52 * MIN)
  h.mgr.invalidate()
  for (let i = 0; i < 3; i++) {
    h.mgr.tick(() => { /* nothing */ })
    await flush()
  }
  const stale = h.mgr.current(BASE + 52 * MIN)[0]
  assert.equal(stale.ok, true)
  assert.equal(stale.attemptHeld, 'focus')
  assert.equal(attemptWhen(stale.nextAttemptAt, stale.attemptHeld, BASE + 52 * MIN)?.kind, 'focus')
  assert.ok(tooltipOf(stale, BASE + 52 * MIN).split('\n').includes('$(clock) next attempt waiting for focus'))
  assert.equal(h.logs.filter((l) => l === HELD_LINE).length, 1, h.logs.join('\n'))
  assert.equal(h.polls.filter((p) => p.source === 'claude').length, 0, 'held, not made')
})

test('while a fresh reading answers the fetch, a focused window says the same next attempt and makes it once the reading is old (1.7 P4b)', async () => {
  const h = harness()
  h.writeClaudeCache((BASE - 2 * MIN) / 1000, 42, null)
  // Every thirty seconds, as the extension ticks.
  for (let k = 0; k <= 62; k++) {
    const now = BASE + k * 30_000
    h.setNow(now)
    h.mgr.invalidate()
    h.mgr.tick(() => { /* nothing */ })
    await flush()
    const s = h.mgr.current(now)[0]
    assert.equal(s.attemptHeld, null, `${k / 2} min`)
    if (s.origin === 'cache' && now - (s.fetchedAt as number) * 1000 < 30 * MIN) {
      // Never due while the reading answers — not "1m" either: the one-minute re-check is no attempt.
      assert.equal(s.nextAttemptAt, BASE + 28 * MIN, `${k / 2} min`)
      assert.equal(h.polls.filter((p) => p.source === 'claude').length, 0, `${k / 2} min`)
    }
  }
  // Past BASE + 28 min the reading no longer answers, and the fetch was made.
  assert.equal(h.polls.filter((p) => p.source === 'claude').length, 1)
  assert.equal(h.mgr.current(BASE + 62 * 30_000)[0].origin, 'poll')
})

/** Every ProblemKind, written out here — the record in types.ts has to name each one. */
const EVERY_KIND: ProblemKind[] = [
  'noFile', 'paused', 'empty', 'noToken', 'tokenExpired', 'consentPending', 'modeCache',
  'retry', 'offline', 'forbidden', 'unauthorized', 'noBinary', 'quotaOff', 'follower', 'unknown',
]
/** The transient ones (Review 1 #2): a rate limit or server error, no connection, an unclassified failure. */
const TRANSIENT_KINDS: ProblemKind[] = ['retry', 'offline', 'unknown']

test('only a transient failure is said beside a reading; quota.json keeps every one (1.7 P4b, Review 1 #2)', async () => {
  assert.deepEqual(Object.keys(FAILURE_TRANSIENT).sort(), [...EVERY_KIND].sort())
  for (const kind of EVERY_KIND) {
    const transient = TRANSIENT_KINDS.includes(kind)
    assert.equal(FAILURE_TRANSIENT[kind], transient, kind)
    const h = failing()
    h.mgr.forcePoll(() => { /* nothing */ })
    await flush()
    h.setNow(BASE + 30 * MIN)
    const words = `synthetic ${kind} words`
    h.answer.claude = { state: null, retryAfterSeconds: transient ? 600 : null, problem: words, problemKind: kind }
    h.mgr.forcePoll(() => { /* nothing */ })
    await flush()
    const s = h.mgr.current(BASE + 30 * MIN)[0]
    // The T0 reading stays on screen either way.
    assert.equal(s.ok, true, kind)
    assert.equal(s.fetchedAt, BASE / 1000, kind)
    if (transient) assert.deepEqual(s.lastFailure, { at: BASE + 30 * MIN, problem: words, kind }, kind)
    else assert.equal(s.lastFailure, null, kind)
    // The tooltip and a stale item follow; the reading is 30 min old, so stale by the 20-minute default.
    const tip = tooltipOf(s, BASE + 30 * MIN)
    assert.equal(tip.includes(words), transient, `${kind}: ${tip}`)
    const item = buildItems(statusInput(s, BASE + 30 * MIN))[0]
    assert.equal(item.text.includes('$(clock) retry'), transient, `${kind}: ${item.text}`)
    // quota.json keeps every failure (§0a.3 unchanged), and so does the manager for the diagnostics.
    const file = JSON.parse(fs.readFileSync(h.files.stateFile, 'utf8'))
    assert.deepEqual(file.failed.claude, { at: BASE + 30 * MIN, kind, text: words }, kind)
    assert.deepEqual(h.mgr.lastFailures().claude, { kind, at: BASE + 30 * MIN }, kind)
  }
})

test('Codex without its binary beside a transcript reading says nothing of it; a restart does not either (1.7 P4b, Review 1 #2)', async () => {
  // The case Review 1 found: the Codex reading comes from a transcript, our own attempt finds no
  // `codex` executable — a permanent cause, which 1.6 showed only where no reading exists.
  const snaps: CodexRateLimitsSnapshot[] = [{
    t: BASE - 45 * MIN, limitId: 'codex', limitName: null, planType: 'plus',
    primary: { usedPercent: 42, windowMinutes: 300, resetsAt: null }, secondary: null, credits: null, limitReached: false,
  }]
  const h = harness({}, {}, () => true, undefined, () => snaps)
  h.mgr.tick(() => { /* nothing */ })
  await flush()
  assert.ok(h.polls.some((p) => p.source === 'codex'), 'the premise: the old transcript reading asked for a fetch')
  const codex = h.mgr.current(BASE + MIN)[1]
  assert.equal(codex.ok, true)
  assert.equal(codex.origin, 'transcript')
  assert.equal(codex.lastFailure, null)
  assert.equal(/Last attempt|no binary/.test(tooltipOf(codex, BASE + MIN)), false, tooltipOf(codex, BASE + MIN))
  // Kept all the same — in quota.json and for the diagnostics.
  assert.equal(JSON.parse(fs.readFileSync(h.files.stateFile, 'utf8')).failed.codex.kind, 'noBinary')
  assert.deepEqual(h.mgr.lastFailures().codex, { kind: 'noBinary', at: BASE })
  // A restart restores it, and still says nothing of it beside the reading.
  const again = new QuotaManager(OPTIONS, h.files, () => { /* silent */ }, () => true, () => snaps, undefined, {
    now: () => BASE + 2 * MIN, findCodexBinary: () => null, poll: async () => ({ state: null, retryAfterSeconds: null }),
  })
  const restored = again.current(BASE + 2 * MIN)[1]
  assert.equal(restored.ok, true)
  assert.equal(restored.lastFailure, null)
  assert.deepEqual(again.lastFailures().codex, { kind: 'noBinary', at: BASE })
  // Without the transcript reading the problem is the card's, as in 1.6.
  const bare = new QuotaManager(OPTIONS, h.files, () => { /* silent */ }, () => true, () => [], undefined, {
    now: () => BASE + 2 * MIN, findCodexBinary: () => null, poll: async () => ({ state: null, retryAfterSeconds: null }),
  }).current(BASE + 2 * MIN)[1]
  assert.equal(bare.ok, false)
  assert.equal(bare.problemKind, 'noBinary')
})

test('lastFailures hands Copy Diagnostics the kind and the time of each source\'s last failed attempt, never its words (1.7 P4b)', async () => {
  const h = failing()
  assert.deepEqual(h.mgr.lastFailures(), { claude: null, codex: null })
  await okThen429(h)
  const f = h.mgr.lastFailures()
  assert.deepEqual(f.claude, { kind: 'retry', at: BASE + 30 * MIN })
  assert.deepEqual(Object.keys(f.claude ?? {}).sort(), ['at', 'kind'])
  assert.equal(JSON.stringify(f).includes('HTTP 429'), false)
  assert.equal(JSON.stringify(f).includes('no binary'), false)
  // A successful poll clears the source's entry, Clear Stored Data every entry.
  h.setNow(BASE + 45 * MIN)
  h.answer.claude = { state: claudeState((BASE + 45 * MIN) / 1000), retryAfterSeconds: null, raw: { limits: [] } }
  h.mgr.forcePoll(() => { /* nothing */ })
  await flush()
  assert.equal(h.mgr.lastFailures().claude, null)
  assert.equal(h.mgr.lastFailures().codex?.kind, 'noBinary')
  h.mgr.clearPolled()
  assert.deepEqual(h.mgr.lastFailures(), { claude: null, codex: null })
})

// ---------------------------------------------------------------------------
// 1.7 W3 (§0a.1): the user agent's version — the CLI, else the newest main transcript, else the fallback
// ---------------------------------------------------------------------------

const UA_SHAPE = /^claude-code\/\d{1,3}\.\d{1,3}\.\d{1,4}$/

/**
 * A harness whose CLI probe and transcript version the test sets; the user agent is Claude Code's,
 * as by default. Counts how often each was asked, and hands back the Claude requests' options.
 */
function versioned(cli: string | null, transcript: () => string | null, optOver: Partial<QuotaOptions> = {}) {
  const asked = { cli: 0, transcript: 0 }
  const h = harness({ userAgent: 'claudeCode', ...optOver }, {
    detectClaudeVersion: async () => { asked.cli += 1; return cli },
    transcriptVersion: () => { asked.transcript += 1; return transcript() },
  })
  const claudePolls = (): PollOptions[] => h.polls.filter((p) => p.source === 'claude').map((p) => p.opts)
  const versionLines = (): string[] => h.logs.filter((l) => l.startsWith('claude: user agent version'))
  return { ...h, asked, claudePolls, versionLines }
}

async function pollOnce(h: { mgr: QuotaManager }): Promise<void> {
  h.mgr.forcePoll(() => { /* nothing */ })
  await flush()
}

test('the CLI gives no version: the newest transcript\'s goes into the user agent, asked at every poll (1.7 W3 test 5, §0a.1)', async () => {
  const h = versioned(null, () => '2.1.281')
  await pollOnce(h)
  const [opts] = h.claudePolls()
  assert.equal(opts.claudeVersion, '2.1.281')
  assert.equal(userAgentFor(opts), 'claude-code/2.1.281')
  assert.match(userAgentFor(opts), UA_SHAPE)
  assert.deepEqual(h.versionLines(), ['claude: user agent version 2.1.281 (from the newest transcript)'])
  // Codex's request carries no transcript version: only Claude's user agent names one.
  assert.equal(h.polls.find((p) => p.source === 'codex')!.opts.claudeVersion, null)

  // A second poll asks the transcripts again (the CLI stays asked once) and logs nothing new.
  await pollOnce(h)
  assert.deepEqual(h.asked, { cli: 1, transcript: 2 })
  assert.equal(h.claudePolls()[1].claudeVersion, '2.1.281')
  assert.equal(h.versionLines().length, 1, h.logs.join('\n'))
})

test('transcripts not read yet at the first poll: the fallback, then the transcript\'s version at the next (1.7 W3 test 5)', async () => {
  let scanned: string | null = null
  const h = versioned(null, () => scanned)
  await pollOnce(h)
  assert.equal(h.claudePolls()[0].claudeVersion, null)
  assert.equal(userAgentFor(h.claudePolls()[0]), `claude-code/${CLAUDE_VERSION_FALLBACK}`)
  assert.equal(userAgentFor(h.claudePolls()[0]), 'claude-code/2.1.257')
  // The cold scan finishes between the two polls.
  scanned = '2.1.281'
  await pollOnce(h)
  assert.equal(h.claudePolls()[1].claudeVersion, '2.1.281')
  assert.match(userAgentFor(h.claudePolls()[1]), UA_SHAPE)
  // One line per source the version came from, in order.
  assert.deepEqual(h.versionLines(), [
    'claude: user agent version 2.1.257 (fallback)',
    'claude: user agent version 2.1.281 (from the newest transcript)',
  ])
})

test('the CLI\'s version beats the transcripts\'; neither known sends the fallback (1.7 W3 test 5, spec §3.0 (i))', async () => {
  const cli = versioned('2.1.290', () => '2.1.281')
  await pollOnce(cli)
  await pollOnce(cli)
  assert.deepEqual(cli.claudePolls().map((o) => o.claudeVersion), ['2.1.290', '2.1.290'])
  assert.equal(userAgentFor(cli.claudePolls()[0]), 'claude-code/2.1.290')
  assert.deepEqual(cli.versionLines(), ['claude: user agent version 2.1.290 (from claude --version)'])
  assert.equal(cli.asked.cli, 1, 'the CLI is asked once per session')

  const neither = versioned(null, () => null)
  await pollOnce(neither)
  assert.equal(neither.claudePolls()[0].claudeVersion, null)
  assert.equal(userAgentFor(neither.claudePolls()[0]), 'claude-code/2.1.257')
  assert.deepEqual(neither.versionLines(), ['claude: user agent version 2.1.257 (fallback)'])
  // Every source gives a header of the one shape.
  for (const opts of [...cli.claudePolls(), ...neither.claudePolls()]) assert.match(userAgentFor(opts), UA_SHAPE)
})

test('a transcript version without the shape, or a lookup that throws, never reaches the header (1.7 W3, §0a.1)', async () => {
  for (const bad of ['2.1.281; rm', 'synthetic', '2.1.281\r\nX-Injected: 1', '1234.1.1', ''] as const) {
    const h = versioned(null, () => bad)
    await pollOnce(h)
    assert.equal(h.claudePolls()[0].claudeVersion, null, JSON.stringify(bad))
    assert.equal(userAgentFor(h.claudePolls()[0]), 'claude-code/2.1.257')
  }
  const throwing = versioned(null, () => { throw new Error('synthetic lookup failure') })
  await pollOnce(throwing)
  // The fetch still went out, with the fallback, and nothing says it failed.
  assert.equal(throwing.claudePolls().length, 1)
  assert.equal(throwing.claudePolls()[0].claudeVersion, null)
  assert.equal(throwing.logs.some((l) => /Unexpected|synthetic lookup failure/.test(l)), false, throwing.logs.join('\n'))
  assert.equal(throwing.mgr.current(BASE)[0].ok, true)
})

test('honest sends none of it and logs no version (1.7 W3, spec §3.0 (i))', async () => {
  const h = versioned(null, () => '2.1.281', { userAgent: 'honest' })
  await pollOnce(h)
  assert.equal(userAgentFor(h.claudePolls()[0]), 'token-pace/1.0.0')
  assert.deepEqual(h.versionLines(), [])
  // 1.7 Review 1 (§0a.1: only when tokenPace.userAgent is claudeCode): the transcripts are not even
  // asked, and no transcript version sits in the request's options.
  assert.equal(h.asked.transcript, 0, 'honest asked the transcripts for a version it never sends')
  assert.equal(h.claudePolls()[0].claudeVersion, null)
  // Back on claudeCode, the next poll asks them again.
  h.mgr.setOptions({ ...OPTIONS, userAgent: 'claudeCode' })
  await pollOnce(h)
  assert.equal(h.asked.transcript, 1)
  assert.equal(userAgentFor(h.claudePolls()[1]), 'claude-code/2.1.281')
})

test('the version reaches the user agent from a main session, never from an agent, never from a hand-written snapshot (1.7 W3, §0a.1)', async () => {
  const MAIN_B = CLAUDE_MAIN.replace('sess-0001.jsonl', 'sess-0002.jsonl')
  const agg = new Aggregator()
  agg.addClaudeLine(claudeLine({ id: 'm1', ts: BASE - 3_600_000, usage: { input: 3 }, version: '2.1.281' }), ctxFor())
  // A later agent of a newer build — not asked.
  agg.addClaudeLine(claudeLine({ id: 's1', ts: BASE - 60_000, agentId: 'a1', usage: { input: 3 }, version: '2.1.300' }),
    ctxFor({ file: CLAUDE_SUB, isSub: true }))
  const live = versioned(null, () => agg.latestClaudeVersion())
  await pollOnce(live)
  assert.equal(live.claudePolls()[0].claudeVersion, '2.1.281')
  assert.equal(userAgentFor(live.claudePolls()[0]), 'claude-code/2.1.281')

  // A snapshot written by hand, its newest session's version `2.1.281; rm`, the other `synthetic`.
  agg.addClaudeLine(claudeLine({ id: 'm2', ts: BASE - 1_800_000, usage: { input: 3 }, version: '2.1.282' }), ctxFor({ file: MAIN_B }))
  const snap = JSON.parse(JSON.stringify(agg.toSnapshot())) as Snapshot
  const mains = snap.mains as unknown as Record<string, Record<string, unknown>>
  mains[MAIN_B].ccVersion = '2.1.281; rm'
  mains[CLAUDE_MAIN].ccVersion = 'synthetic'
  const edited = Aggregator.fromSnapshot(snap)
  const h = versioned(null, () => edited.latestClaudeVersion())
  await pollOnce(h)
  assert.equal(h.claudePolls()[0].claudeVersion, null)
  assert.equal(userAgentFor(h.claudePolls()[0]), 'claude-code/2.1.257')
  // Nothing else of any transcript is in the request's options.
  assert.equal(/synthetic|rm|2\.1\.300/.test(JSON.stringify([...live.claudePolls(), ...h.claudePolls()])), false)
})
