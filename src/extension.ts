// SPDX-FileCopyrightText: 2026 Frederik Marx
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Wiring. Every decision this file makes is about *when* something runs and *who* runs it;
 * every decision about what a number means lives in the modules it calls.
 *
 * Three rules shape the layout:
 *
 *  • One window leads. With several editors open only the lease holder reads transcripts,
 *    polls and writes the shared files; the others watch those files and render them. A
 *    follower that wrongly believes it follows would show stale figures forever, so anything
 *    unreadable counts as "lead yourself" (see lease.ts).
 *  • The status bar ticks every second, the view model at most every five. Rebuilding the
 *    dashboard model is the expensive half, and a countdown does not need it.
 *  • Nothing is written outside `globalStorage` from here. The two opt-in exceptions have
 *    their own consent objects and live in quotaManager.ts and bridge.ts.
 */

import * as crypto from 'crypto'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { Worker } from 'worker_threads'
import * as vscode from 'vscode'
import { ADAPTERS, isKnownSource, SOURCES } from './adapters'
import { AgentTreeVm, MAX_AGENT_MORE, MAX_MORE_PAGES } from './agentTree'
import { AGENT_TABLES_REVISION, Aggregator, IngestChanges } from './agg'
import { Alerts } from './alerts'
import { BridgePaths, registerBridgeCommands, state as bridgeState } from './bridge'
import {
  affects, Config, CONFIG_KEYS, readAlertConfig, readConfig, readPaceConfig, readTimeConfig,
} from './config'
import { NetworkConsent, WriteConsent } from './consent'
import { watchCredentials } from './credentials'
import { DashboardProvider } from './dashboard'
import {
  buildDiagnostics, collectHttpSettings, collectProxyEnv, collectSettings, DiagnosticsInput,
  HttpSetting, QuotaDiag, tildify,
} from './diagnostics'
import { CLAUDE_ROOTS, CODEX_ROOTS, configureRoots } from './discover'
import { DEFAULT_FORECAST_CONFIG, ForecastConfig } from './forecast'
import { setBundle, setLocale, t } from './i18n'
import { Lease } from './lease'
import { NativeViews, registerNativeViews } from './nativeViews'
import { effectivePace, paceVerdict, windowElapsed } from './pace'
import { CLAUDE_QUOTA_FILE, CODEX_QUOTA_FILE, configureQuotaFiles } from './quota'
import { QuotaHistory } from './quotaHistory'
import { QuotaManager, QuotaOptions } from './quotaManager'
import { agentPollFiles, agentReplayFiles, replayAgents, scan, ScanContext } from './scan'
import { sectionSettingsQuery } from './sectionSettings'
import { Role, showMenu, StatusBar, StatusInput } from './statusbar'
import { buildItems, USAGE_PAGE } from './statusText'
import {
  bridgeBlocksDelete, deleteItems, deleteWarning, deleteWarningExternal, formatBytes, inventory,
  StoredKey, StoredPaths,
} from './storage'
import { DayRange, dayOf, RangePreset, rangeFor } from './time'
import { Forecast, PaceVerdict, QuotaState, Snapshot, Source } from './types'
import {
  agentTreeFor, applyMessage, buildViewModel, DASHBOARD_SECTION_KEYS, defaultUiState, forecastsFor, isAgentSelectedIn, isChartSplit,
  MAX_AGENT_EXPANDED, MAX_AGENT_KEY_CHARS, RANGE_PRESETS, UiState, ViewModel,
  WebviewMessage,
} from './viewModel'

/** Status bar cadence: countdowns and ages have to move, so this cannot be slower. */
const TICK_MS = 1000
/**
 * The dashboard model is rebuilt on events and otherwise at most this often — and, since 1.6 (L5),
 * after an ingest that changed the buckets at most this often too: the agent tree follows every
 * ingest at once, the rest of the page the next whole rebuild.
 */
export const VM_MIN_INTERVAL_MS = 5000
/** The timed save's period. */
export const SAVE_MS = 5000
/**
 * 1.6 L5: while the agent poll is on — agents at work, their lines arriving every few seconds —
 * the timed save runs at most this often. The replay's save, the exit save and a lost lease are
 * not affected: the snapshot's cursors and counts are always saved together, so the next leader
 * reads on from whatever the last save held.
 */
export const AGENT_SAVE_MS = 10_000
const INGEST_DEBOUNCE_MS = 400
const SWEEP_MS = 60_000
const QUOTA_TICK_MS = 30_000
const LEASE_MS = 30_000
const ALERT_MS = 60_000
const HISTORY_SAVE_MS = 5 * 60_000
const ROLLUP_MS = 6 * 60 * 60_000
/** A file event storm (a save, a rename, a truncation) is one reload. */
const FOLLOWER_DEBOUNCE_MS = 1000
const QUOTA_FILE_DEBOUNCE_MS = 300
/**
 * While an agent runs, the agent directories of its session are listed this often: the file
 * watcher reports a change within about a second, but not the files of a directory it has
 * never seen (see `agentPollFiles`), and the sweep comes only once a minute.
 */
export const AGENT_POLL_MS = 5000

/** The debug log file is rotated at this size; exactly one older generation is kept. */
const LOG_ROTATE_BYTES = 5 * 1024 * 1024

const SALT_KEY = 'tokenPace.projectSalt'
const UI_KEY = 'tokenPace.ui'
const REMOTE_HINT_KEY = 'tokenPace.remoteHintShown'
const EXTENSION_ID = 'frederik.token-pace'

const WINDOW_SELECT_CYCLE = ['all', 'leading', 'worstPace', 'session', 'weekly', 'auto'] as const
/** Chart metrics, for validating a persisted UI state from an older build. */
const METRICS: ReadonlyArray<UiState['metric']> = ['usage', 'output', 'cacheRead', 'requests', 'reasoning', 'cost']

let log: Logger

/**
 * What `activate` resolves with, and therefore what
 * `vscode.extensions.getExtension('frederik.token-pace')?.exports` is.
 *
 * It exists for one reader: the extension-host smoke test in `test-e2e/`, which has to watch
 * a settings change arrive in a *real* window — the bug that lived from 1.0 to 1.2 was
 * invisible to every unit test because the fake host answered `affectsConfiguration` the way
 * the code asked, not the way the workbench does. So it stays deliberately small and stable:
 * a version string and what the status bar last rendered. Nothing here exposes a transcript,
 * a token, a path or an account — the item text is the same string the user can read off the
 * bar. Preview items (`tokenPace.preview.*`) live in their own id space and are not reported.
 */
export interface TokenPaceApi {
  /** The version of the manifest this bundle was built from. */
  version: string
  /** Id and text of the live status-bar items as of the last render, in bar order. */
  statusBar(): Array<{ id: string; text: string }>
  /**
   * Size of the page the dashboard webview last rendered; 0 until the view resolves. The
   * smoke test polls it: the workbench swallows whatever `resolveWebviewView` throws, so a
   * command that resolves proves nothing about the page.
   */
  dashboardHtmlLength(): number
  /**
   * How many payloads the dashboard webview acknowledged as rendered. The smoke test waits
   * for it after the html length: it proves the postMessage channel and the page's origin
   * rule, which the length alone cannot.
   */
  dashboardRendered(): number
}

