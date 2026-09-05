<!--
SPDX-FileCopyrightText: 2026 Frederik Marx
SPDX-License-Identifier: AGPL-3.0-or-later
-->

### What the panel holds

| Section | Contents |
|---|---|
| quota | One card per provider: per window a bar with the elapsed tick and the pace gap, the verdict, the reset, the forecast and a seven-day sparkline coloured by pace; the reading's age in the header |
| tokens | Fixed periods for every provider and model: the running 5 h and 7 d windows against the quota cards, today, the last 7 and 30 days, this week, this month, all time; composition bars with a cache switch; the cache economy |
| summary | Rule-based sentences, each with its figure and its basis |
| key figures | Today, usage, API equivalent, requests, cache hit, active days, avg per active day — each against the previous period, explained on hover |
| chart · models | Daily bars by model in the provider's hue, with a cost line; the per-model breakdown with price provenance |
| heatmap · hours | 53 weeks of activity, hour-of-day profile, weekday grid |
| history · data quality | The reset retrospective; every source with its age or its failure, coverage, retention, consent, role |

The range, provider and model chips sit below the quota cards and the Tokens section and
filter everything beneath them. Every section header carries a gear that opens the settings
behind that section, and `tokenPace.dashboard.sections` decides which sections appear and in
which order.

Every estimate carries `~` and states what it is based on. A forecast that would
land after the reset is never emitted; below a handful of readings it says
`measuring` rather than guessing.

Three views, one view model: the webview, **Show Usage (Quick Pick)** and
**Show Usage as Text (Markdown)** cannot drift apart.
