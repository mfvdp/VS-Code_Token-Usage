// SPDX-FileCopyrightText: 2026 Frederik Marx
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * 1.9 §0a.2: the one file the language switch reads — Token Pace's own bundle, by a registry id.
 *
 * A fake file system records every path asked for, so the tests below can say exactly which file
 * a language reads, and that no value a settings file can hold makes it read anything outside the
 * l10n directory. The real file system is only touched in a temporary directory of the test's own
 * and, read-only, in the repository's `l10n/`.
 */

import { strict as assert } from 'node:assert'
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative, sep } from 'node:path'
import { test } from 'node:test'
import { languageSetting, sanitize } from '../src/config'
import { setBundle, t } from '../src/i18n'
import { availableLanguages, bundleFileName, readBundle } from '../src/languageLoad'
import { LANGUAGE_IDS, LanguageId, resolveLanguage } from '../src/languages'
import { ROOT } from './helpers/nls'

const DIR = join(tmpdir(), 'token-pace-l10n-fake')

/** A read that records the path and answers from a table; anything else is ENOENT. */
function fakeFs(files: Record<string, string> = {}): { read: (file: string) => string; paths: string[] } {
  const paths: string[] = []
  return {
    paths,
    read: (file: string): string => {
      paths.push(file)
      if (Object.prototype.hasOwnProperty.call(files, file)) return files[file]
      throw Object.assign(new Error(`ENOENT: no such file, open '${file}'`), { code: 'ENOENT' })
    },
  }
}

/** Inside `DIR`, and not by a detour: a path that normalises to the directory's own files. */
function inside(file: string): boolean {
  const rel = relative(DIR, file)
  return rel !== '' && !rel.startsWith('..') && !rel.includes(`..${sep}`) && !rel.includes(sep)
}

test('readBundle reads exactly <dir>/bundle.l10n.<id>.json for every registry id, and English reads nothing (1.9 §0a.2)', () => {
  for (const id of LANGUAGE_IDS) {
    const fs = fakeFs({ [join(DIR, `bundle.l10n.${id}.json`)]: '{"Refresh":"R"}' })
    const bundle = readBundle(DIR, id, fs.read)
    if (id === 'en') {
      assert.deepEqual(bundle, {})
      assert.deepEqual(fs.paths, [], 'English read a file')
      continue
    }
    assert.deepEqual(fs.paths, [join(DIR, `bundle.l10n.${id}.json`)], id)
    assert.deepEqual(bundle, { Refresh: 'R' }, id)
    assert.equal(bundleFileName(id), `bundle.l10n.${id}.json`)
  }
})

test('a setting that is no registry id is auto and reads no path outside the l10n directory — handed straight to readBundle, it reads none at all (1.9 §0a.2, §3 A1 rule 3)', () => {
  const hostile: unknown[] = ['../../etc/passwd', 'fr/../../x', 'FR', 'xx', '', 42]
  for (const raw of hostile) {
    // The way the host goes: the setting through sanitize, the result through resolveLanguage, the id to readBundle.
    const setting = sanitize({ 'tokenPace.language': raw }).language
    assert.equal(setting, 'auto', JSON.stringify(raw))
    assert.equal(languageSetting(raw), 'auto', JSON.stringify(raw))
    for (const vscode of ['en', 'de', 'fr', '../../x']) {
      const fs = fakeFs()
      const resolved = resolveLanguage(setting, vscode, LANGUAGE_IDS)
      readBundle(DIR, resolved.id, fs.read)
      assert.ok(fs.paths.every(inside), `${JSON.stringify(raw)} under ${vscode} read ${fs.paths.join(', ')}`)
    }
    // And the file name is built from a registry id only: the setting's own text, cast to an id
    // somewhere upstream, still opens nothing.
    const fs = fakeFs()
    const failures: string[] = []
    assert.equal(readBundle(DIR, raw as LanguageId, fs.read, (kind) => failures.push(kind)), null, JSON.stringify(raw))
    assert.deepEqual(fs.paths, [], `${JSON.stringify(raw)} reached a path: ${fs.paths.join(', ')}`)
    assert.deepEqual(failures, ['not a registry id'])
  }
})

