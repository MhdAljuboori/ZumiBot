import { describe, expect, it } from 'vitest'
import type { ChatItem } from '@zumibot/shared/types'
import type { AgentSummary, ChatMeta } from '@zumibot/shared/types'
import {
  agentHasUnread,
  anyUnread,
  lineScroll,
  listedChats,
  newLineItem,
  sinceOnChange,
  sinceOnOpen,
  unreadElsewhere
} from '../src/state/unread'

describe('agentHasUnread', () => {
  it('is true only for an unread chat of that agent', () => {
    const chats = [
      { agentName: 'a', replyAt: 9, seenAt: 5 },
      { agentName: 'b', replyAt: 9, seenAt: 5 },
      { agentName: 'c', replyAt: 5, seenAt: 9 }
    ]
    expect(agentHasUnread(chats, 'a')).toBe(true)
    expect(agentHasUnread(chats, 'c')).toBe(false)
    expect(agentHasUnread(chats, 'x')).toBe(false)
  })

  it('never counts a group chat for an agent', () => {
    expect(agentHasUnread([{ agentName: '', replyAt: 9 }], 'a')).toBe(false)
  })
})

describe('unreadElsewhere', () => {
  const chats = [
    { id: '1', replyAt: 9, seenAt: 5 },
    { id: '2', replyAt: 5, seenAt: 9 }
  ]
  it("ignores the open chat's own unread", () => {
    expect(unreadElsewhere(chats, '1')).toBe(false)
  })
  it("counts another chat's unread", () => {
    expect(unreadElsewhere(chats, '2')).toBe(true)
  })
  it('counts every chat when none is open', () => {
    expect(unreadElsewhere(chats, null)).toBe(true)
  })
})

describe('anyUnread', () => {
  it('is true when some chat is unread', () => {
    expect(
      anyUnread([
        { replyAt: 5, seenAt: 9 },
        { replyAt: 9, seenAt: 5 }
      ])
    ).toBe(true)
    expect(anyUnread([{ replyAt: 5, seenAt: 9 }, {}])).toBe(false)
  })
})

describe('sinceOnOpen', () => {
  it('starts the line at seenAt when unread and ever seen', () => {
    expect(sinceOnOpen({ replyAt: 9, seenAt: 5 })).toBe(5)
  })
  it('gives no line for a never-seen chat', () => {
    expect(sinceOnOpen({ replyAt: 9 })).toBeNull()
  })
  it('gives no line for a read chat', () => {
    expect(sinceOnOpen({ replyAt: 5, seenAt: 9 })).toBeNull()
  })
})

describe('a mark and the New line', () => {
  const mark = { at: 60, from: 20 }
  it('opens on the marked message', () => {
    expect(sinceOnOpen({ seenAt: 50, mark })).toBe(20)
    expect(sinceOnOpen({ mark })).toBe(20)
  })
  it('opens on an earlier unseen reply when there is one', () => {
    expect(sinceOnOpen({ replyAt: 40, seenAt: 10, mark })).toBe(10)
  })
  it('opens with no line once an open ended the mark', () => {
    expect(sinceOnOpen({ seenAt: 70, mark })).toBeNull()
  })
  it('shows the line at once when the mark is set while the chat is open', () => {
    expect(sinceOnChange(null, { seenAt: 50 }, { seenAt: 50, mark })).toBe(20)
  })
  it('moves it when another message is marked', () => {
    expect(sinceOnChange(20, { seenAt: 50, mark }, { seenAt: 50, mark: { at: 70, from: 30 } })).toBe(30)
  })
  it('keeps it when a reply lands while marked', () => {
    expect(sinceOnChange(20, { seenAt: 50, mark }, { replyAt: 80, seenAt: 50, mark })).toBe(20)
  })
  it('keeps it on the marked message when the open that ends the mark lands', () => {
    expect(sinceOnChange(20, { seenAt: 50, mark }, { seenAt: 90 })).toBe(20)
  })
})

