<!--
SPDX-FileCopyrightText: 2026 Frederik Marx
SPDX-License-Identifier: AGPL-3.0-or-later
-->

# Translating Token Pace

The brief a translation works from — one language, one package, one branch. It is not shipped with
the extension (`.vscodeignore` ships nothing under `l10n/` but the bundles). How the pieces fit
together is in [Building and testing](../docs/development.md#translating); which languages exist and
how the translations were made is in [Languages](../docs/languages.md).

## What you translate, and from what

1. **The source is the English.** A runtime string's English is its key (`t('Refresh')` — the key
   *is* the text); a manifest string's English is its value in `package.nls.json`. Translate that.
2. **The German is a second reference, not the source.** Read `l10n/parts/<part>.de.json` and
   `package.nls.de.json` where the English is short or could mean two things — "cache", "sub", "more",
   "over", "Split", "Reset" as a noun or a verb — and never translate the German.
3. **The call site settles the rest.** `node scripts/l10n-extract.mjs --json` lists `file:line` for
   every key; read the code around it when English and German both leave a doubt (a label on a
   button, a column head, a sentence in a dialog, a word that is concatenated with a number).

## Register and tone

* Neutral or formal, as the German's *Sie*: French *vous*; Spanish *usted* or impersonal forms;
  Brazilian Portuguese *você*; Italian impersonal forms or *Lei*; Russian *вы*; Turkish the *siz*
  forms; Polish and Czech impersonal forms; Japanese です/ます; Korean 합니다체; Chinese neutral —
  no 你/您 where a sentence can do without.
* No exclamation marks (`!`, `¡`, `！`), no informal address, no emoji. (The manifest's one `!` is
  the status bar's "exhausted" glyph, quoted as “!” — keep it.)

## Never translated

* **Product and company names**: Token Pace, Claude, Claude Code, Codex, Anthropic, OpenAI,
  ChatGPT, VS Code, Visual Studio Code, Open VSX, GitHub, WSL, Windows, macOS, Linux. Plan names
  (Pro, Max 20x, Team, Plus) and the status bar's provider labels `CC` and `CDX` too.
* **Model ids** (`claude-opus-5-5`, `gpt-5.6-sol`), **setting and command ids** (`tokenPace.…`,
  `command:…`), **codicons** (`$(watch)`), **file names and paths** (`quota.json`,
  `~/.claude/…`), and **everything in backticks** — with one exception in the manifest: a span that
  spells a formula in words (`ratio = (used ÷ limit) ÷ (elapsed ÷ window)`) or quotes a label the page
  shows translated (`subagents`) is translated as the German does. There are five, and the test
  names them (`NLS_SPANS_READ_AS_WORDS`): `ratio = (used ÷ limit) ÷ (elapsed ÷ window)`,
  `used % − elapsed %`, `ratio 1.12`, `elapsed ≈ 0` and `subagents`. A description keeps as many
  backtick spans as the English — these five in your words, still in backticks, every other one as
  it is.
* **The JSON examples** of the manifest, byte for byte.
* **The keep-warm line** `Ignore this message. No action. No response.` — a text for Claude, not for
  the reader. It is passed as an argument and never appears in a translation.
* **The terms passage** of Anthropic's Consumer Terms — passed as `{0}`, quoted word for word in
  English. Keep the `{0}` inside the language's own quotation marks.
* `displayName` ("Token Pace — Claude Code & Codex") and `command.category` ("Token Pace").
* **The fourteen native names** of `config.language.enum.<id>` (English, Deutsch, Français, Español,
  Português (Brasil), Italiano, 日本語, 한국어, 简体中文, 繁體中文, Русский, Türkçe, Polski, Čeština) —
  the same in every file. The fourteen names *in the reader's language* (the keys `English`,
  `German`, … `Czech`) are translated.

## Kept exactly

