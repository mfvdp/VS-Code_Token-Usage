// SPDX-FileCopyrightText: 2026 Frederik Marx
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Installer and uninstaller for the status-line bridge.
 *
 * This is the single riskiest thing the extension can do: it edits a file that
 * belongs to another program, and a botched edit costs the user their status
 * line. The rules are therefore narrow and all of them are testable pure
 * functions, with only the dialogs and the command registration in vscode glue:
 *
 *  • A settings.json that does not parse is never written to. Not repaired, not
 *    reformatted, not touched.
 *  • An existing status-line command is preserved by chaining, byte for byte —
 *    it is passed to the bridge script as one shell-quoted argument, so no
 *    second shell ever re-tokenises it — and recorded verbatim so that
 *    "disconnect" restores exactly it.
 *  • A settings.json that is a symlink (dotfiles) is written through, never
 *    replaced; a link we cannot resolve is refused with an explanation.
 *  • The previous value is restored only while the installed command is still
 *    the one we wrote; if something else has taken the slot since, we refuse
 *    rather than overwrite a third party's configuration.
 *  • `settings.local.json` and managed settings can shadow the whole thing —
 *    that is reported as a state, not silently ignored.
 */

import { execFile } from 'child_process'
import * as fs from 'fs'
import * as path from 'path'
import { WriteConsent } from './consent'
import { MementoLike } from './storage'

/** Memento key of the install record. Never deleted by "Clear Stored Data": it is the undo. */
export const BRIDGE_KEY = 'tokenPace.bridge'

/** Standalone: nothing was there. Preserve: chain the old command. Replace: drop it (backed up). */
export type BridgeMode = 'preserve' | 'replace' | 'standalone'

export type ShadowState = 'configuration-shadowed' | 'none'

export type SettingsRead =
  | { kind: 'ok'; settings: Record<string, unknown>; raw: string }
  | { kind: 'missing' }
  | { kind: 'unparsable'; error: string }

export interface BridgeRecord {
  /** The exact previous `statusLine` value, or undefined when there was none. */
  previous: unknown
  installedCommand: string
  at: number
}

export interface BridgePaths {
  /** Claude Code's settings file, usually ~/.claude/settings.json. */
  settingsFile: string
  /** Directory that file lives in — where settings.local.json would shadow it. */
  claudeDir: string
  /** Absolute path of dist/statusline-bridge.js. */
  script: string
  /** Absolute path of the mirror file inside globalStorage. */
  mirror: string
}

export interface PlanOptions {
  node: string
  script: string
  mirror: string
  mode: BridgeMode
  /** Which shell will run the installed command; injectable for tests. */
  platform?: string
}

export interface InstallPlan {
  newSettings: Record<string, unknown>
  previous: unknown
  command: string
  /** The slot already points at our script — nothing to do. */
  noop: boolean
}

/**
 * Reads Claude Code's settings.
 *
 * The raw text is kept because the backup must be a copy of the original bytes,
 * not of our re-serialisation: comments, key order and indentation are the
 * user's, and a backup that differs from the original is not a backup.
 */
export function readSettings(file: string): SettingsRead {
  let raw: string
  try {
    raw = fs.readFileSync(file, 'utf8')
  } catch {
    return { kind: 'missing' }
  }
  if (raw.trim().length === 0) return { kind: 'ok', settings: {}, raw }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (e) {
    return { kind: 'unparsable', error: (e as Error).message }
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { kind: 'unparsable', error: 'settings.json does not contain a JSON object' }
  }
  return { kind: 'ok', settings: parsed as Record<string, unknown>, raw }
}

/**
 * Quotes one argument so that the shell which runs `statusLine.command` hands it
 * to the bridge script as a single, unaltered string.
 *
 * The previous status-line command must survive a round trip through a shell it
 * never asked for. Appending it raw would let that shell tokenise it, and the
 * script would then only see the pieces: `--style "compact box"` would arrive as
 * two arguments and a `;` that was safely inside quotes would become live syntax
 * in the second shell. So it travels as exactly one quoted argument.
 */
