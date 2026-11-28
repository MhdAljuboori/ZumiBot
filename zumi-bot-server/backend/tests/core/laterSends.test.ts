import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import { join } from 'node:path'
import { LATER_GONE, LATER_MAX, laterFullText } from '@zumibot/shared/later'
import type { ChatPush } from '@zumibot/shared/types'
import { ChatStore } from '../../src/core/store/chatStore'
import { LaterSends, type LaterSendsDeps } from '../../src/core/chat/laterSends'

let dir: string
let store: ChatStore
let now: number
let n: number
let timers: { fn: () => void; ms: number; cleared: boolean }[]
let pushes: ChatPush[]
let logs: string[]
let send: ReturnType<typeof vi.fn<LaterSendsDeps['send']>>
let later: LaterSends

const make = () =>
  new LaterSends({
    store,
    send,
    push: (p) => pushes.push(p),
    now: () => now,
    newId: () => `l${++n}`,
    setTimer: (fn, ms) => {
      const t = { fn, ms, cleared: false }
      timers.push(t)
      return { clear: () => (t.cleared = true) }
    },
    log: (l) => logs.push(l)
  })

const flush = async () => {
  for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r))
}
const live = () => timers.filter((t) => !t.cleared)
const fireAll = async () => {
  for (const t of live()) t.fn()
  await flush()
}

beforeEach(async () => {
  dir = await fs.mkdtemp(join(os.tmpdir(), 'later-'))
  store = new ChatStore(dir)
  now = 1_000_000
  n = 0
  timers = []
  pushes = []
  logs = []
  send = vi.fn<LaterSendsDeps['send']>(async () => {})
  later = make()
})
afterEach(async () => {
  later.stop()
  await fs.rm(dir, { recursive: true, force: true })
})

describe('LaterSends', () => {
  it('stores soonest first, keeps the sidebar order and arms each', async () => {
    const c = await store.create('alpha', dir)
    const b = await later.add(c.id, now + 7200_000, 'second')
    const a = await later.add(c.id, now + 3600_000, 'first')
    const meta = await store.get(c.id)
    expect(meta?.later?.map((l) => l.text)).toEqual(['first', 'second'])
    expect(meta?.updatedAt).toBe(c.updatedAt)
    expect(a).toEqual({ id: 'l2', at: now + 3600_000, text: 'first', createdAt: now })
    expect(b.id).toBe('l1')
    expect(live().map((t) => t.ms)).toEqual([7200_000, 3600_000])
    expect(pushes.filter((p) => p.kind === 'meta')).toHaveLength(2)
  })

  it('refuses one past the cap', async () => {
    const c = await store.create('alpha', dir)
    for (let i = 0; i < LATER_MAX; i++) await later.add(c.id, now + 60_000, `m${i}`)
    await expect(later.add(c.id, now + 60_000, 'one more')).rejects.toThrow(laterFullText)
    expect((await store.get(c.id))?.later).toHaveLength(LATER_MAX)
  })

  it('sends at its time under its own id, then removes it', async () => {
    const c = await store.create('alpha', dir)
    const item = await later.add(c.id, now + 60_000, 'check CI')
    await fireAll()
    expect(send).toHaveBeenCalledTimes(1)
    expect(send).toHaveBeenCalledWith(c.id, 'check CI', item.at, item.id)
    expect((await store.get(c.id))?.later).toBeUndefined()
  })

  it('cancel stops it; a second cancel says it is gone', async () => {
    const c = await store.create('alpha', dir)
    const item = await later.add(c.id, now + 60_000, 'check CI')
    const timer = timers[0]!
    await later.cancel(c.id, item.id)
    expect(timer.cleared).toBe(true)
    timer.fn() // a timer that fired anyway finds nothing
    await flush()
    expect(send).not.toHaveBeenCalled()
    expect((await store.get(c.id))?.later).toBeUndefined()
    await expect(later.cancel(c.id, item.id)).rejects.toThrow(LATER_GONE)
  })

  it('send now goes once, and the timer then finds nothing', async () => {
    const c = await store.create('alpha', dir)
    const item = await later.add(c.id, now + 60_000, 'check CI')
    const timer = timers[0]!
    await later.sendNow(c.id, item.id)
    timer.fn()
    await flush()
    expect(send).toHaveBeenCalledTimes(1)
    expect(timer.cleared).toBe(true)
    await expect(later.sendNow(c.id, item.id)).rejects.toThrow(LATER_GONE)
  })

  it('a refused send now keeps it stored and armed', async () => {
    const c = await store.create('alpha', dir)
    const item = await later.add(c.id, now + 60_000, 'check CI')
    send.mockRejectedValueOnce(new Error('A chat can hold at most 50 queued messages'))
    await expect(later.sendNow(c.id, item.id)).rejects.toThrow('at most 50')
    expect((await store.get(c.id))?.later).toHaveLength(1)
    expect(live()).toHaveLength(1)
  })

  it('a send refused at its time is logged and dropped, never retried in a loop', async () => {
    const c = await store.create('alpha', dir)
    await later.add(c.id, now + 60_000, 'check CI')
    send.mockRejectedValueOnce(new Error('nope'))
    await fireAll()
    expect(logs.join('\n')).toContain('nope')
    expect((await store.get(c.id))?.later).toBeUndefined()
    expect(timers).toHaveLength(1) // not armed again
  })

  it('recover arms stored ones, a missed one at once', async () => {
    const c = await store.create('alpha', dir)
    await store.patchInPlace(c.id, () => ({
      later: [
        { id: 'a', at: now - 5000, text: 'missed', createdAt: 1 },
        { id: 'b', at: now + 60_000, text: 'ahead', createdAt: 1 }
      ]
    }))
    await later.recover()
    expect(live().map((t) => t.ms)).toEqual([0, 60_000])
    live()[0]!.fn()
    await flush()
    expect(send).toHaveBeenCalledWith(c.id, 'missed', now - 5000, 'a')
    expect((await store.get(c.id))?.later?.map((l) => l.id)).toEqual(['b'])
  })

  it('stop holds them: nothing goes, and they stay stored', async () => {
    const c = await store.create('alpha', dir)
    const timerFn = (await later.add(c.id, now + 60_000, 'check CI')) && timers[0]!.fn
    later.stop()
    expect(live()).toHaveLength(0)
    timerFn()
    await flush()
    expect(send).not.toHaveBeenCalled()
    expect((await store.get(c.id))?.later).toHaveLength(1)
    await expect(later.add(c.id, now + 60_000, 'x')).rejects.toThrow('shutting down')
  })

  it('a deleted chat is no failure', async () => {
    const c = await store.create('alpha', dir)
    await later.add(c.id, now + 60_000, 'check CI')
    await store.remove(c.id)
    await fireAll()
    expect(send).not.toHaveBeenCalled()
    expect(logs).toEqual([])
  })
})
