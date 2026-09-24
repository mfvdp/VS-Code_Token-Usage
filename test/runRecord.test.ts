// SPDX-FileCopyrightText: 2026 Frederik Marx
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * 1.6 L4 — Claude Code's run record (spec §0a.12, §3 L4): `<session>/workflows/<runId>.json`, read
 * by a streaming key-picker for seven top-level fields and nothing else. The records here are
 * synthetic, in the shape counted on the measuring machine (key names only): one line, the run's
 * content — its script, its logs, its result, a prompt — before the seven figures, with escaped
 * quotes, braces inside strings and nested objects whose keys are named like the seven. None of
 * that content may reach a record, the snapshot, the view model, the page, the markdown or an
 * export; the picker never decodes more than 64 bytes at a time; a file is opened only when its
 * size or time changed; its `status` is the third source of a run's end.
 */

import { strict as assert } from 'node:assert'
import { after, test } from 'node:test'
import * as fs from 'fs'
import * as path from 'path'
import * as nodeVm from 'node:vm'
import { NodeDetails, RESUMED_AFTER_MS, TreeNode } from '../src/agentTree'
import { AGENT_TABLES_REVISION, Aggregator } from '../src/agg'
import { configureRoots } from '../src/discover'
import { agentsCsv, toCsv, toJson } from '../src/exporter'
import { setBundle, setLocale } from '../src/i18n'
import {
  RUN_RECORD_CHUNK_BYTES, RUN_RECORD_KEYS, RUN_RECORD_MAX_BYTES, RUN_RECORD_SCALAR_MAX, RunRecordPicker, cleanRunRecord,
  pickRunRecord, readRunRecord, runRecordEnded,
} from '../src/runRecord'
import {
  agentPollFiles, agentReplayFiles, changedRunRecords, readRunRecords, replayAgents, runRecordFile, runsOfSessions,
  runsWithoutRecordedEnd, scan,
} from '../src/scan'
import { markdownDocument } from '../src/textViews'
import { TimeConfig } from '../src/time'
import { RunRec, RunRecordFields, Snapshot } from '../src/types'
import { ViewModel, agentTreeFor, buildViewModel, defaultUiState } from '../src/viewModel'
import { CLAUDE_SLUG, claudeLine, journalLine, runRecordJson, tmpDir } from './fixtures/helpers'
import { NOW, makeConfig, makeInput } from './fixtures/viewFixtures'
import { ROOT } from './helpers/nls'

/** Roots are module state; the next test file must not inherit a scratch directory. */
after(() => { configureRoots() })

const MIN = 60_000
const utc: TimeConfig = { zone: 'utc', dayBoundaryHour: 0, startOfWeek: 'monday', hourCycle: 'h23' }

const SESSION = '7ec0de00-1a2b-4c3d-8e4f-000000000013'
/** A run id in Claude Code's shape: `wf_`, 8 hex, `-`, 3 hex. */
const RUN = 'wf_7ec0de13-a1b'
const RUN_KEY = `w:${SESSION}|${RUN}`
const A1 = 'a1c2e3a4b5c6d7e8f'

/** The seven fields `runRecordJson` writes by default. */
const SEVEN: RunRecordFields = {
  status: 'completed',
  startTime: Date.UTC(2026, 8, 3, 11, 0, 0),
  durationMs: 1_265_000,
  agentCount: 3,
  totalTokens: 48_210,
  totalToolCalls: 17,
  defaultModel: 'claude-fable-5-1[1m]',
}

function bytes(text: string): Buffer {
  return Buffer.from(text, 'utf8')
}

/** 11:55 and the like: the stamp of a time of NOW's day. */
function clock(ms: number): string {
  return new Date(ms).toISOString().slice(11, 16)
}

// ---------------------------------------------------------------------------
// A Claude home with one session, one run and its record
// ---------------------------------------------------------------------------

interface Home {
  home: string
  main: string
  journal: string
  agent: string
  record: string
}

/**
 * A session whose run has one agent — its last line 50 minutes before NOW, its journal started it
 * and recorded no end, so the members alone make the run unknown — and, unless `record` is null,
 * the run's record beside the session's `subagents/` directory. Configured as the only root.
 */
function recordHome(prefix: string, record: string | null = runRecordJson({ runId: RUN })): Home {
  const home = tmpDir(prefix)
  configureRoots([home], [path.join(home, 'codex')])
  const slug = path.join(home, 'projects', CLAUDE_SLUG)
  const runDir = path.join(slug, SESSION, 'subagents', 'workflows', RUN)
  fs.mkdirSync(runDir, { recursive: true })
  const h: Home = {
    home,
    main: path.join(slug, `${SESSION}.jsonl`),
    journal: path.join(runDir, 'journal.jsonl'),
    agent: path.join(runDir, `agent-${A1.slice(1)}.jsonl`),
    record: path.join(slug, SESSION, 'workflows', `${RUN}.json`),
  }
  const lines = (file: string, ls: string[]): void => fs.writeFileSync(file, ls.map((l) => `${l}\n`).join(''))
  lines(h.main, [claudeLine({ id: 'm0', ts: NOW - 60 * MIN, sessionId: SESSION, usage: { input: 10 }, final: true })])
  lines(h.agent, [claudeLine({ id: 'w1', ts: NOW - 50 * MIN, agentId: A1.slice(1), usage: { input: 5, output: 2 }, final: true })])
  lines(h.journal, [journalLine({ type: 'started', agentId: A1.slice(1) })])
  if (record !== null) writeRecord(h, record)
  return h
}

