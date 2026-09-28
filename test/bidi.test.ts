// SPDX-FileCopyrightText: 2026 Frederik Marx
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * 1.13 A3 (§0a.3, §7a Q5, Q7–Q11, Q29): the bidi format characters Token Pace hands to VS Code — src/bidi.ts writes
 * them, src/hostUi.ts is the one door they go through to a message, a dialog, a Quick Pick, an InputBox or a progress
 * notification, and statusText.ts `finishItems` puts them on the bar.
 *
 *  • the static tests: no literal control in any file of src/ (VS Code 1.62's Trojan Source rule), VS Code's message,
 *    Quick Pick, InputBox and progress API named in src/hostUi.ts alone, the bar's three item owners;
 *  • the page's grammar and the host's one: FIGURE_GRAMMAR string for string, and FIGURE_RE and the page's FIGURE_RUN
 *    finding the same units over the bar's own texts;
 *  • the isolate test (A3 rule 9): (a) the bar under the pseudo-RTL bundle in ar, he and fa — every ItemSpec kind,
 *    the preview, both tooltip modes —, (b) every t() key of the bundle through the three helpers (balanced, depth
 *    ≤ 3, idempotent, lossless), (d) English and German byte for byte; (c), the fake vscode in Arabic, is
 *    test/extension.test.ts's (the activation's fixture lives there — a test file imported by another would run its
 *    tests twice) and test/keepWarmHost.test.ts's (the countdown item);
 *  • the door's own functions over a fake window;
 *  • the leak test of §0a.3: the diagnostics, the exports, the markdown document, the clipboard summary, a
 *    notification's JSON data fields, the view model and every accessible name carry no control.
 *
 * The memory rule (1.13 §0b.10): every text is built once and compared as a string; the loops over a bundle are bounded
 * by its keys (1306), the worlds by their lists. The pseudo-RTL bundle is made in memory (test/helpers/nls.ts
 * pseudoRtlBundle) and never written into l10n/.
 */

import { strict as assert } from 'node:assert'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import * as nodeVm from 'node:vm'
import { after, test } from 'node:test'
import script from 'webview:script'
import {
  BIDI_CONTROLS, FIGURE_GRAMMAR, FIGURE_NAME_UNIT, FIGURE_RE, isolate, isolateLines, isolateMarkdown, itemAriaLabel, LRI,
  leadRtl, MARKDOWN_LINE_KINDS, PDI, RLI, RLM, rangeArrow, stripBidi,
} from '../src/bidi'
import type { BudgetRow } from '../src/budget'
import type { CacheWatchEntry } from '../src/cacheWatch'
import { sanitize } from '../src/config'
import { buildDiagnostics, DiagnosticsInput } from '../src/diagnostics'
import { toCsv, toJson, toMarkdownSummary } from '../src/exporter'
import { hostUiOf, inputOptions, messageTexts, pickItems, pickOptions, WindowApi } from '../src/hostUi'
import { dir, setBundle, setDir, setLang, setLocale } from '../src/i18n'
import { intlTag, languageEntry, LanguageId } from '../src/languages'
import { NotificationEvent, payloadOf, testPayload } from '../src/notify'
import { money } from '../src/render'
import { buildItems, finishItems, ItemModel, previewItems, StatusTextInput, UsageSource } from '../src/statusText'
import { markdownDocument } from '../src/textViews'
import { emptyBucket, Forecast, QuotaState, QuotaWindow } from '../src/types'
import { buildViewModel } from '../src/viewModel'
import { buildAgg, fillHistory, makeConfig, makeHistory, makeInput, NOW, timeConfig, TODAY } from './fixtures/viewFixtures'
import { ROOT, pseudoRtlBundle } from './helpers/nls'

const FSI = String.fromCharCode(0x2068)
const NBSP = String.fromCharCode(0xa0)
const RTL_IDS: readonly LanguageId[] = ['ar', 'he', 'fa']
const J = JSON.stringify

/** Once per file: the pseudo-RTL bundle (every word كلمة, every → a ←, the names and the code kept). */
const PSEUDO = pseudoRtlBundle()
const GERMAN = JSON.parse(readFileSync(join(ROOT, 'l10n', 'bundle.l10n.de.json'), 'utf8')) as Record<string, string>

/** The words, the formats and the direction of one language — the four setters applyLanguage calls. */
function wordsOf(id: LanguageId | 'en', bundle: Record<string, string> | undefined): void {
  setBundle(bundle)
  setLocale(id === 'en' ? undefined : intlTag(languageEntry(id).locale, id))
  setLang(id === 'en' ? undefined : id)
  setDir(id === 'en' ? undefined : languageEntry(id).dir)
}

function pristine(): void {
  setBundle(undefined)
  setLocale(undefined)
  setLang(undefined)
  setDir(undefined)
}

after(pristine)

/** The RTL languages with a bundle on disk (none before group N) — the isolate test runs over each besides the pseudo one. */
const RTL_ON_DISK: ReadonlyArray<readonly [LanguageId, Record<string, string>]> = RTL_IDS
  .filter((id) => existsSync(join(ROOT, 'l10n', `bundle.l10n.${id}.json`)))
  .map((id) => [id, JSON.parse(readFileSync(join(ROOT, 'l10n', `bundle.l10n.${id}.json`), 'utf8')) as Record<string, string>] as const)

/** The worlds of the isolate test: the pseudo bundle under each of the three ids, then each bundle on disk under its own. */
const RTL_WORLDS: ReadonlyArray<readonly [string, LanguageId, Record<string, string>]> = [
  ...RTL_IDS.map((id) => [`pseudo-RTL under ${id}`, id, PSEUDO] as const),
  ...RTL_ON_DISK.map(([id, bundle]) => [id, id, bundle] as const),
]

/** A text's isolates: balanced (each LRI, RLI or FSI closed by its PDI, never a PDI too many) and at most `max` deep. */
function balance(s: string): { ok: boolean; depth: number } {
  let depth = 0
  let deepest = 0
  for (const c of s) {
    if (c === LRI || c === RLI || c === FSI) { depth++; deepest = Math.max(deepest, depth) } else if (c === PDI) {
      depth--
      if (depth < 0) return { ok: false, depth: deepest }
    } else if (c === '\n' && depth !== 0) return { ok: false, depth: deepest }
  }
  return { ok: depth === 0, depth: deepest }
}

const CODICON = /\$\([\w~-]+\)/g
const LEADING_ICONS = /^(?:\$\([\w~-]+\)[  ]*)*/u

/** The units FIGURE_RE finds in a plain text, as isolate makes them (a name only with a connector), icons blanked. */
function unitsIn(plain: string): string[] {
  const blanked = plain.replace(CODICON, (m) => ' '.repeat(m.length))
  return [...blanked.matchAll(FIGURE_RE)].filter((m) => m.groups?.name === undefined || FIGURE_NAME_UNIT.test(m[0]))
    .map((m) => m[0]).filter((u) => u !== '')
}

/**
 * A text VS Code draws, as isolate must have made it (A3 rules 2–4): its leading icons, then RLI (never FSI — the
 * first strong character of a pseudo text is often the L of "Claude"), each figure run of the text inside LRI … PDI,
 * PDI — or, without a letter to lay out, the text as it was. Returns the problems.
 */
