import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { SideDeadline } from '../../src/core/btw/sideDeadline'

let expired: ReturnType<typeof vi.fn<() => void>>
const deadline = () => new SideDeadline({ limitMs: 180_000, capMs: 360_000, now: () => Date.now(), onExpire: expired })

beforeEach(() => {
  vi.useFakeTimers()
  expired = vi.fn<() => void>()
})
afterEach(() => vi.useRealTimers())

test('fires at limitMs with no pause', async () => {
  deadline()
  await vi.advanceTimersByTimeAsync(179_999)
  expect(expired).not.toHaveBeenCalled()
  await vi.advanceTimersByTimeAsync(1)
  expect(expired).toHaveBeenCalledOnce()
  await vi.advanceTimersByTimeAsync(600_000)
  expect(expired).toHaveBeenCalledOnce()
})

test('a 60 s pause moves it 60 s later', async () => {
  const d = deadline()
  await vi.advanceTimersByTimeAsync(100_000)
  const resume = d.pause()
  await vi.advanceTimersByTimeAsync(60_000)
  resume()
  await vi.advanceTimersByTimeAsync(79_999)
  expect(expired).not.toHaveBeenCalled()
  await vi.advanceTimersByTimeAsync(1)
  expect(expired).toHaveBeenCalledOnce()
})

test('a pause that would cross capMs fires at capMs', async () => {
  const d = deadline()
  await vi.advanceTimersByTimeAsync(100_000)
  d.pause()
  await vi.advanceTimersByTimeAsync(259_999)
  expect(expired).not.toHaveBeenCalled()
  await vi.advanceTimersByTimeAsync(1)
  expect(expired).toHaveBeenCalledOnce()
})

test('the cap holds after a resume too', async () => {
  const d = deadline()
  await vi.advanceTimersByTimeAsync(10_000)
  const resume = d.pause()
  await vi.advanceTimersByTimeAsync(300_000)
  resume()
  // 10 s counted, but only 50 s of wall time are left.
  await vi.advanceTimersByTimeAsync(49_999)
  expect(expired).not.toHaveBeenCalled()
  await vi.advanceTimersByTimeAsync(1)
  expect(expired).toHaveBeenCalledOnce()
})

test('nested pauses resume only when the last one ends, and a resume runs once', async () => {
  const d = deadline()
  await vi.advanceTimersByTimeAsync(170_000)
  const first = d.pause(),
    second = d.pause()
  await vi.advanceTimersByTimeAsync(30_000)
  first()
  first()
  await vi.advanceTimersByTimeAsync(30_000)
  expect(expired).not.toHaveBeenCalled()
  second()
  await vi.advanceTimersByTimeAsync(9_999)
  expect(expired).not.toHaveBeenCalled()
  await vi.advanceTimersByTimeAsync(1)
  expect(expired).toHaveBeenCalledOnce()
})

test('clear() stops it, and a pause after clear is harmless', async () => {
  const d = deadline()
  const resume = d.pause()
  d.clear()
  resume()
  d.pause()()
  await vi.advanceTimersByTimeAsync(600_000)
  expect(expired).not.toHaveBeenCalled()
  expect(vi.getTimerCount()).toBe(0)
})
