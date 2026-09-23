// SPDX-FileCopyrightText: 2026 Frederik Marx
// SPDX-License-Identifier: AGPL-3.0-or-later

import { test } from 'node:test'
import * as assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

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

// ---------------------------------------------------------------------------
// The read contract (1.6 §0a): which fields each reader of a Claude Code file may name
// ---------------------------------------------------------------------------

interface ContractRow {
  what: string
  file: string
  kind: 'fields' | 'regex' | 'tags'
  body?: string
  variable?: string
  regex?: string
  pattern?: RegExp
  fields: string[]
}
interface ContractOffender { what: string; file: string; unlisted: string[]; unread: string[]; error: string | null }

const contract = require('../scripts/check-privacy.mjs') as {
  READ_CONTRACT: ContractRow[]
  checkReadContract: (read?: (file: string) => string, rows?: ContractRow[]) => ContractOffender[]
  bodyOf: (src: string, signature: string) => string | null
  fieldsRead: (body: string, variable: string) => string[]
  constantOf: (src: string, name: string) => string | null
  quotedKeys: (definition: string) => string[]
}

const REPO = join(__dirname, '..')
const fromRepo = (file: string): string => readFileSync(join(REPO, file), 'utf8')

test('the read contract holds for the shipped sources: every reader names exactly the fields its row lists', () => {
  assert.deepEqual(contract.checkReadContract(fromRepo), [])
  // 1.5's readers, moved into the table unchanged (1.6 P2a) — the journal's since changed by P2b.
  const byWhat = new Map(contract.READ_CONTRACT.map((row) => [row.what, row]))
  assert.deepEqual(byWhat.get('the identity sidecar')?.fields, ['agentType', 'model', 'spawnDepth', 'toolUseId'])
  // 1.6 P2b (§0a.1): the journal's head is read on the raw line, its `key` compared within the
  // journal; the fallback parses a short line without the head for the same three fields.
  assert.deepEqual(byWhat.get('the workflow journal')?.fields, ['type', 'key', 'agentId'])
  assert.equal(byWhat.get('the workflow journal')?.kind, 'regex')
  assert.deepEqual(byWhat.get('the workflow journal (fallback)')?.fields, ['type', 'key', 'agentId'])
  assert.deepEqual(byWhat.get('an agent launch')?.fields, ['subagent_type', 'model', 'run_in_background'])
  assert.deepEqual(byWhat.get('the tool result')?.fields, ['agentId', 'status'])
  assert.deepEqual(byWhat.get('the reported totals')?.fields, ['totalTokens', 'totalDurationMs', 'totalToolUseCount'])
  assert.deepEqual(byWhat.get('the task notification')?.fields, ['tool-use-id', 'status'])
  for (const row of contract.READ_CONTRACT) assert.equal(row.file, 'src/agg.ts', row.what)
})

