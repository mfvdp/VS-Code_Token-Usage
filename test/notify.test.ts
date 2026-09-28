// SPDX-FileCopyrightText: 2026 Frederik Marx
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * 1.12 C2–C4, §0a.5–§0a.7, §0a.10 (P6): the notifications' core — each event with its default, its source and
 * its once-rule (C14 item 1), no storm (item 2), the payload under its allow-list with the leak tests (item 3).
 * Pure: no channel, no network, no vscode — the memento is a fake that records the order of its calls.
 */

import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { HookEntry } from '../src/agentTree'
import { NotifyConfig, readNotifyConfig } from '../src/config'
import { setBundle, setLocale } from '../src/i18n'
import {
  admit, AGENT_DONE_MIN_MS, AGENT_WAIT_AFTER_MS, cleanNotifyState, collectEvents, droppedLines, emptyNotifyState,
  loadNotifyState, newNotifyTables, NOTIFY_HOURLY_CAP, NOTIFY_STATE_KEY, NotificationEvent, NotificationPayload,
  NotifyInput, notifyRound, NotifyState, NotifyWords, payloadOf, pruneNotifyState, QUOTA_RESET_RECENT_MS, quotaEvents,
  markToldWaits, testPayload, turnEvents, waitEvents,
} from '../src/notify'
import { MementoLike } from '../src/storage'
import { TimeConfig } from '../src/time'
import { Forecast, LastRequest, MainRec, QuotaState, QuotaWindow } from '../src/types'
import { ROOT } from './helpers/nls'

const NOW = Date.UTC(2026, 8, 27, 12, 0)
const SEC = 1000
const MIN = 60 * SEC
const HOUR = 60 * MIN
const STALE_MS = 20 * MIN
const TCFG: TimeConfig = { zone: 'utc', dayBoundaryHour: 0, startOfWeek: 'monday', hourCycle: 'h23' }
const WORDS: NotifyWords = { tcfg: TCFG, now: NOW }
const SESSION = '9d0eb37a-synthetic'
const ALL_EVENTS = ['agentWaiting', 'agentDone', 'quotaThreshold', 'quotaExhausted', 'quotaReset', 'paceWarning']

/** Records every call, so "persist before send" and "no state read" are observable. */
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

/** The reader's settings through the product's own sanitiser: one channel, every event listed unless said otherwise. */
function cfg(over: Record<string, unknown> = {}): NotifyConfig {
  const raw: Record<string, unknown> = {
    'tokenPace.notifications.channels': ['webhook'],
    'tokenPace.notifications.events': ALL_EVENTS,
    ...over,
  }
  return readNotifyConfig((k) => raw[k])
}

function win(over: Partial<QuotaWindow> = {}): QuotaWindow {
  return {
    id: 'session:300', kind: 'session', label: '5 h', shortLabel: '5h', model: null, percent: 82,
    resetsAt: NOW + 2 * HOUR, windowMinutes: 300, limitReached: false, unlimited: false, ...over,
  }
}

function weekly(over: Partial<QuotaWindow> = {}): QuotaWindow {
  return win({ id: 'weekly_all:10080', kind: 'weekly', label: '7 d', shortLabel: '7d', resetsAt: NOW + 3 * 24 * HOUR, windowMinutes: 10080, percent: 40, ...over })
}

/** A reading fetched a minute before NOW — fresh by the status bar's rule. */
function reading(windows: QuotaWindow[], over: Partial<QuotaState> = {}): QuotaState {
  return { source: 'claude', ok: true, origin: 'poll', fetchedAt: Math.floor((NOW - MIN) / 1000), planType: 'synthetic-plan', windows, ...over }
}

function eta(etaMs: number, over: Partial<Forecast> = {}): Forecast {
  return {
    state: 'eta', ratePerHour: 10, etaMs, endPercent: 120, sustainablePerHour: 5, confidence: 'high',
    basis: { samples: 8, spanMs: HOUR }, text: '~empty in 1.5 h', ...over,
  }
}

function lastRequest(over: Partial<LastRequest> = {}): LastRequest {
  return { at: NOW - 10 * MIN, ttl: '5m', context: 1000, model: 'claude-opus-5-5', stop: 'end_turn', replyPending: false, ...over }
}

function main(over: Partial<MainRec> = {}): MainRec {
  return {
    source: 'claude', sessionId: SESSION, firstTs: NOW - 5 * HOUR, lastTs: NOW - 10 * MIN, models: ['claude-opus-5-5'],
    input: 1, cacheWrite: 0, cacheWrite1h: 0, cacheRead: 0, output: 1, reasoning: 0, requests: 1, outputFinal: 1, toolCalls: 0,
    ccVersion: null, permissionMode: null, compactions: 0, lastCompaction: null, lastRequest: lastRequest(), lastUserAt: null, ...over,
  }
}

/** A turn that is open: the user's line is the newest. */
const OPEN = lastRequest({ replyPending: true, stop: null })

function hook(over: Partial<HookEntry> = {}): HookEntry {
  return { ts: NOW - 61 * SEC, event: 'PermissionRequest', sessionId: SESSION, agentId: null, wait: 'permission', ...over }
}

function input(over: Partial<NotifyInput> = {}): NotifyInput {
  return { states: [], forecasts: new Map(), mains: [], hooks: [], focused: false, settled: true, role: 'leader', staleAfterMs: STALE_MS, ...over }
}

const kinds = (events: readonly NotificationEvent[]): string[] => events.map((e) => e.event)

/** One quota evaluation and its admission, as the host runs them: the events, then `admit` on the same state. */
function evaluate(states: QuotaState[], st: NotifyState, now = NOW, c = cfg(), forecasts = new Map<string, Forecast>()): NotificationEvent[][] {
  return admit(quotaEvents(states, forecasts, c, st, now, STALE_MS), c, st, now).send
}

function withGerman(fn: () => void): void {
  setBundle(JSON.parse(readFileSync(join(ROOT, 'l10n', 'bundle.l10n.de.json'), 'utf8')) as Record<string, string>)
  setLocale('de')
  try {
    fn()
  } finally {
    setBundle(undefined)
    setLocale(undefined)
  }
}

// ---------------------------------------------------------------------------
// C2 · the quota events (§0a.7) — C14 item 1
// ---------------------------------------------------------------------------

