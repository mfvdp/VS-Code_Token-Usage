// SPDX-FileCopyrightText: 2026 Frederik Marx
// SPDX-License-Identifier: AGPL-3.0-or-later

import { strict as assert } from 'node:assert'
import * as crypto from 'node:crypto'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { test } from 'node:test'
import {
  claudeStateFromBody, claudeStateFromStatusline, codexStateFromBody, codexStateFromTranscript,
  readClaudeJsonUtilization, readClaudeQuota, readCodexQuota, readStatuslineMirror,
  writeQuotaCacheFile,
} from '../src/quota'
import { credentialsPath, isCredentialsError, keychainService, loadCredentials } from '../src/credentials'
import { CodexRateLimitsSnapshot } from '../src/types'
import { scratchDir } from './fixtures/helpers'

const BASE = 1_700_000_000_000
const DAY = 86_400_000

/** The bundled tests lose __dirname, so the fixtures are found from the working directory. */
function fixtures(): string {
  let dir = process.cwd()
  for (let i = 0; i < 6; i++) {
    const c = path.join(dir, 'test', 'fixtures', 'quota')
    if (fs.existsSync(c)) return c
    dir = path.dirname(dir)
  }
  throw new Error('test/fixtures/quota not found — run the tests from the repository root')
}

const FIX = fixtures()

function fixture(name: string): string {
  return path.join(FIX, name)
}

/** A source file of this repository, read as text — for the promises only the code can keep. */
function readSource(rel: string): string {
  return fs.readFileSync(path.resolve(FIX, '..', '..', '..', rel), 'utf8')
}

/** Environment variables are process-wide state; every test puts them back. */
function withEnv(vars: Record<string, string | undefined>, fn: () => void): void {
  const before = new Map(Object.keys(vars).map((k) => [k, process.env[k]]))
  try {
    apply(vars)
    fn()
  } finally {
    apply(Object.fromEntries(before))
  }
}

async function withEnvAsync(
  vars: Record<string, string | undefined>, fn: () => Promise<void>,
): Promise<void> {
  const before = new Map(Object.keys(vars).map((k) => [k, process.env[k]]))
  try {
    apply(vars)
    await fn()
  } finally {
    apply(Object.fromEntries(before))
  }
}

