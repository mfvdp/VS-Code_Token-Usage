<!--
SPDX-FileCopyrightText: 2026 Frederik Marx
SPDX-License-Identifier: AGPL-3.0-or-later
-->

# Commands and keybindings

Part of the [Token Pace documentation](../README.md#documentation).

| Command | Keybinding | Purpose |
|---|---|---|
| `Token Pace: Open Dashboard` | `ctrl+alt+shift+t` / `cmd+alt+shift+t` | The dashboard in the secondary sidebar |
| `Token Pace: Show Usage (Quick Pick)` | | The whole view model as a searchable flat list — following the dashboard's provider switch, its first line naming the provider while the switch shows one |
| `Token Pace: Show Usage as Text` | | A read-only markdown document with the same figures — following the dashboard's provider switch, its range line ending `· Codex only` while the switch shows Codex |
| `Token Pace: Show Actions Menu` | | The QuickPick behind a status bar click |
| `Token Pace: Fetch Quota Now` | | Immediate fetch, asking for consent if needed. Disabled in `quotaSource: cache` |
| `Token Pace: Re-read Token History` | | Full re-scan of all transcripts |
| `Token Pace: Cycle Status Bar Windows` | | Steps `windowSelect` through its values |
| `Token Pace: Preview Status Bar States` | | Synthetic renderings of every state, for 60 seconds |
| `Token Pace: Open Official Usage Page` | | Opens the provider's own usage page in your browser |
| `Token Pace: Export CSV…` | | One row per bucket, plus a `TOTAL` row — the tool table in a second file beside it, the agents in a third; every provider, whatever the switch shows |
| `Token Pace: Export JSON…` | | Buckets, tool calls, agents, totals, range, timezone and pricing provenance; every provider, whatever the switch shows |
| `Token Pace: Copy Usage Summary` | | The summary as markdown, on the clipboard — following the dashboard's provider switch as the markdown document does |
| `Token Pace: Copy Diagnostics` | | An allow-listed report, safe to paste into an issue |
| `Token Pace: Copy Agent ID` | | The whole id of the node selected in the Agents section — agent, launch, run or session, also while its row is inside a closed branch — on the clipboard; the details' *Copy ID* button does the same |
| `Token Pace: Set Up the Agent Hook…` | | Copies the agent hook's script into the extension's storage and opens a read-only document with the snippet you add to `~/.claude/settings.json` yourself, what it reads and how to remove it — Token Pace writes nothing into `~/.claude` (see [Agents](agents.md#the-agent-hook)) |
| `Token Pace: Connect Claude Status Line…` | | Installs the status-line bridge (opt-in, with consent and a backup) |
| `Token Pace: Disconnect Claude Status Line` | | Restores the previous status line, if it is still ours to restore |
| `Token Pace: Clear Stored Data…` | | Lists and deletes what the extension has stored — the snapshot, the quota cache and history, the status-line mirror, the agent hook's mirror `agent-hook.jsonl`, the keep-warm accounting `keepwarm.json`, the decisions and the view state; the hook's script `agent-hook.js` stays while the hook is installed and goes with the storage on uninstall, and so does the status-line bridge's script `statusline-bridge.js` while the status line is connected (see [Export and diagnostics](export.md)) |
| `Token Pace: Reset Network Access Decision` | | Puts the consent question back |
| `Token Pace: Cancel the Keep-Warm Line` | | Cancels the keep-warm countdown under way — the same as a click on its status-bar item — and keep-warm for the rest of that session's idle phase, until you send the session a request of your own; without a countdown it does nothing. Arguments are ignored (see [Prompt cache](prompt-cache.md#keep-warm-in-a-terminal-opt-in)) |
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

**Interface language.** There is no command for it. The language of Token Pace's own texts is the
setting `tokenPace.language` — `auto`, the default, or one of fourteen languages —, and the flag at
the top of the dashboard sets it for you (see [Languages](languages.md)). What the extension
*renders* — the status bar and its tooltips, the dashboard, the Quick Pick, the markdown report, the
notifications and dialogs and the agent hook's setup document — follows that setting at once; the
debug log, the diagnostics report and the CSV and JSON exports stay English on purpose. Everything
the *manifest* contributes — the command titles, the settings pages, the view's name and the
walkthrough's titles — follows VS Code's display language (*Configure Display Language*) instead, and
does not switch with the picker: `package.json` holds only `%key%` placeholders, the words live in
`package.nls.json` (English) and one `package.nls.<id>.json` per language — German, and since 1.9 the
twelve languages of [Languages](languages.md) —, and VS Code picks the file matching its display
language when it starts, falling back to English for any key a translation lacks. Setting ids, enum
values, paths and the JSON examples in the descriptions are identical in every language, because
they are what you copy. `test/nls.test.ts` fails if a key is missing, unused, or if a translation
drops a setting link or an example; how a language is added is in
[Building and testing](development.md#translating).

**Walkthrough.** *Help → Get Started* lists **Get started with Token Pace**: what the bar and
its colours mean, where the quota figures come from and what “poll” means, and the dashboard.
Its three steps carry the buttons for *Preview Status Bar States*, *Fetch Quota Now*,
*Connect Claude Status Line*, *Open Settings* and *Open Dashboard*.
