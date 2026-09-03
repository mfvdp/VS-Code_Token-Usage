// SPDX-FileCopyrightText: 2026 Frederik Marx
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Parsers for every quota shape this build can read.
 *
 * All of them are transport independent: the same body arrives from an external
 * poller's cache file, from our own HTTP poll, from the Codex app-server, from
 * `~/.claude.json` or from the status-line bridge. Nothing here touches the
 * network, and nothing here invents a figure — a field we do not understand is
 * reported in `drift`, never silently dropped, and an implausible value is
 * discarded rather than clamped into something that looks trustworthy.
 */

import * as crypto from 'crypto'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import {
  CodexRateLimitsSnapshot, ExtraUsage, ProblemKind, QuotaOrigin, QuotaState, QuotaWindow, Source,
  WindowKind,
} from './types'

/**
 * Quota figures do NOT come from the transcripts but from the cache of an
 * external poller (during development: two XFCE panel plugins). On a system
 * without such a poller — Windows, say — these files do not exist and the
 * extension shows `CC –`. The paths are therefore configurable.
 */
const DEFAULT_CLAUDE_QUOTA = path.join(os.homedir(), '.cache', 'claude-usage', 'state.json')
const DEFAULT_CODEX_QUOTA = path.join(os.homedir(), '.cache', 'codex-usage', 'state.json')

export let CLAUDE_QUOTA_FILE = DEFAULT_CLAUDE_QUOTA
export let CODEX_QUOTA_FILE = DEFAULT_CODEX_QUOTA

const DAY_MS = 86_400_000
/** A reset further away than this is not a window, it is a parsing accident. */
const FAR_RESET_MS = 400 * DAY_MS
/** Percent may overflow (credits keep a window running past 100), but not by orders of magnitude. */
const MAX_PLAUSIBLE_PERCENT = 200
/** The drift list is a hint for the maintainer, not a dump — keep it readable. */
const MAX_DRIFT = 40
/** Guards the walker against pathological input; real bodies are far below both. */
const WALK_MAX_DEPTH = 8
const WALK_MAX_LEAVES = 400
/** `cachedUsageUtilization` older than this says nothing about the current window. */
export const CLAUDE_JSON_MAX_AGE_MS = 24 * 60 * 60 * 1000
/** Version of the external cache file this build writes (docs/quota-cache-format.md). */
export const CACHE_SCHEMA_VERSION = 1

function untilde(p: string): string {
  return p === '~' || p.startsWith(`~${path.sep}`) || p.startsWith('~/')
    ? path.join(os.homedir(), p.slice(1))
    : p
}

export function configureQuotaFiles(claudeFile?: string, codexFile?: string): void {
  CLAUDE_QUOTA_FILE = claudeFile?.trim() ? path.resolve(untilde(claudeFile)) : DEFAULT_CLAUDE_QUOTA
  CODEX_QUOTA_FILE = codexFile?.trim() ? path.resolve(untilde(codexFile)) : DEFAULT_CODEX_QUOTA
}

export function quotaFileFor(source: Source): string {
  return source === 'claude' ? CLAUDE_QUOTA_FILE : CODEX_QUOTA_FILE
}

// ------------------------------------------------------------------ helpers

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v !== '' ? v : null
}

/** First defined value among several spellings — providers mix camelCase and snake_case. */
function pick(o: any, ...keys: string[]): unknown {
  if (!o || typeof o !== 'object') return undefined
  for (const k of keys) {
    if (o[k] !== undefined && o[k] !== null) return o[k]
  }
  return undefined
}

/**
 * Reset times arrive as epoch seconds (Codex, status line) or already in
 * milliseconds. 1e11 is the only threshold that separates them for any date
 * this software can meaningfully see (1e11 s is the year 5138).
 */
function resetMs(v: unknown): number | null {
  const n = num(v)
  if (n === null || n <= 0) return null
  return n < 1e11 ? Math.round(n * 1000) : Math.round(n)
}

function isoMs(v: unknown): number | null {
  const s = str(v)
  if (!s) return null
  const t = Date.parse(s)
  return Number.isFinite(t) ? t : null
}

function plausiblePercent(p: number): boolean {
  return Number.isFinite(p) && p >= 0 && p <= MAX_PLAUSIBLE_PERCENT
}

/** "Claude Opus 4.6" -> "claude-opus-4-6": the stable third segment of a scoped window key. */
function slug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
}

