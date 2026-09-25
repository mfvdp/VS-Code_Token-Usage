// SPDX-FileCopyrightText: 2026 Frederik Marx
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * 1.9 A1/A2: the registry of shipped languages and the rules that pick the language whose words are
 * shown (`autoLanguage`, `resolveLanguage`).
 *
 * The registry is what every file name of a language is built from, what the setting's enum lists and
 * what the picker offers, so its shape is checked clause by clause — the canonical-locale clause with
 * this machine's `Intl`, at test time, never with a literal. Nothing is read from disk here but the
 * manifest.
 */

import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { FLAG_SVG } from '../src/flags'
import { setBundle } from '../src/i18n'
import {
  autoLanguage, isLanguageId, LANGUAGE_IDS, LANGUAGES, LanguageId, languageEntry, languageName, LanguageSetting,
  resolveLanguage, ResolvedLanguage, vscodeLanguageTag,
} from '../src/languages'
import { readJson } from './helpers/nls'

/** The lead's list (collect "Vorschlag Sprachliste", tier 1), in the picker's order. */
const LEADS_LIST: Array<[string, string, string, string]> = [
  ['en', 'en', 'English', 'us'],
  ['de', 'de', 'Deutsch', 'de'],
  ['fr', 'fr', 'Français', 'fr'],
  ['es', 'es', 'Español', 'es'],
  ['pt-br', 'pt-BR', 'Português (Brasil)', 'br'],
  ['it', 'it', 'Italiano', 'it'],
  ['ja', 'ja', '日本語', 'jp'],
  ['ko', 'ko', '한국어', 'kr'],
  ['zh-cn', 'zh-CN', '简体中文', 'cn'],
  ['zh-tw', 'zh-TW', '繁體中文', 'tw'],
  ['ru', 'ru', 'Русский', 'ru'],
  ['tr', 'tr', 'Türkçe', 'tr'],
  ['pl', 'pl', 'Polski', 'pl'],
  ['cs', 'cs', 'Čeština', 'cz'],
]

test('the registry: fourteen languages in the lead\'s order, ids unique and lower-case, canonical locales ICU knows, a native name and a drawn flag each, no direction (1.9 A1 rule 1)', () => {
  assert.equal(LANGUAGES.length, 14)
  assert.deepEqual(LANGUAGES.map((e) => [e.id, e.locale, e.native, e.flag]), LEADS_LIST)
  assert.equal(new Set(LANGUAGES.map((e) => e.id)).size, 14, 'an id stands twice')
  assert.equal(new Set(LANGUAGES.map((e) => e.flag)).size, 14, 'two languages share a flag')
  for (const e of LANGUAGES) {
    assert.equal(e.id, e.id.toLowerCase(), `${e.id} is not lower-case — VS Code lower-cases a display language`)
    assert.match(e.id, /^[a-z]{2}(?:-[a-z]{2})?$/, e.id)
    // The canonical tag is ICU's own spelling of the id, and ICU must know it.
    assert.equal(e.locale, Intl.getCanonicalLocales(e.id)[0], `${e.id}: ${e.locale} is not the canonical tag`)
    assert.deepEqual(Intl.DateTimeFormat.supportedLocalesOf([e.locale]), [e.locale], `${e.locale} is unknown to this ICU`)
    assert.ok(e.native.trim().length > 0 && e.native === e.native.trim(), `${e.id} has no native name`)
    assert.ok(Object.prototype.hasOwnProperty.call(FLAG_SVG, e.flag), `${e.id}: no drawing for the flag ${e.flag}`)
    // No direction field, nor any other: every language of 1.9 is written left to right (§0b.11).
    assert.deepEqual(Object.keys(e).sort(), ['flag', 'id', 'locale', 'native'], `${e.id} carries another field`)
  }
  // Frozen: no package can push a language into it at run time.
  assert.ok(Object.isFrozen(LANGUAGES) && LANGUAGES.every((e) => Object.isFrozen(e)))
  assert.deepEqual(LANGUAGE_IDS, LANGUAGES.map((e) => e.id))
  assert.equal(languageEntry('pt-br').locale, 'pt-BR')
})

