// SPDX-FileCopyrightText: 2026 Frederik Marx
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * 1.12 C6–C9, C12 (§2.3, §0a.8, §0a.9, §0a.11): the notifications' host — the one module that knows where a
 * message goes. It holds the channels' secrets in VS Code's secret storage, asks the consent that names a
 * channel's host, runs the three commands (*Set Up a Notification Channel…*, *Send a Test Notification…*,
 * *Remove a Notification Channel…*), evaluates the events when extension.ts asks it to, and hands the
 * diagnostics their `notifications` line.
 *
 * What an event is, whether it may go out and what a message says is notify.ts's (`notifyRound`, `payloadOf`);
 * how a message reaches a channel is notifyChannels.ts's and notifySmtp.ts's. This file joins them, and the rules
 * it adds are these, each with the reason it exists:
 *
 *  • The secrets live in VS Code's secret storage and nowhere else (§0a.8): this is the one module of src/ that
 *    names it (a static test holds that). A secret is read at the moment of a send and dropped with it, and by
 *    the setup and *Remove*; the diagnostics ask only which keys exist. No secret reaches a log line, a message,
 *    the diagnostics, a memento or a setting — the setup writes no setting at all (§0b.5, §7a Q20).
 *  • A channel sends only to the host its consent named (C6): the consent is asked after the address and the
 *    secrets were typed and before anything is stored, and it is kept per channel as `{ host, at }`. At every
 *    send the channel's host as it is now — the stored address's, Telegram's fixed one, the ntfy server's, the
 *    SMTP server's with its port — must be that host; a changed host skips the send until *Set Up* asks again.
 *  • Nothing at all while no channel is listed (C9 rule 3): `request` and `evaluate` return at their first line,
 *    before any secret, state or table is touched. A follower window sends nothing (C2 rule 7).
 *  • One evaluation at a time, at most one per `NOTIFY_EVAL_MIN_MS` (C9 rule 2): a request inside that span
 *    runs once at its end, with the readings of that moment.
 *  • A send that failed is not tried again (§7a Q24): its result is the channel's `last` entry, which the
 *    diagnostics show; a 429's `Retry-After` pauses the channel until then (C1 rule 6, C4 rule 6).
 *  • The test message (C4 rule 7) passes the once-rule, the cooldown and the hourly cap, not the consent's host
 *    or a pause, and goes to one channel at most once in `TEST_MIN_GAP_MS` — a second one inside it is answered,
 *    not sent (Review 3 F8).
 *  • A stored secret is bound to the host its consent named (Review 3 F1, F2): a setup that allows another host
 *    keeps none of the old one's secrets unless the reader types them again, and a preset keeps no header value.
 *  • The words of the commands are the reader's language (C13); the log and the diagnostics stay English.
 */

import { httpsOnly } from './config'
import type { ChannelKind, NotifyConfig, NotifyEventKind, WebhookFormat } from './config'
import type { NotificationsDiag, NotifyChannelDiag } from './diagnostics'
import { t } from './i18n'
import {
  Admission, ChannelLast, droppedLines, loadNotifyState, newNotifyTables, NOTIFY_CHANNELS, NOTIFY_HOURLY_CAP, NOTIFY_STATE_KEY,
  NotificationEvent, NotificationPayload, NotifyInput, notifyRound, NotifyTables, saveNotifyState, testPayload,
} from './notify'
import { FetchLike, SendResult, sendNtfy, sendTelegram, sendWebhook, TELEGRAM_API_HOST } from './notifyChannels'
import { sendMail, SmtpTransport } from './notifySmtp'
import type { MementoLike } from './storage'
import type { TimeConfig } from './time'

/**
 * §0a.8: the only keys this extension ever stores in VS Code's secret storage — a frozen list; *Remove* and
 * *Clear Stored Data* delete from it, nothing else is written there.
 */
export const NOTIFY_SECRET_KEYS = Object.freeze({
  webhookUrl: 'tokenPace.notify.webhook.url',
  webhookSecret: 'tokenPace.notify.webhook.secret',
  telegramBotToken: 'tokenPace.notify.telegram.botToken',
  ntfyTopic: 'tokenPace.notify.ntfy.topic',
  ntfyToken: 'tokenPace.notify.ntfy.token',
  emailPassword: 'tokenPace.notify.email.password',
})

/** The six, as a list. */
export const NOTIFY_SECRET_KEY_LIST: readonly string[] = Object.freeze(Object.values(NOTIFY_SECRET_KEYS))

/** §0a.11: the consents per channel — `{ [channel]: { host, at } }`, per profile, never synced. */
export const NOTIFY_CONSENT_KEY = 'tokenPace.notifyConsent'

/** C9 rule 2: at most one evaluation in this span; a request inside it runs once at its end. */
export const NOTIFY_EVAL_MIN_MS = 5_000

/** C4 rule 7: one test message per channel in this span. */
export const TEST_MIN_GAP_MS = 10_000

