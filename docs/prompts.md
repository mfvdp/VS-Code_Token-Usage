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
Aufgabe stoppen*, and likewise in each of the other twenty-four languages; the German status prompt keeps
the author's own wording, the twenty-four translate the English —, except the keep-warm prompt's text, which
stays English in every language, as the
[keep-warm line](prompt-cache.md#keep-warm-in-a-terminal-opt-in) does. A prompt you edited keeps your
words whatever the language; saving a shipped prompt with exactly its shipped words in the current
language makes it follow the language again.

Every prompt has a title of 1 to 80 characters and a text of 1 to 2000 characters, and the list
holds at most 50 prompts, the characters counted as the field counts them (an emoji counts two). A
prompt is one line: when it is saved, a line break or a tab becomes a space, every other control
character is removed and the ends are trimmed — VS Code types the text into the terminal as keys,
and a line break inside it would make Claude Code send the first line on its own. A text that starts
with an exclamation mark is refused (*A prompt that starts with an exclamation mark would run a
shell command in Claude Code.*): `!` is Claude Code's shell escape. A text that starts with `/` is a
slash command and is shown in the editor font; one that starts with `#`, `@` or `?` is allowed as
well — Claude Code reads those as a memory note, a mention and a request for help.

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

## Editing

A click on a prompt opens its title and text in its place — after 300 milliseconds
(`PROMPT_CLICK_DELAY_MS`), so that a double-click sends the prompt instead and never leaves it open.
When your system's double-click time is longer than that, the first click of a double-click may already
have opened the fields: a double-click on them within 800 milliseconds of their opening
(`PROMPT_DBLCLICK_GRACE_MS`), with nothing changed in them, closes them without saving and sends the
prompt. Later, or once you have changed something, a double-click in a field is the field's own — it
selects a word.

The open prompt shows *Title* and *Text* — the text field's caret at its end —, a counter under the
text (*104 / 2000 characters*) and the buttons *Save*, *Cancel*, *Move up*, *Move down* and *Delete*.
The fields take no more than 80 and 2000 characters.

* **Enter** in either field saves — Shift+Enter too: a prompt is one line, so the text never takes a
  line break (a pasted one becomes a space when the prompt is saved). **Leaving the fields** — a click
  or Tab to anything outside them — saves as well; when nothing changed, they just close. **Escape**
  closes them and leaves the prompt as it was; the keyboard is back on the prompt.
* Before it saves, the dashboard checks what the host will check: an empty title (*The title is
  empty.*), an empty text (*The text is empty.*) or a text that starts with an exclamation mark keeps
  the fields open with the reason under them, and nothing is saved. Otherwise the fields close as soon
  as the list shows the saved words; when Token Pace refuses the change — the list is full, the file
  cannot be written —, they stay open and the section says why (*Not saved: …*).
* **Delete** asks in the page first — *Delete “Status table”?* with *Delete* and *Keep*, the keyboard on
  *Keep*. *Keep*, or Escape, goes back to the buttons.
* **Move up** and **Move down** move the prompt one place; its fields stay open and the keyboard stays on
  the button. At the top, *Move up* does nothing, at the bottom *Move down*.
* **New prompt** opens empty fields at the end of the list, the title field hinting *New prompt*; left
  empty, they close without adding anything. At 50 prompts it does nothing and says *At most 50
  prompts.*

Open fields keep what you typed through every update of the dashboard — the section is drawn again as
terminals open and close, and a language switch or a wider panel draws the whole page again —, and the
keyboard stays in the field it was in, with the selection you had. Nothing of what you type is sent
anywhere before you save it. When another window deleted the prompt you are editing, its fields close
and the section says *This prompt was deleted in another window; your changes were not saved.* While the
list cannot be changed (the box above it says why), a click opens nothing and *New prompt* does nothing;
sending still works.

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
stop it. Every such line is a real request on your usage — [The `/loop` variant](#the-loop-variant) says
what it costs and how to stop it.

## The `/loop` variant

The *Keep the cache warm* prompt sends the [keep-warm line](prompt-cache.md#keep-warm-in-a-terminal-opt-in)
once, on your double-click. Edit its text to `/loop 30m Ignore this message. No action. No response.` and
Claude Code repeats it by itself: `/loop` is Claude Code's own scheduler, and this line — typed into an
idle Claude Code in a test — became one scheduled task that sends the line every 30 minutes, between your
turns, for as long as that session runs. Every run is a request of the main conversation: it reads the
conversation so far from the prompt cache at the cache-read rate and writes the new tail and a short
reply — which is the point, since a request within the hour keeps the one-hour cache warm, where a cold
start re-writes the whole conversation at the 1-hour write rate. For the session of the
[prompt-cache page's](prompt-cache.md#on-the-claude-card) example, 152.3K tokens on Claude Opus 5.5, a
cache read is ~$0.03 of API equivalent against ~$1.22 for one cold rewrite: two reads an hour keep it warm
for ~$0.06. On a subscription these requests draw on your quota at a weight Anthropic does not publish.

Why 30 minutes: Claude Code rounds an interval to a clean step of its clock and may fire a task up to half
its interval late, so a 30-minute loop leaves at most 45 minutes between two requests — under the hour.
20 minutes would do the same at three requests an hour; 60 could reach 90 minutes and let the cache go
cold. A task fires only while Claude Code is running and idle — one that comes due mid-turn waits for the
turn to end — and, like everything typed into that terminal, its line goes with whatever you typed there
and did not send.

To stop it, ask Claude in that session to list its scheduled tasks and cancel the keep-warm one; a fresh
conversation drops the session's tasks, and `/exit` asks whether to stop them (a resumed session restores
them, Claude Code's documentation says). `CLAUDE_CODE_DISABLE_CRON=1` in Claude Code's environment
switches the scheduler off altogether. A loop nobody stops runs seven days at most, as Claude Code
documents for recurring tasks — 336 requests. Token Pace neither counts these requests apart nor sees
that a loop runs: they are requests of the session like any other, and `keepwarm.json` counts only the
lines the keep-warm countdown typed.

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
and to nothing otherwise. A terminal without shell integration is never offered. For a terminal in which
Token Pace holds no running `claude` or `codex` command — one started before Token Pace began to listen,
before a window reload or before you added the section, or one whose command it saw end while VS Code
still names the shell so — there is no start to go by; VS Code still says what runs there, and for the folder
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

## Keyboard and screen readers

Every prompt is two buttons, and so two stops of the Tab key: the prompt itself and its send button
(the triangle beside it). On the prompt, Enter or Space opens its fields at once, and Ctrl+Enter
(⌘+Enter on a Mac) sends it; on the send button, Enter or Space sends it. A key held down acts once.
There is no roving focus: a list of 50 prompts is 100 stops.

A screen reader hears the list as *Prompts*; a prompt by its title, described by its text and *Enter
edits it, Ctrl+Enter sends it.* — "Status table, button, Show the current progress in a clear table. …
Enter edits it, Ctrl+Enter sends it." —, and its send button as *Send “Status table”* (in German
*„Zwischenstand als Tabelle“ senden*). The open fields are a group named *Edit “Status table”* with the
labelled fields *Title* and *Text*; a reason the dashboard gives before saving is announced at once, and
the outcome of a send or of a refused change — *Sent to Claude Code in terminal 2 of 3.* — once,
politely. The delete question is a group of its own, *Delete “Status table”?*. The second line of the
section says in words where a prompt would go and whether it goes, asks first or not now; its state is
never a colour alone.

The walk: Tab to the first prompt (past the section's heading and its gear), Enter — the fields, the caret at the end of
the text —, Escape — closed, the keyboard back on the prompt —, Tab to its send button, Enter — sent —,
Shift+Tab back to the prompt, Ctrl+Enter — sent —, Enter, Tab to *Delete*, Enter — the question, the
keyboard on *Keep* —, Enter — back, the keyboard on *Delete* —, Escape — closed.

In a high-contrast theme the buttons wear the theme's button colours, the fields its field colours with a
one-pixel edge, the send triangle the button's text colour, and the focused control the theme's highlight
ring; a button that does nothing now (*Move up* at the top, *New prompt* at 50) is drawn in the disabled
colour and heard as unavailable. Nothing in the section moves; at 200 % zoom and in the narrowest side
bar the fields and the buttons wrap, and the page never scrolls sideways.
