// SPDX-FileCopyrightText: 2026 Frederik Marx
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The diagnostics report is a promise: "paste this anywhere". The tests hold
 * the allow-list to that — an unknown field is an error, not a leak.
 */

import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import {
  buildDiagnostics, codexConnectionDiag, collectHttpSettings, collectProxyEnv, collectSettings, DiagnosticsInput,
  InspectLike, maskProxyUrl, scrubHome, tildify, VscodeConfigApi,
} from '../src/diagnostics'
import { setBundle, setLang, setLocale } from '../src/i18n'

const HOME = '/home/tester'

function input(over: Partial<DiagnosticsInput> = {}): DiagnosticsInput {
  return {
    extVersion: '1.0.0',
    vscodeVersion: '1.104.0',
    platform: 'linux',
    arch: 'x64',
    node: '22.15.1',
    remoteName: null,
    extensionKind: 'workspace',
    roots: ['~/.claude/projects'],
    fileCount: 412,
    snapshot: { buckets: { h: 210, d: 380, m: 12 }, bytes: 1_234_567, oldestDay: '2026-05-01', newestDay: '2026-09-03', firstIngest: '2026-05-01' },
    retention: { hourDays: 45, days: 400, historyDays: 30 },
    historySize: { samples: 2140, bytes: 210_000, oldest: '2026-08-04' },
    quota: [{
      source: 'claude',
      candidates: [
        { id: 'cacheFile', ok: true, ageSec: 180 },
        // The source cascade puts absolute paths into these strings.
        { id: 'claudeJson', ok: false, ageSec: null, problemKind: 'noFile', problem: `No ${HOME}/.claude.json` },
        { id: 'poll', ok: false, ageSec: null, problemKind: 'consentPending', problem: 'consent required' },
      ],
      backoffEndsAt: null,
      drift: ['spend.used.amount_minor'],
    }],
    codexConnection: { mode: 'persistent', state: 'ready', restartsLastHour: 0, pushes: 3, lastPushAgeSec: 42 },
    consent: 'granted',
    role: 'leader',
    bridge: { installed: true, shadowed: false, mirrorAgeMs: 180_000 },
    http: {
      proxy: { value: '', origin: 'default' },
      proxySupport: { value: 'off', origin: 'user' },
      proxyStrictSSL: { value: true, origin: 'default' },
    },
    proxyEnv: [],
    settings: {},
    partialData: false,
    attribution: 'none',
    language: { setting: 'auto', shown: 'en', vscode: 'en' },
    home: HOME,
    ...over,
  }
}

test('the report is fenced and carries every section', () => {
  const out = buildDiagnostics(input())
  assert.ok(out.startsWith('```text\n'))
  assert.ok(out.endsWith('\n```'))
  for (const section of ['## Environment', '## Data', '## Quota sources', '## Status line bridge', '## Network setup', '## Settings']) {
    assert.ok(out.includes(section), `missing ${section}`)
  }
  assert.match(out, /PARTIAL_DATA {4}no/)
  assert.match(out, /cacheFile {5}ok {3}3 min/)
  assert.match(out, /\[consentPending\]/)
  assert.match(out, /drift: spend\.used\.amount_minor/)
  assert.match(out, /http\.proxySupport {5}\(user\) "off"/)
})

test('a quota problem string is shortened like every other path in the report', () => {
  const out = buildDiagnostics(input())
  assert.match(out, /No ~\/\.claude\.json/)
  assert.ok(!out.includes(HOME), 'the report promises ~ and must keep that promise everywhere')
})

test('scrubHome replaces the home directory wherever it sits in the text', () => {
  assert.equal(scrubHome(`No quota file at ${HOME}/.cache/x.json`, HOME), 'No quota file at ~/.cache/x.json')
  assert.equal(scrubHome(`${HOME} and ${HOME}/a`, HOME), '~ and ~/a')
  assert.equal(scrubHome(`No quota file at ${HOME}/`, `${HOME}/`), 'No quota file at ~/')
  assert.equal(scrubHome('C:\\Users\\t\\.claude.json missing', 'C:\\Users\\t'), '~\\.claude.json missing')
  assert.equal(scrubHome('nothing to do', HOME), 'nothing to do')
  assert.equal(scrubHome('/opt/claude', ''), '/opt/claude')
})

test('PARTIAL_DATA is stated, not implied', () => {
  assert.match(buildDiagnostics(input({ partialData: true })), /PARTIAL_DATA.*yes/)
})

