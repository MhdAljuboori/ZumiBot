import { describe, expect, it } from 'vitest'
import { isUnread, markOn } from '@zumibot/shared/unread'

describe('isUnread', () => {
  it('is false for an old chat with no times', () => {
    expect(isUnread({})).toBe(false)
  })
  it('is false with no reply', () => {
    expect(isUnread({ seenAt: 5 })).toBe(false)
  })
  it('is true for a reply never seen', () => {
    expect(isUnread({ replyAt: 5 })).toBe(true)
  })
  it('is false when seen in the same write', () => {
    expect(isUnread({ replyAt: 5, seenAt: 5 })).toBe(false)
  })
  it('is true when the reply is newer than the seen time', () => {
    expect(isUnread({ replyAt: 6, seenAt: 5 })).toBe(true)
  })
  it('is false when seen after the reply', () => {
    expect(isUnread({ replyAt: 5, seenAt: 6 })).toBe(false)
  })
})

describe('a mark set by the user', () => {
  it('makes a read chat unread while it is past seenAt', () => {
    expect(isUnread({ replyAt: 5, seenAt: 6, mark: { at: 7, from: 4 } })).toBe(true)
  })
  it('counts for an old chat with no reply time', () => {
    expect(isUnread({ mark: { at: 7, from: 4 } })).toBe(true)
  })
  it('is cleared by a later seenAt (an open on another machine, after a sync)', () => {
    expect(markOn({ seenAt: 8, mark: { at: 7, from: 4 } })).toBe(false)
    expect(isUnread({ replyAt: 5, seenAt: 8, mark: { at: 7, from: 4 } })).toBe(false)
  })
  it('is off when there is none', () => {
    expect(markOn({ seenAt: 8 })).toBe(false)
  })
})
