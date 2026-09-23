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
  agentResultLine, agentToolUseLine, apiErrorLine, claudeLine, codexMeta, codexTaskStarted, codexTokenCount, codexTurnContext, iso,
  journalKey, journalLine, metaJson, queueOperationLine, snakeRateLimits, tmpDir, workflowResultLine, workflowToolUseLine,
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
  assert.equal(snap.version, 8)
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

test('stored opened agent nodes and the selection restore by shape; over-long keys are dropped', async () => {
  // The two agent tree fields are opaque node keys: only their shape is checked on restore —
  // strings of at most 200 chars, at most 200 opened nodes, a selection that is such a string
  // or null. The caps are read where `activateHost` reads everything else: after the stub.
  const { MAX_AGENT_EXPANDED, MAX_AGENT_KEY_CHARS } = require('../src/viewModel') as typeof import('../src/viewModel')
  assert.deepEqual([MAX_AGENT_EXPANDED, MAX_AGENT_KEY_CHARS], [200, 200])
  const long = 'k'.repeat(201)
  const opened = ['s:s1', long, 7, '', 's:s1', null, ...Array.from({ length: 250 }, (_, i) => `a:${i}`)]
  const kept = new Map<string, unknown>([
    // 1.5.0 kept folds instead; it was never published, and a fold is not an opened node.
    ['tokenPace.ui', { range: '30d', agentsExpanded: opened, agentsFolded: ['w:s1|wf_1'], agentSelected: 'l:toolu_01' }],
  ])
  const host = await activateHost(makeFixture(), REPO, { globalState: kept })
  await state.execute('tokenPace.setRange', '7d')
  const ui = host.ctx.globalState.get<Record<string, unknown>>('tokenPace.ui')
  const restored = ui?.agentsExpanded as string[]
  assert.ok(Array.isArray(restored), 'agentsExpanded was not written back')
  assert.equal(restored.length, MAX_AGENT_EXPANDED)
  assert.equal(restored.includes(long), false)
  assert.ok(restored.every((k) => typeof k === 'string' && k.length > 0 && k.length <= MAX_AGENT_KEY_CHARS))
  assert.equal(new Set(restored).size, restored.length)
  // The cut keeps the newest ones — the list is in the order they were opened, as an open at
  // the cap keeps it — in their order; the oldest give way, the first key among them.
  assert.deepEqual(restored.slice(0, 2), ['a:50', 'a:51'])
  assert.equal(restored[restored.length - 1], 'a:249')
  assert.equal(restored.includes('s:s1'), false)
  assert.equal(restored.includes('w:s1|wf_1'), false, 'a 1.5.0 fold became an opened node')
  assert.equal('agentsFolded' in (ui as Record<string, unknown>), false, 'the 1.5.0 folds were carried along')
  assert.equal(ui?.agentSelected, 'l:toolu_01')
  assert.deepEqual(disposeAll(LIVE.pop()!), [])

  // Folds alone — what a 1.5.0 window stored — open nothing: the tree starts collapsed.
  const folds = new Map<string, unknown>([['tokenPace.ui', { agentsFolded: ['s:s1', 'w:s1|wf_1'] }]])
  const third = await activateHost(makeFixture(), REPO, { globalState: folds })
  await state.execute('tokenPace.setRange', '7d')
  const fromFolds = third.ctx.globalState.get<Record<string, unknown>>('tokenPace.ui')
  assert.deepEqual(fromFolds?.agentsExpanded, [])
  assert.equal('agentsFolded' in (fromFolds as Record<string, unknown>), false)
  assert.deepEqual(disposeAll(LIVE.pop()!), [])

  const junk = new Map<string, unknown>([
    ['tokenPace.ui', { agentsExpanded: 'not-a-list', agentSelected: long }],
  ])
  const second = await activateHost(makeFixture(), REPO, { globalState: junk })
  await state.execute('tokenPace.setRange', '7d')
  const back = second.ctx.globalState.get<Record<string, unknown>>('tokenPace.ui')
  assert.deepEqual(back?.agentsExpanded, [])
  assert.equal(back?.agentSelected, null)
  assert.deepEqual(disposeAll(LIVE.pop()!), [])
})

test('stored "more" steps restore by shape — a key, a whole number of steps from 1 to 10 — and a step is stored and pushed', async () => {
  // 1.6 D3: `ui.agentsMore` is the view state's too. Entry by entry: a key of the opened nodes'
  // shape and a whole number of steps within MAX_MORE_PAGES; anything else dropped, a key stored
  // twice keeps its last entry, and a list over the cap its newest.
  const { MAX_AGENT_MORE, MAX_MORE_PAGES } = require('../src/agentTree') as typeof import('../src/agentTree')
  assert.deepEqual([MAX_AGENT_MORE, MAX_MORE_PAGES], [200, 10])
  const long = 'k'.repeat(201)
  const more = [
    { key: 'w:s1|wf_1', pages: 2 }, { key: long, pages: 1 }, { key: '', pages: 1 }, { key: 7, pages: 1 },
    { key: 'w:s1|wf_2', pages: 0 }, { key: 'w:s1|wf_3', pages: 11 }, { key: 'w:s1|wf_4', pages: 1.5 },
    { key: 'w:s1|wf_5', pages: '2' }, null, 'w:s1|wf_6', { key: 'w:s1|wf_1', pages: 3 },
    ...Array.from({ length: 250 }, (_, i) => ({ key: `a:${i}`, pages: 1 })),
  ]
  const kept = new Map<string, unknown>([['tokenPace.ui', { agentsExpanded: ['w:s1|wf_1'], agentsMore: more }]])
  const host = await activateHost(makeFixture(), REPO, { globalState: kept })
  await waitFor('the cold start', () => state.logText().includes('Cold start done'))
  await state.execute('tokenPace.setRange', '7d')
  const ui = host.ctx.globalState.get<Record<string, unknown>>('tokenPace.ui')
  const restored = ui?.agentsMore as Array<{ key: string; pages: number }>
  assert.ok(Array.isArray(restored), 'agentsMore was not written back')
  assert.equal(restored.length, MAX_AGENT_MORE)
  assert.ok(restored.every((e) => typeof e.key === 'string' && e.key.length > 0 && e.key.length <= 200
    && Number.isInteger(e.pages) && e.pages >= 1 && e.pages <= MAX_MORE_PAGES), JSON.stringify(restored.slice(0, 3)))
  assert.equal(new Set(restored.map((e) => e.key)).size, restored.length)
  assert.equal(restored[restored.length - 1].key, 'a:249')
  // The node's last entry wins, and the cut keeps the newest: it was the oldest left.
  assert.equal(restored.some((e) => e.key === 'w:s1|wf_1'), false)
  for (const bad of [long, 'w:s1|wf_2', 'w:s1|wf_3', 'w:s1|wf_4', 'w:s1|wf_5', 'w:s1|wf_6']) {
    assert.equal(restored.some((e) => e.key === bad), false, bad)
  }
  // A step from the page is stored and the section pushed at once, carrying it.
  const page = openDashboard()
  await waitFor('the first payload', () => page.sent.some((m) => (m as { type?: unknown }).type === 'data'))
  const before = page.sent.length
  page.post({ type: 'agentMore', key: 'w:s1|wf_1' })
  const after = host.ctx.globalState.get<Record<string, unknown>>('tokenPace.ui')?.agentsMore as Array<{ key: string; pages: number }>
  assert.deepEqual(after[after.length - 1], { key: 'w:s1|wf_1', pages: 1 })
  const pushes = page.sent.slice(before).filter((m) => {
    const x = m as { type?: unknown; key?: unknown }
    return x.type === 'section' && x.key === 'agents'
  }) as Array<{ payload: { ui: { agentsMore: Array<{ key: string; pages: number }> } } }>
  assert.equal(pushes.length, 1, 'the agents section was not pushed')
  assert.deepEqual(pushes[0].payload.ui.agentsMore[pushes[0].payload.ui.agentsMore.length - 1], { key: 'w:s1|wf_1', pages: 1 })
  // Junk in place of the list is no list.
  assert.deepEqual(disposeAll(LIVE.pop()!), [])
  const junk = new Map<string, unknown>([['tokenPace.ui', { agentsMore: 'not-a-list' }]])
  const second = await activateHost(makeFixture(), REPO, { globalState: junk })
  // Its cold start done before it goes: one still running past the dispose writes its log line
  // into the next test's recording.
  await waitFor('the second cold start', () => state.logText().includes('Cold start done'))
  await state.execute('tokenPace.setRange', '7d')
  assert.deepEqual(second.ctx.globalState.get<Record<string, unknown>>('tokenPace.ui')?.agentsMore, [])
  assert.deepEqual(disposeAll(LIVE.pop()!), [])
})