test('the manifest\'s enum is auto and the registry\'s ids, in the registry\'s order (1.9 A1 rule 2)', () => {
  const manifest = readJson('package.json') as {
    contributes: { configuration: Array<{ properties: Record<string, { enum?: string[] }> }> }
  }
  const property = manifest.contributes.configuration.flatMap((c) => Object.entries(c.properties))
    .find(([key]) => key === 'tokenPace.language')?.[1]
  assert.ok(property, 'package.json contributes no tokenPace.language')
  assert.deepEqual(property.enum, ['auto', ...LANGUAGE_IDS])
})

test('isLanguageId: an exact registry id — never another case, a path, an empty string or a number', () => {
  for (const id of LANGUAGE_IDS) assert.equal(isLanguageId(id), true, id)
  for (const bad of ['auto', 'FR', 'Pt-BR', 'pt_BR', 'pt', 'zh', '../x', 'fr/../../x', '', ' fr', 42, null, undefined, {}]) {
    assert.equal(isLanguageId(bad), false, JSON.stringify(bad))
  }
})

test('languageName: each language\'s name in the reader\'s language, one t() literal per id', () => {
  const english: Record<LanguageId, string> = {
    en: 'English', de: 'German', fr: 'French', es: 'Spanish', 'pt-br': 'Portuguese (Brazil)', it: 'Italian',
    ja: 'Japanese', ko: 'Korean', 'zh-cn': 'Chinese (Simplified)', 'zh-tw': 'Chinese (Traditional)', ru: 'Russian',
    tr: 'Turkish', pl: 'Polish', cs: 'Czech',
  }
  for (const id of LANGUAGE_IDS) assert.equal(languageName(id), english[id], id)
  // Through the seam: the German bundle's names (§6), and German's own name is its native one.
  const de = readJson('l10n/bundle.l10n.de.json') as Record<string, string>
  try {
    setBundle(de)
    assert.equal(languageName('de'), 'Deutsch')
    assert.equal(languageName('en'), 'Englisch')
    assert.equal(languageName('zh-tw'), 'Chinesisch (traditionell)')
    assert.equal(languageName('pt-br'), 'Portugiesisch (Brasilien)')
    // Every name has its German word — none of the fourteen is the English one.
    for (const id of LANGUAGE_IDS) assert.notEqual(languageName(id), english[id], `${id} has no German name`)
  } finally {
    setBundle(undefined)
  }
})

test('vscodeLanguageTag: VS Code\'s tag lower-cased, and only as [a-z0-9-]{1,20}', () => {
  assert.equal(vscodeLanguageTag('de'), 'de')
  assert.equal(vscodeLanguageTag('DE-CH'), 'de-ch')
  assert.equal(vscodeLanguageTag(' zh-tw '), 'zh-tw')
  assert.equal(vscodeLanguageTag('qps-ploc'), 'qps-ploc')
  for (const bad of ['', 'x y', 'de_CH', '<b>', 'a'.repeat(21), '``` ', 42, undefined, null]) {
    assert.equal(vscodeLanguageTag(bad), '', JSON.stringify(bad))
  }
})

const EN_DE: readonly LanguageId[] = ['en', 'de']
const ALL: readonly LanguageId[] = LANGUAGE_IDS

