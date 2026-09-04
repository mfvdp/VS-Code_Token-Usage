// SPDX-FileCopyrightText: 2026 Frederik Marx
// SPDX-License-Identifier: AGPL-3.0-or-later

import { createHash } from 'crypto'
import * as path from 'path'
// Value import, and safe: `adapters` imports this module for types only, so the cycle is erased.
import { isKnownSource } from './adapters'
import { PricingOptions, costOfBucket, isCustomPricing } from './prices'
import { SYSTEM_TIME_CONFIG, TimeConfig, addDays, dayOf, dayOfHour, hourIndex, monthOf } from './time'
import {
  Attribution, Bucket, CodexRateLimitsSnapshot, Cursor, PendingMessage, Resolution, SessionRec,
  Snapshot, Source, Tier, ToolStat, bucketKey, emptyBucket, READABLE_STATE_VERSIONS, STATE_VERSION,
  TOOL_IDS_PER_MESSAGE, TOOL_NAME_CAP, TOOL_NAME_MAX_CHARS, toolDayKey, toolKey,
} from './types'

/** Per-file context the scanner hands to every ingest call. */
export interface IngestContext {
  isSub: boolean
  file: string
  attribution: Attribution
  projectSalt: string
  hashProjects: boolean
}

export interface BucketFilter {
  source?: Source
  models?: string[]
  isSub?: boolean
  tier?: Tier
}

/**
 * What the tool side table can be asked. It is keyed by source, day, model and name only:
 * subagent and tier are bucket dimensions the table does not carry, and answering them
 * would mean inventing a split, so they are not offered here.
 */
export interface ToolFilter {
  source?: Source
  models?: string[]
}

export interface ToolQuery {
  /** Copies, sorted by day, source, name, model — the caller may not mutate the table. */
  rows: ToolStat[]
  /** A day inside the answer hit `TOOL_NAME_CAP`: its list of names is incomplete. */
  truncated: boolean
  /** Earliest day with a row in the answer — the "counted since" a view has to state. */
  firstDay: string | null
}

export type Metric = 'usage' | 'output' | 'cacheRead' | 'requests' | 'reasoning' | 'cost'

export interface CostSummary {
  usd: number
  listUsd: number
  /** Billable tokens of models with no price at all. */
  unpricedTokens: number
  unpricedModels: string[]
  /** Billable tokens of fast-mode requests whose model has no published fast rate. */
  fastUnpricedTokens: number
  familyPriced: string[]
  custom: boolean
}

/** Local day (not UTC!) as YYYY-MM-DD in the machine zone. Codex rollouts are UTC; on late
 *  evenings in UTC+2 that would put up to 495M tokens on the wrong day. Used at ingest so the
 *  `day` of hour buckets stays monotone with their `hour`. */
export function localDay(ms: number): string {
  const d = new Date(ms)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/** The figure that actually means "usage": fresh input plus output. Cache reads
 *  otherwise dominate by a factor of ~1000 and make any total unreadable. */
export function billable(b: Bucket): number {
  const fresh = b.source === 'codex' ? Math.max(0, b.input - b.cacheRead) : b.input
  return fresh + b.cacheWrite + b.output
}

const MS_HOUR = 3_600_000
/** Eight days of per-session hour slices — one day more than the longest quota window. */
const SESSION_HOUR_KEEP = 8 * 24

/**
 * How far back the tool side table is kept, whatever `retentionDays` says.
 *
 * A day bucket past the horizon is folded into a month bucket — a handful of rows survive
 * a year. A tool row cannot be: it is keyed day × model × name, so keeping it for the
 * default 400 days would leave tens of thousands of rows in a snapshot that is
 * JSON.stringify'd on every save and synchronously on shutdown (400 days × 3 models ×
 * 40 names is already megabytes). Ninety days answers every range the views offer without
 * that weight, and `ToolQuery.firstDay` makes the shorter horizon self-describing:
 * the section states "tool calls counted since <firstDay>".
 */
const TOOL_KEEP_DAYS = 90

/** Turn gaps per session are a bounded sample, not a log — 200 is enough for a P90. */
const TURN_GAP_CAP = 200

/** Recent Codex tool call ids kept for dedup; a few thousand span far more than one scan. */
const TOOL_CALL_MEMORY = 4000

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null
}

/** Fast mode and US-only inference are independent surcharges, hence four tiers. */
function tierOf(speed: unknown, geo: unknown): Tier {
  const fast = speed === 'fast'
  const us = geo === 'us'
  if (fast && us) return 'fast-us'
  if (fast) return 'fast'
  if (us) return 'us'
  return 'standard'
}

function timeKey(cfg: TimeConfig): string {
  return `${cfg.zone}|${cfg.dayBoundaryHour}`
}

/** First and last calendar day of a YYYY-MM month, so a month bucket can be range-checked. */
function monthBounds(month: string): { first: string; last: string } {
  const first = `${month}-01`
  const y = Number(month.slice(0, 4))
  const m = Number(month.slice(5, 7))
  const days = Number.isFinite(y) && Number.isFinite(m) ? new Date(Date.UTC(y, m, 0)).getUTCDate() : 31
  return { first, last: `${month}-${String(days).padStart(2, '0')}` }
}

/**
 * A pseudonym for a project that survives renames of nothing but is stable for one path:
 * the salt is per installation, so two people with the same checkout path do not share it.
 */
function projectHashOf(salt: string, full: string): string {
  return createHash('sha256').update(salt + full).digest('hex').slice(0, 12)
}

/**
 * Reads the rate-limit block Codex writes into token_count events. Both the snake_case
 * schema of the rollouts and the camelCase one of the app-server are accepted, because
 * the block moved between the two across versions. Anything not a finite number is
 * dropped rather than clamped: a window with an unusable percentage is no window.
 */
