// SPDX-FileCopyrightText: 2026 Frederik Marx
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * 1.12 B (§0a.2–§0a.4): the credentials cascade per platform, the Keychain gate, the Keychain consent's part
 * of the cascade, the sign-in watcher's attribute probe, and the two leak tests.
 *
 * Every test injects the platform and the helper runner: none starts `security` or `secret-tool` (the static
 * test at the end holds `test/` to that — the host test's stand-in `security` on a temporary `PATH` is the one
 * exception, and it is a shell script of the test's own). The credentials file is the test's own temporary
 * file; no token here was ever real.
 */

import { strict as assert } from 'node:assert'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { test } from 'node:test'
import {
  HELPER_TIMEOUT_MS, HELPER_TIMEOUT_USER_MS, HelperResult, HelperRun, isCredentialsError, KEYCHAIN_QUIET_MS, KeychainGate,
  keychainFingerprint, keychainService, loadCredentials, runHelper, watchKeychain,
} from '../src/credentials'
import { buildDiagnostics, credentialsDiag, DiagnosticsInput } from '../src/diagnostics'
import { toCsv, toJson } from '../src/exporter'
import { setBundle, setLocale } from '../src/i18n'
import { poll as realPoll, PollOptions } from '../src/poller'
import { QuotaManager, QuotaOptions } from '../src/quotaManager'
import { admit, emptyNotifyState, payloadOf, quotaEvents, testPayload } from '../src/notify'
import { readNotifyConfig } from '../src/config'
import { buildViewModel } from '../src/viewModel'
import { scratchDir } from './fixtures/helpers'
import { buildAgg, makeConfig, makeInput, timeConfig } from './fixtures/viewFixtures'

const NOW = 1_700_000_000_000
const HOUR = 3_600_000

/** Never a real token: each is asserted absent from every output a leak test reads. */
const KEYCHAIN_TOKEN = 'synthetic-token-XYZ'
const FILE_TOKEN = 'synthetic-file-token-0000000000'
const SECRET_TOOL_TOKEN = 'synthetic-secret-tool-token-000'
const ACCOUNT = 'synthetic-account-123'

const GATE_WORDS = 'No token without the macOS Keychain, which is read in the background only after you fetched by hand — run "Token Pace: Fetch Quota Now"'

function doc(token: string, expiresAt: number | null, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ claudeAiOauth: { accessToken: token, expiresAt, refreshToken: 'synthetic-refresh-token', scopes: ['user:inference'], ...extra } })
}

/** A helper runner that answers each command from a table and records every call. */
function fakeRun(answers: Partial<Record<'security' | 'secret-tool', Partial<HelperResult>>>): HelperRun & { calls: Array<[string, string[]]> } {
  const calls: Array<[string, string[]]> = []
  const run = (async (cmd: string, args: string[]): Promise<HelperResult> => {
    calls.push([cmd, [...args]])
    const a = answers[cmd as 'security' | 'secret-tool']
    return { out: a?.out ?? null, ms: a?.ms ?? 5, timedOut: a?.timedOut ?? false, code: a?.code ?? (a?.out == null ? 1 : 0) }
  }) as HelperRun & { calls: Array<[string, string[]]> }
  run.calls = calls
  return run
}

