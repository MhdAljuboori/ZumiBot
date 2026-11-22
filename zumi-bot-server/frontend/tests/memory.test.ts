import { describe, expect, it } from 'vitest'
import type { MemoryEntry, MemoryInput, MemoryList } from '@zumibot/shared/memory'
import { groupMemories, keepDraftOnConflict, limitState, matchesMemory, typeChoices, visibleMemories } from '../src/state/memory'

const e = (o: Partial<MemoryEntry>): MemoryEntry => ({
  file: 'a.md',
  name: 'a',
  title: 'A',
  description: '',
  type: null,
  body: '',
  modified: 0,
  indexLine: null,
  ...o
})

describe('matchesMemory', () => {
  const m = e({ title: 'Deploy Rules', description: 'before shipping', name: 'deploy', body: 'Run bump first' })
  it('matches every word anywhere, case-insensitive', () => {
    expect(matchesMemory(m, 'BUMP shipping')).toBe(true)
    expect(matchesMemory(m, 'deploy rules')).toBe(true)
  })
  it('fails when one word is missing', () => expect(matchesMemory(m, 'bump nothing')).toBe(false))
  it('empty query matches all', () => {
    expect(matchesMemory(m, '')).toBe(true)
    expect(matchesMemory(m, '   ')).toBe(true)
  })
})

describe('visibleMemories', () => {
  const list = [e({ file: 'a.md', title: 'Alpha' }), e({ file: 'b.md', title: 'Beta' })]
  it('keeps the open row even when the search does not match it', () => {
    expect(visibleMemories(list, 'beta', 'a.md').map((x) => x.file)).toEqual(['a.md', 'b.md'])
    expect(visibleMemories(list, 'beta', null).map((x) => x.file)).toEqual(['b.md'])
  })
})

describe('groupMemories', () => {
  it('orders groups, drops empty, newest first, odd types to other', () => {
    const g = groupMemories([
      e({ file: '1', type: 'project', modified: 1 }),
      e({ file: '2', type: 'user', modified: 1 }),
      e({ file: '3', type: 'user', modified: 5 }),
      e({ file: '4', type: 'preference', modified: 1 }),
      e({ file: '5', type: null, modified: 9 })
    ])
    expect(g.map((x) => [x.key, x.label])).toEqual([
      ['user', 'User'],
      ['project', 'Project'],
      ['other', 'Other']
    ])
    expect(g[0].entries.map((x) => x.file)).toEqual(['3', '2'])
    expect(g[2].entries.map((x) => x.file)).toEqual(['5', '4'])
  })
})

describe('limitState', () => {
  it('maps counts', () => {
    expect(limitState(99, 100)).toBe('room')
    expect(limitState(100, 100)).toBe('full')
    expect(limitState(101, 100)).toBe('over')
  })
})

describe('typeChoices', () => {
  it('lists the four, plus an odd current', () => {
    expect(typeChoices(null)).toEqual(['user', 'feedback', 'project', 'reference', null])
    expect(typeChoices('user')).toEqual(['user', 'feedback', 'project', 'reference'])
    expect(typeChoices('user')).toHaveLength(4)
    expect(typeChoices('preference').at(-1)).toBe('preference')
  })
})

describe('keepDraftOnConflict', () => {
  it('returns the fresh entry and the untouched draft', () => {
    const draft: MemoryInput = { title: 't', description: 'd', type: null, body: 'mine' }
    const fresh = e({ file: 'x.md', body: 'theirs' })
    const list = { entries: [fresh] } as MemoryList
    expect(keepDraftOnConflict(draft, list, 'x.md')).toEqual({ entry: fresh, draft })
    expect(keepDraftOnConflict(draft, list, 'gone.md').entry).toBeNull()
  })
})
