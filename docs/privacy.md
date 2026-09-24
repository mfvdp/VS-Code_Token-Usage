<!--
SPDX-FileCopyrightText: 2026 Frederik Marx
SPDX-License-Identifier: AGPL-3.0-or-later
-->

# Privacy

Part of the [Token Pace documentation](../README.md#documentation).

Only these are read: `~/.claude/projects/` (plus `~/.config/claude/projects/`, where some Claude
Code builds keep it), `~/.codex/sessions/` and `~/.codex/archived_sessions/`, the two quota cache
files, the `cachedUsageUtilization` object in `~/.claude.json`, the extension's own status-line
mirror `statusline-mirror.json` inside its `globalStorage` (below) and the agent hook's mirror
`agent-hook.jsonl` beside it —
whenever that file exists: only the hook script you install writes it, and a line older than 30
minutes no longer counts —, Claude Code's `settings.json`, its `settings.local.json`
and the platform's managed-settings file (to report whether the status-line bridge is installed
and whether something shadows it) and — only in `quotaSource: poll`, only after consent —
`~/.claude/.credentials.json`, for the access token that the poll sends to
`https://api.anthropic.com/api/oauth/usage` and nowhere else.

Inside `~/.claude/projects/` three files beside the agent transcripts are read for the
[Agents](agents.md) section: the `agent-<id>.meta.json` next to each agent transcript, for five
fields — `agentType`, `model`, `spawnDepth`, `toolUseId` and `parentAgentId` (the id of the agent
that spawned it), never its `description`, its `prompt`, its `workflowPhase` or its
`worktreePath`, and only from a regular file of at most 64 KB — and a workflow run's `journal.jsonl`,
for the `type` (`started`, `result`, `failed` or `launched`), the `key` and the `agentId` at the
head of each line, never its `result`, its `label` or its `phase`. The `key` of a journal line is compared with the other lines of the same
journal, to tell a step that was started again from a new one, and is never kept, shown or
exported: it lives in memory only, and what the tree keeps of it is the step's ordinal. The third
is Claude Code's own record of a workflow run, `<session>/workflows/wf_<id>.json` beside the
session's `subagents/` directory, for seven top-level fields — `status`, `startTime`,
`durationMs`, `agentCount`, `totalTokens`, `totalToolCalls` and `defaultModel` —, taken by a
key-picker that walks the file's bytes and decodes nothing else of it: never the run's `script`,
its `args`, its `logs`, its `phases`, its `workflowProgress`, its `result` or its `summary`, which
never become a string at all; only from a regular file of at most 4 MB, never through a link, and
again only when its size or modification time changed. The seven are shown in the run's details as
Claude Code's own figures, never added to a total, and kept with the run for seven days; the exports
carry none of them. To catch agent files the recursive file watcher can miss (on Linux
it does), the `subagents/` directories of the active sessions and the workflow directories
inside them are also listed every five seconds while an agent runs or a Claude Code session is
active, on every platform; the listing follows no link.

`~/.claude/ide/*.lock` (which holds an `authToken` in clear text),
`~/.claude/sessions/*.key` and the `oauthAccount` block of `~/.claude.json` are **never** touched;
symlinks are not followed while scanning; the walk is confined to `projects/` and `sessions/`.

Transcript contents — prompts, responses, tool arguments and tool results — are never stored,
logged, exported or displayed. What is read out of a message body is named here — names,
identifiers and counts, never content:

* the **name** of a tool call, with the day, the model and how often it ran: that is what the
  `tools` section and the `tools[]` of the export are made of, and it is names and counts, never
  a path, an argument or an output;
