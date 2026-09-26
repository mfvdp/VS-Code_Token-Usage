// SPDX-FileCopyrightText: 2026 Frederik Marx
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * 1.10 P2 (spec §3 A4 with its tests and mutation checks, §0a.5, §2.4): the prompt tool's send decision
 * on its facts — every block reached with every other fact passing, with its hard/soft flag; the order;
 * the probe P-6 shape; the agent hook's permission request (G6, by keepWarm.ts's predicate); 1.9 D's bound
 * for a session left behind; a `claude --resume`; a fresh `claude`; Codex; an unknown start; no age for G4;
 * every fact taken strictly. The words that say a block are P4's; this holds the codes.
 * Synthetic sessions throughout — times, stop reasons and flags; no transcript, no terminal.
 */

import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import type { HookEntry } from '../src/agentTree'
import { KEEPWARM_SIBLING_LEFT_MS, hookPermissionOpen } from '../src/keepWarm'
import {
  PROMPT_SOFT_BLOCKS, PromptSendBlock, PromptSession, PromptTargetFacts, PromptVerdict, promptSendDecision,
} from '../src/promptSend'
import { ROOT } from './helpers/nls'

const SEC = 1000
const MIN = 60 * SEC
const HOUR = 60 * MIN
/** 2026-09-26 10:00 UTC. */
const NOW = Date.UTC(2026, 8, 26, 10, 0, 0)
/** The terminal's `claude` started an hour ago. */
const START = NOW - HOUR
const DIR = '-home-u-proj'
const OWN = '9d0eb37a-0000-4000-8000-000000000001'
const OTHER = '5f1c2d3e-0000-4000-8000-000000000002'

/** The session the terminal's `claude` began half a minute after it started; its turn ended five minutes ago. */
function own(over: Partial<PromptSession> = {}): PromptSession {
  return {
    sessionId: OWN, firstAt: START + 30 * SEC, lastTs: NOW - 5 * MIN, stop: 'end_turn', replyPending: false, running: false,
    lastUserAt: NOW - 5 * MIN - 10 * SEC, hookWait: false, ...over,
  }
}

/** Another session of the folder, begun the day before, idle — its newest line three hours old (before the start). */
function other(over: Partial<PromptSession> = {}): PromptSession {
  return {
    sessionId: OTHER, firstAt: NOW - 26 * HOUR, lastTs: NOW - 3 * HOUR - 5 * MIN, stop: 'end_turn', replyPending: false, running: false,
    lastUserAt: NOW - 3 * HOUR - 6 * MIN, hookWait: false, ...over,
  }
}

/** Facts under which a prompt goes at once. */
function facts(over: Partial<PromptTargetFacts> = {}): PromptTargetFacts {
  return { trusted: true, settled: true, target: { kind: 'claude', startedAt: START, projectDir: DIR }, sessions: [own(), other()], ...over }
}

function target(over: Partial<NonNullable<PromptTargetFacts['target']>> = {}): PromptTargetFacts['target'] {
  return { kind: 'claude', startedAt: START, projectDir: DIR, ...over }
}

/** The block, or 'send'. */
function verdict(f: PromptTargetFacts, now = NOW): PromptSendBlock | 'send' {
  const v = promptSendDecision(f, now)
  return v.send ? 'send' : v.block
}

const HARD: readonly PromptSendBlock[] = ['restricted', 'noTerminal', 'reading', 'noSession', 'hookWait']
const SOFT: readonly PromptSendBlock[] = ['openTool', 'notIdle', 'agentRunning', 'otherSession', 'unknownStart', 'unknownFolder', 'codex']

// ---------------------------------------------------------------------------
// The table (§3 A4)
// ---------------------------------------------------------------------------

interface Case { what: string; f: PromptTargetFacts; block: PromptSendBlock }

