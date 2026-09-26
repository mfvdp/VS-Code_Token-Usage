// SPDX-FileCopyrightText: 2026 Frederik Marx
// SPDX-License-Identifier: AGPL-3.0-or-later

import { test } from 'node:test'
import * as assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

interface ScanResult {
  urls: Array<{ url: string; host: string; path: string; allowed: boolean; line: number }>
  offenders: Array<{ url: string; host: string; path: string; allowed: boolean; line: number }>
}

// The scanner is a plain .mjs so `npm run check:privacy` needs no build step; required here
// rather than imported so the TypeScript build does not need an .mjs declaration file.
const { scanBundle, DEFAULT_ALLOW, filesToScan } = require('../scripts/check-privacy.mjs') as {
  scanBundle: (text: string, allow?: string[]) => ScanResult
  DEFAULT_ALLOW: string[]
  filesToScan: () => string[]
}

test('an allowed host passes, an unknown one is reported', () => {
  const fake = [
    'const ENDPOINT = "https://api.anthropic.com/api/oauth/usage"',
    'const PRICES = "https://prices.example.com/v1/list.json"',
  ].join('\n')

  const { urls, offenders } = scanBundle(fake, DEFAULT_ALLOW)
  assert.equal(urls.length, 2)
  assert.equal(offenders.length, 1)
  assert.equal(offenders[0].host, 'prices.example.com')
  assert.equal(offenders[0].url, 'https://prices.example.com/v1/list.json')
  assert.ok(urls.some((u) => u.host === 'api.anthropic.com' && u.allowed))
})

test('a clean bundle has no offenders', () => {
  const clean = 'const usagePage = "https://claude.ai/settings/usage" // and https://chatgpt.com/codex/settings/usage'
  assert.deepEqual(scanBundle(clean, DEFAULT_ALLOW).offenders, [])
})

test('the allow-list is matched on host, and on the path prefix where one is given', () => {
  // claude.ai is allowed only for the usage page, not for the whole host.
  const other = 'fetch("https://claude.ai/api/organizations")'
  const result = scanBundle(other, DEFAULT_ALLOW)
  assert.equal(result.offenders.length, 1)
  assert.equal(result.offenders[0].host, 'claude.ai')

  // A host allowed without a path prefix matches any path.
  assert.deepEqual(scanBundle('"https://api.anthropic.com/anything"', DEFAULT_ALLOW).offenders, [])

  // github.com is allowed only under the project owner's namespace.
  assert.deepEqual(scanBundle('"https://github.com/mfvdp/VS-Code_Token-Usage"', DEFAULT_ALLOW).offenders, [])
  assert.equal(scanBundle('"https://github.com/someone-else/x"', DEFAULT_ALLOW).offenders.length, 1)
})

test('http is scanned as well as https, and duplicates are reported once', () => {
  const text = '"http://evil.example/a" ; "http://evil.example/a" ; "http://evil.example/b"'
  const { urls, offenders } = scanBundle(text, DEFAULT_ALLOW)
  assert.equal(urls.length, 2)
  assert.equal(offenders.length, 2)
  assert.ok(offenders.every((o) => o.host === 'evil.example'))
})

test('a custom allow-list is honoured', () => {
  const text = '"https://only.example/x"'
  assert.deepEqual(scanBundle(text, ['only.example']).offenders, [])
  assert.equal(scanBundle(text, []).offenders.length, 1)
})

test('trailing punctuation is not part of the URL, and the line number is reported', () => {
  const text = 'line one\nsee https://docs.claude.com/en/docs/claude-code.\n'
  const { urls } = scanBundle(text, DEFAULT_ALLOW)
  assert.equal(urls.length, 1)
  assert.equal(urls[0].url, 'https://docs.claude.com/en/docs/claude-code')
  assert.equal(urls[0].allowed, true)
  assert.equal(urls[0].line, 2)
})

test('the scan covers the shipped string files, not just the code bundles', () => {
  // VS Code reads the l10n bundle and the manifest strings at runtime, so a host introduced
  // in a translated sentence ships as surely as one in dist/. dist/ itself is not asserted
  // on: `npm test` does not build it.
  const files = filesToScan()
  assert.ok(files.some((f) => /l10n[\\/]bundle\.l10n\..+\.json$/.test(f)), files.join(' '))
  assert.ok(files.some((f) => /l10n[\\/]parts[\\/].+\.de\.json$/.test(f)), files.join(' '))
  assert.ok(files.some((f) => /^package\.nls.*\.json$/.test(f)), files.join(' '))
})

test('a host planted in a translated string is reported', () => {
  const bundle = '{\n  "a": "Preise: https://price-feed.example/v1/rates"\n}\n'
  const { offenders } = scanBundle(bundle, DEFAULT_ALLOW)
  assert.equal(offenders.length, 1)
  assert.equal(offenders[0].host, 'price-feed.example')
})

// ---------------------------------------------------------------------------
// The read contract (1.6 §0a): which fields each reader of a Claude Code file may name
// ---------------------------------------------------------------------------

interface ContractRow {
  what: string
  file: string
  source?: string
  kind: 'fields' | 'regex' | 'tags' | 'picks'
  body?: string
  variable?: string
  regex?: string
  pattern?: RegExp
  fields: string[]
  pages?: string[]
}
interface ContractOffender { what: string; file: string; unlisted: string[]; unread: string[]; error: string | null }

