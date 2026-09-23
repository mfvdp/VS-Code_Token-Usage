<!--
SPDX-FileCopyrightText: 2026 Frederik Marx
SPDX-License-Identifier: AGPL-3.0-or-later
-->

# Agents

Part of the [Token Pace documentation](../README.md#documentation).

The `agents` section of the [dashboard](dashboard.md) shows the Claude Code sessions of the
last **7 days** as a tree: each session, the workflow runs inside it, the agents it spawned and
the agents those spawned in turn — with the state of every node, what it used and how long it
took. It is on by default, directly after `quota` in `tokenPace.dashboard.sections`; a list you
have set yourself is kept as it is, so there the tree appears once you add `agents` to it. The
range, provider and model chips do not apply: the tree is always the last seven days, so the
filter bar stays below it. *Show Usage as Text* prints the same tree as an indented list, with
the open node's details as a table; the Quick Pick does not carry it.

Claude Code only. Codex writes no agent identity into its transcripts, and the section states
nothing about Codex.

## The tree

**Sessions** are the roots, the most recent first. A session is listed when its own transcript
recorded a response within the last 24 hours, or when it has an agent or a launch from the last
seven days. At most **20** sessions are listed; the rest are counted under the tree
(`3 older session(s) not shown.`). A session is labelled with the first eight characters of its
id (`Session 9d0eb37a`), and with its project beside it while `tokenPace.attribution` is
`project` or `session` — the label the Sessions table shows, hashed too under
`showProjectNames: hash`. With `attribution: none` no project is named anywhere in the tree.

**Below a session** come its workflow runs (`Workflow cfe7718d`) and its agents, each agent
under the agent that launched it when that one is in the same tree, otherwise directly under the
session; the agents of a run stay inside their run. Siblings are ordered by when they started. A
launch whose transcript has not appeared yet is a node of its own, in italics and named from the
launch — `Plan · sonnet · launched` — with no figures beside it, since nothing was counted.
No agent sits more than **6** levels below its session: one that would sit deeper moves up, it
is never dropped. The tree holds at most **300** nodes; past that it is cut
(`Tree cut at 300 nodes.`), keeping every listed session, the open node and every running agent
with the nodes above them, then the rest level by level, so every session keeps its top levels
before any of them keeps its deepest.

**Each row** is the state glyph, the name, the usage — fresh input + cache write + output, the
definition the tables use — and the duration from the first line to the last. A row carries no
lower-bound mark: the details do (`Output … ⚠ lower bound`), and while a row on screen has one,
a line under the tree says so — *Output figures in the details marked ⚠ are lower bounds.* A
running node also says for how long: `running for 12 min 05 s`, counted from its first line and
ticking every second. An agent's name is its type, its model and
the first four characters of its id — `Explore · claude-opus-5 · a94f`. The type is the one the
agent's sidecar names, else the one its launch asked for, else `Agent`; the model is the last one
its transcript recorded, else the alias the sidecar or the launch names, else `–`. An agent's
usage is part of the figures the totals already contain: the tree adds nothing to any sum.

## States

| Glyph | State | Kind | When |
|---|---|---|---|
| ✓ | done | recorded | the parent's tool result or task notification says `completed`, or the workflow run's journal holds a result for the agent |
| ✕ | failed | recorded | the parent recorded `failed`, `error`, `killed`, `cancelled` or `timeout` |
| ● | running | derived | nothing was recorded yet, and the agent replied — or was launched — within the last **10 minutes**, or an agent it launched is running |
| ? | unknown | derived | nothing was recorded, and the agent has been silent for longer than that |
| ● | active | derived | a session whose own transcript recorded a response within the last 10 minutes, or one of whose agents is running |
| ○ | idle | derived | a session silent for longer than that, with no agent running |

A **workflow run** is running while one of its agents runs, failed when one of them failed, done
when every one of them has a recorded result, and unknown otherwise. A **launch** whose
transcript never appeared is running for ten minutes after the launch and unknown after that,
unless the parent records its result, which makes it done or failed like any agent.

Only done and failed are facts: somebody recorded them. Everything else is inferred from when a
file last changed, and says so — the glyph's title reads `~running · derived` where a recorded
state reads `done · recorded`, and the markdown list prints `[~Running]` against `[Done]`. The
running glyph pulses unless the system asks for reduced motion, and every colour is one the rest
of the page already uses.

**The sentences.** The details panel opens with the state and the sentence it was derived with,
word for word. For an agent:

* Completed — the parent recorded the result at 14:20.
* Failed — the parent recorded the failure at 14:20.
* Running — inferred: the transcript changed 2 min ago and no result was recorded yet.
* Running — inferred: a child agent of this agent is still running.
* Unknown — inferred: no result was recorded and the transcript has been silent since 14:20; the agent may have been stopped.

A result recorded without a time is stated without one. Today that is the case for every agent
of a workflow run that no launch accounts for: the run's journal completes it, and its lines
carry no time — *Completed — the workflow journal recorded the result.* The other nodes:

| Node | Sentence |
|---|---|
| Session | Active — inferred: the session transcript changed 3 min ago. |
| Session | Active — inferred: an agent of this session is running. |
| Session | Idle — inferred: the session transcript has been silent since 09:12. |
| Session | Unknown — inferred: the session's own transcript has not been read; only its agents were. |
| Workflow run | Running — inferred: at least one agent of this run is running. |
| Workflow run | Failed — at least one agent of this run has a recorded failure. |
| Workflow run | Done — every agent of this run has a recorded result. |
| Workflow run | Unknown — inferred: not every agent of this run has a recorded result, and none is running. |
| Launch | Running — inferred: the parent recorded the launch 1 min ago and no result yet; the agent's transcript has not been seen yet. |
| Launch | Unknown — inferred: the parent recorded the launch at 14:20 but no result, and the agent's transcript was never seen; the agent may have been stopped. |

A time of today is printed as `14:20`, one of another day as `2026-09-21 14:20`.

## Details

Clicking a row — or `Enter` on it, since the fold and the row are buttons of their own — opens
the node's details under the tree; the same click again closes them. For an agent: type,
models, depth, started, duration, last activity (with a live `… ago` beside it), then turns,
usage, fresh input, cache write 5 m and 1 h, cache read, output, reasoning and tool calls, then
who spawned it and its workflow run. A session lists its project (only while attribution allows
one), its models, the same times and counts, and how many agents it has; a workflow run how many
agents it has and the counts summed over them; a launch the type and model it asked for, when
it was made and who made it. Anything absent is `–`, and a record without a single request
shows dashes, never zeros.

**Parent's report.** When an agent runs synchronously, the tool result that returns it to its
parent carries the parent's own count — tokens, duration and tool calls. That row is shown as
what it is, *the parent's own count, not added to any total*: it need not follow the definition
*usage* follows, and adding it to ours would count the agent twice.

**Why the output is a lower bound.** Claude Code writes no end marker into an agent's
transcript — a finished agent's file ends on an assistant line whose `stop_reason` is still
`null` — so its last reply is counted as far as it was written, and almost every finished
agent's output carries `⚠ lower bound` in its details. A mark on nearly every row would say
nothing, so the tree rows carry none; the line under the tree points to the details instead.

## What is read

Everything comes from the directory Token Pace already reads for the token counts
(`~/.claude/projects/`, or `~/.config/claude/projects/`), and every field is named here:

| File | Taken from it | Never read |
|---|---|---|
| `<session>/subagents/agent-<id>.jsonl`, and `<session>/subagents/workflows/<run>/agent-<id>.jsonl` for an agent of a workflow run | what every transcript is read for — the token counts, the model, the time, the names of tool calls ([Counting](counting.md)); a nested agent lies flat beside the one that spawned it | any text |
| `agent-<id>.meta.json` beside each agent transcript | `agentType`, `model`, `spawnDepth`, `toolUseId` — from a file of at most 64 KB, never through a link | `description`, `prompt`, and every other field |
| `<session>/subagents/workflows/<run>/journal.jsonl` | `type` and `agentId` of each line | the `key` and the `result` a line carries |
| the transcript that launched an agent — the session's, or another agent's | an `Agent` (or `Task`) tool call: its `id` and three fields of its input, `subagent_type`, `model` and `run_in_background` | the input's `description` and `prompt` |
| the same | the tool result that answers it: `agentId`, `status`, `totalTokens`, `totalDurationMs` and `totalToolUseCount`, and the `tool_use_id` it answers | its content — the prompt and the answer it also carries |
| the same | a queued task notification, the way a background agent's end arrives: the `<tool-use-id>` and `<status>` tags inside it | its `<summary>` and its `<output-file>` |

Each of those lines also gives its own time stamp, where it carries one — a journal line today
carries none. For the agent tables nothing else is read: never a `description`, a `prompt`, a
`summary`, an `output-file`, a `content` or a `result`, never a working directory, never any
text. Every string that is kept is an identifier and is checked on the way in: a type or a
model alias is at most 40 characters of `[A-Za-z0-9_.:@/-]`, a model id from a response at most
64 of the same, an id at most 64 characters of `[A-Za-z0-9_-]`, a depth a whole number from 1 to
99. A value that does not fit is dropped whole rather than trimmed into a string nobody wrote,
and the tree shows the gap as `–`, as it does for older Claude Code builds that write no sidecar
at all; only a session id, which no record can do without, is cut down to the id alphabet
instead. The log gets counts, never a value.

What is kept lives in the token snapshot (`state.json` in the extension's own storage): per agent
transcript and per session transcript the ids, the agent's type and model names, the first and
last time, the token counts, the number of tool calls and the recorded result; per launch its
tool-call id, the type and model it asked for, whether it runs in the background, its result and
the parent's three totals. The records are keyed by the transcript's path, as every transcript's
read position always was. None of it is part of the CSV or JSON export, the clipboard summary or
the diagnostics report. The tables do not depend on `tokenPace.attribution` — see
[Sessions and projects](sessions.md).

## Kept for seven days

A record is dropped at the first roll-up **7 days** after its last line, whatever
`tokenPace.retentionDays` says, and the tree never shows an older one. There is no setting for
it: the tree has nothing to show for older agents, and the snapshot would carry them along on
every save.

**The one-time rebuild.** A snapshot written before 1.5 has no agent tables. On the first start
after the update they are rebuilt once from the Claude transcripts that changed in the last seven
days — each read only as far as its tokens were already counted, so no token is counted twice and
no total moves. *Re-read Token History* rebuilds them with everything else. The log states how
much was read, in counts only.

## Live

* The file watcher reports a changed transcript within about a second, as it does for the token
  counts.
* The section is pushed at most once every **2 seconds**. A running agent writes a line every
  0.6 seconds at the median, and every push redraws the tree; the other sections are not held
  back by it, and a fold or a click of yours is answered at once.
* The `running for …` clocks and the last activity in the details tick every second in the page
  itself — no message, no redraw.
* The recursive file watcher can miss the files of a directory created after it started — on
  Linux it does — so while an agent runs the agent directories of the active sessions are also
  listed every **5 seconds**, on every platform; the one-minute sweep stays as the last net.

## Folding and selection

A node with children has a fold (▾ / ▸) in front of its row. What you fold and which node is
open are kept with the rest of the dashboard's view state — range, sort, filters, folded
sections — in the extension's own storage, so they survive a push, a reload and a restart. Only
node keys are kept, made of the session, run, agent or launch id: never a label, a figure or
anything from a transcript, and at most 200 folded nodes. A key whose node has gone matches
nothing, and an open node that has left the tree says so (`The selected node is no longer in the
tree.`). *Clear Stored Data…* removes them with the rest of the dashboard view state.

## Limits

* **Claude Code only.** Codex records no agent identity; its subagent turns are counted in the
  totals as they always were.
* **Only the transcripts Token Pace reads.** An agent that runs on another machine — another
  computer, or the far side of a remote or a container this extension does not run in — is
  invisible here; see [Windows, WSL and remote development](windows-wsl-remote.md) for which
  side reads the transcripts.
* **No end marker.** An agent that was stopped — interrupted, its session closed, its process
  gone — has no recorded result, so ten minutes after its last reply it reads `unknown`, never
  `done`.
* **Waiting can look like silence.** The states are read from replies. An agent waiting on an
  agent it launched reads `running` while that agent runs, and a session reads `active` while
  one of its agents runs — both say they were inferred from below. An agent that waits longer
  than ten minutes on anything else — one long tool call — reads `unknown` until its next
  reply.

## Settings

The section has no setting of its own. The gear in its header opens the two it depends on:
`tokenPace.dashboard.sections`, where `agents` can be moved or removed, and
`tokenPace.attribution`, which decides whether a session may name its project.