function apply(vars: Record<string, string | undefined>): void {
  for (const [k, v] of Object.entries(vars)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
}

function limitsBody(limits: unknown[]): unknown {
  return { limits, five_hour: { utilization: 99, resets_at: '2023-11-15T00:00:00.000Z' } }
}

test('limits[] wins over the top-level buckets and carries the scoped window', () => {
  const q = readClaudeQuota(fixture('claude-cache-v0.json'), BASE)
  assert.equal(q.ok, true)
  assert.equal(q.origin, 'cache')
  assert.equal(q.fetchedAt, 1_699_999_400)
  assert.deepEqual(q.windows.map((w) => w.id),
    ['session:300', 'weekly_all:10080', 'weekly_scoped:10080:fable'])
  assert.deepEqual(q.windows.map((w) => w.kind), ['session', 'weekly', 'weekly'])
  assert.deepEqual(q.windows.map((w) => w.windowMinutes), [300, 10080, 10080])
  assert.deepEqual(q.windows.map((w) => w.model), [null, null, 'Fable'])
  assert.equal(q.windows[0].percent, 41.5)
  assert.equal(q.windows[0].resetsAt, Date.parse('2023-11-15T00:00:00.000Z'))
  assert.equal(q.windows[2].label, '7 d · Fable')
  assert.equal(q.windows[2].shortLabel, 'Fable 7d')
  // extra_usage is in minor units with decimal_places — 1250 credits are $12.50.
  assert.equal(q.extra?.enabled, true)
  assert.equal(q.extra?.used, 12.5)
  assert.equal(q.extra?.limit, 50)
})

test('a model display name becomes a slug, not a label, in the window key', () => {
  const q = claudeStateFromBody(limitsBody([
    {
      kind: 'weekly_scoped', group: 'weekly', percent: 5, severity: 'normal',
      resets_at: '2023-11-20T00:00:00.000Z',
      scope: { model: { id: 'x', display_name: 'Claude Opus 4.6' }, surface: 'code' },
    },
  ]), BASE / 1000)
  assert.deepEqual(q.windows.map((w) => w.id), ['weekly_scoped:10080:claude-opus-4-6'])
})

test('an unknown kind is kept as a window without a length', () => {
  const q = claudeStateFromBody(limitsBody([
    { kind: 'monthly_all', group: 'monthly', percent: 20, severity: 'normal', resets_at: null, scope: null },
  ]), BASE / 1000)
  assert.equal(q.windows.length, 1)
  const w = q.windows[0]
  assert.equal(w.id, 'monthly_all:na')
  assert.equal(w.windowMinutes, null)
  assert.equal(w.kind, 'other')
  assert.equal(w.label, 'monthly all')
  assert.equal(w.resetsAt, null)
})

test('drift lists the numeric fields the parser did not read, and only those', () => {
  const q = readClaudeQuota(fixture('claude-cache-v0.json'), BASE)
  const drift = q.drift ?? []
  for (const p of ['spend.used.amount_minor', 'spend.percent', 'five_hour.used_dollars',
    'five_hour.limit_dollars', 'extra_usage.daily.limit']) {
    assert.ok(drift.includes(p), `${p} missing from drift: ${drift.join(', ')}`)
  }
  // Read values never appear, and the internal zero buckets stay out of the way.
  for (const p of ['five_hour.utilization', 'nimbus_quill.utilization', 'seven_day_opus.utilization',
    'extra_usage.utilization', 'extra_usage.used_credits', 'limits[0].percent']) {
    assert.ok(!drift.includes(p), `${p} should count as consumed`)
  }
  assert.deepEqual(drift, [...drift].sort())
})

test('an implausible percent is discarded with a note, not clamped', () => {
  const q = claudeStateFromBody(limitsBody([
    { kind: 'session', group: 'session', percent: 5000, severity: 'normal', resets_at: null, scope: null },
    { kind: 'weekly_all', group: 'weekly', percent: 10, severity: 'normal', resets_at: null, scope: null },
    { kind: 'weekly_scoped', group: 'weekly', percent: Number.NaN, severity: 'normal', resets_at: null,
      scope: { model: { display_name: 'Fable' } } },
  ]), BASE / 1000)
  assert.deepEqual(q.windows.map((w) => w.id), ['weekly_all:10080'])
  assert.ok(q.drift?.includes('limits[0].percent: implausible percent'))
  assert.ok(q.drift?.includes('limits[2].percent: implausible percent'))
})

test('a reset over 400 days out keeps the window but is reported', () => {
  const at = BASE / 1000
  const q = claudeStateFromBody(limitsBody([
    {
      kind: 'session', group: 'session', percent: 10, severity: 'normal',
      resets_at: new Date(BASE + 500 * DAY).toISOString(), scope: null,
    },
  ]), at)
  assert.equal(q.windows.length, 1)
  assert.ok(q.drift?.some((d) => d.startsWith('limits[0].resets_at: implausible reset time')))
})

test('severity critical at a full window is the provider saying the limit is reached', () => {
  const q = claudeStateFromBody(limitsBody([
    { kind: 'session', group: 'session', percent: 100, severity: 'critical', resets_at: null, scope: null },
    { kind: 'weekly_all', group: 'weekly', percent: 100, severity: 'normal', resets_at: null, scope: null },
    { kind: 'weekly_scoped', group: 'weekly', percent: 80, severity: 'critical', resets_at: null,
      scope: { model: { display_name: 'Fable' } } },
  ]), BASE / 1000)
  assert.deepEqual(q.windows.map((w) => w.limitReached), [true, false, false])
})

test('the top-level fallback keys map onto the same window ids', () => {
  const q = claudeStateFromBody({
    five_hour: { utilization: 10, resets_at: '2023-11-15T00:00:00.000Z' },
    seven_day: { utilization: 20, resets_at: '2023-11-20T00:00:00.000Z' },
    seven_day_opus: { utilization: 30, resets_at: '2023-11-20T00:00:00.000Z' },
  }, BASE / 1000)
  assert.deepEqual(q.windows.map((w) => w.id),
    ['session:300', 'weekly_all:10080', 'weekly_scoped:10080:opus'])
  assert.equal(q.windows[2].model, 'Opus')
})

test('scoped weeks of the top-level fallback stay distinguishable in the status bar', () => {
  const q = claudeStateFromBody({
    five_hour: { utilization: 12, resets_at: null },
    seven_day: { utilization: 40, resets_at: null },
    seven_day_opus: { utilization: 88, resets_at: null },
    seven_day_sonnet: { utilization: 3, resets_at: null },
  }, BASE / 1000)
  // The status bar renders shortLabel alone; three plain "7d" items would be unreadable.
  assert.deepEqual(q.windows.map((w) => w.shortLabel), ['5h', '7d', 'Opus 7d', 'Sonnet 7d'])
  assert.deepEqual(q.windows.map((w) => w.label), ['5 h', '7 d', '7 d Opus', '7 d Sonnet'])
})

test('body as an object with schema_version 1 reads like the poller format', () => {
  const q = readClaudeQuota(fixture('claude-cache-v1.json'), BASE)
  assert.equal(q.ok, true)
  assert.equal(q.fetchedAt, 1_699_999_880)
  assert.deepEqual(q.windows.map((w) => w.id),
    ['session:300', 'weekly_all:10080', 'weekly_scoped:10080:fable'])
})

test('a paused poller is named, for both providers', () => {
  const c = readClaudeQuota(fixture('claude-cache-blocked.json'), BASE)
  assert.equal(c.ok, false)
  assert.equal(c.problemKind, 'paused')
  assert.equal(c.fetchedAt, 1_699_994_600)
  const x = readCodexQuota(fixture('codex-cache-blocked.json'), BASE)
  assert.equal(x.ok, false)
  assert.equal(x.problemKind, 'paused')
})

test('a missing file and an empty body are different problems', () => {
  const dir = scratchDir('quota-missing')
  const gone = readClaudeQuota(path.join(dir, 'nope.json'), BASE)
  assert.equal(gone.problemKind, 'noFile')
  const file = path.join(dir, 'empty.json')
  fs.writeFileSync(file, JSON.stringify({ fetched_at: 1, fail_count: 3, body: null }))
  const empty = readClaudeQuota(file, BASE)
  assert.equal(empty.problemKind, 'empty')
})

test('a cache file from a newer schema is refused rather than guessed at', () => {
  const dir = scratchDir('quota-newer')
  const file = path.join(dir, 'state.json')
  fs.writeFileSync(file, JSON.stringify({ schema_version: 99, fetched_at: 1, body: {} }))
  const q = readClaudeQuota(file, BASE)
  assert.equal(q.ok, false)
  assert.equal(q.problemKind, 'unknown')
})

test('the written cache file carries the contract fields and never overwrites a newer one', () => {
  const dir = scratchDir('quota-write')
  const file = path.join(dir, 'state.json')
  const body = JSON.parse(fs.readFileSync(fixture('claude-cache-v1.json'), 'utf8')).body
  assert.equal(writeQuotaCacheFile(file, 'claude', body, 1_700_000_000, 'token-pace/1.0.0'), true)
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'))
  assert.equal(raw.schema_version, 1)
  assert.equal(raw.source, 'claude')
  assert.equal(raw.writer, 'token-pace/1.0.0')
  assert.equal(raw.fetched_at, 1_700_000_000)
  assert.equal(raw.providers_error, null)
  // Our own older reading must not replace a newer foreign one.
  assert.equal(writeQuotaCacheFile(file, 'claude', body, 1_699_999_000, 'token-pace/1.0.0'), false)
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).fetched_at, 1_700_000_000)
  // And the result reads back through the normal reader.
  const back = readClaudeQuota(file, BASE)
  assert.equal(back.ok, true)
  assert.equal(back.fetchedAt, 1_700_000_000)
})

