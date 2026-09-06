// SPDX-FileCopyrightText: 2026 Frederik Marx
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The localisation seam: one `t()` for every user-visible string, one locale for every
 * `Intl` formatter, and no `vscode` import — so the pure view modules, the webview and the
 * extension host all translate through the same table.
 *
 * How it works
 *
 *  • `t('Fetch failed')` and `t('{0} of {1} files', done, total)` follow `vscode.l10n.t`: the
 *    English message is the key. A bundle entry replaces it, `{n}` placeholders are filled
 *    from the arguments, and without an entry the English text comes back unchanged — which
 *    is why every test that asserts English keeps passing: the bundle is empty there.
 *  • The bundle is `l10n/bundle.l10n.<lang>.json`. VS Code loads it for `vscode.env.language`
 *    because package.json declares `"l10n": "./l10n"`; extension.ts hands it over at
 *    activation with `setBundle(vscode.l10n.bundle ?? {})` and the language with
 *    `setLocale(vscode.env.language)`. Nothing else ever calls the two setters.
 *  • `locale()` is what the `Intl` formatters in time.ts use: 'en-US' until the host says
 *    otherwise, so a date reads the same on every machine in the English build and follows
 *    the editor's language once that is known. A tag ICU does not know falls back to
 *    'en-US' rather than to whatever the operating system prefers.
 *
 * How to add a string
 *
 *  1. `import { t } from './i18n'` and wrap the literal: `t('Reading token history …')`.
 *     The first argument MUST be a string literal — `scripts/l10n-extract.mjs` reads the
 *     source, not the runtime, and fails on a variable, a concatenation or a ternary.
 *     Dynamic parts go into `{0}`, `{1}`, … arguments, never into the key; a translator may
 *     reorder them ("{1} von {0}").
 *  2. Call `t()` where the string is *used*, not at module load. The bundle is set at
 *     activation; `const LABEL = t('…')` at the top of a module runs before that and stays
 *     English for good. A button label that is compared with the dialog's answer is computed
 *     once inside the function and compared with that same value.
 *  3. Write the German into your part file, `l10n/parts/<part>.de.json` (host, model,
 *     dashboard, text — one per package), then run `node scripts/merge-l10n.mjs` to
 *     regenerate `l10n/bundle.l10n.de.json` and commit both. test/i18n.test.ts fails until
 *     the bundle matches the parts, every extracted key has a German entry, and no entry is
 *     left without a call site.
 *
 * What stays English on purpose: the debug log, the diagnostics report and the CSV/JSON
 * headers. They are pasted into issues, and a maintainer has to be able to read them.
 */

/** The locale every formatter uses until the host names another one. */
export const DEFAULT_LOCALE = 'en-US'

let bundle = new Map<string, string>()
let tag = DEFAULT_LOCALE

/**
 * Installs the translation table. Anything that is not a non-empty string is dropped: the
 * bundle is a file, and a broken entry must fall back to English rather than to "undefined".
 */
export function setBundle(next: Readonly<Record<string, string>> | undefined | null): void {
  const table = new Map<string, string>()
  if (next && typeof next === 'object') {
    for (const [key, value] of Object.entries(next)) {
      if (typeof value === 'string' && value.length > 0) table.set(key, value)
    }
  }
  bundle = table
}

/**
 * Sets the locale for `Intl`. The tag is canonicalised ("DE-de" → "de-DE"); one that is
 * malformed, empty or unknown to this Node's ICU leaves `locale()` at 'en-US'.
 */
export function setLocale(next: string | undefined | null): void {
  tag = usableLocale(next)
}

/** The BCP 47 tag the formatters use — see `setLocale`. */
export function locale(): string {
  return tag
}

/**
 * The message in the user's language, with `{0}`, `{1}`, … filled from `args`.
 *
 * A placeholder without an argument stays visible as written: a gap in a sentence is a
 * bug the reader can report, a silently dropped word is not.
 */
export function t(message: string, ...args: Array<string | number>): string {
  const template = bundle.get(message) ?? message
  return args.length === 0 ? template : fill(template, args)
}

function fill(template: string, args: Array<string | number>): string {
  return template.replace(/\{(\d+)\}/g, (match, index: string) => {
    const arg = args[Number(index)]
    return arg === undefined ? match : String(arg)
  })
}

function usableLocale(raw: unknown): string {
  if (typeof raw !== 'string') return DEFAULT_LOCALE
  const trimmed = raw.trim()
  if (trimmed === '') return DEFAULT_LOCALE
  try {
    const canonical = Intl.getCanonicalLocales(trimmed)[0]
    if (!canonical) return DEFAULT_LOCALE
    return Intl.DateTimeFormat.supportedLocalesOf([canonical]).length > 0 ? canonical : DEFAULT_LOCALE
  } catch {
    // RangeError: not a BCP 47 tag at all.
    return DEFAULT_LOCALE
  }
}
