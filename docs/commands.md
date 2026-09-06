<!--
SPDX-FileCopyrightText: 2026 Frederik Marx
SPDX-License-Identifier: AGPL-3.0-or-later
-->

# Commands and keybindings

Part of the [Token Pace documentation](../README.md#documentation).

| Command | Keybinding | Purpose |
|---|---|---|
| `Token Pace: Open Dashboard` | `ctrl+alt+shift+t` / `cmd+alt+shift+t` | The dashboard in the secondary sidebar |
| `Token Pace: Show Usage (Quick Pick)` | | The whole view model as a searchable flat list |
| `Token Pace: Show Usage as Text` | | A read-only markdown document with the same figures |
| `Token Pace: Show Actions Menu` | | The QuickPick behind a status bar click |
| `Token Pace: Fetch Quota Now` | | Immediate fetch, asking for consent if needed. Disabled in `quotaSource: cache` |
| `Token Pace: Re-read Token History` | | Full re-scan of all transcripts |
| `Token Pace: Cycle Status Bar Windows` | | Steps `windowSelect` through its values |
| `Token Pace: Preview Status Bar States` | | Synthetic renderings of every state, for 60 seconds |
| `Token Pace: Open Official Usage Page` | | Opens the provider's own usage page in your browser |
| `Token Pace: Export CSV…` | | One row per bucket, plus a `TOTAL` row — and the tool table in a second file beside it |
| `Token Pace: Export JSON…` | | Buckets, tool calls, totals, range, timezone and pricing provenance |
| `Token Pace: Copy Usage Summary` | | The summary as markdown, on the clipboard |
| `Token Pace: Copy Diagnostics` | | An allow-listed report, safe to paste into an issue |
| `Token Pace: Connect Claude Status Line…` | | Installs the status-line bridge (opt-in, with consent and a backup) |
| `Token Pace: Disconnect Claude Status Line` | | Restores the previous status line, if it is still ours to restore |
| `Token Pace: Clear Stored Data…` | | Lists and deletes what the extension has stored |
| `Token Pace: Reset Network Access Decision` | | Puts the consent question back |
| `Token Pace: Open Settings` | | The extension's settings |
| `Token Pace: Show Log` | | The output channel |

**One keybinding, and it can be switched off.** Only *Open Dashboard* claims a chord. A single
small extension taking two global chords is greedy, and the second one — `ctrl+alt+shift+q` for
*Fetch Quota Now* in earlier versions — bought nothing: fetching is reachable from the status
bar click, the tooltip footer, the actions menu, the panel's title bar and the Command Palette.
It has been removed. The remaining binding is gated on `tokenPace.keybindings`, so it can be
freed from the settings UI instead of by writing a `-` rule into `keybindings.json`; every
command stays available from the Command Palette either way.

The dashboard's title bar carries *Fetch Quota Now*, *Re-read Token History*, *Show Log*,
*Open Settings* and *Export CSV…*.

**Interface language.** Everything the *manifest* contributes is localized: the store listing,
the display name, the command titles, the settings pages and the walkthrough. `package.json`
holds only `%key%` placeholders, the words live in `package.nls.json` (English) and
`package.nls.de.json` (German), and VS Code picks the file matching its display language
(*Configure Display Language*), falling back to English for any key a translation lacks. Setting
ids, enum values, paths and the JSON examples in the descriptions are identical in both
languages, because they are what you copy. What the extension *renders* is English everywhere —
status bar, tooltip, dashboard, text views, exports. That split is deliberate: those sentences
are assembled from fragments, de-duplicated against one another and asserted verbatim by the
tests, so translating them takes a vocabulary seam, not a search-and-replace. A further language
is one file, `package.nls.<locale>.json` with the keys of `package.nls.json`; `test/nls.test.ts`
fails if a key is missing, unused, or if a translation drops a setting link or an example.

**Walkthrough.** *Help → Get Started* lists **Get started with Token Pace**: what the bar and
its colours mean, where the quota figures come from and what “poll” means, and the dashboard.
Its three steps carry the buttons for *Preview Status Bar States*, *Fetch Quota Now*,
*Connect Claude Status Line*, *Open Settings* and *Open Dashboard*.
