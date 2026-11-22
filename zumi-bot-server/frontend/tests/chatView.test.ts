import { describe, expect, it } from 'vitest'
import { applyPush, emptyChatView, loadedPage, prependPage, renameItemAuthors, renameViewAuthors, skipPush } from '../src/state/chatView'
import type { ChatItem, ChatMeta } from '@zumibot/shared/types'

const items: ChatItem[] = [{ type: 'user', id: 'u1', text: 'ping', ts: 1 }]
const meta: ChatMeta = {
  id: 'c1',
  agentName: 'a',
  sessionId: null,
  cwd: '/tmp',
  title: 't',
  createdAt: 1,
  updatedAt: 1,
  inFlight: true
}

describe('applyPush', () => {
  it('keeps live text per agent', () => {
    let s = applyPush(emptyChatView, { chatId: 'c1', kind: 'delta', text: 'a1', agent: 'a' })
    s = applyPush(s, { chatId: 'c1', kind: 'delta', text: 'b1', agent: 'b' })
    s = applyPush(s, { chatId: 'c1', kind: 'delta', text: '+', agent: 'a' })
    expect(s.streamingBy).toEqual({ a: 'a1+', b: 'b1' })
    expect(s.streaming).toBe('')
  })

  it('keeps live thought apart from live text, per agent in a room', () => {
    let s = applyPush(emptyChatView, { chatId: 'c1', kind: 'delta', text: 'Checking ', thought: true })
    s = applyPush(s, { chatId: 'c1', kind: 'delta', text: 'files', thought: true })
    expect(s).toMatchObject({ thought: 'Checking files', streaming: '' })
    let r = applyPush(emptyChatView, { chatId: 'c1', kind: 'delta', text: 'a', agent: 'a', thought: true })
    r = applyPush(r, { chatId: 'c1', kind: 'delta', text: 'b', agent: 'b', thought: true })
    r = applyPush(r, { chatId: 'c1', kind: 'delta', text: 'reply', agent: 'a' })
    expect(r).toMatchObject({ thoughtBy: { a: 'a', b: 'b' }, streamingBy: { a: 'reply' }, thought: '' })
  })

  it("an items push that clears live text clears that agent's live thought too", () => {
    const s = { ...emptyChatView, items: [], start: 0, thought: 'x', thoughtBy: { a: '1', b: '2' } }
    const one = applyPush(s, { chatId: 'c1', kind: 'items', seq: 1, base: null, from: 0, items, clearStreaming: true, agent: 'a' })
    expect(one).toMatchObject({ thought: 'x', thoughtBy: { b: '2' } })
    const all = applyPush(s, { chatId: 'c1', kind: 'items', seq: 1, base: null, from: 0, items, clearStreaming: true })
    expect(all).toMatchObject({ thought: '', thoughtBy: {} })
    expect(applyPush(s, { chatId: 'c1', kind: 'items', seq: 1, base: null, from: 0, items, clearStreaming: false })).toMatchObject({
      thought: 'x',
      thoughtBy: { a: '1', b: '2' }
    })
  })

  it("clears only the finishing agent's live text", () => {
    const s = { ...emptyChatView, items: [], start: 0, streaming: 'x', streamingBy: { a: '1', b: '2' } }
    const one = applyPush(s, { chatId: 'c1', kind: 'items', seq: 1, base: null, from: 0, items, clearStreaming: true, agent: 'a' })
    expect(one).toEqual({ ...emptyChatView, items, start: 0, streaming: 'x', streamingBy: { b: '2' } })
    const all = applyPush(s, { chatId: 'c1', kind: 'items', seq: 1, base: null, from: 0, items, clearStreaming: true })
    expect(all).toEqual({ ...emptyChatView, items, start: 0, streaming: '', streamingBy: {} })
    const keep = applyPush(s, { chatId: 'c1', kind: 'items', seq: 1, base: null, from: 0, items, clearStreaming: false, agent: 'a' })
    expect(keep.streamingBy).toEqual({ a: '1', b: '2' })
  })

  it('accumulates deltas', () => {
    const a = applyPush(emptyChatView, { chatId: 'c1', kind: 'delta', text: 'po' })
    const b = applyPush(a, { chatId: 'c1', kind: 'delta', text: 'ng' })
    expect(b.streaming).toBe('pong')
  })

  it('replaces items and clears streaming when clearStreaming is true', () => {
    const s = { ...emptyChatView, items: [], start: 0, streaming: 'partial', streamingBy: {} }
    const r = applyPush(s, { chatId: 'c1', kind: 'items', seq: 1, base: null, from: 0, items, clearStreaming: true })
    expect(r).toEqual({ ...emptyChatView, items, start: 0, streaming: '', streamingBy: {} })
  })

  it('keeps streaming when clearStreaming is false', () => {
    const s = { ...emptyChatView, items: [], start: 0, streaming: 'partial', streamingBy: {} }
    const r = applyPush(s, { chatId: 'c1', kind: 'items', seq: 1, base: null, from: 0, items, clearStreaming: false })
    expect(r).toEqual({ ...emptyChatView, items, start: 0, streaming: 'partial', streamingBy: {} })
  })

  it('a delta keeps the items before `from` and adds its own', () => {
    const held: ChatItem[] = [
      { type: 'user', id: 'u1', text: 'a', ts: 1 },
      { type: 'assistant', id: 'a1', text: 'old', ts: 2 }
    ]
    const s = { ...emptyChatView, items: held, start: 0, streaming: '', streamingBy: {} }
    const next: ChatItem = { type: 'assistant', id: 'a1', text: 'new', ts: 2 }
    const r = applyPush(s, { chatId: 'c1', kind: 'items', seq: 2, base: 1, from: 1, items: [next], clearStreaming: false })
    expect(r.items).toEqual([held[0], next])
    expect(r.items[0]).toBe(held[0])
  })

  it('a skipped push keeps the items but still ends the live text', () => {
    const s = { ...emptyChatView, items, start: 0, streaming: 'partial', streamingBy: {} }
    expect(skipPush(s, { chatId: 'c1', kind: 'items', seq: 3, base: 2, from: 0, items: [], clearStreaming: true })).toEqual({
      ...emptyChatView,
      items,
      start: 0,
      streaming: '',
      streamingBy: {}
    })
  })

  it('a delta on a view holding only the latest items lands at the right place', () => {
    const held: ChatItem[] = [
      { type: 'user', id: 'u40', text: 'a', ts: 1 },
      { type: 'assistant', id: 'a41', text: 'old', ts: 2 }
    ]
    const s = { ...emptyChatView, items: held, start: 40 }
    const next: ChatItem = { type: 'assistant', id: 'a41', text: 'new', ts: 2 }
    const r = applyPush(s, { chatId: 'c1', kind: 'items', seq: 2, base: 1, from: 41, items: [next], clearStreaming: false })
    expect(r.items).toEqual([held[0], next])
    expect(r.start).toBe(40)
  })

  it('a fresh list replaces the view from where it starts', () => {
    const s = { ...emptyChatView, items, start: 0, quoted: items }
    const fresh: ChatItem[] = [{ type: 'user', id: 'u9', text: 'z', ts: 9 }]
    expect(applyPush(s, { chatId: 'c1', kind: 'items', seq: 5, base: null, from: 9, items: fresh, clearStreaming: false })).toMatchObject({
      items: fresh,
      start: 9,
      quoted: []
    })
  })

  it('returns the same object for a meta push', () => {
    const s = { ...emptyChatView, items, start: 0, streaming: 'x', streamingBy: {} }
    expect(applyPush(s, { chatId: 'c1', kind: 'meta', meta })).toBe(s)
  })

  it('returns the same object for an approvals push', () => {
    const s = { ...emptyChatView, items, start: 0, streaming: 'x', streamingBy: {} }
    expect(applyPush(s, { chatId: 'c1', kind: 'approvals', pending: 1 })).toBe(s)
  })
})

