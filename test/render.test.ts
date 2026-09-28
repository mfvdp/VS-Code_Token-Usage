// SPDX-FileCopyrightText: 2026 Frederik Marx
// SPDX-License-Identifier: AGPL-3.0-or-later

import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { setLocale } from '../src/i18n'
import { intlTag, LANGUAGES } from '../src/languages'
import {
  ageMinutes, BarOptions, compact, decimalText, DEFAULT_BAR, deltaBadge, estimate, extraUsageText, full,
  lastDays, money, percentOf, percentText, provenanceBadge, ratioText, renderBar, severity, usd,
  windowElapsed,
} from '../src/render'

const bar = (percent: number, o: Partial<BarOptions>) => renderBar(percent, { ...DEFAULT_BAR, ...o })

test('blocks: eighth-block fill with the three empty styles', () => {
  assert.equal(bar(50, { width: 8 }), '████▁▁▁▁')
  assert.equal(bar(50, { width: 8, style: 'shade' }), '████░░░░')
  assert.equal(bar(50, { width: 8, style: 'none' }), '████    ')
  assert.equal(bar(0, { width: 4 }), '▁▁▁▁')
  assert.equal(bar(100, { width: 4 }), '████')
  // Partial cell: half a cell is the fourth eighth.
  assert.equal(bar(6.25, { width: 8 }), '▌▁▁▁▁▁▁▁')
  assert.equal(bar(30, { width: 4 }), '█▎▁▁')
  // Out of range values are drawn as a full or empty bar, never as garbage.
  assert.equal(bar(150, { width: 4 }), '████')
  assert.equal(bar(NaN, { width: 4 }), '▁▁▁▁')
  assert.equal(bar(50, { width: 0 }), '')
})

test('shapes and dots: one glyph per cell, style only hides the empty part', () => {
  assert.equal(bar(50, { width: 4, glyphs: 'shapes' }), '■■□□')
  assert.equal(bar(50, { width: 4, glyphs: 'shapes', style: 'shade' }), '■■□□')
  assert.equal(bar(50, { width: 4, glyphs: 'shapes', style: 'none' }), '■■  ')
  assert.equal(bar(50, { width: 4, glyphs: 'dots' }), '●●○○')
  assert.equal(bar(50, { width: 4, glyphs: 'dots', style: 'none' }), '●●  ')
  // Partial cells round to the nearer cell.
  assert.equal(bar(60, { width: 4, glyphs: 'shapes' }), '■■□□')
  assert.equal(bar(65, { width: 4, glyphs: 'shapes' }), '■■■□')
  assert.equal(bar(1, { width: 4, glyphs: 'dots' }), '○○○○')
})

test('pie: exactly one glyph per quintile, width ignored', () => {
  const pie = (p: number) => bar(p, { width: 0, glyphs: 'pie' })
  assert.equal(pie(0), '○')
  assert.equal(pie(19.9), '○')
  assert.equal(pie(20), '◔')
  assert.equal(pie(39), '◔')
  assert.equal(pie(40), '◑')
  assert.equal(pie(60), '◕')
  assert.equal(pie(80), '●')
  assert.equal(pie(100), '●')
  assert.equal(pie(140), '●')
  assert.equal(bar(50, { width: 8, glyphs: 'pie' }).length, 1)
  // The elapsed share can only be a second pie next to it.
  assert.equal(bar(50, { width: 8, glyphs: 'pie', marker: 20, markerStyle: 'bar' }), '◑ ◔')
  assert.equal(bar(50, { width: 8, glyphs: 'pie', marker: 20, markerStyle: 'marker' }), '◑')
})

