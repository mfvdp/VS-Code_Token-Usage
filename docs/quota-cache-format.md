<!--
SPDX-FileCopyrightText: 2026 Frederik Marx
SPDX-License-Identifier: AGPL-3.0-or-later
-->

# The quota cache file

Token Pace does not need the network to show your quota. In its default mode it reads a
small JSON file that *somebody else* wrote — a panel plugin, a cron job, a shell script, a
sibling extension. This document is the contract for that file, so you can write one.

The idea is deliberately narrow: **the reading travels, not the credential.** Whoever holds
the access token makes the request; everybody else reads the answer from disk. One process
asks the provider, any number of widgets display it, and no secret ever leaves the process
that owns it.

Token Pace can be on either end of this file:

* **Reader** in every mode, including `tokenPace.quotaSource: cache` — that setting only
  governs whether Token Pace may fetch on its own, never whether it may read this file.
  Reading is enabled by `tokenPace.claudeQuotaSources` / `tokenPace.codexQuotaSources`
  containing `cacheFile`, which is the default; remove it there to switch the source off.
* **Writer** (only with `tokenPace.writeQuotaCache` turned on, which asks for its own
  consent). After a successful fetch of its own it writes the same format back, so your
  status line or panel widget gets the number without a second request.

## Location

| Provider | Setting | Default |
|---|---|---|
| Claude | `tokenPace.claudeQuotaFile` | `~/.cache/claude-usage/state.json` |
| Codex | `tokenPace.codexQuotaFile` | `~/.cache/codex-usage/state.json` |

One file per provider. `~` is expanded; the settings are machine-scoped, so a synced
setting cannot carry a Linux path onto a Windows machine.

## The envelope

```json
{
  "schema_version": 1,
  "source": "claude",
  "fetched_at": 1788451200,
  "fail_count": 0,
  "blocked_until": 0,
  "writer": "token-pace/1.0.0",
  "body": {},
  "providers_error": null
}
```