export async function activate(context: vscode.ExtensionContext): Promise<TokenPaceApi> {
  // The seam first: everything below may put a string on screen, and the bundle VS Code
  // loaded for the editor's language is the only translation there is (see i18n.ts).
  setLocale(vscode.env.language)
  setBundle(vscode.l10n.bundle ?? {})

  log = new Logger(vscode.window.createOutputChannel('Token Pace', { log: true }))
  context.subscriptions.push(log)
  const say = (m: string): void => log.info(m)

  // --------------------------------------------------------------- settings and paths
  let cfg = readConfig()
  log.configure(cfg.debug, cfg.debugLogFile)
  configureRoots(cfg.claudeDir, cfg.codexDir)
  configureQuotaFiles(cfg.claudeQuotaFile, cfg.codexQuotaFile)

  const storage = context.globalStorageUri.fsPath
  try {
    fs.mkdirSync(storage, { recursive: true })
  } catch (err) {
    log.error(`Could not create the storage directory ${storage}: ${err}`)
  }

  const paths: StoredPaths = {
    state: path.join(storage, 'state.json'),
    quota: path.join(storage, 'quota.json'),
    history: path.join(storage, 'quotaHistory.json'),
    leader: path.join(storage, 'leader.json'),
    mirror: path.join(storage, 'statusline-mirror.json'),
  }
  // `~/.claude.json` lives in the home directory even when CLAUDE_CONFIG_DIR moves the rest
  // of Claude Code's state; deriving it from the config dir would read the wrong file.
  const claudeJsonFile = path.join(os.homedir(), '.claude.json')
  // Same derivation discover.ts uses, so credentials and settings.json follow the roots:
  // CLAUDE_ROOTS[0] is `<claudeDir>/projects`.
  const claudeDir = CLAUDE_ROOTS[0] ? path.dirname(CLAUDE_ROOTS[0]) : path.join(os.homedir(), '.claude')

  log.info(`Claude roots: ${CLAUDE_ROOTS.join(' · ') || 'none'}`)
  log.info(`Codex roots:  ${CODEX_ROOTS.join(' · ') || 'none'}`)
  log.info(`Quota files:  ${CLAUDE_QUOTA_FILE} | ${CODEX_QUOTA_FILE}`)

  // A per-machine random salt: project hashes stay stable across sessions but say nothing
  // about the directory to anyone who has not got this machine's globalState.
  let salt = context.globalState.get<string>(SALT_KEY, '')
  if (typeof salt !== 'string' || salt.length < 16) {
    salt = crypto.randomBytes(16).toString('hex')
    await context.globalState.update(SALT_KEY, salt)
  }

  // --------------------------------------------------------------- core objects
  let agg = Aggregator.fromSnapshot(loadSnapshot(paths.state), cfg.attribution)
  agg.timeConfig = readTimeConfig(cfg)
  let snapshotBytes = fileSize(paths.state)

  const history = new QuotaHistory(paths.history, cfg.quotaHistoryDays)
  history.load()

  const consent = new NetworkConsent(context.globalState, say, {
    intervalMinutes: () => readConfig().pollIntervalMinutes,
  })
  // A function, not a value: both paths follow `tokenPace.claudeQuotaFile` /
  // `tokenPace.codexQuotaFile`, so the dialog must read them when it is shown and
  // not keep whatever they were at activation.
  const writeConsent = new WriteConsent(context.globalState, 'writeQuotaCache', say, {
    paths: () => ({ quotaCacheFiles: externalQuotaFiles() }),
  })

  const quotaMgr = new QuotaManager(
    quotaOptions(cfg),
    { stateFile: paths.quota, historyFile: paths.history, mirrorFile: paths.mirror, claudeJsonFile },
    say,
    () => consent.granted(),
    () => agg.codexRateLimits(),
    history,
    { extVersion: __EXT_VERSION__ },
  )

  const statusBar = new StatusBar()
  context.subscriptions.push(statusBar)

  const alerts = new Alerts(context.globalState, readAlertConfig(cfg), say, undefined, {
    staleAfterMs: cfg.staleAfterMinutes * 60_000,
  })

  let ui = restoreUi(context.globalState.get<unknown>(UI_KEY), cfg)

  // --------------------------------------------------------------- mutable state
  let quotas: QuotaState[] = []
  let forecasts = new Map<string, Forecast>()
  let latestVm: ViewModel | undefined
  /** When the timed save last wrote the state (1.6 L5: at most every AGENT_SAVE_MS while agents run). */
  let lastTimedSave: number | null = null
  /** The input of the last status-bar render; the extension API reads the bar through it. */
  let lastStatusInput: StatusInput | null = null
  let role: Role = 'single'
  let roleWired = false
  let scanning = false
  let ingesting = false
  /** The one-time agent replay while it runs; no ingest, roll-up or timed save meanwhile. */
  let replayRun: Promise<void> | null = null
  /** A replay that failed is tried again on the next activation, not after every ingest. */
  let replayFailed = false
  let dirty = false
  let saving = false
  /** Set on the way out: work still in flight then must not start anything new. */
  let disposed = false
  let writeConsentAsked = false
  const pendingFiles = new Set<string>()

  // --------------------------------------------------------------- config helpers
  /**
   * Both external quota cache files, deduplicated and in the order the consent
   * dialog and the delete list name them. Read on every call: the two settings
   * behind them can change while the window is open.
   */
  function externalQuotaFiles(): string[] {
    const all = [CLAUDE_QUOTA_FILE, CODEX_QUOTA_FILE].filter((f) => typeof f === 'string' && f !== '')
    return all.filter((f, i) => all.indexOf(f) === i)
  }

  function quotaOptions(c: Config): QuotaOptions {
    return {
      mode: c.quotaSource,
      intervalMinutes: c.pollIntervalMinutes,
      claudeDir: c.claudeDir[0] || undefined,
      codexBinary: c.codexBinary || undefined,
      claudeOrder: c.claudeQuotaSources,
      codexOrder: c.codexQuotaSources,
      keychain: c.credentials.keychain,
      userAgent: c.userAgent,
      // Two gates: the setting asks for it and the user has agreed to that specific write.
      writeQuotaCache: c.writeQuotaCache && writeConsent.granted(),
      appServerMode: c.codexAppServer.mode,
      pollOnlyWhenFocused: c.pollOnlyWhenFocused,
    }
  }

  function forecastConfig(): ForecastConfig {
    return {
      ...DEFAULT_FORECAST_CONFIG,
      // A reading older than two poll intervals cannot carry a projection.
      staleAfterMs: 2 * cfg.pollIntervalMinutes * 60_000,
      // The value after the sensitivity preset has been applied, which is the one the pace
      // rule itself uses: the raw setting is 'custom' only, and a forecast measuring against
      // a different threshold than the verdict beside it is two rules for one window.
      minElapsedPercent: effectivePace(readPaceConfig(cfg)).minElapsedPercent,
    }
  }

  function scanContext(): ScanContext {
    return {
      attribution: cfg.attribution,
      projectSalt: salt,
      hashProjects: cfg.showProjectNames === 'hash',
    }
  }

  function currentRange(now: number): DayRange {
    return rangeFor(ui.range, now, readTimeConfig(cfg), agg.stats().oldestDay ?? undefined)
  }

  // --------------------------------------------------------------- rendering
  function buildVm(now: number): ViewModel {
    return buildViewModel({
      quotas,
      agg,
      history,
      cfg,
      now,
      range: currentRange(now),
      ui,
      leader: role !== 'follower',
      candidates: quotaMgr.candidates(),
      drift: quotaMgr.driftReport(),
      dataFiles: { roots: [...CLAUDE_ROOTS, ...CODEX_ROOTS], files: agg.stats().files },
      snapshotBytes,
      consent: consent.state(),
      bridge: bridgeInfo(),
      fingerprints: quotaMgr.fingerprints(),
      forecastCfg: forecastConfig(),
      scanning,
      // The accessor, not a second read: `current()` above (and in `render`) is what filled
      // it, so the card and the status-bar item describe the same mirror.
      context: quotaMgr.contextReading(),
      promptCache: quotaMgr.promptCacheReading(),
      preview: statusBar.previewActive(),
    })
  }

  /** The whole view model, and everything that follows it; true when the model was built. */
  function rebuildVm(now: number): boolean {
    let built = false
    try {
      // Whatever the reads changed up to here is in this model (1.6 L5); the next ingest reports
      // only what comes after it.
      agg.takeChanges()
      latestVm = buildVm(now)
      built = true
      // The poll follows the newest tree there is, before a view could fail on it.
      updateAgentPoll()
      dashboard.update(latestVm)
      views.refreshMarkdown()
    } catch (err) {
      // A broken view must never take the status bar down with it.
      log.error(`Building the view model failed: ${err}`)
    }
    return built
  }

  /**
   * 1.6 L5: the Agents section alone, on the last whole view model — what a change of the agent
   * tables alone needs, and what a bucket change gets at once while the rest of the page waits for
   * the next whole rebuild. The tree is built exactly as the whole model builds it; every other
   * field is the last model's, so the page's other sections compare equal and are not pushed.
   */
  function rebuildAgents(now: number): void {
    const vm = latestVm
    if (vm === undefined) return
    try {
      latestVm = { ...vm, agents: agentTreeFor({ agg, cfg, ui, now }, 'page') }
      updateAgentPoll()
      dashboard.update(latestVm)
      views.refreshMarkdown()
    } catch (err) {
      log.error(`Building the agent tree failed: ${err}`)
    }
  }

  const cadence = new LiveCadence({ full: rebuildVm, agents: rebuildAgents })

  /** The quota readings and their forecasts for this frame; false when they could not be read. */
  function readQuotas(now: number): boolean {
    try {
      quotas = quotaMgr.current(now)
      forecasts = forecastsFor(
        quotas, history, quotaMgr.fingerprints(), forecastConfig(), now, readPaceConfig(cfg), readTimeConfig(cfg),
      )
      return true
    } catch (err) {
      log.error(`Reading the current quota failed: ${err}`)
      return false
    }
  }

  function drawStatusBar(now: number): void {
    try {
      const tree = latestVm?.agents
      const input: StatusInput = {
        quotas, agg, cfg, now, forecasts, role, scanning, consent: consent.state(),
        context: quotaMgr.contextReading(),
        promptCache: quotaMgr.promptCacheReading(),
        budgets: latestVm?.budgets ?? [],
        // 1.6 O1: the running agents of the newest tree there is — the same count the running
        // list's heading and the poll read. No tree, no entry.
        agents: tree ? { running: tree.running, now: tree.runningNow, more: tree.runningMore } : null,
      }
      statusBar.update(input)
      // Kept for the extension API (see `TokenPaceApi`): `buildItems` is pure, so re-running
      // it over this exact input reproduces what is on the bar without rendering twice per
      // second. Holding the input, not the result, is what makes a missing render visible —
      // the object still carries the `cfg` of the frame that was actually drawn.
      lastStatusInput = input
    } catch (err) {
      log.error(`Rendering the status bar failed: ${err}`)
    }
  }

  /** `force` marks an event (quota update, message, config change, a scan's end), not a tick. */
  function render(force = false): void {
    // After `dispose` a frame has nowhere to go. The status bar has disposed its items and
    // forgotten them, so this one would build new items that nothing ever disposes: entries
    // left on the bar by an extension that is gone. Work still under way at `dispose` ends
    // here without one — the agent replay's save, the cold scan, an ingest, a fetch.
    if (disposed) return
    const now = Date.now()
    const readingsOk = readQuotas(now)
    // The view model is built first so the status bar can take the budget rows from it
    // rather than deriving them a second time; `rebuildVm` swallows its own errors, so a
    // broken view still cannot take the bar down with it.
    if (force) cadence.event(now)
    else cadence.tick(now)
    if (readingsOk) drawStatusBar(now)
  }

  /**
   * 1.6 L5: the frame after an ingest, sized by what the ingest changed (`Aggregator.takeChanges`):
   * the agent tables alone rebuild the Agents section and nothing else; the buckets rebuild the
   * whole view model when the last whole one is VM_MIN_INTERVAL_MS old, else the Agents section
   * now and the rest with the next whole rebuild — the tick's, within the interval. The status bar
   * is drawn either way: its figures come from the aggregator itself.
   */
  function renderIngest(changes: IngestChanges): void {
    if (disposed) return
    const now = Date.now()
    const readingsOk = readQuotas(now)
    cadence.ingested(changes, now)
    if (readingsOk) drawStatusBar(now)
  }

  /**
   * Debug only: which source answered, and how old every candidate was.
   *
   * Ids, ages and the parsers' own problem texts — the same material the
   * data-quality section shows, and nothing that a source ever put in a number.
   */
  function logQuotaSources(): void {
    if (!log.debugEnabled) return
    const cands = quotaMgr.candidates()
    // The manager's memo makes this exactly the reading the candidate list belongs
    // to — asking for it again here does not read a file a second time.
    for (const q of quotaMgr.current()) {
      const list = (cands[q.source] ?? []).map((c) => {
        const age = c.ageSec === null ? 'no timestamp' : `${Math.round(c.ageSec)} s`
        return `${c.id} ${age}${c.ok ? '' : ` (${c.problem ?? 'no reading'})`}`
      })
      const chosen = q.ok
        ? `origin ${q.origin ?? 'unknown'}`
        : `no figure (${q.problemKind ?? 'unknown'})`
      log.debug(`Quota ${q.source}: ${chosen} — ${list.join(' · ') || 'no candidate source'}`)
    }
  }

  function bridgeInfo(): { installed: boolean; shadowed: boolean; mirrorAge: number | null } | null {
    try {
      const s = bridgeState(bridgePaths, context.globalState)
      return { installed: s.installed, shadowed: s.shadowed, mirrorAge: s.mirrorAgeMs }
    } catch {
      // The bridge state is a nicety; an unreadable settings.json is not an outage.
      return null
    }
  }

  // --------------------------------------------------------------- views
  function onMessage(m: WebviewMessage): void {
    if (m.type === 'refresh') {
      render(true)
      return
    }
    if (m.type === 'command') {
      void vscode.commands.executeCommand(m.id)
      return
    }
    // The gear of a section header: the settings editor, filtered to the settings that
    // decide what that section shows. Nothing about the view changes, so nothing is stored.
    if (m.type === 'openSectionSettings') {
      void vscode.commands.executeCommand('workbench.action.openSettings', sectionSettingsQuery(m.key))
      return
    }
    const next = applyMessage(ui, m)
    // `applyMessage` returns the same object when nothing changed — identity is the signal.
    if (next !== ui) {
      ui = next
      void context.globalState.update(UI_KEY, ui)
    }
    render(true)
  }

  const dashboard = new DashboardProvider(onMessage, say)
  context.subscriptions.push(
    // The provider too, not only its registration: a section it holds back waits on a timer.
    dashboard,
    vscode.window.registerWebviewViewProvider(DashboardProvider.viewType, dashboard, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
  )

  const views: NativeViews = registerNativeViews(context, {
    getVm: () => latestVm ?? buildVm(Date.now()),
    // The markdown document prints every node of the tree (1.6 D3), which the dashboard's
    // payload no longer carries: it is built on demand, for the moment the view model is of.
    getAgentTextTree: () => agentTreeFor({ agg, cfg, ui, now: latestVm?.now ?? Date.now() }, 'text'),
    run: (command, ...args) => vscode.commands.executeCommand(command, ...args),
    getExportInput: () => ({ agg, range: currentRange(Date.now()), cfg }),
  })

  const bridgePaths: BridgePaths = {
    settingsFile: path.join(claudeDir, 'settings.json'),
    claudeDir,
    script: context.asAbsolutePath(path.join('dist', 'statusline-bridge.js')),
    mirror: paths.mirror,
  }
  registerBridgeCommands(context, {
    memento: context.globalState,
    paths: bridgePaths,
    // Read at call time: a workspace can become trusted while the window is open.
    restricted: () => !vscode.workspace.isTrusted,
    log: say,
    // Installing or removing the bridge changes the status-line mirror, one of the
    // sources the manager reads.
    onChange: () => { quotaMgr.invalidate(); render(true) },
  })

  // --------------------------------------------------------------- scanning
  function runWorker(snapshot: Snapshot, onProgress: (done: number, total: number) => void): Promise<Snapshot> {
    const workerFile = path.join(context.extensionPath, 'dist', 'scanWorker.js')
    return new Promise((resolve, reject) => {
      const worker = new Worker(workerFile, {
        workerData: {
          snapshot,
          ctx: scanContext(),
          timeConfig: readTimeConfig(cfg),
          claudeDirs: cfg.claudeDir,
          codexDirs: cfg.codexDir,
        },
      })
      worker.on('message', (msg: { type?: string; done?: number; total?: number; snapshot?: Snapshot; message?: string }) => {
        if (msg?.type === 'progress') onProgress(msg.done ?? 0, msg.total ?? 0)
        else if (msg?.type === 'done') { resolve(msg.snapshot as Snapshot); void worker.terminate() }
        else if (msg?.type === 'error') { reject(new Error(msg.message ?? 'worker error')); void worker.terminate() }
      })
      worker.on('error', reject)
      worker.on('exit', (code) => { if (code !== 0) reject(new Error(`Worker exited with code ${code}`)) })
    })
  }

  async function coldScan(onProgress: (done: number, total: number) => void = () => {}): Promise<void> {
    scanning = true
    // 1.6 L5 (§7c, Review 1 #2): a scan that starts with no cursor at all — the first start, a
    // re-read, a switch of the attribution — reads every line from the first byte through this
    // build's readers, so the agent tables it leaves are of this build's revision already, and the
    // replay after it would only read the same lines again, the tree half built meanwhile. It is
    // marked so, and the replay runs only after a stored state that was read on from its cursors.
    const fromNothing = agg.cursors.size === 0
    try {
      const snapshot = await runWorker(agg.toSnapshot(), onProgress)
      agg = Aggregator.fromSnapshot(snapshot, cfg.attribution)
      agg.timeConfig = readTimeConfig(cfg)
      if (fromNothing) agg.agentsRevision = AGENT_TABLES_REVISION
      log.info(`Cold start done: ${snapshot.buckets.length} bucket(s), ${Object.keys(snapshot.cursors).length} file(s)`)
    } catch (err) {
      log.error(`Cold start in the worker failed, falling back to the main thread: ${err}`)
      const target = agg
      const done = await scan(target, { ctx: scanContext() }).then(() => true, (e) => {
        log.error(`The fallback failed too: ${e}`)
        return false
      })
      // Only a scan that read everything leaves whole tables; one that failed half-way is replayed.
      if (fromNothing && done && target === agg) target.agentsRevision = AGENT_TABLES_REVISION
    } finally {
      scanning = false
      dirty = true
      // The scan may have read newer Codex rate limits out of the transcripts; a memoised
      // reading taken before it would show "unavailable" for up to five seconds.
      quotaMgr.invalidate()
    }
  }

  let ingestTimer: ReturnType<typeof setTimeout> | undefined

  function scheduleIngest(file?: string): void {
    // A follower leaves the transcripts to the leader, and after `dispose` no timer is armed.
    if (!readsTranscripts()) return
    if (file) pendingFiles.add(file)
    if (ingestTimer) return
    ingestTimer = setTimeout(() => {
      ingestTimer = undefined
      // The cold scan reads every file anyway; the sweep picks up whatever arrives meanwhile.
      // The agent replay hands the files that waited for it back when it ends.
      if (scanning || ingesting || replayRun !== null || role === 'follower') return
      const files = pendingFiles.size > 0 ? [...pendingFiles] : undefined
      pendingFiles.clear()
      ingesting = true
      const target = agg
      const skippedBefore = target.journalSkipped
      void scan(target, { files, ctx: scanContext() })
        .then((n) => {
          // Counts only — a line is never logged, in no mode and to no sink. A journal line too
          // long to be read without its head is skipped (1.6 §0a.1), and only counted here.
          const skipped = target.journalSkipped - skippedBefore
          log.debug(`Ingest: ${files ? `${files.length} changed file(s)` : 'every known file'}`
            + ` → ${n} counted line(s)${skipped > 0 ? `, ${skipped} journal line(s) skipped` : ''}`)
          // A counted Codex line can carry a fresh rate-limit block — same memo rule as the cold scan.
          // What the lines changed decides how much of the page is rebuilt (1.6 L5).
          if (n > 0) { dirty = true; quotaMgr.invalidate(); renderIngest(target.takeChanges()) }
        })
        .catch((err) => log.error(`Ingest failed: ${err}`))
        .finally(() => {
          ingesting = false
          // A replay that found this ingest in its way runs now.
          void replayAgentTables('deferred')
        })
    }, INGEST_DEBOUNCE_MS)
  }

  function rollup(now: number): void {
    // Never while data is moving: a roll-up folds hour buckets a running ingest still writes to,
    // and prunes the agent tables a replay is rebuilding.
    if (scanning || ingesting || replayRun !== null || role === 'follower') return
    try {
      const r = agg.rollup(now, cfg.hourRetentionDays, cfg.retentionDays, readTimeConfig(cfg))
      if (r.hoursMerged > 0 || r.daysMerged > 0) {
        log.info(`Roll-up: ${r.hoursMerged} hour bucket(s) and ${r.daysMerged} day bucket(s) merged`)
      } else {
        log.debug('Roll-up: 0 hour bucket(s) and 0 day bucket(s) merged')
      }
      dirty = true
    } catch (err) {
      log.error(`Roll-up failed: ${err}`)
    }
  }

  // --------------------------------------------------------------- agents
  /**
   * The hot-directory poll: while the tree shows an agent at work, the agent directories of
   * every active session are listed every AGENT_POLL_MS and each new or changed file goes to
   * the ingest like a watcher event. It follows the view model (`updateAgentPoll` after every
   * rebuild), so it stops by itself once nothing runs; a follower never polls.
   */
  const agentPoll = new AgentPoll(pollAgentFiles)

  /** Asked again after every wait: the lease can change hands while a pass or a replay runs. */
  function readsTranscripts(): boolean {
    return role !== 'follower' && !disposed
  }

  function updateAgentPoll(): void {
    const wanted = readsTranscripts() && agentPollWanted(latestVm?.agents)
    if (!agentPoll.set(wanted)) return
    // Counts only, like every line about transcripts.
    log.debug(wanted
      ? `Agent poll: on, every ${AGENT_POLL_MS / 1000} s — ${latestVm?.agents.running ?? 0} running agent(s)`
      : 'Agent poll: off')
  }

  async function pollAgentFiles(): Promise<void> {
    // Not while a scan or the replay moves the records the pass reads its sessions from.
    if (scanning || replayRun !== null || !readsTranscripts()) return
    try {
      const found = await agentPollFiles(agg, Date.now())
      if (!readsTranscripts() || found.changed.length === 0) return
      for (const file of found.changed) scheduleIngest(file)
      log.debug(`Agent poll: ${found.changed.length} of ${found.listed} agent file(s) changed`
        + ` in ${found.sessions} active session(s)`)
    } catch (err) {
      // Best effort by design — the sweep finds within the minute whatever a pass missed.
      log.debug(`Agent poll: a pass failed (${errorKind(err)})`)
    }
  }

  /**
   * The one-time replay of the agent tables. A snapshot written by a build without them
   * (version 6), or without a table this build fills from lines already read — the workflow
   * runs of version 8 —, holds cursors past every line its transcripts had, so the ingest alone
   * would give the tree only what is written from now on; `replayAgents` reads the Claude
   * transcripts and journals of the agent retention once more, up to what was counted, for the
   * agent tables and nothing else. Due whenever this aggregator's tables are not of the current
   * revision (AGENT_TABLES_REVISION) — after a cold start that read on from a stored state of an
   * older revision, after an update that raised it; not after a scan that started with no cursor
   * at all, which read every line itself (1.6 L5, `coldScan`) — and never while a scan or an ingest
   * moves the data, nor in a follower,
   * which renders the leader's tables. A replay that had to wait is retried when the next ingest
   * ends (the sweep brings one every minute). Counts and a duration are logged; never a path or
   * a line.
   */
  function replayAgentTables(why: 'cold start' | 're-read' | 'deferred'): Promise<void> {
    if (replayRun) return replayRun
    if (!readsTranscripts() || replayFailed || scanning || ingesting || agg.agentsRevision === AGENT_TABLES_REVISION) {
      return Promise.resolve()
    }
    const target = agg
    const started = Date.now()
    replayRun = (async () => {
      try {
        const files = agentReplayFiles(target, started)
        const skippedBefore = target.journalSkipped
        const changed = await replayAgents(target, files, scanContext())
        target.agentsRevision = AGENT_TABLES_REVISION
        const skipped = target.journalSkipped - skippedBefore
        log.info(`Agent replay (${why}): ${files.length} file(s) read again, ${changed} change(s),`
          + ` ${Date.now() - started} ms${skipped > 0 ? `, ${skipped} journal line(s) skipped` : ''}`)
        // A re-read or a lost lease can have put another aggregator in place meanwhile; this
        // one is gone then, and there is nothing of it to save or show.
        if (target !== agg || !readsTranscripts()) return
        dirty = true
        // A save already under way wrote the state before the replay ended: the timed save
        // takes this one, as `dirty` stays set.
        if (!saving) {
          dirty = false
          await saveState()
        }
        render(true)
      } catch (err) {
        replayFailed = true
        log.error(`Agent replay failed (${errorKind(err)}); it is tried again on the next start.`)
      }
    })().finally(() => {
      replayRun = null
      // What the watcher and the poll reported meanwhile waited for the replay.
      if (!disposed && pendingFiles.size > 0) scheduleIngest()
    })
    return replayRun
  }

  // --------------------------------------------------------------- persistence
  async function saveState(): Promise<void> {
    // After `dispose` the exit save has written the state and the lease is given up: a save
    // started now could only race that one, or overwrite the file of the window that leads next.
    if (role === 'follower' || saving || disposed) return
    saving = true
    const tmp = `${paths.state}.tmp`
    try {
      await fs.promises.writeFile(tmp, JSON.stringify(agg.toSnapshot()))
      // `dispose` came while the file was written: the exit save has put a newer state in
      // place, and this older one must not replace it.
      if (disposed) {
        await fs.promises.rm(tmp, { force: true }).catch(() => undefined)
        return
      }
      await fs.promises.rename(tmp, paths.state)
      snapshotBytes = fileSize(paths.state)
    } catch (err) {
      log.warn(`Could not persist the snapshot: ${err}`)
    } finally {
      saving = false
    }
  }

  function saveStateSync(): void {
    if (role === 'follower') return
    // A temp file of its own: a save still under way writes `state.json.tmp`, and two writers
    // on one file can leave the start of one snapshot in front of the end of the other.
    const tmp = `${paths.state}.exit.tmp`
    try {
      fs.writeFileSync(tmp, JSON.stringify(agg.toSnapshot()))
      fs.renameSync(tmp, paths.state)
    } catch {
      // On the way out there is nothing left to report to.
    }
  }

  // --------------------------------------------------------------- watchers
  const transcriptWatchers: fs.FSWatcher[] = []
  const followerWatchers: fs.FSWatcher[] = []
  let quotaWatchers: fs.FSWatcher[] = []
  let credentialsWatcher: { dispose(): void } | null = null
  let sweepTimer: ReturnType<typeof setInterval> | undefined
  let followerTimer: ReturnType<typeof setTimeout> | undefined
  let quotaFileTimer: ReturnType<typeof setTimeout> | undefined

  function closeAll(list: fs.FSWatcher[]): void {
    for (const w of list) {
      try { w.close() } catch { /* already closed */ }
    }
    list.length = 0
  }

  function watchTranscripts(): void {
    if (transcriptWatchers.length > 0) return
    for (const root of [...CLAUDE_ROOTS, ...CODEX_ROOTS]) {
      try {
        const w = fs.watch(root, { recursive: true }, (_event, name) => {
          if (!name || !String(name).endsWith('.jsonl')) return
          scheduleIngest(path.join(root, String(name)))
        })
        w.on('error', (e) => log.warn(`Watcher on ${root} disturbed: ${e}`))
        transcriptWatchers.push(w)
      } catch (err) {
        log.warn(`No watcher on ${root} (${err}) — falling back to the periodic sweep.`)
      }
    }
    // Safety net: on Linux fs.watch loses events for new subdirectories and for atomic
    // replacement. Silent undercounting is the worst failure mode for a counting tool.
    if (!sweepTimer) sweepTimer = setInterval(() => { pendingFiles.clear(); scheduleIngest() }, SWEEP_MS)
  }

  function stopTranscriptWatchers(): void {
    closeAll(transcriptWatchers)
    if (sweepTimer) { clearInterval(sweepTimer); sweepTimer = undefined }
  }

  /** Watches the directory rather than the file: an atomic replace breaks a file watch. */
  function watchFiles(files: string[], onChange: () => void): fs.FSWatcher[] {
    const byDir = new Map<string, Set<string>>()
    for (const file of files) {
      if (!file) continue
      const dir = path.dirname(file)
      const set = byDir.get(dir) ?? new Set<string>()
      set.add(path.basename(file))
      byDir.set(dir, set)
    }
    const out: fs.FSWatcher[] = []
    for (const [dir, names] of byDir) {
      try {
        const w = fs.watch(dir, (_event, name) => {
          if (!name || !names.has(path.basename(String(name)))) return
          onChange()
        })
        w.on('error', () => { /* a vanished directory is covered by the periodic tick */ })
        out.push(w)
      } catch {
        // The directory does not exist yet — the tick keeps re-reading anyway.
      }
    }
    return out
  }

  function watchQuotaFiles(): void {
    closeAll(quotaWatchers)
    quotaWatchers = watchFiles(
      [CLAUDE_QUOTA_FILE, CODEX_QUOTA_FILE, paths.mirror, claudeJsonFile],
      () => {
        if (quotaFileTimer) return
        quotaFileTimer = setTimeout(() => {
          quotaFileTimer = undefined
          // The manager may replay a reading for a few seconds; one of the files it
          // read has just changed, so that answer is now the older one.
          quotaMgr.invalidate()
          render(true)
          logQuotaSources()
        }, QUOTA_FILE_DEBOUNCE_MS)
      },
    )
  }

  function ensureCredentialsWatcher(): void {
    // Only ever touched in `poll` mode after consent — the file holds the access token.
    const wanted = role !== 'follower' && cfg.quotaSource === 'poll' && consent.granted()
    if (wanted && !credentialsWatcher) {
      credentialsWatcher = watchCredentials(cfg.claudeDir[0] || undefined, () => {
        log.info('Claude credentials changed — re-checking the quota.')
        quotaMgr.forcePoll(onQuotaUpdate)
      })
    } else if (!wanted && credentialsWatcher) {
      credentialsWatcher.dispose()
      credentialsWatcher = null
    }
  }

  function followerReload(): void {
    agg = Aggregator.fromSnapshot(loadSnapshot(paths.state), cfg.attribution)
    agg.timeConfig = readTimeConfig(cfg)
    snapshotBytes = fileSize(paths.state)
    history.load()
    // The leader has just written; whatever the manager last read is one step behind.
    quotaMgr.invalidate()
    render(true)
  }

  function watchSharedFiles(): void {
    if (followerWatchers.length > 0) return
    followerWatchers.push(...watchFiles([paths.state, paths.quota, paths.history], () => {
      if (followerTimer) clearTimeout(followerTimer)
      followerTimer = setTimeout(() => { followerTimer = undefined; followerReload() }, FOLLOWER_DEBOUNCE_MS)
    }))
  }

  function stopSharedFileWatchers(): void {
    closeAll(followerWatchers)
    if (followerTimer) { clearTimeout(followerTimer); followerTimer = undefined }
  }

  // --------------------------------------------------------------- roles
  function becomeLeader(): void {
    stopSharedFileWatchers()
    watchTranscripts()
    ensureCredentialsWatcher()
    // Whatever arrived while another window led is read now, from the stored cursors.
    scheduleIngest()
  }

  function becomeFollower(): void {
    stopTranscriptWatchers()
    // The role is already set: this stops the poll, and the view model built below keeps it off.
    updateAgentPoll()
    ensureCredentialsWatcher()
    watchSharedFiles()
    followerReload()
  }

  function setRole(next: Role): void {
    if (roleWired && next === role) return
    const before = role
    role = next
    roleWired = true
    quotaMgr.setLeader(role !== 'follower')
    if (role === 'follower') becomeFollower()
    else becomeLeader()
    if (before !== next) {
      log.info(`Role: ${before} → ${next}`)
      log.debug(`Role change ${before} → ${next}: this window ${next === 'follower'
        ? 'renders the shared files and neither reads transcripts nor fetches'
        : 'reads the transcripts, fetches and writes the shared files'}`)
    }
  }

  let lease: Lease | null = cfg.leaderElection ? new Lease(paths.leader, undefined, say) : null

  function updateRole(): void {
    if (!lease) {
      setRole('single')
      return
    }
    // `tryAcquire` renews when the record is already ours, so this is both paths at once.
    const mine = lease.tryAcquire()
    if (log.debugEnabled) {
      const h = lease.holder()
      const left = h ? `, expires in ${Math.round((h.expiresAt - Date.now()) / 1000)} s` : ''
      log.debug(`Lease: ${mine ? 'held by this window' : `held by pid ${h?.pid ?? 'unknown'}`}${left}`)
    }
    setRole(mine ? 'leader' : 'follower')
  }

  // --------------------------------------------------------------- quota
  function onQuotaUpdate(): void {
    // A fetch under way at `dispose` still reports back: no frame, and no alert either.
    if (disposed) return
    // A finished fetch, a changed credential file, a push: the memoised reading in
    // the manager describes the state before all of that.
    quotaMgr.invalidate()
    render(true)
    logQuotaSources()
    runAlerts(Date.now())
  }

  function runAlerts(now: number): void {
    if (role === 'follower') return
    const paceCfg = readPaceConfig(cfg)
    const verdicts = new Map<string, PaceVerdict>()
    for (const q of quotas) {
      for (const w of q.windows) {
        verdicts.set(
          `${q.source}:${w.id}`,
          paceVerdict(w.percent, windowElapsed(w.resetsAt, w.windowMinutes, now), paceCfg),
        )
      }
    }
    // A budget is measured on the local buckets, so a half-read history would announce a
    // share that is only going to rise. The rows are the view model's own — one derivation.
    const budgets = scanning ? [] : latestVm?.budgets ?? []
    void alerts.evaluate(quotas, verdicts, forecasts, now, budgets)
      .then((decisions) => {
        for (const d of decisions) {
          log.info(`Alert (${d.kind}, ${d.source}): ${d.message}`)
          if (d.command) void vscode.commands.executeCommand(d.command)
        }
      })
      .catch((err) => log.warn(`Alert evaluation failed: ${err}`))
  }

  async function ensureWriteConsent(): Promise<void> {
    if (!cfg.writeQuotaCache || writeConsent.granted() || writeConsentAsked) return
    writeConsentAsked = true
    if (await writeConsent.request()) quotaMgr.setOptions(quotaOptions(cfg))
  }

  /**
   * Offered at most once per machine, and only when there is genuinely nothing to show:
   * no quota anywhere, mode `auto`, question never put. Anyone who already gets numbers
   * from an external poller is never asked at all.
   */
  async function offerFetchOnce(): Promise<void> {
    if (cfg.quotaSource !== 'auto') return
    if (consent.state() !== 'unasked' || consent.offered()) return
    if (quotas.some((q) => q.ok)) return
    await consent.markOffered()
    const showWhatIsSent = t('Show what is sent')
    const pick = await vscode.window.showInformationMessage(
      t('No quota data found. Token Pace can fetch it from the provider — that needs your Claude Code access token.'),
      showWhatIsSent,
      t('Not now'),
    )
    if (pick !== showWhatIsSent) return
    if (!(await consent.request())) return
    await vscode.workspace.getConfiguration('tokenPace')
      .update('quotaSource', 'poll', vscode.ConfigurationTarget.Global)
    cfg = readConfig()
    quotaMgr.setOptions(quotaOptions(cfg))
    ensureCredentialsWatcher()
    quotaMgr.forcePoll(onQuotaUpdate)
  }

  async function fetchNow(): Promise<void> {
    cfg = readConfig()
    quotaMgr.setOptions(quotaOptions(cfg))
    // Asking here rather than in the manager keeps the fetch path free of UI: the command is
    // the one place where the user is present and waiting.
    if (quotaMgr.blocked() === 'consent' && !(await consent.request())) {
      void vscode.window.showInformationMessage(
        t('Quota is not fetched. Run "Token Pace: Reset Network Access Decision" to be asked again.'),
      )
      return
    }
    if (lease && role === 'follower') {
      if (lease.tryAcquire()) {
        log.info('Lease taken over for a manual fetch.')
        setRole('leader')
      } else {
        // "In doubt, poll yourself": the user asked, and one extra request beats a stale figure.
        log.info('Another window holds the lease — fetching once anyway on explicit request.')
      }
    }
    quotaMgr.forcePoll(onQuotaUpdate)
  }

  // --------------------------------------------------------------- first run / remote
  /**
   * Remote, WSL or SSH: the extension runs on one side of the connection and the
   * transcripts are on the other, so there is nothing to read and nothing wrong.
   *
   * Asked at most once per machine, and only when there is genuinely nothing: a
   * hint that repeats itself would be worse than the empty view it explains. The
   * offer is the actual fix rather than a pointer at the documentation —
   * `remote.extensionKind` is the one setting that decides the side, and it takes
   * effect only after a reload, which is why the reload comes with it.
   */
  async function remoteHint(): Promise<void> {
    if (agg.stats().files !== 0) return
    const remote = vscode.env.remoteName
    if (!remote) return
    if (context.globalState.get<boolean>(REMOTE_HINT_KEY, false)) return
    // Remembered before the dialog is shown: a question closed unanswered was still asked,
    // and "Not now" must be as final as any other answer.
    await context.globalState.update(REMOTE_HINT_KEY, true)
    // The one-click fix, and the buttons it is compared with — the same values, once.
    const moveHere = t('Run Token Pace locally')
    const openSettings = t('Open Settings')
    const pick = await vscode.window.showInformationMessage(
      t(
        'Token Pace found no Claude Code or Codex transcripts on this host (remote "{0}"). The extension runs on one side of the connection only. If your transcripts are on the local machine, Token Pace can be moved there (one click writes "remote.extensionKind" into your user settings and offers a reload); if they are on this host, point tokenPace.claudeDir / tokenPace.codexDir at them.',
        remote,
      ),
      moveHere,
      openSettings,
      t('Not now'),
    )
    if (pick === openSettings) {
      void vscode.commands.executeCommand('tokenPace.openSettings')
      return
    }
    if (pick === moveHere) await runLocally()
  }

  /**
   * Writes `remote.extensionKind` for this extension into the user settings.
   *
   * Merged into whatever is already there: the setting is a map that other
   * extensions share, and replacing it wholesale would move them too.
   */
  async function runLocally(): Promise<void> {
    const config = vscode.workspace.getConfiguration()
    // The user's own value, not the merged one: merging would copy VS Code's defaults and any
    // workspace entry into the user settings file, which is not what the click asked for.
    const own = config.inspect<Record<string, unknown>>('remote.extensionKind')?.globalValue
    const merged = { ...(own !== null && typeof own === 'object' ? own : {}), [EXTENSION_ID]: ['ui'] }
    try {
      await config.update('remote.extensionKind', merged, vscode.ConfigurationTarget.Global)
    } catch (err) {
      log.warn(`remote.extensionKind could not be written: ${err}`)
      void vscode.window.showWarningMessage(
        t('Token Pace: "remote.extensionKind" could not be written. Set it by hand in your user settings.'),
      )
      return
    }
    log.info(`remote.extensionKind set: "${EXTENSION_ID}": ["ui"].`)
    const reloadWindow = t('Reload Window')
    const reload = await vscode.window.showInformationMessage(
      t('Token Pace will run on the local machine after a window reload.'),
      reloadWindow,
      t('Later'),
    )
    if (reload === reloadWindow) void vscode.commands.executeCommand('workbench.action.reloadWindow')
  }

  // --------------------------------------------------------------- commands
  async function showDashboard(): Promise<void> {
    if (cfg.dashboard.mode === 'quickPick') {
      await vscode.commands.executeCommand('tokenPace.showUsageQuickPick')
      return
    }
    if (cfg.dashboard.mode === 'markdown') {
      await vscode.commands.executeCommand('tokenPace.showUsageMarkdown')
      return
    }
    await vscode.commands.executeCommand('tokenPace.dashboard.focus')
  }

  async function rescan(): Promise<void> {
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: t('Token Pace: re-reading token history …') },
      async () => {
        // A replay still at work belongs to the aggregator about to be dropped: it ends first,
        // so that the replay below is this re-read's own.
        if (replayRun) await replayRun
        agg = Aggregator.fromSnapshot(undefined, cfg.attribution)
        agg.timeConfig = readTimeConfig(cfg)
        await coldScan()
        rollup(Date.now())
        // The re-read fed the agent tables from its own lines, every one from the first byte, and
        // marked them of this build's revision (1.6 L5): the replay below has nothing to do then.
        // It stays for a re-read whose scan failed half-way, whose tables are not whole.
        await replayAgentTables('re-read')
        await saveState()
        render(true)
      },
    )
  }

  async function copyDiagnostics(): Promise<void> {
    const home = os.homedir()
    const stats = agg.stats()
    const hist = history.size()
    const tcfg = readTimeConfig(cfg)
    const candidates = quotaMgr.candidates()
    const drift = quotaMgr.driftReport()
    const net = cfg.diagnostics.includeNetworkSetup
    const quota: QuotaDiag[] = SOURCES.map((source) => ({
      source,
      candidates: (candidates[source] ?? []).map((c) => ({
        id: c.id, ok: c.ok, ageSec: c.ageSec, problem: c.problem ?? null,
      })),
      backoffEndsAt: quotas.find((q) => q.source === source)?.nextAttemptAt ?? null,
      drift: [...(drift[source] ?? [])],
    }))

    const input: DiagnosticsInput = {
      extVersion: __EXT_VERSION__,
      vscodeVersion: vscode.version,
      platform: process.platform,
      arch: process.arch,
      node: process.versions.node,
      remoteName: vscode.env.remoteName ?? null,
      extensionKind: extensionKindName(),
      // Never a transcript path, and never an unshortened home directory.
      roots: [...CLAUDE_ROOTS, ...CODEX_ROOTS].map((r) => tildify(r, home)),
      fileCount: stats.files,
      snapshot: {
        buckets: { h: stats.hourBuckets, d: stats.dayBuckets, m: stats.monthBuckets },
        bytes: snapshotBytes,
        oldestDay: stats.oldestDay,
        newestDay: stats.newestDay,
        firstIngest: agg.firstIngest !== null ? dayOf(agg.firstIngest, tcfg) : null,
      },
      retention: { hourDays: cfg.hourRetentionDays, days: cfg.retentionDays, historyDays: cfg.quotaHistoryDays },
      historySize: { samples: hist.samples, bytes: hist.bytes, oldest: hist.oldest === null ? null : dayOf(hist.oldest, tcfg) },
      quota,
      consent: consent.state(),
      role,
      bridge: bridgeDiag(),
      http: net ? collectHttpSettings(vscode) : NO_HTTP,
      proxyEnv: net ? collectProxyEnv() : [],
      settings: collectSettings(vscode, CONFIG_KEYS),
      partialData: scanning || quotas.some((q) => q.partial === true),
      attribution: cfg.attribution,
      home,
    }
    await vscode.env.clipboard.writeText(buildDiagnostics(input))
    void vscode.window.showInformationMessage(
      t('Token Pace: diagnostics copied. They contain no token, no transcript content and no full paths.'),
    )
  }

  /**
   * D11: the whole id of the node whose details are open — an agent id, a launch's tool_use id,
   * a run's id or a session's id, as the ID row shows it — onto the clipboard, and nothing else.
   * The details the page shows are the ones of the last view model, so the id copied is the one
   * on screen. Nothing selected: one line that says where to select, and the clipboard is left
   * as it was.
   */
  async function copyAgentId(): Promise<void> {
    const id = latestVm?.agents?.selected?.id ?? null
    if (typeof id !== 'string' || id === '') {
      void vscode.window.showInformationMessage(t('Select a node in the Agents section first.'))
      return
    }
    await vscode.env.clipboard.writeText(id)
    void vscode.window.showInformationMessage(t('Token Pace: ID copied to the clipboard.'))
  }

  function bridgeDiag(): DiagnosticsInput['bridge'] {
    const b = bridgeInfo()
    return b === null ? null : { installed: b.installed, shadowed: b.shadowed, mirrorAgeMs: b.mirrorAge }
  }

  async function clearStoredData(): Promise<void> {
    const stats = agg.stats()
    const hist = history.size()
    const home = os.homedir()
    // Only a file we were actually allowed to write is ours to offer for deletion:
    // without the opt-in the path may well hold another tool's cache.
    const external = writeConsent.state() === 'granted' ? externalQuotaFiles() : []
    const items = inventory({ ...paths, externalQuota: external }, context.globalState, {
      state: t('{0} file(s) · {1} … {2}', stats.files, stats.oldestDay ?? '–', stats.newestDay ?? '–'),
      history: t('{0} quota sample(s)', hist.samples),
      externalQuota: external.map((f) => tildify(f, home)).join(' · '),
      ui: t('range, sort and filters of the dashboard'),
      consent: t('network and write decisions'),
    })
    const picks: Array<vscode.QuickPickItem & { key?: StoredKey }> = items.map((i) => ({
      label: i.label,
      description: formatBytes(i.bytes),
      detail: i.detail ?? undefined,
      key: i.key,
    }))
    // Not an item to delete but the sentence that stops a wrong conclusion: the
    // mirror file is deletable, the settings.json entry that feeds it is not.
    const bridge = bridgeInfo()
    if (bridge?.installed === true) {
      picks.push(
        { label: t('Status line bridge'), kind: vscode.QuickPickItemKind.Separator },
        { label: `$(warning) ${t('The Claude status line is still connected')}`, detail: bridgeBlocksDelete() },
      )
    }
    const chosen = await vscode.window.showQuickPick(picks, {
      canPickMany: true,
      title: t('Token Pace — clear stored data'),
      placeHolder: t('Pick what to delete'),
    })
    if (!chosen || chosen.length === 0) return
    const keys = chosen.map((c) => c.key).filter((k): k is StoredKey => k !== undefined)
    // The bridge line is pickable in some hosts; picking only it deletes nothing.
    if (keys.length === 0) return
    const detail = keys.includes('externalQuota')
      ? `${deleteWarning()}\n\n${deleteWarningExternal()}`
      : deleteWarning()
    const deleteLabel = t('Delete')
    const confirm = await vscode.window.showWarningMessage(
      t('Delete {0} stored item(s)? This cannot be undone.', keys.length),
      { modal: true, detail },
      deleteLabel,
    )
    if (confirm !== deleteLabel) return

    const result = await deleteItems(keys, { ...paths, externalQuota: external }, context.globalState, say)
    if (result.deleted.includes('history')) history.clear()
    if (result.deleted.includes('quota')) quotaMgr.clearPolled()
    if (result.deleted.includes('ui')) ui = defaultUiState(cfg)
    if (result.failed.length > 0) {
      void vscode.window.showWarningMessage(t('Token Pace: could not delete {0}.', result.failed.join(', ')))
    }
    if (result.deleted.includes('state')) {
      dirty = false
      await rescan()
    } else {
      render(true)
    }
  }

  async function openUsagePage(arg?: unknown): Promise<void> {
    let source: Source | null = SOURCES.some((s) => s === arg) ? (arg as Source) : null
    if (source === null) {
      const pick = await vscode.window.showQuickPick(
        ADAPTERS.map((a) => ({ label: a.title, description: a.usagePageUrl, value: a.id })),
        { title: t('Open the official usage page'), placeHolder: t('Pick a provider') },
      )
      if (!pick) return
      source = pick.value
    }
    await vscode.env.openExternal(vscode.Uri.parse(USAGE_PAGE[source]))
  }

  async function cycleWindowSelect(): Promise<void> {
    const at = WINDOW_SELECT_CYCLE.indexOf(cfg.windowSelect)
    const next = WINDOW_SELECT_CYCLE[(at + 1) % WINDOW_SELECT_CYCLE.length]
    await vscode.workspace.getConfiguration('tokenPace')
      .update('windowSelect', next, vscode.ConfigurationTarget.Global)
    void vscode.window.showInformationMessage(t('Token Pace: status bar windows — {0}.', next))
  }

  function setRange(arg?: unknown): void {
    let message: WebviewMessage | null = null
    if (typeof arg === 'string' && (RANGE_PRESETS as string[]).includes(arg)) {
      message = { type: 'setRange', preset: arg as RangePreset }
    } else if (isRecord(arg) && typeof arg.from === 'string' && typeof arg.to === 'string') {
      message = { type: 'setRange', from: arg.from, to: arg.to }
    }
    if (!message) return
    onMessage(message)
  }

  context.subscriptions.push(
    vscode.commands.registerCommand('tokenPace.showDashboard', showDashboard),
    vscode.commands.registerCommand('tokenPace.menu', () =>
      showMenu(
        { role, consent: consent.state(), cfg, quotas },
        (command, ...args) => vscode.commands.executeCommand(command, ...args),
      ),
    ),
    vscode.commands.registerCommand('tokenPace.rescan', rescan),
    vscode.commands.registerCommand('tokenPace.showOutput', () => log.show()),
    vscode.commands.registerCommand('tokenPace.refreshQuota', fetchNow),
    vscode.commands.registerCommand('tokenPace.resetNetworkConsent', async () => {
      await consent.reset()
      ensureCredentialsWatcher()
      void vscode.window.showInformationMessage(
        t('Token Pace: network access decision reset. The next quota fetch will ask again.'),
      )
      render(true)
    }),
    vscode.commands.registerCommand('tokenPace.openSettings', () =>
      vscode.commands.executeCommand('workbench.action.openSettings', `@ext:${EXTENSION_ID}`),
    ),
    vscode.commands.registerCommand('tokenPace.openUsagePage', openUsagePage),
    vscode.commands.registerCommand('tokenPace.cycleWindowSelect', cycleWindowSelect),
    vscode.commands.registerCommand('tokenPace.copyDiagnostics', copyDiagnostics),
    vscode.commands.registerCommand('tokenPace.copyAgentId', copyAgentId),
    vscode.commands.registerCommand('tokenPace.clearStoredData', clearStoredData),
    vscode.commands.registerCommand('tokenPace.previewStatusBar', () => {
      statusBar.preview(readConfig())
      render(true)
    }),
    vscode.commands.registerCommand('tokenPace.setRange', setRange),
  )

  // --------------------------------------------------------------- events
  context.subscriptions.push(
    vscode.window.onDidChangeWindowState((state) => quotaMgr.setFocused(state.focused, onQuotaUpdate)),

    vscode.workspace.onDidChangeConfiguration((e) => {
      if (!affects(e, ['tokenPace'])) return
      const before = cfg
      cfg = readConfig()

      log.configure(cfg.debug, cfg.debugLogFile)
      agg.timeConfig = readTimeConfig(cfg)
      quotaMgr.setOptions(quotaOptions(cfg))
      alerts.setConfig(readAlertConfig(cfg))
      alerts.setStaleAfterMs(cfg.staleAfterMinutes * 60_000)
      history.setRetentionDays(cfg.quotaHistoryDays)
      ensureCredentialsWatcher()

      if (cfg.claudeQuotaFile !== before.claudeQuotaFile || cfg.codexQuotaFile !== before.codexQuotaFile) {
        configureQuotaFiles(cfg.claudeQuotaFile, cfg.codexQuotaFile)
        watchQuotaFiles()
        log.info(`Quota files: ${CLAUDE_QUOTA_FILE} | ${CODEX_QUOTA_FILE}`)
      }

      // The roots carry every cursor and every watcher; rebinding them live would silently
      // mix two histories, so this one asks rather than guesses.
      if (!sameList(cfg.claudeDir, before.claudeDir) || !sameList(cfg.codexDir, before.codexDir)) {
        const reloadWindow = t('Reload Window')
        void vscode.window.showInformationMessage(
          t('Token Pace: the transcript directories changed. Reload the window to read them.'),
          reloadWindow,
        ).then((pick) => {
          if (pick === reloadWindow) void vscode.commands.executeCommand('workbench.action.reloadWindow')
        })
      }

      if (cfg.leaderElection !== before.leaderElection) {
        if (cfg.leaderElection) {
          lease = new Lease(paths.leader, undefined, say)
        } else {
          lease?.release()
          lease = null
        }
        updateRole()
      }

      // Session records can only come from a re-read; switching them off just drops the table.
      const attributionOn = before.attribution === 'none' && cfg.attribution !== 'none'
      // Project labels are stored, not derived when they are shown: a switch between
      // basenames and salted hashes reaches only the records that are read again, so
      // it needs the same cold re-read — otherwise the table would mix both forms.
      const labelsChanged = cfg.attribution !== 'none'
        && cfg.showProjectNames !== before.showProjectNames
      if (attributionOn || labelsChanged) {
        log.info(attributionOn
          ? `Attribution switched to "${cfg.attribution}" — re-reading the transcripts.`
          : `Project names switched to "${cfg.showProjectNames}" — re-reading the transcripts.`)
        agg = Aggregator.fromSnapshot(undefined, cfg.attribution)
        agg.timeConfig = readTimeConfig(cfg)
        void coldScan().then(() => { rollup(Date.now()); render(true); void replayAgentTables('re-read') })
      } else if (before.attribution !== 'none' && cfg.attribution === 'none') {
        agg.clearSessions()
        dirty = true
      }

      if (cfg.writeQuotaCache && !before.writeQuotaCache) void ensureWriteConsent()
      render(true)
    }),
  )

  // --------------------------------------------------------------- timers
  const timers: Array<ReturnType<typeof setInterval>> = []
  const every = (ms: number, fn: () => void): void => {
    const t = setInterval(() => {
      try { fn() } catch (err) { log.error(`Scheduled task failed: ${err}`) }
    }, ms)
    timers.push(t)
  }

  every(TICK_MS, () => render())
  every(QUOTA_TICK_MS, () => {
    cfg = readConfig()
    quotaMgr.setOptions(quotaOptions(cfg))
    quotaMgr.tick(onQuotaUpdate)
    // Most windows never fetch anything themselves, so this is the one place where
    // a debug log sees which source answered while nothing at all was going on.
    logQuotaSources()
  })
  every(LEASE_MS, updateRole)
  every(ALERT_MS, () => runAlerts(Date.now()))
  every(SAVE_MS, () => {
    // A replay saves when it is done; half of one is not worth a write. A save still under way
    // keeps the state dirty for the next tick: it would refuse this one and lose the change.
    if (!dirty || scanning || ingesting || replayRun !== null || saving) return
    // 1.6 L5: while agents run, every few seconds brings a line, and the state file is rewritten
    // at most every AGENT_SAVE_MS instead of at every tick of this timer.
    const now = Date.now()
    if (!timedSaveDue(now, lastTimedSave, agentPoll.on)) return
    lastTimedSave = now
    dirty = false
    void saveState()
  })
  every(HISTORY_SAVE_MS, () => {
    if (role === 'follower') return
    history.prune(Date.now())
    history.save()
  })
  every(ROLLUP_MS, () => rollup(Date.now()))

  // --------------------------------------------------------------- teardown
  context.subscriptions.push({
    dispose: () => {
      disposed = true
      for (const t of timers) clearInterval(t)
      agentPoll.dispose()
      if (ingestTimer) clearTimeout(ingestTimer)
      if (quotaFileTimer) clearTimeout(quotaFileTimer)
      stopTranscriptWatchers()
      stopSharedFileWatchers()
      closeAll(quotaWatchers)
      credentialsWatcher?.dispose()
      credentialsWatcher = null
      try { lease?.release() } catch { /* the record expires on its own */ }
      quotaMgr.dispose()
      try {
        history.prune(Date.now())
        history.save()
      } catch { /* a lost sample is survivable */ }
      saveStateSync()
    },
  })

  // --------------------------------------------------------------- start
  watchQuotaFiles()
  updateRole()
  // Set before the first frame so the first-run card says "reading history" rather than "empty";
  // `bootstrap` clears it again for a follower, which never scans.
  scanning = true
  render(true)

  // The cold scan is deliberately not awaited: activation must not wait for a gigabyte of
  // transcripts, and every view above already renders the "reading history" state.
  void bootstrap()

  // --------------------------------------------------------------- the extension API
  // Everything it can report has already been rendered onto the bar; see `TokenPaceApi`.
  return {
    version: __EXT_VERSION__,
    statusBar: () => (lastStatusInput === null
      ? []
      : buildItems(lastStatusInput).map((m) => ({ id: m.id, text: m.text }))),
    dashboardHtmlLength: () => dashboard.renderedHtmlLength(),
    dashboardRendered: () => dashboard.renderedCount(),
  }

  async function bootstrap(): Promise<void> {
    if (role !== 'follower') {
      const progress = vscode.window.createStatusBarItem(
        'tokenPace.scan', vscode.StatusBarAlignment.Left, 999,
      )
      context.subscriptions.push(progress)
      progress.text = `$(sync~spin) ${t('Reading token history …')}`
      progress.show()
      try {
        await coldScan((done, total) => { progress.tooltip = t('{0} of {1} files', done, total) })
      } finally {
        progress.dispose()
      }
      // Disposed while the scan ran: the exit save has stored what there was, and the rest —
      // a roll-up, a save, a frame, a fetch, a question — has no window to go to any more.
      if (disposed) return
      rollup(Date.now())
      await saveState()
      dirty = false
    } else {
      scanning = false
    }
    if (disposed) return
    render(true)
    // After the first frame, so the figures are on screen while the agent tables are rebuilt;
    // a follower renders the leader's and replays nothing.
    void replayAgentTables('cold start')
    // Fetch once right away so that without an external cache the first interval is not a wait.
    quotaMgr.tick(onQuotaUpdate)
    logQuotaSources()
    void ensureWriteConsent()
    await offerFetchOnce()
    if (disposed) return
    await remoteHint()
  }
}

