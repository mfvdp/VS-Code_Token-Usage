// SPDX-FileCopyrightText: 2026 Frederik Marx
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * 1.12 C6–C9, C12, §0a.8, §0a.9, §0a.11 (P9): the notifications' host — the setup and its consent per channel naming
 * the host, the secrets in (a fake of) VS Code's secret storage and nowhere else, *Send a Test* and *Remove*, a changed
 * host that skips a send, the evaluation that does nothing while no channel is listed, the trailing throttle, *Clear
 * Stored Data*'s part, the diagnostics' channel lines, and the leak test over the channels' synthetic secrets (C14
 * items 6, 9, 10). No vscode, no network: the secrets, the memento, the UI, the fetch and the SMTP transport are fakes;
 * the SMTP server is test/helpers/fakeSmtp.ts's in-memory script.
 */

import { strict as assert } from 'node:assert'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { NotifyConfig, readNotifyConfig } from '../src/config'
import { buildDiagnostics, DiagnosticsInput } from '../src/diagnostics'
import { setBundle, setLocale } from '../src/i18n'
import {
  loadNotifyState, NOTIFY_STATE_KEY, NotificationEvent, NotifyInput, payloadOf,
} from '../src/notify'
import { FetchInit, FetchLike, FetchResponseLike, TELEGRAM_API_HOST } from '../src/notifyChannels'
import {
  channelName, consentDetail, failureWord, NOTIFY_CONSENT_KEY, NOTIFY_EVAL_MIN_MS, NOTIFY_SECRET_KEY_LIST, NOTIFY_SECRET_KEYS, NotifyHost,
  NotifyHostDeps, NotifyPickItem, NotifyUi, readConsents, SecretStorageLike, TEST_MIN_GAP_MS,
} from '../src/notifyHost'
import { MementoLike } from '../src/storage'
import { TimeConfig } from '../src/time'
import { QuotaState, QuotaWindow } from '../src/types'
import { fakeSmtp, FakeSmtp } from './helpers/fakeSmtp'
import { ROOT } from './helpers/nls'

const NOW = Date.UTC(2026, 8, 27, 12, 0)
const SEC = 1000
const MIN = 60 * SEC
const HOUR = 60 * MIN
const TCFG: TimeConfig = { zone: 'utc', dayBoundaryHour: 0, startOfWeek: 'monday', hourCycle: 'h23' }

/** §0a.8's four synthetic secrets, and the two the channels have beside them (the webhook's header, the ntfy token). */
const HOOK_URL = 'https://hooks.example.invalid:8443/services/synthetic-url-secret-123'
const HOOK_SECRET = 'synthetic-header-secret-321'
const BOT_TOKEN = '123456:synthetic-bot-token-456'
const TOPIC = 'synthetic-topic-789'
const NTFY_TOKEN = 'synthetic-ntfy-token-654'
const PASSWORD = 'synthetic-password-000'
const SECRETS = [HOOK_URL, 'synthetic-url-secret-123', HOOK_SECRET, BOT_TOKEN, 'synthetic-bot-token-456', TOPIC, NTFY_TOKEN, PASSWORD]
/** The settings' host, account, addresses, chat id and server — never in the diagnostics (Review 2 F1). */
const SMTP_HOST = 'smtp.synthetic-host.example'
const NTFY_SERVER = 'https://ntfy.synthetic-host.example'
const CHAT_ID = '-1009876543210'
const USER = 'synthetic-user@example.invalid'
const FROM = 'synthetic-from@example.invalid'
const TO = 'synthetic-to@example.invalid'
const ADDRESSES = [SMTP_HOST, 'ntfy.synthetic-host.example', 'hooks.example.invalid', CHAT_ID, USER, FROM, TO]

/** Records every call, so "no state read" and "persist before send" are observable. */
class FakeMemento implements MementoLike {
  store = new Map<string, unknown>()
  calls: string[] = []
  get<T>(key: string, defaultValue: T): T {
    this.calls.push(`get:${key}`)
    return this.store.has(key) ? structuredClone(this.store.get(key)) as T : defaultValue
  }
  update(key: string, value: unknown): PromiseLike<void> {
    this.calls.push(`update:${key}`)
    if (value === undefined) this.store.delete(key)
    else this.store.set(key, structuredClone(value))
    return Promise.resolve()
  }
}

/** VS Code's secret storage in memory: `map` the values, `calls` every call in order ("no secret read" looks there). */
class FakeSecrets implements SecretStorageLike {
  readonly map = new Map<string, string>()
  readonly calls: string[] = []
  constructor(initial: Record<string, string> = {}) {
    for (const [k, v] of Object.entries(initial)) this.map.set(k, v)
  }
  get(key: string): Promise<string | undefined> { this.calls.push(`get:${key}`); return Promise.resolve(this.map.get(key)) }
  store(key: string, value: string): Promise<void> { this.calls.push(`store:${key}`); this.map.set(key, value); return Promise.resolve() }
  delete(key: string): Promise<void> { this.calls.push(`delete:${key}`); this.map.delete(key); return Promise.resolve() }
  keys(): Promise<string[]> { this.calls.push('keys'); return Promise.resolve([...this.map.keys()]) }
}
const mapOf = (s: FakeSecrets): Map<string, string> => s.map

/** A scripted UI: each question takes the next answer of its queue and is recorded with what it showed. */
interface Asked { kind: 'pick' | 'input' | 'modal' | 'info'; text: string; detail?: string; buttons?: string[]; options?: Record<string, unknown>; items?: string[] }
class FakeUi implements NotifyUi {
  asked: Asked[] = []
  picks: Array<string | undefined> = []
  inputs: Array<string | undefined> = []
  modals: Array<string | undefined> = []
  infos: Array<string | undefined> = []
  settings: string[] = []
  pick<T extends NotifyPickItem>(items: readonly T[], options: { placeHolder: string }): Promise<T | undefined> {
    this.asked.push({ kind: 'pick', text: options.placeHolder, items: items.map((i) => i.label) })
    const want = this.picks.shift()
    return Promise.resolve(want === undefined ? undefined : items.find((i) => i.label === want))
  }
  input(options: Parameters<NotifyUi['input']>[0]): Promise<string | undefined> {
    this.asked.push({ kind: 'input', text: options.prompt, options: { ...options } })
    const v = this.inputs.shift()
    if (v !== undefined && options.validateInput?.(v) !== undefined) throw new Error(`the box refused ${JSON.stringify(v)}: ${options.validateInput(v)}`)
    return Promise.resolve(v)
  }
  modal(kind: 'info' | 'warning', message: string, detail: string | undefined, ...buttons: string[]): Promise<string | undefined> {
    this.asked.push({ kind: 'modal', text: message, detail, buttons, options: { kind } })
    return Promise.resolve(this.modals.shift())
  }
  info(message: string, ...buttons: string[]): Promise<string | undefined> {
    this.asked.push({ kind: 'info', text: message, buttons })
    return Promise.resolve(this.infos.shift())
  }
  openSettings(query: string): Promise<unknown> {
    this.settings.push(query)
    return Promise.resolve(undefined)
  }
  texts(): string {
    return this.asked.map((a) => [a.text, a.detail ?? '', ...(a.buttons ?? []), ...(a.items ?? [])].join('\n')).join('\n')
  }
}

/** A fetch that records what it is handed and answers with the next status (200 unless a test queues one). */
function fetchSpy(): { fetch: FetchLike; calls: Array<{ url: string; init: FetchInit }>; statuses: Array<{ status: number; retryAfter?: string }> } {
  const calls: Array<{ url: string; init: FetchInit }> = []
  const statuses: Array<{ status: number; retryAfter?: string }> = []
  const fetch: FetchLike = async (url, init) => {
    calls.push({ url, init })
    const next = statuses.shift() ?? { status: 200 }
    const res: FetchResponseLike = {
      status: next.status,
      headers: { get: (n) => (n.toLowerCase() === 'retry-after' ? next.retryAfter ?? null : null) },
      body: { cancel: () => Promise.resolve() },
    }
    return res
  }
  return { fetch, calls, statuses }
}

/** The reader's settings through the product's own sanitiser. */
function cfgOf(over: Record<string, unknown> = {}): NotifyConfig {
  const raw: Record<string, unknown> = {
    'tokenPace.notifications.channels': [],
    'tokenPace.notifications.events': ['agentWaiting', 'agentDone', 'quotaThreshold', 'quotaExhausted', 'quotaReset', 'paceWarning'],
    'tokenPace.notifications.telegram': { chatId: CHAT_ID },
    'tokenPace.notifications.ntfy': { server: NTFY_SERVER },
    'tokenPace.notifications.email': { host: SMTP_HOST, port: 587, security: 'starttls', user: USER, from: FROM, to: TO },
    ...over,
  }
  return readNotifyConfig((k) => raw[k])
}

interface World {
  host: NotifyHost
  ui: FakeUi
  secrets: FakeSecrets
  memento: FakeMemento
  spy: ReturnType<typeof fetchSpy>
  smtp: FakeSmtp
  log: string[]
  debug: string[]
  cfg: { now: NotifyConfig }
  clock: { now: number }
  timers: Array<{ fn: () => void; ms: number; cleared: boolean }>
  input: { now: NotifyInput }
}

