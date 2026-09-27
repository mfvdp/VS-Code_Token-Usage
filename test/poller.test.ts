// SPDX-FileCopyrightText: 2026 Frederik Marx
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * 1.7 W3 (§0a.2): the version probe without the npm `.cmd` shim. Every edge is injected — the
 * platform, the `PATH`, the existence check and the process start — so no test here starts a
 * process or looks at the real `PATH`, and the Windows cases run the same on all three CI runners.
 */

import { strict as assert } from 'node:assert'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { beforeEach, test } from 'node:test'
import {
  CLAUDE_VERSION_FALLBACK, PollOptions, VersionProbeDeps, detectClaudeVersion, findWindowsClaudeExe, isRegularFile,
  resetClaudeVersionProbe, userAgentFor,
} from '../src/poller'
import { scratchDir } from './fixtures/helpers'

type ExecOpts = Parameters<VersionProbeDeps['execFile']>[2]

/** One process start the probe asked for. */
interface Exec {
  file: string
  args: string[]
  opts: ExecOpts
}

/** Every start any test of this file asked for — the §0a.2 sweep reads it at the end. */
const EVERY_EXEC: Exec[] = []

/**
 * An `execFile` that starts nothing: it records the call and answers with `stdout` (or `err`).
 * The recorder is typed loosely on purpose, so a `shell: true` would be recorded, not refused.
 */
function fakeExec(answer: { stdout?: string; err?: Error | null } = {}): { calls: Exec[]; execFile: VersionProbeDeps['execFile'] } {
  const calls: Exec[] = []
  return {
    calls,
    execFile: (file, args, opts, cb) => {
      const call = { file, args: [...args], opts: { ...opts } }
      calls.push(call)
      EVERY_EXEC.push(call)
      setImmediate(() => cb(answer.err ?? null, answer.stdout ?? ''))
    },
  }
}

/** An existence check over a fixed set of paths, recording what it was asked. */
function files(...present: string[]): { asked: string[]; isFile: (p: string) => boolean } {
  const set = new Set(present)
  const asked: string[] = []
  return { asked, isFile: (p) => { asked.push(p); return set.has(p) } }
}

const NPM = 'C:\\Users\\u\\AppData\\Roaming\\npm'

beforeEach(() => { resetClaudeVersionProbe() })

test('win32: an npm install with only claude.cmd, claude.ps1 and claude on the PATH starts nothing (1.7 W3 test 1)', async () => {
  const exec = fakeExec({ stdout: '2.1.281 (Claude Code)' })
  const fsFake = files(`${NPM}\\claude.cmd`, `${NPM}\\claude.ps1`, `${NPM}\\claude`)
  const v = await detectClaudeVersion({ platform: 'win32', pathEnv: NPM, isFile: fsFake.isFile, execFile: exec.execFile })
  assert.equal(v, null)
  assert.deepEqual(exec.calls, [], 'a process was started although no claude.exe is on the PATH')
  // Only the one name was looked for, by its absolute path.
  assert.deepEqual(fsFake.asked, [`${NPM}\\claude.exe`])
  assert.equal(findWindowsClaudeExe(NPM, fsFake.isFile), null)
})

test('win32: a relative entry is skipped, quotes are stripped, the first claude.exe found is started by its path without a shell (1.7 W3 test 2)', async () => {
  const exec = fakeExec({ stdout: '2.1.281 (Claude Code)\n' })
  // `.\rel` holds a claude.exe too — in every spelling a join could give it.
  const fsFake = files('.\\rel\\claude.exe', 'rel\\claude.exe', 'C:\\b\\claude.exe')
  const v = await detectClaudeVersion({
    platform: 'win32', pathEnv: '.\\rel;C:\\a;"C:\\b"', isFile: fsFake.isFile, execFile: exec.execFile,
  })
  assert.equal(v, '2.1.281')
  assert.equal(exec.calls.length, 1)
  assert.deepEqual(exec.calls[0], {
    file: 'C:\\b\\claude.exe', args: ['--version'], opts: { timeout: 3000, windowsHide: true, shell: false },
  })
  // The relative entry was not even looked at; `C:\a` was, and held nothing.
  assert.deepEqual(fsFake.asked, ['C:\\a\\claude.exe', 'C:\\b\\claude.exe'])
})

