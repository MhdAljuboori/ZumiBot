import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DISPATCH_STEPS_MAX, type DispatchEntry, type DispatchFile, type DispatchStep } from '@zumibot/shared/dispatch'
import type { ChatItem } from '@zumibot/shared/types'
import { DispatchService } from '../../src/core/dispatch/dispatchService'

const entry = (id: string, extra: Partial<DispatchEntry> = {}): DispatchEntry => ({
  id,
  parent: null,
  turn: 't',
  description: id,
  subagentType: null,
  prompt: 'p',
  status: 'done',
  now: null,
  usage: { tokens: null, toolUses: null, durationMs: null },
  steps: [],
  report: null,
  startedAt: 1,
  endedAt: 2,
  updatedAt: 2,
  ...extra
})
const toolItem = (id: string): ChatItem => ({
  type: 'tool',
  id,
  name: 'Agent',
  input: {},
  result: null,
  isError: false,
  blocked: false,
  ts: 1
})

function setup(o: { files?: Record<string, DispatchFile>; items?: Record<string, ChatItem[]>; failSave?: boolean } = {}) {
  const files = new Map<string, DispatchFile>(Object.entries(o.files ?? {}))
  const items = new Map<string, ChatItem[]>(Object.entries(o.items ?? { c1: [] }))
  const saves: DispatchFile[] = []
  const changed: string[] = []
  const reads = { items: 0, dispatch: 0 }
  const store = {
    loadDispatch: async (id: string) => {
      reads.dispatch++
      return files.get(id) ?? { v: 1 as const, entries: [] }
    },
    updateDispatch: async (id: string, fn: (f: DispatchFile) => DispatchFile) => {
      if (o.failSave) throw Object.assign(new Error('disk full /secret/path'), { code: 'ENOSPC' })
      const cur = files.get(id) ?? { v: 1 as const, entries: [] }
      const next = fn(cur)
      files.set(id, next)
      saves.push(next)
      return next
    },
    loadItems: async (id: string) => {
      reads.items++
      return items.get(id) ?? []
    }
  }
  let t = 100
  const service = new DispatchService({ store, onChanged: (id) => changed.push(id), now: () => ++t, privateTool: () => null })
  return { service, files, items, saves, changed, reads }
}

beforeEach(() => {
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
})

