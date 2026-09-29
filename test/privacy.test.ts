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

test('api.telegram.org is allowed for its channel, a service\'s webhook host is not — no host of a webhook or of ntfy is ever a literal (1.12 C11 rules 1 and 4)', () => {
  assert.ok(DEFAULT_ALLOW.includes('api.telegram.org'))
  assert.deepEqual(scanBundle('"https://api.telegram.org/bot${token}/sendMessage"', DEFAULT_ALLOW).offenders, [])
  for (const host of ['hooks.slack.com', 'discord.com', 'ntfy.sh', 'prod-00.westeurope.logic.azure.com', 'chat.example.org']) {
    assert.equal(scanBundle(`"https://${host}/x"`, DEFAULT_ALLOW).offenders.length, 1, host)
  }
  // C11 rule 1: the public ntfy server is named in docs/ only — never in a manifest description or a bundle.
  for (const f of filesToScan().filter((x) => !x.startsWith('dist'))) {
    assert.equal(readFileSync(join(REPO, f), 'utf8').includes('https://ntfy.sh'), false, f)
  }
})

// ---------------------------------------------------------------------------
// The network's call sites (1.12 C11): every place in src/ that can reach a host, with its kind of host and why
// ---------------------------------------------------------------------------

interface SiteRow { file: string; sites: string[]; hosts: string; reason: string }
interface SiteScan {
  sites: Array<{ file: string; site: string; line: number }>
  offenders: Array<{ file: string; site: string; line: number | null; problem: string }>
}
const sites = require('../scripts/check-privacy.mjs') as {
  NETWORK_SITES: SiteRow[]
  NETWORK_MODULES: string[]
  NETWORK_SITE_KINDS: string[]
  NETWORK_HOST_KINDS: string[]
  NETWORK_ENTRY_POINTS: Array<{ name: string; file: string; importers: string[]; reason: string }>
  scanNetworkSites: (read?: (file: string) => string, files?: string[], rows?: SiteRow[], entries?: Array<{ name: string; file: string; importers: string[]; reason: string }>) => SiteScan
  networkSitesIn: (src: string, opts?: { references?: boolean }) => Array<{ site: string; line: number }>
  sourceFiles: (root?: string) => string[]
  codeOf: (src: string) => { code: string; bare: string }
}
const readRepo = (file: string): string => readFileSync(join(__dirname, '..', file), 'utf8')
/** 1.12 P8: the SMTP sender's two kinds of site, as a fake tree's `src/notifySmtp.ts`. */
const SMTP_FAKE = 'import * as net from \'net\'\nimport * as tls from \'tls\'\nexport const c = () => net.connect(587, h)\nexport const s = () => tls.connect({ host: h, port: 465 })\n'

test('the network sites of the real tree: the quota fetch, the channels\' fetch and the SMTP sender\'s sockets, each with its row — and nothing else (1.12 C11 rules 2 and 4)', () => {
  const files = sites.sourceFiles(join(__dirname, '..'))
  assert.ok(files.includes('src/poller.ts') && files.includes('src/notifyChannels.ts') && files.includes('src/notifySmtp.ts') && files.includes('src/webview/main.ts'), files.join(' '))
  assert.ok(files.every((f) => f.startsWith('src/')))
  const scan = sites.scanNetworkSites(readRepo, files)
  assert.deepEqual(scan.offenders, [])
  // 1.12 P8 (pinned and changed): the SMTP sender's sites — the import of net and of tls, net.connect( once (the
  // plain connection for STARTTLS), tls.connect( twice (implicit TLS and the upgrade), in the order they stand.
  assert.deepEqual(scan.sites.map((x) => `${x.file}:${x.site}`), [
    'src/notifyChannels.ts:fetch',
    'src/notifySmtp.ts:net', 'src/notifySmtp.ts:tls', 'src/notifySmtp.ts:tls', 'src/notifySmtp.ts:net', 'src/notifySmtp.ts:tls',
    'src/poller.ts:fetch',
  ])
  // The table as C11 gives it, P8's row after P7's.
  assert.deepEqual(sites.NETWORK_SITES.map((r) => [r.file, r.sites, r.hosts]), [
    ['src/poller.ts', ['fetch'], 'literal'],
    ['src/notifyChannels.ts', ['fetch'], 'userConfigured'],
    ['src/notifySmtp.ts', ['net', 'tls'], 'userConfigured'],
  ])
  for (const row of sites.NETWORK_SITES) {
    assert.ok(row.reason.trim().length > 10, `${row.file}: a reason`)
    assert.ok(sites.NETWORK_HOST_KINDS.includes(row.hosts))
    assert.ok(row.sites.every((x) => sites.NETWORK_SITE_KINDS.includes(x)))
  }
  assert.match(sites.NETWORK_SITES[1].reason, /api\.telegram\.org/)
  assert.match(sites.NETWORK_SITES[2].reason, /SMTP server, allowed per host, TLS only/)
  assert.deepEqual(sites.NETWORK_MODULES, ['http', 'https', 'http2', 'net', 'tls', 'dgram', 'undici'])
})

test('a call site outside the table fails: fetch( in src/other.ts, a network module imported anywhere, a socket, a browser request (1.12 C11 rule 4)', () => {
  const tree = (extra: Record<string, string>): SiteScan => {
    // 1.12 P8 (pinned and changed): the tree carries the SMTP sender's file too — its row would be stale without it.
    const files = { 'src/poller.ts': 'res = await fetch(CLAUDE_USAGE_URL, {})\n', 'src/notifyChannels.ts': 'export const f = (u, i) => fetch(u, i)\n', 'src/notifySmtp.ts': SMTP_FAKE, ...extra }
    return sites.scanNetworkSites((f) => { if (!(f in files)) throw new Error('ENOENT'); return (files as Record<string, string>)[f] }, Object.keys(files))
  }
  assert.deepEqual(tree({}).offenders, [])
  // Review 3 F7 (pinned and changed): a case may name more than one site — the re-export of undici's fetch is a
  // reference to fetch as well.
  const cases: Array<[string, string | string[]]> = [
    ['const r = await fetch(url)', 'fetch'],
    ['const r = await globalThis.fetch (url)', 'fetch'],
    ['import * as https from \'https\'', 'https'],
    ['import { request } from "node:http"', 'http'],
    ['import \'dgram\'', 'dgram'],
    ['const net = require(\'net\')', 'net'],
    ['const tls = await import(\'node:tls\')', 'tls'],
    ['export { fetch } from \'undici\'', ['fetch', 'undici']],
    ['import { Agent } from \'undici/lib/agent\'', 'undici'],
    ['import * as h2 from \'http2\'', 'http2'],
    ['tls.connect({ host, port })', 'tls'],
    ['net.createConnection(port, host)', 'net'],
    ['https.get(url, cb)', 'https'],
    ['http.request(opts)', 'http'],
    ['const ws = new WebSocket(url)', 'WebSocket'],
    ['const x = new XMLHttpRequest()', 'XMLHttpRequest'],
    ['navigator.sendBeacon(url, body)', 'sendBeacon'],
    ['const es = new window.EventSource(url)', 'EventSource'],
    ['const s = `${await fetch(url)}`', 'fetch'],
  ]
  for (const [code, site] of cases) {
    const scan = tree({ 'src/other.ts': `// a file\n${code}\n` })
    assert.deepEqual(scan.offenders.map((o) => [o.file, o.site, o.line, o.problem]),
      (Array.isArray(site) ? site : [site]).map((x) => ['src/other.ts', x, 2, 'no row in NETWORK_SITES']), code)
  }
  // The same in a file that has a row, but not among the row's sites.
  const beside = tree({ 'src/notifyChannels.ts': 'import * as tls from \'tls\'\nexport const f = (u, i) => fetch(u, i)\n' })
  assert.deepEqual(beside.offenders.map((o) => [o.file, o.site, o.problem]), [['src/notifyChannels.ts', 'tls', 'not among its row\'s sites']])
  // 1.12 P8: the SMTP sender may open sockets, never fetch — and a socket beside the channels' fetch is no channel's.
  const smtpFetch = tree({ 'src/notifySmtp.ts': `${SMTP_FAKE}export const g = (u) => fetch(u)\n` })
  assert.deepEqual(smtpFetch.offenders.map((o) => [o.file, o.site, o.problem]), [['src/notifySmtp.ts', 'fetch', 'not among its row\'s sites']])
  const channelSocket = tree({ 'src/notifyChannels.ts': 'export const f = (u, i) => fetch(u, i)\nexport const s = () => net.connect(25, h)\n' })
  assert.deepEqual(channelSocket.offenders.map((o) => [o.file, o.site, o.problem]), [['src/notifyChannels.ts', 'net', 'not among its row\'s sites']])
})

/** A fake tree with the three rows' files, and `extra` beside them. */
function siteTree(extra: Record<string, string>): SiteScan {
  const files: Record<string, string> = {
    'src/poller.ts': 'res = await fetch(CLAUDE_USAGE_URL, {})\n',
    'src/notifyChannels.ts': 'export const httpsFetch = (u, i) => fetch(u, i)\n',
    'src/notifySmtp.ts': `${SMTP_FAKE}export function smtpTransport() { return { c, s } }\n`,
    ...extra,
  }
  return sites.scanNetworkSites((f) => { if (!(f in files)) throw new Error('ENOENT'); return files[f] }, Object.keys(files))
}

