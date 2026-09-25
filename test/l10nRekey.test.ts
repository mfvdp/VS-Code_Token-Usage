// SPDX-FileCopyrightText: 2026 Frederik Marx
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * 1.10 B1: scripts/l10n-rekey.mjs — the re-key ledger that carries every change of the English into the languages
 * beyond English and German, and the pending lists it leaves them.
 *
 * The script runs as the command line it is, in a temporary directory holding a small tree of its own: a registry
 * (package.json's language enum), a source with five t() keys, the English manifest, German and two languages
 * (French and Japanese) with their four parts, their bundles, their manifests and their freshness records. A package's
 * change of the English is made there by hand — the German with it, as a package writes it — and the ledger's entries
 * say what changed; the test then reads every file the script touched. test/l10n.languages.test.ts runs the frame's
 * rules over a whole language the script has worked on, and holds the repository's own ledger. Nothing outside the
 * test's temporary directories is touched.
 */

import { strict as assert } from 'node:assert'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { pendingNlsKeys, ROOT } from './helpers/nls'

const REKEY = join(ROOT, 'scripts', 'l10n-rekey.mjs')
const MERGE = join(ROOT, 'scripts', 'merge-l10n.mjs')
const SOURCES = join(ROOT, 'scripts', 'nls-sources.mjs')

type Table = Record<string, string>
interface Entry { n?: number; by?: string; kind: string; part?: string; from?: string; old?: string; key?: string; carry?: boolean; why?: string }
interface Pending {
  v: number
  applied: number
  bundle: Record<string, { parts: string[]; state: string; why: string }>
  nls: Record<string, { state: string; why: string }>
}

const TEMP: string[] = []
after(() => { for (const d of TEMP) rmSync(d, { recursive: true, force: true }) })

function cli(script: string, args: string[], cwd: string): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync(process.execPath, [script, ...args], { cwd, encoding: 'utf8' })
  return { status: r.status, stdout: r.stdout, stderr: r.stderr }
}
const rekey = (dir: string, ...args: string[]): ReturnType<typeof cli> => cli(REKEY, args, dir)

