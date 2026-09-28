// SPDX-FileCopyrightText: 2026 Frederik Marx
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The manifest no longer carries its own prose: every user-visible string is a `%key%` that
 * VS Code resolves out of `package.nls.json` (or `package.nls.<locale>.json`). The tests that
 * pin that prose — the README parity in `docs.test.ts`, the settings checks in
 * `config.test.ts` — must therefore read the *resolved* manifest, or they would only ever see
 * the placeholders and pass on an empty promise.
 *
 * `resolveNls` follows VS Code's own rule (`extensionNls.ts`): a value is replaced only when
 * it is *exactly* `%key%`, never as a substring. That is what keeps `%USERPROFILE%\\.claude`
 * inside a description from being mistaken for a translation key.
 */

import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

// Every test is bundled into a single file in `out-test/`, so `__dirname` is that directory
// at runtime — one level below the repository root, wherever the source of this helper sits.
export const ROOT = join(__dirname, '..')

/** Anchored on purpose — see the note above. */
export const NLS_KEY = /^%([\w.\-]+)%$/

export const readJson = (name: string): unknown => JSON.parse(readFileSync(join(ROOT, name), 'utf8'))

export const englishNls = readJson('package.nls.json') as Record<string, string>
export const germanNls = readJson('package.nls.de.json') as Record<string, string>

/**
 * 1.9 B3: every translation of the manifest on disk — `package.nls.<id>.json`, German among them —
 * with its id and its table, in file-name order. `root` is the repository unless a test names a
 * temporary directory holding a synthetic language.
 */
export function nlsFiles(root: string = ROOT): Array<{ id: string; file: string; nls: Record<string, string> }> {
  return readdirSync(root)
    .map((file) => ({ file, m: /^package\.nls\.(.+)\.json$/.exec(file) }))
    .filter((x): x is { file: string; m: RegExpExecArray } => x.m !== null)
    .sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0))
    .map(({ file, m }) => ({ id: m[1], file, nls: JSON.parse(readFileSync(join(root, file), 'utf8')) as Record<string, string> }))
}

/**
 * 1.10 B1: the manifest keys a language has not translated or reviewed yet — the `nls` map of its pending list,
 * `l10n/pending/<id>.json`, which scripts/l10n-rekey.mjs writes when the English changes. Such a key holds the English
 * (added) or a translation of the English before the change (reworded), so a rule that compares a value with today's
 * English skips it; test/l10n.languages.test.ts (T14) allows no pending list once PENDING_ALLOWED is false (the join).
 */
export function pendingNlsKeys(id: string, root: string = ROOT): Set<string> {
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(join(root, 'l10n', 'pending', `${id}.json`), 'utf8'))
  } catch {
    return new Set()
  }
  const nls = (parsed as { nls?: unknown } | null)?.nls
  return typeof nls === 'object' && nls !== null && !Array.isArray(nls) ? new Set(Object.keys(nls)) : new Set()
}

/**
 * 1.11 A3 rule 11 (b): a language name that a language writes as the English does, `[id, English name, reason]` — T10
 * (test/l10n.languages.test.ts, which exports it) refuses a name equal to its English except by this list, and
 * test/languages.test.ts's German check takes the same list. Here, not in the frame, because both tests read it and a
 * test file bundled into another would run its tests twice. Owned by 1.11 P1; the join (P8) extends it for a
 * translation package's report, each entry with its reason — never a package itself.
 */
export const LANGUAGE_NAME_AS_ENGLISH: ReadonlyArray<readonly [string, string, string]> = [
  ['de', 'Hindi', 'the German name of the language is Hindi (Duden)'],
  // 1.11 L1 (the lead, at the merge): the Latin-script languages of tier 2 write the name as the English does — the
  // dictionaries below — capitalised as a list item where the language writes it in lower case in a sentence.
  ['nl', 'Hindi', 'the Dutch name of the language is Hindi (Van Dale)'],
  ['da', 'Hindi', 'the Danish name of the language is hindi (Den Danske Ordbog), capitalised as a list item'],
  ['sv', 'Hindi', 'the Swedish name of the language is hindi (SAOL), capitalised as a list item'],
  ['nb', 'Hindi', 'the Norwegian name of the language is hindi (Bokmålsordboka), capitalised as a list item'],
  ['fi', 'Hindi', 'the Finnish name of the language is hindi (Kielitoimiston sanakirja), capitalised as a list item'],
  ['hu', 'Hindi', 'the Hungarian name of the language is hindi (A magyar helyesírás szabályai), capitalised as a list item'],
  ['ro', 'Hindi', 'the Romanian name of the language is hindi (DEX), capitalised as a list item'],
  ['id', 'Hindi', 'the Indonesian name of the language is Hindi (KBBI)'],
  // 1.11 L5 (the lead, at the merge): four 1.10 languages write it as the English too, capitalised as a list item.
  ['fr', 'Hindi', 'the French name of the language is hindi (Larousse), capitalised as a list item'],
  ['es', 'Hindi', 'the Spanish name of the language is hindi (RAE), capitalised as a list item'],
  ['pt-br', 'Hindi', 'the Brazilian Portuguese name of the language is hindi (Michaelis), capitalised as a list item'],
  ['it', 'Hindi', 'the Italian name of the language is hindi (Treccani), capitalised as a list item'],
]