/** A channel's secrets, the one it cannot send without first. */
const CHANNEL_SECRETS: Readonly<Record<ChannelKind, readonly string[]>> = {
  webhook: [NOTIFY_SECRET_KEYS.webhookUrl, NOTIFY_SECRET_KEYS.webhookSecret],
  telegram: [NOTIFY_SECRET_KEYS.telegramBotToken],
  ntfy: [NOTIFY_SECRET_KEYS.ntfyTopic, NOTIFY_SECRET_KEYS.ntfyToken],
  email: [NOTIFY_SECRET_KEYS.emailPassword],
}
const REQUIRED_SECRET: Readonly<Record<ChannelKind, string>> = {
  webhook: NOTIFY_SECRET_KEYS.webhookUrl,
  telegram: NOTIFY_SECRET_KEYS.telegramBotToken,
  ntfy: NOTIFY_SECRET_KEYS.ntfyTopic,
  email: NOTIFY_SECRET_KEYS.emailPassword,
}

/** The services' own names (never keys, never translated — §3 E1); the generic webhook's is C13's. */
const FORMAT_NAMES: Readonly<Record<Exclude<WebhookFormat, 'generic'>, string>> = {
  slack: 'Slack',
  discord: 'Discord',
  teams: 'Microsoft Teams',
  mattermost: 'Mattermost',
  rocketChat: 'Rocket.Chat',
}

/** The slice of `vscode.SecretStorage` this module needs — a test hands in a map. */
export interface SecretStorageLike {
  get(key: string): PromiseLike<string | undefined>
  store(key: string, value: string): PromiseLike<void>
  delete(key: string): PromiseLike<void>
  /** Which keys hold a value — the diagnostics' "set" without reading one. */
  keys?(): PromiseLike<readonly string[]>
}

export interface NotifyPickItem {
  label: string
  description?: string
}

/** The questions the commands ask — `vscode.window`'s, a test's script. */
export interface NotifyUi {
  pick<T extends NotifyPickItem>(items: readonly T[], options: { placeHolder: string }): PromiseLike<T | undefined>
  input(options: {
    title: string
    prompt: string
    placeHolder?: string
    password: true
    ignoreFocusOut: true
    validateInput?: (value: string) => string | undefined
  }): PromiseLike<string | undefined>
  /** A modal question: `info` for the consent, `warning` for *Remove*. */
  modal(kind: 'info' | 'warning', message: string, detail: string | undefined, ...buttons: string[]): PromiseLike<string | undefined>
  /** The answer to a command — never an alert (§0b.6): shown only because the reader ran the command. */
  info(message: string, ...buttons: string[]): PromiseLike<string | undefined>
  /** The settings UI at a query (`@id:tokenPace.notifications.channels`). */
  openSettings(query: string): PromiseLike<unknown>
}

export interface NotifyLog {
  info(m: string): void
  debug(m: string): void
}

export interface NotifyHostDeps {
  secrets: SecretStorageLike
  memento: MementoLike
  ui: NotifyUi
  /** notifyChannels.ts `httpsFetch` — the channels' one real fetch; a test's fake. */
  fetch: FetchLike
  /** notifySmtp.ts `smtpTransport()` — a test's scripted server. */
  smtp: SmtpTransport
  log: NotifyLog
  clock: () => number
  /** The notification settings as they are now. */
  config: () => NotifyConfig
  /** The zone and hour cycle the texts' clock times are written in. */
  timeConfig: () => TimeConfig
  /** What one evaluation reads — asked when it runs, not when it is requested. */
  input: () => NotifyInput
  /** This extension's version, for the channels' honest `User-Agent`. */
  version?: string
  /** The trailing timer of `request` — a test's own. */
  setTimer?: (fn: () => void, ms: number) => unknown
  clearTimer?: (handle: unknown) => void
}

/** A channel's consent as it is kept (§0a.11). */
export interface ChannelConsent {
  host: string
  at: number
}

/** What a channel's send came to: a channel's result, or why it was not sent. */
export type SendOutcome =
  | SendResult
  | { ok: false; kind: 'notSetUp' }
  | { ok: false; kind: 'hostChanged' }
  | { ok: false; kind: 'paused'; until: number }

/** A host as a consent holds it: a host name or an address, with a port — never a path, a user or a secret. */
const HOST_RE = /^[A-Za-z0-9.:[\]-]{1,300}$/

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/** The consents read back by their shape: a channel of the four, a host of the host's alphabet, a time. */
export function readConsents(memento: MementoLike): Partial<Record<ChannelKind, ChannelConsent>> {
  const raw = memento.get<unknown>(NOTIFY_CONSENT_KEY, undefined)
  const out: Partial<Record<ChannelKind, ChannelConsent>> = {}
  if (!isObject(raw)) return out
  for (const channel of NOTIFY_CHANNELS) {
    const v = raw[channel]
    if (!isObject(v) || typeof v.host !== 'string' || !HOST_RE.test(v.host)) continue
    if (typeof v.at !== 'number' || !Number.isFinite(v.at)) continue
    out[channel] = { host: v.host, at: v.at }
  }
  return out
}

/** The channel's name in a message: the service's own, or C13's "Webhook (JSON)" and "E-mail (SMTP)". */
export function channelName(channel: ChannelKind, format: WebhookFormat): string {
  switch (channel) {
    case 'webhook': return format === 'generic' ? t('Webhook (JSON)') : FORMAT_NAMES[format]
    case 'telegram': return 'Telegram'
    case 'ntfy': return 'ntfy'
    default: return t('E-mail (SMTP)')
  }
}

