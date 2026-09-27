// SPDX-FileCopyrightText: 2026 Frederik Marx
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * 1.12 C1 (§2.3, §0a.9): the HTTPS channels — the generic webhook and its five presets (Slack, Discord,
 * Microsoft Teams Workflows, Mattermost, Rocket.Chat: the same request, another body), Telegram's
 * `sendMessage` and ntfy's JSON publish. E-mail is notifySmtp.ts's.
 *
 * What goes out is the payload `notify.ts` `payloadOf` built (§0a.10) in the channel's format, nothing
 * else; what comes back and is read is the HTTP status, and for a 429 the number in `Retry-After` —
 * never a response body (a channel's error page may echo the request), never a redirect followed, never
 * anything that could steer Token Pace. The rules, each with the reason it exists:
 *
 *  • `https:` only (`httpsOnly`): no `http:`, no `user:pass@` in an address, no fragment — refused before
 *    any connection, as a `config` failure. A message goes over an encrypted connection or not at all.
 *  • `redirect: 'error'`: an address that answers with a redirect does not get to send the message on to
 *    a host nobody allowed (the consent names one host, C6).
 *  • The body is cancelled, never read: success is a 2xx status and nothing else.
 *  • One send is bounded by `NOTIFY_TIMEOUT_MS` — also when a fetch ignores its signal — and is never
 *    retried here (§7a Q24): `admit` counts the attempt, the host shows the result.
 *  • A secret stands only where its request needs it: the webhook's secret in its header, the ntfy token
 *    in `Authorization`, the Telegram bot token in the path of the one URL Telegram's API has. So no
 *    function here logs, returns or throws a URL, a header or a body: a result is a kind and a status.
 *  • No text is made here. The kinds are words only in the host (notifyHost.ts, C13's failure words), so
 *    this module holds no English.
 *
 * The network call site is `httpsFetch` below, and it is the only one of the channels — the privacy
 * scan's `NETWORK_SITES` table (scripts/check-privacy.mjs, C11) holds this file to `fetch` and to hosts
 * the reader configures: the webhook's address, the ntfy server, and the one literal, Telegram's
 * `api.telegram.org`. The host passes `httpsFetch`; every test passes a fake or a fetch bound to a
 * server of its own.
 */

import { httpsOnly, SECRET_HEADER_RE, TELEGRAM_CHAT_ID_RE, WebhookFormat } from './config'
import { NOTIFY_TIMEOUT_MS, NotificationPayload } from './notify'

export { httpsOnly } from './config'

/**
 * C1 rule 3, C11 rule 1: Telegram's Bot API — the one host literal of the channels, spelled as the address the
 * requests start with, so the privacy scan's URL check sees it in the shipped bundle and holds it to
 * `DEFAULT_ALLOW` (a host put together at run time would be no literal it could see).
 */
const TELEGRAM_API = 'https://api.telegram.org'
/** Its host, as the channel's consent names it (C6). */
export const TELEGRAM_API_HOST = new URL(TELEGRAM_API).host

/** The request a channel makes: always a POST of one JSON body, never a redirect followed, always a deadline. */
export interface FetchInit {
  method: 'POST'
  headers: Record<string, string>
  body: string
  redirect: 'error'
  signal: AbortSignal
}

/** What a channel takes of an answer: its status, one header, and a body to cancel — never to read. */
export interface FetchResponseLike {
  status: number
  headers: { get(name: string): string | null }
  body?: { cancel(reason?: unknown): Promise<void> } | null
}

/** §2.3: the fetch a channel is handed — the host's `httpsFetch`, a test's fake. */
export type FetchLike = (url: string, init: FetchInit) => Promise<FetchResponseLike>

/** C1 rule 6: every failure is one of these, with the status for `http` — the host words them (C13). */
export type SendFailureKind = 'http' | 'timeout' | 'tls' | 'network' | 'refused' | 'config'
export type SendResult =
  | { ok: true }
  | { ok: false; kind: SendFailureKind; status?: number; retryAfterSec?: number }

export interface SendOptions {
  /** This extension's version, for the honest user agent `token-pace/<version>`; absent = `token-pace`. */
  version?: string
  /** One send's deadline; absent = `NOTIFY_TIMEOUT_MS` (15 s). A test passes a short one. */
  timeoutMs?: number
}

/**
 * The extension host's `fetch` — the channels' one network call site (C11's row). It follows VS Code's
 * proxy support as the quota fetch does (how fully is not traced, C1 rule 6).
 */
export const httpsFetch: FetchLike = (url, init) => fetch(url, init)

/** C1 rule 6: a 429's pause is at most an hour. */
const RETRY_AFTER_MAX_S = 3600
/** Discord's `content` (the Execute Webhook page: up to 2000 characters). */
export const DISCORD_CONTENT_MAX = 2000
/** Telegram's `text` (sendMessage: 1–4096 characters). */
export const TELEGRAM_TEXT_MAX = 4096
/** ntfy's message (the publish page: 4096 bytes; a longer one becomes an attachment). */
export const NTFY_MESSAGE_MAX_BYTES = 4096
/** A Telegram bot token as @BotFather gives it: the bot's number, a colon, the secret. It stands in the URL's path. */
const TELEGRAM_TOKEN_RE = /^\d{1,20}:[A-Za-z0-9_-]{1,200}$/
/** An ntfy topic as ntfy accepts one (letters, digits, `-` and `_`, 1–64). */
const NTFY_TOPIC_RE = /^[A-Za-z0-9_-]{1,64}$/
/** A header value: printable ASCII — no line break that could start a header of its own, nothing fetch would refuse. */
const HEADER_VALUE_RE = /^[\x21-\x7e](?:[\t\x20-\x7e]*[\x21-\x7e])?$/
/**
 * Header names the secret may not take: the ones this module sets and the ones the connection owns. A
 * secret named `Content-Type` would break the body, one named `Host` the request.
 */
const RESERVED_HEADERS = new Set([
  'content-type', 'content-length', 'user-agent', 'host', 'connection', 'transfer-encoding', 'keep-alive', 'upgrade',
  'te', 'trailer', 'expect',
])

// ---------------------------------------------------------------------------
// The bodies (C1 rules 1–4) — each checked against the service's documentation page of 2026-09-27
// ---------------------------------------------------------------------------

/** A text cut to `max` UTF-16 units with `…` — never through a surrogate pair. The texts are far shorter; this is a guard. */
function clipChars(s: string, max: number): string {
  if (s.length <= max) return s
  let cut = s.slice(0, max - 1)
  const last = cut.charCodeAt(cut.length - 1)
  if (last >= 0xd800 && last <= 0xdbff) cut = cut.slice(0, -1)
  return `${cut}…`
}

/** A text cut to `max` bytes of UTF-8 with `…` — whole code points only. */
function clipBytes(s: string, max: number): string {
  const enc = new TextEncoder()
  if (enc.encode(s).length <= max) return s
  let out = ''
  let bytes = 3 // the ellipsis
  for (const ch of s) {
    const n = enc.encode(ch).length
    if (bytes + n > max) break
    out += ch
    bytes += n
  }
  return `${out}…`
}

/**
 * Slack's control characters (docs.slack.dev "Formatting message text", read 2026-09-27): "Slack uses `&`,
 * `<`, and `>` as control characters for special parsing in text objects, so they must be converted to HTML
 * entities" — `&amp;`, `&lt;`, `&gt;`.
 */
function slackEscape(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/**
 * C1 rules 1 and 2: the webhook's body in its format — the same payload, another JSON.
 * Pure, and the one place a webhook body is made.
 */
export function webhookBody(format: WebhookFormat, p: NotificationPayload): string {
  switch (format) {
    case 'generic':
      // C1 rule 1: Token Pace's own JSON — `payloadOf`'s fields and nothing else (§0a.10).
      return JSON.stringify(p.json)
    case 'slack':
      // docs.slack.dev "Sending messages using incoming webhooks" (read 2026-09-27): POST, `Content-type:
      // application/json`, `{"text": "Hello, world."}`; mrkdwn's bold is `*bold*` ("Formatting message text").
      return JSON.stringify({ text: `*${slackEscape(p.title)}*\n${slackEscape(p.text)}` })
    case 'mattermost':
      // developers.mattermost.com "Incoming webhooks" (read 2026-09-27): `{"text": "…"}`, `text` is
      // "Markdown-formatted"; "Bold formatting as `*bold*` is not supported (must be done as `**bold**`)".
      return JSON.stringify({ text: `**${p.title}**\n${p.text}` })
    case 'rocketChat':
      // docs.rocket.chat "Integrations" (page of 2026-07-04, read 2026-09-27): an incoming webhook takes a POST
      // with at least a `text` field — `{ "text": "Example message" }`; "Messages" (page of 2026-09-17, read
      // 2026-09-27): bold is `*Hello team*`.
      return JSON.stringify({ text: `*${p.title}*\n${p.text}` })
    case 'discord':
      // docs.discord.com "Webhook Resource", Execute Webhook (read 2026-09-27): `content` "up to 2000
      // characters", `allowed_mentions`; "Message Resource": `"parse": []` suppresses every mention.
      return JSON.stringify({ content: clipChars(`**${p.title}**\n${p.text}`, DISCORD_CONTENT_MAX), allowed_mentions: { parse: [] } })
    case 'teams':
      // learn.microsoft.com "Microsoft Teams" connector, the trigger "When a Teams webhook request is received"
      // (page of 2026-09-22, read 2026-09-27): `{"type": "message", "attachments": [{"contentType":
      // "application/vnd.microsoft.card.adaptive", "contentUrl": null, "content": {"type": "AdaptiveCard",
      // "version": "1.2", "body": [TextBlock …]}}]}` — "contentUrl: Must always be null", the examples at 1.2;
      // "Create an Incoming Webhook" (page of 2026-08-03, read 2026-09-27): Microsoft 365 (Office 365) Connectors "are nearing
      // deprecation", Workflows replace them. No `$schema`: a URL literal the privacy scan would rightly refuse,
      // and not required. One TextBlock per line, so a message of several windows keeps its lines.
      return JSON.stringify({
        type: 'message',
        attachments: [{
          contentType: 'application/vnd.microsoft.card.adaptive',
          contentUrl: null,
          content: {
            type: 'AdaptiveCard',
            version: '1.2',
            body: [
              { type: 'TextBlock', text: p.title, weight: 'Bolder', wrap: true },
              ...p.text.split('\n').map((line) => ({ type: 'TextBlock', text: line, wrap: true })),
            ],
          },
        }],
      })
  }
}

/**
 * C1 rule 3: Telegram's `sendMessage` body — plain text, no `parse_mode` (no markup a translated word could
 * break). core.telegram.org/bots/api (Bot API 10.3, read 2026-09-27): `chat_id` "Integer or String", `text`
 * "1-4096 characters", and `link_preview_options` in place of the retired `disable_web_page_preview`
 * (`is_disabled`). The chat id goes as the string the reader typed — a number or `@name` — so no digit of a
 * long group id is rounded away.
 */
export function telegramBody(chatId: string, p: NotificationPayload): string {
  return JSON.stringify({
    chat_id: chatId,
    text: clipChars(`${p.title}\n${p.text}`, TELEGRAM_TEXT_MAX),
    link_preview_options: { is_disabled: true },
  })
}

/** C1 rule 4: 4 ("high") for what asks for the reader now — an exhausted window, Claude Code waiting — else 3 ("default"). */
export function ntfyPriority(p: NotificationPayload): 3 | 4 {
  return p.json.event === 'quotaExhausted' || p.json.event === 'agentWaiting' ? 4 : 3
}

/**
 * C1 rule 4: ntfy's JSON publish body. docs.ntfy.sh "Publishing" (read 2026-09-27): POST to the server's root
 * with `topic` (required), `message`, `title`, `tags`, `priority` (1–5, 3 the default, 4 "high") — UTF-8 in
 * the body, none in a header (a header cannot carry Ukrainian or Hindi).
 */
export function ntfyBody(topic: string, p: NotificationPayload): string {
  return JSON.stringify({
    topic,
    title: p.title,
    message: clipBytes(p.text, NTFY_MESSAGE_MAX_BYTES),
    priority: ntfyPriority(p),
    tags: [],
  })
}

// ---------------------------------------------------------------------------
// The sends (C1 rule 6)
// ---------------------------------------------------------------------------

function headersOf(opts: SendOptions): Record<string, string> {
  const version = typeof opts.version === 'string' && /^[0-9A-Za-z.+-]{1,40}$/.test(opts.version) ? `/${opts.version}` : ''
  return { 'Content-Type': 'application/json; charset=utf-8', 'User-Agent': `token-pace${version}` }
}

/** C1 rule 6: the body is cancelled, never read; a cancel that throws or rejects changes nothing. */
function discard(res: FetchResponseLike | undefined): void {
  try {
    const body = res?.body
    if (body !== null && body !== undefined && typeof body.cancel === 'function') {
      Promise.resolve(body.cancel()).catch(() => undefined)
    }
  } catch {
    // Nothing of an answer but its status matters.
  }
}

/** A `Retry-After` in whole seconds, 1–3600; a date or anything else is no number (the host's own pause applies). */
function retryAfterOf(res: FetchResponseLike): number | undefined {
  let raw: string | null = null
  try {
    raw = res.headers.get('retry-after')
  } catch {
    return undefined
  }
  if (raw === null || !/^\s*\d{1,10}\s*$/.test(raw)) return undefined
  const n = Number(raw)
  return n >= 1 ? Math.min(n, RETRY_AFTER_MAX_S) : undefined
}

/**
 * A thrown fetch as one kind — by its name and its cause's code, never by showing its text (C1 rule 6).
 * `redirect: 'error'` makes a redirect a thrown "unexpected redirect": the address did not take the message,
 * so it is `refused`, as a refused connection is.
 */
export function failureOf(err: unknown): SendResult {
  const e = err as { name?: unknown; code?: unknown; message?: unknown; cause?: { name?: unknown; code?: unknown; message?: unknown } } | null
  const name = String(e?.name ?? '')
  if (name === 'TimeoutError' || name === 'AbortError') return { ok: false, kind: 'timeout' }
  const code = String(e?.cause?.code ?? e?.code ?? '')
  const message = `${String(e?.message ?? '')} ${String(e?.cause?.message ?? '')}`
  if (/redirect/i.test(message)) return { ok: false, kind: 'refused' }
  if (/CERT|TLS|SSL|SELF_SIGNED|UNABLE_TO_(GET|VERIFY)|HOSTNAME|ALTNAME/i.test(code)
    || /certificate|self.signed|\bTLS\b|\bSSL\b|handshake/i.test(message)) return { ok: false, kind: 'tls' }
  if (code === 'ECONNREFUSED') return { ok: false, kind: 'refused' }
  if (['ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT'].includes(code)) return { ok: false, kind: 'timeout' }
  return { ok: false, kind: 'network' }
}

/** An incomplete or unusable setup: nothing was sent, no connection was made. */
const config = (): SendResult => ({ ok: false, kind: 'config' })

/**
 * One POST: the deadline for the whole request (an AbortController the timer fires, and a race, so a fetch
 * that ignores its signal still ends the send in time), the body cancelled, the status judged. Never a
 * retry. The URL was checked by the caller; it is handed to `fetch` and to nothing else.
 */
async function post(url: string, headers: Record<string, string>, body: string, fetchFn: FetchLike, opts: SendOptions): Promise<SendResult> {
  const timeoutMs = typeof opts.timeoutMs === 'number' && Number.isFinite(opts.timeoutMs) && opts.timeoutMs > 0
    ? Math.min(opts.timeoutMs, NOTIFY_TIMEOUT_MS)
    : NOTIFY_TIMEOUT_MS
  const ctrl = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => {
      ctrl.abort(new DOMException('The notification took too long', 'TimeoutError'))
      resolve('timeout')
    }, timeoutMs)
  })
  let pending: Promise<FetchResponseLike>
  try {
    pending = Promise.resolve(fetchFn(url, { method: 'POST', headers, body, redirect: 'error', signal: ctrl.signal }))
  } catch (err) {
    clearTimeout(timer)
    return failureOf(err)
  }
  try {
    const res = await Promise.race([pending, deadline])
    if (res === 'timeout') {
      // An answer that comes after the deadline is still let go of, unread.
      pending.then(discard, () => undefined)
      return { ok: false, kind: 'timeout' }
    }
    discard(res)
    const status = Number(res.status)
    if (status >= 200 && status < 300) return { ok: true }
    if (!Number.isInteger(status)) return { ok: false, kind: 'network' }
    if (status === 429) {
      const retryAfterSec = retryAfterOf(res)
      return retryAfterSec === undefined ? { ok: false, kind: 'http', status } : { ok: false, kind: 'http', status, retryAfterSec }
    }
    return { ok: false, kind: 'http', status }
  } catch (err) {
    return failureOf(err)
  } finally {
    clearTimeout(timer)
  }
}

