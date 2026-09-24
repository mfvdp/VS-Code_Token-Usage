// SPDX-FileCopyrightText: 2026 Frederik Marx
// SPDX-License-Identifier: AGPL-3.0-or-later

import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { setBundle, setLocale } from '../src/i18n'
import {
  addDays, ageText, attemptWhen, calendarDayOf, calendarWeekdayOf, clockStamp, dayCount, dayOf, dayOfHour, daysBetween, formatReset,
  formatTime, hourIndex, lastDays, lastFailureText, localHourOfDay, monthOf, nextAttemptWords, previousRange, rangeFor, refreshWords,
  relativeShort, relativeTime, resolveZone, retryWords, TimeConfig, weekdayOf, weekdayWords,
} from '../src/time'
import { QuotaState } from '../src/types'
import { ROOT } from './helpers/nls'

const utc: TimeConfig = { zone: 'utc', dayBoundaryHour: 0, startOfWeek: 'monday', hourCycle: 'h23' }
const berlin: TimeConfig = { ...utc, zone: 'Europe/Berlin' }
const ny: TimeConfig = { ...utc, zone: 'America/New_York' }
const system: TimeConfig = { ...utc, zone: 'system' }

/** 2026-09-03 is a Thursday — every range assertion below is anchored to it. */
const NOW = Date.UTC(2026, 8, 3, 12, 0)

test('resolveZone: aliases, IANA names and the silent fallback', () => {
  assert.equal(resolveZone('system'), undefined)
  assert.equal(resolveZone(''), undefined)
  assert.equal(resolveZone('utc'), 'UTC')
  assert.equal(resolveZone('UTC'), 'UTC')
  assert.equal(resolveZone('Europe/Berlin'), 'Europe/Berlin')
  assert.equal(resolveZone('Mars/Olympus'), undefined)
  assert.equal(resolveZone('Europe/Berlin; DROP'), undefined)
})

test('dayOf maps one instant to different days per zone', () => {
  const ms = Date.UTC(2026, 0, 1, 23, 30)
  assert.equal(dayOf(ms, utc), '2026-01-01')
  assert.equal(dayOf(ms, berlin), '2026-01-02')
  assert.equal(dayOf(ms, ny), '2026-01-01')
})

test('an invalid zone behaves exactly like the system zone', () => {
  const ms = Date.UTC(2026, 5, 15, 4, 5)
  assert.equal(dayOf(ms, { ...utc, zone: 'Mars/Olympus' }), dayOf(ms, system))
  assert.equal(localHourOfDay(hourIndex(ms), { ...utc, zone: 'Nope' }), localHourOfDay(hourIndex(ms), system))
})

test('dayBoundaryHour moves the small hours to the previous day', () => {
  const ms = Date.UTC(2026, 2, 10, 3, 0)
  assert.equal(dayOf(ms, utc), '2026-03-10')
  assert.equal(dayOf(ms, { ...utc, dayBoundaryHour: 6 }), '2026-03-09')
  assert.equal(dayOf(Date.UTC(2026, 2, 10, 6, 0), { ...utc, dayBoundaryHour: 6 }), '2026-03-10')
  // Out-of-range settings are clamped, never applied as-is.
  assert.equal(dayOf(ms, { ...utc, dayBoundaryHour: 99 }), dayOf(ms, { ...utc, dayBoundaryHour: 23 }))
  assert.equal(dayOf(ms, { ...utc, dayBoundaryHour: NaN }), '2026-03-10')
})

test('hour helpers: index, day of an hour bucket, local hour, month', () => {
  const ms = Date.UTC(2026, 0, 1, 23, 30)
  const h = hourIndex(ms)
  assert.equal(h, Math.floor(ms / 3_600_000))
  assert.equal(dayOfHour(h, utc), '2026-01-01')
  assert.equal(dayOfHour(h, berlin), '2026-01-02')
  assert.equal(localHourOfDay(h, utc), 23)
  assert.equal(localHourOfDay(h, berlin), 0)
  assert.equal(monthOf('2026-01-01'), '2026-01')
})