function world(opts: { secrets?: Record<string, string>; cfg?: Record<string, unknown>; smtpAuth?: number; input?: Partial<NotifyInput> } = {}): World {
  const ui = new FakeUi()
  const secrets = new FakeSecrets(opts.secrets)
  const memento = new FakeMemento()
  const spy = fetchSpy()
  const smtp = fakeSmtp({ auth: opts.smtpAuth })
  const log: string[] = []
  const debug: string[] = []
  const cfg = { now: cfgOf(opts.cfg) }
  const clock = { now: NOW }
  const timers: World['timers'] = []
  const input = { now: inputOf(opts.input) }
  const deps: NotifyHostDeps = {
    secrets, memento, ui, fetch: spy.fetch, smtp: smtp.transport,
    log: { info: (m) => log.push(m), debug: (m) => debug.push(m) },
    clock: () => clock.now,
    config: () => cfg.now,
    timeConfig: () => TCFG,
    input: () => input.now,
    version: '1.12.0',
    setTimer: (fn, ms) => { const t = { fn, ms, cleared: false }; timers.push(t); return t },
    clearTimer: (h) => { (h as { cleared: boolean }).cleared = true },
  }
  return { host: new NotifyHost(deps), ui, secrets, memento, spy, smtp, log, debug, cfg, clock, timers, input }
}

function inputOf(over: Partial<NotifyInput> = {}): NotifyInput {
  return { states: [], forecasts: new Map(), mains: [], hooks: [], focused: false, settled: true, role: 'leader', staleAfterMs: 20 * MIN, ...over }
}

function win(over: Partial<QuotaWindow> = {}): QuotaWindow {
  return {
    id: 'session:300', kind: 'session', label: '5 h', shortLabel: '5h', model: null, percent: 82,
    resetsAt: NOW + 2 * HOUR, windowMinutes: 300, limitReached: false, unlimited: false, ...over,
  }
}

function reading(windows: QuotaWindow[]): QuotaState {
  return { source: 'claude', ok: true, origin: 'poll', fetchedAt: Math.floor((NOW - MIN) / 1000), planType: 'synthetic-plan', windows }
}

/** A consent as *Set Up* keeps it. */
function consented(memento: FakeMemento, channels: Record<string, string>): void {
  const all: Record<string, { host: string; at: number }> = {}
  for (const [ch, host] of Object.entries(channels)) all[ch] = { host, at: NOW - HOUR }
  memento.store.set(NOTIFY_CONSENT_KEY, all)
}

/** Every channel set up with its synthetic secrets and its consent. */
function allSetUp(w: World): void {
  const m = mapOf(w.secrets)
  m.set(NOTIFY_SECRET_KEYS.webhookUrl, HOOK_URL)
  m.set(NOTIFY_SECRET_KEYS.webhookSecret, HOOK_SECRET)
  m.set(NOTIFY_SECRET_KEYS.telegramBotToken, BOT_TOKEN)
  m.set(NOTIFY_SECRET_KEYS.ntfyTopic, TOPIC)
  m.set(NOTIFY_SECRET_KEYS.ntfyToken, NTFY_TOKEN)
  m.set(NOTIFY_SECRET_KEYS.emailPassword, PASSWORD)
  consented(w.memento, {
    webhook: 'hooks.example.invalid:8443', telegram: TELEGRAM_API_HOST, ntfy: 'ntfy.synthetic-host.example', email: `${SMTP_HOST}:587`,
  })
}

const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))

function withGerman(fn: () => Promise<void>): Promise<void> {
  setBundle(JSON.parse(readFileSync(join(ROOT, 'l10n', 'bundle.l10n.de.json'), 'utf8')) as Record<string, string>)
  setLocale('de')
  return fn().finally(() => { setBundle(null); setLocale('en') })
}

// ---------------------------------------------------------------------------
// Set Up (C6, C7, C8 rules 1–2)
// ---------------------------------------------------------------------------

test('Set Up stores only after Allow: ntfy — the server from the setting, the topic and the token in password boxes that keep the focus, the consent naming the server\'s host with its four paragraphs, then both secrets and { host, at }; the answer names the channel id, Open Settings goes to channels, and no setting is written (1.12 C6 rule 1, C7, C8 rules 1–2, C14 item 6)', async () => {
  const w = world()
  w.ui.picks.push('ntfy')
  w.ui.inputs.push(TOPIC, NTFY_TOKEN)
  w.ui.modals.push('Allow')
  w.ui.infos.push('Open Settings')
  // Nothing is stored before the consent: the store is checked at the moment the modal is asked.
  const modal = w.ui.modal.bind(w.ui)
  w.ui.modal = async (...args) => {
    assert.equal(mapOf(w.secrets).size, 0, 'a secret was stored before the consent')
    assert.equal(w.memento.store.has(NOTIFY_CONSENT_KEY), false, 'the consent was kept before it was given')
    return modal(...args)
  }
  await w.host.setUp()
  const [pick, topicBox, tokenBox, consent, done] = w.ui.asked
  assert.deepEqual(pick.items, ['Webhook (JSON)', 'Slack', 'Discord', 'Microsoft Teams', 'Mattermost', 'Rocket.Chat', 'Telegram', 'ntfy', 'E-mail (SMTP)'])
  assert.equal(pick.text, 'Which channel should Token Pace send notifications to?')
  assert.equal(topicBox.text, 'The ntfy topic. Anyone who knows it can read its messages, so it is kept in VS Code\'s secret storage.')
  assert.equal(tokenBox.text, 'An access token for the ntfy server, if it needs one — leave empty otherwise.')
  for (const box of [topicBox, tokenBox]) {
    assert.equal(box.options?.password, true)
    assert.equal(box.options?.ignoreFocusOut, true)
    // Never pre-filled, and nothing stored yet: no "keep" placeholder either.
    assert.equal(box.options?.value, undefined)
    assert.equal(box.options?.placeHolder, undefined)
  }
  assert.equal(consent.text, 'Allow Token Pace to send notifications to ntfy.synthetic-host.example?')
  assert.equal(consent.detail, consentDetail('ntfy.synthetic-host.example'))
  assert.deepEqual(consent.buttons, ['Allow', 'Never'])
  assert.deepEqual(consent.options, { kind: 'info' })
  const paragraphs = consent.detail!.split('\n\n')
  assert.equal(paragraphs.length, 4)
  assert.ok(paragraphs[0].startsWith('Token Pace will send a short message to ntfy.synthetic-host.example over an encrypted connection'))
  assert.ok(paragraphs[2].includes('Token Pace reads nothing back from ntfy.synthetic-host.example except whether it accepted the message.'))
  assert.equal(paragraphs[3], 'You can take this back with "Token Pace: Remove a Notification Channel…".')
  assert.deepEqual([...mapOf(w.secrets)], [[NOTIFY_SECRET_KEYS.ntfyTopic, TOPIC], [NOTIFY_SECRET_KEYS.ntfyToken, NTFY_TOKEN]])
  assert.deepEqual(readConsents(w.memento), { ntfy: { host: 'ntfy.synthetic-host.example', at: NOW } })
  assert.equal(done.text, 'Notifications: ntfy is set up. To use it, add "ntfy" to tokenPace.notifications.channels.')
  assert.deepEqual(done.buttons, ['Open Settings'])
  assert.deepEqual(w.ui.settings, ['@id:tokenPace.notifications.channels'])
  // Nothing was sent, and the memento holds the consent alone (no settings API exists on the host at all).
  assert.equal(w.spy.calls.length, 0)
  assert.deepEqual([...w.memento.store.keys()], [NOTIFY_CONSENT_KEY])
  assert.ok(w.log.some((l) => l === 'Notify: ntfy set up — its secrets are in VS Code\'s secret storage, its host allowed'))
})

test('Never or Escape at the consent stores nothing and remembers nothing; Escape at a box asks no consent (1.12 C6 rule 1, C14 item 6)', async () => {
  for (const answer of ['Never', undefined]) {
    const w = world()
    w.ui.picks.push('E-mail (SMTP)')
    w.ui.inputs.push(PASSWORD)
    w.ui.modals.push(answer)
    await w.host.setUp()
    assert.equal(w.ui.asked.filter((a) => a.kind === 'modal').length, 1)
    assert.equal(mapOf(w.secrets).size, 0, `${answer}: a secret was stored`)
    assert.equal(w.memento.store.size, 0, `${answer}: something was remembered`)
    assert.equal(w.ui.asked.some((a) => a.kind === 'info'), false, `${answer}: an answer was shown`)
  }
  const w = world()
  w.ui.picks.push('Telegram')
  w.ui.inputs.push(undefined)
  await w.host.setUp()
  assert.equal(w.ui.asked.some((a) => a.kind === 'modal'), false)
  assert.equal(mapOf(w.secrets).size + w.memento.store.size, 0)
})

