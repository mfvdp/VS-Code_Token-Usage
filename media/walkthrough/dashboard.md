<!--
SPDX-FileCopyrightText: 2026 Frederik Marx
SPDX-License-Identifier: AGPL-3.0-or-later
-->

### What the panel holds

| Section | Contents |
|---|---|
| summary | Rule-based sentences, each with its figure and its basis |
| quota | One card per provider: bar, elapsed tick, verdict, reset, forecast, sustainable rate, sparkline, freshness |
| KPIs | Today, usage, API equivalent, requests, cache hit, active days, avg per active day — each against the previous period |
| tokens · chart · models | Totals, daily bars, per-model breakdown with price provenance |
| heatmap · hours | 53 weeks of activity, hour-of-day profile, weekday grid |
| forecast · history | Burn rate, exhaustion estimate, reset retrospective |
| data quality | Every source with its age or its failure, coverage, retention, consent, role |

Every estimate carries `~` and states what it is based on. A forecast that would
land after the reset is never emitted; below a handful of readings it says
`measuring` rather than guessing.

Three views, one view model: the webview, **Show Usage (Quick Pick)** and
**Show Usage as Text (Markdown)** cannot drift apart.
