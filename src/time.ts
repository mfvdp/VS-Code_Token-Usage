// SPDX-FileCopyrightText: 2026 Frederik Marx
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Calendar arithmetic for the display layer, free of any vscode dependency.
 *
 * Buckets are stored per UTC hour; which local day, week or month an hour
 * belongs to is a *display* decision, so it is taken here and nowhere else.
 * All zone work goes through Intl rather than fixed offsets: a fixed offset is
 * wrong twice a year, and a day boundary that jumps by an hour would silently
 * move usage between days.
 */

import { locale, t } from './i18n'
// The attempt sentence reads two fields of a state and asks the one classification record of its kind
// (1.7 P4b); types.ts holds no reader, so this module stays free of any.
import { isTransientFailure } from './types'
import type { QuotaState } from './types'

/** IANA zone name, or the two aliases. An unusable name falls back to the system zone. */
export type Zone = 'system' | 'utc' | string

export type StartOfWeek =
  | 'monday' | 'tuesday' | 'wednesday' | 'thursday' | 'friday' | 'saturday' | 'sunday'

export interface TimeConfig {
  zone: Zone
  /** Hour at which a new day starts, 0..23 — for people whose day ends after midnight. */
  dayBoundaryHour: number
  startOfWeek: StartOfWeek
  hourCycle: 'auto' | 'h12' | 'h23'
}

/** What the machine's own settings say — the baseline every caller can start from. */
export const SYSTEM_TIME_CONFIG: TimeConfig = {
  zone: 'system', dayBoundaryHour: 0, startOfWeek: 'monday', hourCycle: 'auto',
}

const MS_HOUR = 3_600_000
const MS_DAY = 86_400_000

/**
 * Resolve a configured zone to something Intl accepts, or `undefined` for the
 * system zone. An invalid name is *not* an error the user has to fix in a
 * dialog: it silently falls back, because a broken setting must never stop the
 * status bar from showing numbers.
 */
const zoneCache = new Map<string, string | undefined>()
export function resolveZone(z: Zone): string | undefined {
  const raw = typeof z === 'string' ? z.trim() : ''
  if (!raw || raw.toLowerCase() === 'system' || raw.toLowerCase() === 'local') return undefined
  if (zoneCache.has(raw)) return zoneCache.get(raw)
  const name = raw.toLowerCase() === 'utc' ? 'UTC' : raw
  let ok: string | undefined
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: name })
    ok = name
  } catch {
    ok = undefined
  }
  zoneCache.set(raw, ok)
  return ok
}

/** Formatters are expensive to build and are hit on every redraw, so keep one per shape. */
const fmtCache = new Map<string, Intl.DateTimeFormat>()
function formatter(key: string, make: () => Intl.DateTimeFormat): Intl.DateTimeFormat {
  let f = fmtCache.get(key)
  if (!f) {
    f = make()
    fmtCache.set(key, f)
  }
  return f
}

interface ZoneParts { year: number; month: number; day: number; hour: number; minute: number }

/**
 * 1.8 L-2: the calendar parts of an instant are asked for again and again within one view-model
 * build — the day of every hour bucket, by every table that walks the buckets — and each answer
 * is an `Intl.DateTimeFormat.formatToParts` call, one of the heaviest of a build before 1.8 (1.8
 * L-2's profile). So the answers are kept, keyed by the zone and the instant's minute: the parts
 * carry nothing below the minute, and from 1973 on every zone's offset is a whole number of
 * minutes (`PARTS_MEMO_FROM_MS`), so two instants of one minute have the same parts. The pair is
 * the key — a map per zone of maps per minute, so that a hit builds no string. At most
 * `PARTS_MEMO_MAX` answers are kept; a full memo is cleared whole — no bookkeeping in the hot path.
 */
export const PARTS_MEMO_MAX = 20_000
/**
 * The first instant the memo keeps: before it a zone's offset could carry seconds — Liberia's
 * −0:44:30 until 1972-01-07, the last one in the zone data — and two instants of one minute could
 * then lie on two days. Earlier instants are formatted every time, as before 1.8.
 */
export const PARTS_MEMO_FROM_MS = Date.UTC(1973, 0, 1)
/** By zone (`resolveZone`'s name, '' for the system zone), then by the instant's minute. */
const partsMemo = new Map<string, Map<number, Readonly<ZoneParts>>>()
let partsMemoSize = 0
let partsMemoOn = true

