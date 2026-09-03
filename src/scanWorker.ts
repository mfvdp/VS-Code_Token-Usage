// SPDX-FileCopyrightText: 2026 Frederik Marx
// SPDX-License-Identifier: AGPL-3.0-or-later

import { parentPort, workerData } from 'worker_threads'
import { Aggregator } from './agg'
import { configureRoots } from './discover'
import { ScanContext, scan } from './scan'
import { TimeConfig } from './time'
import { Snapshot } from './types'

/** What the extension hands over: `new Worker(file, { workerData })`. */
export interface ScanWorkerData {
  snapshot?: Snapshot
  ctx?: ScanContext
  /** Zone for addressing late lines into rolled-up buckets; system zone when absent. */
  timeConfig?: TimeConfig
  /**
   * `tokenPace.claudeDir` / `tokenPace.codexDir`. A worker thread inherits the environment
   * but not the settings, so without these it would silently scan the default home while the
   * main thread watches a relocated one.
   */
  claudeDirs?: string[]
  codexDirs?: string[]
}

/**
 * Cold-start full scan on its own thread. Parsing roughly 1 GB of transcripts
 * on the extension host would freeze the entire UI.
 */
async function main(): Promise<void> {
  const data: ScanWorkerData = workerData ?? {}
  if (data.claudeDirs || data.codexDirs) configureRoots(data.claudeDirs ?? [], data.codexDirs ?? [])
  const agg = Aggregator.fromSnapshot(data.snapshot, data.ctx?.attribution ?? 'none')
  if (data.timeConfig) agg.timeConfig = data.timeConfig
  let last = 0
  const counted = await scan(agg, {
    ctx: data.ctx,
    onProgress: (p) => {
      const now = Date.now()
      if (now - last < 250 && p.done !== p.total) return
      last = now
      parentPort?.postMessage({ type: 'progress', done: p.done, total: p.total })
    },
  })
  parentPort?.postMessage({ type: 'done', snapshot: agg.toSnapshot(), counted })
}

main().catch((err) => {
  parentPort?.postMessage({ type: 'error', message: String(err?.stack ?? err) })
})