test('providers_error marks the reading as partial', () => {
  const dir = scratchDir('quota-partial')
  const file = path.join(dir, 'state.json')
  const body = JSON.parse(fs.readFileSync(fixture('claude-cache-v1.json'), 'utf8')).body
  fs.writeFileSync(file, JSON.stringify({
    schema_version: 1, fetched_at: 1_700_000_000, body, providers_error: 'extra usage unavailable',
  }))
  assert.equal(readClaudeQuota(file, BASE).partial, true)
})

test('codex windows key on the limit id and its window length', () => {
  const q = readCodexQuota(fixture('codex-cache.json'), BASE)
  assert.equal(q.ok, true)
  assert.equal(q.planType, 'plus')
  assert.deepEqual(q.windows.map((w) => w.id), ['codex:300', 'codex:10080', 'codex_bengalfox:300'])
  assert.deepEqual(q.windows.map((w) => w.kind), ['session', 'weekly', 'session'])
  assert.equal(q.windows[0].resetsAt, (1_700_000_000 + 6400) * 1000)
  assert.equal(q.windows[2].shortLabel, 'Spark 5h')
  assert.equal(q.extra?.balance, '12.50')
  assert.equal(q.extra?.unlimited, false)
  assert.deepEqual(q.drift, ['usageCreditsRemaining'])
  // Codex windows always have a limit; only credits can be unlimited.
  assert.deepEqual(q.windows.map((w) => w.unlimited), [false, false, false])
})

