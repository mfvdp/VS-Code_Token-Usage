// SPDX-FileCopyrightText: 2026 Frederik Marx
// SPDX-License-Identifier: AGPL-3.0-or-later

import * as fs from 'fs'
import * as path from 'path'
import { ADAPTERS, adapterFor, tableOf } from './adapters'
import { Source } from './types'

/**
 * Two settings naming the same directory through a symlink or a trailing slash
 * would count every transcript twice — the realpath is the identity, when it
 * resolves; a directory that does not exist yet keeps its literal spelling so
 * diagnostics can still show it.
 */
function dedupe(roots: string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const r of roots) {
    let key = path.resolve(r)
    try { key = fs.realpathSync(key) } catch { /* missing: literal path is the identity */ }
    if (seen.has(key)) continue
    seen.add(key)
    out.push(path.resolve(r))
  }
  return out
}

/**
 * Set on activation; changes require a window reload. Where a provider's transcripts live is
 * the adapter's answer (`src/adapters`); this module only resolves, dedupes and remembers it.
 */
const ROOTS: Record<Source, string[]> = tableOf(() => [] as string[])
export let CLAUDE_ROOTS: string[] = []
export let CODEX_ROOTS: string[] = []
/** First root of each tool — for callers that still expect a single directory. */
export let CLAUDE_ROOT = ''
export let CODEX_ROOT = ''

/** The configured roots of one provider, for callers that iterate the registry. */
export function rootsFor(source: Source): string[] {
  return ROOTS[source]
}

export function configureRoots(claudeDirs: string[] = [], codexDirs: string[] = []): { claude: string[]; codex: string[] } {
  const dirs: Record<Source, string[]> = { claude: claudeDirs, codex: codexDirs }
  for (const a of ADAPTERS) ROOTS[a.id] = dedupe(a.roots(dirs[a.id]))
  CLAUDE_ROOTS = ROOTS.claude
  CODEX_ROOTS = ROOTS.codex
  CLAUDE_ROOT = CLAUDE_ROOTS[0] ?? ''
  CODEX_ROOT = CODEX_ROOTS[0] ?? ''
  return { claude: [...CLAUDE_ROOTS], codex: [...CODEX_ROOTS] }
}

configureRoots()

function under(file: string, root: string): boolean {
  const r = root.endsWith(path.sep) ? root : root + path.sep
  return file.startsWith(r)
}

/** Which tool a transcript path belongs to, by the configured roots; null when it is outside all of them. */
export function rootOf(file: string): { source: Source; root: string } | null {
  for (const a of ADAPTERS) {
    for (const root of ROOTS[a.id]) if (under(file, root)) return { source: a.id, root }
  }
  return null
}

/**
 * Collects transcript files below a root directory.
 *
 * Deliberately narrow: only `projects/` and `sessions/` are walked. That means
 * `~/.claude/ide/*.lock` (which holds an authToken in clear text) and
 * `~/.claude/sessions/*.key` (session keys) are never touched — not even
 * accidentally through a symlink.
 */
export async function findTranscripts(root: string, match: (name: string) => boolean): Promise<string[]> {
  const out: string[] = []
  const stack = [root]
  while (stack.length) {
    const dir = stack.pop()!
    let entries: fs.Dirent[]
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const e of entries) {
      const p = path.join(dir, e.name)
      // Do not follow symlinks: one could point out of projects/.
      if (e.isSymbolicLink()) continue
      if (e.isDirectory()) stack.push(p)
      else if (e.isFile() && match(e.name)) out.push(p)
    }
  }
  return out.sort()
}

// The three predicates the registry answers, named per provider for the callers that ask
// about exactly one of them (diagnostics, tests). New code should ask the adapter.
export const isClaudeTranscript = (n: string) => adapterFor('claude').matches(n)
export const isCodexRollout = (n: string) => adapterFor('codex').matches(n)
/** Subagent transcripts live under .../<sessionId>/subagents/... */
export const isClaudeSubagent = (p: string) => adapterFor('claude').isSub(p)
