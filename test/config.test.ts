// SPDX-FileCopyrightText: 2026 Frederik Marx
// SPDX-License-Identifier: AGPL-3.0-or-later

import { test } from 'node:test'
import * as assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { CONFIG_KEYS, sanitize, affects, readTimeConfig, readPaceConfig, readAlertConfig } from '../src/config'
import type { Config } from '../src/config'

interface Property {
  type?: string | string[]
  default?: unknown
  enum?: string[]
  minimum?: number
  maximum?: number
  scope?: string
  order?: number
  markdownDescription?: string
  description?: string
  deprecationMessage?: string
  items?: { enum?: string[] }
}

const pkg = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf8')) as {
  contributes: { configuration: Array<{ title: string; properties: Record<string, Property> }> }
}

const sections = pkg.contributes.configuration
const properties: Record<string, Property> = {}
for (const section of sections) for (const [key, value] of Object.entries(section.properties)) properties[key] = value

/** Reads `tokenPace.a.b` out of the Config object as `cfg.a.b`. */
function byPath(cfg: Config, key: string): unknown {
  let cur: unknown = cfg
  for (const part of key.replace(/^tokenPace\./, '').split('.')) {
    if (cur === null || typeof cur !== 'object') return undefined
    cur = (cur as Record<string, unknown>)[part]
  }
  return cur
}

test('contributes.configuration is an array of named sections', () => {
  assert.ok(Array.isArray(sections), 'configuration must be an array of sections')
  assert.ok(sections.length >= 8, 'expected the sections of spec §4.2')
  for (const section of sections) assert.ok(section.title.length > 0)
})

test('every key config.ts reads is contributed by the manifest', () => {
  for (const key of CONFIG_KEYS) {
    assert.ok(properties[key], `CONFIG_KEYS has ${key}, but package.json does not contribute it`)
  }
})

test('every contributed key is read by config.ts (except the deprecated tokenPace.windows)', () => {
  for (const key of Object.keys(properties)) {
    if (key === 'tokenPace.windows') continue
    assert.ok(CONFIG_KEYS.includes(key), `package.json contributes ${key}, but config.ts never reads it`)
  }
})

test('CONFIG_KEYS has no duplicates', () => {
  assert.equal(new Set(CONFIG_KEYS).size, CONFIG_KEYS.length)
})

test('every property carries an order and a description', () => {
  for (const [key, property] of Object.entries(properties)) {
    assert.equal(typeof property.order, 'number', `${key} has no order`)
    assert.ok(property.markdownDescription || property.description, `${key} has no description`)
  }
})

test('path and binary settings are machine-scoped', () => {
  const machine = [
    'tokenPace.claudeDir', 'tokenPace.codexDir', 'tokenPace.claudeQuotaFile',
    'tokenPace.codexQuotaFile', 'tokenPace.codexBinary', 'tokenPace.debugLogFile',
  ]
  for (const key of machine) assert.equal(properties[key].scope, 'machine', `${key} must be machine-scoped`)
})

test('settings that can reach the credentials are machine-scoped too', () => {
  // A workspace must not be able to switch on fetching, redirect the cache write, change
  // the User-Agent or open the OS keychain — those decisions belong to the machine.
  const machine = [
    'tokenPace.quotaSource', 'tokenPace.writeQuotaCache',
    'tokenPace.userAgent', 'tokenPace.credentials.keychain',
  ]
  for (const key of machine) assert.equal(properties[key].scope, 'machine', `${key} must be machine-scoped`)
})

test('the deprecated setting sits behind everything else in its section', () => {
  assert.equal(properties['tokenPace.windows'].order, 99)
})

test('tokenPace.windows is marked deprecated and points at windowSelect', () => {
  const property = properties['tokenPace.windows']
  assert.ok(property.deprecationMessage, 'tokenPace.windows must carry a deprecationMessage')
  assert.match(property.deprecationMessage as string, /windowSelect/)
})

test('an empty configuration produces exactly the manifest defaults', () => {
  const cfg = sanitize({})
  for (const [key, property] of Object.entries(properties)) {
    if (!('default' in property)) continue
    // The two multi-root path settings accept a string and normalise to a list.
    if (key === 'tokenPace.claudeDir' || key === 'tokenPace.codexDir') {
      assert.deepEqual(byPath(cfg, key), [], `${key} should normalise its "" default to []`)
      continue
    }
    assert.deepEqual(byPath(cfg, key), property.default, `${key} default drifted from the manifest`)
  }
})

