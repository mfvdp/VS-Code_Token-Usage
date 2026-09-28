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
import { locale, setBundle, setLocale } from '../src/i18n'
import {
  autoLanguage, intlTag, isLanguageId, LANGUAGE_IDS, languageDir, LANGUAGES, LanguageId, languageEntry, languageName,
  LanguageSetting, resolveLanguage, ResolvedLanguage, vscodeLanguageTag,
} from '../src/languages'
import { LANGUAGE_NAME_AS_ENGLISH, readJson } from './helpers/nls'

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

/** 1.11 A1 rule 1 (§2.1): the twelve of tier 2, after `cs` in the collect row's order — a flag of a country each. */
const TIER_2: Array<[string, string, string, string]> = [
  ['nl', 'nl', 'Nederlands', 'nl'],
  ['uk', 'uk', 'Українська', 'ua'],
  ['sv', 'sv', 'Svenska', 'se'],
  ['nb', 'nb', 'Norsk', 'no'],
  ['da', 'da', 'Dansk', 'dk'],
  ['fi', 'fi', 'Suomi', 'fi'],
  ['hi', 'hi', 'हिन्दी', 'in'],
  ['id', 'id', 'Bahasa Indonesia', 'id'],
  ['vi', 'vi', 'Tiếng Việt', 'vn'],
  ['el', 'el', 'Ελληνικά', 'gr'],
  ['hu', 'hu', 'Magyar', 'hu'],
  ['ro', 'ro', 'Română', 'ro'],
]

/** The ids of 1.11's twelve — written whole by 1.11's group N; every one has its files since 1.11's join. */
const NEW_IN_1_11: readonly string[] = TIER_2.map(([id]) => id)

/**
 * 1.13 A1 rule 1 (§2.1): the three written right to left, after `ro` in collect row 9's order — Egypt's, Israel's and
 * Iran's flags (§7a Q13), the native names by code point below.
 */
const RTL_1_13: Array<[string, string, string, string]> = [
  ['ar', 'ar', 'العربية', 'eg'],
  ['he', 'he', 'עברית', 'il'],
  ['fa', 'fa', 'فارسی', 'ir'],
]

/** The ids of 1.13's three: the languages that have no file until their package (group N, N1–N3) writes it whole. */
const NEW_IN_1_13: readonly string[] = RTL_1_13.map(([id]) => id)

/** The fields 1.13 adds to exactly the three (§0b.3): the direction and the pinned digits and calendar. */
const RTL_FIELDS = { dir: 'rtl', digits: 'latn', calendar: 'gregory' } as const

