<!--
SPDX-FileCopyrightText: 2026 Frederik Marx
SPDX-License-Identifier: AGPL-3.0-or-later
-->

# Export and diagnostics

Part of the [Token Pace documentation](../README.md#documentation).

**Export CSV…** writes one row per stored bucket, plus a `TOTAL` row:

```
day, hour, source, model, isSub, tier, res,
input, cacheWrite5m, cacheWrite1h, cacheRead, output, reasoning,
requests, outputFinal, webSearch, costUsd, priced
```

`priced` is `exact`, `family`, `custom` or `none`; an unpriced bucket leaves `costUsd` empty
rather than writing `0.00`, and the `TOTAL` row's last column reads `lowerBound` when the sum is
one. Days without data produce no row at all — a spreadsheet that fills gaps with zeros turns
“we were not running” into “nothing was used”, and those are different statements.

The tool table cannot be a column on a bucket row — it is keyed by day and model, a bucket row
by day, hour, model, tier and isSub, so any per-row tool number would be an invented split. It
becomes a second file beside the one you choose instead, named `….tools.csv` and announced in
the save dialog before anything is written:

```
day, source, model, tool, calls
```

Tool **names** only, never a call's input or its result. A `TRUNCATED` line is added when a day
had more distinct tools than the per-day cap, so a short table cannot be mistaken for a
complete one.

The agents of the [Agents section](agents.md) cannot be a column either: an agent is one record
across hours and days. They go into a third file beside the one you choose, named `….agents.csv`
and announced in the save dialog as well — *Agent ids and types go into a third file beside it
(.agents.csv).* One line per agent, no `TOTAL` line:

```
agentId, sessionId, workflowId, type, model, models, effort, state, derived,
outcome, outcomeStatus, attempt, firstTs, lastTs, requests, outputFinal,
input, cacheWrite5m, cacheWrite1h, cacheRead, output, reasoning, usage,
toolCalls, toolErrors, spawnedBy, reportTokens, reportDurationMs, reportToolUses
```

Which agents: the agent records whose activity — from their first line to their last — touches a
day of the exported range, within the **7 days** the agent tables keep; every session's, not only
the sessions the dashboard lists. What of them: what the Agents section shows and nothing else —

* `agentId`, `sessionId` and `workflowId` (the run, empty outside one) are the ids the details'
  ID rows show; `type` and `model` are what the agent's name is made of — the model as its
  whole id, the type empty where neither the sidecar nor the launch named one (the row says
  "Agent") —, `models` the real model ids its replies were written with, separated by spaces,
  and `effort` the effort of its newest reply;
* `state` is the tree's state at the moment of the export — `running`, `done`, `failed`,
  `stopped` or `unknown` — and `derived` says whether it was inferred (`true` for running and
  unknown), as the tree marks it with `~`. `outcome` and `outcomeStatus` are what the parent
  recorded, its tool result or a task notification, with its own word (`completed`, `killed` …);
  empty when it recorded nothing — a workflow journal's end is in `state`, not here. `attempt`
  is which start of its workflow step the agent was, as the run's journal numbers them (empty
  outside a run);
* `firstTs` and `lastTs` are its first line and its last activity (a rejected request after its
  last reply included), in ISO time; the counters are its record's, `usage` its billable tokens
  as its row counts them; `toolErrors` the tool results marked as errors, where they are
  counted — empty otherwise;
* `spawnedBy` is the agent id of the agent of the same session that launched it, `session` for
  the session's own transcript, empty when neither is known; `reportTokens`, `reportDurationMs`
  and `reportToolUses` are Claude Code's own report for it, empty without one.

An agent's tokens are **the same tokens** the bucket rows with `isSub` true count, hour by hour —
never add the two; that is also why the file has no `TOTAL`. The report is Claude Code's own
figure, never part of any total either. Never a path — neither the transcript's nor the launching
one's —, never a description, a prompt, a result or any other text of a transcript: the records
hold none of it. An empty cell is an absent value, never a zero.

**Export JSON…** writes the same buckets with the range, the timezone configuration, the pricing
provenance (`as_of`, `custom`, `multiplier`, `unknown_model`), the totals, and the notes that
qualify them. `costUsd` is `null`, not `0`, where there is no price. With attribution on it also
carries a `sessions[]` array, and the note says the project labels are exactly as stored. It also
carries `tools[]` (day, source, model, tool, calls) and `toolsTruncated`, and `agents[]` — the
agents file's rows, with the same fields and Claude Code's report as one `report` object
(`tokens`, `durationMs`, `toolUses`, or `null`); an absent value is `null`, never `0`, and an
install without agents exports an empty list. Its note says which agents and what of them:
*agents[] holds the agent records whose activity overlaps the exported range's days, within the
agent tables' 7-day retention; ids, names and counts only — never a path, a description or a
prompt.* `schema_version` is `3` since `agents[]` was added (`2` added the tool table), and
everything versions 1 and 2 wrote still means the same thing. The save dialog names what is
about to leave the machine — model names always, tool names and the agents' ids and types
(*Agents are included as agents[].*), project labels (basenames or salted hashes) when
attribution is on — because that is the last moment to say no. After the export one message
names every file written, the companions included.

**Copy Usage Summary** puts a markdown version on the clipboard: quota windows, token tables,
cache economy, the digest and the footnotes. The `~` and the lower-bound marks travel with the
numbers.

**Copy Diagnostics** builds a report from a field **allow-list**, not by dumping and redacting.
An unknown field makes the builder throw, so a leak cannot be introduced silently. It contains:
extension, VS Code, platform, arch, Node, remote name, extension kind, role, consent state,
attribution mode; roots and file counts; snapshot size, bucket counts, coverage days, retention
and quota-history size; every quota source with its age or failure and the drift list; the
status-line bridge state; the `http.proxy` settings with their origin and the six proxy
environment variables (`tokenPace.diagnostics.includeNetworkSetup`, credentials inside proxy URLs
replaced by `***`); and the current value of every `tokenPace.*` setting.

It contains **no** token, **no** transcript content and **no** object dumps. Paths are shortened
to `~`, and any key that even looks like a secret is redacted as a matter of defence in depth
(there is no key or endpoint setting to begin with).

**Clear Stored Data…** lists everything the extension has put on disk with its size, and deletes
what you pick: the token snapshot (`state.json`), the quota cache (`quota.json`), the quota
history (`quotaHistory.json`), the status-line mirror (`statusline-mirror.json`), the
[agent hook](agents.md#the-agent-hook)'s mirror (`agent-hook.jsonl`) — once you granted
`tokenPace.writeQuotaCache`, the shared quota cache files outside the extension's storage —, the
consent decisions, the alert state and the dashboard view state. The confirmation says the part
that matters: the snapshot is rebuilt from the transcripts that are still on disk, and Claude Code
deletes those after 30 days, so older history is gone for good. Deleting the agent hook's mirror
is safe — its script writes the file again on the next hook call, and the markers it reported go
with it. The script itself, `agent-hook.js`, is not in the list, and the note under the mirror
says so: it stays while the hook is installed — the entries in Claude Code's settings run it —
and goes with the extension's storage when Token Pace is uninstalled. The leader lease is never
offered for deletion — it is live coordination between open windows, not stored data. The
bridge's install record is kept too: it is the undo.

**Uninstalling** through the Extensions view runs a `vscode:uninstall` hook that removes the
extension's `globalStorage` directory, best effort, and only when the path ends in exactly
`User/globalStorage/frederik.token-pace`.
