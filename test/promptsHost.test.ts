// SPDX-FileCopyrightText: 2026 Frederik Marx
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * 1.10 A (spec §3 A1, §0a.1; P3): the prompt list's store on real files in a temp directory — written only by
 * an operation, whole and atomically, read again before every change, never over a file it cannot read — and
 * the host's part of the section: the refused operation's flash. Nothing a reader wrote reaches the log.
 *
 * The send path (§3 A3: the target, the Quick Pick, the modal, `sendText`) is P4's and extends this file; the
 * host-side leak test through a real activation is in test/extension.test.ts, where the fake host lives.
 */

import { strict as assert } from 'node:assert'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { test } from 'node:test'
import { cleanPromptsFile, PROMPTS_FILE_MAX_BYTES, PromptsRead } from '../src/prompts'
import { newPromptId, PROMPT_FLASH_MS, PromptsHost, PromptsLog, PromptStore } from '../src/promptsHost'
import { scratchDir } from './fixtures/helpers'
import { ROOT } from './helpers/nls'

/** The synthetic words §0a.1's leak test carries: asserted absent from every log line. */
const TITLE = 'synthetic-prompt-title-123'
const TEXT = 'synthetic-prompt-text-456'

function recorder(): PromptsLog & { lines: string[] } {
  const lines: string[] = []
  return { lines, info: (m) => lines.push(`info ${m}`), debug: (m) => lines.push(`debug ${m}`), warn: (m) => lines.push(`warn ${m}`) }
}

function storeIn(dir = scratchDir('prompts')): { file: string; log: ReturnType<typeof recorder>; store: PromptStore } {
  const file = path.join(dir, 'storage', 'prompts.json')
  const log = recorder()
  return { file, log, store: new PromptStore(file, log) }
}

const read = (file: string): unknown => JSON.parse(fs.readFileSync(file, 'utf8'))
/** The real module object — the bundle's import of `fs` reads its functions from it, so a stand-in set here is seen. */
const nodeFs = require('node:fs') as typeof fs
const OLD = new Date('2026-01-02T03:04:05Z')

test('no file until the first change; reading, however often, writes nothing (§3 A1 rule 2)', () => {
  const { file, store } = storeIn()
  for (let i = 0; i < 3; i++) assert.deepEqual(store.read(), { state: 'absent' })
  assert.equal(fs.existsSync(file), false)
  assert.equal(fs.existsSync(path.dirname(file)), false, 'the storage directory was made by a read')
  // A change that changes nothing writes nothing either — the shipped words of a shipped entry, a move at the top.
  assert.equal(store.apply({ op: 'save', id: 's-stop', title: 'Stop after this task', text: 'Stop after the current task and do not start any new work.' }).result, 'unchanged')
  assert.equal(store.apply({ op: 'move', id: 's-status', dir: 'up' }).result, 'unchanged')
  assert.equal(store.apply({ op: 'restore' }).result, 'unchanged')
  assert.equal(fs.existsSync(file), false)
})

test('the first save writes the three references plus the change, whole, by a rename; the log says what was done, never the words (§0a.1)', () => {
  const { file, log, store } = storeIn()
  const r = store.apply({ op: 'save', id: null, title: TITLE, text: TEXT })
  assert.equal(r.result, 'added')
  const written = read(file) as { v: number; prompts: Array<{ id: string; title?: string; text?: string }> }
  assert.equal(written.v, 1)
  assert.deepEqual(written.prompts.slice(0, 3), [{ id: 's-status' }, { id: 's-keepwarm' }, { id: 's-stop' }])
  assert.equal(written.prompts.length, 4)
  assert.match(written.prompts[3].id, /^u-[a-z0-9]{8}$/)
  assert.deepEqual([written.prompts[3].title, written.prompts[3].text], [TITLE, TEXT])
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ['prompts.json'], 'a temp file was left behind')
  assert.deepEqual(store.read(), { state: 'ok', file: written })
  // Move, delete, restore: each a line of its kind and class.
  const id = written.prompts[3].id
  assert.equal(store.apply({ op: 'move', id, dir: 'up' }).result, 'moved')
  assert.equal(store.apply({ op: 'save', id, title: `${TITLE}!`, text: `${TEXT} again` }).result, 'saved')
  assert.equal(store.apply({ op: 'delete', id: 's-keepwarm' }).result, 'deleted')
  assert.deepEqual(store.apply({ op: 'restore' }), { result: 'restored', restored: 1, problem: null, error: null })
  assert.equal(store.apply({ op: 'save', id, title: '', text: TEXT }).result, 'invalid')
  assert.deepEqual(log.lines, [
    'info Prompts: added a user prompt.',
    'info Prompts: moved a user prompt.',
    'info Prompts: saved a user prompt.',
    'info Prompts: deleted a shipped prompt.',
    'info Prompts: restored 1 shipped prompt(s).',
    'debug Prompts: nothing written (save: invalid, titleEmpty).',
  ])
  // §0a.1's leak test at the store: neither word in any line — a line that named the entry's title would fail here.
  for (const line of log.lines) {
    for (const secret of [TITLE, TEXT, 'synthetic']) assert.equal(line.includes(secret), false, line)
  }
})

