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
import { ADAPTERS, SOURCES } from './adapters'
import { Aggregator } from './agg'
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
import { Lease } from './lease'
import { NativeViews, registerNativeViews } from './nativeViews'
import { paceVerdict, windowElapsed } from './pace'
import { CLAUDE_QUOTA_FILE, CODEX_QUOTA_FILE, configureQuotaFiles } from './quota'
import { QuotaHistory } from './quotaHistory'
import { QuotaManager, QuotaOptions } from './quotaManager'
import { scan, ScanContext } from './scan'
import { Role, showMenu, StatusBar } from './statusbar'
import { USAGE_PAGE } from './statusText'
import {
  BRIDGE_BLOCKS_DELETE, DELETE_WARNING, DELETE_WARNING_EXTERNAL, deleteItems, formatBytes, inventory,
  StoredKey, StoredPaths,
} from './storage'
import { DayRange, dayOf, RangePreset, rangeFor } from './time'
import { Forecast, PaceVerdict, QuotaState, Snapshot, Source } from './types'
import {
  applyMessage, buildViewModel, DASHBOARD_SECTION_KEYS, defaultUiState, forecastsFor, RANGE_PRESETS, UiState, ViewModel,
  WebviewMessage,
} from './viewModel'

/** Status bar cadence: countdowns and ages have to move, so this cannot be slower. */
const TICK_MS = 1000
/** The dashboard model is rebuilt on events and otherwise at most this often. */
const VM_MIN_INTERVAL_MS = 5000
const SAVE_MS = 5000
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

/** The debug log file is rotated at this size; exactly one older generation is kept. */
const LOG_ROTATE_BYTES = 5 * 1024 * 1024

const SALT_KEY = 'tokenPace.projectSalt'
const UI_KEY = 'tokenPace.ui'
const REMOTE_HINT_KEY = 'tokenPace.remoteHintShown'
/** The one-click fix offered on a remote host with no transcripts. */
const ACTION_RUN_LOCALLY = 'Run Token Pace locally'
const EXTENSION_ID = 'frederik.token-pace'

const WINDOW_SELECT_CYCLE = ['all', 'leading', 'worstPace', 'session', 'weekly', 'auto'] as const
/** Chart metrics, for validating a persisted UI state from an older build. */
const METRICS: ReadonlyArray<UiState['metric']> = ['usage', 'output', 'cacheRead', 'requests', 'reasoning', 'cost']

let log: Logger

