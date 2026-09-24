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
import { HOOK_EVENTS, HOOK_KEEP_LINES, HOOK_ROTATE_BYTES, HOOK_STDIN_MAX_BYTES } from '../src/agentHookScript'
import {
  AGENT_RETENTION_DAYS, HOOK_MAX_AGE_MS, MAX_AGENT_MORE, MAX_GROUP_CHILDREN, MAX_MORE_PAGES, MAX_PAGE_NODES, MAX_ROOTS, MAX_RUN_AGENTS,
  MAX_RUNNING_LIST, MAX_TREE_DEPTH, MIN_SHORT_ID, RESUMED_AFTER_MS, ROOT_WINDOW_MS, RUNNING_WINDOW_MS, SESSION_ACTIVE_MS,
  PER_MINUTE_FROM_MS, SILENT_AFTER_MS, SPAN_IN_DAYS_FROM_MS, TOP_AGENTS, WEEK_ROWS, WEEKDAY_NAMES_WITHIN_MS,
} from '../src/agentTree'
import { AGENT_ID_MAX_CHARS, AGENT_MODEL_MAX_CHARS, AGENT_NAME_MAX_CHARS, JOURNAL_PARSE_MAX, PENDING_MODE_MAX } from '../src/agg'
import { usedThresholds } from '../src/alerts'
import { readPaceConfig, sanitize } from '../src/config'
import { disclosure } from '../src/consent'
import { AGENTS_CSV_COLUMNS, EXPORT_SCHEMA_VERSION } from '../src/exporter'
import { PaceConfig, paceVerdict } from '../src/pace'
import { priceOf } from '../src/prices'
import { BarGlyphs, BarStyle, renderBar } from '../src/render'
import { RUN_RECORD_CHUNK_BYTES, RUN_RECORD_MAX_BYTES, RUN_RECORD_SCALAR_MAX } from '../src/runRecord'
import { AGENT_META_MAX_BYTES } from '../src/scan'
import { buildItems, selectWindows, viewOf, windowValue } from '../src/statusText'
import { formatReset, TimeConfig } from '../src/time'
import { QuotaState, QuotaWindow } from '../src/types'
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
    'agent-hook.jsonl',               // 1.6 O4 (§0a.13): the agent hook's mirror in globalStorage, only while installed
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
  file: string
  kind: 'fields' | 'regex' | 'tags'
  fields: string[]
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
    for (const field of row.fields) {
      const span = row.kind === 'tags' ? `\`<${field}>\`` : `\`${field}\``
      assert.ok(doc.privacy.includes(span), `docs/privacy.md does not name ${span} of ${row.what}`)
      assert.ok(doc.agents.includes(span), `docs/agents.md does not name ${span} of ${row.what}`)
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
  for (const written of ['Tool errors', '{0} of {1} tool calls', 'Cache misses', '{0} tokens not read from the cache', 'model changed',
    'cache unavailable', 'Compactions', '{0} · last at {1} ({2}, {3} → {4})', 'Claude Code version', 'Permission mode']) {
    assert.ok(src.includes(`t('${written}'`), `src/agentTreeBuild.ts no longer writes: ${written}`)
  }
  for (const example of ['`1 of 3 tool calls`', '`model changed 2 · cache unavailable 1`', '`48.2K tokens not read from the cache`',
    '`1 · last at 14:20 (auto, 167.2K → 12.4K)`', '**Claude Code version**', '**permission mode**', '`bypassPermissions`',
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
    [`At most **${MAX_ROOTS}** sessions`, 'the session cap'],
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
  for (const claim of ['Token Pace writes nothing into `~/.claude`', 'Node.js on the PATH', 'no fallback', 'Delete the four entries']) {
    assert.ok(setup.includes(claim), `the setup document does not say: ${claim}`)
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
  assert.match(doc.statusBar, /`forecast`, `budget`, `agents`\. The array order/)
  assert.ok(doc.statusBar.includes(`\`${three}\`, \`${one}\``), 'docs/status-bar.md does not quote the entry')
  assert.ok(doc.statusBar.split('\n').some((l) => l.startsWith(`| \`${three}\` / \`${one}\` |`)), 'docs/status-bar.md has no row for the entry')
  for (const text of [three, one]) {
    assert.ok(STATES.split('\n').some((l) => l.startsWith(`| \`${text}\` |`)), `docs/status-bar-states.md has no row for ${text}`)
  }
  assert.match(doc.settings, /`forecast`, `budget`, `agents`\. Empty hides the bar/)
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
  // nothing to show, and nothing about the cache may be derived from the token buckets.
  assert.match(doc.statusBar, /status-line bridge is connected, one further row states the prompt cache/)
  assert.match(doc.statusBar, /Without the bridge the row is absent\nrather than estimated/)
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
