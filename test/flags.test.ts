// SPDX-FileCopyrightText: 2026 Frederik Marx
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * 1.9 A3b: the flags are markup the page writes into itself, so they are held to the page's rules
 * like any other markup: a small tag scan allows six elements and the attributes of FLAG_ATTRIBUTES,
 * and nothing that could load, run or style anything. Each drawing stays under a kilobyte, is hidden
 * from assistive technology and draws in one 3:2 box. The globe of `auto` is the one drawing that
 * follows the theme (`currentColor`); no country flag does.
 */

import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { FLAG_ATTRIBUTES, FLAG_ELEMENTS, FLAG_SVG, FLAG_VIEWBOX } from '../src/flags'
import { FlagId, LANGUAGES } from '../src/languages'

const FLAG_IDS: readonly FlagId[] = [
  'us', 'de', 'fr', 'es', 'br', 'it', 'jp', 'kr', 'cn', 'tw', 'ru', 'tr', 'pl', 'cz',
  // 1.11 A1 rule 2: the flags of tier 2, in the registry's order.
  'nl', 'ua', 'se', 'no', 'dk', 'fi', 'in', 'id', 'vn', 'gr', 'hu', 'ro',
]

/** Every tag of a drawing: its name, and each attribute with its value. */
function tags(svg: string): Array<{ name: string; closing: boolean; attrs: Array<[string, string]>; raw: string }> {
  const out: Array<{ name: string; closing: boolean; attrs: Array<[string, string]>; raw: string }> = []
  for (const m of svg.matchAll(/<(\/?)([A-Za-z][\w:-]*)([^>]*)>/g)) {
    const attrs: Array<[string, string]> = []
    const rest = m[3].replace(/\/\s*$/, '')
    // Every attribute is name="value": whatever is left over after taking them out is a finding.
    const leftover = rest.replace(/\s([\w:-]+)="([^"]*)"/g, (_all, name: string, value: string) => {
      attrs.push([name, value])
      return ''
    })
    assert.equal(leftover.trim(), '', `an attribute not written as name="value" in ${m[0]}`)
    out.push({ name: m[2], closing: m[1] === '/', attrs, raw: m[0] })
  }
  return out
}

test('twenty-seven drawings: one per flag of the registry, and the globe for auto (1.9 A3b; 1.11 A1 rule 2: fifteen → twenty-seven)', () => {
  assert.deepEqual(Object.keys(FLAG_SVG).sort(), [...FLAG_IDS, 'auto'].sort())
  assert.deepEqual([...new Set(LANGUAGES.map((e) => e.flag))].sort(), [...FLAG_IDS].sort())
  assert.ok(Object.isFrozen(FLAG_SVG))
  assert.equal(FLAG_VIEWBOX, '0 0 30 20')
})