test('quotaThreshold: a fresh reading at or above its kind\'s threshold fires once per window cycle, only upwards, and a new cycle speaks again (1.12 C2 rule 3)', () => {
  const st = emptyNotifyState()
  const first = evaluate([reading([win({ percent: 82 })])], st)
  assert.deepEqual(first.map(kinds), [['quotaThreshold']])
  assert.equal(first[0][0].identity, `quotaThreshold:claude:session:300:${NOW + 2 * HOUR}`)
  assert.deepEqual([first[0][0].provider, first[0][0].windowLabel, first[0][0].windowKind, first[0][0].percent], ['claude', '5 h', 'session', 82])
  // The same cycle higher up, and after the cooldown: already said.
  assert.deepEqual(evaluate([reading([win({ percent: 95 })], { fetchedAt: Math.floor((NOW + HOUR) / 1000) })], st, NOW + HOUR + MIN), [])
  // A reset time that only jittered is the same cycle (Claude Code's sub-second jitter, RESET_JITTER_MS).
  assert.deepEqual(evaluate([reading([win({ percent: 90, resetsAt: NOW + 2 * HOUR + 4 * SEC })], { fetchedAt: Math.floor((NOW + HOUR) / 1000) })], st, NOW + HOUR + 2 * MIN), [])
  // The next cycle is a new subject.
  const next = evaluate([reading([win({ percent: 81, resetsAt: NOW + 7 * HOUR })], { fetchedAt: Math.floor((NOW + 3 * HOUR) / 1000) })], st, NOW + 3 * HOUR + MIN)
  assert.deepEqual(next.map(kinds), [['quotaThreshold']])
  // Below the threshold nothing.
  assert.deepEqual(evaluate([reading([win({ percent: 79.9 })])], emptyNotifyState()), [])
})

test('quotaThreshold per window kind: session 80 and weekly 80 by default, 0 turns one off, an other window never has one, a model-scoped weekly window takes the weekly one (1.12 C2 rule 3, §7a Q13)', () => {
  const scoped = weekly({ id: 'weekly_scoped:10080:fable', label: '7 d · Fable', model: 'Fable', percent: 85 })
  const other = win({ id: 'other:60', kind: 'other', label: '1 h', percent: 99 })
  const events = quotaEvents([reading([win({ percent: 85 }), weekly({ percent: 90 }), scoped, other])], new Map(), cfg(), emptyNotifyState(), NOW, STALE_MS)
  assert.deepEqual(events.map((e) => [e.event, e.windowLabel]), [['quotaThreshold', '5 h'], ['quotaThreshold', '7 d'], ['quotaThreshold', '7 d · Fable']])
  const off = cfg({ 'tokenPace.notifications.thresholds': { session: 0, weekly: 95 } })
  assert.deepEqual(quotaEvents([reading([win({ percent: 99 }), weekly({ percent: 90 })])], new Map(), off, emptyNotifyState(), NOW, STALE_MS), [])
})

test('several windows past their threshold in one evaluation are one message listing each; an exhausted window says only that (1.12 C2 rules 3–4, C3 rule 1)', () => {
  const st = emptyNotifyState()
  const codex = reading([win({ id: 'codex:300', label: '5 h', percent: 88 })], { source: 'codex' })
  const groups = evaluate([reading([win({ percent: 100 }), weekly({ percent: 85 })]), codex], st)
  assert.deepEqual(groups.map(kinds), [['quotaThreshold', 'quotaThreshold'], ['quotaExhausted']])
  // The exhausted 5 h window's threshold is not in the threshold message.
  assert.deepEqual(groups[0].map((e) => `${e.provider}:${e.windowLabel}`), ['claude:7 d', 'codex:5 h'])
  const p = payloadOf(groups[0], WORDS)
  assert.equal(p.text.split('\n').length, 2)
  assert.deepEqual((p.json.items as Array<Record<string, unknown>>).map((i) => i.provider), ['claude', 'codex'])
})

test('quotaExhausted: the provider\'s limitReached or 100 %, once per cycle, both providers, never an unlimited window (1.12 C2 rule 4)', () => {
  const st = emptyNotifyState()
  const groups = evaluate([
    reading([win({ percent: 97, limitReached: true })]),
    reading([win({ id: 'codex:10080', kind: 'weekly', label: '7 d', percent: 100, resetsAt: NOW + 2 * 24 * HOUR })], { source: 'codex' }),
    reading([win({ id: 'codex_credits:0', kind: 'other', percent: 100, unlimited: true })], { source: 'codex' }),
  ], st)
  assert.deepEqual(groups.map(kinds), [['quotaExhausted', 'quotaExhausted']])
  assert.deepEqual(groups[0].map((e) => e.provider), ['claude', 'codex'])
  assert.deepEqual(evaluate([reading([win({ percent: 100 })], { fetchedAt: Math.floor((NOW + HOUR) / 1000) })], st, NOW + HOUR + MIN), [])
})

test('nothing from a stale reading, a failed one, one of unknown age, or a window whose reset has already come (1.12 C2 rule 7)', () => {
  const c = cfg()
  const f = new Map([['claude:session:300', eta(NOW + HOUR)]])
  const stale = reading([win({ percent: 100 }), weekly({ percent: 90 })], { fetchedAt: Math.floor((NOW - STALE_MS - MIN) / 1000) })
  assert.deepEqual(quotaEvents([stale], f, c, emptyNotifyState(), NOW, STALE_MS), [])
  assert.deepEqual(quotaEvents([reading([win({ percent: 100 })], { ok: false })], f, c, emptyNotifyState(), NOW, STALE_MS), [])
  assert.deepEqual(quotaEvents([reading([win({ percent: 100 })], { fetchedAt: null })], f, c, emptyNotifyState(), NOW, STALE_MS), [])
  // Fresh, but the window it describes is over: its reset lies before now.
  assert.deepEqual(quotaEvents([reading([win({ percent: 95, resetsAt: NOW - MIN })])], f, c, emptyNotifyState(), NOW, STALE_MS), [])
  // The same reading a minute old speaks.
  assert.deepEqual(kinds(quotaEvents([reading([win({ percent: 95 })])], f, c, emptyNotifyState(), NOW, STALE_MS)), ['quotaThreshold', 'paceWarning'])
})

test('quotaReset: a later reset for a window whose stored cycle ended 5 min ago is sent, one that ended 40 min ago is stale news, a first sight or a jitter is none (1.12 C2 rule 5)', () => {
  const c = cfg()
  const st = emptyNotifyState()
  // First sight: the cycle is recorded, nothing is said.
  assert.deepEqual(quotaEvents([reading([win({ percent: 60, resetsAt: NOW - 5 * MIN })], { fetchedAt: Math.floor((NOW - 6 * MIN) / 1000) })], new Map(), c, st, NOW - 6 * MIN, STALE_MS), [])
  assert.equal(st.cycles['claude:session:300'].resetsAt, NOW - 5 * MIN)
  const events = quotaEvents([reading([win({ percent: 3, resetsAt: NOW + 5 * HOUR - 5 * MIN })])], new Map(), c, st, NOW, STALE_MS)
  assert.deepEqual(kinds(events), ['quotaReset'])
  assert.equal(events[0].since, NOW - 5 * MIN)
  assert.equal(events[0].resetsAt, NOW + 5 * HOUR - 5 * MIN)
  assert.equal(events[0].percent, 3)
  assert.equal(events[0].identity, `quotaReset:claude:session:300:${NOW - 5 * MIN}`)
  // 40 minutes late: VS Code was closed — not news.
  const late = emptyNotifyState()
  late.cycles['claude:session:300'] = { resetsAt: NOW - 40 * MIN, percent: 70, seenAt: NOW - 3 * HOUR }
  assert.deepEqual(quotaEvents([reading([win({ percent: 1, resetsAt: NOW + 4 * HOUR })])], new Map(), c, late, NOW, STALE_MS), [])
  assert.ok(QUOTA_RESET_RECENT_MS < 40 * MIN)
  // A reset that jittered by seconds after its time is the same, stale view of the old window — no reset.
  const jitter = emptyNotifyState()
  jitter.cycles['claude:session:300'] = { resetsAt: NOW - 2 * MIN, percent: 70, seenAt: NOW - 3 * MIN }
  assert.deepEqual(quotaEvents([reading([win({ percent: 70, resetsAt: NOW - 2 * MIN + 3 * SEC })])], new Map(), c, jitter, NOW, STALE_MS), [])
  // Off by default: the collect file's "aus".
  assert.deepEqual(quotaEvents([reading([win({ percent: 3, resetsAt: NOW + 5 * HOUR })])], new Map(), readNotifyConfig(() => undefined), st, NOW, STALE_MS), [])
})

