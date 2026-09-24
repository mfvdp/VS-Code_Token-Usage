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
| `$(clock) CC retry 12m` | `retry` | The last attempt failed; the countdown is the scheduled next one. Once it has passed the bar says `$(clock) CC retry due`; in a window that has been in the background for more than ten minutes, `$(clock) CC retry waiting for focus` — the attempt runs when the window is focused again | **Fetch quota now** to retry immediately. The log holds the reason |
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

## An old figure and a failed fetch

With `quotaSource: poll`, a fetch of Token Pace's own can fail while an older reading is still on
screen — most often a `429`, after which the fetch backs off for about 10 minutes, doubling with
every further failure up to 2 hours (a `Retry-After` header wins). The old figure stays, because a
slightly older value beats an empty display, and a transient failure of our own fetch — a `429` or a
server error, a network error, an unclassified one — is said beside it in one sentence:

> Last attempt at 14:20 failed: HTTP 429 — backing off before the next attempt · next attempt in 1h12m

It stands directly under the header of the dashboard's quota card, in the entry's tooltip after the
freshness line, under the provider's heading in the markdown view and in *Copy Usage Summary*, and
as the detail line under the provider's item in the Quick Pick. Once the reading is older than `staleAfterMinutes`, the
status-bar entry adds the next attempt after its age:
`CC 5h ██┃▁▁▁▁▁ 25% · resets 2h14m $(history) 2h · $(clock) retry 1h12m` — in the grey of a stale
reading, never as an alarm. `retry due` means the attempt is due now; `retry waiting for focus`
means this window has been in the background for more than ten minutes, and with
`tokenPace.pollOnlyWhenFocused` on the attempt waits until it is focused — said only of an attempt
that would be made: while a fresh reading from the status line or a cache file answers the fetch,
nothing is due and nothing waits. **Token Pace: Fetch Quota Now** tries again at once. The sentence
disappears with the next successful fetch, or when another source delivers a reading newer than the
failure. The reason is the fetch's own wording — a fixed phrase with at most an HTTP status —, never
the text of an exception, and it survives a restart during the backoff (see
[quota-sources.md](quota-sources.md#what-the-fetch-does)). A permanent cause — no or rejected
credentials, a `403`, no `codex` executable — is not said beside a reading: the figure stands as it
would without it, and the cause is the entry's own state (the table above) once no reading is left.
*Copy Diagnostics* names the kind and the time of the last failed attempt, whichever it was.

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

## The agent hook

The [agent hook](agents.md#the-agent-hook) is optional, and nothing in the status bar depends on
it. When it does not do what you expect:

* **No `waiting for approval` ever appears.** The marker needs Claude Code to raise a permission
  dialog; in Claude Code's auto mode no permission dialog is shown, so no wait is reported, and
  neither in `bypassPermissions`. The hook also needs **Node.js on the PATH** Claude Code runs its
  hooks with: the command starts with `node`, and without it the hook fails on every event and
  `agent-hook.jsonl` is never written. A line older than 30 minutes no longer counts either.
* **The marker stays after you answered.** A wait is seen answered when the agent writes its next
  line or stops; a long tool call you approved keeps the marker until then.
* **Set Up the Agent Hook… shows a warning instead of the document.** The script could not be
  copied into the extension's storage, and no snippet is shown that would point at a missing file;
  the warning names the kind of error.
* **Claude Code reports a failing hook command after Token Pace was uninstalled.** Uninstalling
  removes the extension's storage and the script with it, but the entries you added to `hooks` in
  `~/.claude/settings.json` stay until you delete them — Token Pace never edits that file. Delete the
  four entries (`SubagentStart`, `SubagentStop`, `Notification`, `PermissionRequest`) and the error
  is gone.

## No keep-warm line was sent

The opt-in [keep-warm line](prompt-cache.md#keep-warm-in-a-terminal-opt-in) goes only when every one
of its checks holds, twice: when the countdown would start, and when it ends. With `tokenPace.debug`
on, the log names the check that held it back — `keep-warm: session 9d0eb37a not armed (typedSince)`
before a countdown, `keep-warm: not sent (notIdle)` at its end —, in these words:

* **`off`, `consent`, `restricted`** — `tokenPace.cacheKeepWarm` is off; its consent was refused or
  never given (a refusal is not asked about again until you switch the setting off and on); or the
  workspace is in Restricted Mode.
* **`noBridge`** — no status-line reading describes the session's newest request: the
  [bridge](quota-sources.md#claude-status-line-bridge-opt-in) is not connected, ran for another
  session last, or has not run since the session's newest reply. The transcript's estimate (`~`)
  never starts a countdown.
* **`notDue`, `tooLate`** — more than three minutes of warmth are left; or too little: the line has
  to start more than a minute before the expiry, so a window that slept past the moment sends
  nothing late, and a countdown that could not end in time does not start.
* **`notIdle`, `openTool`** — the session's newest reply is less than a minute old, was cut off or
  paused; or it called a tool, or the newest line is yours — Claude Code is still at the reply, or
  a permission dialog or a question may be open.
* **`agentRunning`** — an agent of the session is running.
* **`hookWait`** — the [agent hook](agents.md#the-agent-hook) reported a permission request after
  the session's newest reply.
* **`noTerminal`, `ambiguousTerminal`** — no terminal of this window runs `claude` in the session's
  folder as VS Code's shell integration reports it — the Claude card then says *Keep-warm cannot reach
  this session: it does not run in a VS Code terminal of this window.* —, or two do. A session in the
  Claude Code extension's own panel is never reached; neither is a terminal without shell
  integration, nor one where Claude Code was started before the window began to watch (start it again
  after switching the setting on). A terminal VS Code reports another program in than `claude` does
  not count either.
* **`typedSince`, `unknownFocus`** — the Claude terminal was the active terminal of the focused
  window since the session's newest reply: you may have typed a draft, which the line would send
  along. Or this window began watching after that reply and cannot tell. Either holds until the
  session's next reply; leave the window, or switch to another terminal, while Claude works.
* **`cap`** — three lines went in this idle phase; your next request starts a new one.
* **`quota`** — a Claude quota window stands at 90 % or more, or is reached.
* **`unanswered`** — the last line got no answer within two minutes; the Claude card says
  *Keep-warm stopped for this session: the last line got no answer within two minutes.* Your next
  request starts a new idle phase.
* **`cancelled`** — you cancelled a countdown in this idle phase.

## A question answered after the window closed

A dialog — the offer to fetch quota on the first start, the consent to write the shared quota
cache — stays open until you click, even when the window that asked is closed or reloaded in the
meantime. An answer given then is kept, but that window acts on nothing any more: after **Allow**
on the first-start offer, `tokenPace.quotaSource` stays on `auto`, so set it to `poll` yourself in
the settings to have the quota fetched.
