// SPDX-FileCopyrightText: 2026 Frederik Marx
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * 1.10 P2 (spec §3 A3 rules 1–2 and test 1, §0a.3 with its leak test, §2.2): the window's one terminal
 * watch against fake terminals — the Codex command pattern, which program an open execution runs, the
 * candidates of the prompt tool (a Claude Code or Codex terminal by its execution, or by the shell VS Code
 * reports and the folder the shell integration reports), the listening rule (two users, nothing held
 * when none wants it), the change event, and that nothing of a terminal's command line or folder reaches
 * an output. The keep-warm side of the watch (G7, G8) is held by keepWarmHost.test.ts, unchanged.
 *
 * Every terminal, execution and window is a fake of test/helpers/fakeVscode.ts; every time is a fixed
 * instant. No terminal is started and nothing is typed anywhere.
 */

import { strict as assert } from 'node:assert'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { test } from 'node:test'
import { projectDirName } from '../src/keepWarm'
import { AgentTerminal, CODEX_COMMAND_RE, TerminalWatch, TerminalWindow, agentExecutionKind } from '../src/terminalWatch'
import { FakeTerminal, FakeVscodeState, createFakeVscode } from './helpers/fakeVscode'
import { ROOT } from './helpers/nls'

const T0 = Date.UTC(2026, 8, 26, 9, 0, 0)
const SEC = 1000

interface Rig {
  watch: TerminalWatch
  state: FakeVscodeState
  window: TerminalWindow
  clock: { now: number }
}

/** A fake window and a watch over it — deaf until a user wants it. */
function rig(): Rig {
  const { api, state } = createFakeVscode()
  const window = (api as { window: TerminalWindow }).window
  const clock = { now: T0 }
  return { watch: new TerminalWatch(window, () => clock.now), state, window, clock }
}

/** The candidates as plain facts (the terminal by its place in the fake's list). */
function facts(r: Rig, list: AgentTerminal[] = r.watch.agentTerminals()): Array<[number, string, number | null, string | null]> {
  return list.map((c) => {
    assert.equal(r.state.terminals.indexOf(c.terminal as unknown as FakeTerminal) + 1, c.index, 'the index is not the place in window.terminals')
    return [c.index, c.kind, c.startedAt, c.projectDir]
  })
}

// ---------------------------------------------------------------------------
// The command patterns
// ---------------------------------------------------------------------------

test('CODEX_COMMAND_RE: codex, a path ending in it, codex.exe — then a space or the end; not codex-mini, npx codex, codex.cmd (§0a.3)', () => {
  for (const yes of ['codex', 'codex --api-key x', '  codex', 'CODEX', '/usr/local/bin/codex', '~/.npm/bin/codex resume',
    'C:\\Users\\u\\AppData\\codex.exe', 'codex.exe', 'codex\tchat']) {
    assert.equal(CODEX_COMMAND_RE.test(yes), true, yes)
  }
  for (const no of ['codex-mini', 'npx codex', 'codex.cmd', 'mycodex', 'codexx', 'echo codex', 'bash -c codex', '', 'claude']) {
    assert.equal(CODEX_COMMAND_RE.test(no), false, no)
  }
  assert.equal(CODEX_COMMAND_RE.flags.includes('g'), false, 'a g flag keeps state between tests')
})

test('agentExecutionKind: claude or codex at Medium or High confidence, from the command line\'s start only — else null', () => {
  const kind = (commandLine: unknown, confidence: unknown = 2): string | null =>
    agentExecutionKind({ commandLine, confidence, cwd: '/x' } as never)
  assert.equal(kind('claude'), 'claude')
  assert.equal(kind('claude --resume'), 'claude')
  assert.equal(kind('codex --api-key synthetic'), 'codex')
  assert.equal(kind('/opt/bin/codex.exe', 1), 'codex')
  assert.equal(kind('codex', 0), null, 'Low confidence')
  for (const c of [Number.NaN, -1, null, '2']) assert.equal(kind('codex', c), null, String(c))
  assert.equal(agentExecutionKind({ commandLine: 'codex', cwd: null } as never), null, 'no confidence')
  for (const line of ['claude-dev', 'npx codex', 'codex.cmd', 'bash', 'vim codex', `${' '.repeat(1100)}codex`]) assert.equal(kind(line), null, line)
  assert.equal(kind(42), null)
  assert.equal(agentExecutionKind(null as never), null)
})

