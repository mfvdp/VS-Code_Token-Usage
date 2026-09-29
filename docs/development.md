<!--
SPDX-FileCopyrightText: 2026 Frederik Marx
SPDX-License-Identifier: AGPL-3.0-or-later
-->

# Building and testing

Part of the [Token Pace documentation](../README.md#documentation).

No runtime dependencies; the bundles are built with esbuild.

```bash
npm install
npm run build          # dist/extension.js, dist/scanWorker.js, dist/statusline-bridge.js, dist/agent-hook.js
npm run watch          # the same, rebuilt on change
npm run typecheck      # tsc --noEmit
npm test               # builds the tests, then node --test "out-test/*.test.js"
npm run test:e2e       # the extension-host smoke test in a real window (needs a display)
npm run check:privacy  # http(s) literals in dist/ against the allow-list, the read contract, src/'s network call sites against NETWORK_SITES, and the hook bundle's fs/path-only rule
npm run package        # build + privacy check + vsce package
```

The tests are plain `node:test` with `node:assert/strict` over synthetic fixtures — never a real
transcript. Every module that has to stay testable (and loadable in the scan worker) is free of
any `vscode` import: the parsers, the aggregator, the pace and price logic, the statistics, the
forecast, the view model, the status bar texts, the serialisers, the bridge script and the agent
hook's script. The four bundles are the extension itself, the scan worker, the status-line bridge
script and the agent hook's script (`dist/agent-hook.js`, which the *Set Up the Agent Hook…*
command copies into the extension's storage and Claude Code runs; built on Node's `fs` and `path`
alone, which `check:privacy` enforces).

The wiring test (`test/extension.test.ts`) runs the real `activate()` against a fake extension
host (`test/helpers/fakeVscode.ts`) that behaves like VS Code where the order of events matters:
once an activation's subscriptions are disposed, a settings change or a change of the window's
focus no longer reaches it. Each test waits for its own activation's cold start — the `Σ` of the
tokens entry on the fake status bar, which only a live activation draws — and never for a
`Cold start done` line in the shared log, which an activation disposed a moment before could have
written; the extension, for its part, drops a cold scan's answer that arrives after the window has
gone.

The version probe behind the quota fetch's user agent (`test/poller.test.ts`) has every edge
injected — the platform, the `PATH`, the file check and the start of the process —, so its Windows
cases run the same on every runner, and no test starts a process or reads the real `PATH`. A
view-model build copies the buckets once and hands that one copy to every table (one copy instead
of 25; the figures are the same, which a test compares with the copy-per-table path); a statistic
called without that copy, as a test may call one, still takes its own.

Since 1.12 two kinds of test reach beyond their own process, and each cleans up after itself: the Codex app-server's
tests start a stand-in child (`process.execPath` with a small script the test writes) and end it in a `finally`,
asserting its process gone; the notification channels' tests open servers on `127.0.0.1`, port 0 — HTTPS and SMTP
with a throwaway certificate `openssl` makes in a temporary directory, skipped with the reason printed where `openssl`
is not on the `PATH` — and close them. No test reaches the network: the fetch and the sockets are injected, and a
static test holds `test/` free of a real service's host.

Since 1.13 `src/bidi.ts` is the only module that writes a direction mark (RLI, LRI, PDI, RLM), always as an escape —
a test finds no literal bidi control in any file of `src/`, the rule VS Code 1.62 applied to its own sources —, and
every message, Quick Pick, InputBox and progress notification goes through `src/hostUi.ts`, which marks its texts in
a right-to-left language and hands back the caller's own label: a static test finds those VS Code API names nowhere
else in `src/`. The isolate test renders every text of every right-to-left bundle through the marks and holds them
balanced, idempotent and lossless, and a leak test holds the diagnostics, the exports, the markdown document, the view
model, the notifications' JSON fields and every accessible name free of them.

