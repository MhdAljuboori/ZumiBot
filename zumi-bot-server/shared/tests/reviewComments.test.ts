import { describe, expect, it } from 'vitest'
import {
  REVIEW_COMMENTS_MAX,
  REVIEW_EMPTY,
  REVIEW_FULL,
  REVIEW_QUOTE_MAX,
  REVIEW_TEXT_MAX,
  addComment,
  cutQuote,
  editComment,
  rangeOf,
  removeComment,
  reviewMessage,
  sortComments,
  type ReviewComment,
  type ReviewPick
} from '@zumibot/shared/reviewComments'

const pick = (o: Partial<ReviewPick> = {}): ReviewPick => ({
  path: 'src/app.ts',
  from: 40,
  to: 44,
  old: false,
  quote: '  const x = 1\n  return x',
  scope: 'uncommitted',
  ...o
})

const add = (
  comments: readonly ReviewComment[],
  text: string,
  o: Partial<ReviewPick> = {},
  id = `c${comments.length + 1}`
): ReviewComment[] => addComment(comments, pick(o), text, 1_700_000_000_000, id)

describe('addComment', () => {
  it('keeps where the comment sits, the lines it quoted and the text', () => {
    const [c] = add([], '  Hoist this.  ')
    expect(c).toEqual({
      id: 'c1',
      path: 'src/app.ts',
      from: 40,
      to: 44,
      old: false,
      quote: '  const x = 1\n  return x',
      text: 'Hoist this.',
      at: 1_700_000_000_000,
      scope: 'uncommitted'
    })
  })

  it('refuses an empty text and a draft that is full, so nothing is half stored', () => {
    expect(() => add([], '   \n  ')).toThrow(REVIEW_EMPTY)
    const full = Array.from({ length: REVIEW_COMMENTS_MAX }, (_, i) => add([], 'x', {}, `f${i}`)[0])
    expect(full).toHaveLength(REVIEW_COMMENTS_MAX)
    expect(() => add(full, 'one more')).toThrow(REVIEW_FULL)
  })

  it('cuts a long text and keeps the indentation of the quote', () => {
    const [c] = add([], 'y'.repeat(REVIEW_TEXT_MAX + 50), { quote: '\t  indented\n' })
    expect(c.text).toHaveLength(REVIEW_TEXT_MAX)
    expect(c.quote).toBe('\t  indented')
  })
})

describe('cutQuote', () => {
  it('normalises line ends, drops trailing blank lines and says how much it cut', () => {
    expect(cutQuote('a\r\nb\r\n\n')).toBe('a\nb')
    const cut = cutQuote('z'.repeat(REVIEW_QUOTE_MAX + 20))
    expect(cut.startsWith('z'.repeat(REVIEW_QUOTE_MAX))).toBe(true)
    expect(cut.endsWith('… 20 more characters not quoted')).toBe(true)
  })
})

describe('editComment and removeComment', () => {
  it('replaces one text, leaves the quote alone and refuses an empty edit', () => {
    const one = add([], 'first')
    const two = add(one, 'second', { from: 10, to: 10 }, 'c2')
    const edited = editComment(two, 'c1', 'changed')
    expect(edited.map((c) => c.text)).toEqual(['changed', 'second'])
    expect(edited[0].quote).toBe(two[0].quote)
    expect(() => editComment(two, 'c1', ' ')).toThrow(REVIEW_EMPTY)
    expect(removeComment(two, 'c1').map((c) => c.id)).toEqual(['c2'])
    expect(removeComment(two, 'nope')).toHaveLength(2)
  })
})

describe('rangeOf and sortComments', () => {
  it('writes one line as `path:n` and a range as `path:n-m`', () => {
    expect(rangeOf({ path: 'a.ts', from: 3, to: 3 })).toBe('a.ts:3')
    expect(rangeOf({ path: 'a.ts', from: 3, to: 9 })).toBe('a.ts:3-9')
  })

  it('reads by path, then up the file, then as written', () => {
    let list = add([], 'one', { path: 'z.ts', from: 5, to: 5 }, 'z5')
    list = add(list, 'two', { path: 'a.ts', from: 90, to: 91 }, 'a90')
    list = add(list, 'three', { path: 'a.ts', from: 12, to: 12 }, 'a12')
    expect(sortComments(list).map((c) => c.id)).toEqual(['a12', 'a90', 'z5'])
  })
})

describe('reviewMessage', () => {
  it('is empty with no comments', () => {
    expect(reviewMessage([])).toBe('')
  })

  it('names how many places, then each range, its quoted lines and the text', () => {
    let list = add([], 'This recomputes on every render — hoist it.')
    list = add(list, 'Why is this still here?', { from: 91, to: 91, old: true, quote: '  legacy()' }, 'c2')
    expect(reviewMessage(list)).toBe(
      'Review of 2 places in the changes.\n\n' +
        '`src/app.ts:40-44`\n```\n  const x = 1\n  return x\n```\nThis recomputes on every render — hoist it.\n\n' +
        '`src/app.ts:91` (old)\n```\n  legacy()\n```\nWhy is this still here?\n'
    )
  })

  it('says "1 place" for one comment and marks one made on the base diff', () => {
    const list = add([], 'Needs a test.', { from: 7, to: 7, scope: 'base', quote: 'export const f = () => 1' })
    expect(list[0].scope).toBe('base')
    expect(reviewMessage(list)).toBe(
      'Review of 1 place in the changes.\n\n`src/app.ts:7` (since start)\n```\nexport const f = () => 1\n```\nNeeds a test.\n'
    )
  })

  it('marks both sides when the lines are old ones on the base diff', () => {
    const list = add([], 'Gone where?', { old: true, scope: 'base' })
    expect(reviewMessage(list)).toContain('`src/app.ts:40-44` (old, since start)')
  })

  it('fences a quote that holds its own fences, so the lines still come through', () => {
    const list = add([], 'Escape this.', { quote: '```js\ncode\n```' })
    const text = reviewMessage(list)
    expect(text).toContain('````\n```js\ncode\n```\n````')
  })

  it('leaves out the fence when the selection quoted nothing', () => {
    const list = add([], 'Blank line here.', { quote: '' })
    expect(reviewMessage(list)).toBe('Review of 1 place in the changes.\n\n`src/app.ts:40-44`\nBlank line here.\n')
  })
})
