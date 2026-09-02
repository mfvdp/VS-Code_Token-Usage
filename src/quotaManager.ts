import * as fs from 'fs'
import { poll } from './poller'
import { readClaudeQuota, readCodexQuota } from './quota'
import { QuotaState, Source } from './types'

export type QuotaSource = 'auto' | 'poll' | 'cache'

export interface QuotaOptions {
  mode: QuotaSource
  intervalMinutes: number
  claudeDir?: string
  codexBinary?: string
}

/** Why a fetch did not happen — so the caller can say something useful. */
export type Blocked = 'mode' | 'consent' | null

const SOURCES: Source[] = ['claude', 'codex']

/**
 * Whether the mode permits a fetch of our own.
 *
 * Only `poll` does, on every platform. `auto` reads the cache file and offers
 * once to switch — it deliberately does not start using the access token by
 * itself. `cache` is the same minus the offer, for anyone who wants the
 * question settled for good.
 */
export function pollsItself(mode: QuotaSource): boolean {
  return mode === 'poll'
}

function ageSeconds(s: QuotaState | null): number {
  if (!s?.fetchedAt) return Infinity
  return Date.now() / 1000 - s.fetchedAt
}

/**
 * Serves the quota from whichever source is best available.
 *
 * `auto` prefers a fresh cache file from an external poller and only fetches by
 * itself when that is missing or stale. So on a system with a panel plugin two
 * clients never knock on the same rate-limit bucket, while the extension still
 * works standalone elsewhere.
 */
export class QuotaManager {
  private polled: Partial<Record<Source, QuotaState>> = {}
  private problem: Partial<Record<Source, string>> = {}
  private failCount: Record<Source, number> = { claude: 0, codex: 0 }
  private nextPollAt: Record<Source, number> = { claude: 0, codex: 0 }
  private inFlight: Partial<Record<Source, boolean>> = {}
  /** Sources with a forced fetch pending — skips the freshness check. */
  private forced = new Set<Source>()

  constructor(
    private opts: QuotaOptions,
    private stateFile: string,
    private log: (msg: string) => void,
    /** Second gate: the mode may allow a fetch, the user still has to have agreed. */
    private consented: () => boolean = () => true,
  ) {
    this.restore()
  }

  /** Why `tick` would do nothing, or null if a fetch may happen. */
  blocked(): Blocked {
    if (!pollsItself(this.opts.mode)) return 'mode'
    if (!this.consented()) return 'consent'
    return null
  }

  setOptions(opts: QuotaOptions): void {
    this.opts = opts
  }

  /** Current state, without touching the network. */
  current(): QuotaState[] {
    return SOURCES.map((src) => {
      const cache = this.opts.mode === 'poll' ? null : src === 'claude' ? readClaudeQuota() : readCodexQuota()
      const own = this.polled[src] ?? null
      // The younger of the two sources wins.
      const best = cache?.ok && ageSeconds(cache) <= ageSeconds(own) ? cache : own?.ok ? own : cache
      if (best?.ok) return best
      const p = this.problem[src] ?? best?.problem
      return { source: src, ok: false, fetchedAt: best?.fetchedAt ?? null, planType: null, windows: [], problem: p }
    })
  }

  /** Kicks off due fetches. Runs in the background; the result lands in `current()`. */
  tick(onUpdate: () => void): void {
    if (this.blocked()) return
    const now = Date.now()
    const intervalMs = Math.max(1, this.opts.intervalMinutes) * 60_000

    for (const src of SOURCES) {
      if (this.inFlight[src]) continue
      if (now < this.nextPollAt[src]) continue

      const forced = this.forced.delete(src)
      if (!forced) {
        if (this.opts.mode !== 'poll') {
          // Fresh external cache? Then no fetch of our own is needed.
          const cache = src === 'claude' ? readClaudeQuota() : readCodexQuota()
          if (cache.ok && ageSeconds(cache) * 1000 < intervalMs) {
            this.nextPollAt[src] = now + 60_000
            continue
          }
        }
        // Is our own state still fresh enough?
        const own = this.polled[src]
        if (own?.ok && ageSeconds(own) * 1000 < intervalMs) {
          this.nextPollAt[src] = (own.fetchedAt ?? 0) * 1000 + intervalMs
          continue
        }
      }

      this.inFlight[src] = true
      const opt = src === 'claude' ? this.opts.claudeDir : this.opts.codexBinary
      void poll(src, this.failCount[src], opt)
        .then((r) => {
          if (r.state) {
            this.polled[src] = r.state
            delete this.problem[src]
            this.failCount[src] = 0
            this.nextPollAt[src] = Date.now() + intervalMs
            this.log(`${src}: quota fetched`)
            this.persist()
          } else {
            this.problem[src] = r.problem ?? 'Fetch failed'
            this.failCount[src] += 1
            // No retry hint means a permanent cause (missing credentials, no
            // binary) — do not keep asking every minute in that case.
            const wait = r.retryAfterSeconds ?? intervalMs / 1000
            this.nextPollAt[src] = Date.now() + wait * 1000
            this.log(`${src}: ${this.problem[src]} — next attempt in ${Math.round(wait / 60)} min`)
          }
        })
        .catch((e) => {
          this.problem[src] = 'Unexpected error while fetching'
          this.failCount[src] += 1
          this.nextPollAt[src] = Date.now() + intervalMs
          this.log(`${src}: ${e}`)
        })
        .finally(() => {
          this.inFlight[src] = false
          onUpdate()
        })
    }
  }

  /** Immediate fetch, regardless of the interval. Neither gate is bypassed. */
  forcePoll(onUpdate: () => void): void {
    const why = this.blocked()
    if (why) {
      this.log(why === 'mode'
        ? `No fetch of our own: quotaSource is "${this.opts.mode}". Set it to "poll" to fetch here.`
        : 'No fetch of our own: network access has not been allowed.')
      onUpdate()
      return
    }
    // Deliberately KEEP the previous state: if the forced fetch fails, a
    // slightly older value still beats an empty display.
    this.nextPollAt = { claude: 0, codex: 0 }
    for (const src of SOURCES) this.forced.add(src)
    this.tick(onUpdate)
  }

  private persist(): void {
    try {
      fs.writeFileSync(this.stateFile, JSON.stringify(this.polled))
    } catch {
      /* Losing this is survivable — the next interval fetches again. */
    }
  }

  private restore(): void {
    try {
      const d = JSON.parse(fs.readFileSync(this.stateFile, 'utf8'))
      for (const src of SOURCES) {
        if (d?.[src]?.ok) {
          this.polled[src] = d[src]
          // Do not fetch again immediately after a restart.
          this.nextPollAt[src] = (d[src].fetchedAt ?? 0) * 1000 + this.opts.intervalMinutes * 60_000
        }
      }
    } catch {
      /* nothing stored yet */
    }
  }
}
