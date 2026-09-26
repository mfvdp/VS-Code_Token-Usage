// SPDX-FileCopyrightText: 2026 Frederik Marx
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * 1.10 A (spec §3 A1, §0a.1; P3): the prompt list, pure — the file's strict shape, the cleaning of a title and
 * a text, the shipped prompts in the reader's language, and the four operations on the list.
 */

import { strict as assert } from 'node:assert'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { setBundle, setLocale } from '../src/i18n'
import { KEEP_WARM_LINE } from '../src/keepWarm'
import {
  applyPromptOp, cleanPromptsFile, cleanPromptText, cleanPromptTitle, parsePromptsText, PROMPT_ID_RE, PROMPT_TEXT_MAX_CHARS,
  PROMPT_TITLE_MAX_CHARS, promptEntries, promptFieldProblem, PromptOp, PromptsFile, PromptsRead, PROMPTS_FILE_MAX_BYTES,
  PROMPTS_FILE_NAME, PROMPTS_FILE_VERSION, PROMPTS_MAX, promptTextOf, SHIPPED_PROMPT_KEY, SHIPPED_PROMPTS, shippedPromptText,
  shippedPromptTitle, userIdFrom,
} from '../src/prompts'
import { ROOT } from './helpers/nls'

const GERMAN = JSON.parse(readFileSync(join(ROOT, 'l10n', 'bundle.l10n.de.json'), 'utf8')) as Record<string, string>

function under<T>(bundle: Record<string, string> | undefined, run: () => T): T {
  try {
    setBundle(bundle)
    setLocale(bundle === undefined ? undefined : 'de')
    return run()
  } finally {
    setBundle(undefined)
    setLocale(undefined)
  }
}

/** §0a.1's example, the file's documented shape. */
const EXAMPLE = {
  v: 1, prompts: [
    { id: 's-status' },
    { id: 's-keepwarm', title: 'Keep warm (loop)', text: '/loop 30m Ignore this message. No action. No response.' },
    { id: 'u-3k9x0a2b', title: 'Review', text: 'Review the last diff for correctness.' },
  ],
}

const ok = (prompts: PromptsFile['prompts']): PromptsRead => ({ state: 'ok', file: { v: 1, prompts } })
let draws = 0
const nextId = (): string => `u-${String(++draws).padStart(8, '0')}`

test('the constants of the list and its file (§2.1)', () => {
  assert.deepEqual(SHIPPED_PROMPTS, ['status', 'keepWarm', 'stop'])
  assert.deepEqual(SHIPPED_PROMPT_KEY, { status: 's-status', keepWarm: 's-keepwarm', stop: 's-stop' })
  assert.deepEqual([PROMPTS_FILE_NAME, PROMPTS_FILE_VERSION, PROMPTS_MAX, PROMPT_TITLE_MAX_CHARS, PROMPT_TEXT_MAX_CHARS, PROMPTS_FILE_MAX_BYTES],
    ['prompts.json', 1, 50, 80, 2000, 512 * 1024])
  for (const id of ['s-status', 's-keepwarm', 's-stop', 'u-abcdefgh', 'u-0a1b2c3d']) assert.ok(PROMPT_ID_RE.test(id), id)
  for (const id of ['s-other', 'U-ABCDEFGH', 'u-ABCDEFGH', 'u-abcdefg', 'u-abcdefghi', '../x', 's-status ', ' u-abcdefgh']) assert.equal(PROMPT_ID_RE.test(id), false, id)
})

test('cleanPromptsFile: the documented example reads back as written (§0a.1)', () => {
  assert.deepEqual(cleanPromptsFile(JSON.parse(JSON.stringify(EXAMPLE))), { state: 'ok', file: EXAMPLE })
  assert.deepEqual(cleanPromptsFile({ v: 1, prompts: [] }), { state: 'ok', file: { v: 1, prompts: [] } })
})