/** C13's failure words — a fixed word per kind, the HTTP status as data; never a body or a server's text. */
export function failureWord(r: SendOutcome): string {
  if (r.ok) return ''
  switch (r.kind) {
    case 'http': return typeof r.status === 'number' ? `HTTP ${r.status}` : 'HTTP'
    case 'timeout': return t('timeout')
    case 'tls': return t('TLS error')
    case 'network': return t('network error')
    case 'refused': return t('refused by the server')
    case 'hostChanged': return t('its host changed since you allowed it')
    // A 429's pause is the server's own answer, kept until its Retry-After.
    case 'paused': return 'HTTP 429'
    default: return t('incomplete setup')
  }
}

/** The English form of a result for the log: the kind and its status, never a URL, a body or a host. */
function logWord(r: SendOutcome): string {
  if (r.ok) return 'ok'
  if (r.kind === 'http') return `HTTP ${typeof r.status === 'number' ? r.status : '?'}`
  if (r.kind === 'refused' && typeof r.status === 'number') return `refused ${r.status}`
  return r.kind
}

/** What *Set Up* offers: nine entries, the webhook's presets as the webhook with another format (C8 rule 1). */
type SetupChoice = { channel: 'webhook'; format: WebhookFormat } | { channel: 'telegram' | 'ntfy' | 'email' }
interface SetupItem extends NotifyPickItem { choice: SetupChoice }

function setupItems(): SetupItem[] {
  const hook = (format: WebhookFormat): SetupChoice => ({ channel: 'webhook', format })
  return [
    { label: t('Webhook (JSON)'), description: t('any https address that accepts JSON'), choice: hook('generic') },
    { label: FORMAT_NAMES.slack, choice: hook('slack') },
    { label: FORMAT_NAMES.discord, choice: hook('discord') },
    { label: FORMAT_NAMES.teams, choice: hook('teams') },
    { label: FORMAT_NAMES.mattermost, choice: hook('mattermost') },
    { label: FORMAT_NAMES.rocketChat, choice: hook('rocketChat') },
    { label: 'Telegram', choice: { channel: 'telegram' } },
    { label: 'ntfy', choice: { channel: 'ntfy' } },
    { label: t('E-mail (SMTP)'), choice: { channel: 'email' } },
  ]
}

interface ChannelItem extends NotifyPickItem { channel: ChannelKind }

/**
 * What a setup collected before its consent: the host the consent names, the secrets to store on *Allow*, and the
 * stored secrets to delete on *Allow* — each one bound to a host this setup no longer allows (Review 3 F1, F2).
 */
interface SetupPlan {
  host: string
  secrets: Record<string, string>
  deletes: string[]
}

/**
 * C6 rule 1: the consent's detail — four whole paragraphs, the host in the first and the third.
 */
export function consentDetail(host: string): string {
  return [
    t('Token Pace will send a short message to {0} over an encrypted connection when one of the events you list in tokenPace.notifications.events happens — at most once per event and quota window, and at most one message of a kind every tokenPace.notifications.cooldownMinutes minutes.', host),
    t('A message holds only the event, the program or provider, the quota window, percentages and times — never a prompt, a line of a transcript, a path, a project, a session\'s name or id, or anything Claude Code or Codex wrote.'),
    t('The address and its secret stay in VS Code\'s secret storage on this machine, never in settings.json. Token Pace reads nothing back from {0} except whether it accepted the message.', host),
    t('You can take this back with "Token Pace: Remove a Notification Channel…".'),
  ].join('\n\n')
}

export class NotifyHost {
  private tables: NotifyTables = newNotifyTables()
  private running: Promise<void> | null = null
  private timer: unknown = null
  private lastRun: number | null = null
  private again = false
  private disposed = false
  /** C4 rule 7: when each channel's last test message went, in memory only. */
  private readonly lastTest = new Map<ChannelKind, number>()

  constructor(private readonly deps: NotifyHostDeps) {}

  // -------------------------------------------------------------- evaluation (C9)

  /**
   * C9 rule 2: an evaluation, now or at the end of the running span — the readings, sessions and waits read
   * when it runs. With no channel listed it returns at once (rule 3): no timer, no read.
   */
  request(): void {
    if (this.disposed || this.deps.config().channels.length === 0) return
    if (this.running !== null) { this.again = true; return }
    if (this.timer !== null) return
    const now = this.deps.clock()
    const wait = this.lastRun === null || now < this.lastRun ? 0 : Math.max(0, this.lastRun + NOTIFY_EVAL_MIN_MS - now)
    this.timer = (this.deps.setTimer ?? setTimeout)(() => {
      this.timer = null
      this.run()
    }, wait)
  }

  private run(): void {
    if (this.disposed || this.running !== null) return
    const now = this.deps.clock()
    this.lastRun = now
    this.running = this.evaluate(this.deps.input(), this.deps.config(), now)
      .then(() => undefined, (err: unknown) => {
        this.deps.log.debug(`Notify: the evaluation failed (${err instanceof Error ? err.name : 'error'})`)
      })
      .finally(() => {
        this.running = null
        if (this.again) {
          this.again = false
          this.request()
        }
      })
  }

