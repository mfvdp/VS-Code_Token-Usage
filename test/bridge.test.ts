// SPDX-FileCopyrightText: 2026 Frederik Marx
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The installer edits a file that belongs to another program. Every test here
 * is about not making that a mistake the user has to repair by hand.
 */

import { strict as assert } from 'node:assert'
import { execFileSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { test } from 'node:test'
import {
  backupNameFor, BRIDGE_SCRIPT_NAME, BridgePaths, BRIDGE_KEY, bridgeCommand, detectShadowing, install, installBridgeScript,
  migrateBridge, migratedCommand, MIRROR_TEMP_STALE_MS, narrowMirrorFile, parseBridgeCommand, planInstall, readSettings,
  refreshBridgeScript, resolveWriteTarget, restore, ScriptFs, shellQuote, state, statusLineCommandOf,
} from '../src/bridge'
import { readStatuslineMirror } from '../src/quota'
import { MementoLike } from '../src/storage'
import { LEAK_STATUS_SECRETS, scratchDir, writeLeakyMirror } from './fixtures/helpers'

const NOW = 1_700_000_000_000
const NODE = '/usr/bin/node'
const SCRIPT = '/ext/dist/statusline-bridge.js'
const MIRROR = '/storage/statusline-mirror.json'

class FakeMemento implements MementoLike {
  store = new Map<string, unknown>()
  fail = false

  get<T>(key: string, defaultValue: T): T {
    return this.store.has(key) ? (this.store.get(key) as T) : defaultValue
  }

  update(key: string, value: unknown): PromiseLike<void> {
    if (this.fail) return Promise.reject(new Error('memento is read-only'))
    if (value === undefined) this.store.delete(key)
    else this.store.set(key, value)
    return Promise.resolve()
  }
}

/** What the shipped bundle holds in these tests — the copy has to carry exactly it. */
const BUNDLE_TEXT = '// the status-line bridge, as the extension ships it\n'

/**
 * A Claude directory, a versioned extension folder with the bundle in it, and the extension's
 * storage — 1.8 §7a Q16: the command names the copy in the storage, never the bundle.
 */
function pathsIn(dir: string): BridgePaths {
  const bundle = path.join(dir, 'extensions', 'frederik.token-pace-1.8.0', 'dist', BRIDGE_SCRIPT_NAME)
  const storage = path.join(dir, 'globalStorage', 'frederik.token-pace')
  fs.mkdirSync(path.dirname(bundle), { recursive: true })
  fs.mkdirSync(storage, { recursive: true })
  fs.writeFileSync(bundle, BUNDLE_TEXT)
  return {
    settingsFile: path.join(dir, 'settings.json'), claudeDir: dir,
    script: path.join(storage, BRIDGE_SCRIPT_NAME), bundle, mirror: MIRROR,
  }
}

const OURS = bridgeCommand(NODE, SCRIPT, MIRROR)

// ---------------------------------------------------------------------------
// readSettings
// ---------------------------------------------------------------------------

test('a missing, an empty and a broken settings file are three different answers', () => {
  const dir = scratchDir('bridge')
  const file = path.join(dir, 'settings.json')
  assert.equal(readSettings(file).kind, 'missing')

  fs.writeFileSync(file, '   \n')
  assert.equal(readSettings(file).kind, 'ok')

  fs.writeFileSync(file, '{ "statusLine": { "type": "command", ')
  const broken = readSettings(file)
  assert.equal(broken.kind, 'unparsable')

  fs.writeFileSync(file, '[1,2]')
  assert.equal(readSettings(file).kind, 'unparsable')

  fs.writeFileSync(file, '{"model":"opus","statusLine":{"type":"command","command":"mine"}}')
  const ok = readSettings(file)
  assert.equal(ok.kind, 'ok')
  assert.equal(ok.kind === 'ok' ? ok.raw.includes('"model"') : false, true)
})

// ---------------------------------------------------------------------------
// planInstall
// ---------------------------------------------------------------------------

test('preserve chains the previous command byte for byte', () => {
  const previous = { type: 'command', command: 'ccstatus --color | tee /tmp/x' }
  const plan = planInstall(
    { statusLine: previous, model: 'opus' },
    { node: NODE, script: SCRIPT, mirror: MIRROR, mode: 'preserve', platform: 'linux' },
  )
  assert.equal(plan.noop, false)
  assert.equal(plan.command, `"${NODE}" "${SCRIPT}" "${MIRROR}" -- 'ccstatus --color | tee /tmp/x'`)
  assert.deepEqual(plan.previous, previous)
  assert.deepEqual(plan.newSettings.statusLine, { type: 'command', command: plan.command })
  assert.equal((plan.newSettings as { model: string }).model, 'opus', 'other settings survive untouched')
})

test('replace and standalone install the bare command', () => {
  const previous = { type: 'command', command: 'ccstatus' }
  for (const mode of ['replace', 'standalone'] as const) {
    const plan = planInstall({ statusLine: previous }, { node: NODE, script: SCRIPT, mirror: MIRROR, mode })
    assert.equal(plan.command, OURS)
    assert.deepEqual(plan.previous, previous, 'the old value is still recorded for the undo')
  }
  const empty = planInstall({}, { node: NODE, script: SCRIPT, mirror: MIRROR, mode: 'standalone' })
  assert.equal(empty.command, OURS)
  assert.equal(empty.previous, undefined)
})

test('a slot that already runs our script is a no-op', () => {
  const plan = planInstall(
    { statusLine: { type: 'command', command: OURS } },
    { node: NODE, script: SCRIPT, mirror: MIRROR, mode: 'preserve' },
  )
  assert.equal(plan.noop, true)
  assert.equal(plan.command, OURS)
})

test('display options of the slot are carried over, the command is not', () => {
  const plan = planInstall(
    { statusLine: { type: 'command', command: 'old', padding: 0 } },
    { node: NODE, script: SCRIPT, mirror: MIRROR, mode: 'replace' },
  )
  assert.deepEqual(plan.newSettings.statusLine, { type: 'command', command: OURS, padding: 0 })
})

test('a status line that is not a command entry is recorded but not chained', () => {
  const previous = { type: 'static', text: 'hello' }
  const plan = planInstall({ statusLine: previous }, { node: NODE, script: SCRIPT, mirror: MIRROR, mode: 'preserve' })
  assert.equal(plan.command, OURS)
  assert.deepEqual(plan.previous, previous)
  assert.equal(statusLineCommandOf(previous), null)
})

test('the previous command travels as exactly one quoted argument', () => {
  assert.equal(shellQuote('ccstatus --color', 'linux'), "'ccstatus --color'")
  assert.equal(shellQuote("echo 'literal $(rm -rf x)'", 'linux'), "'echo '\\''literal $(rm -rf x)'\\'''")
  assert.equal(shellQuote('', 'linux'), "''")
  assert.equal(shellQuote('sl.py --style "compact box"', 'win32'), '"sl.py --style ""compact box"""')
  assert.equal(shellQuote('a & b | c < d > e ^ f', 'win32'), '"a ^& b ^| c ^< d ^> e ^^ f"')
})

test('a shell tokenising our command hands the script the original command back', (t) => {
  if (process.platform === 'win32') {
    t.skip('the POSIX quoting is asserted on POSIX; the cmd.exe form is unit-tested above')
    return
  }
  const dir = scratchDir('bridge')
  // Stands in for the bridge script: prints the argv it was actually given.
  const script = path.join(dir, 'argv.js')
  fs.writeFileSync(script, 'process.stdout.write(JSON.stringify(process.argv.slice(2)))\n')
  const marker = path.join(dir, 'PWNED')
  const previous = `python3 sl.py --style "compact box" --label 'a; touch ${marker}'`

  const command = bridgeCommand(process.execPath, script, MIRROR, previous, 'linux')
  const argv = JSON.parse(execFileSync('/bin/sh', ['-c', command], { encoding: 'utf8' })) as string[]

  assert.deepEqual(argv, [MIRROR, '--', previous], 'quoting, spaces and the ";" all survive')
  assert.equal(fs.existsSync(marker), false, 'a quoted metacharacter never becomes live syntax')
})

test('the backup name survives a Windows file system', () => {
  const name = backupNameFor('/home/t/.claude/settings.json', NOW)
  assert.ok(name.startsWith('/home/t/.claude/settings.json.token-pace-backup-'))
  assert.ok(!path.basename(name).includes(':'))
})

// ---------------------------------------------------------------------------
// install
// ---------------------------------------------------------------------------

function opts(memento: FakeMemento, over: Partial<Parameters<typeof install>[1]> = {}) {
  return {
    mode: 'preserve' as const,
    restricted: false,
    memento,
    now: NOW,
    resolveNode: () => Promise.resolve(NODE as string | null),
    ...over,
  }
}

test('a full install writes the settings, a backup and the undo record', async () => {
  const dir = scratchDir('bridge')
  const paths = pathsIn(dir)
  fs.writeFileSync(paths.settingsFile, '{\n  "statusLine": { "type": "command", "command": "ccstatus" }\n}\n')
  const memento = new FakeMemento()

  const result = await install(paths, opts(memento), () => Promise.resolve(true))
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.equal(result.status, 'installed')
  assert.equal(result.shadowed, 'none')

  const written = JSON.parse(fs.readFileSync(paths.settingsFile, 'utf8'))
  // 1.8 §7a Q16 (pinned and changed): the command names the copy in the extension's storage.
  assert.equal(written.statusLine.command, bridgeCommand(NODE, paths.script, MIRROR, 'ccstatus'))
  assert.equal(fs.readFileSync(paths.script, 'utf8'), BUNDLE_TEXT, 'the copy the command names was not written')
  assert.equal(written.statusLine.command.includes(paths.bundle), false, 'the command names the versioned extension folder')

  assert.ok(result.backup !== null)
  assert.match(fs.readFileSync(result.backup as string, 'utf8'), /"command": "ccstatus"/)

  const record = memento.get<{ installedCommand: string; previous: unknown } | undefined>(BRIDGE_KEY, undefined)
  assert.equal(record?.installedCommand, written.statusLine.command)
  assert.deepEqual(record?.previous, { type: 'command', command: 'ccstatus' })
  assert.equal(fs.existsSync(`${paths.settingsFile}.token-pace.tmp`), false)
})

test('an unparsable settings file is refused before anything is asked', async () => {
  const dir = scratchDir('bridge')
  const paths = pathsIn(dir)
  const broken = '{ "statusLine": '
  fs.writeFileSync(paths.settingsFile, broken)
  let asked = false

  const result = await install(paths, opts(new FakeMemento()), () => { asked = true; return Promise.resolve(true) })
  assert.equal(result.ok, false)
  assert.equal(result.ok === false ? result.reason : '', 'unparsable')
  assert.equal(asked, false)
  assert.equal(fs.readFileSync(paths.settingsFile, 'utf8'), broken)
})

test('restricted mode and a refused consent both leave the file alone', async () => {
  const dir = scratchDir('bridge')
  const paths = pathsIn(dir)
  fs.writeFileSync(paths.settingsFile, '{}')

  const restricted = await install(paths, opts(new FakeMemento(), { restricted: true }), () => Promise.resolve(true))
  assert.equal(restricted.ok === false ? restricted.reason : '', 'restricted')

  const declined = await install(paths, opts(new FakeMemento()), () => Promise.resolve(false))
  assert.equal(declined.ok === false ? declined.reason : '', 'consent')
  assert.equal(fs.readFileSync(paths.settingsFile, 'utf8'), '{}')
})

test('without node on PATH the install explains itself instead of writing', async () => {
  const dir = scratchDir('bridge')
  const paths = pathsIn(dir)
  fs.writeFileSync(paths.settingsFile, '{}')
  const result = await install(
    paths, opts(new FakeMemento(), { resolveNode: () => Promise.resolve(null) }), () => Promise.resolve(true),
  )
  assert.equal(result.ok === false ? result.reason : '', 'noNode')
  assert.match(result.ok === false ? result.message : '', /PATH/)
  assert.equal(fs.readFileSync(paths.settingsFile, 'utf8'), '{}')
})

test('a second install is a no-op, not a second backup', async () => {
  const dir = scratchDir('bridge')
  const paths = pathsIn(dir)
  fs.writeFileSync(paths.settingsFile, '{}')
  const memento = new FakeMemento()
  await install(paths, opts(memento), () => Promise.resolve(true))
  const before = fs.readdirSync(dir).length

  const again = await install(paths, opts(memento), () => Promise.resolve(true))
  assert.equal(again.ok === true ? again.status : '', 'already')
  assert.equal(fs.readdirSync(dir).length, before)
})

test('an install that cannot be recorded is rolled back', async () => {
  const dir = scratchDir('bridge')
  const paths = pathsIn(dir)
  const original = '{\n  "statusLine": { "type": "command", "command": "ccstatus" }\n}\n'
  fs.writeFileSync(paths.settingsFile, original)
  const memento = new FakeMemento()
  memento.fail = true

  const result = await install(paths, opts(memento), () => Promise.resolve(true))
  assert.equal(result.ok === false ? result.reason : '', 'writeFailed')
  assert.equal(fs.readFileSync(paths.settingsFile, 'utf8'), original)
})

// ---------------------------------------------------------------------------
// restore
// ---------------------------------------------------------------------------

test('restore puts back the exact previous value', async () => {
  const dir = scratchDir('bridge')
  const paths = pathsIn(dir)
  const previous = { type: 'command', command: 'ccstatus --color', padding: 1 }
  fs.writeFileSync(paths.settingsFile, JSON.stringify({ statusLine: previous, model: 'opus' }))
  const memento = new FakeMemento()

  await install(paths, opts(memento), () => Promise.resolve(true))
  const result = await restore(paths, memento)
  assert.deepEqual(result, { ok: true, restored: 'previous' })

  const after = JSON.parse(fs.readFileSync(paths.settingsFile, 'utf8'))
  assert.deepEqual(after.statusLine, previous)
  assert.equal(after.model, 'opus')
  assert.equal(memento.store.has(BRIDGE_KEY), false)
})

test('restore removes the key when there was nothing before', async () => {
  const dir = scratchDir('bridge')
  const paths = pathsIn(dir)
  fs.writeFileSync(paths.settingsFile, '{"model":"opus"}')
  const memento = new FakeMemento()
  await install(paths, opts(memento, { mode: 'standalone' }), () => Promise.resolve(true))

  assert.deepEqual(await restore(paths, memento), { ok: true, restored: 'removed' })
  const after = JSON.parse(fs.readFileSync(paths.settingsFile, 'utf8'))
  assert.equal('statusLine' in after, false)
  assert.equal(after.model, 'opus')
})

test('restore refuses when the slot has been taken over since', async () => {
  const dir = scratchDir('bridge')
  const paths = pathsIn(dir)
  fs.writeFileSync(paths.settingsFile, '{}')
  const memento = new FakeMemento()
  await install(paths, opts(memento, { mode: 'standalone' }), () => Promise.resolve(true))

  const foreign = { statusLine: { type: 'command', command: 'someone-else' } }
  fs.writeFileSync(paths.settingsFile, JSON.stringify(foreign))

  const result = await restore(paths, memento)
  assert.equal(result.ok, false)
  assert.equal(result.ok === false ? result.reason : '', 'changed')
  assert.deepEqual(JSON.parse(fs.readFileSync(paths.settingsFile, 'utf8')), foreign)
  assert.equal(memento.store.has(BRIDGE_KEY), true, 'the record survives so a later attempt can still explain')
})

test('restore without an install record changes nothing', async () => {
  const dir = scratchDir('bridge')
  const result = await restore(pathsIn(dir), new FakeMemento())
  assert.equal(result.ok === false ? result.reason : '', 'notInstalled')
})

// ---------------------------------------------------------------------------
// shadowing and state
// ---------------------------------------------------------------------------

test('a local or managed status line shadows ours', () => {
  const dir = scratchDir('bridge')
  assert.equal(detectShadowing(dir, []), 'none')

  fs.writeFileSync(path.join(dir, 'settings.local.json'), '{"model":"opus"}')
  assert.equal(detectShadowing(dir, []), 'none', 'a local file without a status line is not shadowing')

  fs.writeFileSync(path.join(dir, 'settings.local.json'), '{"statusLine":{"type":"command","command":"x"}}')
  assert.equal(detectShadowing(dir, []), 'configuration-shadowed')

  const managed = path.join(dir, 'managed-settings.json')
  fs.writeFileSync(managed, '{"statusLine":{"type":"command","command":"y"}}')
  assert.equal(detectShadowing(scratchDir('bridge'), [managed]), 'configuration-shadowed')
})

test('state answers installed, shadowed and mirror age', async () => {
  const dir = scratchDir('bridge')
  const paths = { ...pathsIn(dir), mirror: path.join(dir, 'statusline-mirror.json') }
  fs.writeFileSync(paths.settingsFile, '{}')
  const memento = new FakeMemento()

  const before = state(paths, memento, NOW)
  assert.deepEqual(before, { installed: false, shadowed: false, mirrorAgeMs: null })

  await install(paths, opts(memento, { mode: 'standalone' }), () => Promise.resolve(true))
  fs.writeFileSync(paths.mirror, '{}')
  const after = state(paths, memento, Date.now())
  assert.equal(after.installed, true)
  assert.ok(after.mirrorAgeMs !== null && after.mirrorAgeMs < 60_000)
})

// ---------------------------------------------------------------------------
// symlinked settings.json (dotfiles)
// ---------------------------------------------------------------------------

test('a symlinked settings.json is written through, not replaced', async (t) => {
  const dir = scratchDir('bridge')
  const real = path.join(dir, 'dotfiles', 'settings.json')
  fs.mkdirSync(path.dirname(real), { recursive: true })
  fs.writeFileSync(real, '{\n  "statusLine": { "type": "command", "command": "ccstatus" }\n}\n')
  const link = path.join(dir, 'settings.json')
  try {
    fs.symlinkSync(real, link)
  } catch {
    t.skip('this file system does not do symlinks')
    return
  }
  const paths: BridgePaths = { ...pathsIn(dir), settingsFile: link }
  const memento = new FakeMemento()

  const result = await install(paths, opts(memento), () => Promise.resolve(true))
  assert.equal(result.ok, true)
  assert.equal(fs.lstatSync(link).isSymbolicLink(), true, 'the link is still a link')
  assert.equal(
    JSON.parse(fs.readFileSync(real, 'utf8')).statusLine.command,
    bridgeCommand(NODE, paths.script, MIRROR, 'ccstatus'),
    'the dotfiles source itself was updated',
  )
  // The backup lands next to the real file, so it is a sibling of what it backs up.
  assert.equal(
    path.dirname(fs.realpathSync(result.ok === true ? (result.backup as string) : link)),
    fs.realpathSync(path.dirname(real)),
  )

  assert.deepEqual(await restore(paths, memento), { ok: true, restored: 'previous' })
  assert.equal(fs.lstatSync(link).isSymbolicLink(), true, 'disconnecting keeps the link too')
  assert.deepEqual(
    JSON.parse(fs.readFileSync(real, 'utf8')).statusLine,
    { type: 'command', command: 'ccstatus' },
  )
})

test('a link whose target is gone is refused with an explanation', async (t) => {
  const dir = scratchDir('bridge')
  const link = path.join(dir, 'settings.json')
  try {
    fs.symlinkSync(path.join(dir, 'nowhere', 'settings.json'), link)
  } catch {
    t.skip('this file system does not do symlinks')
    return
  }
  const resolved = resolveWriteTarget(link)
  assert.equal(resolved.ok, false)
  assert.match(resolved.ok === false ? resolved.message : '', /left untouched/)

  const result = await install(
    { ...pathsIn(dir), settingsFile: link },
    opts(new FakeMemento()),
    () => Promise.resolve(true),
  )
  assert.equal(result.ok, false)
  assert.equal(result.ok === false ? result.reason : '', 'writeFailed')
  assert.equal(fs.lstatSync(link).isSymbolicLink(), true, 'nothing was created in the link place')
})

test('a settings file that is not there yet is written where we were told', () => {
  const dir = scratchDir('bridge')
  const file = path.join(dir, 'settings.json')
  assert.deepEqual(resolveWriteTarget(file), { ok: true, file })
})

// ---------------------------------------------------------------------------
// 1.8 §7a Q16: the script's copy in the extension's storage, and the move of an older command to it
// ---------------------------------------------------------------------------

/** The command a 1.3–1.7 install wrote: the script inside the versioned extension folder. */
function oldCommand(dir: string, previous: string | null = 'ccstatus --style "compact box"'): string {
  const folder = path.join(dir, 'extensions', 'frederik.token-pace-1.7.0', 'dist', BRIDGE_SCRIPT_NAME)
  return bridgeCommand(NODE, folder, MIRROR, previous, 'linux')
}

/**
 * A settings.json as a user keeps it — other keys, a nested block, an entry with a display key of
 * its own and hand-made formatting — with an older install's command in the slot, and the record
 * that install left.
 */
function oldInstall(dir: string, paths: BridgePaths, command = oldCommand(dir)): { raw: string; memento: FakeMemento; previous: unknown } {
  const previous = { type: 'command', command: 'ccstatus --style "compact box"', padding: 2 }
  const raw = [
    '{',
    '    "model": "opus",',
    '    "hooks": { "Notification": [ { "hooks": [ { "type": "command", "command": "notify-send hi" } ] } ] },',
    `    "statusLine": { "type": "command", "command": ${JSON.stringify(command)}, "padding": 2 },`,
    '    "env": { "A": "1" }',
    '}',
    '',
  ].join('\n')
  fs.writeFileSync(paths.settingsFile, raw)
  const memento = new FakeMemento()
  memento.store.set(BRIDGE_KEY, { previous, installedCommand: command, at: NOW - 86_400_000 })
  return { raw, memento, previous }
}

test('a command the bridge wrote is taken apart into its three paths and the chained command, verbatim (1.8 Q16)', () => {
  const previous = `python3 sl.py --style "compact box" --label 'a; b'`
  const command = bridgeCommand(NODE, '/ext/token-pace-1.7.0/dist/statusline-bridge.js', MIRROR, previous, 'linux')
  assert.deepEqual(parseBridgeCommand(command), {
    node: NODE, script: '/ext/token-pace-1.7.0/dist/statusline-bridge.js', mirror: MIRROR,
    rest: ` -- ${shellQuote(previous, 'linux')}`,
  })
  assert.deepEqual(parseBridgeCommand(OURS)?.rest, '')
  // Moved: only the script's path changes; the chained command stays byte for byte, on both platforms.
  assert.equal(migratedCommand(command, '/storage/statusline-bridge.js'),
    bridgeCommand(NODE, '/storage/statusline-bridge.js', MIRROR, previous, 'linux'))
  const win = bridgeCommand('C:\\node\\node.exe', 'C:\\Users\\u\\.vscode\\extensions\\frederik.token-pace-1.7.0\\dist\\statusline-bridge.js',
    'C:\\gs\\statusline-mirror.json', 'sl.cmd --a "b" & c', 'win32')
  assert.equal(migratedCommand(win, 'C:\\gs\\statusline-bridge.js'),
    bridgeCommand('C:\\node\\node.exe', 'C:\\gs\\statusline-bridge.js', 'C:\\gs\\statusline-mirror.json', 'sl.cmd --a "b" & c', 'win32'))
  // Nothing to move: a command that names the copy already, somebody else's command, another script.
  assert.equal(migratedCommand(bridgeCommand(NODE, '/storage/statusline-bridge.js', MIRROR), '/storage/statusline-bridge.js'), null)
  assert.equal(migratedCommand('ccstatus --color', '/storage/statusline-bridge.js'), null)
  assert.equal(migratedCommand(bridgeCommand(NODE, '/opt/other/script.js', MIRROR), '/storage/statusline-bridge.js'), null)
  assert.equal(parseBridgeCommand('node /opt/token-pace/dist/statusline-bridge.js'), null)
})

test('an install whose bundle is missing writes nothing at all (1.8 Q16)', async () => {
  const dir = scratchDir('bridge')
  const paths = pathsIn(dir)
  fs.rmSync(paths.bundle)
  fs.writeFileSync(paths.settingsFile, '{"model":"opus"}')
  const memento = new FakeMemento()
  const result = await install(paths, opts(memento), () => Promise.resolve(true))
  assert.equal(result.ok === false ? result.reason : '', 'writeFailed')
  assert.equal(fs.readFileSync(paths.settingsFile, 'utf8'), '{"model":"opus"}')
  assert.equal(fs.existsSync(paths.script), false)
  assert.equal(memento.store.has(BRIDGE_KEY), false)
  assert.deepEqual(fs.readdirSync(path.dirname(paths.script)), [], 'a temp file of the copy was left behind')
})

test('an older install\'s command is moved to the copy once: only statusLine.command changes, with a backup and the record (1.8 Q16)', async () => {
  const dir = scratchDir('bridge')
  const paths = pathsIn(dir)
  const { raw, memento, previous } = oldInstall(dir, paths)
  const before = JSON.parse(raw) as Record<string, unknown>
  const old = oldCommand(dir)
  // Before the move the state says what is true: the command names a folder that is not there.
  assert.equal(state(paths, memento, NOW).installed, false, 'a command whose script is gone reads as installed')

  const logs: string[] = []
  const moved = await migrateBridge(paths, memento, { restricted: false, now: NOW, log: (m) => logs.push(m) })
  assert.equal(moved.kind, 'migrated')
  const next = bridgeCommand(NODE, paths.script, MIRROR, 'ccstatus --style "compact box"', 'linux')
  const after = JSON.parse(fs.readFileSync(paths.settingsFile, 'utf8')) as Record<string, unknown>
  // Only the one string changed — every other key of the file and of the entry is as it was, and
  // so is every other byte of the file: its indentation, its key order, its one-line hooks block.
  assert.deepEqual(after, { ...before, statusLine: { type: 'command', command: next, padding: 2 } })
  assert.equal(fs.readFileSync(paths.settingsFile, 'utf8'), raw.replace(JSON.stringify(old), JSON.stringify(next)))
  assert.equal(fs.readFileSync(paths.script, 'utf8'), BUNDLE_TEXT)
  // The backup holds the original bytes, formatting and all.
  const backup = moved.kind === 'migrated' ? moved.backup : null
  assert.equal(backup, backupNameFor(paths.settingsFile, NOW))
  assert.equal(fs.readFileSync(backup as string, 'utf8'), raw)
  // The record names the copy; the undo value and the install time are the install's.
  assert.deepEqual(memento.store.get(BRIDGE_KEY), { previous, installedCommand: next, at: NOW - 86_400_000 })
  assert.equal(state(paths, memento, NOW).installed, true)
  assert.equal(logs.length, 1)
  assert.ok(logs[0].includes(paths.script) && logs[0].includes(parseBridgeCommand(old)?.script as string), logs[0])
  assert.equal(logs[0].includes('ccstatus'), false, 'the log line quotes the chained command')

  // Exactly once: the next activation finds the copy named and writes nothing.
  const files = fs.readdirSync(dir).sort()
  const bytes = fs.readFileSync(paths.settingsFile, 'utf8')
  const again = await migrateBridge(paths, memento, { restricted: false, now: NOW + 60_000, log: (m) => logs.push(m) })
  assert.deepEqual(again, { kind: 'current', copied: false })
  assert.deepEqual(fs.readdirSync(dir).sort(), files, 'a second move wrote a second backup')
  assert.equal(fs.readFileSync(paths.settingsFile, 'utf8'), bytes)
  assert.equal(logs.length, 1)

  // Disconnecting afterwards restores the entry of before the install, as ever.
  assert.deepEqual(await restore(paths, memento), { ok: true, restored: 'previous' })
  assert.deepEqual((JSON.parse(fs.readFileSync(paths.settingsFile, 'utf8')) as { statusLine: unknown }).statusLine, previous)
})

test('where the old command stands twice in the file\'s text the move re-serialises it, the values unchanged (1.8 Q16)', async () => {
  const dir = scratchDir('bridge')
  const paths = pathsIn(dir)
  const { memento } = oldInstall(dir, paths)
  const old = oldCommand(dir)
  // The same string once more, under a key of the user's: a text swap could hit either.
  const settings = JSON.parse(fs.readFileSync(paths.settingsFile, 'utf8')) as Record<string, unknown>
  const raw = JSON.stringify({ notes: old, ...settings }, null, 4)
  fs.writeFileSync(paths.settingsFile, raw)
  const moved = await migrateBridge(paths, memento, { restricted: false, now: NOW })
  assert.equal(moved.kind, 'migrated')
  const next = migratedCommand(old, paths.script)
  const after = JSON.parse(fs.readFileSync(paths.settingsFile, 'utf8')) as Record<string, unknown>
  assert.deepEqual(after, { notes: old, ...settings, statusLine: { type: 'command', command: next, padding: 2 } })
  assert.deepEqual(Object.keys(after), ['notes', 'model', 'hooks', 'statusLine', 'env'], 'the key order changed')
  assert.equal(fs.readFileSync(moved.kind === 'migrated' ? moved.backup as string : '', 'utf8'), raw)
})

test('nothing is moved without a record, over a third party\'s command, into a file that does not parse, or in Restricted Mode (1.8 Q16)', async () => {
  const cases: Array<[string, (dir: string, paths: BridgePaths) => { memento: FakeMemento; restricted?: boolean }, string]> = [
    ['no record', (dir, paths) => { oldInstall(dir, paths); return { memento: new FakeMemento() } }, 'none'],
    ['a third party took the slot', (dir, paths) => {
      const { memento } = oldInstall(dir, paths, 'someone-else --flag')
      memento.store.set(BRIDGE_KEY, { previous: undefined, installedCommand: oldCommand(dir), at: NOW })
      return { memento }
    }, 'none'],
    // The slot holds a bridge of another profile — a command Token Pace did not record here.
    ['another profile\'s bridge', (dir, paths) => {
      const { memento } = oldInstall(dir, paths, bridgeCommand(NODE, path.join(dir, 'other', BRIDGE_SCRIPT_NAME), '/other/mirror.json'))
      memento.store.set(BRIDGE_KEY, { previous: undefined, installedCommand: oldCommand(dir), at: NOW })
      return { memento }
    }, 'none'],
    ['unparsable', (dir, paths) => {
      const { memento } = oldInstall(dir, paths)
      fs.writeFileSync(paths.settingsFile, '{ "statusLine": ')
      return { memento }
    }, 'none'],
    ['restricted', (dir, paths) => ({ memento: oldInstall(dir, paths).memento, restricted: true }), 'restricted'],
  ]
  for (const [what, arrange, kind] of cases) {
    const dir = scratchDir('bridge')
    const paths = pathsIn(dir)
    const { memento, restricted } = arrange(dir, paths)
    const bytes = fs.readFileSync(paths.settingsFile, 'utf8')
    const files = fs.readdirSync(dir).sort()
    const record = JSON.stringify(memento.store.get(BRIDGE_KEY))
    const moved = await migrateBridge(paths, memento, { restricted: restricted === true, now: NOW })
    assert.equal(moved.kind, kind, what)
    assert.equal(fs.readFileSync(paths.settingsFile, 'utf8'), bytes, `${what}: settings.json was written`)
    assert.deepEqual(fs.readdirSync(dir).sort(), files, `${what}: a backup was written`)
    assert.equal(fs.existsSync(paths.script), false, `${what}: the copy was made`)
    assert.equal(JSON.stringify(memento.store.get(BRIDGE_KEY)), record, `${what}: the record changed`)
  }
})

test('a move another window made is followed by this window\'s record alone (1.8 Q16)', async () => {
  const dir = scratchDir('bridge')
  const paths = pathsIn(dir)
  const { memento } = oldInstall(dir, paths)
  const next = migratedCommand(oldCommand(dir), paths.script) as string
  // The other window has moved the command already; this one still holds the old record.
  const settings = JSON.parse(fs.readFileSync(paths.settingsFile, 'utf8')) as { statusLine: Record<string, unknown> }
  settings.statusLine.command = next
  fs.writeFileSync(paths.settingsFile, JSON.stringify(settings))
  installBridgeScript(paths.bundle, paths.script)
  const bytes = fs.readFileSync(paths.settingsFile, 'utf8')
  assert.deepEqual(await migrateBridge(paths, memento, { restricted: false, now: NOW }), { kind: 'recorded' })
  assert.equal(fs.readFileSync(paths.settingsFile, 'utf8'), bytes)
  assert.equal((memento.store.get(BRIDGE_KEY) as { installedCommand: string }).installedCommand, next)
  assert.equal(state(paths, memento, NOW).installed, true)
})

test('a move that cannot be recorded puts settings.json back (1.8 Q16)', async () => {
  const dir = scratchDir('bridge')
  const paths = pathsIn(dir)
  const { raw, memento } = oldInstall(dir, paths)
  memento.fail = true
  const moved = await migrateBridge(paths, memento, { restricted: false, now: NOW })
  assert.equal(moved.kind, 'failed')
  assert.equal(fs.readFileSync(paths.settingsFile, 'utf8'), raw)
})

test('a copy the current command names that went missing is put back; the state follows the script (1.8 Q16)', async () => {
  const dir = scratchDir('bridge')
  const paths = pathsIn(dir)
  fs.writeFileSync(paths.settingsFile, '{}')
  const memento = new FakeMemento()
  await install(paths, opts(memento, { mode: 'standalone' }), () => Promise.resolve(true))
  assert.equal(state(paths, memento, NOW).installed, true)
  fs.rmSync(paths.script)
  assert.equal(state(paths, memento, NOW).installed, false, 'the state reads the command string alone')
  const bytes = fs.readFileSync(paths.settingsFile, 'utf8')
  assert.deepEqual(await migrateBridge(paths, memento, { restricted: false, now: NOW }), { kind: 'current', copied: true })
  assert.equal(fs.readFileSync(paths.script, 'utf8'), BUNDLE_TEXT)
  assert.equal(fs.readFileSync(paths.settingsFile, 'utf8'), bytes, 'settings.json was written for a copy')
  assert.equal(state(paths, memento, NOW).installed, true)
  // An older command whose folder is still there runs — and says so until it is moved.
  const other = scratchDir('bridge')
  const p2 = pathsIn(other)
  const { memento: m2 } = oldInstall(other, p2)
  const folder = parseBridgeCommand(oldCommand(other))?.script as string
  fs.mkdirSync(path.dirname(folder), { recursive: true })
  fs.writeFileSync(folder, BUNDLE_TEXT)
  assert.equal(state(p2, m2, NOW).installed, true)
})

test('a reconnect over the command an older install wrote moves it instead of chaining it (1.8 Q16)', async () => {
  const dir = scratchDir('bridge')
  const paths = pathsIn(dir)
  const { memento } = oldInstall(dir, paths)
  const result = await install(paths, opts(memento), () => Promise.resolve(true))
  assert.equal(result.ok === true ? result.status : '', 'already')
  const command = (JSON.parse(fs.readFileSync(paths.settingsFile, 'utf8')) as { statusLine: { command: string } }).statusLine.command
  assert.equal(command, bridgeCommand(NODE, paths.script, MIRROR, 'ccstatus --style "compact box"', 'linux'))
  assert.equal(command.split(BRIDGE_SCRIPT_NAME).length, 2, 'a second bridge was chained into the first')
  assert.equal((memento.store.get(BRIDGE_KEY) as { installedCommand: string }).installedCommand, command)
})

/** A copy's file operations over a real directory, with one of them broken on request. */
function brokenFs(fail: 'rename' | null): ScriptFs & { calls: string[] } {
  const calls: string[] = []
  return {
    calls,
    statSync: (f) => fs.statSync(f),
    readFileSync: (f) => fs.readFileSync(f),
    copyFileSync: (a, b) => { calls.push(`copy ${path.basename(b)}`); fs.copyFileSync(a, b) },
    renameSync: (a, b) => {
      calls.push(`rename ${path.basename(b)}`)
      if (fail === 'rename') throw Object.assign(new Error('EXDEV'), { code: 'EXDEV' })
      fs.renameSync(a, b)
    },
    unlinkSync: (f) => { calls.push(`unlink ${path.basename(f)}`); fs.unlinkSync(f) },
  }
}

test('the copy is refreshed when it differs from the shipped script, and never made by the refresh (1.8 Q16)', () => {
  const dir = scratchDir('bridge')
  const paths = pathsIn(dir)
  // No copy: the refresh makes none — only an install or a move does.
  assert.equal(refreshBridgeScript(paths.bundle, paths.script), false)
  assert.equal(fs.existsSync(paths.script), false)
  // The same bytes: nothing to do, whatever the times say.
  installBridgeScript(paths.bundle, paths.script)
  const past = new Date(NOW - 3_600_000)
  fs.utimesSync(paths.script, past, past)
  assert.equal(refreshBridgeScript(paths.bundle, paths.script), false)
  // Another size, and the same size with another byte: replaced by the shipped script.
  fs.writeFileSync(paths.script, '// an older bridge\n')
  assert.equal(refreshBridgeScript(paths.bundle, paths.script), true)
  assert.equal(fs.readFileSync(paths.script, 'utf8'), BUNDLE_TEXT)
  fs.writeFileSync(paths.script, BUNDLE_TEXT.replace('the', 'THE'))
  assert.equal(refreshBridgeScript(paths.bundle, paths.script), true)
  assert.equal(fs.readFileSync(paths.script, 'utf8'), BUNDLE_TEXT)
  // A missing bundle refreshes nothing and throws nothing.
  fs.writeFileSync(paths.script, '// an older bridge\n')
  fs.rmSync(paths.bundle)
  assert.equal(refreshBridgeScript(paths.bundle, paths.script), false)
  assert.equal(fs.readFileSync(paths.script, 'utf8'), '// an older bridge\n')
})

test('the copy is written through a temp file and a rename; a failed rename leaves neither behind (1.8 Q16)', () => {
  const dir = scratchDir('bridge')
  const paths = pathsIn(dir)
  const ok = brokenFs(null)
  installBridgeScript(paths.bundle, paths.script, ok)
  assert.deepEqual(ok.calls, [`copy ${BRIDGE_SCRIPT_NAME}.${process.pid}.tmp`, `rename ${BRIDGE_SCRIPT_NAME}`])
  fs.rmSync(paths.script)
  const bad = brokenFs('rename')
  assert.throws(() => installBridgeScript(paths.bundle, paths.script, bad), /EXDEV/)
  assert.deepEqual(fs.readdirSync(path.dirname(paths.script)), [])
})

// ---------------------------------------------------------------------------
// 1.8 §7a Q11: a mirror an older script wrote whole, narrowed at activation
// ---------------------------------------------------------------------------

test('a mirror of the whole payload is narrowed to what the reader takes, its time kept; the reading does not change (1.8 Q11)', () => {
  const dir = scratchDir('bridge')
  const file = path.join(dir, 'statusline-mirror.json')
  assert.equal(narrowMirrorFile(file, NOW), 'absent')
  writeLeakyMirror(file, NOW - 60_000, NOW)
  const mtime = new Date(NOW - 50_000)
  fs.utimesSync(file, mtime, mtime)
  const reading = readStatuslineMirror(file)
  assert.equal(narrowMirrorFile(file, NOW), 'narrowed')
  const text = fs.readFileSync(file, 'utf8')
  for (const secret of LEAK_STATUS_SECRETS) assert.equal(text.includes(secret), false, `the mirror still holds ${secret}`)
  const doc = JSON.parse(text) as { schema_version: number; written_at: number; payload: Record<string, unknown> }
  assert.deepEqual(Object.keys(doc).sort(), ['payload', 'schema_version', 'written_at'])
  assert.equal(doc.written_at, NOW - 60_000)
  assert.deepEqual(Object.keys(doc.payload).sort(),
    ['context_window', 'cost', 'model', 'prompt_cache', 'rate_limits', 'session_id'])
  assert.equal(fs.statSync(file).mtimeMs, mtime.getTime(), 'the mirror\'s age changed')
  assert.deepEqual(readStatuslineMirror(file), reading)
  // Narrowed once: the next activation leaves it alone, bytes and time.
  assert.equal(narrowMirrorFile(file, NOW + 1_000), 'unchanged')
  assert.equal(fs.readFileSync(file, 'utf8'), text)
  assert.deepEqual(fs.readdirSync(dir), ['statusline-mirror.json'])
})

test('a mirror that cannot be read is deleted; stale temp files of a whole payload go, a write in flight stays (1.8 Q11)', () => {
  for (const body of ['{ "schema_version": 1, "payl', '[1,2]', JSON.stringify({ schema_version: 2, written_at: NOW, payload: {} }),
    JSON.stringify({ schema_version: 1, payload: { session_id: 'x' } }), JSON.stringify({ schema_version: 1, written_at: NOW, payload: 'x' })]) {
    const dir = scratchDir('bridge')
    const file = path.join(dir, 'statusline-mirror.json')
    fs.writeFileSync(file, body)
    assert.equal(narrowMirrorFile(file, NOW), 'deleted', body)
    assert.equal(fs.existsSync(file), false, body)
  }
  const dir = scratchDir('bridge')
  const file = path.join(dir, 'statusline-mirror.json')
  const stale = `${file}.4821.tmp`
  const fresh = `${file}.4822.tmp`
  writeLeakyMirror(stale, NOW)
  writeLeakyMirror(fresh, NOW)
  const old = new Date(NOW - MIRROR_TEMP_STALE_MS - 1_000)
  fs.utimesSync(stale, old, old)
  const young = new Date(NOW - 1_000)
  fs.utimesSync(fresh, young, young)
  fs.writeFileSync(path.join(dir, 'other.json.tmp'), 'not ours')
  assert.equal(narrowMirrorFile(file, NOW), 'absent')
  assert.deepEqual(fs.readdirSync(dir).sort(), ['other.json.tmp', path.basename(fresh)])
})