test('weekdayOf is relative to the configured start of week', () => {
  assert.equal(weekdayOf('2026-09-03', utc), 3)
  assert.equal(weekdayOf('2026-09-03', { ...utc, startOfWeek: 'sunday' }), 4)
  assert.equal(weekdayOf('2026-08-31', utc), 0)
})

test('addDays / daysBetween / dayCount are calendar arithmetic, DST included', () => {
  assert.equal(addDays('2026-02-28', 1), '2026-03-01')
  assert.equal(addDays('2026-03-29', -1), '2026-03-28')
  assert.equal(addDays('2026-01-01', -1), '2025-12-31')
  assert.deepEqual(daysBetween('2026-01-30', '2026-02-02'),
    ['2026-01-30', '2026-01-31', '2026-02-01', '2026-02-02'])
  assert.deepEqual(daysBetween('2026-02-02', '2026-01-30'), [])
  assert.deepEqual(daysBetween('nope', '2026-01-30'), [])
  assert.equal(dayCount('2026-01-01', '2026-01-01'), 1)
  assert.equal(dayCount('2026-01-01', '2026-01-07'), 7)
})

test('lastDays ends on the zone-local today', () => {
  assert.deepEqual(lastDays(3, NOW, utc), ['2026-09-01', '2026-09-02', '2026-09-03'])
  assert.deepEqual(lastDays(1, Date.UTC(2026, 8, 3, 23, 30), berlin), ['2026-09-04'])
  assert.deepEqual(lastDays(0, NOW, utc), [])
})

test('rangeFor covers every preset', () => {
  const r = (p: Parameters<typeof rangeFor>[0], cfg = utc, first?: string) => {
    const x = rangeFor(p, NOW, cfg, first)
    return `${x.from}..${x.to}`
  }
  assert.equal(r('today'), '2026-09-03..2026-09-03')
  assert.equal(r('yesterday'), '2026-09-02..2026-09-02')
  assert.equal(r('7d'), '2026-08-28..2026-09-03')
  assert.equal(r('30d'), '2026-08-05..2026-09-03')
  assert.equal(r('90d'), '2026-06-06..2026-09-03')
  assert.equal(r('thisWeek'), '2026-08-31..2026-09-03')
  assert.equal(r('thisWeek', { ...utc, startOfWeek: 'sunday' }), '2026-08-30..2026-09-03')
  assert.equal(r('thisMonth'), '2026-09-01..2026-09-03')
  assert.equal(r('lastMonth'), '2026-08-01..2026-08-31')
  assert.equal(r('year'), '2026-01-01..2026-09-03')
  assert.equal(r('all', utc, '2025-11-20'), '2025-11-20..2026-09-03')
  // No first day known: claiming coverage back to the epoch would be a lie.
  assert.equal(r('all'), '2026-09-03..2026-09-03')
  assert.equal(rangeFor('7d', NOW, utc).label, 'Last 7 days')
  assert.equal(rangeFor('all', NOW, utc).preset, 'all')
})

test('custom ranges are validated, ordered and clamped to five years', () => {
  const ok = rangeFor({ from: '2026-01-01', to: '2026-01-31' }, NOW, utc)
  assert.equal(ok.preset, 'custom')
  assert.equal(ok.label, '2026-01-01 → 2026-01-31')
  const flipped = rangeFor({ from: '2026-01-31', to: '2026-01-01' }, NOW, utc)
  assert.equal(flipped.from, '2026-01-01')
  assert.equal(flipped.to, '2026-01-31')
  const huge = rangeFor({ from: '2000-01-01', to: '2026-09-03' }, NOW, utc)
  assert.equal(dayCount(huge.from, huge.to), 1826)
  assert.equal(huge.to, '2026-09-03')
  const junk = rangeFor({ from: 'x', to: 'y' }, NOW, utc)
  assert.equal(junk.from, '2026-09-03')
})