  /** The evaluation in flight, for a test and for the teardown. */
  settled(): Promise<void> {
    return this.running ?? Promise.resolve()
  }

  /**
   * One evaluation (C9): nothing with no channel listed — not a secret, not the state, not a table (rule 3) —
   * nor in a follower window; otherwise notify.ts's round, whose admitted messages go to every listed channel.
   */
  async evaluate(input: NotifyInput, cfg: NotifyConfig, now: number): Promise<Admission | null> {
    if (cfg.channels.length === 0) {
      if (this.tables.turns.size > 0 || this.tables.waits.size > 0) this.tables = newNotifyTables()
      return null
    }
    if (input.role === 'follower') return null
    const admission = await notifyRound(input, cfg, this.tables, {
      memento: this.deps.memento,
      words: { tcfg: this.deps.timeConfig(), now },
      send: (payload, events) => this.fanOut(payload, events, cfg, now),
    }, now)
    for (const line of droppedLines(admission.dropped)) this.deps.log.debug(line)
    return admission
  }

  /** One message to every listed channel, one after the other. */
  private async fanOut(payload: NotificationPayload, events: readonly NotificationEvent[], cfg: NotifyConfig, now: number): Promise<void> {
    const kind = events[0]?.event
    if (kind === undefined) return
    for (const channel of cfg.channels) await this.sendTo(channel, payload, kind, cfg, now)
  }

  /**
   * One message to one channel — the consent's host checked (C6 rule 2), a pause kept (C1 rule 6), the secrets
   * read for this send alone, the result kept as the channel's `last` (C12). Never throws.
   */
  async sendTo(channel: ChannelKind, payload: NotificationPayload, event: NotifyEventKind | 'test', cfg: NotifyConfig, now: number): Promise<SendOutcome> {
    const consent = readConsents(this.deps.memento)[channel]
    if (consent === undefined) {
      this.deps.log.info(`Notify: ${channel} skipped — it is not set up; run Set Up`)
      return { ok: false, kind: 'notSetUp' }
    }
    const paused = loadNotifyState(this.deps.memento).last[channel]?.pausedUntil
    if (paused !== undefined && paused > now) {
      this.deps.log.debug(`Notify: ${channel} paused until ${new Date(paused).toISOString()} (429)`)
      return { ok: false, kind: 'paused', until: paused }
    }
    let result: SendResult | 'hostChanged'
    try {
      result = await this.sendChecked(channel, consent, payload, cfg)
    } catch {
      // The channels never throw; a secret storage that does is a local failure, not the host's.
      result = { ok: false, kind: 'config' }
    }
    if (result === 'hostChanged') {
      this.deps.log.info(`Notify: ${channel} skipped — its host changed since you allowed it; run Set Up again`)
      return { ok: false, kind: 'hostChanged' }
    }
    await this.remember(channel, event, result, now)
    if (result.ok) this.deps.log.debug(`Notify: ${event} sent to ${channel}`)
    else this.deps.log.info(`Notify: ${event} to ${channel} failed (${logWord(result)})`)
    return result
  }

  /**
   * The channel's send, or `hostChanged` when the consent's host is not the channel's host now (C6 rule 2): then
   * nothing is sent and no secret beyond the webhook's address — the one that holds its host — is read.
   */
  private async sendChecked(
    channel: ChannelKind,
    consent: ChannelConsent,
    payload: NotificationPayload,
    cfg: NotifyConfig,
  ): Promise<SendResult | 'hostChanged'> {
    const s = this.deps.secrets
    const opts = { version: this.deps.version }
    const config: SendResult = { ok: false, kind: 'config' }
    const skip = (): 'hostChanged' => 'hostChanged'
    switch (channel) {
      case 'webhook': {
        const url = await s.get(NOTIFY_SECRET_KEYS.webhookUrl)
        const u = url === undefined ? null : httpsOnly(url)
        if (url === undefined || u === null) return config
        if (u.host !== consent.host) return skip()
        const header = cfg.webhook.secretHeader
        const value = header === '' ? undefined : await s.get(NOTIFY_SECRET_KEYS.webhookSecret)
        const secret = header !== '' && value !== undefined && value !== '' ? { header, value } : null
        return sendWebhook(url, secret, cfg.webhook.format, payload, this.deps.fetch, opts)
      }
      case 'telegram': {
        if (TELEGRAM_API_HOST !== consent.host) return skip()
        const token = await s.get(NOTIFY_SECRET_KEYS.telegramBotToken)
        if (token === undefined) return config
        return sendTelegram(token, cfg.telegram.chatId, payload, this.deps.fetch, opts)
      }
      case 'ntfy': {
        const server = httpsOnly(cfg.ntfy.server)
        if (server === null) return config
        if (server.host !== consent.host) return skip()
        const topic = await s.get(NOTIFY_SECRET_KEYS.ntfyTopic)
        if (topic === undefined) return config
        const token = await s.get(NOTIFY_SECRET_KEYS.ntfyToken)
        return sendNtfy(cfg.ntfy.server, topic, token === undefined || token === '' ? null : token, payload, this.deps.fetch, opts)
      }
      default: {
        if (cfg.email.host === '') return config
        if (smtpHost(cfg) !== consent.host) return skip()
        const password = await s.get(NOTIFY_SECRET_KEYS.emailPassword)
        if (password === undefined) return config
        return sendMail(cfg.email, password, payload, this.deps.smtp)
      }
    }
  }