export async function activate(context: vscode.ExtensionContext): Promise<void> {
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
  let lastVmAt = 0
  let role: Role = 'single'
  let roleWired = false
  let scanning = false
  let ingesting = false
  let dirty = false
  let saving = false
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
      minElapsedPercent: readPaceConfig(cfg).minElapsedPercent,
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
      preview: statusBar.previewActive(),
    })
  }

  function rebuildVm(now: number): void {
    try {
      latestVm = buildVm(now)
      lastVmAt = now
      dashboard.update(latestVm)
      views.refreshMarkdown()
    } catch (err) {
      // A broken view must never take the status bar down with it.
      log.error(`Building the view model failed: ${err}`)
    }
  }

  /** `force` marks an event (quota update, ingest, message, config change), not a tick. */
  function render(force = false): void {
    const now = Date.now()
    let readingsOk = false
    try {
      quotas = quotaMgr.current(now)
      forecasts = forecastsFor(
        quotas, history, quotaMgr.fingerprints(), forecastConfig(), now, readPaceConfig(cfg), readTimeConfig(cfg),
      )
      readingsOk = true
    } catch (err) {
      log.error(`Reading the current quota failed: ${err}`)
    }
    // The view model is built first so the status bar can take the budget rows from it
    // rather than deriving them a second time; `rebuildVm` swallows its own errors, so a
    // broken view still cannot take the bar down with it.
    if (force || now - lastVmAt >= VM_MIN_INTERVAL_MS) rebuildVm(now)
    if (!readingsOk) return
    try {
      statusBar.update({
        quotas, agg, cfg, now, forecasts, role, scanning, consent: consent.state(),
        context: quotaMgr.contextReading(),
        budgets: latestVm?.budgets ?? [],
      })
    } catch (err) {
      log.error(`Rendering the status bar failed: ${err}`)
    }
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
    vscode.window.registerWebviewViewProvider(DashboardProvider.viewType, dashboard, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
  )

  const views: NativeViews = registerNativeViews(context, {
    getVm: () => latestVm ?? buildVm(Date.now()),
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
    try {
      const snapshot = await runWorker(agg.toSnapshot(), onProgress)
      agg = Aggregator.fromSnapshot(snapshot, cfg.attribution)
      agg.timeConfig = readTimeConfig(cfg)
      log.info(`Cold start done: ${snapshot.buckets.length} bucket(s), ${Object.keys(snapshot.cursors).length} file(s)`)
    } catch (err) {
      log.error(`Cold start in the worker failed, falling back to the main thread: ${err}`)
      await scan(agg, { ctx: scanContext() }).catch((e) => log.error(`The fallback failed too: ${e}`))
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
    if (role === 'follower') return
    if (file) pendingFiles.add(file)
    if (ingestTimer) return
    ingestTimer = setTimeout(() => {
      ingestTimer = undefined
      // The cold scan reads every file anyway; the sweep picks up whatever arrives meanwhile.
      if (scanning || ingesting || role === 'follower') return
      const files = pendingFiles.size > 0 ? [...pendingFiles] : undefined
      pendingFiles.clear()
      ingesting = true
      void scan(agg, { files, ctx: scanContext() })
        .then((n) => {
          // Counts only — a line is never logged, in no mode and to no sink.
          log.debug(`Ingest: ${files ? `${files.length} changed file(s)` : 'every known file'}`
            + ` → ${n} counted line(s)`)
          // A counted Codex line can carry a fresh rate-limit block — same memo rule as the cold scan.
          if (n > 0) { dirty = true; quotaMgr.invalidate(); render(true) }
        })
        .catch((err) => log.error(`Ingest failed: ${err}`))
        .finally(() => { ingesting = false })
    }, INGEST_DEBOUNCE_MS)
  }

  function rollup(now: number): void {
    // Never while data is moving: a roll-up folds hour buckets a running ingest still writes to.
    if (scanning || ingesting || role === 'follower') return
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

  // --------------------------------------------------------------- persistence
  async function saveState(): Promise<void> {
    if (role === 'follower' || saving) return
    saving = true
    const tmp = `${paths.state}.tmp`
    try {
      await fs.promises.writeFile(tmp, JSON.stringify(agg.toSnapshot()))
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
    const tmp = `${paths.state}.tmp`
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
    const pick = await vscode.window.showInformationMessage(
      'No quota data found. Token Pace can fetch it from the provider — that needs your Claude Code access token.',
      'Show what is sent',
      'Not now',
    )
    if (pick !== 'Show what is sent') return
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
        'Quota is not fetched. Run "Token Pace: Reset Network Access Decision" to be asked again.',
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
    const pick = await vscode.window.showInformationMessage(
      `Token Pace found no Claude Code or Codex transcripts on this host (remote "${remote}"). `
      + 'The extension runs on one side of the connection only. If your transcripts are on the '
      + 'local machine, Token Pace can be moved there (one click writes "remote.extensionKind" into '
      + 'your user settings and offers a reload); if they are on this host, point '
      + 'tokenPace.claudeDir / tokenPace.codexDir at them.',
      ACTION_RUN_LOCALLY,
      'Open Settings',
      'Not now',
    )
    if (pick === 'Open Settings') {
      void vscode.commands.executeCommand('tokenPace.openSettings')
      return
    }
    if (pick === ACTION_RUN_LOCALLY) await runLocally()
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
        'Token Pace: "remote.extensionKind" could not be written. Set it by hand in your user settings.',
      )
      return
    }
    log.info(`remote.extensionKind set: "${EXTENSION_ID}": ["ui"].`)
    const reload = await vscode.window.showInformationMessage(
      'Token Pace will run on the local machine after a window reload.',
      'Reload Window',
      'Later',
    )
    if (reload === 'Reload Window') void vscode.commands.executeCommand('workbench.action.reloadWindow')
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
      { location: vscode.ProgressLocation.Notification, title: 'Token Pace: re-reading token history …' },
      async () => {
        agg = Aggregator.fromSnapshot(undefined, cfg.attribution)
        agg.timeConfig = readTimeConfig(cfg)
        await coldScan()
        rollup(Date.now())
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
    const quota: QuotaDiag[] = (['claude', 'codex'] as Source[]).map((source) => ({
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
      'Token Pace: diagnostics copied. They contain no token, no transcript content and no full paths.',
    )
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
      state: `${stats.files} file(s) · ${stats.oldestDay ?? '–'} … ${stats.newestDay ?? '–'}`,
      history: `${hist.samples} quota sample(s)`,
      externalQuota: external.map((f) => tildify(f, home)).join(' · '),
      ui: 'range, sort and filters of the dashboard',
      consent: 'network and write decisions',
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
        { label: 'Status line bridge', kind: vscode.QuickPickItemKind.Separator },
        { label: '$(warning) The Claude status line is still connected', detail: BRIDGE_BLOCKS_DELETE },
      )
    }
    const chosen = await vscode.window.showQuickPick(picks, {
      canPickMany: true,
      title: 'Token Pace — clear stored data',
      placeHolder: 'Pick what to delete',
    })
    if (!chosen || chosen.length === 0) return
    const keys = chosen.map((c) => c.key).filter((k): k is StoredKey => k !== undefined)
    // The bridge line is pickable in some hosts; picking only it deletes nothing.
    if (keys.length === 0) return
    const detail = keys.includes('externalQuota')
      ? `${DELETE_WARNING}\n\n${DELETE_WARNING_EXTERNAL}`
      : DELETE_WARNING
    const confirm = await vscode.window.showWarningMessage(
      `Delete ${keys.length} stored item(s)? This cannot be undone.`,
      { modal: true, detail },
      'Delete',
    )
    if (confirm !== 'Delete') return

    const result = await deleteItems(keys, { ...paths, externalQuota: external }, context.globalState, say)
    if (result.deleted.includes('history')) history.clear()
    if (result.deleted.includes('quota')) quotaMgr.clearPolled()
    if (result.deleted.includes('ui')) ui = defaultUiState(cfg)
    if (result.failed.length > 0) {
      void vscode.window.showWarningMessage(`Token Pace: could not delete ${result.failed.join(', ')}.`)
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
        { title: 'Open the official usage page', placeHolder: 'Pick a provider' },
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
    void vscode.window.showInformationMessage(`Token Pace: status bar windows — ${next}.`)
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
        'Token Pace: network access decision reset. The next quota fetch will ask again.',
      )
      render(true)
    }),
    vscode.commands.registerCommand('tokenPace.openSettings', () =>
      vscode.commands.executeCommand('workbench.action.openSettings', `@ext:${EXTENSION_ID}`),
    ),
    vscode.commands.registerCommand('tokenPace.openUsagePage', openUsagePage),
    vscode.commands.registerCommand('tokenPace.cycleWindowSelect', cycleWindowSelect),
    vscode.commands.registerCommand('tokenPace.copyDiagnostics', copyDiagnostics),
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
        void vscode.window.showInformationMessage(
          'Token Pace: the transcript directories changed. Reload the window to read them.',
          'Reload Window',
        ).then((pick) => {
          if (pick === 'Reload Window') void vscode.commands.executeCommand('workbench.action.reloadWindow')
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
        void coldScan().then(() => { rollup(Date.now()); render(true) })
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
    if (!dirty || scanning || ingesting) return
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
      for (const t of timers) clearInterval(t)
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

  async function bootstrap(): Promise<void> {
    if (role !== 'follower') {
      const progress = vscode.window.createStatusBarItem(
        'tokenPace.scan', vscode.StatusBarAlignment.Left, 999,
      )
      context.subscriptions.push(progress)
      progress.text = '$(sync~spin) Reading token history …'
      progress.show()
      try {
        await coldScan((done, total) => { progress.tooltip = `${done} of ${total} files` })
      } finally {
        progress.dispose()
      }
      rollup(Date.now())
      await saveState()
      dirty = false
    } else {
      scanning = false
    }
    render(true)
    // Fetch once right away so that without an external cache the first interval is not a wait.
    quotaMgr.tick(onQuotaUpdate)
    logQuotaSources()
    void ensureWriteConsent()
    await offerFetchOnce()
    await remoteHint()
  }
}

export function deactivate(): void {
  // Everything is released through context.subscriptions.
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
    const providers = raw.providers.filter((p): p is Source => p === 'claude' || p === 'codex')
    if (providers.length > 0) out.providers = providers
  }
  if (Array.isArray(raw.models)) {
    out.models = raw.models.filter((m): m is string => typeof m === 'string').slice(0, 50)
  }
  if (typeof raw.metric === 'string' && (METRICS as string[]).includes(raw.metric)) {
    out.metric = raw.metric as UiState['metric']
  }
  if (raw.chartStack === 'provider' || raw.chartStack === 'model') out.chartStack = raw.chartStack
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