const contract = require('../scripts/check-privacy.mjs') as {
  READ_CONTRACT: ContractRow[]
  checkReadContract: (read?: (file: string) => string, rows?: ContractRow[]) => ContractOffender[]
  bodyOf: (src: string, signature: string) => string | null
  fieldsRead: (body: string, variable: string) => string[]
  constantOf: (src: string, name: string) => string | null
  quotedKeys: (definition: string) => string[]
  picksRead: (body: string, variable: string) => string[]
  scanHookBundle: (text: string, allowed?: string[], forbidden?: string[]) => { modules: string[]; offenders: string[] }
  scanBridgeBundle: (text: string) => { modules: string[]; offenders: string[] }
  HOOK_BUNDLE: string
  HOOK_ALLOWED_MODULES: string[]
  HOOK_FORBIDDEN_MODULES: string[]
  BRIDGE_BUNDLE: string
  BRIDGE_ALLOWED_MODULES: string[]
  BRIDGE_FORBIDDEN_MODULES: string[]
}

const REPO = join(__dirname, '..')
const fromRepo = (file: string): string => readFileSync(join(REPO, file), 'utf8')

test('the read contract holds for the shipped sources: every reader names exactly the fields its row lists', () => {
  assert.deepEqual(contract.checkReadContract(fromRepo), [])
  // 1.5's readers, moved into the table unchanged (1.6 P2a) — the journal's since changed by P2b.
  const byWhat = new Map(contract.READ_CONTRACT.map((row) => [row.what, row]))
  // 1.6 P13a (§0a.11, pinned and changed): the sidecar's fifth field, the spawning agent's id.
  assert.deepEqual(byWhat.get('the identity sidecar')?.fields, ['agentType', 'model', 'spawnDepth', 'toolUseId', 'parentAgentId'])
  // 1.6 P2b (§0a.1): the journal's head is read on the raw line, its `key` compared within the
  // journal; the fallback parses a short line without the head for the same three fields.
  assert.deepEqual(byWhat.get('the workflow journal')?.fields, ['type', 'key', 'agentId'])
  assert.equal(byWhat.get('the workflow journal')?.kind, 'regex')
  assert.deepEqual(byWhat.get('the workflow journal (fallback)')?.fields, ['type', 'key', 'agentId'])
  assert.deepEqual(byWhat.get('an agent launch')?.fields, ['subagent_type', 'model', 'run_in_background'])
  assert.deepEqual(byWhat.get('the tool result')?.fields, ['agentId', 'status'])
  assert.deepEqual(byWhat.get('the reported totals')?.fields, ['totalTokens', 'totalDurationMs', 'totalToolUseCount'])
  assert.deepEqual(byWhat.get('the task notification')?.fields, ['tool-use-id', 'status'])
  // 1.6 P4 (§0a.3): the blocks of a reply the launches come from — `input` only for an agent's —
  // and the result that answers a `Workflow` call, in a method of its own, so the agent's result
  // keeps exactly its two fields.
  assert.deepEqual(byWhat.get('the launch blocks')?.fields, ['type', 'name', 'id', 'input'])
  assert.deepEqual(byWhat.get('the workflow result')?.fields, ['runId', 'status'])
  assert.equal(byWhat.get('the workflow result')?.body, 'private runResult(')
  // 1.6 P13a (§0a.6–0a.10): the two raw-line gates are regex rows — their lines are never parsed —,
  // the diagnostics a row per level, the compaction's line and its metadata one each.
  assert.deepEqual([byWhat.get('tool errors')?.kind, byWhat.get('tool errors')?.fields], ['regex', ['is_error']])
  assert.deepEqual([byWhat.get('the permission mode')?.kind, byWhat.get('the permission mode')?.fields], ['regex', ['permissionMode']])
  // 1.8 P5 (§0a.5): a user line's top-level `type`, on the raw line as well — the line is never parsed for it.
  assert.deepEqual([byWhat.get('a user line')?.kind, byWhat.get('a user line')?.fields], ['regex', ['type']])
  // 1.9 P17 (§0a.1): the time of a main transcript's newest user line — its unescaped `timestamp` key, on
  // the raw line of a user line, never parsed; held to the privacy page and the prompt-cache page, the
  // page of its one use (the keep-warm line's G13 bound).
  const userTime = byWhat.get('the time of a user line')
  assert.deepEqual([userTime?.kind, userTime?.regex, userTime?.fields, userTime?.source, userTime?.pages],
    ['regex', 'USER_LINE_TIME_RE', ['timestamp'], '~/.claude/projects/', ['privacy', 'promptCache']])
  assert.deepEqual(byWhat.get('a cache miss')?.fields, ['diagnostics'])
  assert.deepEqual(byWhat.get('a cache miss\'s diagnostics')?.fields, ['cache_miss_reason'])
  assert.deepEqual(byWhat.get('a cache miss\'s reason')?.fields, ['type', 'cache_missed_input_tokens'])
  assert.deepEqual(byWhat.get('the writer\'s version')?.fields, ['version'])
  assert.deepEqual(byWhat.get('a compaction')?.fields, ['type', 'subtype', 'compactMetadata'])
  assert.deepEqual(byWhat.get('a compaction\'s metadata')?.fields, ['trigger', 'preTokens', 'postTokens'])
  // 1.6 P13b (§0a.12): Claude Code's run record — the key-picker's seven keys, a regex row over its
  // key list, and the check of each value. 1.6 P13b (pinned and changed): the two rows read
  // src/runRecord.ts; every other reader is the aggregator's.
  const seven = ['status', 'startTime', 'durationMs', 'agentCount', 'totalTokens', 'totalToolCalls', 'defaultModel']
  assert.deepEqual([byWhat.get('the run record')?.kind, byWhat.get('the run record')?.fields], ['regex', seven])
  assert.deepEqual([byWhat.get('the run record\'s values')?.kind, byWhat.get('the run record\'s values')?.fields], ['fields', seven])
  // 1.6 P14b (§0a.13): the agent hook — the script's four keys of a hook call's input, and the
  // reader's six fields of a mirror line.
  assert.deepEqual(byWhat.get('the agent hook\'s input')?.fields, ['hook_event_name', 'session_id', 'agent_id', 'notification_type'])
  assert.deepEqual(byWhat.get('the agent hook\'s mirror')?.fields, ['v', 'ts', 'event', 'sessionId', 'agentId', 'wait'])
  // 1.6 P13b (pinned and changed by P14b, 1.8 P4 and 1.8 review 2): the two run-record rows read
  // src/runRecord.ts, the two agent-hook rows the hook's own two files, the status-line mirror's rows
  // (1.8 §0a.1) src/quota.ts — but the narrowing at activation (§7a Q11), which src/bridge.ts does;
  // every other reader is the aggregator's.
  const NARROWED = 'the status-line mirror, narrowed at activation'
  const mirrorRow = (what: string): boolean => what === 'the status-line mirror' || what === NARROWED || what.startsWith('the status line\'s ')
  // 1.8 P10 (§0a.6–§0a.8, pinned and changed): the keep-warm host's rows read src/keepWarmHost.ts.
  // 1.10 P2 (§0a.3, pinned and changed): the six terminal rows read src/terminalWatch.ts — the watch moved
  // out of the host unchanged —, and so do the prompt tool's rows of the folder the shell integration
  // reports; the line typed and keepwarm.json stay the host's.
  const keepWarmRow = (what: string): boolean => what.startsWith('keep-warm: ')
  const promptsRow = (what: string): boolean => what.startsWith('prompts: ')
  const hostRow = (what: string): boolean => what === 'keep-warm: the line typed' || what.startsWith('keep-warm: the accounting') || what === 'keep-warm: a day of the accounting'
  // 1.10 P3 (§0a.1, pinned and changed): the prompt list's two rows read src/prompts.ts, where the file's
  // shape is checked.
  const listRow = (what: string): boolean => what === 'prompts: the list file' || what === 'prompts: an entry of the list'
  // 1.10 P4 (§0a.4, pinned and changed): the prompt typed reads src/promptsHost.ts, where `typePrompt` writes it.
  const typedRow = (what: string): boolean => what === 'prompts: the prompt typed'
  const watchRow = (what: string): boolean => (keepWarmRow(what) && !hostRow(what)) || (promptsRow(what) && !listRow(what) && !typedRow(what))
  const fileOf = (what: string): string => what.startsWith('the run record') ? 'src/runRecord.ts'
    : what === 'the agent hook\'s input' ? 'src/agentHookScript.ts' : what === 'the agent hook\'s mirror' ? 'src/agentHook.ts'
      : what === NARROWED ? 'src/bridge.ts' : mirrorRow(what) ? 'src/quota.ts' : listRow(what) ? 'src/prompts.ts' : typedRow(what) ? 'src/promptsHost.ts'
        : watchRow(what) ? 'src/terminalWatch.ts' : keepWarmRow(what) ? 'src/keepWarmHost.ts' : 'src/agg.ts'
  for (const row of contract.READ_CONTRACT) assert.equal(row.file, fileOf(row.what), row.what)
  // 1.8 §0a.1 (P4): the mirror's reader, level by level — the envelope, the payload's top-level
  // fields with 1.8's `session_id`, and of each block what is taken, the prompt cache's
  // `recache_tokens_if_cold` among it. Held to the privacy page and the prompt-cache page; every
  // other row keeps the default pages.
  const rows = contract.READ_CONTRACT.filter((row) => mirrorRow(row.what))
  assert.deepEqual(rows.map((row) => [row.what, row.kind, row.fields]), [
    ['the status-line mirror', 'fields', ['schema_version', 'written_at', 'payload']],
    [NARROWED, 'fields', ['schema_version', 'written_at', 'payload']],
    ['the status line\'s session', 'picks', ['rate_limits', 'rateLimits', 'plan', 'subscription', 'context_window', 'contextWindow',
      'cost', 'model', 'prompt_cache', 'promptCache', 'session_id', 'sessionId']],
    ['the status line\'s rate limits', 'picks', ['five_hour', 'fiveHour', 'seven_day', 'sevenDay', 'spend_limit', 'spendLimit']],
    ['the status line\'s rate-limit window', 'picks', ['used_percentage', 'usedPercentage', 'utilization', 'resets_at', 'resetsAt']],
    ['the status line\'s spend limit', 'picks', ['used_percentage', 'usedPercentage']],
    ['the status line\'s plan', 'picks', ['name', 'display_name', 'displayName', 'type']],
    ['the status line\'s context window', 'picks', ['total_input_tokens', 'totalInputTokens', 'total_output_tokens', 'totalOutputTokens',
      'context_window_size', 'contextWindowSize', 'used_percentage', 'usedPercentage']],
    ['the status line\'s cost', 'picks', ['total_cost_usd', 'totalCostUsd']],
    ['the status line\'s model', 'picks', ['display_name', 'displayName']],
    ['the status line\'s model id', 'fields', ['id']],
    ['the status line\'s prompt cache', 'picks', ['ttl', 'expires_at', 'expiresAt', 'hit_ratio', 'hitRatio', 'recache_tokens_if_cold',
      'recacheTokensIfCold']],
    ['the status line\'s prompt cache (direct)', 'fields', ['warm']],
  ])
  // 1.9 P17 (pinned and changed): the time of a user line is held to the same two pages (§0a.1).
  // 1.10 P2 (§0a.3, pinned and changed): the prompt tool's rows are held to the privacy page — P3 adds
  // the prompts page, which does not exist before it. 1.10 P3 (§0a.1, §0a.3, pinned and changed): every
  // prompt row is held to both, the privacy page and the prompts page (PROMPTS_PAGES).
  const promptCacheRow = (what: string): boolean => mirrorRow(what) || keepWarmRow(what) || what === 'the time of a user line'
  for (const row of contract.READ_CONTRACT) {
    assert.deepEqual(row.pages, promptCacheRow(row.what) ? ['privacy', 'promptCache'] : promptsRow(row.what) ? ['privacy', 'prompts'] : undefined, row.what)
    if (mirrorRow(row.what)) assert.equal(row.source, 'statusline-mirror.json', row.what)
  }
  // 1.8 P10 (§0a.6–§0a.8): the keep-warm host, reader by reader — the two shell-execution events, an
  // open execution's command line with its confidence and its working directory (tested, never kept),
  // VS Code's word for what runs in a terminal, the one line typed (`sendText` and nothing else of the
  // terminal — never its name), and keepwarm.json read back by its shape.
  const shell = 'VS Code\'s shell integration'
  assert.deepEqual(contract.READ_CONTRACT.filter((row) => keepWarmRow(row.what)).map((row) => [row.what, row.source, row.kind, row.fields]), [
    ['keep-warm: the shell execution events', shell, 'fields', ['terminal', 'execution']],
    ['keep-warm: an open shell execution', shell, 'fields', ['commandLine', 'cwd']],
    ['keep-warm: its command line', shell, 'fields', ['value', 'confidence']],
    ['keep-warm: its working directory', shell, 'fields', ['fsPath']],
    ['keep-warm: a terminal\'s shell', shell, 'fields', ['state']],
    ['keep-warm: the shell VS Code reports', shell, 'fields', ['shell']],
    ['keep-warm: the line typed', shell, 'fields', ['sendText']],
    ['keep-warm: the accounting file', 'keepwarm.json', 'fields', ['v', 'days']],
    ['keep-warm: a day of the accounting', 'keepwarm.json', 'fields', ['requests', 'tokens']],
  ])
  // 1.10 §0a.3 (P2): the one new field of VS Code's terminal API — of a terminal its `shellIntegration`, of
  // that its `cwd`, of that the `fsPath` — in `reportedCwd` and nowhere else.
  // 1.10 §0a.1 (P3): prompts.json read back by its shape — the version and the list, of an entry its id,
  // title and text — in `cleanPromptsFile` and nowhere else.
  // 1.10 §0a.4 (P4, pinned and changed): the prompt typed — of the terminal `sendText` alone, in `typePrompt`.
  assert.deepEqual(contract.READ_CONTRACT.filter((row) => promptsRow(row.what)).map((row) => [row.what, row.source, row.kind, row.body, row.variable, row.fields]), [
    ['prompts: a terminal\'s shell integration', shell, 'fields', 'function reportedCwd(', 'terminal', ['shellIntegration']],
    ['prompts: the folder VS Code reports for a terminal', shell, 'fields', 'function reportedCwd(', 'si', ['cwd']],
    ['prompts: that folder\'s path', shell, 'fields', 'function reportedCwd(', 'dir', ['fsPath']],
    ['prompts: the prompt typed', shell, 'fields', 'function typePrompt(', 'terminal', ['sendText']],
    ['prompts: the list file', 'prompts.json', 'fields', 'export function cleanPromptsFile(', 'o', ['v', 'prompts']],
    ['prompts: an entry of the list', 'prompts.json', 'fields', 'export function cleanPromptsFile(', 'e', ['id', 'title', 'text']],
  ])
})

