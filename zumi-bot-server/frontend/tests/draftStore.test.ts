import { describe, expect, it } from 'vitest'
import { clearDrafts, loadDrafts, saveDrafts } from '../src/state/draftStore'

const memory = (): Storage => {
  const m = new Map<string, string>()
  return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => void m.set(k, v), removeItem: (k) => void m.delete(k) } as Storage
}

describe('draftStore', () => {
  it('round-trips non-empty drafts under zumibot:drafts', () => {
    const s = memory()
    saveDrafts(s, { a: 'hello', b: '', c: '  ' })
    expect(s.getItem('zumibot:drafts')).toBe(JSON.stringify({ a: 'hello' }))
    expect(loadDrafts(s)).toEqual({ a: 'hello' })
  })

  it('returns {} for missing or corrupt data', () => {
    const s = memory()
    expect(loadDrafts(s)).toEqual({})
    s.setItem('zumibot:drafts', '{bad')
    expect(loadDrafts(s)).toEqual({})
    s.setItem('zumibot:drafts', '{"a":1,"b":"ok"}')
    expect(loadDrafts(s)).toEqual({ b: 'ok' })
  })

  it('never throws when storage is unavailable', () => {
    const bad = {
      getItem: () => {
        throw new Error('x')
      },
      setItem: () => {
        throw new Error('x')
      }
    } as unknown as Storage
    expect(() => saveDrafts(bad, { a: 'x' })).not.toThrow()
    expect(loadDrafts(bad)).toEqual({})
    expect(loadDrafts(null)).toEqual({})
  })

  it('loadDrafts consumes the key: a second load is empty', () => {
    const s = memory()
    saveDrafts(s, { a: 'hello' })
    expect(loadDrafts(s)).toEqual({ a: 'hello' })
    expect(s.getItem('zumibot:drafts')).toBeNull()
    expect(loadDrafts(s)).toEqual({})
  })

  it('clearDrafts removes the key', () => {
    const s = memory()
    saveDrafts(s, { a: 'x' })
    clearDrafts(s)
    expect(s.getItem('zumibot:drafts')).toBeNull()
  })
})
