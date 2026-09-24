// SPDX-FileCopyrightText: 2026 Frederik Marx
// SPDX-License-Identifier: AGPL-3.0-or-later

import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { Aggregator, billable, localDay } from '../src/agg'
import { freshInput } from '../src/stats'
import { hourIndex, TimeConfig } from '../src/time'
import { Bucket, MainRec, Snapshot, Source, ToolStat, bucketKey, STATE_VERSION } from '../src/types'
import { CLAUDE_MAIN, CLAUDE_SUB, claudeLine, compactSummaryLine, ctxFor, iso, promptLine, toolResultLine } from './fixtures/helpers'

const utc: TimeConfig = { zone: 'utc', dayBoundaryHour: 0, startOfWeek: 'monday', hourCycle: 'h23' }
const T0 = Date.UTC(2026, 2, 10, 9, 15, 0)
const CTX = ctxFor()

test('streaming snapshots of one message.id count once, with the per-field maximum', () => {
  const agg = new Aggregator()
  const base = { input: 100, cacheWrite: 2000, cacheRead: 5000 }
  assert.equal(agg.addClaudeLine(claudeLine({ id: 'msg_a', ts: T0, usage: { ...base, output: 5 } }), CTX), true)
  assert.equal(agg.addClaudeLine(claudeLine({ id: 'msg_a', ts: T0 + 400, usage: { ...base, output: 20 } }), CTX), true)
  assert.equal(agg.addClaudeLine(claudeLine({ id: 'msg_a', ts: T0 + 900, usage: { ...base, output: 40 }, final: true }), CTX), true)
  const all = agg.all()
  assert.equal(all.length, 1)
  const b = all[0]
  assert.equal(b.input, 100)
  assert.equal(b.cacheWrite, 2000)
  assert.equal(b.cacheRead, 5000)
  assert.equal(b.output, 40)
  assert.equal(b.requests, 1)
  assert.equal(b.outputFinal, 1)
  // A snapshot that shrinks (never seen in practice) must not subtract.
  agg.addClaudeLine(claudeLine({ id: 'msg_a', ts: T0 + 950, usage: { ...base, output: 30 } }), CTX)
  assert.equal(agg.all()[0].output, 40)
})

test('a late line for an earlier message lands on that message, not on the latest', () => {
  const agg = new Aggregator()
  agg.addClaudeLine(claudeLine({ id: 'msg_a', ts: T0, usage: { input: 10, output: 5 } }), CTX)
  agg.addClaudeLine(claudeLine({ id: 'msg_b', ts: T0 + 60_000, model: 'claude-sonnet-4-6', usage: { input: 7, output: 3 } }), CTX)
  agg.addClaudeLine(claudeLine({ id: 'msg_a', ts: T0 + 61_000, usage: { input: 10, output: 60 }, final: true }), CTX)
  const byModel = new Map(agg.all().map((b) => [b.model, b]))
  assert.equal(byModel.get('claude-opus-4-6')!.output, 60)
  assert.equal(byModel.get('claude-opus-4-6')!.requests, 1)
  assert.equal(byModel.get('claude-opus-4-6')!.outputFinal, 1)
  assert.equal(byModel.get('claude-sonnet-4-6')!.output, 3)
  assert.equal(agg.sum('2026-03-10', '2026-03-10', utc).requests, 2)
})

test('placeholder, error, non-assistant and malformed lines are not counted', () => {
  const agg = new Aggregator()
  assert.equal(agg.addClaudeLine(claudeLine({ id: 'msg_s', ts: T0, synthetic: true, usage: { output: 9 } }), CTX), false)
  assert.equal(agg.addClaudeLine(claudeLine({ id: 'msg_e', ts: T0, error: true, usage: { output: 9 } }), CTX), false)
  assert.equal(agg.addClaudeLine(claudeLine({ id: 'msg_u', ts: T0, type: 'user', usage: { output: 9 } }), CTX), false)
  assert.equal(agg.addClaudeLine('{"type":"assistant","message":{"id":"x"}}', CTX), false)
  assert.equal(agg.addClaudeLine('{"usage": not json', CTX), false)
  assert.equal(agg.addClaudeLine('', CTX), false)
  assert.equal(agg.all().length, 0)
  assert.equal(agg.firstIngest, null)
})

test('tier, server tools and thinking tokens are captured; thinking is not added to output', () => {
  const agg = new Aggregator()
  agg.addClaudeLine(claudeLine({
    id: 'msg_f', ts: T0,
    usage: { input: 50, output: 100, thinking: 10, webSearch: 2, webFetch: 1, speed: 'fast', geo: 'us' },
  }), CTX)
  // Thinking grows with the stream like output; the maximum wins, never the sum.
  agg.addClaudeLine(claudeLine({
    id: 'msg_f', ts: T0 + 300,
    usage: { input: 50, output: 140, thinking: 30, webSearch: 2, webFetch: 1, speed: 'fast', geo: 'us' },
  }), CTX)
  const b = agg.all()[0]
  assert.equal(b.tier, 'fast-us')
  assert.equal(b.output, 140)
  assert.equal(b.reasoning, 30)
  assert.equal(b.webSearch, 2)
  assert.equal(b.webFetch, 1)
  assert.equal(billable(b), 50 + 140)

  const tiers = new Aggregator()
  tiers.addClaudeLine(claudeLine({ id: 'm1', ts: T0, usage: { input: 1, speed: 'fast', geo: 'not_available' } }), CTX)
  tiers.addClaudeLine(claudeLine({ id: 'm2', ts: T0, usage: { input: 1, speed: null, geo: 'us' } }), CTX)
  tiers.addClaudeLine(claudeLine({ id: 'm3', ts: T0, usage: { input: 1, speed: 'standard', geo: null } }), CTX)
  assert.deepEqual(tiers.all().map((b) => b.tier).sort(), ['fast', 'standard', 'us'])
})

