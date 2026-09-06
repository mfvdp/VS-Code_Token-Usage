// SPDX-FileCopyrightText: 2026 Frederik Marx
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The webview script as text.
 *
 * `webview:script` is a virtual module: build.mjs builds src/webview/main.ts on its own
 * (browser target, its own tsconfig) and resolves this specifier to the built text, for the
 * shipped bundles and for the test build alike. It is not a file on disk, which is the point
 * — rendering the dashboard's HTML stays a pure string concatenation with no file system
 * behind it.
 */
declare module 'webview:script' {
  const script: string
  export default script
}
