import { describe, expect, it } from 'vitest'
import { continueText, lastTurn, limitHit, limitStop, resumeTime } from '@zumibot/shared/limitResume'
import type { ChatItem } from '@zumibot/shared/types'

const NOW = 1_000_000
const user = (id: string): ChatItem => ({ type: 'user', id, text: id, ts: 1 })
const limit = (resetsAt: number | null, extra: { agent?: string; compact?: true } = {}): ChatItem => ({
  type: 'error',
  id: `e${resetsAt}${extra.agent ?? ''}`,
  text: 'Claude exited with code 1',
  ts: 2,
  limit: { resetsAt, ...extra }
})

describe('lastTurn', () => {
  it('is the last user message and what came after it', () => {
    const items: ChatItem[] = [user('u1'), { type: 'assistant', id: 'a1', text: 'hi', ts: 2 }, user('u2'), limit(5)]
    expect(lastTurn(items)).toEqual({ message: items[2], items: [items[3]] })
  })

  it('is null without a user message', () => {
    expect(lastTurn([{ type: 'assistant', id: 'a1', text: 'hi', ts: 2 }])).toBeNull()
  })
})

describe('limitHit', () => {
  it('is true when the limit stopped the turn, beside another error or with an unknown reset too', () => {
    expect(limitHit([limit(5)])).toBe(true)
    expect(limitHit([limit(null)])).toBe(true)
    expect(limitHit([limit(5), { type: 'error', id: 'x', text: 'provider failed', ts: 2 }])).toBe(true)
  })

  it("is false with no limit error, or only a compaction's", () => {
    expect(limitHit([{ type: 'assistant', id: 'a', text: 'done', ts: 1 }])).toBe(false)
    expect(limitHit([{ type: 'error', id: 'x', text: 'provider failed', ts: 2 }])).toBe(false)
    expect(limitHit([limit(5, { compact: true })])).toBe(false)
  })
})

describe('limitStop', () => {
  it('returns the limits when they are the only errors', () => {
    expect(limitStop([{ type: 'assistant', id: 'a', text: "You've hit your limit", ts: 1 }, limit(5)])).toEqual([{ resetsAt: 5 }])
  })

  it('is null with no error, an unknown reset or another error beside the limit', () => {
    expect(limitStop([{ type: 'assistant', id: 'a', text: 'done', ts: 1 }])).toBeNull()
    expect(limitStop([limit(null)])).toBeNull()
    expect(limitStop([limit(5), { type: 'error', id: 'x', text: 'provider failed', ts: 2 }])).toBeNull()
  })

  it("leaves a compact out: alone it never continues, beside the turn's own limit it does not block it", () => {
    expect(limitStop([{ type: 'assistant', id: 'a', text: 'done', ts: 1 }, limit(5, { compact: true })])).toBeNull()
    expect(limitStop([limit(5), limit(9, { compact: true })])).toEqual([{ resetsAt: 5 }])
  })
})

describe('resumeTime', () => {
  it('is a minute past the last reset', () => {
    expect(resumeTime([{ resetsAt: NOW + 10_000 }, { resetsAt: NOW + 20_000 }], NOW)).toBe(NOW + 80_000)
  })

  it('is a few seconds out when the reset already passed', () => {
    expect(resumeTime([{ resetsAt: NOW - 3_600_000 }], NOW)).toBe(NOW + 5_000)
  })
})

describe('continueText', () => {
  it('is plain continue in a single chat', () => {
    expect(continueText([{ resetsAt: 5 }])).toBe('continue')
  })

  it('names each stopped room member once', () => {
    expect(
      continueText([
        { resetsAt: 5, agent: 'alpha' },
        { resetsAt: 6, agent: 'beta' },
        { resetsAt: 7, agent: 'alpha' }
      ])
    ).toBe('@alpha @beta continue')
  })
})