function writeRecord(h: Home, text: string): void {
  fs.mkdirSync(path.dirname(h.record), { recursive: true })
  fs.writeFileSync(h.record, text)
}

function runOfAgg(agg: Aggregator): RunRec {
  const run = agg.runs().find((r) => r.workflowId === RUN)
  assert.ok(run, 'no run')
  return run
}

function nodes(roots: readonly TreeNode[]): TreeNode[] {
  return roots.flatMap((n) => [n, ...nodes(n.children)])
}

/** The run's node and its details, at `now`, from the markdown's tree (every node open). */
function runNode(agg: Aggregator, now = NOW): { node: TreeNode; details: NodeDetails } {
  const cfg = makeConfig()
  const vm = agentTreeFor({ agg, cfg, ui: { ...defaultUiState(cfg), agentSelected: RUN_KEY }, now }, 'text')
  const node = nodes(vm.roots).find((n) => n.key === RUN_KEY)
  assert.ok(node, `no run node in ${nodes(vm.roots).map((n) => n.key).join(', ')}`)
  assert.ok(vm.selected, 'no details for the run')
  return { node, details: vm.selected }
}

function rowOf(d: NodeDetails, label: string): NodeDetails['rows'][number] | undefined {
  return d.rows.find((r) => r.label === label)
}

/** Counts the calls of an `fs.promises` function for one file while `run` runs. */
async function callsDuring<T>(name: 'open' | 'lstat', file: string, run: () => Promise<T>): Promise<{ result: T; calls: number }> {
  const promises = fs.promises as unknown as Record<string, (...a: unknown[]) => unknown>
  const original = promises[name]
  let calls = 0
  promises[name] = function (this: unknown, ...a: unknown[]): unknown {
    if (String(a[0]) === file) calls++
    return original.apply(this, a)
  }
  try {
    return { result: await run(), calls }
  } finally {
    promises[name] = original
  }
}

// ---------------------------------------------------------------------------
// The picker
// ---------------------------------------------------------------------------

test('the picker takes the seven top-level fields and nothing else — not the nested keys of the same names, not a string that spells them', () => {
  const text = runRecordJson({ runId: RUN, pad: 2000 })
  // The fixture is what it claims: nested objects and strings spell every one of the seven.
  for (const s of ['"phases":[{', '"workflowProgress":{"status":"failed"', '\\"totalTokens\\":1', '"result":{"text"']) {
    assert.ok(text.includes(s), `the fixture lost ${s}`)
  }
  assert.deepEqual(pickRunRecord(bytes(text)), SEVEN)
  assert.deepEqual([...RUN_RECORD_KEYS], ['status', 'startTime', 'durationMs', 'agentCount', 'totalTokens', 'totalToolCalls', 'defaultModel'])
  // A chunk boundary anywhere changes nothing: one byte at a time, and odd sizes.
  for (const size of [1, 2, 7, 63, 64, 65, 4096]) {
    const picker = new RunRecordPicker()
    const b = bytes(text)
    for (let at = 0; at < b.length; at += size) picker.push(b.subarray(at, at + size))
    assert.deepEqual(picker.result(), SEVEN, `chunks of ${size}`)
  }
  // A record that states only some of the seven: the rest are none.
  assert.deepEqual(pickRunRecord(bytes(runRecordJson({ status: 'running', durationMs: null, totalTokens: null, defaultModel: null }))),
    { ...SEVEN, status: 'running', durationMs: null, totalTokens: null, defaultModel: null })
  // None of the seven: no record at all.
  assert.equal(pickRunRecord(bytes('{"script":"x","logs":["y"]}')), null)
  assert.equal(pickRunRecord(bytes('{}')), null)
})

test('every value is taken as JSON.parse reads it — the last of a key given twice, escapes decoded — and through its allow-list', () => {
  const texts = [
    '{"status":"running","agentCount":1,"status":"completed"}',
    '{"agentCount":3,"totalTokens":5,"agentCount":"3"}',
    '{"agentCount":3,"agentCount":{"n":4}}',
    '{"st\\u0061tus":"killed","defaultModel":"claude-\\u006fpus-5"}',
    '{"status":"paused","agentCount":-1,"totalTokens":-5,"totalToolCalls":2.5,"startTime":0,"durationMs":-1}',
    '{"defaultModel":"has space","durationMs":{"ms":5},"totalTokens":[1],"agentCount":true,"status":null}',
    '{"status":"cancelled","startTime":1.7e12,"durationMs":0,"agentCount":0,"totalTokens":0,"totalToolCalls":0,"defaultModel":"m"}',
    '{ "status" : "failed" ,\n\t"totalToolCalls" : 12 , "x" : [ 1 , { "status" : "completed" } ] , "defaultModel":"a/b:c@d-e.f[1m]" }',
    '{"defaultModel":"model[TOOLONGSUFFIX]","status":"stopped"}',
  ]
  for (const text of texts) {
    assert.deepEqual(pickRunRecord(bytes(text)), cleanRunRecord(JSON.parse(text)), text)
  }
  // Spot checks of what the oracle says.
  assert.equal(pickRunRecord(bytes(texts[0]))?.status, 'completed')
  assert.equal(pickRunRecord(bytes(texts[1]))?.agentCount, null, 'the last one given, though the first was a count')
  assert.deepEqual([pickRunRecord(bytes(texts[3]))?.status, pickRunRecord(bytes(texts[3]))?.defaultModel], ['killed', 'claude-opus-5'])
  assert.equal(pickRunRecord(bytes(texts[4])), null, 'nothing of the wrong shape is kept')
  assert.equal(pickRunRecord(bytes(texts[7]))?.status, 'failed', 'the nested status is not the run\'s')
  assert.equal(runRecordEnded(pickRunRecord(bytes(texts[0]))), true)
  assert.equal(runRecordEnded(pickRunRecord(bytes('{"status":"running"}'))), false)
  assert.equal(runRecordEnded(null), false)
})

