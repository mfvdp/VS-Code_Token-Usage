// SPDX-FileCopyrightText: 2026 Frederik Marx
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * 1.14 P4 (§3 A1, §0a.1–§0a.3): what a project is — the key per folder, the same in Claude Code and Codex, the
 * folder's name only under basename and held to §0's alphabet, and what every view prints for a key.
 */

import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import * as path from 'path'
import { Aggregator, IngestContext, claudePlacement } from '../src/agg'
import { configureRoots } from '../src/discover'
import {
  OTHER_PROJECTS, PROJECT_CAP, PROJECT_KEY_RE, PROJECT_NAME_MAX_CHARS, UNATTRIBUTED, claudeProjectSegment, cleanProjectName, isProjectKey,
  projectKeyOf, projectLabel, slugOf,
} from '../src/project'
import { Cursor } from '../src/types'
import { CLAUDE_ROOT, claudeLine, codexMeta, codexTokenCount, codexTurnContext, ctxFor } from './fixtures/helpers'

const T0 = Date.UTC(2026, 8, 29, 9, 15, 0)
const SALT = 'salt-1'

test('slugOf is Claude Code\'s directory rule: every character outside [A-Za-z0-9] becomes -', () => {
  const table: Array<[string, string]> = [
    ['/home/fm/Claude/VS-Code_Tokens', '-home-fm-Claude-VS-Code-Tokens'],
    // The measuring machine's second directory ([read 2026-09-29]): a folder below ~/.claude — the dot a dash too.
    ['/home/fm/.claude/projects/-home-fm-Claude-VS-Code-Tokens/research/real-window/vsc-ws',
      '-home-fm--claude-projects--home-fm-Claude-VS-Code-Tokens-research-real-window-vsc-ws'],
    ['C:\\Users\\u\\proj', 'C--Users-u-proj'],
    ['/home/u/Büro', '-home-u-B-ro'],
    ['/home/u/token-pace', '-home-u-token-pace'],
  ]
  for (const [dir, slug] of table) assert.equal(slugOf(dir), slug, dir)
})

test('projectKeyOf: twelve hex digits of the tagged hash of salt and folder — pinned, and each part changes it', () => {
  const key = projectKeyOf(SALT, '-home-tester-proj-alpha')
  // sha256("tp-project-1\0salt-1\0-home-tester-proj-alpha"): the domain tag and the order of the parts are held.
  assert.equal(key, '11ab00fe63c3')
  assert.match(key, PROJECT_KEY_RE)
  assert.notEqual(key, 'e1bb15975e68', 'the key without its domain tag (1.0–1.13\'s salt + path)')
  assert.notEqual(projectKeyOf('salt-2', '-home-tester-proj-alpha'), key, 'another salt, another key')
  assert.notEqual(projectKeyOf(SALT, '-home-tester-proj-beta'), key, 'another folder, another key')
  assert.equal(projectKeyOf('', '-home-tester-proj-alpha'), UNATTRIBUTED)
  assert.equal(projectKeyOf(SALT, ''), UNATTRIBUTED)
  for (let i = 0; i < 50; i++) assert.match(projectKeyOf(`s${i}`, `-f${i}`), /^[0-9a-f]{12}$/)
  assert.equal(isProjectKey(key), true)
  assert.equal(isProjectKey(''), true)
  assert.equal(isProjectKey(OTHER_PROJECTS), true)
  for (const bad of ['0123456789abc', 'ABCDEF012345', 'proj-alpha', 'p:0123456789ab', ' 0123456789ab', null, 12]) {
    assert.equal(isProjectKey(bad), false, String(bad))
  }
  assert.equal(PROJECT_CAP, 200)
})

