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
requests, outputFinal, webSearch, costUsd, priced,
listCostUsd, priceFrom, priceApproximate,
project
```

`priced` is `exact`, `family`, `custom` or `none`; an unpriced bucket leaves `costUsd` empty
rather than writing `0.00`, and the `TOTAL` row's `priced` column reads `lowerBound` when the sum is
one. Days without data produce no row at all — a spreadsheet that fills gaps with zeros turns
“we were not running” into “nothing was used”, and those are different statements.

The last three columns (1.11) say what each figure was priced by. `listCostUsd` is the same usage
at the published list price — multiplier 1, no custom price — beside `costUsd` at your configured
rates, so a discount shows as the difference between the two; where a custom price alone prices a
model the table does not know, it equals `costUsd`, because a discount against a price that was
never published would be an invention. `priceFrom` is the day the price rule used was read — the
`from` of the dated rule, the borrowed model's under the family fallback —, empty where a custom
price alone priced the bucket. `priceApproximate` is `true` where no rule covered the bucket's day
and the nearest one was used ([how the table is dated](cost.md)). An unpriced bucket leaves all three
empty, as it leaves `costUsd`; the `TOTAL` row carries the list amounts of the priced buckets summed
and leaves the other two empty. The eighteen columns before them keep their positions.

The last column (1.14), `project`, names the bucket's project while `tokenPace.attribution` is
`project` or `session` ([Sessions and projects](sessions.md)) — the label the dashboard shows: the
folder's name with `showProjectNames: basename`, else its pseudonym `p:8f31c0a4e2b1`; `(no project)`
for a Codex session without a working directory and `other projects` for the projects folded into it
(beyond the 200 kept, or idle longer than `retentionDays`), both in English as the whole file is. A name never stands beside its pseudonym — the file
holds the one or the other, so a file shared under `hash` cannot be matched with the folder —, and it
holds no path and no salt. Buckets of several projects in one hour are separate rows, one per project:
summing an hour's or a day's rows gives the figures a schema 4 file had in its one row. Under `none` the
column is there and empty in every row — the header is the same for every file of schema 5, and the
twenty-one columns before it keep their positions —, and the `TOTAL` row leaves it empty, the total
being every project's of the range. The export follows no project filter: every project of the range
is in the file, and the column is there to filter by in a spreadsheet.

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
provenance (`as_of`, `custom`, `multiplier`, `unknown_model`, and since 1.11 `checked_later` — each
row read after `as_of`, `model` with the day of its own check, `checked`; every provider's, whatever
the dashboard shows — and `sources`, the pages the table was read from as host names:
`docs.claude.com`, `platform.claude.com`, `developers.openai.com`), the totals, and the notes that
qualify them. `costUsd` is `null`, not `0`, where there is no price. Each bucket carries the CSV's
`listCostUsd`, `priceFrom` and `priceApproximate` — `null`, `null` and `false` where the CSV leaves
them empty — and `totals` carries `listCostUsd`; the note says what they are: *listCostUsd is the same
usage at the published list price (multiplier 1, no custom price); where a custom price alone priced a
model, it equals costUsd; priceFrom is the day the price rule used was read; priceApproximate means no
rule covered that day and the nearest one was used.* With attribution on each bucket carries the
CSV's `project` as its last field — under `none` no bucket does —, and the file carries a `sessions[]`
array: the session records whose activity touches a day of the range (1.14 — until 1.13 every record),
the first to start first, each with the same `project` label and its counters over its whole lifetime,
which can reach outside the range. Two notes say so, after the ones versions 1–4 wrote: *sessions[] holds
the session records whose activity overlaps the exported range's days, each counted over its whole
lifetime, which can reach outside the range; project is the label its buckets carry* and *project is the
project's label as the dashboard shows it — the folder's name with showProjectNames basename, else a
salted pseudonym; buckets of several projects in one hour are separate rows.* It also
carries `tools[]` (day, source, model, tool, calls) and `toolsTruncated`, and `agents[]` — the
agents file's rows, with the same fields and Claude Code's report as one `report` object
(`tokens`, `durationMs`, `toolUses`, or `null`); an absent value is `null`, never `0`, and an
install without agents exports an empty list. Its note says which agents and what of them:
*agents[] holds the agent records whose activity overlaps the exported range's days, within the
agent tables' 7-day retention; ids, names and counts only — never a path, a description or a
prompt.* `schema_version` is `5` since 1.14 added `project` to `buckets[]` and as the CSV's last
column, and gave `sessions[]` the range's sessions named by the dashboard's label — `p:` and the key
where 1.13 wrote the bare hash of another rule, so no pseudonym of 1.14 matches one of an earlier file
(`4`, 1.11, added `listCostUsd`, `priceFrom` and `priceApproximate` to `buckets[]`, `listCostUsd` to
`totals`, and `checked_later` and `sources` to `pricing`; `3` added `agents[]`, `2` the tool table);
every field versions 1–4 wrote is still there under its name, and under `none` a schema 5 JSON file is a
schema 4 one with the new number. The save dialog names what is
about to leave the machine — model names always, tool names and the agents' ids and types
(*Agents are included as agents[].*), project labels when attribution is on (*Includes model names and
project labels (salted hashes).*, with `showProjectNames: basename` *Includes model names and project
labels (directory basenames).*) — because that is the last moment to say no. After the export one message
names every file written, the companions included.

**Copy Usage Summary** puts a markdown version on the clipboard: quota windows, token tables,
the projects (with attribution on), cache economy, the digest and the footnotes. The `~` and the lower-bound marks travel with the
numbers, and so does the sentence of a transient failure of our own fetch after the reading shown —
`_Last attempt at 14:20 failed: HTTP 429 — backing off before the next attempt · next attempt in
1h12m_` under the provider's heading, as the markdown view prints it. It follows the dashboard's
provider switch as the markdown view does: under one provider it carries that provider's figures
alone and its heading ends `· Codex only`. It follows the dashboard's project filter the same way
(1.14): with attribution on it carries the Projects table as the markdown view prints it — the same
columns, the price footnote once among the footnotes, the lower-bound and the folded line under the
table —, and while a project chip is pressed its figures are the chosen projects' and its heading ends
`· project filter: p:8f31c0a4e2b1` (the folder's name with `basename`). The CSV and JSON exports and *Copy Diagnostics* follow
neither the switch nor the chips: the exports write every provider's and every project's rows of the range.

**Copy Diagnostics** builds a report from a field **allow-list**, not by dumping and redacting.
An unknown field makes the builder throw, so a leak cannot be introduced silently. It contains:
extension, VS Code, platform, arch, Node, remote name, extension kind, role, consent state,
attribution mode; roots and file counts; snapshot size, bucket counts, coverage days, retention
and quota-history size; every quota source with its age or failure and the drift list, and per
provider one line with the next attempt our own fetch wants — the end of a backoff included — and
the kind and the time of our own last failed attempt,
`claude — next attempt 2026-09-24T12:52:00.000Z · last failed attempt 2026-09-24T11:40:00.000Z [retry]`,
each `none` where there is none — never the failure's words, whatever the kind; the language line
(1.9), `setting auto · shown de · VS Code de` — the setting, the language whose words are shown and
VS Code's display language, each a tag or `–` —, while the report itself stays English; since 1.12 the Codex
app-server's line, `codex connection — mode persistent · state ready · restarts 0 in the last hour · pushes 3 · last
push 42 s ago` ([The Codex app-server](quota-sources.md#the-codex-app-server)), and the credentials' line,
`credentials — source keychain · keychain allowed` — where the token came from, by a name, never the token; the
status-line bridge state; a section `## Notifications` with one line per channel — whether it is listed, whether its
secret is set, whether its consent stands, its last result — then the listed events and the messages of this hour,
never a host, an address, a chat id or a secret ([Notifications](notifications.md#the-diagnostics-and-the-log)); the
`http.proxy` settings with their origin and the six proxy
environment variables (`tokenPace.diagnostics.includeNetworkSetup`, credentials inside proxy URLs
replaced by `***`); and the current value of every `tokenPace.*` setting.

It contains **no** token, **no** transcript content and **no** object dumps. Paths are shortened
to `~`, and any key that even looks like a secret is redacted as a matter of defence in depth
(no setting holds a key or a secret to begin with). The notification settings' fields that name a host or an
address — `host`, `user`, `from`, `to`, `chatId` and `server` — read `set` or `not set` (1.12).

**Clear Stored Data…** lists what the extension has stored, each with its size, and deletes
what you pick: the token snapshot (`state.json`), the quota cache (`quota.json` — the readings of
Token Pace's own fetch, the time of its next attempt and, per provider, its last failed attempt), the quota
history (`quotaHistory.json`), the status-line mirror (`statusline-mirror.json`), the
[agent hook](agents.md#the-agent-hook)'s mirror (`agent-hook.jsonl`), the keep-warm accounting (`keepwarm.json`, the
answered [keep-warm lines](prompt-cache.md#keep-warm-in-a-terminal-opt-in) per day and their tokens), your
[prompt list](prompts.md) (`prompts.json`, with the number of prompts it holds) — once you granted
`tokenPace.writeQuotaCache`, the shared quota cache files outside the extension's storage —, the
consent decisions (the keep-warm consent and, since 1.12, the macOS Keychain's among them), the alert state, the
notification channels (1.12, with the number of channels set up — their secrets in VS Code's secret storage, your
consents for their hosts and their last results, as one item) and the dashboard view state.
Deleting `keepwarm.json` deletes the accounting and nothing else; no line depends on it. Deleting `prompts.json`
returns the Prompts section to the three prompts Token Pace ships; the titles and texts you wrote are in no export, no
report and no log, so the file is the only place they are. The confirmation says the part
that matters: the snapshot is rebuilt from the transcripts that are still on disk, and Claude Code
deletes those after 30 days, so older history is gone for good. Deleting the agent hook's mirror
is safe — its script writes the file again on the next hook call, and the markers it reported go
with it. The script itself, `agent-hook.js`, is not in the list, and the note under the mirror
says so: it stays while the hook is installed — the entries in Claude Code's settings run it —
and goes with the extension's storage when Token Pace is uninstalled. The status-line bridge's
script, `statusline-bridge.js` — the copy Claude Code's `statusLine.command` runs since 1.8 — is not
in the list either: it stays while the status line is connected, and activation replaces it with the
shipped one when the two differ. The leader lease is never
offered for deletion — it is live coordination between open windows, not stored data. The
bridge's install record is kept too: it is the undo.

**Uninstalling** through the Extensions view runs a `vscode:uninstall` hook that removes the
extension's `globalStorage` directory, best effort, and only when the path ends in exactly
`User/globalStorage/frederik.token-pace`. The copies of the two scripts go with it — the agent hook's
`agent-hook.js` and the status-line bridge's `statusline-bridge.js` —, so a hook still entered in
Claude Code's settings, or a status line still connected, would then start a script that is gone:
remove the hook's entries and run *Token Pace: Disconnect Claude Status Line* first. A notification channel's
secrets are not in that directory but in VS Code's secret storage, which VS Code does not clear when an extension is
uninstalled (a secret goes only when the extension deletes it — VS Code 1.139.1's code, read on 2026-09-29): remove
your channels first (*Remove a Notification Channel…*, or
*Clear Stored Data…*'s *Notification channels*).