test('paceWarning: only with a forecast whose ETA lies after now and before the reset, not for an exhausted window, once per cycle (1.12 C2 rule 6)', () => {
  const c = cfg({ 'tokenPace.notifications.thresholds': { session: 0, weekly: 0 } })
  const key = 'claude:session:300'
  const at = (f: Forecast, w = win({ percent: 50 })): string[] => kinds(quotaEvents([reading([w])], new Map([[key, f]]), c, emptyNotifyState(), NOW, STALE_MS))
  assert.deepEqual(at(eta(NOW + HOUR)), ['paceWarning'])
  assert.deepEqual(at(eta(NOW + 3 * HOUR)), [], 'the window resets before it runs out')
  assert.deepEqual(at(eta(NOW - MIN)), [], 'an ETA in the past')
  // The forecast's own gate: `state` is `eta` only past its confidence gate.
  for (const state of ['measuring', 'idle', 'stale', 'none', 'resetsFirst', 'full'] as const) {
    assert.deepEqual(at(eta(NOW + HOUR, { state })), [], state)
  }
  assert.deepEqual(at(eta(NOW + HOUR), win({ percent: 100 })), ['quotaExhausted'], 'exhausted says it instead')
  const st = emptyNotifyState()
  const f = new Map([[key, eta(NOW + HOUR)]])
  assert.deepEqual(evaluate([reading([win({ percent: 50 })])], st, NOW, c, f).map(kinds), [['paceWarning']])
  assert.deepEqual(evaluate([reading([win({ percent: 55 })], { fetchedAt: Math.floor((NOW + 20 * MIN) / 1000) })], st, NOW + 21 * MIN, c,
    new Map([[key, eta(NOW + 50 * MIN)]])), [])
})

test('an event not in tokenPace.notifications.events is never built — and with no channel listed nothing is built at all (1.12 C2 rule 8, C9 rule 3)', () => {
  const states = [reading([win({ percent: 100 }), weekly({ percent: 90 })])]
  const only = cfg({ 'tokenPace.notifications.events': ['quotaExhausted'] })
  assert.deepEqual(kinds(quotaEvents(states, new Map(), only, emptyNotifyState(), NOW, STALE_MS)), ['quotaExhausted'])
  const agentsOnly = cfg({ 'tokenPace.notifications.events': ['agentDone'] })
  const st = emptyNotifyState()
  assert.deepEqual(quotaEvents(states, new Map(), agentsOnly, st, NOW, STALE_MS), [])
  assert.deepEqual(st.cycles, {}, 'no quota event listed: not even the cycles are kept')
  // The agent tables are not touched for a kind nobody listed.
  const tables = newNotifyTables()
  collectEvents(input({ mains: [main({ lastRequest: OPEN })], hooks: [hook()] }), cfg({ 'tokenPace.notifications.events': ['quotaReset'] }), emptyNotifyState(), tables, NOW)
  assert.equal(tables.turns.size + tables.waits.size, 0)
  // No channel: nothing, and a follower window: nothing.
  assert.deepEqual(collectEvents(input({ states }), cfg({ 'tokenPace.notifications.channels': [] }), emptyNotifyState(), newNotifyTables(), NOW), [])
  assert.deepEqual(collectEvents(input({ states, role: 'follower' }), cfg(), emptyNotifyState(), newNotifyTables(), NOW), [])
  assert.deepEqual(kinds(collectEvents(input({ states, role: 'single' }), cfg(), emptyNotifyState(), newNotifyTables(), NOW)), ['quotaExhausted', 'quotaThreshold'])
})

// ---------------------------------------------------------------------------
// C2 · the agent events (§0a.5, §0a.6)
// ---------------------------------------------------------------------------

test('agentWaiting: a permission or input wait still standing after 60 s, not after 30 s, not while focused, not without a hook entry, not once answered, once per episode (1.12 C2 rule 1)', () => {
  const seen = new Map<string, number>()
  const mains = [main({ lastTs: NOW - 5 * MIN, lastRequest: OPEN })]
  assert.deepEqual(waitEvents([hook({ ts: NOW - 30 * SEC })], mains, seen, NOW, false), [], 'after 30 s')
  assert.deepEqual(waitEvents([], mains, seen, NOW, false), [], 'no hook entry')
  // Focused: nothing, and the episode is not used up — told once the window loses the focus.
  assert.deepEqual(waitEvents([hook()], mains, seen, NOW, true), [])
  const events = waitEvents([hook()], mains, seen, NOW + SEC, false)
  assert.deepEqual(events.map((e) => [e.event, e.program, e.wait, e.since]), [['agentWaiting', 'claudeCode', 'permission', NOW - 61 * SEC]])
  assert.equal(events[0].identity, `agentWaiting:permission:${NOW - 61 * SEC}`)
  // Review 2 F2 (pinned and changed): building an event no longer marks the episode — it is told once `admit` sent
  // its identity (`markToldWaits`), and only then does the same episode stay quiet.
  assert.equal(waitEvents([hook()], mains, seen, NOW + 2 * SEC, false).length, 1, 'not marked before its admission')
  const told = emptyNotifyState()
  admit(events, cfg(), told, NOW + SEC)
  markToldWaits([hook()], told, seen)
  assert.deepEqual(waitEvents([hook()], mains, seen, NOW + 2 * MIN, false), [], 'the same episode')
  // A new wait is a new episode.
  assert.equal(waitEvents([hook({ ts: NOW + MIN })], mains, seen, NOW + MIN + AGENT_WAIT_AFTER_MS, false).length, 1)
  // Answered: the session's newest reply came after the wait.
  assert.deepEqual(waitEvents([hook()], [main({ lastTs: NOW - 10 * SEC, lastRequest: OPEN })], new Map(), NOW, false), [])
  // Unknown to the aggregator: the hook's word stands (an unknown reply time is no answer).
  assert.equal(waitEvents([hook()], [], new Map(), NOW, false).length, 1)
  // An agent's own wait is answered in the agent's transcript, which is not here: not the session's.
  assert.deepEqual(waitEvents([hook({ agentId: 'a1234567890abcdef' })], mains, new Map(), NOW, false), [])
  // A stop or a start clears a wait; an entry older than the hook's own limit is gone.
  assert.deepEqual(waitEvents([hook({ wait: 'none', event: 'Notification' })], mains, new Map(), NOW, false), [])
  assert.deepEqual(waitEvents([hook({ ts: NOW - 31 * MIN })], mains, new Map(), NOW, false), [])
})