* Every `{n}` placeholder, as often as the key has it. A translation may reorder them.
* The marks, each as often as in the English: `~` (an estimate — ASCII, never `～`), `⚠` (a lower
  bound), `≈`, `–` (absence), `%`, `×`, `→` and the separator `·` (never `・`).
* A dash between two parts of a sentence is the em dash `—`, as in the English (or a comma, a colon,
  brackets) — also where your language's typography sets an en dash there (French, Polish, Czech):
  the en dash `–` is the absence mark, T4 counts it, and a value holds exactly as many as its key. A
  range the English writes with one (`{1}–{2}`) keeps it.
* The fixed forms, which are notation, not words: `45m`, `2h14m`, `3d 5h`, `<1m`, `4 m 10 s`, the
  units inside `2 h 14 min`, `K`/`M`/`G`, the `$` of an amount and `<$0.01`, `1 h TTL`, the ISO day
  `2026-09-01`. The words around them translate ("{0} ago", "in {0}").
* Markdown: the pipes of a table's header row (a key that starts with `| `), `**bold**`, links
  `[text](command:…)` with the target unchanged, `#tokenPace.x#` setting links, fences, and the
  paragraph breaks (`\n\n`) — the settings UI lays a description out by them.
* A command title quoted in a runtime string ("Run “Token Pace: Reset Network Access Decision”") is
  quoted as the language's own `package.nls.<id>.json` translates that title, so the reader finds it
  in the command palette. Quote a VS Code command (*Configure Display Language*) or term
  (*Restricted Mode*) as VS Code's own translation into the language has it, where you know it.
* The other way round: a text of the status bar or the page that a setting's description quotes as
  an example (“~22 running”, “budget 63 %”, “retry 1h12m”, the compact tooltip's header
  “Window | Used | Elapsed | Pace | Resets”) is quoted as your bundle translates it — the reader
  compares the example with what the bar shows.
* A `{n}` the English puts between quotation marks (“{0}”, ‘{0}’) stays between quotation marks. For
  the tests (T11) a quotation mark is one of “ ” " „ « » ‹ › 「 」 『 』 ‘ ’ ' ‚, with a space or a
  no-break space inside allowed; 《 》 and 【 】 are not.
* The quality statement — the third paragraph of `config.language.description` and the picker's line
  "The languages beyond English and German were translated by AI agents …" — says exactly what the
  English says: no word that claims more ("professional", "reviewed", "native").

## The page's words

The keys of `webviewWords()` (src/dashboard.ts) are concatenated into markup: no `<`, `>`, `"` or `&`
in their translations. Use the language's own quotation marks — « », „ ", 「 」, “ ” are fine.

## Plural, length, terms

* **Plural**: 1.9 has no plural rules. The English uses "(s)" forms and a few singular/plural pairs.
  Where the language would need a third form (Russian, Polish, Czech), prefer a construction that
  needs no agreement ("Sitzungen: {0}"-style labels) — the same choice in every string of the kind.