export function parseCodexRateLimits(rl: unknown, t: number): CodexRateLimitsSnapshot | null {
  if (!rl || typeof rl !== 'object') return null
  const r = rl as Record<string, unknown>
  const pick = (a: string, b: string): unknown => (r[a] !== undefined ? r[a] : r[b])
  const window = (w: unknown): CodexRateLimitsSnapshot['primary'] => {
    if (!w || typeof w !== 'object') return null
    const o = w as Record<string, unknown>
    const used = o.used_percent !== undefined ? o.used_percent : o.usedPercent
    if (typeof used !== 'number' || !Number.isFinite(used) || used < 0) return null
    const mins = o.window_minutes !== undefined ? o.window_minutes : o.windowMinutes
    const reset = o.resets_at !== undefined ? o.resets_at : o.resetsAt
    let resetsAt: number | null = null
    if (typeof reset === 'number' && Number.isFinite(reset) && reset > 0) {
      // Rollouts write epoch seconds; anything that already looks like milliseconds is kept.
      resetsAt = reset < 1e12 ? Math.round(reset * 1000) : Math.round(reset)
    }
    return {
      usedPercent: used,
      windowMinutes: typeof mins === 'number' && Number.isFinite(mins) && mins > 0 ? mins : null,
      resetsAt,
    }
  }
  const creditsRaw = r.credits
  let credits: CodexRateLimitsSnapshot['credits'] = null
  if (creditsRaw && typeof creditsRaw === 'object') {
    const c = creditsRaw as Record<string, unknown>
    const bal = c.balance
    credits = {
      hasCredits: (c.has_credits !== undefined ? c.has_credits : c.hasCredits) === true,
      unlimited: c.unlimited === true,
      balance: typeof bal === 'string' ? bal : typeof bal === 'number' && Number.isFinite(bal) ? String(bal) : null,
    }
  }
  const reached = pick('rate_limit_reached_type', 'rateLimitReachedType')
  return {
    t,
    // The account-wide limit carries no id in older rollouts; "codex" is what the
    // app-server names it, so both schemas end up under one key.
    limitId: str(pick('limit_id', 'limitId')) ?? 'codex',
    limitName: str(pick('limit_name', 'limitName')),
    planType: str(pick('plan_type', 'planType')),
    primary: window(r.primary),
    secondary: window(r.secondary),
    credits,
    limitReached: reached !== null && reached !== undefined,
  }
}

/**
 * Collects token counts from both tools.
 *
 * Claude: one API response is written as N lines (one per content block). Dedup
 * runs on message.id and takes the maximum per field, because output_tokens is a
 * streaming snapshot. The bucket is corrected by delta so that lines of the same
 * id arriving later are not counted twice.
 *
 * Codex: total_token_usage is cumulative and is inherited as a baseline on forks.
 * Only the positive increase over the previous event is counted.
 *
 * Buckets are keyed per UTC hour while young, and folded into local days and
 * months by `rollup()`. Ingest and roll-up never overlap: the aggregator is
 * single-threaded, and the extension runs the roll-up between scans, so a line
 * can only ever see a consistent set of buckets.
 */
export class Aggregator {
  private buckets = new Map<string, Bucket>()
  private pending = new Map<string, PendingMessage>()
  private sessionMap = new Map<string, SessionRec>()
  /** Tool side table, keyed `source|day|model|name`. */
  private toolStats = new Map<string, ToolStat>()
  /** Distinct names per `source|day`, for the cap; rebuilt from the rows on restore. */
  private toolNames = new Map<string, Set<string>>()
  /** `source|day` pairs whose name list is incomplete. */
  private toolsTruncated = new Set<string>()
  /**
   * Codex tool call ids already counted. Bounded and not persisted: the cursors keep a
   * region from being read twice within a run, so this only has to survive one scan.
   */
  private seenToolCalls = new Set<string>()
  cursors = new Map<string, Cursor>()
  attribution: Attribution = 'none'
  firstIngest: number | null = null
  /** Zone used to address late lines into rolled-up buckets and to map hours to days. */
  timeConfig: TimeConfig = SYSTEM_TIME_CONFIG
  private rollupState = { lastRun: 0, hourRetentionDays: 0, retentionDays: 0 }
  /** dayOfHour goes through Intl and is hit for every bucket on every query — memoised. */
  private dayMemoKey = ''
  private dayMemo = new Map<number, string>()

  // ---------------------------------------------------------------- Buckets

  private dayOfHourMemo(hour: number, cfg: TimeConfig): string {
    const key = timeKey(cfg)
    if (key !== this.dayMemoKey) {
      this.dayMemoKey = key
      this.dayMemo.clear()
    }
    let d = this.dayMemo.get(hour)
    if (d === undefined) {
      d = dayOfHour(hour, cfg)
      this.dayMemo.set(hour, d)
    }
    return d
  }

  private get(source: Source, res: Resolution, hour: number | null, day: string, model: string, isSub: boolean, tier: Tier): Bucket {
    const k = bucketKey({ source, res, hour, day, model, isSub, tier })
    let b = this.buckets.get(k)
    if (!b) {
      b = emptyBucket(source, model, isSub, tier, res, hour, day)
      this.buckets.set(k, b)
    }
    return b
  }

  /** Hour index below which hour buckets have been folded into days; null before any roll-up. */
  private hourHorizon(): number | null {
    const r = this.rollupState
    if (r.lastRun <= 0) return null
    return hourIndex(r.lastRun) - r.hourRetentionDays * 24
  }

  /** Day below which day buckets have been folded into months; null before any roll-up. */
  private dayHorizon(): string | null {
    const r = this.rollupState
    if (r.lastRun <= 0) return null
    return addDays(dayOf(r.lastRun, this.timeConfig), -r.retentionDays)
  }

  /**
   * The bucket a line belongs to. Normally the hour bucket; but a late line for an hour
   * that the roll-up has already folded away must land in the day (or month) bucket that
   * now holds that hour — otherwise the roll-up would silently resurrect hour buckets and
   * the next roll-up would fold them again, double-shifting nothing but confusing sums.
   */
  bucketFor(source: Source, hour: number, day: string, model: string, isSub: boolean, tier: Tier): Bucket {
    const hh = this.hourHorizon()
    if (hh === null || hour >= hh) return this.get(source, 'h', hour, day, model, isSub, tier)
    const rolledDay = this.dayOfHourMemo(hour, this.timeConfig)
    const dh = this.dayHorizon()
    if (dh === null || rolledDay >= dh) return this.get(source, 'd', null, rolledDay, model, isSub, tier)
    return this.get(source, 'm', null, monthOf(rolledDay), model, isSub, tier)
  }

  private noteIngest(ts: number): void {
    if (this.firstIngest === null || ts < this.firstIngest) this.firstIngest = ts
  }

  // --------------------------------------------------------------- Sessions

  private sessionFor(file: string, ctx: IngestContext, make: () => SessionRec): SessionRec {
    let s = this.sessionMap.get(file)
    if (!s) {
      s = make()
      this.sessionMap.set(file, s)
    }
    // The snapshot records the setting its session table was collected under.
    this.attribution = ctx.attribution
    return s
  }

