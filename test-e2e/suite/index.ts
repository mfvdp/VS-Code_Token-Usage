// SPDX-FileCopyrightText: 2026 Frederik Marx
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The extension-host smoke test: the few questions that only a real VS Code window can answer.
 *
 * The unit suite runs `activate()` against a fake workbench, which answers exactly what the
 * code asks it. That is why `affectsConfiguration('tokenPace.tokenPace')` — a section that
 * does not exist — could go unnoticed from 1.0 to 1.2: every settings change quietly waited
 * for a reload, and ~800 tests were happy. So this file asserts only things the fake cannot
 * fake: the manifest and the code agreeing on ids, a real command dispatch, a real settings
 * write through the workbench, a real editor tab.
 *
 * No mocha. `run()` is what `--extensionTestsPath` calls; the runner below is twenty lines,
 * runs every check even after one fails, and rejects with all of the messages at once, which
 * is what makes the CI log readable without opening an artifact.
 *
 * Launched by `test-e2e/run.mjs` (`npm run test:e2e`) in an isolated user-data-dir with a
 * fresh HOME — this window never sees a real transcript, credential or quota cache.
 */

import { strict as assert } from 'node:assert'
import * as vscode from 'vscode'
// Type-only, so nothing of the extension is bundled into the suite: it exists to keep the
// API this test relies on in step with the one `activate()` actually returns.
import type { TokenPaceApi } from '../../src/extension'

const EXTENSION_ID = 'frederik.token-pace'
/** The one status-bar item that exists without any usage data at all. */
const TOKENS_ITEM = 'tokenPace.tokens'
/** The item `tokenPace.density: minimal` folds the per-window items into. */
const SUMMARY_ITEM = 'tokenPace.summary'
/** The scheme of the markdown usage document (`src/nativeViews.ts`). */
const MARKDOWN_SCHEME = 'tokenpace'

/** How long a settings change may take to reach the bar before it counts as broken. */
const SETTLE_MS = 5000
/**
 * The first frame after the cold scan may wait for a worker thread on a busy runner, and that
 * is not the seam under test — only the steps after it are held to `SETTLE_MS`.
 */
const READY_MS = 20_000
const POLL_MS = 50
/** A hung window must fail the run, not hold the CI job until its own timeout. */
const RUN_BUDGET_MS = 120_000

// ---------------------------------------------------------------------------
// The runner
// ---------------------------------------------------------------------------

interface Check {
  name: string
  run: () => Promise<void>
}

const checks: Check[] = []

function check(name: string, run: () => Promise<void>): void {
  checks.push({ name, run })
}

function messageOf(err: unknown): string {
  if (err instanceof Error) return err.stack ?? err.message
  return String(err)
}

const sleep = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms))

/**
 * Polls `probe` until it returns something truthy, or fails saying what it waited for.
 * Every asynchronous step in this file goes through it, so no check can pass by accident of
 * timing and none can hang.
 */
async function waitFor<T>(
  what: string,
  probe: () => T | Promise<T>,
  ms = SETTLE_MS,
): Promise<NonNullable<T>> {
  const deadline = Date.now() + ms
  for (;;) {
    const value = await probe()
    // Truthy is the signal, so the caller can return the value it was waiting for and use it.
    if (value) return value as NonNullable<T>
    if (Date.now() >= deadline) throw new Error(`timed out after ${ms} ms waiting for ${what}`)
    await sleep(POLL_MS)
  }
}

// ---------------------------------------------------------------------------
// Shared state and small helpers
// ---------------------------------------------------------------------------

let api: TokenPaceApi | null = null
/** The name of the check that is running, for the watchdog's message. */
let current = '(none)'

function extension(): vscode.Extension<unknown> {
  const ext = vscode.extensions.getExtension(EXTENSION_ID)
  assert.ok(ext, `${EXTENSION_ID} is not present in this window`)
  return ext
}

function extensionApi(): TokenPaceApi {
  assert.ok(api, 'the extension API is missing — the activation check has to pass first')
  return api
}

function settings(): vscode.WorkspaceConfiguration {
  return vscode.workspace.getConfiguration('tokenPace')
}

