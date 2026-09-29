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
| `language` | `auto` | The language of Token Pace's own texts — the status bar and its tooltips, the dashboard, the Quick Pick, the markdown document, alerts, notifications and dialogs (1.9): `auto` follows VS Code's display language — which VS Code reports only while its language pack is installed; a regional one such as `de-ch` gets its language, `de`, the way VS Code looks up the settings' own texts, and a language Token Pace has no translation for gets English — or one of `en`, `de`, `fr`, `es`, `pt-br`, `it`, `ja`, `ko`, `zh-cn`, `zh-tw`, `ru`, `tr`, `pl`, `cs`, `nl`, `uk`, `sv`, `nb`, `da`, `fi`, `hi`, `id`, `vi`, `el`, `hu`, `ro`, `ar`, `he`, `fa`. The settings UI offers the thirty values as a list, each language by its own name (*Deutsch*, *日本語*); in Arabic, Hebrew and Persian the dashboard is mirrored and reads from the right ([Right to left](languages.md#right-to-left)). A switch applies at once, without a reload. The flag at the top of the dashboard sets it too, and that is the one write Token Pace makes to your user settings for it: only on a choice, only this key, *Automatic* removing the key again, the language already chosen writing nothing; if VS Code cannot write your `settings.json`, the warning *Token Pace: the language could not be written to your user settings.* says so and nothing changes. The settings, the command titles and the walkthrough always follow VS Code's display language (*Configure Display Language*): VS Code reads them when it starts. The debug log, the diagnostics report and the CSV and JSON exports stay English. A value that is none of these (another case, a path) counts as `auto`, and the log says so. The twenty-seven languages beyond English and German were translated by AI agents and checked by tests, not by native speakers. Application scope: always your user settings, never a workspace's — a cloned repository's `.vscode/settings.json` cannot switch your language. See [Languages](languages.md) |
| `statusBar.show` | `["claudeQuota","codexQuota","tokens"]` | Which entries the status bar shows **and in which order**: `claudeQuota`, `codexQuota`, `extra`, `context`, `tokens`, `cost`, `forecast`, `budget`, `agents`, `cache`. Empty hides the bar. `cost` needs `showCost`, `forecast` needs `quotaHistoryDays` above 0, `context` needs the connected status line, `budget` needs `budgets`, `agents` shows only while a Claude Code agent runs, `cache` only in the last five minutes of a Claude Code session's one-hour [prompt cache](prompt-cache.md) (`$(watch) cache 4m`; `~4m` when estimated from the transcript) |
| `windowSelect` | `worstPace` | Which quota windows appear: `worstPace` (one entry per tool — the window that needs attention), `all`, `leading`, `session`, `weekly`, `auto` |
| `density` | `full` | `full`, `compact` (one item per provider), `minimal` (one item in total) |
| `clickAction` | `dashboard` | What a click does: `dashboard`, `menu`, `refresh`, `openWebsite`. A problem state always performs its repair instead |
| `usagePageLinks` | `true` | Make the tooltip title a link to the provider's official usage page and offer it in the menu. The extension never contacts those pages itself |
| `alignment` | `left` | `left` or `right`. Right-aligned entries are hidden without notice when the window is narrow |
| `staleAfterMinutes` | `20` | Age (1–1440) from which a reading counts as stale: greyed out, marked, and barred from raising alerts. A stale entry whose reading a transient failure of our own fetch followed adds the next attempt, `· $(clock) retry 1h12m` |
| `timezone` | `system` | `system`, `utc`, or an IANA name. Governs the status bar summary as well as the dashboard. Display only — nothing is re-counted; an unusable value falls back |
| `dayBoundaryHour` | `0` | The hour a “day” starts (0–23), for the status bar summary as well as the dashboard. `4` books work after midnight onto the previous day |
| `planName` | `{}` | Plan name shown beside the provider title, e.g. `{"claude": "Max 20x"}` (40 characters max). Display only — never a limit; a name a provider states itself wins, and yours prints as `plan Max 20x (as configured)`. Backticks, control characters and line breaks are stripped and runs of spaces collapse before the 40-character cut, so a plan name cannot end the code span it sits in or forge a row of the tooltip |
| `keybindings` | `true` | Bind `ctrl+alt+shift+t` (`cmd+alt+shift+t`) to *Open Dashboard*. Off frees the chord without a `-` rule in `keybindings.json`; the Command Palette is unaffected |
| `cacheKeepWarm` | `false` | **Opt-in, with its own consent** (1.8): keep a Claude Code session's one-hour [prompt cache](prompt-cache.md#keep-warm-in-a-terminal-opt-in) warm by typing one fixed line — `Ignore this message. No action. No response.` — into the VS Code terminal that runs it and pressing Enter. When the status line reports three minutes or less left, a one-minute countdown you can cancel runs in the status bar (`$(watch) keep warm in 42 s · cancel`, shown whatever `statusBar.show` lists), and the line goes about two minutes before the cache expires — at most three times in a row, never while a Claude quota window stands at 90 % or more, only when every check of the prompt-cache page holds. Switching it on asks for consent; switching it off withdraws it and ends a countdown under way. Every line is a real request that counts against your usage, text you typed but did not send is sent with it, and it is automation that Anthropic's terms do not explicitly permit. Sessions in the Claude Code extension's own panel are out of reach. Application scope: a workspace's `.vscode/settings.json` cannot switch it on |
| `windows` | `all` | **Deprecated** — replaced by `windowSelect`. Still honoured while `windowSelect` is at its default `worstPace` |

