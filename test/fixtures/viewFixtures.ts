// SPDX-FileCopyrightText: 2026 Frederik Marx
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * A synthetic world for the view-model tests: an aggregator fed with invented transcript
 * lines, a quota history in a scratch directory, and two quota states.
 *
 * Everything is pinned to a fixed `NOW` and to the UTC zone so the assertions are the same
 * on every machine — a test that depends on the runner's time zone is a test that fails in
 * one continent.
 */

import * as path from 'path'
import { Aggregator, IngestContext } from '../../src/agg'
import { Config, sanitize } from '../../src/config'
import { DEFAULT_FORECAST_CONFIG } from '../../src/forecast'
import { QuotaHistory } from '../../src/quotaHistory'
import { DayRange, TimeConfig, rangeFor } from '../../src/time'
import { Cursor, QuotaState, QuotaWindow, Source } from '../../src/types'
import { Candidate, UiState, VmInput, defaultUiState } from '../../src/viewModel'
import { claudeLine, codexMeta, codexTokenCount, codexTurnContext, tmpDir } from './helpers'

/** 2026-09-03 12:00 UTC — a Thursday, so the week has three days in it. */
export const NOW = Date.UTC(2026, 8, 3, 12, 0, 0)
export const TODAY = '2026-09-03'
export const FINGERPRINT = 'ab12cd34'

export const CLAUDE_FILE = path.join('/virtual', 'claude', 'projects', '-home-t-alpha', 's1.jsonl')
export const CODEX_FILE = path.join('/virtual', 'codex', 'sessions', 'rollout-1.jsonl')

export function hoursAgo(n: number): number {
  return NOW - n * 3_600_000
}

export function daysAgo(n: number): number {
  return NOW - n * 86_400_000
}

export function makeConfig(over: Record<string, unknown> = {}): Config {
  // A fixed 24-hour clock: 'auto' follows the machine's locale, and the assertions that read
  // "09:00" must not turn into "09:00 AM" on a runner whose locale is en-US.
  return sanitize({
    'tokenPace.timezone': 'utc', 'tokenPace.startOfWeek': 'monday', 'tokenPace.resetHourCycle': 'h23', ...over,
  })
}

export function timeConfig(cfg: Config): TimeConfig {
  return {
    zone: cfg.timezone,
    dayBoundaryHour: cfg.dayBoundaryHour,
    startOfWeek: cfg.startOfWeek,
    hourCycle: cfg.resetHourCycle,
  }
}

function ctx(file: string, attribution: Config['attribution'] = 'none', isSub = false): IngestContext {
  return { isSub, file, attribution, projectSalt: 'salt', hashProjects: false }
}

/**
 * Three days of Claude usage, two of Codex, plus one bucket in the previous 30-day period
 * so period-over-period deltas have something to compare against, and one model the price
 * table does not know so the "lower bound" paths are exercised.
 */
export function buildAgg(attribution: Config['attribution'] = 'none'): Aggregator {
  const agg = new Aggregator()
  agg.attribution = attribution
  const cur: Cursor = { offset: 0, size: 0, ino: 1, dev: 1 }
  agg.cursors.set(CLAUDE_FILE, cur)
  const c = ctx(CLAUDE_FILE, attribution)

  let n = 0
  const claude = (ts: number, model: string, usage: Record<string, number>): void => {
    n++
    agg.addClaudeLine(claudeLine({
      id: `msg-${n}`, ts, model, final: true, cwd: '/home/t/alpha', sessionId: 'sess-alpha',
      usage: {
        input: usage.input ?? 0,
        cacheWrite: usage.cacheWrite ?? 0,
        cacheWrite1h: usage.cacheWrite1h ?? 0,
        cacheRead: usage.cacheRead ?? 0,
        output: usage.output ?? 0,
        thinking: usage.thinking ?? 0,
      },
    }), c)
  }

  // Today, three hours of work.
  claude(Date.UTC(2026, 8, 3, 9, 0), 'claude-opus-4-6', { input: 4000, cacheWrite: 2000, cacheWrite1h: 500, cacheRead: 90000, output: 3000, thinking: 900 })
  claude(Date.UTC(2026, 8, 3, 10, 30), 'claude-sonnet-4-6', { input: 1500, cacheWrite: 800, cacheRead: 40000, output: 1200 })
  claude(Date.UTC(2026, 8, 3, 11, 15), 'claude-experimental-x', { input: 700, cacheRead: 2000, output: 400 })
  // Yesterday and the day before.
  claude(Date.UTC(2026, 8, 2, 14, 0), 'claude-opus-4-6', { input: 2500, cacheWrite: 1000, cacheRead: 55000, output: 1800 })
  claude(Date.UTC(2026, 8, 1, 9, 30), 'claude-opus-4-6', { input: 1800, cacheWrite: 700, cacheRead: 30000, output: 1400 })
  claude(Date.UTC(2026, 7, 28, 16, 0), 'claude-sonnet-4-6', { input: 900, cacheRead: 12000, output: 700 })
  // Inside the previous 30-day period, so the deltas are not "new".
  claude(Date.UTC(2026, 6, 20, 10, 0), 'claude-opus-4-6', { input: 3000, cacheWrite: 900, cacheRead: 20000, output: 2100 })

  const codexCur: Cursor = { offset: 0, size: 0, ino: 2, dev: 1 }
  agg.cursors.set(CODEX_FILE, codexCur)
  const x = ctx(CODEX_FILE, attribution)
  agg.addCodexLine(codexMeta({ ts: Date.UTC(2026, 8, 2, 8, 0), id: 'thread-1', cwd: '/home/t/beta' }), codexCur, x)
  agg.addCodexLine(codexTurnContext(Date.UTC(2026, 8, 2, 8, 0), 'gpt-5.3-codex'), codexCur, x)
  agg.addCodexLine(codexTokenCount({
    ts: Date.UTC(2026, 8, 2, 8, 30),
    total: { total: 12000, input: 9000, cached: 6000, output: 3000, reasoning: 800 },
    last: { total: 12000, input: 9000, cached: 6000, output: 3000, reasoning: 800 },
  }), codexCur, x)
  agg.addCodexLine(codexTokenCount({
    ts: Date.UTC(2026, 8, 3, 10, 0),
    total: { total: 20000, input: 14000, cached: 10000, output: 6000, reasoning: 1500 },
    last: { total: 8000, input: 5000, cached: 4000, output: 3000, reasoning: 700 },
  }), codexCur, x)
  return agg
}