// ---------------------------------------------------------------------------
// 1.13 A4 rule 6: the pseudo-translation — and the pseudo-RTL bundle the frame, the isolate test and the harness share
// ---------------------------------------------------------------------------

/** A literal as a pattern. */
export const reEsc = (x: string): string => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * 1.12 D4 (L1-O2): a name of SAME_IN_EVERY_LANGUAGE as a pattern that takes any run of whitespace for each of its spaces —
 * a hard-wrapped text ("…as Claude\nCode's status line", the status-line consent's English) breaks a name where the
 * line ends, and "Claude\nCode" is the name "Claude Code" still, never the name Claude and the English word Code.
 */
export const namePattern = (name: string): string => reEsc(name).replace(/ /g, '\\s+')

/** Latin letters, the accented ones among them — not × (U+00D7) or ÷ (U+00F7), which stand in that block. */
export const LATIN_LETTERS = 'A-Za-z\\u00C0-\\u00D6\\u00D8-\\u00F6\\u00F8-\\u024F\\u1E00-\\u1EFF'

/**
 * What stands in a text as code or as a name, never as a word of its language — the frame's PROTECTED
 * (test/l10n.languages.test.ts), made from its names (SAME_IN_EVERY_LANGUAGE): fences, backtick spans, placeholders,
 * addresses, command targets, setting ids and links, codicons, paths, file names, model ids, the fixed forms that start
 * with a digit (`2h14m`, `12.5K`, a hash) and the names — a name of several words also across a line break (1.12 D4).
 * 1.13 P1: here, not in the frame, so that the pseudo-RTL bundle below is made by the very pattern the frame's
 * fixtures are (a test file imported by another would run its tests twice).
 */
export function protectedPattern(names: readonly string[]): RegExp {
  return new RegExp([
    '```[\\s\\S]*?```',
    '`[^`\\n]*`',
    '\\{\\d+\\}',
    'https?://[^\\s)]+',
    '\\(command:[^)\\s]*\\)',
    'command:[\\w.]+',
    '#?tokenPace\\.[\\w.]+#?',
    '\\$\\([\\w~-]+\\)',
    '(?:~|%[A-Za-z]+%|[A-Za-z]:)?(?:[\\\\/][\\w.<>*~-]+)+[\\\\/]?',
    '[\\w.<>-]*\\.(?:jsonl?|md|m?js|ts|lock|key|csv|toml|txt|log|vsix|sh|ps1|exe)\\b[\\w.<>-]*',
    '\\b(?:claude|gpt|codex|o\\d)-[\\w.-]+',
    '\\d[\\w.,:]*',
    `(?<![\\p{L}\\p{N}])(?:${[...names].sort((a, b) => b.length - a.length).map(namePattern).join('|')})(?![\\p{L}\\p{N}])`,
  ].join('|'), 'gu')
}

const PSEUDO_WORD = new RegExp(`[${LATIN_LETTERS}]+(?:['’][${LATIN_LETTERS}]+)*`, 'gu')

/**
 * The English turned into a language of another script: every word `word`, everything `protect` matches kept — the
 * code, the names, the placeholders —, and the marks, the quotation marks and the paragraphs as they are. `turnArrows`
 * (1.13 A4 rule 3): every `→` outside the kept spans written `←`, as a right-to-left translation turns an arrow that
 * shows the reading direction.
 */
export function pseudoText(english: string, word: string, protect: RegExp, turnArrows = false): string {
  const turn = (x: string): string => {
    const words = x.replace(PSEUDO_WORD, word)
    return turnArrows ? words.replace(/→/g, '←') : words
  }
  let out = ''
  let at = 0
  for (const m of english.matchAll(protect)) {
    out += turn(english.slice(at, m.index))
    out += m[0]
    at = (m.index ?? 0) + m[0].length
  }
  return out + turn(english.slice(at))
}

/** The file whose lists name what a pseudo-translation keeps. */
const FRAME_FILE = join('test', 'l10n.languages.test.ts')

/**
 * 1.13 P1: the names the frame keeps in every language — SAME_IN_EVERY_LANGUAGE with the lists it spreads
 * (ADDED_AT_THE_JOIN, NAMES_OF_1_12), in its order —, read from the frame's source: the frame is a test file, and a
 * test file imported by another would run its tests twice (test/languages.test.ts reads PENDING_ALLOWED from that file's
 * line for the same reason). The frame's test holds this reading equal to the list itself, so an entry the lead adds
 * at a join is here at once.
 */
export function frameKeptNames(root: string = ROOT): string[] {
  const text = readFileSync(join(root, FRAME_FILE), 'utf8')
  const lists = new Map<string, string[]>()
  for (const m of text.matchAll(/^export const (\w+): ReadonlyArray<readonly \[string, string\]> = \[\n([\s\S]*?)^\]$/gm)) {
    const items: string[] = []
    for (const line of m[2].split('\n')) {
      const spread = /^\s*\.\.\.(\w+),?\s*$/.exec(line)
      const entry = /^\s*\['((?:[^'\\]|\\.)*)',/.exec(line)
      if (spread) items.push(`...${spread[1]}`)
      else if (entry) items.push(entry[1].replace(/\\(.)/g, '$1'))
    }
    lists.set(m[1], items)
  }
  const expand = (name: string, seen: readonly string[]): string[] => {
    const items = lists.get(name)
    if (!items || seen.includes(name)) throw new Error(`${FRAME_FILE}: no list ${name} to read the kept names from`)
    return items.flatMap((x) => (x.startsWith('...') ? expand(x.slice(3), [...seen, name]) : [x]))
  }
  return expand('SAME_IN_EVERY_LANGUAGE', [])
}