/** "GPT-5.3-Codex-Spark" -> "Spark". For the status bar, where space is tight. */
function shortModel(name: string): string {
  const parts = name.split(/[-_\s]+/).filter(Boolean)
  return parts[parts.length - 1] || name
}

function windowLabel(minutes: number | null): string {
  if (!minutes) return '?'
  if (minutes % 1440 === 0) return `${minutes / 1440} d`
  if (minutes % 60 === 0) return `${minutes / 60} h`
  return `${minutes} min`
}

function human(kind: string): string {
  return kind.replace(/_/g, ' ').trim() || 'unknown'
}

function labelFor(id: string): string {
  switch (id) {
    case 'five_hour': return '5 h'
    case 'seven_day': return '7 d'
    case 'seven_day_opus': return '7 d Opus'
    case 'seven_day_sonnet': return '7 d Sonnet'
    case 'seven_day_cowork': return '7 d Cowork'
    case 'seven_day_oauth_apps': return '7 d Apps'
    default: return human(id)
  }
}

/** Title case of a top-level suffix ("oauth_apps" -> "Oauth apps") — the only name we have there. */
function titleOf(suffix: string): string {
  const s = human(suffix)
  return s.charAt(0).toUpperCase() + s.slice(1)
}

function sha8(v: string): string {
  return crypto.createHash('sha256').update(v).digest('hex').slice(0, 8)
}

function problemState(
  source: Source, kind: ProblemKind, problem: string, fetchedAt: number | null = null,
): QuotaState {
  return { source, ok: false, fetchedAt, planType: null, windows: [], problem, problemKind: kind }
}

// -------------------------------------------------------------- drift scan

/**
 * Every numeric leaf of the response, by path.
 *
 * The drift list is the promise that unknown fields are reported instead of
 * silently filtered: whatever the provider adds shows up in the data-quality
 * section by name, so a schema change is visible before it becomes a wrong
 * number.
 */
function numericLeaves(v: unknown, prefix: string, out: string[], depth = 0): void {
  if (out.length >= WALK_MAX_LEAVES || depth > WALK_MAX_DEPTH) return
  if (typeof v === 'number') {
    if (prefix) out.push(prefix)
    return
  }
  if (Array.isArray(v)) {
    for (let i = 0; i < v.length && out.length < WALK_MAX_LEAVES; i++) {
      numericLeaves(v[i], `${prefix}[${i}]`, out, depth + 1)
    }
    return
  }
  if (v && typeof v === 'object') {
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      if (out.length >= WALK_MAX_LEAVES) return
      numericLeaves(val, prefix ? `${prefix}.${k}` : k, out, depth + 1)
    }
  }
}

/**
 * Notes first: they name a value we rejected, which matters more than a field we
 * merely do not render yet. Both groups are sorted, the whole list is capped.
 */
function driftOf(body: unknown, consumed: Set<string>, notes: string[]): string[] {
  const leaves: string[] = []
  numericLeaves(body, '', leaves)
  const rest = leaves.filter((p) => !consumed.has(p)).sort()
  return [...[...notes].sort(), ...rest].slice(0, MAX_DRIFT)
}

// ------------------------------------------------------------------ Claude

/**
 * Anthropic reports the spent amount in minor units, with `decimal_places`
 * saying how many to shift. Treating it as a plain number would inflate the
 * figure by a factor of 100.
 */
function claudeExtra(e: any, consumed: Set<string>, at = 'extra_usage'): ExtraUsage | undefined {
  if (!e || typeof e !== 'object') return undefined
  for (const k of ['decimal_places', 'utilization', 'used_credits', 'monthly_limit']) consumed.add(`${at}.${k}`)
  const dp = num(e.decimal_places) ?? 0
  const scale = (v: number | null) => (v === null ? null : v / 10 ** dp)
  return {
    enabled: e.is_enabled === true,
    utilization: num(e.utilization),
    used: scale(num(e.used_credits)),
    limit: scale(num(e.monthly_limit)),
    currency: str(e.currency),
    balance: null,
    unlimited: false,
    spendLimitReached: e.spend_limit_reached === true,
    reason:
      str(e.disabled_reason)
      ?? (e.user_disabled === true
        ? 'switched off'
        : e.credits_ever_enabled === false
          ? 'never enabled'
          : null),
  }
}

function claudeKind(kindRaw: string, group: string | null): WindowKind {
  if (kindRaw === 'session' || group === 'session') return 'session'
  if (group === 'weekly' || kindRaw.startsWith('weekly')) return 'weekly'
  return 'other'
}

