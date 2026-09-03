// SPDX-FileCopyrightText: 2026 Frederik Marx
// SPDX-License-Identifier: AGPL-3.0-or-later

import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { DigestInput, digest } from '../src/digest'
import { buildViewModel } from '../src/viewModel'
import { NOW, fillHistory, makeHistory, makeInput, state, win } from './fixtures/viewFixtures'

function input(over: Partial<DigestInput> = {}): DigestInput {
  return {
    kpis: [{ key: 'usage', label: 'Usage', value: '10K', spark: [100, 100, 100, 100, 100, 100, 100, 200] }],
    models: {
      rows: [
        { model: 'claude-opus-4-6', cost: 12.5, costShare: '62 %', usage: 900, share: '60 %' },
        { model: 'gpt-5.3-codex', cost: 3.1, costShare: '15 %', usage: 600, share: '40 %' },
      ],
    },
    cacheEconomy: [{ source: 'claude', hitRate: '91 %', hitValue: 91, savedUsd: '~$4.20' }],
    quotas: [{
      title: 'Claude Code',
      windows: [
        { label: '5 h', percent: 22, display: 'normal', verdict: { text: 'on pace' } },
        { label: '7 d', percent: 78, display: 'normal', verdict: { text: '12 points ahead of the clock' } },
      ],
    }],
    unpricedModels: [],
    totals: [{ source: 'claude', title: 'Claude Code', rows: [{ label: 'Today', usage: '10K' }] }],
    showCost: true,
    ...over,
  }
}

test('the digest stays between three and five sentences', () => {
  const s = digest(input())
  assert.ok(s.length >= 3 && s.length <= 5, `got ${s.length}`)
})

test('the digest is deterministic', () => {
  assert.deepEqual(digest(input()), digest(input()))
})

test('every sentence carries a number', () => {
  for (const s of digest(input())) assert.match(s, /\d/, s)
})

test('the digest gives no advice', () => {
  const forbidden = /\b(should|try|switch to|consider|recommend|better to|you could)\b/i
  for (const s of digest(input())) assert.doesNotMatch(s, forbidden, s)
})

test('today is compared against the days before it, with the direction named', () => {
  const up = digest(input())[0]
  assert.match(up, /Today's usage is 100 % above the 7-day average \(200 vs 100 tokens per day\)\./)
  const down = digest(input({
    kpis: [{ key: 'usage', label: 'Usage', value: '1', spark: [100, 100, 100, 100, 100, 100, 100, 50] }],
  }))[0]
  assert.match(down, /50 % below/)
})

test('the cache rate is classified by the documented thresholds', () => {
  const rate = (v: number): string => digest(input({
    cacheEconomy: [{ source: 'claude', hitRate: `${v} %`, hitValue: v, savedUsd: '–' }],
  })).find((s) => s.startsWith('Cache hit rate')) as string
  assert.match(rate(80), /\(excellent\)/)
  assert.match(rate(79), /\(good\)/)
  assert.match(rate(50), /\(good\)/)
  assert.match(rate(49), /\(low\)/)
})

test('a provider without a denominator is left out of the cache sentence', () => {
  const s = digest(input({ cacheEconomy: [{ source: 'claude', hitRate: '–', hitValue: null, savedUsd: '–' }] }))
  assert.equal(s.find((x) => x.startsWith('Cache hit rate')), undefined)
})

test('unpriced models are named as the reason the cost is a lower bound', () => {
  const s = digest(input({ unpricedModels: ['claude-experimental-x'] }))
    .find((x) => x.includes('without a price'))
  assert.match(String(s), /1 model without a price on file \(claude-experimental-x\), so every cost figure here is a lower bound\./)
})

test('the fullest window is the one reported, with its verdict', () => {
  const s = digest(input()).find((x) => x.startsWith('The fullest quota window'))
  assert.equal(s, 'The fullest quota window is Claude Code 7 d at 78 % — 12 points ahead of the clock.')
})

test('a window whose reset has passed is not reported as the fullest one', () => {
  const s = digest(input({
    quotas: [{
      title: 'Claude Code',
      windows: [
        // The last reading before a reset that has already happened: still the highest
        // number on file, and no longer a statement about a window that exists.
        { label: '5 h', percent: 87, display: 'resetDue', verdict: { text: '13 points in reserve' } },
        { label: '7 d', percent: 40, display: 'normal', verdict: { text: 'on pace' } },
      ],
    }],
  })).find((x) => x.startsWith('The fullest quota window'))
  assert.equal(s, 'The fullest quota window is Claude Code 7 d at 40 % — on pace.')
})

test('a window without a limit has no fullness to report', () => {
  const s = digest(input({
    quotas: [{
      title: 'Codex',
      windows: [{ label: '5 h', percent: 99, display: 'unlimited', verdict: { text: 'on pace' } }],
    }],
  }))
  assert.equal(s.find((x) => x.startsWith('The fullest quota window')), undefined)
})

test('a reset-due reading of a real view model never reaches the digest', () => {
  const vm = buildViewModel(makeInput({
    quotas: [state('claude', {
      fetchedAt: Math.round((NOW - 3 * 3_600_000) / 1000),
      windows: [win({ percent: 87, resetsAt: NOW - 60_000 })],
    })],
  }))
  assert.equal(vm.quotas[0].windows[0].display, 'resetDue')
  for (const line of vm.digest) assert.doesNotMatch(line, /fullest quota window/)
})

test('without cost the digest falls back to the busiest model', () => {
  const s = digest(input({ showCost: false })).find((x) => x.includes('model in this range'))
  assert.match(String(s), /^Busiest model in this range: claude-opus-4-6 with 900 tokens, 60 % of the total\.$/)
})

test('an empty world produces no invented sentences', () => {
  const s = digest(input({
    kpis: [{ key: 'usage', label: 'Usage', value: '–', spark: [] }],
    models: { rows: [] },
    cacheEconomy: [],
    quotas: [],
    unpricedModels: [],
  }))
  assert.deepEqual(s, [])
})

test('the digest of a real view model is the view model’s own summary', () => {
  const history = makeHistory()
  fillHistory(history)
  const vm = buildViewModel(makeInput({ history }))
  assert.deepEqual(vm.digest, digest(vm))
  assert.ok(vm.digest.length >= 3)
})