describe('DispatchService', () => {
  it('a running turn is told about once a second from memory and written only when it finishes', async () => {
    const { service, saves, changed } = setup()
    const rec = service.begin('c1', { turn: 'turn-1' })
    rec.event({ kind: 'toolUse', id: 'a', name: 'Agent', input: { description: 'A', prompt: 'p' } })
    rec.event({ kind: 'subText', parent: 'a', text: 'one' })
    rec.event({ kind: 'subText', parent: 'a', text: 'two' })
    expect(changed).toEqual([])
    await vi.advanceTimersByTimeAsync(1000)
    expect(changed).toEqual(['c1'])
    expect(saves).toHaveLength(0)
    expect((await service.get('c1', 'a'))?.entry.steps).toHaveLength(2)
    await service.finish('c1', rec)
    expect(saves).toHaveLength(1)
    expect(saves[0].entries[0].steps).toHaveLength(2)
    expect(changed).toEqual(['c1', 'c1'])
  })

  it('holds at most 20 chats in memory', async () => {
    const files: Record<string, DispatchFile> = {}
    const items: Record<string, ChatItem[]> = {}
    for (let i = 0; i < 22; i++) {
      files[`c${i}`] = { v: 1, entries: [entry(`e${i}`)] }
      items[`c${i}`] = [toolItem(`e${i}`)]
    }
    const { service, reads } = setup({ files, items })
    for (let i = 0; i < 22; i++) await service.list(`c${i}`)
    expect(reads).toEqual({ items: 22, dispatch: 22 })
    await service.list('c21') // still held
    await service.list('c0') // dropped first, read again
    expect(reads).toEqual({ items: 23, dispatch: 23 })
  })

  it('list overlays live entries even before their tool item is saved', async () => {
    const { service } = setup()
    const rec = service.begin('c1', { turn: 'turn-1', member: 'alice' })
    rec.event({ kind: 'toolUse', id: 'a', name: 'Agent', input: { description: 'A', prompt: 'p' } })
    rec.event({ kind: 'subToolUse', parent: 'a', id: 'r', name: 'Read', input: {}, subagent: null })
    const list = await service.list('c1')
    expect(list).toHaveLength(1)
    expect(list[0]).toMatchObject({ id: 'a', status: 'running', member: 'alice', stepCount: 1, openTools: ['r'] })
    expect(list[0]).not.toHaveProperty('steps')
  })

  it('running entry with no live recorder reads interrupted', async () => {
    const { service } = setup({
      files: { c1: { v: 1, entries: [entry('a', { status: 'running', now: 'Reading', endedAt: null })] } },
      items: { c1: [toolItem('a')] }
    })
    const [s] = await service.list('c1')
    expect(s).toMatchObject({ status: 'interrupted', now: null })
    const got = await service.get('c1', 'a')
    expect(got?.entry.status).toBe('interrupted')
  })

  it('list hides entries whose root tool item is not visible', async () => {
    const { service } = setup({
      files: { c1: { v: 1, entries: [entry('a'), entry('b'), entry('n', { parent: 'b' })] } },
      items: { c1: [toolItem('a')] }
    })
    expect((await service.list('c1')).map((s) => s.id)).toEqual(['a'])
  })

  it('nested entries follow their root', async () => {
    const { service } = setup({
      files: { c1: { v: 1, entries: [entry('a'), entry('n', { parent: 'a' }), entry('m', { parent: 'n' })] } },
      items: { c1: [toolItem('a')] }
    })
    expect((await service.list('c1')).map((s) => s.id)).toEqual(['a', 'n', 'm'])
  })

  it('get from returns only newer steps', async () => {
    const steps: DispatchStep[] = [1, 2, 3].map((i) => ({ kind: 'text', text: `s${i}`, ts: i }))
    const { service } = setup({ files: { c1: { v: 1, entries: [entry('a', { steps })] } }, items: { c1: [toolItem('a')] } })
    expect(await service.get('c1', 'a', 2)).toMatchObject({ from: 2, entry: { steps: [{ text: 's3' }] } })
    expect((await service.get('c1', 'a'))?.entry.steps).toHaveLength(3)
    // Past the end: the whole entry again.
    expect(await service.get('c1', 'a', 9)).toMatchObject({ from: 0 })
    expect(await service.get('c1', 'nope')).toBeNull()
  })

  it('get ignores from for an entry whose middle was dropped', async () => {
    const steps: DispatchStep[] = Array.from({ length: DISPATCH_STEPS_MAX }, (_, i) => ({ kind: 'text', text: `s${i}`, ts: i }))
    steps.splice(50, 0, { kind: 'gap', dropped: 7, ts: 50 })
    const { service } = setup({ files: { c1: { v: 1, entries: [entry('a', { steps })] } }, items: { c1: [toolItem('a')] } })
    const got = await service.get('c1', 'a', 900)
    expect(got?.from).toBe(0)
    expect(got?.entry.steps).toHaveLength(DISPATCH_STEPS_MAX + 1)
  })

  it('finish flushes now, unregisters, and keeps the stored entry', async () => {
    const { service, saves, changed, items } = setup()
    const rec = service.begin('c1', { turn: 'turn-1' })
    rec.event({ kind: 'toolUse', id: 'a', name: 'Agent', input: { description: 'A', prompt: 'p' } })
    rec.end('stopped')
    await service.finish('c1', rec)
    expect(saves).toHaveLength(1)
    expect(saves[0].entries[0].status).toBe('stopped')
    expect(changed).toEqual(['c1'])
    // No timer left behind.
    await vi.advanceTimersByTimeAsync(5000)
    expect(saves).toHaveLength(1)
    items.set('c1', [toolItem('a')])
    expect((await service.list('c1'))[0].status).toBe('stopped')
  })

  it('a store failure does not throw and logs only the code', async () => {
    const { service } = setup({ failSave: true })
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    const rec = service.begin('c1', { turn: 'turn-1' })
    rec.event({ kind: 'toolUse', id: 'a', name: 'Agent', input: { description: 'A', prompt: 'p' } })
    await expect(service.finish('c1', rec)).resolves.toBeUndefined()
    expect(log).toHaveBeenCalled()
    expect(JSON.stringify(log.mock.calls)).not.toContain('/secret/path')
    log.mockRestore()
  })

  it('a chat deleted mid-turn logs nothing', async () => {
    const { service } = setup()
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    const svc = service as unknown as { d: { store: { updateDispatch: unknown } } }
    svc.d.store.updateDispatch = async () => {
      throw new Error('Chat not found: c1')
    }
    const rec = service.begin('c1', { turn: 'turn-1' })
    rec.event({ kind: 'toolUse', id: 'a', name: 'Agent', input: { description: 'A', prompt: 'p' } })
    await service.finish('c1', rec)
    expect(log).not.toHaveBeenCalled()
    log.mockRestore()
  })

  it('reads the chat items and its file once, then follows saved items and its own writes', async () => {
    const { service, reads } = setup({ files: { c1: { v: 1, entries: [entry('a'), entry('b')] } }, items: { c1: [toolItem('a')] } })
    expect((await service.list('c1')).map((s) => s.id)).toEqual(['a'])
    expect((await service.list('c1')).map((s) => s.id)).toEqual(['a'])
    expect(reads).toEqual({ items: 1, dispatch: 1 })
    // A saved item list (a resend, a version switch) changes what is visible without another read.
    service.noteItems('c1', [toolItem('b')])
    expect((await service.list('c1')).map((s) => s.id)).toEqual(['b'])
    const rec = service.begin('c1', { turn: 't2' })
    rec.event({ kind: 'toolUse', id: 'c', name: 'Agent', input: { description: 'C', prompt: 'p' } })
    await service.finish('c1', rec)
    service.noteItems('c1', [toolItem('b'), toolItem('c')])
    expect((await service.list('c1')).map((s) => s.id)).toEqual(['b', 'c'])
    expect(reads).toEqual({ items: 1, dispatch: 1 })
  })

  it('renameAgent also renames stored entries it holds', async () => {
    const { service } = setup({ files: { c1: { v: 1, entries: [entry('a', { member: 'old' })] } }, items: { c1: [toolItem('a')] } })
    expect((await service.list('c1'))[0].member).toBe('old')
    service.renameAgent('old', 'new')
    expect((await service.list('c1'))[0].member).toBe('new')
  })

  it('renameAgent renames live recorders', async () => {
    const { service } = setup()
    const rec = service.begin('c1', { turn: 'turn-1', member: 'old' })
    rec.event({ kind: 'toolUse', id: 'a', name: 'Agent', input: { description: 'A', prompt: 'p' } })
    service.renameAgent('old', 'new')
    expect((await service.list('c1'))[0].member).toBe('new')
  })
})
