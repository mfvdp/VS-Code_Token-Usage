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
of its checks holds, twice: when the countdown would start, and when it ends. The log names the
check that held it back — `keep-warm: not sent (notIdle)` when a countdown ended without its line,
and, with `tokenPace.debug` on, `keep-warm: session 9d0eb37a not armed (typedSince)` when none
started —, in these words:

* **`off`, `consent`, `restricted`** — `tokenPace.cacheKeepWarm` is off; its consent was refused or
  never given (a refusal is not asked about again until you switch the setting off and on); or the
  workspace is in Restricted Mode.
* **`reading`** (1.10) — Token Pace was reading the transcripts: the first scan after the window
  opened (the status bar says *Reading token history …*), a re-read, or the one-time replay for the
  Agents tables after an update. The records the other checks read are rebuilt then, so no countdown
  starts and none ends with its line until the reading is done; nothing to do but wait for it.
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
* **`otherSession`** — a terminal is known by its folder, not by its session, and this one may run
  another session of the folder: the session began before the terminal's `claude` started (it was
  resumed there, with `claude --resume`), or another session of the folder began after it — either way
  the session gets no line —; or another session of the folder is not idle: its newest reply is less
  than a minute old, stopped for a tool or was cut off, a line of yours came after it (a question or a
  permission dialog may be open there), or an agent of it runs. The last holds until that session has
  finished its turn, or until it has been left behind: no agent of it running, and its newest line at
  least 2 hours old and older than the moment this terminal's `claude` started — a prompt that never
  got its reply, an interrupted reply, a window closed mid-turn. In 1.8 such a session held the line
  back for as long as its transcript was kept, seven days. A session this terminal's own `claude`
  wrote to — a turn you interrupted there before `/clear` or before starting another session in it —
  is never left behind: it holds the line back until it has finished its turn or that terminal's
  `claude` is started again.

## A prompt was not sent

