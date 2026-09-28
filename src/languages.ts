// SPDX-FileCopyrightText: 2026 Frederik Marx
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * 1.9 A1: the languages Token Pace ships — the one list of them, and the rules that pick the one
 * whose words are shown.
 *
 * The registry is the whole truth about a language: its id is the setting's value
 * (`tokenPace.language`) and the tag of every file of it (`l10n/bundle.l10n.<id>.json`,
 * `package.nls.<id>.json`, `l10n/parts/<part>.<id>.json`), spelled as VS Code 1.138 spells a display
 * language — lower case, `pt-br`, `zh-cn`, `zh-tw` (it lower-cases `--locale` and `argv.json`, and maps
 * every Chinese system locale to one of the two). A file name is only ever built from an id of this
 * list, never from a setting's text (languageLoad.ts).
 *
 * 1.13 A1: the direction and the pinned formats are registry data too. Arabic, Hebrew and Persian are written right to
 * left — `dir: 'rtl'`, absent on every other entry, which is left to right (`languageDir`) — and pin Intl's digits and
 * calendar (`digits: 'latn'`, `calendar: 'gregory'`, `intlTag`): the digits 0–9 and the Gregorian calendar in every
 * view, because the bar, the page and the tooltips put Token Pace's marks beside figures and the exports write 0–9, and
 * because `fa` (and `ar-EG`, `ar-SA` under `auto`) would otherwise print other digits and `fa` the Solar Hijri calendar
 * beside weeks and months computed in Gregorian days. A test holds that exactly these three carry the three fields and no
 * entry carries another one.
 *
 * Pure: the one import is the localisation seam, for the twenty-nine names in the reader's language.
 */

import { t } from './i18n'

/**
 * 1.9 A: the languages Token Pace ships — VS Code's display-language ids, lower-case as VS Code 1.138 spells them.
 * 1.11 A1: twelve more after `cs`; Norwegian is `nb` (Bokmål), the tag VS Code and ICU use for it.
 * 1.13 A1: Arabic, Hebrew and Persian after `ro`, written right to left.
 */
export type LanguageId =
  | 'en' | 'de' | 'fr' | 'es' | 'pt-br' | 'it' | 'ja' | 'ko' | 'zh-cn' | 'zh-tw' | 'ru' | 'tr' | 'pl' | 'cs'
  | 'nl' | 'uk' | 'sv' | 'nb' | 'da' | 'fi' | 'hi' | 'id' | 'vi' | 'el' | 'hu' | 'ro'
  | 'ar' | 'he' | 'fa'
/** `tokenPace.language`: `auto` follows VS Code's display language. */
export type LanguageSetting = 'auto' | LanguageId
/**
 * The flag drawn beside a language — a country, not the language (§3 A3.2): Ukraine's for Ukrainian, India's for Hindi;
 * 1.13 §7a Q13: Egypt's for Arabic, Israel's for Hebrew, Iran's for Persian.
 */
export type FlagId =
  | 'us' | 'de' | 'fr' | 'es' | 'br' | 'it' | 'jp' | 'kr' | 'cn' | 'tw' | 'ru' | 'tr' | 'pl' | 'cz'
  | 'nl' | 'ua' | 'se' | 'no' | 'dk' | 'fi' | 'in' | 'id' | 'vn' | 'gr' | 'hu' | 'ro'
  | 'eg' | 'il' | 'ir'

/** 1.13 A1: the direction a language's words are written in. */
export type TextDirection = 'ltr' | 'rtl'

export interface LanguageEntry {
  /** The setting's value and the file tag: bundle.l10n.<id>.json, package.nls.<id>.json, l10n/parts/<part>.<id>.json. */
  id: LanguageId
  /** Canonical BCP 47: the Intl locale of an explicit choice and the page's `lang` — 'pt-BR', 'zh-CN', 'zh-TW', else the id. */
  locale: string
  /** The language's own name, never translated: "Deutsch", "日本語". */
  native: string
  flag: FlagId
  /** 1.13 A1: written right to left — absent means left to right. Exactly ar, he, fa carry it (a test). */
  dir?: 'rtl'
  /** 1.13 A1 rule 4: Intl's numbering system, pinned where the locale's default is not the digits 0–9 (or may not be, under `auto`). */
  digits?: 'latn'
  /** 1.13 A1 rule 4: Intl's calendar, pinned where the locale's default is not the Gregorian one (fa: Solar Hijri). */
  calendar?: 'gregory'
}

