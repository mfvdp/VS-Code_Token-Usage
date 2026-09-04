// SPDX-FileCopyrightText: 2026 Frederik Marx
// SPDX-License-Identifier: AGPL-3.0-or-later

import * as crypto from 'crypto'
import * as fs from 'fs'
import * as path from 'path'
import { QuotaOrigin, QuotaSample, QuotaState, Source } from './types'

/** Schema of `quotaHistory.json`. A file with any other version is not ours to edit. */
export const HISTORY_VERSION = 1

/** Hard ceiling independent of retention: 20 000 samples are roughly 1.5 MB of JSON. */
const DEFAULT_MAX_SAMPLES = 20_000

/**
 * Thinning grid. Inside the last `THIN_RECENT_DAYS` days one reading per (source, window,
 * identity) per `THIN_RECENT_SLOT_MS` survives — the newest of the slot, so the value shown is
 * always the last one measured; older than that, one per `THIN_OLD_SLOT_MS`. The grid is aligned
 * to the epoch (`Math.floor(t / slot)`), the same quarter hours the sparkline draws, so every
 * stored sample maps to exactly one sparkline slot and no slot ever holds two.
 *
 * The arithmetic that keeps the store under the cap: 7 days × 96 quarter hours = 672 slots per
 * window; with 7 windows (two providers, session, weekly and per-model windows) that is
 * 7 × 672 ≈ 4.7 k samples for the week, plus 24 × 7 = 168 per further day — ≈ 8.6 k at the
 * default 30 days and ≈ 18.7 k at the 90-day maximum, under the 20 k cap. Reset anchors add two
 * samples per reset on top, a few dozen a week at most.
 */
export const THIN_RECENT_DAYS = 7
export const THIN_RECENT_SLOT_MS = 15 * 60_000
export const THIN_OLD_SLOT_MS = 60 * 60_000

/**
 * A reading that follows more than six hours of silence is kept even when it repeats
 * the previous value. Without it a closed laptop would look like a straight line
 * between two distant points instead of the gap it really was.
 */
export const GAP_KEEP_MS = 6 * 60 * 60 * 1000

/** A fall of five points without a new `resetsAt` is a reset the provider did not announce. */
const CYCLE_DROP_POINTS = 5

/**
 * Limit re-basing: percent cannot climb this fast from usage alone, so such a jump means
 * the denominator moved (Anthropic raises weekly limits periodically). The cycle keeps
 * running — only the rate fit has to restart, otherwise the step pollutes the slope.
 */
const REBASE_POINTS_PER_HOUR = 60
const REBASE_MIN_POINTS = 5

/** The threshold the display layer calls "exhausted"; a cycle that touched it was capped. */
const CAP_PERCENT = 99.5

const HOUR_MS = 3_600_000
const DAY_MS = 86_400_000

const ORIGINS: QuotaOrigin[] = ['cache', 'poll', 'push', 'transcript', 'statusline', 'claudeJson']

/**
 * One quota cycle: the stretch between two resets of the same window.
 *
 * `tags` names why the cycle begins (START = first data we have, RESET = a reset was
 * seen or inferred) and whether a limit re-basing happened inside it. `fitStart` is the
 * time from which a rate fit may use samples — the last REBASE, else the cycle start.
 */
export interface Cycle {
  start: number
  /** Time of the last sample of a closed cycle; null while the cycle is the current one. */
  end: number | null
  resetsAt: number | null
  peak: number
  peakAt: number
  last: number
  /** Closed by a reset and backed by at least three readings — only these carry statistics. */
  complete: boolean
  capped: boolean
  tags: Array<'START' | 'RESET' | 'REBASE'>
  /** Start of the rate fit: time of the last REBASE, else `start`. */
  fitStart: number
}

/**
 * Stable, non-reversible key for one account identity.
 *
 * The hint is whatever identifies the account without being a secret (plan type, a
 * hashed e-mail, the credentials file mtime) — never the token itself. Streams of
 * different identities must never mix, so the fingerprint is part of every sample key.
 */
export function fingerprintFor(source: Source, hint: string | null): string {
  return crypto.createHash('sha256').update(`${source}:${hint ?? 'unknown'}`).digest('hex').slice(0, 8)
}

