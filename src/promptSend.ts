// SPDX-FileCopyrightText: 2026 Frederik Marx
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * 1.10 A4 (spec §3 A4, §0a.5, §2.4): when the prompt tool does not type a prompt into the terminal the
 * reader picked, or asks first — `promptSendDecision`, pure. It is always the reader's own click that
 * sends; this decides only whether that click types the prompt at once, only after *Send anyway* (a
 * soft block: the transcript cannot tell a running tool from an open dialog), or not at all (a hard
 * block: a fact, not a guess). The first rule that applies decides:
 *
 *   1  the workspace is trusted                                   restricted     hard   (G1's trust part)
 *   2  no cold scan, no replay of the agent tables (`settled`)    reading        hard   (G14)
 *   3  a target terminal exists                                   noTerminal     hard   (G7's test)
 *   4  the target is not Codex                                    codex          soft   (nothing of Codex is read)
 *   5  the target's folder is known                               unknownFolder  soft   (G7's `cwd` part)
 *   6  no live session of the folder has a permission request
 *      open (live = not left behind by 1.9 D; with no start
 *      time none is left behind)                                  hookWait       hard   (G6)
 *   7  the execution's start is known                             unknownStart   soft   (G13 (a) cannot be asked)
 *   8  a session of the folder wrote after the terminal's
 *      program started — its own, or one it resumed               noSession      hard   (G13 (a), widened)
 *   9  each of those: its turn closed (G4 without its age)        openTool/notIdle soft
 *  10  … and no agent of it running                               agentRunning   soft   (G5)
 *  11  every other live session of the folder idle                otherSession   soft   (G13 (b) with 1.9 D)
 *  12  —                                                          send
 *
 * G4 has no age here: KEEPWARM_IDLE_MIN_MS exists because the keep-warm line goes without a click, and a
 * reader who double-clicks a second after a reply is at the keyboard. Not reused: G2/G3 (cache timing),
 * G8 (focus — the reader is the one who could have typed a draft), G9–G12 (the keep-warm phase), G10 (a
 * prompt at 95 % is the reader's call).
 *
 * The predicates are keepWarm.ts's (`turnClosed`, `siblingLeftBehind`; `hookPermissionOpen` gives a
 * session's `hookWait`), never copied. Every fact is taken strictly, as keep-warm takes its facts: a flag
 * or a time of another shape never lets a prompt go where the exact value would have held it.
 *
 * 1.10 P4 (§3 A4's words): `promptBlockText` says a block in the reader's words — one sentence each, the
 * same wherever a block is said (the section's target line, the terminal pick, the modal, the information
 * message, the flash). The log names the code only.
 *
 * Pure: no clock, no I/O, no `vscode` — the words come from the bundle `t()` reads.
 */

import { t } from './i18n'
import { KeepWarmSibling, siblingLeftBehind, turnClosed } from './keepWarm'
import type { AgentTerminal } from './terminalWatch'

/** Why a prompt does not go at once — the hard blocks never, the soft ones only after *Send anyway*. */
export type PromptSendBlock =
  // never sent (hard)
  | 'restricted' | 'noTerminal' | 'reading' | 'noSession' | 'hookWait'
  // sent only after "Send anyway" (soft)
  | 'openTool' | 'notIdle' | 'agentRunning' | 'otherSession' | 'unknownStart' | 'unknownFolder' | 'codex'

/** The blocks after which *Send anyway* may still send — where the transcript cannot tell work from a dialog. */
export const PROMPT_SOFT_BLOCKS: ReadonlySet<PromptSendBlock> = new Set<PromptSendBlock>([
  'openTool', 'notIdle', 'agentRunning', 'otherSession', 'unknownStart', 'unknownFolder', 'codex',
])

/** §0a.5: one main session of the target's folder, as the aggregator and the agent hook keep it. */
export interface PromptSession extends KeepWarmSibling {
  sessionId: string
  /** G6 for this session: the hook holds a `wait: 'permission'` entry newer than its newest reply (`hookPermissionOpen`). */
  hookWait: boolean
}

/** Everything the decision looks at, gathered at the moment of the send. */
export interface PromptTargetFacts {
  /** `vscode.workspace.isTrusted`. */
  trusted: boolean
  /** No cold scan and no replay of the agent tables under way (G14). */
  settled: boolean
  /** The terminal the prompt would go to — null: no terminal of this window runs Claude Code or Codex. */
  target: Pick<AgentTerminal, 'kind' | 'startedAt' | 'projectDir'> | null
  /** Every main session of the target's folder (folderSessions + hookWait); empty for Codex. */
  sessions: readonly PromptSession[]
}

export type PromptVerdict = { send: true } | { send: false; block: PromptSendBlock; soft: boolean }

function finite(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v)
}

function refuse(block: PromptSendBlock): PromptVerdict {
  return { send: false, block, soft: PROMPT_SOFT_BLOCKS.has(block) }
}

/** A session entry of the shape the decision reads — anything else is taken as the worst it could be. */
function isSession(s: unknown): s is PromptSession {
  return typeof s === 'object' && s !== null
}

/**
 * Rule 8: the session wrote after the terminal's program started — its newest counted reply or its
 * newest `user` line (`max(lastTs, lastUserAt)`) is later than `started`. A time of another shape is not
 * known and proves nothing.
 */
function wroteAfter(s: PromptSession, started: number): boolean {
  return (finite(s.lastTs) && s.lastTs > started) || (finite(s.lastUserAt) && s.lastUserAt > started)
}

/**
 * Rule 11: a session idle by G4's test without its age — its turn closed (`turnClosed`), its newest reply's
 * time known — and with no agent of it running (G5).
 */
function sessionIdle(s: PromptSession): boolean {
  return finite(s.lastTs) && turnClosed(s) === 'closed' && s.running === false
}

/** 1.9 D's bound: left behind before the terminal's program started — never without a known start. */
function leftBehind(s: PromptSession, started: number | null, now: number): boolean {
  return started !== null && finite(started) && siblingLeftBehind(s, started, now)
}

/**
 * §3 A4: the decision for one send, on facts gathered now — `{ send: true }`, or the first rule that does
 * not hold, with whether *Send anyway* may still send (`soft`).
 */
export function promptSendDecision(f: PromptTargetFacts, now: number): PromptVerdict {
  // 1 · G1's trust part: nothing is typed into a terminal in a workspace the reader has not trusted.
  if (f.trusted !== true) return refuse('restricted')
  // 2 · G14: a cold scan or the agent tables' replay is rebuilding the records every later rule reads.
  if (f.settled !== true) return refuse('reading')
  // 3 · G7's test: a terminal of this window that runs Claude Code or Codex.
  const target = f.target
  if (!target || typeof target !== 'object') return refuse('noTerminal')
  // 4 · Nothing of a Codex session is read: it cannot be told whether Codex works or waits for an approval.
  if (target.kind === 'codex') return refuse('codex')
  if (target.kind !== 'claude') return refuse('noTerminal')
  // 5 · G7's `cwd` part: without the terminal's folder no session can be tied to it.
  if (typeof target.projectDir !== 'string' || target.projectDir === '') return refuse('unknownFolder')

  const all = Array.isArray(f.sessions) ? f.sessions : []
  const sessions = all.filter(isSession)
  const started = finite(target.startedAt) ? target.startedAt : null

  // 6 · G6: a permission dialog the agent hook saw open in a live session of the folder — Enter would
  // answer it. Live: not left behind by 1.9 D; with the start unknown, none is left behind.
  for (const s of sessions) if (s.hookWait !== false && !leftBehind(s, started, now)) return refuse('hookWait')

  // 7 · G13 (a) cannot be asked without the time the terminal's program started.
  if (started === null) return refuse('unknownStart')

  // 8 · G13 (a), widened to a resumed session: some session of the folder wrote after the program started —
  // otherwise Claude Code may still show a dialog of its own there (trusting the folder, signing in, the
  // list of --resume), whose highlighted answer Enter would take.
  const own = sessions.filter((s) => wroteAfter(s, started))
  if (own.length === 0) return refuse('noSession')

  // 9 · G4 without its age, for each of them: a user line newest or a tool call open (a dialog may stand
  // open — probe P-6) before any other stop.
  const turns = own.map((s) => turnClosed(s))
  if (turns.includes('openTool')) return refuse('openTool')
  if (turns.includes('notIdle')) return refuse('notIdle')

  // 10 · G5: an agent of one of them runs — its end can wake the conversation at any moment.
  if (own.some((s) => s.running !== false)) return refuse('agentRunning')

  // 11 · G13 (b) with 1.9 D's bound: every other session of the folder idle, or left behind.
  for (const s of all) {
    if (isSession(s) && own.includes(s)) continue
    if (!isSession(s) || !(sessionIdle(s) || leftBehind(s, started, now))) return refuse('otherSession')
  }

  return { send: true }
}

/**
 * §3 A4: why a prompt does not go at once, in the reader's words — `t()` literals in a switch (the extract
 * script reads literals). A reason is a whole sentence; the product names stay as they are in every language.
 */
export function promptBlockText(block: PromptSendBlock): string {
  switch (block) {
    case 'restricted': return t('Restricted Mode: Token Pace types nothing into a terminal in a workspace you have not trusted.')
    case 'reading': return t('Token Pace is reading the transcripts; try again in a moment.')
    case 'noTerminal': return t('No terminal of this window runs Claude Code or Codex (VS Code\'s shell integration reports none).')
    case 'codex': return t('Token Pace reads nothing of a Codex session\'s state: it cannot tell whether Codex is at work or waiting for an approval.')
    case 'unknownFolder': return t('VS Code reports no folder for that terminal, so Token Pace cannot tell which session runs there.')
    case 'hookWait': return t('Claude Code is asking for a permission in a session of that folder. Answer it first.')
    case 'unknownStart': return t('Token Pace did not see Claude Code start in that terminal, so it cannot tell which session runs there.')
    case 'noSession': return t('Claude Code in that terminal has not written a line since it started, so it may still show a dialog of its own (trusting the folder, signing in, the list of --resume). Send the first message by hand.')
    case 'openTool': return t('Claude Code is at work there, or waiting for your answer in a dialog; its transcript cannot tell which.')
    case 'notIdle': return t('Claude Code\'s last reply there did not end its turn.')
    case 'agentRunning': return t('An agent of that session is running.')
    default: return t('Another Claude Code session of the same folder is at work or waiting for an answer.')
  }
}
