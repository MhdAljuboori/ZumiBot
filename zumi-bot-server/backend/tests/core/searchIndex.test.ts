import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import { join } from 'node:path'
import { ChatStore } from '../../src/core/store/chatStore'
import { SearchIndex } from '../../src/core/search/searchIndex'
import type { ChatItem } from '@zumibot/shared/types'

let dir: string
let store: ChatStore
let logged: string[]

const user = (id: string, text: string, ts: number, from?: string): ChatItem => ({ type: 'user', id, text, ts, ...(from ? { from } : {}) })
const reply = (id: string, text: string, ts: number, agent?: string): ChatItem => ({
  type: 'assistant',
  id,
  text,
  ts,
  ...(agent ? { agent } : {})
})
const tool = (id: string, result: string): ChatItem => ({
  type: 'tool',
  id,
  name: 'Bash',
  input: { command: 'cat .env' },
  result,
  isError: false,
  blocked: false,
  ts: 1
})

const all = () => true
const ids = (idx: SearchIndex, q: string, listed: (id: string) => boolean = all): string[] =>
  idx.search(q, 0, listed).hits.map((h) => `${h.chatId}/${h.itemId}`)

beforeEach(async () => {
  dir = await fs.mkdtemp(join(os.tmpdir(), 'zumibot-search-'))
  store = new ChatStore(dir)
  logged = []
})
afterEach(async () => {
  vi.useRealTimers()
  await fs.rm(dir, { recursive: true, force: true })
})

const index = (settleMs = 0): SearchIndex => new SearchIndex({ store, log: (l) => logged.push(l), settleMs })