test('the bridge keeps in the mirror exactly the keys the read contract lists for it (1.8 §7a Q11)', () => {
  const { MIRROR_KEEP } = require('../src/statuslineBridge') as typeof import('../src/statuslineBridge')
  const kept = new Set<string>()
  const walk = (keep: unknown): void => {
    if (Array.isArray(keep)) { for (const alt of keep) walk(alt); return }
    if (typeof keep !== 'object' || keep === null) return
    for (const [k, sub] of Object.entries(keep)) { kept.add(k); walk(sub) }
  }
  walk(MIRROR_KEEP)
  const read = new Set(contract.READ_CONTRACT
    .filter((row) => row.what.startsWith('the status line\'s '))
    .flatMap((row) => row.fields))
  assert.deepEqual([...kept].sort(), [...read].sort(),
    'the bridge keeps a key the reader does not take, or drops one it does — statuslineBridge.ts MIRROR_KEEP and READ_CONTRACT disagree')
})

test('a picks row reads the quoted keys of every pick of its variable, a cast included, and nothing else (1.8 §0a.1)', () => {
  const body = [
    'export function reader(payload, v) {',
    "  const a = pick(payload, 'rate_limits', 'rateLimits')",
    "  const b = pick(pick(payload, 'cost') as any, 'total_cost_usd')",
    "  const c = pick(v as any, 'name', \"display_name\")",
    "  const d = pick(other, 'cwd')",
    "  const e = pick(payloadX, 'transcript_path')",
    '  return payload.model',
    '}',
  ].join('\n')
  assert.deepEqual(contract.picksRead(body, 'payload'), ['rate_limits', 'rateLimits', 'cost'])
  assert.deepEqual(contract.picksRead(body, 'v'), ['name', 'display_name'])
  assert.deepEqual(contract.picksRead(body, 'nothing'), [])
  const rows: ContractRow[] = [
    { what: 'payload', file: 'x.ts', kind: 'picks', body: 'export function reader(', variable: 'payload', fields: ['rate_limits', 'rateLimits', 'cost'] },
  ]
  const read = (text: string) => (): string => text
  assert.deepEqual(contract.checkReadContract(read(body), rows), [])
  // One more key picked: reported as unlisted; a listed one gone: as unread.
  const more = body.replace("'rate_limits', 'rateLimits'", "'rate_limits', 'rateLimits', 'session_name'")
  assert.deepEqual(contract.checkReadContract(read(more), rows),
    [{ what: 'payload', file: 'x.ts', unlisted: ['session_name'], unread: [], error: null }])
  const less = body.replace("pick(pick(payload, 'cost') as any, 'total_cost_usd')", '0')
  assert.deepEqual(contract.checkReadContract(read(less), rows),
    [{ what: 'payload', file: 'x.ts', unlisted: [], unread: ['cost'], error: null }])
  // The shipped reader: `session_name`, `cwd` or `transcript_path` picked of the payload breaks it.
  const quota = fromRepo('src/quota.ts')
  const at = quota.indexOf("const rl = pick(payload, 'rate_limits', 'rateLimits') as any")
  assert.ok(at >= 0)
  for (const key of ['session_name', 'cwd', 'transcript_path']) {
    const src = `${quota.slice(0, at)}void pick(payload, '${key}')\n  ${quota.slice(at)}`
    const broken = contract.checkReadContract((f) => (f === 'src/quota.ts' ? src : fromRepo(f)))
    assert.deepEqual(broken.map((o) => [o.what, o.unlisted]), [['the status line\'s session', [key]]], key)
  }
})