// 1.6 P10a (L3) changed two lines of P3b's: a stored `week` — the 7-day block's row — is a place of
// the list now, kept beside a selection, and a selection the page posts from it is stored; a place
// the host does not know is still dropped whole (`Week` below).
test('the row the details open under restores by shape, beside a selection only, and a selection from the list is stored and pushed', async () => {
  // 1.6 N2: `ui.agentSelectedIn` is a place of the list — the tree's, the running list's or (L3)
  // the 7-day block's — and means something only while a node is selected; anything else comes
  // back as the tree.
  const cases: Array<[Record<string, unknown>, string]> = [
    [{ agentSelected: 'a:a94f0001', agentSelectedIn: 'now' }, 'now'],
    [{ agentSelected: 'a:a94f0001', agentSelectedIn: 'tree' }, 'tree'],
    [{ agentSelected: 'a:a94f0001', agentSelectedIn: 'week' }, 'week'],
    [{ agentSelected: 'a:a94f0001', agentSelectedIn: 'Week' }, 'tree'],
    [{ agentSelected: 'a:a94f0001', agentSelectedIn: ['now'] }, 'tree'],
    [{ agentSelected: 'a:a94f0001' }, 'tree'],
    [{ agentSelected: null, agentSelectedIn: 'now' }, 'tree'],
  ]
  for (const [stored, want] of cases) {
    const kept = new Map<string, unknown>([['tokenPace.ui', stored]])
    const host = await activateHost(makeFixture(), REPO, { globalState: kept })
    await waitFor('the cold start', () => state.logText().includes('Cold start done'))
    await state.execute('tokenPace.setRange', '7d')
    const ui = host.ctx.globalState.get<Record<string, unknown>>('tokenPace.ui')
    assert.equal(ui?.agentSelectedIn, want, JSON.stringify(stored))
    assert.equal(ui?.agentSelected, stored.agentSelected ?? null, JSON.stringify(stored))
    assert.deepEqual(disposeAll(LIVE.pop()!), [])
  }
  // What the page posts from a row of the running list is stored with its place, and the section
  // is pushed at once, carrying it; a selection from the same node's tree row moves it back.
  const host = await activateHost(makeFixture(), REPO)
  await waitFor('the cold start', () => state.logText().includes('Cold start done'))
  const page = openDashboard()
  await waitFor('the first payload', () => page.sent.some((m) => (m as { type?: unknown }).type === 'data'))
  const pushesSince = (from: number): Array<{ payload: { ui: { agentSelected: unknown; agentSelectedIn: unknown } } }> =>
    page.sent.slice(from).filter((m) => {
      const x = m as { type?: unknown; key?: unknown }
      return x.type === 'section' && x.key === 'agents'
    }) as Array<{ payload: { ui: { agentSelected: unknown; agentSelectedIn: unknown } } }>
  let before = page.sent.length
  page.post({ type: 'agentSelect', key: 'a:a94f0001', from: 'now' })
  let ui = host.ctx.globalState.get<Record<string, unknown>>('tokenPace.ui')
  assert.deepEqual([ui?.agentSelected, ui?.agentSelectedIn], ['a:a94f0001', 'now'])
  let pushes = pushesSince(before)
  assert.equal(pushes.length, 1, 'the agents section was not pushed')
  assert.deepEqual([pushes[0].payload.ui.agentSelected, pushes[0].payload.ui.agentSelectedIn], ['a:a94f0001', 'now'])
  before = page.sent.length
  page.post({ type: 'agentSelect', key: 'a:a94f0001', from: 'tree' })
  ui = host.ctx.globalState.get<Record<string, unknown>>('tokenPace.ui')
  assert.deepEqual([ui?.agentSelected, ui?.agentSelectedIn], ['a:a94f0001', 'tree'])
  pushes = pushesSince(before)
  assert.equal(pushes.length, 1, 'moving the details did not push the section')
  assert.equal(pushes[0].payload.ui.agentSelectedIn, 'tree')
  // 1.6 L3: from a row of the 7-day block — stored with its place, and pushed.
  before = page.sent.length
  page.post({ type: 'agentSelect', key: 'a:a94f0001', from: 'week' })
  ui = host.ctx.globalState.get<Record<string, unknown>>('tokenPace.ui')
  assert.deepEqual([ui?.agentSelected, ui?.agentSelectedIn], ['a:a94f0001', 'week'])
  assert.equal(pushesSince(before).length, 1, 'a selection from the 7-day block did not push the section')
  // A place the host does not know drops the message whole: nothing stored, nothing pushed.
  before = page.sent.length
  page.post({ type: 'agentSelect', key: 'a:a94f0002', from: 'Week' })
  ui = host.ctx.globalState.get<Record<string, unknown>>('tokenPace.ui')
  assert.deepEqual([ui?.agentSelected, ui?.agentSelectedIn], ['a:a94f0001', 'week'])
  assert.equal(pushesSince(before).length, 0)
  assert.deepEqual(disposeAll(LIVE.pop()!), [])
})

test('the 7-day block\'s disclosure is stored and pushed at once; a stored state restores by shape (1.6 L3)', async () => {
  // Restored as a boolean, and only as one: anything else is the default, closed.
  const cases: Array<[unknown, boolean]> = [[true, true], [false, false], ['true', false], [1, false], [null, false], [undefined, false]]
  for (const [stored, want] of cases) {
    const kept = new Map<string, unknown>([['tokenPace.ui', { agentsWeekOpen: stored }]])
    const host = await activateHost(makeFixture(), REPO, { globalState: kept })
    await waitFor('the cold start', () => state.logText().includes('Cold start done'))
    await state.execute('tokenPace.setRange', '7d')
    assert.equal(host.ctx.globalState.get<Record<string, unknown>>('tokenPace.ui')?.agentsWeekOpen, want, JSON.stringify(stored))
    assert.deepEqual(disposeAll(LIVE.pop()!), [])
  }
  // The page's disclosure: stored, and the section pushed at once with the block in it; again, closed.
  const host = await activateHost(makeFixture(), REPO)
  await waitFor('the cold start', () => state.logText().includes('Cold start done'))
  const page = openDashboard()
  await waitFor('the first payload', () => page.sent.some((m) => (m as { type?: unknown }).type === 'data'))
  const agentPushes = (from: number): Array<{ payload: { ui: { agentsWeekOpen: unknown }; agents: { week: unknown } } }> =>
    page.sent.slice(from).filter((m) => {
      const x = m as { type?: unknown; key?: unknown }
      return x.type === 'section' && x.key === 'agents'
    }) as Array<{ payload: { ui: { agentsWeekOpen: unknown }; agents: { week: unknown } } }>
  let before = page.sent.length
  page.post({ type: 'agentsWeek' })
  assert.equal(host.ctx.globalState.get<Record<string, unknown>>('tokenPace.ui')?.agentsWeekOpen, true)
  let pushes = agentPushes(before)
  assert.equal(pushes.length, 1, 'opening the block did not push the section')
  assert.equal(pushes[0].payload.ui.agentsWeekOpen, true)
  assert.ok(pushes[0].payload.agents.week && typeof pushes[0].payload.agents.week === 'object', 'the push carries no block')
  before = page.sent.length
  page.post({ type: 'agentsWeek' })
  assert.equal(host.ctx.globalState.get<Record<string, unknown>>('tokenPace.ui')?.agentsWeekOpen, false)
  pushes = agentPushes(before)
  assert.equal(pushes.length, 1, 'closing the block did not push the section')
  assert.deepEqual([pushes[0].payload.ui.agentsWeekOpen, pushes[0].payload.agents.week], [false, null])
  assert.deepEqual(disposeAll(LIVE.pop()!), [])
})