function write(dir: string, file: string, value: unknown): void {
  mkdirSync(join(dir, file, '..'), { recursive: true })
  writeFileSync(join(dir, file), typeof value === 'string' ? value : `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}
const read = <T = Table>(dir: string, file: string): T => JSON.parse(readFileSync(join(dir, file), 'utf8')) as T
const text = (dir: string, file: string): string => readFileSync(join(dir, file), 'utf8')

/** Every file under a directory, path → bytes. */
function snapshot(dir: string, at = ''): Record<string, string> {
  const out: Record<string, string> = {}
  for (const e of readdirSync(join(dir, at), { withFileTypes: true })) {
    const rel = at ? `${at}/${e.name}` : e.name
    if (e.isDirectory()) Object.assign(out, snapshot(dir, rel))
    else out[rel] = readFileSync(join(dir, rel), 'utf8')
  }
  return out
}
const only = (files: Record<string, string>, pick: (path: string) => boolean): Record<string, string> =>
  Object.fromEntries(Object.entries(files).filter(([p]) => pick(p)))

/** The four parts of one language: `Alpha` in two parts, one key each elsewhere. */
function parts(tag: string): Record<string, Table> {
  return {
    dashboard: { Alpha: `Alpha (${tag})` },
    host: { Delta: `Delta (${tag})` },
    model: { 'Alpha': `Alpha (${tag})`, 'Beta {0}': `Beta {0} (${tag})` },
    text: { Gamma: `Gamma (${tag})` },
  }
}

/**
 * A tree as 1.9 left one, with a ledger started (`--start abc1234`): the registry, a source whose t() keys the German
 * parts cover, the English manifest, and German, French and Japanese — four parts, a bundle, a manifest, a record each.
 */
function tree(): string {
  const dir = mkdtempSync(join(tmpdir(), 'token-pace-rekey-'))
  TEMP.push(dir)
  write(dir, 'package.json', { contributes: { configuration: [{ properties: { 'tokenPace.language': { enum: ['auto', 'en', 'de', 'fr', 'ja'] } } }] } })
  write(dir, 'src/i18n.ts', 'export function t(message: string, ..._args: unknown[]): string { return message }\n')
  write(dir, 'src/a.ts', "import { t } from './i18n'\nexport const words = [t('Alpha'), t('Beta {0}', 1), t('Gamma'), t('Delta')]\n")
  write(dir, 'package.nls.json', { a: 'Alpha setting', b: 'Beta setting', c: 'Gamma setting' })
  for (const [id, tag] of [['de', 'de'], ['fr', 'fr'], ['ja', 'ja']]) {
    for (const [part, table] of Object.entries(parts(tag))) write(dir, `l10n/parts/${part}.${id}.json`, table)
    write(dir, `package.nls.${id}.json`, { a: `Alpha (${tag})`, b: `Beta (${tag})`, c: `Gamma (${tag})` })
  }
  assert.equal(cli(MERGE, [], dir).status, 0)
  assert.equal(cli(SOURCES, ['de', 'fr', 'ja'], dir).status, 0)
  const started = rekey(dir, '--start', 'abc1234')
  assert.equal(started.status, 0, started.stderr)
  return dir
}

/** Appends entries to the ledger, numbered on from its last one, by `P1` unless they say otherwise. */
function append(dir: string, ...entries: Entry[]): void {
  const ledger = read<{ v: number; base: string; entries: Entry[] }>(dir, 'l10n/rekey.json')
  for (const e of entries) ledger.entries.push({ n: ledger.entries.length + 1, by: 'P1', why: `why ${ledger.entries.length + 1}`, ...e })
  write(dir, 'l10n/rekey.json', ledger)
}

/** A package's change of the English, with its German: what the eight kinds of entry then describe. */
function changeTheEnglish(dir: string): void {
  write(dir, 'src/a.ts', "import { t } from './i18n'\nexport const words = [t('Alpha'), t('Beta {0} now', 1), t('Gamma'), t('Epsilon')]\n")
  write(dir, 'l10n/parts/model.de.json', { 'Alpha': 'Alpha (de)', 'Beta {0} now': 'Beta {0} (de)', 'Epsilon': 'Epsilon (de)' })
  write(dir, 'l10n/parts/host.de.json', {})
  write(dir, 'l10n/parts/dashboard.de.json', { Alpha: 'Alpha (de)', Gamma: 'Gamma (de)' })
  write(dir, 'package.nls.json', { a: 'Alpha setting', d: 'Delta setting', b: 'Beta setting, now' })
  write(dir, 'package.nls.de.json', { a: 'Alpha (de)', d: 'Delta (de)', b: 'Beta (de), jetzt' })
  assert.equal(cli(MERGE, [], dir).status, 0)
  assert.equal(cli(SOURCES, ['de'], dir).status, 0)
  append(dir,
    { kind: 'add', part: 'model', key: 'Epsilon', why: 'a new text' },
    { kind: 'reword', part: 'model', old: 'Beta {0}', key: 'Beta {0} now', carry: true, why: 'a clearer word' },
    { kind: 'remove', part: 'host', old: 'Delta', why: 'no call site any more' },
    { kind: 'copy', from: 'text', part: 'dashboard', key: 'Gamma', why: 'the page shows it too' },
    { kind: 'review', part: 'model', key: 'Alpha', why: 'its use narrowed' },
    { kind: 'nls-add', key: 'd', why: 'a new setting' },
    { kind: 'nls-reword', key: 'b', why: 'the example changed' },
    { kind: 'nls-remove', key: 'c', why: 'the setting is gone' },
  )
}

test('--start: the base is the tree as it is — every t() key with the German parts it stands in, every manifest value\'s hash —, the ledger has no entry, and each language but English and German a pending list at cursor 0 (1.10 B1)', () => {
  const dir = tree()
  assert.equal(text(dir, 'l10n/rekey-base.json'), [
    '{',
    '  "v": 1,',
    '  "base": "abc1234",',
    '  "keys": {',
    '    "Alpha": ["dashboard", "model"],',
    '    "Beta {0}": ["model"],',
    '    "Delta": ["host"],',
    '    "Gamma": ["text"]',
    '  },',
    '  "nls": {',
    `    "a": ${JSON.stringify(read(dir, 'l10n/nls-sources/de.json').a)},`,
    `    "b": ${JSON.stringify(read(dir, 'l10n/nls-sources/de.json').b)},`,
    `    "c": ${JSON.stringify(read(dir, 'l10n/nls-sources/de.json').c)}`,
    '  }',
    '}',
    '',
  ].join('\n'))
  assert.equal(text(dir, 'l10n/rekey.json'), '{\n  "v": 1,\n  "base": "abc1234",\n  "entries": []\n}\n')
  for (const id of ['fr', 'ja']) assert.deepEqual(read(dir, `l10n/pending/${id}.json`), { v: 1, applied: 0, bundle: {}, nls: {} })
  assert.deepEqual(readdirSync(join(dir, 'l10n', 'pending')).sort(), ['fr.json', 'ja.json'], 'German or English got a pending list')
  assert.equal(rekey(dir, '--check').status, 0)
  // Nothing pending: a second start writes the same bytes.
  const before = snapshot(dir)
  assert.equal(rekey(dir, '--start', 'abc1234').status, 0)
  assert.deepEqual(snapshot(dir), before)
  // A commit is a commit; a German that does not cover the t() keys is no base.
  for (const bad of ['', 'HEAD', 'abc12', '../x']) assert.equal(rekey(dir, '--start', bad).status, 1, JSON.stringify(bad))
  write(dir, 'src/b.ts', "import { t } from './i18n'\nexport const more = t('Omega')\n")
  const incomplete = rekey(dir, '--start', 'def5678')
  assert.equal(incomplete.status, 1)
  assert.match(incomplete.stderr, /no German part has "Omega"/)
  assert.deepEqual(snapshot(dir), { ...before, 'src/b.ts': text(dir, 'src/b.ts') }, 'a refused start wrote a file')
})

test('each kind applied: add, reword with the translation carried, remove, copy, review, nls-add at the English file\'s position, nls-reword, nls-remove — the cursor at the end, the bundles merged, German and English untouched (1.10 B1)', () => {
  const dir = tree()
  changeTheEnglish(dir)
  const german = only(snapshot(dir), (p) => /\.de\.json$|^package\.nls\.json$|^src\/|^l10n\/nls-sources\/de\.json$/.test(p))
  const r = rekey(dir)
  assert.equal(r.status, 0, r.stderr)
  assert.match(r.stdout, /fr: entries 1–8 applied — pending 1 to translate, 2 to review; manifest 1 to translate, 1 to review/)
  for (const id of ['fr', 'ja']) {
    assert.deepEqual(read(dir, `l10n/parts/model.${id}.json`), { 'Alpha': `Alpha (${id})`, 'Beta {0} now': `Beta {0} (${id})` }, `${id}: model`)
    assert.deepEqual(read(dir, `l10n/parts/host.${id}.json`), {}, `${id}: host`)
    assert.deepEqual(read(dir, `l10n/parts/dashboard.${id}.json`), { Alpha: `Alpha (${id})`, Gamma: `Gamma (${id})` }, `${id}: dashboard`)
    assert.deepEqual(read(dir, `l10n/parts/text.${id}.json`), { Gamma: `Gamma (${id})` }, `${id}: text`)
    // The bundle is merged again from the parts: the old key gone with the removed one, the added one not there yet.
    assert.deepEqual(read(dir, `l10n/bundle.l10n.${id}.json`), { 'Alpha': `Alpha (${id})`, 'Beta {0} now': `Beta {0} (${id})`, 'Gamma': `Gamma (${id})` })
    // The manifest: `d` where the English has it, with the English value; `b` as it was; `c` gone, from the record too.
    assert.equal(text(dir, `package.nls.${id}.json`), `${JSON.stringify({ a: `Alpha (${id})`, d: 'Delta setting', b: `Beta (${id})` }, null, 2)}\n`)
    assert.deepEqual(Object.keys(read(dir, `l10n/nls-sources/${id}.json`)), ['a', 'b'])
    assert.deepEqual(read<Pending>(dir, `l10n/pending/${id}.json`), {
      v: 1, applied: 8,
      bundle: {
        'Epsilon': { parts: ['model'], state: 'translate', why: 'a new text' },
        'Beta {0} now': { parts: ['model'], state: 'review', why: 'a clearer word' },
        'Alpha': { parts: ['model'], state: 'review', why: 'its use narrowed' },
      },
      nls: { d: { state: 'translate', why: 'a new setting' }, b: { state: 'review', why: 'the example changed' } },
    })
  }
  // German is the package's, English the source: the script wrote neither.
  assert.deepEqual(only(snapshot(dir), (p) => p in german), german)
  // The copy was a copy: nothing to translate in the second part while the first holds a translation.
  assert.equal('Gamma' in read<Pending>(dir, 'l10n/pending/fr.json').bundle, false)
  assert.equal(rekey(dir, '--check').status, 0)
  // Idempotent: a second run changes no byte.
  const before = snapshot(dir)
  const again = rekey(dir)
  assert.equal(again.status, 0, again.stderr)
  assert.match(again.stdout, /fr: every entry applied \(8\)/)
  assert.match(again.stdout, /nothing to write/)
  assert.deepEqual(snapshot(dir), before)
})

test('a key that is pending stays pending through the next change: reworded, copied into a second part, reworded without its translation, added to the manifest and reworded there (1.10 B1)', () => {
  const dir = tree()
  changeTheEnglish(dir)
  assert.equal(rekey(dir).status, 0)
  write(dir, 'package.nls.json', { a: 'Alpha setting', d: 'Delta setting', b: 'Beta setting, now', e: 'Epsilon setting, now' })
  append(dir,
    { kind: 'reword', part: 'model', old: 'Epsilon', key: 'Epsilon two', carry: true, why: 'a pending key reworded' },
    { kind: 'copy', from: 'model', part: 'text', key: 'Epsilon two', why: 'a second part' },
    { kind: 'reword', part: 'model', old: 'Alpha', key: 'Alpha new', carry: false, why: 'a new meaning' },
    { kind: 'reword', part: 'model', old: 'Beta {0} now', key: 'Beta {0} later', carry: true, why: 'reworded again' },
    { kind: 'nls-add', key: 'e', why: 'added' },
    { kind: 'nls-reword', key: 'e', why: 'reworded at once' },
  )
  const r = rekey(dir)
  assert.equal(r.status, 0, r.stderr)
  const p = read<Pending>(dir, 'l10n/pending/fr.json')
  assert.equal(p.applied, 14)
  assert.deepEqual(p.bundle, {
    // Carried from a key that had no translation: still nothing to carry — to translate, in both parts.
    'Epsilon two': { parts: ['model', 'text'], state: 'translate', why: 'a pending key reworded; a second part' },
    // A carried key carried on: its review goes with it; one reworded without its translation is to translate.
    'Alpha new': { parts: ['model'], state: 'translate', why: 'a new meaning' },
    'Beta {0} later': { parts: ['model'], state: 'review', why: 'reworded again' },
  })
  assert.deepEqual(read(dir, 'l10n/parts/model.fr.json'), { 'Beta {0} later': 'Beta {0} (fr)' })
  // The dashboard keeps its Alpha: the reword was the model part's.
  assert.deepEqual(read(dir, 'l10n/parts/dashboard.fr.json'), { Alpha: 'Alpha (fr)', Gamma: 'Gamma (fr)' })
  assert.deepEqual(p.nls.e, { state: 'translate', why: 'added; reworded at once' })
  assert.deepEqual(Object.keys(read(dir, 'package.nls.fr.json')), ['a', 'd', 'b', 'e'])
})

test('--check: every entry well-formed and applied, no pending list for German or English, none for a language that is not one — each failure named (1.10 B1)', () => {
  const dir = tree()
  changeTheEnglish(dir)
  assert.equal(rekey(dir).status, 0)
  assert.match(rekey(dir, '--check').stdout, /every entry is applied \(8 entries since abc1234; 2 language\(s\) with a pending list\)/)
  // An entry appended and not applied: the cursor is behind.
  append(dir, { kind: 'add', part: 'text', key: 'Zeta' })
  const behind = rekey(dir, '--check')
  assert.equal(behind.status, 1)
  assert.match(behind.stderr, /fr: l10n\/pending\/fr\.json has 8 of the ledger's 9 entries applied — run node scripts\/l10n-rekey\.mjs/)
  assert.match(behind.stderr, /ja: l10n\/pending\/ja\.json has 8 of the ledger's 9 entries applied/)
  assert.equal(rekey(dir).status, 0)
  assert.equal(rekey(dir, '--check').status, 0)
  // Malformed entries: each named, and the script applies nothing while one stands.
  const ledger = read<{ v: number; base: string; entries: Entry[] }>(dir, 'l10n/rekey.json')
  const broken: Array<[Entry, RegExp]> = [
    [{ kind: 'rename', key: 'x', why: 'y' }, /entry 10 has the kind "rename", none of add, reword/],
    [{ kind: 'add', part: 'model', key: 'x' }, /entry 10 \(add\): why must say why/],
    [{ kind: 'add', part: 'page', key: 'x', why: 'y' }, /entry 10 \(add\): part "page" names no part — l10n\/parts\/<part>\.de\.json exists for dashboard, host, model, text/],
    [{ kind: 'add', part: 'model', key: 'x', old: 'w', why: 'y' }, /entry 10 \(add\) has the field "old", which an entry of this kind does not have/],
    [{ kind: 'reword', part: 'model', old: 'w', key: 'x', why: 'y' }, /entry 10 \(reword\) lacks the field "carry"/],
    [{ kind: 'reword', part: 'model', old: 'x', key: 'x', carry: 'yes' as unknown as boolean, why: 'y' }, /carry must be true .*\n.*old and key are the same text/],
    [{ kind: 'copy', from: 'model', part: 'model', key: 'x', why: 'y' }, /entry 10 \(copy\): from and part are the same part/],
    [{ kind: 'nls-add', key: 'a b', why: 'y' }, /entry 10 \(nls-add\): "a b" is no key of package\.nls\.json's form/],
    [{ n: 12, kind: 'remove', part: 'host', old: 'x', why: 'y' }, /entry 10 has n 12 — the entries are numbered 1, 2, 3 … in the order made/],
    [{ kind: 'review', part: 'model', key: 'x', why: 'y', by: '' }, /entry 10 \(review\): by must name the package that made the change/],
  ]
  for (const [e, message] of broken) {
    write(dir, 'l10n/rekey.json', { ...ledger, entries: [...ledger.entries, { n: 10, by: 'P1', ...e }] })
    const check = rekey(dir, '--check')
    assert.equal(check.status, 1, JSON.stringify(e))
    assert.match(check.stderr, message)
    const before = snapshot(dir)
    const apply = rekey(dir)
    assert.equal(apply.status, 1, `applied a malformed ledger: ${JSON.stringify(e)}`)
    assert.deepEqual(snapshot(dir), before, 'a malformed ledger wrote a file')
  }
  write(dir, 'l10n/rekey.json', ledger)
  assert.equal(rekey(dir, '--check').status, 0)
  // A pending list for German, for English, for no language — and one that is no list.
  for (const [id, message] of [
    ['de', /de: l10n\/pending\/de\.json exists — German is written by the package that changes the English, never pending/],
    ['en', /en: l10n\/pending\/en\.json exists — English is the source/],
    ['xx', /xx: l10n\/pending\/xx\.json names no language of the registry with files on disk/],
  ] as const) {
    write(dir, `l10n/pending/${id}.json`, { v: 1, applied: 9, bundle: {}, nls: {} })
    const check = rekey(dir, '--check')
    assert.equal(check.status, 1, id)
    assert.match(check.stderr, message)
    rmSync(join(dir, 'l10n', 'pending', `${id}.json`))
  }
  const good = text(dir, 'l10n/pending/ja.json')
  write(dir, 'l10n/pending/ja.json', { v: 1, applied: 9, bundle: { Zeta: { parts: ['page'], state: 'maybe', why: '' } }, nls: [] })
  const shape = rekey(dir, '--check')
  assert.equal(shape.status, 1)
  for (const m of [/bundle "Zeta": parts \["page"\] is not a list of parts/, /bundle "Zeta": state "maybe" is neither translate nor review/, /bundle "Zeta": why is missing/, /nls is not an object/]) {
    assert.match(shape.stderr, m)
  }
  write(dir, 'l10n/pending/ja.json', good)
  // The ledger and its base belong together.
  write(dir, 'l10n/rekey-base.json', text(dir, 'l10n/rekey-base.json').replace('"abc1234"', '"def5678"'))
  assert.match(rekey(dir, '--check').stderr, /l10n\/rekey-base\.json is the tree at "def5678", the ledger starts at "abc1234"/)
})

test('a language without a pending list has done everything the ledger asks: the script leaves its files alone, --check passes it, and a new ledger may start only once every language is done (1.10 B1)', () => {
  const dir = tree()
  changeTheEnglish(dir)
  assert.equal(rekey(dir).status, 0)
  // Japanese works through its list — as its package does — and deletes it.
  // (A key in two parts has one translation: merge-l10n.mjs refuses two.)
  write(dir, 'l10n/parts/model.ja.json', { 'Alpha': 'アルファ', 'Beta {0} now': 'ベータ {0}', 'Epsilon': 'イプシロン' })
  write(dir, 'l10n/parts/dashboard.ja.json', { Alpha: 'アルファ', Gamma: 'Gamma (ja)' })
  write(dir, 'package.nls.ja.json', { a: 'アルファ', d: 'デルタ', b: 'ベータ、今' })
  assert.equal(cli(SOURCES, ['ja'], dir).status, 0)
  assert.equal(cli(MERGE, [], dir).status, 0)
  // While French has work pending, no new ledger.
  const busy = rekey(dir, '--start', 'def5678')
  assert.equal(busy.status, 1)
  assert.match(busy.stderr, /a language has work pending — finish it before a new ledger starts:\n.*fr: 5 key\(s\) pending/)
  rmSync(join(dir, 'l10n', 'pending', 'ja.json'))
  const ja = only(snapshot(dir), (p) => /\.ja\.json$/.test(p))
  // An entry after the list is gone does not reach the language: its package is done (the join holds it to every key).
  append(dir, { kind: 'add', part: 'text', key: 'Zeta' })
  const r = rekey(dir)
  assert.equal(r.status, 0, r.stderr)
  assert.match(r.stdout, /ja: no pending list — its package has done everything the ledger asks/)
  assert.deepEqual(only(snapshot(dir), (p) => /\.ja\.json$/.test(p)), ja)
  assert.equal(rekey(dir, '--check').status, 0)
  assert.equal(existsSync(join(dir, 'l10n', 'pending', 'ja.json')), false)
  assert.match(rekey(dir, '--print', 'ja').stdout, /ja has no pending list — its package has done everything the ledger asks/)
})

test('--print <id>: the work list as two tables — each key with its part, its state, the English, the German, the value it holds and why — and nothing for German, English or no language (1.10 B1)', () => {
  const dir = tree()
  changeTheEnglish(dir)
  assert.equal(rekey(dir).status, 0)
  const before = snapshot(dir)
  const r = rekey(dir, '--print', 'fr')
  assert.equal(r.status, 0, r.stderr)
  assert.deepEqual(snapshot(dir), before, '--print wrote a file')
  const out = r.stdout
  for (const line of [
    'l10n-rekey: fr — 8 of the ledger\'s 8 entries applied (base abc1234)',
    'Runtime strings — 1 to translate, 2 to review (l10n/parts/<part>.fr.json, then node scripts/merge-l10n.mjs):',
    '| # | State | Part | English (the key) | German | Carried | Why |',
    '| 1 | translate | model | "Epsilon" | "Epsilon (de)" | – | a new text |',
    '| 2 | review | model | "Beta {0} now" | "Beta {0} (de)" | "Beta {0} (fr)" | a clearer word |',
    '| 3 | review | model | "Alpha" | "Alpha (de)" | "Alpha (fr)" | its use narrowed |',
    'Manifest — 1 to translate, 1 to review (package.nls.fr.json, then node scripts/nls-sources.mjs fr):',
    '| # | State | Key | English | German | Carried | Why |',
    '| 1 | translate | d | "Delta setting" | "Delta (de)" | – | a new setting |',
    '| 2 | review | b | "Beta setting, now" | "Beta (de), jetzt" | "Beta (fr)" | the example changed |',
    'Once both lists are done: node scripts/nls-sources.mjs fr, then delete l10n/pending/fr.json.',
  ]) assert.ok(out.split('\n').includes(line), `--print does not print: ${line}\n${out}`)
  // A pipe inside a text is escaped, a line break is written as \n: one row per key.
  write(dir, 'l10n/parts/model.fr.json', { 'Alpha': 'A | B\nC', 'Beta {0} now': 'Beta {0} (fr)' })
  assert.ok(rekey(dir, '--print', 'fr').stdout.includes('| 3 | review | model | "Alpha" | "Alpha (de)" | "A \\| B\\nC" | its use narrowed |'))
  for (const [args, message] of [
    [['--print', 'de'], /de has no pending list — German is written by the package that changes the English, and English is the source/],
    [['--print', 'en'], /en has no pending list/],
    [['--print', 'xx'], /"xx" is no language of the registry with files on disk/],
    [['--print'], /name a language — node scripts\/l10n-rekey\.mjs --print <id>/],
    [['--apply'], /unknown argument\(s\): --apply/],
  ] as const) {
    const bad = rekey(dir, ...args)
    assert.equal(bad.status, 1, args.join(' '))
    assert.match(bad.stderr, message)
  }
})

test('the tests\' helper reads a language\'s pending manifest keys, and none where it has no list (1.10 B1)', () => {
  const dir = tree()
  changeTheEnglish(dir)
  assert.equal(rekey(dir).status, 0)
  assert.deepEqual([...pendingNlsKeys('fr', dir)].sort(), ['b', 'd'])
  assert.deepEqual([...pendingNlsKeys('de', dir)], [])
  write(dir, 'l10n/pending/ja.json', '{ not json')
  assert.deepEqual([...pendingNlsKeys('ja', dir)], [])
})

test('the repository\'s ledger: 1.10\'s starts at e72057a — 1123 t() keys, 295 manifest keys, one line each —, a list exists only for the twelve languages beyond English and German, each at the ledger\'s end, and none of these files ships (1.10 P1)', () => {
  const base = read<{ v: number; base: string; keys: Record<string, string[]>; nls: Table }>(ROOT, 'l10n/rekey-base.json')
  const ledger = read<{ v: number; base: string; entries: Entry[] }>(ROOT, 'l10n/rekey.json')
  assert.deepEqual([base.v, base.base], [1, ledger.base])
  // 1.10 P1 wrote the base from the 1.9.0 release commit; a later version's --start writes its own, and this pin with it.
  if (base.base === 'e72057a') {
    assert.equal(Object.keys(base.keys).length, 1123)
    assert.equal(Object.keys(base.nls).length, 295)
  }
  // The base file is what --start writes: one line per key and per manifest key.
  assert.equal(text(ROOT, 'l10n/rekey-base.json').split('\n').length, Object.keys(base.keys).length + Object.keys(base.nls).length + 9)
  // A list for each language that has not finished its work (P1 wrote twelve at cursor 0; a language's package deletes its own).
  const twelve = ['cs', 'es', 'fr', 'it', 'ja', 'ko', 'pl', 'pt-br', 'ru', 'tr', 'zh-cn', 'zh-tw']
  const dir = join(ROOT, 'l10n', 'pending')
  const ids = existsSync(dir) ? readdirSync(dir).map((f) => f.replace(/\.json$/, '')).sort() : []
  assert.deepEqual(ids.filter((id) => !twelve.includes(id)), [], 'a pending list for English, German or no language')
  for (const id of ids) assert.equal(read<Pending>(ROOT, `l10n/pending/${id}.json`).applied, ledger.entries.length, id)
  // .vscodeignore ships nothing under l10n/ but the bundles.
  const negations = text(ROOT, '.vscodeignore').split('\n').filter((l) => l.startsWith('!l10n'))
  assert.deepEqual(negations, ['!l10n/bundle.l10n.*.json'])
})

test('docs/development.md says how an English change reaches the languages: the ledger and its base, the eight kinds, the script and its options, the pending lists, the frame while they exist, the freeze and the join (1.10 P1)', () => {
  const flat = (s: string): string => s.replace(/\s+/g, ' ')
  const dev = flat(text(ROOT, 'docs/development.md'))
  for (const claim of [
    '### Changing the English: the re-key ledger (1.10)',
    '`l10n/rekey.json`', '`l10n/rekey-base.json`', '`l10n/pending/<id>.json`', '`scripts/l10n-rekey.mjs`',
    'German is never in the ledger\'s hands',
    'node scripts/l10n-rekey.mjs --print <id>', 'node scripts/l10n-rekey.mjs --start <sha>', 'node scripts/l10n-rekey.mjs --check',
    'node scripts/nls-sources.mjs --check --strict <id>',
    '`PENDING_ALLOWED`', '**T14**', 'an English change without its entry fails',
    'the English is frozen again after the second review',
    'A language without a pending list has done everything the ledger asks',
    '`t()` falls back to the English',
    'l10n/rekey.json`, `l10n/rekey-base.json` and `l10n/pending/`',
  ]) assert.ok(dev.includes(claim), `docs/development.md does not say: ${claim}`)
  // The eight kinds, each with its fields, as the script's ENTRY_FIELDS has them.
  const script = text(ROOT, 'scripts/l10n-rekey.mjs')
  for (const [kind, fields] of [['add', 'part, key'], ['reword', 'part, old, key, carry'], ['remove', 'part, old'], ['copy', 'from, part, key'],
    ['review', 'part, key'], ['nls-add', 'key'], ['nls-reword', 'key'], ['nls-remove', 'key']]) {
    assert.ok(dev.includes(`| \`${kind}\` | ${fields.split(', ').map((f) => `\`${f}\``).join(', ')} |`), `docs/development.md's table has no row for ${kind}`)
    const listed = fields.split(', ').map((f) => `'${f}'`).join(', ')
    assert.ok(script.includes(`'${kind}': [${listed}]`), `ENTRY_FIELDS no longer gives ${kind} ${fields}`)
  }
})
