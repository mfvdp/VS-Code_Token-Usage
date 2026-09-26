// SPDX-FileCopyrightText: 2026 Frederik Marx
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * 1.9 §0a.2: the one file the language switch reads — Token Pace's own translation bundle for the
 * chosen language, `<extension folder>/l10n/bundle.l10n.<id>.json`.
 *
 * It is a file this extension ships (`.vscodeignore` keeps `!l10n/bundle.l10n.*.json`), holding the
 * translations of its own English strings: no user data, no file of another program, nothing over
 * the network. Until 1.8 VS Code read it for its own display language and handed it over as
 * `vscode.l10n.bundle`; since 1.9 Token Pace reads it itself, for the language `tokenPace.language`
 * names, at activation and when the setting changes.
 *
 * The file name is built from a registry id only (`LanguageId`, languages.ts): the setting's text is
 * matched against the registry first (config.ts `sanitize`) and never put into a path, so no value a
 * settings file holds can make this read anything but one of the registry's names below `l10nDir`.
 * English reads no file: its source text is the key.
 *
 * What is read is checked, not trusted: the value must be a plain object, and `setBundle` (i18n.ts)
 * keeps its non-empty strings only; the page's words are HTML-escaped on their way into the page.
 */

import * as fs from 'fs'
import * as path from 'path'
import { isLanguageId, LANGUAGE_IDS, LanguageId } from './languages'

/** The file name of a registry id's bundle — the only name this module ever reads. */
export function bundleFileName(id: LanguageId): string {
  return `bundle.l10n.${id}.json`
}

/** What went wrong, in a word the log can carry: an errno code, never a path or a message. */
function errorKind(err: unknown): string {
  const code = (err as { code?: unknown } | null)?.code
  if (typeof code === 'string' && /^[A-Z0-9_]{1,24}$/.test(code)) return code
  if (err instanceof SyntaxError) return 'not JSON'
  return 'unreadable'
}

/**
 * §0a.2: the bundle of a registry id, from `<l10nDir>/bundle.l10n.<id>.json`; null when it is missing or not an object.
 * English: {}. `fail` hears why a file gave null (an errno code, 'not JSON' or 'not an object') — for the one log line.
 */
export function readBundle(
  l10nDir: string,
  id: LanguageId,
  read: (file: string) => string = (file) => fs.readFileSync(file, 'utf8'),
  fail?: (errorKind: string) => void,
): Record<string, string> | null {
  if (id === 'en') return {}
  // The name is built from a registry id and nothing else: the type says so already, but a cast
  // upstream (a setting's text where an id belongs) must not reach a path.
  if (!isLanguageId(id)) {
    fail?.('not a registry id')
    return null
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(read(path.join(l10nDir, bundleFileName(id))))
  } catch (err) {
    fail?.(errorKind(err))
    return null
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    fail?.('not an object')
    return null
  }
  return parsed as Record<string, string>
}

/** The ids whose bundle file exists ('en' always) — what the picker offers; read once at activation. */
export function availableLanguages(
  l10nDir: string,
  exists: (file: string) => boolean = (file) => {
    try {
      return fs.statSync(file).isFile()
    } catch {
      return false
    }
  },
): LanguageId[] {
  return LANGUAGE_IDS.filter((id) => id === 'en' || exists(path.join(l10nDir, bundleFileName(id))))
}