test('a rename that throws leaves the old file intact and no temp sibling; the result names the error\'s code (§0a.1 "Write")', () => {
  const { file, log, store } = storeIn()
  store.apply({ op: 'delete', id: 's-stop' })
  const before = fs.readFileSync(file, 'utf8')
  const real = nodeFs.renameSync
  nodeFs.renameSync = () => {
    throw Object.assign(new Error(`EXDEV: cross-device link not permitted, rename '${file}.tmp' -> '${file}'`), { code: 'EXDEV' })
  }
  try {
    const r = store.apply({ op: 'save', id: null, title: TITLE, text: TEXT })
    assert.deepEqual(r, { result: 'notWritten', restored: 0, problem: null, error: 'EXDEV' })
  } finally {
    nodeFs.renameSync = real
  }
  assert.equal(fs.readFileSync(file, 'utf8'), before, 'the old file was changed — written in place instead of renamed?')
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ['prompts.json'], 'the temp file of the failed write was left behind')
  assert.deepEqual(log.lines.slice(-1), ['warn Prompts: prompts.json could not be written (EXDEV).'])
  assert.equal(log.lines.join('\n').includes(file), false, 'the log holds the path of the error\'s message')
  // A directory that cannot be written: the write's own error, the old file kept.
  if (process.platform !== 'win32' && process.getuid?.() !== 0) {
    fs.chmodSync(path.dirname(file), 0o555)
    try {
      assert.deepEqual(store.apply({ op: 'save', id: null, title: TITLE, text: TEXT }), { result: 'notWritten', restored: 0, problem: null, error: 'EACCES' })
    } finally {
      fs.chmodSync(path.dirname(file), 0o755)
    }
    assert.equal(fs.readFileSync(file, 'utf8'), before)
  }
})

test('a change another window made between two operations is kept: every operation reads the file again (§3.0 d, §0a.1)', () => {
  const dir = scratchDir('prompts')
  const a = storeIn(dir)
  const b = storeIn(dir)
  assert.equal(a.store.apply({ op: 'save', id: null, title: 'From A', text: 'a' }).result, 'added')
  // The other window reads A's list (its first read), then adds its own.
  assert.equal(b.store.read().state, 'ok')
  assert.equal(b.store.apply({ op: 'save', id: null, title: 'From B', text: 'b' }).result, 'added')
  // A's next operation starts from the file as it is now, B's entry in it.
  assert.equal(a.store.apply({ op: 'delete', id: 's-status' }).result, 'deleted')
  const titles = (read(a.file) as { prompts: Array<{ title?: string }> }).prompts.map((p) => p.title ?? null)
  assert.deepEqual(titles, [null, null, 'From A', 'From B'])
  // And A's view follows B's next change without an operation of its own (a stat per build).
  assert.equal(b.store.apply({ op: 'move', id: 's-stop', dir: 'down' }).result, 'moved')
  assert.deepEqual(a.store.read(), cleanPromptsFile(read(a.file)))
  assert.deepEqual((read(a.file) as { prompts: Array<{ title?: string }> }).prompts.map((p) => p.title ?? null), [null, 'From A', null, 'From B'])
})

test('the stat cache: a read parses the file again only when its size, time or inode changed', () => {
  const { file, store } = storeIn()
  store.apply({ op: 'delete', id: 's-stop' })
  const real = JSON.parse
  let parses = 0
  JSON.parse = ((...a: Parameters<typeof JSON.parse>) => { parses++; return real(...a) }) as typeof JSON.parse
  try {
    store.read()
    store.read()
    store.read()
    assert.equal(parses, 1, 'an unchanged file was parsed again')
    fs.writeFileSync(file, JSON.stringify({ v: 1, prompts: [{ id: 's-stop' }] }))
    assert.deepEqual(store.read(), { state: 'ok', file: { v: 1, prompts: [{ id: 's-stop' }] } })
    assert.equal(parses, 2)
  } finally {
    JSON.parse = real
  }
})

