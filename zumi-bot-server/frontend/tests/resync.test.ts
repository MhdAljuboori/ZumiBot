import { describe, expect, it } from 'vitest'
import { createGate, isNotConnected, pendingFromItems } from '../src/state/resync'
import type { ChatItem } from '@zumibot/shared/types'

describe('createGate', () => {
  it('only the latest request is current', () => {
    const g = createGate()
    const a = g.next()
    const b = g.next()
    expect(g.isCurrent(a)).toBe(false)
    expect(g.isCurrent(b)).toBe(true)
  })
  it('keeps gates per key', () => {
    const g = createGate()
    const a = g.next('x')
    g.next('y')
    expect(g.isCurrent(a, 'x')).toBe(true)
  })
})

describe('isNotConnected', () => {
  it('matches only the exact reconnect error', () => {
    expect(isNotConnected(new Error('Not connected. Reconnecting…'))).toBe(true)
    expect(isNotConnected(new Error('boom'))).toBe(false)
    expect(isNotConnected('Not connected. Reconnecting…')).toBe(true)
  })
})

describe('pendingFromItems', () => {
  it('counts pending approval items only', () => {
    const items = [
      { type: 'approval', id: '1', status: 'pending' },
      { type: 'approval', id: '2', status: 'denied' },
      { type: 'user', id: '3', text: 'x', ts: 1 },
      { type: 'approval', id: '4', status: 'pending' }
    ] as unknown as ChatItem[]
    expect(pendingFromItems(items)).toBe(2)
  })
  it('pendingFromItems counts pending handoffs', () => {
    const items = [
      { type: 'approval', id: '1', status: 'pending' },
      { type: 'browser-action', id: '2', ts: 1, agent: 'ops', handoff: { id: 'h1', status: 'pending' } },
      { type: 'browser-action', id: '3', ts: 2, agent: 'ops', surface: 'desktop', handoff: { id: 'h2', status: 'pending' } }
    ] as unknown as ChatItem[]
    expect(pendingFromItems(items)).toBe(3)
  })
  it('ignores done handoffs', () => {
    const items = (['done', 'cancelled', 'expired', 'interrupted'] as const).map((status, i) => ({
      type: 'browser-action',
      id: String(i),
      ts: i,
      agent: 'ops',
      handoff: { id: `h${i}`, status }
    })) as unknown as ChatItem[]
    expect(pendingFromItems(items)).toBe(0)
  })
  it('counts a pending vault approval like an approval', () => {
    const items = [
      { type: 'vault-approval', id: 'v1', request: { status: 'pending' } },
      { type: 'vault-approval', id: 'v2', request: { status: 'allowed' } }
    ] as unknown as ChatItem[]
    expect(pendingFromItems(items)).toBe(1)
  })
})
