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
  // 1.13 A1 rule 3 (§7a Q13): Egypt, Israel, Iran.
  'eg', 'il', 'ir',
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

test('thirty drawings: one per flag of the registry, and the globe for auto (1.9 A3b; 1.11 A1 rule 2: fifteen → twenty-seven; 1.13 A1 rule 3: → thirty)', () => {
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
  // Byte sizes stay small: India's chakra is the largest drawing of the twelve. 1.13 P2 (pinned and changed: every flag
  // after the fourteen): the twelve of 1.11 only — the emblems of 1.13 are larger, and held to 1 KB by the rule above.
  const sizes = FLAG_IDS.slice(14, 26).map((id) => Buffer.byteLength(FLAG_SVG[id], 'utf8'))
  assert.ok(Math.max(...sizes) === Buffer.byteLength(FLAG_SVG.in, 'utf8') && Math.max(...sizes) <= 1024, sizes.join(' '))
})

// ---------------------------------------------------------------------------
// 1.13 A1 rule 3 (§7a Q13): Egypt, Israel and Iran, each against its construction
// ---------------------------------------------------------------------------

/** Every point of a drawing's `d` or `points` data, as numbers — absolute commands (M L H V Q A z) and the relative m/h. */
function pointsOf(data: string): Array<[number, number]> {
  const out: Array<[number, number]> = []
  let x = 0
  let y = 0
  for (const m of data.matchAll(/([MLHVQAZmhz])([^MLHVQAZmhz]*)/g)) {
    const n = (m[2].match(/-?(?:\d+\.?\d*|\.\d+)/g) ?? []).map(Number)
    switch (m[1]) {
      case 'M': case 'L': for (let i = 0; i + 1 < n.length; i += 2) out.push([x = n[i], y = n[i + 1]]); break
      case 'm': for (let i = 0; i + 1 < n.length; i += 2) out.push([x += n[i], y += n[i + 1]]); break
      case 'H': out.push([x = n[0], y]); break
      case 'h': out.push([x += n[0], y]); break
      case 'V': out.push([x, y = n[0]]); break
      // A quadratic curve: its middle (t = ½ — where a symmetric curve like these turns) and its end; an arc: its end.
      case 'Q': out.push([(x + 2 * n[0] + n[2]) / 4, (y + 2 * n[1] + n[3]) / 4], [x = n[2], y = n[3]]); break
      case 'A': out.push([x = n[5], y = n[6]]); break
    }
  }
  return out
}
const polygonPoints = (p: string): Array<[number, number]> => p.trim().split(/\s+/).map((xy) => xy.split(',').map(Number) as [number, number])
/** The bounding box of every path and polygon of a drawing painted in `fill` — by its own attribute or its <g>'s. */
function box(svg: string, fill: string): { x0: number; x1: number; y0: number; y1: number; pts: Array<[number, number]> } {
  const pts: Array<[number, number]> = []
  // A path or polygon takes its fill from its own attribute or from the <g> around it.
  const g = new RegExp(`<g fill="${fill}">(.*?)</g>`).exec(svg)?.[1] ?? ''
  for (const t of tags(g)) {
    const a = Object.fromEntries(t.attrs)
    if (t.name === 'path') pts.push(...pointsOf(a.d))
    if (t.name === 'polygon') pts.push(...polygonPoints(a.points))
  }
  for (const p of all(svg, 'path').filter((a) => a.fill === fill)) pts.push(...pointsOf(p.d))
  const xs = pts.map(([x]) => x)
  const ys = pts.map(([, y]) => y)
  return { x0: Math.min(...xs), x1: Math.max(...xs), y0: Math.min(...ys), y1: Math.max(...ys), pts }
}

test('the flags of 1.13 are the countries §7a Q13 names for the languages — Egypt for Arabic, Israel for Hebrew, Iran for Persian — and each of them draws its bands in rects and its emblem in one colour (1.13 A1 rule 3)', () => {
  const flagOf = (id: string): FlagId | undefined => LANGUAGES.find((e) => e.id === id)?.flag
  assert.deepEqual(['ar', 'he', 'fa'].map(flagOf), ['eg', 'il', 'ir'])
  for (const id of ['eg', 'il', 'ir'] as const) {
    const size = Buffer.byteLength(FLAG_SVG[id], 'utf8')
    assert.ok(size <= 1024, `${id}: ${size} bytes`)
    // No fill="none" (the colours test holds it for every country flag): a stroked star is drawn as filled rings.
    assert.equal(FLAG_SVG[id].includes('"none"'), false, id)
  }
})