test('cleanPromptsFile: anything but the shape is unreadable, never repaired; a newer version is newer (§3 A1 test list)', () => {
  const bad: Array<[string, unknown]> = [
    ['an extra top-level key', { ...EXAMPLE, extra: 1 }],
    ['an extra entry key', { v: 1, prompts: [{ id: 'u-3k9x0a2b', title: 'T', text: 'x', sentAt: 1 }] }],
    ['v 0', { v: 0, prompts: [] }],
    ['v "1"', { v: '1', prompts: [] }],
    ['v 1.5', { v: 1.5, prompts: [] }],
    ['no v', { prompts: [] }],
    ['prompts not a list', { v: 1, prompts: {} }],
    ['51 entries', { v: 1, prompts: Array.from({ length: 51 }, (_, i) => ({ id: `u-${String(i).padStart(8, '0')}`, title: 't', text: 'x' })) }],
    ['a duplicate id', { v: 1, prompts: [{ id: 's-status' }, { id: 's-status' }] }],
    ['s-other', { v: 1, prompts: [{ id: 's-other' }] }],
    ['U-ABCDEFGH', { v: 1, prompts: [{ id: 'U-ABCDEFGH', title: 't', text: 'x' }] }],
    ['a shipped entry with a title but no text', { v: 1, prompts: [{ id: 's-stop', title: 'Stop' }] }],
    ['a user entry without a text', { v: 1, prompts: [{ id: 'u-3k9x0a2b', title: 'Review' }] }],
    ['a user entry that is an id alone', { v: 1, prompts: [{ id: 'u-3k9x0a2b' }] }],
    ['a title of 81', { v: 1, prompts: [{ id: 'u-3k9x0a2b', title: 'a'.repeat(81), text: 'x' }] }],
    ['a text of 2001', { v: 1, prompts: [{ id: 'u-3k9x0a2b', title: 't', text: 'a'.repeat(2001) }] }],
    ['a text with \\n', { v: 1, prompts: [{ id: 'u-3k9x0a2b', title: 't', text: 'a\nb' }] }],
    ['a text with \\u001b', { v: 1, prompts: [{ id: 'u-3k9x0a2b', title: 't', text: '\u001b[31mred' }] }],
    ['a text starting with !', { v: 1, prompts: [{ id: 'u-3k9x0a2b', title: 't', text: '!ls' }] }],
    ['a text with spaces around', { v: 1, prompts: [{ id: 'u-3k9x0a2b', title: 't', text: ' x ' }] }],
    ['an empty title', { v: 1, prompts: [{ id: 'u-3k9x0a2b', title: '', text: 'x' }] }],
    ['a number for a text', { v: 1, prompts: [{ id: 'u-3k9x0a2b', title: 't', text: 5 }] }],
    ['an entry that is no object', { v: 1, prompts: ['s-status'] }],
    ['an array', [EXAMPLE]],
    ['null', null],
  ]
  for (const [what, raw] of bad) assert.deepEqual(cleanPromptsFile(raw), { state: 'unreadable', kind: 'shape' }, what)
  // A newer build's file, whatever else it holds: read-only, never written over.
  assert.deepEqual(cleanPromptsFile({ v: 2, prompts: [] }), { state: 'newer', v: 2 })
  assert.deepEqual(cleanPromptsFile({ v: 3, prompts: [], tags: [] }), { state: 'newer', v: 3 })
})

test('parsePromptsText: a text larger than 512 KiB is too large without JSON.parse being called; not JSON is json (§3 A1)', () => {
  const real = JSON.parse
  let parses = 0
  JSON.parse = ((...a: Parameters<typeof JSON.parse>) => { parses++; return real(...a) }) as typeof JSON.parse
  try {
    const big = JSON.stringify({ v: 1, prompts: [] }) + ' '.repeat(513 * 1024)
    assert.deepEqual(parsePromptsText(big), { state: 'unreadable', kind: 'tooLarge' })
    assert.equal(parses, 0, 'a file above the bound was parsed')
    assert.deepEqual(parsePromptsText('{ "v": 1, "prompts": [ }'), { state: 'unreadable', kind: 'json' })
    assert.deepEqual(parsePromptsText(JSON.stringify(EXAMPLE)), { state: 'ok', file: EXAMPLE })
    assert.equal(parses, 2)
  } finally {
    JSON.parse = real
  }
  // Mutation (§3 A1): taking the first 50 of 51 entries would make the 51 case readable — the count is checked whole.
  const fiftyOne = { v: 1, prompts: Array.from({ length: 51 }, (_, i) => ({ id: `u-${String(i).padStart(8, '0')}`, title: 't', text: 'x' })) }
  assert.equal(cleanPromptsFile(fiftyOne).state, 'unreadable')
  assert.equal(cleanPromptsFile({ ...fiftyOne, prompts: fiftyOne.prompts.slice(0, 50) }).state, 'ok')
})

