// SPDX-FileCopyrightText: 2026 Frederik Marx
// SPDX-License-Identifier: AGPL-3.0-or-later

import { strict as assert } from 'node:assert'
import { after, test } from 'node:test'
import * as fs from 'fs'
import * as path from 'path'
import { Aggregator } from '../src/agg'
import * as discover from '../src/discover'
import { configureRoots, findTranscripts, isClaudeSubagent, isClaudeTranscript, isCodexRollout, rootOf } from '../src/discover'
import { scan } from '../src/scan'
import { claudeLine, codexMeta, codexTokenCount, codexTurnContext, tmpDir } from './fixtures/helpers'

/** Roots are module state; whatever a test sets, the next process step must not inherit. */
after(() => { configureRoots() })

test('explicit directories: multiple roots, deduped by spelling and trailing separators', () => {
  const dir = tmpDir('disc')
  const a = path.join(dir, 'a')
  const b = path.join(dir, 'b')
  const r = configureRoots([a, `${a}${path.sep}`, ` ${a} `, b, ''], [b])
  assert.deepEqual(r.claude, [path.join(a, 'projects'), path.join(b, 'projects')])
  assert.deepEqual(r.codex, [path.join(b, 'sessions')])
  assert.deepEqual(discover.CLAUDE_ROOTS, r.claude)
  assert.deepEqual(discover.CODEX_ROOTS, r.codex)
  assert.equal(discover.CLAUDE_ROOT, r.claude[0])
  assert.equal(discover.CODEX_ROOT, r.codex[0])
})

test('a symlinked duplicate of a root counts once (realpath identity)', () => {
  const dir = tmpDir('disc')
  const real = path.join(dir, 'real')
  fs.mkdirSync(path.join(real, 'projects'), { recursive: true })
  const link = path.join(dir, 'link')
  fs.symlinkSync(real, link, 'dir')
  const r = configureRoots([real, link], [])
  assert.equal(r.claude.length, 1)
})

test('archived Codex sessions join the roots when the directory exists', () => {
  const home = tmpDir('disc')
  fs.mkdirSync(path.join(home, 'sessions'))
  let r = configureRoots([], [home])
  assert.deepEqual(r.codex, [path.join(home, 'sessions')])
  fs.mkdirSync(path.join(home, 'archived_sessions'))
  r = configureRoots([], [home])
  assert.deepEqual(r.codex, [path.join(home, 'sessions'), path.join(home, 'archived_sessions')])
})