// ---------------------------------------------------------------------------
// §3 A3 test 1 · the candidates
// ---------------------------------------------------------------------------

test('the candidates: claude + claude, codex + codex; a codex execution under a bash shell never; a shell reported without an execution — its reported folder; the index is the place in window.terminals (§3 A3 test 1)', () => {
  const r = rig()
  r.watch.want('prompts', true, T0)
  const s = r.state
  // 1 · Claude Code, its execution seen: its start time and folder.
  const claude = s.openTerminal({ shell: 'claude', name: 'Summary of a conversation', cwd: '/home/u/elsewhere' })
  r.clock.now = T0 + 5 * SEC
  s.startExecution(claude, { commandLine: 'claude --resume', confidence: 2, cwd: '/home/u/proj' })
  // 2 · Codex, its execution seen.
  const codex = s.openTerminal({ shell: 'codex' })
  r.clock.now = T0 + 7 * SEC
  s.startExecution(codex, { commandLine: 'codex', confidence: 1, cwd: '/home/u/proj' })
  // 3 · A codex execution in a terminal VS Code says runs bash: never.
  const bash = s.openTerminal({ shell: 'bash' })
  s.startExecution(bash, { commandLine: 'codex', cwd: '/home/u/proj' })
  // 4 · Claude Code started before the watch listened (a reload): the shell says so, the folder is the one
  // the shell integration reports.
  s.openTerminal({ shell: 'claude', cwd: '/home/u/restored' })
  // 5 · Codex the same way, without a folder reported — and one without shell integration at all.
  s.openTerminal({ shell: 'codex' })
  s.openTerminal({ shell: 'codex', integration: false })
  assert.deepEqual(facts(r), [
    [1, 'claude', T0 + 5 * SEC, '-home-u-proj'],
    [2, 'codex', T0 + 7 * SEC, '-home-u-proj'],
    [4, 'claude', null, '-home-u-restored'],
    [5, 'codex', null, null],
    [6, 'codex', null, null],
  ])
  // Never a terminal's name, its output, its creation options or its process.
  assert.equal(s.nameReads, 0)
  assert.equal(s.outputReads, 0)
  assert.equal(s.creationReads, 0)
  // The index follows window.terminals: the first one closed, every place moves up.
  s.closeTerminal(claude)
  assert.deepEqual(facts(r).map((c) => [c[0], c[1]]), [[1, 'codex'], [3, 'claude'], [4, 'codex'], [5, 'codex']])
})

test('the candidates: programs named like them, npx, a .cmd shim and Low confidence never; VS Code naming no shell lets the execution decide; of several executions the newest (§3 A3 test 1)', () => {
  const r = rig()
  r.watch.want('prompts', true, T0)
  const s = r.state
  for (const commandLine of ['claude-dev', 'npx codex', 'codex.cmd', 'npx claude']) s.startExecution(s.openTerminal(), { commandLine, cwd: '/home/u/p' })
  s.startExecution(s.openTerminal(), { commandLine: 'codex', confidence: 0, cwd: '/home/u/p' })
  assert.deepEqual(facts(r), [])
  // VS Code reports no shell (older VS Code, or not yet): the execution decides.
  const plain = s.openTerminal()
  r.clock.now = T0 + SEC
  s.startExecution(plain, { commandLine: 'codex', cwd: '/home/u/p' })
  assert.deepEqual(facts(r), [[6, 'codex', T0 + SEC, '-home-u-p']])
  // A second execution in it, newer: `claude` in another folder — the newest decides.
  r.clock.now = T0 + 9 * SEC
  const newer = s.startExecution(plain, { commandLine: 'claude', cwd: '/home/u/q' })
  assert.deepEqual(facts(r), [[6, 'claude', T0 + 9 * SEC, '-home-u-q']])
  // It ends: the older one again.
  s.endExecution(plain, newer)
  assert.deepEqual(facts(r), [[6, 'codex', T0 + SEC, '-home-u-p']])
  // VS Code names the program now: an execution of the other program no longer counts, the shell does.
  plain.setShell('claude')
  assert.deepEqual(facts(r), [[6, 'claude', null, null]])
  plain.setShell('pwsh')
  assert.deepEqual(facts(r), [])
})