test('codex parsing tolerates the snake_case spelling', () => {
  const q = codexStateFromBody({
    rate_limits: { plan_type: 'pro', credits: { has_credits: true, unlimited: true, balance: null } },
    rate_limits_by_limit_id: {
      codex: {
        limit_id: 'codex', limit_name: null,
        primary: { used_percent: 12.5, window_duration_mins: 300, resets_at: 1_700_006_400 },
        secondary: null,
      },
    },
  }, 1_700_000_000)
  assert.equal(q.planType, 'pro')
  assert.deepEqual(q.windows.map((w) => w.id), ['codex:300'])
  assert.equal(q.windows[0].percent, 12.5)
  assert.equal(q.extra?.unlimited, true)
})

test('a reached limit is an explicit state, taken from the provider', () => {
  const q = codexStateFromBody({
    rateLimits: { planType: 'plus', rateLimitReachedType: 'codex_bengalfox' },
    rateLimitsByLimitId: {
      codex: { limitId: 'codex', primary: { usedPercent: 50, windowDurationMins: 300, resetsAt: null } },
      codex_bengalfox: {
        limitId: 'codex_bengalfox', limitName: 'Spark',
        primary: { usedPercent: 100, windowDurationMins: 300, resetsAt: null },
      },
    },
  }, 1_700_000_000)
  const byId = new Map(q.windows.map((w) => [w.id, w]))
  assert.equal(byId.get('codex:300')?.limitReached, false)
  assert.equal(byId.get('codex_bengalfox:300')?.limitReached, true)
})

