// SPDX-FileCopyrightText: 2026 Frederik Marx
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * What the extension has put on disk, and how to get rid of it.
 *
 * A tool whose whole argument is data thrift has to be able to say what it
 * stores and let the user delete it — otherwise the promise is unverifiable.
 * The module is deliberately dumb: it knows file names and memento keys, not
 * what is inside them, so a new persisted file is one line here and cannot be
 * forgotten by the delete command.
 *
 * `paths.leader` is accepted but never offered for deletion: the lease is live
 * coordination between open windows, not stored user data, and removing it
 * while another window holds it would give two windows the leader role at once.
 */

import * as fs from 'fs'
import * as path from 'path'

/**
 * The slice of `vscode.Memento` this code needs.
 *
 * Declaring it structurally keeps every module that persists small values
 * loadable in a plain Node test, which is the whole reason the logic is not in
 * the vscode glue.
 */
export interface MementoLike {
  get<T>(key: string, defaultValue: T): T
  update(key: string, value: unknown): PromiseLike<void>
}

export type StoredKey =
  'state' | 'quota' | 'history' | 'consent' | 'alerts' | 'ui' | 'mirror' | 'externalQuota'

/** Absolute paths of the extension's files in `globalStorage`. */
export interface StoredPaths {
  state: string
  quota: string
  history: string
  leader: string
  mirror: string
  /**
   * The shared quota cache files outside `globalStorage`, one per provider.
   *
   * Only set by the caller when the `writeQuotaCache` opt-in was granted at some
   * point: a file we were never allowed to write is not ours to offer for
   * deletion, however plausible its path looks.
   */
  externalQuota?: string[]
}

export interface StoredItem {
  key: StoredKey
  /** Human label for the pick list, e.g. "Token snapshot (state.json)". */
  label: string
  bytes: number
  /** One line of context supplied by the caller (oldest day, sample count …). */
  detail: string | null
  present: boolean
}

/** Memento keys per item. Everything the user can delete is listed here, once. */
export const STORED_MEMENTO_KEYS: Readonly<Record<'consent' | 'alerts' | 'ui', readonly string[]>> = {
  consent: ['networkConsent', 'networkConsentOffered', 'writeConsent.writeQuotaCache', 'writeConsent.statusLine'],
  alerts: ['tokenPace.alerts'],
  ui: ['tokenPace.ui'],
}

const LABELS: Record<StoredKey, string> = {
  state: 'Token snapshot (state.json)',
  quota: 'Quota cache (quota.json)',
  history: 'Quota history (quotaHistory.json)',
  mirror: 'Status line mirror (statusline-mirror.json)',
  externalQuota: 'Shared quota cache (outside the extension storage)',
  consent: 'Consent decisions',
  alerts: 'Alert state',
  ui: 'Dashboard view state',
}

/**
 * The files behind a key, or null for the memento-backed items.
 *
 * A list rather than one path, because the shared quota cache is one file per
 * provider and both of them belong to the same decision.
 */
export function storedFiles(key: StoredKey, paths: StoredPaths): string[] | null {
  switch (key) {
    case 'state': return [paths.state]
    case 'quota': return [paths.quota]
    case 'history': return [paths.history]
    case 'mirror': return [paths.mirror]
    case 'externalQuota': {
      const files = (paths.externalQuota ?? []).filter((f) => typeof f === 'string' && f !== '')
      return files.length > 0 ? files : null
    }
    default: return null
  }
}

/** The single file behind a key — the shape the older callers and tests use. */
export function storedFile(key: StoredKey, paths: StoredPaths): string | null {
  const files = storedFiles(key, paths)
  return files !== null && files.length === 1 ? files[0] : null
}

function sizeOf(files: string[]): { bytes: number; present: boolean } {
  let bytes = 0
  let present = false
  for (const file of files) {
    try {
      const st = fs.statSync(file)
      if (!st.isFile()) continue
      bytes += st.size
      present = true
    } catch {
      // A file that is not there contributes nothing and is not an error.
    }
  }
  return { bytes, present }
}

/** Serialised size of the memento values, so the dialog can name a number too. */
function mementoSize(keys: readonly string[], memento: MementoLike): { bytes: number; present: boolean } {
  let bytes = 0
  let present = false
  for (const key of keys) {
    const value = memento.get<unknown>(key, undefined)
    if (value === undefined) continue
    present = true
    try {
      bytes += Buffer.byteLength(JSON.stringify(value) ?? '', 'utf8')
    } catch {
      // A value that cannot be serialised still exists; its size is simply unknown.
    }
  }
  return { bytes, present }
}

/**
 * Everything the extension stores, in the order the delete dialog shows it.
 *
 * `details` comes from the caller because only it knows the oldest day of the
 * snapshot or how many quota samples are in the history file; this module must
 * not parse those files just to describe them.
 */
