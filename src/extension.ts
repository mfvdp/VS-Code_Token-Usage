import * as fs from 'fs'
import * as path from 'path'
import { Worker } from 'worker_threads'
import * as vscode from 'vscode'
import { Aggregator } from './agg'
import { NetworkConsent } from './consent'
import { buildViewModel, DashboardProvider } from './dashboard'
import { CLAUDE_ROOT, CODEX_ROOT, configureRoots } from './discover'
import { CLAUDE_QUOTA_FILE, CODEX_QUOTA_FILE, configureQuotaFiles } from './quota'
import { QuotaManager, QuotaSource } from './quotaManager'
import { readConfig, StatusBar } from './statusbar'
import { QuotaState, Snapshot } from './types'
import { scan } from './scan'

const SAVE_DEBOUNCE = 5000
const INGEST_DEBOUNCE = 400
const SWEEP_INTERVAL = 60_000
const TICK_INTERVAL = 1000

let log: vscode.LogOutputChannel

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  log = vscode.window.createOutputChannel('Token Pace', { log: true })
  context.subscriptions.push(log)

  const statusBar = new StatusBar()
  const dashboard = new DashboardProvider()
  context.subscriptions.push(
    statusBar,
    vscode.window.registerWebviewViewProvider(DashboardProvider.viewType, dashboard, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
  )

  // Settle the paths before anything is read. Changing them needs a window
  // reload — watchers and cursors hang off them.
  {
    const c = vscode.workspace.getConfiguration('tokenPace')
    const roots = configureRoots(c.get<string>('claudeDir'), c.get<string>('codexDir'))
    configureQuotaFiles(c.get<string>('claudeQuotaFile'), c.get<string>('codexQuotaFile'))
    log.info(`Claude: ${roots.claude}`)
    log.info(`Codex:  ${roots.codex}`)
    log.info(`Quota:  ${CLAUDE_QUOTA_FILE} | ${CODEX_QUOTA_FILE}`)
  }

  const stateFile = path.join(context.globalStorageUri.fsPath, 'state.json')
  await fs.promises.mkdir(context.globalStorageUri.fsPath, { recursive: true }).catch(() => {})

  const quotaOptions = () => {
    const c = vscode.workspace.getConfiguration('tokenPace')
    return {
      mode: c.get<QuotaSource>('quotaSource', 'auto'),
      intervalMinutes: c.get<number>('pollIntervalMinutes', 30),
      claudeDir: c.get<string>('claudeDir'),
      codexBinary: c.get<string>('codexBinary'),
    }
  }
  const consent = new NetworkConsent(context.globalState, (m) => log.info(m))
  const quotaMgr = new QuotaManager(
    quotaOptions(),
    path.join(context.globalStorageUri.fsPath, 'quota.json'),
    (m) => log.info(m),
    () => consent.granted(),
  )

  let agg = Aggregator.fromSnapshot(await loadState(stateFile))
  let quotas: QuotaState[] = quotaMgr.current()
  let scanning = true
  let dirty = false
  const pendingFiles = new Set<string>()

  const render = (): void => {
    const cfg = readConfig()
    statusBar.update(quotas, agg)
    dashboard.update(
      buildViewModel(
        quotas, agg, cfg.staleAfterMinutes, Date.now(), cfg.showCost, cfg.customPrices,
        vscode.workspace
          .getConfiguration('tokenPace')
          .get<string[]>('dashboard.sections', ['quota', 'tokens', 'chart', 'models']),
      ),
    )
  }

  const refreshQuotas = (): void => {
    quotas = quotaMgr.current()
  }

  // ------------------------------------------------- Cold start in the worker
  const progress = vscode.window.createStatusBarItem(
    'tokenPace.scan', vscode.StatusBarAlignment.Left, 999,
  )
  context.subscriptions.push(progress)
  progress.text = '$(sync~spin) Reading token history …'
  progress.show()

  try {
    const snapshot = await runColdScan(context, agg.toSnapshot(), (done, total) => {
      progress.tooltip = `${done} of ${total} files`
    })
    agg = Aggregator.fromSnapshot(snapshot)
    log.info(`Cold start done: ${snapshot.buckets.length} buckets, ${Object.keys(snapshot.cursors).length} files`)
  } catch (err) {
    log.error(`Cold start in the worker failed, falling back to the main thread: ${err}`)
    await scan(agg).catch((e) => log.error(`The fallback failed too: ${e}`))
  } finally {
    progress.dispose()
    scanning = false
    dirty = true
  }
  render()
  // Fetch once right away so that without an external cache we do not wait for the first interval.
  quotaMgr.tick(() => { refreshQuotas(); render() })
  void offerFetchOnce()

  /**
   * Offered at most once per machine, and only when there is genuinely nothing
   * to show: no quota anywhere, mode `auto`, question never put. Anyone who
   * already gets numbers from an external poller is never asked at all.
   */
  async function offerFetchOnce(): Promise<void> {
    if (quotaOptions().mode !== 'auto') return
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
    await vscode.workspace
      .getConfiguration('tokenPace')
      .update('quotaSource', 'poll', vscode.ConfigurationTarget.Global)
    quotaMgr.setOptions(quotaOptions())
    quotaMgr.forcePoll(() => { refreshQuotas(); render() })
  }

  // ------------------------------------------------------------- Incremental
  let ingestTimer: NodeJS.Timeout | undefined
  const scheduleIngest = (file?: string): void => {
    if (file) pendingFiles.add(file)
    if (ingestTimer) return
    ingestTimer = setTimeout(async () => {
      ingestTimer = undefined
      if (scanning) return
      const files = pendingFiles.size ? [...pendingFiles] : undefined
      pendingFiles.clear()
      try {
        const n = await scan(agg, { files })
        if (n > 0) { dirty = true; render() }
      } catch (err) {
        log.error(`Ingest failed: ${err}`)
      }
    }, INGEST_DEBOUNCE)
  }

  for (const root of [CLAUDE_ROOT, CODEX_ROOT]) {
    try {
      const w = fs.watch(root, { recursive: true }, (_e, name) => {
        if (!name || !name.endsWith('.jsonl')) return
        scheduleIngest(path.join(root, name))
      })
      w.on('error', (e) => log.warn(`Watcher on ${root} disturbed: ${e}`))
      context.subscriptions.push({ dispose: () => w.close() })
    } catch (err) {
      log.warn(`No watcher on ${root} (${err}) — falling back to the periodic sweep.`)
    }
  }

  // Safety net: on Linux fs.watch loses events for newly created subdirectories
  // and for atomic replacement. Silent undercounting is the worst failure mode
  // for a counting tool, so sweep everything at a regular interval.
  const sweep = setInterval(() => { pendingFiles.clear(); scheduleIngest() }, SWEEP_INTERVAL)
  context.subscriptions.push({ dispose: () => clearInterval(sweep) })

  // ------------------------------------------------------------------- Quota
  for (const file of [CLAUDE_QUOTA_FILE, CODEX_QUOTA_FILE]) {
    try {
      const dir = path.dirname(file)
      const base = path.basename(file)
      const w = fs.watch(dir, (_e, name) => {
        if (name === base) { refreshQuotas(); render() }
      })
      w.on('error', () => {})
      context.subscriptions.push({ dispose: () => w.close() })
    } catch {
      // Directory does not exist — the tick below covers that.
    }
  }

  // --------------------------------------------------------- Tick and persist
  let sinceQuota = 0
  const tick = setInterval(() => {
    sinceQuota += TICK_INTERVAL
    // Reset countdowns run locally; only re-consult the source occasionally.
    if (sinceQuota >= 30_000) {
      sinceQuota = 0
      quotaMgr.setOptions(quotaOptions())
      quotaMgr.tick(() => { refreshQuotas(); render() })
      refreshQuotas()
    }
    render()
  }, TICK_INTERVAL)
  context.subscriptions.push({ dispose: () => clearInterval(tick) })

  const save = setInterval(() => {
    if (!dirty || scanning) return
    dirty = false
    void saveState(stateFile, agg.toSnapshot())
  }, SAVE_DEBOUNCE)
  context.subscriptions.push({ dispose: () => clearInterval(save) })

  // --------------------------------------------------------------- Commands
  context.subscriptions.push(
    vscode.commands.registerCommand('tokenPace.showDashboard', () =>
      vscode.commands.executeCommand('tokenPace.dashboard.focus'),
    ),
    vscode.commands.registerCommand('tokenPace.showOutput', () => log.show()),
    vscode.commands.registerCommand('tokenPace.refreshQuota', async () => {
      quotaMgr.setOptions(quotaOptions())
      // Asking here rather than from the manager keeps the fetch path free of UI:
      // the command is the one place where the user is present and waiting.
      if (quotaMgr.blocked() === 'consent' && !(await consent.request())) {
        vscode.window.showInformationMessage(
          'Quota is not fetched. Run "Token Pace: Reset Network Access Decision" to be asked again.',
        )
        return
      }
      quotaMgr.forcePoll(() => { refreshQuotas(); render() })
    }),
    vscode.commands.registerCommand('tokenPace.resetNetworkConsent', async () => {
      await consent.reset()
      vscode.window.showInformationMessage(
        'Network access decision reset. The next quota fetch will ask again.',
      )
      render()
    }),
    vscode.commands.registerCommand('tokenPace.rescan', async () => {
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'Re-reading token history …' },
        async () => {
          scanning = true
          agg = new Aggregator()
          try {
            agg = Aggregator.fromSnapshot(await runColdScan(context, agg.toSnapshot(), () => {}))
          } finally {
            scanning = false
          }
          await saveState(stateFile, agg.toSnapshot())
          refreshQuotas()
          render()
        },
      )
    }),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('tokenPace')) { statusBar.reloadConfig(); render() }
    }),
  )

  context.subscriptions.push({ dispose: () => void saveState(stateFile, agg.toSnapshot()) })
}

