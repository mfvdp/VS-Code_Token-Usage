// SPDX-FileCopyrightText: 2026 Frederik Marx
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `npm run test:e2e` — downloads VS Code stable once, launches it with this extension in
 * development mode and runs `test-e2e/suite/index.js` inside it (see that file for what is
 * asserted and why a fake host cannot answer it).
 *
 * Two promises shape the launch:
 *
 *  • Nothing of the developer's machine is read. The window gets a `--user-data-dir` and an
 *    `--extensions-dir` of its own under the OS temp directory, every other extension is
 *    disabled, and HOME points into that same throw-away box — the transcript readers derive
 *    `~/.claude` and `~/.codex` from `os.homedir()`, so a shared HOME would mean a smoke test
 *    reading real conversations. The few environment variables that could point the readers
 *    back at the real files are cleared with it.
 *  • Nothing is left behind. The box is removed afterwards; only `.vscode-test/` survives, and
 *    that is the downloaded editor (gitignored, never in the .vsix, cached in CI).
 *
 * Headless: on CI this runs under `xvfb-run -a`; locally it needs a display, and the window
 * appears for a few seconds. The download is the only step that needs the network.
 */

import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { downloadAndUnzipVSCode, runTests } from '@vscode/test-electron'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
/** Built by build.mjs from test-e2e/suite/index.ts; `--extensionTestsPath` wants plain JS. */
const suite = join(root, 'test-e2e', 'suite', 'index.js')
const cachePath = join(root, '.vscode-test')

/** The download is the one step that can fail for a reason that is not ours. */
const DOWNLOAD_TRIES = 3

const sleep = (ms) => new Promise((done) => setTimeout(done, ms))

/**
 * The suite and `dist/extension.js` both come out of build.mjs, and the window loads the
 * built extension — so building here is not a convenience, it is what keeps a passing run
 * from describing yesterday's code.
 */
function build() {
  const built = spawnSync(process.execPath, ['build.mjs'], { cwd: root, stdio: 'inherit' })
  if (built.status !== 0) {
    console.error('test-e2e: `node build.mjs` failed — nothing was launched.')
    process.exit(built.status ?? 1)
  }
}

async function download() {
  let last
  for (let attempt = 1; attempt <= DOWNLOAD_TRIES; attempt++) {
    try {
      return await downloadAndUnzipVSCode({ version: 'stable', cachePath })
    } catch (err) {
      last = err
      console.error(`test-e2e: downloading VS Code failed (attempt ${attempt}/${DOWNLOAD_TRIES}): ${err}`)
      if (attempt < DOWNLOAD_TRIES) await sleep(attempt * 5000)
    }
  }
  throw last
}

/**
 * X11 hands out a cookie file that lives in the *real* home directory; with HOME redirected
 * the window would fail to open a display. `xvfb-run` sets XAUTHORITY itself, so on CI this
 * only passes that value through.
 */
function xauthority() {
  if (process.env.XAUTHORITY) return process.env.XAUTHORITY
  const inHome = process.env.HOME ? join(process.env.HOME, '.Xauthority') : ''
  return inHome && existsSync(inHome) ? inHome : undefined
}

/**
 * A VS Code the shell already runs inside leaves its own variables behind: an integrated
 * terminal exports `ELECTRON_RUN_AS_NODE` and a whole `VSCODE_*` family. Inherited, the first
 * turns the downloaded editor into a plain Node — "code: bad option: --extensionDevelopmentPath"
 * — and the rest point it at the window that started it. The child gets none of them.
 */
function withoutHostEditor() {
  const cleared = { ELECTRON_RUN_AS_NODE: undefined }
  for (const key of Object.keys(process.env)) {
    if (key.startsWith('VSCODE_')) cleared[key] = undefined
  }
  return cleared
}

build()
if (!existsSync(suite)) {
  console.error(`test-e2e: ${suite} was not built — check the build output above.`)
  process.exit(1)
}

const box = mkdtempSync(join(tmpdir(), 'token-pace-e2e-'))
const home = join(box, 'home')
mkdirSync(home, { recursive: true })

let code = 1
try {
  const vscodeExecutablePath = await download()
  console.log(`test-e2e: ${vscodeExecutablePath}\ntest-e2e: sandbox ${box}`)
  code = await runTests({
    vscodeExecutablePath,
    extensionDevelopmentPath: root,
    extensionTestsPath: suite,
    launchArgs: [
      '--disable-extensions',
      `--user-data-dir=${join(box, 'user-data')}`,
      `--extensions-dir=${join(box, 'extensions')}`,
    ],
    extensionTestsEnv: {
      ...withoutHostEditor(),
      // A home of its own — see the note at the top of this file.
      HOME: home,
      USERPROFILE: home,
      XDG_CONFIG_HOME: join(home, '.config'),
      XDG_DATA_HOME: join(home, '.local', 'share'),
      XDG_STATE_HOME: join(home, '.local', 'state'),
      XDG_CACHE_HOME: join(home, '.cache'),
      // Undefined removes the variable from the child's environment: none of these may point
      // the readers at the real files, and a token must not be inherited at all.
      CLAUDE_CONFIG_DIR: undefined,
      CLAUDE_SECURESTORAGE_CONFIG_DIR: undefined,
      CLAUDE_CODE_OAUTH_TOKEN: undefined,
      CODEX_HOME: undefined,
      CODEX_CLI_PATH: undefined,
      XAUTHORITY: xauthority(),
      // The same fixed clock and locale the unit suite runs under.
      TZ: 'UTC',
      LANG: 'en_US.UTF-8',
    },
  })
} catch (err) {
  console.error(`test-e2e: ${err instanceof Error ? err.message : String(err)}`)
  code = typeof err?.code === 'number' && err.code !== 0 ? err.code : 1
} finally {
  rmSync(box, { recursive: true, force: true })
}

process.exit(code)
