// SPDX-FileCopyrightText: 2026 Frederik Marx
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * 1.9 B3: the frame every language is measured by.
 *
 * Twelve languages beyond English and German are translated by AI agents, in parallel, from the
 * English source with the German as a second reference (l10n/TRANSLATING.md), and no native speaker
 * reads them. What a machine can check is checked here, the same thirteen rules for every language
 * whose files are on disk — German among them, whose own rules (no informal „du", „Token" not
 * „Tokens") stay in its own tests:
 *
 *   T1  the keys: the bundle's are the extracted t() keys, the manifest's are package.nls.json's in its order
 *   T2  the parts: the four part files, each with exactly the German part's keys
 *   T3  the placeholders: every {n} of the key, as often
 *   T4  the marks: ~ ⚠ ≈ – % × → · as often as the key (the manifest: ~ ⚠ ≈ –)
 *   T5  the code: backtick spans, tokenPace ids, codicons, command targets; in the manifest also the
 *       setting links, command links, fences, paragraphs and JSON examples
 *   T6  the page's words carry no markup character
 *   T7  the tone: no exclamation mark
 *   T8  the tables: a header row keeps its pipes
 *   T9  no English left, proper names and code excepted (SAME_IN_EVERY_LANGUAGE)
 *   T10 the registry: every file names a shipped language; the language names translated, the
 *       native names and the product's name as they are
 *   T11 the English quotes: the keep-warm consent quotes the terms and the line verbatim, and a
 *       quoted {n} stays between quotation marks
 *   T12 the freshness of the manifest's translations (scripts/nls-sources.mjs --check)
 *   T13 the heat map's weekday words fit their column: four characters at most
 *
 * Every rule is a function over the files of one language, so it runs over the repository's files
 * and — each once with the mutation it exists to catch — over a synthetic language written into a
 * temporary directory: a copy of the German under another id (a Latin-script language), and a
 * pseudo-translation of the English that turns every word into 語 and keeps everything the rules
 * hold (a language of another script). Both pass every rule before they are broken. No file outside
 * the repository and the test's own temporary directories is touched; nothing is sent anywhere.
 */

import { strict as assert } from 'node:assert'
import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { KEEP_WARM_TERMS_PASSAGE, KeepWarmConsent } from '../src/consent'
import { setBundle, setLang, setLocale } from '../src/i18n'
import { KEEP_WARM_LINE } from '../src/keepWarm'
import { isLanguageId, LANGUAGE_IDS, languageEntry, languageName, LANGUAGES } from '../src/languages'
import type { MementoLike } from '../src/storage'
import { weekdayWords } from '../src/time'
import { ROOT } from './helpers/nls'

// ---------------------------------------------------------------------------
// The words that stay the same in every language (T9)
// ---------------------------------------------------------------------------

/**
 * T9's exceptions, each with its reason: a word of this list is taken out of the key and the value
 * before they are compared, so keeping it in English is no "English left". Owned by 1.9 P3; the lead
 * extends it at the join (P19) for a false positive a translation package reports — never a package
 * itself (§0b.7). Case matters: `Windows` is the operating system, `windows` the quota's.
 */
export const SAME_IN_EVERY_LANGUAGE: ReadonlyArray<readonly [string, string]> = [
  // The product names of the brief (TRANSLATING.md, "Never translated").
  ['Token Pace', 'the product\'s name'],
  ['Claude Code', 'a product\'s name'],
  ['Claude', 'a product\'s name'],
  ['Codex', 'a product\'s name'],
  ['Anthropic', 'a company\'s name'],
  ['OpenAI', 'a company\'s name'],
  ['ChatGPT', 'a product\'s name'],
  ['Visual Studio Code', 'a product\'s name'],
  ['VS Code', 'a product\'s name'],
  ['Open VSX', 'a registry\'s name'],
  ['GitHub', 'a service\'s name'],
  ['WSL', 'a product\'s name (Windows Subsystem for Linux)'],
  ['Windows', 'an operating system\'s name'],
  ['macOS', 'an operating system\'s name'],
  ['Linux', 'an operating system\'s name'],
  // Abbreviations every language writes the same.
  ['API', 'an abbreviation written so in every language'],
  ['USD', 'a currency code'],
  ['CSV', 'a file format\'s name'],
  ['JSON', 'a file format\'s name'],
  ['TTL', 'the cache\'s time-to-live as Anthropic writes it (`1 h TTL` is a fixed form, §3 A5)'],
  ['ID', 'an abbreviation written so in every language'],
  ['HTTP', 'a protocol\'s name'],
  ['TLS', 'a protocol\'s name'],
  ['OAuth', 'a protocol\'s name'],
  ['CLI', 'an abbreviation written so in every language'],
  ['P90', 'a statistic\'s name (the 90th percentile)'],
  ['CV', 'a statistic\'s name (the coefficient of variation)'],
  ['ctx', 'the context figure\'s short label'],
  // The units and suffixes of the fixed forms (§3 A5: `2 h 14 min`, `4 m 10 s`, `12.5K`).
  ['min', 'a unit of the fixed forms'],
  ['h', 'a unit of the fixed forms'],
  ['d', 'a unit of the fixed forms'],
  ['m', 'a unit of the fixed forms (`4 m 10 s`, countdownText)'],
  ['s', 'a unit of the fixed forms'],
  ['K', 'a suffix of the fixed forms'],
  ['M', 'a suffix of the fixed forms'],
  ['G', 'a suffix of the fixed forms'],
  ['Quick Pick', 'VS Code\'s name for the list, kept as shipped (the German says „Quick Pick" too)'],
  // 1.9 P3: found by running the rule over German, or certain for every language.
  ['CC', 'the status bar\'s short label for Claude Code (adapters `shortLabel`) — notation, quoted in the manifest\'s examples'],
  ['CDX', 'the status bar\'s short label for Codex (adapters `shortLabel`) — notation'],
  ['Pro', 'a plan\'s name as the providers write it (config.planName\'s examples)'],
  ['Max', 'a plan\'s name as the providers write it (config.planName\'s examples)'],
  ['Team', 'a plan\'s name as the providers write it (config.planName\'s examples)'],
  ['Plus', 'a plan\'s name as the providers write it (config.planName\'s examples)'],
]

/**
 * The languages written in another script than Latin (T9's second rule): their values may keep no
 * run of three Latin words. Every other language of the registry is written in Latin script.
 */
const NON_LATIN: ReadonlySet<string> = new Set(['ja', 'ko', 'zh-cn', 'zh-tw', 'ru'])

/**
 * T5: a backtick span of the manifest that is words, not code — a formula spelled in words or a
 * label the page shows translated. A translation may put these into its own words (the German does,
 * since 1.2); every other span is a setting's value, a key or a command and stays as it is.
 */
export const NLS_SPANS_READ_AS_WORDS: ReadonlyArray<readonly [string, string]> = [
  ['ratio = (used ÷ limit) ÷ (elapsed ÷ window)', 'the pace formula in words (config.pace.*)'],
  ['used % − elapsed %', 'the tolerance formula in words (config.pace.sensitivity)'],
  ['ratio 1.12', 'a value of the formula, in its words (config.pace.tolerancePoints)'],
  ['elapsed ≈ 0', 'the formula\'s edge case in words (config.pace.minElapsedPercent)'],
  ['subagents', 'the chart chip\'s label as the page shows it (config.chart.modelStyle) — the page translates it'],
]

// ---------------------------------------------------------------------------
// What a language is measured against: the English source and the German reference
// ---------------------------------------------------------------------------

const PARTS = ['dashboard', 'host', 'model', 'text'] as const
type Part = typeof PARTS[number]

interface Source {
  /** Every t() key of src/, as scripts/l10n-extract.mjs reads them. */
  keys: string[]
  /** package.nls.json. */
  english: Record<string, string>
  /** The key set of each German part: the shape every language's parts mirror (§3 B1). */
  germanParts: Record<Part, string[]>
  /** The keys of webviewWords(): the page's own words, concatenated into markup. */
  pageWords: string[]
  /** languageName() of every id with no bundle installed: the fourteen names in English. */
  names: Array<{ id: string; english: string }>
  /** weekdayWords() with no bundle installed: 'Sun' … 'Sat'. */
  weekdays: string[]
}

const readTable = (file: string): Record<string, string> => JSON.parse(readFileSync(file, 'utf8')) as Record<string, string>

/** The seam is module state; every test that installs a bundle puts it back. */
function pristine(): void {
  setBundle(undefined)
  setLocale(undefined)
  setLang(undefined)
}

/** dashboard.ts imports `vscode`; the module is required behind the stub dashboard.test.ts uses. */
function pageWordKeys(): string[] {
  const mod = require('node:module')
  if (!mod._load.stubbed) {
    const original = mod._load
    const load = function (this: unknown, request: string, parent: unknown, isMain: boolean): unknown {
      if (request === 'vscode') return { commands: { executeCommand: () => undefined } }
      return original.call(this, request, parent, isMain)
    }
    load.stubbed = true
    mod._load = load
  }
  const { pageWords } = require('../src/dashboard') as typeof import('../src/dashboard')
  pristine()
  return Object.keys(pageWords().dict)
}

let source: Source | null = null
function src(): Source {
  if (source) return source
  const r = spawnSync(process.execPath, [join(ROOT, 'scripts', 'l10n-extract.mjs'), '--json'], { cwd: ROOT, encoding: 'utf8' })
  assert.equal(r.status, 0, `l10n-extract failed:\n${r.stderr}`)
  const keys = Object.keys((JSON.parse(r.stdout) as { keys: Record<string, string[]> }).keys)
  const germanParts = {} as Record<Part, string[]>
  for (const part of PARTS) germanParts[part] = Object.keys(readTable(join(ROOT, 'l10n', 'parts', `${part}.de.json`)))
  pristine()
  source = {
    keys,
    english: readTable(join(ROOT, 'package.nls.json')),
    germanParts,
    pageWords: pageWordKeys(),
    names: LANGUAGES.map((e) => ({ id: e.id, english: languageName(e.id) })),
    weekdays: weekdayWords(),
  }
  return source
}

// ---------------------------------------------------------------------------
// The files of one language
// ---------------------------------------------------------------------------

interface LangFiles {
  id: string
  root: string
  bundle: Record<string, string> | null
  parts: Partial<Record<string, Record<string, string>>>
  nls: Record<string, string> | null
  /** Files that exist but do not parse as a JSON object. */
  unreadable: string[]
}

/** `host.pt-br.json` → part and id — the rule scripts/merge-l10n.mjs names a part by. */
const PART_FILE = /^([A-Za-z0-9_-]+)\.([a-z]{2,3}(?:-[A-Za-z0-9]+)*)\.json$/

function readObject(file: string, unreadable: string[], label: string): Record<string, string> | null {
  if (!existsSync(file)) return null
  try {
    const v = JSON.parse(readFileSync(file, 'utf8')) as unknown
    if (typeof v === 'object' && v !== null && !Array.isArray(v)) return v as Record<string, string>
  } catch { /* named below */ }
  unreadable.push(label)
  return null
}

function loadLang(root: string, id: string): LangFiles {
  const unreadable: string[] = []
  const parts: Partial<Record<string, Record<string, string>>> = {}
  const partsDir = join(root, 'l10n', 'parts')
  for (const f of existsSync(partsDir) ? readdirSync(partsDir).sort() : []) {
    const m = PART_FILE.exec(f)
    if (!m || m[2] !== id) continue
    const table = readObject(join(partsDir, f), unreadable, `l10n/parts/${f}`)
    if (table) parts[m[1]] = table
  }
  return {
    id,
    root,
    bundle: readObject(join(root, 'l10n', `bundle.l10n.${id}.json`), unreadable, `l10n/bundle.l10n.${id}.json`),
    parts,
    nls: readObject(join(root, `package.nls.${id}.json`), unreadable, `package.nls.${id}.json`),
    unreadable,
  }
}

/** Every language with a file on disk — a bundle, a part, a manifest translation or a record — in the registry's order. */
function languagesOnDisk(root: string = ROOT): string[] {
  const ids = new Set<string>()
  const add = (dir: string, re: RegExp, group = 1): void => {
    if (!existsSync(dir)) return
    for (const f of readdirSync(dir)) { const m = re.exec(f); if (m) ids.add(m[group]) }
  }
  add(join(root, 'l10n'), /^bundle\.l10n\.(.+)\.json$/)
  add(root, /^package\.nls\.(.+)\.json$/)
  add(join(root, 'l10n', 'parts'), PART_FILE, 2)
  add(join(root, 'l10n', 'nls-sources'), /^(.+)\.json$/)
  const order = (id: string): number => { const i = (LANGUAGE_IDS as readonly string[]).indexOf(id); return i < 0 ? 999 : i }
  return [...ids].sort((a, b) => order(a) - order(b) || (a < b ? -1 : 1))
}

// ---------------------------------------------------------------------------
// Small tools
// ---------------------------------------------------------------------------

const J = (x: unknown): string => JSON.stringify(x)
const count = (s: string, needle: string): number => s.split(needle).length - 1
const sorted = (xs: string[]): string[] => [...xs].sort()
/** The entries of a bundle a rule reads: every key the bundle translates. */
const entries = (t: Record<string, string> | null): Array<[string, string]> =>
  t ? Object.entries(t).filter((e): e is [string, string] => typeof e[1] === 'string') : []
/** The manifest's entries beside the English: [key, English, translation]. */
function nlsEntries(s: Source, l: LangFiles): Array<[string, string, string]> {
  if (!l.nls) return []
  return Object.entries(s.english).filter(([k]) => typeof l.nls![k] === 'string').map(([k, en]) => [k, en, l.nls![k]])
}

const placeholders = (s: string): string[] => sorted([...s.matchAll(/\{(\d+)\}/g)].map((m) => m[0]))
const MARKS = ['~', '⚠', '≈', '–', '%', '×', '→', '·'] as const
const NLS_MARKS = ['~', '⚠', '≈', '–'] as const
const withoutFences = (s: string): string => s.replace(/```[\s\S]*?```/g, ' ')
const spans = (s: string): string[] => sorted([...withoutFences(s).matchAll(/`([^`\n]+)`/g)].map((m) => m[1]))
const ids = (s: string): string[] => sorted([...s.matchAll(/tokenPace\.[A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)*/g)].map((m) => m[0]))
const codicons = (s: string): string[] => sorted([...s.matchAll(/\$\([a-z0-9-]+(?:~[a-z]+)?\)/g)].map((m) => m[0]))
const commandTargets = (s: string): string[] => sorted([...s.matchAll(/command:([A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)*)/g)].map((m) => m[1]))
const settingLinks = (s: string): string[] => sorted([...s.matchAll(/#(tokenPace\.[\w.]+)#/g)].map((m) => m[1]))
const commandLinks = (s: string): string[] => sorted([...s.matchAll(/\(command:([\w.]+)\)/g)].map((m) => m[1]))
const jsonBlocks = (s: string): string[] => [...s.matchAll(/```json\n([\s\S]*?)```/g)].map((m) => m[1])
const paragraphs = (s: string): number => s.split('\n\n').length

const reEsc = (x: string): string => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * What stands in a text as code or as a name, never as a word of its language: fences, backtick
 * spans, placeholders, addresses, command targets, setting ids and links, codicons, paths, file
 * names, model ids, the fixed forms that start with a digit (`2h14m`, `12.5K`, a hash) and the words
 * of SAME_IN_EVERY_LANGUAGE. T9 takes these out before it compares; the pseudo-translation keeps
 * them as they are.
 */
const PROTECTED = new RegExp([
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
  `(?<![\\p{L}\\p{N}])(?:${[...SAME_IN_EVERY_LANGUAGE.map(([w]) => w)].sort((a, b) => b.length - a.length).map(reEsc).join('|')})(?![\\p{L}\\p{N}])`,
].join('|'), 'gu')

/** The words of a text once its code and names are out: runs of letters, two or more. */
function wordsOf(s: string): string[] {
  return (s.replace(PROTECTED, ' ').match(/[\p{L}\p{M}]+/gu) ?? []).filter((w) => [...w].length >= 2)
}
/** Latin letters, the accented ones among them — not × (U+00D7) or ÷ (U+00F7), which stand in that block. */
const LATIN_LETTERS = 'A-Za-z\\u00C0-\\u00D6\\u00D8-\\u00F6\\u00F8-\\u024F\\u1E00-\\u1EFF'
const LATIN_WORD = new RegExp(`^[${LATIN_LETTERS}]+$`, 'u')

/** T9, Latin script: the key never its own translation (three words or more), and no four words of it in a row. */
function latinLeft(key: string, value: string): string | null {
  const k = wordsOf(key).map((w) => w.toLowerCase())
  if (k.length >= 3 && value === key) return 'is its own key'
  const v = ` ${wordsOf(value).map((w) => w.toLowerCase()).join(' ')} `
  for (let i = 0; i + 4 <= k.length; i++) {
    const run = k.slice(i, i + 4).join(' ')
    if (v.includes(` ${run} `)) return `keeps four English words in a row: "${run}"`
  }
  return null
}

/** T9, another script: no run of three Latin words of two letters or more. A one-letter token neither counts nor breaks a run. */
function nonLatinLeft(value: string): string | null {
  const tokens = value.replace(PROTECTED, ' ').match(/[\p{L}\p{M}]+/gu) ?? []
  let run: string[] = []
  for (const tok of tokens) {
    if (LATIN_WORD.test(tok)) {
      if ([...tok].length < 2) continue
      run.push(tok)
      if (run.length >= 3) return `keeps three Latin words in a row: "${run.join(' ')}"`
    } else {
      run = []
    }
  }
  return null
}

/** The quotation marks a {n} may stand between (T11), in any of the fourteen languages. */
const OPEN_QUOTES = '“"„«‹「『‘\'‚»›'
const CLOSE_QUOTES = '”"“»›」』’\'‘«‹'
function quoted(s: string, ph: string): boolean {
  return new RegExp(`[${reEsc(OPEN_QUOTES)}][\\u00a0\\u202f ]?${reEsc(ph)}[\\u00a0\\u202f ]?[${reEsc(CLOSE_QUOTES)}]`).test(s)
}

function installed<T>(bundle: Record<string, string> | null, run: () => T): T {
  try {
    setBundle(bundle ?? {})
    return run()
  } finally {
    pristine()
  }
}

const noMemento: MementoLike = { get: <T>(_key: string, fallback: T): T => fallback, update: () => Promise.resolve() }

// ---------------------------------------------------------------------------
// The rules — each returns the problems it found, every one naming the language, the file and the key
// ---------------------------------------------------------------------------

type Rule = (s: Source, l: LangFiles) => string[]
const BUNDLE = (l: LangFiles): string => `l10n/bundle.l10n.${l.id}.json`
const NLS = (l: LangFiles): string => `package.nls.${l.id}.json`

const RULES: Record<string, { title: string; rule: Rule }> = {
  T1: {
    title: 'the keys — the bundle\'s are the extracted t() keys, no more, no less; the manifest\'s are package.nls.json\'s, in its order',
    rule: (s, l) => {
      const out = l.unreadable.map((f) => `${l.id}: ${f} is not a JSON object`)
      if (!l.bundle) out.push(`${l.id}: ${BUNDLE(l)} is missing`)
      else {
        const have = new Set(Object.keys(l.bundle))
        const want = new Set(s.keys)
        for (const k of s.keys) if (!have.has(k)) out.push(`${l.id}: ${BUNDLE(l)}: no translation of ${J(k)}`)
        for (const k of Object.keys(l.bundle)) if (!want.has(k)) out.push(`${l.id}: ${BUNDLE(l)}: ${J(k)} is no key of src/ (any more)`)
      }
      if (!l.nls) out.push(`${l.id}: ${NLS(l)} is missing`)
      else {
        const en = Object.keys(s.english)
        const have = Object.keys(l.nls)
        for (const k of en) if (!(k in l.nls)) out.push(`${l.id}: ${NLS(l)}: no translation of ${k}`)
        for (const k of have) if (!(k in s.english)) out.push(`${l.id}: ${NLS(l)}: ${k} is no key of package.nls.json`)
        const common = have.filter((k) => k in s.english)
        const order = en.filter((k) => k in l.nls!)
        const at = common.findIndex((k, i) => k !== order[i])
        if (at >= 0) out.push(`${l.id}: ${NLS(l)}: ${common[at]} stands where package.nls.json has ${order[at]} — the keys are not in its order`)
      }
      return out
    },
  },
  T2: {
    title: 'the parts — the four part files, each with exactly the German part\'s keys',
    rule: (s, l) => {
      const out: string[] = []
      for (const name of Object.keys(l.parts)) {
        if (!(PARTS as readonly string[]).includes(name)) out.push(`${l.id}: l10n/parts/${name}.${l.id}.json is no part the German has`)
      }
      for (const part of PARTS) {
        const table = l.parts[part]
        const file = `l10n/parts/${part}.${l.id}.json`
        if (!table) { out.push(`${l.id}: ${file} is missing`); continue }
        const want = new Set(s.germanParts[part])
        for (const k of s.germanParts[part]) if (!(k in table)) out.push(`${l.id}: ${file}: no translation of ${J(k)} (l10n/parts/${part}.de.json has it)`)
        for (const k of Object.keys(table)) if (!want.has(k)) out.push(`${l.id}: ${file}: ${J(k)} is not in l10n/parts/${part}.de.json`)
      }
      return out
    },
  },
  T3: {
    title: 'the placeholders — every value keeps the {n} of its key, each as often',
    rule: (s, l) => [
      ...entries(l.bundle).filter(([k, v]) => J(placeholders(v)) !== J(placeholders(k)))
        .map(([k, v]) => `${l.id}: ${BUNDLE(l)}: ${J(k)} has ${J(placeholders(v))}, its key ${J(placeholders(k))}`),
      ...nlsEntries(s, l).filter(([, en, v]) => J(placeholders(v)) !== J(placeholders(en)))
        .map(([k, en, v]) => `${l.id}: ${NLS(l)}: ${k} has ${J(placeholders(v))}, the English ${J(placeholders(en))}`),
    ],
  },
  T4: {
    title: 'the marks — ~ ⚠ ≈ – % × → · as often as the key (the manifest: ~ ⚠ ≈ –); ASCII ~, never ～',
    rule: (s, l) => {
      const out: string[] = []
      for (const [k, v] of entries(l.bundle)) {
        for (const m of MARKS) if (count(v, m) !== count(k, m)) out.push(`${l.id}: ${BUNDLE(l)}: ${J(k)} has ${count(v, m)} × ${m}, its key ${count(k, m)}`)
        if (v.includes('～') || v.includes('・')) out.push(`${l.id}: ${BUNDLE(l)}: ${J(k)} writes ～ or ・ for ~ or ·`)
      }
      for (const [k, en, v] of nlsEntries(s, l)) {
        for (const m of NLS_MARKS) if (count(v, m) !== count(en, m)) out.push(`${l.id}: ${NLS(l)}: ${k} has ${count(v, m)} × ${m}, the English ${count(en, m)}`)
        if (v.includes('～')) out.push(`${l.id}: ${NLS(l)}: ${k} writes ～ for ~`)
      }
      return out
    },
  },
  T5: {
    title: 'the code — backtick spans, tokenPace ids, codicons, command targets and paragraphs as the key has them; the manifest\'s links, fences and JSON examples too',
    rule: (s, l) => {
      const out: string[] = []
      const same = (what: string, f: (x: string) => unknown, file: string, key: string, en: string, v: string): void => {
        if (J(f(v)) !== J(f(en))) out.push(`${l.id}: ${file}: ${key} — the ${what} differ: ${J(f(v))}, the English ${J(f(en))}`)
      }
      for (const [k, v] of entries(l.bundle)) {
        const key = J(k)
        same('backtick spans', spans, BUNDLE(l), key, k, v)
        same('tokenPace ids', ids, BUNDLE(l), key, k, v)
        same('codicons', codicons, BUNDLE(l), key, k, v)
        same('command targets', commandTargets, BUNDLE(l), key, k, v)
        same('paragraphs', paragraphs, BUNDLE(l), key, k, v)
      }
      const words = new Set(NLS_SPANS_READ_AS_WORDS.map(([w]) => w))
      for (const [k, en, v] of nlsEntries(s, l)) {
        same('setting links', settingLinks, NLS(l), k, en, v)
        same('command links', commandLinks, NLS(l), k, en, v)
        same('fences', (x) => count(x, '```'), NLS(l), k, en, v)
        same('paragraphs', paragraphs, NLS(l), k, en, v)
        same('JSON examples', jsonBlocks, NLS(l), k, en, v)
        same('tokenPace ids', ids, NLS(l), k, en, v)
        same('codicons', codicons, NLS(l), k, en, v)
        same('command targets', commandTargets, NLS(l), k, en, v)
        // Every span that is code stays; a span that is words may be translated, but none is dropped or added.
        const have = spans(v)
        const code = spans(en).filter((x) => !words.has(x))
        const left = [...have]
        const lost = code.filter((x) => { const i = left.indexOf(x); if (i < 0) return true; left.splice(i, 1); return false })
        if (lost.length > 0 || have.length !== spans(en).length) {
          out.push(`${l.id}: ${NLS(l)}: ${k} — the backtick spans differ: ${J(have)}, the English ${J(spans(en))}${lost.length ? ` (lost: ${J(lost)})` : ''}`)
        }
      }
      return out
    },
  },
  T6: {
    title: 'the page\'s words — no <, >, " or & in a translation of a webviewWords() key',
    rule: (s, l) => s.pageWords.filter((k) => typeof l.bundle?.[k] === 'string' && /[<>"&]/.test(l.bundle[k]))
      .map((k) => `${l.id}: ${BUNDLE(l)}: ${J(k)} is a word of the page and its translation carries markup: ${J(l.bundle![k])}`),
  },
  T7: {
    title: 'the tone — no exclamation mark (! ¡ ！) in any value; the manifest keeps only the English\'s own',
    rule: (s, l) => [
      ...entries(l.bundle).filter(([, v]) => /[!¡！]/.test(v)).map(([k, v]) => `${l.id}: ${BUNDLE(l)}: ${J(k)} exclaims: ${J(v)}`),
      ...nlsEntries(s, l).filter(([, en, v]) => /[¡！]/.test(v) || count(v, '!') !== count(en, '!'))
        .map(([k]) => `${l.id}: ${NLS(l)}: ${k} exclaims where the English does not`),
    ],
  },
  T8: {
    title: 'the tables — a key that starts with "| " keeps its pipes',
    rule: (s, l) => entries(l.bundle).filter(([k, v]) => k.startsWith('| ') && count(v, '|') !== count(k, '|'))
      .map(([k, v]) => `${l.id}: ${BUNDLE(l)}: ${J(k)} has ${count(v, '|')} pipes, its key ${count(k, '|')}`),
  },
  T9: {
    title: 'no English left — proper names and code excepted',
    rule: (s, l) => {
      const out: string[] = []
      const left = (en: string, v: string): string | null => (NON_LATIN.has(l.id) ? nonLatinLeft(v) : latinLeft(en, v))
      for (const [k, v] of entries(l.bundle)) {
        const why = left(k, v)
        if (why) out.push(`${l.id}: ${BUNDLE(l)}: ${J(k)} ${why}`)
      }
      for (const [k, en, v] of nlsEntries(s, l)) {
        if (en.length >= 40 && v === en) { out.push(`${l.id}: ${NLS(l)}: ${k} is still the English text`); continue }
        const why = left(en, v)
        if (why) out.push(`${l.id}: ${NLS(l)}: ${k} ${why}`)
      }
      return out
    },
  },
  T10: {
    title: 'the registry — the files name a shipped language; its fourteen names translated, the native names and the product\'s name as they are',
    rule: (s, l) => {
      const out: string[] = []
      if (!isLanguageId(l.id)) out.push(`${l.id}: no language of the registry (src/languages.ts) has this id — a file named after it is never read`)
      else if (l.id === 'en') out.push('en: English is the source — its words are the keys and package.nls.json; no file may be named after it')
      if (l.bundle) {
        for (const { english } of s.names) {
          const v = l.bundle[english]
          if (typeof v !== 'string' || v === '' || v === english) out.push(`${l.id}: ${BUNDLE(l)}: the language name ${J(english)} is not translated`)
        }
      }
      if (l.nls) {
        for (const e of LANGUAGES) {
          if (l.nls[`config.language.enum.${e.id}`] !== e.native) out.push(`${l.id}: ${NLS(l)}: config.language.enum.${e.id} is not the native name ${J(e.native)}`)
        }
        for (const key of ['displayName', 'command.category']) {
          if (l.nls[key] !== s.english[key]) out.push(`${l.id}: ${NLS(l)}: ${key} is not the English ${J(s.english[key])}`)
        }
      }
      return out
    },
  },
  T11: {
    title: 'the English quotes — the keep-warm consent quotes the terms and the line verbatim; a quoted {n} stays between quotation marks',
    rule: (s, l) => {
      if (!l.bundle) return []
      const out: string[] = []
      const detail = installed(l.bundle, () => new KeepWarmConsent(noMemento, () => undefined, { line: KEEP_WARM_LINE }).disclosure())
      if (!detail.includes(KEEP_WARM_TERMS_PASSAGE)) out.push(`${l.id}: ${BUNDLE(l)}: the keep-warm consent no longer quotes the terms passage verbatim`)
      if (!detail.includes(KEEP_WARM_LINE)) out.push(`${l.id}: ${BUNDLE(l)}: the keep-warm consent no longer quotes the line ${J(KEEP_WARM_LINE)} verbatim`)
      for (const [k, v] of entries(l.bundle)) {
        for (const ph of new Set(placeholders(k))) {
          if (quoted(k, ph) && !quoted(v, ph)) out.push(`${l.id}: ${BUNDLE(l)}: ${J(k)} quotes ${ph}; its translation does not stand it between quotation marks`)
        }
      }
      return out
    },
  },
  T12: {
    title: 'the freshness — every manifest translation was made from today\'s English (scripts/nls-sources.mjs --check)',
    rule: (_s, l) => freshness(l.root).filter((p) => p.startsWith(`${l.id}: `)),
  },
  T13: {
    title: 'the weekday words — Sun … Sat translated in four characters or fewer (the heat map\'s rows)',
    rule: (s, l) => {
      if (!l.bundle) return []
      const shown = installed(l.bundle, () => weekdayWords())
      return shown.map((w, i) => [s.weekdays[i], w]).filter(([, w]) => [...w].length > 4 || w.length === 0)
        .map(([en, w]) => `${l.id}: ${BUNDLE(l)}: ${J(en)} is ${J(w)}, ${[...w].length} characters`)
    },
  },
}

/** T12 runs the script as the gate does, once per directory: its problems, one per line, "<id>: <key> — …". */
const FRESHNESS = new Map<string, string[]>()
function freshness(root: string): string[] {
  const hit = FRESHNESS.get(root)
  if (hit) return hit
  const r = spawnSync(process.execPath, [join(ROOT, 'scripts', 'nls-sources.mjs'), '--check'], { cwd: root, encoding: 'utf8' })
  const lines = r.stderr.split('\n').filter((x) => x.startsWith('nls-sources: ') && !x.includes('translate the named keys')).map((x) => x.slice('nls-sources: '.length))
  if (r.status !== 0 && lines.length === 0) lines.push(`?: nls-sources.mjs --check failed: ${r.stderr}`)
  FRESHNESS.set(root, lines)
  return lines
}

// ---------------------------------------------------------------------------
// The repository: every language on disk, every rule
// ---------------------------------------------------------------------------

const ON_DISK = languagesOnDisk()

test('the frame runs over the languages on disk — German among them — and English has no file of its own (1.9 B3)', () => {
  assert.ok(ON_DISK.includes('de'), `no German files found: ${J(ON_DISK)}`)
  assert.equal(ON_DISK.includes('en'), false)
  assert.deepEqual(Object.keys(RULES), ['T1', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7', 'T8', 'T9', 'T10', 'T11', 'T12', 'T13'])
  // The references are what they claim to be.
  const s = src()
  assert.ok(s.keys.length >= 1000, `only ${s.keys.length} t() keys`)
  assert.ok(s.pageWords.length >= 150 && s.pageWords.every((k) => s.keys.includes(k)), `${s.pageWords.length} page words`)
  assert.deepEqual(s.weekdays, ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'])
  assert.equal(s.names.length, 14)
  assert.deepEqual(PARTS.map((p) => s.germanParts[p].length > 100), [true, true, true, true])
})

for (const id of ON_DISK) {
  const name = isLanguageId(id) ? `${languageEntry(id).native} (${id})` : id
  for (const [no, { title, rule }] of Object.entries(RULES)) {
    test(`${no} · ${name}: ${title}`, () => {
      const problems = rule(src(), loadLang(ROOT, id))
      assert.deepEqual(problems, [], `\n${problems.slice(0, 40).join('\n')}${problems.length > 40 ? `\n… and ${problems.length - 40} more` : ''}`)
    })
  }
}

// ---------------------------------------------------------------------------
// Synthetic languages in a temporary directory — each rule once with the mutation it exists to catch
// ---------------------------------------------------------------------------

const TEMP: string[] = []
after(() => { for (const d of TEMP) rmSync(d, { recursive: true, force: true }) })
function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'token-pace-lang-'))
  TEMP.push(d)
  return d
}

/**
 * The English turned into a language of another script: every word 語, everything the rules hold
 * kept — the code, the names, the placeholders, the marks, the quotation marks, the paragraphs.
 */
const PSEUDO_WORD = new RegExp(`[${LATIN_LETTERS}]+(?:['’][${LATIN_LETTERS}]+)*`, 'gu')
function pseudo(english: string): string {
  let out = ''
  let at = 0
  for (const m of english.matchAll(PROTECTED)) {
    out += english.slice(at, m.index).replace(PSEUDO_WORD, '語')
    out += m[0]
    at = (m.index ?? 0) + m[0].length
  }
  return out + english.slice(at).replace(PSEUDO_WORD, '語')
}

function writeJson(file: string, table: Record<string, string>): void {
  mkdirSync(join(file, '..'), { recursive: true })
  writeFileSync(file, `${JSON.stringify(table, null, 2)}\n`, 'utf8')
}

/**
 * A synthetic language `id` in a directory of its own: the English manifest, the four parts (the
 * German's keys), the bundle merged from them, the manifest's translation and its freshness record
 * (made by the script, as a translation package makes it). `german`: the German's words under
 * another id — a Latin-script language that passes every rule; `pseudo`: the English as 語 — a
 * language of another script that passes every rule.
 */
const BASES = new Map<string, string>()
function fixture(kind: 'german' | 'pseudo', id: string): string {
  const cacheKey = `${kind}:${id}`
  let base = BASES.get(cacheKey)
  if (!base) {
    base = tempDir()
    const s = src()
    const germanBundle = readTable(join(ROOT, 'l10n', 'bundle.l10n.de.json'))
    const germanNls = readTable(join(ROOT, 'package.nls.de.json'))
    writeJson(join(base, 'package.nls.json'), s.english)
    const merged: Record<string, string> = {}
    for (const part of PARTS) {
      const table: Record<string, string> = {}
      for (const k of s.germanParts[part]) table[k] = kind === 'german' ? germanBundle[k] : pseudo(k)
      writeJson(join(base, 'l10n', 'parts', `${part}.${id}.json`), table)
      Object.assign(merged, table)
    }
    const bundle: Record<string, string> = {}
    for (const k of Object.keys(merged).sort()) bundle[k] = merged[k]
    writeJson(join(base, 'l10n', `bundle.l10n.${id}.json`), bundle)
    const nls: Record<string, string> = {}
    for (const [k, en] of Object.entries(s.english)) {
      nls[k] = kind === 'german' ? germanNls[k] : k.startsWith('config.language.enum.') && k !== 'config.language.enum.auto' ? en : pseudo(en)
    }
    writeJson(join(base, `package.nls.${id}.json`), nls)
    const r = spawnSync(process.execPath, [join(ROOT, 'scripts', 'nls-sources.mjs'), id], { cwd: base, encoding: 'utf8' })
    assert.equal(r.status, 0, r.stderr)
    BASES.set(cacheKey, base)
  }
  const dir = tempDir()
  cpSync(base, dir, { recursive: true })
  return dir
}

/** Edits one JSON file of a fixture in place. */
function edit(dir: string, file: string, change: (t: Record<string, string>) => void): void {
  const path = join(dir, file)
  const t = readTable(path)
  change(t)
  writeFileSync(path, `${JSON.stringify(t, null, 2)}\n`, 'utf8')
}

/** Runs one rule over a fixture language; the problems it names. */
function run(no: string, dir: string, id: string): string[] {
  return RULES[no].rule(src(), loadLang(dir, id))
}

/** A key of the German bundle the mutation can work on: the first one `pick` accepts. */
function keyWhere(pick: (key: string) => boolean): string {
  const k = src().keys.find(pick)
  assert.ok(k, 'no key for the mutation')
  return k
}

/** The bundle and the part that hold a key must change together: the merge would refuse them apart. */
function editKey(dir: string, id: string, key: string, change: (value: string) => string | undefined): void {
  for (const f of [`l10n/bundle.l10n.${id}.json`, ...PARTS.map((p) => `l10n/parts/${p}.${id}.json`)]) {
    edit(dir, f, (t) => {
      if (!(key in t)) return
      const next = change(t[key])
      if (next === undefined) delete t[key]
      else t[key] = next
    })
  }
}

/** The mutation fails the rule, and names the language and the key; the unbroken fixture passes it. */
function caught(no: string, dir: string, id: string, clean: string, ...needles: string[]): void {
  assert.deepEqual(run(no, clean, id), [], `${no} fails the unbroken ${id} fixture`)
  const problems = run(no, dir, id)
  assert.ok(problems.length > 0, `${no} did not catch the mutation`)
  for (const needle of [`${id}: `, ...needles]) {
    assert.ok(problems.some((p) => p.includes(needle)), `${no} does not name ${J(needle)}:\n${problems.join('\n')}`)
  }
}

test('the two synthetic languages — the German under fr, the English as 語 under ja — pass every rule', () => {
  for (const [kind, id] of [['german', 'fr'], ['pseudo', 'ja']] as const) {
    const dir = fixture(kind, id)
    for (const no of Object.keys(RULES)) assert.deepEqual(run(no, dir, id), [], `${no} fails the unbroken ${kind} fixture ${id}`)
  }
})

test('T1 catches a bundle key gone, a key src/ does not have, and a manifest out of order', () => {
  const clean = fixture('pseudo', 'ja')
  const key = keyWhere((k) => k === 'Refresh')
  const dir = fixture('pseudo', 'ja')
  edit(dir, 'l10n/bundle.l10n.ja.json', (t) => { delete t[key]; t['A key no source has'] = '語' })
  caught('T1', dir, 'ja', clean, 'no translation of "Refresh"', '"A key no source has" is no key of src/')
  const order = fixture('pseudo', 'ja')
  edit(order, 'package.nls.ja.json', (t) => {
    const { displayName, ...rest } = t
    for (const k of Object.keys(t)) delete t[k]
    Object.assign(t, rest, { displayName })
  })
  caught('T1', order, 'ja', clean, 'not in its order')
})

test('T2 catches a key deleted from one Polish part (§3 B3\'s mutation)', () => {
  const clean = fixture('pseudo', 'pl')
  const dir = fixture('pseudo', 'pl')
  const key = src().germanParts.model[0]
  edit(dir, 'l10n/parts/model.pl.json', (t) => { delete t[key] })
  caught('T2', dir, 'pl', clean, 'l10n/parts/model.pl.json', `no translation of ${J(key)}`)
})

test('T3 catches a {1} lost in one French value (§3 B3\'s mutation)', () => {
  const clean = fixture('german', 'fr')
  const key = keyWhere((k) => k.includes('{1}') && !k.includes('{2}'))
  const dir = fixture('german', 'fr')
  editKey(dir, 'fr', key, (v) => v.replace('{1}', ''))
  caught('T3', dir, 'fr', clean, J(key))
})

test('T4 catches ～ for ~ in Japanese (§3 B3\'s mutation)', () => {
  const clean = fixture('pseudo', 'ja')
  const key = keyWhere((k) => k.includes('~'))
  const dir = fixture('pseudo', 'ja')
  editKey(dir, 'ja', key, (v) => v.replace('~', '～'))
  caught('T4', dir, 'ja', clean, J(key), '× ~')
})

test('T5 catches a translated setting value in backticks, a setting id lost, a manifest span translated and a codicon lost', () => {
  const clean = fixture('german', 'fr')
  const tick = keyWhere((k) => /`[a-z]+`/.test(k))
  const id = keyWhere((k) => /tokenPace\.[a-z]/.test(k) && !/`[^`]*tokenPace/.test(k) && k !== tick)
  const dir = fixture('german', 'fr')
  editKey(dir, 'fr', tick, (v) => v.replace(/`([a-z]+)`/, '`$1-traduit`'))
  editKey(dir, 'fr', id, (v) => v.replace(/tokenPace\.[A-Za-z0-9_.]*[A-Za-z0-9_]/, 'le réglage'))
  caught('T5', dir, 'fr', clean, J(tick), J(id), 'backtick spans', 'tokenPace ids')
  // The bundle's keys carry no codicon today; the manifest's examples do (`$(history)`).
  const nls = fixture('german', 'fr')
  edit(nls, 'package.nls.fr.json', (t) => {
    t['config.pace.sensitivity.description'] = t['config.pace.sensitivity.description'].replace('`custom`', '`personnalisé`')
    t['config.showAgeInItem.enum.always'] = t['config.showAgeInItem.enum.always'].replace(/\$\([a-z-]+\)/, '')
  })
  caught('T5', nls, 'fr', clean, 'config.pace.sensitivity.description', 'lost: ["custom"]', 'config.showAgeInItem.enum.always', 'codicons')
})

