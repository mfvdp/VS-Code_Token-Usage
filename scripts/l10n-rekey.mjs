// SPDX-FileCopyrightText: 2026 Frederik Marx
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * 1.10 B1: the re-key ledger — how a change of the English reaches the twelve languages beyond
 * English and German.
 *
 * A runtime string's key is its English (src/i18n.ts): a changed sentence is a new key that every
 * language lacks, and test/l10n.languages.test.ts turns twelve languages red at once. 1.9 therefore
 * froze the English while its languages were translated. 1.10 changes the English while the code is
 * written, and records each change, in the order made, so that every language's files follow it at
 * the moment it is made and every gate stays green until the language's own package has translated
 * it:
 *
 *   l10n/rekey.json          the ledger: { "v": 1, "base": "<sha>", "entries": [ … ] } — append-only,
 *                            one entry per change, numbered from 1 (`n`), written by the package that
 *                            changes the English
 *   l10n/rekey-base.json     the tree the ledger starts from (`--start`): every t() key with the German
 *                            parts it stands in, and the SHA-256 prefix of every package.nls.json value
 *                            (the one nls-sources.mjs records) — what the ledger's own test replays the
 *                            entries on
 *   l10n/pending/<id>.json   per language: how many entries are applied to its files (`applied`) and
 *                            what is left to do — `{ "v": 1, "applied": <n>, "bundle": { "<key>":
 *                            { "parts": [..], "state", "why" } }, "nls": { "<key>": { "state", "why" } } }`
 *
 * An entry is `{ "n", "by", "kind", …, "why" }` with exactly the fields of its kind (ENTRY_FIELDS):
 *
 *   add         part, key              a new key: nothing written, the key listed `translate`
 *   reword      part, old, key, carry  a key's English changed: `carry: true` moves the old key's value to
 *                                      the new key and lists it `review` (the old translation still says
 *                                      what the new English says); `false` drops it and lists the new key
 *                                      `translate`. A reworded key that was pending stays pending.
 *   remove      part, old              the key leaves the part and the list
 *   copy        from, part, key        a key a second part now uses too: the language's value copied into
 *                                      `part` (merge-l10n.mjs then sees one translation in two parts);
 *                                      listed there when it is listed in `from`
 *   review      part, key              the English is unchanged but its use narrowed: listed `review`
 *   nls-add     key                    a new manifest key: inserted at the English file's position with the
 *                                      English value, listed `translate`
 *   nls-reword  key                    a manifest value changed: the value stays, listed `review`
 *                                      (nls-sources.mjs calls it stale until the language records it again)
 *   nls-remove  key                    the key leaves the manifest, its freshness record and the list
 *
 * German is never in the ledger's hands: the package that changes the English writes the German parts
 * and package.nls.de.json itself. A bundle key listed `translate` is absent from the language's parts
 * and bundle, so t() shows the English there — honest, and only on the build branch; the join (1.10
 * P20) allows no pending key. The state of a listed bundle key follows from the files: `translate`
 * while one of its listed parts lacks it, `review` once every one holds a (carried) value.
 *
 * A language without a pending file has done everything the ledger asks: `--start` writes a pending
 * file at cursor 0 for every language, the language's package empties it and deletes it. So a new
 * version's first change of the English starts a new ledger with `--start`.
 *
 * Run:  node scripts/l10n-rekey.mjs               applies the entries after each language's cursor to
 *                                                 its files, moves the cursor to the end, and merges the
 *                                                 bundles (merge-l10n.mjs) — a second run changes nothing
 *       node scripts/l10n-rekey.mjs --check       writes nothing; exit 1 when an entry is malformed or
 *                                                 names a part that does not exist, a cursor is behind, a
 *                                                 pending file is malformed or names no language, or
 *                                                 German (or English) has one
 *       node scripts/l10n-rekey.mjs --print <id>  writes nothing; the language's work list: each key with
 *                                                 its part, its state, the English, the German, the value
 *                                                 it carries and why
 *       node scripts/l10n-rekey.mjs --start <sha> starts a ledger at the tree as it is (the base, no
 *                                                 entries, a pending file at cursor 0 per language) —
 *                                                 refused while a language has work pending
 *
 * The languages are the registry's (package.json's `tokenPace.language` enum, which test/languages
 * holds equal to src/languages.ts) other than English and German, each once it has a file on disk.
 * Paths are relative to the working directory (the repository root), as merge-l10n.mjs's are. None of
 * these files is shipped (.vscodeignore ships nothing under l10n/ but the bundles).
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { bundlePath, merge, serialize as serializeBundle } from './merge-l10n.mjs'
import { serialize as serializeRecord, sourceHash } from './nls-sources.mjs'

