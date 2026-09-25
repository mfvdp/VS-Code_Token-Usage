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
  AGENT_ID_MAX_CHARS, AGENT_MODEL_MAX_CHARS, AGENT_NAME_MAX_CHARS, AGENT_TABLES_REVISION, JOURNAL_PARSE_MAX, outcomeOfStatus, PENDING_MODE_MAX,
  STOP_REASONS, USER_LINE_LITERAL,
} from '../src/agg'
import { usedThresholds } from '../src/alerts'
import { readPaceConfig, sanitize } from '../src/config'
import { disclosure } from '../src/consent'
import { AGENTS_CSV_COLUMNS, EXPORT_SCHEMA_VERSION } from '../src/exporter'
import { PaceConfig, paceVerdict } from '../src/pace'
import { OPUS_5_5_CHECKED, PRICES, PRICES_AS_OF, priceOf } from '../src/prices'
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
  // 1.8 P10 (§0a.7, pinned and changed): the keep-warm accounting joins the list.
  const keys: StoredKey[] = ['state', 'quota', 'history', 'mirror', 'hookMirror', 'keepWarm']
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

test('docs/dashboard.md and docs/numbers.md name the subagent share of a window and the records against the buckets, as the views write them', () => {
  // 1.6 N7 (P10b): the words the view model, the markdown and the page write, taken from the sources that write them.
  const model = readDoc('src/viewModel.ts')
  const text = readDoc('src/textViews.ts')
  const page = readDoc('src/webview/main.ts')
  for (const [src, written] of [
    [model, 'Subagents {0} of {1} counted here ({2})'],
    [model, 'The two differ by construction: a record keeps a whole agent, a bucket the hour of each reply.'],
    [text, '{0}: subagents {1} of {2} counted here ({3})'],
    [page, 'Agent records, last 7 days'], [page, 'Subagent tokens in the hour buckets, last 7 days'],
  ] as Array<[string, string]>) assert.ok(src.includes(`'${written}'`), `a source no longer writes: ${written}`)
  const dash = readDoc('docs/dashboard.md').replace(/\s+/g, ' ')
  for (const claim of ['`Subagents 4.7M of 5.5M counted here (86 %)`', '`5 h: subagents 4.7M of 5.5M counted here (86 %)`',
    'a share of **tokens**, never of the quota', 'never moves the window\'s percentage', 'both figures carry `≈`',
    'every Codex window have no such line', '`Current 5 h window` and `Current 7 d window`', '`<1 %` or `>99 %`',
    '`Agent records, last 7 days`', '`Subagent tokens in the hour buckets, last 7 days`',
    '*the two differ by construction: a record keeps a whole agent, a bucket the hour of each reply*']) {
    assert.ok(dash.includes(claim), `docs/dashboard.md does not say: ${claim}`)
  }
  const numbers = doc.numbers.replace(/\s+/g, ' ')
  for (const claim of ['| Subagent share of a Claude window (`Subagents 4.7M of 5.5M counted here (86 %)`) |',
    'A share of tokens, **never of the quota**', '`≈` on both figures', 'Claude only',
    '| Agent records against subagent hour buckets (data quality) |', 'a record keeps a whole agent, a bucket the hour of each reply',
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
  for (const line of disclosure(30).split('\n')) {
    if (line.trim() === '') continue
    assert.ok(step.includes(line), `media/walkthrough/quota.md no longer says: ${line}`)
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
  // now that the code's is 9.
  for (const claim of ['1.5.0 and 1.5.1 were committed but never published; their changes ship here.',
    `(\`STATE_VERSION\` ${STATE_VERSION})`, '(`AGENT_TABLES_REVISION` 8)',
    'the first start after the upgrade replays the agent tables once', `\`agents[]\` (\`schema_version\` ${EXPORT_SCHEMA_VERSION})`,
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
    `\`STATE_VERSION\` ${STATE_VERSION}, \`AGENT_TABLES_REVISION\` ${RELEASED_1_7.AGENT_TABLES_REVISION} and the export's \`schema_version\` ${EXPORT_SCHEMA_VERSION} (\`EXPORT_SCHEMA_VERSION\` ${EXPORT_SCHEMA_VERSION}) are the values 1.6.0 wrote, unchanged`,
    'the update replays nothing and re-reads nothing',
    'Nothing new is read from any Claude Code or Codex file, and the read contract is unchanged.',
    'never a credential, a header or an exception\'s text',
  ]) assert.ok(flat.includes(claim), `the 1.7.0 entry does not say: ${claim}`)
  // Every version the entry names is the one 1.7.0 shipped: no bump is claimed. 1.8 P5 (pinned and
  // changed): the code's revision is 9 since, so the entry is held to 1.7.0's values, the two
  // unchanged ones still read from the code.
  for (const m of flat.matchAll(/`(STATE_VERSION|AGENT_TABLES_REVISION|EXPORT_SCHEMA_VERSION)` (\d+)/g)) {
    const actual = { STATE_VERSION, AGENT_TABLES_REVISION: RELEASED_1_7.AGENT_TABLES_REVISION, EXPORT_SCHEMA_VERSION }[m[1] as 'STATE_VERSION']
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
  // docs/counting.md and docs/agents.md: the revision 1.8.0 raised, and why.
  const counting = flat(doc.counting)
  assert.ok(counting.includes(`— ${AGENT_TABLES_REVISION} in 1.8.0, 8 in 1.6.0 and 1.7.0 —`), 'docs/counting.md does not state 1.8.0\'s revision')
  assert.ok(counting.includes('1.8.0 raised it to 9 for the [prompt-cache estimate](prompt-cache.md#how-the-estimate-is-made)'),
    'docs/counting.md does not say why the revision rose')
  assert.ok(flat(doc.agents).includes(`revision **${AGENT_TABLES_REVISION}** in 1.8.0`), 'docs/agents.md does not state 1.8.0\'s revision')
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
  for (const claim of [`${usd(row.input)} per million input tokens, ${usd(row.cacheWrite5m)} for a 5-minute cache write, ${usd(row.cacheWrite1h)} for a 1-hour cache write, ${usd(row.cacheRead)} for a cache hit and ${usd(row.output)} for output; fast mode ${usd(row.fast!.input)} in and ${usd(row.fast!.output)} out`,
    'the **Claude Opus 5.5** row from a check of Anthropic\'s pricing page on **24 September 2026**', 'priced from this row and marked `approximate`',
    'Opus 5.5 reads it at $0.20/MTok (0.05×)', '**Prices as of 6 September 2026**']) {
    assert.ok(cost.includes(claim), `docs/cost.md does not say: ${claim}`)
  }
  assert.equal(PRICES_AS_OF, '2026-09-06', 'the page\'s "Prices as of" date is the table\'s')
  assert.equal(OPUS_5_5_CHECKED, '2026-09-24', 'the page\'s Opus 5.5 check day is the row\'s')
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
  assert.ok(flat(doc.privacy).includes('Those two facts serve only the checks of the opt-in [keep-warm line](prompt-cache.md#keep-warm-in-a-terminal-opt-in)'))
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
  assert.ok(flat(STATES).includes('Keep-warm line for Session Tue 14:20 · 9d0eb37a in 42 seconds, activate to cancel'))
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
const RELEASED_1_8 = { AGENT_TABLES_REVISION: 9 } as const

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
  const first = log.indexOf('\n## ')
  const second = log.indexOf('\n## ', first + 4)
  const entry = log.slice(first, second)
  assert.match(entry, /^\n## 1\.8\.0 — 2026-09-25\n\n\*\*/, 'the newest CHANGELOG entry is not 1.8.0 of 2026-09-25, or does not open with its summary')
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
    `\`STATE_VERSION\` ${STATE_VERSION} and the export's \`schema_version\` ${EXPORT_SCHEMA_VERSION} (\`EXPORT_SCHEMA_VERSION\` ${EXPORT_SCHEMA_VERSION}) are unchanged`,
    `\`AGENT_TABLES_REVISION\` 8 → ${RELEASED_1_8.AGENT_TABLES_REVISION}`, 'rebuilds the agent tables once',
    'a median 36 ms instead of 53 in UTC and 55 instead of 73 in Europe/Berlin — a measurement, not a promise',
    'Opening a folded section of the dashboard runs every fit again', '(13 rows, the narrowing at activation among them)',
  ]) assert.ok(flat.includes(claim), `the 1.8.0 entry does not say: ${claim}`)
  assert.equal(AGENT_TABLES_REVISION, RELEASED_1_8.AGENT_TABLES_REVISION, 'the code\'s revision is not the one 1.8.0 states')
  assert.equal(kw.KEEPWARM_LEAD_MS, 3 * 60_000, '"three minutes or less"')
  assert.equal(kw.KEEPWARM_COUNTDOWN_MS, 60_000, '"counts down 60 seconds"')
  assert.equal(kw.KEEPWARM_MAX_PER_IDLE, 3, '"at most three lines"')
  assert.equal(cw.CACHE_WATCH_MAX, 3, '"At most three sessions"')
  // The build figures are development.md's, measured there.
  assert.ok(flatText(doc.development).includes('a build took a median 36 ms instead of 53 in UTC (55 instead of 73 in Europe/Berlin)'))
  // The Consumer Terms' passage is the dialog's; the entry names it and does not re-word it.
  assert.equal(flat.includes(KEEP_WARM_TERMS_PASSAGE), false, 'the entry quotes the terms passage — the page and the dialog do')
  // Every version the entry names is the one 1.8.0 ships.
  for (const m of flat.matchAll(/`(STATE_VERSION|EXPORT_SCHEMA_VERSION)` (\d+)/g)) {
    assert.equal(Number(m[2]), m[1] === 'STATE_VERSION' ? STATE_VERSION : EXPORT_SCHEMA_VERSION, `the 1.8.0 entry says ${m[1]} ${m[2]}`)
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
  assert.ok(nlsEn['capabilities.untrustedWorkspaces'].includes('All three are disabled in Restricted Mode.'))
  assert.ok(nlsDe['capabilities.untrustedWorkspaces'].includes('Alle drei sind im eingeschränkten Modus abgeschaltet.'))
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
  assert.ok(doc.numbers.split('\n').some((l) => l.startsWith('| API cost |') && l.includes(`table checked ${PRICES_AS_OF}, the Claude Opus 5.5 row ${OPUS_5_5_CHECKED}`)))
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