/**
 * `limits[]` is the complete list: it also carries the model-scoped windows
 * (kind "weekly_scoped" with scope.model.display_name) that do not appear in the
 * top-level fields at all. Those fields serve only as a fallback.
 */
function fromLimits(
  body: any, consumed: Set<string>, notes: string[], ref: number,
): QuotaWindow[] | null {
  if (!Array.isArray(body?.limits) || body.limits.length === 0) return null
  const out: QuotaWindow[] = []
  for (let i = 0; i < body.limits.length; i++) {
    const l = body.limits[i]
    const at = `limits[${i}]`
    if (!l || typeof l !== 'object') continue
    consumed.add(`${at}.percent`)
    // A missing percent is a limit the provider did not report; a present but
    // impossible one is a value we refuse — and say so.
    if (typeof l.percent !== 'number') continue
    const percent: number = l.percent
    if (!plausiblePercent(percent)) {
      notes.push(`${at}.percent: implausible percent`)
      continue
    }
    const kindRaw = str(l.kind) ?? 'unknown'
    const group = str(l.group)
    // Only the two documented lengths are known; anything else gets no denominator,
    // and therefore no pace and no forecast.
    const minutes = kindRaw === 'session' ? 300 : group === 'weekly' ? 10080 : null
    const model = str(l.scope?.model?.display_name)
    const resetsAt = isoMs(l.resets_at)
    if (resetsAt !== null && Math.abs(resetsAt - ref) > FAR_RESET_MS) {
      notes.push(`${at}.resets_at: implausible reset time (over 400 days out)`)
    }
    const wl = minutes === null ? human(kindRaw) : windowLabel(minutes)
    const short = minutes === null ? human(kindRaw) : wl.replace(' ', '')
    out.push({
      id: `${kindRaw}:${minutes ?? 'na'}${model ? `:${slug(model)}` : ''}`,
      kind: claudeKind(kindRaw, group),
      label: model ? `${wl} · ${model}` : wl,
      shortLabel: model ? `${shortModel(model)} ${short}` : short,
      model,
      percent,
      resetsAt,
      windowMinutes: minutes,
      // "critical" alone is a warning level; only together with a full window is it
      // the provider saying the limit is actually reached.
      limitReached: str(l.severity) === 'critical' && percent >= 100,
      unlimited: false,
    })
  }
  return out.length ? out : null
}

/** Fallback for bodies without `limits[]`: the named top-level buckets. */
function fromTopLevel(body: any, notes: string[], ref: number): QuotaWindow[] {
  const out: QuotaWindow[] = []
  for (const [id, v] of Object.entries<any>(body ?? {})) {
    if (!v || typeof v !== 'object' || typeof v.utilization !== 'number') continue
    // Internal code names (nimbus_quill, cinder_cove, juniper_tide …) sit at 0
    // throughout and would only lengthen the list.
    if (id !== 'five_hour' && !id.startsWith('seven_day')) continue
    const percent = v.utilization as number
    if (!plausiblePercent(percent)) {
      notes.push(`${id}.utilization: implausible percent`)
      continue
    }
    const minutes = id === 'five_hour' ? 300 : 10080
    const suffix = id === 'five_hour' || id === 'seven_day' ? null : id.slice('seven_day_'.length)
    const model = suffix ? titleOf(suffix) : null
    const resetsAt = isoMs(v.resets_at)
    if (resetsAt !== null && Math.abs(resetsAt - ref) > FAR_RESET_MS) {
      notes.push(`${id}.resets_at: implausible reset time (over 400 days out)`)
    }
    const kindRaw = id === 'five_hour' ? 'session' : suffix ? 'weekly_scoped' : 'weekly_all'
    // The status bar shows only `shortLabel`, so a scoped week has to carry its model here
    // as well — otherwise seven_day, seven_day_opus and seven_day_sonnet all read "7d".
    const short = windowLabel(minutes).replace(' ', '')
    out.push({
      id: `${kindRaw}:${minutes}${suffix ? `:${slug(suffix)}` : ''}`,
      kind: kindRaw === 'session' ? 'session' : 'weekly',
      label: labelFor(id),
      shortLabel: model ? `${shortModel(model)} ${short}` : short,
      model,
      percent,
      resetsAt,
      windowMinutes: minutes,
      limitReached: false,
      unlimited: false,
    })
  }
  return out
}

