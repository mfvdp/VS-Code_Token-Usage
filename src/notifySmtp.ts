// SPDX-FileCopyrightText: 2026 Frederik Marx
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * 1.12 C10 (§2.3, §0a.9): e-mail over SMTP, straight from the extension — TLS only, one message, one recipient.
 *
 * What goes out is the envelope (`MAIL FROM`/`RCPT TO` = the configured addresses), `EHLO [127.0.0.1]`, the
 * `AUTH` exchange and the message: the title `notify.ts` `payloadOf` built as its Subject, the text as its body
 * (§0a.10) — nothing else. What comes back and is read is the reply codes, the `EHLO` reply's keywords
 * (`STARTTLS`, `AUTH …`) and nothing more: never a server's words in a result, a log line or a text. The rules,
 * each with the reason it exists:
 *
 *  • TLS before anything that matters. `security: 'tls'` (implicit TLS, usually port 465) speaks TLS from the
 *    first byte. `security: 'starttls'` (usually 587) sends in plain text only `EHLO [127.0.0.1]` and
 *    `STARTTLS`: an `EHLO` reply without `STARTTLS` ends the send `refused` before any `AUTH` and before any
 *    address — never a password or an address in plain text. After the upgrade the first reply's keywords are
 *    forgotten (RFC 3207 §4.2) and `EHLO` is asked again over TLS; bytes the server sent after its `220` to
 *    `STARTTLS` and before the handshake are an injection (a man in the middle pipelining a reply of its own),
 *    and end the send as `tls`.
 *  • Certificates are always verified: `rejectUnauthorized: true` is written out on every `tls.connect`, so
 *    no option and no `NODE_TLS_REJECT_UNAUTHORIZED` in the environment turns it off; the host's name (or its
 *    address) is checked against the certificate. Node's certificate store, not the operating system's — VS
 *    Code's `http.systemCertificates` does not reach a raw `tls.connect` (not traced), so a server behind a
 *    private CA may fail as `tls`.
 *  • `EHLO [127.0.0.1]`: an address literal, never the machine's host name (a personal fact).
 *  • `AUTH PLAIN` when the server offers it, else `AUTH LOGIN`, else `refused`; written only once the
 *    connection is TLS (`Session.secureLine` refuses otherwise — a second guard beside the order of the
 *    steps). `235` is required.
 *  • One message, then `QUIT`, and the connection closed: every socket this send opened is destroyed in a
 *    `finally`, every timer cleared — a send leaves nothing behind (C10 rule 7).
 *  • Bounded: 15 s for each reply (the connection and the handshake included), 30 s for the whole send; a
 *    reply of more than 256 lines or 4 KiB a line is no SMTP server's.
 *  • No text is made here and no server text is kept: a result is a kind (`SendResult` of notifyChannels.ts,
 *    the same kinds P7's channels return, so the host words them once) and, for `refused` after a reply, that
 *    reply's code.
 *  • A setup that is not whole — a host, a sender, a recipient, a user or a password missing, a value the
 *    settings' sanitiser (`readNotifyConfig`, config.ts) would not have let through, an address that is not
 *    plain ASCII (no `SMTPUTF8` in 1.12) — is `config`, and no connection is made.
 *
 * The network call sites are `net.connect` and `tls.connect` in `smtpTransport` below, and they are the only
 * ones of this file — the privacy scan's `NETWORK_SITES` table (scripts/check-privacy.mjs, C11) holds this file
 * to `net` and `tls` and to hosts the reader configures (the SMTP server). The host passes `smtpTransport()`;
 * the tests pass a scripted server of their own, or `smtpTransport({ ca })` trusting exactly their certificate.
 */

import { randomBytes } from 'crypto'
import * as net from 'net'
import { Duplex } from 'stream'
import * as tls from 'tls'
import { EMAIL_ADDRESS_RE, NotifyConfig, readNotifyConfig, SMTP_SECURITIES } from './config'
import { NotificationPayload } from './notify'
import { failureOf, SendFailureKind, SendResult } from './notifyChannels'

export type SmtpSettings = NotifyConfig['email']

/** C10 rule 7: one reply may take this long — the connection and the TLS handshake count as one. */
export const SMTP_REPLY_TIMEOUT_MS = 15_000
/** C10 rule 7: the whole send. */
export const SMTP_SEND_TIMEOUT_MS = 30_000
/** C10 rule 3: the `EHLO` argument — an address literal, never the machine's host name. */
export const EHLO_DOMAIN = '[127.0.0.1]'
/** C10 rule 6: the right-hand side of every `Message-ID` — a domain that exists nowhere (RFC 2606). */
export const MESSAGE_ID_DOMAIN = 'token-pace.invalid'

/** After a delivered message, `QUIT`'s `221` is waited for this long at most — the result is already known. */
const QUIT_WAIT_MS = 1_000
/** A reply line longer than this, or a reply of more lines, is no SMTP server's (RFC 5321 §4.5.3.1.5: 512). */
const MAX_REPLY_LINE = 4096
const MAX_REPLY_LINES = 256
/** The longest password this sends (RFC 4954 §4 allows a 12 288-octet `AUTH` line; base64 grows by a third). */
const MAX_PASSWORD_BYTES = 4096
/** RFC 2047 §2: an encoded word is at most 75 characters; `=?UTF-8?B?` and `?=` take 12, so 45 bytes → 60. */
const ENCODED_WORD_BYTES = 45
/** RFC 2045 §6.8: base64 lines of at most 76 characters. */
const BASE64_LINE = 76
/** RFC 5322 §2.1.1: a header line of at most 998 characters — a longer ASCII title is encoded (and so folded). */
const PLAIN_SUBJECT_MAX = 900

/**
 * §2.3: how `sendMail` reaches a server — the host's `smtpTransport()`, a test's scripted server. Each call
 * resolves when the connection (and for `connectTls`/`upgrade` its TLS handshake, certificate verified) stands,
 * or rejects with Node's error, which `sendMail` turns into a kind.
 */
export interface SmtpTransport {
  /** Implicit TLS: a TLS connection from the first byte. */
  connectTls(host: string, port: number): Promise<Duplex>
  /** A plain TCP connection, for `STARTTLS` — nothing but `EHLO` and `STARTTLS` is sent over it. */
  connectPlain(host: string, port: number): Promise<Duplex>
  /** `STARTTLS`'s handshake on the plain connection, for `host`'s certificate. */
  upgrade(sock: Duplex, host: string): Promise<Duplex>
}

export interface SmtpOptions {
  /** One reply's deadline; absent = `SMTP_REPLY_TIMEOUT_MS` (15 s), never more. A test passes a short one. */
  replyTimeoutMs?: number
  /** The whole send's deadline; absent = `SMTP_SEND_TIMEOUT_MS` (30 s), never more. */
  timeoutMs?: number
  /** The clock of the `Date` header; absent = `Date.now`. */
  now?: () => number
}

// ---------------------------------------------------------------------------
// The transport (the network call sites)
// ---------------------------------------------------------------------------

/** A host as a socket takes it: a bracketed IPv6 address of the setting without its brackets. */
function socketHost(host: string): string {
  return host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host
}

/** SNI carries a host name only, never an address (RFC 6066 §3); the certificate is checked against either. */
function tlsTarget(host: string): { host: string; servername?: string } {
  const h = socketHost(host)
  return net.isIP(h) === 0 ? { host: h, servername: h } : { host: h }
}

/**
 * An error a socket raises after its caller has let go of it (a late reset, a destroyed handshake) must not
 * become an uncaught exception in the extension host: every socket here keeps this listener, and the send
 * that owns the socket has listeners of its own.
 */
const ignore = (): void => undefined

/**
 * Resolves with `sock` once `ready` fired, rejects with the first `error` or a close before it (the socket
 * destroyed) — a socket is only handed on when it stands.
 */
function whenReady<T extends net.Socket>(sock: T, ready: 'connect' | 'secureConnect'): Promise<T> {
  sock.on('error', ignore)
  return new Promise<T>((resolve, reject) => {
    const settle = (err: Error | null): void => {
      sock.off('error', onError)
      sock.off('close', onClose)
      sock.off(ready, onReady)
      if (err === null) {
        resolve(sock)
        return
      }
      sock.destroy()
      reject(err)
    }
    const onError = (err: Error): void => settle(err)
    const onClose = (): void => settle(Object.assign(new Error('the connection closed before it stood'), { code: 'ECONNRESET' }))
    const onReady = (): void => settle(null)
    sock.once('error', onError)
    sock.once('close', onClose)
    sock.once(ready, onReady)
  })
}

/**
 * The real transport: `net.connect` and `tls.connect`, TLS 1.2 at least, certificates verified against Node's
 * store — or against exactly `opts.ca` when a test passes its own certificate (never a global, never
 * `NODE_TLS_REJECT_UNAUTHORIZED`). No option here turns verification off.
 */
export function smtpTransport(opts: { ca?: string | string[] } = {}): SmtpTransport {
  const trust = opts.ca === undefined ? {} : { ca: opts.ca }
  return {
    connectTls: (host, port) =>
      whenReady(tls.connect({ ...tlsTarget(host), port, rejectUnauthorized: true, minVersion: 'TLSv1.2', ...trust }), 'secureConnect'),
    connectPlain: (host, port) => whenReady(net.connect({ host: socketHost(host), port }), 'connect'),
    upgrade: (sock, host) =>
      whenReady(tls.connect({ ...tlsTarget(host), socket: sock, rejectUnauthorized: true, minVersion: 'TLSv1.2', ...trust }), 'secureConnect'),
  }
}

// ---------------------------------------------------------------------------
// The message (C10 rule 6)
// ---------------------------------------------------------------------------

/** Printable ASCII — what a header or an address may hold unencoded here. */
const PRINTABLE_ASCII_RE = /^[\x20-\x7e]*$/
/** A lone surrogate: a string that UTF-8 cannot carry as it is (it would become U+FFFD — another password). */
const LONE_SURROGATE_RE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/

function base64(s: string): string {
  return Buffer.from(s, 'utf8').toString('base64')
}

/**
 * C10 rule 6: a header's text as it may stand in a header — itself when it is printable ASCII (and holds no
 * `=?`, which a reader would take for an encoded word), else RFC 2047 encoded words `=?UTF-8?B?…?=` of at most
 * 75 characters each, whole code points only, folded onto continuation lines (`CRLF SP`), which a reader joins
 * without the space (RFC 2047 §6.2).
 */
export function encodeHeaderWord(s: string): string {
  const text = s.replace(/[\r\n\t]+/g, ' ')
  if (PRINTABLE_ASCII_RE.test(text) && !text.includes('=?') && text.length <= PLAIN_SUBJECT_MAX) return text
  const words: string[] = []
  let chunk = ''
  let bytes = 0
  for (const ch of text) {
    const n = Buffer.byteLength(ch, 'utf8')
    if (bytes + n > ENCODED_WORD_BYTES && chunk !== '') {
      words.push(chunk)
      chunk = ''
      bytes = 0
    }
    chunk += ch
    bytes += n
  }
  if (chunk !== '' || words.length === 0) words.push(chunk)
  return words.map((w) => `=?UTF-8?B?${base64(w)}?=`).join('\r\n ')
}

/**
 * C10 rule 6: SMTP's dot-stuffing (RFC 5321 §4.5.2) — a line of `body` (CRLF line ends) that starts with `.`
 * gets a second one, so no line of the message can end it early. A base64 line never starts with a dot; the
 * rule is kept anyway, for every line of the message.
 */
export function dotStuff(body: string): string {
  return body.replace(/(^|\r\n)\./g, '$1..')
}

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** C10 rule 6: RFC 5322 §3.3's date in UTC — `Sun, 27 Sep 2026 12:00:00 +0000`. */
export function rfc5322Date(ms: number): string {
  const d = new Date(ms)
  const two = (n: number): string => String(n).padStart(2, '0')
  return `${DAYS[d.getUTCDay()]}, ${two(d.getUTCDate())} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()} `
    + `${two(d.getUTCHours())}:${two(d.getUTCMinutes())}:${two(d.getUTCSeconds())} +0000`
}

/** C10 rule 6: `<32 hex@token-pace.invalid>` — random, so it says nothing about the machine or the reader. */
export function messageId(): string {
  return `<${randomBytes(16).toString('hex')}@${MESSAGE_ID_DOMAIN}>`
}

/**
 * C10 rule 6: the message — its headers and its base64 body, CRLF line ends, ending with a CRLF; the Subject is
 * the payload's title, the body its text (§0a.10: nothing else of anything). Not yet dot-stuffed.
 */
export function messageOf(from: string, to: string, p: NotificationPayload, now: number, id: string = messageId()): string {
  const body = base64(p.text.replace(/\r\n?/g, '\n').replace(/\n/g, '\r\n')).match(new RegExp(`.{1,${BASE64_LINE}}`, 'g')) ?? []
  const headers = [
    `From: <${from}>`,
    `To: <${to}>`,
    `Subject: ${encodeHeaderWord(p.title)}`,
    `Date: ${rfc5322Date(now)}`,
    `Message-ID: ${id}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    'Auto-Submitted: auto-generated',
  ]
  return `${headers.join('\r\n')}\r\n\r\n${body.map((l) => `${l}\r\n`).join('')}`
}

// ---------------------------------------------------------------------------
// The setup's checks (C10 rule 8's `config`)
// ---------------------------------------------------------------------------

/**
 * The settings as they may be used, or null (`config`): every field whole and each exactly what the settings'
 * own sanitiser (`readNotifyConfig`) makes of it — so a hand-made object cannot carry a host with a path, a
 * second address or a line break past it —, the addresses plain ASCII (no `SMTPUTF8` here), the password
 * present, whole UTF-16 and without the NUL that separates `AUTH PLAIN`'s parts.
 */
function usable(cfg: SmtpSettings, password: string): SmtpSettings | null {
  if (cfg === null || typeof cfg !== 'object') return null
  const clean = readNotifyConfig((key) => (key === 'tokenPace.notifications.email' ? cfg : undefined)).email
  for (const k of ['host', 'port', 'security', 'user', 'from', 'to'] as const) {
    if (clean[k] !== cfg[k]) return null
  }
  if (clean.host === '' || clean.user === '' || clean.from === '' || clean.to === '') return null
  if (!(SMTP_SECURITIES as readonly string[]).includes(clean.security)) return null
  for (const address of [clean.from, clean.to]) {
    if (!EMAIL_ADDRESS_RE.test(address) || !/^[\x21-\x7e]+$/.test(address)) return null
  }
  if (typeof password !== 'string' || password === '' || password.includes('\0') || LONE_SURROGATE_RE.test(password)) return null
  if (Buffer.byteLength(password, 'utf8') > MAX_PASSWORD_BYTES || clean.user.includes('\0')) return null
  return clean
}

// ---------------------------------------------------------------------------
// The conversation (C10 rules 1, 4, 5, 7, 8)
// ---------------------------------------------------------------------------

/** A result this module decided — a refusal, a broken setup, an upgrade that cannot be trusted. */
class SmtpFailure extends Error {
  constructor(readonly result: SendResult) {
    super(result.ok ? 'ok' : result.kind)
  }
}

const fail = (kind: SendFailureKind, status?: number): SmtpFailure =>
  new SmtpFailure(status === undefined ? { ok: false, kind } : { ok: false, kind, status })

function timeoutError(): Error {
  const err = new Error('SMTP reply timeout')
  err.name = 'TimeoutError'
  return err
}

interface Reply {
  code: number
  /** Each line's text after the code — read for the `EHLO` keywords only, never shown or kept. */
  lines: string[]
}

/**
 * The reading side of one socket at a time: bytes into lines, lines into replies (`250-…` continues, `250 …`
 * ends), one waiter. Detached before the TLS upgrade, attached to the TLS socket after it.
 */
class Wire {
  private sock: Duplex | null = null
  private buf = ''
  private partial: string[] = []
  private partialCode = 0
  private readonly queue: Reply[] = []
  private problem: unknown = null
  private waiter: { resolve: (r: Reply) => void; reject: (e: unknown) => void } | null = null

  private readonly onData = (chunk: Buffer | string): void => {
    this.buf += typeof chunk === 'string' ? chunk : chunk.toString('latin1')
    for (let at = this.buf.indexOf('\n'); at !== -1; at = this.buf.indexOf('\n')) {
      const line = this.buf.slice(0, at).replace(/\r$/, '')
      this.buf = this.buf.slice(at + 1)
      if (!this.take(line)) return
    }
    if (this.buf.length > MAX_REPLY_LINE) this.stop(fail('network'))
  }

  private readonly onError = (err: unknown): void => this.stop(err)
  private readonly onEnd = (): void => this.stop(fail('network'))

  attach(sock: Duplex): void {
    this.sock = sock
    sock.on('data', this.onData)
    sock.on('error', this.onError)
    sock.on('end', this.onEnd)
    sock.on('close', this.onEnd)
  }

  /** Lets go of the socket; true when it held anything unread — bytes, a line, a reply nobody asked for. */
  detach(): boolean {
    const sock = this.sock
    if (sock !== null) {
      sock.off('data', this.onData)
      sock.off('error', this.onError)
      sock.off('end', this.onEnd)
      sock.off('close', this.onEnd)
    }
    this.sock = null
    const unread = this.buf !== '' || this.partial.length > 0 || this.queue.length > 0
    this.buf = ''
    this.partial = []
    this.queue.length = 0
    return unread
  }

  write(text: string): void {
    // Everything this module writes is ASCII by construction (base64, the checked addresses, the encoded
    // Subject); a byte beyond it would need 8BITMIME or SMTPUTF8, which this does not speak.
    if (!/^[\x00-\x7f]*$/.test(text)) throw fail('config')
    if (this.sock === null || this.sock.destroyed) throw fail('network')
    this.sock.write(Buffer.from(text, 'latin1'))
  }

  /** The next reply; rejects when the socket ends, errs, or speaks something that is not SMTP. */
  next(): Promise<Reply> {
    const queued = this.queue.shift()
    if (queued !== undefined) return Promise.resolve(queued)
    if (this.problem !== null) return Promise.reject(this.problem)
    return new Promise<Reply>((resolve, reject) => {
      this.waiter = { resolve, reject }
    })
  }

  /** Ends the reading for good: a waiter gets `why`. */
  stop(why: unknown): void {
    if (this.problem === null) this.problem = why
    const w = this.waiter
    this.waiter = null
    if (w !== null) w.reject(this.problem)
  }

  private take(line: string): boolean {
    const m = /^(\d{3})(?:([ -])(.*))?$/.exec(line)
    if (m === null || line.length > MAX_REPLY_LINE) {
      this.stop(fail('network'))
      return false
    }
    const code = Number(m[1])
    if (this.partial.length > 0 && code !== this.partialCode) {
      this.stop(fail('network'))
      return false
    }
    this.partialCode = code
    this.partial.push(m[3] ?? '')
    if (this.partial.length > MAX_REPLY_LINES) {
      this.stop(fail('network'))
      return false
    }
    if (m[2] === '-') return true
    const reply: Reply = { code, lines: this.partial }
    this.partial = []
    const w = this.waiter
    this.waiter = null
    if (w !== null) w.resolve(reply)
    else this.queue.push(reply)
    return true
  }
}

/** The `EHLO` reply's keywords (its lines after the first): `STARTTLS`, and the mechanisms `AUTH` names. */
function extensionsOf(r: Reply): { starttls: boolean; auth: Set<string> } {
  const auth = new Set<string>()
  let starttls = false
  for (const raw of r.lines.slice(1)) {
    const line = raw.trim()
    if (/^STARTTLS$/i.test(line)) starttls = true
    const m = /^AUTH[ =](.*)$/i.exec(line)
    if (m !== null) for (const mech of m[1].trim().split(/\s+/)) auth.add(mech.toUpperCase())
  }
  return { starttls, auth }
}

/** One send's sockets, timers and wire — everything `close` ends. */
class Session {
  private readonly sockets = new Set<Duplex>()
  private readonly timers = new Set<ReturnType<typeof setTimeout>>()
  private readonly wire = new Wire()
  private closed = false
  /** True once the connection is TLS — implicit or after `STARTTLS`'s handshake; `secureLine` needs it. */
  private secure = false

  constructor(private readonly transport: SmtpTransport, private readonly replyMs: number) {}

  /** `p` within one reply's deadline (`ms`), or a `TimeoutError`; the timer is this session's, so `close` ends it. */
  private within<T>(p: Promise<T>, ms: number = this.replyMs): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.timers.delete(timer)
        reject(timeoutError())
      }, ms)
      this.timers.add(timer)
      p.then(
        (v) => {
          clearTimeout(timer)
          this.timers.delete(timer)
          resolve(v)
        },
        (err: unknown) => {
          clearTimeout(timer)
          this.timers.delete(timer)
          reject(err)
        },
      )
    })
  }

  /**
   * A connection or an upgrade within one reply's deadline. Whatever the race's outcome, the socket — if one
   * comes, however late — is this session's to end: one that stands after the send was closed is destroyed
   * at once.
   */
  private async open(connect: () => Promise<Duplex>): Promise<Duplex> {
    // Called at once, not on a later turn: `STARTTLS`'s handshake must take the socket before it can read a byte.
    let pending: Promise<Duplex>
    try {
      pending = Promise.resolve(connect())
    } catch (err) {
      pending = Promise.reject(err)
    }
    pending.then((sock) => {
      sock.on('error', ignore)
      this.sockets.add(sock)
      if (this.closed) sock.destroy()
    }, ignore)
    const sock = await this.within(pending)
    if (this.closed) throw fail('timeout')
    return sock
  }

  private async reply(ms?: number): Promise<Reply> {
    return this.within(this.wire.next(), ms)
  }

  /** A reply whose code is one of `ok`; a 4xx/5xx (or any other code) is `refused` with that code. */
  private async expect(...ok: number[]): Promise<Reply> {
    const r = await this.reply()
    if (!ok.includes(r.code)) throw fail('refused', r.code)
    return r
  }

  private line(text: string): void {
    this.wire.write(`${text}\r\n`)
  }

  /** C10 rules 1 and 4: an `AUTH` step, an address or the message — only over TLS, whatever the order above says. */
  private secureLine(text: string): void {
    if (!this.secure) throw fail('tls')
    this.line(text)
  }

  async run(cfg: SmtpSettings, password: string, message: string): Promise<void> {
    const host = cfg.host
    let sock: Duplex
    if (cfg.security === 'tls') {
      // A refused connection, a name that does not resolve, a handshake or a certificate: failureOf tells them apart.
      sock = await this.open(() => this.transport.connectTls(host, cfg.port))
      this.secure = true
      this.wire.attach(sock)
      await this.expect(220)
    } else {
      sock = await this.open(() => this.transport.connectPlain(host, cfg.port))
      this.wire.attach(sock)
      await this.expect(220)
      this.line(`EHLO ${EHLO_DOMAIN}`)
      const plain = extensionsOf(await this.expect(250))
      // C10 rule 1: no STARTTLS, no send — before any AUTH and before any address.
      if (!plain.starttls) throw fail('refused')
      this.line('STARTTLS')
      await this.expect(220)
      // Anything the server sent after its 220 and before the handshake was not asked for: an injection.
      if (this.wire.detach()) throw fail('tls')
      let secure: Duplex
      try {
        secure = await this.open(() => this.transport.upgrade(sock, host))
      } catch (err) {
        throw asTls(err)
      }
      this.secure = true
      this.wire.attach(secure)
    }
    // RFC 3207 §4.2: what the plain EHLO said is forgotten; the keywords are asked again over TLS.
    this.line(`EHLO ${EHLO_DOMAIN}`)
    const ext = extensionsOf(await this.expect(250))
    if (ext.auth.has('PLAIN')) {
      this.secureLine(`AUTH PLAIN ${base64(`\0${cfg.user}\0${password}`)}`)
      await this.expect(235)
    } else if (ext.auth.has('LOGIN')) {
      this.secureLine('AUTH LOGIN')
      await this.expect(334)
      this.secureLine(base64(cfg.user))
      await this.expect(334)
      this.secureLine(base64(password))
      await this.expect(235)
    } else {
      throw fail('refused')
    }
    this.secureLine(`MAIL FROM:<${cfg.from}>`)
    await this.expect(250)
    this.secureLine(`RCPT TO:<${cfg.to}>`)
    await this.expect(250, 251)
    this.secureLine('DATA')
    await this.expect(354)
    if (!this.secure) throw fail('tls')
    this.wire.write(`${dotStuff(message)}.\r\n`)
    await this.expect(250)
    // Delivered. QUIT, and its 221 waited for briefly — the connection is ended in `close` either way.
    this.line('QUIT')
    await this.reply(Math.min(QUIT_WAIT_MS, this.replyMs)).catch(ignore)
  }

  /** Ends everything: the wire, every timer, every socket this send opened (C10 rule 7). */
  close(): void {
    this.closed = true
    this.wire.detach()
    this.wire.stop(fail('timeout'))
    for (const timer of this.timers) clearTimeout(timer)
    this.timers.clear()
    for (const sock of this.sockets) sock.destroy()
  }
}

/** A failed `STARTTLS` handshake: the connection stood, so anything but the deadline is `tls`. */
function asTls(err: unknown): SmtpFailure {
  if (err instanceof SmtpFailure) return err
  const r = failureOf(err)
  return !r.ok && r.kind === 'timeout' ? new SmtpFailure(r) : fail('tls')
}

/** A deadline within its constant, or the constant. */
function limit(v: number | undefined, max: number): number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.min(v, max) : max
}

/**
 * C10: one message to `cfg.to` through `cfg.host` — TLS only, certificates verified, `AUTH` with `cfg.user` and
 * `password`, the payload's title as the Subject and its text as the body. Never throws; never retries (§7a
 * Q24); leaves no socket and no timer behind. The password stands in the `AUTH` exchange over TLS and nowhere
 * else — not in a result, not in an error.
 */
export async function sendMail(
  cfg: SmtpSettings,
  password: string,
  p: NotificationPayload,
  transport: SmtpTransport = smtpTransport(),
  opts: SmtpOptions = {},
): Promise<SendResult> {
  const settings = usable(cfg, password)
  if (settings === null) return { ok: false, kind: 'config' }
  const now = typeof opts.now === 'function' ? opts.now() : Date.now()
  const message = messageOf(settings.from, settings.to, p, now)
  const session = new Session(transport, limit(opts.replyTimeoutMs, SMTP_REPLY_TIMEOUT_MS))
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<SendResult>((resolve) => {
    timer = setTimeout(() => resolve({ ok: false, kind: 'timeout' }), limit(opts.timeoutMs, SMTP_SEND_TIMEOUT_MS))
  })
  const talk = session.run(settings, password, message).then(
    (): SendResult => ({ ok: true }),
    (err: unknown): SendResult => (err instanceof SmtpFailure ? err.result : failureOf(err)),
  )
  try {
    return await Promise.race([talk, deadline])
  } finally {
    clearTimeout(timer)
    session.close()
  }
}
