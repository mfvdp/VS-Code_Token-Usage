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
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import {
  ConsentUi, DEFAULT_QUOTA_CACHE_FILES, disclosure, NetworkConsent, WriteConsent,
  writeConsentDisclosure,
} from '../src/consent'
import type { MessageKind, MessageOpts } from '../src/hostUi'
import { setBundle, setLocale } from '../src/i18n'
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
    // 1.13 P5 (pinned and changed: the dialog goes through the door's showMessage — src/hostUi.ts — with its kind).
    showMessage(
      kind: MessageKind,
      message: string,
      options: MessageOpts,
      ...items: string[]
    ): Promise<string | undefined> {
      assert.equal(kind, 'info')
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

test('the status line disclosure says what the narrowed mirror keeps and where the script\'s copy lives (1.8 P11)', () => {
  const text = writeConsentDisclosure('statusLine', {
    settingsFile: '/tmp/token-pace-test/.claude/settings.json',
    mirrorFile: '/tmp/token-pace-test/storage/statusline-mirror.json',
    scriptFile: '/tmp/token-pace-test/storage/statusline-bridge.js',
  })
  const flat = text.replace(/\s+/g, ' ')
  // §7a Q11: the script keeps only the fields Token Pace reads — never "mirrors that JSON" any more.
  for (const claim of ['the script keeps of it only the fields Token Pace reads', 'the prompt cache and the session\'s id',
    'The session\'s name, its working directory, its transcript\'s path and the rest of the JSON never reach the file.',
    'Those fields are stored at /tmp/token-pace-test/storage/statusline-mirror.json.',
    // §7a Q16: the command runs the copy in the extension's storage, which an uninstall deletes.
    'the "statusLine" entry is set to the script\'s copy at /tmp/token-pace-test/storage/statusline-bridge.js, in the extension\'s storage.',
    'deletes the script\'s copy with the extension\'s storage', 'so disconnect first if you plan to remove Token Pace.']) {
    assert.ok(flat.includes(claim), `the dialog does not say: ${claim}`)
  }
  for (const stale of ['mirrors that JSON', 'The mirrored JSON', 'set to the script.']) assert.equal(flat.includes(stale), false, stale)
  // Without the paths it names the storage's own place, never an extension folder.
  const bare = writeConsentDisclosure('statusLine')
  assert.ok(bare.includes('<globalStorage>/statusline-bridge.js') && bare.includes('<globalStorage>/statusline-mirror.json'))
  assert.equal(/dist[\\/]statusline-bridge/.test(bare), false)
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
  assert.match(disclosure(30), /https:\/\/api\.anthropic\.com\/api\/oauth\/usage(?![\w./-])/)
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

test('the Codex paragraph follows the app-server mode — persistent says it keeps running, oneShot keeps the 1.x words; in German too (1.12 A5, A6 test 10)', async () => {
  const persistent = '\u2022 Codex \u2014 the local "codex app-server" is started, kept running while this window fetches, and\n'
    + '  asked for its rate limits. No traffic of ours leaves the machine for this.'
  const oneShot = '\u2022 Codex \u2014 the local "codex app-server" is started and asked for its rate limits. No traffic\n'
    + '  of ours leaves the machine for this.'
  assert.ok(disclosure(30, 'persistent').includes(persistent))
  assert.equal(disclosure(30, 'persistent').includes(oneShot), false)
  assert.ok(disclosure(30, 'oneShot').includes(oneShot))
  assert.equal(disclosure(30, 'oneShot').includes(persistent), false)
  // The default is the setting's default.
  assert.equal(disclosure(30), disclosure(30, 'persistent'))
  // The dialog reads the configured mode when it is shown.
  let mode: 'oneShot' | 'persistent' = 'oneShot'
  const consent = new NetworkConsent(new FakeMemento(), () => {}, { intervalMinutes: () => 30, appServerMode: () => mode })
  assert.ok(consent.disclosure().includes(oneShot))
  mode = 'persistent'
  assert.ok(consent.disclosure().includes(persistent))
  const host = ui([undefined])
  await new NetworkConsent(new FakeMemento(), () => {}, { ui: host, intervalMinutes: () => 30, appServerMode: () => mode }).request()
  assert.ok(host.shown[0].detail.includes(persistent))

  const de = JSON.parse(readFileSync(join(__dirname, '..', 'l10n', 'bundle.l10n.de.json'), 'utf8')) as Record<string, string>
  try {
    setBundle(de)
    setLocale('de')
    assert.ok(disclosure(30, 'persistent').includes('\u2022 Codex \u2014 der lokale \u201ecodex app-server\u201c wird gestartet, l\u00e4uft weiter, solange dieses Fenster abruft,\n'
      + '  und wird nach seinen Rate-Limits gefragt. Daf\u00fcr verl\u00e4sst kein Datenverkehr von uns den Rechner.'))
    assert.ok(disclosure(30, 'oneShot').includes('\u2022 Codex \u2014 der lokale \u201ecodex app-server\u201c wird gestartet und nach seinen Rate-Limits gefragt.\n'))
  } finally {
    setBundle(undefined)
    setLocale(undefined)
  }
})

// ---------------------------------------------------------------------------
// 1.12 B3, B4: the Keychain in the consent (B8 tests 3 and 4)
// ---------------------------------------------------------------------------

// Review 2 F5 (pinned and changed): the macOS dialog itself says to choose "Always Allow" — the advice a reader who
// clicks Allow once would otherwise find only in troubleshooting.md (a slow read closes the gate, B2 rule 3).
const DARWIN_CLAUDE = '• Claude — GET https://api.anthropic.com/api/oauth/usage, using Claude Code\'s access token: from\n'
  + '  CLAUDE_CODE_OAUTH_TOKEN if it is set, else from the macOS Keychain item "Claude Code-credentials" (read with\n'
  + '  macOS\'s security tool, which may ask you once — choose "Always Allow"), else from\n'
  + '  ~/.claude/.credentials.json. The request identifies itself as the Claude Code client, because\n'
  + '  the endpoint rate-limits other callers into a permanent 429.'
const LINUX_CLAUDE = '• Claude — GET https://api.anthropic.com/api/oauth/usage, using Claude Code\'s access token: from\n'
  + '  CLAUDE_CODE_OAUTH_TOKEN if it is set, else from ~/.claude/.credentials.json, else from the\n'
  + '  Secret Service through secret-tool. The request identifies itself as the Claude Code client,\n'
  + '  because the endpoint rate-limits other callers into a permanent 429.'
const OTHER_CLAUDE = '• Claude — GET https://api.anthropic.com/api/oauth/usage, using Claude Code\'s access token: from\n'
  + '  CLAUDE_CODE_OAUTH_TOKEN if it is set, else from ~/.claude/.credentials.json. The request\n'
  + '  identifies itself as the Claude Code client, because the endpoint rate-limits other callers\n'
  + '  into a permanent 429.'

function withConfigDir<T>(value: string | undefined, fn: () => T): T {
  const before = process.env.CLAUDE_CONFIG_DIR
  try {
    if (value === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = value
    return fn()
  } finally {
    if (before === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = before
  }
}

test('the Claude paragraph names every source of the token on the platform: macOS the Keychain item before the file, Linux the Secret Service after it, elsewhere the variable and the file — with the item\'s suffix where CLAUDE_CONFIG_DIR is set, in English and German (1.12 B4, B8 test 4)', () => {
  withConfigDir(undefined, () => {
    const cases: Array<[NodeJS.Platform, boolean, string]> = [
      ['darwin', true, DARWIN_CLAUDE], ['linux', true, LINUX_CLAUDE], ['win32', true, OTHER_CLAUDE],
      ['darwin', false, OTHER_CLAUDE], ['linux', false, OTHER_CLAUDE], ['win32', false, OTHER_CLAUDE],
    ]
    for (const [platform, keychain, paragraph] of cases) {
      const text = disclosure(30, 'persistent', platform, keychain)
      assert.ok(text.includes(paragraph), `${platform}, keychain ${keychain}: ${text}`)
      // Exactly one Claude paragraph, and the 1.x words are gone.
      assert.equal(text.split('• Claude').length, 2)
      assert.equal(text.includes('using the accessToken from'), false)
    }
    // The Codex paragraph by mode stays beside it (A6 test 10).
    assert.ok(disclosure(30, 'oneShot', 'darwin', true).includes('is started and asked for its rate limits'))
  })
  withConfigDir('/home/synthetic/.claude-work', () => {
    const text = disclosure(30, 'persistent', 'darwin', true)
    assert.match(text, /the macOS Keychain item "Claude Code-credentials-[0-9a-f]{8}" \(read with/)
  })
  // The dialog reads the platform and the setting it is given, when it is shown.
  let keychain = true
  const consent = new NetworkConsent(new FakeMemento(), () => {}, { platform: 'darwin', keychain: () => keychain })
  withConfigDir(undefined, () => {
    assert.ok(consent.disclosure().includes(DARWIN_CLAUDE))
    keychain = false
    assert.ok(consent.disclosure().includes(OTHER_CLAUDE))
  })

  const de = JSON.parse(readFileSync(join(__dirname, '..', 'l10n', 'bundle.l10n.de.json'), 'utf8')) as Record<string, string>
  try {
    setBundle(de)
    setLocale('de')
    withConfigDir(undefined, () => {
      assert.ok(disclosure(30, 'persistent', 'darwin', true).includes('• Claude — GET https://api.anthropic.com/api/oauth/usage mit dem Zugriffstoken von Claude Code: aus\n'
        + '  CLAUDE_CODE_OAUTH_TOKEN, wenn gesetzt, sonst aus dem macOS-Schlüsselbundeintrag „Claude Code-credentials“ (gelesen mit\n'
        // Review 2 F5 (pinned and changed): „wählen Sie „Immer erlauben““, re-wrapped at 100.
        + '  dem security-Werkzeug von macOS, das Sie einmal fragen kann — wählen Sie „Immer erlauben“), sonst\n'
        + '  aus ~/.claude/.credentials.json. Die Anfrage weist sich als Claude-Code-Client aus, weil der\n'
        + '  Endpunkt andere Aufrufer dauerhaft mit 429 abweist.'))
      assert.ok(disclosure(30, 'persistent', 'linux', true).includes('sonst aus dem\n  Secret Service über secret-tool. Die Anfrage weist sich als Claude-Code-Client aus, weil der\n'))
      assert.ok(disclosure(30, 'persistent', 'win32', true).includes('aus\n  CLAUDE_CODE_OAUTH_TOKEN, wenn gesetzt, sonst aus ~/.claude/.credentials.json. Die Anfrage weist\n'))
      // 1.x's German second sentence, word for word, in each of the three.
      for (const platform of ['darwin', 'linux', 'win32'] as const) {
        const flat = disclosure(30, 'persistent', platform, true).replace(/\s+/g, ' ')
        assert.ok(flat.includes('Die Anfrage weist sich als Claude-Code-Client aus, weil der Endpunkt andere Aufrufer dauerhaft mit 429 abweist.'), platform)
      }
    })
  } finally {
    setBundle(undefined)
    setLocale(undefined)
  }
})

test('the network dialog\'s Allow on macOS with the Keychain setting on records the Keychain consent too — one question naming both; elsewhere, or with the setting off, only its own; Never records neither Keychain answer (1.12 B3 rule 1)', async () => {
  const cases: Array<[NodeJS.Platform, boolean, string | undefined]> = [
    ['darwin', true, 'granted'], ['darwin', false, undefined], ['linux', true, undefined], ['win32', true, undefined],
  ]
  for (const [platform, keychain, expected] of cases) {
    const memento = new FakeMemento()
    const host = ui(['Allow'])
    const consent = new NetworkConsent(memento, () => {}, { ui: host, platform, keychain: () => keychain })
    assert.equal(await consent.request(), true)
    assert.equal(memento.store.get('networkConsent'), 'granted')
    assert.equal(memento.store.get('networkConsentKeychain'), expected, `${platform}, keychain ${keychain}`)
    assert.equal(host.shown[0].detail.includes('macOS Keychain item'), expected === 'granted')
  }
  const memento = new FakeMemento()
  await new NetworkConsent(memento, () => {}, { ui: ui(['Never']), platform: 'darwin' }).request()
  assert.equal(memento.store.get('networkConsent'), 'denied')
  assert.equal(memento.store.has('networkConsentKeychain'), false)
})

test('the Keychain question: its title and detail name the item and macOS\'s own question; Allow records granted, Never denied, Escape nothing; Reset Network Access Decision clears it with the network\'s answer (1.12 B3 rules 2 and 4, B8 test 3)', async () => {
  const logs: string[] = []
  const memento = new FakeMemento()
  memento.store.set('networkConsent', 'granted')
  const host = ui([undefined, 'Allow'])
  const consent = new NetworkConsent(memento, (m) => logs.push(m), { ui: host, platform: 'darwin' })
  assert.equal(consent.keychainState(), 'unasked')
  // Escape: not now — nothing recorded, asked again next time.
  assert.equal(await withConfigDir(undefined, () => consent.requestKeychain()), false)
  assert.equal(consent.keychainState(), 'unasked')
  assert.equal(memento.store.has('networkConsentKeychain'), false)
  assert.equal(await withConfigDir(undefined, () => consent.requestKeychain()), true)
  assert.equal(consent.keychainState(), 'granted')
  // Granted: not asked again.
  assert.equal(await consent.requestKeychain(), true)
  assert.equal(host.shown.length, 2)
  assert.equal(host.shown[0].message, 'Also read Claude Code\'s access token from the macOS Keychain?')
  assert.deepEqual(host.shown[0].items, ['Allow', 'Never'])
  assert.equal(host.shown[0].detail, 'Claude Code keeps its access token in the Keychain item "Claude Code-credentials". Token Pace reads it with macOS\'s security tool only to send it to https://api.anthropic.com/api/oauth/usage — the fetch you allowed — and never writes, refreshes or logs it.\n\nmacOS may ask whether "security" may use that item. Choose "Always Allow"; with "Allow" only, Token Pace reads it only when you fetch by hand.')
  assert.ok(logs.includes('Keychain access allowed by the user.'))
  // Never: denied, kept.
  const other = new FakeMemento()
  const no = new NetworkConsent(other, () => {}, { ui: ui(['Never']), platform: 'darwin' })
  assert.equal(await no.requestKeychain(), false)
  assert.equal(no.keychainState(), 'denied')
  // Kept for good: asked again, the answer is the stored one, and no dialog is shown.
  const shownBefore = host.shown.length
  assert.equal(await new NetworkConsent(other, () => {}, { ui: host, platform: 'darwin' }).requestKeychain(), false)
  assert.equal(host.shown.length, shownBefore)
  // A value that is no answer reads as unasked.
  other.store.set('networkConsentKeychain', 'yes')
  assert.equal(no.keychainState(), 'unasked')
  // The reset clears both answers.
  await consent.reset()
  assert.equal(consent.state(), 'unasked')
  assert.equal(consent.keychainState(), 'unasked')
  assert.equal(memento.store.has('networkConsentKeychain'), false)

  // German: the title and the detail as §3 B6 has them.
  const de = JSON.parse(readFileSync(join(__dirname, '..', 'l10n', 'bundle.l10n.de.json'), 'utf8')) as Record<string, string>
  try {
    setBundle(de)
    setLocale('de')
    const shown = ui([undefined])
    await withConfigDir(undefined, () => new NetworkConsent(new FakeMemento(), () => {}, { ui: shown, platform: 'darwin' }).requestKeychain())
    assert.equal(shown.shown[0].message, 'Das Zugriffstoken von Claude Code auch aus dem macOS-Schlüsselbund lesen?')
    assert.equal(shown.shown[0].detail, 'Claude Code bewahrt sein Zugriffstoken im Schlüsselbundeintrag „Claude Code-credentials“ auf. Token Pace liest es mit dem security-Werkzeug von macOS nur, um es an https://api.anthropic.com/api/oauth/usage zu senden — den Abruf, den Sie erlaubt haben —, und schreibt, erneuert oder protokolliert es nie.\n\nmacOS fragt womöglich, ob „security“ diesen Eintrag verwenden darf. Wählen Sie „Immer erlauben“; mit „Erlauben“ allein liest Token Pace ihn nur, wenn Sie von Hand abrufen.')
    assert.deepEqual(shown.shown[0].items, ['Erlauben', 'Nie'])
  } finally {
    setBundle(undefined)
    setLocale(undefined)
  }
})