export const LEDGER_FILE = 'l10n/rekey.json'
export const BASE_FILE = 'l10n/rekey-base.json'
export const PENDING_DIR = 'l10n/pending'
const PARTS_DIR = 'l10n/parts'
const RECORDS_DIR = 'l10n/nls-sources'
const ENGLISH = 'package.nls.json'

/** The fields every entry has, and the ones of each kind — an entry has exactly these, nothing else. */
const COMMON_FIELDS = ['n', 'by', 'kind', 'why']
export const ENTRY_FIELDS = {
  'add': ['part', 'key'],
  'reword': ['part', 'old', 'key', 'carry'],
  'remove': ['part', 'old'],
  'copy': ['from', 'part', 'key'],
  'review': ['part', 'key'],
  'nls-add': ['key'],
  'nls-reword': ['key'],
  'nls-remove': ['key'],
}
const STATES = ['translate', 'review']
/** A language tag as the registry spells one — lower case, `pt-br`; never a path. */
const ID = /^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/
const SHA = /^[0-9a-f]{7,40}$/
const NLS_KEY = /^[A-Za-z0-9_.-]+$/

const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k)
const isObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v)
const J = (x) => JSON.stringify(x)

function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'))
}

/** An object read from a JSON file — or an error naming the file. */
function readTable(root, file) {
  const parsed = readJson(join(root, file))
  if (!isObject(parsed)) throw new Error(`${file}: not a JSON object`)
  return parsed
}

/** Two-space indent, one trailing newline — the bytes every l10n file is written in. */
const serialize = (value) => `${JSON.stringify(value, null, 2)}\n`

/** Writes `text` when the file holds anything else; true when it wrote. */
function writeIfChanged(root, file, text) {
  const path = join(root, file)
  let current = null
  try { current = readFileSync(path, 'utf8') } catch { /* not written yet */ }
  if (current === text) return false
  writeFileSync(path, text, 'utf8')
  return true
}

/** A table with its keys in plain code-unit order — the order of every part file. */
function sortedTable(table) {
  const out = {}
  for (const k of Object.keys(table).sort()) out[k] = table[k]
  return out
}

// ---------------------------------------------------------------------------
// The registry, the parts, the languages
// ---------------------------------------------------------------------------

/** The registry's ids in its order: package.json's `tokenPace.language` enum without `auto`. */
export function registry(root = '.') {
  const pkg = readJson(join(root, 'package.json'))
  const sections = pkg?.contributes?.configuration
  for (const section of Array.isArray(sections) ? sections : [sections]) {
    const property = section?.properties?.['tokenPace.language']
    if (property && Array.isArray(property.enum)) return property.enum.filter((x) => x !== 'auto')
  }
  throw new Error('package.json declares no tokenPace.language enum — the registry of languages')
}

/** The parts a bundle is merged from: the German part files' names, in name order. */
export function partNames(root = '.') {
  const dir = join(root, PARTS_DIR)
  if (!existsSync(dir)) return []
  return readdirSync(dir).map((f) => /^([A-Za-z0-9_-]+)\.de\.json$/.exec(f)?.[1]).filter((x) => x !== undefined).sort()
}

/** Whether a language has any file on disk: its manifest translation or one of its parts. */
function onDisk(root, id) {
  if (existsSync(join(root, `package.nls.${id}.json`))) return true
  const dir = join(root, PARTS_DIR)
  return existsSync(dir) && readdirSync(dir).some((f) => f.endsWith(`.${id}.json`) && f.split('.').length === 3)
}

/** The languages the ledger is applied to: the registry's, other than English and German, once on disk. */
export function languages(root = '.') {
  return registry(root).filter((id) => id !== 'en' && id !== 'de' && ID.test(id) && onDisk(root, id))
}

// ---------------------------------------------------------------------------
// The ledger
// ---------------------------------------------------------------------------

