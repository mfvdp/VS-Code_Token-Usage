// SPDX-FileCopyrightText: 2026 Frederik Marx
// SPDX-License-Identifier: AGPL-3.0-or-later

import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { Source } from './types'

/**
 * Both tools keep their data under the home directory — on Windows `~/.claude`
 * is `%USERPROFILE%\.claude`. Both also allow relocating that directory via an
 * environment variable; without honouring it a user would see zero tokens
 * forever, with no error to explain why.
 *
 * Caveat: the extension host only inherits variables that were set when VS Code
 * started — one set only in a shell profile does not reach here. Hence the
 * additional `tokenPace.claudeDir` / `tokenPace.codexDir` settings, which may
 * name several directories: people move between machines and keep old homes.
 */
function homesOf(envVar: string, fallback: string, overrides: string[]): string[] {
  const explicit = overrides.map((o) => o.trim()).filter((o) => o.length > 0)
  if (explicit.length) return explicit.map((o) => path.resolve(untilde(o)))
  const env = process.env[envVar]?.trim()
  return [env ? path.resolve(untilde(env)) : path.join(os.homedir(), fallback)]
}

/** Expand a leading "~" — people type it in settings. */
function untilde(p: string): string {
  return p === '~' || p.startsWith(`~${path.sep}`) || p.startsWith('~/')
    ? path.join(os.homedir(), p.slice(1))
    : p
}

function isDir(p: string): boolean {
  try { return fs.statSync(p).isDirectory() } catch { return false }
}

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

/** Set on activation; changes require a window reload. */
export let CLAUDE_ROOTS: string[] = []
export let CODEX_ROOTS: string[] = []
/** First root of each tool — for callers that still expect a single directory. */
export let CLAUDE_ROOT = ''
export let CODEX_ROOT = ''

export function configureRoots(claudeDirs: string[] = [], codexDirs: string[] = []): { claude: string[]; codex: string[] } {
  const claude: string[] = []
  for (const home of homesOf('CLAUDE_CONFIG_DIR', '.claude', claudeDirs)) claude.push(path.join(home, 'projects'))
  if (claudeDirs.every((d) => !d.trim())) {
    // Some Claude Code builds keep their state under XDG config instead of ~/.claude.
    const xdg = path.join(os.homedir(), '.config', 'claude', 'projects')
    if (isDir(xdg)) claude.push(xdg)
  }
  const codex: string[] = []
  for (const home of homesOf('CODEX_HOME', '.codex', codexDirs)) {
    codex.push(path.join(home, 'sessions'))
    // Archived threads keep their rollouts; leaving them out would make usage vanish on archive.
    const archived = path.join(home, 'archived_sessions')
    if (isDir(archived)) codex.push(archived)
  }
  CLAUDE_ROOTS = dedupe(claude)
  CODEX_ROOTS = dedupe(codex)
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
  for (const root of CLAUDE_ROOTS) if (under(file, root)) return { source: 'claude', root }
  for (const root of CODEX_ROOTS) if (under(file, root)) return { source: 'codex', root }
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

export const isClaudeTranscript = (n: string) => n.endsWith('.jsonl')
export const isCodexRollout = (n: string) => n.startsWith('rollout-') && n.endsWith('.jsonl')

/** Subagent transcripts live under .../<sessionId>/subagents/... */
export const isClaudeSubagent = (p: string) => p.includes(`${path.sep}subagents${path.sep}`)
