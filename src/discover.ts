// SPDX-FileCopyrightText: 2026 Frederik Marx
// SPDX-License-Identifier: AGPL-3.0-or-later

import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

/**
 * Both tools keep their data under the home directory — on Windows `~/.claude`
 * is `%USERPROFILE%\.claude`. Both also allow relocating that directory via an
 * environment variable; without honouring it a user would see zero tokens
 * forever, with no error to explain why.
 *
 * Caveat: the extension host only inherits variables that were set when VS Code
 * started — one set only in a shell profile does not reach here. Hence the
 * additional `tokenPace.claudeDir` / `tokenPace.codexDir` settings.
 */
function homeOf(envVar: string, fallback: string, override?: string): string {
  const explicit = override?.trim() || process.env[envVar]?.trim()
  return explicit ? path.resolve(untilde(explicit)) : path.join(os.homedir(), fallback)
}

/** Expand a leading "~" — people type it in settings. */
function untilde(p: string): string {
  return p === '~' || p.startsWith(`~${path.sep}`) || p.startsWith('~/')
    ? path.join(os.homedir(), p.slice(1))
    : p
}

/** Set once on activation; changes require a window reload. */
export let CLAUDE_ROOT = path.join(homeOf('CLAUDE_CONFIG_DIR', '.claude'), 'projects')
export let CODEX_ROOT = path.join(homeOf('CODEX_HOME', '.codex'), 'sessions')

export function configureRoots(claudeDir?: string, codexDir?: string): { claude: string; codex: string } {
  CLAUDE_ROOT = path.join(homeOf('CLAUDE_CONFIG_DIR', '.claude', claudeDir), 'projects')
  CODEX_ROOT = path.join(homeOf('CODEX_HOME', '.codex', codexDir), 'sessions')
  return { claude: CLAUDE_ROOT, codex: CODEX_ROOT }
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