test('the consent names the channel\'s host: the webhook address\'s with its port, Telegram\'s fixed one, the SMTP server with its port — and a preset asks only the address (1.12 C6 rule 1, C8 rule 1)', async () => {
  const cases: Array<[string, string[], string, Record<string, string>]> = [
    ['Slack', [HOOK_URL], 'hooks.example.invalid:8443', { [NOTIFY_SECRET_KEYS.webhookUrl]: HOOK_URL }],
    ['Telegram', [BOT_TOKEN], TELEGRAM_API_HOST, { [NOTIFY_SECRET_KEYS.telegramBotToken]: BOT_TOKEN }],
    ['E-mail (SMTP)', [PASSWORD], `${SMTP_HOST}:587`, { [NOTIFY_SECRET_KEYS.emailPassword]: PASSWORD }],
  ]
  for (const [label, typed, host, stored] of cases) {
    const w = world({ cfg: { 'tokenPace.notifications.webhook': { format: 'generic', secretHeader: 'X-Token' } } })
    w.ui.picks.push(label)
    w.ui.inputs.push(...typed)
    w.ui.modals.push('Allow')
    await w.host.setUp()
    // A preset asks the address alone, whatever secretHeader names (C8 rule 1).
    assert.equal(w.ui.asked.filter((a) => a.kind === 'input').length, 1, label)
    assert.equal(w.ui.asked.find((a) => a.kind === 'modal')?.text, `Allow Token Pace to send notifications to ${host}?`, label)
    assert.deepEqual(Object.fromEntries(mapOf(w.secrets)), stored, label)
  }
  assert.equal(TELEGRAM_API_HOST, 'api.telegram.org')
  // The e-mail box names the account it asks the password of.
  const w = world()
  w.ui.picks.push('E-mail (SMTP)')
  await w.host.setUp()
  assert.equal(w.ui.asked[1].text, `The password or app password of ${USER} on the SMTP server. It is kept in VS Code's secret storage.`)
})

test('the setup checks: Telegram without a chat, ntfy without a server, e-mail without host, user, from or to — the check with Open Settings at its key, no box, nothing stored (1.12 C13)', async () => {
  const cases: Array<[string, Record<string, unknown>, string, string]> = [
    ['Telegram', { 'tokenPace.notifications.telegram': { chatId: '' } },
      'Set the chat in tokenPace.notifications.telegram first — the bot\'s token alone does not say where to send.', '@id:tokenPace.notifications.telegram'],
    ['ntfy', { 'tokenPace.notifications.ntfy': { server: 'http://ntfy.synthetic-host.example' } },
      'Set the server in tokenPace.notifications.ntfy first.', '@id:tokenPace.notifications.ntfy'],
    ['E-mail (SMTP)', { 'tokenPace.notifications.email': { host: SMTP_HOST, port: 587, security: 'starttls', user: USER, from: FROM, to: '' } },
      'Set host, user, from and to in tokenPace.notifications.email first.', '@id:tokenPace.notifications.email'],
  ]
  for (const [label, cfg, text, query] of cases) {
    const w = world({ cfg })
    w.ui.picks.push(label)
    w.ui.infos.push('Open Settings')
    await w.host.setUp()
    assert.deepEqual(w.ui.asked.map((a) => a.kind), ['pick', 'info'], label)
    assert.equal(w.ui.asked[1].text, text)
    assert.deepEqual(w.ui.settings, [query])
    assert.equal(mapOf(w.secrets).size + w.memento.store.size, 0)
  }
})

test('the webhook: the address box refuses http and an address with credentials in words that never echo the value; a named header asks its value, none says how to name one; a stored address is kept by an empty answer; a preset whose format differs says to set it (1.12 C7, C8 rule 1, C13)', async () => {
  // Without a header: the address box explains how to name one; the validation.
  const w = world()
  w.ui.picks.push('Webhook (JSON)')
  w.ui.inputs.push(HOOK_URL)
  w.ui.modals.push('Allow')
  await w.host.setUp()
  const box = w.ui.asked[1]
  assert.equal(box.text, 'The webhook\'s address (it begins with https://). It is kept in VS Code\'s secret storage, never in settings.json. '
    + 'Name the header in tokenPace.notifications.webhook\'s secretHeader first, if your address expects a secret.')
  const validate = box.options?.validateInput as (v: string) => string | undefined
  const refused = 'Only an https:// address without a user name or password in it is accepted.'
  for (const bad of ['http://hooks.example.invalid/synthetic-url-secret-123', 'https://user:synthetic-password-000@hooks.example.invalid/x', 'synthetic', '']) {
    assert.equal(validate(bad), refused, bad)
  }
  assert.equal(validate(HOOK_URL), undefined)
  assert.deepEqual(Object.fromEntries(mapOf(w.secrets)), { [NOTIFY_SECRET_KEYS.webhookUrl]: HOOK_URL })
  // The format setting is generic already: the short answer.
  assert.equal(w.ui.asked.at(-1)?.text, 'Notifications: Webhook (JSON) is set up. To use it, add "webhook" to tokenPace.notifications.channels.')

  // With a header named, and an address stored: "Leave empty to keep the stored one", an empty answer keeps it.
  const v = world({ secrets: { [NOTIFY_SECRET_KEYS.webhookUrl]: HOOK_URL }, cfg: { 'tokenPace.notifications.webhook': { format: 'generic', secretHeader: 'X-Token' } } })
  v.ui.picks.push('Webhook (JSON)')
  v.ui.inputs.push('', HOOK_SECRET)
  v.ui.modals.push('Allow')
  await v.host.setUp()
  const [, url, header] = v.ui.asked
  assert.equal(url.options?.placeHolder, 'Leave empty to keep the stored one.')
  assert.equal((url.options?.validateInput as (s: string) => string | undefined)(''), undefined)
  assert.equal(url.text.includes('secretHeader'), false, 'a named header still explains how to name one')
  assert.equal(header.text, 'The value of the header X-Token. It is kept in VS Code\'s secret storage.')
  assert.equal(header.options?.password, true)
  assert.equal(v.ui.asked.find((a) => a.kind === 'modal')?.text, 'Allow Token Pace to send notifications to hooks.example.invalid:8443?')
  assert.deepEqual(Object.fromEntries(mapOf(v.secrets)), { [NOTIFY_SECRET_KEYS.webhookUrl]: HOOK_URL, [NOTIFY_SECRET_KEYS.webhookSecret]: HOOK_SECRET })
  // Not one value in any text a box or a message showed.
  for (const s of SECRETS) {
    assert.equal(w.ui.texts().includes(s), false, s)
    assert.equal(v.ui.texts().includes(s), false, s)
  }

  // A preset with the format setting still generic: set the format too — two whole keys.
  const p = world()
  p.ui.picks.push('Discord')
  p.ui.inputs.push(HOOK_URL)
  p.ui.modals.push('Allow')
  await p.host.setUp()
  assert.equal(p.ui.asked.at(-1)?.text,
    'Notifications: Discord is set up. To use it, add "webhook" to tokenPace.notifications.channels and set the format in tokenPace.notifications.webhook to "discord".')
})

/** The boxes a setup showed, each with its placeholder. */
const boxes = (ui: FakeUi): Array<[string, unknown]> => ui.asked.filter((a) => a.kind === 'input').map((a) => [a.text, a.options?.placeHolder])
const KEEP = 'Leave empty to keep the stored one.'