/** Every problem of one entry (at index `i`), one line each. */
function entryProblems(e, i, parts) {
  const at = `${LEDGER_FILE}: entry ${i + 1}`
  if (!isObject(e)) return [`${at} is not an object`]
  const out = []
  if (e.n !== i + 1) out.push(`${at} has n ${J(e.n)} — the entries are numbered 1, 2, 3 … in the order made`)
  const fields = ENTRY_FIELDS[e.kind]
  if (!fields) return [...out, `${at} has the kind ${J(e.kind)}, none of ${Object.keys(ENTRY_FIELDS).join(', ')}`]
  const label = `${at} (${e.kind})`
  const allowed = new Set([...COMMON_FIELDS, ...fields])
  for (const k of Object.keys(e)) if (!allowed.has(k)) out.push(`${label} has the field ${J(k)}, which an entry of this kind does not have`)
  for (const k of fields) if (!own(e, k)) out.push(`${label} lacks the field ${J(k)}`)
  if (typeof e.by !== 'string' || !/^[^\u0000-\u001f]{1,40}$/.test(e.by)) out.push(`${label}: by must name the package that made the change ("P6")`)
  if (typeof e.why !== 'string' || e.why.trim().length === 0) out.push(`${label}: why must say why, in a few words`)
  else if (e.why.includes('; ')) out.push(`${label}: why must not contain "; " — a pending list joins the reasons of one key with it`)
  for (const k of ['part', 'from']) {
    if (fields.includes(k) && !parts.includes(e[k])) out.push(`${label}: ${k} ${J(e[k])} names no part — l10n/parts/<part>.de.json exists for ${parts.join(', ')}`)
  }
  for (const k of ['key', 'old']) {
    if (fields.includes(k) && (typeof e[k] !== 'string' || e[k].length === 0)) out.push(`${label}: ${k} must be a non-empty string`)
  }
  if (e.kind.startsWith('nls-') && typeof e.key === 'string' && !NLS_KEY.test(e.key)) out.push(`${label}: ${J(e.key)} is no key of package.nls.json's form`)
  if (e.kind === 'reword') {
    if (typeof e.carry !== 'boolean') out.push(`${label}: carry must be true (the old translation still says it) or false`)
    if (e.old === e.key) out.push(`${label}: old and key are the same text`)
  }
  if (e.kind === 'copy' && e.from === e.part) out.push(`${label}: from and part are the same part`)
  return out
}

/** The ledger and every problem of it — its shape, its base, each entry. */
export function readLedger(root = '.', parts = partNames(root)) {
  const problems = []
  if (!existsSync(join(root, LEDGER_FILE))) return { ledger: null, problems: [`${LEDGER_FILE} is missing — start one: node scripts/l10n-rekey.mjs --start <sha>`] }
  let ledger
  try {
    ledger = readTable(root, LEDGER_FILE)
  } catch (err) {
    return { ledger: null, problems: [`${LEDGER_FILE}: ${err.message}`] }
  }
  for (const k of Object.keys(ledger)) if (!['v', 'base', 'entries'].includes(k)) problems.push(`${LEDGER_FILE} has the field ${J(k)}; a ledger has v, base and entries`)
  if (ledger.v !== 1) problems.push(`${LEDGER_FILE}: v is ${J(ledger.v)}, not 1`)
  if (typeof ledger.base !== 'string' || !SHA.test(ledger.base)) problems.push(`${LEDGER_FILE}: base ${J(ledger.base)} is no commit`)
  if (!Array.isArray(ledger.entries)) return { ledger: null, problems: [...problems, `${LEDGER_FILE}: entries is not a list`] }
  ledger.entries.forEach((e, i) => problems.push(...entryProblems(e, i, parts)))
  if (existsSync(join(root, BASE_FILE))) {
    try {
      const base = readTable(root, BASE_FILE)
      if (base.base !== ledger.base) problems.push(`${BASE_FILE} is the tree at ${J(base.base)}, the ledger starts at ${J(ledger.base)}`)
    } catch (err) {
      problems.push(`${BASE_FILE}: ${err.message}`)
    }
  } else {
    problems.push(`${BASE_FILE} is missing — the ledger's test replays the entries on it`)
  }
  return { ledger, problems }
}

// ---------------------------------------------------------------------------
// The pending lists
// ---------------------------------------------------------------------------

export const pendingFile = (id) => `${PENDING_DIR}/${id}.json`

