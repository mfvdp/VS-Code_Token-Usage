<!--
SPDX-FileCopyrightText: 2026 Frederik Marx
SPDX-License-Identifier: AGPL-3.0-or-later
-->

# Languages

Part of the [Token Pace documentation](../README.md#documentation).

Token Pace's own texts — the status bar and its tooltips, the dashboard, the Quick Pick, the
markdown document, alerts, notifications and dialogs — come in twenty-six languages: English and
German, and since 1.9.0 twelve more — Français, Español, Português (Brasil), Italiano, 日本語, 한국어,
简体中文, 繁體中文, Русский, Türkçe, Polski and Čeština —, and since 1.11.0 twelve more again — Nederlands,
Українська, Svenska, Norsk, Dansk, Suomi, हिन्दी, Bahasa Indonesia, Tiếng Việt, Ελληνικά, Magyar and
Română. You choose one with the flag at the top of the dashboard or with the setting
`tokenPace.language`; `auto`, the default, follows VS Code's display language.

## The picker and the setting

**The flag.** The dashboard's top row holds the provider switch — *Claude Code · Codex · All* — and,
at its end, a button with the flag of the language the texts are in now: the US flag for English.
Its tooltip says what the picker can switch and what it cannot (below). Where the row is too narrow
for both, the flag moves onto a line of its own under the switch, at its right end; the switch's
buttons stay on one line.

**The list.** A click on the flag — or Enter, Space, ↓ or ↑ on it — opens the list: *Automatic*
first, then every language this build ships a translation for, in the order of the table below —
twenty-seven lines. Each line shows the language's flag, its own name, and — where the two differ —
its name in the language you read now (*Deutsch* · German). *Automatic* says what it would show:
*Automatic — as VS Code (English)*, or, when Token Pace has no translation for VS Code's language,
*Automatic — VS Code's language (bg) has no translation here, so English*. The chosen line carries
a ✓. A list taller than the window scrolls inside its box, the two lines under it staying in view:
what switches at once and what follows VS Code — *Token Pace's own texts switch at once. The
settings, the command titles and the walkthrough follow VS Code's display language (Configure Display
Language).* —, and who translated the languages — *The languages beyond English and German were
translated by AI agents and checked by tests, not by native speakers.*

**The keyboard.** In the list ↓ and ↑ move (from the last line to the first and back), Home and End
go to the first and the last, Enter or Space chooses, Escape closes it and puts the focus back on the
flag, Tab closes it without a choice. Nothing is chosen by moving. Typing a letter — without Ctrl, Alt
or ⌘ — moves the focus to the next line after the focused one whose own name or name in your language
begins with it, round the list: on an English page `h` reaches *हिन्दी* (Hindi), then *Magyar*
(Hungarian); a letter no name begins with moves nothing, and typing chooses nothing either — Enter or
Space does. A screen reader hears the button as a menu button named "Language: English (automatic)" —
"Language: English" once you chose English —; the flag itself is decoration and is not announced.
Each line is heard by its name, the language's own name in its own voice where the screen reader has
one. In a German window the button is named „Sprache: Deutsch (automatisch)" and the first line reads
*Automatisch — wie VS Code (Deutsch)*. After a choice the focus is back on the flag, which is then named
in the new language; a switch made elsewhere — in the settings UI, or in another window — puts the
focus back where it was on the page.

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

**Which languages VS Code can report.** Microsoft ships a language pack for each display language VS
Code itself comes in. Of Token Pace's twenty-six that is German, French, Spanish, Brazilian
Portuguese, Italian, Japanese, Korean, Simplified and Traditional Chinese, Russian, Turkish, Polish,
Czech and — of the twelve of 1.11.0 — Hungarian alone. VS Code has a language pack for Hungarian; for
the other eleven — Dutch, Ukrainian, Swedish, Norwegian, Danish, Finnish, Hindi, Indonesian,
Vietnamese, Greek and Romanian — it has none, so `auto` shows English there and the settings stay in
VS Code's language: choose the language with the flag, or set `tokenPace.language`. VS Code's
Hungarian language pack was last updated for VS Code 1.48 (2020); where it sets VS Code's display
language, `auto` shows Hungarian and Token Pace's settings and command titles follow, because VS Code
then reads Token Pace's own `package.nls.hu.json` — what of VS Code's own words that pack still covers
is VS Code's matter. Norwegian is Bokmål — the id is `nb`, the list says *Norsk* —; VS Code has no
Norwegian pack to report `nb`, `no` or `nn`, and Token Pace maps neither `no` nor `nn` onto it: choose
it with the flag or `tokenPace.language: nb` (a display language `nb-no` would reach it by the rule
above).

