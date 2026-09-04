// SPDX-FileCopyrightText: 2026 Frederik Marx
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The prose is part of the product: a settings description, a README sentence or a row in
 * docs/status-bar-states.md is what a user takes for the contract. These tests keep the words
 * pinned to the code that has to honour them — every example string here is either rendered by
 * the real function or asserted absent, so a description cannot drift back to a promise the
 * build does not keep. Synthetic data only; no file outside the repository is touched.
 */

import { strict as assert } from 'node:assert'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { usedThresholds } from '../src/alerts'
import { sanitize } from '../src/config'
import { disclosure } from '../src/consent'
import { priceOf } from '../src/prices'
import { BarGlyphs, BarStyle, renderBar } from '../src/render'
import { selectWindows, viewOf, windowValue } from '../src/statusText'
import { formatReset, TimeConfig } from '../src/time'
import { QuotaState, QuotaWindow } from '../src/types'
import { readManifest } from './helpers/nls'

const ROOT = join(__dirname, '..')
const readDoc = (name: string): string => readFileSync(join(ROOT, name), 'utf8')

interface Property {
  type?: string
  default?: unknown
  enum?: string[]
  enumDescriptions?: string[]
  markdownDescription?: string
  items?: { minimum?: number; maximum?: number }
}

/**
 * The manifest holds `%key%` placeholders since 1.2.0; the prose these tests pin lives in
 * `package.nls.json`, so every read goes through the resolver.
 */
const pkg = readManifest<{
  contributes: { configuration: Array<{ properties: Record<string, Property> }> }
}>()
const properties: Record<string, Property> = {}
for (const section of pkg.contributes.configuration) {
  for (const [key, value] of Object.entries(section.properties)) properties[key] = value
}

/** The whole manifest, for the contribution points these tests pin. */
const manifest = readManifest<{
  version: string
  engines: { vscode: string }
  devDependencies: Record<string, string>
  keywords: string[]
  contributes: {
    commands: Array<{ command: string; title: string }>
    keybindings: Array<{ command: string; key: string; mac?: string; when?: string }>
    viewsContainers: Record<string, unknown>
    walkthroughs: Array<{
      id: string
      title: string
      steps: Array<{
        id: string
        title: string
        description: string
        media: { markdown: string }
        completionEvents?: string[]
      }>
    }>
  }
}>()

const README = readDoc('README.md')
const STATES = readDoc('docs/status-bar-states.md')

/**
 * The examples in the settings UI are quoted with curly quotes; this pulls them out, one entry
 * per enum value (null where a description carries no example, such as "Follow the locale").
 */
function examples(key: string): Array<string | null> {
  return (properties[key].enumDescriptions ?? []).map((d) => {
    const m = d.match(/“([^”]*)”/)
    return m ? m[1] : null
  })
}

/** Trailing blanks are invisible in the settings UI, so an example may drop them. */
const trimmed = (s: string): string => s.replace(/\s+$/, '')

/** Every bar the renderer can draw for one glyph set, over the whole percentage range. */
function drawable(glyphs: BarGlyphs, style: BarStyle): Set<string> {
  const out = new Set<string>()
  for (let p = 0; p <= 1000; p++) {
    out.add(trimmed(renderBar(p / 10, { width: 8, style, glyphs, marker: null, markerStyle: 'none', remaining: false })))
  }
  return out
}

// ---------------------------------------------------------------------------
// Bar examples: the settings UI may only show glyphs the renderer emits
// ---------------------------------------------------------------------------

test('every barGlyphs example is a bar the renderer can actually draw', () => {
  const sets: BarGlyphs[] = ['blocks', 'shapes', 'dots', 'pie']
  const shown = examples('tokenPace.barGlyphs')
  assert.equal(shown.length, sets.length)
  sets.forEach((glyphs, i) => {
    const example = shown[i]
    assert.ok(example, `barGlyphs ${glyphs} has no example`)
    assert.ok(drawable(glyphs, 'line').has(example as string), `barGlyphs ${glyphs}: “${example}” is never rendered`)
  })
  // The regression: U+2584 (lower half block) is from another row of the block and cannot appear.
  assert.equal((shown[0] as string).includes('▄'), false, 'the blocks example uses a glyph renderBar never emits')
})

