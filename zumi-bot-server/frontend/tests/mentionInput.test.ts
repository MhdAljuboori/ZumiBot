import { describe, expect, it } from 'vitest'
import type { AgentSummary } from '@zumibot/shared/types'
import { everyoneMatches, filterMembers, insertMention, mentionOptionName, mentionOptions, mentionQuery } from '../src/state/mentionInput'

const agent = (name: string): AgentSummary => ({
  filePath: `/agents/${name}.md`,
  name,
  description: '',
  color: null,
  icon: null,
  error: null,
  builtIn: false
})

describe('mentionQuery', () => {
  it('finds the @word before the caret', () => {
    expect(mentionQuery('hi @ui', 6)).toEqual({ start: 3, query: 'ui' })
    expect(mentionQuery('@', 1)).toEqual({ start: 0, query: '' })
    expect(mentionQuery('a\n@x', 4)).toEqual({ start: 2, query: 'x' })
  })
  it('ignores an @ inside a word and a finished mention', () => {
    expect(mentionQuery('a@b', 3)).toBeNull()
    expect(mentionQuery('@ui x', 5)).toBeNull()
    expect(mentionQuery('no mention', 10)).toBeNull()
  })
  it('only looks left of the caret', () => {
    expect(mentionQuery('hi @ui-ux', 6)).toEqual({ start: 3, query: 'ui' })
  })
})

describe('filterMembers', () => {
  const members = [agent('ui-ux-specialist'), agent('writer'), agent('qa')]
  it('matches a name or display-name prefix, case-insensitively', () => {
    expect(filterMembers('ui', members).map((m) => m.name)).toEqual(['ui-ux-specialist'])
    expect(filterMembers('UI-UX', members).map((m) => m.name)).toEqual(['ui-ux-specialist'])
    expect(filterMembers('ux', members)).toEqual([])
    expect(filterMembers('w', members).map((m) => m.name)).toEqual(['writer'])
  })
  it('returns everyone for an empty query', () => {
    expect(filterMembers('', members)).toHaveLength(3)
  })
})

describe('insertMention', () => {
  it('replaces the typed @query with the full handle and a space', () => {
    expect(insertMention('hi @ui', { start: 3, query: 'ui' }, 6, 'ui-ux-specialist')).toEqual({
      text: 'hi @ui-ux-specialist ',
      caret: 21
    })
  })
  it('keeps the text after the caret', () => {
    expect(insertMention('@u there', { start: 0, query: 'u' }, 2, 'qa')).toEqual({ text: '@qa  there', caret: 4 })
  })
})

describe('everyoneMatches', () => {
  it('matches an empty query and any start of everyone, case-insensitively', () => {
    expect(everyoneMatches('')).toBe(true)
    expect(everyoneMatches('e')).toBe(true)
    expect(everyoneMatches('EVERY')).toBe(true)
    expect(everyoneMatches('everyone')).toBe(true)
    expect(everyoneMatches('everyones')).toBe(false)
    expect(everyoneMatches('ui')).toBe(false)
  })
})

describe('mentionOptions', () => {
  const members = [agent('ui-ux-specialist'), agent('writer'), agent('qa')]
  it('puts everyone first in a room when it fits the query', () => {
    expect(mentionOptions('', members, true).map(mentionOptionName)).toEqual(['everyone', 'ui-ux-specialist', 'writer', 'qa'])
    expect(mentionOptions('ev', members, true).map(mentionOptionName)).toEqual(['everyone'])
    expect(mentionOptions('w', members, true).map(mentionOptionName)).toEqual(['writer'])
  })
  it('never offers everyone where it is off (a single chat)', () => {
    expect(mentionOptions('', members, false).map(mentionOptionName)).toEqual(['ui-ux-specialist', 'writer', 'qa'])
    expect(mentionOptions('ev', members, false)).toEqual([])
  })
})