/**
 * For tests: empties the calendar-parts memo and hands back how many answers it held. With
 * `memoise: false` the memo also stays off until the next call — every answer is formatted anew,
 * the path before 1.8 that the tests hold the memo to.
 */
export function resetTimeMemos(memoise = true): number {
  const held = partsMemoSize
  partsMemo.clear()
  partsMemoSize = 0
  partsMemoOn = memoise
  return held
}

function partsOf(ms: number, zone: string | undefined): Readonly<ZoneParts> {
  if (!partsMemoOn || !(ms >= PARTS_MEMO_FROM_MS)) return formatParts(ms, zone)
  const z = zone ?? ''
  const minute = Math.floor(ms / 60_000)
  let minutes = partsMemo.get(z)
  const hit = minutes?.get(minute)
  if (hit !== undefined) return hit
  const p = Object.freeze(formatParts(ms, zone))
  if (partsMemoSize >= PARTS_MEMO_MAX) {
    partsMemo.clear()
    partsMemoSize = 0
    minutes = undefined
  }
  if (!minutes) partsMemo.set(z, minutes = new Map())
  minutes.set(minute, p)
  partsMemoSize++
  return p
}

function formatParts(ms: number, zone: string | undefined): ZoneParts {
  const f = formatter(`p|${zone ?? ''}`, () => new Intl.DateTimeFormat('en-US', {
    timeZone: zone,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit',
    // h23 keeps midnight at 00 — 'hour12: false' still yields 24 in some ICU builds.
    hourCycle: 'h23',
  }))
  const out: ZoneParts = { year: 1970, month: 1, day: 1, hour: 0, minute: 0 }
  for (const p of f.formatToParts(ms)) {
    if (p.type === 'year') out.year = Number(p.value)
    else if (p.type === 'month') out.month = Number(p.value)
    else if (p.type === 'day') out.day = Number(p.value)
    else if (p.type === 'hour') out.hour = Number(p.value)
    else if (p.type === 'minute') out.minute = Number(p.value)
  }
  return out
}

function pad2(n: number): string { return String(n).padStart(2, '0') }
function pad4(n: number): string { return String(n).padStart(4, '0') }

function boundaryHour(cfg: TimeConfig): number {
  const h = Number(cfg.dayBoundaryHour)
  if (!Number.isFinite(h)) return 0
  return Math.min(23, Math.max(0, Math.floor(h)))
}

export function hourIndex(ms: number): number {
  return Math.floor(ms / MS_HOUR)
}

/**
 * Local calendar day of an instant, honouring `dayBoundaryHour`.
 *
 * The boundary is applied by moving the instant back before the calendar is
 * consulted, so 02:00 with a boundary of 6 lands on the previous day exactly as
 * a person working through the night would count it.
 */
export function dayOf(ms: number, cfg: TimeConfig): string {
  const p = partsOf(ms - boundaryHour(cfg) * MS_HOUR, resolveZone(cfg.zone))
  return `${pad4(p.year)}-${pad2(p.month)}-${pad2(p.day)}`
}

/** The day an hour bucket belongs to; the bucket is named by the instant it starts at. */
export function dayOfHour(hour: number, cfg: TimeConfig): string {
  return dayOf(hour * MS_HOUR, cfg)
}

export function monthOf(day: string): string {
  return day.slice(0, 7)
}

/** Wall-clock hour 0..23 of an hour bucket in the configured zone (no day boundary shift). */
export function localHourOfDay(hour: number, cfg: TimeConfig): number {
  return partsOf(hour * MS_HOUR, resolveZone(cfg.zone)).hour
}

const WEEK_START: Record<StartOfWeek, number> = {
  sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6,
}

/** A day string is a calendar fact, so it is parsed as UTC — no zone, no DST, no drift. */
function dayMs(day: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day)
  if (!m) return NaN
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
}

function fromMs(ms: number): string {
  const d = new Date(ms)
  return `${pad4(d.getUTCFullYear())}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`
}

export function isDay(day: string): boolean {
  return Number.isFinite(dayMs(day))
}

/** 0 = the configured first day of the week, so charts can be laid out without a lookup. */
export function weekdayOf(day: string, cfg: TimeConfig): number {
  const ms = dayMs(day)
  if (!Number.isFinite(ms)) return 0
  const start = WEEK_START[cfg.startOfWeek] ?? WEEK_START.monday
  return (new Date(ms).getUTCDay() - start + 7) % 7
}