/** The environment of every test: no variable token, no config-directory override. */
async function withCleanEnv(fn: () => Promise<void>, extra: Record<string, string | undefined> = {}): Promise<void> {
  const vars: Record<string, string | undefined> = {
    CLAUDE_CODE_OAUTH_TOKEN: undefined, CLAUDE_SECURESTORAGE_CONFIG_DIR: undefined, CLAUDE_CONFIG_DIR: undefined, ...extra,
  }
  const before = new Map(Object.keys(vars).map((k) => [k, process.env[k]]))
  try {
    for (const [k, v] of Object.entries(vars)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
    await fn()
  } finally {
    for (const [k, v] of before) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
  }
}

function claudeDirWith(token: string | null, expiresAt: number | null = NOW + HOUR): string {
  const dir = scratchDir('cred')
  if (token !== null) fs.writeFileSync(path.join(dir, '.credentials.json'), doc(token, expiresAt))
  return dir
}

// ---------------------------------------------------------------------------
// B1 · the order per platform (B8 test 1)
// ---------------------------------------------------------------------------

test('macOS reads the Keychain before the file; an expired Keychain token falls through to the file; Linux the file before secret-tool; Windows never starts a helper (1.12 B1, B8 test 1)', async () => {
  await withCleanEnv(async () => {
    const both = claudeDirWith(FILE_TOKEN)
    // darwin: both fresh — the Keychain's.
    const kc = fakeRun({ security: { out: doc(KEYCHAIN_TOKEN, NOW + HOUR) } })
    const a = await loadCredentials({ claudeDir: both, keychain: true, platform: 'darwin', run: kc, occasion: 'userAction' }, NOW)
    assert.equal(isCredentialsError(a), false)
    assert.deepEqual([(a as { from: string }).from, (a as { accessToken: string }).accessToken], ['keychain', KEYCHAIN_TOKEN])
    assert.deepEqual(kc.calls, [['security', ['find-generic-password', '-s', 'Claude Code-credentials', '-w']]])
    // darwin: the Keychain's expired — the file's.
    const old = fakeRun({ security: { out: doc(KEYCHAIN_TOKEN, NOW - 1) } })
    const b = await loadCredentials({ claudeDir: both, keychain: true, platform: 'darwin', run: old, occasion: 'userAction' }, NOW)
    assert.equal((b as { from: string }).from, 'file')
    // darwin with the setting off: the file, and no helper.
    const off = fakeRun({ security: { out: doc(KEYCHAIN_TOKEN, NOW + HOUR) } })
    const c = await loadCredentials({ claudeDir: both, keychain: false, platform: 'darwin', run: off, occasion: 'userAction' }, NOW)
    assert.equal((c as { from: string }).from, 'file')
    assert.equal(off.calls.length, 0)
    // darwin: both expired — the expiry is reported, with no value.
    const stale = claudeDirWith(FILE_TOKEN, NOW - 1)
    const d = await loadCredentials({ claudeDir: stale, keychain: true, platform: 'darwin', run: old, occasion: 'userAction' }, NOW)
    assert.equal((d as { kind: string }).kind, 'tokenExpired')
    assert.equal(JSON.stringify(d).includes(KEYCHAIN_TOKEN) || JSON.stringify(d).includes(FILE_TOKEN), false)

    // linux: the file's before secret-tool's — the helper is not even started while the file answers.
    const st = fakeRun({ 'secret-tool': { out: doc(SECRET_TOOL_TOKEN, NOW + HOUR) } })
    const e = await loadCredentials({ claudeDir: both, keychain: true, platform: 'linux', run: st }, NOW)
    assert.equal((e as { from: string }).from, 'file')
    assert.equal(st.calls.length, 0)
    const none = claudeDirWith(null)
    const f = await loadCredentials({ claudeDir: none, keychain: true, platform: 'linux', run: st }, NOW)
    assert.equal((f as { from: string }).from, 'secretTool')
    assert.deepEqual(st.calls, [['secret-tool', ['lookup', 'service', 'Claude Code-credentials']]])

    // win32: the file, else nothing — no helper at all.
    const w = fakeRun({ security: { out: doc(KEYCHAIN_TOKEN, NOW + HOUR) }, 'secret-tool': { out: doc(SECRET_TOOL_TOKEN, NOW + HOUR) } })
    const g = await loadCredentials({ claudeDir: both, keychain: true, platform: 'win32', run: w, occasion: 'userAction' }, NOW)
    assert.equal((g as { from: string }).from, 'file')
    const h = await loadCredentials({ claudeDir: none, keychain: true, platform: 'win32', run: w, occasion: 'userAction' }, NOW)
    assert.equal((h as { kind: string }).kind, 'noToken')
    assert.ok((h as { error: string }).error.startsWith('No Claude Code credentials at '))
    assert.equal(w.calls.length, 0)

    // The variable wins everywhere, before any helper.
    await withCleanEnv(async () => {
      const envRun = fakeRun({ security: { out: doc(KEYCHAIN_TOKEN, NOW + HOUR) } })
      const v = await loadCredentials({ claudeDir: both, keychain: true, platform: 'darwin', run: envRun, occasion: 'userAction' }, NOW)
      assert.equal((v as { from: string }).from, 'env')
      assert.equal(envRun.calls.length, 0)
    }, { CLAUDE_CODE_OAUTH_TOKEN: 'synthetic-env-token' })
  })
})

test('the Keychain item carries the suffix of CLAUDE_CONFIG_DIR where that is set, in the read and in the probe (1.12 B1)', async () => {
  await withCleanEnv(async () => {
    const run = fakeRun({ security: { out: doc(KEYCHAIN_TOKEN, NOW + HOUR) } })
    await loadCredentials({ claudeDir: claudeDirWith(null), keychain: true, platform: 'darwin', run, occasion: 'userAction' }, NOW)
    await keychainFingerprint(run)
    const item = keychainService()
    assert.match(item, /^Claude Code-credentials-[0-9a-f]{8}$/)
    assert.deepEqual(run.calls.map(([, args]) => args[2]), [item, item])
  }, { CLAUDE_CONFIG_DIR: '/home/synthetic/.claude-work' })
})

// ---------------------------------------------------------------------------
// B2 · the gate (B8 test 2)
// ---------------------------------------------------------------------------

test('the gate: a background read before any user action never starts security; a quiet user-action read opens it, a slow, failed or timed-out one closes it; a later quiet one reopens it (1.12 B2, B8 test 2)', async () => {
  await withCleanEnv(async () => {
    const logs: string[] = []
    const log = (m: string): void => { logs.push(m) }
    const gate = new KeychainGate(log)
    const withFile = claudeDirWith(FILE_TOKEN)
    const without = claudeDirWith(null)
    const quiet = fakeRun({ security: { out: doc(KEYCHAIN_TOKEN, NOW + HOUR), ms: 200 } })
    const opts = { keychain: true, platform: 'darwin' as const, gate, log }
    assert.equal(gate.state(), 'untried')

    // Background, untried: not started — the file's token, or B2 rule 4's words without one.
    const a = await loadCredentials({ ...opts, claudeDir: withFile, run: quiet, occasion: 'background' }, NOW)
    assert.equal((a as { from: string }).from, 'file')
    const b = await loadCredentials({ ...opts, claudeDir: without, run: quiet, occasion: 'background' }, NOW)
    assert.deepEqual(b, { kind: 'noToken', error: GATE_WORDS })
    // An expired file is no answer on macOS while the Keychain was skipped: the same words, not "expired".
    const c = await loadCredentials({ ...opts, claudeDir: claudeDirWith(FILE_TOKEN, NOW - 1), run: quiet, occasion: 'background' }, NOW)
    assert.deepEqual(c, { kind: 'noToken', error: GATE_WORDS })
    assert.equal(quiet.calls.length, 0)
    assert.ok(logs.includes('claude: the Keychain was not read (background, gate closed)'))

    // A user action reads; a quiet answer (200 ms) opens the gate, and the background may read.
    const d = await loadCredentials({ ...opts, claudeDir: without, run: quiet, occasion: 'userAction' }, NOW)
    assert.equal((d as { from: string }).from, 'keychain')
    assert.equal(gate.state(), 'open')
    const e = await loadCredentials({ ...opts, claudeDir: without, run: quiet, occasion: 'background' }, NOW)
    assert.equal((e as { from: string }).from, 'keychain')
    assert.equal(quiet.calls.length, 2)
    assert.ok(logs.includes('claude: token from the Keychain'))

    // A slow read (1 800 ms — a dialog was answered) closes it: the next background read skips.
    const slow = fakeRun({ security: { out: doc(KEYCHAIN_TOKEN, NOW + HOUR), ms: 1_800 } })
    const f = await loadCredentials({ ...opts, claudeDir: without, run: slow, occasion: 'userAction' }, NOW)
    assert.equal((f as { from: string }).from, 'keychain', 'the slow read still brings its token')
    assert.equal(gate.state(), 'closed')
    assert.ok(logs.includes('claude: Keychain read took 1800 ms — background reads wait for the next fetch by hand'), logs.join(' | '))
    await loadCredentials({ ...opts, claudeDir: without, run: slow, occasion: 'background' }, NOW)
    assert.equal(slow.calls.length, 1)

    // A later user action with a quiet read reopens it; a timed-out one closes it; a failed one too.
    await loadCredentials({ ...opts, claudeDir: without, run: quiet, occasion: 'userAction' }, NOW)
    assert.equal(gate.state(), 'open')
    const hung = fakeRun({ security: { out: null, ms: 5_000, timedOut: true } })
    const g = await loadCredentials({ ...opts, claudeDir: without, run: hung, occasion: 'background' }, NOW)
    assert.equal(gate.state(), 'closed', 'a background read that timed out closes the gate too')
    assert.equal((g as { kind: string }).kind, 'noToken')
    assert.ok(logs.some((l) => /^claude: Keychain read timed out after 5000 ms/.test(l)))
    await loadCredentials({ ...opts, claudeDir: without, run: quiet, occasion: 'userAction' }, NOW)
    const missing = fakeRun({ security: { out: null, ms: 30, code: 44 } })
    await loadCredentials({ ...opts, claudeDir: without, run: missing, occasion: 'userAction' }, NOW)
    assert.equal(gate.state(), 'closed')
    assert.ok(logs.includes('claude: no token from the Keychain — background reads wait for the next fetch by hand'))

    // The threshold is the constant: exactly KEYCHAIN_QUIET_MS is still quiet.
    const edge = new KeychainGate()
    edge.note({ ok: true, ms: KEYCHAIN_QUIET_MS, timedOut: false }, 'userAction')
    assert.equal(edge.state(), 'open')
    edge.note({ ok: true, ms: KEYCHAIN_QUIET_MS + 1, timedOut: false }, 'background')
    assert.equal(edge.state(), 'closed')
    edge.reset()
    assert.equal(edge.state(), 'untried')
    // The gate never widens what is read: without a gate the occasion alone changes nothing (1.x callers).
    const plain = fakeRun({ security: { out: doc(KEYCHAIN_TOKEN, NOW + HOUR) } })
    await loadCredentials({ claudeDir: without, keychain: true, platform: 'darwin', run: plain }, NOW)
    assert.equal(plain.calls.length, 1)
    // No log line carries the token.
    assert.equal(logs.some((l) => l.includes(KEYCHAIN_TOKEN) || l.includes(FILE_TOKEN)), false)
  })
})

test('a user-action Keychain read waits 30 s for macOS\'s dialog, a background read 5 s: a stand-in answering after 7 s (scaled to 1.4 s) brings its token by hand and times out in the background; the quiet rule still measures the time taken (1.12 B2 rule 3, Review 2 F6)', async () => {
  await withCleanEnv(async () => {
    assert.equal(HELPER_TIMEOUT_MS, 5_000)
    assert.equal(HELPER_TIMEOUT_USER_MS, 30_000)
    // A stand-in of the test's own (never macOS's security): it writes its pid, then answers after 1 400 ms — 7 s at a
    // fifth of the time. The test's runner hands the real runHelper the limit loadCredentials chose, divided by five
    // (30 s → 6 s, 5 s → 1 s), so the real timeout of execFile decides — scaled, not replaced.
    const dir = scratchDir('cred-timeout')
    const script = path.join(dir, 'stand-in-helper.js')
    const pidFile = path.join(dir, 'pid')
    fs.writeFileSync(script, `require('fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid))\n`
      + `setTimeout(() => process.stdout.write(${JSON.stringify(doc(KEYCHAIN_TOKEN, NOW + HOUR))}), 1_400)\n`)
    const limits: Array<number | undefined> = []
    const results: HelperResult[] = []
    const scaled: HelperRun = async (_cmd, _args, timeoutMs) => {
      limits.push(timeoutMs)
      const r = await runHelper(process.execPath, [script], (timeoutMs ?? HELPER_TIMEOUT_MS) / 5)
      results.push(r)
      return r
    }
    const gone = async (): Promise<boolean> => {
      const pid = Number(fs.readFileSync(pidFile, 'utf8'))
      for (let i = 0; i < 50; i++) {
        try { process.kill(pid, 0) } catch { return true }
        await new Promise((r) => setTimeout(r, 20))
      }
      return false
    }
    const without = claudeDirWith(null)
    const opts = { keychain: true, platform: 'darwin' as const, claudeDir: without, run: scaled }
    try {
      const byHand = await loadCredentials({ ...opts, occasion: 'userAction' }, NOW)
      assert.equal((byHand as { from: string }).from, 'keychain', JSON.stringify(byHand))
      assert.equal(results[0].timedOut, false)
      assert.ok(await gone(), 'the stand-in ended')
      fs.rmSync(pidFile)
      const background = await loadCredentials({ ...opts, occasion: 'background' }, NOW)
      assert.equal(isCredentialsError(background), true, 'no Keychain token in the background')
      assert.equal(results[1].timedOut, true)
      assert.ok(await gone(), 'the timed-out stand-in was ended')
      assert.deepEqual(limits, [HELPER_TIMEOUT_USER_MS, HELPER_TIMEOUT_MS])
    } finally {
      try { process.kill(Number(fs.readFileSync(pidFile, 'utf8')), 'SIGKILL') } catch { /* gone */ }
      fs.rmSync(dir, { recursive: true, force: true })
    }

    // B2 rule 3 unchanged: a user action's read answered after a 7-s dialog brings its token and still closes the gate.
    const gate = new KeychainGate()
    const afterDialog = fakeRun({ security: { out: doc(KEYCHAIN_TOKEN, NOW + HOUR), ms: 7_000 } })
    const d = await loadCredentials({ ...opts, run: afterDialog, gate, occasion: 'userAction' }, NOW)
    assert.equal((d as { from: string }).from, 'keychain')
    assert.equal(gate.state(), 'closed')
  })
})

test('the words of B2 rule 4 in German — the command quoted as the German manifest has it (1.12 B2 rule 4)', async () => {
  const de = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'l10n', 'bundle.l10n.de.json'), 'utf8')) as Record<string, string>
  const title = (JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.nls.de.json'), 'utf8')) as Record<string, string>)['command.refreshQuota.title']
  try {
    setBundle(de)
    setLocale('de')
    await withCleanEnv(async () => {
      const r = await loadCredentials({ claudeDir: claudeDirWith(null), keychain: true, platform: 'darwin', gate: new KeychainGate(), run: fakeRun({}), occasion: 'background' }, NOW)
      assert.equal((r as { error: string }).error,
        `Ohne den macOS-Schlüsselbund kein Token — er wird im Hintergrund erst gelesen, nachdem Sie einmal von Hand abgerufen haben: Führen Sie „Token Pace: ${title}“ aus`)
    })
  } finally {
    setBundle(undefined)
    setLocale(undefined)
  }
})

