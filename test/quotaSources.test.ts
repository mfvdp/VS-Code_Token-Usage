// SPDX-FileCopyrightText: 2026 Frederik Marx
// SPDX-License-Identifier: AGPL-3.0-or-later

import { strict as assert } from 'node:assert'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { test } from 'node:test'
import { bestState, SourceInputs } from '../src/quotaSources'
import { CodexRateLimitsSnapshot, QuotaState } from '../src/types'

const SCRATCH = '/tmp/claude-1000/-home-frederik-Claude-VS-Code-Tokens/9d0eb37a-71d8-4832-9deb-36dcbfb5985b/scratchpad'
const BASE = 1_700_000_000_000
const MIN = 60_000

function tmpDir(): string {
  const root = fs.existsSync(SCRATCH) ? SCRATCH : os.tmpdir()
  return fs.mkdtempSync(path.join(root, 'qsrc-'))
}

const claudeBody = (percent: number) => ({
  limits: [
    {
      kind: 'session', group: 'session', percent, severity: 'normal',
      resets_at: '2023-11-15T00:00:00.000Z', scope: null,
    },
  ],
})

function writeCache(dir: string, name: string, fetchedAtSec: number, percent: number): string {
  const file = path.join(dir, name)
  fs.writeFileSync(file, JSON.stringify({
    schema_version: 1, fetched_at: fetchedAtSec, fail_count: 0, blocked_until: 0,
    body: claudeBody(percent),
  }))
  return file
}

function writeMirror(dir: string, writtenAtMs: number, percent: number): string {
  const file = path.join(dir, 'mirror.json')
  fs.writeFileSync(file, JSON.stringify({
    schema_version: 1, written_at: writtenAtMs,
    payload: { rate_limits: { five_hour: { used_percentage: percent, resets_at: 1_700_006_400 } } },
  }))
  return file
}

function writeClaudeJson(dir: string, fetchedAtMs: number, percent: number): string {
  const file = path.join(dir, 'claude.json')
  fs.writeFileSync(file, JSON.stringify({
    oauthAccount: { accountUuid: 'decoy' },
    cachedUsageUtilization: {
      fetchedAtMs, accountUuid: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', utilization: claudeBody(percent),
    },
  }))
  return file
}

function inputs(dir: string, over: Partial<SourceInputs> = {}): SourceInputs {
  return {
    claudeOrder: ['cacheFile', 'statusline', 'claudeJson', 'poll'],
    codexOrder: ['cacheFile', 'transcript', 'poll'],
    polled: {},
    transcript: () => [],
    mirrorFile: path.join(dir, 'mirror.json'),
    claudeJsonFile: path.join(dir, 'claude.json'),
    claudeCacheFile: path.join(dir, 'claude-cache.json'),
    codexCacheFile: path.join(dir, 'codex-cache.json'),
    mode: 'auto',
    ...over,
  }
}

test('the freshest reading wins, whatever the configured order says', () => {
  const dir = tmpDir()
  writeCache(dir, 'claude-cache.json', (BASE - 40 * MIN) / 1000, 20)
  writeMirror(dir, BASE - 2 * MIN, 55)
  writeClaudeJson(dir, BASE - 20 * MIN, 33)
  const r = bestState('claude', inputs(dir), BASE)
  assert.equal(r.state.ok, true)
  assert.equal(r.state.origin, 'statusline')
  assert.equal(r.state.windows[0].percent, 55)
  // The windows come from one source only — nothing is spliced together.
  assert.equal(r.state.windows.length, 1)
})

test('equally fresh readings are decided by the configured order', () => {
  const dir = tmpDir()
  writeCache(dir, 'claude-cache.json', (BASE - 5 * MIN) / 1000, 20)
  writeMirror(dir, BASE - 5 * MIN, 55)
  const cacheFirst = bestState('claude', inputs(dir, { claudeOrder: ['cacheFile', 'statusline'] }), BASE)
  assert.equal(cacheFirst.state.origin, 'cache')
  const mirrorFirst = bestState('claude', inputs(dir, { claudeOrder: ['statusline', 'cacheFile'] }), BASE)
  assert.equal(mirrorFirst.state.origin, 'statusline')
})

test('a source that is not in the order is not consulted at all', () => {
  const dir = tmpDir()
  writeCache(dir, 'claude-cache.json', (BASE - 5 * MIN) / 1000, 20)
  writeMirror(dir, BASE - MIN, 55)
  const r = bestState('claude', inputs(dir, { claudeOrder: ['cacheFile'] }), BASE)
  assert.equal(r.state.origin, 'cache')
  assert.deepEqual(r.candidates.map((c) => c.id), ['cacheFile'])
})

