// SPDX-FileCopyrightText: 2026 Frederik Marx
// SPDX-License-Identifier: AGPL-3.0-or-later

import { strict as assert } from 'node:assert'
import * as fs from 'node:fs'
import { test } from 'node:test'
import { Lease } from '../src/lease'
import { scratchFile } from './fixtures/helpers'

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