// ---------------------------------------------------------------------------
// B3 · the Keychain consent's part of the cascade (B8 test 3, the cascade's side)
// ---------------------------------------------------------------------------

test('without the Keychain consent the Keychain is not read even on a user action: unasked points at Fetch Quota Now, denied leaves the file\'s words (1.12 B3, B8 test 3)', async () => {
  await withCleanEnv(async () => {
    const run = fakeRun({ security: { out: doc(KEYCHAIN_TOKEN, NOW + HOUR) } })
    const without = claudeDirWith(null)
    const base = { claudeDir: without, keychain: true, platform: 'darwin' as const, gate: new KeychainGate(), run, occasion: 'userAction' as const }
    const unasked = await loadCredentials({ ...base, keychainConsent: 'unasked' }, NOW)
    assert.deepEqual(unasked, { kind: 'noToken', error: GATE_WORDS })
    const denied = await loadCredentials({ ...base, keychainConsent: 'denied' }, NOW)
    assert.equal((denied as { kind: string }).kind, 'noToken')
    assert.ok((denied as { error: string }).error.startsWith('No Claude Code credentials at '))
    // The file still counts for both.
    const withFile = claudeDirWith(FILE_TOKEN)
    for (const consent of ['unasked', 'denied'] as const) {
      const r = await loadCredentials({ ...base, claudeDir: withFile, keychainConsent: consent }, NOW)
      assert.equal((r as { from: string }).from, 'file')
    }
    assert.equal(run.calls.length, 0)
    const granted = await loadCredentials({ ...base, keychainConsent: 'granted' }, NOW)
    assert.equal((granted as { from: string }).from, 'keychain')
    assert.equal(run.calls.length, 1)
  })
})