  private newSession(
    source: Source, sessionId: string, label: string, full: string, isSub: boolean,
    parent: string | null, ts: number, ctx: IngestContext,
  ): SessionRec {
    const projectHash = projectHashOf(ctx.projectSalt, full)
    return {
      source, sessionId,
      project: ctx.hashProjects ? projectHash : label,
      projectHash,
      isSub, parent,
      firstTs: ts, lastTs: ts,
      models: [],
      input: 0, cacheWrite: 0, cacheWrite1h: 0, cacheRead: 0, output: 0, reasoning: 0,
      requests: 0, outputFinal: 0,
      lastCacheTtl: null, lastCacheWriteTs: null,
      turnGapsMs: [],
      hourUsage: {},
    }
  }

  /**
   * Credits one hour of a session with the tokens it was billed for.
   *
   * The lifetime counters cannot be sliced afterwards, so the slice is kept while the line
   * is read. It is the same billable definition and the same UTC hour index the buckets use,
   * so a per-window attribution and the window's own usage row add up to the same tokens.
   */
  private noteSessionHour(s: SessionRec, hour: number, tokens: number): void {
    if (!Number.isFinite(hour) || !(tokens > 0)) return
    const map = s.hourUsage ?? (s.hourUsage = {})
    const k = String(hour)
    map[k] = (map[k] ?? 0) + tokens
  }

  /** A new request in a session: its distance to the previous one approximates a turn. */
  private noteTurn(s: SessionRec, ts: number, model: string): void {
    if (ts > s.lastTs) {
      s.turnGapsMs.push(ts - s.lastTs)
      if (s.turnGapsMs.length > TURN_GAP_CAP) s.turnGapsMs.splice(0, s.turnGapsMs.length - TURN_GAP_CAP)
      s.lastTs = ts
    }
    if (ts < s.firstTs) s.firstTs = ts
    if (!s.models.includes(model)) s.models.push(model)
  }

  private noteCacheWrite(s: SessionRec, cacheWrite: number, cacheWrite1h: number, ts: number): void {
    if (cacheWrite <= 0) return
    s.lastCacheTtl = cacheWrite1h > 0 ? '1h' : '5m'
    s.lastCacheWriteTs = ts
  }

  /**
   * Where a Claude transcript sits tells what it is: `<projects>/<slug>/<sessionId>.jsonl`
   * for a main session, `<projects>/<slug>/<sessionId>/subagents/<agent>.jsonl` for a
   * subagent. The slug is the fallback project label when a line carries no cwd.
   */
  private static claudePlacement(file: string, isSub: boolean): { slug: string; parent: string | null } {
    const dir = path.dirname(file)
    if (isSub) {
      const sessionDir = path.dirname(dir)
      return { slug: path.basename(path.dirname(sessionDir)), parent: path.basename(sessionDir) }
    }
    return { slug: path.basename(dir), parent: null }
  }

  // ------------------------------------------------------------------ Tools

  /**
   * Credits `n` calls of one tool to a day.
   *
   * The cap counts distinct names per (source, day) across models: names come from the
   * transcript and a generator that invents one per call would otherwise grow the state
   * file without bound. Names beyond the cap are dropped and the day is flagged, because
   * a short list that does not say it is short is a wrong list.
   */
  private addTool(source: Source, day: string, model: string, name: string, n: number): void {
    if (!(n > 0) || !name || !day) return
    const clean = name.length > TOOL_NAME_MAX_CHARS ? name.slice(0, TOOL_NAME_MAX_CHARS) : name
    const k = toolKey({ source, day, model, name: clean })
    const have = this.toolStats.get(k)
    if (have) {
      have.calls += n
      return
    }
    const dayKey = toolDayKey(source, day)
    let names = this.toolNames.get(dayKey)
    if (!names) {
      names = new Set<string>()
      this.toolNames.set(dayKey, names)
    }
    if (!names.has(clean) && names.size >= TOOL_NAME_CAP) {
      this.toolsTruncated.add(dayKey)
      return
    }
    names.add(clean)
    this.toolStats.set(k, { source, day, model, name: clean, calls: n })
  }

  /** True the first time a tool call id is seen; keeps the memory bounded (oldest first). */
  private firstSightOfCall(id: string): boolean {
    if (this.seenToolCalls.has(id)) return false
    this.seenToolCalls.add(id)
    if (this.seenToolCalls.size > TOOL_CALL_MEMORY) {
      const drop = this.seenToolCalls.size - TOOL_CALL_MEMORY
      let i = 0
      for (const k of this.seenToolCalls) {
        this.seenToolCalls.delete(k)
        if (++i >= drop) break
      }
    }
    return true
  }

  /**
   * Counts the `tool_use` blocks of one Claude line onto its message.
   *
   * Claude writes one content block per line under a repeated `message.id`, so a message
   * with two parallel `Read` calls arrives as two lines. Counting by block id makes those
   * two calls, while a line read twice stays one; a block without an id falls back to the
   * max-per-name rule, which never double counts but folds parallel calls of one tool into
   * a single call. `p.day`/`p.model` place the count on the message, not on the late line.
   */
  private countClaudeTools(p: PendingMessage, content: unknown): void {
    if (!Array.isArray(content)) return
    const counts = new Map<string, number>()
    for (const c of content) {
      if (!c || typeof c !== 'object') continue
      // Only real tool calls: a `server_tool_use` block is already counted as webSearch /
      // webFetch on the bucket, and listing it here would report the same call twice.
      if ((c as { type?: unknown }).type !== 'tool_use') continue
      const name = str((c as { name?: unknown }).name)
      if (!name) continue
      const id = str((c as { id?: unknown }).id)
      if (id) {
        const ids = p.toolIds ?? (p.toolIds = [])
        if (ids.includes(id)) continue
        if (ids.length < TOOL_IDS_PER_MESSAGE) ids.push(id)
        const tools = p.tools ?? (p.tools = {})
        tools[name] = (tools[name] ?? 0) + 1
        this.addTool('claude', p.day, p.model, name, 1)
        continue
      }
      counts.set(name, (counts.get(name) ?? 0) + 1)
    }
    if (counts.size === 0) return
    const tools = p.tools ?? (p.tools = {})
    for (const [name, cand] of counts) {
      const prev = tools[name] ?? 0
      if (cand <= prev) continue
      tools[name] = cand
      this.addTool('claude', p.day, p.model, name, cand - prev)
    }
  }

