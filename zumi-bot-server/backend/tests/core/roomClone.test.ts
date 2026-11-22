import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import type { ChatItem, ChatMeta } from '@zumibot/shared/types'
import { cloneRoom, type CloneDeps } from '../../src/core/chat/roomClone'
import { ChatStore } from '../../src/core/store/chatStore'

let tmp: string
let store: ChatStore
let deps: CloneDeps
let copyAllowed: Mock<(from: string, to: string) => void>
let n: number

beforeEach(async () => {
  tmp = await fs.mkdtemp(join(tmpdir(), 'room-clone-'))
  n = 0
  store = new ChatStore(
    join(tmp, 'data'),
    () => 1000,
    () => `c${++n}`
  )
  copyAllowed = vi.fn<(from: string, to: string) => void>()
  deps = { store, allowed: { copyAllowed }, now: () => 5000 }
})
afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true })
})

const items: ChatItem[] = [
  { type: 'user', id: 'u1', text: 'hello', ts: 1 },
  { type: 'assistant', id: 'a1', text: 'hi', ts: 2 }
]

async function seedRoom(over: Record<string, unknown> = {}, group: Record<string, unknown> = {}): Promise<ChatMeta> {
  const c = await store.createGroup(['writer', 'critic'], '/work', 'Be kind')
  await store.saveItems(c.id, items)
  return store.update(c.id, {
    title: 'API room',
    reactions: { a1: ['👍'] },
    replyAt: 10,
    seenAt: 9,
    mark: { at: 8, from: 7 },
    held: true,
    group: {
      ...c.group!,
      sessions: { writer: 's1', critic: 's2' },
      seen: { writer: 'a1', critic: 'a1' },
      next: { writer: { seed: true } },
      ...group
    },
    ...over
  } as Partial<ChatMeta>)
}

