import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import { join } from 'node:path'
import type { ChatItem, ChatPush } from '@zumibot/shared/types'
import { ChatStore } from '../../src/core/store/chatStore'
import { LimitResumes, NOT_WAITING } from '../../src/core/chat/limitResumes'
import { removeDir } from '../support/platform'

const NOW = Date.parse('2026-11-06T18:00:00Z')
const HOUR = 3_600_000
let dir: string
let chats: ChatStore
let resumes: LimitResumes
let sent: unknown[][]
let idled: string[]
let answer: 'started' | 'gone' | 'busy' // what the task queue's continueLimit says
let pushes: ChatPush[]
let running: Set<string>
let timers: { fn: () => void; ms: number; cleared: boolean }[]
let nextId: number

const limitError = (resetsAt: number | null, extra: { agent?: string; compact?: true } = {}): ChatItem => ({
  type: 'error',
  id: `e-${++nextId}`,
  text: 'Claude exited with code 1',
  ts: 2,
  limit: { resetsAt, ...extra }
})
const user = (id: string, text = 'Check the design'): ChatItem => ({ type: 'user', id, text, ts: 1 })
const limitedChat = async (...errors: ChatItem[]) => {
  const chat = await chats.create('alpha', dir)
  await chats.saveItems(chat.id, [
    user('u1'),
    { type: 'assistant', id: 'a1', text: "You've hit your session limit", ts: 2 },
    ...(errors.length > 0 ? errors : [limitError(NOW + HOUR)])
  ])
  return chat
}
const settle = () => new Promise((resolve) => setTimeout(resolve, 30))
const live = () => timers.filter((t) => !t.cleared)
// A wait is armed after the chat store's file reads, which a loaded runner (Windows CI) can stretch past one settle.
const waitArmed = async (n = 1) => {
  for (let i = 0; i < 100 && timers.length < n; i++) await settle()
}
const fire = async () => {
  for (let i = 0; i < 100 && live().length === 0; i++) await settle()
  live().at(-1)!.fn()
  await settle()
}

beforeEach(async () => {
  dir = await fs.mkdtemp(join(os.tmpdir(), 'zumibot-limit-resumes-'))
  let clock = NOW
  nextId = 0
  chats = new ChatStore(
    dir,
    () => ++clock,
    () => `chat-${++nextId}`
  )
  sent = []
  idled = []
  answer = 'started'
  pushes = []
  running = new Set()
  timers = []
  resumes = new LimitResumes({
    store: chats,
    // As TaskQueue does: the send ends the wait before it starts the turn; a busy chat (a compaction) or a wait gone
    // meanwhile sends nothing.
    tasks: {
      continueLimit: async (...args) => {
        if (answer !== 'started') return answer
        sent.push(args)
        await resumes.cancel(args[0])
        return 'started'
      },
      idle: (id) => {
        idled.push(id)
      }
    },
    isRunning: (id) => running.has(id),
    push: (p) => pushes.push(p),
    now: () => NOW,
    newId: () => `m-${++nextId}`,
    setTimer: (fn, ms) => {
      const t = { fn, ms, cleared: false }
      timers.push(t)
      return {
        clear: () => {
          t.cleared = true
        }
      }
    },
    log: () => {}
  })
})

afterEach(() => removeDir(dir))