test('buckets are keyed by UTC hour and carry the machine-zone day', () => {
  const agg = new Aggregator()
  const ts = Date.UTC(2026, 2, 10, 23, 30)
  agg.addClaudeLine(claudeLine({ id: 'msg_h', ts, usage: { input: 1 } }), CTX)
  const b = agg.all()[0]
  assert.equal(b.res, 'h')
  assert.equal(b.hour, hourIndex(ts))
  assert.equal(b.day, localDay(ts))
  assert.equal(bucketKey(b), `claude|h|${hourIndex(ts)}|claude-opus-4-6|0|standard`)
  // Two hours apart → two buckets; same hour, other model → separate bucket.
  agg.addClaudeLine(claudeLine({ id: 'msg_h2', ts: ts + 2 * 3_600_000, usage: { input: 1 } }), CTX)
  agg.addClaudeLine(claudeLine({ id: 'msg_h3', ts, model: 'claude-haiku-4-5', usage: { input: 1 } }), CTX)
  assert.equal(agg.all().length, 3)
})

test('attribution off: no session records, cursor keeps only lastTs', () => {
  const agg = new Aggregator()
  agg.cursors.set(CLAUDE_MAIN, { offset: 0, size: 0, ino: 1, dev: 1 })
  agg.addClaudeLine(claudeLine({ id: 'msg_a', ts: T0, usage: { input: 1 } }), CTX)
  assert.equal(agg.sessions().length, 0)
  const cur = agg.cursors.get(CLAUDE_MAIN)!
  assert.equal(cur.lastTs, T0)
  assert.equal(cur.sessionId, undefined)
  assert.equal(cur.project, undefined)
  assert.equal(agg.toSnapshot().attribution, 'none')
})

test('attribution on: session id, project basename, salted hash, and never the cwd itself', () => {
  const agg = new Aggregator()
  agg.cursors.set(CLAUDE_MAIN, { offset: 0, size: 0, ino: 1, dev: 1 })
  const ctx = ctxFor({ attribution: 'session', projectSalt: 'salt-1' })
  agg.addClaudeLine(claudeLine({ id: 'msg_a', ts: T0, usage: { input: 10, cacheWrite: 100, cacheRead: 5, output: 3 } }), ctx)
  agg.addClaudeLine(claudeLine({ id: 'msg_a', ts: T0 + 100, usage: { input: 10, cacheWrite: 100, cacheRead: 5, output: 9 }, final: true }), ctx)
  agg.addClaudeLine(claudeLine({ id: 'msg_b', ts: T0 + 90_000, model: 'claude-sonnet-4-6', usage: { input: 4, output: 2, thinking: 1 } }), ctx)
  const s = agg.sessions()
  assert.equal(s.length, 1)
  const rec = s[0]
  assert.equal(rec.source, 'claude')
  assert.equal(rec.sessionId, 'sess-0001')
  assert.equal(rec.project, 'proj-alpha')
  assert.match(rec.projectHash, /^[0-9a-f]{12}$/)
  assert.equal(rec.isSub, false)
  assert.equal(rec.parent, null)
  assert.equal(rec.firstTs, T0)
  assert.equal(rec.lastTs, T0 + 90_000)
  assert.deepEqual(rec.models, ['claude-opus-4-6', 'claude-sonnet-4-6'])
  assert.equal(rec.input, 14)
  assert.equal(rec.output, 11)
  assert.equal(rec.reasoning, 1)
  assert.equal(rec.requests, 2)
  assert.equal(rec.outputFinal, 1)
  // A turn gap runs from the last counted line of the previous message (T0+100) to the
  // first line of the next — the streaming continuation is part of the previous turn.
  assert.deepEqual(rec.turnGapsMs, [89_900])
  const cur = agg.cursors.get(CLAUDE_MAIN)!
  assert.equal(cur.sessionId, 'sess-0001')
  assert.equal(cur.project, 'proj-alpha')
  const snap = agg.toSnapshot()
  assert.equal(snap.attribution, 'session')
  assert.equal(JSON.stringify(snap).includes('/home/tester/proj-alpha'), false)

  // The hash is a function of salt and path: same salt → same hash, other salt → other hash.
  const again = new Aggregator()
  again.addClaudeLine(claudeLine({ id: 'msg_a', ts: T0, usage: { input: 1 } }), ctxFor({ attribution: 'project', projectSalt: 'salt-1' }))
  assert.equal(again.sessions()[0].projectHash, rec.projectHash)
  const other = new Aggregator()
  other.addClaudeLine(claudeLine({ id: 'msg_a', ts: T0, usage: { input: 1 } }), ctxFor({ attribution: 'project', projectSalt: 'salt-2' }))
  assert.notEqual(other.sessions()[0].projectHash, rec.projectHash)

  // hashProjects: the label is the pseudonym; the record carries no basename. (The record's
  // key is the transcript path, and Claude's path embeds the project slug — a fact of the
  // file layout, present in cursor keys since the first release, not something to hide here.)
  const hashed = new Aggregator()
  hashed.addClaudeLine(claudeLine({ id: 'msg_a', ts: T0, usage: { input: 1 } }), ctxFor({ attribution: 'project', projectSalt: 'salt-1', hashProjects: true }))
  const h = hashed.sessions()[0]
  assert.equal(h.project, h.projectHash)
  assert.equal(JSON.stringify(h).includes('proj-alpha'), false)
  assert.equal(hashed.cursors.size, 0)
})

test('a line without cwd falls back to the project directory slug', () => {
  const agg = new Aggregator()
  agg.addClaudeLine(claudeLine({ id: 'msg_a', ts: T0, cwd: null, sessionId: null, usage: { input: 1 } }), ctxFor({ attribution: 'session' }))
  const rec = agg.sessions()[0]
  assert.equal(rec.project, '-home-tester-proj-alpha')
  assert.equal(rec.sessionId, 'sess-0001') // basename of the transcript
})

