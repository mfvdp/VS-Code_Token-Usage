// SPDX-FileCopyrightText: 2026 Frederik Marx
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The provider registry is only worth having if it is the *only* place a provider is
 * described. These tests pin both halves of that: the derived tables must agree with the
 * registry, and no shipped module may spell a provider's name out again — the failure mode
 * this replaces was a second table drifting from the first, which a user only ever sees as
 * one provider wearing two names.
 *
 * Synthetic data only; the source tree is read, nothing outside the repository is touched.
 */

import { strict as assert } from 'node:assert'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import {
  ADAPTERS, LABEL, PROVIDER_NAME, SOURCES, SOURCE_TITLE, USAGE_PAGE, adapterFor, isKnownSource,
  maybeAdapterFor, tableOf,
} from '../src/adapters'
import { freshInput, SOURCE_TITLE as STATS_TITLE } from '../src/stats'
import { USAGE_PAGE as STATUS_USAGE_PAGE } from '../src/statusText'
import { emptyBucket } from '../src/types'
import type { Source } from '../src/types'

const ROOT = join(__dirname, '..')

test('SOURCES is the registry, in registry order', () => {
  assert.deepEqual(SOURCES, ADAPTERS.map((a) => a.id))
  assert.deepEqual(SOURCES, ['claude', 'codex'])
  for (const s of SOURCES) assert.equal(adapterFor(s).id, s)
  // No duplicate ids: two adapters answering to one source would make `adapterFor` a coin toss.
  assert.equal(new Set(SOURCES).size, SOURCES.length)
})

test('every adapter names itself completely', () => {
  for (const a of ADAPTERS) {
    for (const [field, value] of [
      ['title', a.title], ['name', a.name], ['shortLabel', a.shortLabel], ['usagePageUrl', a.usagePageUrl],
    ] as Array<[string, string]>) {
      assert.equal(typeof value, 'string', `${a.id}.${field}`)
      assert.ok(value.trim().length > 0, `${a.id}.${field} is empty`)
    }
    assert.ok(a.usagePageUrl.startsWith('https://'), a.usagePageUrl)
    assert.ok(a.quotaSourceIds.length > 0, `${a.id} has no quota source`)
    assert.equal(new Set(a.quotaSourceIds).size, a.quotaSourceIds.length, `${a.id} repeats a quota source`)
  }
  // Two providers must not share a title or a prefix — the status bar would be unreadable.
  assert.equal(new Set(ADAPTERS.map((a) => a.title)).size, ADAPTERS.length)
  assert.equal(new Set(ADAPTERS.map((a) => a.shortLabel)).size, ADAPTERS.length)
  assert.equal(new Set(ADAPTERS.map((a) => a.usagePageUrl)).size, ADAPTERS.length)
})

test('the derived tables are the registry and cover every source', () => {
  assert.deepEqual(SOURCE_TITLE, tableOf((a) => a.title))
  assert.deepEqual(PROVIDER_NAME, tableOf((a) => a.name))
  assert.deepEqual(LABEL, tableOf((a) => a.shortLabel))
  assert.deepEqual(USAGE_PAGE, tableOf((a) => a.usagePageUrl))
  for (const t of [SOURCE_TITLE, PROVIDER_NAME, LABEL, USAGE_PAGE]) {
    assert.deepEqual(Object.keys(t).sort(), [...SOURCES].sort())
  }
  // The two modules that re-export a table must hand on the registry's, not a copy of it.
  assert.equal(STATS_TITLE, SOURCE_TITLE)
  assert.equal(STATUS_USAGE_PAGE, USAGE_PAGE)
})

test('the titles and labels the views print are the ones users know', () => {
  assert.deepEqual(SOURCE_TITLE, { claude: 'Claude Code', codex: 'Codex' })
  assert.deepEqual(PROVIDER_NAME, { claude: 'Claude', codex: 'Codex' })
  assert.deepEqual(LABEL, { claude: 'CC', codex: 'CDX' })
})

test('the file predicates belong to the adapter that reads them', () => {
  const claude = adapterFor('claude')
  const codex = adapterFor('codex')
  assert.equal(claude.matches('sess-0001.jsonl'), true)
  assert.equal(claude.matches('sess-0001.json'), false)
  assert.equal(codex.matches('rollout-2026-03-10T09-00-00-abc.jsonl'), true)
  assert.equal(codex.matches('notes.jsonl'), false)
  assert.equal(claude.isSub(join('r', 'sess', 'subagents', 'a.jsonl')), true)
  assert.equal(claude.isSub(join('r', 'sess.jsonl')), false)
  // Codex has no subagent transcripts at all — the answer is "no", never "unknown".
  assert.equal(codex.isSub(join('r', 'sess', 'subagents', 'a.jsonl')), false)
})

test('roots come from the adapter and honour an explicit directory', () => {
  const dirs = [join('/virtual', 'home')]
  assert.deepEqual(adapterFor('claude').roots(dirs), [join('/virtual', 'home', 'projects')])
  assert.deepEqual(adapterFor('codex').roots(dirs), [join('/virtual', 'home', 'sessions')])
})

