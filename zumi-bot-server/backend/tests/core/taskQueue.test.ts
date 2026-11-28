import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import { join } from 'node:path'
import {
  NOTICE_TEXT,
  type Attachment,
  type ChatItem,
  type ChatMeta,
  type ChatPush,
  type NoticeKind,
  type QueuedTask,
  type WorkflowSent
} from '@zumibot/shared/types'
import { RESUME_TEXT } from '@zumibot/shared/pause'
import type { CapPause } from '@zumibot/shared/spendCaps'
import type { CardAsk } from '@zumibot/shared/todos'
import { RUN_ITEM_FIXED, type RunMark } from '@zumibot/shared/runBlocks'
import { ChatStore } from '../../src/core/store/chatStore'
import { AttachmentStore } from '../../src/core/attachments/attachmentStore'
import { ChatService } from '../../src/core/chat/chatService'
import { LimitResumes } from '../../src/core/chat/limitResumes'
import type { RunHandle, RunOptions, RunOutcome } from '../../src/core/chat/claudeRunner'
import type { RunEvent } from '../../src/core/chat/streamParser'
import type { SentCommand } from '@zumibot/shared/commands'
import { PAUSE_UNAVAILABLE, STEERED_ITEM_FIXED, TASKS_MAX, TaskQueue, type TaskQueueDeps } from '../../src/core/chat/taskQueue'