test('an unreadable or newer file keeps its bytes and its time through every operation; the log says so once per state (§3 A1 rule 5)', () => {
  const kinds: Array<[string, string | Buffer, PromptsRead]> = [
    ['json', '{ "v": 1, "prompts": [ ', { state: 'unreadable', kind: 'json' }],
    ['shape', JSON.stringify({ v: 1, prompts: [{ id: 'u-3k9x0a2b', title: TITLE, text: `${TEXT}\n` }] }), { state: 'unreadable', kind: 'shape' }],
    ['newer', JSON.stringify({ v: 2, prompts: [], sync: true }), { state: 'newer', v: 2 }],
  ]
  for (const [what, bytes, state] of kinds) {
    const { file, log, store } = storeIn()
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, bytes)
    fs.utimesSync(file, OLD, OLD)
    const mtime = fs.statSync(file).mtimeMs
    assert.deepEqual(store.read(), state, what)
    assert.deepEqual(store.read(), state, what)
    for (const op of [{ op: 'save', id: null, title: 't', text: 'x' }, { op: 'save', id: 's-status', title: 't', text: 'x' }, { op: 'delete', id: 's-status' },
      { op: 'move', id: 's-stop', dir: 'up' }, { op: 'restore' }] as const) {
      const r = store.apply(op)
      assert.equal(r.result, 'readOnly', `${what}: ${op.op}`)
      assert.equal(r.error, what, `${what}: the refusal names the file's state`)
    }
    assert.equal(fs.readFileSync(file, 'utf8'), String(bytes), `${what}: the reader's file was changed`)
    assert.equal(fs.statSync(file).mtimeMs, mtime, `${what}: the reader's file was touched`)
    assert.deepEqual(fs.readdirSync(path.dirname(file)), ['prompts.json'])
    const said = log.lines.filter((l) => l.includes('could not be read'))
    assert.deepEqual(said, [`warn Prompts: prompts.json could not be read (${what}); nothing is written.`], what)
    for (const line of log.lines) assert.equal(line.includes(TITLE) || line.includes(TEXT), false, line)
  }
})

test('a file larger than 512 KiB is not even read; a directory in its place is an I/O error; the state is said again after it changed', () => {
  const { file, log, store } = storeIn()
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify({ v: 1, prompts: [] }) + ' '.repeat(PROMPTS_FILE_MAX_BYTES))
  const realRead = nodeFs.readFileSync
  const realParse = JSON.parse
  let reads = 0
  let parses = 0
  nodeFs.readFileSync = ((...a: Parameters<typeof fs.readFileSync>) => { if (a[0] === file) reads++; return realRead(...a) }) as typeof fs.readFileSync
  JSON.parse = ((...a: Parameters<typeof JSON.parse>) => { parses++; return realParse(...a) }) as typeof JSON.parse
  try {
    assert.deepEqual(store.read(), { state: 'unreadable', kind: 'tooLarge' })
    assert.equal(store.apply({ op: 'restore' }).result, 'readOnly')
  } finally {
    nodeFs.readFileSync = realRead
    JSON.parse = realParse
  }
  assert.equal(reads, 0, 'the file was read')
  assert.equal(parses, 0, 'the file was parsed')
  fs.rmSync(file)
  fs.mkdirSync(file)
  assert.deepEqual(store.read(), { state: 'unreadable', kind: 'io' })
  fs.rmdirSync(file)
  assert.deepEqual(store.read(), { state: 'absent' })
  fs.writeFileSync(file, 'nope')
  assert.deepEqual(store.read(), { state: 'unreadable', kind: 'json' })
  assert.deepEqual(log.lines.filter((l) => l.startsWith('warn')), [
    'warn Prompts: prompts.json could not be read (tooLarge); nothing is written.',
    'warn Prompts: prompts.json could not be read (io); nothing is written.',
    'warn Prompts: prompts.json could not be read (json); nothing is written.',
  ])
})

test('Clear Stored Data: after the file is gone and forgotten, the list is the three shipped entries again', () => {
  const { file, store } = storeIn()
  store.apply({ op: 'delete', id: 's-status' })
  assert.equal(store.read().state, 'ok')
  fs.rmSync(file)
  store.forget()
  assert.deepEqual(store.read(), { state: 'absent' })
  assert.equal(store.apply({ op: 'restore' }).result, 'unchanged', 'every default prompt is there already')
})

