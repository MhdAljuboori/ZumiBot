import { describe, expect, it } from 'vitest'
import {
  ITEM_CUT_NOTE,
  concurrencyKey,
  concurrencyOf,
  itemCounts,
  itemsFailedText,
  joinItemOutputs,
  newItems,
  nextPending,
  openVisitStatus,
  parseItems,
  retryItems,
  startPending
} from '../src/workflowForEach'
import { progressOf } from '../src/workflows'
import type { ItemRun, Visit } from '../src/workflows'

const ids = () => {
  let i = 0
  return () => `n${++i}`
}
const item = (over: Partial<ItemRun>): ItemRun => ({ id: 'i', n: 1, text: 'T', status: 'pending', ...over })

describe('parseItems', () => {
  it('trims lines, drops empty ones and exact repeats, keeps order', () => {
    expect(parseItems(' Parent-120 Home Page \n\n Inbox\nInbox\r\nGrid')).toEqual({ items: ['Parent-120 Home Page', 'Inbox', 'Grid'] })
    expect(parseItems('')).toEqual({ items: [] })
  })

  it('refuses more than 100 items', () => {
    const text = Array.from({ length: 101 }, (_, i) => `item ${i}`).join('\n')
    expect(parseItems(text)).toEqual({ error: 'The list has 101 items; the most is 100' })
  })

  it('refuses an item over 1 000 characters', () => {
    expect(parseItems(`a\nb\n${'x'.repeat(1001)}`)).toEqual({ error: 'Item 3 is over 1 000 characters' })
    expect(parseItems(`a\n${'x'.repeat(1000)}`)).toEqual({ items: ['a', 'x'.repeat(1000)] })
  })
})

describe('items helpers', () => {
  it('newItems makes pending items numbered from 1', () => {
    expect(newItems(['a', 'b'], ids())).toEqual([
      { id: 'n1', n: 1, text: 'a', status: 'pending' },
      { id: 'n2', n: 2, text: 'b', status: 'pending' }
    ])
  })

  it('itemCounts and nextPending', () => {
    const items = [
      item({ id: 'a', status: 'done' }),
      item({ id: 'b', status: 'failed' }),
      item({ id: 'c' }),
      item({ id: 'd', status: 'running' }),
      item({ id: 'e' })
    ]
    expect(itemCounts(items)).toEqual({ done: 1, failed: 1, pending: 2, total: 5 })
    expect(nextPending(items)?.id).toBe('c')
    expect(nextPending([item({ status: 'done' })])).toBeUndefined()
  })

  it('itemsFailedText', () => {
    expect(itemsFailedText(2, 36)).toBe('2 of 36 items failed')
  })
})

describe('joinItemOutputs', () => {
  it('heads each reply with its item', () => {
    expect(
      joinItemOutputs([
        { text: 'A', output: 'x' },
        { text: 'B', output: 'y' }
      ])
    ).toBe('## A\n\nx\n\n## B\n\ny')
  })

  it('gives each item an equal share of 100 000', () => {
    const out = joinItemOutputs(['A', 'B', 'C'].map((text) => ({ text, output: 'z'.repeat(60_000) })))
    expect(out.length).toBeLessThanOrEqual(100_000)
    for (const h of ['## A', '## B', '## C']) expect(out).toContain(h)
    const sections = out.split('\n\n## ')
    expect(sections).toHaveLength(3)
    for (const s of sections) expect(s.endsWith(ITEM_CUT_NOTE)).toBe(true)
  })
})

describe('joinItemOutputs caps', () => {
  it('keeps 100 items with 1 000-character texts within the cap and adds no false note', () => {
    const items = Array.from({ length: 100 }, (_, i) => ({ text: `${i}`.padEnd(1000, 'h'), output: i % 2 ? '' : undefined }))
    const out = joinItemOutputs(items)
    expect(out.length).toBeLessThanOrEqual(100_000)
    expect(out).not.toContain(ITEM_CUT_NOTE)
    expect(out.split('\n\n## ')).toHaveLength(100)
  })

  it('treats an undefined output as empty, and handles one item and none', () => {
    expect(joinItemOutputs([{ text: 'A' }])).toBe('## A\n\n')
    expect(joinItemOutputs([])).toBe('')
    const one = joinItemOutputs([{ text: 'A', output: 'q'.repeat(150_000) }])
    expect(one.length).toBeLessThanOrEqual(100_000)
    expect(one.endsWith(ITEM_CUT_NOTE)).toBe(true)
  })

  it('does not cut a reply that exactly fits its share, and cuts one char more', () => {
    const fit = 'q'.repeat(100_000 - '## A'.length - 2)
    expect(joinItemOutputs([{ text: 'A', output: fit }])).toBe(`## A\n\n${fit}`)
    const over = joinItemOutputs([{ text: 'A', output: `${fit}q` }])
    expect(over.length).toBeLessThanOrEqual(100_000)
    expect(over.endsWith(ITEM_CUT_NOTE)).toBe(true)
  })
})

