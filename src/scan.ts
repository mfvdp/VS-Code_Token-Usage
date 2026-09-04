// SPDX-FileCopyrightText: 2026 Frederik Marx
// SPDX-License-Identifier: AGPL-3.0-or-later

import { ADAPTERS, adapterFor } from './adapters'
import { Aggregator, IngestContext } from './agg'
import { findTranscripts, rootOf, rootsFor } from './discover'
import { newCursor, readNewLines } from './tail'
import { Attribution, Source } from './types'

export interface ScanProgress { done: number; total: number; file: string }

/** The attribution settings a scan applies to every file it reads. */
export interface ScanContext {
  attribution: Attribution
  projectSalt: string
  hashProjects: boolean
}

export interface ScanOptions {
  onProgress?: (p: ScanProgress) => void
  /** Only these files (watcher events); otherwise every transcript below every root. */
  files?: string[]
  /** Absent means no session records — the safe default for a caller that did not ask. */
  ctx?: ScanContext
}

const NO_ATTRIBUTION: ScanContext = { attribution: 'none', projectSalt: '', hashProjects: true }

/**
 * Reads all new lines from every provider. Used for the cold start (in the worker)
 * as well as for incremental updates — so the logic exists only once, and a provider
 * contributes its roots, its file names and its line parser through its adapter.
 */
export async function scan(agg: Aggregator, opts: ScanOptions = {}): Promise<number> {
  const scanCtx = opts.ctx ?? NO_ATTRIBUTION
  const all: Array<{ file: string; source: Source }> = []
  if (opts.files) {
    for (const file of opts.files) {
      const r = rootOf(file)
      if (r) all.push({ file, source: r.source })
    }
  } else {
    for (const a of ADAPTERS) {
      for (const root of rootsFor(a.id)) {
        for (const file of await findTranscripts(root, a.matches)) all.push({ file, source: a.id })
      }
    }
  }

  let counted = 0
  let done = 0

  for (const { file, source } of all) {
    const adapter = adapterFor(source)
    let known = agg.cursors.get(file)
    if (!known) { known = newCursor(); agg.cursors.set(file, known) }
    // A `const` so the callbacks below close over a cursor the compiler knows is present.
    const cur = known
    const ctx: IngestContext = { ...scanCtx, file, isSub: adapter.isSub(file) }

    await readNewLines(
      file, cur,
      (line) => { if (adapter.ingest(line, cur, ctx, agg)) counted++ },
      undefined,
      () => adapter.resetCursor(cur),
    )
    opts.onProgress?.({ done: ++done, total: all.length, file })
  }
  return counted
}