/**
 * The utilization of every top-level bucket counts as read, including the
 * internal code names we deliberately do not show: their zero is not news, and
 * listing them as drift every single time would bury the fields that matter.
 */
function markBuckets(body: any, consumed: Set<string>): void {
  if (!body || typeof body !== 'object') return
  for (const [id, v] of Object.entries<any>(body)) {
    if (v && typeof v === 'object' && typeof v.utilization === 'number') consumed.add(`${id}.utilization`)
  }
}

function sortClaude(windows: QuotaWindow[]): QuotaWindow[] {
  return windows.sort(
    (a, b) =>
      (a.windowMinutes ?? 1e9) - (b.windowMinutes ?? 1e9)
      || Number(a.model !== null) - Number(b.model !== null)
      || a.label.localeCompare(b.label, 'en'),
  )
}

/**
 * Builds the state from an already-parsed API response — shared by the cache
 * file, our own poll, `~/.claude.json` and the status-line bridge.
 */
export function claudeStateFromBody(
  body: any, fetchedAt: number | null, origin?: QuotaOrigin,
): QuotaState {
  const consumed = new Set<string>()
  const notes: string[] = []
  const ref = fetchedAt !== null && Number.isFinite(fetchedAt) ? fetchedAt * 1000 : Date.now()
  const windows = sortClaude(fromLimits(body, consumed, notes, ref) ?? fromTopLevel(body, notes, ref))
  markBuckets(body, consumed)
  const extra = claudeExtra(body?.extra_usage, consumed)
  const drift = driftOf(body, consumed, notes)
  const state: QuotaState = {
    source: 'claude',
    ok: windows.length > 0,
    fetchedAt,
    planType: null,
    windows,
    extra,
  }
  if (origin) state.origin = origin
  if (drift.length) state.drift = drift
  if (!state.ok) {
    state.problem = 'Response contained no quota windows'
    state.problemKind = 'empty'
  }
  return state
}

// ------------------------------------------------------------------- Codex

/** OpenAI reports a prepaid balance rather than a monthly allowance. */
function codexExtra(c: any, resetCredits: any, consumed: Set<string>): ExtraUsage | undefined {
  if (!c || typeof c !== 'object') return undefined
  for (const k of ['balance']) {
    consumed.add(`rateLimits.credits.${k}`)
    consumed.add(`rate_limits.credits.${k}`)
  }
  consumed.add('rateLimitResetCredits.availableCount')
  consumed.add('rate_limit_reset_credits.available_count')
  const available = num(pick(resetCredits, 'availableCount', 'available_count'))
  const balance = pick(c, 'balance')
  return {
    enabled: pick(c, 'hasCredits', 'has_credits') === true || c.unlimited === true,
    utilization: null,
    used: null,
    limit: null,
    currency: null,
    balance: typeof balance === 'string' ? balance : balance != null ? String(balance) : null,
    unlimited: c.unlimited === true,
    spendLimitReached: false,
    reason: available !== null && available > 0 ? `${available} reset credit(s) available` : null,
  }
}

/**
 * Whether the provider itself says a limit is hit.
 *
 * `rate_limit_reached_type` sometimes names the limit or the slot it refers to;
 * only then is the flag narrowed, because marking every window as blocked on a
 * value we do not understand would be an invented state.
 */
function reachedMarker(o: any): string | null {
  const t = pick(o, 'rateLimitReachedType', 'rate_limit_reached_type')
  if (typeof t === 'string' && t && t !== 'none') return t
  if (t === true) return '*'
  if (pick(o, 'spendControlReached', 'spend_control_reached') === true) return '*'
  if (pick(o, 'limitReached', 'limit_reached') === true) return '*'
  return null
}

function codexWindowKind(minutes: number | null): WindowKind {
  if (minutes === null) return 'other'
  if (minutes <= 1440) return 'session'
  if (minutes <= 10080) return 'weekly'
  return 'other'
}