test('each drawing: at most 1 KB, one <svg> in the 3:2 box, hidden from assistive technology, only the elements and attributes allowed, nothing that loads, runs or styles (1.9 A7 test 6)', () => {
  const allowedAttrs = new Set(FLAG_ATTRIBUTES)
  const allowedElems = new Set(FLAG_ELEMENTS)
  for (const [id, svg] of Object.entries(FLAG_SVG)) {
    assert.ok(Buffer.byteLength(svg, 'utf8') <= 1024, `${id}: ${Buffer.byteLength(svg, 'utf8')} bytes`)
    assert.ok(svg.startsWith('<svg'), `${id} does not start with <svg`)
    assert.ok(svg.endsWith('</svg>'), `${id} does not end with </svg>`)
    const all = tags(svg)
    // The text between the tags is empty: a drawing says nothing a screen reader or a search could find.
    assert.equal(svg.replace(/<[^>]*>/g, ''), '', `${id} carries text`)
    const opening = all[0]
    assert.equal(opening.name, 'svg')
    const attr = (name: string): string | undefined => opening.attrs.find(([n]) => n === name)?.[1]
    assert.equal(attr('aria-hidden'), 'true', id)
    assert.equal(attr('focusable'), 'false', id)
    assert.equal(attr('viewBox'), FLAG_VIEWBOX, id)
    assert.equal(all.filter((x) => x.name === 'svg').length, 2, `${id}: one <svg> and its end, no nested one`)
    for (const tag of all) {
      assert.ok(allowedElems.has(tag.name), `${id}: <${tag.name}> is not allowed`)
      for (const [name, value] of tag.attrs) {
        assert.ok(allowedAttrs.has(name), `${id}: the attribute ${name} is not allowed (${tag.raw})`)
        // A value is a number list, a colour, a word or a transform — never a reference to anything.
        assert.doesNotMatch(value, /url\(|javascript:|[<>&]/i, `${id}: ${name}="${value}"`)
      }
    }
    // No URL of any kind, the SVG namespace's included: the page carries these into the shipped
    // bundle, whose every http(s) literal the privacy scan holds to its allow-list.
    for (const banned of [/https?:/i, /\shref=/, /\sxlink:/, /\sstyle=/, /\son[a-z]+=/i, /url\(/, /<script/i, /<foreignObject/i, /<use\b/, /<image\b/, /<style/i, /<a\b/]) {
      assert.doesNotMatch(svg, banned, `${id} matches ${banned}`)
    }
  }
})

test('the globe draws in currentColor and nothing else; every country flag keeps its own colours', () => {
  const colours = (svg: string): string[] => [...svg.matchAll(/\s(?:fill|stroke)="([^"]*)"/g)].map((m) => m[1])
  const globe = colours(FLAG_SVG.auto)
  assert.ok(globe.includes('currentColor'), 'the globe does not follow the theme')
  assert.deepEqual(globe.filter((c) => c !== 'currentColor' && c !== 'none'), [], 'the globe has a colour of its own')
  for (const id of FLAG_IDS) {
    assert.equal(FLAG_SVG[id].includes('currentColor'), false, `${id} follows the theme`)
    for (const c of colours(FLAG_SVG[id])) assert.match(c, /^#[0-9A-Fa-f]{3}(?:[0-9A-Fa-f]{3})?$/, `${id}: the colour ${c}`)
  }
})

test('the drawings are the flags Frederik and the lead chose: the US flag for English, Taiwan\'s for 繁體中文 (§7a Q2, Q3)', () => {
  const flagOf = (id: string): FlagId => LANGUAGES.find((e) => e.id === id)!.flag
  assert.equal(flagOf('en'), 'us')
  assert.equal(flagOf('zh-tw'), 'tw')
  assert.equal(flagOf('zh-cn'), 'cn')
  assert.equal(flagOf('pt-br'), 'br')
  assert.equal(flagOf('cs'), 'cz')
  // The US flag: thirteen stripes (six white strokes on red), a blue canton, fifty dots in nine rows.
  const us = FLAG_SVG.us
  assert.ok(us.includes('fill="#B22234"') && us.includes('fill="#3C3B6E"'))
  const dots = /<path d="([^"]*)" stroke="#FFF" stroke-width="\.6"\/>/.exec(us)
  assert.ok(dots, 'no dot grid in the canton')
  assert.equal((dots[1].match(/h\.6/g) ?? []).length, 50, 'the canton has not fifty dots')
  assert.equal((dots[1].match(/M/g) ?? []).length, 9, 'the dots are not nine rows')
  // Taiwan's: a red field, the blue canton a quarter of it, a twelve-rayed white sun.
  const tw = FLAG_SVG.tw
  assert.ok(tw.includes('fill="#FE0000"') && tw.includes('<rect width="15" height="10" fill="#000095"/>'))
  const rays = /<polygon points="([^"]*)" fill="#FFFFFF"\/>/.exec(tw)
  assert.ok(rays)
  assert.equal(rays[1].trim().split(/\s+/).length, 24, 'the sun has not twelve rays')
})

// ---------------------------------------------------------------------------
// 1.11 A1 rule 2: the twelve flags of tier 2, each against its public construction
// ---------------------------------------------------------------------------

/** A number of a drawing, as it is written there. */
const num = (v: string | undefined): number => (v === undefined ? 0 : Number(v))
/** The attributes of every tag named `name` in a drawing, in the order drawn. */
const all = (svg: string, name: string): Array<Record<string, string>> =>
  tags(svg).filter((x) => x.name === name && !x.closing).map((x) => Object.fromEntries(x.attrs))

