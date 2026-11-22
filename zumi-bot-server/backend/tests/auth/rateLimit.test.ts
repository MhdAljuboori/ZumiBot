import { describe, expect, it } from 'vitest'
import { createLimiter } from '../../src/auth/rateLimit'

function setup() {
  let t = 1_000_000
  const lim = createLimiter({ now: () => t })
  return { lim, advance: (ms: number) => (t += ms) }
}
const fail = (lim: ReturnType<typeof createLimiter>, n: number, ip = '1.1.1.1') => {
  for (let i = 0; i < n; i++) lim.fail(ip)
}

describe('rate limiter', () => {
  it('after 2 failures still allowed', () => {
    const { lim } = setup()
    fail(lim, 2)
    expect(lim.check('1.1.1.1')).toEqual({ allowed: true, retryAfterMs: 0 })
  })

  it('after the 3rd, retryAfterMs is 1000', () => {
    const { lim } = setup()
    fail(lim, 3)
    expect(lim.check('1.1.1.1')).toEqual({ allowed: false, retryAfterMs: 1000 })
  })

  it('the wait counts down and then allows', () => {
    const { lim, advance } = setup()
    fail(lim, 3)
    advance(400)
    expect(lim.check('1.1.1.1').retryAfterMs).toBe(600)
    advance(600)
    expect(lim.check('1.1.1.1').allowed).toBe(true)
  })

  it('after the 4th, 2000', () => {
    const { lim } = setup()
    fail(lim, 4)
    expect(lim.check('1.1.1.1').retryAfterMs).toBe(2000)
  })

  it('after the 9th, the cap 60000', () => {
    const { lim } = setup()
    fail(lim, 9)
    expect(lim.check('1.1.1.1')).toEqual({ allowed: false, retryAfterMs: 60000 })
  })

  it('the 10th failure locks for 900000', () => {
    const { lim, advance } = setup()
    fail(lim, 10)
    expect(lim.check('1.1.1.1')).toEqual({ allowed: false, retryAfterMs: 900000 })
    advance(899_999)
    expect(lim.check('1.1.1.1').allowed).toBe(false)
  })

  it('the lock is per IP (another IP allowed)', () => {
    const { lim } = setup()
    fail(lim, 10)
    expect(lim.check('2.2.2.2')).toEqual({ allowed: true, retryAfterMs: 0 })
  })

  it('success clears', () => {
    const { lim } = setup()
    fail(lim, 5)
    lim.succeed('1.1.1.1')
    expect(lim.check('1.1.1.1').allowed).toBe(true)
    fail(lim, 2)
    expect(lim.check('1.1.1.1').allowed).toBe(true)
  })

  it('failures older than 15 min drop out', () => {
    const { lim, advance } = setup()
    fail(lim, 9)
    advance(15 * 60_000 + 1)
    expect(lim.check('1.1.1.1').allowed).toBe(true)
    lim.fail('1.1.1.1')
    lim.fail('1.1.1.1')
    expect(lim.check('1.1.1.1').allowed).toBe(true)
  })

  it('failures recorded after the 10th keep the IP blocked past the first lock expiry', () => {
    const { lim, advance } = setup()
    fail(lim, 10)
    advance(10 * 60_000)
    fail(lim, 10)
    advance(5 * 60_000 + 1)
    expect(lim.check('1.1.1.1').allowed).toBe(false)
  })

  it('the lock survives failures 1-9 ageing out', () => {
    const { lim, advance } = setup()
    fail(lim, 9)
    advance(14 * 60_000)
    lim.fail('1.1.1.1')
    advance(60_000 + 1)
    // the first 9 are gone from the window but the 10th set a lock lasting 15 min
    expect(lim.check('1.1.1.1').allowed).toBe(false)
    advance(14 * 60_000)
    expect(lim.check('1.1.1.1').allowed).toBe(true)
  })

  it('a burst of 25 failures stays blocked until the window really clears', () => {
    const { lim, advance } = setup()
    fail(lim, 10)
    advance(10 * 60_000)
    fail(lim, 15)
    advance(5 * 60_000 + 1)
    expect(lim.check('1.1.1.1').allowed).toBe(false)
    advance(10 * 60_000)
    expect(lim.check('1.1.1.1').allowed).toBe(true)
  })

  it('success clears a locked IP', () => {
    const { lim } = setup()
    fail(lim, 12)
    lim.succeed('1.1.1.1')
    expect(lim.check('1.1.1.1').allowed).toBe(true)
  })

  it('sweeps idle IPs so the map stays bounded', () => {
    const { lim, advance } = setup()
    for (let i = 0; i < 300; i++) lim.fail(`10.0.${i >> 8}.${i & 255}`)
    expect(lim.size()).toBe(300)
    advance(15 * 60_000 + 1)
    for (let i = 0; i < 200; i++) lim.check('9.9.9.9')
    expect(lim.size()).toBe(0)
  })
})
