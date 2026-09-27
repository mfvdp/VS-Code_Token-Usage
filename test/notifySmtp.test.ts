// SPDX-FileCopyrightText: 2026 Frederik Marx
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * 1.12 C10, C14 item 5 (P8): e-mail over SMTP — TLS before anything that matters, certificates verified, AUTH
 * PLAIN or LOGIN, one message, QUIT and the connection closed. First against a scripted SMTP server in memory
 * (an injected `SmtpTransport` whose sockets are a Duplex pair, its "TLS upgrade" a new pair — every byte the
 * server received recorded per phase, plain or TLS), then against real servers the tests start on 127.0.0.1
 * port 0 (`net` for STARTTLS, `tls` for implicit TLS, throwaway self-signed certificates made by `openssl` in a
 * temp dir that is removed at once, the client trusting exactly the test's certificate through
 * `smtpTransport({ ca })` — never NODE_TLS_REJECT_UNAUTHORIZED, never a global), with a recording TCP relay in
 * between so a test reads the bytes as they went over the wire; and `openssl s_client` as an independent
 * client of the same servers. The real-socket tests run only where `openssl` is on the PATH and are skipped
 * with the reason printed elsewhere (the Windows CI). No private key is committed.
 *
 * Every server, relay and child is ended in a `finally`; each test has a timeout of its own ≤ 5 s; after each
 * test the open-handle check (`afterEach`) holds that no socket, server, timer or child process is left — and
 * the file ends without `--test-force-exit`. No test reaches a host of a service (the fakes use `.invalid`).
 */

import { strict as assert } from 'node:assert'
import { spawn, spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import * as net from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Duplex } from 'node:stream'
import { afterEach, test } from 'node:test'
import * as tls from 'node:tls'
import { HookEntry } from '../src/agentTree'
import { NotifyConfig, readNotifyConfig } from '../src/config'
import {
  admit, collectEvents, emptyNotifyState, newNotifyTables, NotificationEvent, NotificationPayload, NotifyInput, NotifyWords,
  payloadOf, testPayload,
} from '../src/notify'
import {
  dotStuff, EHLO_DOMAIN, encodeHeaderWord, MESSAGE_ID_DOMAIN, messageOf, rfc5322Date, sendMail, SMTP_REPLY_TIMEOUT_MS,
  SMTP_SEND_TIMEOUT_MS, SmtpSettings, SmtpTransport, smtpTransport,
} from '../src/notifySmtp'
import { TimeConfig } from '../src/time'
import { Forecast, LastRequest, MainRec, QuotaState, QuotaWindow } from '../src/types'
import { ROOT } from './helpers/nls'

const NOW = Date.UTC(2026, 8, 27, 12, 0)
const SEC = 1000
const MIN = 60 * SEC
const HOUR = 60 * MIN
const TCFG: TimeConfig = { zone: 'utc', dayBoundaryHour: 0, startOfWeek: 'monday', hourCycle: 'h23' }
const WORDS: NotifyWords = { tcfg: TCFG, now: NOW }

const USER = 'synthetic-user'
const PASSWORD = 'synthetic-password-000'
const FROM = 'token-pace@example.invalid'
const TO = 'reader@example.invalid'
/** The settings as the sanitiser leaves them — a `.invalid` host (RFC 2606) that no resolver answers. */
function settings(over: Partial<SmtpSettings> = {}): SmtpSettings {
  return readNotifyConfig((k) => (k === 'tokenPace.notifications.email'
    ? { host: 'smtp.example.invalid', port: 587, security: 'starttls', user: USER, from: FROM, to: TO, ...over }
    : undefined)).email
}
const b64 = (s: string): string => Buffer.from(s, 'utf8').toString('base64')
const unb64 = (s: string): string => Buffer.from(s, 'base64').toString('utf8')
/** What the password looks like in each AUTH form — none of these may stand before TLS. */
const SECRET_FORMS = [PASSWORD, b64(PASSWORD), b64(`\0${USER}\0${PASSWORD}`), USER, b64(USER)]
const ADDRESSES = [FROM, TO]

function ev(over: Partial<NotificationEvent> = {}): NotificationEvent {
  return {
    event: 'quotaThreshold', identity: 'quotaThreshold:claude:session:300:x', provider: 'claude', program: null, windowLabel: '5 h',
    windowKind: 'session', percent: 82, resetsAt: NOW + 2 * HOUR, etaAt: null, since: null, atLeastMs: null, wait: null, at: NOW - MIN,
    ...over,
  }
}
/** Two windows past their threshold in one message (C2 rule 3) — the payload P6 builds, English. */
const TWO = payloadOf([ev(), ev({ provider: 'codex', windowLabel: '7 d', windowKind: 'weekly', percent: 91, resetsAt: NOW + 3 * 24 * HOUR })], WORDS)
const TWO_TEXT = 'Claude, 5 h window: 82% used — resets at 14:00.\nCodex, 7 d window: 91% used — resets at We 12:00.'

// ---------------------------------------------------------------------------
// The open-handle check (C10 rule 10's third mutation; §0b.10's bound)
// ---------------------------------------------------------------------------

/** The kinds of handle a send, a server, a relay, a child or a timer would leave behind. */
const LEAK_KINDS = new Set(['TCPSocketWrap', 'TCPServerWrap', 'TCPWrap', 'TLSWrap', 'ConnectWrap', 'ShutdownWrap', 'SimpleShutdownWrap', 'Timeout', 'ProcessWrap', 'Immediate'])

function leaks(): string[] {
  return process.getActiveResourcesInfo().filter((kind) => LEAK_KINDS.has(kind)).sort()
}

afterEach(async () => {
  // A destroyed socket's handle closes on the next turns of the loop — give it up to half a second.
  const until = Date.now() + 500
  while (leaks().length > 0 && Date.now() < until) await new Promise<void>((resolve) => setImmediate(resolve))
  assert.deepEqual(leaks(), [], 'a test left a socket, a server, a timer or a child process behind')
})

// ---------------------------------------------------------------------------
// The scripted SMTP server — one script, spoken over a Duplex pair or a real socket
// ---------------------------------------------------------------------------

interface Script {
  /** The plain EHLO reply's keywords — AUTH offered before TLS too, to show the client does not take it. */
  plainKeywords?: string[]
  /** The EHLO reply's keywords over TLS. */
  tlsKeywords?: string[]
  /** The reply to STARTTLS; 220 goes on to the handshake. */
  startTls?: number
  /** Bytes sent right after the 220 to STARTTLS, in the same write — a pipelined injection. */
  inject?: string
  /** The final AUTH reply and its text (a server may echo anything — the client keeps none of it). */
  auth?: number
  authText?: string
  mail?: number
  rcpt?: number
  data?: number
  end?: number
  /** From this step on the server says nothing. */
  silentAt?: 'greeting' | 'ehlo' | 'end' | 'quit'
  /** Each reply this many ms late. */
  delayMs?: number
  /** The greeting is not SMTP. */
  garbage?: boolean
  /** The connection is closed instead of answering this step. */
  closeAt?: 'ehlo'
}

interface Phase { tls: boolean; bytes: string }

interface Out {
  write(text: string): void
  end(): void
  /** Called once the 220 to STARTTLS is written: the next bytes are a TLS handshake. */
  startTls(): void
}

/**
 * The server's side of one conversation: what it received, per phase (plain, then TLS), byte for byte; the
 * dialogue both sides spoke, line by line (`C:`/`S:`, `-- TLS --` at the upgrade); the message as DATA carried it.
 */
class SmtpScript {
  readonly phases: Phase[] = []
  readonly dialogue: string[] = []
  message = ''
  quit = false
  closed = false
  private mode: 'command' | 'data' | 'user' | 'pass' = 'command'
  private buf = ''
  private out: Out | null = null
  private upgrading = false

  constructor(readonly s: Script = {}) {}

