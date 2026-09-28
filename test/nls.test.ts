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

test('the language setting\'s words: what switches, what follows VS Code, what stays English, who translated — twenty-seven languages since 1.13 — in both languages; its values are the native names in every file, the twelve of 1.11 after cs, the three of 1.13 after ro (1.9 A1 rule 4; 1.11 A2; 1.13 A1 rule 2)', () => {
  const en = englishNls['config.language.description']
  const de = germanNls['config.language.description']
  for (const claim of [
    // Review 2 F7 (pinned and changed): the in-editor popups are alerts since 1.12 (C0) — alerts, notifications and dialogs.
    'the status bar and its tooltips, the dashboard, the Quick Pick, the markdown document, alerts, notifications and dialogs',
    '`auto` follows VS Code\'s display language (English where Token Pace has no translation for it)',
    'The flag at the top of the dashboard sets this setting too',
    'The settings, the command titles and the walkthrough always follow VS Code\'s display language (*Configure Display Language*)',
    'VS Code reads them when it starts, so they cannot switch while it runs',
    'The debug log, the diagnostics report and the CSV and JSON exports stay English',
    // 1.11 A2 rule 3 (pinned and changed: twelve): the languages beyond English and German are twenty-four; 1.13 A1 rule 2
    // (pinned and changed: twenty-four): twenty-seven — the rest of the paragraph word for word.
    'The twenty-seven languages beyond English and German were translated by AI agents from the English text, with the German as a second reference',
    'checked by tests for completeness, placeholders and the marks ~, ⚠ and –',
    'not by native speakers',
  ]) {
    assert.ok(en.includes(claim), `the setting's description does not say: ${claim}`)
  }
  for (const claim of [
    // Review 2 F7: „Benachrichtigung“ names only the outbound message since 1.12 (§6) — the in-editor ones are Warnhinweise.
    'die Statusleiste und ihre Tooltips, das Dashboard, der Quick Pick, das Markdown-Dokument, Warnhinweise, Benachrichtigungen und Dialoge',
    '`auto` folgt der Anzeigesprache von VS Code (Englisch, wo Token Pace sie nicht übersetzt hat)',
    'Die Flagge oben im Dashboard stellt diese Einstellung ebenfalls ein',
    'Die Einstellungen, die Befehlstitel und die Einführung folgen immer der Anzeigesprache von VS Code (*Anzeigesprache konfigurieren*)',
    'VS Code liest sie beim Start, deshalb können sie nicht umschalten, solange es läuft',
    'Das Debug-Protokoll, der Diagnosebericht und die CSV- und JSON-Exporte bleiben Englisch',
    'Die siebenundzwanzig Sprachen über Englisch und Deutsch hinaus haben KI-Agenten aus dem englischen Text übersetzt, mit dem Deutschen als zweiter Vorlage',
    'Tests prüfen sie auf Vollständigkeit, Platzhalter und die Zeichen ~, ⚠ und –',
    'Muttersprachler haben sie nicht geprüft',
  ]) {
    assert.ok(de.includes(claim), `the German description does not say: ${claim}`)
  }
  // No claim beyond the tests: not professional, not reviewed, not native (§3 B4).
  for (const stale of ['professional', 'reviewed by', 'native-quality', 'professionell', 'lektoriert', 'The twelve languages', 'Die zwölf Sprachen',
    'The twenty-four languages', 'Die vierundzwanzig Sprachen']) {
    assert.equal(en.includes(stale) || de.includes(stale), false, stale)
  }
  assert.equal(englishNls['config.language.enum.auto'], 'Follow VS Code\'s display language (English where Token Pace has no translation for it)')
  assert.equal(germanNls['config.language.enum.auto'], 'Der Anzeigesprache von VS Code folgen (Englisch, wo Token Pace sie nicht übersetzt hat)')
  // A name is not translated: each value is the language's own name, the same in every file.
  const natives: Record<string, string> = {
    en: 'English', de: 'Deutsch', fr: 'Français', es: 'Español', 'pt-br': 'Português (Brasil)', it: 'Italiano', ja: '日本語',
    ko: '한국어', 'zh-cn': '简体中文', 'zh-tw': '繁體中文', ru: 'Русский', tr: 'Türkçe', pl: 'Polski', cs: 'Čeština',
    // 1.11 §2.1: the twelve of tier 2 — Norwegian is "Norsk" (§7a Q12).
    nl: 'Nederlands', uk: 'Українська', sv: 'Svenska', nb: 'Norsk', da: 'Dansk', fi: 'Suomi', hi: 'हिन्दी', id: 'Bahasa Indonesia',
    vi: 'Tiếng Việt', el: 'Ελληνικά', hu: 'Magyar', ro: 'Română',
    // 1.13 §2.1: the three of 1.13 — Persian's with FARSI YEH (U+06CC), the registry's test pins the code points.
    ar: 'العربية', he: 'עברית', fa: 'فارسی',
  }
  assert.deepEqual(Object.fromEntries(LANGUAGES.map((e) => [e.id, e.native])), natives)
  // In the English file's order: auto, then the registry's — the twelve of 1.11 right after cs, the three of 1.13 right
  // after ro, as package.json lists them.
  const order = Object.keys(englishNls).filter((k) => k.startsWith('config.language.enum.'))
  assert.deepEqual(order, ['auto', ...LANGUAGES.map((e) => e.id)].map((id) => `config.language.enum.${id}`))
  for (const [name, bundle] of BUNDLES) {
    for (const [id, native] of Object.entries(natives)) {
      assert.equal(bundle[`config.language.enum.${id}`], native, `${name}: config.language.enum.${id}`)
    }
  }
})