test('the transcript source keeps the newest snapshot per limit id', () => {
  const snap = (t: number, limitId: string, percent: number): CodexRateLimitsSnapshot => ({
    t, limitId, limitName: limitId === 'codex' ? null : 'Spark', planType: 'plus',
    primary: { usedPercent: percent, windowMinutes: 300, resetsAt: 1_700_006_400 },
    secondary: null, credits: { hasCredits: false, unlimited: false, balance: null },
    limitReached: false,
  })
  const q = codexStateFromTranscript([
    snap(BASE - 3 * 3_600_000, 'codex', 10),
    snap(BASE - 600_000, 'codex', 44),
    snap(BASE - 7_200_000, 'codex_bengalfox', 3),
  ])
  assert.equal(q.ok, true)
  assert.equal(q.origin, 'transcript')
  assert.equal(q.fetchedAt, Math.round((BASE - 600_000) / 1000))
  const byId = new Map(q.windows.map((w) => [w.id, w.percent]))
  assert.equal(byId.get('codex:300'), 44)
  assert.equal(byId.get('codex_bengalfox:300'), 3)
})

test('no snapshots is an absence, not a zero', () => {
  const q = codexStateFromTranscript([])
  assert.equal(q.ok, false)
  assert.equal(q.windows.length, 0)
  assert.equal(q.problemKind, 'empty')
})

test('claude.json yields the windows and a hashed account hint, never the uuid', () => {
  const r = readClaudeJsonUtilization(fixture('claude-json.json'), BASE)
  assert.equal(r.state.ok, true)
  assert.equal(r.state.origin, 'claudeJson')
  assert.equal(r.state.fetchedAt, (BASE - 1_800_000) / 1000)
  assert.deepEqual(r.state.windows.map((w) => w.id),
    ['session:300', 'weekly_all:10080', 'weekly_scoped:10080:fable'])
  const expected = crypto.createHash('sha256')
    .update('11111111-2222-3333-4444-555555555555').digest('hex').slice(0, 8)
  assert.equal(r.identityHint, expected)
  // The decoy account in oauthAccount is never touched.
  const decoy = crypto.createHash('sha256')
    .update('00000000-dead-beef-0000-000000000000').digest('hex').slice(0, 8)
  assert.notEqual(r.identityHint, decoy)
})

test('claude.json older than 24 h is discarded, with the hint kept', () => {
  const r = readClaudeJsonUtilization(fixture('claude-json.json'), BASE + 25 * 3_600_000)
  assert.equal(r.state.ok, false)
  assert.ok(r.state.problem?.startsWith('stale'))
  assert.equal(r.state.windows.length, 0)
  assert.ok(r.identityHint)
})

test('the status line mirror yields windows, context, cost and prompt cache', () => {
  const r = readStatuslineMirror(fixture('statusline-mirror.json'))
  assert.equal(r.state.ok, true)
  assert.equal(r.state.origin, 'statusline')
  assert.equal(r.state.fetchedAt, (BASE - 300_000) / 1000)
  assert.deepEqual(r.state.windows.map((w) => w.id), ['session:300', 'weekly_all:10080'])
  assert.equal(r.state.windows[0].percent, 44)
  assert.equal(r.state.windows[0].resetsAt, (1_700_000_000 + 6400) * 1000)
  assert.equal(r.state.extra?.utilization, 10)
  assert.deepEqual(r.context, { used: 128_000, size: 200_000, usedPct: 64 })
  assert.deepEqual(r.cost, { totalUsd: 1.2345 })
  assert.equal(r.promptCache?.warm, true)
  assert.equal(r.promptCache?.ttl, '5m')
  assert.equal(r.model?.displayName, 'Fable')
})

test('a status line without rate limits reports no windows instead of zeroes', () => {
  const r = claudeStateFromStatusline({ model: { id: 'x' }, cost: { total_cost_usd: 0.5 } }, 1_700_000_000)
  assert.equal(r.state.ok, false)
  assert.equal(r.state.windows.length, 0)
  assert.equal(r.promptCache, null)
  assert.deepEqual(r.cost, { totalUsd: 0.5 })
})

test('a mirror file of an unknown schema is refused', () => {
  const dir = scratchDir('quota-mirror')
  const file = path.join(dir, 'mirror.json')
  fs.writeFileSync(file, JSON.stringify({ schema_version: 7, written_at: BASE, payload: {} }))
  assert.equal(readStatuslineMirror(file).state.problemKind, 'unknown')
})

