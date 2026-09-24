// SPDX-FileCopyrightText: 2026 Frederik Marx
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The bridge script runs inside somebody else's status line. These tests pin
 * the two promises that matter: the mirror is written atomically, and whatever
 * was there before us still gets its bytes and its exit code.
 */

import { strict as assert } from 'node:assert'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { test } from 'node:test'
import { claudeStateFromStatusline, readStatuslineMirror } from '../src/quota'
import {
  BRIDGE_SCRIPT_NAME, BridgeIo, bridgeMain, MIRROR_KEEP, minimalLine, narrowPayload, shellFor, SpawnResult, writeMirror,
} from '../src/statuslineBridge'
import { LEAK_SESSION_ID, LEAK_STATUS_SECRETS, leakyStatusPayload, scratchDir, writeLeakyMirror } from './fixtures/helpers'


const PAYLOAD = {
  model: { id: 'claude-opus-5', display_name: 'Opus' },
  rate_limits: {
    five_hour: { used_percentage: 25.4, resets_at: 1_700_006_400 },
    seven_day: { used_percentage: 61.2, resets_at: 1_700_438_400 },
  },
}

interface Recorder extends BridgeIo {
  out: Buffer[]
  err: Buffer[]
  spawned: Array<{ command: string; args: string[]; stdin: Buffer }>
}

function recorder(result: SpawnResult | Error = { code: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) }): Recorder {
  const out: Buffer[] = []
  const err: Buffer[] = []
  const spawned: Array<{ command: string; args: string[]; stdin: Buffer }> = []
  return {
    out,
    err,
    spawned,
    write(stream, chunk) {
      (stream === 'stdout' ? out : err).push(chunk)
    },
    spawn(command, args, stdin) {
      spawned.push({ command, args, stdin })
      return result instanceof Error ? Promise.reject(result) : Promise.resolve(result)
    },
  }
}

function text(chunks: Buffer[]): string {
  return Buffer.concat(chunks).toString('utf8')
}

test('the payload is mirrored atomically and nothing is left behind', async () => {
  const dir = scratchDir('bridgescript')
  const mirror = path.join(dir, 'nested', 'statusline-mirror.json')
  const io = recorder()

  const code = await bridgeMain(['node', 'bridge.js', mirror], Buffer.from(JSON.stringify(PAYLOAD)), io)
  assert.equal(code, 0)

  const written = JSON.parse(fs.readFileSync(mirror, 'utf8'))
  assert.equal(written.schema_version, 1)
  assert.equal(typeof written.written_at, 'number')
  assert.ok(Math.abs(Date.now() - written.written_at) < 60_000)
  assert.deepEqual(written.payload, PAYLOAD)
  assert.deepEqual(fs.readdirSync(path.dirname(mirror)), ['statusline-mirror.json'])
})

test('without a previous command the minimal line is printed', async () => {
  const dir = scratchDir('bridgescript')
  const io = recorder()
  await bridgeMain(
    ['node', 'bridge.js', path.join(dir, 'm.json')],
    Buffer.from(JSON.stringify(PAYLOAD)),
    io,
  )
  assert.equal(text(io.out), 'Opus · 5h 25% · 7d 61%\n')
  assert.equal(io.spawned.length, 0)
})

test('the previous command gets the same bytes and gives back its own', async () => {
  const dir = scratchDir('bridgescript')
  const mirror = path.join(dir, 'm.json')
  const stdin = Buffer.from(JSON.stringify(PAYLOAD))
  const io = recorder({ code: 3, stdout: Buffer.from([0xf0, 0x9f, 0x92, 0xa1, 0x0a]), stderr: Buffer.from('warn\n') })

  const code = await bridgeMain(['node', 'bridge.js', mirror, '--', 'ccstatus --color'], stdin, io)

  assert.equal(code, 3, 'the exit code is the previous command\'s')
  assert.equal(io.spawned.length, 1)
  assert.equal(io.spawned[0].stdin.equals(stdin), true, 'stdin is forwarded byte for byte')
  assert.deepEqual(Buffer.concat(io.out), Buffer.from([0xf0, 0x9f, 0x92, 0xa1, 0x0a]))
  assert.equal(text(io.err), 'warn\n')
  // The mirror is still written: it is the whole point of being in the chain.
  assert.equal(JSON.parse(fs.readFileSync(mirror, 'utf8')).payload.model.display_name, 'Opus')
})

test('the previous command is handed to a shell as the one string it always was', () => {
  assert.deepEqual(shellFor('ccstatus --color | tee /tmp/x', 'linux'), {
    command: '/bin/sh',
    args: ['-c', 'ccstatus --color | tee /tmp/x'],
  })
  const win = shellFor('ccstatus --color', 'win32')
  assert.deepEqual(win.args, ['/d', '/s', '/c', 'ccstatus --color'])
})