test('T6 catches markup in a translation of one of the page\'s words — each of <, >, " and & on its own', () => {
  const clean = fixture('pseudo', 'ja')
  const dir = fixture('pseudo', 'ja')
  const words = src().pageWords.slice(0, 4)
  words.forEach((k, i) => editKey(dir, 'ja', k, (v) => `${v} ${'<>"&'[i]} 語`))
  caught('T6', dir, 'ja', clean, ...words.map((k) => J(k)))
})

test('T7 catches an exclamation mark — ！ in Japanese, ! in French', () => {
  const ja = fixture('pseudo', 'ja')
  const cleanJa = fixture('pseudo', 'ja')
  editKey(ja, 'ja', 'Refresh', (v) => `${v}！`)
  caught('T7', ja, 'ja', cleanJa, '"Refresh"')
  const fr = fixture('german', 'fr')
  const cleanFr = fixture('german', 'fr')
  edit(fr, 'package.nls.fr.json', (t) => { t.description = `${t.description}!` })
  caught('T7', fr, 'fr', cleanFr, 'description')
})

test('T8 catches a table header row that lost a pipe', () => {
  const clean = fixture('german', 'fr')
  const key = keyWhere((k) => k.startsWith('| '))
  const dir = fixture('german', 'fr')
  editKey(dir, 'fr', key, (v) => v.replace(/ \| [^|]+ \|$/, ' |'))
  caught('T8', dir, 'fr', clean, J(key))
})

