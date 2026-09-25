// SPDX-FileCopyrightText: 2026 Frederik Marx
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The manifest is localizable: every user-visible string in `package.json` is a `%key%` that
 * VS Code resolves out of `package.nls.json`, and a German build resolves it out of
 * `package.nls.de.json` instead. Three things can silently break that, and none of them shows
 * up in a build:
 *
 *   - a key used in the manifest that no bundle defines — VS Code then shows the raw `%key%`;
 *   - a key left in a bundle after the setting it described was removed — dead prose that a
 *     translator keeps maintaining;
 *   - a translation that drops a `#tokenPace.x#` setting link, a `command:` link or a fenced
 *     example — those are the parts of a description that *do* something, and losing one turns
 *     a working link into plain text in that language only.
 *
 * Every translation — `package.nls.<id>.json`, German and, from 1.9 on, each language a translation
 * package adds (`nlsFiles()`) — is checked against the English one for exactly that structure, not
 * for wording. The rules that are German's own (the quoted runtime words, the keep-warm setting's
 * German claims) stay German's; test/l10n.languages.test.ts holds every language to the rest of the
 * 1.9 frame. 1.10 B1: a key on a language's pending list (`l10n/pending/<id>.json`, the English changed and the
 * language's package has not translated it yet) is out of the rules that compare a value with today's English — the
 * English prose, the links and paragraphs, the JSON examples — until it is done; the frame's T14 allows no such list at
 * the join. No file outside the repository is touched.
 */

import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { LANGUAGES } from '../src/languages'
import { englishNls, germanNls, manifestKeys, NLS_KEY, nlsFiles, pendingNlsKeys, rawManifest, readManifest, ROOT } from './helpers/nls'

/** 1.9 B3: every translation of the manifest on disk, German among them. */
const TRANSLATIONS = nlsFiles()
/** 1.10 B1: the English beside a translation, less the keys its pending list names (compared once they are done). */
const comparable = (id: string): Array<[string, string]> => {
  const pending = pendingNlsKeys(id)
  return Object.entries(englishNls).filter(([key]) => !pending.has(key))
}
const BUNDLES: Array<[string, Record<string, string>]> = [
  ['package.nls.json', englishNls],
  ...TRANSLATIONS.map((f): [string, Record<string, string>] => [f.file, f.nls]),
]

test('the translations of the manifest are read from disk, German among them (1.9 B3)', () => {
  // A guard against a loop over nothing: every rule below runs over this list.
  assert.deepEqual(TRANSLATIONS.find((f) => f.id === 'de')?.nls, germanNls, 'package.nls.de.json was not found')
  assert.equal(TRANSLATIONS.some((f) => f.file === 'package.nls.json'), false, 'the English file is no translation')
})

const used = manifestKeys()

test('the manifest actually uses placeholders, and every one of them resolves in every bundle (1.9 B3: every language on disk)', () => {
  // A guard against the opposite failure: an edit that puts English prose back into the
  // manifest would leave the bundles complete and consistent while shipping untranslatable text.
  assert.ok(used.length >= 200, `only ${used.length} %key% placeholders left in package.json`)
  for (const [name, bundle] of BUNDLES) {
    for (const key of used) {
      assert.ok(key in bundle, `package.json uses %${key}%, which ${name} does not define`)
      assert.ok(String(bundle[key]).length > 0, `${name} has an empty value for ${key}`)
    }
  }
})

test('no bundle carries a key the manifest does not use (1.9 B3: every language on disk)', () => {
  const inUse = new Set(used)
  for (const [name, bundle] of BUNDLES) {
    for (const key of Object.keys(bundle)) {
      assert.ok(inUse.has(key), `${name} defines ${key}, which package.json never uses`)
    }
  }
})

test('every translation has every key of the English one, in its order, and no other (1.9 B3 T1; German since 1.2)', () => {
  for (const { file, nls } of TRANSLATIONS) {
    assert.deepEqual(Object.keys(nls), Object.keys(englishNls), `${file}: its keys are not package.nls.json's, in its order`)
  }
})

test('every translation is its own language — no entry is a forgotten copy of the English prose (1.9 B3 T9; German since 1.2)', () => {
  // Short labels legitimately match (“Token Pace”, “Codex”, “Dashboard”); a whole paragraph
  // that matches is an untranslated string, not a coincidence.
  for (const { id, file, nls } of TRANSLATIONS) {
    for (const [key, english] of comparable(id)) {
      if (english.length < 40) continue
      assert.notEqual(nls[key], english, `${file}: ${key} is still the English text`)
    }
  }
})

