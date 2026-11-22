import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { SNAPSHOT_MAX_BYTES, SNAPSHOT_ID_RE, SnapshotStore } from '../../src/core/files/snapshotStore'

const exists = (p: string): Promise<boolean> =>
  fs.access(p).then(
    () => true,
    () => false
  )

let tmp: string
let root: string
let store: SnapshotStore

beforeEach(async () => {
  tmp = await fs.mkdtemp(join(tmpdir(), 'snap-'))
  root = join(tmp, 'file-copies')
  store = new SnapshotStore(root)
})
afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true })
})

async function putId(chat: string, text: string): Promise<string> {
  const r = await store.put(chat, text)
  if (!('id' in r)) throw new Error(r.miss)
  return r.id
}

describe('SnapshotStore', () => {
  it('put returns a sha256 id and read gives the same text back, CRLF and no trailing newline included', async () => {
    for (const text of ['one\r\ntwo\r\n', 'no newline at end', '', 'café \u{1F600}']) {
      const id = await putId('chat-1', text)
      expect(id).toMatch(SNAPSHOT_ID_RE)
      expect(await store.read('chat-1', id)).toBe(text)
    }
  })

  it('put twice gives the same id and one file', async () => {
    const a = await putId('chat-1', 'same')
    const b = await putId('chat-1', 'same')
    expect(b).toBe(a)
    expect(await fs.readdir(join(root, 'chat-1'))).toEqual([a])
  })

  it('writes files as 0600 and the chat folder as 0700', async () => {
    const id = await putId('chat-1', 'secret')
    if (process.platform !== 'win32') expect((await fs.stat(join(root, 'chat-1', id))).mode & 0o777).toBe(0o600)
    if (process.platform !== 'win32') expect((await fs.stat(join(root, 'chat-1'))).mode & 0o777).toBe(0o700)
  })

  it('refuses text over the limit and text with a NUL', async () => {
    expect(await store.put('chat-1', 'a'.repeat(SNAPSHOT_MAX_BYTES))).toHaveProperty('id')
    expect(await store.put('chat-1', 'a'.repeat(SNAPSHOT_MAX_BYTES + 1))).toEqual({ miss: 'too-big' })
    // Two-byte characters: few characters, over the limit in bytes.
    expect(await store.put('chat-1', 'é'.repeat(SNAPSHOT_MAX_BYTES / 2 + 1))).toEqual({ miss: 'too-big' })
    expect(await store.put('chat-1', 'a\u0000b')).toEqual({ miss: 'binary' })
  })

  it('read returns null for a bad chat id, a bad id or a missing file', async () => {
    const id = await putId('chat-1', 'x')
    expect(await store.read('../x', id)).toBeNull()
    expect(await store.read('chat-1', '../x')).toBeNull()
    expect(await store.read('chat-1', 'abc')).toBeNull()
    expect(await store.read('chat-1', 'f'.repeat(64))).toBeNull()
    expect(await store.read('chat-2', id)).toBeNull()
  })

  it('pathOf gives the file path, and null for a bad chat id or id', async () => {
    const id = await putId('chat-1', 'x')
    expect(store.pathOf('chat-1', id)).toBe(join(root, 'chat-1', id))
    expect(store.pathOf('a/b', id)).toBeNull()
    expect(store.pathOf('', id)).toBeNull()
    expect(store.pathOf('chat-1', '../x')).toBeNull()
    expect(store.pathOf('chat-1', id.toUpperCase())).toBeNull()
  })

  it('put refuses a bad chat id', async () => {
    await expect(store.put('a/b', 'x')).rejects.toThrow('Invalid chat id')
  })

  it('copy copies the listed ids and skips missing ones', async () => {
    const a = await putId('chat-1', 'alpha')
    await putId('chat-1', 'beta')
    await store.copy('chat-1', 'chat-2', [a, 'f'.repeat(64), '../x'])
    expect(await store.read('chat-2', a)).toBe('alpha')
    expect(await fs.readdir(join(root, 'chat-2'))).toEqual([a])
    if (process.platform !== 'win32') expect((await fs.stat(join(root, 'chat-2', a))).mode & 0o777).toBe(0o600)
    if (process.platform !== 'win32') expect((await fs.stat(join(root, 'chat-2'))).mode & 0o777).toBe(0o700)
    expect(await store.read('chat-1', a)).toBe('alpha')
  })

  it('copy from a chat with no copies makes nothing', async () => {
    await store.copy('chat-1', 'chat-2', ['f'.repeat(64)])
    expect(await exists(join(root, 'chat-2'))).toBe(false)
  })

  it('removeChat removes the folder, only that chat, and ignores a bad id', async () => {
    const id = await putId('chat-1', 'x')
    await putId('chat-2', 'y')
    await store.removeChat('chat-1')
    expect(await exists(join(root, 'chat-1'))).toBe(false)
    expect(await store.read('chat-1', id)).toBeNull()
    expect(await exists(join(root, 'chat-2'))).toBe(true)
    await store.removeChat('../chat-2')
    expect(await exists(join(root, 'chat-2'))).toBe(true)
  })
})