test('cleanPromptText and cleanPromptTitle: one line, no control character, trimmed, within their bounds; a text never starts with ! (§3 A1 rule 3)', () => {
  const cases: Array<[unknown, string | null]> = [
    ['a\nb', 'a b'], ['a\r\nb', 'a b'], ['a\rb', 'a b'], ['a b c', 'a b c'], ['\t x', 'x'], ['\u001b[31mred', '[31mred'], ['\u0085x', 'x'],
    ['\u007fx\u009f', 'x'], ['  x  ', 'x'], ['', null], [' ', null], ['\n\t', null], ['!ls', null], ['  !ls', null], ['\n!ls', null],
    ['a'.repeat(2001), null], ['a'.repeat(2000), 'a'.repeat(2000)],
    ['/loop 30m Ignore this message. No action. No response.', '/loop 30m Ignore this message. No action. No response.'],
    ['# note', '# note'], ['@file', '@file'], ['?', '?'], ['a!b', 'a!b'],
    [5, null], [null, null], [undefined, null], [['x'], null],
  ]
  for (const [raw, want] of cases) assert.equal(cleanPromptText(raw), want, JSON.stringify(raw))
  // A title: the same cleaning, 1–80, and an exclamation mark is a title's own business.
  assert.equal(cleanPromptTitle(' Status\ttable\n'), 'Status table')
  assert.equal(cleanPromptTitle('a'.repeat(80)), 'a'.repeat(80))
  assert.equal(cleanPromptTitle('a'.repeat(81)), null)
  assert.equal(cleanPromptTitle('!Now'), '!Now')
  assert.equal(cleanPromptTitle(''), null)
  assert.equal(cleanPromptTitle(7), null)
  // The cleaning shortens a value within the bound, never lengthens one: \r\n is one space.
  assert.equal(cleanPromptText(`${'a'.repeat(1999)}\r\n`), 'a'.repeat(1999))
  // Why a save is refused, in the order the section says it: the title first.
  assert.equal(promptFieldProblem('', ''), 'titleEmpty')
  assert.equal(promptFieldProblem('a'.repeat(81), 'x'), 'titleLong')
  assert.equal(promptFieldProblem('t', ' '), 'textEmpty')
  assert.equal(promptFieldProblem('t', 'a'.repeat(2001)), 'textLong')
  assert.equal(promptFieldProblem('t', ' !rm -rf .'), 'textBang')
  assert.equal(promptFieldProblem('t', 'x'), null)
})

