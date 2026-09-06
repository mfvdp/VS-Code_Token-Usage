<!--
SPDX-FileCopyrightText: 2026 Frederik Marx
SPDX-License-Identifier: AGPL-3.0-or-later
-->

# Building and testing

Part of the [Token Pace documentation](../README.md#documentation).

No runtime dependencies; the bundles are built with esbuild.

```bash
npm install
npm run build          # dist/extension.js, dist/scanWorker.js, dist/statusline-bridge.js
npm run watch          # the same, rebuilt on change
npm run typecheck      # tsc --noEmit
npm test               # builds the tests, then node --test "out-test/*.test.js"
npm run test:e2e       # the extension-host smoke test in a real window (needs a display)
npm run check:privacy  # http(s) literals in dist/ against the allow-list
npm run package        # build + privacy check + vsce package
```

The tests are plain `node:test` with `node:assert/strict` over synthetic fixtures — never a real
transcript. Every module that has to stay testable (and loadable in the scan worker) is free of
any `vscode` import: the parsers, the aggregator, the pace and price logic, the statistics, the
forecast, the view model, the status bar texts, the serialisers and the bridge script.

A handful of questions a fake host cannot answer run in a real editor: `npm run test:e2e`
downloads VS Code stable into `.vscode-test/`, starts it with this extension in development
mode, every other extension disabled, a user-data directory of its own and a fresh `HOME` — so
the smoke test never sees a real transcript — and asserts that the extension activates, that
every contributed command is registered, that the status-bar preview runs, that a settings
change reaches the status bar without a window reload, and that the dashboard command opens its
view. The settings check is why it exists at all: from 1.0 to 1.2 every settings change quietly
waited for a window reload, and ~800 unit tests against a fake host could not see it.

CI runs type check, build, tests and the privacy check on **ubuntu, macOS and windows** — the
transcript readers touch paths, inodes and line endings, and Windows is where the bar glyphs and
the path handling actually differ. The smoke test runs under `xvfb` on ubuntu in a job of its
own, so the unit matrix stays fast. CodeQL, a dependency review and a gitleaks scan run alongside.
Pushing a `v*` tag builds the `.vsix`, creates a GitHub release and publishes to both the Visual
Studio Marketplace and **Open VSX** — the latter is what makes the extension installable in
VSCodium at all. Cursor and Windsurf are published to from the same registry, but they run an
older VS Code base than the `^1.106.0` engine floor the secondary-sidebar contribution point
needs, so they cannot install it until they rebase. Each publish step is skipped rather than failed when its
token is not configured, so a fork can produce the `.vsix` without any secrets.

The recipe itself — what to run in which order, the two secrets it needs and the publisher
verification — is in [Releasing](release.md).