test('the host\'s flash: a refused operation says why for PROMPT_FLASH_MS; a done one, an unchanged one or one another window made moot says nothing (§3 A3 rule 9)', () => {
  const { file, store } = storeIn()
  let now = 1_000_000
  const host = new PromptsHost({ store, clock: () => now })
  assert.deepEqual(host.vmInput(now), { read: { state: 'absent' }, flash: null })
  assert.equal(PROMPT_FLASH_MS, 10_000)
  host.apply({ op: 'save', id: null, title: ' ', text: TEXT })
  assert.deepEqual(host.vmInput(now).flash, { failure: 'titleEmpty', error: null })
  host.apply({ op: 'save', id: null, title: TITLE, text: '' })
  assert.deepEqual(host.vmInput(now).flash, { failure: 'textEmpty', error: null })
  host.apply({ op: 'save', id: null, title: TITLE, text: '!rm -rf .' })
  assert.deepEqual(host.vmInput(now + PROMPT_FLASH_MS - 1).flash, { failure: 'textBang', error: null })
  assert.equal(host.vmInput(now + PROMPT_FLASH_MS).flash, null, 'the flash outlived PROMPT_FLASH_MS')
  // A done operation clears it; one another window made moot (notFound) and an unchanged one say nothing.
  host.apply({ op: 'save', id: null, title: TITLE, text: '!x' })
  assert.notEqual(host.vmInput(now).flash, null)
  host.apply({ op: 'save', id: null, title: TITLE, text: TEXT })
  assert.equal(host.vmInput(now).flash, null)
  host.apply({ op: 'delete', id: 'u-zzzzzzzz' })
  host.apply({ op: 'move', id: 's-status', dir: 'up' })
  assert.equal(host.vmInput(now).flash, null)
  // Full.
  for (let i = 0; i < 46; i++) host.apply({ op: 'save', id: null, title: `t${i}`, text: 'x' })
  assert.equal((read(file) as { prompts: unknown[] }).prompts.length, 50)
  now += 5
  host.apply({ op: 'save', id: null, title: TITLE, text: TEXT })
  assert.deepEqual(host.vmInput(now).flash, { failure: 'full', error: null })
  // Read-only: the file's state rides with the refusal.
  fs.writeFileSync(file, '[]')
  host.apply({ op: 'delete', id: 's-stop' })
  assert.deepEqual(host.vmInput(now), { read: { state: 'unreadable', kind: 'shape' }, flash: { failure: 'readOnly', error: 'shape' } })
  // Clear Stored Data: nothing held, no flash.
  fs.rmSync(file)
  host.forget()
  assert.deepEqual(host.vmInput(now), { read: { state: 'absent' }, flash: null })
})

test('a new prompt id is u- and eight of [a-z0-9], drawn from the system\'s random source', () => {
  const seen = new Set<string>()
  for (let i = 0; i < 200; i++) {
    const id = newPromptId()
    assert.match(id, /^u-[a-z0-9]{8}$/)
    seen.add(id)
  }
  assert.ok(seen.size > 190, 'the ids repeat')
})

test('static: the store and the host log no title and no text — no log call names either, and nothing else writes the file (§0a.1)', () => {
  const src = fs.readFileSync(path.join(ROOT, 'src', 'promptsHost.ts'), 'utf8')
  const calls = [...src.matchAll(/\blog\.(?:info|debug|warn)\(([^\n]*)\)/g)].map((m) => m[1])
  assert.ok(calls.length >= 5, calls.join('\n'))
  for (const call of calls) assert.doesNotMatch(call, /\b(?:title|text)\b|op\.|file\.prompts/, call)
  // One write of the file, by rename, in the store's apply.
  assert.equal((src.match(/fs\.writeFileSync\(/g) ?? []).length, 1)
  assert.equal((src.match(/fs\.renameSync\(tmp, this\.file\)/g) ?? []).length, 1)
  for (const f of fs.readdirSync(path.join(ROOT, 'src')).filter((n) => n.endsWith('.ts') && n !== 'promptsHost.ts' && n !== 'storage.ts')) {
    const other = fs.readFileSync(path.join(ROOT, 'src', f), 'utf8')
    assert.equal(/paths\.prompts\b[^\n]*(?:writeFileSync|renameSync)|(?:writeFileSync|renameSync)\([^\n]*paths\.prompts/.test(other), false, `${f} writes prompts.json`)
  }
  // The pure module holds no log and no file access.
  const pure = fs.readFileSync(path.join(ROOT, 'src', 'prompts.ts'), 'utf8')
  assert.equal(/from '(?:fs|path|vscode)'|\blog\./.test(pure), false)
})
