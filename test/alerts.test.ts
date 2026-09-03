// SPDX-FileCopyrightText: 2026 Frederik Marx
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The alert hygiene rules, one test each. They are the reason the feature is
 * defensible at all: a warning that repeats itself is worse than none.
 */

import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { ACTION_DASHBOARD, ACTION_SNOOZE, Alerts, DASHBOARD_COMMAND, nextLocalMidnight, usedThresholds } from '../src/alerts'
import { AlertConfig } from '../src/config'
import { MementoLike } from '../src/storage'
import { Forecast, PaceLevel, PaceVerdict, QuotaState, QuotaWindow } from '../src/types'

const NOW = 1_700_000_000_000
const HOUR = 3_600_000

/** Records every update in order, so "persist before notify" is observable. */
class FakeMemento implements MementoLike {
  store = new Map<string, unknown>()
  calls: string[] = []

  get<T>(key: string, defaultValue: T): T {
    return this.store.has(key) ? (this.store.get(key) as T) : defaultValue
  }

  update(key: string, value: unknown): PromiseLike<void> {
    this.calls.push(`update:${key}`)
    if (value === undefined) this.store.delete(key)
    else this.store.set(key, value)
    return Promise.resolve()
  }
}

function cfg(over: Partial<AlertConfig> = {}): AlertConfig {
  return {
    thresholds: [],
    basis: 'used',
    requireAhead: false,
    minRemainingMinutes: 0,
    useItLoseIt: false,
    forecastLeadMinutes: 0,
    onPaceFast: false,
    windowCondition: 'any',
    ...over,
  }
}

function win(over: Partial<QuotaWindow> = {}): QuotaWindow {
  return {
    id: 'session:300',
    kind: 'session',
    label: '5 h',
    shortLabel: '5h',
    model: null,
    percent: 50,
    resetsAt: NOW + 3 * HOUR,
    windowMinutes: 300,
    limitReached: false,
    unlimited: false,
    ...over,
  }
}

/** A reading taken at `at` — alerts refuse to speak from a stale one. */
function quotaAt(at: number, windows: QuotaWindow[], over: Partial<QuotaState> = {}): QuotaState {
  return quota(windows, { fetchedAt: Math.floor(at / 1000), ...over })
}

function quota(windows: QuotaWindow[], over: Partial<QuotaState> = {}): QuotaState {
  return {
    source: 'claude',
    ok: true,
    fetchedAt: Math.floor(NOW / 1000),
    planType: 'max',
    windows,
    ...over,
  }
}

function verdict(level: PaceLevel): PaceVerdict {
  return { level, points: 12, ratio: 1.3, measuring: false, text: '12 points ahead of the clock' }
}

function forecast(over: Partial<Forecast> = {}): Forecast {
  return {
    state: 'eta',
    ratePerHour: 20,
    etaMs: NOW + 30 * 60_000,
    endPercent: 120,
    sustainablePerHour: 5,
    confidence: 'medium',
    basis: { samples: 8, spanMs: 2 * HOUR },
    text: '~empty in 30 min',
    ...over,
  }
}

interface Harness {
  alerts: Alerts
  memento: FakeMemento
  order: string[]
  messages: string[]
}

function harness(c: AlertConfig, answer: string | undefined = undefined): Harness {
  const memento = new FakeMemento()
  const order: string[] = []
  const messages: string[] = []
  const alerts = new Alerts(memento, c, () => {}, (msg) => {
    order.push('notify')
    messages.push(msg)
    return Promise.resolve(answer)
  }, { staleAfterMs: 20 * 60_000 })
  const originalUpdate = memento.update.bind(memento)
  memento.update = (key: string, value: unknown) => {
    order.push('update')
    return originalUpdate(key, value)
  }
  return { alerts, memento, order, messages }
}

const noVerdicts = new Map<string, PaceVerdict>()
const noForecasts = new Map<string, Forecast>()

test('every trigger switched off means the module says nothing', async () => {
  const h = harness(cfg())
  const out = await h.alerts.evaluate([quota([win({ percent: 99 })])], noVerdicts, noForecasts, NOW)
  assert.equal(out.length, 0)
  assert.equal(h.messages.length, 0)
})

test('a threshold speaks once, and again only when a higher one breaks', async () => {
  const h = harness(cfg({ thresholds: [80, 90] }))
  const first = await h.alerts.evaluate([quota([win({ percent: 82 })])], noVerdicts, noForecasts, NOW)
  assert.equal(first.length, 1)
  assert.equal(first[0].kind, 'threshold')
  assert.match(first[0].message, /threshold 80 %/)

  const again = await h.alerts.evaluate([quota([win({ percent: 85 })])], noVerdicts, noForecasts, NOW + 60_000)
  assert.equal(again.length, 0, 'the same threshold must not speak twice')

  const higher = await h.alerts.evaluate([quota([win({ percent: 91 })])], noVerdicts, noForecasts, NOW + 120_000)
  assert.equal(higher.length, 1)
  assert.match(higher[0].message, /threshold 90 %/)
  assert.equal(h.messages.length, 2)
})

