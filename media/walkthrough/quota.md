<!--
SPDX-FileCopyrightText: 2026 Frederik Marx
SPDX-License-Identifier: AGPL-3.0-or-later
-->

### Local sources first

| Source | What it is | How fresh |
|---|---|---|
| cache file | `~/.cache/claude-usage/state.json`, written by a panel widget or a script | the writer's `fetched_at` |
| status line | Claude Code's own status line, mirrored by the opt-in bridge | every status-line refresh |
| `~/.claude.json` | Claude Code's `cachedUsageUtilization` | its own cache; discarded above 24 h |
| Codex transcripts | the `rate_limits` block Codex writes itself | as old as your last Codex turn |

All four cost nothing, need no credentials and touch no network. Their age is
always shown, and a reading older than `staleAfterMinutes` is greyed out.

### What "poll" means

Fetching the figures ourselves is a separate decision, asked once, in a dialog.
This is that dialog, word for word — so the terms can be read here, before it
ever appears:

```
Token counts are read from local transcript files and need no network access. Quota percentages do.

If you allow it, then at most every 30 minutes (tokenPace.pollIntervalMinutes):

• Claude — GET https://api.anthropic.com/api/oauth/usage, using the accessToken from
  ~/.claude/.credentials.json. The request identifies itself as the Claude Code client,
  because the endpoint rate-limits other callers into a permanent 429.
• Codex — the local "codex app-server" is started and asked for its rate limits. No traffic
  of ours leaves the machine for this.

That endpoint is undocumented: it is what Claude Code itself calls, it carries no stability
promise, and it may change or disappear at any time. Token Pace then shows no quota figures
rather than guessing any.

The token is only read, never refreshed, and appears in no log line or error message. The
target address is hard-coded and cannot be configured. Nothing is sent anywhere else, and
no usage data is collected by this extension.

You can change this later with "Token Pace: Reset Network Access Decision".
```

The interval in the first line is your `tokenPace.pollIntervalMinutes`.
`tokenPace.quotaSource: cache` settles the question for good, without a dialog.
