<!--
SPDX-FileCopyrightText: 2026 Frederik Marx
SPDX-License-Identifier: AGPL-3.0-or-later
-->

# Status bar

Part of the [Token Pace documentation](../README.md#documentation).

## What an entry is made of

```
[state glyph] LABEL WINDOW [bar] VALUE [indicator] [· resets …] [$(history) age]
   $(warning)   CC    5h   ██┃▁▁▁▁▁  25%     ▲      · resets 2h14m   $(history) 12m
```

* **Entries.** `tokenPace.statusBar.show` is an ordered array of `claudeQuota`, `codexQuota`,
  `extra`, `context`, `tokens`, `cost`, `forecast`, `budget`. The array order is the display
  order (drag the rows in the settings UI); the order *inside* one entry is fixed. An empty
  list hides the status bar entirely. `context` is off by default and appears only while the
  Claude Code status line is connected — it is one session's context window, never an account
  figure. `budget` is off by default too and shows the configured budget closest to its own
  limit (`budget 63 %`, `budget ~63 %` for a money budget, `budget 118 % over`); the tooltip
  lists all of them.
* **Density.** `full` (default) gives every window its own entry, `compact` folds a provider's
  windows into one item (`CC 25%·2h14m | 69%·6d`), `minimal` folds every provider into a
  single `TP 69% ▲`. Problem states are never folded — a named cause is the point.
* **Window selection.** `tokenPace.windowSelect`: `worstPace` (the worst pace verdict, and within
  one verdict the most-utilised of those windows — the default, so each tool contributes exactly
  one entry), `all` (every window, up to nine entries), `leading` (the most-utilised window per
  tool), `session`, `weekly`, or `auto`. **The `auto` rule:** session windows only, unless *every*
  session window is below **30 %**, in which case every window is shown. The tooltip states
  what `auto` decided and why. A filter that would match nothing falls back to the full list.
  *Token Pace: Cycle Status Bar Windows* steps through the values without opening settings.
* **Bar.** `barWidth` (0–20, default 8; `0` leaves the percentage), `barStyle` (`line` /
  `shade` / `none` — how the *empty* part is drawn), `barGlyphs` (`blocks`, `shapes`, `dots`,
  `pie`). All four glyph sets exist because block elements are not shipped in every status bar
  font; each set stays inside one Unicode block so the bar cannot jitter between fallbacks —
  which is also why `line` and `shade` differ only for `blocks`: `shapes` and `dots` draw their
  own empty glyph (`□`, `○`), `pie` has no empty part, so there only `none` changes anything.
* **Time marker.** `timeProgressStyle`: `marker` (the `┃` sits where the window's own clock
  stands — needs a width of at least 6), `bar` (a second track underneath), `none`. This is
  what makes pace readable **without colour**: fill left of the marker is reserve, fill right
  of it is ahead of pace.
* **Indicator.** `tokenPace.indicator` decides whether the verdict is signalled by `color`,
  `glyph` (`▲` / `▲▲`), `both` (default) or `none`. Colour alone is invisible to red-green
  colour blind readers and disappears in themes that tint the whole status bar.
* **Remaining mode.** `percentMode: remaining` turns the number into what is left and mirrors
  the bar; the choice is carried through item, bar direction, tooltip header and legend.
  `used` is rounded, `remaining` is floored, so neither mode ever claims headroom that is not
  there.
* **Countdown.** `resetFormat`: `none`, `relative` (`45m`, `2h14m`, `3d 5h`), `absolute`
  (`06:00`, with a weekday prefix beyond a day), `both`. `resetHourCycle` picks 12- or
  24-hour, `auto` follows the OS locale. The countdown is always introduced by the word
  `resets` — a bare `· 2h14m` would read like the age suffix, and the two move in opposite
  directions. A window whose provider states no reset time gets **no** countdown, ever.
* **Age.** `showAgeInItem`: `never`, `whenStale` (default), `always`. The age is recomputed at
  every redraw, so it never freezes at the value it had when it was fetched. A reading older
  than `staleAfterMinutes` (default 20) is greyed with `tokenPace.stale`, marked in the
  tooltip, loses its alarm background, and may not raise an alert.
* **Labels.** `tokenPace.labels` overrides the provider prefix (`claude`, `codex`, and
  `summary` for the collective item) or a single window by its id — `session:300`,
  `weekly_all:10080`, `weekly_scoped:10080:fable`, `codex:300`, `codex:10080`. Values are cut
  at 40 characters. Labels *we* derive are shortened to `labelMaxChars`; a label you set
  yourself is never shortened.

## Special states

| Text | Meaning |
|---|---|
| `$(warning) CC 5h ██████┃█ 100% exhausted · resets 47m` | exhausted (≥ 99.5 %) — alarm background; the state is also said in words, because the icon and the background can both be switched off, and every countdown is named `resets`, so it can be read neither as a percentage nor as the reading age |
| `⛔ CC 5h ████████ 100% limit reached` | the provider itself reports the limit as reached — a flag, not a derivation |
| `CC 5h ████████ 111%` | above 100.5 %: usage billed beyond the plan. `overflowDisplay: clamp` shows `100%` instead — the figure is real, not a rounding error |
| `CC 7d ∞ · resets 3d 5h` | a window or credit pot without a limit: no bar and no pace, because there is no denominator |
| `CC 5h ▁▁▁▁▁▁▁▁ reset due` | the reset has passed and no reading newer than it has arrived. The gauge is never set to 0 by us; a re-poll is scheduled instead |
| `CC extra $12.00 of $50.00 · 24 %` | extra usage, in its own blue |
| `CC $(graph) 5h ~empty in 40m` | the forecast entry — an estimate, and it carries `~` |
| `Σ 4.6M · today` / `Σ 12.3M · 7d` | tokens for `summary.period` and `summary.scope`; the period is always named |
| `~$1.23 · today ⚠` | hypothetical API cost; `⚠` means some tokens have no price and are missing from the sum |
| `$(shield) CC consent`, `$(key) CC no token`, `$(cloud-offline) CC offline`, … | a named cause replaces the figure, and the click performs the repair for *that* cause |

The full matrix — every text, which state wins, which colour, and the one thing to check —
is [status-bar-states.md](status-bar-states.md).

## Clicking

`tokenPace.clickAction` is `dashboard` (default), `menu`, `refresh` or `openWebsite`. In a
problem state the click always performs the repair step for that cause instead — the table in
[If the bar says …](troubleshooting.md) lists which. *Token Pace: Show Actions Menu* is a
QuickPick with every action, including *Show usage as text (Markdown)*; an action the current
state cannot perform stays in the list and says why
(`disabled: another VS Code window holds the lease and polls`) rather than disappearing.

## Tooltip

`tokenPace.tooltip`: `full`, `compact` (title, window table, freshness, footer — at most
twelve lines) or `off`. The full tooltip carries the window table
`Window | Used | Elapsed | Pace | Resets`, a forecast line per window that has one, the `auto`
explanation, extra usage, the freshness line (`Updated 3 min ago · cache file`), token tables
for today / 7 days / 30 days, the composition and cache-hit line, a provenance line
(`measured: quota, tokens · estimated: ~API cost`), the explanatory paragraphs, and the action
footer. `tooltipExplanations` is **off** by default — the paragraphs are worth reading once,
not on every hover; `true` brings them back. The uncertainty markers (`~`, `⚠`) and the
provenance line are never hidden by it.

When the Claude status-line bridge is connected, one further row states the prompt cache that
status line last reported — warm or cold, its TTL, the countdown to its expiry and the hit
ratio, each part a `–` where the reading did not carry it. Without the bridge the row is absent
rather than estimated: the token buckets know what was read from the cache, not whether the
cache is still alive.

Only this extension's own argument-less commands are ever linked from the tooltip, and a link
that would do nothing in the current state — *Fetch now* while consent is denied, in
`quotaSource: cache`, or while another window polls — is rendered as plain text instead of
pretending.

## Colours

Four contributed theme colours, overridable in `workbench.colorCustomizations`:

```jsonc
"workbench.colorCustomizations": {
  "tokenPace.paceOk":    "#89D185",  // on pace, or spare left over       (dark default)
  "tokenPace.paceWarn":  "#CCA700",  // ahead of pace (beyond the band, if one is set)
  "tokenPace.paceAhead": "#D18616",  // second level, only with pace.levels: graded
  "tokenPace.stale":     "#8B8B8B"   // reading older than staleAfterMinutes
}                                    // stale defaults to descriptionForeground
```

Each colour ships a default for all four theme variants; the values above are the dark ones,
except `tokenPace.stale`, which follows the theme's `descriptionForeground` unless you set it.

`colorMode: monochrome` drops the colours entirely and leaves the signal to the glyphs. The
alarm background of an exhausted window is not a colour setting and stays either way.

## Previewing

**Token Pace: Preview Status Bar States** renders synthetic versions of every state into their
own `tokenPace.preview.*` items, each marked `[preview]`, using your current format settings —
so a glyph set or a bar width can be judged without waiting for the state to happen for real.
It ends after 60 seconds, on a click, or when the command is run again. It reads no file,
writes no file, and never mixes with the live items.