test('every barStyle example is a bar the renderer can draw with the default glyph set', () => {
  const styles: BarStyle[] = ['line', 'shade', 'none']
  const shown = examples('tokenPace.barStyle')
  assert.equal(shown.length, styles.length)
  styles.forEach((style, i) => {
    const example = shown[i]
    assert.ok(example, `barStyle ${style} has no example`)
    assert.ok(drawable('blocks', style).has(example as string), `barStyle ${style}: “${example}” is never rendered`)
  })
})

test('barStyle says where line and shade actually differ, because for shapes and dots they do not', () => {
  const bar = (glyphs: BarGlyphs, style: BarStyle): string =>
    renderBar(25, { width: 8, style, glyphs, marker: null, markerStyle: 'none', remaining: false })
  // The fact the description has to state: only `blocks` reacts to line vs shade.
  assert.notEqual(bar('blocks', 'line'), bar('blocks', 'shade'))
  assert.equal(bar('shapes', 'line'), bar('shapes', 'shade'))
  assert.equal(bar('dots', 'line'), bar('dots', 'shade'))
  assert.equal(bar('pie', 'line'), bar('pie', 'shade'))

  const md = properties['tokenPace.barStyle'].markdownDescription ?? ''
  assert.match(md, /line.+shade.+differ only/i)
  assert.match(md, /blocks/)
  assert.match(README, /`line` and `shade` differ only for `blocks`/)
  assert.match(STATES, /differ only for `barGlyphs: blocks`/)
})

// ---------------------------------------------------------------------------
// Reset clock and reading age
// ---------------------------------------------------------------------------

test('the resetHourCycle examples are what formatReset prints', () => {
  const utc: TimeConfig = { zone: 'utc', dayBoundaryHour: 0, startOfWeek: 'monday', hourCycle: 'auto' }
  const now = Date.UTC(2026, 8, 3, 3, 46)
  const at6 = Date.UTC(2026, 8, 3, 6, 0)
  const shown = examples('tokenPace.resetHourCycle')
  // enum order: auto, h12, h23 — `auto` follows the locale, so only the two fixed ones are pinned.
  assert.equal(formatReset(at6, now, 'absolute', { ...utc, hourCycle: 'h12' }), shown[1])
  assert.equal(formatReset(at6, now, 'absolute', { ...utc, hourCycle: 'h23' }), shown[2])
  assert.equal(shown[1], '06:00 AM')
})

test('the showAgeInItem examples use the age format the item really carries', () => {
  const shown = examples('tokenPace.showAgeInItem').filter((s): s is string => !!s && s.includes('$(history)'))
  assert.equal(shown.length, 2)
  for (const s of shown) {
    const age = s.slice(s.indexOf('$(history)') + '$(history)'.length).trim()
    // ageShort: "<1m", "24m", "3h", "2d" — and never a trailing word the renderer does not emit.
    assert.match(age, /^(<1m|\d+[mhd])$/, `“${s}” shows an age the status bar never writes`)
  }
})

// ---------------------------------------------------------------------------
// windowSelect: worstPace
// ---------------------------------------------------------------------------

const NOW = Date.UTC(2026, 8, 3, 12, 0, 0)
const HOUR = 3_600_000

function win(p: Partial<QuotaWindow>): QuotaWindow {
  return {
    id: 'session:300', kind: 'session', label: '5 h', shortLabel: '5h', model: null,
    percent: 25, resetsAt: NOW + HOUR, windowMinutes: 300, limitReached: false, unlimited: false, ...p,
  }
}