/** The text of one status-bar item, or undefined when the bar does not carry it. */
function textOf(items: ReadonlyArray<{ id: string; text: string }>, id: string): string | undefined {
  return items.find((i) => i.id === id)?.text
}

/** For a failure message: the whole bar, ids and texts, in bar order. */
function describe(items: ReadonlyArray<{ id: string; text: string }>): string {
  return items.length === 0 ? '(no items)' : items.map((i) => `${i.id}="${i.text}"`).join(' | ')
}

/** The command ids the manifest contributes, read defensively — `packageJSON` is untyped. */
function contributedCommands(manifest: unknown): string[] {
  const contributes = (manifest as { contributes?: unknown } | undefined)?.contributes
  const commands = (contributes as { commands?: unknown } | undefined)?.commands
  if (!Array.isArray(commands)) return []
  return commands
    .map((c) => (c as { command?: unknown }).command)
    .filter((c): c is string => typeof c === 'string')
}

/** Every open editor tab, across all groups. */
function tabs(): readonly vscode.Tab[] {
  return vscode.window.tabGroups.all.flatMap((g) => g.tabs)
}

// ---------------------------------------------------------------------------
// The checks
// ---------------------------------------------------------------------------

check('the extension is present and activates', async () => {
  const ext = extension()
  const exported = await ext.activate() as TokenPaceApi | undefined
  assert.ok(ext.isActive, 'activate() resolved but the extension is not active')
  assert.ok(exported, 'activate() resolved without the extension API')
  assert.equal(typeof exported.statusBar, 'function', 'the API has no statusBar()')
  const version = (ext.packageJSON as { version?: unknown }).version
  assert.equal(exported.version, version, 'the API reports a different version than the manifest')
  api = exported

  // An activation that renders nothing would make every later check vacuous.
  const items = exported.statusBar()
  assert.ok(items.length > 0, 'the status bar is empty after activation')
  assert.ok(textOf(items, TOKENS_ITEM) !== undefined, `no ${TOKENS_ITEM} item: ${describe(items)}`)
  console.log(`     status bar: ${describe(items)}`)
})

check('every contributed command is registered', async () => {
  const declared = contributedCommands(extension().packageJSON)
  assert.ok(declared.length > 0, 'the manifest contributes no commands — nothing was checked')
  const registered = new Set(await vscode.commands.getCommands(true))
  const missing = declared.filter((id) => !registered.has(id))
  assert.deepEqual(missing, [], `contributed but not registered: ${missing.join(', ')}`)
})

check('the status-bar preview runs and ends', async () => {
  // Executing it is the whole check: the preview builds every synthetic state through the
  // same text layer as the live bar, so a throw here is a broken renderer, not a broken test.
  await vscode.commands.executeCommand('tokenPace.previewStatusBar')
  // The command toggles a 60 s preview. Ending it right away keeps the synthetic items from
  // outliving this check — they never touch the live ids, but the dashboard says "preview"
  // while one is on screen, and no other check should have to know that.
  await vscode.commands.executeCommand('tokenPace.previewStatusBar')
})