  /** C12: the channel's last result — its time, its event, ok or the kind with its status, a 429's pause. */
  private async remember(channel: ChannelKind, event: NotifyEventKind | 'test', r: SendResult, now: number): Promise<void> {
    const st = loadNotifyState(this.deps.memento)
    const last: ChannelLast = { at: now, event, ok: r.ok }
    if (!r.ok) {
      last.kind = r.kind
      if (typeof r.status === 'number') last.status = r.status
      if (typeof r.retryAfterSec === 'number' && r.retryAfterSec > 0) last.pausedUntil = now + r.retryAfterSec * 1000
    }
    st.last[channel] = last
    await saveNotifyState(this.deps.memento, st, now)
  }

  // -------------------------------------------------------------- what is set up

  /** Whether a secret is stored — by the keys where the storage lists them; a storage that fails holds none. */
  private async has(key: string): Promise<boolean> {
    const s = this.deps.secrets
    try {
      if (typeof s.keys === 'function') return (await s.keys()).includes(key)
      return (await s.get(key)) !== undefined
    } catch {
      return false
    }
  }

  /** C8 rule 3: the channels with a consent and their secret — listed in `channels` or not. */
  async setUpChannels(): Promise<ChannelKind[]> {
    const consents = readConsents(this.deps.memento)
    const out: ChannelKind[] = []
    for (const channel of NOTIFY_CHANNELS) {
      if (consents[channel] !== undefined && await this.has(REQUIRED_SECRET[channel])) out.push(channel)
    }
    return out
  }

  /** *Remove*'s list: a channel with a consent or any secret — a half-set-up one can be removed too. */
  private async presentChannels(): Promise<ChannelKind[]> {
    const consents = readConsents(this.deps.memento)
    const out: ChannelKind[] = []
    for (const channel of NOTIFY_CHANNELS) {
      let any = consents[channel] !== undefined
      for (const key of CHANNEL_SECRETS[channel]) if (!any && await this.has(key)) any = true
      if (any) out.push(channel)
    }
    return out
  }

  /** C9 rule 7: the API's answer in the test mode — `noChannel`, or the set-up channels. */
  async check(): Promise<string> {
    const ready = await this.setUpChannels()
    return ready.length === 0 ? 'noChannel' : ready.join(',')
  }

  // -------------------------------------------------------------- the commands (C8)

  /**
   * C8 rule 1, C6, C7: *Set Up a Notification Channel…* — the channel, its inputs, the consent naming its host,
   * then the secrets stored and the consent kept; no setting written (rule 2). *Never* or Escape stores nothing
   * and remembers nothing.
   */
  async setUp(): Promise<void> {
    const ui = this.deps.ui
    const cfg = this.deps.config()
    const item = await ui.pick(setupItems(), { placeHolder: t('Which channel should Token Pace send notifications to?') })
    if (item === undefined || this.disposed) return
    const choice = item.choice
    const plan = await this.inputsFor(choice, item.label, cfg)
    if (plan === null || this.disposed) return
    const allow = t('Allow')
    const never = t('Never')
    const answer = await ui.modal('info', t('Allow Token Pace to send notifications to {0}?', plan.host), consentDetail(plan.host), allow, never)
    if (answer !== allow || this.disposed) return
    const now = this.deps.clock()
    for (const [key, value] of Object.entries(plan.secrets)) await this.deps.secrets.store(key, value)
    // A secret kept for another host than the one just allowed is not kept for this one (§0a.8).
    for (const key of plan.deletes) await this.deps.secrets.delete(key)
    const consents = readConsents(this.deps.memento)
    consents[choice.channel] = { host: plan.host, at: now }
    await this.deps.memento.update(NOTIFY_CONSENT_KEY, consents)
    // A new setup starts the channel afresh: an old failure or pause was another address's.
    const st = loadNotifyState(this.deps.memento)
    if (st.last[choice.channel] !== undefined) {
      delete st.last[choice.channel]
      await saveNotifyState(this.deps.memento, st, now)
    }
    this.deps.log.info(`Notify: ${choice.channel} set up — its secrets are in VS Code's secret storage, its host allowed`)
    const open = t('Open Settings')
    const format = choice.channel === 'webhook' && choice.format !== cfg.webhook.format ? choice.format : null
    const done = format === null
      ? t('Notifications: {0} is set up. To use it, add "{1}" to tokenPace.notifications.channels.', item.label, choice.channel)
      : t('Notifications: {0} is set up. To use it, add "{1}" to tokenPace.notifications.channels and set the format in tokenPace.notifications.webhook to "{2}".', item.label, choice.channel, format)
    const pick = await ui.info(done, open)
    if (pick === open && !this.disposed) await ui.openSettings('@id:tokenPace.notifications.channels')
  }

  /** A setup check (C13): what is missing in the settings, with *Open Settings* at that key. */
  private async missing(message: string, key: string): Promise<null> {
    const open = t('Open Settings')
    const pick = await this.deps.ui.info(message, open)
    if (pick === open && !this.disposed) await this.deps.ui.openSettings(`@id:${key}`)
    return null
  }

