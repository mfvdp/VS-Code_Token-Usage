<!--
SPDX-FileCopyrightText: 2026 Frederik Marx
SPDX-License-Identifier: AGPL-3.0-or-later
-->

### What an entry is made of

```
[state glyph] LABEL WINDOW [bar] VALUE [indicator] [· reset] [$(history) age]
   $(warning)   CC    5h   ██┃▁▁▁▁▁  25%     ▲        · resets 2h14m   $(history) 12m
```

```
CC 5h ██┃▁▁▁▁▁ 25% · resets 2h14m
CC 7d █████┃▁▁ 69% ▲ · resets 4d 6h
CDX 5h ███┃▁▁▁▁ 33% · resets 1h05m
Σ 2.6M · today          ~$1.23 · today
```

### The colours

| | |
|---|---|
| 🟢 green | at or below the elapsed share — on pace, or spare left over |
| 🟡 yellow ▲ | ahead of pace, from the first whole percent — beyond the tolerance band, if you set one (`pace.tolerancePoints`, 0 by default) |
| 🟠 amber ▲▲ | 15 % or more ahead — three times the band, at least 15 — only with `pace.levels: graded` |
| 🔴 red | the window is spent (≥ 99.5 %); the entry also gets an alarm background |

The `┃` marker sits where the window's own clock stands, so the verdict is readable
without colour. The tooltip says it in words: `12 % ahead of pace` or
`36 % of the window still spare`; a window that has only just reset is still measuring, and
its Pace cell is a dash until the phase ends.

Absence is a dash. A missing figure is never drawn as `0 %` or `$0.00`.

A reading that is stale because a fetch of Token Pace's own failed says when the next attempt
is — `CC 5h ██┃▁▁▁▁▁ 25% · resets 2h14m $(history) 2h · $(clock) retry 1h12m`, then `retry due` —
in the grey of a stale reading, never as an alarm. The dashboard's provider switch changes nothing
on the bar.

`agents` in `tokenPace.statusBar.show` — off by default — adds `~3 running` while Claude Code
agents run: inferred from their transcripts, so marked `~`, with no colour and no alarm.

`cache` — off by default as well — adds `$(watch) cache 4m` in the last five minutes of a Claude
Code session's one-hour prompt cache, `~4m` when the expiry is estimated from the session's
transcript; hidden while no cache is cooling, never in colour.

The opt-in keep-warm line (`tokenPace.cacheKeepWarm`, off by default, with its own consent) has an
item of its own whatever `statusBar.show` lists: `$(watch) keep warm in 42 s · cancel`. A click
cancels the line; type nothing into the Claude terminal while it counts down.
