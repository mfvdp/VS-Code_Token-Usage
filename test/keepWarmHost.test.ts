// SPDX-FileCopyrightText: 2026 Frederik Marx
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * 1.8 B2 part 2 (spec §3 B2 tests 7, 8, 11, 12, 14, §0a.6 leak test; §7a Q19; §7c): the keep-warm host
 * against fake terminals — the countdown and its cancel, the second check at zero, the `sendText` spy,
 * the answers and the idle phase, `keepwarm.json`, the consent's words, two windows, and that nothing of
 * a terminal's command line or folder reaches an output.
 *
 * Every terminal, execution and window is a fake of test/helpers/fakeVscode.ts; every transcript line is
 * a synthetic fixture fed into a real aggregator; every time is a fixed instant. No terminal is started,
 * no real transcript read, nothing typed anywhere but into a fake's `sendText` spy.
 */

import { strict as assert } from 'node:assert'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { test } from 'node:test'
import { Aggregator } from '../src/agg'
import { emptyAgentTree } from '../src/agentTree'
import { watchCaches } from '../src/cacheWatch'
import { KEEP_WARM_CONSENT_KEY, KEEP_WARM_TERMS_PASSAGE, KeepWarmConsent, keepWarmDisclosure } from '../src/consent'
import { setBundle, setLocale } from '../src/i18n'
import {
  KEEP_WARM_LINE, KEEPWARM_COUNTDOWN_MS, KEEPWARM_LEAD_MS, KEEPWARM_MAX_PER_IDLE, KEEPWARM_VERIFY_MS,
} from '../src/keepWarm'
import {
  KEEPWARM_CANCEL_COMMAND, KEEPWARM_DAYS_KEPT, KEEPWARM_FILE_NAME, KEEPWARM_ITEM_ID, KEEPWARM_SENT_SHOWN_MS,
  KEEPWARM_VERIFY_GRACE_MS, KeepWarmFrame, KeepWarmHost, KeepWarmWindow, claudeQuotaMax, cleanKeepWarmFile, sessionRunning,
} from '../src/keepWarmHost'
import type { PromptCacheReading } from '../src/quotaSources'
import { TimeConfig } from '../src/time'
import { QuotaState } from '../src/types'
import { buildViewModel } from '../src/viewModel'
import { claudeLine, ctxFor, promptLine, scratchDir } from './fixtures/helpers'
import { makeInput } from './fixtures/viewFixtures'
import { FakeStatusBarItem, FakeTerminal, FakeVscodeState, createFakeVscode } from './helpers/fakeVscode'
import { ROOT } from './helpers/nls'

const SEC = 1000
const MIN = 60 * SEC
const HOUR = 60 * MIN
/** 2026-09-24 14:57:00 UTC: the bridge's stated expiry of the session's one-hour cache. */
const EXPIRY = Date.UTC(2026, 8, 24, 14, 57, 0)
/** The session's newest reply: the request that set the expiry, its line five seconds after it began. */
const LAST = EXPIRY - HOUR + 5 * SEC
/** This window started watching ten minutes before that reply. */
const T0 = LAST - 10 * MIN
/** 2 m 50 s before the expiry: due (3 min or less), and a countdown started now ends 1 m 50 s before it. */
const NOW = EXPIRY - 170 * SEC
const SID = '9d0eb37a-6f3e-4c2b-9a1d-2e4f6a8c0b13'
/** §0a.6's leak test: a command line with a secret on it, in a folder with a name — neither may reach an output. */
const SECRET_LINE = 'claude --api-key synthetic-secret-123'
const SECRET_CWD = '/home/u/synthetic-project'
const PROJECT_DIR = '-home-u-synthetic-project'
const FILE = path.join('/virtual', 'claude', 'projects', PROJECT_DIR, `${SID}.jsonl`)
const tcfg: TimeConfig = { zone: 'utc', dayBoundaryHour: 0, startOfWeek: 'monday', hourCycle: 'h23' }
const LEFT = 1

// ---------------------------------------------------------------------------
// The world: a transcript, the bridge's reading of it, a fake window with a Claude terminal
// ---------------------------------------------------------------------------

interface World {
  agg: Aggregator
  readings: PromptCacheReading[]
  quotas: QuotaState[]
  /** Appends one line to the session's transcript, as the ingest would. */
  line(raw: string): void
  /** The session's user asks something, and Claude answers at `at` (a counted request). */
  reply(at: number, o?: { input?: number; output?: number; read?: number; stop?: string }): void
}

let ids = 0

function world(o: { expiry?: number; quotaPercent?: number } = {}): World {
  const agg = new Aggregator()
  agg.cursors.set(FILE, { offset: 0, size: 0, ino: 900, dev: 1 })
  const c = ctxFor({ file: FILE })
  const line = (raw: string): void => { agg.addClaudeLine(raw, c) }
  const reply = (at: number, r: { input?: number; output?: number; read?: number; write?: number; stop?: string } = {}): void => {
    line(claudeLine({
      id: `msg_kw_${++ids}`, ts: at, model: 'claude-opus-5-5', final: true, stopReason: r.stop, sessionId: SID, cwd: SECRET_CWD,
      usage: { input: r.input ?? 300, cacheWrite: r.write ?? 0, cacheWrite1h: r.write ?? 0, cacheRead: r.read ?? 150_000, output: r.output ?? 40 },
    }))
  }
  // The session started two days ago; its newest reply wrote the one-hour cache.
  line(promptLine({ ts: LAST - 2 * 86_400_000 - 5 * SEC }))
  reply(LAST - 2 * 86_400_000)
  line(promptLine({ ts: LAST - 30 * SEC }))
  reply(LAST, { write: 2000, output: 200 })
  const expiry = o.expiry ?? EXPIRY
  const reading: PromptCacheReading = {
    warm: true, ttl: '1h', expiresAt: expiry, hitRatio: 0.98, readAt: Math.floor((LAST + SEC) / 1000),
    sessionId: SID, recacheIfCold: 152_300, model: 'claude-opus-5-5',
  }
  const quotas: QuotaState[] = [{
    source: 'claude', ok: true, fetchedAt: Math.floor(NOW / 1000) - 60, planType: 'max',
    windows: [{ id: 'session:300', kind: 'session', label: '5 h', shortLabel: '5h', model: null, percent: o.quotaPercent ?? 42,
      resetsAt: NOW + 2 * HOUR, windowMinutes: 300, limitReached: false, unlimited: false }],
  }]
  return { agg, readings: [reading], quotas, line, reply }
}

