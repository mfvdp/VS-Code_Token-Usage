// SPDX-FileCopyrightText: 2026 Frederik Marx
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Static privacy check: every http(s) literal that survives into the shipped bundles *and the
 * shipped string files* is listed with its host and matched against an allow-list. The
 * promise "no network access
 * beyond the one consent-gated endpoint" is otherwise unverifiable — a price feed, a status
 * page or a CDN font would be a two-line change nobody notices in review.
 *
 * The allow-list is deliberately small and each entry has a reason:
 *   api.anthropic.com          the one endpoint the consent dialog names
 *   claude.ai/settings/usage   the official usage page, opened in the user's browser
 *   chatgpt.com                the same for Codex
 *   docs.claude.com, developers.openai.com, support.claude.com, github.com/mfvdp
 *                              documentation links that only ever appear as text
 *   api.telegram.org           Telegram's Bot API — only for a channel the reader set up and
 *                              allowed (1.12)
 *
 * The notification channels' other hosts are the reader's own — a webhook address, an ntfy server,
 * an SMTP server, typed by the reader — and so no literal this scan could see. They are named by
 * the second table, `NETWORK_SITES` (below, 1.12 C11): every place in `src/` that can reach a host
 * at all — a `fetch(`, a socket, an import of a network module — with the kind of host it reaches
 * and why. A call site anywhere else fails the CLI, and so does a row whose file no longer has it.
 *
 * Beside the URL scan, the read contract (`READ_CONTRACT`, below): which fields each reader of a
 * Claude Code file may name — the list docs/privacy.md and docs/agents.md are held to by
 * test/docs.test.ts. The CLI fails when a reader names a field the table does not list, or a
 * listed field is no longer read.
 *
 * And the agent hook's bundle (1.6 O4, `dist/agent-hook.js`, which Claude Code runs on every hook
 * event the user installs it for): it may load `fs` and `path` and nothing else — never a network
 * module, a child process, a worker thread, never `fetch(` (`scanHookBundle`, below). 1.8 §7a Q16:
 * the status-line bridge's bundle (`dist/statusline-bridge.js`, which the connected status line runs
 * from its copy in globalStorage) is held to the same rule, with `child_process` allowed — it starts
 * the status-line command that was there before it — and nothing else added.
 *
 * Run: node scripts/check-privacy.mjs   (also `npm run check:privacy`)
 */

import { readdirSync, readFileSync, existsSync } from 'fs'
import { join } from 'path'

/** Entries are either a bare host or `host/path-prefix`. */
export const DEFAULT_ALLOW = [
  'api.anthropic.com',
  'claude.ai/settings/usage',
  'chatgpt.com',
  'docs.claude.com',
  'developers.openai.com',
  'support.claude.com',
  'github.com/mfvdp',
  'api.telegram.org',
]