test('a reader that names one more field, or no longer reads a listed one, breaks the contract', () => {
  const src = [
    'function cleanMeta(v) {',
    '  const o = v',
    '  return { a: o.agentType, b: o?.model }',
    '}',
    'const NOTE_ID_RE = /<tool-use-id>([a-z]+)<\\/tool-use-id>/',
    'const HEAD_RE = /^\\{"type":"(a|b)"(?:,"key":"(x)")?/',
    'export const KEYS = [',
    "  'status', 'startTime',",
    ']',
  ].join('\n')
  const rows: ContractRow[] = [
    { what: 'meta', file: 'x.ts', kind: 'fields', body: 'function cleanMeta(', variable: 'o', fields: ['agentType', 'model'] },
    { what: 'note', file: 'x.ts', kind: 'tags', pattern: /const NOTE_\w+_RE = \/<([a-z-]+)>/g, fields: ['tool-use-id'] },
    { what: 'head', file: 'x.ts', kind: 'regex', regex: 'HEAD_RE', fields: ['type', 'key'] },
    { what: 'keys', file: 'x.ts', kind: 'regex', regex: 'KEYS', fields: ['status', 'startTime'] },
  ]
  const read = (text: string) => (file: string): string => {
    assert.equal(file, 'x.ts')
    return text
  }
  assert.deepEqual(contract.checkReadContract(read(src), rows), [])
  // One more field read: reported as unlisted.
  const more = src.replace('b: o?.model', 'b: o?.model, c: o.description')
  assert.deepEqual(contract.checkReadContract(read(more), rows),
    [{ what: 'meta', file: 'x.ts', unlisted: ['description'], unread: [], error: null }])
  // A listed field no longer read: reported as unread — the documentation would promise a read
  // that does not happen, or hide the one that replaced it.
  const less = src.replace(', b: o?.model', '')
  assert.deepEqual(contract.checkReadContract(read(less), rows),
    [{ what: 'meta', file: 'x.ts', unlisted: [], unread: ['model'], error: null }])
  // A key more in a raw-line pattern, and a tag more, are reads too.
  const pattern = src.replace('(?:,"key":"(x)")?', '(?:,"key":"(x)")?(?:,"label":"(y)")?')
    .replace('const NOTE_ID_RE', 'const NOTE_SUMMARY_RE = /<summary>(.*)<\\/summary>/\nconst NOTE_ID_RE')
  assert.deepEqual(contract.checkReadContract(read(pattern), rows).map((o) => [o.what, o.unlisted]),
    [['note', ['summary']], ['head', ['label']]])
  // A reader that is gone, or a file that cannot be read, is an error, never a pass.
  const gone = contract.checkReadContract(read(src.replace('function cleanMeta(', 'function other(')), rows)
  assert.deepEqual(gone.map((o) => [o.what, o.unread, typeof o.error]), [['meta', ['agentType', 'model'], 'string']])
  const unreadable = contract.checkReadContract(() => { throw new Error('ENOENT') }, rows)
  assert.equal(unreadable.length, rows.length)
  assert.ok(unreadable.every((o) => typeof o.error === 'string'))
})

test('the contract\'s readers: a body to its own closing brace, a constant to the end of its statement', () => {
  const src = 'class A {\r\n  private f(r) {\r\n    if (r.a) {\r\n      return r.b\r\n    }\r\n    return r?.c\r\n  }\r\n  g(r) { return r.d }\r\n}\r\n'
  const body = contract.bodyOf(src, 'private f(')
  assert.ok(body !== null)
  assert.deepEqual(contract.fieldsRead(body, 'r'), ['a', 'b', 'c'])
  assert.equal(contract.bodyOf(src, 'private h('), null)
  assert.deepEqual(contract.quotedKeys(contract.constantOf('const R = /"a":"(x|y)","b":\\d+/\nconst S = 1', 'R') ?? ''), ['a', 'b'])
  assert.deepEqual(contract.quotedKeys(contract.constantOf("const L = '\"is_error\":true'", 'L') ?? ''), ['is_error'])
  assert.deepEqual(contract.quotedKeys(contract.constantOf('const K = [\n  "x", \'y\',\n]\nconst Z = ["no"]', 'K') ?? ''), ['x', 'y'])
  assert.equal(contract.constantOf('const K = 1', 'Q'), null)
})

test('the CLI fails on a broken read contract and passes on a kept one', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tp-contract-'))
  try {
    mkdirSync(join(dir, 'dist'))
    mkdirSync(join(dir, 'src'))
    writeFileSync(join(dir, 'dist', 'extension.js'), 'const ENDPOINT = "https://api.anthropic.com/api/oauth/usage"\n')
    const agg = fromRepo('src/agg.ts')
    const run = (): { status: number | null; out: string } => {
      const r = spawnSync(process.execPath, [join(REPO, 'scripts', 'check-privacy.mjs')], { cwd: dir, encoding: 'utf8' })
      return { status: r.status, out: `${r.stdout}${r.stderr}` }
    }
    writeFileSync(join(dir, 'src', 'agg.ts'), agg)
    const kept = run()
    assert.equal(kept.status, 0, kept.out)
    assert.match(kept.out, /read contract: \d+ reader\(s\)/)
    // The sidecar reader starts to read the description: the gate stops it.
    const at = agg.indexOf('function cleanMeta(')
    assert.ok(at >= 0)
    const open = agg.indexOf('{', at) + 1
    writeFileSync(join(dir, 'src', 'agg.ts'), `${agg.slice(0, open)}\n  void o.description\n${agg.slice(open)}`)
    const broken = run()
    assert.equal(broken.status, 1, broken.out)
    assert.match(broken.out, /DIFF {2}the identity sidecar/)
    assert.match(broken.out, /read but not listed: description/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