test('cleanProjectName holds a folder\'s name to §0\'s alphabet: _ per character, runs folded, 64 at most', () => {
  const table: Array<[unknown, string | null]> = [
    ['token-pace', 'token-pace'],
    ['Büro-App', 'B_ro-App'],
    ['Mein Projekt', 'Mein_Projekt'],
    ['a…b', 'a_b'],
    ['x\u202ey', 'x_y'],
    ['<b>bold</b>', '_b_bold_b_'],
    ['v1.2@host:9', 'v1.2@host:9'],
    ['a  __  b', 'a_b'],
    // A character outside the BMP is one character, one '_'.
    ['app😀x', 'app_x'],
    // NFC first: a decomposed ü is one character too.
    ['Bu\u0308ro', 'B_ro'],
    ['', null],
    ['日本語', null],
    ['___', null],
    [42, null],
    [null, null],
  ]
  for (const [input, want] of table) assert.equal(cleanProjectName(input), want, JSON.stringify(input))
  const long = 'x'.repeat(90)
  assert.equal(cleanProjectName(long), 'x'.repeat(PROJECT_NAME_MAX_CHARS))
  assert.equal(PROJECT_NAME_MAX_CHARS, 64)
})

test('projectLabel: the name under basename when the table has one, else p: and the key; the two words of their own', () => {
  const key = projectKeyOf(SALT, '-home-u-token-pace')
  const labels = { [key]: { lastTs: T0, name: 'token-pace' }, '0123456789ab': { lastTs: T0 } }
  assert.equal(projectLabel(key, labels, true), 'token-pace')
  assert.equal(projectLabel(key, labels, false), `p:${key}`)
  assert.equal(projectLabel('0123456789ab', labels, true), 'p:0123456789ab')
  assert.equal(projectLabel('fedcba987654', labels, true), 'p:fedcba987654')
  assert.equal(projectLabel(UNATTRIBUTED, labels, true), '(no project)')
  assert.equal(projectLabel(OTHER_PROJECTS, labels, true), 'other projects')
  // An inherited property is no label.
  assert.equal(projectLabel('toString', {}, true), 'p:toString')
})

const claudeFile = (slug: string, name = 'sess-0001.jsonl'): string => path.join(CLAUDE_ROOT, slug, name)
const on = (over: Partial<IngestContext> = {}): IngestContext => ctxFor({ attribution: 'project', projectSalt: SALT, ...over })
const cursor = (): Cursor => ({ offset: 0, size: 0, ino: 1, dev: 1 })

test('§3 A1 rule 3: a Codex session and a Claude Code session started in one folder share one key', () => {
  const agg = new Aggregator()
  agg.addClaudeLine(claudeLine({ id: 'c1', ts: T0, cwd: '/home/u/proj', usage: { input: 10 } }),
    on({ file: claudeFile('-home-u-proj') }))
  const cur = cursor()
  const codexCtx = on({ file: '/virtual/codex/sessions/2026/09/29/rollout-a.jsonl' })
  agg.addCodexLine(codexMeta({ ts: T0, id: 'thread-a', cwd: '/home/u/proj' }), cur, codexCtx)
  agg.addCodexLine(codexTurnContext(T0, 'gpt-5.4'), cur, codexCtx)
  agg.addCodexLine(codexTokenCount({ ts: T0 + 1000, total: { input: 20, total: 20 } }), cur, codexCtx)
  const key = projectKeyOf(SALT, '-home-u-proj')
  assert.deepEqual([...new Set(agg.all().map((b) => b.project))], [key])
  assert.deepEqual(agg.sessions().map((s) => [s.source, s.project]), [['claude', key], ['codex', key]])
  assert.deepEqual(Object.keys(agg.projects()), [key])
})

test('§3 A1 rule 3: a folder renamed is a new project — the old one keeps its buckets and its last activity', () => {
  const agg = new Aggregator()
  agg.addClaudeLine(claudeLine({ id: 'old', ts: T0, cwd: '/home/u/proj', usage: { input: 10 } }), on({ file: claudeFile('-home-u-proj') }))
  const before = agg.all().map((b) => ({ ...b }))
  agg.addClaudeLine(claudeLine({ id: 'new', ts: T0 + 3_600_000, cwd: '/home/u/proj-renamed', usage: { input: 7 } }),
    on({ file: claudeFile('-home-u-proj-renamed', 'sess-0002.jsonl') }))
  const oldKey = projectKeyOf(SALT, '-home-u-proj')
  const newKey = projectKeyOf(SALT, '-home-u-proj-renamed')
  assert.notEqual(oldKey, newKey)
  assert.deepEqual(agg.all().filter((b) => b.project === oldKey), before)
  assert.equal(agg.projects()[oldKey].lastTs, T0)
  assert.equal(agg.projects()[newKey].lastTs, T0 + 3_600_000)
})