export function deactivate(): void {
  // Everything is released through context.subscriptions.
}

// ---------------------------------------------------------------------------
// The hot-directory poll's two decisions — whether to run, and one timer at most — kept out
// of `activate` so a test can hold them without a window
// ---------------------------------------------------------------------------

/**
 * Whether the hot-directory poll has anything to look for: an agent or a launch the tree shows
 * as running, or a session that is active. An active session may start an agent or a workflow
 * run at any moment, and the first file of a new directory is exactly the one a recursive
 * watcher on Linux can miss — a `Workflow` call leaves no launch the tree could wait on, so
 * waiting for one would miss the run's start. A pass costs a few milliseconds. The decision reads
 * the running count and the roots' states only, never a node's children, which the page need not
 * carry. An idle session keeps nothing going: the poll lists active sessions only.
 */
export function agentPollWanted(tree: AgentTreeVm | undefined): boolean {
  if (!tree) return false
  return tree.running > 0 || tree.roots.some((r) => r.kind === 'session' && r.state === 'active')
}

/** The two timer calls the poll makes: the real ones, unless a test hands in its own. */
export interface PollTimers {
  set(fn: () => void, ms: number): unknown
  clear(handle: unknown): void
}

const REAL_TIMERS: PollTimers = {
  set: (fn, ms) => setInterval(fn, ms),
  clear: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
}