describe('retryItems', () => {
  it('carries done items and resets failed and pending ones', () => {
    const items = [
      item({ id: 'a', n: 1, text: 'A', status: 'done', chatId: 'c1', output: 'x', costUsd: 1, startedAt: 1, endedAt: 2 }),
      item({
        id: 'b',
        n: 2,
        text: 'B',
        status: 'failed',
        chatId: 'c2',
        error: 'boom',
        messageId: 'm',
        output: 'o',
        until: 5,
        startedAt: 3,
        endedAt: 4
      }),
      item({ id: 'c', n: 3, text: 'C' })
    ]
    const out = retryItems(items, ids())
    expect(out[0]).toMatchObject({ n: 1, status: 'done', carried: true, output: 'x', chatId: 'c1', costUsd: 1 })
    expect(out[1]).toEqual({ id: expect.any(String), n: 2, text: 'B', status: 'pending', chatId: 'c2' })
    expect(out[2]).toEqual({ id: expect.any(String), n: 3, text: 'C', status: 'pending' })
    expect(new Set(out.map((i) => i.id)).size).toBe(3)
    expect(out.some((i) => ['a', 'b', 'c'].includes(i.id))).toBe(false)
  })

  it('with one item id resets only that item', () => {
    const items = [
      item({ id: 'b', n: 1, text: 'B', status: 'failed', error: 'e1' }),
      item({ id: 'c', n: 2, text: 'C', status: 'failed', error: 'e2' })
    ]
    const out = retryItems(items, ids(), 'b')
    expect(out[0]).toMatchObject({ status: 'pending' })
    expect(out[0].error).toBeUndefined()
    expect(out[1]).toMatchObject({ status: 'failed', carried: true, error: 'e2' })
  })
})

// A failed visit holds no pending or stopped item today (a paused item stays open), but the rule stays total.
describe('retryItems with pending or stopped items', () => {
  it('with one item id keeps a pending item pending and uncarried, and carries only done and failed ones', () => {
    const items = [
      item({ id: 'a', n: 1, status: 'done', output: 'x' }),
      item({ id: 'b', n: 2, status: 'failed', error: 'e' }),
      item({ id: 'c', n: 3, status: 'pending' }),
      item({ id: 'd', n: 4, status: 'stopped' })
    ]
    const out = retryItems(items, ids(), 'b')
    expect(out[0]).toMatchObject({ status: 'done', carried: true })
    expect(out[1]).toEqual({ id: expect.any(String), n: 2, text: 'T', status: 'pending' })
    // As they were, but under new ids too: an old id would still name the item in the earlier visit.
    expect(out[2]).toEqual({ ...items[2], id: expect.any(String) })
    expect(out[3]).toEqual({ ...items[3], id: expect.any(String) })
    expect(new Set(out.map((i) => i.id)).size).toBe(4)
    expect(out.some((i) => ['a', 'b', 'c', 'd'].includes(i.id))).toBe(false)
  })
})

