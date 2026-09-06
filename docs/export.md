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

**Export JSON…** writes the same buckets with the range, the timezone configuration, the pricing
provenance (`as_of`, `custom`, `multiplier`, `unknown_model`), the totals, and the notes that
qualify them. `costUsd` is `null`, not `0`, where there is no price. With attribution on it also
carries a `sessions[]` array, and the note says the project labels are exactly as stored. It also
carries `tools[]` (day, source, model, tool, calls) and `toolsTruncated`; `schema_version` is `2`
since those two were added, and everything version 1 wrote still means the same thing. The
save dialog names what is about to leave the machine — model names always, project labels
(basenames or salted hashes) when attribution is on — because that is the last moment to say no.

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
history (`quotaHistory.json`), the status-line mirror, the consent decisions, the alert state and
the dashboard view state. The confirmation says the part that matters: the snapshot is rebuilt
from the transcripts that are still on disk, and Claude Code deletes those after 30 days, so
older history is gone for good. The leader lease is never offered for deletion — it is live
coordination between open windows, not stored data. The bridge's install record is kept too: it
is the undo.

**Uninstalling** through the Extensions view runs a `vscode:uninstall` hook that removes the
extension's `globalStorage` directory, best effort, and only when the path ends in exactly
`User/globalStorage/frederik.token-pace`.