/**
 * One interval while the poll is wanted and none otherwise, however often it is asked. A pass
 * that outlasts the interval is not started a second time beside itself: the tick that meets it
 * is skipped. A pass reports its own failures; none of them reaches the timer.
 */
export class AgentPoll {
  private timer: unknown = null
  private busy = false

  constructor(
    private readonly pass: () => Promise<void>,
    private readonly everyMs = AGENT_POLL_MS,
    private readonly timers: PollTimers = REAL_TIMERS,
  ) {}

  get on(): boolean {
    return this.timer !== null
  }

  /** Starts or stops the interval to match `wanted`; true when that changed anything. */
  set(wanted: boolean): boolean {
    if (wanted === this.on) return false
    if (wanted) {
      this.timer = this.timers.set(() => this.tick(), this.everyMs)
    } else {
      this.timers.clear(this.timer)
      this.timer = null
    }
    return true
  }

  dispose(): void {
    this.set(false)
  }

  private tick(): void {
    if (this.busy) return
    this.busy = true
    void Promise.resolve()
      .then(() => this.pass())
      .catch(() => undefined)
      .finally(() => { this.busy = false })
  }
}

// ---------------------------------------------------------------------------
// The live cost (1.6 L5): which rebuild an ingest is worth, and how often the state is saved —
// kept out of `activate`, like the poll, so a test can hold them with a clock of its own
// ---------------------------------------------------------------------------

