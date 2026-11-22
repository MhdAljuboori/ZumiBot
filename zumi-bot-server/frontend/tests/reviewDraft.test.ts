import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReviewComment } from '@zumibot/shared/reviewComments'
import { clearDraft, commentRow, draftCount, draftKey, loadDraft, parseDraft, saveDraft } from '../src/state/reviewDraft'

const comment = (o: Partial<ReviewComment> = {}): ReviewComment => ({
  id: 'c1',
  path: 'src/app.ts',
  from: 4,
  to: 6,
  old: false,
  quote: 'code',
  text: 'Fix this',
  at: 1,
  scope: 'uncommitted',
  ...o
})

// The node environment has no localStorage; each test installs the one it wants.
const store = (): Storage => {
  const map = new Map<string, string>()
  return {
    get length() {
      return map.size
    },
    clear: () => map.clear(),
    getItem: (k: string) => map.get(k) ?? null,
    key: (i: number) => [...map.keys()][i] ?? null,
    removeItem: (k: string) => void map.delete(k),
    setItem: (k: string, v: string) => void map.set(k, v)
  } as Storage
}

const install = (s: Storage | null): void => {
  if (s === null) vi.stubGlobal('localStorage', undefined)
  else vi.stubGlobal('localStorage', s)
}

beforeEach(() => install(store()))
afterEach(() => vi.unstubAllGlobals())

describe('parseDraft', () => {
  it('reads a stored list of comments', () => {
    expect(parseDraft(JSON.stringify([comment()]))).toEqual([comment()])
  })

  it('reads anything else as no draft, rather than half a draft', () => {
    expect(parseDraft(null)).toEqual([])
    expect(parseDraft('not json')).toEqual([])
    expect(parseDraft('{"id":"c1"}')).toEqual([])
    expect(parseDraft('[{"id":"c1"}]')).toEqual([])
    expect(parseDraft(JSON.stringify([comment(), { id: 'c2' }]))).toEqual([])
    expect(parseDraft(JSON.stringify([comment({ scope: 'weird' as ReviewComment['scope'] })]))).toEqual([])
    expect(parseDraft(JSON.stringify([comment({ from: Number.NaN })]))).toEqual([])
  })
})

describe('saveDraft and loadDraft', () => {
  it('keeps a draft per chat and brings it back', () => {
    saveDraft('chat-a', [comment()])
    saveDraft('chat-b', [comment({ id: 'c9', text: 'other' })])
    expect(loadDraft('chat-a')).toEqual([comment()])
    expect(loadDraft('chat-b')[0].text).toBe('other')
    expect(loadDraft('chat-c')).toEqual([])
  })

  it('removes the key once the draft is empty, so an unused chat leaves nothing behind', () => {
    const s = store()
    install(s)
    saveDraft('chat-a', [comment()])
    expect(s.getItem(draftKey('chat-a'))).not.toBeNull()
    clearDraft('chat-a')
    expect(s.getItem(draftKey('chat-a'))).toBeNull()
    expect(loadDraft('chat-a')).toEqual([])
  })

  it('works without storage and when storage throws', () => {
    install(null)
    expect(() => saveDraft('chat-a', [comment()])).not.toThrow()
    expect(loadDraft('chat-a')).toEqual([])
    install({
      getItem: () => {
        throw new Error('blocked')
      },
      setItem: () => {
        throw new Error('blocked')
      },
      removeItem: () => {
        throw new Error('blocked')
      }
    } as unknown as Storage)
    expect(() => saveDraft('chat-a', [comment()])).not.toThrow()
    expect(() => clearDraft('chat-a')).not.toThrow()
    expect(loadDraft('chat-a')).toEqual([])
  })
})

describe('draftCount and commentRow', () => {
  it('counts one comment and many', () => {
    expect(draftCount(1)).toBe('1 comment')
    expect(draftCount(3)).toBe('3 comments')
  })

  it('shows the range and the first line that has text', () => {
    expect(commentRow(comment({ text: '\n  first line\nsecond' }))).toEqual({ where: 'src/app.ts:4-6', first: 'first line' })
    expect(commentRow(comment({ from: 9, to: 9, text: 'one' }))).toEqual({ where: 'src/app.ts:9', first: 'one' })
  })
})