test('environment overrides and tilde expansion drive the default roots', () => {
  const dir = tmpDir('disc')
  const saved = { claude: process.env.CLAUDE_CONFIG_DIR, codex: process.env.CODEX_HOME }
  try {
    process.env.CLAUDE_CONFIG_DIR = path.join(dir, 'cc')
    process.env.CODEX_HOME = path.join(dir, 'cx')
    const r = configureRoots()
    assert.equal(r.claude[0], path.join(dir, 'cc', 'projects'))
    assert.equal(r.codex[0], path.join(dir, 'cx', 'sessions'))
    // An explicit setting wins over the environment.
    assert.equal(configureRoots([path.join(dir, 'set')]).claude[0], path.join(dir, 'set', 'projects'))
    assert.equal(configureRoots(['~/x']).claude[0], path.join(require('os').homedir(), 'x', 'projects'))
  } finally {
    if (saved.claude === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = saved.claude
    if (saved.codex === undefined) delete process.env.CODEX_HOME
    else process.env.CODEX_HOME = saved.codex
  }
})

test('findTranscripts walks recursively, matches by name, and never follows symlinks', async () => {
  const dir = tmpDir('disc')
  const root = path.join(dir, 'projects')
  fs.mkdirSync(path.join(root, 'p', 'sub'), { recursive: true })
  fs.writeFileSync(path.join(root, 'p', 'a.jsonl'), '')
  fs.writeFileSync(path.join(root, 'p', 'sub', 'b.jsonl'), '')
  fs.writeFileSync(path.join(root, 'p', 'c.txt'), '')
  const outside = path.join(dir, 'outside')
  fs.mkdirSync(outside)
  fs.writeFileSync(path.join(outside, 'z.jsonl'), '')
  fs.symlinkSync(outside, path.join(root, 'p', 'link'), 'dir')
  fs.symlinkSync(path.join(outside, 'z.jsonl'), path.join(root, 'p', 'l.jsonl'), 'file')
  const found = await findTranscripts(root, isClaudeTranscript)
  assert.deepEqual(found, [path.join(root, 'p', 'a.jsonl'), path.join(root, 'p', 'sub', 'b.jsonl')])
  assert.deepEqual(await findTranscripts(path.join(dir, 'missing'), isClaudeTranscript), [])
})

test('name matchers and subagent detection', () => {
  assert.equal(isClaudeTranscript('x.jsonl'), true)
  assert.equal(isClaudeTranscript('x.json'), false)
  assert.equal(isCodexRollout('rollout-2026-03-10T09-00-00-abc.jsonl'), true)
  assert.equal(isCodexRollout('notes.jsonl'), false)
  assert.equal(isClaudeSubagent(path.join('r', 's', 'sess', 'subagents', 'a.jsonl')), true)
  assert.equal(isClaudeSubagent(path.join('r', 's', 'sess.jsonl')), false)
})

test('scan walks every root, passes the context through, and is incremental', async () => {
  const dir = tmpDir('scan')
  const claudeHome = path.join(dir, 'claude-home')
  const codexHome = path.join(dir, 'codex-home')
  const T0 = Date.UTC(2026, 2, 10, 9, 0)
  const slugDir = path.join(claudeHome, 'projects', '-home-tester-proj-alpha')
  const main = path.join(slugDir, 'sess-0001.jsonl')
  const sub = path.join(slugDir, 'sess-0001', 'subagents', 'agent-a1.jsonl')
  fs.mkdirSync(path.dirname(sub), { recursive: true })
  fs.writeFileSync(main, [
    claudeLine({ id: 'm1', ts: T0, usage: { input: 10, output: 5 }, final: true }),
    claudeLine({ id: 'm2', ts: T0 + 60_000, usage: { input: 20, output: 5 }, final: true }),
  ].map((l) => `${l}\n`).join(''))
  fs.writeFileSync(sub, `${claudeLine({ id: 's1', ts: T0 + 1000, sessionId: null, usage: { input: 7 }, final: true })}\n`)
  const archived = path.join(codexHome, 'archived_sessions', '2026', '03', '10')
  fs.mkdirSync(path.join(codexHome, 'sessions'), { recursive: true })
  fs.mkdirSync(archived, { recursive: true })
  const rollout = path.join(archived, 'rollout-2026-03-10T09-00-00-thread-0001.jsonl')
  fs.writeFileSync(rollout, [
    codexMeta({ ts: T0, id: 'thread-0001' }),
    codexTurnContext(T0, 'gpt-5.4'),
    codexTokenCount({ ts: T0 + 5000, total: { input: 80, output: 20, total: 100 } }),
  ].map((l) => `${l}\n`).join(''))
  // Decoys: a stray file outside every root, and a non-transcript inside one.
  fs.writeFileSync(path.join(dir, 'stray.jsonl'), `${claudeLine({ id: 'x', ts: T0, usage: { input: 999 } })}\n`)
  fs.writeFileSync(path.join(slugDir, 'notes.txt'), 'not a transcript')

  configureRoots([claudeHome], [codexHome])
  const agg = new Aggregator()
  const progress: number[] = []
  const counted = await scan(agg, {
    ctx: { attribution: 'session', projectSalt: 'salt', hashProjects: false },
    onProgress: (p) => progress.push(p.done),
  })
  assert.equal(counted, 4)
  assert.deepEqual(progress, [1, 2, 3])
  assert.deepEqual([...agg.cursors.keys()].sort(), [main, sub, rollout].sort())
  for (const cur of agg.cursors.values()) {
    assert.equal(typeof cur.mtime, 'number')
    assert.equal(cur.offset, cur.size)
  }
  const bySource = new Map(agg.all().map((b) => [`${b.source}:${b.isSub}`, b]))
  assert.equal(bySource.get('claude:false')!.input, 30)
  assert.equal(bySource.get('claude:true')!.input, 7)
  assert.equal(bySource.get('codex:false')!.input, 80)
  const sessions = new Map(agg.sessions().map((s) => [s.sessionId, s]))
  assert.equal(sessions.get('agent-a1')!.parent, 'sess-0001')
  assert.equal(sessions.get('agent-a1')!.isSub, true)
  assert.equal(sessions.get('sess-0001')!.project, 'proj-alpha')
  assert.equal(sessions.get('thread-0001')!.project, 'proj-beta')
  assert.equal(agg.attribution, 'session')

  // Nothing changed: nothing counted, and the pre-filter leaves the cursors as they were.
  const before = JSON.stringify([...agg.cursors.values()])
  assert.equal(await scan(agg, { ctx: { attribution: 'session', projectSalt: 'salt', hashProjects: false } }), 0)
  assert.equal(JSON.stringify([...agg.cursors.values()]), before)

  // Appended lines are picked up; `files` narrows the sweep and ignores paths outside the roots.
  fs.appendFileSync(main, `${claudeLine({ id: 'm3', ts: T0 + 120_000, usage: { input: 1 }, final: true })}\n`)
  fs.appendFileSync(rollout, `${codexTokenCount({ ts: T0 + 9000, total: { input: 100, output: 30, total: 130 }, last: { input: 20, output: 10, total: 30 } })}\n`)
  const n = await scan(agg, { files: [main, rollout, path.join(dir, 'stray.jsonl')], ctx: { attribution: 'session', projectSalt: 'salt', hashProjects: false } })
  assert.equal(n, 2)
  assert.equal(agg.sum('2026-03-01', '2026-03-31', { zone: 'utc', dayBoundaryHour: 0, startOfWeek: 'monday', hourCycle: 'h23' }).requests, 6)
  assert.equal(agg.cursors.get(rollout)!.lastTotal, 130)

  // A rewritten rollout (new inode, shorter) is read from the start with neutral fork state.
  const tmp = path.join(archived, 'rewrite.tmp')
  fs.writeFileSync(tmp, [
    codexMeta({ ts: T0, id: 'thread-0001' }),
    codexTurnContext(T0, 'gpt-5.4'),
    codexTokenCount({ ts: T0 + 5000, total: { input: 8, output: 2, total: 10 } }),
  ].map((l) => `${l}\n`).join(''))
  fs.renameSync(tmp, rollout)
  await scan(agg, { files: [rollout] })
  assert.equal(agg.cursors.get(rollout)!.lastTotal, 10)
  assert.equal(agg.cursors.get(rollout)!.replayDone, true)

  // Without a context the scan records no sessions for a file it meets for the first time.
  const plain = new Aggregator()
  await scan(plain)
  assert.equal(plain.sessions().length, 0)
  assert.equal(plain.attribution, 'none')
})

test('rootOf classifies a path by the configured roots', () => {
  const dir = tmpDir('disc')
  const c = path.join(dir, 'c')
  const x = path.join(dir, 'x')
  configureRoots([c], [x])
  assert.deepEqual(rootOf(path.join(c, 'projects', 'p', 'a.jsonl')), { source: 'claude', root: path.join(c, 'projects') })
  assert.deepEqual(rootOf(path.join(x, 'sessions', '2026', 'r.jsonl')), { source: 'codex', root: path.join(x, 'sessions') })
  assert.equal(rootOf(path.join(c, 'projectsX', 'a.jsonl')), null)
  assert.equal(rootOf(path.join(dir, 'elsewhere.jsonl')), null)
})
