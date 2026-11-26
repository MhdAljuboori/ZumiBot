import { describe, expect, it } from 'vitest'
import { createItemsFeed } from '../../src/rpc/itemsFeed'
import { ITEMS_JUMP_MAX, ITEMS_PAGE, type ChatItem, type ChatPush, type WirePush } from '@zumibot/shared/types'

const user = (id: string): ChatItem => ({ type: 'user', id, text: id, ts: 1 })
const tool = (id: string, result: string | null = null): ChatItem => ({
  type: 'tool',
  id,
  name: 'Bash',
  input: { command: 'ls' },
  result,
  isError: false,
  blocked: false,
  ts: 2
})
const itemsPush = (items: ChatItem[], chatId = 'c1'): ChatPush => ({ chatId, kind: 'items', items, clearStreaming: false })

// What a client holding the whole of `held` makes of a wire push; mirrors the frontend's applyPush.
const apply = (held: ChatItem[], p: WirePush): ChatItem[] =>
  p.kind !== 'items' ? held : p.base === null ? p.items : [...held.slice(0, p.from), ...p.items]
const users = (n: number, prefix = 'u'): ChatItem[] => Array.from({ length: n }, (_, i) => user(`${prefix}${i}`))

describe('createItemsFeed', () => {
  it("sends a chat's first list whole", () => {
    const feed = createItemsFeed()
    const list = [user('u1'), tool('t1')]
    expect(feed.wire(itemsPush(list))).toEqual({
      chatId: 'c1',
      kind: 'items',
      seq: 1,
      base: null,
      from: 0,
      items: list,
      clearStreaming: false
    })
  })

  it('peeks at the held list without loading or numbering one', async () => {
    const feed = createItemsFeed()
    expect(feed.peek('c1')).toBeNull()
    const list = [user('u1'), tool('t1')]
    feed.wire(itemsPush(list))
    expect(feed.peek('c1')).toBe(list)
    // A peek takes no number: the next push still builds on the last one.
    expect(feed.wire(itemsPush([...list, user('u2')]))).toMatchObject({ seq: 2, base: 1 })
    await feed.snapshot('c2', async () => [user('x')])
    expect(feed.peek('c2')).toEqual([user('x')])
    feed.forget('c1')
    expect(feed.peek('c1')).toBeNull()
  })

  it('sends a long first list as its latest page', () => {
    const feed = createItemsFeed()
    const list = users(ITEMS_PAGE + 5)
    expect(feed.wire(itemsPush(list))).toMatchObject({ base: null, from: 5, items: list.slice(5) })
  })

  it('then sends only the items past what the last push had', () => {
    const feed = createItemsFeed()
    const u1 = user('u1')
    const t1 = tool('t1')
    const first = feed.wire(itemsPush([u1, t1]))
    const done = tool('t1', 'ok')
    const next = feed.wire(itemsPush([u1, done, user('u2')]))
    expect(next).toMatchObject({ seq: 2, base: 1, from: 1, items: [done, user('u2')] })
    expect(apply(apply([], first), next)).toEqual([u1, done, user('u2')])
  })

  it('matches items read again from disk by content, not identity', () => {
    const feed = createItemsFeed()
    const list = [user('u1'), tool('t1', 'ok')]
    feed.wire(itemsPush(list))
    const reread = JSON.parse(JSON.stringify(list)) as ChatItem[]
    expect(feed.wire(itemsPush([...reread, user('u2')]))).toMatchObject({ base: 1, from: 2, items: [user('u2')] })
  })

  it('carries a shorter list as an empty tail', () => {
    const feed = createItemsFeed()
    const list = [user('u1'), user('u2')]
    const first = feed.wire(itemsPush(list))
    const next = feed.wire(itemsPush([list[0]]))
    expect(next).toMatchObject({ base: 1, from: 1, items: [] })
    expect(apply(apply([], first), next)).toEqual([list[0]])
  })

  it('sends a list sharing nothing with the last one whole', () => {
    const feed = createItemsFeed()
    feed.wire(itemsPush([user('u1')]))
    expect(feed.wire(itemsPush([user('x')]))).toMatchObject({ seq: 2, base: null, from: 0 })
  })

  it("numbers lists across chats and keeps each chat's base apart", () => {
    const feed = createItemsFeed()
    const a = [user('a')]
    const b = [user('b')]
    feed.wire(itemsPush(a, 'A'))
    feed.wire(itemsPush(b, 'B'))
    expect(feed.wire(itemsPush([...a, user('a2')], 'A'))).toMatchObject({ seq: 3, base: 1, from: 1 })
  })

  it('a version switch goes out as a delta from the switched message', () => {
    const feed = createItemsFeed()
    const head = [user('u0'), tool('t0', 'ok')]
    const first = feed.wire(itemsPush([...head, user('a1'), tool('a2', 'ok'), user('a3')]))
    const next = feed.wire(itemsPush([...head, user('b1'), tool('b2', 'ok')]))
    expect(next).toMatchObject({ base: 1, from: 2, items: [user('b1'), tool('b2', 'ok')] })
    expect(apply(apply([], first), next)).toEqual([...head, user('b1'), tool('b2', 'ok')])
  })

  it('passes other pushes through', () => {
    const feed = createItemsFeed()
    const delta: ChatPush = { chatId: 'c1', kind: 'delta', text: 'po' }
    expect(feed.wire(delta)).toBe(delta)
  })

  it('snapshot gives the last pushed list and its number, without loading', async () => {
    const feed = createItemsFeed()
    const list = [user('u1')]
    feed.wire(itemsPush(list))
    expect(
      await feed.snapshot('c1', () => {
        throw new Error('loaded')
      })
    ).toEqual({ items: list, seq: 1 })
  })

  it('snapshot of a chat with no push loads it and numbers it, so the next push builds on it', async () => {
    const feed = createItemsFeed()
    const stored = [user('u1')]
    const snap = await feed.snapshot('c1', async () => stored)
    expect(snap).toEqual({ items: stored, seq: 1 })
    expect(feed.wire(itemsPush([...stored, user('u2')]))).toMatchObject({ seq: 2, base: 1, from: 1 })
  })

  it('snapshot prefers a push that landed while it loaded', async () => {
    const feed = createItemsFeed()
    const pushed = [user('u1'), user('u2')]
    const snap = await feed.snapshot('c1', async () => {
      feed.wire(itemsPush(pushed))
      return [user('u1')]
    })
    expect(snap).toEqual({ items: pushed, seq: 1 })
  })

  it('page gives the latest page, where it starts, and the list number', async () => {
    const feed = createItemsFeed()
    const list = users(ITEMS_PAGE + 10)
    feed.wire(itemsPush(list))
    expect(await feed.page('c1', async () => [])).toEqual({ items: list.slice(10), start: 10, seq: 1, quoted: [] })
  })

  it('page before an item gives the page ending just before it', async () => {
    const feed = createItemsFeed()
    const list = users(ITEMS_PAGE * 2 + 10)
    feed.wire(itemsPush(list))
    const older = await feed.page('c1', async () => [], list[ITEMS_PAGE + 10].id)
    expect(older).toMatchObject({ items: list.slice(10, ITEMS_PAGE + 10), start: 10 })
    expect(await feed.page('c1', async () => [], list[10].id)).toMatchObject({ items: list.slice(0, 10), start: 0 })
  })

  it('page until an item reaches back to it and ten above, in one page', async () => {
    const feed = createItemsFeed()
    const list = users(ITEMS_PAGE * 4)
    feed.wire(itemsPush(list))
    const end = ITEMS_PAGE * 3
    expect(await feed.page('c1', async () => [], list[end].id, list[7].id)).toMatchObject({ items: list.slice(0, end), start: 0 })
    expect(await feed.page('c1', async () => [], list[end].id, list[40].id)).toMatchObject({ items: list.slice(30, end), start: 30 })
    // From the latest page too; an item already inside the page, or one not there, changes nothing.
    expect(await feed.page('c1', async () => [], undefined, list[30].id)).toMatchObject({ items: list.slice(20), start: 20 })
    expect(await feed.page('c1', async () => [], undefined, list[ITEMS_PAGE * 4 - 1].id)).toMatchObject({ start: ITEMS_PAGE * 3 })
    expect(await feed.page('c1', async () => [], undefined, 'nope')).toMatchObject({ start: ITEMS_PAGE * 3 })
  })

  it('page until an item stops at ITEMS_JUMP_MAX, to be asked again', async () => {
    const feed = createItemsFeed()
    const list = users(ITEMS_JUMP_MAX + 100)
    feed.wire(itemsPush(list))
    expect(await feed.page('c1', async () => [], undefined, list[0].id)).toMatchObject({ start: 100, items: list.slice(100) })
  })

  it('page before an item that is gone is refused', async () => {
    const feed = createItemsFeed()
    feed.wire(itemsPush(users(3)))
    await expect(feed.page('c1', async () => [], 'nope')).rejects.toThrow('Message not found')
  })

  it('page carries the agent messages its replies quote from before it, and nothing it has itself', async () => {
    const feed = createItemsFeed()
    const old: ChatItem = { type: 'assistant', id: 'a-old', text: 'old answer', ts: 1 }
    const near: ChatItem = { type: 'assistant', id: 'a-near', text: 'near', ts: 2 }
    const reply: ChatItem = { type: 'user', id: 'r1', text: 'about that', ts: 3, replyTo: 'a-old' }
    const replyNear: ChatItem = { type: 'user', id: 'r2', text: 'and this', ts: 4, replyTo: 'a-near' }
    feed.wire(itemsPush([old, ...users(ITEMS_PAGE), near, reply, replyNear]))
    const page = await feed.page('c1', async () => [])
    expect(page.quoted).toEqual([old])
  })

  it('forget and reset make the next push whole', () => {
    const feed = createItemsFeed()
    const list = [user('u1')]
    feed.wire(itemsPush(list, 'A'))
    feed.wire(itemsPush(list, 'B'))
    feed.forget('A')
    expect(feed.wire(itemsPush(list, 'A'))).toMatchObject({ base: null, from: 0 })
    feed.reset()
    expect(feed.wire(itemsPush(list, 'B'))).toMatchObject({ base: null, from: 0 })
  })

  it('keeps a bounded number of chats; an evicted one is sent whole again', () => {
    const feed = createItemsFeed(2)
    const list = [user('u1')]
    feed.wire(itemsPush(list, 'A'))
    feed.wire(itemsPush(list, 'B'))
    feed.wire(itemsPush(list, 'A')) // A is now the most recent
    feed.wire(itemsPush(list, 'C')) // evicts B
    expect(feed.wire(itemsPush(list, 'A'))).toMatchObject({ base: 3 })
    expect(feed.wire(itemsPush(list, 'B'))).toMatchObject({ base: null })
  })
})