function keyOf(s: QuotaSample): string {
  return `${s.s}|${s.w}|${s.t}|${s.f}`
}

/** Accepts a persisted entry only when every field is present and finite — NaN is dropped, never clamped. */
function sampleOf(v: unknown): QuotaSample | null {
  if (!v || typeof v !== 'object') return null
  const o = v as Record<string, unknown>
  const s = o.s
  const w = o.w
  const t = o.t
  const p = o.p
  const r = o.r
  const origin = o.o
  const f = o.f
  if (s !== 'claude' && s !== 'codex') return null
  if (typeof w !== 'string' || w === '') return null
  if (typeof t !== 'number' || !Number.isFinite(t)) return null
  if (typeof p !== 'number' || !Number.isFinite(p) || p < 0) return null
  if (r !== null && (typeof r !== 'number' || !Number.isFinite(r))) return null
  if (typeof origin !== 'string' || !ORIGINS.includes(origin as QuotaOrigin)) return null
  if (typeof f !== 'string' || f === '') return null
  return { s, w, t, p, r: r as number | null, o: origin as QuotaOrigin, f }
}

/** null = the envelope is not a version-1 history; single bad entries are skipped instead. */
function samplesOf(parsed: unknown): QuotaSample[] | null {
  if (!parsed || typeof parsed !== 'object') return null
  const o = parsed as Record<string, unknown>
  if (o.version !== HISTORY_VERSION) return null
  if (!Array.isArray(o.samples)) return null
  const out: QuotaSample[] = []
  for (const entry of o.samples) {
    const s = sampleOf(entry)
    if (s) out.push(s)
  }
  return out
}

interface Building {
  cycle: Cycle
  count: number
}

function begin(s: QuotaSample, tag: 'START' | 'RESET'): Building {
  return {
    cycle: {
      start: s.t, end: null, resetsAt: s.r, peak: s.p, peakAt: s.t, last: s.p,
      complete: false, capped: s.p >= CAP_PERCENT, tags: [tag], fitStart: s.t,
    },
    count: 1,
  }
}

function absorb(b: Building, s: QuotaSample): void {
  b.count++
  b.cycle.last = s.p
  if (s.r !== null) b.cycle.resetsAt = s.r
  if (s.p > b.cycle.peak) {
    b.cycle.peak = s.p
    b.cycle.peakAt = s.t
  }
  if (b.cycle.peak >= CAP_PERCENT) b.cycle.capped = true
}

/**
 * Splits one window's samples into cycles.
 *
 * A cycle ends when the provider announces a different `resetsAt` or when the percentage
 * falls by five points or more without one — providers do not always publish the reset,
 * and a fall is the only other honest evidence that the window turned over. A rise that
 * is too steep to come from usage is a re-basing: it stays inside the cycle but moves
 * `fitStart`, so the forecast does not fit a slope across the step.
 */
function cyclesOf(list: QuotaSample[]): Cycle[] {
  if (list.length === 0) return []
  const out: Cycle[] = []
  let cur = begin(list[0], 'START')
  for (let i = 1; i < list.length; i++) {
    const prev = list[i - 1]
    const s = list[i]
    // A null resetsAt means "the source does not say", not "the reset time changed".
    const resetChanged = prev.r !== null && s.r !== null && prev.r !== s.r
    const fell = prev.p - s.p >= CYCLE_DROP_POINTS
    if (resetChanged || fell) {
      cur.cycle.end = prev.t
      cur.cycle.complete = cur.count >= 3
      out.push(cur.cycle)
      cur = begin(s, 'RESET')
      continue
    }
    const hours = (s.t - prev.t) / HOUR_MS
    const rise = s.p - prev.p
    if (rise >= REBASE_MIN_POINTS && hours > 0 && rise / hours > REBASE_POINTS_PER_HOUR) {
      if (!cur.cycle.tags.includes('REBASE')) cur.cycle.tags.push('REBASE')
      cur.cycle.fitStart = s.t
    }
    absorb(cur, s)
  }
  // The last cycle is by definition the running one: no end, and no statistics.
  out.push(cur.cycle)
  return out
}