// ---------------------------------------------------------------------------
// The plan name: read where a provider states it, never derived and never taken
// from the account block of ~/.claude.json.

test('a plan name is read from a usage body when one is there, and stays absent otherwise', () => {
  const body = {
    plan_type: 'Max 20x',
    limits: [{ kind: 'session', group: 'session', percent: 10, resets_at: null, scope: null }],
  }
  assert.equal(claudeStateFromBody(body, 1_700_000_000).planType, 'Max 20x')
  assert.equal(claudeStateFromBody({ ...body, plan_type: undefined, subscription_type: 'Pro' },
    1_700_000_000).planType, 'Pro')
  // Today's real bodies name no plan — the field is an absence, not an empty string.
  assert.equal(claudeStateFromBody({ ...body, plan_type: undefined }, 1_700_000_000).planType, null)
  // A plan that is not a name is not a plan: no number, no object without a name,
  // and no essay that would be cut off into something that was never written.
  assert.equal(claudeStateFromBody({ ...body, plan_type: 5 }, 1_700_000_000).planType, null)
  assert.equal(claudeStateFromBody({ ...body, plan_type: { tier: 3 } }, 1_700_000_000).planType, null)
  assert.equal(claudeStateFromBody({ ...body, plan_type: 'x'.repeat(41) }, 1_700_000_000).planType, null)
})

test('the status line may name a plan, nested or plain, and does not today', () => {
  const rl = { rate_limits: { five_hour: { used_percentage: 20, resets_at: null } } }
  assert.equal(claudeStateFromStatusline(rl, 1_700_000_000).state.planType, null)
  assert.equal(claudeStateFromStatusline({ ...rl, plan: 'Pro' }, 1_700_000_000).state.planType, 'Pro')
  assert.equal(claudeStateFromStatusline({ ...rl, subscription: { display_name: 'Team' } },
    1_700_000_000).state.planType, 'Team')
  assert.equal(readStatuslineMirror(fixture('statusline-mirror.json')).state.planType, null)
})

test('claude.json is read for cachedUsageUtilization and for nothing else', () => {
  // The fixture carries an e-mail address, an account uuid and a project history
  // beside the cache block; none of it may reach the reading.
  const raw = fs.readFileSync(fixture('claude-json.json'), 'utf8')
  assert.ok(raw.includes('never-read@example.invalid'))
  const r = readClaudeJsonUtilization(fixture('claude-json.json'), BASE)
  const rendered = JSON.stringify(r)
  for (const secret of ['never-read@example.invalid', '00000000-dead-beef', '/home/example/project', 'lastCost']) {
    assert.ok(!rendered.includes(secret), `the reading leaked ${secret}`)
  }

  // A subscription named in oauthAccount is the obvious source for a plan name —
  // and the one this build has promised never to open. It stays unread.
  const dir = scratchDir('claude-json-plan')
  const file = path.join(dir, 'claude.json')
  fs.writeFileSync(file, JSON.stringify({
    oauthAccount: { subscriptionType: 'max_20x', emailAddress: 'never-read@example.invalid' },
    cachedUsageUtilization: {
      fetchedAtMs: BASE - 60_000,
      utilization: { limits: [{ kind: 'session', group: 'session', percent: 7, resets_at: null, scope: null }] },
    },
  }))
  const plan = readClaudeJsonUtilization(file, BASE)
  assert.equal(plan.state.ok, true)
  assert.equal(plan.state.planType, null)

  // And the reader itself touches no other key: the parsed file is only ever
  // asked for cachedUsageUtilization.
  const src = readSource('src/quota.ts')
  const body = src.slice(src.indexOf('export function readClaudeJsonUtilization'))
    .split('\n// ---')[0]
  const touched = [...body.matchAll(/parsed\s*\??\.\s*([A-Za-z_$][\w$]*)/g)].map((m) => m[1])
  assert.deepEqual([...new Set(touched)], ['cachedUsageUtilization'])
})

