// SPDX-FileCopyrightText: 2026 Frederik Marx
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * 1.8 B2 part 1 (spec §3 B2 "The guards", §7a Q19, §7c): the keep-warm decision on its facts — every
 * guard passing is `go`, each guard failing alone is its block, every block is reached —, the timing
 * of Q19 (due at 3 minutes left, the line at about 2, never inside the last minute), G2's "never an
 * estimate", G4 with the probe P-6 shape, the terminal match (the command line, its confidence, the
 * working directory's project-directory name), G8, G9–G11, G10 and Restricted Mode. The host that
 * gathers the facts — terminals, focus, the countdown, `sendText` — is P10's (keepWarmHost.test.ts).
 * Synthetic records, readings and command lines throughout; no terminal, no transcript, no mirror.
 */

import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { Aggregator } from '../src/agg'
import { HookEntry } from '../src/agentTree'
import { CACHE_COOLING_LEAD_MS, CacheWatchEntry, TTL_MS, watchCaches } from '../src/cacheWatch'
import {
  CLAUDE_COMMAND_RE, COMMAND_CONFIDENCE_MEDIUM, COMMAND_LINE_TESTED_CHARS, KEEPWARM_COUNTDOWN_MS, KEEPWARM_GUARD_OF,
  KEEPWARM_IDLE_MIN_MS, KEEPWARM_LEAD_MS, KEEPWARM_MAX_PER_IDLE, KEEPWARM_QUOTA_STOP_PERCENT, KEEPWARM_SEND_MARGIN_MS,
  KEEPWARM_VERIFY_MS, KEEP_WARM_LINE, KeepWarmBlock, KeepWarmFacts, KeepWarmStage, ShellExecutionFacts,
  claudeExecutionMatches, keepWarmDecision, projectDirName,
} from '../src/keepWarm'
import type { PromptCacheReading } from '../src/quotaSources'
import { TimeConfig } from '../src/time'
import { LastRequest, MainRec } from '../src/types'
import {
  CLAUDE_MAIN, CLAUDE_SLUG, CODEX_FILE, claudeLine, codexMeta, codexTokenCount, codexTurnContext, ctxFor, promptLine,
  toolResultLine,
} from './fixtures/helpers'
import { ROOT } from './helpers/nls'

const SEC = 1000
const MIN = 60 * SEC
const HOUR = 60 * MIN
/** 2026-09-24 14:52:00 UTC: the bridge's stated expiry of the session's one-hour cache. */
const EXPIRY = Date.UTC(2026, 8, 24, 14, 52, 0)
/** 2 m 30 s before it: inside the lead, and the countdown can still end more than a minute before the expiry. */
const NOW = EXPIRY - 150 * SEC
const S1 = '9d0eb37a-0000-4000-8000-000000000001'
const tcfg: TimeConfig = { zone: 'utc', dayBoundaryHour: 0, startOfWeek: 'monday', hourCycle: 'h23' }

function reading(over: Partial<PromptCacheReading> = {}): PromptCacheReading {
  return {
    warm: true, ttl: '1h', expiresAt: EXPIRY, hitRatio: 0.9, readAt: Math.floor((EXPIRY - HOUR + 6 * SEC) / 1000),
    sessionId: S1, recacheIfCold: 152_300, model: 'claude-opus-5-5', ...over,
  }
}

function entry(over: Partial<CacheWatchEntry> = {}): CacheWatchEntry {
  return {
    sessionId: S1, name: 'Session Tue 14:20 · 9d0eb37a', source: 'bridge', ttl: '1h', expiresAt: EXPIRY, phase: 'cooling',
    recache: 152_300, model: 'claude-opus-5-5', ...over,
  }
}

function lastRequest(over: Partial<LastRequest> = {}): LastRequest {
  return { at: EXPIRY - HOUR, ttl: '1h', context: 152_300, model: 'claude-opus-5-5', stop: 'end_turn', replyPending: false, ...over }
}

/** The session's main record: its newest reply 5 s after the request that set the expiry, an idle hour ago. */
function main(over: Partial<MainRec> = {}): MainRec {
  return {
    source: 'claude', sessionId: S1, firstTs: Date.UTC(2026, 8, 22, 14, 20), lastTs: EXPIRY - HOUR + 5 * SEC,
    models: ['claude-opus-5-5'], input: 1000, cacheWrite: 500, cacheWrite1h: 500, cacheRead: 90_000, output: 2000, reasoning: 0,
    requests: 12, outputFinal: 12, toolCalls: 3, ccVersion: null, permissionMode: null, compactions: 0, lastCompaction: null,
    lastRequest: lastRequest(), ...over,
  }
}

/** Facts under which every guard holds. */
function facts(over: Partial<KeepWarmFacts> = {}): KeepWarmFacts {
  return {
    enabled: true, consent: 'granted', trusted: true,
    entry: entry(), reading: reading(), main: main(),
    running: false, hook: null,
    terminals: { matching: 1, touchedSince: 'no' },
    sentThisPhase: 0, lastUnanswered: false, cancelled: false,
    quotaMax: { percent: 42, reached: false },
    ...over,
  }
}