test('the Prompts section\'s four manifest rows: its enum value with its words, the restore command, the paragraph of the sections setting and the statement on what Token Pace types — in both languages (1.10 §3 A6)', () => {
  const manifest = rawManifest as { contributes: { commands: Array<{ command: string; title: string; category?: string }> } }
  const restore = manifest.contributes.commands.find((c) => c.command === 'tokenPace.restoreDefaultPrompts')
  assert.deepEqual(restore, { command: 'tokenPace.restoreDefaultPrompts', title: '%command.restoreDefaultPrompts.title%', category: '%command.category%' })
  assert.equal(englishNls['command.restoreDefaultPrompts.title'], 'Restore Default Prompts')
  assert.equal(germanNls['command.restoreDefaultPrompts.title'], 'Standard-Prompts wiederherstellen')
  assert.equal(englishNls['config.dashboard.sections.enum.prompts'],
    'Your own prompts, starting with three shipped ones — a double-click types one into the terminal that runs Claude Code or Codex and presses Enter. Not in the default')
  assert.equal(germanNls['config.dashboard.sections.enum.prompts'],
    'Ihre eigenen Prompts, zu Beginn drei mitgelieferte — ein Doppelklick tippt einen davon in das Terminal, in dem Claude Code oder Codex läuft, und drückt die Eingabetaste. Nicht in der Voreinstellung')
  // The sections setting's last paragraph, added.
  assert.ok(englishNls['config.dashboard.sections.description'].endsWith('\n\n`prompts` — your own prompts for Claude Code\'s and Codex\'s terminals — is not in the default: add it where you want it, first for the quickest reach.'))
  assert.ok(germanNls['config.dashboard.sections.description'].endsWith('\n\n`prompts` — Ihre eigenen Prompts für die Terminals von Claude Code und Codex — ist nicht in der Voreinstellung: Fügen Sie ihn dort ein, wo Sie ihn haben möchten, zuoberst für den schnellsten Zugriff.'))
  // What Restricted Mode stops: both things Token Pace types — a prompt by each of the three ways it is sent (Review 2 F4).
  assert.ok(englishNls['capabilities.untrustedWorkspaces'].endsWith('each behind its own consent dialog. It types into a terminal in two cases only: the opt-in keep-warm line into Claude Code\'s terminal, and a prompt of the dashboard\'s Prompts section when you send it yourself — a double-click, its send button or Ctrl+Enter. All of these are disabled in Restricted Mode.'))
  assert.ok(germanNls['capabilities.untrustedWorkspaces'].endsWith('jede hinter einem eigenen Zustimmungsdialog. In ein Terminal tippt es nur in zwei Fällen: die optionale Warmhalte-Zeile in das Terminal von Claude Code und einen Prompt aus dem Abschnitt Prompts des Dashboards, wenn Sie ihn selbst senden — per Doppelklick, mit seiner Sende-Schaltfläche oder mit Strg+Eingabe. All das ist im eingeschränkten Modus abgeschaltet.'))
  // The German key names follow VS Code's (§6): Eingabetaste, never „Enter-Taste".
  assert.equal(germanNls['config.dashboard.sections.enum.prompts'].includes('Enter'), false)
})

