// SPDX-FileCopyrightText: 2026 Frederik Marx
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The two questions the extension is allowed to ask, and the answers it keeps.
 *
 * Everything this tool does by default is local and read-only. The three
 * exceptions — one network call and two writes outside `globalStorage` — each
 * have their own dialog, their own memento key and their own revocation, so a
 * yes to one is never a yes to another. 1.8 B2 adds a fourth of the same kind:
 * the opt-in keep-warm line, the one thing the extension does on its own (§0c),
 * with a dialog that names its cost, its risk and the terms it falls under.
 *
 * The dialogs state what happens in concrete terms (which address, which file,
 * which interval), because a consent dialog whose text is vaguer than the
 * action it unlocks is a formality, not a decision.
 */

import { t } from './i18n'
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
 * moved, and the whole point of this dialog is that its numbers are true. For the
 * same reason the Codex paragraph follows `tokenPace.codexAppServer.mode` (1.12 A5):
 * `persistent` — the default — keeps the app-server running while this window
 * fetches, and the text says so; `oneShot` keeps the 1.x sentence.
 */
export function disclosure(intervalMinutes: number, appServerMode: 'oneShot' | 'persistent' = 'persistent'): string {
  const minutes = Number.isFinite(intervalMinutes) && intervalMinutes > 0
    ? Math.round(intervalMinutes)
    : DEFAULT_INTERVAL_MINUTES
  // One key per paragraph, with the hard wraps inside it: the dialog's layout is part of the
  // text, and a translated half-sentence glued to an English one would not be either.
  return [
    t('Token counts are read from local transcript files and need no network access. Quota percentages do.'),
    '',
    cadenceLine(minutes),
    '',
    t('\u2022 Claude \u2014 GET https://api.anthropic.com/api/oauth/usage, using the accessToken from\n  ~/.claude/.credentials.json. The request identifies itself as the Claude Code client,\n  because the endpoint rate-limits other callers into a permanent 429.'),
    appServerMode === 'oneShot'
      ? t('\u2022 Codex \u2014 the local "codex app-server" is started and asked for its rate limits. No traffic\n  of ours leaves the machine for this.')
      : t('\u2022 Codex \u2014 the local "codex app-server" is started, kept running while this window fetches, and\n  asked for its rate limits. No traffic of ours leaves the machine for this.'),
    '',
    t('That endpoint is undocumented: it is what Claude Code itself calls, it carries no stability\npromise, and it may change or disappear at any time. Token Pace then shows no quota figures\nrather than guessing any.'),
    '',
    t('The token is only read, never refreshed, and appears in no log line or error message. The\ntarget address is hard-coded and cannot be configured. Nothing is sent anywhere else, and\nno usage data is collected by this extension.'),
    '',
    t('You can change this later with "Token Pace: Reset Network Access Decision".'),
  ].join('\n')
}

/**
 * "every 45 minutes", "every 1 hour", "every 2 hours" \u2014 as three whole sentences.
 *
 * The cadence is not assembled from a translated fragment: "every" and "hours" belong to one
 * sentence in every language, and a language that puts the number last could not be served by
 * a phrase glued together here.
 */