function codexWindow(
  limitId: string, name: string | null, slot: 'primary' | 'secondary', w: any,
  reached: string | null, notes: string[], at: string,
): QuotaWindow | null {
  const raw = pick(w, 'usedPercent', 'used_percent')
  if (typeof raw !== 'number') return null
  const percent: number = raw
  if (!plausiblePercent(percent)) {
    notes.push(`${at}.usedPercent: implausible percent`)
    return null
  }
  const minutes = num(pick(w, 'windowDurationMins', 'window_duration_mins', 'windowMinutes', 'window_minutes'))
  const label = windowLabel(minutes)
  const short = label.replace(' ', '')
  const display = name ?? limitId
  const hit = reached !== null
    && (reached === '*' || reached === limitId || reached === slot || reached === display)
  return {
    id: `${limitId}:${minutes ?? slot}`,
    kind: codexWindowKind(minutes),
    label: limitId === 'codex' ? label : `${display} ${label}`,
    shortLabel: limitId === 'codex' ? short : `${shortModel(display)} ${short}`,
    // Codex names the limit, not a model; a scoped window would need a model field
    // the provider does not send.
    model: null,
    percent,
    resetsAt: resetMs(pick(w, 'resetsAt', 'resets_at')),
    windowMinutes: minutes,
    limitReached: hit,
    // Codex windows always have a limit; only the credits can be unlimited.
    unlimited: false,
  }
}

export function codexStateFromBody(
  body: any, fetchedAt: number | null, origin?: QuotaOrigin,
): QuotaState {
  const consumed = new Set<string>()
  const notes: string[] = []
  const windows: QuotaWindow[] = []
  const byIdKey = body?.rateLimitsByLimitId ? 'rateLimitsByLimitId' : 'rate_limits_by_limit_id'
  const byId = pick(body, 'rateLimitsByLimitId', 'rate_limits_by_limit_id')
  const rateLimits = pick(body, 'rateLimits', 'rate_limits') as any
  const globalReached = reachedMarker(rateLimits) ?? reachedMarker(body)
  if (byId && typeof byId === 'object') {
    for (const [key, v] of Object.entries<any>(byId as Record<string, any>)) {
      const limitId = str(pick(v, 'limitId', 'limit_id')) ?? key
      const name = str(pick(v, 'limitName', 'limit_name'))
      const reached = reachedMarker(v) ?? globalReached
      // Key on window length, not primary/secondary — which slot is used varies
      // with the plan, and secondary is often null.
      for (const slot of ['primary', 'secondary'] as const) {
        const w = v?.[slot]
        if (!w || typeof w !== 'object') continue
        const at = `${byIdKey}.${key}.${slot}`
        for (const k of ['usedPercent', 'used_percent', 'windowDurationMins', 'window_duration_mins',
          'windowMinutes', 'window_minutes', 'resetsAt', 'resets_at']) {
          consumed.add(`${at}.${k}`)
        }
        const win = codexWindow(limitId, name, slot, w, reached, notes, at)
        if (win) windows.push(win)
      }
    }
  }
  // Main quota first, model-specific buckets after.
  windows.sort((a, b) => {
    const am = a.id.startsWith('codex:') ? 0 : 1
    const bm = b.id.startsWith('codex:') ? 0 : 1
    return am - bm || (a.windowMinutes ?? 1e9) - (b.windowMinutes ?? 1e9)
  })
  const extra = codexExtra(pick(rateLimits, 'credits'), pick(body, 'rateLimitResetCredits', 'rate_limit_reset_credits'), consumed)
  const drift = driftOf(body, consumed, notes)
  const state: QuotaState = {
    source: 'codex',
    ok: windows.length > 0,
    fetchedAt,
    planType: str(pick(rateLimits, 'planType', 'plan_type')),
    windows,
    extra,
  }
  if (origin) state.origin = origin
  if (drift.length) state.drift = drift
  if (!state.ok) {
    state.problem = 'Response contained no quota windows'
    state.problemKind = 'empty'
  }
  return state
}

/**
 * The network-free Codex source: the `rate_limits` block Codex writes into its
 * own transcripts. The newest snapshot per limit id wins — older lines describe
 * a window that has moved on.
 */
