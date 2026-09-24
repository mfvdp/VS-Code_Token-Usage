<!--
SPDX-FileCopyrightText: 2026 Frederik Marx
SPDX-License-Identifier: AGPL-3.0-or-later
-->

# Quota sources

Part of the [Token Pace documentation](../README.md#documentation).

`tokenPace.quotaSource` decides whether a fetch of our own may happen at all. It behaves the
same on every platform:

| Value | Behaviour |
|---|---|
| `auto` (default) | Local sources only, **no network access of its own**. If none of them has data, it offers **once** to switch to `poll` |
| `poll` | Fetches directly — but only after you have agreed in the dialog below |
| `cache` | Local sources only, never fetches and never asks |

Within that, `tokenPace.claudeQuotaSources` and `tokenPace.codexQuotaSources` list which
sources may be consulted:

| Provider | Sources, in the default order |
|---|---|
| Claude | `cacheFile` → `statusline` → `claudeJson` → `poll` |
| Codex | `cacheFile` → `transcript` → `poll` |

**The freshest source that has data wins.** The configured order only breaks a tie, so a stale
preferred source never hides a current one. Fields are **never merged** across sources: two
readings can belong to two accounts, and a spliced state would be a figure that never existed
anywhere. The data-quality section lists every candidate with its age or its reason for failing
— an absent source is a stated absence, not a gap.

## The cache file

The reading travels, not the credential: whoever holds the access token makes the request, and
everyone else reads the answer from disk. One process asks the provider, any number of widgets
display it, and no secret leaves the process that owns it. During development the writers were
a pair of XFCE panel plugins; a cron job or a shell script does just as well.

The format is a small JSON envelope with the provider's verbatim response inside it, and it is
documented as a contract in [quota-cache-format.md](quota-cache-format.md) —
`schema_version`, `fetched_at` in Unix seconds, `fail_count`, `blocked_until`, `writer`, `body`,
`providers_error`. An absent or unparsable file is *absence*, not zero: Token Pace shows `–`
with the fail count, never `0 %`. A `blocked_until` in the future is reported as a paused state
(`$(clock) CC paused`, with the writer's own *poller paused until …* on the tooltip's *Reported*
line) rather than dressing the old number up as current.

## Consent for our own fetch

Fetching uses Claude Code's access token, so it never starts unasked. The first time it would
happen, a modal dialog names, in concrete terms:

* the interval you have actually configured (not a hard-coded “every 30 minutes”),
* `GET https://api.anthropic.com/api/oauth/usage` and the `accessToken` in
  `~/.claude/.credentials.json`,
* that the request identifies itself as the Claude Code client, and why,
* that for Codex the local `codex app-server` is started and nothing of ours leaves the machine,
* that the endpoint is undocumented, carries no stability promise, and may change or disappear
  — after which Token Pace shows no quota figures rather than guessing any,
* that the token is only read, never refreshed, never logged, never in an error message or in
  the diagnostics, and never sent anywhere else.

Only **Allow** enables it; **Never** is remembered; closing the dialog leaves the question open.
The answer is stored per machine and is never synced. **Token Pace: Reset Network Access
Decision** puts the question back.

## What the fetch does

* **Claude** — `GET https://api.anthropic.com/api/oauth/usage`, header
  `anthropic-beta: oauth-2025-04-20`, 20-second timeout. The URL is hard-coded and not
  configurable.
* **Codex** — `codex app-server --stdio` is started and asked for `account/rateLimits/read` over
  JSON-RPC. The executable is looked up via `tokenPace.codexBinary`, then `CODEX_CLI_PATH`, then
  `PATH`, and finally inside the binary bundled with the official IDE extension.

**User agent.** `tokenPace.userAgent: claudeCode` (default) sends the same string Claude Code
itself sends, `claude-code/<version>`. The version comes from three sources, in this order:

1. what `claude --version` prints, asked once per session;
2. where that gives none — on Windows with only the npm `claude.cmd` on the `PATH` — the version
   the newest Claude Code session on this machine wrote into its transcript (`version`, three
   numbers, of the main session with the latest reply; an agent's transcript is not asked). It is
   asked again at every fetch, because the first fetch can come before the transcripts are read;
3. where neither is known, a fixed version.

On Windows, `claude --version` is started only from a `claude.exe` found in a directory of the
`PATH`: each absolute directory among its first 64 entries is checked for that one file's
existence — nothing is read from it — and the file is started by its full path, without a shell.
The npm shim `claude.cmd`, a `.bat` and a `.ps1` are never started, and neither the current
directory nor a relative `PATH` entry is searched. The log names the source once, and again only
when it changes: `claude: user agent version 2.1.281 (from claude --version)`,
`(from the newest transcript)` or `(fallback)`. Nothing else of any transcript reaches the
request.

`honest` sends `token-pace/<version>` instead, and none of the above. **Warning:** the honest
agent lands in an aggressively rate-limited bucket and can expect `429 Too Many Requests` within a
few fetches, after which Token Pace backs off for up to two hours and no new figure arrives: the
older reading stays, and beside it the card, the tooltip and — once it is stale — the entry say that
the last attempt failed and when the next one is (below). The endpoint is undocumented; this is an
observation from the field, not a documented rule.

**Credentials.** In order: `CLAUDE_CODE_OAUTH_TOKEN`, then
`~/.claude/.credentials.json` (`CLAUDE_SECURESTORAGE_CONFIG_DIR` and `CLAUDE_CONFIG_DIR` are
honoured), then — with `tokenPace.credentials.keychain` on, which it is by default — the OS
keychain: `security find-generic-password` on macOS, `secret-tool lookup` on Linux. An expired
token found early does not end the search; only when every source is exhausted is the expiry
reported. The credentials file is watched, so a re-login is noticed within seconds instead of at
the next interval — by size and mtime, because the content is a secret and is not even hashed.
The token is read, used once and dropped. It is **never refreshed**: rotating it from here would
invalidate Claude Code's own session, so when it has expired the extension says so and waits for
Claude Code to renew it during normal use.

> The keychain paths are best effort and are documented as such: the macOS item name
> (`Claude Code-credentials`, with a hash of `CLAUDE_CONFIG_DIR` appended when that variable is
> set) and the Linux `secret-tool` lookup have not been independently verified against every
> Claude Code build. A missing helper is not treated as an error.

**Errors** never quote the exception. They are classified into named states — `timeout`,
`TLS error — possibly a proxy intercepting TLS`, `network error`, `proxy requires
authentication (HTTP 407)`, `401` (sign in again), `403` (may mean a Team or Enterprise account
without a usage endpoint; token counts keep working), `429`/`5xx` (back off) — and each state
names its own repair step in the status bar and the tooltip. Backoff grows with jitter: from
10 min up to 2 h on rate limits and server errors (a `Retry-After` header wins), from 1 min up
to 30 min on network errors. A permanent cause — missing credentials, no `codex` executable — is
not retried every minute. **Token Pace: Fetch Quota Now** forces an immediate attempt.

A failed attempt does not wipe the reading in hand: the older figure stays, and a transient failure
of our own fetch is said beside it — `Last attempt at 14:20 failed: HTTP 429 — backing off before the
next attempt · next attempt in 1h12m` under the dashboard card's header, in the tooltip, the markdown
view, the Quick Pick and *Copy Usage Summary*, and as ` · $(clock) retry 1h12m` after the age of a
stale status-bar entry. Transient means the cause passes by itself and another attempt is scheduled
after a backoff: a `429` or a server error, a network error (timeout, DNS, TLS, proxy), an unclassified
status or error. A permanent cause — missing, expired or rejected credentials, a refused endpoint
(`403`), no `codex` executable, an answer without windows — is not said beside a reading: nothing
changes until you act, the reading stands, and the cause shows where no reading exists (the status
bar's `$(key) CC no token`, `$(circle-slash) CDX no codex` and the rest of
[status-bar-states.md](status-bar-states.md)). The sentence is said only while Token Pace may fetch
itself (`quotaSource: poll`, consent given, this window holding the lease), and only while the failure
is newer than the reading shown — a newer reading from another source answers the question the failure
left open. A next attempt whose time has passed reads `due`, never `reset due`. The time and the reason
of the last failed attempt are kept in the extension's own `quota.json`, so a restart during a backoff
still says why the figure is old. That entry holds the time, the kind of failure and the fetch's own
words (a fixed phrase with at most an HTTP status, or the Codex app-server's error string) — never a
token, a header or an exception's text —; it is kept for a permanent cause too (only the display leaves
that out), and it goes with the next successful fetch and with *Clear Stored Data…*. *Copy Diagnostics*
names its kind and its time per provider, never its words.

Even where fetching is enabled it is skipped while another source has a reading younger than the
interval — a fresh number from somebody else answers the same question for free. Nothing is then
called due or waiting for focus: the next attempt is not before that reading turns older than the
interval, and that is the time the views give for it.

## Reset re-poll

The moment a window turns over is the most important one for a pace tool, and the least likely
to be caught by a 30-minute interval. So for every window with a stated reset, one extra fetch
is scheduled just after it — five seconds past the announced time plus up to ten seconds of
jitter, once per (window, reset time), and only while the reading in hand is genuinely older
than the reset. Until that reading arrives the window reads `reset due`; the gauge is never
zeroed by us.

## Several windows open

`tokenPace.leaderElection` (on by default) lets one VS Code window do the reading and fetching
while the others follow its files, so several windows do not hammer the same rate-limit bucket
or fight over the stored history. The lease is an advisory file in `globalStorage` holding a pid,
a random id and an expiry. The governing rule is **in doubt, poll yourself**: an unreadable or
stale lease looks acquirable, because a window that wrongly believes it leads costs one extra
request, while a window that wrongly believes it follows shows stale figures forever. A follower
says so in the tooltip and still fetches on an explicit *Fetch Quota Now*.

**Focus gating.** With `tokenPace.pollOnlyWhenFocused` (default on) a window that has been in
the background for more than ten minutes stops its scheduled fetches; regaining focus after that
runs one freshness check, which is also what catches a machine coming back from standby. A
manual fetch always runs. A scheduled attempt that falls due meanwhile says so instead of waiting
in silence: the retry state reads `retry waiting for focus`, the tooltip `$(clock) next attempt
waiting for focus`, the markdown's freshness row `next refresh waiting for focus`, and the log says
once per hold `claude: a due fetch waits for this window to be focused (tokenPace.pollOnlyWhenFocused)`.
That is said only of an attempt that would be made — a fresh reading from the status line or a cache
file answers the fetch, and a background window showing one holds nothing back.

**Persistent app-server.** `tokenPace.codexAppServer.mode: persistent` keeps one
`codex app-server` child alive per editor instead of spawning one per poll, and then receives
`account/rateLimits/updated` pushes as data. It is killed on deactivate and on process exit,
restarts with exponential backoff (5 s up to 5 min), and gives up after five restarts in an hour
rather than respawning a broken binary forever. Followers keep no child. The default `oneShot`
spawns per poll and kills the child afterwards.

## Writing the cache file (opt-in)

`tokenPace.writeQuotaCache` writes each successful fetch of our own back to the cache file in
the documented format, so a panel widget, a shell prompt and this extension share one request
instead of three. This is one of exactly **two** writes Token Pace can make outside its own
storage: it is off by default, enabling it asks for its own separate consent that names the
file, an existing file with a newer `fetched_at` is never overwritten, and the write is atomic
(temp file plus rename).

## Claude status-line bridge (opt-in)

**Token Pace: Connect Claude Status Line…** copies a small script into the extension's storage,
`<globalStorage>/statusline-bridge.js`, and registers it as Claude Code's `statusLine.command`.
Claude Code then pipes its status JSON — rate limits, context window, prompt cache, running cost —
into that script on every refresh; the script writes the fields Token Pace reads of it to
`<globalStorage>/statusline-mirror.json` and prints a status line. That mirror is the only
official, network-free source for the Claude quota percentages. Which fields those are — among
them, since 1.8, `session_id`, which tells one session's prompt cache from another's, and the
prompt cache's `recache_tokens_if_cold` — is listed in [Prompt cache](prompt-cache.md#what-is-read)
and [Privacy](privacy.md); everything else of the JSON never reaches the file (1.3 to 1.7 mirrored
it whole, and 1.8 narrows such a mirror on its first activation).

**Where the script lives.** The command names the copy in the extension's storage, not the script
inside the extension's own folder: that folder carries the version in its name, and every update
replaces it — a command naming it would run a script that is gone. An install of 1.3 to 1.7 named
that folder. On its first activation in a trusted window 1.8 moves such a command to the copy:
only the `statusLine.command` string changes — the same node, the same mirror, the same chained
command, and the rest of `settings.json` as it was —, a backup of the original bytes is written first, and only while the slot still holds the
command Token Pace recorded; the Token Pace log says so. Every activation replaces the copy with the
shipped script when the two differ, so an update reaches a status line connected before it.

This is the second and last write outside the extension's storage, and the riskiest thing the
extension can do, because it edits a file that belongs to another program. The rules are narrow:

* A `settings.json` that does not parse is **never** written to — not repaired, not reformatted,
  not touched.
* A backup of the original bytes is written first, next to it, as
  `settings.json.token-pace-backup-<timestamp>`.
* An existing status-line command is preserved by chaining: it is called by the script with the
  same input and its output is passed through unchanged. Extra keys of the entry (`padding` and
  the like) are carried over.
* **Token Pace: Disconnect Claude Status Line** restores the previous entry exactly — but only
  while the installed command is still the one we wrote. If something else has taken the slot
  since, it refuses rather than overwrite a third party's configuration.
* `settings.local.json` and managed settings can shadow the whole thing. Claude Code merges them
  over the user settings, so an install can be technically successful and have no effect at all;
  that is reported as `configuration-shadowed`, with the shadowing files named, rather than
  silently ignored.
* The script never sends anything anywhere, never logs the piped JSON, and every failure path
  still passes stdin through and exits 0 — it must never break somebody's status line.
* It is **not** removed when the extension is uninstalled. Disconnect first if you plan to
  remove Token Pace: uninstalling deletes the extension's storage, the script's copy with it, and
  a status line still connected would then start a script that is gone.
* Both writes are disabled in Restricted Mode.

> The field names of the piped payload (`rate_limits.five_hour.used_percentage`,
> `context_window`, `prompt_cache`, `cost.total_cost_usd`, …) are read defensively in both
> snake_case and camelCase and have not been independently verified against every Claude Code
> version. A block that is absent is an absent figure, never a zero.

## Extra usage

Usage bought on top of the plan is tracked separately and never folded into the plan
windows — they are different pots and adding them would misstate both. Anthropic reports a
monthly allowance under `extra_usage` (the amount arrives in minor units with a
`decimal_places` shift, so `1240` is $12.40, not $1,240); OpenAI reports a prepaid balance
under `rateLimits.credits`.

A disabled allowance is stated as `off (never enabled)` — or with whatever reason the provider
gives — rather than drawn as a 0 % bar, which would read like headroom that is not there. Where
an allowance is active it gets its own blue bar:

```
Extra usage    $12.40 of $50.00 · 25 %
Extra usage    $50.00 of $50.00 · 100 % · spend limit reached
Extra usage    42 credits left
Extra usage    unlimited
```