export function makeHistory(dir?: string): QuotaHistory {
  const file = path.join(dir ?? tmpDir('tp-vm'), 'quotaHistory.json')
  return new QuotaHistory(file, 30)
}

export function win(over: Partial<QuotaWindow> = {}): QuotaWindow {
  return {
    id: 'session:300',
    kind: 'session',
    label: '5 h',
    shortLabel: '5h',
    model: null,
    percent: 40,
    resetsAt: NOW + 2 * 3_600_000,
    windowMinutes: 300,
    limitReached: false,
    unlimited: false,
    ...over,
  }
}

export function state(source: Source, over: Partial<QuotaState> = {}): QuotaState {
  return {
    source,
    ok: true,
    origin: 'poll',
    fetchedAt: Math.round((NOW - 5 * 60_000) / 1000),
    planType: source === 'claude' ? 'max20' : 'pro',
    windows: [win(), win({ id: 'weekly_all:10080', kind: 'weekly', label: '7 d', shortLabel: '7d', percent: 62, resetsAt: NOW + 3 * 86_400_000, windowMinutes: 10080 })],
    ...over,
  }
}

/** A rising series of readings for one window, so the forecast has a slope to find. */
export function fillHistory(history: QuotaHistory, source: Source = 'claude', windowId = 'session:300'): void {
  for (let i = 8; i >= 0; i--) {
    const t = NOW - i * 15 * 60_000
    history.add(
      {
        source,
        ok: true,
        origin: 'poll',
        fetchedAt: Math.round(t / 1000),
        planType: null,
        windows: [win({ id: windowId, percent: 40 - i * 3 })],
      },
      FINGERPRINT,
      t,
    )
  }
}

export interface FixtureOptions {
  cfg?: Config
  agg?: Aggregator
  history?: QuotaHistory
  quotas?: QuotaState[]
  ui?: Partial<UiState>
  range?: DayRange
}

export function makeInput(o: FixtureOptions = {}): VmInput {
  const cfg = o.cfg ?? makeConfig()
  const agg = o.agg ?? buildAgg()
  const history = o.history ?? makeHistory()
  const ui: UiState = { ...defaultUiState(cfg), ...o.ui }
  const range = o.range ?? rangeFor('30d', NOW, timeConfig(cfg), agg.stats().oldestDay ?? TODAY)
  const candidates: Record<Source, Candidate[]> = {
    claude: [{ id: 'cacheFile', ok: true, ageSec: 180 }, { id: 'poll', ok: false, ageSec: null, problem: 'no token' }],
    codex: [{ id: 'transcript', ok: true, ageSec: 7200 }],
  }
  return {
    quotas: o.quotas ?? [state('claude'), state('codex')],
    agg,
    history,
    cfg,
    now: NOW,
    range,
    ui,
    leader: true,
    candidates,
    drift: { claude: ['spend.used.amount_minor'], codex: [] },
    dataFiles: { roots: ['~/.claude', '~/.codex'], files: 2 },
    snapshotBytes: 40960,
    consent: 'granted',
    bridge: null,
    fingerprints: { claude: FINGERPRINT, codex: FINGERPRINT },
    forecastCfg: DEFAULT_FORECAST_CONFIG,
  }
}