test('previousRange is the equally long span right before — except for all', () => {
  const prev7 = previousRange(rangeFor('7d', NOW, utc))
  assert.deepEqual([prev7?.from, prev7?.to], ['2026-08-21', '2026-08-27'])
  assert.equal(prev7?.label, 'Previous 7 days')
  const prevToday = previousRange(rangeFor('today', NOW, utc))
  assert.deepEqual([prevToday?.from, prevToday?.to], ['2026-09-02', '2026-09-02'])
  assert.equal(prevToday?.label, 'Previous day')
  const prevMonth = previousRange(rangeFor('lastMonth', NOW, utc))
  assert.deepEqual([prevMonth?.from, prevMonth?.to], ['2026-07-01', '2026-07-31'])
  assert.equal(previousRange(rangeFor('all', NOW, utc)), null)
})

test('relativeShort: compact countdown, never negative', () => {
  const now = 0
  assert.equal(relativeShort(now + (2 * 3600 + 14 * 60) * 1000, now), '2h14m')
  assert.equal(relativeShort(now + 45 * 60_000, now), '45m')
  assert.equal(relativeShort(now + (3 * 24 + 5) * 3_600_000, now), '3d 5h')
  assert.equal(relativeShort(now + 3 * 24 * 3_600_000, now), '3d')
  assert.equal(relativeShort(now + 2 * 3_600_000, now), '2h')
  assert.equal(relativeShort(now + 30_000, now), '<1m')
  assert.equal(relativeShort(now - 1, now), 'reset due')
  assert.equal(relativeShort(now, now), 'reset due')
})

test('formatReset: every format, and nothing at all without a reset time', () => {
  const now = Date.UTC(2026, 8, 3, 3, 46)
  const soon = Date.UTC(2026, 8, 3, 6, 0)          // 2 h 14 min ahead
  const monday = Date.UTC(2026, 8, 7, 6, 0)         // more than a day ahead
  assert.equal(formatReset(null, now, 'both', utc), '')
  assert.equal(formatReset(soon, now, 'none', utc), '')
  assert.equal(formatReset(soon, now, 'relative', utc), '2h14m')
  assert.equal(formatReset(soon, now, 'absolute', utc), '06:00')
  assert.equal(formatReset(soon, now, 'both', utc), '06:00 (in 2h14m)')
  assert.equal(formatReset(soon, now, 'absolute', { ...utc, hourCycle: 'h12' }), '06:00 AM')
  // Weekday prefix once the day is no longer obvious.
  assert.equal(formatReset(monday, now, 'absolute', utc), 'Mo 06:00')
  assert.equal(formatReset(monday, now, 'both', utc), 'Mo 06:00 (in 4d 2h)')
  // Past reset: a countdown would go negative, so it says what is actually true.
  assert.equal(formatReset(now - 60_000, now, 'relative', utc), 'reset due')
  assert.equal(formatReset(now - 60_000, now, 'both', utc), '03:45 (reset due)')
  // Zone-aware: the same instant, a different wall clock.
  assert.equal(formatReset(soon, now, 'absolute', berlin), '08:00')
})

test('formatReset says "reset due" only once the reset is actually due', () => {
  const now = Date.UTC(2026, 8, 3, 3, 46)
  for (const ahead of [1, 1000, 60_000, 3_600_000]) {
    assert.notEqual(formatReset(now + ahead, now, 'relative', utc), 'reset due')
    assert.doesNotMatch(formatReset(now + ahead, now, 'both', utc), /reset due/)
  }
  assert.equal(formatReset(now, now, 'relative', utc), 'reset due')
  assert.equal(formatReset(now - 1, now, 'relative', utc), 'reset due')
})

test('a reset string never carries the verb the views put in front of it', () => {
  // The dashboard prints " · resets " before the countdown; a "resets" in here would come
  // out as "resets reset due".
  const now = Date.UTC(2026, 8, 3, 3, 46)
  for (const at of [now - 60_000, now, now + 60_000, now + 5 * 86_400_000]) {
    for (const fmt of ['relative', 'absolute', 'both'] as const) {
      assert.doesNotMatch(formatReset(at, now, fmt, utc), /resets/)
    }
  }
})

