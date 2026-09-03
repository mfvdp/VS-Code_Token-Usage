// SPDX-FileCopyrightText: 2026 Frederik Marx
// SPDX-License-Identifier: AGPL-3.0-or-later

import * as assert from 'node:assert/strict'
import { test } from 'node:test'
import { Cycle, ForecastConfig, calibration, forecast, lockoutText, resetForecast, retrospective } from '../src/forecast'
import { QuotaSample, QuotaWindow } from '../src/types'

const NOW = 1_700_000_000_000
const H = 3_600_000
const MIN = 60_000

const CFG: ForecastConfig = {
  minSamples: 4,
  minSpanMs: 20 * MIN,
  idleRate: 0.1,
  minElapsedPercent: 3,
  staleAfterMs: H,
}

/** Deterministic clock text: the zone of the test machine must not decide the assertion. */
const utc = (ms: number): string => new Date(ms).toISOString().slice(11, 16)

function win(percent: number, resetsAt: number | null, extra: Partial<QuotaWindow> = {}): QuotaWindow {
  return {
    id: 'session:300', kind: 'session', label: '5 h', shortLabel: '5h', model: null,
    percent, resetsAt, windowMinutes: 300, limitReached: false, unlimited: false, ...extra,
  }
}

function sample(t: number, p: number, r: number | null = null): QuotaSample {
  return { s: 'claude', w: 'session:300', t, p, r, o: 'poll', f: 'abcd1234' }
}

/** `count` readings ending at NOW, `stepMs` apart, rising by `perHour` points per hour. */
function series(count: number, stepMs: number, startPercent: number, perHour: number, r: number | null = null): QuotaSample[] {
  const out: QuotaSample[] = []
  const first = NOW - (count - 1) * stepMs
  for (let i = 0; i < count; i++) {
    const t = first + i * stepMs
    out.push(sample(t, startPercent + (perHour * (t - first)) / H, r))
  }
  return out
}

test('no samples is state none and says nothing at all', () => {
  const none = forecast([], win(10, NOW + 4 * H), NOW, CFG, 50)
  assert.equal(none.state, 'none')
  assert.equal(none.text, '')
  assert.equal(none.etaMs, null)
})

test('an exhausted window names the reset without counting it down, and invents none', () => {
  const full = forecast(series(13, 15 * MIN, 95, 2), win(99.7, NOW + 4 * H), NOW, CFG, 50)
  assert.equal(full.state, 'full')
  // No duration in the sentence: every view prints the window's own countdown right beside
  // it, and the two duration formats disagreed about the same instant.
  assert.equal(full.text, 'full until the reset')
  assert.equal(/\d/.test(full.text), false)
  // Nothing is projected: the rate and the ETA stay absent, only the sentence is filled in.
  assert.equal(full.ratePerHour, null)
  assert.equal(full.etaMs, null)
  assert.equal(full.endPercent, null)

  // No stated reset, and a reset already past: the bare fact and nothing more.
  assert.equal(forecast([], win(100, null), NOW, CFG, 50).text, 'full')
  assert.equal(forecast([], win(100, NOW - MIN), NOW, CFG, 50).text, 'full')
  assert.equal(forecast([], win(100, Number.NaN), NOW, CFG, 50).text, 'full')
})

test('an unlimited window never gets a projection', () => {
  const f = forecast(series(13, 15 * MIN, 10, 10), win(40, NOW + 4 * H, { unlimited: true }), NOW, CFG, 50)
  assert.equal(f.state, 'none')
})

test('too few readings or too short a span is measuring, and says so', () => {
  const f = forecast(series(2, 10 * MIN, 10, 12), win(12, NOW + 4 * H), NOW, CFG, 50)
  assert.equal(f.state, 'measuring')
  assert.equal(f.text, 'measuring · 2 readings over 10 min')
  assert.deepEqual(f.basis, { samples: 2, spanMs: 10 * MIN })
  assert.equal(f.ratePerHour, null)

  const short = forecast(series(5, 3 * MIN, 10, 12), win(12, NOW + 4 * H), NOW, CFG, 50)
  assert.equal(short.state, 'measuring')
  assert.equal(short.text, 'measuring · 5 readings over 12 min')
})