/**
 * C1 rules 1–2: the webhook — the address from SecretStorage, `https:` only; with `secret` (the header the
 * reader named in `webhook.secretHeader` and the value stored for it) that one header more. A header name
 * outside `SECRET_HEADER_RE`, one the request itself sets, or a value that is no plain header value is an
 * incomplete setup (`config`) — nothing is sent.
 */
export async function sendWebhook(
  url: string,
  secret: { header: string; value: string } | null,
  format: WebhookFormat,
  p: NotificationPayload,
  fetchFn: FetchLike,
  opts: SendOptions = {},
): Promise<SendResult> {
  const u = httpsOnly(url)
  if (u === null) return config()
  const headers = headersOf(opts)
  if (secret !== null) {
    if (typeof secret.header !== 'string' || !SECRET_HEADER_RE.test(secret.header) || RESERVED_HEADERS.has(secret.header.toLowerCase())) return config()
    if (typeof secret.value !== 'string' || !HEADER_VALUE_RE.test(secret.value)) return config()
    headers[secret.header] = secret.value
  }
  return post(u.href, headers, webhookBody(format, p), fetchFn, opts)
}

/**
 * C1 rule 3: `POST https://api.telegram.org/bot<token>/sendMessage`. The token must look like one — it stands
 * in the URL's path, so a `/` or a `?` in it would make another request —, the chat id like one
 * (`TELEGRAM_CHAT_ID_RE`); else `config`. The URL is never logged, returned or thrown: the token is in it.
 */