/**
 * The colour a drawing paints at (x, y), from its `<rect>`s alone — the later one on top, as SVG paints them. A flag of
 * bands is rects only; for one with more (India's chakra) the point is taken where nothing else is drawn.
 */
function colourAt(svg: string, x: number, y: number): string | null {
  let out: string | null = null
  for (const r of all(svg, 'rect')) {
    const x0 = num(r.x)
    const y0 = num(r.y)
    if (x >= x0 && x < x0 + num(r.width) && y >= y0 && y < y0 + num(r.height)) out = r.fill
  }
  return out
}

/** Three (or two) equal bands, in their order: the colour at the middle of each and just inside each edge. */
function bands(svg: string, direction: 'horizontal' | 'vertical', colours: readonly string[], at = 5): void {
  const length = direction === 'horizontal' ? 20 : 30
  const band = length / colours.length
  const point = (along: number): [number, number] => (direction === 'horizontal' ? [at, along] : [along, 10])
  colours.forEach((c, i) => {
    for (const along of [i * band + 0.1, (i + 0.5) * band, (i + 1) * band - 0.1]) {
      assert.equal(colourAt(svg, ...point(along)), c, `${direction} band ${i + 1} at ${along.toFixed(2)}`)
    }
  })
}

test('the tricolours and bicolours of 1.11: equal bands in their order — the Netherlands, Hungary and Romania in three, Ukraine and Indonesia in two, drawn in rects alone (1.11 A1 rule 2)', () => {
  const rectsOnly = (svg: string): boolean => tags(svg).every((x) => x.name === 'svg' || x.name === 'rect')
  const cases: Array<[FlagId, 'horizontal' | 'vertical', string[]]> = [
    ['nl', 'horizontal', ['#AE1C28', '#FFFFFF', '#21468B']],
    ['hu', 'horizontal', ['#CE2939', '#FFFFFF', '#477050']],
    ['ro', 'vertical', ['#002B7F', '#FCD116', '#CE1126']],
    ['ua', 'horizontal', ['#0057B7', '#FFD700']],
    ['id', 'horizontal', ['#FF0000', '#FFFFFF']],
  ]
  for (const [id, direction, colours] of cases) {
    assert.ok(rectsOnly(FLAG_SVG[id]), `${id} draws more than bands`)
    bands(FLAG_SVG[id], direction, colours)
    // Every corner of the box is painted: the first rect is the whole field.
    assert.deepEqual([all(FLAG_SVG[id], 'rect')[0].width, all(FLAG_SVG[id], 'rect')[0].height], ['30', '20'], id)
  }
  // Indonesia is red over white, never Poland's white over red.
  assert.notEqual(colourAt(FLAG_SVG.id, 15, 5), colourAt(FLAG_SVG.pl, 15, 5))
})

test('the Nordic crosses in their own proportions: arms as wide and hoist fields as the flag\'s units give them, the unit set by the height — so the vertical bar stands off-centre toward the hoist and the horizontal one in the middle (1.11 A1 rule 2)', () => {
  // [flag, field, cross colours from the outside in, the hoist field's width, the arms' widths (outside in), the field's height] in the flag's units.
  const crosses: Array<[FlagId, string, string[], number, number[], number]> = [
    ['se', '#006AA7', ['#FECC00'], 5, [2], 4],
    ['no', '#BA0C2F', ['#FFFFFF', '#00205B'], 6, [4, 2], 6],
    ['dk', '#C8102E', ['#FFFFFF'], 12, [4], 12],
    ['fi', '#FFFFFF', ['#002F6C'], 5, [3], 4],
  ]
  for (const [id, field, colours, hoist, arms, height] of crosses) {
    const svg = FLAG_SVG[id]
    assert.equal(svg.split('<rect ').length - 1, 1, `${id}: one field`)
    assert.deepEqual(all(svg, 'rect')[0], { width: '30', height: '20', fill: field }, id)
    const unit = 20 / (2 * height + arms[0])
    const paths = all(svg, 'path')
    assert.equal(paths.length, colours.length, `${id}: one cross per colour`)
    paths.forEach((p, i) => {
      const m = /^M([\d.]+) 0v20M0 ([\d.]+)h30$/.exec(p.d)
      assert.ok(m, `${id}: the cross ${p.d} is not one vertical and one horizontal arm across the whole flag`)
      assert.equal(p.stroke, colours[i], id)
      const centre = (hoist + arms[0] / 2) * unit
      assert.ok(Math.abs(Number(m[1]) - centre) < 0.01, `${id}: the vertical arm at ${m[1]}, the construction puts it at ${centre.toFixed(3)}`)
      assert.ok(Number(m[1]) < 15, `${id}: the vertical arm is not toward the hoist`)
      assert.equal(Number(m[2]), 10, `${id}: the horizontal arm is not in the middle`)
      assert.ok(Math.abs(Number(p['stroke-width']) - arms[i] * unit) < 0.01, `${id}: the arm is ${p['stroke-width']} wide, the construction says ${(arms[i] * unit).toFixed(3)}`)
    })
  }
})

