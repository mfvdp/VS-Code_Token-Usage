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
  agentResultLine, agentToolUseLine, claudeLine, codexMeta, codexTaskStarted, codexTokenCount, codexTurnContext, iso,
  journalLine, metaJson, snakeRateLimits, tmpDir,
} from './fixtures/helpers'
import {
  createFakeContext, createFakeVscode, disposeAll, FakeExtensionContext, FakeVscodeState, installVscodeStub,
} from './helpers/fakeVscode'
// Shapes and constants only: agentTree.ts imports nothing, so loading it early reads no setting.
import { AgentTreeVm, emptyAgentTree, TreeNode } from '../src/agentTree'
// Type-only, so the bundle still requires `../src/extension` lazily — see `activateHost`, and
// `lazy` for the modules below it.
import type { TokenPaceApi } from '../src/extension'
import { bridgeBlocksDelete } from '../src/storage'
import { Snapshot, STATE_VERSION } from '../src/types'

/** Never a real key: the string is asserted *absent* from every output this test reads. */
const FAKE_TOKEN = 'sk-ant-oat01-SYNTHETIC-TEST-TOKEN-0000000000000000'

/** One instant for every synthetic record, so both scan paths produce identical buckets. */
const T = Date.now()

const CLAUDE_SESSION_ITEM = 'tokenPace.quota.claude.session.300'
const CLAUDE_WEEK_ITEM = 'tokenPace.quota.claude.weekly_all.10080'
const CODEX_ITEM = 'tokenPace.quota.codex.codex.300'
const TOKENS_ITEM = 'tokenPace.tokens'
const CONTEXT_ITEM = 'tokenPace.context'
const BUDGET_ITEM = 'tokenPace.budget'

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
  activate(context: unknown): Promise<TokenPaceApi>
  deactivate(): void
}

