# Changelog

All notable changes to **Token Pace** are recorded here.
This project follows [Semantic Versioning](https://semver.org/).

## 1.13.0 — <date set at publish>

**Arabic, Hebrew and Persian, with the dashboard mirrored for them.** Three languages written from right to left join
the flag at the top of the dashboard — Arabic (العربية), Hebrew (עברית) and Persian (فارسی) —, twenty-nine in all,
translated by AI agents from the English text and checked by tests, not by native speakers. Chosen, the dashboard
reads from the right: its sections, tables, range chips, language list, agent tree and details are mirrored and the
quota bars fill from the right, while the charts keep time running from left to right and every figure keeps its marks
where they belong. All three write the digits 0–9 and count days by the Gregorian calendar, so a figure reads the same
in the status bar, on the dashboard and in an export. VS Code's own surfaces stay left to right — VS Code has no
right-to-left layout —, so Token Pace marks its texts in the status bar, its tooltips, the Quick Pick, messages and
dialogs to read in their own order there. Beside it the 1.12 leftovers: the words of the Keychain, Telegram, e-mail
and app-server settings, the German reset times, and the prompt cache's countdown torn in a narrow sidebar.

### Added

* **Three languages written from right to left.** Arabic (العربية), Hebrew (עברית) and Persian (فارسی) — twenty-nine
  languages, thirty lines in the list with *Automatic*. Each switches the status bar and its tooltips, the dashboard,
  the Quick Pick, the markdown document, every dialog and every notification at once, as the flag or
  `tokenPace.language` chooses it; the settings and the command titles follow VS Code's display language, and
  Microsoft has no language pack for any of the three — a community pack for Arabic exists, not tried by the author —,
  so without a pack `auto` shows English and the flag picks them, the settings staying in VS Code's language. The
  Arabic and the Hebrew script are drawn with your system's fonts; Token Pace ships none. The flags are Egypt's for
  Arabic, Israel's for Hebrew and Iran's for Persian, simplified drawings, never mirrored — a flag is not a language,
  and the name stands beside it. **These translations were made by AI agents (Claude Fable 5.1 for Arabic, Claude
  Opus 5.5 for Hebrew and Persian) from the English text, with the German as a second reference, checked by tests for
  completeness, placeholders, marks, the settings' status-bar examples, freshness and the direction — no direction
  mark and no digit of another script in a translation — and read once more by further AI agents, not by native
  speakers**; their register was chosen from common usage, not verified against a style guide, and a wrong or clumsy
  word is a bug to report. The twenty-four other languages name the three and carry every text 1.13 changed, through
  the ledger of English changes, by an AI agent as well.
* **The dashboard mirrored.** In Arabic, Hebrew and Persian the page is laid out from the right — turned at a switch,
  without a reload —: the sections and their texts, the tables with their figure columns at the left edge, the range
  chips and the provider switch, the language list, the agent tree — indenting toward the left, `←` opening a node and
  `→` closing it — with its details, and the quota bars, which fill from the right. The charts are not mirrored, as
  design guidance for right-to-left layouts has it, so time runs from left to right in them: the daily bars, the
  sparklines, the year strip, the hour strip and the weekday grid. Every figure, amount, day, clock time and model or project name is one
  left-to-right unit with its marks where they belong — `~25%`, `⚠ 3.2M` —, and a range the page writes reads from the
  right, with `←`. What a screen reader reads is unchanged: the mirror is the stylesheet's, and the page names its
  language for the screen reader's voice.
* **The digits 0–9 and the Gregorian calendar** in all three languages, chosen or under `auto`: left to itself,
  Persian would print Persian digits and Solar Hijri dates, and Arabic under an Egyptian or Saudi display language
  Arabic-Indic digits. A figure reads the same beside Token Pace's marks, in the status bar, on the dashboard and in an
  export, and *week to date* and *month to date* carry the days they count. The first day of the week stays
  `tokenPace.startOfWeek`'s, in every language.

### Changed

* **Token Pace's texts on VS Code's surfaces carry invisible direction marks in a right-to-left language.** VS Code lays
  out the status bar, its tooltips, the Quick Pick, messages, dialogs, the InputBox and progress notifications from left
  to right in every language; in Arabic, Hebrew and Persian each text Token Pace puts there is marked as a right-to-left
  paragraph of its own and each figure and name in it as a left-to-right unit, so that a sentence beginning with
  *Claude* still reads from the right and `~18 h 46 min` stays whole; an entry's icon stays at its left edge, and the
  bar's glyphs draw from the right. A text copied from there may carry those invisible marks. None goes into a status
  bar entry's or the dashboard's accessible names, the markdown document, the log, the diagnostics report or an export;
  a Quick Pick's line, a message and a dialog's button have no accessible name of their own, and VS Code gives a screen
  reader the text they show, marks included.
* **A notification's title and text begin with a right-to-left mark** in Arabic, Hebrew and Persian, so that a chat or
  push client that takes a message's direction from its first letter lays out a sentence beginning with *Claude Code*
  from the right; the JSON's other fields carry none.
* **The Keychain setting** says that the first read in *a VS Code window* happens only when you fetch by hand — "a
  window" read as a quota window.
* **The Telegram setting** begins *Sending through a Telegram bot* and speaks of "the @name of a public Telegram
  channel": "channel" no longer names Telegram's channel and the notification channel at once.
* **The e-mail setup's hint** writes the setting's field names as code: *Set `host`, `user`, `from` and `to` in
  tokenPace.notifications.email first.*
* **The app-server setting** says that *the app-server* ends when VS Code closes, where "it" could be read as the mode.
* **The German reset times** read „Reset: Do 14:20" instead of „Reset um Do 14:20" in the status bar, the Quick Pick
  and the notifications — a clock that may carry a weekday takes the label form —, and the settings' German examples
  follow („· Reset: Mo 06:00").

### Fixed

* **The prompt cache's countdown** — `4 m 10 s`, `1 h 2 m` — could break between its parts in a narrow sidebar; it is
  one run now, as `~18 h 46 min` is since 1.12.

### Internal

* **Snapshot and export.** `STATE_VERSION` 8, `AGENT_TABLES_REVISION` 10 and `EXPORT_SCHEMA_VERSION` 4 are unchanged —
  the first start of 1.13.0 rebuilds nothing, and every export field means what it did; the exports stay English, with
  the digits 0–9 in every language.
* **Nothing new is read or written.** The three languages are three more of Token Pace's own translation files,
  twenty-eight in all, inside the extension's folder; a language's direction is a constant of the language list, and
  the marks are added where a text is shown, never stored.
* **The re-key ledger.** 1.13's holds 11 entries since the 1.12.0 release (`l10n/rekey.json`, its count read by a
  test), which the twenty-four languages worked through in one package, while the three new languages are whole
  translations from the frozen English and never a pending list.
* **The frame learned right to left before a word was written.** T16 refuses a direction mark, a digit of another
  script, an Arabic presentation form and a turned placeholder in any translation; the arrow rule lets a right-to-left
  language turn `→` into `←`; a fourth synthetic language — every word `كلمة`, under `ar` — runs every rule;
  `RESET_CLOCK_KEYS` lists the texts whose placeholder may hold a clock with its weekday, where a translation needs a
  label rather than a clock-only preposition; `FIELD_IDS_OF_A_KEY` is retired, the e-mail check's ids written as code.
* **The lease's watchdog, named.** `LEASE_RENEW_MS` (30 seconds) and `LEASE_TTL_MS` (three renewals, 90 seconds) name
  what the lease always did, and tests take it over from a window whose process is gone at the next check, and from a
  silent one after 90 seconds, not before.
* **One door to VS Code's messages.** Every message, Quick Pick, InputBox and progress notification goes through one
  module, and a static test finds those calls nowhere else; the one module that writes a direction mark writes it as an
  escape, and a test finds no literal one in the sources.
* **The dashboard harness** probes every language written from right to left, and the smoke test in a real window
  checks the Arabic status bar's marks.

## 1.12.0 — <date set at publish>

**Notifications to your phone, a chat or your mail, a Codex app-server that stays connected, and the macOS Keychain
asked for by name.** Token Pace can now send a short message when Claude Code waits for you, a long turn finished or
a quota window passes your threshold, runs out, resets or is forecast to run out before its reset — to a webhook of
your own or Slack, Discord, Microsoft Teams, Mattermost, Rocket.Chat, to a Telegram bot, an ntfy topic or an e-mail
address; nothing is sent until you set a channel up and allow its host, and a message never holds a prompt, a path, a
project or a session. With quota fetching allowed, one `codex app-server` now keeps running for all your windows and
Codex's rate limits arrive over that one connection, instead of a new process for every check. On a Mac, Claude Code's
access token is looked for in its Keychain item before the credentials file — the consent now says so, and asks once
more if you allowed fetching before —, and a sign-in or sign-out is noticed within seconds. Beside it the 1.11
leftovers: the English page's range chips, a duration torn in a narrow sidebar, the budget entry's percent, the
ellipsis, and VS Code's own words in Turkish and Traditional Chinese.

### Added

* **Notifications** — *Token Pace: Set Up a Notification Channel…* connects a channel: a webhook with Token Pace's own
  JSON, or the same webhook in the format of Slack, Discord, Microsoft Teams (a Workflows webhook), Mattermost or
  Rocket.Chat; a Telegram bot; an ntfy topic; or e-mail through your SMTP server, with STARTTLS or TLS and nothing sent
  before the connection is encrypted. It asks for the address and its secret in boxes that hide what you type, asks
  whether Token Pace may send to that host — the consent names it —, and keeps the secret in VS Code's secret storage,
  never in your settings; it writes no setting, so you list the channel in `tokenPace.notifications.channels` yourself.
  What you hear about is your list in `tokenPace.notifications.events`: `agentWaiting` (Claude Code has waited a minute
  for your permission or answer — needs the agent hook), `agentDone` (a turn of at least two minutes finished — "after
  at least", a lower bound), `quotaThreshold` (a 5-hour or weekly window past `tokenPace.notifications.thresholds`, 80
  and 80), `quotaExhausted`, `quotaReset` (off by default, and only for a reset no more than 30 minutes ago) and
  `paceWarning` (the forecast runs out before the reset, marked `~`); the agent events only while the window is not
  focused, the quota events never from a stale reading. No storm: each event once, one message of a kind per
  `tokenPace.notifications.cooldownMinutes` (10), at most 20 an hour in all, a failed send not tried again, a `429`
  obeyed. The messages are in the language of `tokenPace.language`. **The channels were built from each service's
  documentation and tested against local servers — none of them was tried against the real service by the author
  yet.**
* **Send a Test Notification…** sends a test message to one channel you set up and says whether it went, or why not
  in one word; **Remove a Notification Channel…** deletes a channel's secrets, your consent and its last result.
  *Clear Stored Data…* has an item *Notification channels*, and *Copy Diagnostics* a section `## Notifications` — per
  channel whether it is listed, its secret set, its consent standing and its last result, never a host or an address.
* **The sign-in watcher on macOS.** Beside the credentials file (watched by its size and time since 1.0.0), the
  Keychain item is watched by its modification date — its attributes, never its secret —, so signing in or out of
  Claude Code brings the new figures, or *no token*, within seconds and without a reload.
* **Two more lines in *Copy Diagnostics***: `codex connection — mode … · state …` says which mode of the Codex
  app-server is live, and `credentials — source … · keychain …` where the Claude token came from, by a name.

### Changed

* **The Codex app-server is one standing connection by default.** `tokenPace.codexAppServer.mode` defaults to
  `persistent`: in `quotaSource: poll`, after your consent, the window that fetches keeps one `codex app-server`
  running for the whole editor, waits for its answer to `initialize`, asks every fetch over that connection and takes
  the rate-limit updates it pushes, so while pushes come no fetch is made. A child that exits is started again after a
  growing wait; after five restarts within an hour each fetch starts one of its own until the hour has passed, and then
  the standing one comes back. It ends when VS Code closes, when another window takes over fetching, when fetching is
  switched off and when the mode or `tokenPace.codexBinary` changes. `oneShot` keeps the old way — a child per fetch.
  The setting is machine-scoped now, so a workspace cannot choose it for you. A consent given before stays valid:
  keeping the child running sends nothing anywhere. The standing connection was tested against a stand-in app-server,
  not against a signed-in Codex, by the author.
* **On macOS the Keychain comes before the credentials file.** The order is `CLAUDE_CODE_OAUTH_TOKEN`, the Keychain item
  `Claude Code-credentials`, then `~/.claude/.credentials.json` — a file there may be another setup's leftover of
  another account; Linux and Windows are unchanged. The Keychain is read only after you allowed it: the network dialog
  names it now, and if you allowed fetching before, *Fetch Quota Now* asks once more. Its first read in a window happens
  only when you fetch by hand, because macOS may ask whether `security` may use the item — choose *Always Allow* —, and
  fetches in the background read it only after such a read brought the token within a second; a fetch by hand waits up
  to 30 seconds for macOS's question. **The Keychain path is untested on macOS by the author.**
* **Alerts are called alerts.** The in-editor popups of `tokenPace.alerts.*` are *alerts* in every settings sentence,
  and a *notification* is only what leaves VS Code; the German Alerts category reads „Warnhinweise“, and ten of the
  other languages renamed theirs too, because the old name is now the notifications' word — a reader who knew it finds
  the new one in the settings' list of categories.
* **The English page's words.** The range chips say *week to date*, *month to date* and *last month*, and the chart's
  metric menu *cache read*, where the English page printed the internal names.
* **The budget entry** writes its percentage as the quota entries do — `budget 63%`.
* **The ellipsis.** English puts no space before it — *Loading…*, *Reading token history…* —, as VS Code does; every
  other language follows its own typography.
* **"Record" means a record.** Below three weeks the weekday grid's caption says *based on 1 week — a single
  observation, not a habit* or *based on 2 weeks — observations, not yet a habit*, and the attribution setting deletes
  the per-session *data*.
* **Turkish and Traditional Chinese use VS Code's own terms** — *Uzantı Konağı* for the extension host, 延伸模組,
  延伸主機 and 受限模式 for an extension, the extension host and Restricted Mode.
* **The twenty-four languages beyond English and German carry every text 1.12 added or changed**, translated by AI
  agents and read again by further AI agents — not by native speakers; the macOS Keychain's name and its buttons are
  written as each agent believed macOS shows them, not checked on a Mac.
* **The JSON export's note** on `listCostUsd` names its exception: where a custom price alone priced a model, it equals
  `costUsd`.

### Fixed

* **A Codex app-server started for fetching kept running after fetching was switched off** — `quotaSource` no longer
  `poll`, or *Reset Network Access Decision* — until the window closed; now it ends at once.
* **In persistent mode every fetch started a second, one-shot child** beside the standing one; a fetch now asks the
  connection, and starts a child of its own only while the standing one restarts or has restarted too often.
* **After five restarts the standing app-server stayed off for the rest of the session**; it comes back once the hour
  has passed.
* **A duration broke between its parts in a narrow sidebar** — "~18 h" on one line and "46 min" on the next, in nine
  languages; `~18 h 46 min`, `3 d 4 h` and `49 min 00 s` are one run each now.
* **A label ending in a halfwidth form** (`｡`, `､`, halfwidth Hangul) got no space before its value; it is spaced like a
  plain colon now, and only the full-width forms carry their own blank.
* **The English page printed `thisWeek`, `thisMonth`, `lastMonth` and `cacheRead`** in its extra range chips and the
  chart's metric menu.
* **A threshold alert could come again within one quota window** when Claude Code's reset time jittered between
  readings; a reset time within 30 seconds of the one an alert already named is the same cycle now.
* **Without a `codex` executable** the search for it ran at every check of every window that fetches; a miss is kept
  for five minutes, or until `tokenPace.codexBinary` changes.

### Privacy

* **The consent now names the Keychain.** Since 1.0.0 the macOS Keychain was read after a consent whose text named only
  the credentials file; the dialog now names every place the token is read from on your platform, and on macOS a
  consent given before 1.12 does not cover the Keychain — it is asked for once more, inside *Fetch Quota Now*, never
  unprompted.
* **The credentials' three fields under a contract row.** Of the credentials document only `claudeAiOauth`, its
  `accessToken` and its `expiresAt` are read, and the privacy check fails a build that reads another; the token is
  still read, used once and dropped — never refreshed, logged or written, not to the Keychain either.
* **Notifications leave the machine only as you set them up.** A message is built from an allow-list of twelve fields —
  the event, the provider or program, the window's label and kind, a percentage, the kind of wait and times — and the
  privacy check holds its builder to them: never a prompt, a transcript line, a path, a project, a session's id or name,
  an agent, a plan, an account, a token count or a cost. The hosts are the ones you configure, each named by its
  consent and compared at every send — a changed host sends nothing until you allow it — plus one literal, Telegram's
  `api.telegram.org`, on the privacy check's allow-list. The secrets stay in VS Code's secret storage under six fixed
  keys; nothing is read back from a channel but whether it accepted the message.
* **Every network call site is in a table.** The privacy check now holds every place in the source that can reach the
  network — the quota fetch, the notification channels' one fetch, the SMTP connection — to a table with the kind of
  host each reaches and why; a fetch, a socket or a network module anywhere else fails the build.

### Internal

* **Snapshot and export.** `STATE_VERSION` 8, `AGENT_TABLES_REVISION` 10 and `EXPORT_SCHEMA_VERSION` 4 are unchanged —
  the first start of 1.12.0 rebuilds nothing, and every export field means what it did.
* **The re-key ledger.** 1.12's holds 121 entries since the 1.11.0 release (`l10n/rekey.json`), which the twenty-four
  languages worked through as pending lists, six at a time; `node scripts/nls-sources.mjs --check --strict` is the gate
  again since the join. None of it ships.
* **The frame learned 1.12's names before its texts were written** — the environment variable, the Secret Service,
  the channels' services and the protocols —, reads a product name across a line break, lists the texts whose
  placeholder is a session's name (the page's own `tr()` calls included), lets a key that names a setting's fields by
  their ids keep them in English, and holds what a language keeps: a name never translated, no markdown mark in a
  notification text that its English lacks.