test("hourCycle 'auto' follows the machine, and stays one of the two forms", () => {
  const t = Date.UTC(2026, 8, 3, 6, 0)
  const auto = formatTime(t, { ...utc, hourCycle: 'auto' })
  assert.ok(auto === '06:00' || auto === '06:00 AM', `unexpected auto form ${auto}`)
})

test('the clock is spelled with ordinary spaces, whatever ICU does this year', () => {
  // CLDR 42 (ICU 72) put U+202F before AM/PM in en-US and CLDR 48 (ICU 78) took it back
  // out; both ship inside Node 22, so an unnormalised string differs from runner to runner
  // — and `package.nls.json` documents exactly one of the two ("06:00 AM"). The character
  // is invisible, which is precisely why it has to be asserted.
  const t = Date.UTC(2026, 8, 3, 6, 0)
  for (const cfg of [
    { ...utc, hourCycle: 'h12' as const },
    { ...utc, hourCycle: 'h23' as const },
    { ...utc, hourCycle: 'auto' as const },
    { ...berlin, hourCycle: 'h12' as const },
  ]) {
    for (const withWeekday of [false, true]) {
      const out = formatTime(t, cfg, withWeekday)
      assert.doesNotMatch(out, /[\u00a0\u202f\u2007\u2009]/, `${JSON.stringify(out)} carries an exotic space`)
    }
  }
  assert.equal(formatTime(t, { ...utc, hourCycle: 'h12' }), '06:00 AM')
})

test('ageText names absence instead of showing a zero age', () => {
  const now = Date.UTC(2026, 8, 3, 12, 0)
  assert.equal(ageText(null, now), null)
  assert.equal(ageText(0, now), null)
  assert.equal(ageText(now / 1000 - 30, now), 'just now')
  assert.equal(ageText(now / 1000 - 12 * 60, now), '12 min ago')
  assert.equal(ageText(now / 1000 - 3 * 3600, now), '3 h ago')
  assert.equal(ageText(now / 1000 - 3 * 86400, now), '3 d ago')
})

test('relativeTime keeps its long form (tooltips, tables)', () => {
  const now = 0
  assert.equal(relativeTime((2 * 3600 + 14 * 60) * 1000, now), 'in 2 h 14 min')
  assert.equal(relativeTime(-180_000, now), '3 min ago')
  assert.equal(relativeTime(60 * 3_600_000, now), 'in 2 d 12 h')
})