// ---------------------------------------------------------------------------
// §0a.3 · the attribute probe and the watcher (B8 test 5)
// ---------------------------------------------------------------------------

function attributes(mdatHex: string): string {
  return [
    'keychain: "/Users/synthetic/Library/Keychains/login.keychain-db"',
    'version: 512',
    'class: "genp"',
    'attributes:',
    '    0x00000007 <blob>="Claude Code-credentials"',
    `    "acct"<blob>="${ACCOUNT}"`,
    '    "cdat"<timedate>=0x32303235303130313132303030305A00  "20250101120000Z\\000"',
    `    "mdat"<timedate>=0x${mdatHex}  "20260927120000Z\\000"`,
    '    "svce"<blob>="Claude Code-credentials"',
  ].join('\n')
}

test('the probe keeps the modification date and nothing else of the attributes — no -w, no -g; none for a missing item, unknown otherwise (1.12 §0a.3 leak test)', async () => {
  const run = fakeRun({ security: { out: attributes('3230323630393237313230303030') } })
  const fp = await keychainFingerprint(run)
  assert.equal(fp, 'mdat:0x3230323630393237313230303030')
  assert.equal(fp.includes(ACCOUNT), false)
  assert.equal(fp.includes('login.keychain'), false)
  assert.deepEqual(run.calls, [['security', ['find-generic-password', '-s', keychainService()]]])
  for (const [, args] of run.calls) assert.equal(args.includes('-w') || args.includes('-g'), false)
  // The quoted date where no hex form is printed.
  assert.equal(await keychainFingerprint(fakeRun({ security: { out: '    "mdat"<timedate>="20260927120000Z\\000"' } })), 'mdat:20260927120000Z')
  assert.equal(await keychainFingerprint(fakeRun({ security: { out: null, code: 44 } })), 'none')
  assert.equal(await keychainFingerprint(fakeRun({ security: { out: null, code: 1 } })), 'unknown')
  assert.equal(await keychainFingerprint(fakeRun({ security: { out: null, timedOut: true, code: null } })), 'unknown')
  assert.equal(await keychainFingerprint(fakeRun({ security: { out: `    "acct"<blob>="${ACCOUNT}"` } })), 'unknown')
  assert.equal(await keychainFingerprint(async () => { throw new Error('spawn failed') }), 'unknown')
})