describe('renameItemAuthors', () => {
  const thread: ChatItem[] = [
    { type: 'user', id: 'u1', text: '@old hi', ts: 1 },
    { type: 'assistant', id: 'a1', text: 'hello', ts: 2, agent: 'old' },
    { type: 'tool', id: 't1', name: 'Read', input: {}, result: null, isError: false, blocked: false, ts: 3, agent: 'old' },
    {
      type: 'approval',
      id: 'r1',
      toolUseId: 't1',
      toolName: 'Read',
      input: {},
      description: null,
      reason: null,
      status: 'pending',
      ts: 4,
      agent: 'old'
    },
    { type: 'assistant', id: 'b1', text: 'me too', ts: 5, agent: 'other' }
  ]

  it('moves assistant, tool and approval items to the new name, keeping the rest as they were', () => {
    const out = renameItemAuthors(thread, [{ from: 'old', to: 'new' }])
    expect(out.map((i) => ('agent' in i ? i.agent : null))).toEqual([null, 'new', 'new', 'new', 'other'])
    expect(out[0]).toBe(thread[0])
    expect(out[4]).toBe(thread[4])
    expect(out[1]).toEqual({ ...thread[1], agent: 'new' })
  })

  it('returns the same list when no author is renamed', () => {
    expect(renameItemAuthors(thread, [{ from: 'nobody', to: 'new' }])).toBe(thread)
    expect(renameItemAuthors(items, [{ from: 'old', to: 'new' }])).toBe(items) // a single chat's items carry no author
  })

  it('renames the views it touches and keeps the others', () => {
    const group = { items: thread, streaming: 'live', streamingBy: {} }
    const single = { items, streaming: '', streamingBy: {} }
    const views = { g: group, s: single }
    const out = renameViewAuthors(views, [{ from: 'old', to: 'new' }])
    expect(out.s).toBe(single)
    expect(out.g.streaming).toBe('live')
    expect(out.g.items.map((i) => ('agent' in i ? i.agent : null))).toEqual([null, 'new', 'new', 'new', 'other'])
    expect(renameViewAuthors(views, [{ from: 'nobody', to: 'new' }])).toBe(views)
  })
})