/** The two rebuilds the host can make. */
export interface RebuildSteps {
  /** The whole view model — `buildViewModel` — and everything after it; true when the model was built. */
  full(now: number): boolean
  /** The Agents section alone, on the last whole view model (`agentTreeFor`), and everything after it. */
  agents(now: number): void
}

/**
 * When the whole view model is rebuilt, and when the Agents section alone is.
 *
 * The whole model is the expensive half — every table, the chart, the heatmap — and a running
 * agent writes a line into its transcript every few seconds. Its record changes the agent tables,
 * and its reply's tokens the buckets. So: an event (a quota update, a message, a setting, a scan's
 * end) rebuilds the whole model at once, as before 1.6; the one-second tick rebuilds it once
 * VM_MIN_INTERVAL_MS have passed since the last whole rebuild, as before 1.6 — the quota
 * countdowns and every "… ago" depend on that. An ingest that changed the agent tables alone
 * rebuilds the Agents section alone. An ingest that changed the buckets rebuilds the whole model
 * when the last one is at least the interval old; otherwise the Agents section now, and the bucket
 * change is marked stale (`stale`, the host's `vmStale`) until the next whole rebuild takes it —
 * the tick's at the latest, or the next ingest's once the interval has passed.
 */
export class LiveCadence {
  private lastFull: number | null = null
  private staleFlag = false