## Pace

| Setting | Default | Meaning |
|---|---|---|
| `pace.sensitivity` | `normal` | `relaxed`, `normal`, `strict` or `custom` — how long a window counts as just reset, see the preset table in [Pace, not level](numbers.md#pace-not-level) |
| `pace.tolerancePoints` | `0` | Band in percentage points a window may run ahead of its clock before it is coloured (whole numbers, 0–20); applies with every sensitivity. The verdict rounds the band the way the card rounds its figure, so `2.5` is a band of 3, not half a point more grace than 2 |
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
| `dashboard.sections` | `quota, agents, tokens, summary, kpis, chart, models, heatmap, hours, dataQuality` | Which sections the panel shows **and in which order**. Also available: `context`, `records`, `tools`, `budget`, `history`, `projects`, `sessions`, `prompts`. A list you have set yourself is kept as it is, so `agents` (new in 1.6) appears there only once you add it. `prompts` (new in 1.10) is your own list of prompts for Claude Code's and Codex's terminals — add it where you want it, first for the quickest reach ([Prompts](prompts.md)). While the dashboard's provider switch shows Codex, `agents` and `context` are left out |
| `dashboard.defaultRange` | `30d` | The range the dashboard opens with |
| `dashboard.modelRows` | `12` | Rows in the model table before the rest is folded into “… n more” (0–500); `0` shows every model |
| `dashboard.topN` | `5` | Rows per table in the `records` and `tools` sections (1–20) — the top models, projects, sessions and tools, and since 1.11 the most expensive days, the longest and largest sessions and the hours with the most cache written. A cap on what is listed, never on what is counted |
| `dashboard.mode` | `webview` | What *Open Dashboard* and a status bar click open: `webview`, `quickPick`, `markdown` |
| `chart.modelStyle` | `pattern` | How the bands of one provider are told apart in the daily chart: `pattern` (solid, stripes, cross-hatch, lines, dots in the provider hue), `shade` (lightness steps of the hue) or `both`. With the chart's `subagents` chip pressed, a provider's main sessions take the style's first rank and its subagents the second |
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
| `userAgent` | `claudeCode` | `claudeCode` (`claude-code/<version>`: what `claude --version` prints — on Windows only from a `claude.exe` on the `PATH` —, else the version the newest Claude Code session wrote into its transcript, else a fixed one) or `honest`. **`honest` gets rate-limited into a permanent 429.** Machine-scoped |
| `codexAppServer.mode` | `persistent` | `persistent` (one long-running `codex app-server` per editor, kept by the fetching window: every fetch asks it over the same connection, and its rate-limit pushes are taken as they arrive — [The Codex app-server](quota-sources.md#the-codex-app-server)) or `oneShot` (a child per fetch, ended once it answered). Machine-scoped, so a workspace cannot override your choice |
| `credentials.keychain` | `true` | On macOS look for the token in the Keychain item Claude Code keeps it in — before `~/.claude/.credentials.json`, only after you allowed the Keychain too, and in a VS Code window first only when you fetch by hand; on Linux after that file, with `secret-tool` ([Credentials](quota-sources.md#what-the-fetch-does)). Machine-scoped |
| `pollOnlyWhenFocused` | `true` | Skip scheduled fetches after ten minutes in the background — the attempt then reads `waiting for focus`. A manual fetch always runs |
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
| `alerts.thresholds` | `[90]` | Percentages (1–100) at which an alert is shown. **An empty list means no alerts at all** |
| `alerts.basis` | `used` | Whether the thresholds mean used or remaining |
| `alerts.requireAhead` | `true` | Only alert when the window is also ahead of pace |
| `alerts.minRemainingMinutes` | `60` | Do not alert when the window resets within this many minutes (0–10080) |
| `alerts.useItLoseIt` | `false` | Also show an alert about capacity about to expire unused |
| `alerts.forecastLeadMinutes` | `0` | Show an alert when the forecast expects exhaustion within *n* minutes (0–1440); `0` = off |
| `alerts.onPaceFast` | `false` | Show an alert once per cycle when a window goes from on pace to ahead of pace |
| `alerts.windowCondition` | `any` | Which windows may alert: `any`, `sessionOnly`, `weeklyOnly` |
| `alerts.budgetPercent` | `0` | Show an alert once per period when a `budgets` entry passes this share of its own limit (0–200); `0` = off |

## Notifications (phone, chat, e-mail)

Messages Token Pace sends outside VS Code (1.12) — not the alerts above, which are VS Code popups. All eight
settings are machine-scoped: a workspace sets none of them, and Settings Sync does not carry them. None of them holds
a secret: a webhook's address, a bot's token, an ntfy topic and a password are kept in VS Code's secret storage.

The Settings editor shows both categories, *Alerts* and *Notifications (phone, chat, e-mail)*, in VS Code's display
language. In German („Warnhinweise“, before „Benachrichtigungen“) and in ten of the twenty-four other languages the
Alerts category has a new name since 1.12, because its old name is now the notifications' word — look for the new one
in the category list. The rows' titles, such as *Notifications: Channels*, are made by VS Code from the keys and stay
English in every language.

| Setting | Default | Meaning |
|---|---|---|
| `notifications.channels` | `[]` | The channels a notification may go to: `webhook`, `telegram`, `ntfy`, `email`. **Empty means nothing is ever sent.** A channel works once *Set Up a Notification Channel…* kept its address and secret in VS Code's secret storage and you allowed its host |
| `notifications.events` | `[agentWaiting, agentDone, quotaThreshold, quotaExhausted, paceWarning]` | What a notification is sent about; `quotaReset` is the sixth event, off by default. `agentWaiting` needs the agent hook; `agentWaiting` and `agentDone` are Claude Code's and are sent only while the window is not focused |
| `notifications.thresholds` | `{ session: 80, weekly: 80 }` | The percentage used at which `quotaThreshold` fires, per kind of window (0–100, `0` = off for that kind) — once per window and cycle, only upwards, never from a stale reading |
| `notifications.cooldownMinutes` | `10` | The least time between two notifications of one kind of event (1–1440); one that comes sooner is dropped, not saved for later. At most 20 notifications an hour in all |
| `notifications.webhook` | `{ format: generic, secretHeader: "" }` | `format`: `generic` (Token Pace's JSON), `slack`, `discord`, `teams`, `mattermost` or `rocketChat`; `secretHeader`: the name of a header that carries a secret, if your address expects one |
| `notifications.telegram` | `{ chatId: "" }` | The chat your bot sends to — a number, or `@name` for a public Telegram channel |
| `notifications.ntfy` | `{ server: "" }` | The `https://` address of your ntfy server itself — `https://ntfy.sh` for the public one, or your own — never a topic's address (ntfy takes the JSON publish only at its root); there is no default |
| `notifications.email` | `{ host: "", port: 587, security: starttls, user: "", from: "", to: "" }` | Your SMTP server and one recipient: `security` `starttls` (usually port 587) or `tls` (usually port 465). Nothing is sent without encryption |

## Diagnostics

| Setting | Default | Meaning |
|---|---|---|
| `debug` | `false` | Verbose logging in the *Token Pace* output channel. Never logs a token, a transcript line or a response body |
| `debugLogFile` | `""` | Additionally write the log to this file. It will contain full paths — prefer *Copy Diagnostics* for an issue |
| `diagnostics.includeNetworkSetup` | `true` | Include the effective `http.proxy` settings and the proxy environment variables in *Copy Diagnostics* |