test('a new reset time is a new subject', async () => {
  const h = harness(cfg({ thresholds: [80] }))
  await h.alerts.evaluate([quota([win({ percent: 82 })])], noVerdicts, noForecasts, NOW)
  const nextCycle = await h.alerts.evaluate(
    [quotaAt(NOW + HOUR, [win({ percent: 82, resetsAt: NOW + 8 * HOUR })])], noVerdicts, noForecasts, NOW + HOUR,
  )
  assert.equal(nextCycle.length, 1)
})

test('several breached thresholds become one message per provider', async () => {
  const h = harness(cfg({ thresholds: [80, 90] }))
  const out = await h.alerts.evaluate([
    quota([
      win({ id: 'session:300', label: '5 h', percent: 82 }),
      win({ id: 'weekly_all:10080', kind: 'weekly', label: '7 d', percent: 95, resetsAt: NOW + 40 * HOUR }),
    ]),
  ], noVerdicts, noForecasts, NOW)

  assert.equal(out.length, 1)
  assert.equal(out[0].windowIds.length, 2)
  assert.equal(h.messages.length, 1)
  assert.match(h.messages[0], /5 h at 82 %/)
  assert.match(h.messages[0], /7 d at 95 %/)
})

test('a stale reading never triggers anything', async () => {
  const h = harness(cfg({ thresholds: [80] }))
  const old = quota([win({ percent: 99 })], { fetchedAt: Math.floor((NOW - 60 * 60_000) / 1000) })
  const out = await h.alerts.evaluate([old], noVerdicts, noForecasts, NOW)
  assert.equal(out.length, 0)

  const unknownAge = quota([win({ percent: 99 })], { fetchedAt: null })
  assert.equal((await h.alerts.evaluate([unknownAge], noVerdicts, noForecasts, NOW)).length, 0)

  const failed = quota([win({ percent: 99 })], { ok: false, problem: 'no token' })
  assert.equal((await h.alerts.evaluate([failed], noVerdicts, noForecasts, NOW)).length, 0)
})

test('a remaining threshold is the same statement as a used one', () => {
  assert.deepEqual(usedThresholds(cfg({ thresholds: [20, 10], basis: 'remaining' })), [80, 90])
  assert.deepEqual(usedThresholds(cfg({ thresholds: [90, 80, 80] })), [80, 90])
  assert.deepEqual(usedThresholds(cfg({ thresholds: [Number.NaN, 140, -3] })), [])
})

test('basis remaining reports what is left, and only past the line', async () => {
  const h = harness(cfg({ thresholds: [20], basis: 'remaining' }))
  assert.equal((await h.alerts.evaluate([quota([win({ percent: 75 })])], noVerdicts, noForecasts, NOW)).length, 0)
  const out = await h.alerts.evaluate([quota([win({ percent: 82 })])], noVerdicts, noForecasts, NOW + 60_000)
  assert.equal(out.length, 1)
  assert.match(out[0].message, /has 18 % left \(threshold 20 %\)/)
})

test('requireAhead waits for the pace verdict, and does not consume the threshold', async () => {
  const h = harness(cfg({ thresholds: [80], requireAhead: true }))
  const key = 'claude:session:300'

  const calm = new Map([[key, verdict('ok')]])
  assert.equal((await h.alerts.evaluate([quota([win({ percent: 82 })])], calm, noForecasts, NOW)).length, 0)

  const ahead = new Map([[key, verdict('warn')]])
  const out = await h.alerts.evaluate([quota([win({ percent: 82 })])], ahead, noForecasts, NOW + 60_000)
  assert.equal(out.length, 1)
})

test('a window that resets within minRemainingMinutes stays quiet', async () => {
  const h = harness(cfg({ thresholds: [80], minRemainingMinutes: 60 }))
  const soon = win({ percent: 95, resetsAt: NOW + 20 * 60_000 })
  assert.equal((await h.alerts.evaluate([quota([soon])], noVerdicts, noForecasts, NOW)).length, 0)

  // Same cycle, but now far enough from the reset: the threshold may still speak.
  const later = win({ percent: 95, resetsAt: NOW + 20 * 60_000 })
  const out = await h.alerts.evaluate([quota([later])], noVerdicts, noForecasts, NOW - 2 * HOUR)
  assert.equal(out.length, 1)
})

test('use it or lose it fires once for a barely used weekly window', async () => {
  const h = harness(cfg({ useItLoseIt: true }))
  const weekly = win({ id: 'weekly_all:10080', kind: 'weekly', label: '7 d', percent: 42, resetsAt: NOW + 30 * HOUR })
  const out = await h.alerts.evaluate([quota([weekly])], noVerdicts, noForecasts, NOW)
  assert.equal(out.length, 1)
  assert.equal(out[0].kind, 'useItLoseIt')
  assert.equal(out[0].level, 'info')
  assert.equal((await h.alerts.evaluate([quota([weekly])], noVerdicts, noForecasts, NOW + 60_000)).length, 0)

  const busy = win({ id: 'weekly_all:10080', kind: 'weekly', percent: 80, resetsAt: NOW + 30 * HOUR })
  assert.equal((await h.alerts.evaluate([quota([busy])], noVerdicts, noForecasts, NOW)).length, 0)
})