test('a reading older than staleAfterMs is stale, not a forecast', () => {
  const old = series(13, 15 * MIN, 10, 10).map((s) => ({ ...s, t: s.t - 2 * H }))
  const f = forecast(old, win(40, NOW + 4 * H), NOW, CFG, 50)
  assert.equal(f.state, 'stale')
  assert.equal(f.text, 'stale reading')
  assert.equal(f.etaMs, null)
  assert.notEqual(f.basis, null)
})

test('a flat or falling series is idle, never "empty in 40 days"', () => {
  const flat = forecast(series(13, 15 * MIN, 40, 0), win(40, NOW + 4 * H), NOW, CFG, 50)
  assert.equal(flat.state, 'idle')
  assert.equal(flat.text, 'idle · no change over 3 h')
  assert.ok(Math.abs(flat.ratePerHour as number) < 1e-9)
  assert.equal(flat.etaMs, null)

  const falling = forecast(series(13, 15 * MIN, 40, -2), win(34, NOW + 4 * H), NOW, CFG, 50)
  assert.equal(falling.state, 'idle')
  assert.ok((falling.ratePerHour as number) < 0)
})

test('a rising series gives an ETA with wall-clock time, confidence and a "~" marker', () => {
  const f = forecast(series(13, 15 * MIN, 10, 10), win(40, NOW + 20 * H), NOW, CFG, 50, utc)
  assert.equal(f.state, 'eta')
  assert.ok(Math.abs((f.ratePerHour as number) - 10) < 1e-6)
  assert.equal(Math.round(((f.etaMs as number) - NOW) / H), 6)
  assert.equal(f.confidence, 'high')
  assert.deepEqual(f.basis, { samples: 13, spanMs: 3 * H })
  assert.equal(f.text, `~empty in 6 h (${utc(f.etaMs as number)}) · high confidence`)
  assert.ok(f.text.startsWith('~'))
  // The window would be far past 100 % by the time it resets.
  assert.ok((f.endPercent as number) > 100)
  const over = resetForecast(f)
  assert.equal(over?.sign, '-')
  assert.ok(Math.abs((over as { points: number }).points - 140) < 1e-6)
})

test('a window that resets before it runs empty reports the end percent instead', () => {
  const f = forecast(series(13, 15 * MIN, 34, 2), win(40, NOW + 5 * H), NOW, CFG, 50, utc)
  assert.equal(f.state, 'resetsFirst')
  assert.equal(f.etaMs, null, 'never an ETA that lands after the reset')
  assert.ok(Math.abs((f.endPercent as number) - 50) < 1e-6)
  assert.equal(f.text, '~ends at 50 % when it resets')
  const buffer = resetForecast(f)
  assert.equal(buffer?.sign, '+')
  assert.ok(Math.abs((buffer as { points: number }).points - 50) < 1e-6)
})

test('a reset that already passed yields no ETA while the reading still predates it', () => {
  const resetsAt = NOW - 10 * MIN
  // Twelve readings ending 10 min before the reset: rising, recent enough not to be stale,
  // but describing a window that no longer exists.
  const stale = series(12, 10 * MIN, 80, 9).map((x) => ({ ...x, t: x.t - 20 * MIN }))
  const f = forecast(stale, win(80, resetsAt), NOW, CFG, 50, utc)
  assert.notEqual(f.state, 'eta', 'never an exhaustion time after a reset that has passed')
  assert.equal(f.state, 'stale')
  assert.equal(f.text, 'reset due')
  assert.equal(f.etaMs, null)
  assert.equal(f.endPercent, null)
  assert.equal(lockoutText(f, NOW, utc), null)
  assert.notEqual(f.basis, null, 'the readings are still counted, only not extrapolated')

  // A reading taken after the reset is trusted again — the window is simply clockless now.
  const fresh = forecast(series(12, 10 * MIN, 10, 9), win(40, resetsAt), NOW, CFG, 50, utc)
  assert.equal(fresh.state, 'eta')
})