check('a settings change reaches the status bar without a reload', async () => {
  const tp = extensionApi()

  // The starting point is written rather than assumed, so the check does not depend on what
  // the manifest currently defaults `summary.period` to. This wait also covers the cold scan:
  // until it ends, the item says "reading history …" instead of a period.
  await settings().update('summary.period', 'today', vscode.ConfigurationTarget.Global)
  const before = await waitFor(
    `${TOKENS_ITEM} to show the "today" period`,
    () => {
      const text = textOf(tp.statusBar(), TOKENS_ITEM)
      return text !== undefined && text.endsWith('· today') ? text : undefined
    },
    READY_MS,
  )

  // This is the regression that lived from 1.0 to 1.2: the workbench answers
  // `affectsConfiguration` per section prefix, the host asked for a section that did not
  // exist, and every settings change waited for a window reload without saying so.
  await settings().update('summary.period', '7d', vscode.ConfigurationTarget.Global)
  const after = await waitFor(
    `${TOKENS_ITEM} to follow tokenPace.summary.period`,
    () => {
      const text = textOf(tp.statusBar(), TOKENS_ITEM)
      return text !== undefined && text !== before ? text : undefined
    },
  )
  assert.ok(after.endsWith('· 7d'), `the item still reads "${after}" after the period changed`)

  // And back, so the seam is proven in both directions and the profile is left as it was.
  await settings().update('summary.period', undefined, vscode.ConfigurationTarget.Global)
  await waitFor(
    `${TOKENS_ITEM} to return to the default period`,
    () => textOf(tp.statusBar(), TOKENS_ITEM) === before,
  )

  // The same seam from the other side: `density: minimal` changes which items exist rather
  // than what one of them says, and that half of the wiring has its own code path.
  assert.equal(
    tp.statusBar().some((i) => i.id === SUMMARY_ITEM), false,
    `${SUMMARY_ITEM} is on the bar before the density changed: ${describe(tp.statusBar())}`,
  )
  await settings().update('density', 'minimal', vscode.ConfigurationTarget.Global)
  await waitFor(
    `${SUMMARY_ITEM} to appear at minimal density`,
    () => tp.statusBar().some((i) => i.id === SUMMARY_ITEM),
  )
  await settings().update('density', undefined, vscode.ConfigurationTarget.Global)
  await waitFor(
    `${SUMMARY_ITEM} to go again`,
    () => !tp.statusBar().some((i) => i.id === SUMMARY_ITEM),
  )
})

check('the dashboard command opens the dashboard', async () => {
  // Default mode: the webview *view* in the secondary side bar. It is not an editor tab, so
  // `window.tabGroups` cannot see it; what is observable is that the command resolves, and
  // that is exactly what breaks when the contributed view id and the `<viewType>.focus`
  // command drift apart — the dispatch then rejects with "command not found".
  await vscode.commands.executeCommand('tokenPace.showDashboard')

  // The tab assertion goes through the mode that does open an editor: the same command, the
  // live `dashboard.mode` setting, the markdown usage document. It proves the routing, the
  // content provider and the settings seam in one go.
  await settings().update('dashboard.mode', 'markdown', vscode.ConfigurationTarget.Global)
  try {
    const tab = await waitFor('the usage document to open as a tab', async () => {
      // Re-issued each poll: the command reads the mode from the host's own copy of the
      // settings, which the configuration event fills in — the first attempt may still be
      // the webview one.
      await vscode.commands.executeCommand('tokenPace.showDashboard')
      return tabs().find((t) => t.input instanceof vscode.TabInputText
        && t.input.uri.scheme === MARKDOWN_SCHEME)
    })
    assert.ok(tab.label.length > 0, 'the usage tab has no label')
  } finally {
    await settings().update('dashboard.mode', undefined, vscode.ConfigurationTarget.Global)
    await vscode.commands.executeCommand('workbench.action.closeAllEditors')
  }
})

// ---------------------------------------------------------------------------
// run()
// ---------------------------------------------------------------------------

/** What `--extensionTestsPath` calls. Rejecting is what fails the run. */
export async function run(): Promise<void> {
  const failures: string[] = []
  const watchdog = sleep(RUN_BUDGET_MS).then(() => {
    throw new Error(`the smoke test did not finish within ${RUN_BUDGET_MS} ms (in: ${current})`)
  })

  const all = (async (): Promise<void> => {
    console.log(`Token Pace extension-host smoke test — ${checks.length} checks`)
    for (const c of checks) {
      current = c.name
      const started = Date.now()
      try {
        await c.run()
        console.log(`ok   ${c.name} (${Date.now() - started} ms)`)
      } catch (err) {
        failures.push(`${c.name}: ${messageOf(err)}`)
        console.error(`FAIL ${c.name} (${Date.now() - started} ms)\n${messageOf(err)}`)
      }
    }
    current = '(done)'
    console.log(`${checks.length - failures.length}/${checks.length} checks passed`)
    if (failures.length > 0) {
      throw new Error(`${failures.length} of ${checks.length} checks failed:\n  - ${failures.join('\n  - ')}`)
    }
  })()

  await Promise.race([all, watchdog])
}
