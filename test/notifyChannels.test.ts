// SPDX-FileCopyrightText: 2026 Frederik Marx
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * 1.12 C1, C14 item 4 (P7): the HTTPS channels — every body byte for byte, `https:` only, no redirect
 * followed, the body never read, the secret header only where it is named and stored, the kinds of a failure,
 * a bounded send — first against an injected fetch that records what it is handed, then against a local
 * HTTPS server the tests start (127.0.0.1, port 0, a throwaway self-signed certificate made by `openssl` in a
 * temp dir that is removed at once, the client trusting exactly that certificate through a dispatcher of its
 * own — never NODE_TLS_REJECT_UNAUTHORIZED, never a global). Every server is closed and every dispatcher
 * destroyed in a `finally`; each test has a timeout of its own ≤ 5 s. No test reaches a host of a service.
 * And C14 item 3's leak test over the channels' bodies (P6-O3).
 */

import { strict as assert } from 'node:assert'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import * as http from 'node:http'
import * as https from 'node:https'
import { AddressInfo, Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { HookEntry } from '../src/agentTree'
import { readNotifyConfig, WEBHOOK_FORMATS, WebhookFormat } from '../src/config'
import { setBundle, setLocale } from '../src/i18n'
import {
  admit, collectEvents, emptyNotifyState, newNotifyTables, NotificationEvent, NotificationPayload, NotifyInput, NotifyWords,
  payloadOf, testPayload,
} from '../src/notify'
import {
  DISCORD_CONTENT_MAX, failureOf, FetchInit, FetchLike, FetchResponseLike, ntfyBody, ntfyPriority, sendNtfy, sendTelegram,
  sendWebhook, SendFailureKind, SendResult, TELEGRAM_API_HOST, telegramBody, webhookBody,
} from '../src/notifyChannels'
import { TimeConfig } from '../src/time'
import { Forecast, LastRequest, MainRec, QuotaState, QuotaWindow } from '../src/types'
import { ROOT } from './helpers/nls'

const NOW = Date.UTC(2026, 8, 27, 12, 0)
const SEC = 1000
const MIN = 60 * SEC
const HOUR = 60 * MIN
const TCFG: TimeConfig = { zone: 'utc', dayBoundaryHour: 0, startOfWeek: 'monday', hourCycle: 'h23' }
const WORDS: NotifyWords = { tcfg: TCFG, now: NOW }
const VERSION = '1.12.0'
/** P6's generic JSON, key by key (C1 rule 1) — the channels add none. */
const JSON_KEYS = ['v', 'source', 'event', 'title', 'text', 'provider', 'program', 'window', 'windowKind', 'percent', 'resetsAt', 'eta', 'since', 'atLeastMinutes', 'wait', 'at']
/** A webhook address that no resolver answers (`.invalid`, RFC 2606) — the fakes never connect anyway. */
const HOOK_URL = 'https://hooks.example.invalid/services/synthetic-webhook-path-321'
const BOT_TOKEN = '123456:synthetic-bot-token-456'
const NTFY_SERVER = 'https://ntfy.example.invalid'

function ev(over: Partial<NotificationEvent> = {}): NotificationEvent {
  return {
    event: 'quotaThreshold', identity: 'quotaThreshold:claude:session:300:x', provider: 'claude', program: null, windowLabel: '5 h',
    windowKind: 'session', percent: 82, resetsAt: NOW + 2 * HOUR, etaAt: null, since: null, atLeastMs: null, wait: null, at: NOW - MIN,
    ...over,
  }
}

/** The fixture of the byte-for-byte bodies: two windows past their threshold in one message (C2 rule 3). */
const TWO = payloadOf([ev(), ev({ provider: 'codex', windowLabel: '7 d', windowKind: 'weekly', percent: 91, resetsAt: NOW + 3 * 24 * HOUR })], WORDS)
const TWO_TEXT = 'Claude, 5 h window: 82% used — resets at 14:00.\nCodex, 7 d window: 91% used — resets at We 12:00.'

/** A payload of Slack's and the markup formats' hard characters. */
function hard(): NotificationPayload {
  return { title: 'Token Pace: <a> & "b"', text: 'x < y > z & *w*\nzweite Zeile — ü', json: { v: 1, source: 'token-pace', event: 'quotaExhausted' } }
}

// ---------------------------------------------------------------------------
// The recording fake fetch
// ---------------------------------------------------------------------------

interface Call { url: string; init: FetchInit }

/** A response whose body counts every attempt to read it, and whose reading throws. */
function response(status: number, headers: Record<string, string> = {}, cancel: () => Promise<void> = async () => undefined): FetchResponseLike & { reads: string[]; cancels: number } {
  const reads: string[] = []
  const r = {
    status,
    headers: { get: (n: string): string | null => headers[n.toLowerCase()] ?? null },
    reads,
    cancels: 0,
    body: {
      cancel: (): Promise<void> => { r.cancels++; return cancel() },
      getReader: (): never => { reads.push('getReader'); throw new Error('the body was read') },
    },
  }
  for (const m of ['text', 'json', 'arrayBuffer', 'blob', 'formData', 'bytes']) {
    Object.defineProperty(r, m, { value: () => { reads.push(m); throw new Error('the body was read') }, enumerable: false })
  }
  return r
}

function recorder(answer: (call: Call) => Promise<FetchResponseLike> | FetchResponseLike = () => response(200)): { fetch: FetchLike; calls: Call[] } {
  const calls: Call[] = []
  return {
    calls,
    fetch: async (url, init) => {
      calls.push({ url, init })
      return answer({ url, init })
    },
  }
}

const OPTS = { version: VERSION }
const HEADERS = { 'Content-Type': 'application/json; charset=utf-8', 'User-Agent': `token-pace/${VERSION}` }

// ---------------------------------------------------------------------------
// C14 item 4 — the bodies
// ---------------------------------------------------------------------------

test('each format\'s body byte for byte for one fixture — the six webhook formats, Telegram, ntfy (1.12 C1 rules 1–4, C14 item 4)', () => {
  assert.equal(TWO.title, 'Token Pace: quota threshold reached')
  assert.equal(TWO.text, TWO_TEXT)
  const expected: Record<WebhookFormat, string> = {
    generic: '{"v":1,"source":"token-pace","event":"quotaThreshold","title":"Token Pace: quota threshold reached","text":"Claude, 5 h window: 82% used — resets at 14:00.\\nCodex, 7 d window: 91% used — resets at We 12:00.","provider":"claude","program":null,"window":"5 h","windowKind":"session","percent":82,"resetsAt":"2026-09-27T14:00:00.000Z","eta":null,"since":null,"atLeastMinutes":null,"wait":null,"at":"2026-09-27T11:59:00.000Z","items":[{"event":"quotaThreshold","provider":"claude","program":null,"window":"5 h","windowKind":"session","percent":82,"resetsAt":"2026-09-27T14:00:00.000Z","eta":null,"since":null,"atLeastMinutes":null,"wait":null,"at":"2026-09-27T11:59:00.000Z"},{"event":"quotaThreshold","provider":"codex","program":null,"window":"7 d","windowKind":"weekly","percent":91,"resetsAt":"2026-09-30T12:00:00.000Z","eta":null,"since":null,"atLeastMinutes":null,"wait":null,"at":"2026-09-27T11:59:00.000Z"}]}',
    slack: '{"text":"*Token Pace: quota threshold reached*\\nClaude, 5 h window: 82% used — resets at 14:00.\\nCodex, 7 d window: 91% used — resets at We 12:00."}',
    discord: '{"content":"**Token Pace: quota threshold reached**\\nClaude, 5 h window: 82% used — resets at 14:00.\\nCodex, 7 d window: 91% used — resets at We 12:00.","allowed_mentions":{"parse":[]}}',
    teams: '{"type":"message","attachments":[{"contentType":"application/vnd.microsoft.card.adaptive","contentUrl":null,"content":{"type":"AdaptiveCard","version":"1.2","body":[{"type":"TextBlock","text":"Token Pace: quota threshold reached","weight":"Bolder","wrap":true},{"type":"TextBlock","text":"Claude, 5 h window: 82% used — resets at 14:00.","wrap":true},{"type":"TextBlock","text":"Codex, 7 d window: 91% used — resets at We 12:00.","wrap":true}]}}]}',
    mattermost: '{"text":"**Token Pace: quota threshold reached**\\nClaude, 5 h window: 82% used — resets at 14:00.\\nCodex, 7 d window: 91% used — resets at We 12:00."}',
    rocketChat: '{"text":"*Token Pace: quota threshold reached*\\nClaude, 5 h window: 82% used — resets at 14:00.\\nCodex, 7 d window: 91% used — resets at We 12:00."}',
  }
  assert.deepEqual(Object.keys(expected).sort(), [...WEBHOOK_FORMATS].sort(), 'every format has its fixture')
  for (const format of WEBHOOK_FORMATS) assert.equal(webhookBody(format, TWO), expected[format], format)
  assert.equal(telegramBody('-1001234567890', TWO),
    '{"chat_id":"-1001234567890","text":"Token Pace: quota threshold reached\\nClaude, 5 h window: 82% used — resets at 14:00.\\nCodex, 7 d window: 91% used — resets at We 12:00.","link_preview_options":{"is_disabled":true}}')
  assert.equal(ntfyBody('synthetic-topic-789', TWO),
    '{"topic":"synthetic-topic-789","title":"Token Pace: quota threshold reached","message":"Claude, 5 h window: 82% used — resets at 14:00.\\nCodex, 7 d window: 91% used — resets at We 12:00.","priority":3,"tags":[]}')
  // The generic JSON is P6's, key by key — the channel adds nothing and drops nothing (§0a.10).
  const generic = JSON.parse(webhookBody('generic', TWO)) as Record<string, unknown>
  assert.deepEqual(generic, TWO.json)
  assert.deepEqual(Object.keys(generic).filter((k) => k !== 'items'), JSON_KEYS)
  assert.deepEqual(Object.keys(JSON.parse(webhookBody('generic', testPayload(WORDS))) as object), JSON_KEYS)
})

test('Slack escapes its three control characters, the markup formats carry their bold, Discord can ping nobody, Telegram has no parse_mode (1.12 C1 rules 2–3)', () => {
  const p = hard()
  assert.equal(JSON.parse(webhookBody('slack', p)).text, '*Token Pace: &lt;a&gt; &amp; "b"*\nx &lt; y &gt; z &amp; *w*\nzweite Zeile — ü')
  assert.equal(JSON.parse(webhookBody('mattermost', p)).text, '**Token Pace: <a> & "b"**\nx < y > z & *w*\nzweite Zeile — ü')
  assert.equal(JSON.parse(webhookBody('rocketChat', p)).text, '*Token Pace: <a> & "b"*\nx < y > z & *w*\nzweite Zeile — ü')
  const discord = JSON.parse(webhookBody('discord', p)) as { content: string; allowed_mentions: { parse: unknown[] } }
  assert.deepEqual(discord.allowed_mentions, { parse: [] })
  assert.equal(discord.content, '**Token Pace: <a> & "b"**\nx < y > z & *w*\nzweite Zeile — ü')
  const tg = JSON.parse(telegramBody('@synthetic_channel', p)) as Record<string, unknown>
  assert.deepEqual(Object.keys(tg), ['chat_id', 'text', 'link_preview_options'])
  assert.equal(tg.parse_mode, undefined)
  assert.equal(tg.text, 'Token Pace: <a> & "b"\nx < y > z & *w*\nzweite Zeile — ü')
  // No body carries a URL literal (C1 rule 2: no `$schema`, nothing the privacy scan would refuse).
  for (const format of WEBHOOK_FORMATS) assert.doesNotMatch(webhookBody(format, TWO), /https?:/, format)
})

test('ntfy: priority 4 for an exhausted window and for Claude Code waiting, 3 for everything else and the test message (1.12 C1 rule 4)', () => {
  const kinds: Array<[NotificationEvent['event'], 3 | 4]> = [
    ['agentWaiting', 4], ['agentDone', 3], ['quotaThreshold', 3], ['quotaExhausted', 4], ['quotaReset', 3], ['paceWarning', 3],
  ]
  for (const [event, priority] of kinds) {
    const p = payloadOf([ev({ event, program: event.startsWith('agent') ? 'claudeCode' : null, wait: event === 'agentWaiting' ? 'input' : null, since: NOW - 2 * MIN, atLeastMs: 5 * MIN, etaAt: NOW + HOUR })], WORDS)
    assert.equal(ntfyPriority(p), priority, event)
    assert.equal((JSON.parse(ntfyBody('t', p)) as { priority: number }).priority, priority, event)
  }
  assert.equal(ntfyPriority(testPayload(WORDS)), 3)
})

test('the longest message of the longest language stays under Discord\'s 2000 characters — six windows, five sessions, every language on disk (1.12 C1 rule 2)', () => {
  // The bound: one reading of both providers holds six windows today (Claude's 5 h, 7 d and two model-scoped weeks,
  // Codex's 5 h and 7 d); five sessions waiting or finishing in one evaluation is more than a reader runs at once.
  const windows: Array<Partial<NotificationEvent>> = [
    { provider: 'claude', windowLabel: '5 h', windowKind: 'session' },
    { provider: 'claude', windowLabel: '7 d', windowKind: 'weekly' },
    { provider: 'claude', windowLabel: '7 d · Opus', windowKind: 'weekly' },
    { provider: 'claude', windowLabel: '7 d · Sonnet', windowKind: 'weekly' },
    { provider: 'codex', windowLabel: '5 h', windowKind: 'session' },
    { provider: 'codex', windowLabel: '7 d', windowKind: 'weekly' },
  ]
  const groups: NotificationEvent[][] = [
    ...(['quotaThreshold', 'quotaExhausted', 'quotaReset', 'paceWarning'] as const).map((event) => windows.map((w) => ev({
      event, ...w, percent: 100, resetsAt: NOW + 6 * 24 * HOUR + 23 * HOUR, etaAt: NOW + 5 * 24 * HOUR, since: NOW - 29 * MIN,
    }))),
    [1, 2, 3, 4, 5].map((i) => ev({ event: 'agentWaiting', provider: null, program: 'claudeCode', windowLabel: null, windowKind: null, percent: null, resetsAt: null, wait: i % 2 ? 'permission' : 'input', since: NOW - 23 * HOUR })),
    [1, 2, 3, 4, 5].map(() => ev({ event: 'agentDone', provider: null, program: 'claudeCode', windowLabel: null, windowKind: null, percent: null, resetsAt: null, atLeastMs: 23 * HOUR + 59 * MIN + 59 * SEC })),
  ]
  const ids = readdirSync(join(ROOT, 'l10n')).map((f) => /^bundle\.l10n\.(.+)\.json$/.exec(f)?.[1]).filter((x): x is string => x !== undefined)
  assert.ok(ids.length >= 24, ids.join(' '))
  let longest = { id: '', length: 0 }
  try {
    for (const id of ['en', ...ids]) {
      setBundle(id === 'en' ? undefined : JSON.parse(readFileSync(join(ROOT, 'l10n', `bundle.l10n.${id}.json`), 'utf8')) as Record<string, string>)
      setLocale(id === 'en' ? undefined : id)
      for (const g of [...groups.map((x) => payloadOf(x, WORDS)), testPayload(WORDS)]) {
        const whole = `**${g.title}**\n${g.text}`
        if (whole.length > longest.length) longest = { id, length: whole.length }
        // Under the limit whole: the clip in the channel is a guard, not the rule.
        assert.equal((JSON.parse(webhookBody('discord', g)) as { content: string }).content, whole, id)
      }
    }
  } finally {
    setBundle(undefined)
    setLocale(undefined)
  }
  assert.ok(longest.length < DISCORD_CONTENT_MAX, `${longest.id}: ${longest.length}`)
})

test('a text past a service\'s limit is cut with … — Discord 2000 characters, Telegram 4096, ntfy 4096 bytes, never through a surrogate pair (1.12 C1 rules 2–4, a guard)', () => {
  const long: NotificationPayload = { title: 'Token Pace: t', text: `${'ü'.repeat(1990)}😀${'x'.repeat(5000)}`, json: { v: 1, event: 'quotaThreshold' } }
  const content = (JSON.parse(webhookBody('discord', long)) as { content: string }).content
  assert.equal(content.length, DISCORD_CONTENT_MAX)
  assert.ok(content.endsWith('…'))
  const text = (JSON.parse(telegramBody('1', long)) as { text: string }).text
  assert.ok(text.length <= 4096 && text.endsWith('…'))
  const message = (JSON.parse(ntfyBody('t', long)) as { message: string }).message
  assert.ok(new TextEncoder().encode(message).length <= 4096 && message.endsWith('…'))
  for (const s of [content, text, message]) assert.doesNotMatch(s, /[\ud800-\udbff](?![\udc00-\udfff])/, 'no lone high surrogate')
  // At the limit exactly nothing is cut.
  const exact: NotificationPayload = { title: 'T', text: 'y'.repeat(DISCORD_CONTENT_MAX - '**T**\n'.length), json: {} }
  assert.equal((JSON.parse(webhookBody('discord', exact)) as { content: string }).content, `**T**\n${exact.text}`)
})

// ---------------------------------------------------------------------------
// C14 item 4 — the requests
// ---------------------------------------------------------------------------

test('the webhook: one POST to the address, JSON with the honest user agent, redirect: error, a signal — and the secret header only when named and stored (1.12 C1 rule 1)', async () => {
  const r = recorder()
  assert.deepEqual(await sendWebhook(HOOK_URL, null, 'generic', TWO, r.fetch, OPTS), { ok: true })
  assert.equal(r.calls.length, 1)
  const [call] = r.calls
  assert.equal(call.url, HOOK_URL)
  assert.equal(call.init.method, 'POST')
  assert.equal(call.init.redirect, 'error')
  assert.ok(call.init.signal instanceof AbortSignal)
  assert.deepEqual(call.init.headers, HEADERS)
  assert.equal(call.init.body, webhookBody('generic', TWO))
  // Named and stored: that one header more, with its value.
  await sendWebhook(HOOK_URL, { header: 'X-Token-Pace-Secret', value: 'synthetic-url-secret-123' }, 'slack', TWO, r.fetch, OPTS)
  assert.deepEqual(r.calls[1].init.headers, { ...HEADERS, 'X-Token-Pace-Secret': 'synthetic-url-secret-123' })
  assert.equal(r.calls[1].init.body.includes('synthetic-url-secret-123'), false)
  // `Authorization` may carry it (a common endpoint's form).
  await sendWebhook(HOOK_URL, { header: 'Authorization', value: 'Bearer synthetic-url-secret-123' }, 'generic', TWO, r.fetch, OPTS)
  assert.equal(r.calls[2].init.headers.Authorization, 'Bearer synthetic-url-secret-123')
  // Without a version the agent is still ours, not Node's.
  await sendWebhook(HOOK_URL, null, 'generic', TWO, r.fetch)
  assert.equal(r.calls[3].init.headers['User-Agent'], 'token-pace')
  // A header name the pattern refuses, one the request sets itself, a value that is no plain header value: an
  // incomplete setup, and nothing sent.
  const before = r.calls.length
  for (const secret of [
    { header: 'X Token', value: 'v' }, { header: 'X-Token:', value: 'v' }, { header: '', value: 'v' }, { header: 'Content-Type', value: 'text/plain' },
    { header: 'host', value: 'evil.example' }, { header: 'User-Agent', value: 'x' }, { header: 'X-Token', value: '' },
    { header: 'X-Token', value: 'a\r\nX-Other: b' }, { header: 'X-Token', value: 'ümlaut' }, { header: 'X-Token', value: ' padded ' },
  ]) {
    assert.deepEqual(await sendWebhook(HOOK_URL, secret, 'generic', TWO, r.fetch, OPTS), { ok: false, kind: 'config' }, JSON.stringify(secret))
  }
  assert.equal(r.calls.length, before, 'nothing sent for an incomplete setup')
})

test('https: only — http:, user:pass@, a fragment, a non-URL: config, and fetch is never called (1.12 C1 rules 1 and 4, httpsOnly)', async () => {
  const r = recorder()
  const refused = ['http://hooks.example.invalid/x', 'https://user:pass@hooks.example.invalid/x', 'https://:pass@hooks.example.invalid/x',
    'https://hooks.example.invalid/x#frag', 'hooks.example.invalid/x', 'ftp://hooks.example.invalid/x', 'file:///etc/passwd', '', ' ', 'https://',
    'javascript:alert(1)', 'data:,x', 'HTTP://hooks.example.invalid/x']
  for (const url of refused) {
    assert.deepEqual(await sendWebhook(url, null, 'generic', TWO, r.fetch, OPTS), { ok: false, kind: 'config' }, url)
    assert.deepEqual(await sendNtfy(url, 'synthetic-topic-789', null, TWO, r.fetch, OPTS), { ok: false, kind: 'config' }, url)
  }
  assert.equal(r.calls.length, 0)
})

test('a 2xx is ok; 401 is http 401; 429 with Retry-After: 120 is a pause of 120 s, at most an hour; a 3xx the fetch did not follow is its status (1.12 C1 rule 6)', async () => {
  const cases: Array<[FetchResponseLike, SendResult]> = [
    [response(200), { ok: true }],
    [response(202), { ok: true }],
    [response(204), { ok: true }],
    [response(401), { ok: false, kind: 'http', status: 401 }],
    [response(404), { ok: false, kind: 'http', status: 404 }],
    [response(500), { ok: false, kind: 'http', status: 500 }],
    [response(302, { location: 'https://elsewhere.example.invalid/' }), { ok: false, kind: 'http', status: 302 }],
    [response(429, { 'retry-after': '120' }), { ok: false, kind: 'http', status: 429, retryAfterSec: 120 }],
    [response(429, { 'retry-after': '99999' }), { ok: false, kind: 'http', status: 429, retryAfterSec: 3600 }],
    [response(429, { 'retry-after': 'Wed, 21 Oct 2026 07:28:00 GMT' }), { ok: false, kind: 'http', status: 429 }],
    [response(429, { 'retry-after': '0' }), { ok: false, kind: 'http', status: 429 }],
    [response(429), { ok: false, kind: 'http', status: 429 }],
  ]
  for (const [res, want] of cases) {
    const r = recorder(() => res)
    assert.deepEqual(await sendWebhook(HOOK_URL, null, 'generic', TWO, r.fetch, OPTS), want, `${res.status} ${JSON.stringify(want)}`)
    assert.deepEqual(await sendTelegram(BOT_TOKEN, '42', TWO, r.fetch, OPTS), want)
    assert.deepEqual(await sendNtfy(NTFY_SERVER, 'synthetic-topic-789', null, TWO, r.fetch, OPTS), want)
  }
})

test('a thrown fetch is one kind: a TLS cause tls, a refused connection or a redirect refused, an abort timeout, anything else network — never its text (1.12 C1 rule 6)', async () => {
  const fail = (message: string, cause?: { code?: string; message?: string; name?: string }): Error => Object.assign(new TypeError(message), { cause })
  const cases: Array<[unknown, SendFailureKind]> = [
    [fail('fetch failed', { code: 'DEPTH_ZERO_SELF_SIGNED_CERT', message: 'self-signed certificate' }), 'tls'],
    [fail('fetch failed', { code: 'CERT_HAS_EXPIRED', message: 'certificate has expired' }), 'tls'],
    [fail('fetch failed', { code: 'ERR_TLS_CERT_ALTNAME_INVALID', message: 'Hostname/IP does not match certificate\'s altnames' }), 'tls'],
    [fail('fetch failed', { code: 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', message: 'unable to verify the first certificate' }), 'tls'],
    [fail('fetch failed', { code: 'ERR_SSL_WRONG_VERSION_NUMBER', message: 'wrong version number' }), 'tls'],
    [fail('fetch failed', { code: 'ECONNREFUSED', message: 'connect ECONNREFUSED 127.0.0.1:1' }), 'refused'],
    [fail('fetch failed', { message: 'unexpected redirect' }), 'refused'],
    [fail('fetch failed', { code: 'ENOTFOUND', message: 'getaddrinfo ENOTFOUND hooks.example.invalid' }), 'network'],
    [fail('fetch failed', { code: 'ECONNRESET', message: 'read ECONNRESET' }), 'network'],
    [fail('fetch failed', { code: 'UND_ERR_SOCKET', message: 'other side closed' }), 'network'],
    [fail('fetch failed', { code: 'UND_ERR_CONNECT_TIMEOUT', message: 'Connect Timeout Error' }), 'timeout'],
    [Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' }), 'timeout'],
    [Object.assign(new Error('This operation was aborted'), { name: 'AbortError' }), 'timeout'],
    [new Error('anything at all: synthetic-url-secret-123'), 'network'],
    ['a string thrown', 'network'],
    [null, 'network'],
  ]
  for (const [err, kind] of cases) {
    assert.deepEqual(failureOf(err), { ok: false, kind }, String((err as Error | null)?.message ?? err))
    const r = recorder(() => { throw err })
    const got = await sendWebhook(HOOK_URL, null, 'generic', TWO, r.fetch, OPTS)
    assert.deepEqual(got, { ok: false, kind })
    assert.deepEqual(Object.keys(got).sort(), ['kind', 'ok'], 'a result is a kind — no text, no URL')
  }
  // A fetch that throws before it returns a promise is the same.
  const sync: FetchLike = () => { throw fail('fetch failed', { code: 'ECONNREFUSED' }) }
  assert.deepEqual(await sendWebhook(HOOK_URL, null, 'generic', TWO, sync, OPTS), { ok: false, kind: 'refused' })
})

test('the response body is never read: cancelled once, never text()/json()/getReader(); a cancel that throws or rejects changes nothing (1.12 C1 rule 6, §0a.9)', async () => {
  for (const status of [200, 401, 429, 500]) {
    const res = response(status)
    await sendWebhook(HOOK_URL, null, 'generic', TWO, recorder(() => res).fetch, OPTS)
    assert.deepEqual(res.reads, [], `${status}: read`)
    assert.equal(res.cancels, 1, `${status}: cancelled`)
  }
  const rejecting = response(200, {}, () => Promise.reject(new Error('cancel failed')))
  assert.deepEqual(await sendWebhook(HOOK_URL, null, 'generic', TWO, recorder(() => rejecting).fetch, OPTS), { ok: true })
  const throwing = response(401, {}, () => { throw new Error('cancel threw') })
  assert.deepEqual(await sendNtfy(NTFY_SERVER, 'topic', null, TWO, recorder(() => throwing).fetch, OPTS), { ok: false, kind: 'http', status: 401 })
  // A body whose very getter throws, and none at all.
  const getter = { status: 204, headers: { get: () => null } } as FetchResponseLike
  Object.defineProperty(getter, 'body', { get: () => { throw new Error('the body was touched') } })
  assert.deepEqual(await sendTelegram(BOT_TOKEN, '42', TWO, recorder(() => getter).fetch, OPTS), { ok: true })
  assert.deepEqual(await sendTelegram(BOT_TOKEN, '42', TWO, recorder(() => ({ status: 200, headers: { get: () => null }, body: null })).fetch, OPTS), { ok: true })
  // A Retry-After whose reading throws is no number, not a failure of its own.
  const badHeaders = { status: 429, headers: { get: (): string => { throw new Error('headers') } }, body: null }
  assert.deepEqual(await sendWebhook(HOOK_URL, null, 'generic', TWO, recorder(() => badHeaders).fetch, OPTS), { ok: false, kind: 'http', status: 429 })
})

test('one send is bounded: a fetch that never answers and ignores its signal ends as timeout at the deadline, its signal aborted; a later answer is let go of unread (1.12 C1 rule 6)', { timeout: 5000 }, async () => {
  let signal: AbortSignal | null = null
  let late: (r: FetchResponseLike) => void = () => undefined
  const hanging: FetchLike = (_url, init) => { signal = init.signal; return new Promise((resolve) => { late = resolve }) }
  const t0 = Date.now()
  assert.deepEqual(await sendWebhook(HOOK_URL, null, 'generic', TWO, hanging, { ...OPTS, timeoutMs: 50 }), { ok: false, kind: 'timeout' })
  const took = Date.now() - t0
  assert.ok(took >= 40 && took < 1000, `${took} ms`)
  assert.equal((signal as AbortSignal | null)?.aborted, true)
  const res = response(200)
  late(res)
  await new Promise((r) => setImmediate(r))
  assert.equal(res.cancels, 1)
  assert.deepEqual(res.reads, [])
  // No deadline beyond the channels' own 15 s: a longer one asked for is cut to it; nonsense is the default.
  const seen: number[] = []
  const quick: FetchLike = async () => { seen.push(1); return response(200) }
  for (const timeoutMs of [60_000, Number.NaN, -1, 0]) assert.deepEqual(await sendWebhook(HOOK_URL, null, 'generic', TWO, quick, { timeoutMs }), { ok: true })
  assert.equal(seen.length, 4)
})

test('Telegram: POST https://api.telegram.org/bot<token>/sendMessage — a token or chat id that does not look like one is config and nothing is sent (1.12 C1 rule 3)', async () => {
  const r = recorder()
  assert.deepEqual(await sendTelegram(BOT_TOKEN, '-1001234567890', TWO, r.fetch, OPTS), { ok: true })
  assert.equal(TELEGRAM_API_HOST, 'api.telegram.org')
  assert.equal(r.calls[0].url, `https://${TELEGRAM_API_HOST}/bot${BOT_TOKEN}/sendMessage`)
  assert.equal(r.calls[0].init.redirect, 'error')
  assert.deepEqual(r.calls[0].init.headers, HEADERS)
  assert.equal(r.calls[0].init.body, telegramBody('-1001234567890', TWO))
  assert.equal(r.calls[0].init.body.includes(BOT_TOKEN), false, 'the token stands in the path only')
  await sendTelegram(BOT_TOKEN, '@synthetic_channel', TWO, r.fetch, OPTS)
  assert.equal((JSON.parse(r.calls[1].init.body) as { chat_id: string }).chat_id, '@synthetic_channel')
  const before = r.calls.length
  // A token with a path, a query or a fragment in it would make another request; a chat id outside Telegram's form.
  for (const [token, chat] of [
    ['123:abc/../../getUpdates?x=', '42'], ['123:abc?offset=1', '42'], ['123:abc#x', '42'], ['abc', '42'], ['', '42'], ['123:', '42'],
    [BOT_TOKEN, ''], [BOT_TOKEN, 'someone'], [BOT_TOKEN, '@abc'], [BOT_TOKEN, '12 34'], [BOT_TOKEN, '1'.repeat(21)],
  ]) {
    assert.deepEqual(await sendTelegram(token, chat, TWO, r.fetch, OPTS), { ok: false, kind: 'config' }, `${token} ${chat}`)
  }
  assert.equal(r.calls.length, before)
})

test('ntfy: the JSON publish to the server\'s address, the topic in the body, Authorization: Bearer only with a token; a topic ntfy refuses is config (1.12 C1 rule 4)', async () => {
  const r = recorder()
  assert.deepEqual(await sendNtfy(NTFY_SERVER, 'synthetic-topic-789', null, TWO, r.fetch, OPTS), { ok: true })
  assert.equal(r.calls[0].url, `${NTFY_SERVER}/`)
  assert.deepEqual(r.calls[0].init.headers, HEADERS)
  assert.equal(r.calls[0].init.body, ntfyBody('synthetic-topic-789', TWO))
  assert.equal(r.calls[0].url.includes('synthetic-topic-789'), false, 'the topic is not in the address')
  await sendNtfy(`${NTFY_SERVER}/ntfy/`, 'synthetic-topic-789', 'tk_synthetic000', TWO, r.fetch, OPTS)
  assert.equal(r.calls[1].url, `${NTFY_SERVER}/ntfy/`, 'a server served under a path keeps it')
  assert.deepEqual(r.calls[1].init.headers, { ...HEADERS, Authorization: 'Bearer tk_synthetic000' })
  // UTF-8 in the body, none in a header.
  const uk: NotificationPayload = { title: 'Token Pace: квота вичерпана', text: 'कोटा समाप्त', json: { event: 'quotaExhausted' } }
  await sendNtfy(NTFY_SERVER, 'synthetic-topic-789', null, uk, r.fetch, OPTS)
  for (const v of Object.values(r.calls[2].init.headers)) assert.match(v, /^[\x20-\x7e]*$/)
  assert.equal((JSON.parse(r.calls[2].init.body) as { title: string }).title, 'Token Pace: квота вичерпана')
  const before = r.calls.length
  for (const [topic, token] of [['', null], ['a/b', null], ['a b', null], ['x'.repeat(65), null], ['ok', ''], ['ok', 'tk a'], ['ok', 'tk\r\nX: y']] as Array<[string, string | null]>) {
    assert.deepEqual(await sendNtfy(NTFY_SERVER, topic, token, TWO, r.fetch, OPTS), { ok: false, kind: 'config' }, `${topic} ${token}`)
  }
  assert.equal(r.calls.length, before)
})

test('no English, and no host literal but Telegram\'s: the channels return kinds, the host words them (1.12 §4 P7, C11 rule 1)', () => {
  const src = readFileSync(join(ROOT, 'src', 'notifyChannels.ts'), 'utf8')
  assert.doesNotMatch(src, /from '\.\/i18n'/)
  assert.doesNotMatch(src, /(?<![\w$.])t\(/)
  const { scanBundle, DEFAULT_ALLOW } = require('../scripts/check-privacy.mjs') as {
    scanBundle: (text: string, allow?: string[]) => { urls: Array<{ host: string }>; offenders: unknown[] }
    DEFAULT_ALLOW: string[]
  }
  const scan = scanBundle(src, DEFAULT_ALLOW)
  assert.deepEqual([...new Set(scan.urls.map((u) => u.host))], [TELEGRAM_API_HOST])
  assert.deepEqual(scan.offenders, [])
})

// ---------------------------------------------------------------------------
// C14 item 3 over the channels (P6-O3): nothing planted in the notifier's inputs reaches a body
// ---------------------------------------------------------------------------

function win(over: Partial<QuotaWindow> = {}): QuotaWindow {
  return {
    id: 'session:300', kind: 'session', label: '5 h', shortLabel: '5h', model: null, percent: 82,
    resetsAt: NOW + 2 * HOUR, windowMinutes: 300, limitReached: false, unlimited: false, ...over,
  }
}

function lastRequest(over: Partial<LastRequest> = {}): LastRequest {
  return { at: NOW - 10 * MIN, ttl: '5m', context: 1000, model: 'claude-opus-5-5', stop: 'end_turn', replyPending: false, ...over }
}

function main(over: Partial<MainRec> = {}): MainRec {
  return {
    source: 'claude', sessionId: '9d0eb37a-synthetic', firstTs: NOW - 5 * HOUR, lastTs: NOW - 10 * MIN, models: ['claude-opus-5-5'],
    input: 1, cacheWrite: 0, cacheWrite1h: 0, cacheRead: 0, output: 1, reasoning: 0, requests: 1, outputFinal: 1, toolCalls: 0,
    ccVersion: null, permissionMode: null, compactions: 0, lastCompaction: null, lastRequest: lastRequest(), lastUserAt: null, ...over,
  }
}

test('C14 item 3 over the channels: a synthetic token, a project path and a transcript line planted in the notifier\'s inputs reach no URL, header or body of any format — and each secret stands only where its request needs it (1.12 §0a.8–§0a.10, P6-O3)', async () => {
  const TOKEN = 'synthetic-token-XYZ'
  const PROJECT = '/home/u/synthetic-project-123'
  const LINE = 'Synthetic transcript line: please refactor the parser'
  const SESSION = '9d0eb37a-synthetic'
  const planted = [TOKEN, PROJECT, 'synthetic-project-123', LINE, SESSION, '9d0eb37a', 'synthetic-plan']
  const cfg = readNotifyConfig((k) => ({
    'tokenPace.notifications.channels': ['webhook', 'telegram', 'ntfy'],
    'tokenPace.notifications.events': ['agentWaiting', 'agentDone', 'quotaThreshold', 'quotaExhausted', 'quotaReset', 'paceWarning'],
    'tokenPace.notifications.cooldownMinutes': 1,
  } as Record<string, unknown>)[k])
  const reading = (source: 'claude' | 'codex', windows: QuotaWindow[]): QuotaState => ({
    source, ok: true, origin: 'poll', fetchedAt: Math.floor((NOW - MIN) / 1000), planType: 'synthetic-plan', windows,
    problem: `${LINE} ${TOKEN}`, drift: [PROJECT, TOKEN],
  })
  const forecast: Forecast = {
    state: 'eta', ratePerHour: 10, etaMs: NOW + 90 * MIN, endPercent: 120, sustainablePerHour: 5, confidence: 'high',
    basis: { samples: 8, spanMs: HOUR }, text: LINE,
  }
  const hook: HookEntry = { ts: NOW - 19 * MIN, event: 'PermissionRequest', sessionId: SESSION, agentId: null, wait: 'permission' }
  const open = main({ lastRequest: lastRequest({ replyPending: true, stop: null, model: `claude-${TOKEN}` }), lastTs: NOW - 20 * MIN, models: [LINE] })
  const st = emptyNotifyState()
  st.cycles['claude:session:300'] = { resetsAt: NOW - 5 * MIN, percent: 97, seenAt: NOW - 10 * MIN }
  const tables = newNotifyTables()
  const world = (now: number, mains: MainRec[]): NotifyInput => ({
    states: now < NOW ? [] : [
      reading('claude', [win({ percent: 4, resetsAt: NOW + 5 * HOUR - 5 * MIN }), win({ id: 'weekly_all:10080', kind: 'weekly', label: '7 d', shortLabel: '7d', percent: 100, resetsAt: NOW + 3 * 24 * HOUR, windowMinutes: 10080 }), win({ id: 'weekly_scoped:10080:fable', kind: 'weekly', label: '7 d · Fable', shortLabel: '7d', percent: 90, resetsAt: NOW + 3 * 24 * HOUR, windowMinutes: 10080 })]),
      reading('codex', [win({ id: 'codex:300', percent: 60 })]),
    ],
    forecasts: new Map([['codex:codex:300', forecast]]),
    mains, hooks: [hook], focused: false, settled: true, role: 'leader', staleAfterMs: 20 * MIN,
  })
  const payloads: NotificationPayload[] = []
  for (const [now, mains] of [[NOW - 16 * MIN, [open]], [NOW, [main({ lastTs: NOW - MIN, models: [LINE] })]]] as Array<[number, MainRec[]]>) {
    for (const group of admit(collectEvents(world(now, mains), cfg, st, tables, now), cfg, st, now).send) payloads.push(payloadOf(group, WORDS))
  }
  payloads.push(testPayload(WORDS))
  assert.deepEqual(payloads.map((p) => p.json.event).sort(), ['agentDone', 'agentWaiting', 'paceWarning', 'quotaExhausted', 'quotaReset', 'quotaThreshold', 'test'])
  const secrets = { url: HOOK_URL, header: 'synthetic-url-secret-123', bot: BOT_TOKEN, topic: 'synthetic-topic-789', ntfyToken: 'tk_synthetic000' }
  const r = recorder()
  for (const p of payloads) {
    for (const format of WEBHOOK_FORMATS) await sendWebhook(secrets.url, { header: 'X-Secret', value: secrets.header }, format, p, r.fetch, OPTS)
    await sendTelegram(secrets.bot, '-1001234567890', p, r.fetch, OPTS)
    await sendNtfy(NTFY_SERVER, secrets.topic, secrets.ntfyToken, p, r.fetch, OPTS)
  }
  assert.equal(r.calls.length, payloads.length * (WEBHOOK_FORMATS.length + 2))
  for (const call of r.calls) {
    const all = `${call.url}\n${JSON.stringify(call.init.headers)}\n${call.init.body}`
    for (const s of planted) assert.equal(all.includes(s), false, `${s} reached ${call.url.slice(0, 30)}…`)
    const isTelegram = call.url.startsWith(`https://${TELEGRAM_API_HOST}/`)
    const isNtfy = call.url.startsWith(NTFY_SERVER)
    // Each secret only where its request needs it: the address and its header for the webhook, the token in the
    // Telegram path, the ntfy token in Authorization and the topic in the ntfy body — never in another request,
    // never in a body but the topic's.
    assert.equal(call.url.includes('synthetic-webhook-path-321'), !isTelegram && !isNtfy)
    assert.equal(JSON.stringify(call.init.headers).includes(secrets.header), !isTelegram && !isNtfy)
    assert.equal(call.url.includes(secrets.bot), isTelegram)
    assert.equal(JSON.stringify(call.init.headers).includes(secrets.ntfyToken), isNtfy)
    assert.equal(call.init.body.includes(secrets.topic), isNtfy)
    for (const s of [secrets.header, secrets.bot, secrets.ntfyToken, 'synthetic-webhook-path-321']) assert.equal(call.init.body.includes(s), false, `${s} in a body`)
  }
})

// ---------------------------------------------------------------------------
// Against a local HTTPS server (127.0.0.1, port 0) — the real fetch, trusting exactly the test's certificate
// ---------------------------------------------------------------------------

interface Pem { key: string; cert: string }
let pems: { own: Pem; other: Pem } | string | undefined

/**
 * Two throwaway self-signed certificates for 127.0.0.1, made by `openssl` in a temp dir that is removed before
 * this returns — no private key is committed or left behind. Where `openssl` is not on the PATH (the Windows CI)
 * the server tests are skipped with this reason.
 */
function certificates(): { own: Pem; other: Pem } | string {
  if (pems !== undefined) return pems
  const probe = spawnSync('openssl', ['version'], { encoding: 'utf8', timeout: 5000 })
  if (probe.status !== 0) return (pems = 'openssl is not on the PATH — the local HTTPS server tests are skipped')
  const dir = mkdtempSync(join(tmpdir(), 'tp-channels-'))
  try {
    const make = (name: string): Pem | null => {
      const key = join(dir, `${name}.key`)
      const cert = join(dir, `${name}.pem`)
      const r = spawnSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256', '-nodes', '-days', '1',
        '-subj', '/CN=127.0.0.1', '-addext', 'subjectAltName=IP:127.0.0.1', '-keyout', key, '-out', cert], { stdio: 'ignore', timeout: 10_000 })
      return r.status === 0 ? { key: readFileSync(key, 'utf8'), cert: readFileSync(cert, 'utf8') } : null
    }
    const own = make('own')
    const other = make('other')
    pems = own !== null && other !== null ? { own, other } : 'openssl could not make a certificate — the local HTTPS server tests are skipped'
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
  return pems
}

type Dispatcher = { destroy(): Promise<void> }
type AgentClass = new (opts: { connect: { ca: string } }) => Dispatcher

/**
 * The dispatcher class of Node's own fetch (undici's `Agent`, reached through the global dispatcher Node sets
 * after its first fetch — a `data:` URL, which touches no socket). A dispatcher made from it with
 * `connect: { ca }` trusts exactly that certificate, for the requests it is passed to and no other.
 */
async function agentClass(): Promise<AgentClass | string> {
  await (await fetch('data:,x')).arrayBuffer()
  const d = (globalThis as Record<symbol, unknown>)[Symbol.for('undici.globalDispatcher.1')] as { constructor?: AgentClass } | undefined
  return typeof d?.constructor === 'function' ? d.constructor : 'Node\'s fetch has no dispatcher class to trust one certificate with — skipped'
}

interface Seen { method: string; url: string; headers: http.IncomingHttpHeaders; body: string }

/** Every socket a server accepts, so the `finally` can end them — an answer left open (the test of a body that never ends) included. */
function track(server: http.Server | https.Server): Set<Socket> {
  const sockets = new Set<Socket>()
  server.on('connection', (sock: Socket) => {
    sockets.add(sock)
    sock.on('close', () => sockets.delete(sock))
  })
  return sockets
}

async function closeServer(server: http.Server | https.Server, sockets: Set<Socket>): Promise<void> {
  for (const sock of sockets) sock.destroy()
  server.closeAllConnections()
  await new Promise<void>((resolve) => server.close(() => resolve()))
}
type Handler = (req: http.IncomingMessage, res: http.ServerResponse) => void

interface Served { base: string; fetch: FetchLike; seen: Seen[]; fetches: number }

/**
 * A local HTTPS server for one test: listens on 127.0.0.1 port 0 with `serve`'s certificate, records every
 * request once its body arrived, answers with `handler`; the client is the real fetch with a dispatcher that
 * trusts `trust`'s certificate. The server's connections are closed, the server and the dispatcher are ended
 * in a `finally`.
 */
async function withServer(
  t: { skip(reason: string): void },
  handler: Handler,
  fn: (s: Served) => Promise<void>,
  certs: { serve: 'own' | 'other'; trust: 'own' | 'other' } = { serve: 'own', trust: 'own' },
): Promise<void> {
  const pem = certificates()
  if (typeof pem === 'string') { t.skip(pem); return }
  const Agent = await agentClass()
  if (typeof Agent === 'string') { t.skip(Agent); return }
  const seen: Seen[] = []
  const server = https.createServer({ key: pem[certs.serve].key, cert: pem[certs.serve].cert }, (req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      seen.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers, body: Buffer.concat(chunks).toString('utf8') })
      handler(req, res)
    })
  })
  const sockets = track(server)
  const agent = new Agent({ connect: { ca: pem[certs.trust].cert } })
  try {
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const base = `https://127.0.0.1:${(server.address() as AddressInfo).port}`
    const served: Served = {
      base,
      seen,
      fetches: 0,
      fetch: (url, init) => { served.fetches++; return fetch(url, { ...init, dispatcher: agent } as RequestInit) },
    }
    await fn(served)
  } finally {
    await closeServer(server, sockets)
    await agent.destroy()
  }
}

test('local HTTPS: the webhook arrives as one POST with P6\'s JSON, our two headers, and the secret header only when configured (1.12 C1 rule 1)', { timeout: 5000 }, async (t) => {
  await withServer(t, (_req, res) => { res.writeHead(204); res.end() }, async (s) => {
    assert.deepEqual(await sendWebhook(`${s.base}/hook`, null, 'generic', TWO, s.fetch, OPTS), { ok: true })
    assert.deepEqual(await sendWebhook(`${s.base}/hook`, { header: 'X-Token-Pace-Secret', value: 'synthetic-url-secret-123' }, 'generic', TWO, s.fetch, OPTS), { ok: true })
    assert.equal(s.seen.length, 2)
    const [plain, secret] = s.seen
    for (const req of s.seen) {
      assert.equal(req.method, 'POST')
      assert.equal(req.url, '/hook')
      assert.equal(req.headers['content-type'], 'application/json; charset=utf-8')
      assert.equal(req.headers['user-agent'], `token-pace/${VERSION}`)
      assert.equal(req.body, webhookBody('generic', TWO))
      assert.deepEqual(Object.keys(JSON.parse(req.body) as object).filter((k) => k !== 'items'), JSON_KEYS)
    }
    assert.equal(plain.headers['x-token-pace-secret'], undefined)
    assert.equal(secret.headers['x-token-pace-secret'], 'synthetic-url-secret-123')
    assert.equal(JSON.stringify(plain.headers).includes('synthetic-url-secret-123'), false)
  })
})

test('local HTTPS: Telegram and ntfy go the same way — the path with the token, the topic in the body, Authorization only with a token (1.12 C1 rules 3–4)', { timeout: 5000 }, async (t) => {
  await withServer(t, (_req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"ok":true,"result":{"synthetic":"reply"}}') }, async (s) => {
    // Telegram's one literal host, answered here by the local server: the address is rewritten for the dispatcher alone.
    const toLocal: FetchLike = (url, init) => s.fetch(url.replace(`https://${TELEGRAM_API_HOST}`, s.base), init)
    assert.deepEqual(await sendTelegram(BOT_TOKEN, '42', TWO, toLocal, OPTS), { ok: true })
    assert.deepEqual(await sendNtfy(s.base, 'synthetic-topic-789', null, TWO, s.fetch, OPTS), { ok: true })
    assert.deepEqual(await sendNtfy(s.base, 'synthetic-topic-789', 'tk_synthetic000', TWO, s.fetch, OPTS), { ok: true })
    assert.deepEqual(s.seen.map((x) => [x.method, x.url]), [['POST', `/bot${BOT_TOKEN}/sendMessage`], ['POST', '/'], ['POST', '/']])
    assert.equal(s.seen[0].body, telegramBody('42', TWO))
    assert.equal(s.seen[1].body, ntfyBody('synthetic-topic-789', TWO))
    assert.equal(s.seen[1].headers.authorization, undefined)
    assert.equal(s.seen[2].headers.authorization, 'Bearer tk_synthetic000')
  })
})