describe('cloneRoom', () => {
  it('copies members, role and folder, and starts with no history', async () => {
    const src = await seedRoom()
    const c = await cloneRoom(deps, src.id, 'New room', null)
    expect(c.id).not.toBe(src.id)
    expect(c.title).toBe('New room')
    expect(c.cwd).toBe('/work')
    expect(c.group).toMatchObject({ members: ['writer', 'critic'], role: 'Be kind' })
    // toMatchObject treats {} and [] as subsets, so emptiness is checked exactly
    expect(c.group!.sessions).toEqual({})
    expect(c.group!.seen).toEqual({})
    expect(c.group!.active).toEqual([])
    expect(c.group!.queue).toEqual([])
    expect(c.group).not.toHaveProperty('next')
    expect(c.group).not.toHaveProperty('context')
    expect(c.group).not.toHaveProperty('handoff')
    for (const k of ['reactions', 'tasks', 'held', 'replyAt', 'seenAt', 'mark', 'context', 'next']) expect(c).not.toHaveProperty(k)
    expect(await store.loadItems(c.id)).toEqual([])
    expect(await store.get(c.id)).toEqual(c)
  })

  it("copies no sessions, so no member's session engine either: a Codex member starts a new thread", async () => {
    const src = await seedRoom({}, { sessions: { writer: 's1', critic: 'th-2' }, sessionEngines: { critic: 'codex' } })
    const c = await cloneRoom(deps, src.id, 'New room', null)
    expect(c.group!.sessions).toEqual({})
    expect(c.group).not.toHaveProperty('sessionEngines')
    expect((await store.get(src.id))?.group?.sessionEngines).toEqual({ critic: 'codex' })
  })

  it('clone room copies no tasks: the ones made in the source room stay on the board under it', async () => {
    const src = await seedRoom()
    const from = { chatId: src.id, turn: 't', itemId: 'a1', label: 'Reply', at: 1 }
    await store.updateBoard(() => ({
      v: 1,
      rev: 1,
      seen: {},
      items: [
        {
          id: 't1',
          text: 'x',
          group: null,
          from,
          addedBy: 'writer',
          done: null,
          removed: null,
          last: { action: 'added', by: 'writer', at: 1 },
          rev: 1,
          updatedAt: 1
        }
      ]
    }))
    const c = await cloneRoom(deps, src.id, 'New room', null)
    expect((await store.loadBoard()).items.map((i) => i.from.chatId)).toEqual([src.id])
    expect(c.id).not.toBe(src.id)
  })

  it('stores the handoff with its origin and time', async () => {
    const src = await seedRoom()
    const c = await cloneRoom(deps, src.id, 'New room', 'Summary text')
    expect(c.group?.handoff).toEqual({ text: 'Summary text', from: { chatId: src.id, title: 'API room' }, at: 5000 })
    expect((await store.get(c.id))?.group?.handoff).toEqual(c.group?.handoff)
  })

  it('names an untitled source Room in the handoff', async () => {
    const src = await seedRoom({ title: '' })
    const c = await cloneRoom(deps, src.id, 'New room', 'x')
    expect(c.group?.handoff?.from.title).toBe('Room')
  })

  it('names a whitespace-only source title Room too', async () => {
    const src = await seedRoom({ title: '   ' })
    const c = await cloneRoom(deps, src.id, 'New room', 'x')
    expect(c.group?.handoff?.from.title).toBe('Room')
  })

  it('carries no handoff when none is given, even if the source has one', async () => {
    const src = await seedRoom({}, { handoff: { text: 'old', from: { chatId: 'z', title: 'Z' }, at: 1 } })
    const c = await cloneRoom(deps, src.id, 'New room', null)
    expect(c.group).not.toHaveProperty('handoff')
    expect((await store.get(c.id))?.group).not.toHaveProperty('handoff')
  })

  it('leaves the source untouched', async () => {
    const src = await seedRoom()
    const before = structuredClone(await store.get(src.id))
    await cloneRoom(deps, src.id, 'New room', 'Summary')
    expect(await store.get(src.id)).toEqual(before)
    expect(await store.loadItems(src.id)).toEqual(items)
  })

  it('copies the allow-for-chat memory once per member', async () => {
    const src = await seedRoom()
    const c = await cloneRoom(deps, src.id, 'New room', null)
    expect(copyAllowed.mock.calls).toEqual([
      [`${src.id}:writer`, `${c.id}:writer`],
      [`${src.id}:critic`, `${c.id}:critic`]
    ])
  })

  it('rejects a missing source and a single chat', async () => {
    await expect(cloneRoom(deps, 'nope', 'T', null)).rejects.toThrow('Chat not found: nope')
    const single = await store.create('helper', '/work')
    await expect(cloneRoom(deps, single.id, 'T', null)).rejects.toThrow('Not a group chat')
    expect(copyAllowed).not.toHaveBeenCalled()
    expect((await store.list()).map((c) => c.id)).toEqual([single.id])
  })

  it('Clone room keeps the worktree only when asked', async () => {
    const wt = { root: '/r-a', branch: 'zumibot/room-1', source: '/r', folder: '/r/app', links: [] }
    const src = await seedRoom({ cwd: '/r-a/app', worktree: wt })
    const kept = await cloneRoom(deps, src.id, 'Kept', null, { keepWorktree: true })
    expect(kept).toMatchObject({ cwd: '/r-a/app', worktree: wt })
    // Default: a plain room in the folder the user picked.
    const plain = await cloneRoom(deps, src.id, 'Plain', null)
    expect(plain.cwd).toBe(wt.folder)
    expect(plain).not.toHaveProperty('worktree')
    // A plain source is unchanged by either.
    const p2 = await seedRoom()
    expect((await cloneRoom(deps, p2.id, 'X', null)).cwd).toBe('/work')
    expect(await cloneRoom(deps, p2.id, 'Y', null, { keepWorktree: true })).not.toHaveProperty('worktree')
  })
})