  /**
   * C7: one box per secret, `password` and `ignoreFocusOut`, never pre-filled — "Leave empty to keep the stored
   * one" where one is stored for the host this setup allows; a validation message never echoes the value. Null when
   * the reader went away, a setting the channel needs is missing, or nothing would be stored for a secret the channel
   * cannot do without.
   *
   * Review 3 F1, F2 (§0a.8, C6): a stored secret is bound to the host its consent named. Where this setup allows
   * another host — the webhook's address, the ntfy server or the SMTP server with its port changed, or no consent
   * stands — a secret of the old one is never offered to keep: the box shows no "keep", an empty answer to a
   * secret the channel can do without deletes it on *Allow*, and one it cannot do without must be typed again. A
   * preset never keeps the generic webhook's header value (it asks for none).
   */
  private async inputsFor(choice: SetupChoice, title: string, cfg: NotifyConfig): Promise<SetupPlan | null> {
    const ui = this.deps.ui
    const s = this.deps.secrets
    const keep = t('Leave empty to keep the stored one.')
    const box = (prompt: string, stored: boolean, validateInput?: (v: string) => string | undefined): PromiseLike<string | undefined> =>
      ui.input({ title, prompt, placeHolder: stored ? keep : undefined, password: true, ignoreFocusOut: true, validateInput })
    const consented = readConsents(this.deps.memento)[choice.channel]?.host
    const secrets: Record<string, string> = {}
    const deletes: string[] = []
    /** A secret that may stay only for the host allowed before: deleted on *Allow* when it is stored and not typed. */
    const dropUnlessTyped = async (key: string): Promise<void> => {
      if (secrets[key] === undefined && await this.has(key)) deletes.push(key)
    }
    switch (choice.channel) {
      case 'webhook': {
        const stored = await s.get(NOTIFY_SECRET_KEYS.webhookUrl)
        const storedOk = stored !== undefined && httpsOnly(stored) !== null
        let prompt = t('The webhook\'s address (it begins with https://). It is kept in VS Code\'s secret storage, never in settings.json.')
        if (choice.format === 'generic' && cfg.webhook.secretHeader === '') {
          prompt = `${prompt} ${t('Name the header in tokenPace.notifications.webhook\'s secretHeader first, if your address expects a secret.')}`
        }
        const typed = await box(prompt, storedOk, (v) => ((v.trim() === '' && storedOk) || httpsOnly(v) !== null
          ? undefined
          : t('Only an https:// address without a user name or password in it is accepted.')))
        if (typed === undefined) return null
        const url = typed.trim() === '' ? stored : typed.trim()
        const u = url === undefined ? null : httpsOnly(url)
        if (u === null) return null
        if (typed.trim() !== '') secrets[NOTIFY_SECRET_KEYS.webhookUrl] = typed.trim()
        const sameHost = consented !== undefined && u.host === consented
        // C7: the header's value only when the reader named a header; a preset asks only the address (C8 rule 1).
        if (choice.format === 'generic' && cfg.webhook.secretHeader !== '') {
          const value = await box(t('The value of the header {0}. It is kept in VS Code\'s secret storage.', cfg.webhook.secretHeader),
            sameHost && await this.has(NOTIFY_SECRET_KEYS.webhookSecret))
          if (value === undefined) return null
          if (value.trim() !== '') secrets[NOTIFY_SECRET_KEYS.webhookSecret] = value.trim()
        }
        // F1: a preset never keeps the header value; another host keeps it only when it was typed in this setup.
        if (choice.format !== 'generic' || !sameHost) await dropUnlessTyped(NOTIFY_SECRET_KEYS.webhookSecret)
        return { host: u.host, secrets, deletes }
      }
      case 'telegram': {
        if (cfg.telegram.chatId === '') {
          return this.missing(t('Set the chat in tokenPace.notifications.telegram first — the bot\'s token alone does not say where to send.'), 'tokenPace.notifications.telegram')
        }
        // Telegram's host is fixed: its token is bound to api.telegram.org whatever the settings say.
        const stored = await this.has(NOTIFY_SECRET_KEYS.telegramBotToken)
        const token = await box(t('The Telegram bot\'s token (from @BotFather). It is kept in VS Code\'s secret storage.'), stored)
        if (token === undefined || (token.trim() === '' && !stored)) return null
        if (token.trim() !== '') secrets[NOTIFY_SECRET_KEYS.telegramBotToken] = token.trim()
        return { host: TELEGRAM_API_HOST, secrets, deletes }
      }
      case 'ntfy': {
        const server = httpsOnly(cfg.ntfy.server)
        if (server === null) return this.missing(t('Set the server in tokenPace.notifications.ntfy first.'), 'tokenPace.notifications.ntfy')
        // F2: the topic and the token are the server's they were allowed for; another server asks both afresh.
        const sameHost = consented !== undefined && server.host === consented
        const stored = sameHost && await this.has(NOTIFY_SECRET_KEYS.ntfyTopic)
        const topic = await box(t('The ntfy topic. Anyone who knows it can read its messages, so it is kept in VS Code\'s secret storage.'), stored)
        if (topic === undefined || (topic.trim() === '' && !stored)) return null
        if (topic.trim() !== '') secrets[NOTIFY_SECRET_KEYS.ntfyTopic] = topic.trim()
        const token = await box(t('An access token for the ntfy server, if it needs one — leave empty otherwise.'),
          sameHost && await this.has(NOTIFY_SECRET_KEYS.ntfyToken))
        if (token === undefined) return null
        if (token.trim() !== '') secrets[NOTIFY_SECRET_KEYS.ntfyToken] = token.trim()
        if (!sameHost) await dropUnlessTyped(NOTIFY_SECRET_KEYS.ntfyToken)
        return { host: server.host, secrets, deletes }
      }
      default: {
        const e = cfg.email
        if (e.host === '' || e.user === '' || e.from === '' || e.to === '') {
          return this.missing(t('Set host, user, from and to in tokenPace.notifications.email first.'), 'tokenPace.notifications.email')
        }
        // F2: the password is the server's it was allowed for — host and port; another one asks it afresh.
        const host = smtpHost(cfg)
        const stored = consented !== undefined && host === consented && await this.has(NOTIFY_SECRET_KEYS.emailPassword)
        const password = await box(t('The password or app password of {0} on the SMTP server. It is kept in VS Code\'s secret storage.', e.user), stored)
        // A password is taken as typed: spaces may belong to it.
        if (password === undefined || (password === '' && !stored)) return null
        if (password !== '') secrets[NOTIFY_SECRET_KEYS.emailPassword] = password
        return { host, secrets, deletes }
      }
    }
  }