test('Israel: white, the two blue stripes 25 of 160 high at 15 from the edges, the Star of David of two equilateral triangles with horizontal bases, lines 5.5 of 160 wide, on the middle of the flag (1.13 A1 rule 3, the flag law of 1948)', () => {
  const il = FLAG_SVG.il
  const unit = 20 / 160
  const [field, top, bottom] = all(il, 'rect')
  assert.deepEqual(field, { width: '30', height: '20', fill: '#FFFFFF' })
  for (const [stripe, y] of [[top, 15], [bottom, 160 - 15 - 25]] as const) {
    assert.equal(stripe.fill, '#0038B8')
    assert.equal(stripe.width, '30')
    assert.ok(Math.abs(num(stripe.y) - y * unit) < 1e-9 && Math.abs(num(stripe.height) - 25 * unit) < 1e-9, `a stripe at ${stripe.y}, ${stripe.height} high`)
  }
  // The white between the stripes and the edges, and in the middle — the stripes are where the law puts them.
  for (const y of [0.5, 1.8, 5.1, 10, 14.9, 18.2, 19.5]) assert.equal(colourAt(il, 5, y), '#FFFFFF', `y ${y}`)
  for (const y of [2, 4.9, 15.1, 18]) assert.equal(colourAt(il, 5, y), '#0038B8', `y ${y}`)
  // The star: one blue path of four triangles — for each of the two, its outer edge and its inner one (wound the other
  // way, so the nonzero rule leaves the inside white).
  const [star] = all(il, 'path')
  assert.equal(star.fill, '#0038B8')
  const triangles = star.d.split('z').filter((x) => x !== '').map((x) => pointsOf(x))
  assert.equal(triangles.length, 4)
  const side = (a: [number, number], b: [number, number]): number => Math.hypot(a[0] - b[0], a[1] - b[1])
  const area = (t: Array<[number, number]>): number => t.reduce((sum, [x, y], i) => { const [x2, y2] = t[(i + 1) % 3]; return sum + x * y2 - x2 * y }, 0) / 2
  const radii: number[] = []
  triangles.forEach((t, i) => {
    assert.equal(t.length, 3, `triangle ${i + 1}`)
    const sides = [side(t[0], t[1]), side(t[1], t[2]), side(t[2], t[0])]
    assert.ok(Math.max(...sides) - Math.min(...sides) < 0.03, `triangle ${i + 1} is not equilateral: ${sides.map((x) => x.toFixed(3))}`)
    // Centred on the flag, its base parallel to the stripes (two corners on one height).
    const cx = t.reduce((a, [x]) => a + x, 0) / 3
    const cy = t.reduce((a, [, y]) => a + y, 0) / 3
    assert.ok(Math.abs(cx - 15) < 0.01 && Math.abs(cy - 10) < 0.01, `triangle ${i + 1} is centred at ${cx.toFixed(3)} ${cy.toFixed(3)}`)
    assert.ok(Math.abs(t[1][1] - t[2][1]) < 1e-9, `triangle ${i + 1}'s base is not horizontal`)
    radii.push(side(t[0], [cx, cy]))
    // Outer triangles (1st, 3rd) wound one way, inner ones (2nd, 4th) the other: the rings are drawn, not two solid stars.
    assert.equal(Math.sign(area(t)), i % 2 === 0 ? 1 : -1, `triangle ${i + 1} is wound the wrong way`)
  })
  // The first pair points up, the second down: a hexagram, not one triangle drawn twice.
  assert.ok(triangles[0][0][1] < 10 && triangles[2][0][1] > 10)
  // Each line 5.5 of 160 wide (an equilateral triangle's outer and inner edges lie (R − r) / 2 apart), its middle on a
  // circle of 29.141 of 160 — the common drawing's size, which the law leaves open.
  for (const [outer, inner] of [[radii[0], radii[1]], [radii[2], radii[3]]]) {
    assert.ok(Math.abs((outer - inner) / 2 - 5.5 * unit) < 0.01, `the star's line is ${((outer - inner) / 2).toFixed(3)} wide`)
    assert.ok(Math.abs((outer + inner) / 2 - 29.141 * unit) < 0.01, `the star's line runs at ${((outer + inner) / 2).toFixed(3)} from the centre`)
  }
  // The star stays inside the white middle band.
  const b = box(il, '#0038B8')
  assert.ok(b.y0 > 5 && b.y1 < 15, `the star spans ${b.y0}–${b.y1}`)
})

