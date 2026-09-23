// SPDX-FileCopyrightText: 2026 Frederik Marx
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The text views, the status bar words and the native dialogs in another language.
 *
 * Every other test in this repository asserts English and runs with an empty bundle, which
 * proves that `t()` falls back — but not that anything would ever change. So this file
 * installs a small German bundle *after* the modules are loaded and looks for the German in
 * what they render. That is the whole point of the seam: a table built at module load would
 * still be English here, and three of these modules used to have one.
 *
 * It also pins the two rules that must not be decided by reading English words at runtime:
 * a reset that has passed, and a retrospective without a complete cycle.
 */

import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import type { RunningItem } from '../src/agentTree'
import { ConsentUi, disclosure, NetworkConsent, writeConsentDisclosure } from '../src/consent'
import { toMarkdownSummary } from '../src/exporter'
import { setBundle, setLocale } from '../src/i18n'
import {
  buildItems, previewItems, problemView, quotaTooltip, StatusTextInput, makeContext, summaryTooltip,
  tokenTooltip,
} from '../src/statusText'
import { bridgeBlocksDelete, deleteWarning, inventory, labelOf, MementoLike } from '../src/storage'
import { markdownDocument, quickPickItems } from '../src/textViews'
import { QuotaState } from '../src/types'
import { buildViewModel, ViewModel } from '../src/viewModel'
import {
  NOW, agentShareAgg, buildAgg, fillHistory, makeConfig, makeHistory, makeInput, state, win,
} from './fixtures/viewFixtures'

/**
 * A handful of real entries from `l10n/parts/text.de.json`. Deliberately not the whole file:
 * the test is about the seam reaching every renderer, and a bundle small enough to read makes
 * a failure say which string did not go through it.
 */
const DE: Record<string, string> = {
  'Quota': 'Kontingent',
  'Key figures': 'Kennzahlen',
  'Data quality': 'Datenqualität',
  'Sessions': 'Sitzungen',
  'Token Pace — usage': 'Token Pace — Verbrauch',
  '| Window | Used | Elapsed | Pace | Resets | Forecast |':
    '| Fenster | Verbraucht | Verstrichen | Tempo | Reset | Prognose |',
  '| Window | Used | Elapsed | Pace | Resets |':
    '| Fenster | Verbraucht | Verstrichen | Tempo | Reset |',
  'Open dashboard': 'Dashboard öffnen',
  'Fetch quota now': 'Kontingent jetzt abrufen',
  'stale': 'veraltet',
  'Updated {0} · {1}': 'Aktualisiert {0} · {1}',
  'polled': 'abgerufen',
  'Fetch now': 'Jetzt abrufen',
  'no token': 'kein Token',
  'No credentials were found, so the quota cannot be polled.':
    'Es wurden keine Zugangsdaten gefunden, daher lässt sich das Kontingent nicht abrufen.',
  '{0} — quota unavailable': '{0} — Kontingent nicht verfügbar',
  'resets {0}': 'Reset {0}',
  'reset due': 'Reset fällig',
  '[preview]': '[Vorschau]',
  'Allow': 'Erlauben',
  'Never': 'Nie',
  'Allow Token Pace to fetch quota figures?': 'Token Pace erlauben, Kontingentwerte abzurufen?',
  'Token counts are read from local transcript files and need no network access. Quota percentages do.':
    'Die Token-Zahlen werden aus lokalen Transkriptdateien gelesen und brauchen keinen Netzwerkzugriff. Die Kontingent-Prozentwerte schon.',
  'If you allow it, then at most every {0} minutes (tokenPace.pollIntervalMinutes):':
    'Wenn Sie es erlauben, dann höchstens alle {0} Minuten (tokenPace.pollIntervalMinutes):',
  'What changes:': 'Was sich ändert:',
  'Token snapshot (state.json)': 'Token-Snapshot (state.json)',
  'Consent decisions': 'Zustimmungsentscheidungen',
  'The token snapshot is rebuilt from the transcript files that are still on disk. Claude Code deletes those after 30 days, so any usage history older than that is lost for good.':
    'Der Token-Snapshot wird aus den Transkriptdateien neu aufgebaut, die noch auf der Platte liegen. Claude Code löscht diese nach 30 Tagen, sodass jeder ältere Verbrauchsverlauf endgültig verloren ist.',
  'Run "Token Pace: Disconnect Claude Status Line" first — clearing files here does not restore Claude Code\'s settings.json.':
    'Führen Sie zuerst „Token Pace: Claude-Statuszeile trennen“ aus — das Löschen von Dateien hier stellt die settings.json von Claude Code nicht wieder her.',
  'Tokens — {0}': 'Token — {0}',
  'Summary': 'Zusammenfassung',
  // 1.6 N7: the subagent share under the window table, and the data-quality line with its note.
  'Subagents {0} of {1} counted here ({2})': 'Subagenten {0} von {1} hier gezählt ({2})',
  '{0}: subagents {1} of {2} counted here ({3})': '{0}: Subagenten {1} von {2} hier gezählt ({3})',
  'Agent records, last 7 days': 'Agent-Datensätze, letzte 7 Tage',
  'Subagent tokens in the hour buckets, last 7 days': 'Subagent-Token in den Stunden-Buckets, letzte 7 Tage',
  'The two differ by construction: a record keeps a whole agent, a bucket the hour of each reply.':
    'Die beiden unterscheiden sich systembedingt: Ein Datensatz umfasst einen ganzen Agenten, ein Bucket die Stunde jeder Antwort.',
  // 1.6 O1: the running agents in the status bar.
  '~{0} running': '~{0} laufen',
  '~1 running': '~1 läuft',
  'Agents running now — inferred from their transcripts (changed within the last 10 minutes, no result recorded).':
    'Agenten, die gerade laufen — abgeleitet aus ihren Transkripten (in den letzten 10 Minuten geändert, kein Ergebnis aufgezeichnet).',
  'and {0} more': 'und {0} weitere',
  'Token Pace — running agents': 'Token Pace — laufende Agenten',
}

