// SPDX-FileCopyrightText: 2026 Frederik Marx
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The localisation seam and its tooling.
 *
 * Three promises are checked here, none of which a build would catch:
 *  - `t()` behaves like `vscode.l10n.t` — the English message is the key, the bundle replaces
 *    it, `{n}` is filled from the arguments — and stays English without a bundle, which is
 *    what lets every other test keep asserting English words;
 *  - the committed German bundle is exactly what the parts give, covers every `t('…')` call
 *    in src/, and carries nothing that no call uses any more;
 *  - the `Intl` formatters follow `setLocale`, and only the *display* ones — the day
 *    arithmetic keeps reading en-US digits whatever the language.
 * The two scripts are run as the command lines they are: a wrong exit code is a broken gate.
 * Nothing outside the repository and the test's own temporary directories is touched.
 */

import { strict as assert } from 'node:assert'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { DEFAULT_LOCALE, locale, setBundle, setLocale, t } from '../src/i18n'
import { dayOf, formatDay, formatTime, rangeFor, TimeConfig } from '../src/time'
import { readJson, ROOT } from './helpers/nls'

const EXTRACT = join(ROOT, 'scripts', 'l10n-extract.mjs')
const MERGE = join(ROOT, 'scripts', 'merge-l10n.mjs')
const BUNDLE = 'l10n/bundle.l10n.de.json'

const utc: TimeConfig = { zone: 'utc', dayBoundaryHour: 0, startOfWeek: 'monday', hourCycle: 'h23' }
/** 2026-09-05, a Saturday, 14:20 UTC. */
const NOW = Date.UTC(2026, 8, 5, 14, 20)

function run(script: string, args: string[], cwd: string): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync(process.execPath, [script, ...args], { cwd, encoding: 'utf8' })
  return { status: r.status, stdout: r.stdout, stderr: r.stderr }
}

/** The seam is module state; every test that changes it puts it back. */
function pristine(): void {
  setBundle(undefined)
  setLocale(undefined)
}

// ---------------------------------------------------------------------------
// t()
// ---------------------------------------------------------------------------

test('t() without a bundle returns the message and fills the placeholders', () => {
  pristine()
  assert.equal(t('Fetch failed'), 'Fetch failed')
  assert.equal(t('{0} of {1} files', 3, 12), '3 of 12 files')
  assert.equal(t('{1} before {0}', 'a', 'b'), 'b before a')
  // Twice the same index is twice the same argument.
  assert.equal(t('{0} and {0}', 'x'), 'x and x')
  // A placeholder nobody filled stays visible: a gap is a bug that can be reported.
  assert.equal(t('{0} of {1}', 1), '1 of {1}')
  // Braces that are not an index are text.
  assert.equal(t('{ modal: true }'), '{ modal: true }')
})

test('t() takes the bundle entry, keeps its placeholder order, and ignores what it cannot use', () => {
  try {
    setBundle({
      'Fetch failed': 'Abruf fehlgeschlagen',
      '{0} of {1} files': '{0} von {1} Dateien',
      '{0} — {1} ({2} used)': '{2} verbraucht: {1} ({0})',
      'empty': '',
      'wrong type': 42 as unknown as string,
    })
    assert.equal(t('Fetch failed'), 'Abruf fehlgeschlagen')
    assert.equal(t('{0} of {1} files', 3, 12), '3 von 12 Dateien')
    assert.equal(t('{0} — {1} ({2} used)', '5 h', 'ahead', '37 %'), '37 % verbraucht: ahead (5 h)')
    assert.equal(t('empty'), 'empty')
    assert.equal(t('wrong type'), 'wrong type')
    assert.equal(t('not in the bundle'), 'not in the bundle')
    // A key that is also an Object.prototype member must not resolve to the prototype.
    assert.equal(t('constructor'), 'constructor')
    setBundle(undefined)
    assert.equal(t('Fetch failed'), 'Fetch failed')
  } finally {
    pristine()
  }
})

// ---------------------------------------------------------------------------
// setLocale and the formatters
// ---------------------------------------------------------------------------

test('setLocale canonicalises a tag and falls back to en-US for anything ICU cannot use', () => {
  try {
    assert.equal(locale(), DEFAULT_LOCALE)
    assert.equal(DEFAULT_LOCALE, 'en-US')
    setLocale('de')
    assert.equal(locale(), 'de')
    setLocale('DE-de')
    assert.equal(locale(), 'de-DE')
    setLocale('en')
    assert.equal(locale(), 'en')
    for (const bad of ['', '   ', 'not a tag', 'x', 'qps-ploc', undefined, null]) {
      setLocale('de')
      setLocale(bad)
      assert.equal(locale(), 'en-US', `setLocale(${JSON.stringify(bad)}) did not fall back`)
    }
  } finally {
    pristine()
  }
})