test('T9 catches a copied English sentence — in a French value (§3 B3\'s mutation), in a Japanese one, in a manifest entry', () => {
  const cleanFr = fixture('german', 'fr')
  const key = keyWhere((k) => k === 'Not enough data for a summary yet.')
  const fr = fixture('german', 'fr')
  editKey(fr, 'fr', key, () => 'Not enough data for a summary yet.')
  caught('T9', fr, 'fr', cleanFr, J(key), 'is its own key')
  // A sentence of the English inside an otherwise French value.
  const inside = fixture('german', 'fr')
  editKey(inside, 'fr', key, (v) => `${v} Not enough data for a summary.`)
  caught('T9', inside, 'fr', cleanFr, J(key), 'four English words in a row')
  const cleanJa = fixture('pseudo', 'ja')
  const ja = fixture('pseudo', 'ja')
  editKey(ja, 'ja', key, () => '語: not enough data yet')
  caught('T9', ja, 'ja', cleanJa, J(key), 'three Latin words in a row')
  const nls = fixture('german', 'fr')
  edit(nls, 'package.nls.fr.json', (t) => { t.description = readTable(join(ROOT, 'package.nls.json')).description })
  caught('T9', nls, 'fr', cleanFr, 'package.nls.fr.json: description')
})

test('T10 catches a file named after no shipped language, an untranslated language name, a translated native name and a translated product name', () => {
  const clean = fixture('german', 'fr')
  const xx = fixture('german', 'xx')
  assert.ok(run('T10', xx, 'xx').some((p) => p.startsWith('xx: no language of the registry')))
  const dir = fixture('german', 'fr')
  editKey(dir, 'fr', 'Japanese', () => 'Japanese')
  edit(dir, 'package.nls.fr.json', (t) => { t['config.language.enum.de'] = 'Allemand'; t.displayName = 'Token Pace — Claude Code et Codex' })
  caught('T10', dir, 'fr', clean, 'the language name "Japanese" is not translated', 'config.language.enum.de', 'displayName')
})

