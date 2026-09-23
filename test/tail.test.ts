// SPDX-FileCopyrightText: 2026 Frederik Marx
// SPDX-License-Identifier: AGPL-3.0-or-later

import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import * as fs from 'fs'
import * as path from 'path'
import { newCursor, readNewLines, sameFile } from '../src/tail'
import { tmpDir } from './fixtures/helpers'

async function read(file: string, cur = newCursor(), maxBytes?: number): Promise<{ lines: string[]; restarted: boolean }> {
  const lines: string[] = []
  const restarted = await readNewLines(file, cur, (l) => lines.push(l), maxBytes)
  return { lines, restarted }
}

test('a partial trailing line is not delivered and is re-read on the next pass', async () => {
  const dir = tmpDir('tail')
  const file = path.join(dir, 'a.jsonl')
  fs.writeFileSync(file, 'line1\nlin')
  const cur = newCursor()
  let r = await read(file, cur)
  assert.deepEqual(r.lines, ['line1'])
  assert.equal(cur.offset, 6)
  assert.equal(cur.size, 9)
  assert.equal(typeof cur.mtime, 'number')
  fs.appendFileSync(file, 'e2\nline3\n')
  r = await read(file, cur)
  assert.deepEqual(r.lines, ['line2', 'line3'])
  assert.equal(cur.offset, 18)
  // Nothing new: no lines, cursor untouched.
  r = await read(file, cur)
  assert.deepEqual(r.lines, [])
  assert.equal(r.restarted, false)
  assert.equal(cur.offset, 18)
})

test('a 3-byte character straddling the 1 MiB chunk boundary is decoded whole', async () => {
  const dir = tmpDir('tail')
  const file = path.join(dir, 'wide.jsonl')
  const CHUNK = 1 << 20
  // "€" is E2 82 AC; put its first byte at the last position of the first chunk.
  const head = Buffer.alloc(CHUNK - 1, 0x78) // 'x'
  const content = Buffer.concat([head, Buffer.from('€\ntail\n', 'utf8')])
  fs.writeFileSync(file, content)
  const cur = newCursor()
  const r = await read(file, cur)
  assert.equal(r.lines.length, 2)
  assert.equal(r.lines[0].length, CHUNK)
  assert.equal(r.lines[0].endsWith('€'), true)
  assert.equal(r.lines[0].includes('�'), false)
  assert.equal(r.lines[1], 'tail')
  assert.equal(cur.offset, content.length)
})

test('a new inode at the same path restarts from the beginning', async () => {
  const dir = tmpDir('tail')
  const file = path.join(dir, 'rot.jsonl')
  fs.writeFileSync(file, 'old1\nold2\n')
  const cur = newCursor()
  let r = await read(file, cur)
  assert.deepEqual(r.lines, ['old1', 'old2'])
  assert.equal(r.restarted, true, 'the first read of a file is a restart from a blank cursor')
  const ino = cur.ino
  const other = path.join(dir, 'rot.new')
  fs.writeFileSync(other, 'new1\nnew2\nnew3\n')
  fs.renameSync(other, file)
  // The restart hook fires before the first line, so derived state is clean for all of them.
  const order: string[] = []
  const restarted = await readNewLines(file, cur, (l) => order.push(l), undefined, () => order.push('<restart>'))
  assert.equal(restarted, true)
  assert.notEqual(cur.ino, ino)
  assert.deepEqual(order, ['<restart>', 'new1', 'new2', 'new3'])
  // Unchanged afterwards: no restart, no hook.
  const again = await readNewLines(file, cur, () => order.push('x'), undefined, () => order.push('<restart>'))
  assert.equal(again, false)
  assert.equal(order.length, 4)
})

test('truncation restarts from the beginning', async () => {
  const dir = tmpDir('tail')
  const file = path.join(dir, 'trunc.jsonl')
  fs.writeFileSync(file, 'a1\na2\na3\n')
  const cur = newCursor()
  await read(file, cur)
  assert.equal(cur.offset, 9)
  fs.writeFileSync(file, 'b1\n')
  const r = await read(file, cur)
  assert.equal(r.restarted, true)
  assert.deepEqual(r.lines, ['b1'])
  assert.equal(cur.offset, 3)
})

