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
* The three languages of 1.13 — Arabic, Hebrew and Persian, written right to left — have theirs in
  [1.13: a new language, whole](#113-a-new-language-whole).

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
  Tiếng Việt, Ελληνικά, Magyar, Română, and from 1.13 on العربية, עברית, فارسی) — the same in every file. The
  names *in the reader's language* (the keys `English`, `German`, … `Czech`, from 1.11 on `Dutch` … `Romanian`, and
  from 1.13 on `Arabic`, `Hebrew`, `Persian`) are translated. Where
  your language writes one of them as the English does (the German *Hindi*), say so in your report
  with the key: the lead adds it to `LANGUAGE_NAME_AS_ENGLISH` in the test, with its reason.

## Kept exactly

* Every `{n}` placeholder, as often as the key has it. A translation may reorder them.
* The marks, each as often as in the English: `~` (an estimate — ASCII, never `～`), `⚠` (a lower
  bound), `≈`, `–` (absence), `%`, `×`, `→` and the separator `·` (never `・`). In a language written right
  to left `→` and `←` are one mark ([1.13: right to left](#113-right-to-left)).
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
  an example (“~22 running”, “budget 63%”, “retry 1h12m”, the compact tooltip's header
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
`nl`, `uk`, `sv`, `nb`, `da`, `fi`, `hi`, `id`, `vi`, `el`, `hu`, `ro`; from 1.13 on also `ar`, `he`, `fa`):

| File | Made how |
|---|---|
| `l10n/parts/dashboard.<id>.json`, `l10n/parts/host.<id>.json`, `l10n/parts/model.<id>.json`, `l10n/parts/text.<id>.json` | written by you: exactly the keys of the German part of the same name, with your translations |
| `l10n/bundle.l10n.<id>.json` | generated: `node scripts/merge-l10n.mjs` |
| `package.nls.<id>.json` | written by you: every key of `package.nls.json`, in its order |
| `l10n/nls-sources/<id>.json` | generated: `node scripts/nls-sources.mjs <id>` — only once the manifest is translated: the record says your text translates today's English |
| `l10n/pending/<id>.json` | 1.10: written by `scripts/l10n-rekey.mjs` whenever the English changed — your work list; you empty it and delete it (the next section). A language new in 1.11 had none in 1.11; from 1.12 on every language beyond English and German has one while the English changes — but a language new in 1.13 (`ar`, `he`, `fa`), which is written whole |

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
  with a no-break space (U+00A0) before the colon in French, `{0}：` in Chinese (Japanese writes the
  ASCII colon `{0}:`, as its sentences do), `（）` around a figure in Chinese and Japanese, `、` between two items in Japanese and Chinese. Write no
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
   `{0} %` as your language writes a percent; the status bar keeps `25%` (notation) — the budget entry
   too (1.12): “budget 63%”.
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

## 1.12: your pending list

For the twenty-four languages beyond English and German — every one of the registry has its files since 1.11. 1.12's
ledger started at the 1.11.0 release (`node scripts/l10n-rekey.mjs --start d39c2df`) with an empty list for each of you;
the code packages' English changes filled it, and you work through it as
[the 1.10 section](#working-through-your-pending-list-110) says. A package holds six languages, one worktree.

1. `node scripts/l10n-rekey.mjs --print <id>`: translate every `translate` key into the parts it names, read every
   `review` key against the new English — keep it, or write it again —, and do every manifest key on the list.
2. Then `node scripts/merge-l10n.mjs`, `node scripts/nls-sources.mjs <id>` for each of your ids, and delete
   `l10n/pending/<id>.json`. The gates are the ones of [1.11: a new language, whole](#111-a-new-language-whole) (its
   item 11), for each of your six ids, ending in `test ! -e l10n/pending/<id>.json`.
3. What is new in 1.12, and what it needs:
   * **Notifications** are messages Token Pace sends to a phone, a chat or a mailbox, for the events the reader lists —
     `agentWaiting`, `agentDone`, `quotaThreshold`, `quotaExhausted`, `quotaReset`, `paceWarning` (ids, never
     translated). Their texts are read on a phone's lock screen: keep them short. A `{0}` in them is a product name —
     Claude Code or Codex ([the next section](#session-names-and-product-names-in-placeholders-112)).
   * **Alert ≠ notification.** An alert is the popup inside VS Code (`tokenPace.alerts.*`); a notification is a message
     sent outside it. Your word for the Alerts category (`configuration.alerts.title`, on your list for `review` with its
     English unchanged) and your word for the new category must differ, and the six alert sentences use your word for
     the in-editor popup.
   * **The consents' paragraphs keep the English's hard wraps** — a line break where the English has one —, as the 1.x
     consents do.
   * **The Keychain**: use Apple's name for it in your language as macOS shows it, if you know it, else your common word.
     `Claude Code-credentials` is the item's name and stays. "Always Allow" is a button of macOS: write macOS's own label
     in your language if you know it, else keep the English between your quotation marks.
   * **The range chips** "week to date" and "month to date" as your chips read them — the word you carried stays unless
     it is wrong.
   * **The budget example** of `config.statusBar.show.enum.budget` as your status bar prints it (T15 — copy what it
     prints).
   * **The ellipsis** as your language's typography sets it: the English's spacing of `…` is not a rule for your language.
   * **"record"** only for a personal best of the *Records* section.
   * **Backtick names stay as they are** (T5): the settings' fields `chatId`, `server`, `host`, `port`, `security`,
     `user`, `from`, `to`, `format`, `secretHeader`, and the event ids above.
   * **Names never translated** — T9 knows them since 1.12 (`SAME_IN_EVERY_LANGUAGE`): `CLAUDE_CODE_OAUTH_TOKEN`,
     `Secret Service`, `secret-tool`, `Slack`, `Discord`, `Microsoft Teams`, `Mattermost`, `Rocket.Chat`, `Telegram`,
     `ntfy`, `BotFather`, `SMTP`, `STARTTLS`. A test holds that every one of them, and the word `security` of the darwin
     paragraphs, stands in your value at least as often as in the key (repeat a name if you must, never translate or drop
     it), and that the notification texts (n=59–75) carry no `*`, `_`, `~` or backtick the key lacks (Review L 1.12).
   * **Your terms of 1.11 stay yours** — session, window, reset, quota, prompt, keep-warm, entry, record: a 1.12 key uses
     the word your language chose for the same concept in 1.11.
4. The questions 1.10's and 1.11's readers left for native speakers stay open: where a key of your list is one of them,
   keep the value you have and say so.
5. Your report opens with the line "Not a native speaker: the translations are an AI agent's." — then the branch and its
   commit, the gates with their exit codes, and per language the counts (runtime keys translated and reviewed, manifest
   keys), the words you chose for notification, alert, channel, Keychain, secret storage, webhook, cooldown and test
   message, any false positive of the frame named with its key (not worked around), anything in the English that looked
   wrong (reported, not changed), and the minutes it took.

## Session names and product names in placeholders (1.12)

Some placeholders receive a name, not a figure. The words around them are where 1.11's readers found the most defects —
a gender, a case ending, a word read twice — and no test judges those, so this section names the keys (the test's list is
`SESSION_NAME_KEYS` in `test/l10n.languages.test.ts`).

A session's name comes in two forms:

* **full** — "Session Tue 14:20 · 9d0eb37a" ("Session 9d0eb37a" where the session has no first line), your translation
  of `Session {0} · {1}` and `Session {0}`: it begins with your word for session. The keys that receive it:
  * `Token Pace will type “{0}” into the terminal that runs {1} and press Enter, so that its prompt cache stays warm. Click to cancel.`
  * `Keep-warm line for {0} in {1} seconds, press to cancel`
  * `Prompt cache of {0} cools in {1}`, `Prompt cache of {0} cools in {1}, and {2} more`,
    `Prompt cache of {0} cools in about {1} (estimated)`, `Prompt cache of {0} cools in about {1} (estimated), and {2} more`
  * `{0} · prompt cache warm · cools in {1} (1 h TTL)`, `{0} · prompt cache warm · cools in ~{1} (1 h TTL, estimated from the transcript)`,
    `{0} · prompt cache cools in {1} (1 h TTL)`, `{0} · prompt cache cools in ~{1} (1 h TTL, estimated from the transcript)`,
    `{0} · prompt cache cold since {1} (1 h TTL)`, `{0} · prompt cache cold since ~{1} (1 h TTL, estimated from the transcript)`
* **short** — "Tue 14:20 · 9d0eb37a", a time and an id without a word: the Records' lines, whose key names the session
  itself — `Longest session {0}: {1}`, `Largest session {0}: {1}`.

Each receives the name in its `{0}` — the keep-warm tooltip alone in its `{1}`.

1. In a **full** key never write your word for session before the placeholder: the name brings it, and the word would
   read twice ("Session Session Tue 14:20 …").
2. An adjective, a pronoun or a verb that refers to the session agrees with **your word for session** — its gender and
   its number (1.11: a Greek tooltip whose pronoun did not agree with the Greek word for session).
3. **A case ending cannot attach to a placeholder.** Where your grammar would inflect the name, use a construction that
   needs no case — the name in brackets, `({0})`, or as a label, `{0}:` (1.11: Russian, Czech, Polish, Ukrainian).
4. **A product-name placeholder** — the notifications' `{0}`, which is Claude Code or Codex — is a name: never
   translated, never inflected; rule 3's constructions where your grammar wants a case.
5. Your list's `why` for such a key says which form its placeholder carries.

## 1.13: right to left

For every language, and for Arabic, Hebrew and Persian above all. A right-to-left text is stored in **logical order** —
the order in which it is read and typed —, and the layout is the display's: the dashboard mirrors itself for these
languages, and on VS Code's own surfaces (the status bar, tooltips, Quick Picks, messages, dialogs), which VS Code lays
out left to right in every language, Token Pace wraps each text in invisible isolates of its own.

* **The isolates are the code's, never the translation's.** Never write a direction mark or an isolate — LRM U+200E,
  RLM U+200F, ALM U+061C, LRE … RLO U+202A–U+202E, LRI … PDI U+2066–U+2069 (T16) — not even to "fix" how a line looks in
  your editor: a mark in a value lands in the bar, in a screen reader's words and in every copy of the text.
* **Write in logical order, never in visual order**, and never reverse a Latin word or a number to make a line look
  right: the bidi algorithm lays it out. A placeholder is `{0}` as the key writes it — never `}0{` (a placeholder typed
  in visual order) and never `{٠}` (T16).
* **The arrows** (T4): in a language written right to left `→` and `←` count as one mark — as many arrows as the key
  has. Turn an arrow that shows the reading direction: a range, as in `Longest streak {0} days · {1} → {2}`, reads from
  the right, and the arrow that points on is `←` (`{1} ← {2}`); "scroll sideways for the remaining columns →" points to
  where the columns are in your layout. Keep `→` where it names something that stays left to right on the screen — a
  chart's axis, the time line of a chart. Every arrow you turned is named in your report, key by key.
* **Numbers**: the digits `0–9` only — never the Arabic-Indic `٠–٩` or the Persian `۰–۹` (T16): Token Pace formats every
  figure itself, with the digits 0–9 and the Gregorian calendar in all three languages, so a figure reads the same in the
  bar, on the page and in an export. A digit in your value is one the key has. The percent sign is `%`, never `٪` (T4
  counts `٪` as a `%` missing).
* **Names and code stay Latin inside the sentence**: Token Pace, Claude Code, Codex, the names of 1.12, `security`, every
  backtick span, setting id, path and command — written where your sentence needs them, in logical order.
* **Quotation marks**: `«…»` in Arabic and Persian (the logical `«` opens; the glyphs turn by themselves in a
  right-to-left line), `"…"` or `„…”` in Hebrew — one form throughout, named in your report.
* **Persian ZWNJ** (U+200C, the zero-width non-joiner inside a word, as in `سه‌شنبه`) and ZWJ (U+200D) are letters' business,
  not direction marks: T16 lets them stand.
* **No Arabic presentation form** (U+FB50–U+FDFF, U+FE70–U+FEFF — shaped letters, as a PDF's copy gives them): write the
  plain letters; a presentation form breaks search, copy and the font's own shaping (T16).
* **The native names**, by code point, in every file: `العربية` (U+0627 U+0644 U+0639 U+0631 U+0628 U+064A U+0629),
  `עברית` (U+05E2 U+05D1 U+05E8 U+05D9 U+05EA), `فارسی` (U+0641 U+0627 U+0631 U+0633 U+06CC — FARSI YEH, not the Arabic
  yeh U+064A).

## 1.13: a new language, whole

In 1.13 three languages join, each written right to left: `ar` العربية (Arabic), `he` עברית (Hebrew), `fa` فارسی
(Persian) — one package each, one at a time. Each is a whole translation, made once from the English at the frozen tip
(the commit the lead names), with the German as a second reference and the call site where both leave a doubt.
Another language's translation is not a source — not even Persian for Arabic script questions, or Arabic for Persian
terms. A new language is never a pending list.

Every item of [1.11: a new language, whole](#111-a-new-language-whole) holds for you — items 1 and 3–12 as they stand,
its register (item 2) replaced by the one below —, with [1.13: right to left](#113-right-to-left) and these notes:

1. **Register** — a reading of common UI practice, not verified against a style guide and not a native speaker's:
   decide for your language and give the reason in your report.
   * **Arabic**: Modern Standard Arabic; commands and buttons as verbal nouns (حفظ، إلغاء، فتح اللوحة); running sentences
     without a gendered second person where a construction can do without — the passive, the verbal noun, an
     impersonal يمكن —, else the masculine singular Arabic software uses.
   * **Hebrew**: commands in the infinitive or as nouns (לשמור / שמירה), instructions impersonal (יש ל…), no gendered
     imperative where the sentence can do without.
   * **Persian**: شما with plural verbs; commands as verbal nouns or infinitives (ذخیره، لغو).
2. **Plurals**: no plural rules in 1.13 either. Arabic's six categories (zero/one/two/few/many/other) and Hebrew's dual
   take the label form — "الجلسات: {0}", "סשנים: {0}" —, the same construction in every string of the kind, named in
   your report; Persian writes the singular noun after a numeral, so "{0} جلسه" is right as it stands.
3. **Weekday words** (T13): four characters or fewer, counted as grapheme clusters. Intl's short forms are longer (five
   to eight): Hebrew writes the short forms `א׳` … `ש׳`, Persian its one-letter forms `ی د س چ پ ج ش`, Arabic three
   letters or Intl's narrow forms `ح ن ث ر خ ج س` — your choice, named in your report.
4. **Marks**: the Arabic comma `،`, semicolon `؛` and question mark `؟` in Arabic and Persian sentences; `%`, `·`, `–` as
   the absence mark, `—` between clauses, `…`, and `~ ⚠ ≈` as the key has them (T4).
5. **Hard wraps**: a consent paragraph keeps the English's line count, each line ≤ 100 characters.
6. **The bar's examples** (T15) as your locale prints them with the digits 0–9 — forms such as `06:00 ص` in Arabic's
   12-hour clock, a weekday before the clock beyond a day: do not work them out; copy what T15 prints.
7. **The reset-clock slots**, the two words (an alert is the popup inside VS Code, a notification a message sent outside
   it — never one word for both), and "Always Allow" (macOS's own label in your language if you know it, else the English
   between your quotation marks): as [1.12: your pending list](#112-your-pending-list) and
   [1.13: your pending list](#113-your-pending-list) say.
8. **Terms**: your 30 hardest terms, and the word you chose for prompt, record (a personal best), entry (an agent's
   data), keep-warm, cold start, session, window, reset, quota, notification, alert, channel, Keychain, secret storage,
   cooldown and test message.
9. **Gates** — item 11 of the 1.11 section, with `out-test/bidi.test.js` in the test run from 1.13 on:

   ```
   node build.mjs --tests && systemd-run --user --scope -q -p MemoryMax=8G -p MemorySwapMax=0 env CI=true TZ=UTC \
     LANG=en_US.UTF-8 HOME=$(mktemp -d) NODE_OPTIONS=--max-old-space-size=6144 node --test \
     out-test/l10n.languages.test.js out-test/nls.test.js out-test/languages.test.js out-test/i18n.test.js \
     out-test/i18n.model.test.js out-test/i18n.text.test.js out-test/dashboard.test.js out-test/prompts.test.js \
     out-test/bidi.test.js
   node scripts/nls-sources.mjs --check --strict <id>
   test ! -e l10n/pending/<id>.json
   ```

10. **Your report** opens with the line "Not a native speaker: the translations are an AI agent's." — then the branch and
    its commit, the gates with their exit codes, the counts (runtime keys, part entries, manifest keys), the register,
    the plural construction, the terms of item 8, the weekday words, the arrows turned (key by key), the quotation marks,
    any false positive of the frame named with its key (not worked around), anything in the English that looked wrong
    (reported, not changed), and the minutes it took.

## 1.13: your pending list

For the twenty-four languages beyond English and German. 1.13's ledger started at the 1.12.0 release
(`node scripts/l10n-rekey.mjs --start a09a405`) with an empty list for each of you; the code packages' English changes
fill it, and you work through it as [the 1.10 section](#working-through-your-pending-list-110) says —
`node scripts/l10n-rekey.mjs --print <id>`, every `translate` key into the parts it names, every `review` key read against
the new English, every manifest key on the list, then `node scripts/merge-l10n.mjs`, `node scripts/nls-sources.mjs <id>`
and the file deleted (the gates of [1.11: a new language, whole](#111-a-new-language-whole), item 11, ending in
`test ! -e l10n/pending/<id>.json`).

1. **What to expect**, about eleven keys a language: the three language names `Arabic`, `Hebrew`, `Persian`
   (`translate`, as your dictionary writes them — where it writes one as the English does, say so with the key); the
   three native names, `nls-add` entries that already hold the right value, which you confirm; `config.language.description`
   (`review`: the count of translated languages, now twenty-seven); and four leftovers of 1.12 —
   `config.credentials.keychain.description` ("a VS Code window", `review`), `config.notifications.telegram.description`
   (the `@name` of a public Telegram channel, in your language's 1.12 word for a Telegram channel), the e-mail channel's
   setup hint (its field ids `host`, `user`, `from` and `to` in backticks now — keep each as it is) and
   `config.codexAppServer.mode.description` (the app-server ends, not the mode — a subject your grammar may need to say).
2. **The reset-clock slots** (`RESET_CLOCK_KEYS` in `test/l10n.languages.test.ts`). A reset clock is `14:20` today and
   `Thu 14:20` a day or more away — one slot, and the code decides which it holds. Write a form that reads with both: a
   label (`Reset: {0}`), a colon or brackets; never a preposition that takes a clock hour only (German *um*, Danish *kl.*,
   Ukrainian *о*, Greek *στις*). The slots:
   * `resets at {0}` ({0}), `resets at {0} (in {1})` ({0}) — the status bar's reset part;
   * `{0} (in {1})` ({0}), `{0} (reset due)` ({0}) — the reset with its countdown, and past its time;
   * `reset at {0}` ({0}) — the usage Quick Pick's line;
   * `{0}, {1} window: {2} used — resets at {3}.` ({3}), `{0}, {1} window: exhausted — resets at {2}.` ({2}) and
     `{0}, {1} window: {2} used, runs out at {3} — before it resets at {4}.` ({3} and {4}) — the notifications.

   Your 1.11 and 1.12 forms before these slots were read by 1.12's Review L and kept with their reasons: keep them
   unless your list names the key. The paragraph is for the three new languages and any later change; 1.13 turns the
   German to the label form („Reset: {0}").
3. The questions 1.10's, 1.11's and 1.12's readers left for native speakers stay open: where a key of your list is one of
   them, keep the value you have and say so.
4. Your report opens with the line "Not a native speaker: the translations are an AI agent's." — then the branch and its
   commit, the gates with their exit codes, per language the counts and the three language names, the subject you gave
   the app-server sentence, and anything that looked wrong (reported, not changed).

## 1.14: your pending list

For the twenty-seven languages beyond English and German — Arabic, Hebrew and Persian among them for the first time: a
language of 1.13 has its files since 1.13's join, so the ledger reaches it from 1.14 on. 1.14's ledger started at the
1.13.0 release (`node scripts/l10n-rekey.mjs --start c036c7c`) with an empty list for each of you; its entries fill it, and
you work through it as [the 1.10 section](#working-through-your-pending-list-110) says — `node scripts/l10n-rekey.mjs --print <id>`,
every `translate` key into the parts it names, every `review` key read against the English and its `why`, every manifest
key on the list, then `node scripts/merge-l10n.mjs`, `node scripts/nls-sources.mjs <id>` and the file deleted (the gates of
[1.11: a new language, whole](#111-a-new-language-whole), item 11, ending in `test ! -e l10n/pending/<id>.json`).

1. **The hard wraps** — the ledger's first nine entries, `review`, all in the `text` part: nine consent paragraphs that
   languages of 1.9 and 1.11 wrapped otherwise than the English (one line for the English's four, a line of 127
   characters). T17 holds them from 1.14 on ([1.14: hard wraps are a rule now](#114-hard-wraps-are-a-rule-now)): re-wrap
   each to the English's line count, every line at most 100 characters; where your words do not fit, shorten the
   sentence, never the facts. A value that keeps the wraps already stays as it is — say so.
2. **The project words** (`translate`): a project is shown by its label, which is data — its folder's name
   (`VS-Code_Tokens`) or a pseudonym (`p:8f31c0a4e2b1`) —, never translated, inflected or declined; write the sentence
   around it so that it reads with either, as with a session's name
   ([the section on names](#session-names-and-product-names-in-placeholders-112)). The keys whose placeholder receives a
   label are `PROJECT_LABEL_KEYS` in `test/l10n.languages.test.ts`; the package that adds them lists them here. Your words
   for project, session, filter and chip stay the ones of 1.11–1.13, and `projects ({0}) ▾` takes your form of
   `models ({0}) ▾`.
3. **The list separator** (`{0}, {1}`, `translate`): the comma your language writes between the items of a list of names:
   Arabic and Persian `،`, Chinese and Japanese `、` or `,` — your choice, named in your report. Never a direction mark
   (T16).
4. **The clock stamps** (`review`): the keys of [1.14: clock stamps](#114-clock-stamps) — the English is unchanged; check the
   word before the slot, keep it or change it, and say which.
5. **The reset in the explanation** (`review`): `{0} % used — over the limit until the reset at {1}.` and
   `{0} % used — exhausted until the reset at {1}.` — their slot `{1}` holds the reset's weekday a day or more ahead
   (`Thu 06:00`) from 1.14 on, as the reset-clock slots of [1.13: your pending list](#113-your-pending-list) do: a label or
   brackets before it, never a clock-only preposition.
6. **The bar's sentences** (`review` of two manifest keys, their `why` says "translate anew"):
   `config.timeProgressStyle.description` and `walkthrough.getStarted.readTheBar.description` read the bar by reaching the
   marker, no longer by left and right; Arabic, Hebrew and Persian read so since 1.13's fix pass — review and keep.
7. The questions 1.10's to 1.13's readers left for native speakers stay open: where a key of your list is one of them,
   keep the value you have where the English's meaning did not change, and say so.
8. Your report opens with the line "Not a native speaker: the translations are an AI agent's." — then the branch and its
   commit, the gates with their exit codes, per language the counts, the separator chosen, the clock-stamp slots changed
   (key, old → new, why) and kept, the hard wraps re-wrapped and shortened, your words for the project filter and
   `(no project)`, and anything in the English that looked wrong (reported, not changed).

## 1.14: clock stamps

A clock stamp is `14:20` for a time of today and `2026-09-26 14:20` for one of another day — one slot, and the code
decides which it holds (`clockStamp` in `src/time.ts`). The slot may hold `14:20` or `2026-09-26 14:20` — write a form
that reads with both: a label (`Recorded: {0}`), a colon or brackets; never a preposition that takes a clock hour only
(German *um*, Danish *kl.*, Ukrainian *о*, Greek *στις*) — the reset-clock slots' rule, for a slot that may hold a date.
1.14 turns the German to such forms („abgelehnt ({0})", „aufgezeichnet ({0})"). The slots, `CLOCK_STAMP_KEYS` in
`test/l10n.languages.test.ts`, which a scan of every `t()` and `tr()` call holds to the code:

* an agent in the tree — its last request, its end as the parent recorded it, its state inferred after or without it:
  * `rejected at {0}` ({0})
  * `rejected at {0} — {1}` ({0})
  * `Stopped — the parent recorded ‘{0}’ at {1}.` ({1})
  * `Failed — the parent recorded the failure at {0}.` ({0})
  * `Completed — the parent recorded the result at {0}.` ({0})
  * `Running — inferred: the transcript changed {0}, after an outcome was recorded at {1}.` ({1})
  * `Unknown — inferred: the transcript went on after an outcome was recorded at {0}, and has been silent since {1}.` ({0} and {1})
  * `Unknown — inferred: no result was recorded; the last request, at {0}, was rejected.` ({0})
  * `Unknown — inferred: no result was recorded; the last request, at {0}, was rejected — {1}.` ({0})
  * `Unknown — inferred: no result was recorded and the transcript has been silent since {0}, after a {1} call; the agent may have been stopped.` ({0})
  * `Unknown — inferred: no result was recorded and the transcript has been silent since {0}; the agent may have been stopped.` ({0})
  * `Unknown — inferred: the parent recorded the launch at {0} but no result, and the agent's transcript was never seen; the agent may have been stopped.` ({0})
  * `Idle — inferred: the session transcript has been silent since {0}.` ({0})
* a workflow run — its end as the parent recorded it, its state inferred, the run record's row:
  * `Stopped — the parent recorded ‘{0}’ for this run at {1}.` ({1})
  * `Failed — the parent recorded the failure of this run at {0}.` ({0})
  * `Completed — the parent recorded the end of this run at {0}.` ({0})
  * `Unknown — inferred: the parent launched this run at {0}, but no agent of it was ever seen.` ({0})
  * `Running — inferred: an agent of this run wrote on after the parent recorded its end at {0}.` ({0})
  * `{0} · started {1} · {2} agents · {3} tokens · {4} tool calls · {5} · default model {6}` ({1})
* the agent hook's wait, a recorded outcome ("done at 14:20"), the last compaction:
  * `The agent hook reported at {0}: waiting for approval.` ({0})
  * `The agent hook reported at {0}: waiting for input.` ({0})
  * `{0} at {1}` ({1})
  * `{0} · last at {1} (manual, {2} → {3})` ({1})
  * `{0} · last at {1} (auto, {2} → {3})` ({1})
  * `{0} · last at {1} (–, {2} → {3})` ({1})
* the prompt cache — its cold line, the cold start's cost, the Codex line — and the failed quota attempt:
  * `{0} · prompt cache cold since {1} (1 h TTL)` ({1})
  * `{0} · prompt cache cold since ~{1} (1 h TTL, estimated from the transcript)` ({1})
  * `A cold start after {0} re-writes {1} tokens instead of reading them from the cache.` ({0})
  * `A cold start after {0} re-writes {1} tokens at the 1 h write rate ({2}× input, {3}) instead of reading them from the cache ({4}× input, {5}).` ({0})
  * `A cold start after {0} re-writes {1} tokens at the 1 h write rate ({2}× input) instead of reading them from the cache ({3}× input).` ({0})
  * `Codex prompt cache · last request at {0} · OpenAI keeps a cached prompt prefix at least 30 minutes after its last use for GPT-5.6 and later — ~until {1}, perhaps longer.` ({0} and {1})
  * `Last attempt at {0} failed: {1}` ({0})
* the page's words a screen reader gets for a row's clock:
  * `silent since {0}` ({0})
  * `since {0}` ({0})

A key that takes a clock of today alone is not one — `{0} finished a turn at {1}`, `This channel works: Token Pace can
reach it. Sent at {0}.` —: its slot never holds a date.

## 1.14: hard wraps are a rule now

Since 1.12 this brief has asked the consents' paragraphs to keep the English's hard wraps — a line break where the
English has one —, and 1.13 added "each line ≤ 100 characters"; no test held it, and many values of 1.9 and 1.11 wrap
otherwise. **T17** holds it from 1.14 on, in every language, German included:

* a runtime value whose English holds a line break, every English line at most 100 characters, is **hard-wrapped**: it has
  exactly as many lines as the English, each at most 100 characters, counted as a reader sees them (grapheme clusters,
  as T13 counts);
* a value whose English has a longer line — the Keychain paragraph, whose lines reach 236 — is a **paragraph**: exactly as
  many lines as the English, no length rule;
* a manifest value whose English has a line break inside a paragraph — a fenced JSON example, the walkthrough's list of
  command links — keeps the English's number of lines.

A key on your pending list is exempt while it is listed; at the join every value is held. Break where the English breaks
where your word order allows, else where a line reaches 100 characters; keep the English's indentation (the two spaces
before a bullet's following lines); never break inside a URL, a path, a placeholder or a backtick span. The German three
that missed the rule were re-wrapped with it in 1.14 — two of them a little shorter, since their words did not fit in the
English's lines of 100.

## The gates

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
  `·`, is named wherever it stands; in a language written right to left (Arabic, Hebrew, Persian) `→` and `←` count as
  one mark (1.13).
* **T5 · Code** — backtick spans, `tokenPace.…` ids, `$(…)` codicons, `command:` targets and
  paragraphs as the key has them; in the manifest also the setting links, command links, fences and
  JSON examples.
* **T6 · Page words** — no `<`, `>`, `"`, `&` in a translation of one of the page's words.
* **T7 · Tone** — no exclamation mark.
* **T8 · Tables** — a key that starts with `| ` keeps its pipes.
* **T9 · No English left** — once placeholders, code, paths, model ids and the words of
  `SAME_IN_EVERY_LANGUAGE` (the names above, the abbreviations `API`, `USD`, `CSV`, `JSON`, `TTL`,
  `ID`, `HTTP`, `TLS`, `OAuth`, `CLI`, `P90`, `CV`, `ctx`, the units, `Quick Pick`, the literal command
  `codex app-server`, the colour ids `paceWarn` and `paceAhead`, and from 1.12 on the names of
  [1.12: your pending list](#112-your-pending-list)) are taken out — a name of several words also where a line break
  splits it (1.12):
  in a Latin-script language a key of three words or more is never its own translation and no four
  words of the key stand in a row in the value; in Japanese, Korean, Chinese, Russian — from 1.11
  on Ukrainian, Greek and Hindi, and from 1.13 on Arabic, Hebrew and Persian — no value keeps three Latin words in a row — a `×` or `÷` between two
  of them ends the run. Vietnamese is written in Latin letters and held by the first rule. No manifest entry
  of 40 characters or more is the English. A manifest key on your pending list is left out of T3, T4,
  T5, T7 and T9 until it is done: its value is the English, or your translation of the English before
  the change. A key that names a setting's fields by their ids writes them as code (1.13): the e-mail channel's setup
  hint has `host`, `user`, `from` and `to` in backticks — keep each in its backticks as it is (T5), and T9 takes the
  code out before it compares; bare, the four are English words it catches.
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
  `config.density.enum.*`, `config.summary.period.enum.*`, `config.resetHourCycle.enum.*` and (1.12)
  `config.statusBar.show.enum.budget` (the
  text between two of T11's quotation marks; a no-break space reads as a space, and an apostrophe
  between two letters — aujourd’hui, dell’ora — is a letter of the word, not a mark) is a text your
  language's status bar prints — your bundle's words, your locale's decimals, weekday and 12-hour
  clock — for this fixture: Monday 2026-09-28, 03:46 UTC; Claude Code's 5 h window at 25 % with its
  reset 2 h 14 min away (06:00), its 7 d window at 69 % with 6 days left; 3.1M tokens today, 12.3M
  in 7 days, 48.9M in 30; a budget of 4.92M Claude Code tokens a day, so today's 3.1M are 63 %
  (“budget 63%”). The reset formats and hour cycles show no bar, `full` a bar of width 8
  without the time marker, `compact` both windows; the weekday example is the same reset read two
  days before it, and `minimal` the 5 h window alone at 01:30, where 25 % runs ahead of the pace
  (`▲`). So the English “CC 5h 25% · resets 2h14m” is “CC 5h 25% · Reset in 2h14m” in German, and
  “Σ 3.1M · today” is “Σ 3,1M · heute”. A value quotes as many examples as the English. A key on
  your pending list is left out until it is done.
* **T16 · Direction** (1.13) — no value writes a bidi control (U+061C, U+200E, U+200F, U+202A–U+202E, U+2066–U+2069)
  the key lacks — the isolates are the code's —, a digit of another script (any decimal digit but `0–9`), an Arabic
  presentation form (U+FB50–U+FDFF, U+FE70–U+FEFF), or a placeholder turned or in other digits (`}0{`, `{٠}`); ZWNJ and
  ZWJ may stand. In every language, not only the three written right to left ([1.13: right to left](#113-right-to-left)).
* **T17 · Wraps** (1.14) — a value whose English is hard-wrapped (a line break, every English line at most 100
  characters) has as many lines as the English, each at most 100 characters, counted in grapheme clusters; a paragraph
  value (an English line longer than that) and a manifest value with a line break inside a paragraph (a fenced example, a
  list of links) have as many lines as the English. A key on your pending list is exempt until it is done
  ([1.14: hard wraps are a rule now](#114-hard-wraps-are-a-rule-now)).

A rule that is wrong about a string — English that is right to keep, say — is **reported with its
key**, not worked around and not edited: the lead extends `SAME_IN_EVERY_LANGUAGE` when the languages
are joined. Do not run the dashboard harness (its output folder is shared); the join runs it once for
every language.

## Your report

The branch and its commit; the gates' results (a false positive named with its key); your 30
hardest terms; anything in the English that looked wrong; the time it took. In 1.10 also: how many
keys of your list you translated, reviewed and did in the manifest.