test('agentWaiting for input: a question in an open turn is one, the idle prompt of a finished turn is not — that end is agentDone\'s (1.12 C2 rule 1)', () => {
  const input1 = hook({ event: 'Notification', wait: 'input' })
  assert.deepEqual(waitEvents([input1], [main({ lastTs: NOW - 5 * MIN, lastRequest: OPEN })], new Map(), NOW, false).map((e) => e.wait), ['input'])
  assert.deepEqual(waitEvents([input1], [main({ lastTs: NOW - 5 * MIN })], new Map(), NOW, false), [])
})

test('agentDone: a turn this window saw open for at least two minutes and now sees closed; not while the transcripts are read, not for a turn first seen closed, not while focused (1.12 C2 rule 2)', () => {
  const seen = new Map()
  const open = main({ lastRequest: OPEN, lastTs: NOW - MIN })
  // Still reading: nothing is observed either.
  assert.deepEqual(turnEvents([open], seen, NOW, { settled: false, focused: false }), [])
  assert.equal(seen.size, 0)
  assert.deepEqual(turnEvents([open], seen, NOW, { settled: true, focused: false }), [])
  const closedAt = NOW + 3 * MIN
  const done = turnEvents([main({ lastTs: closedAt })], seen, NOW + 3 * MIN + 5 * SEC, { settled: true, focused: false })
  assert.deepEqual(done.map((e) => [e.event, e.program, e.at, e.atLeastMs]), [['agentDone', 'claudeCode', closedAt, 3 * MIN]])
  assert.equal(done[0].identity, `agentDone:${closedAt}`)
  // The same close again: nothing.
  assert.deepEqual(turnEvents([main({ lastTs: closedAt })], seen, NOW + 5 * MIN, { settled: true, focused: false }), [])
  // Open for a minute only.
  const short = new Map()
  turnEvents([open], short, NOW, { settled: true, focused: false })
  assert.deepEqual(turnEvents([main({ lastTs: NOW + MIN })], short, NOW + MIN + SEC, { settled: true, focused: false }), [])
  assert.ok(AGENT_DONE_MIN_MS === 2 * MIN)
  // First seen closed (after activation, or after the scan): history, not news.
  assert.deepEqual(turnEvents([main({ lastTs: NOW })], new Map(), NOW, { settled: true, focused: false }), [])
  // Focused: the close is taken as seen.
  const focused = new Map()
  turnEvents([open], focused, NOW, { settled: true, focused: true })
  assert.deepEqual(turnEvents([main({ lastTs: NOW + 5 * MIN })], focused, NOW + 5 * MIN, { settled: true, focused: true }), [])
  assert.deepEqual(turnEvents([main({ lastTs: NOW + 5 * MIN })], focused, NOW + 6 * MIN, { settled: true, focused: false }), [])
  // The table is bounded to the sessions the aggregator holds.
  turnEvents([], focused, NOW + 7 * MIN, { settled: true, focused: false })
  assert.equal(focused.size, 0)
})

test('agentDone counts from the newest prompt: an interrupted turn and a short reply three hours later are no long turn; an ordinary long turn with tool activity still is (1.12 C2 rule 2, Review 2 F4)', () => {
  const at = (h: number, m: number, sec = 0): number => Date.UTC(2026, 8, 27, h, m, sec)
  const gate = { settled: true, focused: false }
  const req = (atMs: number, over: Partial<LastRequest> = {}): LastRequest => lastRequest({ at: atMs, ...over })
  const toolOpen = (atMs: number): LastRequest => req(atMs, { stop: 'tool_use', replyPending: true })

  // Seen open at 12:00 — a tool's result is the newest line.
  const seen = new Map()
  assert.deepEqual(turnEvents([main({ lastTs: at(11, 59), lastRequest: toolOpen(at(11, 59)) })], seen, at(12, 0), gate), [])
  // 12:05 — the next reply is cut off by an interruption: it states no stop, the user's line is the newest.
  const cut = req(at(12, 4), { stop: null, replyPending: true })
  assert.deepEqual(turnEvents([main({ lastTs: at(12, 5), lastRequest: cut })], seen, at(12, 6), gate), [])
  // Three hours later the reader is back, writes a prompt, and a short reply closes the turn at 15:02 (window
  // unfocused): the closing request answers a new prompt — its span is the reply alone, below two minutes.
  const reply = req(at(15, 1, 30), { stop: 'end_turn', replyPending: false })
  assert.deepEqual(turnEvents([main({ lastTs: at(15, 2), lastRequest: reply })], seen, at(15, 2, 5), gate), [], 'no "after at least 3 h"')

  // The same, but the new prompt's turn runs a while: counted from its first request, not from 12:00.
  const again = new Map()
  turnEvents([main({ lastTs: at(11, 59), lastRequest: toolOpen(at(11, 59)) })], again, at(12, 0), gate)
  turnEvents([main({ lastTs: at(12, 5), lastRequest: cut })], again, at(12, 6), gate)
  turnEvents([main({ lastTs: at(15, 0, 20), lastRequest: toolOpen(at(15, 0, 10)) })], again, at(15, 1), gate)
  turnEvents([main({ lastTs: at(15, 5), lastRequest: toolOpen(at(15, 4, 50)) })], again, at(15, 5), gate)
  const back = turnEvents([main({ lastTs: at(15, 10), lastRequest: req(at(15, 9, 40)) })], again, at(15, 10, 5), gate)
  assert.deepEqual(back.map((e) => e.atLeastMs), [at(15, 10) - at(15, 0, 10)])

  // An ordinary long turn: open at 12:00, tool activity, closed at 12:40 — at least 40 min.
  const long = new Map()
  turnEvents([main({ lastTs: at(11, 59), lastRequest: toolOpen(at(11, 59)) })], long, at(12, 0), gate)
  turnEvents([main({ lastTs: at(12, 20), lastRequest: toolOpen(at(12, 19)) })], long, at(12, 20), gate)
  turnEvents([main({ lastTs: at(12, 30), lastRequest: toolOpen(at(12, 29, 30)) })], long, at(12, 30), gate)
  const done = turnEvents([main({ lastTs: at(12, 40), lastRequest: req(at(12, 39, 30)) })], long, at(12, 40, 5), gate)
  assert.equal(done.length, 1)
  assert.ok((done[0].atLeastMs as number) >= 40 * MIN, `${done[0].atLeastMs}`)
})

// ---------------------------------------------------------------------------
// C4 · no storm — C14 item 2
// ---------------------------------------------------------------------------