describe('progressOf', () => {
  const visit = (over: Partial<Visit>): Visit => ({
    id: 'v',
    stepId: 's',
    n: 1,
    status: 'running',
    input: '',
    inputs: [],
    startedAt: 1,
    ...over
  })

  it('counts an open for each visit and names its current item', () => {
    const items = [item({ id: 'a', status: 'done' }), item({ id: 'b', text: 'Gallery View', status: 'running' }), item({ id: 'c' })]
    expect(progressOf({ visits: [visit({ items })] })).toEqual([{ stepId: 's', done: 1, failed: 0, total: 3, current: 'Gallery View' }])
  })

  it('cuts a long current item to 80', () => {
    const items = [item({ text: 'y'.repeat(200), status: 'waiting' })]
    expect(progressOf({ visits: [visit({ status: 'waiting', items })] })[0].current).toBe('y'.repeat(80))
  })

  it('gives nothing for a done visit or one without items, and counts carried done items', () => {
    expect(progressOf({ visits: [visit({ status: 'done', items: [item({ status: 'done' })] })] })).toEqual([])
    expect(progressOf({ visits: [visit({})] })).toEqual([])
    const items = [item({ id: 'a', status: 'done', carried: true }), item({ id: 'b', status: 'failed', carried: true }), item({ id: 'c' })]
    expect(progressOf({ visits: [visit({ items })] })).toEqual([{ stepId: 's', done: 1, failed: 1, total: 3, current: null }])
  })

  it('marks the progress paused while the current item is paused by the user', () => {
    const items = [item({ id: 'a', status: 'done' }), item({ id: 'b', text: 'Inbox', status: 'running', paused: true }), item({ id: 'c' })]
    expect(progressOf({ visits: [visit({ items })] })).toEqual([
      { stepId: 's', done: 1, failed: 0, total: 3, current: 'Inbox', paused: true }
    ])
    // A paused flag left on an ended item (Continued by hand) is no current item's.
    const after = [item({ id: 'a', status: 'failed', paused: true }), item({ id: 'b', text: 'Next', status: 'running' })]
    expect(progressOf({ visits: [visit({ items: after })] })[0]).toEqual({ stepId: 's', done: 0, failed: 1, total: 2, current: 'Next' })
  })
})

describe('running several items at once', () => {
  it('concurrencyOf reads 2 or 3 and treats anything else as one at a time', () => {
    expect(concurrencyOf({})).toBe(1)
    expect(concurrencyOf({ concurrency: 2 })).toBe(2)
    expect(concurrencyOf({ concurrency: 3 })).toBe(3)
    expect(concurrencyOf({ concurrency: 7 as 3 })).toBe(1)
  })

  it('concurrencyKey stores only 2 or 3', () => {
    expect(concurrencyKey(1)).toEqual({})
    expect(concurrencyKey(2)).toEqual({ concurrency: 2 })
    expect(concurrencyKey(5)).toEqual({ concurrency: 3 })
    expect(concurrencyKey(-1)).toEqual({})
  })

  it('startPending fills the free slots in list order and leaves a full list as it is', () => {
    const items = [
      item({ id: 'a', status: 'done' }),
      item({ id: 'b', status: 'running' }),
      item({ id: 'c' }),
      item({ id: 'd' }),
      item({ id: 'e' })
    ]
    const two = startPending(items, 3, 50)
    expect(two.items.map((i) => i.status)).toEqual(['done', 'running', 'running', 'running', 'pending'])
    expect(two.started.map((i) => [i.id, i.startedAt])).toEqual([
      ['c', 50],
      ['d', 50]
    ])
    const full = startPending(two.items, 3, 60)
    expect(full).toEqual({ items: two.items, started: [] })
    // A paused item keeps its slot.
    const paused = startPending([item({ id: 'p', status: 'running', paused: true }), item({ id: 'q' })], 1, 70)
    expect(paused.started).toEqual([])
  })

  it('openVisitStatus waits while any open item waits', () => {
    expect(openVisitStatus([item({ status: 'running' }), item({ status: 'waiting' })])).toBe('waiting')
    expect(openVisitStatus([item({ status: 'running' }), item({ status: 'done' })])).toBe('running')
  })

  it('progressOf counts the open items and names the first in list order', () => {
    const visit = (items: ItemRun[]): Visit => ({
      id: 'v',
      stepId: 'fe',
      n: 1,
      status: 'running',
      input: '',
      inputs: [],
      items,
      startedAt: 0
    })
    const items = [
      item({ id: 'a', text: 'A', status: 'done' }),
      item({ id: 'b', text: 'B', status: 'running', paused: true }),
      item({ id: 'c', text: 'C', status: 'waiting' }),
      item({ id: 'd', text: 'D' })
    ]
    expect(progressOf({ visits: [visit(items)] })).toEqual([
      { stepId: 'fe', done: 1, failed: 0, total: 4, current: 'B', running: 2, paused: true, pausedItems: 1 }
    ])
    expect(progressOf({ visits: [visit(items.slice(0, 2))] })).toEqual([
      { stepId: 'fe', done: 1, failed: 0, total: 2, current: 'B', paused: true }
    ])
  })
})