test('worstPace is documented as level first, utilisation second — which is what it does', () => {
  // Both windows are ahead of their clock, so both land in the same pace level; the 7 d window
  // is 30 points ahead, the 5 h window only 6 — and the more-utilised one still wins.
  const q: QuotaState = {
    source: 'claude', ok: true, origin: 'poll', fetchedAt: Math.floor(NOW / 1000), planType: null,
    windows: [
      // 85 % of five hours have run, 91 % is used: 6 points ahead.
      win({ id: 'session:300', percent: 91, windowMinutes: 300, resetsAt: NOW + 0.75 * HOUR }),
      // 10 % of seven days have run, 40 % is used: 30 points ahead.
      win({
        id: 'weekly_all:10080', kind: 'weekly', label: '7 d', shortLabel: '7d', percent: 40,
        windowMinutes: 10080, resetsAt: NOW + 151.2 * HOUR,
      }),
    ],
  }
  const cfg = sanitize({ 'tokenPace.timezone': 'utc', 'tokenPace.windowSelect': 'worstPace' })
  assert.deepEqual(selectWindows(q, cfg, NOW).map((w) => w.id), ['session:300'])

  // So neither the settings UI nor the README may promise "furthest ahead of the clock".
  const shown = properties['tokenPace.windowSelect'].enumDescriptions ?? []
  const worst = shown[(properties['tokenPace.windowSelect'].enum ?? []).indexOf('worstPace')]
  assert.equal(/furthest ahead/.test(worst), false, worst)
  assert.match(worst, /most-utilised/)
  assert.equal(/`worstPace` \(the one furthest ahead of the clock\)/.test(README), false)
  assert.match(README, /`worstPace` \(the worst pace verdict/)
})

// ---------------------------------------------------------------------------
// Family fallback
// ---------------------------------------------------------------------------

test('the README names the donor the family fallback really picks', () => {
  // The rule is "newest priced model of the family", so the donor is whatever prices.ts holds
  // today — the README example has to be derived from it, never guessed.
  for (const unknown of ['claude-opus-4-9', 'gpt-5.7-mini']) {
    const priced = priceOf(unknown, '2026-09-03', { unknownModel: 'family' })
    assert.equal(priced?.confidence, 'family', `${unknown} has no family fallback`)
    const claim = `\`${unknown}\` → \`${priced?.family}\``
    assert.ok(README.includes(claim), `the README does not say ${claim}`)
  }
})

// ---------------------------------------------------------------------------
// Alert thresholds: the manifest range is what can fire
// ---------------------------------------------------------------------------

test('the alert-threshold range in the manifest is exactly what an alert can fire on', () => {
  const items = properties['tokenPace.alerts.thresholds'].items ?? {}
  assert.equal(items.minimum, 1)
  assert.equal(items.maximum, 100)
  const at = (n: number): number[] =>
    usedThresholds(sanitize({ 'tokenPace.alerts.thresholds': [n] }).alerts)
  assert.deepEqual(at(items.maximum as number), [100], 'the advertised maximum never fires')
  assert.deepEqual(at(items.minimum as number), [1], 'the advertised minimum never fires')
  // Above the advertised maximum nothing can fire, which is why the manifest must not offer it.
  assert.deepEqual(at(110), [])
})

// ---------------------------------------------------------------------------
// Privacy: the list of files read
// ---------------------------------------------------------------------------

test('the Privacy list names every file the extension opens', () => {
  const privacy = README.slice(README.indexOf('\n## Privacy'), README.indexOf('\n## ', README.indexOf('\n## Privacy') + 5))
  assert.ok(privacy.length > 0)
  for (const needed of [
    '~/.claude/projects/',            // transcript scan
    '.config/claude/projects/',       // the XDG location src/discover.ts also walks
    '~/.codex/sessions/',
    'archived_sessions/',
    'cachedUsageUtilization',         // the one object read from ~/.claude.json
    'mirror',                         // the status-line bridge's mirror in globalStorage
    'settings.json',                  // bridge install state
    'settings.local.json',            // shadow detection
    'managed-settings',               // shadow detection
    '.credentials.json',              // poll mode, after consent
  ]) {
    assert.ok(privacy.includes(needed), `the Privacy section does not mention ${needed}`)
  }
  // The claims that must stay: what is never touched.
  for (const never of ['ide/*.lock', 'sessions/*.key', 'oauthAccount']) {
    assert.ok(privacy.includes(never), `the Privacy section dropped the "never read" claim for ${never}`)
  }
})

test('the promise about transcript contents matches what the tool table stores', () => {
  const privacy = README.slice(README.indexOf('\n## Privacy'), README.indexOf('\n## ', README.indexOf('\n## Privacy') + 5))
  // The tool side table stores a name, a day, a model and a count — so the sentence may not
  // claim tool calls are never stored, and it has to say what is stored instead.
  assert.equal(/tool calls — are never stored/.test(privacy), false,
    'the Privacy section still promises that tool calls are never stored')
  assert.match(privacy, /tool arguments and tool results — are never stored/)
  assert.match(privacy, /\*\*name\*\* of a tool/)
  // The attribution setting makes the same distinction, in the settings UI.
  const attribution = String(properties['tokenPace.attribution'].markdownDescription)
  assert.equal(/no tool call\./.test(attribution), false, attribution)
  assert.match(attribution, /no tool argument and no tool result/)
})

test('both export dialogs say that tool names are about to leave the machine', () => {
  // The README's rule for the save dialog: it names what is about to be written, because that
  // is the last moment to say no. The tool table is the newest thing in both files — names as
  // the transcript spells them, MCP names included — so neither dialog may stay quiet about it.
  const src = readDoc('src/nativeViews.ts')
  for (const command of ['tokenPace.exportCsv', 'tokenPace.exportJson']) {
    const at = src.indexOf(`registerCommand('${command}'`)
    assert.ok(at >= 0, `src/nativeViews.ts no longer registers ${command}`)
    const block = src.slice(at, src.indexOf('}),', at))
    assert.match(block, /[Tt]ool names/, `the ${command} save dialog does not mention tool names`)
  }
})

test('the tool-table retention the README promises is the horizon the aggregator applies', () => {
  const days = /TOOL_KEEP_DAYS = (\d+)/.exec(readDoc('src/agg.ts'))
  assert.ok(days, 'src/agg.ts no longer states a TOOL_KEEP_DAYS')
  const cap = (days as RegExpExecArray)[1]
  const flat = (t: string): string => t.replace(/\s+/g, ' ')
  assert.ok(flat(README).includes(`kept for at most ${cap} days`),
    `the README does not state the ${cap}-day tool horizon`)
  // The day buckets outlive the tool rows on the shipped default, so it is user-visible.
  assert.ok(flat(readDoc('CHANGELOG.md')).includes(`at most **${cap} days**`),
    `the CHANGELOG does not state the ${cap}-day tool horizon`)
})

test('the README states the snapshot version the code writes and the one it reads forward', () => {
  const src = readDoc('src/types.ts')
  const version = /STATE_VERSION = (\d+)/.exec(src)
  assert.ok(version, 'src/types.ts no longer states a STATE_VERSION')
  assert.ok(README.includes(`snapshot is schema version ${(version as RegExpExecArray)[1]}`),
    `the README does not name schema version ${(version as RegExpExecArray)[1]}`)
  const readable = /READABLE_STATE_VERSIONS[^=]*= \[([^\]]*)\]/.exec(src)
  assert.ok(readable, 'src/types.ts no longer lists the readable versions')
  for (const v of (readable as RegExpExecArray)[1].split(',').map((x) => x.trim()).filter(Boolean)) {
    assert.match(README, new RegExp(`[Vv]ersion ${v}\\b`), `the README does not say version ${v} is still read`)
  }
})

