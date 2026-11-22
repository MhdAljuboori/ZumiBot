import { describe, expect, it } from 'vitest'
import { NO_PICK, keepArchived, pickAll, pickRow, pickedShown } from '../src/state/archiveSelection'

const shown = ['a', 'b', 'c', 'd', 'e']

describe('pickRow', () => {
  it('ticks and unticks one row, which becomes the anchor', () => {
    const one = pickRow(NO_PICK, shown, 'b', false)
    expect(one).toEqual({ ids: ['b'], anchor: 'b' })
    expect(pickRow(one, shown, 'b', false)).toEqual({ ids: [], anchor: 'b' })
  })

  it('a shift click ticks every row from the anchor to the clicked one, either way', () => {
    const down = pickRow(pickRow(NO_PICK, shown, 'b', false), shown, 'd', true)
    expect(pickedShown(down, shown)).toEqual(['b', 'c', 'd'])
    expect(down.anchor).toBe('d')
    const up = pickRow(pickRow(NO_PICK, shown, 'e', false), shown, 'c', true)
    expect(pickedShown(up, shown)).toEqual(['c', 'd', 'e'])
  })

  it('a shift click on a ticked row unticks the range', () => {
    const all = pickAll(NO_PICK, shown)
    const anchored = pickRow(pickRow(all, shown, 'b', false), shown, 'b', false) // untick then tick again: anchor on b
    expect(pickedShown(pickRow(anchored, shown, 'd', true), shown)).toEqual(['a', 'e'])
  })

  it('a shift click without an anchor the list shows is a plain tick', () => {
    expect(pickRow(NO_PICK, shown, 'c', true)).toEqual({ ids: ['c'], anchor: 'c' })
    const hidden = { ids: ['x'], anchor: 'x' }
    expect(pickRow(hidden, shown, 'c', true)).toEqual({ ids: ['x', 'c'], anchor: 'c' })
  })
})

describe('pickedShown', () => {
  it('counts only the ticked rows the list shows, in list order', () => {
    const pick = { ids: ['d', 'x', 'a'], anchor: 'a' }
    expect(pickedShown(pick, shown)).toEqual(['a', 'd'])
    expect(pickedShown(pick, ['b'])).toEqual([])
  })
})

describe('pickAll', () => {
  it('adds every shown row and keeps ticked rows a search hides', () => {
    const pick = pickAll({ ids: ['x'], anchor: 'x' }, ['a', 'b'])
    expect([...pick.ids].sort()).toEqual(['a', 'b', 'x'])
    expect(pickedShown(pick, ['a', 'b', 'x'])).toEqual(['a', 'b', 'x'])
  })
})

describe('keepArchived', () => {
  it('drops chats that left the archive, and the anchor with them', () => {
    expect(keepArchived({ ids: ['a', 'b'], anchor: 'b' }, ['a', 'c'])).toEqual({ ids: ['a'], anchor: null })
  })

  it('returns the same pick when nothing left', () => {
    const pick = { ids: ['a'], anchor: 'a' }
    expect(keepArchived(pick, ['a', 'b'])).toBe(pick)
  })
})
