// SPDX-FileCopyrightText: 2026 Frederik Marx
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The diagnostics report is a promise: "paste this anywhere". The tests hold
 * the allow-list to that — an unknown field is an error, not a leak.
 */

import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import {
  buildDiagnostics, collectHttpSettings, collectProxyEnv, collectSettings, DiagnosticsInput,
  InspectLike, maskProxyUrl, scrubHome, tildify, VscodeConfigApi,
} from '../src/diagnostics'

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