test('the Records rows of the manifest name the four tables of 1.11 — the records value of the sections setting and topN\'s first paragraph, its second unchanged — in both languages (1.11 B5, B7)', () => {
  assert.equal(englishNls['config.dashboard.sections.enum.records'],
    'Records of the selected range: peak day, longest streak with usage, the top models, projects and sessions, the most expensive days, the longest and largest Claude Code sessions, and the hours with the most cache written')
  assert.equal(germanNls['config.dashboard.sections.enum.records'],
    'Rekorde des gewählten Zeitraums: Spitzentag, längste Strecke mit Verbrauch, die stärksten Modelle, Projekte und Sitzungen, die teuersten Tage, die längsten und größten Claude-Code-Sitzungen sowie die Stunden mit dem meisten Cache-Schreiben')
  const [en, en2, ...enRest] = englishNls['config.dashboard.topN.description'].split('\n\n')
  const [de, de2, ...deRest] = germanNls['config.dashboard.topN.description'].split('\n\n')
  assert.deepEqual([enRest, deRest], [[], []])
  assert.equal(en, 'How many rows each table of the `records` and `tools` sections of `#tokenPace.dashboard.sections#` shows — top models, projects, sessions and tools, the most expensive days, the longest and largest sessions and the hours with the most cache written.')
  assert.equal(de, 'Wie viele Zeilen jede Tabelle der Abschnitte `records` und `tools` von `#tokenPace.dashboard.sections#` zeigt — die stärksten Modelle, Projekte, Sitzungen und Tools, die teuersten Tage, die längsten und größten Sitzungen und die Stunden mit dem meisten Cache-Schreiben.')
  assert.equal(en2, 'A cap on what is *listed*, never on what is counted: the shares beside the rows are shares of everything in the range.')
  assert.equal(de2, 'Eine Grenze für das, was *aufgelistet* wird, nie für das, was gezählt wird: die Anteile neben den Zeilen sind Anteile an allem im Zeitraum.')
})

test('the auto hour cycle says what the code reads — the operating system\'s clock format, the locale the extension host runs under, not the language of the texts — in both languages (1.11 D9)', () => {
  assert.equal(englishNls['config.resetHourCycle.enum.auto'],
    'Follow the operating system\'s clock format (the locale the extension host runs under), not the language of Token Pace\'s texts')
  assert.equal(germanNls['config.resetHourCycle.enum.auto'],
    'Dem Uhrzeitformat des Betriebssystems folgen (dem Gebietsschema, unter dem der Erweiterungshost läuft), nicht der Sprache der Texte von Token Pace')
  // 1.10's words named the display language, which `auto` never read.
  assert.equal(englishNls['config.resetHourCycle.enum.auto'].includes('display'), false)
  assert.equal(germanNls['config.resetHourCycle.enum.auto'].includes('Anzeigesprache'), false)
  // What the value claims: time.ts asks Intl without a locale tag — the host's default locale, not the words' language.
  assert.ok(readFileSync(join(ROOT, 'src', 'time.ts'), 'utf8').includes("new Intl.DateTimeFormat(undefined, { hour: 'numeric' }).resolvedOptions().hourCycle"),
    'the hour cycle of auto is read another way: say so in config.resetHourCycle.enum.auto')
})