test('the calendar day and weekday of an instant follow the zone and leave the day boundary aside (1.6 N6)', () => {
  // 23:30 UTC on Wednesday 2026-09-02 is Thursday 01:30 in Berlin and still Wednesday in New York.
  const ms = Date.UTC(2026, 8, 2, 23, 30)
  assert.equal(calendarDayOf(ms, utc), '2026-09-02')
  assert.equal(calendarDayOf(ms, berlin), '2026-09-03')
  assert.equal(calendarWeekdayOf(ms, utc), 3)
  assert.equal(calendarWeekdayOf(ms, berlin), 4)
  assert.equal(calendarWeekdayOf(ms, ny), 3)
  // A day boundary at 06:00 counts 01:30 into the day before; the calendar does not.
  const late = { ...berlin, dayBoundaryHour: 6 }
  assert.equal(dayOf(ms, late), '2026-09-02')
  assert.equal(calendarDayOf(ms, late), '2026-09-03')
  assert.equal(calendarWeekdayOf(ms, late), 4)
  assert.deepEqual(weekdayWords(), ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'])
})

// ---------------------------------------------------------------------------
// 1.7 W1, W2: the next attempt and the failed one
// ---------------------------------------------------------------------------

/** The bundle the extension ships, installed for the length of `run`. */
function german<T>(run: () => T): T {
  const bundle = JSON.parse(readFileSync(join(ROOT, 'l10n', 'bundle.l10n.de.json'), 'utf8')) as Record<string, string>
  try {
    setBundle(bundle)
    setLocale('de')
    return run()
  } finally {
    setBundle(undefined)
    setLocale(undefined)
  }
}

test('attemptWhen: a countdown ahead, due once passed, waiting for focus while held — never a reset (1.7 W2)', () => {
  assert.deepEqual(attemptWhen(NOW + 72 * 60_000, null, NOW), { kind: 'in', text: '1h12m' })
  assert.deepEqual(attemptWhen(NOW - 1, null, NOW), { kind: 'due' })
  assert.deepEqual(attemptWhen(NOW, undefined, NOW), { kind: 'due' })
  assert.deepEqual(attemptWhen(NOW - 1, 'focus', NOW), { kind: 'focus' })
  // A hold says nothing about a time still ahead: the countdown stands.
  assert.deepEqual(attemptWhen(NOW + 60_000, 'focus', NOW), { kind: 'in', text: '1m' })
  assert.equal(attemptWhen(null, null, NOW), null)
  assert.equal(attemptWhen(undefined, 'focus', NOW), null)
  assert.equal(attemptWhen(NaN, null, NOW), null)
  assert.equal(attemptWhen(Infinity, null, NOW), null)
  assert.equal(attemptWhen(NOW + 60_000, null, NaN), null)
  // Every time ahead is a duration, whatever relativeShort says of a time that has passed.
  for (let ms = 1; ms <= 3 * 3_600_000; ms += 59_999) {
    const w = attemptWhen(NOW + ms, null, NOW)
    assert.equal(w?.kind, 'in')
    assert.notEqual((w as { text: string }).text, 'reset due')
  }
})

test('the attempt words in English and German — one set for the status bar, the sentence and the freshness column (1.7 W2)', () => {
  const ahead = attemptWhen(NOW + 72 * 60_000, null, NOW)
  const due = attemptWhen(NOW - 1, null, NOW)
  const held = attemptWhen(NOW - 1, 'focus', NOW)
  const en = [ahead, due, held].map((w) => [retryWords(w), nextAttemptWords(w!), refreshWords(w!)])
  assert.deepEqual(en, [
    ['retry 1h12m', 'next attempt in 1h12m', '1h12m'],
    ['retry due', 'next attempt due', 'due'],
    ['retry waiting for focus', 'next attempt waiting for focus', 'waiting for focus'],
  ])
  assert.equal(retryWords(null), 'retry')
  const de = german(() => [ahead, due, held].map((w) => [retryWords(w), nextAttemptWords(w!), refreshWords(w!)]))
  assert.deepEqual(de, [
    ['neuer Versuch in 1h12m', 'nächster Versuch in 1h12m', '1h12m'],
    ['neuer Versuch fällig', 'nächster Versuch fällig', 'fällig'],
    ['neuer Versuch wartet auf Fokus', 'nächster Versuch wartet auf Fokus', 'wartet auf Fokus'],
  ])
  assert.equal(german(() => retryWords(null)), 'neuer Versuch')
  // None of them is ever a reset's word.
  for (const words of [...en.flat(), ...de.flat()]) assert.doesNotMatch(words, /reset due|Reset fällig/)
})

test('clockStamp: the clock time today, the day in front on any other day — the day boundary as dayOf has it (1.7 W1)', () => {
  assert.equal(clockStamp(NOW - 20 * 60_000, NOW, utc), '11:40')
  assert.equal(clockStamp(Date.UTC(2026, 8, 2, 14, 20), NOW, utc), '2026-09-02 14:20')
  assert.equal(clockStamp(Date.UTC(2026, 8, 3, 14, 20), NOW, berlin), '16:20')
  // 02:30 with a boundary at 06:00 belongs to the day before, as the agent tree has always said it.
  const late = { ...utc, dayBoundaryHour: 6 }
  const small = Date.UTC(2026, 8, 3, 2, 30)
  assert.equal(clockStamp(small, NOW, late), '2026-09-02 02:30')
  assert.equal(clockStamp(small, Date.UTC(2026, 8, 3, 5, 0), late), '02:30')
  for (const ms of [small, NOW - 1, NOW - 26 * 3_600_000, NOW + 90 * 60_000]) {
    for (const cfg of [utc, berlin, ny, late]) {
      const time = formatTime(ms, cfg)
      assert.equal(clockStamp(ms, NOW, cfg), dayOf(ms, cfg) === dayOf(NOW, cfg) ? time : `${dayOf(ms, cfg)} ${time}`)
    }
  }
})

function failedState(over: Partial<QuotaState> = {}): QuotaState {
  return {
    source: 'claude', ok: true, origin: 'poll', fetchedAt: Math.floor((NOW - 2 * 3_600_000) / 1000), planType: null,
    windows: [], nextAttemptAt: NOW + 72 * 60_000, attemptHeld: null,
    lastFailure: { at: NOW - 20 * 60_000, problem: 'HTTP 429 — backing off before the next attempt', kind: 'retry' },
    ...over,
  }
}

test('lastFailureText: when, the poller\'s words verbatim, then the next attempt — EN and DE (1.7 W1)', () => {
  assert.equal(lastFailureText(failedState(), NOW, utc),
    'Last attempt at 11:40 failed: HTTP 429 — backing off before the next attempt · next attempt in 1h12m')
  assert.equal(lastFailureText(failedState({ nextAttemptAt: NOW - 1 }), NOW, utc),
    'Last attempt at 11:40 failed: HTTP 429 — backing off before the next attempt · next attempt due')
  assert.equal(lastFailureText(failedState({ nextAttemptAt: NOW - 1, attemptHeld: 'focus' }), NOW, utc),
    'Last attempt at 11:40 failed: HTTP 429 — backing off before the next attempt · next attempt waiting for focus')
  // No known next attempt: the sentence ends with the failure, no invented time.
  assert.equal(lastFailureText(failedState({ nextAttemptAt: null }), NOW, utc),
    'Last attempt at 11:40 failed: HTTP 429 — backing off before the next attempt')
  // Another day: the day in front.
  assert.equal(lastFailureText(failedState({
    lastFailure: { at: Date.UTC(2026, 8, 2, 14, 20), problem: 'timeout while fetching', kind: 'offline' },
  }), NOW, utc), 'Last attempt at 2026-09-02 14:20 failed: timeout while fetching · next attempt in 1h12m')
  // The markup variant wraps the reason and nothing else.
  assert.equal(lastFailureText(failedState(), NOW, utc, (p) => `\`${p}\``),
    'Last attempt at 11:40 failed: `HTTP 429 — backing off before the next attempt` · next attempt in 1h12m')
  // Nothing without a failure, or with one that is no failure.
  assert.equal(lastFailureText(failedState({ lastFailure: null }), NOW, utc), null)
  assert.equal(lastFailureText(failedState({ lastFailure: undefined }), NOW, utc), null)
  assert.equal(lastFailureText(failedState({ lastFailure: { at: NaN, problem: 'x', kind: 'retry' } }), NOW, utc), null)
  assert.equal(lastFailureText(failedState({ lastFailure: { at: NOW, problem: '', kind: 'retry' } }), NOW, utc), null)
  // German: the sentence of the bundle, the poller's (German) words verbatim.
  const de = german(() => lastFailureText(failedState({
    lastFailure: { at: NOW - 20 * 60_000, problem: 'HTTP 429 — Wartezeit vor dem nächsten Versuch', kind: 'retry' },
  }), NOW, utc))
  assert.equal(de, 'Letzter Versuch um 11:40 fehlgeschlagen: HTTP 429 — Wartezeit vor dem nächsten Versuch · nächster Versuch in 1h12m')
  assert.equal(german(() => lastFailureText(failedState({ nextAttemptAt: NOW - 1, attemptHeld: 'focus' }), NOW, utc)),
    'Letzter Versuch um 11:40 fehlgeschlagen: HTTP 429 — backing off before the next attempt · nächster Versuch wartet auf Fokus')
})