test('an ETA never lands after the reset, whatever the reset time', () => {
  for (const hours of [0.5, 1, 2, 3, 4, 6, 8, 12, 24]) {
    const resetsAt = NOW + hours * H
    const f = forecast(series(13, 15 * MIN, 10, 10), win(40, resetsAt), NOW, CFG, 50, utc)
    if (f.state === 'eta') assert.ok((f.etaMs as number) < resetsAt, `eta at ${hours} h`)
    else assert.equal(f.state, 'resetsFirst')
  }
})

test('confidence follows sample count and span', () => {
  const low = forecast(series(5, 20 * MIN, 10, 10), win(40, NOW + 20 * H), NOW, CFG, 50, utc)
  assert.equal(low.confidence, 'low')
  const medium = forecast(series(9, 15 * MIN, 10, 10), win(40, NOW + 20 * H), NOW, CFG, 50, utc)
  assert.equal(medium.confidence, 'medium')
  const high = forecast(series(13, 15 * MIN, 10, 10), win(40, NOW + 20 * H), NOW, CFG, 50, utc)
  assert.equal(high.confidence, 'high')
  // Twelve readings squeezed into one hour are still only medium.
  const dense = forecast(series(13, 5 * MIN, 10, 10), win(40, NOW + 20 * H), NOW, CFG, 50, utc)
  assert.equal(dense.confidence, 'medium')
})

test('the sustainable rate is what would just last until the reset', () => {
  const f = forecast(series(13, 15 * MIN, 10, 10), win(40, NOW + 6 * H), NOW, CFG, 50, utc)
  assert.ok(Math.abs((f.sustainablePerHour as number) - 10) < 1e-6)
  const noReset = forecast(series(13, 15 * MIN, 10, 10), win(40, null), NOW, CFG, 50, utc)
  assert.equal(noReset.sustainablePerHour, null, 'no clock, no denominator')
  assert.equal(noReset.endPercent, null)
  const past = forecast(series(13, 15 * MIN, 10, 10), win(40, NOW - H), NOW, CFG, 50, utc)
  assert.equal(past.sustainablePerHour, null)
})

test('too little of the window elapsed suppresses the forecast', () => {
  const f = forecast(series(13, 15 * MIN, 10, 10), win(40, NOW + 20 * H), NOW, CFG, 1)
  assert.equal(f.state, 'measuring')
  assert.equal(f.text, 'measuring · window just started')
  assert.equal(f.etaMs, null)
  // A window without a clock is not suppressed — there is nothing to be early in.
  const noClock = forecast(series(13, 15 * MIN, 10, 10), win(40, NOW + 20 * H), NOW, CFG, null, utc)
  assert.equal(noClock.state, 'eta')
})

test('the fit restarts at a limit re-basing and ignores earlier cycles', () => {
  const jump: QuotaSample[] = [
    sample(NOW - 4 * H, 10),
    sample(NOW - 3 * H, 12),
    sample(NOW - 2.9 * H, 80),   // +68 points in 6 minutes: the limit moved, not the usage
    sample(NOW - 2 * H, 82),
    sample(NOW - H, 84),
    sample(NOW, 86),
  ]
  const f = forecast(jump, win(86, NOW + 20 * H), NOW, CFG, 50, utc)
  assert.equal(f.state, 'eta')
  assert.equal(f.basis?.samples, 4)
  assert.ok((f.ratePerHour as number) > 1.8 && (f.ratePerHour as number) < 2.3, `rate ${f.ratePerHour}`)

  // Everything before a reset belongs to another cycle and must not enter the fit.
  const acrossReset: QuotaSample[] = [
    ...series(10, 15 * MIN, 40, 10).map((s) => ({ ...s, t: s.t - 4 * H })),
    sample(NOW - 30 * MIN, 3),
    sample(NOW, 6),
  ]
  const after = forecast(acrossReset, win(6, NOW + 5 * H), NOW, CFG, 50, utc)
  assert.equal(after.state, 'measuring')
  assert.equal(after.basis?.samples, 2)
})

test('lockoutText names the wall-clock time only for a real ETA', () => {
  const eta = forecast(series(13, 15 * MIN, 10, 10), win(40, NOW + 20 * H), NOW, CFG, 50, utc)
  assert.equal(lockoutText(eta, NOW, utc), `locks ${utc(eta.etaMs as number)}`)
  const resets = forecast(series(13, 15 * MIN, 34, 2), win(40, NOW + 5 * H), NOW, CFG, 50, utc)
  assert.equal(lockoutText(resets, NOW, utc), null)
  assert.equal(lockoutText(eta, (eta.etaMs as number) + MIN, utc), null, 'a passed ETA is not a lockout')
})

