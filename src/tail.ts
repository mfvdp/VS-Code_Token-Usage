// SPDX-FileCopyrightText: 2026 Frederik Marx
// SPDX-License-Identifier: AGPL-3.0-or-later

import * as fs from 'fs'
import { Cursor } from './types'

/**
 * Reads every COMPLETE line appended to a file since the last call.
 *
 * The cursor only advances past the last finished line — a half-written trailing
 * line is read again on the next pass. If (dev, ino) changes or the file shrinks,
 * it is re-read from the start; that covers rotation and atomic replacement,
 * which would otherwise silently undercount.
 *
 * @returns true if the file was re-read from the start (caller must reset derived state)
 */
export async function readNewLines(
  file: string,
  cur: Cursor,
  onLine: (line: string) => void,
  maxBytes = 256 * 1024 * 1024,
): Promise<boolean> {
  let st: fs.Stats
  try { st = await fs.promises.stat(file) } catch { return false }

  let restarted = false
  if (st.ino !== cur.ino || st.dev !== cur.dev || st.size < cur.offset) {
    cur.offset = 0
    cur.ino = st.ino
    cur.dev = st.dev
    restarted = true
  }
  if (st.size <= cur.offset) { cur.size = st.size; return restarted }

  const end = Math.min(st.size, cur.offset + maxBytes)
  const fh = await fs.promises.open(file, 'r')
  try {
    const CHUNK = 1 << 20
    let pos = cur.offset
    let rest = Buffer.alloc(0)
    // Byte position where the current incomplete line starts.
    let lineStart = cur.offset

    while (pos < end) {
      const len = Math.min(CHUNK, end - pos)
      const buf = Buffer.allocUnsafe(len)
      const { bytesRead } = await fh.read(buf, 0, len, pos)
      if (bytesRead <= 0) break
      pos += bytesRead

      const data = rest.length ? Buffer.concat([rest, buf.subarray(0, bytesRead)]) : buf.subarray(0, bytesRead)
      let from = 0
      for (;;) {
        const nl = data.indexOf(0x0a, from)
        if (nl < 0) break
        const line = data.subarray(from, nl).toString('utf8')
        lineStart += Buffer.byteLength(line, 'utf8') + 1
        from = nl + 1
        if (line.length) onLine(line)
      }
      rest = data.subarray(from)
    }
    cur.offset = lineStart
    cur.size = st.size
  } finally {
    await fh.close()
  }
  return restarted
}

/** A fresh cursor for a file that has never been read. */
export function newCursor(): Cursor {
  return { offset: 0, size: 0, ino: -1, dev: -1 }
}
