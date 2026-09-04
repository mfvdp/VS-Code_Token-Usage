// SPDX-FileCopyrightText: 2026 Frederik Marx
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The provider registry — one place for everything that is per *provider*.
 *
 * Before this module the same two-entry table was written out nine times: the
 * titles in `stats.ts`, `statusText.ts`, `digest.ts`, `statusbar.ts` and the
 * webview script, the usage-page URLs twice, the `SOURCES` list twice, plus the
 * `source === 'claude'` branches in `discover.ts`, `scan.ts` and
 * `quotaSources.ts`. Nine tables are nine chances for a name, a URL or an order
 * to drift — and the drift is invisible until a user sees two names for one
 * provider.
 *
 * What belongs here: facts about a provider (its names, its usage page, where
 * its transcripts live, how a line of them is ingested, which quota sources it
 * has). What deliberately does NOT: pricing (that is per model, not per
 * provider), the persisted quota history (its keys are storage, not identity)
 * and the settings enums (per-provider settings stay spelled out in the
 * manifest, where a user reads them).
 *
 * `Source` stays a two-member union on purpose: the exhaustiveness checks the
 * compiler does on it are exactly what makes a registry safe to refactor into.
 * Adding a provider is a deliberate act — a new union member, a new adapter,
 * and the compiler then names every place that still has to decide something.
 */

import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

import type { Aggregator, IngestContext } from '../agg'
import {
  CLAUDE_QUOTA_FILE, CODEX_QUOTA_FILE, codexStateFromTranscript, readClaudeJsonUtilization,
  readClaudeQuota, readCodexQuota, readStatuslineMirror,
} from '../quota'
// Type only, and deliberately so: `quotaSources` imports this module for real, so a value
// import back would be a runtime cycle. The types are erased, the cycle never exists.
import type {
  ClaudeSourceId, CodexSourceId, Reading, SourceExtras, SourceId, SourceInputs,
} from '../quotaSources'
import { Bucket, Cursor, QuotaState, Source } from '../types'

/** Everything the extension knows about one provider. */
export interface ProviderAdapter {
  id: Source
  /** The product as it is called on screen — "Claude Code", not "claude". */
  title: string
  /**
   * The provider in prose. Alerts say "Claude quota", not "Claude Code quota": the quota
   * belongs to the account, not to the editor integration that spends it.
   */
  name: string
  /** Terse status-bar prefix; `tokenPace.labels` overrides it. */
  shortLabel: string
  /** The provider's own usage page — the only URLs this extension ever opens. */
  usagePageUrl: string
  /**
   * Directories to walk for transcripts, derived from the user's configured directories for
   * this provider (empty means: use the environment variable, else the default home).
   * Returned unnormalised — `discover.configureRoots` dedupes across the result.
   */
  roots(dirs: string[]): string[]
  /** Whether a file name below a root is one of this provider's transcripts. */
  matches(name: string): boolean
  /** Whether a transcript path belongs to a subagent rather than the main session. */
  isSub(file: string): boolean
  /** Feeds one transcript line to the aggregator; true when it counted tokens. */
  ingest(line: string, cur: Cursor, ctx: IngestContext, agg: Aggregator): boolean
  /**
   * Neutralises the derived cursor fields before a re-read from the start. Only providers
   * whose counters are cumulative have anything to undo here.
   */
  resetCursor(cur: Cursor): void
  /** Input tokens that are not cache reads — the two tools report them differently. */
  freshInput(b: Bucket): number
  /** The quota sources this provider can be read from, in the manifest's default order. */
  quotaSourceIds: readonly SourceId[]
  /** One reading of one source. Never merges sources — that rule lives in `quotaSources`. */
  readQuota(id: SourceId, inputs: SourceInputs, now: number): Reading
}

// ---------------------------------------------------------------------------
// Root discovery
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Quota readings
// ---------------------------------------------------------------------------

function missing(source: Source): QuotaState {
  return {
    source, ok: false, fetchedAt: null, planType: null, windows: [],
    problem: 'No fetch of our own yet', problemKind: 'unknown',
  }
}

function readClaude(id: ClaudeSourceId, inputs: SourceInputs, now: number): Reading {
  switch (id) {
    case 'cacheFile':
      return { id, state: readClaudeQuota(inputs.claudeCacheFile ?? CLAUDE_QUOTA_FILE, now), identityHint: null }
    case 'statusline': {
      const r = readStatuslineMirror(inputs.mirrorFile)
      // The extras ride along even when the payload carried no rate limits at
      // all: a context window without a quota window is still a fact the bridge
      // observed, and dropping it would hide it behind an unrelated absence.
      const extras: SourceExtras = {
        context: r.context === null ? null : { ...r.context, fetchedAt: r.state.fetchedAt },
        cost: r.cost,
        promptCache: r.promptCache,
        model: r.model,
      }
      return { id, state: r.state, identityHint: r.identityHint, extras }
    }
    case 'claudeJson': {
      const r = readClaudeJsonUtilization(inputs.claudeJsonFile, now)
      return { id, state: r.state, identityHint: r.identityHint }
    }
    case 'poll':
      return { id, state: inputs.polled.claude ?? missing('claude'), identityHint: null }
  }
}