test('marker: the clock position overrides the glyph on both sides of the fill', () => {
  assert.equal(bar(0, { width: 8, marker: 50, markerStyle: 'marker' }), '▁▁▁▁┃▁▁▁')
  assert.equal(bar(100, { width: 8, marker: 50, markerStyle: 'marker' }), '████┃███')
  assert.equal(bar(0, { width: 8, marker: 0, markerStyle: 'marker' }), '┃▁▁▁▁▁▁▁')
  assert.equal(bar(0, { width: 8, marker: 100, markerStyle: 'marker' }), '▁▁▁▁▁▁▁┃')
  assert.equal(bar(50, { width: 6, glyphs: 'shapes', marker: 100, markerStyle: 'marker' }), '■■■□□┃')
  // Below six cells the marker would eat most of the bar, so it stays off.
  assert.equal(bar(0, { width: 5, marker: 50, markerStyle: 'marker' }), '▁▁▁▁▁')
  // No clock, no marker.
  assert.equal(bar(0, { width: 8, marker: null, markerStyle: 'marker' }), '▁▁▁▁▁▁▁▁')
  assert.equal(bar(50, { width: 8, marker: 50, markerStyle: 'none' }), '████▁▁▁▁')
})

test('markerStyle bar: a second, thin bar for the elapsed share', () => {
  assert.equal(bar(50, { width: 4, marker: 25, markerStyle: 'bar' }), '██▁▁ ▔▁▁▁')
  assert.equal(bar(50, { width: 4, marker: 100, markerStyle: 'bar' }), '██▁▁ ▔▔▔▔')
  assert.equal(bar(50, { width: 4, marker: 0, markerStyle: 'bar' }), '██▁▁ ▁▁▁▁')
  assert.equal(bar(50, { width: 4, marker: null, markerStyle: 'bar' }), '██▁▁')
})

test('remaining: the fill runs from the right (battery), the clock still from the left', () => {
  assert.equal(bar(25, { width: 4, remaining: true }), '▁▁▁█')
  assert.equal(bar(30, { width: 4, remaining: true }), '▁▁▎█')
  assert.equal(bar(50, { width: 4, glyphs: 'shapes', remaining: true }), '□□■■')
  assert.equal(bar(0, { width: 8, remaining: true, marker: 0, markerStyle: 'marker' }), '┃▁▁▁▁▁▁▁')
})

test('percentText: rounding that never claims headroom that is gone', () => {
  assert.equal(percentText(25, 'used', 'clamp'), '25%')
  assert.equal(percentText(25.4, 'used', 'clamp'), '25%')
  assert.equal(percentText(111, 'used', 'clamp'), '100%')
  assert.equal(percentText(111, 'used', 'actual'), '111%')
  assert.equal(percentText(25, 'remaining', 'actual'), '75%')
  assert.equal(percentText(25.4, 'remaining', 'actual'), '74%')
  assert.equal(percentText(99.6, 'remaining', 'actual'), '0%')
  assert.equal(percentText(111, 'remaining', 'actual'), '0%')
  assert.equal(percentText(111, 'remaining', 'clamp'), '0%')
  // Absence and nonsense are a dash, never "0%".
  assert.equal(percentText(NaN, 'used', 'actual'), '–')
  assert.equal(percentText(Infinity, 'used', 'actual'), '–')
  assert.equal(percentText(-1, 'used', 'actual'), '–')
})

test('estimate marks once and only once', () => {
  assert.equal(estimate('$1.20'), '~$1.20')
  assert.equal(estimate('~$1.20'), '~$1.20')
  assert.equal(estimate(''), '~')
})

test('provenance, ratio and percentOf refuse to invent a denominator', () => {
  assert.equal(provenanceBadge('measured'), 'measured')
  assert.equal(provenanceBadge('estimated'), 'estimated')
  assert.equal(provenanceBadge('derived'), 'derived')
  assert.equal(ratioText(3, 2), '1.5')
  assert.equal(ratioText(3, 2, 2), '1.50')
  assert.equal(ratioText(3, 0), '–')
  assert.equal(ratioText(NaN, 2), '–')
  assert.equal(percentOf(91, 100), '91 %')
  assert.equal(percentOf(1, 3), '33 %')
  assert.equal(percentOf(1, 0), '–')
})

