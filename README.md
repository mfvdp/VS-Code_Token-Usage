# Token Pace — Claude Code & Codex

Quota, tokens and API cost for **Claude Code** and **Codex**, permanently in the VS Code
status bar, with a detailed tooltip and a dashboard in the secondary sidebar.

The bars are coloured by **pace**, not by level: green while consumption stays at or below
the share of the window that has already elapsed, yellow once it runs ahead of the clock,
red when the window is spent. A 60 % bar is reassuring an hour before the reset and alarming
five minutes in — a fixed threshold cannot tell those apart.

```
CC 5h ██▁▁▁▁▁▁ 25%   CC 7d ██▁▁▁▁▁▁ 25%   CC Fable 7d █▁▁▁▁▁▁▁ 14%
CDX 7d ████████ 100%   CDX Spark 5h ▁▁▁▁▁▁▁▁ 0%   Σ 4.6M
```

One entry per quota window, including the model-scoped ones. With
`tokenPace.windows: "leading"` only the most-utilised window per tool remains, and
`tokenPace.statusBar.show` decides which entries appear at all.

**Out of the box this extension makes no network access at all.** Token counts are read from
local transcript files. Quota percentages need the provider, and that is asked for once, in a
dialog that states exactly what is sent where — see [Quota](#quota-cache-file-or-own-fetch)
and [Handling of the access token](#handling-of-the-access-token). No usage data is collected.

Not affiliated with, endorsed by, or sponsored by Anthropic or OpenAI. “Claude” and “Codex”
are the trademarks of their respective owners and are used here only to name the tools whose
output is read.

## Where the numbers come from

| Display | Source | Confidence |
|---|---|---|
| Quota %, reset, model windows | provider API, or an external poller's cache file | exact (from the server) |
| Tokens per day/model | `~/.claude/projects/**/*.jsonl` | exact |
| Tokens per day/model | `~/.codex/sessions/**/rollout-*.jsonl` | exact |
| Output of Claude subagents | the same transcripts | **lower bound** (⚠ in the tooltip) |

For Claude the windows come from the response's `limits[]` array, not from the top-level
fields: only there do the model-scoped quotas appear (`kind: "weekly_scoped"` with
`scope.model.display_name`).

The percentages come from each provider's server and cover **all** clients — desktop app and
browser included. They cannot be derived from the local token counts, and the extension
never suggests otherwise.

“Usage” means fresh input + cache write + output. Cache reads are listed separately because
they would otherwise dominate the total by a factor of ~1000.

### Pace, not level

Each bar carries a tick marking how much of that window's own time has already passed, and
the colour compares consumption against that tick rather than against a fixed threshold:

| Colour | Meaning |
|---|---|
| 🟢 green | usage at or below the elapsed share — on pace |
| 🟡 yellow (▲) | usage ahead of the clock — the window runs out before it resets |
| 🔴 red | the window is spent (the status bar entry also gets an alarm background) |

An absolute level says little on its own: 80 % used is comfortable six days into a weekly
window and alarming six hours in. Real numbers from one session:

```
CC 5 h     98 % used · 82 % elapsed   → yellow ▲
CC 7 d     40 % used · 80 % elapsed   → green
CDX 7 d   100 % used · 10 % elapsed   → red
```

Windows that report no reset time have nothing to compare against; they stay green until
they are spent.

### Extra usage

Usage bought on top of the plan is tracked separately and never folded into the plan
windows — they are different pots and adding them would misstate both. Anthropic reports a
monthly allowance under `extra_usage` (the amount arrives in minor units with a
`decimal_places` shift, so `1240` is $12.40, not $1,240); OpenAI reports a prepaid balance
under `rateLimits.credits`.

A disabled allowance is stated as `off (never enabled)` rather than drawn as a 0 % bar —
the latter would read like headroom that is not there. Where an allowance is active it gets
its own blue bar:

```
Extra usage    $12.40 of $50.00 · 25 %
Extra usage    $50.00 of $50.00 · 100 % · spend limit reached
Extra usage    42 credits left
```

## Quota: cache file or own fetch

`tokenPace.quotaSource` decides where the percentages come from. It behaves the same on
every platform:

| Value | Behaviour |
|---|---|
| `auto` (default) | Cache file only, **no network access**. If nothing is there, offers **once** to switch to `poll`. |
| `poll` | Fetches directly — but only after you have agreed in the dialog below. |
| `cache` | Cache file only, never fetches and never asks. |

The cache file is written by an external poller — during development that was a pair of XFCE
panel plugins. Where one exists, the extension never asks anything: a second client on the
same rate-limit bucket would gain nothing and only risk a 429 for both.

### Consent

Fetching uses Claude Code's access token, so it never starts unasked. The first time it would
happen, a dialog names the endpoint, the credential file, the fact that the request
identifies itself as the Claude Code client, and what is *not* done with the token. Only
**Allow** enables it; **Never** is remembered; closing the dialog leaves the question open.

The answer is stored per machine and is never synced. **Token Pace: Reset Network Access
Decision** puts the question back.

The extension's own fetch runs every `tokenPace.pollIntervalMinutes` minutes (default 30):

* **Claude** — `GET https://api.anthropic.com/api/oauth/usage` with the `accessToken` from
  `~/.claude/.credentials.json`, header `anthropic-beta: oauth-2025-04-20` and a
  `claude-code` user agent. Without that user agent the call lands in an aggressively
  rate-limited bucket and receives a permanent 429.
* **Codex** — `codex app-server --stdio` is started and asked for
  `account/rateLimits/read` over JSON-RPC. The executable is looked up via `CODEX_CLI_PATH`,
  then `PATH`, and finally inside the binary bundled with the official IDE extension.

Even where fetching is enabled it is skipped while a cache file is younger than the
interval. The tooltip states which source produced the displayed number (“polled” or
“cache file”).

Failures back off progressively: on 429 or 5xx from 10 min up to 2 h (a `Retry-After`
header wins), on network errors from 1 min up to 30 min, both with jitter. A permanent
cause — missing credentials, no `codex` executable — is not retried every minute. The last
successful state survives a restart, so switching windows does not trigger a fetch.
**Token Pace: Fetch Quota Now** forces an immediate attempt.

### Handling of the access token

* It is **only read**, and sent exclusively to `api.anthropic.com`. The target URL is
  hard-coded and not configurable.
* It is **never refreshed**. Rotating the token from here would invalidate Claude Code's own
  session. If it has expired, the extension says so and waits for Claude Code to renew it
  during normal use.
* It appears in no log line and no error message; network errors are reported generically so
  that nothing from the request can leak.
* Nothing happens without consent, and consent is revocable at any time.
* `tokenPace.quotaSource: "cache"` disables every network access and the question with it.

## The “API cost” column

What this usage would have cost through the provider API at list prices — computed per
model, because the rates differ by a factor of 50.

**On a subscription you do not pay these amounts.** The figure has no billing relationship;
it only answers “what would this have been through the API”.

Prices as of 1 September 2026, sourced from [docs.claude.com](https://docs.claude.com) and
[developers.openai.com/api/docs/pricing](https://developers.openai.com/api/docs/pricing).
Anthropic cache rates are fixed multiples of the input rate (5-min write 1.25×, 1-hour write
2×, read 0.1×) — the two write TTLs are counted separately. For OpenAI the cached-read rate
is stated separately, and `input_tokens` already includes the cached tokens (counting both
would pay for them twice).

Prices go stale. `tokenPace.customPrices` overrides or extends the table per model
without a rebuild; models with no price on file show as `–` and are named in the footnote so
the total is never silently too low. `tokenPace.showCost: false` hides the column.

Amounts are shown to the cent below $100 and rounded to whole dollars from $100 up, where
the cents no longer carry information anyone acts on. Exactly zero is a dash, because no
usage says something different from $0.00; a real amount under a cent shows as `<$0.01`
rather than rounding away to nothing.

## Counting

Three traps that make naive evaluations wrong:

* **Claude dedup.** One API response is written as *N* lines (one per content block). Dedup
  runs on `message.id` and takes the maximum per field — `output_tokens` is a streaming
  snapshot, so “first line wins” halves the value.
* **Codex fork replay.** A forked thread carries the parent thread's complete
  `token_count` history. Without detecting it you count roughly double. It is recognised via
  `session_meta.forked_from_id` plus the fork timestamp; only the positive increase counts.
* **Time zone.** Codex rollouts are UTC. Day boundaries are formed in local time.

## Privacy

Only `~/.claude/projects/`, `~/.codex/sessions/` and the two quota files are read.
`~/.claude/ide/*.lock` (which holds an `authToken` in clear text) and
`~/.claude/sessions/*.key` are **never** touched; symlinks are not followed while scanning.
Nothing is written except the extension's own state in its `globalStorage`. The only
outbound network access is the quota fetch described above — transcript contents never leave
the machine.

## Windows

The `.vsix` is platform-independent (no native code) and installs with

```powershell
code --install-extension token-pace-0.9.0.vsix
```

or through the UI via *Extensions → … → Install from VSIX…*.

Both halves work there: `~/.claude` resolves to `%USERPROFILE%\.claude`. Windows has no
external poller writing the cache file, so the quota stays empty until you allow fetching —
the extension offers that once, and [Consent](#consent) says what the dialog states. Token
counts need none of that and appear straight away.

If the directories have been relocated, set `tokenPace.claudeDir` / `tokenPace.codexDir`
(or `CLAUDE_CONFIG_DIR` / `CODEX_HOME` — but those only apply when they were already set when
**VS Code started**, not when they merely live in a shell profile).

### WSL

If Claude Code runs **inside WSL**, the transcripts live in the Linux file system, not under
`%USERPROFILE%`. This extension declares `"extensionKind": ["ui"]` and therefore always runs
on the Windows host — it would look at the wrong home directory and report 0 tokens with no
error. Two ways out:

* point `tokenPace.claudeDir` at `\\wsl$\<distro>\home\<user>\.claude` (slow, because
  every read goes through the 9p server), or
* change `"extensionKind"` in `package.json` to `["workspace"]` and rebuild — then the
  extension runs in the WSL remote and sees the paths directly.

Not both at once: `["ui", "workspace"]` would leave the choice to VS Code and make the
failure mode unpredictable.

## Settings

**What is shown**

| Setting | Values |
|---|---|
| `statusBar.show` | `claudeQuota` · `codexQuota` · `extra` · `tokens` · `cost` — an empty list hides the status bar entirely |
| `dashboard.sections` | `quota` · `tokens` · `chart` · `models` |
| `windows` | `all` (every quota window) or `leading` (only the most-utilised one per tool) |

**Appearance**

`barWidth` (0 = no bars) · `barStyle` (`line` / `shade` / `none`) · `alignment` ·
`staleAfterMinutes`

**Cost**

`showCost` · `customPrices`

**Data sources**

`quotaSource` · `pollIntervalMinutes` · `claudeDir` · `codexDir` · `claudeQuotaFile` ·
`codexQuotaFile` · `codexBinary`

**Commands**

| Command | Purpose |
|---|---|
| `Token Pace: Open Dashboard` | Dashboard in the secondary sidebar |
| `Token Pace: Re-read Token History` | Full re-scan of all transcripts |
| `Token Pace: Fetch Quota Now` | Immediate fetch, asking for consent if needed |
| `Token Pace: Reset Network Access Decision` | Puts the consent question back |
| `Token Pace: Show Log` | Output channel |

There is no warning threshold to configure: the colour follows the pace comparison described
above, which needs no tuning.

## Building

```bash
npm install && npm run build      # dist/
npm run package                   # .vsix
code --install-extension token-pace-0.9.0.vsix
```

## License

**GPL-3.0-or-later.** Copyright © 2026 Frederik Marx. The full text is in [LICENSE](LICENSE);
every source file carries an [SPDX](https://spdx.dev) identifier.

Copyleft was chosen deliberately. This extension reads an access token, and the only
meaningful assurance about what it does with it is that you can read the code. That
assurance should survive being passed on: anyone who **distributes** a modified version — as
another extension, as a `.vsix`, inside a product — has to publish its complete source under
the same licence, so the next person gets the same guarantee.

Using and modifying it for yourself carries no obligation whatsoever. The duty begins at
distribution, never at use, and forking this repository is not distribution.