test('the registry: twenty-nine languages — the lead\'s fourteen, the twelve of tier 2 in the collect row\'s order, then Arabic, Hebrew and Persian —, ids unique and lower-case, canonical locales ICU knows, a native name and a drawn flag each, a direction and pinned formats on exactly the three (1.9 A1 rule 1; 1.11 A1 rule 1: the literal 14 → 26; 1.13 A1 rule 1: 26 → 29)', () => {
  assert.equal(LANGUAGES.length, 29)
  assert.deepEqual(LANGUAGES.map((e) => [e.id, e.locale, e.native, e.flag]), [...LEADS_LIST, ...TIER_2, ...RTL_1_13])
  assert.equal(new Set(LANGUAGES.map((e) => e.id)).size, LANGUAGES.length, 'an id stands twice')
  assert.equal(new Set(LANGUAGES.map((e) => e.flag)).size, LANGUAGES.length, 'two languages share a flag')
  // Every native name is in NFC — the form every file of the repository is written in, and the frame compares in.
  for (const e of LANGUAGES) assert.equal(e.native, e.native.normalize('NFC'), `${e.id}: the native name is not NFC`)
  for (const e of LANGUAGES) {
    assert.equal(e.id, e.id.toLowerCase(), `${e.id} is not lower-case — VS Code lower-cases a display language`)
    assert.match(e.id, /^[a-z]{2}(?:-[a-z]{2})?$/, e.id)
    // The canonical tag is ICU's own spelling of the id, and ICU must know it.
    assert.equal(e.locale, Intl.getCanonicalLocales(e.id)[0], `${e.id}: ${e.locale} is not the canonical tag`)
    assert.deepEqual(Intl.DateTimeFormat.supportedLocalesOf([e.locale]), [e.locale], `${e.locale} is unknown to this ICU`)
    assert.ok(e.native.trim().length > 0 && e.native === e.native.trim(), `${e.id} has no native name`)
    assert.ok(Object.prototype.hasOwnProperty.call(FLAG_SVG, e.flag), `${e.id}: no drawing for the flag ${e.flag}`)
    // 1.13 A1 rule 1 (pinned and changed: no direction field, nor any other — every language of 1.9 and 1.11 was written
    // left to right): the three of 1.13 carry exactly dir, digits and calendar beside the four, with the one value each
    // may have; every other entry carries the four and nothing else.
    const rtl = NEW_IN_1_13.includes(e.id)
    assert.deepEqual(Object.keys(e).sort(), ['flag', 'id', 'locale', 'native', ...(rtl ? Object.keys(RTL_FIELDS) : [])].sort(), `${e.id} carries another field`)
    if (rtl) for (const [k, v] of Object.entries(RTL_FIELDS)) assert.equal((e as unknown as Record<string, unknown>)[k], v, `${e.id}: ${k}`)
  }
  // Exactly three are written right to left — languageDir says so for them and 'ltr' for the other twenty-six.
  assert.deepEqual(LANGUAGE_IDS.filter((id) => languageDir(id) === 'rtl'), ['ar', 'he', 'fa'])
  for (const id of LANGUAGE_IDS) assert.ok(['ltr', 'rtl'].includes(languageDir(id)), id)
  // The native names by code point (§2.1): Persian's is written with FARSI YEH (U+06CC), not the Arabic yeh (U+064A).
  const points = (x: string): string[] => [...x].map((c) => c.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0'))
  assert.deepEqual(NEW_IN_1_13.map((id) => points(languageEntry(id as LanguageId).native)), [
    ['0627', '0644', '0639', '0631', '0628', '064A', '0629'],
    ['05E2', '05D1', '05E8', '05D9', '05EA'],
    ['0641', '0627', '0631', '0633', '06CC'],
  ])
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

test('languageName: each language\'s name in the reader\'s language, one t() literal per id — twenty-nine distinct English words (1.11 A1; 1.13 A1 rule 2: Arabic, Hebrew, Persian)', () => {
  const english: Record<LanguageId, string> = {
    en: 'English', de: 'German', fr: 'French', es: 'Spanish', 'pt-br': 'Portuguese (Brazil)', it: 'Italian',
    ja: 'Japanese', ko: 'Korean', 'zh-cn': 'Chinese (Simplified)', 'zh-tw': 'Chinese (Traditional)', ru: 'Russian',
    tr: 'Turkish', pl: 'Polish', cs: 'Czech',
    // 1.11 A1: the twelve of tier 2 (§2.1).
    nl: 'Dutch', uk: 'Ukrainian', sv: 'Swedish', nb: 'Norwegian', da: 'Danish', fi: 'Finnish', hi: 'Hindi',
    id: 'Indonesian', vi: 'Vietnamese', el: 'Greek', hu: 'Hungarian', ro: 'Romanian',
    // 1.13 A1 rule 2 (§7a Q14): "Persian", Microsoft's and ICU's English name for `fa` — not "Farsi".
    ar: 'Arabic', he: 'Hebrew', fa: 'Persian',
  }
  for (const id of LANGUAGE_IDS) assert.equal(languageName(id), english[id], id)
  assert.equal(new Set(LANGUAGE_IDS.map(languageName)).size, LANGUAGE_IDS.length, 'two languages share an English name')
  // An English name is never the native one but where they are the same word (English).
  for (const e of LANGUAGES) if (e.id !== 'en') assert.notEqual(languageName(e.id), e.native, e.id)
  // Through the seam: the German bundle's names (§6), and German's own name is its native one.
  const de = readJson('l10n/bundle.l10n.de.json') as Record<string, string>
  try {
    setBundle(de)
    assert.equal(languageName('de'), 'Deutsch')
    assert.equal(languageName('en'), 'Englisch')
    assert.equal(languageName('zh-tw'), 'Chinesisch (traditionell)')
    assert.equal(languageName('pt-br'), 'Portugiesisch (Brasilien)')
    // 1.11 §6: the twelve of tier 2 in German — Hindi is Hindi in German too (LANGUAGE_NAME_AS_ENGLISH).
    assert.deepEqual(NEW_IN_1_11.map((id) => languageName(id as LanguageId)), ['Niederländisch', 'Ukrainisch', 'Schwedisch',
      'Norwegisch', 'Dänisch', 'Finnisch', 'Hindi', 'Indonesisch', 'Vietnamesisch', 'Griechisch', 'Ungarisch', 'Rumänisch'])
    // 1.13 §6: the three of 1.13 in German, as the Duden writes them (not „Farsi").
    assert.deepEqual(NEW_IN_1_13.map((id) => languageName(id as LanguageId)), ['Arabisch', 'Hebräisch', 'Persisch'])
    // Every name has its German word — none is the English one but where LANGUAGE_NAME_AS_ENGLISH says German writes it
    // so (1.11 A3 rule 11 b, the frame's T10 list: Hindi).
    for (const id of LANGUAGE_IDS) {
      if (LANGUAGE_NAME_AS_ENGLISH.some(([lang, name]) => lang === 'de' && name === english[id])) assert.equal(languageName(id), english[id], id)
      else assert.notEqual(languageName(id), english[id], `${id} has no German name`)
    }
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
    // 1.11: Hungarian is a language of the registry; once its bundle is available, `auto` under a Hungarian VS Code shows it.
    ['hu', ALL, 'hu'],
    ['hu', EN_DE, 'en'],
    // 1.11 §7a Q11: no alias — `nb-no` strips to `nb`, but `no` (and `nn`) is no id of the registry.
    ['nb-no', ALL, 'nb'],
    ['no', ALL, 'en'],
    ['nn', ALL, 'en'],
    ['el-gr', ALL, 'el'],
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
    ['en', EN_DE, { setting: 'auto', id: 'en', intl: 'en', htmlLang: 'en', dir: 'ltr', auto: { vscode: 'en', shipped: true } }],
    ['de', EN_DE, { setting: 'auto', id: 'de', intl: 'de', htmlLang: 'de', dir: 'ltr', auto: { vscode: 'de', shipped: true } }],
    ['de-ch', EN_DE, { setting: 'auto', id: 'de', intl: 'de-ch', htmlLang: 'de', dir: 'ltr', auto: { vscode: 'de-ch', shipped: true } }],
    ['hu', EN_DE, { setting: 'auto', id: 'en', intl: 'hu', htmlLang: 'en', dir: 'ltr', auto: { vscode: 'hu', shipped: false } }],
    ['en', ALL, { setting: 'auto', id: 'en', intl: 'en', htmlLang: 'en', dir: 'ltr', auto: { vscode: 'en', shipped: true } }],
    ['de', ALL, { setting: 'auto', id: 'de', intl: 'de', htmlLang: 'de', dir: 'ltr', auto: { vscode: 'de', shipped: true } }],
    ['de-ch', ALL, { setting: 'auto', id: 'de', intl: 'de-ch', htmlLang: 'de', dir: 'ltr', auto: { vscode: 'de-ch', shipped: true } }],
    // 1.11 (pinned and changed: English with every language of 1.9 available): with every language of the registry
    // available, Hungarian is one of them — its words, its formats, its page; with English and German only, English.
    ['hu', ALL, { setting: 'auto', id: 'hu', intl: 'hu', htmlLang: 'hu', dir: 'ltr', auto: { vscode: 'hu', shipped: true } }],
    ['pt-pt', ALL, { setting: 'auto', id: 'en', intl: 'pt-pt', htmlLang: 'en', dir: 'ltr', auto: { vscode: 'pt-pt', shipped: false } }],
    // Beyond the four: a regional Chinese keeps its region in the page's lang, and in Intl.
    ['zh-tw', ALL, { setting: 'auto', id: 'zh-tw', intl: 'zh-tw', htmlLang: 'zh-TW', dir: 'ltr', auto: { vscode: 'zh-tw', shipped: true } }],
    ['pt-br', EN_DE, { setting: 'auto', id: 'en', intl: 'pt-br', htmlLang: 'en', dir: 'ltr', auto: { vscode: 'pt-br', shipped: false } }],
    // 1.13 A1 (§0a.1, §0a.2): the direction and the pin follow the words' language. VS Code's `ar` with an Arabic bundle:
    // Arabic words, right to left, the digits 0–9 and the Gregorian calendar pinned; its `ar-eg` keeps Egypt's region
    // with the pin (Intl's default there is Arabic-Indic digits); a Persian tag's own `nu` is replaced. The page's lang
    // is the plain tag. Without the bundle, English words, left to right, and VS Code's own tag unpinned.
    ['ar', ALL, { setting: 'auto', id: 'ar', intl: 'ar-u-ca-gregory-nu-latn', htmlLang: 'ar', dir: 'rtl', auto: { vscode: 'ar', shipped: true } }],
    ['ar-eg', ALL, { setting: 'auto', id: 'ar', intl: 'ar-EG-u-ca-gregory-nu-latn', htmlLang: 'ar', dir: 'rtl', auto: { vscode: 'ar-eg', shipped: true } }],
    ['fa-IR-u-nu-arabext', ALL, { setting: 'auto', id: 'fa', intl: 'fa-IR-u-ca-gregory-nu-latn', htmlLang: 'fa', dir: 'rtl', auto: { vscode: 'fa-ir-u-nu-arabext', shipped: true } }],
    ['he', ALL, { setting: 'auto', id: 'he', intl: 'he-u-ca-gregory-nu-latn', htmlLang: 'he', dir: 'rtl', auto: { vscode: 'he', shipped: true } }],
    ['ar', EN_DE, { setting: 'auto', id: 'en', intl: 'ar', htmlLang: 'en', dir: 'ltr', auto: { vscode: 'ar', shipped: false } }],
    ['ar-eg', EN_DE, { setting: 'auto', id: 'en', intl: 'ar-eg', htmlLang: 'en', dir: 'ltr', auto: { vscode: 'ar-eg', shipped: false } }],
  ]
  for (const [tag, available, expected] of autoRows) {
    assert.deepEqual(resolveLanguage('auto', tag, available), expected, `auto under ${tag} with ${available.length} available`)
  }
  // An explicit id: its own locale for the words, the formats and the page — whatever VS Code says;
  // one whose bundle the build does not have is English through and through. 1.13 A1 (pinned and changed: intl was
  // the entry's locale): the formats' tag is the locale through intlTag — the locale itself for every language but the
  // three, which pin the digits and the calendar —, and the direction the language's.
  for (const available of [EN_DE, ALL]) {
    for (const setting of LANGUAGE_IDS as readonly LanguageSetting[]) {
      for (const tag of ['en', 'de', 'de-ch', 'hu', 'ar-eg']) {
        const id = setting as LanguageId
        const has = available.includes(id)
        const shown: LanguageId = has ? id : 'en'
        const locale = languageEntry(shown).locale
        const intl = NEW_IN_1_13.includes(shown) ? `${locale}-u-ca-gregory-nu-latn` : locale
        assert.deepEqual(resolveLanguage(setting, tag, available),
          { setting, id: shown, intl, htmlLang: locale, dir: NEW_IN_1_13.includes(shown) ? 'rtl' : 'ltr', auto: null },
          `${setting} under ${tag} with ${available.length} available`)
      }
    }
  }
  // English is always there, whatever the list says.
  assert.equal(resolveLanguage('en', 'de', []).id, 'en')
})

// ---------------------------------------------------------------------------
// 1.13 A1 rule 4 (§0a.2): the digits 0–9 and the Gregorian calendar, pinned for the three and for no other language
// ---------------------------------------------------------------------------

test('intlTag: the words\' entry\'s calendar and digits as a -u-ca-gregory-nu-latn extension on the base, the base\'s own ca and nu replaced and its other keywords kept, canonicalised; the base as it stands for a language that pins nothing, and for a tag ICU cannot read — never a throw (1.13 A1 rule 4, §0a.2)', () => {
  const cases: Array<[unknown, LanguageId, string]> = [
    ['ar', 'ar', 'ar-u-ca-gregory-nu-latn'],
    ['ar-EG', 'ar', 'ar-EG-u-ca-gregory-nu-latn'],
    // VS Code's tag under auto is lower case: ICU's spelling comes back.
    ['ar-eg', 'ar', 'ar-EG-u-ca-gregory-nu-latn'],
    ['fa-IR-u-nu-arabext', 'fa', 'fa-IR-u-ca-gregory-nu-latn'],
    ['ar-u-nu-arab-ca-islamic', 'ar', 'ar-u-ca-gregory-nu-latn'],
    // Another keyword of the base stays: an hour cycle VS Code reported is VS Code's.
    ['ar-EG-u-hc-h12', 'ar', 'ar-EG-u-ca-gregory-hc-h12-nu-latn'],
    ['he', 'he', 'he-u-ca-gregory-nu-latn'],
    ['fa', 'fa', 'fa-u-ca-gregory-nu-latn'],
    // A language that pins nothing: the base as it stands, even one ICU would spell otherwise or not read at all.
    ['de-CH', 'de', 'de-CH'],
    ['de-ch', 'de', 'de-ch'],
    ['pt-BR', 'pt-br', 'pt-BR'],
    ['x@y', 'de', 'x@y'],
    ['', 'en', ''],
    // A base ICU cannot read comes back as it was — setLocale decides (en-US).
    ['x@y', 'ar', 'x@y'],
    ['', 'fa', ''],
    ['not a tag', 'he', 'not a tag'],
  ]
  for (const [base, id, want] of cases) assert.equal(intlTag(base as string, id), want, `${JSON.stringify(base)} under ${id}`)
  // Not a string at all (a guard the types do not need, the code has anyway): no throw either.
  assert.equal(intlTag(42 as unknown as string, 'ar'), 42 as unknown as string)
  // Every other language of the registry: its locale unchanged — the pin is on the three alone.
  for (const e of LANGUAGES) {
    if (NEW_IN_1_13.includes(e.id)) continue
    assert.equal(intlTag(e.locale, e.id), e.locale, e.id)
  }
  // setLocale takes the pinned tag as it stands (i18n.ts usableLocale: canonical, known to ICU), and the formatters read it.
  try {
    for (const id of NEW_IN_1_13 as LanguageId[]) {
      const tag = intlTag(languageEntry(id).locale, id)
      setLocale(tag)
      assert.equal(locale(), tag, id)
      const n = new Intl.NumberFormat(locale()).resolvedOptions()
      const d = new Intl.DateTimeFormat(locale()).resolvedOptions()
      assert.deepEqual([n.numberingSystem, d.calendar], ['latn', 'gregory'], id)
    }
    setLocale(intlTag('ar-eg', 'ar'))
    assert.equal(locale(), 'ar-EG-u-ca-gregory-nu-latn')
  } finally {
    setLocale(undefined)
  }
})

test('every other locale of the registry writes the digits 0–9 and counts in the Gregorian calendar by ICU\'s own default — so the pin is written for the three alone, and it is needed there: Persian\'s default is Persian digits and the Solar Hijri calendar, Egypt\'s and Saudi Arabia\'s Arabic-Indic digits (1.13 A1 rule 4, §0a.2)', () => {
  const defaults = (tag: string): [string, string] => [
    new Intl.NumberFormat(tag).resolvedOptions().numberingSystem,
    new Intl.DateTimeFormat(tag).resolvedOptions().calendar,
  ]
  for (const e of LANGUAGES) {
    if (NEW_IN_1_13.includes(e.id)) continue
    assert.deepEqual(defaults(e.locale), ['latn', 'gregory'], `${e.locale}: a pin would be needed here too`)
  }
  // The three's bases: fa's default is not 0–9 and not Gregorian — the day 26 September 2026 is 4 Mehr there —, and VS
  // Code's regional Arabic under auto gives Arabic-Indic digits. ar and he happen to be latn and gregory on this ICU; the
  // pin is written for them too, so the three behave alike under any ICU (A1 rule 4).
  assert.notDeepEqual(defaults('fa'), ['latn', 'gregory'])
  assert.notEqual(defaults('ar-EG')[0], 'latn')
  assert.notEqual(defaults('ar-SA')[0], 'latn')
  for (const id of NEW_IN_1_13 as LanguageId[]) {
    assert.deepEqual(defaults(intlTag(languageEntry(id).locale, id)), ['latn', 'gregory'], id)
  }
})

// ---------------------------------------------------------------------------
// 1.9 B5 (P19): the join — every language of the registry is in the repository, and the picker offers them all
// ---------------------------------------------------------------------------

/**
 * 1.11 P2 (pinned and changed: every language of the registry had its files since 1.9's join): the twelve of tier 2 are in
 * the registry before a single file of theirs exists — group N writes each whole, from the frozen tip, and the join (P8,
 * PENDING_ALLOWED false) has them all. Until then a language of the registry has all of its files or none, and one with
 * none is one of the twelve.
 * 1.13 P2 (pinned and changed: one of 1.11's twelve): the twelve have their files since 1.11's join; Arabic, Hebrew and
 * Persian are in the registry before a single file of theirs exists (N1–N3 write each whole, P7 joins), so a language
 * with none is one of 1.13's three — P1's spec error 4.
 */
test('the join: every language of the registry but English has its four parts, its bundle, its manifest and its freshness record — on the build branch, one of 1.13\'s three has none of them yet (1.9 B5, P19; 1.11 P2; 1.13 P2)', () => {
  const { existsSync, readFileSync } = require('node:fs') as typeof import('node:fs')
  const { join } = require('node:path') as typeof import('node:path')
  const { pendingNlsKeys, ROOT } = require('./helpers/nls') as typeof import('./helpers/nls')
  const english = Object.keys(readJson('package.nls.json') as Record<string, string>)
  const missing: string[] = []
  const notYet: string[] = []
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
    // A language not written yet: none of its seven files. Half a language is a finding in either state.
    if (files.every((f) => !existsSync(join(ROOT, f)))) { notYet.push(id); continue }
    for (const f of files) {
      if (!existsSync(join(ROOT, f))) { missing.push(f); continue }
      const v = JSON.parse(readFileSync(join(ROOT, f), 'utf8')) as unknown
      assert.ok(v !== null && typeof v === 'object' && !Array.isArray(v) && Object.keys(v as object).length > 0, `${f} is no table`)
    }
    // The record covers every key of the English manifest, in its order (T12 checks the hashes). 1.10 B1 (pinned and
    // changed: every key): a key on the language's pending list that it has not translated yet has no record until it
    // is; test/l10n.languages.test.ts (T14) allows no list at the join.
    if (existsSync(join(ROOT, `l10n/nls-sources/${id}.json`))) {
      const record = JSON.parse(readFileSync(join(ROOT, `l10n/nls-sources/${id}.json`), 'utf8')) as object
      const pending = pendingNlsKeys(id)
      assert.deepEqual(Object.keys(record), english.filter((k) => !pending.has(k) || Object.prototype.hasOwnProperty.call(record, k)), `${id}: the record`)
    }
  }
  assert.deepEqual(missing, [], `missing: ${missing.join(', ')}`)
  // Only a language of 1.13's three may be unwritten, and only before the join.
  assert.deepEqual(notYet.filter((id) => !NEW_IN_1_13.includes(id)), [], 'a language of 1.12 has no files')
  if (!pendingAllowed()) assert.deepEqual(notYet, [], `at the join every language is written: ${notYet.join(', ')} is not`)
})

test('the join: availableLanguages over the repository\'s l10n/ finds every language written, and the picker offers Automatic and each of them in the registry\'s order — all twenty-nine and thirty options at the join, the twenty-six of 1.12 and twenty-seven before it —, each native name in its own direction, the three written right to left last (1.9 B5, P19; 1.11 A8, P2; 1.13 P2, P7)', () => {
  const { existsSync } = require('node:fs') as typeof import('node:fs')
  const { join } = require('node:path') as typeof import('node:path')
  const { ROOT } = require('./helpers/nls') as typeof import('./helpers/nls')
  const { availableLanguages } = require('../src/languageLoad') as typeof import('../src/languageLoad')
  const { buildViewModel } = require('../src/viewModel') as typeof import('../src/viewModel')
  const { makeInput } = require('./fixtures/viewFixtures') as typeof import('./fixtures/viewFixtures')
  const available = availableLanguages(join(ROOT, 'l10n'))
  const written = LANGUAGE_IDS.filter((id) => id === 'en' || existsSync(join(ROOT, 'l10n', `bundle.l10n.${id}.json`)))
  assert.deepEqual(available, written)
  if (pendingAllowed()) {
    // 1.13 P2 (pinned and changed: the fourteen of 1.10 at least, and beyond them only one of 1.11's twelve): the build
    // branch — the twenty-six of 1.12 at least, and no language beyond them but one of 1.13's three.
    assert.deepEqual(available.slice(0, 26), [...LEADS_LIST, ...TIER_2].map(([id]) => id))
    assert.deepEqual(available.slice(26).filter((id) => !NEW_IN_1_13.includes(id)), [])
  } else {
    // 1.13 P2 (pinned and changed: 1.11 P8's twenty-six): 1.13's join (P7) — English, German, the twenty-four and the three.
    assert.deepEqual(available, [...LANGUAGE_IDS])
    assert.equal(available.length, 29)
  }
  // What the extension hands the view model at activation, under auto in an English window.
  const picker = (setting: LanguageSetting) => buildViewModel({
    ...makeInput(), language: { resolved: resolveLanguage(setting, 'en', available), available, vscode: 'en' },
  }).language
  const auto = picker('auto')
  assert.equal(auto.options.length, available.length + 1)
  // 1.11 P8 (A1 rule 3, A8): Automatic and the twenty-six at the join; 1.13 (pinned and changed: 27): and the three.
  if (!pendingAllowed()) assert.equal(auto.options.length, 30)
  assert.deepEqual(auto.options.map((o) => o.id), ['auto', ...available])
  // 1.13 P7 (§3 E3; A2 rule 5): at the join the three written right to left are offered, last, each native name in its
  // own direction — Automatic in the reader's (null), every other one left to right.
  if (!pendingAllowed()) {
    assert.deepEqual(auto.options.slice(-3).map((o) => o.id), [...NEW_IN_1_13])
    assert.deepEqual(auto.options.filter((o) => o.dir === 'rtl').map((o) => o.id), [...NEW_IN_1_13])
  }
  assert.deepEqual(auto.options.filter((o) => o.checked).map((o) => o.id), ['auto'])
  // Each language by its own name, in its own lang, with its flag; its name in the reader's language beside it. A
  // language without its bundle is not offered (the setting's value shows English until it is).
  for (const e of LANGUAGES) {
    const o = auto.options.find((x) => x.id === e.id)
    if (!available.includes(e.id)) { assert.equal(o, undefined, `${e.id} is offered without its bundle`); continue }
    assert.ok(o, e.id)
    assert.equal(o.native, e.native)
    assert.equal(o.lang, e.locale)
    assert.equal(o.flag, e.flag)
    assert.equal(o.dir, languageDir(e.id))
    assert.equal(o.name, e.id === 'en' ? null : languageName(e.id))
  }
  assert.equal(auto.options[0].dir, null)
  // Every language offered can be chosen and is then the one checked, its flag on the button.
  for (const id of available) {
    const l = picker(id)
    assert.equal(l.shown, id)
    assert.equal(l.flag, languageEntry(id).flag)
    assert.deepEqual(l.options.filter((o) => o.checked).map((o) => o.id), [id], id)
  }
})

// ---------------------------------------------------------------------------
// 1.10 P20: the join — every language has worked through the ledger, and the gates hold without tolerance
// ---------------------------------------------------------------------------

/**
 * 1.11 P1 (pinned and changed: the join test of 1.10 P20 held the tree to the join unconditionally). `--start b89ff43`
 * began 1.11's ledger with a list at cursor 0 for each of the twelve 1.10 languages, and the frame's PENDING_ALLOWED
 * (test/l10n.languages.test.ts) is true again until 1.11's join (P8). The switch is read from that file's line — a test
 * file bundled into this one would run its tests twice —, so this test holds the join exactly when the frame does, and
 * the build branch's gates in between.
 */
function pendingAllowed(): boolean {
  const { readFileSync } = require('node:fs') as typeof import('node:fs')
  const { join } = require('node:path') as typeof import('node:path')
  const { ROOT } = require('./helpers/nls') as typeof import('./helpers/nls')
  const m = /^export const PENDING_ALLOWED: boolean = (true|false)$/m.exec(readFileSync(join(ROOT, 'test', 'l10n.languages.test.ts'), 'utf8'))
  assert.ok(m, 'test/l10n.languages.test.ts no longer declares PENDING_ALLOWED on one line')
  return m[1] === 'true'
}

test('the join: no pending list is left, every ledger entry is applied to every language, and the manifest\'s records are fresh without any tolerance — l10n-rekey --check and nls-sources --check --strict exit 0; on the build branch, while PENDING_ALLOWED, every list is at the ledger\'s end and the tolerant gates pass (1.10 B1, P20; 1.11 P1: both states)', () => {
  const { spawnSync } = require('node:child_process') as typeof import('node:child_process')
  const { existsSync, readdirSync, readFileSync } = require('node:fs') as typeof import('node:fs')
  const { join } = require('node:path') as typeof import('node:path')
  const { ROOT } = require('./helpers/nls') as typeof import('./helpers/nls')
  // The language packages delete their lists at the end; an empty folder may stay behind (git does not keep one).
  const pendingDir = join(ROOT, 'l10n', 'pending')
  const left = existsSync(pendingDir) ? readdirSync(pendingDir).filter((f) => !f.startsWith('.')) : []
  const ledger = JSON.parse(readFileSync(join(ROOT, 'l10n', 'rekey.json'), 'utf8')) as { v: number; entries: unknown[] }
  assert.equal(ledger.v, 1)
  const run = (script: string, ...args: string[]): { status: number | null; out: string } => {
    const r = spawnSync(process.execPath, [join(ROOT, 'scripts', script), ...args], { cwd: ROOT, encoding: 'utf8' })
    return { status: r.status, out: `${r.stdout}${r.stderr}` }
  }
  const translations = readdirSync(ROOT).filter((f) => /^package\.nls\.[a-z-]+\.json$/.test(f)).length
  const rekey = run('l10n-rekey.mjs', '--check')
  assert.equal(rekey.status, 0, rekey.out)
  assert.match(rekey.out, new RegExp(`every entry is applied \\(${ledger.entries.length} entr(?:y|ies) since \\w+; ${left.length} language\\(s\\) with a pending list\\)`))
  if (pendingAllowed()) {
    // The build branch: a list for each language that has not worked through the ledger yet, each at its end (T14), and
    // the freshness gate tolerant of the keys they name.
    assert.ok(left.length > 0, 'PENDING_ALLOWED is true, and no list is on disk — the join sets it false')
    const tolerant = run('nls-sources.mjs', '--check')
    assert.equal(tolerant.status, 0, tolerant.out)
    assert.match(tolerant.out, new RegExp(`every record is fresh \\(${translations} language\\(s\\)`))
    return
  }
  assert.deepEqual(left, [], `pending lists left at the join: ${left.join(', ')}`)
  // The ledger has entries (the version changed the English), each applied: a language without a list is done.
  assert.ok(ledger.entries.length > 0, 'the ledger has no entry')
  // --strict counts a pending manifest key as a problem; at the join there is none, in any language.
  const strict = run('nls-sources.mjs', '--check', '--strict')
  assert.equal(strict.status, 0, strict.out)
  assert.match(strict.out, new RegExp(`every record is fresh \\(${translations} language\\(s\\)\\)`))
  assert.doesNotMatch(strict.out, /pending/)
})