test('§3 A1 rule 6: a subagent that worked in a worktree counts to its session\'s folder, and names nothing', () => {
  const agg = new Aggregator()
  const sub = path.join(CLAUDE_ROOT, '-home-u-proj', 'sess-0001', 'subagents', 'agent-a1.jsonl')
  agg.addClaudeLine(claudeLine({ id: 's1', ts: T0, cwd: '/home/u/proj/.claude/worktrees/x', usage: { input: 3 } }),
    on({ file: sub, isSub: true, hashProjects: false }))
  const key = projectKeyOf(SALT, '-home-u-proj')
  assert.equal(agg.all()[0].project, key)
  assert.equal(agg.sessions()[0].project, key)
  assert.deepEqual(agg.projects(), { [key]: { lastTs: T0 } })
  assert.equal(JSON.stringify(agg.toSnapshot()).includes('"x"'), false)
})

test('§3 A1 rule 4: names — a main line whose cwd is the folder names it once; a mismatch, a subagent and hash never', () => {
  const key = projectKeyOf(SALT, '-home-u-proj')
  const main = claudeFile('-home-u-proj')
  const names = on({ file: main, hashProjects: false })
  const agg = new Aggregator()
  // A main line whose cwd slugs elsewhere (a subdirectory the session moved to): no name.
  agg.addClaudeLine(claudeLine({ id: 'a', ts: T0, cwd: '/home/u/proj/sub', usage: { input: 1 } }), names)
  assert.equal(agg.projects()[key].name, undefined)
  agg.addClaudeLine(claudeLine({ id: 'b', ts: T0 + 1, cwd: '/home/u/proj', usage: { input: 1 } }), names)
  assert.equal(agg.projects()[key].name, 'proj')
  // The first name is kept: a later line naming the folder otherwise (a symlink's path slugging the same) changes nothing.
  agg.addClaudeLine(claudeLine({ id: 'c', ts: T0 + 2, cwd: '/home/u.proj', usage: { input: 1 } }), names)
  assert.equal(agg.projects()[key].name, 'proj')
  // hashProjects: no name read at all.
  const hashed = new Aggregator()
  hashed.addClaudeLine(claudeLine({ id: 'b', ts: T0, cwd: '/home/u/proj', usage: { input: 1 } }), on({ file: main, hashProjects: true }))
  assert.equal(hashed.projects()[key].name, undefined)
  // Codex under basename names the folder by its cwd; under hash it does not.
  for (const hashProjects of [false, true]) {
    const x = new Aggregator()
    x.addCodexLine(codexMeta({ ts: T0, cwd: '/home/u/Büro-App' }), cursor(), on({ file: '/virtual/codex/r.jsonl', hashProjects }))
    const k = projectKeyOf(SALT, '-home-u-B-ro-App')
    assert.equal(x.projects()[k].name, hashProjects ? undefined : 'B_ro-App', String(hashProjects))
  }
})

test('§0a.2 rule 4: under hash the Claude reader does not look at the line\'s cwd — a cwd that throws is ingested without error', () => {
  const line = JSON.parse(claudeLine({ id: 'g', ts: T0, usage: { input: 5 } })) as Record<string, unknown>
  delete line.cwd
  Object.defineProperty(line, 'cwd', { enumerable: true, get() { throw new Error('the cwd was read') } })
  const respond = (agg: Aggregator, ctx: IngestContext): boolean =>
    (agg as unknown as { claudeResponse(d: unknown, c: IngestContext): boolean }).claudeResponse(line, ctx)
  const hashed = new Aggregator()
  assert.equal(respond(hashed, on({ hashProjects: true })), true)
  assert.equal(hashed.all()[0].input, 5)
  // With names on the reader reads it — the getter is the one the line has.
  assert.throws(() => respond(new Aggregator(), on({ hashProjects: false })), /the cwd was read/)
  // And with attribution off nothing of it is read either.
  assert.equal(respond(new Aggregator(), ctxFor({ attribution: 'none', projectSalt: SALT })), true)
})