test('mode cache never asks our own poll, mode auto only shows one that exists', () => {
  const dir = tmpDir()
  const polledState: QuotaState = {
    source: 'claude', ok: true, origin: 'poll', fetchedAt: BASE / 1000, planType: 'max',
    windows: [{
      id: 'session:300', kind: 'session', label: '5 h', shortLabel: '5h', model: null,
      percent: 77, resetsAt: null, windowMinutes: 300, limitReached: false, unlimited: false,
    }],
  }
  writeCache(dir, 'claude-cache.json', (BASE - 5 * MIN) / 1000, 20)

  const cacheMode = bestState('claude', inputs(dir, { mode: 'cache', polled: { claude: polledState } }), BASE)
  assert.equal(cacheMode.state.origin, 'cache')
  assert.ok(!cacheMode.candidates.some((c) => c.id === 'poll'))

  const autoEmpty = bestState('claude', inputs(dir, { mode: 'auto' }), BASE)
  assert.ok(!autoEmpty.candidates.some((c) => c.id === 'poll'))

  const autoWithPoll = bestState('claude', inputs(dir, { mode: 'auto', polled: { claude: polledState } }), BASE)
  assert.equal(autoWithPoll.state.origin, 'poll')
  assert.ok(autoWithPoll.candidates.some((c) => c.id === 'poll'))

  // In poll mode a fresher foreign file still beats an older own poll.
  const older: QuotaState = { ...polledState, fetchedAt: (BASE - 30 * MIN) / 1000 }
  const pollMode = bestState('claude', inputs(dir, { mode: 'poll', polled: { claude: older } }), BASE)
  assert.equal(pollMode.state.origin, 'cache')
})

test('every enabled source appears among the candidates with its age and problem', () => {
  const dir = tmpDir()
  writeCache(dir, 'claude-cache.json', (BASE - 3 * MIN) / 1000, 20)
  const r = bestState('claude', inputs(dir), BASE)
  assert.deepEqual(r.candidates.map((c) => c.id), ['cacheFile', 'statusline', 'claudeJson'])
  assert.equal(r.candidates[0].ok, true)
  assert.equal(Math.round(r.candidates[0].ageSec ?? -1), 180)
  assert.equal(r.candidates[1].ok, false)
  assert.ok(r.candidates[1].problem)
  assert.equal(r.candidates[1].ageSec, null)
})

test('the account hint is taken from claude.json even when another source wins', () => {
  const dir = tmpDir()
  writeMirror(dir, BASE - MIN, 55)
  writeClaudeJson(dir, BASE - 20 * MIN, 33)
  const r = bestState('claude', inputs(dir), BASE)
  assert.equal(r.state.origin, 'statusline')
  assert.equal(typeof r.identityHint, 'string')
  assert.equal(r.identityHint?.length, 8)
})

test('with nothing readable the highest-ranked source explains why', () => {
  const dir = tmpDir()
  const r = bestState('claude', inputs(dir), BASE)
  assert.equal(r.state.ok, false)
  assert.equal(r.state.problemKind, 'noFile')
  assert.equal(r.candidates.length, 3)
})

test('an empty order is reported as "no source enabled", not as a missing file', () => {
  const dir = tmpDir()
  const r = bestState('claude', inputs(dir, { claudeOrder: [] }), BASE)
  assert.equal(r.state.problemKind, 'quotaOff')
  assert.deepEqual(r.candidates, [])
})

test('codex: the transcript snapshot competes with the cache file on age', () => {
  const dir = tmpDir()
  fs.writeFileSync(path.join(dir, 'codex-cache.json'), JSON.stringify({
    fetched_at: (BASE - 90 * MIN) / 1000, fail_count: 0,
    body: {
      rateLimits: { planType: 'plus' },
      rateLimitsByLimitId: {
        codex: { limitId: 'codex', primary: { usedPercent: 11, windowDurationMins: 300, resetsAt: null } },
      },
    },
  }))
  const snaps: CodexRateLimitsSnapshot[] = [{
    t: BASE - 4 * MIN, limitId: 'codex', limitName: null, planType: 'plus',
    primary: { usedPercent: 42, windowMinutes: 300, resetsAt: null }, secondary: null,
    credits: null, limitReached: false,
  }]
  const r = bestState('codex', inputs(dir, { transcript: () => snaps }), BASE)
  assert.equal(r.state.origin, 'transcript')
  assert.equal(r.state.windows[0].percent, 42)
  assert.deepEqual(r.candidates.map((c) => c.id), ['cacheFile', 'transcript'])
})