test('local: http: is refused before any connection — a plain server on 127.0.0.1 sees none, fetch is never called (1.12 C1 rule 1, §0a.9)', { timeout: 5000 }, async (t) => {
  let connections = 0
  const plain = http.createServer((_req, res) => { res.writeHead(200); res.end() })
  plain.on('connection', () => { connections++ })
  const sockets = track(plain)
  try {
    await new Promise<void>((resolve) => plain.listen(0, '127.0.0.1', resolve))
    const url = `http://127.0.0.1:${(plain.address() as AddressInfo).port}/hook`
    await withServer(t, (_req, res) => { res.writeHead(200); res.end() }, async (s) => {
      assert.deepEqual(await sendWebhook(url, null, 'generic', TWO, s.fetch, OPTS), { ok: false, kind: 'config' })
      assert.deepEqual(await sendNtfy(url.replace('/hook', ''), 'synthetic-topic-789', null, TWO, s.fetch, OPTS), { ok: false, kind: 'config' })
      assert.equal(s.fetches, 0)
    })
    assert.equal(connections, 0)
  } finally {
    await closeServer(plain, sockets)
  }
})

test('local HTTPS: a 3xx is not followed — the one request to the address, none to where it points, and the send refused (1.12 §0a.9, redirect: error)', { timeout: 5000 }, async (t) => {
  await withServer(t, (req, res) => {
    if (req.url === '/hook') { res.writeHead(302, { location: '/elsewhere' }); res.end(); return }
    if (req.url === '/hook307') { res.writeHead(307, { location: '/elsewhere' }); res.end(); return }
    res.writeHead(200); res.end()
  }, async (s) => {
    assert.deepEqual(await sendWebhook(`${s.base}/hook`, null, 'generic', TWO, s.fetch, OPTS), { ok: false, kind: 'refused' })
    assert.deepEqual(await sendWebhook(`${s.base}/hook307`, { header: 'X-Secret', value: 'synthetic-url-secret-123' }, 'discord', TWO, s.fetch, OPTS), { ok: false, kind: 'refused' })
    assert.deepEqual(s.seen.map((x) => x.url), ['/hook', '/hook307'], 'nothing reached /elsewhere')
  })
})