test('readBundle: a file that is missing, not JSON or not an object is null and says why in a word; the entries setBundle cannot use are dropped there (1.9 A2 test 3)', () => {
  const file = join(DIR, 'bundle.l10n.fr.json')
  const cases: Array<[string | null, string]> = [
    [null, 'ENOENT'],
    ['{ not json', 'not JSON'],
    ['[1, 2]', 'not an object'],
    ['null', 'not an object'],
    ['"Actualiser"', 'not an object'],
  ]
  for (const [text, kind] of cases) {
    const fs = fakeFs(text === null ? {} : { [file]: text })
    const failures: string[] = []
    assert.equal(readBundle(DIR, 'fr', fs.read, (k) => failures.push(k)), null, String(text))
    assert.deepEqual(failures, [kind], String(text))
  }
  // An object passes as it is; the seam keeps its non-empty strings only.
  const fs = fakeFs({ [file]: JSON.stringify({ Refresh: 3, Range: 'Période', Models: '' }) })
  const bundle = readBundle(DIR, 'fr', fs.read)
  assert.deepEqual(bundle, { Refresh: 3, Range: 'Période', Models: '' })
  try {
    setBundle(bundle)
    assert.equal(t('Refresh'), 'Refresh')
    assert.equal(t('Range'), 'Période')
    assert.equal(t('Models'), 'Models')
  } finally {
    setBundle(undefined)
  }
})

test('availableLanguages: English always, then every id whose bundle file exists, in the registry\'s order', () => {
  const asked: string[] = []
  const on = new Set([join(DIR, 'bundle.l10n.zh-tw.json'), join(DIR, 'bundle.l10n.de.json'), join(DIR, 'bundle.l10n.en.json')])
  const got = availableLanguages(DIR, (f) => { asked.push(f); return on.has(f) })
  assert.deepEqual(got, ['en', 'de', 'zh-tw'])
  // English is never looked for (its text is the key), every other id by its own file name only.
  assert.deepEqual(asked, LANGUAGE_IDS.filter((id) => id !== 'en').map((id) => join(DIR, `bundle.l10n.${id}.json`)))
  assert.deepEqual(availableLanguages(DIR, () => false), ['en'])

  // The real file system: a regular file counts, a directory of that name does not.
  const dir = mkdtempSync(join(tmpdir(), 'token-pace-l10n-'))
  try {
    writeFileSync(join(dir, 'bundle.l10n.fr.json'), '{}')
    mkdirSync(join(dir, 'bundle.l10n.it.json'))
    writeFileSync(join(dir, 'bundle.l10n.xx.json'), '{}')
    assert.deepEqual(availableLanguages(dir), ['en', 'fr'])
    assert.deepEqual(availableLanguages(join(dir, 'nowhere')), ['en'])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the repository\'s l10n/ offers English and exactly the registry ids whose bundle it ships — German among them', () => {
  const dir = join(ROOT, 'l10n')
  const shipped = readdirSync(dir).map((f) => /^bundle\.l10n\.(.+)\.json$/.exec(f)?.[1]).filter((x): x is string => x !== undefined)
  const got = availableLanguages(dir)
  assert.deepEqual(got, LANGUAGE_IDS.filter((id) => id === 'en' || shipped.includes(id)))
  assert.ok(got.includes('de'), 'the German bundle is not offered')
  // Every shipped bundle names a registry id (the files a package adds are named after it).
  assert.deepEqual(shipped.filter((tag) => !(LANGUAGE_IDS as readonly string[]).includes(tag)), [])
  // And the German one reads as a table of strings.
  const de = readBundle(dir, 'de')
  assert.ok(de && Object.keys(de).length > 1000 && Object.values(de).every((v) => typeof v === 'string'))
})
