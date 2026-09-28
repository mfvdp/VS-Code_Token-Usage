// SPDX-FileCopyrightText: 2026 Frederik Marx
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * 1.13 A3 (§0a.3): the bidi format characters Token Pace hands to VS Code — the one module that writes them.
 *
 * VS Code's workbench has no right-to-left layout: the status bar, its hovers, the Quick Pick, the notifications and
 * the dialogs lay every text out left to right whatever the display language. An Arabic, Hebrew or Persian sentence
 * with a Latin name or a figure in it then reads in the wrong order ("Claude 5h 25% · إعادة الضبط 14:20" begins
 * with its Latin name, so the whole line runs left to right). The helpers below mark such a text for the surface it
 * is handed to, and nothing else:
 *
 *  • `isolate` makes it a right-to-left paragraph of its own inside the left-to-right one — RLI … PDI (§7a Q7:
 *    not FSI, whose first strong character would be that Latin name) —, each figure, clock, day, money figure and
 *    identifier inside as a left-to-right unit LRI … PDI (§7a Q5, the page's grammar: FIGURE_GRAMMAR), the leading
 *    `$(icon)` tokens outside at the start (§7a Q29 — VS Code draws an item's icon at its left edge);
 *  • `isolateLines` does it per line (a line break ends a bidi paragraph — a hard-wrapped dialog detail);
 *  • `isolateMarkdown` does it inside the markdown a status-bar tooltip is made of, never where a mark would change
 *    what the markdown is (MARKDOWN_LINE_KINDS);
 *  • `leadRtl` puts one RLM in front of a text that leaves Token Pace (a notification, §7a Q11), which a chat or push
 *    client lays out by its first strong character.
 *
 * Every helper returns its input unchanged — byte for byte — when the words' language is written left to right
 * (i18n.ts `dir()`, the words' language's, never VS Code's), and adds characters only: `stripBidi` of the result is
 * the input whenever the input carried none. The marks never go into a translation (T16), a `t()` result, the page
 * (it has its own `dir`), an accessible name, the markdown document, a log line, the diagnostics, an export or a
 * notification's JSON data fields (§0a.3's leak test). Every control is written here as an escape, never as the
 * character itself (VS Code 1.62's Trojan Source rule, held over `src/` by test/bidi.test.ts).
 *
 * No `vscode` import: the status bar's texts are built by the pure statusText.ts, which the tests load.
 */

import { dir } from './i18n'
import type { TextDirection } from './languages'

/** LEFT-TO-RIGHT ISOLATE, RIGHT-TO-LEFT ISOLATE, POP DIRECTIONAL ISOLATE, RIGHT-TO-LEFT MARK. */
export const LRI = '\u2066'
export const RLI = '\u2067'
export const PDI = '\u2069'
export const RLM = '\u200F'
/** FIRST STRONG ISOLATE — never written (§7a Q7); named so that an isolate already in a text is recognised. */
const FSI = '\u2068'

/**
 * The bidi controls a translation never writes and an export never carries (T16, §0a.3): ALM U+061C, LRM U+200E,
 * RLM U+200F, LRE … RLO U+202A–U+202E, LRI … PDI U+2066–U+2069. ZWNJ U+200C and ZWJ U+200D are NOT among them —
 * Persian writes ZWNJ inside words (سه‌شنبه).
 */
export const BIDI_CONTROLS = /[\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/u
const BIDI_CONTROLS_ALL = new RegExp(BIDI_CONTROLS.source, 'gu')

/**
 * 1.13 A3 rule 3: what one left-to-right unit of a right-to-left line is — the page's grammar, string for string
 * (src/webview/main.ts FIGURE_GRAMMAR, P4's; the page's script is self-contained, so the grammar is written twice, and
 * test/bidi.test.ts holds the two equal and to the same figures over the bar fixture's texts). In the order a position
 * is tried: a range of two ISO days written with → (one unit), an ISO day, a clock, a money figure with its currency,
 * a figure with its mark (~ ⚠ ≈, < > ≤ ≥), sign, number, unit and a duration's further parts, a Latin name or
 * identifier (a model id whole, a path, a host, a setting's key, a product name of several words).
 */
export const FIGURE_GRAMMAR = {
  edge: '(?<![\\p{L}\\p{N}_])',
  end: '(?![\\p{L}\\p{N}])',
  space: '[ \\u00a0\\u202f]',
  range: '\\d{4}-\\d{2}-\\d{2}[ \\u00a0]?\\u2192[ \\u00a0]?\\d{4}-\\d{2}-\\d{2}',
  day: '\\d{4}-\\d{2}-\\d{2}',
  clock: '\\d{1,2}:\\d{2}(?::\\d{2})?(?:[ \\u00a0\\u202f]?(?:AM|PM|am|pm))?',
  money: '(?:[~\\u26a0\\u2248][ \\u00a0]?)?<?[\\u200e\\u200f\\u061c]*(?:(?:[A-Z]{1,3})?\\p{Sc}[ \\u00a0\\u202f]?[\\u200e\\u200f\\u061c]*\\d+(?:[.,\\u00a0\\u202f]\\d+)*'
    + '|\\d+(?:[.,\\u00a0\\u202f]\\d+)*[ \\u00a0\\u202f]?[\\u200e\\u200f\\u061c]*(?:[A-Z]{1,3})?\\p{Sc})',
  figure: '(?:[~\\u26a0\\u2248][ \\u00a0\\u202f]?)?(?:[<>\\u2264\\u2265][ \\u00a0\\u202f]?)?[+\\-\\u2212\\u00b1]?\\d+(?:[.,\\u00a0\\u202f]\\d+)*'
    + '(?:[ \\u00a0\\u202f]?(?:%|K|M|G|min|ms|h|d|m|s)(?!\\p{L})(?:[ \\u00a0\\u202f]?\\d+[ \\u00a0\\u202f]?(?:min|ms|h|m|s)(?!\\p{L}))*)?',
  name: '(?:[~\\p{Sc}]?\\/\\.?|\\.)?[A-Za-z0-9_]*[A-Za-z][A-Za-z0-9_]*(?:[\\-.:\\/@]+[A-Za-z0-9_]+)*'
    + '(?:[ \\u00a0](?:[~\\p{Sc}]?\\/\\.?|\\.)?[A-Za-z0-9_]*[A-Za-z][A-Za-z0-9_]*(?:[\\-.:\\/@]+[A-Za-z0-9_]+)*)*',
}

/** 1.13 A3 rule 3: the grammar as one pattern, its kinds as named groups — the page's FIGURE_RUN, the host's side. */
export const FIGURE_RE = new RegExp(FIGURE_GRAMMAR.edge + '(?:(?<range>' + FIGURE_GRAMMAR.range + ')|(?<day>' + FIGURE_GRAMMAR.day
  + ')|(?<clock>' + FIGURE_GRAMMAR.clock + ')|(?<money>' + FIGURE_GRAMMAR.money + ')|(?<figure>' + FIGURE_GRAMMAR.figure
  + ')|(?<name>' + FIGURE_GRAMMAR.name + '))' + FIGURE_GRAMMAR.end, 'gu')

/** A name is a unit only with a space, a connector or a path's ~ in it: a single word is one run already (the page's). */
export const FIGURE_NAME_UNIT = /[ \u00A0\-.:/@_~]/

/** VS Code's icon syntax, `$(name)` or `$(name~spin)` — parsed anywhere in a status-bar text, a label or a tooltip. */
const CODICON = /\$\([\w~-]+\)/gu
/** The leading icons of a text and the space after them — they stand before the isolate (§7a Q29). */
const LEADING_CODICONS = /^(?:\$\([\w~-]+\)[ \u00A0]*)+/u
/** A letter of a script written right to left (Hebrew, Arabic, Syriac, Thaana, N'Ko …, and their presentation forms). */
const RTL_LETTER = /[\u0590-\u08FF\uFB1D-\uFDFF\uFE70-\uFEFF]/u
const LETTER = /\p{L}/u
/** A range's arrow, either way: ← U+2190 (a right-to-left line's, rangeArrow) or → U+2192 (a hand-picked range's label). */
const ARROW = /[\u2190\u2192]/u

/**
 * 1.13 (Review 2 F1): whether a text has something to lay out — a letter, a range's arrow, or a figure unit of FIGURE_RE
 * (a letter-free line of two days, `2026-08-05 ← 2026-09-03`: a record streak's, a budget's period, a hand-picked range
 * beside its days — left as it was, VS Code's left-to-right Quick Pick laid its arrow out from the last day back to the
 * first). A text of punctuation alone, an empty one, a lone icon: nothing, and the line stays as it is.
 */
function laysOut(text: string): boolean {
  if (LETTER.test(text) || ARROW.test(text)) return true
  FIGURE_RE.lastIndex = 0
  for (let m = FIGURE_RE.exec(text); m !== null; m = FIGURE_RE.exec(text)) {
    if (m[0] === '') { FIGURE_RE.lastIndex++; continue }
    return true
  }
  return false
}

/**
 * Each unit of FIGURE_RE in `text` wrapped in LRI … PDI — the same units the page makes elements of (a name only as
 * FIGURE_NAME_UNIT says), nothing taken out: the characters stay in their logical order.
 */
function unitsOf(text: string): string {
  if (!/[0-9A-Za-z]/.test(text)) return text
  let out = ''
  let last = 0
  FIGURE_RE.lastIndex = 0
  for (let m = FIGURE_RE.exec(text); m !== null; m = FIGURE_RE.exec(text)) {
    if (m[0] === '') { FIGURE_RE.lastIndex++; continue }
    if (m.groups?.name !== undefined && !FIGURE_NAME_UNIT.test(m[0])) continue
    out += text.slice(last, m.index) + LRI + m[0] + PDI
    last = m.index + m[0].length
  }
  return last === 0 ? text : out + text.slice(last)
}

/**
 * The spans of a text that are left as they are — its `$(icon)` tokens and the isolates it already carries (a text
 * isolated before is isolated already: the helpers are idempotent) —, and the units made in the rest.
 */
function unitsAround(text: string): string {
  let out = ''
  let at = 0
  for (const [from, to] of keptSpans(text, [CODICON])) {
    out += unitsOf(text.slice(at, from)) + text.slice(from, to)
    at = to
  }
  return out + unitsOf(text.slice(at))
}

/** Where each isolate of `text` opens and where its PDI closes it (to the end when it is not closed). */
function isolateSpans(text: string): Array<[number, number]> {
  const out: Array<[number, number]> = []
  let depth = 0
  let from = -1
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (c === LRI || c === RLI || c === FSI) {
      if (depth === 0) from = i
      depth++
    } else if (c === PDI && depth > 0) {
      depth--
      if (depth === 0) out.push([from, i + 1])
    }
  }
  if (depth > 0) out.push([from, text.length])
  return out
}

/** The spans `patterns` match and the isolates, merged, in order. */
function keptSpans(text: string, patterns: readonly RegExp[]): Array<[number, number]> {
  const spans: Array<[number, number]> = [...isolateSpans(text)]
  for (const re of patterns) {
    re.lastIndex = 0
    for (let m = re.exec(text); m !== null; m = re.exec(text)) {
      if (m[0] === '') { re.lastIndex++; continue }
      spans.push([m.index, m.index + m[0].length])
    }
  }
  spans.sort((a, b) => a[0] - b[0] || b[1] - a[1])
  const merged: Array<[number, number]> = []
  for (const s of spans) {
    const top = merged[merged.length - 1]
    if (top && s[0] < top[1]) top[1] = Math.max(top[1], s[1])
    else merged.push([s[0], s[1]])
  }
  return merged
}

/** A text that is one isolate already, from its first character to its last. */
function wholeIsolate(text: string): boolean {
  const spans = isolateSpans(text)
  return spans.length === 1 && spans[0][0] === 0 && spans[0][1] === text.length && text.endsWith(PDI)
}

/** One line: its leading icons, then RLI, its units, PDI — or the line as it is when there is nothing to lay out (laysOut). */
function isolateLine(line: string): string {
  const icons = LEADING_CODICONS.exec(line)?.[0] ?? ''
  const rest = line.slice(icons.length)
  if (!laysOut(rest.replace(CODICON, '')) || wholeIsolate(rest)) return line
  return icons + RLI + unitsAround(rest) + PDI
}

/**
 * 1.13 A3 rules 2–4: `s` as a right-to-left paragraph of its own on a left-to-right surface — its leading `$(icon)`
 * tokens outside at the start, then RLI, the text with each figure run inside LRI … PDI, PDI —, when `d` (the words'
 * language's direction) is 'rtl' and the text holds a letter, a figure unit or a range's arrow (Review 2 F1); `s`
 * unchanged otherwise. A text of several lines is isolated line by line, as `isolateLines` does: a line break ends a
 * bidi paragraph, and an isolate across one would reach the first line only.
 */
export function isolate(s: string, d: TextDirection = dir()): string {
  if (d !== 'rtl' || typeof s !== 'string' || s === '') return s
  return s.includes('\n') ? s.split('\n').map(isolateLine).join('\n') : isolateLine(s)
}

/** `isolate` per line — a line break ends a bidi paragraph, so a hard-wrapped dialog detail needs one isolate per line. */
export function isolateLines(s: string, d: TextDirection = dir()): string {
  if (d !== 'rtl' || typeof s !== 'string' || s === '') return s
  return s.split('\n').map(isolateLine).join('\n')
}

// ---------------------------------------------------------------------------
// The tooltips' markdown
// ---------------------------------------------------------------------------

/**
 * 1.13 A3 rule 5: the kinds of line a status-bar tooltip is made of (statusText.ts), as isolateMarkdown knows them —
 * and where each takes its marks:
 *
 *   blank        nothing
 *   fence        a ``` line and every line inside the fence: nothing (code)
 *   separator    a table's `|---|---|` row: nothing
 *   table row    `| a | b |`: each cell's text, between its own spaces — never across a `|`
 *   list item    `- text` (also `*`, `+`, `1.`), heading `# text`, quote `> text`: the text after the marker
 *   links row    a line of `$(icon) [text](command:…)` links joined by ` · ` (the footer): each link's text inside its
 *                brackets — never across a link or an icon
 *   paragraph    every other line: its leading `$(icon)` tokens outside, then one isolate over the rest, opened after
 *                a leading run of emphasis marks and link brackets (`**`, `_`, `**[`) and closed before a trailing run
 *                (`**`, `_`, `](…)`) — inside the marks, so that `**` and `_` still open and close (a mark beside an
 *                emphasis delimiter on its outside changes whether it is one), never before a list marker, a `|`, a
 *                `*`, a `_`, a link's `[` or a fence
 *
 * Inside a line: a code span `…` whose text is written left to right is one left-to-right unit, whole (a model id,
 * a label, a plan's name); an HTML tag (the bar's colour spans), a link's destination and an `$(icon)` are left as
 * they are; the figures of the words are units as in `isolate`.
 */
export const MARKDOWN_LINE_KINDS = ['blank', 'fence', 'separator', 'table row', 'list item', 'links row', 'paragraph'] as const

const FENCE = /^ {0,3}(?:```|~~~)/
const SEPARATOR_ROW = /^ *\|?(?: *:?-{3,}:? *\|)+ *(?::?-{3,}:? *)?$/
const BLOCK_MARKER = /^( {0,3}(?:[-*+]|\d{1,9}[.)]|#{1,6}|>)[ \t]+)/
const CODE_SPAN = /`[^`\n]*`/gu
const HTML_TAG = /<\/?[A-Za-z][^<>\n]*>/gu
const LINK_DESTINATION = /\]\([^()\s]*\)/gu
const LINK = /\[([^\[\]\n]*)\]\(([^()\s]*)\)/gu

/** The text of a code span as one left-to-right unit when it is written left to right; the span itself otherwise. */
function codeUnit(span: string): string {
  const inner = span.slice(1, -1)
  return /[0-9A-Za-z]/.test(inner) && !RTL_LETTER.test(inner) ? LRI + span + PDI : span
}

/** The units of a stretch of markdown text: code spans whole, tags, destinations and icons as they are, figures inside the rest. */
function markdownUnits(text: string): string {
  let out = ''
  let at = 0
  for (const [from, to] of keptSpans(text, [CODE_SPAN, HTML_TAG, LINK_DESTINATION, CODICON])) {
    out += unitsOf(text.slice(at, from))
    const kept = text.slice(from, to)
    out += kept.startsWith('`') && kept.endsWith('`') && kept.length >= 2 ? codeUnit(kept) : kept
    at = to
  }
  return out + unitsOf(text.slice(at))
}

/** Whether a `[` at `at` opens a link — a `](` destination `)` closes it on this line. */
function opensLink(text: string, at: number): boolean {
  LINK.lastIndex = at
  const m = LINK.exec(text)
  return m !== null && m.index === at
}

/** A line of links, icons and ` · ` alone (the footer's actions). */
function linksRow(text: string): boolean {
  if (!/\[[^\]]*\]\(/.test(text)) return false
  return text.replace(LINK, '').replace(CODICON, '').replace(/[·\s]/gu, '') === ''
}

/** A stretch of inline markdown — a paragraph's text, a cell's, an item's — isolated as the rules of MARKDOWN_LINE_KINDS say. */
function isolateInline(text: string): string {
  const icons = LEADING_CODICONS.exec(text)?.[0] ?? ''
  const rest = text.slice(icons.length)
  if (!laysOut(rest.replace(CODICON, '').replace(LINK_DESTINATION, '').replace(HTML_TAG, '')) || wholeIsolate(rest)) return text
  if (linksRow(rest)) {
    return icons + rest.replace(LINK, (all, label: string, dest: string) =>
      (laysOut(label) && !wholeIsolate(label) ? `[${RLI}${unitsAround(label)}${PDI}](${dest})` : all))
  }
  // The opening run: emphasis marks and the `[` of a link that closes on the line.
  let open = 0
  for (;;) {
    const c = rest[open]
    if (c === '*' || c === '_') { open++; continue }
    if (c === '[' && opensLink(rest, open)) { open++; continue }
    break
  }
  // The closing run: emphasis marks and a link's `](…)` at the end.
  let close = rest.length
  for (;;) {
    const c = rest[close - 1]
    if (close > open && (c === '*' || c === '_')) { close--; continue }
    if (close > open && c === ')') {
      const head = rest.lastIndexOf('](', close)
      if (head > open && /^\]\([^()\s]*\)$/.test(rest.slice(head, close))) { close = head; continue }
    }
    break
  }
  const inner = rest.slice(open, close)
  if (!laysOut(inner.replace(CODICON, '').replace(LINK_DESTINATION, '').replace(HTML_TAG, '')) || wholeIsolate(inner)) return text
  return icons + rest.slice(0, open) + RLI + markdownUnits(inner) + PDI + rest.slice(close)
}

/** The cells of a table row, each isolated between its own spaces; the pipes (and an escaped `\|`) as they are. */
function isolateRow(line: string): string {
  const parts: string[] = []
  let cell = ''
  for (let i = 0; i < line.length; i++) {
    const c = line[i]
    if (c === '\\' && line[i + 1] === '|') { cell += '\\|'; i++; continue }
    if (c === '|') { parts.push(cell, '|'); cell = ''; continue }
    cell += c
  }
  parts.push(cell)
  return parts.map((p) => {
    if (p === '|') return p
    const lead = /^\s*/.exec(p)?.[0] ?? ''
    const trail = /\s*$/.exec(p.slice(lead.length))?.[0] ?? ''
    const body = p.slice(lead.length, p.length - trail.length)
    return body === '' ? p : lead + isolateInline(body) + trail
  }).join('')
}

/**
 * 1.13 A3 rule 5: the markdown of a status-bar tooltip with its texts isolated inside its structure — per line, as
 * MARKDOWN_LINE_KINDS lists them: after a list marker, inside each table cell, inside `_…_` and `**…**`, around a
 * link's text; never across a `|`, a separator row, an `$(icon)` or a link's `](…)`, never inside a fence. VS Code's
 * hover drops a `dir` attribute (its sanitizer allows none), so only the text can carry a direction there. The
 * markdown unchanged for a left-to-right language; `stripBidi` of the result is the input.
 */
export function isolateMarkdown(md: string, d: TextDirection = dir()): string {
  if (d !== 'rtl' || typeof md !== 'string' || md === '') return md
  let fenced = false
  return md.split('\n').map((line) => {
    if (FENCE.test(line)) { fenced = !fenced; return line }
    if (fenced || line.trim() === '' || SEPARATOR_ROW.test(line)) return line
    if (line.trimStart().startsWith('|')) return isolateRow(line)
    const marker = BLOCK_MARKER.exec(line)?.[1] ?? ''
    return marker + isolateInline(line.slice(marker.length))
  }).join('\n')
}

// ---------------------------------------------------------------------------
// A text that leaves Token Pace; a text that must be plain; a range's arrow
// ---------------------------------------------------------------------------

/**
 * 1.13 A3 rule 7 (§7a Q11): `s` with one RLM at the start of each of its lines when `d` is 'rtl' — a notification's
 * title and text, which a chat or push client lays out by the first strong character of a paragraph (HTML's
 * `dir=auto` rule): "Claude Code ينتظر إذنك" then runs right to left although it begins with a Latin name. Per line,
 * because a client may take each line as a paragraph of its own. No isolate (a client may show one); `s` unchanged
 * for a left-to-right language and for a line that begins with the mark already.
 */
export function leadRtl(s: string, d: TextDirection = dir()): string {
  if (d !== 'rtl' || typeof s !== 'string' || s === '') return s
  return s.split('\n').map((line) => (line === '' || line.startsWith(RLM) ? line : RLM + line)).join('\n')
}

/** For the tests and for any text that must be plain: every BIDI_CONTROLS character removed. */
export function stripBidi(s: string): string {
  return typeof s === 'string' ? s.replace(BIDI_CONTROLS_ALL, '') : s
}

/**
 * 1.13 (Review 1 F1): the arrow between the two ends of a range the host builds for one surface — the totals' and a
 * key figure's span, a Quick Pick's period —, pointing the way the line reads: ' → ' left to right, ' ← ' right to
 * left (the page's own ranges take theirs from the page's rangeArrow, src/webview/main.ts; a translation's from its
 * translator, T4). A hand-picked range's label (time.ts rangeFor) is data every outlet shares and keeps → (Review 2
 * F2: the page prints it as one left-to-right unit, the Quick Picks add their own arrow); the markdown document, the
 * exports and the log keep their own → (English data, or a text editor's left-to-right line).
 */
export function rangeArrow(d: TextDirection = dir()): string {
  return d === 'rtl' ? ' ← ' : ' → '
}

/**
 * 1.13 A3 rule 6 (§7a Q10): the accessible name VS Code derives for a status-bar item that carries none of its own
 * (read in VS Code 1.139.1's workbench, `setOrUpdateEntry`: each `$(icon)` as its name between spaces, trimmed, then
 * `, ` and the tooltip's text) — made here from the texts before they are isolated, so that an item of a
 * right-to-left language, whose text carries the isolates, still has an accessible name without a control.
 */
export function itemAriaLabel(text: string, tooltip?: string): string {
  const plain = stripBidi(text).replace(/\$\((.*?)\)/g, (_m, icon: string) => ` ${icon} `).trim()
  return tooltip ? `${plain}, ${stripBidi(tooltip)}` : plain
}
