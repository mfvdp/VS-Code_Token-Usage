// SPDX-FileCopyrightText: 2026 Frederik Marx
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Static privacy check: every http(s) literal that survives into the shipped bundles *and the
 * shipped string files* is listed with its host and matched against an allow-list. The
 * promise "no network access
 * beyond the one consent-gated endpoint" is otherwise unverifiable — a price feed, a status
 * page or a CDN font would be a two-line change nobody notices in review.
 *
 * The allow-list is deliberately small and each entry has a reason:
 *   api.anthropic.com          the one endpoint the consent dialog names
 *   claude.ai/settings/usage   the official usage page, opened in the user's browser
 *   chatgpt.com                the same for Codex
 *   docs.claude.com, developers.openai.com, support.claude.com, github.com/mfvdp
 *                              documentation links that only ever appear as text
 *
 * Beside the URL scan, the read contract (`READ_CONTRACT`, below): which fields each reader of a
 * Claude Code file may name — the list docs/privacy.md and docs/agents.md are held to by
 * test/docs.test.ts. The CLI fails when a reader names a field the table does not list, or a
 * listed field is no longer read.
 *
 * Run: node scripts/check-privacy.mjs   (also `npm run check:privacy`)
 */

import { readdirSync, readFileSync, existsSync } from 'fs'
import { join } from 'path'

/** Entries are either a bare host or `host/path-prefix`. */
export const DEFAULT_ALLOW = [
  'api.anthropic.com',
  'claude.ai/settings/usage',
  'chatgpt.com',
  'docs.claude.com',
  'developers.openai.com',
  'support.claude.com',
  'github.com/mfvdp',
]

