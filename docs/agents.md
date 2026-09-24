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
right now, so you do not have to look for them in the tree; its first line opens, on request, a
block of where the agent tokens of the last seven days went (see [Last 7 days](#last-7-days));
the tree itself starts closed, with only the sessions showing. It is on by default, directly after `quota` in
`tokenPace.dashboard.sections`; a list you have set yourself is kept as it is, so there the
section appears once you add `agents` to it. The range, provider and model chips do not apply:
the section is always the last seven days, so the filter bar stays below it. *Show Usage as
Text* prints the running list, the 7-day block while you have it open, and then the whole tree as indented lists — every node open, at
most 50 children each (see [Opening and selection](#opening-and-selection)) — with the open
node's details as a table. *Show Usage (Quick Pick)* has a group `Agents` after the quota: the
first five entries of the running list, one row for the rest, and the sessions' tallies added
together — `14 started · 5 ✓ · 2 ✕ · … · last 7 days`, in words beside it —, every row opening the
dashboard; past the 20 sessions the tree lists, that row names the sessions it counts and how
many older ones it leaves out. The CSV and JSON exports carry the agents too (see [Export and diagnostics](export.md)).

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
one row of them however many of its agents run; it has no start of its own, so it comes last.

**Each row** is two lines, as a tree row is (see [The tree](#the-tree)): the running glyph and the
agent's name as the tree writes it — `Explore · opus-5 · 94f3` —, then its usage — `–` for a launch
and a collector, since nothing of them was counted, `⚠` inside it where it is a lower bound —, a
live `running for 12 min 05 s` counted from its first line (from the launch, for a launch) and
`silent for 4 min` once the agent has not written for a while; and under them, a line of its own,
where it sits: `Session 9d0eb37a · Workflow run cfe7718d`, the session and the run by their ids,
with the session's project after them while `tokenPace.attribution` names one. An agent that runs
only because an agent below it runs — the parent waiting for its child — says so on that line:
`waits for a child agent`. A collector has **no clock**: the earliest first line among its agents
may be a request the API rejected for an agent that failed long before, and a clock from it would
claim a precision nobody has — its row says `~10 of them running` in the clock's place.

**A click on a row** opens the same details a click on its tree row opens — under the row you
clicked, here the running list's — and the same click again closes them. It opens nothing in the
tree: the panel shows whether the node's tree row is on screen or inside a closed branch — or in
a session the tree does not list, for as long as the agent runs and the list names it (see
[Opening and selection](#opening-and-selection)). The rows are buttons ahead of the tree, so the
keyboard reaches them first — the `Last 7 days` button of the first line, then each row a stop of
the `Tab` key, then the open [7-day block](#last-7-days)'s largest agents, then the tree, which is
one (see [The keyboard](#the-keyboard)).

With nothing running, the list is one line — `No agent is running.` — with no heading, and the
`Last 7 days` button at its end. The
markdown report prints the list under `### Running now`, one line per agent — `[~Running]`
first, as the tree's lines mark an inferred state, then its name with the model's whole id, where
it sits and its usage,
`⚠` behind a usage that is a lower bound, `(waiting)` behind a waiting one and
`(~10 of them running)` behind a collector — and heads the tree after it with
`### Sessions and agents`.

**In the status bar.** `agents` in `tokenPace.statusBar.show` — off by default — puts the
heading's count on the status bar: `~3 running`, `~1 running`. It is hidden while nothing runs,
has no colour and no alarm, and says nothing when an agent finishes. Its tooltip says what
running means, names the first five rows of the list — the agent's name with the model's whole
id, and where it sits; a collector with `(~10 of them running)` — and counts the rows it leaves
out (`and 2 more`). A click does what `tokenPace.clickAction` says, as on every other entry. See
[the status bar](status-bar.md).

## Last 7 days

The running list's first line — its heading `Running now (3)`, or the line `No agent is running.` —
carries a button at its end, `Last 7 days` ▸. It opens a block under the running list, before the
tree: **Last 7 days · where the agent tokens went**. The block is closed by default; whether it is
open is kept with the rest of the view state (see [Opening and selection](#opening-and-selection)),
and the button says to a screen reader whether it is open. Only while it is open is it built at all.

**What it counts.** Every agent record of the seven days the tree covers that counted at least one
request — of every session, the ones the tree does not list included — once, at its **whole usage**,
the figure its tree row shows (fresh input + cache write + output). An agent without a counted
request is not in it, nor a launch whose transcript was never read. A record is a whole agent: one
that started eight days ago and wrote on into the seven is counted whole, where the hour buckets of
the tables split the same tokens by the hour of each reply — so the block's figures and the tables'
subagent figures are two different cuts of the same tokens, and are not added to each other.

**The table.** One row per **type and model**, as the agents' names say them — `Explore ·
opus-5`, the model's whole id in the row's title and in the markdown report; a record that names no
type is an `Agent`. The largest usage first, at most **10** rows; the rest are counted in one line
under the table (`3 other combinations`). The columns: *Type · model*, *Agents* (how many), *Usage*
(theirs together), *Share* (of the whole block — every agent of the seven days, the rows the table
leaves out included; `<1 %` for a share that rounds to none), *Median per agent* (the usage of the
agent in the middle, or halfway between the two in the middle), and — only while
`tokenPace.showCost` is on — *~Cost*: what their tokens would have cost through the API, marked `~`
as every cost of the page. An agent is priced at the rates of its model on the day of its last
counted reply, as the tables price the same tokens, at the model's standard rate (a record keeps no
speed and no web search). An agent without a price is not in a cost: its model has none on file, or
its replies were written with more than one model — a fallback in the middle of a run — whose
tokens its record cannot split between them. A row none of whose agents has a price shows `–`; a
sum that holds only some of its agents is a lower bound and carries `⚠`, titled *not every agent
has a price: the sum is a lower bound*. A last row, *All agents*, gives how many agents the block
holds, their usage and their cost together; a share of the whole and a median of one agent's are
no figures of the whole, and its two cells stay empty. With costs off the block names no amount
anywhere. In a sidebar of 320 px or less the table stacks, as every table of the page does, and
tighter: a row's type and model on a line of their own, then its figures, each with its column's
name, as many to a line as fit; a name too long for its column breaks between the type and the
model, never inside either.

**The largest agents.** Under the table, **The 5 largest agents** by usage — rows like the running
list's: the state glyph and the agent's name, then its usage, its share of the block and, with
costs on, its cost, and a line of where it sits (`Session 9d0eb37a · Workflow run cfe7718d`). A
click on one, or `Enter` or `Space` on it, opens the agent's details under that row, as a click on
its tree row or its running row opens them under that one (see [Details](#details)) — wherever its
tree row is: inside a closed branch, or in a session the tree does not list. The rows are buttons
between the running list and the tree, each a stop of the `Tab` key.

With no agent of the seven days that counted a request, the block says so in one line: `No agent
of the last 7 days has a counted request.` The markdown report prints the block while it is open,
after the running list — `### Last 7 days · where the agent tokens went`, the table, the line for
the rest, and `#### The 5 largest agents` with one line each: `[Done] Explore · claude-opus-5 · 94f3 ·
Session 9d0eb37a · 1.2M · 34 %`, a cost behind it while costs are on. The block's rows are part of
the section's push: they count against its cap of nodes (see
[The tree](#the-tree)).

## The tree

**Sessions** are the roots, the most recent first. A session is listed when its own transcript
recorded a response within the last 24 hours, or when it has an agent or a launch from the last
seven days, or a workflow run whose journal changed in them. At most **20** sessions are listed; the rest are counted under the tree
(`3 older session(s) not shown.`). A session is **named by when it started**, then by the first
eight characters of its id: `Session Tue 14:20 · 9d0eb37a` — its first line's weekday and clock
time while that lies within the last **6 days**, its date and clock time before that
(`Session 2026-09-01 14:20 · 9d0eb37a`), in the zone `tokenPace.timezone` names and the clock
format the rest of the page uses; the date is the calendar's, whatever `tokenPace.dayBoundaryHour`
says. Six days and not seven, so no two starts a weekday could name are in it. A session whose
own transcript was never read has no first line and is named by its id alone (`Session 9d0eb37a`).
The id is in the figures' dim tone; the project follows it while `tokenPace.attribution` is
`project` or `session` — the label the Sessions table shows, hashed too under
`showProjectNames: hash`. With `attribution: none` no project is named anywhere in the tree.

**Closed by default.** Only the sessions show until you open one; an opened node shows its
children closed in turn. Each session says under its name what its agents came to — its
[tally](#the-tally), `12 started · 3 ✓ · 1 ✕ · 2 ↻ · 1 ■ · ~4 ● · ~1 ?` — so a closed session
already tells a run that went well from one that did not. A run whose agents no transcript shows
has nothing to open: it has no toggle, and its tally still says what is below it. What you open
stays open (see [Opening and selection](#opening-and-selection)).

**Below a session** come its workflow runs and its agents, each agent under the agent that
launched it when that one is in the same tree, otherwise directly under the session; the agents
of a run stay inside their run. A run is named like a session, by when it started — its first
agent's first line, or its launch: `Workflow run Tue 00:19 · cfe7718d`. Siblings — the children of
a session, of a run and of an agent alike — are in **plain time order, the newest start first**,
whatever state each is in: the glyph, the state's word and the tally say that, the order says
when; a node without a known start comes after the others, and a run's collector is always its
last child. A launch whose transcript has not appeared yet is a node of its own, in italics and
named from the launch — `Plan · sonnet · launched` — with `–` for its figures, since nothing was
counted. A workflow run is a node from the moment its session launched it, before any agent of it
has written: with `–` for its figures and nothing to open until one does. A run's agents without a
counted reply are one node, the run's last child: its
[collector](#agents-without-a-counted-reply).
No agent sits more than **6** levels below its session: one that would sit deeper moves up, it
is never dropped.

**Fifty at a time.** An opened node shows at most **50** of its children at a time, in the
order above. When it has more, a line after the last one says so — `50 more · 377 not shown`,
or `12 more` when the next fifty are the rest — and a click on it, or `Enter` or `Space` on it,
shows the next fifty: the line is an item of the tree like the node's children, reached with the
arrow keys. A node takes that step at most **10** times, so it shows up to 550 of its children; past
that the line only counts the rest, `377 not shown`. Always among those shown, each taking the
place of the last one that is not: every child that is running, the one on the way to the node
whose details are open, and a run's collector, which stays its last child — so the open node's
row is never left out, nor a running agent's, nor the row that counts the run's agents without a
counted reply. When those alone are more than fifty, the way to the open node comes first, then
the collector, then the running children.

**Only what is open goes to the page.** A closed node's children are not sent to it at all: only
whether it has any, how many, and what the agents below it came to. A large run closed is one
row: a run of 427 agents made a section of 77.8 KB while every node went to the page, and its
session closed is well under 1 KB. The fifty an opened node shows first are its newest fifty. One push of the section holds at most **2000** nodes, a
safety cap that only many opened nodes
of fifty children each reach: it is filled with the path to the node whose details are open and
the running agents first, then in the order the page draws the tree, and an opened node whose
children no longer fit shows none of them and says how many it has (`377 not shown`). While the
[7-day block](#last-7-days) is open, its rows — the table's and its largest agents' — are rows of
the push too, and the tree has that many fewer places.

**Each row is two lines.** The first is the state glyph and the name — the short id at its end in
the figures' dim tone, and a session's project after it. The second, under the name, in the dim
tone, is the figures: the usage — fresh input + cache write + output, the definition the tables
use —, the duration from the first line to the last, and for a session, a run and a closed agent
with agents below it, the [tally](#the-tally). A session's and a run's second line is the usage,
then the tally, then the span or the duration — `88.2K · 6 started · 2 ✓ · 1 ✕ · 19 min 50 s`: what
the agents below came to is what such a row is there to say. A run's
[collector](#agents-without-a-counted-reply) follows the same order — `– · 263 started · 250 ✓ ·
3 ✕ · ~10 ● · –`. An agent's is the usage, then the duration or the clock, then its silence and its
tally.

Neither line wraps, whatever the width. Where the name has no room, each part gives way in the
order of what the row can best do without, ending on `…`, and the whole name — the model's whole id
included — is the line's title:

* An agent's **model** gives way first — `workflow-subagent · opus-… · f6a7` —, and where the line
  has no room left even for its dot and the `…`, it is taken off the name whole:
  `workflow-subagent · f6a7`. The **type** — what tells Explore from Plan from general-purpose — and
  the short id stay whole; only a line too short for those two alone would cut the type. A launch
  keeps its last word (`launched`) whole the same way.
* A session's **project** gives way first, then a session's or a run's **short id**, down to its
  `…`. The prefix word and the **time** the row is named by stay whole —
  `Workflow run Thu 11:57 · 0d…` —, so a run never loses the time it is named by. Only a name by its
  date in a narrow sidebar, `Workflow run 2026-09-03 11:57`, is too wide for its line even without
  its id; there the prefix word gives way — `Wo… 2026-09-03 11:57 · 0…` — and still never the time.

Where the figures have no room — a narrow sidebar, a deep row — their last parts come off the line
whole, the last first: a session's, a run's or a collector's span or duration, then the tally's
last counts; an agent's tally, then its silence and its clock. The line ends on `…`: no figure is
ever cut in two, a screen reader still hears every one, and the details panel shows them all. The
usage always stays.

A **session's** figures name themselves — `own 12.0M · agents 137.4M · 22 d 11 h`: what its own
transcript used, counted from its first line, and what its agents of the last seven days used. The
two are never added: they cover different spans, a session's own transcript often weeks, its
agents the seven days the tree keeps. A session without agents shows no agents figure. The last
figure is the session's span from its first line to its last (its title says so), written in days
and hours from **48 hours** on — the hours floored, so `22 d 11 h` for a session of 22 days, 11
hours and 59 minutes — and as a duration below that. A usage that is a **lower bound** carries
`⚠` inside it, its title the reason — `⚠ lower bound — 2 of 41 replies unfinished` — and the
details' Output row says the same (see [Why the output is a lower bound](#details)); a session's
mark is its own transcript's, on its own figure. A running node shows, in its duration's place,
for how long it has been running, counted from its first line and ticking every second —
`12 min 05 s`; the running list's row says `running for 12 min 05 s`. A running
agent whose transcript has not changed for **3 minutes** says that too, after its figures —
`silent for 4 min`, in whole minutes, then `1 h 05 min` — in the same quiet tone as the figures,
from the page's own clock: it appears the second the three minutes are up, with no push, and goes
again with the agent's next line. A pause of a minute or two is an ordinary tool call; after three
minutes the reader may want to look. It changes no state — the agent stays running until ten
minutes have passed — and an agent that runs only because an agent it launched runs, or a launch,
never says it: they have no line of their own to be silent in. An agent's name
is its type, its model and its short id — `Explore · opus-5 · 94f3`. The type is the one
the agent's sidecar names, else the one its launch asked for, else `Agent`; the model is the last
one its transcript recorded, else the alias the sidecar or the launch names, else `–` — on the
row in its short form, without the `claude-` every Claude model id starts with. The details'
title and Models row, the markdown report and a screen reader get the whole id:
`Explore · claude-opus-5 · 94f3`. The **short
id** is the start of the agent's id that no other agent of the same session starts with — the
agents a run's journal names without a transcript included, since a sentence may name one — at
least **4** characters long: Claude Code's ids are `a` and 16 hex digits, and the `a`, which
every one of them carries, is left off. Four characters keep nearly every agent apart; where two
agents of a session share them, both names carry as many as it takes — measured over a week on one
machine, 917 of 925 agents needed four and 8 needed five. The whole id is in the details. An
agent's usage is part of the figures the totals already contain: the tree adds nothing to any sum.

**Without the colours, the glyphs and the mouse.** A screen reader gets words where the eye gets
marks: a glyph is `running, derived` or `done, recorded` (its title keeps `~running · derived`), a
tally is read in words, and a clock that ticks every second is hidden from it and stands beside it
as words that stand still — `since 14:20` for the time a node has been running, `silent since
14:21` for a silence — from the clock times the view model sends with each node; the page formats
no time of its own. Each row is an item of a tree (`treeitem`) and says so: its **name** is the
node's whole name, a session's project after it, its state and — where the row shows one — its
tally, in words: `Workflow run Tue 11:40 · cfe7718d, running, derived, 8 started, 3 done, about 2
running`; its **figures** follow as its description, `412.3K lower bound, since 11:40` — every
figure, the ones a narrow sidebar took off the line included, read as if they stood on it: `own
32K, agents 166K, 49 min 00 s`. With it a
screen reader hears the item's level, its place among its siblings and how many they are — every
child the node has, the ones past the fifty shown included: `3 of 165` —, whether it is open, and
whether it is the selected one. The toggle is the mouse's alone and hidden from a screen reader:
the item says whether it is open. The toggle is 24 px wide and high and a row at least 24 px high,
so neither is a target smaller than 24 × 24 px (WCAG 2.5.8). In a forced-colours theme —
Windows High Contrast — the glyphs and the `⚠` take the text colour, the toggle's arrow the
button's, the open row, whose tint the theme removes, a 2 px outline in the highlight colour, and
the item the keyboard is on a 2 px ring in the text colour; the theme's own colours are left on
everywhere else.

### The keyboard

The tree is a tree to the keyboard too, as WAI-ARIA's tree pattern describes one. It is **one stop
of the `Tab` key**: `Tab` from the last stop before it — the running list's last row, or the last
of the open 7-day block's largest agents — lands on one item of the tree — the one
you were last on, else the selected node while its row is shown, else the first session — and the
next `Tab` leaves the tree; while that item's details are open, the next `Tab` first reaches their
*Copy ID* button, and `Shift+Tab` goes back to the item. Inside the tree the keys move from item to
item:

| Key | On an item of the tree |
|---|---|
| `↓` / `↑` | the next / the previous item shown |
| `Home` / `End` | the first / the last item shown |
| `→` | on a closed node, opens it; on an open one, moves to its first child |
| `←` | on an open node, closes it; elsewhere, moves to the node above |
| `Enter` / `Space` | opens the node's details under its row, or closes them again; on a `50 more` line, shows the next fifty |
| `Escape` | closes the details (see [Details](#details)) |

**Moving selects nothing**: the arrows only move the focus, the details open with `Enter` or
`Space` — or a click. A key with `Ctrl`, `Alt`, `Shift` or `Meta` is left to VS Code. The item the
focus is on has a ring round its line in the theme's focus colour; a click on a row focuses its
item as well, without the ring. When the section is pushed again while the focus is in the tree,
it stays on the item with the same node, else on the nearest item above it that is still shown —
the node a `50 more` line belonged to, once it shows every child; the run, when newer agents push
the one you were on out of its first fifty —, else on the first session.

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

A session's and a run's tally stand on the second line of the row, after the usage and before the
span or the duration, whether the node is open or closed: what failed, was retried or is still
unknown among a few hundred agents is not something to count off the rows. An agent's stands only
while it is closed, at the end of its line; open, its children are on screen with their own glyphs. A node with no agent below it — a session that started none, an agent that launched
none, a launch — has no tally, rather than a `0 started`. The markdown report prints a node's
tally after its name in brackets, on every node that has one:
`[~Running] Workflow run Tue 11:50 · cfe7718d (8 started · 3 ✓ · 1 ✕ · 2 ↻ · ~2 ●) · 1.2M · 4 min 10 s` — the
names the tree's, the id plain and the model whole. It prints
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
one of them failed. It has no toggle and no children; its figures are `–`, never a `0`, and it runs
no clock, in the tree or in the running list: it has no start of its own. Its second line is a
run's — its usage, its [tally](#the-tally), then its duration, the trailing `–` the first part to
give way —, and its state is its members', by the rule a run's state follows (see
[States](#states)). An agent of a run whose transcript holds only rejected requests
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
attempt by its short id. A superseded attempt keeps its own glyph and state; its row is dimmed —
its name faded to 65 %, its short id and figures in their dim tone as on any row, so every word of
it still reads at 3:1 or better in the light and the dark theme; the glyph keeps its full strength,
since it is the mark of the state and keeps its 3:1 too —,
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
closed, once every member is; else what [Claude Code's run record](#claude-codes-run-record) says;
else inferred from them. A recorded end does not close a member that
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
| Workflow run | Completed — Claude Code's run record says ‘completed’. |
| Workflow run | Failed — Claude Code's run record says ‘failed’. |
| Workflow run | Stopped — Claude Code's run record says ‘killed’. |
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

### Claude Code's run record

Claude Code keeps a record of every workflow run of its own — `<session>/workflows/<run>.json`,
beside the session's `subagents/` directory — and its `status` is the third word on a run's end:
`completed` makes the run done, `failed` failed, and `killed`, `stopped` and `cancelled` stopped,
the word quoted as Claude Code wrote it — *Completed — Claude Code's run record says ‘completed’.*;
`running` says nothing. It comes after the parent's end and after the members' own: an
undocumented file is believed only where nothing that says more is there. The record states when
the run started and how long it took, so its end has a time, and it is outlived as the parent's is:
when an agent of the run writes more than 60 seconds after that end, the run is its members' again.
All seven of its fields are the run's details' row `Claude Code's run record` — `completed ·
started 11:00 · 3 agents · 48.2K tokens · 17 tool calls · 21 min 05 s · default model
claude-fable-5-1[1m]`: its status, its start, how many agents it counts, its tokens, its tool calls,
how long it took and its default model, a dash for each part the record does not state and for the
whole row without a record (none yet, one larger than 4 MB, one that ends before its object does)
—, *Claude Code's own figures, never added to a total*: they are what Claude Code counts, and the
tree's usage is its own.

Which of the four decides, for every combination (the precedence of a run's end; a test holds the
tree builder to this table):

| The parent recorded an end | Every member closed | The run record ended it | The run's state comes from |
|---|---|---|---|
| no | no | no | the members' clocks |
| yes | no | no | the parent |
| no | yes | no | the members' ends |
| no | no | yes | the run record |
| yes | yes | no | the parent |
| yes | no | yes | the parent |
| no | yes | yes | the members' ends |
| yes | yes | yes | the parent |

A recorded end with a time — the parent's, or the record's — is set aside when an agent of the run
wrote on more than 60 seconds after it, and the next source down decides; the members' ends carry
no time and are never set aside.

## Details

Clicking a row — of the tree, of the running list or of the [7-day block](#last-7-days)'s largest
agents —, or `Enter` or `Space` on it (see
[The keyboard](#the-keyboard)), opens the node's details right under that row; the same click or
key again closes them. In the tree the panel stands inside the node's entry, between its row and its
children, across the tree's whole width however deep the node sits; under a row of the running
list or of the 7-day block it is that row's second line. A running agent has a row in both the tree
and the running list, and one of the largest agents a row in the block as well: the details open
under the one you clicked, and a click on another moves them there. Only the row they stand
under is pressed. When the row they stand under leaves the page — the agent stops running and
leaves the list, you close the 7-day block, or you close a node above its tree row — they move to
the node's other row if one is on the page — its tree row first, then its running row, then its
row in the block —; if none is, they are not shown, without a word, and come back with the row
(see [Opening and selection](#opening-and-selection)). The panel is drawn once, never
twice.
`Escape` anywhere in the section closes the details and puts the keyboard focus back on the row
they stood under — in the tree on its item —; while a hover card or a sparkline's tip is open, the first `Escape` closes that
and the next one the details.

**An agent's details**, in this order. Under the state and its sentence, one line of what the
agent came to — `1.2K in 29 min 00 s · 5 requests · 3 tool calls`: its usage, its duration, its
requests and its tool calls. Then its **token mix**: one bar of its fresh input, cache write,
cache read and output, each part as wide as its share of the four together, in the Tokens
section's colours, and the same in words under it — `fresh 2 % · cache write 18 % · cache read
76 % · output 4 %`, which is what a screen reader and the markdown report get (in a forced-colours
theme each part has a border of the text's colour). For an agent of a workflow run with at least
two agents that counted a request, its **rank in the run** by usage — `3 of 41 by usage`, an
agent with a bigger usage before it, equal ones sharing a place. The **context at the end**: the
input, cache reads and cache writes of its newest request — what its next request would have
started from (Claude Code's report below counts the reply's output on top of it). From
**1 minute** on, what it used **per minute** of its duration. Then its type, its models, the
**effort** its replies were written at — the word Claude Code writes, `xhigh`, or `high, then
xhigh` where it changed —, its ID, depth, started, duration, last activity (with a live `… ago`
beside it) and — for an agent that wrote on after its outcome — what was recorded, then its
requests (the requests to the API; 1.5 called them turns), usage, fresh input, cache write 5 m
and 1 h, cache read, output — with its lower bound, where it is one, in numbers — reasoning and
tool calls, then what of it went wrong or was done again: its **tool errors** — `1 of 3 tool
calls`, the tool results marked as an error, where it called a tool —, its **cache misses** —
`model changed 2 · cache unavailable 1`, why the cache missed on its requests, the most frequent
reason first, with the input tokens those misses state were not read from the cache (`48.2K tokens
not read from the cache`; Claude Code gives that figure for a changed message, model, tool set or
system prompt, not for an unavailable cache or a previous message it could not find, so only the
stated ones are summed), only where there was one — and its **compactions** — `1 · last at 14:20
(auto, 167.2K → 12.4K)`: how often its transcript was compacted, when last, whether it was asked
for (`manual`) or Claude Code's own (`auto`), and the context before and after it, only where it
was —; then — when the API rejected its last request — the `Last request` row, then who
spawned it — left out for an agent of a workflow run that no launch names: its run started it,
and the next row names the run; where no launch names a spawner, the agent its sidecar names as
its parent —, its workflow run and — where the run's journal started its
step more than once — which attempt it was, the **Claude Code version** that wrote its transcript
— `2.1.281`, `–` where its lines named none — and its **permission mode**, where its transcript
names one (as Claude Code writes the word, `bypassPermissions`; on the measuring machine no
agent's transcript names one), and last Claude Code's report, where there is one. An
agent nothing of which was counted has no summary line, no mix, no rank, no pace and no tool
errors, and dashes for its figures.

A session opens with its two figures — `Own transcript`, and
`Agents, last 7 days` with what it is not: *not added to the own figure — the two cover different
spans* — then its project (only while attribution allows one), its models, `Since first line`
and `Span` in place of a start and a duration, the last activity, the counts of its own
transcript — its usage is the `Own transcript` row already —, its compactions where it was
compacted, how many agents it has, how many of
them ended on a rejected request, by reason, its **agents by effort** — `xhigh 412 · max 12 · – 3`,
the most frequent first, `–` counting the ones with none recorded: a launch nobody has read a line
of, an agent its journal started without a transcript, one whose replies carried none —, the
Claude Code version that wrote its transcript, the permission mode its prompt last named — the
word Claude Code writes, `plan` — and its
ID; a collector its tally in words (`266 started, 255 done, 3 failed, about 8 unknown`), a
`Usage` of `–` with why — *These agents were started, but none of them wrote a reply that could be
counted — their transcripts hold no response, or only rejected requests.* — and how many of them
ended on a rejected request, by reason, and no ID, since it stands for no one identifier; a
workflow run its tally in words — `427 started, 112 done, 12 failed, 295 retried, about 8
unknown`, the agents its journal started without a counted transcript included — and how many
agents it did not list, its **parallelism** — `up to 7 at once`, the most of its agents whose time
from their first line to their last activity overlapped, both ends included —, its times, the end
its parent recorded when an agent wrote on after it, the counts summed over its agents, how many
of them ended on a rejected request, by reason, its agents by effort, how often it was launched
when it was resumed, [Claude Code's own record](#claude-codes-run-record) of it — a dash without
one — and its ID; a launch
the type and model it asked for,
its ID, when it was made and who made it. Anything absent is `–`, and a record without a single
request shows dashes, never zeros. Every row says itself how it is laid out — a figure beside its
label, or a sentence under it across the whole width, which a narrow panel breaks between its words
and never between a figure and its unit (`15 min 40 s` may wrap after `min`, never inside `40 s`)
— and which row the live clock ticks in;
the page does not guess either from a row's words.

**ID and Copy ID.** The `ID` row holds the whole identifier the node stands for — the agent's id,
a launch's tool-call id, a run's id, a session's id — and the `Copy ID` button beside it puts that
id on the clipboard, and nothing else. *Token Pace: Copy Agent ID* in the Command Palette does
the same for the selected node — it reads the id off the stored selection itself, so it copies it
also while the node's row is hidden inside a closed branch — and says so when no node is selected.
A run's [collector](#agents-without-a-counted-reply) has no `ID` row, and the command copies
nothing for it.

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
bound at all. The rows of the tree and of the running list carry the mark inside the usage — `⚠`,
its title the reason, *lower bound* to a screen reader —, the details' Output row says it with the
numbers, and the markdown report marks the line — ` ⚠` behind the usage — and says once, at the
end, what the mark means. No line under the tree speaks of it.

## What is read

Everything comes from the directory Token Pace already reads for the token counts
(`~/.claude/projects/`, or `~/.config/claude/projects/`), and every field is named here:

| File | Taken from it | Never read |
|---|---|---|
| `<session>/subagents/agent-<id>.jsonl`, and `<session>/subagents/workflows/<run>/agent-<id>.jsonl` for an agent of a workflow run | what every transcript is read for — the token counts, the model, the time, the names of tool calls ([Counting](counting.md)): of a reply's `tool_use` blocks the `type`, the `name` and the `id`, and the `name` of the last one is kept for the agent with its line's time (at most 100 characters of `[A-Za-z0-9_.:@/-]`, else none); of a reply's line its top-level `effort` — one of `low`, `medium`, `high`, `xhigh` and `max`, any other value none; the tool results marked `is_error`, counted on the raw line by the literal `"is_error":true` — the line is not parsed for it; of a reply's message its `diagnostics`' `cache_miss_reason` — the reason's `type` (one of `previous_message_not_found`, `unavailable`, `messages_changed`, `model_changed`, `tools_changed` and `system_changed`; any other is not counted) and the `cache_missed_input_tokens` it states —, once per message, on its first line; a nested agent lies flat beside the one that spawned it | any text, a tool call's `input` — and an `effort` inside it —, an error line's `perTurnEffort`, the tool result itself, and anything else of the `diagnostics` |
| `agent-<id>.meta.json` beside each agent transcript | `agentType`, `model`, `spawnDepth`, `toolUseId` and `parentAgentId` — the id of the agent that spawned it, the link where no launch names a spawner — from a file of at most 64 KB, never through a link | `description`, `prompt`, `requestShape`, `requestNonInteractive`, `workflowPhase`, `worktreePath` (a path), `worktreeBranch`, `spawnedWithWorktree`, `stoppedByUser`, and every other field |
| every Claude Code transcript — a session's and an agent's | of a counted reply — and of an agent's API error line — the top-level `version`: three numbers, `2.1.281`, any other value none; of a user line — the prompt — the top-level `permissionMode`, matched on the raw line, one of `default`, `acceptEdits`, `bypassPermissions`, `plan` and `auto` — the line is never parsed for it; of a compaction's line — a `system` line whose `subtype` is `compact_boundary`, recognised on the raw line and then parsed — its `compactMetadata`: the `trigger` (`manual` or `auto`), `preTokens` and `postTokens`, and the line's time | the prompt and everything else of a user line; of a compaction its `preservedSegment`, `preservedMessages`, `preCompactDiscoveredTools`, `cumulativeDroppedTokens` and how long it took, and the `isCompactSummary` line after it, which holds the summary — that line is never parsed at all |
| `<session>/subagents/workflows/<run>/journal.jsonl` | `type`, `key` and `agentId` at the head of each line, matched on the raw line — a line of at most 16 KB without that head is parsed for the same three, a longer one skipped and counted; the `key` is compared within the journal, never kept: with the keys of the same journal's other lines, to tell a step that was started again from a new one, and it is never stored, shown, exported or logged | the `result`, `label` and `phase` a line carries |
| the transcript that launched an agent — the session's, or another agent's | an `Agent` (or `Task`) tool call: its `id` and three fields of its input, `subagent_type`, `model` and `run_in_background` | the input's `description` and `prompt` |
| the same | the tool result that answers it: `agentId`, `status`, `totalTokens`, `totalDurationMs` and `totalToolUseCount`, and the `tool_use_id` it answers | its content — the prompt and the answer it also carries |
| the same | a queued task notification, the way a background agent's end arrives: the `<tool-use-id>` and `<status>` tags inside it | its `<summary>` and its `<output-file>` |
| `<session>/subagents/…/agent-<id>.jsonl`, an API error line (`isApiErrorMessage`) — a request the API rejected | `apiErrorStatus` (an HTTP status, 100 to 599), `error` (one of `rate_limit`, `server_error`, `invalid_request`, `authentication_failed`, `max_output_tokens`, `overloaded`) and, of its `quotaLimits` block, the `rateLimitType` (one of `five_hour`, `seven_day`, `seven_day_opus`, `seven_day_sonnet`); any other value is none; a main session's error lines are skipped | its `message` — the error's text —, `errorDetails`, `apiError`, `perTurnEffort`, `requestId`, and everything else of `quotaLimits`: its `status`, `resetsAt`, `overageStatus`, `overageDisabledReason`, `isUsingOverage`, `upgradePaths` and `unifiedRateLimitFallbackAvailable` |
| `<session>/workflows/<run>.json` — Claude Code's run record, beside the session's `subagents/` directory, named by the run's id | seven top-level fields — `status` (one of `completed`, `failed`, `killed`, `stopped`, `cancelled` and `running`), `startTime`, `durationMs`, `agentCount`, `totalTokens`, `totalToolCalls` and `defaultModel` (a model id of `[A-Za-z0-9_.:@/-]`, with a bracketed suffix such as `[1m]`) —, taken by a key-picker that walks the file's bytes in 64 KB chunks and decodes a top-level key of at most 64 bytes and, of the seven, a value of at most 64 bytes, nothing else; only from a regular file of at most 4 MB, never through a link; a value of another shape is none | everything else, never decoded: its `script`, `scriptPath`, `args`, `logs`, `phases`, `workflowProgress`, `result`, `summary`, `error`, `workflowName`, `taskId`, `timestamp` and `runId` |
| the transcript that launched a workflow run | a `Workflow` tool call: its `id` alone — of a reply's `tool_use` blocks the `type`, the `name` and the `id` are read, and the `input` only of an `Agent` or `Task` call; from the tool result that answers it the `runId` (`wf_` and at most 61 characters of `[A-Za-z0-9_-]`) and the `status`, and the `tool_use_id` it answers; the run's end arrives as a task notification, read as above | the call's whole input — its `script`, `scriptPath`, `args` and `description` — and the result's `summary`, `scriptPath`, `transcriptDir` (a path), `workflowName`, `taskId` and `taskType` |

So from a `Workflow` tool call its `id`, and from the result that answers it the `runId` and the
`status`: the run id is only compared with the name of the run's directory — the id the run's name
and its `ID` row show already. Each of those lines also gives its own time stamp, where it
carries one — a journal line carries none, so a run's last activity is its journal's
modification time. For the agent tables nothing
else is read: never a `description`, a `prompt`, a `summary`, an `output-file`, a `content`, a
`result`, a `label` or a `phase`, never a workflow's `script`, `scriptPath` or `transcriptDir`,
never an API error's text or its `errorDetails`, never a tool result, never a compaction's summary,
never a sidecar's `workflowPhase` or `worktreePath`, never a run record's `logs`, `phases` or
`workflowProgress`, never a working directory, never any text. A
permission mode named before a transcript's first counted reply — where the prompt line that names
it sits — waits in memory for the record that reply makes, for at most **4000** transcripts, the
oldest dropped first, and is not stored before it. Every string that is kept is an identifier and is checked on the way in: a type or a
model alias is at most 40 characters of `[A-Za-z0-9_.:@/-]`, a model id from a response at most
64 of the same, an id at most 64 characters of `[A-Za-z0-9_-]`, a depth a whole number from 1 to
99, a Claude Code version three numbers of at most 3, 3 and 4 digits (`2.1.281`). A value that does not fit is dropped whole rather than trimmed into a string nobody wrote,
and the tree shows the gap as `–`, as it does for older Claude Code builds that write no sidecar
at all; only a session id, which no record can do without, is cut down to the id alphabet
instead. The log gets counts, never a value.

What is kept lives in the token snapshot (`state.json` in the extension's own storage): per agent
transcript and per session transcript the ids, the agent's type and model names, the first and
last time, the token counts, the number of tool calls and the recorded result with the parent's
word for it (one of `completed`, `failed`, `error`, `timeout`, `killed`, `cancelled`,
`stopped`), and for an agent its last rejected request — its time, its HTTP status, its error
kind and its limit, each one of the values listed above — an agent whose transcript holds nothing
but rejected requests has a record from the first of them, its counts all zero —, the name of
its last tool call with that line's time, the effort of its newest reply and every other one its
replies carried (at most the five levels), and the context of its newest request — a count —, its
tool errors, its cache misses by reason with the tokens they state, and for an agent and a session
alike the Claude Code version that wrote its newest reply, the permission mode its prompt last
named, how often it was compacted and its last compaction — the time, `manual` or `auto`, and the
context before and after it; per launch its tool-call id, the type and model it asked for, whether it runs in the
background, its result with that word and the parent's three totals; per `Workflow` call its
tool-call id, the run id its result named, when it was made, and the run's end with the parent's
word for it; per workflow run the agents
its journal started, each with the ordinal of its step, its attempt, the journal's outcome and the
attempt that superseded it, how many further ones it did not list, and when the journal last
changed — never a key —, and the seven fields of its run record with the record file's size and
modification time, by which a record that did not change is not read again. The records are keyed by the transcript's path, as every transcript's read
position always was. The CSV and JSON exports carry of each agent record what the tree shows of
it — its ids, its type, model and effort, its state, counts and times, who launched it and Claude
Code's report — in the agents file beside the CSV and the `agents[]` of the JSON (see
[Export and diagnostics](export.md)); never a path, a journal key, a rejected request, its last tool call, its version, its
permission mode, its cache misses or its compactions — of the metadata only the count of its tool errors. The
clipboard summary and the diagnostics report carry none of it. The tables do not depend on `tokenPace.attribution` — see
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
fill in raises the revision, and the rebuild runs once more. The rebuild also reads an agent's
sidecar again when the identity it kept names no spawning agent — the fifth field, `parentAgentId`,
came with 1.6 — and keeps that identity when the file is gone; an agent whose transcript the rebuild
could not read again counts no tool errors, and its details have no `Tool errors` row rather than a
zero nobody counted. It reads each run's [record](#claude-codes-run-record) once, too — one that
did not change since it was last read is not opened again. *Re-read Token History* rebuilds them
with everything else. A first start with no stored state, a re-read and a switch of
`tokenPace.attribution` read every line from its first byte and fill the agent tables as they go,
so no rebuild follows them — the tree does not stand half built for a moment after they end. The
log states how much was read, in counts only.

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
  The keyboard focus stays on its row through a push — on the running list's row, or on the
  tree's item it was on, else the nearest item above it that is still shown (see
  [The keyboard](#the-keyboard)).
* The clocks of the running list (`running for …`) and of the tree (the time since the start, in
  the duration's place) and the last activity in the details tick every second in the page itself
  — no message, no redraw — and so does a running agent's `silent for …`, which the same timer
  shows once three minutes have passed. When a clock grows a unit — `59 s` to `1 min 00 s` — or a
  silence appears, its row's figures are fitted to the line again.
* The recursive file watcher can miss the files of a directory created after it started — on
  Linux it does — so while an agent runs, or while a session is active, the agent directories of
  the active sessions are also listed every **5 seconds**, on every platform; the one-minute
  sweep stays as the last net. An active session is enough: it may start an agent or a workflow
  run at any moment, and the agents of a workflow run are started by the run, not by a call the
  session's transcript records, so the first file of a new run is found within five seconds rather
  than a minute. A pass costs a few milliseconds.
  With every session idle and nothing running, the listing stops.
* A run's [record](#claude-codes-run-record) is read by the same pass for the runs of the active
  sessions, and by the one-minute sweep for every other run whose record has not stated an end —
  each only when the file's size or modification time changed since it was last read: one `lstat`
  otherwise, and a record that says its run ended is left alone by the sweep.
* The tree carries no time of its own, so a tree that did not change is not sent to the page
  again.
* **Only what changed is rebuilt.** A read that changed the agent tables alone — a journal line,
  a result or a notification the parent recorded, a sidecar — rebuilds the Agents section and the
  status bar entry, nothing else. A running agent's reply also counts tokens, which the other
  sections show: while agents write, those sections are rebuilt at most once every **5 seconds**,
  the tree and the status bar at every read. So while agents run, the figures of the other
  sections can be up to five seconds behind the tree; the status bar's token entry is not.
* **Saved every 10 seconds while agents run.** While the agent directories are listed (above), the
  state is saved at most once every **10 seconds** instead of every 5, and closing the window saves
  what is left. With several windows open the ones that follow the leading window read its saved
  state, so while agents run they see an agent's change up to about 11 seconds late. A window that
  takes over the lead reads on from the last save: the cursors and the counts are saved together,
  so nothing is lost and nothing counted twice.

## Opening and selection

A node with children has a toggle (▸ closed, ▾ open) in front of its row — a click on it, or `→` and
`←` on the item, opens and closes it; the tree starts with every node closed. Which nodes you opened and which node's details are open are kept with the
rest of the dashboard's view state — range, sort, filters, folded sections — in the extension's
own storage, so they survive a push, a reload and a restart; selecting a node never opens
anything by itself. Only node keys are kept, made of the session, run, agent or launch id: the
opened nodes' keys and the selected one's — with which of its rows its details open under, the
tree's, the running list's or the 7-day block's — and whether the [7-day block](#last-7-days) is
open, never a label, a figure or anything from a
transcript, and at most 200 opened nodes: opening one more forgets the one opened longest ago,
so a node can always be opened, and the key of a node that has left the tree does not keep its
place for good. A key whose node has gone matches nothing. How many children an opened node shows
is kept the same way: the "more" steps of at most 200 nodes, the one taken longest ago forgotten
first, and closing a node forgets its steps — opened again, it shows its first fifty. The details
open for a node whose row is on the page — in the tree, in the running list, or among the open
7-day block's largest agents. A selected node
inside a closed branch has no row there: its details stay shut, without a word, until the branch
is opened again, and the markdown report, which prints every node, shows them all the same. A
selected node that is gone says so instead (`The selected node is no longer in the tree.`). That
is an agent or a launch older than seven days, a session without agents that has been quiet for
more than 24 hours, and any node of a session beyond the 20 listed that neither the running list
nor the open 7-day block names — the session itself, or one of its agents once it has stopped
running and is not among the largest. *Clear Stored
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
`tokenPace.attribution`, which decides whether a session may name its project. The running count
can also go on the status bar: `agents` in `tokenPace.statusBar.show` (see
[Running now](#running-now)).