test('subagent transcripts: isSub, parent from the session directory, own id from the file name', () => {
  const agg = new Aggregator()
  const ctx = ctxFor({ attribution: 'session', file: CLAUDE_SUB, isSub: true })
  agg.addClaudeLine(claudeLine({ id: 'msg_sub', ts: T0, sessionId: null, usage: { input: 3 } }), ctx)
  const rec = agg.sessions()[0]
  assert.equal(rec.isSub, true)
  assert.equal(rec.parent, 'sess-0001')
  assert.equal(rec.sessionId, 'agent-a1')
  assert.equal(rec.project, 'proj-alpha')
  assert.equal(agg.all()[0].isSub, true)
  assert.equal(bucketKey(agg.all()[0]).split('|')[4], '1')
})

test('cache TTL class and time of the last cache write per session; turn gaps are capped', () => {
  const agg = new Aggregator()
  const ctx = ctxFor({ attribution: 'session' })
  agg.addClaudeLine(claudeLine({ id: 'w1', ts: T0, usage: { cacheWrite: 500, cacheWrite1h: 0 } }), ctx)
  let rec = agg.sessions()[0]
  assert.equal(rec.lastCacheTtl, '5m')
  assert.equal(rec.lastCacheWriteTs, T0)
  agg.addClaudeLine(claudeLine({ id: 'w2', ts: T0 + 1000, usage: { cacheWrite: 800, cacheWrite1h: 800 } }), ctx)
  rec = agg.sessions()[0]
  assert.equal(rec.lastCacheTtl, '1h')
  assert.equal(rec.lastCacheWriteTs, T0 + 1000)
  // A request without a cache write leaves the last write untouched.
  agg.addClaudeLine(claudeLine({ id: 'w3', ts: T0 + 2000, usage: { input: 5 } }), ctx)
  rec = agg.sessions()[0]
  assert.equal(rec.lastCacheTtl, '1h')
  assert.equal(rec.lastCacheWriteTs, T0 + 1000)

  for (let i = 0; i < 260; i++) {
    agg.addClaudeLine(claudeLine({ id: `g${i}`, ts: T0 + 10_000 + i * 1000, usage: { input: 1 } }), ctx)
  }
  rec = agg.sessions()[0]
  assert.equal(rec.turnGapsMs.length, 200)
  assert.equal(rec.turnGapsMs[rec.turnGapsMs.length - 1], 1000)
})

test('firstIngest is the oldest counted timestamp; stats reflect buckets and files', () => {
  const agg = new Aggregator()
  agg.cursors.set(CLAUDE_MAIN, { offset: 0, size: 0, ino: 1, dev: 1 })
  agg.addClaudeLine(claudeLine({ id: 'a', ts: T0, usage: { input: 1 } }), CTX)
  agg.addClaudeLine(claudeLine({ id: 'b', ts: T0 - 86_400_000 * 3, usage: { input: 1 } }), CTX)
  agg.addClaudeLine(claudeLine({ id: 'c', ts: T0 + 5000, synthetic: true }), CTX)
  assert.equal(agg.firstIngest, T0 - 86_400_000 * 3)
  const st = agg.stats()
  assert.equal(st.buckets, 2)
  assert.equal(st.hourBuckets, 2)
  assert.equal(st.dayBuckets, 0)
  assert.equal(st.monthBuckets, 0)
  assert.equal(st.files, 1)
  assert.equal(st.oldestDay, localDay(T0 - 86_400_000 * 3))
  assert.equal(st.newestDay, localDay(T0))
})

test('snapshot round trip keeps everything; attribution rules on restore', () => {
  const agg = new Aggregator()
  agg.cursors.set(CLAUDE_MAIN, { offset: 10, size: 10, ino: 1, dev: 1 })
  const ctx = ctxFor({ attribution: 'session' })
  agg.addClaudeLine(claudeLine({ id: 'a', ts: T0, usage: { input: 1, output: 2 } }), ctx)
  const snap = agg.toSnapshot()
  assert.equal(snap.version, STATE_VERSION)
  assert.equal(Object.keys(snap.sessions).length, 1)
  assert.equal(Object.keys(snap.pending).length, 1)
  assert.equal(snap.pending['a'].session, CLAUDE_MAIN)
  assert.equal(snap.firstIngest, T0)

  const same = Aggregator.fromSnapshot(JSON.parse(JSON.stringify(snap)), 'session')
  assert.deepEqual(same.all(), agg.all())
  assert.equal(same.sessions().length, 1)
  assert.equal(same.firstIngest, T0)
  assert.equal(same.cursors.get(CLAUDE_MAIN)!.sessionId, 'sess-0001')
  // The late line still finds its session after a restore.
  same.addClaudeLine(claudeLine({ id: 'a', ts: T0 + 100, usage: { input: 1, output: 12 } }), ctx)
  assert.equal(same.sessions()[0].output, 12)
  assert.equal(same.all()[0].output, 12)

  // project ↔ session share the record shape.
  assert.equal(Aggregator.fromSnapshot(snap, 'project').sessions().length, 1)

  // Off: buckets stay, session data and identifiers go.
  const off = Aggregator.fromSnapshot(JSON.parse(JSON.stringify(snap)), 'none')
  assert.equal(off.all().length, 1)
  assert.equal(off.sessions().length, 0)
  assert.equal(off.cursors.get(CLAUDE_MAIN)!.sessionId, undefined)
  assert.equal(off.toSnapshot().pending['a'].session, undefined)

  // Turning attribution on over a snapshot that never collected it → empty (cold scan).
  const plain = new Aggregator()
  plain.addClaudeLine(claudeLine({ id: 'a', ts: T0, usage: { input: 1 } }), CTX)
  const cold = Aggregator.fromSnapshot(plain.toSnapshot(), 'session')
  assert.equal(cold.all().length, 0)
  assert.equal(cold.attribution, 'session')

  // Version mismatch → empty. 5 is the one older version that still loads (no tool table).
  assert.equal(Aggregator.fromSnapshot({ ...snap, version: 4 }, 'session').all().length, 0)
  assert.equal(Aggregator.fromSnapshot({ ...snap, version: STATE_VERSION + 1 }, 'session').all().length, 0)
  assert.equal(Aggregator.fromSnapshot(undefined).all().length, 0)

  // clearSessions drops the table and the identifiers everywhere.
  agg.clearSessions()
  assert.equal(agg.sessions().length, 0)
  assert.equal(agg.attribution, 'none')
  assert.equal(agg.cursors.get(CLAUDE_MAIN)!.sessionId, undefined)
})