/**
 * The registry in the picker's order — the lead's list (collect "Vorschlag Sprachliste", tier 1), then 1.11's twelve
 * (tier 2) in the collect row's order, then 1.13's three (collect row 9's order: Arabic, Hebrew, Persian). Written by 1.9
 * P1, 1.11 P2 and 1.13 P2; no translation package touches it. A language is offered once its bundle exists
 * (languageLoad.ts `availableLanguages`), so an entry without files is never chosen.
 *
 * The native names of 1.13 by code point (NFC; a test pins them): ar U+0627 0644 0639 0631 0628 064A 0629, he U+05E2 05D1
 * 05E8 05D9 05EA, fa U+0641 0627 0631 0633 06CC — FARSI YEH, not the Arabic yeh U+064A.
 */
export const LANGUAGES: readonly LanguageEntry[] = Object.freeze([
  { id: 'en', locale: 'en', native: 'English', flag: 'us' },
  { id: 'de', locale: 'de', native: 'Deutsch', flag: 'de' },
  { id: 'fr', locale: 'fr', native: 'Français', flag: 'fr' },
  { id: 'es', locale: 'es', native: 'Español', flag: 'es' },
  { id: 'pt-br', locale: 'pt-BR', native: 'Português (Brasil)', flag: 'br' },
  { id: 'it', locale: 'it', native: 'Italiano', flag: 'it' },
  { id: 'ja', locale: 'ja', native: '日本語', flag: 'jp' },
  { id: 'ko', locale: 'ko', native: '한국어', flag: 'kr' },
  { id: 'zh-cn', locale: 'zh-CN', native: '简体中文', flag: 'cn' },
  { id: 'zh-tw', locale: 'zh-TW', native: '繁體中文', flag: 'tw' },
  { id: 'ru', locale: 'ru', native: 'Русский', flag: 'ru' },
  { id: 'tr', locale: 'tr', native: 'Türkçe', flag: 'tr' },
  { id: 'pl', locale: 'pl', native: 'Polski', flag: 'pl' },
  { id: 'cs', locale: 'cs', native: 'Čeština', flag: 'cz' },
  { id: 'nl', locale: 'nl', native: 'Nederlands', flag: 'nl' },
  { id: 'uk', locale: 'uk', native: 'Українська', flag: 'ua' },
  { id: 'sv', locale: 'sv', native: 'Svenska', flag: 'se' },
  // §7a Q12: "Norsk", Frederik's list; the variant is Bokmål (`nb`), which docs/languages.md says.
  { id: 'nb', locale: 'nb', native: 'Norsk', flag: 'no' },
  { id: 'da', locale: 'da', native: 'Dansk', flag: 'dk' },
  { id: 'fi', locale: 'fi', native: 'Suomi', flag: 'fi' },
  { id: 'hi', locale: 'hi', native: 'हिन्दी', flag: 'in' },
  { id: 'id', locale: 'id', native: 'Bahasa Indonesia', flag: 'id' },
  { id: 'vi', locale: 'vi', native: 'Tiếng Việt', flag: 'vn' },
  { id: 'el', locale: 'el', native: 'Ελληνικά', flag: 'gr' },
  { id: 'hu', locale: 'hu', native: 'Magyar', flag: 'hu' },
  { id: 'ro', locale: 'ro', native: 'Română', flag: 'ro' },
  // 1.13 A1: written right to left, the digits 0–9 and the Gregorian calendar pinned (§7a Q6, Q13, Q14, Q16, Q33).
  { id: 'ar', locale: 'ar', native: 'العربية', flag: 'eg', dir: 'rtl', digits: 'latn', calendar: 'gregory' },
  { id: 'he', locale: 'he', native: 'עברית', flag: 'il', dir: 'rtl', digits: 'latn', calendar: 'gregory' },
  { id: 'fa', locale: 'fa', native: 'فارسی', flag: 'ir', dir: 'rtl', digits: 'latn', calendar: 'gregory' },
].map((e) => Object.freeze(e as LanguageEntry)))

/** Every id, in the registry's order — the manifest's enum after `auto`. */
export const LANGUAGE_IDS: readonly LanguageId[] = Object.freeze(LANGUAGES.map((e) => e.id))