test('the status-line bridge\'s bundle may load child_process, fs and path, and never a network module, a thread or fetch( (1.8 §7a Q16)', () => {
  assert.equal(contract.BRIDGE_BUNDLE.replace(/\\/g, '/'), 'dist/statusline-bridge.js')
  assert.deepEqual(contract.BRIDGE_ALLOWED_MODULES, ['child_process', 'fs', 'path'])
  assert.deepEqual(contract.BRIDGE_FORBIDDEN_MODULES, ['http', 'https', 'net', 'tls', 'dgram', 'worker_threads'])
  const clean = 'var import_child_process = require("child_process");\nvar fs = __toESM(require("fs"));\nvar path = __toESM(require("path"));\n'
  assert.deepEqual(contract.scanBridgeBundle(clean), { modules: ['child_process', 'fs', 'path'], offenders: [] })
  // The agent hook's rule is unchanged: the same text breaks it.
  assert.deepEqual(contract.scanHookBundle(clean).offenders, ['loads child_process', 'names child_process'])
  const cases: Array<[string, string]> = [
    ['require("https")', 'loads https'], ["require('node:net')", 'loads net'], ['import("tls")', 'loads tls'],
    ['import { Worker } from "worker_threads"', 'loads worker_threads'], ['require("os")', 'loads os'],
    ['const m = "http"; require(m)', 'names http'], ['fetch(url)', 'calls fetch('],
  ]
  for (const [text, finding] of cases) {
    assert.ok(contract.scanBridgeBundle(clean + text).offenders.includes(finding), `${text}: ${JSON.stringify(contract.scanBridgeBundle(clean + text))}`)
  }
  // The shipped bundle, when it is built: those three and nothing else, and no URL.
  try {
    const text = readFileSync(join(REPO, contract.BRIDGE_BUNDLE), 'utf8')
    assert.deepEqual(contract.scanBridgeBundle(text), { modules: ['child_process', 'fs', 'path'], offenders: [] })
    assert.deepEqual(scanBundle(text).urls, [])
  } catch (err) {
    if ((err as { code?: string }).code !== 'ENOENT') throw err
  }
})

