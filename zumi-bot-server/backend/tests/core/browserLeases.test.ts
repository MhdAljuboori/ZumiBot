import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BrowserLeases } from '../../src/core/browser/browserLeases'
const owner = (turnId: string, profileId = 'p') => ({ turnId, profileId, chatId: 'chat' })
const signal = () => new AbortController().signal
const tick = () => vi.advanceTimersByTimeAsync(0)
describe('browser turn leases', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())
  it('changes epoch only on a new ownership period, including same-turn reacquisition', async () => {
    const leases = new BrowserLeases({ leaseIdleMs: 120000, queueMs: 120000 })
    const first = await leases.acquire(owner('a'), signal())
    first.release()
    const uninterrupted = await leases.acquire(owner('a'), signal())
    uninterrupted.release()
    expect(uninterrupted.epoch).toBe(first.epoch)
    leases.release(owner('a'))
    const released = await leases.acquire(owner('a'), signal())
    released.release()
    expect(released.epoch).toBeGreaterThan(first.epoch)
    await vi.advanceTimersByTimeAsync(120000)
    const expired = await leases.acquire(owner('a'), signal())
    expired.release()
    expect(expired.epoch).toBeGreaterThan(released.epoch)
    leases.close()
  })
  it('keeps multi-command turns exclusive until release', async () => {
    const leases = new BrowserLeases({ leaseIdleMs: 120000, queueMs: 120000 })
    const first = await leases.acquire(owner('a'), signal())
    first.release()
    let acquired = false
    const second = leases.acquire(owner('b'), signal()).then((done) => {
      acquired = true
      return done
    })
    const again = await leases.acquire(owner('a'), signal())
    again.release()
    expect(acquired).toBe(false)
    leases.release(owner('a'))
    ;(await second).release()
  })
  it('expires inactivity but never releases an active command', async () => {
    const leases = new BrowserLeases({ leaseIdleMs: 120000, queueMs: 300000 })
    const done = await leases.acquire(owner('a'), signal())
    let acquired = false
    const next = leases.acquire(owner('b'), signal()).then((release) => {
      acquired = true
      return release
    })
    await vi.advanceTimersByTimeAsync(120000)
    expect(acquired).toBe(false)
    done.release()
    await vi.advanceTimersByTimeAsync(119999)
    expect(acquired).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    ;(await next).release()
  })
  it('pause drains the command and blocks subsequent observations until resumed', async () => {
    const leases = new BrowserLeases({ leaseIdleMs: 120000, queueMs: 120000 })
    const done = await leases.acquire(owner('a'), signal())
    let paused = false,
      ran = false
    const pause = leases.pause('p').then(() => {
      paused = true
    })
    const next = leases.acquire(owner('a'), signal()).then((release) => {
      ran = true
      return release
    })
    await tick()
    expect(paused).toBe(false)
    done.release()
    await pause
    expect(ran).toBe(false)
    leases.resume('p')
    ;(await next).release()
  })
  it('expires and cancels queued work without later granting it', async () => {
    const leases = new BrowserLeases({ leaseIdleMs: 120000, queueMs: 120000 })
    const done = await leases.acquire(owner('a'), signal())
    const abort = new AbortController()
    const cancelled = leases.acquire(owner('b'), abort.signal)
    const expired = leases.acquire(owner('c'), signal())
    const checkCancelled = expect(cancelled).rejects.toThrow('cancelled')
    const checkExpired = expect(expired).rejects.toThrow('timed out')
    abort.abort()
    await vi.advanceTimersByTimeAsync(120000)
    await checkCancelled
    await checkExpired
    done.release()
    leases.release(owner('a'))
    ;(await leases.acquire(owner('d'), signal())).release()
  })
  it('ending a turn rejects its waiters while another profile progresses', async () => {
    const leases = new BrowserLeases({ leaseIdleMs: 120000, queueMs: 120000 })
    const done = await leases.acquire(owner('a'), signal())
    const waiting = leases.acquire(owner('b'), signal())
    const check = expect(waiting).rejects.toThrow('ended')
    leases.endTurn('b')
    await check
    ;(await leases.acquire(owner('c', 'q'), signal())).release()
    done.release()
    leases.endTurn('a')
    await expect(leases.acquire(owner('a'), signal())).rejects.toThrow('ended')
  })
  it('does not rearm ownership timers when an invalidated active command finishes', async () => {
    const leases = new BrowserLeases({ leaseIdleMs: 120000, queueMs: 120000 })
    const done = await leases.acquire(owner('a'), signal())
    leases.invalidate('p')
    done.release()
    expect(vi.getTimerCount()).toBe(0)
    await expect(leases.acquire(owner('b'), signal())).rejects.toThrow('invalidated')
  })
  it('an untimed waiter outlasts a pause that a plain waiter times out in, then is granted on resume', async () => {
    const leases = new BrowserLeases({ leaseIdleMs: 120000, queueMs: 1000 })
    await leases.pause('p')
    let granted = false
    const untimed = leases.acquire(owner('a'), signal(), { untimedWhilePaused: true }).then((lease) => {
      granted = true
      return lease
    })
    const plain = expect(leases.acquire(owner('a'), signal())).rejects.toThrow('timed out')
    await vi.advanceTimersByTimeAsync(10000)
    await plain
    expect(granted).toBe(false)
    leases.resume('p')
    ;(await untimed).release()
    leases.close()
  })
  it("a pause stops an untimed waiter's queue limit and resume starts it again", async () => {
    const leases = new BrowserLeases({ leaseIdleMs: 120000, queueMs: 1000 })
    const holder = await leases.acquire(owner('a'), signal())
    let failed = false
    const untimed = leases.acquire(owner('b'), signal(), { untimedWhilePaused: true }).catch((error: Error) => {
      failed = true
      throw error
    })
    await vi.advanceTimersByTimeAsync(900)
    const pause = leases.pause('p')
    holder.release()
    await pause
    await vi.advanceTimersByTimeAsync(5000)
    expect(failed).toBe(false)
    // Owner a keeps the lease between commands, so b still waits, now with a fresh limit.
    leases.resume('p')
    await vi.advanceTimersByTimeAsync(999)
    expect(failed).toBe(false)
    const check = expect(untimed).rejects.toThrow('timed out')
    await vi.advanceTimersByTimeAsync(1)
    await check
    leases.close()
  })
  it('reports the end of every ownership period, and only that', async () => {
    const released: string[] = []
    const leases = new BrowserLeases({ leaseIdleMs: 120000, queueMs: 120000, onRelease: (id) => released.push(id) })
    ;(await leases.acquire(owner('a'), signal())).release()
    // Between commands the turn still owns the browser.
    expect(released).toEqual([])
    leases.release(owner('a'))
    expect(released).toEqual(['p'])
    ;(await leases.acquire(owner('a'), signal())).release()
    await vi.advanceTimersByTimeAsync(120000)
    expect(released).toEqual(['p', 'p'])
    ;(await leases.acquire(owner('b'), signal())).release()
    leases.endTurn('b')
    expect(released).toEqual(['p', 'p', 'p'])
    // A turn that ends mid-command lets go once the command finishes.
    const active = await leases.acquire(owner('c'), signal())
    leases.endTurn('c')
    expect(released).toHaveLength(3)
    active.release()
    expect(released).toHaveLength(4)
    // Protected while a card waits: its own idle expiry, once unprotected, ends it too.
    const held = await leases.acquire(owner('d'), signal())
    held.release()
    const unprotect = leases.protect(owner('d'))
    await vi.advanceTimersByTimeAsync(240000)
    expect(released).toHaveLength(4)
    unprotect()
    await vi.advanceTimersByTimeAsync(120000)
    expect(released).toHaveLength(5)
    ;(await leases.acquire(owner('e', 'q'), signal())).release()
    leases.invalidate('q')
    expect(released).toEqual(['p', 'p', 'p', 'p', 'p', 'q'])
    // Nobody owned it any more: nothing ends twice.
    leases.invalidate('q')
    leases.release(owner('e', 'q'))
    expect(released).toHaveLength(6)
    leases.close()
  })
})
