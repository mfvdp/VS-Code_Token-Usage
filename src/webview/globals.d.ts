// SPDX-FileCopyrightText: 2026 Frederik Marx
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The three names main.ts uses but does not declare.
 *
 * `acquireVsCodeApi` is the webview host's own function, injected by VS Code before the page
 * runs. `SRC_TITLE` and `SRC_IDS` are the provider registry's two facts, written in front of
 * this module by src/dashboard.ts because the registry itself is Node code and cannot be part
 * of a browser bundle. All three are declared, never defined: nothing here reaches the built
 * script, so a wrong shape is a compile error and never a second copy of the truth.
 */

/** The VS Code webview API. Only `postMessage` is used, and only ever with our own messages. */
declare function acquireVsCodeApi(): { postMessage(message: unknown): void }

/** The provider titles as the reader knows them — "Claude Code", not "claude". */
declare const SRC_TITLE: Record<string, string>

/** The provider ids, in registry order; that order is the order of the filter chips. */
declare const SRC_IDS: readonly string[]