interface Rig {
  host: KeepWarmHost
  state: FakeVscodeState
  window: KeepWarmWindow
  clock: { now: number }
  logs: string[]
  file: string
  w: World
  /** One frame of the host at `now` (the clock moves there first). */
  tick(now: number, over?: Partial<KeepWarmFrame>): boolean
  /** The countdown item on screen, if any. */
  item(): (FakeStatusBarItem & { accessibilityInformation?: { label?: string } }) | undefined
}

/** A fake window and a host over it, the world's session running `claude` in a terminal of it. */
function rig(o: { w?: World; dir?: string; terminal?: boolean; commandLine?: string; cwd?: string; shell?: string | undefined } = {}): Rig {
  const { api, state } = createFakeVscode()
  const window = (api as { window: KeepWarmWindow }).window
  const clock = { now: T0 }
  const logs: string[] = []
  const dir = o.dir ?? scratchDir('keepwarm')
  const file = path.join(dir, KEEPWARM_FILE_NAME)
  const host = new KeepWarmHost({
    window, file, clock: () => clock.now,
    log: { info: (m) => logs.push(`info ${m}`), debug: (m) => logs.push(`debug ${m}`), warn: (m) => logs.push(`warn ${m}`) },
  })
  const w = o.w ?? world()
  const r: Rig = {
    host, state, window, clock, logs, file, w,
    tick(now: number, over: Partial<KeepWarmFrame> = {}): boolean {
      clock.now = now
      const f: KeepWarmFrame = {
        now, enabled: true, consent: 'granted', trusted: true,
        entries: watchCaches({ readings: w.readings, mains: w.agg.mainEntries(), tcfg }, now, Infinity),
        readings: w.readings, mains: w.agg.mainEntries(), tree: emptyAgentTree(), hook: new Map(), quotas: w.quotas, tcfg,
        alignment: LEFT, ...over,
      }
      return host.tick(f)
    },
    item: () => state.live().find((i) => i.id === KEEPWARM_ITEM_ID) as ReturnType<Rig['item']>,
  }
  // The window starts watching; the user opens a terminal, starts Claude Code in the project and works
  // in it, then leaves the window while Claude is still at its reply.
  r.tick(T0)
  if (o.terminal !== false) {
    const terminal = state.openTerminal({ shell: 'shell' in o ? o.shell : 'claude', name: 'Summary of a conversation' })
    state.setActiveTerminal(terminal)
    clock.now = T0 + 5 * SEC
    state.startExecution(terminal, { commandLine: o.commandLine ?? SECRET_LINE, confidence: 2, cwd: o.cwd ?? SECRET_CWD })
    clock.now = LAST - 20 * SEC
    state.fireWindowState(false)
  }
  return r
}

function terminalOf(r: Rig): FakeTerminal {
  return r.state.terminals[0]
}

/** Runs the host every second from `from` to `to`, both included. */
function run(r: Rig, from: number, to: number, over: Partial<KeepWarmFrame> = {}): void {
  for (let t = from; t <= to; t += SEC) r.tick(t, over)
}

function germanBundle(): Record<string, string> {
  return JSON.parse(fs.readFileSync(path.join(ROOT, 'l10n', 'bundle.l10n.de.json'), 'utf8')) as Record<string, string>
}

function inGerman<T>(fn: () => T): T {
  setLocale('de')
  setBundle(germanBundle())
  try {
    return fn()
  } finally {
    setLocale('en')
    setBundle({})
  }
}

// ---------------------------------------------------------------------------
// The countdown, the line, the second check (§3 B2 tests 7 and 8)
// ---------------------------------------------------------------------------

test('a due session arms a 60-second countdown of its own item, the line goes once at zero, and the item says so for 10 s (§3 B2, §7a Q19)', () => {
  const r = rig()
  // Before 3 minutes are left nothing starts; at 2 m 50 s the countdown does.
  r.tick(EXPIRY - KEEPWARM_LEAD_MS - SEC)
  assert.equal(r.item(), undefined)
  assert.equal(r.tick(NOW), true, 'arming changes the page')
  const item = r.item()
  assert.ok(item, 'no countdown item')
  assert.equal(item.text, '$(watch) keep warm in 60 s · cancel')
  assert.equal(item.name, 'Token Pace — keep-warm countdown')
  assert.equal(item.command, KEEPWARM_CANCEL_COMMAND)
  assert.equal(item.tooltip, `Token Pace will type “${KEEP_WARM_LINE}” into the terminal that runs Session Tue 13:57 · 9d0eb37a and press Enter, so that its prompt cache stays warm. Click to cancel.`)
  assert.equal(item.accessibilityInformation?.label, 'Keep-warm line for Session Tue 13:57 · 9d0eb37a in 60 seconds, activate to cancel')
  // No colour, no alarm: a countdown, not a warning.
  assert.equal(item.color, undefined)
  assert.equal(item.backgroundColor, undefined)
  assert.match(r.logs.join('\n'), /info keep-warm: countdown started for session 9d0eb37a; the cache expires at 14:57/)
  // It counts down each second.
  r.tick(NOW + 18 * SEC)
  assert.equal(r.item()?.text, '$(watch) keep warm in 42 s · cancel')
  assert.equal(r.item()?.accessibilityInformation?.label, 'Keep-warm line for Session Tue 13:57 · 9d0eb37a in 42 seconds, activate to cancel')
  assert.equal(r.state.sent.length, 0, 'a line before the countdown ended')
  // At zero: the line, once, into the terminal the countdown was armed for.
  run(r, NOW + 19 * SEC, NOW + KEEPWARM_COUNTDOWN_MS)
  assert.equal(r.state.sent.length, 1)
  assert.equal(r.state.sent[0].terminal, terminalOf(r))
  assert.equal(r.item()?.text, '$(watch) keep-warm line sent')
  assert.equal(r.item()?.command, undefined, 'nothing is left to cancel')
  assert.match(r.logs.join('\n'), /info keep-warm: line sent to the terminal of session 9d0eb37a; the cache expires at 14:57/)
  run(r, NOW + KEEPWARM_COUNTDOWN_MS + SEC, NOW + KEEPWARM_COUNTDOWN_MS + KEEPWARM_SENT_SHOWN_MS + SEC)
  assert.equal(r.item(), undefined, 'the "sent" words stay 10 s')
  // No second line while the first waits for its answer (the session's newest line is now the user's).
  r.w.line(promptLine({ ts: NOW + KEEPWARM_COUNTDOWN_MS + 500 }))
  run(r, NOW + KEEPWARM_COUNTDOWN_MS + 12 * SEC, EXPIRY + 5 * MIN)
  assert.equal(r.state.sent.length, 1)
  // Nothing of the terminal but its executions and its shell was looked at: never its name, never its output.
  assert.equal(r.state.nameReads, 0)
  assert.equal(r.state.outputReads, 0)
})