test('freshInput is the adapter rule, so stats and pricing cannot disagree', () => {
  const claude = { ...emptyBucket('claude', 'claude-opus-4-6', false, 'standard', 'h', 0, '2026-03-10'), input: 100, cacheRead: 40 }
  const codex = { ...emptyBucket('codex', 'gpt-5.4-codex', false, 'standard', 'h', 0, '2026-03-10'), input: 100, cacheRead: 40 }
  // Claude reports cache reads beside the input, Codex reports them inside it.
  assert.equal(freshInput(claude), 100)
  assert.equal(freshInput(codex), 60)
  assert.equal(adapterFor('claude').freshInput(claude), 100)
  assert.equal(adapterFor('codex').freshInput(codex), 60)
})

test('a source that is only claimed to be one is answered, not dereferenced', () => {
  // Snapshots are files: `source` arrives as plain text and may name a provider this build
  // has never heard of. The lookup says so; it does not hand out `undefined.freshInput`.
  for (const s of SOURCES) assert.equal(maybeAdapterFor(s), adapterFor(s))
  for (const s of ['gemini', '', 'Claude', 'claude ']) {
    assert.equal(maybeAdapterFor(s), undefined, s)
    assert.equal(isKnownSource(s), false, s)
  }
  assert.equal(isKnownSource(undefined), false)
  assert.equal(isKnownSource(null), false)
  for (const s of SOURCES) assert.equal(isKnownSource(s), true)
  // Nothing inherited from Object.prototype passes for an adapter either.
  assert.equal(maybeAdapterFor('toString'), undefined)
  assert.equal(isKnownSource('constructor'), false)

  // `freshInput` therefore stays total: an unknown provider gets the plain reading.
  const alien = { ...emptyBucket('gemini' as Source, 'gemini-9', false, 'standard', 'h', 0, '2026-03-10'), input: 100, cacheRead: 40 }
  assert.equal(freshInput(alien), 100)
})

test('readQuota reaches the real reader and states an absence rather than inventing one', () => {
  const inputs = {
    claudeOrder: [], codexOrder: [], polled: {}, transcript: () => [],
    mirrorFile: join('/virtual', 'missing-mirror.json'),
    claudeJsonFile: join('/virtual', 'missing.json'),
    claudeCacheFile: join('/virtual', 'missing-claude.json'),
    codexCacheFile: join('/virtual', 'missing-codex.json'),
    mode: 'cache' as const,
  }
  for (const a of ADAPTERS) {
    for (const id of a.quotaSourceIds) {
      const r = a.readQuota(id, inputs, 1_772_000_000_000)
      assert.equal(r.id, id, `${a.id}/${id}`)
      assert.equal(r.state.source, a.id, `${a.id}/${id}`)
      // Nothing exists to read, so every reading must fail — and say so.
      assert.equal(r.state.ok, false, `${a.id}/${id}`)
      assert.ok((r.state.problem ?? '').length > 0, `${a.id}/${id} failed without a reason`)
      assert.deepEqual(r.state.windows, [], `${a.id}/${id} invented a window`)
    }
  }
})

test('the quota source ids match the manifest enums', () => {
  const manifest = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
  const sections = manifest.contributes.configuration as Array<{ properties: Record<string, { items?: { enum?: string[] } }> }>
  const props: Record<string, { items?: { enum?: string[] } }> = {}
  for (const s of sections) Object.assign(props, s.properties)
  const enumOf = (key: string): string[] => props[key]?.items?.enum ?? []
  const keys: Record<Source, string> = {
    claude: 'tokenPace.claudeQuotaSources',
    codex: 'tokenPace.codexQuotaSources',
  }
  for (const a of ADAPTERS) {
    assert.deepEqual([...a.quotaSourceIds], enumOf(keys[a.id]), a.id)
  }
})

/** Every `.ts` file the extension ships, so the scan below cannot miss a new module. */
function srcFiles(dir: string): string[] {
  const out: string[] = []
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    // The registry is the one place a provider may be spelled out.
    if (e.isDirectory()) { if (e.name !== 'adapters') out.push(...srcFiles(p)) } else if (e.name.endsWith('.ts')) out.push(p)
  }
  return out.sort()
}

/** Comment lines are prose about the code, not a second table; they may name a provider. */
function withoutCommentLines(text: string): string {
  return text
    .split('\n')
    .filter((l) => {
      const t = l.trimStart()
      return !(t.startsWith('//') || t.startsWith('*') || t.startsWith('/*'))
    })
    .join('\n')
}

test('no module outside the registry spells a provider name out again', () => {
  const names = [...ADAPTERS.map((a) => a.title), ...ADAPTERS.map((a) => a.name), ...ADAPTERS.map((a) => a.shortLabel)]
  const offenders: string[] = []
  for (const file of srcFiles(join(ROOT, 'src'))) {
    const code = withoutCommentLines(readFileSync(file, 'utf8'))
    for (const name of new Set(names)) {
      // A whole string literal equal to the name: prose that merely mentions it is fine,
      // a second lookup table is not. Names are plain words, so nothing needs escaping.
      const re = new RegExp(`(['"\`])${name}\\1`)
      if (re.test(code)) offenders.push(`${file.slice(ROOT.length + 1)}: ${name}`)
    }
  }
  assert.deepEqual(offenders, [], `provider names outside src/adapters:\n${offenders.join('\n')}`)
})

test('the usage page URLs live only in the registry', () => {
  const offenders: string[] = []
  for (const file of srcFiles(join(ROOT, 'src'))) {
    const code = readFileSync(file, 'utf8')
    for (const a of ADAPTERS) if (code.includes(a.usagePageUrl)) offenders.push(`${file.slice(ROOT.length + 1)}: ${a.id}`)
  }
  assert.deepEqual(offenders, [])
})
