import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import { join } from 'node:path'
import { ChatStore } from '../../src/core/store/chatStore'
import { ReadMarks } from '../../src/core/chat/readMarks'
import { isUnread } from '@zumibot/shared/unread'
import type { ChatMeta, ChatPush } from '@zumibot/shared/types'

let dir: string
let storeClock: number
let idSeq: number
let now: number
let looking: Set<string>
let pushes: ChatPush[]
let log: ReturnType<typeof vi.fn<(line: string) => void>>
let store: ChatStore

const marks = (s: Pick<ChatStore, 'patchInPlace'> = store) =>
  new ReadMarks({ store: s, lookingAt: (id) => looking.has(id), push: (p) => pushes.push(p), now: () => now, log })

beforeEach(async () => {
  dir = await fs.mkdtemp(join(os.tmpdir(), 'zumibot-readmarks-'))
  storeClock = 1000
  idSeq = 0
  now = 500
  looking = new Set()
  pushes = []
  log = vi.fn<(line: string) => void>()
  store = new ChatStore(
    dir,
    () => ++storeClock,
    () => `id-${++idSeq}`
  )
})
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

const metaOf = (p: ChatPush): ChatMeta => {
  if (p.kind !== 'meta') throw new Error('not a meta push')
  return p.meta
}

describe('ReadMarks', () => {
  it('a reply marks the chat unread and pushes its meta', async () => {
    const c = await store.create('a', '/a')
    await marks().turnEnded({ chatId: c.id, agent: 'a', outcome: 'ok' })
    const got = (await store.get(c.id))!
    expect(got.replyAt).toBe(500)
    expect(got.seenAt).toBeUndefined()
    expect(got.updatedAt).toBe(c.updatedAt)
    expect(pushes).toHaveLength(1)
    expect(pushes[0]).toMatchObject({ chatId: c.id, kind: 'meta' })
    expect(isUnread(metaOf(pushes[0]))).toBe(true)
  })

  it('an asked chat is never unread after a turn, even when nobody looks', async () => {
    const c = await store.create('b', '/b')
    await marks().turnEnded({ chatId: c.id, agent: 'b', outcome: 'ok', asked: true })
    const got = (await store.get(c.id))!
    expect(got.replyAt).toBe(500)
    expect(got.seenAt).toBe(500)
    expect(isUnread(got)).toBe(false)
  })

  it('an error marks it too', async () => {
    const c = await store.create('a', '/a')
    await marks().turnEnded({ chatId: c.id, agent: 'a', outcome: 'error' })
    expect((await store.get(c.id))!.replyAt).toBe(500)
  })

  it('a stopped turn changes nothing', async () => {
    const c = await store.create('a', '/a')
    await marks().turnEnded({ chatId: c.id, agent: 'a', outcome: 'stopped' })
    expect(await store.get(c.id)).toEqual(c)
    expect(pushes).toEqual([])
  })

  it('a reply while someone looks is read at once', async () => {
    const c = await store.create('a', '/a')
    looking.add(c.id)
    await marks().turnEnded({ chatId: c.id, agent: 'a', outcome: 'ok' })
    const got = (await store.get(c.id))!
    expect(got).toMatchObject({ replyAt: 500, seenAt: 500 })
    expect(isUnread(got)).toBe(false)
  })

  it('ChatService turn ends for a room are ignored', async () => {
    const room = await store.createGroup(['a', 'b'], '/a')
    await marks().turnEnded({ chatId: room.id, agent: 'a', outcome: 'ok' })
    expect(await store.get(room.id)).toEqual(room)
    expect(pushes).toEqual([])
  })

  it('a room reply marks the room', async () => {
    const room = await store.createGroup(['a', 'b'], '/a')
    await marks().roomTurnEnded({ chatId: room.id, agent: 'a', outcome: 'ok', passed: false })
    expect((await store.get(room.id))!.replyAt).toBe(500)
    expect(pushes).toHaveLength(1)
  })

  it('a room pass changes nothing', async () => {
    const room = await store.createGroup(['a', 'b'], '/a')
    await marks().roomTurnEnded({ chatId: room.id, agent: 'a', outcome: 'ok', passed: true })
    expect(await store.get(room.id)).toEqual(room)
    expect(pushes).toEqual([])
  })

  it('a stopped room turn changes nothing', async () => {
    const room = await store.createGroup(['a', 'b'], '/a')
    await marks().roomTurnEnded({ chatId: room.id, agent: 'a', outcome: 'stopped', passed: false })
    expect(await store.get(room.id)).toEqual(room)
    expect(pushes).toEqual([])
  })

  it('started clears an unread chat', async () => {
    const c = await store.create('a', '/a')
    const m = marks()
    await m.turnEnded({ chatId: c.id, agent: 'a', outcome: 'ok' })
    pushes = []
    now = 600
    await m.started(c.id)
    expect((await store.get(c.id))!.seenAt).toBe(600)
    expect(pushes).toHaveLength(1)
    await m.started(c.id)
    expect(pushes).toHaveLength(1)
  })

  it('started never leaves the chat unread when replyAt is ahead of the clock (synced from a faster clock)', async () => {
    const c = await store.create('a', '/a')
    await store.patchInPlace(c.id, () => ({ replyAt: 900 }))
    await marks().started(c.id)
    expect(isUnread((await store.get(c.id))!)).toBe(false)
  })

  it('stopped on a running chat never leaves it unread either', async () => {
    const c = await store.create('a', '/a')
    await store.patchInPlace(c.id, () => ({ replyAt: 900, inFlight: true }))
    await marks().stopped(c.id)
    expect(isUnread((await store.get(c.id))!)).toBe(false)
  })

  it('started on a read chat writes nothing', async () => {
    const c = await store.create('a', '/a')
    await marks().started(c.id)
    expect(await store.get(c.id)).toEqual(c)
    expect(pushes).toEqual([])
  })

  it('stopped stamps seenAt only while the chat runs', async () => {
    const c = await store.create('a', '/a')
    const m = marks()
    await m.stopped(c.id)
    expect(pushes).toEqual([])
    expect((await store.get(c.id))!.seenAt).toBeUndefined()
    await store.update(c.id, { inFlight: true })
    now = 700
    await m.stopped(c.id)
    expect((await store.get(c.id))!.seenAt).toBe(700)
    expect(pushes).toHaveLength(1)
  })

  describe('Mark unread', () => {
    it('marks a read chat unread from the message and pushes its meta', async () => {
      const c = await store.create('a', '/a')
      await store.patchInPlace(c.id, () => ({ replyAt: 400, seenAt: 450 }))
      const meta = await marks().markUnread(c.id, 399)
      const got = (await store.get(c.id))!
      expect(got.mark).toEqual({ at: 500, from: 399 })
      expect(got.updatedAt).toBe(c.updatedAt)
      expect(isUnread(got)).toBe(true)
      expect(meta).toEqual(got)
      expect(pushes).toHaveLength(1)
      expect(metaOf(pushes[0]).mark).toEqual({ at: 500, from: 399 })
    })

    it('lands past a seenAt ahead of the clock, or it would never be on', async () => {
      const c = await store.create('a', '/a')
      await store.patchInPlace(c.id, () => ({ replyAt: 900, seenAt: 900 }))
      await marks().markUnread(c.id, 300)
      expect(isUnread((await store.get(c.id))!)).toBe(true)
    })

    it('rejects a chat that is gone, since the user asked for it', async () => {
      await expect(marks().markUnread('nope', 1)).rejects.toThrow('Chat not found')
      expect(pushes).toEqual([])
    })

    it('a look start (a refocus) keeps it', async () => {
      const c = await store.create('a', '/a')
      const m = marks()
      await m.markUnread(c.id, 100)
      pushes = []
      now = 600
      await m.started(c.id)
      expect(isUnread((await store.get(c.id))!)).toBe(true)
      expect(pushes).toEqual([])
    })

    it('looking away from a running chat keeps it', async () => {
      const c = await store.create('a', '/a')
      await store.update(c.id, { inFlight: true })
      const m = marks()
      await m.markUnread(c.id, 100)
      now = 600
      await m.stopped(c.id)
      expect(isUnread((await store.get(c.id))!)).toBe(true)
    })

    it('a reply while someone looks keeps it and is unread too', async () => {
      const c = await store.create('a', '/a')
      const m = marks()
      await m.markUnread(c.id, 100)
      looking.add(c.id)
      now = 600
      await m.turnEnded({ chatId: c.id, agent: 'a', outcome: 'ok' })
      const got = (await store.get(c.id))!
      expect(got.replyAt).toBe(600)
      expect(got.mark).toEqual({ at: 500, from: 100 })
      expect(isUnread(got)).toBe(true)
    })

    it('an open after the mark clears it', async () => {
      const c = await store.create('a', '/a')
      const m = marks()
      await m.markUnread(c.id, 100)
      pushes = []
      now = 700
      await m.opened(c.id, 650)
      const got = (await store.get(c.id))!
      expect(got.mark).toBeUndefined()
      expect(got.seenAt).toBe(700)
      expect(isUnread(got)).toBe(false)
      expect(pushes).toHaveLength(1)
    })

    it('an open before the mark (the page it was set from) keeps it', async () => {
      const c = await store.create('a', '/a')
      const m = marks()
      await m.markUnread(c.id, 100)
      pushes = []
      now = 700
      await m.opened(c.id, 450)
      expect(isUnread((await store.get(c.id))!)).toBe(true)
      expect(pushes).toEqual([])
    })

    it('an open of an unmarked chat writes nothing (a look start reads it)', async () => {
      const c = await store.create('a', '/a')
      await store.patchInPlace(c.id, () => ({ replyAt: 400 }))
      await marks().opened(c.id, 450)
      expect((await store.get(c.id))!.seenAt).toBeUndefined()
      expect(pushes).toEqual([])
    })

    it('an open never leaves it unread when the mark is ahead of the clock', async () => {
      const c = await store.create('a', '/a')
      await store.patchInPlace(c.id, () => ({ mark: { at: 900, from: 100 }, replyAt: 950 }))
      await marks().opened(c.id, 920)
      expect(isUnread((await store.get(c.id))!)).toBe(false)
    })
  })

  it('a removed chat is ignored quietly', async () => {
    const c = await store.create('a', '/a')
    await store.remove(c.id)
    const m = marks()
    await m.turnEnded({ chatId: c.id, agent: 'a', outcome: 'ok' })
    await m.roomTurnEnded({ chatId: c.id, agent: 'a', outcome: 'ok', passed: false })
    await m.started(c.id)
    await m.stopped(c.id)
    await m.opened(c.id, 1)
    expect(pushes).toEqual([])
    expect(log).not.toHaveBeenCalled()
  })

  it('a store failure is logged and swallowed', async () => {
    const boom = { patchInPlace: () => Promise.reject(new Error('secret chat text')) }
    await expect(marks(boom).turnEnded({ chatId: 'x', agent: 'a', outcome: 'ok' })).resolves.toBeUndefined()
    expect(log).toHaveBeenCalledTimes(1)
    expect(log).toHaveBeenCalledWith('read marks: turn end failed')
  })

  it('names each failing hook in the log', async () => {
    const boom = { patchInPlace: () => Promise.reject(new Error('x')) }
    const m = marks(boom)
    await m.roomTurnEnded({ chatId: 'x', agent: 'a', outcome: 'ok', passed: false })
    await m.started('x')
    await m.stopped('x')
    await m.opened('x', 1)
    expect(log.mock.calls.map((c) => c[0])).toEqual([
      'read marks: room turn end failed',
      'read marks: look start failed',
      'read marks: look stop failed',
      'read marks: open failed'
    ])
  })

  it('a push failure is logged and a throwing log is swallowed', async () => {
    const c = await store.create('a', '/a')
    log.mockImplementation(() => {
      throw new Error('log broke')
    })
    const m = new ReadMarks({
      store,
      lookingAt: () => false,
      push: () => {
        throw new Error('push broke')
      },
      now: () => now,
      log
    })
    await expect(m.turnEnded({ chatId: c.id, agent: 'a', outcome: 'ok' })).resolves.toBeUndefined()
    expect(log).toHaveBeenCalledWith('read marks: turn end failed')
  })
})
