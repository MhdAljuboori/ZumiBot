import { describe, expect, it } from 'vitest'
import { CLONE_TITLE_MAX, HANDOFF_MAX_CHARS, UNTITLED_ROOM, nextCopyTitle } from '@zumibot/shared/roomClone'

describe('room clone constants', () => {
  it('has the agreed limits', () => {
    expect(HANDOFF_MAX_CHARS).toBe(12_000)
    expect(CLONE_TITLE_MAX).toBe(200)
    expect(UNTITLED_ROOM).toBe('Room')
  })
})

describe('nextCopyTitle', () => {
  it('adds (2) to a fresh title', () => {
    expect(nextCopyTitle('API room', [])).toBe('API room (2)')
  })

  it('skips taken numbers', () => {
    expect(nextCopyTitle('API room', ['API room (2)', 'API room (3)'])).toBe('API room (4)')
  })

  it('bumps a trailing (n) instead of stacking', () => {
    expect(nextCopyTitle('API room (2)', [])).toBe('API room (3)')
    expect(nextCopyTitle('API room (2)', ['API room (3)'])).toBe('API room (4)')
  })

  it('trims the title first', () => {
    expect(nextCopyTitle('  API room  ', [])).toBe('API room (2)')
  })

  it('falls back to Room for an empty title', () => {
    expect(nextCopyTitle('', [])).toBe('Room (2)')
    expect(nextCopyTitle('   ', [])).toBe('Room (2)')
  })

  it('cuts the base so the whole result fits', () => {
    const long = 'x'.repeat(CLONE_TITLE_MAX)
    const out = nextCopyTitle(long, [])
    expect(out.length).toBeLessThanOrEqual(CLONE_TITLE_MAX)
    expect(out.endsWith(' (2)')).toBe(true)
    const again = nextCopyTitle(out, [])
    expect(again.length).toBeLessThanOrEqual(CLONE_TITLE_MAX)
    expect(again.endsWith(' (3)')).toBe(true)
  })

  it('skips taken candidates when the base was cut', () => {
    const long = 'x'.repeat(CLONE_TITLE_MAX)
    const first = nextCopyTitle(long, [])
    expect(nextCopyTitle(long, [first])).not.toBe(first)
  })
})