  /** A new connection or the TLS phase of this one: from here `out` answers. */
  begin(out: Out, secure: boolean): void {
    const first = this.phases.length === 0
    this.out = out
    this.phases.push({ tls: secure, bytes: '' })
    if (secure && !first) this.dialogue.push('-- TLS --')
    if (!first) return
    if (secure) this.dialogue.push('-- TLS --')
    if (this.s.silentAt === 'greeting') return
    if (this.s.garbage === true) { this.say('HTTP/1.1 400 Bad Request'); return }
    this.say(`220 smtp.example.invalid ESMTP synthetic`)
  }

  feed(chunk: Buffer | string): void {
    if (this.upgrading) return
    const text = typeof chunk === 'string' ? chunk : chunk.toString('latin1')
    this.phases[this.phases.length - 1].bytes += text
    this.buf += text
    for (let at = this.buf.indexOf('\r\n'); at !== -1; at = this.buf.indexOf('\r\n')) {
      const line = this.buf.slice(0, at)
      this.buf = this.buf.slice(at + 2)
      this.dialogue.push(`C: ${line}`)
      this.line(line)
    }
  }

  ended(): void {
    this.closed = true
  }

  private say(text: string, extra = ''): void {
    const out = this.out
    if (out === null) return
    for (const l of text.split('\r\n')) this.dialogue.push(`S: ${l}`)
    const send = (): void => out.write(`${text}\r\n${extra}`)
    if (this.s.delayMs !== undefined) setTimeout(send, this.s.delayMs)
    else send()
  }

  private ehlo(keywords: string[]): string {
    return ['smtp.example.invalid greets [127.0.0.1]', ...keywords].map((k, i, all) => `250${i === all.length - 1 ? ' ' : '-'}${k}`).join('\r\n')
  }

  private line(line: string): void {
    const s = this.s
    if (this.mode === 'data') {
      if (line === '.') {
        this.mode = 'command'
        if (s.silentAt !== 'end') this.say(`${s.end ?? 250} 2.0.0 Ok: queued as SYNTHETIC`)
        return
      }
      this.message += `${line}\r\n`
      return
    }
    if (this.mode === 'user') { this.mode = 'pass'; this.say('334 UGFzc3dvcmQ6'); return }
    if (this.mode === 'pass') { this.mode = 'command'; this.say(`${s.auth ?? 235} ${s.authText ?? '2.7.0 Authentication successful'}`); return }
    const upper = line.toUpperCase()
    if (upper.startsWith('EHLO ')) {
      if (s.closeAt === 'ehlo') { this.out?.end(); return }
      if (s.silentAt === 'ehlo') return
      const secure = this.phases[this.phases.length - 1].tls
      this.say(this.ehlo(secure ? (s.tlsKeywords ?? ['PIPELINING', 'AUTH PLAIN LOGIN', '8BITMIME']) : (s.plainKeywords ?? ['PIPELINING', 'SIZE 10240000', 'STARTTLS', 'AUTH PLAIN LOGIN'])))
      return
    }
    if (upper === 'STARTTLS') {
      const code = s.startTls ?? 220
      if (code !== 220) { this.say(`${code} 4.7.0 TLS not available`); return }
      this.say('220 2.0.0 Ready to start TLS', s.inject ?? '')
      this.upgrading = true
      this.buf = ''
      this.out?.startTls()
      return
    }
    if (upper.startsWith('AUTH PLAIN ')) { this.say(`${s.auth ?? 235} ${s.authText ?? '2.7.0 Authentication successful'}`); return }
    if (upper === 'AUTH LOGIN') { this.mode = 'user'; this.say('334 VXNlcm5hbWU6'); return }
    if (upper.startsWith('MAIL FROM:')) { this.say(`${s.mail ?? 250} 2.1.0 Ok`); return }
    if (upper.startsWith('RCPT TO:')) { this.say(`${s.rcpt ?? 250} 2.1.5 Ok`); return }
    if (upper === 'DATA') {
      const code = s.data ?? 354
      if (code === 354) this.mode = 'data'
      this.say(`${code} End data with <CR><LF>.<CR><LF>`)
      return
    }
    if (upper === 'QUIT') {
      this.quit = true
      if (s.silentAt === 'quit') return
      this.say('221 2.0.0 Bye')
      this.out?.end()
      return
    }
    this.say('500 5.5.2 Error: command not recognized')
  }

  /** The TLS phase begins (the upgrade stands). */
  secured(out: Out): void {
    this.upgrading = false
    this.begin(out, true)
  }
}

/** Two Duplex ends wired to each other — what one writes the other reads; one destroyed ends the other. */
function duplexPair(): [Duplex, Duplex] {
  const ends: Duplex[] = []
  const make = (peer: () => Duplex): Duplex => new Duplex({
    read() { /* pushed by the peer */ },
    write(chunk: Buffer, _enc, cb) { const p = peer(); if (!p.destroyed) p.push(chunk); cb() },
    final(cb) { const p = peer(); if (!p.destroyed) p.push(null); cb() },
  })
  ends.push(make(() => ends[1]), make(() => ends[0]))
  for (const [a, b] of [[ends[0], ends[1]], [ends[1], ends[0]]]) {
    a.on('error', () => undefined)
    a.on('close', () => b.destroy())
  }
  return [ends[0], ends[1]]
}

interface Memory {
  transport: SmtpTransport
  server: SmtpScript
  calls: string[]
  /** Every end made — all destroyed once the send is over (the open-handle check's in-memory half). */
  ends: Duplex[]
}

/**
 * The in-memory server: `connectPlain`/`connectTls` hand the client one end of a pair, the script speaks on the
 * other; `upgrade` is the "TLS handshake" — a new pair, the script's TLS phase, the old pair ended with the new.
 */
function memory(script: Script = {}, fault: { connect?: 'refused'; upgrade?: 'certificate' } = {}): Memory {
  const server = new SmtpScript(script)
  const calls: string[] = []
  const ends: Duplex[] = []
  const serve = (secure: boolean, old: Duplex | null): Duplex => {
    const [client, srv] = duplexPair()
    ends.push(client, srv)
    const out: Out = { write: (text) => { if (!srv.destroyed) srv.write(text) }, end: () => srv.end(), startTls: () => undefined }
    srv.on('data', (chunk: Buffer) => server.feed(chunk))
    srv.on('close', () => server.ended())
    if (old !== null) {
      client.on('close', () => old.destroy())
      server.secured(out)
    } else {
      server.begin(out, secure)
    }
    return client
  }
  const refused = (): Error => Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:587'), { code: 'ECONNREFUSED' })
  const transport: SmtpTransport = {
    connectPlain: async (host, port) => {
      calls.push(`connectPlain ${host}:${port}`)
      if (fault.connect === 'refused') throw refused()
      return serve(false, null)
    },
    connectTls: async (host, port) => {
      calls.push(`connectTls ${host}:${port}`)
      if (fault.connect === 'refused') throw refused()
      return serve(true, null)
    },
    upgrade: async (sock, host) => {
      calls.push(`upgrade ${host}`)
      if (fault.upgrade === 'certificate') throw Object.assign(new Error('self-signed certificate'), { code: 'DEPTH_ZERO_SELF_SIGNED_CERT' })
      return serve(true, sock)
    },
  }
  return { transport, server, calls, ends }
}

/** A turn of the loop, so a close the send caused reaches the server. */
const settle = (): Promise<void> => new Promise<void>((resolve) => setImmediate(resolve))

/** Turns of the loop until `ok()` — at most `ms` (a close crosses the relay and the server's TLS socket first). */
async function until(ok: () => boolean, ms = 1000): Promise<boolean> {
  const end = Date.now() + ms
  while (!ok() && Date.now() < end) await new Promise<void>((resolve) => setTimeout(resolve, 5))
  return ok()
}

/** The dialogue with the random Message-ID written as `<id>` — the one line no two sends share. */
function dialogueOf(server: SmtpScript): string[] {
  return server.dialogue.map((l) => l.replace(/^C: Message-ID: <[0-9a-f]{32}@token-pace\.invalid>$/, 'C: Message-ID: <id>'))
}

/** Everything the server received before the first TLS phase. */
function plainBytes(server: SmtpScript): string {
  return server.phases.filter((p) => !p.tls).map((p) => p.bytes).join('')
}

