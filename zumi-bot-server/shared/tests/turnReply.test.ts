import { describe, expect, it } from 'vitest'
import { turnOutcome } from '@zumibot/shared/turnReply'
import type { ChatItem, NoticeKind } from '@zumibot/shared/types'

const user = (id: string): ChatItem => ({ type: 'user', id, text: id, ts: 1 })
const said = (id: string, text: string): ChatItem => ({ type: 'assistant', id, text, ts: 2 })
const tool = (id: string): ChatItem => ({ type: 'tool', id, name: 'Bash', input: {}, result: 'ok', isError: false, blocked: false, ts: 3 })
const notice = (kind: NoticeKind): ChatItem => ({ type: 'notice', id: `n-${kind}`, kind, text: kind, ts: 4 })
const error = (id: string, text: string, resetsAt?: number | null): ChatItem => ({
  type: 'error',
  id,
  text,
  ts: 5,
  ...(resetsAt !== undefined ? { limit: { resetsAt } } : {})
})

describe('turnOutcome', () => {
  it('reply is last assistant text of the turn', () => {
    const items = [user('u1'), said('a0', 'earlier exchange'), user('u2'), said('a1', 'looking'), tool('t1'), said('a2', 'pong')]
    expect(turnOutcome(items, 'u2')).toEqual({
      over: false,
      items: items.slice(3),
      reply: 'pong',
      error: null,
      limit: [],
      kind: 'ok'
    })
    // No text of its own: null, never an earlier exchange's.
    expect(turnOutcome([user('u1'), said('a0', 'earlier'), user('u2'), tool('t1')], 'u2')).toMatchObject({ reply: null, kind: 'ok' })
    expect(turnOutcome(items, 'missing')).toBeNull()
    // Only a user item counts as the message.
    expect(turnOutcome(items, 'a1')).toBeNull()
  })

  it('kind from notices in routine order', () => {
    const kindOf = (...tail: ChatItem[]) => turnOutcome([user('u'), ...tail], 'u')!.kind
    expect(kindOf(error('e', 'boom'), notice('userPaused'), notice('stopped'))).toBe('error')
    expect(kindOf(notice('stopped'), notice('userPaused'))).toBe('paused')
    expect(kindOf(notice('interrupted'), notice('stopped'))).toBe('stopped')
    expect(kindOf(said('a', 'half'), notice('interrupted'))).toBe('interrupted')
    expect(kindOf(said('a', 'done'), notice('expired'))).toBe('ok')
    // The hop cap's notice is a capped turn, not the user's pause; an error still wins.
    expect(kindOf(said('a', 'half'), notice('paused'))).toBe('capped')
    expect(kindOf(error('e', 'boom'), notice('paused'))).toBe('error')
    expect(kindOf(notice('userPaused'))).toBe('paused')
    expect(turnOutcome([user('u'), said('a', 'half'), notice('paused')], 'u')).toMatchObject({ kind: 'capped', reply: 'half' })

    const failed = turnOutcome([user('u'), error('e1', 'first'), error('e2', 'second')], 'u')!
    expect(failed).toMatchObject({ kind: 'error', error: 'first', limit: [] })
    // The limit counts only when it is all that went wrong.
    const limited = turnOutcome([user('u'), said('a', 'hit it'), error('e1', 'limit', 5000)], 'u')!
    expect(limited).toMatchObject({ kind: 'error', error: 'limit', limit: [{ resetsAt: 5000 }], reply: 'hit it' })
    expect(turnOutcome([user('u'), error('e1', 'limit', 5000), error('e2', 'boom')], 'u')).toMatchObject({ limit: [] })
    expect(turnOutcome([user('u'), error('e1', 'limit', null)], 'u')).toMatchObject({ limit: [{ resetsAt: null }] })
  })

  it('over when a later user item exists', () => {
    const items = [user('u1'), said('a1', 'first'), notice('stopped'), user('u2'), said('a2', 'second')]
    expect(turnOutcome(items, 'u1')).toEqual({
      over: true,
      items: [items[1], items[2]],
      reply: 'first',
      error: null,
      limit: [],
      kind: 'stopped'
    })
    expect(turnOutcome(items, 'u2')).toMatchObject({ over: false, reply: 'second', kind: 'ok' })
    expect(turnOutcome([user('u1')], 'u1')).toEqual({ over: false, items: [], reply: null, error: null, limit: [], kind: 'ok' })
  })
})