test('deltaBadge: growth from nothing is "new", noise is a dot', () => {
  assert.deepEqual(deltaBadge(12, null), { glyph: '', text: 'new' })
  assert.deepEqual(deltaBadge(12, 0), { glyph: '', text: 'new' })
  assert.deepEqual(deltaBadge(0, 0), { glyph: '•', text: '±0%' })
  assert.deepEqual(deltaBadge(110, 100), { glyph: '▲', text: '+10%' })
  assert.deepEqual(deltaBadge(105, 100), { glyph: '▲', text: '+5.0%' })
  assert.deepEqual(deltaBadge(50, 100), { glyph: '▼', text: '-50%' })
  assert.deepEqual(deltaBadge(100.2, 100), { glyph: '•', text: '+0.2%' })
  assert.deepEqual(deltaBadge(99.8, 100), { glyph: '•', text: '-0.2%' })
  assert.deepEqual(deltaBadge(NaN, 100), { glyph: '•', text: '–' })
})

test('money and counts keep their existing behaviour', () => {
  assert.equal(usd(0), '–')
  assert.equal(usd(0.004), '<$0.01')
  assert.equal(usd(1.5), '$1.50')
  assert.equal(usd(100), '$100')
  assert.equal(usd(99.994), '$99.99')
  assert.equal(money(2, 'EUR'), '€2.00')
  assert.equal(money(2, null), '2.00')
  assert.equal(money(2, 'XYZZY'), '2.00 XYZZY')
  assert.equal(compact(987), '987')
  assert.equal(compact(12_345), '12.3K')
  assert.equal(compact(1_200_000), '1.2M')
  assert.equal(compact(3_400_000_000), '3.4G')
  assert.equal(full(12_345), '12,345')
  assert.equal(ageMinutes(null), null)
  assert.equal(ageMinutes(1000, 1000 * 1000 + 60_000), 1)
})

test('extraUsageText states "off" instead of drawing 0 %', () => {
  const base = {
    enabled: true, utilization: null, used: null, limit: null, currency: null,
    balance: null, unlimited: false, spendLimitReached: false, reason: null,
  }
  assert.equal(extraUsageText(undefined), null)
  assert.equal(extraUsageText({ ...base, unlimited: true }), 'unlimited')
  assert.equal(extraUsageText({ ...base, enabled: false, reason: 'not set up' }), 'off (not set up)')
  assert.equal(extraUsageText({ ...base, used: 2, limit: 10, currency: 'USD' }), '$2.00 of $10.00')
  assert.equal(extraUsageText({ ...base, balance: '12' }), '12 credits left')
  assert.equal(extraUsageText(base), 'on')
})

test('compatibility shims still serve the wave-2 callers', () => {
  // Old positional call shape.
  assert.equal(renderBar(50, 8, 'shade'), '████░░░░')
  assert.equal(renderBar(50, 8), '████▁▁▁▁')
  assert.equal(severity(99.6, 10), 'error')
  assert.equal(severity(50, 40), 'warn')
  // The shim asks the one rule set, so it follows the shipped default band of 0: two points
  // ahead of pace is yellow, exactly as every card that prints "2 % ahead of pace" is.
  assert.equal(severity(42, 40), 'warn')
  assert.equal(severity(10, null), 'ok')
  const now = 1_000_000_000_000
  assert.equal(windowElapsed(now + 150 * 60_000, 300, now), 50)
  const days = lastDays(3, now)
  assert.equal(days.length, 3)
  assert.match(days[2], /^\d{4}-\d{2}-\d{2}$/)
})

// ---------------------------------------------------------------------------
// 1.10 B4: decimals through Intl
// ---------------------------------------------------------------------------

