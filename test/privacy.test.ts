// SPDX-FileCopyrightText: 2026 Frederik Marx
// SPDX-License-Identifier: AGPL-3.0-or-later

import { test } from 'node:test'
import * as assert from 'node:assert/strict'

interface ScanResult {
  urls: Array<{ url: string; host: string; path: string; allowed: boolean; line: number }>
  offenders: Array<{ url: string; host: string; path: string; allowed: boolean; line: number }>
}

// The scanner is a plain .mjs so `npm run check:privacy` needs no build step; required here
// rather than imported so the TypeScript build does not need an .mjs declaration file.
const { scanBundle, DEFAULT_ALLOW, filesToScan } = require('../scripts/check-privacy.mjs') as {
  scanBundle: (text: string, allow?: string[]) => ScanResult
  DEFAULT_ALLOW: string[]
  filesToScan: () => string[]
}

test('an allowed host passes, an unknown one is reported', () => {
  const fake = [
    'const ENDPOINT = "https://api.anthropic.com/api/oauth/usage"',
    'const PRICES = "https://prices.example.com/v1/list.json"',
  ].join('\n')

  const { urls, offenders } = scanBundle(fake, DEFAULT_ALLOW)
  assert.equal(urls.length, 2)
  assert.equal(offenders.length, 1)
  assert.equal(offenders[0].host, 'prices.example.com')
  assert.equal(offenders[0].url, 'https://prices.example.com/v1/list.json')
  assert.ok(urls.some((u) => u.host === 'api.anthropic.com' && u.allowed))
})

test('a clean bundle has no offenders', () => {
  const clean = 'const usagePage = "https://claude.ai/settings/usage" // and https://chatgpt.com/codex/settings/usage'
  assert.deepEqual(scanBundle(clean, DEFAULT_ALLOW).offenders, [])
})

test('the allow-list is matched on host, and on the path prefix where one is given', () => {
  // claude.ai is allowed only for the usage page, not for the whole host.
  const other = 'fetch("https://claude.ai/api/organizations")'
  const result = scanBundle(other, DEFAULT_ALLOW)
  assert.equal(result.offenders.length, 1)
  assert.equal(result.offenders[0].host, 'claude.ai')

  // A host allowed without a path prefix matches any path.
  assert.deepEqual(scanBundle('"https://api.anthropic.com/anything"', DEFAULT_ALLOW).offenders, [])

  // github.com is allowed only under the project owner's namespace.
  assert.deepEqual(scanBundle('"https://github.com/mfvdp/VS-Code_Token-Usage"', DEFAULT_ALLOW).offenders, [])
  assert.equal(scanBundle('"https://github.com/someone-else/x"', DEFAULT_ALLOW).offenders.length, 1)
})

test('http is scanned as well as https, and duplicates are reported once', () => {
  const text = '"http://evil.example/a" ; "http://evil.example/a" ; "http://evil.example/b"'
  const { urls, offenders } = scanBundle(text, DEFAULT_ALLOW)
  assert.equal(urls.length, 2)
  assert.equal(offenders.length, 2)
  assert.ok(offenders.every((o) => o.host === 'evil.example'))
})

test('a custom allow-list is honoured', () => {
  const text = '"https://only.example/x"'
  assert.deepEqual(scanBundle(text, ['only.example']).offenders, [])
  assert.equal(scanBundle(text, []).offenders.length, 1)
})

test('trailing punctuation is not part of the URL, and the line number is reported', () => {
  const text = 'line one\nsee https://docs.claude.com/en/docs/claude-code.\n'
  const { urls } = scanBundle(text, DEFAULT_ALLOW)
  assert.equal(urls.length, 1)
  assert.equal(urls[0].url, 'https://docs.claude.com/en/docs/claude-code')
  assert.equal(urls[0].allowed, true)
  assert.equal(urls[0].line, 2)
})

test('the scan covers the shipped string files, not just the code bundles', () => {
  // VS Code reads the l10n bundle and the manifest strings at runtime, so a host introduced
  // in a translated sentence ships as surely as one in dist/. dist/ itself is not asserted
  // on: `npm test` does not build it.
  const files = filesToScan()
  assert.ok(files.some((f) => /l10n[\\/]bundle\.l10n\..+\.json$/.test(f)), files.join(' '))
  assert.ok(files.some((f) => /l10n[\\/]parts[\\/].+\.de\.json$/.test(f)), files.join(' '))
  assert.ok(files.some((f) => /^package\.nls.*\.json$/.test(f)), files.join(' '))
})

test('a host planted in a translated string is reported', () => {
  const bundle = '{\n  "a": "Preise: https://price-feed.example/v1/rates"\n}\n'
  const { offenders } = scanBundle(bundle, DEFAULT_ALLOW)
  assert.equal(offenders.length, 1)
  assert.equal(offenders[0].host, 'price-feed.example')
})
