import { beforeEach, expect, test, vi } from 'vitest'
import type { ChatItem, ChatMeta, ChatPush } from '@zumibot/shared/types'
import type { ReplyOptionsAnswer, ReplyOptionsInput } from '../../src/core/chat/replyOptions'
import { ReplyOptions, type ReplyOptionsDeps } from '../../src/core/chat/replyOptionsService'

let meta: ChatMeta
let items: ChatItem[]
let pushes: ChatPush[]
let on: boolean
let read: ReturnType<typeof vi.fn<(chatId: string, input: ReplyOptionsInput, signal: AbortSignal) => Promise<ReplyOptionsAnswer | null>>>
let failGet: boolean
let running: boolean

const ans = (options: string[], question = '', summary = ''): ReplyOptionsAnswer => ({ options, question, summary })

beforeEach(() => {
  meta = { id: 'c1', agentName: 'git-helper', sessionId: null, cwd: '/w', title: 't', createdAt: 0, updatedAt: 0, inFlight: false }
  items = [
    { type: 'user', id: 'u1', text: 'rename it', ts: 0 },
    { type: 'assistant', id: 'a1', text: 'Native or Subagent-driven?', ts: 0 }
  ]
  pushes = []
  on = true
  failGet = false
  running = false
  read = vi.fn(async () => ans(['Native', 'Subagent-driven'], 'Which way should I build it?', 'Wrote the plan.'))
})

function service(): ReplyOptions {
  const store: ReplyOptionsDeps['store'] = {
    get: async (id) => {
      if (failGet) throw new Error('EIO')
      return id === meta.id ? meta : null
    },
    loadItems: async () => items,
    // As ChatStore's: the patch is read against the meta as it is when the write runs.
    patchInPlace: async (id, fn) => {
      if (id !== meta.id) return null
      const patch = fn(meta)
      if (!patch) return null
      meta = { ...meta, ...patch }
      return meta
    }
  }
  return new ReplyOptions({ store, push: (p) => pushes.push(p), enabled: async () => on, running: () => running, read })
}

test('stores the options for the reply and pushes the meta', async () => {
  await service().idle('c1')
  expect(read).toHaveBeenCalledTimes(1)
  expect(read.mock.calls[0][1]).toEqual({ speakers: ['Git Helper'], message: 'rename it', reply: 'Native or Subagent-driven?' })
  expect(meta.suggested).toEqual({
    after: 'a1',
    options: ['Native', 'Subagent-driven'],
    question: 'Which way should I build it?',
    summary: 'Wrote the plan.'
  })
  expect(pushes).toEqual([{ chatId: 'c1', kind: 'meta', meta }])
})

test('stores an empty list too, so the same reply is never read twice', async () => {
  read.mockResolvedValue(ans([], 'Anything?', 'Nothing to offer.'))
  const s = service()
  await s.idle('c1')
  expect(meta.suggested).toEqual({ after: 'a1', options: [] })
  await s.idle('c1')
  expect(read).toHaveBeenCalledTimes(1)
})

test('no read while the switch is off', async () => {
  on = false
  await service().idle('c1')
  expect(read).not.toHaveBeenCalled()
})

test('no read for a running or paused chat', async () => {
  meta = { ...meta, inFlight: true }
  await service().idle('c1')
  meta = { ...meta, inFlight: false, pause: 'paused' }
  await service().idle('c1')
  expect(read).not.toHaveBeenCalled()
})

test('no read for a chat answered away from the composer', async () => {
  meta = { ...meta, task: {} as never }
  await service().idle('c1')
  expect(read).not.toHaveBeenCalled()
})

test('no read when the chat does not end on a reply that asks', async () => {
  items = [...items, { type: 'error', id: 'e1', text: 'boom', ts: 0 }]
  await service().idle('c1')
  items = [items[0], { type: 'assistant', id: 'a2', text: 'All done.', ts: 0 }]
  await service().idle('c1')
  expect(read).not.toHaveBeenCalled()
})

test('no read while a queued message is about to start: its run would refuse the write', async () => {
  meta = { ...meta, tasks: [{} as never] }
  await service().idle('c1')
  expect(read).not.toHaveBeenCalled()
})