test('Review 3 F7 (a): fetch itself is a site, not only its call — bound to another name, handed on, reached through a global object or looked up by its name, in a file without a row, fails; a property\'s name, an injected deps.fetch and typeof fetch do not count (1.12 C11 rule 2)', () => {
  assert.deepEqual(siteTree({}).offenders, [])
  const bypasses = [
    // Review 3's three forms.
    '(globalThis as any)[\'fetch\'](u)',
    'const f = fetch; f(u)',
    'Reflect.apply(fetch, globalThis, [u])',
    // And their kin.
    'const g = globalThis.fetch',
    'const g = (globalThis as any).fetch',
    'const w = window?.fetch',
    'const s = self.fetch',
    'const f = Reflect.get(globalThis, "fetch")',
    'const f = globalThis[`fetch`]',
    'const d = { fetch }',
    'const pick = online ? fetch : offline',
    'run(fetch)',
    'import { fetch } from \'node-fetch\'',
  ]
  for (const code of bypasses) {
    const scan = siteTree({ 'src/other.ts': `// a file\n${code}\n` })
    assert.deepEqual(scan.offenders.map((o) => [o.file, o.site, o.line, o.problem]), [['src/other.ts', 'fetch', 2, 'no row in NETWORK_SITES']], code)
  }
  const names = [
    'interface Deps { fetch: FetchLike; fetch2?: F; fetch?: F }',
    'const deps = { fetch: injected }',
    'send(url, this.deps.fetch)',
    'function send(url: string, fetch: FetchLike) { return url }',
    'const ok = typeof fetch === \'function\'',
    'const help = "it\'s \'fetch\' in a sentence"',
    'const q = \'fetchy\'',
    '// const f = fetch',
  ]
  for (const code of names) assert.deepEqual(siteTree({ 'src/other.ts': `${code}\n` }).offenders, [], code)
  // The calls-only form, which the test tree's own static test asks for.
  assert.deepEqual(sites.networkSitesIn('const f = fetch; f(u)', { references: false }), [])
  assert.deepEqual(sites.networkSitesIn('const f = fetch; f(u)'), [{ site: 'fetch', line: 1 }])
})

test('Review 3 F7 (b): httpsFetch and smtpTransport are handed on by src/extension.ts alone — an import of either anywhere else fails, as a named import, a member of a namespace import, a require or a string; their own modules and src/extension.ts pass (1.12 C11 rule 2)', () => {
  assert.deepEqual(sites.NETWORK_ENTRY_POINTS.map((e) => [e.name, e.file, e.importers]), [
    ['httpsFetch', 'src/notifyChannels.ts', ['src/extension.ts']],
    ['smtpTransport', 'src/notifySmtp.ts', ['src/extension.ts']],
  ])
  for (const e of sites.NETWORK_ENTRY_POINTS) assert.ok(e.reason.trim().length > 10, e.name)
  const allowed = siteTree({ 'src/extension.ts': 'import { httpsFetch } from \'./notifyChannels\'\nimport { smtpTransport } from \'./notifySmtp\'\nhost({ fetch: httpsFetch, smtp: smtpTransport() })\n' })
  assert.deepEqual(allowed.offenders, [])
  const importers: Array<[string, string, string]> = [
    ['src/notifyHost.ts', 'import { httpsFetch } from \'./notifyChannels\'', 'httpsFetch'],
    ['src/notifyHost.ts', 'import { httpsFetch as f } from \'./notifyChannels\'', 'httpsFetch'],
    ['src/quota.ts', 'import * as ch from \'./notifyChannels\'\nvoid ch.httpsFetch', 'httpsFetch'],
    ['src/quota.ts', 'const t = require(\'./notifySmtp\').smtpTransport()', 'smtpTransport'],
    ['src/quota.ts', 'import * as smtp from \'./notifySmtp\'\nconst t = (smtp as any)[\'smtpTransport\']()', 'smtpTransport'],
    ['src/poller.ts', 'import { smtpTransport } from \'./notifySmtp\'\nres = await fetch(CLAUDE_USAGE_URL, {})', 'smtpTransport'],
  ]
  for (const [file, code, name] of importers) {
    const scan = siteTree({ [file]: `${code}\n` })
    const line = code.split('\n').findIndex((l) => l.includes(name)) + 1
    const own = name === 'httpsFetch' ? 'src/notifyChannels.ts' : 'src/notifySmtp.ts'
    assert.deepEqual(scan.offenders.map((o) => [o.file, o.site, o.line, o.problem]), [[file, name, line, `only src/extension.ts may import it (${own})`]], code)
  }
  // A comment or a longer name is no import.
  assert.deepEqual(siteTree({ 'src/notifyHost.ts': '/** notifyChannels.ts `httpsFetch` — a test\'s fake. */\nconst httpsFetcher = 1\n' }).offenders, [])
})

test('a row that no longer holds fails: its site gone, its file gone; a row without a reason or with an unknown kind fails (1.12 C11 rule 4)', () => {
  const files: Record<string, string> = { 'src/poller.ts': 'res = await fetch(URL)\n', 'src/notifyChannels.ts': 'export const f = 1\n', 'src/notifySmtp.ts': SMTP_FAKE }
  const read = (f: string): string => { if (!(f in files)) throw new Error('ENOENT'); return files[f] }
  const stale = sites.scanNetworkSites(read, Object.keys(files))
  assert.deepEqual(stale.offenders.map((o) => [o.file, o.site, o.problem]), [['src/notifyChannels.ts', 'fetch', 'listed but not found (a stale row)']])
  // 1.12 P8: the SMTP sender's row holds only while it has both kinds of socket.
  files['src/notifyChannels.ts'] = 'export const f = (u, i) => fetch(u, i)\n'
  files['src/notifySmtp.ts'] = 'import * as net from \'net\'\nexport const c = () => net.connect(587, h)\n'
  const halfSmtp = sites.scanNetworkSites(read, Object.keys(files))
  assert.deepEqual(halfSmtp.offenders.map((o) => [o.file, o.site, o.problem]), [['src/notifySmtp.ts', 'tls', 'listed but not found (a stale row)']])
  files['src/notifySmtp.ts'] = SMTP_FAKE
  files['src/notifyChannels.ts'] = 'export const f = 1\n'
  delete files['src/notifyChannels.ts']
  const gone = sites.scanNetworkSites(read, Object.keys(files))
  assert.deepEqual(gone.offenders.map((o) => [o.file, o.problem]), [['src/notifyChannels.ts', 'cannot read src/notifyChannels.ts']])
  const rows: SiteRow[] = [
    { file: 'src/poller.ts', sites: ['fetch'], hosts: 'literal', reason: ' ' },
    { file: 'src/a.ts', sites: ['fetch'], hosts: 'anywhere', reason: 'a reason' },
    { file: 'src/b.ts', sites: ['smtp'], hosts: 'literal', reason: 'a reason' },
    { file: 'src/c.ts', sites: [], hosts: 'literal', reason: 'a reason' },
  ]
  const own: Record<string, string> = { 'src/poller.ts': 'fetch(u)', 'src/a.ts': 'fetch(u)', 'src/b.ts': '', 'src/c.ts': '' }
  const bad = sites.scanNetworkSites((f) => own[f], Object.keys(own), rows)
  assert.deepEqual(bad.offenders.map((o) => [o.file, o.problem]), [
    ['src/poller.ts', 'a row without its reason'],
    ['src/a.ts', 'an unknown kind of host: anywhere'],
    ['src/b.ts', 'an unknown site'],
    ['src/c.ts', 'a row without a site'],
    ['src/b.ts', 'listed but not found (a stale row)'],
  ])
})

test('a comment or a string that names a call is no call; a template\'s ${…} is code (1.12 C11 rule 2)', () => {
  const quiet = [
    '// answers the fetch (`runPolls` then skips it)',
    '/* tls.connect(host) and require(\'https\') */',
    '/**\n * the fetch (and the net.connect( of old)\n */',
    'const help = \'call fetch(url) yourself\'',
    'const glob = "**/*.ts" // and a fetch( after it',
    'const tpl = `fetch(${1 + 1}) is text`',
    'const re = /fetch\\(|["\'`]/g',
    'if (x) { y = a / b / c } // fetch(',
    'const url = \'https://example.invalid\'; const n = 2 // fetch(',
  ]
  for (const line of quiet) assert.deepEqual(sites.networkSitesIn(line), [], line)
  assert.deepEqual(sites.networkSitesIn('const tpl = `a ${await fetch(u)} b`'), [{ site: 'fetch', line: 1 }])
  assert.deepEqual(sites.networkSitesIn('const u = \'https://x.invalid\'; void fetch(u)'), [{ site: 'fetch', line: 1 }])
  assert.deepEqual(sites.networkSitesIn('const t = `x\n${`y${fetch(u)}`}\nz`\nfetch(v)'), [{ site: 'fetch', line: 2 }, { site: 'fetch', line: 4 }])
  // Not a call: another name that ends or starts with the word.
  assert.deepEqual(sites.networkSitesIn('prefetch(x); fetchNow(y); this.fetchQuota(z); const fetched = 1'), [])
  // The lexer keeps the code of every source file: each line that starts with `import` or `export` is itself in
  // the blanked text, up to a comment at its end — nothing of a file is lost to a misread string or pattern.
  for (const f of sites.sourceFiles(join(__dirname, '..'))) {
    const src = readRepo(f)
    const { code, bare } = sites.codeOf(src)
    assert.equal(code.length, src.length, f)
    assert.equal(bare.length, src.length, f)
    const lines = src.split('\n')
    const kept = code.split('\n')
    lines.forEach((l, i) => {
      if (/^(import|export) /.test(l)) assert.ok(l.startsWith(kept[i].trimEnd()) && kept[i].trim().length > 6, `${f}:${i + 1}`)
    })
  }
})