test('cost: priced, unpriced, fast-without-rate and family attribution', () => {
  const agg = new Aggregator()
  agg.addClaudeLine(claudeLine({ id: 'p', ts: T0, model: 'claude-opus-4-6', usage: { input: 1_000_000 } }), CTX)
  agg.addClaudeLine(claudeLine({ id: 'u', ts: T0, model: 'claude-zeta-9', usage: { input: 700, output: 300 } }), CTX)
  agg.addClaudeLine(claudeLine({ id: 'f', ts: T0, model: 'claude-sonnet-4-6', usage: { input: 400, output: 100, speed: 'fast' } }), CTX)
  const c = agg.cost('2026-03-10', '2026-03-10', utc, {})
  assert.ok(Math.abs(c.usd - 5) < 1e-9, `opus 4.6 input at $5/M: ${c.usd}`)
  assert.equal(c.listUsd, c.usd)
  assert.deepEqual(c.unpricedModels, ['claude-zeta-9'])
  assert.equal(c.unpricedTokens, 1000)
  assert.equal(c.fastUnpricedTokens, 500)
  assert.equal(c.custom, false)
  assert.deepEqual(c.familyPriced, [])

  const disc = agg.cost('2026-03-10', '2026-03-10', utc, { multiplier: 0.5 })
  assert.ok(Math.abs(disc.usd - 2.5) < 1e-9)
  assert.ok(Math.abs(disc.listUsd - 5) < 1e-9)
  assert.equal(disc.custom, true)

  const fam = agg.cost('2026-03-10', '2026-03-10', utc, { unknownModel: 'family' })
  assert.equal(fam.unpricedModels.includes('claude-zeta-9'), true, 'no family for an unknown line')
  const opusNew = new Aggregator()
  opusNew.addClaudeLine(claudeLine({ id: 'q', ts: T0, model: 'claude-opus-4-9', usage: { input: 1000 } }), CTX)
  const famOk = opusNew.cost('2026-03-10', '2026-03-10', utc, { unknownModel: 'family' })
  assert.deepEqual(famOk.familyPriced, ['claude-opus-4-9'])
  assert.ok(famOk.usd > 0)

  // Filters narrow every query the same way.
  assert.equal(agg.sum('2026-03-10', '2026-03-10', utc, { models: ['claude-zeta-9'] }).input, 700)
  assert.equal(agg.sum('2026-03-10', '2026-03-10', utc, { tier: 'fast' }).input, 400)
  assert.equal(agg.sum('2026-03-10', '2026-03-10', utc, { source: 'codex' }).input, 0)
  assert.equal(agg.sum('2026-03-10', '2026-03-10', utc, { isSub: true }).requests, 0)
})

test('a restored bucket from a provider this build does not know is dropped', () => {
  const agg = new Aggregator()
  agg.addClaudeLine(
    claudeLine({ id: 'a', ts: T0, usage: { input: 100, cacheRead: 40, output: 5 }, tools: [{ name: 'Read' }] }),
    CTX,
  )
  const snap = JSON.parse(JSON.stringify(agg.toSnapshot())) as Snapshot
  // A snapshot is a file: another build, or a hand edit, can put any string in `source`.
  const alien: Bucket = { ...snap.buckets[0], source: 'gemini' as Source, model: 'gemini-9' }
  snap.buckets.push(alien)
  snap.buckets.push({ ...alien, source: '' as Source })
  const alienTool: ToolStat = { source: 'gemini' as Source, day: '2026-03-10', model: 'gemini-9', name: 'Grep', calls: 3 }
  snap.tools = [...(snap.tools ?? []), alienTool]

  const back = Aggregator.fromSnapshot(snap)
  // Every restored row has to name a provider the registry can answer for: everything
  // downstream looks the source up to decide how to read the row.
  assert.deepEqual(back.all().map((b) => b.source), ['claude'])
  assert.equal(back.all().length, 1)
  assert.deepEqual(back.tools().rows.map((t) => t.source), ['claude'])
  // And the rule that reads a bucket stays total regardless: the views sit behind a `try`,
  // so a throw here would blank the dashboard instead of stating an absence.
  assert.equal(freshInput(alien), alien.input)
  assert.equal(billable(alien), alien.input + alien.cacheWrite + alien.output)
})

// ---------------------------------------------------------------------------
// 1.7 W3 (§0a.1): the Claude Code version for the user agent, from the main sessions only
// ---------------------------------------------------------------------------

const MAIN_B = CLAUDE_MAIN.replace('sess-0001.jsonl', 'sess-0002.jsonl')
const MAIN_B_CTX = ctxFor({ file: MAIN_B })
const SUB_CTX = ctxFor({ file: CLAUDE_SUB, isSub: true })

function mainRecOf(agg: Aggregator, file: string): MainRec {
  const rec = new Map(agg.mainEntries()).get(file)
  assert.ok(rec, `no main record for ${file}`)
  return rec
}

test('latestClaudeVersion: the main session with the latest last line names it; agents are never asked (1.7 W3, §0a.1)', () => {
  const agg = new Aggregator()
  assert.equal(agg.latestClaudeVersion(), null, 'no session, no version')
  // The newer session is read first, so the answer is not simply the last one read.
  agg.addClaudeLine(claudeLine({ id: 'b1', ts: T0 + 3_600_000, usage: { input: 3 }, version: '2.1.281' }), MAIN_B_CTX)
  agg.addClaudeLine(claudeLine({ id: 'a1', ts: T0, usage: { input: 3 }, version: '2.1.280' }), CTX)
  assert.equal(agg.latestClaudeVersion(), '2.1.281')
  // An agent's transcript written later, by a newer build, is not a main session: not used.
  agg.addClaudeLine(claudeLine({ id: 's1', ts: T0 + 7_200_000, agentId: 'a1', usage: { input: 3 }, version: '2.1.300' }), SUB_CTX)
  assert.equal(agg.agents().length, 1)
  assert.equal(agg.agents()[0].ccVersion, '2.1.300')
  assert.equal(agg.latestClaudeVersion(), '2.1.281')
  // The older session goes on and becomes the newest: its version now.
  agg.addClaudeLine(claudeLine({ id: 'a2', ts: T0 + 5_400_000, usage: { input: 3 }, version: '2.1.279' }), CTX)
  assert.equal(agg.latestClaudeVersion(), '2.1.279')
})