export function shellQuote(value: string, platform: string = process.platform): string {
  if (platform === 'win32') {
    // cmd.exe: a doubled quote is a literal quote inside a quoted string, and
    // the metacharacters keep their caret escape so no redirection or pipe of
    // the user's command can leak into the command line we write.
    const escaped = value.replace(/"/g, '""').replace(/[\^&|<>]/g, (c) => `^${c}`)
    return `"${escaped}"`
  }
  // POSIX: single quotes protect everything but a single quote itself, which is
  // spliced in as '\'' — close, escaped quote, reopen.
  return `'${value.split("'").join("'\\''")}'`
}

/** The command string Claude Code will run on every status-line refresh. */
export function bridgeCommand(
  node: string,
  script: string,
  mirror: string,
  previous?: string | null,
  platform: string = process.platform,
): string {
  const base = `"${node}" "${script}" "${mirror}"`
  return previous !== undefined && previous !== null && previous.length > 0
    ? `${base} -- ${shellQuote(previous, platform)}`
    : base
}

/** The command of a `{ type: 'command', command: string }` entry, or null. */
export function statusLineCommandOf(value: unknown): string | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const v = value as Record<string, unknown>
  if (v.type !== 'command') return null
  return typeof v.command === 'string' ? v.command : null
}

/**
 * What the install would change. Pure, so the caller can show it before writing.
 *
 * Extra keys of an existing entry (`padding`, for instance) are carried over:
 * they are display preferences for the slot, not for the command we replace.
 */
export function planInstall(settings: Record<string, unknown>, opts: PlanOptions): InstallPlan {
  const previous = settings.statusLine
  const previousCommand = statusLineCommandOf(previous)

  if (previousCommand !== null && previousCommand.includes(opts.script)) {
    return { newSettings: settings, previous, command: previousCommand, noop: true }
  }

  // Only a plain command entry can be chained; anything else (a future entry
  // type, a bare string) is kept as the recorded previous value but not run.
  const chain = opts.mode === 'preserve' ? previousCommand : null
  const command = bridgeCommand(opts.node, opts.script, opts.mirror, chain, opts.platform ?? process.platform)

  const carried: Record<string, unknown> = {}
  if (typeof previous === 'object' && previous !== null && !Array.isArray(previous)) {
    for (const [k, v] of Object.entries(previous as Record<string, unknown>)) {
      if (k !== 'type' && k !== 'command') carried[k] = v
    }
  }

  return {
    newSettings: { ...settings, statusLine: { type: 'command', command, ...carried } },
    previous,
    command,
    noop: false,
  }
}

/** File name of the backup: `settings.json.token-pace-backup-<timestamp>`. */
export function backupNameFor(settingsFile: string, at: number): string {
  // Colons are illegal in Windows file names, so the ISO stamp is flattened.
  const stamp = new Date(at).toISOString().replace(/[:.]/g, '-')
  return `${settingsFile}.token-pace-backup-${stamp}`
}

/**
 * The path a write must actually land on.
 *
 * `~/.claude/settings.json` is often a symlink into a dotfiles repository
 * (stow, chezmoi). tmp + rename onto the link would silently replace the link
 * with a regular file: the user's dotfiles would keep their bytes but stop
 * reaching Claude Code, and disconnecting would not put the link back either.
 * So the real path is resolved first and both the backup and the new content go
 * there. A link whose target cannot be resolved is not written at all — where
 * it should point is a guess we are not entitled to make.
 */
export function resolveWriteTarget(file: string): { ok: true; file: string } | { ok: false; message: string } {
  try {
    fs.lstatSync(file)
  } catch {
    // Nothing there yet: the write creates the file exactly where we were told.
    return { ok: true, file }
  }
  try {
    return { ok: true, file: fs.realpathSync(file) }
  } catch (e) {
    return {
      ok: false,
      message: `${file} could not be resolved (${(e as Error).message}). It looks like a link whose `
        + 'target is missing, so it was left untouched — repair the link and try again.',
    }
  }
}

/**
 * tmp + rename, on the resolved path only: the caller passes what
 * `resolveWriteTarget` returned, so the temp file is a sibling of the real file
 * and the rename stays atomic on the same filesystem.
 */
function writeJsonAtomic(file: string, value: unknown): void {
  const tmp = `${file}.token-pace.tmp`
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  fs.renameSync(tmp, file)
}