test('a held queue still gets options: its messages wait for the user', async () => {
  meta = { ...meta, tasks: [{} as never], held: true }
  await service().idle('c1')
  expect(read).toHaveBeenCalledTimes(1)
})

test('no read while a run has claimed the chat but not yet stored it as running', async () => {
  running = true
  await service().idle('c1')
  expect(read).not.toHaveBeenCalled()
})

test('no write when a run claimed the chat during the read', async () => {
  read.mockImplementation(async () => {
    running = true
    return ans(['Native'])
  })
  await service().idle('c1')
  expect(meta.suggested).toBeUndefined()
  expect(pushes).toEqual([])
})

test('a new idle aborts the earlier read even when it reads nothing itself', async () => {
  const signals: AbortSignal[] = []
  read.mockImplementationOnce(async (_c, _i, signal) => {
    signals.push(signal)
    return new Promise<ReplyOptionsAnswer>(() => {})
  })
  const s = service()
  void s.idle('c1')
  await vi.waitFor(() => expect(signals).toHaveLength(1))
  on = false
  await s.idle('c1')
  expect(signals[0].aborted).toBe(true)
})

test('no read when the last item was already read', async () => {
  meta = { ...meta, suggested: { after: 'a1', options: ['Native'] } }
  await service().idle('c1')
  expect(read).not.toHaveBeenCalled()
})

test('no answer stores nothing and pushes nothing', async () => {
  read.mockResolvedValue(null)
  await service().idle('c1')
  expect(meta.suggested).toBeUndefined()
  expect(pushes).toEqual([])
})

test('no write when the chat started running meanwhile', async () => {
  read.mockImplementation(async () => {
    meta = { ...meta, inFlight: true }
    return ans(['Native'])
  })
  await service().idle('c1')
  expect(meta.suggested).toBeUndefined()
  expect(pushes).toEqual([])
})

test('a new idle aborts the earlier read', async () => {
  let release!: (v: ReplyOptionsAnswer) => void
  const signals: AbortSignal[] = []
  read.mockImplementationOnce(async (_c, _i, signal) => {
    signals.push(signal)
    return new Promise<ReplyOptionsAnswer>((r) => (release = r))
  })
  read.mockImplementationOnce(async (_c, _i, signal) => {
    signals.push(signal)
    return ans(['Second'])
  })
  const s = service()
  const first = s.idle('c1')
  await vi.waitFor(() => expect(signals).toHaveLength(1))
  // The first read's reply was replaced: a new last item, so the second idle reads again.
  items = [...items, { type: 'assistant', id: 'a2', text: 'Local or remote?', ts: 0 }]
  await s.idle('c1')
  expect(signals[0].aborted).toBe(true)
  release(ans(['First']))
  await first
  expect(meta.suggested).toEqual({ after: 'a2', options: ['Second'] })
})

test('close aborts every read', async () => {
  const signals: AbortSignal[] = []
  read.mockImplementation(async (_c, _i, signal) => {
    signals.push(signal)
    return new Promise<ReplyOptionsAnswer>(() => {})
  })
  const s = service()
  void s.idle('c1')
  await vi.waitFor(() => expect(signals).toHaveLength(1))
  s.close()
  expect(signals[0].aborted).toBe(true)
})

test('no read once closed: a turn that ends while the server stops spawns nothing', async () => {
  const s = service()
  s.close()
  await s.idle('c1')
  expect(read).not.toHaveBeenCalled()
})

test('no read when the service closes while the gates are read', async () => {
  const s = service()
  let open!: () => void
  const gate = new Promise<void>((r) => (open = r))
  const d = s as unknown as { d: ReplyOptionsDeps }
  d.d.enabled = async () => (await gate, true)
  const p = s.idle('c1')
  s.close()
  open()
  await p
  expect(read).not.toHaveBeenCalled()
})

test('never rejects', async () => {
  failGet = true
  const err = vi.spyOn(console, 'error').mockImplementation(() => {})
  await expect(service().idle('c1')).resolves.toBeUndefined()
  expect(err).toHaveBeenCalledWith('reply options failed:', 'c1', 'error')
  err.mockRestore()
})
