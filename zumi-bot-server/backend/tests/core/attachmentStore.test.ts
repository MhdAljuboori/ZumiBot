import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AttachmentStore } from '../../src/core/attachments/attachmentStore'
import { ATTACH_MAX_BYTES, stageErrors } from '@zumibot/shared/attachments'

const u32be = (n: number): number[] => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]
function png(w: number, h: number): Buffer {
  return Buffer.from([
    0x89,
    0x50,
    0x4e,
    0x47,
    0x0d,
    0x0a,
    0x1a,
    0x0a,
    ...u32be(13),
    ...Buffer.from('IHDR'),
    ...u32be(w),
    ...u32be(h),
    8,
    6,
    0,
    0,
    0
  ])
}
const exists = (p: string): Promise<boolean> =>
  fs.access(p).then(
    () => true,
    () => false
  )

let tmp: string
let root: string
let src: string
let n: number
let store: AttachmentStore

beforeEach(async () => {
  tmp = await fs.mkdtemp(join(tmpdir(), 'attach-'))
  root = join(tmp, 'attachments')
  src = join(tmp, 'src')
  await fs.mkdir(src)
  n = 0
  store = new AttachmentStore(root, () => `id${++n}`)
})
afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true })
})

async function stageOk(name = 'shot.png', bytes: Uint8Array = png(32, 16)) {
  const r = await store.stageBytes(name, bytes)
  if (!r.ok) throw new Error(r.error)
  return r.attachment
}

describe('AttachmentStore', () => {
  it('copyFiles copies each attachment to the other chat and leaves the source alone', async () => {
    const a = await stageOk('a.png')
    const b = await stageOk('b.txt', Buffer.from('hi'))
    await store.commit('c1', [a.id, b.id])
    await store.copyFiles('c1', 'c2', [a, b])
    expect(await fs.readFile(store.pathOf('c2', b), 'utf8')).toBe('hi')
    expect(await exists(store.pathOf('c2', a))).toBe(true)
    await store.removeChat('c1')
    expect(await exists(store.pathOf('c2', a))).toBe(true)
    expect(await exists(store.pathOf('c1', a))).toBe(false)
  })

  it('copyFiles skips a file that is gone and rejects a bad chat id', async () => {
    const a = await stageOk('a.png')
    await expect(store.copyFiles('c1', 'c2', [a])).resolves.toBeUndefined()
    expect(await exists(store.dirOf('c2'))).toBe(false)
    await expect(store.copyFiles('../x', 'c2', [a])).rejects.toThrow('Invalid chat id')
    await expect(store.copyFiles('c1', 'a/b', [a])).rejects.toThrow('Invalid chat id')
  })

  it('removeFiles deletes only the named attachment folders', async () => {
    const a = await stageOk('a.png')
    const b = await stageOk('b.png')
    await store.commit('c1', [a.id, b.id])
    await store.removeFiles('c1', [a.id, '../evil'])
    expect(await store.chatFile('c1', a.id)).toBeNull()
    expect(await store.chatFile('c1', b.id)).not.toBeNull()
  })

  it('stagePath copies the file and fills metadata', async () => {
    const p = join(src, 'shot.png')
    const bytes = png(32, 16)
    await fs.writeFile(p, bytes)
    const r = await store.stagePath(p)
    expect(r).toEqual({ ok: true, attachment: { id: 'id1', name: 'shot.png', mime: 'image/png', size: bytes.length, kind: 'image' } })
    expect(await exists(join(root, '.staged', 'id1', 'shot.png'))).toBe(true)
    expect(await store.stagedFile('id1')).toBe(join(root, '.staged', 'id1', 'shot.png'))
  })

  it('kind is file when the bytes are not an image, whatever the name', async () => {
    const p = join(src, 'notes.png')
    await fs.writeFile(p, 'just text')
    const r = await store.stagePath(p)
    expect(r.ok && r.attachment.mime).toBe('application/octet-stream')
    expect(r.ok && r.attachment.kind).toBe('file')
  })

  it('an image over the inline limits is a file', async () => {
    const p = join(src, 'huge.png')
    await fs.writeFile(p, png(8001, 10))
    const r = await store.stagePath(p)
    expect(r.ok && r.attachment.kind).toBe('file')
    expect(r.ok && r.attachment.mime).toBe('image/png')
  })

  it('rejects folders and files over 25 MB', async () => {
    const dir = join(src, 'folder')
    await fs.mkdir(dir)
    expect(await store.stagePath(dir)).toEqual({ ok: false, name: 'folder', error: stageErrors.folder('folder') })
    const big = join(src, 'big.bin')
    await fs.writeFile(big, '')
    await fs.truncate(big, ATTACH_MAX_BYTES + 1)
    expect(await store.stagePath(big)).toEqual({ ok: false, name: 'big.bin', error: stageErrors.tooBig('big.bin') })
  })

  it('a missing path is unreadable', async () => {
    expect(await store.stagePath(join(src, 'nope.txt'))).toEqual({ ok: false, name: 'nope.txt', error: stageErrors.unreadable('nope.txt') })
  })

  it('stageBytes keeps only the base name', async () => {
    const a = await stageOk('../../x.png')
    expect(a.name).toBe('x.png')
    expect(await exists(join(root, '.staged', a.id, 'x.png'))).toBe(true)
    expect((await stageOk('')).name).toBe('file')
  })

  it('commit moves staged files into the chat folder in order', async () => {
    const a = await stageOk('a.png')
    const b = await stageOk('b.png')
    const out = await store.commit('c1', [b.id, a.id])
    expect(out.map((x) => x.id)).toEqual([b.id, a.id])
    expect(await exists(store.pathOf('c1', a))).toBe(true)
    expect(store.pathOf('c1', a)).toBe(join(root, 'c1', a.id, 'a.png'))
    expect(store.dirOf('c1')).toBe(join(root, 'c1'))
    expect(await store.stagedFile(a.id)).toBeNull()
    expect(await store.chatFile('c1', a.id)).toBe(store.pathOf('c1', a))
  })

  it('commit rejects an unknown id without moving any file', async () => {
    const good = await stageOk()
    await expect(store.commit('c1', [good.id, 'nope'])).rejects.toThrow(stageErrors.GONE)
    expect(await store.stagedFile(good.id)).not.toBeNull()
    expect(await exists(join(root, 'c1'))).toBe(false)
  })

  it('chatFile returns null for ids with path characters', async () => {
    expect(await store.chatFile('c1', '..')).toBeNull()
    expect(await store.chatFile('c1', 'a/b')).toBeNull()
    expect(await store.chatFile('../c1', 'id1')).toBeNull()
    expect(await store.chatFile('c1', 'missing')).toBeNull()
    expect(await store.stagedFile('../x')).toBeNull()
  })

  it('discard deletes the staged copy', async () => {
    const a = await stageOk()
    await store.discard(a.id)
    expect(await exists(join(root, '.staged', a.id))).toBe(false)
    expect(await store.stagedFile(a.id)).toBeNull()
    await store.discard('unknown')
  })

  it('removeChat deletes the chat folder', async () => {
    const a = await stageOk()
    await store.commit('c1', [a.id])
    await store.removeChat('c1')
    expect(await exists(join(root, 'c1'))).toBe(false)
  })

  it('clearStaged empties .staged', async () => {
    const a = await stageOk()
    await store.clearStaged()
    expect(await exists(join(root, '.staged', a.id))).toBe(false)
    expect(await store.stagedFile(a.id)).toBeNull()
  })
})