A double-click in the dashboard's [Prompts](prompts.md) section types a prompt only after its checks
([When Token Pace does not send, or asks first](prompts.md#when-token-pace-does-not-send-or-asks-first)).
A check that never lets it go shows a message, *Token Pace: the prompt was not sent. …*, and the section
says *Not sent: …*; one that asks first shows *Send “…” anyway?* The log names the check —
`Prompts: not sent (hookWait)` —, in these words:

* **`restricted`** — the workspace is in Restricted Mode, where Token Pace types nothing into a terminal.
  Trust the workspace (*Manage Workspace Trust*); the list itself can be edited either way.
* **`reading`** — Token Pace is reading the transcripts: the first scan after the window opened (the
  status bar says *Reading token history …*), a re-read, or the one-time replay for the Agents tables
  after an update. Send again once it is done.
* **`noTerminal`** — no terminal of this window runs Claude Code or Codex as VS Code's shell integration
  reports it, or the terminal closed before the prompt went. Start `claude` (or `codex`) in a VS Code
  terminal with shell integration. Claude Code in the Claude Code extension's own panel cannot be
  reached, nor can a terminal of another window or one without shell integration.
* **`codex`** — asks first, every time: Token Pace reads nothing of a Codex session, so it cannot tell
  whether Codex waits for an approval. Look at the terminal; *Send anyway* when Codex is idle.
* **`unknownFolder`** — asks first: VS Code reports no folder for that terminal, so no session can be tied
  to it. *Send anyway* after a look at the terminal, or start Claude Code again in a terminal with shell
  integration.
* **`hookWait`** — the [agent hook](agents.md#the-agent-hook) reports a permission request open in a
  session of that folder: the text and Enter would answer it. Answer it in Claude Code, then send again.
* **`unknownStart`** — asks first: Token Pace did not see Claude Code start in that terminal — it was
  started before the window was reloaded, or before the Prompts section was added. Restart Claude Code in
  that terminal for the full check, or *Send anyway* after a look at it.
* **`noSession`** — Claude Code in that terminal has not written a line since it started: it may still
  show a dialog of its own — whether to trust the folder (Enter would pick the highlighted *No, exit*),
  signing in, the list of `--resume` —, and a prompt would answer it and be lost. Type the first message
  in the terminal yourself; once Claude Code has answered it, the section can send.
* **`openTool`, `notIdle`** — ask first: Claude Code is at work there, or waits for your answer in a
  permission dialog or a question — its transcript cannot tell which —, or its last reply was cut off or
  paused. Look at the terminal: answer a dialog first; while it works, *Send anyway* hands the prompt to
  Claude Code, which takes what is typed during a turn after it.
* **`agentRunning`** — asks first: an agent of that session is running, and its end can wake the
  conversation. *Send anyway*, or wait for the agent.
* **`otherSession`** — asks first: another session of the same folder is at work or waits for an answer —
  a terminal is known by its folder, not by its session, so the prompt could reach that one. It stops
  asking once that session has finished its turn, or has been left behind: no agent of it running, and
  its newest line at least 2 hours old and older than the moment this terminal's `claude` started.

When nothing happened at all: a send while another is under way — its terminal pick or its question open,
or less than a second after the last one — is dropped, and the log says `Prompts: a send was dropped
(another one is under way)`; a page drawn before `prompts` was taken out of `tokenPace.dashboard.sections`
changes nothing, and the log says `Prompts: an operation was dropped (the section is not listed)`. When
the text stayed in Claude Code's input line without being sent, press Enter there: Token Pace types the
Enter 200 milliseconds after the text, and not at all when the window closed in between. *Not sent: The
terminal did not take the text.* means VS Code refused the text — the terminal had gone; the log names the
error's kind.

## The language

The language of Token Pace's own texts is the setting `tokenPace.language`, which the flag at the top
of the dashboard sets (see [Languages](languages.md)). When it does not do what you expect:

* **The dashboard is in another language than VS Code.** The setting names a language — you chose one
  with the flag, or set it in the settings. Choose *Automatic* at the top of the flag's list, or set
  `tokenPace.language` back to `auto`, and the texts follow VS Code's display language again.
* **`auto` shows English, though another display language is set.** VS Code reports its display
  language only while that language's pack is installed; without the pack it reports English, and the
  flag's list then says *Automatic — as VS Code (English)*. And a language Token Pace has no
  translation for is English under `auto` too — the list's first line says so: *Automatic — VS Code's
  language (hu) has no translation here, so English*. Choosing a language in the list needs no
  language pack.
* **The settings and the command titles did not switch.** They cannot: VS Code reads them from the
  extension's `package.nls.<language>.json` when it starts, for its own display language, and gives
  an extension no way to have them read again. *Configure Display Language* — which restarts VS Code —
  changes them. The walkthrough's titles follow VS Code the same way; its three step pages are English
  in every language.
* **One text stayed in the old language.** A Quick Pick, a dialog or a notification that was open at
  the switch keeps its language until it closes. The words of Token Pace's last failed quota fetch
  stay in the language they were written in until the next attempt. The debug log, the diagnostics
  report and the CSV and JSON exports are English in every language, on purpose.
* **A choice did nothing, and a warning said** *Token Pace: the language could not be written to your
  user settings.* VS Code could not write your user `settings.json` — a file that is read-only, say,
  or one with an error in it. The log names the kind of error; the page stays in the language it had.
* **The setting names a language, but the texts are not in it.** The value is not one of the ids of
  [the table](languages.md#the-twenty-six-languages) — another case (`FR`), a path, a typo — and counts
  as `auto`; or the installed build carries no translation file for it, or the file could not be
  read, and the texts are English. The log says which.

## A question answered after the window closed

A dialog — the offer to fetch quota on the first start, the consent to write the shared quota
cache — stays open until you click, even when the window that asked is closed or reloaded in the
meantime. An answer given then is kept, but that window acts on nothing any more: after **Allow**
on the first-start offer, `tokenPace.quotaSource` stays on `auto`, so set it to `poll` yourself in
the settings to have the quota fetched.