test('Review 3 F1: a stored secret is bound to the host it was allowed for — the generic webhook with X-Token for one host, then Slack for another: the preset asks for no header and deletes the stored value on Allow, and the test to the new host carries no X-Token; the generic webhook set up again for that host with a value typed sends it there; another host with an empty answer deletes the value, the same host keeps it (1.12 §0a.8, C6, C7)', async () => {
  const header = { 'tokenPace.notifications.webhook': { format: 'generic', secretHeader: 'X-Token' } }
  const OTHER = 'https://hooks.elsewhere.example/services/synthetic-url-secret-123'
  const w = world({ cfg: header })
  // 1. The generic webhook with secretHeader X-Token for hooks.example.invalid:8443.
  w.ui.picks.push('Webhook (JSON)')
  w.ui.inputs.push(HOOK_URL, HOOK_SECRET)
  w.ui.modals.push('Allow')
  await w.host.setUp()
  assert.equal(readConsents(w.memento).webhook?.host, 'hooks.example.invalid:8443')
  assert.equal(mapOf(w.secrets).get(NOTIFY_SECRET_KEYS.webhookSecret), HOOK_SECRET)
  // 2. Set Up → Slack with an address of another host: the pick, the address box, the consent and the answer — no header.
  w.ui.asked.length = 0
  w.ui.picks.push('Slack')
  w.ui.inputs.push(OTHER)
  w.ui.modals.push('Allow')
  await w.host.setUp()
  assert.deepEqual(w.ui.asked.map((a) => a.kind), ['pick', 'input', 'modal', 'info'])
  assert.equal(w.ui.asked[2].text, 'Allow Token Pace to send notifications to hooks.elsewhere.example?')
  assert.deepEqual(Object.fromEntries(mapOf(w.secrets)), { [NOTIFY_SECRET_KEYS.webhookUrl]: OTHER }, 'the old host\'s header value was kept')
  // 3. Send a Test — with the settings as they were, and with the format the answer asked for: no X-Token either time.
  for (const [format, label] of [['generic', 'Webhook (JSON)'], ['slack', 'Slack']]) {
    w.cfg.now = cfgOf({ 'tokenPace.notifications.webhook': { format, secretHeader: 'X-Token' } })
    w.clock.now += TEST_MIN_GAP_MS
    w.ui.picks.push(label)
    await w.host.sendTest()
    assert.equal(w.ui.asked.at(-1)?.text, `Notifications: the test message went to ${label}.`)
  }
  assert.equal(w.spy.calls.length, 2)
  for (const c of w.spy.calls) {
    assert.equal(c.url, OTHER)
    assert.equal('X-Token' in c.init.headers, false, 'the header set up for one host went to another')
    assert.equal(`${JSON.stringify(c.init.headers)}${c.init.body}`.includes(HOOK_SECRET), false)
  }
  // The generic webhook set up again for the new host with a value typed in this setup: stored, and sent there.
  w.cfg.now = cfgOf(header)
  w.ui.asked.length = 0
  w.ui.picks.push('Webhook (JSON)')
  w.ui.inputs.push('', 'synthetic-header-typed-222')
  w.ui.modals.push('Allow')
  await w.host.setUp()
  // The address is kept (it names the host allowed); no value is stored any more, so its box offers none to keep.
  assert.deepEqual(boxes(w.ui).map(([, p]) => p), [KEEP, undefined])
  w.clock.now += TEST_MIN_GAP_MS
  w.ui.picks.push('Webhook (JSON)')
  await w.host.sendTest()
  assert.equal(w.spy.calls.at(-1)?.url, OTHER)
  assert.equal(w.spy.calls.at(-1)?.init.headers['X-Token'], 'synthetic-header-typed-222')

  // The generic webhook for another host with an empty header answer: no "keep" offered, the value deleted on Allow.
  const v = world({ cfg: header })
  v.ui.picks.push('Webhook (JSON)')
  v.ui.inputs.push(HOOK_URL, HOOK_SECRET)
  v.ui.modals.push('Allow')
  await v.host.setUp()
  // The same host again: both boxes offer to keep, the value stays.
  v.ui.asked.length = 0
  v.ui.picks.push('Webhook (JSON)')
  v.ui.inputs.push('', '')
  v.ui.modals.push('Allow')
  await v.host.setUp()
  assert.deepEqual(boxes(v.ui).map(([, p]) => p), [KEEP, KEEP])
  assert.equal(mapOf(v.secrets).get(NOTIFY_SECRET_KEYS.webhookSecret), HOOK_SECRET)
  // Another host: the value's box offers nothing to keep, and an empty answer deletes it — only after Allow.
  v.ui.asked.length = 0
  v.ui.picks.push('Webhook (JSON)')
  v.ui.inputs.push(OTHER, '')
  v.ui.modals.push('Never')
  await v.host.setUp()
  assert.deepEqual(boxes(v.ui).map(([, p]) => p), [KEEP, undefined])
  assert.equal(mapOf(v.secrets).get(NOTIFY_SECRET_KEYS.webhookSecret), HOOK_SECRET, 'a secret was deleted without Allow')
  v.ui.picks.push('Webhook (JSON)')
  v.ui.inputs.push(OTHER, '')
  v.ui.modals.push('Allow')
  await v.host.setUp()
  assert.deepEqual(Object.fromEntries(mapOf(v.secrets)), { [NOTIFY_SECRET_KEYS.webhookUrl]: OTHER })
  assert.equal(readConsents(v.memento).webhook?.host, 'hooks.elsewhere.example')
  // A preset for the same host keeps no header value either: it asks for none.
  const p = world({ cfg: header })
  p.ui.picks.push('Webhook (JSON)', 'Discord')
  p.ui.inputs.push(HOOK_URL, HOOK_SECRET, '')
  p.ui.modals.push('Allow', 'Allow')
  await p.host.setUp()
  await p.host.setUp()
  assert.equal(readConsents(p.memento).webhook?.host, 'hooks.example.invalid:8443')
  assert.deepEqual(Object.fromEntries(mapOf(p.secrets)), { [NOTIFY_SECRET_KEYS.webhookUrl]: HOOK_URL }, 'a preset kept the header value')
  for (const s of SECRETS) assert.equal(`${w.ui.texts()}\n${v.ui.texts()}\n${w.log.join('\n')}`.includes(s), false, s)
})

test('Review 3 F2: ntfy\'s topic and token and the SMTP password are the server\'s they were allowed for — ntfy with a token on server one, the server changed to server two: the send is skipped, the next setup offers nothing to keep, an empty token deletes the stored one on Allow, and the test to server two carries no Authorization; the same server keeps both; a changed SMTP port asks for the password again (1.12 §0a.8, C6, C7)', async () => {
  const ONE = 'https://ntfy.one.example'
  const TWO = 'https://ntfy.two.example'
  const w = world({ cfg: { 'tokenPace.notifications.ntfy': { server: ONE } } })
  w.ui.picks.push('ntfy')
  w.ui.inputs.push(TOPIC, NTFY_TOKEN)
  w.ui.modals.push('Allow')
  await w.host.setUp()
  assert.equal(readConsents(w.memento).ntfy?.host, 'ntfy.one.example')
  // The same server again: both boxes offer to keep ("Leave empty to keep the stored one."), empty answers keep both.
  w.ui.asked.length = 0
  w.ui.picks.push('ntfy')
  w.ui.inputs.push('', '')
  w.ui.modals.push('Allow')
  await w.host.setUp()
  assert.deepEqual(boxes(w.ui).map(([, p]) => p), [KEEP, KEEP])
  assert.deepEqual(Object.fromEntries(mapOf(w.secrets)), { [NOTIFY_SECRET_KEYS.ntfyTopic]: TOPIC, [NOTIFY_SECRET_KEYS.ntfyToken]: NTFY_TOKEN })
  // The server changed in the settings: the test is skipped, nothing reaches server two.
  w.cfg.now = cfgOf({ 'tokenPace.notifications.ntfy': { server: TWO } })
  w.ui.picks.push('ntfy')
  await w.host.sendTest()
  assert.equal(w.ui.asked.at(-1)?.text, 'Notifications: the test message to ntfy failed (its host changed since you allowed it).')
  assert.equal(w.spy.calls.length, 0)
  // Set Up for server two: neither box offers to keep a secret of server one; an empty topic ends the setup unchanged.
  w.ui.asked.length = 0
  w.ui.picks.push('ntfy')
  w.ui.inputs.push('')
  await w.host.setUp()
  assert.deepEqual(boxes(w.ui), [['The ntfy topic. Anyone who knows it can read its messages, so it is kept in VS Code\'s secret storage.', undefined]])
  assert.equal(w.ui.asked.some((a) => a.kind === 'modal'), false)
  assert.equal(readConsents(w.memento).ntfy?.host, 'ntfy.one.example')
  // A topic typed, the token box left empty: on Allow the token of server one is deleted.
  w.ui.asked.length = 0
  w.ui.picks.push('ntfy')
  w.ui.inputs.push('synthetic-topic-two-987', '')
  w.ui.modals.push('Allow')
  await w.host.setUp()
  assert.deepEqual(boxes(w.ui), [
    ['The ntfy topic. Anyone who knows it can read its messages, so it is kept in VS Code\'s secret storage.', undefined],
    ['An access token for the ntfy server, if it needs one — leave empty otherwise.', undefined],
  ])
  assert.equal(w.ui.asked.find((a) => a.kind === 'modal')?.text, 'Allow Token Pace to send notifications to ntfy.two.example?')
  assert.deepEqual(Object.fromEntries(mapOf(w.secrets)), { [NOTIFY_SECRET_KEYS.ntfyTopic]: 'synthetic-topic-two-987' })
  w.clock.now += TEST_MIN_GAP_MS
  w.ui.picks.push('ntfy')
  await w.host.sendTest()
  assert.equal(w.spy.calls.length, 1)
  assert.equal(w.spy.calls[0].url, `${TWO}/`)
  assert.equal('Authorization' in w.spy.calls[0].init.headers, false, 'server one\'s token went to server two')
  const text = `${w.spy.calls[0].url}\n${JSON.stringify(w.spy.calls[0].init.headers)}\n${w.spy.calls[0].init.body}`
  assert.equal(text.includes(NTFY_TOKEN) || text.includes(TOPIC), false)

  // E-mail: the port changed — the password box offers nothing to keep, an empty answer ends the setup unchanged,
  // a typed one is stored and the consent names the new port; the same server offers to keep it.
  const e = world()
  e.ui.picks.push('E-mail (SMTP)')
  e.ui.inputs.push(PASSWORD)
  e.ui.modals.push('Allow')
  await e.host.setUp()
  e.ui.asked.length = 0
  e.ui.picks.push('E-mail (SMTP)')
  e.ui.inputs.push('')
  e.ui.modals.push('Allow')
  await e.host.setUp()
  assert.deepEqual(boxes(e.ui).map(([, p]) => p), [KEEP])
  assert.equal(mapOf(e.secrets).get(NOTIFY_SECRET_KEYS.emailPassword), PASSWORD)
  e.cfg.now = cfgOf({ 'tokenPace.notifications.email': { host: SMTP_HOST, port: 465, security: 'tls', user: USER, from: FROM, to: TO } })
  e.ui.asked.length = 0
  e.ui.picks.push('E-mail (SMTP)')
  e.ui.inputs.push('')
  await e.host.setUp()
  assert.deepEqual(boxes(e.ui).map(([, p]) => p), [undefined])
  assert.equal(e.ui.asked.some((a) => a.kind === 'modal'), false)
  assert.equal(readConsents(e.memento).email?.host, `${SMTP_HOST}:587`)
  e.ui.picks.push('E-mail (SMTP)')
  e.ui.inputs.push('synthetic-password-465')
  e.ui.modals.push('Allow')
  await e.host.setUp()
  assert.equal(mapOf(e.secrets).get(NOTIFY_SECRET_KEYS.emailPassword), 'synthetic-password-465')
  assert.equal(readConsents(e.memento).email?.host, `${SMTP_HOST}:465`)
})

