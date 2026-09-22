// SPDX-FileCopyrightText: 2026 Frederik Marx
// SPDX-License-Identifier: AGPL-3.0-or-later

import * as fs from 'fs'
import { ADAPTERS, adapterFor } from './adapters'
import { AGENT_RETENTION_DAYS, SESSION_ACTIVE_MS } from './agentTree'
import { Aggregator, IngestContext, parseAgentMeta } from './agg'
import { agentTranscriptsOf, findTranscripts, rootOf, rootsFor } from './discover'
import { newCursor, readNewLines } from './tail'
import { AgentMeta, Attribution, Cursor, Source } from './types'

export interface ScanProgress { done: number; total: number; file: string }

/** The attribution settings a scan applies to every file it reads. */
export interface ScanContext {
  attribution: Attribution
  projectSalt: string
  hashProjects: boolean
}

export interface ScanOptions {
  onProgress?: (p: ScanProgress) => void
  /** Only these files (watcher events); otherwise every transcript below every root. */
  files?: string[]
  /** Absent means no session records — the safe default for a caller that did not ask. */
  ctx?: ScanContext
}

const NO_ATTRIBUTION: ScanContext = { attribution: 'none', projectSalt: '', hashProjects: true }

/**
 * Reads all new lines from every provider. Used for the cold start (in the worker)
 * as well as for incremental updates — so the logic exists only once, and a provider
 * contributes its roots, its file names and its line parser through its adapter.
 *
 * Returns how many lines changed the state — counted tokens or an agent's record — plus
 * the agent sidecars that gave a record its identity.
 */
export async function scan(agg: Aggregator, opts: ScanOptions = {}): Promise<number> {
  const scanCtx = opts.ctx ?? NO_ATTRIBUTION
  const all: Array<{ file: string; source: Source }> = []
  if (opts.files) {
    for (const file of opts.files) {
      const r = rootOf(file)
      if (r) all.push({ file, source: r.source })
    }
  } else {
    for (const a of ADAPTERS) {
      for (const root of rootsFor(a.id)) {
        for (const file of await findTranscripts(root, a.matches)) all.push({ file, source: a.id })
      }
    }
  }

  let counted = 0
  let done = 0

  for (const { file, source } of all) {
    const adapter = adapterFor(source)
    let known = agg.cursors.get(file)
    if (!known) { known = newCursor(); agg.cursors.set(file, known) }
    // A `const` so the callbacks below close over a cursor the compiler knows is present.
    const cur = known
    const ctx: IngestContext = { ...scanCtx, file, isSub: adapter.isSub(file) }

    await readNewLines(
      file, cur,
      (line) => { if (adapter.ingest(line, cur, ctx, agg)) counted++ },
      undefined,
      () => adapter.resetCursor(cur),
    )
    // After the lines: an agent's record is made by its first counted line, and only a
    // record asks for its sidecar.
    counted += await readSidecar(agg, file, ctx)
    opts.onProgress?.({ done: ++done, total: all.length, file })
  }
  return counted
}

/** A sidecar larger than this is no agent's identity any more; it is read as absent. */
export const AGENT_META_MAX_BYTES = 64 * 1024

/** Opening without following a link, where the platform can refuse one (not on Windows). */
const NO_FOLLOW = fs.constants.O_NOFOLLOW ?? 0

/**
 * The identity sidecar of an agent transcript: `agent-<id>.meta.json` beside
 * `agent-<id>.jsonl`. At most 64 KB — a larger one is treated as absent — and never through a
 * link: the walk never follows one out of the transcript directory, and a sidecar may not
 * either. Four fields go through their sanitisers (`parseAgentMeta`); nothing else of the
 * file is kept — it also holds the agent's description and prompt — and no value is logged.
 * Null when there is no such file or nothing usable in it.
 */
export async function readAgentMeta(file: string): Promise<AgentMeta | null> {
  if (!file.endsWith('.jsonl')) return null
  const sidecar = `${file.slice(0, -'.jsonl'.length)}.meta.json`
  let fh: fs.promises.FileHandle
  try {
    const entry = await fs.promises.lstat(sidecar)
    if (!entry.isFile() || entry.size > AGENT_META_MAX_BYTES) return null
    fh = await fs.promises.open(sidecar, fs.constants.O_RDONLY | NO_FOLLOW)
  } catch {
    return null
  }
  try {
    // Asked again of the handle that is read: the file can have changed since the check.
    const st = await fh.stat()
    if (!st.isFile() || st.size === 0 || st.size > AGENT_META_MAX_BYTES) return null
    const buf = Buffer.alloc(st.size)
    const { bytesRead } = await fh.read(buf, 0, st.size, 0)
    return parseAgentMeta(buf.toString('utf8', 0, bytesRead))
  } catch {
    return null
  } finally {
    await fh.close()
  }
}

/** Reads the sidecar an agent's record still waits for; 1 when it gave the record an identity. */
async function readSidecar(agg: Aggregator, file: string, ctx: IngestContext): Promise<number> {
  if (!ctx.isSub || !agg.needsAgentMeta(file)) return 0
  const meta = await readAgentMeta(file)
  agg.setAgentMeta(file, meta)
  return meta ? 1 : 0
}