test('win32: which PATH entries count — drive or share, at most 64, each at most 1024 characters (1.7 W3, §0a.2)', () => {
  const any = (p: string): boolean => p.toLowerCase().endsWith('\\claude.exe')
  // Relative, drive-relative and rooted-without-a-drive entries never count; a drive and a share do.
  for (const [entry, want] of [
    ['.', null], ['..\\x', null], ['bin', null], ['C:bin', null], ['\\bin', null], ['/bin', null], ['', null], ['  ', null],
    ['C:\\Tools', 'C:\\Tools\\claude.exe'], ['c:/Tools/', 'c:\\Tools\\claude.exe'], [' "D:\\Program Files\\Claude" ', 'D:\\Program Files\\Claude\\claude.exe'],
    ['\\\\server\\share\\bin', '\\\\server\\share\\bin\\claude.exe'],
  ] as const) {
    assert.equal(findWindowsClaudeExe(entry, any), want, JSON.stringify(entry))
  }
  // No PATH at all, or an empty one: nothing.
  assert.equal(findWindowsClaudeExe(undefined, any), null)
  assert.equal(findWindowsClaudeExe('', any), null)
  assert.equal(findWindowsClaudeExe(';;;', any), null)
  // The 64th entry is looked at, the 65th is not.
  const filler = Array.from({ length: 63 }, (_, i) => `C:\\empty${i}`)
  const at64 = files('C:\\hit\\claude.exe')
  assert.equal(findWindowsClaudeExe([...filler, 'C:\\hit'].join(';'), at64.isFile), 'C:\\hit\\claude.exe')
  const at65 = files('C:\\hit\\claude.exe')
  assert.equal(findWindowsClaudeExe([...filler, 'C:\\late', 'C:\\hit'].join(';'), at65.isFile), null)
  assert.equal(at65.asked.length, 64)
  // An entry past 1024 characters is skipped whole, not cut to a shorter directory.
  const long = `C:\\${'x'.repeat(1021)}`
  assert.equal(long.length, 1024)
  assert.equal(findWindowsClaudeExe(long, any), `${long}\\claude.exe`)
  const tooLong = `C:\\${'x'.repeat(1022)}`
  const cut = files(`${tooLong}\\claude.exe`, `${tooLong.slice(0, 1024)}\\claude.exe`)
  assert.equal(findWindowsClaudeExe(`${tooLong};C:\\next`, cut.isFile), null)
  assert.deepEqual(cut.asked, ['C:\\next\\claude.exe'])
  // An existence check that throws is a file that is not there.
  assert.equal(findWindowsClaudeExe('C:\\a;C:\\b', (p) => {
    if (p.startsWith('C:\\a')) throw new Error('EACCES')
    return true
  }), 'C:\\b\\claude.exe')
})

test('win32: without a PATH nothing is started; an exec error or an answer without a version is null (1.7 W3)', async () => {
  const none = fakeExec({ stdout: '2.1.281' })
  assert.equal(await detectClaudeVersion({ platform: 'win32', pathEnv: undefined, isFile: () => true, execFile: none.execFile }), null)
  assert.deepEqual(none.calls, [])
  resetClaudeVersionProbe()
  const broken = fakeExec({ err: new Error('spawn EACCES') })
  assert.equal(await detectClaudeVersion({ platform: 'win32', pathEnv: 'C:\\c', isFile: () => true, execFile: broken.execFile }), null)
  assert.equal(broken.calls.length, 1)
  resetClaudeVersionProbe()
  const silent = fakeExec({ stdout: 'Claude Code' })
  assert.equal(await detectClaudeVersion({ platform: 'win32', pathEnv: 'C:\\c', isFile: () => true, execFile: silent.execFile }), null)
  resetClaudeVersionProbe()
  // A start that throws where it is made answers null too.
  const v = await detectClaudeVersion({
    platform: 'win32', pathEnv: 'C:\\c', isFile: () => true,
    execFile: (file, args, opts) => {
      EVERY_EXEC.push({ file, args: [...args], opts: { ...opts } })
      throw new Error('EINVAL')
    },
  })
  assert.equal(v, null)
})