Under `auto` the numbers and dates follow the tag VS Code reports, as they did before 1.9: a display
language Token Pace has no translation for keeps its own number and date formats, with English words.
A language you choose formats as that language does.

## What switches at once, and what cannot

**At once, without a reload**: the dashboard — every section, the provider switch, the picker, the
page's own words, its numbers and dates — keeping its scroll position and the keyboard focus; the
status bar's texts, tooltips and accessible names, the keep-warm countdown among them; the markdown
document and the agent hook's setup document while they are open; and from then on every Quick Pick,
alert, message, dialog and consent text, and every notification Token Pace sends to a channel (1.12).

**Not with the picker:**

* **The manifest.** The settings UI, the command titles in the Command Palette, the view's and its
  container's names, the walkthrough's titles and the Extensions view's name and description follow
  VS Code's display language: VS Code reads them from `package.nls.<language>.json` when it starts and
  offers an extension no way to have them read again. So with VS Code in German and the picker on
  Français, the settings are German and everything Token Pace draws is French. *Configure Display
  Language* — which restarts VS Code — changes them. The walkthrough's three step pages are English in
  every language.
* **What is open at that moment.** A Quick Pick, a modal dialog, an alert or another message keeps the
  language it was opened in until it closes; VS Code gives no way to rewrite one.
* **The words of the last failed attempt.** When Token Pace's own quota fetch fails, the reason is
  written down in the language of that moment and kept; it stays in that language until the next
  attempt. Every reading that can be made again is made again at the switch.
* **What stays English on purpose**: the debug log, the diagnostics report and the CSV and JSON
  exports — they are pasted into issues and have to be readable by a maintainer —, the keep-warm line
  and the terms passage the keep-warm consent quotes, command and setting ids, codicon names and
  product names.

## The twenty-six languages

| Id | Language | In English | Flag | Since |
|---|---|---|---|---|
| `en` | English | English | United States (`us`) | 1.0.0 |
| `de` | Deutsch | German | Germany (`de`) | 1.3.0 |
| `fr` | Français | French | France (`fr`) | 1.9.0 |
| `es` | Español | Spanish | Spain (`es`) | 1.9.0 |
| `pt-br` | Português (Brasil) | Portuguese (Brazil) | Brazil (`br`) | 1.9.0 |
| `it` | Italiano | Italian | Italy (`it`) | 1.9.0 |
| `ja` | 日本語 | Japanese | Japan (`jp`) | 1.9.0 |
| `ko` | 한국어 | Korean | South Korea (`kr`) | 1.9.0 |
| `zh-cn` | 简体中文 | Chinese (Simplified) | China (`cn`) | 1.9.0 |
| `zh-tw` | 繁體中文 | Chinese (Traditional) | Taiwan (`tw`) | 1.9.0 |
| `ru` | Русский | Russian | Russia (`ru`) | 1.9.0 |
| `tr` | Türkçe | Turkish | Türkiye (`tr`) | 1.9.0 |
| `pl` | Polski | Polish | Poland (`pl`) | 1.9.0 |
| `cs` | Čeština | Czech | Czechia (`cz`) | 1.9.0 |
| `nl` | Nederlands | Dutch | Netherlands (`nl`) | **new in 1.11.0** |
| `uk` | Українська | Ukrainian | Ukraine (`ua`) | **new in 1.11.0** |
| `sv` | Svenska | Swedish | Sweden (`se`) | **new in 1.11.0** |
| `nb` | Norsk | Norwegian | Norway (`no`) | **new in 1.11.0** |
| `da` | Dansk | Danish | Denmark (`dk`) | **new in 1.11.0** |
| `fi` | Suomi | Finnish | Finland (`fi`) | **new in 1.11.0** |
| `hi` | हिन्दी | Hindi | India (`in`) | **new in 1.11.0** |
| `id` | Bahasa Indonesia | Indonesian | Indonesia (`id`) | **new in 1.11.0** |
| `vi` | Tiếng Việt | Vietnamese | Vietnam (`vn`) | **new in 1.11.0** |
| `el` | Ελληνικά | Greek | Greece (`gr`) | **new in 1.11.0** |
| `hu` | Magyar | Hungarian | Hungary (`hu`) | **new in 1.11.0** |
| `ro` | Română | Romanian | Romania (`ro`) | **new in 1.11.0** |