// ---------------------------------------------------------------------------
// The read contract (1.6 §0a): which fields each reader of a Claude Code file may name
// ---------------------------------------------------------------------------

interface ContractRow {
  what: string
  file: string
  source?: string
  kind: 'fields' | 'regex' | 'tags' | 'picks'
  body?: string
  variable?: string
  regex?: string
  pattern?: RegExp
  fields: string[]
  pages?: string[]
}
interface ContractOffender { what: string; file: string; unlisted: string[]; unread: string[]; error: string | null }

const contract = require('../scripts/check-privacy.mjs') as {
  READ_CONTRACT: ContractRow[]
  checkReadContract: (read?: (file: string) => string, rows?: ContractRow[]) => ContractOffender[]
  bodyOf: (src: string, signature: string) => string | null
  fieldsRead: (body: string, variable: string) => string[]
  constantOf: (src: string, name: string) => string | null
  quotedKeys: (definition: string) => string[]
  picksRead: (body: string, variable: string) => string[]
  scanHookBundle: (text: string, allowed?: string[], forbidden?: string[]) => { modules: string[]; offenders: string[] }
  scanBridgeBundle: (text: string) => { modules: string[]; offenders: string[] }
  HOOK_BUNDLE: string
  HOOK_ALLOWED_MODULES: string[]
  HOOK_FORBIDDEN_MODULES: string[]
  BRIDGE_BUNDLE: string
  BRIDGE_ALLOWED_MODULES: string[]
  BRIDGE_FORBIDDEN_MODULES: string[]
}

const REPO = join(__dirname, '..')
const fromRepo = (file: string): string => readFileSync(join(REPO, file), 'utf8')