test('a field outside the allow-list is refused, not redacted', () => {
  const withToken = { ...input(), accessToken: 'sk-ant-oat01-not-a-real-token' } as unknown as DiagnosticsInput
  assert.throws(() => buildDiagnostics(withToken), /allow-list: accessToken/)

  const withSecret = { ...input(), secret: 'nope' } as unknown as DiagnosticsInput
  assert.throws(() => buildDiagnostics(withSecret), /allow-list: secret/)

  // And it never reaches the output by another route.
  try {
    buildDiagnostics(withToken)
    assert.fail('should have thrown')
  } catch (e) {
    assert.ok(!String((e as Error).message).includes('sk-ant'))
  }
})

test('settings are shown with paths shortened and anything secret-shaped redacted', () => {
  const out = buildDiagnostics(input({
    settings: {
      'tokenPace.claudeQuotaFile': `${HOME}/.cache/claude-monitor/usage-claude.json`,
      'tokenPace.claudeDir': [`${HOME}/.claude`, '/opt/claude'],
      'tokenPace.debug': false,
      'tokenPace.alerts.thresholds': [80, 95],
      'tokenPace.apiToken': 'sk-ant-oat01-not-a-real-token',
    },
  }))
  assert.match(out, /tokenPace\.claudeQuotaFile = "~\/\.cache\/claude-monitor\/usage-claude\.json"/)
  assert.match(out, /tokenPace\.claudeDir = \["~\/\.claude","\/opt\/claude"\]/)
  assert.match(out, /tokenPace\.debug = false/)
  assert.match(out, /tokenPace\.alerts\.thresholds = \[80,95\]/)
  assert.match(out, /tokenPace\.apiToken = <redacted>/)
  assert.ok(!out.includes('sk-ant'))
  assert.ok(!out.includes(HOME), 'no unshortened home path may survive')
})

test('a value can never break out of the fence', () => {
  const out = buildDiagnostics(input({ extVersion: '1.0.0```\n## Injected' }))
  assert.equal(out.split('```').length, 3)
})

test('proxy credentials are masked, host lists are not touched', () => {
  assert.equal(maskProxyUrl('http://user:s3cret@proxy.example:8080'), 'http://user:***@proxy.example:8080')
  assert.equal(maskProxyUrl('https://alice:pw@127.0.0.1:3128/path'), 'https://alice:***@127.0.0.1:3128/path')
  assert.equal(maskProxyUrl('http://proxy.example:8080'), 'http://proxy.example:8080')
  assert.equal(maskProxyUrl('localhost,127.0.0.1,.internal'), 'localhost,127.0.0.1,.internal')
  assert.equal(maskProxyUrl(''), '')
})

test('the report masks the proxy environment it prints', () => {
  const out = buildDiagnostics(input({
    proxyEnv: [{ name: 'HTTPS_PROXY', value: 'http://user:s3cret@proxy.example:8080' }],
  }))
  assert.match(out, /HTTPS_PROXY .*user:\*\*\*@proxy\.example:8080/)
  assert.ok(!out.includes('s3cret'))
})

test('tildify shortens only a real home prefix', () => {
  assert.equal(tildify(`${HOME}/.claude/projects`, HOME), '~/.claude/projects')
  assert.equal(tildify(HOME, HOME), '~')
  assert.equal(tildify(`${HOME}/`, HOME), '~/')
  assert.equal(tildify('/home/tester2/.claude', HOME), '/home/tester2/.claude')
  assert.equal(tildify('/opt/claude', HOME), '/opt/claude')
  assert.equal(tildify('/opt/claude', ''), '/opt/claude')
  assert.equal(tildify('C:\\Users\\t\\.claude', 'C:\\Users\\t'), '~\\.claude')
})

test('collectProxyEnv reports only what is set', () => {
  const found = collectProxyEnv({ HTTPS_PROXY: 'http://p:1', no_proxy: 'localhost', HTTP_PROXY: '' })
  assert.deepEqual(found, [
    { name: 'HTTPS_PROXY', value: 'http://p:1' },
    { name: 'no_proxy', value: 'localhost' },
  ])
})

