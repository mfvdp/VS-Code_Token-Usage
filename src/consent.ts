// SPDX-FileCopyrightText: 2026 Frederik Marx
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The two questions the extension is allowed to ask, and the answers it keeps.
 *
 * Everything this tool does by default is local and read-only. The three
 * exceptions — one network call and two writes outside `globalStorage` — each
 * have their own dialog, their own memento key and their own revocation, so a
 * yes to one is never a yes to another.
 *
 * The dialogs state what happens in concrete terms (which address, which file,
 * which interval), because a consent dialog whose text is vaguer than the
 * action it unlocks is a formality, not a decision.
 */

import { MementoLike } from './storage'

const CONSENT_KEY = 'networkConsent'
const OFFERED_KEY = 'networkConsentOffered'

export type ConsentState = 'granted' | 'denied' | 'unasked'

/**
 * The one `vscode.window` method the dialogs need. Injectable so the classes
 * can be exercised without an editor; the real module is required lazily.
 */
export interface ConsentUi {
  showInformationMessage(
    message: string,
    options: { modal: boolean; detail?: string },
    ...items: string[]
  ): PromiseLike<string | undefined>
}

function windowUi(): ConsentUi {
  const vscode = require('vscode') as typeof import('vscode')
  return vscode.window
}

/** Default poll interval of the manifest — used when no live value is supplied. */
const DEFAULT_INTERVAL_MINUTES = 30

/**
 * The network disclosure, with the interval the user has actually configured.
 *
 * A fixed "every 30 minutes" in the text was a small lie as soon as the setting
 * moved, and the whole point of this dialog is that its numbers are true.
 */
export function disclosure(intervalMinutes: number): string {
  const minutes = Number.isFinite(intervalMinutes) && intervalMinutes > 0
    ? Math.round(intervalMinutes)
    : DEFAULT_INTERVAL_MINUTES
  const cadence = minutes >= 60 && minutes % 60 === 0
    ? `${minutes / 60} ${minutes === 60 ? 'hour' : 'hours'}`
    : `${minutes} minutes`
  return [
    'Token counts are read from local transcript files and need no network access. Quota percentages do.',
    '',
    `If you allow it, then at most every ${cadence} (tokenPace.pollIntervalMinutes):`,
    '',
    '• Claude — GET https://api.anthropic.com/api/oauth/usage, using the accessToken from',
    '  ~/.claude/.credentials.json. The request identifies itself as the Claude Code client,',
    '  because the endpoint rate-limits other callers into a permanent 429.',
    '• Codex — the local "codex app-server" is started and asked for its rate limits. No traffic',
    '  of ours leaves the machine for this.',
    '',
    'That endpoint is undocumented: it is what Claude Code itself calls, it carries no stability',
    'promise, and it may change or disappear at any time. Token Pace then shows no quota figures',
    'rather than guessing any.',
    '',
    'The token is only read, never refreshed, and appears in no log line or error message. The',
    'target address is hard-coded and cannot be configured. Nothing is sent anywhere else, and',
    'no usage data is collected by this extension.',
    '',
    'You can change this later with "Token Pace: Reset Network Access Decision".',
  ].join('\n')
}

/**
 * Gate in front of every network access the extension makes on its own.
 *
 * Quota percentages can only be fetched with Claude Code's access token, and
 * starting to do that unasked is not defensible however carefully it is
 * implemented. So the default touches no network at all, and the one question
 * that unlocks it states plainly what is sent where — including the fact that
 * the request identifies itself as the Claude Code client, which is the part a
 * user is least able to discover on their own.
 *
 * The answer is remembered per machine, never synced, and revocable.
 */
export class NetworkConsent {
  private asking: Promise<boolean> | null = null

  constructor(
    private memento: MementoLike,
    private log: (msg: string) => void,
    private opts: { intervalMinutes?: () => number; ui?: ConsentUi } = {},
  ) {}

  state(): ConsentState {
    return this.memento.get<ConsentState>(CONSENT_KEY, 'unasked')
  }

  granted(): boolean {
    return this.state() === 'granted'
  }

  /** The text the dialog would show right now — also used by the onboarding card. */
  disclosure(): string {
    return disclosure(this.opts.intervalMinutes?.() ?? DEFAULT_INTERVAL_MINUTES)
  }

