// SPDX-FileCopyrightText: 2026 Frederik Marx
// SPDX-License-Identifier: GPL-3.0-or-later

import { ModelPrice, priceOf } from './prices'
import {
  Bucket, Cursor, PendingMessage, Snapshot, Source,
  bucketKey, emptyBucket, STATE_VERSION,
} from './types'

/** Local day (not UTC!) as YYYY-MM-DD. Codex rollouts are UTC; on late evenings
 *  in UTC+2 that would put up to 495M tokens on the wrong day. */
export function localDay(ms: number): string {
  const d = new Date(ms)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0
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
 */
export class Aggregator {
  private buckets = new Map<string, Bucket>()
  private pending = new Map<string, PendingMessage>()
  cursors = new Map<string, Cursor>()

  private bucket(source: Source, day: string, model: string, isSub: boolean): Bucket {
    const k = bucketKey(source, day, model, isSub)
    let b = this.buckets.get(k)
    if (!b) { b = emptyBucket(source, day, model, isSub); this.buckets.set(k, b) }
    return b
  }

  // ---------------------------------------------------------------- Claude

  /** Processes one line of a Claude transcript. Returns true if it was counted. */
  addClaudeLine(raw: string, isSub: boolean): boolean {
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

    const ts = Date.parse(d.timestamp ?? '')
    const day = localDay(Number.isFinite(ts) ? ts : Date.now())
    const model = typeof m.model === 'string' ? m.model : 'unbekannt'
    const final = m.stop_reason != null

    const cand = {
      input: num(u.input_tokens),
      cacheWrite: num(u.cache_creation_input_tokens),
      // The 1h variant costs 2x input instead of 1.25x and must be tracked separately.
      cacheWrite1h: num(u.cache_creation?.ephemeral_1h_input_tokens),
      cacheRead: num(u.cache_read_input_tokens),
      // iterations[] is already the total and must not be added on top.
      output: num(u.output_tokens),
    }

    const prev = this.pending.get(id)
    if (!prev) {
      const b = this.bucket('claude', day, model, isSub)
      b.input += cand.input
      b.cacheWrite += cand.cacheWrite
      b.cacheWrite1h += cand.cacheWrite1h
      b.cacheRead += cand.cacheRead
      b.output += cand.output
      b.requests += 1
      if (final) b.outputFinal += 1
      this.pending.set(id, { day, model, isSub, ...cand, final })
      this.trimPending()
      return true
    }

    // Known id: only add the difference to the running maximum.
    const b = this.bucket('claude', prev.day, prev.model, prev.isSub)
    const next = {
      input: Math.max(prev.input, cand.input),
      cacheWrite: Math.max(prev.cacheWrite, cand.cacheWrite),
      cacheWrite1h: Math.max(prev.cacheWrite1h, cand.cacheWrite1h),
      cacheRead: Math.max(prev.cacheRead, cand.cacheRead),
      output: Math.max(prev.output, cand.output),
    }
    b.input += next.input - prev.input
    b.cacheWrite += next.cacheWrite - prev.cacheWrite
    b.cacheWrite1h += next.cacheWrite1h - prev.cacheWrite1h
    b.cacheRead += next.cacheRead - prev.cacheRead
    b.output += next.output - prev.output
    if (final && !prev.final) b.outputFinal += 1
    prev.input = next.input
    prev.cacheWrite = next.cacheWrite
    prev.cacheWrite1h = next.cacheWrite1h
    prev.cacheRead = next.cacheRead
    prev.output = next.output
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
   * Processes one line of a Codex rollout, advancing `cur` as it goes:
   * startTs/forked drive replay-prefix detection, lastTotal drives delta computation.
   */
  addCodexLine(raw: string, cur: Cursor): boolean {
    let d: any
    try { d = JSON.parse(raw) } catch { return false }
    const ts = Date.parse(d?.timestamp ?? '')
    if (cur.startTs === undefined && Number.isFinite(ts)) cur.startTs = ts

    const type = d?.type
    const p = d?.payload

    if (type === 'session_meta') {
      // A forked thread carries the parent thread's complete history with it.
      if (p && (p.forked_from_id || p.thread_source === 'subagent')) cur.forked = true
      return false
    }
    if (type === 'turn_context') {
      if (p && typeof p.model === 'string') cur.model = p.model
      return false
    }
    if (type !== 'event_msg' || p?.type !== 'token_count') return false

    const info = p.info
    if (!info || typeof info !== 'object') return false
    const total = info.total_token_usage
    const last = info.last_token_usage
    if (!total || typeof total !== 'object') return false

    const totalTokens = num(total.total_tokens)

    // Replay prefix: leading events whose timestamp sits at the fork point.
    if (!cur.replayDone) {
      const atStart =
        cur.startTs !== undefined && Number.isFinite(ts) && Math.abs(ts - cur.startTs) <= 2000
      if (cur.forked && atStart) {
        cur.lastTotal = totalTokens // remember as baseline, do not count
        return false
      }
      cur.replayDone = true
      if (cur.lastTotal === undefined) {
        // First real event: the difference total-last is the inherited baseline.
        const lastTotalTokens = last ? num(last.total_tokens) : 0
        cur.lastTotal = Math.max(0, totalTokens - lastTotalTokens)
      }
    }

    const prevTotal = cur.lastTotal ?? 0
    if (totalTokens <= prevTotal) return false // duplicate or post-compaction marker
    cur.lastTotal = totalTokens

    // When total rises, the delta is field-wise identical to last_token_usage.
    const src = last && typeof last === 'object' ? last : total
    const day = localDay(Number.isFinite(ts) ? ts : Date.now())
    const b = this.bucket('codex', day, cur.model || 'unbekannt', !!cur.forked)
    b.input += num(src.input_tokens)
    b.cacheRead += num(src.cached_input_tokens)
    b.cacheWrite += num(src.cache_write_input_tokens)
    b.output += num(src.output_tokens)
    b.reasoning += num(src.reasoning_output_tokens)
    b.requests += 1
    b.outputFinal += 1 // Codex reports final values, not a streaming snapshot
    return true
  }

  // ----------------------------------------------------------- Persistence

  toSnapshot(): Snapshot {
    return {
      version: STATE_VERSION,
      buckets: [...this.buckets.values()],
      cursors: Object.fromEntries(this.cursors),
      pending: Object.fromEntries(this.pending),
    }
  }

  static fromSnapshot(s: Snapshot | undefined): Aggregator {
    const a = new Aggregator()
    if (!s || s.version !== STATE_VERSION) return a
    for (const b of s.buckets ?? []) {
      a.buckets.set(bucketKey(b.source, b.day, b.model, b.isSub), b)
    }
    for (const [k, v] of Object.entries(s.cursors ?? {})) a.cursors.set(k, v)
    for (const [k, v] of Object.entries(s.pending ?? {})) a.pending.set(k, v)
    return a
  }

  all(): Bucket[] { return [...this.buckets.values()] }

  /**
   * Hypothetical API cost for a period. Computed per model, because the rates
   * differ by a factor of 50. `unpricedTokens` reports the volume with no price
   * on file — otherwise the total would silently come out too low.
   */
  cost(
    fromDay: string,
    toDay: string,
    source?: Source,
    overrides?: Record<string, ModelPrice>,
  ): { usd: number; unpricedTokens: number; unpricedModels: string[] } {
    let usd = 0
    let unpricedTokens = 0
    const unpriced = new Set<string>()
    for (const b of this.buckets.values()) {
      if (source && b.source !== source) continue
      if (b.day < fromDay || b.day > toDay) continue
      const c = costOf(b, overrides)
      if (c === null) {
        unpriced.add(b.model)
        unpricedTokens += billable(b)
      } else {
        usd += c
      }
    }
    return { usd, unpricedTokens, unpricedModels: [...unpriced].sort() }
  }

  /** Sums over a day range (inclusive), optionally per source. */
  sum(fromDay: string, toDay: string, source?: Source): Bucket {
    const out = emptyBucket(source ?? 'claude', fromDay, '*', false)
    for (const b of this.buckets.values()) {
      if (source && b.source !== source) continue
      if (b.day < fromDay || b.day > toDay) continue
      out.input += b.input
      out.cacheWrite += b.cacheWrite
      out.cacheWrite1h += b.cacheWrite1h
      out.cacheRead += b.cacheRead
      out.output += b.output
      out.reasoning += b.reasoning
      out.requests += b.requests
      out.outputFinal += b.outputFinal
    }
    return out
  }

  /** Daily series for the sparkline: total per day, ascending. */
  series(days: string[], source?: Source): number[] {
    const idx = new Map(days.map((d, i) => [d, i]))
    const out = new Array(days.length).fill(0)
    for (const b of this.buckets.values()) {
      if (source && b.source !== source) continue
      const i = idx.get(b.day)
      if (i === undefined) continue
      out[i] += billable(b)
    }
    return out
  }
}

/** What a single bucket would have cost through the API, in USD. */
export function costOf(b: Bucket, overrides?: Record<string, ModelPrice>): number | null {
  const p = priceOf(b.model, overrides)
  if (!p) return null
  const M = 1e6
  if (b.source === 'codex') {
    // input_tokens already includes the cached tokens — otherwise they get paid for twice.
    const fresh = Math.max(0, b.input - b.cacheRead)
    return (fresh * p.input + b.cacheRead * p.cacheRead + b.output * p.output) / M
  }
  const write5m = Math.max(0, b.cacheWrite - b.cacheWrite1h)
  return (
    (b.input * p.input +
      write5m * p.cacheWrite5m +
      b.cacheWrite1h * p.cacheWrite1h +
      b.cacheRead * p.cacheRead +
      b.output * p.output) /
    M
  )
}

/** The figure that actually means "usage": fresh input plus output. Cache reads
 *  otherwise dominate by a factor of ~1000 and make any total unreadable. */
export function billable(b: Bucket): number {
  const fresh = b.source === 'codex' ? Math.max(0, b.input - b.cacheRead) : b.input
  return fresh + b.cacheWrite + b.output
}