test('linux and macOS: `claude --version` without a shell, the answer cached for the session (1.7 W3 test 3)', async () => {
  for (const platform of ['linux', 'darwin'] as const) {
    resetClaudeVersionProbe()
    const exec = fakeExec({ stdout: '2.1.281 (Claude Code)' })
    const isFile = files()
    assert.equal(await detectClaudeVersion({ platform, pathEnv: '/usr/bin:/bin', isFile: isFile.isFile, execFile: exec.execFile }), '2.1.281')
    assert.deepEqual(exec.calls, [{ file: 'claude', args: ['--version'], opts: { timeout: 3000, windowsHide: true, shell: false } }])
    // No PATH lookup of our own there: the name is started as it is.
    assert.deepEqual(isFile.asked, [])
    // The second call answers from the cache and starts nothing.
    assert.equal(await detectClaudeVersion({ platform, execFile: exec.execFile }), '2.1.281')
    assert.equal(exec.calls.length, 1)
  }
  // An exec error is null, and cached as well …
  resetClaudeVersionProbe()
  const broken = fakeExec({ err: new Error('spawn claude ENOENT') })
  assert.equal(await detectClaudeVersion({ platform: 'linux', execFile: broken.execFile }), null)
  assert.equal(await detectClaudeVersion({ platform: 'linux', execFile: broken.execFile }), null)
  assert.equal(broken.calls.length, 1)
  // … until `resetClaudeVersionProbe()` asks again.
  resetClaudeVersionProbe()
  const again = fakeExec({ stdout: '2.1.290 (Claude Code)' })
  assert.equal(await detectClaudeVersion({ platform: 'linux', execFile: again.execFile }), '2.1.290')
  assert.equal(again.calls.length, 1)
})

test('the existence check is a stat: a regular file counts, a directory or nothing does not (1.7 W3, §0a.2)', () => {
  const dir = scratchDir('tp-claude-exe')
  const exe = path.join(dir, 'claude.exe')
  fs.writeFileSync(exe, 'synthetic — never read')
  assert.equal(isRegularFile(exe), true)
  const folder = path.join(dir, 'folder', 'claude.exe')
  fs.mkdirSync(folder, { recursive: true })
  assert.equal(isRegularFile(folder), false)
  assert.equal(isRegularFile(path.join(dir, 'missing', 'claude.exe')), false)
})

test('the User-Agent has the claude-code shape for every source of the version; honest sends none of it (1.7 W3, §0a.1)', () => {
  const base: PollOptions = { keychain: false, userAgent: 'claudeCode', extVersion: '1.7.0', claudeVersion: null }
  const SHAPE = /^claude-code\/\d{1,3}\.\d{1,3}\.\d{1,4}$/
  // The CLI's answer (as the probe parses `2.1.290 (Claude Code)`), a transcript's, and the fallback.
  for (const claudeVersion of ['2.1.290', '2.1.281', null]) {
    const ua = userAgentFor({ ...base, claudeVersion })
    assert.match(ua, SHAPE, String(claudeVersion))
    assert.equal(ua, `claude-code/${claudeVersion ?? CLAUDE_VERSION_FALLBACK}`)
  }
  assert.equal(userAgentFor({ ...base, claudeVersion: null }), 'claude-code/2.1.257')
  assert.equal(userAgentFor({ ...base, userAgent: 'honest', claudeVersion: '2.1.281' }), 'token-pace/1.7.0')
})