test('the forecast lead warns once, and never past a reset that comes first', async () => {
  const h = harness(cfg({ forecastLeadMinutes: 60 }))
  const key = 'claude:session:300'
  const w = win({ percent: 70 })

  const late = new Map([[key, forecast({ etaMs: NOW + 4 * HOUR })]])
  assert.equal((await h.alerts.evaluate([quota([w])], noVerdicts, late, NOW)).length, 0)

  const afterReset = new Map([[key, forecast({ etaMs: NOW + 3 * HOUR + 60_000 })]])
  assert.equal((await h.alerts.evaluate([quota([w])], noVerdicts, afterReset, NOW)).length, 0)

  const soon = new Map([[key, forecast()]])
  const out = await h.alerts.evaluate([quota([w])], noVerdicts, soon, NOW)
  assert.equal(out.length, 1)
  assert.equal(out[0].kind, 'forecast')
  assert.equal((await h.alerts.evaluate([quota([w])], noVerdicts, soon, NOW + 60_000)).length, 0)
})

test('onPaceFast speaks on the flip and then holds its peace', async () => {
  const h = harness(cfg({ onPaceFast: true }))
  const key = 'claude:session:300'
  const w = win({ percent: 60 })

  assert.equal(
    (await h.alerts.evaluate([quota([w])], new Map([[key, verdict('ok')]]), noForecasts, NOW)).length, 0,
  )
  const out = await h.alerts.evaluate([quota([w])], new Map([[key, verdict('warn')]]), noForecasts, NOW + 60_000)
  assert.equal(out.length, 1)
  assert.equal(out[0].kind, 'pace')
  assert.equal(
    (await h.alerts.evaluate([quota([w])], new Map([[key, verdict('warn2')]]), noForecasts, NOW + 120_000)).length,
    0,
  )
})

test('windowCondition decides which kinds may speak', async () => {
  const weekly = win({ id: 'weekly_all:10080', kind: 'weekly', label: '7 d', percent: 95, resetsAt: NOW + 40 * HOUR })
  const session = win({ percent: 95 })

  const only = harness(cfg({ thresholds: [90], windowCondition: 'weeklyOnly' }))
  const out = await only.alerts.evaluate([quota([session, weekly])], noVerdicts, noForecasts, NOW)
  assert.equal(out.length, 1)
  assert.deepEqual(out[0].windowIds, ['weekly_all:10080'])
})

test('the state is written before the notification is shown', async () => {
  const h = harness(cfg({ thresholds: [80] }))
  await h.alerts.evaluate([quota([win({ percent: 82 })])], noVerdicts, noForecasts, NOW)
  assert.deepEqual(h.order, ['update', 'notify'])
})

test('"Open Dashboard" is handed back as a command, not executed here', async () => {
  const h = harness(cfg({ thresholds: [80] }), ACTION_DASHBOARD)
  const out = await h.alerts.evaluate([quota([win({ percent: 82 })])], noVerdicts, noForecasts, NOW)
  assert.equal(out[0].command, DASHBOARD_COMMAND)
})

test('"Not today" snoozes until the next local midnight', async () => {
  const h = harness(cfg({ thresholds: [80, 90] }), ACTION_SNOOZE)
  const out = await h.alerts.evaluate([quota([win({ percent: 82 })])], noVerdicts, noForecasts, NOW)
  const until = out[0].snoozedUntil
  assert.ok(until !== undefined)
  assert.equal(until, nextLocalMidnight(NOW))
  assert.ok(until > NOW && until - NOW <= 24 * HOUR)
  const midnight = new Date(until)
  assert.equal(midnight.getHours(), 0)
  assert.equal(midnight.getMinutes(), 0)

  // Any moment inside the snooze — how far away midnight is depends on the
  // machine's zone, so the point is derived rather than assumed.
  const midway = NOW + Math.floor((until - NOW) / 2)
  const during = await h.alerts.evaluate(
    [quotaAt(midway, [win({ percent: 95 })])], noVerdicts, noForecasts, midway,
  )
  assert.equal(during.length, 0, 'a snooze silences everything, not just the threshold that caused it')

  const after = await h.alerts.evaluate(
    [quotaAt(until + 1, [win({ percent: 95, resetsAt: until + 3 * HOUR })])], noVerdicts, noForecasts, until + 1,
  )
  assert.equal(after.length, 1)
})

test('the buttons offered are always the same two', async () => {
  const memento = new FakeMemento()
  const seen: string[][] = []
  const alerts = new Alerts(memento, cfg({ thresholds: [80] }), () => {}, (_m, actions) => {
    seen.push(actions)
    return Promise.resolve(undefined)
  })
  await alerts.evaluate([quota([win({ percent: 82 })])], noVerdicts, noForecasts, NOW)
  assert.deepEqual(seen, [[ACTION_DASHBOARD, ACTION_SNOOZE]])
})
