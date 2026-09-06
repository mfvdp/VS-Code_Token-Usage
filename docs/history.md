<!--
SPDX-FileCopyrightText: 2026 Frederik Marx
SPDX-License-Identifier: AGPL-3.0-or-later
-->

# History and forecasts

Part of the [Token Pace documentation](../README.md#documentation).

With `tokenPace.quotaHistoryDays` above 0 (default **30**), each real quota reading is appended
to `quotaHistory.json` in the extension's `globalStorage`: source, window id, timestamp, percent,
reset time, origin and an account fingerprint. That series is what makes burn rate, sparklines,
forecasts and the reset retrospective possible. Setting it to `0` disables the history, and with
it the sparklines, the forecast line and the `history` section.

* **Write guard.** Only an actual reading is stored — a poll answer, a push, or a file whose
  `fetchedAt` moved. A state replayed from memory (a redraw, a mode switch, a follower reloading
  the snapshot) is not a measurement and does not become a sample. A sample that repeats the
  previous percent and reset is dropped, unless more than six hours have passed: then it is the
  evidence that the gap ended.
* **Identity.** Streams of different accounts never mix. The fingerprint is derived from the
  hashed account uuid in `~/.claude.json` where that is readable, otherwise the plan type — and
  for Codex from the plan type plus the set of limit ids. Never from the token.
* **Merging, not overwriting.** Several windows share one file, so a save re-reads it, unions the
  samples and writes atomically; last-writer-wins would throw away what the other window saw.
* **Thinning.** The series is kept on the sparkline's own grid: inside the last seven days one
  reading per window per quarter hour (the newest of the slot), one per hour beyond that. The
  last reading before a reset and the first one after it are always kept, as are the first
  reading of the series, the peak of every cycle and a third reading of a cycle that would
  otherwise drop below three, so the reset history, its `complete` flags and the forecast fits
  are the same before and after thinning. Seven windows come to about 4.7 k samples a week,
  8.6 k at 30 days and 18.7 k at 90 — under the hard cap of 20 k.
* **Gaps are drawn across.** The sparkline covers seven days on a time-proportional axis, so a
  stretch without readings is exactly as wide as the time nobody measured, and the line runs
  straight from the last reading before it to the first one after; the number of such gaps in
  the last 24 h is counted in the copied summary. Where the window turned over and the value
  fell, the line holds the old value in its old colour up to the moment the old window ended
  — the reset the last reading before the turn announced, when it lies between the two
  readings, otherwise the first reading after the turn — and drops there vertically, in the
  neutral provider colour, to the new reading's value: never to a 0 nobody measured, and never
  as a slope across the hours VS Code was closed. A rise across a turn-over is an ordinary
  stroke. Every other stroke wears the pace colour of its later reading. Hovering a reading,
  or stepping through them with ← and → once the sparkline has the focus, names its day, time
  and percentage — and `reset` when the window turned over before it.
* **Cycles.** A cycle ends when the window turned over: the provider announces a different
  reset time, the percentage falls by five points or more without one, or the reset time it
  announced has passed and the percentage fell after it — how a pinned Codex window that never
  reached five points ends. Reset times within half a minute of each other are the same reset
  — Claude Code's usage cache writes the time with sub-second jitter — and the reset time of
  an idle rolling window, which merely rides along with the clock, has not moved either. A
  rise too steep to come from usage is treated as the limit being re-based: the cycle
  continues, but the rate fit restarts.