test('the cooldown drops a second event of a kind — not marked sent, so it speaks once the cooldown is over (1.12 C4 rule 2)', () => {
  const c = cfg()
  const st = emptyNotifyState()
  assert.deepEqual(evaluate([reading([win({ percent: 85 })])], st, NOW, c).map(kinds), [['quotaThreshold']])
  const codex = reading([win({ id: 'codex:300', percent: 90 })], { source: 'codex', fetchedAt: Math.floor((NOW + 4 * MIN) / 1000) })
  const events = quotaEvents([codex], new Map(), c, st, NOW + 5 * MIN, STALE_MS)
  const second = admit(events, c, st, NOW + 5 * MIN)
  assert.deepEqual(second.send, [])
  assert.deepEqual(second.dropped, [{ event: 'quotaThreshold', why: 'cooldown' }])
  assert.deepEqual(droppedLines(second.dropped), ['Notify: quotaThreshold dropped (cooldown)'])
  assert.equal(st.sent[events[0].identity], undefined, 'a dropped event is not marked sent')
  // After the cooldown, while it still holds.
  const later = reading([win({ id: 'codex:300', percent: 91 })], { source: 'codex', fetchedAt: Math.floor((NOW + 10 * MIN) / 1000) })
  assert.deepEqual(evaluate([later], st, NOW + 11 * MIN, c).map(kinds), [['quotaThreshold']])
  // Another kind has its own cooldown.
  const exhausted = reading([win({ id: 'codex:10080', kind: 'weekly', label: '7 d', percent: 100, resetsAt: NOW + 2 * 24 * HOUR })],
    { source: 'codex', fetchedAt: Math.floor((NOW + 11 * MIN) / 1000) })
  assert.deepEqual(evaluate([exhausted], st, NOW + 12 * MIN, c).map(kinds), [['quotaExhausted']])
})

test('an agentWaiting the cooldown dropped speaks after it while the wait still stands, and not once it is answered — Review 2\'s case (1.12 C4 rule 2, Review 2 F2)', async () => {
  const at = (h: number, m: number): number => Date.UTC(2026, 8, 27, h, m)
  const A = 'a1b2c3d4-synthetic'
  const B = 'b2c3d4e5-synthetic'
  const memento = new FakeMemento()
  const tables = newNotifyTables()
  const sent: string[][] = []
  const deps = { memento, words: WORDS, send: async (_p: NotificationPayload, events: readonly NotificationEvent[]) => { sent.push(events.map((e) => e.identity)) } }
  // The window unfocused (CLI in an outside terminal), the cooldown the default ten minutes.
  const c = cfg({ 'tokenPace.notifications.events': ['agentWaiting'] })
  assert.equal(c.cooldownMinutes, 10)
  const hookA = hook({ sessionId: A, ts: at(11, 59) })
  const hookB = hook({ sessionId: B, ts: at(12, 2) })
  const mainA = main({ sessionId: A, lastTs: at(11, 50), lastRequest: OPEN })
  const mainB = main({ sessionId: B, lastTs: at(11, 50), lastRequest: OPEN })
  const round = (now: number, mains: MainRec[], hooks: HookEntry[]) => notifyRound(input({ mains, hooks }), c, tables, deps, now)

  // 12:00 — A has waited a minute: sent.
  assert.deepEqual((await round(at(12, 0), [mainA, mainB], [hookA])).send.map((g) => g.map((e) => e.identity)), [[`agentWaiting:permission:${at(11, 59)}`]])
  // 12:03 — B has waited a minute, three minutes after A's message: dropped by the cooldown, not marked sent.
  const early = await round(at(12, 3), [mainA, mainB], [hookA, hookB])
  assert.deepEqual(early.send, [])
  assert.deepEqual(early.dropped, [{ event: 'agentWaiting', why: 'cooldown' }])
  assert.equal(loadNotifyState(memento).sent[`agentWaiting:permission:${at(12, 2)}`], undefined)
  // 12:07 — still inside the cooldown: dropped again, still standing.
  assert.deepEqual((await round(at(12, 7), [mainA, mainB], [hookA, hookB])).dropped, [{ event: 'agentWaiting', why: 'cooldown' }])
  // 12:11 — the cooldown is over and B still waits: B speaks now; A, already told, does not again.
  assert.deepEqual((await round(at(12, 11), [mainA, mainB], [hookA, hookB])).send.map((g) => g.map((e) => e.identity)), [[`agentWaiting:permission:${at(12, 2)}`]])
  // 12:25 — both told: nothing more while they stand.
  assert.deepEqual((await round(at(12, 25), [mainA, mainB], [hookA, hookB])).send, [])
  // 12:31 — B was answered at 12:30 (its newest reply after the wait), A's entry is past the hook's own age: nothing.
  const answered = main({ sessionId: B, lastTs: at(12, 30), lastRequest: OPEN })
  assert.deepEqual((await round(at(12, 31), [mainA, answered], [hookA, hookB])).send, [])
  assert.deepEqual(sent, [[`agentWaiting:permission:${at(11, 59)}`], [`agentWaiting:permission:${at(12, 2)}`]], 'two messages in all — A at 12:00, B at 12:11')
})

test('the hourly cap stops the 21st message, over all kinds and channels together, and a new hour starts again (1.12 C4 rule 3)', () => {
  const c = cfg({ 'tokenPace.notifications.cooldownMinutes': 1 })
  const st = emptyNotifyState()
  const one = (i: number): NotificationEvent => ({
    event: 'agentWaiting', identity: `agentWaiting:permission:${i}`, provider: null, program: 'claudeCode', windowLabel: null,
    windowKind: null, percent: null, resetsAt: null, etaAt: null, since: i, atLeastMs: null, wait: 'permission', at: NOW,
  })
  let sent = 0
  for (let i = 0; i < NOTIFY_HOURLY_CAP + 2; i++) sent += admit([one(i)], c, st, NOW + i * 2 * MIN).send.length
  assert.equal(sent, NOTIFY_HOURLY_CAP)
  const capped = admit([one(99)], c, st, NOW + 50 * MIN)
  assert.deepEqual(capped.dropped, [{ event: 'agentWaiting', why: 'hourlyCap' }])
  assert.equal(admit([one(99)], c, st, NOW + 61 * MIN).send.length, 1, 'a new hour')
  // Two channels: every message counts twice.
  const two = cfg({ 'tokenPace.notifications.channels': ['webhook', 'ntfy'], 'tokenPace.notifications.cooldownMinutes': 1 })
  const st2 = emptyNotifyState()
  let sent2 = 0
  for (let i = 0; i < NOTIFY_HOURLY_CAP; i++) sent2 += admit([one(i)], two, st2, NOW + i * 2 * MIN).send.length
  assert.equal(sent2, NOTIFY_HOURLY_CAP / 2)
})