test('local HTTPS: the body is never read — an answer whose body never ends is ok at once; an error page\'s text reaches no result (1.12 C1 rule 6, §0a.9)', { timeout: 5000 }, async (t) => {
  await withServer(t, (req, res) => {
    if (req.url === '/open') { res.writeHead(200, { 'content-type': 'text/plain' }); res.write('a body that never ends — '); return }
    res.writeHead(500, { 'content-type': 'text/html' }); res.end('<h1>synthetic error page echoing synthetic-url-secret-123</h1>')
  }, async (s) => {
    const t0 = Date.now()
    assert.deepEqual(await sendWebhook(`${s.base}/open`, null, 'generic', TWO, s.fetch, { ...OPTS, timeoutMs: 3000 }), { ok: true })
    assert.ok(Date.now() - t0 < 1500, `${Date.now() - t0} ms — the send waited for the body`)
    const failed = await sendWebhook(`${s.base}/error`, null, 'generic', TWO, s.fetch, OPTS)
    assert.deepEqual(failed, { ok: false, kind: 'http', status: 500 })
    assert.equal(JSON.stringify(failed).includes('synthetic'), false)
  })
})

test('local HTTPS: a server that never answers ends the send as timeout at its deadline (1.12 C1 rule 6)', { timeout: 5000 }, async (t) => {
  await withServer(t, () => { /* never answers */ }, async (s) => {
    const t0 = Date.now()
    assert.deepEqual(await sendNtfy(s.base, 'synthetic-topic-789', null, TWO, s.fetch, { ...OPTS, timeoutMs: 300 }), { ok: false, kind: 'timeout' })
    const took = Date.now() - t0
    assert.ok(took >= 250 && took < 2000, `${took} ms`)
  })
})

test('local HTTPS: certificates are verified — a server whose certificate the client does not trust is tls, and it sees no request (1.12 C1 rule 6)', { timeout: 5000 }, async (t) => {
  await withServer(t, (_req, res) => { res.writeHead(200); res.end() }, async (s) => {
    assert.deepEqual(await sendWebhook(`${s.base}/hook`, null, 'generic', TWO, s.fetch, OPTS), { ok: false, kind: 'tls' })
    assert.deepEqual(s.seen, [])
  }, { serve: 'other', trust: 'own' })
})

test('local: a port nobody listens on is refused (1.12 C1 rule 6)', { timeout: 5000 }, async (t) => {
  // A port the OS gave a server a moment ago and that is closed now.
  const probe = http.createServer()
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve))
  const port = (probe.address() as AddressInfo).port
  await new Promise<void>((resolve) => probe.close(() => resolve()))
  await withServer(t, (_req, res) => { res.writeHead(200); res.end() }, async (s) => {
    assert.deepEqual(await sendWebhook(`https://127.0.0.1:${port}/hook`, null, 'generic', TWO, s.fetch, OPTS), { ok: false, kind: 'refused' })
  })
})