test('the shipped prompts follow the language, the keep-warm text is English in every one, and an edited entry keeps its words (§3.0 c, §3 A1 rule 1)', () => {
  const english = promptEntries({ state: 'absent' })
  assert.deepEqual(english, {
    writable: true, restorable: 0, entries: [
      { id: 's-status', shipped: 'status', title: 'Status table', text: 'Show the current progress in a clear table. Columns: step/status | description | model | duration | expected to finish.', edited: false },
      { id: 's-keepwarm', shipped: 'keepWarm', title: 'Keep the cache warm', text: KEEP_WARM_LINE, edited: false },
      { id: 's-stop', shipped: 'stop', title: 'Stop after this task', text: 'Stop after the current task and do not start any new work.', edited: false },
    ],
  })
  assert.equal(KEEP_WARM_LINE, 'Ignore this message. No action. No response.')
  // Frederik's own words in German, verbatim — his „Model" included (§7a Q28).
  const german = under(GERMAN, () => promptEntries({ state: 'absent' }).entries.map((e) => [e.title, e.text]))
  assert.deepEqual(german, [
    ['Zwischenstand als Tabelle', 'Zeige den aktuellen Zwischenstand in einer übersichtlichen Tabelle an. Spalten: Schritt/Status | Beschreibung | Model | Dauer | voraussichtlich fertig.'],
    ['Cache warmhalten', KEEP_WARM_LINE],
    ['Nach dieser Aufgabe stoppen', 'Nach der laufenden Aufgabe stoppen und keine neue Arbeit beginnen.'],
  ])
  // A synthetic French bundle: the shipped words follow, the keep-warm text does not, an edited entry keeps its words.
  const french = { 'Status table': 'Tableau d’avancement', 'Keep the cache warm': 'Garder le cache chaud', [KEEP_WARM_LINE]: 'NE PAS TRADUIRE' }
  const read = ok([{ id: 's-status' }, { id: 's-keepwarm' }, { id: 'u-3k9x0a2b', title: 'Review', text: 'Review the last diff.' }])
  const fr = under(french, () => promptEntries(read).entries)
  assert.deepEqual(fr.map((e) => [e.title, e.text, e.edited]), [
    ['Tableau d’avancement', shippedPromptText('status'), false],
    ['Garder le cache chaud', KEEP_WARM_LINE, false],
    ['Review', 'Review the last diff.', false],
  ])
  // An edited shipped entry is the reader's words in every language.
  const edited = ok([{ id: 's-stop', title: 'Halt', text: 'Stop now.' }])
  for (const bundle of [undefined, GERMAN, french]) {
    assert.deepEqual(under(bundle, () => promptEntries(edited).entries), [{ id: 's-stop', shipped: 'stop', title: 'Halt', text: 'Stop now.', edited: true }])
  }
  // What a send types for an id: the stored words, or the shipped ones of now.
  assert.deepEqual(under(GERMAN, () => promptTextOf({ state: 'absent' }, 's-keepwarm')), { title: 'Cache warmhalten', text: KEEP_WARM_LINE })
  assert.equal(promptTextOf({ state: 'absent' }, 'u-3k9x0a2b'), null)
})

test('an unreadable or newer file shows the three shipped entries, read-only; restorable counts the missing shipped ids (§3 A1 rule 5)', () => {
  for (const read of [{ state: 'unreadable', kind: 'json' }, { state: 'unreadable', kind: 'io' }, { state: 'newer', v: 2 }] as PromptsRead[]) {
    const r = promptEntries(read)
    assert.equal(r.writable, false)
    assert.equal(r.restorable, 0)
    assert.deepEqual(r.entries.map((e) => [e.id, e.edited]), [['s-status', false], ['s-keepwarm', false], ['s-stop', false]])
  }
  const r = promptEntries(ok([{ id: 'u-3k9x0a2b', title: 'Review', text: 'x' }, { id: 's-keepwarm' }]))
  assert.equal(r.writable, true)
  assert.equal(r.restorable, 2)
  assert.deepEqual(r.entries.map((e) => e.id), ['u-3k9x0a2b', 's-keepwarm'])
})

