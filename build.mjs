// SPDX-FileCopyrightText: 2026 Frederik Marx
// SPDX-License-Identifier: AGPL-3.0-or-later

import * as esbuild from 'esbuild'
import { readFileSync } from 'fs'

const pkg = JSON.parse(readFileSync('package.json', 'utf8'))

const watch = process.argv.includes('--watch')
const common = {
  bundle: true,
  format: 'cjs',
  platform: 'node',
  target: 'node20',
  external: ['vscode'],
  sourcemap: true,
  logLevel: 'info',
  // Keeps the version we report to the Codex app-server in step with the manifest.
  define: { __EXT_VERSION__: JSON.stringify(pkg.version) },
}

const ctxs = await Promise.all([
  esbuild.context({ ...common, entryPoints: ['src/extension.ts'], outfile: 'dist/extension.js' }),
  esbuild.context({ ...common, entryPoints: ['src/scanWorker.ts'], outfile: 'dist/scanWorker.js' }),
])

if (watch) {
  await Promise.all(ctxs.map((c) => c.watch()))
} else {
  await Promise.all(ctxs.map(async (c) => { await c.rebuild(); await c.dispose() }))
}
