// SPDX-FileCopyrightText: 2026 Frederik Marx
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The table behind the gear in every section header.
 *
 * A settings query is only useful while every id in it still exists: `@id:` filters the
 * editor down to exactly the ids it names, so a renamed or dropped setting turns the gear
 * into a button that opens an empty settings page. The manifest is therefore read here and
 * every id checked against it, the same way the README rows are checked.
 */

import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { SECTION_SETTINGS, sectionSettingsQuery } from '../src/sectionSettings'
import { DASHBOARD_SECTION_KEYS } from '../src/viewModel'
import { rawManifest } from './helpers/nls'

const CONFIGURATION = (rawManifest as {
  contributes: { configuration: Array<{ properties?: Record<string, unknown> }> }
}).contributes.configuration

const DECLARED = new Set<string>()
for (const group of CONFIGURATION) {
  for (const id of Object.keys(group.properties ?? {})) DECLARED.add(id)
}

test('every section the panel folds has settings behind its gear', () => {
  for (const key of DASHBOARD_SECTION_KEYS) {
    const list = SECTION_SETTINGS[key]
    assert.ok(Array.isArray(list) && list.length > 0, `${key} has no settings`)
    // Whichever section is on screen, "should this be here at all" is a question about it.
    assert.equal(list[list.length - 1], 'tokenPace.dashboard.sections', key)
    assert.equal(new Set(list).size, list.length, `${key} names a setting twice`)
  }
  // Nothing beyond the sections themselves: a key here that the panel does not render would
  // be a gear nobody can reach.
  assert.deepEqual(Object.keys(SECTION_SETTINGS).sort(), [...DASHBOARD_SECTION_KEYS].sort())
})

test('every id behind a gear is a setting the manifest really contributes', () => {
  assert.ok(DECLARED.size > 50, `only ${DECLARED.size} settings were read from the manifest`)
  for (const [key, list] of Object.entries(SECTION_SETTINGS)) {
    for (const id of list) {
      assert.match(id, /^tokenPace\./, `${key}: ${id}`)
      // No exception for any id: one that is renamed or dropped turns its gear into a button
      // that opens an empty settings page, which is exactly what this reads the manifest for.
      assert.ok(DECLARED.has(id), `${key}: ${id} is not in contributes.configuration`)
    }
  }
})

test('the query is the @id: filter the settings editor understands', () => {
  const q = sectionSettingsQuery('tools')
  assert.equal(q, '@id:tokenPace.retentionDays,tokenPace.dashboard.sections')
  // One filter, not a search term: no spaces, and every id inside it.
  for (const key of DASHBOARD_SECTION_KEYS) {
    const query = sectionSettingsQuery(key)
    assert.ok(query.startsWith('@id:'), query)
    assert.equal(/\s/.test(query), false, query)
    for (const id of SECTION_SETTINGS[key]) assert.ok(query.includes(id), `${key}: ${id}`)
  }
})