function hook(over: Partial<HookEntry> = {}): HookEntry {
  return { ts: EXPIRY - HOUR + 30 * SEC, event: 'PermissionRequest', sessionId: S1, agentId: null, wait: 'permission', ...over }
}

const STAGES: readonly KeepWarmStage[] = ['arm', 'send']

/** The block, or 'go'. */
function verdict(f: KeepWarmFacts, now = NOW, stage: KeepWarmStage = 'arm'): KeepWarmBlock | 'go' {
  const v = keepWarmDecision(f, now, stage)
  return v.go ? 'go' : v.block
}

/** Before the expiry by `ms`. */
const left = (ms: number): number => EXPIRY - ms

// ---------------------------------------------------------------------------
// The constants (§7a Q19, §3 B2 "Modules")
// ---------------------------------------------------------------------------

test('the numbers are Q19\'s: due at 3 minutes left, a 60 s countdown, so the line at about 2; at most 3 lines; none at 90 %', () => {
  assert.equal(KEEPWARM_LEAD_MS, 3 * MIN)
  assert.equal(KEEPWARM_COUNTDOWN_MS, 60 * SEC)
  assert.equal(KEEPWARM_LEAD_MS - KEEPWARM_COUNTDOWN_MS, 2 * MIN, 'the line goes at about 2 minutes of warmth left')
  assert.equal(KEEPWARM_SEND_MARGIN_MS, 60 * SEC)
  assert.equal(KEEPWARM_IDLE_MIN_MS, 60 * SEC)
  assert.equal(KEEPWARM_VERIFY_MS, 2 * MIN)
  assert.equal(KEEPWARM_MAX_PER_IDLE, 3)
  assert.equal(KEEPWARM_QUOTA_STOP_PERCENT, 90)
  // The nudge arms inside A's cooling warning, which stays at 5 minutes.
  assert.equal(CACHE_COOLING_LEAD_MS, 5 * MIN)
  assert.ok(KEEPWARM_LEAD_MS < CACHE_COOLING_LEAD_MS)
  assert.equal(COMMAND_CONFIDENCE_MEDIUM, 1)
})

