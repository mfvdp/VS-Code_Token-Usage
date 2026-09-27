<!--
SPDX-FileCopyrightText: 2026 Frederik Marx
SPDX-License-Identifier: AGPL-3.0-or-later
-->

# Notifications

Part of the [Token Pace documentation](../README.md#documentation).

Since 1.12 Token Pace can send a short message to your phone, a chat or your mail when something happens that you
would otherwise only see in VS Code: Claude Code waiting for your answer, a long turn finished, a quota window past
your threshold, exhausted, reset, or forecast to run out before its reset. A **notification** is such a message, sent
to a **channel** outside VS Code. It is not an **alert**: the alerts of `tokenPace.alerts.*` are VS Code's own popups
inside the editor ([Budgets and alerts](budgets-alerts.md)), and both may speak about the same window once.

**Nothing is sent by default.** While `tokenPace.notifications.channels` is empty — its default — Token Pace sends
nothing, reads no secret and keeps no state for notifications. A channel sends only after you set it up with *Token
Pace: Set Up a Notification Channel…*, allowed its host, and listed it in `tokenPace.notifications.channels`.

What a notification never does: it never carries a prompt, a line of a transcript, a path, a folder or project name,
a session's name or id, an agent, a plan, an account, a token count or a cost; it never asks you anything and nothing
you answer in a chat reaches Token Pace — Token Pace reads nothing back from a channel except whether it accepted the
message; and a failed notification is never tried again and never becomes an alert — it is in the log and in *Copy
Diagnostics*.

## Setting up a channel

Run *Token Pace: Set Up a Notification Channel…* and pick one of nine entries. Token Pace asks for the channel's
address and secrets in boxes that hide what you type, then asks whether it may send to the channel's host (below), and
only then stores the secrets — in VS Code's secret storage, never in `settings.json`. It writes no setting: when it is
done it tells you the channel's id to add to `tokenPace.notifications.channels`, and *Open Settings* takes you there.
You can run *Set Up* again at any time — to change an address, or to allow a new host. Where a secret is stored
already for the host this setup allows, its box says *Leave empty to keep the stored one.* A stored secret belongs to
the host you allowed it for: when *Set Up* allows another one — a webhook address on another host, another ntfy
server, or another SMTP server or port — it offers none of the old secrets to keep, a secret the channel cannot do
without has to be typed again, one it can do without (the webhook's secret header, the ntfy token) is deleted on
*Allow* when you leave its box empty, and a preset never keeps the generic webhook's header value.

| Entry | Channel id | What you need | Where it comes from |
|---|---|---|---|
| Webhook (JSON) | `webhook` | An `https://` address that accepts a JSON `POST`; optionally a secret header | Your own server or an automation service. Name the header in `tokenPace.notifications.webhook`'s `secretHeader` first; *Set Up* then asks for its value |
| Slack | `webhook` | An incoming-webhook address | A Slack app of yours: its *Incoming Webhooks* page, *Activate Incoming Webhooks*, then *Add New Webhook to Workspace* and the channel; the address is under *Webhook URLs for Your Workspace* |
| Discord | `webhook` | A channel webhook's address | The channel's settings, *Integrations → Webhooks* |
| Microsoft Teams | `webhook` | A Workflows webhook's address | A workflow (Power Automate, or Workflows in Teams) with the trigger *When a Teams webhook request is received*; its address is shown when the flow is saved (the old Office 365 connectors are being retired) |
| Mattermost | `webhook` | An incoming-webhook address | *Product menu → Integrations → Incoming Webhook*, *Add Incoming Webhook* — where *Integrations* is missing, a System Admin enables incoming webhooks under *System Console → Integrations → Integration Management* |
| Rocket.Chat | `webhook` | An incoming-webhook address | *Manage → Workspace → Integrations*, *New*, the *Incoming* tab; the address is in the *Instructions* after saving |
| Telegram | `telegram` | A bot's token and the chat it sends to | The token from @BotFather; the chat id (a number, negative for a group, or `@name` for a public Telegram channel) in `tokenPace.notifications.telegram` first |
| ntfy | `ntfy` | A server, a topic, and an access token if the server needs one | The server's own address — `https://ntfy.sh` or your own server's — in `tokenPace.notifications.ntfy` first; the topic is a secret, because anyone who knows it can read its messages |
| E-mail (SMTP) | `email` | An SMTP server, an account, a sender and one recipient | `host`, `port`, `security`, `user`, `from` and `to` in `tokenPace.notifications.email` first; many providers want an app password rather than your account's password |

The paths in the last column are the ones the services' documentation gave on 2026-09-28 (Slack, Microsoft's Teams
connector page, Mattermost, Rocket.Chat); Discord's help page could not be read that day, so its path is not checked —
none of them was followed in the services' apps by the author.

The five services' presets are the webhook channel with another body: the address is the same kind of secret, and
`tokenPace.notifications.webhook`'s `format` picks the body (`generic`, `slack`, `discord`, `teams`, `mattermost`,
`rocketChat`). There is one channel of each kind; *Set Up* after a preset says so when your `format` has to change.

