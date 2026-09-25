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
npm run check:privacy  # http(s) literals in dist/ against the allow-list, the read contract, and the hook bundle's fs/path-only rule
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

A handful of questions a fake host cannot answer run in a real editor: `npm run test:e2e`
downloads VS Code stable into `.vscode-test/`, starts it with this extension in development
mode, every other extension disabled, a user-data directory of its own and a fresh `HOME` — so
the smoke test never sees a real transcript — and asserts that the extension activates, that
every contributed command is registered, that the status-bar preview runs, that a settings
change reaches the status bar without a window reload, that a change of `tokenPace.language` does
too — the status bar turns German and back to English (1.9) —, and that the dashboard command opens
its view. The settings check is why it exists at all: from 1.0 to 1.2 every settings change quietly
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
id — seven files per language, and a translation touches no other:

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
```

`test/l10n.languages.test.ts` holds every language on disk to the same thirteen rules, T1–T13: the
keys, the parts, the placeholders, the marks (`~`, `⚠`, `≈`, `–`, `%`, `×`, `→`, `·`), the code
(backtick spans, setting ids, codicons, command targets, links, fences, JSON examples), the page's words
(no markup character), the tone (no exclamation mark), the tables, no English left (proper names and
code excepted — the list `SAME_IN_EVERY_LANGUAGE` in the test, each word with its reason), the registry,
the English quotes (the keep-warm consent's terms passage and line stay word for word), the freshness
and the heat map's weekday words. Every rule also runs once against a synthetic language in a temporary
directory — the German under another id, and the English with every word turned into 語 — broken in
the one way the rule exists to catch. `test/nls.test.ts` holds every manifest translation to the
manifest's structure. The brief a translation works from is `l10n/TRANSLATING.md`. Nothing of this
ships but the bundles and the `package.nls*.json` files: `.vscodeignore` keeps `l10n/parts/`,
`l10n/nls-sources/` and the brief out of the package.

While translations are being made, the English is frozen: a changed runtime text changes its key and
fails every language's T1 at once, and a changed manifest sentence, which keeps its key, is what the
freshness record catches. A new language is a registry entry and its files; the tests, the picker
(which offers every language whose bundle is on disk) and the dashboard harness (a `main-<id>` page in
both themes at 260 and 420 px) pick it up by themselves. What the reader sees of all this is in
[Languages](languages.md).

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
