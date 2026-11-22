import { describe, expect, it } from 'vitest'
import { ISLAND_AGENTS_MAX, ISLAND_PATH, cleanAgentList, cleanHotkey, parseIslandOpenTarget } from '@zumibot/shared/island'

describe('constants', () => {
  it('names the island page and the agent cap', () => {
    expect(ISLAND_PATH).toBe('/island')
    expect(ISLAND_AGENTS_MAX).toBe(10)
  })
})

describe('cleanAgentList', () => {
  it('keeps the first of each valid name and drops empty or control-character ones', () => {
    expect(cleanAgentList(['a', 'b', 'a', '', 'x\u0007'])).toEqual(['a', 'b'])
  })
  it('caps the list and rejects a non-array', () => {
    expect(cleanAgentList(Array.from({ length: 12 }, (_, i) => `a${i}`))).toHaveLength(10)
    expect(cleanAgentList('a')).toBeNull()
    expect(cleanAgentList(null)).toBeNull()
  })
  it('drops non-strings and names over 100 characters', () => {
    expect(cleanAgentList([1, null, 'a'.repeat(101), 'a'.repeat(100)])).toEqual(['a'.repeat(100)])
  })
})

describe('parseIslandOpenTarget', () => {
  it('takes a chat with no live view, or no chat', () => {
    expect(parseIslandOpenTarget({ chatId: 'c1', live: null })).toEqual({ chatId: 'c1', live: null })
    expect(parseIslandOpenTarget({ chatId: null, live: null })).toEqual({ chatId: null, live: null })
  })
  it('takes a desktop live view with or without a point', () => {
    expect(parseIslandOpenTarget({ chatId: 'c1', live: { kind: 'desktop', agent: 'a', point: { x: 1, y: 2 } } })?.live?.kind).toBe(
      'desktop'
    )
    expect(parseIslandOpenTarget({ chatId: 'c1', live: { kind: 'desktop', agent: 'a', point: null } })?.live).toEqual({
      kind: 'desktop',
      agent: 'a',
      point: null
    })
  })
  it('takes a handoff live view', () => {
    const live = { kind: 'handoff', surface: 'browser', target: { agent: 'a', chatId: 'c1', requestId: 'r1' } }
    expect(parseIslandOpenTarget({ chatId: 'c1', live })).toEqual({ chatId: 'c1', live })
  })
  it('refuses extra keys at every level', () => {
    expect(parseIslandOpenTarget({ chatId: 'c1', live: null, extra: 1 })).toBeNull()
    expect(parseIslandOpenTarget({ chatId: 'c1', live: { kind: 'desktop', agent: 'a', point: null, x: 1 } })).toBeNull()
    expect(
      parseIslandOpenTarget({
        chatId: 'c1',
        live: { kind: 'handoff', surface: 'desktop', target: { agent: 'a', chatId: 'c', requestId: 'r', z: 1 } }
      })
    ).toBeNull()
  })
  it('refuses non-finite points, long ids and garbage', () => {
    expect(parseIslandOpenTarget({ chatId: 'c1', live: { kind: 'desktop', agent: 'a', point: { x: NaN, y: 0 } } })).toBeNull()
    expect(parseIslandOpenTarget({ chatId: 'c'.repeat(201), live: null })).toBeNull()
    expect(
      parseIslandOpenTarget({ chatId: 'c1', live: { kind: 'handoff', surface: 'tv', target: { agent: 'a', chatId: 'c', requestId: 'r' } } })
    ).toBeNull()
    expect(parseIslandOpenTarget({ chatId: 'c1', live: { kind: 'other' } })).toBeNull()
    for (const v of [null, undefined, 5, 'x', [], {}, { chatId: 1, live: null }]) expect(parseIslandOpenTarget(v)).toBeNull()
  })
})

describe('cleanHotkey', () => {
  it('keeps a valid accelerator and refuses the rest', () => {
    expect(cleanHotkey('Ctrl+Alt+Space')).toBe('Ctrl+Alt+Space')
    expect(cleanHotkey('Space')).toBeNull()
    expect(cleanHotkey('Ctrl+Alt+Space; rm')).toBeNull()
    expect(cleanHotkey(7)).toBeNull()
  })
})
