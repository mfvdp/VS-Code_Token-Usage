<!--
SPDX-FileCopyrightText: 2026 Frederik Marx
SPDX-License-Identifier: AGPL-3.0-or-later
-->

# Windows, WSL and remote development

Part of the [Token Pace documentation](../README.md#documentation).

The `.vsix` is platform-independent (no native code) and installs with

```powershell
code --install-extension token-pace-1.1.0.vsix
```

or through the UI via *Extensions → … → Install from VSIX…*. Both halves work there:
`~/.claude` resolves to `%USERPROFILE%\.claude`.

**`extensionKind` is now `["ui", "workspace"]`.** The extension can run either on the local
machine (the UI side) or inside a remote — WSL, SSH, a container, a Codespace. VS Code picks the
first kind it can satisfy, so by default it runs **locally** and reads the home directory of the
machine your editor is running on.

That is the right default for most people, and the wrong one whenever Claude Code or Codex runs
on the *other* side. If your transcripts live in the remote (Claude Code running inside WSL, for
example), tell VS Code to run this extension there:

```jsonc
"remote.extensionKind": {
  "frederik.token-pace": ["workspace"]
}
```

**Or let the extension write it.** On a remote host where it finds no transcripts at all,
Token Pace offers *Run Token Pace locally* once. That button writes
`"remote.extensionKind": { "frederik.token-pace": ["ui"] }` into your **user** `settings.json`
— merged into whatever is already there, so other extensions' entries are kept — and then
offers a window reload. It is the one write outside the extension's own storage that has no
dialog in front of it: the click is the decision, it happens at most once per machine, and it
is undone by deleting that one key. The setting is yours afterwards; nothing rewrites it later.

No rebuild is needed any more — this replaces the “edit `package.json` and repackage” advice of
earlier versions. The alternative is to point `tokenPace.claudeDir` at
`\\wsl$\<distro>\home\<user>\.claude`, which works but is slow, because every read goes through
the 9p server.

If the directories have been relocated, set `tokenPace.claudeDir` / `tokenPace.codexDir` — both
accept a string or an array of strings, so several homes can be summed — or use
`CLAUDE_CONFIG_DIR` / `CODEX_HOME`. Those environment variables only apply when they were already
set when **VS Code started**, not when they merely live in a shell profile. Both settings are
machine-scoped, so a synced setting cannot carry a Linux path onto a Windows machine, and both
take effect after **Reload Window**.

**The Claude Code version on Windows.** In `quotaSource: poll` the fetch names the Claude Code
version in its user agent ([Quota sources](quota-sources.md#what-the-fetch-does)). On Windows,
Token Pace runs `claude --version` only from a `claude.exe` it finds in a directory of the `PATH`
— checked for existence, nothing read from it, started by its full path without a shell. An npm
install puts only the shim `claude.cmd` there (beside `claude` and `claude.ps1`), and that shim is
never started: the version then comes from the newest Claude Code session's transcript, and a fixed
one is sent only when there is none. The Token Pace log says which, once, and again only when the
version or its source changes: `claude: user agent version 2.1.281 (from the newest transcript)`.

**The status-line bridge's script** lives in the extension's storage since 1.8 —
`<globalStorage>/statusline-bridge.js`, inside the editor's user-data directory on the side Token
Pace runs on —, and the command in
Claude Code's `settings.json` names that path. Claude Code and Token Pace therefore have to run on
the same side of a remote for the bridge to work (`remote.extensionKind`, above). Before 1.8 the
command named the script inside the versioned extension folder, which an update removes; 1.8 moves
such a command to the copy once ([Quota sources](quota-sources.md#claude-status-line-bridge-opt-in)).
On Windows the command holds its paths with backslashes, as the installer has always written them.

The extension supports untrusted workspaces and virtual workspaces: it never reads, executes or
evaluates workspace content at all. In Restricted Mode the three opt-ins that act outside the
extension's storage are disabled — the two writes (the shared quota cache file and the status-line
bridge) and the [keep-warm line](prompt-cache.md#keep-warm-in-a-terminal-opt-in), which then listens
to no terminal and types nothing. On a
machine with no transcripts it reports that it found none instead of showing zeros — and on a
remote host it offers, once, to move itself to the local side by writing `remote.extensionKind`
to your user settings (above).