// ---------------------------------------------------------------------------
// The paused state
// ---------------------------------------------------------------------------

test('the documented cause of "CC paused" is the one that can actually produce it', () => {
  const row = STATES.split('\n').find((l) => l.includes('CC paused'))
  assert.ok(row, 'docs/status-bar-states.md no longer documents the paused state')
  // Only src/quota.ts produces this state, from a cache file whose blocked_until is in the future.
  assert.match(row as string, /blocked_until/)
  assert.equal(/pollOnlyWhenFocused/.test(row as string), false, 'the focus gate never produces this state')
  // And the README says the same about the cache file.
  assert.match(README, /`blocked_until` in the future is reported as a paused state/)
})

// ---------------------------------------------------------------------------
// Problem states: one repair action per cause, in the code and in both documents
// ---------------------------------------------------------------------------

/** The `ProblemKind` union, read out of src/types.ts so a new kind cannot be forgotten. */
function problemKinds(): string[] {
  const src = readDoc('src/types.ts')
  const at = src.indexOf('export type ProblemKind =')
  assert.ok(at >= 0, 'src/types.ts no longer declares ProblemKind')
  const decl = src.slice(at, src.indexOf('\n\n', at))
  const kinds = [...decl.matchAll(/'([A-Za-z]+)'/g)].map((m) => m[1])
  assert.ok(kinds.length >= 15, `only ${kinds.length} problem kinds parsed`)
  return kinds
}