describe('SearchIndex', () => {
  it('builds from every stored chat and says indexing until then', async () => {
    const a = await store.create('alpha', '/a')
    const b = await store.create('beta', '/b')
    await store.saveItems(a.id, [user('u1', 'Please deploy the app', 10), tool('t1', 'SECRET=deploy'), reply('a1', 'Deployed it.', 11)])
    await store.saveItems(b.id, [user('u2', 'Nothing here', 20)])
    const idx = index()
    expect(idx.search('deploy', 0, all).indexing).toBe(true)
    idx.start()
    await idx.whenBuilt()
    const r = idx.search('deploy', 0, all)
    expect(r.indexing).toBe(false)
    // newest first; tool results are never indexed
    expect(r.hits.map((h) => h.itemId)).toEqual(['a1', 'u1'])
    expect(r.hits[0]).toMatchObject({ chatId: a.id, role: 'assistant', agent: null, ts: 11, snippet: 'Deployed it.', marks: [[0, 6]] })
    expect(idx.size()).toBe(3)
  })

  it('needs every word, each as a word start, and a phrase as typed', () => {
    const idx = index()
    idx.note('c', [
      user('1', 'Fix the build script', 1),
      user('2', 'the script will build', 2),
      user('3', 'rebuild the scripts', 3),
      user('4', 'release v8.6.5 now', 4),
      user('5', 'v8 then 6 then 5', 5)
    ])
    idx.flush()
    expect(ids(idx, 'build script')).toEqual(['c/2', 'c/1'])
    expect(ids(idx, 'scr')).toEqual(['c/3', 'c/2', 'c/1'])
    expect(ids(idx, '"build script"')).toEqual(['c/1'])
    expect(ids(idx, '"script"')).toEqual(['c/2', 'c/1'])
    expect(ids(idx, 'v8.6.5')).toEqual(['c/4'])
    idx.note('d', [reply('1', 'The **Zephyrine** protocol, see [the relay docs](https://x.example/relay)', 9)])
    idx.flush()
    expect(ids(idx, '"zephyrine protocol"')).toEqual(['d/1'])
    expect(idx.search('relay', 0, all).hits[0].snippet).toBe('The Zephyrine protocol, see the relay docs')
    expect(ids(idx, 'nothing')).toEqual([])
  })

  it('pages newest first and counts every match', () => {
    const idx = index()
    idx.note(
      'c',
      Array.from({ length: 45 }, (_, i) => user(`m${i}`, `note number ${i}`, 100 + i))
    )
    idx.flush()
    const first = idx.search('note', 0, all)
    expect(first).toMatchObject({ total: 45, more: true, capped: false })
    expect(first.hits).toHaveLength(30)
    expect(first.hits[0].itemId).toBe('m44')
    const second = idx.search('note', 30, all)
    expect(second.hits.map((h) => h.itemId)).toEqual(Array.from({ length: 15 }, (_, i) => `m${14 - i}`))
    expect(second.more).toBe(false)
  })

  it('leaves out chats no longer listed', () => {
    const idx = index()
    idx.note('a', [user('1', 'hello', 1)])
    idx.note('b', [user('1', 'hello', 2)])
    idx.flush()
    expect(ids(idx, 'hello', (id) => id === 'a')).toEqual(['a/1'])
  })

  it('follows edits: a message gone from the items leaves, a changed one is found by its new words', () => {
    const idx = index()
    idx.note('c', [user('1', 'old words', 1), reply('2', 'kept reply', 2)])
    idx.flush()
    idx.note('c', [user('1', 'new words', 1), reply('2', 'kept reply', 2)])
    idx.flush()
    expect(ids(idx, 'old')).toEqual([])
    expect(ids(idx, 'new')).toEqual(['c/1'])
    idx.note('c', [reply('2', 'kept reply', 2)])
    idx.flush()
    expect(ids(idx, 'words')).toEqual([])
    expect(idx.size()).toBe(1)
  })

  it('run items are not indexed', () => {
    const idx = index()
    const run: ChatItem = { ...user('r1', '<bash-input>secretword ls</bash-input><bash-stdout>ok', 2), run: { processId: 'p1' } } as ChatItem
    idx.note('c', [user('1', 'plain words', 1), run])
    idx.flush()
    expect(idx.size()).toBe(1)
    expect(ids(idx, 'secretword')).toEqual([])
  })

  it('follows a rename without reindexing the text', () => {
    const idx = index()
    idx.note('c', [reply('1', 'from the room', 1, 'old-name'), user('2', 'asked', 2, 'old-name')])
    idx.flush()
    idx.note('c', [reply('1', 'from the room', 1, 'new-name'), user('2', 'asked', 2, 'new-name')])
    idx.flush()
    expect(idx.search('room', 0, all).hits[0].agent).toBe('new-name')
    expect(idx.search('asked', 0, all).hits[0]).toMatchObject({ role: 'user', agent: 'new-name' })
  })

  it('skips empty messages and repeated ids', () => {
    const idx = index()
    idx.note('c', [user('1', '   ', 1), user('2', 'twice', 2), user('2', 'twice again', 3)])
    idx.flush()
    expect(idx.size()).toBe(1)
    expect(idx.search('twice', 0, all).hits[0].ts).toBe(2)
  })

  it('removes a chat at once, also one still settling', () => {
    const idx = index(60_000)
    idx.note('a', [user('1', 'hello', 1)])
    idx.flush()
    idx.note('a', [user('1', 'hello', 1), user('2', 'hello again', 2)])
    idx.remove('a')
    idx.flush()
    expect(ids(idx, 'hello')).toEqual([])
    expect(idx.size()).toBe(0)
  })

  it('indexes a chat once its saves settle, with its latest items', () => {
    vi.useFakeTimers()
    const idx = index(2000)
    idx.note('c', [user('1', 'first', 1)])
    vi.advanceTimersByTime(1000)
    idx.note('c', [user('1', 'first', 1), user('2', 'second', 2)])
    expect(ids(idx, 'first')).toEqual([])
    vi.advanceTimersByTime(1000)
    expect(ids(idx, 'second')).toEqual(['c/2'])
  })

  it('a save during the build wins over the stale read, and the removal listener drops a chat', async () => {
    const a = await store.create('alpha', '/a')
    const b = await store.create('alpha', '/b')
    await store.saveItems(a.id, [user('1', 'stale words', 1)])
    await store.saveItems(b.id, [user('1', 'gone words', 1)])
    const idx = index()
    store.setItemsListener((id, items) => idx.note(id, items))
    store.setRemovedListener((id) => idx.remove(id))
    idx.start()
    // Queued behind the build's first reads; the listeners see these before the build reads them.
    await store.saveItems(a.id, [user('1', 'fresh words', 1)])
    await store.remove(b.id)
    await idx.whenBuilt()
    idx.flush()
    expect(ids(idx, 'words')).toEqual([`${a.id}/1`])
    expect(ids(idx, 'fresh')).toEqual([`${a.id}/1`])
  })

  it('logs a chat it cannot read by id only', async () => {
    const a = await store.create('alpha', '/a')
    const idx = new SearchIndex({
      store: {
        list: () => store.list(),
        loadItems: async () => {
          throw new Error('EACCES: /secret/path')
        }
      },
      log: (l) => logged.push(l)
    })
    idx.start()
    await idx.whenBuilt()
    expect(logged).toEqual([`search index: skipped ${a.id}`])
  })

  it('compacts once dead entries outweigh live ones, and still finds everything', () => {
    const idx = index()
    // 6000 messages, then each rewritten: the first set dies.
    const items = (word: string): ChatItem[] => Array.from({ length: 6000 }, (_, i) => user(`m${i}`, `${word} ${i}`, i))
    idx.note('c', items('alpha'))
    idx.flush()
    idx.note('c', items('beta'))
    idx.flush()
    expect(idx.size()).toBe(6000)
    expect(idx.search('alpha', 0, all).total).toBe(0)
    expect(idx.search('beta', 0, all).total).toBe(6000)
    expect(ids(idx, '"beta 42"')).toEqual(['c/m42'])
  })

  it('a stop ends the build between chats', async () => {
    for (let i = 0; i < 3; i++) await store.saveItems((await store.create('alpha', '/a')).id, [user('1', `chat ${i}`, i)])
    const idx = index()
    idx.start()
    await idx.stop()
    expect(idx.size()).toBeLessThan(3)
    expect(idx.search('chat', 0, all).indexing).toBe(true)
  })

  it('stops indexing after stop', async () => {
    const idx = index()
    await idx.stop()
    idx.note('c', [user('1', 'late', 1)])
    idx.flush()
    expect(idx.size()).toBe(0)
  })
})