function isolatedProblems(s: string, what: string): string[] {
  const out: string[] = []
  const plain = stripBidi(s)
  const icons = LEADING_ICONS.exec(s)?.[0] ?? ''
  const rest = s.slice(icons.length)
  if (!/\p{L}/u.test(plain.slice(icons.length).replace(CODICON, ''))) {
    if (s !== plain) out.push(`${what}: a text without a word carries marks: ${J(s)}`)
    return out
  }
  if (rest[0] !== RLI) out.push(`${what}: does not open with RLI after its icons: ${J(s)}`)
  if (!rest.endsWith(PDI)) out.push(`${what}: does not close with PDI: ${J(s)}`)
  const b = balance(s)
  if (!b.ok || b.depth > 3) out.push(`${what}: unbalanced or deeper than 3: ${J(s)}`)
  for (const unit of unitsIn(plain.slice(icons.length))) {
    if (!s.includes(LRI + unit + PDI)) out.push(`${what}: the figure run ${J(unit)} is not a left-to-right unit: ${J(s)}`)
  }
  return out
}

/** A test's own reading of a markdown text's lines (A3 rule 5): the kind of each, a table row with its cell count. */
function lineKinds(md: string): string[] {
  let fenced = false
  return md.split('\n').map((line) => {
    if (/^ {0,3}(?:```|~~~)/.test(line)) { fenced = !fenced; return 'fence' }
    if (fenced) return 'code'
    if (line.trim() === '') return 'blank'
    if (/^ *\|?(?: *:?-{3,}:? *\|)+ *(?::?-{3,}:? *)?$/.test(line)) return 'separator'
    if (line.trimStart().startsWith('|')) return `row:${line.replace(/\\\|/g, '').split('|').length}`
    if (/^ {0,3}[-*+][ \t]+/.test(line)) return 'item'
    if (/^ {0,3}\d{1,9}[.)][ \t]+/.test(line)) return 'numbered'
    if (/^ {0,3}#{1,6}[ \t]/.test(line)) return 'heading'
    return 'paragraph'
  })
}

/**
 * markdown-it (a dependency of @vscode/vsce, CommonMark with GFM tables — the kind of renderer VS Code's hover uses):
 * the rendered HTML of a tooltip, marks and all, taken off again — it must be the plain tooltip's, so that no mark
 * changed what the markdown is (a list item, a table, an emphasis, a link). Null when the package is not installed.
 */
const markdownIt: ((md: string) => string) | null = (() => {
  try {
    const MarkdownIt = createRequire(__filename)('markdown-it') as new (o: Record<string, unknown>) => { render(md: string): string }
    const md = new MarkdownIt({ html: true, linkify: false, breaks: false })
    return (text: string) => md.render(text)
  } catch {
    return null
  }
})()

/** Rule 5's structure test for one tooltip: lossless, the same line kinds, the same rendered markdown; the problems. */
function structureProblems(isolated: string, plain: string, what: string): string[] {
  const out: string[] = []
  if (stripBidi(isolated) !== plain) out.push(`${what}: stripBidi of the isolated tooltip is not the tooltip`)
  const a = lineKinds(isolated)
  const b = lineKinds(plain)
  if (J(a) !== J(b)) {
    const at = a.findIndex((k, i) => k !== b[i])
    out.push(`${what}: line ${at + 1} is a ${a[at]} and was a ${b[at]}: ${J(isolated.split('\n')[at])}`)
  }
  if (markdownIt) {
    const shown = stripBidi(markdownIt(isolated))
    const want = markdownIt(plain)
    if (shown !== want) {
      const at = [...want].findIndex((c, i) => c !== [...shown][i])
      out.push(`${what}: the rendered markdown differs at ${at}: ${J(want.slice(Math.max(0, at - 60), at + 60))} → ${J(shown.slice(Math.max(0, at - 60), at + 60))}`)
    }
  }
  return out
}

/** Each line of an isolated tooltip that has a word to lay out carries its RLI (a tooltip left out is a finding). */
function tooltipIsolatedProblems(isolated: string, what: string): string[] {
  const out: string[] = []
  const kinds = lineKinds(stripBidi(isolated))
  isolated.split('\n').forEach((line, i) => {
    const plain = stripBidi(line).replace(CODICON, '').replace(/\]\([^)]*\)/g, ']').replace(/<[^>]*>/g, '').replace(/`[^`]*`/g, '')
    if (!['paragraph', 'item', 'heading', 'numbered'].includes(kinds[i]) && !kinds[i].startsWith('row:')) return
    if (/\p{L}/u.test(plain) && !line.includes(RLI)) out.push(`${what}: line ${i + 1} is not isolated: ${J(line)}`)
  })
  return out
}

// ---------------------------------------------------------------------------
// Static: the escapes, the one door, the bar's owners
// ---------------------------------------------------------------------------

/** Every `.ts` file under src/, relative, sorted. */
function srcFiles(dir = join(ROOT, 'src'), rel = 'src'): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? srcFiles(join(dir, e.name), `${rel}/${e.name}`)
    : e.name.endsWith('.ts') ? [`${rel}/${e.name}`] : [])).sort()
}

const { codeOf } = createRequire(__filename)(join(ROOT, 'scripts', 'check-privacy.mjs')) as {
  codeOf: (src: string) => { code: string; bare: string }
}

/** VS Code's API names the door alone may use (§3 A3 rule 8). */
export const DOOR_API = ['showInformationMessage', 'showWarningMessage', 'showErrorMessage', 'showQuickPick', 'createQuickPick',
  'showInputBox', 'createInputBox', 'withProgress'] as const
const DOOR_API_RE = new RegExp(`(?<![\\w$])(?:${DOOR_API.join('|')})(?![\\w$])`, 'g')

/** Every place a source names one of `names` in its code (comments and strings blanked): `file:line name`. */
function namedIn(file: string, text: string, re: RegExp): string[] {
  const { bare } = codeOf(text)
  return [...bare.matchAll(re)].map((m) => `${file}:${text.slice(0, m.index).split('\n').length} ${m[0]}`)
}

test('1.13 §0a.3 (static, the Trojan Source rule of VS Code 1.62): no file of src/ holds a bidi control as a character — src/bidi.ts writes each as an escape', () => {
  const found: string[] = []
  for (const f of srcFiles()) {
    const text = readFileSync(join(ROOT, f), 'utf8')
    text.split('\n').forEach((line, i) => { if (BIDI_CONTROLS.test(line)) found.push(`${f}:${i + 1}`) })
  }
  assert.deepEqual(found, [])
  // And bidi.ts's constants are the characters, written as escapes.
  const own = readFileSync(join(ROOT, 'src', 'bidi.ts'), 'utf8')
  for (const [name, code] of [['LRI', '2066'], ['RLI', '2067'], ['PDI', '2069'], ['RLM', '200F']]) {
    assert.ok(own.includes(`export const ${name} = '\\u${code}'`), name)
  }
  assert.deepEqual([LRI, RLI, PDI, RLM].map((c) => c.codePointAt(0)), [0x2066, 0x2067, 0x2069, 0x200f])
})