/** Every problem of one pending file's shape (not of its content against today's English: T14 checks that). */
export function pendingProblems(p, id, parts, entries) {
  const file = pendingFile(id)
  if (!isObject(p)) return [`${file} is not a JSON object`]
  const out = []
  for (const k of Object.keys(p)) if (!['v', 'applied', 'bundle', 'nls'].includes(k)) out.push(`${file} has the field ${J(k)}`)
  if (p.v !== 1) out.push(`${file}: v is ${J(p.v)}, not 1`)
  if (!Number.isInteger(p.applied) || p.applied < 0) out.push(`${file}: applied ${J(p.applied)} is no count of entries`)
  else if (entries !== null && p.applied > entries) out.push(`${file}: applied is ${p.applied}, and the ledger has ${entries} entries`)
  if (!isObject(p.bundle)) out.push(`${file}: bundle is not an object`)
  else {
    for (const [key, v] of Object.entries(p.bundle)) {
      const at = `${file}: bundle ${J(key)}`
      if (!isObject(v)) { out.push(`${at} is not an object`); continue }
      for (const k of Object.keys(v)) if (!['parts', 'state', 'why'].includes(k)) out.push(`${at} has the field ${J(k)}`)
      if (!Array.isArray(v.parts) || v.parts.length === 0 || new Set(v.parts).size !== v.parts.length || v.parts.some((x) => !parts.includes(x))) {
        out.push(`${at}: parts ${J(v.parts)} is not a list of parts (${parts.join(', ')})`)
      }
      if (!STATES.includes(v.state)) out.push(`${at}: state ${J(v.state)} is neither translate nor review`)
      if (typeof v.why !== 'string' || v.why.length === 0) out.push(`${at}: why is missing`)
    }
  }
  if (!isObject(p.nls)) out.push(`${file}: nls is not an object`)
  else {
    for (const [key, v] of Object.entries(p.nls)) {
      const at = `${file}: nls ${J(key)}`
      if (!isObject(v)) { out.push(`${at} is not an object`); continue }
      for (const k of Object.keys(v)) if (!['state', 'why'].includes(k)) out.push(`${at} has the field ${J(k)}`)
      if (!STATES.includes(v.state)) out.push(`${at}: state ${J(v.state)} is neither translate nor review`)
      if (typeof v.why !== 'string' || v.why.length === 0) out.push(`${at}: why is missing`)
    }
  }
  return out
}

/** A language's pending file, or null when it has none (its package has done everything the ledger asks). */
function readPending(root, id) {
  const file = pendingFile(id)
  if (!existsSync(join(root, file))) return null
  return readJson(join(root, file))
}

/** The ids of every pending file on disk. */
function pendingIds(root) {
  const dir = join(root, PENDING_DIR)
  if (!existsSync(dir)) return []
  return readdirSync(dir).map((f) => /^(.+)\.json$/.exec(f)?.[1]).filter((x) => x !== undefined).sort()
}

const emptyPending = () => ({ v: 1, applied: 0, bundle: {}, nls: {} })

// ---------------------------------------------------------------------------
// Applying the entries to one language
// ---------------------------------------------------------------------------

/**
 * One language's files in memory, the entries applied one by one. `tables` are its parts, `manifest`
 * its package.nls.<id>.json, `record` its freshness record (null when it has none), `pending` its list.
 */
class Language {
  constructor(root, id, parts, english) {
    this.root = root
    this.id = id
    this.english = english
    this.tables = {}
    for (const part of parts) {
      const file = `${PARTS_DIR}/${part}.${id}.json`
      this.tables[part] = existsSync(join(root, file)) ? readTable(root, file) : {}
    }
    const nls = `package.nls.${id}.json`
    this.manifest = existsSync(join(root, nls)) ? readTable(root, nls) : {}
    const rec = `${RECORDS_DIR}/${id}.json`
    this.record = existsSync(join(root, rec)) ? readTable(root, rec) : null
    this.pending = readPending(root, id)
    this.reordered = false
    this.warnings = []
  }

  /** The state a listed key is in: `translate` while one of its parts lacks it, else `review`. */
  stateOf(key, parts) {
    return parts.some((p) => !own(this.tables[p], key)) ? 'translate' : 'review'
  }

  /** Lists `key` for `part`, with `why` beside any reason it is listed for already. */
  list(key, part, why) {
    const b = this.pending.bundle
    const entry = own(b, key) ? b[key] : (b[key] = { parts: [], state: 'translate', why })
    if (!entry.parts.includes(part)) entry.parts.push(part)
    if (!entry.why.split('; ').includes(why)) entry.why = `${entry.why}; ${why}`
    entry.state = this.stateOf(key, entry.parts)
  }

  /** Takes `part` off `key`'s listing; the listing goes when no part is left. */
  unlist(key, part) {
    const b = this.pending.bundle
    if (!own(b, key)) return
    const entry = b[key]
    entry.parts = entry.parts.filter((p) => p !== part)
    if (entry.parts.length === 0) delete b[key]
    else entry.state = this.stateOf(key, entry.parts)
  }

  listedIn(key, part) {
    return own(this.pending.bundle, key) && this.pending.bundle[key].parts.includes(part)
  }

