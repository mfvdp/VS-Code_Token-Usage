<!--
SPDX-FileCopyrightText: 2026 Frederik Marx
SPDX-License-Identifier: AGPL-3.0-or-later
-->

# Privacy

Part of the [Token Pace documentation](../README.md#documentation).

Only these are read: `~/.claude/projects/` (plus `~/.config/claude/projects/`, where some Claude
Code builds keep it), `~/.codex/sessions/` and `~/.codex/archived_sessions/`, the two quota cache
files, the `cachedUsageUtilization` object in `~/.claude.json`, the extension's own status-line
mirror file inside its `globalStorage` and — only while you have installed the agent hook — the
hook's `agent-hook.jsonl` beside it, Claude Code's `settings.json`, its `settings.local.json`
and the platform's managed-settings file (to report whether the status-line bridge is installed
and whether something shadows it) and — only in `quotaSource: poll`, only after consent —
`~/.claude/.credentials.json`, for the access token that the poll sends to
`https://api.anthropic.com/api/oauth/usage` and nowhere else.

Inside `~/.claude/projects/` three files beside the agent transcripts are read for the
[Agents](agents.md) section: the `agent-<id>.meta.json` next to each agent transcript, for five
fields — `agentType`, `model`, `spawnDepth`, `toolUseId` and `parentAgentId` (the id of the agent
that spawned it), never its `description`, its `prompt`, its `workflowPhase` or its
`worktreePath`, and only from a regular file of at most 64 KB — and a workflow run's `journal.jsonl`,
for the `type`, the `key` and the `agentId` at the head of each line, never its `result`, its
`label` or its `phase`. The `key` of a journal line is compared with the other lines of the same
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
  whether it runs in the background; from the tool result that answers it `agentId`, `status`,
  `totalTokens`, `totalDurationMs` and `totalToolUseCount`; from a `Workflow` tool call its `id`,
  and from the result that answers it the `runId` and the `status` — the call's input, which
  holds the workflow's `script`, is never read; from a queued task notification the
  `<tool-use-id>` and `<status>` tags. Never the `description`, the `prompt`, the `summary`, the
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
  tool results marked `is_error`, counted on the raw line — the line is not parsed for it, and the
  result itself is never read —, and of a reply's `diagnostics` the `cache_miss_reason`: its
  `type`, one of six reasons, and the `cache_missed_input_tokens` it states, nothing else of the
  diagnostics. In an agent's and a session's transcript: the top-level `version` of a reply (the
  Claude Code version that wrote it, three numbers), the `permissionMode` a prompt line names,
  matched on the raw line — the prompt line is never parsed for it —, and of a compaction's line (a
  `system` line whose `subtype` is `compact_boundary`) its `compactMetadata`'s `trigger` (`manual`
  or `auto`), `preTokens` and `postTokens`. Never the `isCompactSummary` line that holds the
  compaction's summary — it is not parsed at all —, never the compaction's `preservedSegment`, its
  `preservedMessages` or its `preCompactDiscoveredTools`. Each value is held to the values Claude
  Code writes, and the records keep counts, the last version and mode, and the last compaction
  with its time; the exports carry of them only the count of an agent's tool errors.

**The agent hook** ([Agents](agents.md#the-agent-hook)) is opt-in — **installed by you, removed by
you**. *Set Up the Agent Hook…* copies its script, `agent-hook.js`, into the extension's
`globalStorage` and shows the snippet you add to `~/.claude/settings.json` yourself; Token Pace
never writes into `~/.claude` and never runs the script. Claude Code runs it for four hook events,
and of each call's input it reads four keys — `hook_event_name`, `session_id`, `agent_id` and
`notification_type` —, never the call's `message`, `tool_input`, `tool_response`, `prompt`,
`transcript_path`, `cwd` or `last_assistant_message`. It appends one line to `agent-hook.jsonl`
beside itself with six fields — `v`, `ts`, `event`, `sessionId`, `agentId` and `wait`: two ids, an
event name, a time and one of three words — and writes nowhere else. It loads Node's `fs` and
`path` and nothing else (`npm run check:privacy` fails the build otherwise), opens no network
connection, prints nothing, and keeps the file to its newest 1000 lines. The extension reads the
six fields back, checks each again, and shows the latest wait as a marker in the Agents section;
nothing of it enters the snapshot, an export, the diagnostics or the log.

Nothing is written except the extension's own state in its `globalStorage` — and, while you have
installed it, the agent hook's line in the same storage —, with exactly two
opt-in exceptions, each behind its own consent dialog and each with a backup or a
never-overwrite rule: the external quota cache file (`tokenPace.writeQuotaCache`) and the
status-line bridge. Both are off by default and both are disabled in Restricted Mode.

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
does. The documentation tests hold this page and the agents page to the same table.

The webview loads no external resource at all, no telemetry of any kind is collected, and there
is no endpoint setting to point somewhere else.