test('the state is persisted before the send, a failed attempt counts and is never retried, and no channel means no state read (1.12 C4 rules 4–5, C9 rule 3)', async () => {
  const memento = new FakeMemento()
  const order: string[] = []
  const tables = newNotifyTables()
  const deps = {
    memento,
    words: WORDS,
    send: async (p: NotificationPayload): Promise<void> => {
      order.push(`send:${String(p.json.event)}`)
      throw new Error('HTTP 503')
    },
  }
  const origUpdate = memento.update.bind(memento)
  memento.update = (key: string, value: unknown) => {
    order.push(`update:${key}`)
    return origUpdate(key, value)
  }
  const states = [reading([win({ percent: 100 })])]
  const first = await notifyRound(input({ states }), cfg(), tables, deps, NOW)
  assert.deepEqual(first.send.map(kinds), [['quotaExhausted']])
  assert.deepEqual(order, [`update:${NOTIFY_STATE_KEY}`, 'send:quotaExhausted'], 'persisted before the send')
  // The send failed: the next evaluation, after the cooldown, does not try again.
  order.length = 0
  const again = await notifyRound(input({ states: [reading([win({ percent: 100 })], { fetchedAt: Math.floor((NOW + 15 * MIN) / 1000) })] }), cfg(), tables, deps, NOW + 16 * MIN)
  assert.deepEqual(again.send, [])
  assert.deepEqual(again.dropped, [{ event: 'quotaExhausted', why: 'sent' }])
  assert.deepEqual(order.filter((o) => o.startsWith('send')), [])
  // Nothing changed: nothing written.
  assert.deepEqual(order, [])
  // No channel listed: not even the state is read.
  const quiet = new FakeMemento()
  await notifyRound(input({ states }), cfg({ 'tokenPace.notifications.channels': [] }), newNotifyTables(), { ...deps, memento: quiet }, NOW)
  await notifyRound(input({ states, role: 'follower' }), cfg(), newNotifyTables(), { ...deps, memento: quiet }, NOW)
  assert.deepEqual(quiet.calls, [])
})

test('the persisted state is read back by its shape and pruned like the alerts\' — 45 days, 200 entries (1.12 §0a.11, C4 rule 1)', () => {
  const raw = {
    sent: { 'quotaThreshold:claude:session:300:1': NOW, bad: 'x', ['x'.repeat(300)]: NOW },
    lastByKind: { quotaThreshold: NOW, dailySummary: NOW },
    hour: { start: NOW, count: 3 },
    last: { webhook: { at: NOW, event: 'test', ok: false, kind: 'http', status: 401, host: 'hooks.example.org' }, sms: { at: NOW, event: 'test', ok: true } },
    cycles: { 'claude:session:300': { resetsAt: NOW, percent: 40, seenAt: NOW }, broken: { resetsAt: 'soon', percent: 1, seenAt: NOW } },
    stranger: 'synthetic-plan',
  }
  const st = cleanNotifyState(raw)
  assert.deepEqual(st, {
    sent: { 'quotaThreshold:claude:session:300:1': NOW },
    lastByKind: { quotaThreshold: NOW },
    hour: { start: NOW, count: 3 },
    last: { webhook: { at: NOW, event: 'test', ok: false, kind: 'http', status: 401 } },
    cycles: { 'claude:session:300': { resetsAt: NOW, percent: 40, seenAt: NOW } },
  })
  assert.deepEqual(cleanNotifyState('nonsense'), emptyNotifyState())
  const big = emptyNotifyState()
  for (let i = 0; i < 250; i++) big.sent[`k${i}`] = NOW - i * MIN
  big.sent.old = NOW - 46 * 24 * HOUR
  pruneNotifyState(big, NOW)
  assert.equal(Object.keys(big.sent).length, 200)
  assert.equal(big.sent.old, undefined)
  assert.equal(big.sent.k0, NOW, 'the newest are kept')
  const memento = new FakeMemento()
  memento.store.set(NOTIFY_STATE_KEY, raw)
  assert.deepEqual(loadNotifyState(memento), st)
})

// ---------------------------------------------------------------------------
// C3 · the payload (§0a.10) — C14 item 3
// ---------------------------------------------------------------------------

const JSON_KEYS = ['v', 'source', 'event', 'title', 'text', 'provider', 'program', 'window', 'windowKind', 'percent', 'resetsAt', 'eta',
  'since', 'atLeastMinutes', 'wait', 'at']

/** One event of every kind, as the builders make them. */
function everyKind(): NotificationEvent[][] {
  const st = emptyNotifyState()
  st.cycles['claude:session:300'] = { resetsAt: NOW - 5 * MIN, percent: 97, seenAt: NOW - 10 * MIN }
  const quota = quotaEvents([
    reading([win({ percent: 4, resetsAt: NOW + 5 * HOUR - 5 * MIN }), weekly({ percent: 85 }), weekly({ id: 'weekly_scoped:10080:fable', label: '7 d · Fable', percent: 100 })]),
    reading([win({ id: 'codex:300', percent: 60, resetsAt: NOW + 2 * HOUR })], { source: 'codex' }),
  ], new Map([['codex:codex:300', eta(NOW + 90 * MIN)]]), cfg(), st, NOW, STALE_MS)
  const turns = new Map()
  turnEvents([main({ lastRequest: OPEN })], turns, NOW - 14 * MIN - 30 * SEC, { settled: true, focused: false })
  const done = turnEvents([main({ lastTs: NOW - MIN })], turns, NOW, { settled: true, focused: false })
  const waits = waitEvents([hook(), hook({ sessionId: 'b2c3d4e5-synthetic', event: 'Notification', wait: 'input' })],
    [main({ lastTs: NOW - 5 * MIN, lastRequest: OPEN }), main({ sessionId: 'b2c3d4e5-synthetic', lastTs: NOW - 5 * MIN, lastRequest: OPEN })],
    new Map(), NOW, false)
  return admit([...quota, ...done, ...waits], cfg(), emptyNotifyState(), NOW).send
}