describe('SearchIndex time range', () => {
  it('keeps only hits inside from and to, both inclusive', () => {
    const idx = index()
    idx.note('c', [user('old', 'we decided on postgres', 100), reply('mid', 'decided: postgres it is', 200), user('new', 'postgres decided', 300)])
    idx.flush()
    const at = (range: { from?: number; to?: number }) => idx.search('decided', 0, all, 30, range).hits.map((h) => h.itemId)
    expect(at({})).toEqual(['new', 'mid', 'old'])
    expect(at({ from: 200 })).toEqual(['new', 'mid'])
    expect(at({ to: 200 })).toEqual(['mid', 'old'])
    expect(at({ from: 150, to: 250 })).toEqual(['mid'])
    expect(idx.search('decided', 0, all, 30, { from: 150, to: 250 }).total).toBe(1)
  })
})

describe('searchableOf', () => {
  it('is what the index holds: user and agent text, never a Run result or a tool', async () => {
    const { searchableOf } = await import('../../src/core/search/searchIndex')
    expect(searchableOf(user('u', 'hi', 5, 'bob'))).toEqual({ role: 'user', agent: 'bob', ts: 5, text: 'hi' })
    expect(searchableOf(reply('a', 'yo', 6, 'ann'))).toEqual({ role: 'assistant', agent: 'ann', ts: 6, text: 'yo' })
    expect(searchableOf(reply('e', '  ', 6))).toBeNull()
    expect(searchableOf(tool('t', 'x'))).toBeNull()
  })
})