/**
 * `PROBLEM_ACTION` is module-private (it is an implementation detail of `buildViewModel`),
 * so it is read from the source text rather than imported. That still fails loudly when the
 * table drifts, which is the point.
 */
function problemActions(): Record<string, { label: string; command: string }> {
  const src = readDoc('src/viewModel.ts')
  const at = src.indexOf('const PROBLEM_ACTION')
  assert.ok(at >= 0, 'src/viewModel.ts no longer defines PROBLEM_ACTION')
  const body = src.slice(at, src.indexOf('\n}', at))
  const out: Record<string, { label: string; command: string }> = {}
  for (const m of body.matchAll(/(\w+):\s*\{\s*label:\s*'([^']*)'\s*,\s*command:\s*'([^']*)'\s*\}/g)) {
    out[m[1]] = { label: m[2], command: m[3] }
  }
  return out
}

/** The contract of round 1.1: exactly one repair per cause, and this is the mapping. */
const PROBLEM_TABLE: Array<[string, string, string]> = [
  ['noToken', 'Show log', 'tokenPace.showOutput'],
  ['tokenExpired', 'Show log', 'tokenPace.showOutput'],
  ['consentPending', 'Fetch quota now', 'tokenPace.refreshQuota'],
  ['modeCache', 'Open settings', 'tokenPace.openSettings'],
  ['retry', 'Fetch quota now', 'tokenPace.refreshQuota'],
  ['offline', 'Fetch quota now', 'tokenPace.refreshQuota'],
  ['forbidden', 'Show log', 'tokenPace.showOutput'],
  ['unauthorized', 'Show log', 'tokenPace.showOutput'],
  ['noBinary', 'Open settings', 'tokenPace.openSettings'],
  ['quotaOff', 'Open settings', 'tokenPace.openSettings'],
  ['noFile', 'Re-read history', 'tokenPace.rescan'],
  ['empty', 'Re-read history', 'tokenPace.rescan'],
  ['paused', 'Fetch quota now', 'tokenPace.refreshQuota'],
  ['follower', 'Open dashboard', 'tokenPace.showDashboard'],
  ['unknown', 'Show log', 'tokenPace.showOutput'],
]

/** The rows of one markdown table, keyed by the `kind` cell they carry. */
function rowsByKind(doc: string, from: string, to: string): Map<string, string> {
  const section = doc.slice(doc.indexOf(from), doc.indexOf(to, doc.indexOf(from) + from.length))
  assert.ok(section.length > 0, `${from} is missing`)
  const out = new Map<string, string>()
  for (const line of section.split('\n')) {
    const m = line.match(/^\|[^|]*\|\s*`([A-Za-z]+)`\s*\|/)
    if (m) out.set(m[1], line)
  }
  return out
}

