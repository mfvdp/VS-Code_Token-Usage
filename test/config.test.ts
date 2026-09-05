// SPDX-FileCopyrightText: 2026 Frederik Marx
// SPDX-License-Identifier: AGPL-3.0-or-later

import { test } from 'node:test'
import * as assert from 'node:assert/strict'

import {
  CONFIG_KEYS, sanitize, affects, planNameOf, planText, readTimeConfig, readPaceConfig,
  readAlertConfig,
} from '../src/config'
import type { Config } from '../src/config'
import { readManifest } from './helpers/nls'

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

/**
 * Since 1.2.0 the manifest carries `%key%` placeholders and the prose lives in
 * `package.nls.json`; these checks are about the words, so they read the resolved manifest.
 */
const pkg = readManifest<{
  contributes: { configuration: Array<{ title: string; properties: Record<string, Property> }> }
}>()

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

test('the chart model style is read as an enum with pattern as its default', () => {
  assert.ok(CONFIG_KEYS.includes('tokenPace.chart.modelStyle'))
  assert.equal(sanitize({}).chart.modelStyle, 'pattern')
  assert.equal(sanitize({ 'tokenPace.chart.modelStyle': 'shade' }).chart.modelStyle, 'shade')
  assert.equal(sanitize({ 'tokenPace.chart.modelStyle': 'both' }).chart.modelStyle, 'both')
  // A word the page has no rules for would be an unstyled chart, so it falls back.
  assert.equal(sanitize({ 'tokenPace.chart.modelStyle': 'rainbow' }).chart.modelStyle, 'pattern')
  assert.equal(sanitize({ 'tokenPace.chart.modelStyle': 3 }).chart.modelStyle, 'pattern')
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
    // Not part of AlertConfig — the budget level travels with it so `Alerts.enabled()` can
    // see it without every hand-built test config having to name it.
    budgetPercent: 0,
  })
})

test('affects() accepts keys with and without the tokenPace prefix', () => {
  const touched = new Set(['tokenPace.barWidth'])
  const event = { affectsConfiguration: (section: string) => touched.has(section) }
  assert.equal(affects(event, ['barWidth']), true)
  assert.equal(affects(event, ['tokenPace.barWidth']), true)
  assert.equal(affects(event, ['tokenPace.density', 'barWidth']), true)
  assert.equal(affects(event, ['density']), false)
  // The bare namespace means "any of our settings": VS Code answers a section prefix, so it
  // must be passed through as is — `tokenPace.tokenPace` is nothing and would never match.
  const any = { affectsConfiguration: (section: string) => 'tokenPace.barWidth'.startsWith(section) }
  assert.equal(affects(any, ['tokenPace']), true)
  const other = { affectsConfiguration: (section: string) => 'editor.fontSize'.startsWith(section) }
  assert.equal(affects(other, ['tokenPace']), false)
})

test('planName is trimmed, cut at 40 characters and otherwise dropped', () => {
  assert.deepEqual(sanitize({}).planName, {})
  assert.deepEqual(sanitize({ 'tokenPace.planName': { claude: '  Max 20x  ' } }).planName, { claude: 'Max 20x' })
  assert.deepEqual(sanitize({ 'tokenPace.planName': { claude: 'x'.repeat(60) } }).planName,
    { claude: 'x'.repeat(40) })
  // A blank name is no name, and neither is a number or a nested object.
  assert.deepEqual(sanitize({ 'tokenPace.planName': { claude: '   ', codex: 5 } }).planName, {})
  assert.deepEqual(sanitize({ 'tokenPace.planName': 'Pro' }).planName, {})
  // Keys we do not know are not carried along.
  assert.deepEqual(sanitize({ 'tokenPace.planName': { gemini: 'Ultra' } }).planName, {})
})

test('the provider outranks the setting, and a configured name says that it is one', () => {
  const cfg = sanitize({ 'tokenPace.planName': { claude: 'Max 20x' } })
  assert.deepEqual(planNameOf(cfg, 'claude', 'max20'), { name: 'max20', from: 'provider' })
  assert.deepEqual(planNameOf(cfg, 'claude', null), { name: 'Max 20x', from: 'configured' })
  // A provider field that is present but empty is not an answer.
  assert.deepEqual(planNameOf(cfg, 'claude', '   '), { name: 'Max 20x', from: 'configured' })
  assert.equal(planNameOf(cfg, 'codex', null), null)
  assert.equal(planText(null), null)
  assert.equal(planText({ name: 'max20', from: 'provider' }), 'plan max20')
  assert.equal(planText({ name: 'Max 20x', from: 'configured' }), 'plan Max 20x (as configured)')
})

test('the context entry and the context section are contributed but not switched on', () => {
  const bar = properties['tokenPace.statusBar.show'].items?.enum ?? []
  assert.ok(bar.includes('context'), 'statusBar.show cannot show the context window')
  assert.equal((properties['tokenPace.statusBar.show'].default as string[]).includes('context'), false)
  assert.deepEqual(sanitize({ 'tokenPace.statusBar.show': ['context'] }).statusBar.show, ['context'])

  const sections = properties['tokenPace.dashboard.sections'].items?.enum ?? []
  assert.ok(sections.includes('context'), 'dashboard.sections cannot show the context window')
  assert.equal((properties['tokenPace.dashboard.sections'].default as string[]).includes('context'), false)
  assert.deepEqual(sanitize({ 'tokenPace.dashboard.sections': ['context'] }).dashboard.sections, ['context'])
})