test('a reader with 200 stored opened nodes, all long gone, can still open one: the oldest gives way', async () => {
  // Nothing prunes the key of a node that has left the tree — a session past the list, an agent
  // past the seven days — so a regular reader reaches the cap with keys that match nothing. The
  // click on a node of today must still open it, be stored and reach the page.
  const { MAX_AGENT_EXPANDED } = require('../src/viewModel') as typeof import('../src/viewModel')
  const stale = Array.from({ length: MAX_AGENT_EXPANDED }, (_, i) => `s:gone-${i}`)
  const kept = new Map<string, unknown>([['tokenPace.ui', { agentsExpanded: stale }]])
  const host = await activateHost(makeFixture(), REPO, { globalState: kept })
  await waitFor('the cold start', () => state.logText().includes('Cold start done'))
  const page = openDashboard()
  await waitFor('the first payload', () => page.sent.some((m) => (m as { type?: unknown }).type === 'data'))
  const before = page.sent.length
  page.post({ type: 'agentToggle', key: 's:todays-session' })
  const ui = host.ctx.globalState.get<Record<string, unknown>>('tokenPace.ui')
  const stored = ui?.agentsExpanded as string[]
  assert.ok(Array.isArray(stored), 'agentsExpanded was not written back')
  assert.equal(stored.length, MAX_AGENT_EXPANDED)
  assert.equal(stored[stored.length - 1], 's:todays-session', 'the click opened nothing')
  assert.equal(stored.includes('s:gone-0'), false, 'the oldest key was kept')
  assert.deepEqual(stored.slice(0, 2), ['s:gone-1', 's:gone-2'])
  // The section is pushed at once, carrying the opened node.
  const pushes = page.sent.slice(before).filter((m) => {
    const x = m as { type?: unknown; key?: unknown }
    return x.type === 'section' && x.key === 'agents'
  }) as Array<{ payload: { ui: { agentsExpanded: string[] } } }>
  assert.equal(pushes.length, 1, 'the agents section was not pushed')
  assert.equal(pushes[0].payload.ui.agentsExpanded.includes('s:todays-session'), true)
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
  // position: `state.live()` records items in creation order, the API in bar order. Each id
  // once, too — the two tests before this one dispose their activations while the cold scan
  // still runs, and a disposed activation draws no frame into this recording.
  const items = host.api.statusBar()
  assert.deepEqual(items.map((i) => i.id).sort(), state.live().map((i) => i.id).sort())
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
 * as this build writes it (8), or as a build before the agent tables did (6) — every line
 * counted, every cursor at its file's end, and no agent table at all. 1.6 P2b: this build writes
 * version 8 (it was 7), and a version 6 has no runs and no revision to delete (it had no
 * `journalResults`/`agentsReplayed` either).
 */
async function seedSnapshot(fx: Fixture, version: 6 | 8): Promise<Snapshot> {
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
    delete snap.runs
    delete snap.agentsRevision
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

test('an agent that writes nothing but rejected requests keeps its session in the poll while they keep coming (1.6 P5b #5)', async () => {
  // A transcript of nothing but requests the API rejected has its record from its first one
  // (D4), and a later rejection moves only the record's rejection, not its last reply: the check
  // read the last reply alone, so a session whose one agent kept being rejected dropped out of the
  // poll ten minutes after the first rejection, while the agent was still being written.
  const { scan, agg, discover } = lazy()
  const home = tmpDir('tp-poll-rejected')
  const at = (...p: string[]): string => path.join(home, 'projects', '-tmp-poll', ...p)
  const now = Date.now()
  const main = at('s-rejected.jsonl')
  const agent = at('s-rejected', 'subagents', 'agent-ab12.jsonl')
  writeLines(main, [claudeLine({ id: 'm1', ts: now - HOUR, usage: { input: 1 } })])
  writeLines(agent, [apiErrorLine({ id: 'r1', ts: now - HOUR, agentId: 'ab12' })])
  discover.configureRoots([home], [path.join(home, 'codex')])
  const a = new agg.Aggregator()
  await scan.scan(a)
  assert.deepEqual(scan.activeAgentSessions(a, now), [], 'one rejection an hour ago is no activity now')

  appendLine(agent, apiErrorLine({ id: 'r2', ts: now - MINUTE, agentId: 'ab12' }))
  await scan.scan(a, { files: [agent] })
  const rec = a.agents().find((r) => r.agentId === 'ab12')
  assert.ok(rec)
  assert.equal(rec.requests, 0)
  assert.equal(rec.lastTs, now - HOUR, 'a rejection moved the last reply')
  assert.equal(rec.rejected?.at, now - MINUTE)
  assert.deepEqual(scan.activeAgentSessions(a, now), [main])
  // And ten minutes after the latest one the session is idle again.
  assert.deepEqual(scan.activeAgentSessions(a, now - MINUTE + 11 * MINUTE), [])
})

test('the poll is wanted while an agent runs or a session is active, and never for an idle one', () => {
  // 1.6 D8: an active session may start a workflow run at any moment, and a `Workflow` call
  // leaves no launch the tree could wait on — so an active session is enough, whatever is below
  // it. Until 1.5.1 a finished agent in an active session stopped the poll, and the first file of
  // a run started next was left to a watcher that can miss it.
  const { ext } = lazy()
  const node = (over: Partial<TreeNode>): TreeNode => ({
    key: 'a:0', kind: 'agent', label: 'Agent', fullLabel: 'Agent', startClock: null, lastClock: null, sub: null, state: 'done', derived: false, usage: '–', usageAgents: null,
    lowerBound: false, lowerBoundText: null, duration: '–', startTs: null, lastTs: null, silence: false, agentCount: 0, hasChildren: false, childrenTotal: 0,
    childrenMore: 0, tally: null, tallyText: null, tallySpoken: null, superseded: false, children: [], ...over,
  })
  const tree = (roots: TreeNode[], running = 0): AgentTreeVm => ({ ...emptyAgentTree(), roots, running })
  const waiting = node({ key: 'l:toolu_x', kind: 'pending', state: 'unknown', derived: true })

  assert.equal(ext.agentPollWanted(undefined), false)
  assert.equal(ext.agentPollWanted(tree([])), false)
  assert.equal(ext.agentPollWanted(tree([node({ kind: 'session', state: 'active', children: [node({})] })])), true,
    'a finished agent in an active session: the session may start the next one')
  assert.equal(ext.agentPollWanted(tree([node({ kind: 'session', state: 'active' })])), true,
    'an active session without agents')
  // The count covers every root, the ones beyond the list too.
  assert.equal(ext.agentPollWanted(tree([], 1)), true)
  assert.equal(ext.agentPollWanted(tree([node({ kind: 'session', state: 'active', children: [node({ children: [waiting] })] })])),
    true, 'a launch deep in an active session')
  assert.equal(ext.agentPollWanted(tree([node({ kind: 'session', state: 'idle', children: [waiting] })])), false,
    'a launch in an idle session: no pass would list its directory')
  assert.equal(ext.agentPollWanted(tree([node({ kind: 'session', state: 'idle', children: [node({})] }),
    node({ key: 's:2', kind: 'session', state: 'unknown' })])), false, 'every session idle and nothing running')
  // Only a session's own state counts: the decision reads the roots, never a node's children,
  // which the page need not carry.
  assert.equal(ext.agentPollWanted(tree([node({ kind: 'session', state: 'idle', children: [node({ kind: 'session', state: 'active' })] })])),
    false, 'an active state below the roots')
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

// ---------------------------------------------------------------------------
// The live cost (1.6 L5)
// ---------------------------------------------------------------------------

/** A LiveCadence with spies for its two rebuilds. */
function cadenceWithSpies(minMs?: number): {
  cadence: InstanceType<ReturnType<typeof lazy>['ext']['LiveCadence']>
  full: number[]
  agents: number[]
  failNext: { value: boolean }
} {
  const { ext } = lazy()
  const full: number[] = []
  const agents: number[] = []
  const failNext = { value: false }
  const cadence = new ext.LiveCadence({
    full: (now) => {
      if (failNext.value) { failNext.value = false; return false }
      full.push(now)
      return true
    },
    agents: (now) => { agents.push(now) },
  }, minMs)
  return { cadence, full, agents, failNext }
}

test('a change of the agent tables alone rebuilds the Agents section alone, never the whole view model (1.6 L5)', () => {
  const { ext } = lazy()
  assert.equal(ext.VM_MIN_INTERVAL_MS, 5000)
  const { cadence, full, agents } = cadenceWithSpies()
  // No whole model yet: an ingest builds it — there is nothing an Agents section could go onto.
  assert.equal(cadence.ingested({ buckets: false, agents: true }, 1_000), 'full')
  assert.deepEqual(full, [1_000])
  // A journal line, a parent's result, a sidecar a moment later: the section alone, again and again.
  for (const at of [1_400, 1_800, 7_000, 60_000]) assert.equal(cadence.ingested({ buckets: false, agents: true }, at), 'agents')
  assert.deepEqual(full, [1_000], 'buildViewModel ran for a change of the agent tables')
  assert.deepEqual(agents, [1_400, 1_800, 7_000, 60_000])
  assert.equal(cadence.stale, false)
  // Nothing changed at all: nothing is rebuilt.
  assert.equal(cadence.ingested({ buckets: false, agents: false }, 61_000), 'none')
  assert.deepEqual(agents.length, 4)
  // An event is whole, always; so is a tick once the interval has passed — as before 1.6.
  cadence.event(61_500)
  cadence.tick(62_000)
  cadence.tick(66_499)
  cadence.tick(66_500)
  assert.deepEqual(full, [1_000, 61_500, 66_500])
})

test('a burst of bucket lines over 12 s makes at most three whole rebuilds, and every change reaches one within the interval (1.6 L5)', () => {
  const { cadence, full, agents } = cadenceWithSpies()
  cadence.event(0)
  // An ingest every 400 ms (the debounce) with tokens of a running agent, and the one-second tick.
  let pendingSince: number | null = null
  let longestWait = 0
  const plans: string[] = []
  for (let at = 100; at <= 12_000; at += 100) {
    const before = full.length
    if (at % 400 === 0) {
      plans.push(cadence.ingested({ buckets: true, agents: true }, at))
      if (full.length === before && pendingSince === null) pendingSince = at
    }
    if (at % 1000 === 0) cadence.tick(at)
    if (full.length > before && pendingSince !== null) {
      longestWait = Math.max(longestWait, at - pendingSince)
      pendingSince = null
    }
  }
  const whole = full.filter((at) => at > 0)
  assert.ok(whole.length <= 3, `${whole.length} whole rebuilds: ${whole.join(', ')}`)
  assert.ok(whole.length >= 2, 'the deferred bucket changes never reached a whole rebuild')
  // 1.5 rebuilt the whole model on every ingest: thirty of them here. Now each is either the
  // whole model (when the interval has passed) or the Agents section alone — the tree stays live.
  assert.equal(plans.length, 30)
  assert.ok(plans.every((p) => p === 'full' || p === 'agents'), plans.join(', '))
  assert.equal(agents.length, plans.filter((p) => p === 'agents').length)
  assert.ok(longestWait <= 5000, `a bucket change waited ${longestWait} ms`)
  // The last change is still waiting, and the next tick past the interval takes it.
  assert.equal(cadence.stale, true)
  cadence.tick(full[full.length - 1] + 5000)
  assert.equal(cadence.stale, false)
})

test('a whole rebuild that failed leaves the bucket change stale and is tried again at the next tick (1.6 L5)', () => {
  const { cadence, full, failNext } = cadenceWithSpies()
  cadence.event(0)
  cadence.ingested({ buckets: true, agents: false }, 1_000)
  assert.equal(cadence.stale, true)
  failNext.value = true
  cadence.tick(5_000)
  assert.equal(cadence.stale, true, 'a failed build took the change with it')
  cadence.tick(6_000)
  assert.deepEqual(full, [0, 6_000])
  assert.equal(cadence.stale, false)
  // A clock that went back is no interval: the next frame is whole.
  cadence.ingested({ buckets: true, agents: false }, 3_000)
  assert.deepEqual(full, [0, 6_000, 3_000])
})

test('the timed save runs every 10 s while the agent poll is on and every 5 s while it is off (1.6 L5)', () => {
  const { ext } = lazy()
  assert.equal(ext.SAVE_MS, 5000)
  assert.equal(ext.AGENT_SAVE_MS, 10_000)
  const saves = (pollOn: boolean): number[] => {
    const out: number[] = []
    let last: number | null = null
    // The save timer's ticks, a few milliseconds early or late each.
    for (let i = 1; i <= 12; i++) {
      const at = i * ext.SAVE_MS + (i % 2 === 0 ? 7 : -7)
      if (ext.timedSaveDue(at, last, pollOn)) { out.push(at); last = at }
    }
    return out
  }
  const on = saves(true)
  assert.equal(on.length, 6)
  for (let i = 1; i < on.length; i++) assert.ok(Math.abs(on[i] - on[i - 1] - 10_000) <= 20, on.join(', '))
  assert.equal(saves(false).length, 12)
  // The first tick always saves, and a clock that went back is no reason to wait.
  assert.equal(ext.timedSaveDue(1_000, null, true), true)
  assert.equal(ext.timedSaveDue(1_000, 50_000, true), true)
})

test('a journal line pushes the Agents section and the status bar entry alone; a whole rebuild would have pushed more (1.6 L5, O1)', async () => {
  const fx = makeFixture()
  const w = writeAgentWorld(fx)
  const RUN3 = 'wf_e0e0e0e0-5555-4555'
  const intervals = holdIntervals()
  const seeAgain = blindRecursiveWatchers()
  try {
    await activateHost(fx, REPO, { settings: { 'tokenPace.statusBar.show': ['claudeQuota', 'agents', 'tokens'] } })
    const { agg } = lazy()
    await waitFor('the whole tables to be saved', () => readState(fx)?.agentsRevision === agg.AGENT_TABLES_REVISION)
    // O1: the running workflow agent, on the bar.
    await waitFor('the agents entry', () => state.textOf('tokenPace.agents') === '~1 running')
    const page = openDashboard()
    await waitFor('the first payload', () => page.sent.some((m) => (m as { type?: unknown }).type === 'data'))
    // The session opened, so its runs are on the page.
    page.post({ type: 'agentToggle', key: `s:${ACTIVE}` })
    await sleep(500)
    const mark = page.sent.length

    // A new run's journal — its first line, an agent started and no transcript of it yet: the
    // agent tables change, no bucket does. A new file too, which a whole rebuild would count.
    writeLines(path.join(w.project, ACTIVE, 'subagents', 'workflows', RUN3, 'journal.jsonl'),
      [journalLine({ type: 'started', agentId: 'a3a3a3' })])
    assert.ok(intervals.fire(60_000) > 0, 'no sweep interval is armed')
    const runKey = `w:${ACTIVE}|${RUN3}`
    const pushedAfter = (from: number): Array<{ type?: unknown; key?: unknown; payload?: { agents?: AgentTreeVm } }> =>
      page.sent.slice(from) as Array<{ type?: unknown; key?: unknown; payload?: { agents?: AgentTreeVm } }>
    await waitFor('the new run on the page', () => pushedAfter(mark).some((m) =>
      m.type === 'section' && m.key === 'agents' && treeKeys(m.payload?.agents?.roots ?? []).includes(runKey)))
    await sleep(300)
    assert.deepEqual(pushedAfter(mark).map((m) => `${String(m.type)} ${String(m.key)}`), pushedAfter(mark).map(() => 'section agents'),
      'a change of the agent tables alone pushed more than the Agents section')
    // The entry followed the tree without a tick of its own: the run's journal-only agent runs too.
    assert.equal(state.textOf('tokenPace.agents'), '~2 running')

    // What the whole view model would have said: one file more on the data-quality line.
    const mark2 = page.sent.length
    page.post({ type: 'refresh' })
    await waitFor('the data-quality section', () => pushedAfter(mark2).some((m) => m.type === 'section' && m.key === 'dataQuality'))
    assert.deepEqual(disposeAll(LIVE.pop()!), [])
  } finally {
    seeAgain()
    intervals.restore()
  }
})

test('while the agent poll is on the state is saved every 10 s, while it is off every 5 s, and the exit save writes what is left (1.6 L5)', async () => {
  const promises = (require('fs') as typeof fs).promises as unknown as {
    writeFile: (...args: unknown[]) => Promise<void>
    rename: (...args: unknown[]) => Promise<void>
  }
  const nodeFs = require('fs') as { writeFileSync: (...args: unknown[]) => void }
  const realWrite = promises.writeFile
  const realRename = promises.rename
  const realWriteSync = nodeFs.writeFileSync
  const renamed: string[] = []
  const realNow = Date.now
  let offset = 0
  const writes: string[] = []
  const ROLLUP_MS = 6 * 60 * 60_000
  const run = async (fx: Fixture, pollOn: boolean): Promise<{ timed: number[]; exit: number }> => {
    const tmp = `${fx.stateFile}.tmp`
    const exitTmp = `${fx.stateFile}.exit.tmp`
    writes.length = 0
    renamed.length = 0
    // A save has ended once its temp file was renamed into place: the write is under way before
    // the temp file exists, so its absence says nothing.
    const saved = (): number => writes.filter((f) => f === tmp).length
    const ended = (): boolean => renamed.filter((f) => f === tmp).length === saved()
    const intervals = holdIntervals()
    try {
      await activateHost(fx, REPO)
      await waitFor('the cold start\'s save', () => saved() > 0 && ended())
      if (pollOn) await waitFor('the poll to start', () => state.logText().includes('Agent poll: on'))
      else {
        await sleep(300)
        assert.doesNotMatch(state.logText(), /Agent poll: on/)
      }
      const timed: number[] = []
      for (let tick = 1; tick <= 4; tick++) {
        offset += 5000
        // The roll-up leaves the state to be saved, as an ingest would.
        assert.ok(intervals.fire(ROLLUP_MS) > 0)
        const before = saved()
        assert.ok(intervals.fire(5000) > 0, 'no save interval is armed')
        await waitFor('the save to end', ended)
        if (saved() > before) timed.push(tick)
      }
      // One more change nothing saves before the window goes: the exit save writes it.
      intervals.fire(ROLLUP_MS)
      assert.deepEqual(disposeAll(LIVE.pop()!), [])
      return { timed, exit: writes.filter((f) => f === exitTmp).length }
    } finally {
      intervals.restore()
    }
  }
  promises.writeFile = (...args: unknown[]): Promise<void> => {
    writes.push(String(args[0]))
    return realWrite.apply(promises, args)
  }
  promises.rename = (...args: unknown[]): Promise<void> =>
    realRename.apply(promises, args).then(() => { renamed.push(String(args[0])) })
  nodeFs.writeFileSync = (...args: unknown[]): void => {
    writes.push(String(args[0]))
    realWriteSync.apply(nodeFs, args)
  }
  Date.now = () => realNow() + offset
  try {
    // An agent at work in an active session: the poll is on, and every second tick saves.
    const busy = makeFixture()
    writeAgentWorld(busy)
    const on = await run(busy, true)
    assert.deepEqual(on.timed, [1, 3], `timed saves at ticks ${on.timed.join(', ')}`)
    assert.equal(on.exit, 1, 'no exit save')
    assert.ok(readState(busy)?.agents, 'the exit state is not whole')

    // Every session quiet for eleven minutes and no agent: the poll is off, and every tick saves.
    const quiet = makeFixture()
    const own = path.join(quiet.claudeRoot, '-tmp-token-pace-synthetic', '0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0.jsonl')
    fs.writeFileSync(own, fs.readFileSync(own, 'utf8').split(new Date(T).toISOString()).join(new Date(T - 11 * MINUTE).toISOString()))
    const off = await run(quiet, false)
    assert.deepEqual(off.timed, [1, 2, 3, 4], `timed saves at ticks ${off.timed.join(', ')}`)
    assert.equal(off.exit, 1, 'no exit save')
  } finally {
    promises.writeFile = realWrite
    promises.rename = realRename
    nodeFs.writeFileSync = realWriteSync
    Date.now = realNow
  }
})

test('while an agent runs, the poll hands the new and changed files of active sessions to the ingest, never an idle one, and stops when nothing runs and no session is active', async () => {
  const { ext, agg } = lazy()
  const fx = makeFixture()
  const w = writeAgentWorld(fx)
  // 1.6 D8: an active session keeps the poll going — it may start the next agent or run at any
  // moment — so the poll stops only once nothing runs and every session is idle. Here every
  // session is idle by its own transcript: the fixture's session, this one's lines and its sync
  // agent's are dated eleven minutes back, and only the workflow's agent writes now. Its session
  // is active through it while it runs (the roll-up), and idle again once it is done.
  const quiet = T - 11 * MINUTE
  const retime = (file: string): void => {
    fs.writeFileSync(file, fs.readFileSync(file, 'utf8').split(new Date(T).toISOString()).join(new Date(quiet).toISOString()))
  }
  for (const file of [path.join(w.project, '0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0.jsonl'), w.activeMain, w.sync]) retime(file)
  // A state that has been replayed already: the cold start reads every line itself, and
  // nothing waits for a replay.
  const replayed = new agg.Aggregator()
  replayed.agentsRevision = agg.AGENT_TABLES_REVISION
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
    // One active session — this one, through its running agent; the fixture's own is quiet — with
    // five files.
    assert.match(state.logText(), /Agent poll: 4 of 5 agent file\(s\) changed in 1 active session\(s\)/)
    // Both runs have their results, the sync agent had one before: nothing runs any more, no
    // session is active, and the poll stopped with the first model that said so.
    await waitFor('the poll to stop', () => state.logText().includes('Agent poll: off'))

    assert.deepEqual(disposeAll(LIVE.pop()!), [])
    assert.equal(intervals.armed(), 0, 'an interval outlived the extension')
    // The state written on the way out: what the poll found was counted, the idle session was
    // never read again.
    const saved = readState(fx)
    const agents = saved?.agents ?? {}
    // 1.6 P2b: the journals' results are their runs' now, not written onto the agents' records.
    const ended = (run: string): Array<[string, string | null]> =>
      (saved?.runs?.[`${ACTIVE}|${run}`]?.agents ?? []).map((a) => [a.agentId, a.outcome])
    assert.deepEqual(ended(RUN2), [['a2a2a2', 'completed']])
    assert.deepEqual(ended(RUN), [['a1a1a1', 'completed']])
    assert.equal(agents[second]?.requests, 1)
    assert.equal(agents[w.idleAgent]?.input, 17)
    assert.equal(agents[idleNew], undefined)
  } finally {
    seeAgain()
    intervals.restore()
  }
})

test('a journal\'s keys, labels, phases and results reach neither the log, the diagnostics, the markdown nor the state (1.6 §0a.1)', async () => {
  // The host's half of the §0a.1 leak test (test/agg.journal.test.ts has the aggregator's): the
  // cold start reads the journal in the worker, the next line of it is read on the main thread —
  // after the rebuild pass has read the keys again — and the rest goes where the host sends it.
  const fx = makeFixture()
  const w = writeAgentWorld(fx)
  const secret = 'JOURNAL-HOST-CONTENT-3b9e'
  // The fixture's run started a1a1a1 under the key of step "a1a1a1"; the same step again replaces it.
  appendLine(w.journal, journalLine({ type: 'started', agentId: 'a1a1a2', step: 'a1a1a1', label: `${secret}-label`, phase: `${secret}-phase` }))
  const { agg, ext } = lazy()
  const replayed = new agg.Aggregator()
  replayed.agentsRevision = agg.AGENT_TABLES_REVISION
  fs.mkdirSync(fx.storage, { recursive: true })
  fs.writeFileSync(fx.stateFile, JSON.stringify(replayed.toSnapshot()))
  const intervals = holdIntervals()
  const seeAgain = blindRecursiveWatchers()
  try {
    await activateHost(fx, REPO)
    await waitFor('the cold start', () => state.logText().includes('Cold start done'))
    await waitFor('the poll to start', () => state.logText().includes('Agent poll: on'))
    // A result and a third start of the step, read by a pass of the poll on the main thread.
    appendLine(w.journal, journalLine({ type: 'result', agentId: 'a1a1a2', step: 'a1a1a1', result: { summary: `${secret}-result` } }))
    appendLine(w.journal, journalLine({ type: 'started', agentId: 'a1a1a3', step: 'a1a1a1', label: `${secret}-label` }))
    const ingests = state.logText().split('Ingest:').length
    assert.ok(intervals.fire(ext.AGENT_POLL_MS) > 0, 'no interval of the poll\'s period is armed')
    await waitFor('the journal to be read on', () => state.logText().split('Ingest:').length > ingests)
    await state.execute('tokenPace.showUsageMarkdown')
    const markdown = lastMarkdown()
    await state.execute('tokenPace.copyDiagnostics')
    const report = state.clipboard[state.clipboard.length - 1]
    assert.ok(report && report.length > 0, 'no diagnostics were copied')
    assert.deepEqual(disposeAll(LIVE.pop()!), [])
    const saved = fs.readFileSync(fx.stateFile, 'utf8')
    // It went through: the rebuilt keys told the third start from a new step.
    const run = (JSON.parse(saved) as Snapshot).runs?.[`${ACTIVE}|${RUN}`]
    assert.deepEqual(run?.agents.map((a) => [a.agentId, a.step, a.attempt, a.outcome, a.supersededBy]), [
      ['a1a1a1', 1, 1, 'stopped', 'a1a1a2'], ['a1a1a2', 1, 2, 'completed', 'a1a1a3'], ['a1a1a3', 1, 3, null, null],
    ])
    const key = journalKey('a1a1a1')
    assert.ok(fs.readFileSync(w.journal, 'utf8').includes(key), 'the fixture lost its key')
    const hex = key.slice(3)
    const runs = Array.from({ length: hex.length - 15 }, (_, i) => hex.slice(i, i + 16))
    for (const [what, text] of [['log', state.logText()], ['diagnostics', report], ['markdown', markdown], ['state', saved]]) {
      assert.equal(text.includes(key), false, `the ${what} holds the journal key`)
      assert.equal(runs.find((r) => text.includes(r)), undefined, `the ${what} holds 16 hex digits of the journal key`)
      assert.equal(text.includes(secret), false, `the ${what} holds a journal line's label, phase or result`)
      assert.equal(text.includes('synthetic journal'), false, `the ${what} holds the fixture's journal content`)
    }
  } finally {
    seeAgain()
    intervals.restore()
  }
})

test('a Workflow call\'s script and its result\'s summary, paths and names reach neither the log, the diagnostics, the markdown nor the state (1.6 §0a.3)', async () => {
  // The host's half of the §0a.3 leak test (test/agg.runs.test.ts has the aggregator's): the cold
  // start reads the run's launch, the result that names the run and the notification that ends
  // it, the replay the revision asks for reads them again, and the rest goes where the host sends it.
  const fx = makeFixture()
  const w = writeAgentWorld(fx)
  const secret = 'WORKFLOW-HOST-CONTENT-8c2d'
  appendLine(w.activeMain, workflowToolUseLine({ id: 'msg_act_wf', ts: T, toolUseId: 'toolu_wfhost01', script: `${secret}-script` }))
  appendLine(w.activeMain, workflowResultLine({ ts: T, toolUseId: 'toolu_wfhost01', runId: RUN, summary: `${secret}-summary` }))
  appendLine(w.activeMain, queueOperationLine({ ts: T, toolUseId: 'toolu_wfhost01', status: 'completed', summary: `${secret}-note` }))
  await activateHost(fx, REPO)
  await waitFor('the cold start', () => state.logText().includes('Cold start done'))
  const { agg } = lazy()
  await waitFor('the replayed tables to be saved', () => readState(fx)?.agentsRevision === agg.AGENT_TABLES_REVISION)
  await state.execute('tokenPace.showUsageMarkdown')
  const markdown = lastMarkdown()
  await state.execute('tokenPace.copyDiagnostics')
  const report = state.clipboard[state.clipboard.length - 1]
  assert.ok(report && report.length > 0, 'no diagnostics were copied')
  assert.deepEqual(disposeAll(LIVE.pop()!), [])
  const saved = fs.readFileSync(fx.stateFile, 'utf8')
  // It went through: the launch is kept with the run it named and the end the parent recorded,
  // and the run reads done by it.
  const launches = Object.values((JSON.parse(saved) as Snapshot).runLaunches ?? {})
  assert.deepEqual(launches.map((l) => [l.toolUseId, l.runId, l.outcome, l.outcomeStatus]), [['toolu_wfhost01', RUN, 'completed', 'completed']])
  // 1.6 N6: named by its start, then its id.
  assert.match(markdown, /\[Done\] Workflow run [^·]+ · c0ffee00/)
  for (const [what, text] of [['log', state.logText()], ['diagnostics', report], ['markdown', markdown], ['state', saved]]) {
    assert.equal(text.includes(secret), false, `the ${what} holds the call's script, the result's summary or the notification's`)
    for (const fixture of ['synthetic workflow', 'synthetic-workflow-name', '/tmp/synthetic/', 'local_workflow']) {
      assert.equal(text.includes(fixture), false, `the ${what} holds the fixture's ${fixture}`)
    }
  }
})

test('a rejected request\'s text, its details and its quota block reach neither the log, the diagnostics, the markdown nor the state (1.6 §0a.2)', async () => {
  // The host's half of the §0a.2 leak test (test/agg.agents.test.ts has the aggregator's): the
  // cold start reads the error lines of an agent's transcript and of a main one, the replay the
  // revision asks for reads them again, and the rest goes where the host sends it.
  const fx = makeFixture()
  const w = writeAgentWorld(fx)
  const secret = 'API-ERROR-HOST-CONTENT-3a7f'
  appendLine(w.running, apiErrorLine({
    id: 'msg_a1_err', ts: T, agentId: 'a1a1a1', text: `${secret}-text`, errorDetails: `${secret}-details`,
    apiError: `${secret}-api`, upgradePaths: [`${secret}-upgrade`],
  }))
  appendLine(w.activeMain, apiErrorLine({ id: 'msg_act_err', ts: T, text: `${secret}-main`, errorDetails: `${secret}-main-details` }))
  await activateHost(fx, REPO)
  await waitFor('the cold start', () => state.logText().includes('Cold start done'))
  const { agg } = lazy()
  await waitFor('the replayed tables to be saved', () => readState(fx)?.agentsRevision === agg.AGENT_TABLES_REVISION)
  await state.execute('tokenPace.showUsageMarkdown')
  const markdown = lastMarkdown()
  await state.execute('tokenPace.copyDiagnostics')
  const report = state.clipboard[state.clipboard.length - 1]
  assert.ok(report && report.length > 0, 'no diagnostics were copied')
  assert.deepEqual(disposeAll(LIVE.pop()!), [])
  const saved = fs.readFileSync(fx.stateFile, 'utf8')
  // It went through: the agent's record keeps its rejection — three values and a time — and
  // the main session's error line was read for nothing.
  const agents = (JSON.parse(saved) as Snapshot).agents ?? {}
  assert.deepEqual(agents[w.running]?.rejected, { at: T, status: 429, error: 'rate_limit', limit: 'five_hour' })
  for (const [what, text] of [['log', state.logText()], ['diagnostics', report], ['markdown', markdown], ['state', saved]]) {
    assert.equal(text.includes(secret), false, `the ${what} holds an error line's text, details, API error or upgrade offer`)
    for (const fixture of ['synthetic overage reason', 'synthetic-overage-status', 'synthetic-slug']) {
      assert.equal(text.includes(fixture), false, `the ${what} holds the fixture's ${fixture}`)
    }
  }
})

test('a tool call\'s input reaches neither the log, the diagnostics, the markdown nor the state — only its name does (1.6 §0a.5)', async () => {
  // The host's half of the §0a.5 leak test (test/agg.agents.test.ts has the aggregator's): the
  // cold start reads an agent's last tool call, the replay the revision asks for reads it again,
  // and the rest goes where the host sends it.
  const fx = makeFixture()
  const w = writeAgentWorld(fx)
  const secret = 'TOOL-INPUT-HOST-CONTENT-9b4d'
  appendLine(w.running, claudeLine({
    id: 'msg_a1_tool', ts: T, agentId: 'a1a1a1', usage: { input: 4, output: 2 }, final: true, stopReason: 'tool_use',
    content: [{ type: 'tool_use', id: 'toolu_host_leak', name: 'Bash', input: { command: `${secret}-command`, description: `${secret}-description` } }],
  }))
  await activateHost(fx, REPO)
  await waitFor('the cold start', () => state.logText().includes('Cold start done'))
  const { agg } = lazy()
  await waitFor('the replayed tables to be saved', () => readState(fx)?.agentsRevision === agg.AGENT_TABLES_REVISION)
  await state.execute('tokenPace.showUsageMarkdown')
  const markdown = lastMarkdown()
  await state.execute('tokenPace.copyDiagnostics')
  const report = state.clipboard[state.clipboard.length - 1]
  assert.ok(report && report.length > 0, 'no diagnostics were copied')
  assert.deepEqual(disposeAll(LIVE.pop()!), [])
  const saved = fs.readFileSync(fx.stateFile, 'utf8')
  // It went through: the agent's record keeps the call's name and its line's time.
  const agents = (JSON.parse(saved) as Snapshot).agents ?? {}
  assert.deepEqual([agents[w.running]?.lastTool, agents[w.running]?.lastToolTs], ['Bash', T])
  for (const [what, text] of [['log', state.logText()], ['diagnostics', report], ['markdown', markdown], ['state', saved]]) {
    assert.equal(text.includes(secret), false, `the ${what} holds a tool call's input`)
  }
})

test('a session that has just called the Workflow tool, with no agent file yet, starts the poll', async () => {
  // 1.6 D8. A workflow run's first agent writes into a directory made after the watcher started
  // — the one a recursive watcher on Linux can miss — and a `Workflow` call is no agent launch,
  // so no pending node waits for it. Until 1.5.1 nothing started the poll then, and the run's
  // first minute went unseen. The fixture's own session is quiet here; the one active session
  // is the one with the fresh call.
  const fx = makeFixture()
  const project = path.join(fx.claudeRoot, '-tmp-token-pace-synthetic')
  const own = path.join(project, '0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0.jsonl')
  fs.writeFileSync(own, fs.readFileSync(own, 'utf8').split(new Date(T).toISOString()).join(new Date(T - 11 * MINUTE).toISOString()))
  writeLines(path.join(project, `${ACTIVE}.jsonl`), [
    claudeLine({ id: 'msg_wf_1', ts: T, usage: { input: 7, output: 1 }, tools: [{ name: 'Workflow', id: 'toolu_wf_0001' }] }),
  ])
  await activateHost(fx, REPO)
  await waitFor('the cold start', () => state.logText().includes('Cold start done'))
  await waitFor('the poll to start', () => state.logText().includes('Agent poll: on'))
  // On for the session, not for an agent: nothing runs yet.
  assert.match(state.logText(), /Agent poll: on, every 5 s — 0 running agent\(s\)/)
  assert.deepEqual(disposeAll(LIVE.pop()!), [])
})

test('Copy Agent ID copies the id of the node whose details are open, and nothing without one', async () => {
  // 1.6 D11: the details' Copy ID button and the palette command are one command, and what it
  // copies is the whole id the ID row shows — here the sync agent's — never a label or a figure.
  const fx = makeFixture()
  writeAgentWorld(fx)
  const host = await activateHost(fx, REPO)
  await waitFor('the cold start', () => state.logText().includes('Cold start done'))
  // The tables are whole once the cold start has saved them, marked of this build's revision
  // (1.6 L5: a first start reads every line itself and replays nothing). Read off this fixture's
  // saved state — a log line may be an earlier test's, still running when that test disposed its
  // activation.
  const { agg } = lazy()
  await waitFor('the whole tables to be saved', () => readState(fx)?.agentsRevision === agg.AGENT_TABLES_REVISION)
  const page = openDashboard()
  await waitFor('the first payload', () => page.sent.some((m) => (m as { type?: unknown }).type === 'data'))
  const before = state.clipboard.length
  await state.execute('tokenPace.copyAgentId')
  assert.equal(state.clipboard.length, before, 'something was copied with nothing selected')
  assert.equal(state.messages[state.messages.length - 1]?.text, 'Select a node in the Agents section first.')

  // 1.6 D3: the sync agent has finished, so only its tree row can open its details — inside its
  // session, which the reader opens first.
  page.post({ type: 'agentToggle', key: `s:${ACTIVE}` })
  page.post({ type: 'agentSelect', key: 'a:c3c3c3' })
  assert.equal(host.ctx.globalState.get<Record<string, unknown>>('tokenPace.ui')?.agentSelected, 'a:c3c3c3')
  // The button's message, through the page's own allow-list, runs the command.
  page.post({ type: 'command', id: 'tokenPace.copyAgentId' })
  await waitFor('the id on the clipboard', () => state.clipboard.length > before)
  assert.deepEqual(state.clipboard.slice(before), ['c3c3c3'])
  assert.equal(state.messages[state.messages.length - 1]?.text, 'Token Pace: ID copied to the clipboard.')
  assert.deepEqual(disposeAll(LIVE.pop()!), [])
})

test('the exports say the agents are about to leave before anything is written, then write them beside the chosen file (1.6 O2)', async () => {
  const fx = makeFixture()
  writeAgentWorld(fx)
  await activateHost(fx, REPO)
  await waitFor('the cold start', () => state.logText().includes('Cold start done'))
  const { agg } = lazy()
  await waitFor('the whole tables to be saved', () => readState(fx)?.agentsRevision === agg.AGENT_TABLES_REVISION)
  const { AGENTS_CSV_COLUMNS } = require('../src/exporter') as typeof import('../src/exporter')
  const uri = (HOST.api as { Uri: { file(p: string): unknown } }).Uri.file
  // The CSV: the dialog names the tool file and the agents file first; three files follow it.
  const chosen = path.join(fx.data, 'out', 'usage.csv')
  state.answers.push(uri(chosen), undefined)
  await state.execute('tokenPace.exportCsv')
  const title = String(state.saveDialogs[state.saveDialogs.length - 1]?.title ?? '')
  assert.ok(title.includes('Tool names go into a second file beside it (.tools.csv).'), title)
  assert.ok(title.includes('Agent ids and types go into a third file beside it (.agents.csv).'), title)
  const agentsFile = path.join(fx.data, 'out', 'usage.agents.csv')
  assert.deepEqual(state.writes.map((w) => w.path), [chosen, path.join(fx.data, 'out', 'usage.tools.csv'), agentsFile])
  assert.equal(state.messages[state.messages.length - 1]?.text,
    `Token Pace: exported to ${chosen}, ${path.join(fx.data, 'out', 'usage.tools.csv')} and ${agentsFile}`)
  const lines = state.writes[2].text.trim().split('\n')
  assert.equal(lines[0], AGENTS_CSV_COLUMNS.join(','))
  // Every agent of the world, by its id — the running one, the sync one and the idle session's —
  // and none of the paths they were read from.
  assert.deepEqual(lines.slice(1).map((l) => l.split(',')[0]).sort(), ['a1a1a1', 'b1b1b1', 'c3c3c3'])
  for (const w of state.writes) {
    assert.equal(w.text.includes(fx.claudeRoot), false, `${w.path} names the transcripts' root`)
    assert.equal(w.text.includes('.jsonl'), false, `${w.path} names a transcript`)
  }
  // The JSON: one file, its dialog naming agents[].
  const json = path.join(fx.data, 'out', 'usage.json')
  state.answers.push(uri(json), undefined)
  await state.execute('tokenPace.exportJson')
  const jsonTitle = String(state.saveDialogs[state.saveDialogs.length - 1]?.title ?? '')
  assert.ok(jsonTitle.includes('Tool names are included as tools[].') && jsonTitle.includes('Agents are included as agents[].'), jsonTitle)
  assert.equal(state.writes.length, 4)
  const written = JSON.parse(state.writes[3].text) as { schema_version: number; agents: Array<{ agentId: string; type: string | null }> }
  assert.equal(written.schema_version, 3)
  assert.deepEqual(written.agents.map((a) => [a.agentId, a.type]).sort(),
    [['a1a1a1', 'workflow-subagent'], ['b1b1b1', null], ['c3c3c3', 'Explore']])
  assert.equal(state.messages[state.messages.length - 1]?.text, `Token Pace: exported to ${json}`)
  // Said no to: nothing written.
  state.answers.push(undefined)
  await state.execute('tokenPace.exportCsv')
  assert.equal(state.writes.length, 4)
  assert.deepEqual(disposeAll(LIVE.pop()!), [])
})

test('the usage document prints every node of the agent tree, though the dashboard has them all closed', async () => {
  // 1.6 D3: the page carries only what the reader opened; the markdown document is handed the
  // tree with every node open, built for it (`getAgentTextTree`), and the page's stays closed.
  const fx = makeFixture()
  writeAgentWorld(fx)
  await activateHost(fx, REPO)
  await waitFor('the cold start', () => state.logText().includes('Cold start done'))
  // The tables are whole once the cold start has saved them, marked of this build's revision
  // (1.6 L5) — read off this fixture's saved state, as a log line may be an earlier test's. The
  // page's first payload may be a view model built before that — before the cold start's own
  // frame, even.
  const { agg } = lazy()
  await waitFor('the whole tables to be saved', () => readState(fx)?.agentsRevision === agg.AGENT_TABLES_REVISION)
  const page = openDashboard()
  const pageTree = (): AgentTreeVm | undefined => {
    const carrying = page.sent.filter((m) => {
      const { type, key } = m as { type?: unknown; key?: unknown }
      return type === 'data' || (type === 'section' && key === 'agents')
    }) as Array<{ payload: { agents: AgentTreeVm } }>
    return carrying[carrying.length - 1]?.payload.agents
  }
  await waitFor('the tree on the page', () => treeKeys(pageTree()?.roots ?? []).includes(`s:${ACTIVE}`))
  assert.ok(pageTree()!.roots.every((r) => r.children.length === 0), 'the closed tree carried children to the page')
  await state.execute('tokenPace.showUsageMarkdown')
  const md = lastMarkdown()
  const at = md.indexOf('### Sessions and agents')
  assert.ok(at >= 0, md)
  const tree = md.slice(at, md.indexOf('\n## ', at) < 0 ? undefined : md.indexOf('\n## ', at))
  // The sessions, the run inside the active one and its agent, the sync agent and the idle one's.
  // 1.6 N6: sessions and runs named by their start, then their id.
  assert.match(tree, /\n- \[[^\]]+\] Session [^·]+ · a0a0a0a0/)
  assert.match(tree, /\n {2}- \[[^\]]+\] Workflow run [^·]+ · c0ffee00/)
  assert.match(tree, /\n {4}- \[[^\]]+\] workflow-subagent · claude-[^ ]+ · a1a1 · /)
  assert.match(tree, /\n {2}- \[[^\]]+\] Explore · claude-[^ ]+ · c3c3 · /)
  assert.match(tree, /\n {2}- \[[^\]]+\] Agent · claude-[^ ]+ · b1b1 · /)
  assert.deepEqual(disposeAll(LIVE.pop()!), [])
})

