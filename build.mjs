// SPDX-FileCopyrightText: 2026 Frederik Marx
// SPDX-License-Identifier: AGPL-3.0-or-later

// Three bundles and a test build, no bundler config file:
//   node build.mjs           dist/extension.js, dist/scanWorker.js, dist/statusline-bridge.js
//   node build.mjs --watch   the same, rebuilt on change
//   node build.mjs --tests   every test/**/*.test.ts to out-test/, for `node --test out-test/`
//
// The dashboard's webview script is a build of its own and reaches every one of them as
// text, through the virtual module `webview:script` — see `webviewScriptPlugin` below.

import * as esbuild from 'esbuild'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'fs'
import { join, relative, sep } from 'path'

const pkg = JSON.parse(readFileSync('package.json', 'utf8'))

const watch = process.argv.includes('--watch')
const tests = process.argv.includes('--tests')

const WEBVIEW_ENTRY = 'src/webview/main.ts'

/**
 * The dashboard's script is the one module in this repository that runs in a browser: its own
 * tsconfig (lib DOM, strict, no Node types), no imports, no externals, nothing minified. It is
 * built to text here rather than to a file, because the page carries it inline under the CSP
 * nonce and the dashboard's HTML must stay a pure string.
 *
 * `bundle` is off on purpose. The bundler wraps an iife around the whole file, which would put
 * the script's state and its renderers out of the page's own scope — a change to what the page
 * *is*, not only to how it is built. Without imports there is nothing to bundle anyway, and the
 * guard below keeps it that way.
 */
async function buildWebviewText() {
  if (!existsSync(WEBVIEW_ENTRY)) throw new Error(`build: ${WEBVIEW_ENTRY} does not exist`)
  const built = await esbuild.build({
    entryPoints: [WEBVIEW_ENTRY],
    outfile: 'webview.js',
    write: false,
    bundle: false,
    minify: false,
    platform: 'browser',
    target: 'es2022',
    tsconfig: 'tsconfig.webview.json',
    // Nothing is appended to the text: what the page gets is the module and nothing else.
    legalComments: 'none',
    logLevel: 'silent',
  })
  const text = built.outputFiles[0].text
  // An import would survive `bundle: false` verbatim, and a webview has no loader for one.
  if (/^\s*(import|export)\b/m.test(text)) {
    throw new Error(`build: ${WEBVIEW_ENTRY} must stay self-contained — no import, no export`)
  }
  return text
}

let webviewText = null

/**
 * Resolves `import script from 'webview:script'` to the text built above — for the shipped
 * bundles and for `--tests` alike, so a test renders the very script the page ships. The text
 * is built once and remembered; in watch mode the entry is named as a watched file, so a change
 * to the webview rebuilds the extension bundle around it.
 */
const webviewScriptPlugin = {
  name: 'webview-script',
  setup(build) {
    build.onResolve({ filter: /^webview:script$/ }, (args) => ({
      path: args.path, namespace: 'webview-script',
    }))
    build.onLoad({ filter: /.*/, namespace: 'webview-script' }, async () => {
      if (webviewText === null || watch) webviewText = await buildWebviewText()
      return {
        contents: `export default ${JSON.stringify(webviewText)}`,
        loader: 'js',
        watchFiles: [WEBVIEW_ENTRY],
      }
    })
  },
}

const common = {
  bundle: true,
  format: 'cjs',
  platform: 'node',
  target: 'node20',
  external: ['vscode'],
  logLevel: 'info',
  plugins: [webviewScriptPlugin],
  // Keeps the version we report to the Codex app-server in step with the manifest.
  define: { __EXT_VERSION__: JSON.stringify(pkg.version) },
}

/** The three shipped bundles. The status-line bridge is a plain Node script, no vscode. */
const entries = [
  { in: 'src/extension.ts', out: 'dist/extension.js' },
  { in: 'src/scanWorker.ts', out: 'dist/scanWorker.js' },
  { in: 'src/statuslineBridge.ts', out: 'dist/statusline-bridge.js' },
]

/** All test files, recursively, so a future test/<area>/ subdirectory is picked up too. */
function findTests(dir) {
  const out = []
  if (!existsSync(dir)) return out
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...findTests(full))
    else if (entry.name.endsWith('.test.ts')) out.push(full)
  }
  return out.sort()
}

if (tests) {
  const files = findTests('test')
  if (files.length === 0) {
    console.log('build: no test/**/*.test.ts found')
    process.exit(0)
  }
  rmSync('out-test', { recursive: true, force: true })
  mkdirSync('out-test', { recursive: true })

  // Each file is bundled on its own so that one test whose sources are mid-rewrite cannot
  // stop the others from running; failures are collected and reported at the end.
  const failed = []
  for (const file of files) {
    const name = relative('test', file).split(sep).join('-').replace(/\.ts$/, '.js')
    try {
      await esbuild.build({
        ...common,
        logLevel: 'silent',
        entryPoints: [file],
        outfile: join('out-test', name),
        sourcemap: 'inline',
      })
    } catch (err) {
      failed.push({ file, err })
    }
  }

  const built = files.length - failed.length
  console.log(`build: ${built}/${files.length} test bundle(s) → out-test/`)
  for (const { file, err } of failed) {
    console.error(`build: FAILED ${file}`)
    for (const e of err.errors ?? [{ text: String(err) }]) {
      console.error(`  ${e.location ? `${e.location.file}:${e.location.line}: ` : ''}${e.text}`)
    }
  }
  process.exit(failed.length > 0 ? 1 : 0)
}

const present = []
for (const e of entries) {
  if (existsSync(e.in)) present.push(e)
  // During the parallel build-out a module may not exist yet; skipping it beats failing the
  // whole build, as long as the omission is stated.
  else console.log(`build: skipping ${e.out} — ${e.in} does not exist yet`)
}

// The extension-host smoke test's suite (`npm run test:e2e`). Not shipped and not in dist/:
// `--extensionTestsPath` names a plain CommonJS module, so it is built beside its source,
// with the map inlined to keep it a single artifact.
const e2e = { in: 'test-e2e/suite/index.ts', out: 'test-e2e/suite/index.js' }
if (existsSync(e2e.in)) {
  await esbuild.build({ ...common, entryPoints: [e2e.in], outfile: e2e.out, sourcemap: 'inline' })
}

const ctxs = await Promise.all(
  present.map((e) => esbuild.context({ ...common, entryPoints: [e.in], outfile: e.out, sourcemap: true })),
)

if (watch) {
  await Promise.all(ctxs.map((c) => c.watch()))
} else {
  await Promise.all(ctxs.map(async (c) => { await c.rebuild(); await c.dispose() }))
}
