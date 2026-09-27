// SPDX-FileCopyrightText: 2026 Frederik Marx
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The prose is part of the product: a settings description, a README sentence or a row in
 * docs/status-bar-states.md is what a user takes for the contract. These tests keep the words
 * pinned to the code that has to honour them — every example string here is either rendered by
 * the real function or asserted absent, so a description cannot drift back to a promise the
 * build does not keep. Synthetic data only; no file outside the repository is touched.
 */

import { strict as assert } from 'node:assert'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join, normalize, relative } from 'node:path'
import { test } from 'node:test'
import { HOOK_LINE_MAX_BYTES, HOOK_TAIL_BYTES, hookSetupDocument } from '../src/agentHook'
import { HOOK_EVENTS, HOOK_KEEP_LINES, HOOK_ROTATE_BYTES, HOOK_STDIN_MAX_BYTES, NOTIFICATION_WAITS } from '../src/agentHookScript'
import {
  AGENT_RETENTION_DAYS, HOOK_MAX_AGE_MS, MAX_AGENT_MORE, MAX_GROUP_CHILDREN, MAX_MORE_PAGES, MAX_PAGE_NODES, MAX_ROOTS, MAX_RUN_AGENTS,
  MAX_RUNNING_LIST, MAX_TREE_DEPTH, MIN_SHORT_ID, RESUMED_AFTER_MS, ROOT_WINDOW_MS, RUNNING_WINDOW_MS, SESSION_ACTIVE_MS,
  PER_MINUTE_FROM_MS, SILENT_AFTER_MS, SPAN_IN_DAYS_FROM_MS, TOP_AGENTS, WEEK_ROWS, WEEKDAY_NAMES_WITHIN_MS,
} from '../src/agentTree'
import {
  AGENT_ID_MAX_CHARS, AGENT_MODEL_MAX_CHARS, AGENT_NAME_MAX_CHARS, AGENT_TABLES_REVISION, Aggregator, JOURNAL_PARSE_MAX, outcomeOfStatus, PENDING_MODE_MAX,
  STOP_REASONS, USER_LINE_LITERAL,
} from '../src/agg'
import { usedThresholds } from '../src/alerts'
import { readPaceConfig, sanitize } from '../src/config'
import { disclosure } from '../src/consent'
import { AGENTS_CSV_COLUMNS, CSV_COLUMNS, EXPORT_SCHEMA_VERSION, toJson } from '../src/exporter'
import { PaceConfig, paceVerdict } from '../src/pace'
import { LEGACY_CHECKED, OPUS_5_5_CHECKED, PRICES, PRICES_AS_OF, PRICES_CHECKED_LATER, PRICE_SOURCE_PAGES, priceOf } from '../src/prices'
import { BarGlyphs, BarStyle, renderBar } from '../src/render'
import { RUN_RECORD_CHUNK_BYTES, RUN_RECORD_MAX_BYTES, RUN_RECORD_SCALAR_MAX } from '../src/runRecord'
import { AGENT_META_MAX_BYTES } from '../src/scan'
import { durationText } from '../src/stats'
import { buildItems, selectWindows, viewOf, windowValue } from '../src/statusText'
import { labelOf, StoredKey } from '../src/storage'
import { formatReset, lastFailureText, nextAttemptWords, refreshWords, retryWords, TimeConfig } from '../src/time'
import { FAILURE_TRANSIENT, QuotaState, QuotaWindow, STATE_VERSION } from '../src/types'
import { SOURCES, SOURCE_TITLE } from '../src/adapters'
import { MAX_AGENT_EXPANDED } from '../src/viewModel'
import { readManifest } from './helpers/nls'
import { createHash } from 'node:crypto'
import { setBundle, setLocale } from '../src/i18n'
import { autoLanguage, LANGUAGE_IDS, LANGUAGES, languageName, resolveLanguage } from '../src/languages'
import { countdownText } from '../src/promptCache'
import { compact, full, usd } from '../src/render'
import { dayOf, relativeShort, relativeTime } from '../src/time'

const ROOT = join(__dirname, '..')
/**
 * Line endings are normalised on the way in. A Windows checkout with `core.autocrlf` — the
 * Git for Windows default, and the CI runner's — hands out CRLF, and a rule like "the
 * declaration ends at the first blank line" (`indexOf('\n\n')`) then matches nothing at all:
 * the assertion below silently reads the whole rest of the file instead of the declaration.
 * The words these tests pin are the same on every platform; the separators are not part of
 * them, so they are levelled here rather than at each of the twenty reading sites.
 */
const readDoc = (name: string): string => readFileSync(join(ROOT, name), 'utf8').replace(/\r\n/g, '\n')

interface Property {
  type?: string
  default?: unknown
  minimum?: number
  maximum?: number
  multipleOf?: number
  enum?: string[]
  enumDescriptions?: string[]
  markdownDescription?: string
  items?: { minimum?: number; maximum?: number; enum?: string[] }
}

/**
 * The manifest holds `%key%` placeholders since 1.2.0; the prose these tests pin lives in
 * `package.nls.json`, so every read goes through the resolver.
 */
const pkg = readManifest<{
  contributes: { configuration: Array<{ properties: Record<string, Property> }> }
}>()
const properties: Record<string, Property> = {}
for (const section of pkg.contributes.configuration) {
  for (const [key, value] of Object.entries(section.properties)) properties[key] = value
}

/** The whole manifest, for the contribution points these tests pin. */
const manifest = readManifest<{
  version: string
  engines: { vscode: string }
  devDependencies: Record<string, string>
  keywords: string[]
  contributes: {
    commands: Array<{ command: string; title: string }>
    keybindings: Array<{ command: string; key: string; mac?: string; when?: string }>
    viewsContainers: Record<string, unknown>
    walkthroughs: Array<{
      id: string
      title: string
      steps: Array<{
        id: string
        title: string
        description: string
        media: { markdown: string }
        completionEvents?: string[]
      }>
    }>
  }
}>()

const README = readDoc('README.md')
const STATES = readDoc('docs/status-bar-states.md')

/**
 * Since 1.3 the README is the store overview only — three pictures, six bullets, install,
 * privacy in five lines and the index — and every chapter it used to carry lives in its own
 * page under `docs/`. The prose assertions below therefore name the page they belong to: a
 * sentence that has to exist is checked where a reader would look it up, not in whichever
 * file happens to contain the words. `DOCS` is every page at once, for the few checks that
 * only ask that a claim exists somewhere in the documentation.
 */
const doc = {
  numbers: readDoc('docs/numbers.md'),
  statusBar: readDoc('docs/status-bar.md'),
  dashboard: readDoc('docs/dashboard.md'),
  agents: readDoc('docs/agents.md'),
  quotaSources: readDoc('docs/quota-sources.md'),
  cost: readDoc('docs/cost.md'),
  counting: readDoc('docs/counting.md'),
  history: readDoc('docs/history.md'),
  budgetsAlerts: readDoc('docs/budgets-alerts.md'),
  sessions: readDoc('docs/sessions.md'),
  export: readDoc('docs/export.md'),
  troubleshooting: readDoc('docs/troubleshooting.md'),
  privacy: readDoc('docs/privacy.md'),
  windows: readDoc('docs/windows-wsl-remote.md'),
  settings: readDoc('docs/settings.md'),
  commands: readDoc('docs/commands.md'),
  development: readDoc('docs/development.md'),
  release: readDoc('docs/release.md'),
  // 1.8 §0a.1 (P4): the prompt cache's page, created with its "What is read" section.
  promptCache: readDoc('docs/prompt-cache.md'),
  // 1.9 P3 (§3 A7): the languages page — the picker, `auto`, what switches, the table, the notation, the statement.
  languages: readDoc('docs/languages.md'),
  // 1.10 P3 (§3 A7): the prompts page — adding the section, the list, where the prompts are kept; P4 and P5 add
  // sending and editing.
  prompts: readDoc('docs/prompts.md'),
} as const
const DOCS = [README, STATES, ...Object.values(doc)].join('\n')

/**
 * The examples in the settings UI are quoted with curly quotes; this pulls them out, one entry
 * per enum value (null where a description carries no example, such as "Follow the locale").
 */
function examples(key: string): Array<string | null> {
  return (properties[key].enumDescriptions ?? []).map((d) => {
    const m = d.match(/“([^”]*)”/)
    return m ? m[1] : null
  })
}

/** Trailing blanks are invisible in the settings UI, so an example may drop them. */
const trimmed = (s: string): string => s.replace(/\s+$/, '')

/** Every bar the renderer can draw for one glyph set, over the whole percentage range. */
function drawable(glyphs: BarGlyphs, style: BarStyle): Set<string> {
  const out = new Set<string>()
  for (let p = 0; p <= 1000; p++) {
    out.add(trimmed(renderBar(p / 10, { width: 8, style, glyphs, marker: null, markerStyle: 'none', remaining: false })))
  }
  return out
}

// ---------------------------------------------------------------------------
// Bar examples: the settings UI may only show glyphs the renderer emits
// ---------------------------------------------------------------------------

test('every barGlyphs example is a bar the renderer can actually draw', () => {
  const sets: BarGlyphs[] = ['blocks', 'shapes', 'dots', 'pie']
  const shown = examples('tokenPace.barGlyphs')
  assert.equal(shown.length, sets.length)
  sets.forEach((glyphs, i) => {
    const example = shown[i]
    assert.ok(example, `barGlyphs ${glyphs} has no example`)
    assert.ok(drawable(glyphs, 'line').has(example as string), `barGlyphs ${glyphs}: “${example}” is never rendered`)
  })
  // The regression: U+2584 (lower half block) is from another row of the block and cannot appear.
  assert.equal((shown[0] as string).includes('▄'), false, 'the blocks example uses a glyph renderBar never emits')
})

test('every barStyle example is a bar the renderer can draw with the default glyph set', () => {
  const styles: BarStyle[] = ['line', 'shade', 'none']
  const shown = examples('tokenPace.barStyle')
  assert.equal(shown.length, styles.length)
  styles.forEach((style, i) => {
    const example = shown[i]
    assert.ok(example, `barStyle ${style} has no example`)
    assert.ok(drawable('blocks', style).has(example as string), `barStyle ${style}: “${example}” is never rendered`)
  })
})

test('barStyle says where line and shade actually differ, because for shapes and dots they do not', () => {
  const bar = (glyphs: BarGlyphs, style: BarStyle): string =>
    renderBar(25, { width: 8, style, glyphs, marker: null, markerStyle: 'none', remaining: false })
  // The fact the description has to state: only `blocks` reacts to line vs shade.
  assert.notEqual(bar('blocks', 'line'), bar('blocks', 'shade'))
  assert.equal(bar('shapes', 'line'), bar('shapes', 'shade'))
  assert.equal(bar('dots', 'line'), bar('dots', 'shade'))
  assert.equal(bar('pie', 'line'), bar('pie', 'shade'))

  const md = properties['tokenPace.barStyle'].markdownDescription ?? ''
  assert.match(md, /line.+shade.+differ only/i)
  assert.match(md, /blocks/)
  assert.match(doc.statusBar, /`line` and `shade` differ only for `blocks`/)
  assert.match(STATES, /differ only for `barGlyphs: blocks`/)
})

// ---------------------------------------------------------------------------
// Reset clock and reading age
// ---------------------------------------------------------------------------

test('the resetHourCycle examples are what formatReset prints', () => {
  const utc: TimeConfig = { zone: 'utc', dayBoundaryHour: 0, startOfWeek: 'monday', hourCycle: 'auto' }
  const now = Date.UTC(2026, 8, 3, 3, 46)
  const at6 = Date.UTC(2026, 8, 3, 6, 0)
  const shown = examples('tokenPace.resetHourCycle')
  // enum order: auto, h12, h23 — `auto` follows the locale, so only the two fixed ones are pinned.
  assert.equal(formatReset(at6, now, 'absolute', { ...utc, hourCycle: 'h12' }), shown[1])
  assert.equal(formatReset(at6, now, 'absolute', { ...utc, hourCycle: 'h23' }), shown[2])
  assert.equal(shown[1], '06:00 AM')
})

test('the showAgeInItem examples use the age format the item really carries', () => {
  const shown = examples('tokenPace.showAgeInItem').filter((s): s is string => !!s && s.includes('$(history)'))
  assert.equal(shown.length, 2)
  for (const s of shown) {
    const age = s.slice(s.indexOf('$(history)') + '$(history)'.length).trim()
    // ageShort: "<1m", "24m", "3h", "2d" — and never a trailing word the renderer does not emit.
    assert.match(age, /^(<1m|\d+[mhd])$/, `“${s}” shows an age the status bar never writes`)
  }
})

// ---------------------------------------------------------------------------
// windowSelect: worstPace
// ---------------------------------------------------------------------------

const NOW = Date.UTC(2026, 8, 3, 12, 0, 0)
const HOUR = 3_600_000

function win(p: Partial<QuotaWindow>): QuotaWindow {
  return {
    id: 'session:300', kind: 'session', label: '5 h', shortLabel: '5h', model: null,
    percent: 25, resetsAt: NOW + HOUR, windowMinutes: 300, limitReached: false, unlimited: false, ...p,
  }
}

test('worstPace is documented as level first, utilisation second — which is what it does', () => {
  // Both windows are ahead of their clock, so both land in the same pace level; the 7 d window
  // is 30 points ahead, the 5 h window only 6 — and the more-utilised one still wins.
  const q: QuotaState = {
    source: 'claude', ok: true, origin: 'poll', fetchedAt: Math.floor(NOW / 1000), planType: null,
    windows: [
      // 85 % of five hours have run, 91 % is used: 6 points ahead.
      win({ id: 'session:300', percent: 91, windowMinutes: 300, resetsAt: NOW + 0.75 * HOUR }),
      // 10 % of seven days have run, 40 % is used: 30 points ahead.
      win({
        id: 'weekly_all:10080', kind: 'weekly', label: '7 d', shortLabel: '7d', percent: 40,
        windowMinutes: 10080, resetsAt: NOW + 151.2 * HOUR,
      }),
    ],
  }
  const cfg = sanitize({ 'tokenPace.timezone': 'utc', 'tokenPace.windowSelect': 'worstPace' })
  assert.deepEqual(selectWindows(q, cfg, NOW).map((w) => w.id), ['session:300'])

  // So neither the settings UI nor the status-bar page may promise "furthest ahead of the clock".
  const shown = properties['tokenPace.windowSelect'].enumDescriptions ?? []
  const worst = shown[(properties['tokenPace.windowSelect'].enum ?? []).indexOf('worstPace')]
  assert.equal(/furthest ahead/.test(worst), false, worst)
  assert.match(worst, /most-utilised/)
  assert.equal(/`worstPace` \(the one furthest ahead of the clock\)/.test(DOCS), false)
  assert.match(doc.statusBar, /`worstPace` \(the worst pace verdict/)
})

// ---------------------------------------------------------------------------
// Family fallback
// ---------------------------------------------------------------------------

test('docs/cost.md names the donor the family fallback really picks', () => {
  // The rule is "newest priced model of the family", so the donor is whatever prices.ts holds
  // today — the documented example has to be derived from it, never guessed.
  for (const unknown of ['claude-opus-4-9', 'gpt-5.7-mini']) {
    const priced = priceOf(unknown, '2026-09-03', { unknownModel: 'family' })
    assert.equal(priced?.confidence, 'family', `${unknown} has no family fallback`)
    const claim = `\`${unknown}\` → \`${priced?.family}\``
    assert.ok(doc.cost.includes(claim), `docs/cost.md does not say ${claim}`)
  }
})

// ---------------------------------------------------------------------------
// Alert thresholds: the manifest range is what can fire
// ---------------------------------------------------------------------------

test('the alert-threshold range in the manifest is exactly what an alert can fire on', () => {
  const items = properties['tokenPace.alerts.thresholds'].items ?? {}
  assert.equal(items.minimum, 1)
  assert.equal(items.maximum, 100)
  const at = (n: number): number[] =>
    usedThresholds(sanitize({ 'tokenPace.alerts.thresholds': [n] }).alerts)
  assert.deepEqual(at(items.maximum as number), [100], 'the advertised maximum never fires')
  assert.deepEqual(at(items.minimum as number), [1], 'the advertised minimum never fires')
  // Above the advertised maximum nothing can fire, which is why the manifest must not offer it.
  assert.deepEqual(at(110), [])
})

// ---------------------------------------------------------------------------
// Privacy: the list of files read
// ---------------------------------------------------------------------------

test('the Privacy list names every file the extension opens', () => {
  const privacy = doc.privacy
  assert.ok(privacy.length > 0)
  for (const needed of [
    '~/.claude/projects/',            // transcript scan
    '.config/claude/projects/',       // the XDG location src/discover.ts also walks
    '~/.codex/sessions/',
    'archived_sessions/',
    'cachedUsageUtilization',         // the one object read from ~/.claude.json
    'mirror',                         // the status-line bridge's mirror in globalStorage
    'settings.json',                  // bridge install state
    'settings.local.json',            // shadow detection
    'managed-settings',               // shadow detection
    '.credentials.json',              // poll mode, after consent
    'meta.json',                      // an agent transcript's identity sidecar
    'journal.jsonl',                  // a workflow run's journal of started agents and results
    'workflows/wf_',                  // 1.6 L4 (§0a.12): Claude Code's run record, <session>/workflows/wf_<id>.json
    'subagents/',                     // the agent directories the running tree is polled from
    'agent-hook.jsonl',               // 1.6 O4 (§0a.13): the agent hook's mirror in globalStorage, read whenever it exists
    '`agent-hook.js`',                // 1.6 O4: the hook script's copy in globalStorage, which the setup command writes
    'workflows/wf_<id>.json',         // 1.6 L4: the run record's whole name, as the pages give it
    'statusline-mirror.json',         // 1.8 §0a.1: the status-line mirror by its name, the file its contract rows read
    '`statusline-bridge.js`',         // 1.8 §7a Q16: the bridge script's copy in globalStorage, which the command names
  ]) {
    assert.ok(privacy.includes(needed), `the Privacy section does not mention ${needed}`)
  }
  // The claims that must stay: what is never touched.
  for (const never of ['ide/*.lock', 'sessions/*.key', 'oauthAccount']) {
    assert.ok(privacy.includes(never), `the Privacy section dropped the "never read" claim for ${never}`)
  }
})

test('the promise about transcript contents matches what the tool table stores', () => {
  const privacy = doc.privacy
  // The tool side table stores a name, a day, a model and a count — so the sentence may not
  // claim tool calls are never stored, and it has to say what is stored instead.
  assert.equal(/tool calls — are never stored/.test(privacy), false,
    'the Privacy section still promises that tool calls are never stored')
  assert.match(privacy, /tool arguments and tool results — are never stored/)
  assert.match(privacy, /\*\*name\*\* of a tool/)
  // The attribution setting makes the same distinction, in the settings UI.
  const attribution = String(properties['tokenPace.attribution'].markdownDescription)
  assert.equal(/no tool call\./.test(attribution), false, attribution)
  assert.match(attribution, /no tool argument and no tool result/)
})

/** One row of the read contract (scripts/check-privacy.mjs): a reader and the fields it may name. */
interface ReadContractRow {
  what: string
  /** The file the reader takes its fields from, as docs/privacy.md names it. */
  source: string
  file: string
  kind: 'fields' | 'regex' | 'tags' | 'picks'
  fields: string[]
  /** 1.8 §0a.1: the pages (keys of `doc`) that must name the fields; absent means privacy and agents. */
  pages?: Array<keyof typeof doc>
}

// The contract is a plain .mjs so `npm run check:privacy` needs no build step; required here
// rather than imported, as test/privacy.test.ts does, so the TypeScript build needs no .mjs
// declaration file.
const { READ_CONTRACT, checkReadContract } = require('../scripts/check-privacy.mjs') as {
  READ_CONTRACT: ReadContractRow[]
  checkReadContract: (read?: (file: string) => string) => Array<{
    what: string; file: string; unlisted: string[]; unread: string[]; error: string | null
  }>
}

/**
 * What the agent tables take out of the files they read, as the aggregator's own parsers read
 * it. The read contract of scripts/check-privacy.mjs is the documented list, one row per reader:
 * a parser that starts to read one more field fails here — and in `node scripts/check-privacy.mjs`
 * — until the contract lists it, and then until the privacy page and the agents page name it too.
 */
test('the privacy and agents pages name every field the agent tables read, and the ones they never do', () => {
  assert.deepEqual(checkReadContract((file) => readDoc(file)), [],
    'src/agg.ts reads other fields than the read contract lists — update READ_CONTRACT in scripts/check-privacy.mjs, docs/privacy.md and docs/agents.md')
  // The readers 1.5 documented stay in the contract: a row cannot leave it unnoticed.
  const readers = READ_CONTRACT.map((row) => row.what)
  for (const what of ['the identity sidecar', 'the workflow journal', 'the workflow journal (fallback)', 'an agent launch',
    'the tool result', 'the reported totals', 'the task notification',
    // 1.6 §0a.3 (P4): the launch blocks of a reply, and the result that answers a `Workflow` call.
    'the launch blocks', 'the workflow result',
    // 1.6 §0a.2 (P5a): an agent's rejected request, and the limit that refused it.
    'a rejected request', 'a rejected request\'s limit',
    // 1.6 §0a.5 (P6): the tool calls of a reply; §0a.4 (P9): the effort of a response.
    'the tool calls of a reply', 'the effort of a response',
    // 1.6 §0a.6–0a.10 (P13a): the tool errors and the permission mode on the raw line, a cache miss
    // level by level, the writer's version, a compaction and its metadata.
    'tool errors', 'a cache miss', 'a cache miss\'s diagnostics', 'a cache miss\'s reason', 'the writer\'s version',
    'the permission mode', 'a compaction', 'a compaction\'s metadata',
    // 1.6 §0a.12 (P13b): Claude Code's run record — the key-picker's seven keys, and each value's check.
    'the run record', 'the run record\'s values',
    // 1.6 §0a.13 (P14b): the agent hook — its script's four keys of a call, its reader's six fields of a line.
    'the agent hook\'s input', 'the agent hook\'s mirror']) {
    assert.ok(readers.includes(what), `the read contract no longer has a row for ${what}`)
  }
  for (const row of READ_CONTRACT) {
    assert.ok(row.fields.length > 0, `the read contract's row for ${row.what} lists no field`)
    // 1.6 P15: every row names the file it reads, and the privacy page names that file too.
    assert.ok(typeof row.source === 'string' && row.source.length > 0, `the read contract's row for ${row.what} names no file`)
    assert.ok(doc.privacy.includes(row.source), `docs/privacy.md does not name ${row.source}, the file ${row.what} is read from`)
    // 1.8 §0a.1 (pinned and changed): a row names the pages it is held to; the default is 1.6's pair.
    const pages = row.pages ?? ['privacy', 'agents']
    assert.ok(pages.includes('privacy'), `the read contract's row for ${row.what} is not held to docs/privacy.md`)
    for (const field of row.fields) {
      const span = row.kind === 'tags' ? `\`<${field}>\`` : `\`${field}\``
      for (const page of pages) {
        assert.ok(page in doc, `the read contract's row for ${row.what} names a page the docs tests do not read: ${page}`)
        assert.ok(doc[page].includes(span), `the ${page} page does not name ${span} of ${row.what}`)
      }
    }
  }
  // And what stays out, in the words both pages promise it in. 1.6 §0a.1 (P2b): a journal line's
  // `label` and `phase`; §0a.3 (P4): a `Workflow` call's `script` and its result's `scriptPath`
  // and `transcriptDir`; §0a.2 (P5a): an API error line's `errorDetails`.
  for (const never of ['description', 'prompt', 'summary', 'output-file', 'content', 'result', 'label', 'phase',
    'script', 'scriptPath', 'transcriptDir', 'errorDetails',
    // 1.6 §0a.4 (P9): an error line's effort of its own, which the effort's reader never names.
    'perTurnEffort',
    // 1.6 §0a.10, §0a.11 (P13a): the line holding a compaction's summary and what the compaction
    // preserved; a sidecar's workflow phase and its worktree's path.
    'isCompactSummary', 'preservedSegment', 'workflowPhase', 'worktreePath',
    // 1.6 §0a.12 (P13b): the parts of a run record the key-picker never decodes, beside its script and result.
    'logs', 'phases', 'workflowProgress',
    // 1.6 §0a.13 (P14b): the keys of a hook call the agent hook's script never reads.
    'tool_input', 'tool_response', 'transcript_path', 'cwd', 'last_assistant_message']) {
    assert.ok(doc.privacy.includes(`\`${never}\``), `docs/privacy.md no longer says ${never} is never read`)
    assert.ok(doc.agents.includes(`\`${never}\``), `docs/agents.md no longer says ${never} is never read`)
  }
})

/**
 * 1.8 §0a.1, §7a Q11 (P4): the status-line mirror's reader is a row set of the contract, held to the
 * privacy page and the prompt-cache page; both say what is never read of the payload, that 1.3 to
 * 1.7 kept it whole and 1.8 stops it, and the bridge's own pages say where its script lives now.
 */
test('the privacy and prompt-cache pages name the mirror\'s fields, what is never read of the payload, and that 1.8 narrows the mirror', () => {
  const mirrorRows = READ_CONTRACT.filter((row) => row.source === 'statusline-mirror.json')
  assert.ok(mirrorRows.length >= 10, 'the status-line mirror has lost its contract rows')
  for (const row of mirrorRows) assert.deepEqual(row.pages, ['privacy', 'promptCache'], row.what)
  // 1.8's two new fields, on both pages, and in the quota-sources section that points at them.
  for (const field of ['session_id', 'recache_tokens_if_cold']) {
    assert.ok(mirrorRows.some((row) => row.fields.includes(field)), `no contract row reads ${field}`)
    assert.ok(doc.quotaSources.includes(`\`${field}\``), `docs/quota-sources.md does not name ${field}`)
  }
  assert.ok(doc.quotaSources.includes('[Prompt cache](prompt-cache.md#what-is-read)'), 'docs/quota-sources.md does not point at the page')
  for (const never of ['session_name', 'prompt_id', 'transcript_path', 'cwd', 'workspace', 'pr', 'worktree', 'agent', 'version',
    'output_style', 'vim', 'effort', 'thinking', 'fast_mode', 'exceeds_200k_tokens', 'caching_observed', 'requests', 'misses',
    'expected_rebuilds', 'cache_write_tokens', 'miss_recache_tokens', 'last_miss_at', 'last_miss_cause', 'miss_causes']) {
    assert.ok(doc.privacy.includes(`\`${never}\``), `docs/privacy.md does not say ${never} is never read`)
    assert.ok(doc.promptCache.includes(`\`${never}\``), `docs/prompt-cache.md does not say ${never} is never read`)
  }
  const flat = (text: string): string => text.replace(/\s+/g, ' ')
  for (const claim of ['Never read, and since 1.8 never in the mirror:', 'the rest of `cost`']) {
    assert.ok(flat(doc.privacy).includes(claim), `docs/privacy.md does not say: ${claim}`)
    assert.ok(flat(doc.promptCache).includes(claim), `docs/prompt-cache.md does not say: ${claim}`)
  }
  // §7a Q11: what 1.3 to 1.7 kept, and that 1.8 stops it.
  for (const claim of ['**1.3 to 1.7 stored the payload as Claude Code piped it**', '1.8 stops that: on its first activation it rewrites such a mirror',
    'the script\'s next write replaces the file anyway']) {
    assert.ok(flat(doc.privacy).includes(claim), `docs/privacy.md does not say: ${claim}`)
  }
  // The allow-lists as the reader has them, and the per-session memory as the manager keeps it.
  const { RECACHE_MAX, STATUSLINE_SESSION_RE } = require('../src/quota') as typeof import('../src/quota')
  const { CACHE_READINGS_MAX, CACHE_READING_KEEP_MS } = require('../src/quotaManager') as typeof import('../src/quotaManager')
  assert.equal(STATUSLINE_SESSION_RE.source, '^[A-Za-z0-9_-]{1,64}$')
  assert.ok(flat(doc.promptCache).includes('Only an id of letters, digits, `_` and `-`, at most 64 characters, is taken'))
  assert.ok(flat(doc.promptCache).includes(`a whole count from 0 to ${RECACHE_MAX.toLocaleString('en-US').replace(/,/g, ' ')}`))
  assert.ok(flat(doc.promptCache).includes(`at most ${CACHE_READINGS_MAX} sessions`))
  assert.equal(CACHE_READING_KEEP_MS, 2 * 3_600_000)
  assert.ok(flat(doc.promptCache).includes('none whose reading is older than two hours'))
  assert.ok(flat(doc.privacy).includes('one per session for at most two hours'))
  // §7a Q16: where the script lives, on the two pages a reader looks it up in, and the check of its bundle.
  for (const [name, text] of [['quota-sources', doc.quotaSources], ['windows-wsl-remote', doc.windows]] as const) {
    assert.ok(text.includes('`<globalStorage>/statusline-bridge.js`'), `docs/${name}.md does not say where the bridge's script lives`)
  }
  assert.ok(flat(doc.quotaSources).includes('only the `statusLine.command` string changes'), 'docs/quota-sources.md does not say what the move changes')
  assert.ok(flat(doc.privacy).includes('The status-line bridge\'s bundle, `dist/statusline-bridge.js`'), 'docs/privacy.md does not name the bridge bundle\'s rule')
})

/**
 * The details panel prints the sentence a state was derived with, and the agents page quotes
 * them — with an example where the sentence has a time or an age. Every state sentence the tree
 * builder can write is either quoted or the same sentence with or without its time.
 */
test('docs/agents.md quotes the state sentences the tree builder writes, word for word', () => {
  const src = readDoc('src/agentTreeBuild.ts')
  const quoted = [
    'Completed — the parent recorded the result at {0}.',
    'Failed — the parent recorded the failure at {0}.',
    'Running — inferred: the transcript changed {0} and no result was recorded yet.',
    'Running — inferred: a child agent of this agent is still running.',
    'Unknown — inferred: no result was recorded and the transcript has been silent since {0}; the agent may have been stopped.',
    'Completed — the workflow journal recorded the result.',
    'Active — inferred: the session transcript changed {0}.',
    'Active — inferred: an agent of this session is running.',
    'Idle — inferred: the session transcript has been silent since {0}.',
    "Unknown — inferred: the session's own transcript has not been read; only its agents were.",
    'Running — inferred: at least one agent of this run is running.',
    // 1.6 D2 (P2b): a run is decided by its members' outcomes — its old "Failed — at least one agent
    // of this run has a recorded failure." and "Done — every agent of this run has a recorded
    // result." are gone from the builder and the page.
    'Done — every agent of this run has a recorded outcome, and at least one completed.',
    'Failed — every agent of this run has a recorded outcome, and none completed.',
    // 1.6 §7c (P4): "outcome", as the run's other sentences say — its "… a recorded result, …" is gone.
    'Unknown — inferred: not every agent of this run has a recorded outcome, and none is running.',
    "Running — inferred: the parent recorded the launch {0} and no result yet; the agent's transcript has not been seen yet.",
    "Unknown — inferred: the parent recorded the launch at {0} but no result, and the agent's transcript was never seen; the agent may have been stopped.",
    // 1.6 D6: an agent that wrote on after its outcome.
    'Running — inferred: the transcript changed {0}, after an outcome was recorded at {1}.',
    'Unknown — inferred: the transcript went on after an outcome was recorded at {0}, and has been silent since {1}.',
    // 1.6 D7 (P2a): a stop the parent recorded, in its own word; a run whose every agent was stopped.
    'Stopped — the parent recorded ‘{0}’ at {1}.',
    'Stopped — every agent of this run has a recorded outcome, and none completed: the last attempt of each step was stopped.',
    // 1.6 D2, D7 (P2b): what the workflow journal recorded — a failure, a retry, a replacement.
    'Failed — the workflow journal recorded the failure.',
    'Failed, retried — the workflow journal recorded the failure and started the same step again (agent {0}).',
    'Stopped, replaced — the workflow journal started the same step again (agent {0}) before this agent recorded a result.',
    // 1.6 N4 (P4): a run's own end, as its parent recorded it for its latest launch; a run an agent
    // of which wrote on after it; a run nothing but its launch shows yet.
    'Completed — the parent recorded the end of this run at {0}.',
    'Failed — the parent recorded the failure of this run at {0}.',
    'Stopped — the parent recorded ‘{0}’ for this run at {1}.',
    'Running — inferred: an agent of this run wrote on after the parent recorded its end at {0}.',
    'Running — inferred: the parent launched this run {0} and no agent has written yet.',
    'Unknown — inferred: the parent launched this run at {0}, but no agent of it was ever seen.',
    // 1.6 N3 (P5a): an agent whose last request the API rejected — with the reason the line gave,
    // and without one when it gave none.
    'Unknown — inferred: no result was recorded; the last request, at {0}, was rejected — {1}.',
    'Unknown — inferred: no result was recorded; the last request, at {0}, was rejected.',
    'Running — inferred: the transcript changed {0}; its last request was rejected — {1}.',
    'Running — inferred: the transcript changed {0}; its last request was rejected.',
    // 1.6 D4 (P5b): a run's collector — its agents without a counted reply — by its members' states.
    'Running — inferred: at least one of these agents is running.',
    'Unknown — inferred: not every one of these agents has a recorded outcome, and none is running.',
    'Done — every one of these agents has a recorded outcome, and at least one completed.',
    'Failed — every one of these agents has a recorded outcome, and none completed.',
    'Failed — the workflow journal recorded a failure for each of them.',
    'Stopped — every one of these agents has a recorded outcome, and none completed: the last attempt of each step was stopped.',
    // 1.6 N5 (P6): an agent that went quiet on a tool call names the call.
    'Unknown — inferred: no result was recorded and the transcript has been silent since {0}, after a {1} call; the agent may have been stopped.',
    // 1.6 L4 (P13b): a run's end as Claude Code's own run record states it, its word quoted.
    "Completed — Claude Code's run record says ‘{0}’.",
    "Failed — Claude Code's run record says ‘{0}’.",
    "Stopped — Claude Code's run record says ‘{0}’.",
  ]
  // The run sentences 1.6 replaced are written nowhere any more.
  for (const gone of ['Failed — at least one agent of this run has a recorded failure.',
    'Done — every agent of this run has a recorded result.',
    'Unknown — inferred: not every agent of this run has a recorded result, and none is running.']) {
    assert.equal(src.includes(gone), false, `src/agentTreeBuild.ts still writes: ${gone}`)
    assert.equal(doc.agents.replace(/\s+/g, ' ').includes(gone), false, `docs/agents.md still quotes: ${gone}`)
  }
  const flat = doc.agents.replace(/\s+/g, ' ')
  for (const sentence of quoted) {
    assert.ok(src.includes(`'${sentence}'`) || src.includes(`"${sentence}"`),
      `src/agentTreeBuild.ts no longer writes: ${sentence}`)
    // Every placeholder, {0} and {1} alike, stands for the example the page gives there.
    const pattern = sentence.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\\\{\d\\\}/g, '[^|]+?')
    assert.match(flat, new RegExp(pattern), `docs/agents.md does not quote: ${sentence}`)
  }
  // 1.6 D7: the finder knows the stopped states and the ", retried" / ", replaced" twins P2b adds.
  const written = [...src.matchAll(
    /\bt\((['"])((?:Completed|Failed|Running|Unknown|Active|Idle|Done|Stopped)(?:, (?:retried|replaced))? — .*?)\1/g)]
    .map((m) => m[2])
  assert.ok(written.length >= quoted.length, `only ${written.length} state sentences found in src/agentTreeBuild.ts`)
  // A sentence is covered when the page quotes it or its twin: the same sentence without the
  // time at its end, written where the time is unknown — "… recorded ‘{0}’." beside "… recorded
  // ‘{0}’ at {1}." — whichever of the two the page quotes.
  const timeless = (x: string): string | null => {
    const at = / at \{\d\}\.$/.exec(x)
    return at === null ? null : x.slice(0, at.index) + '.'
  }
  const covered = (s: string): boolean => quoted.includes(s)
    || quoted.some((q) => timeless(q) === s) || (timeless(s) !== null && quoted.includes(timeless(s) as string))
  assert.deepEqual(written.filter((s) => !covered(s)), [], 'a state sentence the agents page does not quote')
})

test('docs/agents.md names the O3 rows of the details as the tree builder writes them, and the words for what it never reads', () => {
  // 1.6 O3 (P13a): tool errors, cache misses, compactions, the version and the permission mode — the
  // messages the builder writes and the examples the page quotes of them.
  const src = readDoc('src/agentTreeBuild.ts')
  const flat = doc.agents.replace(/\s+/g, ' ')
  // 1.7 V-A: the Compactions row is one of three whole sentences, one per trigger.
  for (const written of ['Tool errors', '{0} of {1} tool calls', 'Cache misses', '{0} tokens not read from the cache', 'model changed',
    'cache unavailable', 'Compactions', '{0} · last at {1} (manual, {2} → {3})', '{0} · last at {1} (auto, {2} → {3})',
    '{0} · last at {1} (–, {2} → {3})', 'Claude Code version', 'Permission mode']) {
    assert.ok(src.includes(`t('${written}'`), `src/agentTreeBuild.ts no longer writes: ${written}`)
  }
  // 1.6 P15: the examples are the harness's (research/webview-check, the rejected workflow agent's
  // details) — the join of several reasons is the builder's own unit example.
  for (const example of ['`1 of 2 tool calls`', '`tools changed 1`', '`model changed 2 · cache unavailable 1`', '`10.4K tokens not read from the cache`',
    '`1 · last at 11:48 (auto, 13.5K → 3.1K)`', '**Claude Code version**', '**permission mode**', '`bypassPermissions`',
    'no `Tool errors` row rather than a zero nobody counted', 'only the stated ones are summed']) {
    assert.ok(flat.includes(example), `docs/agents.md does not say: ${example}`)
  }
  // The raw-line gates, as both pages promise them.
  for (const page of [doc.agents, doc.privacy]) {
    const text = page.replace(/\s+/g, ' ')
    assert.ok(text.includes('counted on the raw line'), 'a page no longer says the tool errors are counted on the raw line')
    assert.ok(/`permissionMode`[^.]*matched on the raw line/.test(text), 'a page no longer says the permission mode is matched on the raw line')
  }
})

test('docs/agents.md names a run\'s collector as the tree builder writes it: both labels, the sentence of its details, its running count', () => {
  // 1.6 D4 (P5b): the agents of a run without a counted reply are one node — the page says how it
  // is labelled, why it has no figures, and how the running list and its heading count it.
  const src = readDoc('src/agentTreeBuild.ts')
  const flat = doc.agents.replace(/\s+/g, ' ')
  for (const [written, example] of [
    ['{0} agent(s) without a counted reply', '263 agent(s) without a counted reply'],
    ['{0} agent(s) failed before their first reply', '3 agent(s) failed before their first reply'],
    ['These agents were started, but none of them wrote a reply that could be counted — their transcripts hold no response, or only rejected requests.',
      'These agents were started, but none of them wrote a reply that could be counted — their transcripts hold no response, or only rejected requests.'],
  ]) {
    assert.ok(src.includes(`'${written}'`), `src/agentTreeBuild.ts no longer writes: ${written}`)
    assert.ok(flat.includes(example), `docs/agents.md does not quote: ${example}`)
  }
  assert.ok(readDoc('src/webview/main.ts').includes("tr('~{0} of them running'"), 'the page no longer says how many of a collector run')
  for (const claim of ['`~10 of them running`', '`Running now (11)`', '`(~10 of them running)`', '### Agents without a counted reply']) {
    assert.ok(doc.agents.includes(claim), `docs/agents.md does not say: ${claim}`)
  }
})

test('docs/agents.md states the limits the tree, the push and the sanitisers work to', () => {
  const agg = readDoc('src/agg.ts')
  const throttle = /SECTION_MIN_INTERVAL_MS[^=]*=\s*\{\s*agents:\s*(\d+)\s*\}/.exec(readDoc('src/dashboard.ts'))
  assert.ok(throttle, 'src/dashboard.ts no longer states the push interval of the agents section')
  const name = /const NAME_ALPHABET = \/\^(\[[^\]]+\])\+\$\//.exec(agg)
  const id = /const ID_ALPHABET = \/\^(\[[^\]]+\])\+\$\//.exec(agg)
  const depth = /const MAX_SPAWN_DEPTH = (\d+)/.exec(agg)
  assert.ok(name && id && depth, 'src/agg.ts no longer states its agent alphabets and depth cap')
  const host = readDoc('src/extension.ts').replace(/_/g, '')
  const wholeEvery = /export const VMMININTERVALMS = (\d+)/.exec(host)
  const saveEvery = /export const SAVEMS = (\d+)/.exec(host)
  const agentSave = /export const AGENTSAVEMS = (\d+)/.exec(host)
  assert.ok(wholeEvery && saveEvery && agentSave, 'src/extension.ts no longer states its rebuild and save intervals')
  const claims: Array<[string, string]> = [
    [`the last **${AGENT_RETENTION_DAYS} days**`, 'what the tree covers'],
    [`**${AGENT_RETENTION_DAYS} days** after its last line`, 'when a record is dropped'],
    // 1.7 F2 (pinned and changed): the cap on the active sessions, and the same cap inside the group
    // of earlier sessions.
    [`At most **${MAX_ROOTS}** sessions are listed as roots, and at most **${MAX_ROOTS}** inside the group of earlier sessions`, 'the session caps'],
    // 1.6 D3 (§7a Q15): the node cap became a window per node and a stated cap on the payload.
    [`at most **${MAX_GROUP_CHILDREN}** of its children at a time`, 'the window of an opened node'],
    [`at most **${MAX_MORE_PAGES}** times`, 'the most "more" steps of one node'],
    [`the "more" steps of at most ${MAX_AGENT_MORE} nodes`, 'the cap on remembered "more" steps'],
    [`at most **${MAX_PAGE_NODES}** nodes`, 'the page payload cap'],
    [`more than **${MAX_TREE_DEPTH}** levels`, 'the depth cap'],
    [`within the last **${RUNNING_WINDOW_MS / 60_000} minutes**`, 'the running window'],
    [`a response within the last ${SESSION_ACTIVE_MS / 60_000} minutes`, 'the active window'],
    [`a response within the last ${ROOT_WINDOW_MS / 3_600_000} hours`, 'which sessions are roots'],
    [`once every **${Number(throttle[1]) / 1000} seconds**`, 'the push interval'],
    [`at most ${MAX_AGENT_EXPANDED} opened nodes`, 'the cap on opened nodes'],
    [`at most **${MAX_RUNNING_LIST}** running agents`, 'the running list cap'],
    [`more than **${RESUMED_AFTER_MS / 1000} seconds** after`, 'how late a line may follow a recorded outcome'],
    [`at least **${MIN_SHORT_ID}** characters`, 'the shortest short id'],
    [`at most **${MAX_RUN_AGENTS}** agents of its journal`, 'the journal agents a run keeps'],
    [`a line of at most ${JOURNAL_PARSE_MAX / 1024} KB without that head`, 'the journal fallback cap'],
    [`from **${SPAN_IN_DAYS_FROM_MS / 3_600_000} hours** on`, 'when a span is written in days'],
    // 1.6 N5 (P6): when a running agent's row says how long it has been silent.
    [`has not changed for **${SILENT_AFTER_MS / 60_000} minutes**`, 'when a running agent\'s silence is stated'],
    // 1.6 N6 (P7): how far back a session's or a run's start is named by its weekday.
    [`within the last **${WEEKDAY_NAMES_WITHIN_MS / 86_400_000} days**`, 'when a start is named by its weekday'],
    // 1.6 L2 (P9): from how long an agent ran on its details say what it used per minute.
    [`From **${PER_MINUTE_FROM_MS / 60_000} minute** on, what it used **per minute**`, 'when an agent\'s pace is stated'],
    // 1.6 L3 (P10a): the 7-day block's rows and its largest agents.
    [`The largest usage first, at most **${WEEK_ROWS}** rows`, 'the rows of the 7-day block'],
    // 1.6 L5 (P11): how often the other sections follow while agents write, and the save cadence.
    [`at most once every **${Number(wholeEvery[1]) / 1000} seconds**, the tree and the status bar at every read`, 'the whole rebuild\'s interval'],
    [`the state is saved at most once every **${Number(agentSave[1]) / 1000} seconds** instead of every ${Number(saveEvery[1]) / 1000}`, 'the save cadence while agents run'],
    [`**The ${TOP_AGENTS} largest agents** by usage`, 'the largest agents the 7-day block names'],
    [`at most ${AGENT_META_MAX_BYTES / 1024} KB`, 'the sidecar size cap'],
    [`at most ${AGENT_NAME_MAX_CHARS} characters of \`${name[1]}\``, 'the type and alias cap'],
    [`a model id from a response at most ${AGENT_MODEL_MAX_CHARS}`, 'the model id cap'],
    [`id at most ${AGENT_ID_MAX_CHARS} characters of \`${id[1]}\``, 'the id cap'],
    [`a whole number from 1 to ${depth[1]}`, 'the spawn depth range'],
    // 1.6 O3 (P13a, §0a.9): the permission modes waiting for a record.
    [`for at most **${PENDING_MODE_MAX}** transcripts, the oldest dropped first`, 'the permission modes kept before a record'],
    // 1.6 L4 (P13b, §0a.12): how much of a run record is read, in what steps, and how much of it is decoded.
    [`only from a regular file of at most ${RUN_RECORD_MAX_BYTES / (1024 * 1024)} MB, never through a link`, 'the run record cap'],
    [`walks the file's bytes in ${RUN_RECORD_CHUNK_BYTES / 1024} KB chunks`, 'the run record\'s chunk'],
    [`decodes a top-level key of at most ${RUN_RECORD_SCALAR_MAX} bytes and, of the seven, a value of at most ${RUN_RECORD_SCALAR_MAX} bytes`, 'what the key-picker decodes'],
    // 1.6 O4 (P14b, §0a.13): the agent hook — how long a call counts, what the reader takes, what the
    // script reads and how far the file grows.
    [`while it is younger than **${HOOK_MAX_AGE_MS / 60_000} minutes**`, 'how long an agent hook call counts'],
    [`at most its last **${HOOK_TAIL_BYTES / 1024} KB**, lines of at most **${HOOK_LINE_MAX_BYTES / 1024} KB**`, 'what the hook reader takes'],
    [`reads at most **${HOOK_STDIN_MAX_BYTES / (1024 * 1024)} MB** of input`, 'the hook script\'s input cap'],
    [`Over **${HOOK_ROTATE_BYTES / 1024} KB** the file is cut to its newest **${HOOK_KEEP_LINES}** lines`, 'the hook mirror\'s cut'],
  ]
  const flat = doc.agents.replace(/\s+/g, ' ')
  for (const [claim, what] of claims) {
    assert.ok(flat.includes(claim), `docs/agents.md does not state ${what}: ${claim}`)
  }
})

test('docs/agents.md says what the group of earlier sessions is, as the tree builds it (1.7 F2)', () => {
  const flat = doc.agents.replace(/\s+/g, ' ')
  for (const claim of [
    '**Active sessions** are the roots, the most recent first; every other session is in one closed row after them',
    'Every session that is not active — idle, or one whose own transcript was never read — sits in one row after the active ones, always the last root: `Earlier sessions (12)`',
    'It is a container, not a thing with a state: it has no glyph',
    'no details and no figures of its own; its second line is what the agents of the sessions it holds came to, their tallies added',
    'or `–` when none of them started an agent',
    '`Active — inferred: an agent of this session is running.`',
    'so a running agent is never inside the group, and the running list above the tree is the same with the group as without it',
    '`- Earlier sessions (12) (40 started · 31 ✓ · 3 ✕ · 6 ↻)`',
    'The group of earlier sessions has no details: a click on its row opens or closes it.',
    'inside the closed group of earlier sessions too',
    '`14 started · … · the 23 most recent sessions of the last 7 days`',
  ]) assert.ok(flat.includes(claim), `docs/agents.md does not say: ${claim}`)
  // The sentences the tree's own words say, word for word.
  const tree = readDoc('src/agentTreeBuild.ts')
  assert.ok(tree.includes("t('Earlier sessions ({0})'"), 'the group is no longer named so')
  assert.ok(tree.includes("t('Active — inferred: an agent of this session is running.')"))
  assert.equal(flat.includes('Only the sessions show until you open one'), false, 'docs/agents.md still says only the sessions show')
  assert.ok(doc.dashboard.replace(/\s+/g, ' ').includes('only the active sessions show, every other session in one closed row after them'),
    'docs/dashboard.md\'s agents row does not name the group')
})

test('the pages say what a colour means in the Agents section — an outcome, not a pace — and that it is never the only carrier (1.7 F4)', () => {
  const flat = (text: string): string => text.replace(/\s+/g, ' ')
  const sentence = 'In the Agents section a colour means an outcome — green done, yellow unknown, red failed, blue running —, not a pace: on the quota cards yellow and red say how fast a window fills.'
  assert.ok(flat(doc.agents).includes(sentence), 'docs/agents.md does not say what a colour means there')
  assert.ok(flat(doc.numbers).includes(sentence), 'docs/numbers.md does not say what a colour means in the Agents section')
  for (const claim of [
    'mixed 60 : 40 with the text colour',
    'at least 4.5:1 against the sidebar and against a row\'s hover background on Dark Modern, Light Modern, 2026 Dark and 2026 Light',
    'a stop\'s name (`■`, dim) and a superseded attempt\'s (faded) stay in the text colour',
    'The row that is open — its details under it — is in the text colour too',
    'the colour is the third carrier, never the only one',
    'the state colours give way to it',
    '`started`, `↻` and `■` stay in the figures\' dim tone',
    'the unknown `?` in the yellow an unknown agent\'s name wears',
  ]) assert.ok(flat(doc.agents).includes(claim), `docs/agents.md does not say: ${claim}`)
  const dashboard = flat(doc.dashboard)
  assert.ok(dashboard.includes('the third carrier beside the glyph and the words, never the only one'), 'docs/dashboard.md does not name the colours')
  assert.ok(dashboard.includes('the names and the tallies in its text colour, the state colours giving way'), 'docs/dashboard.md does not say forced colours win')
  // The mix the pages quote is the stylesheet's.
  const css = readDoc('src/dashboard.ts')
  for (const state of ['done', 'unknown', 'failed', 'running']) assert.ok(new RegExp(`--ag-c-${state}: color-mix\\(in srgb, [^;]+ 60%, var\\(--vscode-foreground\\)\\);`).test(css), state)
})

test('the pages say what the tree\'s guide lines are — the explorer\'s indent-guide colour, decoration, behind the rows, stopping at an open panel (1.8 L-4), the text colour in forced colours (1.7 F6)', () => {
  const flat = (text: string): string => text.replace(/\s+/g, ' ')
  const agents = flat(doc.agents)
  for (const claim of [
    '**Guide lines.** Lines connect every child to its parent',
    'the last child\'s line ends at its stub (`└`)',
    'The roots — the sessions and the group of earlier sessions — have none, and neither have the running list and the 7-day block',
    'in the colour the theme gives the explorer\'s indent guides (`tree.indentGuidesStroke`',
    '2.50:1 against the sidebar on Dark Modern, 2.21:1 on Light Modern',
    // 1.8 L-4 (pinned and changed: "… and pass behind an open details panel"): the lines stop at the panel,
    // which paints no colour of its own.
    'they never cross a word, a glyph, a toggle or the open row\'s edge, and change no row\'s height or width',
    'At an open details panel they stop: a line that runs past the panel ends a pixel above its border and goes on a pixel below it',
    'the panel paints no colour of its own — it shows the page\'s own background wherever the view stands, in the side bar or dragged into the panel area',
    'They are decoration only — nothing to read, nothing to copy',
    'In a forced-colours theme they are in the text colour.',
    'the guide lines the text colour',
  ]) assert.ok(agents.includes(claim), `docs/agents.md does not say: ${claim}`)
  const dashboard = flat(doc.dashboard)
  assert.ok(dashboard.includes('the tree\'s guide lines, which connect every child to its parent in the theme\'s indent-guide colour, are decoration only'),
    'docs/dashboard.md does not name the guide lines')
  assert.ok(dashboard.includes('the open row and the guide lines in the system\'s colours'), 'docs/dashboard.md does not say how forced colours draw them')
  // The token the pages name is the stylesheet's, and so is the forced colour.
  const css = readDoc('src/dashboard.ts')
  assert.ok(css.includes('--ag-guide: var(--vscode-tree-indentGuidesStroke, var(--rule));'), 'the lines no longer take the indent-guide token')
  assert.ok(css.includes('.agtree ul[role="group"] > li::before, .agtree ul[role="group"] > li::after { border-color: CanvasText; }'))
  // 1.8 L-4: the gap is the stylesheet's, and the panel has no background of its own.
  assert.ok(css.includes('.agtree ul[role="group"] > li.ag-gap::before { clip-path: polygon('), 'the lines no longer stop at the panel: say it in the docs')
  assert.equal(agents.includes('pass behind an open details panel'), false, 'docs/agents.md still says the lines pass behind the panel')
})

test('the agent hook is documented as it works: installed by you, removed by you, Node.js required, the tree\'s words (1.6 O4)', () => {
  const flat = (text: string): string => text.replace(/\s+/g, ' ')
  const agents = flat(doc.agents)
  const privacy = flat(doc.privacy)
  // The command, as the palette shows it, on the commands page and on the agents page.
  const command = manifest.contributes.commands.find((c) => c.command === 'tokenPace.showAgentHookSetup')
  assert.ok(command, 'the manifest has no tokenPace.showAgentHookSetup')
  assert.equal(command.title, 'Set Up the Agent Hook…')
  assert.ok(doc.commands.includes('| `Token Pace: Set Up the Agent Hook…` |'), 'docs/commands.md has no row for the command')
  assert.ok(agents.includes('*Token Pace: Set Up the Agent Hook…*'), 'docs/agents.md does not name the command')
  // Installed by you, removed by you; nothing written into ~/.claude; Node.js on the PATH.
  for (const [page, text] of [['agents', agents], ['privacy', privacy]] as const) {
    assert.ok(/\*\*installed by you, removed by you\*\*/i.test(text), `docs/${page}.md does not say it is installed and removed by you`)
    assert.ok(text.includes('never writes into `~/.claude`'), `docs/${page}.md does not say nothing is written into ~/.claude`)
  }
  for (const claim of ['**Node.js on the PATH** Claude Code runs its hooks with', 'there is no fallback without it',
    '`node "<globalStorage>/agent-hook.js" "<globalStorage>/agent-hook.jsonl"`',
    'In Claude Code\'s auto mode no permission dialog is shown, so no wait is reported.',
    'The marker is shown when Claude Code reports it', '`waiting for approval`', '`waiting for input`',
    '`The agent hook reported at 14:21: waiting for approval.`', 'the row `Agent hook` — `waiting for approval at 14:21`',
    'a marker, never a state', '`fetch(`']) {
    assert.ok(agents.toLowerCase().includes(claim.toLowerCase()), `docs/agents.md does not say: ${claim}`)
  }
  // The four events the snippet installs are the ones the page names, and PostToolUse is not among them.
  for (const event of HOOK_EVENTS) assert.ok(agents.includes(`\`${event}\``), `docs/agents.md does not name ${event}`)
  assert.equal(/PostToolUse/.test(doc.agents + doc.privacy), false, 'a page names PostToolUse, which the hook does not install')
  // The sentences and the row quoted on the page are the ones the tree builder writes.
  const src = readDoc('src/agentTreeBuild.ts')
  for (const key of ["t('The agent hook reported at {0}: waiting for approval.'", "t('waiting for approval')", "t('waiting for input')",
    "t('Agent hook')"]) {
    assert.ok(src.includes(key), `src/agentTreeBuild.ts no longer writes ${key}`)
  }
  // The setup document says what the page says it says.
  const setup = flat(hookSetupDocument('/x/globalStorage/frederik.token-pace', 'linux'))
  for (const claim of ['Token Pace writes nothing into `~/.claude`', 'Node.js on the PATH', 'no fallback', 'Delete the four entries',
    '`agent-hook.jsonl` then stops growing, and its lines stop counting after 30 minutes.']) {
    assert.ok(setup.includes(claim), `the setup document does not say: ${claim}`)
  }
})

test('the pages list what Clear Stored Data offers — the agent hook\'s mirror among it — and say its script stays (1.6 P16)', () => {
  const flat = (text: string): string => text.replace(/\s+/g, ' ')
  const exp = flat(doc.export)
  const para = exp.slice(exp.indexOf('**Clear Stored Data…**'), exp.indexOf('**Uninstalling**'))
  assert.ok(para.length > 100, 'docs/export.md has no Clear Stored Data paragraph')
  // Every file the list names by its file name is named on the page, in backticks.
  // 1.8 P10 (§0a.7, pinned and changed): the keep-warm accounting joins the list. 1.10 P3 (§0a.1, pinned and
  // changed): and the prompt list.
  const keys: StoredKey[] = ['state', 'quota', 'history', 'mirror', 'hookMirror', 'keepWarm', 'prompts']
  for (const key of keys) {
    const file = /\(([^)]+)\)$/.exec(labelOf(key))?.[1]
    assert.ok(file, `the list's label of ${key} names no file`)
    assert.ok(para.includes(`\`${file}\``), `docs/export.md does not list ${file}`)
  }
  for (const claim of ['the [agent hook](agents.md#the-agent-hook)\'s mirror (`agent-hook.jsonl`)',
    'Deleting the agent hook\'s mirror is safe — its script writes the file again on the next hook call',
    'The script itself, `agent-hook.js`, is not in the list, and the note under the mirror says so: it stays while the hook is installed',
    'and goes with the extension\'s storage when Token Pace is uninstalled', '`tokenPace.writeQuotaCache`']) {
    assert.ok(para.includes(claim), `docs/export.md does not say: ${claim}`)
  }
  const row = doc.commands.split('\n').find((l) => l.startsWith('| `Token Pace: Clear Stored Data…` |')) ?? ''
  assert.ok(row.includes('the agent hook\'s mirror `agent-hook.jsonl`') && row.includes('`agent-hook.js` stays while the hook is installed and goes with the storage on uninstall'), row)
  const agents = flat(doc.agents)
  for (const claim of ['*Clear Stored Data…* lists `agent-hook.jsonl` among what it can delete', '`agent-hook.js` stays while the hook is installed and goes with the storage on uninstall',
    '`agent-hook.jsonl` then stops growing, and its lines stop counting after 30 minutes']) {
    assert.ok(agents.includes(claim), `docs/agents.md does not say: ${claim}`)
  }
})

test('the pages quote the Quick Pick\'s agent summary as the view writes it — "Last 7 days: " first (1.6 P16)', () => {
  const flat = (text: string): string => text.replace(/\s+/g, ' ')
  assert.ok(readDoc('src/textViews.ts').includes("t('Last 7 days: {0}', tallyText(tally))"), 'the view no longer writes the label: say it in the docs')
  assert.ok(flat(doc.agents).includes('`Last 7 days: 14 started · 5 ✓ · 2 ✕ · …`'), 'docs/agents.md does not quote the summary')
  assert.ok(flat(doc.dashboard).includes('*Last 7 days: 14 started · 5 ✓ · 2 ✕ · …*'), 'docs/dashboard.md does not quote the summary')
  for (const [page, text] of [['agents', doc.agents], ['dashboard', doc.dashboard]] as const) {
    assert.equal(/· … · last 7 days[`*]/.test(flat(text)), false, `docs/${page}.md still quotes the ' · last 7 days' tail`)
  }
})

test('docs/dashboard.md says a forced-colours theme paints the pressed chips in the highlight colours, as the page\'s rule does (1.6 P16)', () => {
  assert.ok(readDoc('src/dashboard.ts').includes('  button[aria-pressed="true"]:not(.ag-row) { forced-color-adjust: none; background: Highlight; color: HighlightText; border-color: Highlight; outline-color: CanvasText; }'),
    'the rule moved: say it in the docs')
  // 1.7 F1 (pinned and changed: "a range, a provider, a model, …"): the providers are no chips of the
  // filter bar any more; the provider switch's buttons are chips like the others.
  assert.ok(doc.dashboard.replace(/\s+/g, ' ').includes('every pressed chip of the page (a button of the provider switch, a range, a model, the custom dates, the cache switch, the chart\'s `subagents` and cost line, the heatmap\'s metric, the hours\' zone) in the highlight colours'),
    'docs/dashboard.md does not say how a pressed chip looks in a forced-colours theme')
  // 1.7 D-B (pinned and changed: "A pressed chip is the one element the page takes out of the theme's
  // adjustment, …"): the chart's bands by model are taken out too. 1.8 L-5 (pinned and changed: "… are
  // the two things …"): and a thin subagents' band of the split.
  assert.ok(readDoc('src/dashboard.ts').includes('  .band:not(.sp-main, .sp-sub) { forced-color-adjust: none;'),
    'the bands by model are no longer taken out of the adjustment: say it in the docs')
  assert.ok(readDoc('src/dashboard.ts').includes('  .band.sp-sub.band-thin { forced-color-adjust: none; outline: none; background: repeating-linear-gradient(90deg, CanvasText 0 1px, Canvas 1px 3px); }'),
    'a thin subagents\' band is no longer striped: say it in the docs')
  assert.ok(doc.dashboard.replace(/\s+/g, ' ').includes('A pressed chip, a band of the chart by model and a thin subagents\' band of the split are the three things the page takes out of the theme\'s adjustment, and they wear nothing but the theme\'s own system colours'),
    'docs/dashboard.md does not say what the page takes out of the theme\'s adjustment')
  assert.ok(doc.dashboard.replace(/\s+/g, ' ').includes('a subagents\' band drawn under 4 px tall, which its ring would fill whole, as vertical stripes instead, one pixel of the text colour in three'),
    'docs/dashboard.md does not say how a thin subagents\' band is drawn in a forced-colours theme')
  assert.equal(doc.dashboard.replace(/\s+/g, ' ').includes('are the two things the page takes out'), false,
    'docs/dashboard.md still names two things taken out of the adjustment')
  assert.equal(doc.dashboard.replace(/\s+/g, ' ').includes('one element the page takes out of the theme\'s adjustment'), false,
    'docs/dashboard.md still says the pressed chip is the one element taken out')
})

test('docs/dashboard.md says a forced-colours theme draws the chart\'s bands by model as patterns in its two colours, as the page\'s rules do (1.7 D-B)', () => {
  const style = readDoc('src/dashboard.ts')
  for (const rule of ['.band.r0:not(.sp-main, .sp-sub) { background: CanvasText; }',
    '.band.r1:not(.sp-main, .sp-sub) { background: repeating-linear-gradient(45deg, CanvasText 0 2px, Canvas 2px 4px); }',
    '.band.r2:not(.sp-main, .sp-sub) { background: repeating-linear-gradient(135deg, CanvasText 0 2px, Canvas 2px 4px); }',
    '.band.r4:not(.sp-main, .sp-sub) { background: repeating-linear-gradient(0deg, CanvasText 0 2px, Canvas 2px 4px); }',
    '.band.rother:not(.sp-main, .sp-sub) { background: radial-gradient(CanvasText 1px, Canvas 1.2px);',
    'outline: 1px solid Canvas; outline-offset: -1px;',
    // 1.7 P7b: the ring is kept off a band drawn under 4 px tall, which the script marks `band-thin`.
    '.band:not(.sp-main, .sp-sub, .band-thin) { outline: 1px solid Canvas; outline-offset: -1px; }',
    '.band.band-thin.rother:not(.sp-main, .sp-sub) { background-position: 0 50%; }']) {
    assert.ok(style.includes(rule), 'the forced-colours rule of the bands moved: say it in the docs — ' + rule)
  }
  assert.ok(readDoc('src/webview/main.ts').includes('const BAND_THIN_PX = 4;'), 'the height of a thin band moved: say it in the docs')
  const dash = doc.dashboard.replace(/\s+/g, ' ')
  for (const claim of ['the bands are drawn as patterns in the theme\'s two colours, the text colour and the page colour, whatever the style',
    'the largest model of a provider solid in the text colour, then 45° stripes, 135° stripes, cross-hatch, horizontal lines, and dots for `other`',
    'each band ringed by the page colour so two bands side by side stay two',
    'all but a band drawn under 4 px tall, which the ring would cover whole: it keeps its pattern or its solid fill alone, the dots of `other` in its middle',
    'the provider is told by the legend\'s headings, the band\'s tooltip and the order of the bands in a column']) {
    assert.ok(dash.includes(claim), 'docs/dashboard.md does not say: ' + claim)
  }
})

test('the status bar pages, the settings page and the setting itself name the agents entry as the status bar writes it (1.6 O1)', () => {
  const on = sanitize({ 'tokenPace.statusBar.show': ['agents'] })
  const item = (n: number) => buildItems({
    quotas: [], agg: { sum: () => { throw new Error('unused') }, cost: () => { throw new Error('unused') } },
    cfg: on, now: 0, forecasts: new Map(), role: 'single', scanning: false, consent: 'granted',
    agents: { running: n, now: [], more: 0 },
  })[0]
  const three = item(3).text
  const one = item(1).text
  const many = item(22).text
  assert.deepEqual([three, one, many], ['~3 running', '~1 running', '~22 running'])
  // The entry is listed wherever the entries are, and its two texts are the ones the code writes.
  // (1.8 A5, pinned and changed: the lists end with `cache` now, after `agents`.)
  assert.match(doc.statusBar, /`forecast`, `budget`, `agents`, `cache`\. The array order/)
  assert.ok(doc.statusBar.includes(`\`${three}\`, \`${one}\``), 'docs/status-bar.md does not quote the entry')
  assert.ok(doc.statusBar.split('\n').some((l) => l.startsWith(`| \`${three}\` / \`${one}\` |`)), 'docs/status-bar.md has no row for the entry')
  for (const text of [three, one]) {
    assert.ok(STATES.split('\n').some((l) => l.startsWith(`| \`${text}\` |`)), `docs/status-bar-states.md has no row for ${text}`)
  }
  assert.match(doc.settings, /`forecast`, `budget`, `agents`, `cache`\. Empty hides the bar/)
  assert.match(doc.agents, /`agents` in `tokenPace\.statusBar\.show` — off by default/)
  // Off by default, and the example in its description is the entry's own text, in both languages.
  const setting = properties['tokenPace.statusBar.show'] as { default?: string[]; items?: { enum?: string[]; enumDescriptions?: string[] } }
  assert.equal(setting.default?.includes('agents'), false)
  const at = setting.items?.enum?.indexOf('agents') ?? -1
  assert.ok(at >= 0)
  assert.ok(setting.items?.enumDescriptions?.[at]?.includes(`“${many}”`), setting.items?.enumDescriptions?.[at])
  const bundle = JSON.parse(readDoc('l10n/bundle.l10n.de.json')) as Record<string, string>
  const de = JSON.parse(readDoc('package.nls.de.json')) as Record<string, string>
  assert.ok(de['config.statusBar.show.enum.agents'].includes(`“${bundle['~{0} running'].replace('{0}', '22')}”`),
    de['config.statusBar.show.enum.agents'])
})

test('docs/status-bar.md quotes the settings\' own examples of the bar, word for word — the reset word, the weekday, the period (1.10 B3)', () => {
  // 1.10 B3: the manifest's examples are what the bar prints (T15 holds them in every language); the page quotes the
  // English ones, so a reader who compares the two finds the same text.
  const english = JSON.parse(readDoc('package.nls.json')) as Record<string, string>
  const flat = doc.statusBar.replace(/\s+/g, ' ')
  for (const key of ['config.resetFormat.enum.relative', 'config.resetFormat.enum.absolute', 'config.resetFormat.enum.both',
    'config.density.enum.full', 'config.density.enum.compact', 'config.summary.period.enum.today']) {
    const examples = [...english[key].matchAll(/“([^”]+)”/g)].map((m) => m[1])
    assert.ok(examples.length > 0, key)
    for (const ex of examples) assert.ok(flat.includes(`\`${ex}\``), `docs/status-bar.md does not quote ${key}'s ${ex}`)
  }
  assert.ok(flat.includes('a German bar says `· Reset in 2h14m`, `· Reset um 06:00`'))
})

test('docs/dashboard.md and docs/numbers.md name the subagent share of a window and the agent entries against the buckets, as the views write them', () => {
  // 1.6 N7 (P10b): the words the view model, the markdown and the page write, taken from the sources that write them.
  // 1.10 B2 D6 (pinned and changed: "Agent records, last 7 days", "a record keeps a whole agent"): an agent entry.
  const model = readDoc('src/viewModel.ts')
  const text = readDoc('src/textViews.ts')
  const page = readDoc('src/webview/main.ts')
  for (const [src, written] of [
    [model, 'Subagents {0} of {1} counted here ({2})'],
    [model, 'The two differ by construction: an agent entry keeps a whole agent, a bucket the hour of each reply.'],
    [text, '{0}: subagents {1} of {2} counted here ({3})'],
    [page, 'Agent entries, last 7 days'], [page, 'Subagent tokens in the hour buckets, last 7 days'],
  ] as Array<[string, string]>) assert.ok(src.includes(`'${written}'`), `a source no longer writes: ${written}`)
  const dash = readDoc('docs/dashboard.md').replace(/\s+/g, ' ')
  for (const claim of ['`Subagents 4.7M of 5.5M counted here (86 %)`', '`5 h: subagents 4.7M of 5.5M counted here (86 %)`',
    'a share of **tokens**, never of the quota', 'never moves the window\'s percentage', 'both figures carry `≈`',
    'every Codex window have no such line', '`Current 5 h window` and `Current 7 d window`', '`<1 %` or `>99 %`',
    '`Agent entries, last 7 days`', '`Subagent tokens in the hour buckets, last 7 days`',
    '*the two differ by construction: an agent entry keeps a whole agent, a bucket the hour of each reply*']) {
    assert.ok(dash.includes(claim), `docs/dashboard.md does not say: ${claim}`)
  }
  const numbers = doc.numbers.replace(/\s+/g, ' ')
  for (const claim of ['| Subagent share of a Claude window (`Subagents 4.7M of 5.5M counted here (86 %)`) |',
    'A share of tokens, **never of the quota**', '`≈` on both figures', 'Claude only',
    '| Agent entries against subagent hour buckets (data quality) |', 'an agent entry keeps a whole agent, a bucket the hour of each reply',
    // Review 3: the buckets' figure is marked as the view model marks it (dataQuality.agents.buckets).
    'the buckets\' figure `≈` once those seven days reach below the hour buckets\' roll-up']) {
    assert.ok(numbers.includes(claim), `docs/numbers.md does not say: ${claim}`)
  }
})

test('docs/dashboard.md and docs/numbers.md say a model window\'s share counts that window\'s models, and when no card has the line', () => {
  // 1.6 P10c (the lead's calls on P10b Q1/Q2, Review 3 #1): both figures of a model window by its
  // family; no line anywhere without an agent in the seven days, a measured zero with one.
  const model = readDoc('src/viewModel.ts')
  assert.ok(/function claudeFamily\(/.test(model) && /function windowFamily\(/.test(model), 'the family match moved: say it in the docs')
  const dash = readDoc('docs/dashboard.md').replace(/\s+/g, ' ')
  for (const claim of ['For a model window — `7 d Opus` — both figures count only that window\'s models',
    'the Claude models of its family, whatever their version (`claude-opus-4-6`, `claude-opus-5`, `claude-3-opus` for Opus)',
    'a model window whose family nothing was counted for in its hours has no line',
    'as long as an agent ran anywhere in the last seven days',
    'with no agent record and no subagent hour bucket in those seven days no card has the line at all']) {
    assert.ok(dash.includes(claim), `docs/dashboard.md does not say: ${claim}`)
  }
  const numbers = doc.numbers.replace(/\s+/g, ' ')
  for (const claim of ['for a model window (`7 d Opus`) both figures of that window\'s models only — the Claude models of its family',
    'on no card while the last seven days hold no agent record and no subagent hour bucket']) {
    assert.ok(numbers.includes(claim), `docs/numbers.md does not say: ${claim}`)
  }
})

test('docs/agents.md gives a collector\'s figures in a run\'s order, and a part taken off the line as a screen reader hears it', () => {
  // 1.6 P10c (the lead's calls on Wave C): the collector's second line is usage · tally · duration;
  // a figure the fit took off is read as if it stood on the line (Review 3 #2).
  const flat = doc.agents.replace(/\s+/g, ' ')
  for (const claim of ['`– · 263 started · 250 ✓ · 3 ✕ · ~10 ● · –`', 'a session\'s, a run\'s or a collector\'s span or duration',
    'its usage, its [tally](#the-tally), then its duration, the trailing `–` the first part to give way',
    'read as if they stood on it: `own 32K, agents 166K, 49 min 00 s`']) {
    assert.ok(flat.includes(claim), `docs/agents.md does not say: ${claim}`)
  }
  for (const gone of ['Its second line ends on its [tally]']) {
    assert.equal(flat.includes(gone), false, `docs/agents.md still says: ${gone}`)
  }
})

test('docs/agents.md and docs/dashboard.md name the 7-day block as the page writes it, and say what it does not add up', () => {
  // 1.6 L3 (P10a): the words the page and the markdown write, taken from the sources that write them.
  const page = readDoc('src/webview/main.ts')
  const text = readDoc('src/textViews.ts')
  const build = readDoc('src/agentTreeBuild.ts')
  for (const [src, written] of [
    [page, 'Last 7 days'], [page, 'Last 7 days · where the agent tokens went'], [page, 'Type · model'], [page, 'Median per agent'],
    [page, '~Cost'], [page, 'All agents'], [page, 'No agent of the last 7 days has a counted request.'],
    [page, 'not every agent has a price: the sum is a lower bound'], [text, 'The {0} largest agents'], [build, '{0} other combinations'],
  ] as Array<[string, string]>) assert.ok(src.includes(`'${written}'`), `a source no longer writes: ${written}`)
  const flat = doc.agents.replace(/\s+/g, ' ')
  for (const claim of ['## Last 7 days', '`Last 7 days` ▸', '**Last 7 days · where the agent tokens went**', '*Type · model*', '*Agents*',
    '*Usage*', '*Share*', '*Median per agent*', '*~Cost*', '`tokenPace.showCost`', '(`3 other combinations`)', '*All agents*',
    '*not every agent has a price: the sum is a lower bound*', '`No agent of the last 7 days has a counted request.`',
    '### Last 7 days · where the agent tokens went', '#### The 5 largest agents', 'at its **whole usage**',
    'are not added to each other', 'the rates of its model on the day of its last counted reply',
    'written with more than one model', 'they count against its cap of nodes']) {
    assert.ok(flat.includes(claim), `docs/agents.md does not say: ${claim}`)
  }
  const dash = readDoc('docs/dashboard.md').replace(/\s+/g, ' ')
  for (const claim of ['a `Last 7 days` button', '(agents.md#last-7-days)', 'the 7-day block\'s largest agents', 'the 7-day block\'s disclosure']) {
    assert.ok(dash.includes(claim), `docs/dashboard.md does not say: ${claim}`)
  }
})

test('docs/agents.md names sessions and runs by their start, rows as two lines in time order, and what a screen reader gets', () => {
  // 1.6 N6 (P7, the lead's notes): the names by start time, the short model, the newest first, the
  // two-line row; N9: the words for a screen reader, the 24 px targets, the forced-colours theme.
  const src = readDoc('src/agentTreeBuild.ts')
  for (const written of ['Session {0} · {1}', 'Workflow run {0} · {1}', 'Workflow run {0}']) {
    assert.ok(src.includes(`'${written}'`), `src/agentTreeBuild.ts no longer writes: ${written}`)
  }
  const flat = doc.agents.replace(/\s+/g, ' ')
  for (const claim of ['`Session Tue 14:20 · 9d0eb37a`', '`Session 2026-09-01 14:20 · 9d0eb37a`', '`Session 9d0eb37a`',
    '`Workflow run Tue 00:19 · cfe7718d`', '`Session 9d0eb37a · Workflow run cfe7718d`', 'plain time order, the newest start first',
    '`Explore · opus-5 · 94f3`', '`Explore · claude-opus-5 · 94f3`', '**Each row is two lines.**', 'no figure is ever cut in two',
    '`running, derived`', '`since 14:20`', '24 × 24 px', 'forced-colours theme', 'it runs no clock',
    '`~10 of them running` in the clock\'s place', '`tokenPace.timezone`']) {
    assert.ok(flat.includes(claim), `docs/agents.md does not say: ${claim}`)
  }
  for (const gone of ['Siblings are ordered by when they started', 'A row carries no lower-bound mark', 'The tree\'s rows carry no mark',
    '`Workflow cfe7718d`']) {
    assert.equal(flat.includes(gone), false, `docs/agents.md still says: ${gone}`)
  }
})

// 1.6 P7b (the lead's call on the P7 pictures): what gives way on a row's name and in which order,
// the order of a session's and a run's figures, and a superseded row's glyph at full strength.
test('docs/agents.md says what gives way on a name — the model, the project, the id, never the type or the time — and the order of a run\'s figures', () => {
  const flat = doc.agents.replace(/\s+/g, ' ')
  for (const claim of ['`workflow-subagent · opus-… · f6a7`', '`workflow-subagent · f6a7`', 'so a run never loses the time it is named by',
    '`Wo… 2026-09-03 11:57 · 0…`', 'and still never the time', '`88.2K · 6 started · 2 ✓ · 1 ✕ · 19 min 50 s`',
    'after the usage and before the span or the duration', 'the glyph keeps its full strength', 'its name faded to 65 %']) {
    assert.ok(flat.includes(claim), `docs/agents.md does not say: ${claim}`)
  }
  for (const gone of ['its glyph and its name faded to 65 %', 'then the name\'s first part', 'never the model or the short id',
    'A session\'s and a run\'s tally end the second line']) {
    assert.equal(flat.includes(gone), false, `docs/agents.md still says: ${gone}`)
  }
  // The page's rules the page says them by: the model's least room, the order of the parts.
  const page = readDoc('src/webview/main.ts')
  assert.ok(/const AGENT_MODEL_ROOM_EM = 1\.9;/.test(page), 'the model\'s least room changed: say it in docs/agents.md')
})

// 1.6 L1 (P8): the keyboard of the tree — one stop of the Tab key, the tree pattern's keys — in a
// table the page's own key handling is held to, key by key.
test('docs/agents.md lists the keys of the agent tree, and the page handles exactly those', () => {
  const page = readDoc('src/webview/main.ts')
  const at = page.indexOf('function agentKeyMove(')
  assert.ok(at >= 0, 'the page no longer has agentKeyMove')
  const body = page.slice(at, page.indexOf('\n}\n', at))
  assert.deepEqual([...body.matchAll(/case '([^']+)':/g)].map((m) => m[1]),
    ['ArrowDown', 'ArrowUp', 'Home', 'End', 'ArrowRight', 'ArrowLeft', 'Enter', ' '], 'the tree\'s keys changed: say it in docs/agents.md')
  const flat = doc.agents.replace(/\s+/g, ' ')
  for (const claim of ['### The keyboard', 'one stop of the `Tab` key', '| `↓` / `↑` | the next / the previous item shown |',
    '| `Home` / `End` | the first / the last item shown |', '| `→` | on a closed node, opens it; on an open one, moves to its first child |',
    '| `←` | on an open node, closes it; elsewhere, moves to the node above |', '| `Enter` / `Space` |', '**Moving selects nothing**',
    '*Copy ID* button', 'else on the nearest item above it that is still shown', '`3 of 165`']) {
    assert.ok(flat.includes(claim), `docs/agents.md does not say: ${claim}`)
  }
  for (const gone of ['since the toggle and the row are buttons of their own', 'on the running list\'s row or on the tree\'s, whichever it was on']) {
    assert.equal(flat.includes(gone), false, `docs/agents.md still says: ${gone}`)
  }
  const dash = readDoc('docs/dashboard.md').replace(/\s+/g, ' ')
  assert.ok(dash.includes('one stop of the `Tab` key'), 'docs/dashboard.md does not say the tree is one stop of the Tab key')
  assert.equal(dash.includes('its toggle and its row are buttons of their own'), false, 'docs/dashboard.md still calls the toggle and the row buttons')
})

test('docs/agents.md says why an output is a lower bound as measured, in the words the details use, and no row line points to it', () => {
  // 1.6 D10 (P6): the lower bound's cause, counted on the measuring machine — replacing 1.5's
  // "almost every finished agent", which the count contradicts — and the details' note as the
  // builder writes it. The line under the tree that pointed to the details is gone.
  const src = readDoc('src/agentTreeBuild.ts')
  assert.ok(src.includes("t('⚠ lower bound — {0} of {1} replies unfinished'"), 'the builder no longer writes the reason')
  const flat = doc.agents.replace(/\s+/g, ' ')
  for (const claim of ['`⚠ lower bound — 2 of 41 replies unfinished`', '**293 of 925 agents (32 %)**', '**201 of them exactly one**',
    '**455 of the 477**', 'only **22** were the file\'s last reply', '`silent for 4 min`', '`1 h 05 min`']) {
    assert.ok(flat.includes(claim), `docs/agents.md does not say: ${claim}`)
  }
  for (const gone of ['almost every finished', 'Output figures in the details marked ⚠ are lower bounds.', 'nearly always mid-reply']) {
    assert.equal(flat.includes(gone), false, `docs/agents.md still says: ${gone}`)
  }
  assert.equal(readDoc('docs/counting.md').replace(/\s+/g, ' ').includes('Almost every finished subagent'), false,
    'docs/counting.md still calls almost every finished subagent a lower bound')
})

test('both export dialogs say that tool names are about to leave the machine', () => {
  // The documented rule for the save dialog: it names what is about to be written, because that
  // is the last moment to say no. The tool table is the newest thing in both files — names as
  // the transcript spells them, MCP names included — so neither dialog may stay quiet about it.
  const src = readDoc('src/nativeViews.ts')
  for (const command of ['tokenPace.exportCsv', 'tokenPace.exportJson']) {
    const at = src.indexOf(`registerCommand('${command}'`)
    assert.ok(at >= 0, `src/nativeViews.ts no longer registers ${command}`)
    const block = src.slice(at, src.indexOf('}),', at))
    assert.match(block, /[Tt]ool names/, `the ${command} save dialog does not mention tool names`)
  }
})

test('both export dialogs say that the agents\' ids and types are about to leave the machine (1.6 O2)', () => {
  // The same rule as for the tool names: the agents file and `agents[]` are named before
  // anything is written, the file with its suffix, the array with its name.
  const src = readDoc('src/nativeViews.ts')
  const block = (command: string): string => {
    const at = src.indexOf(`registerCommand('${command}'`)
    assert.ok(at >= 0, `src/nativeViews.ts no longer registers ${command}`)
    return src.slice(at, src.indexOf('}),', at))
  }
  assert.ok(block('tokenPace.exportCsv').includes("t('Agent ids and types go into a third file beside it (.agents.csv).')"),
    'the CSV save dialog does not name the agents file')
  assert.ok(block('tokenPace.exportCsv').includes('AGENTS_FILE_SUFFIX'), 'the CSV export writes no agents file')
  assert.ok(block('tokenPace.exportJson').includes("t('Agents are included as agents[].')"),
    'the JSON save dialog does not name agents[]')
  // docs/export.md quotes both sentences as the dialogs say them.
  const flat = (x: string): string => x.replace(/\s+/g, ' ')
  for (const sentence of ['Agent ids and types go into a third file beside it (.agents.csv).', 'Agents are included as agents[].']) {
    assert.ok(flat(doc.export).includes(sentence), `docs/export.md does not quote "${sentence}"`)
  }
})

test('docs/export.md lists every column of the agents file, the schema version and the note on agents[] (1.6 O2)', () => {
  const flat = (x: string): string => x.replace(/\s+/g, ' ')
  const block = /```\n(agentId,[\s\S]*?)```/.exec(doc.export)
  assert.ok(block, 'docs/export.md has no column block for the agents file')
  assert.deepEqual((block as RegExpExecArray)[1].split(/[\s,]+/).filter(Boolean), [...AGENTS_CSV_COLUMNS])
  assert.ok(doc.export.includes(`\`schema_version\` is \`${EXPORT_SCHEMA_VERSION}\``),
    `docs/export.md does not state schema version ${EXPORT_SCHEMA_VERSION}`)
  assert.ok(flat(doc.export).includes('agents[] holds the agent records whose activity overlaps the exported range\'s days, within '
    + `the agent tables' ${AGENT_RETENTION_DAYS}-day retention; ids, names and counts only — never a path, a description or a prompt`),
  'docs/export.md does not quote the note on agents[]')
  // The pages that used to say the agent tables never reach an export say what does.
  for (const [page, text] of [['agents.md', doc.agents], ['privacy.md', doc.privacy]] as const) {
    assert.equal(/None of it is part of the CSV or JSON export|never in an export/.test(flat(text)), false,
      `docs/${page} still says no agent reaches an export`)
  }
  assert.equal(flat(doc.dashboard).includes('the one part the Quick Pick leaves out'), false,
    'docs/dashboard.md still says the Quick Pick leaves the agents out')
})

test('docs/dashboard.md names the chart\'s split by main session and subagent as the page and the model write it (1.6 O2)', () => {
  // The words, taken from the sources that write them: the chip the page draws, the band labels
  // the chart builds, the tooltip of a split band, the rule a forced-colours theme paints by.
  const page = readDoc('src/webview/main.ts')
  const stats = readDoc('src/stats.ts')
  const style = readDoc('src/dashboard.ts')
  for (const [src, written] of [
    [page, 'subagents'], [page, '{0} · {1} · {2} % of the day · {3} total {4}'],
    [stats, '{0} · main sessions'], [stats, '{0} · subagents'],
  ] as Array<[string, string]>) assert.ok(src.includes(`'${written}'`), `a source no longer writes: ${written}`)
  assert.ok(page.includes('data-act="chartSplit"') && page.includes("type: 'setChartSplit'"), 'the chip moved: say it in the docs')
  assert.ok(style.includes('.band.sp-main { background: CanvasText; }') && style.includes('.band.sp-sub { background: Canvas; outline: 1px solid CanvasText;'),
    'the forced-colours rule of the split moved: say it in the docs')
  const dash = readDoc('docs/dashboard.md').replace(/\s+/g, ' ')
  for (const claim of ['**Main sessions and subagents.**', 'The `subagents` chip beside the metric selector',
    '`Claude Code · main sessions`', '`Claude Code · subagents`', 'whose subagents are its forked threads',
    'sum exactly to its column split by model, day by day and in every metric', 'A part that counted nothing in the range has no band',
    'The legend has no provider headings then', '`Claude Code · subagents · 12,345 · 58.8 % of the day · Claude Code total 21,000`',
    'The choice is kept with the rest of the view state', 'the main sessions are drawn as a solid band in the text colour',
    'the subagents as a band of the page colour ringed by the text colour', 'the chart\'s split (`model` or `agents`)',
    'stacked **by model** unless its `subagents` chip is pressed']) {
    assert.ok(dash.includes(claim), `docs/dashboard.md does not say: ${claim}`)
  }
  assert.equal(dash.includes('always stacked **by model**'), false, 'docs/dashboard.md still says the chart is always by model')
})

test('the tool-table retention the docs promise is the horizon the aggregator applies', () => {
  const days = /TOOL_KEEP_DAYS = (\d+)/.exec(readDoc('src/agg.ts'))
  assert.ok(days, 'src/agg.ts no longer states a TOOL_KEEP_DAYS')
  const cap = (days as RegExpExecArray)[1]
  const flat = (t: string): string => t.replace(/\s+/g, ' ')
  assert.ok(flat(doc.counting).includes(`kept for at most ${cap} days`),
    `docs/counting.md does not state the ${cap}-day tool horizon`)
  // The day buckets outlive the tool rows on the shipped default, so it is user-visible.
  assert.ok(flat(readDoc('CHANGELOG.md')).includes(`at most **${cap} days**`),
    `the CHANGELOG does not state the ${cap}-day tool horizon`)
})

test('docs/counting.md states the snapshot version the code writes and the one it reads forward', () => {
  const src = readDoc('src/types.ts')
  const version = /STATE_VERSION = (\d+)/.exec(src)
  assert.ok(version, 'src/types.ts no longer states a STATE_VERSION')
  assert.ok(doc.counting.includes(`snapshot is schema version ${(version as RegExpExecArray)[1]}`),
    `docs/counting.md does not name schema version ${(version as RegExpExecArray)[1]}`)
  const readable = /READABLE_STATE_VERSIONS[^=]*= \[([^\]]*)\]/.exec(src)
  assert.ok(readable, 'src/types.ts no longer lists the readable versions')
  for (const v of (readable as RegExpExecArray)[1].split(',').map((x) => x.trim()).filter(Boolean)) {
    assert.match(doc.counting, new RegExp(`[Vv]ersion ${v}\\b`), `docs/counting.md does not say version ${v} is still read`)
  }
})

// ---------------------------------------------------------------------------
// The paused state
// ---------------------------------------------------------------------------

test('the documented cause of "CC paused" is the one that can actually produce it', () => {
  const row = STATES.split('\n').find((l) => l.includes('CC paused'))
  assert.ok(row, 'docs/status-bar-states.md no longer documents the paused state')
  // Only src/quota.ts produces this state, from a cache file whose blocked_until is in the future.
  assert.match(row as string, /blocked_until/)
  assert.equal(/pollOnlyWhenFocused/.test(row as string), false, 'the focus gate never produces this state')
  // And docs/quota-sources.md says the same about the cache file.
  assert.match(doc.quotaSources, /`blocked_until` in the future is reported as a paused state/)
})

// ---------------------------------------------------------------------------
// Problem states: one repair action per cause, in the code and in both documents
// ---------------------------------------------------------------------------

/** The `ProblemKind` union, read out of src/types.ts so a new kind cannot be forgotten. */
function problemKinds(): string[] {
  const src = readDoc('src/types.ts')
  const at = src.indexOf('export type ProblemKind =')
  assert.ok(at >= 0, 'src/types.ts no longer declares ProblemKind')
  const decl = src.slice(at, src.indexOf('\n\n', at))
  const kinds = [...decl.matchAll(/'([A-Za-z]+)'/g)].map((m) => m[1])
  assert.ok(kinds.length >= 15, `only ${kinds.length} problem kinds parsed`)
  return kinds
}

/**
 * The repair table is read from the source text rather than called, so the documented
 * mapping is checked against what a reader of `viewModel.ts` sees. The labels go through
 * `t()` since the German build, so the English message is read out of the call.
 */
function problemActionTable(): Record<string, { label: string; command: string }> {
  const src = readDoc('src/viewModel.ts')
  const at = src.indexOf('export function problemActions')
  assert.ok(at >= 0, 'src/viewModel.ts no longer defines problemActions')
  const body = src.slice(at, src.indexOf('\n}', at))
  const out: Record<string, { label: string; command: string }> = {}
  for (const m of body.matchAll(/(\w+):\s*\{\s*label:\s*t\('([^']*)'\)\s*,\s*command:\s*'([^']*)'\s*\}/g)) {
    out[m[1]] = { label: m[2], command: m[3] }
  }
  return out
}

/** The contract of round 1.1: exactly one repair per cause, and this is the mapping. */
const PROBLEM_TABLE: Array<[string, string, string]> = [
  ['noToken', 'Show log', 'tokenPace.showOutput'],
  ['tokenExpired', 'Show log', 'tokenPace.showOutput'],
  ['consentPending', 'Fetch quota now', 'tokenPace.refreshQuota'],
  ['modeCache', 'Open settings', 'tokenPace.openSettings'],
  ['retry', 'Fetch quota now', 'tokenPace.refreshQuota'],
  ['offline', 'Fetch quota now', 'tokenPace.refreshQuota'],
  ['forbidden', 'Show log', 'tokenPace.showOutput'],
  ['unauthorized', 'Show log', 'tokenPace.showOutput'],
  ['noBinary', 'Open settings', 'tokenPace.openSettings'],
  ['quotaOff', 'Open settings', 'tokenPace.openSettings'],
  ['noFile', 'Re-read history', 'tokenPace.rescan'],
  ['empty', 'Re-read history', 'tokenPace.rescan'],
  ['paused', 'Fetch quota now', 'tokenPace.refreshQuota'],
  ['follower', 'Open dashboard', 'tokenPace.showDashboard'],
  ['unknown', 'Show log', 'tokenPace.showOutput'],
]

/**
 * The rows of one markdown table, keyed by the `kind` cell they carry. `to` may be absent —
 * a page whose chapter runs to the end of the file has no following heading to stop at.
 */
function rowsByKind(text: string, from: string, to?: string): Map<string, string> {
  const start = text.indexOf(from)
  assert.ok(start >= 0, `${from} is missing`)
  const end = to === undefined ? -1 : text.indexOf(to, start + from.length)
  const section = end < 0 ? text.slice(start) : text.slice(start, end)
  assert.ok(section.length > 0, `${from} is missing`)
  const out = new Map<string, string>()
  for (const line of section.split('\n')) {
    const m = line.match(/^\|[^|]*\|\s*`([A-Za-z]+)`\s*\|/)
    if (m) out.set(m[1], line)
  }
  return out
}

test('every ProblemKind has exactly one repair action, and the code holds that table', () => {
  const kinds = problemKinds()
  assert.deepEqual(PROBLEM_TABLE.map((r) => r[0]).sort(), [...kinds].sort(),
    'PROBLEM_TABLE and the ProblemKind union have drifted apart')

  const actual = problemActionTable()
  const expected: Record<string, { label: string; command: string }> = {}
  for (const [kind, label, command] of PROBLEM_TABLE) expected[kind] = { label, command }
  assert.deepEqual(actual, expected, 'problemActions() in src/viewModel.ts no longer matches the documented table')
})

test('docs/status-bar-states.md lists the same problem table', () => {
  const rows = rowsByKind(STATES, '## Problem states', '\n## ')
  for (const [kind, label] of PROBLEM_TABLE) {
    const row = rows.get(kind)
    assert.ok(row, `docs/status-bar-states.md has no row for the problem kind ${kind}`)
    assert.ok((row as string).includes(label), `${kind}: the row does not name “${label}”`)
  }
})

test('docs/troubleshooting.md explains every problem state with its bar text and its click', () => {
  const rows = rowsByKind(doc.troubleshooting, '# If the bar says')
  for (const [kind, label] of PROBLEM_TABLE) {
    const row = rows.get(kind)
    assert.ok(row, `docs/troubleshooting.md does not cover the problem kind ${kind}`)
    assert.ok((row as string).includes(label), `${kind}: the row does not name “${label}”`)
  }
})

// ---------------------------------------------------------------------------
// The settings tables against the manifest
// ---------------------------------------------------------------------------

const SETTINGS = doc.settings

test('every contributed setting has a row in the settings tables', () => {
  assert.ok(SETTINGS.length > 0, 'docs/settings.md is empty')
  for (const key of Object.keys(properties)) {
    const short = key.replace(/^tokenPace\./, '')
    assert.ok(SETTINGS.includes(`| \`${short}\` |`), `docs/settings.md has no row for ${key}`)
  }
})

test('the documented section table lists exactly the sections the panel contributes', () => {
  // A section removed from the manifest but left in the table is a promise the build does not
  // keep — and one added without a row is a section nobody can find out about.
  const page = doc.dashboard
  const table = page.slice(page.indexOf('| Section | Contents |'), page.indexOf('\nDefaults omit'))
  assert.ok(table.length > 0, 'docs/dashboard.md has no section table any more')
  const listed = [...table.matchAll(/^\| `([a-zA-Z]+)` \| /gm)].map((m) => m[1])
  const contributed = properties['tokenPace.dashboard.sections'].items?.enum ?? []
  assert.deepEqual([...listed].sort(), [...contributed].sort())
  // And the sentence under it names every section the default leaves out, and only those.
  const omitted = [...page.slice(page.indexOf('\nDefaults omit'), page.indexOf('\nDefaults omit') + 240)
    .matchAll(/`([a-zA-Z]+)`/g)].map((m) => m[1])
  const shipped = properties['tokenPace.dashboard.sections'].default as string[]
  assert.deepEqual([...new Set(omitted)].sort(), contributed.filter((k) => !shipped.includes(k)).sort())
})

test('the settings table shows the section order the manifest ships', () => {
  // A section added to the default is the one change a reader of this row cannot see coming:
  // 1.5 put `agents` after `quota`, and the row went on listing the 1.4 order.
  const shipped = (properties['tokenPace.dashboard.sections'].default as string[]).join(', ')
  assert.ok(SETTINGS.includes(`| \`dashboard.sections\` | \`${shipped}\` |`),
    `docs/settings.md does not show dashboard.sections defaulting to ${shipped}`)
})

test('the dashboard page names every section the filter bar stays below', () => {
  // The chips do not filter these, so the bar sits below them while they lead the list. The
  // sentence lost track once already: `agents` joined the list and the page still named three.
  const m = /const RANGE_FREE = \[([^\]]*)\]/.exec(readDoc('src/webview/main.ts'))
  assert.ok(m, 'src/webview/main.ts no longer lists the sections the filter bar skips')
  const free = [...m[1].matchAll(/'([a-zA-Z]+)'/g)].map((x) => x[1])
  assert.ok(free.length >= 4, `only ${free.length} filter-free sections parsed`)
  const page = doc.dashboard.replace(/\s+/g, ' ')
  const at = page.indexOf('the filter bar sits below every ')
  assert.ok(at >= 0, 'docs/dashboard.md no longer says where the filter bar sits')
  const clause = page.slice(at, page.indexOf(' section that leads the list', at))
  assert.deepEqual([...clause.matchAll(/`([a-zA-Z]+)`/g)].map((x) => x[1]).sort(), [...free].sort())
})

test('the settings tables state the defaults the manifest actually ships', () => {
  const shown: Array<[string, string]> = [
    ['tokenPace.windowSelect', 'worstPace'],
    ['tokenPace.clickAction', 'dashboard'],
    ['tokenPace.tooltipExplanations', 'false'],
    ['tokenPace.density', 'full'],
    ['tokenPace.alerts.thresholds', '[90]'],
    ['tokenPace.chart.modelStyle', 'pattern'],
  ]
  for (const [key, text] of shown) {
    const short = key.replace(/^tokenPace\./, '')
    assert.equal(JSON.stringify(properties[key].default).replace(/"/g, ''), text,
      `${key} does not default to ${text} in package.json`)
    assert.ok(SETTINGS.includes(`| \`${short}\` | \`${text}\` |`),
      `docs/settings.md does not show ${short} defaulting to ${text}`)
  }
})

test('the tolerance band is offered in whole points, which is all the verdict reads', () => {
  const p = properties['tokenPace.pace.tolerancePoints']
  assert.equal(p.type, 'number')
  assert.equal(p.default, 0)
  assert.equal(p.minimum, 0)
  assert.equal(p.maximum, 20)
  // The step the spinner offers, and why the manifest states one: `paceVerdict` rounds the
  // band to whole points before it compares, so that a card printing "3 % ahead of pace"
  // cannot wear two colours. A band typed as 2.5 is therefore not half a point of extra
  // grace — it is exactly 3 — and a spinner that steps in halves would be offering a
  // precision the verdict does not have.
  assert.equal(p.multipleOf, 1)
  const band = (points: number): PaceConfig =>
    readPaceConfig(sanitize({ 'tokenPace.pace.tolerancePoints': points }))
  for (const percent of [33.4, 35.6, 36.4, 36.6, 40, 48, 60]) {
    assert.equal(paceVerdict(percent, 33, band(2.5)).level, paceVerdict(percent, 33, band(3)).level,
      `${percent} %: a band of 2.5 is judged differently from a band of 3`)
  }
  // Not "somewhere between 2 and 3": at 2.6 points ahead — "3 % ahead of pace" on the card —
  // the rounded band of 3 keeps the window green where a band of 2 has already coloured it.
  assert.equal(paceVerdict(35.6, 33, band(2.5)).level, 'ok')
  assert.equal(paceVerdict(35.6, 33, band(2)).level, 'warn')
  // And the row a reader looks the setting up in says so, rather than leaving the decimal open.
  const rows = SETTINGS.split('\n').filter((l) => l.startsWith('| `pace.tolerancePoints` |'))
  assert.equal(rows.length, 1, 'docs/settings.md has no single row for pace.tolerancePoints')
  assert.match(rows[0], /whole/)
  assert.ok(rows[0].includes('0–20'), rows[0])
})

// ---------------------------------------------------------------------------
// The engine floor the secondary sidebar needs
// ---------------------------------------------------------------------------

test('the engine floor and the version the README promises are the same', () => {
  // contributes.viewsContainers.secondarySidebar was proposed API in 1.104 and only became a
  // stable contribution point in 1.106, so anything lower would register no container at all.
  assert.equal(manifest.engines.vscode, '^1.106.0')
  assert.equal(manifest.devDependencies['@types/vscode'], '^1.106.0')
  assert.ok(manifest.contributes.viewsContainers.secondarySidebar, 'the panel no longer lives in the secondary sidebar')
  assert.match(README, /Requires VS Code 1\.106 or newer/)
  // And the store keywords may not promise editors that cannot run it.
  for (const fork of ['cursor', 'windsurf']) {
    assert.equal(manifest.keywords.includes(fork), false, `keywords still advertise ${fork}`)
  }
})

// ---------------------------------------------------------------------------
// The state words, the pictures, and what actually ships
// ---------------------------------------------------------------------------

/**
 * Whether a repository path survives `.vscodeignore` into the `.vsix`.
 *
 * The file excludes `**` and then negates one path at a time, which is exactly the shape a
 * new asset gets forgotten in: it is in git, the docs point at it, and the packaged
 * extension has nothing there. `vsce` keeps a file when the last matching pattern is a
 * negation, so the patterns are walked in order and the last match wins.
 */
function shipped(path: string): boolean {
  const toRegExp = (pattern: string): RegExp => {
    // `**` crosses directories, a single `*` does not; everything else is a literal.
    const out = pattern
      .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
      .replace(/\\?\*\\?\*/g, '\u0000')
      .replace(/\*/g, '[^/]*')
      .replace(/\u0000/g, '.*')
    return new RegExp(`^${out}$`)
  }
  let keep = true
  for (const raw of readDoc('.vscodeignore').split('\n')) {
    const line = raw.trim()
    if (line === '' || line.startsWith('#')) continue
    const negated = line.startsWith('!')
    if (toRegExp(negated ? line.slice(1) : line).test(path)) keep = negated
  }
  return keep
}

test('the two states that survive every switched-off channel are quoted with their words', () => {
  const cfg = sanitize({ 'tokenPace.timezone': 'utc' })
  const q: QuotaState = {
    source: 'claude', ok: true, origin: 'poll', fetchedAt: Math.floor(NOW / 1000), planType: null,
    windows: [
      win({ percent: 100, resetsAt: NOW + 47 * 60_000 }),
      win({ id: 'weekly_all:10080', percent: 100, limitReached: true }),
    ],
  }
  const exhausted = windowValue(viewOf(q, q.windows[0], cfg, NOW), cfg)
  const stopped = windowValue(viewOf(q, q.windows[1], cfg, NOW), cfg)
  assert.equal(exhausted, '100% exhausted')
  assert.equal(stopped, '100% limit reached')
  // Both tables show the bar text; a row that still carries the bare figure is stale.
  for (const [name, page] of [['docs/status-bar.md', doc.statusBar], ['docs/status-bar-states.md', STATES]] as const) {
    for (const [needle, marker] of [[exhausted, 'exhausted (≥ 99.5 %)'], [stopped, 'reports the limit as reached']] as const) {
      const row = page.split('\n').find((l) => l.startsWith('|') && l.includes(marker))
      assert.ok(row, `${name} has no row for “${marker}”`)
      assert.ok((row as string).includes(needle), `${name}: “${marker}” no longer prints “${needle}”`)
    }
  }
})

test('every picture the README embeds exists and is packaged', () => {
  const links = [...README.matchAll(/!\[[^\]]*\]\((media\/[^)\s]+)\)/g)].map((m) => m[1])
  assert.ok(links.length >= 2, 'the README embeds no screenshots any more')
  for (const link of links) {
    // vsce rewrites a relative image to the repository's raw URL, so a missing file is a
    // permanent 404 on the Marketplace page — and nothing in the packaging warns about it.
    assert.ok(existsSync(join(ROOT, link)), `README.md embeds ${link}, which is not in the repository`)
    assert.ok(shipped(link), `${link} is excluded by .vscodeignore`)
  }
})

test('.vscodeignore still keeps the things that must not ship', () => {
  for (const path of ['src/extension.ts', 'test/docs.test.ts', 'dist/extension.js.map', 'media/logo.svg', 'dist/agent-hook.js.map']) {
    assert.equal(shipped(path), false, `${path} would be packaged`)
  }
  // 1.6 O4: the agent hook's script ships, for the setup command to copy.
  for (const path of ['package.json', 'package.nls.json', 'package.nls.de.json', 'README.md',
    'dist/extension.js', 'dist/agent-hook.js', 'media/logo.png', 'docs/status-bar-states.md']) {
    assert.equal(shipped(path), true, `${path} would not be packaged`)
  }
})

test('every page under docs/ is packaged, because the README links all of them', () => {
  // The store overview is the README, and since 1.3 it is almost only links into docs/. A
  // page missing from the .vsix is a dead link in the Extensions view's readme pane, where
  // nothing rewrites a relative path to the repository.
  for (const file of readdirSync(join(ROOT, 'docs')).filter((f) => f.endsWith('.md'))) {
    assert.equal(shipped(`docs/${file}`), true, `docs/${file} would not be packaged`)
  }
})

// ---------------------------------------------------------------------------
// Keybindings and the walkthrough
// ---------------------------------------------------------------------------

test('exactly one keybinding, and the setting that switches it off exists', () => {
  assert.equal(manifest.contributes.keybindings.length, 1)
  const [binding] = manifest.contributes.keybindings
  assert.equal(binding.command, 'tokenPace.showDashboard')
  assert.equal(binding.when, 'config.tokenPace.keybindings')
  assert.equal(properties['tokenPace.keybindings'].type, 'boolean')
  assert.equal(properties['tokenPace.keybindings'].default, true)
  assert.match(doc.commands, /`ctrl\+alt\+shift\+t`/)
  // The removed chord may still be named in prose (it explains why it went); what it may not
  // do any more is stand in a table cell as if it still bound something.
  assert.equal(/\|\s*`ctrl\+alt\+shift\+q`[^|]*\|/.test(DOCS), false,
    'the documentation still lists the removed chord as a binding')
})

test('the walkthrough only names commands that exist and media files that are there', () => {
  const commands = new Set(manifest.contributes.commands.map((c) => c.command))
  const walkthroughs = manifest.contributes.walkthroughs
  assert.equal(walkthroughs.length, 1)
  assert.equal(walkthroughs[0].steps.length, 3)
  for (const step of walkthroughs[0].steps) {
    assert.ok(step.title.length > 0 && step.description.length > 0, `${step.id} is incomplete`)
    const media = join(ROOT, step.media.markdown)
    assert.ok(existsSync(media), `${step.id} points at a missing media file: ${step.media.markdown}`)
    // On disk is not enough: .vscodeignore excludes everything and negates one path at a
    // time, so a step whose media is not negated ships as "Error reading markdown document".
    assert.ok(shipped(step.media.markdown), `${step.media.markdown} is not negated in .vscodeignore`)
    const links = [...step.description.matchAll(/\(command:([\w.]+)\)/g)].map((m) => m[1])
    assert.ok(links.length > 0, `${step.id} has no button`)
    for (const command of links) assert.ok(commands.has(command), `${step.id} links the unknown command ${command}`)
    for (const event of step.completionEvents ?? []) {
      const command = event.startsWith('onCommand:') ? event.slice('onCommand:'.length) : null
      if (command) assert.ok(commands.has(command), `${step.id}: completionEvent names the unknown command ${command}`)
    }
  }
})

test('the quota step quotes the consent dialog, not a paraphrase of it', () => {
  // The walkthrough invites the reader to read the terms before the dialog appears, so it
  // has to be the terms — including the sentence about identifying as the Claude Code
  // client, which src/consent.ts calls the part a user is least able to discover alone.
  const step = readDoc('media/walkthrough/quota.md')
  // 1.12 P5 (pinned and changed): the Claude line depends on the platform (§3 B4) — the step quotes the one
  // Windows shows, word for word, and names what macOS and Linux add.
  for (const line of disclosure(30, 'persistent', 'win32').split('\n')) {
    if (line.trim() === '') continue
    assert.ok(step.includes(line), `media/walkthrough/quota.md no longer says: ${line}`)
  }
  const flatStep = step.replace(/\s+/g, ' ')
  for (const claim of ['on macOS the Keychain item `Claude Code-credentials`, read before the file', 'on Linux the Secret Service through `secret-tool`, after the file']) {
    assert.ok(flatStep.includes(claim), `media/walkthrough/quota.md does not say: ${claim}`)
  }
  // 30 minutes is the default the manifest declares; a different one would misquote it.
  assert.equal(properties['tokenPace.pollIntervalMinutes'].default, 30)
})

test('the menu command is named after what it opens', () => {
  const menu = manifest.contributes.commands.find((c) => c.command === 'tokenPace.menu')
  assert.equal(menu?.title, 'Show Actions Menu')
  assert.equal(/`Token Pace: Menu`/.test(DOCS), false, 'the documentation still uses the old command title')
})

// ---------------------------------------------------------------------------
// Budgets: the sentence that keeps a money budget from reading as a bill
// ---------------------------------------------------------------------------

test('every place a money budget is described says it is not a bill', () => {
  const setting = String(properties['tokenPace.budgets'].markdownDescription)
  assert.match(setting, /hypothetical API equivalent, not a bill/)
  // And the same promise where a reader looks it up rather than hovers it.
  const page = doc.budgetsAlerts
  const section = page.slice(page.indexOf('\n## Budgets'), page.indexOf('\n## ', page.indexOf('\n## Budgets') + 5))
  assert.ok(section.length > 0, 'docs/budgets-alerts.md has no Budgets section')
  assert.match(section, /hypothetical API equivalent, not a bill/)
  // A budget must never be presented as something a provider stated.
  assert.match(section, /limits \*\*you\*\* state/)
  assert.match(section, /lower bound/)
  assert.match(section, /shows a dash/)
})

test('the budget alert is off by default and says what it is judged on', () => {
  assert.equal(properties['tokenPace.alerts.budgetPercent'].default, 0)
  const d = String(properties['tokenPace.alerts.budgetPercent'].markdownDescription)
  assert.match(d, /`0` disables it/)
  assert.match(d, /once per period/)
  // The freshness gate is a different one from the quota alerts', and the description says so.
  assert.match(d, /locally counted usage/)
})

// ---------------------------------------------------------------------------
// The store overview and the pages behind it
// ---------------------------------------------------------------------------

/** Every markdown file whose links have to resolve: the overview, the pages, the walkthrough. */
function linkedFiles(): string[] {
  const out = ['README.md']
  for (const f of readdirSync(join(ROOT, 'docs')).filter((n) => n.endsWith('.md')).sort()) out.push(`docs/${f}`)
  for (const f of readdirSync(join(ROOT, 'media/walkthrough')).filter((n) => n.endsWith('.md')).sort()) {
    out.push(`media/walkthrough/${f}`)
  }
  return out
}

/**
 * GitHub's heading slug, which is what an anchor in a relative link is matched against:
 * lower-cased, code spans and emphasis dropped, everything but letters, digits, spaces,
 * hyphens and underscores removed, spaces turned into hyphens. `## If the bar says …`
 * therefore ends in a hyphen, because dropping the ellipsis leaves its space behind.
 */
function slugs(markdown: string): Set<string> {
  const out = new Set<string>()
  let inFence = false
  for (const line of markdown.split('\n')) {
    if (/^```/.test(line)) { inFence = !inFence; continue }
    if (inFence) continue
    const m = /^#{1,6} (.+)$/.exec(line)
    if (!m) continue
    out.add(m[1]
      .replace(/`/g, '')
      .replace(/\*\*?/g, '')
      .toLowerCase()
      .replace(/[^\p{L}\p{N} _-]/gu, '')
      .replace(/ /g, '-'))
  }
  return out
}

test('every relative link in the README, docs/ and the walkthrough resolves', () => {
  // vsce rewrites a relative link against the repository URL, so a path that is wrong here is
  // a 404 on both store pages — and nothing in the packaging says a word about it.
  const broken: string[] = []
  for (const file of linkedFiles()) {
    const text = readDoc(file)
    for (const m of text.matchAll(/\[[^\]\n]*\]\(([^)\s]+)\)/g)) {
      const target = m[1]
      if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith('//')) continue
      const [path, anchor] = target.split('#') as [string, string | undefined]
      const resolved = path === '' ? file : normalize(join(dirname(file), path))
      if (relative(ROOT, join(ROOT, resolved)).startsWith('..')) {
        broken.push(`${file}: ${target} leaves the repository`)
        continue
      }
      if (!existsSync(join(ROOT, resolved))) {
        broken.push(`${file}: ${target} → ${resolved} does not exist`)
        continue
      }
      if (anchor !== undefined && anchor !== '' && resolved.endsWith('.md')
        && !slugs(readDoc(resolved)).has(anchor)) {
        broken.push(`${file}: ${target} — ${resolved} has no heading with that anchor`)
      }
    }
  }
  assert.deepEqual(broken, [], `\n${broken.join('\n')}`)
})

test('the README index links every page under docs/, and links nothing that is not one', () => {
  const listed = new Set([...README.matchAll(/\]\((docs\/[^)#\s]+)\)/g)].map((m) => m[1].slice('docs/'.length)))
  const present = new Set(readdirSync(join(ROOT, 'docs')).filter((f) => f.endsWith('.md')))
  assert.deepEqual([...listed].sort(), [...present].sort(),
    'the README documentation index and the contents of docs/ have drifted apart')
})

test('the README stays the store overview and does not grow a manual back', () => {
  // 1.3 split a 1337-line README into docs/. The cap is what keeps it from creeping back: a
  // chapter belongs on its own page, where the index can point at it and a reader can find it.
  const lines = README.split('\n').length
  assert.ok(lines <= 200, `README.md is ${lines} lines; the store overview is meant to stay short`)
  for (const needed of ['## What you see', '## Install', '## Privacy', '## Documentation', '## Licence']) {
    assert.ok(README.includes(needed), `README.md no longer has a ${needed} section`)
  }
  // And what it must not carry again: the settings tables live on their own page.
  assert.equal(/\| `windowSelect` \|/.test(README), false, 'the settings table is back in the README')
})

test('every page under docs/ says where it belongs and carries the licence header', () => {
  for (const file of readdirSync(join(ROOT, 'docs')).filter((f) => f.endsWith('.md'))) {
    const text = readDoc(`docs/${file}`)
    assert.match(text, /SPDX-License-Identifier: AGPL-3\.0-or-later/, `docs/${file} has no SPDX header`)
    assert.match(text, /^<!--[\s\S]*?-->\n\n# .+\n/, `docs/${file} does not open with one H1`)
  }
})

test('the release page names the two secrets, keeps the token expiry out of the repository, and says how to verify the publisher', () => {
  for (const needed of ['VSCE_PAT', 'OVSX_PAT', 'deliberately **not** written here', 'pdvfm.de', 'TXT record']) {
    assert.ok(doc.release.includes(needed), `docs/release.md does not mention ${needed}`)
  }
  // The workflow is what the page describes, so the secret names have to be the ones it reads.
  const workflow = readDoc('.github/workflows/release.yml')
  for (const secret of ['VSCE_PAT', 'OVSX_PAT']) {
    assert.ok(workflow.includes(`secrets.${secret}`), `release.yml does not read secrets.${secret}`)
  }
})

test('the tooltip chapter states the prompt-cache row, and only for a connected bridge', () => {
  // The row exists because the status line delivered a reading; without the bridge there is
  // nothing to show of it. 1.8 A5 (pinned and changed: "Without the bridge the row is absent rather
  // than estimated" is gone, spec fact 3): the sessions' rows before it are estimated from the
  // transcript where the bridge does not describe a session, and say so; the 1.3 row stays the bridge's.
  const flat = doc.statusBar.replace(/\s+/g, ' ')
  assert.match(flat, /status-line bridge is connected, one further row states the prompt cache that status line last reported/)
  assert.equal(flat.includes('absent rather than estimated'), false)
  assert.ok(flat.includes('where it does not, they are estimated from the session\'s transcript, carry `~`'))
})

test('the settings page says that a plan name is cleaned before it is printed', () => {
  const row = doc.settings.split('\n').find((l) => l.startsWith('| `planName` |'))
  assert.ok(row, 'docs/settings.md has no planName row')
  assert.match(row as string, /Backticks, control characters and line breaks are stripped/)
  assert.match(row as string, /40-character cut/)
  // What the row promises is what config.sanitize does.
  assert.equal(sanitize({ 'tokenPace.planName': { claude: 'Max`20x\nteam' } }).planName.claude, 'Max20x team')
  assert.equal((sanitize({ 'tokenPace.planName': { claude: 'x'.repeat(80) } }).planName.claude ?? '').length, 40)
})

test('the developer page keeps the command that runs the smoke test in a real window', () => {
  assert.match(doc.development, /npm run test:e2e/)
  assert.match(readDoc('package.json'), /"test:e2e":/)
})

// ---------------------------------------------------------------------------
// 1.6 P15: the documentation of 1.6.0, complete — every limit, sentence and command it relies on
// ---------------------------------------------------------------------------

test('docs/agents.md states the node cap for the markdown report too, what does not count against it, and the measured payload', () => {
  const flat = doc.agents.replace(/\s+/g, ' ')
  for (const claim of [
    // Review 1 #3: MAX_PAGE_NODES applies in text mode as well — the report prints the line for a node that no longer fits.
    `at most **${MAX_PAGE_NODES}** nodes in the whole report, filled in the same order`,
    `at most 50 children each and at most ${MAX_PAGE_NODES} nodes in all`,
    // 1.7 F2 (pinned and changed): the report prints the group of earlier sessions open.
    'every node of the sessions the tree lists — the active ones and, open, the group of earlier ones —',
    // §7c Wave C: the running list's items do not count against the cap, the 7-day block's rows do.
    `The running list's rows are not among the ${MAX_PAGE_NODES} — the list is sent whole, at most ${MAX_RUNNING_LIST} rows.`,
    'its rows — the table\'s and its largest agents\' — are rows of the push too',
    // The harness's 427-agent world, re-measured for 1.6.0 (research/webview-check, agentsbig.host.json).
    'synthetic session of one workflow run of **427** agents', '**1.8 KB** with the tree closed', '**33.8 KB** with the session and the run open',
    '**101.2 KB** with every one of the 164 agents shown',
  ]) assert.ok(flat.includes(claim), `docs/agents.md does not say: ${claim}`)
  for (const gone of ['77.8 KB', 'well under 1 KB', '1.5 called them turns', 'A snapshot written before 1.5']) {
    assert.equal(flat.includes(gone), false, `docs/agents.md still says: ${gone}`)
  }
  assert.ok(readDoc('src/agentTreeBuild.ts').includes('const cap = MAX_PAGE_NODES - (week !== null ? week.rows.length + week.top.length : 0)'),
    'the payload cap is computed otherwise now: say it in docs/agents.md')
})

test('the agent hook\'s pages name the twelve notification types and the wait each one reports', () => {
  const types = Object.keys(NOTIFICATION_WAITS)
  assert.equal(types.length, 12, 'the hook knows another number of notification types: say it on the pages')
  const agents = doc.agents.replace(/\s+/g, ' ')
  for (const type of types) assert.ok(agents.includes(`\`${type}\``), `docs/agents.md does not name the notification type ${type}`)
  assert.ok(agents.includes('twelve types in all'), 'docs/agents.md does not count the notification types')
  const listed = (kind: string): string[] => types.filter((x) => NOTIFICATION_WAITS[x] === kind)
  assert.deepEqual(listed('permission'), ['permission_prompt'])
  assert.ok(agents.includes(`\`input\` for an ${listed('input').map((x) => `\`${x}\``).join(', ').replace(/, ([^,]+)$/, ' or $1')} notification`),
    'docs/agents.md lists other notification types as a wait for input than the script does')
  assert.ok(doc.privacy.replace(/\s+/g, ' ').includes('one of the twelve types Claude Code\'s hooks reference lists; any other drops the call'),
    'docs/privacy.md does not say which notification types the script takes')
})

test('the pages say the hook was verified, the auto mode reports no wait, and how long a mirror line counts', () => {
  const verified = 'with Claude Code 2.1.281 (four probe sessions, key names only)'
  const auto = 'In Claude Code\'s auto mode no permission dialog is shown, so no wait is reported.'
  for (const [page, text] of [['agents', doc.agents], ['privacy', doc.privacy]] as const) {
    const flat = text.replace(/\s+/g, ' ')
    assert.ok(flat.includes(verified), `docs/${page}.md does not say the hook was verified ${verified}`)
    assert.ok(flat.includes(auto), `docs/${page}.md does not say the auto mode reports no wait`)
  }
  const privacy = doc.privacy.replace(/\s+/g, ' ')
  assert.ok(privacy.includes(`a line older than ${HOOK_MAX_AGE_MS / 60_000} minutes no longer counts`), 'docs/privacy.md does not say how long a mirror line counts')
  // Review 4: the mirror is read whenever it exists, not only while the hook is installed; the copy of the script is a write.
  assert.ok(privacy.includes('`agent-hook.jsonl` beside it — whenever that file exists'), 'docs/privacy.md does not say when the mirror is read')
  assert.equal(privacy.includes('only while you have installed the agent hook'), false, 'docs/privacy.md still ties the read to an installed hook')
  assert.ok(privacy.includes('the copy of the agent hook\'s script, `agent-hook.js`, that *Set Up the Agent Hook…* puts there'),
    'docs/privacy.md does not name the copy of the hook script among the writes')
})

test('both pages word the raw-line gates as they work: wherever the key appears, only the closed enum\'s value', () => {
  // Review 4 on §0a.6/§0a.9, the lead's words: the gates match the key wherever it stands unescaped.
  for (const [page, text] of [['agents', doc.agents], ['privacy', doc.privacy]] as const) {
    const flat = text.replace(/\s+/g, ' ')
    assert.ok(/`permissionMode`, matched on the raw line wherever the key appears in a Claude line; only the value of the closed enum is taken/.test(flat),
      `docs/${page}.md does not word the permission mode's gate as it works`)
    assert.ok(/`"is_error":true`[^.]*wherever the key appears in a Claude line/.test(flat), `docs/${page}.md does not word the tool errors' gate as it works`)
    assert.equal(flat.includes('the `permissionMode` a prompt line names'), false, `docs/${page}.md still ties the permission mode to a prompt line`)
  }
  const agg = readDoc('src/agg.ts')
  assert.ok(agg.includes('const mode = permissionModeOf(raw)') && agg.includes('const errors = toolErrorsOf(raw)'), 'the gates moved: say it on the pages')
})

test('the status and journal words both pages list are the ones the aggregator knows', () => {
  const words = ['completed', 'failed', 'error', 'timeout', 'killed', 'cancelled', 'stopped']
  for (const w of words) assert.notEqual(outcomeOfStatus(w), null, `${w} is no end any more`)
  assert.equal(outcomeOfStatus('async_launched'), null)
  const listed = `${words.slice(0, -1).map((w) => `\`${w}\``).join(', ')}, \`stopped\` and \`async_launched\``
  for (const [page, text] of [['agents', doc.agents], ['privacy', doc.privacy]] as const) {
    assert.ok(text.replace(/\s+/g, ' ').includes(listed), `docs/${page}.md does not list the status words: ${listed}`)
  }
  assert.ok(readDoc('src/agg.ts').includes('"type":"(started|result|failed|launched)"'), 'the journal head knows other types now')
  assert.ok(doc.agents.includes('`type` (one of `started`, `result`, `failed` and `launched`; a `launched` line is ignored)'), 'docs/agents.md does not list the journal types')
  assert.ok(doc.privacy.replace(/\s+/g, ' ').includes('the `type` (`started`, `result`, `failed` or `launched`)'), 'docs/privacy.md does not list the journal types')
})

test('docs/privacy.md quotes the scope of the leak tests, and the hook bundle\'s rule', () => {
  const flat = doc.privacy.replace(/\s+/g, ' ')
  for (const claim of ['**Leak tests.**',
    'a synthetic world with prompts, descriptions, results, summaries, scripts, error texts and account ids under every neighbouring key reaches none of the outputs',
    'the snapshot, the view model, the markdown report, the CSV and JSON exports, the log, the diagnostics report, the hook\'s mirror line',
    'fails the build']) {
    assert.ok(flat.includes(claim), `docs/privacy.md does not say: ${claim}`)
  }
  const { HOOK_FORBIDDEN_MODULES } = require('../scripts/check-privacy.mjs') as { HOOK_FORBIDDEN_MODULES: string[] }
  for (const mod of HOOK_FORBIDDEN_MODULES) assert.ok(flat.includes(`\`${mod}\``), `docs/privacy.md does not name the forbidden module ${mod}`)
})

test('every command the Command Palette offers has a row on the commands page', () => {
  const raw = JSON.parse(readDoc('package.json')) as { contributes: { menus?: { commandPalette?: Array<{ command: string; when?: string }> } } }
  const hidden = new Set((raw.contributes.menus?.commandPalette ?? []).filter((m) => m.when === 'false').map((m) => m.command))
  for (const c of manifest.contributes.commands) {
    if (hidden.has(c.command)) continue
    assert.ok(doc.commands.includes(`| \`Token Pace: ${c.title}\` |`), `docs/commands.md has no row for ${c.command} (${c.title})`)
  }
  // The rendered interface follows the display language (since 1.3); the page no longer says it is English everywhere.
  assert.equal(doc.commands.includes('is English everywhere'), false, 'docs/commands.md still says the interface is English everywhere')
})

test('docs/development.md names every bundle the build ships, and what check:privacy checks', () => {
  const outs = [...readDoc('build.mjs').matchAll(/\{ in: '[^']+', out: '(dist\/[^']+)' \}/g)].map((m) => m[1])
  assert.equal(outs.length, 4, `build.mjs ships ${outs.length} bundles`)
  const line = doc.development.split('\n').find((l) => l.startsWith('npm run build ')) ?? ''
  for (const out of outs) assert.ok(line.includes(out), `docs/development.md's build line does not name ${out}`)
  const privacy = doc.development.split('\n').find((l) => l.startsWith('npm run check:privacy')) ?? ''
  assert.ok(privacy.includes('the read contract') && privacy.includes('fs/path-only rule'), privacy)
})

test('docs/agents.md quotes durations as durationText writes them, rounded to the unit before the split', () => {
  const examples: Array<[number, string]> = [[999.4, '999 ms'], [59_949, '59.9 s'], [59_950, '1 min 00 s'], [3_599_499, '59 min 59 s'], [3_599_500, '1 h 00 min']]
  for (const [ms, text] of examples) assert.equal(durationText(ms), text)
  assert.notEqual(durationText(1_199_600), '19 min 60 s')
  const flat = doc.agents.replace(/\s+/g, ' ')
  assert.ok(flat.includes(`— ${examples.map(([, x]) => `\`${x}\``).join(', ')} —, so it never reads \`19 min 60 s\``),
    'docs/agents.md does not quote the durations as durationText writes them')
})

/**
 * 1.11 P5 (§3 C4 rule 4): the export's schema version 1.6.0 … 1.10.0 shipped, where 1.11 moved on to 4 — the release
 * notes of those versions say `3`, which is history now, pinned as a released constant (the pattern of RELEASED_1_7);
 * defined before its first use.
 */
const RELEASED_1_10 = { EXPORT_SCHEMA_VERSION: 3 } as const

/**
 * 1.11 P5 (§3 C5 rule 3): a day of the price table as docs/cost.md writes it — `2026-09-06` → "6 September 2026" —, the
 * one formatter the docs tests hold the page's dates to, so that the page is held to the constants, never to a literal.
 */
const longDay = (iso: string): string =>
  new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${iso}T00:00:00Z`))

test('the snapshot version and the agent tables\' revision are stated on the pages and in the release notes', () => {
  assert.ok(doc.agents.replace(/\s+/g, ' ').includes(`which revision of the agent tables it holds — revision **${AGENT_TABLES_REVISION}** in`),
    'docs/agents.md does not state the agent tables\' revision')
  assert.ok(doc.counting.replace(/\s+/g, ' ').includes(`the revision of the agent tables it holds — ${AGENT_TABLES_REVISION} in`),
    'docs/counting.md does not state the agent tables\' revision')
  const log = readDoc('CHANGELOG.md')
  // 1.7 P11 (pinned and changed: "the newest CHANGELOG entry is 1.6.0"): 1.7.0 stands above it now,
  // so the 1.6.0 entry is found by its heading; the 1.7.0 entry has a test of its own below.
  const first = log.indexOf('\n## 1.6.0 ')
  assert.ok(first >= 0, 'the CHANGELOG has no 1.6.0 entry')
  const second = log.indexOf('\n## ', first + 4)
  const entry = log.slice(first, second)
  assert.match(entry, /^\n## 1\.6\.0 — \d{4}-\d{2}-\d{2}\n/, 'the 1.6.0 heading lost its date')
  const flat = entry.replace(/\s+/g, ' ')
  // 1.8 P5 (pinned and changed): the 1.6.0 entry names the revision 1.6.0 wrote — 8 —, which is history
  // now that the code's is 9. 1.11 P5 (pinned and changed, §3 C4 rule 4): the schema version 1.6.0 wrote — 3 —
  // likewise, now that the code's is 4.
  for (const claim of ['1.5.0 and 1.5.1 were committed but never published; their changes ship here.',
    `(\`STATE_VERSION\` ${STATE_VERSION})`, '(`AGENT_TABLES_REVISION` 8)',
    'the first start after the upgrade replays the agent tables once', `\`agents[]\` (\`schema_version\` ${RELEASED_1_10.EXPORT_SCHEMA_VERSION})`,
    '### Added', '### Changed', '### Fixed', '### Privacy']) {
    assert.ok(flat.includes(claim), `the 1.6.0 entry does not say: ${claim}`)
  }
  for (const heading of ['## 1.5.0', '## 1.5.1']) assert.equal(log.includes(`\n${heading} `), false, `the CHANGELOG still has the heading ${heading}`)
  // A store page: no path of the machine it was built on, no internal file, no secret.
  for (const never of [/\/home\//, /plan-1\.\d/, /\.claude\/projects/, /VSCE_PAT|OVSX_PAT/, /research\//]) {
    assert.equal(never.test(entry), false, `the 1.6.0 entry mentions ${never}`)
  }
})

test('the README names the agents\' features, and what check:privacy holds a build to', () => {
  const flat = README.replace(/\s+/g, ' ')
  for (const claim of ['**Your Claude Code agents as a tree**', '**Where the agent tokens went**', '`agents` in `statusBar.show` shows `~3 running`',
    '**agent hook**', 'split every day by main session and subagent', 'The tree is a tree to the keyboard and a screen reader too',
    'the agents included in all of them', 'read contract', 'Node\'s `fs` and `path`', '(docs/agents.md#the-agent-hook)']) {
    assert.ok(flat.includes(claim), `README.md does not say: ${claim}`)
  }
  assert.equal(flat.includes('reads an agent\'s type, model, ids and outcome — never'), false, 'README.md still lists 1.5\'s fields only')
  // The picture of the dashboard shows the Agents section, and its caption says so.
  assert.match(README, /!\[The Token Pace dashboard in the secondary sidebar:[^\]]*the Agents section[^\]]*\]\(media\/screenshot-dashboard\.png\)/)
})

test('the walkthrough\'s pages name the Agents section, the chart split and the tolerance the manifest ships', () => {
  const panel = readDoc('media/walkthrough/dashboard.md')
  assert.ok(panel.split('\n').some((l) => l.startsWith('| agents |')), 'media/walkthrough/dashboard.md has no agents row')
  assert.ok(panel.includes('with the `subagents` chip, by main session and subagent'), 'media/walkthrough/dashboard.md does not name the chart split')
  const bar = readDoc('media/walkthrough/status-bar.md')
  assert.ok(bar.includes(`(\`pace.tolerancePoints\`, ${String(properties['tokenPace.pace.tolerancePoints'].default)} by default)`),
    'media/walkthrough/status-bar.md states another tolerance default than the manifest ships')
  assert.ok(bar.includes('`~3 running`'), 'media/walkthrough/status-bar.md does not name the agents entry')
})

test('the German manifest says Token and Tool-Aufrufe, as the interface does', () => {
  const de = JSON.parse(readDoc('package.nls.de.json')) as Record<string, string>
  for (const [key, value] of Object.entries(de)) {
    assert.equal(/\bTokens\b/.test(value), false, `package.nls.de.json:${key} says „Tokens"; the interface says „Token"`)
    assert.equal(/Werkzeugaufruf|Werkzeugargument|Werkzeugergebnis/.test(value), false, `package.nls.de.json:${key} still says „Werkzeug…" for a tool call`)
  }
  assert.ok(de['config.dashboard.sections.enum.tools'].startsWith('Tool-Aufrufe'), de['config.dashboard.sections.enum.tools'])
  assert.ok(de['config.dashboard.sections.enum.agents'].includes('Detailbereich') && de['config.dashboard.sections.enum.chart'].includes('Subagenten'),
    'the German section descriptions lost the words the interface uses')
})

test('the troubleshooting, sessions, counting and numbers pages carry what 1.6 changed', () => {
  const trouble = doc.troubleshooting.replace(/\s+/g, ' ')
  assert.ok(trouble.includes('## The agent hook') && trouble.includes('**Node.js on the PATH**'), 'docs/troubleshooting.md has no agent hook section')
  for (const event of HOOK_EVENTS) assert.ok(trouble.includes(`\`${event}\``), `docs/troubleshooting.md does not name ${event}`)
  assert.ok(trouble.includes('`tokenPace.quotaSource` stays on `auto`'), 'docs/troubleshooting.md does not say what a late Allow leaves')
  const sessions = doc.sessions.replace(/\s+/g, ' ')
  for (const claim of ['the effort of its replies', 'its last rejected request', 'the seven fields of Claude Code\'s run record', '`Session Tue 14:20 · 9d0eb37a`']) {
    assert.ok(sessions.includes(claim), `docs/sessions.md does not say: ${claim}`)
  }
  const counting = doc.counting.replace(/\s+/g, ' ')
  assert.ok(counting.includes('`<session>/workflows/wf_<id>.json`, is no transcript either: it is never counted'), 'docs/counting.md does not name the run record')
  assert.ok(counting.includes('a journal line or a run record only ever sets a state'), 'docs/counting.md does not say the run record only sets a state')
  const numbers = doc.numbers.replace(/\s+/g, ' ')
  assert.equal(numbers.includes('the tree rows carry no mark'), false, 'docs/numbers.md still says the rows carry no ⚠')
  for (const row of ['| A workflow run\'s end |', '| Claude Code\'s run record of a workflow run', '| Why an agent ended on a rejected request']) {
    assert.ok(numbers.includes(row), `docs/numbers.md has no row: ${row}`)
  }
})

test('the user agent\'s version: its three sources, the Windows lookup and the log line, where a reader looks (1.7 W3, §0a.1, §0a.2)', () => {
  const { CLAUDE_VERSION_FALLBACK } = require('../src/poller') as typeof import('../src/poller')
  // §0a.1: the privacy page's sentence, as the spec words it.
  const privacy = doc.privacy.replace(/\s+/g, ' ')
  for (const claim of [
    'The version in the `User-Agent` header is the one `claude --version` prints; where that gives none — on Windows with only the npm `claude.cmd` on the PATH — it is the version the newest Claude Code session on this machine wrote into its transcript (`version`, three numbers), and where neither is known a fixed version.',
    'never from an agent\'s, and nothing else of any transcript reaches a request',
    'with `tokenPace.userAgent: honest` no Claude Code version is sent at all',
    // §0a.2: existence only, no shell, no script.
    'only from a `claude.exe` found in a directory of the `PATH`', 'nothing is read from it', 'without a shell',
    'the npm shim `claude.cmd`, a `.bat` and a `.ps1` are never started',
  ]) {
    assert.ok(privacy.includes(claim), `docs/privacy.md does not say: ${claim}`)
  }
  // The quota sources page: the order, the Windows rule and the three log forms.
  const quota = doc.quotaSources.replace(/\s+/g, ' ')
  for (const claim of [
    'The version comes from three sources, in this order', 'what `claude --version` prints, asked once per session',
    'the version the newest Claude Code session on this machine wrote into its transcript', 'an agent\'s transcript is not asked',
    'asked again at every fetch', 'where neither is known, a fixed version',
    'each absolute directory among its first 64 entries is checked for that one file\'s existence — nothing is read from it — and the file is started by its full path, without a shell',
    'The npm shim `claude.cmd`, a `.bat` and a `.ps1` are never started',
    '`claude: user agent version 2.1.281 (from claude --version)`', '`(from the newest transcript)`', '`(fallback)`',
    '`honest` sends `token-pace/<version>` instead, and none of the above',
  ]) {
    assert.ok(quota.includes(claim), `docs/quota-sources.md does not say: ${claim}`)
  }
  assert.equal(quota.includes('(a constant if that fails)'), false, 'docs/quota-sources.md still names the CLI as the only source')
  assert.match(CLAUDE_VERSION_FALLBACK, /^\d{1,3}\.\d{1,3}\.\d{1,4}$/)
  // The Windows page: one paragraph, the shim never started, the log line.
  const windows = doc.windows.replace(/\s+/g, ' ')
  for (const claim of ['**The Claude Code version on Windows.**', 'only from a `claude.exe` it finds in a directory of the `PATH`',
    'that shim is never started', 'the version then comes from the newest Claude Code session\'s transcript',
    '`claude: user agent version 2.1.281 (from the newest transcript)`']) {
    assert.ok(windows.includes(claim), `docs/windows-wsl-remote.md does not say: ${claim}`)
  }
})

// ---------------------------------------------------------------------------
// 1.7 P11: what 1.7.0 shipped, where a reader looks for it
// ---------------------------------------------------------------------------

/** The German runtime bundle, for the words the German page and the German manifest share. */
const GERMAN = JSON.parse(readDoc('l10n/bundle.l10n.de.json')) as Record<string, string>
const flatText = (text: string): string => text.replace(/\s+/g, ' ')
const nlsEn = JSON.parse(readDoc('package.nls.json')) as Record<string, string>
const nlsDe = JSON.parse(readDoc('package.nls.de.json')) as Record<string, string>

test('the provider switch is named where a reader looks: its three buttons, „Alle", and what it does not reach (1.7 F1)', () => {
  // The buttons are the registry's titles in its order, then All — the page's words, not the docs'.
  const titles = SOURCES.map((s) => SOURCE_TITLE[s])
  assert.deepEqual(titles, ['Claude Code', 'Codex'], 'the registry changed: name the new buttons on the pages')
  assert.ok(readDoc('src/dashboard.ts').includes("'All': t('All'),"), 'the page no longer carries the All button\'s word')
  assert.equal(GERMAN['All'], 'Alle')
  assert.equal(GERMAN['Providers'], 'Anbieter')
  const dash = flatText(doc.dashboard)
  assert.ok(dash.includes(`${titles.map((t) => `\`${t}\``).join(', ')}, \`All\` (German \`${GERMAN['All']}\`)`),
    'docs/dashboard.md does not name the switch\'s buttons as the page writes them')
  assert.ok(flatText(README).includes(`\`${titles.join(' · ')} · All\``), 'README.md does not name the switch')
  assert.ok(readDoc('media/walkthrough/dashboard.md').includes(`${titles.map((t) => `\`${t}\``).join(', ')}, \`All\``),
    'the walkthrough does not name the switch')
  assert.ok(nlsEn['walkthrough.getStarted.openDashboard.description'].includes(`${titles.join(' · ')} · All`), 'the walkthrough step does not name the switch')
  assert.ok(nlsDe['walkthrough.getStarted.openDashboard.description'].includes(`${titles.join(' · ')} · ${GERMAN['All']}`)
    && nlsDe['walkthrough.getStarted.openDashboard.description'].includes('Anbieterschalter'), 'the German walkthrough step does not name the switch (§6: Anbieterschalter)')
  // Under Codex the two Claude-only sections are left out — the manifest says so of both.
  assert.ok(nlsEn['config.dashboard.sections.enum.agents'].includes('left out while the provider switch shows Codex'))
  assert.ok(nlsEn['config.dashboard.sections.enum.context'].includes('left out while the provider switch shows Codex'))
  for (const key of ['config.dashboard.sections.enum.agents', 'config.dashboard.sections.enum.context']) {
    assert.ok(nlsDe[key].includes('ausgeblendet, solange der Anbieterschalter Codex zeigt'), `${key} does not say it in German`)
  }
  // The text views follow it — and say which provider they show, in the words the code writes.
  assert.ok(readDoc('src/textViews.ts').includes("t('{0} only', shown)"), 'the markdown range line no longer names the provider')
  const commands = flatText(doc.commands)
  for (const row of ['Show Usage (Quick Pick)', 'Show Usage as Text', 'Copy Usage Summary']) {
    const line = doc.commands.split('\n').find((l) => l.startsWith(`| \`Token Pace: ${row}\``))
    assert.ok(line && line.includes('following the dashboard\'s provider switch'), `docs/commands.md: ${row} does not say it follows the switch`)
  }
  assert.ok(commands.includes('every provider, whatever the switch shows'), 'docs/commands.md does not say the exports follow no switch')
  assert.ok(flatText(doc.agents).includes('While the switch shows Codex, neither of the two prints an Agents part'), 'docs/agents.md does not say the text views leave the Agents part out')
  assert.ok(flatText(doc.export).includes('The CSV and JSON exports and *Copy Diagnostics* follow neither the switch nor the chips'))
  // What it does not reach: the bar, the budget item, the agents entry, the alerts — where a reader looks.
  const bar = flatText(doc.statusBar)
  assert.ok(bar.includes('**The dashboard\'s provider switch does not reach the bar.**')
    // 1.8 A5 (pinned and changed: the `cache` entry joined the list).
    && bar.includes('the entries, their tooltips, the `budget` entry (every budget), the `agents` entry, the `cache` entry and the alerts stay as the settings above make them'),
    'docs/status-bar.md does not say the switch governs nothing on the bar')
  assert.ok(flatText(doc.budgetsAlerts).includes('the switch hides a row, it never moves a figure')
    && flatText(doc.budgetsAlerts).includes('the status bar\'s `budget` entry and the budget alerts keep every budget, whatever the switch shows'),
    'docs/budgets-alerts.md does not say what the switch does to the budgets')
  assert.ok(flatText(readDoc('media/walkthrough/status-bar.md')).includes('The dashboard\'s provider switch changes nothing on the bar.'), 'the status-bar walkthrough does not say it')
  // The host reads every budget for the bar and the alerts, which is what the pages promise.
  assert.equal((readDoc('src/extension.ts').match(/latestVm\?\.allBudgets \?\? \[\]/g) ?? []).length, 2, 'the bar or the alerts read another budget list')
})

test('the group of earlier sessions is named where a reader looks, with its words, its cap and its keys (1.7 F2)', () => {
  assert.ok(readDoc('src/agentTreeBuild.ts').includes("t('Earlier sessions ({0})'"), 'the group is no longer named so')
  assert.equal(GERMAN['Earlier sessions ({0})'], 'Frühere Sitzungen ({0})')
  assert.ok(flatText(README).includes('one closed row, `Earlier sessions (12)`'), 'README.md does not name the group')
  assert.ok(readDoc('media/walkthrough/dashboard.md').includes('in one closed row, `Earlier sessions (12)`'), 'the walkthrough does not name the group')
  assert.ok(nlsEn['walkthrough.getStarted.openDashboard.description'].includes('“Earlier sessions (12)”'), 'the walkthrough step does not name the group')
  assert.ok(nlsDe['walkthrough.getStarted.openDashboard.description'].includes('„Frühere Sitzungen (12)“'), 'the German walkthrough step does not name the group (§6)')
  const agents = flatText(doc.agents)
  for (const claim of [
    // The keyboard: Enter and Space toggle the group, and Tab's and a push's fallback is the first item.
    '| `Enter` / `Space` | opens the node\'s details under its row, or closes them again; on a `50 more` line, shows the next fifty; on the group of earlier sessions, which has no details, opens or closes the group |',
    'else the first item: the first active session, or the group of earlier sessions when no session is active — and the',
    '—, else on the first item: the first active session, or the group of earlier sessions when no session is active.',
    'The one row without details is the group of earlier sessions: the same click or key opens or closes the group.',
    'the group of earlier sessions, which cannot be selected, says nothing of that',
    // The Quick Pick counts what the tree lists: the active roots and the group's — both capped.
    `at most ${MAX_ROOTS} active ones and ${MAX_ROOTS} earlier ones`,
  ]) assert.ok(agents.includes(claim), `docs/agents.md does not say: ${claim}`)
  const dash = flatText(doc.dashboard)
  for (const claim of [
    'all but the row of earlier sessions, a container with no state and no figures of its own',
    'a click on the row of earlier sessions opens or closes that row instead, since it has no details',
    'the group of earlier sessions, which has no state, no figures and no details, is named by its words and its tally alone and carries no `aria-selected`',
    'the earlier sessions\' too, whose group is closed on the page',
    '`… · the 23 most recent sessions of the last 7 days`',
    'the group of earlier sessions a list item without a state or a figure and its sessions one level in',
  ]) assert.ok(dash.includes(claim), `docs/dashboard.md does not say: ${claim}`)
  // The page's keys do what the pages say: the group's row toggles, and Enter/Space act on the row.
  const page = readDoc('src/webview/main.ts')
  assert.ok(page.includes("data-act=\"' + (group ? 'agentToggle' : 'agentSelect')"), 'the group\'s row no longer toggles it')
  assert.ok(page.includes("(group ? '' : ' aria-selected=\"' + on + '\"')"), 'the group carries aria-selected again')
})

test('the state colours are named where a reader looks, as the stylesheet\'s four tokens mix them (1.7 F4)', () => {
  const css = readDoc('src/dashboard.ts')
  // The four hues the pages name are the four the stylesheet mixes, each from the token of its state.
  const sources: Record<string, string> = {
    done: 'var(--ok)',
    unknown: 'var(--vscode-list-warningForeground, var(--warn))',
    failed: 'var(--vscode-list-errorForeground, var(--error))',
    running: 'var(--claude)',
  }
  for (const [state, from] of Object.entries(sources)) {
    assert.ok(css.includes(`--ag-c-${state}: color-mix(in srgb, ${from} 60%, var(--vscode-foreground));`), `--ag-c-${state} is no longer mixed from ${from}`)
  }
  for (const [token, hue] of [['--ok', 'green'], ['--warn', 'yellow'], ['--error', 'red'], ['--claude', 'blue']]) {
    assert.ok(css.includes(`${token}: var(--vscode-charts-${hue});`), `${token} is no longer the theme's ${hue}`)
  }
  const words = 'green done, yellow unknown, red failed, blue running'
  for (const [name, text] of [['README.md', README], ['docs/agents.md', doc.agents], ['docs/dashboard.md', doc.dashboard],
    ['docs/numbers.md', doc.numbers], ['media/walkthrough/dashboard.md', readDoc('media/walkthrough/dashboard.md')]] as const) {
    assert.ok(flatText(text).includes(words), `${name} does not name the four state colours`)
  }
  assert.ok(flatText(README).includes('never as the only sign, and guide lines connect every child to its parent'), 'README.md does not say the colour is never alone, nor name the guide lines')
  // Review 3 #2 (accepted): the hues are the theme's own and may lie close on a theme.
  assert.ok(flatText(doc.agents).includes('The four hues are the theme\'s own, so on some themes two of them lie close together'),
    'docs/agents.md does not say the hues may lie close together')
})

test('a band of the chart under BAND_THIN_PX keeps its pattern without the ring, where the pages say it (1.7 P7b)', () => {
  const m = /const BAND_THIN_PX = (\d+);/.exec(readDoc('src/webview/main.ts'))
  assert.ok(m, 'src/webview/main.ts no longer states the height of a thin band')
  const px = Number(m[1])
  assert.ok(flatText(doc.dashboard).includes(`all but a band drawn under ${px} px tall, which the ring would cover whole`), 'docs/dashboard.md states another height')
  assert.ok(flatText(readDoc('CHANGELOG.md')).includes(`a band drawn under ${px} px tall keeps its pattern without the ring`), 'the 1.7.0 notes state another height')
})

test('a transient failure of our own fetch: the sentence the views print, the kinds the pages call transient, the attempt words (1.7 W1, W2, P4b)', () => {
  // The kinds FAILURE_TRANSIENT calls transient are the ones the pages list — any change is a docs change.
  const transient = Object.entries(FAILURE_TRANSIENT).filter(([, v]) => v).map(([k]) => k).sort()
  assert.deepEqual(transient, ['offline', 'retry', 'unknown'], 'the transient kinds changed: say which on docs/quota-sources.md')
  const quota = flatText(doc.quotaSources)
  assert.ok(quota.includes('Transient means the cause passes by itself and another attempt is scheduled after a backoff: a `429` or a server error, a network error (timeout, DNS, TLS, proxy), an unclassified status or error.'),
    'docs/quota-sources.md does not say which failures are transient')
  assert.ok(quota.includes('A permanent cause — missing, expired or rejected credentials, a refused endpoint (`403`), no `codex` executable, an answer without windows — is not said beside a reading'))
  // The sentence as lastFailureText writes it, word for word on every page that quotes it.
  const tcfg: TimeConfig = { zone: 'utc', dayBoundaryHour: 0, startOfWeek: 'monday', hourCycle: 'h23' }
  const now = Date.UTC(2026, 8, 24, 14, 40)
  assert.ok(readDoc('src/poller.ts').includes("'HTTP {0} — backing off before the next attempt'"), 'the poller words a 429 otherwise')
  const q: QuotaState = {
    source: 'claude', ok: true, origin: 'poll', fetchedAt: Math.floor((now - 2 * HOUR) / 1000), planType: null, windows: [],
    lastFailure: { at: Date.UTC(2026, 8, 24, 14, 20), problem: 'HTTP 429 — backing off before the next attempt', kind: 'retry' },
    nextAttemptAt: now + 72 * 60_000, attemptHeld: null,
  }
  const sentence = lastFailureText(q, now, tcfg)
  assert.equal(sentence, 'Last attempt at 14:20 failed: HTTP 429 — backing off before the next attempt · next attempt in 1h12m')
  for (const [name, text] of [['docs/quota-sources.md', doc.quotaSources], ['docs/status-bar.md', doc.statusBar], ['docs/status-bar-states.md', STATES],
    ['docs/troubleshooting.md', doc.troubleshooting], ['docs/dashboard.md', doc.dashboard], ['docs/export.md', doc.export],
    ['CHANGELOG.md', readDoc('CHANGELOG.md')]] as const) {
    assert.ok(flatText(text).includes(sentence as string), `${name} does not quote the sentence as the views print it`)
  }
  assert.equal(lastFailureText({ ...q, lastFailure: { ...q.lastFailure!, kind: 'noToken' } }, now, tcfg), null, 'a permanent cause is said beside a reading')
  // The attempt's words: the countdown, due, held for focus — never a reset's "reset due".
  assert.equal(retryWords({ kind: 'in', text: '1h12m' }), 'retry 1h12m')
  assert.equal(retryWords({ kind: 'due' }), 'retry due')
  assert.equal(retryWords({ kind: 'focus' }), 'retry waiting for focus')
  assert.equal(nextAttemptWords({ kind: 'focus' }), 'next attempt waiting for focus')
  assert.equal(refreshWords({ kind: 'focus' }), 'waiting for focus')
  assert.ok(flatText(doc.dashboard).includes('`next attempt due` once that time has passed, `next attempt waiting for focus` while a background window holds it back; a permanent cause adds no line'),
    'docs/dashboard.md\'s quota row does not name the card\'s failure line')
  assert.ok(flatText(doc.troubleshooting).includes('as the detail line under the provider\'s item in the Quick Pick'), 'docs/troubleshooting.md does not say where the Quick Pick puts it')
  assert.ok(flatText(doc.quotaSources).includes('backs off for up to two hours and no new figure arrives'), 'docs/quota-sources.md still says nothing new is shown')
  assert.equal(flatText(doc.quotaSources).includes('shows nothing new'), false, 'docs/quota-sources.md still says nothing new is shown')
  assert.ok(readDoc('media/walkthrough/status-bar.md').includes('`CC 5h ██┃▁▁▁▁▁ 25% · resets 2h14m $(history) 2h · $(clock) retry 1h12m`'), 'the status-bar walkthrough does not show the suffix')
  // The manifest in both languages, in the words each build shows.
  const focus = refreshWords({ kind: 'focus' })
  assert.ok(nlsEn['config.pollOnlyWhenFocused.description'].includes(`“${focus}”`), 'pollOnlyWhenFocused does not quote the attempt\'s words')
  assert.ok(nlsDe['config.pollOnlyWhenFocused.description'].includes(`„${GERMAN[focus]}“`), 'the German pollOnlyWhenFocused does not quote the German words')
  assert.ok(nlsEn['config.staleAfterMinutes.description'].includes(`(“${retryWords({ kind: 'in', text: '1h12m' })}”)`), 'staleAfterMinutes does not name the suffix')
  assert.ok(nlsDe['config.staleAfterMinutes.description'].includes(`(„${GERMAN['retry {0}'].replace('{0}', '1h12m')}“)`), 'the German staleAfterMinutes does not name the suffix')
})

test('the user agent\'s manifest words, the privacy page\'s conditions and quota.json\'s last failed attempt (1.7 §0a.1–0a.3)', () => {
  const en = nlsEn['config.userAgent.description']
  const de = nlsDe['config.userAgent.description']
  for (const claim of ['what `claude --version` prints', 'on Windows only from a `claude.exe` on the PATH, never the npm shim `claude.cmd`',
    'else the version the newest Claude Code session wrote into its transcript, else a fixed version', 'no new figure arrives']) {
    assert.ok(en.includes(claim), `config.userAgent.description does not say: ${claim}`)
  }
  for (const claim of ['was `claude --version` ausgibt', 'nie über das npm-Startskript `claude.cmd`', 'die neueste Claude-Code-Sitzung in ihr Transkript geschrieben hat', 'es kommt keine neue Zahl']) {
    assert.ok(de.includes(claim), `config.userAgent.description (German) does not say: ${claim}`)
  }
  for (const stale of ['a constant if it cannot be detected', 'shows nothing new', 'eine Konstante', 'zeigt nichts Neues']) {
    assert.equal(en.includes(stale) || de.includes(stale), false, `config.userAgent.description still says: ${stale}`)
  }
  assert.ok(nlsEn['config.userAgent.enum.claudeCode'].startsWith('claude-code/<the Claude Code version: from the CLI, else the newest transcript, else fixed>'))
  assert.ok(nlsDe['config.userAgent.enum.claudeCode'].startsWith('claude-code/<die Claude-Code-Version: von der CLI, sonst aus dem neuesten Transkript, sonst fest>'))
  // §0a.1: the privacy page names the conditions, and claims no new field.
  const privacy = flatText(doc.privacy)
  for (const claim of ['The header goes only with the one consent-gated fetch — in `quotaSource: poll`, after you allowed it, to `https://api.anthropic.com/api/oauth/usage` — and only under `tokenPace.userAgent: claudeCode`.',
    'No field is read for it that was not read before', 'and the read contract is unchanged',
    // §0a.3: what quota.json keeps of a failed attempt, what never, and when it goes.
    'and `quota.json`, which holds the readings of the quota fetch and, per provider, its last failed attempt: when it was, its kind and the fetch\'s own words',
    'never a token, a header or an exception\'s text; the entry goes with the next successful fetch, with *Clear Stored Data…* and with the file']) {
    assert.ok(privacy.includes(claim), `docs/privacy.md does not say: ${claim}`)
  }
  // The file holds what the pages say: the time, the kind and the words, nothing else.
  const manager = readDoc('src/quotaManager.ts')
  assert.ok(manager.includes('if (f) failed[src] = { at: f.at, kind: f.kind, text: f.text }'), 'quota.json keeps more of a failed attempt than the pages say')
  assert.ok(/clearPolled\(\): void \{[\s\S]*?this\.problem = \{\}/.test(manager), 'Clear Stored Data no longer forgets the failed attempts')
  assert.ok(flatText(doc.export).includes('the quota cache (`quota.json` — the readings of Token Pace\'s own fetch, the time of its next attempt and, per provider, its last failed attempt)'),
    'docs/export.md does not say what quota.json holds')
  assert.ok(flatText(doc.windows).includes('The Token Pace log says which, once, and again only when the version or its source changes'), 'docs/windows-wsl-remote.md says the log names it only once')
  assert.ok(flatText(README).includes('`quota.json` keeps the last failed attempt: its time, its kind and the fetch\'s own words, never a token, a header or an exception\'s text'),
    'README.md\'s privacy paragraph does not name quota.json\'s failed attempt')
})

test('the smaller 1.7 changes are on the pages: the compaction without a trigger, the revisions, one bucket copy, the injected probe (1.7 V-A, P-A, D-C)', () => {
  assert.ok(readDoc('src/agentTreeBuild.ts').includes("t('{0} · last at {1} (–, {2} → {3})'"), 'a compaction without a trigger is written otherwise')
  assert.ok(flatText(doc.agents).includes('whether it was asked for (`manual`) or Claude Code\'s own (`auto`) — `–` where the line recorded no trigger —'),
    'docs/agents.md does not say what a compaction without a trigger reads')
  // 1.8 P5 (pinned and changed): 1.6.0 and 1.7.0 kept revision 8 — history beside 1.8.0's 9.
  assert.ok(flatText(doc.agents).includes('revision **8** in 1.6.0 and 1.7.0'), 'docs/agents.md does not say 1.7.0 kept the revision')
  assert.ok(flatText(doc.counting).includes('8 in 1.6.0 and 1.7.0 —'), 'docs/counting.md does not say 1.7.0 kept the revision')
  const dev = flatText(doc.development)
  assert.ok(dev.includes('one copy instead of 25; the figures are the same'), 'docs/development.md does not name the one bucket copy')
  assert.ok(dev.includes('`test/poller.test.ts`') && dev.includes('no test starts a process or reads the real `PATH`'), 'docs/development.md does not name the injected probe')
  assert.ok(existsSync(join(ROOT, 'test/poller.test.ts')), 'the page names a test file that is not there')
  assert.ok(readDoc('src/viewModel.ts').includes('shareBuckets'), 'the unshared path the page compares with is gone')
})

/** 1.8 P5: what 1.7.0 shipped where 1.8 moved on — the agent tables' revision (1.8.0 raises it to 9). */
const RELEASED_1_7 = { AGENT_TABLES_REVISION: 8 } as const
/** 1.9 P17: the agent tables' revision 1.8.0 shipped, where 1.9 moved on to 10 (§0a.1) — RELEASED_1_8's, defined before its first use. */
const RELEASED_1_8_REVISION = 9

test('the 1.7.0 release notes: in the order a store page reads, the versions unchanged, no speed claim, no path or secret', () => {
  const log = readDoc('CHANGELOG.md')
  // 1.8 P11 (pinned and changed: "the newest CHANGELOG entry is 1.7.0"): 1.8.0 stands above it now,
  // so the 1.7.0 entry is found by its heading; the 1.8.0 entry has a test of its own below.
  const first = log.indexOf('\n## 1.7.0 ')
  assert.ok(first >= 0, 'the CHANGELOG has no 1.7.0 entry')
  const second = log.indexOf('\n## ', first + 4)
  const entry = log.slice(first, second)
  assert.match(entry, /^\n## 1\.7\.0 — \d{4}-\d{2}-\d{2}\n\n\*\*/, 'the 1.7.0 entry lost its date, or does not open with its summary')
  const flat = flatText(entry)
  const order = ['### Added', '### Changed', '### Fixed', '### Privacy'].map((h) => flat.indexOf(h))
  assert.ok(order.every((i) => i > 0) && order.every((i, k) => k === 0 || i > order[k - 1]), 'the 1.7.0 entry\'s sections are missing or out of order')
  for (const claim of [
    '**The provider switch.**', '**Earlier sessions in one closed row.**', '**State colours on the rows.**', '**Guide lines in the tree.**',
    '**The failed attempt beside a stale reading.**', `(German „${GERMAN['All']}")`, '`Earlier sessions (12)`',
    `At most ${MAX_ROOTS} active and ${MAX_ROOTS} earlier sessions are listed`,
    'green done, yellow unknown, red failed, blue running', '**Copy Diagnostics** says `next attempt` where it said `backoff until`',
    '**The Agents and Context sections are left out while the switch shows Codex**',
    'The status bar, its tooltips, the `budget` and `agents` entries, the alerts, the CSV and JSON exports and *Copy Diagnostics* follow no view',
    '**`retry reset due`.**', 'it now reads `retry due`', '`12.3K lower bound, since 11:59`', 'one copy instead of 25, the same figures',
    `\`STATE_VERSION\` ${STATE_VERSION}, \`AGENT_TABLES_REVISION\` ${RELEASED_1_7.AGENT_TABLES_REVISION} and the export's \`schema_version\` ${RELEASED_1_10.EXPORT_SCHEMA_VERSION} (\`EXPORT_SCHEMA_VERSION\` ${RELEASED_1_10.EXPORT_SCHEMA_VERSION}) are the values 1.6.0 wrote, unchanged`,
    'the update replays nothing and re-reads nothing',
    'Nothing new is read from any Claude Code or Codex file, and the read contract is unchanged.',
    'never a credential, a header or an exception\'s text',
  ]) assert.ok(flat.includes(claim), `the 1.7.0 entry does not say: ${claim}`)
  // Every version the entry names is the one 1.7.0 shipped: no bump is claimed. 1.8 P5 (pinned and
  // changed): the code's revision is 9 since, so the entry is held to 1.7.0's values, the two
  // unchanged ones still read from the code. 1.11 P5 (pinned and changed, §3 C4 rule 4): the export's is 4 since, so
  // the entry is held to 1.7.0's 3 as well.
  for (const m of flat.matchAll(/`(STATE_VERSION|AGENT_TABLES_REVISION|EXPORT_SCHEMA_VERSION)` (\d+)/g)) {
    const actual = { STATE_VERSION, AGENT_TABLES_REVISION: RELEASED_1_7.AGENT_TABLES_REVISION, EXPORT_SCHEMA_VERSION: RELEASED_1_10.EXPORT_SCHEMA_VERSION }[m[1] as 'STATE_VERSION']
    assert.equal(Number(m[2]), actual, `the 1.7.0 entry says ${m[1]} ${m[2]}`)
  }
  // P-A is one copy, not a speed-up (the lead's rule: nothing measured one).
  assert.equal(/faster|speed-?up|speeds? up|quicker|performance/i.test(entry), false, 'the 1.7.0 entry claims a speed-up')
  assert.equal(entry.includes('package.json'), false, 'the 1.7.0 entry talks about the manifest\'s version')
  // A store page: no path of the machine it was built on, no internal file, no secret.
  for (const never of [/\/home\//, /plan-1\.\d/, /p11-input/, /\.claude\/projects/, /VSCE_PAT|OVSX_PAT/, /research\//, /[A-Za-z]:\\/, /\/tmp\//]) {
    assert.equal(never.test(entry), false, `the 1.7.0 entry mentions ${never}`)
  }
})

test('docs/dashboard.md says the chart\'s labels are thinned to the width a column has, also when a folded section is opened, as the page\'s one toggle listener does (1.8 L-6)', () => {
  const dash = doc.dashboard.replace(/\s+/g, ' ')
  for (const claim of ['The value labels over the columns and the dates under them are thinned to the width a column actually has',
    'each column\'s total still in its tooltip', 'fitted again when the sidebar is resized and when a folded chart section is opened',
    // 1.8 Review 1: the step is the column width's (fitChart: 30 px a value, 34 px a date) — over the default
    // 30 days the harness measures every 3rd value and 4th date at 420 px, every 7th and 8th at 260 px.
    'only every n-th one where they would crowd (over 30 days every third value and every fourth date in a 420 px sidebar, every seventh and every eighth at 260 px)']) {
    assert.ok(dash.includes(claim), 'docs/dashboard.md does not say: ' + claim)
  }
  assert.equal(dash.includes('every second, third or sixth one'), false, 'docs/dashboard.md names steps the fit does not take')
  const src = readDoc('src/webview/main.ts')
  assert.ok(src.includes("document.addEventListener('toggle', () => { if (vm) applyFits(); }, true);"), 'opening a section no longer runs every fit: say it in the docs')
  assert.ok(src.includes("window.addEventListener('resize', () => { if (vm) applyFits(); });"), 'a resize no longer runs every fit: say it in the docs')
})

test('the pages say what 1.8 P5 keeps: the newest cache request of a main session, the Codex turn, revision 9, the Opus 5.5 row (§0a.2, §0a.3, §0a.5)', () => {
  const flat = (text: string): string => text.replace(/\s+/g, ' ')
  // docs/counting.md and docs/agents.md: the revision 1.8.0 raised, and why. 1.9 P17 (pinned and changed):
  // the code's revision is 10 since (§0a.1), so 1.8.0's 9 is history beside it, as 1.7.0's 8 is.
  const counting = flat(doc.counting)
  assert.ok(counting.includes(`, ${RELEASED_1_8_REVISION} in 1.8.0, 8 in 1.6.0 and 1.7.0 —`), 'docs/counting.md does not state 1.8.0\'s revision')
  assert.ok(counting.includes('1.8.0 raised it to 9 for the [prompt-cache estimate](prompt-cache.md#how-the-estimate-is-made)'),
    'docs/counting.md does not say why the revision rose')
  assert.ok(flat(doc.agents).includes(`revision **${RELEASED_1_8_REVISION}** in 1.8.0`), 'docs/agents.md does not state 1.8.0\'s revision')
  // docs/prompt-cache.md: the section, the fields it keeps, the six stop reasons, the literal, why it errs.
  const pc = flat(doc.promptCache)
  assert.ok(doc.promptCache.includes('\n## How the estimate is made\n'), 'docs/prompt-cache.md has no "How the estimate is made"')
  for (const field of ['timestamp', 'ephemeral_1h_input_tokens', 'usage.cache_creation', 'input_tokens', 'cache_creation_input_tokens',
    'cache_read_input_tokens', 'output_tokens', 'message.model', 'stop_reason', 'type', 'token_count', 'turn_context', 'model']) {
    assert.ok(doc.promptCache.includes(`\`${field}\``), `docs/prompt-cache.md does not name \`${field}\``)
  }
  assert.ok(pc.includes(STOP_REASONS.map((v) => `\`${v}\``).slice(0, -1).join(', ') + ` and \`${STOP_REASONS[STOP_REASONS.length - 1]}\``),
    'docs/prompt-cache.md does not list the stop reasons as the code keeps them')
  for (const claim of ['never an agent\'s transcript', 'every figure of that estimate carries `~`', 'which is why it carries `~`',
    'runs late by the time the model took to start its reply', 'would make it early', 'the time and the model of the newest counted turn of a rollout that is not a fork',
    'not rebuilt after the update']) {
    assert.ok(pc.includes(claim), `docs/prompt-cache.md does not say: ${claim}`)
  }
  // docs/privacy.md: the same fields, the literal the raw line is matched on, the Codex value, the leak test.
  const privacy = flat(doc.privacy)
  assert.ok(privacy.includes(`the unescaped literal \`${USER_LINE_LITERAL}\` on the raw line`), 'docs/privacy.md does not name the user-line literal')
  assert.ok(privacy.includes(STOP_REASONS.map((v) => `\`${v}\``).slice(0, -1).join(', ') + ` and \`${STOP_REASONS[STOP_REASONS.length - 1]}\``),
    'docs/privacy.md does not list the stop reasons as the code keeps them')
  for (const claim of ['of a main session\'s newest reply that used the prompt cache its time, the kind of cache it wrote (5 minutes or 1 hour), its size in tokens and its model',
    '`usage.cache_creation.ephemeral_1h_input_tokens`', 'the time and model of the newest turn', 'So does the prompt-cache request (1.8)']) {
    assert.ok(privacy.includes(claim), `docs/privacy.md does not say: ${claim}`)
  }
  // docs/cost.md: the Opus 5.5 row as the table holds it, its own check day, and what it changes.
  const row = PRICES['claude-opus-5-5'][0]
  assert.equal(row.from, OPUS_5_5_CHECKED)
  const cost = flat(doc.cost)
  const usd = (n: number): string => `$${Number.isInteger(n) ? n : n.toFixed(2)}`
  // 1.11 P5 (pinned and changed, §3 C5 rule 3): the two days written from the constants by longDay, no longer two
  // literals beside a check that the constants equal them — a re-check of the table changes prices.ts and cost.md only.
  for (const claim of [`${usd(row.input)} per million input tokens, ${usd(row.cacheWrite5m)} for a 5-minute cache write, ${usd(row.cacheWrite1h)} for a 1-hour cache write, ${usd(row.cacheRead)} for a cache hit and ${usd(row.output)} for output; fast mode ${usd(row.fast!.input)} in and ${usd(row.fast!.output)} out`,
    `the **Claude Opus 5.5** row from a check of Anthropic's pricing page on **${longDay(OPUS_5_5_CHECKED)}**`, 'priced from this row and marked `approximate`',
    'Opus 5.5 reads it at $0.20/MTok (0.05×)', `**Prices as of ${longDay(PRICES_AS_OF)}**`]) {
    assert.ok(cost.includes(claim), `docs/cost.md does not say: ${claim}`)
  }
  assert.ok(Math.abs(row.cacheRead / row.input - 0.05) < 1e-12, 'the page\'s 0.05× is the row\'s multiple')
  // The stale claims the row made wrong are gone.
  assert.equal(cost.includes('Opus 4.6** alone'), false, 'docs/cost.md still gives fast mode to Opus 4.6 alone')
  assert.equal(cost.includes('2 September 2026'), false, 'docs/cost.md still dates the table 2 September')
})

/**
 * 1.8 P6 (§3 A8 test 17): the prompt-cache page states the watch as the code has it — its constants,
 * the six state lines, the cost comparison with the table's own factors, the Codex line —, the
 * dashboard page and the numbers page point at it, and none of the places 1.3 promised "never an
 * estimate" in still says so (status-bar.md's tooltip sentence is P7's, with the tooltip rows).
 */
test('the prompt-cache page states the watch as the code has it, and 1.3\'s "never an estimate" is gone from the places it stood (1.8 P6)', () => {
  const cw = require('../src/cacheWatch') as typeof import('../src/cacheWatch')
  const flat = (text: string): string => text.replace(/\s+/g, ' ')
  const pc = flat(doc.promptCache)
  const minutes = (ms: number): string => `${ms / 60_000} minutes`
  for (const [name, value] of [
    ['CACHE_COOLING_LEAD_MS', minutes(cw.CACHE_COOLING_LEAD_MS)], ['CACHE_COLD_SHOWN_MS', minutes(cw.CACHE_COLD_SHOWN_MS)],
    ['CACHE_WATCH_MAX', String(cw.CACHE_WATCH_MAX)], ['CACHE_TEXT_MAX', String(cw.CACHE_TEXT_MAX)],
    ['BRIDGE_SKEW_MS', `${cw.BRIDGE_SKEW_MS / 1000} seconds`], ['CODEX_RETENTION_MS', minutes(cw.CODEX_RETENTION_MS)],
  ] as const) {
    assert.ok(doc.promptCache.includes(`| \`${name}\` | ${value} |`), `docs/prompt-cache.md does not state ${name} = ${value}`)
  }
  // The six state lines, as the table has them.
  for (const line of ['{0} · prompt cache warm · cools in {1} (1 h TTL)', '{0} · prompt cache cools in {1} (1 h TTL)',
    '{0} · prompt cache cold since {1} (1 h TTL)', '{0} · prompt cache warm · cools in ~{1} (1 h TTL, estimated from the transcript)',
    '{0} · prompt cache cools in ~{1} (1 h TTL, estimated from the transcript)', '{0} · prompt cache cold since ~{1} (1 h TTL, estimated from the transcript)']) {
    assert.ok(doc.promptCache.includes(`\`${line}\``), `docs/prompt-cache.md does not show ${line}`)
  }
  // The examples, as the real functions render them: Opus 5.5 on the page's day, 4 m 10 s before 14:52.
  const tz: TimeConfig = { zone: 'utc', dayBoundaryHour: 0, startOfWeek: 'monday', hourCycle: 'h23' }
  const expiry = Date.UTC(2026, 8, 24, 14, 52)
  const e = {
    sessionId: '9d0eb37a-0000', name: 'Session Tue 14:20 · 9d0eb37a', source: 'bridge' as const, ttl: '1h' as const,
    expiresAt: expiry, phase: 'cooling' as const, recache: 152_300, model: 'claude-opus-5-5',
  }
  const now = expiry - 250_000
  const examples = [
    cw.cacheLineText(e, now, tz), cw.cacheCostText(e, now, tz, {}, true),
    cw.cacheLineText({ ...e, phase: 'cold' }, expiry + 60_000, tz), cw.cacheCostText({ ...e, phase: 'cold' }, expiry + 60_000, tz, {}, true),
    cw.cacheCostText({ ...e, model: 'claude-experimental-x' }, now, tz, {}, true), cw.cacheMoreText(2),
    cw.codexCacheText({ at: expiry - cw.CODEX_RETENTION_MS, model: 'gpt-5.6-sol' }, expiry - 20 * 60_000, tz),
  ]
  for (const x of examples) assert.ok(x !== null && pc.includes(x), `docs/prompt-cache.md does not show: ${x}`)
  // The factors the table gives today, in the page's words.
  const factor = (m: string, k: 'cacheWrite1h' | 'cacheRead'): string => cw.factorText(PRICES[m][0][k] / PRICES[m][0].input)
  assert.ok(pc.includes(`${factor('claude-opus-5-5', 'cacheWrite1h')}× and ${factor('claude-opus-5-5', 'cacheRead')}× for Claude Opus 5.5`))
  assert.ok(pc.includes(`${factor('claude-fable-5-1', 'cacheWrite1h')}× and ${factor('claude-fable-5-1', 'cacheRead')}× for Claude Fable 5.1 and Mythos 5.1`))
  assert.ok(pc.includes(`${factor('claude-sonnet-5', 'cacheWrite1h')}× and ${factor('claude-sonnet-5', 'cacheRead')}× for every other Claude model`))
  for (const claim of ['every figure of that estimate carries `~`', 'estimated from the transcript', 'no factor is written into the code',
    'at a weight Anthropic does not publish', '`tokenPace.unknownModelPricing: family`', 'the status line\'s `fast_mode` is not read',
    'a closed session\'s cache cools as well', '`promptCacheTtl`', '`subagentPromptCacheTtl`', '`CLAUDE_CODE_PROMPT_CACHE_TTL`',
    '`ENABLE_PROMPT_CACHING_1H=1`', '`FORCE_PROMPT_CACHING_5M=1`', '`claude -p "hello" --output-format json`',
    'the transcript does not overrule it', 'a cooling cache is a moment, not a record', 'It is measured, never estimated.',
    'It is a minimum, not an expiry']) {
    assert.ok(pc.includes(claim), `docs/prompt-cache.md does not say: ${claim}`)
  }
  // The dashboard's quota row and the numbers table point at the page and name the estimate.
  const quotaRow = doc.dashboard.split('\n').find((l) => l.startsWith('| `quota` |')) ?? ''
  for (const claim of ['[Prompt cache](prompt-cache.md)', 'estimated from its transcript where it does not', 'carries `~` on every figure',
    'the bridge\'s words, measured', examples[0], examples[1]]) {
    assert.ok(quotaRow.includes(claim as string), `docs/dashboard.md's quota row does not say: ${claim}`)
  }
  assert.ok(doc.numbers.split('\n').some((l) => l.startsWith('| Prompt cache of a Claude Code session') && l.includes('**estimate** from the transcript')),
    'docs/numbers.md has no row for the prompt-cache estimate')
  // 1.3's promise, gone from the places it stood (spec fact 3).
  assert.equal(quotaRow.includes('never an estimate of any of it'), false, 'docs/dashboard.md still promises no estimate')
  // A doc comment read as its sentences: the leading `*` of each line taken off.
  const prose = (file: string): string => flat(readDoc(file).replace(/\n\s*\*(?!\/)\s?/g, ' '))
  const promptCacheSrc = prose('src/promptCache.ts')
  assert.equal(promptCacheSrc.includes('no view ever estimates any of it'), false, 'src/promptCache.ts still promises no estimate')
  assert.ok(promptCacheSrc.includes('1.8 reversed 1.3\'s promise that the cache is never estimated'))
  const vmSrc = prose('src/viewModel.ts')
  assert.equal(vmSrc.includes('nothing here is ever estimated from the transcripts'), false, 'QuotaCard.promptCache still promises no estimate')
  assert.equal(vmSrc.includes('like the context window, this figure has no second source'), false, 'VmInput.promptCache still promises no estimate')
})

/**
 * 1.8 P9 (§3 B2 "Docs", §7a Q19): the prompt-cache page's keep-warm section — a draft P10 grows and
 * P11 finishes — names every guard in reader words with Q19's numbers, states the constants as
 * src/keepWarm.ts has them, the line word for word, what no check can see, and nothing of the spec's
 * superseded four minutes; the privacy page points the two §0a.5 facts at it.
 */
test('the prompt-cache page\'s keep-warm section states the checks and the constants as src/keepWarm.ts has them (1.8 P9)', () => {
  const kw = require('../src/keepWarm') as typeof import('../src/keepWarm')
  const coolingMinutes = (require('../src/cacheWatch') as typeof import('../src/cacheWatch')).CACHE_COOLING_LEAD_MS / 60_000
  const flat = (text: string): string => text.replace(/\s+/g, ' ')
  const page = doc.promptCache
  const head = '\n## Keep-warm in a terminal (opt-in)\n'
  assert.ok(page.includes(head), 'docs/prompt-cache.md has no keep-warm section')
  const from = page.indexOf(head)
  const section = page.slice(from, page.indexOf('\n## ', from + head.length))
  const text = flat(section)
  const minutes = (ms: number): string => `${ms / 60_000} minutes`
  const seconds = (ms: number): string => `${ms / 1000} seconds`
  for (const [name, value] of [
    ['KEEPWARM_LEAD_MS', minutes(kw.KEEPWARM_LEAD_MS)], ['KEEPWARM_COUNTDOWN_MS', seconds(kw.KEEPWARM_COUNTDOWN_MS)],
    ['KEEPWARM_SEND_MARGIN_MS', seconds(kw.KEEPWARM_SEND_MARGIN_MS)], ['KEEPWARM_IDLE_MIN_MS', seconds(kw.KEEPWARM_IDLE_MIN_MS)],
    ['KEEPWARM_VERIFY_MS', minutes(kw.KEEPWARM_VERIFY_MS)], ['KEEPWARM_MAX_PER_IDLE', String(kw.KEEPWARM_MAX_PER_IDLE)],
    ['KEEPWARM_QUOTA_STOP_PERCENT', `${kw.KEEPWARM_QUOTA_STOP_PERCENT} %`],
  ] as const) {
    assert.ok(section.includes(`| \`${name}\` | ${value} |`), `the keep-warm section does not state ${name} = ${value}`)
  }
  // One numbered check per guard of the decision.
  const guards = new Set(Object.values(kw.KEEPWARM_GUARD_OF))
  assert.equal([...section.matchAll(/^\d+\. \*\*/gm)].length, guards.size, 'the section does not list one check per guard')
  // Q19's numbers in words, derived from the constants.
  const lead = kw.KEEPWARM_LEAD_MS / 60_000
  for (const claim of [
    `once the cache has ${lead} minutes or less of warmth left`,
    `so the line goes at about ${(kw.KEEPWARM_LEAD_MS - kw.KEEPWARM_COUNTDOWN_MS) / 60_000} minutes left`,
    'never within the last minute before the expiry', 'a window that was asleep at that moment sends nothing late',
    `The cooling warning on the card still starts at ${coolingMinutes} minutes`,
    `At most ${kw.KEEPWARM_MAX_PER_IDLE} lines in a row`, `at ${kw.KEEPWARM_QUOTA_STOP_PERCENT} % or more, or reached`,
    `within ${kw.KEEPWARM_VERIFY_MS / 60_000} minutes`, 'at least a minute old and ended its turn (`end_turn`)',
    'Claude Code writes a reply that calls a tool only once the tool has finished',
    'such a session gets the warning, never a line', 'The terminal\'s name, its output and its environment are never read.',
    'text you typed there and did not send is sent together with the line',
    'type nothing into the Claude terminal while the countdown runs', 'Without a quota reading this check does not block.',
    `\`${kw.KEEP_WARM_LINE}\``, '`tokenPace.cacheKeepWarm`', 'never in Restricted Mode',
  ]) {
    assert.ok(text.includes(claim), `the keep-warm section does not say: ${claim}`)
  }
  // The spec's older numbers are superseded by Q19.
  for (const stale of ['4 minutes', 'four minutes', '55 minutes']) assert.equal(text.includes(stale), false, `the keep-warm section still says ${stale}`)
  // The privacy page's §0a.5 facts point at the section; the estimate section links it.
  // 1.10 P4 (pinned and changed — "serve only" the keep-warm line's checks): since 1.10 the Prompts section's too (§0a.5).
  assert.ok(flat(doc.privacy).includes('Those two facts serve the checks of the opt-in [keep-warm line](prompt-cache.md#keep-warm-in-a-terminal-opt-in) (1.8), which types nothing unless that reply ended its turn (`end_turn`) and the newest message line is not the user\'s, and — since 1.10 — the dashboard\'s [Prompts](prompts.md#when-token-pace-does-not-send-or-asks-first) section'))
  assert.equal(flat(doc.privacy).includes('Those two facts serve only'), false)
  assert.ok(flat(page).includes('for the checks of the opt-in [keep-warm line](#keep-warm-in-a-terminal-opt-in)'))
})

/**
 * 1.8 P7 (§3 A5, A8): the status-bar pages, the settings page and the setting itself name the `cache`
 * entry as the status bar writes it — every text taken from `buildItems`, not written out here —, the
 * ids table has its id, and status-bar.md's tooltip paragraph no longer promises that the prompt cache
 * is never estimated (spec fact 3's last place; P6 took the other four).
 */
test('the status bar pages, the settings page and the setting name the cache entry as the status bar writes it; the tooltip paragraph no longer promises "no estimate" (1.8 P7)', () => {
  const cw = require('../src/cacheWatch') as typeof import('../src/cacheWatch')
  const NOW = Date.UTC(2026, 8, 24, 14, 47, 50)
  const entry = (left: number, source: 'bridge' | 'transcript', id = '9d0eb37a-0000'): import('../src/cacheWatch').CacheWatchEntry => ({
    sessionId: id, name: `Session Tue 14:20 · ${id.slice(0, 8)}`, source, ttl: '1h', expiresAt: NOW + left,
    phase: cw.cachePhase(NOW + left, NOW)!, recache: 152_300, model: 'claude-opus-5-5',
  })
  const item = (entries: import('../src/cacheWatch').CacheWatchEntry[]) => buildItems({
    quotas: [], agg: { sum: () => { throw new Error('unused') }, cost: () => { throw new Error('unused') } },
    cfg: sanitize({ 'tokenPace.statusBar.show': ['cache'], 'tokenPace.timezone': 'utc' }), now: NOW, forecasts: new Map(),
    role: 'single', scanning: false, consent: 'granted', cacheWatch: entries,
  })[0]
  const measured = item([entry(250_000, 'bridge')])
  const estimated = item([entry(250_000, 'transcript')])
  const seconds = item([entry(45_000, 'bridge')])
  const secondsEstimated = item([entry(45_000, 'transcript')])
  const two = item([entry(250_000, 'bridge'), entry(270_000, 'transcript', '5f1c2d3e-0000')])
  assert.deepEqual([measured.text, estimated.text, seconds.text, secondsEstimated.text, two.text],
    ['$(watch) cache 4m', '$(watch) cache ~4m', '$(watch) cache 45s', '$(watch) cache ~45s', '$(watch) cache 4m +1'])
  // Listed wherever the entries are; its texts, its id and its spoken words are the code's.
  assert.match(doc.statusBar, /`budget`, `agents`, `cache`\. The array order/)
  for (const text of [measured.text, estimated.text, seconds.text, two.text]) {
    assert.ok(doc.statusBar.includes(`\`${text}\``), `docs/status-bar.md does not quote ${text}`)
  }
  assert.ok(doc.statusBar.split('\n').some((l) => l.startsWith(`| \`${measured.text}\` / \`${estimated.text}\` |`)), 'docs/status-bar.md has no row for the entry')
  for (const row of [`| \`${measured.text}\` |`, `| \`${estimated.text}\` |`, `| \`${seconds.text}\` / \`${secondsEstimated.text}\` |`, `| \`${two.text}\` |`]) {
    assert.ok(STATES.split('\n').some((l) => l.startsWith(row)), `docs/status-bar-states.md has no row ${row}`)
  }
  assert.ok(STATES.includes(`| Prompt cache | \`${measured.id}\` |`), 'docs/status-bar-states.md does not list the id')
  const flat = (x: string): string => x.replace(/\s+/g, ' ')
  for (const [name, page] of [['docs/status-bar.md', doc.statusBar], ['docs/status-bar-states.md', STATES], ['docs/prompt-cache.md', doc.promptCache]] as const) {
    assert.ok(flat(page).includes(measured.ariaLabel as string), `${name} does not say what a screen reader hears: ${measured.ariaLabel}`)
  }
  assert.equal(measured.ariaLabel, 'Prompt cache of Session Tue 14:20 · 9d0eb37a cools in 4 m 10 s')
  assert.ok(flat(doc.statusBar).includes('`… cools in about 4 m 10 s (estimated)`') && estimated.ariaLabel?.endsWith('cools in about 4 m 10 s (estimated)'))
  assert.match(doc.settings, /`agents` shows only while a Claude Code agent runs, `cache` only in the last five minutes of a Claude Code session's one-hour \[prompt cache\]\(prompt-cache\.md\)/)
  assert.ok(flat(doc.promptCache).includes('The opt-in entry `cache` in `tokenPace.statusBar.show` (not in the default) shows only while a watched cache is cooling'))
  // Off by default, and the example in its description is the entry's own text without its icon, in both languages.
  const setting = properties['tokenPace.statusBar.show'] as { default?: string[]; items?: { enum?: string[]; enumDescriptions?: string[] } }
  assert.equal(setting.default?.includes('cache'), false)
  const at = setting.items?.enum?.indexOf('cache') ?? -1
  assert.ok(at >= 0)
  const bare = (text: string): string => text.replace('$(watch) ', '')
  assert.ok(setting.items?.enumDescriptions?.[at]?.includes(`“${bare(measured.text)}”`) && setting.items?.enumDescriptions?.[at]?.includes(`“${bare(estimated.text)}”`),
    setting.items?.enumDescriptions?.[at])
  const bundle = JSON.parse(readDoc('l10n/bundle.l10n.de.json')) as Record<string, string>
  const de = JSON.parse(readDoc('package.nls.de.json')) as Record<string, string>
  assert.ok(de['config.statusBar.show.enum.cache'].includes(`“${bundle['cache {0}'].replace('{0}', '4m')}”`), de['config.statusBar.show.enum.cache'])
  // Spec fact 3, the last of its five places: the tooltip paragraph says the estimate, not its absence.
  assert.equal(flat(doc.statusBar).includes('absent rather than estimated'), false, 'docs/status-bar.md still promises no estimate')
  assert.ok(flat(doc.statusBar).includes('estimated from the session\'s transcript, carry `~` and say *estimated from the transcript*'))
  assert.ok(flat(doc.statusBar).includes('unless its session is one of the rows above: one row per session'))
})

/**
 * 1.8 P10 (§3 B2 "Docs", §0a.6–§0a.8, §7a Q19, §7c): the keep-warm line on the pages a reader looks it up
 * on — the prompt-cache page's section grown with the countdown, the notes, the accounting, the switch
 * and the terms passage word for word with its link; the troubleshooting section naming every reason
 * a line was held back; the status-bar states and the settings and commands rows in the host's words;
 * the privacy page's readers.
 */
test('the pages describe the keep-warm line as the host builds it: the countdown, the notes, the accounting, the consent, the terms, every block (1.8 P10)', () => {
  const kw = require('../src/keepWarm') as typeof import('../src/keepWarm')
  const host = require('../src/keepWarmHost') as typeof import('../src/keepWarmHost')
  const { KEEP_WARM_TERMS_PASSAGE } = require('../src/consent') as typeof import('../src/consent')
  const flat = (text: string): string => text.replace(/\s+/g, ' ')
  const page = doc.promptCache
  const from = page.indexOf('\n## Keep-warm in a terminal (opt-in)\n')
  const section = flat(page.slice(from, page.indexOf('\n## ', from + 10)))
  const hostSrc = readDoc('src/keepWarmHost.ts')
  // The item's words, as keepWarmHost.ts writes them (its t() keys), with the page's example figures.
  assert.ok(hostSrc.includes("t('keep warm in {0} s · cancel', secs)") && hostSrc.includes("t('keep-warm line sent')"))
  const item = '`$(watch) keep warm in 42 s · cancel`'
  for (const claim of [
    item, '`$(watch) keep-warm line sent` for 10 seconds', 'whatever `tokenPace.statusBar.show` lists',
    '**A click cancels** the line and keep-warm for the rest of the session\'s idle phase', '*Token Pace: Cancel the Keep-Warm Line*',
    'At zero every check runs again', 'a window starts one only for the session its own Claude terminal began (checks 7 and 13)',
    'one whose `claude` started after the session\'s first reply never does',
    'a terminal is known by its folder, not by the session in it', 'one resumed there with `claude --resume` — never gets a line',
    'That session gets the line only while it is idle by check 13\'s measure',
    'what time cannot tell apart is a terminal whose `claude` started before the session\'s first reply',
    'Keep-warm line for this session in 42 s — cancel it in the status bar.',
    'Keep-warm cannot reach this session: it does not run in a VS Code terminal of this window.',
    'Keep-warm stopped for this session: the last line got no answer within two minutes.',
    'Keep-warm requests today: 2 · 64 tokens', '`keepwarm.json`', '31 days at most',
    'A session in the Claude Code extension\'s own panel gets the cooling warning and never a line.',
    'a half-typed draft and the line went out as one message', 'type nothing into the Claude terminal while the countdown runs',
    'a setting of the application scope', 'only *Allow keep-warm* allows it', 'the question comes again only when you switch the setting off and on',
    'Switching it off withdraws the consent', `“${KEEP_WARM_TERMS_PASSAGE}”`,
    '[Consumer Terms](https://www.anthropic.com/legal/consumer-terms)', 'This page gives no legal advice',
    '`sendText`', '`onDidStartTerminalShellExecution`', '`onDidEndTerminalShellExecution`',
  ]) assert.ok(section.includes(claim), `the keep-warm section does not say: ${claim}`)
  for (const [name, value] of [['KEEPWARM_SENT_SHOWN_MS', `${host.KEEPWARM_SENT_SHOWN_MS / 1000} seconds`],
    ['KEEPWARM_VERIFY_GRACE_MS', `${host.KEEPWARM_VERIFY_GRACE_MS / 1000} seconds`], ['KEEPWARM_DAYS_KEPT', String(host.KEEPWARM_DAYS_KEPT)]]) {
    assert.ok(section.includes(`| \`${name}\` | ${value} |`), `the keep-warm section does not state ${name} = ${value}`)
  }
  assert.equal(host.KEEPWARM_SENT_SHOWN_MS, 10_000)
  assert.equal(host.KEEPWARM_DAYS_KEPT, 31)
  assert.equal(kw.KEEPWARM_VERIFY_MS, 2 * 60_000, '"within two minutes" on the card and the pages')
  // Troubleshooting names every block the decision can give, in backticks, under its own heading.
  const trouble = doc.troubleshooting
  const at = trouble.indexOf('\n## No keep-warm line was sent\n')
  assert.ok(at >= 0, 'docs/troubleshooting.md has no keep-warm section')
  const why = trouble.slice(at, trouble.indexOf('\n## ', at + 10))
  for (const block of Object.keys(kw.KEEPWARM_GUARD_OF)) assert.ok(why.includes(`\`${block}\``), `troubleshooting.md does not explain ${block}`)
  assert.ok(flat(why).includes('`keep-warm: session 9d0eb37a not armed (typedSince)`') && flat(why).includes('`keep-warm: not sent (notIdle)`'))
  // The status-bar states and the id; the settings row; the commands row.
  for (const text of [item, '`$(watch) keep-warm line sent`', '`tokenPace.keepWarm`']) assert.ok(STATES.includes(text), `status-bar-states.md does not name ${text}`)
  // 1.10 D8 (pinned and changed): "press to cancel", and the old verb nowhere.
  assert.ok(flat(STATES).includes('Keep-warm line for Session Tue 14:20 · 9d0eb37a in 42 seconds, press to cancel'))
  assert.ok(section.includes('Keep-warm line for Session Tue 14:20 · 9d0eb37a in 42 seconds, press to cancel'))
  for (const text of [STATES, page, doc.privacy, doc.troubleshooting]) assert.equal(flat(text).includes('activate to cancel'), false)
  const row = SETTINGS.split('\n').find((l) => l.startsWith('| `cacheKeepWarm` | `false` |')) ?? ''
  for (const claim of ['three minutes or less left', 'about two minutes before the cache expires', 'withdraws it', 'Application scope',
    'text you typed but did not send is sent with it', 'not explicitly permit', 'own panel are out of reach']) {
    assert.ok(row.includes(claim), `the settings row does not say: ${claim}`)
  }
  assert.ok(doc.commands.includes('| `Token Pace: Cancel the Keep-Warm Line` | |'))
  // Q19's numbers everywhere the pages speak of the nudge; the spec's older ones nowhere.
  for (const text of [section, flat(why), row]) {
    for (const stale of ['four minutes before', '4 minutes before', 'about 55 minutes', 'quiet for 55']) assert.equal(text.includes(stale), false, stale)
  }
  // Privacy: the readers by their names, the one line typed, the file, the leak test.
  const privacy = flat(doc.privacy)
  for (const claim of ['VS Code\'s shell integration', '`sendText`', 'Nothing is ever read back from the terminal',
    'Never a terminal\'s name — Claude Code sets it to a summary of the conversation —', '`tokenPace.keepWarmConsent`',
    'never a session id, a path, a time of day, a terminal or a command line', '`claude --api-key synthetic-secret-123` in `/home/u/synthetic-project`']) {
    assert.ok(privacy.includes(claim), `docs/privacy.md does not say: ${claim}`)
  }
})

/** 1.8 P11: what 1.8.0 ships where later releases may move on — pinned here, read from the code today. */
const RELEASED_1_8 = { AGENT_TABLES_REVISION: RELEASED_1_8_REVISION } as const

/**
 * 1.8 P11 (§4 P11 (5), §7c, the P11 input's claims to make and to avoid): the 1.8.0 entry is the newest,
 * in the order a store page reads, states every version as the code has it, names what was built — the
 * cooling warning, the `cache` entry, the Codex line, the keep-warm line with Q19's numbers from the
 * constants, the narrowed mirror, the bridge's copy, the Opus 5.5 row, L-4 and L-5 as fixes, L-6 as a
 * robustness change — and nothing that was struck, superseded or not measured.
 */
test('the 1.8.0 release notes: the newest entry, every section in order, the versions and numbers the code has, nothing struck or unmeasured', () => {
  const kw = require('../src/keepWarm') as typeof import('../src/keepWarm')
  const cw = require('../src/cacheWatch') as typeof import('../src/cacheWatch')
  const { KEEP_WARM_TERMS_PASSAGE } = require('../src/consent') as typeof import('../src/consent')
  const log = readDoc('CHANGELOG.md')
  // 1.9 P20 (pinned and changed: "the newest CHANGELOG entry is 1.8.0"): 1.9.0 stands above it now, so the
  // 1.8.0 entry is found by its heading; the 1.9.0 entry has a test of its own (1.9 P20, below).
  const first = log.indexOf('\n## 1.8.0 ')
  assert.ok(first >= 0, 'the CHANGELOG has no 1.8.0 entry')
  const second = log.indexOf('\n## ', first + 4)
  const entry = log.slice(first, second)
  assert.match(entry, /^\n## 1\.8\.0 — 2026-09-25\n\n\*\*/, 'the 1.8.0 entry is not of 2026-09-25, or does not open with its summary')
  const flat = flatText(entry)
  const order = ['### Added', '### Changed', '### Fixed', '### Privacy', '### Internal'].map((h) => flat.indexOf(h))
  assert.ok(order.every((i) => i > 0) && order.every((i, k) => k === 0 || i > order[k - 1]), 'the 1.8.0 entry\'s sections are missing or out of order')
  const cooling = cw.CACHE_COOLING_LEAD_MS / 60_000
  assert.equal(cooling, 5)
  for (const claim of [
    // Added: the cooling warning, the entry, the Codex line, the keep-warm line.
    '**The cooling warning on the Claude card.**', 'Only a one-hour prompt cache is watched',
    '`Session Tue 14:20 · 9d0eb37a · prompt cache cools in 4 m 10 s (1 h TTL)`',
    'A cold start after 14:52 re-writes 152.3K tokens at the 1 h write rate (2× input, ~$1.22) instead of reading them from the cache (0.05× input, ~$0.03).',
    'At most three sessions, the most urgent first', '2× and 0.05× for Claude Opus 5.5', 'a cooling cache is a moment, not a record',
    '**The `cache` status-bar entry**', '`$(watch) cache 4m`', '`$(watch) cache ~4m`', 'Hidden while none is cooling, a cold cache included; no colour and no alarm',
    '**The Codex line.**', 'no countdown, no cooling, no cost, no status-bar entry',
    '**The keep-warm line — opt-in, off by default.**', '`tokenPace.cacheKeepWarm`', `\`${kw.KEEP_WARM_LINE}\``,
    'three minutes or less left', 'counts down 60 seconds', 'at about two minutes left', 'at most three lines per idle phase',
    `no Claude quota window at ${kw.KEEPWARM_QUOTA_STOP_PERCENT} % or more, or reached`, 'never the transcript\'s estimate', 'the workspace trusted',
    'so the line goes only when you left the Claude terminal before its newest reply ended',
    'cancels the line and keep-warm for the rest of that session\'s idle phase; the setting stays as it is',
    'whether the cache entry then lives on is Anthropic\'s rule, which Token Pace does not measure',
    'a draft left in Claude Code\'s input line is sent with the line', 'the Claude Code extension\'s own panel is out of reach',
    'section 3 of Anthropic\'s Consumer Terms', 'is out of reach until it is started again', '`keepwarm.json`', 'application scope',
    // Changed: 1.3.0's promise, one line per session, Opus 5.5, the dialog.
    '1.3.0 said: "Without the bridge there is no line — nothing is estimated."', '*estimated from the transcript* in words',
    '**One line per session.**', '**Claude Opus 5.5 is priced.**', 'marked `approximate`',
    '`Prices as of 2026-09-06; checked later: claude-opus-5-5 (2026-09-24).`', 'at Opus 5.5\'s rates, the newest priced Opus',
    '**The status-line bridge\'s consent dialog**',
    // Fixed: the bridge's copy, L-4, L-5.
    '**The status-line bridge after an update.**', '`statusline-bridge.js`', 'a backup of the original `settings.json` first',
    'the guide lines stop a pixel above it and go on a pixel below it', '**Thin subagents\' bands in a forced-colours theme**',
    // Privacy: the narrowed mirror, the two fields, nothing new from a transcript, the terminals, three opt-ins.
    '1.3 to 1.7 stored it so in `statusline-mirror.json`', '`session_id`', '`prompt_cache.recache_tokens_if_cold`',
    '**Nothing new is read from a transcript.**', 'never a terminal\'s name, its output or its environment', '**Three opt-ins now**',
    // Internal: the versions, the pushes, the measured build, L-6, the read contract.
    // 1.11 P5 (pinned and changed, §3 C4 rule 4): the schema version 1.8.0 shipped, 3 — the code's is 4 since.
    `\`STATE_VERSION\` ${STATE_VERSION} and the export's \`schema_version\` ${RELEASED_1_10.EXPORT_SCHEMA_VERSION} (\`EXPORT_SCHEMA_VERSION\` ${RELEASED_1_10.EXPORT_SCHEMA_VERSION}) are unchanged`,
    `\`AGENT_TABLES_REVISION\` 8 → ${RELEASED_1_8.AGENT_TABLES_REVISION}`, 'rebuilds the agent tables once',
    'a median 36 ms instead of 53 in UTC and 55 instead of 73 in Europe/Berlin — a measurement, not a promise',
    'Opening a folded section of the dashboard runs every fit again', '(13 rows, the narrowing at activation among them)',
  ]) assert.ok(flat.includes(claim), `the 1.8.0 entry does not say: ${claim}`)
  // 1.9 P17 (pinned and changed): the code's revision is 10 since (§0a.1, one replay after the update), so
  // the entry is held to 1.8.0's value and the code to the one after it.
  assert.equal(AGENT_TABLES_REVISION, RELEASED_1_8.AGENT_TABLES_REVISION + 1, 'the code\'s revision is not the one after 1.8.0\'s')
  assert.equal(kw.KEEPWARM_LEAD_MS, 3 * 60_000, '"three minutes or less"')
  assert.equal(kw.KEEPWARM_COUNTDOWN_MS, 60_000, '"counts down 60 seconds"')
  assert.equal(kw.KEEPWARM_MAX_PER_IDLE, 3, '"at most three lines"')
  assert.equal(cw.CACHE_WATCH_MAX, 3, '"At most three sessions"')
  // The build figures are development.md's, measured there.
  assert.ok(flatText(doc.development).includes('a build took a median 36 ms instead of 53 in UTC (55 instead of 73 in Europe/Berlin)'))
  // The Consumer Terms' passage is the dialog's; the entry names it and does not re-word it.
  assert.equal(flat.includes(KEEP_WARM_TERMS_PASSAGE), false, 'the entry quotes the terms passage — the page and the dialog do')
  // Every version the entry names is the one 1.8.0 ships (1.11 P5, pinned and changed: the export's as released).
  for (const m of flat.matchAll(/`(STATE_VERSION|EXPORT_SCHEMA_VERSION)` (\d+)/g)) {
    assert.equal(Number(m[2]), m[1] === 'STATE_VERSION' ? STATE_VERSION : RELEASED_1_10.EXPORT_SCHEMA_VERSION, `the 1.8.0 entry says ${m[1]} ${m[2]}`)
  }
  // Claims to avoid (the P11 input): B1 was struck; L-6 is no visible fix; no cooling, countdown or cost
  // for Codex; no "safe"; nothing it cannot see is claimed seen; Q19 superseded the spec's four and 55 minutes.
  for (const never of [/\/loop/, /copyKeepWarm/i, /keep-warm prompt/i, /Copy keep-warm/i, /\bsafe(ly)?\b/i, /detects? (a )?draft/i,
    /four minutes|4 minutes|55 minutes/, /never an estimate/i, /chart labels?/i, /keeps? (the )?focus/i, /unanswered lines? (are|is) counted/i]) {
    assert.equal(never.test(entry), false, `the 1.8.0 entry says ${never}`)
  }
  // A store page: no path of the machine it was built on, no internal file, no secret, no package version talk.
  for (const never of [/\/home\//, /plan-1\.\d/, /p11-input/, /\.claude\/projects/, /VSCE_PAT|OVSX_PAT/, /research\//, /[A-Za-z]:\\/, /\/tmp\//, /package\.json/]) {
    assert.equal(never.test(entry), false, `the 1.8.0 entry mentions ${never}`)
  }
})

/**
 * 1.8 P11 (§4 P11 (1), (4), (6); §7c wave 3 decisions; the P11 input's wave 3 list): the sentences the
 * package added where a reader would look — the G8 sentence and the slash-command rule of the keep-warm
 * checks, the three opt-ins wherever Restricted Mode is named, the countdown item on the status-bar
 * page, the keep-warm notes in the dashboard's quota row, the bridge's copy beside the hook's in the
 * stored-data list and on uninstall, the Opus 5.5 check day in the numbers table, the README's features
 * and its fourth picture, and the walkthrough's `cache` entry.
 */
test('the pages say what 1.8 P11 checked against the code: the keep-warm focus rule, three opt-ins, the bridge\'s copy, the price check day, the README features (1.8 P11)', () => {
  const pc = flatText(doc.promptCache)
  for (const claim of [
    'So the line goes only when you left the Claude terminal — another terminal active, or the window unfocused — before its newest reply ended',
    'A local command such as `/usage` or `/cost` leaves a line of yours newest as well, so after one no line goes until the session\'s next real reply.',
    'and it costs that session one request', '[prompt caching](https://code.claude.com/docs/en/prompt-caching)',
    'In Restricted Mode no terminal is listened to and no line goes', 'a record of the day, so also after the setting was switched off',
  ]) assert.ok(pc.includes(claim), `docs/prompt-cache.md does not say: ${claim}`)
  assert.equal(doc.promptCache.includes('<!-- 1.8 P9') || doc.promptCache.includes('P11 reviews the section'), false, 'a build note is left in the page')
  // Three opt-ins wherever Restricted Mode is named for them.
  assert.ok(flatText(doc.windows).includes('In Restricted Mode the three opt-ins that act outside the extension\'s storage are disabled'))
  assert.equal(flatText(doc.windows).includes('the two opt-in writes are disabled'), false)
  assert.ok(flatText(README).includes('three opt-ins, each behind its own consent dialog, all three off by default and off in Restricted Mode'))
  assert.equal(flatText(README).includes('except the two opt-ins, each behind'), false)
  // 1.10 P3 (§3 A6, pinned and changed): the manifest's statement names the two things Token Pace types —
  // the keep-warm line and a prompt you send (Review 2 F4: by a double-click, its send button or Ctrl+Enter) —
  // and that Restricted Mode disables all of them.
  assert.ok(nlsEn['capabilities.untrustedWorkspaces'].includes('It types into a terminal in two cases only: the opt-in keep-warm line into Claude Code\'s terminal, and a prompt of the dashboard\'s Prompts section when you send it yourself — a double-click, its send button or Ctrl+Enter. All of these are disabled in Restricted Mode.'))
  assert.ok(nlsDe['capabilities.untrustedWorkspaces'].includes('In ein Terminal tippt es nur in zwei Fällen: die optionale Warmhalte-Zeile in das Terminal von Claude Code und einen Prompt aus dem Abschnitt Prompts des Dashboards, wenn Sie ihn selbst senden — per Doppelklick, mit seiner Sende-Schaltfläche oder mit Strg+Eingabe. All das ist im eingeschränkten Modus abgeschaltet.'))
  assert.equal(nlsEn['capabilities.untrustedWorkspaces'].includes('the one thing it ever types'), false)
  assert.equal(nlsDe['capabilities.untrustedWorkspaces'].includes('das Einzige, was es je tippt'), false)
  assert.ok(flatText(doc.privacy).includes('Those are the three opt-ins, each behind a consent dialog of its own.'))
  assert.ok(flatText(doc.quotaSources).includes('and so is the third opt-in, the [keep-warm line](prompt-cache.md#keep-warm-in-a-terminal-opt-in)'))
  // The countdown item on the status-bar page, the notes in the dashboard's quota row.
  assert.ok(flatText(doc.statusBar).includes('its own item `tokenPace.keepWarm` stands before every other Token Pace item (priority 1001)'))
  const { KEEPWARM_ITEM_PRIORITY, KEEPWARM_ITEM_ID } = require('../src/keepWarmHost') as typeof import('../src/keepWarmHost')
  assert.equal(KEEPWARM_ITEM_PRIORITY, 1001)
  assert.equal(KEEPWARM_ITEM_ID, 'tokenPace.keepWarm')
  const quotaRow = doc.dashboard.split('\n').find((l) => l.startsWith('| `quota` |')) ?? ''
  for (const claim of ['`Keep-warm line for this session in 42 s — cancel it in the status bar.`',
    '`Keep-warm cannot reach this session: it does not run in a VS Code terminal of this window.`',
    '`Keep-warm stopped for this session: the last line got no answer within two minutes.`', '`Keep-warm requests today: 2 · 64 tokens`']) {
    assert.ok(quotaRow.includes(claim), `docs/dashboard.md's quota row does not say: ${claim}`)
  }
  // The bridge's copy stays beside the hook's in the stored-data list, and goes on uninstall.
  assert.ok(flatText(doc.export).includes('The status-line bridge\'s script, `statusline-bridge.js` — the copy Claude Code\'s `statusLine.command` runs since 1.8 — is not in the list either'))
  assert.ok(flatText(doc.export).includes('run *Token Pace: Disconnect Claude Status Line* first'))
  assert.ok(doc.commands.includes('and so does the status-line bridge\'s script `statusline-bridge.js` while the status line is connected'))
  assert.ok(flatText(doc.quotaSources).includes('What 1.8 does not move is a Token Pace command it has no record of'))
  // The Opus 5.5 row's own check day, where the numbers table dates the price table.
  // 1.11 P9 (pinned and changed — P5's spec error 1: the row carried both ISO days, so a re-check of the table touched
  // this page too): the row names no day and points to cost.md, where the days are held to the constants (C5 rule 3).
  const costRow = doc.numbers.split('\n').find((l) => l.startsWith('| API cost |')) ?? ''
  assert.ok(costRow.includes('[The “API cost” column](cost.md)') && costRow.includes('`Prices as of <day>; checked later: <model> (<day>).`'), costRow)
  assert.equal(/\d{4}-\d{2}-\d{2}/.test(costRow), false, 'docs/numbers.md\'s API-cost row carries a date')
  // The README: the features 1.8 added, the index row, the fourth picture; the walkthrough's entry.
  const readme = flatText(README)
  for (const claim of ['**A prompt cache that says when it cools.**', '**Keep-warm, opt-in and off by default.**', '`$(watch) cache 4m`',
    '`~until 14:52, perhaps longer`', 'A draft left in Claude Code\'s input line is sent along', '(docs/prompt-cache.md#keep-warm-in-a-terminal-opt-in)',
    'the opt-in keep-warm line with every check it makes and what it cannot see']) {
    assert.ok(readme.includes(claim), `the README does not say: ${claim}`)
  }
  assert.match(README, /!\[The Claude quota card with its prompt-cache block[^\]]*\]\(media\/screenshot-prompt-cache\.png\)/)
  assert.ok(existsSync(join(ROOT, 'media/screenshot-prompt-cache.png')), 'the README embeds a picture that is not there')
  const bar = flatText(readDoc('media/walkthrough/status-bar.md'))
  assert.ok(bar.includes('`cache` — off by default as well — adds `$(watch) cache 4m`') && bar.includes('`$(watch) keep warm in 42 s · cancel`'))
  assert.ok(flatText(readDoc('media/walkthrough/quota.md')).includes('which keeps only the fields Token Pace reads'))
})

// ---------------------------------------------------------------------------
// 1.9 P3 (§3 A7, B4): docs/languages.md and the Translating section of docs/development.md
// ---------------------------------------------------------------------------

/** The country each flag of the registry is — the table's fourth column names it beside the flag's id. */
const FLAG_COUNTRY: Record<string, string> = {
  us: 'United States', de: 'Germany', fr: 'France', es: 'Spain', br: 'Brazil', it: 'Italy', jp: 'Japan', kr: 'South Korea',
  cn: 'China', tw: 'Taiwan', ru: 'Russia', tr: 'Türkiye', pl: 'Poland', cz: 'Czechia',
  // 1.11 P9 (Review 1 F1): the twelve of tier 2.
  nl: 'Netherlands', ua: 'Ukraine', se: 'Sweden', no: 'Norway', dk: 'Denmark', fi: 'Finland', in: 'India', id: 'Indonesia',
  vn: 'Vietnam', gr: 'Greece', hu: 'Hungary', ro: 'Romania',
}

/** The seam is module state: a test that installs a locale or a bundle puts it back. */
function underLocale<T>(tag: string | undefined, run: () => T): T {
  try {
    setBundle(undefined)
    setLocale(tag)
    return run()
  } finally {
    setBundle(undefined)
    setLocale(undefined)
  }
}

test('docs/languages.md: one row per registry entry — its id, its native name, its name in English, its flag — in the registry\'s order (1.9 A7)', () => {
  const rows = doc.languages.split('\n').filter((l) => /^\| `[a-z-]+` \|/.test(l))
  // 1.11 P9 (pinned and changed — Review 1 F1: the test tolerated 14–26 rows with every bundle present): the table lists
  // the whole registry, one row per entry, strictly, and a fifth column says since when — English from the first release,
  // German since 1.3.0 (every text; the settings since 1.2.0), the twelve of 1.9 and, marked as new, the twelve of 1.11
  // (§3 A6). Every language listed ships its bundle: the picker offers no other.
  const { availableLanguages } = require('../src/languageLoad') as typeof import('../src/languageLoad')
  const shipped = availableLanguages(join(ROOT, 'l10n'))
  const since = (i: number): string => (i === 0 ? '1.0.0' : i === 1 ? '1.3.0' : i < 14 ? '1.9.0' : '**new in 1.11.0**')
  const want = underLocale(undefined, () => LANGUAGES.map((e, i) => `| \`${e.id}\` | ${e.native} | ${languageName(e.id)} | ${FLAG_COUNTRY[e.flag]} (\`${e.flag}\`) | ${since(i)} |`))
  assert.equal(rows.length, LANGUAGES.length, `${rows.length} rows for ${LANGUAGES.length} languages`)
  assert.deepEqual(rows, want)
  assert.deepEqual(LANGUAGES.filter((e) => !shipped.includes(e.id)).map((e) => e.id), [], 'the table names a language the picker does not offer')
  assert.equal(rows.filter((r) => r.endsWith('| **new in 1.11.0** |')).length, 12)
  assert.ok(doc.languages.includes('| Id | Language | In English | Flag | Since |'))
  // The flags the page explains are the registry's.
  const flag = (id: string): string => LANGUAGES.find((e) => e.id === id)?.flag ?? '?'
  assert.deepEqual(['en', 'es', 'pt-br', 'zh-cn', 'zh-tw'].map(flag), ['us', 'es', 'br', 'cn', 'tw'])
  const page = flatText(doc.languages)
  for (const claim of ['**A flag is not a language.**', 'English carries the US flag because the author chose it',
    'so the list calls it *English*, not *English (US)*', 'Spanish carries Spain\'s, Brazilian Portuguese Brazil\'s, and the two Chinese entries carry China\'s and Taiwan\'s',
    'Windows\' emoji font draws no flags', 'in a High Contrast theme they keep their colours and get an outline',
    'The picker offers the languages whose translation file the installed build carries.']) {
    assert.ok(page.includes(claim), `docs/languages.md does not say: ${claim}`)
  }
})

test('docs/languages.md: the picker, the setting and `auto` as the code has them — the rule stated by its own examples (1.9 A1–A3)', () => {
  const page = flatText(doc.languages)
  for (const claim of [
    'at its end, a button with the flag of the language the texts are in now: the US flag for English',
    '*Automatic* first, then every language this build ships a translation for, in the order of the table below',
    'where the two differ — its name in the language you read now (*Deutsch* · German)',
    '*Automatic — as VS Code (English)*', '*Automatic — VS Code\'s language (bg) has no translation here, so English*',
    'In the list ↓ and ↑ move (from the last line to the first and back), Home and End go to the first and the last, Enter or Space chooses, Escape closes it and puts the focus back on the flag, Tab closes it without a choice. Nothing is chosen by moving.',
    'a menu button named "Language: English (automatic)" — "Language: English" once you chose English —',
    'A choice writes `tokenPace.language` into your user settings', 'the setting has application scope',
    '*Automatic* removes the key again; the line that is already chosen writes nothing',
    'any other value (another case, a path) counts as `auto`, and the log says so',
    '`de-ch` becomes `de`', '`pt-pt` therefore gets English: Token Pace has Brazilian Portuguese, `pt-br`, but no `pt`',
    // 1.9 P20 (pinned and changed: "a Swiss German window keeps Swiss number formats …"): VS Code 1.138 hands a
    // regional display language over as its pack's language (§7a probe: --locale=de-ch → env.language de), so no
    // Swiss German window reaches the formatters as de-ch; the page says what VS Code reports instead.
    'Under `auto` the numbers and dates follow the tag VS Code reports, as they did before 1.9: a display language Token Pace has no translation for keeps its own number and date formats, with English words.',
  ]) assert.ok(page.includes(claim), `docs/languages.md does not say: ${claim}`)
  // The examples are the rule's own answers. 1.11 lead fix after P2 (pinned and changed: the `hu` example): Hungarian is
  // a language of the registry since 1.11, so the page's example of a display language without a translation is `bg`
  // (Bulgarian — a VS Code language pack Token Pace has no translation for and does not plan one).
  assert.equal(autoLanguage('de-ch', LANGUAGE_IDS), 'de')
  assert.equal(autoLanguage('pt-pt', LANGUAGE_IDS), 'en')
  const bg = resolveLanguage('auto', 'bg', LANGUAGE_IDS)
  assert.deepEqual([bg.id, bg.intl, bg.auto?.shipped], ['en', 'bg', false])
  assert.equal(resolveLanguage('auto', 'de-ch', LANGUAGE_IDS).intl, 'de-ch')
  // The words the page quotes are the view model's keys.
  const vm = readDoc('src/viewModel.ts')
  for (const key of ["'Automatic — as VS Code ({0})'", "\"Automatic — VS Code's language ({0}) has no translation here, so English\"",
    "'Language: {0} (automatic)'", "'Language: {0}'"]) {
    assert.ok(vm.includes(`t(${key}`), `src/viewModel.ts no longer writes ${key}`)
  }
  // The setting the page names, as the manifest declares it.
  assert.equal(properties['tokenPace.language'].default, 'auto')
  assert.deepEqual(properties['tokenPace.language'].enum, ['auto', ...LANGUAGE_IDS])
})

test('docs/languages.md: what switches at once and what cannot — the manifest sentence, what is open, the failed attempt\'s words, what stays English (1.9 A2 rule 5, A4, §3.0 d–f)', () => {
  const page = flatText(doc.languages)
  for (const claim of [
    '**At once, without a reload**: the dashboard — every section, the provider switch, the picker, the page\'s own words, its numbers and dates — keeping its scroll position',
    'the status bar\'s texts, tooltips and accessible names, the keep-warm countdown among them',
    'the markdown document and the agent hook\'s setup document while they are open',
    'and from then on every Quick Pick, notification, dialog and consent text',
    'The settings UI, the command titles in the Command Palette, the view\'s and its container\'s names, the walkthrough\'s titles and the Extensions view\'s name and description follow VS Code\'s display language',
    'VS Code reads them from `package.nls.<language>.json` when it starts and offers an extension no way to have them read again',
    'So with VS Code in German and the picker on Français, the settings are German and everything Token Pace draws is French.',
    '*Configure Display Language* — which restarts VS Code — changes them',
    'The walkthrough\'s three step pages are English in every language.',
    'A Quick Pick, a modal dialog or a notification keeps the language it was opened in until it closes',
    'it stays in that language until the next attempt', 'Every reading that can be made again is made again at the switch.',
    'the debug log, the diagnostics report and the CSV and JSON exports',
    'the keep-warm line and the terms passage the keep-warm consent quotes',
  ]) assert.ok(page.includes(claim), `docs/languages.md does not say: ${claim}`)
  // Three step pages, and no translated copy of one.
  const steps = readdirSync(join(ROOT, 'media/walkthrough')).filter((f) => f.endsWith('.md'))
  assert.equal(steps.length, 3)
  assert.equal(steps.some((f) => /\.[a-z]{2}(-[a-z]+)?\.md$/.test(f)), false)
})

test('docs/languages.md: the notation that stays the same in every language is what the functions print, and German, Japanese and French format as the page says (1.9 A5)', () => {
  const T0 = Date.UTC(2026, 8, 1, 12, 0, 0)
  const MIN = 60_000
  const page = flatText(doc.languages)
  const forms = underLocale(undefined, () => ({
    m45: relativeShort(T0 + 45 * MIN, T0), h2m14: relativeShort(T0 + 134 * MIN, T0), d3h5: relativeShort(T0 + 77 * 60 * MIN, T0),
    lt1: relativeShort(T0 + 30_000, T0), cd: countdownText(250_000),
    in214: relativeTime(T0 + 134 * MIN, T0), in3d5h: relativeTime(T0 + 77 * 60 * MIN, T0), ago3: relativeTime(T0 - 3 * MIN, T0), in12: relativeTime(T0 + 12 * MIN, T0),
    cent: usd(0.004), dollars: usd(12.5), k: compact(12_500), m: compact(2_800_000), g: compact(3_200_000_000),
    day: dayOf(T0, { zone: 'utc', dayBoundaryHour: 0, startOfWeek: 'monday', hourCycle: 'h23' }),
  }))
  assert.deepEqual([forms.m45, forms.h2m14, forms.d3h5, forms.lt1, forms.cd], ['45m', '2h14m', '3d 5h', '<1m', '4 m 10 s'])
  assert.deepEqual([forms.in214, forms.in3d5h, forms.ago3, forms.in12], ['in 2 h 14 min', 'in 3 d 5 h', '3 min ago', 'in 12 min'])
  assert.deepEqual([forms.cent, forms.dollars.startsWith('$'), forms.k, forms.m, forms.g], ['<$0.01', true, '12.5K', '2.8M', '3.2G'])
  assert.equal(forms.day, '2026-09-01')
  assert.ok(page.includes('the countdowns `45m`, `2h14m`, `3d 5h`, `<1m` and `4 m 10 s`; the units inside `2 h 14 min`, `3 d 5 h` and `12 min` (the words around them are translated: *3 min ago*, *in 2 h 14 min*); the suffixes `K`, `M` and `G`; the `$` in front of an amount and `<$0.01`; the `%` in the bar; the bar\'s glyphs (`█┃▁`, `▲`, `Σ`) and the codicons; the ISO day `2026-09-01`; `1 h TTL`; and the marks `~` (an estimate), `⚠` and `≈` (a lower bound) and `–` (nothing known)'),
    'docs/languages.md does not list the fixed notation as the code has it')
  // `1 h TTL` is kept by the German too, where the watch writes it.
  assert.ok(GERMAN['{0} · prompt cache cools in {1} (1 h TTL)'].includes('1 h TTL'))
  // The formats the page names.
  assert.deepEqual(underLocale('de', () => [compact(2_800_000), full(1_234_567)]), ['2,8M', '1.234.567'])
  for (const tag of ['ja', 'zh-CN', 'zh-TW']) assert.deepEqual(underLocale(tag, () => [compact(2_800_000), full(1_234_567)]), ['2.8M', '1,234,567'], tag)
  const fr = underLocale('fr', () => [compact(2_800_000), full(1_234_567)])
  assert.equal(fr[0], '2,8M')
  assert.match(fr[1], /^1[   ]234[   ]567$/, 'French groups thousands with a space')
  assert.ok(page.includes('German writes `2,8M` and `1.234.567`, French groups thousands with a narrow space and writes a decimal comma, Japanese and Chinese write `2.8M` and `1,234,567` as English does'))
})

test('docs/languages.md: the translation statement says who translated, from what, what was checked and that no native speaker reviewed it — and claims nothing more (1.9 B4)', () => {
  const page = flatText(doc.languages)
  for (const claim of [
    // 1.11 P9 (pinned and changed: "The twelve languages beyond English and German"): the twelve of 1.9, named.
    'The twelve languages of 1.9.0 — Français, Español, Português (Brasil), Italiano, 日本語, 한국어, 简体中文, 繁體中文, Русский, Türkçe, Polski and Čeština — were translated by AI agents (Claude Opus 5.5) from the English text, with the German as a second reference',
    'checked by tests for completeness, placeholders and the marks `~`, `⚠`, `≈` and `–` — they were **not reviewed by native speakers**',
    'they cannot tell a good word from a clumsy one',
    'A wrong or clumsy word is a bug — please report it on the [issue tracker](https://github.com/mfvdp/VS-Code_Token-Usage/issues), with the language, the text you saw and where you saw it',
  ]) assert.ok(page.includes(claim), `docs/languages.md does not say: ${claim}`)
  // The address is the manifest's own.
  assert.equal((JSON.parse(readDoc('package.json')) as { bugs: { url: string } }).bugs.url, 'https://github.com/mfvdp/VS-Code_Token-Usage/issues')
  // No claim beyond the tests: not professional, not reviewed, not native, and nothing new about German.
  const rest = page.replace(/not reviewed by native speakers/g, '')
  for (const never of [/review/i, /professional/i, /native[- ]quality/i, /proofread/i, /certified/i, /fluent/i, /lektor/i]) {
    assert.equal(never.test(rest), false, `docs/languages.md says ${never}`)
  }
  // The setting's description says the same, in both languages (P1's words).
  assert.ok(nlsEn['config.language.description'].includes('not by native speakers'))
  assert.ok(nlsDe['config.language.description'].includes('Muttersprachler haben sie nicht geprüft'))
})

test('docs/development.md says how a language is made and checked: the registry, the parts, the two scripts, the record, the fifteen rules, the freeze (1.9 P3; 1.10 P21: fifteen)', () => {
  const dev = flatText(doc.development)
  for (const claim of [
    '## Translating', '`src/languages.ts` (`LANGUAGES`: the id, the `Intl` locale, the native name and the flag, in the picker\'s order)',
    '`l10n/parts/<part>.<id>.json` — the runtime translations in four parts, `dashboard`, `host`, `model` and `text`, each with exactly the keys of the German part of the same name',
    '`l10n/bundle.l10n.<id>.json` — what the extension reads, generated from the parts by `node scripts/merge-l10n.mjs`',
    '`package.nls.<id>.json` — the manifest\'s words: every key of `package.nls.json`, in its order',
    '`l10n/nls-sources/<id>.json` — the freshness record: for every manifest key, the first 16 hex digits of the SHA-256 of the English it was translated from, written by `node scripts/nls-sources.mjs <id>`',
    '`node scripts/nls-sources.mjs --check` names every language and key whose English changed since',
    // 1.10 P21 (pinned and changed: "thirteen rules, T1–T13"): T14 (the pending lists) and T15 (the bar's examples) joined in 1.10.
    '`test/l10n.languages.test.ts` holds every language on disk to the same fifteen rules, T1–T15',
    'the list `SAME_IN_EVERY_LANGUAGE` in the test, each word with its reason',
    'the German under another id, and the English with every word turned into 語',
    'The brief a translation works from is `l10n/TRANSLATING.md`',
    '`.vscodeignore` keeps `l10n/parts/`, `l10n/nls-sources/` and the brief out of the package',
    'While translations are being made, the English is frozen',
    'the dashboard harness (a `main-<id>` page in both themes at 260 and 420 px)',
  ]) assert.ok(dev.includes(claim), `docs/development.md does not say: ${claim}`)
  // The record is what the page says it is: the first 16 hex digits of the English's SHA-256.
  const record = JSON.parse(readDoc('l10n/nls-sources/de.json')) as Record<string, string>
  assert.equal(record.displayName, createHash('sha256').update(nlsEn.displayName, 'utf8').digest('hex').slice(0, 16))
  // What ships and what does not.
  for (const path of ['l10n/TRANSLATING.md', 'l10n/nls-sources/de.json', 'l10n/parts/host.de.json']) assert.equal(shipped(path), false, `${path} would be packaged`)
  for (const path of ['l10n/bundle.l10n.de.json', 'package.nls.de.json', 'docs/languages.md']) assert.equal(shipped(path), true, `${path} would not be packaged`)
  // The README's index row, in the order the pages are read.
  // 1.11 P9 (pinned and changed: "the fourteen languages"): twenty-six.
  assert.ok(README.includes('| [Languages](docs/languages.md) | The language picker and `tokenPace.language`, what switches at once and what follows VS Code, the twenty-six languages and their flags, the notation that stays the same, and how the translations were made |'))
  assert.ok(doc.languages.includes('see [Building and testing](development.md#translating)'))
})

// ---------------------------------------------------------------------------
// 1.9 P16 (§3 C1, C2): the Performance bullet of the day memo and of the one empty options object
// ---------------------------------------------------------------------------

test('docs/development.md says how the day of an hour bucket is kept since 1.9, with the measured figures, and names what the code has (1.9 P16)', () => {
  const dev = flatText(doc.development)
  const perf = dev.slice(dev.indexOf('## Performance'))
  for (const claim of [
    '**The day an hour bucket falls on** per time zone and day boundary (`dayOfHourMemo` in `src/agg.ts`, `dayOfBucket` in `src/stats.ts`)',
    'Since 1.9 each memo keeps the zone and the boundary hour as two fields and compares them',
    '44 % of a build\'s CPU time in Europe/Berlin, 8 % in UTC; now 6 % in either',
    'over 5000 hours in ten zones at the boundary hours 0, 4 and 23',
    'a build now takes a median 26 ms instead of 49 in Europe/Berlin and 26 instead of 31 in UTC',
    'priced through one frozen empty options object (`NO_PRICING`), not a new one per bucket',
  ]) assert.ok(perf.includes(claim), `docs/development.md's Performance section does not say: ${claim}`)
  // What the bullet names is in the code, and the key string it says is gone is gone from both memos.
  const agg = readDoc('src/agg.ts')
  const stats = readDoc('src/stats.ts')
  assert.ok(agg.includes('private dayOfHourMemo(') && stats.includes('export function dayOfBucket('))
  assert.ok(agg.includes('const NO_PRICING: PricingOptions = Object.freeze({})') && agg.includes('pricing ?? NO_PRICING'))
  assert.equal(/\$\{t?cfg\.zone\}\|\$\{t?cfg\.dayBoundaryHour\}/.test(agg + stats), false, 'a key string of the zone and the boundary is built again')
  // 1.8's figures stay as 1.8 measured them.
  assert.ok(dev.includes('a build took a median 36 ms instead of 53 in UTC (55 instead of 73 in Europe/Berlin)'))
})

/**
 * 1.9 P17 (§3 D rule 4–5, §0a.1 "Docs"): the G13 bound in reader words where a reader looks for it — the
 * prompt-cache page's check 13 and its constants table (the number from src/keepWarm.ts), the
 * troubleshooting entry of `otherSession`, the privacy page's sentence on the one new kept fact and the
 * estimate section's paragraph on it, and the revision 10 replay on the counting and agents pages.
 */
test('the pages state the keep-warm G13 bound as src/keepWarm.ts has it, the time of a user line as the aggregator keeps it, and revision 10 (1.9 P17)', () => {
  const kw = require('../src/keepWarm') as typeof import('../src/keepWarm')
  const { USER_LINE_TIME_RE } = require('../src/agg') as typeof import('../src/agg')
  const page = doc.promptCache
  const head = '\n## Keep-warm in a terminal (opt-in)\n'
  const from = page.indexOf(head)
  assert.ok(from >= 0, 'docs/prompt-cache.md has no keep-warm section')
  const section = page.slice(from, page.indexOf('\n## ', from + head.length))
  const hours = kw.KEEPWARM_SIBLING_LEFT_MS / 3_600_000
  assert.equal(kw.KEEPWARM_SIBLING_LEFT_MS, 2 * 3_600_000, '"the two hours" in words on the page')
  assert.ok(section.includes(`| \`KEEPWARM_SIBLING_LEFT_MS\` | ${hours} hours |`), 'the keep-warm section does not state KEEPWARM_SIBLING_LEFT_MS')
  const text = flatText(section)
  for (const claim of [
    `no agent of it running, and its newest line at least ${hours} hours old and older than the moment the terminal's \`claude\` started`,
    'a prompt that never got its reply, an interrupted reply, a window closed mid-turn',
    'In 1.8 such a session held the folder back for as long as its transcript was kept, seven days.',
    'That is an inference, not a rule Claude Code documents, and the two hours stand behind it',
    'a session that wrote a line in the last two hours is never passed over',
    'Its newest line is the later of its newest reply and its newest `user` line; when the user\'s line is the newest and its time is not known, the session is not passed over.',
    'is idle by check 13\'s measure or left behind by it',
  ]) assert.ok(text.includes(claim), `the keep-warm section does not say: ${claim}`)
  // The estimate section: the one new fact, how it is matched, the latest of a line, never shown.
  const pc = flatText(page)
  for (const claim of [
    'Since 1.9 one more fact is kept, for the keep-warm line\'s check of the other sessions of a folder (check 13) and nothing else',
    'its top-level `timestamp`, matched on the raw line, which is never parsed for it',
    'of several on one line (a tool\'s result nests some) the latest counts, so a nested one can only make the session look newer, never older',
    'and the time is never shown, logged or exported', 'Apart from that one `timestamp`, no field is read for any of it',
  ]) assert.ok(pc.includes(claim), `docs/prompt-cache.md does not say: ${claim}`)
  // The key the pages quote is the one the aggregator matches.
  assert.ok(USER_LINE_TIME_RE.source.startsWith('"timestamp":"') && USER_LINE_TIME_RE.source.endsWith('Z)"'), USER_LINE_TIME_RE.source)
  for (const [name, text2] of [['docs/prompt-cache.md', pc], ['docs/privacy.md', flatText(doc.privacy)]] as const) {
    assert.ok(text2.includes('`"timestamp":"…Z"`'), `${name} does not quote the key the raw line is matched on`)
  }
  assert.ok(flatText(doc.privacy).includes('Since 1.9 the record also keeps the time of the newest line of the transcript that is yours or a tool\'s (a `user` line) — its `timestamp`, matched on the raw line'),
    'docs/privacy.md does not name the time of a user line')
  // 1.10 P4 (pinned and changed): the two facts and the time of a user line serve the Prompts section's question too (§0a.5).
  for (const claim of ['nothing else of that line is read —, for the keep-warm line\'s check of other sessions of the same folder',
    'Those two facts serve the checks of the opt-in [keep-warm line](prompt-cache.md#keep-warm-in-a-terminal-opt-in)',
    'where one that has been left behind no longer holds the line back — and, since 1.10, for the same question of the Prompts section']) {
    assert.ok(flatText(doc.privacy).includes(claim), `docs/privacy.md does not say: ${claim}`)
  }
  // Troubleshooting: the otherSession entry says when a session stops holding the line back.
  const why = flatText(doc.troubleshooting)
  for (const claim of [
    `or until it has been left behind: no agent of it running, and its newest line at least ${hours} hours old and older than the moment this terminal's \`claude\` started`,
    'In 1.8 such a session held the line back for as long as its transcript was kept, seven days.',
  ]) assert.ok(why.includes(claim), `docs/troubleshooting.md does not say: ${claim}`)
  // The revision 10 replay, and why.
  assert.equal(AGENT_TABLES_REVISION, 10)
  assert.ok(flatText(doc.counting).includes(`— ${AGENT_TABLES_REVISION} in 1.9.0, 9 in 1.8.0, 8 in 1.6.0 and 1.7.0 —`), 'docs/counting.md does not state 1.9.0\'s revision')
  assert.ok(flatText(doc.counting).includes(`1.9.0 raised it to ${AGENT_TABLES_REVISION} for the [keep-warm line](prompt-cache.md#keep-warm-in-a-terminal-opt-in)'s check of the other sessions of a folder`),
    'docs/counting.md does not say why 1.9.0 raised the revision')
  assert.ok(flatText(doc.counting).includes('so that a session left behind before the update stops holding the line back at once'))
  assert.ok(flatText(doc.agents).includes(`revision **${AGENT_TABLES_REVISION}** in 1.9.0, revision **9** in 1.8.0`), 'docs/agents.md does not state 1.9.0\'s revision')
  assert.ok(flatText(doc.agents).includes('1.9.0 did, for the time of each main session\'s newest `user` line'))
})

// ---------------------------------------------------------------------------
// 1.9 P20 (§4 P20, §3 A7, B4, D; Review 2's docs sentences): the documentation of 1.9.0, complete —
// every item of §1 where a reader looks for it, the release notes, the quality statement in its four
// places, the old claims gone, and the German counterpart of every interface text the pages quote.
// ---------------------------------------------------------------------------

/** 2026-09-28 is a Monday; `day` days on, 06:00 UTC. */
const MONDAY_0600 = (day = 0): number => Date.UTC(2026, 8, 28 + day, 6, 0)
const UTC_TIME: TimeConfig = { zone: 'utc', dayBoundaryHour: 0, startOfWeek: 'monday', hourCycle: 'h23' }

/** 1.8's day label — weekday, day and month out of formatToParts, the literals dropped — for the release notes' "before". */
function dayLabel18(tag: string, ms: number): string {
  const parts = new Intl.DateTimeFormat(tag, { timeZone: 'UTC', weekday: 'short', day: 'numeric', month: 'short' }).formatToParts(ms)
  const part = (type: string): string => parts.find((p) => p.type === type)?.value ?? ''
  return `${part('weekday')} ${part('day')} ${part('month')}`
}

test('the 1.9.0 release notes: its date set at publish, every section in order, the plain statement, the versions and figures the code has, nothing unverified (1.9 P20)', () => {
  const kw = require('../src/keepWarm') as typeof import('../src/keepWarm')
  const { formatDay, formatTime } = require('../src/time') as typeof import('../src/time')
  const log = readDoc('CHANGELOG.md')
  // 1.10 P21 (pinned and changed: "the newest CHANGELOG entry is 1.9.0"): 1.10.0 stands above it now, so the
  // entry is found by its heading; its date is still the publish's.
  const first = log.indexOf('\n## 1.9.0 ')
  assert.ok(first >= 0, 'the CHANGELOG has no 1.9.0 entry')
  const second = log.indexOf('\n## ', first + 4)
  const entry = log.slice(first, second)
  // The release cadence: the date is set on the release branch at publish, never before.
  assert.match(entry, /^\n## 1\.9\.0 — <date set at publish>\n\n\*\*/, 'the 1.9.0 CHANGELOG entry does not keep its date for the publish, or does not open with its summary')
  const flat = flatText(entry)
  const heads = ['### Added', '### Changed', '### Fixed', '### Privacy', '### Internal']
  const order = heads.map((h) => flat.indexOf(h))
  assert.ok(order.every((i) => i > 0) && order.every((i, k) => k === 0 || i > order[k - 1]), 'the 1.9.0 entry\'s sections are missing or out of order')
  const section = (h: string): string => { const at = heads.indexOf(h); return flat.slice(order[at], at + 1 < heads.length ? order[at + 1] : undefined) }
  // The twelve languages, named in their own names in the registry's order — in the summary and in Added. 1.11 P2
  // (pinned and changed: every language of the registry but English and German): the twelve of 1.9 are the registry's
  // first fourteen but English and German; 1.11's twelve follow them.
  const twelve = LANGUAGES.slice(0, 14).filter((e) => e.id !== 'en' && e.id !== 'de').map((e) => e.native)
  assert.equal(twelve.length, 12)
  const named = `${twelve.slice(0, -1).join(', ')} and ${twelve[twelve.length - 1]}`
  assert.equal(flat.split(named).length - 1, 2, `the 1.9.0 entry does not name the twelve languages twice as the registry has them: ${named}`)
  const hours = kw.KEEPWARM_SIBLING_LEFT_MS / 3_600_000
  for (const claim of [
    // Added: the picker, the twelve languages with the plain statement, the setting.
    '**The language picker.**', 'beside `Claude Code · Codex · All`', 'the US flag for English', '`Automatic — as VS Code (English)` first',
    '(`Deutsch · German`); the chosen line carries a ✓', 'nothing is chosen by moving', '`Language: English (automatic)`',
    'the page keeps its scroll position and the focus goes back to the flag',
    '`Token Pace\'s own texts switch at once. The settings, the command titles and the walkthrough follow VS Code\'s display language (Configure Display Language).`',
    'in a High Contrast theme they keep their colours and get an outline',
    '**They were translated by AI agents from the English text, with the German as a second reference, and checked by tests for completeness, placeholders and the marks `~`, `⚠`, `≈` and `–` — they were not reviewed by native speakers.**',
    'A wrong or clumsy word is a bug — please report it on the [issue tracker](https://github.com/mfvdp/VS-Code_Token-Usage/issues)',
    `or one of ${LANGUAGE_IDS.slice(0, 14).map((id) => `\`${id}\``).join(', ')}, which the settings UI offers by each language's own name`,
    'It has the application scope: always your user settings, never a workspace\'s',
    'VS Code reports its display language only while that language\'s pack is installed',
    // Changed: the weekday, the diagnostics line.
    '(`lun.`, `pon.`, `Pzt`, `seg.`, `月`, `周一`)', 'which turned Polish `pon.` into the word `po`', 'English and German keep their two letters, `Mo 06:00`',
    '`setting auto · shown de · VS Code de`',
    // Fixed: the day label, the Brazilian weekdays, the page's lang, the calibration, Review 2's (c) word for word.
    '`土 26 9`, `周六 26 9` or `so 26 9`', '`9月26日(土)`, `9月26日周六`, `so 26. 9.`',
    'read `se` for both Monday and Friday and `qu` for both Wednesday and Thursday', '(`lang="fr"`)', '(`pt-BR`, `zh-CN`, `zh-TW`)',
    `The keep-warm line is no longer held back by another session of the same folder that was left behind — its newest line at least ${hours} hours old and older than the moment the terminal's \`claude\` started (a prompt that never got its reply, an interrupted reply, a window closed mid-turn). In 1.8 such a session held the line back for as long as its transcript was kept, up to seven days.`,
    // Privacy: Review 2's (d) word for word, the setting write, the bundle read.
    'One more field of a Claude Code transcript is read**: the `timestamp` of a `user` line of a main transcript, matched on the raw line as the unescaped key `"timestamp":"…Z"` — the latest on the line; the line is never parsed for it. Kept: the newest such time, one number per main session, in the token snapshot for seven days, used only by the keep-warm line\'s check of the other sessions of a folder; never shown, logged or exported.',
    '**One setting is written for you**: `tokenPace.language`', '`l10n/bundle.l10n.<language>.json`',
    // Internal: the versions, Review 2's (e), L-7 with development.md's figures, L-8, the reset line, the frame, H-1, C-1, the contract.
    // 1.11 P5 (pinned and changed, §3 C4 rule 4): the schema version 1.9.0 shipped, 3 — the code's is 4 since.
    `\`STATE_VERSION\` ${STATE_VERSION} and the export's \`schema_version\` ${RELEASED_1_10.EXPORT_SCHEMA_VERSION} (\`EXPORT_SCHEMA_VERSION\` ${RELEASED_1_10.EXPORT_SCHEMA_VERSION}) are unchanged; \`AGENT_TABLES_REVISION\` ${RELEASED_1_8_REVISION} → ${AGENT_TABLES_REVISION}`,
    `The first start of 1.9.0 rebuilds the agent tables once (revision ${AGENT_TABLES_REVISION}), so sessions already read have that time at once; nothing is counted again and the snapshot schema stays ${STATE_VERSION}.`,
    'a view-model build took a median 26 ms instead of 49 in Europe/Berlin and 26 instead of 31 in UTC, measured on the developer\'s machine — a measurement, not a promise',
    'A cost series asked for without pricing is priced through one shared empty options object.',
    'so nothing on screen changes', 'the first 16 hex digits of the SHA-256 of the English it was translated from',
    'feeds each page what the extension pushes', 'the built extension is the same', '(`USER_LINE_TIME_RE`)',
  ]) assert.ok(flat.includes(claim), `the 1.9.0 entry does not say: ${claim}`)
  // The figure is development.md's, measured there — not §7c's profiler run.
  assert.ok(flatText(doc.development).includes('a build now takes a median 26 ms instead of 49 in Europe/Berlin and 26 instead of 31 in UTC'))
  assert.equal(/46 ms|22 ms|46 → 22/.test(flat), false, 'the 1.9.0 entry quotes the profiler\'s figure, not development.md\'s')
  // The versions it names are the code's; the snapshot schema and the export stay. 1.11 P5 (pinned and changed, §3 C4
  // rule 4): the export's as 1.9.0 shipped it, 3 — the code's is the one after it.
  assert.deepEqual([STATE_VERSION, RELEASED_1_10.EXPORT_SCHEMA_VERSION, AGENT_TABLES_REVISION], [8, 3, 10])
  for (const m of flat.matchAll(/`(STATE_VERSION|EXPORT_SCHEMA_VERSION)` (\d+)/g)) {
    assert.equal(Number(m[2]), m[1] === 'STATE_VERSION' ? STATE_VERSION : RELEASED_1_10.EXPORT_SCHEMA_VERSION, `the 1.9.0 entry says ${m[1]} ${m[2]}`)
  }
  // The examples are what the code prints: the weekday of each language, the day label 1.9 writes and the one 1.8 wrote.
  const weekday = (tag: string, day = 0): string => underLocale(tag, () => formatTime(MONDAY_0600(day), UTC_TIME, true).split(' ')[0])
  assert.deepEqual([['pl', 0], ['tr', 0], ['fr', 0], ['pt-BR', 0], ['ja', 0], ['zh-CN', 0], ['en', 0], ['de', 0]].map(([tag, d]) => weekday(tag as string, d as number)),
    ['pon.', 'Pzt', 'lun.', 'seg.', '月', '周一', 'Mo', 'Mo'])
  const sat = Date.UTC(2026, 8, 26, 12)
  assert.deepEqual(['ja', 'zh-CN', 'cs'].map((tag) => underLocale(tag, () => formatDay(sat, UTC_TIME))), ['9月26日(土)', '9月26日周六', 'so 26. 9.'])
  assert.deepEqual(['ja', 'zh-CN', 'cs'].map((tag) => dayLabel18(tag, sat)), ['土 26 9', '周六 26 9', 'so 26 9'])
  const two = (day: number): string => new Intl.DateTimeFormat('pt-BR', { timeZone: 'UTC', weekday: 'short' }).format(MONDAY_0600(day)).slice(0, 2)
  assert.deepEqual([two(0), two(4), two(2), two(3)], ['se', 'se', 'qu', 'qu'], '1.8\'s two letters of Brazilian Portuguese')
  assert.deepEqual([weekday('pt-BR', 0), weekday('pt-BR', 4), weekday('pt-BR', 2), weekday('pt-BR', 3)], ['seg.', 'sex.', 'qua.', 'qui.'])
  assert.equal(new Intl.DateTimeFormat('pl', { timeZone: 'UTC', weekday: 'short' }).format(MONDAY_0600()).slice(0, 2), 'po')
  // The diagnostics line is the report's own.
  assert.ok(readDoc('src/diagnostics.ts').includes("row('Language', `setting ${tagOf(language.setting)} · shown ${tagOf(language.shown)} · VS Code ${tagOf(language.vscode)}`)"))
  // Claims the package could not verify, or that the notes forbid, are not made: no visible "resets at" fix
  // (no clock time reaches that line today), no Swiss German change (VS Code 1.138 already reports `de` for
  // it), never the unqualified "an abandoned session no longer blocks the line".
  assert.equal(section('### Fixed').includes('resets at'), false, 'the 1.9.0 entry claims a visible "resets at" fix')
  for (const never of [/Swiss/i, /de-ch/i, /abandoned session no longer blocks/i, /professional/i, /native[- ]quality/i, /proofread/i, /certified/i, /fluent/i]) {
    assert.equal(never.test(entry), false, `the 1.9.0 entry says ${never}`)
  }
  assert.equal(/review/i.test(flat.replace(/not reviewed by native speakers/g, '')), false, 'the 1.9.0 entry claims a review')
  // A store page: no path of the machine it was built on, no internal file, no secret, no package version talk.
  for (const never of [/\/home\//, /plan-1\.\d/, /p1\d-input/, /\.claude\/projects/, /VSCE_PAT|OVSX_PAT/, /research\//, /[A-Za-z]:\\/, /\/tmp\//, /package\.json/]) {
    assert.equal(never.test(entry), false, `the 1.9.0 entry mentions ${never}`)
  }
})

test('the quality statement stands in its four places and in the picker, says who translated from what, what the tests check, that no native speaker reviewed it — and claims nothing more (1.9 B4, P20)', () => {
  const statement = 'translated by AI agents'
  const places: Array<[string, string]> = [
    ['docs/languages.md', flatText(doc.languages)], ['README.md', flatText(README)],
    ['CHANGELOG.md 1.9.0', flatText(readDoc('CHANGELOG.md').split('\n## 1.8.0 ')[0])],
    ['package.nls.json config.language.description', nlsEn['config.language.description']],
  ]
  for (const [name, text] of places) {
    assert.ok(text.includes(statement) && /not (reviewed )?by native speakers/.test(text), `${name} does not carry the quality statement`)
    for (const never of [/professional/i, /native[- ]quality/i, /proofread/i, /certified/i, /fluent/i]) assert.equal(never.test(text), false, `${name} says ${never}`)
  }
  // 1.11 P9 (pinned and changed: "The twelve beyond"): twenty-four.
  assert.ok(flatText(README).includes('The twenty-four beyond English and German were translated by AI agents and checked by tests, not by native speakers.'))
  // The picker's line is the view model's, and the German says the same, as §3 A4 has it.
  const quality = 'The languages beyond English and German were translated by AI agents and checked by tests, not by native speakers.'
  assert.ok(readDoc('src/viewModel.ts').includes(`t('${quality}')`))
  assert.equal(GERMAN[quality], 'Die Sprachen über Englisch und Deutsch hinaus haben KI-Agenten übersetzt und Tests geprüft, keine Muttersprachler.')
  for (const [name, text] of [['docs/languages.md', doc.languages], ['docs/dashboard.md', doc.dashboard], ['CHANGELOG.md', readDoc('CHANGELOG.md')]] as const) {
    assert.ok(flatText(text).includes(quality) || name === 'CHANGELOG.md', `${name} does not quote the picker's line`)
  }
})

test('the pages say what 1.9 shipped where a reader looks: the picker, the setting and its one write, `auto` and the language packs, the manifest that cannot follow — and the old claims are gone (1.9 P20, §3 A7)', () => {
  // The old claims, gone from every page.
  for (const [name, text] of [['README.md', README], ...Object.entries(doc).map(([k, v]) => [`docs/${k}`, v])] as Array<[string, string]>) {
    const f = flatText(text)
    assert.equal(f.includes('every other display language gets English'), false, `${name} still says "every other display language gets English"`)
    assert.equal(f.includes('German or English'), false, `${name} still says "German or English"`)
  }
  assert.equal(/^\* \*\*English and German\.\*\*/m.test(README), false, 'README.md still heads its languages bullet "English and German."')
  // 1.11 P9 (pinned and changed: "Fourteen languages"): twenty-six.
  assert.ok(README.includes('* **Twenty-six languages.**') && flatText(README).includes('→ [Languages](docs/languages.md)'))
  assert.ok(README.includes('| [Dashboard](docs/dashboard.md) | The provider switch and the language picker,'))
  assert.ok(README.includes('| [Commands and keybindings](docs/commands.md) | The commands, the one chord, the interface language — a setting and a picker, not a command —, the walkthrough |'))
  // The README's privacy paragraph names the one write outside the storage 1.9 adds.
  assert.ok(flatText(README).includes('a language you pick in the dashboard goes into your user settings'))
  // dashboard.md: the picker in the top row, its menu and keys, the note and the quality line, the allow-list.
  const dash = flatText(doc.dashboard)
  for (const claim of [
    '**Language.** The flag at the end of the top row is the language picker — the US flag while the texts are English.',
    'In the menu `↓` and `↑` move, `Home` and `End` go to the first and the last line, `Enter` or `Space` chooses, `Escape` closes it and puts the focus back on the flag, and `Tab` leaves it without a choice.',
    'the page keeps its scroll position, the focus goes back to the flag, and the choice is written to `tokenPace.language` in your user settings',
    'The same row ends with the language picker\'s flag', 'and on the language picker\'s flag after a choice',
    'a language for the picker (`auto` or one of the twenty-six ids — the one setting the page can have written, `tokenPace.language`, in your user settings)',
    'never a path and never another setting',
  ]) assert.ok(dash.includes(claim), `docs/dashboard.md does not say: ${claim}`)
  // commands.md: no command; the setting and the picker; the manifest part kept.
  const cmds = flatText(doc.commands)
  for (const claim of ['**Interface language.** There is no command for it.', 'the flag at the top of the dashboard sets it for you',
    'follows VS Code\'s display language (*Configure Display Language*) instead, and does not switch with the picker',
    'falling back to English for any key a translation lacks']) {
    assert.ok(cmds.includes(claim), `docs/commands.md does not say: ${claim}`)
  }
  assert.equal(manifest.contributes.commands.some((c) => /language/i.test(c.command)), false, 'a language command exists after all')
  // settings.md: the row — application scope, the fifteen values, the one write and its warning.
  const row = doc.settings.split('\n').find((l) => l.startsWith('| `language` |')) ?? ''
  const warning = 'Token Pace: the language could not be written to your user settings.'
  // 1.11 P2 (pinned and changed: "the fifteen values", fifteen in the enum): the enum has auto and the twenty-six ids of
  // the registry now; the row's count is P9's to write (§3 A6).
  for (const claim of ['which VS Code reports only while its language pack is installed', 'The settings UI offers the twenty-seven values as a list, each language by its own name',
    'The twenty-four languages beyond English and German were translated by AI agents and checked by tests, not by native speakers.',
    'that is the one write Token Pace makes to your user settings for it: only on a choice, only this key, *Automatic* removing the key again, the language already chosen writing nothing',
    `the warning *${warning}* says so and nothing changes`, 'Application scope: always your user settings, never a workspace\'s']) {
    assert.ok(row.includes(claim), `docs/settings.md's language row does not say: ${claim}`)
  }
  assert.ok(row.includes(LANGUAGE_IDS.map((id) => `\`${id}\``).join(', ')), 'docs/settings.md\'s language row does not list the registry\'s ids in its order')
  assert.equal(properties['tokenPace.language'].enum?.length, LANGUAGES.length + 1)
  assert.deepEqual(properties['tokenPace.language'].enumDescriptions?.slice(1), LANGUAGES.map((e) => e.native))
  const ext = readDoc('src/extension.ts')
  assert.ok(ext.includes(`t('${warning}')`) && ext.includes(".update('language', id === 'auto' ? undefined : id, vscode.ConfigurationTarget.Global)"))
  assert.equal(GERMAN[warning], 'Token Pace: Die Sprache konnte nicht in Ihre Benutzereinstellungen geschrieben werden.')
  const scope = (readManifest<{ contributes: { configuration: Array<{ properties: Record<string, { scope?: string }> }> } }>()
    .contributes.configuration.find((c) => c.properties['tokenPace.language'])?.properties['tokenPace.language'].scope)
  assert.equal(scope, 'application')
  // privacy.md: the bundle read, the setting write and its warning, what is kept of the user line's time.
  const priv = flatText(doc.privacy)
  for (const claim of ['its own translation file for the language you chose (`l10n/bundle.l10n.<language>.json` inside the extension\'s folder',
    'And one setting of Token Pace\'s own is written for you (1.9): your user settings, when you choose a language in the dashboard (`tokenPace.language`)',
    'If VS Code cannot write your settings, one warning says so, the log names the kind of error, and nothing changes.',
    'What is kept of it is one number per main session, the newest such time — not the line\'s text, its id, or the object a nested time came from —, and it is never shown.']) {
    assert.ok(priv.includes(claim), `docs/privacy.md does not say: ${claim}`)
  }
  // languages.md: what VS Code reports, the focus, the twelve named as new, the formats.
  const lang = flatText(doc.languages)
  for (const claim of [
    'English and German, and since 1.9.0 twelve more',
    '**VS Code reports a display language only while its language pack is installed**',
    'a window started with `--locale=pt-br` and no Portuguese language pack reports `en`',
    'the picker needs no language pack', 'a window started with `--locale=de-ch` and the German pack reports `de` —, so a Swiss German window shows German',
    'keeping its scroll position and the keyboard focus',
    'After a choice the focus is back on the flag, which is then named in the new language; a switch made elsewhere — in the settings UI, or in another window — puts the focus back where it was on the page.',
    'A setting that names a language the installed build carries no translation file for shows English, and the list then checks no line.',
    `the other twelve — ${LANGUAGES.slice(0, 14).filter((e) => e.id !== 'en' && e.id !== 'de').map((e) => e.native).slice(0, -1).join(', ')} and Čeština — are new in 1.9.0`,
    'English and German keep their two letters (`Mo 06:00`, `Sa 14:20`)', '(`9月26日(土)`, `9月26日周六`, `so 26. 9.`)',
    'The calibration\'s figures take the language\'s decimal mark (`1,2` in German and French).',
    '*Token Pace\'s own texts switch at once. The settings, the command titles and the walkthrough follow VS Code\'s display language (Configure Display Language).*',
  ]) assert.ok(lang.includes(claim), `docs/languages.md does not say: ${claim}`)
  // The probe the page rests on is §7a's (VS Code without a pack reports `en`; `de-ch` arrives as `de`), and the
  // rule the code applies to what arrives: `de` is German, words and formats alike.
  const de = resolveLanguage('auto', 'de', LANGUAGE_IDS)
  assert.deepEqual([de.id, de.intl], ['de', 'de'])
  assert.deepEqual(underLocale('de', () => (1.2).toLocaleString('de', { minimumFractionDigits: 1, maximumFractionDigits: 1, useGrouping: false })), '1,2')
  assert.ok(readDoc('src/viewModel.ts').includes('n.toLocaleString(locale(), { minimumFractionDigits: 1, maximumFractionDigits: 1, useGrouping: false })'))
  // troubleshooting.md: the language section.
  const trouble = flatText(doc.troubleshooting)
  for (const claim of ['## The language', '**The dashboard is in another language than VS Code.**',
    '**`auto` shows English, though another display language is set.**', '**The settings and the command titles did not switch.**',
    '**One text stayed in the old language.**', `a warning said** *${warning}*`, '**The setting names a language, but the texts are not in it.**']) {
    assert.ok(trouble.includes(claim), `docs/troubleshooting.md does not say: ${claim}`)
  }
  // The log lines the entry points to are the host's.
  for (const line of ['Language: the setting is not one of the shipped languages; auto is used.', 'has no translation file in this build; English is shown.',
    'could not be read (${failure}); English is shown.', 'Language: the setting could not be written (${errorKind(err)}).']) {
    assert.ok(ext.includes(line), `src/extension.ts no longer logs: ${line}`)
  }
  // 1.10 B4, B5, B8 (P7): the decimals, the narrow width and the Turkish percent — a documented limit (§7a 14).
  for (const claim of [
    'Since 1.10 so does every other decimal the dashboard, the tooltips and the text views print — a key figure\'s change (`▼ -0,7%`), the plan factor (`×0,4`), a span under ten hours (`2,5 h`); the exports and the diagnostics report keep the `.`.',
    '**The percent follows the number in every language** — `25 %` in a sentence, `25%` in the status bar —, Turkish included, although Turkish typography and the Turkish number format put the sign first (`%25`): the Turkish translation keeps the English order in every string, for one style across the page, the bar and the texts. A known limit, not an oversight.',
    // 1.10 P21 (pinned and changed): the models' turn line joined the glued figures at the join. 1.11 P9 (pinned and
    // changed — Review 1 F4): glue() binds each figure to its unit, not the whole turn line, and the page says so.
    '**At a narrow width** (1.10) a line never ends between a figure and its unit — `2 min`, `54 %`, `4 m 10 s` stay together in every language, and each figure of a model\'s turn line stays with its unit (`~12 h 05 min`, `P90 ~18 h 46 min` — the line may wrap between the two) —, an ISO day never breaks at its hyphen, and a window\'s percentage never stands alone on a line: it wraps together with the verdict beside it.',
  ]) assert.ok(lang.includes(claim), `docs/languages.md does not say: ${claim}`)
  assert.ok(flatText(doc.numbers).includes('**Decimals** follow the language too (1.10), wherever the dashboard, the tooltips and the text views print one: a key figure\'s change against the period before (`▼ -0,7%` in German — the sign and the `%` are the badge\'s own and stay attached to the figure)'))
  assert.ok(flatText(doc.numbers).includes('The CSV and JSON exports and the diagnostics report keep the `.` in every language: they are read by programs, not by you.'))
  // Review 2 (forDocs 1): the sizes Clear Stored Data… lists are among them (storage.ts formatBytes, P7).
  assert.ok(flatText(doc.numbers).includes('a span under ten hours (`2,5 h`) and the file sizes *Clear Stored Data…* lists (`12,3 kB`).'))
  // The Turkish percent really is Intl's `%25`, and the Turkish bundle writes the number first: the limit the page states.
  assert.equal(new Intl.NumberFormat('tr', { style: 'percent' }).format(0.25), '%25')
  const tr = JSON.parse(readDoc('l10n/bundle.l10n.tr.json')) as Record<string, string>
  const percentKeys = Object.keys(tr).filter((k) => /\{\d\} %/.test(k))
  assert.ok(percentKeys.length >= 20, String(percentKeys.length))
  assert.deepEqual(percentKeys.filter((k) => /%\s?\{\d\}/.test(tr[k])), [], 'a Turkish string writes the percent first')
  // numbers.md, development.md, export.md.
  assert.ok(flatText(doc.numbers).includes('**In your language** (1.9). A figure is written the way the language you chose'))
  assert.ok(flatText(doc.numbers).includes('[Languages](languages.md#numbers-dates-and-times)'))
  const dev = flatText(doc.development)
  for (const claim of ['seven files per language, and a translation touches no other', 'node scripts/merge-l10n.mjs --check # every bundle equals its parts',
    'node scripts/nls-sources.mjs --check # every manifest translation matches today\'s English',
    'that a change of `tokenPace.language` does too — the status bar turns German and back to English (1.9) —']) {
    assert.ok(dev.includes(claim), `docs/development.md does not say: ${claim}`)
  }
  // The gates the page lists are the brief's — in the memory scope of §0b.10 (1.12 lead fix after Review 1 F2: the block ran node --test
  // unscoped; pinned and changed).
  assert.ok(flatText(readDoc('l10n/TRANSLATING.md')).includes('node build.mjs --tests && systemd-run --user --scope -q -p MemoryMax=8G -p MemorySwapMax=0 env CI=true TZ=UTC \\ LANG=en_US.UTF-8 HOME=$(mktemp -d) NODE_OPTIONS=--max-old-space-size=6144 node --test \\ out-test/l10n.languages.test.js'))
  assert.ok(!/node build\.mjs --tests && CI=true/.test(readDoc('l10n/TRANSLATING.md')), 'an unscoped test command is back in TRANSLATING.md')
  assert.ok(readDoc('test-e2e/suite/index.ts').includes("check('a language change reaches the status bar without a reload'"))
  assert.ok(flatText(doc.export).includes('the language line (1.9), `setting auto · shown de · VS Code de`'))
  // The walkthrough's dashboard page names the flag at the other end of the switch's row.
  assert.ok(flatText(readDoc('media/walkthrough/dashboard.md')).includes('At the other end of that row a flag picks the language of Token Pace\'s own texts — twenty-six of them, or *Automatic* for VS Code\'s display language (`tokenPace.language`)'))
})

test('Review 2\'s sentences stand where a reader looks: the terminal\'s own session is never left behind, and what no check can see (1.9 P20, Review 2 (a), (b))', () => {
  const own = 'A session this terminal\'s own `claude` wrote to — a turn you interrupted there before `/clear` or before starting another session in it — is never left behind: it holds the line back until it has finished its turn or that terminal\'s `claude` is started again.'
  assert.ok(flatText(doc.troubleshooting).includes(own), 'docs/troubleshooting.md\'s otherSession entry does not say Review 2 (a)')
  const pc = flatText(doc.promptCache)
  const check13 = pc.slice(pc.indexOf('13. **The terminal\'s own session**'), pc.indexOf('**What no check can see.**'))
  assert.ok(check13.includes(own), 'docs/prompt-cache.md\'s check 13 does not say Review 2 (a)')
  assert.ok(pc.includes('and it costs that session one request; a menu or picker open in that terminal is not seen by any check, and a session left behind there may get the line after a prompt it never answered.'),
    'docs/prompt-cache.md\'s "What no check can see" does not say Review 2 (b)')
  // (b) says nothing about the old prompt being sent again.
  assert.equal(/prompt (is|gets) sent again|re-?sends? the (old )?prompt/i.test(pc), false)
  // The rule the sentence describes: a sibling whose newest line is newer than the terminal's `claude` is never left behind.
  const kw = require('../src/keepWarm') as typeof import('../src/keepWarm')
  assert.ok(readDoc('src/keepWarm.ts').includes('return newest !== null && newest < started && newest <= now - KEEPWARM_SIBLING_LEFT_MS'))
  assert.equal(kw.KEEPWARM_SIBLING_LEFT_MS, 2 * 3_600_000)
})

test('the picture of the open picker is in the repository, embedded in the README and packaged (1.9 P20, §7 Q17)', () => {
  const file = 'media/screenshot-languages.png'
  assert.match(README, /!\[The language picker open at the top of the dashboard: Automatic — as VS Code \(English\) first[^\]]*\]\(media\/screenshot-languages\.png\)/)
  const png = readFileSync(join(ROOT, file))
  assert.deepEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], `${file} is not a PNG`)
  // 420 px at twice the size: the page's width in the harness, as the other store pictures are.
  assert.equal(png.readUInt32BE(16), 840, `${file} is not 840 px wide`)
  assert.equal(shipped(file), true, `${file} would not be packaged`)
})

test('the German counterpart of every interface text the pages quote for the language switch says the same, in the glossary\'s words (1.9 P20, §6)', () => {
  const pairs: Array<[string, string]> = [
    ['Language: {0} (automatic)', 'Sprache: {0} (automatisch)'],
    ['Language: {0}', 'Sprache: {0}'],
    ['Automatic — as VS Code ({0})', 'Automatisch — wie VS Code ({0})'],
    ["Automatic — VS Code's language ({0}) has no translation here, so English", 'Automatisch — für die Sprache von VS Code ({0}) gibt es hier keine Übersetzung, daher Englisch'],
    ["Token Pace's own texts switch at once. The settings, the command titles and the walkthrough follow VS Code's display language (Configure Display Language).",
      'Die eigenen Texte von Token Pace wechseln sofort. Die Einstellungen, die Befehlstitel und die Einführung folgen der Anzeigesprache von VS Code (Anzeigesprache konfigurieren).'],
    ['The languages beyond English and German were translated by AI agents and checked by tests, not by native speakers.',
      'Die Sprachen über Englisch und Deutsch hinaus haben KI-Agenten übersetzt und Tests geprüft, keine Muttersprachler.'],
    ['Token Pace: the language could not be written to your user settings.', 'Token Pace: Die Sprache konnte nicht in Ihre Benutzereinstellungen geschrieben werden.'],
  ]
  for (const [en, de] of pairs) assert.equal(GERMAN[en], de, `the German bundle's words for: ${en}`)
  // The German words the languages page quotes are the bundle's, filled as the view model fills them.
  const lang = flatText(doc.languages)
  assert.ok(lang.includes(`„${GERMAN['Language: {0} (automatic)'].replace('{0}', 'Deutsch')}"`), 'docs/languages.md does not quote the German button name')
  assert.ok(lang.includes(`*${GERMAN['Automatic — as VS Code ({0})'].replace('{0}', 'Deutsch')}*`), 'docs/languages.md does not quote the German Automatic line')
  // The German manifest keeps the statement and names the display language as the glossary does.
  assert.ok(nlsDe['config.language.description'].includes('Anzeigesprache konfigurieren') && nlsDe['config.language.enum.auto'].startsWith('Der Anzeigesprache von VS Code folgen'))
})

/**
 * 1.10 P3 (§3 A1, A7, §0a.1): the prompts page says what the code does — the three shipped prompts word for word
 * as the code ships them (and their German titles as the German bundle has them), the limits, the ids, the
 * file's shape and where it is never written to —, and the pages around it name the section, the command and
 * the file.
 */
test('the prompts page quotes the shipped prompts, the limits and the file as the code has them, and says where a prompt never goes (1.10 P3)', () => {
  const { PROMPT_TEXT_MAX_CHARS, PROMPT_TITLE_MAX_CHARS, PROMPTS_FILE_MAX_BYTES, PROMPTS_MAX, SHIPPED_PROMPTS, SHIPPED_PROMPT_KEY, shippedPromptText, shippedPromptTitle } =
    require('../src/prompts') as typeof import('../src/prompts')
  const page = doc.prompts
  const flat = flatText(page)
  assert.ok(page.startsWith('<!--') && page.includes('\n# Prompts\n'), 'docs/prompts.md does not open with its title')
  assert.ok(flat.includes('The Prompts section of the dashboard is your own list of prompts for Claude Code and Codex. A double-click on a prompt types its text into the VS Code terminal that runs Claude Code or Codex and presses Enter — always on your click, never on its own.'))
  for (const heading of ['## Adding the section', '## The list', '## Where the prompts are kept']) assert.ok(page.includes(`\n${heading}\n`), `docs/prompts.md has no ${heading}`)
  // The three shipped prompts, in their order, word for word — the table escapes the status text's pipes.
  const rows = page.split('\n').filter((l) => /^\| (Status table|Keep the cache warm|Stop after this task) \|/.test(l))
  assert.deepEqual(rows, SHIPPED_PROMPTS.map((id) => `| ${shippedPromptTitle(id)} | \`${shippedPromptText(id).replace(/\|/g, '\\|')}\` |`))
  // Their German titles, as the German bundle says them; the keep-warm text stays English.
  for (const id of ['status', 'keepWarm', 'stop'] as const) assert.ok(flat.includes(`*${GERMAN[shippedPromptTitle(id)]}*`), `docs/prompts.md does not quote the German title of ${id}`)
  // The limits, the ids and the file's size bound as the code has them.
  assert.deepEqual([PROMPTS_MAX, PROMPT_TITLE_MAX_CHARS, PROMPT_TEXT_MAX_CHARS, PROMPTS_FILE_MAX_BYTES], [50, 80, 2000, 512 * 1024])
  assert.ok(flat.includes('a title of 1 to 80 characters and a text of 1 to 2000 characters, and the list holds at most 50 prompts'))
  assert.ok(flat.includes('larger than 512 KiB'))
  for (const id of SHIPPED_PROMPTS) assert.ok(page.includes(`\`${SHIPPED_PROMPT_KEY[id]}\``), `docs/prompts.md does not name ${SHIPPED_PROMPT_KEY[id]}`)
  // The words the section and the command say, as the code says them.
  assert.ok(flat.includes(`*${'prompts.json could not be read ({0}). The shipped prompts are shown, and nothing is saved until the file is fixed or deleted (Token Pace: Clear Stored Data…).'.replace('{0}', 'json')}*`))
  assert.ok(flat.includes('*A prompt that starts with an exclamation mark would run a shell command in Claude Code.*'))
  for (const said of ['*Not saved: The title is empty.*', '*Not saved: the list is full (at most 50 prompts)*', '*Not saved: prompts.json could not be written (EACCES)*',
    '*every default prompt is there already*', '*Prompts (prompts.json)*', '`Prompts: saved a user prompt.`']) {
    assert.ok(flat.includes(said), `docs/prompts.md does not say: ${said}`)
  }
  // Where a prompt never goes, and what the file never holds.
  for (const claim of ['never in the log, the diagnostics report (not even a count), the CSV or JSON export, *Copy Usage Summary*, the usage document, the usage Quick Pick or the status bar',
    'no time, no session, no terminal, no path, no count of sends', '`prompts.json` is not part of VS Code\'s Settings Sync, and the list has no export and no import',
    'It is written only when you change the list', 'until your first change there is no file', 'a temporary file, then a rename',
    'When two windows save the same prompt, the later save wins', 'While `prompts` is not listed, the dashboard does not look at that file; only *Clear Stored Data…* (to count its prompts) and *Token Pace: Restore Default Prompts* read it then']) {
    assert.ok(flat.includes(claim), `docs/prompts.md does not say: ${claim}`)
  }
  // The pages around it: the section's row and the default's omissions, the settings row, the command, the privacy page's writes.
  const row = doc.dashboard.split('\n').find((l) => l.startsWith('| `prompts` |')) ?? ''
  assert.ok(row.includes('[Prompts](prompts.md)') && row.includes('Off by default'), row)
  assert.ok(SETTINGS.includes('`prompts` (new in 1.10) is your own list of prompts for Claude Code\'s and Codex\'s terminals'))
  const command = doc.commands.split('\n').find((l) => l.startsWith('| `Token Pace: Restore Default Prompts` |')) ?? ''
  assert.ok(command.includes('a shipped prompt you edited is not missing and stays as you wrote it'), command)
  assert.ok(doc.commands.includes('your prompt list `prompts.json` (deleting it brings back the three shipped prompts)'))
  assert.ok(flatText(doc.privacy).includes('`prompts.json` when you change the dashboard\'s prompt list — your own titles and texts, nothing else'))
  assert.ok(flatText(doc.export).includes('the titles and texts you wrote are in no export, no report and no log'))
})

/**
 * 1.10 P4 (§3 A3, A4, A7, §0a.4, §0a.5; §7a's probe): the prompts page says how a prompt is sent — the reader's
 * action, the gap, the two writes with the delay the code has, the draft that goes with it —, into which terminal,
 * and every check of the decision in the words the code says it, with never or asks first as the code has it; the
 * troubleshooting page names every check; the privacy and prompt-cache pages say what the send types and reads.
 */
test('the prompts page says how a prompt is sent, into which terminal, and every check in the words the code has (1.10 P4)', () => {
  const { PROMPT_SOFT_BLOCKS, promptBlockText } = require('../src/promptSend') as typeof import('../src/promptSend')
  const { PROMPT_ENTER_DELAY_MS, PROMPT_SEND_MIN_GAP_MS } = require('../src/promptsHost') as typeof import('../src/promptsHost')
  const { promptTargetVm, promptSentText } = require('../src/viewModel') as typeof import('../src/viewModel')
  const page = doc.prompts
  const flat = flatText(page)
  for (const heading of ['## Sending', '## Which terminal', '## When Token Pace does not send, or asks first']) {
    assert.ok(page.includes(`\n${heading}\n`), `docs/prompts.md has no ${heading}`)
  }
  // The constants as the code has them.
  assert.deepEqual([PROMPT_SEND_MIN_GAP_MS, PROMPT_ENTER_DELAY_MS], [1000, 200])
  assert.ok(flat.includes(`(\`PROMPT_SEND_MIN_GAP_MS\`, ${PROMPT_SEND_MIN_GAP_MS} ms)`))
  assert.ok(flat.includes(`then, ${PROMPT_ENTER_DELAY_MS} milliseconds later (\`PROMPT_ENTER_DELAY_MS\`), the Enter alone`))
  // Every check, in its row, with the code's hard or soft and its sentence word for word.
  const blocks = ['restricted', 'reading', 'noTerminal', 'codex', 'unknownFolder', 'hookWait', 'unknownStart', 'noSession', 'openTool', 'notIdle', 'agentRunning', 'otherSession'] as const
  const rows = page.split('\n').filter((l) => /^\| `\w+` \| (never|asks first) \|/.test(l))
  assert.deepEqual(rows, blocks.map((b) => `| \`${b}\` | ${PROMPT_SOFT_BLOCKS.has(b) ? 'asks first' : 'never'} | *${promptBlockText(b)}* |`))
  // The words the section, the pick, the question and the log say, as the code builds them.
  const where = promptTargetVm({ state: 'active', kind: 'claude', index: 2, count: 3, verdict: { send: true } }).text
  for (const said of [`*${where}*`, `*${promptTargetVm({ state: 'pick', candidates: 2 }).text}*`, `*${promptTargetVm({ state: 'none' }).text}*`,
    `*${promptSentText({ ok: true, kind: 'claude', index: 2, count: 3 }).text}*`, `*${promptSentText({ ok: false, block: 'failed' }).text}*`,
    '*Claude Code — terminal 2 of 3*', '*ready*, *sending asks first* or *not now*', '*Send “Status table” anyway?*',
    '*If Claude Code is showing a permission dialog or a question there, the text and Enter would answer it. Text typed in that terminal and not sent yet goes with it.*',
    '`Prompts: sent a prompt to Claude Code in terminal 2 of 3`', '`Prompts: not sent (hookWait)`', '`Prompts: a send was dropped (another one is under way)`']) {
    assert.ok(flat.includes(said), `docs/prompts.md does not say: ${said}`)
  }
  // What the page promises, and what §7a's probe found.
  for (const claim of ['**Anything you typed in that terminal and did not send goes with the prompt.**', 'The text and the Enter are two writes (`sendText`)',
    'a 119-character prompt stayed in its input box that way, unsent', 'never Claude Code in the Claude Code extension\'s own panel',
    'A terminal\'s name is never read', 'Nothing is read back from the terminal', 'is not counted in `keepwarm.json`',
    'restart Claude Code in it after a reload for the full check', 'sending was tried with Claude Code only (2.1.282 and 2.1.283), not with Codex',
    'the dashboard page only names the prompt and never hands over a text of its own', 'Nothing of your answer is kept: the next send asks again',
    'with *No, exit* highlighted, so that Enter would end Claude Code', 'a text typed into an open dialog answers it and is lost',
    'so a fresh `claude --resume` list standing in this terminal goes unseen then', 'became one scheduled task']) {
    assert.ok(flat.includes(claim), `docs/prompts.md does not say: ${claim}`)
  }
  // Troubleshooting: every check by its code, under its own heading.
  const trouble = doc.troubleshooting
  const at = trouble.indexOf('\n## A prompt was not sent\n')
  assert.ok(at >= 0, 'docs/troubleshooting.md has no section for a prompt that was not sent')
  const why = trouble.slice(at, trouble.indexOf('\n## ', at + 10))
  for (const b of blocks) assert.ok(why.includes(`\`${b}\``), `troubleshooting.md does not explain ${b}`)
  assert.ok(flatText(why).includes('`Prompts: an operation was dropped (the section is not listed)`'))
  // Privacy: the second write, always the reader's; the kept facts the decision reads; the watch's listening rule.
  const privacy = flatText(doc.privacy)
  for (const claim of ['**The prompt you send** ([Prompts](prompts.md#sending), 1.10) is the second thing Token Pace ever types into another program\'s input',
    'never a text the dashboard page hands over', 'the text, then, 200 milliseconds later, the Enter alone', '`Prompts: not sent (openTool)`',
    'The watch listens to the events while the keep-warm line may act, or while the dashboard lists the Prompts section and the workspace is trusted',
    'in which the watch holds no open execution of that program — none seen, or the one it saw has ended']) {
    assert.ok(privacy.includes(claim), `docs/privacy.md does not say: ${claim}`)
  }
  for (const stale of ['while the setting is on and allowed and from nothing else', 'where the watch saw no such start', 'saw no start of that program']) {
    assert.equal(privacy.includes(stale), false, `docs/privacy.md still says: ${stale}`)
  }
  // The prompt-cache page: a countdown ends for a prompt, as the host logs it; the watch's second user.
  const pc = flatText(doc.promptCache)
  assert.ok(readDoc('src/keepWarmHost.ts').includes("this.log.info('keep-warm: not sent (a prompt was typed into its terminal)')"))
  for (const claim of ['`keep-warm: not sent (a prompt was typed into its terminal)`', 'keep-warm stops for the rest of that session\'s idle phase, as a click on the countdown stops it',
    'stops Token Pace listening to the terminals for it — the window listens on only while the dashboard lists the [Prompts](prompts.md#which-terminal) section in a trusted workspace']) {
    assert.ok(pc.includes(claim), `docs/prompt-cache.md does not say: ${claim}`)
  }
  assert.equal(pc.includes('stops Token Pace listening to the terminals at all'), false)
})

/**
 * 1.10 P5 (§3 A2, A5, A7): the prompts page says how a prompt is edited — the click's delay and the double-click's
 * grace as the page's constants have them, the keys, the checks before a save, the delete question, the moves, a new
 * prompt, the fields surviving an update — and how the section reads with the keyboard and a screen reader, in the
 * words the page says; the dashboard page has the section's paragraph and names it among the filter-free ones.
 */
test('the prompts page says how a prompt is edited and how the section reads with the keyboard and a screen reader, in the page\'s words (1.10 P5)', () => {
  const page = doc.prompts
  const flat = flatText(page)
  const headings = ['## The list', '## Editing', '## Where the prompts are kept', '## Sending', '## Keyboard and screen readers']
  const at = headings.map((h) => page.indexOf(`\n${h}\n`))
  assert.ok(at.every((i) => i >= 0), `docs/prompts.md lacks one of ${headings.join(', ')}`)
  assert.deepEqual([...at].sort((a, b) => a - b), at, 'docs/prompts.md has its sections in another order')
  // The page's two timings, as src/webview/main.ts has them.
  const main = readDoc('src/webview/main.ts')
  const delay = /\nconst PROMPT_CLICK_DELAY_MS = (\d+);/.exec(main)?.[1]
  const grace = /\nconst PROMPT_DBLCLICK_GRACE_MS = (\d+);/.exec(main)?.[1]
  assert.deepEqual([delay, grace], ['300', '800'])
  assert.ok(flat.includes(`after ${delay} milliseconds (\`PROMPT_CLICK_DELAY_MS\`)`))
  assert.ok(flat.includes(`within ${grace} milliseconds of their opening (\`PROMPT_DBLCLICK_GRACE_MS\`)`))
  // The page's words, as the English and the German bundle have them.
  const title = 'Status table'
  for (const said of ['*Title* and *Text*', '*104 / 2000 characters*', '*Save*, *Cancel*, *Move up*, *Move down* and *Delete*',
    '*The title is empty.*', '*The text is empty.*', `*${'Delete “{0}”?'.replace('{0}', title)}*`, '*Delete* and *Keep*', '*New prompt*',
    '*At most 50 prompts.*', '*This prompt was deleted in another window; your changes were not saved.*', '*Prompts*',
    '*Enter edits it, Ctrl+Enter sends it.*', `*${'Send “{0}”'.replace('{0}', title)}*`, `*${'Edit “{0}”'.replace('{0}', title)}*`,
    `*${GERMAN['Send “{0}”'].replace('{0}', GERMAN[title])}*`, '*Sent to Claude Code in terminal 2 of 3.*']) {
    assert.ok(flat.includes(said), `docs/prompts.md does not say: ${said}`)
  }
  for (const claim of ['**Enter** in either field saves — Shift+Enter too', '**Leaving the fields**', '**Escape** closes them and leaves the prompt as it was',
    'Open fields keep what you typed through every update of the dashboard', 'Nothing of what you type is sent anywhere before you save it',
    'two stops of the Tab key', 'Ctrl+Enter (⌘+Enter on a Mac) sends it', 'A key held down acts once', 'There is no roving focus: a list of 50 prompts is 100 stops',
    'the keyboard on *Keep*', 'never a colour alone', 'the page never scrolls sideways']) {
    assert.ok(flat.includes(claim), `docs/prompts.md does not say: ${claim}`)
  }
  // The dashboard page: the section's paragraph, the filter-free list (the RANGE_FREE test holds its names).
  const dash = flatText(doc.dashboard)
  assert.ok(dash.includes('**Prompts.** The `prompts` section — not in the default;'), 'docs/dashboard.md has no Prompts paragraph')
  assert.ok(dash.includes('[Prompts](prompts.md#editing)') && dash.includes('[Sending](prompts.md#sending)'))
  assert.ok(dash.includes('and not your prompt list — so the filter bar sits below every'))
  assert.ok(dash.includes('the id of a prompt to send, delete or move, a prompt\'s title and text to save'))
})

// ---------------------------------------------------------------------------
// 1.10 P21 — documentation, release notes, pictures (plan-1.10-build.md §4 P21).

/**
 * 1.10 P21: the 1.10.0 release notes — the newest entry with its date left for the publish, every section in
 * order, the three shipped prompts and the limits as the code has them, the checks the code knows, the words the
 * page and the bar say, the versions unchanged, the plain statement on the twelve languages, and nothing the
 * notes must not claim.
 */
test('the 1.10.0 release notes: the newest entry, its date set at publish, every section in order, the prompts, limits, checks and words the code has, the versions, the plain statement, nothing unverified (1.10 P21)', () => {
  const { PROMPTS_MAX, PROMPT_TITLE_MAX_CHARS, PROMPT_TEXT_MAX_CHARS, SHIPPED_PROMPTS, shippedPromptText, shippedPromptTitle } = require('../src/prompts') as typeof import('../src/prompts')
  const { PROMPT_ENTER_DELAY_MS, PROMPT_FLASH_MS, PROMPT_SEND_MIN_GAP_MS } = require('../src/promptsHost') as typeof import('../src/promptsHost')
  const { PROMPT_SOFT_BLOCKS } = require('../src/promptSend') as typeof import('../src/promptSend')
  const { AGENT_TABLES_REVISION } = require('../src/agg') as typeof import('../src/agg')
  const { KEEP_WARM_LINE, KEEPWARM_GUARD_OF } = require('../src/keepWarm') as typeof import('../src/keepWarm')
  const log = readDoc('CHANGELOG.md')
  // 1.11 P9 (pinned and changed: the newest entry): 1.11.0 is the newest now — the 1.10.0 entry is found by its heading.
  const first = log.indexOf('\n## 1.10.0 ')
  assert.ok(first >= 0, 'the CHANGELOG has no 1.10.0 entry')
  const second = log.indexOf('\n## ', first + 4)
  const entry = log.slice(first, second)
  // The release cadence: the date is set on the release branch at publish, never before.
  assert.match(entry, /^\n## 1\.10\.0 — <date set at publish>\n\n\*\*/, 'the 1.10.0 CHANGELOG entry does not keep its date for the publish, or does not open with its summary')
  assert.ok(log.includes('\n## 1.9.0 — <date set at publish>\n'), 'the 1.9.0 entry is gone or dated')
  const flat = flatText(entry)
  const heads = ['### Added', '### Changed', '### Fixed', '### Privacy', '### Internal']
  const order = heads.map((h) => flat.indexOf(h))
  assert.ok(order.every((i) => i > 0) && order.every((i, k) => k === 0 || i > order[k - 1]), 'the 1.10.0 entry\'s sections are missing or out of order')
  const section = (h: string): string => { const at = heads.indexOf(h); return flat.slice(order[at], at + 1 < heads.length ? order[at + 1] : undefined) }
  // The three shipped prompts, word for word, in Added — the status text with its pipes as the code has them.
  assert.deepEqual(SHIPPED_PROMPTS, ['status', 'keepWarm', 'stop'])
  for (const id of SHIPPED_PROMPTS) {
    assert.ok(section('### Added').includes(`*${shippedPromptTitle(id)}*`), `the 1.10.0 entry does not name the shipped prompt ${id}`)
    assert.ok(section('### Added').includes(`\`${shippedPromptText(id)}\``), `the 1.10.0 entry does not quote the shipped text of ${id}`)
  }
  assert.equal(shippedPromptText('keepWarm'), KEEP_WARM_LINE)
  // The limits and timings as the code has them.
  assert.deepEqual([PROMPTS_MAX, PROMPT_TITLE_MAX_CHARS, PROMPT_TEXT_MAX_CHARS, PROMPT_SEND_MIN_GAP_MS, PROMPT_ENTER_DELAY_MS, PROMPT_FLASH_MS], [50, 80, 2000, 1000, 200, 10_000])
  const delay = /\nconst PROMPT_CLICK_DELAY_MS = (\d+);/.exec(readDoc('src/webview/main.ts'))?.[1]
  assert.equal(delay, '300')
  for (const claim of [`A title has ${PROMPT_TITLE_MAX_CHARS} characters`.replace('A title has ', 'A title has 1 to '), `a text 1 to ${PROMPT_TEXT_MAX_CHARS} on one line`,
    `the list holds at most ${PROMPTS_MAX} prompts`, `(after ${delay} milliseconds, so that a double-click sends instead)`,
    `The text and the Enter are two writes, ${PROMPT_ENTER_DELAY_MS} milliseconds apart`, 'at most one per second', 'for ten seconds']) {
    assert.ok(flat.includes(claim), `the 1.10.0 entry does not say: ${claim}`)
  }
  // The checks: the hard ones named as never sending, the soft ones as asking first — as the code flags them.
  assert.deepEqual([...PROMPT_SOFT_BLOCKS].sort(), ['agentRunning', 'codex', 'notIdle', 'openTool', 'otherSession', 'unknownFolder', 'unknownStart'])
  for (const claim of ['in Restricted Mode; while it reads the transcripts; with no such terminal; while the agent hook reports a permission request open',
    'has not written a line since it started', 'an open tool call, a reply that did not end its turn, an agent of the session running, another session of the same folder busy, a Claude Code whose start Token Pace did not see',
    'a terminal whose folder VS Code does not report, and Codex, of whose state Token Pace reads nothing', '*Send “Status table” anyway?*', 'Nothing of your answer is kept']) {
    assert.ok(flat.includes(claim), `the 1.10.0 entry does not say: ${claim}`)
  }
  // The words the page, the bar and the settings say, as the code and the manifest have them.
  for (const [en] of [['Sent to {0} in terminal {1} of {2}.'], ['Keep-warm line for {0} in {1} seconds, press to cancel'], ['Avg turn time {0}'], ['Agent entries, last 7 days'],
    ['Share of complete cycles that hit the limit: {0} · Avg unused at the reset: {1}'], ['Active days'], ['Enter edits it, Ctrl+Enter sends it.'], ['Send anyway'], ['Restore Default Prompts']]) {
    assert.ok(en === 'Restore Default Prompts' ? nlsEn['command.restoreDefaultPrompts.title'] === en : typeof GERMAN[en] === 'string', `${en} is not a text of the code`)
  }
  assert.ok(flat.includes('*Sent to Claude Code in terminal 2 of 3.*') && flat.includes('`Keep-warm line for {0} in {1} seconds, press to cancel`') && flat.includes('*Avg turn time*')
    && flat.includes('*Agent entries, last 7 days*') && flat.includes('*Share of complete cycles that hit the limit: {0} · Avg unused at the reset: {1}*') && flat.includes('*Active days*')
    && flat.includes('*Enter edits it, Ctrl+Enter sends it.*') && flat.includes('*Send anyway*') && flat.includes('`Token Pace: Restore Default Prompts`'))
  assert.ok(flat.includes("This is the current session's context, as the status line reports it — not an account figure, and not comparable to a quota window."))
  assert.ok(typeof GERMAN["This is the current session's context, as the status line reports it — not an account figure, and not comparable to a quota window."] === 'string')
  for (const key of ['config.resetFormat.enum.relative', 'config.resetFormat.enum.both', 'config.summary.period.enum.today']) {
    assert.ok(flat.includes(`\`${nlsEn[key]}\``), `the 1.10.0 entry does not quote the manifest's ${key}`)
  }
  assert.ok(nlsDe['config.resetFormat.enum.relative'].includes('· Reset in 2h14m') && nlsDe['config.summary.period.enum.today'].includes('Σ 3,1M · heute'))
  assert.ok(section('### Changed').includes('`· Reset in 2h14m`, `Σ 3,1M · heute`'))
  // The keep-warm line's fourteenth check, as the code numbers it.
  assert.equal(KEEPWARM_GUARD_OF.reading, 'G14')
  assert.ok(section('### Fixed').includes('(`reading`, check 14 of the keep-warm line)'))
  // The versions it names are the code's; the snapshot schema and the export stay. 1.11 P5 (pinned and changed, §3 C4
  // rule 4): the export's as 1.10.0 shipped it, 3 — the code's is 4 since.
  assert.deepEqual([STATE_VERSION, RELEASED_1_10.EXPORT_SCHEMA_VERSION, AGENT_TABLES_REVISION], [8, 3, 10])
  assert.ok(section('### Internal').includes(`\`STATE_VERSION\` ${STATE_VERSION}, the export's \`schema_version\` ${RELEASED_1_10.EXPORT_SCHEMA_VERSION} (\`EXPORT_SCHEMA_VERSION\` ${RELEASED_1_10.EXPORT_SCHEMA_VERSION}) and \`AGENT_TABLES_REVISION\` ${AGENT_TABLES_REVISION} are unchanged`))
  for (const m of flat.matchAll(/`(STATE_VERSION|EXPORT_SCHEMA_VERSION|AGENT_TABLES_REVISION)` (\d+)/g)) {
    assert.equal(Number(m[2]), m[1] === 'STATE_VERSION' ? STATE_VERSION : m[1] === 'EXPORT_SCHEMA_VERSION' ? RELEASED_1_10.EXPORT_SCHEMA_VERSION : AGENT_TABLES_REVISION, `the 1.10.0 entry says ${m[1]} ${m[2]}`)
  }
  // The ledger's count and the contract's rows are what the files hold. 1.11 P1 (pinned and changed: the count read from
  // l10n/rekey.json): `l10n-rekey.mjs --start b89ff43` began 1.11's ledger and emptied the entries, so 1.10's count is
  // history — the 115 entries of l10n/rekey.json at b89ff43 (base e72057a), a literal from here on.
  assert.ok(section('### Internal').includes('`l10n/rekey.json` (115 entries for this release)'), '1.10\'s ledger held 115 entries')
  const rows = (readDoc('scripts/check-privacy.mjs').match(/what: 'prompts: /g) ?? []).length
  assert.ok(section('### Internal').includes(`gains ${['', 'one', 'two', 'three', 'four', 'five', 'six', 'seven'][rows]} rows`), `the read contract has ${rows} prompts rows`)
  // The twelve languages, named in their own names in the registry's order, and the plain statement. 1.11 P2 (pinned and
  // changed: every language of the registry but English and German): the twelve of 1.10 are the registry's first fourteen
  // but English and German.
  const twelve = LANGUAGES.slice(0, 14).filter((e) => e.id !== 'en' && e.id !== 'de').map((e) => e.native)
  assert.ok(flat.includes(`${twelve.slice(0, -1).join(', ')} and ${twelve[twelve.length - 1]}`), 'the 1.10.0 entry does not name the twelve languages as the registry has them')
  assert.ok(flat.includes('**This work was again done by AI agents from the English text, with the German as a second reference, and checked by tests — not reviewed by native speakers.**'))
  assert.ok(flat.includes('translated by AI agents, as in 1.9, and not reviewed by native speakers'))
  // Claims the notes must not make: nothing beyond an AI agent's reading; no Codex send tried; no path, file or secret of the machine.
  for (const never of [/professional/i, /native[- ]quality/i, /proofread/i, /certified/i, /fluent/i, /tried with Codex/i, /tested with Codex/i]) {
    assert.equal(never.test(entry), false, `the 1.10.0 entry says ${never}`)
  }
  assert.equal(/review/i.test(flat.replace(/not reviewed by native speakers/g, '')), false, 'the 1.10.0 entry claims a review')
  for (const never of [/\/home\//, /plan-1\.\d+/, /\.claude\/projects/, /VSCE_PAT|OVSX_PAT/, /research\//, /[A-Za-z]:\\/, /\/tmp\//, /package\.json/, /worktree/i, /Review [12L]\b/]) {
    assert.equal(never.test(entry), false, `the 1.10.0 entry mentions ${never}`)
  }
  // The old words are not claimed anywhere: the manifest's examples carry the bar's word, the countdown's old verb and the
  // 7-day block's old head are gone from the pages, and nothing says the keep-warm line is the one thing typed.
  for (const key of ['config.resetFormat.enum.relative', 'config.resetFormat.enum.absolute', 'config.resetFormat.enum.both', 'config.density.enum.full']) {
    assert.ok(nlsEn[key].includes('resets'), `${key} lacks the bar's word`)
  }
  assert.ok(nlsEn['config.summary.period.enum.today'].includes('· today'))
  for (const [name, text] of [['CHANGELOG.md 1.10.0', entry], ['docs/agents.md', doc.agents], ['docs/dashboard.md', doc.dashboard], ['docs/prompt-cache.md', doc.promptCache],
    ['docs/privacy.md', doc.privacy], ['docs/status-bar-states.md', STATES], ['docs/troubleshooting.md', doc.troubleshooting], ['docs/export.md', doc.export], ['README.md', README]] as const) {
    for (const stale of ['activate to cancel', 'Agent records', 'a record keeps no speed', 'the one thing it ever types', 'nothing is typed anywhere except the keep-warm line:', 'Avg turn ~']) {
      assert.equal(flatText(text).includes(stale), false, `${name} still says: ${stale}`)
    }
  }
  assert.equal(nlsEn['capabilities.untrustedWorkspaces'].includes('the one thing it ever types'), false)
  assert.ok(nlsEn['capabilities.untrustedWorkspaces'].includes('It types into a terminal in two cases only'))
})

/**
 * 1.10 P21 (§7 Q26): the picture of the Prompts section — 420 px at twice the size, dark, English, with the target
 * line — is in the repository, embedded in the README and packaged, as the other store pictures are.
 */
test('the picture of the Prompts section is in the repository, embedded in the README and packaged (1.10 P21, §7 Q26)', () => {
  const file = 'media/screenshot-prompts.png'
  assert.match(README, /!\[The Prompts section of the dashboard: the line on how it works and that unsent text goes with a prompt, the line naming where a prompt would go — Sends to Claude Code in terminal 2 of 3 — ready —[^\]]*\]\(media\/screenshot-prompts\.png\)/)
  const png = readFileSync(join(ROOT, file))
  assert.deepEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], `${file} is not a PNG`)
  assert.equal(png.readUInt32BE(16), 840, `${file} is not 840 px wide`)
  assert.equal(shipped(file), true, `${file} would not be packaged`)
  // The four other pictures of the dashboard are 840 px wide as well — the same page width at twice the size.
  for (const other of ['media/screenshot-dashboard.png', 'media/screenshot-prompt-cache.png', 'media/screenshot-languages.png', 'media/screenshot-tokens.png']) {
    assert.equal(readFileSync(join(ROOT, other)).readUInt32BE(16), 840, `${other} is not 840 px wide`)
  }
})

/**
 * 1.10 P21: the sentences the last package added where a reader looks — the prompts page (the twelve languages, the
 * field's count, the `/loop` variant), the languages page (the ledger, the terms, the stacked label's colon, the turn
 * line), development.md (the `; ` rule, the test seam), status-bar.md (`auto`), agents.md (an agent entry), the
 * README (the site, the bullet, the privacy sentence) and the walkthrough — each held to the code where the code
 * decides it.
 */
test('the pages carry the sentences of the documentation package, held to the code (1.10 P21)', () => {
  const prompts = flatText(doc.prompts)
  // 1.11 P9 (pinned and changed: "the other twelve languages"): twenty-four translate the shipped prompts.
  for (const claim of ['and likewise in each of the other twenty-four languages; the German status prompt keeps the author\'s own wording, the twenty-four translate the English',
    'the characters counted as the field counts them (an emoji counts two)', 'one whose command it saw end while VS Code still names the shell so']) {
    assert.ok(prompts.includes(claim), `docs/prompts.md does not say: ${claim}`)
  }
  // The `/loop` section: its place, the interval and the bound it rests on, the cost from the prompt-cache page's own example, the ways to stop it, the seven days.
  assert.ok(doc.prompts.includes('\n## The `/loop` variant\n'))
  const at = doc.prompts.indexOf('\n## Sending\n'), loop = doc.prompts.indexOf('\n## The `/loop` variant\n'), which = doc.prompts.indexOf('\n## Which terminal\n')
  assert.ok(at < loop && loop < which, 'the /loop section is not between Sending and Which terminal')
  const loopText = flatText(doc.prompts.slice(loop, which))
  for (const claim of ['`/loop 30m Ignore this message. No action. No response.`', 'every 30 minutes', 'at most 45 minutes between two requests — under the hour',
    'a cache read is ~$0.03 of API equivalent against ~$1.22 for one cold rewrite', 'ask Claude in that session to list its scheduled tasks and cancel the keep-warm one',
    '`CLAUDE_CODE_DISABLE_CRON=1`', 'runs seven days at most', '`keepwarm.json` counts only the lines the keep-warm countdown typed', 'at a weight Anthropic does not publish']) {
    assert.ok(loopText.includes(claim), `the /loop section does not say: ${claim}`)
  }
  assert.ok(flatText(doc.promptCache).includes('152.3K tokens at the 1 h write rate (2× input, ~$1.22) instead of reading them from the cache (0.05× input, ~$0.03)'),
    'the prompt-cache page no longer carries the example the /loop section quotes')
  assert.ok(doc.promptCache.includes('([Prompts](prompts.md#the-loop-variant))'))
  assert.ok(prompts.includes('[The `/loop` variant](#the-loop-variant)'))
  // The languages page: the ledger in reader words, the terms as the files have them, the colon per language, the turn line.
  const languages = flatText(doc.languages)
  for (const claim of ['every change went into a ledger of English changes (the build\'s `l10n/rekey.json`) which each of the twelve languages worked through',
    'no pending list may exist at the join, and every settings translation must be fresh', 'was again done by AI agents (Claude Opus 5.5, with a wording pass by Claude Fable 5.1), not by native speakers',
    // 1.11 P9 (pinned and changed: "the other nine keep the loanword"): the nine of 1.9 — the twelve of 1.11 have their own sentence.
    'is said in the language\'s own word in Turkish (*istem*) and in the two Chinese variants (提示词 in Simplified, 提示 in Traditional Chinese); the other nine of 1.9 keep the loanword',
    'not a key label of VS Code\'s', '*Période :* with a no-break space in French, *范围：* and *範圍：* with the full-width colon in Simplified and Traditional Chinese, the plain `:` everywhere else, Japanese included',
    // 1.11 P9 (pinned and changed): the full-width colon's wider gap is gone (D1, P3), and the turn line keeps each figure
    // with its unit, not the whole line (Review 1 F4: glue() binds figure and unit).
    'each figure of a model\'s turn line stays with its unit (`~12 h 05 min`, `P90 ~18 h 46 min` — the line may wrap between the two)', 'are new in 1.9.0', 'are new in 1.11.0']) {
    assert.ok(languages.includes(claim), `docs/languages.md does not say: ${claim}`)
  }
  const bundle = (id: string): Record<string, string> => JSON.parse(readDoc(`l10n/bundle.l10n.${id}.json`)) as Record<string, string>
  assert.equal(bundle('fr')['{0}:'], '{0} :')
  assert.equal(bundle('fr').Period, 'Période')
  assert.deepEqual([bundle('zh-cn')['{0}:'], bundle('zh-cn').Range, bundle('zh-tw')['{0}:'], bundle('zh-tw').Range, bundle('ja')['{0}:'], bundle('de')['{0}:']], ['{0}：', '范围', '{0}：', '範圍', '{0}:', '{0}:'])
  for (const id of ['es', 'pt-br', 'it', 'ko', 'ru', 'pl', 'cs']) assert.equal(bundle(id)['{0}:'], '{0}:', `${id} writes another colon`)
  assert.equal(bundle('tr').Prompts, 'İstemler')
  assert.equal(bundle('zh-cn').Prompts, '提示词')
  assert.equal(bundle('zh-tw').Prompts, '提示')
  for (const id of ['fr', 'es', 'pt-br', 'it', 'pl', 'cs']) assert.match(bundle(id).Prompts, /^Prompt/, `${id} does not keep the loanword`)
  assert.deepEqual([bundle('ja').Prompts, bundle('ko').Prompts, bundle('ru').Prompts], ['プロンプト', '프롬프트', 'Промпты'])
  // No list of an earlier version's ledger is left (1.11 P1, pinned and changed: no list at all; 1.12 P1, pinned and
  // changed: 1.10's base e72057a alone) — from `--start b89ff43` on the lists on disk were 1.11's, which its join emptied,
  // and from `--start d39c2df` on they are 1.12's, which its join empties (test/l10n.languages.test.ts T14 with
  // PENDING_ALLOWED false).
  const ledgerBase = (JSON.parse(readDoc('l10n/rekey.json')) as { base: string }).base
  assert.equal(['e72057a', 'b89ff43'].includes(ledgerBase) && existsSync(join(ROOT, 'l10n/pending')) && readdirSync(join(ROOT, 'l10n/pending')).length > 0, false, 'a pending list of 1.10 or 1.11 is left')
  // development.md: the ledger's `; ` rule as the script has it, the test seam as the code gates it.
  const dev = flatText(doc.development)
  assert.ok(dev.includes('A `why` never holds `; ` — the script joins the reasons of one key with it and splits on it again —, and `--check` refuses one.'))
  assert.ok(readDoc('scripts/l10n-rekey.mjs').includes("'; '"), 'the script no longer joins reasons with "; ": say so in the docs')
  assert.ok(dev.includes('asks the extension\'s exported API, `promptSendCheck(id)`, what a send would decide with no Claude Code or Codex terminal open — `noTerminal`, nothing typed'))
  assert.ok(dev.includes('only while the extension host runs in test mode; in a normal window it answers `notListed` before reading anything'))
  assert.ok(readDoc('src/extension.ts').includes("promptSendCheck: (id: string) => (context.extensionMode !== vscode.ExtensionMode.Test"), 'the seam is no longer gated on the test mode: say so in the docs')
  assert.ok(readDoc('test-e2e/suite/index.ts').includes("'noTerminal'"), 'the e2e check no longer expects noTerminal')
  // status-bar.md: `auto` is what the code reads — Intl without a locale tag.
  assert.ok(flatText(doc.statusBar).includes('`auto` takes the hour cycle of the locale the extension host runs under — what `Intl` resolves without a locale tag, normally the operating system\'s —, not the language of Token Pace\'s texts'))
  assert.equal(flatText(doc.statusBar).includes('`auto` follows the OS locale'), false)
  assert.ok(readDoc('src/time.ts').includes("new Intl.DateTimeFormat(undefined, { hour: 'numeric' }).resolvedOptions().hourCycle"), 'the hour cycle of `auto` is read another way: say so in the docs')
  // agents.md: the 7-day block's word is the view's (1.10 B2 D6).
  const agents = flatText(doc.agents)
  for (const claim of ['Every agent entry of the seven days the tree covers', 'An agent entry is a whole agent', '(an agent\'s entry keeps no speed and no web search)']) {
    assert.ok(agents.includes(claim), `docs/agents.md does not say: ${claim}`)
  }
  assert.ok(readDoc('src/textViews.ts').includes("t('Agent entries, last 7 days')"))
  // README: the site in the top lines, the bullet, the privacy sentence, the index row; the walkthrough's row.
  const readme = flatText(README)
  assert.ok(README.split('\n').slice(0, 8).join('\n').includes('[token-pace.com](https://token-pace.com)'), 'the README does not link the site in its top lines')
  assert.ok(README.includes('* **Your own prompts, typed into Claude Code\'s terminal on a double-click.**') && readme.includes('→ [Prompts](docs/prompts.md)'))
  assert.ok(readme.includes('and a prompt of the dashboard\'s Prompts section, typed only when you double-click it and never in Restricted Mode'))
  assert.ok(readme.includes('three opt-ins, each behind its own consent dialog, all three off by default and off in Restricted Mode'))
  assert.ok(README.includes('| [Prompts](docs/prompts.md) | The dashboard\'s Prompts section: your own prompts for Claude Code\'s and Codex\'s terminals, the three shipped ones, editing, how a prompt is sent and into which terminal, when Token Pace asks first or does not send, the `/loop` variant, and where the list is kept |'))
  assert.ok(readDoc('media/walkthrough/dashboard.md').split('\n').some((l) => l.startsWith('| prompts | Your own prompts for Claude Code and Codex — not in the default')), 'media/walkthrough/dashboard.md has no prompts row')
})

// ---------------------------------------------------------------------------
// 1.11 P5 (§3 C4, C5; §0a.5): the exports' price fields and the price table's dates, from the code
// ---------------------------------------------------------------------------

test('1.11 C4: docs/export.md lists the bucket CSV\'s columns as the code writes them, says what the three price fields are and quotes their note, and states schema 4', () => {
  const flat = flatText(doc.export)
  const block = /```\n(day, hour,[\s\S]*?)```/.exec(doc.export)
  assert.ok(block, 'docs/export.md has no column block for the bucket CSV')
  assert.deepEqual(block[1].split(/[\s,]+/).filter(Boolean), [...CSV_COLUMNS])
  assert.equal(CSV_COLUMNS.indexOf('listCostUsd'), 18, 'the three columns follow the eighteen of schema 1–3')
  // The note and the hosts as the export writes them.
  const utc: TimeConfig = { zone: 'utc', dayBoundaryHour: 0, startOfWeek: 'monday', hourCycle: 'h23' }
  const j = JSON.parse(toJson(new Aggregator(), { from: '2026-09-01', to: '2026-09-01' }, sanitize({}), utc)) as { notes: string[]; pricing: { sources: string[] } }
  const note = j.notes.find((n) => n.startsWith('listCostUsd'))
  assert.ok(note, 'the export writes no note on its price fields')
  assert.ok(flat.includes(`*${note}.*`), 'docs/export.md does not quote the note on the price fields')
  assert.ok(flat.includes(`as host names: ${j.pricing.sources.map((h) => `\`${h}\``).join(', ')})`), 'docs/export.md does not list the export\'s sources')
  for (const claim of [
    `\`schema_version\` is \`${EXPORT_SCHEMA_VERSION}\` since 1.11 added \`listCostUsd\`, \`priceFrom\` and \`priceApproximate\` to \`buckets[]\`, \`listCostUsd\` to \`totals\`, and \`checked_later\` and \`sources\` to \`pricing\` (\`3\` added \`agents[]\`, \`2\` the tool table); everything versions 1–3 wrote is still there and still means the same thing`,
    'listCostUsd, priceFrom, priceApproximate', '`listCostUsd` is the same usage at the published list price — multiplier 1, no custom price —',
    'a discount against a price that was never published would be an invention', '`priceFrom` is the day the price rule used was read',
    'the borrowed model\'s under the family fallback', '`priceApproximate` is `true` where no rule covered the bucket\'s day and the nearest one was used',
    'An unpriced bucket leaves all three empty', 'the `TOTAL` row carries the list amounts of the priced buckets summed and leaves the other two empty',
    'The eighteen columns before them keep their positions', '`null`, `null` and `false` where the CSV leaves them empty', '`totals` carries `listCostUsd`',
    'every provider\'s, whatever the dashboard shows', 'the `TOTAL` row\'s `priced` column reads `lowerBound`',
  ]) assert.ok(flat.includes(claim), `docs/export.md does not say: ${claim}`)
  assert.equal(flat.includes('everything versions 1 and 2 wrote'), false, 'docs/export.md still states schema 3\'s history')
})

test('1.11 C5: docs/cost.md writes the table\'s three days from the constants, builds its footnote example from them and names every source page; the README names no price date', () => {
  const cost = flatText(doc.cost)
  for (const claim of [`**Prices as of ${longDay(PRICES_AS_OF)}**`,
    `come from an earlier check of the same table on ${longDay(LEGACY_CHECKED)}, and the **Claude Opus 5.5** row from a check of Anthropic's pricing page on **${longDay(OPUS_5_5_CHECKED)}**`,
    `its usage from the days before ${longDay(OPUS_5_5_CHECKED)} is priced from this row`]) {
    assert.ok(cost.includes(claim), `docs/cost.md does not say: ${claim}`)
  }
  // No other day in either form: a day the constants do not hold would be a stale one.
  const long = [...new Set([...cost.matchAll(/\b\d{1,2} (?:January|February|March|April|May|June|July|August|September|October|November|December) \d{4}\b/g)].map((m) => m[0]))]
  assert.deepEqual(long.sort(), [PRICES_AS_OF, LEGACY_CHECKED, OPUS_5_5_CHECKED].map(longDay).sort())
  // The footnote example, built from the constants as the page's footnote is (viewModel.ts laterChecksText).
  const later = PRICES_CHECKED_LATER.map((r) => `${r.model} (${r.checked})`).join(', ')
  const footnote = later ? `\`Prices as of ${PRICES_AS_OF}; checked later: ${later}.\`` : `\`Prices as of ${PRICES_AS_OF}.\``
  assert.ok(cost.includes(footnote), `docs/cost.md does not quote the footnote ${footnote}`)
  const iso = [...new Set([...cost.matchAll(/\b\d{4}-\d{2}-\d{2}\b/g)].map((m) => m[0]))]
  assert.deepEqual(iso.sort(), [PRICES_AS_OF, ...PRICES_CHECKED_LATER.map((r) => r.checked)].sort())
  // The pages the rules were read from, by host, and the Opus 5.5 row's own.
  for (const host of Object.values(PRICE_SOURCE_PAGES).flat()) assert.ok(cost.includes(`\`${host}\``), `docs/cost.md does not name ${host}`)
  assert.ok(cost.includes('**Claude Opus 5.5** row from a check of Anthropic\'s pricing page') && cost.includes('([platform.claude.com](https://platform.claude.com/docs/en/about-claude/pricing))'))
  assert.ok(PRICES['claude-opus-5-5'][0].source.startsWith('platform.claude.com '), 'the page names the host the row\'s source names')
  // The exports carry both amounts (§3 C4).
  for (const claim of ['The CSV and JSON [exports](export.md) carry both amounts for every bucket, whatever `showListPrice` says — `costUsd` at your configured rates and `listCostUsd` at the list price —',
    'the day of the rule each was priced by (`priceFrom`)', 'whether no rule covered its day (`priceApproximate`)',
    'Where a custom price alone prices a model the table does not know, the two amounts are the same']) {
    assert.ok(cost.includes(claim), `docs/cost.md does not say: ${claim}`)
  }
  // The README carries no price date and no "Prices as of", so nothing there can drift from the table.
  const readme = flatText(README)
  for (const day of [PRICES_AS_OF, LEGACY_CHECKED, OPUS_5_5_CHECKED]) {
    assert.equal(readme.includes(day) || readme.includes(longDay(day)), false, `README.md names the price day ${day}`)
  }
  assert.equal(/prices as of/i.test(readme), false, 'README.md dates the prices')
})

test('1.11 B6, C2, C3: docs/dashboard.md describes the Records section\'s four new tables as the page draws them, and docs/cost.md the price sources, the tooltip\'s price line and the cost head — adding no date', () => {
  const dash = flatText(doc.dashboard)
  for (const claim of ['**Records.** The `records` section — off by default —', 'at most `tokenPace.dashboard.topN` rows per table',
    '*Most expensive days* ranks the range\'s days by their API cost at your configured rates', 'a screen reader hears it as “lower bound”',
    '*Longest sessions* and *Largest sessions* rank the Claude Code sessions of the Agents section\'s last seven days that are no longer active',
    'a session still active is counted in a note and not ranked', '*Hours with the most cache written* ranks hours, not requests',
    'is headed *API cost (your rates)* while your own rates apply', 'says *Reading history…* and shows no record at all',
    'a rescan that reads fewer transcripts shows fewer records, never an old one', 'The Quick Pick and the markdown view carry the same rows']) {
    assert.ok(dash.includes(claim), `docs/dashboard.md does not say: ${claim}`)
  }
  const cost = flatText(doc.cost)
  const { PRICE_SOURCE_PAGES } = require('../src/prices') as typeof import('../src/prices')
  const { SOURCES } = require('../src/adapters') as typeof import('../src/adapters')
  // The footnote as the view model writes it under All (viewModel.ts priceSourcesText): the registry's hosts in order.
  const sources = SOURCES.flatMap((s) => PRICE_SOURCE_PAGES[s]).join(', ')
  for (const claim of [`*Price sources: ${sources}.*`, 'by host name and as text, never as a link',
    'A status-bar tooltip that prints an *API cost* column says the same under its tables, whether or not `tokenPace.tooltipExplanations` is on',
    'a Codex quota tooltip names no Claude row', 'the dashboard\'s *API cost* columns are headed *API cost (your rates)*']) {
    assert.ok(cost.includes(claim), `docs/cost.md does not say: ${claim}`)
  }
})

// ---------------------------------------------------------------------------
// 1.11 P9 — documentation, release notes, pictures (plan-1.11-build.md §4 P9).
// ---------------------------------------------------------------------------

/**
 * 1.11 P9: the 1.11.0 release notes — the newest entry with its date left for the publish, every section in order,
 * the twelve languages named as the registry has them, the pack fact and the plain statement, the four tables' titles
 * and the words the page, the bar and the settings say, the export's columns, the versions, the ledger's count read
 * from the file, and nothing the notes must not claim.
 */
test('the 1.11.0 release notes: the newest entry, its date set at publish, every section in order, the languages, the tables, the price words, the export, the versions, the ledger, nothing unverified (1.11 P9)', () => {
  const { AGENT_TABLES_REVISION } = require('../src/agg') as typeof import('../src/agg')
  const { AGENT_RETENTION_DAYS, SESSION_ACTIVE_MS } = require('../src/agentTree') as typeof import('../src/agentTree')
  const log = readDoc('CHANGELOG.md')
  const first = log.indexOf('\n## ')
  const second = log.indexOf('\n## ', first + 4)
  const entry = log.slice(first, second)
  // The release cadence: the date is set on the release branch at publish, never before.
  assert.match(entry, /^\n## 1\.11\.0 — <date set at publish>\n\n\*\*/, 'the newest CHANGELOG entry is not 1.11.0 with its date left for the publish, or does not open with its summary')
  assert.ok(log.includes('\n## 1.10.0 — <date set at publish>\n'), 'the 1.10.0 entry is gone or dated')
  const flat = flatText(entry)
  const heads = ['### Added', '### Changed', '### Fixed', '### Privacy', '### Internal']
  const order = heads.map((h) => flat.indexOf(h))
  assert.ok(order.every((i) => i > 0) && order.every((i, k) => k === 0 || i > order[k - 1]), 'the 1.11.0 entry\'s sections are missing or out of order')
  const section = (h: string): string => { const at = heads.indexOf(h); return flat.slice(order[at], at + 1 < heads.length ? order[at + 1] : undefined) }
  // The twelve languages of 1.11, named in their own names in the registry's order — in the summary and in Added.
  assert.equal(LANGUAGES.length, 26)
  const twelve = LANGUAGES.slice(14).map((e) => e.native)
  assert.equal(twelve.length, 12)
  const named = `${twelve.slice(0, -1).join(', ')} and ${twelve[twelve.length - 1]}`
  assert.equal(flat.split(named).length - 1, 2, `the 1.11.0 entry does not name the twelve languages twice as the registry has them: ${named}`)
  for (const claim of ['twenty-six languages, twenty-seven lines in the list with *Automatic*', 'VS Code has a language pack for Hungarian only (last updated for VS Code 1.48, 2020)',
    'Norwegian is Bokmål (`nb`)', 'Token Pace ships none',
    '**These translations were made by AI agents (Claude Opus 5.5) from the English text, with the German as a second reference, and checked by tests for completeness, placeholders, marks, the settings\' status-bar examples and freshness — not by native speakers**',
    'not verified against a style guide', 'a wrong or clumsy word is a bug to report']) {
    assert.ok(section('### Added').includes(claim), `the 1.11.0 entry does not say: ${claim}`)
  }
  // The four tables' titles and the words of the page, as the code has them (a German for each: a key of the bundle).
  for (const en of ['Most expensive days', 'Longest sessions', 'Largest sessions', 'Hours with the most cache written', 'API cost (your rates)', 'Price sources: {0}.',
    'Reading history…', 'What the same tokens would have cost through the API at your configured rates', 'lower bound']) {
    assert.equal(typeof GERMAN[en], 'string', `${en} is not a text of the code`)
  }
  const added = section('### Added')
  assert.ok(added.includes('*Most expensive days*') && added.includes('*Longest sessions* and *Largest sessions*') && added.includes('*Hours with the most cache written*'))
  assert.ok(added.includes(`the Claude Code sessions of the last ${AGENT_RETENTION_DAYS} days that are no longer active — no counted line for ${SESSION_ACTIVE_MS / 60_000} minutes`))
  assert.ok(added.includes('`Tue 14:20 · 9d0eb37a`') && added.includes('`tokenPace.dashboard.topN` rows each'))
  const changed = section('### Changed')
  assert.ok(changed.includes('*API cost (your rates)*') && changed.includes('*what the same tokens would have cost through the API at your configured rates*') && changed.includes('*Reading history…*'))
  // The price sources as the view model joins them: the hosts of the registry, in order — and the Claude hosts alone in a Claude tooltip.
  const sources = SOURCES.flatMap((s) => PRICE_SOURCE_PAGES[s]).join(', ')
  assert.ok(changed.includes(`*Price sources: ${sources}.*`) && changed.includes(`*Price sources: ${PRICE_SOURCE_PAGES.claude.join(', ')}.*`))
  // The export's columns, as the code writes them, and the manifest's `auto` sentence.
  assert.deepEqual(CSV_COLUMNS.slice(-3), ['listCostUsd', 'priceFrom', 'priceApproximate'])
  for (const field of ['the CSV gains `listCostUsd`', '`priceFrom`', '`priceApproximate`', '`checked_later`', '`sources`', '`listCostUsd` in `totals`']) assert.ok(changed.includes(field), `the 1.11.0 entry does not name ${field}`)
  assert.ok(changed.includes(`*${nlsEn['config.resetHourCycle.enum.auto']}*`), 'the 1.11.0 entry does not quote the manifest\'s auto sentence')
  // The CJK "both" examples are what each language's manifest quotes of its bar.
  const fixed = section('### Fixed')
  for (const [id, example] of [['ja', '06:00 にリセット（2h14m 後）'], ['ko', '06:00 초기화(2h14m 후)'], ['zh-cn', '06:00 重置（2h14m 后）'], ['zh-tw', '06:00 重設（2h14m 後）']] as const) {
    assert.ok((JSON.parse(readDoc(`package.nls.${id}.json`)) as Record<string, string>)['config.resetFormat.enum.both'].includes(example), `${id}'s manifest does not quote ${example}`)
    assert.ok(fixed.includes(`\`${example}\``), `the 1.11.0 entry does not quote ${example}`)
  }
  assert.ok(fixed.includes('one space after a plain colon and none after a full-width one') && fixed.includes('"before it resets (reset due)"'))
  assert.ok(readDoc('src/alerts.ts').includes('c.window.resetsAt <= now'), 'the reset-due guard is gone from alerts.ts')
  // Privacy: the file count from the registry, the session name, the export's fields.
  const privacy = section('### Privacy')
  assert.equal(LANGUAGES.length - 1, 25)
  assert.ok(privacy.includes('twenty-five translation files in all'))
  assert.ok(privacy.includes('a weekday, a time and the first eight characters of the session id; never a project or a path'))
  assert.ok(privacy.includes('never a path, a URL with a path, or a session or project name the export did not already carry'))
  // The versions it names are the code's.
  const internal = section('### Internal')
  assert.deepEqual([STATE_VERSION, EXPORT_SCHEMA_VERSION, AGENT_TABLES_REVISION], [8, 4, 10])
  assert.ok(internal.includes(`\`STATE_VERSION\` ${STATE_VERSION} and \`AGENT_TABLES_REVISION\` ${AGENT_TABLES_REVISION} are unchanged`))
  assert.ok(internal.includes(`\`EXPORT_SCHEMA_VERSION\` ${RELEASED_1_10.EXPORT_SCHEMA_VERSION} → ${EXPORT_SCHEMA_VERSION}`))
  for (const m of flat.matchAll(/`(STATE_VERSION|AGENT_TABLES_REVISION)` (\d+)/g)) {
    assert.equal(Number(m[2]), m[1] === 'STATE_VERSION' ? STATE_VERSION : AGENT_TABLES_REVISION, `the 1.11.0 entry says ${m[1]} ${m[2]}`)
  }
  // The ledger's count, and its base the 1.10.0 release. 1.12 P1 (pinned and changed: the count read from l10n/rekey.json,
  // its base b89ff43): `l10n-rekey.mjs --start d39c2df` began 1.12's ledger and emptied the entries, so 1.11's count is
  // history — the 67 entries of l10n/rekey.json at d39c2df (base b89ff43), a literal from here on.
  assert.ok(internal.includes('1.11\'s holds 67 entries since the 1.10.0 release'), '1.11\'s ledger held 67 entries')
  assert.ok(internal.includes('197 values in 23 of the 24 languages'))
  // Claims the notes must not make: nothing beyond an AI agent's reading; no Codex send tried; no path, file, secret or date of the machine.
  for (const never of [/professional/i, /native[- ]quality/i, /proofread/i, /certified/i, /fluent/i, /review/i, /tried with Codex/i, /tested with Codex/i]) {
    assert.equal(never.test(entry), false, `the 1.11.0 entry says ${never}`)
  }
  for (const never of [/\/home\//, /plan-1\.\d+/, /\.claude\/projects/, /VSCE_PAT|OVSX_PAT/, /research\//, /[A-Za-z]:\\/, /\/tmp\//, /package\.json/, /worktree/i, /Review [12L]\b/, /\d{4}-\d{2}-\d{2}/]) {
    assert.equal(never.test(entry), false, `the 1.11.0 entry mentions ${never}`)
  }
  // The old counts and the old claims stand nowhere a reader looks (§4 P9 item 4).
  for (const [name, text] of [['CHANGELOG.md 1.11.0', entry], ['docs/languages.md', doc.languages], ['docs/dashboard.md', doc.dashboard], ['docs/settings.md', doc.settings],
    ['docs/commands.md', doc.commands], ['docs/troubleshooting.md', doc.troubleshooting], ['docs/privacy.md', doc.privacy], ['docs/prompts.md', doc.prompts], ['docs/status-bar.md', doc.statusBar],
    ['docs/numbers.md', doc.numbers], ['docs/development.md', doc.development], ['README.md', README], ['media/walkthrough/dashboard.md', readDoc('media/walkthrough/dashboard.md')]] as const) {
    for (const stale of ['fourteen languages', 'twelve languages beyond', 'a known limit of 1.10', 'Follow the display locale', 'the fifteen values', 'fourteen of them', 'the fourteen ids', 'one of fourteen languages', 'the-fourteen-languages']) {
      assert.equal(flatText(text).includes(stale), false, `${name} still says: ${stale}`)
    }
  }
  assert.equal(nlsEn['config.resetHourCycle.enum.auto'].includes('display locale'), false)
})

/**
 * 1.11 P9: the sentences the documentation package added where a reader looks — the languages page (the twenty-six,
 * the pack fact, the register, the three native "prompt" words, the key names, the fonts, the stacked label's one gap,
 * the type-ahead), privacy.md (§0a.1, §0a.2, §0a.5), counting.md (§0a.3), prompt-cache.md (B10), status-bar.md (C2),
 * development.md (C5 rule 4), cost.md (Review 2 F2, F3), the README, commands.md, troubleshooting.md, the walkthrough
 * and the brief's pattern-key note — each held to the code where the code decides it — and the store picture of the
 * picker at its release length.
 */
test('the pages carry the sentences of the 1.11 documentation package, held to the code (1.11 P9)', () => {
  const languages = flatText(doc.languages)
  const bundle = (id: string): Record<string, string> => JSON.parse(readDoc(`l10n/bundle.l10n.${id}.json`)) as Record<string, string>
  for (const claim of [
    // The twenty-six, the picker's length, the type-ahead as the page's own rule.
    'come in twenty-six languages: English and German, and since 1.9.0 twelve more', 'and since 1.11.0 twelve more again — Nederlands, Українська, Svenska, Norsk, Dansk, Suomi, हिन्दी, Bahasa Indonesia, Tiếng Việt, Ελληνικά, Magyar and Română',
    'in the order of the table below — twenty-seven lines', 'A list taller than the window scrolls inside its box, the two lines under it staying in view',
    'Typing a letter — without Ctrl, Alt or ⌘ — moves the focus to the next line after the focused one whose own name or name in your language begins with it, round the list',
    'on an English page `h` reaches *हिन्दी* (Hindi), then *Magyar* (Hungarian); a letter no name begins with moves nothing, and typing chooses nothing either — Enter or Space does',
    // The pack fact (§3 A6, §7a Q20; Review L F2 and R3: hu HAS a pack, of 2020) and Bokmål (§7a Q12).
    'VS Code has a language pack for Hungarian; for the other eleven — Dutch, Ukrainian, Swedish, Norwegian, Danish, Finnish, Hindi, Indonesian, Vietnamese, Greek and Romanian — it has none, so `auto` shows English there and the settings stay in VS Code\'s language',
    'VS Code\'s Hungarian language pack was last updated for VS Code 1.48 (2020)', 'Norwegian is Bokmål — the id is `nb`, the list says *Norsk* —', 'Token Pace maps neither `no` nor `nn` onto it',
    // The table's paragraph, the flags of the new languages, the fonts (§7a Q20).
    'are new in 1.11.0. Norwegian (`nb`) is Bokmål.', 'Hindi carries India\'s, Greek Greece\'s, Ukrainian Ukraine\'s and Norwegian Norway\'s',
    '**Fonts.** Token Pace ships no font', 'A system without a font for one of these scripts shows boxes in their place; the words are right, the font is missing. The flag switches back at once, or set `tokenPace.language`',
    // Numbers: the clocks and the grouping the locales print (checked below).
    'Hindi groups by lakh (`12,34,567`) and keeps the decimal point', 'Danish, Finnish and Indonesian write `06.00` with a full stop, Hungarian puts the 12-hour mark in front (`de. 06:00`)',
    'None of the twelve languages of 1.11 puts the sign first',
    // The stacked label's one gap (D1) — the old limit is gone.
    'Since 1.11 the page puts one space after a plain colon and none after a full-width one, whose glyph carries its own blank, so the gap before the value is one gap in every language',
    // How the translations were made: the twelve of 1.11, the twelve of 1.9 through the ledger, the reading pass, the open questions (D13), the register (§7a Q16), the terms, the key names (D5).
    'were each translated whole by an AI agent (Claude Opus 5.5) from the English text as it stood when 1.11\'s English was frozen, with the German as a second reference, and checked by the same tests',
    'every settings sentence — **not by native speakers**', 'The twelve languages of 1.9 worked through 1.11\'s ledger of English changes the same way (Claude Opus 5.5 and Claude Fable 5.1)',
    'A reading pass by further AI agents followed, one per language, none of them a native speaker either; what it found was applied where the reader named a fact of the language — a gender, a case, what a pronoun refers to — and left as it was otherwise',
    'The open questions the 1.10 readers left for native speakers are not answered in 1.11 either',
    '**Register.** Each language addresses you as its software does: Ukrainian *ви*, Hindi *आप*, Indonesian *Anda*, Greek the plural of politeness, Romanian the *dumneavoastră* forms, Hungarian the *Ön* forms or an impersonal one, Finnish passive and impersonal forms, Vietnamese no pronoun where a sentence can do without one, and Dutch *je*, Swedish, Norwegian and Danish *du*',
    'The register was chosen by the agents that translated, from common usage, not verified against a style guide',
    'Of the twelve of 1.11 three say it in their own word — Finnish *kehote*, Greek *προτροπή*, Vietnamese *lời nhắc* —; the other nine keep the loanword',
    'the twelve languages of 1.11 write the label as VS Code shows it in every language — `Enter`, `Ctrl+Enter`, `⌘+Enter` —, with the language\'s word for "key" around it where a sentence needs one',
  ]) assert.ok(languages.includes(claim), `docs/languages.md does not say: ${claim}`)
  assert.ok(doc.languages.includes('\n## The twenty-six languages\n'))
  // The facts behind them: the registry, the page's type-ahead rule, the locales, the bundles' words.
  assert.deepEqual(LANGUAGES.slice(14).map((e) => e.id), ['nl', 'uk', 'sv', 'nb', 'da', 'fi', 'hi', 'id', 'vi', 'el', 'hu', 'ro'])
  assert.deepEqual(['hi', 'el', 'uk', 'nb'].map((id) => LANGUAGES.find((e) => e.id === id)?.flag), ['in', 'gr', 'ua', 'no'])
  assert.deepEqual([autoLanguage('no', LANGUAGE_IDS), autoLanguage('nn', LANGUAGE_IDS), autoLanguage('nb-no', LANGUAGE_IDS)], ['en', 'en', 'nb'])
  const main = readDoc('src/webview/main.ts')
  assert.ok(main.includes('function langKeyMove(') && main.includes('whose own name or name in the reader\'s language starts with it'), 'the type-ahead rule of main.ts changed: say so in the docs')
  assert.ok(main.includes('const FULL_WIDTH_END = '), 'dh() no longer tells a full-width colon from a plain one: say so in the docs')
  const clock = (tag: string, cycle: 'h12' | 'h23'): string => new Intl.DateTimeFormat(tag, { hour: '2-digit', minute: '2-digit', hourCycle: cycle, timeZone: 'UTC' }).format(new Date(Date.UTC(2026, 8, 1, 6, 0)))
  assert.deepEqual(['da', 'fi', 'id'].map((tag) => clock(tag, 'h23')), ['06.00', '06.00', '06.00'])
  assert.equal(clock('hu', 'h12'), 'de. 06:00')
  assert.equal(underLocale('hi', () => full(1_234_567)), '12,34,567')
  for (const id of LANGUAGES.slice(14).map((e) => e.id)) {
    const b = bundle(id)
    assert.deepEqual(Object.keys(b).filter((k) => /\{\d\} %/.test(k) && /%\s?\{\d\}/.test(b[k])), [], `${id} writes the percent first`)
  }
  assert.deepEqual([bundle('fi').Prompts, bundle('el').Prompts, bundle('vi').Prompts], ['Kehotteet', 'Προτροπές', 'Lời nhắc'])
  for (const id of ['nl', 'sv', 'nb', 'da', 'id', 'hu', 'ro']) assert.match(bundle(id).Prompts, /^Prompt/, `${id} does not keep the loanword`)
  assert.match(bundle('hi').Prompts, /^प्रॉम्प्ट/)
  assert.match(bundle('uk').Prompts, /^Промпт/)
  assert.equal(bundle('ja')['{0}:'], '{0}:')
  // privacy.md: §0a.1 (the file count from the registry), §0a.2 (Review 2's sentence), §0a.5 (the export's fields).
  const privacy = flatText(doc.privacy)
  assert.equal(LANGUAGES.length - 1, 25)
  for (const claim of ['one of the twenty-five translation files it ships, with the translations of its own texts and nothing of yours',
    'the Records\' longest and largest sessions are named by a weekday, a time and the first eight characters of the session id — never a project or a path; a test puts a project name into the index\'s key and an agent\'s file and finds it in no record, no Quick Pick item, no markdown document and no export',
    '**What an export adds in 1.11.** Per bucket the list amount, the day of the price rule it was priced by and whether no rule covered its day (`listCostUsd`, `priceFrom`, `priceApproximate`), the list total, and in the JSON the price rows checked after the table\'s day and the pages the table was read from (`pricing.checked_later`, `pricing.sources`)',
    'never a path, a URL with a path, or a session or project name the export did not already carry']) {
    assert.ok(privacy.includes(claim), `docs/privacy.md does not say: ${claim}`)
  }
  assert.ok(readDoc('test/records.test.ts').includes('synthetic-project-123'), 'the §0a.2 leak test is gone')
  // counting.md (§0a.3), prompt-cache.md (B10), status-bar.md (C2), cost.md (Review 2 F2, F3).
  assert.ok(flatText(doc.counting).includes('The Records section\'s *Hours with the most cache written* (1.11) ranks these UTC hour buckets — shown in the configured zone — by the tokens written to the prompt cache, hours rather than requests: the buckets keep no single request, an hour can hold several writes, and a large cache write is usually a cold start, a new conversation or a compaction'))
  assert.ok(flatText(doc.promptCache).includes('The dashboard\'s Records section ranks the hours with the most cache written — the hour buckets by the tokens written to that cache, hours rather than requests; a large write is usually a cold start, a new conversation or a compaction ([Dashboard](dashboard.md))'))
  assert.equal(typeof GERMAN['A large cache write is usually a cold start — a conversation\'s prefix written to the cache again after it expired —, a new conversation or a compaction; one hour can hold several.'], 'string')
  const bar = flatText(doc.statusBar)
  assert.ok(bar.includes('Neither is the price line (1.11): under every token table with an *API cost* column — the quota entries\', the tokens and cost entries\', the budget entry\'s — one italic line names the day the price table was checked, the rows checked later, *your configured rates* while a multiplier or custom prices apply, and the pages the tooltip\'s own providers\' prices were read from, by host name'))
  assert.ok(bar.includes(`*Prices as of …; checked later: … Price sources: ${PRICE_SOURCE_PAGES.claude.join(', ')}.*`))
  const statusText = readDoc('src/statusText.ts')
  assert.equal((statusText.match(/priceLine\(ctx, /g) ?? []).length, 4, 'the tooltips print the price line in another number of places: say so in the docs')
  assert.ok(statusText.includes("if (rows.some((b) => b.unit === 'usd')) out.push(...priceLine(ctx, scopeSources(cfg)))"), 'the budget tooltip no longer prints the price line for a money budget')
  const cost = flatText(doc.cost)
  assert.ok(cost.includes('the key figures\' *API equivalent* card explains itself as *what the same tokens would have cost through the API at your configured rates*, every status-bar tooltip with a cost — the budget entry\'s included — says *your configured rates* in its price line'))
  assert.ok(readDoc('src/stats.ts').includes("t('What the same tokens would have cost through the API at your configured rates')"))
  // development.md: the price table's ledger is the CHANGELOG (C5 rule 4), the constants named as exported.
  const dev = flatText(doc.development)
  assert.ok(doc.development.includes('\n## The price table\n'))
  for (const claim of ['**A re-check of the table, or a new row, is a CHANGELOG line**: the CHANGELOG is the table\'s ledger',
    '`PRICES_AS_OF` is the day the table was checked whole, `LEGACY_CHECKED` the earlier check of the Claude 4.x and 3.x rows, `OPUS_5_5_CHECKED` the day of the Claude Opus 5.5 row',
    'a rule closed without a successor only when `CLOSED_ON_PURPOSE` names it with a comment']) {
    assert.ok(dev.includes(claim), `docs/development.md does not say: ${claim}`)
  }
  const prices = readDoc('src/prices.ts')
  for (const name of ['export const PRICES_AS_OF', 'export const LEGACY_CHECKED', 'export const OPUS_5_5_CHECKED', 'export const PRICES_CHECKED_LATER', 'export const PRICE_SOURCE_PAGES']) assert.ok(prices.includes(name), `${name} is gone from prices.ts`)
  assert.ok(readDoc('test/prices.test.ts').includes('const CLOSED_ON_PURPOSE'))
  // The README: the bullet with every native name in the registry's order, the Records bullet, the index rows, the picture's alt text.
  const readme = flatText(README)
  const natives = LANGUAGES.map((e) => e.native)
  assert.ok(readme.includes(`— to ${natives.slice(0, -1).join(', ')} or ${natives[natives.length - 1]}, or to VS Code's display language`), 'the README bullet does not name the twenty-six as the registry has them')
  for (const claim of ['* **Twenty-six languages.**', 'The twenty-four beyond English and German were translated by AI agents and checked by tests, not by native speakers',
    'the fixed-period token totals and, off by default, the Records — since 1.11 the most expensive days, the longest and largest Claude Code sessions and the hours with the most cache written. → [Dashboard](docs/dashboard.md)',
    'the twenty-six languages and their flags, the notation that stays the same, and how the translations were made |',
    'The dated price table and the pages it was read from, your own rates and the list price beside them, the family fallback, and what the figure is not |',
    'down to Română · Romanian — twenty-seven lines, each with its flag']) {
    assert.ok(readme.includes(claim), `README.md does not say: ${claim}`)
  }
  // The store picture of the picker shows the whole list (§4 P9): 840 px wide, tall enough for twenty-seven lines.
  const png = readFileSync(join(ROOT, 'media/screenshot-languages.png'))
  assert.equal(png.readUInt32BE(16), 840)
  assert.ok(png.readUInt32BE(20) >= 1500, `media/screenshot-languages.png is ${png.readUInt32BE(20)} px tall — the list of twenty-seven lines needs more`)
  // commands.md, troubleshooting.md, the walkthrough, prompts.md — and every language translates the shipped prompt's title.
  assert.ok(flatText(doc.commands).includes('`auto`, the default, or one of twenty-six languages') && flatText(doc.commands).includes('German, the twelve languages of 1.9 and the twelve of 1.11 ([Languages](languages.md))'))
  assert.ok(doc.troubleshooting.includes('[the table](languages.md#the-twenty-six-languages)'))
  assert.ok(flatText(readDoc('media/walkthrough/dashboard.md')).includes('twenty-six of them, or *Automatic*'))
  assert.ok(flatText(doc.prompts).includes('and likewise in each of the other twenty-four languages; the German status prompt keeps the author\'s own wording, the twenty-four translate the English'))
  for (const id of LANGUAGES.slice(1).map((e) => e.id)) assert.equal(typeof bundle(id)['Status table'], 'string', `${id} does not translate the shipped prompt's title`)
  // The brief's pattern-key note says what the Japanese files do (L6: ja keeps the ASCII colon).
  const brief = flatText(readDoc('l10n/TRANSLATING.md'))
  assert.ok(brief.includes('`{0}：` in Chinese (Japanese writes the ASCII colon `{0}:`, as its sentences do), `（）` around a figure in Chinese and Japanese'))
  assert.equal(brief.includes('`{0}：` in Chinese and Japanese'), false)
  // dashboard.md and settings.md: the count words and the type-ahead.
  assert.ok(flatText(doc.dashboard).includes('then the twenty-six languages, each with its flag') && flatText(doc.dashboard).includes('A letter moves the focus to the next language whose own name or name in your language begins with it, round the list, and chooses nothing'))
  assert.ok(doc.settings.includes('The settings UI offers the twenty-seven values as a list') && doc.settings.includes('The twenty-four languages beyond English and German were translated by AI agents'))
  assert.equal(properties['tokenPace.language'].enum?.length, 27)
})

test('the Codex app-server section says what the standing connection does — the default, the lease, the three methods, the reads, the pushes, the restarts and their hour, the ends, the diagnostics line — and the other pages point at it (1.12 A7)', () => {
  const quota = flatText(doc.quotaSources)
  const at = quota.indexOf('## The Codex app-server')
  assert.ok(at >= 0, 'docs/quota-sources.md has no "The Codex app-server" section')
  assert.equal(quota.includes('**Persistent app-server.**'), false, 'the 1.x opt-in paragraph is still there')
  const section = quota.slice(at, quota.indexOf('## Writing the cache file', at))
  for (const claim of [
    '`tokenPace.codexAppServer.mode: persistent` — the default since 1.12',
    'in the window that holds the lease', 'with `tokenPace.leaderElection: false` every window fetches and keeps its own',
    'Three methods are sent and nothing else: `initialize`, `initialized` and `account/rateLimits/read`',
    'Nothing of the answer to `initialize` is kept', 'no line of its output reaches the log',
    'A fetch due while the child is starting waits for it; one due while it is restarting starts one child of its own, once',
    'moves the next scheduled fetch a whole interval on', 'Pushes, where Codex sends them',
    'started again after 5 seconds, the wait doubling up to 5 minutes', 'After five restarts within an hour',
    'until the oldest of the five is an hour old', 'ended with `SIGKILL`', 'when another window takes over fetching',
    '*Reset Network Access Decision*', 'the mode or `tokenPace.codexBinary` changes',
    '`codex connection — mode persistent · state ready · restarts 0 in the last hour · pushes 3 · last push 42 s ago`',
    '`codex: app-server ready`', '`codex: app-server exited — restart in 10 s`', '`codex: quota fetched over the connection`',
    'A consent given before 1.12 stays valid',
    'The standing connection was tested against a stand-in app-server, not against a signed-in Codex, by the author.',
  ]) assert.ok(section.includes(claim), `docs/quota-sources.md's Codex app-server section does not say: ${claim}`)
  // The states it names are the connection's, and a follower's.
  const src = readDoc('src/appServer.ts')
  const m = /export type AppServerState = ([^\n]+)/.exec(src)
  assert.ok(m, 'src/appServer.ts no longer declares AppServerState')
  const states = [...m[1].matchAll(/'([a-zA-Z]+)'/g)].map((x) => x[1])
  assert.deepEqual(states, ['off', 'starting', 'ready', 'restarting', 'budgetSpent'])
  for (const s of [...states, 'follower']) assert.ok(section.includes(`\`${s}\``), `the section does not name the state ${s}`)
  // The pages beside it.
  assert.ok(doc.settings.includes('| `codexAppServer.mode` | `persistent` |'), 'docs/settings.md does not show the new default')
  assert.equal(properties['tokenPace.codexAppServer.mode'].default, 'persistent')
  assert.ok(flatText(doc.privacy).includes('kept running while this window leads and fetches, and asked over that one connection'), 'docs/privacy.md has no Codex sentence')
  const trouble = flatText(doc.troubleshooting)
  assert.ok(trouble.includes('## The Codex app-server') && trouble.includes('| `state budgetSpent` | The app-server restarted too often — five times within an hour; for the rest of the hour each fetch starts it once'), 'docs/troubleshooting.md has no budgetSpent row')
  assert.ok(flatText(doc.statusBar).includes('the Codex entry\'s figure may change between two fetches, when Codex pushes an update — nothing else of the entry changes'), 'docs/status-bar.md does not say a push may change the figure')
})

test('alerts and notifications are two words for two things on the pages: the Alerts section says so, the settings page has the Notifications table, the privacy page names the payload\'s allow-list (1.12 C0, C5, §0a.10)', () => {
  const alerts = flatText(doc.budgetsAlerts.slice(doc.budgetsAlerts.indexOf('\n## Alerts')))
  assert.ok(alerts.includes('An **alert** is the popup inside VS Code that the `tokenPace.alerts.*` settings control. A **notification** (1.12) is something else: a message Token Pace sends outside VS Code'),
    'docs/budgets-alerts.md does not tell an alert from a notification')
  assert.ok(alerts.includes('the same threshold crossing may raise both — each once'), 'docs/budgets-alerts.md does not say both may speak')
  // The Alerts section's own sentences say alert: the only notifications there are the ones it tells apart.
  const words = alerts.replace(/tokenPace\.notifications\.\*|settings\.md#notifications-phone-chat-e-mail/g, '')
  assert.equal((words.match(/notification/gi) ?? []).length, 1, 'docs/budgets-alerts.md still calls an alert a notification')
  // The settings page: its own section after Alerts, every key machine-scoped and none a secret.
  const settings = doc.settings
  const at = settings.indexOf('\n## Notifications (phone, chat, e-mail)')
  assert.ok(at > settings.indexOf('\n## Alerts') && at < settings.indexOf('\n## Diagnostics'), 'docs/settings.md has no Notifications section between Alerts and Diagnostics')
  const section = flatText(settings.slice(at, settings.indexOf('\n## Diagnostics')))
  assert.ok(section.includes('All eight settings are machine-scoped') && section.includes('None of them holds a secret'))
  assert.ok(section.includes('| `notifications.channels` | `[]` |') && section.includes('**Empty means nothing is ever sent.**'))
  assert.ok(section.includes('| `notifications.events` | `[agentWaiting, agentDone, quotaThreshold, quotaExhausted, paceWarning]` |'))
  // The privacy page: the source, the twelve fields the builder reads, and what never goes into a message.
  const privacy = flatText(doc.privacy)
  assert.ok(privacy.includes('**Notifications, since 1.12.**') && privacy.includes('the notification payload\'s allow-list'))
  assert.ok(privacy.includes('Never a prompt, a title of the Prompts section, a line of a transcript, a path, a folder or project name, a session\'s id or name, an agent\'s id or type, a plan name, an account, a token count or a cost'),
    'docs/privacy.md does not say what a notification never holds')
  assert.ok(privacy.includes('A session\'s id is kept in memory only, as the key of the notifier\'s own table'))
})