test('formatTime, formatDay and the range labels follow the locale; the day arithmetic does not', () => {
  try {
    pristine()
    assert.equal(formatDay(NOW, utc), 'Sat 5 Sep')
    assert.equal(formatTime(NOW, utc), '14:20')
    assert.equal(formatTime(NOW, utc, true), 'Sa 14:20')
    assert.equal(formatTime(NOW, { ...utc, hourCycle: 'h12' }), '02:20 PM')
    assert.equal(rangeFor('7d', NOW, utc).label, 'Last 7 days')
    assert.equal(dayOf(NOW, utc), '2026-09-05')

    setLocale('de')
    setBundle({ 'Last {0} days': 'Letzte {0} Tage' })
    const day = formatDay(NOW, utc)
    // "Sa. 5 Sept." — the month abbreviation is ICU's business, the order and the weekday are ours.
    assert.ok(day.startsWith('Sa. 5 '), day)
    assert.notEqual(day, 'Sat 5 Sep')
    assert.equal(formatTime(NOW, utc), '14:20')
    assert.equal(formatTime(NOW, utc, true), 'Sa 14:20')
    assert.equal(rangeFor('7d', NOW, utc).label, 'Letzte 7 Tage')
    // The calendar is computed from en-US digits whatever the language: same day, same key.
    assert.equal(dayOf(NOW, utc), '2026-09-05')
    assert.equal(dayOf(NOW, { ...utc, zone: 'Europe/Berlin' }), '2026-09-05')

    // 'en' is what VS Code reports for the default language; it must print like 'en-US'.
    setBundle(undefined)
    setLocale('en')
    assert.equal(formatDay(NOW, utc), 'Sat 5 Sep')
    assert.equal(formatTime(NOW, utc, true), 'Sa 14:20')
    assert.equal(formatTime(NOW, { ...utc, hourCycle: 'h12' }), '02:20 PM')
  } finally {
    pristine()
  }
})

// ---------------------------------------------------------------------------
// The extract script
// ---------------------------------------------------------------------------

