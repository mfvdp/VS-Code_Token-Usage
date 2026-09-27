<!--
SPDX-FileCopyrightText: 2026 Frederik Marx
SPDX-License-Identifier: AGPL-3.0-or-later
-->

# Counting

Part of the [Token Pace documentation](../README.md#documentation).

Three traps that make naive evaluations wrong:

* **Claude dedup.** One API response is written as *N* lines (one per content block). Dedup
  runs on `message.id` and takes the maximum per field — `output_tokens` is a streaming
  snapshot, so “first line wins” halves the value. Lines of the same id arriving later correct
  the bucket by the delta instead of being added a second time.
* **Codex fork replay.** A forked thread carries the parent thread's complete
  `token_count` history. Without detecting it you count roughly double. It is recognised via
  `session_meta.forked_from_id` (and `thread_source: "subagent"`); the preferred end-of-replay
  marker is the first `task_started` event, with a 2-second timestamp heuristic as the fallback
  for rollouts written by versions that do not persist that marker. `total_token_usage` is
  cumulative, so only the positive increase over the previous event counts.
* **Time zone.** Codex rollouts are UTC. Day boundaries are formed in local time, through `Intl`
  rather than a fixed offset — a fixed offset is wrong twice a year and would silently move
  usage between days. `tokenPace.timezone` and `tokenPace.dayBoundaryHour` (`4` books work
  between midnight and 04:00 onto the previous day) change the display only; nothing is
  re-counted.

**Buckets and roll-up.** Counts are stored per **UTC hour** while they are young, then folded
into local days after `tokenPace.hourRetentionDays` (default **45**), and days into months after
`tokenPace.retentionDays` (default **400**). Sums are preserved exactly and running the fold
twice changes nothing, but it is **irreversible**: the hour profile, the burn rate and the usage
inside a running quota window need hour resolution. A month bucket is only counted when a range
contains the whole month, because its days can no longer be told apart. Note that Claude Code
deletes its own transcripts after about 30 days, so anything older than that exists only in this
snapshot and cannot be rebuilt by a re-scan. The Records section's *Hours with the most cache written*
(1.11) ranks these UTC hour buckets — shown in the configured zone — by the tokens written to the prompt
cache, hours rather than requests: the buckets keep no single request, an hour can hold several writes,
and a large cache write is usually a cold start, a new conversation or a compaction.

**Tiers.** Fast mode and US-only inference are independent surcharges, so every bucket is keyed
by one of four tiers — `standard`, `fast`, `us`, `fast-us` — and the model table marks a
non-standard tier explicitly.

**Reasoning tokens** (`output_tokens_details.thinking_tokens`) are counted and shown separately.
They are a subset of output, so the composition bar deliberately does not draw them as their own
slice — that would count them twice.

**Tool calls.** The `tools` section counts how often each tool was called, by name, per day and
model. It is a small side table beside the buckets, not a bucket dimension: a tool dimension
would multiply every bucket by models × tiers × hours and turn every sum into a guess. Only the
**name** is read — `Read`, `Bash`, an MCP server's `files.read` — never an argument, a path or a
result. At most 100 distinct names are kept per provider and day; when a day exceeds that, the
section and the export say so instead of quietly showing a short list. The rows are kept for at
most 90 days — a table keyed by day × model × name cannot be carried as far as a rolled-up
bucket — and for less when `tokenPace.retentionDays` is shorter; the section states the first
day it has a row for, so a range that reaches further back does not read as a quiet week.

**Agents.** Where a Claude transcript sits says what it is: `<project>/<session>.jsonl` is a
session, `<session>/subagents/agent-<id>.jsonl` one of its agents — an agent spawned by another
agent lies flat beside it — and `<session>/subagents/workflows/<run>/agent-<id>.jsonl` an agent
of a workflow run. The placement is read from the nearest `subagents` directory above the file,
at every depth. A run's `journal.jsonl` sits beside its agents with the same suffix, but it is
the run's own record, not a transcript: it is never counted, only `type`, `key` and `agentId`
at the head of its lines are read — the key only compared within the journal, never kept — and
its lines say which agents the run started, which completed, which failed and which step was
started again. Claude Code's own record of a run, `<session>/workflows/wf_<id>.json`, is no
transcript either: it is never counted, and of it only seven top-level fields are read — its
`status`, `startTime`, `durationMs`, `agentCount`, `totalTokens`, `totalToolCalls` and
`defaultModel` —, shown as Claude Code's own figures and never added to a total. An agent's tokens have always been
part of the totals; the
[Agents](agents.md) section adds a view of them, not a count. Beside the buckets every agent
transcript and every session transcript of the last seven days gets a small record of its own,
filled by the same message-id dedupe, so a streamed reply counts once there as well; a launch,
its result, a task notification, a journal line or a run record only ever sets a state. The records are dropped seven days after
their last line, whatever `tokenPace.retentionDays` says.

**Claude Code's report of a sync agent.** The tool result that returns a sync agent to its parent
carries Claude Code's own figures for it, shown in the agent's details as *Report from Claude
Code*. Its `totalTokens` is the context of the agent's last request including its reply — the
input, cache write, cache read and output of that one request (a median ratio of 1.000 against
that request, measured on this machine) — not what the agent consumed over its run (a median
0.83 of the usage counted here). It is a different kind of figure, and it is never summed: not
into the agent's usage, not into any total. The agent's own *Context at the end*, beside it, is
counted here: the input, cache write and cache read of its newest request — the running maximum
over that reply's lines, as every figure of a reply is —, without the reply's output, so it
stays below Claude Code's figure by about that output.

**Lower bounds.** A response with no terminal line has an output figure that is a floor, not a
total. Such rows carry `⚠`, the tooltip states what share of today's responses are affected, and
the dashboard's data-quality section carries the lower-bound share for the whole range. In the
[Agents](agents.md) section the details say how many of an agent's replies never finished, of how
many (`⚠ lower bound — 2 of 41 replies unfinished`). Measured on this machine over seven days, a
third of the agents have such a reply — nearly always one cut off at the tool call it made, not
the agent's last: only 22 of 925 agent transcripts end on an unfinished reply.

**Upgrading.** The persisted snapshot is schema version 8; version 5, 6 and 7 are still read. It
also states the revision of the agent tables it holds — 10 in 1.9.0, 9 in 1.8.0, 8 in 1.6.0 and 1.7.0 —, and a snapshot with an older
one, or none, has the agent tables rebuilt once on the first start after the update. 1.8.0 raised it
to 9 for the [prompt-cache estimate](prompt-cache.md#how-the-estimate-is-made): the rebuild gives every
main session read in the last seven days its newest request that used the prompt cache — its time,
the kind of cache it wrote, its size and its model —, so that a session that is quiet at the update has
its estimate at once and not only with its next reply; it counts nothing, and the schema version stays 8.
1.9.0 raised it to 10 for the [keep-warm line](prompt-cache.md#keep-warm-in-a-terminal-opt-in)'s check of
the other sessions of a folder: the rebuild gives every main session read in the last seven days the
time of its newest `user` line — its `timestamp`, nothing else of the line —, so that a session left
behind before the update stops holding the line back at once, not only when its transcript leaves the
seven days; it counts nothing either, and the schema version stays 8.
Version 7 — everything before the workflow runs of the agent tables —, version 6 — everything
before the agent tables — and version 5 — everything before the tool table — are read forward
rather than thrown away, so no upgrade forces a cold re-read: a table the older version did not
have starts empty. Tool counting then starts with the next ingest, and the section states the
first day it has a row for; the agent tables and the workflow runs are rebuilt once from the
transcripts and journals of the last seven days, each read only as far as its tokens were already
counted, so no token is counted twice and no total moves. A version 7 agent record whose
completion came from the workflow journal gives it back: the rebuilt run holds the journal's view. Any
older version is discarded and the transcripts are read again from scratch — nothing is lost
that the transcripts still hold, it just takes a moment on the first start.
