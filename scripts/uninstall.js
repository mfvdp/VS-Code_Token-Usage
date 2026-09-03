// SPDX-FileCopyrightText: 2026 Frederik Marx
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `vscode:uninstall` hook — best-effort removal of this extension's globalStorage directory.
 *
 * VS Code runs this only when the extension is uninstalled through the Extensions view (not
 * when the directory is deleted by hand, and not on an update), and it gives the script no
 * context at all: no extension id, no storage path, no API. So the locations are derived
 * from the well-known user-data roots of the editors this extension runs in, and nothing is
 * deleted unless the path ends in exactly `User/globalStorage/frederik.token-pace`.
 *
 * It never throws and never touches anything else — a failed cleanup must not turn into a
 * failed uninstall.
 */

const fs = require('fs')
const os = require('os')
const path = require('path')

const EXTENSION_ID = 'frederik.token-pace'

/** Editors that share VS Code's user-data layout. */
const APP_DIRS = ['Code', 'Code - Insiders', 'VSCodium', 'Cursor', 'Windsurf']

function userDataRoots() {
  const home = os.homedir()
  if (!home) return []
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA || path.join(home, 'AppData', 'Roaming')
    return APP_DIRS.map((app) => path.join(appData, app))
  }
  if (process.platform === 'darwin') {
    return APP_DIRS.map((app) => path.join(home, 'Library', 'Application Support', app))
  }
  const xdg = process.env.XDG_CONFIG_HOME || path.join(home, '.config')
  return APP_DIRS.map((app) => path.join(xdg, app))
}

/** Guard against deleting anything but our own storage directory, whatever the roots say. */
function isOwnStorage(dir) {
  const parts = dir.split(path.sep)
  return (
    parts.length >= 3 &&
    parts[parts.length - 1] === EXTENSION_ID &&
    parts[parts.length - 2] === 'globalStorage' &&
    parts[parts.length - 3] === 'User'
  )
}

function main() {
  for (const root of userDataRoots()) {
    const dir = path.join(root, 'User', 'globalStorage', EXTENSION_ID)
    try {
      if (!isOwnStorage(dir)) continue
      const stat = fs.lstatSync(dir)
      // Only a real directory, never a symlink pointing somewhere else.
      if (!stat.isDirectory()) continue
      fs.rmSync(dir, { recursive: true, force: true })
    } catch {
      // Missing, in use, or not ours to remove — all fine, this is best effort.
    }
  }
}

try {
  main()
} catch {
  // Never fail an uninstall.
}