test('applyPromptOp: add, full, save as a reference or edited, delete, move, restore (§3 A1 rule 4)', () => {
  const absent: PromptsRead = { state: 'absent' }
  // The first change writes the list as it was — the three references — plus that change.
  const added = applyPromptOp(absent, { op: 'save', id: null, title: ' Review ', text: 'Review the last diff.\n' }, () => 'u-3k9x0a2b')
  assert.deepEqual(added, {
    result: 'added', restored: 0,
    file: { v: 1, prompts: [{ id: 's-status' }, { id: 's-keepwarm' }, { id: 's-stop' }, { id: 'u-3k9x0a2b', title: 'Review', text: 'Review the last diff.' }] },
  })
  // A colliding draw is drawn again; a draw that is no user id is not taken.
  const seq = ['u-3k9x0a2b', 's-status', 'u-ABCDEFGH', 'u-00000001']
  const again = applyPromptOp(ok(added.file!.prompts), { op: 'save', id: null, title: 'B', text: 'b' }, () => seq.shift()!)
  assert.equal(again.result, 'added')
  assert.equal(again.file!.prompts[4].id, 'u-00000001')
  // 50 entries: full, nothing to write.
  const fifty = ok(Array.from({ length: 50 }, (_, i) => ({ id: `u-${String(i).padStart(8, '0')}`, title: 't', text: 'x' })))
  assert.deepEqual(applyPromptOp(fifty, { op: 'save', id: null, title: 'New', text: 'x' }, nextId), { file: null, result: 'full', restored: 0 })
  // A save with the shipped words of the current language is the reference again — German under a German bundle.
  const editedStatus = ok([{ id: 's-status', title: 'Mine', text: 'My table.' }, { id: 's-stop' }])
  const back = under(GERMAN, () => applyPromptOp(editedStatus, {
    op: 'save', id: 's-status', title: 'Zwischenstand als Tabelle',
    text: 'Zeige den aktuellen Zwischenstand in einer übersichtlichen Tabelle an. Spalten: Schritt/Status | Beschreibung | Model | Dauer | voraussichtlich fertig.',
  }, nextId))
  assert.deepEqual(back, { result: 'saved', restored: 0, file: { v: 1, prompts: [{ id: 's-status' }, { id: 's-stop' }] } })
  // Other words: edited. The same words again: unchanged, nothing to write.
  const edited = applyPromptOp(ok([{ id: 's-status' }]), { op: 'save', id: 's-status', title: 'Status table', text: 'Show it as a list.' }, nextId)
  assert.deepEqual(edited.file, { v: 1, prompts: [{ id: 's-status', title: 'Status table', text: 'Show it as a list.' }] })
  assert.equal(applyPromptOp(ok(edited.file!.prompts), { op: 'save', id: 's-status', title: 'Status table', text: 'Show it as a list.' }, nextId).result, 'unchanged')
  // The shipped words while there is no file: nothing changes, so no file is written.
  assert.deepEqual(applyPromptOp(absent, { op: 'save', id: 's-stop', title: 'Stop after this task', text: 'Stop after the current task and do not start any new work.' }, nextId),
    { file: null, result: 'unchanged', restored: 0 })
  // Invalid words, an id that is gone, an id that is no id.
  assert.equal(applyPromptOp(absent, { op: 'save', id: 's-stop', title: '', text: 'x' }, nextId).result, 'invalid')
  assert.equal(applyPromptOp(absent, { op: 'save', id: 's-stop', title: 't', text: '!ls' }, nextId).result, 'invalid')
  assert.equal(applyPromptOp(absent, { op: 'save', id: 'u-3k9x0a2b', title: 't', text: 'x' }, nextId).result, 'notFound')
  assert.equal(applyPromptOp(absent, { op: 'save', id: '../x', title: 't', text: 'x' }, nextId).result, 'invalid')
  // Delete, and delete again (another window already did).
  const deleted = applyPromptOp(absent, { op: 'delete', id: 's-keepwarm' }, nextId)
  assert.deepEqual(deleted, { result: 'deleted', restored: 0, file: { v: 1, prompts: [{ id: 's-status' }, { id: 's-stop' }] } })
  assert.deepEqual(applyPromptOp(ok(deleted.file!.prompts), { op: 'delete', id: 's-keepwarm' }, nextId), { file: null, result: 'notFound', restored: 0 })
  // Move: a swap with the neighbour; at an end nothing.
  assert.deepEqual(applyPromptOp(absent, { op: 'move', id: 's-stop', dir: 'up' }, nextId).file, { v: 1, prompts: [{ id: 's-status' }, { id: 's-stop' }, { id: 's-keepwarm' }] })
  assert.deepEqual(applyPromptOp(absent, { op: 'move', id: 's-status', dir: 'up' }, nextId), { file: null, result: 'unchanged', restored: 0 })
  assert.deepEqual(applyPromptOp(absent, { op: 'move', id: 's-stop', dir: 'down' }, nextId), { file: null, result: 'unchanged', restored: 0 })
  assert.equal(applyPromptOp(absent, { op: 'move', id: 'u-3k9x0a2b', dir: 'down' }, nextId).result, 'notFound')
  // Restore after a delete: the one missing at the end, in the shipped order.
  const user = { id: 'u-3k9x0a2b', title: 'Review', text: 'x' }
  assert.deepEqual(applyPromptOp(ok([user, { id: 's-stop' }]), { op: 'restore' }, nextId), {
    result: 'restored', restored: 2, file: { v: 1, prompts: [user, { id: 's-stop' }, { id: 's-status' }, { id: 's-keepwarm' }] },
  })
  assert.deepEqual(applyPromptOp(ok(deleted.file!.prompts), { op: 'restore' }, nextId).file!.prompts.map((p) => p.id), ['s-status', 's-stop', 's-keepwarm'])
  // None missing: unchanged — and an edited shipped entry is not missing, it stays as the reader wrote it (§7 Q11).
  const keptEdit = ok([{ id: 's-status', title: 'Mine', text: 'My table.' }, { id: 's-keepwarm' }, { id: 's-stop' }])
  assert.deepEqual(applyPromptOp(keptEdit, { op: 'restore' }, nextId), { file: null, result: 'unchanged', restored: 0 })
  assert.deepEqual(applyPromptOp({ state: 'absent' }, { op: 'restore' }, nextId), { file: null, result: 'unchanged', restored: 0 })
  // A list with room for fewer than are missing gets as many as fit, in order; with no room, full.
  const fortyNine = ok(Array.from({ length: 49 }, (_, i) => ({ id: `u-${String(i).padStart(8, '0')}`, title: 't', text: 'x' })))
  const partly = applyPromptOp(fortyNine, { op: 'restore' }, nextId)
  assert.equal(partly.result, 'restored')
  assert.equal(partly.restored, 1)
  assert.deepEqual(partly.file!.prompts.slice(-1), [{ id: 's-status' }])
  assert.deepEqual(applyPromptOp(fifty, { op: 'restore' }, nextId), { file: null, result: 'full', restored: 0 })
  // Whatever the operation, the written list reads back by the file's own shape.
  for (const r of [added, again, back, edited, deleted, partly]) assert.equal(cleanPromptsFile(JSON.parse(JSON.stringify(r.file))).state, 'ok')
  // An unreadable or newer file is changed by nothing.
  for (const read of [{ state: 'unreadable', kind: 'shape' }, { state: 'newer', v: 2 }] as PromptsRead[]) {
    for (const op of [{ op: 'restore' }, { op: 'delete', id: 's-status' }, { op: 'save', id: null, title: 't', text: 'x' }] as PromptOp[]) {
      assert.deepEqual(applyPromptOp(read, op, nextId), { file: null, result: 'invalid', restored: 0 })
    }
  }
})

