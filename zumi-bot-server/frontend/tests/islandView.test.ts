import { describe, expect, it } from 'vitest'
import type { ChatMeta } from '@zumibot/shared/types'
import { islandOpenAsk, islandTargetOf, recentRows, sameTarget, shortAgo } from '../src/state/islandView'

const baseChat: ChatMeta = { id: '', agentName: 'w', sessionId: null, cwd: '/w', title: 't', createdAt: 0, updatedAt: 0, inFlight: false }
const c = (id: string, extra: Partial<ChatMeta> = {}): ChatMeta => ({ ...baseChat, id, updatedAt: Number(id.slice(1)), ...extra })

describe('shortAgo', () => {
  it('reads now, minutes, hours, days and weeks', () => {
    const now = 100 * 24 * 3_600_000
    expect(shortAgo(now - 30_000, now)).toBe('now')
    expect(shortAgo(now - 5 * 60_000, now)).toBe('5m')
    expect(shortAgo(now - 2 * 3_600_000, now)).toBe('2h')
    expect(shortAgo(now - 3 * 24 * 3_600_000, now)).toBe('3d')
    expect(shortAgo(now - 15 * 24 * 3_600_000, now)).toBe('2w')
  })
  it('never goes negative when the clocks disagree', () => {
    expect(shortAgo(10_000, 5_000)).toBe('now')
  })
})

describe('recentRows', () => {
  it('lists the newest chats with their title, age, current flag and marks', () => {
    const chats = [c('c1', { title: '' }), c('c2', { replyAt: 5, seenAt: 1 }), c('c3', { inFlight: true })]
    const rows = recentRows(chats, 'w', { c1: 2 }, 'c2', 3_000_000, [])
    expect(rows.map((r) => r.id)).toEqual(['c3', 'c2', 'c1'])
    expect(rows[0]).toMatchObject({ title: 't', current: false, marks: { working: true, waiting: 0, unread: false } })
    expect(rows[1]).toMatchObject({ current: true, marks: { working: false, waiting: 0, unread: true } })
    expect(rows[2]).toMatchObject({ title: 'New chat', marks: { waiting: 2 } })
  })
})

describe('recentRows titles', () => {
  it('writes agent handles in a title as display names', () => {
    const rows = recentRows([c('c1', { title: 'ask @code-reviewer' })], 'w', {}, null, 0, [{ name: 'code-reviewer' }])
    expect(rows[0].title).toBe('ask @Code Reviewer')
  })
})

describe('islandTargetOf', () => {
  const chats = [c('c1'), c('c2', { agentName: 'o' }), c('c3', { group: { members: [] } as never })]
  it('remembers the new-chat state and a chat of the agent', () => {
    expect(islandTargetOf({ kind: 'empty' }, chats, 'w')).toEqual({ kind: 'new' })
    expect(islandTargetOf({ kind: 'chat', chatId: 'c1' }, chats, 'w')).toEqual({ kind: 'chat', chatId: 'c1' })
  })
  it('remembers nothing for another agent, a room, an unknown chat or another view', () => {
    expect(islandTargetOf({ kind: 'chat', chatId: 'c2' }, chats, 'w')).toBeNull()
    expect(islandTargetOf({ kind: 'chat', chatId: 'c3' }, chats, 'w')).toBeNull()
    expect(islandTargetOf({ kind: 'chat', chatId: 'zz' }, chats, 'w')).toBeNull()
    expect(islandTargetOf({ kind: 'editor' }, chats, 'w')).toBeNull()
  })
})

describe('sameTarget', () => {
  it('compares kind and chat', () => {
    expect(sameTarget(undefined, { kind: 'new' })).toBe(false)
    expect(sameTarget({ kind: 'new' }, { kind: 'new' })).toBe(true)
    expect(sameTarget({ kind: 'chat', chatId: 'a' }, { kind: 'chat', chatId: 'a' })).toBe(true)
    expect(sameTarget({ kind: 'chat', chatId: 'a' }, { kind: 'chat', chatId: 'b' })).toBe(false)
    expect(sameTarget({ kind: 'chat', chatId: 'a' }, { kind: 'new' })).toBe(false)
  })
})

describe('islandOpenAsk', () => {
  it('has nothing to open without a chat', () => {
    expect(islandOpenAsk({ chatId: null, live: null })).toBeNull()
  })
  it('opens the chat alone', () => {
    expect(islandOpenAsk({ chatId: 'c1', live: null })).toEqual({ chatId: 'c1', live: null })
  })
  it('adds the chat to a desktop view and a handoff', () => {
    expect(islandOpenAsk({ chatId: 'c1', live: { kind: 'desktop', agent: 'a', point: { x: 1, y: 2 } } })).toEqual({
      chatId: 'c1',
      live: { kind: 'desktop', chatId: 'c1', agent: 'a', point: { x: 1, y: 2 } }
    })
    const target = { agent: 'a', chatId: 'c9', requestId: 'r' }
    expect(islandOpenAsk({ chatId: null, live: { kind: 'handoff', surface: 'browser', target } })).toEqual({
      chatId: 'c9',
      live: { kind: 'handoff', chatId: 'c9', surface: 'browser', target }
    })
  })
})
