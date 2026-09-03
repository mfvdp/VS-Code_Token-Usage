// SPDX-FileCopyrightText: 2026 Frederik Marx
// SPDX-License-Identifier: AGPL-3.0-or-later

import { Aggregator, IngestContext } from './agg'
import {
  CLAUDE_ROOTS, CODEX_ROOTS, findTranscripts, isClaudeSubagent, isClaudeTranscript, isCodexRollout, rootOf,
} from './discover'
import { newCursor, readNewLines } from './tail'
import { Attribution, Cursor } from './types'

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
 * Reads all new lines from both tools. Used for the cold start (in the worker)
 * as well as for incremental updates — so the logic exists only once.
 */
export async function scan(agg: Aggregator, opts: ScanOptions = {}): Promise<number> {
  const scanCtx = opts.ctx ?? NO_ATTRIBUTION
  const all: Array<{ file: string; source: 'claude' | 'codex' }> = []
  if (opts.files) {
    for (const file of opts.files) {
      const r = rootOf(file)
      if (r) all.push({ file, source: r.source })
    }
  } else {
    for (const root of CLAUDE_ROOTS) {
      for (const file of await findTranscripts(root, isClaudeTranscript)) all.push({ file, source: 'claude' })
    }
    for (const root of CODEX_ROOTS) {
      for (const file of await findTranscripts(root, isCodexRollout)) all.push({ file, source: 'codex' })
    }
  }

  let counted = 0
  let done = 0

  for (const { file, source } of all) {
    let cur = agg.cursors.get(file)
    if (!cur) { cur = newCursor(); agg.cursors.set(file, cur) }
    const ctx: IngestContext = { ...scanCtx, file, isSub: source === 'claude' && isClaudeSubagent(file) }

    if (source === 'claude') {
      // A re-read from the start needs no reset here: message ids still in `pending`
      // dedupe themselves, and there is no cumulative state to unwind.
      await readNewLines(file, cur, (line) => { if (agg.addClaudeLine(line, ctx)) counted++ })
    } else {
      const codexCur = cur
      await readNewLines(
        file, codexCur,
        (line) => { if (agg.addCodexLine(line, codexCur, ctx)) counted++ },
        undefined,
        () => resetCodexCursor(codexCur),
      )
    }
    opts.onProgress?.({ done: ++done, total: all.length, file })
  }
  return counted
}

/**
 * Before a re-read from the start, the derived Codex fields must be neutral again —
 * a stale baseline would swallow every event of the rewritten file up to the old total.
 */
function resetCodexCursor(cur: Cursor): void {
  cur.lastTotal = undefined
  cur.replayDone = false
  cur.startTs = undefined
  cur.forked = false
}
