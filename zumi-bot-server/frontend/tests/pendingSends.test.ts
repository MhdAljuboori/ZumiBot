import { describe, expect, it } from 'vitest'
import { failSend, isSending, retried, unconfirmed, unqueued, type PendingSend } from '../src/state/pendingSends'
import type { ChatItem } from '@zumibot/shared/types'

type UserItem = Extract<ChatItem, { type: 'user' }>
const user = (id: string, text: string): UserItem => ({ type: 'user', id, text, ts: 1 })
const sending = (id: string, text = id): PendingSend => ({ item: user(id, text), error: null })

describe('pending sends', () => {
  it('shows a sent message until the items hold its id', () => {
    const p = sending('m1', 'hi')
    expect(unconfirmed([user('u1', 'hi')], [p])).toEqual([p])
    expect(unconfirmed([user('u1', 'hi'), user('m1', 'hi')], [p])).toEqual([])
  })

  it('a failed message stays, with why', () => {
    const list = failSend([sending('m1'), sending('m2')], 'm1', 'Chat is already running')
    expect(list[0]).toEqual({ item: user('m1', 'm1'), error: 'Chat is already running' })
    expect(list[1].error).toBeNull()
    expect(unconfirmed([], list)).toEqual(list)
  })

  it('is sending while one is on its way, not when all failed', () => {
    expect(isSending([sending('m1')])).toBe(true)
    expect(isSending(failSend([sending('m1')], 'm1', 'x'))).toBe(false)
    expect(isSending([])).toBe(false)
  })

  it('a resend of a failed text replaces the failed copy; other messages stay', () => {
    const list = [...failSend([sending('m1', 'hi'), sending('m2', 'other')], 'm1', 'x'), sending('m3', 'hi')]
    expect(retried(list, 'hi').map((p) => p.item.id)).toEqual(['m2', 'm3'])
  })

  it('a message the server queued shows only as its task', () => {
    const list = [sending('m1'), sending('m2')]
    expect(unqueued(list, [{ id: 'm1', text: 'm1', ts: 1 }]).map((p) => p.item.id)).toEqual(['m2'])
    expect(unqueued(list, undefined)).toEqual(list)
  })
})