  listNls(key, state, why) {
    const n = this.pending.nls
    if (!own(n, key)) { n[key] = { state, why }; return }
    const entry = n[key]
    if (entry.state !== 'translate') entry.state = state
    if (!entry.why.split('; ').includes(why)) entry.why = `${entry.why}; ${why}`
  }

  apply(e) {
    switch (e.kind) {
      case 'add':
        this.list(e.key, e.part, e.why)
        break
      case 'reword': {
        const t = this.tables[e.part]
        if (own(t, e.old)) {
          const value = t[e.old]
          delete t[e.old]
          if (e.carry && !own(t, e.key)) t[e.key] = value
        } else if (!this.listedIn(e.old, e.part)) {
          this.warnings.push(`entry ${e.n}: ${J(e.old)} was neither in ${e.part}.${this.id}.json nor pending — ${J(e.key)} is listed to translate`)
        }
        this.unlist(e.old, e.part)
        this.list(e.key, e.part, e.why)
        break
      }
      case 'remove':
        delete this.tables[e.part][e.old]
        this.unlist(e.old, e.part)
        break
      case 'copy': {
        const from = this.tables[e.from]
        const to = this.tables[e.part]
        if (own(from, e.key) && !own(to, e.key)) to[e.key] = from[e.key]
        if (this.listedIn(e.key, e.from) || !own(to, e.key)) this.list(e.key, e.part, e.why)
        break
      }
      case 'review':
        this.list(e.key, e.part, e.why)
        break
      case 'nls-add':
        // A key the English no longer has was taken out again by a later entry, which removes it here too.
        if (!own(this.english, e.key)) break
        if (own(this.manifest, e.key)) {
          this.listNls(e.key, this.manifest[e.key] === this.english[e.key] ? 'translate' : 'review', e.why)
        } else {
          this.manifest[e.key] = this.english[e.key]
          this.reordered = true
          this.listNls(e.key, 'translate', e.why)
        }
        break
      case 'nls-reword':
        if (own(this.manifest, e.key)) this.listNls(e.key, 'review', e.why)
        else if (own(this.english, e.key)) {
          this.manifest[e.key] = this.english[e.key]
          this.reordered = true
          this.listNls(e.key, 'translate', e.why)
        }
        break
      case 'nls-remove':
        delete this.manifest[e.key]
        if (this.record) delete this.record[e.key]
        delete this.pending.nls[e.key]
        break
      default:
        throw new Error(`entry ${e.n}: unknown kind ${J(e.kind)}`)
    }
  }

  /** The manifest in the English file's order (an inserted key at its position); keys the English lacks last. */
  manifestInOrder() {
    if (!this.reordered) return this.manifest
    const out = {}
    for (const k of Object.keys(this.english)) if (own(this.manifest, k)) out[k] = this.manifest[k]
    for (const k of Object.keys(this.manifest)) if (!own(out, k)) out[k] = this.manifest[k]
    return out
  }

  /** Writes what changed; the files it wrote. */
  write() {
    const wrote = []
    for (const [part, table] of Object.entries(this.tables)) {
      const file = `${PARTS_DIR}/${part}.${this.id}.json`
      if (Object.keys(table).length === 0 && !existsSync(join(this.root, file))) continue
      if (writeIfChanged(this.root, file, serialize(sortedTable(table)))) wrote.push(file)
    }
    const nls = `package.nls.${this.id}.json`
    if (existsSync(join(this.root, nls)) || Object.keys(this.manifest).length > 0) {
      if (writeIfChanged(this.root, nls, serialize(this.manifestInOrder()))) wrote.push(nls)
    }
    if (this.record) {
      const rec = `${RECORDS_DIR}/${this.id}.json`
      if (writeIfChanged(this.root, rec, serializeRecord(this.record))) wrote.push(rec)
    }
    mkdirSync(join(this.root, PENDING_DIR), { recursive: true })
    if (writeIfChanged(this.root, pendingFile(this.id), serialize(this.pending))) wrote.push(pendingFile(this.id))
    return wrote
  }
}

/** How many keys a pending list holds, by state. */
function tally(p) {
  const count = (o, s) => Object.values(o).filter((v) => v.state === s).length
  return { translate: count(p.bundle, 'translate'), review: count(p.bundle, 'review'), nlsTranslate: count(p.nls, 'translate'), nlsReview: count(p.nls, 'review') }
}

/**
 * Applies the ledger to every language whose cursor is behind, then merges the bundles.
 * @returns {{ lines: string[], problems: string[], wrote: string[] }}
 */
