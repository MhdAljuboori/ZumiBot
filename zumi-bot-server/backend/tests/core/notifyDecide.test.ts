import { describe, expect, it } from 'vitest'
import { DEFAULT_TOGGLES, type NotifyKind, type NotifyToggles } from '@zumibot/shared/notify'
import { kindFor, RATE_CAP, RATE_WINDOW_MS, RateCap } from '../../src/core/notify/decide'

const OFF: NotifyToggles = { waiting: false, replied: false, error: false, routineFailed: false }
const KINDS: NotifyKind[] = ['waiting', 'replied', 'error', 'routine-failed']

describe('kindFor', () => {
  it('off toggles give null', () => {
    for (const k of KINDS) {
      expect(kindFor(OFF, k, null)).toBeNull()
      expect(kindFor(OFF, k, 'turn')).toBeNull()
      expect(kindFor(OFF, k, 'start')).toBeNull()
    }
  })

  it('each chat kind follows its own toggle', () => {
    expect(kindFor(DEFAULT_TOGGLES, 'waiting', null)).toBe('waiting')
    expect(kindFor(DEFAULT_TOGGLES, 'replied', null)).toBe('replied')
    expect(kindFor(DEFAULT_TOGGLES, 'error', null)).toBe('error')
    expect(kindFor({ ...OFF, waiting: true }, 'replied', null)).toBeNull()
    expect(kindFor({ ...OFF, replied: true }, 'replied', null)).toBe('replied')
    expect(kindFor({ ...OFF, error: true }, 'error', null)).toBe('error')
  })

  it('a routine run failed by its turn gives routine-failed, else error, never both', () => {
    expect(kindFor(DEFAULT_TOGGLES, 'routine-failed', 'turn')).toBe('routine-failed')
    expect(kindFor({ ...OFF, routineFailed: true }, 'routine-failed', 'turn')).toBe('routine-failed')
    expect(kindFor({ ...OFF, error: true }, 'routine-failed', 'turn')).toBe('error')
    expect(kindFor(OFF, 'routine-failed', 'turn')).toBeNull()
  })

  it('a routine run that failed before its turn needs the routine-failed toggle', () => {
    expect(kindFor({ ...OFF, routineFailed: true }, 'routine-failed', 'start')).toBe('routine-failed')
    expect(kindFor({ ...OFF, error: true }, 'routine-failed', 'start')).toBeNull()
  })

  it("the user's own action or a restart never notifies", () => {
    expect(kindFor(DEFAULT_TOGGLES, 'routine-failed', 'user')).toBeNull()
    expect(kindFor(DEFAULT_TOGGLES, 'routine-failed', 'restart')).toBeNull()
  })
})

describe('RateCap', () => {
  it('is 10 a minute', () => {
    expect(RATE_CAP).toBe(10)
    expect(RATE_WINDOW_MS).toBe(60_000)
  })

  it('allows 10 replied and refuses the 11th within 60 s', () => {
    let t = 1000
    const cap = new RateCap(() => t)
    for (let i = 0; i < 10; i++) {
      expect(cap.allow('d1', 'replied')).toBe(true)
      t += 1000
    }
    expect(cap.allow('d1', 'replied')).toBe(false)
    expect(cap.allow('d1', 'error')).toBe(false)
    expect(cap.allow('d1', 'routine-failed')).toBe(false)
  })

  it('always allows waiting, and waiting does not count', () => {
    const cap = new RateCap(() => 0)
    for (let i = 0; i < 50; i++) expect(cap.allow('d1', 'waiting')).toBe(true)
    for (let i = 0; i < 10; i++) expect(cap.allow('d1', 'replied')).toBe(true)
    expect(cap.allow('d1', 'replied')).toBe(false)
    expect(cap.allow('d1', 'waiting')).toBe(true)
  })

  it('allows again once the clock passes 60 s', () => {
    let t = 0
    const cap = new RateCap(() => t)
    for (let i = 0; i < 10; i++) cap.allow('d1', 'replied')
    expect(cap.allow('d1', 'replied')).toBe(false)
    t = 59_999
    expect(cap.allow('d1', 'replied')).toBe(false)
    t = 60_000
    expect(cap.allow('d1', 'replied')).toBe(true)
  })

  it('counts each device separately', () => {
    const cap = new RateCap(() => 0)
    for (let i = 0; i < 10; i++) cap.allow('d1', 'replied')
    expect(cap.allow('d1', 'replied')).toBe(false)
    expect(cap.allow('d2', 'replied')).toBe(true)
  })
})
