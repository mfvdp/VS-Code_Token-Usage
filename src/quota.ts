// SPDX-FileCopyrightText: 2026 Frederik Marx
// SPDX-License-Identifier: GPL-3.0-or-later

import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { ExtraUsage, QuotaState, QuotaWindow } from './types'

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

function untilde(p: string): string {
  return p === '~' || p.startsWith(`~${path.sep}`) || p.startsWith('~/')
    ? path.join(os.homedir(), p.slice(1))
    : p
}

export function configureQuotaFiles(claudeFile?: string, codexFile?: string): void {
  CLAUDE_QUOTA_FILE = claudeFile?.trim() ? path.resolve(untilde(claudeFile)) : DEFAULT_CLAUDE_QUOTA
  CODEX_QUOTA_FILE = codexFile?.trim() ? path.resolve(untilde(codexFile)) : DEFAULT_CODEX_QUOTA
}

function label(id: string): string {
  switch (id) {
    case 'five_hour': return '5 h'
    case 'seven_day': return '7 d'
    case 'seven_day_opus': return '7 d Opus'
    case 'seven_day_sonnet': return '7 d Sonnet'
    case 'seven_day_cowork': return '7 d Cowork'
    case 'seven_day_oauth_apps': return '7 d Apps'
    default: return id.replace(/_/g, ' ')
  }
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

/** The cache holds the response as an embedded JSON string in the `body` field. */
function readCacheFile(file: string): { outer: any; body: any } | null {
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

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

/**
 * Anthropic reports the spent amount in minor units, with `decimal_places`
 * saying how many to shift. Treating it as a plain number would inflate the
 * figure by a factor of 100.
 */
function claudeExtra(e: any): ExtraUsage | undefined {
  if (!e || typeof e !== 'object') return undefined
  const dp = num(e.decimal_places) ?? 0
  const scale = (v: number | null) => (v === null ? null : v / 10 ** dp)
  return {
    enabled: e.is_enabled === true,
    utilization: num(e.utilization),
    used: scale(num(e.used_credits)),
    limit: scale(num(e.monthly_limit)),
    currency: typeof e.currency === 'string' ? e.currency : null,
    balance: null,
    unlimited: false,
    spendLimitReached: e.spend_limit_reached === true,
    reason:
      typeof e.disabled_reason === 'string'
        ? e.disabled_reason
        : e.user_disabled === true
          ? 'switched off'
          : e.credits_ever_enabled === false
            ? 'never enabled'
            : null,
  }
}

/** OpenAI reports a prepaid balance rather than a monthly allowance. */
function codexExtra(c: any, resetCredits: any): ExtraUsage | undefined {
  if (!c || typeof c !== 'object') return undefined
  const available = num(resetCredits?.availableCount)
  return {
    enabled: c.hasCredits === true || c.unlimited === true,
    utilization: null,
    used: null,
    limit: null,
    currency: null,
    balance: typeof c.balance === 'string' ? c.balance : c.balance != null ? String(c.balance) : null,
    unlimited: c.unlimited === true,
    spendLimitReached: false,
    reason: available !== null && available > 0 ? `${available} reset credit(s) available` : null,
  }
}

/** Builds the state from an already-parsed API response — shared by the cache
 *  file and by the extension's own poll. */
export function claudeStateFromBody(body: any, fetchedAt: number | null): QuotaState {
  const windows = fromLimits(body) ?? fromTopLevel(body)
  windows.sort(
    (a, b) =>
      (a.windowMinutes ?? 1e9) - (b.windowMinutes ?? 1e9) ||
      Number(a.id.includes(':')) - Number(b.id.includes(':')) ||
      a.label.localeCompare(b.label, 'en'),
  )
  return {
    source: 'claude', ok: windows.length > 0, fetchedAt, planType: null, windows,
    extra: claudeExtra(body?.extra_usage),
  }
}

export function codexStateFromBody(body: any, fetchedAt: number | null): QuotaState {
  const windows: QuotaWindow[] = []
  const byId = body?.rateLimitsByLimitId
  if (byId && typeof byId === 'object') {
    for (const [limitId, v] of Object.entries<any>(byId)) {
      // Key on window length, not primary/secondary — which slot is used varies
      // with the plan, and secondary is often null.
      for (const slot of ['primary', 'secondary'] as const) {
        const w = v?.[slot]
        if (!w || typeof w.usedPercent !== 'number') continue
        const minutes = typeof w.windowDurationMins === 'number' ? w.windowDurationMins : null
        const name = v.limitName ? String(v.limitName) : limitId
        const wl = windowLabel(minutes)
        const short = wl.replace(' ', '')
        windows.push({
          id: `${limitId}:${minutes ?? slot}`,
          label: limitId === 'codex' ? wl : `${name} ${wl}`,
          shortLabel: limitId === 'codex' ? short : `${shortModel(name)} ${short}`,
          percent: w.usedPercent,
          resetsAt: typeof w.resetsAt === 'number' ? w.resetsAt * 1000 : null,
          windowMinutes: minutes,
        })
      }
    }
  }
  // Main quota first, model-specific buckets after.
  windows.sort((a, b) => {
    const am = a.id.startsWith('codex:') ? 0 : 1
    const bm = b.id.startsWith('codex:') ? 0 : 1
    return am - bm || (a.windowMinutes ?? 1e9) - (b.windowMinutes ?? 1e9)
  })
  return {
    source: 'codex',
    ok: windows.length > 0,
    fetchedAt,
    planType: body?.rateLimits?.planType ?? null,
    windows,
    extra: codexExtra(body?.rateLimits?.credits, body?.rateLimitResetCredits),
  }
}

export function readClaudeQuota(): QuotaState {
  const base: QuotaState = { source: 'claude', ok: false, fetchedAt: null, planType: null, windows: [] }
  const r = readCacheFile(CLAUDE_QUOTA_FILE)
  if (!r) return { ...base, problem: `No quota file at ${CLAUDE_QUOTA_FILE}` }
  base.fetchedAt = typeof r.outer.fetched_at === 'number' ? r.outer.fetched_at : null

  // The poller pauses after failures; fetched_at stays put while it does.
  const blockedUntil = typeof r.outer.blocked_until === 'number' ? r.outer.blocked_until : 0
  if (blockedUntil > Date.now() / 1000) {
    return { ...base, problem: `Poller paused until ${new Date(blockedUntil * 1000).toLocaleTimeString('en-US')}` }
  }
  if (!r.body) return { ...base, problem: `Empty response (fail_count ${r.outer.fail_count ?? '?'})` }

  return { ...claudeStateFromBody(r.body, base.fetchedAt), origin: 'cache' }
}

/**
 * `limits[]` is the complete list: it also carries the model-scoped windows
 * (kind "weekly_scoped" with scope.model.display_name) that do not appear in the
 * top-level fields at all. Those fields serve only as a fallback.
 */
function fromLimits(body: any): QuotaWindow[] | null {
  if (!Array.isArray(body?.limits) || body.limits.length === 0) return null
  const out: QuotaWindow[] = []
  for (const l of body.limits) {
    if (!l || typeof l.percent !== 'number') continue
    const model: string | null = l.scope?.model?.display_name ?? null
    const minutes = l.kind === 'session' ? 300 : l.group === 'weekly' ? 10080 : null
    const wl = windowLabel(minutes)
    const short = wl.replace(' ', '')
    out.push({
      id: model ? `${l.kind}:${model}` : String(l.kind ?? 'unknown'),
      label: model ? `${wl} · ${model}` : wl,
      shortLabel: model ? `${shortModel(model)} ${short}` : short,
      percent: l.percent,
      resetsAt: l.resets_at ? Date.parse(l.resets_at) : null,
      windowMinutes: minutes,
    })
  }
  return out.length ? out : null
}

function fromTopLevel(body: any): QuotaWindow[] {
  const out: QuotaWindow[] = []
  for (const [id, v] of Object.entries<any>(body ?? {})) {
    if (!v || typeof v !== 'object' || typeof v.utilization !== 'number') continue
    // Internal code names (nimbus_quill, cinder_cove, juniper_tide …) sit at 0
    // throughout and would only lengthen the list.
    if (id !== 'five_hour' && !id.startsWith('seven_day')) continue
    const minutes = id === 'five_hour' ? 300 : 10080
    out.push({
      id,
      label: label(id),
      shortLabel: windowLabel(minutes).replace(' ', ''),
      percent: v.utilization,
      resetsAt: v.resets_at ? Date.parse(v.resets_at) : null,
      windowMinutes: minutes,
    })
  }
  return out
}

export function readCodexQuota(): QuotaState {
  const base: QuotaState = { source: 'codex', ok: false, fetchedAt: null, planType: null, windows: [] }
  const r = readCacheFile(CODEX_QUOTA_FILE)
  if (!r) return { ...base, problem: `No quota file at ${CODEX_QUOTA_FILE}` }
  base.fetchedAt = typeof r.outer.fetched_at === 'number' ? r.outer.fetched_at : null
  if (!r.body) return { ...base, problem: `Empty response (fail_count ${r.outer.fail_count ?? '?'})` }

  return { ...codexStateFromBody(r.body, base.fetchedAt), origin: 'cache' }
}