test('numbers: non-numeric input falls back, out-of-range input clamps', () => {
  for (const [key, property] of Object.entries(properties)) {
    if (property.type !== 'number') continue
    const { minimum, maximum } = property
    assert.equal(typeof minimum, 'number', `${key} has no minimum`)
    assert.equal(typeof maximum, 'number', `${key} has no maximum`)

    // The hand-edited "10m" that used to freeze a timer for a whole session.
    assert.deepEqual(byPath(sanitize({ [key]: '10m' }), key), property.default, `${key} did not fall back`)
    assert.deepEqual(byPath(sanitize({ [key]: NaN }), key), property.default, `${key} accepted NaN`)
    assert.deepEqual(byPath(sanitize({ [key]: Infinity }), key), property.default, `${key} accepted Infinity`)

    assert.equal(byPath(sanitize({ [key]: (minimum as number) - 1000 }), key), minimum, `${key} did not clamp low`)
    assert.equal(byPath(sanitize({ [key]: (maximum as number) + 1000 }), key), maximum, `${key} did not clamp high`)
  }
})

test('enums: an unknown value falls back to the default, a known one is kept', () => {
  for (const [key, property] of Object.entries(properties)) {
    if (!property.enum || property.type !== 'string') continue
    assert.deepEqual(byPath(sanitize({ [key]: 'nonsense' }), key), property.default, `${key} kept a bad enum value`)
    for (const value of property.enum) {
      if (key === 'tokenPace.windows') continue // folded into windowSelect, checked separately
      assert.equal(byPath(sanitize({ [key]: value }), key), value, `${key} rejected the valid value ${value}`)
    }
  }
})

test('arrays keep the user order, drop unknowns and drop duplicates', () => {
  const cfg = sanitize({
    'tokenPace.statusBar.show': ['cost', 'tokens', 'cost', 'nope', 42, 'claudeQuota'],
  })
  assert.deepEqual(cfg.statusBar.show, ['cost', 'tokens', 'claudeQuota'])

  // The order is the display order, so it must survive verbatim.
  const reversed = sanitize({ 'tokenPace.dashboard.sections': ['models', 'quota'] })
  assert.deepEqual(reversed.dashboard.sections, ['models', 'quota'])

  // An empty list is a legitimate choice (it hides the status bar), not a broken value.
  assert.deepEqual(sanitize({ 'tokenPace.statusBar.show': [] }).statusBar.show, [])

  // A non-array falls back to the default rather than to nothing.
  assert.deepEqual(sanitize({ 'tokenPace.statusBar.show': 'tokens' }).statusBar.show,
    ['claudeQuota', 'codexQuota', 'tokens'])

  assert.deepEqual(
    sanitize({ 'tokenPace.claudeQuotaSources': ['poll', 'cacheFile', 'poll'] }).claudeQuotaSources,
    ['poll', 'cacheFile'],
  )
})

test('legacy tokenPace.windows is honoured only while windowSelect is at its default', () => {
  assert.equal(sanitize({ 'tokenPace.windows': 'leading' }).windowSelect, 'leading')
  // Presence decides, not the value: 'worstPace' is the 1.1 default *and* a value people
  // write out, and an explicit one must win over the deprecated setting either way.
  assert.equal(sanitize({ 'tokenPace.windows': 'leading', 'tokenPace.windowSelect': 'worstPace' }).windowSelect, 'worstPace')
  assert.equal(sanitize({ 'tokenPace.windows': 'leading', 'tokenPace.windowSelect': 'all' }).windowSelect, 'all')
  // A value that is not a WindowSelect is not a choice — the legacy setting speaks again.
  assert.equal(sanitize({ 'tokenPace.windows': 'leading', 'tokenPace.windowSelect': 'garbage' }).windowSelect, 'leading')
  assert.equal(sanitize({ 'tokenPace.windows': 'leading', 'tokenPace.windowSelect': 'weekly' }).windowSelect, 'weekly')
  assert.equal(sanitize({ 'tokenPace.windows': 'all', 'tokenPace.windowSelect': 'all' }).windowSelect, 'all')
  // The raw legacy value stays readable for diagnostics.
  assert.equal(sanitize({ 'tokenPace.windows': 'leading' }).windows, 'leading')
  assert.equal(sanitize({ 'tokenPace.windows': 'garbage' }).windows, 'all')
})

test('path settings accept a string or a list and always yield a trimmed list', () => {
  assert.deepEqual(sanitize({ 'tokenPace.claudeDir': '  ~/.claude  ' }).claudeDir, ['~/.claude'])
  assert.deepEqual(sanitize({ 'tokenPace.claudeDir': ['~/a', '', '  ', '~/b', '~/a'] }).claudeDir, ['~/a', '~/b'])
  assert.deepEqual(sanitize({ 'tokenPace.codexDir': 42 }).codexDir, [])
  assert.deepEqual(sanitize({ 'tokenPace.codexDir': ['~/x', 7, null] }).codexDir, ['~/x'])
  // Single-file path settings stay strings, trimmed.
  assert.equal(sanitize({ 'tokenPace.claudeQuotaFile': ' /tmp/q.json ' }).claudeQuotaFile, '/tmp/q.json')
  assert.equal(sanitize({ 'tokenPace.codexBinary': 17 }).codexBinary, '')
})