/** Managed-settings locations that outrank the user's own file on each platform. */
export function managedSettingsPaths(
  platform: string = process.platform,
  env: Record<string, string | undefined> = process.env,
): string[] {
  if (platform === 'win32') {
    return [path.join(env.ProgramData ?? 'C:\\ProgramData', 'ClaudeCode', 'managed-settings.json')]
  }
  if (platform === 'darwin') return ['/Library/Application Support/ClaudeCode/managed-settings.json']
  return ['/etc/claude-code/managed-settings.json']
}

function hasStatusLine(file: string): boolean {
  const read = readSettings(file)
  return read.kind === 'ok' && read.settings.statusLine !== undefined
}

/**
 * Whether another settings file would win over the one we write.
 *
 * Claude Code merges `settings.local.json` and managed settings over the user
 * settings, so an install can be technically successful and have no effect at
 * all. Saying "installed" in that case would be a lie the user cannot check.
 */
export function detectShadowing(
  dir: string,
  managed: string[] = managedSettingsPaths(),
): ShadowState {
  const files = [path.join(dir, 'settings.local.json'), ...managed]
  for (const file of files) if (hasStatusLine(file)) return 'configuration-shadowed'
  return 'none'
}

/** The files that do the shadowing — for the message that explains the state. */
export function shadowingSources(dir: string, managed: string[] = managedSettingsPaths()): string[] {
  return [path.join(dir, 'settings.local.json'), ...managed].filter(hasStatusLine)
}

/** Looks up `node` on PATH. execFile, never a shell: the result is run later. */
export function resolveNode(platform: string = process.platform): Promise<string | null> {
  return new Promise((resolve) => {
    const finder = platform === 'win32' ? 'where' : 'which'
    try {
      execFile(finder, ['node'], { timeout: 5_000, windowsHide: true }, (err, stdout) => {
        if (err) {
          resolve(null)
          return
        }
        const first = String(stdout).split(/\r?\n/).map((s) => s.trim()).find((s) => s.length > 0)
        resolve(first ?? null)
      })
    } catch {
      resolve(null)
    }
  })
}

export type InstallResult =
  | {
    ok: true
    status: 'installed' | 'already'
    command: string
    backup: string | null
    shadowed: ShadowState
  }
  | {
    ok: false
    reason: 'restricted' | 'unparsable' | 'consent' | 'noNode' | 'writeFailed'
    message: string
  }

export interface InstallOptions {
  mode: BridgeMode
  /** Untrusted workspace: the whole feature is off, before anything is asked. */
  restricted: boolean
  memento: MementoLike
  now?: number
  /** Injectable for tests; production resolves `node` on PATH. */
  resolveNode?: () => Promise<string | null>
  log?: (msg: string) => void
}

/**
 * Installs the bridge. The order is deliberate: refuse first, ask second, write
 * last, and never ask a question whose answer we would then have to decline.
 */
