import { describe, expect, it } from 'vitest'
import { failureMessage, quietRejection, rejectedSendState, shouldRestoreDraft } from '../src/state/sendFailure'
import type { ChatItem } from '@zumibot/shared/types'

const user = (id: string, text: string): ChatItem => ({ type: 'user', id, text, ts: 1 })

describe('shouldRestoreDraft', () => {
  it('restores when the send never produced a user item and the box is empty', () => {
    expect(shouldRestoreDraft([user('a', 'old')], 1, 'hello', '')).toBe(true)
  })

  it('does not restore when a user item with that exact text was added since the send started', () => {
    expect(shouldRestoreDraft([user('a', 'old'), user('b', 'hello')], 1, 'hello', '')).toBe(false)
  })

  it('ignores an identical user item that was already in the history before the send', () => {
    expect(shouldRestoreDraft([user('a', 'hello')], 1, 'hello', '')).toBe(true)
  })

  it('does not restore over text the user typed meanwhile', () => {
    expect(shouldRestoreDraft([], 0, 'hello', 'new text')).toBe(false)
  })

  it('restores when the box still shows the sent text (rejected before the clearing render)', () => {
    expect(shouldRestoreDraft([], 0, 'hello', 'hello')).toBe(true)
  })
})

describe('rejectedSendState', () => {
  const task = { id: 'm1', text: 'hello', ts: 1 }
  it('is stored when the items hold its id, even if a task does too', () => {
    expect(rejectedSendState([user('m1', 'hello')], 'm1', [task])).toBe('stored')
  })
  it('is queued when only a task holds its id', () => {
    expect(rejectedSendState([user('a', 'hello')], 'm1', [task])).toBe('queued')
  })
  it('is lost when neither holds it', () => {
    expect(rejectedSendState([user('a', 'hello')], 'm1', undefined)).toBe('lost')
  })
})

describe('failureMessage', () => {
  it('is just the error when the draft was restored', () => {
    expect(failureMessage('boom', 'hello', true)).toBe('boom')
  })

  it('appends the unsent message when it was not restored', () => {
    expect(failureMessage('boom', 'hello', false)).toBe('boom\nYour message was: hello')
  })

  it('truncates a long message to about 200 characters', () => {
    const msg = failureMessage('boom', 'x'.repeat(500), false)
    expect(msg.length).toBeLessThan(260)
    expect(msg.endsWith('…')).toBe(true)
  })
})

describe('quietRejection', () => {
  it('stays quiet when only the socket dropped under a stored message: its turn runs on and replies after the reconnect', () => {
    expect(quietRejection('stored', true)).toBe(true)
  })
  it('stays quiet for a queued message, whose task row holds it', () => {
    expect(quietRejection('queued', false)).toBe(true)
    expect(quietRejection('queued', true)).toBe(true)
  })
  it('reports a stored message whose turn really failed', () => {
    expect(quietRejection('stored', false)).toBe(false)
  })
  it('reports a message that never reached the chat, even when the socket was down', () => {
    expect(quietRejection('lost', true)).toBe(false)
    expect(quietRejection('lost', false)).toBe(false)
  })
})

describe('rejectedSendState with steers', () => {
  it('treats a message still waiting in the running reply as queued', () => {
    expect(rejectedSendState([], 's-1', [], [{ id: 's-1', text: 'x', ts: 1 }])).toBe('queued')
    expect(rejectedSendState([], 's-2', [], [{ id: 's-1', text: 'x', ts: 1 }])).toBe('lost')
  })
})
