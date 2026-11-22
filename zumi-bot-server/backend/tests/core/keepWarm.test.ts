import { beforeEach, expect, it } from 'vitest'
import { KEEP_WARM_EVERY_MS, KEEP_WARM_MIN_TOKENS, KeepWarm, type KeepWarmDeps } from '../../src/core/btw/keepWarm'

const H = 3_600_000
let now: number
let timers: { at: number; fn: () => void; cleared: boolean }[]
let warmed: string[]
let touched: string[]
let running: Set<string>
let rooms: Set<string>
let hours: { roomHours: number; chatHours: number }
let warmResult: boolean
let gone: Set<string>

const make = (o: Partial<KeepWarmDeps> = {}) =>
  new KeepWarm({
    settings: async () => hours,
    chat: async (id) => (gone.has(id) ? null : { room: rooms.has(id), archived: false, asked: false }),
    isRunning: (id) => running.has(id),
    warm: async (chatId, agent) => {
      warmed.push(`${chatId}:${agent}`)
      return warmResult
    },
    warmed: (chatId, agent, at) => {
      touched.push(`${chatId}:${agent}@${at}`)
    },
    now: () => now,
    setTimer: (fn, ms) => {
      const t = { at: now + ms, fn, cleared: false }
      timers.push(t)
      return {
        clear: () => {
          t.cleared = true
        }
      }
    },
    ...o
  })

// Fires every live timer due by `to`, oldest first, moving the clock to each.
async function advance(to: number) {
  for (;;) {
    const due = timers.filter((t) => !t.cleared && t.at <= to).sort((a, b) => a.at - b.at)[0]
    if (!due) break
    due.cleared = true
    now = due.at
    due.fn()
    for (let i = 0; i < 20; i++) await Promise.resolve()
  }
  now = to
}

beforeEach(() => {
  now = 0
  timers = []
  warmed = []
  touched = []
  running = new Set()
  rooms = new Set(['room'])
  gone = new Set()
  hours = { roomHours: 12, chatHours: 2 }
  warmResult = true
})

it('pings a big idle room member just before its cache expires, and again until the room window ends', async () => {
  const kw = make()
  kw.note('room', 'ui', 400_000, 0)
  await advance(KEEP_WARM_EVERY_MS - 1)
  expect(warmed).toEqual([])
  await advance(12 * H + KEEP_WARM_EVERY_MS)
  // 12 h of idle time, a ping every 55 min, none after the window.
  expect(warmed.length).toBe(Math.floor((12 * H) / KEEP_WARM_EVERY_MS))
  expect(warmed.every((w) => w === 'room:ui')).toBe(true)
  expect(touched[0]).toBe(`room:ui@${KEEP_WARM_EVERY_MS}`)
})

it('keeps a single chat warm for the shorter chat window', async () => {
  const kw = make()
  kw.note('solo', 'helper', 300_000, 0)
  await advance(24 * H)
  expect(warmed.length).toBe(Math.floor((2 * H) / KEEP_WARM_EVERY_MS))
})

it('new activity restarts the window, and a compaction or a small context stops the pings', async () => {
  const kw = make()
  kw.note('room', 'ui', 400_000, 0)
  await advance(KEEP_WARM_EVERY_MS)
  expect(warmed).toHaveLength(1)
  kw.note('room', 'ui', null, now) // compacted: the size is unknown until the next request
  await advance(5 * H)
  expect(warmed).toHaveLength(1)
  kw.note('room', 'ui', KEEP_WARM_MIN_TOKENS - 1, now)
  await advance(10 * H)
  expect(warmed).toHaveLength(1)
})

it('does nothing when the window is off', async () => {
  hours = { roomHours: 0, chatHours: 0 }
  const kw = make()
  kw.note('room', 'ui', 400_000, 0)
  kw.note('solo', 'helper', 400_000, 0)
  await advance(24 * H)
  expect(warmed).toEqual([])
})

it('skips a running chat (its own requests keep the cache) and tries again later', async () => {
  const kw = make()
  kw.note('room', 'ui', 400_000, 0)
  running.add('room')
  await advance(KEEP_WARM_EVERY_MS)
  expect(warmed).toEqual([])
  running.delete('room')
  await advance(2 * KEEP_WARM_EVERY_MS)
  expect(warmed).toEqual(['room:ui'])
})

it('stops after a failed ping, and for a chat that is gone', async () => {
  warmResult = false
  const kw = make()
  kw.note('room', 'ui', 400_000, 0)
  await advance(5 * H)
  expect(warmed).toEqual(['room:ui'])
  expect(touched).toEqual([])
  warmResult = true
  gone.add('solo')
  kw.note('solo', 'helper', 400_000, now)
  await advance(now + 5 * H)
  expect(warmed).toEqual(['room:ui'])
})

it('never warms an archived or asked chat', async () => {
  const kw = make({ chat: async (id) => ({ room: false, archived: id === 'old', asked: id === 'ab' }) })
  kw.note('old', 'a', 400_000, 0)
  kw.note('ab', 'b', 400_000, 0)
  await advance(5 * H)
  expect(warmed).toEqual([])
})

it('runs at most two pings at once', async () => {
  let release!: () => void
  const gate = new Promise<void>((r) => {
    release = r
  })
  let inFlight = 0,
    most = 0
  const kw = make({
    warm: async () => {
      inFlight++
      most = Math.max(most, inFlight)
      await gate
      inFlight--
      return true
    }
  })
  for (const m of ['a', 'b', 'c', 'd']) kw.note('room', m, 400_000, 0)
  await advance(KEEP_WARM_EVERY_MS)
  expect(most).toBe(2)
  release()
  await advance(KEEP_WARM_EVERY_MS + 1)
  expect(most).toBe(2)
})

it('stop clears every timer, and forget drops one chat', async () => {
  const kw = make()
  kw.note('room', 'ui', 400_000, 0)
  kw.note('solo', 'helper', 400_000, 0)
  kw.forget('solo')
  await advance(KEEP_WARM_EVERY_MS)
  expect(warmed).toEqual(['room:ui'])
  kw.stop()
  await advance(10 * H)
  expect(warmed).toEqual(['room:ui'])
})