/**
 * The calendar day of an instant in the configured zone — the date its clock reading belongs to,
 * `dayBoundaryHour` left aside. For a name that pairs a date with a clock time ("2026-09-01 02:30"):
 * the boundary is a rule for counting usage into days, and moving a 02:30 start to the day before
 * would put it on a date its own clock never showed.
 */
export function calendarDayOf(ms: number, cfg: TimeConfig): string {
  const p = partsOf(ms, resolveZone(cfg.zone))
  return `${pad4(p.year)}-${pad2(p.month)}-${pad2(p.day)}`
}

/**
 * The weekday of an instant's calendar day in the configured zone — 0 = Sunday … 6 = Saturday,
 * whatever the configured first day of the week; the day boundary left aside, as in
 * calendarDayOf. For "Tue 00:19": the weekday of the day the clock reading belongs to.
 */
export function calendarWeekdayOf(ms: number, cfg: TimeConfig): number {
  const d = dayMs(calendarDayOf(ms, cfg))
  return Number.isFinite(d) ? new Date(d).getUTCDay() : 0
}

/**
 * The seven weekday abbreviations, Sunday first, in the bundle's language — "Mon", „Mo". Built
 * on the call: the bundle is installed at activation, and a table filled before that would stay
 * English for good.
 */
export function weekdayWords(): string[] {
  return [t('Sun'), t('Mon'), t('Tue'), t('Wed'), t('Thu'), t('Fri'), t('Sat')]
}

export function addDays(day: string, n: number): string {
  const ms = dayMs(day)
  if (!Number.isFinite(ms)) return day
  return fromMs(ms + n * MS_DAY)
}

/** Inclusive, ascending; an inverted or unparsable range yields nothing rather than a guess. */
export function daysBetween(from: string, to: string): string[] {
  const a = dayMs(from)
  const b = dayMs(to)
  if (!Number.isFinite(a) || !Number.isFinite(b) || a > b) return []
  const out: string[] = []
  for (let t = a; t <= b; t += MS_DAY) out.push(fromMs(t))
  return out
}

/** Number of days in an inclusive range; 0 when either end is unusable. */
export function dayCount(from: string, to: string): number {
  const a = dayMs(from)
  const b = dayMs(to)
  if (!Number.isFinite(a) || !Number.isFinite(b) || a > b) return 0
  return Math.round((b - a) / MS_DAY) + 1
}

export function lastDays(n: number, now: number, cfg: TimeConfig): string[] {
  const count = Math.max(0, Math.floor(n))
  const today = dayOf(now, cfg)
  const out: string[] = []
  for (let i = count - 1; i >= 0; i--) out.push(addDays(today, -i))
  return out
}

export type RangePreset =
  | 'today' | 'yesterday' | '7d' | '30d' | '90d'
  | 'thisWeek' | 'thisMonth' | 'lastMonth' | 'year' | 'all'

export interface DayRange {
  from: string
  to: string
  label: string
  preset: RangePreset | 'custom'
}

/** Five years of daily buckets is already an unusual amount of scrolling; beyond that a
 *  custom range is a typo or a fuzzing attempt, and the clamp keeps rendering bounded. */
const MAX_SPAN_DAYS = 1826

function startOfWeekDay(day: string, cfg: TimeConfig): string {
  return addDays(day, -weekdayOf(day, cfg))
}