// ---------------------------------------------------------------------------
// The send: the consent's host, a changed host, the last result (C6 rule 2, C1 rule 6, C12)
// ---------------------------------------------------------------------------

test('a changed host skips the send: ntfy\'s server, the SMTP port and the webhook address\'s host — no request, no socket, the log\'s words, the diagnostics\' consent no (host changed); a listed channel without a consent is not set up (1.12 C6 rule 2, C4 rule 6, C14 item 6)', async () => {
  const w = world()
  allSetUp(w)
  const payload = payloadOf([quotaEvent()], { tcfg: TCFG, now: NOW })
  // The settings changed after the consent.
  w.cfg.now = cfgOf({ 'tokenPace.notifications.channels': ['ntfy', 'email'], 'tokenPace.notifications.ntfy': { server: 'https://ntfy.elsewhere.example' },
    'tokenPace.notifications.email': { host: SMTP_HOST, port: 465, security: 'tls', user: USER, from: FROM, to: TO } })
  for (const ch of ['ntfy', 'email'] as const) {
    assert.deepEqual(await w.host.sendTo(ch, payload, 'quotaThreshold', w.cfg.now, NOW), { ok: false, kind: 'hostChanged' })
  }
  // The webhook's address itself names another host (only a hand-edited secret store could do that).
  mapOf(w.secrets).set(NOTIFY_SECRET_KEYS.webhookUrl, 'https://hooks.elsewhere.example/services/synthetic-url-secret-123')
  assert.deepEqual(await w.host.sendTo('webhook', payload, 'quotaThreshold', w.cfg.now, NOW), { ok: false, kind: 'hostChanged' })
  assert.equal(w.spy.calls.length, 0, 'a request went to a host nobody allowed')
  assert.deepEqual(w.smtp.calls, [], 'a socket was opened to a host nobody allowed')
  assert.deepEqual(w.log, [
    'Notify: ntfy skipped — its host changed since you allowed it; run Set Up again',
    'Notify: email skipped — its host changed since you allowed it; run Set Up again',
    'Notify: webhook skipped — its host changed since you allowed it; run Set Up again',
  ])
  // No secret of the skipped channels was read (the webhook's address is the one that names its host).
  assert.deepEqual(w.secrets.calls.filter((c) => c.startsWith('get:')), [`get:${NOTIFY_SECRET_KEYS.webhookUrl}`])
  // Nothing recorded as a failure: the channel did not fail, it was not tried.
  assert.deepEqual(loadNotifyState(w.memento).last, {})
  const diag = await w.host.diagnostics(w.cfg.now, NOW)
  assert.deepEqual(diag.channels.map((c) => [c.channel, c.consent]), [['webhook', 'yes'], ['telegram', 'yes'], ['ntfy', 'hostChanged'], ['email', 'hostChanged']])
  assert.equal(failureWord({ ok: false, kind: 'hostChanged' }), 'its host changed since you allowed it')
  // A channel listed without a consent is not set up: nothing read, nothing sent.
  const bare = world({ cfg: { 'tokenPace.notifications.channels': ['telegram'] } })
  mapOf(bare.secrets).set(NOTIFY_SECRET_KEYS.telegramBotToken, BOT_TOKEN)
  assert.deepEqual(await bare.host.sendTo('telegram', payload, 'quotaThreshold', bare.cfg.now, NOW), { ok: false, kind: 'notSetUp' })
  assert.deepEqual(bare.secrets.calls, [])
  assert.deepEqual(bare.log, ['Notify: telegram skipped — it is not set up; run Set Up'])
})

test('a send\'s result is the channel\'s last: ok, HTTP 401, a 429 that pauses the channel until Retry-After and skips it meanwhile, an SMTP refusal with its code — never retried (1.12 C1 rule 6, C4 rules 4 and 6, C12)', async () => {
  const w = world({ smtpAuth: 535 })
  allSetUp(w)
  const c = cfgOf({ 'tokenPace.notifications.channels': ['webhook', 'telegram', 'email'] })
  const payload = payloadOf([quotaEvent()], { tcfg: TCFG, now: NOW })
  w.spy.statuses.push({ status: 204 }, { status: 401 })
  assert.deepEqual(await w.host.sendTo('webhook', payload, 'quotaThreshold', c, NOW), { ok: true })
  assert.deepEqual(await w.host.sendTo('telegram', payload, 'quotaThreshold', c, NOW), { ok: false, kind: 'http', status: 401 })
  assert.deepEqual(await w.host.sendTo('email', payload, 'quotaThreshold', c, NOW), { ok: false, kind: 'refused', status: 535 })
  assert.equal(w.spy.calls.length, 2, 'a failed send was tried again')
  let last = loadNotifyState(w.memento).last
  assert.deepEqual(last.webhook, { at: NOW, event: 'quotaThreshold', ok: true })
  assert.deepEqual(last.telegram, { at: NOW, event: 'quotaThreshold', ok: false, kind: 'http', status: 401 })
  assert.deepEqual(last.email, { at: NOW, event: 'quotaThreshold', ok: false, kind: 'refused', status: 535 })
  assert.ok(w.log.includes('Notify: quotaThreshold to telegram failed (HTTP 401)'))
  assert.ok(w.log.includes('Notify: quotaThreshold to email failed (refused 535)'))
  // 429 with Retry-After: 120 → paused two minutes; a send meanwhile is skipped, one after it goes.
  w.spy.statuses.push({ status: 429, retryAfter: '120' })
  assert.deepEqual(await w.host.sendTo('webhook', payload, 'quotaExhausted', c, NOW), { ok: false, kind: 'http', status: 429, retryAfterSec: 120 })
  last = loadNotifyState(w.memento).last
  assert.equal(last.webhook?.pausedUntil, NOW + 120 * SEC)
  assert.deepEqual(await w.host.sendTo('webhook', payload, 'quotaExhausted', c, NOW + MIN), { ok: false, kind: 'paused', until: NOW + 120 * SEC })
  assert.equal(w.spy.calls.length, 3)
  assert.deepEqual(await w.host.sendTo('webhook', payload, 'quotaExhausted', c, NOW + 121 * SEC), { ok: true })
  assert.equal(w.spy.calls.length, 4)
  // The diagnostics' line for each (C12).
  const d = await w.host.diagnostics(c, NOW + 121 * SEC)
  const report = buildDiagnostics(diagInput(d))
  assert.ok(report.includes('webhook (generic) · listed yes · secret set · consent yes · last quotaExhausted 0 s ago ok'), report)
  assert.ok(report.includes('telegram · listed yes · secret set · consent yes · last quotaThreshold 2 min ago HTTP 401'))
  assert.ok(report.includes('email · listed yes · secret set · consent yes · last quotaThreshold 2 min ago refused 535'))
  assert.ok(report.includes('ntfy · listed no · secret set · consent yes'))
})

// ---------------------------------------------------------------------------
// Send a Test, Remove (C8 rules 3–4, C4 rule 7)
// ---------------------------------------------------------------------------

