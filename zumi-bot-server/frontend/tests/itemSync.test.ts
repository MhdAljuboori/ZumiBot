import { describe, expect, it } from 'vitest'
import { loadFailed, loadStarted, onItemsPush, onLoaded, unsynced } from '../src/state/itemSync'
import type { ItemsPush } from '../src/state/chatView'

const push = (seq: number, base: number | null, from = 0): ItemsPush => ({
  chatId: 'c1',
  kind: 'items',
  seq,
  base,
  from,
  items: [],
  clearStreaming: false
})

describe('onItemsPush', () => {
  it('takes a fresh list whatever the chat holds, from where it starts', () => {
    expect(onItemsPush(unsynced, push(4, null, 30), true)).toEqual({
      next: { held: 4, start: 30, loading: false, missed: 0 },
      take: true,
      reload: false
    })
  })

  it('takes a delta on the list the chat holds', () => {
    const r = onItemsPush({ held: 4, start: 0, loading: false, missed: 0 }, push(5, 4, 2), true)
    expect(r).toEqual({ next: { held: 5, start: 0, loading: false, missed: 0 }, take: true, reload: false })
  })

  it('drops a delta that changes items before the loaded ones, and reloads', () => {
    const r = onItemsPush({ held: 4, start: 10, loading: false, missed: 0 }, push(5, 4, 9), true)
    expect(r).toEqual({ next: { held: null, start: 10, loading: false, missed: 0 }, take: false, reload: true })
  })

  it('drops a delta on another list and reloads a chat the user has loaded', () => {
    const r = onItemsPush({ held: 3, start: 0, loading: false, missed: 0 }, push(5, 4), true)
    expect(r).toEqual({ next: { held: null, start: 0, loading: false, missed: 0 }, take: false, reload: true })
  })

  it('drops a delta for a chat never loaded without reloading it; opening it loads it', () => {
    expect(onItemsPush(unsynced, push(5, 4), false)).toMatchObject({ take: false, reload: false })
  })

  it('while a load is out, remembers the newest dropped push instead of loading again', () => {
    const loading = loadStarted(unsynced)
    const a = onItemsPush(loading, push(5, 4), true)
    const b = onItemsPush(a.next, push(6, 5), true)
    expect(b).toEqual({ next: { held: null, start: null, loading: true, missed: 6 }, take: false, reload: false })
  })
})

describe('onLoaded', () => {
  it('takes the loaded page when the chat holds none', () => {
    expect(onLoaded(loadStarted(unsynced), 7, 40)).toEqual({
      next: { held: 7, start: 40, loading: false, missed: 0 },
      take: true,
      reload: false
    })
  })

  it('keeps a newer list a push brought while it loaded', () => {
    const pushed = onItemsPush(loadStarted(unsynced), push(9, null, 5), true).next
    expect(onLoaded(pushed, 7, 40)).toEqual({ next: { held: 9, start: 5, loading: false, missed: 0 }, take: false, reload: false })
  })

  it('takes the page and reloads when a push dropped meanwhile is newer than it', () => {
    const dropped = onItemsPush(loadStarted(unsynced), push(8, 7), true).next
    expect(onLoaded(dropped, 7, 0)).toEqual({ next: { held: 7, start: 0, loading: false, missed: 0 }, take: true, reload: true })
  })

  it('does not reload when the load already has the dropped push', () => {
    const dropped = onItemsPush(loadStarted(unsynced), push(8, 7), true).next
    expect(onLoaded(dropped, 8, 0)).toMatchObject({ take: true, reload: false })
  })
})

it('a failed load leaves the chat unsynced and not loading', () => {
  expect(loadFailed(loadStarted({ ...unsynced, missed: 3 }))).toEqual(unsynced)
})
