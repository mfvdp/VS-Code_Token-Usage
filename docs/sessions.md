<!--
SPDX-FileCopyrightText: 2026 Frederik Marx
SPDX-License-Identifier: AGPL-3.0-or-later
-->

# Sessions and projects

Part of the [Token Pace documentation](../README.md#documentation).

`tokenPace.attribution` is `none` by default. With `project` or `session`, Token Pace files your usage by
project and keeps a record per session transcript, in its own extension storage. With `none` nothing of this
is read or written: no key, no name, no record, and no salt.

## How a project is found

A project is a folder. Claude Code keeps every session started in a folder — and every agent those sessions
ran, also an agent that worked in a worktree — under one directory below its projects root, named after the
folder: every character outside `A–Z`, `a–z` and `0–9` becomes `-` (`/home/u/token-pace` →
`-home-u-token-pace`). Token Pace takes that directory's name — the one `slug` segment directly below
`~/.claude/projects/`, of the path it reads anyway, never a line's field — and makes a **project key** of it:
the first twelve hex digits of a SHA-256 of a fixed tag, the salt and the directory's name. For a Codex
rollout the folder is the `cwd` of its `session_meta` line, turned into the same directory name by the same
rule, so a Codex session and a Claude Code session started in the same folder count to one project. A
rollout without a `session_meta` line or without its `cwd` is **(no project)**. Of the `session_meta` line
Token Pace also reads `forked_from_id` and `thread_source` (to skip a fork's copied history, since 1.2) and,
with attribution on, the session's `id`; of a Claude line the `sessionId`. `gitBranch` is never read.

Where the rule does not join what you might think of as one project: a folder that is **renamed or moved** is
a new project for both programs (Claude Code writes the new sessions into a new directory; the old project
keeps its history, and its last activity stops); two folders whose paths differ only in characters the rule
turns into `-` (`/a/b-c` and `/a/b/c`) share a key; and how Claude Code names the directory of a very long
path (it may shorten it) is not traced.

## Names or pseudonyms

By default (`tokenPace.showProjectNames: hash`) a project is shown by its pseudonym, `p:` and the twelve
digits — `p:8f31c0a4e2b1` —, safe in a screen share. A screen reader reads it character by character; set
`showProjectNames` to `basename` to have the folder's name read instead. With `basename` the name comes from
the `cwd` of a **main** transcript's line, and only when that working directory is the project folder itself
(its directory name is the transcript's): a line of an agent — whose `cwd` may be a worktree — or of a session
that moved to a subdirectory never names the project. The name is held to the letters `A–Z` and `a–z`, the
digits and `_ . : @ -`: every other character becomes `_`, at most 64 characters (`Büro-App` shows as
`B_ro-App`). A project none of whose main lines has been read yet shows its pseudonym.

## What is stored

With attribution on, the snapshot holds the project key on every hour, day and month figure, a small label
table — per key the time of the project's newest line and, with `basename`, the folder's name —, and per
transcript a session record (its session id, the key, its counters, its models and the gaps between its
turns). Never the folder's path, a file name, or a word of a transcript in these records. The salt is 16
random bytes per installation, kept in VS Code's global state (`tokenPace.projectSalt`), created only when
attribution is switched on, and deleted with the token snapshot by *Clear Stored Data…*, so the pseudonyms
of an earlier export cannot be matched with the ones the re-read makes after it. The pseudonym protects what
Token Pace shows and exports; the extension's own storage has kept each transcript's path as the key of its
read position since 1.0, and a path holds the project's directory.

## Switching

| From → to | What happens | Re-read |
|---|---|---|
| `none` → `project` or `session` | the salt is made if there is none; the transcripts are read again | yes |
| `project` ↔ `session` | nothing | no |
| `project` or `session` → `none` | the per-project split is folded back (the totals stay exact), the label table and the session records are deleted | no |
| `basename` → `hash` | every name is dropped at once | no |
| `hash` → `basename` | the transcripts are read again (a name is read only while names are on) | yes |

A snapshot of 1.13 or earlier is read on as it is under `none`; under `project` or `session` the
transcripts are read once more, because an old snapshot has no project on its hour figures.

## Limits

At most **200 projects** keep their own key: at every roll-up the least recently active beyond 200 fold into
**other projects** (their figures added up there, nothing lost), and so does a project whose newest line is
older than `tokenPace.retentionDays` (400 days by default). The session records are kept for
`tokenPace.hourRetentionDays` (45 days by default), at most **2000** of them, the newest.

**The agent tree is not attribution.** Whatever `attribution` says, the [Agents](agents.md)
section keeps small tables of its own for **7 days**: per session transcript and per agent
transcript the session id, the agent id and the workflow run it belongs to, the agent's type and
model names, times, token counts and the recorded result, and the metadata the tree shows — the
effort of its replies, its last rejected request (HTTP status, error kind, limit), the name of
its last tool call, its tool errors, its cache misses by reason, the Claude Code version, the
permission mode and its compactions —; per workflow run the agents its journal started, their
steps and attempts, and the seven fields of Claude Code's run record — keyed by the transcript's
path, as every transcript's read position in the snapshot always was. They hold no project name,
no prompt, no description and no result (the full list is in [Agents](agents.md#what-is-read)). With
`none` a session in the tree is named by when it started and the first eight characters of its
id — `Session Tue 14:20 · 9d0eb37a` — and nothing else; with `project` or `session` it also
carries the project's label — its pseudonym, or with `basename` its folder's name. Switching back to `none` therefore leaves the tree
in place, without its project labels; its records age out seven days after their last line.