describe('LimitResumes', () => {
  it('stores the wait a minute past the reset, keeps the sidebar order, and continues the chat then', async () => {
    const chat = await limitedChat()
    resumes.idle(chat.id)
    await waitArmed()
    const stored = await chats.get(chat.id)
    expect(stored?.resume).toEqual({ at: NOW + HOUR + 60_000, after: 'u1', waits: 1 })
    expect(stored?.updatedAt).toBe(chat.updatedAt)
    expect(pushes.at(-1)).toMatchObject({ chatId: chat.id, kind: 'meta', meta: { resume: { after: 'u1' } } })
    expect(live().map((t) => t.ms)).toEqual([HOUR + 60_000])
    // Another idle while the timer runs arms nothing more.
    resumes.idle(chat.id)
    await settle()
    expect(timers).toHaveLength(1)

    await fire()
    // Ahead of any queued task, for the wait on u1 only; 'routine': not the user's own message.
    expect(sent).toEqual([[chat.id, 'continue', expect.any(String), 'u1', 'routine']])
    expect((await chats.get(chat.id))?.resume).toBeUndefined()
  })

  it('in a room, asks each member the limit stopped and waits for the last reset', async () => {
    const room = await chats.createGroup(['alpha', 'beta'], dir)
    await chats.saveItems(room.id, [user('u1'), limitError(NOW + HOUR, { agent: 'alpha' }), limitError(NOW + 2 * HOUR, { agent: 'beta' })])
    resumes.idle(room.id)
    await settle()
    expect((await chats.get(room.id))?.resume?.at).toBe(NOW + 2 * HOUR + 60_000)
    await fire()
    expect(sent[0]?.[1]).toBe('@alpha @beta continue')
  })

  it('does not wait when the turn did not stop on the limit alone', async () => {
    const cases: ChatItem[][] = [
      [limitError(null)],
      [limitError(NOW + HOUR), { type: 'error', id: 'x', text: 'provider failed', ts: 2 }],
      [{ type: 'notice', id: 'n', kind: 'stopped', text: 'Stopped', ts: 2 }],
      [limitError(NOW + HOUR, { compact: true })]
    ]
    for (const errors of cases) {
      const chat = await limitedChat(...errors)
      resumes.idle(chat.id)
      await settle()
      expect((await chats.get(chat.id))?.resume).toBeUndefined()
    }
    expect(timers).toEqual([])
  })

  it("leaves a routine run's turn, an asked chat and a running chat alone", async () => {
    const routineChat = await limitedChat()
    resumes.idle(routineChat.id, new Set(['u1']))
    const asked = await limitedChat()
    await chats.update(asked.id, { asked: { by: 'beta', from: 'src', fromTitle: 'Source', chain: [] } })
    resumes.idle(asked.id)
    const busy = await limitedChat()
    running.add(busy.id)
    resumes.idle(busy.id)
    await settle()
    for (const c of [routineChat, asked, busy]) expect((await chats.get(c.id))?.resume).toBeUndefined()
    expect(timers).toEqual([])
  })

  it("waits with queued messages too, leaving them unheld: they follow the continue's turn", async () => {
    const chat = await limitedChat()
    await chats.addTask(chat.id, { id: 't1', text: 'next', ts: 3 })
    await chats.addTask(chat.id, { id: 't2', text: 'after', ts: 4 })
    resumes.idle(chat.id)
    await waitArmed()
    const stored = await chats.get(chat.id)
    expect(stored?.resume).toEqual({ at: NOW + HOUR + 60_000, after: 'u1', waits: 1 })
    expect(stored?.held).toBeUndefined()
    await fire()
    expect(sent).toEqual([[chat.id, 'continue', expect.any(String), 'u1', 'routine']])
    expect((await chats.get(chat.id))?.tasks?.map((t) => t.id)).toEqual(['t1', 't2'])
  })

  it('holds the queued messages when nothing continues the limited turn by itself', async () => {
    const withTasks = async (...errors: ChatItem[]) => {
      const chat = await limitedChat(...errors)
      await chats.addTask(chat.id, { id: 't1', text: 'next', ts: 3 })
      return chat
    }
    const routineChat = await withTasks()
    resumes.idle(routineChat.id, new Set(['u1']))
    const unknownReset = await withTasks(limitError(null))
    resumes.idle(unknownReset.id)
    const otherError = await withTasks(limitError(NOW + HOUR), { type: 'error', id: 'x', text: 'provider failed', ts: 2 })
    resumes.idle(otherError.id)
    await settle()
    for (const c of [routineChat, unknownReset, otherError]) {
      const meta = await chats.get(c.id)
      expect(meta?.resume).toBeUndefined()
      expect(meta?.held).toBe(true)
      expect(pushes).toContainEqual(expect.objectContaining({ chatId: c.id, kind: 'meta', meta: expect.objectContaining({ held: true }) }))
    }
    expect(timers).toEqual([])
  })

  it('leaves the tasks alone after a turn the limit did not stop, or a compaction it stopped', async () => {
    const cases: ChatItem[][] = [
      [{ type: 'notice', id: 'n', kind: 'stopped', text: 'Stopped', ts: 2 }],
      [{ type: 'error', id: 'x', text: 'provider failed', ts: 2 }],
      [limitError(NOW + HOUR, { compact: true })]
    ]
    for (const errors of cases) {
      const chat = await limitedChat(...errors)
      await chats.addTask(chat.id, { id: 't1', text: 'next', ts: 3 })
      resumes.idle(chat.id)
      await settle()
      const meta = await chats.get(chat.id)
      expect(meta?.resume).toBeUndefined()
      expect(meta?.held).toBeUndefined()
    }
  })

  it('settled resolves once the idle check has stored the wait', async () => {
    const chat = await limitedChat()
    resumes.idle(chat.id)
    await resumes.settled(chat.id)
    expect((await chats.get(chat.id))?.resume).toMatchObject({ after: 'u1' })
    await expect(resumes.settled('nothing-queued')).resolves.toBeUndefined()
  })

  it('still waits when the queued messages are held', async () => {
    const chat = await limitedChat()
    await chats.addTask(chat.id, { id: 't1', text: 'next', ts: 3 })
    await chats.holdTasks(chat.id)
    resumes.idle(chat.id)
    await settle()
    expect((await chats.get(chat.id))?.resume).toBeDefined()
  })

  it('stores no wait in a pausing or paused chat: a limit that ended a pausing turn still lands it paused', async () => {
    const pausing = await limitedChat()
    await chats.patchInPlace(pausing.id, () => ({ pause: 'pausing', held: true }))
    resumes.idle(pausing.id)
    const paused = await limitedChat(limitError(NOW + HOUR), { type: 'notice', id: 'p', kind: 'userPaused', text: 'Paused.', ts: 3 })
    await chats.patchInPlace(paused.id, () => ({ pause: 'paused', held: true }))
    resumes.idle(paused.id)
    await settle()
    for (const c of [pausing, paused]) expect((await chats.get(c.id))?.resume).toBeUndefined()
    expect(timers).toEqual([])
  })

  it('a wait that comes due in a chat paused meanwhile is dropped and sends nothing', async () => {
    const chat = await limitedChat()
    resumes.idle(chat.id)
    await settle()
    expect((await chats.get(chat.id))?.resume).toBeDefined()
    await chats.patchInPlace(chat.id, () => ({ pause: 'paused', held: true }))
    await fire()
    expect(sent).toEqual([])
    const after = await chats.get(chat.id)
    expect(after?.resume).toBeUndefined()
    expect(after?.pause).toBe('paused')
  })

  it('cancel ends the wait, and its old timer sends nothing', async () => {
    const chat = await limitedChat()
    resumes.idle(chat.id)
    await waitArmed()
    const timer = live()[0]!
    await resumes.cancel(chat.id)
    expect((await chats.get(chat.id))?.resume).toBeUndefined()
    expect(timer.cleared).toBe(true)
    expect(pushes.at(-1)).toMatchObject({ kind: 'meta', meta: { id: chat.id } })
    timer.fn()
    await settle()
    expect(sent).toEqual([])
  })

  it('a wait whose turn is no longer the last ends without sending, and wakes the queue for the tasks it held', async () => {
    const chat = await limitedChat()
    resumes.idle(chat.id)
    await settle()
    await chats.saveItems(chat.id, [user('u-other', 'another version')])
    await fire()
    expect(sent).toEqual([])
    expect((await chats.get(chat.id))?.resume).toBeUndefined()
    expect(idled).toEqual([chat.id])
  })

  it('a wait that comes due while a compaction runs stays, and goes at the next idle', async () => {
    const chat = await limitedChat()
    resumes.idle(chat.id)
    await settle()
    answer = 'busy'
    await fire()
    expect(sent).toEqual([])
    expect((await chats.get(chat.id))?.resume).toBeDefined()
    const armed = timers.length
    answer = 'started'
    resumes.idle(chat.id) // the compaction ended
    await waitArmed(armed + 1)
    // Armed again for the stored time (the fake clock stands still; really it is due, so it goes at once).
    expect(timers.slice(armed).map((t) => t.ms)).toEqual([HOUR + 60_000])
    await fire()
    expect(sent).toEqual([[chat.id, 'continue', expect.any(String), 'u1', 'routine']])
    expect((await chats.get(chat.id))?.resume).toBeUndefined()
  })

  it('dontContinue holds no Run result: a tray of those alone stays unheld, and the queue is woken for them', async () => {
    const run = { processId: 'p_0000000001' }
    const alone = await limitedChat()
    const mixed = await limitedChat()
    const plain = await limitedChat()
    await chats.addTask(alone.id, { id: 'r1', text: 'result', run, ts: 3 })
    await chats.addTask(mixed.id, { id: 't1', text: 'next', ts: 3 })
    await chats.addTask(mixed.id, { id: 'r2', text: 'result', run, ts: 3 })
    await chats.addTask(plain.id, { id: 't2', text: 'next', ts: 3 })
    for (const c of [alone, mixed, plain]) resumes.idle(c.id)
    await waitArmed(3)
    for (const c of [alone, mixed, plain]) await resumes.dontContinue(c.id)
    expect((await chats.get(alone.id))?.held).toBeUndefined()
    expect((await chats.get(alone.id))?.resume).toBeUndefined()
    expect((await chats.get(mixed.id))?.held).toBe(true)
    expect((await chats.get(plain.id))?.held).toBe(true)
    // Only a tray with a Run result needs the queue now; a held one of visible tasks alone waits for the user.
    expect(idled).toEqual([alone.id, mixed.id])
  })

  it('dontContinue ends the wait and holds the queued tasks for the user; a chat with none stays unheld', async () => {
    const chat = await limitedChat()
    await chats.addTask(chat.id, { id: 't1', text: 'next', ts: 3 })
    const bare = await limitedChat()
    resumes.idle(chat.id)
    resumes.idle(bare.id)
    await waitArmed(2)
    const timer = live()[0]!
    await resumes.dontContinue(chat.id)
    await resumes.dontContinue(bare.id)
    const meta = await chats.get(chat.id)
    expect(meta?.resume).toBeUndefined()
    expect(meta?.held).toBe(true)
    expect(meta?.updatedAt).toBe(chat.updatedAt)
    expect(pushes).toContainEqual({ chatId: chat.id, kind: 'meta', meta: expect.objectContaining({ held: true }) })
    const bareMeta = await chats.get(bare.id)
    expect(bareMeta?.held).toBeUndefined()
    expect(bareMeta?.resume).toBeUndefined()
    expect(live()).toEqual([])
    timer.fn()
    await settle()
    expect(sent).toEqual([])
  })

  it('continueNow sends the continue at once as the user, ahead of the tasks, and ends the wait', async () => {
    const chat = await limitedChat()
    await chats.addTask(chat.id, { id: 't1', text: 'next', ts: 3 })
    resumes.idle(chat.id)
    await waitArmed()
    const timer = live()[0]!
    await resumes.continueNow(chat.id)
    expect(sent).toEqual([[chat.id, 'continue', expect.any(String), 'u1', 'user']])
    await settle()
    expect((await chats.get(chat.id))?.resume).toBeUndefined()
    expect(timer.cleared).toBe(true)
    expect((await chats.get(chat.id))?.tasks?.map((t) => t.id)).toEqual(['t1'])
  })

  it("continueNow asks a room's stopped members by name", async () => {
    const room = await chats.createGroup(['alpha', 'beta'], dir)
    await chats.saveItems(room.id, [user('u1'), limitError(NOW + HOUR, { agent: 'beta' })])
    resumes.idle(room.id)
    await waitArmed()
    await resumes.continueNow(room.id)
    expect(sent[0]?.[1]).toBe('@beta continue')
  })

  it('continueNow refuses a chat with no wait, one whose turn moved on, a paused one and a busy one', async () => {
    const none = await limitedChat()
    await expect(resumes.continueNow(none.id)).rejects.toThrow(NOT_WAITING)
    const moved = await limitedChat()
    resumes.idle(moved.id)
    const paused = await limitedChat()
    resumes.idle(paused.id)
    const busy = await limitedChat()
    resumes.idle(busy.id)
    await waitArmed(3)
    await chats.saveItems(moved.id, [user('u-other', 'another version')])
    await expect(resumes.continueNow(moved.id)).rejects.toThrow(NOT_WAITING)
    await chats.patchInPlace(paused.id, () => ({ pause: 'paused', held: true }))
    await expect(resumes.continueNow(paused.id)).rejects.toThrow(NOT_WAITING)
    answer = 'busy'
    await expect(resumes.continueNow(busy.id)).rejects.toThrow('Chat is busy')
    answer = 'gone'
    await expect(resumes.continueNow(busy.id)).rejects.toThrow(NOT_WAITING)
    await expect(resumes.continueNow('missing')).rejects.toThrow('Chat not found')
    expect(sent).toEqual([])
    expect((await chats.get(busy.id))?.resume).toBeDefined()
  })

  it('counts continues in a row and stops past the cap; a message of the user starts the count again', async () => {
    const chat = await limitedChat()
    resumes.idle(chat.id)
    await settle()
    for (let wait = 1; wait <= 5; wait++) {
      expect((await chats.get(chat.id))?.resume?.waits).toBe(wait)
      await fire()
      const messageId = sent.at(-1)![2] as string
      await chats.saveItems(chat.id, [...(await chats.loadItems(chat.id)), user(messageId, 'continue'), limitError(NOW + HOUR)])
      resumes.idle(chat.id)
      await settle()
    }
    expect((await chats.get(chat.id))?.resume).toBeUndefined()
    expect(sent).toHaveLength(5)
    expect((await chats.get(chat.id))?.held).toBeUndefined() // no tasks: nothing to hold

    await chats.saveItems(chat.id, [...(await chats.loadItems(chat.id)), user('by-hand', 'go on'), limitError(NOW + HOUR)])
    const before = timers.length
    resumes.idle(chat.id)
    await waitArmed(before + 1)
    expect((await chats.get(chat.id))?.resume).toMatchObject({ after: 'by-hand', waits: 1 })
  })

  it('stop() clears the timers and keeps the wait stored; recover() arms it again', async () => {
    const chat = await limitedChat()
    resumes.idle(chat.id)
    await waitArmed()
    resumes.stop()
    expect(timers.every((t) => t.cleared)).toBe(true)
    timers[0]!.fn()
    await settle()
    expect(sent).toEqual([])
    expect((await chats.get(chat.id))?.resume).toBeDefined()

    const after = new LimitResumes({
      store: chats,
      tasks: {
        continueLimit: async (...args) => {
          sent.push(args)
          return 'started'
        },
        idle: () => {}
      },
      isRunning: () => false,
      push: () => {},
      now: () => NOW + 2 * HOUR,
      newId: () => 'm-next',
      setTimer: (fn, ms) => {
        const t = { fn, ms, cleared: false }
        timers.push(t)
        return {
          clear: () => {
            t.cleared = true
          }
        }
      }
    })
    const before = timers.length
    await after.recover()
    await waitArmed(before + 1)
    expect(timers.at(-1)!.ms).toBe(0)
    timers.at(-1)!.fn()
    await settle()
    expect(sent).toEqual([[chat.id, 'continue', 'm-next', 'u1', 'routine']])
  })

  it("a deleted chat's timer does nothing", async () => {
    const chat = await limitedChat()
    resumes.idle(chat.id)
    await settle()
    await chats.remove(chat.id)
    await fire()
    expect(sent).toEqual([])
  })
})