/**
 * 1.13 A4 rule 6: the word of the `arab` fixture and of the pseudo-RTL bundle — "word" in Arabic, كلمة (U+0643 U+0644
 * U+0645 U+0629): four letters of a script written right to left, four grapheme clusters, so every weekday word of the
 * fixture fits T13's column.
 */
export const ARAB_WORD = 'كلمة'

/**
 * Review L 1.12, finding 1: the word the frame's kept-names guard holds beside NAMES_OF_1_12 — `security`, macOS's tool
 * (the darwin paragraphs), which a translation keeps and T9 does not take out of a text (it is an English word
 * everywhere else). The frame's KEPT_NAMES takes it from here, and the pseudo-RTL text keeps it, as a translation does.
 */
export const KEPT_WORDS: readonly string[] = ['security']

const RTL_PROTECT = new Map<string, RegExp>()
/** The pattern the pseudo-RTL text keeps — the frame's names in `root` and KEPT_WORDS —, made once per root. */
function rtlProtect(root: string): RegExp {
  let re = RTL_PROTECT.get(root)
  if (!re) {
    re = protectedPattern([...frameKeptNames(root), ...KEPT_WORDS])
    RTL_PROTECT.set(root, re)
  }
  return re
}

/**
 * 1.13 A4 rule 6: one English text as the pseudo-RTL language writes it — every word ARAB_WORD, every `→` a `←`, the
 * code, the names (and KEPT_WORDS), the placeholders, the other marks and the quotation marks as they are, in logical
 * order. No bidi control (T16): the isolates are the code's, never a translation's.
 */
export function pseudoRtl(english: string, root: string = ROOT): string {
  return pseudoText(english, ARAB_WORD, rtlProtect(root), true)
}

/**
 * 1.13 A4 rule 6, A3 rule 9, A5 rule 1: the pseudo-RTL bundle — every t() key (the German bundle's keys, which the frame's
 * T1 holds to the extracted keys) with its pseudoRtl text, keys sorted as merge-l10n.mjs writes a bundle. The frame's
 * `arab` fixture is made of the same texts (a test holds the two equal), under the id `ar`; the isolate test and the
 * harness install it where no Arabic, Hebrew or Persian translation exists yet. Nothing is written: a test that needs
 * files writes them into a temporary directory of its own, never into `l10n/`.
 */
export function pseudoRtlBundle(root: string = ROOT): Record<string, string> {
  const german = JSON.parse(readFileSync(join(root, 'l10n', 'bundle.l10n.de.json'), 'utf8')) as Record<string, string>
  const out: Record<string, string> = {}
  for (const key of Object.keys(german).sort()) out[key] = pseudoRtl(key, root)
  return out
}

/** The raw manifest, placeholders and all — for the tests that check the placeholders. */
export const rawManifest = readJson('package.json') as Record<string, unknown>

/** Every `%key%` the manifest uses, in the order it uses them. */
export function manifestKeys(node: unknown = rawManifest, out: string[] = []): string[] {
  if (typeof node === 'string') {
    const m = NLS_KEY.exec(node)
    if (m) out.push(m[1])
  } else if (Array.isArray(node)) {
    for (const item of node) manifestKeys(item, out)
  } else if (node && typeof node === 'object') {
    for (const value of Object.values(node)) manifestKeys(value, out)
  }
  return out
}

/** A deep copy of `node` with every `%key%` replaced from `nls`; an unknown key is kept. */
export function resolveNls<T>(node: T, nls: Record<string, string> = englishNls): T {
  if (typeof node === 'string') {
    const m = NLS_KEY.exec(node)
    return (m && m[1] in nls ? nls[m[1]] : node) as unknown as T
  }
  if (Array.isArray(node)) return node.map((item) => resolveNls(item, nls)) as unknown as T
  if (node && typeof node === 'object') {
    const out: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(node)) out[key] = resolveNls(value, nls)
    return out as unknown as T
  }
  return node
}

/** `package.json` as a user of the English build sees it. */
export function readManifest<T>(nls: Record<string, string> = englishNls): T {
  return resolveNls(readJson('package.json'), nls) as T
}
