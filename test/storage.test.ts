// SPDX-FileCopyrightText: 2026 Frederik Marx
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Inventory and deletion of the extension's own storage — the mechanics behind
 * "Clear Stored Data". Real files in a temp directory, because the promise is
 * that the bytes are gone, not that a function returned true.
 */

import { strict as assert } from 'node:assert'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { test } from 'node:test'
import {
  BRIDGE_BLOCKS_DELETE, DELETE_WARNING_EXTERNAL, deleteItems, formatBytes, inventory, MementoLike,
  StoredPaths, storedFile, storedFiles,
} from '../src/storage'
import { scratchDir } from './fixtures/helpers'


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
  const dir = scratchDir('storage')
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
  const dir = scratchDir('storage')
  const items = inventory(pathsIn(dir), new FakeMemento())
  assert.ok(!items.some((i) => i.label.includes('leader')))
})

test('deleting a file removes its interrupted temp sibling too', async () => {
  const dir = scratchDir('storage')
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
  const dir = scratchDir('storage')
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
  const dir = scratchDir('storage')
  const result = await deleteItems(['quota', 'history', 'mirror'], pathsIn(dir), new FakeMemento())
  assert.deepEqual(result.deleted, ['quota', 'history', 'mirror'])
  assert.deepEqual(result.failed, [])
})

test('deleting the consent item clears every consent key, including the write consents', async () => {
  const dir = scratchDir('storage')
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
  const dir = scratchDir('storage')
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

// ---------------------------------------------------------------------------
// The one file outside globalStorage
// ---------------------------------------------------------------------------

test('the shared quota cache is listed only when its paths are supplied', () => {
  const dir = scratchDir('storage')
  const bare = inventory(pathsIn(dir), new FakeMemento())
  assert.equal(bare.some((i) => i.key === 'externalQuota'), false, 'a file we may not write was offered')

  const claude = path.join(dir, 'claude-usage.json')
  const codex = path.join(dir, 'codex-usage.json')
  fs.writeFileSync(claude, '{"schema_version":1}')
  const items = inventory(
    { ...pathsIn(dir), externalQuota: [claude, codex] },
    new FakeMemento(),
    { externalQuota: `${claude} · ${codex}` },
  )
  const item = items.find((i) => i.key === 'externalQuota')
  assert.ok(item, 'the shared cache is missing from the list')
  // One of the two exists: the item is present, and its size is the sum.
  assert.equal(item.present, true)
  assert.equal(item.bytes, 20)
  assert.ok(item.detail!.includes(codex), 'the picker line does not name both files')
  // It comes after the extension's own files and before the memento items.
  assert.deepEqual(
    items.map((i) => i.key),
    ['state', 'quota', 'history', 'mirror', 'externalQuota', 'consent', 'alerts', 'ui'],
  )
})

test('an empty or missing path list is not an item at all', () => {
  const dir = scratchDir('storage')
  const empty = inventory({ ...pathsIn(dir), externalQuota: [] }, new FakeMemento())
  assert.equal(empty.some((i) => i.key === 'externalQuota'), false)
  const blank = inventory({ ...pathsIn(dir), externalQuota: ['', '  '.trim()] }, new FakeMemento())
  assert.equal(blank.some((i) => i.key === 'externalQuota'), false)
})

test('deleting the shared cache removes both provider files and their temp siblings', async () => {
  const dir = scratchDir('storage')
  const claude = path.join(dir, 'claude-usage.json')
  const codex = path.join(dir, 'codex-usage.json')
  const temp = `${claude}.tmp`
  const neighbour = path.join(dir, 'someone-elses.json')
  for (const f of [claude, codex, temp, neighbour]) fs.writeFileSync(f, '{}')

  const paths = { ...pathsIn(dir), externalQuota: [claude, codex] }
  const result = await deleteItems(['externalQuota'], paths, new FakeMemento())

  assert.deepEqual(result, { deleted: ['externalQuota'], failed: [] })
  assert.equal(fs.existsSync(claude), false)
  assert.equal(fs.existsSync(codex), false)
  assert.equal(fs.existsSync(temp), false)
  assert.equal(fs.existsSync(neighbour), true, 'an unrelated file in the same directory was deleted')
})

test('storedFiles lists both cache files where storedFile can only name one', () => {
  const dir = scratchDir('storage')
  const paths = { ...pathsIn(dir), externalQuota: ['/a/claude.json', '/a/codex.json'] }
  assert.deepEqual(storedFiles('externalQuota', paths), ['/a/claude.json', '/a/codex.json'])
  assert.equal(storedFile('externalQuota', paths), null)
  assert.deepEqual(storedFiles('state', paths), [paths.state])
  assert.equal(storedFiles('consent', paths), null)
  assert.equal(storedFiles('externalQuota', pathsIn(dir)), null)
})

test('the two extra warnings say what deleting cannot undo', () => {
  assert.match(DELETE_WARNING_EXTERNAL, /outside the extension storage/)
  assert.match(DELETE_WARNING_EXTERNAL, /other tools/)
  assert.match(BRIDGE_BLOCKS_DELETE, /Disconnect Claude Status Line/)
  assert.match(BRIDGE_BLOCKS_DELETE, /settings\.json/)
})