test('the read contract holds for the shipped sources: every reader names exactly the fields its row lists', () => {
  assert.deepEqual(contract.checkReadContract(fromRepo), [])
  // 1.5's readers, moved into the table unchanged (1.6 P2a) — the journal's since changed by P2b.
  const byWhat = new Map(contract.READ_CONTRACT.map((row) => [row.what, row]))
  // 1.6 P13a (§0a.11, pinned and changed): the sidecar's fifth field, the spawning agent's id.
  assert.deepEqual(byWhat.get('the identity sidecar')?.fields, ['agentType', 'model', 'spawnDepth', 'toolUseId', 'parentAgentId'])
  // 1.6 P2b (§0a.1): the journal's head is read on the raw line, its `key` compared within the
  // journal; the fallback parses a short line without the head for the same three fields.
  assert.deepEqual(byWhat.get('the workflow journal')?.fields, ['type', 'key', 'agentId'])
  assert.equal(byWhat.get('the workflow journal')?.kind, 'regex')
  assert.deepEqual(byWhat.get('the workflow journal (fallback)')?.fields, ['type', 'key', 'agentId'])
  assert.deepEqual(byWhat.get('an agent launch')?.fields, ['subagent_type', 'model', 'run_in_background'])
  assert.deepEqual(byWhat.get('the tool result')?.fields, ['agentId', 'status'])
  assert.deepEqual(byWhat.get('the reported totals')?.fields, ['totalTokens', 'totalDurationMs', 'totalToolUseCount'])
  assert.deepEqual(byWhat.get('the task notification')?.fields, ['tool-use-id', 'status'])
  // 1.6 P4 (§0a.3): the blocks of a reply the launches come from — `input` only for an agent's —
  // and the result that answers a `Workflow` call, in a method of its own, so the agent's result
  // keeps exactly its two fields.
  assert.deepEqual(byWhat.get('the launch blocks')?.fields, ['type', 'name', 'id', 'input'])
  assert.deepEqual(byWhat.get('the workflow result')?.fields, ['runId', 'status'])
  assert.equal(byWhat.get('the workflow result')?.body, 'private runResult(')
  // 1.6 P13a (§0a.6–0a.10): the two raw-line gates are regex rows — their lines are never parsed —,
  // the diagnostics a row per level, the compaction's line and its metadata one each.
  assert.deepEqual([byWhat.get('tool errors')?.kind, byWhat.get('tool errors')?.fields], ['regex', ['is_error']])
  assert.deepEqual([byWhat.get('the permission mode')?.kind, byWhat.get('the permission mode')?.fields], ['regex', ['permissionMode']])
  // 1.8 P5 (§0a.5): a user line's top-level `type`, on the raw line as well — the line is never parsed for it.
  assert.deepEqual([byWhat.get('a user line')?.kind, byWhat.get('a user line')?.fields], ['regex', ['type']])
  // 1.9 P17 (§0a.1): the time of a main transcript's newest user line — its unescaped `timestamp` key, on
  // the raw line of a user line, never parsed; held to the privacy page and the prompt-cache page, the
  // page of its one use (the keep-warm line's G13 bound).
  const userTime = byWhat.get('the time of a user line')
  assert.deepEqual([userTime?.kind, userTime?.regex, userTime?.fields, userTime?.source, userTime?.pages],
    ['regex', 'USER_LINE_TIME_RE', ['timestamp'], '~/.claude/projects/', ['privacy', 'promptCache']])
  assert.deepEqual(byWhat.get('a cache miss')?.fields, ['diagnostics'])
  assert.deepEqual(byWhat.get('a cache miss\'s diagnostics')?.fields, ['cache_miss_reason'])
  assert.deepEqual(byWhat.get('a cache miss\'s reason')?.fields, ['type', 'cache_missed_input_tokens'])
  assert.deepEqual(byWhat.get('the writer\'s version')?.fields, ['version'])
  assert.deepEqual(byWhat.get('a compaction')?.fields, ['type', 'subtype', 'compactMetadata'])
  assert.deepEqual(byWhat.get('a compaction\'s metadata')?.fields, ['trigger', 'preTokens', 'postTokens'])
  // 1.6 P13b (§0a.12): Claude Code's run record — the key-picker's seven keys, a regex row over its
  // key list, and the check of each value. 1.6 P13b (pinned and changed): the two rows read
  // src/runRecord.ts; every other reader is the aggregator's.
  const seven = ['status', 'startTime', 'durationMs', 'agentCount', 'totalTokens', 'totalToolCalls', 'defaultModel']
  assert.deepEqual([byWhat.get('the run record')?.kind, byWhat.get('the run record')?.fields], ['regex', seven])
  assert.deepEqual([byWhat.get('the run record\'s values')?.kind, byWhat.get('the run record\'s values')?.fields], ['fields', seven])
  // 1.6 P14b (§0a.13): the agent hook — the script's four keys of a hook call's input, and the
  // reader's six fields of a mirror line.
  assert.deepEqual(byWhat.get('the agent hook\'s input')?.fields, ['hook_event_name', 'session_id', 'agent_id', 'notification_type'])
  assert.deepEqual(byWhat.get('the agent hook\'s mirror')?.fields, ['v', 'ts', 'event', 'sessionId', 'agentId', 'wait'])
  // 1.6 P13b (pinned and changed by P14b, 1.8 P4 and 1.8 review 2): the two run-record rows read
  // src/runRecord.ts, the two agent-hook rows the hook's own two files, the status-line mirror's rows
  // (1.8 §0a.1) src/quota.ts — but the narrowing at activation (§7a Q11), which src/bridge.ts does;
  // every other reader is the aggregator's.
  const NARROWED = 'the status-line mirror, narrowed at activation'
  const mirrorRow = (what: string): boolean => what === 'the status-line mirror' || what === NARROWED || what.startsWith('the status line\'s ')
  // 1.8 P10 (§0a.6–§0a.8, pinned and changed): the keep-warm host's rows read src/keepWarmHost.ts.
  // 1.10 P2 (§0a.3, pinned and changed): the six terminal rows read src/terminalWatch.ts — the watch moved
  // out of the host unchanged —, and so do the prompt tool's rows of the folder the shell integration
  // reports; the line typed and keepwarm.json stay the host's.
  const keepWarmRow = (what: string): boolean => what.startsWith('keep-warm: ')
  const promptsRow = (what: string): boolean => what.startsWith('prompts: ')
  const hostRow = (what: string): boolean => what === 'keep-warm: the line typed' || what.startsWith('keep-warm: the accounting') || what === 'keep-warm: a day of the accounting'
  // 1.10 P3 (§0a.1, pinned and changed): the prompt list's two rows read src/prompts.ts, where the file's
  // shape is checked.
  const listRow = (what: string): boolean => what === 'prompts: the list file' || what === 'prompts: an entry of the list'
  // 1.10 P4 (§0a.4, pinned and changed): the prompt typed reads src/promptsHost.ts, where `typePrompt` writes it.
  const typedRow = (what: string): boolean => what === 'prompts: the prompt typed'
  // 1.12 P5 (§0a.4, pinned and changed): the credentials document's two rows read src/credentials.ts.
  const credentialsRow = (what: string): boolean => what === 'the credentials document' || what === 'the credentials document\'s token'
  // 1.12 P6 (§0a.10, pinned and changed): the notification payload's row reads src/notify.ts, where `payloadOf` builds it.
  const payloadRow = (what: string): boolean => what === 'the notification payload'
  // 1.14 P4 (§0a.1–§0a.4): the four attribution readers, the aggregator's.
  const attributionRow = (what: string): boolean => what.startsWith('attribution: ')
  const watchRow = (what: string): boolean => (keepWarmRow(what) && !hostRow(what)) || (promptsRow(what) && !listRow(what) && !typedRow(what))
  const fileOf = (what: string): string => what.startsWith('the run record') ? 'src/runRecord.ts'
    : what === 'the agent hook\'s input' ? 'src/agentHookScript.ts' : what === 'the agent hook\'s mirror' ? 'src/agentHook.ts'
      : what === NARROWED ? 'src/bridge.ts' : mirrorRow(what) ? 'src/quota.ts' : listRow(what) ? 'src/prompts.ts' : typedRow(what) ? 'src/promptsHost.ts'
        : watchRow(what) ? 'src/terminalWatch.ts' : keepWarmRow(what) ? 'src/keepWarmHost.ts'
          : credentialsRow(what) ? 'src/credentials.ts' : payloadRow(what) ? 'src/notify.ts' : 'src/agg.ts'
  for (const row of contract.READ_CONTRACT) assert.equal(row.file, fileOf(row.what), row.what)
  // 1.8 §0a.1 (P4): the mirror's reader, level by level — the envelope, the payload's top-level
  // fields with 1.8's `session_id`, and of each block what is taken, the prompt cache's
  // `recache_tokens_if_cold` among it. Held to the privacy page and the prompt-cache page; every
  // other row keeps the default pages.
  const rows = contract.READ_CONTRACT.filter((row) => mirrorRow(row.what))
  assert.deepEqual(rows.map((row) => [row.what, row.kind, row.fields]), [
    ['the status-line mirror', 'fields', ['schema_version', 'written_at', 'payload']],
    [NARROWED, 'fields', ['schema_version', 'written_at', 'payload']],
    ['the status line\'s session', 'picks', ['rate_limits', 'rateLimits', 'plan', 'subscription', 'context_window', 'contextWindow',
      'cost', 'model', 'prompt_cache', 'promptCache', 'session_id', 'sessionId']],
    ['the status line\'s rate limits', 'picks', ['five_hour', 'fiveHour', 'seven_day', 'sevenDay', 'spend_limit', 'spendLimit']],
    ['the status line\'s rate-limit window', 'picks', ['used_percentage', 'usedPercentage', 'utilization', 'resets_at', 'resetsAt']],
    ['the status line\'s spend limit', 'picks', ['used_percentage', 'usedPercentage']],
    ['the status line\'s plan', 'picks', ['name', 'display_name', 'displayName', 'type']],
    ['the status line\'s context window', 'picks', ['total_input_tokens', 'totalInputTokens', 'total_output_tokens', 'totalOutputTokens',
      'context_window_size', 'contextWindowSize', 'used_percentage', 'usedPercentage']],
    ['the status line\'s cost', 'picks', ['total_cost_usd', 'totalCostUsd']],
    ['the status line\'s model', 'picks', ['display_name', 'displayName']],
    ['the status line\'s model id', 'fields', ['id']],
    ['the status line\'s prompt cache', 'picks', ['ttl', 'expires_at', 'expiresAt', 'hit_ratio', 'hitRatio', 'recache_tokens_if_cold',
      'recacheTokensIfCold']],
    ['the status line\'s prompt cache (direct)', 'fields', ['warm']],
  ])
  // 1.9 P17 (pinned and changed): the time of a user line is held to the same two pages (§0a.1).
  // 1.10 P2 (§0a.3, pinned and changed): the prompt tool's rows are held to the privacy page — P3 adds
  // the prompts page, which does not exist before it. 1.10 P3 (§0a.1, §0a.3, pinned and changed): every
  // prompt row is held to both, the privacy page and the prompts page (PROMPTS_PAGES).
  const promptCacheRow = (what: string): boolean => mirrorRow(what) || keepWarmRow(what) || what === 'the time of a user line'
  for (const row of contract.READ_CONTRACT) {
    // 1.12 P5 (§0a.4, pinned and changed): the credentials rows are held to the privacy page and the quota-sources page.
    // 1.12 P6 (§0a.10, pinned and changed): the payload's row to the privacy page — the notifications page joins it when
    // it exists (P9 writes docs/notifications.md; 1.10 P2's precedent for the prompts page). 1.12 P9 (pinned and changed):
    // it exists — the payload's row is held to both.
    // 1.14 P4 (§0a.1–§0a.4, pinned and changed): the attribution readers' rows are held to the privacy page and the sessions page.
    assert.deepEqual(row.pages, promptCacheRow(row.what) ? ['privacy', 'promptCache'] : promptsRow(row.what) ? ['privacy', 'prompts']
      : credentialsRow(row.what) ? ['privacy', 'quotaSources'] : payloadRow(row.what) ? ['privacy', 'notifications']
        : attributionRow(row.what) ? ['privacy', 'sessions'] : undefined, row.what)
    if (mirrorRow(row.what)) assert.equal(row.source, 'statusline-mirror.json', row.what)
  }
  // 1.8 P10 (§0a.6–§0a.8): the keep-warm host, reader by reader — the two shell-execution events, an
  // open execution's command line with its confidence and its working directory (tested, never kept),
  // VS Code's word for what runs in a terminal, the one line typed (`sendText` and nothing else of the
  // terminal — never its name), and keepwarm.json read back by its shape.
  const shell = 'VS Code\'s shell integration'
  assert.deepEqual(contract.READ_CONTRACT.filter((row) => keepWarmRow(row.what)).map((row) => [row.what, row.source, row.kind, row.fields]), [
    ['keep-warm: the shell execution events', shell, 'fields', ['terminal', 'execution']],
    ['keep-warm: an open shell execution', shell, 'fields', ['commandLine', 'cwd']],
    ['keep-warm: its command line', shell, 'fields', ['value', 'confidence']],
    ['keep-warm: its working directory', shell, 'fields', ['fsPath']],
    ['keep-warm: a terminal\'s shell', shell, 'fields', ['state']],
    ['keep-warm: the shell VS Code reports', shell, 'fields', ['shell']],
    ['keep-warm: the line typed', shell, 'fields', ['sendText']],
    ['keep-warm: the accounting file', 'keepwarm.json', 'fields', ['v', 'days']],
    ['keep-warm: a day of the accounting', 'keepwarm.json', 'fields', ['requests', 'tokens']],
  ])
  // 1.10 §0a.3 (P2): the one new field of VS Code's terminal API — of a terminal its `shellIntegration`, of
  // that its `cwd`, of that the `fsPath` — in `reportedCwd` and nowhere else.
  // 1.10 §0a.1 (P3): prompts.json read back by its shape — the version and the list, of an entry its id,
  // title and text — in `cleanPromptsFile` and nowhere else.
  // 1.10 §0a.4 (P4, pinned and changed): the prompt typed — of the terminal `sendText` alone, in `typePrompt`.
  assert.deepEqual(contract.READ_CONTRACT.filter((row) => promptsRow(row.what)).map((row) => [row.what, row.source, row.kind, row.body, row.variable, row.fields]), [
    ['prompts: a terminal\'s shell integration', shell, 'fields', 'function reportedCwd(', 'terminal', ['shellIntegration']],
    ['prompts: the folder VS Code reports for a terminal', shell, 'fields', 'function reportedCwd(', 'si', ['cwd']],
    ['prompts: that folder\'s path', shell, 'fields', 'function reportedCwd(', 'dir', ['fsPath']],
    ['prompts: the prompt typed', shell, 'fields', 'function typePrompt(', 'terminal', ['sendText']],
    ['prompts: the list file', 'prompts.json', 'fields', 'export function cleanPromptsFile(', 'o', ['v', 'prompts']],
    ['prompts: an entry of the list', 'prompts.json', 'fields', 'export function cleanPromptsFile(', 'e', ['id', 'title', 'text']],
  ])
  // 1.12 §0a.4 (P5): the credentials document — the file or the Keychain item holding the same JSON — of it
  // `claudeAiOauth`, of that the `accessToken` and its `expiresAt`, in `parseCredentials` and nowhere else.
  const credentials = '~/.claude/.credentials.json or the Keychain item Claude Code-credentials'
  assert.deepEqual(contract.READ_CONTRACT.filter((row) => credentialsRow(row.what)).map((row) => [row.what, row.source, row.kind, row.body, row.variable, row.fields]), [
    ['the credentials document', credentials, 'fields', 'function parseCredentials(', 'd', ['claudeAiOauth']],
    ['the credentials document\'s token', credentials, 'fields', 'function parseCredentials(', 'oauth', ['accessToken', 'expiresAt']],
  ])
  // 1.12 §0a.10 (P6): the notification payload — of an event its allow-list, twelve fields (§0a.10's eleven and the
  // kind of `wait`, which the agentWaiting text and C1's JSON carry), in `payloadOf` and nowhere else; never `identity`.
  assert.deepEqual(contract.READ_CONTRACT.filter((row) => payloadRow(row.what)).map((row) => [row.what, row.source, row.kind, row.body, row.variable, row.fields]), [
    ['the notification payload', 'the notification payload', 'fields', 'export function payloadOf(', 'e',
      ['event', 'provider', 'program', 'windowLabel', 'windowKind', 'percent', 'resetsAt', 'etaAt', 'since', 'atLeastMs', 'wait', 'at']],
  ])
  // 1.14 §0a.1–§0a.4 (P4): the attribution readers, each in its own function — the Claude folder from where the file lies
  // (`place.slug`, never a line's field), the working directory for a name, the session id, and the Codex session_meta.
  assert.deepEqual(contract.READ_CONTRACT.filter((row) => attributionRow(row.what)).map((row) => [row.what, row.source, row.kind, row.body, row.variable, row.fields]), [
    ['attribution: the Claude project folder', '~/.claude/projects/', 'fields', 'function claudeProjectOf(', 'place', ['slug']],
    ['attribution: the Claude working directory', '~/.claude/projects/', 'fields', 'function claudeProjectName(', 'd', ['cwd']],
    ['attribution: the Claude session id', '~/.claude/projects/', 'fields', 'function claudeSessionOf(', 'd', ['sessionId']],
    ['attribution: the Codex session_meta', '~/.codex/sessions/', 'fields', 'function codexSessionMeta(', 'p', ['forked_from_id', 'thread_source', 'id', 'cwd']],
  ])
})