test('§0a.4: a session id outside [A-Za-z0-9_-] or longer than 64 characters falls back to the file name', () => {
  for (const sessionId of ['has space', 'x'.repeat(70), '../escape', 'good-id_0']) {
    const agg = new Aggregator()
    agg.addClaudeLine(claudeLine({ id: 'm', ts: T0, sessionId, usage: { input: 1 } }), on({ file: claudeFile('-home-u-proj', 'file-id.jsonl') }))
    assert.equal(agg.sessions()[0].sessionId, sessionId === 'good-id_0' ? sessionId : 'file-id', sessionId)
  }
  const x = new Aggregator()
  x.addCodexLine(codexMeta({ ts: T0, id: 'bad id' }), cursor(), on({ file: '/virtual/codex/rollout-z.jsonl' }))
  assert.equal(x.sessions()[0].sessionId, 'rollout-z')
})

// 1.14 fix pass after Review 2 (F2): the key segment is the first below the transcripts root, at any depth — the real-window
// fixture lay three levels down in this repository's own directory and was keyed, and under basename named, by its own.
test('§0a.1 (Review 2 F2): a .jsonl three levels down in a project directory keys to the segment directly below the root — never its own directory, and it names the project only by a cwd that slugs to that segment', () => {
  const { claude } = configureRoots([path.join(path.sep, 'virtual', 'f2-home')])
  try {
    const root = claude[0]
    const top = '-home-u-proj'
    // Claude Code's layout: the main transcript, a subagent, a workflow agent — the segment is the session's directory.
    assert.equal(claudeProjectSegment(root, path.join(root, top, 'sess-1.jsonl')), top)
    assert.equal(claudeProjectSegment(root, path.join(root, top, 'sess-1', 'subagents', 'agent-a1.jsonl')), top)
    assert.equal(claudeProjectSegment(root, path.join(root, top, 'sess-1', 'subagents', 'workflows', 'wf_1', 'agent-a2.jsonl')), top)
    // No directory names a file directly in the root or outside it.
    assert.equal(claudeProjectSegment(root, path.join(root, 'loose.jsonl')), '')
    assert.equal(claudeProjectSegment(root, path.join(path.dirname(root), 'elsewhere', top, 'sess-1.jsonl')), '')
    // Three levels down, in a directory named as another folder's slug (the fixture's -home-t-token-pace), with a cwd that slugs to it.
    const inner = '-home-t-token-pace'
    const nested = path.join(root, top, 'research', 'fixture', inner, 'sess-2.jsonl')
    assert.equal(claudePlacement(nested, false).slug, top)
    const agg = new Aggregator()
    const names = on({ file: nested, hashProjects: false })
    agg.addClaudeLine(claudeLine({ id: 'n1', ts: T0, cwd: '/home/t/token-pace', usage: { input: 4 } }), names)
    const key = projectKeyOf(SALT, top)
    assert.deepEqual(agg.all().map((b) => b.project), [key])
    assert.equal(agg.sessions()[0].project, key)
    assert.deepEqual(Object.keys(agg.projects()), [key], 'the inner directory is a project of its own')
    assert.equal(agg.projects()[key].name, undefined, 'the inner directory named the project')
    // A subagent below the nested directory keys to the same segment.
    const sub = path.join(root, top, 'research', 'fixture', inner, 'sess-2', 'subagents', 'agent-a3.jsonl')
    agg.addClaudeLine(claudeLine({ id: 'n2', ts: T0 + 1, cwd: '/home/t/token-pace', usage: { input: 2 } }), on({ file: sub, isSub: true, hashProjects: false }))
    assert.deepEqual([...new Set(agg.all().map((b) => b.project))], [key])
    // The name rule is unchanged: a main line whose cwd slugs to the segment names it.
    agg.addClaudeLine(claudeLine({ id: 'n3', ts: T0 + 2, cwd: '/home/u/proj', usage: { input: 1 } }), names)
    assert.equal(agg.projects()[key].name, 'proj')
  } finally {
    configureRoots()
  }
})