// Stops at whitespace and at the characters that end a string literal or a JSX/HTML
// attribute; trailing punctuation is trimmed afterwards.
const URL_RE = /https?:\/\/[^\s'"`\\)>\]},;]+/g

function parse(raw) {
  const url = raw.replace(/[.,:;!?]+$/, '')
  try {
    const u = new URL(url)
    return { url, host: u.host.toLowerCase(), path: u.pathname }
  } catch {
    return { url, host: '', path: '' }
  }
}

function isAllowed(entry, allow) {
  for (const rule of allow) {
    const slash = rule.indexOf('/')
    const host = (slash === -1 ? rule : rule.slice(0, slash)).toLowerCase()
    const prefix = slash === -1 ? '' : rule.slice(slash)
    if (entry.host !== host) continue
    if (prefix === '' || entry.path.startsWith(prefix)) return true
  }
  return false
}

/**
 * Finds every http(s) literal in `text` and classifies it against `allow`.
 * Pure, so the test suite can run it against a fake bundle.
 *
 * @param {string} text
 * @param {string[]} [allow]
 * @returns {{ urls: Array<{url: string, host: string, path: string, allowed: boolean, line: number}>,
 *             offenders: Array<{url: string, host: string, path: string, allowed: boolean, line: number}> }}
 */
export function scanBundle(text, allow = DEFAULT_ALLOW) {
  const urls = []
  const seen = new Set()
  URL_RE.lastIndex = 0
  let m
  while ((m = URL_RE.exec(text)) !== null) {
    const entry = parse(m[0])
    if (seen.has(entry.url)) continue
    seen.add(entry.url)
    const line = text.slice(0, m.index).split('\n').length
    urls.push({ ...entry, allowed: isAllowed(entry, allow), line })
  }
  urls.sort((a, b) => a.host.localeCompare(b.host) || a.url.localeCompare(b.url))
  return { urls, offenders: urls.filter((u) => !u.allowed) }
}

function pick(dir, re) {
  if (!existsSync(dir)) return []
  return readdirSync(dir).filter((f) => re.test(f)).sort().map((f) => join(dir, f))
}

/**
 * Every file the .vsix carries that can hold a URL literal. Code is only half of it: VS Code
 * reads the l10n bundles and the manifest strings at runtime, so a host hidden in a
 * translation ships just as surely as one in `dist/`. `l10n/parts/*.json` do not ship, but
 * they are the input of merge-l10n.mjs, so a host is named in the file a translator edits.
 * Keep in step with the `!` lines of .vscodeignore. Exported so the test can assert the list.
 */
export function filesToScan() {
  return [
    ...pick('dist', /\.js$/),
    ...pick('l10n', /^bundle\.l10n\..+\.json$/),
    ...pick(join('l10n', 'parts'), /\.json$/),
    ...pick('.', /^package\.nls(\..+)?\.json$/),
  ]
}

// ---------------------------------------------------------------------------
// The read contract
// ---------------------------------------------------------------------------

/**
 * One reader of a Claude Code file and the only fields it may name. Three kinds of row:
 *  - `fields`: every `<variable>.<field>` / `<variable>?.<field>` the body names — the body runs
 *    from the line holding `body` to the closing brace at that line's indentation;
 *  - `regex`: the quoted key names (`"name":`) inside the named constant's definition, for a
 *    reader that matches keys on the raw line instead of parsing it;
 *  - `tags`: group 1 of every match of `pattern` over the whole file — the tag names the
 *    matching constants look for.
 * `what` names the reader as both documentation pages describe it. Every package of 1.6 that
 * reads a new field adds its row here, and the pages name the field in backticks.
 *
 * @typedef {{ what: string, file: string, kind: 'fields', body: string, variable: string, fields: string[] }
 *   | { what: string, file: string, kind: 'regex', regex: string, fields: string[] }
 *   | { what: string, file: string, kind: 'tags', pattern: RegExp, fields: string[] }} ReadContractRow
 */

/** @type {ReadContractRow[]} */
export const READ_CONTRACT = [
  { what: 'the identity sidecar', file: 'src/agg.ts', kind: 'fields', body: 'function cleanMeta(', variable: 'o',
    fields: ['agentType', 'model', 'spawnDepth', 'toolUseId'] },
  // 1.6 §0a.1 (P2b): the journal's head is matched on the raw line, and the `key` joins `type` and
  // `agentId` — compared within the journal, never kept. The fallback parses a short line without
  // the head and picks the same three.
  { what: 'the workflow journal', file: 'src/agg.ts', kind: 'regex', regex: 'JOURNAL_HEAD_RE',
    fields: ['type', 'key', 'agentId'] },
  { what: 'the workflow journal (fallback)', file: 'src/agg.ts', kind: 'fields', body: 'function journalFallback(', variable: 'd',
    fields: ['type', 'key', 'agentId'] },
  // 1.6 §0a.3 (P4): the blocks of a reply the launches are read from — an `Agent`/`Task` block's
  // `input` for the three fields above; of a `Workflow` block only its `id`, its input never.
  { what: 'the launch blocks', file: 'src/agg.ts', kind: 'fields', body: 'private noteLaunches(', variable: 'block',
    fields: ['type', 'name', 'id', 'input'] },
  { what: 'an agent launch', file: 'src/agg.ts', kind: 'fields', body: 'private noteLaunches(', variable: 'input',
    fields: ['subagent_type', 'model', 'run_in_background'] },
  { what: 'the tool result', file: 'src/agg.ts', kind: 'fields', body: 'private agentResult(', variable: 'r',
    fields: ['agentId', 'status'] },
  // 1.6 §0a.3 (P4): the result that answers a `Workflow` call — the run it launched and its status.
  { what: 'the workflow result', file: 'src/agg.ts', kind: 'fields', body: 'private runResult(', variable: 'r',
    fields: ['runId', 'status'] },
  { what: 'the reported totals', file: 'src/agg.ts', kind: 'fields', body: 'function reportedTotals(', variable: 'r',
    fields: ['totalTokens', 'totalDurationMs', 'totalToolUseCount'] },
  { what: 'the task notification', file: 'src/agg.ts', kind: 'tags', pattern: /const NOTE_\w+_RE = \/<([a-z-]+)>/g,
    fields: ['tool-use-id', 'status'] },
]

/**
 * The body of one function or method of a source: from the line holding `signature` to the
 * closing brace at the indentation that line starts with. Null when the signature is not there
 * or its brace cannot be found. Line endings are levelled first, as a Windows checkout has CRLF.
 */
export function bodyOf(src, signature) {
  const text = src.replace(/\r\n/g, '\n')
  const at = text.indexOf(signature)
  if (at < 0) return null
  const lineStart = text.lastIndexOf('\n', at) + 1
  const indent = /^[ \t]*/.exec(text.slice(lineStart, at))[0]
  const end = text.indexOf(`\n${indent}}`, at)
  return end > at ? text.slice(at, end) : null
}

/** The distinct `<variable>.<field>` names a body reads, in order of first appearance. */
export function fieldsRead(body, variable) {
  return [...new Set([...body.matchAll(new RegExp(`\\b${variable}\\??\\.([A-Za-z_]+)`, 'g'))].map((m) => m[1]))]
}

/**
 * The definition of a top-level constant, from `const <name> =` to the end of its statement:
 * for a regex or string literal the rest of its line, for anything else the first line end
 * outside a bracket. Enough for the regex literals and key lists the raw-line readers are made
 * of. Null when there is no such constant.
 */
export function constantOf(src, name) {
  const text = src.replace(/\r\n/g, '\n')
  const m = new RegExp(`(?:^|\\n)(?:export )?const ${name}\\b[^=]*=[ \\t]*`).exec(text)
  if (!m) return null
  const from = m.index + m[0].length
  if (/^[/'"`]/.test(text.slice(from, from + 1))) {
    const eol = text.indexOf('\n', from)
    return text.slice(m.index, eol < 0 ? undefined : eol)
  }
  let depth = 0
  for (let i = from; i < text.length; i++) {
    const c = text[i]
    if (c === '\\') { i++; continue }
    if (c === '[' || c === '(' || c === '{') depth++
    else if (c === ']' || c === ')' || c === '}') depth = Math.max(0, depth - 1)
    else if (c === '\n' && depth === 0) return text.slice(m.index, i)
  }
  return text.slice(m.index)
}

/**
 * The quoted key names in a definition: every `"name":`, a backslash before a quote allowed —
 * the keys a raw-line pattern matches. A definition without one is a list of key names
 * (`['status', 'startTime']`), and then every quoted name is a key.
 */
export function quotedKeys(definition) {
  const keyed = [...definition.matchAll(/\\?"([A-Za-z_][A-Za-z0-9_]*)\\?"\s*:/g)].map((m) => m[1])
  const found = keyed.length > 0 ? keyed : [...definition.matchAll(/(['"])([A-Za-z_][A-Za-z0-9_]*)\1/g)].map((m) => m[2])
  return [...new Set(found)]
}

/**
 * What one row's reader reads today, or an error when its body or constant is gone.
 * @param {ReadContractRow} row
 * @param {string} src
 * @returns {{ read: string[] } | { error: string }}
 */
function readOf(row, src) {
  if (row.kind === 'fields') {
    const body = bodyOf(src, row.body)
    return body === null ? { error: `${row.file} no longer contains ${row.body}` } : { read: fieldsRead(body, row.variable) }
  }
  if (row.kind === 'regex') {
    const def = constantOf(src, row.regex)
    return def === null ? { error: `${row.file} no longer defines ${row.regex}` } : { read: quotedKeys(def) }
  }
  if (row.kind === 'tags') {
    return { read: [...new Set([...src.matchAll(row.pattern)].map((m) => m[1]))] }
  }
  return { error: `unknown kind ${String(row.kind)}` }
}

/**
 * Every row whose reader and list differ: the fields read that the row does not list
 * (`unlisted`), the listed ones no longer read (`unread`), or why the reader could not be found
 * (`error`). An empty array is a kept contract.
 *
 * @param {(file: string) => string} [read]  reads a source file named relative to the repository
 * @param {ReadContractRow[]} [contract]
 * @returns {Array<{ what: string, file: string, unlisted: string[], unread: string[], error: string | null }>}
 */
export function checkReadContract(read = (f) => readFileSync(f, 'utf8'), contract = READ_CONTRACT) {
  const offenders = []
  const sources = new Map()
  for (const row of contract) {
    let src = sources.get(row.file)
    if (src === undefined) {
      try { src = read(row.file) } catch (err) { src = null }
      sources.set(row.file, src)
    }
    if (src === null) {
      offenders.push({ what: row.what, file: row.file, unlisted: [], unread: [...row.fields], error: `cannot read ${row.file}` })
      continue
    }
    const got = readOf(row, src)
    if ('error' in got) {
      offenders.push({ what: row.what, file: row.file, unlisted: [], unread: [...row.fields], error: got.error })
      continue
    }
    const unlisted = got.read.filter((f) => !row.fields.includes(f))
    const unread = row.fields.filter((f) => !got.read.includes(f))
    if (unlisted.length > 0 || unread.length > 0) offenders.push({ what: row.what, file: row.file, unlisted, unread, error: null })
  }
  return offenders
}

function main() {
  if (!existsSync('dist')) {
    console.error('check-privacy: no dist/ — run `npm run build` first')
    process.exit(1)
  }
  const files = filesToScan()
  if (!files.some((f) => f.startsWith('dist'))) {
    console.error('check-privacy: no dist/*.js — run `npm run build` first')
    process.exit(1)
  }

  let offenders = 0
  for (const full of files) {
    const { urls } = scanBundle(readFileSync(full, 'utf8'))
    console.log(`${full}: ${urls.length} http(s) literal(s)`)
    for (const u of urls) {
      console.log(`  ${u.allowed ? 'ok  ' : 'DENY'}  ${u.host.padEnd(24)} ${u.url}  (line ${u.line})`)
      if (!u.allowed) offenders++
    }
  }

  // The read contract, after the URL scan: every reader of a Claude Code file names exactly
  // the fields the table lists — the ones both documentation pages promise.
  const broken = checkReadContract()
  console.log(`\nread contract: ${READ_CONTRACT.length} reader(s)`)
  for (const row of READ_CONTRACT) {
    const bad = broken.find((b) => b.what === row.what)
    console.log(`  ${bad ? 'DIFF' : 'ok  '}  ${row.what}: ${row.fields.join(', ')}`)
    if (bad?.error) console.log(`        ${bad.error}`)
    if (bad?.unlisted.length) console.log(`        read but not listed: ${bad.unlisted.join(', ')}`)
    if (bad?.unread.length) console.log(`        listed but not read: ${bad.unread.join(', ')}`)
  }

  let failed = false
  if (offenders > 0) {
    console.error(`\ncheck-privacy: ${offenders} literal(s) outside the allow-list.`)
    console.error('Add a host only with a reason; "no network access by default" is a promise, not a default.')
    failed = true
  }
  if (broken.length > 0) {
    console.error(`\ncheck-privacy: ${broken.length} reader(s) differ from the read contract.`)
    console.error('A new field needs its row in READ_CONTRACT and its name in docs/privacy.md and docs/agents.md.')
    failed = true
  }
  if (failed) process.exit(1)
  console.log('\ncheck-privacy: ok')
}

// Only run the CLI when invoked directly, so the test can import the scanner.
if (process.argv[1] && process.argv[1].endsWith('check-privacy.mjs')) main()
