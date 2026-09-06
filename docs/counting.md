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
snapshot and cannot be rebuilt by a re-scan.

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

**Lower bounds.** A response with no terminal line has an output figure that is a floor, not a
total. Such rows carry `⚠`, the tooltip states what share of today's responses are affected, and
the dashboard's data-quality section carries the lower-bound share for the whole range.

**Upgrading.** The persisted snapshot is schema version 6. Version 5 — everything before the tool
table — is read forward with an empty tool table rather than being thrown away, so no upgrade
forces a cold re-read; tool counting then starts with the next ingest, and the section states the
first day it has a row for. Any older version is discarded and the transcripts are read again
from scratch — nothing is lost that the transcripts still hold, it just takes a moment on the
first start.
