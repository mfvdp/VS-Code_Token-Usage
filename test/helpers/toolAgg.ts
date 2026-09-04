// SPDX-FileCopyrightText: 2026 Frederik Marx
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * An aggregator with tool calls in it, for the view and export tests.
 *
 * The tool side table is addressed by the *local* day of the ingest, while the view model's
 * range is in the configured zone, so every day here is derived with `localDay` and the
 * range is derived from the same days: a fixture that hard-codes a date passes in Berlin and
 * fails in Auckland.
 */

import { Aggregator, localDay } from '../../src/agg'
import { Cursor } from '../../src/types'
import { DayRange } from '../../src/time'
import {
  CODEX_FILE, claudeLine, codexMeta, codexToolCall, codexTurnContext, ctxFor,
} from '../fixtures/helpers'

export interface ToolAgg {
  agg: Aggregator
  /** The two days the calls land on, oldest first. */
  days: [string, string]
  /** A range that contains both of them. */
  range: DayRange
}

/**
 * Six Claude calls over two days and models, plus one Codex call on the later day:
 * `Read` 3 (opus), `Bash` 2 (opus + sonnet), `Edit` 1 (sonnet), `exec` 1 (codex).
 */
export function toolAgg(now: number): ToolAgg {
  const agg = new Aggregator()
  const claude = ctxFor()
  const codexCtx = ctxFor({ file: CODEX_FILE })
  const cur: Cursor = { offset: 0, size: 0, ino: 7, dev: 1 }
  const DAY = 86_400_000
  const t0 = now - DAY
  let n = 0
  const call = (ts: number, model: string, name: string): void => {
    n++
    agg.addClaudeLine(claudeLine({
      id: `tool-${n}`, ts, model, usage: { input: 100, output: 10 }, tools: [{ name, id: `toolu_${n}` }],
    }), claude)
  }
  call(t0, 'claude-opus-4-6', 'Read')
  call(t0, 'claude-opus-4-6', 'Read')
  call(t0, 'claude-opus-4-6', 'Bash')
  call(now, 'claude-opus-4-6', 'Read')
  call(now, 'claude-sonnet-4-6', 'Bash')
  call(now, 'claude-sonnet-4-6', 'Edit')

  agg.cursors.set(CODEX_FILE, cur)
  agg.addCodexLine(codexMeta({ ts: now, id: 'thread-tools' }), cur, codexCtx)
  agg.addCodexLine(codexTurnContext(now, 'gpt-5.4'), cur, codexCtx)
  agg.addCodexLine(codexToolCall({ ts: now, name: 'exec', callId: 'call_1', custom: true }), cur, codexCtx)

  const days: [string, string] = [localDay(t0), localDay(now)]
  return {
    agg,
    days,
    range: { from: days[0], to: days[1], label: 'Two days', preset: 'custom' },
  }
}
