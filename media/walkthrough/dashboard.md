<!--
SPDX-FileCopyrightText: 2026 Frederik Marx
SPDX-License-Identifier: AGPL-3.0-or-later
-->

### What the panel holds

| Section | Contents |
|---|---|
| quota | One card per provider the switch shows: per window a bar with the elapsed tick and the pace gap, the verdict, the reset, the forecast and a seven-day sparkline coloured by pace, and under each Claude window the subagents' share of the tokens counted over it; on the Claude card, from five minutes before a session's one-hour prompt cache expires, its state and what a cold start would cost — measured by the status line, or estimated from the transcript and marked `~` —, and on the Codex card until when OpenAI keeps a prompt prefix at least; the reading's age in the header, and under it, when a fetch of Token Pace's own failed after that reading, when it failed, why, and when the next attempt is |
| agents | The Claude Code agents running now, then the active sessions as a tree of workflow runs and agents and, after them, every other session of the last seven days in one closed row, `Earlier sessions (12)` — closed until you open them, each row with its state, usage, duration and tally, an agent's or a run's name in the colour of its state (green done, yellow unknown, red failed, blue running — beside the glyph and the word, never instead), guide lines from every child to its parent, a click for the details; a `Last 7 days` button for where the agent tokens went. Left out while the switch shows Codex |
| tokens | Fixed periods for every model of the provider the switch shows (under `All`, of every provider): the running 5 h and 7 d windows against the quota cards, today, the last 7 and 30 days, this week, this month, all time; composition bars with a cache switch; the cache economy |
| summary | Rule-based sentences, each with its figure and its basis |
| key figures | Today, usage, API equivalent, requests, cache hit, active days, avg per active day — each against the previous period, explained on hover |
| chart · models | Daily bars by model in the provider's hue — or, with the `subagents` chip, by main session and subagent — with a cost line; the per-model breakdown with price provenance |
| heatmap · hours | 53 weeks of activity, hour-of-day profile, weekday grid |
| history · data quality | The reset retrospective; every source with its age or its failure, coverage, retention, consent, role |
| prompts | Your own prompts for Claude Code and Codex — not in the default: a double-click on one types it into the terminal that runs Claude Code or Codex and presses Enter, always on your click; a click opens it to edit |

The provider switch at the very top — `Claude Code`, `Codex`, `All` — governs every section
below it: one provider's figures, or every provider's as before. The range and model chips sit
below the quota cards, the Agents section and the Tokens section and filter everything beneath
them; the agent tree is always the last seven days. The status bar, the alerts and the exports
follow no switch. At the other end of that row a flag picks the language of Token Pace's own texts
— twenty-nine of them, or *Automatic* for VS Code's display language (`tokenPace.language`); the
settings and the command titles follow VS Code's display language. Every section header carries a
gear that opens the settings
behind that section, and `tokenPace.dashboard.sections` decides which sections appear and in
which order.

Every estimate carries `~` and states what it is based on. A forecast that would
land after the reset is never emitted; below a handful of readings it says
`measuring` rather than guessing.

Three views, one view model: the webview, **Show Usage (Quick Pick)** and
**Show Usage as Text (Markdown)** cannot drift apart.