  // ---------------------------------------------------------------- Claude

  /** Processes one line of a Claude transcript. Returns true if it was counted. */
  addClaudeLine(raw: string, ctx: IngestContext): boolean {
    if (raw.indexOf('"usage"') < 0) return false
    let d: any
    try { d = JSON.parse(raw) } catch { return false }
    if (d?.type !== 'assistant') return false
    const m = d.message
    if (!m || typeof m !== 'object') return false
    const u = m.usage
    if (!u || typeof u !== 'object') return false
    // Placeholder and error lines carry all-zero usage and would only inflate the request count.
    if (m.model === '<synthetic>' || d.isApiErrorMessage) return false
    const id = m.id
    if (typeof id !== 'string' || !id) return false

    const parsed = Date.parse(d.timestamp ?? '')
    const ts = Number.isFinite(parsed) ? parsed : Date.now()
    const hour = hourIndex(ts)
    const day = localDay(ts)
    const model = typeof m.model === 'string' ? m.model : 'unknown'
    const final = m.stop_reason != null
    const isSub = ctx.isSub

    const cand = {
      input: num(u.input_tokens),
      cacheWrite: num(u.cache_creation_input_tokens),
      // The 1h variant costs 2x input instead of 1.25x and must be tracked separately.
      cacheWrite1h: num(u.cache_creation?.ephemeral_1h_input_tokens),
      cacheRead: num(u.cache_read_input_tokens),
      // iterations[] is already the total and must not be added on top.
      output: num(u.output_tokens),
      // Thinking tokens are a subset of output: reported alongside, never added to it.
      reasoning: num(u.output_tokens_details?.thinking_tokens),
      webSearch: num(u.server_tool_use?.web_search_requests),
      webFetch: num(u.server_tool_use?.web_fetch_requests),
    }

    const cur = this.cursors.get(ctx.file)
    if (cur) cur.lastTs = ts
    this.noteIngest(ts)

    const prev = this.pending.get(id)
    if (!prev) {
      const tier = tierOf(u.speed, u.inference_geo)
      const b = this.bucketFor('claude', hour, day, model, isSub, tier)
      b.input += cand.input
      b.cacheWrite += cand.cacheWrite
      b.cacheWrite1h += cand.cacheWrite1h
      b.cacheRead += cand.cacheRead
      b.output += cand.output
      b.reasoning += cand.reasoning
      b.webSearch += cand.webSearch
      b.webFetch += cand.webFetch
      b.requests += 1
      if (final) b.outputFinal += 1
      const p: PendingMessage = { hour, day, model, isSub, tier, ...cand, final }
      this.countClaudeTools(p, m.content)

      if (ctx.attribution !== 'none') {
        const place = Aggregator.claudePlacement(ctx.file, isSub)
        const cwd = str(d.cwd)
        const s = this.sessionFor(ctx.file, ctx, () => this.newSession(
          'claude',
          str(d.sessionId) ?? path.basename(ctx.file, '.jsonl'),
          cwd ? path.basename(cwd) : place.slug,
          cwd ?? place.slug,
          isSub, place.parent, ts, ctx,
        ))
        if (cur) { cur.sessionId = s.sessionId; cur.project = s.project }
        this.noteTurn(s, ts, model)
        s.input += cand.input
        s.cacheWrite += cand.cacheWrite
        s.cacheWrite1h += cand.cacheWrite1h
        s.cacheRead += cand.cacheRead
        s.output += cand.output
        s.reasoning += cand.reasoning
        s.requests += 1
        if (final) s.outputFinal += 1
        this.noteCacheWrite(s, cand.cacheWrite, cand.cacheWrite1h, ts)
        this.noteSessionHour(s, hour, cand.input + cand.cacheWrite + cand.output)
        p.session = ctx.file
      }

      this.pending.set(id, p)
      this.trimPending()
      return true
    }

    // Known id: only add the difference to the running maximum. The bucket is looked up
    // by the message's own hour, so a late line follows its message into a rolled-up bucket.
    const b = this.bucketFor('claude', prev.hour, prev.day, prev.model, prev.isSub, prev.tier)
    // Claude puts each content block on its own line, so the tool calls of a message arrive
    // on the *later* lines of its id: counting them only in the branch above would miss them.
    this.countClaudeTools(prev, m.content)
    const prevReasoning = prev.reasoning ?? 0
    const next = {
      input: Math.max(prev.input, cand.input),
      cacheWrite: Math.max(prev.cacheWrite, cand.cacheWrite),
      cacheWrite1h: Math.max(prev.cacheWrite1h, cand.cacheWrite1h),
      cacheRead: Math.max(prev.cacheRead, cand.cacheRead),
      output: Math.max(prev.output, cand.output),
      reasoning: Math.max(prevReasoning, cand.reasoning),
      webSearch: Math.max(prev.webSearch, cand.webSearch),
      webFetch: Math.max(prev.webFetch, cand.webFetch),
    }
    const delta = {
      input: next.input - prev.input,
      cacheWrite: next.cacheWrite - prev.cacheWrite,
      cacheWrite1h: next.cacheWrite1h - prev.cacheWrite1h,
      cacheRead: next.cacheRead - prev.cacheRead,
      output: next.output - prev.output,
      reasoning: next.reasoning - prevReasoning,
      webSearch: next.webSearch - prev.webSearch,
      webFetch: next.webFetch - prev.webFetch,
    }
    const newlyFinal = final && !prev.final
    b.input += delta.input
    b.cacheWrite += delta.cacheWrite
    b.cacheWrite1h += delta.cacheWrite1h
    b.cacheRead += delta.cacheRead
    b.output += delta.output
    b.reasoning += delta.reasoning
    b.webSearch += delta.webSearch
    b.webFetch += delta.webFetch
    if (newlyFinal) b.outputFinal += 1

    const s = prev.session ? this.sessionMap.get(prev.session) : undefined
    if (s) {
      s.input += delta.input
      s.cacheWrite += delta.cacheWrite
      s.cacheWrite1h += delta.cacheWrite1h
      s.cacheRead += delta.cacheRead
      s.output += delta.output
      s.reasoning += delta.reasoning
      if (newlyFinal) s.outputFinal += 1
      if (ts > s.lastTs) s.lastTs = ts
      this.noteCacheWrite(s, delta.cacheWrite, delta.cacheWrite1h, ts)
      // The message's hour, not the late line's: the bucket above follows the same rule.
      this.noteSessionHour(s, prev.hour, delta.input + delta.cacheWrite + delta.output)
    }

    prev.input = next.input
    prev.cacheWrite = next.cacheWrite
    prev.cacheWrite1h = next.cacheWrite1h
    prev.cacheRead = next.cacheRead
    prev.output = next.output
    prev.reasoning = next.reasoning
    prev.webSearch = next.webSearch
    prev.webFetch = next.webFetch
    prev.final = prev.final || final
    return true
  }

