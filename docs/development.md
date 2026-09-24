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
change reaches the status bar without a window reload, and that the dashboard command opens its
view. The settings check is why it exists at all: from 1.0 to 1.2 every settings change quietly
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