test('the sendText spy: exactly one call per go, (KEEP_WARM_LINE, true) — one line that Claude Code reads as a message (§3 B2 test 8)', () => {
  const r = rig()
  run(r, NOW, NOW + KEEPWARM_COUNTDOWN_MS + 5 * SEC)
  assert.deepEqual(r.state.sent.map((s) => [s.text, s.execute]), [[KEEP_WARM_LINE, true]])
  const text = r.state.sent[0].text
  assert.equal(/[\r\n]/.test(text), false)
  assert.equal(/^[/!@#?]/.test(text), false)
  assert.match(text, /^[ -~]+$/)
})

test('the send stage runs every guard again: a counted reply during the countdown, the setting switched off, a cancel — nothing is sent (§3 B2 test 7)', () => {
  // A counted reply of the session during the countdown: at zero the guards see it, whichever fact
  // the status line has delivered by then — none yet (the transcript is newer than the bridge's reading:
  // no measured cache, G2), a run that states the old expiry (the session is not idle, G4), or the
  // cache the reply refreshed (the line is not due any more, G3).
  for (const [status, block] of [['none', 'noBridge'], ['same expiry', 'notIdle'], ['refreshed', 'notDue']] as const) {
    const busy = rig()
    busy.tick(NOW)
    assert.ok(busy.item())
    busy.w.reply(NOW + 20 * SEC)
    const readAt = Math.floor((NOW + 21 * SEC) / 1000)
    if (status === 'same expiry') busy.w.readings[0] = { ...busy.w.readings[0], readAt }
    if (status === 'refreshed') busy.w.readings[0] = { ...busy.w.readings[0], readAt, expiresAt: NOW + 20 * SEC + HOUR }
    run(busy, NOW + SEC, NOW + KEEPWARM_COUNTDOWN_MS + SEC)
    assert.deepEqual(busy.state.sent, [], `${status}: a line went although the session answered during the countdown`)
    assert.ok(busy.logs.includes(`info keep-warm: not sent (${block})`), `${status}: ${busy.logs.join(' | ')}`)
    assert.equal(busy.item(), undefined)
  }
  // Switched off during the countdown: the countdown ends, without its line.
  const off = rig()
  off.tick(NOW)
  off.tick(NOW + 30 * SEC, { enabled: false })
  assert.equal(off.item(), undefined)
  run(off, NOW + 31 * SEC, NOW + 2 * KEEPWARM_COUNTDOWN_MS, { enabled: false })
  assert.deepEqual(off.state.sent, [])
  assert.match(off.logs.join('\n'), /info keep-warm: not sent \(off\)/)
  assert.equal(off.state.terminalListeners(), 0, 'switched off, the host still listens to the terminals')
  // The cancel: nothing sent, and the idle phase is cancelled — no new countdown for the session.
  const cancel = rig()
  cancel.tick(NOW)
  assert.equal(cancel.host.cancel(), true)
  assert.equal(cancel.item(), undefined)
  run(cancel, NOW + SEC, EXPIRY)
  assert.deepEqual(cancel.state.sent, [])
  assert.match(cancel.logs.join('\n'), /info keep-warm: cancelled for session 9d0eb37a; no further line in this idle phase/)
  assert.match(cancel.logs.join('\n'), /debug keep-warm: session 9d0eb37a not armed \(cancelled\)/)
  assert.equal(cancel.host.cancel(), false, 'nothing is left to cancel')
})

test('the terminal: only one that runs Claude Code in the session\'s folder, VS Code\'s word for its shell where it has one, never its name (G7, §7c)', () => {
  const cases: Array<[string, Parameters<typeof rig>[0], boolean]> = [
    ['the session\'s folder', {}, true],
    ['another project\'s folder', { cwd: '/home/u/other-project' }, false],
    ['a program named like it', { commandLine: 'claude-dev --resume' }, false],
    ['claude through npx', { commandLine: 'npx claude' }, false],
    ['VS Code names no shell', { shell: undefined }, true],
    ['VS Code names another program', { shell: 'bash' }, false],
    ['no terminal at all', { terminal: false }, false],
  ]
  for (const [what, o, arms] of cases) {
    const r = rig(o)
    r.tick(NOW)
    assert.equal(r.item() !== undefined, arms, what)
    assert.equal(r.state.nameReads, 0, `${what}: a terminal's name was read`)
  }
  // Two terminals running Claude Code in the folder: one too many.
  const two = rig()
  const second = two.state.openTerminal({ shell: 'claude' })
  two.state.startExecution(second, { commandLine: 'claude --resume', cwd: SECRET_CWD })
  two.tick(NOW)
  assert.equal(two.item(), undefined)
  assert.match(two.logs.join('\n'), /not armed \(ambiguousTerminal\)/)
  // Claude Code ended in the terminal (the execution's end event): no terminal runs it any more.
  const ended = rig()
  const t = terminalOf(ended)
  const execution = ended.state.startExecution(t, { commandLine: 'claude', cwd: SECRET_CWD })
  ended.state.endExecution(t, execution)
  ended.tick(NOW)
  assert.ok(ended.item(), 'the first execution is still open')
  const closed = rig()
  closed.state.closeTerminal(terminalOf(closed))
  closed.tick(NOW)
  assert.equal(closed.item(), undefined)
  assert.match(closed.logs.join('\n'), /not armed \(noTerminal\)/)
})

test('focus: a terminal the focused window had active since the newest reply, or a window that started after it, arms nothing (G8)', () => {
  // The user came back and the Claude terminal is active in the focused window.
  const back = rig()
  back.clock.now = NOW - MIN
  back.state.fireWindowState(true)
  back.tick(NOW)
  assert.equal(back.item(), undefined)
  assert.match(back.logs.join('\n'), /not armed \(typedSince\)/)
  // … and left again: the touch since the reply stays.
  back.clock.now = NOW + 5 * SEC
  back.state.fireWindowState(false)
  back.tick(NOW + 6 * SEC)
  assert.equal(back.item(), undefined)
  // Another terminal active while the window was focused: the Claude terminal was not touched.
  const other = rig()
  const shell = other.state.openTerminal({ shell: 'bash' })
  other.clock.now = LAST - 25 * SEC
  other.state.setActiveTerminal(shell)
  other.clock.now = LAST + 10 * MIN
  other.state.fireWindowState(true)
  other.tick(NOW)
  assert.ok(other.item(), 'another terminal in focus kept the line back')
  // A window that started watching after the newest reply cannot know.
  const late = rig({ terminal: false })
  late.host.dispose()
  const fresh = new KeepWarmHost({ window: late.window, file: late.file, clock: () => late.clock.now, log: { info: () => {}, debug: (m) => late.logs.push(m), warn: () => {} } })
  late.clock.now = LAST + MIN
  const frame = (now: number): KeepWarmFrame => ({
    now, enabled: true, consent: 'granted', trusted: true,
    entries: watchCaches({ readings: late.w.readings, mains: late.w.agg.mainEntries(), tcfg }, now, Infinity),
    readings: late.w.readings, mains: late.w.agg.mainEntries(), tree: emptyAgentTree(), hook: new Map(), quotas: late.w.quotas, tcfg, alignment: LEFT,
  })
  fresh.tick(frame(LAST + MIN))
  const t = late.state.openTerminal({ shell: 'claude' })
  late.state.startExecution(t, { commandLine: 'claude', cwd: SECRET_CWD })
  late.state.fireWindowState(false)
  fresh.tick(frame(NOW))
  assert.equal(late.state.live().some((i) => i.id === KEEPWARM_ITEM_ID), false)
  assert.match(late.logs.join('\n'), /not armed \(unknownFocus\)/)
})

// ---------------------------------------------------------------------------
// The answers and the idle phase (G9, G11, G12; §0a.7)
// ---------------------------------------------------------------------------

/** One whole round: the countdown from `at`, the line at its end, and — unless `answer` is false — the answer 3 s later. */
function round(r: Rig, at: number, answer = true): number {
  run(r, at, at + KEEPWARM_COUNTDOWN_MS)
  const sentAt = at + KEEPWARM_COUNTDOWN_MS
  // Answered: Claude Code wrote the line as the user's prompt, then its reply. Unanswered: the line
  // reached something else than Claude Code's input line — nothing of it in the transcript.
  if (answer) {
    r.w.line(promptLine({ ts: sentAt + 400 }))
    r.w.reply(sentAt + 3 * SEC, { input: 20, read: 152_000, output: 12 })
  }
  run(r, sentAt + SEC, sentAt + 20 * SEC)
  return sentAt
}

test('an answered line joins today in keepwarm.json — one request and its tokens —, and the file has exactly the shape of §0a.7 (§3 B2 test 12)', () => {
  const r = rig()
  round(r, NOW)
  assert.equal(r.state.sent.length, 1)
  assert.match(r.logs.join('\n'), /info keep-warm: the line to session 9d0eb37a was answered/)
  // The answer re-read the cache; its billable tokens are its fresh input and its output (no write).
  assert.deepEqual(JSON.parse(fs.readFileSync(r.file, 'utf8')), { v: 1, days: { '2026-09-24': { requests: 1, tokens: 32 } } })
  assert.deepEqual(r.host.view(NOW + 2 * MIN, tcfg).today, { requests: 1, tokens: 32 })
  // The second answered line of the day: the same day, both counted.
  r.w.readings[0] = { ...r.w.readings[0], expiresAt: NOW + 2 * MIN + HOUR, readAt: Math.floor((NOW + 2 * MIN) / 1000) }
  const second = NOW + 2 * MIN + HOUR - 170 * SEC
  round(r, second)
  assert.equal(r.state.sent.length, 2)
  const text = fs.readFileSync(r.file, 'utf8')
  assert.deepEqual(JSON.parse(text), { v: 1, days: { '2026-09-24': { requests: 2, tokens: 64 } } })
  // Written whole, atomically: no temp file beside it.
  assert.deepEqual(fs.readdirSync(path.dirname(r.file)).sort(), [KEEPWARM_FILE_NAME])
  // Never a session id, a path, a time of day, a terminal or a command line.
  for (const s of [SID, SID.slice(0, 8), SECRET_CWD, PROJECT_DIR, SECRET_LINE, 'synthetic-secret-123', KEEP_WARM_LINE, 'T']) {
    if (s === 'T') assert.equal(/\d\d:\d\d/.test(text), false, 'a time of day in keepwarm.json')
    else assert.equal(text.includes(s), false, `keepwarm.json holds ${s}`)
  }
})

test('keepwarm.json keeps 31 days, and a hand-edited file — another key, a negative or broken count — reads as empty (§0a.7)', () => {
  const good = { v: 1, days: { '2026-09-01': { requests: 2, tokens: 90 } } }
  assert.deepEqual(cleanKeepWarmFile(good), good.days)
  for (const bad of [
    { v: 1, days: { '2026-09-01': { requests: 2, tokens: 90 } }, extra: true },
    { v: 1, days: { '2026-09-01': { requests: 2, tokens: 90, session: SID } } },
    { v: 1, days: { '2026-09-01': { requests: -1, tokens: 90 } } },
    { v: 1, days: { '2026-09-01': { requests: 2, tokens: -5 } } },
    { v: 1, days: { '2026-09-01': { requests: 1.5, tokens: 5 } } },
    { v: 1, days: { '2026-09-01': { requests: '2', tokens: 5 } } },
    { v: 1, days: { 'yesterday': { requests: 2, tokens: 5 } } },
    { v: 2, days: {} },
    { days: {} },
    [], null, 'x', 7,
  ]) {
    assert.equal(cleanKeepWarmFile(bad), null, JSON.stringify(bad))
  }
  // A hand-edited file on disk: read as empty, the card shows nothing of it; the next answer starts afresh.
  const r = rig()
  fs.writeFileSync(r.file, JSON.stringify({ v: 1, days: { '2026-09-24': { requests: -3, tokens: 10 } } }))
  assert.equal(r.host.view(NOW, tcfg).today, null)
  round(r, NOW)
  assert.deepEqual(JSON.parse(fs.readFileSync(r.file, 'utf8')), { v: 1, days: { '2026-09-24': { requests: 1, tokens: 32 } } })
  // 31 days: a file of forty days keeps today and the thirty before it after the next answer.
  const r2 = rig()
  const days: Record<string, { requests: number; tokens: number }> = {}
  for (let i = 1; i <= 40; i++) days[new Date(EXPIRY - i * 86_400_000).toISOString().slice(0, 10)] = { requests: 1, tokens: i }
  fs.writeFileSync(r2.file, JSON.stringify({ v: 1, days }))
  round(r2, NOW)
  const kept = Object.keys((JSON.parse(fs.readFileSync(r2.file, 'utf8')) as { days: object }).days).sort()
  assert.equal(kept.length, KEEPWARM_DAYS_KEPT)
  assert.equal(kept[kept.length - 1], '2026-09-24')
  assert.equal(kept[0], '2026-08-25')
})

test('three answered lines, then the idle phase is capped; a request of the user\'s starts a new one (G9)', () => {
  const r = rig()
  let at = NOW
  for (let i = 0; i < KEEPWARM_MAX_PER_IDLE; i++) {
    const sentAt = round(r, at)
    // The status line ran after the answer: the cache lives an hour from the answer's request.
    const expires = sentAt + 3 * SEC + HOUR
    r.w.readings[0] = { ...r.w.readings[0], expiresAt: expires, readAt: Math.floor((sentAt + 4 * SEC) / 1000) }
    at = expires - 170 * SEC
  }
  assert.equal(r.state.sent.length, KEEPWARM_MAX_PER_IDLE)
  run(r, at, at + KEEPWARM_COUNTDOWN_MS + SEC)
  assert.equal(r.state.sent.length, KEEPWARM_MAX_PER_IDLE, 'a fourth line in one idle phase')
  assert.match(r.logs.join('\n'), /not armed \(cap\)/)
  assert.deepEqual(JSON.parse(fs.readFileSync(r.file, 'utf8')).days['2026-09-24'].requests, KEEPWARM_MAX_PER_IDLE)
  // The user asks something — from elsewhere, the terminal untouched — and a new idle phase begins.
  const mine = at + 2 * MIN
  r.w.reply(mine)
  r.w.readings[0] = { ...r.w.readings[0], expiresAt: mine + HOUR, readAt: Math.floor((mine + SEC) / 1000) }
  run(r, mine + SEC, mine + 5 * SEC)
  assert.match(r.logs.join('\n'), /debug keep-warm: a request of session 9d0eb37a starts a new idle phase/)
  run(r, mine + HOUR - 170 * SEC, mine + HOUR - 170 * SEC + KEEPWARM_COUNTDOWN_MS)
  assert.equal(r.state.sent.length, KEEPWARM_MAX_PER_IDLE + 1)
})

test('a line without an answer within two minutes stops keep-warm for the idle phase, with the card\'s note (G11)', () => {
  const r = rig()
  const sentAt = round(r, NOW, false)
  run(r, sentAt + 21 * SEC, sentAt + KEEPWARM_VERIFY_MS + KEEPWARM_VERIFY_GRACE_MS)
  assert.deepEqual(r.host.view(sentAt + KEEPWARM_VERIFY_MS, tcfg).unanswered, [], 'unanswered before the wait ran out')
  r.tick(sentAt + KEEPWARM_VERIFY_MS + KEEPWARM_VERIFY_GRACE_MS + SEC)
  assert.deepEqual(r.host.view(sentAt + KEEPWARM_VERIFY_MS + KEEPWARM_VERIFY_GRACE_MS + SEC, tcfg).unanswered, [SID])
  assert.match(r.logs.join('\n'), /info keep-warm: the line to session 9d0eb37a got no answer within 2 minutes; no further line in this idle phase/)
  assert.equal(fs.existsSync(r.file), false, 'an unanswered line was counted')
  // The note on the card, under the session's entry; no further line, even with a fresh reading.
  r.w.readings[0] = { ...r.w.readings[0], expiresAt: sentAt + HOUR, readAt: Math.floor((sentAt + 5 * SEC) / 1000) }
  run(r, sentAt + HOUR - 170 * SEC, sentAt + HOUR - 100 * SEC)
  assert.equal(r.state.sent.length, 1)
  assert.match(r.logs.join('\n'), /not armed \(unanswered\)/)
  const input = { ...makeInput({ agg: r.w.agg }), now: sentAt + HOUR - 100 * SEC, promptCaches: r.w.readings, keepWarm: r.host.view(sentAt + HOUR - 100 * SEC, tcfg) }
  const block = buildViewModel(input).quotas.find((q) => q.source === 'claude')?.cacheWatch
  assert.deepEqual(block?.keepWarm?.notes.map((n) => [n.kind, n.shortId, n.text]),
    [['unanswered', '9d0eb37a', 'Keep-warm stopped for this session: the last line got no answer within two minutes.']])
  // Switched off, the card says nothing of keep-warm any more.
  r.tick(sentAt + HOUR - 99 * SEC, { enabled: false })
  assert.deepEqual(r.host.view(sentAt + HOUR - 99 * SEC, tcfg), { armed: null, noTerminal: [], unanswered: [], today: null })
})

// ---------------------------------------------------------------------------
// The card's notes, the view (§3 B2 "Card notes")
// ---------------------------------------------------------------------------

test('the view names the countdown and the sessions no terminal of this window runs; the view model puts each note under its entry', () => {
  const r = rig()
  r.tick(NOW)
  const view = r.host.view(NOW + 18 * SEC, tcfg)
  assert.deepEqual(view.armed, { sessionId: SID, endsAt: NOW + KEEPWARM_COUNTDOWN_MS })
  assert.deepEqual(view.noTerminal, [])
  const block = buildViewModel({ ...makeInput({ agg: r.w.agg }), now: NOW + 18 * SEC, promptCaches: r.w.readings, keepWarm: view })
    .quotas.find((q) => q.source === 'claude')?.cacheWatch
  assert.deepEqual(block?.keepWarm, {
    notes: [{ line: 0, shortId: '9d0eb37a', kind: 'armed', text: 'Keep-warm line for this session in 42 s — cancel it in the status bar.' }],
    today: null,
  })
  // No terminal: the cooling bridge entry gets the note — the Claude Code panel's sessions too.
  const none = rig({ terminal: false })
  none.tick(NOW)
  assert.deepEqual(none.host.view(NOW, tcfg).noTerminal, [SID])
  const german = inGerman(() => buildViewModel({ ...makeInput({ agg: none.w.agg }), now: NOW, promptCaches: none.w.readings, keepWarm: none.host.view(NOW, tcfg) })
    .quotas.find((q) => q.source === 'claude')?.cacheWatch?.keepWarm)
  assert.deepEqual(german?.notes.map((n) => n.text), ['Warmhalten erreicht diese Sitzung nicht: Sie läuft in keinem VS-Code-Terminal dieses Fensters.'])
  // Switched off: no note at all.
  none.tick(NOW + SEC, { enabled: false })
  assert.deepEqual(none.host.view(NOW + SEC, tcfg).noTerminal, [])
})

// ---------------------------------------------------------------------------
// Inert while it may not act; the consent (§3 B2 test 11)
// ---------------------------------------------------------------------------

test('without the setting, the consent or a trusted workspace the host listens to no terminal and types nothing (G1, §0c)', () => {
  for (const [what, over] of [
    ['setting off', { enabled: false }], ['consent refused', { consent: 'denied' }], ['never asked', { consent: 'unasked' }],
    ['Restricted Mode', { trusted: false }],
  ] as Array<[string, Partial<KeepWarmFrame>]>) {
    const { api, state } = createFakeVscode()
    const window = (api as { window: KeepWarmWindow }).window
    const host = new KeepWarmHost({ window, file: path.join(scratchDir('kw-inert'), KEEPWARM_FILE_NAME), clock: () => T0, log: { info: () => {}, debug: () => {}, warn: () => {} } })
    const w = world()
    const frame = (now: number): KeepWarmFrame => ({
      now, enabled: true, consent: 'granted', trusted: true,
      entries: watchCaches({ readings: w.readings, mains: w.agg.mainEntries(), tcfg }, now, Infinity),
      readings: w.readings, mains: w.agg.mainEntries(), tree: emptyAgentTree(), hook: new Map(), quotas: w.quotas, tcfg, alignment: LEFT, ...over,
    })
    host.tick(frame(T0))
    assert.equal(host.isTracking(), false, what)
    assert.equal(state.terminalListeners(), 0, `${what}: a terminal event is listened to`)
    const t = state.openTerminal({ shell: 'claude' })
    state.startExecution(t, { commandLine: 'claude', cwd: SECRET_CWD })
    for (let now = NOW; now <= NOW + 2 * KEEPWARM_COUNTDOWN_MS; now += SEC) host.tick(frame(now))
    assert.deepEqual(state.sent, [], what)
    assert.equal(state.live().length, 0, what)
    assert.deepEqual(host.view(NOW, tcfg), { armed: null, noTerminal: [], unanswered: [], today: null }, what)
  }
})

test('the consent: the dialog names the cost, the draft that is sent with the line, the panel out of reach and the terms word for word, in English and German; a refusal is recorded (§3 B2 test 11)', async () => {
  const shown: Array<{ message: string; detail?: string; items: string[] }> = []
  const answers: Array<string | undefined> = []
  const ui = {
    showWarningMessage(message: string, options: { modal: boolean; detail?: string }, ...items: string[]): Promise<string | undefined> {
      assert.equal(options.modal, true)
      shown.push({ message, detail: options.detail, items })
      return Promise.resolve(answers.shift())
    },
  }
  const store = new Map<string, unknown>()
  const memento = {
    get: <T>(k: string, d: T): T => (store.has(k) ? store.get(k) as T : d),
    update: (k: string, v: unknown): Promise<void> => { if (v === undefined) store.delete(k); else store.set(k, v); return Promise.resolve() },
  }
  const log: string[] = []
  const consent = new KeepWarmConsent(memento, (m) => log.push(m), { ui, line: KEEP_WARM_LINE })
  assert.equal(consent.mementoKey(), 'tokenPace.keepWarmConsent')
  assert.equal(KEEP_WARM_CONSENT_KEY, 'tokenPace.keepWarmConsent')
  assert.equal(consent.state(), 'unasked')
  // Refused (the modal's Cancel): recorded, never a line.
  answers.push(undefined)
  assert.equal(await consent.request(), false)
  assert.equal(consent.state(), 'denied')
  assert.equal(shown[0].message, 'Let Token Pace type a keep-warm line into Claude Code\'s terminal?')
  assert.deepEqual(shown[0].items, ['Allow keep-warm'])
  const en = shown[0].detail ?? ''
  for (const claim of [
    'has three minutes or less left', 'a one-minute countdown in the status bar that you can cancel', `types “${KEEP_WARM_LINE}” into that terminal and presses Enter`,
    'about two minutes before the cache expires', 'at most three times in a row', 'at 90 % or more',
    'Cost: every line is a real request', 'counts against your usage limits',
    'Anything you typed there and did not send is sent with it', 'type nothing into the Claude terminal while the countdown runs',
    'extension\'s own panel is out of reach',
    `“${KEEP_WARM_TERMS_PASSAGE}”`, 'automated or non-human means', 'Anthropic has not explicitly permitted it',
    'tokenPace.cacheKeepWarm', 'withdraws this consent',
  ]) assert.ok(en.includes(claim), `the dialog does not say: ${claim}`)
  // Q19's numbers, never the spec's older ones; no address the check of the shipped strings would refuse.
  for (const stale of ['four minutes', '4 minutes', '55 minutes']) assert.equal(en.includes(stale), false, stale)
  assert.equal(/https?:/.test(en), false)
  // Allowed: granted, and asked no more.
  answers.push('Allow keep-warm')
  assert.equal(await consent.request(), true)
  assert.equal(consent.state(), 'granted')
  assert.equal(await consent.request(), true)
  assert.equal(shown.length, 2)
  // Switching the setting off withdraws it.
  await consent.reset()
  assert.equal(consent.state(), 'unasked')
  assert.ok(log.some((l) => l.startsWith('Keep-warm declined by the user')))
  // German: the same parts, the terms passage in English inside the German text.
  const de = inGerman(() => keepWarmDisclosure(KEEP_WARM_LINE))
  for (const claim of ['drei Minuten oder weniger', 'einminütigen Countdown', `tippt Token Pace „${KEEP_WARM_LINE}“`, 'etwa zwei Minuten',
    'höchstens dreimal hintereinander', 'Kosten: Jede Zeile ist eine echte Anfrage', 'Nutzungslimits', 'wird mitgesendet',
    'tippen Sie nichts in das Claude-Terminal, solange der Countdown läuft', 'außer Reichweite', `„${KEEP_WARM_TERMS_PASSAGE}“`,
    'automated or non-human means', 'nicht ausdrücklich gestattet', 'tokenPace.cacheKeepWarm']) {
    assert.ok(de.includes(claim), `the German dialog does not say: ${claim}`)
  }
  const title = inGerman(() => {
    const seen: string[] = []
    const c = new KeepWarmConsent(memento, () => {}, { ui: { showWarningMessage: (m: string, _o: unknown, ...items: string[]) => { seen.push(m, ...items); return Promise.resolve(undefined) } } })
    void c.request()
    return seen
  })
  assert.deepEqual(title, ['Token Pace eine Warmhalte-Zeile in das Terminal von Claude Code tippen lassen?', 'Warmhalten erlauben'])
})

test('the countdown item speaks German with a German bundle', () => {
  const r = rig()
  inGerman(() => r.tick(NOW))
  const item = r.item()
  assert.equal(item?.text, '$(watch) Warmhalten in 60 s · abbrechen')
  assert.equal(item?.name, 'Token Pace — Warmhalte-Countdown')
  assert.equal(item?.tooltip, `Token Pace tippt „${KEEP_WARM_LINE}“ in das Terminal, in dem Sitzung Di 13:57 · 9d0eb37a läuft, und drückt die Eingabetaste, damit der Prompt-Cache warm bleibt. Zum Abbrechen klicken.`)
  assert.equal(item?.accessibilityInformation?.label, 'Warmhalte-Zeile für Sitzung Di 13:57 · 9d0eb37a in 60 Sekunden, aktivieren zum Abbrechen')
  run(r, NOW + SEC, NOW + KEEPWARM_COUNTDOWN_MS - SEC)
  inGerman(() => r.tick(NOW + KEEPWARM_COUNTDOWN_MS))
  assert.equal(r.item()?.text, '$(watch) Warmhalte-Zeile gesendet')
})

// ---------------------------------------------------------------------------
// Two windows (§3 B2 test 14)
// ---------------------------------------------------------------------------

test('two windows share the mirror and the snapshot; only the one whose terminal runs the session arms (§3 B2 test 14)', () => {
  const w = world()
  const dir = scratchDir('kw-two')
  const withTerminal = rig({ w, dir })
  const without = rig({ w, dir, terminal: false })
  for (let now = NOW; now <= NOW + KEEPWARM_COUNTDOWN_MS; now += SEC) {
    withTerminal.tick(now)
    without.tick(now)
  }
  assert.equal(withTerminal.state.sent.length, 1)
  assert.equal(without.state.sent.length, 0)
  assert.equal(without.state.live().some((i) => i.id === KEEPWARM_ITEM_ID), false)
  assert.deepEqual(without.host.view(NOW, tcfg).noTerminal, [SID])
  // The window that sent the line counts its answer; the other reads the same file.
  w.line(promptLine({ ts: NOW + KEEPWARM_COUNTDOWN_MS + 400 }))
  w.reply(NOW + KEEPWARM_COUNTDOWN_MS + 3 * SEC, { input: 20, read: 152_000, output: 12 })
  for (let now = NOW + KEEPWARM_COUNTDOWN_MS + SEC; now <= NOW + KEEPWARM_COUNTDOWN_MS + 20 * SEC; now += SEC) {
    withTerminal.tick(now)
    without.tick(now)
  }
  assert.deepEqual(JSON.parse(fs.readFileSync(withTerminal.file, 'utf8')).days, { '2026-09-24': { requests: 1, tokens: 32 } })
  assert.deepEqual(without.host.view(NOW + 2 * MIN, tcfg).today, { requests: 1, tokens: 32 })
})

// ---------------------------------------------------------------------------
// The quota stop, the running agents (G5, G10 as the host reads them)
// ---------------------------------------------------------------------------

test('the host reads G10 off the Claude reading and G5 off the tree: a window at 90 % arms nothing, no tree counts as running', () => {
  const high = rig({ w: world({ quotaPercent: 90 }) })
  high.tick(NOW)
  assert.equal(high.item(), undefined)
  assert.match(high.logs.join('\n'), /not armed \(quota\)/)
  assert.deepEqual(claudeQuotaMax([]), null)
  assert.deepEqual(claudeQuotaMax(world({ quotaPercent: 12 }).quotas), { percent: 12, reached: false })
  const noTree = rig()
  noTree.tick(NOW, { tree: null })
  assert.equal(noTree.item(), undefined)
  assert.match(noTree.logs.join('\n'), /not armed \(agentRunning\)/)
  assert.equal(sessionRunning(null, SID), true)
  assert.equal(sessionRunning(emptyAgentTree(), SID), false)
})

// ---------------------------------------------------------------------------
// §0a.6: the leak test
// ---------------------------------------------------------------------------

test('a command line with a secret on it, in a named folder, matches — and neither string reaches the log, the view model, keepwarm.json or the status bar (§0a.6 leak test)', () => {
  const r = rig({ commandLine: SECRET_LINE, cwd: SECRET_CWD })
  // It matches: the countdown starts, the line goes, the answer is counted.
  round(r, NOW)
  assert.equal(r.state.sent.length, 1)
  const view = r.host.view(NOW + 2 * MIN, tcfg)
  const vm = buildViewModel({ ...makeInput({ agg: r.w.agg }), now: NOW + 2 * MIN, promptCaches: r.w.readings, keepWarm: view })
  // Every status-bar item the fake host ever made — the countdown's among them — with every field.
  const items = JSON.stringify(r.state.items.map((i) => ({ ...i })))
  const outputs: Array<[string, string]> = [
    ['log', r.logs.join('\n')],
    ['view', JSON.stringify(view)],
    ['view model', JSON.stringify(vm)],
    ['keepwarm.json', fs.readFileSync(r.file, 'utf8')],
    ['status bar', items],
  ]
  assert.ok(items.includes('keep-warm line sent'), 'the countdown item is not among the items')
  for (const [what, text] of outputs) {
    for (const secret of [SECRET_LINE, 'synthetic-secret-123', '--api-key', SECRET_CWD, 'synthetic-project']) {
      assert.equal(text.includes(secret), false, `the ${what} holds ${secret}`)
    }
  }
  assert.equal(r.state.nameReads, 0)
})

test('keepWarmHost.ts reads nothing of a terminal but its executions, its shell and sendText — never `.name` (§0a.6, §7c)', () => {
  const src = fs.readFileSync(path.join(ROOT, 'src', 'keepWarmHost.ts'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
  // Every `.name` the file reads is the status-bar item's (written), a watched entry's or a countdown's
  // session name — or an error's; never a terminal's.
  const owners = new Set([...src.matchAll(/([\w)\]]+)\??\.name\b/g)].map((m) => m[1]))
  assert.deepEqual([...owners].sort(), [')', 'c', 'e', 'item'], 'a `.name` of something else is read')
  assert.equal(/\bterminal\??\.name\b/.test(src), false, 'a terminal\'s name is read')
  assert.equal(/\.read\s*\(/.test(src), false, 'an execution\'s output is read')
  assert.equal(/creationOptions|\.env\b|processId/.test(src), false, 'a terminal\'s environment or process is read')
  assert.equal((src.match(/\.sendText\(/g) ?? []).length, 1, 'more than one place types into a terminal')
})

// ---------------------------------------------------------------------------
// 1.8 review 3: the send stage, block by block
// ---------------------------------------------------------------------------

test('the send stage, block by block: what changed during the countdown keeps the line back at zero, with its block in the log (§3 B2 "all again", review 3)', () => {
  type Case = [what: string, block: string, during: (r: Rig) => Partial<KeepWarmFrame> | void]
  const cases: Case[] = [
    // The user typed a prompt: the newest message line is the user's, no reply yet (§0a.5, probe P-6).
    ['a user line newest', 'openTool', (r) => { r.w.line(promptLine({ ts: NOW + 20 * SEC })) }],
    // A subagent of the session started.
    ['a running agent', 'agentRunning', () => ({
      tree: { ...emptyAgentTree(), running: 1, roots: [{ key: `s:${SID}`, tally: { running: 1 } }] } as unknown as KeepWarmFrame['tree'],
    })],
    // A second terminal of this window runs Claude Code in the same folder.
    ['a second matching terminal', 'ambiguousTerminal', (r) => {
      const second = r.state.openTerminal({ shell: 'claude' })
      r.state.startExecution(second, { commandLine: 'claude --resume', cwd: SECRET_CWD })
    }],
    // The armed terminal closed, and another one runs Claude Code in the folder now: the line goes into
    // the terminal the countdown was started for, or nowhere.
    ['another terminal in the armed one\'s place', 'noTerminal', (r) => {
      r.state.closeTerminal(terminalOf(r))
      const next = r.state.openTerminal({ shell: 'claude' })
      r.state.startExecution(next, { commandLine: 'claude', cwd: SECRET_CWD })
    }],
    // The user came back to the window, the Claude terminal active.
    ['the terminal focused since the reply', 'typedSince', (r) => {
      r.clock.now = NOW + 20 * SEC
      r.state.fireWindowState(true)
    }],
    // A Claude window reached 90 %.
    ['90 % of a quota window', 'quota', (r) => {
      r.w.quotas[0] = { ...r.w.quotas[0], windows: [{ ...r.w.quotas[0].windows[0], percent: 90 }] }
    }],
    // The bridge's reading went (Clear Stored Data…): only the transcript's estimate describes the cache.
    ['a transcript-sourced entry', 'noBridge', (r) => { r.w.readings.length = 0 }],
    // Consent withdrawn, and the workspace no longer trusted: G1 ends the countdown at once.
    ['consent withdrawn', 'consent', () => ({ consent: 'unasked' })],
    ['Restricted Mode', 'restricted', () => ({ trusted: false })],
  ]
  for (const [what, block, during] of cases) {
    const r = rig()
    r.tick(NOW)
    assert.ok(r.item(), `${what}: no countdown`)
    run(r, NOW + SEC, NOW + 19 * SEC)
    const over = during(r) ?? {}
    run(r, NOW + 20 * SEC, NOW + KEEPWARM_COUNTDOWN_MS + 5 * SEC, over)
    assert.deepEqual(r.state.sent, [], `${what}: a line went`)
    assert.ok(r.logs.includes(`info keep-warm: not sent (${block})`), `${what}: ${r.logs.filter((l) => l.includes('not ')).join(' | ')}`)
    assert.equal(r.item(), undefined, `${what}: the item stayed`)
  }
})