const CASES: readonly Case[] = [
  { what: 'Restricted Mode', f: facts({ trusted: false }), block: 'restricted' },
  { what: 'the transcripts being read', f: facts({ settled: false }), block: 'reading' },
  { what: 'no terminal runs Claude Code or Codex', f: facts({ target: null }), block: 'noTerminal' },
  { what: 'the target runs Codex', f: facts({ target: target({ kind: 'codex' }), sessions: [] }), block: 'codex' },
  { what: 'no folder reported for the terminal', f: facts({ target: target({ projectDir: null }) }), block: 'unknownFolder' },
  { what: 'a permission request open in the session', f: facts({ sessions: [own({ hookWait: true }), other()] }), block: 'hookWait' },
  { what: 'a permission request open in another live session', f: facts({ sessions: [own(), other({ lastTs: NOW - 90 * MIN, lastUserAt: null, hookWait: true })] }), block: 'hookWait' },
  { what: 'the start not seen', f: facts({ target: target({ startedAt: null }) }), block: 'unknownStart' },
  { what: 'a fresh claude — no session wrote since it started', f: facts({ sessions: [other()] }), block: 'noSession' },
  { what: 'the user\'s line newest after an end_turn reply (probe P-6)', f: facts({ sessions: [own({ replyPending: true, lastUserAt: NOW - MIN }), other()] }), block: 'openTool' },
  { what: 'a reply that called a tool', f: facts({ sessions: [own({ stop: 'tool_use' }), other()] }), block: 'openTool' },
  { what: 'a reply cut off by max_tokens', f: facts({ sessions: [own({ stop: 'max_tokens' }), other()] }), block: 'notIdle' },
  { what: 'an agent of the session running', f: facts({ sessions: [own({ running: true }), other()] }), block: 'agentRunning' },
  { what: 'another session of the folder waiting 90 minutes for its reply', f: facts({ sessions: [own(), other({ replyPending: true, lastUserAt: NOW - 90 * MIN })] }), block: 'otherSession' },
]

test('the decision table: every rule passing sends; each rule failing alone is its block, with its hard or soft flag; every block is reached (§3 A4)', () => {
  assert.deepEqual(promptSendDecision(facts(), NOW), { send: true })
  const reached = new Set<PromptSendBlock>()
  for (const c of CASES) {
    const v = promptSendDecision(c.f, NOW)
    assert.deepEqual(v, { send: false, block: c.block, soft: SOFT.includes(c.block) }, c.what)
    reached.add(c.block)
  }
  assert.deepEqual([...reached].sort(), [...HARD, ...SOFT].sort(), 'a block no case reaches')
  // The soft blocks are exactly the ones the transcript cannot tell from a dialog (and Codex, the folder,
  // the start); the hard ones never offer *Send anyway*.
  assert.deepEqual([...PROMPT_SOFT_BLOCKS].sort(), [...SOFT].sort())
  for (const b of HARD) assert.equal(PROMPT_SOFT_BLOCKS.has(b), false, b)
  // Mutation check (§3 A4): making noSession soft fails here.
  assert.deepEqual(promptSendDecision(facts({ sessions: [other()] }), NOW), { send: false, block: 'noSession', soft: false })
})

test('the order: the first rule that fails decides — Restricted Mode with a permission request open says restricted (§3 A4)', () => {
  const worst = facts({
    trusted: false, settled: false, target: target({ kind: 'claude', startedAt: null, projectDir: DIR }),
    sessions: [own({ hookWait: true, replyPending: true, running: true }), other({ replyPending: true, lastUserAt: NOW - MIN })],
  })
  assert.equal(verdict(worst), 'restricted')
  assert.equal(verdict({ ...worst, trusted: true }), 'reading')
  assert.equal(verdict({ ...worst, trusted: true, settled: true, target: null }), 'noTerminal')
  assert.equal(verdict({ ...worst, trusted: true, settled: true, target: target({ kind: 'codex', startedAt: null, projectDir: null }) }), 'codex')
  assert.equal(verdict({ ...worst, trusted: true, settled: true, target: target({ startedAt: null, projectDir: null }) }), 'unknownFolder')
  // A permission request comes before the unknown start (§3 A4 test: "but a hook permission still hookWait first").
  assert.equal(verdict({ ...worst, trusted: true, settled: true }), 'hookWait')
  const noHook = { ...worst, trusted: true, settled: true, sessions: [own({ replyPending: true, running: true }), other({ replyPending: true, lastUserAt: NOW - MIN })] }
  assert.equal(verdict(noHook), 'unknownStart')
  // Started known: the other session wrote after the start too, so it is one of "those" (a known limit):
  // its user line newest → openTool before the running agent.
  assert.equal(verdict({ ...noHook, target: target() }), 'openTool')
  assert.equal(verdict({ ...noHook, target: target(), sessions: [own({ running: true }), other({ replyPending: true, lastUserAt: NOW - 90 * MIN })] }), 'agentRunning')
  assert.equal(verdict({ ...noHook, target: target(), sessions: [own(), other({ replyPending: true, lastUserAt: NOW - 90 * MIN })] }), 'otherSession')
  // Of two of "those", one at a tool and one cut off: openTool names it — a dialog may be open.
  assert.equal(verdict(facts({ sessions: [own({ stop: 'max_tokens' }), own({ sessionId: OTHER, stop: 'tool_use' })] })), 'openTool')
})