test('latestClaudeVersion: a version without the shape is skipped for the next main session, or none (1.7 W3, §0a.1)', () => {
  const agg = new Aggregator()
  agg.addClaudeLine(claudeLine({ id: 'b1', ts: T0 + 3_600_000, usage: { input: 3 }, version: 'synthetic' }), MAIN_B_CTX)
  agg.addClaudeLine(claudeLine({ id: 'a1', ts: T0, usage: { input: 3 }, version: '2.1.280' }), CTX)
  // The newest session wrote no version the pattern takes: the next one answers.
  assert.equal(mainRecOf(agg, MAIN_B).ccVersion, null)
  assert.equal(agg.latestClaudeVersion(), '2.1.280')

  // A snapshot written by hand: whatever it carries, restore and the reader hold it to the shape.
  const snap = JSON.parse(JSON.stringify(agg.toSnapshot())) as Snapshot
  const mains = snap.mains as unknown as Record<string, Record<string, unknown>>
  mains[MAIN_B].ccVersion = '2.1.281; rm'
  mains[CLAUDE_MAIN].ccVersion = 'synthetic'
  const back = Aggregator.fromSnapshot(snap)
  assert.equal(back.latestClaudeVersion(), null)

  // And a record that carries one anyway (another build's restore, a bug) is checked again here.
  const live = new Aggregator()
  live.addClaudeLine(claudeLine({ id: 'b1', ts: T0 + 3_600_000, usage: { input: 3 }, version: '2.1.281' }), MAIN_B_CTX)
  live.addClaudeLine(claudeLine({ id: 'a1', ts: T0, usage: { input: 3 }, version: '2.1.280' }), CTX)
  mainRecOf(live, MAIN_B).ccVersion = '2.1.281; rm'
  assert.equal(live.latestClaudeVersion(), '2.1.280')
  mainRecOf(live, CLAUDE_MAIN).ccVersion = '<b>2.1.280</b>'
  assert.equal(live.latestClaudeVersion(), null)
})

// ---------------------------------------------------------------------------
// 1.8 §0a.2 / A1 rule 2: a main session's newest request that read or wrote the prompt cache;
// §0a.5: its stop reason and whether the newest message line is the user's
// ---------------------------------------------------------------------------

function lastRequestOf(agg: Aggregator, file = CLAUDE_MAIN): MainRec['lastRequest'] {
  return mainRecOf(agg, file).lastRequest
}

test('lastRequest: a first line with a 1 h write makes it; a later line of the message grows its size and keeps its time (1.8 §0a.2)', () => {
  const agg = new Aggregator()
  const T1 = T0
  agg.addClaudeLine(claudeLine({ id: 'm1', ts: T1, usage: { input: 4, cacheWrite: 5000, cacheWrite1h: 5000, cacheRead: 20_000, output: 10 } }), CTX)
  assert.deepEqual(lastRequestOf(agg), { at: T1, ttl: '1h', context: 4 + 5000 + 20_000 + 10, model: 'claude-opus-4-6', stop: null, replyPending: false })
  // The reply streams on: the running maximum grows, the time stays the first line's — the request's.
  agg.addClaudeLine(claudeLine({ id: 'm1', ts: T1 + 4000, usage: { input: 4, cacheWrite: 5000, cacheWrite1h: 5000, cacheRead: 20_000, output: 900 }, final: true }), CTX)
  assert.deepEqual(lastRequestOf(agg), { at: T1, ttl: '1h', context: 4 + 5000 + 20_000 + 900, model: 'claude-opus-4-6', stop: 'end_turn', replyPending: false })
  // A read-only request after it: the newest, its own time, and the class of the write before it.
  const T2 = T1 + 60_000
  agg.addClaudeLine(claudeLine({ id: 'm2', ts: T2, model: 'claude-sonnet-4-6', usage: { input: 3, cacheRead: 25_900, output: 40 }, final: true, stopReason: 'tool_use' }), CTX)
  assert.deepEqual(lastRequestOf(agg), { at: T2, ttl: '1h', context: 3 + 25_900 + 40, model: 'claude-sonnet-4-6', stop: 'tool_use', replyPending: false })
  // A 5-minute write only: that class.
  agg.addClaudeLine(claudeLine({ id: 'm3', ts: T2 + 60_000, usage: { input: 2, cacheWrite: 300, cacheRead: 25_900, output: 5 }, final: true }), CTX)
  assert.equal(lastRequestOf(agg)?.ttl, '5m')
  assert.equal(lastRequestOf(agg)?.at, T2 + 60_000)
  const kept = lastRequestOf(agg)
  // A request that touched no cache is no newer request of the cache.
  agg.addClaudeLine(claudeLine({ id: 'm4', ts: T2 + 120_000, usage: { input: 50, output: 5 }, final: true }), CTX)
  assert.deepEqual(lastRequestOf(agg), kept)
  // A late line of an older message changes nothing — not its size, not its time.
  agg.addClaudeLine(claudeLine({ id: 'm1', ts: T2 + 130_000, usage: { input: 4, cacheWrite: 5000, cacheWrite1h: 5000, cacheRead: 20_000, output: 5000 } }), CTX)
  assert.deepEqual(lastRequestOf(agg), kept)
  // Nor does an error line or a placeholder reply, whatever usage they carry.
  agg.addClaudeLine(claudeLine({ id: 'e1', ts: T2 + 140_000, error: true, usage: { cacheWrite1h: 9000, cacheWrite: 9000, cacheRead: 1 } }), CTX)
  agg.addClaudeLine(claudeLine({ id: 's1', ts: T2 + 150_000, synthetic: true, usage: { cacheRead: 9 } }), CTX)
  assert.deepEqual(lastRequestOf(agg), kept)
  // A write of both kinds is the 1-hour class.
  agg.addClaudeLine(claudeLine({ id: 'm5', ts: T2 + 200_000, usage: { cacheWrite: 800, cacheWrite1h: 100, cacheRead: 26_000, output: 1 } }), CTX)
  assert.equal(lastRequestOf(agg)?.ttl, '1h')
})