test('no start in this file was ever through a shell, and none of a .cmd, .bat or .ps1 (1.7 W3 test 4, §0a.2)', async () => {
  // A last Windows case whose PATH offers every kind of script in front of the one exe.
  const exec = fakeExec({ stdout: '2.1.281' })
  const all = files('C:\\s\\claude.cmd', 'C:\\s\\claude.CMD', 'C:\\s\\claude.bat', 'C:\\s\\claude.Ps1', 'C:\\s\\claude', 'C:\\e\\claude.exe')
  assert.equal(await detectClaudeVersion({ platform: 'win32', pathEnv: 'C:\\s;C:\\e', isFile: all.isFile, execFile: exec.execFile }), '2.1.281')
  assert.deepEqual(exec.calls.map((c) => c.file), ['C:\\e\\claude.exe'])
  assert.ok(EVERY_EXEC.length >= 8, `the sweep saw only ${EVERY_EXEC.length} starts`)
  for (const call of EVERY_EXEC) {
    assert.equal((call.opts as { shell?: unknown }).shell, false, `${call.file} was started with shell ${String((call.opts as { shell?: unknown }).shell)}`)
    assert.doesNotMatch(call.file, /\.(cmd|bat|ps1)$/i, `${call.file} is a script`)
    assert.deepEqual(call.args, ['--version'])
  }
})

test('1.12 B: pollClaude hands the cascade its occasion, gate, consent, platform and runner, and gives back the source\'s name — the token only in the one header, never in the result (§2.2, §0a.2)', async () => {
  const { pollClaude } = await import('../src/poller')
  const { KeychainGate } = await import('../src/credentials')
  const token = 'synthetic-token-XYZ-poller'
  const saved = { token: process.env.CLAUDE_CODE_OAUTH_TOKEN, config: process.env.CLAUDE_CONFIG_DIR, secure: process.env.CLAUDE_SECURESTORAGE_CONFIG_DIR }
  const g = globalThis as { fetch: typeof fetch }
  const real = g.fetch
  const headers: string[] = []
  const calls: string[][] = []
  try {
    delete process.env.CLAUDE_CODE_OAUTH_TOKEN
    delete process.env.CLAUDE_CONFIG_DIR
    delete process.env.CLAUDE_SECURESTORAGE_CONFIG_DIR
    g.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      headers.push(String(((init?.headers ?? {}) as Record<string, string>).Authorization))
      return new Response(JSON.stringify({ five_hour: { utilization: 7, resets_at: null } }), { status: 200 })
    }) as typeof fetch
    const gate = new KeychainGate()
    const base: PollOptions = {
      claudeDir: scratchDir('poll-cred'), keychain: true, userAgent: 'honest', extVersion: '1.12.0', claudeVersion: null,
      platform: 'darwin', keychainGate: gate, keychainConsent: 'granted',
      keychainRun: async (cmd, args) => {
        calls.push([cmd, ...args])
        return { out: JSON.stringify({ claudeAiOauth: { accessToken: token, expiresAt: Date.now() + 3_600_000 } }), ms: 20, timedOut: false, code: 0 }
      },
    }
    // Background before any user action: no helper, no request, no token — the source is none.
    const skipped = await pollClaude(0, { ...base, occasion: 'background' })
    assert.equal(skipped.problemKind, 'noToken')
    assert.equal(skipped.credentialsFrom, 'none')
    assert.deepEqual([calls.length, headers.length], [0, 0])
    // The user action: the helper, the header, the source's name.
    const read = await pollClaude(0, { ...base, occasion: 'userAction' })
    assert.equal(read.state?.ok, true)
    assert.equal(read.credentialsFrom, 'keychain')
    assert.deepEqual(calls, [['security', 'find-generic-password', '-s', 'Claude Code-credentials', '-w']])
    assert.deepEqual(headers, [`Bearer ${token}`])
    assert.equal(gate.state(), 'open')
    // Absent occasion = background; the gate is open now, so it reads.
    const again = await pollClaude(0, base)
    assert.equal(again.credentialsFrom, 'keychain')
    for (const r of [skipped, read, again]) assert.equal(JSON.stringify(r).includes(token), false)
  } finally {
    g.fetch = real
    for (const [k, v] of [['CLAUDE_CODE_OAUTH_TOKEN', saved.token], ['CLAUDE_CONFIG_DIR', saved.config], ['CLAUDE_SECURESTORAGE_CONFIG_DIR', saved.secure]] as const) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
  }
})
