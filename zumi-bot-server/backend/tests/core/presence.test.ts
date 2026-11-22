import { beforeEach, describe, expect, it } from 'vitest'
import { DROP_GRACE_MS, INPUT_CHATS_KEPT, Presence } from '../../src/core/notify/presence'

function harness() {
  let t = 5000
  const started: string[] = []
  const stopped: string[] = []
  const opened: [string, number][] = []
  const timers: { fn: () => void; at: number; cleared: boolean }[] = []
  const p = new Presence({
    now: () => t,
    setTimer: (fn, ms) => {
      const e = { fn, at: t + ms, cleared: false }
      timers.push(e)
      return {
        clear: () => {
          e.cleared = true
        }
      }
    },
    onStarted: (c) => started.push(c),
    onStopped: (c) => stopped.push(c),
    onOpened: (c, at) => opened.push([c, at])
  })
  const advance = (ms: number) => {
    t += ms
    for (const e of timers.filter((x) => !x.cleared && x.at <= t)) {
      e.cleared = true
      e.fn()
    }
  }
  return {
    p,
    started,
    stopped,
    opened,
    timers,
    advance,
    setNow: (n: number) => {
      t = n
    }
  }
}

const look = (chatId: string | null, o: { deviceId?: string; looking?: boolean; inputAgoMs?: number; openedAgoMs?: number } = {}) => ({
  deviceId: o.deviceId ?? 'd1',
  chatId,
  looking: o.looking ?? true,
  inputAgoMs: o.inputAgoMs ?? 0,
  ...(o.openedAgoMs === undefined ? {} : { openedAgoMs: o.openedAgoMs })
})

