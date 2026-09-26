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
([below](#where-the-prompts-are-kept)). While `prompts` is not listed, Token Pace does not even look at
that file. The section serves Claude Code and Codex alike, so it stays on the page whatever the
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

To find the terminal a prompt goes into, Token Pace reads what VS Code's shell integration reports about
the terminals of the window — the facts the keep-warm line reads — and, for a terminal whose Claude Code
or Codex started before Token Pace began to listen, the folder the shell reports: of the terminal its
`shellIntegration`, of that the `cwd`, of that the `fsPath`, compared with the folders of the sessions
and kept by no one. [Privacy](privacy.md) lists every field.