describe('sinceOnChange', () => {
  it('keeps a held line whatever the marks do', () => {
    expect(sinceOnChange(5, { replyAt: 9, seenAt: 5 }, { replyAt: 9, seenAt: 12 })).toBe(5)
    expect(sinceOnChange(5, {}, {})).toBe(5)
  })
  it('moves a held line on a later unread -> read round (a second idle)', () => {
    expect(sinceOnChange(5, { replyAt: 20, seenAt: 12 }, { replyAt: 20, seenAt: 30 })).toBe(12)
  })
  it('keeps a held line when the previous marks were never seen', () => {
    expect(sinceOnChange(5, { replyAt: 20 }, { replyAt: 20, seenAt: 30 })).toBe(5)
  })
  it('sets the line from the seenAt before the read (the idle case)', () => {
    expect(sinceOnChange(null, { replyAt: 9, seenAt: 5 }, { replyAt: 9, seenAt: 12 })).toBe(5)
  })
  it('sets nothing when the chat was already read', () => {
    expect(sinceOnChange(null, { replyAt: 5, seenAt: 9 }, { replyAt: 5, seenAt: 12 })).toBeNull()
  })
  it('sets nothing when the chat was never seen', () => {
    expect(sinceOnChange(null, { replyAt: 9 }, { replyAt: 9, seenAt: 12 })).toBeNull()
  })
  it('waits while the chat is still unread (the server read has not landed)', () => {
    expect(sinceOnChange(null, { replyAt: 9, seenAt: 5 }, { replyAt: 9, seenAt: 5 })).toBeNull()
  })
})

describe('newLineItem', () => {
  const items: ChatItem[] = [
    { type: 'user', id: 'u1', text: 'a', ts: 1 },
    { type: 'assistant', id: 'a1', text: 'b', ts: 3 },
    { type: 'user', id: 'u2', text: 'c', ts: 7 },
    { type: 'tool', id: 't1', name: 'Bash', input: {}, result: null, isError: false, blocked: false, ts: 8 },
    { type: 'assistant', id: 'a2', text: 'd', ts: 9 }
  ]
  it('is the first non-user item after since', () => {
    expect(newLineItem(items, 5, false)).toBe('t1')
  })
  it('is null with no since or nothing after it', () => {
    expect(newLineItem(items, null, false)).toBeNull()
    expect(newLineItem(items, 20, false)).toBeNull()
  })
  it('skips a kept notice, which is never shown', () => {
    const kept: ChatItem = { type: 'notice', id: 'k1', kind: 'kept', text: 'x', ts: 6 }
    expect(newLineItem([...items.slice(0, 2), kept, ...items.slice(2)], 5, false)).toBe('t1')
  })
  it('counts an error item', () => {
    const err: ChatItem = { type: 'error', id: 'e1', text: 'boom', ts: 6 }
    expect(newLineItem([...items.slice(0, 2), err, ...items.slice(2)], 5, false)).toBe('e1')
  })
  it('is null when older items exist and every loaded item is newer than since (the first unseen one may be unloaded)', () => {
    expect(newLineItem(items.slice(1), 2, true)).toBeNull()
  })
  it('is the normal result when older items exist but one at or before since is loaded', () => {
    expect(newLineItem(items, 5, true)).toBe('t1')
    expect(newLineItem(items, 1, true)).toBe('a1')
  })
  it('does not look for older items when the page starts at the top', () => {
    expect(newLineItem(items.slice(1), 2, false)).toBe('a1')
  })
})

describe('listedChats', () => {
  const agents = [{ name: 'a' }] as AgentSummary[]
  const chat = (id: string, agentName: string, group = false): ChatMeta =>
    ({ id, agentName, group: group ? { members: ['a', 'b'] } : undefined }) as unknown as ChatMeta
  it('keeps a chat whose agent exists', () => {
    expect(listedChats([chat('1', 'a')], agents).map((c) => c.id)).toEqual(['1'])
  })
  it('drops a chat whose agent is gone (the sidebar has no row for it)', () => {
    expect(listedChats([chat('1', 'a'), chat('2', 'gone')], agents).map((c) => c.id)).toEqual(['1'])
  })
  it('keeps a group chat whatever its members', () => {
    expect(listedChats([chat('3', '', true)], agents).map((c) => c.id)).toEqual(['3'])
  })
})

describe('lineScroll', () => {
  // A 1000px list in a 300px window, 18px top padding, sticking within 40px of the bottom.
  const box = { scrollHeight: 1000, clientHeight: 300, padTop: 18, atBottomPx: 40 }
  it('puts the line at the top, past the padding, and does not stick', () => {
    expect(lineScroll({ ...box, lineTop: 418 })).toEqual({ scrollTop: 400, stick: false })
  })
  it('stops at the bottom and sticks when the line is in the last screen', () => {
    expect(lineScroll({ ...box, lineTop: 900 })).toEqual({ scrollTop: 700, stick: true })
  })
  it('sticks when the line lands within the bottom slack', () => {
    expect(lineScroll({ ...box, lineTop: 698 })).toEqual({ scrollTop: 680, stick: true })
  })
  it('never scrolls above the top', () => {
    expect(lineScroll({ ...box, lineTop: 10 })).toEqual({ scrollTop: 0, stick: false })
  })
  it('sticks in a list shorter than its window', () => {
    expect(lineScroll({ ...box, scrollHeight: 200, lineTop: 100 })).toEqual({ scrollTop: 0, stick: true })
  })
})
