// SPDX-FileCopyrightText: 2026 Frederik Marx
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The five names main.ts uses but does not declare.
 *
 * `acquireVsCodeApi` is the webview host's own function, injected by VS Code before the page
 * runs. `SRC_TITLE` and `SRC_IDS` are the provider registry's two facts, `L10N` is the page's
 * translated words and `LOCALE` the language they are counted in; all four are written in
 * front of this module by src/dashboard.ts, because the registry and the localisation seam
 * are Node code and cannot be part of a browser bundle. All five are declared, never defined:
 * nothing here reaches the built script, so a wrong shape is a compile error and never a
 * second copy of the truth.
 */

/** The VS Code webview API. Only `postMessage` is used, and only ever with our own messages. */
declare function acquireVsCodeApi(): { postMessage(message: unknown): void }

/** The provider titles as the reader knows them — "Claude Code", not "claude". */
declare const SRC_TITLE: Record<string, string>

/** The provider ids, in registry order; that order is the order of the filter chips. */
declare const SRC_IDS: readonly string[]

/**
 * Every string this page shows, keyed by its English text and already translated — the
 * dictionary src/dashboard.ts builds with `t()` at render time. `tr()` is what reads it; a
 * key that is missing falls back to itself, which is why an English build ships an empty one.
 */
declare const L10N: Record<string, string>

/** The BCP 47 tag src/i18n.ts hands the host's Intl formatters — the page formats with it too. */
declare const LOCALE: string