  /**
   * Asks once and remembers the answer. Concurrent callers share the same
   * dialog rather than stacking several on top of each other.
   */
  request(): Promise<boolean> {
    if (this.granted()) return Promise.resolve(true)
    if (this.asking) return this.asking
    this.asking = this.ask().finally(() => { this.asking = null })
    return this.asking
  }

  private async ask(): Promise<boolean> {
    const ui = this.opts.ui ?? windowUi()
    const choice = await ui.showInformationMessage(
      'Allow Token Pace to fetch quota figures?',
      { modal: true, detail: this.disclosure() },
      'Allow',
      'Never',
    )
    if (choice === 'Allow') {
      await this.memento.update(CONSENT_KEY, 'granted')
      this.log('Network access allowed by the user.')
      return true
    }
    // Cancel means "not now" and stays askable; only "Never" is recorded.
    if (choice === 'Never') {
      await this.memento.update(CONSENT_KEY, 'denied')
      this.log('Network access declined by the user.')
    }
    return false
  }

  /** Whether the unprompted one-time offer has already been made. */
  offered(): boolean {
    return this.memento.get<boolean>(OFFERED_KEY, false)
  }

  async markOffered(): Promise<void> {
    await this.memento.update(OFFERED_KEY, true)
  }

  async reset(): Promise<void> {
    await this.memento.update(CONSENT_KEY, undefined)
    await this.memento.update(OFFERED_KEY, undefined)
    this.log('Network access decision reset.')
  }
}

export type WriteConsentKind = 'writeQuotaCache' | 'statusLine'

/** Concrete paths for the disclosure text; every one of them is named in the dialog. */
export interface WriteConsentPaths {
  /**
   * Every external quota cache file the writer would create or replace — one
   * per provider. A dialog that named only the Claude file asked for less than
   * the opt-in actually does, and the Codex path is configurable too.
   */
  quotaCacheFiles?: string[]
  /** Claude Code's settings file the bridge would edit. */
  settingsFile?: string
  /** Where the bridge mirrors the status-line JSON (inside globalStorage). */
  mirrorFile?: string
}

/** Supplied as a function wherever the paths follow a setting that can change. */
export type WriteConsentPathsSource = WriteConsentPaths | (() => WriteConsentPaths)

function resolvePaths(source: WriteConsentPathsSource | undefined): WriteConsentPaths {
  if (typeof source === 'function') {
    try {
      return source() ?? {}
    } catch {
      // A path source that throws must not swallow the dialog; the defaults below
      // still describe the shape of what is written.
      return {}
    }
  }
  return source ?? {}
}

/**
 * The paths the writer uses when neither `tokenPace.claudeQuotaFile` nor
 * `tokenPace.codexQuotaFile` is set — the defaults of `src/quota.ts`, repeated
 * here in `~` form because that module resolves them against the real home.
 *
 * Named only when the live paths cannot be read (a settings lookup that throws).
 * A dialog must never name a file the extension would not touch, so these stay
 * in step with `DEFAULT_CLAUDE_QUOTA` / `DEFAULT_CODEX_QUOTA`.
 */
export const DEFAULT_QUOTA_CACHE_FILES: readonly string[] = [
  '~/.cache/claude-usage/state.json',
  '~/.cache/codex-usage/state.json',
]

const WRITE_TITLES: Record<WriteConsentKind, string> = {
  writeQuotaCache: 'Allow Token Pace to write the shared quota cache file?',
  statusLine: 'Allow Token Pace to edit Claude Code\'s settings.json?',
}

/**
 * The text for a write outside `globalStorage`.
 *
 * Both cases touch a file the user did not create for us, so the dialog names
 * the exact path, what protects it (backup, never overwriting newer data) and
 * how to undo it. Nothing here is reversible by us alone after the fact.
 */