export function deactivate(): void { /* state is persisted through subscriptions */ }

// ------------------------------------------------------------------- Helpers

function runColdScan(
  context: vscode.ExtensionContext,
  snapshot: Snapshot,
  onProgress: (done: number, total: number) => void,
): Promise<Snapshot> {
  const workerFile = path.join(context.extensionPath, 'dist', 'scanWorker.js')
  return new Promise((resolve, reject) => {
    const worker = new Worker(workerFile, { workerData: { snapshot } })
    worker.on('message', (msg: any) => {
      if (msg?.type === 'progress') onProgress(msg.done, msg.total)
      else if (msg?.type === 'done') { resolve(msg.snapshot); void worker.terminate() }
      else if (msg?.type === 'error') { reject(new Error(msg.message)); void worker.terminate() }
    })
    worker.on('error', reject)
    worker.on('exit', (code) => { if (code !== 0) reject(new Error(`Worker exited with code ${code}`)) })
  })
}

async function loadState(file: string): Promise<Snapshot | undefined> {
  try {
    return JSON.parse(await fs.promises.readFile(file, 'utf8')) as Snapshot
  } catch {
    return undefined
  }
}

async function saveState(file: string, snapshot: Snapshot): Promise<void> {
  const tmp = `${file}.tmp`
  try {
    await fs.promises.writeFile(tmp, JSON.stringify(snapshot))
    await fs.promises.rename(tmp, file)
  } catch (err) {
    log?.warn(`Could not persist state: ${err}`)
  }
}