  /** Keeps the pending map small; Map preserves insertion order, so the oldest goes first. */
  private trimPending(limit = 4000): void {
    if (this.pending.size <= limit) return
    const drop = this.pending.size - limit
    let i = 0
    for (const k of this.pending.keys()) {
      this.pending.delete(k)
      if (++i >= drop) break
    }
  }

  // ----------------------------------------------------------------- Codex

  /**
   * Processes one line of a Codex rollout, advancing `cur` as it goes: startTs/forked
   * drive replay-prefix detection, lastTotal drives delta computation.
   *
   * Replay prefix of a forked file: the parent's history is copied in, complete with its
   * token_count events. Preferred signal is the first `task_started` event — everything
   * before it is replay and only sets the baseline. Rollouts written by versions that do
   * not persist that marker fall back to the timestamp heuristic: replayed events sit
   * within 2 s of the file's first record. Without look-ahead the two cannot be told
   * apart on a single line, so a token_count that is neither at the fork point nor
   * preceded by a marker is treated as real; the known cost is that a marker-less fork
   * whose first real turn lands inside those 2 s loses that one turn to the baseline.
   */
  addCodexLine(raw: string, cur: Cursor, ctx: IngestContext): boolean {
    let d: any
    try { d = JSON.parse(raw) } catch { return false }
    const parsed = Date.parse(d?.timestamp ?? '')
    const ts = Number.isFinite(parsed) ? parsed : NaN
    if (cur.startTs === undefined && Number.isFinite(ts)) cur.startTs = ts

    const type = d?.type
    const p = d?.payload

    if (type === 'session_meta') {
      // A forked thread carries the parent thread's complete history with it.
      const forkedFrom = p ? str(p.forked_from_id) : null
      if (p && (forkedFrom || p.thread_source === 'subagent')) cur.forked = true
      if (ctx.attribution !== 'none' && p && typeof p === 'object') {
        const cwd = str(p.cwd)
        const sessionId = str(p.id) ?? path.basename(ctx.file, '.jsonl')
        const at = Number.isFinite(ts) ? ts : Date.now()
        const s = this.sessionFor(ctx.file, ctx, () => this.newSession(
          'codex', sessionId,
          cwd ? path.basename(cwd) : path.basename(path.dirname(ctx.file)),
          cwd ?? ctx.file,
          !!cur.forked, forkedFrom, at, ctx,
        ))
        cur.sessionId = s.sessionId
        cur.project = s.project
      }
      return false
    }
    if (type === 'turn_context') {
      if (p && typeof p.model === 'string') cur.model = p.model
      return false
    }
    if (type === 'response_item') {
      // How the current builds record a tool call. `name` is a tool identifier
      // ("exec", "send_message", an MCP tool); `arguments` is content and is not read.
      if (p && typeof p === 'object' && (p.type === 'function_call' || p.type === 'custom_tool_call')) {
        this.noteCodexTool(cur, ts, str(p.name), str(p.call_id) ?? str(p.id))
      }
      // A line that only names a tool is not a counted line: nothing about tokens changed.
      return false
    }
    if (type !== 'event_msg' || !p || typeof p !== 'object') return false

    if (p.type === 'task_started') {
      // The first turn of this file begins here; whatever came before was copied history.
      cur.replayDone = true
      return false
    }
    // The begin events of older builds. `item_completed` is deliberately not read: it
    // repeats the call the response item above already carried, and would double it.
    if (p.type === 'exec_command_begin') {
      // The command line is the user's content and is never read; every shell call is
      // "exec", which is also the name the current builds put on the response item.
      this.noteCodexTool(cur, ts, 'exec', str(p.call_id))
      return false
    }
    if (p.type === 'mcp_tool_call_begin') {
      const inv = p.invocation
      const server = inv && typeof inv === 'object' ? str(inv.server) : null
      const tool = inv && typeof inv === 'object' ? str(inv.tool) : null
      this.noteCodexTool(cur, ts, server && tool ? `${server}.${tool}` : tool ?? server, str(p.call_id))
      return false
    }
    if (p.type !== 'token_count') return false

    // The rate-limit block is a reading in its own right, worth keeping even when the
    // token figures of the line are a duplicate or replay.
    const rl = parseCodexRateLimits(p.rate_limits ?? p.rateLimits, Number.isFinite(ts) ? ts : Date.now())
    if (rl && (!cur.lastRateLimits || rl.t >= cur.lastRateLimits.t)) cur.lastRateLimits = rl

    const info = p.info
    if (!info || typeof info !== 'object') return false
    const total = info.total_token_usage
    const last = info.last_token_usage
    if (!total || typeof total !== 'object') return false

    const totalTokens = num(total.total_tokens)

    if (!cur.replayDone) {
      // Replay prefix without a marker: leading events whose timestamp sits at the fork point.
      const atStart =
        cur.startTs !== undefined && Number.isFinite(ts) && Math.abs(ts - cur.startTs) <= 2000
      if (cur.forked && atStart) {
        cur.lastTotal = totalTokens // remember as baseline, do not count
        return false
      }
      cur.replayDone = true
    }
    if (cur.lastTotal === undefined) {
      // First real event: the difference total-last is the inherited baseline.
      const lastTotalTokens = last && typeof last === 'object' ? num(last.total_tokens) : 0
      cur.lastTotal = Math.max(0, totalTokens - lastTotalTokens)
    }

    const prevTotal = cur.lastTotal
    if (totalTokens <= prevTotal) return false // duplicate or post-compaction marker
    cur.lastTotal = totalTokens

    // When total rises, the delta is field-wise identical to last_token_usage.
    const src = last && typeof last === 'object' ? last : total
    const at = Number.isFinite(ts) ? ts : Date.now()
    const model = cur.model || 'unknown'
    const isSub = !!cur.forked
    const b = this.bucketFor('codex', hourIndex(at), localDay(at), model, isSub, 'standard')
    const add = {
      input: num(src.input_tokens),
      cacheRead: num(src.cached_input_tokens),
      cacheWrite: num(src.cache_write_input_tokens),
      output: num(src.output_tokens),
      reasoning: num(src.reasoning_output_tokens),
    }
    b.input += add.input
    b.cacheRead += add.cacheRead
    b.cacheWrite += add.cacheWrite
    b.output += add.output
    b.reasoning += add.reasoning
    b.requests += 1
    b.outputFinal += 1 // Codex reports final values, not a streaming snapshot
    cur.lastTs = at
    this.noteIngest(at)

    if (ctx.attribution !== 'none') {
      const s = this.sessionFor(ctx.file, ctx, () => this.newSession(
        'codex', path.basename(ctx.file, '.jsonl'), path.basename(path.dirname(ctx.file)),
        ctx.file, isSub, null, at, ctx,
      ))
      if (cur.sessionId === undefined) { cur.sessionId = s.sessionId; cur.project = s.project }
      this.noteTurn(s, at, model)
      s.input += add.input
      s.cacheRead += add.cacheRead
      s.cacheWrite += add.cacheWrite
      s.output += add.output
      s.reasoning += add.reasoning
      s.requests += 1
      s.outputFinal += 1
      this.noteCacheWrite(s, add.cacheWrite, 0, at)
      // Codex reports cached tokens inside input_tokens; only the fresh part is billable.
      this.noteSessionHour(
        s, hourIndex(at), Math.max(0, add.input - add.cacheRead) + add.cacheWrite + add.output,
      )
    }
    return true
  }