// Stops at whitespace and at the characters that end a string literal or a JSX/HTML
// attribute; trailing punctuation is trimmed afterwards.
const URL_RE = /https?:\/\/[^\s'"`\\)>\]},;]+/g

function parse(raw) {
  const url = raw.replace(/[.,:;!?]+$/, '')
  try {
    const u = new URL(url)
    return { url, host: u.host.toLowerCase(), path: u.pathname }
  } catch {
    return { url, host: '', path: '' }
  }
}

function isAllowed(entry, allow) {
  for (const rule of allow) {
    const slash = rule.indexOf('/')
    const host = (slash === -1 ? rule : rule.slice(0, slash)).toLowerCase()
    const prefix = slash === -1 ? '' : rule.slice(slash)
    if (entry.host !== host) continue
    if (prefix === '' || entry.path.startsWith(prefix)) return true
  }
  return false
}

/**
 * Finds every http(s) literal in `text` and classifies it against `allow`.
 * Pure, so the test suite can run it against a fake bundle.
 *
 * @param {string} text
 * @param {string[]} [allow]
 * @returns {{ urls: Array<{url: string, host: string, path: string, allowed: boolean, line: number}>,
 *             offenders: Array<{url: string, host: string, path: string, allowed: boolean, line: number}> }}
 */
export function scanBundle(text, allow = DEFAULT_ALLOW) {
  const urls = []
  const seen = new Set()
  URL_RE.lastIndex = 0
  let m
  while ((m = URL_RE.exec(text)) !== null) {
    const entry = parse(m[0])
    if (seen.has(entry.url)) continue
    seen.add(entry.url)
    const line = text.slice(0, m.index).split('\n').length
    urls.push({ ...entry, allowed: isAllowed(entry, allow), line })
  }
  urls.sort((a, b) => a.host.localeCompare(b.host) || a.url.localeCompare(b.url))
  return { urls, offenders: urls.filter((u) => !u.allowed) }
}

function pick(dir, re) {
  if (!existsSync(dir)) return []
  return readdirSync(dir).filter((f) => re.test(f)).sort().map((f) => join(dir, f))
}

/**
 * Every file the .vsix carries that can hold a URL literal. Code is only half of it: VS Code
 * reads the l10n bundles and the manifest strings at runtime, so a host hidden in a
 * translation ships just as surely as one in `dist/`. `l10n/parts/*.json` do not ship, but
 * they are the input of merge-l10n.mjs, so a host is named in the file a translator edits.
 * Keep in step with the `!` lines of .vscodeignore. Exported so the test can assert the list.
 */
export function filesToScan() {
  return [
    ...pick('dist', /\.js$/),
    ...pick('l10n', /^bundle\.l10n\..+\.json$/),
    ...pick(join('l10n', 'parts'), /\.json$/),
    ...pick('.', /^package\.nls(\..+)?\.json$/),
  ]
}

// ---------------------------------------------------------------------------
// The read contract
// ---------------------------------------------------------------------------

/**
 * One reader of a Claude Code file and the only fields it may name. Four kinds of row:
 *  - `fields`: every `<variable>.<field>` / `<variable>?.<field>` the body names — the body runs
 *    from the line holding `body` to the closing brace at that line's indentation;
 *  - `regex`: the quoted key names (`"name":`) inside the named constant's definition, for a
 *    reader that matches keys on the raw line instead of parsing it;
 *  - `tags`: group 1 of every match of `pattern` over the whole file — the tag names the
 *    matching constants look for;
 *  - `picks` (1.8 §0a.1): the quoted key names of every `pick(<variable>, '<key>', …)` call inside
 *    the body — the status-line reader (src/quota.ts) names the payload's fields through `pick`,
 *    in both spellings, which the `fields` regex does not see.
 * `pages` (1.8 §0a.1, optional) names the documentation pages that must name the row's fields —
 * the keys of `doc` in test/docs.test.ts; without it `['privacy', 'agents']`, the rule since 1.6.
 * `what` names the reader as both documentation pages describe it; `source` the file it reads, as
 * docs/privacy.md names it (a Claude Code transcript under `~/.claude/projects/`, an agent's
 * identity sidecar `agent-<id>.meta.json`, a workflow run's `journal.jsonl`, Claude Code's run record
 * `<session>/workflows/wf_<id>.json`, a hook call's input on the hook script's `stdin`, the hook's
 * mirror `agent-hook.jsonl` in the extension's storage). Every package of 1.6 that reads a new field
 * adds its row here, and the pages name the field in backticks — and the file.
 *
 * The fields by the 1.6 spec's §0a entries: 0a.0 the values of `type`, `status` and `<status>` (no
 * new field); 0a.1 the journal's `key`; 0a.2 `apiErrorStatus`, `error`, `quotaLimits.rateLimitType`;
 * 0a.3 a `Workflow` block's `id` and its result's `runId`; 0a.4 `effort`; 0a.5 a tool call's `name`;
 * 0a.6 `is_error` (raw line); 0a.7 `diagnostics.cache_miss_reason` (`type`,
 * `cache_missed_input_tokens`); 0a.8 `version`; 0a.9 `permissionMode` (raw line); 0a.10
 * `compactMetadata` (`trigger`, `preTokens`, `postTokens`); 0a.11 the sidecar's `parentAgentId`;
 * 0a.12 the run record's seven; 0a.13 the hook's four input keys and its mirror's six fields.
 *
 * 1.8 §0a.1 adds the reader of the status-line mirror, `<globalStorage>/statusline-mirror.json` — the
 * first row for a file that is not a transcript-side file of `~/.claude/projects/`: the payload's
 * top-level fields (with 1.8's `session_id`), and level by level what is taken of each (with 1.8's
 * `recache_tokens_if_cold`). The bridge keeps nothing else in the mirror (statuslineBridge.ts
 * `MIRROR_KEEP`, tied to these rows by test/privacy.test.ts).
 *
 * @typedef {{ what: string, source: string, file: string, kind: 'fields', body: string, variable: string, fields: string[], pages?: string[] }
 *   | { what: string, source: string, file: string, kind: 'regex', regex: string, fields: string[], pages?: string[] }
 *   | { what: string, source: string, file: string, kind: 'tags', pattern: RegExp, fields: string[], pages?: string[] }
 *   | { what: string, source: string, file: string, kind: 'picks', body: string, variable: string, fields: string[], pages?: string[] }} ReadContractRow
 */

/** 1.8 §0a.1: the pages a row of the status-line mirror is held to. */
const MIRROR_PAGES = ['privacy', 'promptCache']
/** 1.8 §0a.6–§0a.8: the pages a row of the keep-warm host is held to. */
const KEEPWARM_PAGES = ['privacy', 'promptCache']
/** 1.10 §0a.1, §0a.3: the pages a row of the prompt tool is held to. */
const PROMPTS_PAGES = ['privacy', 'prompts']
/** 1.12 §0a.4: the pages a row of the credentials document is held to. */
const CREDENTIALS_PAGES = ['privacy', 'quotaSources']
/** 1.12 §0a.4: the credentials document's two places — the file and, on macOS, the Keychain item holding the same JSON. */
const CREDENTIALS_SOURCE = '~/.claude/.credentials.json or the Keychain item Claude Code-credentials'
/**
 * 1.12 §0a.10: the notification payload — not a file of another program but what Token Pace builds and sends, held to
 * the same rule: of an event `payloadOf` reads these fields and no other. P9 adds the notifications page to its pages
 * once docs/notifications.md exists (1.10 P2's precedent for a page that comes later).
 */
const PAYLOAD_PAGES = ['privacy']
const PAYLOAD_SOURCE = 'the notification payload'

/** @type {ReadContractRow[]} */
export const READ_CONTRACT = [
  // 1.6 §0a.11 (P13a): the sidecar's fifth field, the spawning agent's id — the spawner link when
  // no launch names one.
  { what: 'the identity sidecar', source: 'agent-<id>.meta.json', file: 'src/agg.ts', kind: 'fields', body: 'function cleanMeta(', variable: 'o',
    fields: ['agentType', 'model', 'spawnDepth', 'toolUseId', 'parentAgentId'] },
  // 1.6 §0a.1 (P2b): the journal's head is matched on the raw line, and the `key` joins `type` and
  // `agentId` — compared within the journal, never kept. The fallback parses a short line without
  // the head and picks the same three.
  { what: 'the workflow journal', source: 'journal.jsonl', file: 'src/agg.ts', kind: 'regex', regex: 'JOURNAL_HEAD_RE',
    fields: ['type', 'key', 'agentId'] },
  { what: 'the workflow journal (fallback)', source: 'journal.jsonl', file: 'src/agg.ts', kind: 'fields', body: 'function journalFallback(', variable: 'd',
    fields: ['type', 'key', 'agentId'] },
  // 1.6 §0a.3 (P4): the blocks of a reply the launches are read from — an `Agent`/`Task` block's
  // `input` for the three fields above; of a `Workflow` block only its `id`, its input never.
  { what: 'the launch blocks', source: '~/.claude/projects/', file: 'src/agg.ts', kind: 'fields', body: 'private noteLaunches(', variable: 'block',
    fields: ['type', 'name', 'id', 'input'] },
  { what: 'an agent launch', source: '~/.claude/projects/', file: 'src/agg.ts', kind: 'fields', body: 'private noteLaunches(', variable: 'input',
    fields: ['subagent_type', 'model', 'run_in_background'] },
  { what: 'the tool result', source: '~/.claude/projects/', file: 'src/agg.ts', kind: 'fields', body: 'private agentResult(', variable: 'r',
    fields: ['agentId', 'status'] },
  // 1.6 §0a.3 (P4): the result that answers a `Workflow` call — the run it launched and its status.
  { what: 'the workflow result', source: '~/.claude/projects/', file: 'src/agg.ts', kind: 'fields', body: 'private runResult(', variable: 'r',
    fields: ['runId', 'status'] },
  { what: 'the reported totals', source: '~/.claude/projects/', file: 'src/agg.ts', kind: 'fields', body: 'function reportedTotals(', variable: 'r',
    fields: ['totalTokens', 'totalDurationMs', 'totalToolUseCount'] },
  { what: 'the task notification', source: '~/.claude/projects/', file: 'src/agg.ts', kind: 'tags', pattern: /const NOTE_\w+_RE = \/<([a-z-]+)>/g,
    fields: ['tool-use-id', 'status'] },
  // 1.6 §0a.2 (P5a): an API error line of an agent's transcript — the request it rejected: its HTTP
  // status, its error kind and, of its `quotaLimits` block (a plain object), the limit that refused
  // it. Never its message, which holds the error's text, nor anything else of the block.
  { what: 'a rejected request', source: '~/.claude/projects/', file: 'src/agg.ts', kind: 'fields', body: 'function rejectedOf(', variable: 'd',
    fields: ['apiErrorStatus', 'error', 'quotaLimits'] },
  { what: 'a rejected request\'s limit', source: '~/.claude/projects/', file: 'src/agg.ts', kind: 'fields', body: 'function rejectedOf(', variable: 'q',
    fields: ['rateLimitType'] },
  // 1.6 §0a.5 (P6): the tool calls of a reply — counted for the tools table since 1.3, and since
  // 1.6 N5 the name of the last one kept on an agent's record with its line's time. Of a block
  // only its `type`, `name` and `id`; its `input` is never looked at.
  { what: 'the tool calls of a reply', source: '~/.claude/projects/', file: 'src/agg.ts', kind: 'fields', body: 'private countClaudeTools(', variable: 'b',
    fields: ['type', 'name', 'id'] },
  // 1.6 §0a.4 (P9): the effort a reply of an agent's transcript was written at — the line's
  // top-level `effort`, one of five levels. Never a nested one, never an error line's `perTurnEffort`.
  { what: 'the effort of a response', source: '~/.claude/projects/', file: 'src/agg.ts', kind: 'fields', body: 'function effortOf(', variable: 'd',
    fields: ['effort'] },
  // 1.6 §0a.6 (P13a): the tool results marked as errors, counted on the raw line by the literal
  // `"is_error":true` — the line is not parsed for it, and the result is never read.
  { what: 'tool errors', source: '~/.claude/projects/', file: 'src/agg.ts', kind: 'regex', regex: 'TOOL_ERROR_LITERAL',
    fields: ['is_error'] },
  // 1.6 §0a.7 (P13a): why the cache missed on an agent's response — of the message's diagnostics,
  // the reason's type and the input tokens it states. Nothing else of the diagnostics.
  { what: 'a cache miss', source: '~/.claude/projects/', file: 'src/agg.ts', kind: 'fields', body: 'function cacheMissOf(', variable: 'm',
    fields: ['diagnostics'] },
  { what: 'a cache miss\'s diagnostics', source: '~/.claude/projects/', file: 'src/agg.ts', kind: 'fields', body: 'function cacheMissOf(', variable: 'g',
    fields: ['cache_miss_reason'] },
  { what: 'a cache miss\'s reason', source: '~/.claude/projects/', file: 'src/agg.ts', kind: 'fields', body: 'function cacheMissOf(', variable: 'x',
    fields: ['type', 'cache_missed_input_tokens'] },
  // 1.6 §0a.8 (P13a): the Claude Code version that wrote a line.
  { what: 'the writer\'s version', source: '~/.claude/projects/', file: 'src/agg.ts', kind: 'fields', body: 'function versionOf(', variable: 'd',
    fields: ['version'] },
  // 1.6 §0a.9 (P13a): a prompt line's permission mode, matched on the raw line — never parsed.
  { what: 'the permission mode', source: '~/.claude/projects/', file: 'src/agg.ts', kind: 'regex', regex: 'PERMISSION_MODE_RE',
    fields: ['permissionMode'] },
  // 1.8 §0a.5 (P5): a user line — a prompt or a tool result — recognised on the raw line by its
  // top-level `type`, for whether a main transcript's newest message line is the user's. Never parsed
  // for it; nothing of the line is kept but that one bit.
  { what: 'a user line', source: '~/.claude/projects/', file: 'src/agg.ts', kind: 'regex', regex: 'USER_LINE_LITERAL',
    fields: ['type'] },
  // 1.9 §0a.1 (P17): the time of a main transcript's newest user line — the unescaped `timestamp` key,
  // matched on the raw line of a user line, the latest of its matches; the line is never parsed for it,
  // and nothing else of it is kept. Its one use is the keep-warm line's G13 bound, so it is held to the
  // privacy page and the prompt-cache page.
  { what: 'the time of a user line', source: '~/.claude/projects/', file: 'src/agg.ts', kind: 'regex', regex: 'USER_LINE_TIME_RE',
    fields: ['timestamp'], pages: ['privacy', 'promptCache'] },
  // 1.6 §0a.10 (P13a): a compaction's line — its type and subtype, and of its metadata the trigger
  // and the context before and after. Never the segment it preserved, nor the summary line.
  { what: 'a compaction', source: '~/.claude/projects/', file: 'src/agg.ts', kind: 'fields', body: 'function compactionOf(', variable: 'd',
    fields: ['type', 'subtype', 'compactMetadata'] },
  { what: 'a compaction\'s metadata', source: '~/.claude/projects/', file: 'src/agg.ts', kind: 'fields', body: 'function compactionOf(', variable: 'c',
    fields: ['trigger', 'preTokens', 'postTokens'] },
  // 1.6 §0a.12 (P13b): Claude Code's run record of a workflow run — seven top-level fields, picked
  // from the file's bytes by a streaming key-picker that decodes the value of no other key (the
  // run's script, its logs, its result), and each of the seven checked against its allow-list.
  { what: 'the run record', source: '<session>/workflows/wf_<id>.json', file: 'src/runRecord.ts', kind: 'regex', regex: 'RUN_RECORD_KEYS',
    fields: ['status', 'startTime', 'durationMs', 'agentCount', 'totalTokens', 'totalToolCalls', 'defaultModel'] },
  { what: 'the run record\'s values', source: '<session>/workflows/wf_<id>.json', file: 'src/runRecord.ts', kind: 'fields', body: 'export function cleanRunRecord(', variable: 'o',
    fields: ['status', 'startTime', 'durationMs', 'agentCount', 'totalTokens', 'totalToolCalls', 'defaultModel'] },
  // 1.6 §0a.13 (P14b): the opt-in agent hook. Its script, run by Claude Code, reads four keys of a
  // hook call's input — the event, the session, the agent, the notification's type —, never its
  // `message`, `tool_input`, `tool_response`, `prompt`, `transcript_path` or `cwd`; the extension's
  // reader takes the six fields of each line the script wrote, and checks each again.
  { what: 'the agent hook\'s input', source: 'stdin', file: 'src/agentHookScript.ts', kind: 'fields', body: 'export function hookLineOf(', variable: 'j',
    fields: ['hook_event_name', 'session_id', 'agent_id', 'notification_type'] },
  { what: 'the agent hook\'s mirror', source: 'agent-hook.jsonl', file: 'src/agentHook.ts', kind: 'fields', body: 'export function cleanHookLine(', variable: 'o',
    fields: ['v', 'ts', 'event', 'sessionId', 'agentId', 'wait'] },
  // 1.8 §0a.1 (P4): the status-line mirror in the extension's storage — the envelope the bridge
  // writes around the payload, and of the payload what the status-line reader picks, level by
  // level, in both spellings. 1.8 adds the top-level `session_id` and the prompt cache's
  // `recache_tokens_if_cold`; the rest has been read since 1.3.
  { what: 'the status-line mirror', source: 'statusline-mirror.json', file: 'src/quota.ts', kind: 'fields', body: 'export function readStatuslineMirror(', variable: 'parsed',
    fields: ['schema_version', 'written_at', 'payload'], pages: MIRROR_PAGES },
  // 1.8 §7a Q11 (review 2): the mirror's second reader — activation narrows a mirror a 1.3–1.7 bridge
  // wrote whole. Of the envelope it takes the same three fields; of the payload it keeps exactly what
  // the bridge keeps (statuslineBridge.ts `MIRROR_KEEP`, tied to the rows below by test/privacy.test.ts).
  { what: 'the status-line mirror, narrowed at activation', source: 'statusline-mirror.json', file: 'src/bridge.ts', kind: 'fields', body: 'export function narrowMirrorFile(', variable: 'doc',
    fields: ['schema_version', 'written_at', 'payload'], pages: MIRROR_PAGES },
  { what: 'the status line\'s session', source: 'statusline-mirror.json', file: 'src/quota.ts', kind: 'picks', body: 'export function claudeStateFromStatusline(', variable: 'payload',
    fields: ['rate_limits', 'rateLimits', 'plan', 'subscription', 'context_window', 'contextWindow', 'cost', 'model',
      'prompt_cache', 'promptCache', 'session_id', 'sessionId'], pages: MIRROR_PAGES },
  { what: 'the status line\'s rate limits', source: 'statusline-mirror.json', file: 'src/quota.ts', kind: 'picks', body: 'export function claudeStateFromStatusline(', variable: 'rl',
    fields: ['five_hour', 'fiveHour', 'seven_day', 'sevenDay', 'spend_limit', 'spendLimit'], pages: MIRROR_PAGES },
  { what: 'the status line\'s rate-limit window', source: 'statusline-mirror.json', file: 'src/quota.ts', kind: 'picks', body: 'function statuslineWindow(', variable: 'v',
    fields: ['used_percentage', 'usedPercentage', 'utilization', 'resets_at', 'resetsAt'], pages: MIRROR_PAGES },
  { what: 'the status line\'s spend limit', source: 'statusline-mirror.json', file: 'src/quota.ts', kind: 'picks', body: 'export function claudeStateFromStatusline(', variable: 'spend',
    fields: ['used_percentage', 'usedPercentage'], pages: MIRROR_PAGES },
  { what: 'the status line\'s plan', source: 'statusline-mirror.json', file: 'src/quota.ts', kind: 'picks', body: 'function planLabel(', variable: 'v',
    fields: ['name', 'display_name', 'displayName', 'type'], pages: MIRROR_PAGES },
  { what: 'the status line\'s context window', source: 'statusline-mirror.json', file: 'src/quota.ts', kind: 'picks', body: 'export function claudeStateFromStatusline(', variable: 'cw',
    fields: ['total_input_tokens', 'totalInputTokens', 'total_output_tokens', 'totalOutputTokens', 'context_window_size',
      'contextWindowSize', 'used_percentage', 'usedPercentage'], pages: MIRROR_PAGES },
  { what: 'the status line\'s cost', source: 'statusline-mirror.json', file: 'src/quota.ts', kind: 'picks', body: 'export function claudeStateFromStatusline(', variable: 'cost',
    fields: ['total_cost_usd', 'totalCostUsd'], pages: MIRROR_PAGES },
  { what: 'the status line\'s model', source: 'statusline-mirror.json', file: 'src/quota.ts', kind: 'picks', body: 'export function claudeStateFromStatusline(', variable: 'model',
    fields: ['display_name', 'displayName'], pages: MIRROR_PAGES },
  { what: 'the status line\'s model id', source: 'statusline-mirror.json', file: 'src/quota.ts', kind: 'fields', body: 'export function claudeStateFromStatusline(', variable: 'model',
    fields: ['id'], pages: MIRROR_PAGES },
  { what: 'the status line\'s prompt cache', source: 'statusline-mirror.json', file: 'src/quota.ts', kind: 'picks', body: 'function promptCacheOf(', variable: 'v',
    fields: ['ttl', 'expires_at', 'expiresAt', 'hit_ratio', 'hitRatio', 'recache_tokens_if_cold', 'recacheTokensIfCold'], pages: MIRROR_PAGES },
  { what: 'the status line\'s prompt cache (direct)', source: 'statusline-mirror.json', file: 'src/quota.ts', kind: 'fields', body: 'function promptCacheOf(', variable: 'v',
    fields: ['warm'], pages: MIRROR_PAGES },
  // 1.8 §0a.6 (P10): the opt-in keep-warm line's terminals — not a file but VS Code's shell integration.
  // Of its two events the terminal and the execution; of an open execution its command line (the text
  // and VS Code's confidence in it) and the working directory the shell reported — tested for G7 when
  // the guard asks, kept by no one, never logged, shown or exported; of a terminal VS Code's word for
  // what runs in it. Never a terminal's name, its output or its environment. 1.10 §0a.3 (P2): the six
  // rows read src/terminalWatch.ts — the watch moved out of the keep-warm host, unchanged in what it
  // takes —, and the prompt tool reads the same facts (whether a terminal runs Claude Code or Codex).
  { what: 'keep-warm: the shell execution events', source: 'VS Code\'s shell integration', file: 'src/terminalWatch.ts', kind: 'fields', body: 'private startTracking(', variable: 'e',
    fields: ['terminal', 'execution'], pages: KEEPWARM_PAGES },
  { what: 'keep-warm: an open shell execution', source: 'VS Code\'s shell integration', file: 'src/terminalWatch.ts', kind: 'fields', body: 'function executionFacts(', variable: 'execution',
    fields: ['commandLine', 'cwd'], pages: KEEPWARM_PAGES },
  { what: 'keep-warm: its command line', source: 'VS Code\'s shell integration', file: 'src/terminalWatch.ts', kind: 'fields', body: 'function executionFacts(', variable: 'line',
    fields: ['value', 'confidence'], pages: KEEPWARM_PAGES },
  { what: 'keep-warm: its working directory', source: 'VS Code\'s shell integration', file: 'src/terminalWatch.ts', kind: 'fields', body: 'function executionFacts(', variable: 'dir',
    fields: ['fsPath'], pages: KEEPWARM_PAGES },
  { what: 'keep-warm: a terminal\'s shell', source: 'VS Code\'s shell integration', file: 'src/terminalWatch.ts', kind: 'fields', body: 'function shellOf(', variable: 'terminal',
    fields: ['state'], pages: KEEPWARM_PAGES },
  { what: 'keep-warm: the shell VS Code reports', source: 'VS Code\'s shell integration', file: 'src/terminalWatch.ts', kind: 'fields', body: 'function shellOf(', variable: 's',
    fields: ['shell'], pages: KEEPWARM_PAGES },
  // 1.8 §0a.8 (P10): the one write into another program's input — of the terminal only `sendText`, with
  // the fixed line; nothing is read back.
  { what: 'keep-warm: the line typed', source: 'VS Code\'s shell integration', file: 'src/keepWarmHost.ts', kind: 'fields', body: 'function typeLine(', variable: 'terminal',
    fields: ['sendText'], pages: KEEPWARM_PAGES },
  // 1.8 §0a.7 (P10): the keep-warm accounting in the extension's storage, read back by its shape — the
  // version and the days, of a day its two counts; any other key reads the file as empty.
  { what: 'keep-warm: the accounting file', source: 'keepwarm.json', file: 'src/keepWarmHost.ts', kind: 'fields', body: 'export function cleanKeepWarmFile(', variable: 'o',
    fields: ['v', 'days'], pages: KEEPWARM_PAGES },
  { what: 'keep-warm: a day of the accounting', source: 'keepwarm.json', file: 'src/keepWarmHost.ts', kind: 'fields', body: 'export function cleanKeepWarmFile(', variable: 'd',
    fields: ['requests', 'tokens'], pages: KEEPWARM_PAGES },
  // 1.10 §0a.3 (P2): the one new field of VS Code's terminal API — the folder the shell integration reports
  // for a terminal whose shell is `claude` or `codex` and in which the watch saw no execution start (a
  // window reload), read at a send or a build of the Prompts section only, to compare its
  // project-directory name with the transcripts' folders; never kept, logged, shown or exported. Of the
  // terminal its `shellIntegration`, of that its `cwd`, of that the `fsPath`. P3 widened the rows to the
  // prompts page (PROMPTS_PAGES) when it created that page.
  { what: 'prompts: a terminal\'s shell integration', source: 'VS Code\'s shell integration', file: 'src/terminalWatch.ts', kind: 'fields', body: 'function reportedCwd(', variable: 'terminal',
    fields: ['shellIntegration'], pages: PROMPTS_PAGES },
  { what: 'prompts: the folder VS Code reports for a terminal', source: 'VS Code\'s shell integration', file: 'src/terminalWatch.ts', kind: 'fields', body: 'function reportedCwd(', variable: 'si',
    fields: ['cwd'], pages: PROMPTS_PAGES },
  { what: 'prompts: that folder\'s path', source: 'VS Code\'s shell integration', file: 'src/terminalWatch.ts', kind: 'fields', body: 'function reportedCwd(', variable: 'dir',
    fields: ['fsPath'], pages: PROMPTS_PAGES },
  // 1.10 §0a.4 (P4): the second write into another program's input — of the terminal only `sendText`: the text of
  // the prompt the reader double-clicked, then (§7a's probe) the Enter alone after PROMPT_ENTER_DELAY_MS. Nothing is
  // read back.
  { what: 'prompts: the prompt typed', source: 'VS Code\'s shell integration', file: 'src/promptsHost.ts', kind: 'fields', body: 'function typePrompt(', variable: 'terminal',
    fields: ['sendText'], pages: PROMPTS_PAGES },
  // 1.10 §0a.1 (P3): the reader's prompt list in the extension's storage, read back by its shape — the
  // version and the list, of an entry its id and, where the reader wrote them, its title and text; any
  // other key makes the file unreadable, never repaired. The titles and texts are the reader's own words:
  // shown on the page and typed on the reader's click, never logged, exported or reported.
  { what: 'prompts: the list file', source: 'prompts.json', file: 'src/prompts.ts', kind: 'fields', body: 'export function cleanPromptsFile(', variable: 'o',
    fields: ['v', 'prompts'], pages: PROMPTS_PAGES },
  { what: 'prompts: an entry of the list', source: 'prompts.json', file: 'src/prompts.ts', kind: 'fields', body: 'export function cleanPromptsFile(', variable: 'e',
    fields: ['id', 'title', 'text'], pages: PROMPTS_PAGES },
  // 1.12 §0a.4 (P5): the credentials document — the file, or the Keychain item that holds the same JSON on macOS
  // (the Linux Secret Service's too) — read by one parser: of the document `claudeAiOauth`, of that the
  // `accessToken` and its `expiresAt`. Never `refreshToken`, `scopes`, `subscriptionType` or any other field.
  { what: 'the credentials document', source: CREDENTIALS_SOURCE, file: 'src/credentials.ts', kind: 'fields', body: 'function parseCredentials(', variable: 'd',
    fields: ['claudeAiOauth'], pages: CREDENTIALS_PAGES },
  { what: 'the credentials document\'s token', source: CREDENTIALS_SOURCE, file: 'src/credentials.ts', kind: 'fields', body: 'function parseCredentials(', variable: 'oauth',
    fields: ['accessToken', 'expiresAt'], pages: CREDENTIALS_PAGES },
  // 1.12 §0a.10 (P6): the one builder of a notification's payload — of a `NotificationEvent` its allow-list, read by name
  // into the facts the texts and the JSON are made of. Never `identity` (the once-rule's key), and no field an event does
  // not have: a prompt, a path, a project, a session, an agent, a plan, an account, a token count or a cost.
  { what: 'the notification payload', source: PAYLOAD_SOURCE, file: 'src/notify.ts', kind: 'fields', body: 'export function payloadOf(', variable: 'e',
    fields: ['event', 'provider', 'program', 'windowLabel', 'windowKind', 'percent', 'resetsAt', 'etaAt', 'since', 'atLeastMs', 'wait', 'at'],
    pages: PAYLOAD_PAGES },
]

/**
 * The body of one function or method of a source: from the line holding `signature` to the
 * closing brace at the indentation that line starts with. Null when the signature is not there
 * or its brace cannot be found. Line endings are levelled first, as a Windows checkout has CRLF.
 */
export function bodyOf(src, signature) {
  const text = src.replace(/\r\n/g, '\n')
  const at = text.indexOf(signature)
  if (at < 0) return null
  const lineStart = text.lastIndexOf('\n', at) + 1
  const indent = /^[ \t]*/.exec(text.slice(lineStart, at))[0]
  const end = text.indexOf(`\n${indent}}`, at)
  return end > at ? text.slice(at, end) : null
}

/** The distinct `<variable>.<field>` names a body reads, in order of first appearance. */
export function fieldsRead(body, variable) {
  return [...new Set([...body.matchAll(new RegExp(`\\b${variable}\\??\\.([A-Za-z_]+)`, 'g'))].map((m) => m[1]))]
}

/**
 * 1.8 §0a.1: the distinct keys a body picks of `variable` — the quoted names of every
 * `pick(<variable>, '<key>', …)` call, a cast of the variable (`pick(v as any, …)`) included, in
 * order of first appearance. A call whose first argument is anything else is not the variable's.
 */
export function picksRead(body, variable) {
  const calls = body.matchAll(new RegExp(`\\bpick\\(\\s*${variable}(?:\\s+as\\s+[A-Za-z_]+)?\\s*,([^)]*)\\)`, 'g'))
  const keys = []
  for (const call of calls) for (const k of call[1].matchAll(/(['"`])([^'"`]+)\1/g)) keys.push(k[2])
  return [...new Set(keys)]
}

/**
 * The definition of a top-level constant, from `const <name> =` to the end of its statement:
 * for a regex or string literal the rest of its line, for anything else the first line end
 * outside a bracket. Enough for the regex literals and key lists the raw-line readers are made
 * of. Null when there is no such constant.
 */
export function constantOf(src, name) {
  const text = src.replace(/\r\n/g, '\n')
  const m = new RegExp(`(?:^|\\n)(?:export )?const ${name}\\b[^=]*=[ \\t]*`).exec(text)
  if (!m) return null
  const from = m.index + m[0].length
  if (/^[/'"`]/.test(text.slice(from, from + 1))) {
    const eol = text.indexOf('\n', from)
    return text.slice(m.index, eol < 0 ? undefined : eol)
  }
  let depth = 0
  for (let i = from; i < text.length; i++) {
    const c = text[i]
    if (c === '\\') { i++; continue }
    if (c === '[' || c === '(' || c === '{') depth++
    else if (c === ']' || c === ')' || c === '}') depth = Math.max(0, depth - 1)
    else if (c === '\n' && depth === 0) return text.slice(m.index, i)
  }
  return text.slice(m.index)
}

/**
 * The quoted key names in a definition: every `"name":`, a backslash before a quote allowed —
 * the keys a raw-line pattern matches. A definition without one is a list of key names
 * (`['status', 'startTime']`), and then every quoted name is a key.
 */
export function quotedKeys(definition) {
  const keyed = [...definition.matchAll(/\\?"([A-Za-z_][A-Za-z0-9_]*)\\?"\s*:/g)].map((m) => m[1])
  const found = keyed.length > 0 ? keyed : [...definition.matchAll(/(['"])([A-Za-z_][A-Za-z0-9_]*)\1/g)].map((m) => m[2])
  return [...new Set(found)]
}

/**
 * What one row's reader reads today, or an error when its body or constant is gone.
 * @param {ReadContractRow} row
 * @param {string} src
 * @returns {{ read: string[] } | { error: string }}
 */
function readOf(row, src) {
  if (row.kind === 'fields') {
    const body = bodyOf(src, row.body)
    return body === null ? { error: `${row.file} no longer contains ${row.body}` } : { read: fieldsRead(body, row.variable) }
  }
  if (row.kind === 'regex') {
    const def = constantOf(src, row.regex)
    return def === null ? { error: `${row.file} no longer defines ${row.regex}` } : { read: quotedKeys(def) }
  }
  if (row.kind === 'tags') {
    return { read: [...new Set([...src.matchAll(row.pattern)].map((m) => m[1]))] }
  }
  if (row.kind === 'picks') {
    const body = bodyOf(src, row.body)
    return body === null ? { error: `${row.file} no longer contains ${row.body}` } : { read: picksRead(body, row.variable) }
  }
  return { error: `unknown kind ${String(row.kind)}` }
}

/**
 * Every row whose reader and list differ: the fields read that the row does not list
 * (`unlisted`), the listed ones no longer read (`unread`), or why the reader could not be found
 * (`error`). An empty array is a kept contract.
 *
 * @param {(file: string) => string} [read]  reads a source file named relative to the repository
 * @param {ReadContractRow[]} [contract]
 * @returns {Array<{ what: string, file: string, unlisted: string[], unread: string[], error: string | null }>}
 */
export function checkReadContract(read = (f) => readFileSync(f, 'utf8'), contract = READ_CONTRACT) {
  const offenders = []
  const sources = new Map()
  for (const row of contract) {
    let src = sources.get(row.file)
    if (src === undefined) {
      try { src = read(row.file) } catch (err) { src = null }
      sources.set(row.file, src)
    }
    if (src === null) {
      offenders.push({ what: row.what, file: row.file, unlisted: [], unread: [...row.fields], error: `cannot read ${row.file}` })
      continue
    }
    const got = readOf(row, src)
    if ('error' in got) {
      offenders.push({ what: row.what, file: row.file, unlisted: [], unread: [...row.fields], error: got.error })
      continue
    }
    const unlisted = got.read.filter((f) => !row.fields.includes(f))
    const unread = row.fields.filter((f) => !got.read.includes(f))
    if (unlisted.length > 0 || unread.length > 0) offenders.push({ what: row.what, file: row.file, unlisted, unread, error: null })
  }
  return offenders
}

// ---------------------------------------------------------------------------
// The agent hook's bundle
// ---------------------------------------------------------------------------

/** 1.6 O4: the bundle Claude Code runs as the agent hook. */
export const HOOK_BUNDLE = join('dist', 'agent-hook.js')
/** The modules it may load: Node's `fs` and `path`, nothing else. */
export const HOOK_ALLOWED_MODULES = ['fs', 'path']
/**
 * The modules it may never name (§0a.13): the network, a process or a thread of its own. Named
 * twice over on purpose — beside the allow-list above, a string literal of one of these names is a
 * finding wherever it stands, so a module reached through a variable is caught as well.
 */
export const HOOK_FORBIDDEN_MODULES = ['http', 'https', 'net', 'tls', 'dgram', 'child_process', 'worker_threads']

/** 1.8 §7a Q16: the status-line bridge's bundle — the file its copy in globalStorage is made from. */
export const BRIDGE_BUNDLE = join('dist', 'statusline-bridge.js')
/** The modules it may load: `fs` and `path` for the mirror, `child_process` for the previous command. */
export const BRIDGE_ALLOWED_MODULES = ['child_process', 'fs', 'path']
/** The modules it may never name: the network and a thread of its own. */
export const BRIDGE_FORBIDDEN_MODULES = ['http', 'https', 'net', 'tls', 'dgram', 'worker_threads']

/**
 * What a bundle Claude Code runs loads, and what of it breaks its rules: every module a `require`,
 * an `import(…)` or an `import … from` names (a `node:` prefix taken off) that `allowed` does not
 * list; every string literal that is exactly a `forbidden` module's name; a `fetch(`. Pure, for the
 * tests. The defaults are the agent hook's rule (1.6 O4); the bridge passes its own (1.8 Q16).
 *
 * @param {string} text
 * @param {string[]} [allowed]
 * @param {string[]} [forbidden]
 * @returns {{ modules: string[], offenders: string[] }}
 */
export function scanHookBundle(text, allowed = HOOK_ALLOWED_MODULES, forbidden = HOOK_FORBIDDEN_MODULES) {
  const modules = new Set()
  const offenders = new Set()
  const bare = (m) => m.replace(/^node:/, '')
  for (const m of text.matchAll(/\brequire\s*\(\s*(['"`])([^'"`]+)\1\s*\)/g)) modules.add(bare(m[2]))
  for (const m of text.matchAll(/\bimport\s*\(\s*(['"`])([^'"`]+)\1\s*\)/g)) modules.add(bare(m[2]))
  for (const m of text.matchAll(/\bfrom\s*(['"`])([^'"`]+)\1/g)) modules.add(bare(m[2]))
  for (const mod of modules) {
    if (!allowed.includes(mod)) offenders.add(`loads ${mod}`)
  }
  for (const m of text.matchAll(/(['"`])(?:node:)?([a-z_]+)\1/g)) {
    if (forbidden.includes(m[2])) offenders.add(`names ${m[2]}`)
  }
  if (/\bfetch\s*\(/.test(text)) offenders.add('calls fetch(')
  return { modules: [...modules].sort(), offenders: [...offenders].sort() }
}

/** 1.8 §7a Q16: the bridge's bundle against its own rule. */
export function scanBridgeBundle(text) {
  return scanHookBundle(text, BRIDGE_ALLOWED_MODULES, BRIDGE_FORBIDDEN_MODULES)
}

// ---------------------------------------------------------------------------
// The network's call sites (1.12 C11)
// ---------------------------------------------------------------------------

/**
 * 1.12 C11: every place in `src/` that can reach a host, one row per file — the call sites it may have
 * (`sites`, the names of `NETWORK_SITE_KINDS`), the kind of host it reaches (`literal`: a host the code
 * spells, which the URL scan above holds to `DEFAULT_ALLOW`; `userConfigured`: a host the reader typed,
 * which no scan of the code can see) and why. This is how the scan learns the user-configured class: not
 * from a literal, but from the table — a new call site anywhere else fails the CLI, and so does a row whose
 * file no longer has the site it names (a stale row, as the read contract's `unread`). 1.12 P8 adds the
 * SMTP sender's row when it exists.
 *
 * @typedef {{ file: string, sites: string[], hosts: 'literal' | 'userConfigured', reason: string }} NetworkSiteRow
 * @type {NetworkSiteRow[]}
 */
export const NETWORK_SITES = [
  { file: 'src/poller.ts', sites: ['fetch'], hosts: 'literal', reason: 'the one quota endpoint, api.anthropic.com (consent)' },
  { file: 'src/notifyChannels.ts', sites: ['fetch'], hosts: 'userConfigured', reason: 'a notification channel the reader set up and allowed per host; Telegram\'s host is the literal api.telegram.org' },
]

/** The kinds of host a row may name. */
export const NETWORK_HOST_KINDS = ['literal', 'userConfigured']
/**
 * Node's modules that open a connection (C11 rule 2's list, and `http2`, which does as well): an `import`,
 * a `require` or an `import(…)` of one — a `node:` prefix taken off — is a site of that module's name.
 */
export const NETWORK_MODULES = ['http', 'https', 'http2', 'net', 'tls', 'dgram', 'undici']
/**
 * The calls that reach a host, by the name a row lists them under: `fetch(` (a member call such as
 * `globalThis.fetch(` too), a module's connecting calls (C11 rule 2), and — for the dashboard's script,
 * which runs in a browser — `new WebSocket(`, `XMLHttpRequest`, `new EventSource(` and `sendBeacon(`.
 */
const CALL_SITES = [
  { site: 'fetch', re: /(?<![\w$])fetch\s*\(/g },
  { site: 'http', re: /(?<![\w$])http\s*\.\s*(?:request|get)\s*\(/g },
  { site: 'https', re: /(?<![\w$])https\s*\.\s*(?:request|get)\s*\(/g },
  { site: 'http2', re: /(?<![\w$])http2\s*\.\s*connect\s*\(/g },
  { site: 'net', re: /(?<![\w$])net\s*\.\s*(?:connect|createConnection)\s*\(/g },
  { site: 'tls', re: /(?<![\w$])tls\s*\.\s*connect\s*\(/g },
  { site: 'dgram', re: /(?<![\w$])dgram\s*\.\s*createSocket\s*\(/g },
  { site: 'WebSocket', re: /(?<![\w$])new\s+(?:[\w$]+\.)*WebSocket\s*\(/g },
  { site: 'XMLHttpRequest', re: /(?<![\w$])XMLHttpRequest(?![\w$])/g },
  { site: 'EventSource', re: /(?<![\w$])new\s+(?:[\w$]+\.)*EventSource\s*\(/g },
  { site: 'sendBeacon', re: /(?<![\w$])sendBeacon\s*\(/g },
]
/** Every name a row's `sites` may hold. */
export const NETWORK_SITE_KINDS = [...new Set([...CALL_SITES.map((c) => c.site), ...NETWORK_MODULES])]
const IMPORT_RES = [
  /(?<![\w$])from\s*(['"])([^'"\n]+)\1/g,
  /(?<![\w$.])import\s*(['"])([^'"\n]+)\1/g,
  /(?<![\w$.])require\s*\(\s*(['"`])([^'"`\n]+)\1\s*\)/g,
  /(?<![\w$.])import\s*\(\s*(['"`])([^'"`\n]+)\1\s*\)/g,
]

/** After these a `/` starts a regular expression, not a division. */
const REGEX_AFTER_CHAR = new Set(['', '(', ',', '=', ':', '[', '!', '&', '|', '?', '{', '}', ';', '+', '-', '*', '%', '<', '>', '~', '^'])
const REGEX_AFTER_WORD = new Set(['return', 'typeof', 'case', 'do', 'else', 'in', 'of', 'new', 'delete', 'void', 'throw', 'yield', 'await', 'instanceof'])

/**
 * A TypeScript or JavaScript source with its comments blanked (`code`), and with its comments and the
 * contents of its strings, template texts and regular expressions blanked as well (`bare`) — every blanked
 * character a space, every line break kept, so an index is the same line in all three. A call site is looked
 * for in `bare` (a comment that says "the fetch (…)" or a string that names one is no call); a module an
 * import names is looked for in `code` (its name is a string). A template's `${…}` stays code. Pure.
 *
 * The lexer knows comments, the three kinds of string with `${…}` nested in templates, and regular
 * expressions after the characters and words that can precede one; a quote or a regular expression it cannot
 * close ends at its line's end, so a misreading costs one line, never the file.
 *
 * @param {string} src
 * @returns {{ code: string, bare: string }}
 */
export function codeOf(src) {
  const code = src.split('')
  const bare = src.split('')
  const n = src.length
  const blank = (arr, i) => { if (arr[i] !== '\n' && arr[i] !== '\r') arr[i] = ' ' }
  const blankBoth = (i) => { blank(code, i); blank(bare, i) }
  /** Brace depths at which a template's `${` was opened. */
  const opened = []
  let depth = 0
  let inTemplate = false
  let prev = ''
  let word = ''
  let i = 0
  while (i < n) {
    const c = src[i]
    if (inTemplate) {
      if (c === '\\') { blank(bare, i); if (i + 1 < n) blank(bare, i + 1); i += 2; continue }
      if (c === '`') { inTemplate = false; prev = '`'; word = ''; i++; continue }
      if (c === '$' && src[i + 1] === '{') { opened.push(depth); depth++; inTemplate = false; prev = '{'; word = ''; i += 2; continue }
      blank(bare, i)
      i++
      continue
    }
    const d = src[i + 1]
    if (c === '/' && d === '/') {
      while (i < n && src[i] !== '\n') { blankBoth(i); i++ }
      continue
    }
    if (c === '/' && d === '*') {
      const end = src.indexOf('*/', i + 2)
      const stop = end === -1 ? n : end + 2
      for (; i < stop; i++) blankBoth(i)
      continue
    }
    if (c === '\'' || c === '"') {
      i++
      while (i < n && src[i] !== c && src[i] !== '\n') {
        if (src[i] === '\\' && i + 1 < n && src[i + 1] !== '\n') { blank(bare, i); i++ }
        blank(bare, i)
        i++
      }
      if (i < n && src[i] === c) i++
      prev = c
      word = ''
      continue
    }
    if (c === '`') { inTemplate = true; i++; continue }
    if (c === '/' && (REGEX_AFTER_CHAR.has(prev) || (word !== '' && REGEX_AFTER_WORD.has(word)))) {
      let j = i + 1
      let inClass = false
      while (j < n && src[j] !== '\n') {
        if (src[j] === '\\') { j += 2; continue }
        if (src[j] === '[') inClass = true
        else if (src[j] === ']') inClass = false
        else if (src[j] === '/' && !inClass) break
        j++
      }
      if (j < n && src[j] === '/') {
        for (let k = i + 1; k < j; k++) blank(bare, k)
        i = j + 1
        while (i < n && /[a-z]/i.test(src[i])) i++
        prev = '/'
        word = ''
        continue
      }
    }
    if (c === '{') depth++
    if (c === '}') {
      depth--
      if (opened.length > 0 && opened[opened.length - 1] === depth) { opened.pop(); inTemplate = true; i++; continue }
    }
    if (/\s/.test(c)) { i++; continue }
    if (/[\w$]/.test(c)) {
      word = /[\w$]/.test(prev) ? word + c : c
      prev = c
      i++
      continue
    }
    prev = c
    word = ''
    i++
  }
  return { code: code.join(''), bare: bare.join('') }
}

/**
 * The network call sites of one source: each `{ site, line }` — a call of `CALL_SITES` in the code, or an
 * import of a module of `NETWORK_MODULES`. Pure, for the tests.
 *
 * @param {string} src
 * @returns {Array<{ site: string, line: number }>}
 */
export function networkSitesIn(src) {
  const { code, bare } = codeOf(src)
  const lineAt = (index) => src.slice(0, index).split('\n').length
  const found = []
  for (const { site, re } of CALL_SITES) {
    for (const m of bare.matchAll(re)) found.push({ site, line: lineAt(m.index) })
  }
  for (const re of IMPORT_RES) {
    for (const m of code.matchAll(re)) {
      const mod = m[2].replace(/^node:/, '').split('/')[0]
      if (NETWORK_MODULES.includes(mod)) found.push({ site: mod, line: lineAt(m.index) })
    }
  }
  const seen = new Set()
  return found
    .filter((f) => { const k = `${f.site}:${f.line}`; if (seen.has(k)) return false; seen.add(k); return true })
    .sort((a, b) => a.line - b.line || a.site.localeCompare(b.site))
}

/**
 * Every source file under `<root>/src`, as the path a row names (`src/…`, forward slashes), sorted: the
 * TypeScript the extension, its workers, its scripts for Claude Code and the dashboard's page are built from.
 *
 * @param {string} [root]
 * @returns {string[]}
 */
export function sourceFiles(root = '.') {
  const out = []
  const walk = (rel) => {
    const full = join(root, rel)
    if (!existsSync(full)) return
    for (const entry of readdirSync(full, { withFileTypes: true })) {
      const child = `${rel}/${entry.name}`
      if (entry.isDirectory()) walk(child)
      else if (/\.[cm]?[jt]sx?$/.test(entry.name)) out.push(child)
    }
  }
  walk('src')
  return out.sort()
}

/**
 * C11 rule 2: every network call site of `files` against `rows` — pure over the file reader, for the tests.
 * An offender is a site in a file without a row, a site its file's row does not list, a row whose file does not
 * have a site it lists or cannot be read (stale), and a row that is not well-formed (no reason, an unknown kind
 * of host or site).
 *
 * @param {(file: string) => string} [read]
 * @param {string[]} [files]
 * @param {NetworkSiteRow[]} [rows]
 * @returns {{ sites: Array<{ file: string, site: string, line: number }>,
 *             offenders: Array<{ file: string, site: string, line: number | null, problem: string }> }}
 */
export function scanNetworkSites(read = (file) => readFileSync(file, 'utf8'), files = sourceFiles(), rows = NETWORK_SITES) {
  const sites = []
  const offenders = []
  const byFile = new Map()
  for (const row of rows) {
    if (typeof row.reason !== 'string' || row.reason.trim() === '') offenders.push({ file: row.file, site: '', line: null, problem: 'a row without its reason' })
    if (!NETWORK_HOST_KINDS.includes(row.hosts)) offenders.push({ file: row.file, site: '', line: null, problem: `an unknown kind of host: ${row.hosts}` })
    for (const site of row.sites) {
      if (!NETWORK_SITE_KINDS.includes(site)) offenders.push({ file: row.file, site, line: null, problem: 'an unknown site' })
    }
    if (row.sites.length === 0) offenders.push({ file: row.file, site: '', line: null, problem: 'a row without a site' })
    byFile.set(row.file, row)
  }
  const all = [...new Set([...files, ...rows.map((r) => r.file)])].sort()
  for (const file of all) {
    let src
    try {
      src = read(file)
    } catch {
      src = null
    }
    const row = byFile.get(file)
    if (src === null || typeof src !== 'string') {
      if (row !== undefined) offenders.push({ file, site: row.sites.join(', '), line: null, problem: `cannot read ${file}` })
      continue
    }
    const found = networkSitesIn(src)
    for (const f of found) {
      sites.push({ file, site: f.site, line: f.line })
      if (row === undefined) offenders.push({ file, site: f.site, line: f.line, problem: 'no row in NETWORK_SITES' })
      else if (!row.sites.includes(f.site)) offenders.push({ file, site: f.site, line: f.line, problem: 'not among its row\'s sites' })
    }
    if (row !== undefined) {
      for (const site of row.sites) {
        if (!found.some((f) => f.site === site)) offenders.push({ file, site, line: null, problem: 'listed but not found (a stale row)' })
      }
    }
  }
  return { sites, offenders }
}

function main() {
  if (!existsSync('dist')) {
    console.error('check-privacy: no dist/ — run `npm run build` first')
    process.exit(1)
  }
  const files = filesToScan()
  if (!files.some((f) => f.startsWith('dist'))) {
    console.error('check-privacy: no dist/*.js — run `npm run build` first')
    process.exit(1)
  }

  let offenders = 0
  for (const full of files) {
    const { urls } = scanBundle(readFileSync(full, 'utf8'))
    console.log(`${full}: ${urls.length} http(s) literal(s)`)
    for (const u of urls) {
      console.log(`  ${u.allowed ? 'ok  ' : 'DENY'}  ${u.host.padEnd(24)} ${u.url}  (line ${u.line})`)
      if (!u.allowed) offenders++
    }
  }

  // The read contract, after the URL scan: every reader of a Claude Code file names exactly
  // the fields the table lists — the ones both documentation pages promise.
  const broken = checkReadContract()
  console.log(`\nread contract: ${READ_CONTRACT.length} reader(s)`)
  for (const row of READ_CONTRACT) {
    const bad = broken.find((b) => b.what === row.what)
    console.log(`  ${bad ? 'DIFF' : 'ok  '}  ${row.what}: ${row.fields.join(', ')}`)
    if (bad?.error) console.log(`        ${bad.error}`)
    if (bad?.unlisted.length) console.log(`        read but not listed: ${bad.unlisted.join(', ')}`)
    if (bad?.unread.length) console.log(`        listed but not read: ${bad.unread.join(', ')}`)
  }

  // 1.6 O4: the agent hook's bundle loads `fs` and `path`, nothing else.
  let hookBad = null
  if (!existsSync(HOOK_BUNDLE)) {
    console.log(`\nagent hook: ${HOOK_BUNDLE} is missing`)
    hookBad = [`${HOOK_BUNDLE} is missing — run \`npm run build\` first`]
  } else {
    const hook = scanHookBundle(readFileSync(HOOK_BUNDLE, 'utf8'))
    console.log(`\nagent hook: ${HOOK_BUNDLE} loads ${hook.modules.join(', ') || 'nothing'}`)
    for (const o of hook.offenders) console.log(`  DENY  ${o}`)
    if (hook.offenders.length > 0) hookBad = hook.offenders
  }

  // 1.8 §7a Q16: the status-line bridge's bundle loads `child_process`, `fs` and `path`, nothing else.
  let bridgeBad = null
  if (!existsSync(BRIDGE_BUNDLE)) {
    console.log(`\nstatus-line bridge: ${BRIDGE_BUNDLE} is missing`)
    bridgeBad = [`${BRIDGE_BUNDLE} is missing — run \`npm run build\` first`]
  } else {
    const bridge = scanBridgeBundle(readFileSync(BRIDGE_BUNDLE, 'utf8'))
    console.log(`status-line bridge: ${BRIDGE_BUNDLE} loads ${bridge.modules.join(', ') || 'nothing'}`)
    for (const o of bridge.offenders) console.log(`  DENY  ${o}`)
    if (bridge.offenders.length > 0) bridgeBad = bridge.offenders
  }

  // 1.12 C11: every network call site of src/ has its row in NETWORK_SITES, and every row still holds.
  const net = scanNetworkSites()
  console.log(`\nnetwork sites: ${NETWORK_SITES.length} row(s)`)
  for (const row of NETWORK_SITES) {
    const bad = net.offenders.filter((o) => o.file === row.file)
    const at = net.sites.filter((x) => x.file === row.file).map((x) => `${x.site} (line ${x.line})`).join(', ')
    const hosts = row.hosts === 'literal' ? 'a literal host' : 'hosts the reader configures'
    console.log(`  ${bad.length > 0 ? 'DIFF' : 'ok  '}  ${row.file}: ${at || row.sites.join(', ')} — ${hosts}: ${row.reason}`)
    for (const o of bad) console.log(`        ${o.site ? `${o.site}: ` : ''}${o.problem}`)
  }
  for (const o of net.offenders.filter((x) => !NETWORK_SITES.some((r) => r.file === x.file))) {
    console.log(`  DENY  ${o.file}:${o.line} ${o.site} — ${o.problem}`)
  }
  const userFiles = NETWORK_SITES.filter((r) => r.hosts === 'userConfigured').map((r) => r.file)
  if (userFiles.length > 0) {
    console.log(`user-configured hosts: notification channels (${userFiles.join(', ')}) — none is contacted before its channel's consent`)
  }

  let failed = false
  if (net.offenders.length > 0) {
    console.error(`\ncheck-privacy: ${net.offenders.length} network call site(s) or row(s) differ from NETWORK_SITES.`)
    console.error('Every place in src/ that can reach a host needs its row — the file, its sites, the kind of host it reaches and why.')
    failed = true
  }
  if (bridgeBad !== null) {
    console.error(`\ncheck-privacy: the status-line bridge's bundle breaks its rule: ${bridgeBad.join('; ')}.`)
    console.error('It may load child_process, fs and path only — never a network module, a worker, never fetch(.')
    failed = true
  }
  if (hookBad !== null) {
    console.error(`\ncheck-privacy: the agent hook's bundle breaks its rule: ${hookBad.join('; ')}.`)
    console.error('It may load fs and path only — never a network module, a child process, a worker, never fetch(.')
    failed = true
  }
  if (offenders > 0) {
    console.error(`\ncheck-privacy: ${offenders} literal(s) outside the allow-list.`)
    console.error('Add a host only with a reason; "no network access by default" is a promise, not a default.')
    failed = true
  }
  if (broken.length > 0) {
    console.error(`\ncheck-privacy: ${broken.length} reader(s) differ from the read contract.`)
    console.error('A new field needs its row in READ_CONTRACT and its name on the row\'s pages — docs/privacy.md and docs/agents.md, or the ones its `pages` names.')
    failed = true
  }
  if (failed) process.exit(1)
  console.log('\ncheck-privacy: ok')
}

// Only run the CLI when invoked directly, so the test can import the scanner.
if (process.argv[1] && process.argv[1].endsWith('check-privacy.mjs')) main()