test('T11 catches the terms passage dropped from the consent, and a quoted {0} without its quotation marks', () => {
  const clean = fixture('german', 'fr')
  const terms = keyWhere((k) => k.startsWith('Terms: section 3 of Anthropic'))
  const dir = fixture('german', 'fr')
  editKey(dir, 'fr', terms, (v) => v.replace(/„\{0\}“/, ''))
  caught('T11', dir, 'fr', clean, 'the terms passage')
  const marks = fixture('german', 'fr')
  editKey(marks, 'fr', terms, (v) => v.replace(/„\{0\}“/, '{0}'))
  caught('T11', marks, 'fr', clean, J(terms), 'between quotation marks')
})

test('T12 catches a changed English manifest value without a new record (§3 B3\'s mutation)', () => {
  const clean = fixture('german', 'fr')
  const dir = fixture('german', 'fr')
  edit(dir, 'package.nls.json', (t) => { t['config.language.enum.auto'] = `${t['config.language.enum.auto']} (changed)` })
  caught('T12', dir, 'fr', clean, 'config.language.enum.auto', 'the English changed since its translation')
  // The script is the gate: it exits 1 there, and 0 once the language is recorded again.
  const again = spawnSync(process.execPath, [join(ROOT, 'scripts', 'nls-sources.mjs'), 'fr'], { cwd: dir, encoding: 'utf8' })
  assert.equal(again.status, 0, again.stderr)
  assert.equal(spawnSync(process.execPath, [join(ROOT, 'scripts', 'nls-sources.mjs'), '--check'], { cwd: dir, encoding: 'utf8' }).status, 0)
})

