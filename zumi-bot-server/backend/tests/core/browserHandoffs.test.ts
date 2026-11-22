import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BrowserHandoffs } from '../../src/core/browser/browserHandoffs'
import type { BrowserHandoff } from '../../src/core/browser/types'
const owner = { profileId: 'p', turnId: 't', chatId: 'c' }
const setup = () => {
  const updates: BrowserHandoff[] = []
  let id = 0
  const handoffs = new BrowserHandoffs({
    idleMs: 600000,
    now: Date.now,
    newId: () => `r${++id}`,
    agent: () => 'agent',
    onHandoff: async (h) => {
      updates.push({ ...h })
    }
  })
  return { handoffs, updates }
}
describe('browser handoffs', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())
  it.each(['done', 'cancel'] as const)('settles %s once and validates exact identity', async (decision) => {
    const { handoffs, updates } = setup()
    const pending = handoffs.request(owner, 'g', 'https://example.test/private?secret=x', 'Sign in', new AbortController().signal)
    await vi.advanceTimersByTimeAsync(0)
    expect(updates[0]).toMatchObject({ id: 'r1', site: 'https://example.test', status: 'pending' })
    await expect(handoffs.answer('r1', 'wrong', 'g', decision)).rejects.toThrow()
    await expect(handoffs.answer('r1', 'p', 'old', decision)).rejects.toThrow()
    await expect(handoffs.answer('missing', 'p', 'g', decision)).rejects.toThrow()
    await handoffs.answer('r1', 'p', 'g', decision)
    expect((await pending).ok).toBe(decision === 'done')
    await expect(handoffs.answer('r1', 'p', 'g', decision)).rejects.toThrow()
    expect(updates).toHaveLength(2)
  })
  it('expires after ten unattended minutes, suspending while visible', async () => {
    const { handoffs, updates } = setup()
    const pending = handoffs.request(owner, 'g', '', 'Help', new AbortController().signal)
    await vi.advanceTimersByTimeAsync(500000)
    handoffs.setViewed('p', true)
    await vi.advanceTimersByTimeAsync(900000)
    expect(updates).toHaveLength(1)
    handoffs.setViewed('p', false)
    await vi.advanceTimersByTimeAsync(599999)
    expect(updates).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(await pending).toMatchObject({ ok: false, code: 'handoff_expired' })
  })
  it('interrupts turn requests and aborts without waiting for expiry', async () => {
    const { handoffs } = setup()
    const abort = new AbortController()
    const first = handoffs.request(owner, 'g', '', 'Help', abort.signal)
    abort.abort()
    expect(await first).toMatchObject({ ok: false, code: 'handoff_interrupted' })
    const next = handoffs.request(owner, 'g', '', 'Help', new AbortController().signal)
    await handoffs.endTurn('t')
    expect(await next).toMatchObject({ ok: false, code: 'handoff_interrupted' })
  })
  it('publishes per-turn persistence updates and releases waiters if persistence fails', async () => {
    const { handoffs } = setup()
    const statuses: string[] = []
    handoffs.registerTurn('t', async (handoff) => {
      statuses.push(handoff.status)
      throw new Error('disk unavailable')
    })
    expect(await handoffs.request(owner, 'g', '', 'Help', new AbortController().signal)).toMatchObject({
      ok: false,
      code: 'handoff_interrupted'
    })
    expect(statuses).toEqual(['pending', 'interrupted'])
  })
})
