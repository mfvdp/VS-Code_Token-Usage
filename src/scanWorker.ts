import { parentPort, workerData } from 'worker_threads'
import { Aggregator } from './agg'
import { scan } from './scan'
import { Snapshot } from './types'

/**
 * Cold-start full scan on its own thread. Parsing roughly 1 GB of transcripts
 * on the extension host would freeze the entire UI.
 */
async function main(): Promise<void> {
  const start: Snapshot | undefined = workerData?.snapshot
  const agg = Aggregator.fromSnapshot(start)
  let last = 0
  const counted = await scan(agg, {
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
