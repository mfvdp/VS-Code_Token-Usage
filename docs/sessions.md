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
