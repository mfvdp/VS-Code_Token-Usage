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

function partsOf(ms: number, zone: string | undefined): ZoneParts {
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
    return { from, to, label: `${from} → ${to}`, preset: 'custom' }
  }
  switch (preset) {
    case 'today':
      return { from: today, to: today, label: 'Today', preset }
    case 'yesterday': {
      const y = addDays(today, -1)
      return { from: y, to: y, label: 'Yesterday', preset }
    }
    case '7d':
    case '30d':
    case '90d': {
      const n = Number(preset.slice(0, -1))
      return { from: addDays(today, -(n - 1)), to: today, label: `Last ${n} days`, preset }
    }
    case 'thisWeek':
      return { from: startOfWeekDay(today, cfg), to: today, label: 'This week', preset }
    case 'thisMonth':
      return { from: `${today.slice(0, 8)}01`, to: today, label: 'This month', preset }
    case 'lastMonth': {
      const lastOfPrev = addDays(`${today.slice(0, 8)}01`, -1)
      return {
        from: `${lastOfPrev.slice(0, 8)}01`, to: lastOfPrev, label: 'Last month', preset,
      }
    }
    case 'year':
      return { from: `${today.slice(0, 4)}-01-01`, to: today, label: 'This year', preset }
    case 'all':
      // Without a first ingest day there is no coverage to claim — today is the honest floor.
      return {
        from: firstDay && isDay(firstDay) ? firstDay : today, to: today, label: 'All time', preset,
      }
    default:
      return { from: today, to: today, label: 'Today', preset: 'today' }
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
    from, to, label: len === 1 ? 'Previous day' : `Previous ${len} days`, preset: 'custom',
  }
}

export type ResetFormat = 'none' | 'relative' | 'absolute' | 'both'

/**
 * Which hour cycle 'auto' means. The setting exists because a 12-hour reader
 * misreads "18:00"; that preference lives in the OS locale, so it is read from
 * there. The digits themselves are always formatted with the en-US pattern so
 * the status bar looks the same on every machine.
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

/** "06:00" / "06:00 AM", with a weekday prefix when the day itself is in doubt. */
export function formatTime(ms: number, cfg: TimeConfig, withWeekday = false): string {
  const zone = resolveZone(cfg.zone)
  const cycle = effectiveCycle(cfg.hourCycle)
  const f = formatter(`t|${zone ?? ''}|${cycle}`, () => new Intl.DateTimeFormat('en-US', {
    timeZone: zone, hour: '2-digit', minute: '2-digit', hourCycle: cycle,
  }))
  const time = f.format(ms)
  if (!withWeekday) return time
  const w = formatter(`w|${zone ?? ''}`, () => new Intl.DateTimeFormat('en-US', {
    timeZone: zone, weekday: 'short',
  }))
  // Two letters: the bar is narrow and "Mo" is unambiguous next to a clock time.
  return `${w.format(ms).slice(0, 2)} ${time}`
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
  if (diff <= 0) return 'reset due'
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
  return past ? `${txt} ago` : `in ${txt}`
}

/**
 * The reset time as the status bar shows it. A window without a stated reset
 * gets an empty string: an invented countdown would be the most convincing
 * lie the extension could tell.
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
  const far = resetsAt - now >= MS_DAY
  const abs = formatTime(resetsAt, cfg, far)
  if (fmt === 'absolute') return abs
  return resetsAt <= now ? `${abs} (reset due)` : `${abs} (in ${rel})`
}

/** Age of a reading; null when nothing was ever read (absence is not "0 min old"). */
export function ageText(fetchedAtSec: number | null, now: number): string | null {
  if (fetchedAtSec === null || !Number.isFinite(fetchedAtSec) || fetchedAtSec <= 0) return null
  const min = (now - fetchedAtSec * 1000) / 60000
  if (min < 1) return 'just now'
  if (min < 60) return `${Math.round(min)} min ago`
  const h = min / 60
  if (h < 48) return `${Math.round(h)} h ago`
  return `${Math.round(h / 24)} d ago`
}