export function codexStateFromTranscript(snaps: CodexRateLimitsSnapshot[]): QuotaState {
  const newest = new Map<string, CodexRateLimitsSnapshot>()
  for (const s of snaps ?? []) {
    if (!s || typeof s.limitId !== 'string' || !s.limitId) continue
    if (typeof s.t !== 'number' || !Number.isFinite(s.t)) continue
    const prev = newest.get(s.limitId)
    if (!prev || s.t > prev.t) newest.set(s.limitId, s)
  }
  const windows: QuotaWindow[] = []
  let at = 0
  let planType: string | null = null
  let credits: CodexRateLimitsSnapshot['credits'] = null
  for (const s of newest.values()) {
    at = Math.max(at, s.t)
    if (s.planType) planType = s.planType
    if (s.credits) credits = s.credits
    for (const slot of ['primary', 'secondary'] as const) {
      const w = s[slot]
      if (!w) continue
      const percent = num(w.usedPercent)
      if (percent === null || !plausiblePercent(percent)) continue
      const minutes = num(w.windowMinutes)
      const label = windowLabel(minutes)
      const short = label.replace(' ', '')
      const display = s.limitName ?? s.limitId
      windows.push({
        id: `${s.limitId}:${minutes ?? slot}`,
        kind: codexWindowKind(minutes),
        label: s.limitId === 'codex' ? label : `${display} ${label}`,
        shortLabel: s.limitId === 'codex' ? short : `${shortModel(display)} ${short}`,
        model: null,
        percent,
        resetsAt: resetMs(w.resetsAt),
        windowMinutes: minutes,
        limitReached: s.limitReached === true,
        unlimited: false,
      })
    }
  }
  windows.sort((a, b) => {
    const am = a.id.startsWith('codex:') ? 0 : 1
    const bm = b.id.startsWith('codex:') ? 0 : 1
    return am - bm || (a.windowMinutes ?? 1e9) - (b.windowMinutes ?? 1e9)
  })
  if (windows.length === 0) {
    return problemState('codex', 'empty', 'No rate limits in the transcripts yet')
  }
  return {
    source: 'codex',
    ok: true,
    origin: 'transcript',
    fetchedAt: Math.round(at / 1000),
    planType,
    windows,
    extra: credits
      ? {
        enabled: credits.hasCredits === true || credits.unlimited === true,
        utilization: null, used: null, limit: null, currency: null,
        balance: credits.balance, unlimited: credits.unlimited === true,
        spendLimitReached: false, reason: null,
      }
      : undefined,
  }
}

// -------------------------------------------------------------- cache files

interface CacheFile {
  outer: any
  body: any
}

/** The cache holds the response either as an object or as an embedded JSON string. */
function readCacheFile(file: string): CacheFile | null {
  let txt: string
  try { txt = fs.readFileSync(file, 'utf8') } catch { return null }
  let outer: any
  try { outer = JSON.parse(txt) } catch { return null }
  let body: any = null
  if (typeof outer?.body === 'string') {
    try { body = JSON.parse(outer.body) } catch { body = null }
  } else if (outer?.body && typeof outer.body === 'object') {
    body = outer.body
  }
  return { outer, body }
}

/**
 * The shared envelope check of both cache files.
 *
 * `blocked_until` is the external poller saying it is pausing after failures —
 * its `fetched_at` stands still while it does, so without this check the display
 * would age silently instead of naming the pause.
 */
function cacheEnvelope(source: Source, file: string, now: number): QuotaState | CacheFile {
  const r = readCacheFile(file)
  if (!r) return problemState(source, 'noFile', `No quota file at ${file}`)
  const fetchedAt = num(r.outer?.fetched_at)
  const version = num(r.outer?.schema_version) ?? 0
  if (version > CACHE_SCHEMA_VERSION) {
    return problemState(source, 'unknown',
      `Cache file schema_version ${version} is newer than this build reads`, fetchedAt)
  }
  const blockedUntil = num(r.outer?.blocked_until) ?? 0
  if (blockedUntil > now / 1000) {
    return problemState(source, 'paused',
      `Poller paused until ${new Date(blockedUntil * 1000).toLocaleTimeString('en-US')}`, fetchedAt)
  }
  if (!r.body) {
    return problemState(source, 'empty',
      `Empty response (fail_count ${r.outer?.fail_count ?? '?'})`, fetchedAt)
  }
  return r
}

function isState(v: QuotaState | CacheFile): v is QuotaState {
  return (v as QuotaState).source !== undefined
}

export function readClaudeQuota(file: string = CLAUDE_QUOTA_FILE, now = Date.now()): QuotaState {
  const r = cacheEnvelope('claude', file, now)
  if (isState(r)) return r
  const state = claudeStateFromBody(r.body, num(r.outer?.fetched_at), 'cache')
  // A provider that answered with an error block delivered half the picture; that
  // is a marked partial reading, not a complete one.
  if (r.outer?.providers_error) state.partial = true
  return state
}

export function readCodexQuota(file: string = CODEX_QUOTA_FILE, now = Date.now()): QuotaState {
  const r = cacheEnvelope('codex', file, now)
  if (isState(r)) return r
  const state = codexStateFromBody(r.body, num(r.outer?.fetched_at), 'cache')
  if (r.outer?.providers_error) state.partial = true
  return state
}