test('every kind\'s payload: one title, the events\' sentences, the generic JSON exactly the allow-list — absent figures null, never 0, the percent as the bar writes it, the ETA with ~ (1.12 C3, C1 rule 1)', () => {
  const groups = everyKind()
  assert.deepEqual(groups.map((g) => g[0].event), ['agentWaiting', 'agentDone', 'quotaThreshold', 'quotaExhausted', 'quotaReset', 'paceWarning'])
  const byKind = new Map(groups.map((g) => [g[0].event, payloadOf(g, WORDS)]))
  const text = (k: string): string => (byKind.get(k as NotificationEvent['event']) as NotificationPayload).text
  const title = (k: string): string => (byKind.get(k as NotificationEvent['event']) as NotificationPayload).title
  assert.equal(title('agentWaiting'), 'Token Pace: Claude Code is waiting for you')
  assert.equal(text('agentWaiting'), 'Claude Code is waiting for your permission (since 11:58).\nClaude Code is waiting for your answer (since 11:58).')
  assert.equal(title('agentDone'), 'Token Pace: a long turn finished')
  assert.equal(text('agentDone'), 'Claude Code finished a turn at 11:59, after at least 13 min 30 s.')
  assert.equal(title('quotaThreshold'), 'Token Pace: quota threshold reached')
  assert.equal(text('quotaThreshold'), 'Claude, 7 d window: 85% used — resets at We 12:00.')
  assert.equal(title('quotaExhausted'), 'Token Pace: quota exhausted')
  assert.equal(text('quotaExhausted'), 'Claude, 7 d · Fable window: exhausted — resets at We 12:00.')
  assert.equal(title('quotaReset'), 'Token Pace: quota window reset')
  assert.equal(text('quotaReset'), 'Claude, 5 h window: reset at 11:55 — 4% used in the new window.')
  assert.equal(title('paceWarning'), 'Token Pace: quota runs out before its reset')
  assert.equal(text('paceWarning'), 'Codex, 5 h window: 60% used, runs out at ~13:30 — before it resets at 14:00.')
  for (const [kind, p] of byKind) {
    assert.deepEqual(Object.keys(p.json).filter((k) => k !== 'items'), JSON_KEYS, kind)
    assert.equal(p.json.v, 1)
    assert.equal(p.json.source, 'token-pace')
    assert.equal(p.json.title, p.title)
    assert.equal(p.json.text, p.text)
    for (const k of JSON_KEYS) assert.notEqual(p.json[k], 0, `${kind}: ${k} is 0`)
  }
  const pace = (byKind.get('paceWarning') as NotificationPayload).json
  assert.deepEqual(pace, {
    v: 1, source: 'token-pace', event: 'paceWarning', title: 'Token Pace: quota runs out before its reset',
    text: 'Codex, 5 h window: 60% used, runs out at ~13:30 — before it resets at 14:00.', provider: 'codex', program: null,
    window: '5 h', windowKind: 'session', percent: 60, resetsAt: '2026-09-27T14:00:00.000Z', eta: '2026-09-27T13:30:00.000Z',
    since: null, atLeastMinutes: null, wait: null, at: '2026-09-27T11:59:00.000Z',
  })
  const done = (byKind.get('agentDone') as NotificationPayload).json
  assert.deepEqual([done.program, done.provider, done.window, done.percent, done.atLeastMinutes, done.at], ['claudeCode', null, null, null, 13, '2026-09-27T11:59:00.000Z'])
  // Several events of a kind: `items` with the same fields per event.
  const waiting = (byKind.get('agentWaiting') as NotificationPayload).json
  assert.deepEqual((waiting.items as Array<Record<string, unknown>>).map((i) => [Object.keys(i).length, i.wait]), [[12, 'permission'], [12, 'input']])
  // A reset that is not known: the key without the slot, never a dash in the sentence.
  const noReset = quotaEvents([reading([win({ percent: 90, resetsAt: null }), win({ id: 's2', percent: 100, resetsAt: null })])], new Map(), cfg(), emptyNotifyState(), NOW, STALE_MS)
  assert.deepEqual(noReset.map((e) => payloadOf([e], WORDS).text), ['Claude, 5 h window: 90% used.', 'Claude, 5 h window: exhausted.'])
  assert.equal(payloadOf([noReset[0]], WORDS).json.resetsAt, null)
  assert.throws(() => payloadOf([], WORDS))
})

// 1.13 P6 (pinned and changed: the reset-clock slots' „Reset um Mi 12:00", „leer um ~13:30 — vor dem Reset um 14:00" → the
// label form „Reset: Mi 12:00", „leer: ~13:30 — vor dem Reset (14:00)" — §3 B5, §7a Q18; the reset that happened keeps
// its „Reset um 11:55", a clock of today, not a slot of RESET_CLOCK_KEYS).
test('the texts in German: whole keys of the host part, the page\'s clock and percent (1.12 C3 rule 3, C13, §6; 1.13 B5)', () => {
  withGerman(() => {
    const byKind = new Map(everyKind().map((g) => [g[0].event, payloadOf(g, WORDS)]))
    const lines = [...byKind.values()].map((p) => `${p.title} | ${p.text}`)
    assert.deepEqual(lines, [
      'Token Pace: Claude Code wartet auf Sie | Claude Code wartet auf Ihre Erlaubnis (seit 11:58).\nClaude Code wartet auf Ihre Antwort (seit 11:58).',
      'Token Pace: ein langer Turn ist beendet | Claude Code hat um 11:59 einen Turn beendet, nach mindestens 13 min 30 s.',
      'Token Pace: Kontingent-Schwelle erreicht | Claude, Fenster 7 d: 85% verbraucht — Reset: Mi 12:00.',
      'Token Pace: Kontingent erschöpft | Claude, Fenster 7 d · Fable: erschöpft — Reset: Mi 12:00.',
      'Token Pace: Kontingentfenster zurückgesetzt | Claude, Fenster 5 h: Reset um 11:55 — im neuen Fenster 4% verbraucht.',
      'Token Pace: Kontingent reicht nicht bis zum Reset | Codex, Fenster 5 h: 60% verbraucht, leer: ~13:30 — vor dem Reset (14:00).',
    ])
    // The JSON stays English data.
    assert.equal(byKind.get('paceWarning')?.json.windowKind, 'session')
    const test1 = testPayload(WORDS)
    assert.deepEqual([test1.title, test1.text], ['Token Pace: Testnachricht', 'Dieser Kanal funktioniert: Token Pace erreicht ihn. Gesendet um 12:00.'])
  })
})

test('1.13 A3 rule 7 (§7a Q11): in Arabic, Hebrew and Persian (the pseudo-RTL bundle) the title and each line of the text of every kind\'s message and of the test message begin with RLM, and the JSON\'s title and text with them — no other field, no isolate, the twelve fields as they were; in English and German none; the e-mail\'s Subject carries the mark in its encoded word', () => {
  const bidi = require('../src/bidi') as typeof import('../src/bidi')
  const i18n = require('../src/i18n') as typeof import('../src/i18n')
  const { pseudoRtlBundle } = require('./helpers/nls') as typeof import('./helpers/nls')
  const { messageOf } = require('../src/notifySmtp') as typeof import('../src/notifySmtp')
  const english = everyKind().map((g) => payloadOf(g, WORDS))
  const pseudo = pseudoRtlBundle()
  for (const id of ['ar', 'he', 'fa']) {
    try {
      i18n.setBundle(pseudo)
      i18n.setLang(id)
      i18n.setLocale(`${id}-u-ca-gregory-nu-latn`)
      i18n.setDir('rtl')
      const payloads = [...everyKind().map((g) => payloadOf(g, WORDS)), testPayload(WORDS)]
      assert.equal(payloads.length, 7)
      payloads.forEach((p, n) => {
        for (const text of [p.title, p.text]) {
          for (const line of text.split('\n')) {
            assert.equal(line.codePointAt(0), 0x200f, `${id}: ${JSON.stringify(line)}`)
            assert.equal(bidi.stripBidi(line.slice(1)), line.slice(1), `${id}: a second mark in ${JSON.stringify(line)}`)
          }
        }
        assert.equal(p.json.title, p.title)
        assert.equal(p.json.text, p.text)
        assert.deepEqual(Object.keys(p.json).filter((k) => k !== 'items'), JSON_KEYS)
        for (const [k, v] of Object.entries(p.json)) {
          if (k === 'title' || k === 'text') continue
          assert.equal(JSON.stringify(v).search(bidi.BIDI_CONTROLS), -1, `${id}: ${k}`)
        }
        // The twelve fields are the English payload's (the JSON is English data).
        if (n < english.length) {
          const strip = (j: Record<string, unknown>): string => JSON.stringify(Object.fromEntries(Object.entries(j).filter(([k]) => k !== 'title' && k !== 'text')))
          assert.equal(strip(p.json), strip(english[n].json))
        }
      })
      // The e-mail: the Subject an encoded word whose text is the title, mark and all (RFC 2047 carries it).
      const mail = messageOf('a@example.invalid', 'b@example.invalid', payloads[0], NOW, '<x@example.invalid>')
      const subject = /^Subject: (.*(?:\r\n .*)*)$/m.exec(mail)?.[1] ?? ''
      const decoded = subject.split('\r\n ').map((w) => Buffer.from(/^=\?UTF-8\?B\?(.*)\?=$/.exec(w)?.[1] ?? '', 'base64').toString('utf8')).join('')
      assert.equal(decoded, payloads[0].title)
      assert.equal(decoded.codePointAt(0), 0x200f)
    } finally {
      i18n.setBundle(undefined)
      i18n.setLang(undefined)
      i18n.setLocale(undefined)
      i18n.setDir(undefined)
    }
  }
  // English and German: no mark anywhere.
  for (const p of [...english, testPayload(WORDS)]) assert.equal(JSON.stringify(p).search(bidi.BIDI_CONTROLS), -1)
  withGerman(() => {
    for (const p of [...everyKind().map((g) => payloadOf(g, WORDS)), testPayload(WORDS)]) assert.equal(JSON.stringify(p).search(bidi.BIDI_CONTROLS), -1)
  })
})