test('a key or a value longer than 64 bytes is never decoded, and a file that ends before its object closes is no record', () => {
  assert.equal(RUN_RECORD_SCALAR_MAX, 64)
  // A model id of 64 bytes is taken, one of 65 is not; a number spelt in 65 digits is none, though
  // JSON.parse would read it.
  const model64 = 'm'.repeat(60) + '[1m]'
  const model65 = 'm'.repeat(61) + '[1m]'
  assert.equal(pickRunRecord(bytes(`{"defaultModel":"${model64}","status":"completed"}`))?.defaultModel, model64)
  assert.equal(pickRunRecord(bytes(`{"defaultModel":"${model65}","status":"completed"}`))?.defaultModel, null)
  const digits65 = '1' + '0'.repeat(64)
  assert.equal(pickRunRecord(bytes(`{"totalTokens":${digits65},"status":"completed"}`))?.totalTokens, null)
  // A key of 65 bytes is skipped with its value — whatever it would have spelt.
  assert.equal(pickRunRecord(bytes(`{"${'k'.repeat(65)}":"completed","agentCount":2}`))?.agentCount, 2)
  // Truncated anywhere — even right before the last brace — it is no record: one being written is
  // read again at its next change.
  const text = runRecordJson({ runId: RUN })
  for (const cut of [1, 100, Math.floor(text.length / 2), text.length - 2, text.length - 1]) {
    assert.equal(pickRunRecord(bytes(text.slice(0, cut))), null, `cut at ${cut}`)
  }
  assert.deepEqual(pickRunRecord(bytes(text + '\n')), SEVEN)
  // Nothing but an object is a record.
  for (const other of ['', '[]', '"completed"', '12', 'null', '﻿{"status":"completed"}', '{"status":"completed",}',
    '{"status" "completed"}', '{status:"completed"}', '{"status":"completed"]']) {
    assert.equal(pickRunRecord(bytes(other)), null, JSON.stringify(other))
  }
})

/** Every decode and every parse while `run` runs: the byte ranges a Buffer was decoded over, the texts parsed. */
function decodedDuring(run: () => void): { ranges: number[]; parsed: string[]; strings: number } {
  const proto = Buffer.prototype as unknown as Record<string, (...a: unknown[]) => unknown>
  const names = ['toString', 'utf8Slice', 'latin1Slice', 'asciiSlice', 'ucs2Slice', 'base64Slice', 'base64urlSlice', 'hexSlice', 'toJSON']
  const originals = new Map(names.filter((n) => typeof proto[n] === 'function').map((n) => [n, proto[n]]))
  const ranges: number[] = []
  const parsed: string[] = []
  let strings = 0
  for (const [name, original] of originals) {
    proto[name] = function (this: Buffer, ...a: unknown[]): unknown {
      if (name === 'toString') strings++
      const numbers = a.filter((x): x is number => typeof x === 'number')
      const start = numbers[0] ?? 0
      const end = numbers[1] ?? this.length
      ranges.push(name === 'toJSON' ? this.length : Math.max(0, Math.min(end, this.length) - start))
      return original.apply(this, a)
    }
  }
  const parse = JSON.parse
  JSON.parse = function (text: string, reviver?: (this: unknown, key: string, value: unknown) => unknown): unknown {
    parsed.push(String(text))
    return parse.call(JSON, text, reviver)
  } as typeof JSON.parse
  const textDecoder = (globalThis as unknown as { TextDecoder: { prototype: Record<string, (...a: unknown[]) => unknown> } }).TextDecoder.prototype
  const decoder = textDecoder.decode
  textDecoder.decode = function (this: unknown, ...a: unknown[]): unknown {
    const input = a[0] as { byteLength?: number } | undefined
    ranges.push(input?.byteLength ?? 0)
    return decoder.apply(this, a)
  }
  try {
    run()
  } finally {
    for (const [name, original] of originals) proto[name] = original
    JSON.parse = parse
    textDecoder.decode = decoder
  }
  return { ranges, parsed, strings }
}

/**
 * The §0a.12 fixture: 2.5 MB, the seven fields after more than 1 MB of script and logs, and after
 * them another megabyte — a conversation with prompts and results, an account id — and a key given
 * twice (the first `agentCount` 99, the last 3).
 */