  /**
   * Counts one Codex tool call. Two rules keep it honest: the replay prefix of a forked
   * rollout carries the parent's calls and is skipped exactly as its token_count events
   * are, and a call id is counted once, so a build that writes both a begin event and a
   * response item for the same call still reports one call.
   */
  private noteCodexTool(cur: Cursor, ts: number, name: string | null, callId: string | null): void {
    if (!name) return
    if (cur.forked && !cur.replayDone) return
    if (callId && !this.firstSightOfCall(`codex|${callId}`)) return
    const at = Number.isFinite(ts) ? ts : Date.now()
    this.addTool('codex', localDay(at), cur.model || 'unknown', name, 1)
  }

  /** Newest rate-limit reading per limit id across every rollout — the network-free Codex quota. */
  codexRateLimits(): CodexRateLimitsSnapshot[] {
    const best = new Map<string, CodexRateLimitsSnapshot>()
    for (const cur of this.cursors.values()) {
      const s = cur.lastRateLimits
      if (!s) continue
      const have = best.get(s.limitId)
      if (!have || s.t > have.t) best.set(s.limitId, s)
    }
    return [...best.values()].sort((a, b) => a.limitId.localeCompare(b.limitId))
  }

  // ----------------------------------------------------------- Persistence

  toSnapshot(): Snapshot {
    return {
      version: STATE_VERSION,
      buckets: [...this.buckets.values()],
      cursors: Object.fromEntries(this.cursors),
      pending: Object.fromEntries(this.pending),
      sessions: Object.fromEntries(this.sessionMap),
      attribution: this.attribution,
      rollup: { ...this.rollupState },
      firstIngest: this.firstIngest,
      tools: [...this.toolStats.values()],
      toolsTruncated: [...this.toolsTruncated],
    }
  }

  /**
   * Restores a snapshot for the given attribution setting. A schema mismatch yields an
   * empty aggregator, which is the signal for a cold scan. The same happens when the
   * setting now asks for session records the snapshot was never collecting (none →
   * project/session): those can only come from a re-read. The other direction just
   * drops the table; project and session share one record shape and switch freely.
   *
   * Version 5 is read as well: it differs from 6 only by the tool side table, which
   * simply starts empty — a cold re-read of every transcript would be a steep price
   * for a table that has no history yet either way.
   */
  static fromSnapshot(s: Snapshot | undefined, attribution: Attribution = 'none'): Aggregator {
    const a = new Aggregator()
    a.attribution = attribution
    if (!s || !READABLE_STATE_VERSIONS.includes(s.version)) return a
    const stored: Attribution = s.attribution ?? 'none'
    if (attribution !== 'none' && stored === 'none') return a
    for (const b of s.buckets ?? []) {
      // The source has to be a provider this build knows, not merely a non-empty string: the
      // snapshot is a file a user can edit and another build can have written, and everything
      // downstream looks the source up in the registry to decide how to read the bucket.
      if (!b || typeof b !== 'object' || !isKnownSource(b.source) || !b.res) continue
      a.buckets.set(bucketKey(b), b)
    }
    for (const [k, v] of Object.entries(s.cursors ?? {})) a.cursors.set(k, v)
    for (const [k, v] of Object.entries(s.pending ?? {})) a.pending.set(k, v)
    for (const t of s.tools ?? []) {
      if (!t || typeof t !== 'object' || !isKnownSource(t.source)) continue
      if (typeof t.day !== 'string' || typeof t.name !== 'string') continue
      const row: ToolStat = {
        source: t.source,
        day: t.day,
        model: typeof t.model === 'string' && t.model ? t.model : 'unknown',
        name: t.name,
        calls: num(t.calls),
      }
      const k = toolKey(row)
      const have = a.toolStats.get(k)
      // A file edited by hand can hold the same key twice; folding beats letting one win.
      if (have) { have.calls += row.calls; continue }
      a.toolStats.set(k, row)
      const dayKey = toolDayKey(row.source, row.day)
      let names = a.toolNames.get(dayKey)
      if (!names) { names = new Set<string>(); a.toolNames.set(dayKey, names) }
      names.add(row.name)
    }
    for (const k of s.toolsTruncated ?? []) if (typeof k === 'string' && k) a.toolsTruncated.add(k)
    if (attribution !== 'none') {
      for (const [k, v] of Object.entries(s.sessions ?? {})) a.sessionMap.set(k, v)
    } else {
      a.dropSessionFields()
    }
    if (s.rollup && typeof s.rollup === 'object') {
      a.rollupState = {
        lastRun: num(s.rollup.lastRun),
        hourRetentionDays: num(s.rollup.hourRetentionDays),
        retentionDays: num(s.rollup.retentionDays),
      }
    }
    a.firstIngest = typeof s.firstIngest === 'number' && Number.isFinite(s.firstIngest) ? s.firstIngest : null
    return a
  }

  /** Drops per-session data (attribution switched off). */
  clearSessions(): void {
    this.sessionMap.clear()
    this.attribution = 'none'
    this.dropSessionFields()
  }