test('http settings report where the effective value comes from', () => {
  const values: Record<string, unknown> = { proxy: 'http://p:8080', proxySupport: 'override', proxyStrictSSL: true }
  const inspects: Record<string, InspectLike<unknown>> = {
    proxy: { defaultValue: '', globalValue: 'http://p:8080' },
    proxySupport: { defaultValue: 'override', workspaceValue: 'override' },
    proxyStrictSSL: { defaultValue: true },
  }
  const api: VscodeConfigApi = {
    workspace: {
      getConfiguration: () => ({
        get: <T>(key: string) => values[key] as T | undefined,
        inspect: <T>(key: string) => inspects[key] as InspectLike<T> | undefined,
      }),
    },
  }
  const http = collectHttpSettings(api)
  assert.equal(http.proxy.origin, 'user')
  assert.equal(http.proxySupport.origin, 'workspace')
  assert.equal(http.proxyStrictSSL.origin, 'default')
  assert.equal(http.proxy.value, 'http://p:8080')

  assert.deepEqual(collectSettings(api, ['proxy']), { proxy: 'http://p:8080' })
})

test('no route through the report can print the real home directory', () => {
  const out = buildDiagnostics(input({
    // A root the caller forgot to shorten, and a value under a key the path
    // pattern does not match: the two ways the promise could have been broken.
    roots: [`${HOME}/.claude/projects`, '/opt/claude/projects'],
    settings: {
      'tokenPace.claudeDir': [`${HOME}/.claude`],
      'tokenPace.userAgent': `token-pace (${HOME})`,
      'tokenPace.dashboard.mode': 'view',
    },
    quota: [{
      source: 'codex',
      candidates: [{ id: 'rollout', ok: false, ageSec: null, problem: `No sessions under ${HOME}/.codex` }],
      backoffEndsAt: null,
      drift: [`${HOME}/.codex/x`],
    }],
    proxyEnv: [{ name: 'HTTPS_PROXY', value: 'http://proxy.example:8080' }],
  }))

  assert.equal(out.includes(HOME), false, 'the home directory survived somewhere in the report')
  assert.match(out, /~\/\.claude\/projects/)
  assert.match(out, /token-pace \(~\)/)
  assert.match(out, /No sessions under ~\/\.codex/)
})

test('a Windows home does not survive JSON escaping', () => {
  // `JSON.stringify` doubles every separator, so a scrub applied to the finished
  // JSON looks for `C:\Users\jane` in a string that reads `C:\\Users\\jane`.
  const WIN = 'C:\\Users\\jane'
  assert.equal(scrubHome(`"C:\\\\Users\\\\jane\\\\x"`, WIN), '"~\\\\x"')

  const out = buildDiagnostics(input({
    home: WIN,
    roots: [`${WIN}\\.claude\\projects`],
    quota: [],
    settings: {
      'tokenPace.claudeDir': [`${WIN}\\.claude`],
      'tokenPace.userAgent': `token-pace (${WIN}\\x)`,
      'tokenPace.dashboard.mode': 'view',
    },
  }))

  assert.equal(out.includes('jane'), false, 'the account name survived somewhere in the report')
  assert.ok(out.includes('tokenPace.claudeDir = ["~\\\\.claude"]'))
  assert.ok(out.includes('tokenPace.userAgent = "token-pace (~\\\\x)"'))
})

// 1.7 P7b (pinned and changed: the line said `backoff until`): the time is the next attempt our own
// fetch wants since P4b — a backoff's end, or the moment a fresh reading of another source turns old.
test('each quota source names the kind and the time of our last failed attempt — never its words (1.7 P4b)', () => {
  const at = Date.UTC(2026, 8, 24, 11, 40, 0)
  const out = buildDiagnostics(input({
    quota: [
      { source: 'claude', candidates: [], backoffEndsAt: at + 72 * 60_000, lastFailure: { kind: 'retry', at }, drift: [] },
      { source: 'codex', candidates: [], backoffEndsAt: null, lastFailure: null, drift: [] },
    ],
  }))
  assert.ok(out.includes('claude — next attempt 2026-09-24T12:52:00.000Z · last failed attempt 2026-09-24T11:40:00.000Z [retry]'), out)
  assert.ok(out.includes('codex — next attempt none · last failed attempt none'), out)
  // A permanent kind is reported like any other: the report is for the one who debugs it.
  assert.match(buildDiagnostics(input({
    quota: [{ source: 'codex', candidates: [], backoffEndsAt: null, lastFailure: { kind: 'noBinary', at }, drift: [] }],
  })), /codex — next attempt none · last failed attempt 2026-09-24T11:40:00\.000Z \[noBinary\]/)
  // Without the field (a caller of an older shape) it is `none`, and a kind that is no code of ours
  // cannot carry anything into the report but letters.
  assert.match(buildDiagnostics(input()), /claude — next attempt none · last failed attempt none/)
  const odd = buildDiagnostics(input({
    quota: [{ source: 'claude', candidates: [], backoffEndsAt: null, lastFailure: { kind: 'retry```\n## Settings\n[x](command:y) HTTP 429', at }, drift: [] }],
  }))
  assert.match(odd, /last failed attempt 2026-09-24T11:40:00\.000Z \[retrySettingsxcommandyHTTP\]/)
  assert.equal(odd.split('\n').filter((l) => l === '## Settings').length, 1, odd)
  for (const bad of [{ kind: 'retry', at: NaN }, { kind: 7, at }, null]) {
    const text = buildDiagnostics(input({ quota: [{ source: 'claude', candidates: [], backoffEndsAt: null, lastFailure: bad as never, drift: [] }] }))
    assert.match(text, /claude — next attempt none · last failed attempt none/, JSON.stringify(bad))
  }
})

