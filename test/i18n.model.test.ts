// SPDX-FileCopyrightText: 2026 Frederik Marx
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The view model in German.
 *
 * Every other test in this repository asserts English, which works because the bundle is
 * empty there. This file is the other half of the promise: with a bundle installed the very
 * same model comes out in the reader's language — the quota card, the pace verdict, the
 * explanation, the forecast, the KPI cards, the digest, the footnotes and the prompt-cache
 * line — and the figures come out in the reader's number format.
 *
 * Three rules are checked beside the words, because each of them broke once a comparison
 * stopped being a comparison of English literals:
 *  - the state word is dropped when the verdict beside it already carries it,
 *  - "reset due" is never prefixed with the verb, in any language,
 *  - and the unit of the pace is written "%", in German as in English — never "Punkte".
 *
 * The bundle is module state, so every test here puts it back in a `finally`.
 */

import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { setBundle, setLocale } from '../src/i18n'
import { compact, full, money, usd } from '../src/render'
import { paceVerdict } from '../src/pace'
import { buildViewModel } from '../src/viewModel'
import { ROOT } from './helpers/nls'
import {
  NOW, fillHistory, makeConfig, makeHistory, makeInput, state, win,
} from './fixtures/viewFixtures'

/** The bundle the extension ships, so the test reads the very words a German user sees. */
const GERMAN = JSON.parse(
  readFileSync(join(ROOT, 'l10n', 'bundle.l10n.de.json'), 'utf8'),
) as Record<string, string>

function german<T>(run: () => T): T {
  try {
    setBundle(GERMAN)
    setLocale('de')
    return run()
  } finally {
    setBundle(undefined)
    setLocale(undefined)
  }
}

test('the quota card, its verdict and its explanation come out in German', () => {
  const history = makeHistory()
  fillHistory(history)
  const vm = german(() => buildViewModel(makeInput({ history })))

  const card = vm.quotas.find((q) => q.source === 'claude')
  assert.ok(card, 'no Claude card')
  const w = card.windows[0]
  assert.equal(w.percentText, '40%')
  // 40 % used against a window whose clock has run 60 % — behind pace, in German.
  assert.match(w.verdict.text, /des Fensters noch übrig$/, w.verdict.text)
  assert.equal(w.resetLine, 'Reset 2h')
  assert.equal(w.explain.title, 'Warum grün')
  assert.ok(w.explain.lines[0].startsWith('40 % des Fensters verbraucht;'), w.explain.lines[0])
  assert.ok(w.explain.lines.some((l) => l.startsWith('Gelb, sobald')), JSON.stringify(w.explain.lines))
  // The screen-reader line is built from the same translated parts.
  assert.ok(w.aria.text.includes('verbraucht'), w.aria.text)
})

test('the key figures, the digest and the footnotes are German, and the numbers German too', () => {
  const history = makeHistory()
  fillHistory(history)
  const vm = german(() => buildViewModel(makeInput({ history })))

  const labels = vm.kpis.map((k) => k.label)
  assert.deepEqual(labels.slice(0, 2), ['Heute', 'Verbrauch'])
  assert.ok(labels.includes('Anfragen'), labels.join(' · '))
  assert.ok(labels.includes('Cache-Treffer'), labels.join(' · '))
  const usage = vm.kpis.find((k) => k.key === 'usage')
  assert.equal(usage?.note, 'frische Eingabe + Cache-Schreiben + Ausgabe')
  assert.equal(usage?.explain.sparkNote, 'letzte 14 Tage · ein Punkt pro Tag')
  assert.equal(usage?.explain.provenance, 'gemessen')
  // A decimal comma is the whole point of routing the formatters through the seam.
  assert.match(usage?.value ?? '', /^\d+,\d[KMG]$/, usage?.value)

  assert.ok(vm.digest.length > 0)
  assert.ok(vm.digest.some((s) => s.includes('Modell in diesem Zeitraum')), JSON.stringify(vm.digest))
  assert.ok(vm.footnotes[0].startsWith('„Verbrauch“ ='), vm.footnotes[0])
  assert.ok(vm.footnotes.some((f) => f.includes('gemessen = vom Anbieter gelesen')), JSON.stringify(vm.footnotes))
  // The composition bars and the totals table name their columns in German as well.
  assert.deepEqual(vm.composition[0].parts.map((p) => p.text),
    ['Frische Eingabe', 'Cache-Schreiben 5m', 'Cache-Schreiben 1h', 'Cache-Lesen', 'Ausgabe', 'Denkschritte (von der Ausgabe)'])
  assert.ok(vm.totals[0].rows.some((r) => r.label === 'Letzte 7 Tage'), vm.totals[0].rows.map((r) => r.label).join(' · '))
})

