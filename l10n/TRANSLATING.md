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
* The twelve languages of 1.11 each have their line in [1.11: a new language, whole](#111-a-new-language-whole)
  — Dutch and the three Nordic languages among them, whose neutral register is *je*/*du*.

## Never translated

* **Product and company names**: Token Pace, Claude, Claude Code, Codex, Anthropic, OpenAI,
  ChatGPT, VS Code, Visual Studio Code, Open VSX, GitHub, WSL, Windows, macOS, Linux. Plan names
  (Pro, Max 20x, Team, Plus) and the status bar's provider labels `CC` and `CDX` too.
* **Model ids** (`claude-opus-5-5`, `gpt-5.6-sol`), **setting and command ids** (`tokenPace.…`,
  `command:…`), **codicons** (`$(watch)`), **file names and paths** (`quota.json`,
  `~/.claude/…`), and **everything in backticks** — with one exception in the manifest: a span that
  spells a formula in words (`ratio = (used ÷ limit) ÷ (elapsed ÷ window)`) or quotes a label the page
  shows translated (`subagents`) is translated as the German does. There are seven, and the test
  names them (`NLS_SPANS_READ_AS_WORDS`): `ratio = (used ÷ limit) ÷ (elapsed ÷ window)`,
  `used % − elapsed %`, `ratio 1.12`, `elapsed ≈ 0`, `subagents`, and — added when the first twelve
  languages were joined — `plan Max 20x (as configured)` (the tooltip's `plan {0} (as configured)`) and
  `other` (the chart's band). Quote a label as your bundle translates it. A description keeps as many
  backtick spans as the English — these seven in your words, still in backticks, every other one as
  it is.
* **The JSON examples** of the manifest, byte for byte.
* **The keep-warm line** `Ignore this message. No action. No response.` — a text for Claude, not for
  the reader. It is passed as an argument and never appears in a translation.
* **The terms passage** of Anthropic's Consumer Terms — passed as `{0}`, quoted word for word in
  English. Keep the `{0}` inside the language's own quotation marks.
* `displayName` ("Token Pace — Claude Code & Codex") and `command.category` ("Token Pace").
* **The native names** of `config.language.enum.<id>` (English, Deutsch, Français, Español,
  Português (Brasil), Italiano, 日本語, 한국어, 简体中文, 繁體中文, Русский, Türkçe, Polski, Čeština — and
  from 1.11 on Nederlands, Українська, Svenska, Norsk, Dansk, Suomi, हिन्दी, Bahasa Indonesia,
  Tiếng Việt, Ελληνικά, Magyar, Română) — the same in every file. The names *in the reader's language*
  (the keys `English`, `German`, … `Czech`, and from 1.11 on `Dutch` … `Romanian`) are translated. Where
  your language writes one of them as the English does (the German *Hindi*), say so in your report
  with the key: the lead adds it to `LANGUAGE_NAME_AS_ENGLISH` in the test, with its reason.

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
  no-break space inside allowed; 《 》 and 【 】 are not. ” and » may open a quotation as well as close
  one (1.11: Swedish and Finnish ”…” and »…»).
* The quality statement — the third paragraph of `config.language.description` and the picker's line
  "The languages beyond English and German were translated by AI agents …" — says exactly what the
  English says: no word that claims more ("professional", "reviewed", "native").

## The page's words

The keys of `webviewWords()` (src/dashboard.ts) are concatenated into markup: no `<`, `>`, `"` or `&`
in their translations. Use the language's own quotation marks — « », „ ", 「 」, “ ” are fine.

## Plural, length, terms

* **Plural**: 1.9 has no plural rules, nor has 1.11. The English uses "(s)" forms and a few
  singular/plural pairs. Where the language would need a third form (Russian, Polish, Czech — from
  1.11 on also Ukrainian and Romanian), prefer a construction that needs no agreement
  ("Sitzungen: {0}"-style labels) — the same choice in every string of the kind.
* **Length**: the dashboard is 260 px wide at its narrowest. A label that doubles its English length
  wraps or is cut; prefer the short word the platform uses (VS Code's own translation of a term).
* **Terms**: one word for one concept across all strings — "quota", "window", "session", "request",
  "reset", "prompt cache", "subagent", "lower bound", "pace", "burn rate", "extra usage",
  "keep-warm", "cold start", "Restricted Mode", "consent", "status line", "bridge". No glossary file
  is written: your report returns your **30 hardest terms** (English → the word you chose → one line
  why), and the lead keeps them for the next languages.

## The files you own — and no other

For the language `<id>` (the registry's id in `src/languages.ts` — twenty-four beyond English and
German: `fr`, `es`, `pt-br`, `it`, `ja`, `ko`, `zh-cn`, `zh-tw`, `ru`, `tr`, `pl`, `cs`, and from 1.11 on
`nl`, `uk`, `sv`, `nb`, `da`, `fi`, `hi`, `id`, `vi`, `el`, `hu`, `ro`):

| File | Made how |
|---|---|
| `l10n/parts/dashboard.<id>.json`, `l10n/parts/host.<id>.json`, `l10n/parts/model.<id>.json`, `l10n/parts/text.<id>.json` | written by you: exactly the keys of the German part of the same name, with your translations |
| `l10n/bundle.l10n.<id>.json` | generated: `node scripts/merge-l10n.mjs` |
| `package.nls.<id>.json` | written by you: every key of `package.nls.json`, in its order |
| `l10n/nls-sources/<id>.json` | generated: `node scripts/nls-sources.mjs <id>` — only once the manifest is translated: the record says your text translates today's English |
| `l10n/pending/<id>.json` | 1.10: written by `scripts/l10n-rekey.mjs` whenever the English changed — your work list; you empty it and delete it (the next section). A language new in 1.11 never has one |

Nothing else: not `src/`, `test/`, `scripts/`, `docs/`, `media/`, `README.md`, `CHANGELOG.md`,
`package.json`, `package.nls.json`, the German files, this brief, another language's files or the
registry — nor the ledger `l10n/rekey.json` and its base `l10n/rekey-base.json`. A key that appears in
two parts gets the same translation in both (`merge-l10n.mjs` refuses two). Something in the English
that looks wrong is reported, not changed — the English is frozen while the languages are translated.

## Working through your pending list (1.10)

In 1.10 the English changed while the code was written: new texts (the Prompts section), whole
sentences where 1.9 joined two, the settings' examples as the status bar prints them. Each change is an
entry of the re-key ledger, `l10n/rekey.json`, and `scripts/l10n-rekey.mjs` carried it into your files
the moment it was made. What your language has not translated yet is on its pending list,
`l10n/pending/<id>.json`. A key listed `translate` is absent from your parts and your bundle, so the
extension shows it in English — on the build branch only: at the join no language may have a pending
key (`PENDING_ALLOWED` is false in the test from then on).

1. **Read the list**: `node scripts/l10n-rekey.mjs --print <id>` prints two tables — the runtime strings
   and the manifest — with each key's part, its state, the English, the German, the value your files
   hold now and why it is listed. The English, the German and the value are printed as JSON strings,
   ready to paste.
2. **`translate`**: the key is new, or its English changed so much that the old translation says
   something else. Add it to every part the list names — the same words in each —, translated from the
   English as everywhere in this brief.
3. **`review`**: your files hold a value already — a translation carried over from the key's old English
   (a grammar fix, a word made clearer), or a text whose English stayed while its use narrowed (*Active*
   is now only a session's state; the calendar's column says *Active days*). Read it against the new
   English, and keep it or write it again.
4. **The manifest keys** on the list, in `package.nls.<id>.json`: a new key holds the English value —
   translate it; a reworded one holds your translation of the English before the change — read it
   against today's English. Then record the manifest once: `node scripts/nls-sources.mjs <id>`.
5. **Empty the list and delete the file.** `l10n/pending/<id>.json` goes when nothing is left on it, and
   the gates check that it is gone. Run `node scripts/merge-l10n.mjs` after the parts changed. You
   never run `node scripts/l10n-rekey.mjs` without an option: the ledger is applied to your files
   already, and it is the packages' that change the English, not yours.

The notes the 1.10 keys need:

* **A pattern key takes your language's own punctuation.** `{0}:` (the label a stacked table cell
  prints before its value) and the summary's cache sentences (`Cache hit rate — {0} {1} ({2}).`) are
  patterns: write the colon, the brackets and the list's comma as your language sets them — `{0} :`
  with a no-break space (U+00A0) before the colon in French, `{0}：` in Chinese and Japanese, `（）`
  around a figure in Chinese and Japanese, `、` between two items in Japanese and Chinese. Write no
  space after the colon of `{0}:`: the page adds the space after an ASCII colon, and none after a
  full-width one, whose glyph carries its own blank (since 1.11).
* **The status bar writes `25%` without a space**, in every language — its texts are notation, as the
  fixed forms above. `{0} ~ends at {1}%` is such a text: the `%` stays attached, whatever your
  language writes in a sentence.
* **Three words that look alike**: "record" is a personal best (the *Records* section); "entry" is an
  agent's data (*Agent entries*, "agent records" until 1.9); "run record" is a file Claude Code writes
  for a workflow run. Each gets its own word.
* **"press to cancel"** — the keep-warm countdown's screen-reader label — is the verb a person uses for
  a control (press, click, tap, as your language says it of a button), never "enable" or "activate".
* **`×` between Latin words is fine** (T9): `scope × period × unit` names three words of a JSON example
  the way the English does. A `×` or `÷` between two Latin words ends a run of English for T9; no other
  mark does, and a space least of all.

## 1.11: a new language, whole

In 1.11 twelve languages join: `nl` Nederlands, `uk` Українська, `sv` Svenska, `nb` Norsk (the Bokmål
written form; the native name stays *Norsk*), `da` Dansk, `fi` Suomi, `hi` हिन्दी, `id` Bahasa
Indonesia, `vi` Tiếng Việt, `el` Ελληνικά, `hu` Magyar, `ro` Română. Each is a whole translation, made
once from the English at the frozen tip (the commit the lead names: the `t()` keys and
`package.nls.json`), with the German as a second reference and the call site where both leave a
doubt — the first section of this brief. Another language's translation, 1.10's decisions among
them, is not a source. A new language is never a pending list: it has no file before your package
writes one, and `scripts/l10n-rekey.mjs` passes over a language without files.

1. **The files.** Write `l10n/parts/<part>.<id>.json` for the four parts (`dashboard`, `host`,
   `model`, `text`), each with exactly the German part's keys, and `package.nls.<id>.json` with every
   key of `package.nls.json`, in its order; then `node scripts/merge-l10n.mjs` (your bundle) and
   `node scripts/nls-sources.mjs <id>` (your record). `git status` shows them untracked until your
   commit.
2. **Register** — neutral or formal, as the German's *Sie*:
   * Ukrainian *ви*; Hindi *आप*; Indonesian *Anda*; Greek the plural of politeness; Romanian the
     *dumneavoastră* forms; Hungarian the *Ön* forms or impersonal ones; Finnish passive and
     impersonal forms; Vietnamese neutral — no pronoun where a sentence can do without.
   * Dutch *u* or *je*; Swedish, Norwegian and Danish **du** — in Nordic software text the neutral
     address, the formal *Ni*/*De* reading as archaic — and none where a sentence can do without. For
     these four, *je*/*du* is the neutral register this brief asks for, not the informal address it
     rules out.
   * This is a reading of common UI practice, not verified against a style guide and not a native
     speaker's: decide for your language and give the reason in your report.
3. **Key names.** Write `Enter`, `Ctrl+Enter` and `⌘+Enter` as VS Code's key labels are written —
   VS Code localises no key name — with your language's word for "key" around them where a sentence
   needs one. (The twelve languages of 1.10 keep the prose names they chose; that is theirs, and no
   source for you.)
4. **Weekday words** (T13): four characters or fewer, counted as a reader sees them — grapheme
   clusters, not code points. Hindi's `शुक्र` is two clusters and five code points, and passes. Danish
   `tirs.` and `tors.` and Vietnamese `Thứ 2` are five: the usual short forms are `ti.`, `to.` and
   `T2` — your choice, named in your report.
5. **Quotation marks** (T11, T15): your language's own. Swedish and Finnish `”…”` and `»…»`, Danish
   `»…«`, and `«…»` and `„…”` are all read as quotation marks: a `{n}` the English quotes stays
   between them, and an example between them is what T15 checks.
6. **The bar's examples** (T15): a setting that quotes the status bar quotes it as your locale prints
   it — a Danish, Finnish or Indonesian clock reads `06.00`, Hungarian's 12-hour example `de. 06:00`,
   Greek's `06:00 π.μ.`, Hindi's `06:00 am`, and the weekday is your locale's short form
   (`man. 06.00`, `Thứ 2 06:00`, `H 06:00`). Do not work it out: run the tests and copy what T15
   prints — its message names the text the bar builds.
7. **Plurals**: no plural rules in 1.11 either. Ukrainian (one/few/many/other) and Romanian
   (one/few/other) join Russian, Polish and Czech: prefer a construction that needs no agreement —
   the same choice in every string of the kind, named in your report. Indonesian and Vietnamese have
   no plural: the "(s)" forms read as they stand. The others have one/other.
8. **Marks** (T4): the separator `·` is a counted mark, and Greek's ano teleia (`·`, U+0387) is that
   same character once a file is normalised (NFC) — T4 counts the normalised text and names the ano
   teleia: write a comma or a full stop inside a Greek sentence. Hindi's danda `।` and Greek's
   question mark `;` are fine. A dash between two clauses is the em dash `—`, also where your
   typography sets an en dash there (Swedish, Danish, Norwegian, Finnish, Hungarian, Romanian,
   Ukrainian): the en dash `–` is the absence mark.
9. **Numbers**: the page's decimals and groupings come from your locale — Hindi's `12,34,567` and
   its decimal point included; none of the twelve writes the percent sign first. A sentence writes
   `{0} %` as your language writes a percent; the status bar keeps `25%` (notation).
10. **Terms**: return your 30 hardest terms, and name the word you chose for "prompt" (a loanword or
    not), "record" (a personal best), "entry" (an agent's data), "keep-warm" and "cold start".
11. **Gates** — for each id of your package, in your worktree, the tests inside a memory scope (a
    runaway test once took the whole machine):

    ```
    npm run typecheck
    node build.mjs
    node build.mjs --tests && systemd-run --user --scope -q -p MemoryMax=8G -p MemorySwapMax=0 env CI=true TZ=UTC \
      LANG=en_US.UTF-8 HOME=$(mktemp -d) NODE_OPTIONS=--max-old-space-size=6144 node --test \
      out-test/l10n.languages.test.js out-test/nls.test.js out-test/languages.test.js out-test/i18n.test.js \
      out-test/i18n.model.test.js out-test/i18n.text.test.js out-test/dashboard.test.js out-test/prompts.test.js
    node scripts/check-privacy.mjs
    node scripts/merge-l10n.mjs --check
    node scripts/nls-sources.mjs --check --strict <id>
    node scripts/l10n-rekey.mjs --check
    test ! -e l10n/pending/<id>.json
    ```

12. **Your report** opens with the line "Not a native speaker: the translations are an AI agent's." —
    then the branch and its commit, the gates, and per language the runtime and manifest key counts,
    the register chosen, the 30 terms, the weekday words, the plural constructions (Ukrainian,
    Romanian), any false positive of the frame named with its key (not worked around), anything in the
    English that looked wrong (reported, not changed), and the minutes it took.

## 1.11: your pending list

For the twelve languages of 1.10 (`fr`, `es`, `pt-br`, `it`, `ja`, `ko`, `zh-cn`, `zh-tw`, `ru`, `tr`,
`pl`, `cs`). 1.11's ledger started at the 1.10.0 release (`node scripts/l10n-rekey.mjs --start
b89ff43`) with an empty list for each of you; the code packages' English changes filled it, and you
work through it as [the 1.10 section](#working-through-your-pending-list-110) says:

1. `node scripts/l10n-rekey.mjs --print <id>`: translate every `translate` key into the parts it
   names, and read every `review` key against the new English — keep it, or write it again.
2. What to expect: the twelve language names of 1.11 (`Dutch` … `Romanian`) are `translate`; the
   manifest's twelve native names are `nls-add` entries that already hold the right value — the
   native name, the same in every file —, so you confirm them; `config.language.description` and
   the other reworded manifest sentences are `review`.
3. Then `node scripts/nls-sources.mjs <id>`, and delete `l10n/pending/<id>.json`. The gates are the
   1.11 section's above, ending in `test ! -e l10n/pending/<id>.json`.
4. The questions the 1.10 readers left for native speakers are not answered in 1.11: where a key of
   your list is one of them, keep the 1.10 value and say so. The items of 1.11 for single languages
   (the Polish plurals, say) are named in your package's prompt.
5. Your report: the first line as above, then how many keys of your list you translated, reviewed
   and did in the manifest.

## The gates

```
npm run typecheck
node build.mjs
node build.mjs --tests && CI=true TZ=UTC LANG=en_US.UTF-8 HOME=$(mktemp -d) node --test \
  out-test/l10n.languages.test.js out-test/nls.test.js out-test/languages.test.js out-test/i18n.test.js \
  out-test/i18n.model.test.js out-test/i18n.text.test.js out-test/dashboard.test.js out-test/prompts.test.js
node scripts/check-privacy.mjs
node scripts/merge-l10n.mjs --check
node scripts/nls-sources.mjs --check --strict <id>
node scripts/l10n-rekey.mjs --check
test ! -e l10n/pending/<id>.json
```

`--strict <id>` holds your language to every manifest key — a key on your list counts as stale there
— while the others keep theirs; `l10n-rekey.mjs --check` says the ledger is applied to every language;
the last line fails while your list is still on disk. (`out-test/prompts.test.js` holds the shipped
prompts' words, from 1.10 on.)

`test/l10n.languages.test.ts` runs the same rules over every language on disk, yours among them;
each failure names the language, the file and the key:

* **T1 · Keys** — the bundle's keys are the extracted `t()` keys, no more, no less; the manifest's are
  `package.nls.json`'s, in the same order. While `PENDING_ALLOWED` is true, a key your list names
  `translate` may be absent, and one it names `review` is there.
* **T2 · Parts** — the four part files exist, each with exactly the German part's keys — minus the
  keys your list names `translate` for that part.
* **T3 · Placeholders** — every value keeps the `{n}` of its key, each as often.
* **T4 · Marks** — `~ ⚠ ≈ – % × → ·` as often as the key (the manifest: `~ ⚠ ≈ –`), counted in the
  text as NFC normalises it (1.11) — so the Greek ano teleia (U+0387), which NFC makes the separator
  `·`, is named wherever it stands.
* **T5 · Code** — backtick spans, `tokenPace.…` ids, `$(…)` codicons, `command:` targets and
  paragraphs as the key has them; in the manifest also the setting links, command links, fences and
  JSON examples.
* **T6 · Page words** — no `<`, `>`, `"`, `&` in a translation of one of the page's words.
* **T7 · Tone** — no exclamation mark.
* **T8 · Tables** — a key that starts with `| ` keeps its pipes.
* **T9 · No English left** — once placeholders, code, paths, model ids and the words of
  `SAME_IN_EVERY_LANGUAGE` (the names above, the abbreviations `API`, `USD`, `CSV`, `JSON`, `TTL`,
  `ID`, `HTTP`, `TLS`, `OAuth`, `CLI`, `P90`, `CV`, `ctx`, the units, `Quick Pick`, the literal command
  `codex app-server` and the colour ids `paceWarn` and `paceAhead`) are taken out:
  in a Latin-script language a key of three words or more is never its own translation and no four
  words of the key stand in a row in the value; in Japanese, Korean, Chinese, Russian — and from 1.11
  on Ukrainian, Greek and Hindi — no value keeps three Latin words in a row — a `×` or `÷` between two
  of them ends the run. Vietnamese is written in Latin letters and held by the first rule. No manifest entry
  of 40 characters or more is the English. A manifest key on your pending list is left out of T3, T4,
  T5, T7 and T9 until it is done: its value is the English, or your translation of the English before
  the change.
* **T10 · Registry** — every file names a registry id; the registry's language names are translated
  (1.11: a name your list names `translate` may be missing until you translate it, and a name may be
  the English only where `LANGUAGE_NAME_AS_ENGLISH` says your language writes it so);
  `config.language.enum.<id>` is the native name; `displayName` and `command.category` are the English.
* **T11 · The English quotes** — with your bundle installed, the keep-warm consent still quotes the
  terms passage and the line word for word, and every `{n}` the English puts between quotation marks
  stands between quotation marks.
* **T12 · Freshness** — `node scripts/nls-sources.mjs --check` passes: every manifest translation
  was recorded against today's English. A key on your pending list is reported as pending, not stale;
  `--strict <id>` counts it as a problem.
* **T13 · Weekday words** — `Sun` … `Sat` (the heat map's rows) in four characters or fewer, counted
  as grapheme clusters, the characters a reader sees (1.11: Hindi's `शुक्र` is two).
* **T14 · Pending** (1.10) — your list names only keys today's English has, each for a part the German
  has it in, a `review` key where your part holds a value; the ledger is applied to its end; German
  has no list; and once `PENDING_ALLOWED` is false (the join) no list is left.
* **T15 · The bar's examples** (1.10) — every example quoted in `config.resetFormat.enum.*`,
  `config.density.enum.*`, `config.summary.period.enum.*` and `config.resetHourCycle.enum.*` (the
  text between two of T11's quotation marks; a no-break space reads as a space, and an apostrophe
  between two letters — aujourd’hui, dell’ora — is a letter of the word, not a mark) is a text your
  language's status bar prints — your bundle's words, your locale's decimals, weekday and 12-hour
  clock — for this fixture: Monday 2026-09-28, 03:46 UTC; Claude Code's 5 h window at 25 % with its
  reset 2 h 14 min away (06:00), its 7 d window at 69 % with 6 days left; 3.1M tokens today, 12.3M
  in 7 days, 48.9M in 30. The reset formats and hour cycles show no bar, `full` a bar of width 8
  without the time marker, `compact` both windows; the weekday example is the same reset read two
  days before it, and `minimal` the 5 h window alone at 01:30, where 25 % runs ahead of the pace
  (`▲`). So the English “CC 5h 25% · resets 2h14m” is “CC 5h 25% · Reset in 2h14m” in German, and
  “Σ 3.1M · today” is “Σ 3,1M · heute”. A value quotes as many examples as the English. A key on
  your pending list is left out until it is done.

A rule that is wrong about a string — English that is right to keep, say — is **reported with its
key**, not worked around and not edited: the lead extends `SAME_IN_EVERY_LANGUAGE` when the languages
are joined. Do not run the dashboard harness (its output folder is shared); the join runs it once for
every language.

## Your report

The branch and its commit; the gates' results (a false positive named with its key); your 30
hardest terms; anything in the English that looked wrong; the time it took. In 1.10 also: how many
keys of your list you translated, reviewed and did in the manifest.