test('every ProblemKind has exactly one repair action, and the code holds that table', () => {
  const kinds = problemKinds()
  assert.deepEqual(PROBLEM_TABLE.map((r) => r[0]).sort(), [...kinds].sort(),
    'PROBLEM_TABLE and the ProblemKind union have drifted apart')

  const actual = problemActions()
  const expected: Record<string, { label: string; command: string }> = {}
  for (const [kind, label, command] of PROBLEM_TABLE) expected[kind] = { label, command }
  assert.deepEqual(actual, expected, 'PROBLEM_ACTION in src/viewModel.ts no longer matches the documented table')
})

test('docs/status-bar-states.md lists the same problem table', () => {
  const rows = rowsByKind(STATES, '## Problem states', '\n## ')
  for (const [kind, label] of PROBLEM_TABLE) {
    const row = rows.get(kind)
    assert.ok(row, `docs/status-bar-states.md has no row for the problem kind ${kind}`)
    assert.ok((row as string).includes(label), `${kind}: the row does not name “${label}”`)
  }
})

test('the README explains every problem state with its bar text and its click', () => {
  const rows = rowsByKind(README, '## If the bar says', '\n## ')
  for (const [kind, label] of PROBLEM_TABLE) {
    const row = rows.get(kind)
    assert.ok(row, `the README does not cover the problem kind ${kind}`)
    assert.ok((row as string).includes(label), `${kind}: the README row does not name “${label}”`)
  }
})

// ---------------------------------------------------------------------------
// The settings tables against the manifest
// ---------------------------------------------------------------------------

const SETTINGS = README.slice(README.indexOf('\n## Settings'), README.indexOf('\n## Commands and keybindings'))

test('every contributed setting has a row in the README settings tables', () => {
  assert.ok(SETTINGS.length > 0, 'the README has no Settings section any more')
  for (const key of Object.keys(properties)) {
    const short = key.replace(/^tokenPace\./, '')
    assert.ok(SETTINGS.includes(`| \`${short}\` |`), `the README settings tables have no row for ${key}`)
  }
})

