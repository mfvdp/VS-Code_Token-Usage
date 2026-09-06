// SPDX-FileCopyrightText: 2026 Frederik Marx
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Lists every `t('…')` call in src/ — the keys the localisation bundle has to cover.
 *
 * The keys are read from the *source*, not collected at runtime: a string that is only ever
 * shown in a dialog nobody opened during a test run must still be in the bundle. That is
 * also why the first argument of `t()` has to be a string literal (single- or double-quoted,
 * or a template literal without `${}`): a variable, a concatenation or a ternary cannot be
 * extracted, so the script fails on it with the file and line rather than letting a string
 * ship that will never be translated. Dynamic parts belong in `{0}`, `{1}`, … arguments.
 *
 * Only files that import `t` from `./i18n` (any relative path ending in `i18n`) are read for
 * calls, so a module with its own local `t` is never mistaken for a translation site. The
 * TypeScript parser does the reading: a `t('…')` inside a comment or a string is not a call.
 *
 * Run:  node scripts/l10n-extract.mjs                keys, one per line, with their call sites
 *       node scripts/l10n-extract.mjs --json         { "keys": { "<key>": ["src/file.ts:12", …] } }
 *       node scripts/l10n-extract.mjs --dir <path>   read another tree than ./src (tests)
 * Exit 1 on a non-literal first argument, a `t()` without a message, or an unreadable file.
 *
 * `extract(dir)` is exported for tools that build on the key list (the webview dictionary).
 */

import { readdirSync, readFileSync, statSync } from 'fs'
import { join, relative, sep } from 'path'
import ts from 'typescript'

/** `*.ts` files under `dir`, recursively, in a stable order. */
function sourceFiles(dir) {
  const out = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...sourceFiles(full))
    else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) out.push(full)
  }
  return out.sort()
}

/** Whether `import { t } from './i18n'` (or `../i18n`) binds `t` in this file. */
function importsT(source) {
  for (const stmt of source.statements) {
    if (!ts.isImportDeclaration(stmt) || !ts.isStringLiteral(stmt.moduleSpecifier)) continue
    if (!/(^|\/)i18n$/.test(stmt.moduleSpecifier.text)) continue
    const bindings = stmt.importClause?.namedBindings
    if (!bindings || !ts.isNamedImports(bindings)) continue
    for (const el of bindings.elements) {
      if (el.name.text === 't' && (el.propertyName === undefined || el.propertyName.text === 't')) return true
    }
  }
  return false
}

/**
 * Every `t()` call of one file.
 * @returns {{ keys: Array<{ key: string, line: number }>, errors: string[] }}
 */
function callsIn(source, label) {
  const keys = []
  const errors = []
  const lineOf = (node) => source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1
  const visit = (node) => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 't') {
      const first = node.arguments[0]
      if (first === undefined) {
        errors.push(`${label}:${lineOf(node)}: t() has no message`)
      } else if (ts.isStringLiteral(first) || ts.isNoSubstitutionTemplateLiteral(first)) {
        keys.push({ key: first.text, line: lineOf(node) })
      } else {
        errors.push(
          `${label}:${lineOf(first)}: the first argument of t() must be a string literal `
          + `(found ${ts.SyntaxKind[first.kind]}); put the dynamic part into a {0} argument`,
        )
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return { keys, errors }
}

/**
 * The keys of a source tree: message → call sites (`src/file.ts:line`, posix separators).
 * @param {string} dir
 * @param {string} [root] what the site paths are relative to; defaults to the working directory
 * @returns {{ keys: Record<string, string[]>, errors: string[] }}
 */
export function extract(dir, root = process.cwd()) {
  const keys = {}
  const errors = []
  for (const file of sourceFiles(dir)) {
    const label = relative(root, file).split(sep).join('/')
    let text
    try {
      text = readFileSync(file, 'utf8')
    } catch (err) {
      errors.push(`${label}: ${err.message}`)
      continue
    }
    const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
    if (!importsT(source)) continue
    const found = callsIn(source, label)
    errors.push(...found.errors)
    for (const { key, line } of found.keys) {
      const sites = keys[key] ?? (keys[key] = [])
      sites.push(`${label}:${line}`)
    }
  }
  // Sorted by key with plain code-unit order: the same tree lists the same way everywhere.
  const sorted = {}
  for (const key of Object.keys(keys).sort()) sorted[key] = keys[key]
  return { keys: sorted, errors }
}

function main(argv) {
  const json = argv.includes('--json')
  const at = argv.indexOf('--dir')
  const dir = at >= 0 && argv[at + 1] ? argv[at + 1] : 'src'
  try {
    if (!statSync(dir).isDirectory()) throw new Error('not a directory')
  } catch (err) {
    console.error(`l10n-extract: ${dir}: ${err.message}`)
    process.exit(1)
  }

  const { keys, errors } = extract(dir)
  if (errors.length > 0) {
    for (const e of errors) console.error(`l10n-extract: ${e}`)
    process.exit(1)
  }
  if (json) {
    process.stdout.write(`${JSON.stringify({ keys }, null, 2)}\n`)
    return
  }
  for (const [key, sites] of Object.entries(keys)) console.log(`${JSON.stringify(key)}  ${sites.join(' ')}`)
  console.log(`\nl10n-extract: ${Object.keys(keys).length} key(s)`)
}

// Only run the CLI when invoked directly, so a tool can import `extract`.
if (process.argv[1] && process.argv[1].endsWith('l10n-extract.mjs')) main(process.argv.slice(2))
