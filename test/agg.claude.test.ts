// SPDX-FileCopyrightText: 2026 Frederik Marx
// SPDX-License-Identifier: AGPL-3.0-or-later

import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { Aggregator, billable, localDay } from '../src/agg'
import { freshInput } from '../src/stats'
import { hourIndex, TimeConfig } from '../src/time'
import { Bucket, Snapshot, Source, ToolStat, bucketKey, STATE_VERSION } from '../src/types'
import { CLAUDE_MAIN, CLAUDE_SUB, claudeLine, ctxFor } from './fixtures/helpers'

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