test('Greece: nine stripes, blue first and last, and a white cross in a square blue canton five stripes high (1.11 A1 rule 2)', () => {
  const gr = FLAG_SVG.gr
  const stripe = 20 / 9
  const [field, canton] = all(gr, 'rect')
  assert.deepEqual(field, { width: '30', height: '20', fill: '#0D5EAF' })
  const [stripes, cross] = all(gr, 'path')
  // Four white strokes on the blue field make nine stripes: blue, white, blue … blue.
  const ys = [...stripes.d.matchAll(/M0 ([\d.]+)h30/g)].map((m) => Number(m[1]))
  assert.equal(stripes.d.replace(/M0 [\d.]+h30/g, ''), '', 'the stripes are not whole-width lines')
  assert.deepEqual(ys.map((y) => Math.round((y / stripe - 0.5) * 100) / 100), [1, 3, 5, 7], 'the white stripes are not the 2nd, 4th, 6th and 8th of nine')
  assert.equal(stripes.stroke, '#FFFFFF')
  assert.ok(Math.abs(Number(stripes['stroke-width']) - stripe) < 0.01)
  // The canton: a square of five stripes, blue, over the stripes; the cross one stripe wide through its middle.
  assert.equal(canton.fill, '#0D5EAF')
  assert.ok(Math.abs(Number(canton.width) - 5 * stripe) < 0.01 && canton.width === canton.height, 'the canton is not a square five stripes high')
  assert.equal(num(canton.x) + num(canton.y), 0)
  const m = /^M([\d.]+) 0v([\d.]+)M0 ([\d.]+)h([\d.]+)$/.exec(cross.d)
  assert.ok(m, `the canton's cross ${cross.d}`)
  const side = Number(canton.width)
  assert.deepEqual([Number(m[2]), Number(m[4])], [side, side], 'the cross does not span the canton')
  for (const at of [Number(m[1]), Number(m[3])]) assert.ok(Math.abs(at - side / 2) < 0.01, 'the cross is not in the canton\'s middle')
  assert.equal(cross.stroke, '#FFFFFF')
  assert.ok(Math.abs(Number(cross['stroke-width']) - stripe) < 0.01)
  // Painted in this order: the stripes, then the canton over them, then the cross.
  assert.ok(gr.indexOf(stripes.d) < gr.indexOf('<rect width="11.11"') && gr.indexOf('<rect width="11.11"') < gr.indexOf(cross.d))
})

