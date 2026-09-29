// SPDX-FileCopyrightText: 2026 Frederik Marx
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * 1.14 A1 (§0a.1–§0a.3): what a project is, and how it is named — pure, no `vscode` import.
 *
 * A project is a folder. Claude Code files every session started in a folder, and every agent those
 * sessions ran (a worktree's agent too), under one directory below its projects root, named by
 * `slugOf(folder)`; Codex writes the folder into its rollout's `session_meta` as `cwd`. The key is a salted
 * hash of that slug — the same folder gives the same key in both programs, and nothing in the key spells
 * the folder out. Twelve hex digits are 48 bits: for 200 projects the chance of two sharing a key is about
 * 200² / 2⁴⁹ ≈ 7 × 10⁻¹¹.
 *
 * What a view prints for a key is `projectLabel`: the folder's name under `showProjectNames: basename`
 * (read only then, only from a main transcript whose working directory is the folder itself, and held to
 * §0's alphabet by `cleanProjectName`), else the pseudonym `p:` + the key — the form the manifest's example
 * has shown since 1.0.
 */

import { createHash } from 'crypto'
import { t } from './i18n'
import type { ProjectLabel } from './types'

/** A project's key: twelve lower-case hex digits; '' is the unattributed key — a Codex rollout without a working directory. */
export const PROJECT_KEY_RE = /^(?:[0-9a-f]{12})?$/
/** The key of the usage no folder can be named for (§3 A1 rule 2, §7a Q15). */
export const UNATTRIBUTED = ''
/** §3 A3: at most this many projects keep their own key; the least recently active beyond it fold into OTHER_PROJECTS. */
export const PROJECT_CAP = 200
/** The key the folded projects share — no hash can be it (it is not hex). */
export const OTHER_PROJECTS = '*'
/** §0a.2 rule 3: a folder's name is cut to this many characters (no ellipsis character). */
export const PROJECT_NAME_MAX_CHARS = 64
/** §0a.8: at most this many projects in the project filter (P5). */
export const MAX_PROJECT_FILTER = 50
/** The key's domain tag: a later rule is `-2`, and a key of another use of the salt can never equal it. */
export const PROJECT_KEY_TAG = 'tp-project-1'
/** The pseudonym's prefix — `p:8f31c0a4e2b1`. */
export const PSEUDONYM_PREFIX = 'p:'

/** A stored key this build accepts: `PROJECT_KEY_RE` or `OTHER_PROJECTS`. */
export function isProjectKey(v: unknown): v is string {
  return typeof v === 'string' && (v === OTHER_PROJECTS || PROJECT_KEY_RE.test(v))
}

/**
 * Claude Code's directory rule, read from the directory names on disk: every character outside
 * `[A-Za-z0-9]` becomes '-' — `/home/fm/Claude/VS-Code_Tokens` → `-home-fm-Claude-VS-Code-Tokens`. Per UTF-16
 * code unit, as the program's own JavaScript replace does (not traced for a path long enough for Claude Code
 * to shorten its directory name).
 */
export function slugOf(dir: string): string {
  return dir.replace(/[^A-Za-z0-9]/g, '-')
}

/** sha256("tp-project-1\0" + salt + "\0" + slug), the first twelve hex digits; '' for an empty salt or slug. */
export function projectKeyOf(salt: string, slug: string): string {
  if (typeof salt !== 'string' || typeof slug !== 'string' || salt === '' || slug === '') return UNATTRIBUTED
  return createHash('sha256').update(`${PROJECT_KEY_TAG}\0${salt}\0${slug}`).digest('hex').slice(0, 12)
}

/** The characters a folder's name keeps (§0's alphabet without the '/', which a name cannot hold). */
const NAME_CHAR_RE = /^[A-Za-z0-9_.:@-]$/

/**
 * §0a.2 rule 3 (§7a Q3): NFC, every character outside `[A-Za-z0-9_.:@-]` → '_', runs of '_' folded, at most
 * `PROJECT_NAME_MAX_CHARS` — `Büro-App` → `B_ro-App`, `Mein Projekt` → `Mein_Projekt`. Null when nothing is left
 * that names anything: no letter and no digit (the pseudonym is shown instead).
 */
export function cleanProjectName(base: unknown): string | null {
  if (typeof base !== 'string' || base.length === 0) return null
  let out = ''
  // By code point: a character outside the BMP is one '_', not two.
  for (const ch of base.normalize('NFC')) {
    const c = NAME_CHAR_RE.test(ch) ? ch : '_'
    if (c === '_' && out.endsWith('_')) continue
    out += c
  }
  out = out.slice(0, PROJECT_NAME_MAX_CHARS)
  return /[A-Za-z0-9]/.test(out) ? out : null
}

/**
 * What every view prints for a key: the folder's name when the table has one and names are on, else
 * `p:` + key; `(no project)` for '', `other projects` for `OTHER_PROJECTS`. A name is only ever in the table
 * under `showProjectNames: basename` (§3 A7: switching to `hash` drops every name at once), so `names`
 * is a second lock, not the first.
 */
export function projectLabel(key: string, labels: Readonly<Record<string, ProjectLabel>>, names: boolean): string {
  if (key === UNATTRIBUTED) return t('(no project)')
  if (key === OTHER_PROJECTS) return t('other projects')
  const name = names && Object.prototype.hasOwnProperty.call(labels, key) ? labels[key].name : undefined
  return name ?? `${PSEUDONYM_PREFIX}${key}`
}