test('the README states the defaults the manifest actually ships', () => {
  const shown: Array<[string, string]> = [
    ['tokenPace.windowSelect', 'worstPace'],
    ['tokenPace.clickAction', 'dashboard'],
    ['tokenPace.tooltipExplanations', 'false'],
    ['tokenPace.density', 'full'],
    ['tokenPace.alerts.thresholds', '[90]'],
  ]
  for (const [key, text] of shown) {
    const short = key.replace(/^tokenPace\./, '')
    assert.equal(JSON.stringify(properties[key].default).replace(/"/g, ''), text,
      `${key} does not default to ${text} in package.json`)
    assert.ok(SETTINGS.includes(`| \`${short}\` | \`${text}\` |`),
      `the README settings table does not show ${short} defaulting to ${text}`)
  }
})

// ---------------------------------------------------------------------------
// The engine floor the secondary sidebar needs
// ---------------------------------------------------------------------------

test('the engine floor and the version the README promises are the same', () => {
  // contributes.viewsContainers.secondarySidebar was proposed API in 1.104 and only became a
  // stable contribution point in 1.106, so anything lower would register no container at all.
  assert.equal(manifest.engines.vscode, '^1.106.0')
  assert.equal(manifest.devDependencies['@types/vscode'], '^1.106.0')
  assert.ok(manifest.contributes.viewsContainers.secondarySidebar, 'the panel no longer lives in the secondary sidebar')
  assert.match(README, /Requires VS Code 1\.106 or newer/)
  // And the store keywords may not promise editors that cannot run it.
  for (const fork of ['cursor', 'windsurf']) {
    assert.equal(manifest.keywords.includes(fork), false, `keywords still advertise ${fork}`)
  }
})

// ---------------------------------------------------------------------------
// The state words, the pictures, and what actually ships
// ---------------------------------------------------------------------------

/**
 * Whether a repository path survives `.vscodeignore` into the `.vsix`.
 *
 * The file excludes `**` and then negates one path at a time, which is exactly the shape a
 * new asset gets forgotten in: it is in git, the docs point at it, and the packaged
 * extension has nothing there. `vsce` keeps a file when the last matching pattern is a
 * negation, so the patterns are walked in order and the last match wins.
 */
function shipped(path: string): boolean {
  const toRegExp = (pattern: string): RegExp => {
    // `**` crosses directories, a single `*` does not; everything else is a literal.
    const out = pattern
      .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
      .replace(/\\?\*\\?\*/g, '\u0000')
      .replace(/\*/g, '[^/]*')
      .replace(/\u0000/g, '.*')
    return new RegExp(`^${out}$`)
  }
  let keep = true
  for (const raw of readDoc('.vscodeignore').split('\n')) {
    const line = raw.trim()
    if (line === '' || line.startsWith('#')) continue
    const negated = line.startsWith('!')
    if (toRegExp(negated ? line.slice(1) : line).test(path)) keep = negated
  }
  return keep
}

test('the two states that survive every switched-off channel are quoted with their words', () => {
  const cfg = sanitize({ 'tokenPace.timezone': 'utc' })
  const q: QuotaState = {
    source: 'claude', ok: true, origin: 'poll', fetchedAt: Math.floor(NOW / 1000), planType: null,
    windows: [
      win({ percent: 100, resetsAt: NOW + 47 * 60_000 }),
      win({ id: 'weekly_all:10080', percent: 100, limitReached: true }),
    ],
  }
  const exhausted = windowValue(viewOf(q, q.windows[0], cfg, NOW), cfg)
  const stopped = windowValue(viewOf(q, q.windows[1], cfg, NOW), cfg)
  assert.equal(exhausted, '100% exhausted')
  assert.equal(stopped, '100% limit reached')
  // Both tables show the bar text; a row that still carries the bare figure is stale.
  for (const [name, doc] of [['README.md', README], ['docs/status-bar-states.md', STATES]] as const) {
    for (const [needle, marker] of [[exhausted, 'exhausted (≥ 99.5 %)'], [stopped, 'reports the limit as reached']] as const) {
      const row = doc.split('\n').find((l) => l.startsWith('|') && l.includes(marker))
      assert.ok(row, `${name} has no row for “${marker}”`)
      assert.ok((row as string).includes(needle), `${name}: “${marker}” no longer prints “${needle}”`)
    }
  }
})

test('every picture the README embeds exists and is packaged', () => {
  const links = [...README.matchAll(/!\[[^\]]*\]\((media\/[^)\s]+)\)/g)].map((m) => m[1])
  assert.ok(links.length >= 2, 'the README embeds no screenshots any more')
  for (const link of links) {
    // vsce rewrites a relative image to the repository's raw URL, so a missing file is a
    // permanent 404 on the Marketplace page — and nothing in the packaging warns about it.
    assert.ok(existsSync(join(ROOT, link)), `README.md embeds ${link}, which is not in the repository`)
    assert.ok(shipped(link), `${link} is excluded by .vscodeignore`)
  }
})

test('.vscodeignore still keeps the things that must not ship', () => {
  for (const path of ['src/extension.ts', 'test/docs.test.ts', 'dist/extension.js.map', 'media/logo.svg']) {
    assert.equal(shipped(path), false, `${path} would be packaged`)
  }
  for (const path of ['package.json', 'package.nls.json', 'package.nls.de.json', 'README.md',
    'dist/extension.js', 'media/logo.png', 'docs/status-bar-states.md']) {
    assert.equal(shipped(path), true, `${path} would not be packaged`)
  }
})

// ---------------------------------------------------------------------------
// Keybindings and the walkthrough
// ---------------------------------------------------------------------------

test('exactly one keybinding, and the setting that switches it off exists', () => {
  assert.equal(manifest.contributes.keybindings.length, 1)
  const [binding] = manifest.contributes.keybindings
  assert.equal(binding.command, 'tokenPace.showDashboard')
  assert.equal(binding.when, 'config.tokenPace.keybindings')
  assert.equal(properties['tokenPace.keybindings'].type, 'boolean')
  assert.equal(properties['tokenPace.keybindings'].default, true)
  assert.match(README, /`ctrl\+alt\+shift\+t`/)
  // The removed chord may still be named in prose (it explains why it went); what it may not
  // do any more is stand in a table cell as if it still bound something.
  assert.equal(/\|\s*`ctrl\+alt\+shift\+q`[^|]*\|/.test(README), false,
    'the README still lists the removed chord as a binding')
})