The id is the setting's value and VS Code's own name for the display language. The picker offers the
languages whose translation file the installed build carries. English was there from the start and
German since 1.3.0 (the settings since 1.2.0); the other twelve — Français, Español, Português
(Brasil), Italiano, 日本語, 한국어, 简体中文, 繁體中文, Русский, Türkçe, Polski and Čeština — are new in
1.9.0, and the last twelve — Nederlands, Українська, Svenska, Norsk, Dansk, Suomi, हिन्दी, Bahasa
Indonesia, Tiếng Việt, Ελληνικά, Magyar and Română — are new in 1.11.0. Norwegian (`nb`) is Bokmål.

**A flag is not a language.** The name always stands beside the flag, and a screen reader does not
announce the flag. English carries the US flag because the author chose it — its words are spelled
the British way (*colour*, *realised*), so the list calls it *English*, not *English (US)* —, Spanish
carries Spain's, Brazilian Portuguese Brazil's, and the two Chinese entries carry China's and
Taiwan's; Hindi carries India's, Greek Greece's, Ukrainian Ukraine's and Norwegian Norway's. The
flags are small drawings shipped inside the extension, so they look the same on every system —
Windows' emoji font draws no flags — with no font and no download; in a High Contrast theme they keep
their colours and get an outline.

**Fonts.** Token Pace ships no font: the dashboard, the status bar and the dialogs draw हिन्दी and
Ελληνικά — Devanagari and Greek — with the fonts of your system, as VS Code draws everything. A system
without a font for one of these scripts shows boxes in their place; the words are right, the font is
missing. The flag switches back at once, or set `tokenPace.language` to a language your system has a
font for.

## Numbers, dates and times

Where Token Pace formats a figure, the language decides the digits, the decimal mark and the grouping —
German writes `2,8M` and `1.234.567`, French groups thousands with a narrow space and writes a decimal
comma, Japanese and Chinese write `2.8M` and `1,234,567` as English does, Hindi groups by lakh
(`12,34,567`) and keeps the decimal point —, and the names of weekdays and months. The hour cycle of a
clock time stays what `tokenPace.resetHourCycle` or your system says; the rest of the clock's form is
the language's: Danish, Finnish and Indonesian write `06.00` with a full stop, Hungarian puts the
12-hour mark in front (`de. 06:00`). The weekday in front of a clock time is the language's own short
name — `lun.`, `pon.`, `Pzt`, `seg.`, `月`, `周一`, `man.`, `ti`, `Thứ 2` —; English and German keep their
two letters (`Mo 06:00`, `Sa 14:20`), which the settings' own examples quote. The heat map's weekday
words are the translation's own, four characters at most; the weekday in front of a clock time is,
English and German aside, the short form of the language's date format. In Danish, Vietnamese and Polish
the two differ (`ti.` and `tirs.`, `T3` and `Thứ 3`, `Nd` and `niedz.`), because those forms do not fit
the heat map's column — `tirs.` and `Thứ 3` are five characters, `niedz.` six; in the other languages
they differ at most in case or a full stop. The day of a sparkline's hover label is weekday, day and
month (`Sat 26 Sep`, `sam. 26 sept.`), and where a language writes the month as a number — Japanese,
Chinese, Czech — it is that language's own short date (`9月26日(土)`, `9月26日周六`, `so 26. 9.`). The
calibration's figures take the language's decimal mark (`1,2` in German and French). Since 1.10 so does
every other decimal the dashboard, the tooltips and the text views print — a key figure's change
(`▼ -0,7%`), the plan factor (`×0,4`), a span under ten hours (`2,5 h`); the exports and the diagnostics
report keep the `.`.

**The same in every language** — these are the bar's and the page's own notation, not words: the
countdowns `45m`, `2h14m`, `3d 5h`, `<1m` and `4 m 10 s`; the units inside `2 h 14 min`, `3 d 5 h` and
`12 min` (the words around them are translated: *3 min ago*, *in 2 h 14 min*); the suffixes `K`, `M`
and `G`; the `$` in front of an amount and `<$0.01`; the `%` in the bar; the bar's glyphs (`█┃▁`,
`▲`, `Σ`) and the codicons; the ISO day `2026-09-01`; `1 h TTL`; and the marks `~` (an estimate), `⚠`
and `≈` (a lower bound) and `–` (nothing known).