test('l10n-extract lists every t() literal, ignores comments, strings and foreign t, and rejects a non-literal', () => {
  const dir = mkdtempSync(join(tmpdir(), 'token-pace-l10n-'))
  try {
    mkdirSync(join(dir, 'src', 'deep'), { recursive: true })
    writeFileSync(join(dir, 'src', 'a.ts'), [
      "import { t } from './i18n'",
      "// t('In a comment')",
      "const s = \"t('in a string')\"",
      "export const one = t('Plain')",
      'export const two = t("Double {0}", 1)',
      'export const three = t(`Template`)',
      "export const again = t('Plain')",
      '',
    ].join('\n'))
    writeFileSync(join(dir, 'src', 'deep', 'b.ts'), [
      "import { t as translate } from '../i18n'",
      'const t = (x: string): string => x',
      'export const local = t(process.argv[0])',
      "export const named = translate('Not seen: t is not the binding name')",
      '',
    ].join('\n'))
    writeFileSync(join(dir, 'src', 'i18n.ts'), 'export function t(m: string): string { return m }\n')

    const ok = run(EXTRACT, ['--json'], dir)
    assert.equal(ok.status, 0, ok.stderr)
    const { keys } = JSON.parse(ok.stdout) as { keys: Record<string, string[]> }
    assert.deepEqual(keys, {
      'Double {0}': ['src/a.ts:5'],
      'Plain': ['src/a.ts:4', 'src/a.ts:7'],
      'Template': ['src/a.ts:6'],
    })
    // Plain output names the same keys and ends with the count.
    const plain = run(EXTRACT, [], dir)
    assert.equal(plain.status, 0, plain.stderr)
    assert.match(plain.stdout, /"Plain"\s+src\/a\.ts:4 src\/a\.ts:7/)
    assert.match(plain.stdout, /l10n-extract: 3 key\(s\)/)

    writeFileSync(join(dir, 'src', 'c.ts'), [
      "import { t } from './i18n'",
      "const name = 'x'",
      'export const bad = t(name)',
      "export const worse = t('a' + 'b')",
      '',
    ].join('\n'))
    const bad = run(EXTRACT, ['--json'], dir)
    assert.equal(bad.status, 1, 'a non-literal first argument must fail the extract')
    assert.match(bad.stderr, /src\/c\.ts:3: the first argument of t\(\) must be a string literal/)
    assert.match(bad.stderr, /src\/c\.ts:4: the first argument of t\(\) must be a string literal/)
    assert.equal(bad.stdout, '')

    const missing = run(EXTRACT, ['--dir', join(dir, 'nowhere')], dir)
    assert.equal(missing.status, 1)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// The merge script
// ---------------------------------------------------------------------------

test('merge-l10n writes a sorted bundle per language, accepts an agreeing duplicate and refuses a conflict', () => {
  const dir = mkdtempSync(join(tmpdir(), 'token-pace-l10n-'))
  try {
    const parts = join(dir, 'l10n', 'parts')
    mkdirSync(parts, { recursive: true })
    writeFileSync(join(parts, 'host.de.json'), JSON.stringify({ 'b key': 'B', 'shared': 'gleich', 'a key': 'A' }))
    writeFileSync(join(parts, 'text.de.json'), JSON.stringify({ 'shared': 'gleich', 'c key': 'C' }))
    writeFileSync(join(parts, 'host.fr.json'), JSON.stringify({ 'a key': 'A (fr)' }))
    writeFileSync(join(parts, 'README.txt'), 'not a part')

    const check = run(MERGE, ['--check'], dir)
    assert.equal(check.status, 1, 'a missing bundle must fail --check')
    assert.match(check.stderr, /bundle\.l10n\.de\.json is missing/)

    const write = run(MERGE, [], dir)
    assert.equal(write.status, 0, write.stderr)
    const de = readFileSync(join(dir, 'l10n', 'bundle.l10n.de.json'), 'utf8')
    assert.equal(de, `${JSON.stringify({ 'a key': 'A', 'b key': 'B', 'c key': 'C', 'shared': 'gleich' }, null, 2)}\n`)
    const fr = readFileSync(join(dir, 'l10n', 'bundle.l10n.fr.json'), 'utf8')
    assert.equal(fr, `${JSON.stringify({ 'a key': 'A (fr)' }, null, 2)}\n`)
    assert.equal(run(MERGE, ['--check'], dir).status, 0)

    // A part edited after the merge: --check names the key and fails, --print stays silent about files.
    writeFileSync(join(parts, 'text.de.json'), JSON.stringify({ 'shared': 'gleich', 'c key': 'C2', 'd key': 'D' }))
    const stale = run(MERGE, ['--check'], dir)
    assert.equal(stale.status, 1)
    assert.match(stale.stderr, /differs from the parts/)
    assert.match(stale.stderr, /~ "c key"/)
    assert.match(stale.stderr, /\+ "d key"/)
    const print = run(MERGE, ['--print'], dir)
    assert.equal(print.status, 0, print.stderr)
    assert.equal((JSON.parse(print.stdout) as Record<string, Record<string, string>>).de['c key'], 'C2')
    assert.equal(readFileSync(join(dir, 'l10n', 'bundle.l10n.de.json'), 'utf8'), de, '--print wrote a file')

    writeFileSync(join(parts, 'text.de.json'), JSON.stringify({ 'shared': 'anders' }))
    const conflict = run(MERGE, [], dir)
    assert.equal(conflict.status, 1, 'two translations of one key must fail the merge')
    assert.match(conflict.stderr, /text\.de\.json: "shared" is already translated differently in host\.de\.json/)

    writeFileSync(join(parts, 'text.de.json'), JSON.stringify({ 'empty': '' }))
    assert.match(run(MERGE, [], dir).stderr, /"empty" is not a non-empty string/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// The committed bundle
// ---------------------------------------------------------------------------

/** Every `t('…')` key in src/, as the script reports it. */
function extractedKeys(): Record<string, string[]> {
  const r = run(EXTRACT, ['--json'], ROOT)
  assert.equal(r.status, 0, `l10n-extract failed:\n${r.stderr}`)
  return (JSON.parse(r.stdout) as { keys: Record<string, string[]> }).keys
}

test('package.json points VS Code at the l10n directory, and the German bundle is what the parts give', () => {
  const manifest = readJson('package.json') as Record<string, unknown>
  assert.equal(manifest.l10n, './l10n')
  const check = run(MERGE, ['--check'], ROOT)
  assert.equal(check.status, 0, `the committed bundle is stale — run \`node scripts/merge-l10n.mjs\`:\n${check.stderr}`)
})

test('every t() key in src/ has a German entry, and no entry is left without a call site', () => {
  const keys = extractedKeys()
  const bundle = readJson(BUNDLE) as Record<string, string>
  assert.ok(Object.keys(keys).length >= 80, `only ${Object.keys(keys).length} keys extracted from src/`)

  const untranslated = Object.keys(keys).filter((k) => typeof bundle[k] !== 'string' || bundle[k].length === 0)
  assert.deepEqual(untranslated, [], `no German for:\n${untranslated.map((k) => `  ${JSON.stringify(k)}  ${keys[k].join(' ')}`).join('\n')}`)

  const orphans = Object.keys(bundle).filter((k) => !(k in keys))
  assert.deepEqual(orphans, [], `in the bundle but no longer in src/: ${orphans.map((k) => JSON.stringify(k)).join(', ')}`)
})

function placeholders(s: string): string[] {
  return [...s.matchAll(/\{(\d+)\}/g)].map((m) => m[1]).sort()
}

test('every German entry keeps the placeholders of its key, is German, and ends without an exclamation mark', () => {
  const bundle = readJson(BUNDLE) as Record<string, string>
  for (const [key, value] of Object.entries(bundle)) {
    assert.deepEqual(placeholders(value), placeholders(key), `placeholders differ for ${JSON.stringify(key)}`)
    assert.equal(value.includes('!'), false, `exclamation mark in ${JSON.stringify(value)}`)
    // Short labels legitimately match ("Token Pace: {0}", "in {0}"); a sentence never does.
    if (key.split(/\s+/).length >= 6) assert.notEqual(value, key, `still English: ${JSON.stringify(key)}`)
    // The formal register: no informal address anywhere in the bundle.
    assert.doesNotMatch(value, /\b(du|dich|dir|dein|deine|deinen|deinem|deiner)\b/i, `informal address in ${JSON.stringify(value)}`)
  }
})