describe('Presence', () => {
  let h: ReturnType<typeof harness>
  beforeEach(() => {
    h = harness()
  })

  it('looking at a chat fires onStarted once', () => {
    h.p.update('c1', look('x'))
    h.p.update('c1', look('x'))
    expect(h.p.lookingAt('x')).toBe(true)
    expect(h.started).toEqual(['x'])
    expect(h.stopped).toEqual([])
  })

  it('moving chats stops the old and starts the new', () => {
    h.p.update('c1', look('x'))
    h.p.update('c1', look('y'))
    expect(h.stopped).toEqual(['x'])
    expect(h.started).toEqual(['x', 'y'])
    expect(h.p.lookingAt('x')).toBe(false)
    expect(h.p.lookingAt('y')).toBe(true)
  })

  it('looking:false or no chat stops', () => {
    h.p.update('c1', look('x'))
    h.p.update('c1', look('x', { looking: false }))
    expect(h.stopped).toEqual(['x'])
    h.p.update('c1', look('x'))
    h.p.update('c1', look(null))
    expect(h.stopped).toEqual(['x', 'x'])
  })

  it('onStopped waits for the last looking connection', () => {
    h.p.update('c1', look('x'))
    h.p.update('c2', look('x', { deviceId: 'd2' }))
    expect(h.started).toEqual(['x'])
    h.p.update('c1', look('x', { looking: false }))
    expect(h.stopped).toEqual([])
    expect(h.p.lookingAt('x')).toBe(true)
    h.p.update('c2', look('x', { deviceId: 'd2', looking: false }))
    expect(h.stopped).toEqual(['x'])
  })

  it('each looking report tells when its page opened the chat, on the server clock', () => {
    h.p.update('c1', look('x', { openedAgoMs: 300 }))
    h.p.update('c1', look('x', { openedAgoMs: 40_300, inputAgoMs: 10 }))
    expect(h.opened).toEqual([
      ['x', 4700],
      ['x', 4700 - 40_000]
    ])
  })

  it('a report that is not looking, or from a page that sends no open time, tells no open', () => {
    h.p.update('c1', look('x', { looking: false, openedAgoMs: 300 }))
    h.p.update('c1', look(null, { openedAgoMs: 300 }))
    h.p.update('c1', look('x'))
    expect(h.opened).toEqual([])
  })

  it('not looking never starts', () => {
    h.p.update('c1', look('x', { looking: false }))
    expect(h.started).toEqual([])
    expect(h.p.lookingAt('x')).toBe(false)
  })

  it('inputSince compares the input time with t', () => {
    h.p.update('c1', look('x', { inputAgoMs: 2000 }))
    expect(h.p.inputSince('x', 1000)).toBe(true)
    expect(h.p.inputSince('x', 3000)).toBe(false)
    expect(h.p.inputSince('x', 4000)).toBe(false)
    // The connection's own value follows its latest report, but the kept per-chat time is never lowered.
    h.p.update('c1', look('x', { inputAgoMs: 4500 }))
    expect(h.p.inputSince('x', 1000)).toBe(true)
    expect(h.p.inputSince('x', 3000)).toBe(false)
  })

  it('inputSince only counts connections on that chat, looking or not', () => {
    h.p.update('c1', look('x', { looking: false, inputAgoMs: 0 }))
    expect(h.p.inputSince('x', 1000)).toBe(true)
    expect(h.p.inputSince('y', 1000)).toBe(false)
    h.p.update('c1', look('y', { looking: false, inputAgoMs: 0 }))
    expect(h.p.inputSince('x', 1000)).toBe(false)
  })

  it('drop reports the stop only after the grace', () => {
    h.p.update('c1', look('x'))
    h.p.drop('c1')
    expect(h.stopped).toEqual([])
    h.advance(DROP_GRACE_MS - 1)
    expect(h.stopped).toEqual([])
    h.advance(1)
    expect(h.stopped).toEqual(['x'])
    expect(h.p.lookingAt('x')).toBe(false)
    expect(h.p.deviceOf('c1')).toBeNull()
  })

  it('DROP_GRACE_MS is 10 seconds', () => {
    expect(DROP_GRACE_MS).toBe(10_000)
  })

  it('another connection looking within the grace keeps it quiet', () => {
    h.p.update('c1', look('x'))
    h.p.drop('c1')
    h.advance(3000)
    h.p.update('c2', look('x'))
    h.advance(DROP_GRACE_MS)
    expect(h.stopped).toEqual([])
    expect(h.started).toEqual(['x'])
    expect(h.p.lookingAt('x')).toBe(true)
  })

  it('the same connection reporting again cancels the drop', () => {
    h.p.update('c1', look('x'))
    h.p.drop('c1')
    h.advance(3000)
    h.p.update('c1', look('x'))
    h.advance(DROP_GRACE_MS * 2)
    expect(h.stopped).toEqual([])
    expect(h.p.lookingAt('x')).toBe(true)
    expect(h.p.deviceOf('c1')).toBe('d1')
  })

  it('a second drop does not stack timers', () => {
    h.p.update('c1', look('x'))
    h.p.drop('c1')
    h.p.drop('c1')
    expect(h.timers.filter((x) => !x.cleared)).toHaveLength(1)
    h.advance(DROP_GRACE_MS)
    expect(h.stopped).toEqual(['x'])
  })

  it('dropping a connection that was not looking calls nothing', () => {
    h.p.update('c1', look('x', { looking: false }))
    h.p.drop('c1')
    h.advance(DROP_GRACE_MS * 2)
    expect(h.started).toEqual([])
    expect(h.stopped).toEqual([])
    expect(h.p.deviceOf('c1')).toBeNull()
  })

  it('dropping an unknown connection is a no-op', () => {
    h.p.drop('nope')
    expect(h.timers).toHaveLength(0)
    expect(h.stopped).toEqual([])
  })

  it('a dropped connection is gone from lookups at once', () => {
    h.p.update('c1', look('x'))
    h.p.drop('c1')
    expect(h.p.deviceOf('c1')).toBeNull()
    expect(h.p.connsOf('d1')).toEqual([])
    // Its input while looking is still kept for the chat.
    expect(h.p.inputSince('x', 0)).toBe(true)
    expect(h.p.inputSince('x', 5000)).toBe(false)
  })

  it('connsOf lists connections oldest first, deviceOf maps back', () => {
    h.p.update('c1', look('x'))
    h.p.update('c2', look(null, { looking: false }))
    h.p.update('c3', look('y', { deviceId: 'd2' }))
    h.p.update('c1', look('z'))
    expect(h.p.connsOf('d1')).toEqual(['c1', 'c2'])
    expect(h.p.connsOf('d2')).toEqual(['c3'])
    expect(h.p.connsOf('d9')).toEqual([])
    expect(h.p.deviceOf('c2')).toBe('d1')
    expect(h.p.deviceOf('zz')).toBeNull()
  })

  it('the device id of a connection can change, the last wins', () => {
    h.p.update('c1', look('x', { deviceId: 'd1' }))
    h.p.update('c1', look('x', { deviceId: 'd2' }))
    expect(h.p.deviceOf('c1')).toBe('d2')
    expect(h.p.connsOf('d1')).toEqual([])
    expect(h.p.connsOf('d2')).toEqual(['c1'])
  })

  it('lookedAt records the last time each chat was looked at', () => {
    h.p.update('c1', look('x'))
    expect(h.p.lookedAt()).toEqual({ x: 5000 })
    h.advance(2000)
    h.p.update('c1', look('x'))
    expect(h.p.lookedAt()).toEqual({ x: 7000 })
    h.advance(1000)
    h.p.update('c1', look('x', { looking: false }))
    expect(h.p.lookedAt()).toEqual({ x: 8000 })
    h.advance(5000)
    expect(h.p.lookedAt()).toEqual({ x: 8000 })
  })

  it('lookedAt is stamped when the drop grace ends', () => {
    h.p.update('c1', look('x'))
    h.p.drop('c1')
    h.advance(DROP_GRACE_MS)
    expect(h.p.lookedAt()).toEqual({ x: 5000 + DROP_GRACE_MS })
  })

  it('lookedAt returns a copy', () => {
    h.p.update('c1', look('x'))
    h.p.lookedAt().x = 1
    expect(h.p.lookedAt()).toEqual({ x: 5000 })
  })

  describe('input after a connection leaves the chat', () => {
    // Typed at x at 6000 (a looking report with no idle time), last seen there before at 5000.
    function typedAtX() {
      h.p.update('c1', look('x', { inputAgoMs: 0 }))
      h.advance(1000)
      h.p.update('c1', look('x', { inputAgoMs: 0 }))
      h.advance(1000)
    }

    it('still counts after the connection moves to another chat', () => {
      typedAtX()
      h.p.update('c1', look('y', { inputAgoMs: 0 }))
      expect(h.p.inputSince('x', 5500)).toBe(true)
      expect(h.p.inputSince('x', 6000)).toBe(false)
    })

    it('still counts after the connection reports looking:false', () => {
      typedAtX()
      h.p.update('c1', look(null, { looking: false, inputAgoMs: 5000 }))
      expect(h.p.inputSince('x', 5500)).toBe(true)
      expect(h.p.inputSince('x', 6000)).toBe(false)
    })

    it('still counts after the connection is dropped', () => {
      typedAtX()
      h.p.drop('c1')
      h.advance(DROP_GRACE_MS)
      expect(h.p.connsOf('d1')).toEqual([])
      expect(h.p.inputSince('x', 5500)).toBe(true)
      expect(h.p.inputSince('x', 6000)).toBe(false)
    })

    it('a report that is not looking does not count for the chat after it leaves', () => {
      h.p.update('c1', look('x', { looking: false, inputAgoMs: 0 }))
      h.p.update('c1', look('y', { inputAgoMs: 0 }))
      expect(h.p.inputSince('x', 4000)).toBe(false)
    })

    it('a later report with older input does not lower the kept time', () => {
      h.p.update('c1', look('x', { inputAgoMs: 0 })) // input at 5000
      h.advance(1000)
      h.p.update('c2', look('x', { inputAgoMs: 4000 })) // a stale tab: input at 2000
      h.p.update('c1', look(null, { looking: false }))
      h.p.update('c2', look(null, { looking: false }))
      expect(h.p.inputSince('x', 4000)).toBe(true)
      expect(h.p.inputSince('x', 5000)).toBe(false)
    })

    it('a report with newer input raises the kept time', () => {
      h.p.update('c1', look('x', { inputAgoMs: 3000 })) // input at 2000
      h.advance(1000)
      h.p.update('c2', look('x', { inputAgoMs: 0 })) // input at 6000
      h.p.update('c1', look(null, { looking: false }))
      h.p.update('c2', look(null, { looking: false }))
      expect(h.p.inputSince('x', 5500)).toBe(true)
      expect(h.p.inputSince('x', 6000)).toBe(false)
    })

    it(`keeps the input of at most ${INPUT_CHATS_KEPT} chats, dropping the oldest`, () => {
      expect(INPUT_CHATS_KEPT).toBe(500)
      for (let i = 0; i <= INPUT_CHATS_KEPT; i++) {
        h.p.update('c1', look(`chat${i}`, { inputAgoMs: 0 }))
        h.advance(1)
      }
      h.p.update('c1', look(null, { looking: false }))
      expect(h.p.inputSince('chat0', 0)).toBe(false)
      expect(h.p.inputSince('chat1', 0)).toBe(true)
      expect(h.p.inputSince(`chat${INPUT_CHATS_KEPT}`, 0)).toBe(true)
    })
  })
})