/** The seam is module state; every test that changes it puts it back. */
function german<T>(run: () => T): T {
  try {
    setBundle(DE)
    setLocale('de')
    return run()
  } finally {
    setBundle(undefined)
    setLocale(undefined)
  }
}

function fullVm(): ViewModel {
  const history = makeHistory()
  fillHistory(history)
  return buildViewModel(makeInput({
    history,
    cfg: makeConfig({ 'tokenPace.attribution': 'project' }),
    agg: buildAgg('project'),
  }))
}

function statusInput(quotas: QuotaState[]): StatusTextInput {
  return {
    quotas, agg: buildAgg(), cfg: makeConfig({}), now: NOW, forecasts: new Map(),
    role: 'single', scanning: false, consent: 'granted',
  }
}

// ---------------------------------------------------------------------------
// The two text views
// ---------------------------------------------------------------------------

test('the markdown document and the QuickPick are rendered in the bundle language', () => {
  const vm = fullVm()
  const { md, items } = german(() => ({ md: markdownDocument(vm), items: quickPickItems(vm) }))

  assert.ok(md.startsWith('# Token Pace — Verbrauch'), md.slice(0, 60))
  for (const heading of ['## Kontingent', '## Kennzahlen', '## Datenqualität']) {
    assert.ok(md.includes(heading), heading)
  }
  assert.ok(md.includes('| Fenster | Verbraucht | Verstrichen | Tempo | Reset | Prognose |'))
  // A heading whose German is not in this bundle stays English rather than disappearing.
  assert.ok(md.includes('## Models'))

  assert.equal(items[0].label, 'Dashboard öffnen')
  assert.ok(items.some((i) => i.separator && i.label === 'Kontingent'), 'the group heading')
  assert.ok(items.some((i) => i.label === 'Kontingent jetzt abrufen'), 'the action row')

  // And with no bundle the very same call is English again.
  assert.ok(markdownDocument(vm).startsWith('# Token Pace — usage'))
  assert.equal(quickPickItems(vm)[0].label, 'Open dashboard')
})

test('the subagent share under the window table and the data-quality line follow the bundle (1.6 N7)', () => {
  const md = german(() => markdownDocument(buildViewModel(makeInput({ agg: agentShareAgg() }))))
  assert.ok(md.includes('- 5 h: Subagenten 5,5K von 7K hier gezählt (79 %)'), md)
  assert.ok(md.includes('- 7 d: Subagenten 5,5K von 11K hier gezählt (50 %)'), md)
  assert.ok(md.includes('- Agent-Datensätze, letzte 7 Tage: 7,5K · Subagent-Token in den Stunden-Buckets, letzte 7 Tage: 5,5K'), md)
  assert.ok(md.includes('- Die beiden unterscheiden sich systembedingt: Ein Datensatz umfasst einen ganzen Agenten, ein Bucket die Stunde jeder Antwort.'), md)
  assert.equal(/subagents|counted here|Agent records/.test(md), false, md)
})