test('the previous command reaches the second shell byte for byte', async () => {
  const dir = scratchDir('bridgescript')
  // Quoted spaces and a quoted ';' — the two things a re-join would destroy.
  const previous = `python3 ~/.claude/sl.py --style "compact box" --label 'a; touch ${path.join(dir, 'PWNED')}'`
  const io = recorder()

  await bridgeMain(
    ['node', 'bridge.js', path.join(dir, 'm.json'), '--', previous],
    Buffer.from(JSON.stringify(PAYLOAD)),
    io,
  )

  assert.equal(io.spawned.length, 1)
  const args = io.spawned[0].args
  assert.equal(args[args.length - 1], previous, 'the command string is never re-tokenised')
})

test('anything after the single previous-command argument is ignored, not glued on', async () => {
  const dir = scratchDir('bridgescript')
  const io = recorder()
  await bridgeMain(
    ['node', 'bridge.js', path.join(dir, 'm.json'), '--', 'ccstatus', 'stray', ''],
    Buffer.from(JSON.stringify(PAYLOAD)),
    io,
  )
  const args = io.spawned[0].args
  assert.equal(args[args.length - 1], 'ccstatus')
})

test('input that is not JSON still passes through', async () => {
  const dir = scratchDir('bridgescript')
  const mirror = path.join(dir, 'm.json')
  const stdin = Buffer.from('not json at all')
  const io = recorder({ code: 0, stdout: Buffer.from('old line\n'), stderr: Buffer.alloc(0) })

  const code = await bridgeMain(['node', 'bridge.js', mirror, '--', 'ccstatus'], stdin, io)
  assert.equal(code, 0)
  assert.equal(io.spawned[0].stdin.equals(stdin), true)
  assert.equal(text(io.out), 'old line\n')
  assert.equal(fs.existsSync(mirror), false, 'nothing parsable, nothing mirrored')
})

test('a previous command that cannot be started never breaks the status line', async () => {
  const dir = scratchDir('bridgescript')
  const io = recorder(new Error('spawn ENOENT'))
  const code = await bridgeMain(
    ['node', 'bridge.js', path.join(dir, 'm.json'), '--', 'missing-command'],
    Buffer.from(JSON.stringify(PAYLOAD)),
    io,
  )
  assert.equal(code, 0)
})

test('an unwritable mirror path is survivable', async () => {
  const dir = scratchDir('bridgescript')
  const blocked = path.join(dir, 'blocker')
  fs.writeFileSync(blocked, 'not a directory')
  const io = recorder()
  const code = await bridgeMain(
    ['node', 'bridge.js', path.join(blocked, 'm.json')],
    Buffer.from(JSON.stringify(PAYLOAD)),
    io,
  )
  assert.equal(code, 0)
  assert.equal(text(io.out), 'Opus · 5h 25% · 7d 61%\n')
})

test('empty input prints nothing at all', async () => {
  const dir = scratchDir('bridgescript')
  const io = recorder()
  const code = await bridgeMain(['node', 'bridge.js', path.join(dir, 'm.json')], Buffer.alloc(0), io)
  assert.equal(code, 0)
  assert.equal(io.out.length, 0)
})

test('the minimal line omits what is missing and invents nothing', () => {
  assert.equal(minimalLine(PAYLOAD), 'Opus · 5h 25% · 7d 61%')
  assert.equal(minimalLine({ model: { display_name: 'Opus' } }), 'Opus')
  assert.equal(minimalLine({ rate_limits: { five_hour: { used_percentage: 0 } } }), '5h 0%')
  assert.equal(minimalLine({ rate_limits: { seven_day: { used_percentage: 61.2 } } }), '7d 61%')
  assert.equal(minimalLine({ model: {}, rate_limits: {} }), '')
  assert.equal(minimalLine({ rate_limits: { five_hour: { used_percentage: null } } }), '')
  assert.equal(minimalLine('nonsense'), '')
  assert.equal(minimalLine(null), '')
})

test('writeMirror replaces an existing file in one step', () => {
  const dir = scratchDir('bridgescript')
  const file = path.join(dir, 'm.json')
  writeMirror(file, { a: 1 }, 1_000)
  writeMirror(file, { a: 2 }, 2_000)
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { schema_version: 1, written_at: 2_000, payload: { a: 2 } })
  assert.deepEqual(fs.readdirSync(dir), ['m.json'])
})

// ---------------------------------------------------------------------------
// 1.8 §7a Q11: the mirror keeps only what the reader takes
// ---------------------------------------------------------------------------

