<!--
SPDX-FileCopyrightText: 2026 Frederik Marx
SPDX-License-Identifier: AGPL-3.0-or-later
-->

# Settings

Part of the [Token Pace documentation](../README.md#documentation).

Every key is `tokenPace.*`. Grouped and ordered exactly as they appear in the settings UI; the
power-user settings sit at the end of their group.

## General

| Setting | Default | Meaning |
|---|---|---|
| `statusBar.show` | `["claudeQuota","codexQuota","tokens"]` | Which entries the status bar shows **and in which order**: `claudeQuota`, `codexQuota`, `extra`, `context`, `tokens`, `cost`, `forecast`, `budget`. Empty hides the bar. `cost` needs `showCost`, `forecast` needs `quotaHistoryDays` above 0, `context` needs the connected status line, `budget` needs `budgets` |
| `windowSelect` | `worstPace` | Which quota windows appear: `worstPace` (one entry per tool — the window that needs attention), `all`, `leading`, `session`, `weekly`, `auto` |
| `density` | `full` | `full`, `compact` (one item per provider), `minimal` (one item in total) |
| `clickAction` | `dashboard` | What a click does: `dashboard`, `menu`, `refresh`, `openWebsite`. A problem state always performs its repair instead |
| `usagePageLinks` | `true` | Make the tooltip title a link to the provider's official usage page and offer it in the menu. The extension never contacts those pages itself |
| `alignment` | `left` | `left` or `right`. Right-aligned entries are hidden without notice when the window is narrow |
| `staleAfterMinutes` | `20` | Age (1–1440) from which a reading counts as stale: greyed out, marked, and barred from raising alerts |
| `timezone` | `system` | `system`, `utc`, or an IANA name. Governs the status bar summary as well as the dashboard. Display only — nothing is re-counted; an unusable value falls back |
| `dayBoundaryHour` | `0` | The hour a “day” starts (0–23), for the status bar summary as well as the dashboard. `4` books work after midnight onto the previous day |
| `planName` | `{}` | Plan name shown beside the provider title, e.g. `{"claude": "Max 20x"}` (40 characters max). Display only — never a limit; a name a provider states itself wins, and yours prints as `plan Max 20x (as configured)`. Backticks, control characters and line breaks are stripped and runs of spaces collapse before the 40-character cut, so a plan name cannot end the code span it sits in or forge a row of the tooltip |
| `keybindings` | `true` | Bind `ctrl+alt+shift+t` (`cmd+alt+shift+t`) to *Open Dashboard*. Off frees the chord without a `-` rule in `keybindings.json`; the Command Palette is unaffected |
| `windows` | `all` | **Deprecated** — replaced by `windowSelect`. Still honoured while `windowSelect` is at its default `worstPace` |

## Pace

| Setting | Default | Meaning |
|---|---|---|
| `pace.sensitivity` | `normal` | `relaxed`, `normal`, `strict` or `custom` — how long a window counts as just reset, see the preset table in [Pace, not level](numbers.md#pace-not-level) |
| `pace.tolerancePoints` | `0` | Band in percentage points a window may run ahead of its clock before it is coloured (0–20); applies with every sensitivity |
| `pace.minElapsedPercent` | `3` | Only with `sensitivity: custom`. How much of a window must have elapsed before a small reading is judged (0–20) |
| `pace.levels` | `binary` | `binary` or `graded` (a second warning level from 15 % ahead — three times the band, at least 15) |

## Status bar

| Setting | Default | Meaning |
|---|---|---|
| `barWidth` | `8` | Bar width in characters (0–20); `0` hides the bar. The time marker needs at least 6 |
| `barStyle` | `line` | Only bites for `barGlyphs: blocks`. How the **empty** part is drawn: `line`, `shade`, `none` |
| `barGlyphs` | `blocks` | Glyph set: `blocks`, `shapes`, `dots`, `pie` — which looks right depends on your status bar font |
| `timeProgressStyle` | `marker` | How elapsed time is shown: `marker`, `bar`, `none` |
| `indicator` | `both` | How the verdict is signalled: `color`, `glyph`, `both`, `none` |
| `colorMode` | `theme` | `theme` or `monochrome`. The four colours are overridable in `workbench.colorCustomizations` |
| `percentMode` | `used` | Whether the number is what you used or what is left (`used` / `remaining`) |
| `resetFormat` | `relative` | Countdown suffix: `none`, `relative`, `absolute`, `both`. Always introduced by the word `resets` |
| `showAgeInItem` | `whenStale` | Show the reading's age in the entry: `never`, `whenStale`, `always` |
| `labels` | `{}` | Custom prefixes (`claude`, `codex`, `summary`) and window labels by id. Values over 40 characters are cut |
| `summary.period` | `today` | Which period the token and cost entries sum up: `today`, `7d`, `30d`. The period is always printed next to the figure |
| `summary.scope` | `both` | Which tools they sum up: `both`, `claude`, `codex` |
| `tooltip` | `full` | `full`, `compact`, `off` |
| `tooltipExplanations` | `false` | Show the explanatory paragraphs. Uncertainty markers and provenance are never hidden by it |
| `overflowDisplay` | `actual` | Above 100 %: show it (`actual`) or cap it (`clamp`) |
| `resetHourCycle` | `auto` | Clock format for absolute times: `auto`, `h12`, `h23` |
| `labelMaxChars` | `0` | Truncate labels *we* generate to this many characters (0–40); `0` = no truncation |

## Dashboard

| Setting | Default | Meaning |
|---|---|---|
| `dashboard.sections` | `quota, tokens, summary, kpis, chart, models, heatmap, hours, dataQuality` | Which sections the panel shows **and in which order**. Also available: `context`, `records`, `tools`, `budget`, `history`, `projects`, `sessions` |
| `dashboard.defaultRange` | `30d` | The range the dashboard opens with |
| `dashboard.modelRows` | `12` | Rows in the model table before the rest is folded into “… n more” (0–500); `0` shows every model |
| `dashboard.topN` | `5` | Rows per table in the `records` and `tools` sections (1–20). A cap on what is listed, never on what is counted |
| `dashboard.mode` | `webview` | What *Open Dashboard* and a status bar click open: `webview`, `quickPick`, `markdown` |
| `chart.modelStyle` | `pattern` | How the bands of one provider are told apart in the daily chart: `pattern` (solid, stripes, cross-hatch, lines, dots in the provider hue), `shade` (lightness steps of the hue) or `both` |
| `startOfWeek` | `monday` | First day of the week for the heatmap, the weekday grid and `thisWeek` |
| `planPriceUsd` | `{}` | What you pay per month, per tool, e.g. `{"claude": 100}`. Used only for the plan-factor line |
| `calibration.show` | `false` | Show local tokens per quota percentage point, derived from your own history |

## Cost

| Setting | Default | Meaning |
|---|---|---|
| `showCost` | `true` | Show the hypothetical API cost column. With it off, the `cost` entry of `statusBar.show` is not created either |
| `customPrices` | `{}` | Per-model rates in USD per 1M tokens, merged field-wise over the built-in table |
| `pricing.multiplier` | `1` | Factor on every list price (0.01–10) for contract discounts |
| `unknownModelPricing` | `strict` | `strict` (report a lower bound) or `family` (borrow a related model's price and say so) |
| `budgets` | `[]` | Your own limits: `{scope, period, unit, limit, label?}`. **`usd` is the hypothetical API equivalent, not a bill.** Unusable entries are dropped whole; at most 20 |
| `pricing.showListPrice` | `false` | Show the undiscounted list price as a second column |

## Quota sources

| Setting | Default | Meaning |
|---|---|---|
| `quotaSource` | `auto` | `auto` (local sources only, offers once), `poll` (fetch, after consent), `cache` (local only, never asks). Machine-scoped, so a workspace cannot switch fetching on |
| `pollIntervalMinutes` | `30` | Interval between our own fetches (5–1440). The consent dialog names the value you set |
| `claudeQuotaSources` | `["cacheFile","statusline","claudeJson","poll"]` | Which Claude sources may be used; the order breaks ties, the freshest wins |
| `codexQuotaSources` | `["cacheFile","transcript","poll"]` | Which Codex sources may be used |
| `claudeQuotaFile` | `""` | JSON file with the Claude quota state; empty = `~/.cache/claude-usage/state.json` |
| `codexQuotaFile` | `""` | The same for Codex; empty = `~/.cache/codex-usage/state.json` |
| `writeQuotaCache` | `false` | Write our own fetches back to the cache file. **Opt-in, with its own consent dialog**; machine-scoped |
| `codexBinary` | `""` | Path to `codex`; empty = `CODEX_CLI_PATH`, then `PATH`, then the bundled IDE binary. Machine-scoped on purpose |
| `userAgent` | `claudeCode` | `claudeCode` or `honest`. **`honest` gets rate-limited into a permanent 429.** Machine-scoped |
| `codexAppServer.mode` | `oneShot` | `oneShot` (spawn per poll) or `persistent` (one long-lived child, with pushes) |
| `credentials.keychain` | `true` | Also look in the OS keychain when the credentials file has no token. Machine-scoped |
| `pollOnlyWhenFocused` | `true` | Skip scheduled fetches after ten minutes in the background. A manual fetch always runs |
| `leaderElection` | `true` | With several windows open, let one do the fetching and have the others follow its files |

## Paths

| Setting | Default | Meaning |
|---|---|---|
| `claudeDir` | `""` | Claude Code's directory, or an array of several; empty = `~/.claude` or `CLAUDE_CONFIG_DIR`. Needs a **Reload Window** |
| `codexDir` | `""` | The same for Codex; empty = `~/.codex` or `CODEX_HOME` |

## Data and privacy

| Setting | Default | Meaning |
|---|---|---|
| `hourRetentionDays` | `45` | How long hour buckets are kept (1–3650) before they are folded into days. Irreversible |
| `retentionDays` | `400` | How long day buckets are kept (60–36500) before they are folded into months |
| `quotaHistoryDays` | `30` | How long quota readings are kept as a time series (0–90). `0` empties the `forecast` entry of `statusBar.show` and the `history` section of the dashboard, and leaves the quota cards without a sparkline or a forecast line |
| `attribution` | `none` | `none`, `project` or `session`. Changing it triggers a full re-scan |
| `showProjectNames` | `basename` | `basename` or `hash` (salted, screen-share safe) |

## Alerts

| Setting | Default | Meaning |
|---|---|---|
| `alerts.thresholds` | `[90]` | Percentages (1–100) at which a notification is shown. **An empty list means no notifications at all** |
| `alerts.basis` | `used` | Whether the thresholds mean used or remaining |
| `alerts.requireAhead` | `true` | Only alert when the window is also ahead of pace |
| `alerts.minRemainingMinutes` | `60` | Do not alert when the window resets within this many minutes (0–10080) |
| `alerts.useItLoseIt` | `false` | Also notify about capacity about to expire unused |
| `alerts.forecastLeadMinutes` | `0` | Notify when the forecast expects exhaustion within *n* minutes (0–1440); `0` = off |
| `alerts.onPaceFast` | `false` | Notify once per cycle when a window goes from on pace to ahead of pace |
| `alerts.windowCondition` | `any` | Which windows may alert: `any`, `sessionOnly`, `weeklyOnly` |
| `alerts.budgetPercent` | `0` | Notify once per period when a `budgets` entry passes this share of its own limit (0–200); `0` = off |

## Diagnostics

| Setting | Default | Meaning |
|---|---|---|
| `debug` | `false` | Verbose logging in the *Token Pace* output channel. Never logs a token, a transcript line or a response body |
| `debugLogFile` | `""` | Additionally write the log to this file. It will contain full paths — prefer *Copy Diagnostics* for an issue |
| `diagnostics.includeNetworkSetup` | `true` | Include the effective `http.proxy` settings and the proxy environment variables in *Copy Diagnostics* |