test('autoLanguage: the exact tag, then the region stripped as VS Code strips it for the manifest, else English (1.9 A2 test 1)', () => {
  const cases: Array<[string | undefined, readonly LanguageId[], LanguageId]> = [
    ['de', EN_DE, 'de'],
    ['de-ch', EN_DE, 'de'],
    ['DE-CH', EN_DE, 'de'],
    ['pt-br', ALL, 'pt-br'],
    ['pt-pt', ALL, 'en'],
    ['zh-tw', ALL, 'zh-tw'],
    ['zh-cn', ALL, 'zh-cn'],
    ['hu', ALL, 'en'],
    ['', ALL, 'en'],
    [undefined, ALL, 'en'],
    // An id the build does not offer goes to the next rule.
    ['fr', EN_DE, 'en'],
    ['pt-br', EN_DE, 'en'],
    ['en-us', EN_DE, 'en'],
    ['en', EN_DE, 'en'],
    // Several segments are stripped one after the other.
    ['de-de-x-private', EN_DE, 'de'],
    // `zh` is no id: a Hong Kong tag VS Code did not map finds no Chinese of the registry.
    ['zh-hk', ALL, 'en'],
    ['not a tag', ALL, 'en'],
  ]
  for (const [tag, available, expected] of cases) {
    assert.equal(autoLanguage(tag, available), expected, `${JSON.stringify(tag)} with ${available.length} available`)
  }
})

test('resolveLanguage: every setting under VS Code en, de, de-ch and hu — the words, Intl, the page\'s lang and auto (1.9 A2 test 2)', () => {
  // `auto`: the words follow autoLanguage, the formats keep VS Code's own tag (1.8's behaviour), the
  // page's lang is always the words' language — never `hu` for English words.
  const autoRows: Array<[string, readonly LanguageId[], ResolvedLanguage]> = [
    ['en', EN_DE, { setting: 'auto', id: 'en', intl: 'en', htmlLang: 'en', auto: { vscode: 'en', shipped: true } }],
    ['de', EN_DE, { setting: 'auto', id: 'de', intl: 'de', htmlLang: 'de', auto: { vscode: 'de', shipped: true } }],
    ['de-ch', EN_DE, { setting: 'auto', id: 'de', intl: 'de-ch', htmlLang: 'de', auto: { vscode: 'de-ch', shipped: true } }],
    ['hu', EN_DE, { setting: 'auto', id: 'en', intl: 'hu', htmlLang: 'en', auto: { vscode: 'hu', shipped: false } }],
    ['en', ALL, { setting: 'auto', id: 'en', intl: 'en', htmlLang: 'en', auto: { vscode: 'en', shipped: true } }],
    ['de', ALL, { setting: 'auto', id: 'de', intl: 'de', htmlLang: 'de', auto: { vscode: 'de', shipped: true } }],
    ['de-ch', ALL, { setting: 'auto', id: 'de', intl: 'de-ch', htmlLang: 'de', auto: { vscode: 'de-ch', shipped: true } }],
    ['hu', ALL, { setting: 'auto', id: 'en', intl: 'hu', htmlLang: 'en', auto: { vscode: 'hu', shipped: false } }],
    // Beyond the four: a regional Chinese keeps its region in the page's lang, and in Intl.
    ['zh-tw', ALL, { setting: 'auto', id: 'zh-tw', intl: 'zh-tw', htmlLang: 'zh-TW', auto: { vscode: 'zh-tw', shipped: true } }],
    ['pt-br', EN_DE, { setting: 'auto', id: 'en', intl: 'pt-br', htmlLang: 'en', auto: { vscode: 'pt-br', shipped: false } }],
  ]
  for (const [tag, available, expected] of autoRows) {
    assert.deepEqual(resolveLanguage('auto', tag, available), expected, `auto under ${tag} with ${available.length} available`)
  }
  // An explicit id: its own locale for the words, the formats and the page — whatever VS Code says;
  // one whose bundle the build does not have is English through and through.
  for (const available of [EN_DE, ALL]) {
    for (const setting of LANGUAGE_IDS as readonly LanguageSetting[]) {
      for (const tag of ['en', 'de', 'de-ch', 'hu']) {
        const id = setting as LanguageId
        const has = available.includes(id)
        const locale = has ? languageEntry(id).locale : 'en'
        assert.deepEqual(resolveLanguage(setting, tag, available),
          { setting, id: has ? id : 'en', intl: locale, htmlLang: locale, auto: null },
          `${setting} under ${tag} with ${available.length} available`)
      }
    }
  }
  // English is always there, whatever the list says.
  assert.equal(resolveLanguage('en', 'de', []).id, 'en')
})

