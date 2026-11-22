import { describe, expect, it } from 'vitest'
import type { ChatMeta, GroupInfo } from '@zumibot/shared/types'
import type { SearchHit } from '@zumibot/shared/search'
import { addPage, hitKey, hitRows, segments, statusText, whenLabel } from '../src/state/messageSearch'

const chat = (id: string, agentName: string, title: string, extra: Partial<ChatMeta> = {}): ChatMeta => ({
  id,
  agentName,
  sessionId: null,
  cwd: '/w',
  title,
  createdAt: 0,
  updatedAt: 0,
  inFlight: false,
  ...extra
})
const room = (id: string, title: string): ChatMeta =>
  chat(id, '', title, { group: { members: ['alpha', 'beta'], sessions: {}, seen: {}, role: '', active: [], queue: [] } as GroupInfo })
const hit = (chatId: string, itemId: string, extra: Partial<SearchHit> = {}): SearchHit => ({
  chatId,
  itemId,
  role: 'assistant',
  agent: null,
  ts: 0,
  snippet: 'text',
  marks: [],
  ...extra
})

describe('addPage', () => {
  it('adds the next page without a hit already listed', () => {
    const held = [hit('a', '1'), hit('a', '2')]
    expect(addPage(held, [hit('a', '2'), hit('b', '1')]).map(hitKey)).toEqual(['a/1', 'a/2', 'b/1'])
  })
})

describe('hitRows', () => {
  const now = new Date(2026, 10, 11, 15, 0).getTime()
  const chats = [chat('s', 'code-reviewer', 'Review PR'), room('r', ''), chat('x', 'alpha', 'Old', { archivedAt: 5 })]

  it('names who wrote each hit, and the chat it is in', () => {
    const rows = hitRows(
      [
        hit('s', '1'),
        hit('s', '2', { role: 'user' }),
        hit('s', '3', { role: 'user', agent: 'beta-bot' }),
        hit('r', '4', { agent: 'beta' }),
        hit('x', '5')
      ],
      chats,
      now,
      []
    )
    expect(rows.map((r) => [r.title, r.who, r.agent, r.archived])).toEqual([
      ['Review PR', 'Code Reviewer', 'code-reviewer', false],
      ['Review PR', 'You', null, false],
      ['Review PR', '@Beta Bot', 'beta-bot', false],
      ['New chat', 'Beta', 'beta', false],
      ['Old', 'Alpha', 'alpha', true]
    ])
  })

  it('leaves out a hit of a chat this page does not list', () => {
    expect(hitRows([hit('gone', '1')], chats, now, [])).toEqual([])
  })

  it('writes agent handles in the chat title as display names', () => {
    const titled = [chat('t', 'alpha', 'ask @code-reviewer')]
    expect(hitRows([hit('t', '1')], titled, now, [{ name: 'code-reviewer' }])[0].title).toBe('ask @Code Reviewer')
  })
})

describe('whenLabel', () => {
  const now = new Date(2026, 10, 11, 15, 0).getTime()
  it('reads a time today, Yesterday, a weekday this week, then a date', () => {
    expect(whenLabel(new Date(2026, 10, 11, 9, 5).getTime(), now)).toMatch(/9|09/)
    expect(whenLabel(new Date(2026, 10, 10, 23, 0).getTime(), now)).toBe('Yesterday')
    expect(whenLabel(new Date(2026, 10, 7).getTime(), now)).toBe(new Date(2026, 10, 7).toLocaleDateString(undefined, { weekday: 'short' }))
    expect(whenLabel(new Date(2026, 1, 3).getTime(), now)).toBe(
      new Date(2026, 1, 3).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })
    )
    expect(whenLabel(new Date(2024, 1, 3).getTime(), now)).toContain('2024')
  })
})

describe('segments', () => {
  it('cuts the snippet at its marks', () => {
    expect(
      segments('fix the build now', [
        [4, 7],
        [8, 13]
      ])
    ).toEqual([
      { text: 'fix ', mark: false },
      { text: 'the', mark: true },
      { text: ' ', mark: false },
      { text: 'build', mark: true },
      { text: ' now', mark: false }
    ])
  })
  it('ignores marks out of order or range', () => {
    expect(
      segments('abc', [
        [1, 2],
        [0, 1],
        [2, 9]
      ])
    ).toEqual([
      { text: 'a', mark: false },
      { text: 'b', mark: true },
      { text: 'c', mark: false }
    ])
  })
})

describe('statusText', () => {
  it('says what the search found so far', () => {
    expect(statusText(null, true, false)).toBe('Searching messages…')
    expect(statusText(null, false, false)).toBe('')
    expect(statusText(null, false, true)).toBe("Couldn't search messages.")
    expect(statusText({ total: 0, capped: false, indexing: false }, false, false)).toBe('No messages match')
    expect(statusText({ total: 1, capped: false, indexing: false }, false, false)).toBe('1 message')
    expect(statusText({ total: 1, capped: true, indexing: false }, false, false)).toBe('1+ messages')
    expect(statusText({ total: 12, capped: false, indexing: true }, false, false)).toBe('12 messages · still indexing older chats…')
  })
})
