import { describe, expect, it } from 'vitest'
import { filterOptions, matchesSearch, searchWords, selectedLabel, stepFocus, type SelectOption } from '../src/state/menuSearch'

const opt = (value: string, label: string, group?: string): SelectOption => ({ value, label, disabled: false, ...(group ? { group } : {}) })

describe('matchesSearch', () => {
  it('a blank query matches everything', () => {
    expect(searchWords('   ')).toEqual([])
    expect(matchesSearch('Anything', '')).toBe(true)
  })

  it('matches every word in any order, ignoring case', () => {
    expect(matchesSearch('Code Specialist', 'spec')).toBe(true)
    expect(matchesSearch('Code Specialist', 'SPECIALIST code')).toBe(true)
    expect(matchesSearch('Code Specialist', 'code merge')).toBe(false)
  })
})

describe('filterOptions', () => {
  const options = [opt('', 'Nobody'), opt('user', 'You'), opt('a', 'Merge Back', 'Agents'), opt('b', 'Release Manager', 'Agents')]

  it('keeps all options, in order, for a blank query', () => {
    expect(filterOptions(options, ' ').map((o) => o.value)).toEqual(['', 'user', 'a', 'b'])
  })

  it('keeps only the matching options', () => {
    expect(filterOptions(options, 'man').map((o) => o.value)).toEqual(['b'])
  })

  it("a group's label matches its options", () => {
    expect(filterOptions(options, 'agents').map((o) => o.value)).toEqual(['a', 'b'])
  })
})

describe('selectedLabel', () => {
  const options = [opt('x', 'Ex'), opt('y', 'Why')]
  it("names the value's option, else the first, as a native select shows", () => {
    expect(selectedLabel(options, 'y')).toBe('Why')
    expect(selectedLabel(options, 'nope')).toBe('Ex')
    expect(selectedLabel([], 'nope')).toBe('')
  })
})

describe('stepFocus', () => {
  it('goes down from the box to the first item and stops at the last', () => {
    expect(stepFocus(-1, 3, true)).toBe(0)
    expect(stepFocus(1, 3, true)).toBe(2)
    expect(stepFocus(2, 3, true)).toBe(2)
  })

  it('goes up to the box from the first item', () => {
    expect(stepFocus(2, 3, false)).toBe(1)
    expect(stepFocus(0, 3, false)).toBe(-1)
    expect(stepFocus(-1, 3, false)).toBe(-1)
  })

  it('stays in the box when nothing matches', () => {
    expect(stepFocus(-1, 0, true)).toBe(-1)
  })
})