// ---------------------------------------------------------------------------
// §3 A4's named tests
// ---------------------------------------------------------------------------

test('G4 without its age: the P-6 shape → openTool; max_tokens → notIdle; a reply 10 s old that ended its turn → send (§3 A4)', () => {
  // The P-6 shape: the newest reply ended its turn, then the user's line — a question or a dialog may be open.
  assert.equal(verdict(facts({ sessions: [own({ stop: 'end_turn', replyPending: true, lastUserAt: NOW - 20 * SEC })] })), 'openTool')
  for (const stop of ['max_tokens', 'pause_turn', 'refusal', 'stop_sequence', null] as const) {
    assert.equal(verdict(facts({ sessions: [own({ stop })] })), 'notIdle', String(stop))
  }
  // Mutation check (§3 A4): adding G4's age (KEEPWARM_IDLE_MIN_MS) fails here — the reader is at the keyboard.
  assert.equal(verdict(facts({ sessions: [own({ lastTs: NOW - 10 * SEC, lastUserAt: NOW - 15 * SEC })] })), 'send')
  assert.equal(verdict(facts({ sessions: [own({ lastTs: NOW - SEC, lastUserAt: NOW - 2 * SEC })] })), 'send')
})

test('G5: an agent of the session running → agentRunning; of another session left behind → send (§3 A4)', () => {
  assert.equal(verdict(facts({ sessions: [own({ running: true })] })), 'agentRunning')
  // An agent of another session of the folder: that session is not idle — unless left behind, which an
  // agent running rules out (1.9 D).
  assert.equal(verdict(facts({ sessions: [own(), other({ running: true })] })), 'otherSession')
})

test('G6 by keepWarm.ts\'s predicate: a permission request newer than the session\'s newest reply → hookWait, hard; an older one, a wait for input, none → not (§3 A4)', () => {
  const entry = (over: Partial<HookEntry> = {}): HookEntry =>
    ({ ts: NOW - 4 * MIN, event: 'PermissionRequest', sessionId: OWN, agentId: null, wait: 'permission', ...over })
  const session = (hook: HookEntry | null): PromptSession => {
    const s = own()
    return { ...s, hookWait: hookPermissionOpen(hook, s.lastTs) }
  }
  assert.deepEqual(promptSendDecision(facts({ sessions: [session(entry())] }), NOW), { send: false, block: 'hookWait', soft: false })
  assert.equal(verdict(facts({ sessions: [session(entry({ ts: NOW - 6 * MIN }))] })), 'send', 'a request the reply answered')
  assert.equal(verdict(facts({ sessions: [session(entry({ wait: 'input' }))] })), 'send', 'a wait for input')
  assert.equal(verdict(facts({ sessions: [session(null)] })), 'send')
  assert.equal(hookPermissionOpen(entry({ ts: Number.NaN }), NOW), true, 'a request of unknown time counts as open')
  assert.equal(hookPermissionOpen(entry(), Number.NaN), true, 'a reply of unknown time answers nothing')
  // Mutation check (§3 A4): dropping rule 6 sends here.
  assert.equal(verdict(facts({ sessions: [own({ hookWait: true })] })), 'hookWait')
})