/**
 * Writes the external cache file in the documented format (docs/quota-cache-format.md).
 *
 * Never overwrites a file that is newer than our own reading: other writers —
 * the XFCE poller, a second editor — must win over a stale value of ours, or the
 * two would ping-pong. Returns whether the file was written.
 */
export function writeQuotaCacheFile(
  file: string, source: Source, body: unknown, fetchedAtSec: number, writer: string,
): boolean {
  const existing = readCacheFile(file)
  const theirs = num(existing?.outer?.fetched_at)
  if (theirs !== null && theirs >= fetchedAtSec) return false
  const payload = {
    schema_version: CACHE_SCHEMA_VERSION,
    source,
    fetched_at: fetchedAtSec,
    fail_count: 0,
    blocked_until: 0,
    writer,
    body,
    providers_error: null,
  }
  const tmp = `${file}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(tmp, JSON.stringify(payload))
    fs.renameSync(tmp, file)
    return true
  } catch {
    try { fs.unlinkSync(tmp) } catch { /* nothing to clean up */ }
    return false
  }
}

// ------------------------------------------------------------ ~/.claude.json

export interface ClaudeJsonReading {
  state: QuotaState
  /**
   * Non-secret account marker for the history fingerprint: the hashed account
   * uuid, never the token and never the uuid itself.
   */
  identityHint: string | null
}

/**
 * Reads ONLY `cachedUsageUtilization` from `~/.claude.json`.
 *
 * Everything else in that file (`oauthAccount`, project history, …) is none of
 * this extension's business and is never touched. The block is Claude Code's own
 * cache of the same usage response, so the existing body parser applies.
 */
export function readClaudeJsonUtilization(file: string, now = Date.now()): ClaudeJsonReading {
  let txt: string
  try { txt = fs.readFileSync(file, 'utf8') } catch {
    return { state: problemState('claude', 'noFile', `No ${file}`), identityHint: null }
  }
  let parsed: any
  try { parsed = JSON.parse(txt) } catch {
    return { state: problemState('claude', 'empty', 'claude.json is not valid JSON'), identityHint: null }
  }
  const cached = parsed?.cachedUsageUtilization
  if (!cached || typeof cached !== 'object') {
    return { state: problemState('claude', 'empty', 'No cachedUsageUtilization in claude.json'), identityHint: null }
  }
  const uuid = str(cached.accountUuid)
  const identityHint = uuid ? sha8(uuid) : null
  const fetchedAtMs = num(cached.fetchedAtMs)
  if (fetchedAtMs === null) {
    return { state: problemState('claude', 'empty', 'cachedUsageUtilization without a timestamp'), identityHint }
  }
  if (now - fetchedAtMs > CLAUDE_JSON_MAX_AGE_MS) {
    // Older than a day says nothing about the running window — discarded, and the
    // reason is kept for the data-quality list rather than shown as a figure.
    return {
      state: problemState('claude', 'unknown', 'stale: cachedUsageUtilization is older than 24 h',
        Math.round(fetchedAtMs / 1000)),
      identityHint,
    }
  }
  const state = claudeStateFromBody(cached.utilization, Math.round(fetchedAtMs / 1000), 'claudeJson')
  return { state, identityHint }
}

// ---------------------------------------------------------- status line JSON

export interface StatuslineReading {
  state: QuotaState
  identityHint: string | null
  context: { used: number; size: number | null; usedPct: number | null } | null
  cost: { totalUsd: number } | null
  promptCache: { warm: boolean | null; ttl: '5m' | '1h' | null; expiresAt: number | null; hitRatio: number | null } | null
  model: { id: string | null; displayName: string | null } | null
}

function statuslineWindow(v: any, kindRaw: string, minutes: number, label: string): QuotaWindow | null {
  const percent = num(pick(v, 'used_percentage', 'usedPercentage', 'utilization'))
  if (percent === null || !plausiblePercent(percent)) return null
  return {
    id: `${kindRaw}:${minutes}`,
    kind: kindRaw === 'session' ? 'session' : 'weekly',
    label,
    shortLabel: label.replace(' ', ''),
    model: null,
    percent,
    resetsAt: resetMs(pick(v, 'resets_at', 'resetsAt')),
    windowMinutes: minutes,
    limitReached: false,
    unlimited: false,
  }
}

function promptCacheOf(v: any): StatuslineReading['promptCache'] {
  if (!v || typeof v !== 'object') return null
  const ttlRaw = pick(v, 'ttl')
  const ttl = ttlRaw === '5m' || ttlRaw === '1h' ? ttlRaw : null
  return {
    warm: typeof v.warm === 'boolean' ? v.warm : null,
    ttl,
    expiresAt: resetMs(pick(v, 'expires_at', 'expiresAt')),
    hitRatio: num(pick(v, 'hit_ratio', 'hitRatio')),
  }
}

/**
 * The status-line payload Claude Code pipes into its `statusLine.command`.
 *
 * The only official network-free quota source. Windows appear only while the API
 * reports them, so an absent block is an absent window — never a zero.
 */
export function claudeStateFromStatusline(payload: any, fetchedAt: number | null): StatuslineReading {
  const rl = pick(payload, 'rate_limits', 'rateLimits') as any
  const windows: QuotaWindow[] = []
  const five = statuslineWindow(pick(rl, 'five_hour', 'fiveHour'), 'session', 300, '5 h')
  if (five) windows.push(five)
  const seven = statuslineWindow(pick(rl, 'seven_day', 'sevenDay'), 'weekly_all', 10080, '7 d')
  if (seven) windows.push(seven)
  const spend = pick(rl, 'spend_limit', 'spendLimit') as any
  const spendPct = num(pick(spend, 'used_percentage', 'usedPercentage'))
  const state: QuotaState = {
    source: 'claude',
    ok: windows.length > 0,
    origin: 'statusline',
    fetchedAt,
    planType: null,
    windows: sortClaude(windows),
    extra: spendPct !== null && plausiblePercent(spendPct)
      ? {
        enabled: true, utilization: spendPct, used: null, limit: null, currency: null,
        balance: null, unlimited: false, spendLimitReached: false, reason: null,
      }
      : undefined,
  }
  if (!state.ok) {
    state.problem = 'Status line carried no rate limits'
    state.problemKind = 'empty'
  }
  const cw = pick(payload, 'context_window', 'contextWindow') as any
  const inTok = num(pick(cw, 'total_input_tokens', 'totalInputTokens'))
  const outTok = num(pick(cw, 'total_output_tokens', 'totalOutputTokens'))
  const size = num(pick(cw, 'context_window_size', 'contextWindowSize'))
  const used = inTok === null && outTok === null ? null : (inTok ?? 0) + (outTok ?? 0)
  const reported = num(pick(cw, 'used_percentage', 'usedPercentage'))
  const totalUsd = num(pick(pick(payload, 'cost') as any, 'total_cost_usd', 'totalCostUsd'))
  const model = pick(payload, 'model') as any
  return {
    state,
    // The status line carries no account identity of its own.
    identityHint: null,
    context: used === null
      ? null
      : { used, size, usedPct: reported ?? (size !== null && size > 0 ? (used / size) * 100 : null) },
    cost: totalUsd === null ? null : { totalUsd },
    promptCache: promptCacheOf(pick(payload, 'prompt_cache', 'promptCache')),
    model: model && typeof model === 'object'
      ? { id: str(model.id), displayName: str(pick(model, 'display_name', 'displayName')) }
      : null,
  }
}

/** Schema of the bridge's mirror file — ours, so an unknown version is refused. */
export const MIRROR_SCHEMA_VERSION = 1

/** Reads the mirror file the status-line bridge writes into globalStorage. */
export function readStatuslineMirror(file: string): StatuslineReading {
  const empty = (s: QuotaState): StatuslineReading =>
    ({ state: s, identityHint: null, context: null, cost: null, promptCache: null, model: null })
  let txt: string
  try { txt = fs.readFileSync(file, 'utf8') } catch {
    return empty(problemState('claude', 'noFile', `No status line mirror at ${file}`))
  }
  let parsed: any
  try { parsed = JSON.parse(txt) } catch {
    return empty(problemState('claude', 'empty', 'Status line mirror is not valid JSON'))
  }
  const version = num(parsed?.schema_version) ?? 0
  if (version !== MIRROR_SCHEMA_VERSION) {
    return empty(problemState('claude', 'unknown', `Status line mirror schema_version ${version} is not readable`))
  }
  const writtenAt = num(parsed?.written_at)
  if (!parsed?.payload || typeof parsed.payload !== 'object') {
    return empty(problemState('claude', 'empty', 'Status line mirror without a payload',
      writtenAt === null ? null : Math.round(writtenAt / 1000)))
  }
  return claudeStateFromStatusline(parsed.payload, writtenAt === null ? null : Math.round(writtenAt / 1000))
}