* **Tests with a real child and real sockets.** The app-server's tests start a stand-in `codex app-server` and assert
  it gone after every end; the channels' tests post to local HTTPS and SMTP servers with throwaway certificates; no
  test reaches the network.
* **The dashboard harness** checks that a duration's parts stand on one line at the narrowest sidebar in every
  language, and reads the English chip and metric words on every page.

## 1.11.0 — <date set at publish>

**Twenty-six languages, the records the dashboard still lacked, and a price table you can audit.** Twelve
more languages join the flag at the top of the dashboard — Nederlands, Українська, Svenska, Norsk, Dansk,
Suomi, हिन्दी, Bahasa Indonesia, Tiếng Việt, Ελληνικά, Magyar and Română —, translated by AI agents from the
English text and checked by tests, not by native speakers, as the twelve of 1.9 were; typing a letter in the
open list jumps to the next language. The Records section gains four tables: the most expensive days, the
longest and the largest Claude Code sessions, and the hours with the most cache written. Every figure of
API cost now says where its price came from — the tooltips name the price table's check days and source
pages beside every cost table, the cost column's head says *API cost (your rates)* while your own rates
apply, and an export carries the list price beside your figure with the day of the rule each was priced by.
Beside it the 1.10 leftovers: a Chinese stacked table's double gap, a forecast warning that could say
"before it resets (reset due)", the "both" reset format in Japanese, Korean and Chinese, and what
`resetHourCycle: auto` follows.

### Added

* **Twelve more languages.** Nederlands, Українська, Svenska, Norsk, Dansk, Suomi, हिन्दी, Bahasa
  Indonesia, Tiếng Việt, Ελληνικά, Magyar and Română — twenty-six languages, twenty-seven lines in the
  list with *Automatic*. Each switches the status bar and its tooltips, the dashboard, the Quick Pick, the
  markdown document and every dialog at once, as the flag or `tokenPace.language` chooses it; the settings
  and the command titles follow VS Code's display language, and VS Code has a language pack for Hungarian
  only (last updated for VS Code 1.48, 2020) — for the other eleven `auto` shows English and the flag picks
  them, the settings staying in VS Code's language. Norwegian is Bokmål (`nb`). Devanagari and Greek are
  drawn with your system's fonts; Token Pace ships none. **These translations were made by AI agents
  (Claude Opus 5.5) from the English text, with the German as a second reference, and checked by tests for
  completeness, placeholders, marks, the settings' status-bar examples and freshness — not by native
  speakers**; their register was chosen from common usage, not verified against a style guide, and a wrong
  or clumsy word is a bug to report. The twelve languages of 1.9 carry every text 1.11 added or changed,
  through the ledger of English changes, by AI agents as well.
* **Four Records tables.** The `records` section — off by default, `records` in
  `tokenPace.dashboard.sections` — ranks, after the top models, projects and sessions: *Most expensive
  days*, the range's days by their API cost at your configured rates, a day whose cost is a lower bound
  marked `⚠` (it holds usage without a price on file, or the transcripts on disk begin that day); *Longest
  sessions* and *Largest sessions*, the Claude Code sessions of the last 7 days that are no longer active
  — no counted line for 10 minutes — by the time from their first counted line to their last, pauses
  included, and by their usage, their own and their agents', each named by its start and the first eight
  characters of its id (`Tue 14:20 · 9d0eb37a`), a session still active counted in a note and not ranked;
  *Hours with the most cache written* — hours, not requests: the hour buckets by the tokens written to
  the prompt cache, with the part written for one hour, what those writes cost and the models that wrote
  them, since a large cache write is usually a cold start, a new conversation or a compaction and one hour
  can hold several. `tokenPace.dashboard.topN` rows each (the setting that caps every Records table); the
  Quick Pick and the markdown document carry the same rows; nothing is stored, so a rescan that reads fewer
  transcripts shows fewer records, never an old one.
* **Type-ahead in the language list.** In the open list a letter moves the focus to the next language
  whose own name or name in your language begins with it, round the list — `h` reaches *हिन्दी*, then
  *Magyar* —; nothing is chosen by it, Enter or Space still chooses.

### Changed

* **Every tooltip with an API cost names the price table's check days and sources**, whether or not
  `tokenPace.tooltipExplanations` is on: under the cost tables of the quota entries, the tokens and cost
  entries and the budget entry one line says *Prices as of …*, the rows checked later, *your configured
  rates* whenever your multiplier or custom prices apply, and *Price sources: docs.claude.com,
  platform.claude.com.* — the pages the tooltip's own providers' prices were read from, by host name; a
  Codex tooltip names no Claude row. The dashboard's footer names the pages beside the days the same way
  (*Price sources: docs.claude.com, platform.claude.com, developers.openai.com.*, under a provider view
  that provider's own), and *Copy Usage Summary*, the Quick Pick and the markdown document print it.
* **The cost column's head says whose rates.** While `tokenPace.pricing.multiplier` is not 1 or
  `tokenPace.customPrices` applies, every *API cost* column of the dashboard is headed *API cost (your
  rates)*, and the key figures' *API equivalent* explains itself as *what the same tokens would have cost
  through the API at your configured rates*.
* **The exports carry the list price beside your figure** — schema 4. After `priced` the CSV gains
  `listCostUsd` (the same usage at the published list price: multiplier 1, no custom price), `priceFrom`
  (the day the price rule used was read) and `priceApproximate` (`true` where no rule covered the bucket's
  day and the nearest one was used); the JSON the same per bucket, `listCostUsd` in `totals`, and in
  `pricing` the rows checked after the table's day (`checked_later`, every provider's) and the source pages
  as host names (`sources`). An unpriced bucket leaves all three empty; where a custom price alone prices a
  model the table does not know, the list amount equals your figure — a discount against a price never
  published would be an invention. Everything versions 1–3 wrote is still there and still means the same
  thing; a reader of schema 3 reads the same values from a schema 4 file.
* **`tokenPace.resetHourCycle: auto` says what it does**: *Follow the operating system's clock format (the
  locale the extension host runs under), not the language of Token Pace's texts* — it never followed the
  display language, and the settings said so.
* **The Records section waits for the history.** During the first scan, a re-read and the replay of the
  agent tables it says *Reading history…* and shows no record at all — no peak day, no streak, no table —
  so that no record is read from half a history.
* **The settings' `records` and `dashboard.topN` sentences** name the four new tables.

### Fixed

* **A stacked table's label in Chinese** left a double gap after its full-width colon `：` at the
  narrowest side bar; the page now writes one space after a plain colon and none after a full-width one,
  whose glyph carries its own blank — one gap in every language.
* **A forecast warning could say "before it resets (reset due)"** when a window's reset had already
  come before the reading was judged; such a window raises no forecast warning now — the next reading
  brings the new window.
* **The "both" reset format in Japanese, Korean and Chinese** now places its own brackets and verb:
  `06:00 にリセット（2h14m 後）`, `06:00 초기화(2h14m 후)`, `06:00 重置（2h14m 后）` and `06:00 重設（2h14m 後）`
  — the countdown used to be joined with ASCII brackets in every language, and the settings' example of
  each language quotes what its bar prints. English and German print what they printed.

### Privacy

* **Twelve more of Token Pace's own files** are read: the translation file of each new language,
  `l10n/bundle.l10n.<id>.json` inside the extension's folder — twenty-five translation files in all, each
  shipped with the extension, its name built from the registry's id only, never from the setting's text;
  nothing of yours, nothing of another program, nothing over the network.
* **The longest and largest sessions are named as the Agents section names them** — a weekday, a time
  and the first eight characters of the session id; never a project or a path. A test puts a project name
  into the session index's key and an agent's file and finds it in no record, no Quick Pick item, no
  markdown document and no export.
* **The exports' new fields** are dollar amounts, ISO days, `true` or empty, and host names from a
  constant in the code — never a path, a URL with a path, or a session or project name the export did not
  already carry.

### Internal

* **Snapshot and export.** `STATE_VERSION` 8 and `AGENT_TABLES_REVISION` 10 are unchanged — the first
  start of 1.11.0 rebuilds nothing —; `EXPORT_SCHEMA_VERSION` 3 → 4 for the fields above.
* **The re-key ledger.** `node scripts/l10n-rekey.mjs --start <sha>` begins a version's ledger at the tree
  as it is; 1.11's holds 67 entries since the 1.10.0 release (`l10n/rekey.json`, its count read by a test),
  which the twelve languages of 1.9 worked through as pending lists, while a new language is a whole
  translation from the frozen English and never a pending list. `node scripts/nls-sources.mjs --check
  --strict` is the gate from the join on. None of it ships.
