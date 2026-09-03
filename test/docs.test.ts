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
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { usedThresholds } from '../src/alerts'
import { sanitize } from '../src/config'
import { priceOf } from '../src/prices'
import { BarGlyphs, BarStyle, renderBar } from '../src/render'
import { selectWindows } from '../src/statusText'
import { formatReset, TimeConfig } from '../src/time'
import { QuotaState, QuotaWindow } from '../src/types'

const ROOT = join(__dirname, '..')
const readDoc = (name: string): string => readFileSync(join(ROOT, name), 'utf8')

interface Property {
  type?: string
  enum?: string[]
  enumDescriptions?: string[]
  markdownDescription?: string
  items?: { minimum?: number; maximum?: number }
}

const pkg = JSON.parse(readDoc('package.json')) as {
  contributes: { configuration: Array<{ properties: Record<string, Property> }> }
}
const properties: Record<string, Property> = {}
for (const section of pkg.contributes.configuration) {
  for (const [key, value] of Object.entries(section.properties)) properties[key] = value
}

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