test('the agent hook\'s bundle may load fs and path, and never a network module, a process, a thread or fetch( (§0a.13)', () => {
  assert.deepEqual(contract.HOOK_ALLOWED_MODULES, ['fs', 'path'])
  assert.deepEqual(contract.HOOK_FORBIDDEN_MODULES, ['http', 'https', 'net', 'tls', 'dgram', 'child_process', 'worker_threads'])
  const clean = 'var fs = __toESM(require("fs"));\nvar path = __toESM(require("path"));\nfs.openSync(path.join(a, "agent-hook.jsonl"))\n'
  assert.deepEqual(contract.scanHookBundle(clean), { modules: ['fs', 'path'], offenders: [] })
  const cases: Array<[string, string]> = [
    ['require("https")', 'loads https'], ["require('node:net')", 'loads net'], ['require("child_process")', 'loads child_process'],
    ['import("tls")', 'loads tls'], ['import { Worker } from "worker_threads"', 'loads worker_threads'], ['require("dgram")', 'loads dgram'],
    ['require("os")', 'loads os'], ['const m = "http"; require(m)', 'names http'], ['globalThis.fetch ("x")', 'calls fetch('],
    ['fetch(url)', 'calls fetch('],
  ]
  for (const [text, finding] of cases) {
    assert.ok(contract.scanHookBundle(clean + text).offenders.includes(finding), `${text}: ${JSON.stringify(contract.scanHookBundle(clean + text))}`)
  }
  // The shipped bundle, when it is built: fs and path, nothing else.
  const built = join(REPO, contract.HOOK_BUNDLE)
  try {
    const text = readFileSync(built, 'utf8')
    assert.deepEqual(contract.scanHookBundle(text), { modules: ['fs', 'path'], offenders: [] })
    assert.deepEqual(scanBundle(text).urls, [])
  } catch (err) {
    // A bare `node --test` after a checkout has no dist/; the CLI below and test/agentHook.test.ts build it.
    if ((err as { code?: string }).code !== 'ENOENT') throw err
  }
})