  /** Session identifiers also live on cursors and open messages; off means gone everywhere. */
  private dropSessionFields(): void {
    for (const c of this.cursors.values()) { delete c.sessionId; delete c.project }
    for (const p of this.pending.values()) delete p.session
  }

  all(): Bucket[] { return [...this.buckets.values()] }

  sessions(): SessionRec[] { return [...this.sessionMap.values()] }

  /**
   * The tool side table over an inclusive local-day range; both bounds are optional and
   * an omitted one is open. The days are the ones stored at ingest, so no zone mapping
   * happens here — unlike hour buckets, a tool row has no hour left to re-address.
   */
  tools(from?: string, to?: string, filter?: ToolFilter): ToolQuery {
    const rows: ToolStat[] = []
    let firstDay: string | null = null
    let truncated = false
    for (const t of this.toolStats.values()) {
      if (from && t.day < from) continue
      if (to && t.day > to) continue
      if (filter?.source && t.source !== filter.source) continue
      if (filter?.models && filter.models.length && !filter.models.includes(t.model)) continue
      rows.push({ ...t })
      if (firstDay === null || t.day < firstDay) firstDay = t.day
    }
    // The flag is per (source, day); a model filter cannot narrow it, so a filtered answer
    // may call itself incomplete when the dropped names belonged to another model. Saying
    // "incomplete" once too often is the harmless direction.
    for (const k of this.toolsTruncated) {
      const cut = k.indexOf('|')
      const source = k.slice(0, cut)
      const day = k.slice(cut + 1)
      if (from && day < from) continue
      if (to && day > to) continue
      if (filter?.source && source !== filter.source) continue
      truncated = true
      break
    }
    rows.sort((a, b) =>
      a.day.localeCompare(b.day) || a.source.localeCompare(b.source) ||
      a.name.localeCompare(b.name) || a.model.localeCompare(b.model))
    return { rows, truncated, firstDay }
  }

  stats(): {
    buckets: number; files: number; oldestDay: string | null; newestDay: string | null
    hourBuckets: number; dayBuckets: number; monthBuckets: number
  } {
    let oldest: string | null = null
    let newest: string | null = null
    let h = 0, d = 0, m = 0
    for (const b of this.buckets.values()) {
      if (b.res === 'h') h++
      else if (b.res === 'd') d++
      else m++
      const day = b.res === 'm' ? monthBounds(b.day) : { first: b.day, last: b.day }
      if (oldest === null || day.first < oldest) oldest = day.first
      if (newest === null || day.last > newest) newest = day.last
    }
    return {
      buckets: this.buckets.size, files: this.cursors.size, oldestDay: oldest, newestDay: newest,
      hourBuckets: h, dayBuckets: d, monthBuckets: m,
    }
  }

  // ---------------------------------------------------------------- Roll-up

  /**
   * Folds hour buckets older than `hourRetentionDays` into local-day buckets and day
   * buckets older than `retentionDays` into month buckets. Sums are preserved exactly;
   * running it twice changes nothing. The zone given here becomes the aggregator's
   * `timeConfig`, so late lines are addressed with the same calendar the fold used.
   *
   * Must not run while a scan is feeding lines — the extension schedules it between
   * scans; the worker never calls it.
   */
  rollup(
    now: number, hourRetentionDays: number, retentionDays: number, tcfg: TimeConfig,
  ): { hoursMerged: number; daysMerged: number } {
    this.timeConfig = tcfg
    const hourHorizon = hourIndex(now) - Math.max(0, Math.floor(hourRetentionDays)) * 24
    const dayHorizon = addDays(dayOf(now, tcfg), -Math.max(0, Math.floor(retentionDays)))
    let hoursMerged = 0
    let daysMerged = 0

    for (const [k, b] of [...this.buckets]) {
      if (b.res !== 'h' || b.hour === null || b.hour >= hourHorizon) continue
      const day = this.dayOfHourMemo(b.hour, tcfg)
      this.buckets.delete(k)
      mergeInto(this.get(b.source, 'd', null, day, b.model, b.isSub, b.tier), b)
      hoursMerged++
    }
    for (const [k, b] of [...this.buckets]) {
      if (b.res !== 'd' || b.day >= dayHorizon) continue
      this.buckets.delete(k)
      mergeInto(this.get(b.source, 'm', null, monthOf(b.day), b.model, b.isSub, b.tier), b)
      daysMerged++
    }
    // The tool table has day resolution and no month step: folding tool names into months
    // would keep a list of names for years, and no view asks for one. It also gets its own,
    // shorter horizon (see TOOL_KEEP_DAYS): day × model × name cannot be carried as far as a
    // rolled-up month bucket without turning the snapshot into megabytes of names. A
    // retention shorter than the cap still wins — the table is never kept longer than buckets.
    const toolHorizon = addDays(
      dayOf(now, tcfg),
      -Math.min(Math.max(0, Math.floor(retentionDays)), TOOL_KEEP_DAYS),
    )
    for (const [k, t] of [...this.toolStats]) {
      if (t.day >= toolHorizon) continue
      this.toolStats.delete(k)
      this.toolNames.delete(toolDayKey(t.source, t.day))
      this.toolsTruncated.delete(toolDayKey(t.source, t.day))
    }
    for (const k of [...this.toolsTruncated]) {
      // `source|day` — a flag whose day is gone has nothing left to qualify.
      if (k.slice(k.indexOf('|') + 1) < toolHorizon) this.toolsTruncated.delete(k)
    }

    // The per-session hour slices exist for the quota windows only, and the longest of those
    // is a week. Keeping them for the full hour-bucket retention would store months of them.
    const sessionHorizon = Math.max(hourHorizon, hourIndex(now) - SESSION_HOUR_KEEP)
    for (const s of this.sessionMap.values()) {
      if (!s.hourUsage) continue
      for (const k of Object.keys(s.hourUsage)) {
        if (Number(k) < sessionHorizon) delete s.hourUsage[k]
      }
    }

    this.rollupState = {
      lastRun: now,
      hourRetentionDays: Math.max(0, Math.floor(hourRetentionDays)),
      retentionDays: Math.max(0, Math.floor(retentionDays)),
    }
    return { hoursMerged, daysMerged }
  }

  // ---------------------------------------------------------------- Queries

