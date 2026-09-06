<!--
SPDX-FileCopyrightText: 2026 Frederik Marx
SPDX-License-Identifier: AGPL-3.0-or-later
-->

# Privacy

Part of the [Token Pace documentation](../README.md#documentation).

Only these are read: `~/.claude/projects/` (plus `~/.config/claude/projects/`, where some Claude
Code builds keep it), `~/.codex/sessions/` and `~/.codex/archived_sessions/`, the two quota cache
files, the `cachedUsageUtilization` object in `~/.claude.json`, the extension's own status-line
mirror file inside its `globalStorage`, Claude Code's `settings.json`, its `settings.local.json`
and the platform's managed-settings file (to report whether the status-line bridge is installed
and whether something shadows it) and — only in `quotaSource: poll`, only after consent —
`~/.claude/.credentials.json`, for the access token that the poll sends to
`https://api.anthropic.com/api/oauth/usage` and nowhere else.

`~/.claude/ide/*.lock` (which holds an `authToken` in clear text),
`~/.claude/sessions/*.key` and the `oauthAccount` block of `~/.claude.json` are **never** touched;
symlinks are not followed while scanning; the walk is confined to `projects/` and `sessions/`.

Transcript contents — prompts, responses, tool arguments and tool results — are never stored,
logged, exported or displayed. The one thing read out of a message body is the **name** of a tool
call, with the day, the model and how often it ran: that is what the `tools` section and the
`tools[]` of the export are made of, and it is names and counts, never a path, an argument or an
output. Nothing is written except the extension's own state in its `globalStorage`, with
exactly two opt-in exceptions, each behind its own consent dialog and each with a backup or a
never-overwrite rule: the external quota cache file (`tokenPace.writeQuotaCache`) and the
status-line bridge. Both are off by default and both are disabled in Restricted Mode.

One further write exists and is not an opt-in setting: the *Run Token Pace locally* button of
the remote hint puts `remote.extensionKind` into your user `settings.json` — see
[Windows, WSL and remote development](windows-wsl-remote.md). It happens only on
that click, only on a remote host with no transcripts, and it merges rather than replaces.

The only outbound network access is the consent-gated quota fetch described under
[Quota sources](quota-sources.md). That promise is checked mechanically:
`npm run check:privacy` scans the shipped bundles for every `http(s)`
literal and matches it against a small allow-list (`api.anthropic.com`, the two official usage
pages, and documentation links that only ever appear as text). It runs in CI on all three
platforms and in the release workflow, and it fails the build on anything else — a price feed, a
status page or a CDN font would otherwise be a two-line change nobody notices in review.

The webview loads no external resource at all, no telemetry of any kind is collected, and there
is no endpoint setting to point somewhere else.