test('1.13 A3 rule 8 (static, §7a Q8): VS Code\'s message, Quick Pick, InputBox and progress API is named in src/hostUi.ts alone — every other file reaches it through the door; the bar\'s items are made by its three owners', (t) => {
  const files = srcFiles()
  const outside = files.filter((f) => f !== 'src/hostUi.ts')
    .flatMap((f) => namedIn(f, readFileSync(join(ROOT, f), 'utf8'), DOOR_API_RE))
  assert.deepEqual(outside, [], 'a site outside the door — through src/hostUi.ts, please')
  // The door itself: each call of the API it makes, printed for the review (§5, Review 2: "the static test's list").
  const door = namedIn('src/hostUi.ts', readFileSync(join(ROOT, 'src', 'hostUi.ts'), 'utf8'), DOOR_API_RE)
  for (const line of door) t.diagnostic(line)
  assert.deepEqual([...new Set(door.map((l) => l.split(' ')[1]))].sort(),
    ['createQuickPick', 'showErrorMessage', 'showInformationMessage', 'showInputBox', 'showQuickPick', 'showWarningMessage', 'withProgress'])
  // The callers: every file with a message, a pick or a progress of its own imports the door.
  for (const f of ['src/alerts.ts', 'src/bridge.ts', 'src/consent.ts', 'src/extension.ts', 'src/nativeViews.ts', 'src/notifyHost.ts',
    'src/promptsHost.ts', 'src/statusbar.ts']) {
    assert.match(readFileSync(join(ROOT, f), 'utf8'), /from '\.\/hostUi'/, f)
  }
  // The bar's owners (A3 rule 1): statusbar.ts (the items of buildItems/previewItems, isolated by finishItems), the
  // keep-warm countdown and the scan's item — each of the last two isolates its own texts.
  const owners = files.flatMap((f) => namedIn(f, readFileSync(join(ROOT, f), 'utf8'), /(?<![\w$])createStatusBarItem(?![\w$])/g))
  assert.deepEqual([...new Set(owners.map((l) => l.split(':')[0]))], ['src/extension.ts', 'src/keepWarmHost.ts', 'src/statusbar.ts'])
  for (const f of ['src/extension.ts', 'src/keepWarmHost.ts']) assert.match(readFileSync(join(ROOT, f), 'utf8'), /\.text = isolate\(/, f)
  const statusText = readFileSync(join(ROOT, 'src', 'statusText.ts'), 'utf8')
  assert.equal((statusText.match(/return finishItems\(/g) ?? []).length, 2, 'buildItems and previewItems return through finishItems')
  // The scan finds a new site: a call made in another file, its file and line named.
  assert.deepEqual(namedIn('src/x.ts', 'const a = 1\n// showWarningMessage in a comment\nconst s = \'withProgress\'\nvoid vscode.window.showWarningMessage(m)\n', DOOR_API_RE),
    ['src/x.ts:4 showWarningMessage'])
})

// ---------------------------------------------------------------------------
// The grammar: the page's and the host's
// ---------------------------------------------------------------------------

/** The page's script in a context of its own (it is self-contained; its constants are reached as globals). */
const PAGE = ((): nodeVm.Context => {
  const c = nodeVm.createContext({
    acquireVsCodeApi: () => ({ postMessage: () => undefined }),
    document: { addEventListener: () => undefined, getElementById: () => null, querySelector: () => null, querySelectorAll: () => [] },
    window: { addEventListener: () => undefined },
    console,
  })
  nodeVm.runInContext(script, c)
  return c
})()

/** The page's units of a text (FIGURE_RUN, a name only as FIGURE_NAME_UNIT says) as `kind:unit`. */
function pageUnits(s: string): string[] {
  return JSON.parse(String(nodeVm.runInContext('JSON.stringify(Array.from(' + J(s) + '.matchAll(FIGURE_RUN)).filter(function (m) { return m.groups.name === undefined || FIGURE_NAME_UNIT.test(m[0]); }).map(function (m) { return Object.keys(m.groups).filter(function (k) { return m.groups[k] !== undefined; })[0] + ":" + m[0]; }))', PAGE))) as string[]
}

/** The host's units of a text, as the page's. */
function hostUnits(s: string): string[] {
  return [...s.matchAll(FIGURE_RE)].filter((m) => m.groups?.name === undefined || FIGURE_NAME_UNIT.test(m[0]))
    .map((m) => `${Object.keys(m.groups ?? {}).find((k) => m.groups?.[k] !== undefined)}:${m[0]}`)
}

/** The bar fixture of T15 (l10n/TRANSLATING.md): Monday 2026-09-28 03:46 UTC, 5 h at 25 % resetting 06:00, 7 d at 69 %. */
const BAR_NOW = Date.UTC(2026, 8, 28, 3, 46)
const BAR_RESET = Date.UTC(2026, 8, 28, 6, 0)

function barWindow(p: Partial<QuotaWindow> = {}): QuotaWindow {
  return {
    id: 'session:300', kind: 'session', label: '5 h', shortLabel: '5h', model: null, percent: 25,
    resetsAt: BAR_RESET, windowMinutes: 300, limitReached: false, unlimited: false, ...p,
  }
}

/** A usage source with fixed figures (fresh input, cache, output, a cost), for every period the bar asks for. */
function usage(): UsageSource {
  const b = emptyBucket('claude', 'claude-opus-4-6', false, 'standard', 'd', null, '2026-09-28')
  b.input = 3_100_000
  b.cacheWrite = 300_000
  b.cacheWrite1h = 40_000
  b.cacheRead = 12_400_000
  b.output = 210_000
  b.reasoning = 45_000
  b.requests = 320
  b.outputFinal = 300
  return {
    sum: () => ({ ...b }),
    cost: () => ({ usd: 12.34, listUsd: 12.34, unpricedTokens: 2000, unpricedModels: ['claude-experimental-x'], fastUnpricedTokens: 100,
      familyPriced: ['claude-haiku-3-5'], custom: false }),
  }
}

function forecast(p: Partial<Forecast>): Forecast {
  return { state: 'eta', ratePerHour: 12, etaMs: BAR_NOW + 2 * 3_600_000, endPercent: 140, sustainablePerHour: 9, confidence: 'medium',
    basis: { samples: 6, spanMs: 3_600_000 }, text: '~empty in 2h', ...p }
}

function budgetRow(share: number, over: boolean): BudgetRow {
  return {
    key: 'total:month:usd', identity: 'b1', label: 'All providers · this month', scope: 'total', period: 'month', unit: 'usd',
    from: '2026-09-01', to: '2026-09-28', last: '2026-09-30', limit: 200, limitText: '$200', used: share * 2, usedText: `~$${share * 2}`,
    share, shareText: `${share} %`, over, partial: over, covered: true, projected: 230, projectedText: '~$230', projectionBasis: 'the last 7 days',
    projectedOver: over, unmeasurable: null, text: `All providers · this month: ~$${share * 2} of $200 · ${share} %`,
  } as BudgetRow
}

function cacheEntries(): CacheWatchEntry[] {
  return [
    { sessionId: '9d0eb37a-0000-4000-8000-000000000000', name: 'Session Thu 11:05 · 9d0eb37a', source: 'bridge', ttl: '1h',
      expiresAt: BAR_NOW + 250_000, phase: 'cooling', recache: 152_300, model: 'claude-opus-5-5' },
    { sessionId: '5f1c2d3e-0000-4000-8000-000000000000', name: 'Session Thu 10:02 · 5f1c2d3e', source: 'transcript', ttl: '1h',
      expiresAt: BAR_NOW - 60_000, phase: 'cold', recache: 90_000, model: 'claude-opus-4-6' },
  ]
}

/**
 * The world of the isolate test (A3 rule 9 a): Claude Code with both windows, an extra allowance in dollars and a
 * forecast; Codex without its binary (a problem item); a context reading, two budgets, agents running, a cooling cache,
 * the tokens and the cost — each ItemSpec kind the bar builds, at each density, in each tooltip mode.
 */
function worldInput(settings: Record<string, unknown>): StatusTextInput {
  const cfg = sanitize({
    'tokenPace.timezone': 'utc', 'tokenPace.resetHourCycle': 'h23', 'tokenPace.windowSelect': 'all', 'tokenPace.showCost': true,
    'tokenPace.statusBar.show': ['claudeQuota', 'codexQuota', 'extra', 'forecast', 'context', 'budget', 'agents', 'cache', 'tokens', 'cost'],
    'tokenPace.tooltipExplanations': true, ...settings,
  })
  const claude: QuotaState = {
    source: 'claude', ok: true, origin: 'poll', fetchedAt: Math.floor(BAR_NOW / 1000) - 60, planType: 'max20',
    windows: [barWindow(), barWindow({ id: 'weekly:10080', kind: 'weekly', label: '7 d', shortLabel: '7d', percent: 69, resetsAt: BAR_NOW + 6 * 86_400_000, windowMinutes: 10080 })],
    extra: { enabled: true, utilization: 24, used: 12.5, limit: 50, currency: 'USD', balance: null, unlimited: false, spendLimitReached: false, reason: null },
  } as QuotaState
  const codex = { source: 'codex', ok: false, origin: null, fetchedAt: null, planType: null, windows: [], problemKind: 'noBinary',
    problem: 'codex was not found', nextAttemptAt: BAR_NOW + 12 * 60_000 } as unknown as QuotaState
  return {
    quotas: [claude, codex], agg: usage(), cfg, now: BAR_NOW,
    forecasts: new Map([['claude:session:300', forecast({})], ['claude:weekly:10080', forecast({ state: 'resetsFirst', etaMs: null, endPercent: 88, text: '~88% at reset' })]]),
    role: 'single', scanning: true, consent: 'granted',
    context: { used: 128_000, size: 200_000, usedPct: 64, fetchedAt: Math.floor(BAR_NOW / 1000) - 30 },
    budgets: [budgetRow(38, false), budgetRow(118, true)],
    agents: {
      running: 2, more: 1,
      now: ['Explore', 'Plan'].map((type, i) => ({
        key: `a:w${i}`, kind: 'agent', label: `${type} · opus-4-6 · 3f2${i}`, fullLabel: `${type} · claude-opus-4-6 · 3f2${i}`,
        context: 'Session Thu 11:05 · 9d0eb37a', usage: '12.4K', lowerBound: false, lowerBoundText: null, startTs: BAR_NOW - (i + 2) * 60_000,
        lastTs: BAR_NOW - 20_000, startClock: null, lastClock: null, waiting: false, silence: false, hookWait: null, running: 1,
      })) as never,
    },
    cacheWatch: cacheEntries(),
    promptCache: { warm: true, ttl: '1h', expiresAt: BAR_NOW + 50 * 60_000, hitRatio: 0.82, readAt: Math.floor(BAR_NOW / 1000) - 10,
      sessionId: 'other-session', recacheIfCold: 120_000 } as never,
  }
}

/** Every setting the world is built under: each density, each tooltip mode, the reset formats. */
const WORLD_SETTINGS: ReadonlyArray<Record<string, unknown>> = [
  { 'tokenPace.density': 'full', 'tokenPace.tooltip': 'full', 'tokenPace.resetFormat': 'both' },
  { 'tokenPace.density': 'full', 'tokenPace.tooltip': 'compact', 'tokenPace.resetFormat': 'absolute' },
  { 'tokenPace.density': 'compact', 'tokenPace.tooltip': 'full', 'tokenPace.resetFormat': 'relative' },
  { 'tokenPace.density': 'minimal', 'tokenPace.tooltip': 'compact' },
  { 'tokenPace.density': 'minimal', 'tokenPace.tooltip': 'full', 'tokenPace.windowSelect': 'session' },
]

/** Every item of the world and of the preview, under the words now set. */
function allItems(): ItemModel[] {
  return [...WORLD_SETTINGS.flatMap((s) => buildItems(worldInput(s))), ...previewItems(sanitize({ 'tokenPace.timezone': 'utc', 'tokenPace.resetHourCycle': 'h23' }), BAR_NOW),
    ...previewItems(sanitize({ 'tokenPace.timezone': 'utc', 'tokenPace.tooltip': 'compact' }), BAR_NOW)]
}

test('1.13 A3 rule 3 (§7a Q5): the host\'s FIGURE_GRAMMAR is the page\'s, string for string, and FIGURE_RE finds the units the page\'s FIGURE_RUN finds — over the bar\'s own texts, their tooltips and the grammar\'s cases', () => {
  const page = JSON.parse(String(nodeVm.runInContext('JSON.stringify(FIGURE_GRAMMAR)', PAGE))) as Record<string, string>
  assert.deepEqual(Object.keys(FIGURE_GRAMMAR), ['edge', 'end', 'space', 'range', 'day', 'clock', 'money', 'figure', 'name'])
  assert.deepEqual({ ...FIGURE_GRAMMAR }, page)
  assert.equal(FIGURE_NAME_UNIT.source.replace(/\\u00A0/, '\\u00a0'), String(nodeVm.runInContext('FIGURE_NAME_UNIT.source', PAGE)))
  const cases = ['~<$0.01', 'resets 14:20', 'resets Mo 06:00 (in 2h14m)', '~18 h 46 min', `~18${NBSP}h${NBSP}46${NBSP}min`, 'claude-haiku-3-5',
    '2026-08-05 → 2026-09-03', '2026-08-05 ← 2026-09-03', '12.50 US$', '€ 12.50', '~$5.33', 'P90 max20', '⚠ 3.2M', '≈176.5K', '4 m 10 s',
    '2h14m', '-13%', '<1 %', '22 %', '14:20:05', '2:05 PM', '~/.claude/projects', 'Claude Code', 'tokenPace.statusBar.show', '$/1M']
  const texts: string[] = [...cases]
  try {
    wordsOf('en', undefined)
    for (const m of allItems()) texts.push(m.text, m.name, ...m.tooltipMarkdown.split('\n'))
    wordsOf('ar', PSEUDO)
    setDir('ltr')
    for (const m of allItems()) texts.push(m.text, m.name)
  } finally {
    pristine()
  }
  const seen = new Set<string>()
  let compared = 0
  for (const s of texts) {
    if (seen.has(s)) continue
    seen.add(s)
    assert.deepEqual(hostUnits(s), pageUnits(s), s)
    compared++
  }
  assert.ok(compared > 200, `only ${compared} texts compared`)
  // The cases the task names: '~<$0.01' one money unit, a clock one unit, claude-haiku-3-5 one name.
  assert.deepEqual(hostUnits('~<$0.01'), ['money:~<$0.01'])
  assert.deepEqual(hostUnits('resets 14:20'), ['clock:14:20'])
  assert.deepEqual(hostUnits('claude-haiku-3-5'), ['name:claude-haiku-3-5'])
})

// ---------------------------------------------------------------------------
// The helpers
// ---------------------------------------------------------------------------

test('1.13 A3 rules 2–4 (§7a Q7, Q5, Q29): isolate — the leading icons outside, RLI … PDI around the words (never FSI, though the text begins with a Latin name), each figure run an LRI … PDI inside; one isolate per line; idempotent and lossless; nothing for a text with nothing to lay out or for a left-to-right language', () => {
  const s = '$(pulse) Claude 5h 25% · كلمة 14:20'
  // Latin words next to each other are one unit, as they are one left-to-right run (the page's grammar: "Claude 5h").
  assert.equal(isolate(s, 'rtl'), `$(pulse) ${RLI}${LRI}Claude 5h${PDI} ${LRI}25%${PDI} · كلمة ${LRI}14:20${PDI}${PDI}`)
  assert.equal(isolate('Claude Code كلمة', 'rtl')[0], RLI)
  assert.equal(isolate('Claude Code كلمة', 'rtl'), `${RLI}${LRI}Claude Code${PDI} كلمة${PDI}`)
  assert.equal(isolate('~18 h 46 min كلمة', 'rtl'), `${RLI}${LRI}~18 h 46 min${PDI} كلمة${PDI}`)
  assert.equal(isolate('كلمة claude-haiku-3-5 كلمة', 'rtl'), `${RLI}كلمة ${LRI}claude-haiku-3-5${PDI} كلمة${PDI}`)
  // Two icons and the space after them outside; an icon inside stays where it is, its name no unit.
  assert.equal(isolate('$(warning) $(sync~spin) كلمة $(link-external) كلمة', 'rtl'), `$(warning) $(sync~spin) ${RLI}كلمة $(link-external) كلمة${PDI}`)
  // Lines: one isolate each; an empty line stays empty.
  assert.equal(isolate('كلمة 5 h\n\nكلمة', 'rtl'), `${RLI}كلمة ${LRI}5 h${PDI}${PDI}\n\n${RLI}كلمة${PDI}`)
  assert.equal(isolateLines('كلمة 5 h\n\nكلمة', 'rtl'), isolate('كلمة 5 h\n\nكلمة', 'rtl'))
  // Nothing to lay out: an icon alone, the empty text, punctuation alone. 1.13 lead fix after Review 2 (pinned and
  // changed: a figure alone — '42 %', '$(watch) 42' — was left as it was; since Review 2 F1 a figure unit is laid out
  // too, the test below).
  for (const x of ['$(watch)', '', '–', '·', '…', '$(watch) ·']) assert.equal(isolate(x, 'rtl'), x)
  // A figure with its unit holds a letter: it is isolated too, harmlessly (one left-to-right unit inside).
  assert.equal(isolate('$(watch) 4m', 'rtl'), `$(watch) ${RLI}${LRI}4m${PDI}${PDI}`)
  // Idempotent, lossless, and left to right unchanged.
  for (const x of [s, 'Claude Code كلمة', '$(graph) كلمة ~empty in 2h', 'a\nb 5 h']) {
    assert.equal(isolate(isolate(x, 'rtl'), 'rtl'), isolate(x, 'rtl'), x)
    assert.equal(stripBidi(isolate(x, 'rtl')), x)
    assert.equal(isolate(x, 'ltr'), x)
    assert.equal(isolateLines(x, 'ltr'), x)
    assert.equal(isolateMarkdown(x, 'ltr'), x)
    assert.equal(leadRtl(x, 'ltr'), x)
  }
  // The words' direction by default (i18n.ts dir()).
  try {
    setDir('rtl')
    assert.equal(isolate('كلمة'), `${RLI}كلمة${PDI}`)
    assert.equal(rangeArrow(), ' ← ')
  } finally {
    setDir(undefined)
  }
  assert.equal(dir(), 'ltr')
  assert.equal(isolate('كلمة'), 'كلمة')
  assert.equal(rangeArrow(), ' → ')
  // leadRtl: one RLM at the start of each line, once.
  assert.equal(leadRtl('Claude Code كلمة\nكلمة', 'rtl'), `${RLM}Claude Code كلمة\n${RLM}كلمة`)
  assert.equal(leadRtl(leadRtl('x\ny', 'rtl'), 'rtl'), leadRtl('x\ny', 'rtl'))
  // stripBidi takes exactly the controls (not ZWNJ, which Persian writes inside a word).
  const zwnj = String.fromCharCode(0x200c)
  assert.equal(stripBidi(`a${RLI}b${PDI}${RLM}${zwnj}c${String.fromCharCode(0x061c, 0x200e, 0x202b)}`), `ab${zwnj}c`)
})

test('1.13 lead fix after Review 2 (F1): a letter-free line with a figure unit or a range\'s arrow is laid out too — a record streak\'s or a budget\'s period `2026-08-05 ← 2026-09-03` through isolate and through the door\'s pickItems is RLI, two LRI … PDI day units, PDI; a hand-picked range\'s → label one unit; punctuation alone, an empty line and a lone icon unchanged; left to right the very texts', () => {
  const streak = '2026-08-05 ← 2026-09-03'
  const isolated = `${RLI}${LRI}2026-08-05${PDI} ← ${LRI}2026-09-03${PDI}${PDI}`
  assert.equal(isolate(streak, 'rtl'), isolated)
  assert.equal(isolateLines(streak, 'rtl'), isolated)
  // The three Quick Pick descriptions Review 2 named, through the door: the record streak (textViews.ts), a budget's
  // period when it is neither partial nor over, and "Open dashboard" for a hand-picked range — its label (→, one unit
  // of the range grammar, Review 2 F2) beside the Quick Pick's own ← between the two day units.
  const items = [
    { label: 'كلمة 30', description: streak },
    { label: 'كلمة · كلمة: ~$76 كلمة $200 · 38 %', description: '2026-09-01 ← 2026-09-30' },
    { label: 'كلمة', description: '2026-08-05 → 2026-09-03 · 2026-08-05 ← 2026-09-03', detail: 'كلمة 14:20' },
  ]
  const shown = pickItems(items, 'rtl')
  assert.equal(shown[0].description, isolated)
  assert.equal(shown[1].description, `${RLI}${LRI}2026-09-01${PDI} ← ${LRI}2026-09-30${PDI}${PDI}`)
  assert.equal(shown[2].description, `${RLI}${LRI}2026-08-05 → 2026-09-03${PDI} · ${LRI}2026-08-05${PDI} ← ${LRI}2026-09-03${PDI}${PDI}`)
  for (const s of shown) {
    const d = s.description ?? ''
    assert.equal(d.codePointAt(0), 0x2067, d)
    assert.ok(d.endsWith(PDI), d)
    assert.ok((d.match(new RegExp(`${LRI}\\d{4}-\\d{2}-\\d{2}${PDI}`, 'g')) ?? []).length >= 2 || d.includes(`${LRI}2026-08-05 → 2026-09-03${PDI}`), d)
  }
  // A figure alone, an arrow alone: laid out (one unit inside an isolate of its own); the tooltip's markdown too — after
  // a list marker and inside a table cell, a cell without anything to lay out left as it is.
  assert.equal(isolate('42 %', 'rtl'), `${RLI}${LRI}42 %${PDI}${PDI}`)
  assert.equal(isolate('$(watch) 42', 'rtl'), `$(watch) ${RLI}${LRI}42${PDI}${PDI}`)
  assert.equal(isolate('←', 'rtl'), `${RLI}←${PDI}`)
  assert.equal(isolateMarkdown(`- ${streak}\n| 42 % | ▰▰▱ |`, 'rtl'), `- ${isolated}\n| ${RLI}${LRI}42 %${PDI}${PDI} | ▰▰▱ |`)
  // Nothing to lay out: punctuation alone, the empty line, a lone icon — on every surface.
  for (const x of ['', '…', '·', '–', '( )', '$(watch)', '$(watch) …', '**…**', '| · | – |']) {
    assert.equal(isolate(x, 'rtl'), x, J(x))
    assert.equal(isolateLines(x, 'rtl'), x, J(x))
    assert.equal(isolateMarkdown(x, 'rtl'), x, J(x))
  }
  // Balanced, idempotent, lossless (A3 rule 9 b) — and left to right the very texts, the door's very array.
  for (const x of [streak, '42 %', '$(watch) 42', '←', items[2].description]) {
    const once = isolate(x, 'rtl')
    assert.ok(balance(once).ok && balance(once).depth <= 2, J(once))
    assert.equal(isolate(once, 'rtl'), once, J(x))
    assert.equal(stripBidi(once), x)
    assert.equal(isolate(x, 'ltr'), x)
    assert.equal(isolateLines(x, 'ltr'), x)
    assert.equal(isolateMarkdown(x, 'ltr'), x)
  }
  assert.equal(pickItems(items, 'ltr'), items)
  // The mutation this exists against: the old condition (a letter, or nothing) leaves the streak as it was.
  assert.notEqual(isolate(streak, 'rtl'), streak)
})

/** A tooltip with every line kind isolateMarkdown knows (MARKDOWN_LINE_KINDS). */
const EVERY_KIND = [
  '**[Claude Code](https://claude.ai/settings/usage)** · كلمة `max20`',
  '',
  '| كلمة | كلمة | كلمة |',
  '|---|---|---|',
  '| `5h` | <span style="color:var(--vscode-charts-red);">▰▰▱</span> 42 % | كلمة 14:20 |',
  '',
  '- كلمة **~$5.33** كلمة `claude-haiku-3-5`',
  '- كلمة (3 h 4 min)',
  '',
  '$(graph) `5h`: ~empty in 2h · كلمة 6 كلمة 1 h',
  '',
  '_كلمة **كلمة** كلمة (P90)._',
  '',
  '```',
  'code كلمة 42',
  '```',
  '$(sync) [كلمة](command:tokenPace.refreshQuota) · $(history) [كلمة](command:tokenPace.rescan) · $(output) [Log](command:tokenPace.showOutput)',
].join('\n')

test('1.13 A3 rule 5: isolateMarkdown isolates inside the markdown a tooltip is made of — after a list marker, in each cell, inside _…_ and **…**, a link\'s text inside its brackets, never across a | or a link, nothing in a fence or a separator row — and the structure test finds the line kinds and the rendered markdown unchanged', () => {
  assert.deepEqual([...MARKDOWN_LINE_KINDS], ['blank', 'fence', 'separator', 'table row', 'list item', 'links row', 'paragraph'])
  const out = isolateMarkdown(EVERY_KIND, 'rtl')
  const lines = out.split('\n')
  assert.deepEqual(structureProblems(out, EVERY_KIND, 'every kind'), [])
  assert.deepEqual(tooltipIsolatedProblems(out, 'every kind'), [])
  assert.equal(lines[0], `**[${RLI}${LRI}Claude Code${PDI}](https://claude.ai/settings/usage)** · كلمة ${LRI}\`max20\`${PDI}${PDI}`)
  assert.equal(lines[2], `| ${RLI}كلمة${PDI} | ${RLI}كلمة${PDI} | ${RLI}كلمة${PDI} |`)
  assert.equal(lines[3], '|---|---|---|')
  // A cell without a word but with a figure (a bar and its figure) is laid out right to left like its neighbours, the
  // figure one unit, the tag as it is. 1.13 lead fix after Review 2 (pinned and changed: P5 left such a cell as it was,
  // its own paragraph left to right; since Review 2 F1 a figure unit is laid out too — as the page's table shows it).
  assert.equal(lines[4], `| ${RLI}${LRI}\`5h\`${PDI}${PDI} | ${RLI}<span style="color:var(--vscode-charts-red);">▰▰▱</span> ${LRI}42 %${PDI}${PDI} | ${RLI}كلمة ${LRI}14:20${PDI}${PDI} |`)
  assert.equal(lines[6], `- ${RLI}كلمة **${LRI}~$5.33${PDI}** كلمة ${LRI}\`claude-haiku-3-5\`${PDI}${PDI}`)
  assert.equal(lines[9], `$(graph) ${RLI}${LRI}\`5h\`${PDI}: ~${LRI}empty in 2h${PDI} · كلمة ${LRI}6${PDI} كلمة ${LRI}1 h${PDI}${PDI}`)
  assert.equal(lines[11], `_${RLI}كلمة **كلمة** كلمة (P90).${PDI}_`)
  assert.deepEqual(lines.slice(13, 16), ['```', 'code كلمة 42', '```'])
  assert.equal(lines[16], `$(sync) [${RLI}كلمة${PDI}](command:tokenPace.refreshQuota) · $(history) [${RLI}كلمة${PDI}](command:tokenPace.rescan) · $(output) [${RLI}Log${PDI}](command:tokenPace.showOutput)`)
  // Never before a list marker, a |, a *, a _, a [ or a fence.
  for (const line of lines) assert.doesNotMatch(line, new RegExp(`^[${RLI}${LRI}]\\s*(?:[-*+] |\\||\\*|_|\\[|\`\`\`)`), line)
  assert.equal(isolateMarkdown(out, 'rtl'), out, 'idempotent')
  assert.equal(isolateMarkdown(EVERY_KIND, 'ltr'), EVERY_KIND)
  // The structure test catches what it exists for: an RLI before a list marker, before a table's pipe.
  const broken = out.replace(`- ${RLI}كلمة **`, `${RLI}- كلمة **`)
  assert.notDeepEqual(structureProblems(broken, EVERY_KIND, 'mutated'), [])
  assert.notDeepEqual(structureProblems(out.replace(lines[4], RLI + lines[4]), EVERY_KIND, 'mutated'), [])
  assert.ok(markdownIt !== null, 'markdown-it (a dependency of @vscode/vsce) is installed — the rendered half of the structure test runs')
})

test('1.13 A3 rule 9 (a): the bar in the pseudo-RTL language under ar, he and fa — every ItemSpec kind at every density, the preview, both tooltip modes: each text and name is its icons + RLI … PDI with each figure run inside LRI … PDI, each tooltip isolated inside its markdown and passing the structure test, each accessible name without a control; stripBidi gives the left-to-right build back', () => {
  for (const [what, id, bundle] of RTL_WORLDS) {
    let plainItems: ItemModel[]
    let items: ItemModel[]
    try {
      wordsOf(id, bundle)
      setDir('ltr')
      plainItems = allItems()
      setDir('rtl')
      items = allItems()
    } finally {
      pristine()
    }
    assert.equal(items.length, plainItems.length)
    assert.ok(items.length > 60, `${what}: ${items.length} items`)
    const kinds = new Set(items.map((m) => m.id.replace(/^tokenPace\.(preview\.\d+|quota\.\w+\.(?:session|weekly)[^.]*|quota\.\w+)$/, '$1').split('.')[1] ?? m.id))
    assert.ok(kinds.size >= 5, [...kinds].join(' '))
    const problems: string[] = []
    items.forEach((m, i) => {
      const p = plainItems[i]
      const at = `${what} ${m.id}`
      problems.push(...isolatedProblems(m.text, `${at} text`), ...isolatedProblems(m.name, `${at} name`))
      if (stripBidi(m.text) !== p.text || stripBidi(m.name) !== p.name) problems.push(`${at}: not lossless`)
      if (m.tooltipMarkdown !== '') {
        problems.push(...structureProblems(m.tooltipMarkdown, p.tooltipMarkdown, `${at} tooltip`))
        problems.push(...tooltipIsolatedProblems(m.tooltipMarkdown, `${at} tooltip`))
      }
      const aria = m.ariaLabel ?? ''
      if (BIDI_CONTROLS.test(aria)) problems.push(`${at}: its accessible name carries a control: ${J(aria)}`)
      if (aria !== (p.ariaLabel ?? itemAriaLabel(p.text, p.tooltipMarkdown))) problems.push(`${at}: its accessible name is not the plain one`)
    })
    assert.deepEqual(problems.slice(0, 12), [], `${problems.length} problem(s)`)
    // The Latin-first texts are there — "CC 5h …", "Claude Code — 5 h": each opens with RLI (U+2067) after its icons,
    // never with FSI, whose first strong character would lay it out left to right (§7a Q7).
    const latinFirst = items.flatMap((m) => [m.text, m.name]).filter((x) => /^[A-Za-z]/.test(stripBidi(x).replace(LEADING_ICONS, '')))
    assert.ok(latinFirst.length > 20, `${what}: ${latinFirst.length}`)
    for (const x of latinFirst) assert.equal(x.replace(LEADING_ICONS, '').codePointAt(0), 0x2067, x)
  }
})

test('1.13 A3 rule 9 (b): every t() key of the pseudo-RTL bundle (and of each right-to-left bundle on disk) through isolate, isolateLines and isolateMarkdown — balanced, at most three deep, idempotent and lossless', () => {
  const bundles: Array<[string, Record<string, string>]> = [['pseudo-RTL', PSEUDO], ...RTL_ON_DISK.map(([id, b]) => [id, b] as [string, Record<string, string>])]
  assert.ok(Object.keys(PSEUDO).length >= 1300, String(Object.keys(PSEUDO).length))
  for (const [what, bundle] of bundles) {
    const problems: string[] = []
    let n = 0
    for (const [key, value] of Object.entries(bundle)) {
      for (const text of [value, key]) {
        for (const [helper, f] of [['isolate', isolate], ['isolateLines', isolateLines], ['isolateMarkdown', isolateMarkdown]] as const) {
          const once = f(text, 'rtl')
          const b = balance(once)
          if (!b.ok || b.depth > 3) problems.push(`${what} ${helper}: unbalanced or deeper than 3: ${J(key)}`)
          if (f(once, 'rtl') !== once) problems.push(`${what} ${helper}: not idempotent: ${J(key)}`)
          if (stripBidi(once) !== text) problems.push(`${what} ${helper}: not lossless: ${J(key)}`)
          if (/\p{L}/u.test(text) && !once.includes(RLI) && helper !== 'isolateMarkdown') problems.push(`${what} ${helper}: not isolated: ${J(key)}`)
          n++
        }
      }
    }
    assert.deepEqual(problems.slice(0, 10), [], `${problems.length} problem(s)`)
    assert.ok(n >= 6 * 1300, String(n))
  }
})

test('1.13 A3 rule 9 (d): in English and German every helper returns its input byte for byte — each key and each German value, the door\'s own functions the very objects they were handed, the bar\'s items the very array', () => {
  for (const [key, value] of Object.entries(GERMAN)) {
    for (const text of [key, value]) {
      for (const d of ['ltr', undefined] as const) {
        assert.equal(isolate(text, d), text)
        assert.equal(isolateLines(text, d), text)
        assert.equal(isolateMarkdown(text, d), text)
        assert.equal(leadRtl(text, d), text)
      }
    }
  }
  const items = [{ label: 'a', description: 'b', command: 'c' }]
  assert.equal(pickItems(items, 'ltr'), items)
  const o = { title: 'T', placeHolder: 'P' }
  assert.equal(pickOptions(o, 'ltr'), o)
  const io = { title: 'T', prompt: 'P', value: 'v' }
  assert.equal(inputOptions(io, 'ltr'), io)
  const opts = { modal: true, detail: 'x\ny' }
  assert.equal(messageTexts('m', opts, ['A'], 'ltr').opts, opts)
  const built = [{ id: 'x', text: 't', name: 'n', tooltipMarkdown: '', colorId: null, alarm: false, command: null, priorityKey: '1000' }] as ItemModel[]
  assert.equal(finishItems(built, 'ltr'), built)
  for (const lang of ['en', 'de'] as const) {
    try {
      if (lang === 'de') { setBundle(GERMAN); setLocale('de'); setLang('de') }
      for (const m of allItems()) {
        assert.equal(stripBidi(m.text), m.text)
        assert.equal(stripBidi(m.tooltipMarkdown), m.tooltipMarkdown)
      }
    } finally {
      pristine()
    }
  }
})

// ---------------------------------------------------------------------------
// The door over a fake window
// ---------------------------------------------------------------------------

interface Call { api: string; args: unknown[] }

/** A window of the door's members that records each call and answers from `answer`. */
function fakeWindow(answer: (api: string, args: unknown[]) => unknown): { w: WindowApi; calls: Call[] } {
  const calls: Call[] = []
  const rec = (api: string) => (...args: unknown[]): Promise<unknown> => {
    calls.push({ api, args })
    return Promise.resolve(answer(api, args))
  }
  const w = {
    showInformationMessage: rec('info'),
    showWarningMessage: rec('warning'),
    showErrorMessage: rec('error'),
    showQuickPick: rec('pick'),
    showInputBox: rec('input'),
    createQuickPick: () => { calls.push({ api: 'createQuickPick', args: [] }); return { items: [] } },
    withProgress: (options: unknown, task: (p: unknown, t: unknown) => unknown) => {
      const reported: unknown[] = []
      calls.push({ api: 'progress', args: [options, reported] })
      return task({ report: (v: unknown) => { reported.push(v) } }, { isCancellationRequested: false })
    },
  }
  return { w: w as unknown as WindowApi, calls }
}

test('1.13 A3 rule 8: the door — a message and its buttons isolated, a dialog\'s detail line by line, the reader\'s choice handed back as the caller\'s own label; a Quick Pick\'s title, placeholder and items isolated, its answer the caller\'s own item (several too); an InputBox\'s texts and validation isolated, never its value; a progress title and message; left to right the very call the caller would have made', async () => {
  try {
    setDir('rtl')
    // Messages: the answer is the shown label, handed back as the caller's.
    const msg = fakeWindow((_api, args) => args[args.length - 1])
    const ui = hostUiOf(msg.w)
    const never = 'Never كلمة'
    assert.equal(await ui.showMessage('info', 'Allow Token Pace? كلمة', { modal: true, detail: 'كلمة 5 h\n\nكلمة' }, 'Allow كلمة', never), never)
    assert.deepEqual(msg.calls[0], { api: 'info', args: [`${RLI}${LRI}Allow Token Pace${PDI}? كلمة${PDI}`, { modal: true, detail: `${RLI}كلمة ${LRI}5 h${PDI}${PDI}\n\n${RLI}كلمة${PDI}` }, `${RLI}Allow كلمة${PDI}`, `${RLI}Never كلمة${PDI}`] })
    // `{}` is the call without options, as VS Code treats both.
    assert.equal(await ui.showMessage('warning', 'كلمة', {}, 'OK'), 'OK')
    assert.deepEqual(msg.calls[1], { api: 'warning', args: [`${RLI}كلمة${PDI}`, `${RLI}OK${PDI}`] })
    await ui.showMessage('error', 'كلمة', {})
    assert.deepEqual(msg.calls[2], { api: 'error', args: [`${RLI}كلمة${PDI}`] })
    // Nothing chosen (Escape): undefined.
    assert.equal(await hostUiOf(fakeWindow(() => undefined).w).showMessage('info', 'x', {}, 'A'), undefined)
    // Quick Picks: the shown copies, the caller's items back.
    const items = [{ label: '$(sync) كلمة', description: 'كلمة 5 h', detail: 'claude-haiku-3-5', command: 'a' }, { label: 'كلمة', command: 'b' }]
    const pick = fakeWindow((api, args) => (api === 'pick' ? (args[0] as unknown[])[1] : undefined))
    const chosen = await hostUiOf(pick.w).showPick(items, { title: 'Token Pace', placeHolder: 'كلمة' })
    assert.equal(chosen, items[1])
    const shown = pick.calls[0].args[0] as typeof items
    assert.deepEqual(shown[0], { label: `$(sync) ${RLI}كلمة${PDI}`, description: `${RLI}كلمة ${LRI}5 h${PDI}${PDI}`, detail: `${RLI}${LRI}claude-haiku-3-5${PDI}${PDI}`, command: 'a' })
    assert.deepEqual(pick.calls[0].args[1], { title: `${RLI}${LRI}Token Pace${PDI}${PDI}`, placeHolder: `${RLI}كلمة${PDI}` })
    // Strings: the caller's string back; a typed placeholder as it is.
    const strings = fakeWindow((_api, args) => (args[0] as string[])[0])
    assert.equal(await hostUiOf(strings.w).showPick(['Keep كلمة', 'Replace'], { title: 'كلمة', placeHolder: 'node /x/a.js && echo 1' }, ['placeHolder']), 'Keep كلمة')
    assert.deepEqual(strings.calls[0].args, [[`${RLI}Keep كلمة${PDI}`, `${RLI}Replace${PDI}`], { title: `${RLI}كلمة${PDI}`, placeHolder: 'node /x/a.js && echo 1' }])
    // Several: the caller's items.
    const many = fakeWindow((_api, args) => (args[0] as unknown[]).slice())
    assert.deepEqual(await hostUiOf(many.w).showPickMany(items, { title: 'كلمة' }), items)
    assert.equal((many.calls[0].args[1] as { canPickMany: boolean }).canPickMany, true)
    // InputBox: never the value; the validation message isolated.
    const input = fakeWindow(() => 'typed')
    assert.equal(await hostUiOf(input.w).showInput({ title: 'كلمة', prompt: 'كلمة tokenPace.notifications.webhookUrl', placeHolder: 'https://example.invalid/hook', value: 'https://x.invalid/كلمة', password: true, validateInput: (v) => (v === '' ? 'كلمة' : undefined) }), 'typed')
    const shownInput = input.calls[0].args[0] as { title: string; prompt: string; placeHolder: string; value: string; password: boolean; validateInput: (v: string) => unknown }
    assert.deepEqual([shownInput.title, shownInput.prompt, shownInput.placeHolder, shownInput.value, shownInput.password],
      [`${RLI}كلمة${PDI}`, `${RLI}كلمة ${LRI}tokenPace.notifications.webhookUrl${PDI}${PDI}`, `${RLI}${LRI}https://example.invalid/hook${PDI}${PDI}`, 'https://x.invalid/كلمة', true])
    assert.equal(shownInput.validateInput(''), `${RLI}كلمة${PDI}`)
    assert.equal(shownInput.validateInput('x'), undefined)
    // Progress: the title and each message.
    const prog = fakeWindow(() => undefined)
    await hostUiOf(prog.w).showProgress({ location: 15, title: 'كلمة…' } as never, async (p) => { p.report({ message: 'كلمة 3 كلمة' }) })
    assert.deepEqual(prog.calls[0].args, [{ location: 15, title: `${RLI}كلمة…${PDI}` }, [{ message: `${RLI}كلمة ${LRI}3${PDI} كلمة${PDI}` }]])
    // The mutation this exists against: a door that handed the isolated label back would not match the caller's.
    assert.notEqual(msg.calls[0].args[3], never)
  } finally {
    setDir(undefined)
  }
  // Left to right: the very arguments the caller passed, the options only when there are some.
  const ltr = fakeWindow((_api, args) => args[args.length - 1])
  const ui = hostUiOf(ltr.w)
  assert.equal(await ui.showMessage('info', 'Allow?', {}, 'Allow', 'Never'), 'Never')
  const detail = { modal: true, detail: 'a\nb' }
  await ui.showMessage('warning', 'Delete?', detail, 'Delete')
  const items = [{ label: 'a' }]
  await ui.showPick(items, { title: 'T' })
  assert.deepEqual(ltr.calls.map((c) => c.args), [['Allow?', 'Allow', 'Never'], ['Delete?', detail, 'Delete'], [items, { title: 'T' }]])
  assert.equal(ltr.calls[1].args[1], detail)
  assert.equal(ltr.calls[2].args[0], items)
})

// ---------------------------------------------------------------------------
// §0a.3's leak test
// ---------------------------------------------------------------------------

function diagnosticsInput(): DiagnosticsInput {
  return {
    extVersion: '1.13.0', vscodeVersion: '1.139.1', platform: 'linux', arch: 'x64', node: '22.23.3', remoteName: null, extensionKind: 'workspace',
    roots: ['~/.claude/projects'], fileCount: 412,
    snapshot: { buckets: { h: 210, d: 380, m: 12 }, bytes: 1_234_567, oldestDay: '2026-05-01', newestDay: '2026-09-28', firstIngest: '2026-05-01' },
    retention: { hourDays: 45, days: 400, historyDays: 30 }, historySize: { samples: 2140, bytes: 210_000, oldest: '2026-08-04' },
    quota: [{ source: 'claude', candidates: [{ id: 'cacheFile', ok: true, ageSec: 180 }, { id: 'poll', ok: false, ageSec: null, problemKind: 'consentPending', problem: 'consent required' }], backoffEndsAt: null, drift: [] }],
    codexConnection: { mode: 'persistent', state: 'ready', restartsLastHour: 0, pushes: 3, lastPushAgeSec: 42 },
    credentials: { source: 'keychain', keychain: 'allowed' }, consent: 'granted', role: 'leader',
    bridge: { installed: true, shadowed: false, mirrorAgeMs: 180_000 },
    http: { proxy: { value: '', origin: 'default' }, proxySupport: { value: 'off', origin: 'user' }, proxyStrictSSL: { value: true, origin: 'default' } },
    proxyEnv: [], settings: {}, partialData: false, attribution: 'none', language: { setting: 'ar', shown: 'ar', vscode: 'en' }, home: '/home/tester',
  } as DiagnosticsInput
}

function events(): NotificationEvent[] {
  const base = { identity: 'x', provider: 'claude' as const, program: null, windowLabel: '5 h', windowKind: 'session' as const, percent: 90,
    resetsAt: BAR_RESET, etaAt: null, since: null, atLeastMs: null, wait: null, at: BAR_NOW }
  return [{ ...base, event: 'quotaThreshold' }, { ...base, event: 'quotaThreshold', windowLabel: '7 d', windowKind: 'weekly', percent: 95 }]
}

test('1.13 §0a.3 leak test: with the pseudo-RTL bundle under ar, the diagnostics, the CSV and the JSON export, the markdown document, the clipboard summary, a notification\'s JSON data fields, the view model and every accessible name of the bar carry no bidi control — the marks are the surfaces\', never a t() result\'s', () => {
  try {
    wordsOf('ar', PSEUDO)
    const outputs: Array<[string, string]> = []
    const cfg = makeConfig({ 'tokenPace.showCost': true })
    const tcfg = timeConfig(cfg)
    const range = { from: '2026-08-25', to: TODAY, label: `2026-08-25${rangeArrow()}${TODAY}`, preset: 'custom' as const }
    outputs.push(['the diagnostics', buildDiagnostics(diagnosticsInput())])
    outputs.push(['the CSV export', toCsv(buildAgg(), range, cfg, tcfg)])
    outputs.push(['the JSON export', toJson(buildAgg(), range, cfg, tcfg, NOW)])
    const history = makeHistory()
    fillHistory(history)
    const vm = buildViewModel(makeInput({ history, cfg: makeConfig({ 'tokenPace.attribution': 'project', 'tokenPace.showCost': true }), agg: buildAgg('project'), ui: { drillDay: '2026-09-02' } }))
    outputs.push(['the view model', J(vm)])
    outputs.push(['the markdown document', markdownDocument(vm)])
    outputs.push(['the clipboard summary', toMarkdownSummary(vm)])
    const p = payloadOf(events(), { tcfg, now: BAR_NOW })
    const data = Object.fromEntries(Object.entries(p.json).filter(([k]) => k !== 'title' && k !== 'text'))
    outputs.push(['a notification\'s JSON data fields', J(data)])
    outputs.push(['the test message\'s JSON data fields', J(Object.fromEntries(Object.entries(testPayload({ tcfg, now: BAR_NOW }).json).filter(([k]) => k !== 'title' && k !== 'text')))])
    outputs.push(['the bar\'s accessible names', J(allItems().map((m) => m.ariaLabel))])
    outputs.push(['money()', [money(12.5, 'USD'), money(1234, 'EUR'), money(3, 'ILS'), money(3, 'IRR')].join(' ')])
    for (const [what, text] of outputs) {
      const at = text.search(BIDI_CONTROLS)
      assert.equal(at, -1, `${what} carries a control: ${J(text.slice(Math.max(0, at - 40), at + 40))}`)
    }
    // The texts are the pseudo language's (the test would pass vacuously in English).
    assert.match(markdownDocument(vm), /كلمة/)
    assert.match(J(vm), /كلمة/)
    // The notification's two texts are the one place a mark goes (A3 rule 7).
    assert.equal(p.title.codePointAt(0), 0x200f)
    assert.equal(p.json.title, p.title)
  } finally {
    pristine()
  }
})