* **The frame learned the new scripts before a language was written.** Ukrainian, Greek and Hindi join
  the languages of another script; the heat map's weekday words are counted in grapheme clusters, not code
  points (`शुक्र` is two on the screen and five code points); `”` may open a quotation (Swedish, Finnish);
  the Greek ano teleia is refused, since NFC turns it into the separator `·`; and a third synthetic
  language — the English with every word turned into `शुक्र`, under `hi` — runs every rule.
* **The reading pass after the translations** changed 197 values in 23 of the 24 languages beyond English
  and German where an AI reader named a fact of the language — a gender, a case, what a pronoun refers to
  — with the English frozen; the questions only a native speaker can settle stay open.
* **The dashboard harness** probes every language's default page, Prompts page and Records page — 551
  probe files —, measures every character of every page in another language than English against a
  font's missing-glyph box, and holds the picker's flag to the registry's.

## 1.10.0 — <date set at publish>

**A prompt list that types into Claude Code's and Codex's terminals, and the 1.9 leftovers in every
language.** A new dashboard section, *Prompts* — off by default, added with `prompts` in
`tokenPace.dashboard.sections` — holds your own prompts, starting with three Token Pace ships: *Status
table*, *Keep the cache warm* and *Stop after this task*. A double-click on one, its send button or
Ctrl+Enter types its text into the VS Code terminal of this window that runs Claude Code or Codex and
presses Enter — always on your click, never on its own —, and where Token Pace cannot tell a Claude Code
at work from one waiting for your answer in a dialog, it asks first. A click opens a prompt's title and
text to edit; the list lives in one file of the extension's storage and nowhere else. Beside it, what 1.9
left for the twelve languages: the settings' examples say what the status bar prints in each language,
decimals follow the language everywhere on the page, a figure stays with its unit and a percentage with
its verdict at the narrowest width, and every text 1.10 added or changed reached the twelve languages —
translated by AI agents, as in 1.9, and not reviewed by native speakers.

### Added

* **The Prompts section.** `prompts` in `tokenPace.dashboard.sections` — not in the default; add it
  where you want it, first for the quickest reach — shows your own list of prompts. It starts with three
  Token Pace ships, each a title and a one-line text: *Status table* (`Show the current progress in a
  clear table. Columns: step/status | description | model | duration | expected to finish.`), *Keep the
  cache warm* (the keep-warm line, `Ignore this message. No action. No response.`) and *Stop after this
  task* (`Stop after the current task and do not start any new work.`). Until you edit one, a shipped
  prompt's words follow the language of Token Pace's texts — the keep-warm line stays English in every
  language. A click on a prompt opens its title and text in place (after 300 milliseconds, so that a
  double-click sends instead); Enter or leaving the fields saves, Escape leaves the prompt as it was,
  *Delete* asks in the page first, *Move up* and *Move down* reorder, *New prompt* adds one. A title has
  1 to 80 characters, a text 1 to 2000 on one line — a line break becomes a space, since a typed line
  break would send the first line on its own —, the list holds at most 50 prompts, and a text that starts
  with `!` is refused: it would run a shell command in Claude Code. A text that starts with `/` is a slash
  command and is shown in the editor font. The section stays on the page whatever the provider switch
  shows and no chip filters it; the Quick Pick and markdown modes of the dashboard have no prompts.
* **Sending.** A double-click on a prompt, its send button or Ctrl+Enter (⌘+Enter on a Mac) types the
  prompt's text into the terminal of this window that runs Claude Code or Codex and presses Enter: the
  active terminal when it is one, else a pick of exactly those terminals, each named by its place in the
  window's list — *Claude Code — terminal 2 of 3* — with *ready*, *sending asks first* or *not now*
  beside it; never another terminal, never a terminal of another window, never the Claude Code
  extension's own panel, which no extension can type into. The text and the Enter are two writes, 200
  milliseconds apart — typed in one piece with its Enter, a longer text sits in Claude Code's input box as
  pasted text, unsent. **Anything you typed in that terminal and did not send goes with the prompt**; the
  section's first line says so, always. After the send the terminal is shown, the keyboard stays on the
  dashboard, and the section says *Sent to Claude Code in terminal 2 of 3.* for ten seconds. Sending was
  tried with Claude Code (2.1.282 and 2.1.283) only; Codex is recognised by the same shell-integration
  rule and was not tried.
* **When Token Pace asks first, and when it does not send.** Before anything is typed, the terminal and
  — for Claude Code — every session of its folder are checked from facts Token Pace keeps anyway. Where a
  send is known to be unsafe it does not send and says why: in Restricted Mode; while it reads the
  transcripts; with no such terminal; while the agent hook reports a permission request open in a session
  of that folder (the text and Enter would answer it); and while the Claude Code in that terminal has not
  written a line since it started — a fresh `claude` showed three dialogs of its own before its prompt was
  empty, the folder-trust question with *No, exit* highlighted among them, and a text typed into a dialog
  answers it and is lost. Where the transcript cannot tell Claude Code at work from Claude Code waiting in
  a dialog — an open tool call, a reply that did not end its turn, an agent of the session running,
  another session of the same folder busy, a Claude Code whose start Token Pace did not see (after a
  window reload, say), a terminal whose folder VS Code does not report, and Codex, of whose state Token
  Pace reads nothing — it asks first: *Send “Status table” anyway?* with the reason and what an Enter would
  do to an open dialog; *Send anyway* sends, after every check has run once more. Nothing of your answer
  is kept. A prompt that comes while Claude Code works is queued by Claude Code and taken after the turn —
  what *Status table* and *Stop after this task* are for.
* **`Token Pace: Restore Default Prompts`** — in the Command Palette, and the section's button while a
  shipped prompt is missing — adds every shipped prompt missing from the list, at its end, in their
  order; a shipped prompt you edited stays as you wrote it. *Clear Stored Data…* lists the prompt list
  and, deleted, returns it to the three shipped prompts.
* **The `/loop` variant.** Edit the keep-warm prompt's text to `/loop 30m Ignore this message. No
  action. No response.` and Claude Code, its own scheduler, repeats the line every 30 minutes for as
  long as the session runs — in a test it became one scheduled task. The documentation says why 30
  minutes, what every run costs, and how to stop it.
* **Keyboard and screen readers.** Every prompt is two Tab stops, the prompt and its send button: Enter
  or Space opens the fields, Ctrl+Enter sends; a key held down acts once. A screen reader hears the list
  as *Prompts*, a prompt by its title, described by its text and *Enter edits it, Ctrl+Enter sends it.*,
  and the outcome of a send once, politely; where a prompt would go, and whether it goes, asks first or
  not now, stands in words, never in a colour alone.

### Changed

* **The settings' examples of the status bar say what the bar prints.** `Time left — “CC 5h 25% ·
  resets 2h14m”`, `Both — “CC 5h 25% · resets at 06:00 (in 2h14m)”`, `Today — “Σ 3.1M · today”` — with
  the word `resets`, the period the bar adds, in every language's own words (a German bar says `· Reset
  in 2h14m`, `Σ 3,1M · heute`), and a test holds each language's examples to what its bar builds for the
  same fixture. A settings description said the period is named in the summary entry's text only outside
  `today`; the bar always names it.
* **Decimals follow the language on the page.** A key figure's change (`▼ -0,7%` in German), the plan
  factor (`×0,4`), the heat map's variability (`CV 0,35`), a band's share in the chart's tooltip, a span
  under ten hours (`2,5 h`) and the file sizes *Clear Stored Data…* lists (`12,3 kB`) take the language's
  decimal mark; the CSV and JSON exports and the diagnostics report keep the `.`.
* **A window's percentage stays with its verdict.** At the narrowest side bar a window row's figure no
  longer stands alone on a line: verdict and figure wrap together, at the row's right, in every language.
* **The keep-warm countdown's screen-reader label** says *press to cancel* — `Keep-warm line for {0} in
  {1} seconds, press to cancel` —, and each language uses its own verb for pressing a control.
* **Whole sentences where pieces were joined, and clearer words.** The alerts' *runs out* sentences are
  one sentence each in every language (1.9 slotted `in ~2h14m` or `imminently` into them); the summary's
  cache sentence likewise; the context tooltip says *This is the current session's context, as the status
  line reports it — not an account figure, and not comparable to a quota window.*; the Models table says
  *Avg turn time*; the 7-day block's data-quality line says *Agent entries, last 7 days* — an agent entry,
  not a record, which is the Records section's word —; the retrospective's line reads *Share of complete
  cycles that hit the limit: {0} · Avg unused at the reset: {1}*; and the calendar table's column is
  *Active days*, so that *Active* is only ever a session's state.
* **The twelve languages** — Français, Español, Português (Brasil), Italiano, 日本語, 한국어, 简体中文,
  繁體中文, Русский, Türkçe, Polski and Čeština — carry every text 1.10 added or changed, the Prompts
  section's among them: each change went into a ledger of English changes that every language worked
  through, and tests hold that no text and no settings sentence was skipped. The open questions the 1.9
  translations had left per language were decided as well. **This work was again done by AI agents from
  the English text, with the German as a second reference, and checked by tests — not reviewed by native
  speakers.** Turkish keeps the percent after the number (`25 %`), although Turkish typography puts it
  first: a documented limit.
* **The trust statement** in the Extensions view names the two things Token Pace types into a terminal —
  the opt-in keep-warm line, and a prompt of the Prompts section when you send it yourself — and that
  both are disabled in Restricted Mode.

### Fixed

* **The rolled-up bucket sentence** in the data-quality section is singular where it counts one:
  `1 rolled-up bucket in this range has no hour left and is not in the profile`.
* **A figure torn from its unit** at the narrowest side bar — a Korean or Chinese *2 min ago*, a Polish
  unit, the summary's `54 %` — stays with it; an ISO day no longer breaks at its hyphen; and a
  sparkline no longer touches the descenders of the line above it.
* **The stacked tables' colon** is the language's own: `Période :` with a no-break space in French, the
  full-width `：` in Simplified and Traditional Chinese, the plain `:` elsewhere — 1.9 wrote `: ` for
  every language.
* **The summary's cache sentence** in Japanese and Chinese takes the language's own punctuation: it is a
  whole sentence per language now, where 1.9 joined its parts with `, ` and ASCII parentheses.
* **The keep-warm line waits while the transcripts are read.** During the first scan after the window
  opened, a re-read or the replay for the Agents tables the sessions' records are rebuilt, and a check
  could pass a folder whose busy session was still being read: no countdown starts and none ends with
  its line until the reading is done (`reading`, check 14 of the keep-warm line).

### Privacy

* **One file of your own is written**: `prompts.json` in the extension's storage — your prompt titles
  and texts, nothing else: no time, no session, no terminal, no path, no count of sends — only when you
  change the list, whole, a temp file and then a rename. Your titles and texts are shown on the dashboard
  and typed into the terminal you send one to, and reach nothing else: not the log, not the diagnostics
  report (not even a count), not an export, the summary, the usage document or Quick Pick, the status bar
  or a notification's text. The file is not synced, has no export and no import, and *Clear Stored Data…*
  lists and deletes it.
* **The terminals are watched for the Prompts section** as they are for the keep-warm line — by one
  watch that listens while the keep-warm line may act or while the dashboard lists the Prompts section
  in a trusted workspace, and to nothing otherwise. It reads what VS Code's shell integration reports: an
  open command's line, confidence and folder, VS Code's word for what runs in a terminal (`claude` or
  `codex`), and — new — the folder the shell reports for a terminal whose Claude Code or Codex started
  before Token Pace listened, `shellIntegration.cwd`, read only for such a terminal, only when a prompt is
  sent or the section is built, only to compare it with the sessions' folders, and kept by no one. Never a
  terminal's name, its output, its environment or its process; a terminal is named by its place in the
  window's list. Of a Codex session's own state nothing is read.
* **The second thing Token Pace ever types into another program's input** is your prompt — only on
  your own click, never by a timer, a command, a link or a notification, at most one per second, never
  in Restricted Mode, with nothing read back from the terminal. Whether it goes at once, asks first or
  does not go is decided from facts Token Pace keeps anyway — a session's first and newest reply, how the
  newest ended, whether a line of yours came after it, whether an agent of it runs, and with the agent
  hook a permission request — compared at the send and never shown as figures, logged beyond a check's
  code, stored or exported.
* **The extension's exported API** answers the Prompts section's send check (`promptSendCheck`, a seam
  for the extension-host test) only while the host runs in test mode; in a normal window it answers
  `notListed` before reading anything, so no other extension can learn a session's state through it.

### Internal

* **Snapshot and export.** `STATE_VERSION` 8, the export's `schema_version` 3 (`EXPORT_SCHEMA_VERSION`
  3) and `AGENT_TABLES_REVISION` 10 are unchanged: nothing of the snapshot or of an export changes, and
  the first start of 1.10.0 rebuilds nothing.
* **One watch of the window's terminals** (`src/terminalWatch.ts`) serves the keep-warm line and the
  Prompts section; the keep-warm checks it reuses are exported from `src/keepWarm.ts`, not copied, and
  the send decision is a pure function of its own (`src/promptSend.ts`). The keep-warm line gains a
  fourteenth check, `reading`, run right after the first.
* **The re-key ledger.** An English text is its own key, so a changed sentence used to turn twelve
  languages red at once; 1.10 records every English change in `l10n/rekey.json` (115 entries for this
  release) and `scripts/l10n-rekey.mjs` carries each into the twelve languages' files as a pending
  item, which the language's own package works through. Two rules join the frame: T14 (the pending
  lists — none may be left at the join) and T15 (the settings' bar examples are what the bar prints).
  `node scripts/nls-sources.mjs --check --strict` is the gate from the join on. None of it ships.
* **`decimalText`** writes every decimal of the page through `Intl` after rounding as before, so the
  English output is byte for byte what 1.9 printed; CSS geometry and machine output keep the `.`.
* **The read contract** of `npm run check:privacy` gains six rows: `prompts.json` (`v`, `prompts`; an
  entry's `id`, `title`, `text`), a terminal's `shellIntegration`, its `cwd` and its `fsPath`, and the
  one `sendText` of a prompt.
* **The dashboard harness** checks the Prompts section in every language on disk at the narrowest
  width, the layout rules of this release on every language page, and no longer builds a check on an
  empty prefix of a translated message.

## 1.9.0 — <date set at publish>

**Token Pace in fourteen languages, switched at the top of the dashboard.** A flag beside the
provider switch opens the list of languages — English, Deutsch and, new in this release, Français,
Español, Português (Brasil), Italiano, 日本語, 한국어, 简体中文, 繁體中文, Русский, Türkçe, Polski and
Čeština —, and a choice turns the status bar, the dashboard, the Quick Pick, the markdown document
and every notification and dialog from then on into that language at once, without a reload. The
twelve new languages were translated by AI agents from the English text, with the German as a second
reference, and checked by tests for completeness, placeholders and marks; they were not reviewed by
native speakers. The settings and the command titles keep following VS Code's display language,
which VS Code reads when it starts. And the opt-in keep-warm line is no longer held back for up to a
week by a session of the same folder that was left behind.

### Added

* **The language picker.** At the end of the dashboard's top row, beside `Claude Code · Codex · All`,
  a button shows the flag of the language the texts are in — the US flag for English. A click, or
  `Enter`, `Space`, `↓` or `↑` on it, opens the list: `Automatic — as VS Code (English)` first, then
  every language, each with its flag, its own name and, where the two differ, its name in the
  language you read now (`Deutsch · German`); the chosen line carries a ✓. In the list `↓` and `↑`
  move, `Home` and `End` go to the first and the last line, `Enter` or `Space` chooses, `Escape`
  closes it and `Tab` leaves it without a choice; nothing is chosen by moving. A screen reader hears a
  menu button, `Language: English (automatic)`, and each language by its name, in its own voice where
  it has one; the flag is decoration. A choice switches at once, without a reload: the page keeps its
  scroll position and the focus goes back to the flag, and the status bar with its tooltips, the
  Quick Pick, the markdown document and the agent hook's setup document follow; notifications, dialogs
  and consents are in the new language from then on. Two lines under the open list say what cannot
  follow — `Token Pace's own texts switch at once. The settings, the command titles and the
  walkthrough follow VS Code's display language (Configure Display Language).` — and who translated.
  The flags are small drawings shipped inside the extension, the same on every system with no font
  and no download; in a High Contrast theme they keep their colours and get an outline.