function readCodex(id: CodexSourceId, inputs: SourceInputs, now: number): Reading {
  switch (id) {
    case 'cacheFile':
      return { id, state: readCodexQuota(inputs.codexCacheFile ?? CODEX_QUOTA_FILE, now), identityHint: null }
    case 'transcript':
      return { id, state: codexStateFromTranscript(inputs.transcript()), identityHint: null }
    case 'poll':
      return { id, state: inputs.polled.codex ?? missing('codex'), identityHint: null }
  }
}

// ---------------------------------------------------------------------------
// The adapters
// ---------------------------------------------------------------------------

const CLAUDE: ProviderAdapter = {
  id: 'claude',
  title: 'Claude Code',
  name: 'Claude',
  shortLabel: 'CC',
  usagePageUrl: 'https://claude.ai/settings/usage',
  roots(dirs) {
    const out: string[] = []
    for (const home of homesOf('CLAUDE_CONFIG_DIR', '.claude', dirs)) out.push(path.join(home, 'projects'))
    if (dirs.every((d) => !d.trim())) {
      // Some Claude Code builds keep their state under XDG config instead of ~/.claude.
      const xdg = path.join(os.homedir(), '.config', 'claude', 'projects')
      if (isDir(xdg)) out.push(xdg)
    }
    return out
  },
  matches: (n) => n.endsWith('.jsonl'),
  /** Subagent transcripts live under .../<sessionId>/subagents/... */
  isSub: (p) => p.includes(`${path.sep}subagents${path.sep}`),
  ingest: (line, _cur, ctx, agg) => agg.addClaudeLine(line, ctx),
  // A re-read from the start needs no reset: message ids still in `pending` dedupe
  // themselves, and there is no cumulative state to unwind.
  resetCursor: () => { /* nothing derived */ },
  freshInput: (b) => b.input,
  quotaSourceIds: ['cacheFile', 'statusline', 'claudeJson', 'poll'],
  readQuota: (id, inputs, now) => readClaude(id as ClaudeSourceId, inputs, now),
}

const CODEX: ProviderAdapter = {
  id: 'codex',
  title: 'Codex',
  name: 'Codex',
  shortLabel: 'CDX',
  usagePageUrl: 'https://chatgpt.com/codex/settings/usage',
  roots(dirs) {
    const out: string[] = []
    for (const home of homesOf('CODEX_HOME', '.codex', dirs)) {
      out.push(path.join(home, 'sessions'))
      // Archived threads keep their rollouts; leaving them out would make usage vanish on archive.
      const archived = path.join(home, 'archived_sessions')
      if (isDir(archived)) out.push(archived)
    }
    return out
  },
  matches: (n) => n.startsWith('rollout-') && n.endsWith('.jsonl'),
  isSub: () => false,
  ingest: (line, cur, ctx, agg) => agg.addCodexLine(line, cur, ctx),
  /**
   * Before a re-read from the start the derived Codex fields must be neutral again — a stale
   * baseline would swallow every event of the rewritten file up to the old total.
   */
  resetCursor: (cur) => {
    cur.lastTotal = undefined
    cur.replayDone = false
    cur.startTs = undefined
    cur.forked = false
  },
  // Codex reports cached tokens inside `input_tokens`; Claude reports them apart.
  freshInput: (b) => Math.max(0, b.input - b.cacheRead),
  quotaSourceIds: ['cacheFile', 'transcript', 'poll'],
  readQuota: (id, inputs, now) => readCodex(id as CodexSourceId, inputs, now),
}

/** Every provider, in the order the views list them. */
export const ADAPTERS: readonly ProviderAdapter[] = [CLAUDE, CODEX]

const BY_ID: Record<Source, ProviderAdapter> = { claude: CLAUDE, codex: CODEX }

export function adapterFor(source: Source): ProviderAdapter {
  return BY_ID[source]
}

/**
 * The adapter for a source that is only *claimed* to be one — the id read back from a
 * snapshot on disk is plain text, and a hand-edited or foreign file can hold anything.
 * `adapterFor` is for ids the compiler has already vouched for; this one answers
 * `undefined` instead of handing out a dereference of nothing.
 */
export function maybeAdapterFor(source: string): ProviderAdapter | undefined {
  // Via the id list, not a plain lookup: `BY_ID` is an object literal, so `'toString'` would
  // otherwise come back as a function that is not an adapter at all.
  return isKnownSource(source) ? BY_ID[source] : undefined
}

/** The provider ids, in registry order. */
export const SOURCES: Source[] = ADAPTERS.map((a) => a.id)

/** Whether a string names a provider this build knows. The guard for data read off disk. */
export function isKnownSource(v: unknown): v is Source {
  return typeof v === 'string' && SOURCES.includes(v as Source)
}

/** One field of every adapter as the `Record<Source, …>` table the views expect. */
export function tableOf<T>(pick: (a: ProviderAdapter) => T): Record<Source, T> {
  const out = {} as Record<Source, T>
  for (const a of ADAPTERS) out[a.id] = pick(a)
  return out
}

export const SOURCE_TITLE: Record<Source, string> = tableOf((a) => a.title)
export const PROVIDER_NAME: Record<Source, string> = tableOf((a) => a.name)
export const LABEL: Record<Source, string> = tableOf((a) => a.shortLabel)
export const USAGE_PAGE: Record<Source, string> = tableOf((a) => a.usagePageUrl)