/**
 * True when `cyclesOf` would treat the step from `prev` to `s` as a discontinuity: a reset
 * (announced or inferred from a fall) or a limit re-basing. The one rule set, so that thinning
 * keeps exactly the samples the cycle split needs.
 */
function breaks(prev: QuotaSample, s: QuotaSample): boolean {
  const resetChanged = prev.r !== null && s.r !== null && prev.r !== s.r
  if (resetChanged || prev.p - s.p >= CYCLE_DROP_POINTS) return true
  const hours = (s.t - prev.t) / HOUR_MS
  const rise = s.p - prev.p
  return rise >= REBASE_MIN_POINTS && hours > 0 && rise / hours > REBASE_POINTS_PER_HOUR
}

/**
 * Which thinning slot a sample belongs to, or null when it is not thinned at all. The regime is
 * part of the id, so the last hourly slot before the seven-day line and the first quarter hour
 * inside it never read as one slot.
 */
function slotOf(t: number, now: number, thinOld: boolean): string | null {
  if (t >= now - THIN_RECENT_DAYS * DAY_MS) return `q${Math.floor(t / THIN_RECENT_SLOT_MS)}`
  return thinOld ? `h${Math.floor(t / THIN_OLD_SLOT_MS)}` : null
}

/**
 * One stream (same source, window and identity, sorted by time) thinned to one sample per slot.
 *
 * The last reading of a slot wins, so the newest value is always the one kept. Kept regardless
 * of the slot: the newest reading of the stream, the last sample before and the first sample
 * after a discontinuity (so `cyclesOf` and the forecast fits keep their anchors), and any
 * sample whose removal would make its neighbours look like a discontinuity the readings never
 * showed — a gradual fall of five points across a slot is not a reset and must not become one.
 * The cycle split therefore sees the same starts, ends and fit boundaries before and after.
 */
function thinned(list: QuotaSample[], now: number, thinOld: boolean): QuotaSample[] {
  const n = list.length
  if (n < 2) return list
  const out: QuotaSample[] = []
  let lastKept: QuotaSample | null = null
  for (let i = 0; i < n; i++) {
    const s = list[i]
    const next = i + 1 < n ? list[i + 1] : null
    const prev = i > 0 ? list[i - 1] : null
    const slot = slotOf(s.t, now, thinOld)
    const keep = next === null
      || slot === null
      || slotOf(next.t, now, thinOld) !== slot
      || (prev !== null && breaks(prev, s))
      || breaks(s, next)
      || (lastKept !== null && breaks(lastKept, next))
    if (keep) {
      out.push(s)
      lastKept = s
    }
  }
  return out
}

function streamKey(s: QuotaSample): string {
  return `${s.s}|${s.w}|${s.f}`
}

/** Every stream (or only the streams in `only`) thinned; the result is sorted by time again. */
function thinAll(list: QuotaSample[], now: number, thinOld: boolean, only?: Set<string>): QuotaSample[] {
  const streams = new Map<string, QuotaSample[]>()
  const out: QuotaSample[] = []
  for (const s of list) {
    const key = streamKey(s)
    if (only && !only.has(key)) {
      out.push(s)
      continue
    }
    const stream = streams.get(key)
    if (stream) stream.push(s)
    else streams.set(key, [s])
  }
  for (const stream of streams.values()) out.push(...thinned(stream, now, thinOld))
  return out.sort((a, b) => a.t - b.t)
}

/**
 * The persisted quota time series.
 *
 * One file per extension installation in globalStorage, shared by every VS Code window
 * of this editor. Writes merge instead of overwriting, because each window only knows
 * what it read itself and last-writer-wins would silently throw the rest away.
 */
export class QuotaHistory {
  private items: QuotaSample[] = []
  private keys = new Set<string>()
  private loaded = false
  /** At most one `.corrupt-<ts>` copy per instance — a broken file must not breed copies. */
  private corruptKept = false
  /**
   * The `now` of the last `prune`. A save merges the file back in, and without the horizon the
   * merge would resurrect every sample the prune had just dropped — retention and thinning
   * only hold on disk when the save applies the same rules to the union.
   */
  private horizon: number | null = null

