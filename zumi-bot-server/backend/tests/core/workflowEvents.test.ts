import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChatMeta } from '@zumibot/shared/types'
import type { TriggerFilter, Workflow, WorkflowRun, WorkflowTrigger } from '@zumibot/shared/workflows'
import {
  EVENT_RUNS_PER_MINUTE,
  INBOX_CHAIN_MAX,
  eventCall,
  eventText,
  type EventBodies,
  type WorkflowEvent
} from '@zumibot/shared/workflowEvents'
import { WorkflowEventDispatcher, workflowChat, type EventDispatcherDeps } from '../../src/core/workflows/workflowEvents'

const T0 = Date.parse('2026-11-13T09:00:00Z')
let now: number
let workflows: Workflow[]
let meta: Record<string, ChatMeta | null>
let runs: Record<string, WorkflowRun>
let busyIds: Set<string>
let depths: { workflowId: string; depth: number }[] // the runner's unfinished runs
let started: { id: string; via: string; o: any }[]
let logs: string[]
let runImpl: () => Promise<unknown>
let d: WorkflowEventDispatcher

const wf = (id: string, trigger: WorkflowTrigger, enabled = true): Workflow => ({
  id,
  name: id,
  enabled,
  timeZone: 'UTC',
  trigger,
  steps: [],
  edges: [],
  nextRunAt: null,
  createdAt: 0,
  updatedAt: 0
})
const chatMeta = (extra: Partial<ChatMeta> = {}): ChatMeta => ({ id: 'c1', ...extra }) as ChatMeta
const chat = { id: 'c1', title: 'T', folder: '/f' }
const reply = (over: Partial<EventBodies['reply']> = {}): WorkflowEvent => ({
  kind: 'reply',
  body: { chat, agent: 'writer', outcome: 'ok', room: false, reply: 'done', ...over }
})
const todo = (): WorkflowEvent => ({ kind: 'todo', body: { chat, by: 'user', count: 1, todos: [{ text: 'a', group: null }] } })
const inbox = (wid: string, runId = 'r0'): WorkflowEvent => ({
  kind: 'inbox',
  body: { message: { id: 'm', title: 'Hi', body: '' }, workflow: { id: wid, name: wid }, step: 's', runId }
})
const file = (): WorkflowEvent => ({
  kind: 'file',
  body: { folder: '/x', count: 1, truncated: false, files: [{ path: '/x/a.pdf', name: 'a.pdf', change: 'added' }] }
})
const run = (id: string, over: Partial<WorkflowRun> = {}): WorkflowRun => ({ id, workflowId: 'w', via: 'manual', ...over }) as WorkflowRun

beforeEach(() => {
  now = T0
  workflows = []
  meta = { c1: chatMeta() }
  runs = {}
  busyIds = new Set()
  depths = []
  started = []
  logs = []
  runImpl = async () => ({})
  const deps: EventDispatcherDeps = {
    workflows: async () => workflows,
    run: ((w: Workflow, via: string, o: unknown) => {
      started.push({ id: w.id, via, o })
      return runImpl()
    }) as any,
    chatMeta: async (id) => meta[id] ?? null,
    getRun: async (id) => runs[id] ?? null,
    busy: (id) => busyIds.has(id),
    activeDepths: (except) => depths.filter((x) => x.workflowId !== except).map((x) => x.depth),
    now: () => now,
    log: (l) => logs.push(l)
  }
  d = new WorkflowEventDispatcher(deps)
})

describe('workflowChat', () => {
  it('is true for a workflow, test or asked chat', () => {
    expect(workflowChat(chatMeta())).toBe(false)
    expect(workflowChat(chatMeta({ workflow: { workflowId: 'w', runId: 'r', stepId: 's', name: 'n' } }))).toBe(true)
    expect(workflowChat(chatMeta({ workflowTest: 'n' }))).toBe(true)
    expect(workflowChat(chatMeta({ workflowTest: '' }))).toBe(true)
    expect(workflowChat(chatMeta({ asked: { agent: 'a', chatId: 'x' } as any }))).toBe(true)
  })
})