test('the reported folder is read only where the watch saw no execution: an execution without a cwd gives no folder, never the shell integration\'s (§0a.3)', () => {
  const r = rig()
  r.watch.want('prompts', true, T0)
  const t = r.state.openTerminal({ shell: 'claude', cwd: '/home/u/synthetic-shell-folder' })
  r.state.startExecution(t, { commandLine: 'claude', cwd: null })
  assert.deepEqual(facts(r), [[1, 'claude', T0, null]])
  // The same terminal once that execution has ended: the shell still says claude — the reported folder.
  const r2 = rig()
  r2.watch.want('prompts', true, T0)
  const t2 = r2.state.openTerminal({ shell: 'claude', cwd: '/home/u/synthetic-shell-folder' })
  const e = r2.state.startExecution(t2, { commandLine: 'claude', cwd: null })
  r2.state.endExecution(t2, e)
  assert.deepEqual(facts(r2), [[1, 'claude', null, projectDirName('/home/u/synthetic-shell-folder')]])
})

// ---------------------------------------------------------------------------
// The listening rule (§0a.3 "Listening")
// ---------------------------------------------------------------------------

test('the listening rule: the watch subscribes to the five events while any user wants it, once; the last release drops them and everything held (§0a.3)', () => {
  const r = rig()
  const s = r.state
  // A Claude Code terminal is there before anyone wants the watch: nothing of it is looked at.
  const before = s.openTerminal({ shell: 'claude', cwd: '/home/u/p' })
  assert.equal(r.watch.isTracking(), false)
  assert.equal(s.terminalListeners(), 0)
  assert.deepEqual(r.watch.agentTerminals(), [], 'a deaf watch named a candidate')
  // Keep-warm wants it: four terminal events (and the window's focus) are subscribed to, once.
  r.watch.want('keepWarm', true, T0 + 100)
  assert.equal(r.watch.isTracking(), true)
  assert.equal(s.terminalListeners(), 4)
  assert.equal(r.watch.since(), T0 + 100)
  s.startExecution(before, { commandLine: 'claude', cwd: '/home/u/p' })
  // The prompt tool wants it too: no second subscription, the listening start stays.
  r.watch.want('prompts', true, T0 + 200)
  r.watch.want('prompts', true, T0 + 300)
  assert.equal(s.terminalListeners(), 4)
  assert.equal(r.watch.since(), T0 + 100)
  // Keep-warm leaves: the prompt tool still has it, and what it saw.
  r.watch.want('keepWarm', false, T0 + 400)
  assert.equal(r.watch.isTracking(), true)
  assert.equal(s.terminalListeners(), 4)
  assert.deepEqual(facts(r), [[1, 'claude', T0, '-home-u-p']])
  assert.equal(r.watch.claudeTerminals('-home-u-p').length, 1)
  // The prompt tool leaves: deaf, and nothing held — the execution it saw is forgotten.
  r.watch.want('prompts', false, T0 + 500)
  assert.equal(r.watch.isTracking(), false)
  assert.equal(s.terminalListeners(), 0)
  assert.deepEqual(r.watch.agentTerminals(), [])
  assert.deepEqual(r.watch.claudeTerminals('-home-u-p'), [])
  // Wanted again: the execution started while it was deaf is not known — only the shell says claude.
  r.watch.want('prompts', true, T0 + 600)
  assert.equal(r.watch.since(), T0 + 600)
  assert.deepEqual(facts(r), [[1, 'claude', null, '-home-u-p']])
  // A want that is not exactly `true` is a release.
  r.watch.want('prompts', 'yes' as unknown as boolean, T0 + 700)
  assert.equal(r.watch.isTracking(), false)
  // Disposed: deaf for good.
  r.watch.want('keepWarm', true, T0 + 800)
  r.watch.dispose()
  assert.equal(s.terminalListeners(), 0)
  r.watch.want('prompts', true, T0 + 900)
  assert.equal(r.watch.isTracking(), false, 'a disposed watch listened again')
  assert.equal(s.terminalListeners(), 0)
})