interface Host {
  ctx: FakeExtensionContext
  state: FakeVscodeState
  ext: Extension
  /** What `activate()` resolved with — the extension-host smoke test reads the bar through it. */
  api: TokenPaceApi
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
  /** `vscode.env.language` and the bundle VS Code would have loaded for it — the i18n seam's input. */
  language?: { tag: string; bundle?: Record<string, string> }
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
  if (opts.language) state.setLanguage(opts.language.tag, opts.language.bundle)
  state.answers.push(...(opts.answers ?? []))
  const ext = require('../src/extension') as Extension
  const ctx = createFakeContext({ storage: fx.storage, extensionPath, globalState: opts.globalState })
  LIVE.push(ctx)
  const started = Date.now()
  const api = await ext.activate(ctx)
  return { ctx, state, ext, api, elapsedMs: Date.now() - started }
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

/**
 * The dashboard's own message channel: the provider the extension registered, resolved
 * against a fake webview view, so a test can send exactly what the page would send.
 */
function dashboardPost(): (m: unknown) => void {
  return openDashboard().post
}

/** The same fake view, and everything the provider posted to it, oldest first. */
function openDashboard(): { post: (m: unknown) => void; sent: unknown[] } {
  const provider = state.webviewProviders.get('tokenPace.dashboard') as
    { resolveWebviewView(view: unknown): void } | undefined
  assert.ok(provider, 'the dashboard view provider was not registered')
  const sink: Array<(m: unknown) => void> = []
  const sent: unknown[] = []
  provider.resolveWebviewView({
    visible: true,
    webview: {
      options: {},
      html: '',
      onDidReceiveMessage(fn: (m: unknown) => void): { dispose(): void } {
        sink.push(fn)
        return { dispose: () => undefined }
      },
      postMessage: (m: unknown) => {
        sent.push(m)
        return Promise.resolve(true)
      },
      cspSource: '',
    },
    onDidChangeVisibility: () => ({ dispose: () => undefined }),
    onDidDispose: () => ({ dispose: () => undefined }),
    show: () => undefined,
  })
  assert.equal(sink.length, 1, 'the dashboard did not subscribe to its webview')
  return { post: sink[0], sent }
}

/** Snapshot fields that must not depend on which thread did the scanning. */
function bucketFingerprint(file: string): string[] {
  return fingerprintOf(JSON.parse(fs.readFileSync(file, 'utf8')) as Snapshot)
}

function fingerprintOf(snap: Snapshot): string[] {
  return (snap.buckets as unknown as Array<Record<string, unknown>>)
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
  assert.equal(snap.version, 7)
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

  // --- the gear in a section header opens that section's settings --------------
  const post = dashboardPost()
  const openings = (): Array<{ id: string; args: unknown[] }> =>
    state.executedArgs.filter((c) => c.id === 'workbench.action.openSettings')
  const before = openings().length
  post({ type: 'openSectionSettings', key: 'tools' })
  const opened = openings()
  assert.equal(opened.length, before + 1, 'the gear did not open the settings')
  // One `@id:` filter naming real settings — not a search term, and not the whole extension.
  assert.deepEqual(opened[opened.length - 1].args,
    ['@id:tokenPace.retentionDays,tokenPace.dashboard.sections'])
  post({ type: 'openSectionSettings', key: 'quota' })
  const quota = String(openings()[openings().length - 1].args[0])
  assert.match(quota, /^@id:tokenPace\./)
  assert.ok(quota.includes('tokenPace.quotaSource'), quota)
  assert.ok(quota.endsWith('tokenPace.dashboard.sections'), quota)
  // A key that is not a section, or a setting id smuggled in as one, never reaches a command.
  for (const key of ['tokenPace.debug', 'controls', 42]) {
    post({ type: 'openSectionSettings', key })
  }
  assert.equal(openings().length, before + 2, 'a message outside the allow-list opened settings')

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
  const bridgeLine = offered.items.find((i) => i.detail === bridgeBlocksDelete())
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

test('the bundle VS Code loaded for the language reaches the dialogs: activate() feeds the i18n seam', async () => {
  const fx = makeEmptyFixture()
  const de = JSON.parse(fs.readFileSync(path.join(REPO, 'l10n', 'bundle.l10n.de.json'), 'utf8')) as Record<string, string>
  const key = Object.keys(de).find((k) => k.startsWith('Token Pace found no Claude Code or Codex transcripts'))
  assert.ok(key, 'the remote hint has no German entry')
  const buttons = ['Run Token Pace locally', 'Open Settings', 'Not now'].map((k) => de[k])
  assert.ok(buttons.every((b) => typeof b === 'string' && b.length > 0), 'a button of the remote hint has no German entry')
  const expected = de[key].replace('{0}', 'wsl')

  await activateHost(fx, REPO, {
    remoteName: 'wsl',
    globalState: new Map<string, unknown>(),
    language: { tag: 'de', bundle: de },
    // Answered with the German labels: the code has to compare against what it showed.
    answers: [buttons[0], de['Reload Window']],
    settings: { 'tokenPace.quotaSource': 'cache' },
  })

  await waitFor('the German remote hint', () => state.messages.some((m) => m.text === expected))
  const hint = state.messages.find((m) => m.text === expected)!
  assert.deepEqual(hint.actions, buttons)
  await waitFor('the reload prompt', () => state.executed.includes('workbench.action.reloadWindow'))
  const reload = state.messages.find((m) => m.actions.includes(de['Reload Window']))
  assert.ok(reload, 'the reload prompt was not shown with the German button')
  assert.equal(reload.text, de['Token Pace will run on the local machine after a window reload.'])

  assert.deepEqual(disposeAll(LIVE.pop()!), [])
})

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

test('the status line mirror reaches the context entry and the text view', async () => {
  const fx = makeFixture()
  fs.mkdirSync(fx.storage, { recursive: true })
  // A mirror the bridge could have written a minute ago: the same shape as the fixture in
  // test/fixtures/quota, with a fresh timestamp so nothing is stale.
  fs.writeFileSync(path.join(fx.storage, 'statusline-mirror.json'), JSON.stringify({
    schema_version: 1,
    written_at: Date.now() - 60_000,
    payload: {
      rate_limits: { five_hour: { used_percentage: 44 } },
      context_window: {
        total_input_tokens: 120_000,
        total_output_tokens: 8_000,
        context_window_size: 200_000,
        used_percentage: 64,
      },
      // A warm cache with an hour to go: the line the Claude card, the text view and the
      // tooltip print from this one reading.
      prompt_cache: { warm: true, ttl: '1h', expires_at: Math.floor(Date.now() / 1000) + 3_600, hit_ratio: 0.82 },
    },
  }))

  await activateHost(fx, REPO, {
    settings: { 'tokenPace.statusBar.show': ['claudeQuota', 'context', 'tokens'] },
  })
  await waitFor('the context entry', () => state.textOf(CONTEXT_ITEM) !== undefined)
  // The cold scan is awaited so this test leaves nothing running behind it.
  await waitFor('the cold scan', () => (state.textOf(TOKENS_ITEM) ?? '').startsWith('Σ'))

  assert.equal(state.textOf(CONTEXT_ITEM), 'ctx 64%')
  // One session's window, said once, and the same figure in the text view — not a second
  // derivation from the same file.
  await state.execute('tokenPace.showUsageMarkdown')
  const md = lastMarkdown()
  assert.equal(md.split('## Context window').length, 2, md)
  assert.ok(md.includes('128,000 / 200,000 · 64 % — current session, via the status line'), md)
  // The prompt cache from the same mirror, under the Claude windows, with its parts.
  assert.match(md, /\nprompt cache warm · expires in \d+ (h|m) \d+ (m|s) \(1 h TTL\) · hit ratio 82 % — current session, via the status line · updated [^\n]+\n/)

  assert.deepEqual(disposeAll(LIVE.pop()!), [])
})

test('a configured budget reaches the status bar and the markdown view from one derivation', async () => {
  const fx = makeFixture()
  await activateHost(fx, REPO, {
    settings: {
      'tokenPace.statusBar.show': ['budget', 'tokens'],
      'tokenPace.dashboard.sections': ['budget'],
      // Small enough that the synthetic transcripts move it, and stated by the test, so no
      // part of it can have been derived from a plan or a provider reading.
      'tokenPace.budgets': [{ scope: 'total', period: 'month', unit: 'tokens', limit: 1000 }],
    },
  })
  await waitFor('the cold scan', () => (state.textOf(TOKENS_ITEM) ?? '').startsWith('Σ'))
  await waitFor('the budget entry', () => state.textOf(BUDGET_ITEM) !== undefined)

  const text = String(state.textOf(BUDGET_ITEM))
  assert.match(text, /^budget \d+ %/, text)
  // A token budget's share is measured, not hypothetical, so it carries no estimate marker.
  assert.equal(text.includes('~'), false, text)

  // The same share in the text view — the bar takes the row from the view model rather than
  // computing a second one.
  await state.execute('tokenPace.showUsageMarkdown')
  const md = lastMarkdown()
  assert.equal(md.split('## Budgets').length, 2, md)
  const share = text.replace('budget ', '').replace(' over', '')
  assert.ok(md.includes(`| ${share} |`) || md.includes(`| ${share} ⚠ |`), md)

  assert.deepEqual(disposeAll(LIVE.pop()!), [])
})

test('a settings change is applied live: no reload between the edit and the status bar', async () => {
  const fx = makeFixture()
  await activateHost(fx, REPO, {
    settings: { 'tokenPace.statusBar.show': ['tokens'], 'tokenPace.summary.period': 'today' },
  })
  await waitFor('the cold scan', () => (state.textOf(TOKENS_ITEM) ?? '').startsWith('Σ'))
  assert.ok(String(state.textOf(TOKENS_ITEM)).endsWith('· today'), state.textOf(TOKENS_ITEM))

  // The workbench answers `affectsConfiguration` per section prefix; the host asks for the
  // whole namespace. That question was once spelt `tokenPace.tokenPace`, a section that does
  // not exist, and every settings change quietly waited for a reload.
  state.set('tokenPace.summary.period', '7d')
  state.fireConfigChange(['tokenPace.summary.period'])
  await waitFor('the period to change', () => String(state.textOf(TOKENS_ITEM) ?? '').endsWith('· 7d'))
  assert.ok(String(state.textOf(TOKENS_ITEM)).startsWith('Σ'), state.textOf(TOKENS_ITEM))

  state.set('tokenPace.statusBar.show', [])
  state.fireConfigChange(['tokenPace.statusBar.show'])
  await waitFor('the item to go', () => state.textOf(TOKENS_ITEM) === undefined)

  assert.deepEqual(disposeAll(LIVE.pop()!), [])
})

test('a stored chart stack from an older build is ignored, and the rest of the state restores', async () => {
  // The persisted UI state is user data from an older build: every field goes through the
  // restore validation, and what fails it falls back to the default instead of reaching the
  // view model. An older build stored the chart's stacking; the chart is always by model now,
  // so that key is dropped without a word while the fields beside it survive. `setRange`
  // writes the whole restored state back, which is where it is readable.
  const kept = new Map<string, unknown>([
    ['tokenPace.ui', {
      range: '30d', chartStack: 'model', hourZone: 'utc', heatmapMetric: 'sideways', compositionCache: 'noCache',
    }],
  ])
  const host = await activateHost(makeFixture(), REPO, { globalState: kept })
  await state.execute('tokenPace.setRange', '7d')
  const ui = host.ctx.globalState.get<Record<string, unknown>>('tokenPace.ui')
  assert.ok(ui, 'no UI state was written back')
  assert.equal(ui?.range, '7d')
  assert.equal(ui?.hourZone, 'utc')
  assert.equal(ui?.heatmapMetric, 'usage')
  assert.equal(ui?.compositionCache, 'noCache')
  // A field an older build stored and this one no longer has is dropped, not carried.
  assert.equal('chartStack' in (ui as Record<string, unknown>), false)
  assert.deepEqual(disposeAll(LIVE.pop()!), [])

  const junk = new Map<string, unknown>([
    ['tokenPace.ui', { chartStack: 'by-the-moon', compositionCache: 'sometimes' }],
  ])
  const second = await activateHost(makeFixture(), REPO, { globalState: junk })
  await state.execute('tokenPace.setRange', '7d')
  const restored = second.ctx.globalState.get<Record<string, unknown>>('tokenPace.ui')
  assert.equal('chartStack' in (restored as Record<string, unknown>), false)
  assert.equal(restored?.compositionCache, 'all')
  assert.deepEqual(disposeAll(LIVE.pop()!), [])
})

test('stored agent folds and selection restore by shape; over-long keys are dropped', async () => {
  // The two agent tree fields are opaque node keys: only their shape is checked on restore —
  // strings of at most 200 chars, at most 200 folds, a selection that is such a string or null.
  const long = 'k'.repeat(201)
  const folds = ['s:/p/a.jsonl', long, 7, '', 's:/p/a.jsonl', ...Array.from({ length: 250 }, (_, i) => `a:${i}`)]
  const kept = new Map<string, unknown>([
    ['tokenPace.ui', { range: '30d', agentsFolded: folds, agentSelected: 'l:toolu_01' }],
  ])
  const host = await activateHost(makeFixture(), REPO, { globalState: kept })
  await state.execute('tokenPace.setRange', '7d')
  const ui = host.ctx.globalState.get<Record<string, unknown>>('tokenPace.ui')
  const restored = ui?.agentsFolded as string[]
  assert.ok(Array.isArray(restored), 'agentsFolded was not written back')
  assert.equal(restored.length, 200)
  assert.equal(restored[0], 's:/p/a.jsonl')
  assert.equal(restored.includes(long), false)
  assert.ok(restored.every((k) => typeof k === 'string' && k.length > 0 && k.length <= 200))
  assert.equal(new Set(restored).size, restored.length)
  assert.equal(ui?.agentSelected, 'l:toolu_01')
  assert.deepEqual(disposeAll(LIVE.pop()!), [])

  const junk = new Map<string, unknown>([
    ['tokenPace.ui', { agentsFolded: 'not-a-list', agentSelected: long }],
  ])
  const second = await activateHost(makeFixture(), REPO, { globalState: junk })
  await state.execute('tokenPace.setRange', '7d')
  const back = second.ctx.globalState.get<Record<string, unknown>>('tokenPace.ui')
  assert.deepEqual(back?.agentsFolded, [])
  assert.equal(back?.agentSelected, null)
  assert.deepEqual(disposeAll(LIVE.pop()!), [])
})

test('activate() returns the API the extension-host smoke test reads the bar through', async () => {
  // `test-e2e/` asserts a *real* settings round-trip through this return value, so what it
  // reports has to be exactly what the bar shows — otherwise the smoke test could pass over
  // a window that renders nothing. Here that is checkable: the fake host records every item.
  const host = await activateHost(makeFixture(), REPO, {
    settings: { 'tokenPace.summary.period': 'today' },
  })
  const manifest = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8')) as { version: string }
  assert.equal(host.api.version, manifest.version)

  await waitFor('the cold scan', () => (state.textOf(TOKENS_ITEM) ?? '').startsWith('Σ'))
  // Every id on the bar, with the bar's own text. The comparison goes by id rather than by
  // position: `state.live()` records items in creation order, and an activation of an earlier
  // test in this process can still be ticking into the same recording.
  const items = host.api.statusBar()
  assert.deepEqual(
    items.map((i) => i.id).sort(),
    [...new Set(state.live().map((i) => i.id))].sort(),
  )
  for (const item of items) assert.equal(item.text, state.textOf(item.id))

  // The same live seam the smoke test watches, one layer lower: the API has to follow a
  // settings change without a reload, because that is the only way the e2e check can see one.
  const before = state.textOf(TOKENS_ITEM)
  state.set('tokenPace.summary.period', '7d')
  state.fireConfigChange(['tokenPace.summary.period'])
  await waitFor('the period to change', () => String(state.textOf(TOKENS_ITEM) ?? '').endsWith('· 7d'))
  const after = host.api.statusBar().find((i) => i.id === TOKENS_ITEM)?.text
  assert.notEqual(after, before)
  assert.equal(after, state.textOf(TOKENS_ITEM))

  // Nothing but ids and texts: no tooltip, no command, nothing a transcript could reach.
  for (const item of host.api.statusBar()) {
    assert.deepEqual(Object.keys(item).sort(), ['id', 'text'])
  }

  assert.deepEqual(disposeAll(LIVE.pop()!), [])
})

// ---------------------------------------------------------------------------
// The Agents section: the hot-directory poll, the one-time replay, a follower
// ---------------------------------------------------------------------------

/**
 * The modules below the extension, loaded the way the extension itself is: lazily, once
 * `before` has moved the home directory. Loading discover.ts configures the default roots from
 * `os.homedir()`, and this file never lets that be the developer's own.
 */
function lazy(): {
  ext: typeof import('../src/extension')
  scan: typeof import('../src/scan')
  agg: typeof import('../src/agg')
  discover: typeof import('../src/discover')
} {
  return {
    ext: require('../src/extension'),
    scan: require('../src/scan'),
    agg: require('../src/agg'),
    discover: require('../src/discover'),
  }
}

const MINUTE = 60_000
const HOUR = 60 * MINUTE

/** Session ids in the shape Claude Code writes them, and two workflow runs. */
const ACTIVE = 'a0a0a0a0-1111-4111-8111-000000000001'
const IDLE = 'b0b0b0b0-2222-4222-8222-000000000002'
const RUN = 'wf_c0ffee00-3333-4333'
const RUN2 = 'wf_d0d0d0d0-4444-4444'

function writeLines(file: string, lines: string[]): void {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, lines.map((l) => `${l}\n`).join(''))
}

function appendLine(file: string, line: string): void {
  fs.appendFileSync(file, `${line}\n`)
}

function sidecarOf(file: string): string {
  return file.replace(/\.jsonl$/, '.meta.json')
}

interface AgentWorld {
  project: string
  activeMain: string
  idleMain: string
  /** A workflow agent that is still writing, and the journal of its run. */
  running: string
  journal: string
  /** A sync agent whose result the parent recorded. */
  sync: string
  /** The idle session's agent: silent for two hours, no result. */
  idleAgent: string
  /** What the world adds to the fixture's billable tokens. */
  billable: number
}

/**
 * Two Claude sessions beside the fixture's own: an active one with a running workflow agent
 * and a finished sync agent it launched, and one idle for two hours with a silent agent. Every
 * line is invented; the shapes are the ones test/fixtures/helpers.ts documents.
 */
function writeAgentWorld(fx: Fixture): AgentWorld {
  const project = path.join(fx.claudeRoot, '-tmp-token-pace-synthetic')
  const sub = (session: string, ...rest: string[]): string => path.join(project, session, 'subagents', ...rest)
  const w: AgentWorld = {
    project,
    activeMain: path.join(project, `${ACTIVE}.jsonl`),
    idleMain: path.join(project, `${IDLE}.jsonl`),
    running: sub(ACTIVE, 'workflows', RUN, 'agent-a1a1a1.jsonl'),
    journal: sub(ACTIVE, 'workflows', RUN, 'journal.jsonl'),
    sync: sub(ACTIVE, 'agent-c3c3c3.jsonl'),
    idleAgent: sub(IDLE, 'agent-b1b1b1.jsonl'),
    // The main 11 + 1 and its launch line 10 + 20, the running agent 20 + 2, the sync agent
    // 40 + 4, the idle main 13 + 1 and its agent 17 + 1. The parent's report is no usage.
    billable: 12 + 30 + 22 + 44 + 14 + 18,
  }
  writeLines(w.activeMain, [
    claudeLine({ id: 'msg_act_1', ts: T, usage: { input: 11, output: 1 }, final: true }),
    agentToolUseLine({ id: 'msg_act_2', ts: T, toolUseId: 'toolu_sync01', subagentType: 'Explore' }),
    agentResultLine({ ts: T, toolUseId: 'toolu_sync01', agentId: 'c3c3c3', totals: { tokens: 44, durationMs: 1000, toolUses: 0 } }),
  ])
  writeLines(w.running, [claudeLine({ id: 'msg_a1_1', ts: T, agentId: 'a1a1a1', usage: { input: 20, output: 2 } })])
  fs.writeFileSync(sidecarOf(w.running), metaJson({ agentType: 'workflow-subagent', model: 'opus', toolUseId: null }))
  writeLines(w.journal, [journalLine({ type: 'started', agentId: 'a1a1a1' })])
  writeLines(w.sync, [claudeLine({ id: 'msg_c3_1', ts: T, agentId: 'c3c3c3', usage: { input: 40, output: 4 }, final: true })])
  fs.writeFileSync(sidecarOf(w.sync), metaJson({ agentType: 'Explore', model: 'haiku', toolUseId: 'toolu_sync01' }))
  writeLines(w.idleMain, [claudeLine({ id: 'msg_idle_1', ts: T - 2 * HOUR, usage: { input: 13, output: 1 }, final: true })])
  writeLines(w.idleAgent, [claudeLine({ id: 'msg_b1_1', ts: T - 2 * HOUR, agentId: 'b1b1b1', usage: { input: 17, output: 1 } })])
  return w
}

/**
 * Scans the fixture in this process and leaves the result where the extension keeps its state:
 * as this build writes it (7), or as a build before the agent tables did (6) — every line
 * counted, every cursor at its file's end, and no agent table at all.
 */
async function seedSnapshot(fx: Fixture, version: 6 | 7): Promise<Snapshot> {
  const { agg, scan, discover } = lazy()
  discover.configureRoots([fx.claudeDir], [fx.codexDir])
  const a = new agg.Aggregator()
  await scan.scan(a)
  const snap = JSON.parse(JSON.stringify(a.toSnapshot())) as Snapshot
  if (version === 6) {
    snap.version = 6
    delete snap.agents
    delete snap.launches
    delete snap.mains
    delete snap.journalResults
    delete snap.agentsReplayed
    for (const p of Object.values(snap.pending)) {
      delete p.agent
      delete p.main
    }
  }
  fs.mkdirSync(fx.storage, { recursive: true })
  fs.writeFileSync(fx.stateFile, JSON.stringify(snap))
  return snap
}

/** The stored state, or null while it cannot be read (not written yet, or being replaced). */
function readState(fx: Fixture): Snapshot | null {
  try {
    return JSON.parse(fs.readFileSync(fx.stateFile, 'utf8')) as Snapshot
  } catch {
    return null
  }
}

function offsetsOf(snap: Snapshot): Record<string, number> {
  return Object.fromEntries(Object.entries(snap.cursors).map(([file, cur]) => [file, cur.offset]))
}

function treeKeys(nodes: TreeNode[]): string[] {
  return nodes.flatMap((n) => [n.key, ...treeKeys(n.children)])
}

/**
 * Makes every recursive `fs.watch` throw, as on a platform without one: the extension falls
 * back to its periodic sweep — held by the test below — and has its agent poll, which is what
 * the test watches. Undone by the function it returns.
 */
function blindRecursiveWatchers(): () => void {
  // The module object itself: the namespace import above has getters only, and the bundle
  // reads `watch` from this object at every call.
  const nodeFs = require('fs') as { watch: unknown }
  const real = nodeFs.watch as (...args: unknown[]) => fs.FSWatcher
  nodeFs.watch = (...args: unknown[]): fs.FSWatcher => {
    const options = args[1]
    if (typeof options === 'object' && options !== null && (options as { recursive?: unknown }).recursive === true) {
      throw new Error('synthetic: no recursive watcher in this test')
    }
    return real.apply(nodeFs, args)
  }
  return () => { nodeFs.watch = real }
}

interface HeldInterval { fn: () => void; ms: number }

/**
 * Holds every `setInterval` made from here on instead of arming it, until `restore`: the test
 * fires the ones of one period itself and can count what is still armed. Timeouts stay real —
 * the ingest's debounce is one of them.
 */
function holdIntervals(): { fire(ms: number): number; armed(): number; restore(): void } {
  const g = globalThis as unknown as { setInterval: unknown; clearInterval: unknown }
  const realSet = g.setInterval
  const realClear = g.clearInterval as (handle: unknown) => void
  const held = new Set<HeldInterval>()
  g.setInterval = (fn: () => void, ms?: number): HeldInterval => {
    const h = { fn, ms: ms ?? 0 }
    held.add(h)
    return h
  }
  g.clearInterval = (handle: unknown): void => {
    if (!held.delete(handle as HeldInterval)) realClear(handle)
  }
  return {
    fire: (ms) => {
      const due = [...held].filter((h) => h.ms === ms)
      for (const h of due) h.fn()
      return due.length
    },
    armed: () => held.size,
    restore: () => {
      g.setInterval = realSet
      g.clearInterval = realClear
    },
  }
}

test('a poll pass lists the agent files of active sessions only and hands on the new and the changed ones', async () => {
  const { scan, agg, discover } = lazy()
  const home = tmpDir('tp-poll')
  const at = (...p: string[]): string => path.join(home, 'projects', '-tmp-poll', ...p)
  const now = Date.now()
  const line = (id: string, ts: number, agentId?: string): string => claudeLine({ id, ts, agentId, usage: { input: 1 } })
  const active = at('s-active.jsonl')
  const idle = at('s-idle.jsonl')
  // Its own transcript went quiet an hour ago, but one of its agents is still writing.
  const lively = at('s-lively.jsonl')
  const x1 = at('s-active', 'subagents', 'agent-e1.jsonl')
  const y1 = at('s-idle', 'subagents', 'agent-f1.jsonl')
  const z1 = at('s-lively', 'subagents', 'agent-d1.jsonl')
  writeLines(active, [line('m1', now - MINUTE)])
  writeLines(idle, [line('m2', now - HOUR)])
  writeLines(lively, [line('m3', now - HOUR)])
  writeLines(x1, [line('x1', now - MINUTE, 'e1')])
  writeLines(y1, [line('y1', now - HOUR, 'f1')])
  writeLines(z1, [line('z1', now - MINUTE, 'd1')])
  discover.configureRoots([home], [path.join(home, 'codex')])
  const a = new agg.Aggregator()
  await scan.scan(a)

  // By the records alone: the session's own last line, or one of its agents'.
  assert.deepEqual(scan.activeAgentSessions(a, now), [active, lively].sort())
  assert.deepEqual(await scan.agentPollFiles(a, now), { sessions: 2, listed: 2, changed: [] })

  // A line more, a workflow run in a directory made after the scan, a file touched without
  // growing — and a line in the idle session, which no pass lists.
  appendLine(x1, line('x2', now, 'e1'))
  const x2 = at('s-active', 'subagents', 'workflows', 'wf_1', 'agent-e2.jsonl')
  const journal = at('s-active', 'subagents', 'workflows', 'wf_1', 'journal.jsonl')
  writeLines(x2, [line('x3', now, 'e2')])
  writeLines(journal, [journalLine({ type: 'started', agentId: 'e2' })])
  const later = new Date(now + 5000)
  fs.utimesSync(z1, later, later)
  appendLine(y1, line('y2', now - HOUR, 'f1'))
  assert.deepEqual(await scan.agentPollFiles(a, now), { sessions: 2, listed: 4, changed: [x1, x2, journal, z1] })

  // The comparison itself: size or mtime against the cursor, no cursor is new, a file gone is
  // nothing to read.
  const gone = at('s-active', 'subagents', 'agent-e9.jsonl')
  a.cursors.set(gone, { offset: 1, size: 1, ino: 1, dev: 1, mtime: 1 })
  assert.deepEqual(await scan.changedSinceCursor([active, x1, gone, x2, z1], a.cursors), [x1, x2, z1])

  // A record that names a session outside every configured root is never listed.
  const snap = a.toSnapshot()
  const outside = path.join(tmpDir('tp-elsewhere'), 's-out.jsonl')
  snap.mains = { ...snap.mains, [outside]: { ...snap.mains![active], sessionId: 's-out' } }
  assert.deepEqual(scan.activeAgentSessions(agg.Aggregator.fromSnapshot(snap), now), [active, lively].sort())
})

test('the poll is wanted while an agent runs, or while a launch waits for its file in an active session', () => {
  const { ext } = lazy()
  const node = (over: Partial<TreeNode>): TreeNode => ({
    key: 'a:0', kind: 'agent', label: 'Agent', sub: null, state: 'done', derived: false, usage: '–',
    lowerBound: false, duration: '–', startTs: null, lastTs: null, children: [], ...over,
  })
  const tree = (roots: TreeNode[], running = 0): AgentTreeVm => ({ ...emptyAgentTree(T), roots, running })
  const waiting = node({ key: 'l:toolu_x', kind: 'pending', state: 'unknown', derived: true })

  assert.equal(ext.agentPollWanted(undefined), false)
  assert.equal(ext.agentPollWanted(tree([])), false)
  assert.equal(ext.agentPollWanted(tree([node({ kind: 'session', state: 'active', children: [node({})] })])), false,
    'a finished agent in an active session')
  // The count covers every root, the ones beyond the list too.
  assert.equal(ext.agentPollWanted(tree([], 1)), true)
  assert.equal(ext.agentPollWanted(tree([node({ kind: 'session', state: 'active', children: [node({ children: [waiting] })] })])),
    true, 'a launch deep in an active session')
  assert.equal(ext.agentPollWanted(tree([node({ kind: 'session', state: 'idle', children: [waiting] })])), false,
    'a launch in an idle session: no pass would list its directory')
})

test('the poll keeps one timer at most, never runs two passes at once, and outlives no failure', async () => {
  const { ext } = lazy()
  const made: Array<{ fn: () => void; ms: number; cleared: boolean }> = []
  const timers = {
    set: (fn: () => void, ms: number) => {
      const t = { fn, ms, cleared: false }
      made.push(t)
      return t
    },
    clear: (handle: unknown) => { (handle as { cleared: boolean }).cleared = true },
  }
  const settle = (): Promise<void> => new Promise((r) => setImmediate(r))
  let passes = 0
  let finish: () => void = () => undefined
  const poll = new ext.AgentPoll(() => {
    passes++
    return new Promise<void>((r) => { finish = r })
  }, ext.AGENT_POLL_MS, timers)

  assert.equal(poll.on, false)
  assert.equal(poll.set(true), true)
  assert.equal(poll.set(true), false, 'asked twice, it still keeps one timer')
  assert.deepEqual(made.map((t) => t.ms), [ext.AGENT_POLL_MS])
  made[0].fn()
  await settle()
  assert.equal(passes, 1)
  // The pass is still at work: the next tick waits for the one after.
  made[0].fn()
  await settle()
  assert.equal(passes, 1)
  finish()
  await settle()
  made[0].fn()
  await settle()
  assert.equal(passes, 2)
  finish()
  assert.equal(poll.set(false), true)
  assert.equal(made[0].cleared, true)
  assert.equal(poll.set(false), false)
  assert.equal(poll.on, false)

  // A pass that fails reports it itself; the timer ticks on and is not left waiting for it.
  let failures = 0
  const failing = new ext.AgentPoll(() => {
    failures++
    return Promise.reject(new Error('synthetic failure'))
  }, ext.AGENT_POLL_MS, timers)
  failing.set(true)
  const t = made[made.length - 1]
  t.fn()
  await settle()
  t.fn()
  await settle()
  assert.equal(failures, 2)
  failing.dispose()
  assert.equal(t.cleared, true)
})

test('while an agent runs, the poll hands the new and changed files of active sessions to the ingest, never an idle one, and stops when nothing runs', async () => {
  const { ext, agg } = lazy()
  const fx = makeFixture()
  const w = writeAgentWorld(fx)
  // A state that has been replayed already: the cold start reads every line itself, and
  // nothing waits for a replay.
  const replayed = new agg.Aggregator()
  replayed.agentsReplayed = true
  fs.mkdirSync(fx.storage, { recursive: true })
  fs.writeFileSync(fx.stateFile, JSON.stringify(replayed.toSnapshot()))
  const base = EXPECTED_BILLABLE + w.billable
  const intervals = holdIntervals()
  const seeAgain = blindRecursiveWatchers()
  try {
    await activateHost(fx, REPO)
    await waitFor('the cold scan', () => state.textOf(TOKENS_ITEM) === `Σ ${base} · 7d`)
    await waitFor('the poll to start', () => state.logText().includes('Agent poll: on'))
    assert.match(state.logText(), /No watcher on .*falling back to the periodic sweep/)

    // The running agent writes on and its run records the result; a second run starts in a
    // directory made after the cold start and finishes too. The idle session gets a line and
    // an agent of its own.
    const now = Date.now()
    const run2 = path.join(w.project, ACTIVE, 'subagents', 'workflows', RUN2)
    const second = path.join(run2, 'agent-a2a2a2.jsonl')
    appendLine(w.running, claudeLine({ id: 'msg_a1_2', ts: now, agentId: 'a1a1a1', usage: { input: 100, output: 5 }, final: true }))
    appendLine(w.journal, journalLine({ type: 'result', agentId: 'a1a1a1' }))
    writeLines(second, [claudeLine({ id: 'msg_a2_1', ts: now, agentId: 'a2a2a2', usage: { input: 200, output: 7 }, final: true })])
    writeLines(path.join(run2, 'journal.jsonl'), [
      journalLine({ type: 'started', agentId: 'a2a2a2' }), journalLine({ type: 'result', agentId: 'a2a2a2' }),
    ])
    appendLine(w.idleAgent, claudeLine({ id: 'msg_b1_2', ts: T - 2 * HOUR, agentId: 'b1b1b1', usage: { input: 1000 } }))
    const idleNew = path.join(w.project, IDLE, 'subagents', 'agent-b2b2b2.jsonl')
    writeLines(idleNew, [claudeLine({ id: 'msg_b2_1', ts: T - 2 * HOUR, agentId: 'b2b2b2', usage: { input: 3000 } })])

    // No watcher sees any of it, and the sweep is held: only a pass of the poll can.
    assert.ok(intervals.fire(ext.AGENT_POLL_MS) > 0, 'no interval of the poll\'s period is armed')
    await waitFor('the polled files to be counted', () => state.textOf(TOKENS_ITEM) === `Σ ${base + 105 + 207} · 7d`)
    // Two active sessions — this one and the fixture's own, which has no agent — with five files.
    assert.match(state.logText(), /Agent poll: 4 of 5 agent file\(s\) changed in 2 active session\(s\)/)
    // Both runs have their results, the sync agent had one before: nothing runs any more, and
    // the poll stopped with the first model that said so.
    await waitFor('the poll to stop', () => state.logText().includes('Agent poll: off'))

    assert.deepEqual(disposeAll(LIVE.pop()!), [])
    assert.equal(intervals.armed(), 0, 'an interval outlived the extension')
    // The state written on the way out: what the poll found was counted, the idle session was
    // never read again.
    const agents = readState(fx)?.agents ?? {}
    assert.equal(agents[second]?.outcome, 'completed')
    assert.equal(agents[w.running]?.outcome, 'completed')
    assert.equal(agents[w.idleAgent]?.input, 17)
    assert.equal(agents[idleNew], undefined)
  } finally {
    seeAgain()
    intervals.restore()
  }
})

test('the agent tables of an upgraded snapshot are replayed once after the cold start, not on the next start, and by a re-read', async () => {
  const fx = makeFixture()
  const w = writeAgentWorld(fx)
  const fixtureMain = path.join(w.project, '0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0.jsonl')
  // What a 1.4 build leaves behind: every line counted, every cursor at its file's end, no agent table.
  const v6 = await seedSnapshot(fx, 6)
  const claudeFiles = Object.keys(v6.cursors).filter((f) => f.startsWith(fx.claudeRoot + path.sep)).length
  assert.equal(claudeFiles, 7)

  await activateHost(fx, REPO)
  await waitFor('the replayed tables to be saved', () => readState(fx)?.agentsReplayed === true)
  assert.match(state.logText(),
    new RegExp(`Agent replay \\(cold start\\): ${claudeFiles} file\\(s\\) read again, \\d+ change\\(s\\), \\d+ ms`))
  const snap = readState(fx)
  assert.ok(snap)
  assert.equal(snap.version, STATE_VERSION)
  assert.deepEqual(Object.keys(snap.agents ?? {}).sort(), [w.running, w.sync, w.idleAgent].sort())
  assert.equal(snap.agents?.[w.sync]?.outcome, 'completed')
  assert.equal(snap.agents?.[w.sync]?.meta?.agentType, 'Explore')
  assert.equal(snap.agents?.[w.running]?.workflowId, RUN)
  assert.equal(snap.launches?.toolu_sync01?.agentId, 'c3c3c3')
  assert.deepEqual(Object.keys(snap.mains ?? {}).sort(), [fixtureMain, w.activeMain, w.idleMain].sort())
  // The counting is what it was: the replay moves no bucket and no cursor.
  assert.deepEqual(fingerprintOf(snap), fingerprintOf(v6))
  assert.deepEqual(offsetsOf(snap), offsetsOf(v6))

  // The page gets the tree keyed by identifiers alone: no path and no project name reach it.
  const page = openDashboard()
  const data = page.sent.find((m) => (m as { type?: unknown }).type === 'data') as
    { payload: { agents: AgentTreeVm } } | undefined
  assert.ok(data, 'the dashboard got no full payload')
  const keys = treeKeys(data.payload.agents.roots)
  for (const key of [`s:${ACTIVE}`, `w:${ACTIVE}|${RUN}`, 'a:a1a1a1', 'a:c3c3c3', `s:${IDLE}`, 'a:b1b1b1']) {
    assert.ok(keys.includes(key), `${key} is not among ${keys.join(', ')}`)
  }
  for (const key of keys) {
    assert.match(key, /^[swal]:[^\\/]+$/)
    assert.equal(key.includes('token-pace-synthetic'), false, key)
  }
  assert.deepEqual(disposeAll(LIVE.pop()!), [])

  // --- the next start finds the tables replayed ---------------------------------
  await activateHost(fx, REPO)
  await waitFor('the second cold start', () => state.logText().includes('Cold start done'))
  await sleep(300)
  assert.doesNotMatch(state.logText(), /Agent replay/)

  // --- "Re-read token history" replays over what it has just read ---------------
  await state.execute('tokenPace.rescan')
  assert.match(state.logText(), /Agent replay \(re-read\): \d+ file\(s\) read again/)
  const reread = readState(fx)
  assert.ok(reread)
  assert.equal(reread.agentsReplayed, true)
  assert.deepEqual(Object.keys(reread.agents ?? {}).sort(), [w.running, w.sync, w.idleAgent].sort())
  assert.deepEqual(fingerprintOf(reread), fingerprintOf(v6))
  assert.deepEqual(disposeAll(LIVE.pop()!), [])
})

test('a follower shows the agents of the leader\'s state and neither polls nor replays', async () => {
  const fx = makeFixture()
  writeAgentWorld(fx)
  // The leader's state as this build writes it, with a running agent — never replayed, which a
  // leader would do now and a follower must leave to the leader.
  const leader = await seedSnapshot(fx, 7)
  assert.equal(leader.agentsReplayed, false)
  const written = fs.readFileSync(fx.stateFile, 'utf8')
  fs.writeFileSync(fx.leaderFile, JSON.stringify({
    pid: process.pid, id: 'another-window-0123456789abcdef', expiresAt: Date.now() + 120_000,
  }))

  await activateHost(fx, REPO)
  await waitFor('the follower role', () => state.logText().includes('Role: single → follower'))
  await sleep(300)
  await state.execute('tokenPace.showUsageMarkdown')
  assert.match(lastMarkdown(), /\[~Running\] workflow-subagent · claude-opus-4-6 · a1a1/)
  assert.doesNotMatch(state.logText(), /Agent poll: on/)
  assert.doesNotMatch(state.logText(), /Agent replay/)

  assert.deepEqual(disposeAll(LIVE.pop()!), [])
  assert.equal(fs.readFileSync(fx.stateFile, 'utf8'), written, 'a follower wrote the shared state')
})
