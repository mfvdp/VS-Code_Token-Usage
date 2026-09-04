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
| 🟡 yellow ▲ | ahead of pace beyond the tolerance (5 % by default) |
| 🟠 amber ▲▲ | more than three times the tolerance ahead — only with `pace.levels: graded` |
| 🔴 red | the window is spent (≥ 99.5 %); the entry also gets an alarm background |

The `┃` marker sits where the window's own clock stands, so the verdict is readable
without colour. The tooltip says it in words: `12 % ahead of pace`,
`36 % of the window still spare`, `measuring · window just reset`.

Absence is a dash. A missing figure is never drawn as `0 %` or `$0.00`.