| Field | Type | Required | Meaning |
|---|---|---|---|
| `schema_version` | integer | recommended | `1` for this contract. A missing field means `0` — see [Legacy](#legacy-schema_version-0). |
| `source` | `"claude"` \| `"codex"` | recommended | Which provider the body belongs to. A reader that finds the wrong one should ignore the file rather than guess. |
| `fetched_at` | number, **Unix seconds** | **yes** | When the body was obtained from the provider — not when the file was written. This is the number every "3 min old" label and every staleness rule is built on. Seconds, not milliseconds. |
| `fail_count` | integer | optional | Consecutive failed attempts since the last success. Shown in the "empty response" message, so a reader can distinguish "never worked" from "worked an hour ago". |
| `blocked_until` | number, Unix seconds | optional | The writer has paused itself until this time (rate limit, backoff). While it is in the future, Token Pace shows the state `$(clock) CC paused` (tooltip: *poller paused until …*) instead of pretending the old number is current. `0` or absent means "not paused". Honoured for both providers. |
| `writer` | string | recommended | Who wrote the file, e.g. `"token-pace/1.0.0"` or `"xfce-claude-usage/2.3"`. Diagnostics only. |
| `body` | object **or** string | **yes** | The provider response, verbatim. See below. |
| `providers_error` | string \| null | optional | A partial failure: some of the response is present, some is not. A reader shows what it has and marks the rest as missing — it must never render the missing half as `0 %`. |

Unknown extra fields are ignored, never rejected. Nothing in this file may contain a token,
a cookie, a refresh token or an `Authorization` header; Token Pace neither reads nor writes
such fields, and a file that carries one is a leak waiting to happen.

## `body`: object or string

Both forms are accepted, because the pollers in the wild use both:

```json
"body": { "limits": [] }
```

```json
"body": "{\"limits\":[]}"
```

If `body` is a string it is parsed as JSON. If it is anything else — or if parsing fails —
the reading counts as **empty**, not as zero usage: Token Pace shows `CC –` with the
`fail_count`, never `0 %`.

The body is the **verbatim provider response**. Do not reshape it, do not rename fields, do
not drop the ones you happen not to use: the drift scanner reports numeric fields that the
current build does not render, and that report is how new provider fields get noticed.

## Example: Claude

`body` is the response of the endpoint Claude Code itself uses for its usage display. The
numbers below are fictional.

```json
{
  "schema_version": 1,
  "source": "claude",
  "fetched_at": 1788451200,
  "fail_count": 0,
  "blocked_until": 0,
  "writer": "my-poller/0.4",
  "body": {
    "limits": [
      {
        "kind": "session",
        "group": "session",
        "percent": 41.5,
        "resets_at": "2026-09-03T18:00:00Z"
      },
      {
        "kind": "weekly_all",
        "group": "weekly",
        "percent": 68.2,
        "resets_at": "2026-09-08T06:00:00Z"
      },
      {
        "kind": "weekly_scoped",
        "group": "weekly",
        "percent": 12.0,
        "resets_at": "2026-09-08T06:00:00Z",
        "scope": { "model": { "display_name": "Fable" } }
      }
    ],
    "extra_usage": {
      "is_enabled": true,
      "utilization": 8.0,
      "used_credits": 412,
      "monthly_limit": 5000,
      "decimal_places": 2,
      "currency": "USD",
      "spend_limit_reached": false
    }
  },
  "providers_error": null
}
```

Notes for writers:

* `limits[]` is the complete list and the preferred shape — it is the only place the
  model-scoped weekly windows appear. The older top-level form (`five_hour`,
  `seven_day`, `seven_day_opus`, … each with `utilization` and `resets_at`) is still read as
  a fallback.
* `resets_at` is an ISO-8601 timestamp here, unlike `fetched_at` in the envelope, which is
  Unix seconds. That inconsistency is the provider's; the contract keeps the response
  verbatim rather than "fixing" it.
* `extra_usage.used_credits` and `monthly_limit` are minor units; `decimal_places` says how
  far to shift them. Passing them through unshifted inflates the amount by a factor of 100.
* A window with no `resets_at` gets no countdown and no pace verdict. Do not invent one.

## Example: Codex

`body` is the response of the local `codex app-server` rate-limit call. Fictional numbers
again.

```json
{
  "schema_version": 1,
  "source": "codex",
  "fetched_at": 1788451080,
  "fail_count": 0,
  "blocked_until": 0,
  "writer": "my-poller/0.4",
  "body": {
    "rateLimitsByLimitId": {
      "codex": {
        "limitName": "Codex",
        "primary": {
          "usedPercent": 33.0,
          "windowDurationMins": 300,
          "resetsAt": 1788462000
        },
        "secondary": {
          "usedPercent": 71.4,
          "windowDurationMins": 10080,
          "resetsAt": 1788969600
        }
      },
      "codex_bengalfox": {
        "limitName": "Bengal Fox",
        "primary": {
          "usedPercent": 5.0,
          "windowDurationMins": 300,
          "resetsAt": 1788462000
        },
        "secondary": null
      }
    },
    "rateLimits": {
      "planType": "pro",
      "credits": { "hasCredits": true, "unlimited": false, "balance": "18.40" }
    },
    "rateLimitResetCredits": { "availableCount": 2 }
  },
  "providers_error": null
}
```

Notes for writers:

* `resetsAt` is Unix **seconds** here (the reader multiplies by 1000).
* Windows are keyed by window length, not by the `primary` / `secondary` slot: which slot
  carries which window varies by plan, and `secondary` is often `null`. A `null` slot is
  omitted, never rendered as `0 %`.
* `credits.unlimited` means exactly that — it must not be drawn as a full or an empty bar.

If you have no app-server, you do not need this file at all for Codex: Codex writes a
`rate_limits` block into its own transcripts, and Token Pace reads it with
`tokenPace.codexQuotaSources` containing `transcript` — no network, no child process.

## Writing rules

1. **Never overwrite a newer file.** Read the existing file first; if its `fetched_at` is
   greater than the one you are about to write, leave it alone. Two pollers with different
   intervals otherwise overwrite each other's fresher readings in turn, and the number on
   screen ends up older than either of them. Token Pace obeys this rule when
   `tokenPace.writeQuotaCache` is on.
2. **Write atomically.** Write to `<file>.tmp` in the same directory, then `rename` over the
   target. A reader that catches a half-written file sees invalid JSON, and invalid JSON is
   indistinguishable from "no data" — which is the state that hides your numbers.
3. **`fetched_at` is the time of the provider response**, not of the write. Copying the
   write time makes a cached body look forever fresh.
4. **Keep failures visible.** On a failed attempt, keep the last good `body` and
   `fetched_at`, and raise `fail_count`. On a rate limit, set `blocked_until`. Do not write
   an empty body over a good one, and do not write zeros.
5. **Never write a credential into this file**, in any field, in any encoding.

## Legacy: `schema_version` 0

A file **without** `schema_version` is treated as version 0 — the shape the original XFCE
panel pollers wrote. It is read exactly like version 1: the same `fetched_at`, `fail_count`,
`blocked_until` and `body` fields, without `source`, `writer` or `providers_error`. There is
nothing to migrate; adding `schema_version: 1` and `source` to an existing writer is enough.

Version 0 files are read, never written. Token Pace always writes version 1.

## Reading rules that a consumer should copy

* An absent or unparsable file is *absence*, not zero. Render `–`, not `0 %`.
* A `fetched_at` in the future, or one older than your staleness threshold, is marked, not
  silently trusted.
* `blocked_until` in the future means the writer knows it has no current data. Say so.
* Never merge fields from two files or two identities into one reading. A number belongs to
  the account that produced it.