function leakRecord(secret: string): string {
  const base = runRecordJson({
    runId: RUN, secret, pad: 1_100_000, agentCount: 99,
    extra: {
      accountUuid: `${secret}-ACCOUNT-5f3e2d1c-0b9a-4c8d-9e7f-6a5b4c3d2e1f`,
      emailAddress: `${secret.toLowerCase()}@example.invalid`,
      conversation: Array.from({ length: 8000 }, (_, n) => ({
        role: n % 2 === 0 ? 'user' : 'assistant',
        content: n % 2 === 0 ? `${secret} prompt ${n}: "{\\"status\\":\\"killed\\"}"` : `${secret} result ${n} {"totalTokens": ${n}}`,
        status: 'failed', totalTokens: n, defaultModel: `${secret}-nested-model`,
      })),
    },
  })
  return `${base.slice(0, -1)},"agentCount":3}`
}

test('§0a.12 leak test: a 2.5 MB record — the picker returns exactly the seven, and decodes nothing longer than 64 bytes', () => {
  const secret = 'RUNRECORD-LEAK-4c7e'
  const text = leakRecord(secret)
  const b = bytes(text)
  assert.ok(b.length >= 2_500_000 && b.length < RUN_RECORD_MAX_BYTES, `the fixture is ${b.length} bytes`)
  const firstOfSeven = Math.min(...RUN_RECORD_KEYS.map((k) => text.indexOf(`"${k}":`, text.indexOf('"error":null'))))
  assert.ok(firstOfSeven > 1_000_000, `the seven start at byte ${firstOfSeven}`)
  assert.ok(text.lastIndexOf('"agentCount":99') > 0 && text.endsWith(',"agentCount":3}'), 'the fixture lost its duplicate key')
  let got: RunRecordFields | null = null
  const { ranges, parsed, strings } = decodedDuring(() => { got = pickRunRecord(b) })
  assert.deepEqual(got, SEVEN)
  // No decode of the file's bytes beyond one key or one value at a time, and only of top-level ones:
  // its 24 keys, the seven values and the one given twice.
  assert.ok(ranges.length > 0, 'the spy saw nothing')
  assert.ok(Math.max(...ranges) <= RUN_RECORD_SCALAR_MAX, `a decode of ${Math.max(...ranges)} bytes`)
  assert.equal(strings, 24 + 8, 'a decode of anything but a top-level key or one of the seven values')
  assert.ok(parsed.every((p) => p.length <= RUN_RECORD_SCALAR_MAX + 2), `a parse of ${Math.max(...parsed.map((p) => p.length))} characters`)
  for (const p of parsed) assert.equal(p.includes(secret), false, `the picker decoded ${p}`)
  // The chunk the file is read in.
  assert.equal(RUN_RECORD_CHUNK_BYTES, 64 * 1024)
})

// ---------------------------------------------------------------------------
// The file
// ---------------------------------------------------------------------------

test('a record larger than 4 MB is absent, one of exactly 4 MB is read, and only a regular file is taken', async () => {
  assert.equal(RUN_RECORD_MAX_BYTES, 4 * 1024 * 1024)
  const dir = tmpDir('runrecord-file')
  const exact = path.join(dir, 'exact.json')
  const over = path.join(dir, 'over.json')
  const base = runRecordJson({ runId: RUN, pad: 100_000 })
  const fill = (size: number): string => `${base.slice(0, -1)}${' '.repeat(size - Buffer.byteLength(base))}}`
  fs.writeFileSync(exact, fill(RUN_RECORD_MAX_BYTES))
  fs.writeFileSync(over, fill(RUN_RECORD_MAX_BYTES + 1))
  assert.equal(fs.statSync(exact).size, RUN_RECORD_MAX_BYTES)
  const read = await readRunRecord(exact)
  assert.ok(read && read !== 'unchanged')
  assert.deepEqual(read.fields, SEVEN)
  assert.deepEqual(read.stat, { size: RUN_RECORD_MAX_BYTES, mtimeMs: fs.statSync(exact).mtimeMs })
  // One byte more: never opened, its fields none — and its size and time kept, so it is not asked again.
  const big = await callsDuring('open', over, () => readRunRecord(over))
  assert.equal(big.calls, 0)
  assert.deepEqual(big.result, { fields: null, stat: { size: RUN_RECORD_MAX_BYTES + 1, mtimeMs: fs.statSync(over).mtimeMs } })
  // No file, a directory, a link: nothing.
  assert.equal(await readRunRecord(path.join(dir, 'none.json')), null)
  fs.mkdirSync(path.join(dir, 'dir.json'))
  assert.equal(await readRunRecord(path.join(dir, 'dir.json')), null)
  if (process.platform !== 'win32') {
    fs.symlinkSync(exact, path.join(dir, 'link.json'))
    assert.equal(await readRunRecord(path.join(dir, 'link.json')), null)
  }
  // Unchanged against what the last read kept: not opened at all.
  const again = await callsDuring('open', exact, () => readRunRecord(exact, read.stat))
  assert.deepEqual([again.result, again.calls], ['unchanged', 0])
  // A different size or time is read again.
  const moved = await callsDuring('open', exact, () => readRunRecord(exact, { ...read.stat, mtimeMs: read.stat.mtimeMs - 1 }))
  assert.equal(moved.calls, 1)
})