test('the tools section is contributed, off by default, and shares the topN cap', () => {
  const sections = properties['tokenPace.dashboard.sections'].items?.enum ?? []
  assert.ok(sections.includes('tools'), 'dashboard.sections cannot show the tool table')
  assert.equal((properties['tokenPace.dashboard.sections'].default as string[]).includes('tools'), false)
  assert.deepEqual(sanitize({ 'tokenPace.dashboard.sections': ['tools'] }).dashboard.sections, ['tools'])
  // One cap for both top tables, and the description has to name both of them.
  assert.match(String(properties['tokenPace.dashboard.topN'].markdownDescription), /`records` and `tools`/)
})

test('the records section is contributed, off by default, and capped by dashboard.topN', () => {
  const sections = properties['tokenPace.dashboard.sections'].items?.enum ?? []
  assert.ok(sections.includes('records'), 'dashboard.sections cannot show the records')
  assert.equal((properties['tokenPace.dashboard.sections'].default as string[]).includes('records'), false)
  assert.deepEqual(sanitize({ 'tokenPace.dashboard.sections': ['records'] }).dashboard.sections, ['records'])

  assert.equal(sanitize({}).dashboard.topN, 5)
  assert.equal(sanitize({ 'tokenPace.dashboard.topN': 12 }).dashboard.topN, 12)
  // A top list of half a row does not exist; the value is a whole number of rows.
  assert.equal(sanitize({ 'tokenPace.dashboard.topN': 7.6 }).dashboard.topN, 7)
  // Out of range and nonsense both fall back to the documented bounds rather than to zero,
  // which would be a table that lists nothing while the section promises rows.
  assert.equal(sanitize({ 'tokenPace.dashboard.topN': 0 }).dashboard.topN, 1)
  assert.equal(sanitize({ 'tokenPace.dashboard.topN': 400 }).dashboard.topN, 20)
  assert.equal(sanitize({ 'tokenPace.dashboard.topN': 'many' }).dashboard.topN, 5)
})

test('the budget section and entry are contributed but not switched on', () => {
  const bar = properties['tokenPace.statusBar.show'].items?.enum ?? []
  assert.ok(bar.includes('budget'), 'statusBar.show cannot show a budget')
  assert.equal((properties['tokenPace.statusBar.show'].default as string[]).includes('budget'), false)
  assert.deepEqual(sanitize({ 'tokenPace.statusBar.show': ['budget'] }).statusBar.show, ['budget'])

  const sections = properties['tokenPace.dashboard.sections'].items?.enum ?? []
  assert.ok(sections.includes('budget'), 'dashboard.sections cannot show the budgets')
  assert.equal((properties['tokenPace.dashboard.sections'].default as string[]).includes('budget'), false)
  assert.deepEqual(sanitize({ 'tokenPace.dashboard.sections': ['budget'] }).dashboard.sections, ['budget'])
})

test('a budget the user did not state does not exist, and a broken one is dropped whole', () => {
  assert.deepEqual(sanitize({}).budgets, [])
  const cfg = sanitize({
    'tokenPace.budgets': [
      { scope: 'total', period: 'month', unit: 'usd', limit: 200 },
      // Each of these is unusable in a different way; not one of them may be repaired into a
      // number Token Pace invented.
      { scope: 'anthropic', period: 'month', unit: 'usd', limit: 200 },
      { scope: 'claude', period: 'fortnight', unit: 'usd', limit: 200 },
      { scope: 'claude', period: 'day', unit: 'euro', limit: 200 },
      { scope: 'claude', period: 'day', unit: 'tokens', limit: 0 },
      { scope: 'claude', period: 'day', unit: 'tokens' },
      'not an object',
      { scope: 'claude', period: 'day', unit: 'tokens', limit: 5_000_000, label: '  Daily cap  ' },
    ],
  })
  assert.deepEqual(cfg.budgets, [
    { scope: 'total', period: 'month', unit: 'usd', limit: 200 },
    { scope: 'claude', period: 'day', unit: 'tokens', limit: 5_000_000, label: 'Daily cap' },
  ])
})

test('the budget alert level is off by default and clamped to the range the manifest shows', () => {
  assert.equal(sanitize({}).alerts.budgetPercent, 0)
  assert.equal(readAlertConfig(sanitize({})).budgetPercent, 0)
  assert.equal(sanitize({ 'tokenPace.alerts.budgetPercent': 80 }).alerts.budgetPercent, 80)
  assert.equal(sanitize({ 'tokenPace.alerts.budgetPercent': 900 }).alerts.budgetPercent, 200)
  assert.equal(sanitize({ 'tokenPace.alerts.budgetPercent': -5 }).alerts.budgetPercent, 0)
  assert.equal(sanitize({ 'tokenPace.alerts.budgetPercent': 'lots' }).alerts.budgetPercent, 0)
  assert.equal(properties['tokenPace.alerts.budgetPercent'].default, 0)
})
