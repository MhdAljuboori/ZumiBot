import { describe, expect, it } from 'vitest'
import { barTitle, pendingElsewhere } from '../src/state/mobileBar'

describe('barTitle', () => {
  it('names the open chat, or New chat while it has no title', () => {
    expect(barTitle('chat', { title: 'Fix the build' }, false, [])).toBe('Fix the build')
    expect(barTitle('chat', { title: '' }, false, [])).toBe('New chat')
  })
  it('writes agent handles in the title as display names', () => {
    expect(barTitle('chat', { title: 'ask @code-reviewer' }, false, [{ name: 'code-reviewer' }])).toBe('ask @Code Reviewer')
  })
  it('names the editor and the new-chat screens', () => {
    expect(barTitle('editor', undefined, false, [])).toBe('Agent Studio')
    expect(barTitle('empty', undefined, false, [])).toBe('New chat')
    expect(barTitle('empty', undefined, true, [])).toBe('New group chat')
    expect(barTitle('start', undefined, false, [])).toBe('New chat')
  })
  it('falls back to New chat while the open chat is not loaded', () => {
    expect(barTitle('chat', undefined, true, [])).toBe('New chat')
  })
})

describe('pendingElsewhere', () => {
  it('is true only for a chat other than the open one with a pending approval', () => {
    expect(pendingElsewhere({}, null)).toBe(false)
    expect(pendingElsewhere({ a: 1 }, 'a')).toBe(false)
    expect(pendingElsewhere({ a: 1 }, 'b')).toBe(true)
    expect(pendingElsewhere({ a: 1 }, null)).toBe(true)
    expect(pendingElsewhere({ a: 0 }, null)).toBe(false)
  })
})
