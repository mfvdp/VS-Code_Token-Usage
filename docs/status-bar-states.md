<!--
SPDX-FileCopyrightText: 2026 Frederik Marx
SPDX-License-Identifier: AGPL-3.0-or-later
-->

# Status bar states

Every text Token Pace can put in the status bar, what it means, which state wins when
several apply, and the one thing to check when it is not what you expected.

This table is the contract: `src/statusText.ts` implements it, `test/statusbar.test.ts`
pins it, and nothing else in the extension may invent a wording of its own.

## How an item is built

An entry is assembled from fixed parts, always in this order:

```
[state glyph] LABEL WINDOW [bar] VALUE [indicator] [· reset] [$(history) age]
   $(warning)   CC    5h   ██┃▁▁▁▁▁  25%     ▲        · 2h14m      $(history) 12m
```

* **LABEL** is `CC` / `CDX`, overridable per provider with `tokenPace.labels`
  (`{"claude": "Claude"}`).
* **WINDOW** is the provider's short window name (`5h`, `7d`, `Fable 7d`), overridable per
  window id (`{"weekly_scoped:10080:fable": "F7"}`). Names we derive ourselves are
  shortened to `tokenPace.labelMaxChars` with an ellipsis; a name you set yourself is
  never shortened.
* **bar** obeys `barWidth`, `barStyle`, `barGlyphs`, `timeProgressStyle` and
  `percentMode`. The `┃` marker sits where the window's own clock stands, so usage ahead
  of the marker means you are ahead of the clock. It needs a width of at least 6.
  `barStyle` `line` (`▁`) and `shade` (`░`) differ only for `barGlyphs: blocks`; `shapes`
  and `dots` bring their own empty glyph (`□`, `○`) and `pie` has no empty part, so for
  those three only `none` (a blank track) changes the output.
* **VALUE** obeys `percentMode` (`used` / `remaining`) and `overflowDisplay`
  (`clamp` / `actual`).
* **indicator** is the colour-free half of the pace signal, shown when
  `tokenPace.indicator` is `glyph` or `both`.
* **reset** obeys `resetFormat` (`none`, `relative`, `absolute`, `both`) and
  `resetHourCycle`. A window whose provider states no reset time never gets one.
* **age** obeys `showAgeInItem` (`never`, `whenStale`, `always`) and is recomputed against
  the clock on every redraw.

### Item ids, order and priority

Ids are content-bound and stable, because VS Code remembers per id whether you hid an
entry (right-click on the status bar):

| Entry | Id |
|---|---|
| Quota window | `tokenPace.quota.<source>.<window id>`, with every `:` in the id replaced by `.` |
| Quota problem | `tokenPace.quota.<source>.problem` |
| Extra usage | `tokenPace.extra.<source>` |
| Forecast | `tokenPace.forecast.<source>` |
| Tokens | `tokenPace.tokens` |
| API cost | `tokenPace.cost` |
| Collective item (`density: minimal`) | `tokenPace.summary` |
| Per-provider item (`density: compact`) | `tokenPace.compact.<source>` |
| Preview | `tokenPace.preview.<n>` |

The order follows `tokenPace.statusBar.show` (an ordered array — sorting it sorts the bar),
and within a provider the order the parser sorted the windows into: shortest window first,
and a model-scoped window after the plan-wide one of the same length (for Codex, the main
`codex` limit before the model-specific buckets). The first entry gets priority 1000, each
following one is one lower, so the group stays together. Changing the order or `alignment`
rebuilds the items, because VS Code fixes both at creation time.

## Which state wins

Only one state can be drawn, so they are ranked. Top of the list wins:

1. **Problem** (`ok: false`, or no windows at all) — a named cause replaces the figure.
2. **unlimited** — the window (or the credit pot) has no limit. It outranks everything below,
   because a window without a denominator cannot be full, over, or due.
3. **limitReached** — the provider says the limit is hit.
4. **resetDue** — the reset has passed and no reading newer than it has arrived.
5. **overflow** — above 100.5 %.
6. **exhausted** — at or above 99.5 %.
7. **normal** — the pace verdict decides the colour.