  constructor(private readonly steps: RebuildSteps, private readonly minMs = VM_MIN_INTERVAL_MS) {}

  /** A bucket change the last whole view model does not hold yet. */
  get stale(): boolean {
    return this.staleFlag
  }

  /** An event: the whole view model, now. */
  event(now: number): void {
    this.runFull(now)
  }

  /** The one-second tick: the whole view model once the interval has passed since the last one. */
  tick(now: number): void {
    if (this.due(now)) this.runFull(now)
  }

  /** After an ingest, by what it changed; says which rebuild ran. */
  ingested(changes: IngestChanges, now: number): 'full' | 'agents' | 'none' {
    if (changes.buckets) this.staleFlag = true
    // No whole model yet: there is nothing an Agents section alone could be put onto.
    if ((this.staleFlag || this.lastFull === null) && this.due(now)) {
      this.runFull(now)
      return 'full'
    }
    if (!changes.buckets && !changes.agents) return 'none'
    this.steps.agents(now)
    return 'agents'
  }

  /** Never built, the interval passed — or the clock went back, which no interval can be measured on. */
  private due(now: number): boolean {
    return this.lastFull === null || now < this.lastFull || now - this.lastFull >= this.minMs
  }

  private runFull(now: number): void {
    // Cleared before the build: whatever the build reads is in it. A build that failed leaves the
    // change stale and the interval unmeasured, so the next tick tries again.
    const stale = this.staleFlag
    this.staleFlag = false
    if (this.steps.full(now)) this.lastFull = now
    else this.staleFlag = stale
  }
}

