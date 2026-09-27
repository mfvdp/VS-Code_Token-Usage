// SPDX-FileCopyrightText: 2026 Frederik Marx
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * 1.12 C (§2.3, §3 C2–C4, §0a.5–§0a.7, §0a.10): the notifications' core — which of the six events happened,
 * which of them may go out, and what a message holds.
 *
 * Pure: no vscode import, no network, no clock of its own (every function takes `now`) and no secret. The
 * channels (notifyChannels.ts, notifySmtp.ts) send what `payloadOf` builds; the host (notifyHost.ts) hands the
 * readings, the main sessions and the agent hook's waits in, gives `notifyRound` its memento and its sender,
 * and is the one place that knows a channel's address.
 *
 * The rules, each with the reason it exists:
 *
 *  • An event not listed in `tokenPace.notifications.events` is never built (C2 rule 8), and with no channel
 *    listed nothing is built, read or kept at all (C9 rule 3).
 *  • Every event has an identity, and an identity is sent once (C4 rule 1). A quota window's identity is the
 *    alerts' — the window and its reset time (`identityOf`) —, with the reset time held steady across Claude
 *    Code's sub-second jitter (`RESET_JITTER_MS`), so a new cycle is a new subject and a jittering reset is not.
 *  • One message per event kind and evaluation (C3 rule 1): several windows past their threshold are one
 *    message listing each; an exhausted window says only that (C2 rule 3).
 *  • A cooldown per kind drops — never queues — what comes too soon, and leaves it unsent, so it may speak
 *    once the cooldown is over if it still holds (C4 rule 2); an hourly cap bounds everything (C4 rule 3).
 *  • The state is persisted before anything is sent, and a failed attempt counts as sent (C4 rules 4 and 5):
 *    a window closed during a send does not send again, and a dead host gets no retry storm.
 *  • Nothing from a stale reading (the alerts' `freshReading`), nothing about a window whose reset has passed
 *    (the reading describes a window that is over), nothing while the transcripts are still being read.
 *  • A payload is built from the event's allow-list alone (§0a.10): never a prompt, a transcript line, a path,
 *    a project, a session's id or name, an agent, a plan, an account, a token count or a cost.
 */

import { PROVIDER_NAME, SOURCE_TITLE } from './adapters'
import { freshReading, identityOf } from './alerts'
import { HOOK_MAX_AGE_MS, HookEntry } from './agentTree'
import { spanText } from './agentTreeBuild'
import { ChannelKind, NOTIFY_CHANNELS, NOTIFY_EVENTS, NotifyConfig, NotifyEventKind } from './config'
import { t } from './i18n'
import { turnClosed } from './keepWarm'
import { estimate, percentText } from './render'
import { heldReset, RESET_JITTER_MS } from './resetRule'
import type { MementoLike } from './storage'
import { formatTime, resetClock, TimeConfig } from './time'
import { Forecast, MainRec, QuotaState, Source, StopReason } from './types'

export { NOTIFY_CHANNELS, NOTIFY_EVENTS, WEBHOOK_FORMATS } from './config'
export type { ChannelKind, NotifyConfig, NotifyEventKind, WebhookFormat } from './config'

/** C2 rule 1: a wait must still stand this long after it began. */
export const AGENT_WAIT_AFTER_MS = 60_000
/** C2 rule 2: a turn this window saw open at least this long. */
export const AGENT_DONE_MIN_MS = 120_000
/** C2 rule 5: a reset older than this at first sight is not news (VS Code was closed). */
export const QUOTA_RESET_RECENT_MS = 30 * 60_000
/** C4 rule 3: messages per hour, all events and channels together. */
export const NOTIFY_HOURLY_CAP = 20
/** C1 rule 6: one send (the channels' own limit). */
export const NOTIFY_TIMEOUT_MS = 15_000
/** §0a.11: the memento key of the notifier's state — per profile, never synced. */
export const NOTIFY_STATE_KEY = 'tokenPace.notify'

const HOUR_MS = 3_600_000
/** C4 rule 1: pruned like the alerts' entries — 45 days, 200 entries. */
const STATE_TTL_MS = 45 * 24 * HOUR_MS
const STATE_MAX_ENTRIES = 200
/** How often an unchanged cycle is written again, so that its `seenAt` keeps the prune from taking it. */
const CYCLE_REFRESH_MS = HOUR_MS

const QUOTA_EVENTS: readonly NotifyEventKind[] = ['quotaThreshold', 'quotaExhausted', 'quotaReset', 'paceWarning']

/**
 * The allow-list of §0a.10 — nothing else ever reaches a payload. `identity` is for the rate limit only and is
 * never sent: `payloadOf` does not read it (the read contract holds that). The agent events carry no session:
 * the session id is a key of the observation tables in memory and nothing else.
 */
export interface NotificationEvent {
  event: NotifyEventKind
  /** For the once-rule only; never sent (e.g. `quotaThreshold:claude:session:300:<resetsAt>`). */
  identity: string
  /** The quota events' provider. */
  provider: Source | null
  /** The agent events' program — Claude Code's alone (the hook and the turn end are Claude Code's). */
  program: 'claudeCode' | null
  /** The window's label as the page shows it ("5 h", "7 d · Fable") and its kind. */
  windowLabel: string | null
  windowKind: 'session' | 'weekly' | 'other' | null
  /** Whole percent as the bar rounds it. */
  percent: number | null
  /** The window's next reset (ms). */
  resetsAt: number | null
  /** `paceWarning`: when the forecast expects the window to run out (ms) — an estimate. */
  etaAt: number | null
  /** `agentWaiting`: when the wait began; `quotaReset`: when the old window reset. */
  since: number | null
  /** `agentDone`: the turn's observed span — a lower bound. */
  atLeastMs: number | null
  wait: 'permission' | 'input' | null
  /** When the fact was seen: the reading's fetch, the closing reply, the evaluation. */
  at: number
}

/** A JSON value of the generic payload: English data (ids, ISO times, numbers) and the two texts. */
export type NotifyJsonValue = string | number | null | Array<Record<string, string | number | null>>

export interface NotificationPayload {
  title: string
  text: string
  /** C1 rule 1's generic JSON — the same facts with English keys. */
  json: Record<string, NotifyJsonValue>
}

/** What the texts are formatted with: the configured zone and hour cycle, and the moment of the evaluation. */
export interface NotifyWords {
  tcfg: TimeConfig
  now: number
}

// ---------------------------------------------------------------------------
// The persisted state (§0a.11 `tokenPace.notify`)
// ---------------------------------------------------------------------------

/** C2 rule 5: the last cycle the notifier saw of one `source:windowId`. */
export interface NotifyCycle {
  resetsAt: number | null
  percent: number
  seenAt: number
}

/** A channel's last result — written by the host after a send (C12's "last" line). Never a host, a body, a text. */
export interface ChannelLast {
  at: number
  event: NotifyEventKind | 'test'
  ok: boolean
  /** A `SendResult` kind of notifyChannels.ts: `http`, `timeout`, `tls`, `network`, `refused`, `config`. */
  kind?: string
  status?: number
  /** C1 rule 6: a 429's `Retry-After` pauses the channel until then. */
  pausedUntil?: number
}

export interface NotifyState {
  /** Identity → when it was sent (or its send attempted). */
  sent: Record<string, number>
  /** Kind → when its last message went out: the cooldown's clock. */
  lastByKind: Partial<Record<NotifyEventKind, number>>
  /** The hourly cap's window: its start and the messages counted in it. */
  hour: { start: number; count: number }
  last: Partial<Record<ChannelKind, ChannelLast>>
  /** `source:windowId` → its last cycle seen (C2 rule 5). */
  cycles: Record<string, NotifyCycle>
}

export function emptyNotifyState(): NotifyState {
  return { sent: {}, lastByKind: {}, hour: { start: 0, count: 0 }, last: {}, cycles: {} }
}

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/**
 * The memento read back by its shape: every entry checked on its own, anything else dropped. A state written
 * by another version, or by hand, costs at most a resent message — never a crash and never a stranger's field.
 */
export function cleanNotifyState(raw: unknown): NotifyState {
  const st = emptyNotifyState()
  if (!isObject(raw)) return st
  if (isObject(raw.sent)) {
    for (const [k, v] of Object.entries(raw.sent)) if (k.length <= 200 && finite(v)) st.sent[k] = v
  }
  if (isObject(raw.lastByKind)) {
    for (const kind of NOTIFY_EVENTS) {
      const v = raw.lastByKind[kind]
      if (finite(v)) st.lastByKind[kind] = v
    }
  }
  if (isObject(raw.hour) && finite(raw.hour.start) && finite(raw.hour.count) && raw.hour.count >= 0) {
    st.hour = { start: raw.hour.start, count: Math.floor(raw.hour.count) }
  }
  if (isObject(raw.last)) {
    for (const channel of NOTIFY_CHANNELS) {
      const v = raw.last[channel]
      if (!isObject(v) || !finite(v.at) || typeof v.ok !== 'boolean') continue
      const event = v.event === 'test' || (NOTIFY_EVENTS as readonly unknown[]).includes(v.event) ? v.event as ChannelLast['event'] : null
      if (event === null) continue
      const entry: ChannelLast = { at: v.at, event, ok: v.ok }
      if (typeof v.kind === 'string' && /^[A-Za-z]{1,20}$/.test(v.kind)) entry.kind = v.kind
      if (finite(v.status) && Number.isInteger(v.status)) entry.status = v.status
      if (finite(v.pausedUntil)) entry.pausedUntil = v.pausedUntil
      st.last[channel] = entry
    }
  }
  if (isObject(raw.cycles)) {
    for (const [k, v] of Object.entries(raw.cycles)) {
      if (k.length > 200 || !isObject(v) || !finite(v.percent) || !finite(v.seenAt)) continue
      if (v.resetsAt !== null && !finite(v.resetsAt)) continue
      st.cycles[k] = { resetsAt: v.resetsAt as number | null, percent: v.percent, seenAt: v.seenAt }
    }
  }
  return st
}

export function loadNotifyState(memento: MementoLike): NotifyState {
  return cleanNotifyState(memento.get<unknown>(NOTIFY_STATE_KEY, undefined))
}

/** Keeps the newest `max` entries younger than the TTL — the memento is not an archive. */
function pruneTable<T>(table: Record<string, T>, atOf: (v: T) => number, now: number): void {
  for (const k of Object.keys(table)) if (now - atOf(table[k]) > STATE_TTL_MS) delete table[k]
  const left = Object.keys(table)
  if (left.length <= STATE_MAX_ENTRIES) return
  left.sort((a, b) => atOf(table[a]) - atOf(table[b]))
  for (const k of left.slice(0, left.length - STATE_MAX_ENTRIES)) delete table[k]
}

export function pruneNotifyState(st: NotifyState, now: number): NotifyState {
  pruneTable(st.sent, (v) => v, now)
  pruneTable(st.cycles, (v) => v.seenAt, now)
  return st
}

export async function saveNotifyState(memento: MementoLike, st: NotifyState, now: number): Promise<void> {
  await memento.update(NOTIFY_STATE_KEY, pruneNotifyState(st, now))
}

// ---------------------------------------------------------------------------
// The observation tables (memory only)
// ---------------------------------------------------------------------------

/**
 * C2 rule 2: per session id — the key and nothing else of the session —, since when this window counts its
 * current turn open (null while it is not open), the newest reply time of a close already handled, and the
 * newest request it saw of the session (`lastRequest`'s `at` and `stop`) — the one fact that tells a new prompt
 * from a tool's result (Review 2 F4).
 */
export interface TurnSeenEntry {
  openSince: number | null
  closedTs: number | null
  reqAt: number | null
  reqStop: StopReason | null
}
export type TurnSeen = Map<string, TurnSeenEntry>
/**
 * C2 rule 1: per session id, the hook entry's time of the wait episode already told. The once-rule is the
 * persisted `sent[agentWaiting:<wait>:<ts>]` (C4 rule 1); this table only spares an episode that is in it the
 * evaluations that would drop it again, and it marks one only after `admit` — `markToldWaits` — so that a wait
 * the cooldown or the hourly cap dropped is built again while it stands and speaks once they let it (C4 rule 2,
 * Review 2 F2).
 */
export type WaitSeen = Map<string, number>

export interface NotifyTables { turns: TurnSeen; waits: WaitSeen }

export function newNotifyTables(): NotifyTables {
  return { turns: new Map(), waits: new Map() }
}

function eventOf(event: NotifyEventKind, identity: string, at: number, over: Partial<NotificationEvent>): NotificationEvent {
  return {
    event, identity, provider: null, program: null, windowLabel: null, windowKind: null, percent: null,
    resetsAt: null, etaAt: null, since: null, atLeastMs: null, wait: null, at, ...over,
  }
}

// ---------------------------------------------------------------------------
// The events
// ---------------------------------------------------------------------------

/**
 * C2 rules 3–7 (§0a.7): the quota events of this evaluation, from the readings and forecasts the in-editor
 * alerts read. Only a fresh reading speaks, only for a window with a limit and a finite percentage, and only
 * for the kinds the reader listed; `st.cycles` is brought up to date on the way — the last cycle seen per
 * window, which `quotaReset` compares against and which holds a jittering reset time to the cycle it belongs to.
 *
 * `paceWarning` exists only where the forecast does: `Forecast.state === 'eta'` is the one state with an
 * `etaMs` — the forecast's confidence gate (at least `minSamples` readings over `minSpanMs`, past
 * `minElapsedPercent` of the window, a rate above `idleRate`) answers `measuring`, `idle`, `stale`, `none`,
 * `full` or `resetsFirst` otherwise (forecast.ts `forecast`).
 */
export function quotaEvents(
  states: readonly QuotaState[],
  forecasts: ReadonlyMap<string, Forecast>,
  cfg: NotifyConfig,
  st: NotifyState,
  now: number,
  staleAfterMs: number,
): NotificationEvent[] {
  const listed = new Set<NotifyEventKind>(cfg.events)
  if (!QUOTA_EVENTS.some((k) => listed.has(k))) return []
  const out: NotificationEvent[] = []
  for (const s of states) {
    if (!freshReading(s, now, staleAfterMs)) continue
    const at = (s.fetchedAt as number) * 1000
    for (const w of s.windows) {
      if (w.unlimited || !finite(w.percent)) continue
      const key = `${s.source}:${w.id}`
      const cycle = st.cycles[key]
      const resetsAt = finite(w.resetsAt) ? w.resetsAt : null
      // The same cycle when the reset time only jittered: the stored one stays the cycle's name (the rule the
      // in-editor alerts share — resetRule.ts heldReset).
      const cycleResetsAt = heldReset(cycle?.resetsAt, resetsAt)
      const base = { provider: s.source, windowLabel: w.label, windowKind: w.kind, percent: Math.round(w.percent) }

      // C2 rule 5: a later reset for a window whose stored cycle has ended — no more than 30 min ago.
      if (listed.has('quotaReset') && cycle !== undefined && cycle.resetsAt !== null && resetsAt !== null
        && cycle.resetsAt <= now && resetsAt - cycle.resetsAt > RESET_JITTER_MS
        && now - cycle.resetsAt <= QUOTA_RESET_RECENT_MS) {
        out.push(eventOf('quotaReset', `quotaReset:${identityOf(s.source, { ...w, resetsAt: cycle.resetsAt })}`, at,
          { ...base, resetsAt, since: cycle.resetsAt }))
      }
      if (cycle === undefined || cycle.resetsAt !== cycleResetsAt || now - cycle.seenAt >= CYCLE_REFRESH_MS) {
        st.cycles[key] = { resetsAt: cycleResetsAt, percent: w.percent, seenAt: now }
      }

      // A reading whose reset has come describes a window that is over: nothing is said from it.
      if (resetsAt !== null && resetsAt <= now) continue
      const identity = identityOf(s.source, { ...w, resetsAt: cycleResetsAt })
      // C2 rule 4 (`unlimited` never — skipped above); rule 3: the stronger fact says it alone.
      if (w.limitReached === true || w.percent >= 100) {
        if (listed.has('quotaExhausted')) out.push(eventOf('quotaExhausted', `quotaExhausted:${identity}`, at, { ...base, resetsAt }))
        continue
      }
      // C2 rule 3: one threshold per window kind (§7a Q13); `other` takes none; `0` is off.
      const level = w.kind === 'session' ? cfg.thresholds.session : w.kind === 'weekly' ? cfg.thresholds.weekly : 0
      if (listed.has('quotaThreshold') && level > 0 && w.percent >= level) {
        out.push(eventOf('quotaThreshold', `quotaThreshold:${identity}`, at, { ...base, resetsAt }))
      }
      // C2 rule 6: a forecast that runs out after now and before the reset.
      const f = forecasts.get(key)
      if (listed.has('paceWarning') && f !== undefined && f.state === 'eta' && finite(f.etaMs) && f.etaMs > now
        && resetsAt !== null && f.etaMs < resetsAt) {
        out.push(eventOf('paceWarning', `paceWarning:${identity}`, at, { ...base, resetsAt, etaAt: f.etaMs }))
      }
    }
  }
  return out
}

/**
 * C2 rule 2 (§0a.5): a main session whose turn this window saw open, for at least `AGENT_DONE_MIN_MS` by its
 * own observation, and now sees closed (`turnClosed` → `closed`) — one `agentDone` with the observed span
 * as a lower bound ("after at least 12 min") and the closing reply's time. Nothing while the transcripts are
 * still being read (`settled` false: a cold scan's turns are history, not news — and nothing is observed then
 * either), nothing for a turn first seen already closed, and nothing while the window is focused (§7a Q16 —
 * the close is then taken as seen). Claude Code only: a Codex rollout's turn holds no end state Token Pace reads.
 *
 * Review 2 F4 (the lead's decision): the span restarts at the newest prompt. A new request (`lastRequest.at`
 * changed) after a request that did not call a tool — one that ended its turn, was cut off by an interruption,
 * or ended on an error or another stop — answers a prompt the user wrote after it, not a tool's result: a new
 * turn, counted from that request's first line (the earliest time the transcript knows of the answer to the
 * prompt, so the span stays a lower bound). Without this an interrupted or errored turn stayed "open" while the
 * reader was away, and the first short reply after their return read "after at least 3 h". An interruption
 * during a tool call looks like a tool still running (the newest request called a tool, the user's line is
 * newest) and is not told apart: its span counts from the first sighting.
 */
export function turnEvents(
  mains: readonly MainRec[],
  seen: TurnSeen,
  now: number,
  gate: { settled: boolean; focused: boolean },
): NotificationEvent[] {
  if (!gate.settled) return []
  const out: NotificationEvent[] = []
  const alive = new Set<string>()
  for (const m of mains) {
    if (!m || typeof m.sessionId !== 'string') continue
    alive.add(m.sessionId)
    const rec = seen.get(m.sessionId)
    const reqAt = m.lastRequest && finite(m.lastRequest.at) ? m.lastRequest.at : null
    const reqStop = m.lastRequest?.stop ?? null
    // F4: a new request after one that called no tool answers a new prompt — the turn restarted at it.
    const restarted = rec !== undefined && rec.reqAt !== null && reqAt !== null && reqAt !== rec.reqAt
      && rec.reqStop !== 'tool_use'
    if (turnClosed(m.lastRequest) !== 'closed') {
      if (rec === undefined) seen.set(m.sessionId, { openSince: now, closedTs: null, reqAt, reqStop })
      else {
        if (restarted) rec.openSince = Math.min(reqAt as number, now)
        else if (rec.openSince === null) rec.openSince = now
        rec.reqAt = reqAt
        rec.reqStop = reqStop
      }
      continue
    }
    const closedTs = finite(m.lastTs) ? m.lastTs : null
    if (rec === undefined) {
      seen.set(m.sessionId, { openSince: null, closedTs, reqAt, reqStop })
      continue
    }
    // The closing request answers a new prompt: the turn is that request alone, counted from its first line.
    const since = rec.openSince !== null && restarted ? Math.min(reqAt as number, now) : rec.openSince
    rec.openSince = null
    rec.reqAt = reqAt
    rec.reqStop = reqStop
    if (since === null || closedTs === null || rec.closedTs === closedTs) {
      rec.closedTs = closedTs
      continue
    }
    rec.closedTs = closedTs
    const span = closedTs - since
    if (span < AGENT_DONE_MIN_MS || gate.focused) continue
    out.push(eventOf('agentDone', `agentDone:${closedTs}`, closedTs, { program: 'claudeCode', atLeastMs: span }))
  }
  // Bounded to the sessions the aggregator holds.
  for (const id of [...seen.keys()]) if (!alive.has(id)) seen.delete(id)
  return out
}

/**
 * C2 rule 1 (§0a.6): a session's `permission` or `input` wait, as the agent hook reported it, newer than the
 * session's newest counted reply (`hookPermissionOpen`'s comparison, extended to `input`; an unknown reply time
 * counts as not answered), still standing `AGENT_WAIT_AFTER_MS` after it began and younger than the hook's own
 * `HOOK_MAX_AGE_MS`, while the window is not focused — one `agentWaiting` per session and wait episode (the
 * entry's `ts`). A wait seen while the window is focused is told once the window loses the focus, if it still
 * stands. The session's own calls only (`agentId` null — the Agents tree's session marker): an agent's wait is
 * answered in the agent's transcript, which these inputs do not hold.
 *
 * A wait for `input` counts only while the session's turn is not closed — the Agents tree's rule for the same
 * marker: Claude Code's `idle_prompt` notification is every finished turn's state a minute after it ended, and
 * that turn's end is `agentDone`'s to tell, not a question waiting for an answer.
 */
export function waitEvents(
  hooks: readonly HookEntry[],
  mains: readonly MainRec[],
  seen: WaitSeen,
  now: number,
  focused: boolean,
): NotificationEvent[] {
  const out: NotificationEvent[] = []
  const bySession = new Map<string, MainRec>()
  for (const m of mains) if (m && typeof m.sessionId === 'string') bySession.set(m.sessionId, m)
  const standing = new Set<string>()
  for (const h of hooks) {
    if (!h || h.agentId !== null || (h.wait !== 'permission' && h.wait !== 'input')) continue
    if (!finite(h.ts) || now - h.ts > HOOK_MAX_AGE_MS) continue
    const m = bySession.get(h.sessionId)
    if (m !== undefined && finite(m.lastTs) && h.ts <= m.lastTs) continue
    if (h.wait === 'input' && m !== undefined && turnClosed(m.lastRequest) === 'closed') continue
    standing.add(h.sessionId)
    if (now - h.ts < AGENT_WAIT_AFTER_MS || seen.get(h.sessionId) === h.ts || focused) continue
    // Not marked here: an episode is told once its identity is sent (`markToldWaits`, after `admit`).
    out.push(eventOf('agentWaiting', waitIdentity(h.wait, h.ts), now, { program: 'claudeCode', wait: h.wait, since: h.ts }))
  }
  // Bounded to the sessions with a wait standing.
  for (const id of [...seen.keys()]) if (!standing.has(id)) seen.delete(id)
  return out
}

/** C2 rule 1's once-rule: a wait episode's identity — its kind and the hook entry's time, never the session. */
function waitIdentity(wait: 'permission' | 'input', ts: number): string {
  return `agentWaiting:${wait}:${ts}`
}

/**
 * C4 rules 1–2 (Review 2 F2): after `admit`, the wait episodes whose identity is in the persisted `sent` — admitted
 * now or in an earlier life of the window — are marked told in `seen`, and only those: an episode the cooldown or
 * the hourly cap dropped stays unmarked, so the next evaluation builds it again while the wait stands.
 */
export function markToldWaits(hooks: readonly HookEntry[], st: NotifyState, seen: WaitSeen): void {
  for (const h of hooks) {
    if (!h || h.agentId !== null || (h.wait !== 'permission' && h.wait !== 'input') || !finite(h.ts)) continue
    if (st.sent[waitIdentity(h.wait, h.ts)] !== undefined) seen.set(h.sessionId, h.ts)
  }
}

/** What one evaluation hands the notifier (C9 rule 2): the same readings, forecasts, sessions and waits the page has. */
export interface NotifyInput {
  states: readonly QuotaState[]
  forecasts: ReadonlyMap<string, Forecast>
  mains: readonly MainRec[]
  hooks: readonly HookEntry[]
  /** The leader's own window (C9 rule 4). */
  focused: boolean
  /** False while the transcripts are being read (a cold scan, a re-read, the Agents tables' replay). */
  settled: boolean
  role: 'leader' | 'follower' | 'single'
  /** The status bar's `staleAfterMinutes`, in ms — the alerts' freshness rule. */
  staleAfterMs: number
}

/**
 * The events of one evaluation, of the listed kinds only. Nothing with no channel listed (C9 rule 3) or in a
 * follower window (C2 rule 7); the agent events not while the transcripts are being read — `agentDone`
 * because a cold scan's turns are history, `agentWaiting` because a session's newest reply, which answers a
 * wait, may not be read yet.
 */
export function collectEvents(input: NotifyInput, cfg: NotifyConfig, st: NotifyState, tables: NotifyTables, now: number): NotificationEvent[] {
  if (cfg.channels.length === 0 || input.role === 'follower') return []
  const listed = new Set<NotifyEventKind>(cfg.events)
  const out: NotificationEvent[] = []
  if (listed.has('agentWaiting') && input.settled) {
    out.push(...waitEvents(input.hooks, input.mains, tables.waits, now, input.focused))
  }
  if (listed.has('agentDone')) {
    out.push(...turnEvents(input.mains, tables.turns, now, { settled: input.settled, focused: input.focused }))
  }
  out.push(...quotaEvents(input.states, input.forecasts, cfg, st, now, input.staleAfterMs))
  return out
}

// ---------------------------------------------------------------------------
// Admission (C4)
// ---------------------------------------------------------------------------

export type DropReason = 'notListed' | 'sent' | 'cooldown' | 'hourlyCap'

export interface Admission {
  /** One group per event kind, in `NOTIFY_EVENTS` order: one message each. */
  send: NotificationEvent[][]
  dropped: Array<{ event: NotifyEventKind; why: DropReason }>
}

/**
 * C4 rules 1–3: which events of this evaluation go out, grouped one message per kind — and `st` marked for
 * them (each identity sent, the kind's cooldown started, the hour's count raised by one per listed channel).
 * The caller persists `st` before it sends (C4 rule 5). A dropped event is not queued; one dropped by the
 * cooldown or the cap is not marked sent, so it may speak later if it still holds.
 */
export function admit(events: readonly NotificationEvent[], cfg: NotifyConfig, st: NotifyState, now: number): Admission {
  const listed = new Set<NotifyEventKind>(cfg.events)
  const dropped: Admission['dropped'] = []
  const byKind = new Map<NotifyEventKind, NotificationEvent[]>()
  for (const ev of events) {
    if (!listed.has(ev.event)) { dropped.push({ event: ev.event, why: 'notListed' }); continue }
    const group = byKind.get(ev.event) ?? []
    if (st.sent[ev.identity] !== undefined || group.some((x) => x.identity === ev.identity)) {
      dropped.push({ event: ev.event, why: 'sent' })
      continue
    }
    group.push(ev)
    byKind.set(ev.event, group)
  }
  const perMessage = Math.max(1, cfg.channels.length)
  const cooldownMs = cfg.cooldownMinutes * 60_000
  const send: NotificationEvent[][] = []
  for (const kind of NOTIFY_EVENTS) {
    const group = byKind.get(kind)
    if (group === undefined) continue
    const last = st.lastByKind[kind]
    // A clock that went back keeps the cooldown too: a storm is worse than a late message.
    if (last !== undefined && now - last < cooldownMs) {
      for (const ev of group) dropped.push({ event: ev.event, why: 'cooldown' })
      continue
    }
    // The hour's window starts with a message that may go out — an evaluation that sends nothing changes nothing.
    if (!(now >= st.hour.start && now - st.hour.start < HOUR_MS)) st.hour = { start: now, count: 0 }
    if (st.hour.count + perMessage > NOTIFY_HOURLY_CAP) {
      for (const ev of group) dropped.push({ event: ev.event, why: 'hourlyCap' })
      continue
    }
    st.hour.count += perMessage
    st.lastByKind[kind] = now
    for (const ev of group) st.sent[ev.identity] = now
    send.push(group)
  }
  return { send, dropped }
}

/** C4 rule 2's debug lines — one per kind and reason: `Notify: quotaThreshold dropped (cooldown)`. */
export function droppedLines(dropped: Admission['dropped']): string[] {
  return [...new Set(dropped.map((d) => `Notify: ${d.event} dropped (${d.why})`))]
}

/**
 * One evaluation, end to end: nothing at all with no channel listed or in a follower window (not even the
 * state is read — C9 rule 3); otherwise the events, their admission, the wait episodes now sent marked told
 * (`markToldWaits` — after the admission, never before it), the state persisted (C4 rule 5 — only when it
 * changed), then one `send` per message. A send that throws changes nothing: its identities were
 * marked before it started (C4 rule 4 — an attempt counts, no retry).
 */
export async function notifyRound(
  input: NotifyInput,
  cfg: NotifyConfig,
  tables: NotifyTables,
  deps: {
    memento: MementoLike
    words: NotifyWords
    send: (payload: NotificationPayload, events: readonly NotificationEvent[]) => Promise<unknown>
  },
  now: number,
): Promise<Admission> {
  if (cfg.channels.length === 0 || input.role === 'follower') return { send: [], dropped: [] }
  const st = loadNotifyState(deps.memento)
  const before = JSON.stringify(st)
  const events = collectEvents(input, cfg, st, tables, now)
  const admission = admit(events, cfg, st, now)
  if (cfg.events.includes('agentWaiting')) markToldWaits(input.hooks, st, tables.waits)
  if (JSON.stringify(st) !== before) await saveNotifyState(deps.memento, st, now)
  for (const group of admission.send) {
    try {
      await deps.send(payloadOf(group, deps.words), group)
    } catch {
      // Marked sent above: the diagnostics show the failure, the next evaluation does not retry it.
    }
  }
  return admission
}

// ---------------------------------------------------------------------------
// The payload (§0a.10, C3)
// ---------------------------------------------------------------------------

/** The facts `payloadOf` takes of an event — its allow-list, and all the rest of the module formats from. */
interface PayloadFacts {
  event: NotifyEventKind
  provider: Source | null
  program: 'claudeCode' | null
  windowLabel: string | null
  windowKind: NotificationEvent['windowKind']
  percent: number | null
  resetsAt: number | null
  etaAt: number | null
  since: number | null
  atLeastMs: number | null
  wait: 'permission' | 'input' | null
  at: number
}

const iso = (ms: number | null): string | null => (ms === null || !finite(ms) ? null : new Date(ms).toISOString())

/** A lower bound is never rounded up: whole seconds below an hour, whole minutes from one on. */
function atLeastText(ms: number): string {
  return spanText(ms >= HOUR_MS ? Math.floor(ms / 60_000) * 60_000 : Math.floor(ms / 1000) * 1000)
}

/** C3 rule 4: the product names of the registry — the provider for a quota window, Claude Code for its agents. */
function whoOf(f: PayloadFacts): string {
  if (f.provider !== null) return PROVIDER_NAME[f.provider]
  return SOURCE_TITLE.claude
}

/** C13: one whole key per kind. */
function titleOf(f: PayloadFacts): string {
  switch (f.event) {
    case 'agentWaiting': return t('Token Pace: {0} is waiting for you', whoOf(f))
    case 'agentDone': return t('Token Pace: a long turn finished')
    case 'quotaThreshold': return t('Token Pace: quota threshold reached')
    case 'quotaExhausted': return t('Token Pace: quota exhausted')
    case 'quotaReset': return t('Token Pace: quota window reset')
    case 'paceWarning': return t('Token Pace: quota runs out before its reset')
  }
}

/**
 * C13: one whole key per case, the figures through the page's own formatters (C3 rule 2) — the percent as the
 * bar writes it, a reset through `resetClock`, a clock time through `formatTime`, a span through the tree's
 * `spanText`, the ETA marked `~`. An absent reset is the key without that slot, never a `–` in a sentence.
 */
function sentenceOf(f: PayloadFacts, words: NotifyWords): string {
  const who = whoOf(f)
  const label = f.windowLabel ?? ''
  const pct = f.percent === null ? '' : percentText(f.percent, 'used', 'actual')
  const clock = (ms: number): string => formatTime(ms, words.tcfg)
  const reset = (ms: number): string => resetClock(ms, words.now, words.tcfg)
  switch (f.event) {
    case 'agentWaiting':
      return f.wait === 'permission'
        ? t('{0} is waiting for your permission (since {1}).', who, clock(f.since ?? f.at))
        : t('{0} is waiting for your answer (since {1}).', who, clock(f.since ?? f.at))
    case 'agentDone':
      return t('{0} finished a turn at {1}, after at least {2}.', who, clock(f.at), atLeastText(f.atLeastMs ?? 0))
    case 'quotaThreshold':
      return f.resetsAt !== null
        ? t('{0}, {1} window: {2} used — resets at {3}.', who, label, pct, reset(f.resetsAt))
        : t('{0}, {1} window: {2} used.', who, label, pct)
    case 'quotaExhausted':
      return f.resetsAt !== null
        ? t('{0}, {1} window: exhausted — resets at {2}.', who, label, reset(f.resetsAt))
        : t('{0}, {1} window: exhausted.', who, label)
    case 'quotaReset':
      return t('{0}, {1} window: reset at {2} — {3} used in the new window.', who, label, clock(f.since ?? f.at), pct)
    case 'paceWarning':
      return t('{0}, {1} window: {2} used, runs out at {3} — before it resets at {4}.',
        who, label, pct, estimate(reset(f.etaAt ?? f.at)), reset(f.resetsAt ?? f.at))
  }
}

/** C1 rule 1's fields of one event — ISO 8601 UTC times, `null` where absent (never `0`), a whole percent. */
function jsonOf(f: PayloadFacts): Record<string, string | number | null> {
  return {
    event: f.event,
    provider: f.provider,
    program: f.program,
    window: f.windowLabel,
    windowKind: f.windowKind,
    percent: f.percent,
    resetsAt: iso(f.resetsAt),
    eta: iso(f.etaAt),
    since: iso(f.since),
    atLeastMinutes: f.atLeastMs === null ? null : Math.floor(f.atLeastMs / 60_000),
    wait: f.wait,
    at: iso(f.at),
  }
}

/**
 * §0a.10, C3 rule 1: the one function that makes a payload — `{ title, text, json }` for one event kind and its
 * events of this evaluation: the title one whole key per kind, the text the events' sentences joined by a
 * newline, the JSON the first event's fields plus `items` (the same fields per event) when there are several.
 * The texts are in the language of the installed bundle (`tokenPace.language`'s, C3 rule 3); the JSON's keys and
 * values other than `title` and `text` are English data. Events of another kind than the first are left out:
 * a message speaks of one kind (`admit` groups them so).
 *
 * Every field of an event read here is read in this function, by name, and nowhere else: the read contract of
 * scripts/check-privacy.mjs lists the twelve, so a thirteenth fails the check — `identity` is not among them.
 */
export function payloadOf(events: readonly NotificationEvent[], words: NotifyWords): NotificationPayload {
  const facts: PayloadFacts[] = events.map((e) => ({
    event: e.event, provider: e.provider, program: e.program, windowLabel: e.windowLabel, windowKind: e.windowKind,
    percent: e.percent, resetsAt: e.resetsAt, etaAt: e.etaAt, since: e.since, atLeastMs: e.atLeastMs, wait: e.wait,
    at: e.at,
  }))
  if (facts.length === 0) throw new Error('payloadOf: a message needs one event at least')
  const same = facts.filter((f) => f.event === facts[0].event)
  const title = titleOf(same[0])
  const text = same.map((f) => sentenceOf(f, words)).join('\n')
  const { event, ...rest } = jsonOf(same[0])
  const json: Record<string, NotifyJsonValue> = { v: 1, source: 'token-pace', event, title, text, ...rest }
  if (same.length > 1) json.items = same.map(jsonOf)
  return { title, text, json }
}

/**
 * C13's test message (C4 rule 7 — *Send a Test Notification…* sends it past the once-rule, the cooldown and
 * the cap): its title, one sentence with the time it was sent, and the generic JSON with `event: "test"` and
 * every figure `null`.
 */
export function testPayload(words: NotifyWords): NotificationPayload {
  const title = t('Token Pace: test message')
  const text = t('This channel works: Token Pace can reach it. Sent at {0}.', formatTime(words.now, words.tcfg))
  return {
    title,
    text,
    json: {
      v: 1, source: 'token-pace', event: 'test', title, text, provider: null, program: null, window: null,
      windowKind: null, percent: null, resetsAt: null, eta: null, since: null, atLeastMinutes: null, wait: null,
      at: iso(words.now),
    },
  }
}
