import { describe, expect, it } from 'vitest'
import {
  btwOf,
  isOpen,
  SIDE_ASKING_CAP_MS,
  SIDE_TIMEOUT_MS,
  sideParts,
  type SideAskLink,
  type SideQuestion,
  type SideState
} from '@zumibot/shared/btw'

describe('btwOf', () => {
  it('reads a plain question', () => expect(btwOf('/btw how many left?')).toEqual({ question: 'how many left?', mention: null }))
  it('reads a leading @member', () => expect(btwOf('/btw @coder-agent how far?')).toEqual({ question: 'how far?', mention: 'coder-agent' }))
  it.each(['/btw', '/btw   ', '/btw @x'])('has no question in %j', (t) => expect(btwOf(t)).toBeNull())
  it.each([' /btw x', '/btwx y', 'hi /btw x'])('ignores %j', (t) => expect(btwOf(t)).toBeNull())
  it('keeps a multi-line question', () => expect(btwOf('/btw line one\nline two')?.question).toBe('line one\nline two'))
})

describe('sideParts', () => {
  it('splits the mention from the question and trims', () => expect(sideParts('@a  x ')).toEqual({ question: 'x', mention: 'a' }))
  it('takes a question alone', () => expect(sideParts('x')).toEqual({ question: 'x', mention: null }))
  it('has nothing for blank text', () => expect(sideParts('  ')).toBeNull())
  it('keeps a mid-text @ inside the question', () => expect(sideParts('ask @a')).toEqual({ question: 'ask @a', mention: null }))
})

describe('isOpen', () => {
  const q = (state: SideState): SideQuestion => ({ id: 'i', question: 'q', agent: null, askedAt: 1, after: null, state, answer: '' })
  it.each([
    ['picking', true],
    ['running', true],
    ['done', false],
    ['error', false],
    ['stopped', false]
  ] as const)('%s -> %s', (s, open) => expect(isOpen(q(s))).toBe(open))
})

describe('side asks', () => {
  it('caps an asking entry at twice the plain timeout', () => {
    expect(SIDE_ASKING_CAP_MS).toBe(360_000)
    expect(SIDE_ASKING_CAP_MS).toBe(2 * SIDE_TIMEOUT_MS)
  })
  it('an entry carries who asked and its links', () => {
    const link: SideAskLink = { agent: 'b', chatId: 'ab', entryId: 'e', state: 'running' }
    const q: SideQuestion = {
      id: 'i',
      question: 'q',
      agent: 'b',
      from: 'a',
      asks: [link],
      askedAt: 1,
      after: null,
      state: 'running',
      answer: ''
    }
    expect(isOpen(q)).toBe(true)
  })
})