export function applyAll(root = '.') {
  const parts = partNames(root)
  const { ledger, problems } = readLedger(root, parts)
  if (!ledger || problems.length > 0) return { lines: [], problems, wrote: [] }
  const english = readTable(root, ENGLISH)
  const lines = []
  const wrote = []
  const n = ledger.entries.length
  for (const id of languages(root)) {
    const pending = readPending(root, id)
    if (pending === null) {
      lines.push(`${id}: no pending list — its package has done everything the ledger asks`)
      continue
    }
    const shape = pendingProblems(pending, id, parts, n)
    if (shape.length > 0) { problems.push(...shape.map((x) => `${id}: ${x}`)); continue }
    if (pending.applied === n) {
      lines.push(`${id}: every entry applied (${n})`)
      continue
    }
    const lang = new Language(root, id, parts, english)
    const from = lang.pending.applied
    for (const e of ledger.entries.slice(from)) lang.apply(e)
    lang.pending.applied = n
    wrote.push(...lang.write())
    const c = tally(lang.pending)
    lines.push(`${id}: entries ${from + 1}–${n} applied — pending ${c.translate} to translate, ${c.review} to review; manifest ${c.nlsTranslate} to translate, ${c.nlsReview} to review`)
    for (const w of lang.warnings) lines.push(`${id}: ${w}`)
  }
  if (problems.length > 0) return { lines, problems, wrote }
  const merged = merge(join(root, PARTS_DIR))
  if (merged.errors.length > 0) return { lines, problems: merged.errors.map((e) => `merge-l10n: ${e}`), wrote }
  for (const [lang, bundle] of Object.entries(merged.bundles)) {
    const file = bundlePath(lang, 'l10n')
    if (writeIfChanged(root, file, serializeBundle(bundle))) wrote.push(file)
  }
  return { lines, problems, wrote }
}

// ---------------------------------------------------------------------------
// --check
// ---------------------------------------------------------------------------

/** Every problem `--check` names, one line each. */
export function checkAll(root = '.') {
  const parts = partNames(root)
  const { ledger, problems } = readLedger(root, parts)
  const n = ledger ? ledger.entries.length : null
  let langs = []
  try {
    langs = languages(root)
  } catch (err) {
    problems.push(err.message)
  }
  for (const id of pendingIds(root)) {
    if (id === 'de') problems.push(`de: ${pendingFile('de')} exists — German is written by the package that changes the English, never pending`)
    else if (id === 'en') problems.push(`en: ${pendingFile('en')} exists — English is the source`)
    else if (!langs.includes(id)) problems.push(`${id}: ${pendingFile(id)} names no language of the registry with files on disk`)
  }
  for (const id of langs) {
    let pending
    try {
      pending = readPending(root, id)
    } catch (err) {
      problems.push(`${id}: ${pendingFile(id)}: ${err.message}`)
      continue
    }
    if (pending === null) continue
    const shape = pendingProblems(pending, id, parts, n)
    if (shape.length > 0) { problems.push(...shape.map((s) => `${id}: ${s}`)); continue }
    if (n !== null && pending.applied < n) {
      problems.push(`${id}: ${pendingFile(id)} has ${pending.applied} of the ledger's ${n} entries applied — run node scripts/l10n-rekey.mjs`)
    }
  }
  return problems
}

// ---------------------------------------------------------------------------
// --print
// ---------------------------------------------------------------------------

/** A table cell: the text as JSON (unambiguous, copyable into a part file), its pipes escaped. */
const cell = (s) => (s === null || s === undefined ? '–' : J(s).replace(/\|/g, '\\|'))