test('a reader that names one more field, or no longer reads a listed one, breaks the contract', () => {
  const src = [
    'function cleanMeta(v) {',
    '  const o = v',
    '  return { a: o.agentType, b: o?.model }',
    '}',
    'const NOTE_ID_RE = /<tool-use-id>([a-z]+)<\\/tool-use-id>/',
    'const HEAD_RE = /^\\{"type":"(a|b)"(?:,"key":"(x)")?/',
    'export const KEYS = [',
    "  'status', 'startTime',",
    ']',
  ].join('\n')
  const rows: ContractRow[] = [
    { what: 'meta', file: 'x.ts', kind: 'fields', body: 'function cleanMeta(', variable: 'o', fields: ['agentType', 'model'] },
    { what: 'note', file: 'x.ts', kind: 'tags', pattern: /const NOTE_\w+_RE = \/<([a-z-]+)>/g, fields: ['tool-use-id'] },
    { what: 'head', file: 'x.ts', kind: 'regex', regex: 'HEAD_RE', fields: ['type', 'key'] },
    { what: 'keys', file: 'x.ts', kind: 'regex', regex: 'KEYS', fields: ['status', 'startTime'] },
  ]
  const read = (text: string) => (file: string): string => {
    assert.equal(file, 'x.ts')
    return text
  }
  assert.deepEqual(contract.checkReadContract(read(src), rows), [])
  // One more field read: reported as unlisted.
  const more = src.replace('b: o?.model', 'b: o?.model, c: o.description')
  assert.deepEqual(contract.checkReadContract(read(more), rows),
    [{ what: 'meta', file: 'x.ts', unlisted: ['description'], unread: [], error: null }])
  // A listed field no longer read: reported as unread — the documentation would promise a read
  // that does not happen, or hide the one that replaced it.
  const less = src.replace(', b: o?.model', '')
  assert.deepEqual(contract.checkReadContract(read(less), rows),
    [{ what: 'meta', file: 'x.ts', unlisted: [], unread: ['model'], error: null }])
  // A key more in a raw-line pattern, and a tag more, are reads too.
  const pattern = src.replace('(?:,"key":"(x)")?', '(?:,"key":"(x)")?(?:,"label":"(y)")?')
    .replace('const NOTE_ID_RE', 'const NOTE_SUMMARY_RE = /<summary>(.*)<\\/summary>/\nconst NOTE_ID_RE')
  assert.deepEqual(contract.checkReadContract(read(pattern), rows).map((o) => [o.what, o.unlisted]),
    [['note', ['summary']], ['head', ['label']]])
  // A reader that is gone, or a file that cannot be read, is an error, never a pass.
  const gone = contract.checkReadContract(read(src.replace('function cleanMeta(', 'function other(')), rows)
  assert.deepEqual(gone.map((o) => [o.what, o.unread, typeof o.error]), [['meta', ['agentType', 'model'], 'string']])
  const unreadable = contract.checkReadContract(() => { throw new Error('ENOENT') }, rows)
  assert.equal(unreadable.length, rows.length)
  assert.ok(unreadable.every((o) => typeof o.error === 'string'))
})

