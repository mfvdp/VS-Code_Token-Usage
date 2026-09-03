// SPDX-FileCopyrightText: 2026 Frederik Marx
// SPDX-License-Identifier: AGPL-3.0-or-later

// Three bundles and a test build, no bundler config file:
//   node build.mjs           dist/extension.js, dist/scanWorker.js, dist/statusline-bridge.js
//   node build.mjs --watch   the same, rebuilt on change
//   node build.mjs --tests   every test/**/*.test.ts to out-test/, for `node --test out-test/`

import * as esbuild from 'esbuild'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'fs'
import { join, relative, sep } from 'path'

const pkg = JSON.parse(readFileSync('package.json', 'utf8'))

const watch = process.argv.includes('--watch')
const tests = process.argv.includes('--tests')

const common = {
  bundle: true,
  format: 'cjs',
  platform: 'node',
  target: 'node20',
  external: ['vscode'],
  logLevel: 'info',
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

const ctxs = await Promise.all(
  present.map((e) => esbuild.context({ ...common, entryPoints: [e.in], outfile: e.out, sourcemap: true })),
)

if (watch) {
  await Promise.all(ctxs.map((c) => c.watch()))
} else {
  await Promise.all(ctxs.map(async (c) => { await c.rebuild(); await c.dispose() }))
}