test('lastRequest: a message whose cache tokens show on a later line becomes the request then, with its first line\'s time; none before a write has a class', () => {
  const agg = new Aggregator()
  agg.addClaudeLine(claudeLine({ id: 'r1', ts: T0, usage: { input: 5 } }), CTX)
  assert.equal(lastRequestOf(agg), null, 'no cache tokens yet')
  agg.addClaudeLine(claudeLine({ id: 'r1', ts: T0 + 900, usage: { input: 5, cacheRead: 700, output: 3 } }), CTX)
  // Only read: no write before it, so no class — a null TTL, which nothing watches.
  assert.deepEqual(lastRequestOf(agg), { at: T0, ttl: null, context: 708, model: 'claude-opus-4-6', stop: null, replyPending: false })
})

test('lastRequest: an agent\'s transcript gives no record one; the replay builds it as a fresh read does (1.8 §0a.2)', () => {
  const agg = new Aggregator()
  agg.addClaudeLine(claudeLine({ id: 'a1', ts: T0, agentId: 'a1', usage: { cacheWrite: 4000, cacheWrite1h: 4000, cacheRead: 100 } }), SUB_CTX)
  assert.equal(agg.mainEntries().length, 0)
  assert.equal(agg.agents().length, 1)
  assert.equal('lastRequest' in agg.agents()[0], false, 'an agent record keeps none')
  assert.equal(JSON.stringify(agg.toSnapshot().pending).includes('firstAt'), false, 'an agent\'s message keeps no first time')

  const lines = [
    claudeLine({ id: 'm1', ts: T0, usage: { input: 1, cacheWrite: 2000, cacheWrite1h: 2000, output: 1 } }),
    claudeLine({ id: 'm1', ts: T0 + 500, usage: { input: 1, cacheWrite: 2000, cacheWrite1h: 2000, output: 80 }, final: true }),
    claudeLine({ id: 'm2', ts: T0 + 60_000, usage: { input: 1, cacheRead: 2081, output: 9 }, final: true, stopReason: 'max_tokens' }),
  ]
  const live = new Aggregator()
  for (const l of lines) live.addClaudeLine(l, CTX)
  const replayed = new Aggregator()
  replayed.beginAgentReplay([CLAUDE_MAIN])
  for (const l of lines) replayed.addClaudeLine(l, { ...CTX, agentsOnly: true })
  replayed.endAgentReplay()
  assert.deepEqual(lastRequestOf(replayed), lastRequestOf(live))
  assert.deepEqual(lastRequestOf(live), { at: T0 + 60_000, ttl: '1h', context: 1 + 2081 + 9, model: 'claude-opus-4-6', stop: 'max_tokens', replyPending: false })
  assert.equal(replayed.all().length, 0, 'the replay counts nothing')
})

test('lastRequest.stop: the six documented stop reasons are kept, any other value is none (1.8 §0a.5)', () => {
  // Counted on synthetic lines only: one reply per value, each the newest when it is read.
  const values: unknown[] = ['end_turn', 'tool_use', 'max_tokens', 'stop_sequence', 'pause_turn', 'refusal', 'synthetic', 'END_TURN', 42, '']
  const kept = new Map<string, number>()
  const agg = new Aggregator()
  values.forEach((v, i) => {
    const raw = JSON.parse(claudeLine({ id: `st${i}`, ts: T0 + i * 1000, usage: { cacheRead: 100 + i }, final: true })) as { message: Record<string, unknown> }
    raw.message.stop_reason = v
    agg.addClaudeLine(JSON.stringify(raw), CTX)
    const stop = String(lastRequestOf(agg)?.stop)
    kept.set(stop, (kept.get(stop) ?? 0) + 1)
  })
  assert.deepEqual(Object.fromEntries(kept), {
    end_turn: 1, tool_use: 1, max_tokens: 1, stop_sequence: 1, pause_turn: 1, refusal: 1, null: 4,
  })
  // A later line that states none keeps the one an earlier line of the reply stated; one that states
  // another replaces it.
  agg.addClaudeLine(claudeLine({ id: 'sx', ts: T0 + 20_000, usage: { cacheRead: 5 }, final: true, stopReason: 'tool_use' }), CTX)
  agg.addClaudeLine(claudeLine({ id: 'sx', ts: T0 + 20_100, usage: { cacheRead: 5 } }), CTX)
  assert.equal(lastRequestOf(agg)?.stop, 'tool_use')
  agg.addClaudeLine(claudeLine({ id: 'sx', ts: T0 + 20_200, usage: { cacheRead: 5 }, final: true, stopReason: 'end_turn' }), CTX)
  assert.equal(lastRequestOf(agg)?.stop, 'end_turn')
})

/** Bookkeeping lines as Claude Code writes them after a reply (probe P-6: key names only) — synthetic values. */
function bookkeepingLines(ts: number): string[] {
  const at = iso(ts)
  return [
    JSON.stringify({ type: 'attachment', attachment: { type: 'hook_success', content: 'synthetic "type":"user" hook output' }, timestamp: at, sessionId: 'sess-0001' }),
    JSON.stringify({ type: 'system', subtype: 'turn_duration', durationMs: 1234, timestamp: at, sessionId: 'sess-0001' }),
    JSON.stringify({ type: 'file-history-snapshot', messageId: 'uuid-x', snapshot: { trackedFileBackups: {}, timestamp: at } }),
    JSON.stringify({ type: 'last-prompt', lastPrompt: 'synthetic prompt text', sessionId: 'sess-0001' }),
    JSON.stringify({ type: 'ai-title', aiTitle: 'synthetic title', sessionId: 'sess-0001' }),
    JSON.stringify({ type: 'mode', mode: 'normal', sessionId: 'sess-0001' }),
    JSON.stringify({ type: 'permission-mode', permissionMode: 'default', sessionId: 'sess-0001' }),
  ]
}