test('resetForecast signs the buffer and the overshoot, and stays silent without an end percent', () => {
  const base = forecast([], win(10, null), NOW, CFG, 50)
  assert.equal(resetForecast(base), null)
  assert.deepEqual(resetForecast({ ...base, endPercent: 78 }), { sign: '+', points: 22 })
  assert.deepEqual(resetForecast({ ...base, endPercent: 130 }), { sign: '-', points: 30 })
  assert.deepEqual(resetForecast({ ...base, endPercent: 100 }), { sign: '+', points: 0 })
})

function cycle(start: number, last: number, peak: number, complete: boolean): Cycle {
  return {
    start, end: start + 5 * H, resetsAt: start + 5 * H, peak, peakAt: start + H, last,
    complete, capped: peak >= 99.5, tags: ['RESET'], fitStart: start,
  }
}

test('the retrospective needs three complete cycles and ignores the incomplete ones', () => {
  const few = retrospective([cycle(NOW, 80, 80, true), cycle(NOW + 5 * H, 90, 90, true)], 'session:300')
  assert.equal(few.enough, false)
  assert.equal(few.cappedShare, 0)
  assert.ok(Math.abs((few.avgUnused as number) - 15) < 1e-9)

  const retro = retrospective([
    cycle(NOW, 100, 100, true),
    cycle(NOW + 5 * H, 70, 70, true),
    cycle(NOW + 10 * H, 40, 40, true),
    cycle(NOW + 15 * H, 5, 5, false),      // still running: no statistics from it
  ], 'session:300')
  assert.equal(retro.windowId, 'session:300')
  assert.equal(retro.enough, true)
  assert.ok(Math.abs((retro.cappedShare as number) - 1 / 3) < 1e-9)
  assert.ok(Math.abs((retro.avgUnused as number) - 30) < 1e-9)
  assert.equal(retro.cycles.length, 4, 'incomplete cycles stay visible')

  const empty = retrospective([], 'session:300')
  assert.equal(empty.enough, false)
  assert.equal(empty.cappedShare, null)
  assert.equal(empty.avgUnused, null)
})

test('calibration measures points per million local tokens, or says nothing', () => {
  const w = win(40, NOW + 4 * H)
  const span = [sample(NOW - 2 * H, 20), sample(NOW - H, 30)]
  const ok = calibration(span, () => 2_000_000, w)
  assert.ok(ok)
  assert.ok(Math.abs(ok.factor - 5) < 1e-9)
  assert.equal(ok.low, ok.high)
  assert.ok(Math.abs(ok.basisHours - 1) < 1e-9)

  // Span too short.
  assert.equal(calibration([sample(NOW - 30 * MIN, 20), sample(NOW, 40)], () => 2_000_000, w), null)
  // Delta too small.
  assert.equal(calibration([sample(NOW - 2 * H, 20), sample(NOW, 23)], () => 2_000_000, w), null)
  // No local tokens to divide by.
  assert.equal(calibration(span, () => 0, w), null)
  assert.equal(calibration(span, () => null, w), null)
  // Nothing to measure.
  assert.equal(calibration([], () => 1_000_000, w), null)
  assert.equal(calibration(span, () => 2_000_000, win(40, NOW + 4 * H, { unlimited: true })), null)
})

test('calibration takes the newest qualifying spans as a band', () => {
  const samples = [
    sample(NOW - 6 * H, 0), sample(NOW - 5 * H, 10),
    sample(NOW - 4 * H, 20), sample(NOW - 3 * H, 40),
    sample(NOW - 2 * H, 50), sample(NOW - H, 70),
  ]
  const tokens = (from: number): number => (from >= NOW - 2 * H ? 1_000_000 : 2_000_000)
  const band = calibration(samples, tokens, win(70, NOW + H))
  assert.ok(band)
  assert.ok(band.low < band.high)
  assert.ok(band.factor >= band.low && band.factor <= band.high)
  assert.ok(band.basisHours >= 3)
})