/** The work list of one language, as two tables. */
export function printList(root, id) {
  const parts = partNames(root)
  if (id === 'de' || id === 'en') throw new Error(`${id} has no pending list — German is written by the package that changes the English, and English is the source`)
  if (!languages(root).includes(id)) throw new Error(`${J(id)} is no language of the registry with files on disk`)
  const { ledger } = readLedger(root, parts)
  const pending = readPending(root, id)
  if (pending === null) return `l10n-rekey: ${id} has no pending list — its package has done everything the ledger asks.\n`
  const lang = new Language(root, id, parts, readTable(root, ENGLISH))
  const german = {}
  for (const part of parts) {
    const file = `${PARTS_DIR}/${part}.de.json`
    if (existsSync(join(root, file))) Object.assign(german, readTable(root, file))
  }
  const germanNls = existsSync(join(root, 'package.nls.de.json')) ? readTable(root, 'package.nls.de.json') : {}
  const c = tally(pending)
  const out = []
  out.push(`l10n-rekey: ${id} — ${pending.applied} of the ledger's ${ledger ? ledger.entries.length : '?'} entries applied (base ${ledger?.base ?? '?'})`)
  out.push('')
  out.push(`Runtime strings — ${c.translate} to translate, ${c.review} to review (l10n/parts/<part>.${id}.json, then node scripts/merge-l10n.mjs):`)
  out.push('')
  out.push('| # | State | Part | English (the key) | German | Carried | Why |')
  out.push('|---|---|---|---|---|---|---|')
  let i = 0
  for (const [key, v] of Object.entries(pending.bundle)) {
    const carried = v.parts.map((p) => (lang.tables[p] && own(lang.tables[p], key) ? lang.tables[p][key] : null)).find((x) => typeof x === 'string') ?? null
    out.push(`| ${++i} | ${v.state} | ${v.parts.join(', ')} | ${cell(key)} | ${cell(own(german, key) ? german[key] : null)} | ${cell(carried)} | ${v.why.replace(/\|/g, '\\|')} |`)
  }
  out.push('')
  out.push(`Manifest — ${c.nlsTranslate} to translate, ${c.nlsReview} to review (package.nls.${id}.json, then node scripts/nls-sources.mjs ${id}):`)
  out.push('')
  out.push('| # | State | Key | English | German | Carried | Why |')
  out.push('|---|---|---|---|---|---|---|')
  i = 0
  for (const [key, v] of Object.entries(pending.nls)) {
    const carried = v.state === 'review' && own(lang.manifest, key) ? lang.manifest[key] : null
    const pick = (t) => (own(t, key) ? t[key] : null)
    out.push(`| ${++i} | ${v.state} | ${key} | ${cell(pick(lang.english))} | ${cell(pick(germanNls))} | ${cell(carried)} | ${v.why.replace(/\|/g, '\\|')} |`)
  }
  out.push('')
  out.push(`Once both lists are done: node scripts/nls-sources.mjs ${id}, then delete ${pendingFile(id)}.`)
  return `${out.join('\n')}\n`
}

// ---------------------------------------------------------------------------
// --start
// ---------------------------------------------------------------------------

/** The bytes of the base file: one line per key and per manifest key, so a diff reads as a list. */
export function serializeBase(base) {
  const lines = ['{', '  "v": 1,', `  "base": ${J(base.base)},`, '  "keys": {']
  const keys = Object.keys(base.keys)
  keys.forEach((k, i) => lines.push(`    ${J(k)}: [${base.keys[k].map(J).join(', ')}]${i < keys.length - 1 ? ',' : ''}`))
  lines.push('  },', '  "nls": {')
  const nls = Object.keys(base.nls)
  nls.forEach((k, i) => lines.push(`    ${J(k)}: ${J(base.nls[k])}${i < nls.length - 1 ? ',' : ''}`))
  lines.push('  }', '}')
  return `${lines.join('\n')}\n`
}

/**
 * The tree as it is, as a base: every extracted t() key with the German parts that hold it, and the
 * hash of every English manifest value. Refused when the German does not cover the extracted keys
 * exactly — a base every language can start from is a complete one.
 */
export async function baseOf(root, sha) {
  const parts = partNames(root)
  // Loaded here, not at the top: only --start reads the source, and the extract script brings the TypeScript parser.
  const { extract } = await import('./l10n-extract.mjs')
  const { keys, errors } = extract(join(root, 'src'), root)
  if (errors.length > 0) throw new Error(`l10n-extract: ${errors.join('; ')}`)
  const german = {}
  for (const part of parts) german[part] = readTable(root, `${PARTS_DIR}/${part}.de.json`)
  const problems = []
  const out = {}
  for (const key of Object.keys(keys)) {
    const holders = parts.filter((p) => own(german[p], key))
    if (holders.length === 0) problems.push(`no German part has ${J(key)}`)
    out[key] = holders
  }
  for (const part of parts) {
    for (const key of Object.keys(german[part])) if (!own(keys, key)) problems.push(`l10n/parts/${part}.de.json has ${J(key)}, which src/ does not`)
  }
  const english = readTable(root, ENGLISH)
  const germanNls = readTable(root, 'package.nls.de.json')
  if (J(Object.keys(germanNls)) !== J(Object.keys(english))) problems.push('package.nls.de.json does not have package.nls.json\'s keys in its order')
  if (problems.length > 0) throw new Error(`the tree is no base yet:\n  ${problems.slice(0, 20).join('\n  ')}`)
  const nls = {}
  for (const [k, v] of Object.entries(english)) nls[k] = sourceHash(v)
  return { v: 1, base: sha, keys: out, nls }
}