* for the agent tree, of the `tool_use` blocks of a reply the `type`, the `name` and the `id`:
  from an `Agent` (or `Task`) tool call its `id` and three fields of its `input` —
  `subagent_type`, `model` and `run_in_background`: the agent's type, its model alias and
  whether it runs in the background; from the tool result that answers it `agentId`, `status` —
  one of `completed`, `failed`, `error`, `timeout`, `killed`, `cancelled`, `stopped` and
  `async_launched`, any other ignored —, `totalTokens`, `totalDurationMs` and `totalToolUseCount`; from a `Workflow` tool call its `id`,
  and from the result that answers it the `runId` and the `status` — the call's input, which
  holds the workflow's `script`, is never read; from a queued task notification the
  `<tool-use-id>` and `<status>` tags, the status one of the same seven words of an end. Never the `description`, the `prompt`, the `summary`, the
  `output-file`, the `content` or the `result`, never a workflow's `script`, `scriptPath` or
  `transcriptDir`, and never a working directory. Of an agent's transcript the `name` of its last
  tool call is kept too, with the time of its line — what the tree names when the agent went
  quiet after it ("after a Bash call") — never the call's `input`; and of each of its replies the
  top-level `effort` the line was written at, one of five words (`low`, `medium`, `high`, `xhigh`,
  `max`) — never an `effort` nested inside a tool call's input, never an error line's
  `perTurnEffort`, and not from a main session's lines. Each of these
  values is an identifier or a number, and an identifier is held to a small alphabet and length
  on the way in — one that does not fit is dropped, not trimmed. The agent tables keep them for
  seven days in the token snapshot. The CSV and JSON exports carry of each agent only what the
  Agents section shows of it — its ids, its type, model and effort, its state, its counts and
  times, who launched it and the parent's three totals ([Export and diagnostics](export.md)),
  never a path, its last tool call or a rejected request, each identifier checked against its alphabet
  once more on the way out; the diagnostics report carries none of them, and of them the log only
  ever gets counts;
* for the agent tree too, of an API error line in an agent's transcript — the line Claude Code
  writes in place of a reply when the API rejected a request — the HTTP status `apiErrorStatus`,
  the `error` kind and, of its `quotaLimits` block, the `rateLimitType`: which limit refused the
  request. Each is held to the values Claude Code writes (a status from 100 to 599, six error
  kinds, four limits), and the agent's record keeps the last one with its time. Never the line's
  `message`, which holds the error's text, never its `errorDetails`, its `apiError` or its
  `requestId`, and nothing else of `quotaLimits` — not its reset time, its overage state or its
  upgrade offers. A main session's error lines are not read for it at all;
* for the agent tree too, metadata that is no content. In an agent's transcript: the number of
  tool results marked `is_error`, counted on the raw line by the unescaped literal
  `"is_error":true` — wherever the key appears in a Claude line; the line is not parsed for it,
  only the count is taken, and the result itself is never read —, and of a reply's `diagnostics` the `cache_miss_reason`: its
  `type`, one of six reasons, and the `cache_missed_input_tokens` it states, nothing else of the
  diagnostics. In an agent's and a session's transcript: the top-level `version` of a reply (the
  Claude Code version that wrote it, three numbers), the `permissionMode`, matched on the raw line
  wherever the key appears in a Claude line; only the value of the closed enum is taken
  (`default`, `acceptEdits`, `bypassPermissions`, `plan` or `auto`) — Claude Code writes it on the
  line that holds a prompt, and that line is never parsed for it —, and of a compaction's line (a
  `system` line whose `subtype` is `compact_boundary`) its `compactMetadata`'s `trigger` (`manual`
  or `auto`), `preTokens` and `postTokens`. Never the `isCompactSummary` line that holds the
  compaction's summary — it is not parsed at all —, never the compaction's `preservedSegment`, its
  `preservedMessages` or its `preCompactDiscoveredTools`. Each value is held to the values Claude
  Code writes, and the records keep counts, the last version and mode, and the last compaction
  with its time; the exports carry of them only the count of an agent's tool errors.