function cadenceLine(minutes: number): string {
  if (minutes >= 60 && minutes % 60 === 0) {
    const hours = minutes / 60
    return hours === 1
      ? t('If you allow it, then at most every {0} hour (tokenPace.pollIntervalMinutes):', hours)
      : t('If you allow it, then at most every {0} hours (tokenPace.pollIntervalMinutes):', hours)
  }
  return t('If you allow it, then at most every {0} minutes (tokenPace.pollIntervalMinutes):', minutes)
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
    private opts: {
      intervalMinutes?: () => number
      /** 1.12 A5: the configured `tokenPace.codexAppServer.mode`, read when the text is shown. */
      appServerMode?: () => 'oneShot' | 'persistent'
      ui?: ConsentUi
    } = {},
  ) {}

  state(): ConsentState {
    return this.memento.get<ConsentState>(CONSENT_KEY, 'unasked')
  }

  granted(): boolean {
    return this.state() === 'granted'
  }

  /** The text the dialog would show right now — also used by the onboarding card. */
  disclosure(): string {
    return disclosure(this.opts.intervalMinutes?.() ?? DEFAULT_INTERVAL_MINUTES, this.opts.appServerMode?.() ?? 'persistent')
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
    // The two buttons are computed once and compared with those same values: a label that is
    // translated on the way in and re-translated on the way out is a comparison against a
    // string nobody ever showed.
    const allow = t('Allow')
    const never = t('Never')
    const choice = await ui.showInformationMessage(
      t('Allow Token Pace to fetch quota figures?'),
      { modal: true, detail: this.disclosure() },
      allow,
      never,
    )
    if (choice === allow) {
      await this.memento.update(CONSENT_KEY, 'granted')
      this.log('Network access allowed by the user.')
      return true
    }
    // Cancel means "not now" and stays askable; only "Never" is recorded.
    if (choice === never) {
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
  /** Where the bridge keeps the fields Token Pace reads of the status-line JSON (inside globalStorage). */
  mirrorFile?: string
  /**
   * 1.8 §7a Q16: the script's copy the installed command names — `<globalStorage>/statusline-bridge.js`,
   * inside the extension's storage, which an uninstall deletes.
   */
  scriptFile?: string
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

/** The question, asked when the dialog opens rather than when this module is loaded. */
function writeTitle(kind: WriteConsentKind): string {
  return kind === 'writeQuotaCache'
    ? t('Allow Token Pace to write the shared quota cache file?')
    : t('Allow Token Pace to edit Claude Code\'s settings.json?')
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
      t('Token Pace writes only into its own storage \u2014 with this one exception, if you allow it.'),
      '',
      t('After each of its own quota polls it would write the result to these files, one per\nprovider:'),
      ...listed.map((f) => `  ${f}`),
      '',
      t('Each of them is the documented exchange format (schema_version 1) other tools read, so a\npanel, a shell prompt and this extension can share one fetch instead of three.'),
      '',
      t('They contain the provider\'s quota response \u2014 percentages, reset times, plan type. They\nnever contain your access token. An existing file whose fetch time is newer than ours is\nnever overwritten, and the write is atomic (temp file plus rename), so a reader never\nsees half a file.'),
      '',
      t('Switch it off again with the setting "tokenPace.writeQuotaCache".'),
    ].join('\n')
  }
  const settings = paths.settingsFile ?? '~/.claude/settings.json'
  const mirror = paths.mirrorFile ?? '<globalStorage>/statusline-mirror.json'
  const script = paths.scriptFile ?? '<globalStorage>/statusline-bridge.js'
  // 1.8 (§7a Q11, Q16; §7c wave 2 fact 13): the script keeps only the fields the reader takes — the
  // dialog says so, and names the copy in the extension's storage that the command runs.
  return [
    t('Token Pace writes only into its own storage \u2014 with this one exception, if you allow it.'),
    '',
    t('To read quota figures without any network access, it can register a small script as Claude\nCode\'s status line. Claude Code then runs that script on every status-line refresh and pipes\nits status JSON into it; the script keeps of it only the fields Token Pace reads \u2014 the quota\nwindows, the plan, the context window, the cost, the model, the prompt cache and the session\'s\nid \u2014 in a file, and prints a status line. The session\'s name, its working directory, its\ntranscript\'s path and the rest of the JSON never reach the file.'),
    '',
    t('What changes:'),
    `  \u2022 ${t('{0} \u2014 the "statusLine" entry is set to the script\'s copy at {1}, in the extension\'s storage.', settings, script)}`,
    `  \u2022 ${t('A backup is written first, next to it, as settings.json.token-pace-backup-<timestamp>.')}`,
    `  \u2022 ${t('Those fields are stored at {0}.', mirror)}`,
    '',
    t('An existing status-line command is kept: it is called by the script with the same input and\nits output is passed through unchanged. A settings.json that cannot be parsed is never\ntouched. The script never sends anything anywhere and never logs the piped JSON.'),
    '',
    t('"Token Pace: Disconnect Claude Status Line" restores the previous entry exactly \u2014 as long as\nthe entry is still the one we installed. Uninstalling the extension does not remove the entry\nbut deletes the script\'s copy with the extension\'s storage, and a status line still connected\nwould then start a script that is gone \u2014 so disconnect first if you plan to remove Token Pace.'),
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
    // Same rule as the network dialog: one value, shown and compared.
    const allow = t('Allow')
    const never = t('Never')
    const choice = await ui.showInformationMessage(
      writeTitle(this.kind),
      { modal: true, detail: this.disclosure() },
      allow,
      never,
    )
    if (choice === allow) {
      await this.memento.update(this.key, 'granted')
      this.log(`Write access allowed by the user: ${this.kind}.`)
      return true
    }
    if (choice === never) {
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

// ---------------------------------------------------------------------------
// 1.8 B2 (§0c, §3 B2 "Consent"): the keep-warm line
// ---------------------------------------------------------------------------

/** 1.8 §0b.3: the keep-warm consent's memento key — a key of its own, as the other two decisions have. */
export const KEEP_WARM_CONSENT_KEY = 'tokenPace.keepWarmConsent'

/**
 * The passage of Anthropic's Consumer Terms (section 3, "Use of our Services", effective October 8, 2025)
 * the keep-warm line falls under — quoted word for word, in English in every language: a quote of an
 * English legal text is not re-worded. The dialog names no address (the check of the shipped strings
 * allows none for it); docs/prompt-cache.md links the terms.
 */
export const KEEP_WARM_TERMS_PASSAGE = 'Except when you are accessing our Services via an Anthropic API Key or where we otherwise explicitly permit it, to access the Services through automated or non-human means, whether through a bot, script, or otherwise.'

/** The one `vscode.window` method the keep-warm dialog needs: a modal warning. */
export interface KeepWarmConsentUi {
  showWarningMessage(
    message: string,
    options: { modal: boolean; detail?: string },
    ...items: string[]
  ): PromiseLike<string | undefined>
}

/**
 * The keep-warm dialog's text (§3 B2 "Consent", §7a Q19, §7c probe P-4): what is typed, where and when
 * — the countdown at three minutes of warmth left, the line at about two —, what it costs and that every
 * line is logged and every answered one counted (§0c, §7c wave 3 decision 6), what cannot be
 * made safe (a draft in Claude Code's input line is sent with it; the extension's own panel is out of
 * reach; a dialog the transcript does not show is not seen), the terms passage word for word, and how to
 * withdraw. One key per paragraph; the line and the passage go in as arguments, never translated.
 */
export function keepWarmDisclosure(line: string): string {
  return [
    t('When the status line reports that the one-hour prompt cache of a Claude Code session running in a VS Code terminal of this window has three minutes or less left, Token Pace starts a one-minute countdown in the status bar that you can cancel. When it ends, Token Pace types “{0}” into that terminal and presses Enter — about two minutes before the cache expires, at most three times in a row, and never while a Claude quota window stands at 90 % or more.', line),
    '',
    t('Cost: every line is a real request. Claude re-reads the whole conversation at the cache rate and writes a short reply; on a subscription this counts against your usage limits. Every line is written to the Token Pace log, and every line Claude Code answers is counted as a keep-warm request on the Claude card.'),
    '',
    t('Risk: Token Pace cannot see Claude Code\'s input line. Anything you typed there and did not send is sent with it — type nothing into the Claude terminal while the countdown runs. Nor can Token Pace see a dialog the transcript does not show. A session in the Claude Code extension\'s own panel is out of reach and gets no line.'),
    '',
    t('Terms: section 3 of Anthropic\'s Consumer Terms lists among what is not allowed: “{0}” Typing this line is automated access of that kind, and Anthropic has not explicitly permitted it.', KEEP_WARM_TERMS_PASSAGE),
    '',
    t('Switch it off at any time with the setting tokenPace.cacheKeepWarm; switching it off withdraws this consent.'),
  ].join('\n')
}

function warningUi(): KeepWarmConsentUi {
  const vscode = require('vscode') as typeof import('vscode')
  return vscode.window
}

/**
 * The consent for the keep-warm line — a small class of the shape of `NetworkConsent` and `WriteConsent`
 * (state, granted, request, reset, its memento key), its own key and its own dialog: a yes to a fetch or
 * a write is never a yes to typing into Claude Code. Only "Allow keep-warm" grants; any other end of the
 * dialog — the modal's Cancel, Escape — is a refusal, recorded, so the question is not put again at the
 * next start; the host asks again only when the setting goes off and on (switching it off withdraws the
 * consent, `reset`).
 */
export class KeepWarmConsent {
  private asking: Promise<boolean> | null = null

  constructor(
    private memento: MementoLike,
    private log: (msg: string) => void,
    private opts: { ui?: KeepWarmConsentUi; line?: string } = {},
  ) {}

  /** The memento key this instance owns — the delete command lists it. */
  mementoKey(): string {
    return KEEP_WARM_CONSENT_KEY
  }

  state(): ConsentState {
    const v = this.memento.get<unknown>(KEEP_WARM_CONSENT_KEY, 'unasked')
    return v === 'granted' || v === 'denied' ? v : 'unasked'
  }

  granted(): boolean {
    return this.state() === 'granted'
  }

  /** The dialog's detail as it is shown. */
  disclosure(): string {
    return keepWarmDisclosure(this.opts.line ?? '')
  }

  /** Asks and records the answer; concurrent callers share the one dialog. */
  request(): Promise<boolean> {
    if (this.granted()) return Promise.resolve(true)
    if (this.asking) return this.asking
    this.asking = this.ask().finally(() => { this.asking = null })
    return this.asking
  }

  private async ask(): Promise<boolean> {
    const ui = this.opts.ui ?? warningUi()
    // One value, shown and compared — as in the other two dialogs.
    const allow = t('Allow keep-warm')
    const choice = await ui.showWarningMessage(
      t('Let Token Pace type a keep-warm line into Claude Code\'s terminal?'),
      { modal: true, detail: this.disclosure() },
      allow,
    )
    if (choice === allow) {
      await this.memento.update(KEEP_WARM_CONSENT_KEY, 'granted')
      this.log('Keep-warm allowed by the user.')
      return true
    }
    await this.memento.update(KEEP_WARM_CONSENT_KEY, 'denied')
    this.log('Keep-warm declined by the user; it is asked again when tokenPace.cacheKeepWarm is switched off and on.')
    return false
  }

  /** Switching the setting off withdraws the consent: the next switch on asks again. */
  async reset(): Promise<void> {
    if (this.memento.get<unknown>(KEEP_WARM_CONSENT_KEY, undefined) === undefined) return
    await this.memento.update(KEEP_WARM_CONSENT_KEY, undefined)
    this.log('Keep-warm consent withdrawn: tokenPace.cacheKeepWarm was switched off.')
  }
}
