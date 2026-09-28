// SPDX-FileCopyrightText: 2026 Frederik Marx
// SPDX-License-Identifier: AGPL-3.0-or-later

import { strict as assert } from 'node:assert'
import { spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import { test } from 'node:test'
import { Lease, LEASE_RENEW_MS, LEASE_TTL_MS } from '../src/lease'
import { scratchFile } from './fixtures/helpers'
import { pidAlive } from './helpers/fakeAppServer'

const NOW = 1_700_000_000_000
const TTL = 90_000

function tmpFile(): string {
  return scratchFile('lease', 'leader.json')
}

/** A pid that is certainly gone — needed for the "holder died" case. */
function deadPid(): number {
  for (let pid = 40_000; pid < 60_000; pid++) {
    try {
      process.kill(pid, 0)
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ESRCH') return pid
    }
  }
  throw new Error('no free pid found')
}

test('a free lease is taken and held', () => {
  const file = tmpFile()
  const a = new Lease(file, TTL)
  assert.equal(a.tryAcquire(NOW), true)
  assert.equal(a.isLeader(NOW), true)
  assert.equal(a.holder()?.pid, process.pid)
  assert.equal(a.holder()?.expiresAt, NOW + TTL)
})

test('a live lease of another window is left alone', () => {
  const file = tmpFile()
  const a = new Lease(file, TTL)
  const b = new Lease(file, TTL)
  assert.equal(a.tryAcquire(NOW), true)
  assert.equal(b.tryAcquire(NOW + 1_000), false)
  assert.equal(b.isLeader(NOW + 1_000), false)
  assert.equal(a.isLeader(NOW + 1_000), true)
})

test('an expired lease is taken over', () => {
  const file = tmpFile()
  const a = new Lease(file, TTL)
  const b = new Lease(file, TTL)
  a.tryAcquire(NOW)
  assert.equal(b.tryAcquire(NOW + TTL + 1), true)
  assert.equal(b.isLeader(NOW + TTL + 1), true)
  assert.equal(a.isLeader(NOW + TTL + 1), false)
})

test('a lease whose process is gone is dead, however long its TTL runs', () => {
  const file = tmpFile()
  fs.writeFileSync(file, JSON.stringify({ pid: deadPid(), id: 'someone-else', expiresAt: NOW + 10 * TTL }))
  const a = new Lease(file, TTL)
  assert.equal(a.tryAcquire(NOW), true)
  assert.equal(a.isLeader(NOW), true)
})

test('a lease whose expiry cannot be its own is treated as expired', () => {
  const file = tmpFile()
  // A window wrote this under a clock a day fast, then died without releasing;
  // the OS handed its pid to a long-lived process afterwards (here: ours).
  fs.writeFileSync(file, JSON.stringify({ pid: process.pid, id: 'someone-else', expiresAt: NOW + 24 * 3_600_000 }))
  const a = new Lease(file, TTL)

  assert.equal(a.holder()?.expiresAt, NOW + 24 * 3_600_000, 'diagnostics still see what is on disk')
  assert.equal(a.tryAcquire(NOW), true, 'in doubt, poll yourself')
  assert.equal(a.isLeader(NOW), true)
  assert.equal(a.holder()?.expiresAt, NOW + TTL)
})

test('an expiry within two TTLs is still a live lease', () => {
  const file = tmpFile()
  // A holder that renewed a moment ago, read by a window whose clock is a
  // little behind: plausible, so it keeps the lease.
  fs.writeFileSync(file, JSON.stringify({ pid: process.pid, id: 'someone-else', expiresAt: NOW + TTL + 5_000 }))
  const a = new Lease(file, TTL)
  assert.equal(a.tryAcquire(NOW), false)
})

test('only the holder renews', () => {
  const file = tmpFile()
  const a = new Lease(file, TTL)
  const b = new Lease(file, TTL)
  a.tryAcquire(NOW)
  assert.equal(b.renew(NOW + 1_000), false)
  assert.equal(a.holder()?.expiresAt, NOW + TTL)
  assert.equal(a.renew(NOW + 1_000), true)
  assert.equal(a.holder()?.expiresAt, NOW + 1_000 + TTL)
})

test('a corrupt or truncated file is treated as free — in doubt, poll yourself', () => {
  const file = tmpFile()
  fs.writeFileSync(file, '{ "pid": 12')
  const a = new Lease(file, TTL)
  assert.equal(a.holder(), null)
  assert.equal(a.tryAcquire(NOW), true)
  assert.equal(a.isLeader(NOW), true)
})

test('a record without the expected fields is not a lease', () => {
  const file = tmpFile()
  fs.writeFileSync(file, JSON.stringify({ pid: 'not-a-number', id: 7 }))
  const a = new Lease(file, TTL)
  assert.equal(a.tryAcquire(NOW), true)
})

test('release removes our own record and never someone else’s', () => {
  const file = tmpFile()
  const a = new Lease(file, TTL)
  const b = new Lease(file, TTL)
  a.tryAcquire(NOW)
  b.release()
  assert.equal(fs.existsSync(file), true)
  a.release()
  assert.equal(fs.existsSync(file), false)
  // Releasing twice is not an error.
  a.release()
})

test('a lease is renewable after re-acquiring the same file', () => {
  const file = tmpFile()
  const a = new Lease(file, TTL)
  a.tryAcquire(NOW)
  a.release()
  assert.equal(a.renew(NOW + 100), false)
  assert.equal(a.tryAcquire(NOW + 200), true)
  assert.equal(a.renew(NOW + 300), true)
})

// ---------------------------------------------------------------------------
// 1.13 B7 (L10, §0a.4, §7a Q20): the watchdog is the lease's own expiry — named, and its two takeovers timed on a fake
// clock. Another window runs `tryAcquire` every LEASE_RENEW_MS (extension.ts `updateRole`); `checks` is that loop.
// ---------------------------------------------------------------------------

/** Another window's checks, every LEASE_RENEW_MS from `first` on, at most `max` of them: the moment the first one took the lease, or null. */
function takenAt(b: Lease, first: number, max = 8): number | null {
  for (let i = 0, t = first; i < max; i++, t += LEASE_RENEW_MS) if (b.tryAcquire(t)) return t
  return null
}

test('the heartbeat is the expiry: LEASE_TTL_MS is three renewal intervals, and a lease written with the defaults runs one TTL ahead (1.13 B7 rule 2)', () => {
  assert.equal(LEASE_RENEW_MS, 30_000)
  assert.equal(LEASE_TTL_MS, 3 * LEASE_RENEW_MS)
  assert.equal(LEASE_TTL_MS, TTL, 'the TTL of 1.0.0 (90 s) moved')
  const a = new Lease(tmpFile())
  assert.equal(a.tryAcquire(NOW), true)
  assert.equal(a.holder()?.expiresAt, NOW + LEASE_TTL_MS)
  // Renewed at every check, it never lapses: three intervals ahead after each.
  for (let t = NOW; t <= NOW + 10 * LEASE_RENEW_MS; t += LEASE_RENEW_MS) assert.equal(a.tryAcquire(t), true)
  assert.equal(a.holder()?.expiresAt, NOW + 10 * LEASE_RENEW_MS + LEASE_TTL_MS)
})

test('(a) a leader whose process is gone — a crashed window — is taken over at another window\'s next check, within one renewal interval, however fresh its record (1.13 B7 rule 3 a)', () => {
  // A window's process that ended: `process.execPath -e ''`, exited and reaped by spawnSync before it returns (its own
  // timeout, SIGKILL, bounds it — §0b.10). Its pid names nobody now; it is never signalled afterwards, since a reaped
  // pid may be reused (§7a Q20: Token Pace kills no process by a pid it read).
  let pid = 0
  try {
    const child = spawnSync(process.execPath, ['-e', ''], { stdio: 'ignore', timeout: 10_000, killSignal: 'SIGKILL' })
    assert.equal(child.status, 0, String(child.error ?? child.signal))
    pid = child.pid
    assert.ok(Number.isInteger(pid) && pid > 0 && pid !== process.pid)
    assert.equal(pidAlive(pid), false, 'the crashed window\'s process is still there')
    for (const phase of [1, LEASE_RENEW_MS / 2, LEASE_RENEW_MS - 1]) {
      // Its last renewal a moment before the crash: the whole TTL still ahead.
      const file = tmpFile()
      fs.writeFileSync(file, JSON.stringify({ pid, id: 'crashed-window-0123456789abcdef', expiresAt: NOW + LEASE_TTL_MS }))
      const b = new Lease(file)
      const at = takenAt(b, NOW + phase)
      assert.equal(at, NOW + phase, `phase ${phase}: the first check after the crash did not take it`)
      assert.ok(at !== null && at - NOW < LEASE_RENEW_MS)
      assert.equal(b.isLeader(at), true)
      assert.equal(b.holder()?.pid, process.pid)
    }
    // Against the same record with its process alive (ours, another window's id): no check takes it before its expiry.
    const file = tmpFile()
    fs.writeFileSync(file, JSON.stringify({ pid: process.pid, id: 'live-window-0123456789abcdef', expiresAt: NOW + LEASE_TTL_MS }))
    assert.equal(takenAt(new Lease(file), NOW + 1), NOW + 1 + LEASE_TTL_MS)
  } finally {
    if (pid > 0) assert.equal(pidAlive(pid), false, 'the child outlived the test')
  }
})

test('(b) a leader alive but silent — a window whose host hangs, its pid ours, its record never renewed — is taken after LEASE_TTL_MS and not before (1.13 B7 rule 3 b)', () => {
  const hung = (): string => {
    const file = tmpFile()
    // Renewed last at NOW, then never again: the process is alive (the test's own pid), the window says nothing.
    fs.writeFileSync(file, JSON.stringify({ pid: process.pid, id: 'hung-window-0123456789abcdef', expiresAt: NOW + LEASE_TTL_MS }))
    return file
  }
  // Just before its expiry no window takes it; at its expiry the next one does.
  const early = new Lease(hung())
  assert.equal(early.tryAcquire(NOW + LEASE_TTL_MS - 1), false)
  assert.equal(early.tryAcquire(NOW + LEASE_TTL_MS), true)
  // On another window's own interval, whatever its phase: the first check at or past the expiry — the third interval
  // or the fourth, never sooner, never later than one interval after the expiry.
  for (const phase of [0, 1, LEASE_RENEW_MS / 2, LEASE_RENEW_MS - 1]) {
    const b = new Lease(hung())
    const at = takenAt(b, NOW + phase)
    assert.ok(at !== null, `phase ${phase}: never taken`)
    assert.ok(at >= NOW + LEASE_TTL_MS && at < NOW + LEASE_TTL_MS + LEASE_RENEW_MS, `phase ${phase}: taken at +${at - NOW} ms`)
    assert.equal(b.isLeader(at), true)
  }
})
