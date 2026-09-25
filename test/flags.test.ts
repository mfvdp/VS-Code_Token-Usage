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

const FLAG_IDS: readonly FlagId[] = ['us', 'de', 'fr', 'es', 'br', 'it', 'jp', 'kr', 'cn', 'tw', 'ru', 'tr', 'pl', 'cz']

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

test('fifteen drawings: one per flag of the registry, and the globe for auto', () => {
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