test('the test message: its title, the time it was sent, the generic JSON with event test and every figure null (1.12 C13, C4 rule 7)', () => {
  const p = testPayload(WORDS)
  assert.equal(p.title, 'Token Pace: test message')
  assert.equal(p.text, 'This channel works: Token Pace can reach it. Sent at 12:00.')
  assert.deepEqual(Object.keys(p.json), JSON_KEYS)
  assert.equal(p.json.event, 'test')
  assert.equal(p.json.at, '2026-09-27T12:00:00.000Z')
  for (const k of ['provider', 'program', 'window', 'windowKind', 'percent', 'resetsAt', 'eta', 'since', 'atLeastMinutes', 'wait']) assert.equal(p.json[k], null, k)
})

test('§0a.10 leak test: a world with a project, a session, a prompt title and a plan — none of them in any payload of any kind, its texts or its JSON, nor in the dropped lines (1.12 §0a.10, C14 item 3)', () => {
  const secrets = ['synthetic-project-123', SESSION, 'Synthetic Prompt Title', 'synthetic-plan', '9d0eb37a']
  // The session's record is keyed by a path in the aggregator (mainEntries); the notifier is handed the records alone.
  const entries: Array<[string, MainRec]> = [
    [`/home/u/synthetic-project-123/${SESSION}.jsonl`, main({ lastRequest: OPEN, lastTs: NOW - 20 * MIN })],
  ]
  const tables = newNotifyTables()
  const st = emptyNotifyState()
  st.cycles['claude:session:300'] = { resetsAt: NOW - 5 * MIN, percent: 97, seenAt: NOW - 10 * MIN }
  // The first round sees the turn open and the wait standing; the second the turn closed and the readings.
  const world = (now: number, mains: MainRec[]): NotifyInput => input({
    states: now < NOW ? [] : [
      reading([win({ percent: 4, resetsAt: NOW + 5 * HOUR - 5 * MIN }), weekly({ percent: 100 }), weekly({ id: 'weekly_scoped:10080:fable', label: '7 d · Fable', percent: 90 })],
        { planType: 'synthetic-plan', problem: 'Synthetic Prompt Title', drift: ['synthetic-project-123'] }),
      reading([win({ id: 'codex:300', percent: 60 })], { source: 'codex', planType: 'synthetic-plan' }),
    ],
    forecasts: new Map([['codex:codex:300', eta(NOW + 90 * MIN)]]),
    mains,
    hooks: [hook({ ts: NOW - 19 * MIN })],
  })
  const groups: NotificationEvent[][] = []
  const dropped: string[] = []
  for (const [now, mains] of [[NOW - 16 * MIN, entries.map(([, r]) => r)], [NOW, [main({ lastTs: NOW - MIN })]]] as Array<[number, MainRec[]]>) {
    const a = admit(collectEvents(world(now, mains), cfg(), st, tables, now), cfg({ 'tokenPace.notifications.cooldownMinutes': 1 }), st, now)
    groups.push(...a.send)
    dropped.push(...droppedLines(a.dropped))
  }
  assert.deepEqual(groups.map((g) => g[0].event).sort(), [...ALL_EVENTS].sort(), 'every kind fired')
  const payloads = groups.map((g) => payloadOf(g, WORDS))
  const outputs: Array<[string, string]> = [
    ['payloads', JSON.stringify(payloads)],
    ['texts', payloads.map((p) => `${p.title}\n${p.text}`).join('\n')],
    ['dropped lines', dropped.join('\n')],
    ['the persisted state', JSON.stringify(st)],
    ['the test message', JSON.stringify(testPayload(WORDS))],
  ]
  for (const [what, text] of outputs) {
    for (const secret of secrets) assert.equal(text.includes(secret), false, `the ${what} hold ${secret}`)
  }
  // And no key beyond the allow-list reaches a payload.
  for (const p of payloads) {
    assert.deepEqual(Object.keys(p.json).filter((k) => k !== 'items'), JSON_KEYS)
    for (const item of (p.json.items ?? []) as Array<Record<string, unknown>>) assert.deepEqual(Object.keys(item), JSON_KEYS.filter((k) => !['v', 'source', 'title', 'text'].includes(k)))
  }
})

test('§0a.5 and §0a.6 leak tests: agentDone and agentWaiting fire for the synthetic session in its synthetic project, and neither string reaches a payload, a text, the state or a dropped line (1.12 §0a.5, §0a.6)', async () => {
  const file = `/home/u/synthetic-project-123/${SESSION}.jsonl`
  const entries: Array<[string, MainRec]> = [[file, main({ lastRequest: OPEN, lastTs: NOW - 10 * MIN })]]
  const memento = new FakeMemento()
  const sent: NotificationPayload[] = []
  const tables = newNotifyTables()
  const deps = { memento, words: WORDS, send: async (p: NotificationPayload) => { sent.push(p) } }
  const c = cfg({ 'tokenPace.notifications.events': ['agentWaiting', 'agentDone'] })
  const rounds: Array<[number, NotifyInput]> = [
    [NOW - 5 * MIN, input({ mains: entries.map(([, r]) => r), hooks: [hook({ ts: NOW - 7 * MIN })] })],
    [NOW, input({ mains: [main({ lastTs: NOW - MIN })], hooks: [hook({ ts: NOW - 7 * MIN })] })],
  ]
  const dropped: string[] = []
  for (const [now, inp] of rounds) dropped.push(...droppedLines((await notifyRound(inp, c, tables, deps, now)).dropped))
  assert.deepEqual(sent.map((p) => p.json.event), ['agentWaiting', 'agentDone'])
  const outputs = [JSON.stringify(sent), sent.map((p) => `${p.title} ${p.text}`).join(' '), JSON.stringify([...memento.store.values()]), dropped.join('\n')]
  for (const text of outputs) {
    for (const secret of [SESSION, 'synthetic-project-123', file, '9d0eb37a']) assert.equal(text.includes(secret), false, `${secret} in ${text.slice(0, 200)}`)
  }
})