/**
 * Whether a tick of the timed save may write the state: always while the agent poll is off; while
 * it is on, once AGENT_SAVE_MS have passed since the last timed save. The timer ticks every
 * SAVE_MS and a tick comes a little early or late: half a period of slack keeps the cadence at
 * every second tick rather than every third.
 */
export function timedSaveDue(now: number, lastSave: number | null, pollOn: boolean): boolean {
  if (!pollOn || lastSave === null || now < lastSave) return true
  return now - lastSave >= AGENT_SAVE_MS - SAVE_MS / 2
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type LogLevel = 'info' | 'warn' | 'error' | 'debug'

/**
 * The output channel, and optionally the same lines in a file.
 *
 * The file is a mirror and nothing else: it is fed from the very same call with
 * the very same string, so there is no second formatting path that could put a
 * token or transcript content into a file when it may not go into the Output
 * view. `tokenPace.debug` only decides whether the extra debug lines are written
 * at all — the caller asks `debugEnabled` before building an expensive one.
 *
 * Writing is best effort: a sink that fails is reported once and then switched
 * off. A log file must never be the reason an extension stops working.
 */
class Logger {
  private file: string | null = null
  private bytes = 0
  private debugOn = false
  private failed = false

  constructor(private readonly channel: vscode.LogOutputChannel) {}

  get debugEnabled(): boolean {
    return this.debugOn
  }

  /** `logFile` is validated as a string by config.ts; empty means "channel only". */
  configure(debug: boolean, logFile: string): void {
    this.debugOn = debug
    const wanted = logFile.trim()
    const next = wanted ? expandHome(wanted) : null
    if (next === this.file) return
    this.file = next
    // A changed path is a fresh attempt: the old one may have been unwritable.
    this.failed = false
    this.bytes = next === null ? 0 : fileSize(next)
    if (next !== null) this.info(`Debug log file: ${next}`)
  }

  info(m: string): void {
    this.channel.info(m)
    this.write('info', m)
  }

  warn(m: string): void {
    this.channel.warn(m)
    this.write('warn', m)
  }

  error(m: string): void {
    this.channel.error(m)
    this.write('error', m)
  }

  debug(m: string): void {
    if (!this.debugOn) return
    this.channel.debug(m)
    this.write('debug', m)
  }

  show(): void {
    this.channel.show()
  }

  dispose(): void {
    this.channel.dispose()
  }

  private write(level: LogLevel, message: string): void {
    const file = this.file
    if (file === null || this.failed) return
    const line = `${new Date().toISOString()} [${level}] ${message}\n`
    try {
      if (this.bytes >= LOG_ROTATE_BYTES) {
        // One generation: a bounded footprint is worth more than old lines.
        fs.renameSync(file, `${file}.1`)
        this.bytes = 0
      }
      fs.appendFileSync(file, line)
      this.bytes += Buffer.byteLength(line)
    } catch (err) {
      this.failed = true
      this.file = null
      // Reported to the channel only — the sink is what just failed.
      this.channel.error(`Debug log file switched off, writing to it failed: ${err}`)
    }
  }
}

/** A leading `~` in a user-supplied path, the one shell convention Node does not do. */
function expandHome(p: string): string {
  if (p !== '~' && !p.startsWith('~/') && !p.startsWith(`~${path.sep}`)) return p
  return path.join(os.homedir(), p.slice(1))
}

/** Diagnostics with the network section switched off — the shape still has to be complete. */
const NO_HTTP: { proxy: HttpSetting; proxySupport: HttpSetting; proxyStrictSSL: HttpSetting } = {
  proxy: { value: undefined, origin: 'default' },
  proxySupport: { value: undefined, origin: 'default' },
  proxyStrictSSL: { value: undefined, origin: 'default' },
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/**
 * What kind of failure an error is — its system code or its class — for the log lines about
 * transcripts, which name counts and nothing else: a file system error's message carries the
 * path it failed on.
 */
function errorKind(err: unknown): string {
  const code = isRecord(err) ? err.code : undefined
  if (typeof code === 'string' && /^[A-Z0-9_]{1,32}$/.test(code)) return code
  return err instanceof Error ? err.name : 'unknown error'
}

function sameList(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i])
}

