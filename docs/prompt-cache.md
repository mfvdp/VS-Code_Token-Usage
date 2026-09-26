<!--
SPDX-FileCopyrightText: 2026 Frederik Marx
SPDX-License-Identifier: AGPL-3.0-or-later
-->

# Prompt cache

Part of the [Token Pace documentation](../README.md#documentation).

Claude Code keeps the start of a conversation — the system prompt, the tools, the messages so far
— in Anthropic's prompt cache, so that the next request reads that prefix at a fraction of the
input price instead of writing it again. Its status line reports the state of that cache for the
session it runs for: warm or cold, the time-to-live (5 minutes or 1 hour), when the cached prefix
expires, how much of the input the cache served and — from Claude Code 2.1.251 on, as its
[status-line documentation](https://code.claude.com/docs/en/statusline) states — how many tokens
the next request re-caches if the cache has gone cold by then.

Token Pace watches that cache for every Claude Code session on this machine whose cache has the
one-hour lifetime, and says on the Claude quota card when one is about to go cold — five minutes
before — and what a cold start would cost against a cache read. Two sources describe a session, and
every line says which of them it rests on:

* **measured** — the opt-in [status-line bridge](quota-sources.md#claude-status-line-bridge-opt-in):
  the lifetime, the expiry and the size a cold start re-writes, exactly as Claude Code reports them.
  These figures carry no `~` — only the API amounts do, as every API amount on the page;
* **estimated** — the session's transcript, wherever the status line has not described the session's
  newest request: the time of that request plus one hour, and its size; every figure of that estimate
  carries `~`, and the line says *estimated from the transcript* in words — see
  [How the estimate is made](#how-the-estimate-is-made).

Until 1.7 Token Pace promised that the prompt cache is never estimated; 1.8 gives that promise up for
the watch below. The status line's own prompt-cache line keeps it: that line is the bridge's words and
nothing else ([The status line's own line](#the-status-lines-own-line)).

Off by default and behind a consent of its own, Token Pace can also keep a measured one-hour cache
warm: it types one fixed line into the VS Code terminal that runs the session, after a one-minute
countdown you can cancel — see [Keep-warm in a terminal](#keep-warm-in-a-terminal-opt-in), with
everything it checks and everything it cannot.

## On the Claude card

While no watched session's cache is cooling or cold, the card is the card it was — a warm cache is not
news. From five minutes before a session's one-hour cache expires, the card lists the session after its
windows, in the dim tone, in two lines — its state, and what a cold start would cost:

```
Session Tue 14:20 · 9d0eb37a · prompt cache cools in 4 m 10 s (1 h TTL)
A cold start after 14:52 re-writes 152.3K tokens at the 1 h write rate (2× input, ~$1.22) instead of reading them from the cache (0.05× input, ~$0.03).
```

Once the expiry has passed the lines read `Session Tue 14:20 · 9d0eb37a · prompt cache cold since 14:52
(1 h TTL)` and `The next request re-writes 152.3K tokens at the 1 h write rate (2× input, ~$1.22)
instead of reading them from the cache (0.05× input, ~$0.03).` — for another hour; after that the
session is no longer listed. A session is named as the [Agents](agents.md) section names it — the time
it started and the first eight characters of its id —, so it can be found in the tree; a session the
status line reports and no transcript on this machine belongs to (a remote host, a Claude directory
elsewhere) is named by its id alone, `Session 9d0eb37a`. The Agents section's rows carry no mark of
their own: a session quiet for more than ten minutes sits in the closed group of earlier sessions
exactly when its cache cools.

The state line, word for word, in its six forms — `{0}` the session's name, `{1}` the countdown or,
once cold, the expiry's clock time:

| Phase | Measured (the status line) | Estimated (the transcript) |
|---|---|---|
| warm | `{0} · prompt cache warm · cools in {1} (1 h TTL)` | `{0} · prompt cache warm · cools in ~{1} (1 h TTL, estimated from the transcript)` |
| cooling | `{0} · prompt cache cools in {1} (1 h TTL)` | `{0} · prompt cache cools in ~{1} (1 h TTL, estimated from the transcript)` |
| cold | `{0} · prompt cache cold since {1} (1 h TTL)` | `{0} · prompt cache cold since ~{1} (1 h TTL, estimated from the transcript)` |

The card lists at most three sessions, the most urgent first — the cooling ones by their expiry, then
the cold ones with the most recent first —, and says how many more there are:
`2 more sessions with a cooling or cold prompt cache`. The phase is said in words, never by a colour,
and nothing on the card blinks or calls for attention: the section is rewritten every few seconds
while a line counts down, and it is not announced to a screen reader each time.

## Which sessions are watched

**Only a one-hour cache.** A five-minute cache would be "cooling" a few seconds after every reply; it
keeps the status line's own line. The watch takes a session's one-hour cache from the status line when
it reports `ttl` `1h`, and from the transcript when the newest request that read or wrote the cache
followed a write of the one-hour kind. A session whose kind of cache is not known is not watched —
no lifetime is assumed —, and nothing is inferred from the hit ratio.

**The phases.** With the expiry the status line states, or the transcript's estimate of it, a watched
cache is *warm* until five minutes before the expiry, *cooling* from then until the expiry, and *cold*
for an hour after it; then the session is no longer listed. An expiry more than an hour away — a
transcript dated in the future, a clock ahead of this one — describes no cache now, and is not
watched. The limits are constants of the code, not settings:

| Constant | Value | What it is |
|---|---|---|
| `CACHE_COOLING_LEAD_MS` | 5 minutes | how long before the expiry a one-hour cache counts as cooling |
| `CACHE_COLD_SHOWN_MS` | 60 minutes | how long a cold one-hour cache stays listed after its expiry |
| `CACHE_WATCH_MAX` | 3 | cooling or cold sessions on the card, in the Quick Pick and in a tooltip |
| `CACHE_TEXT_MAX` | 10 | watched sessions in the markdown view, warm ones included |
| `BRIDGE_SKEW_MS` | 10 seconds | how much older than the transcript's newest request a status-line reading may be and still describe it |
| `CODEX_RETENTION_MS` | 30 minutes | how long after a Codex turn the Codex card has its line |

**Which source describes a session.** The status line's reading, while the transcript has counted no
cache request of the session or the status line ran after the newest one (with ten seconds of slack);
otherwise the status line has not run since that request, its reading describes an older turn, and
the transcript's estimate describes the session instead. Nothing is merged: each figure of a line is
the one source's. A reading that calls the cache not warm — the last response reported no cache
tokens — before its stated expiry is not watched, and the transcript does not overrule it: the status
line knows the newest request. One session is never described by another session's reading.

**Open or closed.** Token Pace cannot tell whether a session is still open — it never reads Claude
Code's session keys — so a closed session's cache cools as well, and is listed. The line is true
either way: a cold start after 14:52 is what resuming the session would cost.

**Which kind of cache Claude Code asks for.** This is Claude Code's behaviour, not Token Pace's, as
Claude Code's documentation described it in September 2026 ([prompt caching](https://code.claude.com/docs/en/prompt-caching),
[settings](https://code.claude.com/docs/en/settings-reference#promptcachettl),
[environment variables](https://code.claude.com/docs/en/env-vars)) — check it there for the version you
run. Claude Code requests the one-hour lifetime for the main conversation only on a Claude
subscription within the plan's included usage; usage credits, an API key, Bedrock, Vertex and Foundry
get five minutes, and so do subagents, "even on a subscription". Since Claude Code 2.1.242 the
setting `promptCacheTtl` (`"5m"` or `"1h"`) chooses it for the main conversation and
`subagentPromptCacheTtl` for subagents, workflows, compaction, titles and background work; the
environment variables `CLAUDE_CODE_PROMPT_CACHE_TTL` and `CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL` do
the same, `ENABLE_PROMPT_CACHING_1H=1` asks for one hour in both, and `FORCE_PROMPT_CACHING_5M=1`
overrides everything. Which one a session gets shows in `claude -p "hello" --output-format json`: a
one-hour write puts its tokens in `usage.cache_creation.ephemeral_1h_input_tokens` — the field the
estimate below reads, so the watch follows whatever Claude Code chose.

**Claude Code's own clock.** By its documentation ([VS Code](https://code.claude.com/docs/en/vs-code)),
Claude Code shows a prompt-cache clock in the prompt box of its VS Code panel, counting down from the
cache's lifetime, and `/usage` has a line for the main conversation's cache (Claude Code 2.1.251 and
later). Token Pace adds what those cannot: the warning while Claude Code's panel is closed, several
sessions at once, and the cost of a cold start.

**Several windows.** Each VS Code window keeps its own readings of the status line, and a window that
is not the one reading the transcripts has the sessions' estimates from the shared snapshot — up to
about ten seconds behind the window that is.

## What a cold start would cost

**The tokens** are the status line's `recache_tokens_if_cold` — what the next request re-caches if the
cache has gone cold by then, printed as it is (`152.3K`) — or, estimated, the size of the transcript's
newest request (`~152.3K`): the next request sends that prefix, the last reply and whatever comes
next, so the estimate is too small by construction. A status line that does not report the figure
(before Claude Code 2.1.251) gives no cost line.

**The factors** are the price table's own: the model's 1-hour cache-write rate and its cache-read rate,
each divided by its input rate, for the day — with your `tokenPace.customPrices` merged and
`tokenPace.pricing.multiplier` applied, the same rates every cost of the dashboard is computed with.
From today's table that is 2× and 0.05× for Claude Opus 5.5, 2× and 0.025× for Claude Fable 5.1 and
Mythos 5.1, and 2× and 0.1× for every other Claude model; a changed rate changes the line, because
no factor is written into the code. The model is the one the status line names (`model.id`) or the
one of the transcript's newest request, at its standard rates — the status line's `fast_mode` is not
read.

**The money**, with `tokenPace.showCost` on, is the dashboard's hypothetical API amount: the tokens at
the 1-hour write rate for the cold start, at the read rate for the cache read, each with `~` as every
API amount on the page. It is not a bill. On a subscription both come out of the plan's usage — cache
reads "still draw usage", at a weight Anthropic does not publish — and the line claims nothing about a
quota window. With costs off the line keeps the factors and drops the money.

**No borrowed price.** A model without a price of its own — one the table does not know, or one
priced only through the opt-in family fallback (`tokenPace.unknownModelPricing: family`) — keeps the
words and loses factors and money: `A cold start after 14:52 re-writes 152.3K tokens instead of
reading them from the cache.` Your own prices in `tokenPace.customPrices` are shown, as the dashboard
shows them.

## Where it shows

* **Dashboard** — the Claude quota card, after its windows: each listed session's two lines, then how
  many more there are, then the status line's own line when its session is not listed. Only while the
  provider switch shows the Claude card — `Claude Code` or `All`.
* **Markdown view** (*Show Usage as Text*) — under the Claude card, every watched session, warm
  ones too, at most ten: the state as a list item, the cost line under it; then how many cooling or
  cold ones the list leaves out. It follows the provider switch, as the Quick Pick does.
* **Quick Pick** (*Show Usage (Quick Pick)*) — in the quota group after the Claude windows: one item
  per line of the card, the state as its label and the cost as its description, then the count of the
  rest.
* **Status bar** — the Claude quota item's tooltip lists the card's lines, at most three, each its state
  and its cost, then the count of the rest; the status line's own row stands after them for a session
  they do not list. The opt-in entry `cache` in `tokenPace.statusBar.show` (not in the default) shows
  only while a watched cache is cooling — its last five minutes: `$(watch) cache 4m`, `$(watch) cache
  ~4m` for an estimate, `45s` under a minute, `+1` for each further session cooling; hidden while none is
  cooling. It has no colour and no alarm, and a screen reader hears it
  in words: `Prompt cache of Session Tue 14:20 · 9d0eb37a cools in 4 m 10 s`. Its tooltip lists the
  cooling sessions with their cost lines ([Status bar](status-bar.md)). Neither follows the dashboard's
  provider switch: the bar shows the same under every view.
* *Copy Usage Summary*, the exports, *Copy Diagnostics* and the data-quality section say nothing of
  it: a cooling cache is a moment, not a record.

## The status line's own line

With the bridge connected the Claude card also keeps the line it has had since 1.3, for the session
the status line last wrote about — warm or cold, the expiry countdown with the lifetime, the hit ratio,
a `–` for every part the report did not carry: `prompt cache warm · expires in 3 m 40 s (1 h TTL) · hit
ratio 87 %`. It is measured, never estimated. For a session the card lists as cooling or cold the
listed lines replace it — one line per session, on the card, in a tooltip and in the Quick Pick; the
markdown view, which lists warm sessions too, prints it only for a session it does not list. A
five-minute cache, a reading without a session id and a warm one-hour cache keep it.

## Codex

The Codex card ends, for 30 minutes after the newest Codex turn and only for GPT-5.6 and later and
GPT-6, with one line:

```
Codex prompt cache · last request at 14:22 · OpenAI keeps a cached prompt prefix at least 30 minutes after its last use for GPT-5.6 and later — ~until 14:52, perhaps longer.
```

OpenAI documents that minimum for its API — "A cached prefix remains eligible for reuse for 30
minutes after its most recent write or reuse, though OpenAI may retain it longer" —; whether it
holds for Codex on a ChatGPT plan is not documented, hence the `~`. It is a minimum, not an expiry:
the line has no countdown, no cooling and no cold, and no cost — a cold Codex prompt costs the plain
input rate, and OpenAI charges no cache write. Earlier models (GPT-5.5 and before) state no such
minimum and get no line; a forked rollout's turns are its parent's history and move nothing, and a
turn dated more than ten seconds after now — written by a clock ahead of this one — gives no line
either. Nothing is said per Codex session, nothing appears in the status bar, and the markdown view
and the Quick Pick carry the same line under the Codex card.

## Keep-warm in a terminal (opt-in)

Off by default. With `tokenPace.cacheKeepWarm` switched on and your consent given, Token Pace keeps
a Claude Code session's one-hour prompt cache warm by typing one fixed line into the VS Code terminal
that runs the session and pressing Enter — `Ignore this message. No action. No response.` — so that
Claude Code itself sends a request that reads the cache before it expires. Claude Code sends it with
its own login; Token Pace reads no credential and sends nothing over the network. That a request
which reads the cache gives the entry a new lifetime is Anthropic's rule, not something Token Pace
measures: the status line's next reading shows the new expiry, and nothing checks it. It is the one thing
Token Pace ever does on its own, and it does it only while every check below holds — once when a
one-minute countdown starts in the status bar, and all of them again when the countdown ends:

1. **Switched on and allowed** — the setting is on, you allowed it in its consent dialog, and the
   workspace is trusted: never in Restricted Mode.
2. **Measured, never estimated** — the [status-line bridge](quota-sources.md#claude-status-line-bridge-opt-in)
   reports the session's cache: a one-hour cache, warm, with the time it expires. A session only the
   transcript's estimate (`~`) describes never gets a line.
3. **Three minutes or less** — the countdown starts once the cache has 3 minutes or less of warmth
   left, so the line goes at about 2 minutes left, and never within the last minute before the
   expiry: a window that was asleep at that moment sends nothing late, and a countdown that could not
   end in time does not start. The cooling warning on the card still starts at 5 minutes.
4. **The session is idle** — its newest reply is at least a minute old and ended its turn
   (`end_turn`), and nothing of the user's came after it. A prompt or a tool result as the newest
   message line means Claude Code is still at the reply, or waits in a permission dialog or a
   question: Claude Code writes a reply that calls a tool only once the tool has finished, so while
   such a dialog stands open the transcript's newest line is the user's. A reply that stopped for a
   tool, was cut off, or paused is no idle turn either. A local command such as `/usage` or `/cost`
   leaves a line of yours newest as well, so after one no line goes until the session's next real
   reply. Of these lines only their kind is read, never what they say.
5. **No agent running** — no subagent of the session is in the running list; its end could wake the
   conversation at any moment.
6. **No permission request** — with the [agent hook](agents.md#the-agent-hook) installed, no
   permission request of the session after its newest reply. A wait for input passes: after a
   finished turn it is Claude Code's idle prompt.
7. **Exactly one terminal** — exactly one terminal of this window runs `claude` (a path ending in it,
   or `claude.exe`), as VS Code's shell integration reports it with medium or high confidence, in the
   folder the session's transcript belongs to. Claude Code in the Claude Code extension's own panel —
   its default — is out of reach: such a session gets the warning, never a line. A terminal without
   shell integration says nothing, and two candidates are one too many. The terminal's name, its
   output and its environment are never read.
8. **Not touched since** — that terminal has not been the active terminal of the focused window since
   the session's newest reply: keys reach Claude Code's input line only through it. So the line goes
   only when you left the Claude terminal — another terminal active, or the window unfocused — before
   its newest reply ended: the unattended finish keep-warm is for. A terminal counts as touched while
   it is the active one of the focused window even when the keyboard is in the editor. A window that
   began to watch after that reply — opened, or with the setting switched on, since — cannot know, and
   sends nothing.
9. **At most 3 lines in a row** per idle phase of the session — at most about three hours more of
   cache, if each line refreshes it; a request of your own starts a new phase.
10. **Not near a limit** — no Claude quota window at 90 % or more, or reached. Without a quota reading
    this check does not block.
11. **The last line was answered** — by a request of the session within 2 minutes; otherwise
    keep-warm stops for the rest of the idle phase.
12. **Not cancelled** — a click on the countdown cancels the line and keep-warm for the rest of the
    idle phase.
13. **The terminal's own session** — a terminal is known by its folder, not by the session in it, so
    the session has to be the one that terminal's `claude` began: its first reply came after VS Code
    reported the start of that `claude`, and no other session of the same folder began later. A session
    begun before — one resumed there with `claude --resume` — never gets a line. And every other
    session of the folder has to be idle as checks 4 and 5 measure it — its newest reply at least a
    minute old and finished, nothing of the user's after it, no agent of it running —, so that a line
    that reached another session could not land in a reply under way or in an open dialog. Another
    session of the same folder no longer holds the line back once it has been left behind: no agent of
    it running, and its newest line at least 2 hours old and older than the moment the terminal's
    `claude` started — a prompt that never got its reply, an interrupted reply, a window closed
    mid-turn. In 1.8 such a session held the folder back for as long as its transcript was kept, seven
    days. A reply under way or an open dialog lives in the Claude Code that wrote the session's newest
    line, and a line written before this terminal's `claude` started cannot be that one's — so the line
    cannot land in that session's dialog even where the terminal runs it. That is an inference, not a
    rule Claude Code documents, and the two hours stand behind it: a session that wrote a line in the
    last two hours is never passed over, whichever Claude Code wrote it. Its newest line is the later
    of its newest reply and its newest `user` line; when the user's line is the newest and its time is
    not known, the session is not passed over. A session this terminal's own `claude` wrote to — a turn
    you interrupted there before `/clear` or before starting another session in it — is never left
    behind: it holds the line back until it has finished its turn or that terminal's `claude` is
    started again.
14. **Not while the transcripts are read** (1.10) — while Token Pace reads the transcripts from the
    start (the first scan after the window opened, or a re-read) or reads them once more for the
    Agents tables (the replay after an update), no countdown starts and none ends with its line. The
    other checks read the sessions' records, and those are being rebuilt then: a session that is read
    again is missing until its file has been read, so check 13 could pass a folder whose other session
    is at work. This check runs right after check 1, at both moments; it stands last only because it
    came last. It lasts as long as the reading does, and only the log names it (`reading`).

**What no check can see.** Token Pace cannot read Claude Code's input line: **text you typed there
and did not send is sent together with the line** — type nothing into the Claude terminal while the
countdown runs. This was seen, not inferred: a half-typed draft and the line went out as one message.
No interface of VS Code reads a terminal's input, so no check can find a draft; the countdown and its
cancel are the only protection, and the focus check (8) keeps the line from any terminal you were in
since the reply. It cannot see a dialog the transcript does not show either. The terminal is
recognised by its folder and the session in it by time (check 13); what time cannot tell apart is a
terminal whose `claude` started before the session's first reply but which now runs another, older
session of the same folder — one picked there with `/resume`, or one begun in it before the session
was started elsewhere, in another window or in the panel. That session gets the line only while it
is idle by check 13's measure or left behind by it, and it costs that session one request; a menu or
picker open in that terminal is not seen by any check, and a session left behind there may get the
line after a prompt it never answered. Its answer is not the watched session's, so check 11 then
stops keep-warm after that one line. A session
in the Claude Code extension's own panel gets the cooling warning and never a line.

**The countdown.** When the checks hold, a status-bar item of its own appears, whatever
`tokenPace.statusBar.show` lists — a line is never typed without it on screen: `$(watch) keep warm
in 42 s · cancel`, counting down each second from 60, with no colour and no alarm. Its tooltip says
what will be typed where — `Token Pace will type “Ignore this message. No action. No response.” into
the terminal that runs Session Tue 14:20 · 9d0eb37a and press Enter, so that its prompt cache stays
warm. Click to cancel.` —, and a screen reader hears `Keep-warm line for Session Tue 14:20 · 9d0eb37a
in 42 seconds, press to cancel`. **A click cancels** the line and keep-warm for the rest of the
session's idle phase, and so does *Token Pace: Cancel the Keep-Warm Line*. At zero every check runs
again with the facts of that moment; only if all still hold does the line go, into the terminal the
countdown was started for, and the item reads `$(watch) keep-warm line sent` for 10 seconds. Every
line is logged — `keep-warm: line sent to the terminal of session 9d0eb37a; the cache expires at
14:57` —, and so is its answer or the lack of one. One countdown at a time per window, and a window
starts one only for the session its own Claude terminal began (checks 7 and 13): of two windows with
a Claude terminal in the same folder, one whose `claude` started after the session's first reply
never does.

**A prompt of your own** (1.10). When you send a prompt from the dashboard's [Prompts](prompts.md)
section into the terminal a countdown runs for, the countdown ends without its line — your request is on
its way, and a line typed on top of it would be a second one into a busy input line — and keep-warm stops
for the rest of that session's idle phase, as a click on the countdown stops it: a prompt that answered a
dialog or never became a request is not followed by a fresh countdown. The log says `keep-warm: not sent
(a prompt was typed into its terminal)`; the reply to your prompt, a request of the session, starts a new
idle phase. A countdown for another terminal goes on. The Prompts section's *Keep the cache warm* prompt
types this very line by hand, as your own request: it is not counted in `keepwarm.json`. The `/loop`
variant — the line with `/loop 30m` in front, which Claude Code repeats every 30 minutes by itself — is
a prompt you can make of it there ([Prompts](prompts.md#sending)).

**On the Claude card**, under the session's lines: `Keep-warm line for this session in 42 s — cancel
it in the status bar.` while a countdown runs; `Keep-warm cannot reach this session: it does not run
in a VS Code terminal of this window.` for a cooling session the status line measures and no terminal
of this window runs — the panel's sessions among them —; `Keep-warm stopped for this session: the
last line got no answer within two minutes.` after check 11 stopped it. Every other reason is a line
of the log only — at the end of a countdown always, before one with `tokenPace.debug` on;
[Troubleshooting](troubleshooting.md#no-keep-warm-line-was-sent) names each in words.

**Counted apart.** A line answered by a request of the session — its first line within two minutes
of the line — counts one request, and the billable tokens of that answer (fresh input, cache write
and output, the dashboard's usage), towards today in `keepwarm.json`, in the extension's storage:
per local day the number of answered lines and their tokens, 31 days at most, never a session, a
path, a time of day or a terminal. The Claude card shows today's under its prompt-cache block,
`Keep-warm requests today: 2 · 64 tokens`, and so does the markdown view — a record of the day, so
also after the setting was switched off; nothing else does. A line that is not answered is not
counted: it is logged, and it ends keep-warm for the idle phase. *Clear Stored Data…* deletes the
file.

**Switching it on and off.** `tokenPace.cacheKeepWarm` is a setting of the application scope: a
workspace's `.vscode/settings.json`, which a cloned repository brings along, cannot switch it on.
Switching it on asks for consent — a modal warning that names what is typed, when, what it costs,
the draft that is sent with it, the panel out of reach and the terms passage below; only *Allow
keep-warm* allows it. A refusal is kept: the question comes again only when you switch the setting
off and on. Switching it off withdraws the consent, ends a countdown under way without its line, and
stops Token Pace listening to the terminals for it — the window listens on only while the dashboard
lists the [Prompts](prompts.md#which-terminal) section in a trusted workspace. A window in the background asks when it is
focused. A Claude Code session started before the setting was on — or before the window opened or
was reloaded — is not seen until Claude Code is started again in its terminal: the shell integration
reports a command when it starts (one started while the window already listened for the Prompts
section is seen). In Restricted Mode no terminal is listened to and no line goes; the
consent can still be asked there, and it acts only once the workspace is trusted.

**The terms.** Anthropic's [Consumer Terms](https://www.anthropic.com/legal/consumer-terms), section
3, list among what may not be done: “Except when you are accessing our Services via an Anthropic API
Key or where we otherwise explicitly permit it, to access the Services through automated or
non-human means, whether through a bot, script, or otherwise.” A timer in Token Pace that types into
Claude Code's terminal is automated access of that kind, and Anthropic has not explicitly permitted
it; the consent dialog says so, and quotes the passage in English in every language. This page gives
no legal advice: it is a grey zone, and only Anthropic can say otherwise. Every line is also a real
request — on a subscription it counts against your usage limits.

**What is read and typed.** For the keep-warm line — while the setting is on and allowed, and never
otherwise — Token Pace takes of VS Code's shell integration: of its events `onDidStartTerminalShellExecution` and
`onDidEndTerminalShellExecution` the `terminal` and the `execution`; of an execution that has not
ended its `commandLine` — `value` and `confidence` — and its `cwd` (`fsPath`), tested when a check
runs and kept by no one; of a terminal its `state`, VS Code's `shell` for it. It writes one thing into
a terminal: `sendText` with the fixed line and Enter. It reads back `keepwarm.json` by its shape — `v`,
`days`, and per day `requests` and `tokens`. [Privacy](privacy.md) lists the same, and the read
contract of `npm run check:privacy` holds both pages to it. Since 1.10 one watch of the window's
terminals holds these facts for the keep-warm line and for the Prompts section alike; it listens while
either may use them, and to nothing otherwise.

The limits are constants of the code, not settings:

| Constant | Value | What it is |
|---|---|---|
| `KEEPWARM_LEAD_MS` | 3 minutes | how close to the stated expiry the countdown may start |
| `KEEPWARM_COUNTDOWN_MS` | 60 seconds | the visible countdown before every line |
| `KEEPWARM_SEND_MARGIN_MS` | 60 seconds | how long before the expiry the line goes at the latest |
| `KEEPWARM_IDLE_MIN_MS` | 60 seconds | how old the session's newest reply must be |
| `KEEPWARM_VERIFY_MS` | 2 minutes | how soon a request of the session must answer a line |
| `KEEPWARM_MAX_PER_IDLE` | 3 | lines per idle phase of a session |
| `KEEPWARM_QUOTA_STOP_PERCENT` | 90 % | the quota window share from which no line goes |
| `KEEPWARM_SIBLING_LEFT_MS` | 2 hours | how old another session's newest line must be — and older than the terminal's `claude` — for that session to count as left behind (check 13) |
| `KEEPWARM_SENT_SHOWN_MS` | 10 seconds | how long the item says the line was sent |
| `KEEPWARM_VERIFY_GRACE_MS` | 15 seconds | how much longer a window waits for an answer to be counted before it calls the line unanswered |
| `KEEPWARM_DAYS_KEPT` | 31 | days of `keepwarm.json` |

## One reading per session

The bridge's mirror holds one session at a time: the one whose status line ran last. Since 1.8
Token Pace keeps in memory the newest reading of every session the mirror named since the window
opened, by the session's `session_id`, so that one session's prompt cache is never taken for
another's: at most 16 sessions — the oldest reading goes first —, none whose reading is older than
two hours, and an older reading of a session never replaces a newer one. A reading without a
session id (a Claude Code build that does not send one, or an id outside the alphabet below) is not
kept per session. Nothing of it is stored: after a reload a session is back with its next
status-line run, and *Clear Stored Data…* forgets the readings together with the mirror. Two
sessions writing the mirror within 300 ms of each other lose the older write; that session's next
run brings it back.

## What is read

The bridge's script receives the whole status JSON from Claude Code and, since 1.8, writes of it
into `statusline-mirror.json` in the extension's storage only the fields listed here — everything
else is dropped before the file is written (1.3 to 1.7 kept the payload whole; see
[Privacy](privacy.md)). Token Pace reads of that file:

* the envelope the script writes around the payload: `schema_version`, `written_at` and `payload`;
* `session_id` — whose cache it is (1.8). Only an id of letters, digits, `_` and `-`, at most 64
  characters, is taken; anything else counts as no id. It is never shown whole;
* `model`: its `id` and its `display_name`;
* `plan` or `subscription`: a name, or the `name`, `display_name` or `type` of an object;
* `rate_limits`: of `five_hour`, `seven_day` and `spend_limit` the `used_percentage` (or
  `utilization`) and the `resets_at`;
* `context_window`: `total_input_tokens`, `total_output_tokens`, `context_window_size` and
  `used_percentage`;
* `cost`: its `total_cost_usd` and nothing else of it;
* `prompt_cache`: `warm`, `ttl`, `expires_at`, `hit_ratio` and — 1.8 — `recache_tokens_if_cold`, the
  size a cold start would re-write: a whole count from 0 to 10 000 000, anything else counts as no
  figure.

Each field is taken in camelCase too, as Claude Code builds have spelled them: `sessionId`,
`rateLimits`, `fiveHour`, `sevenDay`, `spendLimit`, `usedPercentage`, `resetsAt`, `contextWindow`,
`totalInputTokens`, `totalOutputTokens`, `contextWindowSize`, `totalCostUsd`, `displayName`,
`promptCache`, `expiresAt`, `hitRatio` and `recacheTokensIfCold`.

Never read, and since 1.8 never in the mirror: `session_name` (the session's AI-generated title),
`prompt_id`, `transcript_path`, `cwd`, `workspace`, `pr`, `worktree`, `agent`, `version`,
`output_style`, `vim`, `effort`, `thinking`, `fast_mode`, `exceeds_200k_tokens`, the rest of `cost`,
and of `prompt_cache` its `caching_observed`, `requests`, `misses`, `expected_rebuilds`,
`cache_write_tokens`, `miss_recache_tokens`, `last_miss_at`, `last_miss_cause` and `miss_causes`.

The read contract of `npm run check:privacy` lists these fields reader by reader, and the check
fails when the reader takes one more or no longer takes one of them; the documentation tests hold
this page and [Privacy](privacy.md) to the same list, and a test ties the script's list of kept
keys to it. Nothing of the mirror is logged or exported.

## How the estimate is made

The transcript of a Claude Code session says when each request went out and what it did with the
prompt cache, in the token counts Token Pace reads anyway. For every main session — never an
agent's transcript: a subagent has a prefix of its own and, by default, the 5-minute cache — Token
Pace keeps its newest request that read or wrote the cache, that is, the newest counted reply whose
`usage` shows `cache_creation_input_tokens` or `cache_read_input_tokens` above zero:

* **when** — the `timestamp` of the reply's first line, the earliest moment the transcript knows of
  the request;
* **which cache** — 1 hour when the reply wrote `ephemeral_1h_input_tokens` (in
  `usage.cache_creation`), 5 minutes when it wrote only the 5-minute kind; a reply that only read
  keeps the kind of the write before it, because reading an entry refreshes it; before the
  session's first write there is no kind, and nothing is estimated;
* **how large** — `input_tokens` + `cache_creation_input_tokens` + `cache_read_input_tokens` +
  `output_tokens` of that reply, each the largest its lines showed: about the prefix the next request
  sends, which is why the size is an estimate as well;
* **which model** — its `message.model`, letters, digits and `_.:@/-`, at most 64 characters, or
  none.

A later line of the same reply grows its size and keeps its time; a late line of an older reply
changes nothing; an error line and a placeholder reply are no requests. Two further facts are kept
with it, for the checks of the opt-in [keep-warm line](#keep-warm-in-a-terminal-opt-in) rather than
for the estimate: the reply's `stop_reason` — one of `end_turn`, `tool_use`, `max_tokens`,
`stop_sequence`, `pause_turn` and `refusal`; any other value counts as none — and whether the
transcript's newest message line is the user's, a prompt or a tool result. Claude Code writes a
reply that calls a tool only once the tool has finished, so while a permission dialog or a question
stands open the newest line is the user's. Only a line's top-level `type` decides — a user line is
recognised on the raw line and never parsed for it —, and lines that are no message (attachments,
system lines, file-history snapshots, the session's title and mode lines) do not count.

Since 1.9 one more fact is kept, for the keep-warm line's check of the other sessions of a folder
(check 13) and nothing else: the time of the transcript's newest `user` line — a prompt or a tool
result —, its top-level `timestamp`, matched on the raw line, which is never parsed for it. Only an
unescaped `"timestamp":"…Z"` key matches, so a prompt or a tool's output that spells the key out
does not; of several on one line (a tool's result nests some) the latest counts, so a nested one can
only make the session look newer, never older. Nothing else of that line is read — not its text, not
its ids —, and the time is never shown, logged or exported.

Apart from that one `timestamp`, no field is read for any of it that the token count did not read
before. It is kept with the session's record in the token snapshot for seven days, never logged and
never exported, and the first start of 1.8 rebuilds the agent tables once so that the sessions already
read have it at once — and the first start of 1.9 once more, for the time of the newest `user` line
([Counting](counting.md)).

**The estimated expiry** is that time plus one hour, for a 1-hour cache. It errs in both directions,
which is why it carries `~`: the API counts an entry's lifetime from the start of the request that
writes or reads it, not from the end of its response, and the transcript records when Claude Code
wrote the reply's first line, after the request began — so the estimate runs late by the time the
model took to start its reply; a request that read the cache without writing a line to the transcript
would make it early.

**Codex.** Of the Codex rollouts Token Pace keeps one value for the whole machine: the time and the
model of the newest counted turn of a rollout that is not a fork — the `timestamp` of its
`token_count` event and the `model` its `turn_context` named (letters, digits and `_.:@/-`, at most
64 characters; a turn without such a model keeps nothing) — for the Codex prompt-cache line. It is
kept in the token snapshot and not rebuilt after the update: that line speaks of the last 30 minutes
only, which the next turn fills.