test('a new id is u- and eight of [a-z0-9], from bytes below the last whole multiple of 36 (§3 A1 rule 4)', () => {
  assert.equal(userIdFrom(Uint8Array.from([0, 1, 25, 26, 35, 36, 251, 7])), 'u-abz09a9h')
  // 252–255 would favour the first four characters: they are skipped.
  assert.equal(userIdFrom(Uint8Array.from([255, 252, 0, 0, 0, 0, 0, 0, 0, 0])), 'u-aaaaaaaa')
  assert.equal(userIdFrom(Uint8Array.from([0, 0, 0])), null)
  for (let i = 0; i < 20; i++) {
    const id = userIdFrom(Uint8Array.from({ length: 16 }, () => Math.floor(Math.random() * 252)))
    assert.ok(id !== null && PROMPT_ID_RE.test(id), String(id))
  }
})

test('every bundle\'s status text keeps the table\'s four “ | ” and its “/”; the German keeps Frederik\'s words (§3 A7 test 4)', () => {
  const key = shippedPromptText('status')
  assert.equal(key.split(' | ').length - 1, 4)
  assert.equal(key.split('/').length - 1, 1)
  let checked = 0
  for (const f of readdirSync(join(ROOT, 'l10n')).filter((n) => /^bundle\.l10n\..+\.json$/.test(n))) {
    const bundle = JSON.parse(readFileSync(join(ROOT, 'l10n', f), 'utf8')) as Record<string, string>
    // A language whose package has not translated it yet shows the English (its pending list says so).
    if (!(key in bundle)) continue
    checked++
    assert.equal(bundle[key].split(' | ').length - 1, 4, `${f}: ${bundle[key]}`)
    assert.equal(bundle[key].split('/').length - 1, 1, `${f}: ${bundle[key]}`)
  }
  assert.ok(checked >= 1, 'no bundle carries the status text')
  assert.equal(under(GERMAN, () => shippedPromptTitle('status')), 'Zwischenstand als Tabelle')
})