export function rangeFor(
  preset: RangePreset | { from: string; to: string },
  now: number,
  cfg: TimeConfig,
  firstDay?: string,
): DayRange {
  const today = dayOf(now, cfg)
  if (typeof preset !== 'string') {
    let from = isDay(preset.from) ? preset.from : today
    let to = isDay(preset.to) ? preset.to : today
    // A reversed range is a slip of the hand, not a request for an empty table.
    if (dayMs(from) > dayMs(to)) { const t = from; from = to; to = t }
    if (dayCount(from, to) > MAX_SPAN_DAYS) from = addDays(to, -(MAX_SPAN_DAYS - 1))
    // 1.13 (Review 2 F2): the label is data every outlet shares — the page's caption (one left-to-right unit there), the
    // markdown document's head line, the clipboard summary's heading, the JSON export's range.label — and keeps → in
    // every language; a Quick Pick adds its own arrow the way its line reads (bidi.ts rangeArrow).
    return { from, to, label: `${from} → ${to}`, preset: 'custom' }
  }
  switch (preset) {
    case 'today':
      return { from: today, to: today, label: t('Today'), preset }
    case 'yesterday': {
      const y = addDays(today, -1)
      return { from: y, to: y, label: t('Yesterday'), preset }
    }
    case '7d':
    case '30d':
    case '90d': {
      const n = Number(preset.slice(0, -1))
      return { from: addDays(today, -(n - 1)), to: today, label: t('Last {0} days', n), preset }
    }
    case 'thisWeek':
      return { from: startOfWeekDay(today, cfg), to: today, label: t('This week'), preset }
    case 'thisMonth':
      return { from: `${today.slice(0, 8)}01`, to: today, label: t('This month'), preset }
    case 'lastMonth': {
      const lastOfPrev = addDays(`${today.slice(0, 8)}01`, -1)
      return {
        from: `${lastOfPrev.slice(0, 8)}01`, to: lastOfPrev, label: t('Last month'), preset,
      }
    }
    case 'year':
      return { from: `${today.slice(0, 4)}-01-01`, to: today, label: t('This year'), preset }
    case 'all':
      // Without a first ingest day there is no coverage to claim — today is the honest floor.
      return {
        from: firstDay && isDay(firstDay) ? firstDay : today, to: today, label: t('All time'), preset,
      }
    default:
      return { from: today, to: today, label: t('Today'), preset: 'today' }
  }
}

/**
 * The equally long span immediately before `r`, for period-over-period deltas.
 * 'all' has no predecessor by definition — comparing against "everything before
 * everything" would invent a period that never existed.
 */
export function previousRange(r: DayRange): DayRange | null {
  if (r.preset === 'all') return null
  const len = dayCount(r.from, r.to)
  if (len <= 0) return null
  const to = addDays(r.from, -1)
  const from = addDays(to, -(len - 1))
  return {
    from, to, label: len === 1 ? t('Previous day') : t('Previous {0} days', len), preset: 'custom',
  }
}

export type ResetFormat = 'none' | 'relative' | 'absolute' | 'both'

/**
 * Which hour cycle 'auto' means. The setting exists because a 12-hour reader
 * misreads "18:00"; that preference lives in the OS locale, so it is read from
 * there. The digits themselves follow the seam's locale (`locale()` in i18n.ts:
 * en-US unless the editor runs in another language), so the status bar looks
 * the same on every machine of one language.
 */
let autoCycle: 'h12' | 'h23' | null = null
function systemHourCycle(): 'h12' | 'h23' {
  if (autoCycle) return autoCycle
  let c: string | undefined
  try {
    c = new Intl.DateTimeFormat(undefined, { hour: 'numeric' }).resolvedOptions().hourCycle
  } catch {
    c = undefined
  }
  autoCycle = c === 'h11' || c === 'h12' ? 'h12' : 'h23'
  return autoCycle
}

function effectiveCycle(c: TimeConfig['hourCycle']): 'h12' | 'h23' {
  return c === 'h12' || c === 'h23' ? c : systemHourCycle()
}

/**
 * One plain space, whatever ICU thinks this year.
 *
 * CLDR 42 (ICU 72) put a narrow no-break space before AM/PM in en-US; CLDR 48 (ICU 78) put
 * the ordinary space back. Both ship inside the *same* Node major, so two machines running
 * the same build print two different strings — and `package.nls.json` documents exactly one
 * of them ("06:00 AM"). The character is invisible; a status-bar text that silently changes
 * with a Node upgrade, and a settings example that then no longer matches what the user
 * sees, are not.
 */
function plainSpaces(s: string): string {
  return s.replace(/[\u202f\u00a0]/g, ' ')
}

/** "06:00" / "06:00 AM", with a weekday prefix when the day itself is in doubt. */
export function formatTime(ms: number, cfg: TimeConfig, withWeekday = false): string {
  const zone = resolveZone(cfg.zone)
  const cycle = effectiveCycle(cfg.hourCycle)
  const lang = locale()
  const f = formatter(`t|${lang}|${zone ?? ''}|${cycle}`, () => new Intl.DateTimeFormat(lang, {
    timeZone: zone, hour: '2-digit', minute: '2-digit', hourCycle: cycle,
  }))
  const time = plainSpaces(f.format(ms))
  if (!withWeekday) return time
  return `${weekdayLabel(ms, zone, lang)} ${time}`
}