export function inventory(
  paths: StoredPaths,
  memento: MementoLike,
  details: Partial<Record<StoredKey, string>> = {},
): StoredItem[] {
  const order: StoredKey[] = ['state', 'quota', 'history', 'mirror', 'externalQuota', 'consent', 'alerts', 'ui']
  const out: StoredItem[] = []
  for (const key of order) {
    const files = storedFiles(key, paths)
    // The shared cache is the one item that can be absent from the list entirely:
    // without the opt-in there is no file of ours outside `globalStorage`.
    if (files === null && key === 'externalQuota') continue
    const size = files !== null
      ? sizeOf(files)
      : mementoSize(STORED_MEMENTO_KEYS[key as 'consent' | 'alerts' | 'ui'], memento)
    out.push({ key, label: LABELS[key], bytes: size.bytes, detail: details[key] ?? null, present: size.present })
  }
  return out
}

function unlinkIfPresent(file: string): void {
  try {
    fs.unlinkSync(file)
  } catch (e) {
    // Already gone is the outcome we wanted; anything else is a real failure.
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e
  }
}

/**
 * Whether `name` is a temp file of `base` left over from an interrupted write.
 *
 * Every writer picks its own temp name — `state.json.tmp`,
 * `statusline-mirror.json.4821.tmp`, `quotaHistory.json.tmp-4821-9f0c` — so the
 * shapes are matched instead of a single literal. Only siblings of the file we
 * are deleting are touched, never an unrelated `.tmp` in the directory.
 */
export function isTempSiblingOf(name: string, base: string): boolean {
  if (!name.startsWith(`${base}.`)) return false
  const suffix = name.slice(base.length + 1)
  return suffix.endsWith('.tmp') || suffix === 'tmp' || suffix.startsWith('tmp-') || suffix.includes('.tmp-')
}

/**
 * Removes the file and every temp sibling of it. A temp file of the status line
 * mirror holds the complete Claude Code status payload, so leaving one behind
 * after "Clear Stored Data" would keep exactly the data the user asked us to
 * drop.
 */
function unlinkWithTemps(file: string): void {
  unlinkIfPresent(file)
  const dir = path.dirname(file)
  const base = path.basename(file)
  let entries: string[]
  try {
    entries = fs.readdirSync(dir)
  } catch (e) {
    // No directory means no temp files either.
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return
    throw e
  }
  for (const name of entries) if (isTempSiblingOf(name, base)) unlinkIfPresent(path.join(dir, name))
}

/**
 * Deletes the selected items. Files lose their temp siblings too — an atomic
 * write that was interrupted leaves one behind, and a "deleted" file that comes
 * back from a stale temp file would be the worst kind of surprise.
 *
 * Returns the keys, not the paths: the caller reports in the same terms it
 * asked in. A missing file counts as deleted.
 */
export async function deleteItems(
  keys: StoredKey[],
  paths: StoredPaths,
  memento: MementoLike,
  log?: (msg: string) => void,
): Promise<{ deleted: StoredKey[]; failed: StoredKey[] }> {
  const deleted: StoredKey[] = []
  const failed: StoredKey[] = []
  for (const key of keys) {
    try {
      const files = storedFiles(key, paths)
      if (files !== null) {
        for (const file of files) unlinkWithTemps(file)
      } else {
        for (const k of STORED_MEMENTO_KEYS[key as 'consent' | 'alerts' | 'ui']) {
          await memento.update(k, undefined)
        }
      }
      deleted.push(key)
      log?.(`Stored data removed: ${LABELS[key]}`)
    } catch (e) {
      failed.push(key)
      log?.(`Stored data could not be removed: ${LABELS[key]} — ${(e as Error).message}`)
    }
  }
  return { deleted, failed }
}

/**
 * The sentence the confirmation dialog must show for the token snapshot.
 *
 * "It is rebuilt from the transcripts" is only half true, and the other half is
 * the part that matters: Claude Code deletes its own transcripts after 30 days,
 * so everything older than that is gone for good.
 */
export const DELETE_WARNING = 'The token snapshot is rebuilt from the transcript files that are '
  + 'still on disk. Claude Code deletes those after 30 days, so any usage history older than that '
  + 'is lost for good.'

/**
 * The extra sentence for the shared cache: it is the one file outside our own
 * storage, and other tools read it — deleting it takes their figures away too.
 */
export const DELETE_WARNING_EXTERNAL = 'The shared quota cache lies outside the extension storage '
  + 'and other tools may read it. Deleting it removes their last known figures as well; it is '
  + 'written again on the next quota poll while the opt-in is on.'

/**
 * The line the delete list shows while Claude Code\'s status line is ours.
 *
 * Deleting the mirror file does not undo the settings.json entry, and a user who
 * believed otherwise would be left with a status line pointing at a script whose
 * data we just removed.
 */
export const BRIDGE_BLOCKS_DELETE = 'Run "Token Pace: Disconnect Claude Status Line" first — '
  + 'clearing files here does not restore Claude Code\'s settings.json.'

/** "12.3 kB" / "482 B" — for the pick list, where an exact byte count helps nobody. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '–'
  if (bytes < 1000) return `${Math.round(bytes)} B`
  if (bytes < 1000 * 1000) return `${(bytes / 1000).toFixed(1)} kB`
  return `${(bytes / 1000 / 1000).toFixed(1)} MB`
}
