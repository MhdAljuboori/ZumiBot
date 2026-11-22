import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { RESTORE_REFUSALS } from '@zumibot/shared/fileRestore'
import type { FileChange } from '@zumibot/shared/files'
import type { ChatItem, ChatMeta } from '@zumibot/shared/types'
import { restoreFile, type RestoreDeps } from '../../src/core/files/restoreFile'
import { SnapshotStore } from '../../src/core/files/snapshotStore'

let dir: string
let snapshots: SnapshotStore
let items: ChatItem[]
let meta: ChatMeta
let trashed: string[]
let deps: RestoreDeps

const CHAT = 'c1'
const kept = async (text: string): Promise<string> => ((await snapshots.put(CHAT, text)) as { id: string }).id
const tool = (id: string, changes: Omit<FileChange, 'path'>[], path: string): ChatItem =>
  ({
    type: 'tool',
    id,
    name: 'Edit',
    input: {},
    result: 'ok',
    isError: false,
    blocked: false,
    ts: 1,
    changes: changes.map((c) => ({ ...c, path }))
  }) as ChatItem

beforeEach(async () => {
  dir = await fs.mkdtemp(join(tmpdir(), 'restore-'))
  snapshots = new SnapshotStore(join(dir, 'snaps'))
  items = []
  trashed = []
  meta = { id: CHAT, cwd: join(dir, 'work'), inFlight: false } as ChatMeta
  await fs.mkdir(meta.cwd)
  deps = {
    chat: async (id) => (id === CHAT ? meta : null),
    items: async () => items,
    snapshots,
    home: dir,
    readFile: (p) => fs.readFile(p),
    trash: async (p) => {
      trashed.push(p)
      await fs.rm(p)
    },
    log: () => {}
  }
})
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

describe('restoreFile', () => {
  it('writes the before copy back when the disk still holds the after copy, keeping the mode', async () => {
    const path = join(meta.cwd, 'a.txt')
    await fs.writeFile(path, 'new\n', { mode: 0o640 })
    await fs.chmod(path, 0o640)
    items = [tool('t1', [{ id: 't1', ts: 1, op: 'update', patch: null, before: await kept('old\n'), after: await kept('new\n') }], path)]
    expect(await restoreFile(deps, CHAT, path, 't1', 't1')).toEqual({ done: 'written' })
    expect(await fs.readFile(path, 'utf8')).toBe('old\n')
    if (process.platform !== 'win32') expect((await fs.stat(path)).mode & 0o777).toBe(0o640)
  })

  it('refuses, and writes nothing, when the file changed since', async () => {
    const path = join(meta.cwd, 'a.txt')
    await fs.writeFile(path, 'edited by hand\n')
    items = [tool('t1', [{ id: 't1', ts: 1, op: 'update', patch: null, before: await kept('old\n'), after: await kept('new\n') }], path)]
    await expect(restoreFile(deps, CHAT, path, 't1', 't1')).rejects.toThrow(RESTORE_REFUSALS.changed)
    expect(await fs.readFile(path, 'utf8')).toBe('edited by hand\n')
    await fs.rm(path)
    await expect(restoreFile(deps, CHAT, path, 't1', 't1')).rejects.toThrow(RESTORE_REFUSALS.changed)
  })

  it("undoes a range of steps back to the first one's before", async () => {
    const path = join(meta.cwd, 'a.txt')
    await fs.writeFile(path, 'v2')
    items = [
      tool('t1', [{ id: 't1', ts: 1, op: 'update', patch: null, before: await kept('v0'), after: await kept('v1') }], path),
      tool('t2', [{ id: 't2', ts: 2, op: 'update', patch: null, before: await kept('v1'), after: await kept('v2') }], path)
    ]
    // Undoing only the first step needs v1 on disk.
    await expect(restoreFile(deps, CHAT, path, 't1', 't1')).rejects.toThrow(RESTORE_REFUSALS.changed)
    expect(await restoreFile(deps, CHAT, path, 't1', 't2')).toEqual({ done: 'written' })
    expect(await fs.readFile(path, 'utf8')).toBe('v0')
  })

  it('moves a file the change created to the Trash', async () => {
    const path = join(meta.cwd, 'made.txt')
    await fs.writeFile(path, 'hi')
    items = [tool('t1', [{ id: 't1', ts: 1, op: 'create', patch: null, before: null, after: await kept('hi') }], path)]
    expect(await restoreFile(deps, CHAT, path, 't1', 't1')).toEqual({ done: 'trashed' })
    expect(trashed).toEqual([path])
  })

  it('brings back a deleted file only while it is still absent', async () => {
    const path = join(meta.cwd, 'gone.txt')
    items = [
      tool('t1', [{ id: 't1', ts: 1, op: 'update', patch: null, before: await kept('was'), after: null, why: { after: 'deleted' } }], path)
    ]
    await fs.writeFile(path, 'new one')
    await expect(restoreFile(deps, CHAT, path, 't1', 't1')).rejects.toThrow(RESTORE_REFUSALS.changed)
    await fs.rm(path)
    expect(await restoreFile(deps, CHAT, path, 't1', 't1')).toEqual({ done: 'written' })
    expect(await fs.readFile(path, 'utf8')).toBe('was')
  })

  it('refuses while the chat runs, for a path the chat never changed, and for an unknown chat', async () => {
    const path = join(meta.cwd, 'a.txt')
    await fs.writeFile(path, 'new')
    items = [tool('t1', [{ id: 't1', ts: 1, op: 'update', patch: null, before: await kept('old'), after: await kept('new') }], path)]
    await expect(restoreFile(deps, CHAT, '/etc/passwd', 't1', 't1')).rejects.toThrow(RESTORE_REFUSALS.gone)
    await expect(restoreFile(deps, 'nope', path, 't1', 't1')).rejects.toThrow('Chat not found')
    meta = { ...meta, inFlight: true }
    await expect(restoreFile(deps, CHAT, path, 't1', 't1')).rejects.toThrow(RESTORE_REFUSALS.running)
    expect(await fs.readFile(path, 'utf8')).toBe('new')
  })

  it('a failed write is the fixed sentence', async () => {
    const path = join(meta.cwd, 'a.txt')
    await fs.writeFile(path, 'new')
    items = [tool('t1', [{ id: 't1', ts: 1, op: 'update', patch: null, before: await kept('old'), after: await kept('new') }], path)]
    deps.write = async () => {
      throw Object.assign(new Error(`EACCES ${path}`), { code: 'EACCES' })
    }
    await expect(restoreFile(deps, CHAT, path, 't1', 't1')).rejects.toThrow(RESTORE_REFUSALS.failed)
  })
})
