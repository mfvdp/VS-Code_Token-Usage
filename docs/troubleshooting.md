<!--
SPDX-FileCopyrightText: 2026 Frederik Marx
SPDX-License-Identifier: AGPL-3.0-or-later
-->

# If the bar says …

Part of the [Token Pace documentation](../README.md#documentation).

A problem state replaces the figure with a **named cause**. It is never a silent dash where a
number should be, and the click on the entry performs the repair for that cause instead of the
configured `clickAction`. The same action appears in the tooltip footer and on the dashboard's
problem card; `src/viewModel.ts` holds the mapping, and `test/docs.test.ts` compares it with
this table.

| The bar says | Kind | What happened | The click runs |
|---|---|---|---|
| `$(key) CC no token` | `noToken` | No credentials were found, so nothing could be fetched | **Show log** — it names the lookup that failed, never the token. Sign in to the CLI, or set `CLAUDE_CODE_OAUTH_TOKEN` |
| `$(warning) CC token expired` | `tokenExpired` | The stored credentials are past their expiry. Token Pace never refreshes a token | **Show log**. Sign in again in the CLI; the next poll picks the new token up |
| `$(shield) CC consent` | `consentPending` | Network access has not been granted yet, so no request was made | **Fetch quota now**, which asks first. One dialog, one answer, remembered |
| `$(circle-slash) CC quota off` | `modeCache` | `quotaSource: cache`: local files only, the network is never used | **Open settings**. Point `claudeQuotaFile` / `codexQuotaFile` at a cache file, or switch back to `auto` |
| `$(clock) CC retry 12m` | `retry` | The last attempt failed; the countdown is the scheduled next one | **Fetch quota now** to retry immediately. The log holds the reason |
| `$(cloud-offline) CC offline` | `offline` | The request did not reach the provider — timeout, DNS or proxy | **Fetch quota now**. Check connectivity and `http.proxy`; *Copy Diagnostics* lists the proxy settings in effect |
| `$(lock) CC 403` | `forbidden` | The provider refused the usage endpoint. Often a Team or Enterprise account without one | **Show log**. Token counts keep working, and the menu still offers the official usage page |
| `$(key) CC sign in` | `unauthorized` | The provider rejected the credentials (HTTP 401) | **Show log**. Sign in again in the CLI |
| `$(circle-slash) CDX no codex` | `noBinary` | The Codex CLI was not found on `PATH`, so its app-server could not be asked | **Open settings**. Set `tokenPace.codexBinary`, or install the CLI |
| `$(circle-slash) CC quota off` | `quotaOff` | No quota source is enabled for this provider | **Open settings**. `claudeQuotaSources` / `codexQuotaSources` |
| `CC –` | `noFile` | The configured quota cache file does not exist | **Re-read history**, which also picks up a file that has appeared since. Otherwise check `claudeQuotaFile` / `codexQuotaFile`, or enable another source |
| `CC –` | `empty` | The source answered, but carried no window this build can read | **Re-read history**. Unknown window kinds are reported in the log and the data-quality section, not dropped |
| `$(clock) CC paused` | `paused` | The **external** writer of the cache file is in backoff: its `blocked_until` is still in the future | **Fetch quota now**. Nothing here is broken; the figure returns when that writer resumes. In `quotaSource: cache` a fetch of our own is refused, and the link says so instead of pretending |
| `CC –` | `follower` | Another VS Code window holds the lease and does the polling; this one displays what that window wrote | **Open dashboard**. Nothing to do — `leaderElection: false` makes every window poll on its own |
| `CC –` | `unknown` | No reading, and no cause that can be named | **Show log**; it holds the raw reason |

Two states that look like problems and are not: `CC 5h ▁▁▁▁▁▁▁▁ reset due` means the reset has
passed and no reading newer than it has arrived — the gauge is never zeroed by us, a re-poll is
scheduled instead — and `CC 7d ∞` means the window has no limit, so there is no denominator to
divide by and no pace to compute. The full matrix is in
[status-bar-states.md](status-bar-states.md).

**When a provider reports no window at all**, the dashboard card, the Quick Pick and the
markdown document each carry one extra line, the same line word for word:

> Local estimate — 412k tokens in the last 5 h, first counted at 09:00. Not the provider’s
> window; no limit is known.

That is the number of tokens this machine ingested over the last five hours, and nothing more.
No percentage, no bar, no pace, no forecast and no alert: there is no limit to divide by, and a
share of an invented denominator would be our number wearing the provider’s clothes. It carries
`≈` when part of those five hours is older than the hour buckets still kept. The moment a real
window arrives the line is gone, and the status bar is unchanged either way — a problem state
stays a problem state.