test('lastRequest.replyPending: the probe P-6 shape — an end_turn reply, then a prompt and nothing after it — is pending; a tool result newest too; a reply newest is not (1.8 §0a.5)', () => {
  const agg = new Aggregator()
  const feed = (lines: string[]): void => { for (const l of lines) agg.addClaudeLine(l, CTX) }
  feed([
    promptLine({ ts: T0 }),
    claudeLine({ id: 'm1', ts: T0 + 3000, usage: { input: 3, cacheWrite: 6000, cacheWrite1h: 6000, output: 50 }, final: true }),
  ])
  assert.equal(lastRequestOf(agg)?.replyPending, false, 'an end_turn reply is the newest message line')
  // What follows an end_turn reply is bookkeeping: none of it is a message line.
  feed(bookkeepingLines(T0 + 3500))
  assert.equal(lastRequestOf(agg)?.replyPending, false, 'a bookkeeping line counted as a message line')
  assert.equal(lastRequestOf(agg)?.stop, 'end_turn')
  // P-6: the user asks; the reply that calls AskUserQuestion is written only when the tool completes,
  // so while the question stands the newest message line is the prompt.
  feed([promptLine({ ts: T0 + 5 * 60_000, text: 'synthetic prompt "type":"assistant" quoted' })])
  assert.equal(lastRequestOf(agg)?.replyPending, true, 'the P-6 shape: the prompt is the newest message line')
  assert.equal(lastRequestOf(agg)?.stop, 'end_turn', 'the reply before it still says end_turn — which is why the flag is needed')
  feed(bookkeepingLines(T0 + 5 * 60_000 + 10))
  assert.equal(lastRequestOf(agg)?.replyPending, true, 'bookkeeping after the prompt changes nothing')
  // The reply comes, calling a tool: not pending; its tool result: pending again; the answer: not.
  feed([claudeLine({ id: 'm2', ts: T0 + 9 * 60_000, usage: { input: 2, cacheRead: 6050, output: 20 }, final: true, stopReason: 'tool_use', tools: [{ name: 'Bash', id: 'toolu_p6' }] })])
  assert.deepEqual([lastRequestOf(agg)?.replyPending, lastRequestOf(agg)?.stop], [false, 'tool_use'])
  feed([toolResultLine({ ts: T0 + 9 * 60_000 + 1, results: [{ toolUseId: 'toolu_p6', text: 'synthetic output "type":"assistant"' }] })])
  assert.equal(lastRequestOf(agg)?.replyPending, true, 'a tool result is the newest message line')
  feed([claudeLine({ id: 'm3', ts: T0 + 9 * 60_000 + 3000, usage: { input: 2, cacheRead: 6100, output: 30 }, final: true })])
  assert.deepEqual([lastRequestOf(agg)?.replyPending, lastRequestOf(agg)?.stop], [false, 'end_turn'])
  // A reply of any kind is a message line: an error line and a placeholder end what the user started,
  // and neither is a counted request.
  feed([promptLine({ ts: T0 + 20 * 60_000 })])
  feed([claudeLine({ id: 'e1', ts: T0 + 20 * 60_000 + 500, error: true })])
  assert.equal(lastRequestOf(agg)?.replyPending, false)
  assert.equal(lastRequestOf(agg)?.at, T0 + 9 * 60_000 + 3000, 'the error line is no request')
  // A compaction's summary line is a user line too — recognised on the raw line, never parsed.
  feed([compactSummaryLine({ ts: T0 + 30 * 60_000, summary: 'synthetic summary "type":"assistant"' })])
  assert.equal(lastRequestOf(agg)?.replyPending, true)
})

test('lastRequest.replyPending: in the order the file holds the lines; a session without a cache request has no flag; an agent\'s lines never set it (1.8 §0a.5)', () => {
  const agg = new Aggregator()
  // A prompt before the session's first counted reply: no record yet, nothing to set.
  agg.addClaudeLine(promptLine({ ts: T0 }), CTX)
  assert.equal(agg.mainEntries().length, 0)
  // A reply without cache tokens makes the record but no request of the cache: no flag either.
  agg.addClaudeLine(claudeLine({ id: 'n1', ts: T0 + 1000, usage: { input: 9 }, final: true }), CTX)
  agg.addClaudeLine(promptLine({ ts: T0 + 2000 }), CTX)
  assert.equal(lastRequestOf(agg), null)
  // The first cache request clears it by being the newest line.
  agg.addClaudeLine(claudeLine({ id: 'n2', ts: T0 + 3000, usage: { cacheRead: 9 }, final: true }), CTX)
  assert.equal(lastRequestOf(agg)?.replyPending, false)
  // An agent's prompt and tool results belong to the agent's transcript: the session's flag stays.
  agg.addClaudeLine(promptLine({ ts: T0 + 4000, agentId: 'a1' }), SUB_CTX)
  agg.addClaudeLine(toolResultLine({ ts: T0 + 4001, agentId: 'a1', results: [{ toolUseId: 'toolu_a1' }] }), SUB_CTX)
  assert.equal(lastRequestOf(agg)?.replyPending, false)
  // Another session's prompt is that session's.
  agg.addClaudeLine(promptLine({ ts: T0 + 5000 }), MAIN_B_CTX)
  assert.equal(lastRequestOf(agg)?.replyPending, false)
  // A line that says it changed something only when the flag moved.
  assert.equal(agg.addClaudeLine(promptLine({ ts: T0 + 6000, permissionMode: null }), CTX), true)
  assert.equal(agg.addClaudeLine(promptLine({ ts: T0 + 7000, permissionMode: null }), CTX), false)
})