  private matches(b: Bucket, f?: BucketFilter): boolean {
    if (!f) return true
    if (f.source && b.source !== f.source) return false
    if (f.isSub !== undefined && b.isSub !== f.isSub) return false
    if (f.tier && b.tier !== f.tier) return false
    if (f.models && f.models.length && !f.models.includes(b.model)) return false
    return true
  }

  /**
   * Whether a bucket lies inside an inclusive local-day range. Hour buckets are placed
   * by the configured zone; day buckets are final; a month bucket counts only when the
   * whole month is inside — its days cannot be told apart any more, so a partial month
   * would be a guess. Month buckets are at least `retentionDays` old, so the usual
   * 7/30/90-day ranges never meet one.
   */
  private inRange(b: Bucket, from: string, to: string, tcfg: TimeConfig): boolean {
    if (b.res === 'h') {
      const day = this.dayOfHourMemo(b.hour ?? 0, tcfg)
      return day >= from && day <= to
    }
    if (b.res === 'd') return b.day >= from && b.day <= to
    const m = monthBounds(b.day)
    return m.first >= from && m.last <= to
  }

  /** Sums over an inclusive local-day range; uses the time config to map hour buckets to days. */
  sum(from: string, to: string, tcfg: TimeConfig, filter?: BucketFilter): Bucket {
    const out = emptyBucket(filter?.source ?? 'claude', '*', false, 'standard', 'd', null, from)
    for (const b of this.buckets.values()) {
      if (!this.matches(b, filter) || !this.inRange(b, from, to, tcfg)) continue
      mergeInto(out, b)
    }
    return out
  }

  /**
   * Hypothetical API cost for a period. Computed per bucket, because rates differ by
   * model, day and tier. Tokens that could not be priced are reported, never folded
   * into the total — a silently low figure is worse than a marked gap.
   */
  cost(from: string, to: string, tcfg: TimeConfig, pricing: PricingOptions, filter?: BucketFilter): CostSummary {
    const out: CostSummary = {
      usd: 0, listUsd: 0, unpricedTokens: 0, unpricedModels: [], fastUnpricedTokens: 0,
      familyPriced: [], custom: isCustomPricing(pricing),
    }
    const unpriced = new Set<string>()
    const family = new Set<string>()
    for (const b of this.buckets.values()) {
      if (!this.matches(b, filter) || !this.inRange(b, from, to, tcfg)) continue
      const c = this.costOfBucket(b, tcfg, pricing)
      if (c === null) {
        unpriced.add(b.model)
        out.unpricedTokens += billable(b)
        continue
      }
      if (c.unpriced) {
        out.fastUnpricedTokens += billable(b)
        continue
      }
      out.usd += c.usd
      out.listUsd += c.listUsd
      if (c.confidence === 'family') family.add(b.model)
      if (c.confidence === 'custom') out.custom = true
    }
    out.unpricedModels = [...unpriced].sort()
    out.familyPriced = [...family].sort()
    return out
  }

  /** The dated price rule is chosen by the bucket's day in the configured zone. */
  private costOfBucket(b: Bucket, tcfg: TimeConfig, pricing: PricingOptions) {
    const day = b.res === 'h' ? this.dayOfHourMemo(b.hour ?? 0, tcfg) : b.res === 'm' ? `${b.day}-01` : b.day
    return costOfBucket(day === b.day ? b : { ...b, day }, pricing)
  }

  /**
   * One value per day, ascending, for charts. `days` is a contiguous ascending list.
   * A month bucket whose month lies inside the list is shown on the month's first day:
   * its daily distribution no longer exists and spreading it evenly would invent one.
   */
  series(days: string[], tcfg: TimeConfig, filter?: BucketFilter, metric: Metric = 'usage', pricing?: PricingOptions): number[] {
    const out = new Array<number>(days.length).fill(0)
    if (days.length === 0) return out
    const idx = new Map(days.map((d, i) => [d, i]))
    const from = days[0]
    const to = days[days.length - 1]
    for (const b of this.buckets.values()) {
      if (!this.matches(b, filter)) continue
      let day: string
      if (b.res === 'h') day = this.dayOfHourMemo(b.hour ?? 0, tcfg)
      else if (b.res === 'd') day = b.day
      else {
        const m = monthBounds(b.day)
        if (m.first < from || m.last > to) continue
        day = m.first
      }
      const i = idx.get(day)
      if (i === undefined) continue
      out[i] += this.metricOf(b, metric, tcfg, pricing)
    }
    return out
  }

  private metricOf(b: Bucket, metric: Metric, tcfg: TimeConfig, pricing?: PricingOptions): number {
    switch (metric) {
      case 'output': return b.output
      case 'cacheRead': return b.cacheRead
      case 'requests': return b.requests
      case 'reasoning': return b.reasoning
      case 'cost': {
        const c = this.costOfBucket(b, tcfg, pricing ?? {})
        return c && !c.unpriced ? c.usd : 0
      }
      default: return billable(b)
    }
  }

  /**
   * Hour-resolution sums for [fromMs, toMs), hour-rounded outward. Only hour buckets
   * take part; when the interval reaches below the roll-up horizon the answer is
   * flagged incomplete instead of being padded with day-bucket guesses.
   */
  sumHours(fromMs: number, toMs: number, filter?: BucketFilter): { bucket: Bucket; complete: boolean } {
    const out = emptyBucket(filter?.source ?? 'claude', '*', false, 'standard', 'h', null, localDay(fromMs))
    if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || toMs <= fromMs) return { bucket: out, complete: true }
    const fromHour = hourIndex(fromMs)
    const toHour = Math.ceil(toMs / MS_HOUR)
    for (const b of this.buckets.values()) {
      if (b.res !== 'h' || b.hour === null) continue
      if (b.hour < fromHour || b.hour >= toHour) continue
      if (!this.matches(b, filter)) continue
      mergeInto(out, b)
    }
    const hh = this.hourHorizon()
    return { bucket: out, complete: hh === null || fromHour >= hh }
  }
}

/** Adds every counter of `src` onto `dst`; the identity fields of `dst` stay untouched. */
function mergeInto(dst: Bucket, src: Bucket): void {
  dst.input += src.input
  dst.cacheWrite += src.cacheWrite
  dst.cacheWrite1h += src.cacheWrite1h
  dst.cacheRead += src.cacheRead
  dst.output += src.output
  dst.reasoning += src.reasoning
  dst.requests += src.requests
  dst.outputFinal += src.outputFinal
  dst.webSearch += src.webSearch
  dst.webFetch += src.webFetch
}