* **Twelve languages**: Français, Español, Português (Brasil), Italiano, 日本語, 한국어, 简体中文,
  繁體中文, Русский, Türkçe, Polski and Čeština, beside English and German — every text Token Pace
  draws, with numbers and dates in that language's formats, and, for a VS Code whose display language
  is one of them, the settings' descriptions, the command titles and the walkthrough's titles as well.
  **They were translated by AI agents from the English text, with the German as a second reference,
  and checked by tests for completeness, placeholders and the marks `~`, `⚠`, `≈` and `–` — they
  were not reviewed by native speakers.** The tests hold every language to the same rules: every text
  translated, every placeholder and mark kept, no code, setting or command name translated, no English
  sentence left behind, no exclamation mark; they cannot tell a good word from a clumsy one. A wrong or
  clumsy word is a bug — please report it on the
  [issue tracker](https://github.com/mfvdp/VS-Code_Token-Usage/issues), with the language, the text
  and where you saw it. The notation of the bar and the page is the same in every language: `45m`,
  `2h14m`, `4 m 10 s`, `K`, `M` and `G`, the `$` of an amount, `1 h TTL`, the ISO day and the marks.
  The debug log, the diagnostics report and the CSV and JSON exports stay English.
* **`tokenPace.language`**, the setting the picker writes: `auto` — the default, VS Code's display
  language, and English where Token Pace has no translation for it — or one of `en`, `de`, `fr`, `es`,
  `pt-br`, `it`, `ja`, `ko`, `zh-cn`, `zh-tw`, `ru`, `tr`, `pl`, `cs`, which the settings UI offers
  by each language's own name. It has the application scope: always your user settings, never a
  workspace's, so a cloned repository's `.vscode/settings.json` cannot switch your language. A value
  that is none of these counts as `auto`, and the log says so. VS Code reports its display language
  only while that language's pack is installed, so `auto` gets English without one; choosing a
  language in the list needs no language pack.

### Changed

* **The weekday in front of a clock time** — a reset more than a day away, as the status bar shows
  it with `tokenPace.resetFormat` set to `absolute` or `both` and the markdown view beside a window —
  is the language's own short name in every language but English and German (`lun.`, `pon.`, `Pzt`, `seg.`, `月`, `周一`). 1.8 cut every
  language's to its first two letters, which turned Polish `pon.` into the word `po`. English and
  German keep their two letters, `Mo 06:00`.
* **Copy Diagnostics** names the language in a line of its own, `setting auto · shown de · VS Code
  de`: the setting, the language whose words are shown and VS Code's display language. The report
  itself stays English.

### Fixed

* **A day label under a Japanese, Chinese or Czech display language.** A sparkline point's label
  printed its day as `土 26 9`, `周六 26 9` or `so 26 9` — its words were English, its formats that
  language's, and the marks that make the digits a date were dropped. It is the language's own short
  date now, `9月26日(土)`, `9月26日周六`, `so 26. 9.`.
* **Two weekdays with one label under Brazilian Portuguese.** The two-letter weekday in front of a
  clock time read `se` for both Monday and Friday and `qu` for both Wednesday and Thursday; it is
  `seg.`, `sex.`, `qua.` and `qui.` now.
* **The page's language under a display language Token Pace did not translate.** With VS Code in
  such a language — French, say, with VS Code's French language pack, in 1.8 — the dashboard's
  markup claimed that language (`lang="fr"`) for its English words, and a screen reader could read
  them in a French voice. The page's `lang` is now the language of its words, region included (`pt-BR`,
  `zh-CN`, `zh-TW`), and it moves with the picker.
* **The calibration's figures in German.** With `tokenPace.calibration.show` on, the calibration line
  wrote its figures with a decimal point in every language (`1.2`); it takes the language's decimal
  mark now (`1,2` in German).
* **The keep-warm line and a session left behind.** The keep-warm line is no longer held back by
  another session of the same folder that was left behind — its newest line at least 2 hours old and
  older than the moment the terminal's `claude` started (a prompt that never got its reply, an
  interrupted reply, a window closed mid-turn). In 1.8 such a session held the line back for as long
  as its transcript was kept, up to seven days.

### Privacy

* **One more field of a Claude Code transcript is read**: the `timestamp` of a `user` line of a main
  transcript, matched on the raw line as the unescaped key `"timestamp":"…Z"` — the latest on the
  line; the line is never parsed for it. Kept: the newest such time, one number per main session, in
  the token snapshot for seven days, used only by the keep-warm line's check of the other sessions of
  a folder; never shown, logged or exported.
* **One setting is written for you**: `tokenPace.language`, in your user settings, when you choose a
  language in the dashboard — through VS Code's settings API, the way *Cycle Status Bar Windows*
  writes `tokenPace.windowSelect`; only on that click, only that key, never a workspace's settings.
  *Automatic* removes the key again. If VS Code cannot write your settings, a warning says so and
  nothing changes.
* **Token Pace reads its own translation file** for the language shown,
  `l10n/bundle.l10n.<language>.json` inside the extension's folder — a file it ships, with the
  translations of its own texts and nothing of yours —, at activation and when the setting changes;
  its name is built only from the list of shipped languages, never from the setting's text. Until
  1.8 VS Code read it and handed it over. The language switch reads nothing else: no transcript, no
  file of Claude Code or Codex, nothing over the network.

### Internal

* **Snapshot and export.** `STATE_VERSION` 8 and the export's `schema_version` 3
  (`EXPORT_SCHEMA_VERSION` 3) are unchanged; `AGENT_TABLES_REVISION` 9 → 10, for the time of a
  `user` line (Privacy, above). The first start of 1.9.0 rebuilds the agent tables once (revision
  10), so sessions already read have that time at once; nothing is counted again and the snapshot
  schema stays 8.
* **The day of an hour bucket** is kept per time zone and day boundary by comparing the two directly,
  where a key string of both was built for every bucket: on a synthetic store of 8 700 hour buckets a
  view-model build took a median 26 ms instead of 49 in Europe/Berlin and 26 instead of 31 in UTC,
  measured on the developer's machine — a measurement, not a promise; the figures are the same. A cost
  series asked for without pricing is priced through one shared empty options object.
* **The reset line** of the quota card and the Quick Pick takes `resets at` before a clock time, as
  the status bar does; the card, the Quick Pick and the markdown report hand it a countdown today, so
  nothing on screen changes.
* **The translations are held to one frame.** Every language is checked by the same thirteen rules —
  the keys, the parts, the placeholders, the marks, the code, the page's words, the tone, the tables,
  no English left, the registry, the English quotes, the freshness and the heat map's weekday words
  —, and every manifest translation has a freshness record, the first 16 hex digits of the SHA-256 of
  the English it was translated from, that names every language whose English changed since. Neither
  the records, the translation parts nor the translators' brief is packaged.
* **The dashboard harness** the pages are checked with feeds each page what the extension pushes —
  the view model without its host-only fields —, no longer the whole view model.
* The comments that described engines before Chromium 131 describe what VS Code 1.138 does; the
  built extension is the same.
* **The read contract** of `npm run check:privacy` gains one row, the time of a user line
  (`USER_LINE_TIME_RE`).

## 1.8.0 — 2026-09-25

**A prompt cache that says when it cools, and an opt-in way to keep it warm.** Claude Code keeps
the start of a conversation in Anthropic's prompt cache; once that cache has gone cold, the next
request writes the whole prefix again at the 1-hour write rate instead of reading it at a fraction
of the input price. From five minutes before a Claude Code session's one-hour prompt cache expires,
the Claude quota card now says so — `Session Tue 14:20 · 9d0eb37a · prompt cache cools in 4 m 10 s
(1 h TTL)` — and what a cold start would cost against a cache read. The figures are measured where
the status line describes the session and estimated from its transcript, marked `~`, where it does
not. An opt-in `cache` status-bar entry shows those last five minutes, and the Codex card says until
when OpenAI keeps a prompt prefix at least. Off by default and behind a consent of its own, Token
Pace can also type one fixed line into the VS Code terminal that runs a session, after a one-minute
countdown you can cancel, so that Claude Code sends a request before the cache expires. The
status-line bridge now keeps only the fields Token Pace reads, and its script lives in the
extension's storage, where an update no longer takes it away.

### Added

* **The cooling warning on the Claude card.** Only a one-hour prompt cache is watched — a
  five-minute one would be "cooling" right after every reply. From five minutes before its expiry
  the card lists the session after its windows, in the dim tone, in two lines: its state,
  `Session Tue 14:20 · 9d0eb37a · prompt cache cools in 4 m 10 s (1 h TTL)`, and what a cold start
  would cost, `A cold start after 14:52 re-writes 152.3K tokens at the 1 h write rate (2× input,
  ~$1.22) instead of reading them from the cache (0.05× input, ~$0.03).` After the expiry the lines
  say `cold since 14:52` and `The next request re-writes …` for another hour, then the session is no
  longer listed. At most three sessions, the most urgent first, then
  `2 more sessions with a cooling or cold prompt cache`. A session is named as the Agents tree names
  it. The factors are the price table's own — the model's 1-hour write rate and its cache-read rate,
  each divided by its input rate, with your `tokenPace.customPrices` and `tokenPace.pricing.multiplier`
  applied: 2× and 0.05× for Claude Opus 5.5, 2× and 0.025× for Claude Fable 5.1 and Mythos 5.1, 2× and
  0.1× for every other Claude model. The money appears only with `tokenPace.showCost`, always with
  `~`, as the dashboard's hypothetical API amount; a model without a price of its own — unknown, or
  priced only through the family fallback — keeps the words and loses factors and money. Nothing on
  the card blinks, and the phase is said in words, never by a colour. The markdown view lists every
  watched session, warm ones too, at most ten; the Quick Pick and the Claude quota item's tooltip
  carry the card's lines. *Copy Usage Summary*, the exports and *Copy Diagnostics* say nothing of
  it: a cooling cache is a moment, not a record.
* **The `cache` status-bar entry**, opt-in through `tokenPace.statusBar.show` and not in the
  default: `$(watch) cache 4m` while a watched one-hour cache is cooling — its last five minutes —,
  `$(watch) cache ~4m` when the expiry is estimated from the transcript, `45s` under a minute, `+1`
  for each further session cooling at the same time. Hidden while none is cooling, a cold cache
  included; no colour and no alarm; a screen reader hears
  `Prompt cache of Session Tue 14:20 · 9d0eb37a cools in 4 m 10 s`. Its tooltip names up to three
  cooling sessions with what a cold start would cost, then `and 1 more`. *Preview Status Bar States*
  shows two such entries.