function assertNothingSecretIn(bytes: string, where: string): void {
  for (const s of [...SECRET_FORMS, ...ADDRESSES, 'AUTH', 'MAIL FROM', 'RCPT TO', 'DATA']) {
    assert.equal(bytes.includes(s), false, `${s} ${where}`)
  }
}

/** The message's headers (unfolded) and its body decoded. */
function parseMessage(raw: string): { headers: Array<[string, string]>; body: string; bodyLines: string[] } {
  const at = raw.indexOf('\r\n\r\n')
  const head = raw.slice(0, at).replace(/\r\n /g, ' ')
  const headers = head.split('\r\n').map((l): [string, string] => [l.slice(0, l.indexOf(':')), l.slice(l.indexOf(':') + 2)])
  const bodyLines = raw.slice(at + 4).split('\r\n').filter((l) => l !== '')
  return { headers, body: unb64(bodyLines.join('')), bodyLines }
}

/** RFC 2047's decoding of a header of encoded words (the whitespace between two of them is dropped). */
function decodeHeader(v: string): string {
  return v.replace(/\?=\s+=\?/g, '?==?').replace(/=\?UTF-8\?B\?([A-Za-z0-9+/=]*)\?=/g, (_m, w: string) => unb64(w))
}

const OPTS = { now: () => NOW }

// ---------------------------------------------------------------------------
// C10 rules 1–5 — the recorded bytes of the whole exchange
// ---------------------------------------------------------------------------

/**
 * The whole STARTTLS exchange, both sides, line by line — as the in-memory server recorded it. The plain part is
 * EHLO and STARTTLS alone; AUTH, the addresses and the message come after `-- TLS --` (Review 3 reads this).
 */
const STARTTLS_DIALOGUE = [
  'S: 220 smtp.example.invalid ESMTP synthetic',
  'C: EHLO [127.0.0.1]',
  'S: 250-smtp.example.invalid greets [127.0.0.1]',
  'S: 250-PIPELINING',
  'S: 250-SIZE 10240000',
  'S: 250-STARTTLS',
  'S: 250 AUTH PLAIN LOGIN',
  'C: STARTTLS',
  'S: 220 2.0.0 Ready to start TLS',
  '-- TLS --',
  'C: EHLO [127.0.0.1]',
  'S: 250-smtp.example.invalid greets [127.0.0.1]',
  'S: 250-PIPELINING',
  'S: 250-AUTH PLAIN LOGIN',
  'S: 250 8BITMIME',
  `C: AUTH PLAIN ${b64(`\0${USER}\0${PASSWORD}`)}`,
  'S: 235 2.7.0 Authentication successful',
  `C: MAIL FROM:<${FROM}>`,
  'S: 250 2.1.0 Ok',
  `C: RCPT TO:<${TO}>`,
  'S: 250 2.1.5 Ok',
  'C: DATA',
  'S: 354 End data with <CR><LF>.<CR><LF>',
  `C: From: <${FROM}>`,
  `C: To: <${TO}>`,
  `C: Subject: ${TWO.title}`,
  'C: Date: Sun, 27 Sep 2026 12:00:00 +0000',
  'C: Message-ID: <id>',
  'C: MIME-Version: 1.0',
  'C: Content-Type: text/plain; charset=UTF-8',
  'C: Content-Transfer-Encoding: base64',
  'C: Auto-Submitted: auto-generated',
  'C: ',
  ...(b64(TWO_TEXT.replace(/\n/g, '\r\n')).match(/.{1,76}/g) ?? []).map((l) => `C: ${l}`),
  'C: .',
  'S: 250 2.0.0 Ok: queued as SYNTHETIC',
  'C: QUIT',
  'S: 221 2.0.0 Bye',
]

test('the recorded bytes of a STARTTLS send: EHLO, STARTTLS, then TLS, then EHLO again and AUTH — never an AUTH, a password or an address before TLS (1.12 C10 rules 1, 3, 4, 5; §5 Review 3)', { timeout: 5000 }, async () => {
  assert.equal(TWO.title, 'Token Pace: quota threshold reached')
  assert.equal(TWO.text, TWO_TEXT)
  const m = memory()
  const r = await sendMail(settings(), PASSWORD, TWO, m.transport, OPTS)
  await settle()
  assert.deepEqual(r, { ok: true })
  assert.deepEqual(m.calls, ['connectPlain smtp.example.invalid:587', 'upgrade smtp.example.invalid'])
  assert.deepEqual(dialogueOf(m.server), STARTTLS_DIALOGUE)
  // The bytes, per phase: the plain phase is exactly the two commands — nothing of the secret, the addresses or
  // the message; everything else came after the upgrade.
  assert.deepEqual(m.server.phases.map((p) => p.tls), [false, true])
  assert.equal(plainBytes(m.server), `EHLO ${EHLO_DOMAIN}\r\nSTARTTLS\r\n`)
  assertNothingSecretIn(plainBytes(m.server), 'before TLS')
  const secure = m.server.phases[1].bytes
  assert.ok(secure.startsWith(`EHLO ${EHLO_DOMAIN}\r\nAUTH PLAIN `), secure.slice(0, 40))
  assert.ok(secure.indexOf('AUTH PLAIN') < secure.indexOf('MAIL FROM') && secure.indexOf('MAIL FROM') < secure.indexOf('RCPT TO'))
  assert.ok(secure.endsWith('\r\n.\r\nQUIT\r\n'))
  // QUIT, and the connection closed — every end of every pair destroyed.
  assert.equal(m.server.quit, true)
  assert.equal(m.server.closed, true)
  assert.ok(m.ends.every((e) => e.destroyed))
})

test('implicit TLS: TLS from the first byte — EHLO, AUTH, the envelope, the message, QUIT; no STARTTLS (1.12 C10 rules 1 and 5)', { timeout: 5000 }, async () => {
  const m = memory()
  const r = await sendMail(settings({ security: 'tls', port: 465 }), PASSWORD, TWO, m.transport, OPTS)
  await settle()
  assert.deepEqual(r, { ok: true })
  assert.deepEqual(m.calls, ['connectTls smtp.example.invalid:465'])
  assert.deepEqual(m.server.phases.map((p) => p.tls), [true])
  const d = dialogueOf(m.server)
  assert.deepEqual(d.slice(0, 3), ['-- TLS --', 'S: 220 smtp.example.invalid ESMTP synthetic', 'C: EHLO [127.0.0.1]'])
  assert.equal(d.includes('C: STARTTLS'), false)
  // From the second EHLO on, the implicit exchange is the STARTTLS exchange's TLS part, line for line.
  assert.deepEqual(d.slice(2), STARTTLS_DIALOGUE.slice(STARTTLS_DIALOGUE.indexOf('-- TLS --') + 1))
  assert.equal(m.server.quit, true)
  assert.equal(m.server.closed, true)
  assert.ok(m.ends.every((e) => e.destroyed))
})

test('AUTH LOGIN when the server offers no PLAIN: 334, the user, 334, the password, 235 — each base64, over TLS (1.12 C10 rule 4)', { timeout: 5000 }, async () => {
  const m = memory({ tlsKeywords: ['AUTH LOGIN CRAM-MD5'] })
  assert.deepEqual(await sendMail(settings(), PASSWORD, TWO, m.transport, OPTS), { ok: true })
  const d = dialogueOf(m.server)
  const at = d.indexOf('C: AUTH LOGIN')
  assert.ok(at > d.indexOf('-- TLS --'))
  assert.deepEqual(d.slice(at, at + 6), ['C: AUTH LOGIN', 'S: 334 VXNlcm5hbWU6', `C: ${b64(USER)}`, 'S: 334 UGFzc3dvcmQ6', `C: ${b64(PASSWORD)}`, 'S: 235 2.7.0 Authentication successful'])
  assertNothingSecretIn(plainBytes(m.server), 'before TLS')
  // PLAIN is taken when offered, whatever the order of the mechanisms.
  const p = memory({ tlsKeywords: ['AUTH=LOGIN', 'AUTH LOGIN PLAIN'] })
  assert.deepEqual(await sendMail(settings(), PASSWORD, TWO, p.transport, OPTS), { ok: true })
  assert.ok(dialogueOf(p.server).some((l) => l.startsWith('C: AUTH PLAIN ')))
  // Neither offered over TLS (only before it, where it does not count): refused, and no secret sent at all.
  const none = memory({ tlsKeywords: ['8BITMIME', 'AUTH CRAM-MD5 XOAUTH2'] })
  assert.deepEqual(await sendMail(settings(), PASSWORD, TWO, none.transport, OPTS), { ok: false, kind: 'refused' })
  await settle()
  for (const s of [...SECRET_FORMS, ...ADDRESSES]) assert.equal(none.server.phases.map((x) => x.bytes).join('').includes(s), false, s)
  assert.equal(none.server.closed, true)
})