test('where a run\'s record is: beside its session\'s subagents directory, named by the run\'s id, below a Claude root', () => {
  const h = recordHome('runrecord-where')
  const run = (over: Partial<RunRec>): RunRec => ({
    source: 'claude', sessionId: SESSION, workflowId: RUN, journalFile: h.journal, agents: [], agentsDropped: 0, steps: 0,
    lastTs: NOW, record: null, recordStat: null, ...over,
  })
  assert.equal(runRecordFile(run({})), h.record)
  // The run's directory name must be a run id — no separator, no `..` — and the journal where
  // Claude Code puts it.
  for (const workflowId of ['run-1', 'wf_', 'wf_a/b', 'wf_..', `wf_${'x'.repeat(62)}`]) {
    assert.equal(runRecordFile(run({ workflowId })), null, workflowId)
  }
  const other = path.join(path.dirname(path.dirname(h.journal)), 'wf_0ther000-abc', 'journal.jsonl')
  assert.equal(runRecordFile(run({ journalFile: other })), null, 'a journal of another run')
  assert.equal(runRecordFile(run({ journalFile: null })), null)
  assert.equal(runRecordFile(run({ journalFile: path.join(path.dirname(h.journal), 'agent-x.jsonl') })), null)
  const dotted = h.journal.replace(`${path.sep}${RUN}${path.sep}`, `${path.sep}x${path.sep}..${path.sep}${RUN}${path.sep}`)
  assert.notEqual(dotted, h.journal)
  assert.equal(runRecordFile(run({ journalFile: dotted })), null, 'a path that is not the one the scanner writes')
  const outside = path.join(tmpDir('runrecord-outside'), SESSION, 'subagents', 'workflows', RUN, 'journal.jsonl')
  assert.equal(runRecordFile(run({ journalFile: outside })), null, 'below no configured root')
})

// ---------------------------------------------------------------------------
// Through the scanner
// ---------------------------------------------------------------------------

test('a scan reads the record of every run that has not stated an end, and a record is opened only when its size or time changed', async () => {
  const h = recordHome('runrecord-scan', runRecordJson({ runId: RUN, status: 'running' }))
  const agg = new Aggregator()
  const first = await callsDuring('open', h.record, () => scan(agg))
  assert.equal(first.calls, 1)
  assert.deepEqual(runOfAgg(agg).record, { ...SEVEN, status: 'running' })
  assert.deepEqual(runOfAgg(agg).recordStat, { size: fs.statSync(h.record).size, mtimeMs: fs.statSync(h.record).mtimeMs })
  // The sweep's scan of every file: one lstat, no open, while nothing changed.
  const sweep = await callsDuring('open', h.record, () => scan(agg))
  assert.deepEqual([sweep.calls, sweep.result], [0, 0])
  // Rewritten with its end: read again.
  writeRecord(h, runRecordJson({ runId: RUN, status: 'completed', totalTokens: 50_000 }))
  const later = new Date(NOW + 5000)
  fs.utimesSync(h.record, later, later)
  const ended = await callsDuring('open', h.record, () => scan(agg))
  assert.deepEqual([ended.calls, ended.result], [1, 1])
  assert.deepEqual(runOfAgg(agg).record, { ...SEVEN, totalTokens: 50_000 })
  // A record that states its run's end is not even asked about by the sweep.
  assert.deepEqual(runsWithoutRecordedEnd(agg), [])
  const done = await callsDuring('lstat', h.record, () => scan(agg))
  assert.equal(done.calls, 0)
})

test('the poll hands on the record of an active session\'s run that changed, and the ingest reads it for its run', async () => {
  const h = recordHome('runrecord-poll', null)
  // The session is active: its transcript changed a minute ago.
  fs.appendFileSync(h.main, `${claudeLine({ id: 'm1', ts: NOW - MIN, sessionId: SESSION, usage: { input: 3 }, final: true })}\n`)
  const agg = new Aggregator()
  await scan(agg)
  assert.equal(runOfAgg(agg).record, null)
  assert.deepEqual(runsOfSessions(agg, [h.main]).map((r) => r.workflowId), [RUN])
  // No record yet: nothing to hand on.
  let found = await agentPollFiles(agg, NOW)
  assert.deepEqual(found.records, [])
  // The record appears: the pass names it, and reads nothing itself.
  writeRecord(h, runRecordJson({ runId: RUN, status: 'running' }))
  const polled = await callsDuring('open', h.record, () => agentPollFiles(agg, NOW))
  assert.deepEqual([polled.result.records, polled.calls], [[h.record], 0])
  // The ingest of that file reads it with the picker — no cursor, no line counted.
  assert.equal(await scan(agg, { files: [h.record] }), 1)
  assert.deepEqual(runOfAgg(agg).record, { ...SEVEN, status: 'running' })
  assert.equal(agg.cursors.has(h.record), false, 'a run record is no transcript')
  found = await agentPollFiles(agg, NOW)
  assert.deepEqual(found.records, [])
  // It goes away: named once more, and the run keeps no record.
  fs.rmSync(h.record)
  assert.deepEqual(await changedRunRecords(agg.runs()), [h.record])
  assert.equal(await scan(agg, { files: [h.record] }), 1)
  assert.deepEqual([runOfAgg(agg).record, runOfAgg(agg).recordStat], [null, null])
  assert.deepEqual(await changedRunRecords(agg.runs()), [])
  // A file of that name no run owns is neither read nor tailed.
  const stray = path.join(path.dirname(h.record), 'wf_57a9e000-abc.json')
  fs.writeFileSync(stray, runRecordJson({ runId: 'wf_57a9e000-abc' }))
  assert.equal(await scan(agg, { files: [stray] }), 0)
  assert.equal(agg.cursors.has(stray), false)
  // An idle session's runs are not the poll's.
  assert.deepEqual(runsOfSessions(agg, []), [])
})

