// SPDX-FileCopyrightText: 2026 Frederik Marx
// SPDX-License-Identifier: AGPL-3.0-or-later

import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import {
  ageMinutes, BarOptions, compact, DEFAULT_BAR, deltaBadge, estimate, extraUsageText, full,
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
  assert.equal(severity(42, 40), 'ok')
  assert.equal(severity(10, null), 'ok')
  const now = 1_000_000_000_000
  assert.equal(windowElapsed(now + 150 * 60_000, 300, now), 50)
  const days = lastDays(3, now)
  assert.equal(days.length, 3)
  assert.match(days[2], /^\d{4}-\d{2}-\d{2}$/)
})
