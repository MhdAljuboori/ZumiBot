import { describe, expect, it } from 'vitest'
import type { ChatItem, QueuedTask } from '@zumibot/shared/types'
import { newer, older, sentTexts } from '../src/state/promptHistory'

const user = (id: string, text: string): ChatItem => ({ type: 'user', id, text, ts: 1 })
const agent = (id: string, text: string): ChatItem => ({ type: 'assistant', id, text, ts: 1 })
const task = (id: string, text: string): QueuedTask => ({ id, text, ts: 1 })

describe('sentTexts', () => {
  it('lists the user messages oldest first, then the queued ones, skipping agent items and blank texts', () => {
    const items = [user('1', 'first'), agent('2', 'reply'), user('3', '  '), user('4', 'second')]
    expect(sentTexts(items, [task('t', 'queued')])).toEqual(['first', 'second', 'queued'])
  })

  it('keeps a repeated message once where it was sent last', () => {
    expect(sentTexts([user('1', 'again'), user('2', 'other'), user('3', 'again')])).toEqual(['other', 'again'])
  })
})

describe('older and newer', () => {
  const history = ['one', 'two', 'three']

  it('walks back from the newest, saving the draft, and stops at the oldest', () => {
    const a = older(history, null, 'typed')
    expect(a).toEqual({ browse: { index: 2, saved: 'typed', shown: 'three' }, text: 'three' })
    const b = older(history, a!.browse, 'three')
    expect(b).toEqual({ browse: { index: 1, saved: 'typed', shown: 'two' }, text: 'two' })
    const c = older(history, b!.browse, 'two')
    expect(c?.text).toBe('one')
    expect(older(history, c!.browse, 'one')).toBeNull()
  })

  it('walks forward and gives the saved draft back past the newest', () => {
    const at = { index: 1, saved: 'typed', shown: 'two' }
    const next = newer(history, at, 'two')
    expect(next).toEqual({ browse: { index: 2, saved: 'typed', shown: 'three' }, text: 'three' })
    expect(newer(history, next!.browse, 'three')).toEqual({ browse: null, text: 'typed' })
  })

  it('does nothing forward when not browsing', () => {
    expect(newer(history, null, 'typed')).toBeNull()
  })

  it('treats an edited recalled message as a new draft, so the edit comes back on the way down', () => {
    const at = { index: 0, saved: '', shown: 'one' }
    expect(newer(history, at, 'one edited')).toBeNull()
    expect(older(history, at, 'one edited')?.browse).toEqual({ index: 2, saved: 'one edited', shown: 'three' })
  })

  it('skips the newest message when the box already holds it', () => {
    expect(older(history, null, 'three')?.text).toBe('two')
  })

  it('starts over when the history moved under the recalled message', () => {
    const stale = { index: 0, saved: '', shown: 'zero' }
    expect(older(history, stale, 'zero')?.browse).toEqual({ index: 2, saved: 'zero', shown: 'three' })
  })

  it('has nothing to recall from an empty history', () => {
    expect(older([], null, '')).toBeNull()
  })
})
