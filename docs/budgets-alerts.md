<!--
SPDX-FileCopyrightText: 2026 Frederik Marx
SPDX-License-Identifier: AGPL-3.0-or-later
-->

# Budgets and alerts

Part of the [Token Pace documentation](../README.md#documentation).

## Budgets

`tokenPace.budgets` is a list of limits **you** state; nothing here is derived from a plan, a
quota window or a price list. Each entry names a scope (`total`, `claude`, `codex`), a period
(`day`, `week`, `month`), a unit (`usd`, `tokens`) and your own `limit`, plus an optional
`label`:

```json
"tokenPace.budgets": [
  { "scope": "total",  "period": "month", "unit": "usd",    "limit": 200 },
  { "scope": "claude", "period": "day",   "unit": "tokens", "limit": 5000000, "label": "Daily cap" }
]
```

* **`usd` is the hypothetical API equivalent, not a bill.** On a subscription you do not pay
  these amounts. Unpriced models make the spend — and therefore the share — a **lower bound**,
  marked `⚠`, exactly like the API cost column.
* **A budget is only ever compared with itself.** A token budget and a money budget are two
  different questions, so their raw values are never added, averaged or ranked against each
  other. Only their shares — a fraction of *your* limit — can be compared, which is what the
  status bar entry `budget` uses to pick the one closest to running out.
* **A period with no local data shows a dash**, not 0 %. The figures come from the transcripts
  Token Pace has ingested, and a budget at “0 %” would claim a quiet week where the history may
  simply not have been read yet.
* **A budget nothing can measure keeps its row and says so.** A `usd` budget while
  `tokenPace.showCost` is off has nobody counting it: every figure on the row is a dash and
  the line names what is in the way. It is never removed, because a missing row would let the
  panel answer “No budget configured” to a settings file that plainly configures one.
* **The projection is the same rule as the calendar card's**: the average per *elapsed* day,
  silent below five active days and on the last day of the period, and always marked `~`.
* Periods use your own `tokenPace.timezone`, `tokenPace.dayBoundaryHour` and
  `tokenPace.startOfWeek`. The bounds are printed with every row.
* An entry with an unknown scope, period or unit, or without a finite limit above zero, is
  dropped **whole** rather than repaired — a defaulted limit would be a number Token Pace
  invented. At most 20 budgets, one per scope × period × unit.
* The `budget` dashboard section is off by default; the same rows appear in the Quick Pick
  list, in the markdown document and in *Copy usage summary*.

`tokenPace.alerts.budgetPercent` (default `0` = off) notifies **once per period** when a budget
passes that percentage of its own limit — upwards only, and never while the first read of the
transcript history is still running.

## Alerts

**One threshold out of the box: `tokenPace.alerts.thresholds` is `[90]`.** A window that crosses
90 % while it is also ahead of pace, more than an hour before its reset, and from a reading that
is not stale, produces one notification. **Emptying the list switches notifications off
entirely.** A quota warning is only worth anything if it is rare, so every rule is deliberately
quiet:

| Rule | Setting | Fires when |
|---|---|---|
| Threshold | `alerts.thresholds` (default `[90]`, e.g. `[80, 95]`), `alerts.basis` | A window crosses a configured percentage upwards. Crossing 80 and 95 in one step produces **one** message, not two |
| Only when ahead | `alerts.requireAhead` (default on) | Reaching 80 % of a weekly window on day six is not news; on day two it is |
| Too late to matter | `alerts.minRemainingMinutes` (default 60) | Suppresses a warning about a window that resets within the hour |
| Pace flip | `alerts.onPaceFast` (default off) | A window changes from on pace to ahead of pace — once per cycle |
| Forecast | `alerts.forecastLeadMinutes` (default 0 = off) | The forecast expects the window to run out within *n* minutes. An estimate, labelled `~`, silent right after a reset, and never when the window resets before it would run out |
| Use it or lose it | `alerts.useItLoseIt` (default off) | A weekly window below 60 % that resets within two days — unused allowance does not carry over |
| Which windows | `alerts.windowCondition` | `any`, `sessionOnly` or `weeklyOnly` |

Hygiene that applies to all of them:

* The identity of an alert is the window **and its reset time**, so a new cycle is a new subject
  and the same cycle can never speak twice.
* Only an escalation speaks: a higher threshold than the one already announced, a pace that just
  flipped, a one-off notice.
* **Nothing ever fires from a stale reading**, or from a reading of unknown age. An old
  percentage crossing a threshold is an artefact, not news.
* Several thresholds broken at once become one message per provider.
* The state is persisted *before* the notification is shown, so a window closed while the popup
  is open does not produce the popup again.
* Every notification offers **Open Dashboard** and **Not today**; the latter silences everything
  until the next local midnight.