test('the forecast row, the prompt cache and the repair button speak German', () => {
  const history = makeHistory()
  fillHistory(history)
  const vm = german(() => buildViewModel({
    ...makeInput({ history }),
    promptCache: { warm: true, ttl: '1h', expiresAt: NOW + 220_000, hitRatio: 0.87, readAt: Math.round(NOW / 1000) },
  }))
  const claude = vm.quotas.find((q) => q.source === 'claude')
  assert.ok(claude)
  assert.equal(claude.promptCache?.text,
    'Prompt-Cache warm · läuft ab in 3 m 40 s (1 h TTL) · Trefferquote 87 %')
  // This window resets before the fit runs it empty, so it is the "ends at" sentence.
  const forecast = claude.windows[0].forecast
  assert.equal(forecast?.state, 'resetsFirst')
  assert.match(forecast?.text ?? '', /^~endet bei \d+ % beim Reset$/, forecast?.text)

  const broken = german(() => buildViewModel(makeInput({
    quotas: [state('claude', { ok: false, windows: [], problem: undefined, problemKind: 'noFile' })],
  })))
  const card = broken.quotas.find((q) => q.source === 'claude')
  assert.equal(card?.problem, 'nicht verfügbar')
  assert.deepEqual(card?.problemAction, { label: 'Verlauf neu einlesen', command: 'tokenPace.rescan' })
})

test('the state word is not repeated in German, and "reset due" keeps its verb away', () => {
  const exhausted = german(() => buildViewModel(makeInput({
    quotas: [state('claude', { windows: [win({ percent: 100 })] })],
  })))
  const w = exhausted.quotas[0].windows[0]
  assert.equal(w.verdict.text, 'erschöpft')
  // The verdict beside it already says the word, so the state adds nothing.
  assert.equal(w.stateText, '')

  // A reset that has passed with no newer reading: one sentence, never "Reset Reset fällig".
  const due = german(() => buildViewModel(makeInput({
    quotas: [state('claude', {
      fetchedAt: Math.round((NOW - 3 * 3_600_000) / 1000),
      windows: [win({ resetsAt: NOW - 60_000 })],
    })],
  })))
  const d = due.quotas[0].windows[0]
  assert.equal(d.resetLine, 'Reset fällig')
  assert.equal(d.stateText, '')
  assert.equal(d.explain.title, 'Warum grau')
})

test('the pace unit stays "%" in German — no view ever says "Punkte"', () => {
  const history = makeHistory()
  fillHistory(history)
  const vm = german(() => buildViewModel(makeInput({
    history, cfg: makeConfig({ 'tokenPace.calibration.show': true }),
    quotas: [state('claude', { windows: [win({ percent: 90 })] }), state('codex')],
  })))
  const texts = [
    ...vm.quotas.flatMap((q) => q.windows.flatMap((w) => [w.verdict.text, ...w.explain.lines])),
    ...vm.retro.map((r) => r.text),
    ...vm.dataQuality.calibration.map((c) => c.text),
    ...vm.digest,
    ...vm.footnotes,
  ]
  assert.ok(texts.some((s) => s.includes('% dem Tempo voraus')), JSON.stringify(texts))
  for (const s of texts) assert.doesNotMatch(s, /\bPunkte?n?\b/i, s)
})

test('the number and money formatters follow the locale and go back to en-US', () => {
  assert.equal(compact(12_345), '12.3K')
  assert.equal(full(1_234_567), '1,234,567')
  assert.equal(usd(12.5), '$12.50')
  assert.equal(money(1234.5, 'USD'), '$1,235')
  german(() => {
    assert.equal(compact(12_345), '12,3K')
    assert.equal(full(1_234_567), '1.234.567')
    assert.equal(usd(12.5), '$12,50')
    assert.match(money(1234.5, 'USD'), /1\.235/)
  })
  assert.equal(compact(12_345), '12.3K')
  assert.equal(full(1_234_567), '1,234,567')
})

test('a verdict built in German is the same judgement, only in other words', () => {
  const english = paceVerdict(50, 30, { sensitivity: 'normal', tolerancePoints: 0, minElapsedPercent: 3, levels: 'binary' })
  const de = german(() => paceVerdict(50, 30, { sensitivity: 'normal', tolerancePoints: 0, minElapsedPercent: 3, levels: 'binary' }))
  assert.equal(english.text, '20 % ahead of pace')
  assert.equal(de.text, '20 % dem Tempo voraus')
  assert.equal(de.level, english.level)
  assert.equal(de.points, english.points)
})