Two modifiers apply on top:

* **stale** (reading older than `staleAfterMinutes`): the item turns grey and **loses its
  alarm background** — a stale reading may not raise an alarm, because the state it
  describes may be long over. State glyphs stay.
* **monochrome** (`colorMode: monochrome`): no colours at all; the glyphs carry the signal.
  The alarm background is not a colour setting and stays.

## Data states

| Text | State | Colour / background | Check |
|---|---|---|---|
| `CC 5h ██┃▁▁▁▁▁ 25% · 2h14m` | normal, on pace | `tokenPace.paceOk` | – |
| `CC 5h ████┃▁▁▁ 45% ▲ · 2h14m` | ahead of the clock beyond the tolerance | `tokenPace.paceWarn` | Tolerance: `pace.sensitivity`, or `pace.tolerancePoints` with `custom`. |
| `CC 5h ██████┃▁ 80% ▲▲ · 2h14m` | more than three times the tolerance ahead | `tokenPace.paceAhead` | Only with `pace.levels: graded`. |
| `CC 5h ██████┃█ 100% · resets 47m` prefixed with `$(warning)` | exhausted (≥ 99.5 %) | `statusBarItem.errorBackground` | The countdown is now the only number that moves; it is named so it cannot be mistaken for a percentage. |
| `CC 5h ████████ 111%` | overflow (> 100.5 %), billed beyond the plan | `charts.red` | `overflowDisplay: clamp` shows `100%` instead — the figure is real, not a rounding error. |
| `⛔ CC 5h ████████ 100%` | the provider reports the limit as reached | `statusBarItem.errorBackground` | An explicit provider flag, not derived from the percentage. |
| `CC 7d ∞ · 3d 5h` | window or credits without a limit | default | No bar and no pace: there is no denominator to divide by. |
| `CC 5h ▁▁▁▁▁▁▁▁ reset due` | the reset has passed, no newer reading yet | `tokenPace.stale` | A new reading is fetched shortly after the reset. The gauge is never set to 0 by us. |
| `… $(history) 42m` | the reading is older than `staleAfterMinutes` | `tokenPace.stale` | Fetch now from the tooltip, or check the source in the tooltip's freshness line. |
| `CC extra $12.00 of $50.00 · 24 %` | extra usage / prepaid credits | `charts.blue` | A separate pot; it is never folded into the plan windows. |
| `CC extra off (never enabled)` | extra usage exists but is switched off | `tokenPace.stale` | A disabled allowance is stated, never drawn as "0 % used". The reason in brackets is the provider's own (`never enabled`, `switched off`, or its `disabled_reason`); with none it reads plain `off`. |
| `CC $(graph) 5h ~empty in 40m` | forecast item (`statusBar.show` contains `forecast`) | default | Estimate — it carries `~`. It disappears when there is nothing to measure. |
| `Σ 4.6M` / `Σ 12.3M · 7d` | tokens for `summary.period` and `summary.scope` | default | Fresh input + cache write + output; cache reads are listed separately in the tooltip. |
| `$(sync~spin) reading history …` | the token item during a cold scan | default | The figures are still growing; they are not a total yet. |
| `~$1.23` / `~$12.30 · 7d` | hypothetical API cost | default | Estimate. `⚠` appended means some tokens have no price and are missing from the sum. |
| `–` (cost item) | exactly zero | default | Absence is a dash, never `$0.00`. |
| `TP 69% ▲` | `density: minimal`, the worst window of all shown providers | worst level | The tooltip lists every provider and window. |
| `CC 25%·2h14m \| 69%·6d` | `density: compact`, one item per provider | worst level | The worst window decides the colour; the tooltip keeps the per-window detail. |

## Problem states

`ok: false` replaces the figure with a named cause. The click performs the repair step for
that cause instead of the configured `clickAction`, and the tooltip repeats the check.