/** The decimal mark a locale writes, taken from Intl at test time — the test states no mark of its own. */
function markOf(locale: string): string {
  return new Intl.NumberFormat(locale).formatToParts(1.5).find((p) => p.type === 'decimal')?.value ?? '?'
}

/** Runs `fn` with the formatters in `locale`, and back to the default after it whatever happens. */
function inLocale<T>(locale: string | undefined, fn: () => T): T {
  setLocale(locale)
  try { return fn() } finally { setLocale(undefined) }
}

test('decimalText: the language\'s decimal mark in every registry locale, never grouped, a dash for what is no number (1.10 B4)', () => {
  const marks = new Set<string>()
  // 1.13 P2 (pinned and changed: the plain locale): each language under the tag the host sets for it — its locale through
  // intlTag, which pins Arabic's, Hebrew's and Persian's digits to 0–9 (§0a.2); Persian's own default writes ۲٫۵.
  for (const { id, locale: base } of LANGUAGES) {
    const locale = intlTag(base, id)
    const m = markOf(locale)
    marks.add(m)
    inLocale(locale, () => {
      assert.equal(decimalText(0.7, 1), `0${m}7`, id)
      assert.equal(decimalText(1234.5, 1), `1234${m}5`, id + ': no grouping — the figure read "1234.5" before 1.10')
      assert.equal(decimalText(0.05, 2), `0${m}05`, id)
      // At least minDigits, at most maxDigits: a tenth where there is one, a whole number plain.
      assert.equal(decimalText(1.5, 1, 0), `1${m}5`, id)
      assert.equal(decimalText(2, 1, 0), '2', id)
      assert.equal(decimalText(9.96, 1, 0), '10', id)
      assert.equal(decimalText(-0, 1), `0${m}0`, id + ': -0 prints as toFixed printed it')
      for (const n of [NaN, Infinity, -Infinity]) assert.equal(decimalText(n, 1), '–', id + ' ' + String(n))
      // The sign and the '%' of the delta badge are its own notation; the figure is the language's.
      assert.deepEqual(deltaBadge(99.3, 100), { glyph: '▼', text: `-0${m}7%` }, id)
      assert.deepEqual(deltaBadge(105, 100), { glyph: '▲', text: `+5${m}0%` }, id)
      assert.deepEqual(deltaBadge(110, 100), { glyph: '▲', text: '+10%' }, id)
      assert.equal(ratioText(3, 2), `1${m}5`, id)
    })
  }
  // The registry writes both marks: a test that saw only one would prove nothing about the other.
  assert.deepEqual([...marks].sort(), [',', '.'])
  // German by name: the spec's own example (§1 "What the user gets": `▼ -0,7%`).
  inLocale('de', () => assert.deepEqual(deltaBadge(99.3, 100), { glyph: '▼', text: '-0,7%' }))
})

test('decimalText: English prints the digits toFixed printed, byte for byte (1.10 B4)', () => {
  // A sweep over the values the badge, the plan factor and the durations see: the English output of every changed
  // site is what 1.9 wrote — the ties included (36.55 is 36.549999… in binary: toFixed wrote "36.5", and so does
  // decimalText, where Intl alone would round the printed decimal up to "36.6").
  assert.equal(decimalText(36.55, 1), '36.5')
  assert.equal(decimalText(1.005, 2), '1.00')
  assert.equal(decimalText(-0.04, 1), (-0.04).toFixed(1))
  inLocale('de', () => assert.equal(decimalText(36.55, 1), '36,5'))
  for (let i = 0; i <= 20_000; i++) {
    const n = (i * 7.31) / 97
    for (const d of [0, 1, 2]) assert.equal(decimalText(n, d), n.toFixed(d), `${n} ${d}`)
    assert.equal(ratioText(n, 1), n.toFixed(1))
  }
  assert.deepEqual(deltaBadge(105, 100), { glyph: '▲', text: '+5.0%' })
  assert.deepEqual(deltaBadge(100.2, 100), { glyph: '•', text: '+0.2%' })
})