export async function install(
  paths: BridgePaths,
  opts: InstallOptions,
  consent: () => Promise<boolean>,
): Promise<InstallResult> {
  const log = opts.log ?? (() => {})
  const now = opts.now ?? Date.now()

  if (opts.restricted) {
    return {
      ok: false,
      reason: 'restricted',
      message: 'The status line bridge is disabled in Restricted Mode. Trust the workspace to use it.',
    }
  }

  const read = readSettings(paths.settingsFile)
  if (read.kind === 'unparsable') {
    return {
      ok: false,
      reason: 'unparsable',
      message: `${paths.settingsFile} is not valid JSON (${read.error}). It was left untouched — fix it and try again.`,
    }
  }
  const settings = read.kind === 'ok' ? read.settings : {}

  const target = resolveWriteTarget(paths.settingsFile)
  if (!target.ok) return { ok: false, reason: 'writeFailed', message: target.message }

  if (!(await consent())) {
    return { ok: false, reason: 'consent', message: 'The status line bridge needs your explicit consent.' }
  }

  const node = await (opts.resolveNode ?? (() => resolveNode()))()
  if (node === null || node.length === 0) {
    return {
      ok: false,
      reason: 'noNode',
      message: 'No "node" executable was found on PATH. Claude Code would have to run the bridge '
        + 'script itself, so install Node.js (or add it to PATH) and try again.',
    }
  }

  const plan = planInstall(settings, { node, script: paths.script, mirror: paths.mirror, mode: opts.mode })
  const shadowed = detectShadowing(paths.claudeDir)
  if (plan.noop) {
    log('Status line bridge: already installed, settings unchanged.')
    return { ok: true, status: 'already', command: plan.command, backup: null, shadowed }
  }

  let backup: string | null = null
  try {
    if (read.kind === 'ok') {
      backup = backupNameFor(target.file, now)
      fs.writeFileSync(backup, read.raw, 'utf8')
    }
    writeJsonAtomic(target.file, plan.newSettings)
  } catch (e) {
    return { ok: false, reason: 'writeFailed', message: `Could not write ${paths.settingsFile}: ${(e as Error).message}` }
  }

  try {
    const record: BridgeRecord = { previous: plan.previous, installedCommand: plan.command, at: now }
    await opts.memento.update(BRIDGE_KEY, record)
  } catch (e) {
    // Without the record there is no exact undo, so the edit is rolled back
    // rather than left in place with no way home.
    try {
      if (backup !== null) fs.copyFileSync(backup, target.file)
    } catch { /* the backup itself is the fallback the message names */ }
    return {
      ok: false,
      reason: 'writeFailed',
      message: `The install could not be recorded (${(e as Error).message}); settings.json was restored`
        + `${backup !== null ? ` from ${backup}` : ''}.`,
    }
  }

  log(`Status line bridge installed (${opts.mode}); backup: ${backup ?? 'none needed'}.`)
  return { ok: true, status: 'installed', command: plan.command, backup, shadowed }
}

export type RestoreResult =
  | { ok: true; restored: 'previous' | 'removed' }
  | { ok: false; reason: 'notInstalled' | 'unparsable' | 'changed' | 'writeFailed'; message: string }

/**
 * Puts back exactly what was there before, from the recorded value rather than
 * from the backup file: the backup is a whole file and may be older than other
 * edits the user made since.
 */
export async function restore(paths: BridgePaths, memento: MementoLike): Promise<RestoreResult> {
  const record = memento.get<BridgeRecord | undefined>(BRIDGE_KEY, undefined)
  if (!record || typeof record.installedCommand !== 'string') {
    return { ok: false, reason: 'notInstalled', message: 'Token Pace has not installed a status line.' }
  }

  const read = readSettings(paths.settingsFile)
  if (read.kind === 'unparsable') {
    return {
      ok: false,
      reason: 'unparsable',
      message: `${paths.settingsFile} is not valid JSON. It was left untouched.`,
    }
  }
  if (read.kind === 'missing') {
    await memento.update(BRIDGE_KEY, undefined)
    return { ok: true, restored: 'removed' }
  }

  const current = statusLineCommandOf(read.settings.statusLine)
  if (current !== record.installedCommand) {
    return {
      ok: false,
      reason: 'changed',
      message: 'The status line is no longer the one Token Pace installed, so nothing was changed. '
        + 'Edit settings.json yourself, or restore the backup written at install time.',
    }
  }

  const next: Record<string, unknown> = { ...read.settings }
  if (record.previous === undefined) delete next.statusLine
  else next.statusLine = record.previous

  const target = resolveWriteTarget(paths.settingsFile)
  if (!target.ok) return { ok: false, reason: 'writeFailed', message: target.message }

  try {
    writeJsonAtomic(target.file, next)
  } catch (e) {
    return { ok: false, reason: 'writeFailed', message: `Could not write ${paths.settingsFile}: ${(e as Error).message}` }
  }
  await memento.update(BRIDGE_KEY, undefined)
  return { ok: true, restored: record.previous === undefined ? 'removed' : 'previous' }
}

export interface BridgeState {
  installed: boolean
  shadowed: boolean
  /** Age of the mirror file, or null when there is none. */
  mirrorAgeMs: number | null
}

