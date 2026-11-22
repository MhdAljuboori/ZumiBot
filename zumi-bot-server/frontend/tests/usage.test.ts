import { describe, expect, it } from 'vitest'
import type { ClaudeAccount } from '@zumibot/shared/types'
import { codexRows, duration, percentUsed, resetLabel, sessionPercent, updatedLabel } from '../src/state/usage'

const MIN = 60_000
const HOUR = 60 * MIN
const now = Date.parse('2026-10-25T12:00:00Z')

describe('percentUsed', () => {
  it('rounds and clamps to 0–100', () => {
    expect(percentUsed({ percent: 28.999999999999996, resetsAt: null }, now)).toBe(29)
    expect(percentUsed({ percent: 104, resetsAt: now + HOUR }, now)).toBe(100)
    expect(percentUsed({ percent: -1, resetsAt: null }, now)).toBe(0)
  })
  it('is 0 once the limit has reset', () => {
    expect(percentUsed({ percent: 42, resetsAt: now }, now)).toBe(0)
  })
})

describe('duration', () => {
  it('reads as hours and minutes, rounded up to the minute', () => {
    expect(duration(2 * HOUR + 30 * MIN + 5_000)).toBe('2 hr 31 min')
    expect(duration(3 * HOUR)).toBe('3 hr')
    expect(duration(45 * MIN)).toBe('45 min')
    expect(duration(5_000)).toBe('1 min')
  })
})

describe('resetLabel', () => {
  it('says how long until a reset, or when it is', () => {
    expect(resetLabel({ percent: 33, resetsAt: now + 2 * HOUR + 31 * MIN }, now, 'in')).toBe('Resets in 2 hr 31 min')
    expect(resetLabel({ percent: 15, resetsAt: Date.parse('2026-10-31T10:00:00Z') }, now, 'at', 'UTC')).toBe('Resets Sat 10:00 AM')
  })
  it('is empty when unknown and says Reset once passed', () => {
    expect(resetLabel({ percent: 1, resetsAt: null }, now, 'in')).toBe('')
    expect(resetLabel({ percent: 1, resetsAt: now - 1 }, now, 'at')).toBe('Reset')
  })
})

describe('updatedLabel', () => {
  it('says how old the reading is', () => {
    expect(updatedLabel(now - 30_000, now)).toBe('Updated just now')
    expect(updatedLabel(now - 5 * MIN, now)).toBe('Updated 5 min ago')
    expect(updatedLabel(now - 3 * HOUR, now)).toBe('Updated 3 hr ago')
    expect(updatedLabel(now - 25 * HOUR, now)).toBe('Updated 1 day ago')
    expect(updatedLabel(now - 50 * HOUR, now)).toBe('Updated 2 days ago')
  })
})

describe('sessionPercent', () => {
  const account = (usage: ClaudeAccount['usage']): ClaudeAccount => ({ name: 'me', email: null, plan: 'Max', usage })
  it('is null when nothing is known', () => {
    expect(sessionPercent(null, now)).toBeNull()
    expect(sessionPercent(account(null), now)).toBeNull()
    expect(sessionPercent(account({ session: null, weekly: null, updatedAt: now }), now)).toBeNull()
  })
  it('is the session window percent, 0 once it reset', () => {
    const session = { percent: 28.6, resetsAt: now + HOUR }
    expect(sessionPercent(account({ session, weekly: null, updatedAt: now }), now)).toBe(percentUsed(session, now))
    expect(sessionPercent(account({ session: { percent: 40, resetsAt: now }, weekly: null, updatedAt: now }), now)).toBe(0)
  })
})

describe('codexRows', () => {
  const account = (codex?: ClaudeAccount['codex']): ClaudeAccount => ({
    name: 'me',
    email: null,
    plan: 'Max',
    usage: null,
    ...(codex ? { codex } : {})
  })
  it('is none without a Codex reading, or one with no window', () => {
    expect(codexRows(null)).toEqual([])
    expect(codexRows(account())).toEqual([])
    expect(codexRows(account({ session: null, weekly: null, updatedAt: now }))).toEqual([])
  })
  it('is a session and a weekly row, each only when its window is known', () => {
    const session = { percent: 14, resetsAt: now + HOUR }
    const weekly = { percent: 19, resetsAt: now + 24 * HOUR }
    expect(codexRows(account({ session, weekly, updatedAt: now }))).toEqual([
      { key: 'session', label: 'Session limit', window: session, style: 'in' },
      { key: 'weekly', label: 'Weekly limit', window: weekly, style: 'at' }
    ])
    expect(codexRows(account({ session: null, weekly, updatedAt: now })).map((r) => r.key)).toEqual(['weekly'])
  })
  it('leaves the Claude ring alone', () => {
    const codex = { session: { percent: 90, resetsAt: now + HOUR }, weekly: null, updatedAt: now }
    expect(sessionPercent(account(codex), now)).toBeNull()
  })
})