test('maxBytes caps one pass at complete lines; later passes continue', async () => {
  const dir = tmpDir('tail')
  const file = path.join(dir, 'cap.jsonl')
  const lines = Array.from({ length: 6 }, (_, i) => `line-${i}-xx`) // 9 bytes + newline each
  fs.writeFileSync(file, lines.map((l) => `${l}\n`).join(''))
  const cur = newCursor()
  // 25 bytes hold two full lines and half of a third; the half is left for the next pass.
  let r = await read(file, cur, 25)
  assert.deepEqual(r.lines, ['line-0-xx', 'line-1-xx'])
  assert.equal(cur.offset, 20)
  r = await read(file, cur, 25)
  assert.deepEqual(r.lines, ['line-2-xx', 'line-3-xx'])
  assert.equal(cur.offset, 40)
  r = await read(file, cur, 25)
  assert.deepEqual(r.lines, ['line-4-xx', 'line-5-xx'])
  assert.equal(cur.offset, 60)
  r = await read(file, cur, 25)
  assert.deepEqual(r.lines, [])
})

test('unchanged size and mtime skip the read; a size change is always read', async () => {
  const dir = tmpDir('tail')
  const file = path.join(dir, 'pre.jsonl')
  fs.writeFileSync(file, 'a\nb')
  const cur = newCursor()
  let r = await read(file, cur)
  assert.deepEqual(r.lines, ['a'])
  const st = fs.statSync(file)
  assert.equal(cur.mtime, st.mtimeMs)
  // Same size, same mtime: the pre-filter must not even look inside.
  fs.writeFileSync(file, 'a\nc')
  fs.utimesSync(file, st.atime, st.mtime)
  r = await read(file, cur)
  assert.deepEqual(r.lines, [])
  assert.equal(r.restarted, false)
  // The size moved: read again, and the completed line is the current content.
  fs.appendFileSync(file, '\n')
  r = await read(file, cur)
  assert.deepEqual(r.lines, ['c'])
  assert.equal(cur.size, 4)
})

test('a missing file is neither an error nor a restart', async () => {
  const cur = newCursor()
  const r = await read(path.join(tmpDir('tail'), 'nope.jsonl'), cur)
  assert.deepEqual(r.lines, [])
  assert.equal(r.restarted, false)
  assert.equal(cur.offset, 0)
})

test('empty lines and CRLF endings are tolerated', async () => {
  const dir = tmpDir('tail')
  const file = path.join(dir, 'crlf.jsonl')
  fs.writeFileSync(file, 'a\r\n\n\nb\r\n')
  const r = await read(file)
  assert.deepEqual(r.lines, ['a\r', 'b\r'])
})

test('a new device number with the same inode is the same file: nothing is read twice', async () => {
  // A disk that enumerates as sda3 on one boot and sdb3 on the next hands every file a new
  // st_dev and keeps its inode. Re-reading from 0 there doubled the history on every boot.
  const dir = tmpDir('tail')
  const file = path.join(dir, 'flip.jsonl')
  fs.writeFileSync(file, 'a\nb\n')
  const cur = newCursor()
  await read(file, cur)
  const realDev = cur.dev
  const offset = cur.offset
  cur.dev = realDev + 16 // the cursor was saved while the disk had another number

  // Unchanged file: nothing delivered, no restart, and the cursor learns the new number.
  let restarts = 0
  let lines: string[] = []
  let restarted = await readNewLines(file, cur, (l) => lines.push(l), undefined, () => restarts++)
  assert.equal(restarted, false)
  assert.deepEqual(lines, [])
  assert.equal(restarts, 0)
  assert.equal(cur.offset, offset)
  assert.equal(cur.dev, realDev)

  // Grown file under yet another number: only the new line.
  cur.dev = realDev + 32
  fs.appendFileSync(file, 'c\n')
  lines = []
  restarted = await readNewLines(file, cur, (l) => lines.push(l), undefined, () => restarts++)
  assert.equal(restarted, false)
  assert.deepEqual(lines, ['c'])
  assert.equal(restarts, 0)
  assert.equal(cur.dev, realDev)
})

test('file identity is the inode and the consumed length, never the device number', () => {
  const cur = { ino: 42, offset: 100 }
  assert.equal(sameFile({ ino: 42, size: 100 }, cur), true)
  assert.equal(sameFile({ ino: 42, size: 5000 }, cur), true)
  assert.equal(sameFile({ ino: 43, size: 5000 }, cur), false, 'a new inode is a replaced file')
  assert.equal(sameFile({ ino: 42, size: 99 }, cur), false, 'a shorter file was truncated')
})