test('the contract\'s readers: a body to its own closing brace, a constant to the end of its statement', () => {
  const src = 'class A {\r\n  private f(r) {\r\n    if (r.a) {\r\n      return r.b\r\n    }\r\n    return r?.c\r\n  }\r\n  g(r) { return r.d }\r\n}\r\n'
  const body = contract.bodyOf(src, 'private f(')
  assert.ok(body !== null)
  assert.deepEqual(contract.fieldsRead(body, 'r'), ['a', 'b', 'c'])
  assert.equal(contract.bodyOf(src, 'private h('), null)
  assert.deepEqual(contract.quotedKeys(contract.constantOf('const R = /"a":"(x|y)","b":\\d+/\nconst S = 1', 'R') ?? ''), ['a', 'b'])
  assert.deepEqual(contract.quotedKeys(contract.constantOf("const L = '\"is_error\":true'", 'L') ?? ''), ['is_error'])
  assert.deepEqual(contract.quotedKeys(contract.constantOf('const K = [\n  "x", \'y\',\n]\nconst Z = ["no"]', 'K') ?? ''), ['x', 'y'])
  assert.equal(contract.constantOf('const K = 1', 'Q'), null)
})

test('the CLI fails on a broken read contract and passes on a kept one', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tp-contract-'))
  try {
    mkdirSync(join(dir, 'dist'))
    mkdirSync(join(dir, 'src'))
    writeFileSync(join(dir, 'dist', 'extension.js'), 'const ENDPOINT = "https://api.anthropic.com/api/oauth/usage"\n')
    // 1.6 P14b (pinned and changed): the CLI checks the agent hook's bundle as well, and its two
    // readers are rows of the contract.
    const hookBundle = 'var fs = require("fs");\nvar path = require("path");\n'
    writeFileSync(join(dir, 'dist', 'agent-hook.js'), hookBundle)
    writeFileSync(join(dir, 'src', 'agentHook.ts'), fromRepo('src/agentHook.ts'))
    writeFileSync(join(dir, 'src', 'agentHookScript.ts'), fromRepo('src/agentHookScript.ts'))
    // 1.8 P4 (pinned and changed): the CLI checks the status-line bridge's bundle too, and the
    // mirror's reader is a row of the contract.
    const bridgeBundle = 'var cp = require("child_process");\nvar fs = require("fs");\nvar path = require("path");\n'
    writeFileSync(join(dir, 'dist', 'statusline-bridge.js'), bridgeBundle)
    const quota = fromRepo('src/quota.ts')
    writeFileSync(join(dir, 'src', 'quota.ts'), quota)
    // 1.8 review 2: the narrowing of an older mirror at activation is the mirror's second reader.
    writeFileSync(join(dir, 'src', 'bridge.ts'), fromRepo('src/bridge.ts'))
    // 1.8 P10 (pinned and changed): the keep-warm host's readers are rows of the contract too.
    writeFileSync(join(dir, 'src', 'keepWarmHost.ts'), fromRepo('src/keepWarmHost.ts'))
    // 1.10 P2 (pinned and changed): the terminal watch's readers — moved out of the host — as well.
    const watchSrc = fromRepo('src/terminalWatch.ts')
    writeFileSync(join(dir, 'src', 'terminalWatch.ts'), watchSrc)
    // 1.10 P3 (pinned and changed): the prompt list's reader as well.
    const promptsSrc = fromRepo('src/prompts.ts')
    writeFileSync(join(dir, 'src', 'prompts.ts'), promptsSrc)
    // 1.10 P4 (pinned and changed): and the prompt's one write into a terminal.
    writeFileSync(join(dir, 'src', 'promptsHost.ts'), fromRepo('src/promptsHost.ts'))
    const agg = fromRepo('src/agg.ts')
    const run = (): { status: number | null; out: string } => {
      const r = spawnSync(process.execPath, [join(REPO, 'scripts', 'check-privacy.mjs')], { cwd: dir, encoding: 'utf8' })
      return { status: r.status, out: `${r.stdout}${r.stderr}` }
    }
    writeFileSync(join(dir, 'src', 'agg.ts'), agg)
    // 1.6 P13b (pinned and changed): the run record's reader has a file of its own.
    const runRecord = fromRepo('src/runRecord.ts')
    writeFileSync(join(dir, 'src', 'runRecord.ts'), runRecord)
    const kept = run()
    assert.equal(kept.status, 0, kept.out)
    assert.match(kept.out, /read contract: \d+ reader\(s\)/)
    // The sidecar reader starts to read the description: the gate stops it.
    const at = agg.indexOf('function cleanMeta(')
    assert.ok(at >= 0)
    const open = agg.indexOf('{', at) + 1
    writeFileSync(join(dir, 'src', 'agg.ts'), `${agg.slice(0, open)}\n  void o.description\n${agg.slice(open)}`)
    const broken = run()
    assert.equal(broken.status, 1, broken.out)
    assert.match(broken.out, /DIFF {2}the identity sidecar/)
    assert.match(broken.out, /read but not listed: description/)
    // 1.6 P13b (§0a.12): the key-picker starts to take the run's script as well — the gate stops it.
    writeFileSync(join(dir, 'src', 'agg.ts'), agg)
    const keys = "export const RUN_RECORD_KEYS = ['status',"
    assert.ok(runRecord.includes(keys))
    writeFileSync(join(dir, 'src', 'runRecord.ts'), runRecord.replace(keys, "export const RUN_RECORD_KEYS = ['script', 'status',"))
    const picked = run()
    assert.equal(picked.status, 1, picked.out)
    assert.match(picked.out, /DIFF {2}the run record: /)
    assert.match(picked.out, /read but not listed: script/)
    writeFileSync(join(dir, 'src', 'runRecord.ts'), runRecord)
    assert.equal(run().status, 0)
    // 1.6 P14b (§0a.13): the hook's bundle reaching for the network, or missing — the gate stops both.
    writeFileSync(join(dir, 'dist', 'agent-hook.js'), `${hookBundle}var https = require("https");\n`)
    const net = run()
    assert.equal(net.status, 1, net.out)
    assert.match(net.out, /DENY {2}loads https/)
    assert.match(net.out, /the agent hook's bundle breaks its rule/)
    rmSync(join(dir, 'dist', 'agent-hook.js'))
    const missing = run()
    assert.equal(missing.status, 1, missing.out)
    assert.match(missing.out, /agent-hook\.js is missing/)
    // The hook script starts to read the prompt of a hook call: the contract stops it.
    writeFileSync(join(dir, 'dist', 'agent-hook.js'), hookBundle)
    const script = fromRepo('src/agentHookScript.ts')
    const at2 = script.indexOf('const sessionId = hookId(j.session_id)')
    assert.ok(at2 >= 0)
    writeFileSync(join(dir, 'src', 'agentHookScript.ts'), `${script.slice(0, at2)}void j.prompt\n  ${script.slice(at2)}`)
    const prompt = run()
    assert.equal(prompt.status, 1, prompt.out)
    assert.match(prompt.out, /DIFF {2}the agent hook's input/)
    assert.match(prompt.out, /read but not listed: prompt/)
    writeFileSync(join(dir, 'src', 'agentHookScript.ts'), script)
    assert.equal(run().status, 0)
    // 1.8 §7a Q16: the bridge's bundle reaching for the network, or missing — the gate stops both.
    writeFileSync(join(dir, 'dist', 'statusline-bridge.js'), `${bridgeBundle}var net = require("net");\n`)
    const bridgeNet = run()
    assert.equal(bridgeNet.status, 1, bridgeNet.out)
    assert.match(bridgeNet.out, /DENY {2}loads net/)
    assert.match(bridgeNet.out, /the status-line bridge's bundle breaks its rule/)
    rmSync(join(dir, 'dist', 'statusline-bridge.js'))
    const bridgeMissing = run()
    assert.equal(bridgeMissing.status, 1, bridgeMissing.out)
    assert.match(bridgeMissing.out, /statusline-bridge\.js is missing/)
    writeFileSync(join(dir, 'dist', 'statusline-bridge.js'), bridgeBundle)
    // 1.8 §0a.1: the mirror's reader starts to take the session's working directory — the contract stops it.
    const at3 = quota.indexOf("const rl = pick(payload, 'rate_limits', 'rateLimits') as any")
    assert.ok(at3 >= 0)
    writeFileSync(join(dir, 'src', 'quota.ts'), `${quota.slice(0, at3)}void pick(payload, 'cwd')\n  ${quota.slice(at3)}`)
    const cwd = run()
    assert.equal(cwd.status, 1, cwd.out)
    assert.match(cwd.out, /DIFF {2}the status line's session/)
    assert.match(cwd.out, /read but not listed: cwd/)
    writeFileSync(join(dir, 'src', 'quota.ts'), quota)
    assert.equal(run().status, 0)
    // 1.10 §0a.3 (P2): the watch's reader of the reported folder starts to read a terminal's name — the
    // contract stops it.
    const at4 = watchSrc.indexOf('  const si = terminal.shellIntegration')
    assert.ok(at4 >= 0)
    writeFileSync(join(dir, 'src', 'terminalWatch.ts'), `${watchSrc.slice(0, at4)}  void terminal.name\n${watchSrc.slice(at4)}`)
    const named = run()
    assert.equal(named.status, 1, named.out)
    assert.match(named.out, /DIFF {2}prompts: a terminal's shell integration/)
    assert.match(named.out, /read but not listed: name/)
    writeFileSync(join(dir, 'src', 'terminalWatch.ts'), watchSrc)
    assert.equal(run().status, 0)
    // 1.10 §0a.1 (P3): the prompt list's reader starts to take a time of the entry — the contract stops it.
    const at5 = promptsSrc.indexOf('    const title = e.title')
    assert.ok(at5 >= 0)
    writeFileSync(join(dir, 'src', 'prompts.ts'), `${promptsSrc.slice(0, at5)}    void e.sentAt\n${promptsSrc.slice(at5)}`)
    const timed = run()
    assert.equal(timed.status, 1, timed.out)
    assert.match(timed.out, /DIFF {2}prompts: an entry of the list/)
    assert.match(timed.out, /read but not listed: sentAt/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