test('the replay reads every run\'s record once; a snapshot of revision 7 asks for it, and the record survives a round trip, checked again', async () => {
  assert.equal(AGENT_TABLES_REVISION, 8)
  const h = recordHome('runrecord-replay')
  const live = new Aggregator()
  await scan(live)
  assert.deepEqual(runOfAgg(live).record, SEVEN)
  // A snapshot written before the run records (revision 7) has none, and asks for the replay.
  const before = JSON.parse(JSON.stringify(live.toSnapshot())) as Snapshot
  for (const run of Object.values(before.runs ?? {})) {
    delete (run as Partial<RunRec>).record
    delete (run as Partial<RunRec>).recordStat
  }
  before.agentsRevision = 7
  const restored = Aggregator.fromSnapshot(before)
  assert.deepEqual([runOfAgg(restored).record, runOfAgg(restored).recordStat], [null, null])
  assert.notEqual(restored.agentsRevision, AGENT_TABLES_REVISION, 'the host replays')
  const replayed = await callsDuring('open', h.record, () => replayAgents(restored, agentReplayFiles(restored, NOW)))
  assert.equal(replayed.calls, 1)
  assert.deepEqual(runOfAgg(restored).record, SEVEN)
  // Once: a second replay finds the record as it left it.
  const twice = await callsDuring('open', h.record, () => replayAgents(restored, agentReplayFiles(restored, NOW)))
  assert.equal(twice.calls, 0)
  assert.equal(JSON.stringify(restored.toSnapshot().runs), JSON.stringify(live.toSnapshot().runs))
  // A round trip keeps it; a hand-edited one keeps only what the reader would have taken.
  const back = Aggregator.fromSnapshot(JSON.parse(JSON.stringify(live.toSnapshot())) as Snapshot)
  assert.deepEqual([runOfAgg(back).record, runOfAgg(back).recordStat], [runOfAgg(live).record, runOfAgg(live).recordStat])
  const edited = JSON.parse(JSON.stringify(live.toSnapshot())) as Snapshot
  const run = Object.values(edited.runs ?? {})[0] as unknown as Record<string, unknown>
  run.record = { status: 'paused', startTime: 'soon', durationMs: -1, agentCount: 2.5, totalTokens: 7, totalToolCalls: 4, defaultModel: 'a b', script: 'x' }
  run.recordStat = { size: -1, mtimeMs: 5 }
  const cleaned = runOfAgg(Aggregator.fromSnapshot(edited))
  assert.deepEqual(cleaned.record, { status: null, startTime: null, durationMs: null, agentCount: null, totalTokens: 7, totalToolCalls: 4, defaultModel: null })
  assert.equal(cleaned.recordStat, null)
  // Handed over by a caller, the fields are checked again as well.
  const agg = new Aggregator()
  await scan(agg)
  assert.equal(agg.setRunRecord(SESSION, RUN, { fields: { ...SEVEN, status: 'exploded', script: 'x' }, stat: { size: 1, mtimeMs: 2 } }), true)
  assert.deepEqual(runOfAgg(agg).record, { ...SEVEN, status: null })
  assert.equal('script' in (runOfAgg(agg).record as object), false)
  assert.equal(agg.setRunRecord(SESSION, 'wf_n0thing0-abc', { fields: SEVEN, stat: { size: 1, mtimeMs: 2 } }), false, 'no such run')
  // The roll-up drops the record with its run — a run is kept for seven days after its journal
  // last changed, and this one's changed as the test wrote it.
  agg.rollup(Date.now() + 9 * 86_400_000, 45, 400, utc)
  assert.deepEqual(agg.runs(), [])
})

// ---------------------------------------------------------------------------
// The tree
// ---------------------------------------------------------------------------