test('the mirror keeps only what the extension reads: no session name, path, workspace, version or free text (1.8 Q11)', async () => {
  const dir = scratchDir('bridgescript')
  const mirror = path.join(dir, 'statusline-mirror.json')
  const now = Date.now()
  const payload = leakyStatusPayload(now)
  const stdin = Buffer.from(JSON.stringify(payload))
  const io = recorder({ code: 0, stdout: Buffer.from('previous line\n'), stderr: Buffer.alloc(0) })

  assert.equal(await bridgeMain(['node', BRIDGE_SCRIPT_NAME, mirror, '--', 'ccstatus'], stdin, io), 0)
  const text = fs.readFileSync(mirror, 'utf8')
  for (const secret of LEAK_STATUS_SECRETS) assert.equal(text.includes(secret), false, `the mirror holds ${secret}`)
  for (const key of ['session_name', 'cwd', 'transcript_path', 'workspace', 'version', 'prompt_id', 'pr', 'worktree', 'agent',
    'output_style', 'effort', 'fast_mode', 'last_miss_cause', 'miss_causes', 'caching_observed', 'total_duration_ms',
    'remaining_percentage', 'note', 'label']) {
    assert.equal(text.includes(`"${key}"`), false, `the mirror keeps the key ${key}`)
  }
  // Exactly the reader's fields, and of each block exactly the ones it takes.
  assert.deepEqual(JSON.parse(text).payload, {
    session_id: LEAK_SESSION_ID,
    model: { id: 'claude-opus-5-5', display_name: 'Opus 5.5' },
    rate_limits: {
      five_hour: { used_percentage: 44, resets_at: (payload.rate_limits as { five_hour: { resets_at: number } }).five_hour.resets_at },
      seven_day: (payload.rate_limits as { seven_day: unknown }).seven_day,
    },
    context_window: { total_input_tokens: 120_000, total_output_tokens: 8_000, context_window_size: 200_000, used_percentage: 64 },
    cost: { total_cost_usd: 1.25 },
    prompt_cache: {
      warm: true, ttl: '1h', expires_at: (payload.prompt_cache as { expires_at: number }).expires_at, hit_ratio: 0.82,
      recache_tokens_if_cold: 152_300,
    },
  })
  // The reader sees in the narrowed mirror exactly what it saw in the whole payload.
  const read = readStatuslineMirror(mirror)
  assert.deepEqual(read, claudeStateFromStatusline(payload, read.state.fetchedAt))
  // And the previous command still gets every byte Claude Code sent, the free text included.
  assert.equal(io.spawned[0].stdin.equals(stdin), true)
})

test('a wider mirror an older bridge wrote is replaced by the next write (1.8 Q11)', async () => {
  const dir = scratchDir('bridgescript')
  const mirror = path.join(dir, 'statusline-mirror.json')
  writeLeakyMirror(mirror, Date.now() - 60_000)
  assert.ok(fs.readFileSync(mirror, 'utf8').includes('SL-CWD-7c1f'), 'the fixture is not a whole payload')
  await bridgeMain(['node', BRIDGE_SCRIPT_NAME, mirror], Buffer.from(JSON.stringify(leakyStatusPayload(Date.now()))), recorder())
  const text = fs.readFileSync(mirror, 'utf8')
  for (const secret of LEAK_STATUS_SECRETS) assert.equal(text.includes(secret), false, `the mirror still holds ${secret}`)
  assert.deepEqual(fs.readdirSync(dir), ['statusline-mirror.json'])
})

test('narrowing keeps a value of the shape the reader takes and nothing else (1.8 Q11)', () => {
  // A leaf holds a string, a finite number, a boolean or null — never an object or an array.
  assert.deepEqual(narrowPayload({ session_id: { text: 'x' }, model: { id: ['a'], display_name: 'Opus' } }),
    { model: { display_name: 'Opus' } })
  // A block that is not an object is left out whole; so is a key the table does not name.
  assert.deepEqual(narrowPayload({ rate_limits: 'x', context_window: [1], cwd: '/x', prompt_cache: { warm: true, extra: 1 } }),
    { prompt_cache: { warm: true } })
  // A plan is a name or an object holding one (quota.ts `planLabel`).
  assert.deepEqual(narrowPayload({ plan: 'Max', subscription: { display_name: 'Team', seats: 3 } }),
    { plan: 'Max', subscription: { display_name: 'Team' } })
  // camelCase, as the reader takes it.
  assert.deepEqual(narrowPayload({ sessionId: 'a', rateLimits: { fiveHour: { usedPercentage: 1, junk: 2 } } }),
    { sessionId: 'a', rateLimits: { fiveHour: { usedPercentage: 1 } } })
  // A number the JSON could not carry is no value; a payload that is not an object keeps nothing.
  assert.deepEqual(narrowPayload({ cost: { total_cost_usd: Number.NaN } }), { cost: {} })
  assert.deepEqual(narrowPayload('text'), {})
  assert.deepEqual(narrowPayload([{ session_id: 'a' }]), {})
  assert.deepEqual(narrowPayload(null), {})
  // Every top-level key of the table is a key the reader picks.
  assert.deepEqual(Object.keys(MIRROR_KEEP).sort(), ['contextWindow', 'context_window', 'cost', 'model', 'plan', 'promptCache',
    'prompt_cache', 'rateLimits', 'rate_limits', 'sessionId', 'session_id', 'subscription'])
})