/**
 * Rebuilds the agent tables — agents, launches, main sessions, journal results — from
 * transcripts whose tokens were counted before those tables existed (a version 6 snapshot).
 * Each file is read from the start with a throwaway cursor and `agentsOnly` set, so no
 * bucket, open message, session, tool row or cursor is touched: the counting stays exactly
 * what it was, and `agg.cursors` is only ever read.
 *
 * Only what the counting side has already read is replayed. A line behind a file's cursor was
 * counted; a line beyond it belongs to the next scan, which gives the agent tables their
 * share itself — reading it here as well would count it twice. So each file is read up to
 * its cursor's offset, and a file without a cursor, or no longer the file its cursor measured,
 * is left to the scan. What the files gave the agent tables before is taken out first
 * (`beginAgentReplay`), so a second replay rebuilds the same tables instead of doubling them.
 *
 * Must not overlap a scan that feeds lines — the host runs it between scans, as it runs the
 * roll-up. Returns how many lines and sidecars changed an agent table: a count, never a line.
 */
export async function replayAgents(
  agg: Aggregator, files: readonly string[], ctx: ScanContext = NO_ATTRIBUTION,
): Promise<number> {
  const adapter = adapterFor('claude')
  // In path order, as a cold scan meets them: a session's main transcript before its agents,
  // a workflow's agent transcripts before its journal.
  const limits = new Map<string, number>()
  for (const file of [...new Set(files)].sort()) {
    if (rootOf(file)?.source !== 'claude') continue
    const cur = agg.cursors.get(file)
    if (!cur || !(cur.offset > 0)) continue
    let st: fs.Stats
    try { st = await fs.promises.stat(file) } catch { continue }
    if (st.ino !== cur.ino || st.dev !== cur.dev) continue
    limits.set(file, cur.offset)
  }
  agg.beginAgentReplay(limits.keys())
  let changed = 0
  try {
    for (const [file, limit] of limits) {
      const cur = newCursor()
      const replayCtx: IngestContext = { ...ctx, file, isSub: adapter.isSub(file), agentsOnly: true }
      await readNewLines(file, cur, (line) => { if (adapter.ingest(line, cur, replayCtx, agg)) changed++ }, limit)
      changed += await readSidecar(agg, file, replayCtx)
    }
  } finally {
    agg.endAgentReplay()
  }
  return changed
}

/**
 * The transcripts a replay has to read: every Claude file the cursors know that changed within
 * the agent retention. By modification time as well as by the last counted line, because a
 * workflow journal has no counted line — its cursor never records one.
 */
export function agentReplayFiles(agg: Aggregator, now: number): string[] {
  const horizon = now - AGENT_RETENTION_DAYS * 86_400_000
  const out: string[] = []
  for (const [file, cur] of agg.cursors) {
    if (rootOf(file)?.source !== 'claude') continue
    if (Math.max(cur.lastTs ?? 0, cur.mtime ?? 0) >= horizon) out.push(file)
  }
  return out.sort()
}

// ---------------------------------------------------------------------------
// The hot-directory poll (the host runs a pass every few seconds while agents work)
// ---------------------------------------------------------------------------

/**
 * The main transcripts of the Claude sessions that are active now: a session whose own record,
 * or one of whose agents' records, has a line within SESSION_ACTIVE_MS. The paths are the ones
 * the aggregator keys its main records by and the `sessionFile` its agent records name — never a
 * node key of the tree, which carries no path — and only those below a configured Claude root,
 * like every other file this module reads.
 */
export function activeAgentSessions(agg: Aggregator, now: number): string[] {
  const out = new Set<string>()
  for (const [file, main] of agg.mainEntries()) if (now - main.lastTs <= SESSION_ACTIVE_MS) out.add(file)
  for (const rec of agg.agents()) if (now - rec.lastTs <= SESSION_ACTIVE_MS) out.add(rec.sessionFile)
  return [...out].filter((file) => rootOf(file)?.source === 'claude').sort()
}

/**
 * The files whose size or modification time differ from what their cursor recorded, and the
 * ones no cursor knows yet — new files. One stat each: size and mtime are the two figures
 * `readNewLines` recognises an unchanged file by. A file gone by the time it is asked about is
 * left out; one replaced by a file of the same size and time is the sweep's to find.
 */
export async function changedSinceCursor(
  files: readonly string[], cursors: ReadonlyMap<string, Cursor>,
): Promise<string[]> {
  const out: string[] = []
  for (const file of files) {
    const cur = cursors.get(file)
    if (!cur) {
      out.push(file)
      continue
    }
    try {
      const st = await fs.promises.stat(file)
      if (st.size !== cur.size || st.mtimeMs !== cur.mtime) out.push(file)
    } catch {
      // Gone since it was listed: there is nothing to read.
    }
  }
  return out
}

/** What one pass of the hot-directory poll found: counts for the log, the files for the ingest. */
export interface AgentPollResult {
  /** Active sessions whose directories were listed. */
  sessions: number
  /** Agent transcripts and workflow journals found in them. */
  listed: number
  /** The ones the cursors have not seen in their present state. */
  changed: string[]
}

/**
 * One pass of the hot-directory poll: every agent transcript and workflow journal of every
 * active session (`agentTranscriptsOf` — two known levels, no walk, no link) that is new or
 * changed since its cursor last saw it. A recursive watcher on Linux misses the files of a
 * directory made after it started — a session's first agent, every agent of a new workflow run
 * — and the sweep would only find them within the minute. Lists and compares, reads nothing.
 */
export async function agentPollFiles(agg: Aggregator, now: number): Promise<AgentPollResult> {
  const sessions = activeAgentSessions(agg, now)
  const listed: string[] = []
  for (const session of sessions) listed.push(...await agentTranscriptsOf(session))
  return { sessions: sessions.length, listed: listed.length, changed: await changedSinceCursor(listed, agg.cursors) }
}
