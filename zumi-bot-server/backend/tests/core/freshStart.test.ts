import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import { join } from 'node:path'
import { ChatStore } from '../../src/core/store/chatStore'
import { startFresh } from '../../src/core/chat/freshStart'

let dir: string
let chats: ChatStore
const big = { used: 500_000, window: 1_000_000, at: 1 }

beforeEach(async () => {
  dir = await fs.mkdtemp(join(os.tmpdir(), 'zumibot-fresh-start-'))
  let clock = 0
  let nextId = 0
  chats = new ChatStore(
    dir,
    () => ++clock,
    () => `chat-${++nextId}`
  )
})
afterEach(() => fs.rm(dir, { recursive: true, force: true }))

describe('startFresh', () => {
  it('seeds a single chat with a session anew and drops its meter', async () => {
    const chat = await chats.create('alpha', dir)
    await chats.update(chat.id, { sessionId: 's-old', context: big })
    await startFresh(chats, (await chats.get(chat.id))!)
    const meta = await chats.get(chat.id)
    expect(meta?.next).toEqual({ seed: true, fresh: true })
    expect(meta?.context).toBeUndefined()
  })

  it('leaves a single chat with no session alone', async () => {
    const chat = await chats.create('alpha', dir)
    await startFresh(chats, chat)
    expect((await chats.get(chat.id))?.next).toBeUndefined()
  })

  it('restarts only the room members that have a session, and drops only their meters', async () => {
    const room = await chats.createGroup(['alpha', 'beta'], dir)
    await chats.updateGroup(room.id, (g) => ({ ...g, sessions: { alpha: 's-a', beta: null }, context: { alpha: big, beta: big } }))
    await startFresh(chats, (await chats.get(room.id))!)
    const g = (await chats.get(room.id))?.group
    expect(g?.next).toEqual({ alpha: { seed: true, fresh: true } })
    expect(g?.context).toEqual({ beta: big })
  })
})
