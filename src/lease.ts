// SPDX-FileCopyrightText: 2026 Frederik Marx
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Leader election between several VS Code windows.
 *
 * Without it every window polls the same rate-limit bucket and fires its own
 * notifications. The lease is a single file in globalStorage holding the pid, a
 * random id and an expiry; it is deliberately advisory.
 *
 * The governing rule is "in doubt, poll yourself": every read or parse error
 * makes the lease look acquirable. A window that wrongly believes it leads costs
 * one extra request; a window that wrongly believes it follows shows stale
 * figures forever, which is the worse failure.
 */

import * as crypto from 'crypto'
import * as fs from 'fs'
import * as path from 'path'

export interface LeaseRecord {
  pid: number
  id: string
  /** Unix ms; a lease past this belongs to nobody, whatever the pid says. */
  expiresAt: number
}

const DEFAULT_TTL_MS = 90_000

/** Whether a process is still around. EPERM means "alive but not ours to signal". */
function processAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return (e as NodeJS.ErrnoException).code !== 'ESRCH'
  }
}

function parse(raw: string): LeaseRecord | null {
  let d: any
  try {
    d = JSON.parse(raw)
  } catch {
    return null
  }
  if (typeof d?.pid !== 'number' || typeof d?.id !== 'string' || typeof d?.expiresAt !== 'number') return null
  if (!Number.isFinite(d.expiresAt)) return null
  return { pid: d.pid, id: d.id, expiresAt: d.expiresAt }
}

export class Lease {
  /** Random per window, so a pid reused by the OS cannot pass as us. */
  readonly id = crypto.randomBytes(8).toString('hex')

  constructor(
    private readonly file: string,
    private readonly ttlMs = DEFAULT_TTL_MS,
    private readonly log: (m: string) => void = () => { /* silent by default */ },
  ) {}

  /** The current record, or null when there is none we can read. */
  holder(): { pid: number; expiresAt: number } | null {
    const r = this.read()
    return r ? { pid: r.pid, expiresAt: r.expiresAt } : null
  }

  isLeader(now = Date.now()): boolean {
    const r = this.read()
    return r !== null && r.id === this.id && this.live(r, now)
  }

  /**
   * Takes the lease when it is free, dead or ours; leaves it alone otherwise.
   *
   * A record is dead when it has expired or when its process is gone. Anything
   * unreadable counts as free — see the rule at the top of this file.
   */
  tryAcquire(now = Date.now()): boolean {
    const r = this.read()
    if (r && r.id !== this.id && this.live(r, now) && processAlive(r.pid)) return false
    return this.write(now)
  }

  /**
   * Whether a record can still be running.
   *
   * Every writer sets `expiresAt` to its own now + TTL, so an expiry further
   * ahead than two TTLs cannot have been written by a clock that agrees with
   * ours — a VM resumed with a fast clock, a dead CMOS battery, an NTP step.
   * Such a record is treated as expired rather than as an eternal holder:
   * combined with a pid the OS has since reused it would otherwise keep every
   * window a follower for as long as its bogus expiry runs, and "in doubt, poll
   * yourself" is the rule of this file. `holder()` still reports it verbatim so
   * diagnostics can show what is actually on disk.
   */
  private live(r: LeaseRecord, now: number): boolean {
    return r.expiresAt > now && r.expiresAt <= now + 2 * this.ttlMs
  }

  /** Extends the lease, but only while we still hold it. */
  renew(now = Date.now()): boolean {
    const r = this.read()
    if (!r || r.id !== this.id) return false
    return this.write(now)
  }

  /** Gives the lease up. A record that is not ours is never deleted. */
  release(): void {
    const r = this.read()
    if (!r || r.id !== this.id) return
    try {
      fs.unlinkSync(this.file)
    } catch {
      /* already gone — nothing to release */
    }
  }

  private read(): LeaseRecord | null {
    try {
      return parse(fs.readFileSync(this.file, 'utf8'))
    } catch {
      return null
    }
  }

  /**
   * tmp + rename, with the tmp file created exclusively ('wx').
   *
   * The rename is the atomic step: readers see either the old or the new record,
   * never a half-written one.
   */
  private write(now: number): boolean {
    const rec: LeaseRecord = { pid: process.pid, id: this.id, expiresAt: now + this.ttlMs }
    const tmp = `${this.file}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true })
      fs.writeFileSync(tmp, JSON.stringify(rec), { flag: 'wx' })
      fs.renameSync(tmp, this.file)
      return true
    } catch (e) {
      this.log(`lease: could not write ${this.file} (${(e as Error).name})`)
      try { fs.unlinkSync(tmp) } catch { /* nothing to clean up */ }
      return false
    }
  }
}