test('Send a Test: none set up says so; a set-up channel not listed is offered; the test message goes past the once-rule, the cooldown and the cap, one per channel in 10 s; the answer went, or failed in a fixed word (1.12 C8 rule 3, C4 rule 7, C13)', async () => {
  const none = world()
  await none.host.sendTest()
  assert.deepEqual(none.ui.asked.map((a) => [a.kind, a.text]), [['info', 'No notification channel is set up yet. Run "Token Pace: Set Up a Notification Channel…" first.']])
  // A consent without its secret, or a secret without its consent, is not set up.
  const half = world({ secrets: { [NOTIFY_SECRET_KEYS.telegramBotToken]: BOT_TOKEN } })
  consented(half.memento, { ntfy: 'ntfy.synthetic-host.example' })
  await half.host.sendTest()
  assert.equal(half.ui.asked[0].kind, 'info')

  const w = world({ cfg: { 'tokenPace.notifications.channels': [], 'tokenPace.notifications.webhook': { format: 'slack', secretHeader: '' } } })
  allSetUp(w)
  // The cap and the cooldown are spent — a test passes both.
  await w.memento.update(NOTIFY_STATE_KEY, { sent: {}, lastByKind: { quotaThreshold: NOW }, hour: { start: NOW - MIN, count: 20 }, last: {}, cycles: {} })
  w.ui.picks.push('ntfy')
  await w.host.sendTest()
  const pick = w.ui.asked[0]
  assert.equal(pick.text, 'Which channel should get the test message?')
  assert.deepEqual(pick.items, ['Slack', 'Telegram', 'ntfy', 'E-mail (SMTP)'])
  assert.equal(w.spy.calls.length, 1)
  assert.equal(w.spy.calls[0].url, `${NTFY_SERVER}/`)
  const body = JSON.parse(w.spy.calls[0].init.body) as Record<string, unknown>
  assert.deepEqual([body.topic, body.title, body.message], [TOPIC, 'Token Pace: test message', 'This channel works: Token Pace can reach it. Sent at 12:00.'])
  assert.equal(w.ui.asked.at(-1)?.text, 'Notifications: the test message went to ntfy.')
  assert.deepEqual(loadNotifyState(w.memento).last.ntfy, { at: NOW, event: 'test', ok: true })
  // Within 10 s: not sent — said in the log, and (Review 3 F8, pinned and changed) answered, not ended in silence.
  w.clock.now = NOW + TEST_MIN_GAP_MS - 1
  w.ui.picks.push('ntfy')
  await w.host.sendTest()
  assert.equal(w.spy.calls.length, 1)
  assert.ok(w.log.includes('Notify: a test message to ntfy went less than 10 s ago — this one is not sent'))
  assert.deepEqual([w.ui.asked.at(-1)?.kind, w.ui.asked.at(-1)?.text],
    ['info', 'Notifications: a test message to ntfy went out less than ten seconds ago — try again in a moment.'])
  // A failure in its fixed word, then another channel's timeout word.
  w.clock.now = NOW + TEST_MIN_GAP_MS
  w.spy.statuses.push({ status: 401 })
  w.ui.picks.push('ntfy')
  await w.host.sendTest()
  assert.equal(w.ui.asked.at(-1)?.text, 'Notifications: the test message to ntfy failed (HTTP 401).')
  assert.deepEqual(loadNotifyState(w.memento).last.ntfy, { at: NOW + TEST_MIN_GAP_MS, event: 'test', ok: false, kind: 'http', status: 401 })
  // The once-rule's and the cap's state are the evaluations' alone: a test changed neither.
  const st = loadNotifyState(w.memento)
  assert.deepEqual([st.hour.count, st.lastByKind, st.sent], [20, { quotaThreshold: NOW }, {}])
  // The failure words, English and German.
  const kinds = [
    [{ ok: false, kind: 'timeout' }, 'timeout', 'Zeitüberschreitung'],
    [{ ok: false, kind: 'tls' }, 'TLS error', 'TLS-Fehler'],
    [{ ok: false, kind: 'network' }, 'network error', 'Netzwerkfehler'],
    [{ ok: false, kind: 'refused', status: 535 }, 'refused by the server', 'vom Server abgelehnt'],
    [{ ok: false, kind: 'config' }, 'incomplete setup', 'unvollständige Einrichtung'],
    [{ ok: false, kind: 'http', status: 500 }, 'HTTP 500', 'HTTP 500'],
    [{ ok: false, kind: 'paused', until: NOW }, 'HTTP 429', 'HTTP 429'],
  ] as const
  for (const [r, en] of kinds) assert.equal(failureWord(r as never), en)
  await withGerman(async () => {
    for (const [r, , de] of kinds) assert.equal(failureWord(r as never), de)
    assert.equal(failureWord({ ok: false, kind: 'hostChanged' }), 'sein Host hat sich geändert, seit Sie ihn erlaubt haben')
    const g = world()
    allSetUp(g)
    g.ui.picks.push('E-Mail (SMTP)')
    await g.host.sendTest()
    assert.equal(g.ui.asked[0].text, 'Welcher Kanal soll die Testnachricht bekommen?')
    assert.deepEqual(g.ui.asked[0].items, ['Webhook (JSON)', 'Telegram', 'ntfy', 'E-Mail (SMTP)'])
    assert.equal(g.ui.asked.at(-1)?.text, 'Benachrichtigungen: Die Testnachricht ging an E-Mail (SMTP).')
    // Review 3 F8: a second one within 10 s, in German.
    g.ui.picks.push('E-Mail (SMTP)')
    await g.host.sendTest()
    assert.equal(g.ui.asked.at(-1)?.text,
      'Benachrichtigungen: Eine Testnachricht an E-Mail (SMTP) ging vor weniger als zehn Sekunden hinaus — versuchen Sie es gleich noch einmal.')
    // Review 3 F3, F4: the comma before „außer“, and „Kanal“ written out where a pronoun follows the channel's name.
    assert.ok(consentDetail('ntfy.synthetic-host.example').includes('Token Pace liest von ntfy.synthetic-host.example nichts zurück, außer ob die Nachricht angenommen wurde.'))
    g.ui.picks.push('ntfy')
    g.ui.modals.push('Entfernen')
    await g.host.remove()
    const confirm = g.ui.asked.find((a) => a.kind === 'modal')
    assert.equal(confirm?.text, 'Kanal ntfy entfernen? Seine Geheimnisse und Ihre Zustimmung werden gelöscht, und es wird nichts mehr dorthin gesendet.')
    assert.equal(g.ui.asked.at(-1)?.text, 'Benachrichtigungen: Der Kanal ntfy wurde entfernt — seine Geheimnisse und seine Zustimmung sind gelöscht.')
    const none = world()
    await none.host.sendTest()
    assert.equal(none.ui.asked[0].text, 'Es ist noch kein Benachrichtigungskanal eingerichtet. Führen Sie zuerst „Token Pace: Benachrichtigungskanal einrichten…“ aus.')
  })
})

test('Remove deletes the channel\'s secrets, its consent and its last result after its confirmation; Escape keeps everything; the other channels stay (1.12 C6 rule 3, C8 rule 4, C14 item 6)', async () => {
  const w = world()
  allSetUp(w)
  await w.memento.update(NOTIFY_STATE_KEY, { sent: {}, lastByKind: {}, hour: { start: 0, count: 0 }, cycles: {},
    last: { ntfy: { at: NOW, event: 'test', ok: false, kind: 'http', status: 401 }, email: { at: NOW, event: 'test', ok: true } } })
  // Escape at the confirmation.
  w.ui.picks.push('ntfy')
  w.ui.modals.push(undefined)
  await w.host.remove()
  assert.equal(mapOf(w.secrets).size, 6)
  const confirm = w.ui.asked.find((a) => a.kind === 'modal')
  assert.equal(confirm?.text, 'Remove ntfy? Its secrets and your consent are deleted, and nothing is sent to it any more.')
  assert.deepEqual(confirm?.buttons, ['Remove'])
  assert.deepEqual(confirm?.options, { kind: 'warning' })
  assert.equal(w.ui.asked[0].text, 'Which channel should Token Pace remove?')
  // Remove.
  w.ui.picks.push('ntfy')
  w.ui.modals.push('Remove')
  await w.host.remove()
  assert.equal(mapOf(w.secrets).has(NOTIFY_SECRET_KEYS.ntfyTopic), false)
  assert.equal(mapOf(w.secrets).has(NOTIFY_SECRET_KEYS.ntfyToken), false)
  assert.equal(mapOf(w.secrets).size, 4)
  assert.deepEqual(Object.keys(readConsents(w.memento)), ['webhook', 'telegram', 'email'])
  assert.deepEqual(Object.keys(loadNotifyState(w.memento).last), ['email'])
  assert.equal(w.ui.asked.at(-1)?.text, 'Notifications: ntfy was removed — its secrets and its consent are gone.')
  // A half-set-up channel (a secret, no consent) can be removed too; with nothing left it says so.
  const half = world({ secrets: { [NOTIFY_SECRET_KEYS.emailPassword]: PASSWORD } })
  half.ui.picks.push('E-mail (SMTP)')
  half.ui.modals.push('Remove')
  await half.host.remove()
  assert.equal(mapOf(half.secrets).size, 0)
  await half.host.remove()
  assert.equal(half.ui.asked.at(-1)?.text, 'No notification channel is set up yet. Run "Token Pace: Set Up a Notification Channel…" first.')
})

// ---------------------------------------------------------------------------
// The evaluation (C9 rules 2–3, C2 rule 7)
// ---------------------------------------------------------------------------

function quotaEvent(over: Partial<NotificationEvent> = {}): NotificationEvent {
  return {
    event: 'quotaThreshold', identity: 'quotaThreshold:claude:session:300:x', provider: 'claude', program: null, windowLabel: '5 h', windowKind: 'session',
    percent: 82, resetsAt: NOW + 2 * HOUR, etaAt: null, since: null, atLeastMs: null, wait: null, at: NOW - MIN, ...over,
  }
}

test('with no channel listed the notifier does nothing at all: evaluate reads no secret, no state and keeps no table, request arms no timer; a follower never sends (1.12 C9 rule 3, C2 rule 7, C14 item 6)', async () => {
  const w = world({ input: { states: [reading([win()])] } })
  allSetUp(w)
  w.memento.calls.length = 0
  assert.equal(await w.host.evaluate(w.input.now, w.cfg.now, NOW), null)
  w.host.request()
  assert.deepEqual(w.secrets.calls, [], 'a secret was read with no channel listed')
  assert.deepEqual(w.memento.calls, [], 'the state was read with no channel listed')
  assert.deepEqual(w.timers, [], 'a timer was armed with no channel listed')
  assert.equal(w.spy.calls.length, 0)
  // A follower window: nothing either.
  w.cfg.now = cfgOf({ 'tokenPace.notifications.channels': ['ntfy'] })
  assert.equal(await w.host.evaluate(inputOf({ states: [reading([win()])], role: 'follower' }), w.cfg.now, NOW), null)
  assert.deepEqual([w.secrets.calls, w.memento.calls, w.spy.calls.length], [[], [], 0])
})