**The percent follows the number in every language** — `25 %` in a sentence, `25%` in the status bar
—, Turkish included, although Turkish typography and the Turkish number format put the sign first
(`%25`): the Turkish translation keeps the English order in every string, for one style across the
page, the bar and the texts. A known limit, not an oversight. None of the twelve languages of 1.11
puts the sign first; whether a sentence writes a space before it is the language's own choice.

**At a narrow width** (1.10) a line never ends between a figure and its unit — `2 min`, `54 %`, `4 m`
stay together in every language —, and since 1.12 a duration's parts stay together too: `~18 h 46 min`,
`3 d 4 h` and `49 min 00 s` are one run each, so each figure of a model's turn line stays whole (`~12 h
05 min`, `P90 ~18 h 46 min` — the line may wrap between the two, and between `P90` and its figure). The
prompt cache's countdown (`4 m 10 s`), which writes `m`, is not one of them: it may still break between
its parts. An ISO day never breaks at its hyphen, and a window's percentage never stands alone on a line:
it wraps together with the verdict beside it.

**A stacked table's label** (1.10). Where the side bar is too narrow for a table's columns and its rows
stack, each cell prints its column's name in front of its value, with the colon the language writes:
*Période :* with a no-break space in French, *范围：* and *範圍：* with the full-width colon in Simplified
and Traditional Chinese, the plain `:` everywhere else, Japanese included. Since 1.11 the page puts one
space after a plain colon and none after a full-width one, whose glyph carries its own blank, so the
gap before the value is one gap in every language.

## How the translations were made

English is the source: every text is written in English first, and the German — the manifest since
1.2, every text since 1.3 — is translated with the code. The twelve languages of 1.9.0 — Français,
Español, Português (Brasil), Italiano, 日本語, 한국어, 简体中文, 繁體中文, Русский, Türkçe, Polski and
Čeština — were translated by AI agents (Claude Opus 5.5) from the English text, with the German as a
second reference, and checked by tests for completeness, placeholders and the marks `~`, `⚠`, `≈` and
`–` — they were **not reviewed by native speakers**. The tests hold every language to the same rules:
every text translated, every placeholder and mark kept, no code, setting or command name translated,
no English sentence left behind, no exclamation mark; they cannot tell a good word from a clumsy one.

In 1.10 the English changed while the code was written — the Prompts section's texts, the models',
sessions' and agents' lines, the settings' bar examples —, and every change went into a ledger of English
changes (the build's `l10n/rekey.json`) which each of the twelve languages worked through: every new text
translated, every reworded one read again, every changed settings sentence recorded afresh. The tests hold
that no text and no settings sentence was skipped — no pending list may exist at the join, and every
settings translation must be fresh. That work, and the decisions on the open questions the 1.9
translations had left per language, was again done by AI agents (Claude Opus 5.5, with a wording pass by
Claude Fable 5.1), not by native speakers.

**The twelve languages of 1.11.0** — Nederlands, Українська, Svenska, Norsk, Dansk, Suomi, हिन्दी, Bahasa
Indonesia, Tiếng Việt, Ελληνικά, Magyar and Română — were each translated whole by an AI agent (Claude
Opus 5.5) from the English text as it stood when 1.11's English was frozen, with the German as a second
reference, and checked by the same tests — for completeness, placeholders, the marks, the examples the
settings quote of the status bar (each language's example is what its bar prints) and the freshness of
every settings sentence — **not by native speakers**. The twelve languages of 1.9 worked through 1.11's
ledger of English changes the same way (Claude Opus 5.5 and Claude Fable 5.1). A reading pass by further
AI agents followed, one per language, none of them a native speaker either; what it found was applied
where the reader named a fact of the language — a gender, a case, what a pronoun refers to — and left
as it was otherwise. The open questions the 1.10 readers left for native speakers are not answered in
1.11 either, and the twelve new languages leave questions of their own: a matter of usage or taste is
not decided by an agent twice.

**In 1.12** the twenty-four languages beyond English and German worked through 1.12's ledger of English changes
(121 entries) in four packages of six, each by an AI agent (Claude Opus 5.5); a reading pass by further AI agents
followed, one per package, none of them a native speaker, and what it found was applied where the reader named a
fact of the language. Every language keeps two words apart — an **alert** is the popup inside VS Code, a
**notification** a message sent to a phone, a chat or an inbox —, and ten of them (Polski, 日本語, 한국어,
Nederlands, Svenska, Norsk, Suomi, Magyar, Українська, Ελληνικά) renamed their Alerts category for it, because its
old name is now the notifications' word: a reader who knew the old name finds the new one in the settings UI's list
of categories. The macOS Keychain's name and its buttons ("Always Allow", "Allow") are written as each agent believed
macOS shows them in the language, not checked on a Mac; Magyar keeps the English labels in quotation marks.

**Open questions.** Neither the questions the 1.10 readers left for native speakers nor those of 1.11 are answered in
1.12 — one is closed by a fact: VS Code itself writes 受限模式 for Restricted Mode in Traditional Chinese —, and 1.12
leaves questions of its own, per language family. In French, Spanish, Brazilian Portuguese, Italian and Romanian:
whether *used* in the thresholds' sentence reads as consumed, the article or preposition before a clock time, a
participle's agreement, and the words for a chat, a topic and VS Code's secret storage. In Polish, Czech, Russian and
Ukrainian: the words for an alert beside a notification, for a topic and a webhook, the space before an ellipsis, and
whether a failed test message reads as not sent or not delivered. In Dutch, Danish, Swedish and Norwegian: the
notification word and the Alerts category's, the space before an ellipsis, and the verb for a server that accepts a
message. In Finnish and Hungarian: an idiom for *without notice* that shares the notification word's root, the case
for sending to a channel, the register of nominal and passive forms, and the article before a name or a placeholder.
In Japanese, Korean and the two Chinese variants: the words for an alert, a channel, a webhook, a secret and VS Code's
secret storage, and a formula for *without notice* beside the notification word. And in Turkish, Greek, Hindi,
Indonesian and Vietnamese, each of a family of its own here: the words for a webhook, a host, a secret, a cooldown and
a test message, what a pronoun refers to, and the form of a clock time with its weekday. None of them is decided by an
agent.

**Register.** Each language addresses you as its software does: Ukrainian *ви*, Hindi *आप*, Indonesian
*Anda*, Greek the plural of politeness, Romanian the *dumneavoastră* forms, Hungarian the *Ön* forms
or an impersonal one, Finnish passive and impersonal forms, Vietnamese no pronoun where a sentence can
do without one, and Dutch *je*, Swedish, Norwegian and Danish *du* — the neutral address of software in
those languages, where the formal *u*, *Ni* and *De* would read as distant. The register was chosen
by the agents that translated, from common usage, not verified against a style guide; the twelve
languages of 1.9 keep the register they chose then.

**Terms.** "Prompt", the Prompts section's word, is said in the language's own word in Turkish (*istem*)
and in the two Chinese variants (提示词 in Simplified, 提示 in Traditional Chinese); the other nine of 1.9
keep the loanword. Of the twelve of 1.11 three say it in their own word — Finnish *kehote*, Greek
*προτροπή*, Vietnamese *lời nhắc* —; the other nine keep the loanword. A key's name in a sentence —
Enter, Ctrl+Enter — is, in the twelve languages of 1.9, the language's prose word (*Entrée*, *Intro*,
*Invio*, *Eingabe*), not a key label of VS Code's; the twelve languages of 1.11 write the label as VS
Code shows it in every language — `Enter`, `Ctrl+Enter`, `⌘+Enter` —, with the language's word for
"key" around it where a sentence needs one, so that no prose name is introduced that no native speaker
has checked. VS Code's own terms are VS Code's words (1.12): Turkish writes *Uzantı Konağı* for the extension host
and *Kısıtlı Mod* for Restricted Mode, Traditional Chinese 延伸模組 for an extension, 延伸主機 for the extension host
and 受限模式 for Restricted Mode — as VS Code's language packs for them do.

A wrong or clumsy word is a bug — please report it on the
[issue tracker](https://github.com/mfvdp/VS-Code_Token-Usage/issues), with the language, the text you
saw and where you saw it (the status bar, a section of the dashboard, a dialog).

## Adding a language

A language is a registry entry, four part files, a manifest translation and a freshness record, held
to the same tests as every other — see [Building and testing](development.md#translating).