  /**
   * C8 rule 3: *Send a Test Notification…* — a pick of the set-up channels, the test message to the one chosen,
   * and the answer: it went, or it failed with a fixed word.
   */
  async sendTest(): Promise<void> {
    const ui = this.deps.ui
    const cfg = this.deps.config()
    const ready = await this.setUpChannels()
    if (ready.length === 0) {
      await ui.info(t('No notification channel is set up yet. Run "Token Pace: Set Up a Notification Channel…" first.'))
      return
    }
    const item = await ui.pick(this.itemsOf(ready, cfg), { placeHolder: t('Which channel should get the test message?') })
    if (item === undefined || this.disposed) return
    const channel = item.channel
    const now = this.deps.clock()
    const before = this.lastTest.get(channel)
    if (before !== undefined && now >= before && now - before < TEST_MIN_GAP_MS) {
      this.deps.log.info(`Notify: a test message to ${channel} went less than 10 s ago — this one is not sent`)
      // Review 3 F8: the reader asked, so the command answers — it does not end in silence.
      await ui.info(t('Notifications: a test message to {0} went out less than ten seconds ago — try again in a moment.', item.label))
      return
    }
    this.lastTest.set(channel, now)
    const r = await this.sendTo(channel, testPayload({ tcfg: this.deps.timeConfig(), now }), 'test', cfg, now)
    if (this.disposed) return
    await ui.info(r.ok
      ? t('Notifications: the test message went to {0}.', item.label)
      : t('Notifications: the test message to {0} failed ({1}).', item.label, failureWord(r)))
  }

  /** C8 rule 4, C6 rule 3: *Remove a Notification Channel…* — its secrets, its consent and its last result. */
  async remove(): Promise<void> {
    const ui = this.deps.ui
    const cfg = this.deps.config()
    const present = await this.presentChannels()
    if (present.length === 0) {
      await ui.info(t('No notification channel is set up yet. Run "Token Pace: Set Up a Notification Channel…" first.'))
      return
    }
    const item = await ui.pick(this.itemsOf(present, cfg), { placeHolder: t('Which channel should Token Pace remove?') })
    if (item === undefined || this.disposed) return
    const removeLabel = t('Remove')
    const sure = await ui.modal('warning', t('Remove {0}? Its secrets and your consent are deleted, and nothing is sent to it any more.', item.label), undefined, removeLabel)
    if (sure !== removeLabel || this.disposed) return
    await this.forget(item.channel)
    this.deps.log.info(`Notify: ${item.channel} removed — its secrets, its consent and its last result are gone`)
    await ui.info(t('Notifications: {0} was removed — its secrets and its consent are gone.', item.label))
  }

  private itemsOf(channels: readonly ChannelKind[], cfg: NotifyConfig): ChannelItem[] {
    return channels.map((channel) => ({ label: channelName(channel, cfg.webhook.format), description: channel, channel }))
  }

  /** One channel's secrets, consent and last result deleted. */
  private async forget(channel: ChannelKind): Promise<void> {
    for (const key of CHANNEL_SECRETS[channel]) await this.deps.secrets.delete(key)
    const consents = readConsents(this.deps.memento)
    if (consents[channel] !== undefined) {
      delete consents[channel]
      await this.deps.memento.update(NOTIFY_CONSENT_KEY, Object.keys(consents).length === 0 ? undefined : consents)
    }
    const st = loadNotifyState(this.deps.memento)
    if (st.last[channel] !== undefined) {
      delete st.last[channel]
      await saveNotifyState(this.deps.memento, st, this.deps.clock())
    }
    this.lastTest.delete(channel)
  }

  // -------------------------------------------------------------- Clear Stored Data (C9 rule 5)

