// SPDX-FileCopyrightText: 2026 Frederik Marx
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The manifest no longer carries its own prose: every user-visible string is a `%key%` that
 * VS Code resolves out of `package.nls.json` (or `package.nls.<locale>.json`). The tests that
 * pin that prose — the README parity in `docs.test.ts`, the settings checks in
 * `config.test.ts` — must therefore read the *resolved* manifest, or they would only ever see
 * the placeholders and pass on an empty promise.
 *
 * `resolveNls` follows VS Code's own rule (`extensionNls.ts`): a value is replaced only when
 * it is *exactly* `%key%`, never as a substring. That is what keeps `%USERPROFILE%\\.claude`
 * inside a description from being mistaken for a translation key.
 */

import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

// Every test is bundled into a single file in `out-test/`, so `__dirname` is that directory
// at runtime — one level below the repository root, wherever the source of this helper sits.
export const ROOT = join(__dirname, '..')

/** Anchored on purpose — see the note above. */
export const NLS_KEY = /^%([\w.\-]+)%$/

export const readJson = (name: string): unknown => JSON.parse(readFileSync(join(ROOT, name), 'utf8'))

export const englishNls = readJson('package.nls.json') as Record<string, string>
export const germanNls = readJson('package.nls.de.json') as Record<string, string>

/**
 * 1.9 B3: every translation of the manifest on disk — `package.nls.<id>.json`, German among them —
 * with its id and its table, in file-name order. `root` is the repository unless a test names a
 * temporary directory holding a synthetic language.
 */
export function nlsFiles(root: string = ROOT): Array<{ id: string; file: string; nls: Record<string, string> }> {
  return readdirSync(root)
    .map((file) => ({ file, m: /^package\.nls\.(.+)\.json$/.exec(file) }))
    .filter((x): x is { file: string; m: RegExpExecArray } => x.m !== null)
    .sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0))
    .map(({ file, m }) => ({ id: m[1], file, nls: JSON.parse(readFileSync(join(root, file), 'utf8')) as Record<string, string> }))
}

/**
 * 1.10 B1: the manifest keys a language has not translated or reviewed yet — the `nls` map of its pending list,
 * `l10n/pending/<id>.json`, which scripts/l10n-rekey.mjs writes when the English changes. Such a key holds the English
 * (added) or a translation of the English before the change (reworded), so a rule that compares a value with today's
 * English skips it; test/l10n.languages.test.ts (T14) allows no pending list once PENDING_ALLOWED is false (the join).
 */
export function pendingNlsKeys(id: string, root: string = ROOT): Set<string> {
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(join(root, 'l10n', 'pending', `${id}.json`), 'utf8'))
  } catch {
    return new Set()
  }
  const nls = (parsed as { nls?: unknown } | null)?.nls
  return typeof nls === 'object' && nls !== null && !Array.isArray(nls) ? new Set(Object.keys(nls)) : new Set()
}

/** The raw manifest, placeholders and all — for the tests that check the placeholders. */
export const rawManifest = readJson('package.json') as Record<string, unknown>

/** Every `%key%` the manifest uses, in the order it uses them. */
export function manifestKeys(node: unknown = rawManifest, out: string[] = []): string[] {
  if (typeof node === 'string') {
    const m = NLS_KEY.exec(node)
    if (m) out.push(m[1])
  } else if (Array.isArray(node)) {
    for (const item of node) manifestKeys(item, out)
  } else if (node && typeof node === 'object') {
    for (const value of Object.values(node)) manifestKeys(value, out)
  }
  return out
}

/** A deep copy of `node` with every `%key%` replaced from `nls`; an unknown key is kept. */
export function resolveNls<T>(node: T, nls: Record<string, string> = englishNls): T {
  if (typeof node === 'string') {
    const m = NLS_KEY.exec(node)
    return (m && m[1] in nls ? nls[m[1]] : node) as unknown as T
  }
  if (Array.isArray(node)) return node.map((item) => resolveNls(item, nls)) as unknown as T
  if (node && typeof node === 'object') {
    const out: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(node)) out[key] = resolveNls(value, nls)
    return out as unknown as T
  }
  return node
}

/** `package.json` as a user of the English build sees it. */
export function readManifest<T>(nls: Record<string, string> = englishNls): T {
  return resolveNls(readJson('package.json'), nls) as T
}