test('Egypt: red, white and black in three equal bands, and the eagle as one golden silhouette in the middle of the white band — never Yemen\'s plain tricolour (1.13 A1 rule 3)', () => {
  const eg = FLAG_SVG.eg
  bands(eg, 'horizontal', ['#CE1126', '#FFFFFF', '#000000'])
  assert.deepEqual(all(eg, 'rect')[0], { width: '30', height: '20', fill: '#000000' })
  // The eagle: every shape of it golden, in one <g>, and nothing else golden or of another colour beside the bands.
  const golden = /<g fill="#C09300">(.*?)<\/g>/.exec(eg)
  assert.ok(golden, 'no golden eagle')
  const shapes = tags(golden[1]).filter((t) => !t.closing)
  assert.ok(shapes.length >= 3 && shapes.every((t) => t.name === 'path' && t.attrs.every(([n]) => n === 'd')), 'the eagle is not plain golden shapes')
  assert.deepEqual([...eg.matchAll(/fill="([^"]*)"/g)].map((m) => m[1]).sort(), ['#000000', '#C09300', '#CE1126', '#FFFFFF'])
  // Inside the white band, centred across the flag, about two thirds of the band high.
  const b = box(eg, '#C09300')
  assert.ok(b.y0 > 20 / 3 && b.y1 < 40 / 3, `the eagle spans ${b.y0}–${b.y1}`)
  assert.ok(Math.abs((b.x0 + b.x1) / 2 - 15) < 0.1, `the eagle is not centred: ${b.x0}–${b.x1}`)
  assert.ok(b.y1 - b.y0 > (2 / 3) * (20 / 3), `the eagle is ${(b.y1 - b.y0).toFixed(2)} high`)
  // The wings are symmetric about the middle: every point of the wings' path has its mirror image.
  const wings = tags(golden[1]).find((t) => t.name === 'path' && /V11/.test(t.attrs[0][1]))
  assert.ok(wings, 'no wings')
  const wp = pointsOf(wings.attrs[0][1])
  for (const [x, y] of wp) assert.ok(wp.some(([x2, y2]) => Math.abs(x + x2 - 30) < 0.01 && Math.abs(y - y2) < 0.01), `the wing point ${x} ${y} has no mirror image`)
})

test('Iran: green, white and red in three equal bands, the emblem as one red silhouette a quarter of the height high in the middle, and the takbir as eleven short white strokes along each edge of the white band — inside the green band above it and the red band below it (1.13 A1 rule 3)', () => {
  const ir = FLAG_SVG.ir
  bands(ir, 'horizontal', ['#239F40', '#FFFFFF', '#DA0000'])
  // The takbir: one white path of 22 strokes, eleven per row, all of one length, evenly spaced across the flag.
  const [takbir] = all(ir, 'path').filter((p) => p.stroke === '#FFFFFF')
  assert.ok(takbir, 'no takbir')
  const pts = pointsOf(takbir.d)
  assert.equal(pts.length, 44, 'not 22 strokes')
  const strokes = Array.from({ length: 22 }, (_v, i) => [pts[2 * i], pts[2 * i + 1]] as const)
  for (const [a, b] of strokes) assert.ok(Math.abs(a[1] - b[1]) < 1e-9 && Math.abs(b[0] - a[0] - 2) < 1e-9, 'a stroke is not a short horizontal line')
  const rows = [strokes.slice(0, 11), strokes.slice(11)]
  const halfWidth = num(takbir['stroke-width']) / 2
  rows.forEach((row, r) => {
    const y = row[0][0][1]
    assert.ok(row.every(([a]) => a[1] === y), `row ${r + 1} is not one line`)
    // Inside its band and close to the white band's edge: the green band's lower edge, the red band's upper edge.
    const edge = r === 0 ? 20 / 3 : 40 / 3
    const inside = r === 0 ? edge - (y + halfWidth) : (y - halfWidth) - edge
    assert.ok(inside > 0 && inside < 1, `row ${r + 1} is ${inside.toFixed(2)} from its edge`)
    const gaps = row.slice(1).map(([a], i) => a[0] - row[i][0][0])
    assert.ok(gaps.every((g) => Math.abs(g - 30 / 11) < 0.01), `row ${r + 1}: the strokes are not evenly spaced across the flag`)
    assert.ok(Math.abs(row[0][0][0] - (30 - row[10][1][0])) < 0.05, `row ${r + 1} is not centred`)
  })
  // The emblem: red, in one <g>; inside the white band, centred, a quarter of the flag's height from its top to its foot.
  const b = box(ir, '#DA0000')
  assert.ok(b.y0 > 20 / 3 && b.y1 < 40 / 3, `the emblem spans ${b.y0}–${b.y1}`)
  assert.ok(Math.abs((b.x0 + b.x1) / 2 - 15) < 0.01, `the emblem is not centred: ${b.x0}–${b.x1}`)
  assert.ok(Math.abs(b.y1 - b.y0 - 20 / 4) < 0.05, `the emblem is ${(b.y1 - b.y0).toFixed(2)} high, not a quarter of the flag`)
  // Its two halves mirror each other: the left half's path is the right half's with x → 30 − x.
  const halves = /<g fill="#DA0000"><path d="([^"]*)"\/><path d="([^"]*)"\/>/.exec(ir)
  assert.ok(halves, 'the emblem is not two halves')
  const [right, left] = [pointsOf(halves[1]), pointsOf(halves[2])]
  assert.equal(right.length, left.length)
  right.forEach(([x, y], i) => assert.ok(Math.abs(x + left[i][0] - 30) < 0.01 && Math.abs(y - left[i][1]) < 0.01, `point ${i + 1} of the emblem's halves is not mirrored`))
  // The sword between them, on the middle line.
  const [sword] = all(ir, 'polygon')
  const sp = polygonPoints(sword.points)
  assert.ok(sp.every(([x]) => Math.abs(x - 15) < 0.35) && Math.abs(Math.max(...sp.map(([, y]) => y)) - 12.5) < 0.01, 'the sword is not on the middle line down to the emblem\'s foot')
})