describe('pages', () => {
  const at = (n: number): ChatItem => ({ type: 'user', id: `u${n}`, text: `${n}`, ts: n })
  const quote: ChatItem = { type: 'assistant', id: 'q1', text: 'quoted', ts: 0 }

  it('the latest page replaces what the view held and keeps live text', () => {
    const s = { ...emptyChatView, items: [at(1)], start: 0, streaming: 'live' }
    expect(loadedPage(s, { items: [at(5), at(6)], start: 5, seq: 3, quoted: [quote] })).toEqual({
      ...emptyChatView,
      items: [at(5), at(6)],
      start: 5,
      quoted: [quote],
      streaming: 'live'
    })
  })

  it('a reload whose page lines up with the held items keeps the older ones above it', () => {
    const s = { ...emptyChatView, items: [at(3), at(4), at(5), at(6)], start: 3, quoted: [quote] }
    const fresh = { ...at(6), text: 'edited' }
    expect(loadedPage(s, { items: [at(5), fresh, at(7)], start: 5, seq: 9, quoted: [] })).toMatchObject({
      items: [at(3), at(4), at(5), fresh, at(7)],
      start: 3,
      quoted: [quote]
    })
  })

  it('an older page goes above the loaded items, adding the quotes it brings once', () => {
    const s = { ...emptyChatView, items: [at(5), at(6)], start: 5, quoted: [quote] }
    const r = prependPage(s, { items: [at(3), at(4)], start: 3, seq: 3, quoted: [quote] }, 'u5')
    expect(r).toMatchObject({ items: [at(3), at(4), at(5), at(6)], start: 3, quoted: [quote] })
  })

  it('a page that does not end where the loaded items start is dropped', () => {
    const s = { ...emptyChatView, items: [at(5), at(6)], start: 5 }
    expect(prependPage(s, { items: [at(5), at(6)], start: 5, seq: 3, quoted: [] }, 'u5')).toBe(s)
  })

  it('an older page asked for before a reload is dropped', () => {
    const s = { ...emptyChatView, items: [at(7)], start: 7 }
    expect(prependPage(s, { items: [at(3)], start: 3, seq: 3, quoted: [] }, 'u5')).toBe(s)
  })
})

it('renames browser card display metadata while preserving its immutable handoff identity', () => {
  const card: ChatItem = {
    type: 'browser-action',
    id: 'card',
    ts: 1,
    agent: 'old',
    handoff: {
      id: 'card',
      profileId: 'profile',
      generation: 'generation',
      chatId: 'chat',
      turnId: 'attempt',
      agent: 'old',
      site: 'example.com',
      reason: 'Help',
      createdAt: 1,
      status: 'pending'
    }
  }
  expect(renameItemAuthors([card], [{ from: 'old', to: 'new' }])).toEqual([
    { ...card, agent: 'new', handoff: { ...card.handoff, agent: 'new' } }
  ])
})