test('lastRequest survives a snapshot round trip and restores by shape; a 1.7 snapshot restores none, and its open message grows none (1.8 §0a.2)', () => {
  const agg = new Aggregator()
  agg.addClaudeLine(claudeLine({ id: 'm1', ts: T0, usage: { input: 4, cacheWrite: 5000, cacheWrite1h: 5000, output: 10 } }), CTX)
  agg.addClaudeLine(promptLine({ ts: T0 + 60_000 }), CTX)
  const want = lastRequestOf(agg)
  assert.deepEqual(want, { at: T0, ttl: '1h', context: 5014, model: 'claude-opus-4-6', stop: null, replyPending: true })
  const snap = JSON.parse(JSON.stringify(agg.toSnapshot())) as Snapshot
  assert.equal(snap.pending.m1.firstAt, T0, 'the open message keeps its first line\'s time')
  const back = Aggregator.fromSnapshot(snap)
  assert.deepEqual(lastRequestOf(back), want, 'restoreMain keeps every field, the flag included')
  // The restored open message grows the restored request.
  back.addClaudeLine(claudeLine({ id: 'm1', ts: T0 + 70_000, usage: { input: 4, cacheWrite: 5000, cacheWrite1h: 5000, output: 400 }, final: true }), CTX)
  assert.deepEqual(lastRequestOf(back), { ...want!, context: 5404, stop: 'end_turn', replyPending: false })

  // A snapshot is a file anyone can edit: every value is checked as at ingest.
  const edited = (over: Record<string, unknown> | null, direct = false): MainRec['lastRequest'] => {
    // `direct` keeps what JSON cannot carry (NaN, Infinity) — a copy all the same: the snapshot holds the live records.
    const s = direct ? structuredClone(agg.toSnapshot()) : JSON.parse(JSON.stringify(agg.toSnapshot())) as Snapshot
    const m = (s.mains as unknown as Record<string, Record<string, unknown>>)[CLAUDE_MAIN]
    m.lastRequest = over === null ? null : { ...(m.lastRequest as Record<string, unknown>), ...over }
    return lastRequestOf(Aggregator.fromSnapshot(s))
  }
  assert.equal(edited({ ttl: 'x' }), null, 'a TTL class outside the list')
  assert.equal(edited({ ttl: undefined }), null, 'no TTL key')
  assert.equal(edited({ context: Number.NaN }, true), null, 'a size that is no number')
  assert.equal(edited({ context: -1 }), null, 'a negative size')
  assert.equal(edited({ context: '5014' }), null, 'a size as a string')
  assert.equal(edited({ at: 0 }), null, 'no time')
  assert.equal(edited({ at: Number.POSITIVE_INFINITY }, true), null, 'an endless time')
  assert.equal(edited({ replyPending: 'yes' }), null, 'a flag that is no boolean')
  assert.equal(edited({ replyPending: undefined }), null, 'no flag')
  assert.equal(edited({ model: 'x'.repeat(300) })?.model, null, 'a 300-character model is no model')
  assert.equal(edited({ model: 'claude opus' })?.model, null, 'a model with a space')
  assert.equal(edited({ stop: 'synthetic' })?.stop, null, 'a stop reason outside the list')
  assert.equal(edited({ stop: 'refusal' })?.stop, 'refusal')
  assert.equal(edited(null), null)
  assert.equal(edited({ ttl: '5m' })?.ttl, '5m')

  // What a 1.7 build leaves: no request on the record, no first time on the open message.
  const old = JSON.parse(JSON.stringify(agg.toSnapshot())) as Snapshot
  delete (old.mains as unknown as Record<string, Record<string, unknown>>)[CLAUDE_MAIN].lastRequest
  for (const p of Object.values(old.pending)) delete p.firstAt
  old.agentsRevision = 8
  const v17 = Aggregator.fromSnapshot(old)
  assert.equal(lastRequestOf(v17), null)
  assert.equal(v17.agentsRevision, 8)
  // Its open message's later line grows no request: its first line's time is not known.
  v17.addClaudeLine(claudeLine({ id: 'm1', ts: T0 + 70_000, usage: { input: 4, cacheWrite: 5000, cacheWrite1h: 5000, output: 400 } }), CTX)
  assert.equal(lastRequestOf(v17), null)
  // A new message does.
  v17.addClaudeLine(claudeLine({ id: 'm9', ts: T0 + 80_000, usage: { cacheRead: 5400, output: 3 } }), CTX)
  assert.equal(lastRequestOf(v17)?.at, T0 + 80_000)
  assert.equal(lastRequestOf(v17)?.ttl, null, 'the class of the write before it is not known either')
})

test('lastRequest keeps no content: synthetic text under content and a 300-character model reach no snapshot (1.8 §0a.2 leak test)', () => {
  const secret = 'LASTREQUEST-CONTENT-5e1d'
  const agg = new Aggregator()
  agg.addClaudeLine(promptLine({ ts: T0, text: `${secret}-prompt` }), CTX)
  agg.addClaudeLine(claudeLine({
    id: 'm1', ts: T0 + 1000, model: `claude-${'x'.repeat(293)}`, usage: { input: 3, cacheWrite: 900, cacheWrite1h: 900, output: 4 },
    content: [{ type: 'text', text: `${secret}-reply` }, { type: 'tool_use', id: 'toolu_leak', name: 'Bash', input: { command: `${secret}-input` } }],
    final: true, stopReason: 'tool_use',
  }), CTX)
  agg.addClaudeLine(toolResultLine({ ts: T0 + 2000, results: [{ toolUseId: 'toolu_leak', text: `${secret}-result` }] }), CTX)
  const rec = lastRequestOf(agg)
  assert.deepEqual(rec, { at: T0 + 1000, ttl: '1h', context: 907, model: null, stop: 'tool_use', replyPending: true })
  const snap = agg.toSnapshot()
  const saved = JSON.stringify(snap)
  assert.equal(saved.includes(secret), false, 'the snapshot holds a prompt, a reply, a tool input or a tool result')
  // The main session's record keeps no model that does not fit (the buckets name the line's model, as always).
  assert.equal(JSON.stringify(snap.mains).includes('x'.repeat(65)), false, 'the record holds the overlong model')
})