test('an evaluation sends one message per kind to every listed channel, keeps each channel\'s last, logs a dropped event at debug, and sends nothing again (1.12 C9 rule 2, C4, R2fix-D4)', async () => {
  const w = world({ cfg: { 'tokenPace.notifications.channels': ['ntfy', 'webhook'], 'tokenPace.notifications.cooldownMinutes': 10 } })
  allSetUp(w)
  w.input.now = inputOf({ states: [reading([win({ percent: 82 }), win({ id: 'weekly_all:10080', kind: 'weekly', label: '7 d', percent: 100, resetsAt: NOW + 3 * 24 * HOUR })])] })
  const first = await w.host.evaluate(w.input.now, w.cfg.now, NOW)
  assert.deepEqual(first?.send.map((g) => g.map((e) => e.event)), [['quotaThreshold'], ['quotaExhausted']])
  // Two messages × two channels, in the channels' order.
  assert.deepEqual(w.spy.calls.map((c) => c.url), [`${NTFY_SERVER}/`, HOOK_URL, `${NTFY_SERVER}/`, HOOK_URL])
  const ntfyBody = JSON.parse(w.spy.calls[0].init.body) as Record<string, unknown>
  assert.equal(ntfyBody.message, 'Claude, 5 h window: 82% used — resets at 14:00.')
  // The webhook's generic JSON carries the payload; its secret header only when a header is named (none here).
  assert.equal((JSON.parse(w.spy.calls[1].init.body) as Record<string, unknown>).event, 'quotaThreshold')
  assert.equal(Object.values(w.spy.calls[1].init.headers).includes(HOOK_SECRET), false)
  const last = loadNotifyState(w.memento).last
  assert.deepEqual([last.ntfy?.event, last.webhook?.event], ['quotaExhausted', 'quotaExhausted'])
  // The next evaluation: sent already.
  w.spy.calls.length = 0
  const again = await w.host.evaluate(w.input.now, w.cfg.now, NOW + MIN)
  assert.deepEqual(again?.send, [])
  assert.equal(w.spy.calls.length, 0)
  // A new window over its threshold within the cooldown: dropped, at debug, with C4 rule 2's words.
  w.input.now = inputOf({ states: [reading([win({ id: 'weekly_opus:10080', kind: 'weekly', label: '7 d · Opus', percent: 90, resetsAt: NOW + 3 * 24 * HOUR })])] })
  await w.host.evaluate(w.input.now, w.cfg.now, NOW + 2 * MIN)
  assert.equal(w.spy.calls.length, 0)
  assert.ok(w.debug.includes('Notify: quotaThreshold dropped (cooldown)'), w.debug.join('\n'))
})

test('request runs at most one evaluation per 5 s — the first at once, one more at the end of the span, with the readings of that moment (1.12 C9 rule 2)', async () => {
  const w = world({ cfg: { 'tokenPace.notifications.channels': ['ntfy'] } })
  allSetUp(w)
  let evaluations = 0
  const real = w.host.evaluate.bind(w.host)
  w.host.evaluate = async (...args) => { evaluations++; return real(...args) }
  w.host.request()
  assert.deepEqual(w.timers.map((t) => t.ms), [0])
  w.timers[0].fn()
  await w.host.settled()
  assert.equal(evaluations, 1)
  // Three requests within the span: one timer, at its end.
  w.clock.now = NOW + SEC
  w.host.request()
  w.host.request()
  w.clock.now = NOW + 2 * SEC
  w.host.request()
  assert.deepEqual(w.timers.map((t) => t.ms), [0, NOTIFY_EVAL_MIN_MS - SEC])
  // The readings of the moment it runs, not of the request.
  w.input.now = inputOf({ states: [reading([win({ percent: 95 })])] })
  w.clock.now = NOW + NOTIFY_EVAL_MIN_MS
  w.timers[1].fn()
  await w.host.settled()
  assert.equal(evaluations, 2)
  assert.equal((JSON.parse(w.spy.calls[0].init.body) as Record<string, unknown>).message, 'Claude, 5 h window: 95% used — resets at 14:00.')
  // A request while an evaluation runs is run once after it.
  let release: () => void = () => undefined
  w.host.evaluate = async () => { evaluations++; await new Promise<void>((r) => { release = r }); return null }
  w.clock.now = NOW + 20 * SEC
  w.host.request()
  w.timers[2].fn()
  w.host.request()
  w.host.request()
  assert.equal(w.timers.length, 3, 'a timer was armed while an evaluation ran')
  release()
  await settle()
  await settle()
  assert.equal(w.timers.length, 4)
  // Disposed: the armed timer is cleared, and no request arms another.
  w.host.dispose()
  assert.equal(w.timers[3].cleared, true)
  w.host.request()
  assert.equal(w.timers.length, 4)
})

// ---------------------------------------------------------------------------
// Clear Stored Data (C9 rule 5), the API's check (C9 rule 7)
// ---------------------------------------------------------------------------

test('Clear Stored Data\'s part: the count of the channels set up, then the six secrets, the consents and the state deleted; the API\'s check says noChannel or the channels (1.12 C9 rules 5 and 7, §0a.11)', async () => {
  const w = world()
  assert.equal(await w.host.check(), 'noChannel')
  allSetUp(w)
  mapOf(w.secrets).set('unrelated.key', 'another extension\'s')
  await w.memento.update(NOTIFY_STATE_KEY, { sent: { x: NOW } })
  assert.equal(await w.host.setUpCount(), 4)
  assert.equal(await w.host.check(), 'webhook,telegram,ntfy,email')
  await w.host.forgetAll()
  assert.deepEqual([...mapOf(w.secrets).keys()], ['unrelated.key'])
  assert.deepEqual(w.secrets.calls.filter((c) => c.startsWith('delete:')), NOTIFY_SECRET_KEY_LIST.map((k) => `delete:${k}`))
  assert.equal(w.memento.store.has(NOTIFY_CONSENT_KEY), false)
  assert.equal(w.memento.store.has(NOTIFY_STATE_KEY), false)
  assert.equal(await w.host.setUpCount(), 0)
  // The six keys, frozen, under tokenPace.notify. — §0a.8's list.
  assert.deepEqual(NOTIFY_SECRET_KEY_LIST, ['tokenPace.notify.webhook.url', 'tokenPace.notify.webhook.secret', 'tokenPace.notify.telegram.botToken',
    'tokenPace.notify.ntfy.topic', 'tokenPace.notify.ntfy.token', 'tokenPace.notify.email.password'])
  assert.equal(Object.isFrozen(NOTIFY_SECRET_KEYS), true)
  // A consent of another shape is no consent.
  w.memento.store.set(NOTIFY_CONSENT_KEY, { ntfy: { host: 'https://x.example/path', at: 1 }, email: { host: 'a.example:587' }, fax: { host: 'a', at: 1 } })
  assert.deepEqual(readConsents(w.memento), {})
  assert.equal(channelName('webhook', 'rocketChat'), 'Rocket.Chat')
})

// ---------------------------------------------------------------------------
// §0a.8: the leak test over the channels' synthetic secrets
// ---------------------------------------------------------------------------

/** The diagnostics report as Copy Diagnostics makes it: the channel lines and the settings snapshot. */
function diagInput(notifications: DiagnosticsInput['notifications'], settings: Record<string, unknown> = {}): DiagnosticsInput {
  return {
    extVersion: '1.12.0', vscodeVersion: '1.106.0', platform: 'linux', arch: 'x64', node: '22.15.1', remoteName: null, extensionKind: 'ui',
    roots: [], fileCount: 0, snapshot: { buckets: {}, bytes: 0, oldestDay: null, newestDay: null, firstIngest: null },
    retention: { hourDays: 45, days: 400, historyDays: 30 }, historySize: { samples: 0, bytes: 0, oldest: null }, quota: [],
    codexConnection: null, credentials: null, notifications, consent: 'unasked', role: 'leader', bridge: null,
    http: { proxy: { value: '', origin: 'default' }, proxySupport: { value: 'override', origin: 'default' }, proxyStrictSSL: { value: true, origin: 'default' } },
    proxyEnv: [], settings, partialData: false, attribution: 'none', language: { setting: 'auto', shown: 'en', vscode: 'en' }, home: '/home/tester',
  }
}