test('the bridge keeps in the mirror exactly the keys the read contract lists for it (1.8 §7a Q11)', () => {
  const { MIRROR_KEEP } = require('../src/statuslineBridge') as typeof import('../src/statuslineBridge')
  const kept = new Set<string>()
  const walk = (keep: unknown): void => {
    if (Array.isArray(keep)) { for (const alt of keep) walk(alt); return }
    if (typeof keep !== 'object' || keep === null) return
    for (const [k, sub] of Object.entries(keep)) { kept.add(k); walk(sub) }
  }
  walk(MIRROR_KEEP)
  const read = new Set(contract.READ_CONTRACT
    .filter((row) => row.what.startsWith('the status line\'s '))
    .flatMap((row) => row.fields))
  assert.deepEqual([...kept].sort(), [...read].sort(),
    'the bridge keeps a key the reader does not take, or drops one it does — statuslineBridge.ts MIRROR_KEEP and READ_CONTRACT disagree')
})

test('a picks row reads the quoted keys of every pick of its variable, a cast included, and nothing else (1.8 §0a.1)', () => {
  const body = [
    'export function reader(payload, v) {',
    "  const a = pick(payload, 'rate_limits', 'rateLimits')",
    "  const b = pick(pick(payload, 'cost') as any, 'total_cost_usd')",
    "  const c = pick(v as any, 'name', \"display_name\")",
    "  const d = pick(other, 'cwd')",
    "  const e = pick(payloadX, 'transcript_path')",
    '  return payload.model',
    '}',
  ].join('\n')
  assert.deepEqual(contract.picksRead(body, 'payload'), ['rate_limits', 'rateLimits', 'cost'])
  assert.deepEqual(contract.picksRead(body, 'v'), ['name', 'display_name'])
  assert.deepEqual(contract.picksRead(body, 'nothing'), [])
  const rows: ContractRow[] = [
    { what: 'payload', file: 'x.ts', kind: 'picks', body: 'export function reader(', variable: 'payload', fields: ['rate_limits', 'rateLimits', 'cost'] },
  ]
  const read = (text: string) => (): string => text
  assert.deepEqual(contract.checkReadContract(read(body), rows), [])
  // One more key picked: reported as unlisted; a listed one gone: as unread.
  const more = body.replace("'rate_limits', 'rateLimits'", "'rate_limits', 'rateLimits', 'session_name'")
  assert.deepEqual(contract.checkReadContract(read(more), rows),
    [{ what: 'payload', file: 'x.ts', unlisted: ['session_name'], unread: [], error: null }])
  const less = body.replace("pick(pick(payload, 'cost') as any, 'total_cost_usd')", '0')
  assert.deepEqual(contract.checkReadContract(read(less), rows),
    [{ what: 'payload', file: 'x.ts', unlisted: [], unread: ['cost'], error: null }])
  // The shipped reader: `session_name`, `cwd` or `transcript_path` picked of the payload breaks it.
  const quota = fromRepo('src/quota.ts')
  const at = quota.indexOf("const rl = pick(payload, 'rate_limits', 'rateLimits') as any")
  assert.ok(at >= 0)
  for (const key of ['session_name', 'cwd', 'transcript_path']) {
    const src = `${quota.slice(0, at)}void pick(payload, '${key}')\n  ${quota.slice(at)}`
    const broken = contract.checkReadContract((f) => (f === 'src/quota.ts' ? src : fromRepo(f)))
    assert.deepEqual(broken.map((o) => [o.what, o.unlisted]), [['the status line\'s session', [key]]], key)
  }
})

test('the status-line bridge\'s bundle may load child_process, fs and path, and never a network module, a thread or fetch( (1.8 §7a Q16)', () => {
  assert.equal(contract.BRIDGE_BUNDLE.replace(/\\/g, '/'), 'dist/statusline-bridge.js')
  assert.deepEqual(contract.BRIDGE_ALLOWED_MODULES, ['child_process', 'fs', 'path'])
  assert.deepEqual(contract.BRIDGE_FORBIDDEN_MODULES, ['http', 'https', 'net', 'tls', 'dgram', 'worker_threads'])
  const clean = 'var import_child_process = require("child_process");\nvar fs = __toESM(require("fs"));\nvar path = __toESM(require("path"));\n'
  assert.deepEqual(contract.scanBridgeBundle(clean), { modules: ['child_process', 'fs', 'path'], offenders: [] })
  // The agent hook's rule is unchanged: the same text breaks it.
  assert.deepEqual(contract.scanHookBundle(clean).offenders, ['loads child_process', 'names child_process'])
  const cases: Array<[string, string]> = [
    ['require("https")', 'loads https'], ["require('node:net')", 'loads net'], ['import("tls")', 'loads tls'],
    ['import { Worker } from "worker_threads"', 'loads worker_threads'], ['require("os")', 'loads os'],
    ['const m = "http"; require(m)', 'names http'], ['fetch(url)', 'calls fetch('],
  ]
  for (const [text, finding] of cases) {
    assert.ok(contract.scanBridgeBundle(clean + text).offenders.includes(finding), `${text}: ${JSON.stringify(contract.scanBridgeBundle(clean + text))}`)
  }
  // The shipped bundle, when it is built: those three and nothing else, and no URL.
  try {
    const text = readFileSync(join(REPO, contract.BRIDGE_BUNDLE), 'utf8')
    assert.deepEqual(contract.scanBridgeBundle(text), { modules: ['child_process', 'fs', 'path'], offenders: [] })
    assert.deepEqual(scanBundle(text).urls, [])
  } catch (err) {
    if ((err as { code?: string }).code !== 'ENOENT') throw err
  }
})