function fileSize(file: string): number {
  try {
    return fs.statSync(file).size
  } catch {
    return 0
  }
}

function loadSnapshot(file: string): Snapshot | undefined {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as Snapshot
  } catch {
    // Missing is the normal first start; unreadable triggers a cold scan, which is the repair.
    return undefined
  }
}

/**
 * A persisted UI state is user data from an older build — every field is checked before it
 * reaches the view model, because a single wrong type there is an empty dashboard.
 */
function restoreUi(raw: unknown, cfg: Config): UiState {
  const base = defaultUiState(cfg)
  if (!isRecord(raw)) return base
  const out: UiState = { ...base }
  const range = raw.range
  if (typeof range === 'string' && (RANGE_PRESETS as string[]).includes(range)) {
    out.range = range as RangePreset
  } else if (isRecord(range) && typeof range.from === 'string' && typeof range.to === 'string') {
    out.range = { from: range.from, to: range.to }
  }
  const sort = raw.sort
  if (isRecord(sort) && typeof sort.key === 'string' && (sort.dir === 'asc' || sort.dir === 'desc')) {
    out.sort = { key: sort.key, dir: sort.dir }
  }
  if (Array.isArray(raw.providers)) {
    const providers = raw.providers.filter(isKnownSource)
    if (providers.length > 0) out.providers = providers
  }
  if (Array.isArray(raw.models)) {
    out.models = raw.models.filter((m): m is string => typeof m === 'string').slice(0, 50)
  }
  if (typeof raw.metric === 'string' && (METRICS as string[]).includes(raw.metric)) {
    out.metric = raw.metric as UiState['metric']
  }
  // A field an older build stored and this one no longer has — the chart's stacking by provider
  // or model (`chartStack`), which 1.2.2 took out; 1.6's split is a field of its own, below — is
  // simply not copied: the state is rebuilt from the defaults field by field, so a key this build
  // does not know is dropped without a special case.
  if (raw.compositionCache === 'all' || raw.compositionCache === 'noCache') {
    out.compositionCache = raw.compositionCache
  }
  if (raw.heatmapMetric === 'usage' || raw.heatmapMetric === 'cost') out.heatmapMetric = raw.heatmapMetric
  if (raw.hourZone === 'local' || raw.hourZone === 'utc') out.hourZone = raw.hourZone
  if (typeof raw.drillDay === 'string') out.drillDay = raw.drillDay
  // Folded sections come back too; unknown keys (a section removed by an update) are dropped.
  if (Array.isArray(raw.collapsed)) {
    out.collapsed = raw.collapsed.filter((k): k is string =>
      typeof k === 'string' && (DASHBOARD_SECTION_KEYS as readonly string[]).includes(k))
  }
  // The agent tree nodes the reader opened and the node whose details are open: opaque keys, so
  // only their shape is checked — a key whose node is gone simply matches nothing. The opened
  // keys are stored oldest first, and a list over the cap keeps its newest, as an open at the
  // cap does (see applyMessage). The folds 1.5.0 kept (`agentsFolded`) are not read: that build
  // was never published, and a fold is the opposite of what is kept now.
  if (Array.isArray(raw.agentsExpanded)) {
    out.agentsExpanded = [...new Set(raw.agentsExpanded.filter((k): k is string =>
      typeof k === 'string' && k.length > 0 && k.length <= MAX_AGENT_KEY_CHARS))].slice(-MAX_AGENT_EXPANDED)
  }
  if (raw.agentSelected === null
    || (typeof raw.agentSelected === 'string' && raw.agentSelected.length > 0
      && raw.agentSelected.length <= MAX_AGENT_KEY_CHARS)) {
    out.agentSelected = raw.agentSelected
  }
  // 1.6 N2: which row of the selected node its details open under — a place of the list (the
  // tree's, the running list's, or — 1.6 L3 — the 7-day block's), and only beside a selection:
  // with nothing selected the details have no place, and it is the tree.
  if (out.agentSelected !== null && isAgentSelectedIn(raw.agentSelectedIn)) out.agentSelectedIn = raw.agentSelectedIn
  // 1.6 D3: the "more" steps of opened nodes — a key of the same shape and a whole number of
  // steps from 1 to MAX_MORE_PAGES, anything else dropped entry by entry. A key stored twice
  // keeps its last entry, and a list over the cap its newest, as a step at the cap does.
  if (Array.isArray(raw.agentsMore)) {
    const byKey = new Map<string, number>()
    for (const e of raw.agentsMore) {
      if (!isRecord(e) || typeof e.key !== 'string' || e.key.length === 0 || e.key.length > MAX_AGENT_KEY_CHARS) continue
      if (typeof e.pages !== 'number' || !Number.isInteger(e.pages) || e.pages < 1 || e.pages > MAX_MORE_PAGES) continue
      byKey.delete(e.key)
      byKey.set(e.key, e.pages)
    }
    out.agentsMore = [...byKey].map(([key, pages]) => ({ key, pages })).slice(-MAX_AGENT_MORE)
  }
  // 1.6 L3: whether the 7-day block is open — a boolean, and nothing else.
  if (typeof raw.agentsWeekOpen === 'boolean') out.agentsWeekOpen = raw.agentsWeekOpen
  // 1.6 O2: the chart's split — one of its two words; anything else is the split by model.
  if (isChartSplit(raw.chartSplit)) out.chartSplit = raw.chartSplit
  return out
}

/** Which side of a remote split this window runs on — an allow-listed diagnostics field. */
function extensionKindName(): string {
  try {
    const ext = vscode.extensions.getExtension(EXTENSION_ID)
    if (!ext) return 'unknown'
    return ext.extensionKind === vscode.ExtensionKind.Workspace ? 'workspace' : 'ui'
  } catch {
    return 'unknown'
  }
}
