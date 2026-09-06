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

  if (offenders > 0) {
    console.error(`\ncheck-privacy: ${offenders} literal(s) outside the allow-list.`)
    console.error('Add a host only with a reason; "no network access by default" is a promise, not a default.')
    process.exit(1)
  }
  console.log('\ncheck-privacy: ok')
}

// Only run the CLI when invoked directly, so the test can import the scanner.
if (process.argv[1] && process.argv[1].endsWith('check-privacy.mjs')) main()