test('the walkthrough only names commands that exist and media files that are there', () => {
  const commands = new Set(manifest.contributes.commands.map((c) => c.command))
  const walkthroughs = manifest.contributes.walkthroughs
  assert.equal(walkthroughs.length, 1)
  assert.equal(walkthroughs[0].steps.length, 3)
  for (const step of walkthroughs[0].steps) {
    assert.ok(step.title.length > 0 && step.description.length > 0, `${step.id} is incomplete`)
    const media = join(ROOT, step.media.markdown)
    assert.ok(existsSync(media), `${step.id} points at a missing media file: ${step.media.markdown}`)
    // On disk is not enough: .vscodeignore excludes everything and negates one path at a
    // time, so a step whose media is not negated ships as "Error reading markdown document".
    assert.ok(shipped(step.media.markdown), `${step.media.markdown} is not negated in .vscodeignore`)
    const links = [...step.description.matchAll(/\(command:([\w.]+)\)/g)].map((m) => m[1])
    assert.ok(links.length > 0, `${step.id} has no button`)
    for (const command of links) assert.ok(commands.has(command), `${step.id} links the unknown command ${command}`)
    for (const event of step.completionEvents ?? []) {
      const command = event.startsWith('onCommand:') ? event.slice('onCommand:'.length) : null
      if (command) assert.ok(commands.has(command), `${step.id}: completionEvent names the unknown command ${command}`)
    }
  }
})

test('the quota step quotes the consent dialog, not a paraphrase of it', () => {
  // The walkthrough invites the reader to read the terms before the dialog appears, so it
  // has to be the terms — including the sentence about identifying as the Claude Code
  // client, which src/consent.ts calls the part a user is least able to discover alone.
  const step = readDoc('media/walkthrough/quota.md')
  for (const line of disclosure(30).split('\n')) {
    if (line.trim() === '') continue
    assert.ok(step.includes(line), `media/walkthrough/quota.md no longer says: ${line}`)
  }
  // 30 minutes is the default the manifest declares; a different one would misquote it.
  assert.equal(properties['tokenPace.pollIntervalMinutes'].default, 30)
})

test('the menu command is named after what it opens', () => {
  const menu = manifest.contributes.commands.find((c) => c.command === 'tokenPace.menu')
  assert.equal(menu?.title, 'Show Actions Menu')
  assert.equal(/`Token Pace: Menu`/.test(README), false, 'the README still uses the old command title')
})

// ---------------------------------------------------------------------------
// Budgets: the sentence that keeps a money budget from reading as a bill
// ---------------------------------------------------------------------------

test('every place a money budget is described says it is not a bill', () => {
  const setting = String(properties['tokenPace.budgets'].markdownDescription)
  assert.match(setting, /hypothetical API equivalent, not a bill/)
  // And the same promise where a reader looks it up rather than hovers it.
  const section = README.slice(README.indexOf('\n## Budgets'), README.indexOf('\n## ', README.indexOf('\n## Budgets') + 5))
  assert.ok(section.length > 0, 'the README has no Budgets section')
  assert.match(section, /hypothetical API equivalent, not a bill/)
  // A budget must never be presented as something a provider stated.
  assert.match(section, /limits \*\*you\*\* state/)
  assert.match(section, /lower bound/)
  assert.match(section, /shows a dash/)
})

test('the budget alert is off by default and says what it is judged on', () => {
  assert.equal(properties['tokenPace.alerts.budgetPercent'].default, 0)
  const d = String(properties['tokenPace.alerts.budgetPercent'].markdownDescription)
  assert.match(d, /`0` disables it/)
  assert.match(d, /once per period/)
  // The freshness gate is a different one from the quota alerts', and the description says so.
  assert.match(d, /locally counted usage/)
})