**Which channels were tried against the real service for 1.12**: none yet. Not yet tried live by the author: the
generic webhook, Slack, Discord, Microsoft Teams, Mattermost, Rocket.Chat, Telegram, ntfy and e-mail over SMTP. Every
channel was built from the service's documentation, read on 2026-09-27 (Slack, Discord, Microsoft Teams Workflows,
Mattermost, Rocket.Chat, the Telegram Bot API, ntfy's JSON publishing), and tested against local servers — built from
the service's documentation, not tried by the author.

**Send a Test Notification…** sends a test message to one channel you set up — listed in `channels` or not — and
tells you whether it went, or why not in one word: `HTTP 401` (the service's status), a timeout, a TLS error, a
network error, refused by the server, an incomplete setup, or that its host changed since you allowed it. One test per
channel every ten seconds — a second one inside them is answered with a message and not sent.

**Remove a Notification Channel…** deletes a channel's secrets, your consent for its host and its last result, after
a confirmation.

## The consent — per channel, naming its host

Before anything is stored, *Set Up* asks *Allow Token Pace to send notifications to hooks.slack.com?* — the host is the
one your address names, `api.telegram.org` for Telegram, your ntfy server's, or your SMTP server with its port
(`smtp.example.com:587`). The question says what is sent, how often at most, what a message never holds, where the
secret is kept and how to take it back. *Allow* stores the secrets and remembers the host for that channel; *Never*
or closing the question stores nothing and remembers nothing.

At every send the channel's host as it is now must be the host you allowed: when you change the ntfy server or the
SMTP host or port in the settings, the channel sends nothing — the log says `Notify: ntfy skipped — its host changed
since you allowed it; run Set Up again`, and *Copy Diagnostics* says `consent no (host changed)` — until *Set Up* asks
you again. *Token Pace: Reset Network Access Decision* does not touch the channels; it is the quota fetch's question.

## The events

List what you want to hear about in `tokenPace.notifications.events`; an event that is not listed is never looked
for. Each fires once for what it reports — a wait, a turn, a window's cycle — and never again for it.

| Event | Default | Sent when | What it can and cannot know |
|---|---|---|---|
| `agentWaiting` | on | A Claude Code session has been waiting for your permission, or for your answer while its turn is open, for a minute, and this window is not focused | Needs the agent hook (*Token Pace: Set Up the Agent Hook…*) — without it the event never fires. A wait for your answer counts only while the turn is open: the idle prompt of a turn that has finished is `agentDone`'s news, not a question. A wait that ends within the minute sends nothing; one seen while the window is focused is sent once the window loses the focus, if it still stands. The session's own waits only, not a subagent's |
| `agentDone` | on | A Claude Code turn this window saw open for at least two minutes has finished, and this window is not focused | The span is a lower bound — "after at least 14 min" — counted from the newest prompt this window saw the turn answer, because the turn's real start is not in the transcript. An interruption during a tool call, or an API error line after a tool call, cannot be told from a tool still running, so "at least" can include a pause after such a turn. Nothing for a turn that was already over when VS Code opened, nothing while the transcripts are first read |
| `quotaThreshold` | on | A fresh reading of a 5-hour or weekly window is at or above `tokenPace.notifications.thresholds` (`session`, `weekly`; 80 and 80) | Once per window and cycle, only upwards; several windows at once are one message. Not for a window that is exhausted in the same reading — that says it |
| `quotaExhausted` | on | A fresh reading says the window's limit is reached, or it is at 100 % | Both providers; never for an unlimited window |
| `quotaReset` | off | A fresh reading shows a new cycle for a window whose last cycle ended no more than 30 minutes ago | A reset seen later — VS Code was closed — is stale news and is not sent |
| `paceWarning` | on | The window's forecast expects it to run out before its reset | The run-out time is an estimate and carries `~`; there is a forecast only once enough readings are held ([History and forecasts](history.md)) |

Never from a stale reading (the status bar's `tokenPace.staleAfterMinutes`), never from the status-bar preview, and
`agentWaiting` and `agentDone` are Claude Code's alone — a Codex session holds no end state or wait Token Pace reads.
With several VS Code windows open the window that leads (the lease, as for fetching) sends; the leader's focus stands
for the editor's, so a notification can come while you work in another window. **Without leader election**
(`tokenPace.leaderElection: false`) every window evaluates: the state they share stops most repeats, but two windows
may both send one.

## What a message holds

A message is built from an event's allow-list and nothing else: `event` (which of the six), `provider` (`claude` or
`codex`, for a quota window), `program` (`claudeCode`, for a wait or a turn), the window's `windowLabel` ("5 h",
"7 d · Fable") and `windowKind`, a whole `percent`, the kind of `wait` (`permission` or `input`) and the times
`resetsAt`, `etaAt` (an estimate), `since`, `atLeastMs` (a lower bound) and `at`. The title and the sentences are in
the language of `tokenPace.language` — the services' names (Slack, Discord, Microsoft Teams, Mattermost, Rocket.Chat,
Telegram, ntfy), the event ids and the setting fields stay as they are in every language —, with the clock times in
your zone and hour cycle:

> **Token Pace: quota threshold reached**
> Claude, 5 h window: 82% used — resets at 14:00.

> **Token Pace: Claude Code is waiting for you**
> Claude Code is waiting for your permission (since 11:58).

> Claude Code finished a turn at 11:59, after at least 14 min 20 s.

> Claude, 5 h window: 64% used, runs out at ~13:30 — before it resets at 14:00.

The webhook's `generic` format posts the same facts as JSON with English keys — times in ISO 8601 UTC, `null` where
a figure is absent (never `0`), `items` with one entry per window when a message names several:

```json
{
  "v": 1,
  "source": "token-pace",
  "event": "quotaThreshold",
  "title": "Token Pace: quota threshold reached",
  "text": "Claude, 5 h window: 82% used — resets at 14:00.",
  "provider": "claude",
  "program": null,
  "window": "5 h",
  "windowKind": "session",
  "percent": 82,
  "resetsAt": "2026-09-27T14:00:00.000Z",
  "eta": null,
  "since": null,
  "atLeastMinutes": null,
  "wait": null,
  "at": "2026-09-27T11:59:00.000Z"
}
```

Slack, Mattermost and Rocket.Chat get `text` with the title in bold (Slack's `&`, `<` and `>` escaped), Discord
`content` with no mention that could ping anyone, Microsoft Teams an Adaptive Card of version 1.2 with `contentUrl`
null — as the Workflows trigger expects —, one text block per line, Telegram plain text without a link preview
(`link_preview_options`, no `parse_mode`), ntfy its JSON publish body (priority 4 for `quotaExhausted` and
`agentWaiting`, 3 otherwise), and e-mail a plain-text message whose subject is the title. The request carries
`User-Agent: token-pace/<version>`.

## No storm

* Once per event: a wait, a turn, a window's cycle is sent once, and remembered for 45 days.
* One message per kind of event at a time: an event of a kind whose last message went out less than
  `tokenPace.notifications.cooldownMinutes` ago (10) is dropped, not saved for later — the log says `Notify:
  quotaThreshold dropped (cooldown)`. A quota window's threshold or exhaustion, and a wait that still stands, may speak
  once the cooldown is over; an `agentDone` or a `quotaReset` dropped by the cooldown or the cap is not sent later.
* At most 20 messages an hour, all events and channels together.
* A failed send is not tried again: it counts as sent, and the diagnostics show the failure.
* A `429` answer pauses that channel until its `Retry-After`, at most an hour; a `429` without a number of seconds
  there pauses nothing.
* Nothing is sent twice because a window closed during a send: the state is written before the message goes.

## Where the secrets are kept

The secrets — a webhook's address (the address of a Slack, Discord or Teams webhook is its credential) and its secret
header's value, the Telegram bot's token, the ntfy topic and its access token, the SMTP password — are kept in VS
Code's secret storage on this machine: per machine, never in `settings.json` and never synced with Settings Sync. None
of the eight settings holds one; `tokenPace.notifications.webhook`'s `secretHeader` is the header's name, not its
value. On Linux VS Code's secret storage needs a keyring it can use (GNOME Keyring, KWallet or another Secret
Service); which fallback VS Code applies without one is not traced here — VS Code's [Settings Sync
documentation](https://code.visualstudio.com/docs/configure/settings-sync) covers it under *Troubleshoot
credential-store issues*. A secret is read at the moment of a send and dropped with it, and stands only in the one
request that needs it — the Telegram token in the path of Telegram's address, the webhook's secret and the ntfy token
in a header, the SMTP password in the `AUTH` exchange after TLS stands. It never reaches a log line, a message, *Copy
Diagnostics*, an export or the extension's storage.

**Remove your channels before you uninstall Token Pace** (*Remove a Notification Channel…*, or *Clear Stored Data…*'s
item *Notification channels*): whether VS Code deletes an extension's secrets when it is uninstalled is not traced.

## Connections

The webhook channels, Telegram and ntfy use `https:` only — an `http:` address or one with a user name or password
in it is refused, and a redirect is never followed — through the extension host's `fetch`, which follows VS Code's
proxy support as the quota fetch does (how fully is not traced). A send ends after 15 seconds. ntfy's `server` is the
server's own address with `https://` — `https://ntfy.sh` for the public one — never a topic's address: ntfy takes the
JSON publish only at its root, and a topic's address would post the JSON as the message text.

E-mail goes straight from the extension to your SMTP server, **encrypted before anything else is sent**: `security:
tls` (usually port 465) speaks TLS from the first byte; `starttls` (usually port 587) sends `EHLO [127.0.0.1]` and
`STARTTLS` in plain text and nothing else — a server that offers no `STARTTLS` gets no password and no address, and
the send ends refused. Then `AUTH PLAIN` (or `LOGIN`), `MAIL FROM` your `from`, `RCPT TO` your one `to`, the message
and `QUIT`. The connection is TLS 1.2 or newer, and its certificates are always verified — against Node's certificate
store, not the operating system's, whatever `NODE_TLS_REJECT_UNAUTHORIZED` says — so a server behind a private
certificate authority fails with a TLS error. SMTP does not go through an HTTP proxy. `EHLO` names `[127.0.0.1]`,
never your machine's name; the `Message-ID` ends in `@token-pace.invalid`; addresses must be ASCII. A refusal shows
the server's reply code (`refused 535`), never its words; a send ends after 30 seconds.

## The diagnostics and the log

*Copy Diagnostics* has a section `## Notifications` — one line per channel, then the events you listed and how many
messages went out this hour:

```text
webhook (slack) · listed yes · secret set · consent yes · last quotaThreshold 12 min ago ok
telegram · listed no · secret not set
ntfy · listed yes · secret set · consent yes · last test 3 h ago HTTP 401
email · listed yes · secret set · consent no (host changed)
events: agentWaiting, agentDone, quotaThreshold, quotaExhausted, paceWarning
sent this hour: 3 of 20
```

It says which notification settings are set, never the host, the addresses, the chat id or the ntfy server — in the
settings snapshot below it too, where those fields read `set` or `not set`. The log (*Token Pace: Show Log*) names a
failed send's kind and status, a skipped channel and, at debug level, a dropped event — never an address, a host, a
secret or a response.