/**
 * Per locale tag: how the weekday in front of a clock time is written — `short`, the locale's own short name as Intl
 * gives it; `two`, its first two characters; `bare`, the short name without a trailing '.'. Decided once per tag, from
 * `Intl` itself — the names are ICU's, and two machines with two ICU builds may disagree.
 */
const weekdayForms = new Map<string, 'short' | 'two' | 'bare'>()

/**
 * 1.9 P19 (§7c item 9): the languages whose bar keeps 1.8's two letters — English and German, the two languages 1.8
 * shipped: their manifests quote “· Mo 06:00” (the English is frozen, §0b.8), and 1.8's tests pin “Sa 14:20”. Decided
 * by the locale's primary subtag, so a regional English or German (`en-gb`, `de-ch` under `auto`) keeps them too.
 */
const TWO_LETTER_WEEKDAYS: ReadonlySet<string> = new Set(['en', 'de'])

function weekdayForm(lang: string): 'short' | 'two' | 'bare' {
  let known = weekdayForms.get(lang)
  if (known === undefined) {
    const f = new Intl.DateTimeFormat(lang, { timeZone: 'UTC', weekday: 'short' })
    // 2026-09-06 is a Sunday; seven days from there are the seven names, in any order.
    const names: string[] = []
    for (let d = 0; d < 7; d++) names.push(f.format(Date.UTC(2026, 8, 6 + d, 12)))
    const distinct = (xs: string[]): boolean => new Set(xs).size === 7 && xs.every((x) => x.length > 0)
    const primary = (f.resolvedOptions().locale.split('-')[0] ?? '').toLowerCase()
    const two = distinct(names.map((n) => n.slice(0, 2)))
    if (!TWO_LETTER_WEEKDAYS.has(primary) && distinct(names)) known = 'short'
    else known = two ? 'two' : 'bare'
    weekdayForms.set(lang, known)
  }
  return known
}

/**
 * 1.9 A5, revised by P19 (§7c item 9): the weekday in front of a clock time — the language's own short name, as Intl's
 * `weekday: 'short'` writes it (pl "pon.", tr "Pzt", fr "lun.", ja "月", zh-CN "周一"), where its seven are distinct.
 * The two-character prefix of 1.8 turned Polish "pon." into "po" — a word ("after") — and Turkish "Pzt" into "Pz". Where
 * the seven short names collide, the prefix rule of 1.9 A5: their first two characters when those give seven different
 * labels, else the whole short name without a trailing '.'. English and German keep 1.8's two letters ("Mo", "Sa"):
 * TWO_LETTER_WEEKDAYS. Decided per locale once, memoised by the locale tag.
 */
function weekdayLabel(ms: number, zone: string | undefined, lang: string): string {
  const w = formatter(`w|${lang}|${zone ?? ''}`, () => new Intl.DateTimeFormat(lang, {
    timeZone: zone, weekday: 'short',
  }))
  const name = plainSpaces(w.format(ms))
  const form = weekdayForm(lang)
  return form === 'short' ? name : form === 'two' ? name.slice(0, 2) : name.replace(/\.$/, '')
}

/**
 * "Sat 6 Sep": the calendar day of an instant in the configured zone, for a sparkline label
 * or a table cell. Weekday, day, month in that order whatever the locale — the label has to
 * stay narrow and read the same next to a clock time — with the locale's own names.
 *
 * 1.9 A5: that assembly drops the formatter's literals, which is harmless while the month part is
 * a word ("Sept.", "сент.", "9월"). Where the month part is digits only — ja, zh-CN, zh-TW, cs on
 * this ICU — the literals (`月`, `日`, `.`) are what makes the digits a date, and the assembly
 * printed `土 26 9`; such a locale gets the formatter's own `format()` (`9月26日(土)`, `so 26. 9.`).
 */
export function formatDay(ms: number, cfg: TimeConfig): string {
  const zone = resolveZone(cfg.zone)
  const lang = locale()
  const f = formatter(`d|${lang}|${zone ?? ''}`, () => new Intl.DateTimeFormat(lang, {
    timeZone: zone, weekday: 'short', day: 'numeric', month: 'short',
  }))
  const parts = f.formatToParts(ms)
  const part = (type: Intl.DateTimeFormatPart['type']): string => parts.find((p) => p.type === type)?.value ?? ''
  const month = part('month')
  if (!/\p{L}/u.test(month)) return plainSpaces(f.format(ms))
  return `${part('weekday')} ${part('day')} ${month}`
}