test('1.9 D: a session left behind — its prompt unanswered for 3 h, before the terminal\'s claude — does not hold the prompt back, nor does its permission request; 90 minutes old it does (§3 A4)', () => {
  const abandoned = other({ lastTs: NOW - 3 * HOUR - 5 * MIN, replyPending: true, lastUserAt: NOW - 3 * HOUR })
  assert.equal(verdict(facts({ sessions: [own(), abandoned] })), 'send')
  // Mutation check (§3 A4): dropping 1.9 D's two-hour bound sends here.
  const young = other({ lastTs: NOW - 95 * MIN, replyPending: true, lastUserAt: NOW - 90 * MIN })
  assert.deepEqual(promptSendDecision(facts({ sessions: [own(), young] }), NOW), { send: false, block: 'otherSession', soft: true })
  // At the bound: exactly two hours old is left behind; a second younger is not.
  const edge = (late: number): PromptSession => other({ lastTs: NOW - 3 * HOUR, replyPending: true, lastUserAt: NOW - KEEPWARM_SIBLING_LEFT_MS + late })
  assert.equal(verdict(facts({ sessions: [own(), edge(0)] })), 'send')
  assert.equal(verdict(facts({ sessions: [own(), edge(SEC)] })), 'otherSession')
  // Left behind, its permission request is no dialog of a live Claude Code: it holds nothing back (rule 6 is
  // for live sessions) — but with the start unknown none is left behind, and it does.
  assert.equal(verdict(facts({ sessions: [own(), { ...abandoned, hookWait: true }] })), 'send')
  assert.equal(verdict(facts({ target: target({ startedAt: null }), sessions: [own(), { ...abandoned, hookWait: true }] })), 'hookWait')
  // Its time unknown: not left behind.
  assert.equal(verdict(facts({ sessions: [own(), other({ replyPending: true, lastUserAt: null })] })), 'otherSession')
})

test('claude --resume: the session began before the terminal\'s claude, wrote after it — its own state decides (§3 A4)', () => {
  const resumed = own({ firstAt: START - 2 * 86_400_000 })
  assert.equal(verdict(facts({ sessions: [resumed] })), 'send')
  assert.equal(verdict(facts({ sessions: [{ ...resumed, replyPending: true, lastUserAt: NOW - MIN }] })), 'openTool')
  // Resumed a minute ago, only the user's line after the start (the prompt of the resumed session): it wrote.
  assert.equal(verdict(facts({ sessions: [own({ firstAt: START - HOUR, lastTs: START - MIN, replyPending: true, lastUserAt: START + MIN })] })), 'openTool')
})

test('a fresh claude — no session of the folder wrote since it started — is never typed into: it may show its own dialog (noSession, hard) (§3 A4)', () => {
  assert.deepEqual(promptSendDecision(facts({ sessions: [] }), NOW), { send: false, block: 'noSession', soft: false })
  assert.equal(verdict(facts({ sessions: [other()] })), 'noSession')
  // A session whose newest line is exactly at the start did not write after it.
  assert.equal(verdict(facts({ sessions: [own({ lastTs: START, lastUserAt: START })] })), 'noSession')
})

test('Codex asks first whatever the sessions say; its facts are never read (§3 A4, §0a.5)', () => {
  for (const sessions of [[], [own({ hookWait: true })], [own({ replyPending: true })], [other()]]) {
    assert.deepEqual(promptSendDecision(facts({ target: target({ kind: 'codex', startedAt: null, projectDir: null }), sessions }), NOW),
      { send: false, block: 'codex', soft: true })
  }
  // The rules before it still hold for Codex.
  assert.equal(verdict(facts({ trusted: false, target: target({ kind: 'codex' }) })), 'restricted')
  assert.equal(verdict(facts({ settled: false, target: target({ kind: 'codex' }) })), 'reading')
})

test('an unknown start asks first — reading startedAt null as "every session is its own" would send (§3 A4)', () => {
  // Mutation check (§3 A4): reading `startedAt: null` as "every session is its own" sends here.
  assert.deepEqual(promptSendDecision(facts({ target: target({ startedAt: null }), sessions: [own()] }), NOW), { send: false, block: 'unknownStart', soft: true })
  assert.equal(verdict(facts({ target: target({ startedAt: Number.NaN }) })), 'unknownStart')
})

test('a second Claude Code of the folder that wrote after this terminal\'s claude started counts as its own — its state decides (the known limit of §3 A4)', () => {
  const second = own({ sessionId: OTHER, firstAt: START + 10 * MIN, lastTs: NOW - 2 * MIN, replyPending: true, lastUserAt: NOW - MIN })
  assert.equal(verdict(facts({ sessions: [own(), second] })), 'openTool')
  assert.equal(verdict(facts({ sessions: [own(), { ...second, replyPending: false }] })), 'send')
})