/** An exact registry id: another case, a path or a number is not one. */
export function isLanguageId(v: unknown): v is LanguageId {
  return typeof v === 'string' && (LANGUAGE_IDS as readonly string[]).includes(v)
}

/** The registry entry of an id. */
export function languageEntry(id: LanguageId): LanguageEntry {
  return LANGUAGES.find((e) => e.id === id) ?? LANGUAGES[0]
}

/** 1.13 A1: the words' direction of a language — 'rtl' where the entry says so, else 'ltr'. */
export function languageDir(id: LanguageId): TextDirection {
  return languageEntry(id).dir === 'rtl' ? 'rtl' : 'ltr'
}

/**
 * 1.13 A1 rule 4 (§0a.2): the Intl tag for `base` — the entry's locale for an explicit choice, VS Code's tag under
 * `auto` — with the calendar and the digits the words' entry pins, as a `-u-ca-…-nu-…` extension: the base's own `ca` and
 * `nu` keywords replaced, its other keywords (`hc`, …) kept, the tag canonicalised by ICU (`ar-eg` → `ar-EG-u-ca-gregory-
 * nu-latn`). `base` as it stands when the entry pins nothing — every language but ar, he and fa, whose ICU defaults are
 * the digits 0–9 and the Gregorian calendar already (a test holds it). Never throws: a base ICU cannot read comes back as
 * it was, and setLocale decides what to do with it.
 */
export function intlTag(base: string, id: LanguageId): string {
  const { calendar, digits } = languageEntry(id)
  if (calendar === undefined && digits === undefined) return base
  const options: Intl.LocaleOptions = {}
  if (calendar !== undefined) options.calendar = calendar
  if (digits !== undefined) options.numberingSystem = digits
  try {
    return new Intl.Locale(base, options).toString()
  } catch {
    // RangeError: not a BCP 47 tag; TypeError: not a string.
    return base
  }
}

/**
 * The language's name in the reader's language — one `t()` literal per id ('English', 'German', 'French', 'Spanish',
 * 'Portuguese (Brazil)', 'Italian', 'Japanese', 'Korean', 'Chinese (Simplified)', 'Chinese (Traditional)', 'Russian',
 * 'Turkish', 'Polish', 'Czech'; since 1.11 'Dutch', 'Ukrainian', 'Swedish', 'Norwegian', 'Danish', 'Finnish', 'Hindi',
 * 'Indonesian', 'Vietnamese', 'Greek', 'Hungarian', 'Romanian'; since 1.13 'Arabic', 'Hebrew', 'Persian' — Microsoft's
 * and ICU's English name for `fa`, not "Farsi", §7a Q14): a switch, because the extract script reads literals only.
 */
export function languageName(id: LanguageId): string {
  switch (id) {
    case 'en': return t('English')
    case 'de': return t('German')
    case 'fr': return t('French')
    case 'es': return t('Spanish')
    case 'pt-br': return t('Portuguese (Brazil)')
    case 'it': return t('Italian')
    case 'ja': return t('Japanese')
    case 'ko': return t('Korean')
    case 'zh-cn': return t('Chinese (Simplified)')
    case 'zh-tw': return t('Chinese (Traditional)')
    case 'ru': return t('Russian')
    case 'tr': return t('Turkish')
    case 'pl': return t('Polish')
    case 'cs': return t('Czech')
    case 'nl': return t('Dutch')
    case 'uk': return t('Ukrainian')
    case 'sv': return t('Swedish')
    case 'nb': return t('Norwegian')
    case 'da': return t('Danish')
    case 'fi': return t('Finnish')
    case 'hi': return t('Hindi')
    case 'id': return t('Indonesian')
    case 'vi': return t('Vietnamese')
    case 'el': return t('Greek')
    case 'hu': return t('Hungarian')
    case 'ro': return t('Romanian')
    case 'ar': return t('Arabic')
    case 'he': return t('Hebrew')
    case 'fa': return t('Persian')
  }
}

/**
 * VS Code's display language as Token Pace may repeat it — in the diagnostics report, the log and the
 * picker's *Automatic* line: lower-cased, and only when it is a tag of `[a-z0-9-]{1,20}`; anything
 * else is ''. VS Code reports what `--locale`, `argv.json` or the operating system said, so the value
 * is held to a tag's alphabet before it is printed anywhere.
 */
export function vscodeLanguageTag(raw: unknown): string {
  if (typeof raw !== 'string') return ''
  const tag = raw.trim().toLowerCase()
  return /^[a-z0-9-]{1,20}$/.test(tag) ? tag : ''
}