test('the line is Frederik\'s words, one ASCII line that Claude Code\'s input reads as a message, not a command', () => {
  assert.equal(KEEP_WARM_LINE, 'Ignore this message. No action. No response.')
  assert.match(KEEP_WARM_LINE, /^[ -~]+$/)
  assert.equal(/[\r\n]/.test(KEEP_WARM_LINE), false)
  assert.equal(/^[/!@#?]/.test(KEEP_WARM_LINE), false)
  assert.equal(KEEP_WARM_LINE.includes('http'), false)
})

test('the enum value G7 takes is VS Code\'s Medium, as @types/vscode declares it', () => {
  const dts = readFileSync(join(ROOT, 'node_modules', '@types', 'vscode', 'index.d.ts'), 'utf8')
  const body = /enum TerminalShellExecutionCommandLineConfidence \{([\s\S]*?)\n\t\}/.exec(dts)?.[1] ?? ''
  const values = Object.fromEntries([...body.matchAll(/^\s*(Low|Medium|High) = (\d+)/gm)].map((m) => [m[1], Number(m[2])]))
  assert.deepEqual(values, { Low: 0, Medium: 1, High: 2 })
  assert.equal(COMMAND_CONFIDENCE_MEDIUM, values.Medium)
})

test('keepWarm.ts is pure: type-only imports, no vscode, no clock, no I/O', () => {
  const src = readFileSync(join(ROOT, 'src', 'keepWarm.ts'), 'utf8')
  const imports = src.split('\n').filter((l) => /^import\b/.test(l))
  assert.ok(imports.length > 0)
  for (const l of imports) assert.match(l, /^import type \{/, l)
  for (const bad of ["'vscode'", 'Date.now', 'new Date', 'require(', 'process.', "from 'fs'", "from 'node:"]) {
    assert.equal(src.includes(bad), false, `keepWarm.ts holds ${bad}`)
  }
})

// ---------------------------------------------------------------------------
// §3 B2 test 1 · the decision table
// ---------------------------------------------------------------------------

/** One guard failing alone: its overrides, the moment and stage (default NOW, both stages), the block it gives. */
interface Case { what: string; f: Partial<KeepWarmFacts>; block: KeepWarmBlock; now?: number; stage?: KeepWarmStage }

const CASES: readonly Case[] = [
  { what: 'the setting off', f: { enabled: false }, block: 'off' },
  { what: 'consent refused', f: { consent: 'denied' }, block: 'consent' },
  { what: 'consent never asked', f: { consent: 'unasked' }, block: 'consent' },
  { what: 'Restricted Mode', f: { trusted: false }, block: 'restricted' },
  { what: 'a transcript estimate', f: { entry: entry({ source: 'transcript' }) }, block: 'noBridge' },
  { what: 'no bridge reading', f: { reading: null }, block: 'noBridge' },
  { what: 'a 5-minute cache', f: { reading: reading({ ttl: '5m' }) }, block: 'noBridge' },
  { what: 'a reading without a TTL', f: { reading: reading({ ttl: null }) }, block: 'noBridge' },
  { what: 'a reading that calls it not warm', f: { reading: reading({ warm: false }) }, block: 'noBridge' },
  { what: 'a reading without a warm flag', f: { reading: reading({ warm: null }) }, block: 'noBridge' },
  { what: 'a reading without an expiry', f: { reading: reading({ expiresAt: null }) }, block: 'noBridge' },
  { what: 'another session\'s reading', f: { reading: reading({ sessionId: '0000aaaa-0000-4000-8000-000000000002' }) }, block: 'noBridge' },
  { what: 'a reading without a session id', f: { reading: reading({ sessionId: null }) }, block: 'noBridge' },
  { what: 'more than 3 minutes left', f: {}, now: left(KEEPWARM_LEAD_MS + 1), block: 'notDue' },
  { what: 'the countdown could not end in time', f: {}, now: left(2 * MIN), stage: 'arm', block: 'tooLate' },
  { what: 'inside the last minute', f: {}, now: left(59 * SEC), stage: 'send', block: 'tooLate' },
  { what: 'the newest reply 30 s old', f: { main: main({ lastTs: NOW - 30 * SEC }) }, block: 'notIdle' },
  { what: 'no main record', f: { main: null }, block: 'notIdle' },
  { what: 'no request of the cache on the record', f: { main: main({ lastRequest: null }) }, block: 'notIdle' },
  { what: 'a reply cut off by max_tokens', f: { main: main({ lastRequest: lastRequest({ stop: 'max_tokens' }) }) }, block: 'notIdle' },
  { what: 'a paused turn', f: { main: main({ lastRequest: lastRequest({ stop: 'pause_turn' }) }) }, block: 'notIdle' },
  { what: 'no stop reason kept', f: { main: main({ lastRequest: lastRequest({ stop: null }) }) }, block: 'notIdle' },
  { what: 'a stop sequence', f: { main: main({ lastRequest: lastRequest({ stop: 'stop_sequence' }) }) }, block: 'notIdle' },
  { what: 'a refusal', f: { main: main({ lastRequest: lastRequest({ stop: 'refusal' }) }) }, block: 'notIdle' },
  { what: 'a reply that called a tool', f: { main: main({ lastRequest: lastRequest({ stop: 'tool_use' }) }) }, block: 'openTool' },
  { what: 'the newest message line the user\'s', f: { main: main({ lastRequest: lastRequest({ replyPending: true }) }) }, block: 'openTool' },
  { what: 'an agent running', f: { running: true }, block: 'agentRunning' },
  { what: 'a permission request after the reply', f: { hook: hook() }, block: 'hookWait' },
  { what: 'no terminal', f: { terminals: { matching: 0, touchedSince: 'no' } }, block: 'noTerminal' },
  { what: 'two terminals', f: { terminals: { matching: 2, touchedSince: 'no' } }, block: 'ambiguousTerminal' },
  { what: 'the terminal active in the focused window since', f: { terminals: { matching: 1, touchedSince: 'yes' } }, block: 'typedSince' },
  { what: 'a window started after the reply', f: { terminals: { matching: 1, touchedSince: 'unknown' } }, block: 'unknownFocus' },
  { what: 'three lines this phase', f: { sentThisPhase: KEEPWARM_MAX_PER_IDLE }, block: 'cap' },
  { what: 'a window at 90 %', f: { quotaMax: { percent: KEEPWARM_QUOTA_STOP_PERCENT, reached: false } }, block: 'quota' },
  { what: 'a window reached', f: { quotaMax: { percent: 12, reached: true } }, block: 'quota' },
  { what: 'the last line unanswered', f: { lastUnanswered: true }, block: 'unanswered' },
  { what: 'cancelled in this phase', f: { cancelled: true }, block: 'cancelled' },
]

test('the decision table: every guard passing is go at both stages; each guard failing alone is its block; every block is reached', () => {
  for (const stage of STAGES) assert.deepEqual(keepWarmDecision(facts(), NOW, stage), { go: true }, stage)
  const reached = new Set<KeepWarmBlock>()
  for (const c of CASES) {
    for (const stage of c.stage ? [c.stage] : STAGES) {
      assert.deepEqual(keepWarmDecision(facts(c.f), c.now ?? NOW, stage), { go: false, block: c.block }, `${c.what} (${stage})`)
    }
    reached.add(c.block)
  }
  assert.deepEqual([...reached].sort(), (Object.keys(KEEPWARM_GUARD_OF) as KeepWarmBlock[]).sort(), 'a block no case reaches')
  // The twelve guards, each with its blocks, in the table's order.
  assert.deepEqual([...new Set(Object.values(KEEPWARM_GUARD_OF))].sort((a, b) => Number(a.slice(1)) - Number(b.slice(1))),
    ['G1', 'G2', 'G3', 'G4', 'G5', 'G6', 'G7', 'G8', 'G9', 'G10', 'G11', 'G12'])
})

test('the first failing guard in the table\'s order decides; with every guard failing it is G1', () => {
  const all: Partial<KeepWarmFacts> = {}
  for (const c of CASES.filter((x) => x.now === undefined)) Object.assign(all, c.f)
  assert.equal(verdict(facts(all)), 'off')
  assert.equal(verdict(facts({ ...all, enabled: true, consent: 'granted', trusted: true })), 'noBridge')
  // Two failing guards: the lower one names the block.
  assert.equal(verdict(facts({ running: true, cancelled: true })), 'agentRunning')
  assert.equal(verdict(facts({ sentThisPhase: 3, terminals: { matching: 0, touchedSince: 'yes' } })), 'noTerminal')
})

test('a fact that is not exactly the passing value blocks: a wrong fact may only keep the line back', () => {
  const odd = (o: Record<string, unknown>): KeepWarmFacts => ({ ...facts(), ...o }) as unknown as KeepWarmFacts
  assert.equal(verdict(odd({ enabled: 'true' })), 'off')
  assert.equal(verdict(odd({ trusted: 1 })), 'restricted')
  assert.equal(verdict(odd({ running: undefined })), 'agentRunning')
  assert.equal(verdict(odd({ lastUnanswered: null })), 'unanswered')
  assert.equal(verdict(odd({ cancelled: 0 })), 'cancelled')
  for (const n of [Number.NaN, -1, 1.5, Infinity]) assert.equal(verdict(facts({ sentThisPhase: n })), 'cap', String(n))
  for (const n of [Number.NaN, 0.5, -1]) assert.equal(verdict(facts({ terminals: { matching: n, touchedSince: 'no' } })), 'noTerminal', String(n))
  assert.equal(verdict(odd({ terminals: undefined })), 'noTerminal')
  assert.equal(verdict(facts({ quotaMax: { percent: Number.NaN, reached: false } })), 'quota')
  assert.equal(verdict(facts({ main: main({ lastTs: Number.NaN }) })), 'notIdle')
  assert.equal(verdict(facts({ main: main({ lastRequest: { ...lastRequest(), replyPending: undefined } as unknown as LastRequest }) })), 'openTool')
  assert.equal(verdict(facts({ reading: reading({ expiresAt: Number.NaN }) })), 'noBridge')
  assert.equal(verdict(facts(), Number.NaN), 'notDue')
})

// ---------------------------------------------------------------------------
// §7a Q19 · the timing (G3)
// ---------------------------------------------------------------------------

test('Q19: the countdown arms at 3 minutes left or less (2:59 arms, 3:01 does not); the line goes before the last minute (2:00 goes, 0:59 does not)', () => {
  assert.equal(verdict(facts(), left(2 * MIN + 59 * SEC), 'arm'), 'go')
  assert.equal(verdict(facts(), left(3 * MIN), 'arm'), 'go', 'exactly 3 minutes left is due')
  assert.equal(verdict(facts(), left(3 * MIN + 1 * SEC), 'arm'), 'notDue')
  assert.equal(verdict(facts(), left(2 * MIN), 'send'), 'go')
  assert.equal(verdict(facts(), left(59 * SEC), 'send'), 'tooLate')
  assert.equal(verdict(facts(), left(60 * SEC), 'send'), 'tooLate', 'the line starts MORE than a minute before the expiry')
  assert.equal(verdict(facts(), left(61 * SEC), 'send'), 'go')
  // A countdown armed at 2:59 ends at 1:59 left, a line that may go; one that would end inside the
  // last minute is not started: arming needs more than 2 minutes left.
  assert.equal(verdict(facts(), left(2 * MIN + 1 * SEC), 'arm'), 'go')
  assert.equal(verdict(facts(), left(2 * MIN), 'arm'), 'tooLate')
  // Expired: too late at either stage.
  for (const stage of STAGES) assert.equal(verdict(facts(), EXPIRY + 5 * SEC, stage), 'tooLate', stage)
})

test('Q19 over time: arm goes exactly while 2 to 3 minutes are left, send while 1 to 3 minutes are left (a sweep in seconds)', () => {
  for (let t = left(10 * MIN); t <= EXPIRY + 2 * MIN; t += SEC) {
    const rest = EXPIRY - t
    assert.equal(verdict(facts(), t, 'arm'), rest > 3 * MIN ? 'notDue' : rest > 2 * MIN ? 'go' : 'tooLate', `arm at ${rest} ms left`)
    assert.equal(verdict(facts(), t, 'send'), rest > 3 * MIN ? 'notDue' : rest > 1 * MIN ? 'go' : 'tooLate', `send at ${rest} ms left`)
  }
})

test('a window that slept past the moment sends nothing late; an expiry that moved out during the countdown needs no line', () => {
  // Armed at 2:59 left; the machine slept through the countdown's end and wakes 30 s before the expiry.
  const armedAt = left(2 * MIN + 59 * SEC)
  assert.equal(verdict(facts(), armedAt, 'arm'), 'go')
  assert.equal(verdict(facts(), armedAt + KEEPWARM_COUNTDOWN_MS, 'send'), 'go', 'on time')
  assert.equal(verdict(facts(), left(30 * SEC), 'send'), 'tooLate', 'woke too late')
  // During the countdown the session sent a request: the status line states a new hour.
  const moved = reading({ expiresAt: armedAt + 30 * SEC + HOUR })
  assert.equal(verdict(facts({ reading: moved, entry: entry({ expiresAt: moved.expiresAt as number }) }), armedAt + KEEPWARM_COUNTDOWN_MS, 'send'), 'notDue')
})

// ---------------------------------------------------------------------------
// §3 B2 test 2 · G2: a transcript estimate never arms
// ---------------------------------------------------------------------------

test('G2: a transcript-sourced entry never arms and never sends, at any moment — even beside a reading that would pass', () => {
  // Mutation check (§3 B2 test 2): letting the transcript source through (dropping the entry's
  // source test) sends on the stale reading below — these asserts fail.
  const stale = reading()
  for (let t = EXPIRY - 70 * MIN; t <= EXPIRY + 70 * MIN; t += 15 * SEC) {
    for (const stage of STAGES) {
      assert.equal(verdict(facts({ entry: entry({ source: 'transcript' }), reading: null }), t, stage), 'noBridge')
      assert.equal(verdict(facts({ entry: entry({ source: 'transcript' }), reading: stale }), t, stage), 'noBridge')
    }
  }
})

test('G2 through the watch: a reading older than the transcript\'s newest request leaves the entry the transcript\'s, and it never arms', () => {
  // The transcript counted a request 11 s after the status line last ran: A1 rule 3 gives the
  // session to the transcript, whose expiry is an estimate.
  const request = EXPIRY - HOUR
  const rec = main({ lastRequest: lastRequest({ at: request }), lastTs: request + 5 * SEC })
  const staleReading = reading({ readAt: Math.floor((request - 11 * SEC) / 1000), expiresAt: request - 11 * SEC + HOUR })
  const input = { readings: [staleReading], mains: [[`/p/${S1}.jsonl`, rec] as const], tcfg }
  const at = left(150 * SEC)
  const [e] = watchCaches(input, at)
  assert.equal(e.source, 'transcript')
  assert.equal(e.phase, 'cooling')
  for (const stage of STAGES) assert.equal(verdict(facts({ entry: e, reading: staleReading, main: rec }), at, stage), 'noBridge', stage)
  // The same session with the status line run after the request: the bridge's, and it goes.
  const fresh = reading({ readAt: Math.floor((request + 6 * SEC) / 1000) })
  const [b] = watchCaches({ ...input, readings: [fresh] }, at)
  assert.equal(b.source, 'bridge')
  for (const stage of STAGES) assert.equal(verdict(facts({ entry: b, reading: fresh, main: rec }), at, stage), 'go', stage)
  // Transcript-only (no reading at all): the watch lists it, the nudge does not arm.
  const [t] = watchCaches({ ...input, readings: [] }, at)
  assert.equal(t.source, 'transcript')
  assert.equal(verdict(facts({ entry: t, reading: null, main: rec }), at), 'noBridge')
})

// ---------------------------------------------------------------------------
// §3 B2 test 3 · G4, with the probe P-6 shape
// ---------------------------------------------------------------------------

test('G4: tool_use → openTool; max_tokens, pause_turn, none → notIdle; the newest reply 30 s old → notIdle; end_turn a minute old → go', () => {
  const withStop = (stop: LastRequest['stop']): KeepWarmFacts => facts({ main: main({ lastRequest: lastRequest({ stop }) }) })
  // Mutation check (§3 B2 test 3): dropping the end_turn test lets this one through.
  assert.equal(verdict(withStop('tool_use')), 'openTool')
  for (const stop of ['max_tokens', 'pause_turn', null, 'stop_sequence', 'refusal'] as const) assert.equal(verdict(withStop(stop)), 'notIdle', String(stop))
  assert.equal(verdict(withStop('end_turn')), 'go')
  assert.equal(verdict(facts({ main: main({ lastTs: NOW - 30 * SEC }) })), 'notIdle')
  assert.equal(verdict(facts({ main: main({ lastTs: NOW - KEEPWARM_IDLE_MIN_MS + 1 }) })), 'notIdle')
  assert.equal(verdict(facts({ main: main({ lastTs: NOW - KEEPWARM_IDLE_MIN_MS }) })), 'go', 'exactly a minute is idle')
  assert.equal(verdict(facts({ main: main({ lastTs: NOW + 5 * SEC }) })), 'notIdle', 'a reply dated after now')
})

/** The session of the fixtures' main transcript, as the aggregator keeps it after `lines`. */
function recordAfter(lines: readonly string[]): MainRec {
  const agg = new Aggregator()
  for (const l of lines) agg.addClaudeLine(l, ctxFor())
  const rec = agg.mainEntries().find(([file]) => file === CLAUDE_MAIN)?.[1]
  assert.ok(rec, 'no main record')
  return rec
}

test('G4, the probe P-6 shape through the reader: an end_turn reply, then a prompt 5 minutes old and nothing after it → openTool; a tool result newest → openTool', () => {
  const sid = 'sess-0001'
  const request = EXPIRY - HOUR
  const reply = claudeLine({ id: 'm1', ts: request, usage: { input: 3, cacheWrite: 6000, cacheWrite1h: 6000, cacheRead: 140_000, output: 50 }, final: true })
  const f = (rec: MainRec): KeepWarmFacts =>
    facts({ entry: entry({ sessionId: sid }), reading: reading({ sessionId: sid }), main: rec })
  // The fixture passes as it stands: the end_turn reply is the newest message line.
  const idle = recordAfter([promptLine({ ts: request - 2 * SEC }), reply])
  assert.deepEqual([idle.lastRequest?.stop, idle.lastRequest?.replyPending], ['end_turn', false])
  for (const stage of STAGES) assert.equal(verdict(f(idle), NOW, stage), 'go', stage)
  // P-6: the user asked something 5 minutes ago; the reply calling AskUserQuestion is written only
  // when the question is answered, so the prompt is the newest line — and the previous reply still
  // reads end_turn. Mutation check (§3 B2 test 3): dropping the replyPending test sends here.
  const asked = recordAfter([promptLine({ ts: request - 2 * SEC }), reply, promptLine({ ts: NOW - 5 * MIN })])
  assert.deepEqual([asked.lastRequest?.stop, asked.lastRequest?.replyPending], ['end_turn', true])
  assert.ok(asked.lastTs <= NOW - KEEPWARM_IDLE_MIN_MS, 'the prompt does not move the record\'s last reply')
  for (const stage of STAGES) assert.equal(verdict(f(asked), NOW, stage), 'openTool', stage)
  // A tool result newest (a tool finished, the next reply not yet written): the same.
  const toolDone = recordAfter([
    promptLine({ ts: request - 2 * SEC }),
    claudeLine({ id: 'm1', ts: request, usage: { input: 3, cacheWrite: 6000, cacheWrite1h: 6000, output: 50 }, final: true, stopReason: 'tool_use', tools: [{ name: 'Bash', id: 'toolu_k1' }] }),
    toolResultLine({ ts: request + 4 * SEC, results: [{ toolUseId: 'toolu_k1' }] }),
  ])
  assert.equal(toolDone.lastRequest?.replyPending, true)
  for (const stage of STAGES) assert.equal(verdict(f(toolDone), NOW, stage), 'openTool', stage)
})

// ---------------------------------------------------------------------------
// §3 B2 test 4 · G6, the agent hook
// ---------------------------------------------------------------------------

test('G6: a permission request newer than the newest reply → hookWait; one the reply answered, a wait for input, none → go', () => {
  const lastTs = main().lastTs
  assert.equal(verdict(facts({ hook: hook({ ts: lastTs + 1 }) })), 'hookWait')
  assert.equal(verdict(facts({ hook: hook({ ts: Number.NaN }) })), 'hookWait', 'a request of no known time')
  assert.equal(verdict(facts({ hook: hook({ ts: lastTs }) })), 'go', 'answered by the reply')
  assert.equal(verdict(facts({ hook: hook({ ts: lastTs - MIN }) })), 'go')
  // After an end_turn reply the one documented `input` notification is the idle prompt (G4 holds).
  assert.equal(verdict(facts({ hook: hook({ event: 'Notification', wait: 'input', ts: lastTs + 1 }) })), 'go')
  assert.equal(verdict(facts({ hook: hook({ event: 'SubagentStop', wait: 'none', ts: lastTs + 1 }) })), 'go')
  assert.equal(verdict(facts({ hook: null })), 'go', 'no hook installed')
})

// ---------------------------------------------------------------------------
// §3 B2 test 5 · G7: which shell execution runs the session
// ---------------------------------------------------------------------------

test('CLAUDE_COMMAND_RE: claude, a path ending in it, claude.exe — not claude-dev, npx claude, claude.cmd', () => {
  for (const line of ['claude', 'claude --resume', '  claude -c', '/usr/local/bin/claude', 'C:\\Tools\\claude.exe', './claude',
    'CLAUDE', '~/.local/bin/claude --model opus', 'C:\\Tools\\Claude.EXE --resume']) {
    assert.equal(CLAUDE_COMMAND_RE.test(line), true, line)
  }
  for (const line of ['claude-dev', 'npx claude', 'claude.cmd', 'claudex', 'echo claude', 'cd claude', '/opt/claude/bin/node',
    'my claude', '', '"claude"', '/usr/bin/claude-code']) {
    assert.equal(CLAUDE_COMMAND_RE.test(line), false, line)
  }
  assert.equal(CLAUDE_COMMAND_RE.global, false, 'a g flag would keep state between tests')
})

test('projectDirName: every character of the path outside [A-Za-z0-9-] becomes -', () => {
  assert.equal(projectDirName('/home/u/synthetic-project'), '-home-u-synthetic-project')
  assert.equal(projectDirName('/home/tester/proj-alpha'), CLAUDE_SLUG)
  assert.equal(projectDirName('/home/u/Work/Some-Repo_v2'), '-home-u-Work-Some-Repo-v2')
  assert.equal(projectDirName('/home/u/.claude/x.y z'), '-home-u--claude-x-y-z')
  assert.equal(projectDirName('C:\\Users\\u\\proj'), 'C--Users-u-proj')
  assert.equal(projectDirName('/home/u/Übung'), '-home-u--bung')
  // A trailing separator is no part of the name; a root keeps its own.
  assert.equal(projectDirName('/home/u/proj/'), '-home-u-proj')
  assert.equal(projectDirName('C:\\Users\\u\\proj\\'), 'C--Users-u-proj')
  assert.equal(projectDirName('/'), '-')
  assert.equal(projectDirName('C:\\'), 'C--')
  assert.equal(projectDirName(''), '')
  assert.equal(projectDirName(undefined as unknown as string), '')
})

test('G7 per execution: claude at Medium or High confidence in the session\'s project directory — not Low, not another project, not another program', () => {
  const ex = (over: Partial<ShellExecutionFacts> = {}): ShellExecutionFacts =>
    ({ commandLine: 'claude --resume', confidence: 2, cwd: '/home/tester/proj-alpha', ...over })
  assert.equal(claudeExecutionMatches(ex(), CLAUDE_SLUG), true)
  assert.equal(claudeExecutionMatches(ex({ confidence: 1 }), CLAUDE_SLUG), true, 'Medium')
  assert.equal(claudeExecutionMatches(ex({ confidence: 0 }), CLAUDE_SLUG), false, 'Low')
  assert.equal(claudeExecutionMatches(ex({ confidence: Number.NaN }), CLAUDE_SLUG), false)
  // Mutation check (§3 B2 test 5): dropping the cwd comparison matches another project's claude.
  assert.equal(claudeExecutionMatches(ex({ cwd: '/home/tester/proj-beta' }), CLAUDE_SLUG), false, 'another project')
  assert.equal(claudeExecutionMatches(ex({ cwd: '/home/tester/proj-alpha/sub' }), CLAUDE_SLUG), false, 'a folder inside it')
  assert.equal(claudeExecutionMatches(ex({ cwd: null }), CLAUDE_SLUG), false, 'no working directory reported')
  assert.equal(claudeExecutionMatches(ex({ cwd: '' }), CLAUDE_SLUG), false)
  assert.equal(claudeExecutionMatches(ex(), ''), false, 'no transcript directory')
  for (const commandLine of ['claude-dev', 'npx claude', 'bash', '']) {
    assert.equal(claudeExecutionMatches(ex({ commandLine }), CLAUDE_SLUG), false, commandLine)
  }
  for (const commandLine of ['/usr/local/bin/claude', 'C:\\Tools\\claude.exe']) {
    assert.equal(claudeExecutionMatches(ex({ commandLine }), CLAUDE_SLUG), true, commandLine)
  }
  // Only the start of a command line is tested.
  assert.equal(claudeExecutionMatches(ex({ commandLine: `claude "${'x'.repeat(5000)}"` }), CLAUDE_SLUG), true)
  assert.equal(claudeExecutionMatches(ex({ commandLine: `${'/a'.repeat(COMMAND_LINE_TESTED_CHARS)}/claude` }), CLAUDE_SLUG), false)
  // Windows: VS Code's fsPath lower-cases the drive letter; only that letter's case is forgiven.
  const win = 'C--Users-u-proj'
  assert.equal(claudeExecutionMatches(ex({ cwd: 'c:\\Users\\u\\proj', commandLine: 'claude.exe' }), win), true)
  assert.equal(claudeExecutionMatches(ex({ cwd: 'C:\\Users\\u\\Proj', commandLine: 'claude.exe' }), win), false)
  assert.equal(claudeExecutionMatches(ex({ cwd: '/home/tester/Proj-alpha' }), CLAUDE_SLUG), false, 'POSIX paths keep their case')
  assert.equal(typeof claudeExecutionMatches(ex(), CLAUDE_SLUG), 'boolean', 'nothing of the execution comes back')
})

test('G7 on facts: none → noTerminal, two → ambiguousTerminal, exactly one → go', () => {
  assert.equal(verdict(facts({ terminals: { matching: 0, touchedSince: 'no' } })), 'noTerminal')
  assert.equal(verdict(facts({ terminals: { matching: 2, touchedSince: 'no' } })), 'ambiguousTerminal')
  assert.equal(verdict(facts({ terminals: { matching: 5, touchedSince: 'yes' } })), 'ambiguousTerminal')
  assert.equal(verdict(facts({ terminals: { matching: 1, touchedSince: 'no' } })), 'go')
})

// ---------------------------------------------------------------------------
// §3 B2 test 6 · G8: the terminal touched since the reply
// ---------------------------------------------------------------------------

test('G8: the terminal active in a focused window since the reply → typedSince; a window started after it → unknownFocus', () => {
  // Mutation check (§3 B2 test 6): dropping G8 lets both through.
  for (const stage of STAGES) {
    assert.equal(verdict(facts({ terminals: { matching: 1, touchedSince: 'yes' } }), NOW, stage), 'typedSince', stage)
    assert.equal(verdict(facts({ terminals: { matching: 1, touchedSince: 'unknown' } }), NOW, stage), 'unknownFocus', stage)
    assert.equal(verdict(facts({ terminals: { matching: 1, touchedSince: 'no' } }), NOW, stage), 'go', stage)
  }
})

// ---------------------------------------------------------------------------
// §3 B2 tests 9 and 10 · G9, G11, G10
// ---------------------------------------------------------------------------

test('G9, G11: three answered lines → the fourth is cap; a new idle phase starts at none; an unanswered line stops the phase', () => {
  for (let n = 0; n < KEEPWARM_MAX_PER_IDLE; n++) assert.equal(verdict(facts({ sentThisPhase: n })), 'go', `line ${n + 1}`)
  assert.equal(verdict(facts({ sentThisPhase: KEEPWARM_MAX_PER_IDLE })), 'cap', 'the fourth')
  assert.equal(verdict(facts({ sentThisPhase: KEEPWARM_MAX_PER_IDLE + 4 })), 'cap')
  // A request of the user's own ends the phase: the host counts from none again.
  assert.equal(verdict(facts({ sentThisPhase: 0 })), 'go')
  // No answer within KEEPWARM_VERIFY_MS: no further line in the phase, whatever the count.
  assert.equal(verdict(facts({ sentThisPhase: 1, lastUnanswered: true })), 'unanswered')
  assert.equal(verdict(facts({ sentThisPhase: 1, lastUnanswered: false })), 'go')
})

test('G10: a Claude window at 90 % or reached → quota; below it → go; no reading → not blocked', () => {
  assert.equal(verdict(facts({ quotaMax: { percent: 90, reached: false } })), 'quota')
  assert.equal(verdict(facts({ quotaMax: { percent: 104, reached: false } })), 'quota')
  assert.equal(verdict(facts({ quotaMax: { percent: 3, reached: true } })), 'quota')
  assert.equal(verdict(facts({ quotaMax: { percent: 89.9, reached: false } })), 'go')
  assert.equal(verdict(facts({ quotaMax: null })), 'go', 'no reading')
})

// ---------------------------------------------------------------------------
// §3 B2 test 13 · Restricted Mode; Codex
// ---------------------------------------------------------------------------

test('Restricted Mode blocks with every other guard passing, at both stages', () => {
  for (const stage of STAGES) assert.equal(verdict(facts({ trusted: false }), NOW, stage), 'restricted', stage)
})

test('a Codex session is never an entry: the watch lists the Claude session of a mixed machine and nothing of the Codex rollout', () => {
  const agg = new Aggregator()
  const cur = { offset: 0, size: 0, ino: 1, dev: 1 }
  const turn = NOW - 5 * MIN
  for (const l of [
    codexMeta({ ts: turn - MIN }),
    codexTurnContext(turn - MIN, 'gpt-5.6-sol'),
    codexTokenCount({ ts: turn, total: { input: 90_000, cached: 80_000, output: 500, total: 90_500 } }),
  ]) agg.addCodexLine(l, cur, ctxFor({ file: CODEX_FILE }))
  assert.equal(agg.codexLastTurn()?.model, 'gpt-5.6-sol', 'the Codex turn was counted')
  assert.deepEqual(watchCaches({ readings: [], mains: agg.mainEntries(), tcfg }, NOW), [], 'a Codex-only machine has no entry')
  const request = EXPIRY - HOUR
  agg.addClaudeLine(claudeLine({ id: 'm1', ts: request, usage: { input: 3, cacheWrite: 6000, cacheWrite1h: 6000, output: 50 }, final: true }), ctxFor())
  const mains = agg.mainEntries()
  assert.deepEqual(mains.map(([file]) => file), [CLAUDE_MAIN], 'the Codex rollout makes no main record')
  const entries = watchCaches({ readings: [], mains, tcfg }, request + TTL_MS['1h'] - 150 * SEC)
  assert.deepEqual(entries.map((e) => e.sessionId), ['sess-0001'])
})