test('customPrices keeps only finite, non-negative numeric fields', () => {
  const cfg = sanitize({
    'tokenPace.customPrices': {
      'gpt-5.6-sol': { input: 4, output: 20, cacheRead: 0.4, cacheWrite5m: 0, cacheWrite1h: 0, fast: { input: 8, output: 40 } },
      'bad-model': { input: '4', output: NaN, cacheRead: -1 },
      'partial': { output: 3, unknownField: 9 },
      '': { input: 1 },
      'not-an-object': 5,
    },
  })
  assert.deepEqual(cfg.customPrices['gpt-5.6-sol'],
    { input: 4, output: 20, cacheRead: 0.4, cacheWrite5m: 0, cacheWrite1h: 0, fast: { input: 8, output: 40 } })
  assert.equal(cfg.customPrices['bad-model'], undefined, 'a model without a single usable rate is dropped')
  assert.deepEqual(cfg.customPrices['partial'], { output: 3 })
  assert.equal(cfg.customPrices[''], undefined)
  assert.equal(cfg.customPrices['not-an-object'], undefined)
  assert.deepEqual(sanitize({ 'tokenPace.customPrices': 'nope' }).customPrices, {})
})

test('labels are strings capped at 40 characters, planPriceUsd only finite positives', () => {
  const long = 'x'.repeat(60)
  const cfg = sanitize({
    'tokenPace.labels': { claude: 'CC', 'claude:session:300': long, bad: 5, '': 'x' },
    'tokenPace.planPriceUsd': { claude: 100, codex: -20, other: 5 },
  })
  assert.equal(cfg.labels['claude'], 'CC')
  assert.equal(cfg.labels['claude:session:300'].length, 40)
  assert.equal(cfg.labels['bad'], undefined)
  assert.equal(cfg.labels[''], undefined)
  assert.deepEqual(cfg.planPriceUsd, { claude: 100 })
})

test('alert thresholds are finite, in range, deduplicated and ascending', () => {
  const cfg = sanitize({ 'tokenPace.alerts.thresholds': [95, 80, 95, 0, -3, NaN, 'x', 500, 120] })
  assert.deepEqual(cfg.alerts.thresholds, [80, 95, 120])
  // One threshold out of the box …
  assert.deepEqual(sanitize({}).alerts.thresholds, [90])
  // … and an explicit empty list is still the way to switch notifications off entirely.
  assert.deepEqual(sanitize({ 'tokenPace.alerts.thresholds': [] }).alerts.thresholds, [])
  // A hand-edited non-array is not a choice, so it falls back to the default rather than off.
  assert.deepEqual(sanitize({ 'tokenPace.alerts.thresholds': '90' }).alerts.thresholds, [90])
})

test('the defaults that changed in 1.1 are the ones the manifest advertises', () => {
  const cfg = sanitize({})
  assert.equal(cfg.windowSelect, 'worstPace')
  assert.equal(cfg.clickAction, 'dashboard')
  assert.equal(cfg.tooltipExplanations, false)
  assert.deepEqual(cfg.alerts.thresholds, [90])
  assert.equal(cfg.density, 'full')
  // The keybinding switch is read by VS Code through its when-clause; we only validate it.
  assert.equal(cfg.keybindings, true)
  assert.equal(sanitize({ 'tokenPace.keybindings': false }).keybindings, false)
  assert.equal(sanitize({ 'tokenPace.keybindings': 'no' }).keybindings, true)
})

test('the structural sub-configs mirror the settings', () => {
  const cfg = sanitize({
    'tokenPace.timezone': 'Europe/Berlin',
    'tokenPace.dayBoundaryHour': 4,
    'tokenPace.startOfWeek': 'sunday',
    'tokenPace.resetHourCycle': 'h23',
    'tokenPace.pace.sensitivity': 'strict',
    'tokenPace.pace.levels': 'graded',
    'tokenPace.alerts.thresholds': [90],
    'tokenPace.alerts.windowCondition': 'weeklyOnly',
  })
  assert.deepEqual(readTimeConfig(cfg),
    { zone: 'Europe/Berlin', dayBoundaryHour: 4, startOfWeek: 'sunday', hourCycle: 'h23' })
  assert.deepEqual(readPaceConfig(cfg),
    { sensitivity: 'strict', tolerancePoints: 5, minElapsedPercent: 3, levels: 'graded' })
  assert.deepEqual(readAlertConfig(cfg), {
    thresholds: [90], basis: 'used', requireAhead: true, minRemainingMinutes: 60,
    useItLoseIt: false, forecastLeadMinutes: 0, onPaceFast: false, windowCondition: 'weeklyOnly',
  })
})

test('affects() accepts keys with and without the tokenPace prefix', () => {
  const touched = new Set(['tokenPace.barWidth'])
  const event = { affectsConfiguration: (section: string) => touched.has(section) }
  assert.equal(affects(event, ['barWidth']), true)
  assert.equal(affects(event, ['tokenPace.barWidth']), true)
  assert.equal(affects(event, ['tokenPace.density', 'barWidth']), true)
  assert.equal(affects(event, ['density']), false)
})