test('India: saffron, white and green in three equal bands, the chakra in navy in the middle — a ring three quarters of the white band high and 24 spokes (1.11 A1 rule 2)', () => {
  const svg = FLAG_SVG.in
  bands(svg, 'horizontal', ['#FF9933', '#FFFFFF', '#138808'])
  // The ring: a navy disc and a white one inside it (Taiwan's sun ring is drawn so — a country flag has no `none`).
  const [outer, inner, hub] = all(svg, 'circle')
  for (const c of [outer, inner, hub]) assert.deepEqual([c.cx, c.cy], ['15', '10'])
  assert.deepEqual([outer.fill, inner.fill, hub.fill], ['#000080', '#FFFFFF', '#000080'])
  assert.ok(Number(hub.r) < Number(inner.r) && Number(inner.r) < Number(outer.r))
  // The ring's outer edge: three quarters of the white band (20/3) across.
  assert.ok(Math.abs(2 * Number(outer.r) - (3 / 4) * (20 / 3)) < 0.01, 'the chakra is not ¾ of the white band')
  const ring = { r: String((Number(outer.r) + Number(inner.r)) / 2) }
  const [spokes] = all(svg, 'path')
  assert.equal(spokes.stroke, '#000080')
  const segments = [...spokes.d.matchAll(/M([\d.]+) ([\d.]+)L([\d.]+) ([\d.]+)/g)].map((m) => m.slice(1).map(Number))
  assert.equal(spokes.d.replace(/M[\d.]+ [\d.]+L[\d.]+ [\d.]+/g, ''), '', 'the spokes are not straight segments')
  // Twelve diameters through the centre, 15° apart: 24 spokes.
  assert.equal(segments.length, 12)
  const angles = segments.map(([x1, y1, x2, y2]) => {
    assert.ok(Math.abs((x1 + x2) / 2 - 15) < 0.006 && Math.abs((y1 + y2) / 2 - 10) < 0.006, `the segment ${x1} ${y1} ${x2} ${y2} does not pass through the centre`)
    assert.ok(Math.abs(Math.hypot(x1 - 15, y1 - 10) - Number(ring.r)) < 0.01, 'a spoke does not reach the middle of the ring')
    return ((Math.atan2(y1 - y2, x1 - x2) * 180) / Math.PI + 180) % 180
  }).sort((a, b) => a - b)
  angles.forEach((a, i) => assert.ok(Math.abs(a - i * 15) < 0.5, `the spokes are not 15° apart: ${angles.map((x) => x.toFixed(1)).join(' ')}`))
})

test('Vietnam: one yellow five-pointed star on red, its points on a circle a fifth of the length around the middle (1.11 A1 rule 2)', () => {
  const vn = FLAG_SVG.vn
  assert.deepEqual(all(vn, 'rect'), [{ width: '30', height: '20', fill: '#DA251D' }])
  const stars = all(vn, 'polygon')
  assert.equal(stars.length, 1, 'not one star')
  assert.equal(stars[0].fill, '#FFFF00')
  const points = stars[0].points.trim().split(/\s+/).map((p) => p.split(',').map(Number))
  assert.equal(points.length, 5, 'not five points')
  // Drawn in the pentagram's order (every second point, 144° apart), as China's stars are, the first one straight up.
  points.forEach(([x, y], i) => {
    assert.ok(Math.abs(Math.hypot(x - 15, y - 10) - 6) < 0.01, `point ${i + 1} is not on the circle of radius 6`)
    const angle = (Math.atan2(y - 10, x - 15) * 180) / Math.PI
    const want = ((-90 + i * 144 + 180) % 360 + 360) % 360 - 180
    assert.ok(Math.abs(angle - want) < 0.2, `point ${i + 1} at ${angle.toFixed(1)}°, the star puts it at ${want}°`)
  })
})

test('the flags of 1.11 are the countries the spec names for the languages: a country, not a language (1.11 A1 rule 1)', () => {
  const flagOf = (id: string): FlagId | undefined => LANGUAGES.find((e) => e.id === id)?.flag
  assert.deepEqual(['nl', 'uk', 'sv', 'nb', 'da', 'fi', 'hi', 'id', 'vi', 'el', 'hu', 'ro'].map(flagOf),
    ['nl', 'ua', 'se', 'no', 'dk', 'fi', 'in', 'id', 'vn', 'gr', 'hu', 'ro'])
  // Byte sizes stay small: India's chakra is the largest drawing of the twelve.
  const sizes = FLAG_IDS.slice(14).map((id) => Buffer.byteLength(FLAG_SVG[id], 'utf8'))
  assert.ok(Math.max(...sizes) === Buffer.byteLength(FLAG_SVG.in, 'utf8') && Math.max(...sizes) <= 1024, sizes.join(' '))
})
