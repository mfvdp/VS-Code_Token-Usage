<!--
SPDX-FileCopyrightText: 2026 Frederik Marx
SPDX-License-Identifier: AGPL-3.0-or-later
-->

# Agents

Part of the [Token Pace documentation](../README.md#documentation).

The `agents` section of the [dashboard](dashboard.md) shows the Claude Code sessions of the
last **7 days** as a tree: each session, the workflow runs inside it, the agents it spawned and
the agents those spawned in turn — with the state of every node, what it used and how long it
took. Above the tree, the first thing in the section, a list names the agents that are running
right now, so you do not have to look for them in the tree; the tree itself starts closed, with
only the sessions showing. It is on by default, directly after `quota` in
`tokenPace.dashboard.sections`; a list you have set yourself is kept as it is, so there the
section appears once you add `agents` to it. The range, provider and model chips do not apply:
the section is always the last seven days, so the filter bar stays below it. *Show Usage as
Text* prints the running list and then the whole tree as indented lists — every node open, at
most 50 children each (see [Opening and selection](#opening-and-selection)) — with the open
node's details as a table; the Quick Pick does not carry them.

Claude Code only. Codex writes no agent identity into its transcripts, and the section states
nothing about Codex.

## Running now

The list above the tree — `Running now (3)` — holds every agent and every launch whose state is
**running** (see [States](#states)): an agent that replied, or was launched, within the last ten
minutes and has no recorded result — a launch whose transcript has not appeared yet included —
and an agent that runs only because an agent it launched runs. The agents of a workflow run
without a counted reply are one row for all of them, their run's
[collector](#agents-without-a-counted-reply), while one of them runs — never a row each — and
that row says how many of them run: `~10 of them running`. The heading counts the running agents,
so a collector's count is in it: two rows, one agent and a collector with ten running, read
`Running now (11)` — the same number the sessions' [tallies](#the-tally) give. An attempt a later
one superseded is not listed: the tally counts it as retried. It is taken from every session
of the last seven days — those the tree does not list any more, the nodes inside a closed branch
and those past the fifty children an opened node shows, included — so nothing that runs is
missing from it because the tree is closed or full. Running is an inferred state, and every
row's glyph says so, as the tree's do.

**Order and cap.** The longest-running first: by the time of the agent's first line, or of the
launch, the earliest on top; two that started at the same moment keep a fixed order. The list
holds at most **20** running agents; the rest are counted under it (`and 3 more`). A collector is
one row of them however many of its agents run, and sorts by the first line of the earliest of
its agents that has a transcript — last when none has.

**Each row** is the running glyph, the agent's name as the tree writes it, a live
`running for 12 min 05 s` counted from its first line (from the launch, for a launch; for a
collector from the first line of the earliest of its agents that has a transcript, and no clock
when none has), its usage — `–` for a launch and a collector, since nothing of them was counted —,
`silent for 4 min` once the agent has not written for a while, as on its tree row (see
[The tree](#the-tree)), and under them where it sits:
`Session 9d0eb37a · Workflow cfe7718d`, with the session's project after it while
`tokenPace.attribution` names one. An agent that runs only because an agent below it runs — the
parent waiting for its child — says so on that line: `waits for a child agent`.

**A click on a row** opens the same details a click on its tree row opens — under the row you
clicked, here the running list's — and the same click again closes them. It opens nothing in the
tree: the panel shows whether the node's tree row is on screen or inside a closed branch — or in
a session the tree does not list, for as long as the agent runs and the list names it (see
[Opening and selection](#opening-and-selection)). The rows are buttons ahead of the tree, so the
keyboard reaches them first.

With nothing running, the list is one line — `No agent is running.` — with no heading. The
markdown report prints the list under `### Running now`, one line per agent — `[~Running]`
first, as the tree's lines mark an inferred state, then its name, where it sits and its usage,
`⚠` behind a usage that is a lower bound, `(waiting)` behind a waiting one and
`(~10 of them running)` behind a collector — and heads the tree after it with
`### Sessions and agents`.

## The tree

**Sessions** are the roots, the most recent first. A session is listed when its own transcript
recorded a response within the last 24 hours, or when it has an agent or a launch from the last
seven days, or a workflow run whose journal changed in them. At most **20** sessions are listed; the rest are counted under the tree
(`3 older session(s) not shown.`). A session is labelled with the first eight characters of its
id (`Session 9d0eb37a`), and with its project beside it while `tokenPace.attribution` is
`project` or `session` — the label the Sessions table shows, hashed too under
`showProjectNames: hash`. With `attribution: none` no project is named anywhere in the tree.

**Closed by default.** Only the sessions show until you open one; an opened node shows its
children closed in turn. Each session says beside its name what its agents came to — its
[tally](#the-tally), `12 started · 3 ✓ · 1 ✕ · 2 ↻ · 1 ■ · ~4 ● · ~1 ?` — so a closed session
already tells a run that went well from one that did not. A run whose agents no transcript shows
has nothing to open: it has no toggle, and its tally still says what is below it. What you open
stays open (see [Opening and selection](#opening-and-selection)).

**Below a session** come its workflow runs (`Workflow cfe7718d`) and its agents, each agent
under the agent that launched it when that one is in the same tree, otherwise directly under the
session; the agents of a run stay inside their run. Siblings are ordered by when they started. A
launch whose transcript has not appeared yet is a node of its own, in italics and named from the
launch — `Plan · sonnet · launched` — with no figures beside it, since nothing was counted. A
workflow run is a node from the moment its session launched it, before any agent of it has
written: with `–` for its figures and nothing to open until one does. A run's agents without a
counted reply are one node, the run's last child: its
[collector](#agents-without-a-counted-reply).
No agent sits more than **6** levels below its session: one that would sit deeper moves up, it
is never dropped.

**Fifty at a time.** An opened node shows at most **50** of its children at a time, in the
order above. When it has more, a line after the last one says so — `50 more · 377 not shown`,
or `12 more` when the next fifty are the rest — and a click on it, or `Enter`, shows the next
fifty. A node takes that step at most **10** times, so it shows up to 550 of its children; past
that the line only counts the rest, `377 not shown`. Always among those shown, each taking the
place of the last one that is not: every child that is running, the one on the way to the node
whose details are open, and a run's collector, which stays its last child — so the open node's
row is never left out, nor a running agent's, nor the row that counts the run's agents without a
counted reply. When those alone are more than fifty, the way to the open node comes first, then
the collector, then the running children.

**Only what is open goes to the page.** A closed node's children are not sent to it at all: only
whether it has any, how many, and what the agents below it came to. A large run closed is one
row: a run of 427 agents made a section of 77.8 KB while every node went to the page, and its
session closed is well under 1 KB. One push of the section holds at most **2000** nodes, a
safety cap that only many opened nodes
of fifty children each reach: it is filled with the path to the node whose details are open and
the running agents first, then in the order the page draws the tree, and an opened node whose
children no longer fit shows none of them and says how many it has (`377 not shown`).

**Each row** is the state glyph, the name, the usage — fresh input + cache write + output, the
definition the tables use — and the duration from the first line to the last. A **session's** row
names its two figures — `own 12.0M · agents 137.4M · 22 d 11 h`: what its own transcript used,
counted from its first line, and what its agents of the last seven days used. The two are never
added: they cover different spans, a session's own transcript often weeks, its agents the seven
days the tree keeps. A session without agents shows no agents figure. The last figure is the
session's span from its first line to its last (its title says so), written in days and hours
from **48 hours** on — the hours floored, so `22 d 11 h` for a session of 22 days, 11 hours and
59 minutes — and as a duration below that. A row carries no
lower-bound mark; the details do, with the numbers — `Output` `4.1K ⚠ lower bound — 2 of 41
replies unfinished` (see [Why the output is a lower bound](#details)). A running node also says for how long:
`running for 12 min 05 s`, counted from its first line and ticking every second. A running
agent whose transcript has not changed for **3 minutes** says that too, after its figures —
`silent for 4 min`, in whole minutes, then `1 h 05 min` — in the same quiet tone as the figures,
from the page's own clock: it appears the second the three minutes are up, with no push, and goes
again with the agent's next line. A pause of a minute or two is an ordinary tool call; after three
minutes the reader may want to look. It changes no state — the agent stays running until ten
minutes have passed — and an agent that runs only because an agent it launched runs, or a launch,
never says it: they have no line of their own to be silent in. An agent's name
is its type, its model and its short id — `Explore · claude-opus-5 · 94f3`. The type is the one
the agent's sidecar names, else the one its launch asked for, else `Agent`; the model is the last
one its transcript recorded, else the alias the sidecar or the launch names, else `–`. The **short
id** is the start of the agent's id that no other agent of the same session starts with — the
agents a run's journal names without a transcript included, since a sentence may name one — at
least **4** characters long: Claude Code's ids are `a` and 16 hex digits, and the `a`, which
every one of them carries, is left off. Four characters keep nearly every agent apart; where two
agents of a session share them, both names carry as many as it takes — measured over a week on one
machine, 917 of 925 agents needed four and 8 needed five. The whole id is in the details. An
agent's usage is part of the figures the totals already contain: the tree adds nothing to any sum.

### The tally

A session, a workflow run, a run's [collector](#agents-without-a-counted-reply) — of its own
members — and an agent that launched agents of its own carry the **tally** of
every agent below them — at any depth, on the whole tree, also the ones inside a closed branch
or past a node's first fifty, and the agents a workflow run's journal started whose transcript
was never counted (see [States](#states)) — and every launch whose transcript has not appeared
yet:

| Part | Counts |
|---|---|
| `12 started` | every agent and launch below the node, each attempt once — the only total |
| `3 ✓` | done |
| `1 ✕` | failed, and not retried: a final failure |
| `2 ↻` | retried: every attempt the workflow journal started its step again after, whatever its own state — a failure that was retried, an attempt that was replaced, a completed step that was run again |
| `1 ■` | stopped, and not replaced: a stop nothing followed |
| `~4 ●` | running |
| `~1 ?` | unknown |

Every agent counts once and in exactly one part, so the parts after `started` add up to it, and a
part with no agent in it is left out. Running and unknown are inferred, so their counts carry the
`~` every estimate on the page carries; done, failed, retried and stopped are what was recorded.
There is no "x of y": `started` is the one total. A screen reader gets the same in words —
*12 started, 3 done, 1 failed, 2 retried, 1 stopped, about 4 running, about 1 unknown* — in place
of the glyphs.

A session's and a run's tally stand beside the name whether the node is open or closed: what
failed, was retried or is still unknown among a few hundred agents is not something to count off
the rows. An agent's stands only while it is closed; open, its children are on screen with their
own glyphs. A node with no agent below it — a session that started none, an agent that launched
none, a launch — has no tally, rather than a `0 started`. The markdown report prints a node's
tally after its name in brackets, on every node that has one:
`[~Running] Workflow cfe7718d (8 started · 3 ✓ · 1 ✕ · 2 ↻ · ~2 ●) · 1.2M · 4 min 10 s`. It prints
every node, open on the dashboard or not, at most 50 children each, and one line at their depth
for the rest: `… 377 more`.

### Agents without a counted reply

A workflow run can start hundreds of agents that never write a reply that could be counted: the
run's journal started them, but no transcript of theirs was read, or their transcript holds
nothing but requests the API rejected (see [States](#states)) — a run that hit a usage limit
leaves many of them. Each is a member of its run, but none has a figure to show, and a row each
would bury the agents that did the work. So they are **counted, not listed**: one node, the
**collector**, the last child of its run, stands for all of them —
`263 agent(s) without a counted reply`, or `3 agent(s) failed before their first reply` when every
one of them failed. It has no toggle and no children; its figures are `–`, never a `0`; beside its
label stands its [tally](#the-tally), and its state is its members', by the rule a run's state
follows (see [States](#states)). An agent of a run whose transcript holds only rejected requests
is kept from its first one on, with nothing counted; its first counted reply moves it out of the
collector into a row of its own. An agent outside a run whose transcript holds only rejected
requests keeps a row of its own — there are few — with `–` for its figures and the sentence that
names the rejection. The collector's members count in the run's `Agents` row, in the tally of the
run and of the session, and in the number of running agents the running list's heading and the
agent poll go by; while one of them runs, the running list has one row for all of them. The
markdown report prints the collector as one line under its run:
`[~Running] 263 agent(s) without a counted reply (263 started · 250 ✓ · 3 ✕ · ~10 ●) · – · –`.

## States

| Glyph | State | Kind | When |
|---|---|---|---|
| ✓ | done | recorded | the parent's tool result or task notification says `completed`, or the workflow run's journal holds a result for the agent |
| ✕ | failed | recorded | the parent recorded `failed`, `error` or `timeout`, or the workflow run's journal recorded a failure for the agent |
| ■ | stopped | recorded | the parent recorded `killed`, `cancelled` or `stopped` — an end, but not a failure — or the run's journal started the agent's step again before the agent recorded anything: it was replaced |
| ● | running | derived | nothing was recorded yet, and the agent replied — or was launched — within the last **10 minutes**, or an agent it launched is running |
| ? | unknown | derived | nothing was recorded, and the agent has been silent for longer than that |
| ● | active | derived | a session whose own transcript recorded a response within the last 10 minutes, or one of whose agents is running |
| ○ | idle | derived | a session silent for longer than that, with no agent running |

**An agent that wrote on after its outcome.** When the parent recorded an agent's end at a time,
and the agent's transcript changed more than **60 seconds** after it, the outcome no longer
decides the state: the agent went on — resumed, or the end was recorded for an earlier turn — and
its state is inferred from its lines again, running within ten minutes of its last line, unknown
after that. Its details keep what was recorded in a row of their own, `Recorded` —
`done at 14:20`. A line within that minute is the tail of the same reply and changes nothing. The
workflow journal's result carries no time, so it is never outlived.

**Stopped is not failed.** A stop the parent recorded — Claude Code writes `killed`, `cancelled`
or `stopped` for an agent that was halted — is an end of its own: `■`, in the dim tone, and its
sentence quotes the parent's word as it was written, `‘killed’`. Only `failed`, `error` and
`timeout` make an agent failed.

**Why an agent ended: a rejected request.** When the API refuses a request of an agent — a usage
limit, a server error — Claude Code writes an error line into the agent's transcript in place of a
reply. The last one is kept for the agent while no counted reply follows it (a reply that does
clears it), and its time counts as the transcript's last activity. A transcript that holds nothing
but such lines is kept from its first one, with nothing counted: in a workflow run it is a member of
the run's [collector](#agents-without-a-counted-reply), outside one a row of its own with `–` for
its figures. An agent that ended on one and
has no recorded end reads unknown, as any silent agent does, but its sentence says why rather
than that it may have been stopped — *Unknown — inferred: no result was recorded; the last
request, at 14:20, was rejected — 5-hour limit (HTTP 429).* — and one within its ten minutes
reads running with the rejection named: *Running — inferred: the transcript changed 2 min ago;
its last request was rejected — 5-hour limit (HTTP 429).* Whatever its state, its details carry
the row `Last request` — `rejected at 14:20 — 5-hour limit (HTTP 429)` — and a workflow run's and
a session's details count their agents that ended so, one row per reason:
`Ended on a rejected request` — `5-hour limit (HTTP 429): 12`. The reason is the limit that
refused a rate-limited request, else the kind of error:

| The line says | The reason reads |
|---|---|
| `rateLimitType` `five_hour` | 5-hour limit |
| `rateLimitType` `seven_day` | weekly limit |
| `rateLimitType` `seven_day_opus` or `seven_day_sonnet` | weekly model limit |
| `error` `rate_limit`, no limit named | usage limit |
| `error` `server_error` | server error |
| `error` `overloaded` | overloaded |
| `error` `invalid_request` | invalid request |
| `error` `authentication_failed` | authentication failed |
| `error` `max_output_tokens` | output limit |

followed by the HTTP status in brackets, `(HTTP 429)`; either part is left out when the line does
not give it, and a line that gives neither is stated as *rejected* alone — *Unknown — inferred: no
result was recorded; the last request, at 14:20, was rejected.* A rejection is never counted as a
request or a token: the line's usage is all zeros.

**Retried and replaced.** A workflow run's journal records, for every agent it starts, which step
of the run the agent works on — by a key it compares with the other lines of the same journal
and never keeps — and ends the agent with a result or a failure. When the journal starts a step
again, the attempt before it is superseded: a failed one was retried
(*Failed, retried — the workflow journal recorded the failure and started the same step again
(agent 2e3d).*), one that had recorded nothing yet was replaced — stopped, not unknown
(*Stopped, replaced — the workflow journal started the same step again (agent 2e3d) before this
agent recorded a result.*) — and a completed one was run again. The sentence names the next
attempt by its short id. A superseded attempt keeps its own glyph and state; its row is dimmed,
its glyph's title adds `superseded by a later attempt`, and its markdown line ends on
`(superseded by a later attempt)`; the [tally](#the-tally) counts it under `↻`, not under its
own state. The details of an agent whose step was started more than once
say which attempt it was — `Attempt`: `1 of 2 of this step`. What the parent recorded comes first:
a result the parent recorded for an agent beats the journal's; the journal's ends carry no time
and are never outlived.

A **workflow run** is decided by its members — its agents, the launches inside it, and the agents
its journal started whose transcript was never counted — and a superseded attempt is closed
whatever its own state: it was retried. The run is running while a member runs; unknown while a
member has neither a recorded end nor runs; and once every member is closed, done when one of
them completed — one failure among completed agents does not fail a run —, failed when none
completed and one failed, and stopped when the last attempt of every step was stopped. That is
the run's [tally](#the-tally) read in one order — a `~●` makes it running, else a `~?` unknown,
else a `✓` done, else a `✕` failed, else stopped — so a run's glyph and its tally never disagree,
and a done run may still show `1 ✕` beside it. An agent
the journal started without a counted transcript has no row of its own — its run's
[collector](#agents-without-a-counted-reply) counts it —: it counts in its run's state, in the
tally of every node above it and in the run's `Agents` row, and it is running while
the journal changed within the last ten minutes or another member of the run runs, unknown after
that, unless the journal recorded its end. A run keeps at most **5000** agents of its journal;
further starts are counted, not listed, and its details say so (`12 further agents not listed`).
A **launch** whose transcript never appeared is running for ten minutes after the launch and
unknown after that, unless the parent records its end, which makes it done, failed or stopped
like any agent.

**A run's own end.** A workflow run is started by a `Workflow` tool call in its session's
transcript, and the tool result that answers the call names the run; when the run ends, a task
notification for that call says how — `completed`, `failed`, or a stop in the parent's own word
(`killed`, `cancelled`, `stopped`), as for a background agent. The end recorded for the run's
**latest** launch decides the run before anything else — *Completed — the parent recorded the end
of this run at 14:20.* A resumed run has a launch for every resume; while the latest one is still
under way, what the earlier ones recorded is history, and its details count the launches —
`Launches`: `3 — resumed 2 time(s)`. Without a recorded end the run is its members', as above:
closed, once every member is; else inferred from them. A recorded end does not close a member that
has no outcome of its own — it keeps its own state and is counted so — so a done run can show
`~1 ●` beside it for up to ten minutes, and that agent's details say why. The end is outlived as an
agent's is: when an agent of the run writes more than **60 seconds** after it, the run's state is
inferred from its members again — *Running — inferred: an agent of this run wrote on after the
parent recorded its end at 14:20.* — and its details keep the end in their `Recorded` row. A run
nothing but its launch shows yet — no agent of it has written, and no journal — is running for ten
minutes after the launch and unknown after that, unless its end is recorded; it names no agent
count, `–`, rather than a `0` nobody counted.

Only done, failed and stopped are facts: somebody recorded them. Everything else is inferred from
when a file last changed, and says so — the glyph's title reads `~running · derived` where a
recorded state reads `done · recorded` or `stopped · recorded`, and the markdown list prints
`[~Running]` against `[Done]` and `[Stopped]`. The running glyph pulses unless the system asks for
reduced motion, and every colour is one the rest of the page already uses.

**The sentences.** The details panel opens with the state and the sentence it was derived with,
word for word. For an agent:

* Completed — the parent recorded the result at 14:20.
* Failed — the parent recorded the failure at 14:20.
* Stopped — the parent recorded ‘killed’ at 14:20.
* Completed — the workflow journal recorded the result.
* Failed — the workflow journal recorded the failure.
* Failed, retried — the workflow journal recorded the failure and started the same step again (agent 2e3d).
* Stopped, replaced — the workflow journal started the same step again (agent 2e3d) before this agent recorded a result.
* Running — inferred: the transcript changed 2 min ago and no result was recorded yet.
* Running — inferred: a child agent of this agent is still running.
* Unknown — inferred: no result was recorded and the transcript has been silent since 14:20; the agent may have been stopped.
* Unknown — inferred: no result was recorded and the transcript has been silent since 14:20, after a Bash call; the agent may have been stopped.
* Running — inferred: the transcript changed 1 min ago, after an outcome was recorded at 14:20.
* Unknown — inferred: the transcript went on after an outcome was recorded at 14:20, and has been silent since 14:38.
* Unknown — inferred: no result was recorded; the last request, at 14:20, was rejected — 5-hour limit (HTTP 429).
* Unknown — inferred: no result was recorded; the last request, at 14:20, was rejected.
* Running — inferred: the transcript changed 2 min ago; its last request was rejected — server error (HTTP 529).
* Running — inferred: the transcript changed 2 min ago; its last request was rejected.

A stopped agent's sentence quotes the word the parent wrote — `killed`, `cancelled` or `stopped`,
verbatim; a failed agent's is the same sentence for `failed`, `error` and `timeout`. An unknown
agent whose transcript went quiet on a tool call — its last line called one — names the tool, as
Claude Code wrote its name (`Bash`, `Read`, `mcp__server__tool`); one whose last line called none
keeps the sentence without it, and one whose last request was rejected names the rejection
instead. A result recorded
without a time is stated without one — always so for the workflow journal's, whose lines carry no
time. The other nodes:

| Node | Sentence |
|---|---|
| Session | Active — inferred: the session transcript changed 3 min ago. |
| Session | Active — inferred: an agent of this session is running. |
| Session | Idle — inferred: the session transcript has been silent since 09:12. |
| Session | Unknown — inferred: the session's own transcript has not been read; only its agents were. |
| Workflow run | Running — inferred: at least one agent of this run is running. |
| Workflow run | Done — every agent of this run has a recorded outcome, and at least one completed. |
| Workflow run | Failed — every agent of this run has a recorded outcome, and none completed. |
| Workflow run | Stopped — every agent of this run has a recorded outcome, and none completed: the last attempt of each step was stopped. |
| Workflow run | Unknown — inferred: not every agent of this run has a recorded outcome, and none is running. |
| Workflow run | Completed — the parent recorded the end of this run at 14:20. |
| Workflow run | Failed — the parent recorded the failure of this run at 14:20. |
| Workflow run | Stopped — the parent recorded ‘stopped’ for this run at 14:20. |
| Workflow run | Running — inferred: an agent of this run wrote on after the parent recorded its end at 14:20. |
| Workflow run | Running — inferred: the parent launched this run 2 min ago and no agent has written yet. |
| Workflow run | Unknown — inferred: the parent launched this run at 14:20, but no agent of it was ever seen. |
| Collector | Running — inferred: at least one of these agents is running. |
| Collector | Unknown — inferred: not every one of these agents has a recorded outcome, and none is running. |
| Collector | Done — every one of these agents has a recorded outcome, and at least one completed. |
| Collector | Failed — every one of these agents has a recorded outcome, and none completed. |
| Collector | Failed — the workflow journal recorded a failure for each of them. |
| Collector | Stopped — every one of these agents has a recorded outcome, and none completed: the last attempt of each step was stopped. |
| Launch | Running — inferred: the parent recorded the launch 1 min ago and no result yet; the agent's transcript has not been seen yet. |
| Launch | Unknown — inferred: the parent recorded the launch at 14:20 but no result, and the agent's transcript was never seen; the agent may have been stopped. |

A collector's state is its members', read as a run's is: one running makes it running, one open
unknown, and with every one closed, one completion that nothing superseded makes it done, else a
failure failed, else stopped. When every one of them failed, the label says so and — where the
run's journal recorded each failure — so does the sentence; when every one of them was superseded,
their own ends decide, since the tally counts them all as retried.

A time of today is printed as `14:20`, one of another day as `2026-09-21 14:20`.

## Details

Clicking a row — of the tree or of the running list, or `Enter` on it, since the toggle and the
row are buttons of their own — opens the node's details right under that row; the same click
again closes them. In the tree the panel stands inside the node's entry, between its row and its
children, across the tree's whole width however deep the node sits; under a row of the running
list it is that row's second line. A running agent has a row in both places: the details open
under the one you clicked, and a click on the other moves them there. Only the row they stand
under is pressed. When the row they stand under leaves the page — the agent stops running and
leaves the list, or you close a node above its tree row — they move to the node's other row if
that one is on the page; if it is not, they are not shown, without a word, and come back with
the row (see [Opening and selection](#opening-and-selection)). The panel is drawn once, never
twice.
`Escape` anywhere in the section closes the details and puts the keyboard focus back on the row
they stood under; while a hover card or a sparkline's tip is open, the first `Escape` closes that
and the next one the details. For an agent: type,
models, its ID, depth, started, duration, last activity (with a live `… ago` beside it) and —
for an agent that wrote on after its outcome — what was recorded, then turns,
usage, fresh input, cache write 5 m and 1 h, cache read, output — with its lower bound, where it is
one, in numbers — reasoning and tool calls, then —
when the API rejected its last request — the `Last request` row, then
who spawned it, its workflow run and — where the run's journal started its step more than once —
which attempt it was. A session opens with its two figures — `Own transcript`, and
`Agents, last 7 days` with what it is not: *not added to the own figure — the two cover different
spans* — then its project (only while attribution allows one), its models, `Since first line`
and `Span` in place of a start and a duration, the last activity, the counts of its own
transcript, how many agents it has, how many of them ended on a rejected request, by reason, and
its ID; a collector its tally in words (`266 started, 255 done, 3 failed, about 8 unknown`), a
`Usage` of `–` with why — *These agents were started, but none of them wrote a reply that could be
counted — their transcripts hold no response, or only rejected requests.* — and how many of them
ended on a rejected request, by reason, and no ID, since it stands for no one identifier; a
workflow run how many agents it has — the ones its journal started without a counted transcript
included, and how many it did not list —, how often it was launched when it was resumed, its times, the end its parent
recorded when an agent wrote on after it, the counts summed over its agents, how many of them
ended on a rejected request, by reason, and its ID; a launch
the type and model it asked for,
its ID, when it was made and who made it. Anything absent is `–`, and a record without a single
request shows dashes, never zeros. Every row says itself how it is laid out — a figure beside its
label, or a sentence under it across the whole width — and which row the live clock ticks in;
the page does not guess either from a row's words.

**ID and Copy ID.** The `ID` row holds the whole identifier the node stands for — the agent's id,
a launch's tool-call id, a run's id, a session's id — and the `Copy ID` button beside it puts that
id on the clipboard, and nothing else. *Token Pace: Copy Agent ID* in the Command Palette does
the same for the node whose details are open, and says so when none is.

**Report from Claude Code.** When an agent runs synchronously, the tool result that returns it
to its parent carries Claude Code's own figures for it — `context at the end 18.9K (incl. cache
reads and the reply) · 51.0 s from the start · 4 tool calls`. Its `totalTokens` is the context of
the agent's **last request including its reply**: input, cache write, cache read and output of
that one request (measured on this machine: a median ratio of 1.000 against that request) — not
what the agent used over its run (a median 0.83 of the tree's usage). So the row says which figure
it is, *Claude Code's own figure for this agent, never added to a total*: adding it to ours would
count the agent twice, and it is not the same kind of figure.

**Why the output is a lower bound.** A reply is written into a transcript line by line, and only
its last line carries a stop reason. A reply none of whose lines carries one was never marked
finished, so only the output written up to its last line is counted, and the figure is a lower
bound. The details say how many replies that is, of how many: `⚠ lower bound — 2 of 41 replies
unfinished`, on an agent, on a workflow run (its agents' replies) and on a session (its own
transcript's). Counted on this machine over seven days (2026-09-23): **293 of 925 agents (32 %)**
had at least one such reply, **201 of them exactly one**; **455 of the 477** such replies were
followed by the result of the tool they called — cut off at the tool call, not at the end of the
agent — and only **22** were the file's last reply. Only 22 of the 925 agent transcripts end on an
unfinished reply, so an unfinished reply is no end marker, and most finished agents are no lower
bound at all. The tree's rows carry no mark: the details do, and the markdown report marks the
line — ` ⚠` behind the usage — and says once, at the end, what the mark means.

## What is read

Everything comes from the directory Token Pace already reads for the token counts
(`~/.claude/projects/`, or `~/.config/claude/projects/`), and every field is named here:

| File | Taken from it | Never read |
|---|---|---|
| `<session>/subagents/agent-<id>.jsonl`, and `<session>/subagents/workflows/<run>/agent-<id>.jsonl` for an agent of a workflow run | what every transcript is read for — the token counts, the model, the time, the names of tool calls ([Counting](counting.md)): of a reply's `tool_use` blocks the `type`, the `name` and the `id`, and the `name` of the last one is kept for the agent with its line's time (at most 100 characters of `[A-Za-z0-9_.:@/-]`, else none); a nested agent lies flat beside the one that spawned it | any text, and a tool call's `input` |
| `agent-<id>.meta.json` beside each agent transcript | `agentType`, `model`, `spawnDepth`, `toolUseId` — from a file of at most 64 KB, never through a link | `description`, `prompt`, and every other field |
| `<session>/subagents/workflows/<run>/journal.jsonl` | `type`, `key` and `agentId` at the head of each line, matched on the raw line — a line of at most 16 KB without that head is parsed for the same three, a longer one skipped and counted; the `key` is compared within the journal, never kept: with the keys of the same journal's other lines, to tell a step that was started again from a new one, and it is never stored, shown, exported or logged | the `result`, `label` and `phase` a line carries |
| the transcript that launched an agent — the session's, or another agent's | an `Agent` (or `Task`) tool call: its `id` and three fields of its input, `subagent_type`, `model` and `run_in_background` | the input's `description` and `prompt` |
| the same | the tool result that answers it: `agentId`, `status`, `totalTokens`, `totalDurationMs` and `totalToolUseCount`, and the `tool_use_id` it answers | its content — the prompt and the answer it also carries |
| the same | a queued task notification, the way a background agent's end arrives: the `<tool-use-id>` and `<status>` tags inside it | its `<summary>` and its `<output-file>` |
| `<session>/subagents/…/agent-<id>.jsonl`, an API error line (`isApiErrorMessage`) — a request the API rejected | `apiErrorStatus` (an HTTP status, 100 to 599), `error` (one of `rate_limit`, `server_error`, `invalid_request`, `authentication_failed`, `max_output_tokens`, `overloaded`) and, of its `quotaLimits` block, the `rateLimitType` (one of `five_hour`, `seven_day`, `seven_day_opus`, `seven_day_sonnet`); any other value is none; a main session's error lines are skipped | its `message` — the error's text —, `errorDetails`, `apiError`, `perTurnEffort`, `requestId`, and everything else of `quotaLimits`: its `status`, `resetsAt`, `overageStatus`, `overageDisabledReason`, `isUsingOverage`, `upgradePaths` and `unifiedRateLimitFallbackAvailable` |
| the transcript that launched a workflow run | a `Workflow` tool call: its `id` alone — of a reply's `tool_use` blocks the `type`, the `name` and the `id` are read, and the `input` only of an `Agent` or `Task` call; from the tool result that answers it the `runId` (`wf_` and at most 61 characters of `[A-Za-z0-9_-]`) and the `status`, and the `tool_use_id` it answers; the run's end arrives as a task notification, read as above | the call's whole input — its `script`, `scriptPath`, `args` and `description` — and the result's `summary`, `scriptPath`, `transcriptDir` (a path), `workflowName`, `taskId` and `taskType` |

So from a `Workflow` tool call its `id`, and from the result that answers it the `runId` and the
`status`: the run id is only compared with the name of the run's directory — the id the run's name
and its `ID` row show already. Each of those lines also gives its own time stamp, where it
carries one — a journal line carries none, so a run's last activity is its journal's
modification time. For the agent tables nothing
else is read: never a `description`, a `prompt`, a `summary`, an `output-file`, a `content`, a
`result`, a `label` or a `phase`, never a workflow's `script`, `scriptPath` or `transcriptDir`,
never an API error's text or its `errorDetails`, never a working directory, never any text. Every string that is kept is an identifier and is checked on the way in: a type or a
model alias is at most 40 characters of `[A-Za-z0-9_.:@/-]`, a model id from a response at most
64 of the same, an id at most 64 characters of `[A-Za-z0-9_-]`, a depth a whole number from 1 to
99. A value that does not fit is dropped whole rather than trimmed into a string nobody wrote,
and the tree shows the gap as `–`, as it does for older Claude Code builds that write no sidecar
at all; only a session id, which no record can do without, is cut down to the id alphabet
instead. The log gets counts, never a value.

What is kept lives in the token snapshot (`state.json` in the extension's own storage): per agent
transcript and per session transcript the ids, the agent's type and model names, the first and
last time, the token counts, the number of tool calls and the recorded result with the parent's
word for it (one of `completed`, `failed`, `error`, `timeout`, `killed`, `cancelled`,
`stopped`), and for an agent its last rejected request — its time, its HTTP status, its error
kind and its limit, each one of the values listed above — an agent whose transcript holds nothing
but rejected requests has a record from the first of them, its counts all zero —, and the name of
its last tool call with that line's time; per launch its tool-call id, the type and model it asked for, whether it runs in the
background, its result with that word and the parent's three totals; per `Workflow` call its
tool-call id, the run id its result named, when it was made, and the run's end with the parent's
word for it; per workflow run the agents
its journal started, each with the ordinal of its step, its attempt, the journal's outcome and the
attempt that superseded it, how many further ones it did not list, and when the journal last
changed — never a key. The records are keyed by the transcript's path, as every transcript's read
position always was. None of it is part of the CSV or JSON export, the clipboard summary or
the diagnostics report. The tables do not depend on `tokenPace.attribution` — see
[Sessions and projects](sessions.md).

## Kept for seven days

A record is dropped at the first roll-up **7 days** after its last line — a workflow run 7 days
after its journal last changed — whatever `tokenPace.retentionDays` says, and the tree never shows
an older one. There is no setting for
it: the tree has nothing to show for older agents, and the snapshot would carry them along on
every save.

**The one-time rebuild.** A snapshot written before 1.5 has no agent tables, and one written
before 1.6 no workflow runs. On the first start after the update they are rebuilt once from the
Claude transcripts and journals that changed in the last seven days — each read only as far as its
tokens were already counted, so no token is counted twice and no total moves. The snapshot states
which revision of the agent tables it holds; an update that adds something only such a rebuild can
fill in raises the revision, and the rebuild runs once more. *Re-read Token History* rebuilds them
with everything else. The log states how much was read, in counts only.

**A journal's keys after a restart.** The keys a journal's lines carry live in memory only. After
a restart, before a journal's next lines are read, it is read once from its start up to where it
had been read — for its keys, so a step started again after the restart is still told from a new
one; the run it rebuilds is the one the snapshot held. A journal rewritten from the start is read
anew, and its run's agents with it.

## Live

* The file watcher reports a changed transcript within about a second, as it does for the token
  counts.
* The section is pushed at most once every **2 seconds**. A running agent writes a line every
  0.6 seconds at the median, and every push redraws the running list and the tree; the other
  sections are not held back by it, and opening a node or a click of yours is answered at once.
  The keyboard focus stays on its row through a push — on the running list's row or on the
  tree's, whichever it was on.
* The `running for …` clocks of the running list and the tree and the last activity in the
  details tick every second in the page itself — no message, no redraw — and so does a running
  agent's `silent for …`, which the same timer shows once three minutes have passed.
* The recursive file watcher can miss the files of a directory created after it started — on
  Linux it does — so while an agent runs, or while a session is active, the agent directories of
  the active sessions are also listed every **5 seconds**, on every platform; the one-minute
  sweep stays as the last net. An active session is enough: it may start an agent or a workflow
  run at any moment, and the agents of a workflow run are started by the run, not by a call the
  session's transcript records, so the first file of a new run is found within five seconds rather
  than a minute. A pass costs a few milliseconds.
  With every session idle and nothing running, the listing stops.
* The tree carries no time of its own, so a tree that did not change is not sent to the page
  again.

## Opening and selection

A node with children has a toggle (▸ closed, ▾ open) in front of its row; the tree starts with
every node closed. Which nodes you opened and which node's details are open are kept with the
rest of the dashboard's view state — range, sort, filters, folded sections — in the extension's
own storage, so they survive a push, a reload and a restart; selecting a node never opens
anything by itself. Only node keys are kept, made of the session, run, agent or launch id: the
opened nodes' keys and the selected one's — with which of its rows its details open under, the
tree's or the running list's — never a label, a figure or anything from a
transcript, and at most 200 opened nodes: opening one more forgets the one opened longest ago,
so a node can always be opened, and the key of a node that has left the tree does not keep its
place for good. A key whose node has gone matches nothing. How many children an opened node shows
is kept the same way: the "more" steps of at most 200 nodes, the one taken longest ago forgotten
first, and closing a node forgets its steps — opened again, it shows its first fifty. The details
open for a node whose row is on the page — in the tree, or in the running list. A selected node
inside a closed branch has no row there: its details stay shut, without a word, until the branch
is opened again, and the markdown report, which prints every node, shows them all the same. A
selected node that is gone says so instead (`The selected node is no longer in the tree.`). That
is an agent or a launch older than seven days, a session without agents that has been quiet for
more than 24 hours, and any node of a session beyond the 20 listed that the running list does
not name — the session itself, or one of its agents once it has stopped running. *Clear Stored
Data…* removes them with the rest of the dashboard view state.

## Limits

* **Claude Code only.** Codex records no agent identity; its subagent turns are counted in the
  totals as they always were.
* **Only the transcripts Token Pace reads.** An agent that runs on another machine — another
  computer, or the far side of a remote or a container this extension does not run in — is
  invisible here; see [Windows, WSL and remote development](windows-wsl-remote.md) for which
  side reads the transcripts.
* **No end marker.** An agent that was stopped without its parent recording it — interrupted,
  its session closed, its process gone — has no recorded result, so ten minutes after its last
  reply it reads `unknown`, never `done`. Only a stop the parent recorded reads `stopped`. One that
  ended on a request the API rejected says so, with the reason the error line gives.
* **Waiting can look like silence.** The states are read from replies. An agent waiting on an
  agent it launched reads `running` while that agent runs, and a session reads `active` while
  one of its agents runs — both say they were inferred from below. An agent that waits longer
  than ten minutes on anything else — one long tool call — reads `unknown` until its next
  reply.

## Settings

The section has no setting of its own. The gear in its header opens the two it depends on:
`tokenPace.dashboard.sections`, where `agents` can be moved or removed, and
`tokenPace.attribution`, which decides whether a session may name its project.
