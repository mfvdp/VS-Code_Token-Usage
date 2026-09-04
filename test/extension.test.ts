// SPDX-FileCopyrightText: 2026 Frederik Marx
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The wiring test: one real `activate()` against a fake extension host.
 *
 * Every other test in this suite exercises a module on its own. This one is the only
 * place where `extension.ts` itself runs — settings are read, roots are configured, the
 * cold scan goes through the worker, the quota cascade picks a source, the status bar is
 * filled, the snapshot is written and every command is registered. It is therefore also
 * the only place where a mistake in the *order* of those steps can be caught.
 *
 * Nothing here touches a real transcript. Two temporary directories are created per run:
 * one stands in for the home directory (so the hard-wired `~/.claude.json` cannot reach
 * the user's own file), the other holds invented Claude and Codex transcripts, an
 * invented quota cache and an invented credentials file. The credentials file exists for
 * one reason: its token must never appear in a log line or in the diagnostics report, and
 * an absent file could not prove that.
 */

import { strict as assert } from 'node:assert'
import { execFileSync } from 'node:child_process'
import { after, before, test } from 'node:test'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import {
  claudeLine, codexMeta, codexTaskStarted, codexTokenCount, codexTurnContext, iso, snakeRateLimits, tmpDir,
} from './fixtures/helpers'
import {
  createFakeContext, createFakeVscode, disposeAll, FakeExtensionContext, FakeVscodeState, installVscodeStub,
} from './helpers/fakeVscode'
import { BRIDGE_BLOCKS_DELETE } from '../src/storage'
import { STATE_VERSION } from '../src/types'

/** Never a real key: the string is asserted *absent* from every output this test reads. */
const FAKE_TOKEN = 'sk-ant-oat01-SYNTHETIC-TEST-TOKEN-0000000000000000'

/** One instant for every synthetic record, so both scan paths produce identical buckets. */
const T = Date.now()

const CLAUDE_SESSION_ITEM = 'tokenPace.quota.claude.session.300'
const CLAUDE_WEEK_ITEM = 'tokenPace.quota.claude.weekly_all.10080'
const CODEX_ITEM = 'tokenPace.quota.codex.codex.300'
const TOKENS_ITEM = 'tokenPace.tokens'

/**
 * Σ of the synthetic transcripts, by the same rule `billable()` applies:
 * Claude counts input + cache write + output, Codex counts the uncached input instead.
 */
const EXPECTED_BILLABLE = (130 + 50 + 30) + (60 + 10 + 5) + ((200 - 50) + 40)

interface Fixture {
  home: string
  data: string
  claudeDir: string
  codexDir: string
  storage: string
  claudeCache: string
  missingCodexCache: string
  claudeRoot: string
  codexRoot: string
  stateFile: string
  leaderFile: string
}

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

function findRepoRoot(start: string): string {
  let dir = start
  for (let i = 0; i < 8; i++) {
    if (fs.existsSync(path.join(dir, 'build.mjs')) && fs.existsSync(path.join(dir, 'package.json'))) return dir
    const up = path.dirname(dir)
    if (up === dir) break
    dir = up
  }
  throw new Error(`no repository root above ${start}`)
}

const REPO = findRepoRoot(__dirname)

function makeFixture(): Fixture {
  const home = tmpDir('tp-home')
  const data = tmpDir('tp-data')
  const claudeDir = path.join(data, 'claude')
  const codexDir = path.join(data, 'codex')
  const storage = path.join(data, 'storage')

  // --- Claude transcripts: two models, three assistant messages, one project.
  const project = path.join(claudeDir, 'projects', '-tmp-token-pace-synthetic')
  fs.mkdirSync(project, { recursive: true })
  fs.writeFileSync(
    path.join(project, '0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0.jsonl'),
    [
      claudeLine({ id: 'msg_syn_a', ts: T, usage: { input: 100, cacheWrite: 50, cacheRead: 400, output: 20 }, final: true }),
      claudeLine({ id: 'msg_syn_b', ts: T, usage: { input: 30, cacheRead: 100, output: 10 }, final: true }),
      claudeLine({ id: 'msg_syn_c', ts: T, model: 'claude-sonnet-4-6', usage: { input: 60, cacheWrite: 10, output: 5 }, final: true }),
    ].join('\n') + '\n',
  )

  // --- The credentials file. Nothing in `auto` mode may read it, and this proves it.
  fs.writeFileSync(
    path.join(claudeDir, '.credentials.json'),
    JSON.stringify({ claudeAiOauth: { accessToken: FAKE_TOKEN, expiresAt: T + 3_600_000 } }),
  )

  // --- Codex rollout, in the dated layout Codex writes.
  const day = new Date(T)
  const p2 = (n: number): string => String(n).padStart(2, '0')
  const codexDay = path.join(
    codexDir, 'sessions', String(day.getUTCFullYear()), p2(day.getUTCMonth() + 1), p2(day.getUTCDate()),
  )
  fs.mkdirSync(codexDay, { recursive: true })
  fs.writeFileSync(
    path.join(codexDay, 'rollout-2026-01-01T00-00-00-thread-syn-0001.jsonl'),
    [
      codexMeta({ ts: T, id: 'thread-syn-0001' }),
      codexTurnContext(T, 'gpt-5.4-synthetic'),
      codexTaskStarted(T),
      codexTokenCount({
        ts: T,
        total: { input: 200, cached: 50, output: 40, total: 240 },
        rateLimits: snakeRateLimits({
          primary: { used_percent: 21, window_minutes: 300, resets_at: Math.floor(T / 1000) + 3600 },
          secondary: null,
        }),
      }),
    ].join('\n') + '\n',
  )

  // --- The external quota cache an independent poller would have written (schema v1).
  const claudeCache = path.join(data, 'cache', 'claude-usage.json')
  fs.mkdirSync(path.dirname(claudeCache), { recursive: true })
  fs.writeFileSync(claudeCache, JSON.stringify({
    schema_version: 1,
    source: 'claude',
    fetched_at: Math.floor(T / 1000),
    fail_count: 0,
    blocked_until: 0,
    writer: 'token-pace-test/0.0.0',
    body: {
      five_hour: { utilization: 37, resets_at: iso(T + 3 * 3_600_000) },
      seven_day: { utilization: 12, resets_at: iso(T + 3 * 86_400_000) },
    },
    providers_error: null,
  }, null, 1))

  return {
    home,
    data,
    claudeDir,
    codexDir,
    storage,
    claudeCache,
    // Deliberately absent: the Codex reading then has to come from the transcript.
    missingCodexCache: path.join(data, 'cache', 'no-codex-cache-here.json'),
    claudeRoot: path.join(claudeDir, 'projects'),
    codexRoot: path.join(codexDir, 'sessions'),
    stateFile: path.join(storage, 'state.json'),
    leaderFile: path.join(storage, 'leader.json'),
  }
}

function settingsOf(fx: Fixture): Record<string, unknown> {
  return {
    'tokenPace.claudeDir': [fx.claudeDir],
    'tokenPace.codexDir': [fx.codexDir],
    'tokenPace.claudeQuotaFile': fx.claudeCache,
    'tokenPace.codexQuotaFile': fx.missingCodexCache,
    // A window wider than one day, so a run just after midnight still sees the fixtures.
    'tokenPace.summary.period': '7d',
    // Every window on screen, not just the one the default picks: the assertions below
    // are about what the status bar can render, not about which selection is the default.
    'tokenPace.windowSelect': 'all',
    // Exercises the debug branches — and puts every debug line under the token check.
    'tokenPace.debug': true,
  }
}

// ---------------------------------------------------------------------------
// Host
// ---------------------------------------------------------------------------

interface Extension {
  activate(context: unknown): Promise<void>
  deactivate(): void
}

interface Host {
  ctx: FakeExtensionContext
  state: FakeVscodeState
  ext: Extension
  elapsedMs: number
}

/**
 * One fake host for the whole file.
 *
 * The bundle evaluates `require('vscode')` when `src/extension` is first loaded and keeps
 * the module object, so a later test cannot be handed a different one — every activation
 * shares this host and starts from `state.reset()`.
 */
const HOST = createFakeVscode()
installVscodeStub(HOST.api)
const state = HOST.state

/** Contexts whose subscriptions are still armed, newest last. */
const LIVE: FakeExtensionContext[] = []

/**
 * Activates the extension against the fake host.
 *
 * `../src/extension` is required lazily and only after the stub is in place: a static
 * import at the top of this file would pull `vscode` in before any test could run.
 */
interface ActivateOptions {
  /** Merged over `settingsOf(fx)` — the settings this activation reads. */
  settings?: Record<string, unknown>
  /** A `globalState` that survives the activation, for the once-per-machine memories. */
  globalState?: Map<string, unknown>
  /** `vscode.env.remoteName`: undefined is a local window, a string is WSL/SSH. */
  remoteName?: string
  /**
   * Answers for the dialogs of this activation, oldest first. They have to be queued
   * here rather than before the call: `state.reset()` clears the queue.
   */
  answers?: unknown[]
}

async function activateHost(
  fx: Fixture,
  extensionPath: string,
  opts: ActivateOptions = {},
): Promise<Host> {
  state.reset({ ...settingsOf(fx), ...(opts.settings ?? {}) })
  // After the reset: it clears the remote name and the answer queue along with every
  // other recording.
  state.setRemoteName(opts.remoteName)
  state.answers.push(...(opts.answers ?? []))
  const ext = require('../src/extension') as Extension
  const ctx = createFakeContext({ storage: fx.storage, extensionPath, globalState: opts.globalState })
  LIVE.push(ctx)
  const started = Date.now()
  await ext.activate(ctx)
  return { ctx, state, ext, elapsedMs: Date.now() - started }
}

/** Disposal is asserted per test; this only stops a *failing* test from hanging the run. */
function releaseAll(): void {
  for (const ctx of LIVE.splice(0)) {
    try {
      disposeAll(ctx)
    } catch {
      /* the assertion that already failed is the interesting one */
    }
  }
}

async function waitFor(what: string, ok: () => boolean, ms = 20_000): Promise<void> {
  const deadline = Date.now() + ms
  for (;;) {
    if (ok()) return
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await new Promise((r) => setTimeout(r, 20))
  }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** The text of the most recently opened read-only usage document. */
function lastMarkdown(): string {
  const doc = state.documents[state.documents.length - 1]
  assert.ok(doc, 'no usage document was opened')
  return doc.text
}

/** Snapshot fields that must not depend on which thread did the scanning. */
function bucketFingerprint(file: string): string[] {
  const snap = JSON.parse(fs.readFileSync(file, 'utf8')) as {
    buckets: Array<Record<string, unknown>>
  }
  return snap.buckets
    .map((b) => ['source', 'model', 'isSub', 'input', 'cacheWrite', 'cacheRead', 'output', 'requests']
      .map((k) => `${k}=${String(b[k])}`).join(' '))
    .sort()
}

// ---------------------------------------------------------------------------
// Environment
// ---------------------------------------------------------------------------

const SAVED_ENV: Record<string, string | undefined> = {}
const ENV_KEYS = ['HOME', 'USERPROFILE', 'CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'CLAUDE_SECURESTORAGE_CONFIG_DIR']

let fixture: Fixture
let workerFingerprint: string[] = []

before(() => {
  fixture = makeFixture()
  for (const k of ENV_KEYS) SAVED_ENV[k] = process.env[k]
  // `~/.claude.json` is derived from os.homedir() and cannot be injected; moving the home
  // directory is the only way to keep this test off the developer's own file.
  process.env.HOME = fixture.home
  process.env.USERPROFILE = fixture.home
  delete process.env.CLAUDE_CONFIG_DIR
  delete process.env.CODEX_HOME
  delete process.env.CLAUDE_SECURESTORAGE_CONFIG_DIR
  assert.equal(os.homedir(), fixture.home, 'the fake home must be in effect before activation')

  // The worker path needs dist/scanWorker.js. CI builds before it tests; a bare
  // `node --test` after a checkout does not, so build once rather than skip the path.
  if (!fs.existsSync(path.join(REPO, 'dist', 'scanWorker.js'))) {
    try {
      execFileSync(process.execPath, ['build.mjs'], { cwd: REPO, stdio: 'ignore' })
    } catch {
      // Without the bundle the extension falls back to the main thread, which the
      // second test asserts anyway — the run stays meaningful.
    }
  }
})

after(() => {
  releaseAll()
  for (const k of ENV_KEYS) {
    if (SAVED_ENV[k] === undefined) delete process.env[k]
    else process.env[k] = SAVED_ENV[k]
  }
})

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test('activation reads the synthetic transcripts, fills the status bar and releases everything', async () => {
  const host = await activateHost(fixture, REPO)
  const { ctx } = host

  // --- activation does not wait for the scan -------------------------------
  assert.ok(host.elapsedMs < 2000, `activate() took ${host.elapsedMs} ms`)
  // Only microtasks have run since `void bootstrap()`, so the cold scan cannot be done.
  assert.equal(state.textOf(TOKENS_ITEM), '$(sync~spin) reading history …')
  assert.equal(fs.existsSync(fixture.stateFile), false)

  await waitFor('the cold scan', () => (state.textOf(TOKENS_ITEM) ?? '').startsWith('Σ'))

  // The scan drops the quota memo, so the Codex window — which can only come from the
  // rollout that was just read — is on screen in the very frame that ends the scan.
  // Without that invalidation the memoised "unavailable" reading would stand for up to
  // five seconds, and this line would see `tokenPace.quota.codex.problem` instead.
  assert.ok(
    state.textOf(CODEX_ITEM) !== undefined,
    `the Codex window is not up yet: ${state.live().map((i) => i.id).join(', ')}`,
  )

  // --- the roots that were actually used -----------------------------------
  assert.match(state.logText(), new RegExp(`Claude roots: ${escapeRe(fixture.claudeRoot)}`))
  assert.match(state.logText(), new RegExp(`Codex roots:  ${escapeRe(fixture.codexRoot)}`))
  assert.match(state.logText(), /Role: single → leader/)

  // --- status bar ----------------------------------------------------------
  assert.deepEqual(
    state.live().map((i) => i.id).sort(),
    [CLAUDE_SESSION_ITEM, CLAUDE_WEEK_ITEM, CODEX_ITEM, TOKENS_ITEM].sort(),
  )
  const session = state.textOf(CLAUDE_SESSION_ITEM) ?? ''
  assert.match(session, /CC 5h/, session)
  assert.match(session, /\b37%/, session)
  assert.match(state.textOf(CLAUDE_WEEK_ITEM) ?? '', /\b12%/)
  // Codex has no cache file, so this figure can only have come from the rollout.
  assert.match(state.textOf(CODEX_ITEM) ?? '', /CDX 5h.*\b21%/)
  assert.equal(state.textOf(TOKENS_ITEM), `Σ ${EXPECTED_BILLABLE} · 7d`)
  for (const item of state.live()) {
    assert.doesNotMatch(item.text, /NaN|undefined|Infinity/, `${item.id}: ${item.text}`)
  }

  // --- the persisted snapshot ----------------------------------------------
  const snap = JSON.parse(fs.readFileSync(fixture.stateFile, 'utf8')) as {
    version: number
    buckets: unknown[]
    cursors: Record<string, unknown>
  }
  assert.equal(snap.version, STATE_VERSION)
  assert.equal(snap.version, 5)
  // Two Claude models plus one Codex model, all in the same hour.
  assert.equal(snap.buckets.length, 3)
  assert.equal(Object.keys(snap.cursors).length, 2)
  workerFingerprint = bucketFingerprint(fixture.stateFile)

  // --- commands -------------------------------------------------------------
  const manifest = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8')) as {
    contributes: { commands: Array<{ command: string }> }
  }
  const declared = manifest.contributes.commands.map((c) => c.command).sort()
  // Not an exact count: the manifest grows. Every declared command must exist, and no
  // command may be registered that the manifest does not declare.
  assert.ok(declared.length >= 20, `only ${declared.length} commands are declared`)
  assert.deepEqual([...state.registered.keys()].sort(), declared)
  for (const [id, count] of state.registered) assert.equal(count, 1, `${id} was registered ${count} times`)

  // --- diagnostics carry the roots and no secret ----------------------------
  await state.execute('tokenPace.copyDiagnostics')
  const report = state.clipboard[state.clipboard.length - 1]
  assert.ok(report && report.length > 0, 'no diagnostics were copied')
  // The temporary roots are outside the (temporary) home, so they appear verbatim.
  assert.ok(report.includes(fixture.claudeRoot), 'the Claude root is missing from the report')
  assert.ok(report.includes(fixture.codexRoot), 'the Codex root is missing from the report')
  assert.equal(report.includes(fixture.home), false, 'the home directory leaked into the report')
  assert.equal(report.includes('sk-ant'), false, 'a token-shaped string is in the report')
  assert.equal(report.includes(FAKE_TOKEN), false, 'the credentials token is in the report')
  assert.equal(state.logText().includes(FAKE_TOKEN), false, 'the credentials token reached a log line')
  assert.equal(state.logText().includes('sk-ant'), false, 'a token-shaped string reached a log line')

  // --- setRange rebuilds the view model -------------------------------------
  await state.execute('tokenPace.showUsageMarkdown')
  // The header line is the range; the "Last 30 days" row further down is a fixed
  // summary row that stats.ts writes whatever the range is.
  assert.match(lastMarkdown(), /^\*Last 30 days · \d{4}-\d\d-\d\d → /m)
  await state.execute('tokenPace.setRange', '7d')
  assert.equal((ctx.globalState.get<{ range: string }>('tokenPace.ui') ?? { range: '' }).range, '7d')
  await state.execute('tokenPace.showUsageMarkdown')
  assert.match(lastMarkdown(), /^\*Last 7 days · \d{4}-\d\d-\d\d → /m)
  // An unknown preset is ignored rather than accepted as a custom range.
  await state.execute('tokenPace.setRange', 'not-a-range')
  assert.equal((ctx.globalState.get<{ range: string }>('tokenPace.ui') ?? { range: '' }).range, '7d')

  // --- the QuickPick view -----------------------------------------------------
  await state.execute('tokenPace.showUsageQuickPick')
  const quickPick = state.quickPickControls[state.quickPickControls.length - 1]
  assert.ok(quickPick, 'no QuickPick was created')
  assert.ok(quickPick.items.length > 0, 'the QuickPick is empty')
  assert.equal(quickPick.shown, true)
  for (const item of quickPick.items) {
    assert.equal(typeof item.label, 'string')
    // A separator is a heading: it carries a label and nothing else.
    if (item.kind === -1) {
      assert.equal(item.command, undefined, `a separator carries a command: ${String(item.label)}`)
      assert.equal(item.detail, undefined)
    }
  }

  // --- the status bar preview toggles ---------------------------------------
  await state.execute('tokenPace.previewStatusBar')
  assert.ok(state.live('tokenPace.preview.').length > 0, 'no preview items were created')
  await state.execute('tokenPace.previewStatusBar')
  assert.equal(state.live('tokenPace.preview.').length, 0, 'the preview did not clear itself')

  // --- teardown -------------------------------------------------------------
  const failures = disposeAll(LIVE.pop()!)
  assert.deepEqual(failures, [], 'a dispose() threw')
  host.ext.deactivate()
  assert.equal(state.live().length, 0, 'a status bar item survived disposal')

  // The one-second tick would build new items; after disposal nothing more may appear.
  const created = state.items.length
  await sleep(1500)
  assert.equal(state.items.length, created, 'a timer was still running after disposal')
})

test('without dist/scanWorker.js the main-thread fallback produces the same counts', async () => {
  const fx = makeFixture()
  const bare = tmpDir('tp-noext')
  await activateHost(fx, bare)

  await waitFor('the fallback scan', () => (state.textOf(TOKENS_ITEM) ?? '').startsWith('Σ'))

  // The fallback leaves through the same `finally`, so it drops the memo just as well.
  assert.match(state.textOf(CODEX_ITEM) ?? '', /\b21%/)

  assert.ok(workerFingerprint.length > 0, 'the worker run did not record a fingerprint to compare against')
  assert.match(state.logText(), /falling back to the main thread/)
  assert.equal(state.textOf(TOKENS_ITEM), `Σ ${EXPECTED_BILLABLE} · 7d`)
  assert.deepEqual(bucketFingerprint(fx.stateFile), workerFingerprint)

  assert.deepEqual(disposeAll(LIVE.pop()!), [])
})

test('a live foreign lease makes the window a follower: no cold scan, no snapshot', async () => {
  const fx = makeFixture()
  fs.mkdirSync(fx.storage, { recursive: true })
  // Our own pid is alive by definition, and the random lease id is never ours.
  fs.writeFileSync(fx.leaderFile, JSON.stringify({
    pid: process.pid,
    id: 'another-window-0123456789abcdef',
    // Inside 2 × TTL, so the lease counts as live rather than as a bogus clock.
    expiresAt: Date.now() + 120_000,
  }))

  await activateHost(fx, REPO)

  await waitFor('the follower role', () => state.logText().includes('Role: single → follower'))
  // Give a cold scan every chance to happen, then show that it did not.
  await sleep(300)

  assert.match(state.logText(), /Role: single → follower/)
  assert.doesNotMatch(state.logText(), /Cold start done/)
  assert.equal(fs.existsSync(fx.stateFile), false, 'a follower wrote the shared snapshot')
  // The lease record still belongs to the other window.
  const held = JSON.parse(fs.readFileSync(fx.leaderFile, 'utf8')) as { id: string }
  assert.equal(held.id, 'another-window-0123456789abcdef')
  // Quota still renders: a follower reads the same files the leader would.
  assert.match(state.textOf(CLAUDE_SESSION_ITEM) ?? '', /\b37%/)

  assert.deepEqual(disposeAll(LIVE.pop()!), [])
  assert.equal(fs.existsSync(fx.stateFile), false, 'a follower wrote the snapshot on the way out')
})

/** The same fixture with both transcript roots removed: nothing to read anywhere. */
function makeEmptyFixture(): Fixture {
  const fx = makeFixture()
  fs.rmSync(fx.claudeRoot, { recursive: true, force: true })
  fs.rmSync(fx.codexRoot, { recursive: true, force: true })
  return fx
}

test('on a remote host with no transcripts the hint writes remote.extensionKind and offers a reload', async () => {
  const fx = makeEmptyFixture()
  const shared = new Map<string, unknown>()

  await activateHost(fx, REPO, {
    remoteName: 'wsl',
    globalState: shared,
    answers: ['Run Token Pace locally', 'Reload Window'],
    settings: {
      // No offer to fetch: this test is about the remote hint, and a second dialog
      // would eat the queued answers.
      'tokenPace.quotaSource': 'cache',
      // An unrelated entry that must survive: the setting is a map others share.
      'remote.extensionKind': { 'some.other-extension': ['workspace'] },
    },
  })

  await waitFor(
    'the remote hint',
    () => state.messages.some((m) => m.text.includes('remote "wsl"')),
  )
  const hint = state.messages.find((m) => m.text.includes('remote "wsl"'))!
  assert.deepEqual(hint.actions, ['Run Token Pace locally', 'Open Settings', 'Not now'])

  await waitFor('the reload prompt', () => state.executed.includes('workbench.action.reloadWindow'))
  assert.deepEqual(state.settings.get('remote.extensionKind'), {
    'some.other-extension': ['workspace'],
    'frederik.token-pace': ['ui'],
  })
  assert.equal(shared.get('tokenPace.remoteHintShown'), true)
  assert.deepEqual(disposeAll(LIVE.pop()!), [])

  // --- once per machine, whatever the answer was --------------------------
  await activateHost(fx, REPO, {
    remoteName: 'wsl',
    globalState: shared,
    settings: { 'tokenPace.quotaSource': 'cache' },
  })
  await waitFor('the second bootstrap', () => state.logText().includes('Cold start done'))
  await sleep(200)
  assert.equal(
    state.messages.some((m) => m.text.includes('remote "wsl"')),
    false,
    'the hint was shown a second time',
  )
  assert.deepEqual(disposeAll(LIVE.pop()!), [])
})

test('clear stored data lists the shared cache and says the bridge has to go first', async () => {
  const fx = makeFixture()
  // A status line that is ours: the record and the settings file agree.
  const installed = 'node /opt/token-pace/dist/statusline-bridge.js'
  fs.writeFileSync(
    path.join(fx.claudeDir, 'settings.json'),
    JSON.stringify({ statusLine: { type: 'command', command: installed } }),
  )
  const shared = new Map<string, unknown>([
    // The opt-in was granted at some point, so the shared file is ours to offer.
    ['writeConsent.writeQuotaCache', 'granted'],
    ['tokenPace.bridge', { previous: undefined, installedCommand: installed, at: T }],
  ])

  await activateHost(fx, REPO, { globalState: shared })
  await waitFor('the cold scan', () => (state.textOf(TOKENS_ITEM) ?? '').startsWith('Σ'))

  // --- the list itself ------------------------------------------------------
  await state.execute('tokenPace.clearStoredData')
  const offered = state.quickPicks[state.quickPicks.length - 1]
  assert.ok(offered, 'no pick list was shown')
  const cache = offered.items.find((i) => i.key === 'externalQuota')
  assert.ok(cache, `the shared quota cache is missing: ${offered.items.map((i) => i.label).join(' | ')}`)
  assert.ok(String(cache.detail).includes(fx.claudeCache), 'the Claude cache path is not named')
  assert.ok(String(cache.detail).includes(fx.missingCodexCache), 'the Codex cache path is not named')

  // The bridge line is a statement, not a deletable item: no key, and a separator above it.
  const bridgeLine = offered.items.find((i) => i.detail === BRIDGE_BLOCKS_DELETE)
  assert.ok(bridgeLine, 'the installed bridge is not mentioned')
  assert.equal(bridgeLine.key, undefined)
  assert.ok(String(bridgeLine.detail).includes('Disconnect Claude Status Line'))
  assert.ok(offered.items.some((i) => i.kind === -1), 'the bridge line has no separator above it')

  // --- picking only that line deletes nothing -------------------------------
  const before = state.messages.length
  state.answers.push([bridgeLine])
  await state.execute('tokenPace.clearStoredData')
  assert.equal(state.messages.length, before, 'a confirmation was asked for an empty selection')
  assert.equal(fs.existsSync(fx.claudeCache), true)

  // --- and the shared file really is deleted --------------------------------
  state.answers.push([cache], 'Delete')
  await state.execute('tokenPace.clearStoredData')
  assert.equal(fs.existsSync(fx.claudeCache), false, 'the shared quota cache survived')
  assert.equal(fs.existsSync(fx.stateFile), true, 'an item that was not picked was deleted')
  const confirm = state.messages[state.messages.length - 1]
  assert.match(confirm.text, /Delete 1 stored item/)

  assert.deepEqual(disposeAll(LIVE.pop()!), [])
})

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