test('no STARTTLS offered: refused before any AUTH and any address — the bytes the server received hold no AUTH, no password and no address, though it offered AUTH (1.12 C10 rule 1, §5 Review 3)', { timeout: 5000 }, async () => {
  const m = memory({ plainKeywords: ['PIPELINING', 'AUTH PLAIN LOGIN', '8BITMIME'] })
  const r = await sendMail(settings(), PASSWORD, TWO, m.transport, OPTS)
  await settle()
  assert.deepEqual(r, { ok: false, kind: 'refused' })
  assert.deepEqual(m.calls, ['connectPlain smtp.example.invalid:587'])
  assert.deepEqual(m.server.phases.map((p) => p.tls), [false])
  assert.equal(plainBytes(m.server), `EHLO ${EHLO_DOMAIN}\r\n`)
  assertNothingSecretIn(plainBytes(m.server), 'without TLS')
  assert.equal(m.server.closed, true)
  assert.ok(m.ends.every((e) => e.destroyed))
  // STARTTLS offered but refused (454): the same — refused with the code, nothing else sent.
  const refusedTls = memory({ startTls: 454 })
  assert.deepEqual(await sendMail(settings(), PASSWORD, TWO, refusedTls.transport, OPTS), { ok: false, kind: 'refused', status: 454 })
  assert.equal(plainBytes(refusedTls.server), `EHLO ${EHLO_DOMAIN}\r\nSTARTTLS\r\n`)
  assert.deepEqual(refusedTls.calls, ['connectPlain smtp.example.invalid:587'])
})

test('a reply pipelined after the 220 to STARTTLS is an injection: tls, no handshake, nothing sent after it (1.12 C10 rule 1, RFC 3207 §4.2)', { timeout: 5000 }, async () => {
  const m = memory({ inject: '250-injected\r\n250 AUTH PLAIN\r\n' })
  const r = await sendMail(settings(), PASSWORD, TWO, m.transport, OPTS)
  await settle()
  assert.deepEqual(r, { ok: false, kind: 'tls' })
  assert.deepEqual(m.calls, ['connectPlain smtp.example.invalid:587'])
  assert.equal(plainBytes(m.server), `EHLO ${EHLO_DOMAIN}\r\nSTARTTLS\r\n`)
  assert.equal(m.server.closed, true)
})

test('a handshake whose certificate fails: tls, and no AUTH, no address in any phase (1.12 C10 rule 2)', { timeout: 5000 }, async () => {
  const m = memory({}, { upgrade: 'certificate' })
  const r = await sendMail(settings(), PASSWORD, TWO, m.transport, OPTS)
  await settle()
  assert.deepEqual(r, { ok: false, kind: 'tls' })
  assert.deepEqual(m.calls, ['connectPlain smtp.example.invalid:587', 'upgrade smtp.example.invalid'])
  assertNothingSecretIn(m.server.phases.map((p) => p.bytes).join(''), 'with a failed handshake')
  assert.equal(m.server.closed, true)
})

test('535 on AUTH is refused with its code — no envelope follows, and no word of the server reaches the result (1.12 C10 rules 4 and 8)', { timeout: 5000 }, async () => {
  const m = memory({ auth: 535, authText: `5.7.8 synthetic server text echoing ${PASSWORD}` })
  const r = await sendMail(settings(), PASSWORD, TWO, m.transport, OPTS)
  await settle()
  assert.deepEqual(r, { ok: false, kind: 'refused', status: 535 })
  assert.equal(JSON.stringify(r).includes('synthetic'), false)
  assert.equal(m.server.phases.map((p) => p.bytes).join('').includes('MAIL FROM'), false)
  assert.equal(m.server.closed, true)
  // A refusal at each later step: its code, and the steps after it never sent.
  const steps: Array<[Script, number, string]> = [[{ mail: 550 }, 550, 'RCPT TO'], [{ rcpt: 550 }, 550, 'DATA'], [{ data: 554 }, 554, 'From:'], [{ end: 452 }, 452, 'QUIT']]
  for (const [script, code, never] of steps) {
    const s = memory(script)
    assert.deepEqual(await sendMail(settings(), PASSWORD, TWO, s.transport, OPTS), { ok: false, kind: 'refused', status: code })
    assert.equal(s.server.phases.map((p) => p.bytes).join('').includes(never), false, never)
  }
  // A greeting that refuses (554) — and one that is no SMTP at all (network).
  const greeting = memory({ garbage: true })
  assert.deepEqual(await sendMail(settings(), PASSWORD, TWO, greeting.transport, OPTS), { ok: false, kind: 'network' })
  assert.equal(plainBytes(greeting.server), '')
})

// ---------------------------------------------------------------------------
// C10 rule 6 — the message
// ---------------------------------------------------------------------------

test('the message: From, To, Subject, Date, Message-ID, MIME-Version, Content-Type text/plain UTF-8, base64 in 76-character lines, Auto-Submitted — those nine headers and nothing else, CRLF (1.12 C10 rule 6, §0a.10)', { timeout: 5000 }, async () => {
  const m = memory()
  assert.deepEqual(await sendMail(settings(), PASSWORD, TWO, m.transport, OPTS), { ok: true })
  const raw = m.server.message
  assert.equal(raw.replace(/\r\n/g, '').includes('\n'), false, 'CRLF line ends only')
  const { headers, body, bodyLines } = parseMessage(raw)
  assert.deepEqual(headers.map(([k]) => k), ['From', 'To', 'Subject', 'Date', 'Message-ID', 'MIME-Version', 'Content-Type', 'Content-Transfer-Encoding', 'Auto-Submitted'])
  const h = Object.fromEntries(headers)
  assert.equal(h.From, `<${FROM}>`)
  assert.equal(h.To, `<${TO}>`)
  assert.equal(h.Subject, TWO.title)
  assert.equal(h.Date, 'Sun, 27 Sep 2026 12:00:00 +0000')
  assert.match(h['Message-ID'], new RegExp(`^<[0-9a-f]{32}@${MESSAGE_ID_DOMAIN.replace('.', '\\.')}>$`))
  assert.equal(h['MIME-Version'], '1.0')
  assert.equal(h['Content-Type'], 'text/plain; charset=UTF-8')
  assert.equal(h['Content-Transfer-Encoding'], 'base64')
  assert.equal(h['Auto-Submitted'], 'auto-generated')
  // The body is the payload's text and nothing else, its line ends CRLF.
  assert.equal(body, TWO_TEXT.replace(/\n/g, '\r\n'))
  assert.ok(bodyLines.every((l) => l.length <= 76 && /^[A-Za-z0-9+/=]+$/.test(l)))
  assert.ok(bodyLines.slice(0, -1).every((l) => l.length === 76))
  // Two sends, two Message-IDs.
  const again = memory()
  await sendMail(settings(), PASSWORD, TWO, again.transport, OPTS)
  assert.notEqual(Object.fromEntries(parseMessage(again.server.message).headers)['Message-ID'], h['Message-ID'])
  // The Date header by hand for other days.
  assert.equal(rfc5322Date(Date.UTC(2027, 0, 1, 3, 4, 5)), 'Fri, 01 Jan 2027 03:04:05 +0000')
  assert.equal(rfc5322Date(Date.UTC(2026, 1, 28, 23, 59, 59)), 'Sat, 28 Feb 2026 23:59:59 +0000')
})

