// SPDX-FileCopyrightText: 2026 Frederik Marx
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The consent dialogs — the only place where the extension asks for anything.
 *
 * The rule under test is not "a dialog appears" but "the dialog is true": it has
 * to name every file the opt-in writes, and it has to name the files as they are
 * configured *now*. A disclosure whose paths were frozen at activation would
 * describe a write that no longer happens to that file.
 */

import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import {
  ConsentUi, DEFAULT_QUOTA_CACHE_FILES, disclosure, NetworkConsent, WriteConsent,
  writeConsentDisclosure,
} from '../src/consent'
import { MementoLike } from '../src/storage'

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

interface Shown {
  message: string
  detail: string
  items: string[]
}

function ui(answers: Array<string | undefined>): ConsentUi & { shown: Shown[] } {
  const shown: Shown[] = []
  return {
    shown,
    showInformationMessage(
      message: string,
      options: { modal: boolean; detail?: string },
      ...items: string[]
    ): PromiseLike<string | undefined> {
      shown.push({ message, detail: options.detail ?? '', items })
      return Promise.resolve(answers.shift())
    },
  }
}

const CLAUDE_FILE = '/tmp/token-pace-test/claude-usage.json'
const CODEX_FILE = '/tmp/token-pace-test/codex-usage.json'

test('the quota cache disclosure names every file it would write', () => {
  const text = writeConsentDisclosure('writeQuotaCache', { quotaCacheFiles: [CLAUDE_FILE, CODEX_FILE] })
  assert.ok(text.includes(CLAUDE_FILE), 'the Claude cache file is not named')
  assert.ok(text.includes(CODEX_FILE), 'the Codex cache file is not named')
  assert.ok(text.includes('tokenPace.writeQuotaCache'), 'the way back out is not named')
  assert.ok(text.includes('never contain your access token'))
})

test('with no paths supplied the disclosure names the files the writer defaults to', () => {
  const text = writeConsentDisclosure('writeQuotaCache')
  // Not a placeholder: the fallback has to name the paths quota.ts actually uses,
  // or the dialog asks permission for a file the extension never touches.
  for (const file of DEFAULT_QUOTA_CACHE_FILES) assert.ok(text.includes(file), `${file} is not named`)
  assert.equal(text.includes('undefined'), false)
})

test('the status line disclosure names the settings file, the backup and the mirror', () => {
  const text = writeConsentDisclosure('statusLine', {
    settingsFile: '/tmp/token-pace-test/.claude/settings.json',
    mirrorFile: '/tmp/token-pace-test/storage/statusline-mirror.json',
  })
  assert.ok(text.includes('/tmp/token-pace-test/.claude/settings.json'))
  assert.ok(text.includes('/tmp/token-pace-test/storage/statusline-mirror.json'))
  assert.match(text, /token-pace-backup-<timestamp>/)
})

test('the paths are read when the dialog is shown, not when the object is built', async () => {
  const memento = new FakeMemento()
  let files = [CLAUDE_FILE, CODEX_FILE]
  const host = ui(['Allow'])
  const consent = new WriteConsent(memento, 'writeQuotaCache', () => {}, {
    ui: host,
    paths: () => ({ quotaCacheFiles: files }),
  })

  // The setting moves after construction — exactly what `tokenPace.claudeQuotaFile` does.
  files = ['/tmp/token-pace-test/moved-claude.json', '/tmp/token-pace-test/moved-codex.json']
  assert.equal(await consent.request(), true)

  assert.equal(host.shown.length, 1)
  assert.ok(host.shown[0].detail.includes('/tmp/token-pace-test/moved-claude.json'))
  assert.ok(host.shown[0].detail.includes('/tmp/token-pace-test/moved-codex.json'))
  assert.equal(host.shown[0].detail.includes(CLAUDE_FILE), false, 'the stale path was still named')
  assert.deepEqual(host.shown[0].items, ['Allow', 'Never'])
  assert.equal(memento.store.get('writeConsent.writeQuotaCache'), 'granted')
})

test('a path source that throws does not swallow the dialog', async () => {
  const host = ui(['Never'])
  const consent = new WriteConsent(new FakeMemento(), 'writeQuotaCache', () => {}, {
    ui: host,
    paths: () => { throw new Error('settings unreadable') },
  })
  assert.equal(await consent.request(), false)
  assert.equal(host.shown.length, 1)
  for (const file of DEFAULT_QUOTA_CACHE_FILES) assert.ok(host.shown[0].detail.includes(file))
})

test('cancel stays askable, "Never" is recorded, and a grant is not asked again', async () => {
  const memento = new FakeMemento()
  const host = ui([undefined, 'Allow'])
  const consent = new WriteConsent(memento, 'writeQuotaCache', () => {}, { ui: host, paths: {} })

  assert.equal(await consent.request(), false)
  assert.equal(memento.store.has('writeConsent.writeQuotaCache'), false, 'a cancel was recorded as an answer')

  assert.equal(await consent.request(), true)
  assert.equal(await consent.request(), true)
  assert.equal(host.shown.length, 2, 'a granted consent asked again')

  await consent.reset()
  assert.equal(consent.state(), 'unasked')
})

test('the network disclosure states the interval the user actually configured', () => {
  assert.match(disclosure(45), /every 45 minutes/)
  assert.match(disclosure(60), /every 1 hour/)
  assert.match(disclosure(120), /every 2 hours/)
  // A nonsensical value falls back to the manifest default rather than printing it.
  assert.match(disclosure(0), /every 30 minutes/)
  assert.ok(disclosure(30).includes('https://api.anthropic.com/api/oauth/usage'))
})

test('the network consent remembers exactly one answer per machine', async () => {
  const memento = new FakeMemento()
  const host = ui(['Never'])
  const consent = new NetworkConsent(memento, () => {}, { ui: host, intervalMinutes: () => 30 })

  assert.equal(consent.state(), 'unasked')
  assert.equal(await consent.request(), false)
  assert.equal(consent.state(), 'denied')
  assert.equal(consent.offered(), false)
  await consent.markOffered()
  assert.equal(consent.offered(), true)
  await consent.reset()
  assert.equal(consent.state(), 'unasked')
  assert.equal(consent.offered(), false)
})
