<!--
SPDX-FileCopyrightText: 2026 Frederik Marx
SPDX-License-Identifier: AGPL-3.0-or-later
-->

# Dashboard

Part of the [Token Pace documentation](../README.md#documentation).

*Token Pace: Open Dashboard* (`ctrl+alt+shift+t`, `cmd+alt+shift+t` on macOS, unless
`tokenPace.keybindings` is off) opens the panel in the secondary sidebar. It needs
**VS Code 1.106 or newer**, for the reason given in the [README](../README.md).
`tokenPace.dashboard.sections` is an ordered array — the array order is the render order. Every section is set off from the one above it by a rule and a fixed gap, whether it is folded or not, and its header carries a gear that opens the settings behind that section. The range, provider and model chips filter the statistics — not the quota cards, and not the `tokens` section, whose periods are fixed — so the filter bar sits below every `quota`, `context` and `tokens` section that leads the list and above the first section the filter applies to; a filter-free section listed after a filtered one simply stays below the bar:

| Section | Contents |
|---|---|
| `quota` | One card per provider: the plan name and the reading's age in the header, then per window one header row (label, reset, pace verdict, percentage) over a bar with the elapsed tick, the pace gap painted on either side of it and a second tick for the projected value at the reset, the forecast line, a seven-day sparkline coloured by pace, and extra usage. Every window explains its colour: hovering it, or reaching it with the keyboard, opens why the bar is green, yellow, amber or red — the used and the elapsed share with the gap between them, the rule that turns it yellow (as soon as the reading is ahead of pace, or past your tolerance band), the measuring phase with the time it ends, an exhausted window with its reset, a missing clock, a stale reading; the words are the view model's, so the markdown view prints one such line per window under its table and the Quick Pick carries the first two as the item detail. With the status line connected the Claude card ends with the prompt-cache line — warm or cold, the expiry countdown and TTL, the hit ratio — with a `–` for every part the payload did not carry, and never an estimate of any of it. The full freshness row (last check · last data · last local event · next refresh · snapshot age) and the official page stay in the markdown view; the tooltip keeps the reading's age and links the official page from the provider name. A provider that reports no window at all gets one local five-hour estimate instead, labelled as one |
| `summary` | Three to five rule-based sentences, each with its figure and the basis it came from. No advice — only measurements |
| `context` | The context window of the current Claude Code session as the status line reported it — tokens, and a share only when the payload named a window size. Off by default; nothing here is derived from the token counts |
| `kpis` | Today (usage, and its cost while `showCost` is on), then usage, API equivalent, requests, cache hit, active days, Avg per active day — each with a delta against the previous period and a sparkline. Hovering a card, or reaching it with the keyboard, opens what it counts, how it is computed, the period with its dates, what it is compared with, the split per provider and its basis; the markdown view lists the same explanations under the table |
| `tokens` | Fixed periods of everything — every provider and model, whatever the chips say. Totals table (usage, fresh input, cache write 5 m / 1 h, cache read, output, reasoning, requests, hit rate, per request, API cost) with the rows `Today`, `Last 7 days`, `Last 30 days`, `This week`, `This month`, `All time`. Two rows lead them: `Current 5 h window` and `Current 7 d window` cover exactly the window the provider reports a reset for, so they can be read against the quota card above — where no such window is reported the row is a trailing `Last 5 h` / `Last 7 d` span and says so. Both are summed from hour buckets, so once the oldest hours of the span have been rolled up into day totals every figure in the row carries `≈` and is a lower bound; the span itself is the tooltip of the row label. Then the composition bar over the last 30 days with a `cache` switch that hides cache read and cache write (the remaining shares are then shares of what is drawn, and a caption names the tokens left out), the cache economy of the same 30 days, calendar periods and the plan factor |
| `chart` | Stacked daily (or weekly) bars for the selected range, one band per model in its provider's hue — the models of one provider told apart by pattern or shade (`chart.modelStyle`) — with a metric selector and an optional cost line on a second axis through the column centres. Clicking a column drills into that day |
| `models` | Per-model breakdown with the same columns as the totals table (usage, fresh input, cache write 5 m / 1 h, cache read, output, reasoning, requests, hit rate, per request, API cost) plus the share of the range; every column sortable, with average and P90 turn length where enough samples exist. Where the rates came from is the tooltip of the cost, not a column |
| `heatmap` | Calendar heatmap of the last 53 weeks with current and longest streak, active days, peak day and a variability measure. Days outside the coverage are dotted, not empty |
| `hours` | Hour-of-day profile and a weekday × 4-hour grid, captioned with the weeks of usage days it stands on. A block nothing was ever done in is hatched |
| `records` | Records of the selected range: peak day, longest run of days with usage, and the top models, projects and sessions (`dashboard.topN` rows each). Off by default; the two lower tables need `tokenPace.attribution` |
| `tools` | Tool calls of the selected range by name, with the share of the calls counted in it and the models that made them (`dashboard.topN` rows). Off by default; names only, never a tool's input or its result, and the section states the day counting started |
| `budget` | Your own limits from `tokenPace.budgets`: used, limit, share against **that** number, and the end-of-period projection. Off by default; a period with no local data shows a dash, and no budget is ever added to another |
| `history` | Reset retrospective: how often the window was exhausted, how much was left over |
| `projects` | Per-project breakdown — needs `tokenPace.attribution` |
| `sessions` | Per-session breakdown — needs `tokenPace.attribution: session` |
| `dataQuality` | Roots, file counts, coverage, bucket counts, retention, quota history size, every source with its age or its failure, drift, calibration, bridge state, consent, role — plus buttons for the export and diagnostics commands |

Defaults omit `context`, `records`, `tools`, `budget`, `history`, `projects` and `sessions`; `projects` and `sessions` stay
empty until attribution is switched on and say so instead of showing an empty table, and
`context` says how a reading could be had instead of inventing one.

**The filter bar.** One labelled block with a row each for **Range**, **Providers** and
**Models**: the labels share a column, so the chips of all three rows start at the same place
instead of running on as one paragraph of buttons. The range in words (`Last 30 days ·
2026-08-06 → 2026-09-05`) ends the range row, and the refresh button sits at its right end as
an icon.

**Ranges.** Chips for `today`, `7d` and `30d` are on the bar; `yesterday`, `90d`, `thisWeek`,
`thisMonth`, `lastMonth`, `year` and `all` are one `more ▾` chip away (`fewer ▴` puts them
back, and a range you have selected stays visible whatever the fold says). Two date fields
give a custom range (capped at five years, and a reversed range is swapped rather than
returned empty); they stay hidden until you open them with the `custom…` chip, or until the
range actually is a custom one, so the common case is chips only. `dashboard.defaultRange` is
the starting point; the range you pick is remembered for the session. `all` starts at the
first day actually ingested, never earlier.

**Filters and sorting.** Provider toggles, up to twelve model chips — above four the row is
one `models (N) ▾` chip until you open it, because a long chip row pushes the figures off the
panel, and a model you are filtering on stays on the bar either way — and a
model table sortable by every column it shows (`model`, `usage`, `freshInput`, `cacheWrite5m`,
`cacheWrite1h`, `cacheRead`, `output`, `reasoning`, `requests`, `cacheHit`, `perRequest`, `cost`,
`share`, ascending or descending).
Chart metrics: `usage`, `output`, `cacheRead`, `requests`, `reasoning`, `cost`. The chart is
always stacked **by model**, one band per model under each provider: every band wears its
provider's hue — Claude blue, Codex purple — and the five largest models of a provider are told
apart by rank, drawn as a pattern (solid, 45° stripes, 135° stripes, cross-hatch, horizontal
lines), as a shade of the hue, or as both (`tokenPace.chart.modelStyle`); the rest of that
provider's models is folded into one `other` band — dotted under `pattern` and `both`, the
faintest shade under `shade` — so the column total is the same however many models there are. The legend is grouped by provider and its swatches carry the
band's own fill; a band's tooltip names the model, the provider, the value, its share of the
column and the provider's column total. The cost line, when switched on, runs through the
column centres over a halo in the page background, with a dot per column, on its own axis.
The heatmap switches between `usage` and `cost`; the hour profile between local time and UTC.

**Collapsing.** Every section header is a toggle. What you collapse is remembered with the rest
of the view state (range, sort, filters), so a panel you have trimmed to two sections opens that
way again. `tokenPace.dashboard.sections` decides what exists at all; collapsing decides what
you look at today.

**The gear in a section header.** Opens the settings editor filtered to the settings that
section is made of — the quota gear to the quota sources, the poll interval and the pace
settings, the models gear to the row cap and the price table, and so on; every list ends with
`tokenPace.dashboard.sections`. It never toggles the fold, with the mouse or with the
keyboard, and it changes nothing on its own: it opens the settings you would otherwise have
to find among all of them.

**Peak hours.** No fixed peak windows are built in. The profile is drawn from your own hour
buckets and nothing else, and rolled-up days that no longer have an hour are named as excluded
instead of being folded into the picture. The weekday × 4-hour grid draws every block a day of
usage reached, however few days there are, and hatches the blocks no day reached — “hatched: no
usage in that block”, said under the grid rather than left to be guessed. How thin the evidence
is, is the caption: the days that carry usage, rounded up to whole weeks, as *based on 1 week — a
record, not a habit* below three weeks and *based on 4 weeks* from three weeks on. The weeks are
counted from your usage days, not from the length of the range: four working days inside a month
are four days of evidence, not four weeks of them.

**Forecast states.** Every answer is a named state, never a bare number: `none` (nothing
measured), `full` (already exhausted), `stale` (the newest reading is too old to extrapolate),
`measuring` (too few readings, too short a span, or too little of the window elapsed), `idle`
(flat or falling), `resetsFirst` (`~ends at 62 % when it resets`) and `eta`
(`~empty in 3.2 h (15:42) · medium confidence`). Confidence is `low`, `medium` or `high` from
the number of readings and the span they cover, and the basis is spelled out — “based on 9
readings over 2.4 h”. A forecast that would land after the reset is never emitted. The fit uses
only the current cycle, and restarts at a limit re-basing, so neither a reset nor a raised
limit bends the slope.

**Reset retrospective.** Over completed cycles: how often the window hit the limit, and the
average share of the window left unused at the reset. Below three complete cycles it says
`not enough data yet` and names how many it has. Incomplete cycles stay visible as incomplete
rather than being counted — VS Code is not running all day, and a cycle seen through three
readings would understate its peak.

**Cache economy.** A counterfactual, and labelled as one: what the cache reads would have cost
at the input rate, minus what the writes cost (Codex bills no cache write). Plus the hit rate
and a blended $/1M.

**Previous-period deltas.** Every KPI carries a change against the immediately preceding span
of equal length. Growth from nothing reads `new`, not an infinite rise; a change below half a
point gets a neutral dot rather than an arrow that flips on noise. `all` has no predecessor and
gets no delta.

The colour of a delta comes from what the change **means**, never from its sign: more usage,
more cost and more requests are marked as the bad direction, a higher cache hit rate as the good
one, and active days and the per-day average carry no judgement at all and stay neutral. A green
arrow therefore never has to be read twice.

**Calendar periods and the month projection.** This week, this month, last month and this year,
each with usage, cost, requests, active days and Avg/day. The month projection extrapolates the
cost per *elapsed* day over the days left and shows its derivation
(`so far $41.20 · Avg $2.06/day · 11 days left`). Below five active days it stays silent.

**Plan factor.** With `tokenPace.planPriceUsd` set (`{"claude": 100, "codex": 20}`), one line
says how many times over the hypothetical API cost exceeds what you pay. Leave it empty and the
line is simply absent — Token Pace never guesses a plan price.

**Calibration.** `tokenPace.calibration.show` adds how many local usage tokens correspond to one
percentage point of a quota window, derived from your own history as a band (median, minimum,
maximum). It is an observation about your data, not a published conversion, and it is never
applied as a multiplier to anything. Off by default because it invites over-interpretation.

**Other views.** `tokenPace.dashboard.mode` switches *Open Dashboard* and the status bar click
between `webview`, `quickPick` and `markdown`. **Show Usage (Quick Pick)** is a flat, searchable
list; **Show Usage as Text** opens a read-only markdown document. All three read the same view
model, so the numbers cannot drift apart, and a test counts the rows of one against the other.

**Language.** With VS Code's display language set to German — the *German Language Pack*, or
`--locale=de` — the extension is German: the status bar and its tooltip, the dashboard, the
Quick Pick, the markdown report, the settings descriptions and every dialog, with dates and
numbers formatted for that language (`2,8M`, `1.234.567`). English is the source text, so an
untranslated string falls back to English rather than going blank, and every other display
language gets English. Three things stay English on purpose, because they are pasted into
issues and have to be readable by a maintainer: the debug log, the diagnostics report, and the
CSV and JSON exports.

**Accessibility.** Bars are `role="progressbar"` with `aria-valuenow` and a spoken
`aria-valuetext`; sortable headers carry `aria-sort`; toggles carry `aria-pressed`; chart
columns are focusable buttons. The webview loads no external resource of any kind — its CSP
allows exactly one nonced inline style and script, and the chart, heatmap and sparklines are
CSS and inline SVG. Everything the webview sends back goes through an allow-list that accepts a
range, a sort, a filter, a metric, a drill day, a section toggle, or one of a fixed list of named
commands — never a path and never a setting. Where a webview is unavailable or unwanted, the QuickPick and markdown views
carry the same figures.
