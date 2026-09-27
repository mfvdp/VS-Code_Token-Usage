<!--
SPDX-FileCopyrightText: 2026 Frederik Marx
SPDX-License-Identifier: AGPL-3.0-or-later
-->

# Dashboard

Part of the [Token Pace documentation](../README.md#documentation).

*Token Pace: Open Dashboard* (`ctrl+alt+shift+t`, `cmd+alt+shift+t` on macOS, unless
`tokenPace.keybindings` is off) opens the panel in the secondary sidebar. It needs
**VS Code 1.106 or newer**, for the reason given in the [README](../README.md).
`tokenPace.dashboard.sections` is an ordered array — the array order is the render order. Every section is set off from the one above it by a rule and a fixed gap, whether it is folded or not, and its header carries a gear that opens the settings behind that section. The provider switch at the very top of the page — `Claude Code`, `Codex`, `All` — governs every section below it: under one provider the page shows only that provider's quota card, tokens, summary, key figures, chart, models, heatmap, hours, records, tools, projects, sessions, budgets, reset history and data quality, a footnote says so (*Showing Codex only — the provider switch at the top of the dashboard; ‘All’ shows every provider.*), and while Codex is selected the Claude Code–only `agents` and `context` sections are left out; `All` shows every provider, as the page always did, and a change of provider clears the model chips. The markdown view, the Quick Pick and *Copy Usage Summary* follow the switch too (the markdown's range line ends `· Codex only`, the Quick Pick's first line starts with the provider); the status bar, its tooltips, the alerts, the export and the diagnostics report follow no view. The range and model chips filter the statistics — not the quota cards, not the agent tree, which is always the last seven days, not the `tokens` section, whose periods are fixed, and not your prompt list — so the filter bar sits below every `quota`, `agents`, `context`, `tokens` and `prompts` section that leads the list and above the first section the filter applies to; a filter-free section listed after a filtered one simply stays below the bar:

| Section | Contents |
|---|---|
| `quota` | One card per provider the switch shows — under `All` one for each: the plan name and the reading's age in the header; directly under it, in the dim tone, a line when a transient failure of Token Pace's own fetch came after the reading shown (`Last attempt at 14:20 failed: HTTP 429 — backing off before the next attempt · next attempt in 1h12m`; `next attempt due` once that time has passed, `next attempt waiting for focus` while a background window holds it back; a permanent cause adds no line — see [Quota sources](quota-sources.md#what-the-fetch-does)); then per window one header row (label, reset, pace verdict, percentage) over a bar with the elapsed tick, the pace gap painted on either side of it and a second tick for the projected value at the reset, the forecast line, a seven-day sparkline coloured by pace, and extra usage. Every window explains its colour: hovering it, or reaching it with the keyboard, opens why the bar is green, yellow, amber or red — the used and the elapsed share with the gap between them, the rule that turns it yellow (as soon as the reading is ahead of pace, or past your tolerance band), the measuring phase with the time it ends, an exhausted window with its reset, a missing clock, a stale reading; the words are the view model's, so the markdown view prints one such line per window under its table and the Quick Pick carries the first two as the item detail. Under each Claude window's bar a dim line says how much of what this machine counted over that window came from Claude Code's subagents — `Subagents 4.7M of 5.5M counted here (86 %)` — over the same bounds the `Current 5 h window` and `Current 7 d window` rows of the `tokens` section sum, from the hour buckets, the share a whole percent — `<1 %` or `>99 %` where rounding would say none or all. It is a share of **tokens**, never of the quota: the provider's percentage covers every client of the account, the local count only the transcripts on this machine, so the line never moves the window's percentage and nothing is converted into quota points. Once the window reaches below the hour buckets' roll-up both figures carry `≈`. For a model window — `7 d Opus` — both figures count only that window's models: the Claude models of its family, whatever their version (`claude-opus-4-6`, `claude-opus-5`, `claude-3-opus` for Opus); a model window whose family nothing was counted for in its hours has no line. A window whose subagents counted nothing says `0 … (0 %)` — a count, not an absence — as long as an agent ran anywhere in the last seven days; with no agent record and no subagent hour bucket in those seven days no card has the line at all. A window without a reset or a length, one nothing was counted in at all, and every Codex window have no such line either; the markdown view prints it under the window table as `5 h: subagents 4.7M of 5.5M counted here (86 %)`. From five minutes before a Claude Code session's one-hour prompt cache expires, and for an hour after it, the Claude card lists the session after its windows in two dim lines — its state, `Session Tue 14:20 · 9d0eb37a · prompt cache cools in 4 m 10 s (1 h TTL)` (after the expiry `… · prompt cache cold since 14:52 (1 h TTL)`), and under it what a cold start would cost against a cache read: `A cold start after 14:52 re-writes 152.3K tokens at the 1 h write rate (2× input, ~$1.22) instead of reading them from the cache (0.05× input, ~$0.03).` — at most three sessions, the most urgent first, then how many more there are. The figures are measured where the status line describes the session and estimated from its transcript where it does not; an estimate carries `~` on every figure and says *estimated from the transcript* — see [Prompt cache](prompt-cache.md). With the opt-in [keep-warm line](prompt-cache.md#keep-warm-in-a-terminal-opt-in) switched on and allowed, a dim note stands under the session it concerns — `Keep-warm line for this session in 42 s — cancel it in the status bar.` while its countdown runs, `Keep-warm cannot reach this session: it does not run in a VS Code terminal of this window.` for a cooling session the status line measures that no terminal of this window runs, `Keep-warm stopped for this session: the last line got no answer within two minutes.` —, and while today has answered keep-warm lines `Keep-warm requests today: 2 · 64 tokens` closes the block, whatever the setting says now. With the status line connected the card also keeps its own prompt-cache line for the session the status line last wrote about — warm or cold, the expiry countdown and TTL, the hit ratio, with a `–` for every part the payload did not carry: the bridge's words, measured — except while that session is one of the listed ones, which never get two lines. The Codex card ends, for 30 minutes after a turn of GPT-5.6 or later, with `Codex prompt cache · last request at 14:22 · OpenAI keeps a cached prompt prefix at least 30 minutes after its last use for GPT-5.6 and later — ~until 14:52, perhaps longer.` The full freshness row (last check · last data · last local event · next refresh · snapshot age) and the official page stay in the markdown view; the tooltip keeps the reading's age and links the official page from the provider name. A provider that reports no window at all gets one local five-hour estimate instead, labelled as one |
| `agents` | First a list of the agents running now — longest-running first, each with its live clock, its usage and where it sits (session, workflow run, project), a waiting parent marked as waiting and — with the opt-in [agent hook](agents.md#the-agent-hook) — an agent waiting for your approval marked `waiting for approval` — so none has to be looked for in the tree; its first line carries a `Last 7 days` button that opens, under the list, a block of where the agent tokens of the last seven days went — a table by type and model with how many agents, their usage, its share, the median per agent and, while costs are shown, an estimated `~Cost`, then the five largest agents, whose rows open their details like tree rows ([Agents](agents.md#last-7-days)); then the session → workflow → agent tree of the Claude Code sessions of the last seven days, most recent first, closed by default: only the active sessions show, every other session in one closed row after them (`Earlier sessions (12)`, [Agents](agents.md#the-tree)), a session, a run and that row say what their agents came to — `12 started · 3 ✓ · 1 ✕ · 2 ↻ · ~4 ● · ~1 ?`, open or closed — and the nodes you open stay open. Every row is two lines — the name (`Explore · opus-5 · 94f3`; a session or a run by when it started, `Workflow run Tue 00:19 · cfe7718d`), then its figures — and the children of a node come in plain time order, the newest first. Only what is open is sent to the page, and an opened node shows fifty of its children at a time, with a line after them for the next fifty — `50 more · 377 not shown`. Every node with its state (running, done, failed, stopped or unknown; a session active or idle), its usage and its duration — all but the row of earlier sessions, a container with no state and no figures of its own. A done, failed or stopped state is what the parent's own records, the workflow journal or Claude Code's run record say; running, unknown, active and idle are derived from when the transcripts last changed, and are marked as derived. The name of an agent, a launch, a run and a run's collector, and a tally's parts of those states, are in the colour of their state as well — green done, yellow unknown, red failed, blue running —, beside the glyph and the words and never instead of them, and guide lines connect every child to its parent ([Agents](agents.md#the-tree)). Clicking a node — in the tree, in the running list or among the 7-day block's largest agents — opens its details panel right under the row you clicked, and `Escape` closes it; a click on the row of earlier sessions opens or closes that row instead, since it has no details. The section is pushed at most every two seconds while agents run, and its clocks tick in between. Claude Code only — Codex records no agent identity. Nothing of an agent's prompt, description or result is ever read; the whole account is in [Agents](agents.md) |
| `summary` | Three to five rule-based sentences, each with its figure and the basis it came from. No advice — only measurements |
| `context` | The context window of the current Claude Code session as the status line reported it — tokens, and a share only when the payload named a window size. Off by default; nothing here is derived from the token counts |
| `kpis` | Today (usage, and its cost while `showCost` is on), then usage, API equivalent, requests, cache hit, active days, Avg per active day — each with a delta against the previous period and a sparkline. Hovering a card, or reaching it with the keyboard, opens what it counts, how it is computed, the period with its dates, what it is compared with, the split per provider and its basis; the markdown view lists the same explanations under the table |
| `tokens` | Fixed periods of every model of the provider the switch shows (under `All`, of every provider), whatever the chips say. Totals table (usage, fresh input, cache write 5 m / 1 h, cache read, output, reasoning, requests, hit rate, per request, API cost) with the rows `Today`, `Last 7 days`, `Last 30 days`, `This week`, `This month`, `All time`. Two rows lead them: `Current 5 h window` and `Current 7 d window` cover exactly the window the provider reports a reset for, so they can be read against the quota card above — where no such window is reported the row is a trailing `Last 5 h` / `Last 7 d` span and says so. Both are summed from hour buckets, so once the oldest hours of the span have been rolled up into day totals every figure in the row carries `≈` and is a lower bound; the span itself is the tooltip of the row label. Then the composition bar over the last 30 days with a `cache` switch that hides cache read and cache write (the remaining shares are then shares of what is drawn, and a caption names the tokens left out), the cache economy of the same 30 days, calendar periods and the plan factor |
| `chart` | Stacked daily (or weekly) bars for the selected range, one band per model in its provider's hue — the models of one provider told apart by pattern or shade (`chart.modelStyle`) — or, with the `subagents` chip beside the metric selector pressed, two bands per provider: its main sessions and its subagents. A metric selector and an optional cost line on a second axis through the column centres. Clicking a column drills into that day |
| `models` | Per-model breakdown with the same columns as the totals table (usage, fresh input, cache write 5 m / 1 h, cache read, output, reasoning, requests, hit rate, per request, API cost) plus the share of the range; every column sortable, with average and P90 turn length where enough samples exist. Where the rates came from is the tooltip of the cost, not a column |
| `heatmap` | Calendar heatmap of the last 53 weeks with current and longest streak, active days, peak day and a variability measure. Days outside the coverage are dotted, not empty |
| `hours` | Hour-of-day profile and a weekday × 4-hour grid, captioned with the weeks of usage days it stands on. A block nothing was ever done in is hatched |
| `records` | Records of the selected range: peak day, longest run of days with usage, the top models, projects and sessions, and (since 1.11) the most expensive days — a day whose cost is a lower bound marked ⚠ —, the longest and the largest Claude Code sessions — by time and by tokens, from the Agents section's sessions of the last seven days, only those no longer active, named by their start and the first eight characters of their id — and the hours with the most cache written (`dashboard.topN` rows each). Off by default; the top projects and sessions need `tokenPace.attribution`; while Token Pace is still reading the history the section says *Reading history…* and shows no record |
| `tools` | Tool calls of the selected range by name, with the share of the calls counted in it and the models that made them (`dashboard.topN` rows). Off by default; names only, never a tool's input or its result, and the section states the day counting started |
| `budget` | Your own limits from `tokenPace.budgets`: used, limit, share against **that** number, and the end-of-period projection. Off by default; a period with no local data shows a dash, and no budget is ever added to another. Neither the switch nor a chip moves a figure: under one provider the section shows the `total` budgets and that provider's own, each with the figures `All` shows, and not the other provider's — the status bar's budget item and the budget alerts keep every budget |
| `history` | Reset retrospective of the providers the switch shows: how often the window was exhausted, how much was left over |
| `projects` | Per-project breakdown — needs `tokenPace.attribution` |
| `sessions` | Per-session breakdown — needs `tokenPace.attribution: session` |
| `dataQuality` | Roots, file counts, coverage, bucket counts, the subagent tokens of the last seven days counted two ways — `Agent entries, last 7 days` (every agent of the tree at its whole usage, as its entry keeps it) against `Subagent tokens in the hour buckets, last 7 days` (the hour of each reply, `≈` once those hours reach below the roll-up), under them the note that *the two differ by construction: an agent entry keeps a whole agent, a bucket the hour of each reply* —, retention, quota history size, every source with its age or its failure, drift, calibration, bridge state, consent, role — plus buttons for the export and diagnostics commands. Under one provider the per-provider parts follow the switch — the sources, drift and calibration of that provider, the two subagent lines only under `Claude Code` and `All` — and the lines about the machine (roots, files, coverage, buckets, snapshot, retention, history, consent, role, bridge, version) stay whole |
| `prompts` | Your own prompts for Claude Code and Codex — at first the three Token Pace ships, *Status table*, *Keep the cache warm* and *Stop after this task*: a double-click on one types its text into the terminal of this window that runs Claude Code or Codex and presses Enter, a click opens its title and text to edit. Off by default; not filtered by the range or a chip, and shown whatever the provider switch shows. The list lives in `prompts.json` in the extension's storage and nowhere else — see [Prompts](prompts.md) |

Defaults omit `context`, `records`, `tools`, `budget`, `history`, `projects`, `sessions` and `prompts`; `projects` and `sessions` stay
empty until attribution is switched on and say so instead of showing an empty table, and
`context` says how a reading could be had instead of inventing one.

**The provider switch.** Three buttons at the very top of the page, above everything else —
`Claude Code`, `Codex`, `All` (German `Alle`) — one pressed: the provider the page shows, or every
one. It is the page's first element, above a preview banner or the first-run box, because it
governs every section below it; `All` is the page as it always was. Under `Codex` the `agents` and
`context` sections are not drawn at all — no heading, no fold, no gear — and they come back at
their place when the switch shows `Claude Code` or `All` again. A change of provider clears the model chips
(a model of the other provider would empty every filtered section) and is remembered with the rest
of the view state; the button just pressed keeps the keyboard focus while the page below it is
redrawn. The buttons are a labelled group (*Providers*) of toggle buttons with `aria-pressed`, each
a stop of the `Tab` key and at least 24 × 24 px, and they stay on one line down to the narrowest
sidebar. A third provider in the registry would be a fourth button. The same row ends with the
language picker's flag (*Language*, below); where the row is too narrow for both, the flag moves onto
a line of its own under the switch.

**The filter bar.** One labelled block with a row each for **Range** and **Models**: the labels
share a column, so the chips of both rows start at the same place instead of running on as one
paragraph of buttons. The range in words (`Last 30 days · 2026-08-06 → 2026-09-05`) ends the range
row, and the refresh button sits at its right end as an icon. The providers are not chips of the
bar: the provider switch above the page picks them.

**Ranges.** Chips for `today`, `7d` and `30d` are on the bar; `yesterday`, `90d`, `week to date`,
`month to date`, `last month`, `year` and `all` are one `more ▾` chip away (`fewer ▴` puts them
back, and a range you have selected stays visible whatever the fold says). `week to date`, `month to date`
and `last month` are the values `thisWeek`, `thisMonth` and `lastMonth` of `dashboard.defaultRange`; the chip names
the choice, and the span keeps its own name where it is shown — the Tokens section's rows *This week* and *This month*,
and the range line of the Quick Pick and the markdown document (`This week · 2026-09-21 → 2026-09-27`). Two date fields
give a custom range (capped at five years, and a reversed range is swapped rather than
returned empty); they stay hidden until you open them with the `custom…` chip, or until the
range actually is a custom one, so the common case is chips only. `dashboard.defaultRange` is
the starting point; the range you pick is remembered for the session. `all` starts at the
first day actually ingested, never earlier.

**Filters and sorting.** Up to twelve model chips — above four the row is one `models (N) ▾`
chip until you open it, because a long chip row pushes the figures off the panel, and a model you
are filtering on stays on the bar either way — and a
model table sortable by every column it shows (`model`, `usage`, `freshInput`, `cacheWrite5m`,
`cacheWrite1h`, `cacheRead`, `output`, `reasoning`, `requests`, `cacheHit`, `perRequest`, `cost`,
`share`, ascending or descending).
Chart metrics: `usage`, `output`, `cache read`, `requests`, `reasoning`, `cost`. The chart is
stacked **by model** unless its `subagents` chip is pressed (below), one band per model under each provider: every band wears its
provider's hue — Claude blue, Codex purple — and the five largest models of a provider are told
apart by rank, drawn as a pattern (solid, 45° stripes, 135° stripes, cross-hatch, horizontal
lines), as a shade of the hue, or as both (`tokenPace.chart.modelStyle`); the rest of that
provider's models is folded into one `other` band — dotted under `pattern` and `both`, the
faintest shade under `shade` — so the column total is the same however many models there are. The legend is grouped by provider and its swatches carry the
band's own fill; a band's tooltip names the model, the provider, the value, its share of the
column and the provider's column total. In a forced-colours theme (Windows High Contrast), which
removes every pattern and every hue, the bands are drawn as patterns in the theme's two colours,
the text colour and the page colour, whatever the style: the largest model of a provider solid in
the text colour, then 45° stripes, 135° stripes, cross-hatch, horizontal lines, and dots for
`other`, each band ringed by the page colour so two bands side by side stay two — all but a band
drawn under 4 px tall, which the ring would cover whole: it keeps its pattern or its solid fill
alone, the dots of `other` in its middle. Two colours cannot carry the providers' hues, so there
the provider is told by the legend's headings, the band's tooltip and the order of the bands in a
column. The value labels over the columns and the dates under them are thinned to the width a
column actually has — only every n-th one where they would crowd (over 30 days every third value and
every fourth date in a 420 px sidebar, every seventh and every eighth at 260 px), each column's total
still in its tooltip — and fitted again when the sidebar is resized and when a folded chart section is
opened. The cost line, when switched on, runs through the column centres over a halo in the page
background, with a dot per column, on its own axis.
The heatmap switches between `usage` and `cost`; the hour profile between local time and UTC.

**Main sessions and subagents.** The `subagents` chip beside the metric selector splits every
column by who wrote the tokens instead of by model: two bands per provider, `Claude Code · main
sessions` in the plain hue and `Claude Code · subagents` in the first pattern (or shade) of the
style — the same for Codex, whose subagents are its forked threads. The split comes from the
buckets' own subagent dimension — a reply written in a transcript under `subagents/` for Claude
Code, a forked thread for Codex — so the two bands of a provider sum exactly to its column split
by model, day by day and in every metric; nothing is estimated. A part that counted nothing in the
range has no band, and the model chips and the provider switch narrow the split as they narrow the models.
The legend has no provider headings then — each label names its provider — and a band's tooltip
reads `Claude Code · subagents · 12,345 · 58.8 % of the day · Claude Code total 21,000`. Pressed
(`aria-pressed`), the chip draws the split; pressed again, the models. The choice is kept with the
rest of the view state. In a forced-colours theme (Windows High Contrast), which removes every
pattern and every hue, the main sessions are drawn as a solid band in the text colour and the
subagents as a band of the page colour ringed by the text colour, so the two parts of a column stay
apart — a subagents' band drawn under 4 px tall, which its ring would fill whole, as vertical stripes
instead, one pixel of the text colour in three, so that it never reads as a band of main sessions.

**Collapsing.** Every section header is a toggle. What you collapse is remembered with the rest
of the view state (range, sort, filters, the provider switch, the chart's split), so a panel you have trimmed to two sections opens that
way again. The nodes you open in the agent tree — it starts closed — the one whose details are
open, and how many more children you asked an opened node to show, are kept the same way. `tokenPace.dashboard.sections` decides what exists at all; collapsing decides what
you look at today.

**The gear in a section header.** Opens the settings editor filtered to the settings that
section is made of — the quota gear to the quota sources, the poll interval and the pace
settings, the models gear to the row cap and the price table, and so on; every list ends with
`tokenPace.dashboard.sections`. It never toggles the fold, with the mouse or with the
keyboard, and it changes nothing on its own: it opens the settings you would otherwise have
to find among all of them.

**Prompts.** The `prompts` section — not in the default; add it to `tokenPace.dashboard.sections`, first
for the quickest reach — is your own list of prompts for Claude Code and Codex. At its top a dim line
says how it works and that text typed in the terminal and not sent yet goes with a prompt, a second
one where a prompt would go now (*Sends to Claude Code in terminal 2 of 3 — ready*); then the
prompts, each its title with up to two lines of its text under it (a slash command in the editor
font; the whole text in its tooltip) and a send button beside it; at the end *New prompt*, and
*Restore default prompts* while a shipped prompt is missing. A double-click on a prompt, its send
button, or Ctrl+Enter (⌘+Enter on a Mac) on it types its text into the terminal that runs Claude Code
or Codex and presses Enter; a click opens its title and text in its place after a third of a second,
so that a double-click never leaves them open; Enter or leaving the fields saves, Escape leaves the
prompt as it was, *Delete* asks in the page first, *Move up* and *Move down* reorder. Fields you have
open keep what you typed through every update of the page, a language switch included. The editing
rules, the keys and what a screen reader hears are in [Prompts](prompts.md#editing); where a prompt
goes and when Token Pace asks first, in [Sending](prompts.md#sending).

**Peak hours.** No fixed peak windows are built in. The profile is drawn from your own hour
buckets and nothing else, and rolled-up days that no longer have an hour are named as excluded
instead of being folded into the picture. The weekday × 4-hour grid draws every block a day of
usage reached, however few days there are, and hatches the blocks no day reached — “hatched: no
usage in that block”, said under the grid rather than left to be guessed. How thin the evidence
is, is the caption: the days that carry usage, rounded up to whole weeks, as *based on 1 week — a
single observation, not a habit* and *based on 2 weeks — observations, not yet a habit* below three weeks and
*based on 4 weeks* from three weeks on. The weeks are
counted from your usage days, not from the length of the range: four working days inside a month
are four days of evidence, not four weeks of them.

**Records.** The `records` section — off by default — holds the extremes of the selected range, at most
`tokenPace.dashboard.topN` rows per table: the peak day, the longest streak, the top models, projects and
sessions, and four tables since 1.11. *Most expensive days* ranks the range's days by their API cost at your
configured rates; a ⚠ marks a day whose cost is a lower bound — it holds usage without a price on file, or the
transcripts on disk begin that day —, a screen reader hears it as “lower bound”, and a note under the table says
what it means. *Longest sessions* and *Largest sessions* rank the Claude Code sessions of the Agents section's last
seven days that are no longer active, by the time from their first counted line to their last (pauses included)
and by their usage (their own and their agents'), each named by when it started and the first eight characters of its id (`Tue 14:20 ·
9d0eb37a`) — the Agents section's name without the word *Session*, which the column head says; a session still active is counted in a note and not ranked, since its time and tokens are still
growing, and under the Codex view the line *Claude Code only* stands in for both. *Hours with the most cache
written* ranks hours, not requests — the hour buckets by the tokens written to the prompt cache, with the part
written for one hour, what those writes cost and the models that wrote them; a large write is usually a cold
start, a new conversation or a compaction, and an hour can hold several, as the note under the table says. Every
cost column follows `tokenPace.showCost` and is headed *API cost (your rates)* while your own rates apply; an
absent figure is a dash. While Token Pace is still reading the history — the first scan, a rescan — the section
says *Reading history…* and shows no record at all, so no record is read from half a history; and nothing of it is
stored, so a rescan that reads fewer transcripts shows fewer records, never an old one. The Quick Pick and the
markdown view carry the same rows.

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
Of the agents section the Quick Pick has a group of its own after the quota — the first five
entries of the running list (the name marked `~`, running being inferred; where it sits under
it), one row for the rest, and what the sessions' agents came to: their tallies added — the
earlier sessions' too, whose group is closed on the page —, *Last 7 days: 14 started · 5 ✓ · 2 ✕ ·
…*, in words under it, and past the sessions the tree lists the number it counts, the active
sessions and those the group holds (`… · the 23 most recent sessions of the last 7 days`) — every
row opening the dashboard. The markdown document prints its running list, the 7-day block while the
dashboard has it open, and the whole tree as indented lists — every node open, the group of earlier
sessions a list item without a state or a figure and its sessions one level in, fifty children a
node and a line for the rest — with the open node's details as a table. While the switch shows
Codex, neither view has an agents part or a context line, as the page has neither section.

**Language.** The flag at the end of the top row is the language picker — the US flag while the
texts are English. A click on it, or `Enter`, `Space`, `↓` or `↑`, opens a menu: *Automatic — as VS
Code (English)* first, then the twenty-six languages, each with its flag, its own name and its name in
the language you read now (*Deutsch* · German); the chosen line carries a ✓. In the menu `↓` and `↑`
move, `Home` and `End` go to the first and the last line, `Enter` or `Space` chooses, `Escape` closes
it and puts the focus back on the flag, and `Tab` leaves it without a choice. A letter moves the focus to the next
language whose own name or name in your language begins with it, round the list, and chooses nothing. A choice switches Token
Pace's own texts at once, without a reload — the status bar and its tooltips, this page, the Quick
Pick, the markdown document, and every alert, message, dialog and notification from then on, with dates and numbers
formatted for that language (German `2,8M`, `1.234.567`) —; the page keeps its scroll position, the
focus goes back to the flag, and the choice is written to `tokenPace.language` in your user settings.
Under the open menu two lines say what cannot follow — *Token Pace's own texts switch at once. The
settings, the command titles and the walkthrough follow VS Code's display language (Configure Display
Language).* — and who translated — *The languages beyond English and German were translated by AI
agents and checked by tests, not by native speakers.* `auto`, the default, follows VS Code's display
language where Token Pace has a translation for it, and English where it has none. English is the
source text, so an untranslated string falls back to English rather than going blank. Three things
stay English on purpose, because they are pasted into issues and have to be readable by a maintainer:
the debug log, the diagnostics report, and the CSV and JSON exports. The whole account — `auto` and
what VS Code reports, what switches at once and what cannot, the twenty-six languages and their flags,
the notation that stays the same in every language — is in [Languages](languages.md).

**Accessibility.** Bars are `role="progressbar"` with `aria-valuenow` and a spoken
`aria-valuetext`; sortable headers carry `aria-sort`; toggles carry `aria-pressed`; chart
columns are focusable buttons. The running list's rows are buttons ahead of the tree, under a
level-three heading; the `Last 7 days` button at the end of its first line carries `aria-expanded`,
and the block it opens is a region named by its heading, its largest agents buttons like the
running list's. The agent tree is a `tree` of `treeitem`s with `aria-level`, `aria-setsize`,
`aria-posinset`, `aria-expanded` and `aria-selected`, each named in words — its whole name, its
state, its tally — and described by its figures (the group of earlier sessions, which has no state,
no figures and no details, is named by its words and its tally alone and carries no
`aria-selected`); it is one stop of the `Tab` key, and the arrow
keys, `Home`, `End`, `Enter`, `Space` and `Escape` work in it as in any tree (roving `tabindex`,
see [Agents](agents.md#the-keyboard)); its toggle and its row are the mouse's targets. Every state
glyph has a spoken label that says in words whether the state was recorded or derived (`running, derived`),
and an agent's name and its tally's parts are in the colour of their state as well — green done, yellow
unknown, red failed, blue running, each mixed with the text colour to at least 4.5:1 —, the third
carrier beside the glyph and the words, never the only one (in the Agents section a colour means an
outcome, on the quota cards a pace); the tree's guide lines, which connect every child to its parent
in the theme's indent-guide colour, are decoration only — nothing to read, nothing to copy; the tree's
structure is in each item's level, place and size;
a clock that ticks every second is hidden from a screen reader and stands beside it as words that
stand still (`since 14:20`); the toggle and the row are targets of at least 24 × 24 px, and a
forced-colours theme draws the glyphs, the `⚠`, the open row and the guide lines in the system's colours — the names
and the tallies in its text colour, the state colours giving way — and every
pressed chip of the page (a button of the provider switch, a range, a model, the custom dates, the
cache switch, the chart's `subagents` and cost line, the heatmap's metric, the hours' zone) in the highlight colours,
where the theme would otherwise give pressed and released chips the same face. A pressed chip, a
band of the chart by model and a thin subagents' band of the split are the three things the page takes
out of the theme's adjustment, and they wear nothing but the theme's own system colours: left in, a
chip would get a backplate of the page colour behind its words, on which the highlight text cannot be
read, and the bands would all be painted in the page colour, the theme having removed their patterns
and their hues — taken out, they are drawn as patterns in the theme's two colours (see the chart
above), and a subagents' band under 4 px tall is striped, where its ring would otherwise fill it and
make it look like the main sessions' solid band. The focus
stays on its row — the running list's button, or the tree's item — when the section is pushed
again, on the provider switch's button you pressed when the switch is, and on the language picker's flag after a choice; in the Prompts section it stays in the open fields, with the selection you had, or on the control you pressed there. The webview loads no external resource of any kind — its CSP
allows exactly one nonced inline style and script, and the chart, heatmap and sparklines are
CSS and inline SVG. Everything the webview sends back goes through an allow-list that accepts a
range, a sort, a filter, a provider for the switch (`all` or one the registry knows), a language for the picker (`auto` or one of the twenty-six ids — the one setting the page can have written, `tokenPace.language`, in your user settings), a metric, the chart's split (`model` or `agents`), a drill day, a section toggle, the 7-day block's disclosure, the key of an agent-tree node to
open, close, select or show more children of — at most 200 characters, and only ever matched against the nodes the tree
was built with —, the id of a prompt to send, delete or move, a prompt's title and text to save (at most 80 and 2000
characters, cleaned once more before they are stored; a send carries the id alone, and Token Pace types the text it
reads for that id), or one of a fixed list of named commands; never a path and never another setting. Where a webview is unavailable or unwanted, the QuickPick and markdown views
carry the same figures.
