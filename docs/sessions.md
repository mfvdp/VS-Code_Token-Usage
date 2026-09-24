<!--
SPDX-FileCopyrightText: 2026 Frederik Marx
SPDX-License-Identifier: AGPL-3.0-or-later
-->

# Sessions and projects

Part of the [Token Pace documentation](../README.md#documentation).

`tokenPace.attribution` is `none` by default. With `project` or `session`, Token Pace stores
**project basenames** — the last path segment of the working directory — and **session ids** in
its own extension storage. Never the full path, never a file name, and never anything from the
transcript itself: no prompt, no response, no tool call.

`tokenPace.showProjectNames: hash` replaces the basename with a salted hash (the salt is per
installation, so two people with the same checkout path do not share a pseudonym), which keeps
the grouping while making the panel safe to show in a screen share.

Changing `attribution` triggers a full re-scan, because the information is not in the existing
snapshot. Switching back to `none` deletes the collected per-session records.

The dashboard's `projects` and `sessions` sections follow the range, the model chips and the
provider switch at the top of the page: under `Codex` they list the Codex usage of the range alone,
under `All` every provider's ([Dashboard](dashboard.md)).

**The agent tree is not attribution.** Whatever `attribution` says, the [Agents](agents.md)
section keeps small tables of its own for **7 days**: per session transcript and per agent
transcript the session id, the agent id and the workflow run it belongs to, the agent's type and
model names, times, token counts and the recorded result, and the metadata the tree shows — the
effort of its replies, its last rejected request (HTTP status, error kind, limit), the name of
its last tool call, its tool errors, its cache misses by reason, the Claude Code version, the
permission mode and its compactions —; per workflow run the agents its journal started, their
steps and attempts, and the seven fields of Claude Code's run record — keyed by the transcript's
path, as every transcript's read position in the snapshot always was. They hold no project name,
no prompt, no description and no result (the full list is in [Agents](agents.md#what-is-read)). With
`none` a session in the tree is named by when it started and the first eight characters of its
id — `Session Tue 14:20 · 9d0eb37a` — and nothing else; with `project` or `session` it also
carries the project label of the table above — the salted hash, under `showProjectNames: hash`. Switching back to `none` therefore leaves the tree
in place, without its project labels; its records age out seven days after their last line.