test('a UTF-8 Subject is RFC 2047 encoded and decodable — German „Kontingent erschöpft“, Japanese, a long one folded into words of ≤ 75 characters; ASCII stays plain (1.12 C10 rule 6, encodeHeaderWord)', { timeout: 5000 }, async () => {
  assert.equal(encodeHeaderWord('Token Pace: test message'), 'Token Pace: test message')
  const german = 'Token Pace: Kontingent erschöpft'
  const g = encodeHeaderWord(german)
  assert.match(g, /^=\?UTF-8\?B\?[A-Za-z0-9+/=]+\?=$/)
  assert.equal(decodeHeader(g), german)
  const japanese = 'Token Pace: クォータの上限に達しました — 7 日間の枠 · Fable、リセットは水曜日 12:00'
  const j = encodeHeaderWord(japanese)
  assert.equal(decodeHeader(j), japanese)
  const words = j.split('\r\n ')
  assert.ok(words.length > 1)
  for (const w of words) {
    assert.ok(w.length <= 75, `${w.length}: ${w}`)
    // Each word decodes on its own: no code point is split between two.
    assert.equal(unb64(w.slice(10, -2)).includes('�'), false)
  }
  // An ASCII text that holds `=?` or a line break, or is too long for one header line, is encoded as well.
  assert.equal(decodeHeader(encodeHeaderWord('a =?x?= b')), 'a =?x?= b')
  assert.equal(encodeHeaderWord('a\r\nBcc: x@example.invalid'), 'a Bcc: x@example.invalid')
  const long = 'x'.repeat(2000)
  assert.equal(decodeHeader(encodeHeaderWord(long)), long)
  assert.ok(encodeHeaderWord(long).split('\r\n').every((l) => l.length <= 998))
  // Emoji and a combining mark survive the cut.
  const emoji = `${'é'.repeat(21)}👍🏽${'ü'.repeat(30)}`
  assert.equal(decodeHeader(encodeHeaderWord(emoji)), emoji)
  // Through a send: the German Subject arrives encoded, the body decodes to the text.
  const p: NotificationPayload = { title: german, text: 'Claude, 7-Tage-Fenster · Fable: aufgebraucht — setzt Mi 12:00 zurück.\nZweite Zeile — ü', json: {} }
  const m = memory()
  assert.deepEqual(await sendMail(settings(), PASSWORD, p, m.transport, OPTS), { ok: true })
  const { headers, body } = parseMessage(m.server.message)
  const subject = Object.fromEntries(headers).Subject
  assert.notEqual(subject, german)
  assert.equal(decodeHeader(subject), german)
  assert.equal(body, p.text.replace(/\n/g, '\r\n'))
  assert.equal(/[^\x00-\x7f]/.test(m.server.phases.map((x) => x.bytes).join('')), false, 'every byte on the wire is ASCII')
})

test('dot-stuffing: a line that starts with a dot gets a second one; the message ends CRLF . CRLF (1.12 C10 rule 6, dotStuff)', { timeout: 5000 }, async () => {
  assert.equal(dotStuff('.a\r\nb\r\n.c\r\n..d\r\n'), '..a\r\nb\r\n..c\r\n...d\r\n')
  assert.equal(dotStuff('a.b\r\n. \r\n'), 'a.b\r\n.. \r\n')
  assert.equal(dotStuff(''), '')
  // A base64 body never starts a line with a dot; the headers never do either — the message is its own stuffing.
  const raw = messageOf(FROM, TO, TWO, NOW, '<0123456789abcdef0123456789abcdef@token-pace.invalid>')
  assert.equal(dotStuff(raw), raw)
  assert.ok(raw.endsWith('\r\n'))
  // On the wire: the message, then the lone dot, then QUIT.
  const m = memory()
  assert.deepEqual(await sendMail(settings(), PASSWORD, TWO, m.transport, OPTS), { ok: true })
  assert.ok(m.server.phases[1].bytes.endsWith(`DATA\r\n${m.server.message}.\r\nQUIT\r\n`))
  assert.equal(m.server.message.split('\r\n').slice(10).join('\r\n'), raw.split('\r\n').slice(10).join('\r\n'), 'the same body as messageOf builds')
})

// ---------------------------------------------------------------------------
// C10 rules 7 and 8 — timeouts, failures, the setup
// ---------------------------------------------------------------------------

test('a silent server is a timeout within the injected 50 ms — at the greeting, after EHLO, after the message; the whole send bounded too (1.12 C10 rule 7)', { timeout: 5000 }, async () => {
  for (const silentAt of ['greeting', 'ehlo', 'end'] as const) {
    const m = memory({ silentAt })
    const t0 = Date.now()
    const r = await sendMail(settings(), PASSWORD, TWO, m.transport, { ...OPTS, replyTimeoutMs: 50 })
    const took = Date.now() - t0
    await settle()
    assert.deepEqual(r, { ok: false, kind: 'timeout' }, silentAt)
    assert.ok(took >= 45 && took < 1000, `${silentAt}: ${took} ms`)
    assert.equal(m.server.closed, true)
    assert.ok(m.ends.every((e) => e.destroyed))
  }
  // Each reply in time (30 ms of 50), the whole send not (120 ms): timeout at the send's deadline.
  const slow = memory({ delayMs: 30 })
  const t0 = Date.now()
  assert.deepEqual(await sendMail(settings(), PASSWORD, TWO, slow.transport, { ...OPTS, replyTimeoutMs: 50, timeoutMs: 120 }), { ok: false, kind: 'timeout' })
  const took = Date.now() - t0
  assert.ok(took >= 115 && took < 1000, `${took} ms`)
  // A delivered message whose QUIT gets no answer is still delivered — QUIT is waited for briefly.
  const quiet = memory({ silentAt: 'quit' })
  assert.deepEqual(await sendMail(settings(), PASSWORD, TWO, quiet.transport, { ...OPTS, replyTimeoutMs: 50 }), { ok: true })
  assert.equal(quiet.server.quit, true)
  // The constants.
  assert.equal(SMTP_REPLY_TIMEOUT_MS, 15_000)
  assert.equal(SMTP_SEND_TIMEOUT_MS, 30_000)
})