* **Length**: the dashboard is 260 px wide at its narrowest. A label that doubles its English length
  wraps or is cut; prefer the short word the platform uses (VS Code's own translation of a term).
* **Terms**: one word for one concept across all strings — "quota", "window", "session", "request",
  "reset", "prompt cache", "subagent", "lower bound", "pace", "burn rate", "extra usage",
  "keep-warm", "cold start", "Restricted Mode", "consent", "status line", "bridge". No glossary file
  is written: your report returns your **30 hardest terms** (English → the word you chose → one line
  why), and the lead keeps them for the next languages.

## The files you own — and no other

For the language `<id>` (the registry's id in `src/languages.ts`: `fr`, `es`, `pt-br`, `it`, `ja`,
`ko`, `zh-cn`, `zh-tw`, `ru`, `tr`, `pl`, `cs`):

| File | Made how |
|---|---|
| `l10n/parts/dashboard.<id>.json`, `l10n/parts/host.<id>.json`, `l10n/parts/model.<id>.json`, `l10n/parts/text.<id>.json` | written by you: exactly the keys of the German part of the same name, with your translations |
| `l10n/bundle.l10n.<id>.json` | generated: `node scripts/merge-l10n.mjs` |
| `package.nls.<id>.json` | written by you: every key of `package.nls.json`, in its order |
| `l10n/nls-sources/<id>.json` | generated: `node scripts/nls-sources.mjs <id>` — only once the manifest is translated: the record says your text translates today's English |

Nothing else: not `src/`, `test/`, `scripts/`, `docs/`, `media/`, `README.md`, `CHANGELOG.md`,
`package.json`, `package.nls.json`, the German files, this brief, another language's files or the
registry. A key that appears in two parts gets the same translation in both (`merge-l10n.mjs`
refuses two). Something in the English that looks wrong is reported, not changed — the English is
frozen while the languages are translated.

## The gates

```
node build.mjs
node build.mjs --tests && CI=true TZ=UTC LANG=en_US.UTF-8 HOME=$(mktemp -d) node --test \
  out-test/l10n.languages.test.js out-test/nls.test.js out-test/languages.test.js out-test/i18n.test.js \
  out-test/i18n.model.test.js out-test/i18n.text.test.js out-test/dashboard.test.js
node scripts/check-privacy.mjs
node scripts/merge-l10n.mjs --check
node scripts/nls-sources.mjs --check
```

`test/l10n.languages.test.ts` runs the same rules over every language on disk, yours among them;
each failure names the language, the file and the key:

* **T1 · Keys** — the bundle's keys are the extracted `t()` keys, no more, no less; the manifest's are
  `package.nls.json`'s, in the same order.
* **T2 · Parts** — the four part files exist, each with exactly the German part's keys.
* **T3 · Placeholders** — every value keeps the `{n}` of its key, each as often.
* **T4 · Marks** — `~ ⚠ ≈ – % × → ·` as often as the key (the manifest: `~ ⚠ ≈ –`).
* **T5 · Code** — backtick spans, `tokenPace.…` ids, `$(…)` codicons, `command:` targets and
  paragraphs as the key has them; in the manifest also the setting links, command links, fences and
  JSON examples.
* **T6 · Page words** — no `<`, `>`, `"`, `&` in a translation of one of the page's words.
* **T7 · Tone** — no exclamation mark.
* **T8 · Tables** — a key that starts with `| ` keeps its pipes.
* **T9 · No English left** — once placeholders, code, paths, model ids and the words of
  `SAME_IN_EVERY_LANGUAGE` (the names above, the abbreviations `API`, `USD`, `CSV`, `JSON`, `TTL`,
  `ID`, `HTTP`, `TLS`, `OAuth`, `CLI`, `P90`, `CV`, `ctx`, the units and `Quick Pick`) are taken out:
  in a Latin-script language a key of three words or more is never its own translation and no four
  words of the key stand in a row in the value; in Japanese, Korean, Chinese and Russian no value
  keeps three Latin words in a row. No manifest entry of 40 characters or more is the English.
* **T10 · Registry** — every file names a registry id; the fourteen language names are translated;
  `config.language.enum.<id>` is the native name; `displayName` and `command.category` are the English.
* **T11 · The English quotes** — with your bundle installed, the keep-warm consent still quotes the
  terms passage and the line word for word, and every `{n}` the English puts between quotation marks
  stands between quotation marks.
* **T12 · Freshness** — `node scripts/nls-sources.mjs --check` passes: every manifest translation
  was recorded against today's English.
* **T13 · Weekday words** — `Sun` … `Sat` (the heat map's rows) in four characters or fewer.

A rule that is wrong about a string — English that is right to keep, say — is **reported with its
key**, not worked around and not edited: the lead extends `SAME_IN_EVERY_LANGUAGE` when the languages
are joined. Do not run the dashboard harness (its output folder is shared); the join runs it once for
every language.

## Your report

The branch and its commit; the gates' results (a false positive named with its key); your 30
hardest terms; anything in the English that looked wrong; the time it took.
