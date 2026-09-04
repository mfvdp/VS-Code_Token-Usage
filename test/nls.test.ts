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
 * The German file is checked against the English one for exactly that structure, not for
 * wording. No file outside the repository is touched.
 */

import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { englishNls, germanNls, manifestKeys, NLS_KEY, rawManifest, readManifest, ROOT } from './helpers/nls'

const BUNDLES: Array<[string, Record<string, string>]> = [
  ['package.nls.json', englishNls],
  ['package.nls.de.json', germanNls],
]

const used = manifestKeys()

test('the manifest actually uses placeholders, and every one of them resolves in both bundles', () => {
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

test('neither bundle carries a key the manifest does not use', () => {
  const inUse = new Set(used)
  for (const [name, bundle] of BUNDLES) {
    for (const key of Object.keys(bundle)) {
      assert.ok(inUse.has(key), `${name} defines ${key}, which package.json never uses`)
    }
  }
})

test('the German bundle has every key of the English one, and no other', () => {
  assert.deepEqual(Object.keys(germanNls), Object.keys(englishNls))
})

test('German is German — no entry is a forgotten copy of the English prose', () => {
  // Short labels legitimately match (“Token Pace”, “Codex”, “Dashboard”); a whole paragraph
  // that matches is an untranslated string, not a coincidence.
  for (const [key, english] of Object.entries(englishNls)) {
    if (english.length < 40) continue
    assert.notEqual(germanNls[key], english, `${key} is still the English text`)
  }
})

test('every translation keeps the links and examples that do something', () => {
  const settingLinks = (s: string): string[] => [...s.matchAll(/#(tokenPace\.[\w.]+)#/g)].map((m) => m[1]).sort()
  const commandLinks = (s: string): string[] => [...s.matchAll(/\(command:([\w.]+)\)/g)].map((m) => m[1]).sort()
  const fences = (s: string): number => (s.match(/```/g) ?? []).length
  for (const [key, english] of Object.entries(englishNls)) {
    const german = germanNls[key]
    assert.deepEqual(settingLinks(german), settingLinks(english), `${key} lost or invented a setting link`)
    assert.deepEqual(commandLinks(german), commandLinks(english), `${key} lost or invented a command link`)
    assert.equal(fences(german), fences(english), `${key} lost a fenced example`)
    // The paragraph structure is what the settings UI lays out; a merged paragraph reads as
    // one wall of text in that language only.
    assert.equal(german.split('\n\n').length, english.split('\n\n').length, `${key} changed its paragraphs`)
  }
})

test('the JSON examples inside a translation keep their setting keys and values', () => {
  // A translated `"claude"` or a translated number would be a broken example: users paste it.
  const blocks = (s: string): string[] => [...s.matchAll(/```json\n([\s\S]*?)```/g)].map((m) => m[1])
  for (const [key, english] of Object.entries(englishNls)) {
    assert.deepEqual(blocks(germanNls[key]), blocks(english), `${key} translated a JSON example`)
  }
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
