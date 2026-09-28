// SPDX-FileCopyrightText: 2026 Frederik Marx
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * 1.10 A (spec §3 A1, §0a.1; P3): the prompt list's store on real files in a temp directory — written only by
 * an operation, whole and atomically, read again before every change, never over a file it cannot read — and
 * the host's part of the section: the refused operation's flash. Nothing a reader wrote reaches the log.
 *
 * 1.10 P4 (§3 A3 tests 2–8, §0a.4, §7a's probe): the send path against a fake window, a real terminal watch and
 * fake timers — the target (the active terminal, else a pick of exactly the candidates), the decision before
 * and after *Send anyway*, the two writes (the text, then the Enter alone PROMPT_ENTER_DELAY_MS later), the
 * text read at the send, one flow at a time and the gap, keep-warm yielding first, the terminal shown, the
 * flash, the target line's facts, and the static count of every `sendText` in src/. The host-side leak test
 * through a real activation is in test/extension.test.ts, where the fake host lives.
 */

import { strict as assert } from 'node:assert'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { test } from 'node:test'
import { setBundle, setLocale } from '../src/i18n'
import { KEEP_WARM_LINE } from '../src/keepWarm'
import { cleanPromptsFile, PROMPTS_FILE_MAX_BYTES, PromptsRead, shippedPromptText } from '../src/prompts'
import {
  newPromptId, PROMPT_ENTER_DELAY_MS, PROMPT_FLASH_MS, PROMPT_SEND_MIN_GAP_MS, PromptHostFacts, PromptsHost, PromptsLog, PromptStore,
  PromptsWindow, PromptTimers,
} from '../src/promptsHost'
import { hostUiOf, WindowApi } from '../src/hostUi'
import type { PromptSession } from '../src/promptSend'
import { TerminalWatch, TerminalWindow } from '../src/terminalWatch'
import { scratchDir } from './fixtures/helpers'
import { createFakeVscode, FakeTerminal, FakeVscodeState } from './helpers/fakeVscode'
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
  // A has read its list before B changes it (Review 1b F2): what A holds of the file is the list without B's entry.
  assert.equal(a.store.read().state, 'ok')
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

test('an existing file keeps its bytes and its time through a save that changes nothing, a move at an end and a restore with none missing (Review 1b F2, §3 A1 rule 4)', () => {
  const { file, log, store } = storeIn()
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const bytes = JSON.stringify({ v: 1, prompts: [{ id: 's-status' }, { id: 'u-3k9x0a2b', title: TITLE, text: TEXT }, { id: 's-keepwarm' }, { id: 's-stop' }] })
  fs.writeFileSync(file, bytes)
  fs.utimesSync(file, OLD, OLD)
  const mtime = fs.statSync(file).mtimeMs
  assert.equal(store.read().state, 'ok')
  // The user entry saved with its own words, the shipped one with the shipped words of now, a move at either end, a restore.
  for (const op of [{ op: 'save', id: 'u-3k9x0a2b', title: TITLE, text: TEXT }, { op: 'save', id: 's-stop', title: 'Stop after this task', text: shippedPromptText('stop') },
    { op: 'move', id: 's-status', dir: 'up' }, { op: 'move', id: 's-stop', dir: 'down' }, { op: 'restore' }] as const) {
    assert.equal(store.apply(op).result, 'unchanged', JSON.stringify(op))
  }
  assert.equal(fs.readFileSync(file, 'utf8'), bytes, 'the file was rewritten although nothing changed')
  assert.equal(fs.statSync(file).mtimeMs, mtime, 'the file was touched although nothing changed')
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ['prompts.json'])
  assert.equal(log.lines.some((l) => l.startsWith('info')), false, log.lines.join(' | '))
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
  // 1.10 P4 (pinned and changed): the host takes the window, the watch, keep-warm and the log, and `vmInput`
  // the facts of the target line; its input carries the send's flash (`sent`) and the target beside the store.
  const r = sendRig()
  const { file, host } = r
  let now = r.clock.now
  const vm = (at: number): ReturnType<PromptsHost['vmInput']> => host.vmInput(at, r.facts())
  assert.deepEqual(vm(now), { read: { state: 'absent' }, flash: null, sent: null, target: { state: 'none' } })
  assert.equal(PROMPT_FLASH_MS, 10_000)
  host.apply({ op: 'save', id: null, title: ' ', text: TEXT })
  assert.deepEqual(vm(now).flash, { failure: 'titleEmpty', error: null })
  host.apply({ op: 'save', id: null, title: TITLE, text: '' })
  assert.deepEqual(vm(now).flash, { failure: 'textEmpty', error: null })
  host.apply({ op: 'save', id: null, title: TITLE, text: '!rm -rf .' })
  assert.deepEqual(vm(now + PROMPT_FLASH_MS - 1).flash, { failure: 'textBang', error: null })
  assert.equal(vm(now + PROMPT_FLASH_MS).flash, null, 'the flash outlived PROMPT_FLASH_MS')
  // A done operation clears it; one another window made moot (notFound) and an unchanged one say nothing.
  host.apply({ op: 'save', id: null, title: TITLE, text: '!x' })
  assert.notEqual(vm(now).flash, null)
  host.apply({ op: 'save', id: null, title: TITLE, text: TEXT })
  assert.equal(vm(now).flash, null)
  host.apply({ op: 'delete', id: 'u-zzzzzzzz' })
  host.apply({ op: 'move', id: 's-status', dir: 'up' })
  assert.equal(vm(now).flash, null)
  // Full.
  for (let i = 0; i < 46; i++) host.apply({ op: 'save', id: null, title: `t${i}`, text: 'x' })
  assert.equal((read(file) as { prompts: unknown[] }).prompts.length, 50)
  now += 5
  r.clock.now = now
  host.apply({ op: 'save', id: null, title: TITLE, text: TEXT })
  assert.deepEqual(vm(now).flash, { failure: 'full', error: null })
  // Read-only: the file's state rides with the refusal.
  fs.writeFileSync(file, '[]')
  host.apply({ op: 'delete', id: 's-stop' })
  assert.deepEqual(vm(now), { read: { state: 'unreadable', kind: 'shape' }, flash: { failure: 'readOnly', error: 'shape' }, sent: null, target: { state: 'none' } })
  // Clear Stored Data: nothing held, no flash.
  fs.rmSync(file)
  host.forget()
  assert.deepEqual(vm(now), { read: { state: 'absent' }, flash: null, sent: null, target: { state: 'none' } })
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

// ---------------------------------------------------------------------------
// 1.10 P4: the send path (§3 A3 tests 2–8, §0a.4, §7a's probe)
// ---------------------------------------------------------------------------

const SEC = 1000
const MIN = 60 * SEC
/** 2026-09-26 10:00 UTC — the window starts watching. */
const T0 = Date.UTC(2026, 8, 26, 10, 0, 0)
/** The folder the terminals' `claude` runs in, and its transcripts' directory name. */
const CWD = '/home/u/proj'
const DIR = '-home-u-proj'
const SESSION = '9d0eb37a-0000-4000-8000-000000000001'

/** Fake timers for the Enter: `advance` moves the rig's clock and runs what fell due, in order. */
function fakeTimers(clock: { now: number }): PromptTimers & { advance(ms: number): void; armed(): number } {
  let next = 1
  const queue = new Map<number, { at: number; fn: () => void }>()
  return {
    set: (fn, ms) => { const h = next++; queue.set(h, { at: clock.now + ms, fn }); return h },
    clear: (h) => { queue.delete(h as number) },
    advance(ms: number): void {
      const until = clock.now + ms
      for (;;) {
        const due = [...queue].filter(([, q]) => q.at <= until).sort((a, b) => a[1].at - b[1].at)[0]
        if (due === undefined) break
        queue.delete(due[0])
        clock.now = due[1].at
        due[1].fn()
      }
      clock.now = until
    },
    armed: () => queue.size,
  }
}

/** Lets the flow's awaits run (the host's own timers are the fake ones). */
const settle = (): Promise<void> => new Promise((r) => setImmediate(r))

interface SendRig {
  state: FakeVscodeState
  /** 1.13 P5 (pinned and changed: the window's message and pick members are the door's now — hostUiOf(window)). */
  window: PromptsWindow & TerminalWindow & WindowApi
  watch: TerminalWatch
  host: PromptsHost
  store: PromptStore
  file: string
  log: ReturnType<typeof recorder>
  clock: { now: number }
  timers: ReturnType<typeof fakeTimers>
  /** keep-warm's `yieldTo` calls, each with how many `sendText` calls had been made by then. */
  yields: Array<{ terminal: unknown; sentBefore: number }>
  /** The facts the next decision reads (a function of the call's number, for a change while the modal is open). */
  facts: () => PromptHostFacts
  setFacts(f: (call: number) => PromptHostFacts): void
  /** A terminal running `claude` in the folder, started now (the watch sees the start). */
  claude(o?: { shell?: string | undefined; cwd?: string | null; refuse?: boolean }): FakeTerminal
  codex(): FakeTerminal
  bash(): FakeTerminal
  /** Starts a send flow as the page's message would and lets it run up to its first wait (the pick, the modal, the Enter). */
  send(id: string): Promise<void>
  /** The flows started and not yet awaited. */
  flows: Array<Promise<void>>
}

/** The terminal's own session: begun after its `claude` started, its turn closed, nothing running. */
function idle(over: Partial<PromptSession> = {}): PromptSession {
  return {
    sessionId: SESSION, firstAt: T0 + MIN, lastTs: T0 + 5 * MIN, stop: 'end_turn', replyPending: false, running: false,
    lastUserAt: T0 + 5 * MIN - 10 * SEC, hookWait: false, ...over,
  }
}

function factsWith(sessions: PromptSession[], over: Partial<Omit<PromptHostFacts, 'sessions'>> = {}): PromptHostFacts {
  return { trusted: true, settled: true, sessions: (dir) => (dir === DIR ? sessions : []), ...over }
}

function sendRig(): SendRig {
  const { api, state } = createFakeVscode()
  const window = (api as { window: PromptsWindow & TerminalWindow & WindowApi }).window
  const clock = { now: T0 }
  const watch = new TerminalWatch(window, () => clock.now)
  watch.want('prompts', true, clock.now)
  const { file, log, store } = storeIn()
  const timers = fakeTimers(clock)
  const yields: SendRig['yields'] = []
  const keepWarm = { yieldTo: (terminal: unknown): boolean => { yields.push({ terminal, sentBefore: state.sent.length }); return false } }
  // 1.13 P5 (pinned and changed: the host's questions go through the door over the same fake window, `ui`).
  const host = new PromptsHost({ store, window, ui: hostUiOf(window), watch, keepWarm: keepWarm as never, log, clock: () => clock.now, timers })
  let calls = 0
  let make: (call: number) => PromptHostFacts = () => factsWith([idle()])
  const open = (o: { shell?: string | undefined; commandLine?: string; cwd?: string | null; refuse?: boolean }): FakeTerminal => {
    const t = state.openTerminal({ shell: o.shell, name: 'SYNTHETIC-CONVERSATION-SUMMARY', cwd: o.cwd === undefined ? CWD : o.cwd, refuse: o.refuse })
    if (o.commandLine !== undefined) state.startExecution(t, { commandLine: o.commandLine, confidence: 2, cwd: o.cwd === undefined ? CWD : o.cwd })
    return t
  }
  const r: SendRig = {
    state, window, watch, host, store, file, log, clock, timers, yields,
    facts: () => make(++calls),
    setFacts: (f) => { calls = 0; make = f },
    claude: (o = {}) => open({ shell: 'shell' in o ? o.shell : 'claude', commandLine: 'claude', cwd: o.cwd, refuse: o.refuse }),
    codex: () => open({ shell: 'codex', commandLine: 'codex' }),
    bash: () => open({ shell: 'bash' }),
    flows: [],
    send: async (id) => {
      r.flows.push(host.send(id, r.facts))
      await settle()
      await settle()
    },
  }
  return r
}

/** Runs the send's Enter: the delay passes, every flow started ends. */
async function enter(r: SendRig): Promise<void> {
  r.timers.advance(PROMPT_ENTER_DELAY_MS)
  await Promise.all(r.flows.splice(0))
}

/** The text and Enter typed, as (terminal's place, text, execute). */
function typed(r: SendRig): Array<[number, string, boolean | undefined]> {
  return r.state.sent.map((s) => [r.state.terminals.indexOf(s.terminal) + 1, s.text, s.execute])
}

/** The texts typed, in order (read through a function: an assertion on `state.sent` narrows the property). */
function texts(r: SendRig): string[] {
  return r.state.sent.map((s) => s.text)
}

const STATUS_EN = shippedPromptText('status')

test('the two writes (§7a\'s probe): the text without Enter at once, the Enter alone PROMPT_ENTER_DELAY_MS later — and a second send within the delay is dropped by the gap rule', async () => {
  const r = sendRig()
  const t = r.claude()
  r.state.setActiveTerminal(t)
  r.clock.now = T0 + 10 * MIN
  assert.equal(PROMPT_ENTER_DELAY_MS, 200)
  assert.equal(PROMPT_SEND_MIN_GAP_MS, 1000)
  await r.send('s-status')
  assert.deepEqual(typed(r), [[1, STATUS_EN, false]], 'the text goes first, without Enter')
  assert.equal(r.timers.armed(), 1)
  r.timers.advance(PROMPT_ENTER_DELAY_MS - 1)
  await settle()
  assert.deepEqual(typed(r), [[1, STATUS_EN, false]], 'the Enter came before the delay')
  // Another send while the Enter is still to come: dropped — the gap, and the flow is still open.
  const again = r.host.send('s-stop', r.facts)
  await again
  assert.ok(r.log.lines.includes('info Prompts: a send was dropped (another one is under way)'), r.log.lines.join(' | '))
  r.timers.advance(1)
  await Promise.all(r.flows.splice(0))
  assert.deepEqual(typed(r), [[1, STATUS_EN, false], [1, '', true]], 'the Enter alone, once, after the delay')
  assert.deepEqual(r.state.shown.map((s) => [r.state.terminals.indexOf(s.terminal) + 1, s.preserveFocus]), [[1, true]], 'shown once, the focus kept')
  assert.ok(r.log.lines.includes('info Prompts: sent a prompt to Claude Code in terminal 1 of 1'), r.log.lines.join(' | '))
  assert.deepEqual(r.host.vmInput(r.clock.now, r.facts()).sent, { ok: true, kind: 'claude', index: 1, count: 1 })
})

test('the target: the active terminal when it runs Claude Code or Codex — no question; else a pick of exactly the candidates, named by their place, never by their name; dismissed, nothing (§3 A3 test 2)', async () => {
  const r = sendRig()
  const bash = r.bash()
  const claude = r.claude()
  const codex = r.codex()
  r.clock.now = T0 + 10 * MIN
  // The active terminal runs Claude Code: sent there, no pick.
  r.state.setActiveTerminal(claude)
  await r.send('s-stop')
  await enter(r)
  assert.equal(r.state.quickPicks.length, 0)
  assert.deepEqual(typed(r), [[2, shippedPromptText('stop'), false], [2, '', true]])
  // The active terminal is a bash one: a pick of the two candidates, in their order.
  r.state.sent.length = 0
  r.state.setActiveTerminal(bash)
  r.clock.now += 2 * SEC
  await r.send('s-stop')
  assert.equal(r.state.quickPicks.length, 1)
  const pick = r.state.quickPicks[0]
  assert.deepEqual(pick.items.map((i) => [i.label, i.description, i.detail]), [
    ['Claude Code — terminal 2 of 3', 'ready', undefined],
    ['Codex — terminal 3 of 3', 'sending asks first', 'Token Pace reads nothing of a Codex session\'s state: it cannot tell whether Codex is at work or waiting for an approval.'],
  ])
  // 1.12 D6 (pinned and changed: "to …"): no space before the English ellipsis.
  assert.deepEqual([pick.options.title, pick.options.placeHolder], ['Send “Stop after this task” to…', 'Pick the terminal that runs Claude Code or Codex'])
  // Dismissed: nothing typed, no message.
  assert.deepEqual(r.state.sent, [])
  assert.deepEqual(r.state.messages, [])
  // Picked: the terminal picked.
  r.clock.now += 2 * SEC
  r.state.answers.push((items: Array<{ label: string }>) => items[0])
  await r.send('s-stop')
  await enter(r)
  assert.deepEqual(typed(r), [[2, shippedPromptText('stop'), false], [2, '', true]])
  // One candidate that is not the active terminal: still the pick, with one item (§7a Q5).
  r.state.closeTerminal(codex)
  r.clock.now += 2 * SEC
  await r.send('s-stop')
  assert.deepEqual(r.state.quickPicks[r.state.quickPicks.length - 1].items.map((i) => i.label), ['Claude Code — terminal 2 of 2'])
  assert.equal(r.state.nameReads, 0, 'a terminal\'s name was read')
  assert.equal(r.state.outputReads + r.state.creationReads, 0)
  assert.ok(codex)
})

test('hard, soft, Send anyway: a hard block is the message and the flash, nothing typed; a soft one the modal with its reason and the risk; the decision again after it (§3 A3 test 3)', async () => {
  // Hard: the agent hook reports a permission request.
  const r = sendRig()
  const t = r.claude()
  r.state.setActiveTerminal(t)
  r.clock.now = T0 + 10 * MIN
  r.setFacts(() => factsWith([idle({ hookWait: true })]))
  await r.send('s-status')
  assert.deepEqual(r.state.sent, [])
  assert.deepEqual(r.state.messages.map((m) => [m.kind, m.text]), [['info', 'Token Pace: the prompt was not sent. Claude Code is asking for a permission in a session of that folder. Answer it first.']])
  assert.deepEqual(r.host.vmInput(r.clock.now, r.facts()).sent, { ok: false, block: 'hookWait' })
  assert.ok(r.log.lines.includes('info Prompts: not sent (hookWait)'))
  // Soft: Claude Code at work (an open tool call) — the modal; dismissed, nothing typed.
  r.clock.now += 2 * SEC
  r.state.messages.length = 0
  r.setFacts(() => factsWith([idle({ stop: 'tool_use' })]))
  await r.send('s-status')
  assert.deepEqual(r.state.sent, [])
  const modal = r.state.messages[0]
  assert.equal(modal.kind, 'warning')
  assert.equal(modal.text, 'Send “Status table” anyway?')
  assert.deepEqual(modal.actions, ['Send anyway'])
  assert.deepEqual(modal.options, {
    modal: true,
    detail: 'Claude Code is at work there, or waiting for your answer in a dialog; its transcript cannot tell which.\n\nIf Claude Code is showing a permission dialog or a question there, the text and Enter would answer it. Text typed in that terminal and not sent yet goes with it.',
  })
  assert.ok(r.log.lines.includes('info Prompts: not sent (openTool)'))
  // Send anyway: exactly the text, then the Enter.
  r.clock.now += 2 * SEC
  r.state.answers.push('Send anyway')
  await r.send('s-status')
  await enter(r)
  assert.deepEqual(typed(r), [[1, STATUS_EN, false], [1, '', true]])
  // The facts turned hard while the modal was open: refused as a hard block, nothing typed.
  r.state.sent.length = 0
  r.state.messages.length = 0
  r.clock.now += 2 * SEC
  r.setFacts((call) => factsWith([idle({ stop: 'tool_use', hookWait: call > 2 })]))
  r.state.answers.push('Send anyway')
  await r.send('s-status')
  assert.deepEqual(r.state.sent, [])
  assert.deepEqual(r.state.messages.map((m) => m.kind), ['warning', 'info'])
  assert.match(r.state.messages[1].text, /^Token Pace: the prompt was not sent\. Claude Code is asking for a permission/)
  // The terminal closed while the modal was open: `noTerminal`.
  r.state.messages.length = 0
  r.clock.now += 2 * SEC
  r.setFacts(() => factsWith([idle({ stop: 'tool_use' })]))
  const warn = r.window.showWarningMessage
  r.window.showWarningMessage = ((...a: Parameters<typeof warn>) => { r.state.closeTerminal(t); return warn(...a) }) as typeof warn
  r.state.answers.push('Send anyway')
  await r.send('s-status')
  r.window.showWarningMessage = warn
  assert.deepEqual(r.state.sent, [])
  assert.equal(r.state.messages[1]?.text, 'Token Pace: the prompt was not sent. No terminal of this window runs Claude Code or Codex (VS Code\'s shell integration reports none).')
  assert.deepEqual(r.host.vmInput(r.clock.now, r.facts()).sent, { ok: false, block: 'noTerminal' })
})

test('Codex asks first every time, with its own risk sentence — in English and in German; Restricted Mode and a reading are refused before any terminal is offered (§3 A3 tests 3, A4 rules 1, 2, 4)', async () => {
  const r = sendRig()
  const t = r.codex()
  const c = r.claude()
  r.state.setActiveTerminal(t)
  r.clock.now = T0 + 10 * MIN
  await r.send('s-stop')
  assert.deepEqual(r.state.messages[0]?.options, {
    modal: true,
    detail: 'Token Pace reads nothing of a Codex session\'s state: it cannot tell whether Codex is at work or waiting for an approval.\n\nIf Codex is waiting for an approval there, the text and Enter would answer it. Text typed in that terminal and not sent yet goes with it.',
  })
  const german = JSON.parse(fs.readFileSync(path.join(ROOT, 'l10n', 'bundle.l10n.de.json'), 'utf8')) as Record<string, string>
  setLocale('de')
  setBundle(german)
  try {
    r.state.messages.length = 0
    r.clock.now += 2 * SEC
    await r.send('s-stop')
    const m = r.state.messages[0]
    assert.equal(m?.text, '„Nach dieser Aufgabe stoppen“ trotzdem senden?')
    assert.deepEqual(m?.actions, ['Trotzdem senden'])
    assert.equal(m?.options?.detail, 'Token Pace liest nichts vom Zustand einer Codex-Sitzung: Es kann nicht sagen, ob Codex arbeitet oder auf eine Freigabe wartet.\n\nWartet Codex dort auf eine Freigabe, würden der Text und die Eingabetaste sie beantworten. Was Sie in diesem Terminal getippt und noch nicht gesendet haben, wird mitgesendet.')
    // Claude Code's risk sentence in German.
    r.state.setActiveTerminal(c)
    r.setFacts(() => factsWith([idle({ replyPending: true })]))
    r.state.messages.length = 0
    r.clock.now += 2 * SEC
    await r.send('s-stop')
    assert.equal(r.state.messages[0]?.options?.detail, 'Claude Code arbeitet dort oder wartet in einem Dialog auf Ihre Antwort; das Transkript kann das nicht unterscheiden.\n\nZeigt Claude Code dort einen Berechtigungsdialog oder eine Frage, würden der Text und die Eingabetaste sie beantworten. Was Sie in diesem Terminal getippt und noch nicht gesendet haben, wird mitgesendet.')
    // A hard block in German.
    r.setFacts(() => factsWith([idle()], { settled: false }))
    r.state.messages.length = 0
    r.clock.now += 2 * SEC
    await r.send('s-stop')
    assert.equal(r.state.messages[0]?.text, 'Token Pace: Der Prompt wurde nicht gesendet. Token Pace liest gerade die Transkripte; versuchen Sie es gleich noch einmal.')
  } finally {
    setLocale('en')
    setBundle({})
  }
  // Restricted Mode, a reading under way: the refusal comes before any pick — even with the active terminal a bash one.
  const b = r.bash()
  r.state.setActiveTerminal(b)
  for (const [over, block] of [[{ trusted: false }, 'restricted'], [{ settled: false }, 'reading']] as const) {
    r.setFacts(() => factsWith([idle()], over))
    const picks = r.state.quickPicks.length
    r.clock.now += 2 * SEC
    await r.send('s-stop')
    assert.equal(r.state.quickPicks.length, picks, `${block}: a terminal was offered`)
    assert.ok(r.log.lines.includes(`info Prompts: not sent (${block})`), block)
  }
  // No terminal at all.
  for (const x of [...r.state.terminals]) r.state.closeTerminal(x)
  r.setFacts(() => factsWith([idle()]))
  r.clock.now += 2 * SEC
  await r.send('s-stop')
  assert.equal(r.state.messages[r.state.messages.length - 1]?.text, 'Token Pace: the prompt was not sent. No terminal of this window runs Claude Code or Codex (VS Code\'s shell integration reports none).')
  assert.deepEqual(r.state.sent, [])
})

test('the text typed is the entry\'s as read at the send: a change made while the pick was open, the German shipped words, KEEP_WARM_LINE for the keep-warm entry in every language (§3 A3 test 4)', async () => {
  const r = sendRig()
  const b = r.bash()
  r.claude()
  r.clock.now = T0 + 10 * MIN
  r.state.setActiveTerminal(b)
  assert.equal(r.store.apply({ op: 'save', id: null, title: TITLE, text: TEXT }).result, 'added')
  const id = (cleanPromptsFile(read(r.file)) as { file: { prompts: Array<{ id: string }> } }).file.prompts[3].id
  // While the pick is open the entry is edited (another window, or the page): the new words are typed.
  r.state.answers.push((items: unknown[]) => {
    r.store.apply({ op: 'save', id, title: TITLE, text: `${TEXT} edited` })
    return items[0]
  })
  await r.send(id)
  await enter(r)
  assert.deepEqual(texts(r), [`${TEXT} edited`, ''])
  // Deleted while the pick was open: nothing is typed.
  r.state.sent.length = 0
  r.clock.now += 2 * SEC
  r.state.answers.push((items: unknown[]) => {
    r.store.apply({ op: 'delete', id })
    return items[0]
  })
  await r.send(id)
  assert.deepEqual(r.state.sent, [])
  assert.ok(r.log.lines.includes('info Prompts: not sent (no such prompt)'))
  // An id the list does not hold starts no flow.
  r.clock.now += 2 * SEC
  const picks = r.state.quickPicks.length
  await r.send('u-zzzzzzzz')
  assert.equal(r.state.quickPicks.length, picks)
  // The shipped words in the language of now; the keep-warm line in every language.
  const german = JSON.parse(fs.readFileSync(path.join(ROOT, 'l10n', 'bundle.l10n.de.json'), 'utf8')) as Record<string, string>
  for (const [bundle, locale, status] of [[german, 'de', german[STATUS_EN]], [{ 'Ignore this message. No action. No response.': 'NON' }, 'fr', STATUS_EN]] as const) {
    setLocale(locale)
    setBundle(bundle)
    try {
      for (const [entry, want] of [['s-status', status], ['s-keepwarm', KEEP_WARM_LINE]] as const) {
        r.state.sent.length = 0
        r.clock.now += 2 * SEC
        r.state.answers.push((items: unknown[]) => items[0])
        await r.send(entry)
        await enter(r)
        assert.deepEqual(texts(r), [want, ''], `${locale} ${entry}`)
      }
    } finally {
      setLocale('en')
      setBundle({})
    }
  }
  assert.match(german[STATUS_EN], /^Zeige den aktuellen Zwischenstand/)
})

test('one at a time: two sends 500 ms apart go once, 1200 ms apart twice; a send while the pick is open is dropped (§3 A3 test 5)', async () => {
  const r = sendRig()
  const t = r.claude()
  r.state.setActiveTerminal(t)
  r.clock.now = T0 + 10 * MIN
  await r.send('s-stop')
  await enter(r)
  r.clock.now += 500 - PROMPT_ENTER_DELAY_MS
  await r.send('s-stop')
  await enter(r)
  assert.equal(r.state.sent.length, 2, 'a second send 500 ms after the first went')
  r.clock.now += 1200 - 500 - PROMPT_ENTER_DELAY_MS
  await r.send('s-stop')
  await enter(r)
  assert.equal(r.state.sent.length, 4, 'a send 1200 ms after the first did not go')
  // The pick is open: a second click is dropped, the first goes on.
  const b = r.bash()
  r.state.setActiveTerminal(b)
  r.clock.now += 2 * SEC
  let inner: Promise<void> | null = null
  r.state.answers.push((items: unknown[]) => {
    r.clock.now += 5 * SEC
    inner = r.host.send('s-status', r.facts)
    return items[0]
  })
  await r.send('s-stop')
  await inner
  await enter(r)
  assert.deepEqual(r.state.sent.slice(4).map((s) => s.text), [shippedPromptText('stop'), ''])
  assert.equal(r.log.lines.filter((l) => l === 'info Prompts: a send was dropped (another one is under way)').length, 2)
})

test('keep-warm yields first: yieldTo for the target before any sendText; the terminal shown once per send; the flash; the log names neither the title nor the text (§3 A3 tests 6, 7)', async () => {
  const r = sendRig()
  const b = r.bash()
  const t = r.claude()
  r.state.setActiveTerminal(t)
  r.clock.now = T0 + 10 * MIN
  r.store.apply({ op: 'save', id: null, title: TITLE, text: TEXT })
  const id = (cleanPromptsFile(read(r.file)) as { file: { prompts: Array<{ id: string }> } }).file.prompts[3].id
  await r.send(id)
  await enter(r)
  assert.deepEqual(r.yields.map((y) => [y.terminal === t, y.sentBefore]), [[true, 0]], 'yieldTo came after a sendText, or for another terminal')
  assert.equal(r.state.shown.length, 1)
  assert.deepEqual(r.host.vmInput(r.clock.now, r.facts()).sent, { ok: true, kind: 'claude', index: 2, count: 2 })
  assert.equal(r.host.vmInput(r.clock.now + PROMPT_FLASH_MS, r.facts()).sent, null, 'the flash outlived PROMPT_FLASH_MS')
  // A refused send yields nothing.
  r.setFacts(() => factsWith([idle({ hookWait: true })]))
  r.clock.now += 2 * SEC
  await r.send(id)
  assert.equal(r.yields.length, 1)
  // A saved change gives way to the send's flash and the other way round.
  r.host.apply({ op: 'save', id, title: ' ', text: TEXT })
  const vm = r.host.vmInput(r.clock.now, r.facts())
  assert.deepEqual([vm.flash, vm.sent], [{ failure: 'titleEmpty', error: null }, null])
  for (const line of r.log.lines) for (const secret of [TITLE, TEXT, 'synthetic', CWD, DIR]) assert.equal(line.includes(secret), false, line)
  assert.equal(r.state.nameReads, 0)
  assert.ok(b)
})

test('a terminal that does not take the text: the log names the error\'s name, the flash says so, nothing is shown; a window that goes before the Enter types no Enter', async () => {
  const r = sendRig()
  const t = r.claude({ refuse: true })
  const ok = r.claude()
  r.state.setActiveTerminal(t)
  r.clock.now = T0 + 10 * MIN
  await r.send('s-stop')
  assert.ok(r.log.lines.includes('warn Prompts: not sent (the terminal did not take it: TerminalGone)'), r.log.lines.join(' | '))
  assert.equal(r.log.lines.join('\n').includes('SYNTHETIC'), false, 'the error\'s message reached the log')
  assert.deepEqual(r.host.vmInput(r.clock.now, r.facts()).sent, { ok: false, block: 'failed' })
  assert.equal(r.state.shown.length, 0)
  // The window goes while the Enter is still to come: the text stays unsent, no Enter, no timer left.
  r.state.setActiveTerminal(ok)
  r.clock.now += 2 * SEC
  await r.send('s-stop')
  assert.equal(r.state.sent.length, 1)
  r.host.dispose()
  assert.equal(r.timers.armed(), 0, 'the Enter\'s timer outlived the window')
  await Promise.all(r.flows.splice(0))
  r.timers.advance(PROMPT_ENTER_DELAY_MS)
  await settle()
  assert.deepEqual(r.state.sent.map((s) => s.execute), [false], 'an Enter was typed after the window went')
  assert.equal(r.state.shown.length, 0)
  await r.host.send('s-stop', r.facts)
  assert.equal(r.state.sent.length, 1, 'a disposed host sent')
})

test('the target line\'s facts: Restricted Mode, no terminal, a pick of one or more, the active terminal with its verdict — ready, asks first, not now (§3 A3 rule 6)', () => {
  const r = sendRig()
  const target = (f: PromptHostFacts = factsWith([idle()])): unknown => r.host.vmInput(r.clock.now, f).target
  assert.deepEqual(target(factsWith([idle()], { trusted: false })), { state: 'restricted' })
  assert.deepEqual(target(), { state: 'none' })
  const b = r.bash()
  const t = r.claude()
  r.clock.now = T0 + 10 * MIN
  r.state.setActiveTerminal(b)
  assert.deepEqual(target(), { state: 'pick', candidates: 1 })
  r.codex()
  assert.deepEqual(target(), { state: 'pick', candidates: 2 })
  r.state.setActiveTerminal(t)
  assert.deepEqual(target(), { state: 'active', kind: 'claude', index: 2, count: 3, verdict: { send: true } })
  assert.deepEqual(target(factsWith([idle({ stop: 'tool_use' })])), { state: 'active', kind: 'claude', index: 2, count: 3, verdict: { send: false, block: 'openTool', soft: true } })
  assert.deepEqual(target(factsWith([idle()], { settled: false })), { state: 'active', kind: 'claude', index: 2, count: 3, verdict: { send: false, block: 'reading', soft: false } })
  // A Claude Code started before the watch listened: its shell and the folder VS Code reports — unknownStart.
  const reloaded = r.state.openTerminal({ shell: 'claude', cwd: CWD })
  r.state.setActiveTerminal(reloaded)
  assert.deepEqual(target(), { state: 'active', kind: 'claude', index: 4, count: 4, verdict: { send: false, block: 'unknownStart', soft: true } })
  // Nothing of the watch is looked at while no user wants it.
  r.watch.want('prompts', false, r.clock.now)
  assert.deepEqual(target(), { state: 'none' })
  assert.equal(r.state.nameReads, 0)
})

// 1.10 P5 (§3 A7's smoke test, Review 1b F7): the extension-host smoke test asks the host, through the exported
// API, what a send would do — the codes the send flow reaches before its first question, from the same steps.
test('check: the code a send would reach before its first question — types nothing, asks nothing, shows nothing, logs nothing, sets no flash and leaves the gap rule alone (1.10 P5, §3 A7)', async () => {
  const r = sendRig()
  const check = (id: string, f: PromptHostFacts = factsWith([idle()])): string => r.host.check(id, f)
  assert.equal(check('u-00000000'), 'notFound')
  assert.equal(check('s-status', factsWith([idle()], { trusted: false })), 'restricted')
  assert.equal(check('s-status', factsWith([idle()], { settled: false })), 'reading')
  assert.equal(check('s-status'), 'noTerminal')
  const b = r.bash()
  const t = r.claude()
  r.clock.now = T0 + 10 * MIN
  r.state.setActiveTerminal(b)
  assert.equal(check('s-status'), 'pick')
  r.state.setActiveTerminal(t)
  assert.equal(check('s-status'), 'send')
  assert.equal(check('s-stop', factsWith([idle({ stop: 'tool_use' })])), 'openTool')
  assert.equal(check('s-keepwarm', factsWith([idle({ hookWait: true })])), 'hookWait')
  // Nothing of it reached the reader, the terminal, the log or the page.
  assert.deepEqual(r.state.sent, [])
  assert.deepEqual(r.state.messages, [])
  assert.deepEqual(r.state.quickPicks, [])
  assert.deepEqual(r.state.shown, [])
  assert.deepEqual(r.log.lines, [])
  assert.equal(r.host.vmInput(r.clock.now, r.facts()).sent, null)
  assert.equal(r.state.nameReads, 0)
  // The gap rule is untouched: the reader's own send right after goes.
  await r.send('s-status')
  await enter(r)
  assert.deepEqual(typed(r), [[2, STATUS_EN, false], [2, '', true]])
})

test('static: exactly three `.sendText(` in src/ — the text and the Enter in typePrompt, the keep-warm line in keepWarmHost.ts —; typePrompt called only by the send flow; promptsHost.ts reads no terminal\'s name, output, environment or process (§3 A3 test 8, §0a.4)', () => {
  const code = (file: string): string => fs.readFileSync(path.join(ROOT, 'src', file), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
  const counts: Record<string, number> = {}
  for (const f of fs.readdirSync(path.join(ROOT, 'src'), { recursive: true }) as string[]) {
    if (!f.endsWith('.ts')) continue
    const n = (code(f).match(/\.sendText\(/g) ?? []).length
    if (n > 0) counts[f.replace(/\\/g, '/')] = n
  }
  assert.deepEqual(counts, { 'keepWarmHost.ts': 1, 'promptsHost.ts': 2 })
  const src = code('promptsHost.ts')
  // Both writes are typePrompt's, the text first without Enter, then the Enter alone after the delay.
  const body = src.slice(src.indexOf('async function typePrompt('), src.indexOf('\n}\n', src.indexOf('async function typePrompt(')))
  assert.deepEqual([...body.matchAll(/terminal\.sendText\(([^)]*)\)/g)].map((m) => m[1]), ['text, false', '\'\', true'])
  assert.ok(body.indexOf('await wait(PROMPT_ENTER_DELAY_MS)') > body.indexOf('terminal.sendText(text, false)'))
  // typePrompt is called once, inside `typeInto`, which only `flow` calls, which only `send` calls.
  const calls = [...src.matchAll(/(?<!function )typePrompt\(/g)]
  assert.equal(calls.length, 1)
  const methodAt = (name: string): number => src.indexOf(`  private async ${name}(`)
  assert.ok(calls[0].index! > methodAt('typeInto') && methodAt('typeInto') > methodAt('flow'), 'typePrompt is called outside typeInto')
  assert.equal([...src.matchAll(/this\.typeInto\(/g)].length, 1)
  assert.equal([...src.matchAll(/this\.flow\(/g)].length, 1)
  const send = src.slice(src.indexOf('  async send('), src.indexOf('\n  }\n', src.indexOf('  async send(')))
  assert.ok(send.includes('this.flow('), 'the flow is not the send\'s')
  // Nothing of a terminal but sendText and show; never its name (the one `.name` is an error's).
  assert.deepEqual([...src.matchAll(/([\w)\]]+)\??\.name\b/g)].map((m) => m[1]), ['null)'], 'a `.name` of something else than an error is read')
  // The only `.read(` is the store's (prompts.json) — never an execution's output.
  assert.deepEqual([...new Set([...src.matchAll(/([\w)\]]+)\??\.read\s*\(/g)].map((m) => m[1]))], ['store'])
  assert.equal(/creationOptions|\.env\b|processId|shellIntegration/.test(src), false)
  // No log line names a title, a text or a folder.
  for (const m of src.matchAll(/\blog\.(?:info|debug|warn)\(([^\n]*)\)/g)) assert.doesNotMatch(m[1], /\b(?:title|text|entry|projectDir|cwd)\b/, m[1])
})