interface Deferred {
  promise: Promise<void>
  resolve(): void
  reject(e: unknown): void
}
const deferred = (): Deferred => {
  let resolve = () => {}
  let reject: (e: unknown) => void = () => {}
  const promise = new Promise<void>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

const att = (id: string): Attachment => ({ id, name: `${id}.txt`, mime: 'text/plain', size: 1, kind: 'file' })
const notice = (kind: NoticeKind): ChatItem => ({ type: 'notice', id: `n-${kind}`, kind, text: NOTICE_TEXT[kind], ts: 1 })
const said = (id: string): ChatItem => ({ type: 'user', id, text: id, ts: 1 })

let dir: string
let n: number
let store: ChatStore
let q: TaskQueue
let running: Set<string> // chats with a claimed run
let turns: Deferred[] // single-chat turns, in send order
let posts: Deferred[] // group sends, in send order
let pushes: ChatPush[]
let pushFails: boolean // the hub throwing on a broadcast
let pending: Set<Promise<unknown>> // store calls the queue made that have not settled
let errors: MockInstance<typeof console.error>
let enders: Map<string, Deferred> // the turn of each fake claim, ended by the test or by stop
let dones: Map<string, Promise<void>> // what whenIdle waits for: the claim's end, release included
let stopped: Set<string> // claims ended by stop: those fire idle, like a real release
let steerTakes: boolean // whether the running reply takes a steer (ChatService.steer's answer)

// Claims at once, like ChatService.send/rerun (and refuses a second claim, so an overlap fails the test).
// It fires no idle unless stop ended it: tests call idle() themselves.
const claim = (chatId: string): Promise<void> => {
  if (running.has(chatId)) throw new Error('Chat is already running')
  running.add(chatId)
  const t = deferred()
  turns.push(t)
  enders.set(chatId, t)
  const done = t.promise.finally(() => {
    running.delete(chatId)
    enders.delete(chatId)
    dones.delete(chatId)
    if (stopped.delete(chatId)) q.idle(chatId)
  })
  dones.set(chatId, done)
  return done
}

const fakes = () => ({
  chats: {
    isRunning: (id: string) => running.has(id),
    steer: vi.fn(async (_chatId: string, _task: QueuedTask) => steerTakes),
    send: vi.fn(
      (
        chatId: string,
        _text: string,
        _attachments?: Attachment[],
        _replyTo?: string,
        _messageId?: string,
        _command?: SentCommand,
        _todo?: true,
        _auto?: true,
        _sent?: WorkflowSent,
        _cardAsk?: CardAsk,
        _run?: RunMark,
        _later?: number
      ) => claim(chatId)
    ),
    rerun: vi.fn((chatId: string, _userId: string, _text: string | null) => {
      try {
        return claim(chatId)
      } catch (e) {
        return Promise.reject(e)
      }
    }),
    // Ends the claim like the real stop: its release then fires idle.
    stop: vi.fn((chatId: string) => {
      const t = enders.get(chatId)
      if (!t) return
      stopped.add(chatId)
      t.resolve()
    }),
    whenIdle: vi.fn(async (chatId: string) => {
      await dones.get(chatId)?.catch(() => {})
    }),
    switchVersion: vi.fn(async (_chatId: string, _userId: string, _index: number) => {}),
    compact: vi.fn((chatId: string, _note: string) => {
      try {
        return claim(chatId)
      } catch (e) {
        return Promise.reject(e)
      }
    }),
    canPause: vi.fn(async (_chatId: string) => true),
    setPauseFlag: vi.fn(async (_chatId: string, _on: boolean) => {}),
    // Lands a pause like ChatService: the tray held, then pausing → paused, checked in the write.
    finishPause: vi.fn(async (chatId: string) => {
      await track(store.holdTasks(chatId))
      return track(store.patchInPlace(chatId, (cur) => (cur.pause === 'pausing' ? { pause: 'paused' as const } : null)))
    })
  },
  // Resolves when the test says the message is posted; the room's claim is the test's to add to `running`.
  groups: {
    send: vi.fn(
      (
        _chatId: string,
        _text: string,
        _attachments?: Attachment[],
        _replyTo?: string,
        _messageId?: string,
        _command?: SentCommand,
        _todo?: true,
        _sent?: WorkflowSent,
        _auto?: true,
        _run?: RunMark
      ) => {
        const p = deferred()
        posts.push(p)
        return p.promise
      }
    ),
    rerun: vi.fn((_chatId: string, _userId: string, _text: string | null) => {
      const p = deferred()
      posts.push(p)
      return p.promise
    }),
    // Holds the chat until it ends, like the room's own compaction.
    compact: vi.fn((chatId: string, _member: string, _note: string) => {
      try {
        return claim(chatId)
      } catch (e) {
        return Promise.reject(e)
      }
    }),
    requestPause: vi.fn((_chatId: string) => true),
    // Resume's message: posted when the test says so, like send.
    resume: vi.fn((_chatId: string, _messageId?: string) => {
      const p = deferred()
      posts.push(p)
      return p.promise
    })
  },
  files: {
    // Takes an I/O tick like the real move of files, so a send without the lock would see the chat idle meanwhile.
    commit: vi.fn((_chatId: string, ids: string[]) =>
      track(new Promise<Attachment[]>((resolve) => setImmediate(() => resolve(ids.map(att)))))
    ),
    removeFiles: vi.fn(async (_chatId: string, _ids: string[]) => {})
  }
})
let f: ReturnType<typeof fakes>

const track = <T>(p: Promise<T>): Promise<T> => {
  pending.add(p)
  p.then(
    () => pending.delete(p),
    () => pending.delete(p)
  )
  return p
}
const tracked = (s: ChatStore): TaskQueueDeps['store'] => ({
  get: (id) => track(s.get(id)),
  list: () => track(s.list()),
  loadItems: (id) => track(s.loadItems(id)),
  addTask: (id, task, hold) => track(s.addTask(id, task, hold)),
  takeTask: (id) => track(s.takeTask(id)),
  dropTask: (id, taskId) => track(s.dropTask(id, taskId)),
  holdTasks: (id) => track(s.holdTasks(id)),
  patchInPlace: (id, fn) => track(s.patchInPlace(id, fn))
})

// Lets the queue run until it rests: microtasks, then the store's file I/O, again until no store call is left.
const flush = async () => {
  for (;;) {
    await new Promise<void>((r) => setImmediate(r))
    if (pending.size === 0) return
    await Promise.allSettled([...pending])
  }
}

const taskIds = async (id: string) => ((await store.get(id))?.tasks ?? []).map((t) => t.id)
const metaPushes = () => pushes.filter((p): p is Extract<ChatPush, { kind: 'meta' }> => p.kind === 'meta')
const single = () => store.create('alpha', dir)
const group = () => store.createGroup(['ui', 'wk'], dir)

beforeEach(async () => {
  dir = await fs.mkdtemp(join(os.tmpdir(), 'zumibot-tasks-'))
  n = 0
  let clock = 1000
  store = new ChatStore(
    dir,
    () => ++clock,
    () => `c${++n}`
  )
  running = new Set()
  turns = []
  posts = []
  pushes = []
  pushFails = false
  pending = new Set()
  enders = new Map()
  dones = new Map()
  stopped = new Set()
  steerTakes = true
  f = fakes()
  q = new TaskQueue({
    store: tracked(store),
    chats: f.chats,
    groups: f.groups,
    files: f.files,
    push: (p) => {
      if (pushFails) throw new Error('push failed')
      pushes.push(p)
    },
    now: () => 5000,
    newId: () => `id-${++n}`
  })
  errors = vi.spyOn(console, 'error').mockImplementation(() => {})
})
afterEach(async () => {
  await flush()
  errors.mockRestore()
  await fs.rm(dir, { recursive: true, force: true })
})

describe('TaskQueue.submit', () => {
  it("sends straight away when idle and returns 'sent'", async () => {
    const c = await single()
    const sent = q.submit(c.id, 'hi', [], undefined, 'm1')
    await flush()
    expect(f.chats.send).toHaveBeenCalledTimes(1)
    expect(f.chats.send).toHaveBeenCalledWith(c.id, 'hi', [], undefined, 'm1')
    expect(f.groups.send).not.toHaveBeenCalled()
    turns[0].resolve()
    await expect(sent).resolves.toBe('sent')
    expect(await taskIds(c.id)).toEqual([])
  })

  it("queues while running, keeps order, returns 'queued'", async () => {
    const c = await single()
    running.add(c.id)
    const results = await Promise.all([
      q.submit(c.id, 'one', [], undefined, 'm1'),
      q.submit(c.id, 'two', [], undefined, 'm2'),
      q.submit(c.id, 'three', [])
    ])
    await flush()
    expect(results).toEqual(['queued', 'queued', 'queued'])
    expect(await taskIds(c.id)).toEqual(['m1', 'm2', expect.stringMatching(/^id-/)])
    expect(f.chats.send).not.toHaveBeenCalled()
    expect(metaPushes()).toHaveLength(3)
    expect(metaPushes()[1].meta.tasks).toEqual([
      { id: 'm1', text: 'one', ts: 5000 },
      { id: 'm2', text: 'two', ts: 5000 }
    ])
  })

  it('an idle chat with held tasks sends a new message at once and keeps the tasks', async () => {
    const g = await group()
    await store.saveItems(g.id, [said('u1'), notice('paused')])
    await store.addTask(g.id, { id: 't1', text: 'held', ts: 1 })
    const sent = q.submit(g.id, 'new', [], undefined, 'm1')
    await flush()
    expect(f.groups.send).toHaveBeenCalledTimes(1)
    expect(f.groups.send).toHaveBeenCalledWith(g.id, 'new', [], undefined, 'm1')
    running.add(g.id) // the room claims the chat
    posts[0].resolve()
    await expect(sent).resolves.toBe('sent')
    await flush()
    expect(f.groups.send).toHaveBeenCalledTimes(1)
    expect(await taskIds(g.id)).toEqual(['t1'])
  })

  it('two sends racing on an idle chat: the first goes, the second queues', async () => {
    const c = await single()
    const first = q.submit(c.id, 'one', ['f1'], undefined, 'm1')
    const second = q.submit(c.id, 'two', ['f2'], undefined, 'm2')
    await expect(second).resolves.toBe('queued')
    expect(f.chats.send).toHaveBeenCalledTimes(1)
    expect(f.chats.send).toHaveBeenCalledWith(c.id, 'one', [att('f1')], undefined, 'm1')
    expect(await taskIds(c.id)).toEqual(['m2'])
    turns[0].resolve()
    await expect(first).resolves.toBe('sent')
  })

  it('a send racing the end of a run queues behind older tasks', async () => {
    const c = await single()
    running.add(c.id)
    await q.submit(c.id, 'one', [], undefined, 'm1')
    const second = q.submit(c.id, 'two', [], undefined, 'm2') // still reading the chat when the run releases
    running.delete(c.id)
    q.idle(c.id)
    await flush()
    await expect(second).resolves.toBe('queued')
    expect(f.chats.send).toHaveBeenCalledTimes(1)
    expect(f.chats.send).toHaveBeenCalledWith(c.id, 'one', [], undefined, 'm1')
    expect(await taskIds(c.id)).toEqual(['m2'])
  })

  it('a send to an idle chat with tasks waiting queues behind them and starts the oldest', async () => {
    const c = await single()
    await store.addTask(c.id, { id: 't1', text: 'held', ts: 1 }) // e.g. left by a pump that failed
    await expect(q.submit(c.id, 'new', [], undefined, 'm1')).resolves.toBe('queued')
    await flush() // no idle: the submit itself pumps
    expect(f.chats.send).toHaveBeenCalledTimes(1)
    expect(f.chats.send).toHaveBeenCalledWith(c.id, 'held', [], undefined, 't1')
    expect(await taskIds(c.id)).toEqual(['m1'])
  })

  it('queues behind a dispatch in progress', async () => {
    const g = await group()
    const first = q.submit(g.id, 'one', [], undefined, 'm1')
    await flush()
    expect(f.groups.send).toHaveBeenCalledTimes(1)
    // The post is still on its way and the room has not claimed the chat yet.
    await expect(q.submit(g.id, 'two', [], undefined, 'm2')).resolves.toBe('queued')
    expect(await taskIds(g.id)).toEqual(['m2'])
    running.add(g.id)
    posts[0].resolve()
    await expect(first).resolves.toBe('sent')
    await flush()
    expect(f.groups.send).toHaveBeenCalledTimes(1)
    expect(await taskIds(g.id)).toEqual(['m2'])
  })

  it('a queued command keeps its prompt', async () => {
    const c = await single()
    const command = { agent: 'alpha', name: 'check', prompt: 'Use check on L' }
    running.add(c.id)
    await q.submit(c.id, '/check L', [], undefined, 'm1', command)
    await flush()
    expect((await store.get(c.id))!.tasks![0]).toMatchObject({ id: 'm1', text: '/check L', command })
    running.delete(c.id)
    q.idle(c.id)
    await flush()
    expect(f.chats.send).toHaveBeenCalledWith(c.id, '/check L', [], undefined, 'm1', command)
    turns[0].resolve()
  })

  it('a rerun passes its command to the service', async () => {
    const c = await single()
    await store.saveItems(c.id, [said('u1')])
    const command = { agent: 'alpha', name: 'check', prompt: 'Use check on L' }
    const done = q.rerun(c.id, 'u1', '/check L', command)
    await flush()
    expect(f.chats.rerun).toHaveBeenCalledWith(c.id, 'u1', '/check L', command)
    turns[0].resolve()
    await done
  })

  it('a queued /todo message keeps todo when it starts', async () => {
    const c = await single()
    running.add(c.id)
    await q.submit(c.id, '/todo plan', [], undefined, 'm1', undefined, true)
    await flush()
    expect((await store.get(c.id))!.tasks![0]).toMatchObject({ id: 'm1', text: '/todo plan', todo: true })
    expect('command' in (await store.get(c.id))!.tasks![0]).toBe(false)
    running.delete(c.id)
    q.idle(c.id)
    await flush()
    expect(f.chats.send).toHaveBeenCalledWith(c.id, '/todo plan', [], undefined, 'm1', undefined, true)
    turns[0].resolve()
  })

  it('a send now of a queued /todo message keeps todo, with its command', async () => {
    const c = await single()
    const command = { agent: 'alpha', name: 'day', prompt: 'Plan', todos: true as const }
    running.add(c.id)
    await q.submit(c.id, '/day', [], undefined, 'm1', command, true)
    running.delete(c.id)
    await store.holdTasks(c.id)
    const sent = q.sendTask(c.id, 'm1')
    await flush()
    expect(f.chats.send).toHaveBeenCalledWith(c.id, '/day', [], undefined, 'm1', command, true)
    turns[0].resolve()
    await sent
  })

  it('a room gets todo as the last argument too, and none for a plain send', async () => {
    const g = await group()
    const a = q.submit(g.id, '/todo x', [], undefined, 'm1', undefined, true)
    await flush()
    expect(f.groups.send).toHaveBeenCalledWith(g.id, '/todo x', [], undefined, 'm1', undefined, true)
    posts[0].resolve()
    await a
    running.delete(g.id)
    const b = q.submit(g.id, 'plain', [], undefined, 'm2')
    await flush()
    expect(f.groups.send).toHaveBeenLastCalledWith(g.id, 'plain', [], undefined, 'm2')
    posts[1].resolve()
    await b
  })

  it('a rerun passes todo last, after the command, and only when set', async () => {
    const c = await single()
    await store.saveItems(c.id, [said('u1')])
    const command = { agent: 'alpha', name: 'day', prompt: 'Plan', todos: true as const }
    const first = q.rerun(c.id, 'u1', '/todo /day', command, true)
    await flush()
    expect(f.chats.rerun).toHaveBeenLastCalledWith(c.id, 'u1', '/todo /day', command, true)
    turns[0].resolve()
    await first
    const second = q.rerun(c.id, 'u1', '/todo x', undefined, true)
    await flush()
    expect(f.chats.rerun).toHaveBeenLastCalledWith(c.id, 'u1', '/todo x', undefined, true)
    turns[1].resolve()
    await second
    const third = q.rerun(c.id, 'u1', null)
    await flush()
    expect(f.chats.rerun).toHaveBeenLastCalledWith(c.id, 'u1', null)
    turns[2].resolve()
    await third
  })

  it('group chats dispatch through GroupService', async () => {
    const g = await group()
    const sent = q.submit(g.id, 'hi', ['f1'], 'r1', 'm1')
    await flush()
    expect(f.groups.send).toHaveBeenCalledWith(g.id, 'hi', [att('f1')], 'r1', 'm1')
    expect(f.chats.send).not.toHaveBeenCalled()
    posts[0].resolve()
    await expect(sent).resolves.toBe('sent')
  })

  it('refuses the 51st task before committing files', async () => {
    expect(TASKS_MAX).toBe(50)
    const c = await single()
    running.add(c.id)
    for (let k = 0; k < TASKS_MAX; k++) await store.addTask(c.id, { id: `t${k}`, text: 'x', ts: 1 })
    await expect(q.submit(c.id, 'one', ['f1'], undefined, 'm51')).rejects.toThrow('A chat can hold at most 50 queued messages')
    expect(f.files.commit).not.toHaveBeenCalled()
    expect(await taskIds(c.id)).toHaveLength(TASKS_MAX)
  })

  it('rejects an empty message and an unknown chat before committing files', async () => {
    const c = await single()
    await expect(q.submit(c.id, '  ', [])).rejects.toThrow('Message is empty')
    await expect(q.submit('nope', 'hi', ['f1'])).rejects.toThrow('Chat not found: nope')
    expect(f.files.commit).not.toHaveBeenCalled()
    expect(f.chats.send).not.toHaveBeenCalled()
  })

  it('a send that fails rejects the submit, as today', async () => {
    const c = await single()
    const sent = q.submit(c.id, 'hi', [], undefined, 'm1')
    await flush()
    turns[0].reject(new Error('Claude CLI not found'))
    await expect(sent).rejects.toThrow('Claude CLI not found')
  })
})

describe('TaskQueue.idle', () => {
  it('idle sends the oldest task with its id, files and replyTo, and removes it', async () => {
    const c = await single()
    running.add(c.id)
    await q.submit(c.id, 'one', ['f1'], 'r1', 'm1')
    await q.submit(c.id, 'two', [], undefined, 'm2')
    running.delete(c.id) // the run released its claim, then fired onIdle
    q.idle(c.id)
    await flush()
    expect(f.chats.send).toHaveBeenCalledTimes(1)
    expect(f.chats.send).toHaveBeenCalledWith(c.id, 'one', [att('f1')], 'r1', 'm1')
    expect(await taskIds(c.id)).toEqual(['m2'])
    expect(
      metaPushes()
        .at(-1)
        ?.meta.tasks?.map((t) => t.id)
    ).toEqual(['m2'])
  })

  it('one task per turn', async () => {
    const c = await single()
    running.add(c.id)
    await q.submit(c.id, 'one', [], undefined, 'm1')
    await q.submit(c.id, 'two', [], undefined, 'm2')
    running.delete(c.id)
    q.idle(c.id)
    await flush()
    q.idle(c.id) // while the dispatched task's turn runs
    await flush()
    expect(f.chats.send).toHaveBeenCalledTimes(1)
    turns[0].resolve()
    q.idle(c.id)
    await flush()
    expect(f.chats.send).toHaveBeenCalledTimes(2)
    expect(f.chats.send).toHaveBeenLastCalledWith(c.id, 'two', [], undefined, 'm2')
    expect(await taskIds(c.id)).toEqual([])
  })

  it('pumps again after a group dispatch settles', async () => {
    const g = await group()
    running.add(g.id)
    await q.submit(g.id, 'one', [], undefined, 'm1')
    await q.submit(g.id, 'two', [], undefined, 'm2')
    running.delete(g.id)
    q.idle(g.id)
    await flush()
    expect(f.groups.send).toHaveBeenCalledTimes(1)
    // The room claims, runs and ends before its send resolves: its idle comes while the dispatch is in progress.
    running.add(g.id)
    running.delete(g.id)
    q.idle(g.id)
    await flush()
    expect(f.groups.send).toHaveBeenCalledTimes(1)
    posts[0].resolve() // no idle after this
    await flush()
    expect(f.groups.send).toHaveBeenCalledTimes(2)
    expect(f.groups.send).toHaveBeenLastCalledWith(g.id, 'two', [], undefined, 'm2')
    expect(await taskIds(g.id)).toEqual([])
  })

  it('a group paused at the hop cap keeps its tasks queued', async () => {
    const g = await group()
    running.add(g.id)
    await q.submit(g.id, 'one', [], undefined, 'm1')
    await store.saveItems(g.id, [said('u1'), notice('paused')])
    running.delete(g.id)
    q.idle(g.id)
    await flush()
    await q.resume()
    expect(f.groups.send).not.toHaveBeenCalled()
    expect(await taskIds(g.id)).toEqual(['m1'])
    // A later run that ends another way (here Stop) sends the next task.
    await store.saveItems(g.id, [said('u1'), notice('paused'), said('u2'), notice('stopped')])
    q.idle(g.id)
    await flush()
    expect(f.groups.send).toHaveBeenCalledTimes(1)
    expect(f.groups.send).toHaveBeenCalledWith(g.id, 'one', [], undefined, 'm1')
    expect(await taskIds(g.id)).toEqual([])
  })

  it('a removed chat ends the pump quietly', async () => {
    const c = await single()
    running.add(c.id)
    await q.submit(c.id, 'one', [], undefined, 'm1')
    await store.remove(c.id)
    running.delete(c.id)
    expect(() => q.idle(c.id)).not.toThrow()
    await flush()
    await q.resume()
    expect(f.chats.send).not.toHaveBeenCalled()
    expect(errors).not.toHaveBeenCalled()
  })

  it('a failed dispatch moves on to the next task', async () => {
    const c = await single()
    running.add(c.id)
    await q.submit(c.id, 'one', [], undefined, 'm1')
    await q.submit(c.id, 'two', [], undefined, 'm2')
    running.delete(c.id)
    q.idle(c.id)
    await flush()
    turns[0].reject(new Error('Claude CLI not found'))
    await flush()
    expect(f.chats.send).toHaveBeenCalledTimes(2)
    expect(f.chats.send).toHaveBeenLastCalledWith(c.id, 'two', [], undefined, 'm2')
    expect(errors).toHaveBeenCalledTimes(1)
  })

  it('a failed meta push does not lose the task it took', async () => {
    const c = await single()
    running.add(c.id)
    await q.submit(c.id, 'one', [], undefined, 'm1')
    running.delete(c.id)
    pushFails = true
    q.idle(c.id)
    await flush()
    expect(f.chats.send).toHaveBeenCalledWith(c.id, 'one', [], undefined, 'm1')
    expect(await taskIds(c.id)).toEqual([])
    expect(errors).toHaveBeenCalledWith('pushing the queued messages failed:', expect.any(Error))
    turns[0].resolve()
  })
})

describe('TaskQueue.drop', () => {
  it('dropping a task removes it and its files', async () => {
    const c = await single()
    running.add(c.id)
    await q.submit(c.id, 'one', ['f1', 'f2'], undefined, 'm1')
    await q.submit(c.id, 'two', [], undefined, 'm2')
    const before = metaPushes().length
    await expect(q.drop(c.id, 'm1')).resolves.toBe(true)
    expect(await taskIds(c.id)).toEqual(['m2'])
    expect(f.files.removeFiles).toHaveBeenCalledWith(c.id, ['f1', 'f2'])
    expect(metaPushes()).toHaveLength(before + 1)
    expect(
      metaPushes()
        .at(-1)
        ?.meta.tasks?.map((t) => t.id)
    ).toEqual(['m2'])
  })

  it('a drop whose files fail to go still succeeds: the task is gone', async () => {
    const c = await single()
    running.add(c.id)
    await q.submit(c.id, 'one', ['f1'], undefined, 'm1')
    f.files.removeFiles.mockRejectedValueOnce(new Error('EACCES'))
    await expect(q.drop(c.id, 'm1')).resolves.toBe(true)
    expect(await taskIds(c.id)).toEqual([])
    expect(errors).toHaveBeenCalledTimes(1)
  })

  it('dropping a task already taken is a no-op', async () => {
    const c = await single()
    running.add(c.id)
    await q.submit(c.id, 'one', ['f1'], undefined, 'm1')
    running.delete(c.id)
    q.idle(c.id)
    await flush()
    expect(f.chats.send).toHaveBeenCalledTimes(1)
    const before = metaPushes().length
    await expect(q.drop(c.id, 'm1')).resolves.toBe(false)
    expect(f.files.removeFiles).not.toHaveBeenCalled()
    expect(metaPushes()).toHaveLength(before)
  })
})

describe('TaskQueue.resume', () => {
  it('resume pumps chats that hold tasks', async () => {
    const a = await single()
    await single()
    await store.addTask(a.id, { id: 't1', text: 'one', ts: 1 })
    await q.resume()
    expect(f.chats.send).toHaveBeenCalledTimes(1)
    expect(f.chats.send).toHaveBeenCalledWith(a.id, 'one', [], undefined, 't1')
  })
})

describe('TaskQueue.sendTask', () => {
  it('sends the chosen task, not the oldest, and leaves the others queued', async () => {
    const c = await single()
    running.add(c.id)
    await q.submit(c.id, 'one', [], undefined, 'm1')
    await q.submit(c.id, 'two', ['f1'], 'r1', 'm2')
    await q.submit(c.id, 'three', [], undefined, 'm3')
    running.delete(c.id) // idle with tasks held
    const before = metaPushes().length
    const sent = q.sendTask(c.id, 'm2')
    await flush()
    expect(f.chats.send).toHaveBeenCalledTimes(1)
    expect(f.chats.send).toHaveBeenCalledWith(c.id, 'two', [att('f1')], 'r1', 'm2')
    expect(await taskIds(c.id)).toEqual(['m1', 'm3'])
    expect(metaPushes()).toHaveLength(before + 1)
    expect(f.files.removeFiles).not.toHaveBeenCalled() // its files go with the sent message
    turns[0].resolve()
    await expect(sent).resolves.toBe('sent')
  })

  it('throws when the chat is busy', async () => {
    const c = await single()
    running.add(c.id)
    await q.submit(c.id, 'one', [], undefined, 'm1')
    await expect(q.sendTask(c.id, 'm1')).rejects.toThrow('Chat is busy')
    expect(await taskIds(c.id)).toEqual(['m1'])
    // A group dispatch still on its way counts as busy too.
    const g = await group()
    void q.submit(g.id, 'hi', [], undefined, 'g1')
    await flush()
    await store.addTask(g.id, { id: 't1', text: 'later', ts: 1 })
    await expect(q.sendTask(g.id, 't1')).rejects.toThrow('Chat is busy')
    expect(await taskIds(g.id)).toEqual(['t1'])
    expect(f.chats.send).not.toHaveBeenCalled()
    expect(f.groups.send).toHaveBeenCalledTimes(1)
    running.add(g.id)
    posts[0].resolve()
  })

  it('a failed meta push still sends the chosen task', async () => {
    const c = await single()
    running.add(c.id)
    await q.submit(c.id, 'one', [], undefined, 'm1')
    running.delete(c.id)
    pushFails = true
    const sent = q.sendTask(c.id, 'm1')
    await flush()
    expect(f.chats.send).toHaveBeenCalledWith(c.id, 'one', [], undefined, 'm1')
    turns[0].resolve()
    await expect(sent).resolves.toBe('sent')
    expect(errors).toHaveBeenCalledWith('pushing the queued messages failed:', expect.any(Error))
  })

  it('throws for an unknown task id', async () => {
    const c = await single()
    await expect(q.sendTask(c.id, 'nope')).rejects.toThrow('Queued message not found')
    expect(f.chats.send).not.toHaveBeenCalled()
  })
})

describe('TaskQueue.shutdown', () => {
  it('shutdown stops idle and pump from dispatching; tasks stay queued', async () => {
    const c = await single()
    await store.addTask(c.id, { id: 't1', text: 'one', ts: 1 })
    q.shutdown()
    q.idle(c.id)
    await q.resume()
    await flush()
    expect(f.chats.send).not.toHaveBeenCalled()
    expect((await store.get(c.id))!.tasks).toHaveLength(1)
  })

  it('submit rejects once shut down and sends nothing', async () => {
    const c = await single()
    q.shutdown()
    await expect(q.submit(c.id, 'late', [], undefined, 'm1')).rejects.toThrow('Server is shutting down')
    expect(f.chats.send).not.toHaveBeenCalled()
    expect((await store.get(c.id))!.tasks ?? []).toEqual([])
  })

  it('a submit already waiting on the lock rejects when shutdown comes first', async () => {
    const c = await single()
    const gate = deferred()
    const get = store.get.bind(store)
    let first = true
    vi.spyOn(store, 'get').mockImplementation(async (id: string) => {
      if (first) {
        first = false
        await gate.promise
      }
      return get(id)
    })
    const pending = q.submit(c.id, 'late', [], undefined, 'm1')
    const outcome = expect(pending).rejects.toThrow('Server is shutting down')
    await new Promise<void>((r) => setImmediate(r)) // not flush(): it would wait on the blocked read
    q.shutdown()
    gate.resolve()
    await outcome
    expect(f.chats.send).not.toHaveBeenCalled()
  })
})

const hold = async (id: string, ...tasks: string[]) => {
  for (const t of tasks) await store.addTask(id, { id: t, text: t, ts: 1 })
  await store.holdTasks(id)
}

describe('TaskQueue.rerun', () => {
  it('rerun on a running chat stops it, waits, then reruns: never two runs at once', async () => {
    const c = await single()
    await store.saveItems(c.id, [said('u1')])
    const first = q.submit(c.id, 'hi', [], undefined, 'm1')
    await flush()
    expect(running.has(c.id)).toBe(true)
    const redo = q.rerun(c.id, 'u1', 'edited')
    await flush()
    expect(f.chats.stop).toHaveBeenCalledWith(c.id)
    expect(f.chats.rerun).toHaveBeenCalledTimes(1) // the fake claim throws if the first run were still there
    expect(f.chats.rerun).toHaveBeenCalledWith(c.id, 'u1', 'edited')
    expect(f.chats.stop.mock.invocationCallOrder[0]).toBeLessThan(f.chats.rerun.mock.invocationCallOrder[0])
    await expect(first).resolves.toBe('sent')
    turns[1].resolve()
    await expect(redo).resolves.toBeUndefined()
    expect(f.chats.send).toHaveBeenCalledTimes(1)
  })

  it('rerun on an idle chat just runs, and Resend passes null', async () => {
    const c = await single()
    await store.saveItems(c.id, [said('u1')])
    const redo = q.rerun(c.id, 'u1', null)
    await flush()
    expect(f.chats.stop).not.toHaveBeenCalled()
    expect(f.chats.rerun).toHaveBeenCalledWith(c.id, 'u1', null)
    turns[0].resolve()
    await redo
  })

  it("rerun holds queued tasks: the stop's idle and the rerun's end start none", async () => {
    const c = await single()
    await store.saveItems(c.id, [said('u1')])
    const first = q.submit(c.id, 'hi', [], undefined, 'm1')
    await flush()
    await expect(q.submit(c.id, 'later', [], undefined, 'm2')).resolves.toBe('queued')
    const redo = q.rerun(c.id, 'u1', 'edited')
    await flush()
    await first
    expect(f.chats.send).toHaveBeenCalledTimes(1) // the stop released the chat, and no task went in
    expect(await taskIds(c.id)).toEqual(['m2'])
    expect((await store.get(c.id))?.held).toBe(true)
    expect(metaPushes().some((p) => p.meta.held === true)).toBe(true)
    turns[1].resolve()
    await redo
    q.idle(c.id)
    await flush()
    expect(f.chats.send).toHaveBeenCalledTimes(1)
    expect(await taskIds(c.id)).toEqual(['m2'])
  })

  it('rerun holds an unread steer too: handed back by the stop, the edited reply never sends it by itself', async () => {
    const c = await single()
    await store.saveItems(c.id, [said('u1')])
    const first = q.submit(c.id, 'hi', [], undefined, 'm1')
    await flush()
    await store.addSteer(c.id, { id: 's1', text: 'also use tabs', ts: 1 })
    const redo = q.rerun(c.id, 'u1', 'edited')
    await flush()
    await first
    expect((await store.get(c.id))?.held).toBe(true)
    await store.returnSteers(c.id, ['s1']) // what the stopped turn does with a steer it never read
    turns[1].resolve()
    await redo
    q.idle(c.id)
    await flush()
    expect(f.chats.send).toHaveBeenCalledTimes(1)
    expect(await taskIds(c.id)).toEqual(['s1'])
  })

  it('rerun in a room waits for the post in flight, stops the room, then reruns through GroupService', async () => {
    const g = await group()
    await store.saveItems(g.id, [said('u1')])
    const first = q.submit(g.id, 'hi', [], undefined, 'm1')
    await flush() // the post is on its way and the room has not claimed yet
    const redo = q.rerun(g.id, 'u1', 'edited')
    await flush()
    expect(f.groups.rerun).not.toHaveBeenCalled()
    void claim(g.id) // the room claims, then the post resolves
    posts[0].resolve()
    await flush()
    await first
    expect(f.chats.stop).toHaveBeenCalledWith(g.id)
    expect(f.groups.rerun).toHaveBeenCalledTimes(1)
    expect(f.groups.rerun).toHaveBeenCalledWith(g.id, 'u1', 'edited')
    expect(f.chats.rerun).not.toHaveBeenCalled()
    posts[1].resolve()
    await expect(redo).resolves.toBeUndefined()
  })

  it('an unknown message or an empty edit stops nothing', async () => {
    const c = await single()
    await store.saveItems(c.id, [said('u1')])
    void q.submit(c.id, 'hi', [], undefined, 'm1')
    await flush()
    await expect(q.rerun(c.id, 'nope', 'x')).rejects.toThrow('Message not found')
    await expect(q.rerun(c.id, 'u1', '  ')).rejects.toThrow('Message is empty')
    await expect(q.rerun('gone', 'u1', 'x')).rejects.toThrow('Chat not found: gone')
    expect(f.chats.stop).not.toHaveBeenCalled()
    expect(running.has(c.id)).toBe(true)
    expect((await store.get(c.id))?.held).toBeUndefined()
    turns[0].resolve()
  })

  it('a rerun after shutdown starts nothing', async () => {
    const c = await single()
    await store.saveItems(c.id, [said('u1')])
    q.shutdown()
    await expect(q.rerun(c.id, 'u1', null)).rejects.toThrow('Server is shutting down')
    expect(f.chats.rerun).not.toHaveBeenCalled()
  })

  it('a rerun that fails to start leaves the tasks of a stopped reply held', async () => {
    const c = await single()
    await store.saveItems(c.id, [said('u1')])
    const first = q.submit(c.id, 'hi', [], undefined, 'm1')
    await flush()
    await q.submit(c.id, 'wait', [], undefined, 't1')
    f.chats.rerun.mockRejectedValueOnce(new Error('Claude CLI not found'))
    await expect(q.rerun(c.id, 'u1', null)).rejects.toThrow('Claude CLI not found')
    await first
    await flush()
    expect(f.chats.send).toHaveBeenCalledTimes(1)
    expect(await taskIds(c.id)).toEqual(['t1'])
    expect((await store.get(c.id))?.held).toBe(true)
  })

  it('a stop that cannot finish still leaves the tasks held', async () => {
    const c = await single()
    await store.saveItems(c.id, [said('u1')])
    running.add(c.id) // a claim the fake stop cannot end
    await q.submit(c.id, 'wait', [], undefined, 't1')
    await expect(q.rerun(c.id, 'u1', null)).rejects.toThrow('Chat is busy')
    expect(f.chats.stop).toHaveBeenCalled()
    expect(f.chats.rerun).not.toHaveBeenCalled()
    expect((await store.get(c.id))?.held).toBe(true)
    expect(await taskIds(c.id)).toEqual(['t1'])
  })

  it('a rerun on an idle chat does not hold the tasks: they go on after it, as today', async () => {
    const c = await single()
    await store.saveItems(c.id, [said('u1')])
    await store.addTask(c.id, { id: 't1', text: 'wait', ts: 1 })
    const redo = q.rerun(c.id, 'u1', null)
    await flush()
    expect(f.chats.stop).not.toHaveBeenCalled()
    expect((await store.get(c.id))?.held).toBeUndefined()
    turns[0].resolve()
    await redo
    await flush()
    expect(f.chats.send).toHaveBeenCalledWith(c.id, 'wait', [], undefined, 't1')
  })
})

describe('held tasks', () => {
  it('a composer send while held and idle goes straight in; tasks stay held', async () => {
    const c = await single()
    await hold(c.id, 't1')
    const sent = q.submit(c.id, 'new', [], undefined, 'm1')
    await flush()
    expect(f.chats.send).toHaveBeenCalledTimes(1)
    expect(f.chats.send).toHaveBeenCalledWith(c.id, 'new', [], undefined, 'm1')
    turns[0].resolve()
    await expect(sent).resolves.toBe('sent')
    q.idle(c.id)
    await flush()
    expect(f.chats.send).toHaveBeenCalledTimes(1)
    expect(await taskIds(c.id)).toEqual(['t1'])
    expect((await store.get(c.id))?.held).toBe(true)
  })

  it('a message sent while a held chat runs queues behind the held tasks', async () => {
    const c = await single()
    await hold(c.id, 't1')
    void q.submit(c.id, 'new', [], undefined, 'm1')
    await flush()
    await expect(q.submit(c.id, 'newer', [], undefined, 'm2')).resolves.toBe('queued')
    turns[0].resolve()
    await flush()
    q.idle(c.id)
    await flush()
    expect(f.chats.send).toHaveBeenCalledTimes(1)
    expect(await taskIds(c.id)).toEqual(['t1', 'm2'])
  })

  it('sendTask sends a held task; dropping the last one clears held', async () => {
    const c = await single()
    await hold(c.id, 't1', 't2')
    const sent = q.sendTask(c.id, 't1')
    await flush()
    expect(f.chats.send).toHaveBeenCalledWith(c.id, 't1', [], undefined, 't1')
    turns[0].resolve()
    await expect(sent).resolves.toBe('sent')
    q.idle(c.id)
    await flush()
    expect(f.chats.send).toHaveBeenCalledTimes(1) // t2 is still held
    expect((await store.get(c.id))?.held).toBe(true)
    await expect(q.drop(c.id, 't2')).resolves.toBe(true)
    const meta = await store.get(c.id)
    expect(meta?.tasks).toBeUndefined()
    expect(meta?.held).toBeUndefined()
    expect(metaPushes().at(-1)?.meta.held).toBeUndefined()
  })

  it('idle does not start a held task', async () => {
    const c = await single()
    await hold(c.id, 't1')
    q.idle(c.id)
    await flush()
    expect(f.chats.send).not.toHaveBeenCalled()
  })

  it('resume at startup does not send held tasks', async () => {
    const held = await single()
    const open = await single()
    await hold(held.id, 't1')
    await store.addTask(open.id, { id: 't2', text: 'go', ts: 1 })
    await q.resume()
    await flush()
    expect(f.chats.send).toHaveBeenCalledTimes(1)
    expect(f.chats.send).toHaveBeenCalledWith(open.id, 'go', [], undefined, 't2')
    expect(await taskIds(held.id)).toEqual(['t1'])
  })
})

describe('TaskQueue.switchVersion', () => {
  it('switchVersion while busy throws Chat is busy', async () => {
    const c = await single()
    running.add(c.id)
    await expect(q.switchVersion(c.id, 'u1', 0)).rejects.toThrow('Chat is busy')
    // A room whose post is still on its way is busy too.
    const g = await group()
    void q.submit(g.id, 'hi', [], undefined, 'g1')
    await flush()
    await expect(q.switchVersion(g.id, 'u1', 0)).rejects.toThrow('Chat is busy')
    expect(f.chats.switchVersion).not.toHaveBeenCalled()
    running.add(g.id)
    posts[0].resolve()
  })

  it('switchVersion on an idle chat goes through ChatService', async () => {
    const c = await single()
    await q.switchVersion(c.id, 'u1', 2)
    expect(f.chats.switchVersion).toHaveBeenCalledWith(c.id, 'u1', 2)
  })

  it('a switch that leaves tasks on an idle chat holds them', async () => {
    const g = await group()
    await store.saveItems(g.id, [said('u1'), notice('paused')])
    await store.addTask(g.id, { id: 't1', text: 'wait', ts: 1 })
    // The switch moves the paused notice into a hidden version.
    f.chats.switchVersion.mockImplementationOnce(async () => {
      await store.saveItems(g.id, [said('u1')])
    })
    await q.switchVersion(g.id, 'u1', 0)
    expect((await store.get(g.id))?.held).toBe(true)
    expect(metaPushes().at(-1)?.meta.held).toBe(true)
    await q.resume()
    q.idle(g.id)
    await flush()
    expect(f.groups.send).not.toHaveBeenCalled()
    // A message of the user's own goes straight in; the task stays held.
    const sent = q.submit(g.id, 'new', [], undefined, 'm1')
    await flush()
    expect(f.groups.send).toHaveBeenCalledTimes(1)
    posts[0].resolve()
    await sent
    expect(await taskIds(g.id)).toEqual(['t1'])
  })

  it('a send during a switch waits for it, then goes in: nothing is stranded', async () => {
    const c = await single()
    const gate = deferred()
    f.chats.switchVersion.mockImplementationOnce(async () => {
      running.add(c.id)
      await gate.promise
      running.delete(c.id)
    })
    const switching = q.switchVersion(c.id, 'u1', 1)
    await flush()
    const sent = q.submit(c.id, 'hi', [], undefined, 'm1')
    await flush()
    expect(f.chats.send).not.toHaveBeenCalled()
    gate.resolve()
    await switching
    await flush()
    expect(f.chats.send).toHaveBeenCalledTimes(1)
    expect(await taskIds(c.id)).toEqual([])
    turns[0].resolve()
    await expect(sent).resolves.toBe('sent')
  })
})

describe('TaskQueue.compact', () => {
  it('compact while busy throws Chat is busy', async () => {
    const c = await single()
    running.add(c.id)
    await expect(q.compact(c.id, '')).rejects.toThrow('Chat is busy')
    expect(f.chats.compact).not.toHaveBeenCalled()
  })

  it("compact goes through ChatService, and a room's through GroupService with the member", async () => {
    const c = await single()
    const done = q.compact(c.id, 'keep it')
    await flush()
    expect(f.chats.compact).toHaveBeenCalledWith(c.id, 'keep it')
    turns[0].resolve()
    await done
    const g = await group()
    const roomDone = q.compact(g.id, '', 'wk')
    await flush()
    expect(f.groups.compact).toHaveBeenCalledWith(g.id, 'wk', '')
    turns[1].resolve()
    await roomDone
  })

  it('a room needs the member to compact', async () => {
    const g = await group()
    await expect(q.compact(g.id, '')).rejects.toThrow('Pick the member to compact')
  })

  it('a message sent while compacting queues, then goes in once it ends', async () => {
    const c = await single()
    const done = q.compact(c.id, '')
    await flush()
    expect(await q.submit(c.id, 'next', [], undefined, 'm1')).toBe('queued')
    expect(f.chats.send).not.toHaveBeenCalled()
    turns[0].resolve()
    await done
    await flush()
    expect(f.chats.send).toHaveBeenCalledWith(c.id, 'next', [], undefined, 'm1')
    turns[1].resolve()
  })
})

describe('pause and resume', () => {
  // As pause() and a landed pause leave it: held, even with an empty tray.
  const setPause = (id: string, pause: 'pausing' | 'paused') => store.update(id, { pause, held: true })
  const saved = { members: ['ui'], queue: [{ agent: 'wk', after: ['ui'] }] }
  const roomPaused = (id: string) => store.updateGroup(id, (x) => ({ ...x, paused: saved }))
  const meta = async (id: string) => (await store.get(id))!
  const routine = (id: string, text: string, staged: string[], messageId: string) =>
    q.submit(id, text, staged, undefined, messageId, undefined, undefined, 'routine')

  describe('pump', () => {
    it('starts no task while the chat is paused, after a restart too', async () => {
      const c = await single()
      await store.addTask(c.id, { id: 't1', text: 'wait', ts: 1 }) // not held: the pause alone keeps it
      await store.update(c.id, { pause: 'paused' })
      q.idle(c.id)
      await flush()
      await q.resume()
      await flush()
      expect(f.chats.send).not.toHaveBeenCalled()
      expect(await taskIds(c.id)).toEqual(['t1'])
    })

    it('starts no task while pausing; a reply that ended without landing the pause gets it landed', async () => {
      const c = await single()
      const first = q.submit(c.id, 'go', [], undefined, 'm1')
      await flush()
      await setPause(c.id, 'pausing')
      await q.submit(c.id, 'later', [], undefined, 'm2')
      q.idle(c.id) // still running: nothing
      await flush()
      expect(f.chats.finishPause).not.toHaveBeenCalled()
      turns[0].resolve()
      await first
      q.idle(c.id)
      await flush()
      expect(f.chats.finishPause).toHaveBeenCalledTimes(1)
      expect(f.chats.finishPause).toHaveBeenCalledWith(c.id)
      expect(f.chats.send).toHaveBeenCalledTimes(1)
      expect(await meta(c.id)).toMatchObject({ pause: 'paused', held: true, tasks: [{ id: 'm2' }] })
    })

    it('lands a room left pausing once it let go of the chat (a Pause after its end looked), and starts no task', async () => {
      const g = await group()
      await store.addTask(g.id, { id: 't1', text: 'wait', ts: 1 })
      await setPause(g.id, 'pausing')
      q.idle(g.id) // what the room's release does
      await flush()
      expect(f.chats.finishPause).toHaveBeenCalledTimes(1)
      expect(f.chats.finishPause).toHaveBeenCalledWith(g.id)
      expect(f.groups.send).not.toHaveBeenCalled()
      expect(await meta(g.id)).toMatchObject({ pause: 'paused', held: true, tasks: [{ id: 't1' }] })
    })

    it('a paused chat keeps its pause when its last task is dropped, and a later task is held again', async () => {
      const c = await single()
      await store.addTask(c.id, { id: 't1', text: 'wait', ts: 1 })
      await setPause(c.id, 'paused')
      await expect(q.drop(c.id, 't1')).resolves.toBe(true)
      expect((await meta(c.id)).held).toBeUndefined()
      expect((await meta(c.id)).pause).toBe('paused')
      await expect(routine(c.id, 'tick', [], 'r1')).resolves.toBe('queued')
      q.idle(c.id)
      await flush()
      expect(f.chats.send).not.toHaveBeenCalled()
      expect(await meta(c.id)).toMatchObject({ pause: 'paused', held: true, tasks: [{ id: 'r1' }] })
    })
  })

  describe('routine sends', () => {
    it("a routine's message into an idle paused chat queues and stays held", async () => {
      const c = await single()
      await setPause(c.id, 'paused')
      await expect(routine(c.id, 'tick', ['f1'], 'r1')).resolves.toBe('queued')
      await flush()
      expect(f.chats.send).not.toHaveBeenCalled()
      expect(await meta(c.id)).toMatchObject({ pause: 'paused', held: true, tasks: [{ id: 'r1', text: 'tick', attachments: [att('f1')] }] })
      expect(metaPushes().at(-1)?.meta).toMatchObject({ pause: 'paused', held: true, tasks: [{ id: 'r1' }] })
      q.idle(c.id)
      await q.resume()
      await flush()
      expect(f.chats.send).not.toHaveBeenCalled()
    })

    it("a routine's message into a paused room queues, and the room's saved turns stay", async () => {
      const g = await group()
      await setPause(g.id, 'paused')
      await roomPaused(g.id)
      await expect(routine(g.id, 'tick', [], 'r1')).resolves.toBe('queued')
      await flush()
      expect(f.groups.send).not.toHaveBeenCalled()
      expect(await meta(g.id)).toMatchObject({ pause: 'paused', held: true, tasks: [{ id: 'r1' }], group: { paused: saved } })
    })

    it("a routine's message into a pausing chat queues and is held", async () => {
      const c = await single()
      void q.submit(c.id, 'go', [], undefined, 'm1')
      await flush()
      await q.pause(c.id)
      await expect(routine(c.id, 'tick', [], 'r1')).resolves.toBe('queued')
      expect(await meta(c.id)).toMatchObject({ pause: 'pausing', held: true, tasks: [{ id: 'r1' }] })
      turns[0].resolve()
    })

    it("a routine's message into a chat with no pause sends as today, even past held tasks", async () => {
      const c = await single()
      await hold(c.id, 't1')
      const sent = routine(c.id, 'tick', [], 'r1')
      await flush()
      expect(f.chats.send).toHaveBeenCalledTimes(1)
      expect(f.chats.send).toHaveBeenCalledWith(c.id, 'tick', [], undefined, 'r1', undefined, undefined, true)
      turns[0].resolve()
      await expect(sent).resolves.toBe('sent')
      expect(await taskIds(c.id)).toEqual(['t1'])
    })

    it("a routine's message into an idle chat is sent auto: the user did not type it", async () => {
      const c = await single()
      const sent = routine(c.id, 'tick', [], 'r1')
      await flush()
      expect(f.chats.send.mock.calls[0].slice(5)).toEqual([undefined, undefined, true])
      turns[0].resolve()
      await sent
    })

    it("a routine's message queued while the chat runs keeps auto and is sent with it", async () => {
      const c = await single()
      const first = q.submit(c.id, 'go', [], undefined, 'm1')
      await flush()
      await expect(routine(c.id, 'tick', [], 'r1')).resolves.toBe('queued')
      expect((await store.get(c.id))?.tasks).toMatchObject([{ id: 'r1', auto: true }])
      turns[0].resolve()
      await first
      q.idle(c.id)
      await flush()
      expect(f.chats.send).toHaveBeenCalledTimes(2)
      expect(f.chats.send.mock.calls[1]).toEqual([c.id, 'tick', [], undefined, 'r1', undefined, undefined, true])
    })

    it("a routine's command and to-do flag keep their slots in front of auto", async () => {
      const c = await single()
      const cmd = { agent: 'alpha', name: 'check', prompt: 'p' }
      const sent = q.submit(c.id, '/check', [], undefined, 'r1', cmd, true, 'routine')
      await flush()
      expect(f.chats.send.mock.calls[0].slice(5)).toEqual([cmd, true, true])
      turns[0].resolve()
      await sent
    })

    it("a user's message is stored and sent with no auto at all", async () => {
      const c = await single()
      const first = q.submit(c.id, 'go', [], undefined, 'm1')
      await flush()
      await expect(q.submit(c.id, 'later', [], undefined, 'm2')).resolves.toBe('queued')
      expect((await store.get(c.id))?.tasks?.[0]).not.toHaveProperty('auto')
      turns[0].resolve()
      await first
      q.idle(c.id)
      await flush()
      expect(f.chats.send.mock.calls[0]).toEqual([c.id, 'go', [], undefined, 'm1'])
      expect(f.chats.send.mock.calls[1]).toEqual([c.id, 'later', [], undefined, 'm2'])
    })

    describe('cardAsk', () => {
      const ask = { todoId: 't1', title: 'Card', before: 'b', after: 'a' }

      it('goes to the chat service in the slot after the sender when the chat is idle', async () => {
        const c = await single()
        const p = q.submit(c.id, 'hi', [], undefined, 'm1', undefined, undefined, 'user', undefined, { cardAsk: ask })
        await flush()
        expect(f.chats.send.mock.calls[0]).toEqual([c.id, 'hi', [], undefined, 'm1', undefined, undefined, undefined, undefined, ask])
        turns[0].resolve()
        await p
      })

      it('is stored on the queued task and sent with it after the tray releases it', async () => {
        const c = await single()
        const first = q.submit(c.id, 'go', [], undefined, 'm1')
        await flush()
        await expect(
          q.submit(c.id, 'later', [], undefined, 'm2', undefined, undefined, 'user', undefined, { cardAsk: ask })
        ).resolves.toBe('queued')
        expect((await store.get(c.id))?.tasks).toMatchObject([{ id: 'm2', cardAsk: ask }])
        turns[0].resolve()
        await first
        q.idle(c.id)
        await flush()
        expect(f.chats.send.mock.calls[1]).toEqual([c.id, 'later', [], undefined, 'm2', undefined, undefined, undefined, undefined, ask])
      })

      it('a message without it stores and sends none', async () => {
        const c = await single()
        const first = q.submit(c.id, 'go', [], undefined, 'm1')
        await flush()
        await q.submit(c.id, 'later', [], undefined, 'm2')
        expect((await store.get(c.id))?.tasks?.[0]).not.toHaveProperty('cardAsk')
        turns[0].resolve()
        await first
      })
    })

    describe('run messages', () => {
      const run = { processId: 'p_0000000001' }
      const runSubmit = (id: string, text: string, messageId: string) =>
        q.submit(id, text, [], undefined, messageId, undefined, undefined, 'run', undefined, { run })

      it('run message launches with its mark and no auto', async () => {
        const c = await single()
        const p = runSubmit(c.id, 'result', 'm1')
        await flush()
        expect(f.chats.send.mock.calls[0]).toEqual([c.id, 'result', [], undefined, 'm1', undefined, undefined, undefined, undefined, undefined, run])
        turns[0].resolve()
        await p
      })

      it('run message queues while busy and keeps its mark', async () => {
        const c = await single()
        const first = q.submit(c.id, 'go', [], undefined, 'm1')
        await flush()
        await expect(runSubmit(c.id, 'result', 'm2')).resolves.toBe('queued')
        const task = (await store.get(c.id))?.tasks?.[0]
        expect(task).toMatchObject({ id: 'm2', run })
        expect(task).not.toHaveProperty('auto')
        turns[0].resolve()
        await first
        q.idle(c.id)
        await flush()
        expect(f.chats.send.mock.calls[1]).toEqual([c.id, 'result', [], undefined, 'm2', undefined, undefined, undefined, undefined, undefined, run])
      })

      it('run message waits in a paused chat', async () => {
        const c = await single()
        await setPause(c.id, 'paused')
        await expect(runSubmit(c.id, 'result', 'm1')).resolves.toBe('queued')
        await flush()
        expect(f.chats.send).not.toHaveBeenCalled()
        expect(await meta(c.id)).toMatchObject({ pause: 'paused', held: true, tasks: [{ id: 'm1', run }] })
      })

      it('a room gets the mark after auto', async () => {
        const g = await group()
        const p = runSubmit(g.id, '@ui result', 'm1')
        await flush()
        expect(f.groups.send.mock.calls[0]).toEqual([g.id, '@ui result', [], undefined, 'm1', undefined, undefined, undefined, undefined, run])
        posts[0].resolve()
        await p
      })

      it('routine and process stay auto', async () => {
        const c = await single()
        const first = q.submit(c.id, 'go', [], undefined, 'm1')
        await flush()
        await q.submit(c.id, 'tick', [], undefined, 'r1', undefined, undefined, 'routine')
        await q.submit(c.id, 'wake', [], undefined, 'r2', undefined, undefined, 'process')
        expect((await store.get(c.id))?.tasks).toMatchObject([
          { id: 'r1', auto: true },
          { id: 'r2', auto: true }
        ])
        turns[0].resolve()
        await first
      })
    })

    describe('workflowSent', () => {
      const sent = { workflowId: 'w1', runId: 'r1', stepId: 's1', name: 'WF', step: 'Chat' }

      it('goes to the chat service in the slot after auto when the chat is idle', async () => {
        const c = await single()
        const p = q.submit(c.id, 'hi', [], undefined, 'm1', undefined, undefined, 'routine', sent)
        await flush()
        expect(f.chats.send.mock.calls[0]).toEqual([c.id, 'hi', [], undefined, 'm1', undefined, undefined, true, sent])
        turns[0].resolve()
        await p
      })

      it('is stored on the queued task and sent with it after the tray releases it, Send now too', async () => {
        const c = await single()
        const first = q.submit(c.id, 'go', [], undefined, 'm1')
        await flush()
        await expect(q.submit(c.id, 'later', [], undefined, 'm2', undefined, undefined, 'routine', sent)).resolves.toBe('queued')
        await expect(q.submit(c.id, 'again', [], undefined, 'm3', undefined, undefined, 'routine', sent)).resolves.toBe('queued')
        expect((await store.get(c.id))?.tasks).toMatchObject([
          { id: 'm2', workflowSent: sent },
          { id: 'm3', workflowSent: sent }
        ])
        turns[0].resolve()
        await first
        q.idle(c.id)
        await flush()
        expect(f.chats.send.mock.calls[1]).toEqual([c.id, 'later', [], undefined, 'm2', undefined, undefined, true, sent])
        turns[1].resolve()
        await flush()
        await q.sendTask(c.id, 'm3').catch(() => {})
        await flush()
        const last = f.chats.send.mock.calls[f.chats.send.mock.calls.length - 1]
        expect(last).toEqual([c.id, 'again', [], undefined, 'm3', undefined, undefined, true, sent])
      })

      it('a message without it stores and sends none', async () => {
        const c = await single()
        const first = q.submit(c.id, 'go', [], undefined, 'm1')
        await flush()
        await q.submit(c.id, 'later', [], undefined, 'm2')
        expect((await store.get(c.id))?.tasks?.[0]).not.toHaveProperty('workflowSent')
        turns[0].resolve()
        await first
      })

      it("reaches a room's post after the to-do flag, then auto", async () => {
        const g = await group()
        const p = q.submit(g.id, 'hi', [], undefined, 'm1', undefined, undefined, 'routine', sent)
        await flush()
        expect(f.groups.send).toHaveBeenCalledWith(g.id, 'hi', [], undefined, 'm1', undefined, undefined, sent, true)
        posts[0].resolve()
        await p
      })
    })

    it("a routine's message into a room passes auto after the workflow slot", async () => {
      const g = await group()
      const sent = routine(g.id, 'tick', [], 'r1')
      await flush()
      expect(f.groups.send).toHaveBeenCalledWith(g.id, 'tick', [], undefined, 'r1', undefined, undefined, undefined, true)
      posts[0].resolve()
      await sent
    })

    it("a user's message into a room reaches the room with the same five arguments as before", async () => {
      const g = await group()
      const p = q.submit(g.id, 'hi', [], undefined, 'm1')
      await flush()
      expect(f.groups.send).toHaveBeenCalledWith(g.id, 'hi', [], undefined, 'm1')
      expect(f.groups.send.mock.calls[0]).toHaveLength(5)
      posts[0].resolve()
      await p
    })

    it("a routine's message into a paused chat holding 50 tasks is refused by the cap", async () => {
      const c = await single()
      for (let k = 0; k < TASKS_MAX; k++) await store.addTask(c.id, { id: `t${k}`, text: 'x', ts: 1 })
      await setPause(c.id, 'paused')
      await expect(routine(c.id, 'tick', ['f1'], 'r51')).rejects.toThrow('A chat can hold at most 50 queued messages')
      expect(f.files.commit).not.toHaveBeenCalled()
      expect(await taskIds(c.id)).toHaveLength(TASKS_MAX)
    })
  })

  describe('user sends', () => {
    it('a message into an idle paused chat goes straight in and ends the pause; older tasks stay held', async () => {
      const c = await single()
      await hold(c.id, 't1')
      await setPause(c.id, 'paused')
      const sent = q.submit(c.id, 'new', [], undefined, 'm1')
      await flush()
      expect(f.chats.send).toHaveBeenCalledTimes(1)
      expect(f.chats.send).toHaveBeenCalledWith(c.id, 'new', [], undefined, 'm1')
      const m = await meta(c.id)
      expect(m.pause).toBeUndefined()
      expect(m).toMatchObject({ held: true, tasks: [{ id: 't1' }] })
      // The tabs learn the pause is over before the service's own meta (which comes after an await).
      expect(metaPushes()).toHaveLength(1)
      expect(metaPushes()[0].meta).toMatchObject({ held: true })
      expect(metaPushes()[0].meta.pause).toBeUndefined()
      turns[0].resolve()
      await expect(sent).resolves.toBe('sent')
      q.idle(c.id)
      await flush()
      expect(f.chats.send).toHaveBeenCalledTimes(1)
      expect(await taskIds(c.id)).toEqual(['t1'])
    })

    it('with an empty tray the message ends held too, so messages sent during its reply go on after it', async () => {
      const c = await single()
      await setPause(c.id, 'paused')
      const sent = q.submit(c.id, 'new', [], undefined, 'm1')
      await flush()
      const m = await meta(c.id)
      expect(m.pause).toBeUndefined()
      expect(m.held).toBeUndefined()
      await expect(q.submit(c.id, 'next', [], undefined, 'm2')).resolves.toBe('queued')
      turns[0].resolve()
      await sent
      q.idle(c.id)
      await flush()
      expect(f.chats.send).toHaveBeenLastCalledWith(c.id, 'next', [], undefined, 'm2')
      turns[1].resolve()
    })

    it('in a paused room the message also drops the saved turns: the user took over', async () => {
      const g = await group()
      await hold(g.id, 't1')
      await setPause(g.id, 'paused')
      await roomPaused(g.id)
      const sent = q.submit(g.id, 'new', [], undefined, 'm1')
      await flush()
      expect(f.groups.send).toHaveBeenCalledWith(g.id, 'new', [], undefined, 'm1')
      expect(f.groups.resume).not.toHaveBeenCalled()
      const m = await meta(g.id)
      expect(m.pause).toBeUndefined()
      expect(m.group?.paused).toBeUndefined()
      expect(m).toMatchObject({ held: true, tasks: [{ id: 't1' }] })
      running.add(g.id)
      posts[0].resolve()
      await expect(sent).resolves.toBe('sent')
    })

    it('a message into a pausing chat queues and is held, also after the tray was emptied', async () => {
      const c = await single()
      const first = q.submit(c.id, 'go', [], undefined, 'm1')
      await flush()
      await q.pause(c.id)
      await expect(q.submit(c.id, 'later', [], undefined, 'm2')).resolves.toBe('queued')
      expect(await meta(c.id)).toMatchObject({ pause: 'pausing', held: true, tasks: [{ id: 'm2' }] })
      await q.drop(c.id, 'm2') // the last task out clears held
      await expect(q.submit(c.id, 'again', [], undefined, 'm3')).resolves.toBe('queued')
      expect(await meta(c.id)).toMatchObject({ pause: 'pausing', held: true, tasks: [{ id: 'm3' }] })
      turns[0].resolve()
      await first
      q.idle(c.id)
      await flush()
      expect(f.chats.send).toHaveBeenCalledTimes(1)
      expect(await meta(c.id)).toMatchObject({ pause: 'paused', held: true, tasks: [{ id: 'm3' }] })
    })

    it("Send now on a paused chat's task sends it as the user's own message: the pause ends, the others stay held", async () => {
      const g = await group()
      await hold(g.id, 't1', 't2')
      await setPause(g.id, 'paused')
      await roomPaused(g.id)
      const sent = q.sendTask(g.id, 't2')
      await flush()
      expect(f.groups.send).toHaveBeenCalledWith(g.id, 't2', [], undefined, 't2')
      const m = await meta(g.id)
      expect(m.pause).toBeUndefined()
      expect(m.group?.paused).toBeUndefined()
      expect(m).toMatchObject({ held: true, tasks: [{ id: 't1' }] })
      expect(metaPushes().at(-1)?.meta.pause).toBeUndefined()
      running.add(g.id)
      posts[0].resolve()
      await expect(sent).resolves.toBe('sent')
    })

    it('a compaction of a paused chat keeps it paused, and a message sent meanwhile waits held', async () => {
      const c = await single()
      await setPause(c.id, 'paused')
      const done = q.compact(c.id, '')
      await flush()
      await expect(q.submit(c.id, 'next', [], undefined, 'm1')).resolves.toBe('queued')
      turns[0].resolve()
      await done
      q.idle(c.id)
      await flush()
      expect(f.chats.send).not.toHaveBeenCalled()
      expect(await meta(c.id)).toMatchObject({ pause: 'paused', held: true, tasks: [{ id: 'm1' }] })
    })
  })

  describe('pause()', () => {
    it('refuses an idle chat and writes nothing', async () => {
      const c = await single()
      await expect(q.pause(c.id)).rejects.toThrow('Chat is not running')
      expect(f.chats.setPauseFlag).not.toHaveBeenCalled()
      expect((await meta(c.id)).pause).toBeUndefined()
      expect(metaPushes()).toHaveLength(0)
    })

    it('refuses with a clear message when the build has no pause hook, and writes nothing', async () => {
      const c = await single()
      void q.submit(c.id, 'go', [], undefined, 'm1')
      await flush()
      f.chats.canPause.mockResolvedValue(false)
      await expect(q.pause(c.id)).rejects.toThrow(PAUSE_UNAVAILABLE)
      // Asked about this chat: its engine decides which hook it needs.
      expect(f.chats.canPause).toHaveBeenCalledWith(c.id)
      expect(PAUSE_UNAVAILABLE).toBe('Pause is unavailable: the pause hook is missing from this build')
      expect(f.chats.setPauseFlag).not.toHaveBeenCalled()
      expect((await meta(c.id)).pause).toBeUndefined()
      expect((await meta(c.id)).held).toBeUndefined()
      expect(metaPushes()).toHaveLength(0)
      turns[0].resolve()
    })

    it('a running chat: pausing is stored before the flag, the tray is held even when empty, and the tabs hear of it', async () => {
      const c = await single()
      void q.submit(c.id, 'go', [], undefined, 'm1')
      await flush()
      let atFlag: ChatMeta | null = null
      f.chats.setPauseFlag.mockImplementationOnce(async (id: string) => {
        atFlag = await store.get(id)
      })
      await q.pause(c.id)
      expect(f.chats.setPauseFlag).toHaveBeenCalledWith(c.id, true)
      expect(atFlag).toMatchObject({ pause: 'pausing', held: true })
      expect(await meta(c.id)).toMatchObject({ pause: 'pausing', held: true })
      expect(metaPushes().at(-1)?.meta).toMatchObject({ pause: 'pausing', held: true })
      expect(f.groups.requestPause).not.toHaveBeenCalled()
      expect(f.chats.stop).not.toHaveBeenCalled()
      turns[0].resolve()
    })

    it('a room is told after the flag, and its false (a room still opening) is fine', async () => {
      const g = await group()
      void q.submit(g.id, 'go', [], undefined, 'm1')
      await flush() // the post is on its way and the room has not claimed yet
      f.groups.requestPause.mockReturnValueOnce(false)
      await q.pause(g.id)
      expect(f.groups.requestPause).toHaveBeenCalledWith(g.id)
      expect(f.chats.setPauseFlag.mock.invocationCallOrder[0]).toBeLessThan(f.groups.requestPause.mock.invocationCallOrder[0])
      expect(await meta(g.id)).toMatchObject({ pause: 'pausing', held: true })
      running.add(g.id)
      posts[0].resolve()
    })

    it('pushes the meta read fresh: a room that landed the pause meanwhile is never shown pausing again', async () => {
      const g = await group()
      running.add(g.id)
      f.groups.requestPause.mockImplementationOnce((id: string) => {
        void store.patchInPlace(id, () => ({ pause: 'paused' as const }))
        return true
      })
      await q.pause(g.id)
      expect(metaPushes().map((p) => p.meta.pause)).toEqual(['paused'])
    })

    it("refuses while compacting: one it started, the chat's own, or a room member's", async () => {
      const c = await single()
      const compacting = q.compact(c.id, '')
      await flush() // before the service stores `compacting`
      await expect(q.pause(c.id)).rejects.toThrow('Chat is compacting')
      turns[0].resolve()
      await compacting
      void q.submit(c.id, 'go', [], undefined, 'm1')
      await flush()
      await store.update(c.id, { compacting: true }) // the CLI compacting by itself mid-reply
      await expect(q.pause(c.id)).rejects.toThrow('Chat is compacting')
      turns[1].resolve()
      const g = await group()
      running.add(g.id)
      await store.updateGroup(g.id, (x) => ({ ...x, active: [{ agent: 'ui', turn: 't', since: 1, compacting: true }] }))
      await expect(q.pause(g.id)).rejects.toThrow('Chat is compacting')
      expect(f.chats.setPauseFlag).not.toHaveBeenCalled()
      expect((await meta(c.id)).pause).toBeUndefined()
      expect((await meta(g.id)).pause).toBeUndefined()
    })

    it('a flag that cannot be written leaves the chat pausing (it lands when the reply ends), logging only the code', async () => {
      const c = await single()
      void q.submit(c.id, 'go', [], undefined, 'm1')
      await flush()
      f.chats.setPauseFlag.mockRejectedValueOnce(
        Object.assign(new Error('ENOSPC: no space left, open /data/claude-tmp/x'), { code: 'ENOSPC' })
      )
      await q.pause(c.id)
      expect(await meta(c.id)).toMatchObject({ pause: 'pausing', held: true })
      expect(metaPushes().at(-1)?.meta.pause).toBe('pausing')
      expect(errors).toHaveBeenCalledWith('writing the pause flag failed:', 'ENOSPC')
      turns[0].resolve()
    })

    it('refuses a chat already pausing', async () => {
      const c = await single()
      void q.submit(c.id, 'go', [], undefined, 'm1')
      await flush()
      await q.pause(c.id)
      await expect(q.pause(c.id)).rejects.toThrow('Chat is already paused')
      expect(f.chats.setPauseFlag).toHaveBeenCalledTimes(1)
      turns[0].resolve()
    })

    it('a reply that ends while Pause is pressed still ends paused, and starts no task', async () => {
      const c = await single()
      const first = q.submit(c.id, 'go', [], undefined, 'm1')
      await flush()
      await q.submit(c.id, 'later', [], undefined, 'm2')
      // The reply ends between pause()'s busy check and its write, so its own end found no pause to land.
      const get = store.get.bind(store)
      vi.spyOn(store, 'get').mockImplementationOnce(async (id: string) => {
        turns[0].resolve()
        await first
        q.idle(c.id) // what the release does; the pump waits for pause() to let go of the lock
        return get(id)
      })
      await q.pause(c.id)
      await flush()
      expect(f.chats.finishPause).toHaveBeenCalledTimes(1)
      expect(f.chats.send).toHaveBeenCalledTimes(1)
      expect(await meta(c.id)).toMatchObject({ pause: 'paused', held: true, tasks: [{ id: 'm2' }] })
    })
  })

  describe('resumePaused()', () => {
    it('refuses a chat that is not paused, and a busy one', async () => {
      const c = await single()
      await expect(q.resumePaused(c.id)).rejects.toThrow('Chat is not paused')
      void q.submit(c.id, 'go', [], undefined, 'm1')
      await flush()
      await q.pause(c.id)
      await expect(q.resumePaused(c.id)).rejects.toThrow('Chat is busy')
      expect(f.chats.send).toHaveBeenCalledTimes(1)
      expect((await meta(c.id)).pause).toBe('pausing')
      turns[0].resolve()
    })

    it('a paused chat: pause and held go in one write, Continue goes before any task, and resolves when its reply ends', async () => {
      const c = await single()
      await hold(c.id, 't1', 't2')
      await setPause(c.id, 'paused')
      const patch = vi.spyOn(store, 'patchInPlace'),
        update = vi.spyOn(store, 'update'),
        held = vi.spyOn(store, 'holdTasks')
      let ended = false
      const done = q.resumePaused(c.id).then(() => {
        ended = true
      })
      await flush()
      expect(f.chats.send).toHaveBeenCalledTimes(1)
      expect(f.chats.send).toHaveBeenCalledWith(c.id, RESUME_TEXT, [], undefined, expect.stringMatching(/^id-/))
      expect(patch).toHaveBeenCalledTimes(1)
      expect(update).not.toHaveBeenCalled()
      expect(held).not.toHaveBeenCalled()
      const m = await meta(c.id)
      expect(m.pause).toBeUndefined()
      expect(m.held).toBeUndefined()
      expect(m.tasks?.map((t) => t.id)).toEqual(['t1', 't2'])
      expect(metaPushes()).toHaveLength(1)
      expect(metaPushes()[0].meta.pause).toBeUndefined()
      expect(metaPushes()[0].meta.held).toBeUndefined()
      expect(ended).toBe(false)
      turns[0].resolve()
      await done
      q.idle(c.id)
      await flush()
      expect(f.chats.send).toHaveBeenCalledTimes(2)
      expect(f.chats.send).toHaveBeenLastCalledWith(c.id, 't1', [], undefined, 't1')
      turns[1].resolve()
    })

    it('a paused room: GroupService resumes it, its saved turns are left for it, and sends meanwhile queue behind', async () => {
      const g = await group()
      await hold(g.id, 't1')
      await setPause(g.id, 'paused')
      await roomPaused(g.id)
      const done = q.resumePaused(g.id)
      await flush()
      expect(f.groups.resume).toHaveBeenCalledWith(g.id, expect.stringMatching(/^id-/))
      const m = await meta(g.id)
      expect(m.pause).toBeUndefined()
      expect(m.held).toBeUndefined()
      expect(m.group?.paused).toEqual(saved)
      await expect(q.submit(g.id, 'x', [], undefined, 'm1')).resolves.toBe('queued')
      expect(f.groups.send).not.toHaveBeenCalled()
      running.add(g.id) // the room claims, then Resume's message is posted
      posts[0].resolve()
      await done
      await flush()
      expect(f.groups.send).not.toHaveBeenCalled()
      running.delete(g.id)
      q.idle(g.id)
      await flush()
      expect(f.groups.send).toHaveBeenCalledWith(g.id, 't1', [], undefined, 't1')
      expect(f.groups.resume.mock.invocationCallOrder[0]).toBeLessThan(f.groups.send.mock.invocationCallOrder[0])
      posts[1].resolve()
    })

    it('two Resumes at once: Continue goes once and the second is refused', async () => {
      const c = await single()
      await setPause(c.id, 'paused')
      const a = q.resumePaused(c.id)
      await expect(q.resumePaused(c.id)).rejects.toThrow('Chat is busy')
      expect(f.chats.send).toHaveBeenCalledTimes(1)
      turns[0].resolve()
      await a
    })

    it('Resume after a message the user typed into the paused chat is refused: the user took over', async () => {
      const c = await single()
      await setPause(c.id, 'paused')
      const sent = q.submit(c.id, 'new', [], undefined, 'm1')
      await expect(q.resumePaused(c.id)).rejects.toThrow('Chat is busy')
      turns[0].resolve()
      await sent
      await expect(q.resumePaused(c.id)).rejects.toThrow('Chat is not paused')
      expect(f.chats.send).toHaveBeenCalledTimes(1)
    })
  })

  describe('edits end the pause', () => {
    it('an edit of an idle paused chat ends the pause; the held tasks stay held', async () => {
      const c = await single()
      await store.saveItems(c.id, [said('u1'), notice('userPaused')])
      await hold(c.id, 't1')
      await setPause(c.id, 'paused')
      const redo = q.rerun(c.id, 'u1', 'edited')
      await flush()
      expect(f.chats.rerun).toHaveBeenCalledWith(c.id, 'u1', 'edited')
      const m = await meta(c.id)
      expect(m.pause).toBeUndefined()
      expect(m).toMatchObject({ held: true, tasks: [{ id: 't1' }] })
      expect(metaPushes().at(-1)?.meta.pause).toBeUndefined()
      turns[0].resolve()
      await redo
      q.idle(c.id)
      await flush()
      expect(f.chats.send).not.toHaveBeenCalled()
    })

    it('a Resend in a paused room ends the pause and drops the saved turns', async () => {
      const g = await group()
      await store.saveItems(g.id, [said('u1')])
      await setPause(g.id, 'paused')
      await roomPaused(g.id)
      const redo = q.rerun(g.id, 'u1', null)
      await flush()
      expect(f.groups.rerun).toHaveBeenCalledWith(g.id, 'u1', null)
      const m = await meta(g.id)
      expect(m.pause).toBeUndefined()
      expect(m.held).toBeUndefined() // nothing waits
      expect(m.group?.paused).toBeUndefined()
      posts[0].resolve()
      await redo
    })

    it('an edit while pausing stops the reply, and the new version runs unpaused with the tasks held', async () => {
      const c = await single()
      await store.saveItems(c.id, [said('u1')])
      const first = q.submit(c.id, 'go', [], undefined, 'm1')
      await flush()
      await q.pause(c.id)
      await q.submit(c.id, 'later', [], undefined, 'm2')
      const redo = q.rerun(c.id, 'u1', 'edited')
      await flush()
      await first
      expect(f.chats.stop).toHaveBeenCalledWith(c.id)
      expect(f.chats.rerun).toHaveBeenCalledTimes(1)
      const m = await meta(c.id)
      expect(m.pause).toBeUndefined()
      expect(m).toMatchObject({ held: true, tasks: [{ id: 'm2' }] })
      turns[1].resolve()
      await redo
      q.idle(c.id)
      await flush()
      expect(f.chats.send).toHaveBeenCalledTimes(1)
    })

    it('a version switch ends the pause: queued tasks stay held, an empty tray is not, and a room drops its saved turns', async () => {
      const c = await single()
      await hold(c.id, 't1')
      await setPause(c.id, 'paused')
      await q.switchVersion(c.id, 'u1', 0)
      expect(f.chats.switchVersion).toHaveBeenCalledWith(c.id, 'u1', 0)
      expect((await meta(c.id)).pause).toBeUndefined()
      expect((await meta(c.id)).held).toBe(true)
      expect(metaPushes().at(-1)?.meta.pause).toBeUndefined()
      const g = await group()
      await setPause(g.id, 'paused')
      await roomPaused(g.id)
      await q.switchVersion(g.id, 'u1', 1)
      const m = await meta(g.id)
      expect(m.pause).toBeUndefined()
      expect(m.held).toBeUndefined()
      expect(m.group?.paused).toBeUndefined()
    })

    it('a version switch that fails keeps the pause', async () => {
      const c = await single()
      await setPause(c.id, 'paused')
      f.chats.switchVersion.mockRejectedValueOnce(new Error('Message not found'))
      await expect(q.switchVersion(c.id, 'u1', 0)).rejects.toThrow('Message not found')
      expect((await meta(c.id)).pause).toBe('paused')
    })
  })
})

describe('TaskQueue with a real ChatService', () => {
  const okResult: RunEvent = {
    kind: 'result',
    subtype: 'success',
    isError: false,
    numTurns: 1,
    sessionId: 's1',
    denials: [],
    windows: {},
    uuid: null,
    cost: null
  }
  const pong: RunEvent[] = [{ kind: 'init', sessionId: 's1' }, { kind: 'assistantText', text: 'pong' }, okResult]

  interface Script {
    events: RunEvent[]
    hang?: boolean
  }
  let scripts: Script[]
  let svc: ChatService
  let real: TaskQueue
  let k: number

  beforeEach(() => {
    scripts = []
    k = 0
    svc = new ChatService({
      store,
      files: new AttachmentStore(join(dir, 'attachments'), () => 'unused'),
      locate: async () => '/bin/claude',
      run: (o: RunOptions) => {
        const s = scripts.shift() ?? { events: pong }
        let release: (r: RunOutcome) => void = () => {}
        const outcome = (x: Partial<RunOutcome> = {}): RunOutcome => ({
          exitCode: 0,
          signal: null,
          stderr: '',
          spawnError: null,
          result: okResult as RunOutcome['result'],
          stopped: false,
          ...x
        })
        const done = new Promise<RunOutcome>((resolve) => {
          release = resolve
          setImmediate(() => {
            s.events.forEach((e) => o.onEvent(e))
            if (!s.hang) resolve(outcome())
          })
        })
        return {
          stop: () => release(outcome({ exitCode: null, signal: 'SIGINT', result: null, stopped: true })),
          send: () => true,
          done
        } as RunHandle
      },
      push: () => {},
      now: () => 1000 + ++k,
      newId: () => `x${++k}`,
      permissionMode: 'manual',
      disallowedToolsFor: () => [],
      onIdle: (id) => real.idle(id)
    })
    real = new TaskQueue({
      store,
      chats: svc,
      groups: f.groups,
      files: f.files,
      push: () => {},
      now: () => 5000,
      newId: () => `id-${++k}`
    })
  })

  it('a pending approval card ends unanswered and stays in the hidden version', async () => {
    const c = await store.create('helper', dir)
    scripts.push({
      hang: true,
      events: [
        { kind: 'toolUse', id: 't1', name: 'Bash', input: { command: 'ls' } },
        {
          kind: 'permissionRequest',
          requestId: 'r1',
          toolName: 'Bash',
          input: { command: 'ls' },
          description: 'd',
          reason: 'r',
          toolUseId: 't1'
        }
      ]
    })
    const first = real.submit(c.id, 'go', [])
    // Waited for, not slept on: the submit writes to disk first, which takes longer on Windows.
    await vi.waitFor(() => expect(svc.pendingCount(c.id)).toBe(1))
    const userId = (await store.loadItems(c.id))[0].id
    await real.rerun(c.id, userId, 'go, edited')
    await first
    const shown = await store.loadItems(c.id)
    expect(shown.some((i) => i.type === 'approval' || i.type === 'tool')).toBe(false) // the new version starts clean
    expect(shown[0]).toMatchObject({ type: 'user', text: 'go, edited', versions: { index: 1, count: 2 } })
    const tail = (await store.loadVersions(c.id))[userId].list[0]!.tail
    expect(tail.filter((i) => i.type === 'approval')).toMatchObject([{ id: 'r1', status: 'unanswered' }])
    expect(svc.pendingCount(c.id)).toBe(0)
  })

  it('two quick reruns: the second stops the first and makes version 3', async () => {
    const c = await store.create('helper', dir)
    await real.submit(c.id, 'one', [])
    const userId = (await store.loadItems(c.id))[0].id
    scripts.push({ hang: true, events: [{ kind: 'init', sessionId: 's2' }] })
    const first = real.rerun(c.id, userId, 'two')
    await vi.waitFor(() => expect(svc.isRunning(c.id)).toBe(true))
    const shownId = (await store.loadItems(c.id))[0].id // what the client shows after the first click
    scripts.push({ events: pong })
    const second = real.rerun(c.id, shownId, null) // a second click: waits on the lock, stops the first
    await Promise.all([first, second]) // a second claim over the first would reject: "Chat is already running"
    const shown = await store.loadItems(c.id)
    expect(shown[0]).toMatchObject({ type: 'user', text: 'two', versions: { index: 2, count: 3 } })
    expect(shown.map((i) => i.type)).toEqual(['user', 'assistant'])
    expect(svc.isRunning(c.id)).toBe(false)
  })
})

describe('TaskQueue onNewTurn (a usage limit wait ends)', () => {
  let calls: string[]
  const withHook = (hook: (chatId: string) => Promise<void>) =>
    new TaskQueue({
      store: tracked(store),
      chats: f.chats,
      groups: f.groups,
      files: f.files,
      push: (p) => {
        pushes.push(p)
      },
      now: () => 5000,
      newId: () => `id-${++n}`,
      onNewTurn: hook
    })
  beforeEach(() => {
    calls = []
    q = withHook(async (chatId) => {
      calls.push(`new:${chatId}:${f.chats.send.mock.calls.length}`)
    })
  })

  it('runs before a send starts, and for a message that queues', async () => {
    const c = await single()
    const sent = q.submit(c.id, 'hi', [], undefined, 'm1')
    await flush()
    expect(calls).toEqual([`new:${c.id}:0`])
    turns[0]!.resolve()
    await sent
    running.add(c.id)
    await q.submit(c.id, 'later', [])
    expect(calls).toHaveLength(2)
  })

  it('runs for an edit and a version switch, never for a compact', async () => {
    const c = await single()
    await store.saveItems(c.id, [said('u1')])
    const redo = q.rerun(c.id, 'u1', 'edited')
    await flush()
    turns[0]!.resolve()
    await redo
    await q.switchVersion(c.id, 'u1', 0)
    const compacting = q.compact(c.id, '')
    await flush()
    turns[1]!.resolve()
    await compacting
    expect(calls.map((x) => x.split(':')[0])).toEqual(['new', 'new'])
  })

  it("runs for Resume's Continue and for a routine's message held in a paused chat", async () => {
    const c = await single()
    await store.update(c.id, { pause: 'paused', held: true })
    await expect(q.submit(c.id, 'tick', [], undefined, 'r1', undefined, undefined, 'routine')).resolves.toBe('queued')
    expect(calls).toEqual([`new:${c.id}:0`])
    const resumed = q.resumePaused(c.id)
    await flush()
    expect(calls).toEqual([`new:${c.id}:0`, `new:${c.id}:0`]) // before Continue was sent
    expect(f.chats.send).toHaveBeenCalledWith(c.id, RESUME_TEXT, [], undefined, expect.stringMatching(/^id-/))
    turns[0]!.resolve()
    await resumed
  })

  it("holds a process wake-up in a paused chat as it does a routine's: queued, auto, and the pause stays", async () => {
    const c = await single()
    await store.update(c.id, { pause: 'paused', held: true })
    await expect(q.submit(c.id, 'Background process update', [], undefined, 'w1', undefined, undefined, 'process')).resolves.toBe('queued')
    const meta = await store.get(c.id)
    expect(meta?.pause).toBe('paused')
    expect(meta?.tasks?.find((x) => x.id === 'w1')).toMatchObject({ text: 'Background process update', auto: true })
    expect(f.chats.send).not.toHaveBeenCalled()
  })

  it('a hook that fails never fails the send', async () => {
    q = withHook(async () => {
      throw new Error('disk full')
    })
    const c = await single()
    const sent = q.submit(c.id, 'hi', [])
    await flush()
    turns[0]!.resolve()
    await expect(sent).resolves.toBe('sent')
  })
})

describe('TaskQueue onResume (a routine run follows the Continue)', () => {
  let calls: string[]
  const setPause = (id: string, pause: 'paused') => store.update(id, { pause, held: true })
  const roomPaused = (id: string) => store.updateGroup(id, (x) => ({ ...x, paused: { members: ['ui'], queue: [] } }))
  beforeEach(() => {
    calls = []
    q = new TaskQueue({
      store: tracked(store),
      chats: f.chats,
      groups: f.groups,
      files: f.files,
      push: (p) => {
        pushes.push(p)
      },
      now: () => 5000,
      newId: () => `id-${++n}`,
      onResume: (chatId, messageId) => {
        calls.push(`${chatId}:${messageId}:${f.chats.send.mock.calls.length + f.groups.resume.mock.calls.length}`)
      }
    })
  })

  it("names Continue's message id before it is sent, and sends it under that id", async () => {
    const c = await single()
    await setPause(c.id, 'paused')
    const resumed = q.resumePaused(c.id)
    await flush()
    const id = f.chats.send.mock.calls[0]![4] as string
    expect(f.chats.send).toHaveBeenCalledWith(c.id, RESUME_TEXT, [], undefined, id)
    expect(calls).toEqual([`${c.id}:${id}:0`])
    turns[0]!.resolve()
    await resumed
  })

  it("does the same for a room's Resume", async () => {
    const g = await group()
    await setPause(g.id, 'paused')
    await roomPaused(g.id)
    const resumed = q.resumePaused(g.id)
    await flush()
    const id = f.groups.resume.mock.calls[0]![1] as string
    expect(calls).toEqual([`${g.id}:${id}:0`])
    posts[0]!.resolve()
    await resumed
  })

  it('is not called for a refused Resume, and a hook that throws never stops the Continue', async () => {
    const c = await single()
    await expect(q.resumePaused(c.id)).rejects.toThrow('Chat is not paused')
    expect(calls).toEqual([])
    q = new TaskQueue({
      store: tracked(store),
      chats: f.chats,
      groups: f.groups,
      files: f.files,
      push: (p) => {
        pushes.push(p)
      },
      now: () => 5000,
      newId: () => `id-${++n}`,
      onResume: () => {
        throw new Error('boom')
      }
    })
    await setPause(c.id, 'paused')
    const resumed = q.resumePaused(c.id)
    await flush()
    expect(f.chats.send).toHaveBeenCalledTimes(1)
    turns[0]!.resolve()
    await resumed
  })
})

describe('a usage limit wait holds the tasks', () => {
  let calls: string[]
  let checked: Deferred | null // the limit check the idle started, still running when set
  const wait = { at: 9000, after: 'u1', waits: 1 }
  const setWait = (id: string) => store.patchInPlace(id, () => ({ resume: wait }))
  beforeEach(() => {
    calls = []
    checked = null
    q = new TaskQueue({
      store: tracked(store),
      chats: f.chats,
      groups: f.groups,
      files: f.files,
      push: (p) => {
        pushes.push(p)
      },
      now: () => 5000,
      newId: () => `id-${++n}`,
      // As LimitResumes.cancel: the wait ends.
      onNewTurn: async (id) => {
        calls.push(`new:${id}`)
        await track(store.patchInPlace(id, (cur) => (cur.resume ? { resume: undefined } : null)))
      },
      limitChecked: async (id) => {
        calls.push(`checked:${id}`)
        await checked?.promise
      }
    })
  })
  const queued = async (id: string, ...ids: string[]) => {
    running.add(id)
    for (const m of ids) await q.submit(id, m, [], undefined, m)
    running.delete(id)
    calls = []
  }

  it('idle sends no task while a wait is stored', async () => {
    const c = await single()
    await queued(c.id, 'm1', 'm2')
    await setWait(c.id)
    q.idle(c.id)
    await flush()
    expect(f.chats.send).not.toHaveBeenCalled()
    expect(await taskIds(c.id)).toEqual(['m1', 'm2'])
    // A restart's resume() leaves them too: the stored wait's continue goes first.
    await q.resume()
    await flush()
    expect(f.chats.send).not.toHaveBeenCalled()
  })

  it("the pump reads the chat only after the idle's limit check, which may store a wait", async () => {
    const c = await single()
    await queued(c.id, 'm1')
    checked = deferred()
    q.idle(c.id)
    await flush()
    expect(calls).toContain(`checked:${c.id}`)
    expect(f.chats.send).not.toHaveBeenCalled()
    await setWait(c.id) // the check stores the wait
    checked.resolve()
    await flush()
    expect(f.chats.send).not.toHaveBeenCalled()
    expect(await taskIds(c.id)).toEqual(['m1'])
  })

  it('without a wait the checked pump sends the oldest task as before', async () => {
    const c = await single()
    await queued(c.id, 'm1', 'm2')
    q.idle(c.id)
    await flush()
    expect(f.chats.send).toHaveBeenCalledWith(c.id, 'm1', [], undefined, 'm1')
  })

  it("the user's message goes straight in while a wait holds the tasks, and ends the wait", async () => {
    const c = await single()
    await queued(c.id, 'm1')
    await setWait(c.id)
    const sent = q.submit(c.id, 'go on', [], undefined, 'mine')
    await flush()
    expect(f.chats.send).toHaveBeenCalledWith(c.id, 'go on', [], undefined, 'mine')
    expect(calls).toContain(`new:${c.id}`)
    expect((await store.get(c.id))?.resume).toBeUndefined()
    expect(await taskIds(c.id)).toEqual(['m1'])
    turns[0]!.resolve()
    await expect(sent).resolves.toBe('sent')
  })

  it('Send now ends the wait before the chosen task goes', async () => {
    const c = await single()
    await queued(c.id, 'm1', 'm2')
    await setWait(c.id)
    const sent = q.sendTask(c.id, 'm2')
    await flush()
    expect(calls).toEqual([`new:${c.id}`])
    expect(f.chats.send).toHaveBeenCalledWith(c.id, 'm2', [], undefined, 'm2')
    expect((await store.get(c.id))?.resume).toBeUndefined()
    turns[0]!.resolve()
    await sent
  })

  it('continueLimit sends the continue ahead of the tasks, ends the wait, and the tasks follow its turn', async () => {
    const c = await single()
    await queued(c.id, 'm1', 'm2')
    await setWait(c.id)
    await expect(q.continueLimit(c.id, 'continue', 'k1', 'u1', 'routine')).resolves.toBe('started')
    await flush()
    // A wait's own continue is no message the user typed: auto.
    expect(f.chats.send).toHaveBeenCalledWith(c.id, 'continue', [], undefined, 'k1', undefined, undefined, true)
    expect(calls).toContain(`new:${c.id}`)
    expect((await store.get(c.id))?.resume).toBeUndefined()
    expect(await taskIds(c.id)).toEqual(['m1', 'm2'])
    turns[0]!.resolve() // the continue's turn ends, and its pump sends the oldest task
    await flush()
    expect(f.chats.send).toHaveBeenCalledTimes(2)
    expect(f.chats.send).toHaveBeenLastCalledWith(c.id, 'm1', [], undefined, 'm1')
    expect(await taskIds(c.id)).toEqual(['m2'])
  })

  it("a process wake-up queues behind the wait, never ends it, and goes after the continue's turn", async () => {
    const c = await single()
    await setWait(c.id)
    const wake = 'Background process update'
    await expect(q.submit(c.id, wake, [], undefined, 'w1', undefined, undefined, 'process')).resolves.toBe('queued')
    await flush()
    expect(f.chats.send).not.toHaveBeenCalled()
    expect(calls).not.toContain(`new:${c.id}`)
    expect((await store.get(c.id))?.resume).toEqual(wait)
    expect((await store.get(c.id))?.tasks?.find((x) => x.id === 'w1')).toMatchObject({ text: wake, auto: true })
    // The wait's continue goes first and ends it; the wake-up follows that turn, still auto.
    await expect(q.continueLimit(c.id, 'continue', 'k1', 'u1', 'routine')).resolves.toBe('started')
    await flush()
    expect(f.chats.send).toHaveBeenCalledTimes(1)
    expect(f.chats.send).toHaveBeenCalledWith(c.id, 'continue', [], undefined, 'k1', undefined, undefined, true)
    turns[0]!.resolve()
    await flush()
    expect(f.chats.send).toHaveBeenCalledTimes(2)
    expect(f.chats.send).toHaveBeenLastCalledWith(c.id, wake, [], undefined, 'w1', undefined, undefined, true)
    expect(await taskIds(c.id)).toEqual([])
  })

  it("a room's process wake-up queues behind the wait too, and the wait stands", async () => {
    const g = await group()
    await setWait(g.id)
    await expect(q.submit(g.id, '@ui build failed', [], undefined, 'w1', undefined, undefined, 'process')).resolves.toBe('queued')
    await flush()
    expect(f.groups.send).not.toHaveBeenCalled()
    expect(calls).not.toContain(`new:${g.id}`)
    expect((await store.get(g.id))?.resume).toEqual(wait)
    expect(await taskIds(g.id)).toEqual(['w1'])
  })

  it("continueLimit from the user's Continue now is not auto, and a room's goes through GroupService", async () => {
    const c = await single()
    await setWait(c.id)
    await q.continueLimit(c.id, 'continue', 'k1', 'u1', 'user')
    await flush()
    expect(f.chats.send).toHaveBeenCalledWith(c.id, 'continue', [], undefined, 'k1')
    const g = await group()
    await setWait(g.id)
    await q.continueLimit(g.id, '@ui continue', 'k2', 'u1', 'user')
    await flush()
    expect(f.groups.send).toHaveBeenCalledWith(g.id, '@ui continue', [], undefined, 'k2')
    posts[0]!.resolve()
    turns[0]!.resolve()
  })

  it("continueLimit sends nothing when the wait is gone or another turn's, the chat is paused, or it runs", async () => {
    const c = await single()
    await expect(q.continueLimit(c.id, 'continue', 'k1', 'u1', 'routine')).resolves.toBe('gone')
    await setWait(c.id)
    await expect(q.continueLimit(c.id, 'continue', 'k1', 'u-other', 'routine')).resolves.toBe('gone')
    await store.patchInPlace(c.id, () => ({ pause: 'paused', held: true }))
    await expect(q.continueLimit(c.id, 'continue', 'k1', 'u1', 'routine')).resolves.toBe('gone')
    await store.patchInPlace(c.id, () => ({ pause: undefined, held: undefined }))
    running.add(c.id) // a compaction runs
    await expect(q.continueLimit(c.id, 'continue', 'k1', 'u1', 'routine')).resolves.toBe('busy')
    expect(f.chats.send).not.toHaveBeenCalled()
    expect(calls).toEqual([])
    expect((await store.get(c.id))?.resume).toEqual(wait)
  })
})

describe('TaskQueue spend caps (a cap pauses, the user goes on past it)', () => {
  let overrides: { chatId: string; cap: CapPause; sends: number }[]
  const cap: CapPause = {
    scope: { kind: 'routine', routineId: 'r1', runId: 'run1' },
    label: 'Daily',
    spentUsd: 2.1,
    limitUsd: 2,
    capUsd: 2
  }
  const setPause = (id: string) => store.update(id, { pause: 'paused', held: true, pauseCap: cap })
  beforeEach(() => {
    overrides = []
    q = new TaskQueue({
      store: tracked(store),
      chats: f.chats,
      groups: f.groups,
      files: f.files,
      push: (p) => {
        pushes.push(p)
      },
      now: () => 5000,
      newId: () => `id-${++n}`,
      capOverride: async (chatId, c) => {
        overrides.push({ chatId, cap: c, sends: f.chats.send.mock.calls.length })
      }
    })
  })

  it("a cap's Pause keeps why with the pause and writes the cap's word into the flag", async () => {
    const c = await single()
    void q.submit(c.id, 'go', [], undefined, 'm1')
    await flush()
    await q.pause(c.id, cap)
    expect(f.chats.setPauseFlag).toHaveBeenCalledWith(c.id, true, true)
    expect(await store.get(c.id)).toMatchObject({ pause: 'pausing', held: true, pauseCap: cap })
    turns[0]!.resolve()
  })

  it('Resume clears the cap with the pause and raises the limit before the Continue is sent', async () => {
    const c = await single()
    await setPause(c.id)
    const resumed = q.resumePaused(c.id)
    await flush()
    expect(overrides).toEqual([{ chatId: c.id, cap, sends: 0 }])
    expect(f.chats.send).toHaveBeenCalledTimes(1)
    expect((await store.get(c.id))!.pauseCap).toBeUndefined()
    turns[0]!.resolve()
    await resumed
  })

  it("the user's own message into a capped chat is going on past the cap too", async () => {
    const c = await single()
    await setPause(c.id)
    void q.submit(c.id, 'keep going', [], undefined, 'm1')
    await flush()
    expect(overrides).toEqual([{ chatId: c.id, cap, sends: 0 }])
    expect((await store.get(c.id))!.pauseCap).toBeUndefined()
    turns[0]!.resolve()
  })

  it("a user's own pause raises nothing when it ends", async () => {
    const c = await single()
    await store.update(c.id, { pause: 'paused', held: true })
    const resumed = q.resumePaused(c.id)
    await flush()
    expect(overrides).toEqual([])
    turns[0]!.resolve()
    await resumed
  })
})

// A Run result is the user's click on a block, but the user never sees its task: only a pause and a usage limit wait stop
// it, never `held`, which only the tray's Send now, drop or Resume would release.
describe('Run results are never held', () => {
  const run = { processId: 'p_0000000001' }
  const wait = { at: 9000, after: 'u1', waits: 1 }
  const cap: CapPause = {
    scope: { kind: 'routine', routineId: 'r1', runId: 'run1' },
    label: 'Daily',
    spentUsd: 2.1,
    limitUsd: 2,
    capUsd: 2
  }
  let calls: string[]
  let limits: LimitResumes
  const runSubmit = (id: string, messageId: string) =>
    q.submit(id, 'result', [], undefined, messageId, undefined, undefined, 'run', undefined, { run })
  const sent = () => f.chats.send.mock.calls.map((c) => c[1])
  const meta = async (id: string) => (await store.get(id))!
  const runTask = (id: string): QueuedTask => ({ id, text: 'result', run, ts: 1 })
  // The tray as an older build or a pause left it.
  const tray = async (id: string, patch: Partial<ChatMeta>, ...tasks: QueuedTask[]) => {
    for (const t of tasks) await store.addTask(id, t)
    await store.update(id, patch)
  }

  beforeEach(() => {
    calls = []
    // The real usage limit waits, wired as app.ts does, with a timer that never fires by itself.
    limits = new LimitResumes({
      store: tracked(store),
      tasks: { continueLimit: (...a) => q.continueLimit(...a), idle: (id) => q.idle(id) },
      isRunning: (id) => running.has(id),
      push: (p) => {
        pushes.push(p)
      },
      now: () => 5000,
      newId: () => `id-${++n}`,
      setTimer: () => ({ clear: () => {} }),
      log: () => {}
    })
    q = new TaskQueue({
      store: tracked(store),
      chats: f.chats,
      groups: f.groups,
      files: f.files,
      push: (p) => {
        pushes.push(p)
      },
      now: () => 5000,
      newId: () => `id-${++n}`,
      onNewTurn: async (id) => {
        calls.push(`new:${id}`)
        await track(limits.cancel(id))
      },
      limitChecked: (id) => limits.settled(id),
      capOverride: async (id) => {
        calls.push(`cap:${id}`)
      }
    })
  })

  it('a paused chat the user types into: the pause ends, nothing stays held, and the result goes after the reply', async () => {
    const c = await single()
    await store.update(c.id, { pause: 'paused', held: true })
    await expect(runSubmit(c.id, 'r1')).resolves.toBe('queued')
    const typed = q.submit(c.id, 'hello', [], undefined, 'u1')
    await flush()
    expect(await meta(c.id)).toMatchObject({ tasks: [{ id: 'r1', run }] })
    expect((await meta(c.id)).held).toBeUndefined()
    turns[0].resolve()
    await typed
    q.idle(c.id)
    await flush()
    expect(sent()).toEqual(['hello', 'result'])
    expect(f.chats.send.mock.calls[1]![10]).toEqual(run)
    turns[1].resolve()
    await flush()
    const m = await meta(c.id)
    expect(m.tasks).toBeUndefined()
    expect(m.held).toBeUndefined()
  })

  it('a paused chat with a visible task too: that one stays held, the result still goes', async () => {
    const c = await single()
    await tray(c.id, { pause: 'paused', held: true }, { id: 't1', text: 't1', ts: 1 }, runTask('r1'))
    const typed = q.submit(c.id, 'hello', [], undefined, 'u1')
    await flush()
    expect((await meta(c.id)).held).toBe(true)
    turns[0].resolve()
    await typed
    q.idle(c.id)
    await flush()
    expect(sent()).toEqual(['hello', 'result'])
    turns[1].resolve()
    q.idle(c.id)
    await flush()
    expect(sent()).toEqual(['hello', 'result'])
    expect(await meta(c.id)).toMatchObject({ held: true, tasks: [{ id: 't1' }] })
  })

  it('an edit while a reply runs holds no tray of run results alone, and the result goes after the new version', async () => {
    const c = await single()
    await store.saveItems(c.id, [said('u1')])
    void q.submit(c.id, 'go', [], undefined, 'u2')
    await flush()
    await expect(runSubmit(c.id, 'r1')).resolves.toBe('queued')
    const redo = q.rerun(c.id, 'u1', 'edited')
    await flush()
    expect(f.chats.rerun).toHaveBeenCalledTimes(1)
    expect((await meta(c.id)).held).toBeUndefined()
    turns[1].resolve()
    await redo
    await flush()
    expect(sent()).toEqual(['go', 'result'])
    turns[2].resolve()
    await flush()
    expect((await meta(c.id)).tasks).toBeUndefined()
  })

  it('a Resend while a reply runs holds the visible tasks, and the result still goes after it', async () => {
    const c = await single()
    await store.saveItems(c.id, [said('u1')])
    void q.submit(c.id, 'go', [], undefined, 'u2')
    await flush()
    await q.submit(c.id, 'later', [], undefined, 't1')
    await runSubmit(c.id, 'r1')
    const redo = q.rerun(c.id, 'u1', null)
    await flush()
    expect((await meta(c.id)).held).toBe(true)
    turns[1].resolve()
    await redo
    await flush()
    expect(sent()).toEqual(['go', 'result'])
    turns[2].resolve()
    q.idle(c.id)
    await flush()
    expect(sent()).toEqual(['go', 'result'])
    expect(await meta(c.id)).toMatchObject({ held: true, tasks: [{ id: 't1' }] })
  })

  it("Don't continue on a usage limit wait holds no run result: it goes at once", async () => {
    const c = await single()
    await store.patchInPlace(c.id, () => ({ resume: wait }))
    await expect(runSubmit(c.id, 'r1')).resolves.toBe('queued')
    await flush()
    expect(sent()).toEqual([])
    await limits.dontContinue(c.id)
    await flush()
    expect(sent()).toEqual(['result'])
    turns[0].resolve()
    await flush()
    const m = await meta(c.id)
    expect(m.resume).toBeUndefined()
    expect(m.held).toBeUndefined()
    expect(m.tasks).toBeUndefined()
  })

  it("Don't continue with a visible task: that one is held for the user, the result goes", async () => {
    const c = await single()
    await tray(c.id, { resume: wait }, { id: 't1', text: 't1', ts: 1 }, runTask('r1'))
    await limits.dontContinue(c.id)
    await flush()
    expect(sent()).toEqual(['result'])
    turns[0].resolve()
    q.idle(c.id)
    await flush()
    expect(sent()).toEqual(['result'])
    expect(await meta(c.id)).toMatchObject({ held: true, tasks: [{ id: 't1' }] })
  })

  it('typing into a chat a spend cap paused: the cap is passed, nothing stays held, the result goes after the reply', async () => {
    const c = await single()
    await store.update(c.id, { pause: 'paused', held: true, pauseCap: cap })
    await runSubmit(c.id, 'r1')
    const typed = q.submit(c.id, 'keep going', [], undefined, 'u1')
    await flush()
    expect(calls).toContain(`cap:${c.id}`)
    expect((await meta(c.id)).held).toBeUndefined()
    turns[0].resolve()
    await typed
    q.idle(c.id)
    await flush()
    expect(sent()).toEqual(['keep going', 'result'])
    turns[1].resolve()
    await flush()
    const m = await meta(c.id)
    expect(m.held).toBeUndefined()
    expect(m.tasks).toBeUndefined()
  })

  it('a usage limit wait keeps a run result queued and is not ended by it; the result follows the continue', async () => {
    const c = await single()
    await store.patchInPlace(c.id, () => ({ resume: wait }))
    await expect(runSubmit(c.id, 'r1')).resolves.toBe('queued')
    await flush()
    expect(sent()).toEqual([])
    expect(calls).toEqual([])
    expect((await meta(c.id)).resume).toEqual(wait)
    await expect(q.continueLimit(c.id, 'continue', 'k1', 'u1', 'routine')).resolves.toBe('started')
    await flush()
    expect(sent()).toEqual(['continue'])
    turns[0].resolve() // the continue's turn ends; its pump sends the result
    await flush()
    expect(sent()).toEqual(['continue', 'result'])
    expect(f.chats.send.mock.calls[1]![10]).toEqual(run)
    turns[1].resolve()
  })

  it('a run result queued behind a busy turn never ends a usage limit wait either', async () => {
    const c = await single()
    void q.submit(c.id, 'go', [], undefined, 'u1')
    await flush()
    await store.patchInPlace(c.id, () => ({ resume: wait }))
    calls = []
    await runSubmit(c.id, 'r1')
    expect(calls).toEqual([])
    expect((await meta(c.id)).resume).toEqual(wait)
    turns[0].resolve()
  })

  it('a held tray lets its run result go, but never past a pause or a usage limit wait', async () => {
    const free = await single()
    const paused = await single()
    const waiting = await single()
    await tray(free.id, { held: true }, { id: 't1', text: 't1', ts: 1 }, runTask('r1'))
    await tray(paused.id, { held: true, pause: 'paused' }, runTask('r2'))
    await tray(waiting.id, { held: true, resume: wait }, { id: 't3', text: 't3', ts: 1 }, runTask('r3'))
    for (const id of [free.id, paused.id, waiting.id]) q.idle(id)
    await flush()
    expect(f.chats.send.mock.calls.map((c) => [c[0], c[4]])).toEqual([[free.id, 'r1']])
    expect(await meta(free.id)).toMatchObject({ held: true, tasks: [{ id: 't1' }] })
    expect(await taskIds(paused.id)).toEqual(['r2'])
    expect(await taskIds(waiting.id)).toEqual(['t3', 'r3'])
    turns[0].resolve()
  })

  it('a room the hop cap paused lets its run result go, as a message the user writes would (submit lets one in too)', async () => {
    const room = await group()
    await store.saveItems(room.id, [said('u1'), notice('paused')])
    await tray(room.id, {}, { id: 't1', text: 't1', ts: 1 }, runTask('r1'))
    q.idle(room.id)
    await flush()
    expect(f.groups.send.mock.calls.map((c) => c[4])).toEqual(['r1'])
    expect(f.groups.send.mock.calls[0]![9]).toEqual(run)
    expect(await taskIds(room.id)).toEqual(['t1'])
    posts[0].resolve()
  })

  it('a restart strands no run result: a held tray (an older build held run results too) lets them go', async () => {
    const mixed = await single()
    const alone = await single()
    await tray(mixed.id, { held: true }, { id: 't1', text: 't1', ts: 1 }, runTask('r1'))
    await tray(alone.id, { held: true }, runTask('r2'))
    await q.resume()
    await flush()
    expect(f.chats.send.mock.calls.map((c) => c[4]).sort()).toEqual(['r1', 'r2'])
    expect(await meta(mixed.id)).toMatchObject({ held: true, tasks: [{ id: 't1' }] })
    const left = await meta(alone.id)
    expect(left.tasks).toBeUndefined()
    expect(left.held).toBeUndefined()
    turns[0].resolve()
    turns[1].resolve()
  })

  it('a version switch that ends a pause lets a waiting run result go', async () => {
    const c = await single()
    await tray(c.id, { pause: 'paused', held: true }, { id: 't1', text: 't1', ts: 1 }, runTask('r1'))
    await q.switchVersion(c.id, 'u1', 0)
    await flush()
    expect(sent()).toEqual(['result'])
    expect(await meta(c.id)).toMatchObject({ held: true, tasks: [{ id: 't1' }] })
    expect((await meta(c.id)).pause).toBeUndefined()
    turns[0].resolve()
  })

  it('a run item is never edited or sent again, and a running reply is not stopped for it', async () => {
    const c = await single()
    await store.saveItems(c.id, [said('u1'), { type: 'user', id: 'r1', text: 'result', ts: 1, run }])
    void q.submit(c.id, 'go', [], undefined, 'u2')
    await flush()
    await expect(q.rerun(c.id, 'r1', 'edited')).rejects.toThrow(RUN_ITEM_FIXED)
    await expect(q.rerun(c.id, 'r1', null)).rejects.toThrow(RUN_ITEM_FIXED)
    expect(f.chats.stop).not.toHaveBeenCalled()
    expect(f.chats.rerun).not.toHaveBeenCalled()
    turns[0].resolve()
  })
})

// ---- mid-turn steers (docs/architecture/mid-turn-messages.md) ----

describe('TaskQueue.submit with steer', () => {
  const steer = { steer: true as const }

  it("a user's steer into a running single chat goes into the reply and resolves 'steered'", async () => {
    const c = await single()
    running.add(c.id)
    const committed: string[] = []
    const out = await q.submit(c.id, 'more', ['a1'], 'r1', 'm1', undefined, undefined, 'user', undefined, {
      ...steer,
      committed: (r) => committed.push(r)
    })
    expect(out).toBe('steered')
    expect(committed).toEqual(['steered'])
    expect(f.chats.steer).toHaveBeenCalledWith(c.id, { id: 'm1', text: 'more', attachments: [att('a1')], replyTo: 'r1', ts: 5000 })
    expect(await taskIds(c.id)).toEqual([])
  })

  it('a steer the reply cannot take queues as a task, its files committed once', async () => {
    const c = await single()
    running.add(c.id)
    steerTakes = false
    const out = await q.submit(c.id, 'more', ['a1'], undefined, 'm1', undefined, undefined, 'user', undefined, steer)
    expect(out).toBe('queued')
    expect(await taskIds(c.id)).toEqual(['m1'])
    expect(f.files.commit).toHaveBeenCalledTimes(1)
  })

  it('command and todo messages queue', async () => {
    const c = await single()
    running.add(c.id)
    const command = { agent: 'alpha', name: 'review', prompt: 'Review it' } as unknown as SentCommand
    expect(await q.submit(c.id, '/review', [], undefined, 'm1', command, undefined, 'user', undefined, steer)).toBe('queued')
    expect(await q.submit(c.id, '/todo x', [], undefined, 'm2', undefined, true, 'user', undefined, steer)).toBe('queued')
    expect(f.chats.steer).not.toHaveBeenCalled()
  })

  it('a typed slash command the menu did not resolve queues too: mid-turn it would reach the CLI as plain text', async () => {
    const c = await single()
    running.add(c.id)
    expect(await q.submit(c.id, '/simplify the parser', [], undefined, 'm1', undefined, undefined, 'user', undefined, steer)).toBe('queued')
    expect(await q.submit(c.id, '  /compact', [], undefined, 'm2', undefined, undefined, 'user', undefined, steer)).toBe('queued')
    expect(f.chats.steer).not.toHaveBeenCalled()
    expect(await q.submit(c.id, 'use a/b paths', [], undefined, 'm3', undefined, undefined, 'user', undefined, steer)).toBe('steered')
  })

  it('without the steer option a busy chat queues as before, and a routine never steers', async () => {
    const c = await single()
    running.add(c.id)
    expect(await q.submit(c.id, 'typed', [], undefined, 'm1')).toBe('queued')
    expect(await q.submit(c.id, 'tick', [], undefined, 'm2', undefined, undefined, 'routine', undefined, steer)).toBe('queued')
    expect(f.chats.steer).not.toHaveBeenCalled()
  })

  it('groups and paused chats never steer', async () => {
    const g = await group()
    running.add(g.id)
    expect(await q.submit(g.id, 'hi all', [], undefined, 'm1', undefined, undefined, 'user', undefined, steer)).toBe('queued')
    const c = await single()
    running.add(c.id)
    await store.update(c.id, { pause: 'pausing' })
    expect(await q.submit(c.id, 'wait', [], undefined, 'm2', undefined, undefined, 'user', undefined, steer)).toBe('queued')
    expect(f.chats.steer).not.toHaveBeenCalled()
  })

  it('an idle chat sends a steer as a normal message', async () => {
    const c = await single()
    const sent = q.submit(c.id, 'hi', [], undefined, 'm1', undefined, undefined, 'user', undefined, steer)
    await flush()
    expect(f.chats.send).toHaveBeenCalledTimes(1)
    expect(f.chats.steer).not.toHaveBeenCalled()
    turns[0].resolve()
    await expect(sent).resolves.toBe('sent')
  })

  it('unread steers count toward the queue limit', async () => {
    const c = await single()
    running.add(c.id)
    for (let i = 0; i < TASKS_MAX; i++) await store.addSteer(c.id, { id: `s${i}`, text: 'x', ts: 1 })
    await expect(q.submit(c.id, 'one more', [], undefined, 'm1', undefined, undefined, 'user', undefined, steer)).rejects.toThrow(
      `A chat can hold at most ${TASKS_MAX} queued messages`
    )
    await expect(q.submit(c.id, 'one more', [], undefined, 'm2')).rejects.toThrow(`A chat can hold at most ${TASKS_MAX} queued messages`)
  })
})

describe('TaskQueue.rerun of a mid-turn message', () => {
  it('refuses an edit or resend of a message sent into a running reply, before anything stops', async () => {
    const c = await single()
    await store.saveItems(c.id, [said('u1'), { type: 'user', id: 's1', text: 'more', ts: 2, steered: true }])
    running.add(c.id)
    await expect(q.rerun(c.id, 's1', 'edited')).rejects.toThrow(STEERED_ITEM_FIXED)
    await expect(q.rerun(c.id, 's1', null)).rejects.toThrow(STEERED_ITEM_FIXED)
    expect(f.chats.stop).not.toHaveBeenCalled()
    expect(f.chats.rerun).not.toHaveBeenCalled()
  })
})

describe('/later messages (from later)', () => {
  const at = 1_800_000_000_000
  const laterSubmit = (id: string, text: string, messageId: string) =>
    q.submit(id, text, [], undefined, messageId, undefined, undefined, 'later', undefined, { later: at })

  it('launches an idle chat with its mark after the run slot, and no auto', async () => {
    const c = await single()
    const p = laterSubmit(c.id, 'check CI', 'm1')
    await flush()
    expect(f.chats.send.mock.calls[0]).toEqual([c.id, 'check CI', [], undefined, 'm1', undefined, undefined, undefined, undefined, undefined, undefined, at])
    turns[0]!.resolve()
    await p
  })

  it('queues while the chat runs, keeping its mark, and never steers', async () => {
    const c = await single()
    const first = q.submit(c.id, 'go', [], undefined, 'm1')
    await flush()
    await expect(
      q.submit(c.id, 'check CI', [], undefined, 'm2', undefined, undefined, 'later', undefined, { later: at, steer: true })
    ).resolves.toBe('queued')
    expect(f.chats.steer).not.toHaveBeenCalled()
    const task = (await store.get(c.id))?.tasks?.[0]
    expect(task).toMatchObject({ id: 'm2', later: at })
    expect(task).not.toHaveProperty('auto')
    turns[0]!.resolve()
    await first
    q.idle(c.id)
    await flush()
    expect(f.chats.send.mock.calls[1]?.[11]).toBe(at)
  })

  it('waits, held, in a paused chat and keeps the pause', async () => {
    const c = await single()
    await store.update(c.id, { pause: 'paused' })
    await expect(laterSubmit(c.id, 'check CI', 'm1')).resolves.toBe('queued')
    await flush()
    expect(f.chats.send).not.toHaveBeenCalled()
    expect(await store.get(c.id)).toMatchObject({ pause: 'paused', held: true, tasks: [{ id: 'm1', later: at }] })
  })

  it('queues behind a usage limit wait and does not end it', async () => {
    const calls: string[] = []
    q = new TaskQueue({
      store: tracked(store),
      chats: f.chats,
      groups: f.groups,
      files: f.files,
      push: (p) => {
        pushes.push(p)
      },
      now: () => 5000,
      newId: () => `id-${++n}`,
      onNewTurn: async (chatId) => {
        calls.push(chatId)
      }
    })
    const c = await single()
    await store.update(c.id, { resume: { at: 9000, after: 'u1', waits: 1 } })
    await expect(laterSubmit(c.id, 'check CI', 'm1')).resolves.toBe('queued')
    await flush()
    expect(calls).toEqual([])
    expect(f.chats.send).not.toHaveBeenCalled()
    expect((await store.get(c.id))?.resume).toBeDefined()
  })

  it('a room gets the mark after the run slot', async () => {
    const g = await group()
    const p = laterSubmit(g.id, '@ui check CI', 'm1')
    await flush()
    expect(f.groups.send.mock.calls[0]).toEqual([g.id, '@ui check CI', [], undefined, 'm1', undefined, undefined, undefined, undefined, undefined, at])
    posts[0]!.resolve()
    await p
  })
})