test('the agent hook\'s bundle may load fs and path, and never a network module, a process, a thread or fetch( (§0a.13)', () => {
  assert.deepEqual(contract.HOOK_ALLOWED_MODULES, ['fs', 'path'])
  assert.deepEqual(contract.HOOK_FORBIDDEN_MODULES, ['http', 'https', 'net', 'tls', 'dgram', 'child_process', 'worker_threads'])
  const clean = 'var fs = __toESM(require("fs"));\nvar path = __toESM(require("path"));\nfs.openSync(path.join(a, "agent-hook.jsonl"))\n'
  assert.deepEqual(contract.scanHookBundle(clean), { modules: ['fs', 'path'], offenders: [] })
  const cases: Array<[string, string]> = [
    ['require("https")', 'loads https'], ["require('node:net')", 'loads net'], ['require("child_process")', 'loads child_process'],
    ['import("tls")', 'loads tls'], ['import { Worker } from "worker_threads"', 'loads worker_threads'], ['require("dgram")', 'loads dgram'],
    ['require("os")', 'loads os'], ['const m = "http"; require(m)', 'names http'], ['globalThis.fetch ("x")', 'calls fetch('],
    ['fetch(url)', 'calls fetch('],
  ]
  for (const [text, finding] of cases) {
    assert.ok(contract.scanHookBundle(clean + text).offenders.includes(finding), `${text}: ${JSON.stringify(contract.scanHookBundle(clean + text))}`)
  }
  // The shipped bundle, when it is built: fs and path, nothing else.
  const built = join(REPO, contract.HOOK_BUNDLE)
  try {
    const text = readFileSync(built, 'utf8')
    assert.deepEqual(contract.scanHookBundle(text), { modules: ['fs', 'path'], offenders: [] })
    assert.deepEqual(scanBundle(text).urls, [])
  } catch (err) {
    // A bare `node --test` after a checkout has no dist/; the CLI below and test/agentHook.test.ts build it.
    if ((err as { code?: string }).code !== 'ENOENT') throw err
  }
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
    // 1.6 P14b (pinned and changed): the CLI checks the agent hook's bundle as well, and its two
    // readers are rows of the contract.
    const hookBundle = 'var fs = require("fs");\nvar path = require("path");\n'
    writeFileSync(join(dir, 'dist', 'agent-hook.js'), hookBundle)
    writeFileSync(join(dir, 'src', 'agentHook.ts'), fromRepo('src/agentHook.ts'))
    writeFileSync(join(dir, 'src', 'agentHookScript.ts'), fromRepo('src/agentHookScript.ts'))
    // 1.8 P4 (pinned and changed): the CLI checks the status-line bridge's bundle too, and the
    // mirror's reader is a row of the contract.
    const bridgeBundle = 'var cp = require("child_process");\nvar fs = require("fs");\nvar path = require("path");\n'
    writeFileSync(join(dir, 'dist', 'statusline-bridge.js'), bridgeBundle)
    const quota = fromRepo('src/quota.ts')
    writeFileSync(join(dir, 'src', 'quota.ts'), quota)
    // 1.8 review 2: the narrowing of an older mirror at activation is the mirror's second reader.
    writeFileSync(join(dir, 'src', 'bridge.ts'), fromRepo('src/bridge.ts'))
    // 1.8 P10 (pinned and changed): the keep-warm host's readers are rows of the contract too.
    writeFileSync(join(dir, 'src', 'keepWarmHost.ts'), fromRepo('src/keepWarmHost.ts'))
    // 1.10 P2 (pinned and changed): the terminal watch's readers — moved out of the host — as well.
    const watchSrc = fromRepo('src/terminalWatch.ts')
    writeFileSync(join(dir, 'src', 'terminalWatch.ts'), watchSrc)
    // 1.10 P3 (pinned and changed): the prompt list's reader as well.
    const promptsSrc = fromRepo('src/prompts.ts')
    writeFileSync(join(dir, 'src', 'prompts.ts'), promptsSrc)
    // 1.10 P4 (pinned and changed): and the prompt's one write into a terminal.
    writeFileSync(join(dir, 'src', 'promptsHost.ts'), fromRepo('src/promptsHost.ts'))
    // 1.12 P5 (§0a.4, pinned and changed): and the credentials document's parser.
    const credentialsSrc = fromRepo('src/credentials.ts')
    writeFileSync(join(dir, 'src', 'credentials.ts'), credentialsSrc)
    // 1.12 P6 (§0a.10, pinned and changed): and the notification payload's builder.
    const notifySrc = fromRepo('src/notify.ts')
    writeFileSync(join(dir, 'src', 'notify.ts'), notifySrc)
    // 1.12 P7 (C11, pinned and changed): the CLI holds every network call site of src/ to NETWORK_SITES, so the
    // tree carries the two files its rows name — the quota fetch and the channels' fetch.
    writeFileSync(join(dir, 'src', 'poller.ts'), fromRepo('src/poller.ts'))
    const channelsSrc = fromRepo('src/notifyChannels.ts')
    writeFileSync(join(dir, 'src', 'notifyChannels.ts'), channelsSrc)
    // 1.12 P8 (C11, pinned and changed): and the file of the third row — the SMTP sender's sockets.
    const smtpSrc = fromRepo('src/notifySmtp.ts')
    writeFileSync(join(dir, 'src', 'notifySmtp.ts'), smtpSrc)
    const agg = fromRepo('src/agg.ts')
    const run = (): { status: number | null; out: string } => {
      const r = spawnSync(process.execPath, [join(REPO, 'scripts', 'check-privacy.mjs')], { cwd: dir, encoding: 'utf8' })
      return { status: r.status, out: `${r.stdout}${r.stderr}` }
    }
    writeFileSync(join(dir, 'src', 'agg.ts'), agg)
    // 1.6 P13b (pinned and changed): the run record's reader has a file of its own.
    const runRecord = fromRepo('src/runRecord.ts')
    writeFileSync(join(dir, 'src', 'runRecord.ts'), runRecord)
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
    // 1.6 P13b (§0a.12): the key-picker starts to take the run's script as well — the gate stops it.
    writeFileSync(join(dir, 'src', 'agg.ts'), agg)
    const keys = "export const RUN_RECORD_KEYS = ['status',"
    assert.ok(runRecord.includes(keys))
    writeFileSync(join(dir, 'src', 'runRecord.ts'), runRecord.replace(keys, "export const RUN_RECORD_KEYS = ['script', 'status',"))
    const picked = run()
    assert.equal(picked.status, 1, picked.out)
    assert.match(picked.out, /DIFF {2}the run record: /)
    assert.match(picked.out, /read but not listed: script/)
    writeFileSync(join(dir, 'src', 'runRecord.ts'), runRecord)
    assert.equal(run().status, 0)
    // 1.6 P14b (§0a.13): the hook's bundle reaching for the network, or missing — the gate stops both.
    writeFileSync(join(dir, 'dist', 'agent-hook.js'), `${hookBundle}var https = require("https");\n`)
    const net = run()
    assert.equal(net.status, 1, net.out)
    assert.match(net.out, /DENY {2}loads https/)
    assert.match(net.out, /the agent hook's bundle breaks its rule/)
    rmSync(join(dir, 'dist', 'agent-hook.js'))
    const missing = run()
    assert.equal(missing.status, 1, missing.out)
    assert.match(missing.out, /agent-hook\.js is missing/)
    // The hook script starts to read the prompt of a hook call: the contract stops it.
    writeFileSync(join(dir, 'dist', 'agent-hook.js'), hookBundle)
    const script = fromRepo('src/agentHookScript.ts')
    const at2 = script.indexOf('const sessionId = hookId(j.session_id)')
    assert.ok(at2 >= 0)
    writeFileSync(join(dir, 'src', 'agentHookScript.ts'), `${script.slice(0, at2)}void j.prompt\n  ${script.slice(at2)}`)
    const prompt = run()
    assert.equal(prompt.status, 1, prompt.out)
    assert.match(prompt.out, /DIFF {2}the agent hook's input/)
    assert.match(prompt.out, /read but not listed: prompt/)
    writeFileSync(join(dir, 'src', 'agentHookScript.ts'), script)
    assert.equal(run().status, 0)
    // 1.8 §7a Q16: the bridge's bundle reaching for the network, or missing — the gate stops both.
    writeFileSync(join(dir, 'dist', 'statusline-bridge.js'), `${bridgeBundle}var net = require("net");\n`)
    const bridgeNet = run()
    assert.equal(bridgeNet.status, 1, bridgeNet.out)
    assert.match(bridgeNet.out, /DENY {2}loads net/)
    assert.match(bridgeNet.out, /the status-line bridge's bundle breaks its rule/)
    rmSync(join(dir, 'dist', 'statusline-bridge.js'))
    const bridgeMissing = run()
    assert.equal(bridgeMissing.status, 1, bridgeMissing.out)
    assert.match(bridgeMissing.out, /statusline-bridge\.js is missing/)
    writeFileSync(join(dir, 'dist', 'statusline-bridge.js'), bridgeBundle)
    // 1.8 §0a.1: the mirror's reader starts to take the session's working directory — the contract stops it.
    const at3 = quota.indexOf("const rl = pick(payload, 'rate_limits', 'rateLimits') as any")
    assert.ok(at3 >= 0)
    writeFileSync(join(dir, 'src', 'quota.ts'), `${quota.slice(0, at3)}void pick(payload, 'cwd')\n  ${quota.slice(at3)}`)
    const cwd = run()
    assert.equal(cwd.status, 1, cwd.out)
    assert.match(cwd.out, /DIFF {2}the status line's session/)
    assert.match(cwd.out, /read but not listed: cwd/)
    writeFileSync(join(dir, 'src', 'quota.ts'), quota)
    assert.equal(run().status, 0)
    // 1.10 §0a.3 (P2): the watch's reader of the reported folder starts to read a terminal's name — the
    // contract stops it.
    const at4 = watchSrc.indexOf('  const si = terminal.shellIntegration')
    assert.ok(at4 >= 0)
    writeFileSync(join(dir, 'src', 'terminalWatch.ts'), `${watchSrc.slice(0, at4)}  void terminal.name\n${watchSrc.slice(at4)}`)
    const named = run()
    assert.equal(named.status, 1, named.out)
    assert.match(named.out, /DIFF {2}prompts: a terminal's shell integration/)
    assert.match(named.out, /read but not listed: name/)
    writeFileSync(join(dir, 'src', 'terminalWatch.ts'), watchSrc)
    assert.equal(run().status, 0)
    // 1.10 §0a.1 (P3): the prompt list's reader starts to take a time of the entry — the contract stops it.
    const at5 = promptsSrc.indexOf('    const title = e.title')
    assert.ok(at5 >= 0)
    writeFileSync(join(dir, 'src', 'prompts.ts'), `${promptsSrc.slice(0, at5)}    void e.sentAt\n${promptsSrc.slice(at5)}`)
    const timed = run()
    assert.equal(timed.status, 1, timed.out)
    assert.match(timed.out, /DIFF {2}prompts: an entry of the list/)
    assert.match(timed.out, /read but not listed: sentAt/)
    writeFileSync(join(dir, 'src', 'prompts.ts'), promptsSrc)
    assert.equal(run().status, 0)
    // 1.12 §0a.4 (P5, B8's mutation): the credentials parser starts to read the refresh token — the contract stops it.
    const at6 = credentialsSrc.indexOf('  const exp = oauth.expiresAt')
    assert.ok(at6 >= 0)
    writeFileSync(join(dir, 'src', 'credentials.ts'), `${credentialsSrc.slice(0, at6)}  void oauth.refreshToken\n${credentialsSrc.slice(at6)}`)
    const refreshed = run()
    assert.equal(refreshed.status, 1, refreshed.out)
    assert.match(refreshed.out, /DIFF {2}the credentials document's token/)
    assert.match(refreshed.out, /read but not listed: refreshToken/)
    writeFileSync(join(dir, 'src', 'credentials.ts'), credentialsSrc)
    assert.equal(run().status, 0)
    // 1.12 §0a.10 (P6, C14's mutation): the payload's builder starts to take a plan name of the event — the contract stops it.
    const at7 = notifySrc.indexOf('    at: e.at,\n  }))')
    assert.ok(at7 >= 0)
    writeFileSync(join(dir, 'src', 'notify.ts'), notifySrc.replace('    at: e.at,\n  }))', '    at: e.at, planType: e.planType,\n  }))'))
    const planned = run()
    assert.equal(planned.status, 1, planned.out)
    assert.match(planned.out, /DIFF {2}the notification payload/)
    assert.match(planned.out, /read but not listed: planType/)
    writeFileSync(join(dir, 'src', 'notify.ts'), notifySrc)
    const netKept = run()
    assert.equal(netKept.status, 0, netKept.out)
    assert.match(netKept.out, /network sites: 3 row\(s\)/)
    assert.match(netKept.out, /ok {4}src\/poller\.ts: fetch \(line \d+\) — a literal host: /)
    assert.match(netKept.out, /ok {4}src\/notifyChannels\.ts: fetch \(line \d+\) — hosts the reader configures: /)
    assert.match(netKept.out, /ok {4}src\/notifySmtp\.ts: net \(line \d+\), tls \(line \d+\), tls \(line \d+\), net \(line \d+\), tls \(line \d+\) — hosts the reader configures: the reader's SMTP server/)
    assert.match(netKept.out, /user-configured hosts: notification channels \(src\/notifyChannels\.ts, src\/notifySmtp\.ts\) — none is contacted before its channel's consent/)
    // 1.12 C11 rule 4's mutation: the channels' `fetch(` moved into a helper file of its own — the new site has no
    // row and the channels' row no longer holds, and the gate stops both.
    const site = 'export const httpsFetch: FetchLike = (url, init) => fetch(url, init)'
    assert.ok(channelsSrc.includes(site))
    writeFileSync(join(dir, 'src', 'net.ts'), 'export const netFetch = (url: string, init: RequestInit): Promise<Response> => fetch(url, init)\n')
    writeFileSync(join(dir, 'src', 'notifyChannels.ts'),
      `import { netFetch } from './net'\n${channelsSrc.replace(site, 'export const httpsFetch: FetchLike = (url, init) => netFetch(url, init)')}`)
    const moved = run()
    assert.equal(moved.status, 1, moved.out)
    assert.match(moved.out, /DENY {2}src\/net\.ts:1 fetch — no row in NETWORK_SITES/)
    assert.match(moved.out, /DIFF {2}src\/notifyChannels\.ts: /)
    assert.match(moved.out, /fetch: listed but not found \(a stale row\)/)
    assert.match(moved.out, /network call site\(s\) or row\(s\) differ from NETWORK_SITES/)
    rmSync(join(dir, 'src', 'net.ts'))
    writeFileSync(join(dir, 'src', 'notifyChannels.ts'), channelsSrc)
    assert.equal(run().status, 0)
    // A network module imported anywhere else fails too.
    writeFileSync(join(dir, 'src', 'quota.ts'), `import * as https from 'https'\nvoid https\n${quota}`)
    const imported = run()
    assert.equal(imported.status, 1, imported.out)
    assert.match(imported.out, /DENY {2}src\/quota\.ts:1 https — no row in NETWORK_SITES/)
    writeFileSync(join(dir, 'src', 'quota.ts'), quota)
    assert.equal(run().status, 0)
    // Review 3 F7 (pinned and changed): the channels' real fetch imported by another module than extension.ts, and
    // fetch bound to another name — the gate stops both; the CLI names the two entry points.
    assert.match(netKept.out, /entry point {2}httpsFetch \(src\/notifyChannels\.ts\) — only src\/extension\.ts may import it: /)
    assert.match(netKept.out, /entry point {2}smtpTransport \(src\/notifySmtp\.ts\) — only src\/extension\.ts may import it: /)
    writeFileSync(join(dir, 'src', 'quota.ts'), `import { httpsFetch } from './notifyChannels'\nvoid httpsFetch\n${quota}`)
    const entry = run()
    assert.equal(entry.status, 1, entry.out)
    assert.match(entry.out, /DENY {2}src\/quota\.ts:1 httpsFetch — only src\/extension\.ts may import it \(src\/notifyChannels\.ts\)/)
    assert.match(entry.out, /httpsFetch and smtpTransport are handed on by src\/extension\.ts, never imported anywhere else\./)
    writeFileSync(join(dir, 'src', 'quota.ts'), `${quota}\nexport const bound = fetch\n`)
    const bound = run()
    assert.equal(bound.status, 1, bound.out)
    assert.match(bound.out, /DENY {2}src\/quota\.ts:\d+ fetch — no row in NETWORK_SITES/)
    writeFileSync(join(dir, 'src', 'quota.ts'), quota)
    assert.equal(run().status, 0)
    // 1.12 P8 (C11): a socket opened elsewhere — the SMTP sender's TLS connection moved into a helper file of its
    // own — has no row, and the gate stops it; the sender keeps its row only while it still has both sites.
    const secureCall = 'tls.connect({ ...tlsTarget(host), port, rejectUnauthorized: true'
    assert.ok(smtpSrc.includes(secureCall))
    writeFileSync(join(dir, 'src', 'mailSocket.ts'), 'import * as tls from \'tls\'\nexport const secureSocket = (o: tls.ConnectionOptions): tls.TLSSocket => tls.connect(o)\n')
    writeFileSync(join(dir, 'src', 'notifySmtp.ts'), `import { secureSocket } from './mailSocket'\n${smtpSrc.replace(secureCall, 'secureSocket({ ...tlsTarget(host), port, rejectUnauthorized: true')}`)
    const socketMoved = run()
    assert.equal(socketMoved.status, 1, socketMoved.out)
    assert.match(socketMoved.out, /DENY {2}src\/mailSocket\.ts:1 tls — no row in NETWORK_SITES/)
    assert.match(socketMoved.out, /DENY {2}src\/mailSocket\.ts:2 tls — no row in NETWORK_SITES/)
    assert.match(socketMoved.out, /ok {4}src\/notifySmtp\.ts: /)
    rmSync(join(dir, 'src', 'mailSocket.ts'))
    // Without a tls site of its own the sender's row is stale — the gate stops that as well.
    writeFileSync(join(dir, 'src', 'notifySmtp.ts'), smtpSrc.replace('import * as tls from \'tls\'\n', '').replace(/tls\.connect\(/g, 'secureSocket('))
    const smtpStale = run()
    assert.equal(smtpStale.status, 1, smtpStale.out)
    assert.match(smtpStale.out, /DIFF {2}src\/notifySmtp\.ts: net \(line \d+\), net \(line \d+\) — /)
    assert.match(smtpStale.out, /tls: listed but not found \(a stale row\)/)
    // And a net.connect( in a file of its own, beside a kept sender.
    writeFileSync(join(dir, 'src', 'notifySmtp.ts'), smtpSrc)
    writeFileSync(join(dir, 'src', 'quota.ts'), `${quota}\nimport * as net from 'net'\nexport const probe = (): net.Socket => net.connect(25, 'localhost')\n`)
    const plainSocket = run()
    assert.equal(plainSocket.status, 1, plainSocket.out)
    assert.match(plainSocket.out, /DENY {2}src\/quota\.ts:\d+ net — no row in NETWORK_SITES/)
    writeFileSync(join(dir, 'src', 'quota.ts'), quota)
    assert.equal(run().status, 0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// 1.14 P4 (§0a.1–§0a.6): the attribution readers' leak test, on the aggregator itself — beside extension.test.ts's run
// through the host (log, diagnostics, bar, exports, page), which the restore's allow-list alone would already keep
// clean: here nothing between the reader and the outputs checks the key again.
// ---------------------------------------------------------------------------

test('1.14 leak test (§0a.1–§0a.6): under hash no store, view or export of the aggregator holds the folder, the slug, the worktree, the meta\'s other keys or the salt; under basename the name only where a project is shown', () => {
  const { Aggregator } = require('../src/agg') as typeof import('../src/agg')
  const { isProjectKey, projectKeyOf } = require('../src/project') as typeof import('../src/project')
  const { toCsv, toJson, toMarkdownSummary } = require('../src/exporter') as typeof import('../src/exporter')
  const { buildViewModel } = require('../src/viewModel') as typeof import('../src/viewModel')
  const { claudeLine, codexTokenCount, codexTurnContext } = require('./fixtures/helpers') as typeof import('./fixtures/helpers')
  const { makeConfig, makeInput, timeConfig, NOW, TODAY } = require('./fixtures/viewFixtures') as typeof import('./fixtures/viewFixtures')
  const SLUG = '-home-u-synthetic-secret-dir-synthetic-project-123'
  const CWD = '/home/u/synthetic-secret-dir/synthetic-project-123'
  const SALT = 'f0e1d2c3b4a5968778695a4b3c2d1e0f'
  const secrets = ['synthetic-secret-dir', 'synthetic-project-123', SLUG, 'synthetic-worktree-456', 'synthetic instruction text', 'synthetic-repo', SALT]
  const main = `/virtual/claude/projects/${SLUG}/sess-syn.jsonl`
  const sub = `/virtual/claude/projects/${SLUG}/sess-syn/subagents/agent-b6b6b6.jsonl`
  const rollout = '/virtual/codex/sessions/2026/09/03/rollout-syn.jsonl'
  // 1.14 P7 (pinned and changed: the world takes the attribution — §0a.7's none case).
  const world = (hashProjects: boolean, attribution: 'none' | 'project' = 'project') => {
    const agg = new Aggregator()
    agg.attribution = attribution
    const ctx = (file: string, isSub = false) => ({ isSub, file, attribution, projectSalt: SALT, hashProjects })
    agg.cursors.set(main, { offset: 0, size: 0, ino: 1, dev: 1 })
    agg.addClaudeLine(claudeLine({ id: 'p1', ts: NOW - 3_600_000, cwd: CWD, sessionId: 'sess-syn', usage: { input: 70, output: 7 }, final: true }), ctx(main))
    agg.addClaudeLine(claudeLine({ id: 'p2', ts: NOW - 3_000_000, agentId: 'b6b6b6', sessionId: 'sess-syn', usage: { input: 30, output: 3 }, final: true,
      cwd: '/home/u/synthetic-project-123/.claude/worktrees/synthetic-worktree-456' }), ctx(sub, true))
    const cur = { offset: 0, size: 0, ino: 2, dev: 1 }
    agg.cursors.set(rollout, cur)
    agg.addCodexLine(JSON.stringify({ timestamp: new Date(NOW - 2_000_000).toISOString(), type: 'session_meta', payload: {
      id: 'thread-syn', originator: 'codex_cli_rs', cli_version: '0.0.0', cwd: CWD,
      instructions: 'synthetic instruction text', git: { repository_url: 'https://example.invalid/synthetic-repo' },
    } }), cur, ctx(rollout))
    agg.addCodexLine(codexTurnContext(NOW - 2_000_000, 'gpt-5.4'), cur, ctx(rollout))
    agg.addCodexLine(codexTokenCount({ ts: NOW - 1_900_000, total: { input: 50, cached: 10, output: 5, total: 55 } }), cur, ctx(rollout))
    const cfg = makeConfig({ 'tokenPace.attribution': attribution, 'tokenPace.showProjectNames': hashProjects ? 'hash' : 'basename',
      'tokenPace.dashboard.sections': ['summary', 'tokens', 'agents', 'projects', 'sessions', 'records'] })
    const range = { from: '2026-08-25', to: TODAY, label: 'Last 10 days', preset: 'custom' }
    const vm = buildViewModel(makeInput({ agg, cfg }))
    // The snapshot's values without its path-keyed tables (the read positions and agent tables of 1.0 — §0a.1).
    const snap = JSON.parse(JSON.stringify(agg.toSnapshot())) as Record<string, unknown>
    for (const k of ['cursors', 'agents', 'launches', 'mains', 'runs', 'runLaunches']) delete snap[k]
    snap.sessions = Object.values(snap.sessions as Record<string, unknown>)
    for (const p of Object.values(snap.pending as Record<string, Record<string, unknown>>)) delete p.session
    return {
      agg,
      outputs: [
        ['the snapshot\'s values', JSON.stringify(snap)],
        ['the view model', JSON.stringify(vm)],
        ['the CSV', toCsv(agg, range, cfg, timeConfig(cfg))],
        ['the JSON export', toJson(agg, range, cfg, timeConfig(cfg), NOW)],
        ['the summary', toMarkdownSummary(vm)],
      ] as Array<[string, string]>,
    }
  }
  const hashed = world(true)
  // Every key the store holds is a key — never a segment of a path, never a name.
  for (const b of hashed.agg.all()) assert.equal(isProjectKey(b.project), true, String(b.project))
  for (const k of Object.keys(hashed.agg.projects())) assert.equal(isProjectKey(k), true, k)
  for (const s of hashed.agg.sessions()) assert.equal(isProjectKey(s.project), true, s.project)
  // One key for the folder's session, its worktree agent and its Codex rollout.
  assert.equal(new Set(hashed.agg.sessions().map((s) => s.project)).size, 1)
  for (const [what, text] of hashed.outputs) {
    for (const secret of secrets) assert.equal(text.includes(secret), false, `hash: ${what} holds ${secret}`)
  }
  // 1.14 P7 (§0a.7): the files and the summary name the project by its pseudonym under hash — the key the folder gives.
  const KEY = projectKeyOf(SALT, SLUG)
  const files = (w: ReturnType<typeof world>): Array<[string, string]> => w.outputs.filter(([what]) => ['the CSV', 'the JSON export', 'the summary'].includes(what))
  for (const [what, text] of files(hashed)) assert.ok(text.includes(`p:${KEY}`), `hash: ${what} does not name the project by its pseudonym`)
  const named = world(false)
  assert.equal(Object.values(named.agg.projects())[0].name, 'synthetic-project-123')
  for (const [what, text] of named.outputs) {
    for (const secret of secrets) {
      // The folder's name, with names on, in the label table, the view model, the exports and — 1.14 P7 (pinned and
      // changed: the summary carries the Projects table since P7, §3 A6 rule 3) — the summary; nothing else, anywhere.
      if (secret === 'synthetic-project-123') continue
      assert.equal(text.includes(secret), false, `basename: ${what} holds ${secret}`)
    }
  }
  assert.ok(named.outputs[0][1].includes('synthetic-project-123') && named.outputs[1][1].includes('synthetic-project-123'))
  // §0a.7: under basename the files and the summary name the folder — and never its key beside it: a name and its
  // pseudonym together would link a file shared under hash with its folder.
  for (const [what, text] of files(named)) {
    assert.ok(text.includes('synthetic-project-123'), `basename: ${what} does not name the folder`)
    assert.equal(text.includes(KEY), false, `basename: ${what} holds the key beside the name`)
  }
  // §0a.7: under none neither file nor the summary holds a project — no column value, no field, no sessions[], no name.
  const off = world(false, 'none')
  for (const b of off.agg.all()) assert.equal(b.project, undefined)
  for (const [what, text] of files(off)) {
    for (const secret of [...secrets, KEY, '(no project)']) assert.equal(text.includes(secret), false, `none: ${what} holds ${secret}`)
    assert.equal(/p:[0-9a-f]{12}/.test(text), false, `none: ${what} holds a pseudonym`)
  }
  const [head, ...rows] = off.outputs.find(([what]) => what === 'the CSV')![1].trim().split('\n').map((l) => l.split(','))
  assert.equal(head[head.length - 1], 'project')
  for (const r of rows) assert.equal(r[head.length - 1], '', r.join(','))
  const json = JSON.parse(off.outputs.find(([what]) => what === 'the JSON export')![1]) as { buckets: object[]; sessions?: unknown }
  assert.equal(json.buckets.some((b) => 'project' in b), false)
  assert.equal(json.sessions, undefined)
})