* **The Codex line.** For 30 minutes after a Codex turn of GPT-5.6 or later, the Codex card ends
  with `Codex prompt cache · last request at 14:22 · OpenAI keeps a cached prompt prefix at least 30
  minutes after its last use for GPT-5.6 and later — ~until 14:52, perhaps longer.` It is a minimum
  OpenAI documents for its API, not an expiry: no countdown, no cooling, no cost, no status-bar
  entry and nothing per session. Earlier models get no line, and neither does a turn dated more than
  ten seconds ahead of the local clock.
* **The keep-warm line — opt-in, off by default.** With `tokenPace.cacheKeepWarm` switched on and
  its own consent given, when the status line reports that a session's one-hour prompt cache has
  three minutes or less left, a status-bar item of its own counts down 60 seconds —
  `$(watch) keep warm in 42 s · cancel`, shown whatever `statusBar.show` lists, with no colour and no
  alarm. When it ends and every check still holds, Token Pace types
  `Ignore this message. No action. No response.` into the VS Code terminal that runs the session and
  presses Enter, at about two minutes left, so that Claude Code itself sends a request with its own
  login; whether the cache entry then lives on is Anthropic's rule, which Token Pace does not
  measure. A click on the item, or *Token Pace: Cancel the Keep-Warm Line*, cancels the line and
  keep-warm for the rest of that session's idle phase; the setting stays as it is. The checks, all
  of them when the countdown starts and all again when it ends: the setting on, the consent given,
  the workspace trusted; a one-hour cache the status line measures — never the transcript's
  estimate; the session idle — its newest reply at least a minute old and finished, nothing of yours
  after it, no agent of it running, no permission request of the agent hook after it; exactly one
  terminal of this window running `claude` in the session's folder as VS Code's shell integration
  reports it, and running this session — the newest the folder began after that `claude` started
  —, while every other session of the folder is idle too; that terminal not the active one of the
  focused window since the session's newest reply, so the line goes only when you left the Claude
  terminal before its newest reply ended; at most three lines per idle phase, the last one answered;
  no Claude quota window at 90 % or more, or reached. The consent dialog names what is typed and
  when, the cost — every line is a real request that counts against your usage limits —, that a
  draft left in Claude Code's input line is sent with the line, that the Claude Code extension's own
  panel is out of reach, and the passage of section 3 of Anthropic's Consumer Terms on automated
  access, which this falls under. A Claude Code started before the setting was on, or before the
  window opened or was reloaded, is out of reach until it is started again. Answered lines are
  counted per local day in `keepwarm.json` in the extension's storage and shown on the Claude card
  and in the markdown view, `Keep-warm requests today: 2 · 64 tokens`; the card also notes, under
  the session, a countdown under way, a cooling session no terminal of this window runs, and a line
  that got no answer within two minutes, after which no further line goes in that idle phase.
  *Clear Stored Data…* lists `keepwarm.json` and the keep-warm consent. The setting has the
  application scope, so a workspace's `.vscode/settings.json` cannot switch it on.

### Changed

* **1.3.0's promise about the prompt cache is given up for the watch.** 1.3.0 said: "Without the
  bridge there is no line — nothing is estimated." Where the status line does not describe a
  session's newest request — it is not connected, or it last ran for another session —, the session's
  one-hour cache is now estimated from its transcript: the newest request that read or wrote the
  cache, plus one hour, and its size. Every figure of such a line carries `~`, and the line says
  *estimated from the transcript* in words. The status line's own prompt-cache line of 1.3 stays as
  it was, measured.
* **One line per session.** For a session the card lists as cooling or cold, its lines replace the
  status line's own prompt-cache line — on the card, in the tooltip and in the Quick Pick; the
  markdown view, which lists warm sessions too, prints that line only for a session it does not list.
* **Claude Opus 5.5 is priced.** $4 per million input tokens, $5 for a 5-minute cache write, $8 for a
  1-hour cache write, $0.20 for a cache hit and $20 for output, fast mode $8 in and $40 out — from
  Anthropic's pricing page as checked on 24 September 2026. Until now its usage was reported as
  unpriced, a lower bound with the model named; it is priced everywhere the page shows a cost, and
  its usage from the days before 24 September is priced from this row and marked `approximate`. The
  footnote names the row's own check day beside the table's — `Prices as of 2026-09-06; checked
  later: claude-opus-5-5 (2026-09-24).` —, and so does the Models table's `list as of` date. The opt-in
  family fallback now prices an Opus model the table does not know at Opus 5.5's rates, the newest
  priced Opus.
* **The status-line bridge's consent dialog** says what the script keeps — the fields Token Pace
  reads, never the session's name, its working directory or its transcript's path — and that the
  command runs the script's copy in the extension's storage, which an uninstall deletes: disconnect
  first.
* **The descriptions** of `tokenPace.statusBar.show` (the `cache` value) and of the workspace-trust
  capability (three opt-ins, all off in Restricted Mode), and the walkthrough, say all of this, in
  English and German.

### Fixed

* **The status-line bridge after an update.** The installed `statusLine.command` named the script
  inside the extension's versioned folder, which every update removes: the status line then started
  a script that was gone, and Token Pace still called the bridge installed. The command now names a
  copy in the extension's storage, `statusline-bridge.js`, which every activation replaces with the
  shipped script when the two differ. A command an install of 1.3 to 1.7 wrote is moved to the copy
  once, on the first activation of 1.8 in a trusted window — the write you consented to at install
  time, a backup of the original `settings.json` first, only the command string changed, and only
  while the entry still holds the command Token Pace recorded; the log says so. The state reads
  installed only while the script the command names exists, and connecting again over such a
  command moves it instead of chaining the old bridge as the previous status line.
* **The details panel of the Agents tree outside the side bar.** With the view dragged into the
  panel area, an open details box showed the side bar's colour. It paints no colour of its own now,
  and the guide lines stop a pixel above it and go on a pixel below it instead of passing behind it.
* **Thin subagents' bands in a forced-colours theme** (Windows High Contrast). A subagents' band of
  the chart's split under 4 px tall was filled whole by its ring and read as a main-session band; it
  is striped now, one pixel in the text colour in three.
* The status-bar page's table of item ids lacked the running agents' `tokenPace.agents`, missing
  since 1.6.0.

### Privacy

* **The status-line mirror keeps only what Token Pace reads.** Claude Code pipes its whole status
  JSON into the bridge's script — the session's AI-generated name, its working directory, its
  transcript's path, the workspace and the Claude Code version among it —, and 1.3 to 1.7 stored it
  so in `statusline-mirror.json`. The script now writes of it only the fields Token Pace reads — the
  rate limits, the plan, the context window, the cost's `total_cost_usd`, the model, the prompt cache
  and the session's id — and drops the rest before the file is written. The first activation of 1.8
  rewrites a mirror an older script wrote with only those fields, or deletes one it cannot read.
* **Two fields more of that mirror**: `session_id`, to tell one session's prompt cache from
  another's — letters, digits, `_` and `-`, at most 64 characters, shown only as its first eight —,
  and `prompt_cache.recache_tokens_if_cold`, the size a cold start would re-write. The readings are
  kept in memory only, one per session, at most 16, none older than two hours.
* **Nothing new is read from a transcript.** Of a main session's newest reply that used the prompt
  cache, its time, the kind of cache it wrote, its size and its model are kept — from what the token
  count reads of every reply anyway —, with its `stop_reason` (six values, any other as none) and
  whether the newest message line is the user's, told by the line's top-level `type` alone. Of the
  Codex rollouts, the time and model of the newest turn. All of it stays in the token snapshot, and
  none of it is exported or logged.
* **The keep-warm line** reads, only while it is switched on and allowed, what VS Code's shell
  integration reports of this window's terminals — a running command's command line with VS Code's
  confidence in it and its working directory, tested and kept by no one, and VS Code's name for the
  shell — never a terminal's name, its output or its environment, and nothing is read back from a
  terminal. It writes the one line and `keepwarm.json`: per day the number of answered lines and
  their tokens, never a session, a path, a time of day or a terminal. With the setting off, without
  the consent or in Restricted Mode no terminal is listened to.
* **Three opt-ins now**, each behind its own consent dialog and all three disabled in Restricted
  Mode: the shared quota cache file, the status-line bridge and the keep-warm line.

### Internal

* **Snapshot and export.** `STATE_VERSION` 8 and the export's `schema_version` 3
  (`EXPORT_SCHEMA_VERSION` 3) are unchanged; the export gains nothing and its `as_of` stays the
  table's day. `AGENT_TABLES_REVISION` 8 → 9: the first start after the update rebuilds the agent
  tables once from the last seven days' transcripts, counting nothing twice, so that a session quiet
  at the update has its prompt-cache estimate at once and not only with its next reply.
* **What the page is sent.** While the provider switch shows Codex, no Agents or Context fragment is
  pushed that the page would drop (on the harness's large run a minute of a running agent sent 441 KB
  of them; now none); the whole-page push leaves out the second copy of the budgets the status bar
  and the alerts read (1.6 KB less with three budgets); and the quota push leaves out the watch
  list's warm entries, which only the markdown view prints.
* **Lookups kept.** A view-model build looks up the calendar parts of an instant, a model's normal
  name and its price on a day once per key instead of per bucket: on a synthetic store of 8 700 hour
  buckets a median 36 ms instead of 53 in UTC and 55 instead of 73 in Europe/Berlin — a measurement,
  not a promise; the figures are the same.
* Opening a folded section of the dashboard runs every fit again — one listener instead of two.
* **The read contract** of `npm run check:privacy` covers the status-line mirror (13 rows, the
  narrowing at activation among them), a transcript's user line, and the keep-warm host's reads of
  VS Code's shell integration and of `keepwarm.json`; the bridge's bundle is held to `child_process`,
  `fs` and `path`, like the agent hook's to `fs` and `path`.

## 1.7.0 — 2026-09-24

**One provider at a time, a quieter agent tree, and three fixes from a Windows machine.** A switch
at the very top of the dashboard — `Claude Code · Codex · All` — shows the whole page for one
provider: its quota card, its tokens, its chart, its models, its budgets; `All` is the page as it
was. The Agents section lists the sessions that are active now and puts every other one into a
single closed row, `Earlier sessions (12)`; an agent's name says its state in colour as well —
green done, yellow unknown, red failed, blue running —, and guide lines connect every child to its
parent. When Token Pace's own quota fetch fails — a `429` and its backoff — the old figure no longer
stands there without a word: the card, the tooltip and a stale status-bar entry say when the last
attempt failed, why, and when the next one is. On Windows the quota fetch now names the Claude Code
version in use, an npm install included.

### Added