/** Starts a ledger: the base, no entries, a pending file at cursor 0 per language. */
export async function start(root, sha) {
  if (typeof sha !== 'string' || !SHA.test(sha)) throw new Error(`${J(sha)} is no commit — name the one the tree is at (git log -1)`)
  const parts = partNames(root)
  const langs = languages(root)
  const { ledger } = existsSync(join(root, LEDGER_FILE)) ? readLedger(root, parts) : { ledger: null }
  const n = ledger ? ledger.entries.length : 0
  const busy = []
  for (const id of pendingIds(root)) {
    let p
    try { p = readPending(root, id) } catch { busy.push(`${id}: ${pendingFile(id)} cannot be read`); continue }
    if (!isObject(p) || !isObject(p.bundle) || !isObject(p.nls)) { busy.push(`${id}: ${pendingFile(id)} is malformed`); continue }
    const keys = Object.keys(p.bundle).length + Object.keys(p.nls).length
    if (keys > 0) busy.push(`${id}: ${keys} key(s) pending`)
    else if (p.applied !== n) busy.push(`${id}: ${p.applied} of ${n} entries applied`)
  }
  if (busy.length > 0) throw new Error(`a language has work pending — finish it before a new ledger starts:\n  ${busy.join('\n  ')}`)
  const base = await baseOf(root, sha)
  mkdirSync(join(root, PENDING_DIR), { recursive: true })
  const wrote = []
  if (writeIfChanged(root, BASE_FILE, serializeBase(base))) wrote.push(BASE_FILE)
  if (writeIfChanged(root, LEDGER_FILE, serialize({ v: 1, base: sha, entries: [] }))) wrote.push(LEDGER_FILE)
  for (const id of langs) if (writeIfChanged(root, pendingFile(id), serialize(emptyPending()))) wrote.push(pendingFile(id))
  return { base, langs, wrote }
}

// ---------------------------------------------------------------------------
// The command line
// ---------------------------------------------------------------------------

async function main(argv) {
  const root = '.'
  const fail = (lines) => {
    for (const l of lines) console.error(`l10n-rekey: ${l}`)
    process.exit(1)
  }
  if (argv.includes('--check')) {
    const problems = checkAll(root)
    if (problems.length > 0) {
      fail([...problems, '', 'append the missing fields, or run `node scripts/l10n-rekey.mjs` to apply the entries.'])
    }
    const { ledger } = readLedger(root)
    const pending = languages(root).filter((id) => existsSync(join(root, pendingFile(id)))).length
    console.log(`l10n-rekey: every entry is applied (${ledger.entries.length} entr${ledger.entries.length === 1 ? 'y' : 'ies'} since ${ledger.base}; ${pending} language(s) with a pending list)`)
    return
  }
  const printAt = argv.indexOf('--print')
  if (printAt >= 0) {
    const id = argv[printAt + 1]
    if (!id || id.startsWith('--')) fail(['name a language — node scripts/l10n-rekey.mjs --print <id>'])
    try {
      process.stdout.write(printList(root, id))
    } catch (err) {
      fail([err.message])
    }
    return
  }
  const startAt = argv.indexOf('--start')
  if (startAt >= 0) {
    try {
      const { base, langs, wrote } = await start(root, argv[startAt + 1])
      for (const f of wrote) console.log(`l10n-rekey: wrote ${f}`)
      console.log(`l10n-rekey: a ledger starts at ${base.base} — ${Object.keys(base.keys).length} t() key(s), ${Object.keys(base.nls).length} manifest key(s); ${langs.length} language(s) at cursor 0`)
    } catch (err) {
      fail([err.message])
    }
    return
  }
  const unknown = argv.filter((a) => a.startsWith('--'))
  if (unknown.length > 0 || argv.length > 0) fail([`unknown argument(s): ${argv.join(' ')} — --check, --print <id>, --start <sha>, or none to apply`])
  let result
  try {
    result = applyAll(root)
  } catch (err) {
    fail([err.message])
  }
  const { lines, problems, wrote } = result
  for (const l of lines) console.log(`l10n-rekey: ${l}`)
  if (problems.length > 0) fail(problems)
  for (const f of wrote) console.log(`l10n-rekey: wrote ${f}`)
  if (wrote.length === 0) console.log('l10n-rekey: nothing to write')
}

// Only run the CLI when invoked directly, so a tool can import the functions.
if (process.argv[1] && process.argv[1].endsWith('l10n-rekey.mjs')) main(process.argv.slice(2))
