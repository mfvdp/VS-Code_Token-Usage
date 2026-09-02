# Changelog

All notable changes to **Token Pace** are recorded here.
This project follows [Semantic Versioning](https://semver.org/).

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
