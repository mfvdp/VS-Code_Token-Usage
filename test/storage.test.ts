// SPDX-FileCopyrightText: 2026 Frederik Marx
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Inventory and deletion of the extension's own storage — the mechanics behind
 * "Clear Stored Data". Real files in a temp directory, because the promise is
 * that the bytes are gone, not that a function returned true.
 */

import { strict as assert } from 'node:assert'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { test } from 'node:test'
import { deleteItems, formatBytes, inventory, MementoLike, StoredPaths, storedFile } from '../src/storage'

const SCRATCH = '/tmp/claude-1000/-home-frederik-Claude-VS-Code-Tokens/9d0eb37a-71d8-4832-9deb-36dcbfb5985b/scratchpad'

function tmpDir(): string {
  const base = fs.existsSync(SCRATCH) ? SCRATCH : os.tmpdir()
  return fs.mkdtempSync(path.join(base, 'storage-'))
}

class FakeMemento implements MementoLike {
  store = new Map<string, unknown>()

  get<T>(key: string, defaultValue: T): T {
    return this.store.has(key) ? (this.store.get(key) as T) : defaultValue
  }

  update(key: string, value: unknown): PromiseLike<void> {
    if (value === undefined) this.store.delete(key)
    else this.store.set(key, value)
    return Promise.resolve()
  }
}

function pathsIn(dir: string): StoredPaths {
  return {
    state: path.join(dir, 'state.json'),
    quota: path.join(dir, 'quota.json'),
    history: path.join(dir, 'quotaHistory.json'),
    leader: path.join(dir, 'leader.json'),
    mirror: path.join(dir, 'statusline-mirror.json'),
  }
}

test('the inventory names size and presence of every item', () => {
  const dir = tmpDir()
  const paths = pathsIn(dir)
  fs.writeFileSync(paths.state, '{"version":5}')
  fs.writeFileSync(paths.quota, '[]')
  const memento = new FakeMemento()
  memento.store.set('networkConsent', 'granted')
  memento.store.set('tokenPace.ui', { range: '30d' })

  const items = inventory(paths, memento, { state: 'oldest day 2026-05-01' })
  const byKey = new Map(items.map((i) => [i.key, i]))

  assert.deepEqual(items.map((i) => i.key), ['state', 'quota', 'history', 'mirror', 'consent', 'alerts', 'ui'])
  assert.equal(byKey.get('state')!.present, true)
  assert.equal(byKey.get('state')!.bytes, 13)
  assert.equal(byKey.get('state')!.detail, 'oldest day 2026-05-01')
  assert.equal(byKey.get('history')!.present, false)
  assert.equal(byKey.get('history')!.bytes, 0)
  assert.equal(byKey.get('consent')!.present, true)
  assert.ok(byKey.get('consent')!.bytes > 0)
  assert.equal(byKey.get('alerts')!.present, false)
  assert.equal(byKey.get('ui')!.present, true)
})

test('the lease is not offered for deletion', () => {
  const dir = tmpDir()
  const items = inventory(pathsIn(dir), new FakeMemento())
  assert.ok(!items.some((i) => i.label.includes('leader')))
})

test('deleting a file removes its interrupted temp sibling too', async () => {
  const dir = tmpDir()
  const paths = pathsIn(dir)
  fs.writeFileSync(paths.state, '{}')
  fs.writeFileSync(`${paths.state}.tmp`, '{"half":')
  const memento = new FakeMemento()

  const result = await deleteItems(['state'], paths, memento)
  assert.deepEqual(result, { deleted: ['state'], failed: [] })
  assert.equal(fs.existsSync(paths.state), false)
  assert.equal(fs.existsSync(`${paths.state}.tmp`), false)
})

test('every temp shape the writers use is swept, and nothing else is', async () => {
  const dir = tmpDir()
  const paths = pathsIn(dir)
  // One per writer: state.ts, statuslineBridge.ts, quotaHistory/lease/quota.ts, bridge.ts.
  const temps = [
    `${paths.mirror}.tmp`,
    `${paths.mirror}.48213.tmp`,
    `${paths.mirror}.tmp-48213-9f0c1a2b`,
    `${paths.mirror}.token-pace.tmp`,
  ]
  fs.writeFileSync(paths.mirror, '{"payload":{}}')
  for (const t of temps) fs.writeFileSync(t, '{"cwd":"/home/tester/work"}')
  // A neighbour that is not ours: same directory, different file.
  const neighbour = path.join(dir, 'other.json.tmp')
  fs.writeFileSync(neighbour, 'keep me')

  const result = await deleteItems(['mirror'], paths, new FakeMemento())
  assert.deepEqual(result, { deleted: ['mirror'], failed: [] })
  assert.equal(fs.existsSync(paths.mirror), false)
  for (const t of temps) assert.equal(fs.existsSync(t), false, `${path.basename(t)} survived`)
  assert.equal(fs.existsSync(neighbour), true, 'an unrelated temp file is not ours to delete')
})

test('a file that is already gone counts as deleted', async () => {
  const dir = tmpDir()
  const result = await deleteItems(['quota', 'history', 'mirror'], pathsIn(dir), new FakeMemento())
  assert.deepEqual(result.deleted, ['quota', 'history', 'mirror'])
  assert.deepEqual(result.failed, [])
})

test('deleting the consent item clears every consent key, including the write consents', async () => {
  const dir = tmpDir()
  const memento = new FakeMemento()
  memento.store.set('networkConsent', 'granted')
  memento.store.set('networkConsentOffered', true)
  memento.store.set('writeConsent.writeQuotaCache', 'granted')
  memento.store.set('writeConsent.statusLine', 'denied')
  memento.store.set('tokenPace.alerts', { entries: {} })
  memento.store.set('tokenPace.ui', { range: '7d' })
  memento.store.set('tokenPace.bridge', { installedCommand: 'x' })

  await deleteItems(['consent', 'alerts', 'ui'], pathsIn(dir), memento)

  assert.equal(memento.store.has('networkConsent'), false)
  assert.equal(memento.store.has('networkConsentOffered'), false)
  assert.equal(memento.store.has('writeConsent.writeQuotaCache'), false)
  assert.equal(memento.store.has('writeConsent.statusLine'), false)
  assert.equal(memento.store.has('tokenPace.alerts'), false)
  assert.equal(memento.store.has('tokenPace.ui'), false)
  // The install record is the only way back from an edited settings.json.
  assert.equal(memento.store.has('tokenPace.bridge'), true)
})

test('a file that cannot be removed is reported, not swallowed', async () => {
  const dir = tmpDir()
  const paths = pathsIn(dir)
  // A directory where a file is expected: unlink fails with EISDIR/EPERM.
  fs.mkdirSync(paths.quota)
  const result = await deleteItems(['quota'], paths, new FakeMemento())
  assert.deepEqual(result.deleted, [])
  assert.deepEqual(result.failed, ['quota'])
})

test('storedFile maps only the file-backed keys', () => {
  const paths = pathsIn('/nowhere')
  assert.equal(storedFile('state', paths), paths.state)
  assert.equal(storedFile('mirror', paths), paths.mirror)
  assert.equal(storedFile('consent', paths), null)
})

test('sizes are readable', () => {
  assert.equal(formatBytes(482), '482 B')
  assert.equal(formatBytes(12_300), '12.3 kB')
  assert.equal(formatBytes(1_500_000), '1.5 MB')
  assert.equal(formatBytes(Number.NaN), '–')
})