test('the failures are kinds: refused connection, a closed connection, a slow connect — never a text (1.12 C10 rule 8)', { timeout: 5000 }, async () => {
  const refused = memory({}, { connect: 'refused' })
  assert.deepEqual(await sendMail(settings(), PASSWORD, TWO, refused.transport, OPTS), { ok: false, kind: 'refused' })
  assert.deepEqual(await sendMail(settings({ security: 'tls', port: 465 }), PASSWORD, TWO, refused.transport, OPTS), { ok: false, kind: 'refused' })
  const closed = memory({ closeAt: 'ehlo' })
  assert.deepEqual(await sendMail(settings(), PASSWORD, TWO, closed.transport, OPTS), { ok: false, kind: 'network' })
  // A connect that never stands: timeout at the reply deadline, and the socket that comes later is destroyed.
  const late: Duplex[] = []
  const slowConnect: SmtpTransport = {
    ...memory().transport,
    connectPlain: () => new Promise<Duplex>((resolve) => {
      setTimeout(() => { const [c, s] = duplexPair(); late.push(c, s); resolve(c) }, 80)
    }),
  }
  assert.deepEqual(await sendMail(settings(), PASSWORD, TWO, slowConnect, { ...OPTS, replyTimeoutMs: 30 }), { ok: false, kind: 'timeout' })
  await new Promise<void>((resolve) => setTimeout(resolve, 100))
  assert.equal(late.length, 2)
  assert.ok(late.every((e) => e.destroyed), 'the late socket was destroyed')
  // A connect that never settles, the whole send's deadline first: timeout at it, and the reply timer of the
  // connect (2 s) ended with the send — the open-handle check after this test holds that no timer is left.
  const hung: SmtpTransport = { ...memory().transport, connectPlain: () => new Promise<Duplex>(() => undefined) }
  const t1 = Date.now()
  assert.deepEqual(await sendMail(settings(), PASSWORD, TWO, hung, { ...OPTS, replyTimeoutMs: 2000, timeoutMs: 60 }), { ok: false, kind: 'timeout' })
  assert.ok(Date.now() - t1 < 1000)
  // A transport that throws at once.
  const throwing: SmtpTransport = { ...memory().transport, connectPlain: () => { throw Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' }) } }
  assert.deepEqual(await sendMail(settings(), PASSWORD, TWO, throwing, OPTS), { ok: false, kind: 'network' })
})

test('an incomplete or hand-made setup is config and no connection is made — host, from, to, user, password; a NUL, a lone surrogate, an address with a line break or beyond ASCII, a host with a path (1.12 C10 rule 8, C5 rule 3)', { timeout: 5000 }, async () => {
  const m = memory()
  const cases: Array<[string, SmtpSettings, string]> = [
    ['no host', settings({ host: '' }), PASSWORD],
    ['no from', settings({ from: '' }), PASSWORD],
    ['no to', settings({ to: '' }), PASSWORD],
    ['no user', settings({ user: '' }), PASSWORD],
    ['no password', settings(), ''],
    ['a NUL in the password', settings(), 'synthetic\0password'],
    ['a lone surrogate', settings(), 'synthetic\ud800password'],
    ['a password too long', settings(), 'x'.repeat(5000)],
    ['a host with a path', { ...settings(), host: 'smtp.example.invalid/x' }, PASSWORD],
    ['a host with credentials', { ...settings(), host: 'u:p@smtp.example.invalid' }, PASSWORD],
    ['a line break in to', { ...settings(), to: 'a@example.invalid\r\nRCPT TO:<b@example.invalid>' }, PASSWORD],
    ['two addresses', { ...settings(), to: 'a@example.invalid, b@example.invalid' }, PASSWORD],
    ['an address beyond ASCII', settings({ to: 'léa@example.invalid' }), PASSWORD],
    ['a port out of range', { ...settings(), port: 70000 }, PASSWORD],
    ['a port as text', { ...settings(), port: '465' as unknown as number }, PASSWORD],
    ['an unknown security', { ...settings(), security: 'none' as unknown as SmtpSettings['security'] }, PASSWORD],
    ['a user with a line break', { ...settings(), user: 'u\r\nx' }, PASSWORD],
    ['no settings at all', null as unknown as SmtpSettings, PASSWORD],
  ]
  for (const [why, cfg, password] of cases) {
    assert.deepEqual(await sendMail(cfg, password, TWO, m.transport, OPTS), { ok: false, kind: 'config' }, why)
  }
  assert.deepEqual(m.calls, [], 'no connection was made')
  // The sanitiser's own output is usable, a bracketed IPv6 host included.
  assert.equal(settings({ host: '[::1]' }).host, '[::1]')
  const v6 = memory()
  assert.deepEqual(await sendMail(settings({ host: '[::1]' }), PASSWORD, TWO, v6.transport, OPTS), { ok: true })
  assert.deepEqual(v6.calls, ['connectPlain [::1]:587', 'upgrade [::1]'])
})

// ---------------------------------------------------------------------------
// C14 item 3 over the e-mail (P6-O3): nothing planted in the notifier's inputs reaches a header or the body
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

test('C14 item 3 over the e-mail: a synthetic token, a project path and a transcript line planted in the notifier\'s inputs reach neither a header nor the body of any message — and the password stands only in the AUTH line over TLS, the addresses only in the envelope and From/To (1.12 §0a.8–§0a.10, P6-O3)', { timeout: 5000 }, async () => {
  const TOKEN = 'synthetic-token-XYZ'
  const PROJECT = '/home/u/synthetic-project-123'
  const LINE = 'Synthetic transcript line: please refactor the parser'
  const SESSION = '9d0eb37a-synthetic'
  const planted = [TOKEN, PROJECT, 'synthetic-project-123', LINE, SESSION, '9d0eb37a', 'synthetic-plan', 'Synthetic Prompt Title']
  const cfg: NotifyConfig = readNotifyConfig((k) => ({
    'tokenPace.notifications.channels': ['email'],
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
  for (const security of ['starttls', 'tls'] as const) {
    for (const p of payloads) {
      const m = memory()
      assert.deepEqual(await sendMail(settings({ security, port: security === 'tls' ? 465 : 587 }), PASSWORD, p, m.transport, OPTS), { ok: true }, `${p.json.event}`)
      const all = m.server.phases.map((x) => x.bytes).join('')
      const { headers, body } = parseMessage(m.server.message)
      const decoded = `${headers.map(([k, v]) => `${k}: ${decodeHeader(v)}`).join('\n')}\n${body}`
      for (const s of planted) {
        assert.equal(all.includes(s), false, `${s} reached the wire in ${String(p.json.event)}`)
        assert.equal(decoded.includes(s), false, `${s} reached the message of ${String(p.json.event)}`)
      }
      // The message is the payload's title and text — and nothing of the JSON's other fields.
      assert.equal(decodeHeader(Object.fromEntries(headers).Subject), p.title)
      assert.equal(body, p.text.replace(/\n/g, '\r\n'))
      // Each secret only where its step needs it: the credentials in the one AUTH line, after TLS.
      const lines = all.split('\r\n')
      assert.deepEqual(lines.filter((l) => SECRET_FORMS.some((s) => l.includes(s))), [`AUTH PLAIN ${b64(`\0${USER}\0${PASSWORD}`)}`])
      assertNothingSecretIn(plainBytes(m.server), 'before TLS')
      assert.equal(decoded.includes(PASSWORD), false)
      // The addresses in MAIL FROM, RCPT TO, From and To — and nowhere else.
      assert.deepEqual(lines.filter((l) => ADDRESSES.some((a) => l.includes(a))), [`MAIL FROM:<${FROM}>`, `RCPT TO:<${TO}>`, `From: <${FROM}>`, `To: <${TO}>`])
    }
  }
})

// ---------------------------------------------------------------------------
// The source: no English, one kind of network site, verification never off
// ---------------------------------------------------------------------------

test('the source: no English and no URL; tls.connect only with rejectUnauthorized: true, never a checkServerIdentity of its own; EHLO never the host name (1.12 §4 P8, C10 rules 2 and 3, C11)', { timeout: 5000 }, () => {
  const src = readFileSync(join(ROOT, 'src', 'notifySmtp.ts'), 'utf8')
  assert.doesNotMatch(src, /from '\.\/i18n'/)
  assert.doesNotMatch(src, /(?<![\w$.])t\(/)
  const calls = [...src.matchAll(/tls\.connect\(\{([^\n]*)\}\)/g)].map((m) => m[1])
  assert.equal(calls.length, 2, 'implicit TLS and the upgrade')
  for (const c of calls) assert.match(c, /rejectUnauthorized: true/)
  assert.doesNotMatch(src, /rejectUnauthorized:\s*false|checkServerIdentity|NODE_TLS_REJECT_UNAUTHORIZED\s*=|os\.hostname|hostname\(\)/)
  assert.equal(EHLO_DOMAIN, '[127.0.0.1]')
  const { scanBundle, DEFAULT_ALLOW } = require('../scripts/check-privacy.mjs') as {
    scanBundle: (text: string, allow?: string[]) => { urls: unknown[]; offenders: unknown[] }
    DEFAULT_ALLOW: string[]
  }
  assert.deepEqual(scanBundle(src, DEFAULT_ALLOW).urls, [])
  // The kinds are P7's (notifyChannels.ts's SendResult and failureOf), so the host words them once (C13).
  assert.match(src, /import \{ failureOf, SendFailureKind, SendResult \} from '\.\/notifyChannels'/)
})

// ---------------------------------------------------------------------------
// Against real servers on 127.0.0.1 port 0 — the real transport, trusting exactly the test's certificate
// ---------------------------------------------------------------------------

interface Pem { key: string; cert: string }
interface Pems { own: Pem; other: Pem; wrongName: Pem }
let pems: Pems | string | undefined

/**
 * Three throwaway self-signed certificates, made by `openssl` in a temp dir that is removed before this returns —
 * no private key is committed or left behind: `own` and `other` for 127.0.0.1 (the client trusts `own` alone),
 * `wrongName` for another name (trusted, but not 127.0.0.1's). Where `openssl` is not on the PATH (the Windows
 * CI) the real-socket tests are skipped with this reason.
 */
function certificates(): Pems | string {
  if (pems !== undefined) return pems
  const probe = spawnSync('openssl', ['version'], { encoding: 'utf8', timeout: 5000 })
  if (probe.status !== 0) return (pems = 'openssl is not on the PATH — the real-socket SMTP tests are skipped')
  const dir = mkdtempSync(join(tmpdir(), 'tp-smtp-'))
  try {
    const make = (name: string, cn: string, san: string): Pem | null => {
      const key = join(dir, `${name}.key`)
      const cert = join(dir, `${name}.pem`)
      const r = spawnSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256', '-nodes', '-days', '1',
        '-subj', `/CN=${cn}`, '-addext', `subjectAltName=${san}`, '-keyout', key, '-out', cert], { stdio: 'ignore', timeout: 10_000 })
      return r.status === 0 ? { key: readFileSync(key, 'utf8'), cert: readFileSync(cert, 'utf8') } : null
    }
    const own = make('own', '127.0.0.1', 'IP:127.0.0.1')
    const other = make('other', '127.0.0.1', 'IP:127.0.0.1')
    const wrongName = make('wrong', 'other.invalid', 'DNS:other.invalid')
    pems = own !== null && other !== null && wrongName !== null
      ? { own, other, wrongName }
      : 'openssl could not make a certificate — the real-socket SMTP tests are skipped'
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
  return pems
}

/** Every socket a server accepts, so the `finally` can end them. */
function track(server: net.Server, sockets: Set<net.Socket>): void {
  server.on('connection', (sock: net.Socket) => {
    sockets.add(sock)
    sock.on('close', () => sockets.delete(sock))
  })
}

async function close(server: net.Server, sockets: Set<net.Socket>): Promise<void> {
  for (const s of sockets) s.destroy()
  await new Promise<void>((resolve) => server.close(() => resolve()))
}

async function listen(server: net.Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return (server.address() as net.AddressInfo).port
}

interface Chunk { from: 'C' | 'S'; bytes: Buffer }
interface Real {
  /** The relay's port — where the client connects; the relay records the bytes as they went over the wire. */
  port: number
  /** The server's own port (no relay) — for `openssl s_client`. */
  serverPort: number
  server: SmtpScript
  wire: Chunk[]
  transport: SmtpTransport
}

/**
 * A real SMTP server on 127.0.0.1 port 0 speaking `script` — `net` with STARTTLS (the server wraps its socket in
 * a TLSSocket after the 220) or `tls` from the first byte — with `serve`'s certificate; in front of it a TCP relay
 * that records every byte both ways; the client is `smtpTransport({ ca })` trusting `trust`'s certificates only.
 * Every socket, the relay and the server are ended in a `finally`.
 */
async function withReal(
  t: { skip(reason: string): void },
  mode: 'starttls' | 'tls',
  script: Script,
  certs: { serve: keyof Pems; trust: Array<keyof Pems> },
  fn: (r: Real) => Promise<void>,
): Promise<void> {
  const pem = certificates()
  if (typeof pem === 'string') { t.skip(pem); return }
  const served = new SmtpScript(script)
  const { key, cert } = pem[certs.serve]
  const onPlain = (sock: net.Socket): void => {
    sock.on('error', () => undefined)
    const out: Out = {
      write: (text) => { if (!sock.destroyed) sock.write(text) },
      end: () => sock.end(),
      startTls: () => {
        sock.removeAllListeners('data')
        const secure = new tls.TLSSocket(sock, { isServer: true, key, cert })
        secure.on('error', () => undefined)
        secure.on('secure', () => {
          served.secured({ write: (text) => { if (!secure.destroyed) secure.write(text) }, end: () => secure.end(), startTls: () => undefined })
          secure.on('data', (c: Buffer) => served.feed(c))
        })
        secure.on('close', () => served.ended())
      },
    }
    sock.on('data', (c: Buffer) => served.feed(c))
    sock.on('close', () => served.ended())
    served.begin(out, false)
  }
  const onTls = (sock: tls.TLSSocket): void => {
    sock.on('error', () => undefined)
    sock.on('data', (c: Buffer) => served.feed(c))
    sock.on('close', () => served.ended())
    served.begin({ write: (text) => { if (!sock.destroyed) sock.write(text) }, end: () => sock.end(), startTls: () => undefined }, true)
  }
  const server: net.Server = mode === 'starttls' ? net.createServer(onPlain) : tls.createServer({ key, cert }, onTls)
  server.on('tlsClientError', () => undefined)
  const serverSockets = new Set<net.Socket>()
  track(server, serverSockets)
  const wire: Chunk[] = []
  const relaySockets = new Set<net.Socket>()
  let serverPort = 0
  const relay = net.createServer((c) => {
    const up = net.connect(serverPort, '127.0.0.1')
    relaySockets.add(up)
    for (const s of [c, up]) s.on('error', () => undefined)
    c.on('data', (d: Buffer) => { wire.push({ from: 'C', bytes: d }); up.write(d) })
    up.on('data', (d: Buffer) => { wire.push({ from: 'S', bytes: d }); c.write(d) })
    c.on('close', () => up.destroy())
    up.on('close', () => { relaySockets.delete(up); c.destroy() })
  })
  track(relay, relaySockets)
  try {
    serverPort = await listen(server)
    const port = await listen(relay)
    await fn({ port, serverPort, server: served, wire, transport: smtpTransport({ ca: certs.trust.map((k) => pem[k].cert) }) })
  } finally {
    await close(relay, relaySockets)
    await close(server, serverSockets)
  }
}

function realSettings(port: number, security: 'starttls' | 'tls'): SmtpSettings {
  return settings({ host: '127.0.0.1', port, security })
}

const bytesFrom = (wire: Chunk[], from: 'C' | 'S'): Buffer => Buffer.concat(wire.filter((c) => c.from === from).map((c) => c.bytes))

test('real sockets, STARTTLS: over the wire the client sends in plain text only EHLO [127.0.0.1] and STARTTLS, then a TLS handshake — the password, the addresses and the message cross encrypted, and arrive (1.12 C10 rules 1–5, §5 Review 3)', { timeout: 5000 }, async (t) => {
  await withReal(t, 'starttls', {}, { serve: 'own', trust: ['own'] }, async (r) => {
    assert.deepEqual(await sendMail(realSettings(r.port, 'starttls'), PASSWORD, TWO, r.transport, OPTS), { ok: true })
    await settle()
    // The server's decrypted view: the same dialogue as the scripted one.
    assert.deepEqual(dialogueOf(r.server), STARTTLS_DIALOGUE)
    assert.equal(plainBytes(r.server), `EHLO ${EHLO_DOMAIN}\r\nSTARTTLS\r\n`)
    // The wire: the client's cleartext is exactly the two commands, and what follows is a TLS record.
    const c = bytesFrom(r.wire, 'C')
    const plain = `EHLO ${EHLO_DOMAIN}\r\nSTARTTLS\r\n`
    assert.equal(c.subarray(0, plain.length).toString('latin1'), plain)
    assert.equal(c[plain.length], 0x16, 'a TLS handshake record follows STARTTLS')
    assert.equal(c[plain.length + 1], 0x03)
    const s = bytesFrom(r.wire, 'S').toString('latin1')
    assert.ok(s.startsWith('220 smtp.example.invalid ESMTP synthetic\r\n250-'))
    for (const secret of [...SECRET_FORMS, ...ADDRESSES, 'AUTH PLAIN', 'MAIL FROM', 'RCPT TO', TWO.title, b64(TWO_TEXT.replace(/\n/g, '\r\n')).slice(0, 40)]) {
      assert.equal(c.toString('latin1').includes(secret), false, `${secret} in the client's bytes on the wire`)
    }
    const { headers, body } = parseMessage(r.server.message)
    assert.equal(Object.fromEntries(headers).Subject, TWO.title)
    assert.equal(body, TWO_TEXT.replace(/\n/g, '\r\n'))
    assert.equal(r.server.quit, true)
    assert.equal(await until(() => r.server.closed), true, 'the server saw the connection closed')
  })
})

test('real sockets, implicit TLS: the first byte is a TLS handshake, nothing in plain text at all — and the message arrives (1.12 C10 rules 1, 2, 5)', { timeout: 5000 }, async (t) => {
  await withReal(t, 'tls', {}, { serve: 'own', trust: ['own'] }, async (r) => {
    assert.deepEqual(await sendMail(realSettings(r.port, 'tls'), PASSWORD, TWO, r.transport, OPTS), { ok: true })
    await settle()
    const c = bytesFrom(r.wire, 'C')
    assert.equal(c[0], 0x16)
    for (const secret of [...SECRET_FORMS, ...ADDRESSES, 'EHLO', 'AUTH', 'MAIL FROM', TWO.title]) {
      assert.equal(c.toString('latin1').includes(secret), false, secret)
    }
    assert.deepEqual(r.server.phases.map((p) => p.tls), [true])
    assert.deepEqual(dialogueOf(r.server).slice(2), STARTTLS_DIALOGUE.slice(STARTTLS_DIALOGUE.indexOf('-- TLS --') + 1))
    assert.equal(await until(() => r.server.closed), true, 'the server saw the connection closed')
  })
})

test('real sockets: certificates are verified — a certificate the client does not trust, or one for another name, is tls and the server hears no AUTH, no address (1.12 C10 rule 2; rule 10\'s rejectUnauthorized mutation)', { timeout: 5000 }, async (t) => {
  for (const mode of ['starttls', 'tls'] as const) {
    for (const certs of [{ serve: 'other', trust: ['own'] }, { serve: 'wrongName', trust: ['own', 'wrongName'] }] as Array<{ serve: keyof Pems; trust: Array<keyof Pems> }>) {
      await withReal(t, mode, {}, certs, async (r) => {
        assert.deepEqual(await sendMail(realSettings(r.port, mode), PASSWORD, TWO, r.transport, OPTS), { ok: false, kind: 'tls' }, `${mode} ${certs.serve}`)
        await settle()
        assert.equal(r.server.phases.filter((p) => p.tls).length, 0, 'no TLS phase began')
        assertNothingSecretIn(r.server.phases.map((p) => p.bytes).join(''), `${mode} ${certs.serve}`)
        assertNothingSecretIn(bytesFrom(r.wire, 'C').toString('latin1'), `on the wire, ${mode} ${certs.serve}`)
      })
    }
  }
})

test('real sockets: a server without STARTTLS gets no secret on the wire; a port nobody listens on is refused (1.12 C10 rules 1 and 8)', { timeout: 5000 }, async (t) => {
  await withReal(t, 'starttls', { plainKeywords: ['AUTH PLAIN LOGIN'] }, { serve: 'own', trust: ['own'] }, async (r) => {
    assert.deepEqual(await sendMail(realSettings(r.port, 'starttls'), PASSWORD, TWO, r.transport, OPTS), { ok: false, kind: 'refused' })
    assert.equal(bytesFrom(r.wire, 'C').toString('latin1'), `EHLO ${EHLO_DOMAIN}\r\n`)
  })
  const pem = certificates()
  if (typeof pem === 'string') { t.skip(pem); return }
  const probe = net.createServer()
  const port = await listen(probe)
  await new Promise<void>((resolve) => probe.close(() => resolve()))
  const transport = smtpTransport({ ca: pem.own.cert })
  assert.deepEqual(await sendMail(realSettings(port, 'starttls'), PASSWORD, TWO, transport, OPTS), { ok: false, kind: 'refused' })
  assert.deepEqual(await sendMail(realSettings(port, 'tls'), PASSWORD, TWO, transport, OPTS), { ok: false, kind: 'refused' })
})

/**
 * `openssl s_client` as an independent client of the same test servers: with the test's certificate as its CA and
 * the address checked (`-verify_ip`, `-verify_return_error`) it completes STARTTLS and implicit TLS against the
 * own certificate and refuses the other name's — the verdicts the extension's client gives (above). So the
 * servers the tests trust are real SMTP-over-TLS peers, and the refusals are the certificates', not the fixture's.
 */
async function sClient(args: string[], stdin: string): Promise<{ code: number | null; out: string }> {
  const child = spawn('openssl', ['s_client', ...args], { stdio: ['pipe', 'pipe', 'pipe'] })
  let out = ''
  child.stdout.on('data', (d: Buffer) => { out += d.toString('utf8') })
  child.stderr.on('data', (d: Buffer) => { out += d.toString('utf8') })
  const done = new Promise<number | null>((resolve) => child.on('close', (code) => resolve(code)))
  const killer = setTimeout(() => child.kill('SIGKILL'), 4000)
  try {
    child.stdin.end(stdin)
    return { code: await done, out }
  } finally {
    clearTimeout(killer)
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL')
      await done
    }
  }
}

/** The s_client options the test needs (OpenSSL 1.1.1 and later); a build without them — LibreSSL — is skipped by name. */
const S_CLIENT_OPTIONS = ['-starttls', '-verify_ip', '-verify_return_error', '-brief', '-nocommands', '-ign_eof']

function sClientMissing(): string | null {
  const help = spawnSync('openssl', ['s_client', '-help'], { encoding: 'utf8', timeout: 5000 })
  const text = `${help.stdout ?? ''}${help.stderr ?? ''}`
  const missing = S_CLIENT_OPTIONS.filter((o) => !new RegExp(`(^|\\s)${o}(\\s|$)`, 'm').test(text))
  return missing.length === 0 ? null : `openssl s_client lacks ${missing.join(' ')} — the s_client test is skipped`
}

test('openssl s_client agrees: STARTTLS and implicit TLS verified against the test certificate, the other name refused (1.12 C10 rule 9\'s integration test; skipped where openssl is not on the PATH)', { timeout: 5000 }, async (t) => {
  const pem = certificates()
  if (typeof pem === 'string') { t.skip(pem); return }
  const lacking = sClientMissing()
  if (lacking !== null) { t.skip(lacking); return }
  const dir = mkdtempSync(join(tmpdir(), 'tp-smtp-ca-'))
  try {
    const caOwn = join(dir, 'own.pem')
    const caWrong = join(dir, 'wrong.pem')
    writeFileSync(caOwn, pem.own.cert)
    writeFileSync(caWrong, pem.wrongName.cert)
    // -nocommands: a line that starts with Q is sent, not taken as s_client's own quit; -ign_eof: the server ends it.
    const verify = (ca: string): string[] => ['-CAfile', ca, '-verify_return_error', '-verify_ip', '127.0.0.1', '-brief', '-nocommands', '-ign_eof']
    await withReal(t, 'starttls', {}, { serve: 'own', trust: ['own'] }, async (r) => {
      const res = await sClient(['-connect', `127.0.0.1:${r.serverPort}`, '-starttls', 'smtp', ...verify(caOwn)], 'QUIT\r\n')
      assert.equal(res.code, 0, res.out.slice(0, 400))
      assert.match(res.out, /Verification: OK/)
      assert.deepEqual(r.server.phases.map((p) => p.tls), [false, true])
      assert.match(r.server.phases[0].bytes, /^EHLO \S+\r\nSTARTTLS\r\n$/)
      assert.match(r.server.phases[1].bytes, /QUIT\r\n$/)
    })
    await withReal(t, 'tls', {}, { serve: 'own', trust: ['own'] }, async (r) => {
      const res = await sClient(['-connect', `127.0.0.1:${r.serverPort}`, ...verify(caOwn)], 'QUIT\r\n')
      assert.equal(res.code, 0, res.out.slice(0, 400))
      assert.match(res.out, /Verification: OK/)
      assert.equal(r.server.quit, true)
    })
    await withReal(t, 'starttls', {}, { serve: 'wrongName', trust: ['wrongName'] }, async (r) => {
      const res = await sClient(['-connect', `127.0.0.1:${r.serverPort}`, '-starttls', 'smtp', ...verify(caWrong)], 'QUIT\r\n')
      assert.notEqual(res.code, 0, res.out.slice(0, 400))
      assert.match(res.out, /IP address mismatch|verify error|certificate verify failed/i)
      assert.equal(r.server.phases.some((p) => p.tls && p.bytes !== ''), false)
    })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