/** A fake `fs.watch`: the listener is kept, the watcher can be closed. */
function fakeWatch(): { watch: NonNullable<Parameters<typeof watchKeychain>[1]>['watch']; fire(name: string): void; dirs: string[]; closed(): boolean } {
  let listener: ((event: string, name: string | Buffer | null) => void) | null = null
  const dirs: string[] = []
  let closed = false
  return {
    watch: (dir, _opts, l) => {
      dirs.push(dir)
      listener = l
      return { close: () => { closed = true }, on: () => undefined } as unknown as fs.FSWatcher
    },
    fire: (name) => listener?.('rename', name),
    dirs,
    closed: () => closed,
  }
}

const tick = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

async function until(what: string, cond: () => boolean, ms = 2_000): Promise<void> {
  const end = Date.now() + ms
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`)
    await tick(5)
  }
}

test('the watcher: a changing mdat is one change each after the debounce; another file\'s event starts no probe; unknown reports nothing; the item gone is one change; a watch that throws is no watcher and no error (1.12 B5, B8 test 5)', async () => {
  let mdat: string | null = '3130'
  let answer: 'item' | 'unknown' = 'item'
  const calls: string[][] = []
  const run: HelperRun = async (_cmd, args) => {
    calls.push(args)
    if (answer === 'unknown') return { out: null, ms: 3, timedOut: false, code: 1 }
    return mdat === null ? { out: null, ms: 3, timedOut: false, code: 44 } : { out: attributes(mdat), ms: 3, timedOut: false, code: 0 }
  }
  const w = fakeWatch()
  let changes = 0
  const home = '/home/synthetic'
  const handle = watchKeychain(() => { changes++ }, { platform: 'darwin', home, run, watch: w.watch, debounceMs: 20 })
  try {
    assert.deepEqual(w.dirs, [path.join(home, 'Library', 'Keychains')])
    await until('the baseline probe', () => calls.length === 1)
    // An event of another file of the folder: no probe.
    w.fire('System.keychain')
    w.fire('metadata.keychain-db')
    await tick(60)
    assert.equal(calls.length, 1)
    // The same date: probed, no change.
    w.fire('login.keychain-db')
    await until('the probe', () => calls.length === 2)
    await tick(10)
    assert.equal(changes, 0)
    // A new date: one change, after the debounce — three events in a row are one probe.
    mdat = '3131'
    w.fire('login.keychain-db')
    w.fire('login.keychain-db-journal')
    w.fire('login.keychain-db')
    await until('the change', () => changes === 1)
    await tick(60)
    assert.equal(calls.length, 3)
    assert.equal(changes, 1)
    // A probe answering unknown reports nothing and keeps the date it had.
    answer = 'unknown'
    w.fire('login.keychain-db')
    await until('the unknown probe', () => calls.length === 4)
    await tick(10)
    assert.equal(changes, 1)
    answer = 'item'
    // The item gone: none — one change, and one only.
    mdat = null
    w.fire('login.keychain-db')
    await until('the sign-out', () => changes === 2)
    w.fire('login.keychain-db')
    await until('the probe after', () => calls.length === 6)
    await tick(10)
    assert.equal(changes, 2)
    // Every probe was the attribute probe.
    for (const args of calls) assert.deepEqual(args, ['find-generic-password', '-s', keychainService()])
  } finally {
    handle.dispose()
  }
  assert.equal(w.closed(), true)
  // After dispose an event does nothing.
  w.fire('login.keychain-db')
  await tick(40)
  assert.equal(calls.length, 6)

  // A watch that throws: no watcher, no error, no probe.
  const probes: string[][] = []
  const failing = watchKeychain(() => { changes++ }, {
    platform: 'darwin', home, run: async (_c, a) => { probes.push(a); return { out: null, ms: 1, timedOut: false, code: 1 } },
    watch: () => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }) }, debounceMs: 5,
  })
  failing.dispose()
  assert.equal(probes.length, 0)
  // Elsewhere than macOS nothing is watched.
  const linux = fakeWatch()
  watchKeychain(() => { changes++ }, { platform: 'linux', home, run, watch: linux.watch }).dispose()
  assert.deepEqual(linux.dirs, [])
})

test('the watcher keeps no account name: a synthetic "acct" beside a changing "mdat" reaches neither a fingerprint nor a log line (1.12 §0a.3 leak test)', async () => {
  let mdat = '41'
  const logs: string[] = []
  const w = fakeWatch()
  let changes = 0
  const seen: string[] = []
  const run: HelperRun = async () => ({ out: attributes(mdat), ms: 2, timedOut: false, code: 0 })
  const handle = watchKeychain(() => {
    changes++
    // The host's answer to a change: its one English line, then a background fetch.
    logs.push('Claude credentials changed — re-checking the quota.')
  }, { platform: 'darwin', home: '/home/synthetic', run, watch: w.watch, debounceMs: 5 })
  try {
    await tick(20)
    for (const next of ['42', '43']) {
      mdat = next
      w.fire('login.keychain-db')
      await until(`the change to ${next}`, () => changes === (next === '42' ? 1 : 2))
      seen.push(await keychainFingerprint(run))
    }
  } finally {
    handle.dispose()
  }
  assert.equal(changes, 2)
  assert.deepEqual(seen, ['mdat:0x42', 'mdat:0x43'])
  for (const text of [...seen, ...logs]) assert.equal(text.includes(ACCOUNT), false, text)
})

// ---------------------------------------------------------------------------
// §0a.2 · the leak test through the manager and the real poll
// ---------------------------------------------------------------------------

// 1.12 P6 (pinned and changed): the resets lie ahead of the real clock the manager reads, so that the notifier's quota
// events (below) judge the reading this fetch brought, as they would in the product.
const USAGE_BODY = {
  five_hour: { utilization: 42, resets_at: new Date(Date.now() + 3 * HOUR).toISOString() },
  seven_day: { utilization: 20, resets_at: new Date(Date.now() + 5 * 24 * HOUR).toISOString() },
}

interface FetchCall { url: string; authorization: string | null }

async function withFetch(fn: (calls: FetchCall[]) => Promise<void>): Promise<void> {
  const g = globalThis as { fetch: typeof fetch }
  const real = g.fetch
  const calls: FetchCall[] = []
  g.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const headers = (init?.headers ?? {}) as Record<string, string>
    calls.push({ url: String(url), authorization: headers.Authorization ?? null })
    return new Response(JSON.stringify(USAGE_BODY), { status: 200, headers: { 'content-type': 'application/json' } })
  }) as typeof fetch
  try {
    await fn(calls)
  } finally {
    g.fetch = real
  }
}

const OPTIONS: QuotaOptions = {
  mode: 'poll',
  intervalMinutes: 30,
  claudeOrder: ['poll'],
  codexOrder: ['poll'],
  keychain: true,
  userAgent: 'claudeCode',
  writeQuotaCache: false,
  appServerMode: 'oneShot',
  pollOnlyWhenFocused: false,
  platform: 'darwin',
  keychainConsent: () => 'granted',
}

function diagInput(mgr: QuotaManager, gate: KeychainGate): DiagnosticsInput {
  return {
    extVersion: '1.12.0', vscodeVersion: '1.104.0', platform: 'darwin', arch: 'arm64', node: '22.15.1', remoteName: null,
    extensionKind: 'workspace', roots: [], fileCount: 0,
    snapshot: { buckets: {}, bytes: 0, oldestDay: null, newestDay: null, firstIngest: null },
    retention: { hourDays: 45, days: 400, historyDays: 30 },
    historySize: { samples: 0, bytes: 0, oldest: null },
    quota: [], codexConnection: null,
    credentials: credentialsDiag({ source: mgr.lastCredentialsFrom(), platform: 'darwin', setting: true, consent: 'granted', gate: gate.state() }),
    consent: 'granted', role: 'leader', bridge: null,
    http: {
      proxy: { value: '', origin: 'default' }, proxySupport: { value: 'off', origin: 'default' },
      proxyStrictSSL: { value: true, origin: 'default' },
    },
    proxyEnv: [], settings: {}, partialData: false, attribution: 'none',
    language: { setting: 'auto', shown: 'en', vscode: 'en' }, home: '/home/synthetic',
  }
}

test('the Keychain\'s token goes into the one Authorization header and nowhere else — not the log, the diagnostics, quota.json, the readings, the exports, the notification payloads (1.12 §0a.2 leak test)', async () => {
  await withCleanEnv(async () => {
    await withFetch(async (fetches) => {
      const dir = scratchDir('cred-leak')
      const logs: string[] = []
      const gate = new KeychainGate((m) => logs.push(m))
      const keychainRun = fakeRun({ security: { out: doc(KEYCHAIN_TOKEN, Date.now() + HOUR), ms: 40 } })
      const polls: PollOptions[] = []
      const mgr = new QuotaManager(
        { ...OPTIONS, claudeDir: claudeDirWith(null), keychainGate: gate },
        { stateFile: path.join(dir, 'quota.json'), historyFile: '', mirrorFile: path.join(dir, 'mirror.json'), claudeJsonFile: path.join(dir, 'claude.json') },
        (m) => logs.push(m),
        () => true,
        () => [],
        undefined,
        {
          detectClaudeVersion: async () => '2.1.300',
          findCodexBinary: () => null,
          // The real poll, with the stand-in helper runner — everything else is the product's own path.
          poll: (src, fc, opts) => {
            polls.push(opts)
            return realPoll(src, fc, { ...opts, keychainRun })
          },
        },
      )
      try {
        // A background tick first: the gate is untried, the Keychain not read, no request.
        mgr.tick(() => undefined)
        await until('the background poll', () => logs.some((l) => l.startsWith('claude: No token without the macOS Keychain')))
        assert.equal(keychainRun.calls.length, 0)
        assert.equal(fetches.length, 0)
        assert.equal(mgr.lastCredentialsFrom(), 'none')
        // Fetch Quota Now: a user action — the Keychain is read, its token goes into the header.
        mgr.forcePoll(() => undefined, { userAction: true })
        await until('the fetch', () => logs.includes('claude: quota fetched'))
        assert.equal(polls.find((p) => p.occasion === 'userAction') !== undefined, true)
        assert.equal(keychainRun.calls.length, 1)
        assert.deepEqual(fetches.map((f) => [f.url, f.authorization]), [['https://api.anthropic.com/api/oauth/usage', `Bearer ${KEYCHAIN_TOKEN}`]])
        assert.equal(mgr.lastCredentialsFrom(), 'keychain')
        assert.equal(gate.state(), 'open')
        assert.ok(logs.includes('claude: token from the Keychain'))
      } finally {
        mgr.dispose()
      }
      const cfg = makeConfig()
      const tcfg = timeConfig(cfg)
      const agg = buildAgg()
      const range = { from: '2026-08-01', to: '2026-09-30' }
      const readings = mgr.current()
      assert.equal(readings.find((q) => q.source === 'claude')?.ok, true, 'the fetched reading is not the one shown')
      // 1.12 P6 (P5-O1, §0a.2's "the notify payloads"): every payload the notifier builds from this reading — a threshold
      // on each window, a forecast before the reset — and the test message; the token is in none of them.
      const now = Date.now()
      const notifyCfg = readNotifyConfig((k) => ({
        'tokenPace.notifications.channels': ['webhook'],
        'tokenPace.notifications.events': ['quotaThreshold', 'quotaExhausted', 'quotaReset', 'paceWarning'],
        'tokenPace.notifications.thresholds': { session: 10, weekly: 10 },
      } as Record<string, unknown>)[k])
      const claudeWindow = readings.find((q) => q.source === 'claude')?.windows.find((w) => w.kind === 'session')
      assert.ok(claudeWindow)
      const forecasts = new Map([[`claude:${claudeWindow.id}`, {
        state: 'eta' as const, ratePerHour: 30, etaMs: now + HOUR, endPercent: 130, sustainablePerHour: 20, confidence: 'high' as const,
        basis: { samples: 8, spanMs: HOUR }, text: '',
      }]])
      const groups = admit(quotaEvents(readings, forecasts, notifyCfg, emptyNotifyState(), now, 20 * 60_000), notifyCfg, emptyNotifyState(), now).send
      assert.deepEqual(groups.map((g) => [g[0].event, g.length]), [['quotaThreshold', 2], ['paceWarning', 1]])
      const payloads = [...groups.map((g) => payloadOf(g, { tcfg: timeConfig(makeConfig()), now })), testPayload({ tcfg: timeConfig(makeConfig()), now })]
      const outputs: Array<[string, string]> = [
        ['log', logs.join('\n')],
        ['diagnostics', buildDiagnostics(diagInput(mgr, gate))],
        ['quota.json', fs.readFileSync(path.join(dir, 'quota.json'), 'utf8')],
        ['readings', JSON.stringify(readings)],
        // The view model the page and the text views are drawn from, deep-serialised, with the fetched reading in it.
        ['view model', JSON.stringify(buildViewModel(makeInput({ quotas: readings, agg, cfg })))],
        ['csv', toCsv(agg, range, cfg, tcfg)],
        ['json', toJson(agg, range, cfg, tcfg)],
        ['notify payloads', JSON.stringify(payloads)],
      ]
      assert.match(outputs[1][1], /^credentials — source keychain · keychain allowed$/m)
      for (const [what, text] of outputs) {
        for (const secret of [KEYCHAIN_TOKEN, 'synthetic-refresh-token', 'Bearer ']) assert.equal(text.includes(secret), false, `the ${what} holds ${secret}`)
      }
    })
  })
})

// ---------------------------------------------------------------------------
// The static rule: no test starts the real helpers
// ---------------------------------------------------------------------------

test('no test starts the real security or secret-tool: every Keychain test injects its runner, the host test puts a stand-in on a PATH of its own (1.12 B8)', () => {
  const dir = path.join(__dirname, '..', 'test')
  const files = fs.readdirSync(dir, { recursive: true }).map(String).filter((f) => f.endsWith('.ts'))
  assert.ok(files.length > 20)
  const exec = 'exec' + 'File'
  const needle = new RegExp(`\\b(?:${exec}|${exec}Sync|spawn|spawnSync)\\(\\s*['"\`](?:security|secret-tool)['"\`]`)
  for (const f of files) {
    const text = fs.readFileSync(path.join(dir, f), 'utf8')
    assert.equal(needle.test(text), false, `test/${f} starts a real credentials helper`)
  }
})
