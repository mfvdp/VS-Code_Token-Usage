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
 * A file whose size and mtime are exactly what the last pass recorded is not
 * read: on a sweep over thousands of finished transcripts that is the difference
 * between a stat on the open handle and a read of the whole tail. The rotation
 * check runs first, because a replaced file can have the same size and an older
 * mtime.
 *
 * @param onRestart called before the first line whenever the file is re-read from the
 *   start, so derived per-file state (Codex baselines) is reset before it can taint a line
 * @returns true if the file was re-read from the start
 */
export async function readNewLines(
  file: string,
  cur: Cursor,
  onLine: (line: string) => void,
  maxBytes = 256 * 1024 * 1024,
  onRestart?: () => void,
): Promise<boolean> {
  // Open first, ask afterwards: every figure below — identity, size, mtime — comes from the
  // handle that is read, so nothing can change between a check and the read it guards. An
  // unchanged file costs an open and a stat instead of a stat alone; on a sweep over a
  // thousand finished transcripts that is a few milliseconds of kernel time per pass.
  let fh: fs.promises.FileHandle
  try { fh = await fs.promises.open(file, 'r') } catch { return false }
  let restarted = false
  try {
    const st = await fh.stat()
    if (st.ino !== cur.ino || st.dev !== cur.dev || st.size < cur.offset) {
      cur.offset = 0
      cur.ino = st.ino
      cur.dev = st.dev
      restarted = true
      onRestart?.()
    }
    if (!restarted && st.size === cur.size && st.mtimeMs === cur.mtime) return false
    if (st.size <= cur.offset) {
      cur.size = st.size
      cur.mtime = st.mtimeMs
      return restarted
    }
    const end = Math.min(st.size, cur.offset + maxBytes)
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

      // Leftover bytes of the previous chunk are prepended, so a multi-byte character
      // split by the chunk boundary is decoded whole rather than as two replacements.
      const data = rest.length ? Buffer.concat([rest, buf.subarray(0, bytesRead)]) : buf.subarray(0, bytesRead)
      let from = 0
      for (;;) {
        const nl = data.indexOf(0x0a, from)
        if (nl < 0) break
        // Advance by raw byte count, not by the re-encoded string: an invalid byte
        // sequence in the file would otherwise shift every later offset.
        lineStart += nl - from + 1
        const line = data.subarray(from, nl).toString('utf8')
        from = nl + 1
        if (line.length) onLine(line)
      }
      rest = data.subarray(from)
    }
    cur.offset = lineStart
    // A pass cut short by maxBytes records what it consumed, not the file size: otherwise
    // the next sweep would take the untouched remainder for an unchanged file and skip it.
    cur.size = end < st.size ? lineStart : st.size
    cur.mtime = st.mtimeMs
  } finally {
    await fh.close()
  }
  return restarted
}

/** A fresh cursor for a file that has never been read. */
export function newCursor(): Cursor {
  return { offset: 0, size: 0, ino: -1, dev: -1 }
}