  /** *Clear Stored Data…*'s line under the item: how many channels are set up. */
  async setUpCount(): Promise<number> {
    return (await this.setUpChannels()).length
  }

  /**
   * C9 rule 5, §0a.11: after *Clear Stored Data…*'s confirmation — the six secrets, the consents and the state,
   * and what this window keeps in memory of them.
   */
  async forgetAll(): Promise<void> {
    for (const key of NOTIFY_SECRET_KEY_LIST) await this.deps.secrets.delete(key)
    await this.deps.memento.update(NOTIFY_CONSENT_KEY, undefined)
    await this.deps.memento.update(NOTIFY_STATE_KEY, undefined)
    this.tables = newNotifyTables()
    this.lastTest.clear()
  }

  // -------------------------------------------------------------- the diagnostics (C12)

  /**
   * C12: per channel whether it is listed, whether its secret is set, whether its consent stands, its last result
   * and a pause — names, words and ages; never a host, an address, a chat id, a URL or a topic. The secrets are not
   * read: only which keys exist.
   */
  async diagnostics(cfg: NotifyConfig, now: number): Promise<NotificationsDiag> {
    let keys: readonly string[] | null = null
    try {
      keys = typeof this.deps.secrets.keys === 'function' ? await this.deps.secrets.keys() : null
    } catch {
      keys = null
    }
    const consents = readConsents(this.deps.memento)
    const st = loadNotifyState(this.deps.memento)
    const channels: NotifyChannelDiag[] = NOTIFY_CHANNELS.map((channel) => {
      const consent = consents[channel]
      const now_ = currentHost(channel, cfg)
      const last = st.last[channel]
      return {
        channel,
        format: channel === 'webhook' ? cfg.webhook.format : null,
        listed: cfg.channels.includes(channel),
        secret: keys === null ? 'unknown' : keys.includes(REQUIRED_SECRET[channel]) ? 'set' : 'notSet',
        // The webhook's host is in its stored address, which only *Set Up* changes — and that asks again.
        consent: consent === undefined ? 'no' : now_ === undefined || now_ === consent.host ? 'yes' : 'hostChanged',
        last: last === undefined ? null : {
          event: last.event,
          ageSec: Math.max(0, (now - last.at) / 1000),
          ok: last.ok,
          kind: last.kind ?? null,
          status: last.status ?? null,
        },
        pausedUntil: last?.pausedUntil !== undefined && last.pausedUntil > now ? last.pausedUntil : null,
      }
    })
    const inHour = now >= st.hour.start && now - st.hour.start < 3_600_000
    return { channels, events: [...cfg.events], sentThisHour: inHour ? st.hour.count : 0, hourlyCap: NOTIFY_HOURLY_CAP }
  }

  dispose(): void {
    this.disposed = true
    if (this.timer !== null) (this.deps.clearTimer ?? ((h: unknown) => clearTimeout(h as ReturnType<typeof setTimeout>)))(this.timer)
    this.timer = null
  }
}

/** C6 rule 1: the SMTP server as its consent names it — the host with its port. */
function smtpHost(cfg: NotifyConfig): string {
  return `${cfg.email.host}:${cfg.email.port}`
}

/**
 * The host a channel's settings name now, for the diagnostics' consent — undefined for the webhook, whose host is
 * in its stored address (read only by a send and by *Set Up*), and null where the settings name none.
 */
function currentHost(channel: ChannelKind, cfg: NotifyConfig): string | null | undefined {
  switch (channel) {
    case 'webhook': return undefined
    case 'telegram': return TELEGRAM_API_HOST
    case 'ntfy': return httpsOnly(cfg.ntfy.server)?.host ?? null
    default: return cfg.email.host === '' ? null : smtpHost(cfg)
  }
}

/** What extension.ts hands the factory: the context's secret storage and its global state. */
export interface NotifyContextLike {
  readonly secrets: SecretStorageLike
  readonly globalState: MementoLike
}

/**
 * The host as the extension builds it (C9 rule 1): the context's secret storage and global state, VS Code's
 * questions and the settings UI. `vscode` is required here, lazily, so the module stays loadable in a plain test.
 */
export function notifyHostFor(
  context: NotifyContextLike,
  deps: Omit<NotifyHostDeps, 'secrets' | 'memento' | 'ui'>,
): NotifyHost {
  return new NotifyHost({ ...deps, secrets: context.secrets, memento: context.globalState, ui: vscodeNotifyUi() })
}

function vscodeNotifyUi(): NotifyUi {
  const vscode = require('vscode') as typeof import('vscode')
  return {
    pick: (items, options) => vscode.window.showQuickPick([...items], { placeHolder: options.placeHolder, ignoreFocusOut: true }),
    input: (options) => vscode.window.showInputBox(options),
    modal: (kind, message, detail, ...buttons) => (kind === 'warning'
      ? vscode.window.showWarningMessage(message, { modal: true, detail }, ...buttons)
      : vscode.window.showInformationMessage(message, { modal: true, detail }, ...buttons)),
    info: (message, ...buttons) => vscode.window.showInformationMessage(message, ...buttons),
    openSettings: (query) => vscode.commands.executeCommand('workbench.action.openSettings', query),
  }
}