test('the record reaches the run\'s details as Claude Code\'s own figures — all seven, a dash for each it lacks, a dash without one', async () => {
  const h = recordHome('runrecord-row')
  const agg = new Aggregator()
  await scan(agg)
  const { details } = runNode(agg)
  // After the Launches and before the ID, as the details of a run end.
  const labels = details.rows.map((r) => r.label)
  assert.equal(labels.indexOf("Claude Code's run record"), labels.indexOf('ID') - 1)
  assert.deepEqual(rowOf(details, "Claude Code's run record"), {
    label: "Claude Code's run record",
    value: 'completed · started 11:00 · 3 agents · 48.2K tokens · 17 tool calls · 21 min 05 s · default model claude-fable-5-1[1m]',
    note: "Claude Code's own figures, never added to a total",
    kind: 'sentence',
  })
  // Never added: the run's own usage is its agent's, and the record's figure is nowhere else.
  assert.equal(rowOf(details, 'Usage')?.value, '7')
  // Part of it: a dash for each part it does not state.
  agg.setRunRecord(SESSION, RUN, { fields: { ...SEVEN, startTime: null, agentCount: null, defaultModel: null }, stat: { size: 1, mtimeMs: 1 } })
  assert.equal(rowOf(runNode(agg).details, "Claude Code's run record")?.value,
    'completed · started – · – agents · 48.2K tokens · 17 tool calls · 21 min 05 s · default model –')
  // None: a dash — no file, one too large, one cut off.
  for (const text of [null, `${runRecordJson({ runId: RUN }).slice(0, -1)}${' '.repeat(RUN_RECORD_MAX_BYTES)}}`, runRecordJson({ runId: RUN }).slice(0, -1)]) {
    // Each differs in size from the one before, so each is read.
    if (text === null) fs.rmSync(h.record)
    else writeRecord(h, text)
    await readRunRecords(agg, agg.runs())
    assert.equal(runOfAgg(agg).record, null)
    assert.deepEqual(rowOf(runNode(agg).details, "Claude Code's run record"), { label: "Claude Code's run record", value: '–' })
  }
  // A run no journal made — nothing but its members' records — has no record to read: a dash too.
})

/** A run of one open member, its last line at `last`, and a record of `status` that ended at `end` (null: no time). */
function recordRun(status: string, last: number, end: number | null = NOW - 40 * MIN): Aggregator {
  const agg = new Aggregator()
  const dir = path.join('/virtual', 'claude', 'projects', CLAUDE_SLUG, SESSION, 'subagents', 'workflows', RUN)
  agg.addClaudeLine(claudeLine({ id: 'w1', ts: last, agentId: A1.slice(1), usage: { input: 5, output: 2 }, final: true }),
    { isSub: true, file: path.join(dir, `agent-${A1.slice(1)}.jsonl`), attribution: 'none', projectSalt: '', hashProjects: false })
  agg.addWorkflowJournalLine(journalLine({ type: 'started', agentId: A1.slice(1) }),
    { isSub: true, file: path.join(dir, 'journal.jsonl'), attribution: 'none', projectSalt: '', hashProjects: false })
  const start = NOW - 60 * MIN
  const fields = pickRunRecord(bytes(runRecordJson({
    runId: RUN, status, startTime: end === null ? null : start, durationMs: end === null ? null : end - start,
  })))
  assert.ok(agg.setRunRecord(SESSION, RUN, { fields, stat: { size: 1, mtimeMs: 1 } }))
  return agg
}

test('the record\'s status is the third source of a run\'s end: its word, quoted — and it is outlived like the parent\'s', () => {
  const cases: Array<[string, string, string]> = [
    ['completed', 'done', "Completed — Claude Code's run record says ‘completed’."],
    ['failed', 'failed', "Failed — Claude Code's run record says ‘failed’."],
    ['killed', 'stopped', "Stopped — Claude Code's run record says ‘killed’."],
    ['stopped', 'stopped', "Stopped — Claude Code's run record says ‘stopped’."],
    ['cancelled', 'stopped', "Stopped — Claude Code's run record says ‘cancelled’."],
  ]
  // The member's last line came before the record's end: the record decides, and the member keeps
  // its own state — a run's end closes no member.
  for (const [status, state, sentence] of cases) {
    const { node, details } = runNode(recordRun(status, NOW - 50 * MIN))
    assert.deepEqual([node.state, node.derived, details.stateText], [state, false, sentence], status)
    assert.equal(node.tally?.unknown, 1, status)
  }
  // `running` is no end: the members decide.
  const running = runNode(recordRun('running', NOW - 50 * MIN))
  assert.deepEqual([running.node.state, running.details.stateText],
    ['unknown', 'Unknown — inferred: not every agent of this run has a recorded outcome, and none is running.'])
  // A member that wrote more than a minute after the record's end: the run is its members' again —
  // running here — and exactly a minute after, the record still stands.
  const end = NOW - 5 * MIN
  const outlived = runNode(recordRun('completed', end + RESUMED_AFTER_MS + 1000, end))
  assert.deepEqual([outlived.node.state, outlived.node.derived, outlived.details.stateText],
    ['running', true, 'Running — inferred: at least one agent of this run is running.'])
  assert.equal(runNode(recordRun('completed', end + RESUMED_AFTER_MS, end)).node.state, 'done')
  // A record that states no start or no length has no time for its end, and is never outlived.
  assert.equal(runNode(recordRun('completed', NOW - MIN, null)).node.state, 'done')
})

test('the record\'s row and its sentences are German in German', () => {
  const bundle = JSON.parse(fs.readFileSync(path.join(ROOT, 'l10n', 'bundle.l10n.de.json'), 'utf8')) as Record<string, string>
  try {
    setBundle(bundle)
    setLocale('de')
    const texts = (status: string): NodeDetails => runNode(recordRun(status, NOW - 50 * MIN)).details
    assert.equal(texts('completed').stateText, 'Fertig — der Lauf-Datensatz von Claude Code sagt ‚completed‘.')
    assert.equal(texts('failed').stateText, 'Fehlgeschlagen — der Lauf-Datensatz von Claude Code sagt ‚failed‘.')
    assert.equal(texts('killed').stateText, 'Gestoppt — der Lauf-Datensatz von Claude Code sagt ‚killed‘.')
    const d = texts('completed')
    assert.deepEqual(rowOf(d, 'Lauf-Datensatz von Claude Code'), {
      label: 'Lauf-Datensatz von Claude Code',
      value: `completed · Start ${clock(NOW - 60 * MIN)} · 3 Agenten · 48,2K Token · 17 Tool-Aufrufe · 20 min 00 s · Standardmodell claude-fable-5-1[1m]`,
      note: 'die eigenen Zahlen von Claude Code, nie zu einer Summe addiert',
      kind: 'sentence',
    })
  } finally {
    setBundle(undefined)
    setLocale(undefined)
  }
})