test('the clipboard summary follows the bundle too', () => {
  const vm = fullVm()
  const md = german(() => toMarkdownSummary(vm))
  assert.ok(md.includes('| Fenster | Verbraucht | Verstrichen | Tempo | Reset |'), md.slice(0, 400))
  assert.ok(/## Token — /.test(md), 'the totals heading')
  assert.equal(toMarkdownSummary(vm).includes('| Fenster |'), false)
})

// ---------------------------------------------------------------------------
// The status bar
// ---------------------------------------------------------------------------

test('the status bar text, its tooltip and the preview follow the bundle', () => {
  const ok = state('claude', {
    windows: [win({ percent: 42, resetsAt: NOW + 3_600_000 })],
    fetchedAt: Math.floor(NOW / 1000) - 300,
  })
  const input = statusInput([ok])
  const items = german(() => buildItems(input))
  assert.ok(items[0].text.includes('Reset 1h'), items[0].text)
  assert.equal(items[0].text.includes('resets'), false, items[0].text)
  assert.ok(items[0].tooltipMarkdown.includes('| Fenster | Verbraucht |'), 'the tooltip table head')
  assert.ok(items[0].tooltipMarkdown.includes('Aktualisiert 5 min ago · abgerufen'), 'the freshness line')
  assert.ok(items[0].tooltipMarkdown.includes('[Jetzt abrufen](command:tokenPace.refreshQuota)'))

  // The vocabulary that used to live in a module-level table.
  const broken = state('claude', { ok: false, problemKind: 'noToken', fetchedAt: null, windows: [] })
  const problem = german(() => problemView(broken, makeConfig({}), NOW))
  assert.equal(problem.message, 'kein Token')
  assert.match(problem.explain, /^Es wurden keine Zugangsdaten/)
  const tooltips = german(() => ({
    quota: quotaTooltip(ok, makeContext(input)),
    summary: summaryTooltip(['claude'], makeContext(statusInput([broken]))),
    tokens: tokenTooltip(makeContext(input), 'tokens'),
  }))
  assert.ok(tooltips.quota.includes('| Fenster |'))
  assert.ok(tooltips.summary.includes('Claude Code — Kontingent nicht verfügbar'))
  assert.ok(tooltips.tokens.includes('[Jetzt abrufen]'))

  // The preview mark is a word, not a glyph, so it is translated as well.
  const preview = german(() => previewItems(makeConfig({}), NOW))
  assert.ok(preview.every((i) => i.text.startsWith('[Vorschau] ')), preview[0].text)
  assert.ok(previewItems(makeConfig({}), NOW).every((i) => i.text.startsWith('[preview] ')))
})

test('the running agents in the status bar speak German, and every word is the bundle\'s own (1.6 O1)', () => {
  const item = (n: number): RunningItem => ({
    key: `a:a${n}`, kind: 'agent', label: `Explore · opus-5 · 10${n}`, fullLabel: `Explore · claude-opus-5 · 10${n}`,
    context: 'Sitzung 9d0eb37a', usage: '1K', lowerBound: false, lowerBoundText: null, startTs: NOW - 60_000,
    lastTs: NOW, startClock: null, lastClock: null, waiting: false, silence: false, running: 1,
  })
  const on = makeConfig({ 'tokenPace.statusBar.show': ['agents'] })
  const of = (n: number, more = 0): ReturnType<typeof buildItems>[number] => german(() => buildItems({
    ...statusInput([]), cfg: on, agents: { running: n + more, now: Array.from({ length: n }, (_, i) => item(i)), more },
  }))[0]
  assert.equal(of(3).text, '~3 laufen')
  assert.equal(of(1).text, '~1 läuft')
  assert.equal(of(1).name, 'Token Pace — laufende Agenten')
  assert.equal(of(1234).text, '~1.234 laufen', 'the count in German digits')
  const tip = of(7, 2).tooltipMarkdown
  assert.ok(tip.startsWith('Agenten, die gerade laufen — abgeleitet aus ihren Transkripten'), tip)
  assert.ok(tip.split('\n').includes('und 4 weitere'), tip)
  // Every word of the entry is the committed bundle's, not only this file's excerpt of it.
  const bundle = JSON.parse(readFileSync(join(__dirname, '..', 'l10n', 'bundle.l10n.de.json'), 'utf8')) as Record<string, string>
  for (const key of ['~{0} running', '~1 running', 'Token Pace — running agents', 'and {0} more',
    'Agents running now — inferred from their transcripts (changed within the last 10 minutes, no result recorded).']) {
    assert.equal(bundle[key], DE[key], key)
  }
})

test('a reset that has passed keeps its own sentence in any language', () => {
  // The rule used to search the formatted reset for the English words "reset due"; the
  // countdown is translated, so it is asked of the clock instead.
  const due = state('claude', {
    windows: [win({ percent: 88, resetsAt: NOW - 60_000, limitReached: true })],
    fetchedAt: Math.floor(NOW / 1000) - 60,
  })
  const text = german(() => buildItems(statusInput([due]))[0].text)
  assert.ok(text.includes('Reset fällig'), text)
  assert.equal(text.includes('Reset Reset fällig'), false, text)
  // English, same window: the word is attached only when there is a countdown to attach it to.
  assert.ok(buildItems(statusInput([due]))[0].text.includes('reset due'))
})

// ---------------------------------------------------------------------------
// The dialogs and the inventory
// ---------------------------------------------------------------------------

test('the consent dialog asks, and compares its answer, in the bundle language', async () => {
  const shown: { message: string; detail: string; items: string[] }[] = []
  const ui: ConsentUi = {
    showInformationMessage(message, options, ...items) {
      shown.push({ message, detail: options.detail ?? '', items })
      // The user clicks the button as it was labelled — which is the German one.
      return Promise.resolve(items[0])
    },
  }
  const store = new Map<string, unknown>()
  const memento: MementoLike = {
    get: <T>(key: string, dflt: T): T => (store.has(key) ? (store.get(key) as T) : dflt),
    update: (key, value) => { store.set(key, value); return Promise.resolve() },
  }
  const consent = new NetworkConsent(memento, () => {}, { ui, intervalMinutes: () => 45 })

  setBundle(DE)
  try {
    assert.equal(await consent.request(), true, 'the translated Allow was not recognised')
  } finally {
    setBundle(undefined)
  }
  assert.equal(store.get('networkConsent'), 'granted')
  assert.equal(shown[0].message, 'Token Pace erlauben, Kontingentwerte abzurufen?')
  assert.deepEqual(shown[0].items, ['Erlauben', 'Nie'])
  assert.match(shown[0].detail, /^Die Token-Zahlen werden aus lokalen Transkriptdateien/)
  assert.match(shown[0].detail, /höchstens alle 45 Minuten/)
  // The address is not a sentence and does not move.
  assert.match(shown[0].detail, /https:\/\/api\.anthropic\.com\/api\/oauth\/usage(?![\w./-])/)
})

test('the write disclosure and the stored-data labels follow the bundle', () => {
  const text = german(() => writeConsentDisclosure('statusLine', { settingsFile: '/s.json' }))
  assert.ok(text.includes('Was sich ändert:'), text.slice(0, 200))
  assert.ok(text.includes('/s.json'), 'the path is data, not a word')
  assert.equal(writeConsentDisclosure('statusLine').includes('Was sich ändert:'), false)

  const labels = german(() => [labelOf('state'), labelOf('consent')])
  assert.deepEqual(labels, ['Token-Snapshot (state.json)', 'Zustimmungsentscheidungen'])
  assert.equal(labelOf('state'), 'Token snapshot (state.json)')

  // The inventory takes its labels from the same function, so a pick list is never half English.
  const paths = {
    state: '/nowhere/state.json', quota: '/nowhere/quota.json', history: '/nowhere/h.json',
    leader: '/nowhere/leader.json', mirror: '/nowhere/m.json',
  }
  const empty: MementoLike = { get: <T>(_k: string, d: T): T => d, update: () => Promise.resolve() }
  const items = german(() => inventory(paths, empty))
  assert.equal(items[0].label, 'Token-Snapshot (state.json)')

  const warnings = german(() => [deleteWarning(), bridgeBlocksDelete()])
  assert.match(warnings[0], /^Der Token-Snapshot wird aus den Transkriptdateien/)
  assert.match(warnings[1], /Claude-Statuszeile trennen/)
  assert.match(deleteWarning(), /^The token snapshot is rebuilt/)
})

test('the network disclosure keeps the interval it is given in either language', () => {
  assert.match(disclosure(45), /every 45 minutes/)
  const de = german(() => disclosure(45))
  assert.match(de, /höchstens alle 45 Minuten/)
  // Placeholders are filled, never left in the text.
  assert.equal(de.includes('{0}'), false)
})
