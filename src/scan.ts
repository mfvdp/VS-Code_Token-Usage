// SPDX-FileCopyrightText: 2026 Frederik Marx
// SPDX-License-Identifier: GPL-3.0-or-later

import { Aggregator } from './agg'
import { CLAUDE_ROOT, CODEX_ROOT, findTranscripts, isClaudeSubagent, isClaudeTranscript, isCodexRollout } from './discover'
import { newCursor, readNewLines } from './tail'
import { Cursor } from './types'

export interface ScanProgress { done: number; total: number; file: string }

/**
 * Reads all new lines from both tools. Used for the cold start (in the worker)
 * as well as for incremental updates — so the logic exists only once.
 */
export async function scan(
  agg: Aggregator,
  opts: { onProgress?: (p: ScanProgress) => void; files?: string[] } = {},
): Promise<number> {
  const claude = opts.files
    ? opts.files.filter((f) => f.startsWith(CLAUDE_ROOT))
    : await findTranscripts(CLAUDE_ROOT, isClaudeTranscript)
  const codex = opts.files
    ? opts.files.filter((f) => f.startsWith(CODEX_ROOT))
    : await findTranscripts(CODEX_ROOT, isCodexRollout)

  const all = [...claude, ...codex]
  let counted = 0
  let done = 0

  for (const file of all) {
    let cur = agg.cursors.get(file)
    if (!cur) { cur = newCursor(); agg.cursors.set(file, cur) }

    if (file.startsWith(CLAUDE_ROOT)) {
      const isSub = isClaudeSubagent(file)
      await readNewLines(file, cur, (line) => { if (agg.addClaudeLine(line, isSub)) counted++ })
    } else {
      const restarted = await readNewLines(file, cur, (line) => {
        if (agg.addCodexLine(line, cur as Cursor)) counted++
      })
      if (restarted) resetCodexCursor(cur)
    }
    opts.onProgress?.({ done: ++done, total: all.length, file })
  }
  return counted
}

/** After a re-read from the start, the derived Codex fields must be neutral again. */
function resetCodexCursor(cur: Cursor): void {
  cur.lastTotal = undefined
  cur.replayDone = false
  cur.startTs = undefined
  cur.forked = false
}
