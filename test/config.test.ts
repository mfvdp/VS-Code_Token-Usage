// SPDX-FileCopyrightText: 2026 Frederik Marx
// SPDX-License-Identifier: AGPL-3.0-or-later

import { test } from 'node:test'
import * as assert from 'node:assert/strict'

import {
  CONFIG_KEYS, sanitize, affects, planNameOf, planText, readTimeConfig, readPaceConfig,
  readAlertConfig, readNotifyConfig, httpsOnly, notifyOnly, NOTIFY_CONFIG_KEYS,
} from '../src/config'
import type { Config } from '../src/config'
import { englishNls, germanNls, readJson, readManifest } from './helpers/nls'

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
  items?: { enum?: string[]; enumDescriptions?: string[] }
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
  // Review 2 F9 (pinned and changed): nor keep a child running — with `persistent` the default, a workspace's
  // settings could otherwise override a reader's `oneShot`.
  const machine = [
    'tokenPace.quotaSource', 'tokenPace.writeQuotaCache',
    'tokenPace.userAgent', 'tokenPace.credentials.keychain', 'tokenPace.codexAppServer.mode',
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
  // … and an explicit empty list is still the way to switch alerts off entirely.
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
  // No band unless one is set: a window ahead of pace is coloured at once.
  assert.deepEqual(readPaceConfig(cfg),
    { sensitivity: 'strict', tolerancePoints: 0, minElapsedPercent: 3, levels: 'graded' })
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

test('planName is one line of plain text — no backtick, no control character', () => {
  // The status-bar tooltip prints the name inside a code span, so a backtick in the value
  // used to close that span and hand the rest of the tooltip to the user's markup.
  assert.deepEqual(sanitize({ 'tokenPace.planName': { claude: 'Max `20x`' } }).planName,
    { claude: 'Max 20x' })
  assert.deepEqual(sanitize({ 'tokenPace.planName': { claude: '`' } }).planName, {})
  // A line break splits a one-line label in two; the words survive, joined by one space.
  assert.deepEqual(sanitize({ 'tokenPace.planName': { claude: 'Max\n20x' } }).planName,
    { claude: 'Max 20x' })
  assert.deepEqual(sanitize({ 'tokenPace.planName': { codex: 'Plus\r\n  Team\tA' } }).planName,
    { codex: 'Plus Team A' })
  // The invisible ones are removed outright, not turned into a gap.
  assert.deepEqual(sanitize({ 'tokenPace.planName': { claude: 'Ma\u0000x\u007f 20x\u009b' } }).planName,
    { claude: 'Max 20x' })
  // The cap counts what is left, so stripped characters do not eat into the 40 a user has;
  // a cut that lands on a space is trimmed again rather than printing a trailing gap.
  assert.deepEqual(sanitize({ 'tokenPace.planName': { claude: '`'.repeat(20) + 'y'.repeat(40) } }).planName,
    { claude: 'y'.repeat(40) })
  assert.deepEqual(sanitize({ 'tokenPace.planName': { claude: 'z'.repeat(39) + '  tail' } }).planName,
    { claude: 'z'.repeat(39) })
  // Everything a name legitimately contains is left alone.
  assert.deepEqual(sanitize({ 'tokenPace.planName': { claude: 'Max 20x (Team) · €', codex: 'Pro+' } }).planName,
    { claude: 'Max 20x (Team) · €', codex: 'Pro+' })
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

test('a stored dashboard section that no longer exists is dropped, not shown', () => {
  // 1.2.1 shipped a `forecast` section; a settings file written then still names it. The
  // sanitizer drops it in silence — the rest of the list is the user's order and stays.
  const sections = properties['tokenPace.dashboard.sections'].items?.enum ?? []
  assert.equal(sections.includes('forecast'), false, 'forecast is still a contributed section')
  assert.equal((properties['tokenPace.dashboard.sections'].default as string[]).includes('forecast'), false)
  assert.deepEqual(
    sanitize({ 'tokenPace.dashboard.sections': ['quota', 'forecast', 'tokens'] }).dashboard.sections,
    ['quota', 'tokens'],
  )
  // The status-bar entry of the same name is a different thing and is still contributed.
  const bar = properties['tokenPace.statusBar.show'].items?.enum ?? []
  assert.ok(bar.includes('forecast'), 'the status bar lost its forecast entry')
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

test('the agents entry is contributed but not switched on, and is the one value 1.6 adds (1.6 O1)', () => {
  const bar = properties['tokenPace.statusBar.show'].items?.enum ?? []
  assert.ok(bar.includes('agents'), 'statusBar.show cannot show the running agents')
  assert.equal((properties['tokenPace.statusBar.show'].default as string[]).includes('agents'), false)
  assert.deepEqual(sanitize({ 'tokenPace.statusBar.show': ['agents'] }).statusBar.show, ['agents'])
  assert.deepEqual(sanitize({}).statusBar.show.includes('agents'), false)
  // The manifest's values are the ones config.ts keeps, in the same order, `agents` after the 1.5
  // values (1.8 A5, pinned and changed: `agents` was last; `cache` follows it now).
  const kept = sanitize({ 'tokenPace.statusBar.show': [...bar].reverse() }).statusBar.show
  assert.deepEqual([...kept].reverse(), bar)
  assert.equal(bar[bar.indexOf('budget') + 1], 'agents')
  // Its description says what the entry is and that it is inferred, in both languages.
  assert.equal(englishNls['config.statusBar.show.enum.agents'],
    'Running agents, e.g. “~22 running” — inferred from their transcripts; hidden while none runs')
  assert.equal(germanNls['config.statusBar.show.enum.agents'],
    'Laufende Agenten, z. B. “~22 laufen” — abgeleitet aus ihren Transkripten; ausgeblendet, solange keiner läuft')
})

test('the cache entry is contributed but not switched on, and is the one value 1.8 adds (1.8 A5)', () => {
  const bar = properties['tokenPace.statusBar.show'].items?.enum ?? []
  assert.equal(bar[bar.length - 1], 'cache', 'statusBar.show cannot show the prompt cache, or not last')
  assert.equal((properties['tokenPace.statusBar.show'].default as string[]).includes('cache'), false)
  assert.deepEqual(sanitize({ 'tokenPace.statusBar.show': ['cache'] }).statusBar.show, ['cache'])
  assert.deepEqual(sanitize({}).statusBar.show.includes('cache'), false)
  assert.deepEqual(sanitize({ 'tokenPace.statusBar.show': ['cache', 'tokens', 'cache'] }).statusBar.show, ['cache', 'tokens'])
  // Its description names the entry's own text, off by default and hidden while nothing cools, in both languages.
  const descriptions = properties['tokenPace.statusBar.show'].items?.enumDescriptions ?? []
  assert.equal(descriptions[bar.indexOf('cache')], englishNls['config.statusBar.show.enum.cache'])
  assert.equal(englishNls['config.statusBar.show.enum.cache'],
    'The one-hour prompt cache of a Claude Code session in its last five minutes, e.g. “cache 4m” — “cache ~4m” when estimated from the transcript; hidden while none is cooling')
  assert.equal(germanNls['config.statusBar.show.enum.cache'],
    'Der Ein-Stunden-Prompt-Cache einer Claude-Code-Sitzung in seinen letzten fünf Minuten, z. B. “Cache 4m” — “Cache ~4m”, wenn aus dem Transkript geschätzt; ausgeblendet, solange keiner abkühlt')
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

test('tokenPace.language: auto or an exact registry id — another case, a path, a number, an empty string or null is auto (1.9 A1 rule 3)', () => {
  assert.equal(sanitize({}).language, 'auto')
  assert.equal(sanitize({ 'tokenPace.language': 'auto' }).language, 'auto')
  for (const id of ['en', 'de', 'fr', 'es', 'pt-br', 'it', 'ja', 'ko', 'zh-cn', 'zh-tw', 'ru', 'tr', 'pl', 'cs']) {
    assert.equal(sanitize({ 'tokenPace.language': id }).language, id, id)
  }
  // The id is also a file tag: `FR` is not `fr`, and `pt-BR` not `pt-br` — both are auto, not a guess.
  for (const bad of ['FR', 'pt-BR', 'Zh-TW', '../x', 'fr/../../x', '', ' de', 'pt', 'xx', 42, null, true, ['de'], { de: true }]) {
    assert.equal(sanitize({ 'tokenPace.language': bad }).language, 'auto', JSON.stringify(bad))
  }
})

test('the language setting: a string enum of auto and the twenty-nine ids, auto by default, of application scope, first in General with order 0 (1.9 A1 rule 2; 1.11 A2: the twelve of tier 2 after cs; 1.13 A1: the three of 1.13 after ro)', () => {
  const raw = readJson('package.json') as {
    contributes: { configuration: Array<{ id: string; properties: Record<string, Record<string, unknown>> }> }
  }
  const general = raw.contributes.configuration.find((g) => g.id === 'tokenPace.general')
  assert.ok(general)
  const keys = Object.keys(general.properties)
  assert.equal(keys[0], 'tokenPace.language', 'the language is not the first setting of General')
  const ids = ['en', 'de', 'fr', 'es', 'pt-br', 'it', 'ja', 'ko', 'zh-cn', 'zh-tw', 'ru', 'tr', 'pl', 'cs',
    'nl', 'uk', 'sv', 'nb', 'da', 'fi', 'hi', 'id', 'vi', 'el', 'hu', 'ro',
    // 1.13 P2 (pinned and changed: the twenty-six): Arabic, Hebrew and Persian after ro.
    'ar', 'he', 'fa']
  assert.deepEqual(general.properties['tokenPace.language'], {
    type: 'string',
    order: 0,
    enum: ['auto', ...ids],
    enumDescriptions: ['auto', ...ids].map((v) => `%config.language.enum.${v}%`),
    default: 'auto',
    markdownDescription: '%config.language.description%',
    // A cloned repository's `.vscode/settings.json` must not switch a reader's interface language,
    // and every window of the user shows the same one.
    scope: 'application',
  })
  // Nothing else of General moved: the keep-warm setting still follows the plan names (1.8).
  assert.equal(keys.indexOf('tokenPace.cacheKeepWarm'), keys.indexOf('tokenPace.planName') + 1)
  assert.equal(CONFIG_KEYS[0], 'tokenPace.language')
})

test('the Codex app-server keeps a standing connection by default; oneShot stays the opt-out (1.12 A1 rule 1, A6 test 9)', () => {
  const p = properties['tokenPace.codexAppServer.mode']
  assert.equal(p.default, 'persistent')
  assert.deepEqual(p.enum, ['oneShot', 'persistent'])
  // Unset, or a value that is not one of the two: the manifest's default.
  assert.equal(sanitize({}).codexAppServer.mode, 'persistent')
  assert.equal(sanitize({ 'tokenPace.codexAppServer.mode': 'always' }).codexAppServer.mode, 'persistent')
  assert.equal(sanitize({ 'tokenPace.codexAppServer.mode': 'oneShot' }).codexAppServer.mode, 'oneShot')
  // The words say so, in English and German (A5).
  assert.match(englishNls['config.codexAppServer.mode.enum.persistent'], /— the default$/)
  assert.match(germanNls['config.codexAppServer.mode.enum.persistent'], /— die Voreinstellung$/)
  for (const nls of [englishNls, germanNls]) {
    assert.ok(nls['config.codexAppServer.mode.description'].includes('`persistent`'))
    assert.ok(nls['config.codexAppServer.mode.description'].includes('`oneShot`'))
  }
})

// ---------------------------------------------------------------------------
// 1.12 C5, C14 item 7 (P6): the eight notification settings
// ---------------------------------------------------------------------------

const NOTIFY_KEYS = [
  'tokenPace.notifications.channels', 'tokenPace.notifications.events', 'tokenPace.notifications.thresholds',
  'tokenPace.notifications.cooldownMinutes', 'tokenPace.notifications.webhook', 'tokenPace.notifications.telegram',
  'tokenPace.notifications.ntfy', 'tokenPace.notifications.email',
]

test('the eight notification settings: in CONFIG_KEYS, in their own category after Alerts, all machine-scoped (1.12 C5 rule 1, §0b.3)', () => {
  assert.deepEqual([...NOTIFY_CONFIG_KEYS], NOTIFY_KEYS)
  for (const key of NOTIFY_KEYS) assert.ok(CONFIG_KEYS.includes(key), key)
  const raw = readJson('package.json') as {
    contributes: { configuration: Array<{ id: string; title: string; order: number; properties: Record<string, Record<string, unknown>> }> }
  }
  const ids = raw.contributes.configuration.map((c) => c.id)
  assert.equal(ids.indexOf('tokenPace.notifications'), ids.indexOf('tokenPace.alerts') + 1, 'the category does not follow Alerts')
  const cat = raw.contributes.configuration.find((c) => c.id === 'tokenPace.notifications')
  assert.ok(cat)
  assert.equal(cat.title, '%configuration.notifications.title%')
  assert.deepEqual(Object.keys(cat.properties), NOTIFY_KEYS, 'the category holds the eight keys and nothing else')
  // Every category keeps its own place in the settings UI: the orders are one to n without a gap.
  assert.deepEqual(raw.contributes.configuration.map((c) => c.order), raw.contributes.configuration.map((_, i) => i + 1))
  // A workspace decides nothing about a channel, and Settings Sync carries no address (C5 rule 1).
  for (const key of NOTIFY_KEYS) assert.equal(properties[key].scope, 'machine', `${key} must be machine-scoped`)
  assert.equal(englishNls['configuration.notifications.title'], 'Notifications (phone, chat, e-mail)')
  assert.equal(germanNls['configuration.notifications.title'], 'Benachrichtigungen (Telefon, Chat, E-Mail)')
})

test('no notification setting holds a secret: the schema has no field for an address that is a credential, a token, a topic or a password (1.12 C5 rule 2, §0a.8)', () => {
  const names: string[] = []
  const walk = (schema: Record<string, unknown>, at: string): void => {
    const props = schema.properties as Record<string, Record<string, unknown>> | undefined
    for (const [name, sub] of Object.entries(props ?? {})) {
      names.push(`${at}.${name}`)
      walk(sub, `${at}.${name}`)
    }
    if (schema.items && typeof schema.items === 'object') walk(schema.items as Record<string, unknown>, `${at}[]`)
  }
  for (const key of NOTIFY_KEYS) {
    const property = properties[key] as unknown as Record<string, unknown>
    names.push(key)
    walk(property, key)
    // An object's fields are exactly its properties: nothing a hand-edit could slip a secret into.
    if (property.type === 'object') assert.equal(property.additionalProperties, false, `${key} accepts fields it does not name`)
  }
  assert.deepEqual(names.map((n) => n.replace(/^tokenPace\.notifications\./, '')), [
    'channels', 'events', 'thresholds', 'thresholds.session', 'thresholds.weekly', 'cooldownMinutes',
    'webhook', 'webhook.format', 'webhook.secretHeader', 'telegram', 'telegram.chatId', 'ntfy', 'ntfy.server',
    'email', 'email.host', 'email.port', 'email.security', 'email.user', 'email.from', 'email.to',
  ])
  // secretHeader is the header's name; its value is the secret and has no field.
  for (const n of names) {
    const leaf = n.split('.').pop() as string
    assert.doesNotMatch(leaf, /^(url|webhookUrl|address|token|botToken|topic|password|pass|secret|apiKey|key)$/i, `${n} would hold a secret`)
  }
})

test('the notification defaults: no channel, the five events of the collect file, 80/80, ten minutes, no host (1.12 C14 item 7, §0b.3)', () => {
  const n = sanitize({}).notifications
  assert.deepEqual(n.channels, [])
  assert.deepEqual(n.events, ['agentWaiting', 'agentDone', 'quotaThreshold', 'quotaExhausted', 'paceWarning'])
  assert.deepEqual(n.thresholds, { session: 80, weekly: 80 })
  assert.equal(n.cooldownMinutes, 10)
  assert.deepEqual(n.webhook, { format: 'generic', secretHeader: '' })
  assert.deepEqual(n.telegram, { chatId: '' })
  assert.deepEqual(n.ntfy, { server: '' })
  assert.deepEqual(n.email, { host: '', port: 587, security: 'starttls', user: '', from: '', to: '' })
  // The manifest says the same (the generic defaults test reads every key; these are named for the reader).
  assert.deepEqual(properties['tokenPace.notifications.events'].default, n.events)
  assert.deepEqual(properties['tokenPace.notifications.events'].items?.enum,
    ['agentWaiting', 'agentDone', 'quotaThreshold', 'quotaExhausted', 'quotaReset', 'paceWarning'])
  assert.deepEqual(properties['tokenPace.notifications.channels'].items?.enum, ['webhook', 'telegram', 'ntfy', 'email'])
})

test('readNotifyConfig cleans every value on its own: unknowns and duplicates out, clamps, one plain address, https only, the patterns (1.12 C5 rule 3)', () => {
  const read = (raw: Record<string, unknown>) => readNotifyConfig((k) => raw[k])
  const n = read({
    'tokenPace.notifications.channels': ['ntfy', 'sms', 'ntfy', 7, 'email'],
    'tokenPace.notifications.events': ['quotaReset', 'dailySummary', 'quotaReset', 'agentDone'],
    'tokenPace.notifications.thresholds': { session: 140, weekly: -5, other: 50 },
    'tokenPace.notifications.cooldownMinutes': 0,
    'tokenPace.notifications.webhook': { format: 'matrix', secretHeader: 'X-Token Pace' },
    'tokenPace.notifications.telegram': { chatId: ' -1001234567890 ' },
    'tokenPace.notifications.ntfy': { server: ' https://ntfy.example.org ' },
    'tokenPace.notifications.email': { host: 'smtp.example.org', port: 70000, security: 'ssl', user: ' me@example.org ', from: 'Me <me@example.org>', to: 'you@example.org' },
  })
  assert.deepEqual(n.channels, ['ntfy', 'email'])
  assert.deepEqual(n.events, ['quotaReset', 'agentDone'])
  assert.deepEqual(n.thresholds, { session: 100, weekly: 0 })
  assert.equal(n.cooldownMinutes, 1)
  assert.deepEqual(n.webhook, { format: 'generic', secretHeader: '' })
  assert.equal(n.telegram.chatId, '-1001234567890')
  assert.equal(n.ntfy.server, 'https://ntfy.example.org')
  assert.deepEqual(n.email, { host: 'smtp.example.org', port: 65535, security: 'starttls', user: 'me@example.org', from: '', to: 'you@example.org' })
  // An empty list is a choice (nothing is sent, nothing is listened for); a non-list is the default.
  assert.deepEqual(read({ 'tokenPace.notifications.events': [] }).events, [])
  assert.deepEqual(read({ 'tokenPace.notifications.events': 'agentDone' }).events.length, 5)
  // A threshold that is not a number is the default, `0` is off, fractions are whole percentages.
  assert.deepEqual(read({ 'tokenPace.notifications.thresholds': { session: 'high', weekly: 0 } }).thresholds, { session: 80, weekly: 0 })
  assert.deepEqual(read({ 'tokenPace.notifications.thresholds': { session: 79.6, weekly: 90 } }).thresholds, { session: 80, weekly: 90 })
  assert.deepEqual(read({ 'tokenPace.notifications.thresholds': 'eighty' }).thresholds, { session: 80, weekly: 80 })
  // The header's name, the chat and the SMTP host by their patterns.
  assert.equal(read({ 'tokenPace.notifications.webhook': { format: 'slack', secretHeader: 'X-Hook-Secret' } }).webhook.secretHeader, 'X-Hook-Secret')
  assert.equal(read({ 'tokenPace.notifications.webhook': { format: 'teams' } }).webhook.format, 'teams')
  for (const chatId of ['@my_channel', '123456789']) assert.equal(read({ 'tokenPace.notifications.telegram': { chatId } }).telegram.chatId, chatId)
  for (const chatId of ['@abc', 'my channel', 'https://t.me/x', 42]) assert.equal(read({ 'tokenPace.notifications.telegram': { chatId } }).telegram.chatId, '')
  for (const host of ['smtp://smtp.example.org', 'user:pass@smtp.example.org', 'smtp.example.org:587', 'smtp example.org', '-bad.example']) {
    assert.equal(read({ 'tokenPace.notifications.email': { host } }).email.host, '', host)
  }
  assert.equal(read({ 'tokenPace.notifications.email': { host: '[2001:db8::1]', port: 465, security: 'tls' } }).email.host, '[2001:db8::1]')
  assert.equal(read({ 'tokenPace.notifications.email': { security: 'tls' } }).email.security, 'tls')
  for (const bad of ['two@a.org, three@b.org', 'no-at-sign', 'a@b@c', '"quoted"@x.org']) {
    assert.equal(read({ 'tokenPace.notifications.email': { to: bad } }).email.to, '', bad)
  }
  // A user name on one line, whatever the settings file holds.
  assert.equal(read({ 'tokenPace.notifications.email': { user: 'me\n@example.org' } }).email.user, 'me @example.org')
})

test('httpsOnly: an https address with a host, without credentials or a fragment — nothing else (1.12 C1 rule 1, C5 rule 3)', () => {
  assert.equal(httpsOnly('https://ntfy.sh')?.hostname, 'ntfy.sh')
  assert.equal(httpsOnly(' https://hooks.example.org/services/T0/B0/x ')?.pathname, '/services/T0/B0/x')
  assert.equal(httpsOnly('https://ntfy.example.org:8443/')?.port, '8443')
  for (const bad of ['http://ntfy.sh', 'https://user:pass@ntfy.sh', 'https://user@ntfy.sh', 'https://ntfy.sh/#frag', 'ntfy.sh',
    'ftp://ntfy.sh', '', '   ', 'https:// ntfy.sh', 'https://', 'javascript:alert(1)']) {
    assert.equal(httpsOnly(bad), null, bad)
  }
  // A settings file's ntfy server that fails is no server at all.
  assert.equal(readNotifyConfig((k) => k === 'tokenPace.notifications.ntfy' ? { server: 'http://ntfy.sh' } : undefined).ntfy.server, '')
})

test('a change of the notification settings alone is the notifier\'s: notifyOnly says so, and says no for any other key (1.12 C5 rule 3)', () => {
  const change = (...keys: string[]) => ({
    affectsConfiguration: (section: string) => keys.some((k) => k === section || k.startsWith(`${section}.`) || section === 'tokenPace'),
  })
  assert.equal(notifyOnly(change('tokenPace.notifications.channels')), true)
  assert.equal(notifyOnly(change('tokenPace.notifications.email', 'tokenPace.notifications.events')), true)
  assert.equal(notifyOnly(change('tokenPace.notifications.email', 'tokenPace.alerts.thresholds')), false)
  assert.equal(notifyOnly(change('tokenPace.alerts.thresholds')), false)
  assert.equal(notifyOnly(change('tokenPace.staleAfterMinutes')), false)
  // The routing never hides a notifications change from `affects` itself.
  assert.equal(affects(change('tokenPace.notifications.ntfy'), ['tokenPace']), true)
})

test('C0: the six Alerts sentences say alert, never notification; the German Alerts category is „Warnhinweise“ and its sentences say Warnhinweis (1.12 C0)', () => {
  const six = ['thresholds', 'requireAhead', 'useItLoseIt', 'forecastLeadMinutes', 'onPaceFast', 'budgetPercent']
    .map((k) => `config.alerts.${k}.description`)
  for (const key of six) {
    assert.doesNotMatch(englishNls[key], /notif/i, `${key} still says notification`)
    assert.match(englishNls[key], /\balert/i, `${key} does not say alert`)
  }
  assert.equal(englishNls['configuration.alerts.title'], 'Alerts')
  assert.equal(germanNls['configuration.alerts.title'], 'Warnhinweise')
  // In German „Benachrichtigung“ means only the message sent outside VS Code — no sentence of the Alerts category says it.
  const alertKeys = Object.keys(germanNls).filter((k) => k.startsWith('config.alerts.') || k === 'config.staleAfterMinutes.description')
  assert.ok(alertKeys.length >= 14)
  for (const key of alertKeys) assert.doesNotMatch(germanNls[key], /benachrichtig/i, `${key} says Benachrichtigung`)
  for (const key of six) assert.match(germanNls[key], /Warnhinweis|warnen/, `${key} does not say Warnhinweis`)
  // The two category names differ in both languages.
  assert.notEqual(englishNls['configuration.alerts.title'], englishNls['configuration.notifications.title'])
  assert.ok(!germanNls['configuration.notifications.title'].startsWith(germanNls['configuration.alerts.title']))
})