test('T13 catches a weekday word too long for the heat map\'s column', () => {
  const clean = fixture('german', 'fr')
  const dir = fixture('german', 'fr')
  editKey(dir, 'fr', 'Mon', () => 'Montag')
  caught('T13', dir, 'fr', clean, '"Mon" is "Montag"')
})

// ---------------------------------------------------------------------------
// The freshness script itself (scripts/nls-sources.mjs)
// ---------------------------------------------------------------------------

test('nls-sources writes a record in the English\'s key order, and --check names a missing record, an orphan record, a key never recorded and a key gone', () => {
  const dir = tempDir()
  const script = join(ROOT, 'scripts', 'nls-sources.mjs')
  const cli = (...args: string[]): { status: number | null; stdout: string; stderr: string } => {
    const r = spawnSync(process.execPath, [script, ...args], { cwd: dir, encoding: 'utf8' })
    return { status: r.status, stdout: r.stdout, stderr: r.stderr }
  }
  writeJson(join(dir, 'package.nls.json'), { b: 'Bee', a: 'Ay', c: 'Sea' })
  writeJson(join(dir, 'package.nls.fr.json'), { b: 'Abeille', a: 'A', c: 'Mer' })
  assert.equal(cli('--check').status, 1, 'a translation without a record is not fresh')
  assert.match(cli('--check').stderr, /fr: package\.nls\.fr\.json has no record/)
  // A tag that is no language — a path among them — writes nothing.
  for (const bad of ['../x', 'FR', 'fr/../../x', '']) {
    const r = cli(bad)
    assert.equal(r.status, 1, `nls-sources ${J(bad)}`)
  }
  assert.equal(existsSync(join(dir, 'l10n')), false, 'a refused tag wrote a file')
  const w = cli('fr')
  assert.equal(w.status, 0, w.stderr)
  const record = readFileSync(join(dir, 'l10n', 'nls-sources', 'fr.json'), 'utf8')
  assert.deepEqual(Object.keys(JSON.parse(record)), ['b', 'a', 'c'])
  assert.match(record, /^\{\n {2}"b": "[0-9a-f]{16}",\n/)
  assert.ok(record.endsWith('}\n'))
  assert.equal(cli('--check').status, 0)
  // An English key added after the translation: never recorded.
  writeJson(join(dir, 'package.nls.json'), { b: 'Bee', a: 'Ay', c: 'Sea', d: 'Dee' })
  assert.match(cli('--check').stderr, /fr: d — no record of the English it was translated from/)
  // An English key removed: recorded, but gone.
  writeJson(join(dir, 'package.nls.json'), { b: 'Bee', a: 'Ay' })
  assert.match(cli('--check').stderr, /fr: c — recorded, but package\.nls\.json has no such key any more/)
  // A record left behind by a translation that was removed.
  writeJson(join(dir, 'package.nls.json'), { b: 'Bee', a: 'Ay', c: 'Sea' })
  writeJson(join(dir, 'l10n', 'nls-sources', 'it.json'), { b: '0000000000000000' })
  assert.match(cli('--check').stderr, /it: l10n[\\/]nls-sources[\\/]it\.json has no package\.nls\.it\.json beside it/)
})

test('German\'s record is the one the script makes from today\'s files, and the records are not shipped', () => {
  const r = spawnSync(process.execPath, [join(ROOT, 'scripts', 'nls-sources.mjs'), '--check'], { cwd: ROOT, encoding: 'utf8' })
  assert.equal(r.status, 0, r.stderr)
  const record = readTable(join(ROOT, 'l10n', 'nls-sources', 'de.json'))
  assert.deepEqual(Object.keys(record), Object.keys(src().english))
  // .vscodeignore ships nothing under l10n/ but the bundles: no part, no record, no brief.
  const ignore = readFileSync(join(ROOT, '.vscodeignore'), 'utf8')
  const negations = ignore.split('\n').filter((l) => l.startsWith('!l10n'))
  assert.deepEqual(negations, ['!l10n/bundle.l10n.*.json'])
  assert.ok(existsSync(join(ROOT, 'l10n', 'TRANSLATING.md')), 'the brief is missing')
})

test('the brief names every rule of the frame, the files a package owns, the gates and the scripts (1.9 B2)', () => {
  const brief = readFileSync(join(ROOT, 'l10n', 'TRANSLATING.md'), 'utf8')
  for (const needed of [
    'l10n/parts/dashboard.<id>.json', 'l10n/parts/host.<id>.json', 'l10n/parts/model.<id>.json', 'l10n/parts/text.<id>.json',
    'l10n/bundle.l10n.<id>.json', 'package.nls.<id>.json', 'l10n/nls-sources/<id>.json',
    'node scripts/merge-l10n.mjs', 'node scripts/nls-sources.mjs <id>', 'node scripts/nls-sources.mjs --check', 'node scripts/l10n-extract.mjs --json',
    'out-test/l10n.languages.test.js', 'SAME_IN_EVERY_LANGUAGE', 'Ignore this message. No action. No response.',
    'never translate the German', '30 hardest terms', '260 px',
  ]) assert.ok(brief.includes(needed), `l10n/TRANSLATING.md does not say: ${needed}`)
  for (const no of Object.keys(RULES)) assert.ok(new RegExp(`\\*\\*${no} `).test(brief), `the brief does not describe ${no}`)
  // The marks, as the rules count them; the product names, as T9 excepts them.
  for (const m of MARKS) assert.ok(brief.includes(`\`${m}\``), `the brief does not name the mark ${m}`)
  for (const [w] of SAME_IN_EVERY_LANGUAGE.slice(0, 15)) assert.ok(brief.includes(w), `the brief does not name ${w}`)
})