/** `autoLanguage` with whether the tag found a shipped language (true) or fell back to English (false). */
function autoLookup(vscodeLanguage: string | undefined, available: readonly LanguageId[]): { id: LanguageId; found: boolean } {
  let tag = vscodeLanguageTag(vscodeLanguage)
  while (tag !== '') {
    if (isLanguageId(tag) && available.includes(tag)) return { id: tag, found: true }
    const dash = tag.lastIndexOf('-')
    tag = dash > 0 ? tag.slice(0, dash) : ''
  }
  return { id: 'en', found: false }
}

/**
 * What `auto` means for VS Code's display language: the lower-cased tag if it is an available id, else the tag with its
 * last `-segment` stripped, repeatedly — the rule VS Code 1.138 applies to package.nls.<language>.json [read 2026-09-25],
 * so the texts and the settings UI agree ('de-ch' → 'de'); else 'en'. 'pt-pt' → 'en' ('pt' is no id).
 */
export function autoLanguage(vscodeLanguage: string | undefined, available: readonly LanguageId[]): LanguageId {
  return autoLookup(vscodeLanguage, available).id
}

export interface ResolvedLanguage {
  setting: LanguageSetting
  /** The language whose words are shown. */
  id: LanguageId
  /**
   * Intl: the entry's `locale` for an explicit choice; under `auto` VS Code's own tag, as 1.8 used it ('de-ch' keeps
   * de-CH's formats). 1.13 A1 rule 4: through `intlTag` — with the words' entry's pinned calendar and digits ('ar' →
   * 'ar-u-ca-gregory-nu-latn', VS Code's 'ar-eg' → 'ar-EG-u-ca-gregory-nu-latn'); every other language's tag unchanged.
   */
  intl: string
  /**
   * The page's `lang`: always the words' language (the entry's `locale`) — never VS Code's tag when the words are English,
   * and never the pinned tag (1.13 A1 rule 5: `setLang` takes no `-u-` extension; a `lang` needs none).
   */
  htmlLang: string
  /** 1.13 A1: the words' direction — `languageDir(id)`, never VS Code's: an English page under VS Code's `ar` is 'ltr'. */
  dir: TextDirection
  /** Under `auto`: VS Code's display language as reported (through `[a-z0-9-]{1,20}`, else '') and whether Token Pace has it. */
  auto: { vscode: string; shipped: boolean } | null
}

/**
 * An explicit id whose bundle is not available resolves to English (a log line says why).
 *
 * 1.13 A1: the direction and the pinned formats follow the words' language (`id`), never VS Code's tag — an English
 * page under VS Code's `ar` (no Arabic bundle) stays left to right with VS Code's own formats, and an Arabic page under
 * VS Code's `ar-eg` takes Egypt's formats with the digits 0–9 and the Gregorian calendar pinned.
 *
 * Under `auto` the words follow `autoLanguage`, and the formats keep VS Code's own tag (`intl`), as
 * they did before 1.9: a `de-ch` window keeps Swiss number formats with German words, a `pt-pt` window
 * Portugal's formats with English words (Hungarian, 1.9's example, is a language of the registry since
 * 1.11 and, once its bundle ships, `hu` shows Hungarian words). `setLocale` canonicalises the tag and falls back to en-US for
 * one ICU does not know. An empty tag counts as English, which is what VS Code reports by default.
 */
export function resolveLanguage(
  setting: LanguageSetting,
  vscodeLanguage: string | undefined,
  available: readonly LanguageId[],
): ResolvedLanguage {
  if (setting !== 'auto') {
    const id: LanguageId = setting === 'en' || available.includes(setting) ? setting : 'en'
    const entry = languageEntry(id)
    return { setting, id, intl: intlTag(entry.locale, id), htmlLang: entry.locale, dir: languageDir(id), auto: null }
  }
  const vscode = vscodeLanguageTag(vscodeLanguage)
  const { id, found } = autoLookup(vscodeLanguage, available)
  const raw = typeof vscodeLanguage === 'string' ? vscodeLanguage.trim() : ''
  return {
    setting,
    id,
    intl: intlTag(raw, id),
    htmlLang: languageEntry(id).locale,
    dir: languageDir(id),
    auto: { vscode, shipped: found || vscode === '' },
  }
}