// ---------------------------------------------------------------------------
// 1.9 B5 (P19): the join — every language of the registry is in the repository, and the picker offers them all
// ---------------------------------------------------------------------------

test('the join: every language of the registry but English has its four parts, its bundle, its manifest and its freshness record (1.9 B5, P19)', () => {
  const { existsSync, readFileSync } = require('node:fs') as typeof import('node:fs')
  const { join } = require('node:path') as typeof import('node:path')
  const { ROOT } = require('./helpers/nls') as typeof import('./helpers/nls')
  const english = Object.keys(readJson('package.nls.json') as Record<string, string>)
  const missing: string[] = []
  for (const { id } of LANGUAGES) {
    const files = [
      ...['dashboard', 'host', 'model', 'text'].map((part) => `l10n/parts/${part}.${id}.json`),
      `l10n/bundle.l10n.${id}.json`,
      `package.nls.${id}.json`,
      `l10n/nls-sources/${id}.json`,
    ]
    if (id === 'en') {
      // English is the source: its words are the keys and package.nls.json; no file is named after it.
      for (const f of files) assert.equal(existsSync(join(ROOT, f)), false, `${f} exists — English has no file of its own`)
      continue
    }
    for (const f of files) {
      if (!existsSync(join(ROOT, f))) { missing.push(f); continue }
      const v = JSON.parse(readFileSync(join(ROOT, f), 'utf8')) as unknown
      assert.ok(v !== null && typeof v === 'object' && !Array.isArray(v) && Object.keys(v as object).length > 0, `${f} is no table`)
    }
    // The record covers every key of the English manifest, in its order (T12 checks the hashes).
    if (existsSync(join(ROOT, `l10n/nls-sources/${id}.json`))) {
      assert.deepEqual(Object.keys(JSON.parse(readFileSync(join(ROOT, `l10n/nls-sources/${id}.json`), 'utf8')) as object), english, `${id}: the record`)
    }
  }
  assert.deepEqual(missing, [], `missing: ${missing.join(', ')}`)
})

test('the join: availableLanguages over the repository\'s l10n/ finds all fourteen, and the picker offers fifteen options — Automatic and every language in the registry\'s order (1.9 B5, P19)', () => {
  const { join } = require('node:path') as typeof import('node:path')
  const { ROOT } = require('./helpers/nls') as typeof import('./helpers/nls')
  const { availableLanguages } = require('../src/languageLoad') as typeof import('../src/languageLoad')
  const { buildViewModel } = require('../src/viewModel') as typeof import('../src/viewModel')
  const { makeInput } = require('./fixtures/viewFixtures') as typeof import('./fixtures/viewFixtures')
  const available = availableLanguages(join(ROOT, 'l10n'))
  assert.deepEqual(available, [...LANGUAGE_IDS])
  // What the extension hands the view model at activation, under auto in an English window.
  const picker = (setting: LanguageSetting) => buildViewModel({
    ...makeInput(), language: { resolved: resolveLanguage(setting, 'en', available), available, vscode: 'en' },
  }).language
  const auto = picker('auto')
  assert.equal(auto.options.length, 15)
  assert.deepEqual(auto.options.map((o) => o.id), ['auto', ...LANGUAGE_IDS])
  assert.deepEqual(auto.options.filter((o) => o.checked).map((o) => o.id), ['auto'])
  // Each language by its own name, in its own lang, with its flag; its name in the reader's language beside it.
  for (const e of LANGUAGES) {
    const o = auto.options.find((x) => x.id === e.id)
    assert.ok(o, e.id)
    assert.equal(o.native, e.native)
    assert.equal(o.lang, e.locale)
    assert.equal(o.flag, e.flag)
    assert.equal(o.name, e.id === 'en' ? null : languageName(e.id))
  }
  // Every language can be chosen and is then the one checked, its flag on the button.
  for (const id of LANGUAGE_IDS) {
    const l = picker(id)
    assert.equal(l.shown, id)
    assert.equal(l.flag, languageEntry(id).flag)
    assert.deepEqual(l.options.filter((o) => o.checked).map((o) => o.id), [id], id)
  }
})
