<!--
SPDX-FileCopyrightText: 2026 Frederik Marx
SPDX-License-Identifier: AGPL-3.0-or-later
-->

# Numbers, words and pace

Part of the [Token Pace documentation](../README.md#documentation).

## Where the numbers come from

| Display | Source | Confidence | Freshness |
|---|---|---|---|
| Claude quota %, reset, model windows | external cache file (default `~/.cache/claude-usage/state.json`) | exact — the provider's own response | the writer's `fetched_at`; can be hours |
| the same | status-line mirror, if you installed the bridge | exact | every status-line refresh of Claude Code |
| the same | `cachedUsageUtilization` in `~/.claude.json` | exact | Claude Code's own cache; discarded above 24 h |
| the same | our own fetch of `api.anthropic.com/api/oauth/usage` | exact | `pollIntervalMinutes` (default 30) — consent required |
| Codex quota %, reset, credits | external cache file (default `~/.cache/codex-usage/state.json`) | exact | the writer's `fetched_at` |
| the same | the `rate_limits` block Codex writes into its own transcripts | exact | as old as your last Codex turn — the age is always shown |
| the same | the local `codex app-server` (`account/rateLimits/read`) | exact | poll interval — consent required |
| Tokens per hour / day / model | `~/.claude/projects/**/*.jsonl` | exact | on file change |
| Tokens per hour / day / model | `~/.codex/sessions/**/rollout-*.jsonl` (and `archived_sessions/`) | exact | on file change |
| Output of any response with no terminal line — in Claude subagent transcripts, most often a reply cut off at the tool call it made | the same transcripts | **lower bound** (⚠ in tooltip, tables, export, the agent tree's rows and its details, with how many of how many replies are unfinished) | – |
| Agent states done, failed and stopped | the parent's tool result or task notification, or the workflow run's journal | **recorded** | on file change; the agent tree is pushed at most every 2 s |
| A workflow run's end | the task notification for its latest `Workflow` launch, else its members' recorded ends, else Claude Code's run record (`<session>/workflows/wf_<id>.json`) | **recorded**, the source named in the sentence; without one the run's state is derived from its members | on file change; a run record only when its size or time changed |
| Claude Code's run record of a workflow run (status, start, agents, tokens, tool calls, duration, default model) | the seven top-level fields of `<session>/workflows/wf_<id>.json` | Claude Code's own figures — an undocumented file; shown, never added to a total, `–` where a field is absent | the same |
| Why an agent ended on a rejected request (`5-hour limit (HTTP 429)`) | the last API error line of the agent's transcript | **recorded** — Claude Code's own error line; never a request or a token | on file change |
| An agent's tool errors, cache misses, Claude Code version, permission mode and compactions | its transcript's metadata: tool results marked `is_error`, a reply's cache-miss reason, a line's `version`, the `permissionMode`, compaction lines | **recorded** counts and words; the tokens not read from the cache only where a reason states them | on file change |
| Running agents in the status bar (`~3 running`) and the Agents section's `Running now` | the same derivation as the running state | **derived** — hence `~` | the same |
| `waiting for approval` / `waiting for input` on an agent's row | the opt-in agent hook's mirror file, a line younger than 30 minutes | a **marker** Claude Code's hooks reported, never a state | when the file changes |
| Agent states running and unknown, sessions active and idle | the time of a transcript's last response, or of the launch | **derived** (`~` in the glyph's title), with the sentence it rests on | the same |
| Report from Claude Code of a sync agent | the tool result that returns the agent | Claude Code's own figure — the context of the agent's last request with its reply, not what it used; shown, never added to a total | – |
| An agent's context at the end, token mix, rank in its run, usage per minute | the agent's transcript — the counted replies | **exact** for what was counted; the context is its newest request's input, cache write and cache read, without the reply | on file change |
| An agent's effort | the top-level `effort` of its replies' lines | **recorded** — Claude Code's own word, one of five | on file change |
| Subagent share of a Claude window (`Subagents 4.7M of 5.5M counted here (86 %)`) | the hour buckets of the local Claude transcripts over the window's own bounds — its reset minus its length, up to now — the subagent transcripts' against all; for a model window (`7 d Opus`) both figures of that window's models only — the Claude models of its family | **exact** for what was counted on this machine; `≈` on both figures once the window reaches below the hour buckets' roll-up. A share of tokens, **never of the quota**: it is not multiplied into the window's percentage, which covers every client of the account. Claude only, and on no card while the last seven days hold no agent record and no subagent hour bucket | on file change |
| Agent entries against subagent hour buckets (data quality) | the agents' entries of the last seven days, each at its whole usage, and the subagent hour buckets of the same seven days | **exact**, both — the buckets' figure `≈` once those seven days reach below the hour buckets' roll-up; they differ by construction — an agent entry keeps a whole agent, a bucket the hour of each reply — and neither corrects the other | on file change |
| Prompt cache of a Claude Code session — cooling, cold since, what a cold start would re-write (`prompt cache cools in 4 m 10 s`) | the status-line bridge's `prompt_cache` for that session; where it does not describe the session's newest request, the transcript's newest cache request plus the one-hour lifetime | **exact** from the bridge; **estimate** from the transcript — `~` on every figure and *estimated from the transcript* in words; the money beside it always `~` — see [Prompt cache](prompt-cache.md) | every rebuild of the dashboard |
| API cost | token counts × a dated price table | **estimate** (`~`) | table checked 2026-09-06, the Claude Opus 5.5 row 2026-09-24 — the footnote says both: `Prices as of 2026-09-06; checked later: claude-opus-5-5 (2026-09-24).` |
| Burn rate, ETA, end-of-window, reset retrospective | the stored quota history | **estimate**, with a stated confidence and “based on *N* readings” | needs several readings |
| Tokens per percentage point (calibration) | quota history ÷ local tokens | **observation about your data**, off by default | – |

For Claude the windows come from the response's `limits[]` array, not from the top-level
fields: only there do the model-scoped quotas appear (`kind: "weekly_scoped"` with
`scope.model.display_name`). The older top-level shape (`five_hour`, `seven_day`,
`seven_day_opus`, …) is still read as a fallback.

The percentages come from each provider's server and cover **all** clients — desktop app and
browser included. They cannot be derived from the local token counts, and the extension
never suggests otherwise.

“Usage” means fresh input + cache write + output. Cache reads are listed separately because
they would otherwise dominate the total by a factor of ~1000.

Absence is never drawn as a number: a missing figure is `–`, never `0 %` or `$0.00`; a window
without a stated length gets no pace and no forecast rather than an invented denominator; a
day with no data has no row in an export rather than a row of zeros.

**In your language** (1.9). A figure is written the way the language you chose — with the flag at the
top of the dashboard, or `tokenPace.language` — writes it: its digits, decimal mark and grouping
(German `2,8M` and `1.234.567`, French a decimal comma and a narrow space between thousands), its names
of weekdays and months, the weekday in front of a clock time in its own short form; under `auto`, the
way VS Code's display language writes it. The notation is the same in every language, because it is
the bar's and the page's own and not a word: the countdowns `45m`, `2h14m`, `3d 5h` and `4 m 10 s`,
the suffixes `K`, `M` and `G`, the `$` in front of an amount, the ISO day `2026-09-01`, `1 h TTL`, and
the marks `~`, `⚠`, `≈` and `–` this page explains. The whole list is in
[Languages](languages.md#numbers-dates-and-times).

**Decimals** follow the language too (1.10), wherever the dashboard, the tooltips and the text views
print one: a key figure's change against the period before (`▼ -0,7%` in German — the sign and the `%`
are the badge's own and stay attached to the figure), the plan factor (`×0,4`), the variability of the
heat map (`CV 0,35`), a band's share of the day in the chart's tooltip, a threshold with a decimal in a
window's explanation and a span under ten hours (`2,5 h`). The CSV and JSON exports and the diagnostics
report keep the `.` in every language: they are read by programs, not by you.

## Words used here

Nine terms carry most of the meaning in this extension. Each is used in exactly one sense, in
the status bar, the tooltip, the dashboard and the exports alike.

| Term | What it means |
|---|---|
| **Window** | One quota bucket of a provider, with a length and a reset time: Claude's 5-hour session, its 7-day plan window, a model-scoped 7-day window, Codex's 5-hour and 7-day limits. Every figure belongs to a window; nothing is ever summed across two |
| **Pace** | Consumption compared with the share of the window that has **already elapsed**, not with a fixed threshold. `ratio = (used ÷ limit) ÷ (elapsed ÷ window)`; `1.0` is exactly on pace |
| **Ahead of pace / spare** | The same relation as a difference of percentages (`used % − elapsed %`). Above the line it reads `5 % ahead of pace`, below it `36 % of the window still spare`. The unit is percentage points of the window, written `%` — the same sign as the figure above it |
| **Elapsed marker** | The `┃` inside the bar, at the position the window's own clock has reached. Fill left of it is spare, fill right of it is ahead of pace. It is what makes the verdict readable without colour. The dashboard bar also paints the gap: fill beyond the marker is drawn in a darker shade of the level colour, and track between the end of the fill and the marker in a stronger grey than the rest of the track |
| **Lower bound** | A figure that is certainly *at least* this large but may be larger: the output of a response with no terminal line is counted only as far as it was written. Marked `⚠` in the tooltip, the tables, the exports, and on the agent tree's rows — its title the reason, `⚠ lower bound — 2 of 41 replies unfinished` — and in their details, and never quietly rounded up |
| **Provenance** | Where a number came from and how sure it is. Every view carries it: `measured: quota, tokens · estimated: ~API cost`, and per model `exact` / `family` / `custom` / `none` |
| **Poll vs cache** | *Poll* is a request Token Pace makes itself, with your access token, after consent. *Cache* is a reading somebody else already fetched — a cache file, Claude Code's status line, `~/.claude.json`, the Codex transcripts. Cache costs nothing and touches no network; its age is always shown |
| **Forecast state** | The named answer a forecast gives instead of a bare number: `none`, `full`, `stale`, `measuring`, `idle`, `resetsFirst` (`~ends at 62 % when it resets`) or `eta` (`~empty in 3.2 h (15:42) · medium confidence`) |

## Pace, not level

Each bar carries a tick marking how much of that window's own time has already passed, and
the colour compares consumption against that tick rather than against a fixed threshold.

The verdict is one ratio:

```
ratio = (used ÷ limit) ÷ (elapsed ÷ window)
```

`1.0` is exactly on pace; above `1.0` you are consuming faster than the window refills. The
same relation is stated as a **difference of percentages** (`used % − elapsed %`), because that
number stays readable near the start and the end of a window where the ratio explodes towards
infinity. The unit is percentage points of the window, and it is written `%` — the same sign as
the figure above it. The tooltip always names the difference, tolerance or not.

The colour follows that difference at once: a window ahead of its clock is yellow, at or
behind it green. Both are rounded to the whole percent the card prints, so a card that says
`on pace` is never yellow and one that says `1 % ahead of pace` always is — the sentence and
the colour never contradict each other.

Two guards keep the verdict honest:

* **Tolerance band** (`pace.tolerancePoints`, default **0**). Whoever wants a few points of
  grace before the colour flips can ask for them. The band is taken off before the rounding:
  with a band of 5, a card reading `5 % ahead of pace` stays green and `6 % ahead of pace` is
  yellow. It applies with every sensitivity.
* **Minimum elapsed.** Right after a reset `elapsed ≈ 0`, so the ratio explodes and the very
  first prompt would always look too fast. While that little of the window has run **and** at
  most 10 % of it is used, the verdict is `measuring`: the bar stays green and the views print
  no pace text at all. Above that share the reading is far too large to be an artefact of the
  short clock — 60 % of a window spent in its first two minutes is a fact, not a rounding
  error — so it is judged from the first minute, and bar, verdict, status bar and sparkline
  colour together.

`tokenPace.pace.sensitivity` picks how long a window counts as just reset:

| Preset | Minimum elapsed |
|---|---|
| `relaxed` | 5 % |
| `normal` (default) | 3 % |
| `strict` | 1 % |
| `custom` | `pace.minElapsedPercent` |

| Colour | Meaning |
|---|---|
| 🟢 green | usage at or below the elapsed share (plus the band, if one is set) — on pace |
| 🟡 yellow (▲) | usage ahead of pace, from the first whole percent |
| 🟡 amber (▲▲) | 15 % or more ahead — three times the band, at least 15 — only with `pace.levels: graded` |
| 🔴 red | the window is spent (≥ 99.5 %); the status bar entry also gets an alarm background |

In the Agents section a colour means an outcome — green done, yellow unknown, red failed, blue
running —, not a pace: on the quota cards yellow and red say how fast a window fills. The
[Agents](agents.md#the-tree) page says which rows wear one.

Exhaustion outranks everything: a full window is a fact, not a tendency. The verdict text is
one of `on pace`, `5 % ahead of pace`, `36 % of the window still spare`,
`no clock for this window`, `exhausted` — or nothing, while the window is still measuring.

An absolute level says little on its own: 80 % used is comfortable six days into a weekly
window and alarming six hours in. Real numbers from one session:

```
CC 5 h     98 % used · 82 % elapsed   → yellow ▲
CC 7 d     40 % used · 80 % elapsed   → green
CDX 7 d   100 % used · 10 % elapsed   → red
```

Windows that report no reset time have nothing to compare against; they stay green until
they are spent.