test('the agent tables of an upgraded snapshot are replayed once after the cold start, not on the next start, and not after a re-read', async () => {
  const fx = makeFixture()
  const w = writeAgentWorld(fx)
  const fixtureMain = path.join(w.project, '0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0.jsonl')
  // What a 1.4 build leaves behind: every line counted, every cursor at its file's end, no agent table.
  const v6 = await seedSnapshot(fx, 6)
  const claudeFiles = Object.keys(v6.cursors).filter((f) => f.startsWith(fx.claudeRoot + path.sep)).length
  assert.equal(claudeFiles, 7)

  await activateHost(fx, REPO)
  const { agg } = lazy()
  await waitFor('the replayed tables to be saved', () => readState(fx)?.agentsRevision === agg.AGENT_TABLES_REVISION)
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
  // The replay draws its frame once its save is done, and the file read above is on disk a
  // moment before that frame: a page resolved in between is given the tree of the frame before,
  // and the replayed one follows as the `agents` section when the section's interval allows.
  const page = openDashboard()
  assert.ok(page.sent.some((m) => (m as { type?: unknown }).type === 'data'), 'the dashboard got no full payload')
  const pageTree = (): AgentTreeVm | undefined => {
    const carrying = page.sent.filter((m) => {
      const { type, key } = m as { type?: unknown; key?: unknown }
      return type === 'data' || (type === 'section' && key === 'agents')
    }) as Array<{ payload: { agents: AgentTreeVm } }>
    return carrying[carrying.length - 1]?.payload.agents
  }
  // 1.6 D3: the page carries a node's children only while it is open, so the reader opens the two
  // sessions and the run.
  for (const key of [`s:${ACTIVE}`, `w:${ACTIVE}|${RUN}`, `s:${IDLE}`]) page.post({ type: 'agentToggle', key })
  const wanted = [`s:${ACTIVE}`, `w:${ACTIVE}|${RUN}`, 'a:a1a1a1', 'a:c3c3c3', `s:${IDLE}`, 'a:b1b1b1']
  await waitFor('the replayed tree on the page', () => {
    const tree = pageTree()
    return !!tree && wanted.every((k) => treeKeys(tree.roots).includes(k))
  })
  const keys = treeKeys(pageTree()!.roots)
  for (const key of wanted) {
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

  // --- "Re-read token history" reads every line itself, and replays nothing ------
  // 1.6 L5 (§7c, Review 1 #2): until P11 the re-read replayed over what it had just read — the
  // same lines once more, the tree half built meanwhile. Its scan starts with no cursor, so the
  // tables it leaves are of this build's revision, and the state says so.
  await state.execute('tokenPace.rescan')
  assert.doesNotMatch(state.logText(), /Agent replay/)
  const reread = readState(fx)
  assert.ok(reread)
  assert.equal(reread.agentsRevision, agg.AGENT_TABLES_REVISION)
  assert.deepEqual(Object.keys(reread.agents ?? {}).sort(), [w.running, w.sync, w.idleAgent].sort())
  assert.equal(reread.agents?.[w.sync]?.outcome, 'completed')
  assert.equal(reread.agents?.[w.sync]?.meta?.agentType, 'Explore')
  assert.equal(reread.launches?.toolu_sync01?.agentId, 'c3c3c3')
  assert.deepEqual(Object.keys(reread.mains ?? {}).sort(), [fixtureMain, w.activeMain, w.idleMain].sort())
  assert.deepEqual(fingerprintOf(reread), fingerprintOf(v6))
  assert.deepEqual(disposeAll(LIVE.pop()!), [])
})

test('a first start with no stored state reads the agent tables whole and replays nothing; a state of an older revision is replayed (1.6 L5)', async () => {
  // §7c (Review 1 #2): the cold scan of a first start reads every line from the first byte, so
  // the replay that followed it read the same lines again — and took the tables apart while it
  // did, the tree half built for that while.
  const fx = makeFixture()
  const w = writeAgentWorld(fx)
  const { agg } = lazy()
  await activateHost(fx, REPO)
  await waitFor('the cold start', () => state.logText().includes('Cold start done'))
  await waitFor('the state to be saved', () => readState(fx) !== null)
  const first = readState(fx)!
  assert.equal(first.agentsRevision, agg.AGENT_TABLES_REVISION, 'the cold scan did not mark its tables of this revision')
  await sleep(300)
  assert.doesNotMatch(state.logText(), /Agent replay/)
  // Whole without it: every agent, the sync agent's outcome and identity, its launch, every session.
  assert.deepEqual(Object.keys(first.agents ?? {}).sort(), [w.running, w.sync, w.idleAgent].sort())
  assert.equal(first.agents?.[w.sync]?.outcome, 'completed')
  assert.equal(first.agents?.[w.sync]?.meta?.agentType, 'Explore')
  assert.equal(first.agents?.[w.running]?.workflowId, RUN)
  assert.equal(first.launches?.toolu_sync01?.agentId, 'c3c3c3')
  assert.deepEqual((first.runs?.[`${ACTIVE}|${RUN}`]?.agents ?? []).map((a) => a.agentId), ['a1a1a1'])
  await state.execute('tokenPace.showUsageMarkdown')
  assert.match(lastMarkdown(), /\[~Running\] workflow-subagent · claude-[^ ]+ · a1a1/)
  assert.deepEqual(disposeAll(LIVE.pop()!), [])

  // A stored state whose tables are of an older revision — read on from its cursors — is still
  // replayed once, as every upgrade is.
  const older = readState(fx)!
  older.agentsRevision = agg.AGENT_TABLES_REVISION - 1
  fs.writeFileSync(fx.stateFile, JSON.stringify(older))
  await activateHost(fx, REPO)
  await waitFor('the replay after the cold start', () => /Agent replay \(cold start\): \d+ file\(s\) read again/.test(state.logText()))
  await waitFor('the replayed tables to be saved', () => readState(fx)?.agentsRevision === agg.AGENT_TABLES_REVISION)
  assert.deepEqual(Object.keys(readState(fx)?.agents ?? {}).sort(), [w.running, w.sync, w.idleAgent].sort())
  assert.deepEqual(disposeAll(LIVE.pop()!), [])
})

test('a replay still saving at disposal draws no frame after it and leaves the exit state in place', async () => {
  // Held still, the interleaving a loaded machine produced now and then: the replay after the
  // cold start is saving the tables it rebuilt when the window goes. The frame it drew once the
  // save was done built status bar items nothing ever disposed — into the next test's recording,
  // too — and its temp file was the exit save's as well. 1.6 L5: a first start with no stored
  // state replays nothing any more, so the window starts from a stored state whose tables were
  // never replayed — revision 0, as a build before 1.6 leaves them.
  const fx = makeFixture()
  const seeded = await seedSnapshot(fx, 8)
  assert.equal(seeded.agentsRevision, 0)
  const tmp = `${fx.stateFile}.tmp`
  // The module object itself, as in `blindRecursiveWatchers`: the bundle reads `writeFile` from
  // it at every call.
  const promises = (require('fs') as typeof fs).promises as unknown as { writeFile: (...args: unknown[]) => Promise<void> }
  const real = promises.writeFile
  let release: () => void = () => undefined
  let held: Promise<void> | null = null
  promises.writeFile = (...args: unknown[]): Promise<void> => {
    // The cold start's own save goes through; the replay's is the one after its log line.
    if (held === null && args[0] === tmp && state.logText().includes('Agent replay (cold start)')) {
      held = new Promise<void>((r) => { release = r }).then(() => real.apply(promises, args))
      return held
    }
    return real.apply(promises, args)
  }
  try {
    await activateHost(fx, REPO)
    await waitFor('the replay\'s save', () => held !== null)
    assert.deepEqual(disposeAll(LIVE.pop()!), [])
    const created = state.items.length
    // The exit save's file by identity: the replay's snapshot holds the same tables, so only a
    // file renamed over it would tell the two apart.
    const exitFile = fs.statSync(fx.stateFile, { bigint: true }).ino

    release()
    await held
    // What the save does next — a rename, or dropping its temp file — and the replay after it.
    await waitFor('the save to end', () => !fs.existsSync(tmp))
    await sleep(100)
    assert.equal(state.items.length, created, 'a status bar item was built after disposal')
    assert.equal(fs.statSync(fx.stateFile, { bigint: true }).ino, exitFile, 'a save under way at disposal replaced the exit state')
    assert.deepEqual(fs.readdirSync(fx.storage).filter((n) => n.startsWith('state.json.')), [], 'a temp file was left behind')
    assert.doesNotMatch(state.logText(), /Could not persist the snapshot/)
  } finally {
    promises.writeFile = real
  }
})

test('a follower shows the agents of the leader\'s state and neither polls nor replays', async () => {
  const fx = makeFixture()
  writeAgentWorld(fx)
  // The leader's state as this build writes it, with a running agent — never replayed, which a
  // leader would do now and a follower must leave to the leader.
  const leader = await seedSnapshot(fx, 8)
  assert.equal(leader.agentsRevision, 0)
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