/** What the dashboard and the diagnostics report show about the bridge. */
export function state(paths: BridgePaths, memento: MementoLike, now: number = Date.now()): BridgeState {
  const record = memento.get<BridgeRecord | undefined>(BRIDGE_KEY, undefined)
  const read = readSettings(paths.settingsFile)
  const current = read.kind === 'ok' ? statusLineCommandOf(read.settings.statusLine) : null
  const installed = record !== undefined && typeof record.installedCommand === 'string'
    && current === record.installedCommand

  let mirrorAgeMs: number | null = null
  try {
    mirrorAgeMs = Math.max(0, now - fs.statSync(paths.mirror).mtimeMs)
  } catch {
    mirrorAgeMs = null
  }

  return { installed, shadowed: detectShadowing(paths.claudeDir) === 'configuration-shadowed', mirrorAgeMs }
}

// ---------------------------------------------------------------------------
// vscode glue
// ---------------------------------------------------------------------------

export interface BridgeDeps {
  memento: MementoLike
  paths: BridgePaths
  /** Read at call time: the workspace can become trusted while we run. */
  restricted: () => boolean
  log: (msg: string) => void
  /** Called after a successful install or restore so the views can refresh. */
  onChange?: () => void
}

export interface DisposableLike {
  dispose(): void
}

export interface ExtensionContextLike {
  subscriptions: DisposableLike[]
}

/**
 * Registers `tokenPace.connectStatusLine` and `tokenPace.disconnectStatusLine`.
 *
 * The mode question is only asked when there is something to preserve; with an
 * empty slot there is no decision to make and no dialog to show.
 */
export function registerBridgeCommands(context: ExtensionContextLike, deps: BridgeDeps): void {
  const vscode = require('vscode') as typeof import('vscode')
  const consent = new WriteConsent(deps.memento, 'statusLine', deps.log, {
    paths: { settingsFile: deps.paths.settingsFile, mirrorFile: deps.paths.mirror },
  })

  const connect = vscode.commands.registerCommand('tokenPace.connectStatusLine', async () => {
    if (deps.restricted()) {
      void vscode.window.showWarningMessage(
        'Token Pace: the status line bridge is disabled in Restricted Mode.',
      )
      return
    }
    const read = readSettings(deps.paths.settingsFile)
    if (read.kind === 'unparsable') {
      void vscode.window.showWarningMessage(
        `Token Pace: ${deps.paths.settingsFile} is not valid JSON, so it was left untouched.`,
      )
      return
    }

    let mode: BridgeMode = 'standalone'
    const previous = read.kind === 'ok' ? statusLineCommandOf(read.settings.statusLine) : null
    if (previous !== null) {
      const keep = 'Keep it and chain Token Pace'
      const replace = 'Replace it (a backup is written)'
      const choice = await vscode.window.showQuickPick([keep, replace], {
        title: 'A status line command is already configured',
        placeHolder: previous.length > 80 ? `${previous.slice(0, 80)}…` : previous,
      })
      if (choice === undefined) return
      mode = choice === keep ? 'preserve' : 'replace'
    }

    const result = await install(deps.paths, {
      mode,
      restricted: deps.restricted(),
      memento: deps.memento,
      log: deps.log,
    }, () => consent.request())

    if (!result.ok) {
      if (result.reason !== 'consent') void vscode.window.showWarningMessage(`Token Pace: ${result.message}`)
      return
    }
    deps.onChange?.()
    const shadow = result.shadowed === 'configuration-shadowed'
      ? ' Another settings file also defines a status line and takes precedence (configuration-shadowed).'
      : ''
    void vscode.window.showInformationMessage(
      result.status === 'already'
        ? `Token Pace: the status line is already connected.${shadow}`
        : `Token Pace: status line connected. Backup: ${result.backup ?? 'none needed'}.${shadow}`,
    )
  })

  const disconnect = vscode.commands.registerCommand('tokenPace.disconnectStatusLine', async () => {
    const result = await restore(deps.paths, deps.memento)
    if (!result.ok) {
      void vscode.window.showWarningMessage(`Token Pace: ${result.message}`)
      return
    }
    deps.onChange?.()
    void vscode.window.showInformationMessage(
      result.restored === 'previous'
        ? 'Token Pace: the previous status line was restored.'
        : 'Token Pace: the status line entry was removed.',
    )
  })

  context.subscriptions.push(connect, disconnect)
}
