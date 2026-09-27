// SPDX-FileCopyrightText: 2026 Frederik Marx
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * 1.12 P9 (§0a.8, P8-D3): an in-memory SMTP server behind an injected `SmtpTransport` — for the host's leak test,
 * which must see the password exactly where its request needs it (the `AUTH` line after the upgrade) and nowhere
 * before it. No socket, no port, no network: `connectPlain`/`connectTls` hand the client one end of a Duplex pair
 * and the script answers on the other; `upgrade` is the "TLS handshake" — a new pair, the old one ended with it.
 *
 * It speaks the happy path of RFC 5321 with STARTTLS and `AUTH PLAIN`/`LOGIN`, and answers `AUTH` with `auth`
 * (235 unless a test says 535). test/notifySmtp.test.ts keeps its own, fuller script for the protocol's cases.
 */

import { Duplex } from 'node:stream'
import type { SmtpTransport } from '../../src/notifySmtp'

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

export interface FakeSmtp {
  transport: SmtpTransport
  /** What the client sent, per phase: the plain part before STARTTLS, then the "TLS" part. */
  phases: Array<{ tls: boolean; bytes: string }>
  /** The client's lines in order, `-- TLS --` at the upgrade. */
  lines: string[]
  /** The transport's calls: `connectPlain host:port`, `upgrade host`. */
  calls: string[]
  /** Every Duplex end made — all destroyed once a send is over. */
  ends: Duplex[]
}

export function fakeSmtp(opts: { auth?: number } = {}): FakeSmtp {
  const phases: FakeSmtp['phases'] = []
  const lines: string[] = []
  const calls: string[] = []
  const ends: Duplex[] = []
  let mode: 'command' | 'data' | 'user' | 'pass' = 'command'
  let buf = ''
  let upgrading = false
  let say: (text: string) => void = () => undefined

  const ehlo = (secure: boolean): string => {
    const keys = ['smtp.example.invalid greets [127.0.0.1]', ...(secure ? ['AUTH PLAIN LOGIN'] : ['STARTTLS', 'AUTH PLAIN LOGIN'])]
    return keys.map((k, i) => `250${i === keys.length - 1 ? ' ' : '-'}${k}`).join('\r\n')
  }
  const line = (l: string, secure: boolean, end: () => void): void => {
    if (mode === 'data') {
      if (l === '.') { mode = 'command'; say('250 2.0.0 Ok') }
      return
    }
    if (mode === 'user') { mode = 'pass'; say('334 UGFzc3dvcmQ6'); return }
    if (mode === 'pass') { mode = 'command'; say(`${opts.auth ?? 235} 2.7.0 done`); return }
    const upper = l.toUpperCase()
    if (upper.startsWith('EHLO ')) { say(ehlo(secure)); return }
    if (upper === 'STARTTLS') { say('220 2.0.0 Ready to start TLS'); upgrading = true; buf = ''; return }
    if (upper.startsWith('AUTH PLAIN ')) { say(`${opts.auth ?? 235} 2.7.0 done`); return }
    if (upper === 'AUTH LOGIN') { mode = 'user'; say('334 VXNlcm5hbWU6'); return }
    if (upper.startsWith('MAIL FROM:') || upper.startsWith('RCPT TO:')) { say('250 2.1.0 Ok'); return }
    if (upper === 'DATA') { mode = 'data'; say('354 End data with <CR><LF>.<CR><LF>'); return }
    if (upper === 'QUIT') { say('221 2.0.0 Bye'); end(); return }
    say('500 5.5.2 Error: command not recognized')
  }
  const serve = (secure: boolean, old: Duplex | null): Duplex => {
    const [client, srv] = duplexPair()
    ends.push(client, srv)
    phases.push({ tls: secure, bytes: '' })
    if (old !== null) { lines.push('-- TLS --'); upgrading = false; client.on('close', () => old.destroy()) }
    say = (text) => { if (!srv.destroyed) srv.write(`${text}\r\n`) }
    srv.on('data', (chunk: Buffer) => {
      if (upgrading) return
      const text = chunk.toString('latin1')
      phases[phases.length - 1].bytes += text
      buf += text
      for (let at = buf.indexOf('\r\n'); at !== -1; at = buf.indexOf('\r\n')) {
        const l = buf.slice(0, at)
        buf = buf.slice(at + 2)
        lines.push(l)
        line(l, secure, () => srv.end())
      }
    })
    if (old === null) say('220 smtp.example.invalid ESMTP synthetic')
    return client
  }
  const transport: SmtpTransport = {
    connectPlain: async (host, port) => { calls.push(`connectPlain ${host}:${port}`); return serve(false, null) },
    connectTls: async (host, port) => { calls.push(`connectTls ${host}:${port}`); return serve(true, null) },
    upgrade: async (sock, host) => { calls.push(`upgrade ${host}`); return serve(true, sock) },
  }
  return { transport, phases, lines, calls, ends }
}
