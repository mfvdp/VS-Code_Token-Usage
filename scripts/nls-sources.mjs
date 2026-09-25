// SPDX-FileCopyrightText: 2026 Frederik Marx
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * 1.9 B3 T12: which English a translation of the manifest was made from.
 *
 * A runtime string needs no such record: its key *is* its English text (see src/i18n.ts), so an
 * English sentence that changes is a new key, and every language's parity test fails by itself
 * until the language translates it again. A manifest string is different: `package.nls.json` maps
 * a stable key (`config.language.description`) to its English, and a changed English value leaves
 * the key — and every translation of it — standing. Without a record, fourteen manifests could go
 * stale and nothing would say so.
 *
 * So each language keeps `l10n/nls-sources/<id>.json`: for every key of `package.nls.<id>.json`,
 * the first 16 hex digits of the SHA-256 of `package.nls.json`'s English value at the time the key
 * was translated. `--check` compares every record with today's English and names each language and
 * key whose English changed since — the list a translation package works through.
 *
 * Run it only after translating: writing a record says "this language's text is a translation of
 * today's English", and nothing checks that claim but a reader.
 *
 * Run:  node scripts/nls-sources.mjs <id> [<id> …]   writes l10n/nls-sources/<id>.json from
 *                                                    today's package.nls.json and package.nls.<id>.json
 *       node scripts/nls-sources.mjs --check         writes nothing; exit 1 when a language has no
 *                                                    record, a record has no language, or a key's
 *                                                    English changed since its translation
 *
 * Paths are relative to the working directory (the repository root), as merge-l10n.mjs's are.
 * The records are not shipped (.vscodeignore ships nothing under l10n/ but the bundles).
 */

import { createHash } from 'crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'

export const SOURCES_DIR = join('l10n', 'nls-sources')
const ENGLISH = 'package.nls.json'

/** A language tag as the registry spells one — lower case, `pt-br`; never a path. */
const ID = /^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/

/** The first 16 hex digits of the SHA-256 of a manifest string's English. */
export function sourceHash(english) {
  return createHash('sha256').update(String(english), 'utf8').digest('hex').slice(0, 16)
}

/** `package.nls.pt-br.json` → `pt-br`; anything else is not a translation of the manifest. */
function nlsId(file) {
  const m = /^package\.nls\.(.+)\.json$/.exec(file)
  return m && ID.test(m[1]) ? m[1] : null
}

function readTable(file) {
  const parsed = JSON.parse(readFileSync(file, 'utf8'))
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('not a JSON object')
  return parsed
}

/** The exact bytes of a record: the English file's key order, two-space indent, one trailing newline. */
export function serialize(record) {
  return `${JSON.stringify(record, null, 2)}\n`
}

/**
 * The record of one language: every key the translation has that the English has too, in the
 * English file's order, with the hash of today's English.
 */
export function recordOf(english, translated) {
  const out = {}
  for (const key of Object.keys(english)) {
    if (Object.prototype.hasOwnProperty.call(translated, key)) out[key] = sourceHash(english[key])
  }
  return out
}

/**
 * Every problem of the records under the working directory, one line each, naming the language and
 * the key: a translation without a record, a record without a translation, a key of the English
 * that was never recorded, a recorded key the English no longer has, and a key whose English
 * changed since its translation.
 */
export function check(root = '.') {
  const problems = []
  let english
  try {
    english = readTable(join(root, ENGLISH))
  } catch (err) {
    return [`${ENGLISH}: ${err.message}`]
  }
  const langs = readdirSync(root).map(nlsId).filter((x) => x !== null).sort()
  const dir = join(root, SOURCES_DIR)
  const records = existsSync(dir)
    ? readdirSync(dir).map((f) => /^(.+)\.json$/.exec(f)).filter((m) => m && ID.test(m[1])).map((m) => m[1]).sort()
    : []
  for (const id of records) {
    if (!langs.includes(id)) problems.push(`${id}: ${join(SOURCES_DIR, id + '.json')} has no package.nls.${id}.json beside it`)
  }
  for (const id of langs) {
    const file = join(dir, `${id}.json`)
    if (!existsSync(file)) {
      problems.push(`${id}: package.nls.${id}.json has no record — run \`node scripts/nls-sources.mjs ${id}\` after translating`)
      continue
    }
    let record
    try {
      record = readTable(file)
    } catch (err) {
      problems.push(`${id}: ${join(SOURCES_DIR, id + '.json')}: ${err.message}`)
      continue
    }
    for (const [key, value] of Object.entries(english)) {
      if (!Object.prototype.hasOwnProperty.call(record, key)) {
        problems.push(`${id}: ${key} — no record of the English it was translated from`)
      } else if (record[key] !== sourceHash(value)) {
        problems.push(`${id}: ${key} — the English changed since its translation`)
      }
    }
    for (const key of Object.keys(record)) {
      if (!Object.prototype.hasOwnProperty.call(english, key)) problems.push(`${id}: ${key} — recorded, but package.nls.json has no such key any more`)
    }
  }
  return problems
}

function main(argv) {
  if (argv.includes('--check')) {
    const problems = check()
    if (problems.length > 0) {
      for (const p of problems) console.error(`nls-sources: ${p}`)
      console.error('\nnls-sources: translate the named keys again, then run `node scripts/nls-sources.mjs <id>`.')
      process.exit(1)
    }
    const n = readdirSync('.').map(nlsId).filter((x) => x !== null).length
    console.log(`nls-sources: every record is fresh (${n} language(s))`)
    return
  }
  const ids = argv.filter((a) => !a.startsWith('--'))
  if (ids.length === 0) {
    console.error('nls-sources: name a language — node scripts/nls-sources.mjs <id> — or pass --check')
    process.exit(1)
  }
  let english
  try {
    english = readTable(ENGLISH)
  } catch (err) {
    console.error(`nls-sources: ${ENGLISH}: ${err.message}`)
    process.exit(1)
  }
  for (const id of ids) {
    if (!ID.test(id)) {
      console.error(`nls-sources: ${JSON.stringify(id)} is not a language tag`)
      process.exit(1)
    }
    const file = `package.nls.${id}.json`
    let translated
    try {
      translated = readTable(file)
    } catch (err) {
      console.error(`nls-sources: ${file}: ${err.message}`)
      process.exit(1)
    }
    const record = recordOf(english, translated)
    const missing = Object.keys(english).filter((k) => !(k in record))
    mkdirSync(SOURCES_DIR, { recursive: true })
    const out = join(SOURCES_DIR, `${id}.json`)
    writeFileSync(out, serialize(record), 'utf8')
    console.log(`nls-sources: wrote ${out} (${Object.keys(record).length} key(s))`)
    if (missing.length > 0) console.error(`nls-sources: ${file} lacks ${missing.length} key(s) of ${ENGLISH}; --check names them`)
  }
}

// Only run the CLI when invoked directly, so a test can import the functions.
if (process.argv[1] && process.argv[1].endsWith('nls-sources.mjs')) main(process.argv.slice(2))
