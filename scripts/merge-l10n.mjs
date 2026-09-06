// SPDX-FileCopyrightText: 2026 Frederik Marx
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Merges `l10n/parts/<part>.<lang>.json` into `l10n/bundle.l10n.<lang>.json`, the file
 * VS Code loads for that language.
 *
 * Why parts: several packages translate several sets of modules in parallel, and one shared
 * file would conflict on every merge. Each package owns one part (host, model, dashboard,
 * text); the bundle is generated from them — keys in plain code-unit order, two-space
 * indent, one trailing newline — so the same parts always give the same bytes, and
 * test/i18n.test.ts can insist that the committed bundle is exactly that.
 *
 * Rules: a value must be a non-empty string. A key that appears in two parts is fine while
 * both give the same translation; two different translations for one key fail the merge,
 * because the bundle could only keep one of them and which one would be an accident of
 * file order. Parts are read in file-name order.
 *
 * Run:  node scripts/merge-l10n.mjs           writes every bundle whose parts exist
 *       node scripts/merge-l10n.mjs --check   writes nothing; exit 1 when a committed bundle
 *                                             differs from what the parts give
 *       node scripts/merge-l10n.mjs --print   writes nothing; prints { "<lang>": {…} }
 */

import { existsSync, readdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'

const L10N_DIR = 'l10n'
const PARTS_DIR = join(L10N_DIR, 'parts')

/** `host.de.json` → `{ part: 'host', lang: 'de' }`; anything else is not a part file. */
function partName(file) {
  const m = /^([A-Za-z0-9_-]+)\.([a-z]{2,3}(?:-[A-Za-z0-9]+)*)\.json$/.exec(file)
  return m ? { part: m[1], lang: m[2] } : null
}

/**
 * Merges the parts of `partsDir` per language.
 * @param {string} partsDir
 * @returns {{ bundles: Record<string, Record<string, string>>, errors: string[] }}
 */
export function merge(partsDir = PARTS_DIR) {
  const errors = []
  const byLang = {}
  const origin = {}
  const files = existsSync(partsDir) ? readdirSync(partsDir).sort() : []
  for (const file of files) {
    const name = partName(file)
    if (name === null) continue
    let parsed
    try {
      parsed = JSON.parse(readFileSync(join(partsDir, file), 'utf8'))
    } catch (err) {
      errors.push(`${file}: ${err.message}`)
      continue
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      errors.push(`${file}: not a JSON object`)
      continue
    }
    const table = byLang[name.lang] ?? (byLang[name.lang] = {})
    const from = origin[name.lang] ?? (origin[name.lang] = {})
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value !== 'string' || value.length === 0) {
        errors.push(`${file}: ${JSON.stringify(key)} is not a non-empty string`)
        continue
      }
      if (key in table && table[key] !== value) {
        errors.push(`${file}: ${JSON.stringify(key)} is already translated differently in ${from[key]}`)
        continue
      }
      table[key] = value
      from[key] = file
    }
  }
  const bundles = {}
  for (const lang of Object.keys(byLang).sort()) {
    const sorted = {}
    for (const key of Object.keys(byLang[lang]).sort()) sorted[key] = byLang[lang][key]
    bundles[lang] = sorted
  }
  return { bundles, errors }
}

/** The exact bytes of a bundle file. */
export function serialize(bundle) {
  return `${JSON.stringify(bundle, null, 2)}\n`
}

export function bundlePath(lang, dir = L10N_DIR) {
  return join(dir, `bundle.l10n.${lang}.json`)
}

function main(argv) {
  const check = argv.includes('--check')
  const print = argv.includes('--print')
  const { bundles, errors } = merge()
  if (errors.length > 0) {
    for (const e of errors) console.error(`merge-l10n: ${e}`)
    process.exit(1)
  }
  if (print) {
    process.stdout.write(`${JSON.stringify(bundles, null, 2)}\n`)
    return
  }
  let stale = 0
  for (const [lang, bundle] of Object.entries(bundles)) {
    const file = bundlePath(lang)
    const text = serialize(bundle)
    let current = null
    try { current = readFileSync(file, 'utf8') } catch { /* not written yet */ }
    if (current === text) {
      console.log(`merge-l10n: ${file} is up to date (${Object.keys(bundle).length} key(s))`)
      continue
    }
    if (check) {
      stale++
      console.error(`merge-l10n: ${file} ${current === null ? 'is missing' : 'differs from the parts'}`)
      if (current !== null) {
        let old = {}
        try { old = JSON.parse(current) } catch { /* the diff below then lists every key as new */ }
        for (const key of Object.keys(bundle)) {
          if (!(key in old)) console.error(`  + ${JSON.stringify(key)}`)
          else if (old[key] !== bundle[key]) console.error(`  ~ ${JSON.stringify(key)}`)
        }
        for (const key of Object.keys(old)) if (!(key in bundle)) console.error(`  - ${JSON.stringify(key)}`)
      }
      continue
    }
    writeFileSync(file, text, 'utf8')
    console.log(`merge-l10n: wrote ${file} (${Object.keys(bundle).length} key(s))`)
  }
  if (stale > 0) {
    console.error('\nmerge-l10n: run `node scripts/merge-l10n.mjs` and commit the bundle.')
    process.exit(1)
  }
}

// Only run the CLI when invoked directly, so the test can import `merge`.
if (process.argv[1] && process.argv[1].endsWith('merge-l10n.mjs')) main(process.argv.slice(2))