test('§0a.8 leak test: six synthetic secrets through a setup of each channel, a test send, a failed send (HTTP 401), an evaluation and Remove stand only in the requests that need them — never in the log, a message, the diagnostics, the memento or a setting; the settings\' host, addresses, chat id and server not in the diagnostics either (1.12 §0a.8, §0a.11, C14 items 6 and 9)', async () => {
  const settings = {
    'tokenPace.notifications.channels': ['webhook', 'telegram', 'ntfy', 'email'],
    'tokenPace.notifications.webhook': { format: 'generic', secretHeader: 'X-Token' },
    'tokenPace.notifications.telegram': { chatId: CHAT_ID },
    'tokenPace.notifications.ntfy': { server: NTFY_SERVER },
    'tokenPace.notifications.email': { host: SMTP_HOST, port: 587, security: 'starttls', user: USER, from: FROM, to: TO },
  }
  const w = world({ cfg: settings })
  // The four setups, by hand.
  const setups: Array<[string, string[]]> = [['Webhook (JSON)', [HOOK_URL, HOOK_SECRET]], ['Telegram', [BOT_TOKEN]], ['ntfy', [TOPIC, NTFY_TOKEN]], ['E-mail (SMTP)', [PASSWORD]]]
  for (const [label, typed] of setups) {
    w.ui.picks.push(label)
    w.ui.inputs.push(...typed)
    w.ui.modals.push('Allow')
    await w.host.setUp()
  }
  assert.equal(await w.host.setUpCount(), 4)
  // A test send to each, the Telegram one failing with 401.
  for (const [label] of setups) {
    if (label === 'Telegram') w.spy.statuses.push({ status: 401 })
    w.ui.picks.push(label)
    w.clock.now += TEST_MIN_GAP_MS
    await w.host.sendTest()
  }
  // An evaluation's message to all four.
  w.clock.now += HOUR
  w.input.now = inputOf({ states: [reading([win({ percent: 82 })])].map((s) => ({ ...s, fetchedAt: Math.floor((w.clock.now - MIN) / 1000) })) })
  await w.host.evaluate(w.input.now, w.cfg.now, w.clock.now)
  // Each secret exactly where its request needs it.
  const requests = w.spy.calls
  assert.equal(requests.length, 6)
  const hook = requests.filter((r) => r.url === HOOK_URL)
  assert.equal(hook.length, 2)
  for (const r of hook) assert.equal(r.init.headers['X-Token'], HOOK_SECRET)
  const tg = requests.filter((r) => r.url.startsWith('https://api.telegram.org/'))
  assert.deepEqual(tg.map((r) => r.url), [`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`])
  const ntfy = requests.filter((r) => r.url === `${NTFY_SERVER}/`)
  for (const r of ntfy) {
    assert.equal(r.init.headers.Authorization, `Bearer ${NTFY_TOKEN}`)
    assert.equal((JSON.parse(r.init.body) as Record<string, unknown>).topic, TOPIC)
  }
  for (const r of requests) {
    // No secret of another channel in a request, and none in a body but ntfy's own topic.
    const own = r.url === HOOK_URL ? [HOOK_URL, 'synthetic-url-secret-123', HOOK_SECRET] : r.url.startsWith('https://api.telegram.org/') ? [BOT_TOKEN, 'synthetic-bot-token-456'] : [TOPIC, NTFY_TOKEN]
    const text = `${r.url}\n${JSON.stringify(r.init.headers)}\n${r.init.body}`
    for (const s of SECRETS) if (!own.includes(s)) assert.equal(text.includes(s), false, `${s} in a request to another channel`)
    assert.equal(r.init.body.includes(PASSWORD) || r.init.body.includes(HOOK_SECRET) || r.init.body.includes(NTFY_TOKEN) || r.init.body.includes(BOT_TOKEN), false)
  }
  // The password: in the AUTH line after the upgrade, and in no byte before it.
  const plain = w.smtp.phases.filter((p) => !p.tls).map((p) => p.bytes).join('')
  const plainB64 = Buffer.from(`\u0000${USER}\u0000${PASSWORD}`).toString('base64')
  for (const s of [PASSWORD, plainB64, 'AUTH', USER, FROM, TO]) assert.equal(plain.includes(s), false, `${s} before TLS`)
  const auth = w.smtp.lines.filter((l) => l.startsWith('AUTH PLAIN '))
  assert.equal(auth.length, 2)
  for (const l of auth) assert.equal(Buffer.from(l.slice('AUTH PLAIN '.length), 'base64').toString('utf8'), `\u0000${USER}\u0000${PASSWORD}`)
  assert.ok(w.smtp.lines.indexOf('-- TLS --') < w.smtp.lines.findIndex((l) => l.startsWith('AUTH')))
  // Every end of the fake server closed within half a second of the last send (a close crosses the pair on a later tick).
  for (let i = 0; i < 100 && w.smtp.ends.some((e) => !e.destroyed); i++) await new Promise<void>((resolve) => setTimeout(resolve, 5))
  for (const end of w.smtp.ends) assert.equal(end.destroyed, true, 'a socket of the fake server was left open')
  // Remove every channel.
  for (const [label] of setups) {
    w.ui.picks.push(label)
    w.ui.modals.push('Remove')
    await w.host.remove()
  }
  assert.equal(mapOf(w.secrets).size, 0)
  // None of them anywhere else: the log, every text shown, the memento, the diagnostics with the settings snapshot.
  const diagnostics = buildDiagnostics(diagInput(await w.host.diagnostics(w.cfg.now, w.clock.now), settings))
  const memento = JSON.stringify([...w.memento.store])
  const outputs: Array<[string, string]> = [
    ['the log', [...w.log, ...w.debug].join('\n')], ['a message or a box', w.ui.texts()], ['the memento', memento], ['the diagnostics', diagnostics],
    ['a settings query', w.ui.settings.join('\n')],
  ]
  for (const [where, text] of outputs) {
    for (const s of SECRETS) assert.equal(text.includes(s), false, `${s} reached ${where}`)
  }
  for (const a of ADDRESSES) assert.equal(diagnostics.includes(a), false, `${a} reached the diagnostics`)
  // The memento holds the consents' hosts (that is what a consent is) and nothing of the secrets; after Remove not even those.
  assert.deepEqual(readConsents(w.memento), {})
  assert.ok(diagnostics.includes('tokenPace.notifications.email = {"host":"set","port":587,"security":"starttls","user":"set","from":"set","to":"set"}'), diagnostics)
})

// ---------------------------------------------------------------------------
// Static (C14 item 10)
// ---------------------------------------------------------------------------

/** Every `.ts` file under a directory, recursively. */
function tsFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? tsFiles(join(dir, e.name))
    : e.name.endsWith('.ts') ? [join(dir, e.name)] : [])).sort()
}

test('static: VS Code\'s secret storage is named only in src/notifyHost.ts; test/ reaches no real host of a service, and no test calls fetch( but the channels\' own tests against their local servers (1.12 §0a.8, C14 item 10)', () => {
  const rel = (f: string): string => f.slice(ROOT.length + 1).split('\\').join('/')
  // In the code — the privacy scan's own lexer blanks comments and strings (a comment may say where a secret is kept).
  const { codeOf, networkSitesIn } = require('../scripts/check-privacy.mjs') as {
    codeOf: (text: string) => { code: string; bare: string }
    networkSitesIn: (text: string, opts?: { references?: boolean }) => Array<{ site: string }>
  }
  const bare = (f: string): string => codeOf(readFileSync(f, 'utf8')).bare
  const naming = tsFiles(join(ROOT, 'src')).filter((f) => /\.secrets\b|\bSecretStorage\b/.test(bare(f))).map(rel)
  assert.deepEqual(naming, ['src/notifyHost.ts'])
  // And there only in the factory that takes the context's: `context.secrets`, once.
  assert.equal((bare(join(ROOT, 'src', 'notifyHost.ts')).match(/\bcontext\.secrets\b/g) ?? []).length, 1)
  // The real hosts of the channels' services: named in a test only where the test says why — a string a sanitiser or
  // the privacy scan judges, or the one literal Telegram's address starts with.
  const HOSTS = /hooks\.slack\.com|discord(?:app)?\.com|api\.telegram\.org|ntfy\.sh|logic\.azure\.com|webhook\.office\.com|outlook\.office(?:365)?\.com|smtp\.gmail\.com|open\.rocket\.chat/g
  const allowed: Record<string, string[]> = {
    // httpsOnly judges ntfy's public server as a string (P6).
    'test/config.test.ts': ['ntfy.sh'],
    // The request's address is Telegram's — the fetch is a fake or bound to 127.0.0.1 (P7).
    'test/notifyChannels.test.ts': ['api.telegram.org'],
    // The scan's allow-list and the hosts it refuses (P7).
    'test/privacy.test.ts': ['api.telegram.org', 'hooks.slack.com', 'discord.com', 'ntfy.sh', 'logic.azure.com'],
    // The privacy page's sentence naming the scan's allowed host (P9), and the notifications page's and the settings
    // table's sentence naming ntfy's public server as the server's own address (the fix pass after Review 3).
    'test/docs.test.ts': ['api.telegram.org', 'ntfy.sh'],
    // The consent's Telegram host and the request address of this file's fake fetch.
    'test/notifyHost.test.ts': ['api.telegram.org', 'hooks.slack.com', 'discord.com', 'ntfy.sh', 'logic.azure.com', 'webhook.office.com',
      'outlook.office.com', 'smtp.gmail.com', 'open.rocket.chat'],
  }
  for (const file of [...tsFiles(join(ROOT, 'test')), ...tsFiles(join(ROOT, 'test-e2e'))]) {
    const found = [...new Set(readFileSync(file, 'utf8').match(HOSTS) ?? [])]
    const ok = allowed[rel(file)] ?? []
    for (const h of found) assert.ok(ok.includes(h), `${rel(file)} names ${h}, a real service's host`)
  }
  // A fetch( in the code of a test (the privacy scan's own lexer: comments and strings do not count) only where the
  // channels are tested against local HTTPS servers — the global dispatcher reached with fetch('data:,x'), then a fetch
  // bound to 127.0.0.1; every other test hands in a fake. Calls only (Review 3 F7, pinned and changed): since the scan
  // counts a reference to fetch as well, a test's fake named fetch or its 'fetch' as data would count — neither calls it.
  const fetching = [...tsFiles(join(ROOT, 'test')), ...tsFiles(join(ROOT, 'test-e2e'))]
    .filter((f) => networkSitesIn(readFileSync(f, 'utf8'), { references: false }).some((s) => s.site === 'fetch')).map(rel)
  assert.deepEqual(fetching, ['test/notifyChannels.test.ts'])
  const own = readFileSync(join(ROOT, 'test', 'notifyChannels.test.ts'), 'utf8')
  assert.ok(own.includes('fetch(\'data:,x\')'), 'the channels\' test no longer reaches the dispatcher with fetch(\'data:,x\')')
})