// ---------------------------------------------------------------------------
// §0a.12: nothing of the record but the seven, anywhere
// ---------------------------------------------------------------------------

function loadDashboard(): typeof import('../src/dashboard') {
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
  return require('../src/dashboard')
}

/** The Agents section as the page's own script renders it. */
function pageOf(vm: ViewModel): string {
  const { DashboardProvider } = loadDashboard()
  const html = { value: '' }
  new DashboardProvider(() => undefined).resolveWebviewView({
    visible: true,
    webview: {
      options: {},
      set html(v: string) { html.value = v },
      get html(): string { return html.value },
      onDidReceiveMessage: () => ({ dispose: () => undefined }),
      postMessage: () => Promise.resolve(true),
      cspSource: '',
    },
    onDidChangeVisibility: () => ({ dispose: () => undefined }),
    onDidDispose: () => ({ dispose: () => undefined }),
    show: () => undefined,
  } as never)
  const open = /<script nonce="[A-Za-z0-9]+">/.exec(html.value)
  assert.ok(open, 'the page has no script')
  const script = html.value.slice(open.index + open[0].length, html.value.indexOf('</script>', open.index))
  const c = nodeVm.createContext({
    acquireVsCodeApi: () => ({ postMessage: () => undefined }),
    document: { addEventListener: () => undefined, getElementById: () => null, querySelector: () => null, querySelectorAll: () => [] },
    window: { addEventListener: () => undefined },
    console,
  })
  nodeVm.runInContext(script, c)
  ;(c as Record<string, unknown>).fixture = JSON.parse(JSON.stringify(vm))
  return String(nodeVm.runInContext('vm = fixture; sAgents()', c))
}

test('§0a.12 leak test: a record\'s script, logs, prompts, results and account id reach neither the run, the snapshot, the page, the markdown nor an export', async () => {
  const secret = 'RUNRECORD-HOME-8e1a'
  const h = recordHome('runrecord-leak', leakRecord(secret))
  assert.ok(fs.statSync(h.record).size >= 2_500_000)
  const live = new Aggregator()
  await scan(live)
  // A restart — a snapshot round trip at the revision before — and the replay.
  const snap = JSON.parse(JSON.stringify(live.toSnapshot())) as Snapshot
  snap.agentsRevision = AGENT_TABLES_REVISION - 1
  const agg = Aggregator.fromSnapshot(snap)
  await replayAgents(agg, agentReplayFiles(agg, NOW))
  // It went through: exactly the seven, the last of the key given twice.
  assert.deepEqual(runOfAgg(live).record, SEVEN)
  assert.deepEqual(runOfAgg(agg).record, SEVEN)
  assert.deepEqual(Object.keys(runOfAgg(agg).record as object).sort(), [...RUN_RECORD_KEYS].sort())

  const cfg = makeConfig()
  const expanded = [`s:${SESSION}`, RUN_KEY]
  const input = makeInput({ agg, cfg, ui: { agentsExpanded: expanded, agentSelected: RUN_KEY } })
  const vm = buildViewModel(input)
  assert.equal(vm.agents.selected?.key, RUN_KEY)
  const page = pageOf(vm)
  assert.ok(page.includes('<span class="nobr">48.2K</span> tokens · 17 tool calls · <span class="nobr">21 min</span> <span class="nobr">05 s</span>'),
    'the page does not show the record, each figure kept with its unit')
  const range = { from: '2026-09-01', to: '2026-09-03' }
  const outputs: Array<[string, string]> = [
    ['run', JSON.stringify(runOfAgg(agg))], ['live snapshot', JSON.stringify(live.toSnapshot())], ['snapshot', JSON.stringify(agg.toSnapshot())],
    ['view model', JSON.stringify(vm)], ['page', page], ['markdown', markdownDocument(vm, agentTreeFor(input, 'text'))],
    ['json export', toJson(agg, range, cfg, utc, NOW)], ['csv export', toCsv(agg, range, cfg, utc)],
    ['agents export', agentsCsv(agg, range, cfg, utc, NOW)],
  ]
  const never = new RegExp(`${secret}|${secret.toLowerCase()}|/tmp/synthetic`)
  for (const [where, text] of outputs) assert.equal(never.test(text), false, `${where} holds the record's content`)
  // And the stored state and the run carry no key of the record but the seven.
  const keys = /"(script|scriptPath|logs|phases|workflowProgress|args|accountUuid|emailAddress|conversation|taskId|workflowName|timestamp)"/
  for (const [where, text] of outputs.slice(0, 3)) assert.equal(keys.test(text), false, `${where} holds a key of the record's content`)
})
