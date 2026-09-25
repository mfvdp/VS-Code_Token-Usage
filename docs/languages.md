<!--
SPDX-FileCopyrightText: 2026 Frederik Marx
SPDX-License-Identifier: AGPL-3.0-or-later
-->

# Languages

Part of the [Token Pace documentation](../README.md#documentation).

Token Pace's own texts — the status bar and its tooltips, the dashboard, the Quick Pick, the
markdown document, notifications and dialogs — come in fourteen languages: English and German, and
since 1.9.0 twelve more. You choose one with the flag at the top of the dashboard or with the setting
`tokenPace.language`; `auto`, the default, follows VS Code's display language.

## The picker and the setting

**The flag.** The dashboard's top row holds the provider switch — *Claude Code · Codex · All* — and,
at its end, a button with the flag of the language the texts are in now: the US flag for English.
Its tooltip says what the picker can switch and what it cannot (below). Where the row is too narrow
for both, the flag moves onto a line of its own under the switch, at its right end; the switch's
buttons stay on one line.

**The list.** A click on the flag — or Enter, Space, ↓ or ↑ on it — opens the list: *Automatic*
first, then every language this build ships a translation for, in the order of the table below. Each
line shows the language's flag, its own name, and — where the two differ — its name in the language
you read now (*Deutsch* · German). *Automatic* says what it would show: *Automatic — as VS Code
(English)*, or, when Token Pace has no translation for VS Code's language, *Automatic — VS Code's
language (hu) has no translation here, so English*. The chosen line carries a ✓. Under the list stand
two lines: what switches at once and what follows VS Code — *Token Pace's own texts switch at once. The
settings, the command titles and the walkthrough follow VS Code's display language (Configure Display
Language).* —, and who translated the languages — *The languages beyond English and German were
translated by AI agents and checked by tests, not by native speakers.*

**The keyboard.** In the list ↓ and ↑ move (from the last line to the first and back), Home and End
go to the first and the last, Enter or Space chooses, Escape closes it and puts the focus back on the
flag, Tab closes it without a choice. Nothing is chosen by moving. A screen reader hears the button
as a menu button named "Language: English (automatic)" — "Language: English" once you chose English
—; the flag itself is decoration and is not announced. Each line is heard by its name, the language's
own name in its own voice where the screen reader has one. In a German window the button is named
„Sprache: Deutsch (automatisch)" and the first line reads *Automatisch — wie VS Code (Deutsch)*. After
a choice the focus is back on the flag, which is then named in the new language; a switch made elsewhere — in the settings UI, or in
another window — puts the focus back where it was on the page.

**The setting.** A choice writes `tokenPace.language` into your user settings, the way *Cycle Status
Bar Windows* writes `tokenPace.windowSelect` — only on that click, only that key, and never into a
workspace's settings: the setting has application scope, so a cloned repository's
`.vscode/settings.json` cannot switch your language. *Automatic* removes the key again; the line that
is already chosen writes nothing. If VS Code cannot write your `settings.json`, a warning says so and
nothing changes. The setting can be set in the settings UI as well — `auto` or one of the ids of the
table, each offered with its own name; any other value (another case, a path) counts as `auto`, and
the log says so. A setting that names a language the installed build carries no translation file for
shows English, and the list then checks no line. See [Settings](settings.md).

## `auto`

`auto` takes the display language VS Code reports (*Configure Display Language*), in lower case.
**VS Code reports a display language only while its language pack is installed**: without the pack
it reports English — a window started with `--locale=pt-br` and no Portuguese language pack reports
`en` —, so `auto` shows English there, and the list's first line says *Automatic — as VS Code
(English)*. Choosing *Português (Brasil)* in the list shows Portuguese all the same: the picker needs
no language pack. Where Token Pace has the language VS Code reports, it is shown; otherwise the tag
loses its last part, again and again — `de-ch` becomes `de` — which is the rule VS Code itself applies
to the settings' own texts, so the texts and the settings UI agree; and where nothing is left, the
texts are English. `pt-pt` therefore gets English: Token Pace has Brazilian Portuguese, `pt-br`, but
no `pt`. VS Code 1.138 hands a regional display language over as the language of its pack — a window
started with `--locale=de-ch` and the German pack reports `de` —, so a Swiss German window shows
German.

Under `auto` the numbers and dates follow the tag VS Code reports, as they did before 1.9: a display
language Token Pace has no translation for keeps its own number and date formats, with English words.
A language you choose formats as that language does.

## What switches at once, and what cannot

**At once, without a reload**: the dashboard — every section, the provider switch, the picker, the
page's own words, its numbers and dates — keeping its scroll position and the keyboard focus; the
status bar's texts, tooltips and accessible names, the keep-warm countdown among them; the markdown
document and the agent hook's setup document while they are open; and from then on every Quick Pick,
notification, dialog and consent text.

**Not with the picker:**

* **The manifest.** The settings UI, the command titles in the Command Palette, the view's and its
  container's names, the walkthrough's titles and the Extensions view's name and description follow
  VS Code's display language: VS Code reads them from `package.nls.<language>.json` when it starts and
  offers an extension no way to have them read again. So with VS Code in German and the picker on
  Français, the settings are German and everything Token Pace draws is French. *Configure Display
  Language* — which restarts VS Code — changes them. The walkthrough's three step pages are English in
  every language.