A handful of questions a fake host cannot answer run in a real editor: `npm run test:e2e` downloads
VS Code stable into `.vscode-test/`, starts it with this extension in development mode, every other
extension disabled, a user-data directory of its own and a fresh `HOME` — so the smoke test never
sees a real transcript — and asserts that the extension activates, that every contributed command is
registered, that the status-bar preview runs, that a settings change reaches the status bar without
a window reload, that a change of `tokenPace.language` does too — the status bar turns German and
back to English (1.9) —, and that the dashboard command opens its view. Since 1.10 it also lists
`prompts` among the sections through the configuration API, sees the Prompts section drawn, and asks
the extension's exported API, `promptSendCheck(id)`, what a send would decide with no Claude Code or
Codex terminal open — `noTerminal`, nothing typed. That seam answers a code, never a text, and only
while the extension host runs in test mode; in a normal window it answers `notListed` before reading
anything. Since 1.12 it finds the three notification commands registered and asks `notifyCheck()` — `noChannel`
with no channel set up, no request made —, gated on the test mode the same way. Since 1.13 a ninth check sets
`tokenPace.language` to `ar` and finds every status bar entry with a word opening a right-to-left isolate right after its
icons and closing it, balanced — the first entry given an icon by an empty `tokenPace.claudeQuotaSources` in the
throwaway profile —, and back under `auto` the very English texts without a mark. The settings check is why it exists
at all: from 1.0 to 1.2 every settings change quietly
waited for a window reload, and ~800 unit tests against a fake host could not see it.

CI runs type check, build, tests and the privacy check on **ubuntu, macOS and windows** — the
transcript readers touch paths, inodes and line endings, and Windows is where the bar glyphs and
the path handling actually differ. The smoke test runs under `xvfb` on ubuntu in a job of its
own, so the unit matrix stays fast. CodeQL, a dependency review and a gitleaks scan run alongside.
Pushing a `v*` tag builds the `.vsix`, creates a GitHub release and publishes to both the Visual
Studio Marketplace and **Open VSX** — the latter is what makes the extension installable in
VSCodium at all. Cursor and Windsurf are published to from the same registry, but they run an
older VS Code base than the `^1.106.0` engine floor the secondary-sidebar contribution point
needs, so they cannot install it until they rebase. Each publish step is skipped rather than failed when its
token is not configured, so a fork can produce the `.vsix` without any secrets.

**Commit trailers.** Since 1.5 a commit written with an AI coding assistant names, in its
`Co-Authored-By:` trailer, the model that actually wrote it — so the commits of one release can
name different models, and the history tells which part came from which.

The recipe itself — what to run in which order, the two secrets it needs and the publisher
verification — is in [Releasing](release.md).

## Translating