test('onDidChange: a start, an end, a closed terminal and a new active terminal fire it while the watch listens; the window\'s focus and a deaf watch do not', () => {
  const r = rig()
  const s = r.state
  let fired = 0
  const self = { n: 0 }
  const sub = r.watch.onDidChange(function (this: { n: number }) { this.n++; fired++ }, self)
  const t = s.openTerminal({ shell: 'claude' })
  s.startExecution(t, { commandLine: 'claude' })
  assert.equal(fired, 0, 'a deaf watch fired')
  r.watch.want('prompts', true, T0)
  const e = s.startExecution(t, { commandLine: 'claude' })
  assert.equal(fired, 1)
  s.endExecution(t, e)
  assert.equal(fired, 2)
  s.setActiveTerminal(t)
  assert.equal(fired, 3)
  s.fireWindowState(false)
  assert.equal(fired, 3, 'the focus changes no target')
  s.closeTerminal(t)
  assert.equal(fired >= 4, true)
  assert.equal(self.n, fired, 'thisArgs is not the listener\'s this')
  const disposables: Array<{ dispose(): void }> = []
  let second = 0
  r.watch.onDidChange(() => { second++ }, undefined, disposables as never)
  assert.equal(disposables.length, 1)
  sub.dispose()
  const before = fired
  s.startExecution(s.openTerminal(), { commandLine: 'codex' })
  assert.equal(fired, before, 'a disposed listener was called')
  assert.equal(second, 1)
})

test('G8 on the watch: a window that began listening after the reply cannot tell; the focused window\'s active terminal is touched; one left before the reply is not (moved from the keep-warm host)', () => {
  const r = rig()
  const s = r.state
  const t = s.openTerminal({ shell: 'claude' })
  s.setActiveTerminal(t)
  r.watch.want('keepWarm', true, T0)
  assert.equal(r.watch.touchedSince(t as never, T0 - SEC), 'unknown')
  assert.equal(r.watch.touchedSince(t as never, Number.NaN), 'unknown')
  assert.equal(r.watch.touchedSince(t as never, T0 + SEC), 'yes', 'active in the focused window')
  r.clock.now = T0 + 10 * SEC
  s.fireWindowState(false)
  assert.equal(r.watch.touchedSince(t as never, T0 + 5 * SEC), 'yes', 'left after the reply')
  assert.equal(r.watch.touchedSince(t as never, T0 + 20 * SEC), 'no', 'left before the reply')
})

// ---------------------------------------------------------------------------
// §0a.3 · the leak test
// ---------------------------------------------------------------------------

