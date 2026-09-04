# Changelog

All notable changes to **Token Pace** are recorded here.
This project follows [Semantic Versioning](https://semver.org/).

## 1.2.0 — 2026-09-04

### Added

* **Context window of the current Claude Code session.** When the status line is connected,
  the mirror already carries `context_window`; it is now shown as its own dashboard section
  (`context`, not on by default), a Quick Pick row, a markdown section, and an optional status
  bar entry (`context` in `tokenPace.statusBar.show`, e.g. `ctx 64%`). It is labelled *current
  session, via the status line* everywhere it appears: it describes **one conversation**, not
  the account, and it is not comparable to a quota window. Without a window size in the payload
  there is no percentage and no bar — only the token count. Nothing here is derived from the
  local token counts; no status line means no card, never an estimate.
* **`tokenPace.planName`** — the plan name shown beside the provider title, per tool
  (`{"claude": "Max 20x"}`, 40 characters max). Display only: Token Pace never derives a limit,
  a window or a denominator from it. A name a provider states itself always wins, and a name
  out of the settings prints as `plan Max 20x (as configured)` so the two can be told apart.
  `~/.claude.json`'s `oauthAccount` is still never read.
* **Records.** A new dashboard section (`records`, not on by default), a Quick Pick group and a
  markdown section for the extremes of the selected range: its peak day, its longest run of
  consecutive days with usage, and the top models, projects and sessions. `tokenPace.dashboard.topN`
  (default 5, 1–20) caps how many rows each table lists — never what is counted, so the shares
  beside the rows stay shares of the whole range. Rolled-up month buckets have no day left in
  them and take part in neither day record; how many were left out is stated. A day before the
  first ingest is unwatched, not idle, so it neither breaks a streak nor counts as a zero — the
  same rule the heatmap follows. The two lower tables need `tokenPace.attribution` and say so
  instead of standing empty.
* **Local five-hour estimate where a provider reports no window.** One line on the quota card,
  identical in all three views: *Local estimate — 412k tokens in the last 5 h, first counted at
  09:00. Not the provider’s window; no limit is known.* It counts locally ingested tokens and
  carries no percentage, no bar, no pace, no forecast and no alert — there is no limit behind
  it, and inventing a denominator would turn an estimate into a fake quota window. It appears
  only while that provider has no window at all, and the status bar is unchanged: a problem
  state stays a problem state.
* **Tool-usage statistics.** How often each tool was called, by name — a new dashboard section
  (`tools`, not on by default), a Quick Pick group and a markdown section, capped by the same
  `tokenPace.dashboard.topN` the records use. Every row carries the calls, the share of the
  calls counted in the range and the models that made them; nothing carries a limit, because a
  tool call has none. Names only: never an argument, a path or a result. Counting lives in a
  side table beside the buckets, so no sum, no CSV column and no bucket key changes, and at
  most 100 distinct names are kept per provider and day — a day that goes past that says so
  instead of showing a short list as a complete one. The snapshot is version 6 and reads
  version 5 forward with an empty table, so no upgrade forces a cold re-read; the section
  states the first day it actually has rows for rather than showing a quiet week that was
  never measured. The rows are kept for at most **90 days** — and for less when
  `tokenPace.retentionDays` is shorter — because a table keyed by day × model × name cannot be
  carried as far as a rolled-up bucket: on the default retention a `year` or `all` range shows
  tokens for 400 days and tools for 90, and the section says which day its rows start at.
* **Exports carry the tool table.** *Export CSV…* writes a second file beside the one you pick,
  `….tools.csv` with `day, source, model, tool, calls`, announced in the save dialog before
  anything is written — never a per-bucket column, which would be an invented split of a
  figure nobody measured that way. *Export JSON…* gains `tools[]` and `toolsTruncated`, and its
  `schema_version` is therefore `2`; everything version 1 wrote still means the same thing. Its
  save dialog names the tool names too: both export paths make the same promise about the same
  data, because the dialog is the last moment to say no.
* **Budgets — a limit you state yourself.** `tokenPace.budgets` takes a list of
  `{scope, period, unit, limit, label?}` entries (`total`/`claude`/`codex` × `day`/`week`/`month`
  × `usd`/`tokens`), measured against the locally counted usage: a new dashboard section
  (`budget`, not on by default), a Quick Pick group, a markdown table, a line in *Copy usage
  summary*, and an optional status bar entry (`budget` in `tokenPace.statusBar.show`) showing
  the budget closest to its own limit. **USD here is the hypothetical API equivalent, not a
  bill**, and unpriced models make the spend — and therefore the share — a lower bound, marked
  `⚠` like every other lower bound. A token budget and a money budget are never added, averaged
  or ranked against each other; only their shares of *your* own limit are comparable. A period
  with no local data shows a dash rather than 0 %, and the end-of-period projection is the same
  rule the calendar card uses: per elapsed day, silent below five active days, always `~`.
  Periods follow your zone, day boundary and start of week; an entry with an unknown scope,
  period or unit — or without a finite limit above zero — is dropped whole rather than repaired.
  A budget nothing can measure — `usd` while `tokenPace.showCost` is off — keeps its row with
  a dash in every figure and names what is in the way, so no view can answer *No budget
  configured* about a settings file that configures one.
* **`tokenPace.alerts.budgetPercent`** (default `0` = off) notifies once per period when a
  budget passes that share of its own limit. Upwards only, one message per period, and gated on
  the transcript history having been read rather than on a quota reading's freshness — a budget
  comes from the local buckets, so a provider's staleness rule says nothing about it.
* **A German manifest.** Everything `package.json` contributes — the store listing, the display
  name, all 20 command titles, the view and walkthrough texts and every one of the settings'
  descriptions, enum descriptions and deprecation notices — now lives in `package.nls.json` as
  269 `%key%` placeholders, with a complete German translation in `package.nls.de.json`. VS Code
  picks the file that matches its display language and falls back to English for anything a
  bundle does not have, so nothing can be missing at worst — only English. Setting ids, enum
  values, file paths and the JSON examples inside the descriptions are the same in both
  languages, because they are what a reader copies. What the extension *renders* — status bar,
  tooltip, dashboard, text views, exports — stays English for now: those sentences are assembled
  from fragments, de-duplicated against one another and asserted verbatim by the tests, so they
  need a vocabulary seam rather than a search-and-replace. `test/nls.test.ts` checks that every
  key the manifest uses resolves in both bundles, that neither bundle carries a key nobody uses,
  and that no translation quietly drops a `#tokenPace.x#` setting link, a `command:` link or a
  fenced example.

### Changed

* The privacy promise now states exactly what a tool call leaves behind: prompts, responses,
  tool arguments and tool results are still never stored, logged, exported or displayed, and
  the name of a tool with its day, model and count is what the new section is made of. The
  `tokenPace.attribution` description says the same.

### Fixed

* At a sidebar narrower than 320 px the tables stack into `label: value` cards, and a long
  value — the new tools section is the first with one — ran past the card edge instead of
  wrapping, readable only by scrolling sideways through the layout that exists to avoid
  exactly that. Stacked cells now wrap; real columns still never break mid-figure.
* A stored snapshot whose bucket or tool row named a provider this build does not know — a
  hand-edited or foreign `globalStorage` file — was restored as if it were real, and the first
  read of it threw inside the view model. The views swallow that, so it showed as a blank
  dashboard rather than as a stated absence. Such rows are now rejected where the rest of the
  snapshot is validated, and the reading rule itself stays total: an unfamiliar provider gets
  the plain input count instead of an exception.

## 1.1.0 — 2026-09-04

A round about the first ten minutes: better defaults, words that say what they mean, and a
place to look things up. No new data source, no new number — the same measurements, stated
more plainly.

**Your explicit settings are untouched.** Only defaults moved, and a default only applies
where you never set the key yourself.

### Please read before updating

* **`engines.vscode` is now `^1.106.0`** (was `^1.104.0`). The dashboard lives in the
  secondary sidebar, and `contributes.viewsContainers.secondarySidebar` only became a stable
  contribution point in VS Code 1.106 — in 1.104 it was behind the `contribSecondarySideBar`
  proposed API, so on 1.104 and 1.105 the container was never registered. The old floor was
  simply wrong. Editors on an older VS Code base (Cursor and Windsurf at the time of writing)
  cannot install this version; VSCodium tracks the VS Code releases and can.
* **Four defaults changed**, each because the old one asked the user to configure their way to
  the obvious behaviour:
  * `tokenPace.windowSelect`: `all` → **`worstPace`**. Nine status bar entries were the first
    thing most people turned off. `worstPace` gives each tool exactly one entry — the window
    that needs attention. `all` is still there.
  * `tokenPace.clickAction`: `menu` → **`dashboard`**. A click now opens the panel; the menu
    is one command away and still the default target of a problem-free right-hand path.
  * `tokenPace.alerts.thresholds`: `[]` → **`[90]`**. One notification, at 90 %, only while
    the window is also ahead of pace, only more than an hour before its reset, and never from
    a stale reading. **Emptying the list still switches notifications off entirely.**
  * `tokenPace.tooltipExplanations`: `true` → **`false`**. The paragraphs are worth reading
    once, not on every hover. The uncertainty markers (`~`, `⚠`) and the provenance line were
    never covered by this setting and still are not.
* **The `ctrl+alt+shift+q` keybinding for *Fetch Quota Now* is gone.** Two global chords for
  one small extension is greedy, and fetching is reachable from the status bar click, the
  tooltip footer, the actions menu, the panel title bar and the Command Palette. *Open
  Dashboard* keeps `ctrl+alt+shift+t` / `cmd+alt+shift+t`, and the new boolean
  `tokenPace.keybindings` switches it off from the settings UI instead of requiring a `-` rule
  in `keybindings.json`.
* **The remote hint now offers to do the move itself.** On a remote host with no transcripts,
  the notification's *Run Token Pace locally* button writes `"remote.extensionKind"` into your
  **user settings** (merged, so other extensions' entries stay) and offers a reload. That is a
  third write outside the extension's own storage, and the only one that is not consent-gated
  — the click *is* the consent. It is offered at most once per machine, only where nothing was
  found at all, and the manual edit it replaces is still documented in the README.
* **Four more settings are machine-scoped**, so a workspace can no longer make decisions about
  credentials: `tokenPace.quotaSource`, `tokenPace.writeQuotaCache`, `tokenPace.userAgent` and
  `tokenPace.credentials.keychain`. A synced or workspace-level value for these is ignored in
  favour of the machine-level one.
* **`tokenPace.timezone` and `tokenPace.dayBoundaryHour` moved from the Dashboard group to
  General**, because they govern the status bar summary as well. The keys are unchanged.

### Changed

**Words**

* The pace verdict is stated in the unit the figure above it uses: `5 % ahead of pace` instead
  of `5 points ahead of the clock`, and `36 % of the window still spare` instead of
  `36 points in reserve`. The sustainable rate reads `~18.8 %/h keeps it to the reset` instead
  of `points/h`.
* The KPI label `Ø per active day` is now `Avg per active day`, in all three views.
* The command *Token Pace: Menu* is now *Token Pace: Show Actions Menu*, and the menu itself
  gained *Show usage as text (Markdown)* directly after *Open dashboard*.

**Status bar**

* The token and cost entries always print their period: `Σ 2.6M · today`, `~$1.23 · today`.
  A bare `Σ 2.6M` did not say what it summed.
* Every countdown is introduced by the word `resets`: `· resets 6h45m`. A bare `· 6h45m` was
  one glance away from the `$(history) 12m` age suffix, and the two move in opposite
  directions.
* **The two alarm states are said in words**, next to the figure: `100% exhausted` and
  `100% limit reached`. The `$(warning)` icon, the `⛔` emoji and the alarm background are the
  three channels that carried them, and `indicator: color`, `colorMode: monochrome` and a
  high-contrast theme each remove one. The words survive all three.
* The repair action of a problem state is now one table for all of it — status bar click,
  tooltip footer, dashboard card, Quick Pick and text view. `403` and “no reading, no named
  cause” now open the log (where the reason actually is) rather than a browser tab or another
  fetch, and a missing cache file offers *Re-read history*, which also picks up a file that has
  appeared since. The table is in `docs/status-bar-states.md` and in the README, and a test
  compares both against the code.

**Dashboard**

* The KPI row starts with a **today** tile (usage today, with its cost while `showCost` is on).
* KPI deltas are coloured by what the change means, not by its sign: more usage, cost and
  requests read as the bad direction, a higher cache hit rate as the good one, and active days
  and the per-day average carry no judgement and stay neutral.
* **Sections collapse.** Every header is a toggle, and what you collapse is remembered with the
  rest of the view state. The model chips fold behind a `models (N)` toggle above four, and the
  custom date fields stay hidden until the range actually is a custom one or you open them with
  the `custom…` chip.

**Settings**

* The groups are ordered the way they are used: the power-user settings (`labelMaxChars`,
  `resetHourCycle`, `overflowDisplay`, `diagnostics.includeNetworkSetup`,
  `codexAppServer.mode`, `credentials.keychain`, `leaderElection`, `pollOnlyWhenFocused`,
  `calibration.show`, `pricing.showListPrice`) sit at the end of their group, and the
  deprecated `tokenPace.windows` sits behind everything.
* Descriptions say up front when a setting does nothing: `pace.tolerancePoints` and
  `pace.minElapsedPercent` only apply with `pace.sensitivity: custom`, `barStyle` only bites
  for `barGlyphs: blocks`. Cross-references were added where one setting silences another —
  `showCost` ↔ the `cost` entry, `quotaHistoryDays` ↔ the `forecast` entry and the forecast and
  history sections.

### Added

* **A walkthrough**, *Get started with Token Pace*, in *Help → Get Started*: what the bar and
  its colours mean (with a *Preview status bar states* button), where the quota figures come
  from and what “poll” means (with *Fetch quota now*, *Connect Claude status line* and
  *Open settings*), and the dashboard. The second step quotes the network-consent disclosure
  in full — the same text the dialog shows, including the sentence about identifying as the
  Claude Code client — so the terms can be read before the dialog ever appears. A test
  compares the two, line by line.
* **`tokenPace.keybindings`** (default `true`) — see above.
* **README:** screenshots of the status bar and of the dashboard (rendered from preview data,
  never from real usage), which now also ship inside the `.vsix`; a *Words used here* glossary of the nine terms the
  extension leans on; and an *If the bar says …* section covering every problem state with its
  exact bar text, its cause and the action its click performs.

## 1.0.0 — 2026-09-03

The 1.0 release. Everything the extension shows is now traceable to a source, a formula and a
date; everything it does not know is stated as unknown rather than rounded to zero.

### Please read before updating

* **The persisted snapshot moved to schema version 5.** The first start after the update
  discards the old snapshot and re-reads every transcript once. Nothing is lost that the
  transcripts still hold — Claude Code deletes its own after about 30 days, so anything older
  than that only ever existed in the snapshot and cannot come back.
* **The status bar item ids changed** from index-based to content-bound
  (`tokenPace.quota.claude.session.300` instead of a position). VS Code remembers hidden
  entries per id, so an entry you had hidden by right-clicking the status bar reappears once;
  hide it again and it stays hidden.
* **`tokenPace.windows` is deprecated** in favour of `tokenPace.windowSelect`, which has four
  more values. The old setting is still read while `windowSelect` is at its default `all`, so
  an existing `"leading"` keeps working; setting `windowSelect` to anything overrides it.
* **The order of `tokenPace.statusBar.show` now matters.** The array is the display order —
  drag the rows in the settings UI to sort the bar. It also gained `forecast` as an entry.
* **The pace verdict no longer flips at the first point ahead of the clock.** By default a
  window has to run more than 5 percentage points ahead, and at least 3 % of the window has to
  have elapsed before any colour is shown at all. `tokenPace.pace.sensitivity` picks
  `relaxed` / `normal` / `strict`, or `custom` for your own two numbers.
* **`extensionKind` is now `["ui", "workspace"]`.** The extension can run locally or inside a
  remote, and VS Code runs it locally by default. If Claude Code or Codex runs in WSL, SSH or a
  container, set `"remote.extensionKind": {"frederik.token-pace": ["workspace"]}` — editing
  `package.json` and rebuilding is no longer necessary.

### Fixed

* Status bar item ids were derived from the item's position, so hiding one entry hid whatever
  moved into its place after the next update. Ids are now bound to the content they show.
* A percentage left over from a window that had already reset was shown as if it were current.
  Such a window now reads `reset due` until a reading newer than the reset arrives, and one
  extra fetch is scheduled just after the reset (with jitter, once per window and cycle) to get
  that reading. The gauge is never zeroed by us.
* A Codex rollout re-read from the start after rotation or an atomic replacement kept its old
  cumulative baseline, which swallowed every event up to the previous total. The derived
  per-file state is now reset before the first line of a re-read.
* Tail offsets advanced by the length of the decoded string rather than by the bytes consumed,
  so a single invalid UTF-8 sequence shifted every later offset in that file.
* A read cut short by the size cap recorded the file's full size as consumed, so the next sweep
  took the untouched remainder for an unchanged file and skipped it.

### Added

**Status bar**

* `tokenPace.density` (`full` / `compact` / `minimal`), so a provider's windows can collapse
  into one entry, or every provider into one. Problem states are never folded.
* `tokenPace.windowSelect` with `worstPace`, `session`, `weekly` and `auto` on top of `all` and
  `leading`. `auto` shows session windows only, unless every session window is below 30 %.
* Four bar glyph sets (`blocks`, `shapes`, `dots`, `pie`) and a time-progress style
  (`marker` / `bar` / `none`), because block elements are not shipped in every status bar font.
* `tokenPace.indicator`: the pace verdict as a glyph (`▲` / `▲▲`) as well as, or instead of, a
  colour — colour alone is invisible to red-green colour blind readers.
* `tokenPace.percentMode: remaining`, carried consistently through item, bar direction, tooltip
  header and legend.
* Reset countdowns (`resetFormat`, `resetHourCycle`), a reading age in the entry
  (`showAgeInItem`), custom labels per provider and per window id (`labels`, `labelMaxChars`).
* Named problem states — no token, token expired, consent, retry, offline, quota off, 403,
  sign in, no codex, paused, follower, empty — each with its own repair on click.
* Four contributed theme colours (`tokenPace.paceOk`, `paceWarn`, `paceAhead`, `stale`),
  overridable in `workbench.colorCustomizations`, plus `colorMode: monochrome`.
* A tooltip with the window table, forecasts, freshness, provenance and an action footer;
  `tokenPace.tooltip` and `tooltipExplanations` control how much of it is built.
* **Token Pace: Preview Status Bar States** renders synthetic versions of every state for 60
  seconds, in their own id space, so a format setting can be judged without waiting for the
  state to happen. **Token Pace: Menu** and **Cycle Status Bar Windows**; keybindings for the
  dashboard and for a forced fetch.

**Pace**

* The verdict is one shared module: a tolerance band in percentage points, a minimum elapsed
  share, `binary` or `graded` warning levels, and one wording used by the status bar, the
  tooltip, the dashboard and the alerts.
* The sustainable rate — what would just last until the reset — per hour and per day.

**Dashboard**

* Thirteen sections in a configurable order: summary, quota, key figures, tokens, chart,
  models, activity heatmap, time of day, forecast, reset history, projects, sessions and data
  quality.
* Range chips (`today` … `all`) plus a custom date range, provider and model filters, a sortable
  model table, six chart metrics with an optional cost line, a per-day drill-down, a calendar
  heatmap with streaks and variability, and an hour profile with a weekday × 4-hour grid.
* Previous-period deltas on every KPI, calendar periods with an end-of-month projection that
  shows its derivation, cache economy as an explicit counterfactual, and a plan factor from
  `tokenPace.planPriceUsd`.
* A rule-based summary digest: three to five sentences, each with its figure and its basis, no
  advice.
* `tokenPace.dashboard.mode` switches between the webview, a QuickPick and a read-only markdown
  document. All three read one view model, and a test counts the rows of one against the other.
* Timezone, day boundary hour and start of week are configurable; they change the display only.

**Quota sources**

* Three new sources besides the external cache file and our own fetch: the `rate_limits` block
  Codex writes into its own transcripts, the `cachedUsageUtilization` object in
  `~/.claude.json`, and the mirror file of the new Claude status-line bridge.
  `tokenPace.claudeQuotaSources` / `codexQuotaSources` decide which may be used. The freshest
  source that has data wins; the configured order only breaks ties, and fields are never merged
  across sources.
* `tokenPace.userAgent`, `credentials.keychain` (macOS `security`, Linux `secret-tool`),
  `pollOnlyWhenFocused`, `leaderElection`, `codexAppServer.mode: persistent`, and
  `writeQuotaCache`.
* The cache file format is now a documented contract with a `schema_version`
  (`docs/quota-cache-format.md`), including `blocked_until`, `providers_error` and the rules a
  writer has to follow.
* Network errors are classified into named states — timeout, TLS interception, proxy
  authentication, 401, 403, 429 — each with its own repair step, and never quoting the
  exception.

**History and forecast**

* A persisted quota time series (`quotaHistory.json`, `tokenPace.quotaHistoryDays`, default 30)
  with a write guard that keeps replayed state out, an account fingerprint that keeps two
  accounts apart, merge-on-save between windows, and gaps drawn as gaps.
* Burn rate, exhaustion ETA, end-of-window projection and lockout time as named states —
  `measuring`, `idle`, `eta`, `resetsFirst`, `stale`, `full`, `none` — with a stated confidence
  and the number of readings behind it.
* A reset retrospective over completed cycles: how often the window hit the limit, how much was
  left unused. Silent below three complete cycles.
* An opt-in calibration band (`tokenPace.calibration.show`): local tokens per quota percentage
  point, as a median with its minimum and maximum. Never applied as a multiplier to anything.

**Alerts**

* Threshold, pace-flip, forecast and use-it-or-lose-it notifications — **all off by default**.
  One message per window and reset cycle, only on escalation, never from a stale reading,
  consolidated per provider, with a “Not today” snooze until the next local midnight.

**Cost**

* The price table is dated (checked 2026-09-02, legacy Anthropic rows 2026-08-13) and every
  rate carries the day it was read; a bucket no rule covers is marked as approximate.
* Fast mode is priced only where the table publishes fast rates — today Claude Opus 4.6 alone.
  Fast usage of any other model is reported as unpriced with the reason *fast rate unknown*
  rather than billed at the standard rate.
* US-only inference carries its 1.1× surcharge; web search is billed at $10 per 1,000 calls.
* `tokenPace.pricing.multiplier`, `pricing.showListPrice`, and `unknownModelPricing: family` as
  an opt-in fallback to the newest priced model of the same family, marked wherever it is used.
* `tokenPace.customPrices` now merges field-wise over the built-in table, so a single rate can
  be corrected, and model keys are normalised before lookup.

**Data**

* Counts are stored per UTC hour and rolled up into days after `hourRetentionDays` (45) and into
  months after `retentionDays` (400), preserving sums exactly.
* Reasoning tokens, `server_tool_use` counters and the four pricing tiers (`standard`, `fast`,
  `us`, `fast-us`) are counted and shown.
* `tokenPace.attribution` adds opt-in per-project and per-session figures: project basenames or
  salted hashes and session ids, never a full path, a file name or anything from a transcript.
* `claudeDir` / `codexDir` accept several directories; Codex `archived_sessions/` and Claude's
  XDG location are found as well.

**Export and diagnostics**

* **Export CSV…** (18 columns per bucket plus a `TOTAL` row that says when it is a lower
  bound), **Export JSON…** (with range, timezone, pricing provenance and notes) and
  **Copy Usage Summary** as markdown. Days without data produce no row.
* **Copy Diagnostics** builds its report from a field allow-list — an unknown field makes it
  throw — with paths shortened to `~` and proxy credentials masked. No token, no transcript
  content, no object dumps.
* **Clear Stored Data…** lists everything on disk with its size and deletes what you pick, and
  a `vscode:uninstall` hook removes the extension's storage directory on uninstall.

**Multi-window**

* An advisory lease in `globalStorage` elects one window to read and fetch while the others
  follow its files. In doubt a window polls itself: one extra request beats stale figures
  forever. A follower says so in the tooltip and still fetches on request.

**Claude status-line bridge**

* **Token Pace: Connect Claude Status Line…** registers a bundled script as Claude Code's
  `statusLine.command` and mirrors its status JSON into `globalStorage` — the only official,
  network-free source for the Claude quota percentages. Opt-in, behind its own consent dialog,
  with a byte-exact backup of `settings.json`, chaining of an existing status-line command,
  a refusal to touch a file that does not parse, an exact restore on **Disconnect**, and
  detection of `settings.local.json` or managed settings that would shadow the install.

**Tests, CI and the privacy check**

* A `node:test` suite over synthetic fixtures only, covering the parsers, the aggregator, pace,
  prices, statistics, forecast, view model, status bar texts, serialisers, storage and the
  bridge; plus an invariants suite for the anti-fake rules.
* CI runs type check, build, tests and the privacy check on ubuntu, macOS and Windows, next to
  CodeQL, a dependency review and a gitleaks scan.
* `npm run check:privacy` scans the shipped bundles for every `http(s)` literal and fails the
  build on anything outside a small allow-list, so “no network access by default” is checked
  mechanically rather than promised.
* A tag push now also publishes to **Open VSX**, which is what makes the extension installable
  in VSCodium, Cursor and Windsurf.

### Changed

* `.vscodeignore` is now an allow-list — everything is excluded and only the files that ship
  are named back in — so nothing can slip into the `.vsix` by being added to a directory that
  happened not to be listed. `docs/*.md` is among the files that ship, so the cache file
  contract and the status bar state table are available offline.
* The dashboard is rebuilt: updates are per section, so a one-second refresh no longer resets a
  sort order or the scroll position, and every message the webview sends back goes through an
  allow-list that accepts a range, a sort, a filter, a metric, a drill day or one of nine named
  commands — never a path, never a setting. No external resource of any kind is loaded.
* The extension declares support for untrusted and virtual workspaces. In Restricted Mode the
  two opt-in writes are disabled.
* The tooltip's window table gained a **Pace** column: it names the difference between usage
  and elapsed time in percentage points, tolerance or not, instead of leaving the verdict to
  the colour alone.

### Deprecated

* `tokenPace.windows` — use `tokenPace.windowSelect`. It is still honoured while `windowSelect`
  is at its default, and will be removed in a later release.

## 0.9.0 — 2026-09-02

First release prepared for the Visual Studio Marketplace, under the name
**Token Pace — Claude Code & Codex** (previously “AI Token Usage”).

### Renamed

The extension is published as **Token Pace — Claude Code & Codex**. Three identifiers moved
with it, which matters only to anyone who ran a pre-release build:

* Extension id `frederik.ai-token-usage` → `frederik.token-pace`. The old copy does not
  update to the new one; uninstall it.
* Settings prefix `aiTokenUsage.*` → `tokenPace.*`. Existing entries in `settings.json` keep
  the old prefix and are silently ignored — rename them.
* Command prefix `AI Token Usage:` → `Token Pace:`.

The persisted state lives under the extension id, so the first start after the rename does a
full re-scan of the transcripts instead of resuming. Nothing is lost; it just takes a moment.

### Relicensed

From MIT to **AGPL-3.0-or-later**. The extension reads an access token, and the assurance
that it only does what it claims rests on the source being readable. Copyleft carries that
assurance forward: a modified version has to ship its source whether it is distributed as
software or merely offered as a network service. Private use and private modification stay
unrestricted.

### Changed — please read before updating

* **The extension no longer makes any network access on its own by default.**
  Previously `quotaSource: "auto"` fetched directly on Windows. It now reads the cache file
  on every platform and asks nothing unless there is nothing to show.
* Fetching the quota requires **explicit one-time consent**. The dialog names the endpoint,
  the credential file, the fact that the request identifies itself as the Claude Code client,
  and what is not done with the token. The answer is stored per machine and never synced.
* `quotaSource` now behaves identically on all platforms. The Windows special case is gone.

### Added

* Command **Token Pace: Reset Network Access Decision** to put the question back.
* One-time, dismissable offer to enable fetching — shown only when no quota data exists at
  all, so anyone served by an external poller is never asked.
* Store logo (`media/logo.png`), gallery banner, keywords, categories and repository links.
* Prices for **Claude Fable 5.1** (`claude-fable-5-1`) and **Claude Mythos 5.1**. Fable 5.1
  reads cache at a flat $0.25/MTok rather than the usual 0.1x of the input rate, so the
  price helper now takes an explicit cache-read rate; deriving it would have overstated
  cache-heavy usage fourfold. The Mythos 5.1 cache-read rate was not confirmed at launch and
  uses the standard multiple until it is.

### Notes

Token counts have never needed network access and still do not. Declining consent costs only
the quota percentages; everything read from the local transcripts keeps working.

## 0.8.3

* Dollar amounts of $100 and above are rounded to whole dollars. Below that they stay at
  two decimals. The threshold is applied to the rounded value, so a figure displayed as
  “100” is never shown with cents.

## 0.8.2

* All dollar amounts are shown with two decimals.
* The API-cost figures use the same colour as the other numbers. Green is now reserved for
  the pace indicator alone.

## 0.8.1 and earlier

Development before the first release. In summary:

* Status bar with one entry per quota window, including the model-scoped ones, with bars
  built from Unicode block elements and a marker for how far the window's own clock has run.
* Colour follows **pace**, not level: green while usage is at or below the elapsed share of
  the window, yellow once it runs ahead, red when the window is spent.
* Dashboard in the secondary sidebar: quota, tokens, a 14-day chart and a per-model table.
* Incremental ingest of Claude and Codex transcripts with deduplication by message id,
  replay and fork detection, rotation-safe tailing and a periodic sweep against lost
  filesystem events. The cold start runs on a worker thread.
* Per-model API cost at list prices, with unpriced models named rather than silently
  counted as zero.
* Extra (purchased) usage reported separately from the plan windows.
* Configurable status bar entries and dashboard sections.
* Own quota poller with progressive backoff, as an alternative to an external cache file.