  constructor(
    private readonly file: string,
    private retentionDays: number,
    private readonly maxSamples: number = DEFAULT_MAX_SAMPLES,
  ) {}

  /**
   * New retention window. `tokenPace.quotaHistoryDays` can change while the window is open,
   * and rebuilding the instance would drop the loaded samples for nothing — the next `prune`
   * simply uses the new horizon.
   */
  setRetentionDays(days: number): void {
    if (Number.isFinite(days) && days >= 0) this.retentionDays = Math.floor(days)
  }

  /** Missing file = normal first start. Unreadable file = keep one copy, then start empty. */
  load(): void {
    this.loaded = true
    let raw: string
    try {
      raw = fs.readFileSync(this.file, 'utf8')
    } catch {
      this.setItems([])
      return
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      this.keepCorrupt()
      this.setItems([])
      return
    }
    const list = samplesOf(parsed)
    if (!list) {
      this.keepCorrupt()
      this.setItems([])
      return
    }
    this.setItems(list)
  }

  /**
   * Atomic write with merge-on-save: re-read the file, union by (s, w, t, f), sort by
   * time, apply the last prune's retention and thinning to the union (else the file would
   * hand back what the prune dropped), cap, then tmp + rename. Best effort — history is a
   * convenience, so a read-only storage directory must never break the poll loop.
   */
  save(): void {
    const merged = new Map<string, QuotaSample>()
    for (const s of this.readFile()) merged.set(keyOf(s), s)
    for (const s of this.items) merged.set(keyOf(s), s)
    let list = [...merged.values()].sort((a, b) => a.t - b.t)
    list = this.horizon === null ? this.capped(list) : this.trimmed(list, this.horizon)
    this.setItems(list)
    this.writeFile(list)
  }

  /**
   * Adds one sample per window of a real reading and returns how many were kept.
   *
   * Caller contract: only pass a state that came from an actual reading — a poll answer,
   * a push notification, or a file whose `fetchedAt` moved. A state replayed from memory
   * (a redraw, a mode switch, a follower reloading the snapshot) must not reach this
   * method. The value guard below catches most repetitions, but only the caller can tell
   * a fresh identical reading from a replay of the same one.
   *
   * Write guard: a sample is dropped when (w, t, f) already exists, or when percent and
   * resetsAt equal the previous sample of that window — unless more than six hours passed,
   * because then the sample is the evidence that the gap ended.
   *
   * Thinning: inside the last seven days a stream keeps one sample per quarter hour, and a new
   * reading in a slot that already holds one replaces it — except the anchors around a reset,
   * which stay (see `thinned`). The thinning is a write rule, not a file format: the schema
   * version is unchanged, a dense version-1 file loads as it is and is thinned by the next
   * `prune`, and samples another window merged into the file are thinned by the next `add`.
   */
  add(state: QuotaState, fingerprint: string, now: number): number {
    this.ensure()
    if (!state.ok) return 0
    const origin = state.origin
    if (!origin || !ORIGINS.includes(origin)) return 0
    let t: number
    if (typeof state.fetchedAt === 'number' && Number.isFinite(state.fetchedAt)) {
      t = Math.round(state.fetchedAt * 1000)
    } else if (origin === 'push') {
      // A push carries no timestamp of its own; it arrives when it arrives.
      t = Math.round(now)
    } else {
      return 0
    }
    let added = 0
    const touched = new Set<string>()
    for (const w of state.windows ?? []) {
      if (!w || typeof w.id !== 'string' || w.id === '') continue
      const p = w.percent
      if (typeof p !== 'number' || !Number.isFinite(p) || p < 0) continue
      const r = typeof w.resetsAt === 'number' && Number.isFinite(w.resetsAt) ? w.resetsAt : null
      const sample: QuotaSample = { s: state.source, w: w.id, t, p, r, o: origin, f: fingerprint }
      const key = keyOf(sample)
      if (this.keys.has(key)) continue
      const prev = this.previous(sample)
      if (prev && prev.p === p && prev.r === r && t - prev.t <= GAP_KEEP_MS) continue
      this.items.push(sample)
      this.keys.add(key)
      touched.add(streamKey(sample))
      added++
    }
    if (added > 0) this.setItems(thinAll(this.items, now, false, touched))
    return added
  }