// 1.7 P7b (Review 2 #4): the time the line prints is the next attempt we want — since P4b the state's
// `nextAttemptAt`, a backoff's end included — so the line says that, and docs/export.md quotes the line
// exactly as the report prints it.
test('each quota source says when its next attempt is, in the words docs/export.md quotes — no "backoff until" (1.7 P7b)', () => {
  const at = Date.UTC(2026, 8, 24, 11, 40, 0)
  const out = buildDiagnostics(input({
    quota: [{ source: 'claude', candidates: [], backoffEndsAt: at + 72 * 60_000, lastFailure: { kind: 'retry', at }, drift: [] }],
  }))
  const line = out.split('\n').find((l) => l.startsWith('claude — ')) as string
  assert.equal(line, 'claude — next attempt 2026-09-24T12:52:00.000Z · last failed attempt 2026-09-24T11:40:00.000Z [retry]')
  assert.equal(/backoff/i.test(out), false, out)
  // No attempt planned (none made yet, or a mode that makes none) is `none`, never a date.
  for (const none of [null, NaN, Infinity]) {
    const text = buildDiagnostics(input({ quota: [{ source: 'claude', candidates: [], backoffEndsAt: none, lastFailure: null, drift: [] }] }))
    assert.match(text, /^claude — next attempt none · last failed attempt none$/m, String(none))
  }
  const doc = readFileSync(join(__dirname, '..', 'docs', 'export.md'), 'utf8').replace(/\s+/g, ' ')
  assert.ok(doc.includes('`' + line + '`'), 'docs/export.md does not quote the line: ' + line)
  assert.ok(doc.includes('one line with the next attempt our own fetch wants — the end of a backoff included — and the kind and the time of our own last failed attempt'),
    'docs/export.md does not say what the line names')
  assert.equal(/backoff until/.test(doc), false, 'docs/export.md still says "backoff until"')
})

test('the report names the language setting, the language shown and VS Code\'s tag — in English, whatever the language (1.9 §2.4)', () => {
  // The line is the report's own words, so a German or Japanese window prints it the same way.
  const cases: Array<[DiagnosticsInput['language'], string]> = [
    [{ setting: 'auto', shown: 'en', vscode: 'en' }, 'setting auto · shown en · VS Code en'],
    [{ setting: 'auto', shown: 'de', vscode: 'de-ch' }, 'setting auto · shown de · VS Code de-ch'],
    [{ setting: 'fr', shown: 'en', vscode: 'hu' }, 'setting fr · shown en · VS Code hu'],
    [{ setting: 'pt-br', shown: 'pt-br', vscode: 'de' }, 'setting pt-br · shown pt-br · VS Code de'],
    // A tag that is not one (the caller passes '' then) is a dash, never text the report repeats.
    [{ setting: 'auto', shown: 'en', vscode: '' }, 'setting auto · shown en · VS Code –'],
    [{ setting: 'auto', shown: 'en', vscode: 'x```y' }, 'setting auto · shown en · VS Code –'],
  ]
  try {
    for (const bundle of [undefined, { 'Language': 'Sprache', 'setting': 'Einstellung' }]) {
      setBundle(bundle)
      setLocale(bundle ? 'de' : undefined)
      for (const [language, line] of cases) {
        const out = buildDiagnostics(input({ language }))
        const row = out.split('\n').find((l) => l.startsWith('Language '))
        assert.ok(row, 'the report has no language line')
        assert.equal(row, `Language        ${line}`)
      }
    }
  } finally {
    setBundle(undefined)
    setLocale(undefined)
  }
})

