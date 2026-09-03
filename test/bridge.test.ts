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
  backupNameFor, BridgePaths, BRIDGE_KEY, bridgeCommand, detectShadowing, install, planInstall,
  readSettings, resolveWriteTarget, restore, shellQuote, state, statusLineCommandOf,
} from '../src/bridge'
import { MementoLike } from '../src/storage'
import { scratchDir } from './fixtures/helpers'

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

function pathsIn(dir: string): BridgePaths {
  return { settingsFile: path.join(dir, 'settings.json'), claudeDir: dir, script: SCRIPT, mirror: MIRROR }
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
  assert.equal(written.statusLine.command, bridgeCommand(NODE, SCRIPT, MIRROR, 'ccstatus'))

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
  const paths: BridgePaths = { settingsFile: link, claudeDir: dir, script: SCRIPT, mirror: MIRROR }
  const memento = new FakeMemento()

  const result = await install(paths, opts(memento), () => Promise.resolve(true))
  assert.equal(result.ok, true)
  assert.equal(fs.lstatSync(link).isSymbolicLink(), true, 'the link is still a link')
  assert.equal(
    JSON.parse(fs.readFileSync(real, 'utf8')).statusLine.command,
    bridgeCommand(NODE, SCRIPT, MIRROR, 'ccstatus'),
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
    { settingsFile: link, claudeDir: dir, script: SCRIPT, mirror: MIRROR },
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