// ---------------------------------------------------------------------------
// The credentials cascade lives here too: it is the security-critical half of
// the same subsystem, and its failures must stay describable without the token.

test('credentialsPath honours the secure-storage directory before everything else', () => {
  const dir = scratchDir('cred-path')
  const secure = path.join(dir, 'secure')
  const config = path.join(dir, 'config')
  withEnv({ CLAUDE_SECURESTORAGE_CONFIG_DIR: secure, CLAUDE_CONFIG_DIR: config }, () => {
    assert.equal(credentialsPath(path.join(dir, 'setting')), path.join(secure, '.credentials.json'))
  })
  withEnv({ CLAUDE_SECURESTORAGE_CONFIG_DIR: undefined, CLAUDE_CONFIG_DIR: config }, () => {
    assert.equal(credentialsPath(path.join(dir, 'setting')), path.join(dir, 'setting', '.credentials.json'))
    assert.equal(credentialsPath(), path.join(config, '.credentials.json'))
  })
})

test('the keychain item name carries the config-dir hash only when that is set', () => {
  withEnv({ CLAUDE_CONFIG_DIR: undefined }, () => {
    assert.equal(keychainService(), 'Claude Code-credentials')
  })
  withEnv({ CLAUDE_CONFIG_DIR: '/home/example/.claude-work' }, () => {
    const suffix = crypto.createHash('sha256').update('/home/example/.claude-work').digest('hex').slice(0, 8)
    assert.equal(keychainService(), `Claude Code-credentials-${suffix}`)
  })
})

test('the environment token wins, and the file supplies the expiry', async () => {
  const dir = scratchDir('cred')
  fs.writeFileSync(path.join(dir, '.credentials.json'), JSON.stringify({
    claudeAiOauth: { accessToken: 'file-token', expiresAt: BASE + 3_600_000 },
  }))
  await withEnvAsync({ CLAUDE_CODE_OAUTH_TOKEN: 'env-token', CLAUDE_SECURESTORAGE_CONFIG_DIR: undefined },
    async () => {
      const c = await loadCredentials({ claudeDir: dir, keychain: false }, BASE)
      assert.equal(isCredentialsError(c), false)
      assert.equal((c as { from: string }).from, 'env')
    })
  await withEnvAsync({ CLAUDE_CODE_OAUTH_TOKEN: undefined, CLAUDE_SECURESTORAGE_CONFIG_DIR: undefined },
    async () => {
      const c = await loadCredentials({ claudeDir: dir, keychain: false }, BASE)
      assert.equal(isCredentialsError(c), false)
      assert.equal((c as { from: string }).from, 'file')
      assert.equal((c as { expiresAtMs: number }).expiresAtMs, BASE + 3_600_000)
    })
})

test('an expired token is reported as such, a missing one as missing — never with the value', async () => {
  const dir = scratchDir('cred-exp')
  const file = path.join(dir, '.credentials.json')
  fs.writeFileSync(file, JSON.stringify({
    claudeAiOauth: { accessToken: 'secret-value-not-to-be-logged', expiresAt: BASE - 1 },
  }))
  await withEnvAsync({ CLAUDE_CODE_OAUTH_TOKEN: undefined, CLAUDE_SECURESTORAGE_CONFIG_DIR: undefined },
    async () => {
      const expired = await loadCredentials({ claudeDir: dir, keychain: false }, BASE)
      assert.equal(isCredentialsError(expired), true)
      assert.equal((expired as { kind: string }).kind, 'tokenExpired')
      assert.ok(!JSON.stringify(expired).includes('secret-value-not-to-be-logged'))

      fs.unlinkSync(file)
      const none = await loadCredentials({ claudeDir: dir, keychain: false }, BASE)
      assert.equal((none as { kind: string }).kind, 'noToken')
      assert.ok((none as { error: string }).error.includes(file))
    })
})