/**
 * Compact countdown: "45m", "2h14m", "3d 5h".
 *
 * A reset that has come and gone reads "reset due" — never a negative
 * countdown, and never a fresh window we have not actually seen reported.
 */
export function relativeShort(ms: number, now: number): string {
  if (!Number.isFinite(ms)) return ''
  const diff = ms - now
  if (diff <= 0) return t('reset due')
  const total = Math.floor(diff / 1000)
  if (total < 60) return '<1m'
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  if (h >= 24) {
    const d = Math.floor(h / 24)
    const rh = h % 24
    return rh > 0 ? `${d}d ${rh}h` : `${d}d`
  }
  if (h > 0) return m > 0 ? `${h}h${m}m` : `${h}h`
  return `${m}m`
}

/** "in 2 h 14 min" or "3 min ago" — the long form used in tooltips and tables. */
export function relativeTime(target: number, now = Date.now()): string {
  const diff = Math.round((target - now) / 1000)
  const past = diff < 0
  let s = Math.abs(diff)
  const h = Math.floor(s / 3600); s -= h * 3600
  const m = Math.floor(s / 60)
  let txt: string
  // Beyond two days, count in days — nobody converts "155 h 22 min" in their head.
  if (h >= 48) txt = `${Math.floor(h / 24)} d ${h % 24} h`
  else if (h > 0) txt = `${h} h ${String(m).padStart(2, '0')} min`
  else txt = `${m} min`
  return past ? t('{0} ago', txt) : t('in {0}', txt)
}

/**
 * The reset time as the status bar shows it. A window without a stated reset
 * gets an empty string: an invented countdown would be the most convincing
 * lie the extension could tell.
 *
 * The result never contains the word "resets" — a countdown reads as a duration
 * ("2h14m"), and a reset that has come and gone reads "reset due" and nothing
 * else. The verb stands in the callers' own whole messages, never here — in two
 * places: the view model's `WindowVm.resetLine` (`resetLineOf`:
 * `resets {0}` around a countdown, `resets at {0}` around a clock time, "reset
 * due" left alone) and the status bar's `resetSuffix` (`resets {0}` around the
 * `relative` form, `resets at {0}` around the `absolute` one, and for `both` its
 * own `resets at {0} (in {1})`, built from `resetClock` and `relativeShort`, not
 * from this function's text); a "resets" in here would come out of those as
 * "resets reset due".
 *
 * 1.11 D12: `both` is one whole message — "06:00 (in 2h14m)", "06:00 (reset due)",
 * the keys `{0} (in {1})` and `{0} (reset due)` — never brackets written here around
 * a translated piece: a language places its own brackets (CJK writes `（…）`) and its
 * own word order around the two figures. `resetClock` is the one definition of the
 * clock time and `relativeShort` of the countdown; every form here is built from them.
 */
export function formatReset(
  resetsAt: number | null,
  now: number,
  fmt: ResetFormat,
  cfg: TimeConfig,
): string {
  if (resetsAt === null || !Number.isFinite(resetsAt) || fmt === 'none') return ''
  const rel = relativeShort(resetsAt, now)
  if (fmt === 'relative') return rel
  const abs = resetClock(resetsAt, now, cfg)
  if (fmt === 'absolute') return abs
  return resetsAt <= now ? t('{0} (reset due)', abs) : t('{0} (in {1})', abs, rel)
}

/**
 * The clock time of a reset as `formatReset`'s `absolute` and `both` forms write it — the
 * weekday in front once the reset is a day or more away. 1.11 D12: exported for the status
 * bar's `both` item, which puts it into its own whole message (`resets at {0} (in {1})`)
 * beside `relativeShort`'s countdown instead of wrapping `formatReset`'s text.
 */
export function resetClock(resetsAt: number, now: number, cfg: TimeConfig): string {
  return formatTime(resetsAt, cfg, resetsAt - now >= MS_DAY)
}