* **The provider switch.** Three buttons at the very top of the dashboard, above everything else —
  `Claude Code`, `Codex`, `All` (German „Alle") —, one of them pressed. Under one provider the page
  shows only that provider's quota card, token totals, chart, models, tools, projects, sessions,
  reset history and data quality, and of the budgets the `total` ones and that provider's own, each
  with the figures `All` shows; a footnote says so. `All` is the page as it always was. A change of
  provider clears the model chips. The choice is remembered with the rest of the view state, the
  button you pressed keeps the keyboard focus, and the switch is a labelled group of toggle buttons,
  each at least 24 × 24 px, on one line down to the narrowest sidebar.
* **Earlier sessions in one closed row.** The roots of the Agents tree are the sessions active now —
  their own transcript wrote within the last ten minutes, or one of their agents runs —, the most
  recent first; every other session of the last seven days sits in one row after them,
  `Earlier sessions (12)`, closed until you open it, its second line the tallies of the sessions it
  holds added up. It has no state, no glyph and no details: a click, `Enter` or `Space` opens and
  closes it, and it stays as you left it. A session moves out as soon as it is active again and back
  in once it is idle, so a running agent is never inside it and the running list is the same as
  before. At most 20 active and 20 earlier sessions are listed, the rest counted under the tree. The
  markdown report prints the group as one list item with its sessions one level in, and the Quick
  Pick's summary counts them too.
* **State colours on the rows.** The name of an agent, a launch, a run and a run's collector is in
  the colour of its state — green done, yellow unknown, red failed, blue running —, and so are those
  parts of every tally (`3 ✓` green, `1 ✕` red). Each colour is the theme's own, mixed with the text
  colour so that it reads as text: at least 4.5:1 on Dark Modern, Light Modern, 2026 Dark and 2026
  Light. The colour is the third sign beside the glyph and the words, never the only one; a stopped
  or superseded agent, a session, the row of earlier sessions and the row whose details are open keep
  the text colour, and a forced-colours theme puts its own text colour on all of them.
* **Guide lines in the tree.** A line runs down from every opened node past its children, with a stub
  into each one, the last one ending at its stub — in the colour of the explorer's indent guides,
  behind the rows and behind an open details panel, decoration only; in a forced-colours theme in the
  text colour.
* **The failed attempt beside a stale reading.** When a fetch of Token Pace's own fails after the
  reading on screen and the cause passes by itself — a `429` and its backoff, a server error, a
  network error —, the older figure stays and one sentence says what happened:
  `Last attempt at 14:20 failed: HTTP 429 — backing off before the next attempt · next attempt in 1h12m`.
  It stands directly under the header of the dashboard's quota card, in the tooltip, in the markdown
  view, the Quick Pick and *Copy Usage Summary*; once the reading is stale, the status-bar entry adds
  ` · $(clock) retry 1h12m` after its age, in the grey of a stale reading and never as an alarm. A
  next attempt whose time has passed reads `due`, and `waiting for focus` while
  `tokenPace.pollOnlyWhenFocused` holds it back in a window that has been in the background for more
  than ten minutes (the log says so once per hold). A permanent cause — missing or rejected
  credentials, a `403`, no `codex` executable — is not said beside a reading; it shows, as before,
  where no reading is left. The sentence survives a restart during the backoff.

### Changed

* **The provider chips became the switch.** The filter bar keeps its `Range` and `Models` rows; the
  providers are picked above the page. Unlike the chips, the switch also reaches the quota cards, the
  Tokens section, the budgets, the reset history and the data quality.
* **The Agents and Context sections are left out while the switch shows Codex** — no heading, no
  fold, no gear — and come back in their place under `Claude Code` or `All`.
* **The markdown view, the Quick Pick and *Copy Usage Summary* follow the switch**: the markdown's
  range line and the summary's heading end `· Codex only`, the Quick Pick's first line starts with
  the provider, and none of them prints an Agents or Context part under Codex. The status bar, its
  tooltips, the `budget` and `agents` entries, the alerts, the CSV and JSON exports and *Copy
  Diagnostics* follow no view: they show every provider their settings name.
* **Copy Diagnostics** says `next attempt` where it said `backoff until` — it prints the next attempt
  our own fetch wants, the end of a backoff included — and names the kind and the time of the last
  failed attempt per provider, never its words.
* **Where the user agent's version comes from on Windows.** `claude --version` is started only from a
  `claude.exe` in a directory of the `PATH`, by its full path and without a shell. Where there is
  none — an npm install puts only the shim `claude.cmd` there, which is never started — the version
  is the one the newest Claude Code session on the machine wrote into its transcript, and only where
  neither is known a fixed one. The log names the source once, and again when it changes;
  `tokenPace.userAgent: honest` sends none of it.
* **The descriptions** of `tokenPace.userAgent`, `tokenPace.pollOnlyWhenFocused`,
  `tokenPace.staleAfterMinutes` and of the `agents` and `context` sections, and the walkthrough, say
  all of this, in English and German.
* **Snapshot and export stay as they were.** `STATE_VERSION` 8, `AGENT_TABLES_REVISION` 8 and the
  export's `schema_version` 3 (`EXPORT_SCHEMA_VERSION` 3) are the values 1.6.0 wrote, unchanged: the
  update replays nothing and re-reads nothing.
* For contributors: a view-model build copies the token buckets once and hands that one copy to every
  table — one copy instead of 25, the same figures; the compaction row's words are three whole
  templates instead of the bare words `auto` and `manual`, so no other `auto` can take their
  translation; the extension test's fake host unsubscribes a disposed activation, each test waits for
  its own activation's cold start, and the extension drops a cold scan's answer that arrives after its
  window has gone; the Windows version probe has its edges injected, so its tests run on every
  platform.

### Fixed

* **`retry reset due`.** A retry whose time had passed read `retry reset due` (German „neuer Versuch
  in Reset fällig"); it now reads `retry due`, and `reset due` is a reset's word only.
* **The Claude Code version on Windows with an npm install.** Without a shell the npm shim
  `claude.cmd` cannot be started, so the quota fetch named a fixed Claude Code version rather than
  the one installed; it now names the one in use (above).
* **A stray space for screen readers.** The `⚠` of a lower bound on an agent's row was an image with a
  name of its own, and Chrome read the figures as `12.3K lower bound , since 11:59`; the mark is now
  hidden from screen readers and its words stand in the line: `12.3K lower bound, since 11:59`.
* **The chart's bands by model in a forced-colours theme** (Windows High Contrast) were all painted in
  the page colour. They are drawn as patterns in the theme's two colours — the largest model of a
  provider solid, then stripes, cross-hatch and lines, dots for `other` —, each ringed by the page
  colour; a band drawn under 4 px tall keeps its pattern without the ring, which would cover it whole,
  the dots of `other` in its middle.
* **A next attempt nothing waits for is no longer called due.** While a fresh reading from the status
  line or a cache file answers the fetch, the markdown view's `next refresh` said `reset due`; it now
  names when that reading turns older than the interval, and a background window showing such a
  reading says neither `due` nor `waiting for focus`.
* **A `$(…)` inside a Codex error or plan name** could print as an icon in the Quick Pick; it prints as
  text.

### Privacy

* Nothing new is read from any Claude Code or Codex file, and the read contract is unchanged. Three
  uses are new. The `version` the agent tree already read of a counted reply — the newest main
  session's, never an agent's — becomes the second source of the `claude-code/<version>` user agent,
  and only for the one consent-gated quota fetch in `quotaSource: poll` with `tokenPace.userAgent:
  claudeCode`. On Windows each `PATH` directory is checked for a `claude.exe` by its existence alone —
  nothing is read from it — and that file is started without a shell; a `.cmd`, `.bat` or `.ps1` never
  is. And the extension's own `quota.json` keeps the last failed attempt per provider — its time, its
  kind and the fetch's own words, never a credential, a header or an exception's text —, cleared by the
  next successful fetch, by *Clear Stored Data…* and with the file.

## 1.6.0 — 2026-09-24

**Your Claude Code agents, in the dashboard.** A new Agents section shows the sessions of the last
seven days as a tree of their workflow runs and agents, with the agents running right now listed
first. Every session and run says what its agents came to — started, done, failed, retried,
stopped, still running — and every state says whether somebody recorded it or it was inferred.
Failures, stops, replaced attempts and requests the API rejected are told apart; a large run stays
readable, fifty agents at a time; the tree works with the keyboard and a screen reader. A 7-day
block shows where the agent tokens went, the quota cards say how much of each Claude window came
from subagents, the chart can split every day by main session and subagent, and the Quick Pick,
the markdown report and the exports carry the agents too. Two opt-ins join: the running agents in
the status bar, and an agent hook you install into Claude Code yourself that marks an agent waiting
for your approval. Everything the section reads is named field by field; nothing of a prompt, a
description or a result is read.

1.5.0 and 1.5.1 were committed but never published; their changes ship here.

### Added

* **Agents — the Claude Code sessions of the last seven days as a tree.** A new dashboard section,
  `agents`, directly below the quota cards and on by default, shows every session, the workflow
  runs inside it, the agents it spawned and the agents those spawned in turn, the most recent
  session first — at most 20 sessions, the rest counted under the tree. Each node has its state,
  its usage (the tables' definition, and a part of their totals rather than an addition to them)
  and its duration. The tree starts closed: only the sessions show until you open one, and what
  you open stays open across pushes, reloads and restarts. Claude Code only — Codex writes no agent
  identity, and the section says nothing about it.
* **Running now, first thing in the section.** A list names every agent and every launch that is
  running at this moment, the longest-running first — with a live `running for …` clock, its
  usage and where it sits — so none has to be looked for in the tree. At most 20 rows, the rest
  counted (`and 3 more`); a parent that runs only because its child does says `waits for a child
  agent`, and an agent that has written nothing for three minutes or more says so —
  `silent for 4 min`.
* **A tally on every session and run.** `427 started · 390 ✓ · 15 ✕ · 10 ↻ · ~11 ● · ~1 ?` —
  every agent below counted once, in exactly one part: done, failed, retried (every attempt a
  workflow journal started again), stopped, and the inferred running and unknown, marked `~`. A
  closed session already tells a run that went well from one that did not.
* **States that say what they rest on.** Done, failed and stopped are what somebody recorded: the
  parent's tool result or task notification, the workflow run's journal, the task notification of
  the `Workflow` call that launched a run, or Claude Code's own record of the run. Running and
  unknown — and a session's active and idle — are inferred from when a transcript last changed,
  and say so. A stop Claude Code records (`killed`, `cancelled`, `stopped`) is its own state, `■`,
  not a failure; an attempt the journal started again is dimmed and counted as retried; a run is
  decided by its members, so one failure among completed agents does not fail it. Every state
  opens its details with the sentence it was derived from, word for word.
* **Why an agent ended.** When the API rejected an agent's last request, its details say so with
  the limit or the error and the HTTP status — `rejected at 14:20 — 5-hour limit (HTTP 429)` — and
  a run and a session count their agents that ended so, by reason. The agents of a run that never
  wrote a reply that could be counted are one row, `263 agent(s) without a counted reply`, with
  `–` for its figures, rather than hundreds of empty ones.
* **Details under the row you clicked.** A click, or `Enter`, opens a node's details right under
  its row: a one-line summary, the token mix as a bar and in words, its rank in its run, the
  context at the end, what it used per minute, the effort its replies were written at, its ID with
  a *Copy ID* button (and the command *Token Pace: Copy Agent ID*), its tool errors, why the cache
  missed, its compactions, the Claude Code version and the permission mode, and Claude Code's own
  report of a synchronous agent — never added to a total. A run adds how many of its agents ran at
  once, how often it was resumed and the seven fields of Claude Code's run record; a session shows
  its own transcript's usage beside its agents' of the last seven days, never added, and its span
  in days and hours.
* **Large runs readable.** Every row is two lines — the name, then the figures — and a session or
  a run is named by when it started (`Workflow run Tue 00:19 · cfe7718d`). Children come in time
  order, the newest first; an opened node shows fifty of them at a time, with a line for the next
  fifty (`50 more · 377 not shown`), up to ten steps. Only what is open is sent to the page: a
  session with a run of 427 agents weighs 1.8 KB closed. Where a sidebar is narrow, the model gives
  way before the agent's type, and a run never loses the time it is named by. A usage that is a
  lower bound carries `⚠` on the row, its reason in the title — `⚠ lower bound — 2 of 41 replies
  unfinished`.
* **A tree to the keyboard and a screen reader.** One stop of the `Tab` key, the arrow keys,
  `Home`, `End`, `Enter`, `Space` and `Escape` as in any tree; every row named in words — its state
  as recorded or derived, its tally — and clocks that stand still for a screen reader. Targets of at
  least 24 × 24 px, and the system's colours in a forced-colours theme.
* **Where the agent tokens went.** The running list's `Last 7 days` button opens a block of the
  agent tokens of the seven days by type and model — how many agents, their usage, its share, the
  median per agent and, with costs on, an estimated `~Cost` — and the five largest agents, whose
  rows open their details.
* **The subagents' share of each Claude window.** Under each Claude window's bar a dim line says
  how much of what this machine counted over that window came from subagents —
  `Subagents 4.7M of 5.5M counted here (86 %)` —, a share of tokens and never of the quota; a model
  window counts only its models. The data-quality section sets the agent records against the
  subagent hour buckets of the same seven days.
* **Running agents in the status bar, opt-in.** `agents` in `tokenPace.statusBar.show` shows
  `~3 running` while agents run and nothing while none does — no colour, no alarm, no word when an
  agent finishes; its tooltip names five of them.
* **The agents in the Quick Pick, the exports and the chart.** The Quick Pick has an `Agents` group
  after the quota: the first five running agents and the sessions' tallies added up. The JSON
  export gains `agents[]` (`schema_version` 3) and the CSV export a third file, `….agents.csv`:
  ids, type, model, effort, state, counts and times of each agent, never a path; both save dialogs
  say so before anything is written. The chart's `subagents` chip splits every column into each
  provider's main sessions and its subagents.
* **The agent hook, opt-in.** *Token Pace: Set Up the Agent Hook…* copies a small script into the
  extension's storage and shows the snippet for `~/.claude/settings.json` — installed by you,
  removed by you; Token Pace never writes into `~/.claude`. With the hook installed, an agent
  waiting for your approval or input says so on its row: `waiting for approval`. It needs Node.js
  on the PATH, and in Claude Code's auto mode no permission dialog is shown, so no wait is
  reported. The keys it reads were checked against Claude Code 2.1.281.
* **The markdown report prints the agents too:** the running list, the 7-day block while it is
  open, and the tree with every node open — fifty children a node, at most 2000 nodes, a line for
  the rest — and the open node's details as a table.

### Changed

* **The default section order gains `agents` after `quota`.** A `tokenPace.dashboard.sections`
  you have set yourself is left exactly as it is, so there the section appears once you add
  `agents` to it. The range, provider and model chips do not apply to it — it is always the last
  seven days — so the filter bar stays below it.
* **Live while agents run, and cheap.** The Agents section is pushed at most every two seconds and
  its clocks tick in the page; an unchanged tree is not sent again. The agent directories of the
  active sessions are listed every five seconds while an agent runs or a session is active, so a
  new workflow run is found within seconds on every platform. A read that changed only the agents
  rebuilds only the Agents section and the status bar; while agents write, the other sections
  follow at most every five seconds, and the state is saved every ten seconds instead of five.
* **The snapshot is schema version 8** (`STATE_VERSION` 8), and the agent tables are at revision 8
  (`AGENT_TABLES_REVISION` 8). Versions 5, 6 and 7 are read forward, so the update forces no cold
  re-read: the first start after the upgrade replays the agent tables once from the Claude
  transcripts and workflow journals of the last seven days, each read only as far as its tokens
  were already counted — no token is counted twice and no total moves.
* **Clear Stored Data…** lists the agent hook's mirror, `agent-hook.jsonl`, among what it can
  delete; the hook's script stays while the hook is installed and goes with the extension's
  storage on uninstall.
* **German:** „Tool-Aufrufe" replaces „Werkzeugaufrufe", and the settings say „Token" as the
  interface does; the German setting descriptions no longer quote English interface texts.
* For contributors: the extension test probes the timers directly at shutdown, and the wait for
  the rebuilt tree after an upgrade is capped by the rebuild interval rather than a literal.

### Fixed

* **The token history no longer multiplies when the disk comes up under another number.** A
  file's identity was its device and inode number. The device number names the block device,
  not the file system, and a disk that enumerates as `sda3` on one boot and `sdb3` on the next
  gave every file a new one: every transcript was then read again from the start into the
  buckets that already held it, and the figures of the days before grew with every such boot. A
  file is now the same file as long as its inode is and it has not shrunk. The history that is
  already stored is not repaired by itself: if older days look too high, run **Re-read Token
  History** once.
* **The agents of a workflow run were filed one level off.** A transcript under
  `subagents/workflows/<run>/` was read as if the run's directory were the session: with
  attribution on, its record named `workflows` as its parent session — the `parent` of
  `sessions[]` in the JSON export — and, for a line without a working directory, `subagents` as
  its project. The placement now walks up to the nearest `subagents` directory. Records made
  before the update keep their old placement until *Re-read Token History*.
* **A duration no longer reads `19 min 60 s`.** It is rounded to the unit it prints and only then
  split — the models table's turn lengths and the sessions table included.
* **The Records card no longer overflows a 260 px sidebar.** The rule that keeps a provider's name
  in a quota card from breaking applied to every card row; it now applies to the quota cards only.
* **A live update no longer re-renders the whole page when a section that is not on it changes**,
  so scroll positions stay where they were.
* **A pressed chip looks pressed in a forced-colours theme** (Windows High Contrast): every pressed
  chip of the page — a range, a provider, a model, the custom dates, the cache switch, the cost
  line, the heatmap's metric, the hours' zone — wears the highlight colours.
* **Nothing acts after the window has closed.** A dialog answered after its window went away is
  recorded but acts on nothing; a quota fetch that returns after shutdown writes nothing; the
  cold-scan worker is stopped at shutdown; nothing is drawn or saved after it.
* In the Agents section as the unpublished 1.5 builds had it: a failed workflow agent no longer
  shows as running for ten minutes; a stop is no longer a failure and a replaced agent no longer an
  unknown `?`; a run is no longer failed by one failure among completed agents; the agents a run's
  journal started without a transcript are counted (a run of 427 no longer reads 164); an agent
  that writes on after its recorded end is running again; a session's own usage is no longer shown
  as if it were its agents'; the lower bound names its real cause — a reply cut off at a tool call,
  a third of the agents, not almost all — and sits on the rows; short ids no longer collide; the
  page no longer receives the whole tree (78 KB for one large run); a new workflow run is found in
  seconds, not a minute; "Parent's report" is *Report from Claude Code* and says which figure it is.

### Privacy

* **Every field the Agents section reads is named** in the documentation's privacy and agents
  pages, and `npm run check:privacy` holds every reader to a read contract: a reader that takes a
  field the contract does not list, or no longer takes one it lists, fails the build.
* Read: an agent's type, model, depth and ids from its identity sidecar; the start, the result and
  the step of each workflow journal line (the step's key is only compared, never kept); a launch's
  type, model alias and background flag; the result's agent or run id, status and Claude Code's
  three totals; a notification's id and status; an agent's effort, its last tool's name, its tool
  errors (counted on the raw line), its cache-miss reasons, the Claude Code version, the permission
  mode (matched on the raw line), its compactions; a rejected request's HTTP status, error kind and
  limit; seven top-level fields of a run record, picked from its bytes without decoding the rest.
  Never a prompt, a description, a summary, a result, a script, an error's text or a path.
* **The agent hook** reads four keys of a hook call and writes six fields per line into the
  extension's own storage; its bundle may load Node's `fs` and `path` and nothing else, which
  `npm run check:privacy` enforces. Nothing of it enters the snapshot, an export, the diagnostics
  or the log.
* **The exports carry the agents' ids, names and counts** — announced in both save dialogs — and
  never a path, a journal key, a rejected request, a last tool's name or a compaction. The
  diagnostics report carries none of the agent tables.
* **Leak tests.** For every field read, a test puts synthetic text under the keys beside it and
  checks that none of it reaches the outputs that field could reach — the snapshot, the
  dashboard's view, the markdown report, the exports, the log, the diagnostics report. Before the
  release a synthetic world with prompts, descriptions, results, summaries, scripts, error texts
  and account ids under every neighbouring key was run through as well, and reached none of the
  outputs.

## 1.4.0 — 2026-09-07

### Changed

* **The shade model style is legible at every band height.** Measured in a real browser at 4, 8
  and 16 px: the old lightness ramp, with its 1 px outline on the faint ranks, collapsed to a
  colour distance under 1 between neighbouring models at 8 px and ran backwards at 4 px, where
  the outline was half the band. The ramp is now six even steps chosen from those measurements
  (no neighbour closer than a distance of about 10, the faintest band still clearly off the
  page, both providers still apart), with no outline. The pattern and combined styles are
  unchanged.
* **A reached limit is red in the verdict chip too.** A window the provider reports as
  limit-reached wore the alarm colour on its bar but a dim chip whenever the pace happened to be
  fine; chip and bar now agree.
* **The tolerance band is a whole number** in the settings editor (`tokenPace.pace.tolerancePoints`
  offers 0–20 in steps of 1); the verdict rounds a hand-written decimal the way the card rounds
  its figure, so `2.5` is a band of 3.

### Fixed

* A payload without a worded reset line — one from an older build — reads a clock time as
  "resets at 14:20" and a countdown as "resets 3h20m" instead of forcing the countdown wording
  on both.
* **Why a sparkline can start over.** A sign-in with a different Claude account on 6 September
  showed that the quota history keeps one stream per account identity and never mixes two: the
  sparklines then show only the new account's readings. That rule is now pinned by a test at
  the manager level; the behaviour is unchanged and correct.

## 1.3.2 — 2026-09-07

### Security

* **The last four CodeQL findings are closed in code.** The dashboard's section renderer is
  chosen by comparing the section key with each literal instead of looking a function up by
  name; the page nonce is sixteen random bytes as hex, with no modulo that could bias it; and
  the transcript tail opens a file before it asks anything about it — identity, size and
  modification time all come from the handle it reads, so nothing can change between a check
  and the read it guards. An unchanged file now costs an open and a stat instead of a stat
  alone, a few milliseconds per sweep over a thousand finished transcripts.

### Changed

* The release workflow builds its GitHub release with `softprops/action-gh-release` v3
  (Node 24 runtime, same inputs); the dependency review uses v5 of its action.

## 1.3.1 — 2026-09-06

### Security

* **Every value from a payload is escaped before it becomes markup.** CodeQL flagged the
  dashboard's page build (`innerHTML` from a posted view model). An audit of every path found
  no exploitable field, but about twenty interpolations bypassed the escaper — numbers, level
  and class names, translated words, `data-*` attributes; all of them now go through it, the
  translated strings are escaped once where the page is built, and a section key or part key
  that is not one of ours is dropped instead of looked up on a prototype. The page's script
  constants are hardened against an early `</script>`, the CSP forbids `base-uri` and
  `form-action`, and the nonce comes from the platform's cryptographic generator.
* **The webview takes messages of its own origin only** — measured in a real VS Code window —
  and acknowledges every rendered page; the smoke test waits for that acknowledgement, so a
  rule that shut the host out could not ship.
* **The status-bar tooltip keeps borrowed strings in code spans.** Window labels, model names
  and a provider's error text are printed inside a code span with backticks removed, the way
  the plan name already was, so a hostile label cannot rewrite the tooltip's markdown.
* **Markdown cells escape the backslash before the pipe**, so a value like `a\|b` no longer
  splits a table column in the report or the export. The transcript tail reads up to the size
  of the file it opened, not the size it measured a moment earlier. The test files are no
  longer scanned by CodeQL: their fixtures stat-then-write and assert on literal URLs on
  purpose.

### Changed

* **The price table is checked as of 2026-09-06.** Both pricing pages were read again in full.
  New rows: GPT-6 Astra ($10 in, $1 cached, $50 out per million; fast mode at exactly twice
  that, so fast turns are priced rather than left unpriced), GPT-5.4 Pro, GPT-5.2 Pro and
  Claude Opus 4.5. Corrections: fast mode now belongs to Claude Opus 5 and Opus 4.8 at $10 / $50,
  Opus 4.6 runs fast requests at its standard rates and Opus 4.7 refuses them (the table used to
  give Opus 4.6 alone a six-times fast rate); Claude Mythos 5.1 shares the $0.25 cache-read rate
  of Fable 5.1. GPT-6 Astra's long-context surcharge above 272K input tokens is not applied —
  a bucket does not know a request's context size — so such turns are priced at the short-context
  rate, a lower bound as everywhere else in the cost column.

## 1.3.0 — 2026-09-06

### Added

* **Every quota card explains its colour.** Hovering a window on a quota card — or reaching it
  with the keyboard — opens the same kind of panel the key figures have: how much of the window
  is used and how much of its time has passed, the resulting distance from pace, the rule that
  painted the card ("Yellow as soon as the reading is ahead of pace; green at or behind"), and,
  where they apply, the measuring phase with its end time, exhaustion, a window without a reset
  clock, or a stale reading with its age. The markdown report prints the same line under each
  window and the Quick Pick shows it as the item detail.
* **The sparkline answers the mouse.** Moving over a quota sparkline marks the nearest reading
  and names it — day, time and percent, plus "reset" where a cycle ended; the sparkline can be
  focused and stepped through with the arrow keys, Escape hides the label. The label is built in
  the view model with the configured time zone and hour cycle.
* **Prompt-cache state on the Claude card.** When the status-line bridge is connected, the
  Claude card ends with the prompt cache's state: warm with its expiry countdown and TTL class,
  cold, or expired at the time of the last reading, with the hit ratio where the payload carries
  one. The same line appears in the markdown report, the Quick Pick and the status-bar tooltip.
  Without the bridge there is no line — nothing is estimated.
* **A smoke test in a real VS Code.** `npm run test:e2e` downloads VS Code into `.vscode-test/`,
  starts it with an isolated profile and an empty home, and checks that the extension activates,
  every contributed command is registered, the status-bar preview renders, a settings change
  reaches the status bar without a reload, and the dashboard command opens the dashboard. A
  separate workflow runs it on every push. `activate()` now returns a small API
  (`version`, `statusBar()`) for this test.
* **A reached limit is red and says so.** A window the provider reports as limit-reached is
  painted red on the dashboard as it already was in the status bar, and its explanation states
  the limit first instead of quoting a pace rule that did not decide the colour. A window whose
  stated reset has passed is no longer judged in colour at all: its chip loses the pace class
  and the "▲", matching its neutral bar and its "Why grey" explanation.
* **The privacy check reads the translations too.** `npm run check:privacy` now scans the
  German bundle, its parts and the manifest strings for http(s) literals, not only the three
  shipped bundles.
* **The CI names the failing tests.** When the test step fails, the job summary lists every
  `not ok` line with its diagnostic block, so a red run can be read without opening the log.
  Dependabot watches npm and the workflow actions weekly.

* **Token Pace speaks German.** When VS Code's display language is German, the dashboard, the
  status bar and its tooltip, the Quick Pick, the markdown report, the dialogs and the
  notifications are German too — 789 strings, with numbers and dates formatted for the
  language. English stays the source; the German lives in `l10n/` and ships in the package.
  Debug log lines, the diagnostics copy and CSV/JSON headers stay English on purpose, because
  they are pasted into issues.

### Changed

* **The store page is short again.** The README — which is the overview on the Marketplace and
  on Open VSX — now says what the extension is, shows the three pictures, lists what you see,
  how to install it and what it does with your data, and links to the documentation. Every
  chapter moved, word for word, to a page under `docs/`: where the numbers come from, the status
  bar, the dashboard, quota sources, cost, counting, history, budgets and alerts, sessions,
  export, troubleshooting, privacy, Windows and remote development, settings, commands and
  building. The pages ship in the package, so the links also work in the Extensions view; a new
  `docs/release.md` records the release recipe, the two store secrets and the publisher
  verification.
* **Under the hood: the dashboard script is a TypeScript module.** The webview's script used
  to be a template string inside the renderer, invisible to the type checker; it is now
  `src/webview/main.ts`, checked against the DOM types, built by esbuild and inlined at build
  time. The rendered page is unchanged.

* **Ahead of pace is yellow at once.** The tolerance band that kept a card green while it was up
  to five points ahead of pace is gone: `tokenPace.pace.tolerancePoints` now defaults to 0 and
  applies with every sensitivity, so a window that says "1 % ahead of pace" is yellow and one
  that says "0 % ahead" never is. The sensitivity presets keep only the minimum elapsed share
  before a verdict (relaxed 5 %, normal 3 %, strict 1 %); the measuring phase ends early once
  usage passes 10 %. With graded levels the amber step starts at 15 points ahead.
* **Absolute reset times read "resets at 15:30".** With `tokenPace.resetFormat` set to
  `absolute` or `both`, the countdown word gives way to "resets at" (German "Reset um"); the
  relative form stays "resets 3h44m" in English and becomes "Reset in 3h44m" in German.
* **The store tokens reach only the publish steps.** The release workflow no longer puts
  `VSCE_PAT` and `OVSX_PAT` into the environment of every step; `npm ci`, the tests and the
  packaging run without them.
* **The reset stroke is vertical.** Where a cycle ends, the neutral stroke drops straight down —
  at the announced reset time when it lies between two readings, otherwise at the first reading
  of the new cycle; the line holds the old value until then and continues from the new reading's
  value, never from an invented zero. A reading at which the value rose is an ordinary segment.

### Fixed

* **A Codex window that ends under five points now closes its cycle.** A pinned window whose
  reset time then rides along with the clock again was invisible to the reset rule when the fall
  was small; the rule now recognises a reset that passed between two readings, so the reset
  history, the thinning of repeats, the forecast split and the sparkline agree.
* **A fractional tolerance band** (`tokenPace.pace.tolerancePoints` 2.5, say) flipped the colour
  between two printed figures; the verdict now rounds the way the views print, so the colour
  changes exactly where the figure does.
* **The prompt-cache line names the age of its reading** and marks one older than
  `tokenPace.staleAfterMinutes`, in the card, the Quick Pick, the markdown report and the
  tooltip.
* **The model table's hit-rate sort** read a number back out of its own formatted cell; it
  sorts by the share the cell was formatted from, which also keeps it right in German.
* **A backtick in the plan name** no longer ends the code span in the status-bar tooltip:
  `tokenPace.planName` is read without backticks, control characters and line breaks.
* **Windows test runs.** The suite failed on Windows since 1.2.1 on two counts that the Linux and
  macOS runners could not show: fixtures checked out with CRLF line endings (a `.gitattributes`
  now pins LF) and a time formatter that printed a narrow no-break space before "AM" on some ICU
  builds (it prints an ordinary space everywhere now).

## 1.2.3 — 2026-09-05

### Changed

* **The store page shows 1.2.2.** The README pictures — and with them the Marketplace and Open
  VSX overview — are retaken from the current build: the dashboard picture shows the quota
  cards with their sparklines, the folded Tokens section, the filter block, the summary, the key
  figures and the chart by model with its cost line; a second picture shows the Tokens section
  with the running-window rows and the cache switch; the status-bar picture is retaken. The
  walkthrough's section table and its dashboard step name the sections of 1.2.2 — no Forecast
  section, no sustainable-rate line, the Tokens section and the gears where they are now.

## 1.2.2 — 2026-09-05

### Added

* **Every key figure explains itself.** Hovering a card in the *Key figures* row — or reaching
  it with the keyboard — opens a small panel that says what the figure counts, how it is
  computed, the period with its dates, what the delta is compared with (the previous period, or
  yesterday, with that value), the split between Claude Code and Codex, whether it is measured,
  derived or estimated, and what the sparkline spans. The words come from the view model, so the
  markdown report lists the same explanations under its table and the Quick Pick shows them as
  the item detail. The panel never widens the page: on the right half of the grid it hangs from
  the card's right edge.
* **Two window rows in the totals table.** `Current 5 h window` and `Current 7 d window` lead
  the fixed rows, per provider, and cover exactly the window the provider reports a reset for —
  so they can be read against the quota card above. Where no such window is reported the row is
  a trailing `Last 5 h` / `Last 7 d` span and says so. Both are summed from hour buckets: once
  the oldest hours of the span are rolled up into day totals, every figure in the row carries
  `≈`, and the span itself is the tooltip of the row label.
* **A cache switch over the composition bars.** `cache: shown | hidden` sits directly above the
  bars; hidden drops cache read and both cache writes from bar and legend, the remaining shares
  are shares of what is drawn, and a caption under the bar names the tokens left out — the bar
  never pretends the cache did not exist. Each slice's tooltip carries its tokens and its share.
  The choice is remembered with the rest of the panel state.
* **A gear in every section header.** It opens the settings editor filtered to the settings that
  section is made of — the quota gear to the quota sources, the poll interval and the pace
  settings, the models gear to the row cap and the price table, and so on; every list ends with
  the section list itself, so a section can be hidden from where it stands. Enter and Space on
  the gear do the same without folding the section.
* **`tokenPace.chart.modelStyle`** — how the daily chart tells the models of one provider
  apart: `pattern` (default: solid, stripes, cross-hatch, lines, dots), `shade` (lighter and
  darker steps of the provider's hue) or `both`. A change redraws the chart at once.

### Changed

* **The daily chart is always stacked by model, and the provider stays readable.** The
  *by provider / by model* selector is gone; every band wears its provider's hue — Claude blue,
  Codex purple — and the five largest models of each provider get a rank drawn as a pattern or a
  shade (see the new setting), with the rest folded into one `other` band per provider. The
  legend is grouped by provider and its swatches carry the same fill as the bands; a band's
  tooltip names the model, the provider, the value, its share of the column and the provider's
  total for that column. A stored *by provider* choice from 1.2.1 is dropped silently.
* **The cost line is legible and sits where the bars are.** Its points are at the column
  centres rather than the column edges, the 2 px line runs over a 4 px halo in the page
  background so it reads over any band, every data point is a dot, and the legend key is drawn
  the same way.
* **A young window that is already heavy is judged, not excused.** `measuring` — the state
  right after a reset in which no verdict is coloured — now needs both a young window
  (`pace.minElapsedPercent`) and a bill of at most twice the tolerance (10 points at `normal`).
  Sixty percent used two percent into the window shows yellow in the bar, the status bar and the
  sparkline alike, and can raise a pace alert; it used to show green.
* **The sparkline is one line, and only the turn of a window is neutral.** A stretch without
  readings is drawn straight across, from the last reading before it to the first one after,
  instead of a dashed bridge or a hole. The stroke into a reading the window turned over before
  — the reset time moved, or the value fell by five points without one, the rule the reset
  history already splits cycles by — wears the provider colour instead of a pace colour; every
  other stroke keeps the pace colour of its later reading, and a reading of 0 % is on pace with
  or without a clock. (1.2.1 coloured the fall at a reset in the pace colour of the new window.)
* **The Tokens section sits above the filter bar and follows no chip.** Its rows are fixed
  periods — the two running windows, today, the last 7 and 30 days, this week, this month, all
  time — of every provider and model; the *Selected range* and *previous period* rows are gone
  (the key figures, the chart and the models table carry the range), and the composition bars
  and the cache economy cover the last 30 days and say so. The default section order is now
  `quota, tokens, summary, kpis, …`; a stored order is kept as it is, and a `tokens` entry listed
  after a filtered section stays below the bar.
* **The filter bar is one labelled block.** A row each for *Range*, *Providers* and *Models*
  with the chips aligned in a column; `today`, `7d`, `30d` and `custom…` are visible and the
  rest fold behind `more ▾`; the range caption sits at the end of the Range row; the models fold
  behind `models (N) ▾` once there are more than four; refresh is an icon button at the right.
* **Sections are set apart.** Every section is separated from the one above by a rule and a
  fixed gap, folded or not, so a collapsed Summary no longer glues to the filter bar; the two
  quota cards are divided by a hairline as well.

### Removed

* **The Forecast section.** Its cards repeated the forecast line every quota card already
  carries, and its *Local usage in window* and per-project attribution tables answered a
  question nobody had asked. The forecast itself is unchanged: the sentence stays on the quota
  card and in the tooltip, the status-bar forecast entry and the forecast alert stay. A
  `dashboard.sections` list that still names `forecast` is accepted and the entry ignored.

### Fixed

* **Every reading looked like a reset.** Claude Code's usage cache reports a window's reset time
  with sub-second jitter from one read to the next, and an idle Codex window's reset time rides
  along with the clock. The exact comparison took each of them for a new window: the reset
  history split into one-sample cycles, no reading was ever thinned as a repeat, and the
  sparkline — once its reset strokes were neutral — was neutral from end to end. Reset times
  are now compared with a half-minute tolerance, a clock that only moved by the time between two
  readings is not a reset, and the one rule (`resetRule.ts`) serves the reset history, the
  thinning anchors, the forecast and the sparkline alike.
* The `dashboard.sections` enum descriptions in the manifest were listed in a different order
  than the values — the settings editor described `quota` as the summary and vice versa. A test
  now checks every enum in the manifest against its descriptions.

## 1.2.1 — 2026-09-04

### Added

* **The daily chart stacks by model.** A second selector beside the metric — *by provider* /
  *by model* — splits every column into the five largest models of the range, each in its own
  colour across all columns, and folds the rest into one `other` band; the column total is the
  same either way, because a stack is a partition of the same figure. The legend names the
  models verbatim, a click on a column still opens that day, and the choice is remembered with
  the rest of the panel state. The plot is twice as tall (240 px) for both stacks.
* **The models table shows what the totals table shows.** Usage, fresh input, cache write 5 m
  and 1 h, cache read, output, reasoning, requests, hit rate, per request, API cost and share —
  the same helpers, the same `–` for an absent figure, and a single-model table adds up to the
  totals row column by column. Every column sorts on its raw count rather than on the rounded
  label. The markdown view carries the same figures, plus the provider and cost-share columns it
  has the room for.
* **Seven-day sparklines, coloured by pace.** The line under each quota window now spans a
  fixed seven days on a time-proportional axis of 15-minute slots: a night without VS Code is
  as wide as a night, not one notch. Each stretch is drawn in the colour the bar showed at the
  time (green, yellow, orange, red), a hole with no reset inside is bridged by a dashed grey
  line — *unmeasured*, not a claim — and a hole that contains a reset stays a hole. The quota
  history is thinned as it is written so this stays bounded: one sample per window and quarter
  hour inside the last seven days, one per hour beyond, with the samples around every reset, the
  first and the peak of every cycle and a third reading of a short one always kept, so the reset
  history reads the same before and after thinning; seven windows come to about 4 700 samples a
  week and stay under the 20 000 cap even at 90 days of retention.

### Changed

* **The quota card lost a line per window and gained its verdict up top.** The pace verdict
  (`▲ 9 % ahead of pace`) sits in the header row between the window label and the percentage,
  wrapping on a narrow sidebar instead of clipping. The bar paints the pace gap: ahead of time,
  the fill beyond the elapsed marker is darker; behind time, the track between the fill and the
  marker is a stronger grey than the rest of the track — the marker itself is unchanged. Gone
  from every view: the sustainable-rate line (`~17.9 %/h keeps it to the reset`) and the
  `measuring · …` hints; a window too young to
  judge simply shows no verdict — in the card, the Summary and the clipboard export alike — and
  a forecast still measuring prints the bare state word `measuring` in the Forecast section and
  nothing on the card. Gone from the dashboard card only: the `official page` link and the
  freshness row — the markdown view keeps both (the official page as a line of its own now),
  and the tooltip keeps the reading's age and the official page as the link on the provider
  name, as before.
* **The weekday × four-hour grid draws whatever days it has.** It used to hatch every cell
  below three distinct days, which on a 7-day range is every cell, and said nothing about it.
  A cell is now filled from the days that touched it and hatched only where no usage day did;
  the caption states the basis — `based on 1 week — a record, not a habit` below three weeks,
  the plain `based on N weeks` from there on (a 30-day range worked on every day says `5 weeks`,
  rounded up from 30 days) — counting weeks from the days with usage, not from the length of the
  range. A legend line explains the hatch.
* **The `Price` column is gone** from the models table and the markdown table. Where a rate
  came from now lives on the cost it qualifies: the tooltip of the API-cost cell, a `⚠` when a
  related model's rates stood in, and the footnote as before.
* **The quota cards lead the dashboard.** The default section order is now `quota, summary,
  kpis, …`: the bars for Claude Code and Codex come first, everything statistical follows.
  The range, provider and model chips filter the statistics and not the quota cards, so the
  filter bar moved down with them — it sits below the `quota` and `context` cards that lead
  the list and above the first section it applies to. A first-run or preview notice still
  stands above everything, because it qualifies every figure on the page. The Quick Pick and
  the markdown view follow the same order. A configured `tokenPace.dashboard.sections` is
  left exactly as it is.

### Fixed

* **The cost line drew across the sections below the chart.** The overlay is an inline SVG
  with only a viewBox; without an explicit size a replaced element takes the plot's width and
  derives its height from the 1:1 ratio, so it was as tall as the plot was wide and the line was
  stretched over the models table and the heatmap. It now has the plot's exact size.
* **The chart's dropdowns were unreadable** — light option text on the light native popup.
  Selects and their options take the theme's dropdown colours, and the page declares the colour
  scheme of the theme so the popup is painted dark in a dark theme.
* **Quota-history retention never held on disk.** Saving merged the file back into memory and
  resurrected every sample the prune had just dropped. A save after a prune now applies the same
  retention, thinning and cap to the merged result.

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

* **Settings changes apply without a reload again.** The check that asks whether a change
  touched any `tokenPace` setting had spelt the section `tokenPace.tokenPace`, which nothing
  ever matches, so since 1.0 every edit — status bar entries, dashboard sections, plan name,
  budgets, alert thresholds, quota source — quietly waited for the next window reload. The
  bare namespace is now passed through as the workbench expects, and an activation test edits
  a setting and watches the status bar follow.
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
