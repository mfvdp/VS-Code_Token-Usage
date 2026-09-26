<!--
SPDX-FileCopyrightText: 2026 Frederik Marx
SPDX-License-Identifier: AGPL-3.0-or-later
-->

# Prompts

Part of the [Token Pace documentation](../README.md#documentation).

The Prompts section of the dashboard is your own list of prompts for Claude Code and Codex. A
double-click on a prompt types its text into the VS Code terminal that runs Claude Code or Codex and
presses Enter — always on your click, never on its own. The list starts with three prompts Token Pace
ships; you can change them, delete them, add your own and bring the shipped ones back with
*Token Pace: Restore Default Prompts*.

## Adding the section

The section is not in the default. Add `prompts` to `tokenPace.dashboard.sections` — anywhere in the
list, first for the quickest reach:

```json
"tokenPace.dashboard.sections": ["prompts", "quota", "agents", "tokens", "summary", "kpis", "chart", "models", "heatmap", "hours", "dataQuality"]
```

It has no setting of its own: the list is yours and lives in a file of the extension's storage
([below](#where-the-prompts-are-kept)). While `prompts` is not listed, the dashboard does not look at that file; only *Clear Stored
Data…* (to count its prompts) and *Token Pace: Restore Default Prompts* read it then. The section serves Claude Code and Codex alike, so it stays on the page whatever the
provider switch shows, and neither the range nor a model chip filters it. It is the dashboard
panel's only: the Quick Pick and markdown modes of `tokenPace.dashboard.mode` have no prompts.

## The list

The three shipped prompts, in this order:

| Title | Text |
|---|---|
| Status table | `Show the current progress in a clear table. Columns: step/status \| description \| model \| duration \| expected to finish.` |
| Keep the cache warm | `Ignore this message. No action. No response.` |
| Stop after this task | `Stop after the current task and do not start any new work.` |

Until you edit one, a shipped prompt's title and text follow the language of Token Pace's texts
(`tokenPace.language`) — in German *Zwischenstand als Tabelle*, *Cache warmhalten* and *Nach dieser
Aufgabe stoppen* —, except the keep-warm prompt's text, which stays English in every language, as the
[keep-warm line](prompt-cache.md#keep-warm-in-a-terminal-opt-in) does. A prompt you edited keeps your
words whatever the language; saving a shipped prompt with exactly its shipped words in the current
language makes it follow the language again.

Every prompt has a title of 1 to 80 characters and a text of 1 to 2000 characters, and the list holds at
most 50 prompts. A prompt is one line: when it is saved, a line break or a tab becomes a space, every
other control character is removed and the ends are trimmed — VS Code types the text into the terminal
as keys, and a line break inside it would make Claude Code send the first line on its own. A text that
starts with an exclamation mark is refused (*A prompt that starts with an exclamation mark would run a
shell command in Claude Code.*): `!` is Claude Code's shell escape. A text that starts with `/` is a
slash command and is shown in the editor font; one that starts with `#`, `@` or `?` is allowed as well
— Claude Code reads those as a memory note, a mention and a request for help.

*Token Pace: Restore Default Prompts* — in the Command Palette, and the section's button while a shipped
prompt is missing — adds every shipped prompt missing from the list at its end, in their order, and
says how many it brought back, or *every default prompt is there already*. A shipped prompt you edited
is not missing: it stays as you wrote it.

When `prompts.json` cannot be read — it is not JSON, not the shape below, larger than 512 KiB, or
reading it failed — the section shows the three shipped prompts, every change is refused, and a box says
so: *prompts.json could not be read (json). The shipped prompts are shown, and nothing is saved until the
file is fixed or deleted (Token Pace: Clear Stored Data…).* A file written by a newer version of Token
Pace is shown the same way and never changed. The file itself stays as it is, for you to repair or
delete. When a change is refused, the section says why: *Not saved: The title is empty.*, *Not saved:
the list is full (at most 50 prompts)*, *Not saved: prompts.json could not be written (EACCES)*.

## Where the prompts are kept

In one file of the extension's storage — `prompts.json` in Token Pace's `globalStorage` folder — shared
by every window of your VS Code profile. It is written only when you change the list — save, delete,
move or restore —, never when you only look at it: until your first change there is no file, and the
three shipped prompts come from Token Pace itself. A change that changes nothing writes nothing. Every
change reads the file again first and changes one prompt by its id, and the file is written whole — a
temporary file, then a rename —, so a change another window made in between is kept; the other window
shows it with its next update. When two windows save the same prompt, the later save wins. A write that
fails leaves the old file as it was.

The file holds `v`, the version (`1`), and `prompts`, the list in its order. A prompt holds its `id` —
`s-status`, `s-keepwarm` and `s-stop` for the shipped ones, `u-` and eight lower-case letters or digits
for yours — and, for one of yours and for a shipped one you edited, its `title` and `text`; an unedited
shipped prompt is its `id` alone. Nothing else: no time, no session, no terminal, no path, no count of
sends. Token Pace reads the file back by exactly this shape — anything else makes it unreadable, and it
is never repaired:

```json
{ "v": 1, "prompts": [
    { "id": "s-status" },
    { "id": "s-keepwarm", "title": "Keep warm (loop)", "text": "/loop 30m Ignore this message. No action. No response." },
    { "id": "u-3k9x0a2b", "title": "Review", "text": "Review the last diff for correctness." } ] }
```

Your prompts are your data. A title or a text is shown on the dashboard and typed into the terminal you
send it to — and nowhere else: never in the log, the diagnostics report (not even a count), the CSV or
JSON export, *Copy Usage Summary*, the usage document, the usage Quick Pick or the status bar. The log
says what was done and whether it was a shipped prompt or one of yours — `Prompts: saved a user
prompt.` —, never its words. `prompts.json` is not part of VS Code's Settings Sync, and the list has no
export and no import. *Clear Stored Data…* lists it as *Prompts (prompts.json)* with the number of
prompts it holds; deleting it returns the list to the three shipped prompts.

## Sending

A double-click on a prompt — or its send button, or Ctrl+Enter (⌘+Enter on a Mac) on it — sends it: Token
Pace types the prompt's text into the terminal that runs Claude Code or Codex and presses Enter. It is
always your action on that prompt at that moment: nothing is sent by a timer, a command, a link or a
notification. At most one prompt goes per second (`PROMPT_SEND_MIN_GAP_MS`, 1000 ms), and never while the
terminal pick or the question below is open — a key held down, a triple click or a second double-click
while the first send is under way sends once; the log then says `Prompts: a send was dropped (another one
is under way)`. The text is the prompt as the list holds it at that moment, read from `prompts.json` (or,
for an unedited shipped prompt, its words in the language of now): the dashboard page only names the
prompt and never hands over a text of its own.

The text and the Enter are two writes (`sendText`): the text first, then, 200 milliseconds later
(`PROMPT_ENTER_DELAY_MS`), the Enter alone. Typed in one piece with its Enter, a longer text does not go:
Claude Code takes such a chunk as pasted text and keeps the Enter as a line break — a 119-character prompt
stayed in its input box that way, unsent —, while the Enter typed on its own sends it. Should the window
close between the two writes, the Enter is not typed: the text then waits in the input line.

**Anything you typed in that terminal and did not send goes with the prompt.** Token Pace cannot read a
terminal's input, so a half-typed line there and the prompt go out as one message. The section's first
line says so, always, and so does the question below.

After the send the terminal is shown and the keyboard stays on the dashboard; the section says *Sent to
Claude Code in terminal 2 of 3.* for ten seconds, and a screen reader hears it once. The log says
`Prompts: sent a prompt to Claude Code in terminal 2 of 3` — never a title or a text. Nothing is read back
from the terminal: not its output, not what Claude Code or Codex shows. When VS Code does not take the
text — the terminal has gone —, the section says *Not sent: The terminal did not take the text.*

The *Keep the cache warm* prompt types the [keep-warm line](prompt-cache.md#keep-warm-in-a-terminal-opt-in)
by hand: it is your own request and is not counted in `keepwarm.json`. A keep-warm countdown running for
the terminal a prompt goes into ends without its line, and keep-warm waits for that session's next
request, as after a click on the countdown — your prompt is already on its way.

A prompt that starts with `/` is a slash command for Claude Code. Typed into an idle Claude Code in a test,
`/loop 30m Ignore this message. No action. No response.` became one scheduled task that sends the line
every 30 minutes for as long as that Claude Code session runs; Claude Code's `/exit` then asks whether to
stop it. Every such line is a real request on your usage.

## Which terminal

A prompt goes into a terminal of this VS Code window that runs Claude Code or Codex — never another
terminal, never a terminal of another window, and never Claude Code in the Claude Code extension's own
panel, which no extension can type into. When the active terminal (the one that has the focus, or had it
last) runs Claude Code or Codex, the prompt goes there. Otherwise Token Pace offers a pick of exactly the
terminals that do, in their order, each named by its place in the window's list of terminals — *Claude
Code — terminal 2 of 3* — with *ready*, *sending asks first* or *not now* beside it and the reason under
it; Escape sends nothing. A terminal's name is never read: Claude Code sets it to a summary of the
conversation.

The section's second line says where a prompt would go now: *Sends to Claude Code in terminal 2 of 3 —
ready*, *Sends to Claude Code in terminal 2 of 3 — sending asks first: …* or *… — not now: …* with the
reason, *Sends to the terminal you pick: 2 terminals run Claude Code or Codex.*, or *No terminal of this
window runs Claude Code or Codex.* It follows the terminals as they open, close, become active and start
or end a program.

Token Pace knows such a terminal from VS Code's shell integration only — the facts the keep-warm line
reads: a command that started in the terminal and has not ended, whose command line starts with `claude`
or `codex` (a path ending in either, `claude.exe`, `codex.exe`), reported with medium or high confidence,
and VS Code's own word for what runs in the terminal, `claude` or `codex`; a terminal VS Code reports
another program in (`bash`, `pwsh` …) never counts, whatever ran there before. It listens to those facts
while the Prompts section is listed and the workspace is trusted (or while the keep-warm line may act),
and to nothing otherwise. A terminal without shell integration is never offered. For a terminal whose
Claude Code or Codex started before Token Pace began to listen — before a window reload, or before you
added the section — there is no start to go by; VS Code still says what runs there, and for the folder
Token Pace reads the one the shell reports: of the terminal its `shellIntegration`, of that the `cwd`, of
that the `fsPath`, compared with the folders of the sessions and kept by no one. Such a terminal asks
first, because Token Pace did not see Claude Code start there: restart Claude Code in it after a reload
for the full check. [Privacy](privacy.md) lists every field.

Codex is recognised by the same rule — VS Code names its shell `codex` as it names Claude Code's `claude`
— but sending was tried with Claude Code only (2.1.282 and 2.1.283), not with Codex.

## When Token Pace does not send, or asks first

Before anything is typed, Token Pace checks the terminal and — for Claude Code — every session whose
transcript lies in that terminal's folder, from facts it keeps anyway: a session's first and newest reply,
how the newest ended, whether a line of yours came after it, whether an agent of it runs, and — with the
[agent hook](agents.md#the-agent-hook) installed — whether a permission request is open. Of a Codex
session it reads nothing. The first check that fails decides. Where Token Pace knows a send is unsafe it
does not send and says why — a message, *Token Pace: the prompt was not sent. …*, and the section's
*Not sent: …* —; the log names the check's code, `Prompts: not sent (hookWait)`. Where the transcript
cannot tell Claude Code at work from Claude Code waiting in a dialog, it asks first: *Send “Status table”
anyway?*, with the reason and *If Claude Code is showing a permission dialog or a question there, the text
and Enter would answer it. Text typed in that terminal and not sent yet goes with it.* (for Codex: *If
Codex is waiting for an approval there, the text and Enter would answer it. …*). *Send anyway* sends —
after every check has run once more on the facts of that moment; a check that now says never still
stops it. Nothing of your answer is kept: the next send asks again.

| Check | Sends | What Token Pace says |
|---|---|---|
| `restricted` | never | *Restricted Mode: Token Pace types nothing into a terminal in a workspace you have not trusted.* |
| `reading` | never | *Token Pace is reading the transcripts; try again in a moment.* |
| `noTerminal` | never | *No terminal of this window runs Claude Code or Codex (VS Code's shell integration reports none).* |
| `codex` | asks first | *Token Pace reads nothing of a Codex session's state: it cannot tell whether Codex is at work or waiting for an approval.* |
| `unknownFolder` | asks first | *VS Code reports no folder for that terminal, so Token Pace cannot tell which session runs there.* |
| `hookWait` | never | *Claude Code is asking for a permission in a session of that folder. Answer it first.* |
| `unknownStart` | asks first | *Token Pace did not see Claude Code start in that terminal, so it cannot tell which session runs there.* |
| `noSession` | never | *Claude Code in that terminal has not written a line since it started, so it may still show a dialog of its own (trusting the folder, signing in, the list of --resume). Send the first message by hand.* |
| `openTool` | asks first | *Claude Code is at work there, or waiting for your answer in a dialog; its transcript cannot tell which.* |
| `notIdle` | asks first | *Claude Code's last reply there did not end its turn.* |
| `agentRunning` | asks first | *An agent of that session is running.* |
| `otherSession` | asks first | *Another Claude Code session of the same folder is at work or waiting for an answer.* |

In words: in Restricted Mode nothing is typed (the list can still be edited); while Token Pace reads the
transcripts — the first scan after the window opened, a re-read, the replay for the Agents tables — the
sessions' records are being rebuilt and no check could be trusted; a permission request the agent hook
saw open would be answered by the text and Enter. A Claude Code that has not written a line since it
started may still show a dialog of its own, and a text typed into an open dialog answers it and is lost:
a fresh `claude` showed three such dialogs before its prompt was empty — the question whether to trust
the folder, with *No, exit* highlighted, so that Enter would end Claude Code, a notice about the terminal,
a question about browser tools. So the first message after a start is yours to type. A session counts as
the terminal's when it wrote a line after the terminal's `claude` started — its own, or one it resumed —;
a Claude Code whose start Token Pace did not see, or whose folder VS Code does not report, cannot be tied
to a session, and asks first. Then each of those sessions must have finished its turn — its newest reply
ended it, and no line of yours came after it — with no agent of it running, and every other session of
the folder must be idle the same way, unless it was left behind: no agent of it running, and its newest
line at least 2 hours old and older than the moment the terminal's `claude` started (the
[keep-warm line's](prompt-cache.md#keep-warm-in-a-terminal-opt-in) check 13 does the same). Unlike the
keep-warm line, a prompt needs no minute of quiet after a reply: you are at the keyboard. A known limit:
another Claude Code of the same folder that wrote after this terminal's `claude` started counts as the
terminal's own, so a fresh `claude --resume` list standing in this terminal goes unseen then (the folder
question cannot stand there: the folder has sessions, so it was trusted before).

*Status table* and *Stop after this task* are meant for a Claude Code at work, so they will usually ask
first. What Claude Code does with a prompt that comes while it works is its own: it queues what is typed
during a turn — in a test a prompt typed while Claude Code ran a command was answered afterwards, with
nothing lost and nothing interrupted. [Troubleshooting](troubleshooting.md#a-prompt-was-not-sent) says
what to do about each check.