test('the report is byte for byte the same under a German page: its figures keep the machine\'s \'.\' (1.10 B4, §3.0 h)', () => {
  // The decimals of the views follow the language since 1.10; the report is pasted into an issue and stays one text
  // in every language — its sizes ("1.2 MB", "210.0 kB") are toFixed's, not the reader's.
  const bundle = JSON.parse(readFileSync(join(__dirname, '..', 'l10n', 'bundle.l10n.de.json'), 'utf8')) as Record<string, string>
  const cases = [input(), input({ historySize: { samples: 12, bytes: 999_949, oldest: '2026-08-04' }, partialData: true })]
  const en = cases.map((c) => buildDiagnostics(c))
  assert.ok(en[0].includes('1.2 MB') && en[1].includes('999.9 kB'), en.join('\n'))
  try {
    setBundle(bundle)
    setLocale('de')
    setLang('de')
    assert.deepEqual(cases.map((c) => buildDiagnostics(c)), en)
  } finally {
    setBundle(undefined)
    setLocale(undefined)
    setLang(undefined)
  }
})

test('the codex connection line says which mode is live and where the standing connection is — every state, a follower\'s, and nothing but words and counts (1.12 A6 test 11, §0a.11)', () => {
  const line = (c: DiagnosticsInput['codexConnection']): string => {
    const out = buildDiagnostics(input({ codexConnection: c }))
    const l = out.split('\n').find((x) => x.startsWith('codex connection'))
    assert.ok(l, 'the report has no codex connection line')
    // It closes the quota sources section.
    const lines = out.split('\n')
    assert.ok(lines.indexOf(l) > lines.indexOf('## Quota sources') && lines.indexOf(l) < lines.indexOf('## Status line bridge'))
    return l
  }
  const now = 1_700_000_000_000
  const base = { mode: 'persistent' as const, role: 'leader' as const, restartsLastHour: 0, pushes: 0, lastPushAt: null, pid: 4242 }
  const cases: Array<[Parameters<typeof codexConnectionDiag>[0], string]> = [
    [{ ...base, state: 'off' }, 'codex connection — mode persistent · state off · restarts 0 in the last hour · pushes 0 · last push –'],
    [{ ...base, state: 'starting' }, 'codex connection — mode persistent · state starting · restarts 0 in the last hour · pushes 0 · last push –'],
    [{ ...base, state: 'ready', pushes: 3, lastPushAt: now - 42_000 }, 'codex connection — mode persistent · state ready · restarts 0 in the last hour · pushes 3 · last push 42 s ago'],
    [{ ...base, state: 'restarting', restartsLastHour: 2, pushes: 7, lastPushAt: now - 600_000 }, 'codex connection — mode persistent · state restarting · restarts 2 in the last hour · pushes 7 · last push 10 min ago'],
    [{ ...base, state: 'budgetSpent', restartsLastHour: 5 }, 'codex connection — mode persistent · state budgetSpent · restarts 5 in the last hour · pushes 0 · last push –'],
    [{ ...base, mode: 'oneShot', state: 'off' }, 'codex connection — mode oneShot · state off · restarts 0 in the last hour · pushes 0 · last push –'],
    // A follower keeps no child — whatever its (absent) connection would say.
    [{ ...base, role: 'follower', state: 'off' }, 'codex connection — mode persistent · state follower · restarts 0 in the last hour · pushes 0 · last push –'],
  ]
  for (const [status, expected] of cases) {
    const l = line(codexConnectionDiag(status, now))
    assert.equal(l, expected)
    // The pid is for the tests only (§2.1): the report prints none.
    assert.equal(l.includes('4242'), false)
  }
  assert.equal(line(null), 'codex connection — not reported')
  // Held to its words and counts: a hostile value is a `?` or a dash, never text the report repeats.
  const hostile = { mode: 'x```y', state: '/home/tester/codex', restartsLastHour: Number.NaN, pushes: -1, lastPushAgeSec: null } as unknown as DiagnosticsInput['codexConnection']
  assert.equal(line(hostile), 'codex connection — mode ? · state ? · restarts – in the last hour · pushes – · last push –')
})