test('every fact is taken strictly: a flag or a time of another shape never lets a prompt go where the exact value holds it', () => {
  const odd = (o: Record<string, unknown>): PromptTargetFacts => ({ ...facts(), ...o }) as unknown as PromptTargetFacts
  assert.equal(verdict(odd({ trusted: 1 })), 'restricted')
  assert.equal(verdict(odd({ trusted: undefined })), 'restricted')
  assert.equal(verdict(odd({ settled: 'true' })), 'reading')
  assert.equal(verdict(odd({ target: undefined })), 'noTerminal')
  assert.equal(verdict(odd({ target: 'claude' })), 'noTerminal')
  assert.equal(verdict(odd({ target: { kind: 'bash', startedAt: START, projectDir: DIR } })), 'noTerminal')
  assert.equal(verdict(odd({ target: { kind: 'claude', startedAt: START, projectDir: '' } })), 'unknownFolder')
  assert.equal(verdict(odd({ target: { kind: 'claude', startedAt: START, projectDir: 7 } })), 'unknownFolder')
  assert.equal(verdict(odd({ target: { kind: 'claude', startedAt: '1', projectDir: DIR } })), 'unknownStart')
  const s = (o: Record<string, unknown>): PromptSession => ({ ...own(), ...o }) as unknown as PromptSession
  assert.equal(verdict(facts({ sessions: [s({ hookWait: undefined })] })), 'hookWait')
  assert.equal(verdict(facts({ sessions: [s({ hookWait: 0 })] })), 'hookWait')
  assert.equal(verdict(facts({ sessions: [s({ replyPending: undefined })] })), 'openTool')
  assert.equal(verdict(facts({ sessions: [s({ running: undefined })] })), 'agentRunning')
  assert.equal(verdict(facts({ sessions: [s({ lastTs: Number.NaN, lastUserAt: null })] })), 'noSession')
  for (const list of [undefined, null, {}, 'x']) assert.equal(verdict(odd({ sessions: list })), 'noSession', String(list))
  // A session entry of another shape among the others: not idle.
  assert.equal(verdict(odd({ sessions: [own(), null] })), 'otherSession')
  // Another session whose reply time is unknown: not idle, and not left behind.
  assert.equal(verdict(facts({ sessions: [own(), other({ lastTs: Number.NaN, lastUserAt: null })] })), 'otherSession')
  assert.equal(verdict(facts({ sessions: [own(), other({ running: undefined as unknown as boolean })] })), 'otherSession')
  // A moment that is not a time leaves nothing behind.
  assert.equal(verdict(facts({ sessions: [own(), other({ replyPending: true, lastUserAt: NOW - 3 * HOUR })] }), Number.NaN), 'otherSession')
  // Every verdict carries its flag from the one set.
  for (const f of [facts({ trusted: false }), facts({ target: target({ kind: 'codex' }) })]) {
    const v = promptSendDecision(f, NOW) as Extract<PromptVerdict, { send: false }>
    assert.equal(v.soft, PROMPT_SOFT_BLOCKS.has(v.block))
  }
})

test('promptSend.ts is pure: no vscode, no clock, no I/O; the predicates are keepWarm.ts\'s, imported, never copied', () => {
  const src = readFileSync(join(ROOT, 'src', 'promptSend.ts'), 'utf8')
  const imports = src.split('\n').filter((l) => /^import\b/.test(l))
  // 1.10 P4 (pinned and changed): the words of the blocks live here now (§4 P4, `promptBlockText`) — `t()` from
  // i18n.ts, which reads the bundle it was given and nothing else.
  assert.deepEqual(imports, [
    'import { t } from \'./i18n\'',
    'import { KeepWarmSibling, siblingLeftBehind, turnClosed } from \'./keepWarm\'',
    'import type { AgentTerminal } from \'./terminalWatch\'',
  ])
  for (const bad of ["'vscode'", 'Date.now', 'new Date', 'require(', 'process.', "from 'fs'", "from 'node:"]) {
    assert.equal(src.includes(bad), false, `promptSend.ts holds ${bad}`)
  }
  // `t()` only in the block's words.
  const words = src.slice(src.indexOf('export function promptBlockText('))
  assert.equal(src.split('t(\'').length - 1, words.split('t(\'').length - 1, 'a t() call outside promptBlockText')
  // No copy of G4's or 1.9 D's tests: neither the stop reason nor the two-hour bound is spelled out here.
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
  for (const copy of ["'end_turn'", "'tool_use'", 'KEEPWARM_SIBLING_LEFT_MS', 'KEEPWARM_IDLE_MIN_MS', "'permission'"]) {
    assert.equal(code.includes(copy), false, `promptSend.ts copies ${copy}`)
  }
})
