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

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// Every test is bundled into a single file in `out-test/`, so `__dirname` is that directory
// at runtime — one level below the repository root, wherever the source of this helper sits.
export const ROOT = join(__dirname, '..')

/** Anchored on purpose — see the note above. */
export const NLS_KEY = /^%([\w.\-]+)%$/

export const readJson = (name: string): unknown => JSON.parse(readFileSync(join(ROOT, name), 'utf8'))

export const englishNls = readJson('package.nls.json') as Record<string, string>
export const germanNls = readJson('package.nls.de.json') as Record<string, string>

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
