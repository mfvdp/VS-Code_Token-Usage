// SPDX-FileCopyrightText: 2026 Frederik Marx
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The opt-in agent hook (1.6 O4, spec §0a.13): the script Claude Code runs, the reader of the file
 * it writes, the copy of the script into globalStorage, the setup document, and the marker the tree
 * puts on a row.
 *
 * Every hook input here is synthetic, in the shape the key-names-only probe of 2026-09-23 recorded
 * (Claude Code 2.1.281: `SubagentStart`, `SubagentStop`, `Notification`, `PermissionRequest`), and
 * every key the probe saw beside the four the script reads carries a synthetic string — the leak
 * test proves none of them reaches the mirror, the tree, the page or the markdown. Nothing outside
 * the test's own temporary directories is touched.
 */

import { strict as assert } from 'node:assert'
import { execFileSync, spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { test } from 'node:test'
import {
  cleanHookLine, CopyFs, HOOK_FUTURE_MS, HOOK_LINE_MAX_BYTES, HOOK_TAIL_BYTES, HookMirror, hookCommand, hookSetupDocument,
  hookSnippet, installHookScript, parseHookMirror, readHookTail, refreshHookScript, shellPath,
} from '../src/agentHook'
import {
  acceptedMirrorPath, appendMirrorLine, HOOK_EVENTS, HOOK_KEEP_LINES, HOOK_MIRROR_NAME, HOOK_ROTATE_BYTES, HOOK_SCRIPT_NAME,
  HOOK_STDIN_MAX_BYTES, HookFs, hookId, hookLineOf, hookMain, NOTIFICATION_WAITS,
} from '../src/agentHookScript'
import { AgentTreeVm, HOOK_MAX_AGE_MS, HookEntry, TreeNode, hookKey } from '../src/agentTree'
import { AgentTreeInput, buildAgentTree } from '../src/agentTreeBuild'
import { cleanAgentId } from '../src/agg'
import { setBundle, setLocale } from '../src/i18n'
import { TimeConfig } from '../src/time'
import { AgentRec, MainRec } from '../src/types'
import { tmpDir } from './fixtures/helpers'
import { ROOT } from './helpers/nls'

const NOW = Date.UTC(2026, 8, 22, 12, 0, 0)
const MIN = 60_000
const tcfg: TimeConfig = { zone: 'utc', dayBoundaryHour: 0, startOfWeek: 'monday', hourCycle: 'h23' }

/** Claude Code's shapes: a session's UUID, an agent's `a` + 16 hex. */
const SESSION = '3f9a2c1d-7b4e-4c8a-9e21-5d6f7a8b9c0d'
const AGENT = 'a94f3c2e10b7d5e19'

/**
 * Every key the probe recorded beside the four the script reads (§7c "P14b probe result"), with a
 * synthetic value each — and the ones §0a.13 names on top. None of them may leave the script.
 */
const SYNTHETIC: Record<string, unknown> = {
  message: 'synthetic hook message',
  tool_input: { command: 'synthetic tool input rm -rf /synthetic' },
  tool_response: { stdout: 'synthetic tool response' },
  prompt: 'synthetic hook prompt',
  transcript_path: '/synthetic/transcript/path.jsonl',
  agent_transcript_path: '/synthetic/agent/transcript.jsonl',
  cwd: '/synthetic/working/directory',
  last_assistant_message: 'synthetic last assistant message',
  prompt_id: 'synthetic-prompt-id',
  scratchpad_dir: '/synthetic/scratchpad',
  background_tasks: [{ id: 'synthetic-background-task' }],
  session_crons: [{ id: 'synthetic-session-cron' }],
  permission_mode: 'synthetic-permission-mode',
  permission_suggestions: [{ rule: 'synthetic permission suggestion' }],
  effort: { level: 'synthetic-effort-level' },
  agent_type: 'synthetic-agent-type',
  stop_hook_active: 'synthetic-stop-hook-active',
  tool_name: 'SyntheticToolName',
}
/** Every string of the synthetic values, and each key's value as JSON — what must be found nowhere. */
const LEAKS: string[] = Object.values(SYNTHETIC).map((v) => (typeof v === 'string' ? v : JSON.stringify(v)))
  .concat(['synthetic'])

/** A hook call as Claude Code hands it over, with every synthetic neighbour. */
function hookInput(event: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return { ...SYNTHETIC, hook_event_name: event, session_id: SESSION, agent_id: AGENT, ...over }
}

const stdin = (v: unknown): Buffer => Buffer.from(typeof v === 'string' ? v : JSON.stringify(v), 'utf8')

/** A temporary storage directory and its mirror path. */
function storage(): { dir: string; mirror: string } {
  const dir = tmpDir('tp-hook')
  return { dir, mirror: path.join(dir, HOOK_MIRROR_NAME) }
}

function linesOf(file: string): string[] {
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter((l) => l.length > 0) : []
}

// ---------------------------------------------------------------------------
// The script
// ---------------------------------------------------------------------------

test('the leak test: a hook call becomes one line of six fields and nothing of its input else (§0a.13)', () => {
  const { mirror } = storage()
  for (const [event, over] of [
    ['PermissionRequest', {}], ['SubagentStart', {}], ['SubagentStop', {}],
    ['Notification', { notification_type: 'permission_prompt' }], ['Notification', { notification_type: 'idle_prompt', agent_id: undefined }],
  ] as const) {
    assert.equal(hookMain(['node', 'agent-hook.js', mirror], stdin(hookInput(event, over)), NOW), 0)
  }
  const lines = linesOf(mirror)
  assert.equal(lines.length, 5)
  const text = fs.readFileSync(mirror, 'utf8')
  for (const s of LEAKS) assert.equal(text.includes(s), false, `the mirror holds ${s}`)
  for (const line of lines) {
    const o = JSON.parse(line) as Record<string, unknown>
    assert.deepEqual(Object.keys(o), ['v', 'ts', 'event', 'sessionId', 'agentId', 'wait'])
    assert.equal(o.v, 1)
    assert.equal(o.ts, NOW)
    assert.equal(o.sessionId, SESSION)
  }
  assert.deepEqual(lines.map((l) => {
    const o = JSON.parse(l) as { event: string; agentId: string | null; wait: string }
    return [o.event, o.agentId, o.wait]
  }), [
    ['PermissionRequest', AGENT, 'permission'], ['SubagentStart', AGENT, 'none'], ['SubagentStop', AGENT, 'none'],
    ['Notification', AGENT, 'permission'], ['Notification', null, 'input'],
  ])
  // And through the reader: the entries hold the same six fields, nothing synthetic.
  const entries = parseHookMirror(text, NOW)
  const json = JSON.stringify([...entries.values()])
  for (const s of LEAKS) assert.equal(json.includes(s), false, `an entry holds ${s}`)
})

test('the script reads exactly the four keys of its input (§0a.13): the others may be anything, or missing', () => {
  // A call with only the four keys gives the same line as one with every neighbour.
  const bare = { hook_event_name: 'PermissionRequest', session_id: SESSION, agent_id: AGENT }
  assert.deepEqual(hookLineOf(bare, NOW), hookLineOf(hookInput('PermissionRequest'), NOW))
  // A getter on any other key is never called.
  const touched: string[] = []
  const trap: Record<string, unknown> = { hook_event_name: 'Notification', session_id: SESSION, notification_type: 'idle_prompt' }
  for (const key of Object.keys(SYNTHETIC)) {
    Object.defineProperty(trap, key, { enumerable: true, get: () => { touched.push(key); return 'synthetic' } })
  }
  assert.deepEqual(hookLineOf(trap, NOW), { v: 1, ts: NOW, event: 'Notification', sessionId: SESSION, agentId: null, wait: 'input' })
  assert.deepEqual(touched, [])
})

test('the waits: a permission request always, a notification by its documented type, a start or a stop never', () => {
  const wait = (event: string, over: Record<string, unknown> = {}): string | null => hookLineOf(hookInput(event, over), NOW)?.wait ?? null
  assert.equal(wait('PermissionRequest'), 'permission')
  assert.equal(wait('PermissionRequest', { tool_name: 'Edit' }), 'permission')
  assert.equal(wait('SubagentStart'), 'none')
  assert.equal(wait('SubagentStop'), 'none')
  const expected: Record<string, string> = {
    permission_prompt: 'permission', idle_prompt: 'input', agent_needs_input: 'input', elicitation_dialog: 'input',
    elicitation_url_dialog: 'input', auth_success: 'none', elicitation_complete: 'none', elicitation_response: 'none',
    agent_completed: 'none', quota_auto_resume_fired: 'none', quota_auto_resume_stale: 'none', quota_auto_resume_disabled: 'none',
  }
  assert.deepEqual({ ...NOTIFICATION_WAITS }, expected)
  for (const [kind, w] of Object.entries(expected)) {
    assert.match(kind, /^[a-z_]{1,40}$/)
    assert.equal(wait('Notification', { notification_type: kind }), w, kind)
  }
  // The events are the four the setup document installs — PostToolUse is not among them.
  assert.deepEqual([...HOOK_EVENTS], ['SubagentStart', 'SubagentStop', 'Notification', 'PermissionRequest'])
})

test('an unknown event, an unknown notification type or a missing one is dropped: nothing is written', () => {
  const { mirror } = storage()
  for (const input of [
    hookInput('PostToolUse'), hookInput('Stop'), hookInput('UserPromptSubmit'), hookInput('PreToolUse'), hookInput('permissionrequest'),
    hookInput('Notification', { notification_type: 'synthetic_type' }), hookInput('Notification', { notification_type: undefined }),
    hookInput('Notification', { notification_type: 'toString' }), hookInput('Notification', { notification_type: '__proto__' }),
    hookInput('Notification', { notification_type: 7 }), { ...hookInput('PermissionRequest'), hook_event_name: undefined },
  ]) {
    assert.equal(hookLineOf(input, NOW), null, JSON.stringify(input.hook_event_name) + ' ' + JSON.stringify(input.notification_type))
    assert.equal(hookMain(['node', 'agent-hook.js', mirror], stdin(input), NOW), 0)
  }
  assert.equal(fs.existsSync(mirror), false)
})

test('long values and values outside the id alphabet are dropped, never cut: no line for them', () => {
  const long = 'a'.repeat(65)
  for (const over of [
    { session_id: long }, { session_id: '' }, { session_id: undefined }, { session_id: 'sess ion' }, { session_id: '../x' },
    { session_id: 42 }, { agent_id: long }, { agent_id: 'a94f/..' }, { agent_id: 7 }, { agent_id: '' }, { agent_id: {} },
  ]) {
    assert.equal(hookLineOf(hookInput('PermissionRequest', over), NOW), null, JSON.stringify(over))
  }
  // Sixty-four characters fit, as the aggregator's own ids do; a missing agent is the session's call.
  assert.equal(hookLineOf(hookInput('PermissionRequest', { agent_id: 'a'.repeat(64) }), NOW)?.agentId, 'a'.repeat(64))
  assert.equal(hookLineOf(hookInput('PermissionRequest', { agent_id: null }), NOW)?.agentId, null)
  // Not an object, or no time: nothing.
  for (const v of [null, [], 'x', 42]) assert.equal(hookLineOf(v, NOW), null)
  assert.equal(hookLineOf(hookInput('SubagentStop'), NaN), null)
  // The script's alphabet is the aggregator's.
  for (const v of [SESSION, AGENT, 'a'.repeat(64), long, '', 'a b', 'a.b', 'a:b', 'a/b', 'ab_-9', null, 3, 'Ä']) {
    assert.equal(hookId(v), cleanAgentId(v), String(v))
  }
})

test('the script writes only the mirror it is given: an absolute path named agent-hook.jsonl without a .. part', () => {
  const { dir, mirror } = storage()
  const call = stdin(hookInput('PermissionRequest'))
  const refused = [
    undefined, '', HOOK_MIRROR_NAME, `./${HOOK_MIRROR_NAME}`, path.join(dir, 'other.jsonl'), path.join(dir, 'agent-hook.json'),
    path.join(dir, `${HOOK_MIRROR_NAME}.bak`), `${dir}${path.sep}..${path.sep}${path.basename(dir)}${path.sep}${HOOK_MIRROR_NAME}`,
    `${dir}/../x/${HOOK_MIRROR_NAME}`, `${dir}\\..\\${HOOK_MIRROR_NAME}`, `${dir}/..`, `${mirror}\u0000`, `${dir}/${'x'.repeat(5000)}/${HOOK_MIRROR_NAME}`,
  ]
  for (const arg of refused) {
    assert.equal(acceptedMirrorPath(arg), null, String(arg))
    assert.equal(hookMain(['node', 'agent-hook.js', ...(arg === undefined ? [] : [arg])], call, NOW), 0)
  }
  assert.deepEqual(fs.readdirSync(dir), [])
  assert.equal(acceptedMirrorPath(mirror), path.normalize(mirror))
  hookMain(['node', 'agent-hook.js', mirror], call, NOW)
  assert.deepEqual(fs.readdirSync(dir), [HOOK_MIRROR_NAME])
  // No directory is made: a mirror whose directory is gone is not written.
  const gone = path.join(dir, 'gone', HOOK_MIRROR_NAME)
  assert.equal(hookMain(['node', 'agent-hook.js', gone], call, NOW), 0)
  assert.equal(fs.existsSync(path.dirname(gone)), false)
  // Nor through a link of that name (POSIX: the file is opened with O_NOFOLLOW).
  if (process.platform !== 'win32') {
    const other = storage()
    const target = path.join(other.dir, 'elsewhere.txt')
    fs.writeFileSync(target, 'untouched\n')
    fs.symlinkSync(target, other.mirror)
    assert.equal(hookMain(['node', 'agent-hook.js', other.mirror], call, NOW), 0)
    assert.equal(fs.readFileSync(target, 'utf8'), 'untouched\n')
  }
})

test('the input is read up to 1 MB: a longer one, or one that is no JSON, writes nothing', () => {
  const { mirror } = storage()
  const big = JSON.stringify({ ...hookInput('PermissionRequest'), tool_input: { command: 'x'.repeat(HOOK_STDIN_MAX_BYTES) } })
  assert.ok(Buffer.byteLength(big) > HOOK_STDIN_MAX_BYTES)
  for (const input of [Buffer.from(big), Buffer.from('not json'), Buffer.alloc(0), null]) {
    assert.equal(hookMain(['node', 'agent-hook.js', mirror], input, NOW), 0)
  }
  assert.equal(fs.existsSync(mirror), false)
  // Just under the cap is read.
  const fits = JSON.stringify({ ...hookInput('PermissionRequest'), tool_input: { command: 'x'.repeat(HOOK_STDIN_MAX_BYTES - 2000) } })
  assert.ok(Buffer.byteLength(fits) <= HOOK_STDIN_MAX_BYTES)
  hookMain(['node', 'agent-hook.js', mirror], Buffer.from(fits), NOW)
  assert.equal(linesOf(mirror).length, 1)
})

/** The real file operations, every call on a path recorded. */
function spyHookFs(): { io: HookFs; calls: Array<[string, string]> } {
  const calls: Array<[string, string]> = []
  const real = fs as unknown as HookFs
  const io: HookFs = {
    openSync: (f, flags, mode) => { calls.push(['open', f]); return real.openSync(f, flags, mode) },
    writeSync: (fd, text) => real.writeSync(fd, text),
    fstatSync: (fd) => real.fstatSync(fd),
    closeSync: (fd) => real.closeSync(fd),
    readSync: (fd, buf, o, l, p) => real.readSync(fd, buf, o, l, p),
    writeFileSync: (f, text, o) => { calls.push(['writeFile', f]); real.writeFileSync(f, text, o) },
    renameSync: (a, b) => { calls.push(['rename', `${a} -> ${b}`]); real.renameSync(a, b) },
    unlinkSync: (f) => { calls.push(['unlink', f]); real.unlinkSync(f) },
  }
  return { io, calls }
}

test('the mirror is appended to, and over 256 KB cut to its newest 1000 lines through a temporary file and a rename', () => {
  const { dir, mirror } = storage()
  const line = (n: number): string => JSON.stringify({ v: 1, ts: NOW + n, event: 'SubagentStop', sessionId: SESSION, agentId: AGENT, wait: 'none' })
  // Up to the cap the file only grows.
  let n = 0
  const { io, calls } = spyHookFs()
  while (fs.existsSync(mirror) ? fs.statSync(mirror).size + line(n).length + 1 <= HOOK_ROTATE_BYTES : true) {
    appendMirrorLine(mirror, line(n), io)
    n++
  }
  assert.ok(n > HOOK_KEEP_LINES, `only ${n} lines fit under the cap`)
  assert.equal(linesOf(mirror).length, n)
  assert.equal(calls.some(([op]) => op === 'rename'), false, 'rotated before the cap')
  // One more line takes it over: the newest 1000 lines stay, the last one written among them.
  appendMirrorLine(mirror, line(n), io)
  const kept = linesOf(mirror)
  assert.equal(kept.length, HOOK_KEEP_LINES)
  assert.equal(kept[kept.length - 1], line(n))
  assert.equal(kept[0], line(n - HOOK_KEEP_LINES + 1))
  assert.ok(fs.statSync(mirror).size < HOOK_ROTATE_BYTES)
  // Written beside the mirror and renamed over it — nothing outside the directory, no temporary file left.
  const writes = calls.filter(([op]) => op === 'writeFile' || op === 'rename')
  assert.equal(writes.length, 2)
  const tmp = writes[0][1]
  assert.equal(path.dirname(tmp), dir)
  assert.equal(writes[1][1], `${tmp} -> ${mirror}`)
  for (const [, p] of calls) assert.ok(p.split(' -> ').every((x) => x.startsWith(dir + path.sep)), p)
  assert.deepEqual(fs.readdirSync(dir), [HOOK_MIRROR_NAME])
  // Every line whole: the reader takes them all.
  assert.equal(kept.every((l) => JSON.parse(l).v === 1), true)
})

/** dist/agent-hook.js — built once when a bare `node --test` finds none, as test/extension.test.ts does for the worker. */
function bundle(): string {
  const file = path.join(ROOT, 'dist', HOOK_SCRIPT_NAME)
  if (!fs.existsSync(file)) execFileSync(process.execPath, ['build.mjs'], { cwd: ROOT, stdio: 'ignore' })
  return file
}

test('the built script, as Claude Code runs it: exit code 0 and no output, whatever it is given', () => {
  const script = bundle()
  const { dir, mirror } = storage()
  const run = (args: string[], input: string): { status: number | null; out: string } => {
    const r = spawnSync(process.execPath, [script, ...args], { input, encoding: 'utf8', timeout: 15_000 })
    return { status: r.status, out: `${r.stdout}${r.stderr}` }
  }
  const good = JSON.stringify(hookInput('PermissionRequest'))
  for (const [args, input] of [
    [[mirror], good], [[mirror], 'not json'], [[], good], [[path.join(dir, 'x.jsonl')], good], [[mirror], ''],
    [[mirror], JSON.stringify(hookInput('PostToolUse'))], [[path.join(dir, 'gone', HOOK_MIRROR_NAME)], good],
  ] as Array<[string[], string]>) {
    const r = run(args, input)
    assert.deepEqual(r, { status: 0, out: '' }, `${args.join(' ')} ← ${input.slice(0, 40)}`)
  }
  const lines = linesOf(mirror)
  assert.equal(lines.length, 1)
  const o = JSON.parse(lines[0]) as Record<string, unknown>
  assert.deepEqual(Object.keys(o), ['v', 'ts', 'event', 'sessionId', 'agentId', 'wait'])
  for (const s of LEAKS) assert.equal(lines[0].includes(s), false, s)
  assert.deepEqual(fs.readdirSync(dir), [HOOK_MIRROR_NAME])
})

// ---------------------------------------------------------------------------
// The reader
// ---------------------------------------------------------------------------

const mirrorLine = (over: Record<string, unknown> = {}): string =>
  JSON.stringify({ v: 1, ts: NOW - MIN, event: 'PermissionRequest', sessionId: SESSION, agentId: AGENT, wait: 'permission', ...over })

test('the reader checks every one of the six fields again, and takes a line of the script\'s shape only', () => {
  assert.deepEqual(cleanHookLine(mirrorLine(), NOW),
    { ts: NOW - MIN, event: 'PermissionRequest', sessionId: SESSION, agentId: AGENT, wait: 'permission' })
  const refused: Array<Record<string, unknown>> = [
    { v: 2 }, { v: '1' }, { ts: NOW - MIN + 0.5 }, { ts: -1 }, { ts: 0 }, { ts: '1' }, { ts: null },
    { ts: NOW - HOOK_MAX_AGE_MS - 1 }, { ts: NOW + HOOK_FUTURE_MS + 1 },
    { event: 'PostToolUse' }, { event: 'Stop' }, { event: null },
    { sessionId: 'a'.repeat(65) }, { sessionId: 'se ss' }, { sessionId: null }, { sessionId: '' },
    { agentId: 'a'.repeat(65) }, { agentId: '../x' }, { agentId: '' }, { agentId: 5 },
    { wait: 'approval' }, { wait: null },
    // A pair the script never writes: a start or a stop that waits, a permission request that does not.
    { event: 'SubagentStop', wait: 'permission' }, { event: 'SubagentStart', wait: 'input' }, { event: 'PermissionRequest', wait: 'none' },
  ]
  for (const over of refused) assert.equal(cleanHookLine(mirrorLine(over), NOW), null, JSON.stringify(over))
  // A key more — or one fewer — is not a line of the script.
  assert.equal(cleanHookLine(mirrorLine({ message: 'synthetic' }), NOW), null)
  const five = JSON.parse(mirrorLine()) as Record<string, unknown>
  delete five.agentId
  assert.equal(cleanHookLine(JSON.stringify(five), NOW), null)
  // Not an object, no JSON, over 1 KB.
  for (const raw of ['', '[]', 'null', '1', 'not json', mirrorLine().slice(0, -1)]) assert.equal(cleanHookLine(raw, NOW), null, raw)
  const padded = mirrorLine({ sessionId: SESSION }).replace('{', `{${' '.repeat(HOOK_LINE_MAX_BYTES)}`)
  assert.equal(cleanHookLine(padded, NOW), null)
  // The edges that count: exactly as old as the cap, a minute ahead, a session's own call.
  assert.ok(cleanHookLine(mirrorLine({ ts: NOW - HOOK_MAX_AGE_MS }), NOW))
  assert.ok(cleanHookLine(mirrorLine({ ts: NOW + HOOK_FUTURE_MS }), NOW))
  assert.equal(cleanHookLine(mirrorLine({ agentId: null }), NOW)?.agentId, null)
})

test('the latest call per session and agent counts — a stop after a permission request clears it', () => {
  const text = [
    mirrorLine({ ts: NOW - 5 * MIN }),
    mirrorLine({ ts: NOW - 4 * MIN, event: 'SubagentStop', wait: 'none' }),
    mirrorLine({ ts: NOW - 3 * MIN, agentId: 'a0000000000000001' }),
    mirrorLine({ ts: NOW - 2 * MIN, agentId: null, event: 'Notification', wait: 'input' }),
    'garbage',
    mirrorLine({ ts: NOW - 2 * MIN, agentId: null, event: 'Notification', wait: 'permission' }),
    mirrorLine({ ts: NOW - 6 * MIN, agentId: 'a0000000000000001', event: 'SubagentStop', wait: 'none' }),
  ].join('\n')
  const entries = parseHookMirror(text, NOW)
  assert.deepEqual([...entries.keys()].sort(), [hookKey(SESSION, null), hookKey(SESSION, AGENT), hookKey(SESSION, 'a0000000000000001')].sort())
  assert.equal(entries.get(hookKey(SESSION, AGENT))?.wait, 'none')
  // An older line after a newer one does not replace it; of two at the same time, the later line wins.
  assert.equal(entries.get(hookKey(SESSION, 'a0000000000000001'))?.wait, 'permission')
  assert.equal(entries.get(hookKey(SESSION, null))?.wait, 'permission')
  // CRLF endings are the same lines.
  assert.equal(parseHookMirror(text.replace(/\n/g, '\r\n'), NOW).size, 3)
})

test('the reader takes the file\'s last 256 KB, whole lines only, and reads it again only when it changed', () => {
  const { mirror } = storage()
  // A first line too far back to be read whole, then lines up to the tail's size.
  const filler = mirrorLine({ ts: NOW - 20 * MIN, agentId: 'a0000000000000002' })
  const lines = [mirrorLine({ ts: NOW - 10 * MIN, agentId: 'a0000000000000003' })]
  while (lines.join('\n').length < HOOK_TAIL_BYTES + 5000) lines.push(filler)
  lines.push(mirrorLine())
  fs.writeFileSync(mirror, lines.join('\n') + '\n')
  const tail = readHookTail(mirror)
  assert.ok(tail)
  assert.ok(Buffer.byteLength(tail.text) <= HOOK_TAIL_BYTES)
  // The cut line at the start is not taken; every line taken is whole.
  assert.equal(tail.text.split('\n').filter(Boolean).every((l) => cleanHookLine(l, NOW) !== null), true)
  const m = new HookMirror(mirror)
  assert.equal(m.refresh(NOW), true)
  assert.equal(m.entries().has(hookKey(SESSION, 'a0000000000000003')), false, 'a line before the tail was read')
  assert.equal(m.entries().get(hookKey(SESSION, AGENT))?.wait, 'permission')
  // Unchanged: nothing read again.
  assert.equal(m.refresh(NOW), false)
  // Changed: read again; gone: no entry.
  fs.appendFileSync(mirror, mirrorLine({ ts: NOW - 30_000, event: 'SubagentStop', wait: 'none' }) + '\n')
  assert.equal(m.refresh(NOW), true)
  assert.equal(m.entries().get(hookKey(SESSION, AGENT))?.wait, 'none')
  fs.rmSync(mirror)
  assert.equal(m.refresh(NOW), true)
  assert.equal(m.entries().size, 0)
  assert.equal(m.refresh(NOW), false)
  // Not through a link, and not a directory of that name.
  if (process.platform !== 'win32') {
    const other = storage()
    const real = path.join(other.dir, 'real.jsonl')
    fs.writeFileSync(real, mirrorLine() + '\n')
    fs.symlinkSync(real, other.mirror)
    assert.equal(readHookTail(other.mirror), null)
    const linked = new HookMirror(other.mirror)
    linked.refresh(NOW)
    assert.equal(linked.entries().size, 0)
  }
  const dirNamed = storage()
  fs.mkdirSync(dirNamed.mirror)
  assert.equal(readHookTail(dirNamed.mirror), null)
})

// ---------------------------------------------------------------------------
// The copy into globalStorage and the setup document
// ---------------------------------------------------------------------------

/** The real copy operations, every write recorded with its path. */
function spyCopyFs(): { io: CopyFs; writes: string[] } {
  const writes: string[] = []
  const io: CopyFs = {
    statSync: (f) => fs.statSync(f),
    copyFileSync: (a, b) => { writes.push(b); fs.copyFileSync(a, b) },
    renameSync: (a, b) => { writes.push(a, b); fs.renameSync(a, b) },
    unlinkSync: (f) => { writes.push(f); fs.unlinkSync(f) },
  }
  return { io, writes }
}

test('the setup copies the script into globalStorage and writes nothing anywhere else (fs spy)', () => {
  const home = tmpDir('tp-hook-home')
  const claude = path.join(home, '.claude')
  fs.mkdirSync(claude)
  fs.writeFileSync(path.join(claude, 'settings.json'), '{"hooks":{}}\n')
  const src = tmpDir('tp-hook-dist')
  const shipped = path.join(src, HOOK_SCRIPT_NAME)
  fs.writeFileSync(shipped, '// the script\n')
  const { dir } = storage()
  const { io, writes } = spyCopyFs()
  const target = installHookScript(shipped, dir, io)
  assert.equal(target, path.join(dir, HOOK_SCRIPT_NAME))
  assert.equal(fs.readFileSync(target, 'utf8'), '// the script\n')
  assert.ok(writes.length > 0)
  for (const w of writes) assert.ok(w.startsWith(dir + path.sep), `a write outside globalStorage: ${w}`)
  assert.deepEqual(fs.readdirSync(dir), [HOOK_SCRIPT_NAME])
  assert.equal(fs.readFileSync(path.join(claude, 'settings.json'), 'utf8'), '{"hooks":{}}\n')
  assert.deepEqual(fs.readdirSync(claude), ['settings.json'])
  // A missing bundle is said, and leaves nothing behind.
  assert.throws(() => installHookScript(path.join(src, 'missing.js'), dir, io))
  assert.deepEqual(fs.readdirSync(dir), [HOOK_SCRIPT_NAME])
})

test('at activation the copy is refreshed only when it is there and older than the shipped script', () => {
  const src = tmpDir('tp-hook-dist')
  const shipped = path.join(src, HOOK_SCRIPT_NAME)
  fs.writeFileSync(shipped, '// build 2\n')
  const { dir } = storage()
  const { io, writes } = spyCopyFs()
  // No copy: nothing is made — only the setup command makes one.
  assert.equal(refreshHookScript(shipped, dir, io), false)
  assert.deepEqual([fs.readdirSync(dir), writes], [[], []])
  // An older copy is replaced.
  const copy = path.join(dir, HOOK_SCRIPT_NAME)
  fs.writeFileSync(copy, '// build 1\n')
  const past = new Date(Date.now() - 3_600_000)
  fs.utimesSync(copy, past, past)
  assert.equal(refreshHookScript(shipped, dir, io), true)
  assert.equal(fs.readFileSync(copy, 'utf8'), '// build 2\n')
  for (const w of writes) assert.ok(w.startsWith(dir + path.sep), w)
  // A copy as new as the script and of its size stays.
  const before = writes.length
  const later = new Date(Date.now() + 3_600_000)
  fs.utimesSync(copy, later, later)
  assert.equal(refreshHookScript(shipped, dir, io), false)
  assert.equal(writes.length, before)
})

test('the setup document: the snippet with this machine\'s two paths, what it reads, Node.js required, how to remove it', () => {
  const posix = '/home/t/.config/Code/User/globalStorage/frederik.token-pace'
  const doc = hookSetupDocument(posix, 'linux')
  const snippet = JSON.parse(hookSnippet(posix, 'linux')) as { hooks: Record<string, Array<{ hooks: Array<{ type: string; command: string }> }>> }
  assert.deepEqual(Object.keys(snippet.hooks), ['SubagentStart', 'SubagentStop', 'Notification', 'PermissionRequest'])
  const command = `node "${posix}/agent-hook.js" "${posix}/agent-hook.jsonl"`
  for (const list of Object.values(snippet.hooks)) assert.deepEqual(list, [{ hooks: [{ type: 'command', command }] }])
  assert.ok(doc.includes('```json\n' + hookSnippet(posix, 'linux') + '\n```'), doc)
  assert.equal(doc.includes('PostToolUse'), false)
  for (const claim of ['`~/.claude/settings.json`', 'Token Pace writes nothing into `~/.claude`', 'Node.js on the PATH',
    'there is no fallback', '`hook_event_name`, `session_id`, `agent_id` and `notification_type`',
    '`v`, `ts`, `event`, `sessionId`, `agentId` and `wait`', 'Delete the four entries', 'after 30 minutes',
    'In Claude Code\'s auto mode no permission dialog is shown, so no wait is reported.', 'Over 256 KB the file is cut to its newest 1000 lines',
    '## Removing it']) {
    assert.ok(doc.includes(claim), `the document does not say: ${claim}`)
  }
  // A path with a space or a shell character is quoted for the shell Claude Code runs the command in.
  assert.equal(hookCommand('/Users/t/Library/Application Support/Code/User/globalStorage/x', 'darwin'),
    'node "/Users/t/Library/Application Support/Code/User/globalStorage/x/agent-hook.js" "/Users/t/Library/Application Support/Code/User/globalStorage/x/agent-hook.jsonl"')
  assert.equal(shellPath('/a/$HOME/`x`/"q"/b\\c', 'linux'), '"/a/\\$HOME/\\`x\\`/\\"q\\"/b\\\\c"')
  // Windows: forward slashes, which Node takes and the shell does not read as escapes.
  assert.equal(hookCommand('C:\\Users\\t\\AppData\\Roaming\\Code\\User\\globalStorage\\x', 'win32'),
    'node "C:/Users/t/AppData/Roaming/Code/User/globalStorage/x/agent-hook.js" "C:/Users/t/AppData/Roaming/Code/User/globalStorage/x/agent-hook.jsonl"')
  // The path the snippet names is one the script accepts.
  assert.equal(acceptedMirrorPath(path.join(posix, HOOK_MIRROR_NAME)) !== null, path.isAbsolute(posix))
})

test('the setup document in German, through the bundle', () => {
  const bundle = JSON.parse(fs.readFileSync(path.join(ROOT, 'l10n', 'bundle.l10n.de.json'), 'utf8')) as Record<string, string>
  try {
    setLocale('de')
    setBundle(bundle)
    const doc = hookSetupDocument('/x/globalStorage/frederik.token-pace', 'linux')
    for (const claim of ['# Token Pace — der Agent-Hook', 'Token Pace schreibt nichts in `~/.claude`', '## Was er tut', '## Was er braucht',
      '## Der Eintrag', '## Entfernen', 'Ohne Node.js läuft der Hook nicht', '‚wartet auf Freigabe‘',
      'Im Auto-Modus von Claude Code erscheint kein Berechtigungsdialog, daher wird kein Warten gemeldet.', 'nach 30 Minuten',
      'Über 256 KB wird die Datei auf ihre neuesten 1000 Zeilen gekürzt.']) {
      assert.ok(doc.includes(claim), `the German document does not say: ${claim}`)
    }
    // The snippet is the same in either language: it is what the user copies.
    assert.ok(doc.includes(hookSnippet('/x/globalStorage/frederik.token-pace', 'linux')))
    assert.equal(/\b(What it does|Removing it|The snippet)\b/.test(doc), false, doc)
  } finally {
    setBundle(undefined)
    setLocale(undefined)
  }
})

// ---------------------------------------------------------------------------
// The marker in the tree
// ---------------------------------------------------------------------------

function main(over: Partial<MainRec> = {}): MainRec {
  return {
    source: 'claude', sessionId: SESSION, firstTs: NOW - 60 * MIN, lastTs: NOW - 2 * MIN, models: ['claude-opus-5'],
    input: 1000, cacheWrite: 500, cacheWrite1h: 0, cacheRead: 9000, output: 800, reasoning: 0,
    requests: 6, outputFinal: 6, toolCalls: 3, ccVersion: null, permissionMode: null, compactions: 0, lastCompaction: null,
    ...over,
  }
}

function rec(id: string, over: Partial<AgentRec> = {}): AgentRec {
  const dir = path.join(path.sep, 'home', 't', '.claude', 'projects', '-home-t-alpha')
  return {
    source: 'claude', agentId: id, sessionId: SESSION, sessionFile: path.join(dir, `${SESSION}.jsonl`), workflowId: null,
    meta: { agentType: 'Explore', model: 'opus', spawnDepth: 1, toolUseId: null, parentAgentId: null },
    metaTries: 1, spawnerFile: path.join(dir, `${SESSION}.jsonl`),
    firstTs: NOW - 20 * MIN, lastTs: NOW - 2 * MIN, models: ['claude-opus-5'],
    input: 300, cacheWrite: 200, cacheWrite1h: 0, cacheRead: 5000, output: 700, reasoning: 0,
    requests: 5, outputFinal: 5, toolCalls: 3, outcome: null, outcomeTs: null, outcomeStatus: null, rejected: null,
    lastTool: 'Bash', lastToolTs: NOW - 2 * MIN, effort: null, efforts: [], lastContext: null,
    toolErrors: 0, cacheMisses: {}, cacheMissedTokens: 0, ccVersion: null, permissionMode: null, compactions: 0, lastCompaction: null,
    ...over,
  }
}

function entry(over: Partial<HookEntry> = {}): HookEntry {
  return { ts: NOW - MIN, event: 'PermissionRequest', sessionId: SESSION, agentId: AGENT, wait: 'permission', ...over }
}

function hookMap(...entries: HookEntry[]): Map<string, HookEntry> {
  return new Map(entries.map((e) => [hookKey(e.sessionId, e.agentId), e]))
}

function tree(hook: ReadonlyMap<string, HookEntry> | undefined, over: Partial<AgentTreeInput> = {}, now = NOW): AgentTreeVm {
  return buildAgentTree({
    agents: [rec(AGENT)], launches: [], mains: [main()], sessions: [], attribution: 'none', selected: null, mode: 'text', tcfg,
    hook, ...over,
  }, now)
}

function nodeOf(vm: AgentTreeVm, key: string): TreeNode {
  const walk = (list: TreeNode[]): TreeNode | null => {
    for (const n of list) {
      if (n.key === key) return n
      const hit = walk(n.children)
      if (hit) return hit
    }
    return null
  }
  const n = walk(vm.roots)
  assert.ok(n, `no node ${key}`)
  return n
}

test('a permission request inside an agent marks its row, its running item, its state sentence and its details', () => {
  const key = `a:${AGENT}`
  const vm = tree(hookMap(entry()), { selected: key })
  const n = nodeOf(vm, key)
  assert.equal(n.state, 'running')
  assert.equal(n.derived, true)
  assert.equal(n.hookWait, 'waiting for approval')
  // The marker explains the quiet: no "silent for" clock beside it.
  assert.equal(n.silence, false)
  const item = vm.runningNow.find((r) => r.key === key)
  assert.ok(item)
  assert.equal(item.hookWait, 'waiting for approval')
  assert.equal(item.silence, false)
  assert.ok(vm.selected)
  assert.equal(vm.selected.state, 'running')
  assert.ok(vm.selected.stateText.endsWith(' The agent hook reported at 11:59: waiting for approval.'), vm.selected.stateText)
  assert.ok(vm.selected.stateText.startsWith('Running — inferred:'), vm.selected.stateText)
  const rows = vm.selected.rows
  assert.deepEqual(rows[rows.length - 1], { label: 'Agent hook', value: 'waiting for approval at 11:59' })
  // The session carries none: the call named the agent.
  assert.equal(nodeOf(vm, `s:${SESSION}`).hookWait, null)
  // Without the hook, and with an empty mirror, nothing of it.
  for (const hook of [undefined, new Map<string, HookEntry>()]) {
    const plain = tree(hook, { selected: key })
    assert.equal(nodeOf(plain, key).hookWait, null)
    assert.equal(nodeOf(plain, key).silence, true)
    assert.equal(plain.selected?.rows.some((r) => r.label === 'Agent hook'), false)
    assert.equal(/agent hook/i.test(plain.selected?.stateText ?? ''), false)
  }
})

test('the marker goes with the next activity of the node, a later call without a wait, age, and a recorded end', () => {
  const key = `a:${AGENT}`
  const at = (e: HookEntry, over: Partial<AgentTreeInput> = {}, now = NOW): string | null => nodeOf(tree(hookMap(e), over, now), key).hookWait
  // Newer than the agent's last line: shown; as old or older: that line answered it.
  assert.equal(at(entry({ ts: NOW - 2 * MIN + 1 })), 'waiting for approval')
  assert.equal(at(entry({ ts: NOW - 2 * MIN })), null)
  assert.equal(at(entry({ ts: NOW - 3 * MIN })), null)
  // A stop, a start or a notification that asks nothing — the latest call — clears it.
  for (const e of [entry({ event: 'SubagentStop', wait: 'none' }), entry({ event: 'SubagentStart', wait: 'none' }),
    entry({ event: 'Notification', wait: 'none' })]) {
    assert.equal(at(e), null, e.event)
  }
  // Up to HOOK_MAX_AGE_MS old; then no longer, whatever the agent does. It keeps its state: unknown
  // after the running window, its sentence still the transcript's with the hook's after it.
  const old = entry({ ts: NOW - 2 * MIN + 1000 })
  const later = NOW - 2 * MIN + 1000 + HOOK_MAX_AGE_MS
  assert.equal(at(old, {}, later), 'waiting for approval')
  assert.equal(nodeOf(tree(hookMap(old), {}, later), key).state, 'unknown')
  assert.equal(at(old, {}, later + 1), null)
  // An agent whose end was recorded waits for nothing.
  for (const outcome of ['completed', 'failed', 'stopped'] as const) {
    const done = rec(AGENT, { outcome, outcomeTs: NOW - 90_000, outcomeStatus: outcome === 'stopped' ? 'killed' : outcome })
    assert.equal(at(entry(), { agents: [done] }), null, outcome)
  }
  // Another session's call with the same agent id is no call of this agent.
  assert.equal(at(entry({ sessionId: '00000000-0000-4000-8000-000000000000' })), null)
})

test('a call without an agent marks the session row — a wait for input only while the session is active', () => {
  const key = `s:${SESSION}`
  const permission = entry({ agentId: null })
  const input = entry({ agentId: null, event: 'Notification', wait: 'input' })
  const vm = tree(hookMap(permission), { selected: key })
  const s = nodeOf(vm, key)
  assert.equal(s.state, 'active')
  assert.equal(s.hookWait, 'waiting for approval')
  assert.equal(nodeOf(vm, `a:${AGENT}`).hookWait, null)
  assert.ok(vm.selected?.stateText.endsWith(' The agent hook reported at 11:59: waiting for approval.'), vm.selected?.stateText)
  // The details' row before the ID, which stays the last.
  const rows = vm.selected?.rows ?? []
  assert.deepEqual(rows.slice(-2).map((r) => r.label), ['Agent hook', 'ID'])
  assert.equal(nodeOf(tree(hookMap(input)), key).hookWait, 'waiting for input')
  // An idle session — its transcript quiet for more than ten minutes, no agent at work — waits
  // for input like every finished session: no marker. A permission request stays one.
  const idle = { mains: [main({ lastTs: NOW - 12 * MIN })], agents: [rec(AGENT, { lastTs: NOW - 15 * MIN })] }
  const late = (e: HookEntry): HookEntry => ({ ...e, ts: NOW - 11 * MIN })
  assert.equal(nodeOf(tree(hookMap(late(input)), idle), key).state, 'idle')
  assert.equal(nodeOf(tree(hookMap(late(input)), idle), key).hookWait, null)
  assert.equal(nodeOf(tree(hookMap(late(permission)), idle), key).hookWait, 'waiting for approval')
})

test('the marker in German, the words of the bundle', () => {
  const bundle = JSON.parse(fs.readFileSync(path.join(ROOT, 'l10n', 'bundle.l10n.de.json'), 'utf8')) as Record<string, string>
  try {
    setLocale('de')
    setBundle(bundle)
    const key = `a:${AGENT}`
    const vm = tree(hookMap(entry(), entry({ agentId: null, event: 'Notification', wait: 'input' })), { selected: key })
    assert.equal(nodeOf(vm, key).hookWait, 'wartet auf Freigabe')
    assert.equal(nodeOf(vm, `s:${SESSION}`).hookWait, 'wartet auf Eingabe')
    assert.ok(vm.selected?.stateText.endsWith(' Der Agent-Hook hat um 11:59 gemeldet: wartet auf Freigabe.'), vm.selected?.stateText)
    const rows = vm.selected?.rows ?? []
    assert.deepEqual(rows[rows.length - 1], { label: 'Agent-Hook', value: 'wartet auf Freigabe um 11:59' })
    const s = tree(hookMap(entry({ agentId: null, event: 'Notification', wait: 'input' })), { selected: `s:${SESSION}` })
    assert.ok(s.selected?.stateText.endsWith(' Der Agent-Hook hat um 11:59 gemeldet: wartet auf Eingabe.'), s.selected?.stateText)
  } finally {
    setBundle(undefined)
    setLocale(undefined)
  }
})

test('the mirror\'s entries reach the tree as the reader parses them, and nothing of a call but the marker', () => {
  const { mirror } = storage()
  hookMain(['node', 'agent-hook.js', mirror], stdin(hookInput('PermissionRequest')), NOW - MIN)
  const m = new HookMirror(mirror)
  m.refresh(NOW)
  const vm = tree(m.entries(), { selected: `a:${AGENT}` })
  assert.equal(nodeOf(vm, `a:${AGENT}`).hookWait, 'waiting for approval')
  const json = JSON.stringify(vm)
  for (const s of LEAKS) assert.equal(json.includes(s), false, s)
  // The tree never names the mirror, its fields' keys or the event.
  for (const s of [HOOK_MIRROR_NAME, 'PermissionRequest', '"wait"', 'sessionId']) assert.equal(json.includes(s), false, s)
})