| Text | Cause | Click runs | Check |
|---|---|---|---|
| `$(key) CC no token` | no credentials found | Show Log | Sign in to the CLI, or set `CLAUDE_CODE_OAUTH_TOKEN`. The log names the lookup that failed — never the token. |
| `$(warning) CC token expired` | stored credentials past their expiry | Show Log | Sign in again; the next poll picks the new token up. Token Pace never refreshes a token itself. |
| `$(shield) CC consent` | network consent not granted yet | Fetch Quota Now (which asks) | One dialog, one answer, remembered. Until then nothing leaves the machine. |
| `$(clock) CC retry 12m` | last attempt failed, backoff running | Fetch Quota Now | The countdown is the scheduled next attempt. The log holds the reason; clicking retries now. |
| `$(cloud-offline) CC offline` | timeout, DNS or proxy error | Fetch Quota Now | Connectivity and `http.proxy`. Copy Diagnostics lists the proxy settings in effect. |
| `$(circle-slash) CC quota off` | no quota source enabled, or `quotaSource: cache` | Open Settings | `claudeQuotaSources` / `codexQuotaSources`, or point `claudeQuotaFile` at a cache file. |
| `$(lock) CC 403` | provider refused the usage endpoint | Open Official Usage Page | May mean a Team/Enterprise account without a usage endpoint. Token counts keep working. |
| `$(key) CC sign in` | provider rejected the credentials (401) | Show Log | Sign in again in the CLI. |
| `$(circle-slash) CDX no codex` | the Codex CLI was not found | Open Settings | `tokenPace.codexBinary`, or install the CLI. |
| `CC –` (noFile) | the configured cache file does not exist | Open Settings | `claudeQuotaFile` / `codexQuotaFile`, or enable another source. |
| `$(clock) CC paused` | the external quota writer paused itself: `blocked_until` in the cache file is still in the future | Fetch Quota Now (does nothing in `quotaSource: cache`) | Nothing here is broken — the figure returns when the writer resumes. The time it named is on the tooltip's *Reported* line. |
| `CC –` (follower) | another VS Code window holds the lease and polls | Open Dashboard | Nothing to do. `leaderElection: false` makes every window poll on its own. |
| `CC –` (empty) | the source answered but carried no readable window | Re-read History | Unknown window kinds are reported in the log and the data-quality section, not dropped. |
| `CC –` (unknown) | no reading, no named cause | Fetch Quota Now | The log holds the raw reason. |

At `density: compact` and `minimal` the problem item is **not** folded away: a named cause
is the whole point, and the provider label has to stay readable.

## Tooltip

`tokenPace.tooltip` decides how much of it is built:

* **full** — title (a link to the provider's usage page unless `usagePageLinks` is off),
  the window table `Window | Used | Elapsed | Pace | Resets`, a forecast line per window
  that has one, the `windowSelect: auto` explanation, extra usage, the freshness line, the
  token tables for today / 7 days / 30 days, the composition and cache-hit line, the
  provenance line, the explanations (`tooltipExplanations`) and the action footer.
* **compact** — title, table, freshness, footer. At most twelve lines.
* **off** — no tooltip at all.

Footer links are `$(sync) Fetch now`, `$(history) Re-read`, `$(output) Log`,
`$(settings-gear) Settings`, `$(dashboard) Dashboard`. Only this extension's own
argument-less commands are ever linked, and a link that would do nothing in the current
state — Fetch now while consent is denied, `quotaSource: cache`, or while another window
polls — is rendered as plain text instead of pretending.

## Click

Without a problem, a click runs `tokenPace.clickAction`:

| Setting | Command |
|---|---|
| `dashboard` | `tokenPace.showDashboard` |
| `menu` (default) | `tokenPace.menu` — a QuickPick with every action, including the ones the current state cannot perform, each saying why |
| `refresh` | `tokenPace.refreshQuota` |
| `openWebsite` | `tokenPace.openUsagePage` with the item's provider |

## Preview

**Token Pace: Preview Status Bar States** renders synthetic versions of every state above
into their own `tokenPace.preview.*` items, each marked `[preview]`, using your current
format settings. It ends after 60 seconds, on a click, or when the command is run again.
It reads no file, writes no file, and never mixes with the real items — the preview is a
rendering of made-up data and says so.