/** Age of a reading; null when nothing was ever read (absence is not "0 min old"). */
export function ageText(fetchedAtSec: number | null, now: number): string | null {
  if (fetchedAtSec === null || !Number.isFinite(fetchedAtSec) || fetchedAtSec <= 0) return null
  const min = (now - fetchedAtSec * 1000) / 60000
  if (min < 1) return t('just now')
  if (min < 60) return t('{0} min ago', Math.round(min))
  const h = min / 60
  if (h < 48) return t('{0} h ago', Math.round(h))
  return t('{0} d ago', Math.round(h / 24))
}

/**
 * "14:20" today, "2026-09-01 14:20" on any other day — the Sessions table's own form, for a clock
 * time that may lie on another day: an agent's end (agentTreeBuild's `stamp`), a failed attempt.
 * The day is `dayOf`'s, the configured day boundary included, as the tree has always printed it.
 */
export function clockStamp(ms: number, now: number, tcfg: TimeConfig): string {
  const time = formatTime(ms, tcfg)
  const day = dayOf(ms, tcfg)
  return day === dayOf(now, tcfg) ? time : `${day} ${time}`
}

/**
 * 1.7 W2: when our next quota attempt is — a countdown, due, or held for focus. Never a reset:
 * `relativeShort` says "reset due" for a time that has passed, and an attempt is no reset.
 */
export type AttemptWhen = { kind: 'in'; text: string } | { kind: 'due' } | { kind: 'focus' }

/**
 * Null without a known `nextAttemptAt`; 'in' only for a time still ahead (`relativeShort` of it,
 * which for a time ahead is always a duration); a time that has passed is 'due', or 'focus' while
 * the manager holds it back for a window in the background (`QuotaState.attemptHeld`).
 */
export function attemptWhen(
  nextAttemptAt: number | null | undefined,
  held: 'focus' | null | undefined,
  now: number,
): AttemptWhen | null {
  if (typeof nextAttemptAt !== 'number' || !Number.isFinite(nextAttemptAt) || !Number.isFinite(now)) return null
  if (nextAttemptAt <= now) return held === 'focus' ? { kind: 'focus' } : { kind: 'due' }
  return { kind: 'in', text: relativeShort(nextAttemptAt, now) }
}

/** The status bar's words: "retry 1h12m" · "retry due" · "retry waiting for focus" · "retry" (null). */
export function retryWords(w: AttemptWhen | null): string {
  if (w === null) return t('retry')
  switch (w.kind) {
    case 'in': return t('retry {0}', w.text)
    case 'due': return t('retry due')
    default: return t('retry waiting for focus')
  }
}

/** The sentence's tail: "next attempt in 1h12m" · "next attempt due" · "next attempt waiting for focus". */
export function nextAttemptWords(w: AttemptWhen): string {
  switch (w.kind) {
    case 'in': return t('next attempt in {0}', w.text)
    case 'due': return t('next attempt due')
    default: return t('next attempt waiting for focus')
  }
}

/** The markdown freshness column ("next refresh {3}"): "1h12m" · "due" · "waiting for focus". */
export function refreshWords(w: AttemptWhen): string {
  switch (w.kind) {
    case 'in': return w.text
    case 'due': return t('due')
    default: return t('waiting for focus')
  }
}

/**
 * 1.7 W1: "Last attempt at 14:20 failed: HTTP 429 — backing off before the next attempt · next
 * attempt in 1h12m", or null without a failure. The time is `clockStamp`'s — the day in front on
 * another day —, the reason the poller's words verbatim (a fixed string, at most an HTTP status, or
 * Codex's app-server error, never an exception's text), and the tail is left off when no next attempt
 * is known. `wrap` puts the reason into a code span where the sentence lands in markup (the tooltip).
 *
 * 1.7 P4b: null for a permanent kind (`FAILURE_TRANSIENT`) — the manager hands on transient failures
 * only, and this, the one sentence every view prints, asks again for a state built anywhere else.
 */
export function lastFailureText(
  q: QuotaState,
  now: number,
  tcfg: TimeConfig,
  wrap: (problem: string) => string = (p) => p,
): string | null {
  const f = q.lastFailure
  if (!f || typeof f.at !== 'number' || !Number.isFinite(f.at)
    || typeof f.problem !== 'string' || f.problem === '' || !isTransientFailure(f.kind)) return null
  const head = t('Last attempt at {0} failed: {1}', clockStamp(f.at, now, tcfg), wrap(f.problem))
  const w = attemptWhen(q.nextAttemptAt, q.attemptHeld, now)
  return w === null ? head : `${head} · ${nextAttemptWords(w)}`
}