test('a Codex terminal with a secret on its command line, in a named folder, is a candidate — and neither string, nor the folder, reaches the console, the output channel, a status-bar item or a message; no name, output or creation option is read (§0a.3 leak test)', () => {
  const SECRET_LINE = 'codex --api-key synthetic-secret-123'
  const SECRET_CWD = '/home/u/synthetic-project-789'
  const printed: string[] = []
  const methods = ['log', 'info', 'warn', 'error', 'debug', 'trace'] as const
  const saved = methods.map((m) => console[m])
  for (const m of methods) console[m] = (...args: unknown[]): void => { printed.push(args.map(String).join(' ')) }
  let got: AgentTerminal[]
  const r = rig()
  try {
    const s = r.state
    // One Codex terminal the watch saw start, one it did not (started before it listened): the shell and
    // the reported folder speak for that one.
    const early = s.openTerminal({ shell: 'codex', name: 'SYNTHETIC-CONVERSATION-SUMMARY', cwd: SECRET_CWD })
    s.startExecution(early, { commandLine: SECRET_LINE, cwd: SECRET_CWD })
    r.watch.want('prompts', true, T0)
    const seen = s.openTerminal({ name: 'SYNTHETIC-CONVERSATION-SUMMARY' })
    s.startExecution(seen, { commandLine: SECRET_LINE, confidence: 2, cwd: SECRET_CWD })
    got = r.watch.agentTerminals()
    r.watch.claudeTerminals(projectDirName(SECRET_CWD))
    r.watch.touchedSince(seen as never, T0)
    r.watch.want('prompts', false, T0 + SEC)
    r.watch.dispose()
  } finally {
    methods.forEach((m, i) => { console[m] = saved[i] })
  }
  assert.deepEqual(got.map((c) => [c.index, c.kind, c.startedAt, c.projectDir]), [
    [1, 'codex', null, '-home-u-synthetic-project-789'],
    [2, 'codex', T0, '-home-u-synthetic-project-789'],
  ])
  const outputs: Array<[string, string]> = [
    ['console', printed.join('\n')],
    ['output channel', JSON.stringify(r.state.log)],
    ['status bar', JSON.stringify(r.state.items.map((i) => ({ ...i })))],
    ['messages', JSON.stringify(r.state.messages)],
    ['clipboard', JSON.stringify(r.state.clipboard)],
    ['typed', JSON.stringify(r.state.sent.map((x) => x.text))],
  ]
  for (const [what, text] of outputs) {
    for (const secret of [SECRET_LINE, 'synthetic-secret-123', '--api-key', SECRET_CWD, 'synthetic-project-789', 'SYNTHETIC-CONVERSATION-SUMMARY']) {
      assert.equal(text.includes(secret), false, `the ${what} holds ${secret}`)
    }
  }
  assert.equal(printed.length, 0, 'the watch printed something')
  assert.equal(r.state.nameReads, 0, 'a terminal\'s name was read')
  assert.equal(r.state.outputReads, 0, 'an execution\'s output was read')
  assert.equal(r.state.creationReads, 0, 'a terminal\'s creation options or process were read')
  // Mutation check (§0a.3): logging the cwd in agentTerminals puts it on the console and fails here.
})

test('terminalWatch.ts loads no vscode at run time and keeps nothing of a terminal beyond references: no string of a command line or a folder is stored in a field', () => {
  const src = fs.readFileSync(path.join(ROOT, 'src', 'terminalWatch.ts'), 'utf8')
  const imports = src.split('\n').filter((l) => /^import\b/.test(l))
  assert.ok(imports.some((l) => l === 'import type * as vscode from \'vscode\''), 'vscode is not a type-only import')
  assert.equal(imports.some((l) => /from 'vscode'/.test(l) && !/^import type/.test(l)), false)
  // The fields the class keeps: users, flags, times, references to terminals and executions, listeners.
  const fields = [...src.matchAll(/^ {2}private (?:readonly )?(\w+)/gm)].map((m) => m[1])
  assert.deepEqual(fields.filter((f) => !/^(startTracking|stopTracking|closeTouch|changed)$/.test(f)).sort(),
    ['active', 'changeListeners', 'clock', 'disposed', 'focused', 'open', 'startedListening', 'subs', 'touchedAt', 'users', 'window'].sort())
  assert.match(src, /private open = new Map<vscode\.Terminal, Map<vscode\.TerminalShellExecution, number>>\(\)/)
})