* **What is open at that moment.** A Quick Pick, a modal dialog or a notification keeps the language
  it was opened in until it closes; VS Code gives no way to rewrite one.
* **The words of the last failed attempt.** When Token Pace's own quota fetch fails, the reason is
  written down in the language of that moment and kept; it stays in that language until the next
  attempt. Every reading that can be made again is made again at the switch.
* **What stays English on purpose**: the debug log, the diagnostics report and the CSV and JSON
  exports — they are pasted into issues and have to be readable by a maintainer —, the keep-warm line
  and the terms passage the keep-warm consent quotes, command and setting ids, codicon names and
  product names.

## The fourteen languages

| Id | Language | In English | Flag |
|---|---|---|---|
| `en` | English | English | United States (`us`) |
| `de` | Deutsch | German | Germany (`de`) |
| `fr` | Français | French | France (`fr`) |
| `es` | Español | Spanish | Spain (`es`) |
| `pt-br` | Português (Brasil) | Portuguese (Brazil) | Brazil (`br`) |
| `it` | Italiano | Italian | Italy (`it`) |
| `ja` | 日本語 | Japanese | Japan (`jp`) |
| `ko` | 한국어 | Korean | South Korea (`kr`) |
| `zh-cn` | 简体中文 | Chinese (Simplified) | China (`cn`) |
| `zh-tw` | 繁體中文 | Chinese (Traditional) | Taiwan (`tw`) |
| `ru` | Русский | Russian | Russia (`ru`) |
| `tr` | Türkçe | Turkish | Türkiye (`tr`) |
| `pl` | Polski | Polish | Poland (`pl`) |
| `cs` | Čeština | Czech | Czechia (`cz`) |

The id is the setting's value and VS Code's own name for the display language. The picker offers the
languages whose translation file the installed build carries. English and German were there before;
the other twelve — Français, Español, Português (Brasil), Italiano, 日本語, 한국어, 简体中文, 繁體中文,
Русский, Türkçe, Polski and Čeština — are new in 1.9.0.

**A flag is not a language.** The name always stands beside the flag, and a screen reader does not
announce the flag. English carries the US flag because the author chose it — its words are spelled
the British way (*colour*, *realised*), so the list calls it *English*, not *English (US)* —, Spanish
carries Spain's, Brazilian Portuguese Brazil's, and the two Chinese entries carry China's and
Taiwan's. The flags are small drawings shipped inside the extension, so they look the same on every
system — Windows' emoji font draws no flags — with no font and no download; in a High Contrast theme
they keep their colours and get an outline.

## Numbers, dates and times

Where Token Pace formats a figure, the language decides the digits, the decimal mark and the
grouping — German writes `2,8M` and `1.234.567`, French groups thousands with a narrow space and writes
a decimal comma, Japanese and Chinese write `2.8M` and `1,234,567` as English does —, and the names of
weekdays and months. The hour cycle of a clock time stays what `tokenPace.resetHourCycle` or your
system says. The weekday in front of a clock time is the language's own short name — `lun.`, `pon.`,
`Pzt`, `seg.`, `月`, `周一` —; English and German keep their two letters (`Mo 06:00`, `Sa 14:20`), which
the settings' own examples quote. The day of a sparkline's hover label is weekday, day and month
(`Sat 26 Sep`, `sam. 26 sept.`), and where a language writes the month as a number — Japanese, Chinese,
Czech — it is that language's own short date (`9月26日(土)`, `9月26日周六`, `so 26. 9.`). The calibration's
figures take the language's decimal mark (`1,2` in German and French).

**The same in every language** — these are the bar's and the page's own notation, not words: the
countdowns `45m`, `2h14m`, `3d 5h`, `<1m` and `4 m 10 s`; the units inside `2 h 14 min`, `3 d 5 h` and
`12 min` (the words around them are translated: *3 min ago*, *in 2 h 14 min*); the suffixes `K`, `M`
and `G`; the `$` in front of an amount and `<$0.01`; the `%` in the bar; the bar's glyphs (`█┃▁`,
`▲`, `Σ`) and the codicons; the ISO day `2026-09-01`; `1 h TTL`; and the marks `~` (an estimate), `⚠`
and `≈` (a lower bound) and `–` (nothing known).

## How the translations were made

English is the source: every text is written in English first, and the German — the manifest since
1.2, every text since 1.3 — is translated with the code. The twelve languages beyond English and German were translated by AI agents
(Claude Opus 5.5) from the English text, with the German as a second reference, and checked by tests
for completeness, placeholders and the marks `~`, `⚠`, `≈` and `–` — they were **not reviewed by
native speakers**. The tests hold every language to the same rules: every text translated, every
placeholder and mark kept, no code, setting or command name translated, no English sentence left
behind, no exclamation mark; they cannot tell a good word from a clumsy one.

A wrong or clumsy word is a bug — please report it on the
[issue tracker](https://github.com/mfvdp/VS-Code_Token-Usage/issues), with the language, the text you
saw and where you saw it (the status bar, a section of the dashboard, a dialog).

## Adding a language

A language is a registry entry, four part files, a manifest translation and a freshness record, held
to the same tests as every other — see [Building and testing](development.md#translating).