  /** One window's stream of one identity, oldest first. */
  samples(source: Source, windowId: string, fingerprint: string, sinceMs?: number): QuotaSample[] {
    this.ensure()
    const from = sinceMs ?? Number.NEGATIVE_INFINITY
    return this.items.filter((s) => s.s === source && s.w === windowId && s.f === fingerprint && s.t >= from)
  }

  cycles(source: Source, windowId: string, fingerprint: string): Cycle[] {
    return cyclesOf(this.samples(source, windowId, fingerprint))
  }

  /** Stretches without any reading — periods of no coverage, never zeroes. */
  gaps(samples: QuotaSample[], maxGapMs: number): Array<{ from: number; to: number }> {
    const list = [...samples].sort((a, b) => a.t - b.t)
    const out: Array<{ from: number; to: number }> = []
    for (let i = 1; i < list.length; i++) {
      if (list[i].t - list[i - 1].t > maxGapMs) out.push({ from: list[i - 1].t, to: list[i].t })
    }
    return out
  }

  /**
   * Retention first, then thinning (a quarter hour inside the last seven days, an hour beyond),
   * then the hard cap — the oldest samples go. Call `save()` to persist.
   */
  prune(now: number): void {
    this.ensure()
    this.horizon = now
    this.setItems(this.trimmed(this.items, now))
  }

  size(): { samples: number; bytes: number; oldest: number | null } {
    this.ensure()
    let bytes: number
    try {
      bytes = fs.statSync(this.file).size
    } catch {
      bytes = Buffer.byteLength(JSON.stringify({ version: HISTORY_VERSION, samples: this.items }))
    }
    return { samples: this.items.length, bytes, oldest: this.items.length > 0 ? this.items[0].t : null }
  }

  /** Drops everything, in memory and on disk (Clear Stored Data). */
  clear(): void {
    this.loaded = true
    this.setItems([])
    try {
      fs.unlinkSync(this.file)
    } catch {
      /* already gone */
    }
  }

  private ensure(): void {
    if (!this.loaded) this.load()
  }

  /** Retention, thinning, cap — the prune rules, in that order. */
  private trimmed(list: QuotaSample[], now: number): QuotaSample[] {
    const cutoff = now - this.retentionDays * DAY_MS
    return this.capped(thinAll(list.filter((s) => s.t >= cutoff), now, true))
  }

  private capped(list: QuotaSample[]): QuotaSample[] {
    return list.length > this.maxSamples ? list.slice(list.length - this.maxSamples) : list
  }

  private setItems(list: QuotaSample[]): void {
    list.sort((a, b) => a.t - b.t)
    this.items = list
    this.keys = new Set(list.map(keyOf))
  }

  private previous(s: QuotaSample): QuotaSample | null {
    let best: QuotaSample | null = null
    for (const c of this.items) {
      if (c.s !== s.s || c.w !== s.w || c.f !== s.f) continue
      if (c.t > s.t) continue
      if (!best || c.t > best.t) best = c
    }
    return best
  }

  private readFile(): QuotaSample[] {
    let raw: string
    try {
      raw = fs.readFileSync(this.file, 'utf8')
    } catch {
      return []
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      this.keepCorrupt()
      return []
    }
    const list = samplesOf(parsed)
    if (!list) {
      this.keepCorrupt()
      return []
    }
    return list
  }

  private keepCorrupt(): void {
    if (this.corruptKept) return
    this.corruptKept = true
    try {
      fs.copyFileSync(this.file, `${this.file}.corrupt-${Date.now()}`)
    } catch {
      /* best effort: the copy is a courtesy, not a guarantee */
    }
  }

  private writeFile(list: QuotaSample[]): void {
    const tmp = `${this.file}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true })
      fs.writeFileSync(tmp, JSON.stringify({ version: HISTORY_VERSION, samples: list }))
      fs.renameSync(tmp, this.file)
    } catch {
      try {
        fs.unlinkSync(tmp)
      } catch {
        /* nothing to clean up */
      }
    }
  }
}
