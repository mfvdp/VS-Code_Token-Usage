<!--
SPDX-FileCopyrightText: 2026 Frederik Marx
SPDX-License-Identifier: AGPL-3.0-or-later
-->

# Prompt cache

Part of the [Token Pace documentation](../README.md#documentation).

Claude Code keeps the start of a conversation — the system prompt, the tools, the messages so far
— in Anthropic's prompt cache, so that the next request reads that prefix at a fraction of the
input price instead of writing it again. Its status line reports the state of that cache for the
session it runs for: warm or cold, the time-to-live (5 minutes or 1 hour), when the cached prefix
expires, how much of the input the cache served and — from Claude Code 2.1.251 on — how many tokens
the next request re-caches if the cache has gone cold by then.

Token Pace learns all of this as Claude Code states it only through the opt-in
[status-line bridge](quota-sources.md#claude-status-line-bridge-opt-in). With the bridge connected
the Claude quota card ends with a prompt-cache line built from that report — on the
[Dashboard](dashboard.md), in the [status bar](status-bar.md)'s tooltip and in the text views.
Where the bridge does not describe a session, Token Pace estimates the session's cache from its
transcript instead, and every figure of that estimate carries `~` — see
[How the estimate is made](#how-the-estimate-is-made).

## One reading per session

The bridge's mirror holds one session at a time: the one whose status line ran last. Since 1.8
Token Pace keeps in memory the newest reading of every session the mirror named since the window
opened, by the session's `session_id`, so that one session's prompt cache is never taken for
another's: at most 16 sessions — the oldest reading goes first —, none whose reading is older than
two hours, and an older reading of a session never replaces a newer one. A reading without a
session id (a Claude Code build that does not send one, or an id outside the alphabet below) is not
kept per session. Nothing of it is stored: after a reload a session is back with its next
status-line run, and *Clear Stored Data…* forgets the readings together with the mirror. Two
sessions writing the mirror within 300 ms of each other lose the older write; that session's next
run brings it back.

## What is read

The bridge's script receives the whole status JSON from Claude Code and, since 1.8, writes of it
into `statusline-mirror.json` in the extension's storage only the fields listed here — everything
else is dropped before the file is written (1.3 to 1.7 kept the payload whole; see
[Privacy](privacy.md)). Token Pace reads of that file:

* the envelope the script writes around the payload: `schema_version`, `written_at` and `payload`;
* `session_id` — whose cache it is (1.8). Only an id of letters, digits, `_` and `-`, at most 64
  characters, is taken; anything else counts as no id. It is never shown whole;
* `model`: its `id` and its `display_name`;
* `plan` or `subscription`: a name, or the `name`, `display_name` or `type` of an object;
* `rate_limits`: of `five_hour`, `seven_day` and `spend_limit` the `used_percentage` (or
  `utilization`) and the `resets_at`;
* `context_window`: `total_input_tokens`, `total_output_tokens`, `context_window_size` and
  `used_percentage`;
* `cost`: its `total_cost_usd` and nothing else of it;
* `prompt_cache`: `warm`, `ttl`, `expires_at`, `hit_ratio` and — 1.8 — `recache_tokens_if_cold`, the
  size a cold start would re-write: a whole count from 0 to 10 000 000, anything else counts as no
  figure.

Each field is taken in camelCase too, as Claude Code builds have spelled them: `sessionId`,
`rateLimits`, `fiveHour`, `sevenDay`, `spendLimit`, `usedPercentage`, `resetsAt`, `contextWindow`,
`totalInputTokens`, `totalOutputTokens`, `contextWindowSize`, `totalCostUsd`, `displayName`,
`promptCache`, `expiresAt`, `hitRatio` and `recacheTokensIfCold`.

Never read, and since 1.8 never in the mirror: `session_name` (the session's AI-generated title),
`prompt_id`, `transcript_path`, `cwd`, `workspace`, `pr`, `worktree`, `agent`, `version`,
`output_style`, `vim`, `effort`, `thinking`, `fast_mode`, `exceeds_200k_tokens`, the rest of `cost`,
and of `prompt_cache` its `caching_observed`, `requests`, `misses`, `expected_rebuilds`,
`cache_write_tokens`, `miss_recache_tokens`, `last_miss_at`, `last_miss_cause` and `miss_causes`.

The read contract of `npm run check:privacy` lists these fields reader by reader, and the check
fails when the reader takes one more or no longer takes one of them; the documentation tests hold
this page and [Privacy](privacy.md) to the same list, and a test ties the script's list of kept
keys to it. Nothing of the mirror is logged or exported.

## How the estimate is made

The transcript of a Claude Code session says when each request went out and what it did with the
prompt cache, in the token counts Token Pace reads anyway. For every main session — never an
agent's transcript: a subagent has a prefix of its own and, by default, the 5-minute cache — Token
Pace keeps its newest request that read or wrote the cache, that is, the newest counted reply whose
`usage` shows `cache_creation_input_tokens` or `cache_read_input_tokens` above zero:

* **when** — the `timestamp` of the reply's first line, the earliest moment the transcript knows of
  the request;
* **which cache** — 1 hour when the reply wrote `ephemeral_1h_input_tokens` (in
  `usage.cache_creation`), 5 minutes when it wrote only the 5-minute kind; a reply that only read
  keeps the kind of the write before it, because reading an entry refreshes it; before the
  session's first write there is no kind, and nothing is estimated;
* **how large** — `input_tokens` + `cache_creation_input_tokens` + `cache_read_input_tokens` +
  `output_tokens` of that reply, each the largest its lines showed: about the prefix the next request
  sends, which is why the size is an estimate as well;
* **which model** — its `message.model`, letters, digits and `_.:@/-`, at most 64 characters, or
  none.

A later line of the same reply grows its size and keeps its time; a late line of an older reply
changes nothing; an error line and a placeholder reply are no requests. Two further facts are kept
with it, for the checks of the opt-in keep-warm line rather than for the estimate: the reply's
`stop_reason` — one of `end_turn`, `tool_use`, `max_tokens`, `stop_sequence`, `pause_turn` and
`refusal`; any other value counts as none — and whether the transcript's newest message line is the
user's, a prompt or a tool result. Claude Code writes a reply that calls a tool only once the tool
has finished, so while a permission dialog or a question stands open the newest line is the user's.
Only a line's top-level `type` decides — a user line is recognised on the raw line and never parsed
for it —, and lines that are no message (attachments, system lines, file-history snapshots, the
session's title and mode lines) do not count.

No field is read for any of it that the token count did not read before. It is kept with the
session's record in the token snapshot for seven days, never logged and never exported, and the
first start of 1.8 rebuilds the agent tables once so that the sessions already read have it at once
([Counting](counting.md)).

**The estimated expiry** is that time plus one hour, for a 1-hour cache. It errs in both directions,
which is why it carries `~`: the API counts an entry's lifetime from the start of the request that
writes or reads it, not from the end of its response, and the transcript records when Claude Code
wrote the reply's first line, after the request began — so the estimate runs late by the time the
model took to start its reply; a request that read the cache without writing a line to the transcript
would make it early.

**Codex.** Of the Codex rollouts Token Pace keeps one value for the whole machine: the time and the
model of the newest counted turn of a rollout that is not a fork — the `timestamp` of its
`token_count` event and the `model` its `turn_context` named (letters, digits and `_.:@/-`, at most
64 characters; a turn without such a model keeps nothing) — for the Codex prompt-cache line. It is
kept in the token snapshot and not rebuilt after the update: that line speaks of the last 30 minutes
only, which the next turn fills.