export function writeConsentDisclosure(kind: WriteConsentKind, paths: WriteConsentPaths = {}): string {
  if (kind === 'writeQuotaCache') {
    const files = (paths.quotaCacheFiles ?? []).filter((f) => typeof f === 'string' && f.trim() !== '')
    const listed = files.length > 0 ? files : [...DEFAULT_QUOTA_CACHE_FILES]
    return [
      'Token Pace writes only into its own storage — with this one exception, if you allow it.',
      '',
      'After each of its own quota polls it would write the result to these files, one per',
      'provider:',
      ...listed.map((f) => `  ${f}`),
      '',
      'Each of them is the documented exchange format (schema_version 1) other tools read, so a',
      'panel, a shell prompt and this extension can share one fetch instead of three.',
      '',
      'They contain the provider\'s quota response — percentages, reset times, plan type. They',
      'never contain your access token. An existing file whose fetch time is newer than ours is',
      'never overwritten, and the write is atomic (temp file plus rename), so a reader never',
      'sees half a file.',
      '',
      'Switch it off again with the setting "tokenPace.writeQuotaCache".',
    ].join('\n')
  }
  const settings = paths.settingsFile ?? '~/.claude/settings.json'
  const mirror = paths.mirrorFile ?? '<globalStorage>/statusline-mirror.json'
  return [
    'Token Pace writes only into its own storage — with this one exception, if you allow it.',
    '',
    'To read quota figures without any network access, it can register a small script as Claude',
    'Code\'s status line. Claude Code then runs that script on every status-line refresh and pipes',
    'its status JSON into it; the script mirrors that JSON to a file and prints a status line.',
    '',
    'What changes:',
    `  • ${settings} — the "statusLine" entry is set to the script.`,
    `  • A backup is written first, next to it, as settings.json.token-pace-backup-<timestamp>.`,
    `  • The mirrored JSON is stored at ${mirror}.`,
    '',
    'An existing status-line command is kept: it is called by the script with the same input and',
    'its output is passed through unchanged. A settings.json that cannot be parsed is never',
    'touched. The script never sends anything anywhere and never logs the piped JSON.',
    '',
    '"Token Pace: Disconnect Claude Status Line" restores the previous entry exactly — as long as',
    'the entry is still the one we installed. It is not removed automatically when the extension',
    'is uninstalled, so disconnect first if you plan to remove Token Pace.',
  ].join('\n')
}

/**
 * Consent for one kind of write outside `globalStorage`.
 *
 * Separate from the network consent and from each other: allowing a cache file
 * to be shared says nothing about letting an editor rewrite Claude Code's own
 * configuration, and the reverse is just as true.
 */
export class WriteConsent {
  private asking: Promise<boolean> | null = null
  private readonly key: string

  constructor(
    private memento: MementoLike,
    readonly kind: WriteConsentKind,
    private log: (msg: string) => void,
    private opts: { ui?: ConsentUi; paths?: WriteConsentPathsSource } = {},
  ) {
    this.key = `writeConsent.${kind}`
  }

  /** The memento key this instance owns — the delete command lists it. */
  mementoKey(): string {
    return this.key
  }

  state(): ConsentState {
    return this.memento.get<ConsentState>(this.key, 'unasked')
  }

  granted(): boolean {
    return this.state() === 'granted'
  }

  /**
   * The text as it is right now.
   *
   * Resolved per call, not once at construction: the quota cache paths follow
   * `tokenPace.claudeQuotaFile` / `tokenPace.codexQuotaFile`, and a dialog that
   * named the path those settings had at activation would name the wrong file.
   */
  disclosure(): string {
    return writeConsentDisclosure(this.kind, resolvePaths(this.opts.paths))
  }

  request(): Promise<boolean> {
    if (this.granted()) return Promise.resolve(true)
    if (this.asking) return this.asking
    this.asking = this.ask().finally(() => { this.asking = null })
    return this.asking
  }

  private async ask(): Promise<boolean> {
    const ui = this.opts.ui ?? windowUi()
    const choice = await ui.showInformationMessage(
      WRITE_TITLES[this.kind],
      { modal: true, detail: this.disclosure() },
      'Allow',
      'Never',
    )
    if (choice === 'Allow') {
      await this.memento.update(this.key, 'granted')
      this.log(`Write access allowed by the user: ${this.kind}.`)
      return true
    }
    if (choice === 'Never') {
      await this.memento.update(this.key, 'denied')
      this.log(`Write access declined by the user: ${this.kind}.`)
    }
    return false
  }

  async reset(): Promise<void> {
    await this.memento.update(this.key, undefined)
    this.log(`Write access decision reset: ${this.kind}.`)
  }
}
