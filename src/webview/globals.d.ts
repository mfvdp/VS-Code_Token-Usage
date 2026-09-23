// SPDX-FileCopyrightText: 2026 Frederik Marx
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The six names main.ts uses but does not declare.
 *
 * `acquireVsCodeApi` is the webview host's own function, injected by VS Code before the page
 * runs. `SRC_TITLE` and `SRC_IDS` are the provider registry's two facts, `L10N` is the page's
 * translated words, `LOCALE` the language they are counted in and `AGENT_PAGING` the agent
 * tree's paging steps; all five are written in front of this module by src/dashboard.ts,
 * because the registry, the localisation seam and the tree's limits are Node code and cannot be
 * part of a browser bundle. All six are declared, never defined:
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

/**
 * src/agentTree.ts's MAX_GROUP_CHILDREN and MAX_MORE_PAGES (1.6 D3): how many children an open
 * node of the agent tree shows per "more" step, and at most how many steps it takes.
 */
declare const AGENT_PAGING: { groupChildren: number; morePages: number }