test('every translation keeps the links and examples that do something (1.9 B3 T5: every language on disk)', () => {
  const settingLinks = (s: string): string[] => [...s.matchAll(/#(tokenPace\.[\w.]+)#/g)].map((m) => m[1]).sort()
  const commandLinks = (s: string): string[] => [...s.matchAll(/\(command:([\w.]+)\)/g)].map((m) => m[1]).sort()
  const fences = (s: string): number => (s.match(/```/g) ?? []).length
  for (const { id, file, nls } of TRANSLATIONS) {
    for (const [key, english] of comparable(id)) {
      const translated = nls[key]
      assert.deepEqual(settingLinks(translated), settingLinks(english), `${file}: ${key} lost or invented a setting link`)
      assert.deepEqual(commandLinks(translated), commandLinks(english), `${file}: ${key} lost or invented a command link`)
      assert.equal(fences(translated), fences(english), `${file}: ${key} lost a fenced example`)
      // The paragraph structure is what the settings UI lays out; a merged paragraph reads as
      // one wall of text in that language only.
      assert.equal(translated.split('\n\n').length, english.split('\n\n').length, `${file}: ${key} changed its paragraphs`)
    }
  }
})

test('the JSON examples inside a translation keep their setting keys and values (1.9 B3 T5: every language on disk)', () => {
  // A translated `"claude"` or a translated number would be a broken example: users paste it.
  const blocks = (s: string): string[] => [...s.matchAll(/```json\n([\s\S]*?)```/g)].map((m) => m[1])
  for (const { id, file, nls } of TRANSLATIONS) {
    for (const [key, english] of comparable(id)) {
      assert.deepEqual(blocks(nls[key]), blocks(english), `${file}: ${key} translated a JSON example`)
    }
  }
})

test('every enum description is the key of the value standing at its own index', () => {
  // `dashboard.sections` shipped with its first two descriptions swapped, so the settings UI
  // explained "quota" as the summary and vice versa. The keys carry the value's own name, so
  // the two lists can be checked against each other rather than only counted.
  const manifest = rawManifest as {
    contributes: { configuration: Array<{ properties: Record<string, Record<string, unknown>> }> }
  }
  let checked = 0
  for (const section of manifest.contributes.configuration) {
    for (const [key, property] of Object.entries(section.properties)) {
      const items = (property.items ?? {}) as Record<string, unknown>
      for (const holder of [property, items]) {
        const described = holder.enumDescriptions as string[] | undefined
        if (!described) continue
        const values = (holder.enum ?? []) as string[]
        assert.equal(described.length, values.length,
          `${key} describes ${described.length} of ${values.length} values`)
        const short = key.replace(/^tokenPace\./, '')
        for (let i = 0; i < values.length; i++) {
          assert.equal(described[i], `%config.${short}.enum.${values[i]}%`,
            `${key}: the description at index ${i} is not the one for "${values[i]}"`)
        }
        checked++
      }
    }
  }
  assert.ok(checked >= 20, `only ${checked} enum lists checked`)
})

test('the strings a user sees first are localized, not left in the manifest', () => {
  const manifest = rawManifest as {
    displayName: string
    description: string
    contributes: {
      commands: Array<{ title: string; category?: string }>
      configuration: Array<{ title: string; properties: Record<string, Record<string, unknown>> }>
      walkthroughs: Array<{ title: string; description: string; steps: Array<{ title: string; description: string }> }>
      viewsContainers: Record<string, Array<{ title: string }>>
      views: Record<string, Array<{ name: string }>>
    }
  }
  const placeholder = (value: unknown, what: string): void => {
    assert.match(String(value), NLS_KEY, `${what} is not a %key%`)
  }
  placeholder(manifest.displayName, 'displayName')
  placeholder(manifest.description, 'description')
  for (const command of manifest.contributes.commands) {
    placeholder(command.title, `command title ${command.title}`)
    if (command.category !== undefined) placeholder(command.category, 'command category')
  }
  for (const container of Object.values(manifest.contributes.viewsContainers)) {
    for (const entry of container) placeholder(entry.title, 'view container title')
  }
  for (const view of Object.values(manifest.contributes.views)) {
    for (const entry of view) placeholder(entry.name, 'view name')
  }
  for (const walkthrough of manifest.contributes.walkthroughs) {
    placeholder(walkthrough.title, 'walkthrough title')
    placeholder(walkthrough.description, 'walkthrough description')
    for (const step of walkthrough.steps) {
      placeholder(step.title, 'walkthrough step title')
      placeholder(step.description, 'walkthrough step description')
    }
  }
  for (const section of manifest.contributes.configuration) {
    placeholder(section.title, 'configuration section title')
    for (const [key, property] of Object.entries(section.properties)) {
      for (const field of ['markdownDescription', 'description', 'deprecationMessage']) {
        if (property[field] !== undefined) placeholder(property[field], `${key}.${field}`)
      }
      const enums = property.enumDescriptions as string[] | undefined
      for (const value of enums ?? []) placeholder(value, `${key}.enumDescriptions`)
    }
  }
})

test('the resolved manifest still reads like the manifest it replaced', () => {
  // The end of the chain: what VS Code shows an English user has to be prose, not a key.
  const manifest = readManifest<{
    displayName: string
    contributes: { commands: Array<{ command: string; title: string; category?: string }> }
  }>()
  assert.equal(manifest.displayName, 'Token Pace — Claude Code & Codex')
  const dashboard = manifest.contributes.commands.find((c) => c.command === 'tokenPace.showDashboard')
  assert.equal(dashboard?.title, 'Open Dashboard')
  assert.equal(dashboard?.category, 'Token Pace')
})

test('the localized manifest is shipped — .vscodeignore excludes everything by default', () => {
  // Without an explicit negation the bundles are dropped from the .vsix and every string in
  // the store listing and the settings UI degrades to `%key%`.
  const ignore = readFileSync(join(ROOT, '.vscodeignore'), 'utf8')
  assert.match(ignore, /^!package\.nls\*\.json$/m, '.vscodeignore does not keep package.nls*.json')
})

test('a German setting description never quotes a string the runtime shows in German', () => {
  // A description that illustrates a rule with a card text has to quote the card text the
  // reader will actually see. The German file quoted the English runtime strings through 1.3,
  // which reads as a bug in the product rather than as an example.
  const bundle = JSON.parse(
    readFileSync(join(ROOT, 'l10n', 'bundle.l10n.de.json'), 'utf8'),
  ) as Record<string, string>
  let quoted = 0
  for (const [key, value] of Object.entries(germanNls)) {
    for (const m of value.matchAll(/\u201e([^\u201c]+)\u201c/g)) {
      quoted++
      assert.equal(typeof bundle[m[1]], 'undefined',
        `package.nls.de.json:${key} quotes ${JSON.stringify(m[1])}, which the German build `
        + `shows as ${JSON.stringify(bundle[m[1]])}`)
    }
  }
  assert.ok(quoted >= 10, `only ${quoted} quoted phrase(s) in package.nls.de.json`)
})

test('the keep-warm setting: a boolean, off by default, of application scope, in General after the plan names; its words follow §7a Q19 in both languages (1.8 §0b.3, §3 B2)', () => {
  const manifest = rawManifest as {
    contributes: {
      configuration: Array<{ id: string; properties: Record<string, Record<string, unknown>> }>
      commands: Array<{ command: string; title: string; category?: string }>
    }
  }
  const general = manifest.contributes.configuration.find((g) => g.id === 'tokenPace.general')
  assert.ok(general)
  const keys = Object.keys(general.properties)
  assert.equal(keys.indexOf('tokenPace.cacheKeepWarm'), keys.indexOf('tokenPace.planName') + 1)
  // A workspace's `.vscode/settings.json`, which a cloned repository brings along, cannot switch it on.
  assert.deepEqual(general.properties['tokenPace.cacheKeepWarm'], {
    type: 'boolean', order: 12, default: false, markdownDescription: '%config.cacheKeepWarm.description%', scope: 'application',
  })
  const en = englishNls['config.cacheKeepWarm.description']
  const de = germanNls['config.cacheKeepWarm.description']
  for (const claim of ['three minutes or less left', 'a one-minute countdown you can cancel', 'about two minutes before the cache expires',
    'Off by default; asks for consent first', 'switching it off withdraws the consent', 'a real request that counts against your usage',
    'text you typed but did not send is sent with it', 'automation that Anthropic\'s terms do not explicitly permit',
    'Claude Code extension\'s own panel are out of reach', 'Prompt cache page',
    // 1.8 P11: the bounds the consent names, in the description too.
    'at most three times in a row', 'at 90 % or more', 'never in Restricted Mode']) {
    assert.ok(en.includes(claim), `the setting's description does not say: ${claim}`)
  }
  for (const claim of ['drei Minuten Restzeit oder weniger', 'einminütiger Countdown, den Sie abbrechen können', 'etwa zwei Minuten vor dem Ablauf',
    'Standardmäßig aus; fragt zuerst nach Ihrer Zustimmung', 'das Abschalten zieht sie zurück', 'echte Anfrage', 'mitgesendet',
    'nicht ausdrücklich gestatten', 'außer Reichweite', 'Prompt-Cache',
    'höchstens dreimal hintereinander', 'bei 90 % oder mehr', 'nie im eingeschränkten Modus']) {
    assert.ok(de.includes(claim), `the German description does not say: ${claim}`)
  }
  // §7a Q19 replaced the spec's four minutes and fifty-five; neither is said in either language.
  for (const stale of ['four minutes', '4 minutes', '55 minutes', 'vier Minuten', '55 Minuten']) {
    assert.equal(en.includes(stale) || de.includes(stale), false, stale)
  }
  // The cancel command, in the palette under the extension's category.
  const cancel = manifest.contributes.commands.find((c) => c.command === 'tokenPace.cancelKeepWarm')
  assert.deepEqual(cancel, { command: 'tokenPace.cancelKeepWarm', title: '%command.cancelKeepWarm.title%', category: '%command.category%' })
  assert.equal(englishNls['command.cancelKeepWarm.title'], 'Cancel the Keep-Warm Line')
  assert.equal(germanNls['command.cancelKeepWarm.title'], 'Warmhalte-Zeile abbrechen')
})

test('the language setting\'s words: what switches, what follows VS Code, what stays English, who translated — in both languages; its values are the native names in every file (1.9 A1 rule 4)', () => {
  const en = englishNls['config.language.description']
  const de = germanNls['config.language.description']
  for (const claim of [
    'the status bar and its tooltips, the dashboard, the Quick Pick, the markdown document, notifications and dialogs',
    '`auto` follows VS Code\'s display language (English where Token Pace has no translation for it)',
    'The flag at the top of the dashboard sets this setting too',
    'The settings, the command titles and the walkthrough always follow VS Code\'s display language (*Configure Display Language*)',
    'VS Code reads them when it starts, so they cannot switch while it runs',
    'The debug log, the diagnostics report and the CSV and JSON exports stay English',
    'The twelve languages beyond English and German were translated by AI agents from the English text, with the German as a second reference',
    'checked by tests for completeness, placeholders and the marks ~, ⚠ and –',
    'not by native speakers',
  ]) {
    assert.ok(en.includes(claim), `the setting's description does not say: ${claim}`)
  }
  for (const claim of [
    'die Statusleiste und ihre Tooltips, das Dashboard, der Quick Pick, das Markdown-Dokument, Benachrichtigungen und Dialoge',
    '`auto` folgt der Anzeigesprache von VS Code (Englisch, wo Token Pace sie nicht übersetzt hat)',
    'Die Flagge oben im Dashboard stellt diese Einstellung ebenfalls ein',
    'Die Einstellungen, die Befehlstitel und die Einführung folgen immer der Anzeigesprache von VS Code (*Anzeigesprache konfigurieren*)',
    'VS Code liest sie beim Start, deshalb können sie nicht umschalten, solange es läuft',
    'Das Debug-Protokoll, der Diagnosebericht und die CSV- und JSON-Exporte bleiben Englisch',
    'Die zwölf Sprachen über Englisch und Deutsch hinaus haben KI-Agenten aus dem englischen Text übersetzt, mit dem Deutschen als zweiter Vorlage',
    'Tests prüfen sie auf Vollständigkeit, Platzhalter und die Zeichen ~, ⚠ und –',
    'Muttersprachler haben sie nicht geprüft',
  ]) {
    assert.ok(de.includes(claim), `the German description does not say: ${claim}`)
  }
  // No claim beyond the tests: not professional, not reviewed, not native (§3 B4).
  for (const stale of ['professional', 'reviewed by', 'native-quality', 'professionell', 'lektoriert']) {
    assert.equal(en.includes(stale) || de.includes(stale), false, stale)
  }
  assert.equal(englishNls['config.language.enum.auto'], 'Follow VS Code\'s display language (English where Token Pace has no translation for it)')
  assert.equal(germanNls['config.language.enum.auto'], 'Der Anzeigesprache von VS Code folgen (Englisch, wo Token Pace sie nicht übersetzt hat)')
  // A name is not translated: each value is the language's own name, the same in every file.
  const natives: Record<string, string> = {
    en: 'English', de: 'Deutsch', fr: 'Français', es: 'Español', 'pt-br': 'Português (Brasil)', it: 'Italiano', ja: '日本語',
    ko: '한국어', 'zh-cn': '简体中文', 'zh-tw': '繁體中文', ru: 'Русский', tr: 'Türkçe', pl: 'Polski', cs: 'Čeština',
  }
  assert.deepEqual(Object.fromEntries(LANGUAGES.map((e) => [e.id, e.native])), natives)
  for (const [name, bundle] of BUNDLES) {
    for (const [id, native] of Object.entries(natives)) {
      assert.equal(bundle[`config.language.enum.${id}`], native, `${name}: config.language.enum.${id}`)
    }
  }
})
