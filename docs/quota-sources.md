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
itself sends, with the version read once per session from `claude --version` (a constant if that
fails). `honest` sends `token-pace/<version>` instead. **Warning:** the honest agent lands in an
aggressively rate-limited bucket and can expect `429 Too Many Requests` within a few fetches,
after which Token Pace backs off for up to two hours and shows nothing new. The endpoint is
undocumented; this is an observation from the field, not a documented rule.

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

Even where fetching is enabled it is skipped while another source has a reading younger than the
interval — a fresh number from somebody else answers the same question for free.

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
manual fetch always runs.

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

**Token Pace: Connect Claude Status Line…** registers a small bundled script as Claude Code's
`statusLine.command`. Claude Code then pipes its status JSON — rate limits, context window,
prompt cache, running cost — into that script on every refresh; the script mirrors the JSON to
`<globalStorage>/statusline-mirror.json` and prints a status line. That mirror is the only
official, network-free source for the Claude quota percentages.

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
  remove Token Pace.
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