describe('emit', () => {
  it('fires each enabled workflow of the kind with the event call, text and kind', async () => {
    workflows = [
      wf('a', { kind: 'reply', filters: [] }),
      wf('b', { kind: 'reply', filters: [] }, false),
      wf('c', { kind: 'todo', filters: [] }),
      wf('m', { kind: 'manual' })
    ]
    const e = reply()
    await d.emit(e)
    expect(started.map((s) => s.id)).toEqual(['a'])
    expect(started[0].via).toBe('event')
    expect(started[0].o).toEqual({ call: eventCall(e.body, T0), input: eventText(e), event: { kind: 'reply' } })
  })

  it('honours only', async () => {
    const f: WorkflowTrigger = { kind: 'file', path: '/x', pattern: '', changes: ['added'], filters: [] }
    workflows = [wf('a', f), wf('b', f)]
    await d.emit(file(), { only: 'b' })
    expect(started.map((s) => s.id)).toEqual(['b'])
  })

  it('runs nothing when a filter fails, and starts when it passes', async () => {
    const filters: TriggerFilter[] = [{ field: 'body.agent', equals: 'writer' }]
    workflows = [wf('a', { kind: 'reply', filters })]
    await d.emit(reply({ agent: 'other' }))
    expect(started).toHaveLength(0)
    await d.emit(reply())
    expect(started).toHaveLength(1)
  })

  it('applies contains filters', async () => {
    workflows = [wf('a', { kind: 'reply', filters: [{ field: 'body.reply', equals: 'on', op: 'contains' }] })]
    await d.emit(reply())
    expect(started).toHaveLength(1)
  })

  it.each([
    ['workflow', chatMeta({ workflow: { workflowId: 'w', runId: 'r', stepId: 's', name: 'n' } })],
    ['workflowTest', chatMeta({ workflowTest: 'n' })],
    ['asked', chatMeta({ asked: { agent: 'a', chatId: 'x' } as any })]
  ])('skips reply and to-do from a %s chat', async (_n, m) => {
    meta.c1 = m
    workflows = [wf('a', { kind: 'reply', filters: [] }), wf('b', { kind: 'todo', filters: [] })]
    await d.emit(reply())
    await d.emit(todo())
    expect(started).toHaveLength(0)
  })

  it('fires nothing for a deleted chat and reads the meta once per event', async () => {
    workflows = [wf('a', { kind: 'reply', filters: [] }), wf('b', { kind: 'reply', filters: [] })]
    const spy = vi.fn(async (id: string) => meta[id] ?? null)
    const d2 = new WorkflowEventDispatcher({
      workflows: async () => workflows,
      run: (() => Promise.resolve({})) as any,
      chatMeta: spy,
      getRun: async () => null,
      busy: () => false,
      activeDepths: () => [],
      now: () => now,
      log: () => {}
    })
    await d2.emit(reply())
    expect(spy).toHaveBeenCalledTimes(1)
    meta = {}
    await d2.emit(reply())
    expect(started).toHaveLength(0)
  })

  describe('inbox', () => {
    const inb: WorkflowTrigger = { kind: 'inbox', filters: [] }
    it('skips the sending workflow itself, fires another, with depth 1 from a plain run', async () => {
      workflows = [wf('a', inb), wf('b', inb)]
      runs.r0 = run('r0')
      await d.emit(inbox('a'))
      expect(started.map((s) => s.id)).toEqual(['b'])
      expect(started[0].o.event).toEqual({ kind: 'inbox', depth: 1 })
    })
    it('fires at depth 3 from a depth 2 source, not from depth 3', async () => {
      workflows = [wf('b', inb)]
      runs.r0 = run('r0', { via: 'event', event: { kind: 'inbox', depth: 2 } })
      await d.emit(inbox('a'))
      expect(started[0].o.event).toEqual({ kind: 'inbox', depth: 3 })
      expect(INBOX_CHAIN_MAX).toBe(3)
      started = []
      runs.r0 = run('r0', { via: 'event', event: { kind: 'inbox', depth: 3 } })
      await d.emit(inbox('a'))
      expect(started).toHaveLength(0)
    })
    it('treats a missing depth as 1', async () => {
      workflows = [wf('b', inb)]
      runs.r0 = run('r0', { via: 'event', event: { kind: 'inbox' } })
      await d.emit(inbox('a'))
      expect(started[0].o.event.depth).toBe(2)
    })
    it('walks the parent chain to the root', async () => {
      workflows = [wf('b', inb)]
      const parent = (runId: string) => ({ workflowId: 'w', runId, visitId: 'v', name: 'n', stepName: 's', depth: 1 })
      runs.r0 = run('r0', { via: 'workflow', parent: parent('r1') })
      runs.r1 = run('r1', { via: 'workflow', parent: parent('r2') })
      runs.r2 = run('r2', { via: 'event', event: { kind: 'inbox', depth: 3 } })
      await d.emit(inbox('a'))
      expect(started).toHaveLength(0)
      runs.r2 = run('r2', { via: 'event', event: { kind: 'inbox', depth: 2 } })
      await d.emit(inbox('a'))
      expect(started[0].o.event.depth).toBe(3)
    })
    it('a root started by any event kind counts its depth (missing = 1); a missing run or a non-event root counts 0', async () => {
      workflows = [wf('b', inb)]
      runs.r0 = run('r0', { via: 'event', event: { kind: 'reply' } })
      await d.emit(inbox('a'))
      expect(started[0].o.event.depth).toBe(2)
      started = []
      await d.emit(inbox('a', 'gone'))
      expect(started[0].o.event.depth).toBe(1)
      started = []
      runs.r0 = run('r0', { via: 'schedule' })
      await d.emit(inbox('a'))
      expect(started[0].o.event.depth).toBe(1)
    })
    it('a chain through a file-started root: depth 2 fires at 3, depth 3 does not fire', async () => {
      workflows = [wf('b', inb)]
      runs.r0 = run('r0', { via: 'event', event: { kind: 'file', depth: 2 } })
      await d.emit(inbox('a'))
      expect(started[0].o.event).toEqual({ kind: 'inbox', depth: 3 })
      started = []
      runs.r0 = run('r0', { via: 'event', event: { kind: 'file', depth: 3 } })
      await d.emit(inbox('a'))
      expect(started).toHaveLength(0)
    })
    it('stops at a missing parent run and stops after 10 hops', async () => {
      workflows = [wf('b', inb)]
      runs.r0 = run('r0', { parent: { workflowId: 'w', runId: 'missing', visitId: 'v', name: 'n', stepName: 's', depth: 1 } })
      await d.emit(inbox('a'))
      expect(started).toHaveLength(1)
      // a cycle must end
      runs.r0 = run('r0', { parent: { workflowId: 'w', runId: 'r0', visitId: 'v', name: 'n', stepName: 's', depth: 1 } })
      await d.emit(inbox('a'))
      expect(started).toHaveLength(2)
    })
    it('does not pass depth for other kinds', async () => {
      workflows = [wf('a', { kind: 'reply', filters: [] })]
      await d.emit(reply())
      expect(started[0].o.event).toEqual({ kind: 'reply' })
    })
  })

  describe('file depth', () => {
    const f: WorkflowTrigger = { kind: 'file', path: '/x', pattern: '', changes: ['added'], filters: [] }
    it('is 1 with no other workflow running, and leaves its own runs out', async () => {
      workflows = [wf('a', f)]
      depths = [{ workflowId: 'a', depth: 3 }]
      await d.emit(file(), { only: 'a' })
      expect(started[0].o.event).toEqual({ kind: 'file', depth: 1 })
    })
    it('is 1 more than the deepest other unfinished run, and past the chain max it does not fire', async () => {
      workflows = [wf('a', f)]
      depths = [
        { workflowId: 'w1', depth: 0 },
        { workflowId: 'w2', depth: 1 }
      ]
      await d.emit(file(), { only: 'a' })
      expect(started[0].o.event).toEqual({ kind: 'file', depth: 2 })
      started = []
      depths = [
        { workflowId: 'w1', depth: 1 },
        { workflowId: 'w2', depth: 3 }
      ]
      await d.emit(file(), { only: 'a' })
      expect(started).toHaveLength(0)
    })
  })

  it('drops file events while a run of that workflow is unfinished', async () => {
    workflows = [wf('a', { kind: 'file', path: '/x', pattern: '', changes: ['added'], filters: [] })]
    busyIds.add('a')
    await d.emit(file(), { only: 'a' })
    expect(started).toHaveLength(0)
    busyIds.clear()
    await d.emit(file(), { only: 'a' })
    expect(started).toHaveLength(1)
  })

  it('caps event runs per workflow per minute', async () => {
    workflows = [wf('a', { kind: 'reply', filters: [] }), wf('b', { kind: 'reply', filters: [{ field: 'body.agent', equals: 'x' }] })]
    for (let i = 0; i < EVENT_RUNS_PER_MINUTE; i++) await d.emit(reply())
    expect(started).toHaveLength(EVENT_RUNS_PER_MINUTE)
    await d.emit(reply())
    expect(started).toHaveLength(EVENT_RUNS_PER_MINUTE)
    now = T0 + 60_001
    await d.emit(reply())
    expect(started).toHaveLength(EVENT_RUNS_PER_MINUTE + 1)
  })

  it('counts only runs that started, so filtered events do not use the cap', async () => {
    workflows = [wf('a', { kind: 'reply', filters: [{ field: 'body.agent', equals: 'writer' }] })]
    for (let i = 0; i < 40; i++) await d.emit(reply({ agent: 'other' }))
    await d.emit(reply())
    expect(started).toHaveLength(1)
  })

  it('logs a rejected run and never throws', async () => {
    workflows = [wf('a', { kind: 'reply', filters: [] }), wf('b', { kind: 'reply', filters: [] })]
    runImpl = () => Promise.reject(new Error('boom'))
    await expect(d.emit(reply())).resolves.toBeUndefined()
    expect(started).toHaveLength(2)
    expect(logs.length).toBe(2)
    expect(logs[0]).toContain('boom')
  })

  it('never throws when a dependency fails', async () => {
    const bad = new WorkflowEventDispatcher({
      workflows: async () => {
        throw new Error('x')
      },
      run: (() => Promise.resolve({})) as any,
      chatMeta: async () => null,
      getRun: async () => null,
      busy: () => false,
      activeDepths: () => [],
      now: () => now,
      log: (l) => logs.push(l)
    })
    await expect(bad.emit(reply())).resolves.toBeUndefined()
    expect(logs).toHaveLength(1)
  })
})