**The status-line mirror** ([Quota sources](quota-sources.md#claude-status-line-bridge-opt-in),
[Prompt cache](prompt-cache.md#what-is-read)) is written only while you have the opt-in
status-line bridge connected. Claude Code pipes its whole status JSON into the bridge's script — the session's
AI-generated name, its working directory, its transcript's path, the workspace and the Claude Code
version among it. Since 1.8 the script keeps of it only the fields Token Pace reads and drops the
rest before it writes `statusline-mirror.json`, and Token Pace reads of that file only: the envelope
the script writes, `schema_version`, `written_at` and `payload`; of the payload `session_id`, to tell
one session's prompt cache from another's (1.8; an id of letters, digits, `_` and `-`, at most 64
characters, or nothing — never shown whole); `model` (its `id` and `display_name`); `plan` or
`subscription` (a name, or the `name`, `display_name` or `type` of an object); `rate_limits` (of
`five_hour`, `seven_day` and `spend_limit` the `used_percentage` or `utilization` and the
`resets_at`); `context_window` (`total_input_tokens`, `total_output_tokens`, `context_window_size`,
`used_percentage`); of `cost` only `total_cost_usd`; and `prompt_cache` (`warm`, `ttl`, `expires_at`,
`hit_ratio` and, 1.8, `recache_tokens_if_cold`, the size a cold start would re-write — a whole count
or nothing). Each is taken in camelCase too: `sessionId`, `rateLimits`, `fiveHour`, `sevenDay`,
`spendLimit`, `usedPercentage`, `resetsAt`, `contextWindow`, `totalInputTokens`,
`totalOutputTokens`, `contextWindowSize`, `totalCostUsd`, `displayName`, `promptCache`, `expiresAt`,
`hitRatio`, `recacheTokensIfCold`. Never read, and since 1.8 never in the mirror: `session_name`,
`prompt_id`, `transcript_path`, `cwd`, `workspace`, `pr`, `worktree`, `agent`, `version`,
`output_style`, `vim`, `effort`, `thinking`, `fast_mode`, `exceeds_200k_tokens`, the rest of `cost`,
and of `prompt_cache` its `caching_observed`, `requests`, `misses`, `expected_rebuilds`,
`cache_write_tokens`, `miss_recache_tokens`, `last_miss_at`, `last_miss_cause` and `miss_causes`.
**1.3 to 1.7 stored the payload as Claude Code piped it**, the session's name, its working directory
and its transcript's path in it. 1.8 stops that: on its first activation it rewrites such a mirror
with only the fields above — its time kept — or deletes one it cannot read, and removes the temp
files an interrupted write left behind; the script's next write replaces the file anyway. The
readings are kept in memory only, one per session for at most two hours; nothing of the mirror is
logged, exported or kept anywhere else. The read contract below lists these fields, and a test ties
the script's list of kept keys to it.

**The agent hook** ([Agents](agents.md#the-agent-hook)) is opt-in — **installed by you, removed by
you**. *Set Up the Agent Hook…* copies its script, `agent-hook.js`, into the extension's
`globalStorage` and shows the snippet you add to `~/.claude/settings.json` yourself; Token Pace
never writes into `~/.claude` and never runs the script. Claude Code runs it for four hook events,
and of each call's input, which Claude Code hands it on `stdin`, it reads four keys — `hook_event_name`, `session_id`, `agent_id` and
`notification_type` (one of the twelve types Claude Code's hooks reference lists; any other drops
the call) —, never the call's `message`, `tool_input`, `tool_response`, `prompt`,
`transcript_path`, `cwd` or `last_assistant_message`. It appends one line to `agent-hook.jsonl`
beside itself with six fields — `v`, `ts`, `event`, `sessionId`, `agentId` and `wait`: two ids, an
event name, a time and one of three words — and writes nowhere else. It loads Node's `fs` and
`path` and nothing else (`npm run check:privacy` fails the build otherwise), opens no network
connection, prints nothing, and keeps the file to its newest 1000 lines. The extension reads the
six fields back, checks each again, and shows the latest wait as a marker in the Agents section;
nothing of it enters the snapshot, an export, the diagnostics or the log. The keys were verified
with Claude Code 2.1.281 (four probe sessions, key names only). In Claude Code's auto mode no
permission dialog is shown, so no wait is reported. *Clear Stored Data…*
deletes `agent-hook.jsonl` ([Export and diagnostics](export.md)); the script stays while the hook
is installed and goes with the extension's storage on uninstall.

Nothing is written except the extension's own state in its `globalStorage` — among it the copy of
the agent hook's script, `agent-hook.js`, that *Set Up the Agent Hook…* puts there and that
activation replaces with the shipped one while a copy is there, the copy of the status-line bridge's
script, `statusline-bridge.js`, that *Connect Claude Status Line…* puts there and that activation
replaces with the shipped one when the two differ, and the lines the hook script
appends to `agent-hook.jsonl` while you have it installed, and `quota.json`, which holds the
readings of the quota fetch and, per provider, its last failed attempt: when it was, its kind and
the fetch's own words — a fixed phrase with at most an HTTP status, or the Codex app-server's error
string —, never a token, a header or an exception's text; the entry goes with the next successful
fetch, with *Clear Stored Data…* and with the file, and it is what lets a restart during a backoff
still say why the figure is old ([Quota sources](quota-sources.md#what-the-fetch-does)) —, with
exactly two opt-in exceptions, each behind its own consent dialog and each with a backup or a
never-overwrite rule: the external quota cache file (`tokenPace.writeQuotaCache`) and the
status-line bridge. Both are off by default and both are disabled in Restricted Mode. The bridge's
command names the script's copy in `globalStorage` since 1.8 — never the versioned extension folder,
which an update removes. A command an install of 1.3 to 1.7 wrote into `settings.json` is moved to the
copy once, on the first activation of 1.8 in a trusted window: the write you consented to at install
time, with a backup of the original bytes first, changing only the `statusLine` entry's `command`
string and only while the entry still holds the command Token Pace recorded; the log says so.

One further write exists and is not an opt-in setting: the *Run Token Pace locally* button of
the remote hint puts `remote.extensionKind` into your user `settings.json` — see
[Windows, WSL and remote development](windows-wsl-remote.md). It happens only on
that click, only on a remote host with no transcripts, and it merges rather than replaces.

The only outbound network access is the consent-gated quota fetch described under
[Quota sources](quota-sources.md). That promise is checked mechanically:
`npm run check:privacy` scans the shipped bundles for every `http(s)`
literal and matches it against a small allow-list (`api.anthropic.com`, the two official usage
pages, and documentation links that only ever appear as text). It runs in CI on all three
platforms and in the release workflow, and it fails the build on anything else — a price feed, a
status page or a CDN font would otherwise be a two-line change nobody notices in review.
The same command checks the **read contract**: a table in `scripts/check-privacy.mjs` names, for
every reader of a Claude Code file, the fields it may take — the ones this page lists above — and
the check fails when a reader takes a field the table does not list, or no longer takes one it
does. The documentation tests hold this page and the agents page to the same table — this page and
the prompt-cache page for the status-line mirror's rows. It also holds
the agent hook's bundle, `dist/agent-hook.js`, to Node's `fs` and `path`: a network module
(`http`, `https`, `net`, `tls`, `dgram`), `child_process`, `worker_threads` or a `fetch(` in it
fails the build. The status-line bridge's bundle, `dist/statusline-bridge.js` — the file its copy
is made from —, is held to `child_process` (it starts the status-line command that was there before
it), `fs` and `path` the same way: a network module, `worker_threads` or a `fetch(` in it fails the
build.

**The user agent of the quota fetch.** The version in the `User-Agent` header is the one
`claude --version` prints; where that gives none — on Windows with only the npm `claude.cmd` on the
PATH — it is the version the newest Claude Code session on this machine wrote into its transcript
(`version`, three numbers), and where neither is known a fixed version. It is the same fact the
command gives — the version of the Claude Code this machine runs —, taken from a main session's
record only, never from an agent's, and nothing else of any transcript reaches a request; with
`tokenPace.userAgent: honest` no Claude Code version is sent at all. The header goes only with the
one consent-gated fetch — in `quotaSource: poll`, after you allowed it, to
`https://api.anthropic.com/api/oauth/usage` — and only under `tokenPace.userAgent: claudeCode`. No
field is read for it that was not read before: the version is the top-level `version` the agent
tree already takes of a counted reply (above), and the read contract is unchanged. On Windows the command is
started only from a `claude.exe` found in a directory of the `PATH` — each directory is checked for
that one file's existence, nothing is read from it — and without a shell: the npm shim
`claude.cmd`, a `.bat` and a `.ps1` are never started. See [Quota sources](quota-sources.md).

**Leak tests.** Each field the agent tables and the agent hook read has a leak test whose fixture
puts synthetic text under the keys beside it — the prompt, the description, the result, the
summary, the script, the error's text — and asserts that none of it reaches the outputs that field
could reach: the snapshot, the view model, the markdown report, the CSV and JSON exports, the log,
the diagnostics report, the hook's mirror line. The status-line mirror has one too (1.8): a payload
with synthetic text under `session_name`, `cwd`, `transcript_path`, `workspace`, `pr`, `worktree`,
`agent`, `prompt_id`, `version` and the miss causes reaches neither the mirror, the view model, the
page, the markdown report, the Quick Pick, a status-bar tooltip, the log, the diagnostics report nor
an export, and of its session id at most the first eight characters. Before the 1.6.0 release a
review ran one more:
a synthetic world with prompts, descriptions, results, summaries, scripts, error texts and account
ids under every neighbouring key reaches none of the outputs.

The webview loads no external resource at all, no telemetry of any kind is collected, and there
is no endpoint setting to point somewhere else.
