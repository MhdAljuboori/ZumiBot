import { describe, expect, it } from 'vitest'
import type { ChatMeta, ChatPr } from '@zumibot/shared/types'
import { BACKOFF, FIRST_MS, GIVE_UP_MS, MAX_MS, PrWatcher } from '../../../src/core/github/prWatcher'
import { watchable } from '../../../src/core/github/pullRequests'

const pending = (n = 1): ChatPr['checks'] => ({ status: 'pending', total: n, pending: n, failing: [] })
const passing = (): ChatPr['checks'] => ({ status: 'passing', total: 1, pending: 0, failing: [] })

const OPEN: ChatPr = { number: 7, url: 'u', state: 'open', branch: 'b', at: 1, checks: pending() }

const meta = (o: Omit<Partial<ChatMeta>, 'pr'> & { pr?: Partial<ChatPr> } = {}): ChatMeta => {
  const { pr, ...rest } = o
  return { id: 'c1', ...rest, ...(pr === undefined ? {} : { pr: { ...OPEN, ...pr } }) } as ChatMeta
}

/** A clock and a timer queue the test drives by hand, so no real time passes. */
function harness(start: ChatMeta) {
  let now = 0
  let chat = start
  const timers: { at: number; fn: () => void; id: number }[] = []
  let nextId = 1
  const reads: number[] = []
  const logs: string[] = []
  let fail: string | null = null
  let onRead: ChatMeta | null = null
  const w = new PrWatcher({
    read: async (chatId) => {
      reads.push(now)
      if (fail !== null) throw Object.assign(new Error(fail), { code: 'EFAIL' })
      // What a real read does: the service writes the new state before the watcher looks again.
      if (onRead !== null) {
        chat = onRead
        onRead = null
      }
      void chatId
    },
    chat: async () => chat,
    setTimer: (fn, ms) => {
      const id = nextId++
      timers.push({ at: now + ms, fn, id })
      return id
    },
    clearTimer: (t) => {
      const i = timers.findIndex((x) => x.id === t)
      if (i >= 0) timers.splice(i, 1)
    },
    now: () => now,
    log: (l) => logs.push(l)
  })
  return {
    watcher: w,
    reads,
    logs,
    at: () => now,
    setChat: (next: ChatMeta) => {
      chat = next
    },
    changeOnRead: (next: ChatMeta) => {
      onRead = next
    },
    setFail: (why: string | null) => {
      fail = why
    },
    /** Runs the one armed timer, moving the clock to its time. Returns how long it waited. */
    async fire(): Promise<number> {
      const t = timers.shift()
      if (!t) throw new Error('no timer armed')
      const waited = t.at - now
      // Never backwards: `skip` may already have moved the clock past this timer's time.
      now = Math.max(now, t.at)
      t.fn()
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
      return waited
    },
    armed: () => timers.length,
    skip: (ms: number) => {
      now += ms
    }
  }
}

describe('watchable', () => {
  it('is true only for an open PR with checks still running in a chat that is not archived', () => {
    expect(watchable(meta({ pr: {} }))).toBe(true)
    expect(watchable(meta({}))).toBe(false)
    expect(watchable(meta({ pr: { checks: passing() } }))).toBe(false)
    expect(watchable(meta({ pr: { state: 'merged' } }))).toBe(false)
    expect(watchable(meta({ pr: {}, archivedAt: 5 }))).toBe(false)
    expect(watchable(meta({ pr: {}, archivedAt: 5, unarchivedAt: 9 }))).toBe(true)
  })
})

describe('PrWatcher', () => {
  it('never looks at a chat with no pull request, or one whose checks are finished', () => {
    const h = harness(meta({}))
    h.watcher.watch(meta({}))
    h.watcher.watch(meta({ pr: { checks: passing() } }))
    expect(h.watcher.size).toBe(0)
    expect(h.armed()).toBe(0)
  })

  it('reads after 15 s and then asks less often while nothing changes, up to two minutes', async () => {
    const h = harness(meta({ pr: {} }))
    h.watcher.watch(meta({ pr: {} }))
    expect(await h.fire()).toBe(FIRST_MS)
    expect(h.reads).toHaveLength(1)
    expect(await h.fire()).toBe(Math.round(FIRST_MS * BACKOFF))
    expect(await h.fire()).toBe(Math.round(Math.round(FIRST_MS * BACKOFF) * BACKOFF))
    let last = 0
    for (let i = 0; i < 12; i++) last = await h.fire()
    expect(last).toBe(MAX_MS)
  })

  it('goes back to reading often as soon as the checks move', async () => {
    const h = harness(meta({ pr: {} }))
    h.watcher.watch(meta({ pr: {} }))
    await h.fire()
    await h.fire() // the delay has backed off once
    h.changeOnRead(meta({ pr: { checks: pending(2) } })) // the next read finds the checks moved
    const waited = await h.fire()
    expect(waited).toBe(Math.round(Math.round(FIRST_MS * BACKOFF) * BACKOFF))
    expect(await h.fire()).toBe(FIRST_MS) // ... and the one after it is soon again
  })

  it('stops the moment the checks finish, the PR is merged, the chat is archived or the chat is gone', async () => {
    for (const next of [meta({ pr: { checks: passing() } }), meta({ pr: { state: 'merged' } }), meta({ pr: {}, archivedAt: 5 })]) {
      const h = harness(meta({ pr: {} }))
      h.watcher.watch(meta({ pr: {} }))
      h.setChat(next)
      await h.fire()
      expect(h.watcher.size).toBe(0)
      expect(h.armed()).toBe(0)
    }
  })

  it('gives up after two hours, leaving Refresh to read on demand', async () => {
    const h = harness(meta({ pr: {} }))
    h.watcher.watch(meta({ pr: {} }))
    await h.fire()
    h.skip(GIVE_UP_MS)
    await h.fire()
    expect(h.watcher.size).toBe(0)
    expect(h.reads).toHaveLength(1) // the round past the limit did not read
  })

  it('keeps watching after a failed read, logging only its code', async () => {
    const h = harness(meta({ pr: {} }))
    h.watcher.watch(meta({ pr: {} }))
    h.setFail('could not reach github.com')
    await h.fire()
    expect(h.watcher.size).toBe(1)
    expect(h.armed()).toBe(1)
    expect(h.logs.join(' ')).toContain('EFAIL')
    expect(h.logs.join(' ')).not.toContain('github.com')
  })

  it('watches one PR once, and stop and stopAll leave nothing armed', async () => {
    const h = harness(meta({ pr: {} }))
    h.watcher.watch(meta({ pr: {} }))
    h.watcher.watch(meta({ pr: {} }))
    expect(h.watcher.size).toBe(1)
    expect(h.armed()).toBe(1)
    h.watcher.stop('c1')
    expect(h.armed()).toBe(0)
    h.watcher.watch(meta({ pr: {} }))
    h.watcher.stopAll()
    expect(h.watcher.size).toBe(0)
    expect(h.armed()).toBe(0)
  })
})
