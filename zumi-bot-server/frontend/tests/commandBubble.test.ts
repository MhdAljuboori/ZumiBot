import { describe, expect, it } from 'vitest'
import type { AgentSummary } from '@zumibot/shared/types'
import { chipBroken, leadChips, startsWithCommand, toggled } from '../src/state/commandBubble'

const agent = (over: Partial<AgentSummary> = {}): AgentSummary =>
  ({
    filePath: '/a.md',
    name: 'bot',
    description: '',
    color: null,
    icon: null,
    memory: null,
    memoryLimit: null,
    error: null,
    builtIn: false,
    commands: [{ name: 'check', description: 'Check a card' }],
    ...over
  }) as AgentSummary

describe('startsWithCommand', () => {
  it('is true when the text begins with /name followed by space or end', () => {
    expect(startsWithCommand('/check https://x', 'check')).toBe(true)
    expect(startsWithCommand('/check', 'check')).toBe(true)
  })
  it('is false for another name, a longer name, a later slash or no slash', () => {
    expect(startsWithCommand('/checks x', 'check')).toBe(false)
    expect(startsWithCommand('/check-all x', 'check')).toBe(false)
    expect(startsWithCommand('see /check', 'check')).toBe(false)
    expect(startsWithCommand('check', 'check')).toBe(false)
  })
})

describe('chipBroken', () => {
  it('is false for a loadable agent that still lists the command', () => {
    expect(chipBroken(agent(), 'check')).toBe(false)
  })
  it('is true when the agent is missing, has an error, or no longer lists the command', () => {
    expect(chipBroken(undefined, 'check')).toBe(true)
    expect(chipBroken(agent({ error: 'bad' }), 'check')).toBe(true)
    expect(chipBroken(agent({ commands: [] }), 'check')).toBe(true)
    expect(chipBroken(agent({ commands: undefined }), 'check')).toBe(true)
    expect(chipBroken(agent(), 'other')).toBe(true)
  })
})

describe('toggled', () => {
  it('adds an id that is not there and removes one that is', () => {
    const open = toggled(new Set(['a']), 'b')
    expect([...open]).toEqual(['a', 'b'])
    expect([...toggled(open, 'a')]).toEqual(['b'])
  })
  it('leaves the set it was given alone', () => {
    const before = new Set(['a'])
    toggled(before, 'b')
    expect([...before]).toEqual(['a'])
  })
})

describe('leadChips', () => {
  it('lists the command alone, as before', () => {
    expect(leadChips('/check x', 'check', false)).toEqual(['check'])
  })
  it('puts todo first, then the command that follows it', () => {
    expect(leadChips('/todo /check x', 'check', true)).toEqual(['todo', 'check'])
    expect(leadChips('/todo   /check', 'check', true)).toEqual(['todo', 'check'])
  })
  it('lists todo alone for a plain /todo message', () => {
    expect(leadChips('/todo make a list', null, true)).toEqual(['todo'])
    expect(leadChips('/todo', null, true)).toEqual(['todo'])
  })
  it('stands in only for text that still starts with the name', () => {
    expect(leadChips('/check x', 'check', true)).toEqual(['check']) // a flagged command: no /todo typed
    expect(leadChips('/todos x', null, true)).toEqual([])
    expect(leadChips('/todo x', null, false)).toEqual([])
    expect(leadChips('/todo hello /check', 'check', true)).toEqual(['todo'])
    expect(leadChips('hello', 'check', false)).toEqual([])
  })
})