export async function sendTelegram(
  botToken: string,
  chatId: string,
  p: NotificationPayload,
  fetchFn: FetchLike,
  opts: SendOptions = {},
): Promise<SendResult> {
  if (typeof botToken !== 'string' || !TELEGRAM_TOKEN_RE.test(botToken)) return config()
  if (typeof chatId !== 'string' || !TELEGRAM_CHAT_ID_RE.test(chatId)) return config()
  return post(`${TELEGRAM_API}/bot${botToken}/sendMessage`, headersOf(opts), telegramBody(chatId, p), fetchFn, opts)
}

/**
 * C1 rule 4: ntfy — a POST of the JSON publish body to the server's address as the reader set it
 * (`tokenPace.notifications.ntfy.server`, `https:` only, its root or the path it is served under), the topic
 * in the body, `Authorization: Bearer <token>` when a token is stored. A topic ntfy would refuse, or a token
 * that is no plain header value, is `config`.
 */
export async function sendNtfy(
  server: string,
  topic: string,
  token: string | null,
  p: NotificationPayload,
  fetchFn: FetchLike,
  opts: SendOptions = {},
): Promise<SendResult> {
  const u = httpsOnly(server)
  if (u === null) return config()
  if (typeof topic !== 'string' || !NTFY_TOPIC_RE.test(topic)) return config()
  const headers = headersOf(opts)
  if (token !== null) {
    if (typeof token !== 'string' || !HEADER_VALUE_RE.test(token) || /\s/.test(token)) return config()
    headers.Authorization = `Bearer ${token}`
  }
  return post(u.href, headers, ntfyBody(topic, p), fetchFn, opts)
}