Every text Token Pace shows goes through one seam, `t()` in `src/i18n.ts`, and the English message is
the key. The languages are listed once, in `src/languages.ts` (`LANGUAGES`: the id, the `Intl` locale,
the native name and the flag, in the picker's order), and every file of a language is named after its
id — seven files per language, and a translation touches no other (while the English changes, an
eighth: its pending list, [below](#changing-the-english-the-re-key-ledger-110)):

* `l10n/parts/<part>.<id>.json` — the runtime translations in four parts, `dashboard`, `host`, `model`
  and `text`, each with exactly the keys of the German part of the same name. The parts follow the
  areas of the code, so two changes that add strings to different areas never touch one file; a key
  that stands in two parts has the same translation in both.
* `l10n/bundle.l10n.<id>.json` — what the extension reads, generated from the parts by
  `node scripts/merge-l10n.mjs` (keys sorted, two different translations of one key refused);
  `--check` fails while a bundle differs from its parts.
* `package.nls.<id>.json` — the manifest's words: every key of `package.nls.json`, in its order. VS Code
  reads it when it starts, for its own display language.
* `l10n/nls-sources/<id>.json` — the freshness record: for every manifest key, the first 16 hex digits
  of the SHA-256 of the English it was translated from, written by `node scripts/nls-sources.mjs <id>`
  once the translation is done. `node scripts/nls-sources.mjs --check` names every language and key
  whose English changed since. A runtime string needs no record: its key is its English, so a changed
  sentence is a new key that every language lacks.

Since 1.13 an entry may carry three more fields, and exactly Arabic, Hebrew and Persian do — a test holds it:
`dir: 'rtl'` (`languageDir` gives the page's direction and the direction of the marks on VS Code's surfaces; an entry
without it is left to right), `digits: 'latn'` and `calendar: 'gregory'` (`intlTag` adds `-u-ca-gregory-nu-latn` to the
`Intl` tag, so that the three print the digits 0–9 and Gregorian dates under any ICU, chosen or under `auto`).

A language's own gates — the ones a translation runs before it is merged; the whole suite runs once
all of them are in:

```bash
node build.mjs
node build.mjs --tests && CI=true TZ=UTC LANG=en_US.UTF-8 HOME=$(mktemp -d) node --test \
  out-test/l10n.languages.test.js out-test/nls.test.js out-test/languages.test.js out-test/i18n.test.js \
  out-test/i18n.model.test.js out-test/i18n.text.test.js out-test/dashboard.test.js
node scripts/check-privacy.mjs
node scripts/merge-l10n.mjs --check    # every bundle equals its parts
node scripts/nls-sources.mjs --check   # every manifest translation matches today's English
node scripts/l10n-rekey.mjs --check    # every entry of the re-key ledger applied to every language (1.10)
```

`test/l10n.languages.test.ts` holds every language on disk to the same sixteen rules, T1–T16: the
keys, the parts, the placeholders, the marks (`~`, `⚠`, `≈`, `–`, `%`, `×`, `→`, `·`), the code
(backtick spans, setting ids, codicons, command targets, links, fences, JSON examples), the page's words
(no markup character), the tone (no exclamation mark), the tables, no English left (proper names and
code excepted — the list `SAME_IN_EVERY_LANGUAGE` in the test, each word with its reason), the registry,
the English quotes (the keep-warm consent's terms passage and line stay word for word), the freshness
and the heat map's weekday words — the thirteen of 1.9 — and, since 1.10, T14 for the pending lists
([below](#changing-the-english-the-re-key-ledger-110)) and T15 for the bar's own examples:
every example a setting of the status bar quotes (`CC 5h 25% · resets 2h14m`, `Σ 3.1M · today`) is what
that language's bar prints for the fixture the test and the brief document — its words, its decimals, its
weekday and its 12-hour clock —, the English's included — and, since 1.13, T16 for the direction: no bidi control
in a value, no digit of another script, no Arabic presentation form, a placeholder only as `{n}` with ASCII digits.
Every rule also runs once against a synthetic
language in a temporary directory — the German under another id, and the English with every word turned
into 語 (since 1.11 also into शुक्र, under `hi`, and since 1.13 into كلمة with every `→` turned `←`, under `ar`) —
broken in the one way the rule exists to catch (T15,
which reads the bar under the id's own locale, against the English and a copy of the Czech files instead). `test/nls.test.ts` holds every manifest translation to the
manifest's structure. The brief a translation works from is `l10n/TRANSLATING.md`. Nothing of this
ships but the bundles and the `package.nls*.json` files: `.vscodeignore` keeps `l10n/parts/`,
`l10n/nls-sources/` and the brief out of the package — and, since 1.10, `l10n/rekey.json`,
`l10n/rekey-base.json` and `l10n/pending/`.

While translations are being made, the English is frozen: a changed runtime text changes its key and
fails every language's T1 at once, and a changed manifest sentence, which keeps its key, is what the
freshness record catches. A new language is a registry entry and its files; the tests, the picker
(which offers every language whose bundle is on disk) and the dashboard harness (a `main-<id>` page in
both themes at 260 and 420 px) pick it up by themselves. What the reader sees of all this is in
[Languages](languages.md).

### Changing the English: the re-key ledger (1.10)

A runtime string's key is its English, so a changed sentence is a new key that every language lacks, and
twelve languages fail T1 and T2 at once. 1.9 therefore froze the English while its languages were
translated. In 1.10 the English changes while the code is written, and each change is recorded where the
languages' files can follow it at once:

* `l10n/rekey.json` — the ledger: `{ "v": 1, "base": "<sha>", "entries": [ … ] }`, append-only, one entry
  per change in the order made, numbered from 1 (`n`), each naming the package that made it (`by`) and
  why (`why`). One entry per line keeps a diff readable. A `why` never holds `; ` — the script joins the
  reasons of one key with it and splits on it again —, and `--check` refuses one.
* `l10n/rekey-base.json` — the tree the ledger starts from (1.10's was `e72057a`, the 1.9.0 release: 1123
  `t()` keys, 295 manifest keys; 1.11's was `b89ff43`, the 1.10.0 release: 1197 and 297; 1.12's is `d39c2df`, the
  1.11.0 release: 1240 and 309): every `t()` key
  with the German parts it stands in, and the first 16 hex digits of the SHA-256 of every `package.nls.json`
  value.
* `l10n/pending/<id>.json` — per language beyond English and German: how many entries are applied to its
  files (`applied`) and what is left to do — each bundle key with the parts it is listed for and its
  state (`translate` while a listed part lacks it, `review` once every listed part holds a value carried
  over or kept), and each manifest key with its state.

An entry has `n`, `by`, `kind` and `why`, and exactly the fields of its kind:

| Kind | Fields | What `scripts/l10n-rekey.mjs` does in each language |
|---|---|---|
| `add` | `part`, `key` | nothing written; the key listed `translate` for that part |
| `reword` | `part`, `old`, `key`, `carry` | `carry: true` — the old translation still says what the new English says, a grammar fix, say —: the old key's value moved to the new key, listed `review`; `carry: false`: the old key taken out, the new one listed `translate`. A reworded key that was pending stays pending under its new key |
| `remove` | `part`, `old` | the key taken out of the part and off the list |
| `copy` | `from`, `part`, `key` | a key a second part now uses too: the language's value copied from `from` (so `merge-l10n.mjs` sees one translation in two parts), and listed for `part` when it is listed for `from` |
| `review` | `part`, `key` | the English is unchanged but its use narrowed: listed `review`, the value stays |
| `nls-add` | `key` | put into `package.nls.<id>.json` at the English file's position, with the English value, listed `translate` |
| `nls-reword` | `key` | the value stays, listed `review` |
| `nls-remove` | `key` | taken out of the manifest, the freshness record and the list |

German is never in the ledger's hands: the package that changes the English writes the German parts and
`package.nls.de.json` itself, as every package since 1.2 — then `node scripts/merge-l10n.mjs`, for a
manifest change `node scripts/nls-sources.mjs de`, appends its entries and runs
`node scripts/l10n-rekey.mjs`; the edits of the twelve languages' files that follow are part of its commit.

```bash
node scripts/l10n-rekey.mjs                 # applies every entry after each language's cursor, then merges the bundles
node scripts/l10n-rekey.mjs --check         # every entry well-formed and applied; no list for German, none for English
node scripts/l10n-rekey.mjs --print <id>    # a language's work list: key, part, state, English, German, the value it holds, why
node scripts/l10n-rekey.mjs --start <sha>   # a new ledger at the tree as it is — refused while a language has work pending
```

A second run changes no byte. A key listed `translate` is absent from the language's parts and bundle, so
`t()` falls back to the English — on the build branch only —, and a pending manifest key holds the English
value: nothing is invented. A language without a pending list has done everything the ledger asks:
`--start` writes a list at cursor 0 for every language, and the language's own package works it through,
records its manifest and deletes the list. The next version's first change of the English starts a new
ledger. `--start` writes the new base and an empty ledger: the entries of the version before are not
carried over — each is applied, no list of theirs is left, and they stay in the history (1.10's 115 at
`b89ff43`, 1.11's 67 at `d39c2df`, 1.12's 121 at `a09a405`). 1.11's ledger started at `b89ff43`, before its first English change; 1.12's
at `d39c2df` (`node scripts/l10n-rekey.mjs --start d39c2df`), with a list at cursor 0 for each of the twenty-four
languages beyond English and German — every one has its files since 1.11. It holds 121 entries: the code packages'
English changes, each with its German, until the English was frozen; the twenty-four languages then worked through
their lists in four packages of six, and at the join `PENDING_ALLOWED` went back to false and
`node scripts/nls-sources.mjs --check --strict` became the gate again. 1.13's ledger started at the 1.12.0 release
(`node scripts/l10n-rekey.mjs --start a09a405`: 1303 `t()` keys, 331 manifest keys) with a list at cursor 0 for each of
the twenty-four, and `PENDING_ALLOWED` was true again until 1.13's join. It holds 11 entries — the three new language
names and native names, the settings' count of translated languages, and four settings' and one message's wording —,
which the twenty-four worked through in one package; at the join `PENDING_ALLOWED` went back to false, with no list
left. The three languages 1.13 adds — Arabic, Hebrew and Persian — are never on it: they have no file before their
packages write them whole from the frozen English, and `--start` passes over a language without files. Four tests read
the live ledger's figures until then — the kept-names guard's seventeen notification texts, the 1.12.0 notes' base
and count, the languages page's count and this page's own — and hold literals of history since
(`NOTIFY_TEXT_KEYS_1_12`, 121 entries on base `d39c2df`).

While lists exist (`PENDING_ALLOWED` in `test/l10n.languages.test.ts` is true), the frame reads them: T1
and T2 let a key listed `translate` be absent, a manifest key on a list stays out of the rules that
compare a value with today's English (T3, T4, T5, T7, T9 and the manifest checks of `test/nls.test.ts`),
and `node scripts/nls-sources.mjs --check` reports it as pending, not stale. **T14** holds the lists
themselves: their keys in today's English and in the German parts they name, the ledger applied to its
end, none for German. The ledger's own test replays the entries on the base and asks for today's German
parts, `t()` keys and manifest — so an English change without its entry fails, in the package that made
it. T9, for its part, lets a `×` or `÷` between two Latin words end a run of English (`scope × period ×
unit` in a Chinese sentence).

1.10's order: the code packages change the English, each change with its German and its entries; the
English is frozen again after the second review, and the twelve language packages start from that commit
— each owns its seven files and its list, and runs `node scripts/nls-sources.mjs --check --strict <id>`
(every manifest key of its own, pending or not) before it is merged. At the join `PENDING_ALLOWED` is
false: no list may be left (T14), every rule holds every key again, and
`node scripts/nls-sources.mjs --check --strict` is the gate from then on.

### Two kinds of language work, and the frame for twenty-four languages (1.11)

From 1.11 a language is made in one of two ways. A language new to the registry is a **whole
translation** from the frozen English, the German beside it: its package writes the four parts and the
manifest translation at once and generates the bundle and the record — never a pending list, since
`scripts/l10n-rekey.mjs` passes over a language with no file on disk, so the ledger never reaches it. A
language that exists **works through its pending list** as above. The brief has a section for each
("1.11: a new language, whole", "1.11: your pending list").

The frame was taught the twelve new languages before any of them was written, each rule once, for every
language. `NON_LATIN` names every language of another script: Ukrainian, Greek and Hindi joined
Japanese, Korean, Chinese and Russian, while Vietnamese is written in Latin letters and held by the Latin
rule. T13 counts grapheme clusters (`Intl.Segmenter`), the characters a reader sees, where it counted
code points — a Hindi weekday such as `शुक्र` is two on the screen and five code points; for every
language of 1.10 the two counts are equal. `”` may open a quotation (Swedish and Finnish). T4 counts the
marks of the NFC form, in which the Greek ano teleia is the separator `·`, and names it. T10 lets a
language name the ledger has just added be missing while it is pending, and a name equal to the English
stand only where `LANGUAGE_NAME_AS_ENGLISH` says the language writes it so (German *Hindi*). A third
synthetic language — the English with every word turned into शुक्र, under `hi` — runs every rule.

In 1.12 the frame learned three things before a single 1.12 text was written, and three more while the languages
were made. T9 takes the names those texts carry
out of a text as it takes the product names (`NAMES_OF_1_12` in `SAME_IN_EVERY_LANGUAGE`: `CLAUDE_CODE_OAUTH_TOKEN`,
`Secret Service`, `secret-tool`, the notification channels' services and the protocols `SMTP` and `STARTTLS`), and a
name of several words also where a line break splits it ("Claude" at a line's end and "Code" at the next line's start
are the name Claude Code, not the name Claude and the English word Code). `SESSION_NAME_KEYS` lists the `t()` keys
whose placeholder receives a session's name — the full name ("Session Tue 14:20 · 9d0eb37a") or the short one ("Tue
14:20 · 9d0eb37a") —, where a translation must mind gender and case in a way no rule can judge: a test scans every
`t()` call of `src/` with the TypeScript parser for the expressions that carry a name (`SESSION_NAME_CARRIERS`) and
asks for exactly the listed keys, pins the calls that make a name (`SESSION_NAME_SOURCES`), and holds the brief's
section "Session names and product names in placeholders" to the list. While the languages were made:
`FIELD_IDS_OF_A_KEY` — a key that names a setting's fields by their ids keeps them in English (`host`, `user`, `from`
and `to` of the e-mail channel's setup check), and T9 takes them out of that key and its value alone, beside
`SAME_IN_EVERY_LANGUAGE` and `ADDED_AT_THE_JOIN`, which take a name out of every text; the kept-names guard — every
name of `NAMES_OF_1_12` and the word `security` (macOS's tool) stand in a value at least as often as in its key,
repeated perhaps, never translated or dropped, and the seventeen notification texts carry no `*`, `_`, `~` or
backtick their English lacks, since they go to chat services as they are; and the session-name scan over the page's
own `tr()` calls too (`src/webview/main.ts` has its own `tr`), with `SESSION_NAME_PAGE_FIELDS`, the fields a session's
name travels in on the page.

In 1.13 the frame learned right to left before a single Arabic, Hebrew or Persian value was written, each rule once, for
every language. **T16** holds the direction: no bidi control (U+061C, U+200E, U+200F, U+202A–U+202E, U+2066–U+2069) in a
value — the isolates are the code's, never a translation's —, no decimal digit but `0–9`, no Arabic presentation form,
and a placeholder only as `{n}` with ASCII digits (never `}0{` typed in visual order, never `{٠}`); ZWNJ and ZWJ, which
Persian writes inside words, may stand. `NON_LATIN` gains `ar`, `he` and `fa` (`NEW_IN_1_13` beside the registry until
it has them). **The arrow rule**: T4 counts `→` and `←` as one mark in a language `RTL_LANGUAGES` names — read from the
registry's `languageDir`, never a list of the frame's own —, since a right-to-left reader reads a range from the right
and the arrow that points on there is `←`. A fourth synthetic language, the English with every word turned into كلمة and
every `→` into `←` under `ar`, runs every rule; its texts are `pseudoRtlBundle()` of `test/helpers/nls.ts`, which the
isolate test and the harness install where no right-to-left translation exists yet, made with the frame's own pattern
(`protectedPattern`, from the names the helper reads out of the frame's source — a test holds the two equal).
`RESET_CLOCK_KEYS` lists the `t()` keys whose placeholder receives a reset clock that may carry a weekday (`14:20`
today, `Thu 14:20` beyond) — where a translation needs a form that reads with both, a label rather than a clock-only
preposition such as German *um*: a scan of every `t()` and `tr()` call follows `resetClock` and `formatReset`'s absolute
and `both` forms through variables, local functions, fields and wrapper calls into the arguments, asks for exactly the
listed keys (the one excepted key with its reason, `RESET_CLOCK_EXCEPTED`) and pins the two functions' calls
(`RESET_CLOCK_SOURCES`); the brief names every key. `FIELD_IDS_OF_A_KEY` is empty since 1.13: the e-mail setup check
writes its field ids as code (`` `host` ``, `` `user` ``, `` `from` ``, `` `to` ``), which T9 takes out as it takes every code
span, and T5 holds each backtick span in every value — the declaration and its guard stay, the guard's cases on a
synthetic key. At the join the frame needed no new exception: no list of names, no language name and no T16 exception
was added for the three.

## The price table

`src/prices.ts` is the price table: per model a list of dated rules, newest first — `from`, an optional
`until`, the rates and a `source` naming the page the rule was read from, one of the hosts of
`PRICE_SOURCE_PAGES`. `PRICES_AS_OF` is the day the table was checked whole, `LEGACY_CHECKED` the earlier check
of the Claude 4.x and 3.x rows, `OPUS_5_5_CHECKED` the day of the Claude Opus 5.5 row; `PRICES_CHECKED_LATER`
lists the rows read after `PRICES_AS_OF`, and the dashboard's footnote, the tooltips' price line and the JSON
export's `pricing` print them from there. `test/prices.test.ts` holds the table's hygiene — every rule dated,
sourced and newest first, a model's rules meeting without a gap or an overlap, a rule closed without a
successor only when `CLOSED_ON_PURPOSE` names it with a comment, every source a known host —, and
`test/docs.test.ts` holds the three days of [The “API cost” column](cost.md) to the constants, written by one
formatter, and the README to no price date at all. **A re-check of the table, or a new row, is a CHANGELOG
line**: the CHANGELOG is the table's ledger. Change the constant or the rule in `src/prices.ts` and the
sentence in `docs/cost.md`, and say so under the next version; no other page carries a date of the table.

## Performance

The dashboard is a webview: everything it draws reaches it as a message, which the editor serialises
and the page takes in. The host therefore sends the page what it draws, and nothing else:

* **One section at a time.** After the first whole page, a push carries the fields of one section — of
  a section whose fields changed and that the page shows (`SECTION_FIELDS`, `shownSections` in
  `src/dashboard.ts`); the Agents section at most every two seconds (`SECTION_MIN_INTERVAL_MS`), a
  reader's own click on it at once.
* **Nothing for a section the page has taken out.** While the provider switch shows Codex, the page
  leaves the Agents and Context sections out, and the host still builds them whole — the agent poll and
  the status bar's `agents` entry read the tree. The fragment that takes each section off the page goes;
  after it no fragment of either is pushed until the switch shows Claude Code again — alone or under
  All —, and then each comes back whole, with the newest data. On the harness's large run (one session
  with a workflow run of 427 agents, both opened), a minute of a running agent under Codex pushed twelve
  Agents fragments of about 37 KB each — 441 KB the page dropped unread; now it pushes none.
* **No second copy of the budgets.** The view model keeps every budget whatever the switch shows
  (`allBudgets`), for the status bar's `budget` entry and the budget alerts; the page draws the rows of
  its view (`budgets`) and never reads the other list, so the whole-page push leaves it out
  (`pagePayload`, `HOST_ONLY_FIELDS`). Under All the two are the same rows: with three budgets
  configured, a whole-page push is 1.6 KB smaller.

Building the view model — at most every five seconds (`VM_MIN_INTERVAL_MS`), from every bucket the
store holds, table after table — asks the same few questions thousands of times: the local day and
hour of an hour bucket, a model's name without its date and context suffix, a model's price on a day.
Since 1.8 each answer is looked up once and kept:

* **The calendar parts of an instant** per time zone and minute (`partsOf` in `src/time.ts`), at most
  20 000 (`PARTS_MEMO_MAX`). An answer carries nothing below the minute, and from 1973 on every zone's
  offset is a whole number of minutes; before that (`PARTS_MEMO_FROM_MS` — Liberia's −0:44:30 lasted
  until 1972) two instants of one minute could fall on two days, so those are worked out every time.
* **A model's normal name** (`normalizeModel` in `src/prices.ts`), at most 1024 names
  (`MODEL_MEMO_MAX`), and **its price on a day** per pricing-options object (`priceOf`), at most
  20 000 per object (`PRICE_MEMO_MAX`). A build makes one options object and hands it to every table,
  the cards and the Agents tree, so each model is priced once per day of its usage; a kept price is
  frozen, and no caller writes into one.

A full memo is emptied whole — there is no bookkeeping in the hot path. The figures are the same:
the tests hold every answer, and five whole view models, against the path without the memos
(`resetTimeMemos(false)`, `resetPriceMemos(false)`). On a synthetic store of 8 700 hour buckets a
build took a median 36 ms instead of 53 in UTC (55 instead of 73 in Europe/Berlin), on the harness's
large agent run 15 ms instead of 17 — measured on the developer's machine, not a promise.

* **The day an hour bucket falls on** per time zone and day boundary (`dayOfHourMemo` in `src/agg.ts`,
  `dayOfBucket` in `src/stats.ts`). Since 1.9 each memo keeps the zone and the boundary hour as two
  fields and compares them, where it built a key string of both for every bucket it was asked about —
  44 % of a build's CPU time in Europe/Berlin, 8 % in UTC; now 6 % in either. The tests hold both
  against `dayOfHour` without a memo, over 5000 hours in ten zones at the boundary hours 0, 4 and 23.
  On the same store a build now takes a median 26 ms instead of 49 in Europe/Berlin and 26 instead of
  31 in UTC, before and after measured on one day (the machine's figures move from day to day). And a
  cost series asked for without pricing options is priced through one frozen empty options object
  (`NO_PRICING`), not a new one per bucket, so `priceOf` keeps one memo for it.
