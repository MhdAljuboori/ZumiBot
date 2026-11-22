import { describe, expect, it } from 'vitest'
import type { AgentSummary } from '@zumibot/shared/types'
import { addPhrase, aliasAgents, cleanAliases, removePhrase, sameAliases, setPhrase, talkAgents } from '../src/state/talkSettings'

const agent = (name: string, extra: Partial<AgentSummary> = {}): AgentSummary => ({
  filePath: `/a/${name}.md`,
  name,
  description: '',
  color: null,
  icon: null,
  error: null,
  builtIn: false,
  ...extra
})

describe('talkAgents', () => {
  it('lists loadable agents, Codex ones too, never Zumi Bot or broken ones', () => {
    const list = [
      agent('a'),
      agent('zumi-bot', { builtIn: true }),
      agent('c', { provider: 'codex' }),
      agent('d', { error: 'bad' }),
      agent('e')
    ]
    expect(talkAgents(list).map((a) => a.name)).toEqual(['a', 'c', 'e'])
  })
})

describe('talkAgents and remote agents', () => {
  it('leaves a remote agent out: a voice request is never sent to one (and aliases for it are not edited)', () => {
    const list = [agent('a'), agent('r', { provider: 'ag-ui', remoteHost: 'agents.example.com' }), agent('g', { provider: 'acp' })]
    expect(talkAgents(list).map((a) => a.name)).toEqual(['a', 'g'])
    expect(aliasAgents(list, {})).toEqual(['a', 'g'])
  })
})

describe('aliasAgents', () => {
  it('adds an agent that is gone but still has aliases', () => {
    expect(aliasAgents([agent('a')], { a: ['x'], gone: ['y'] })).toEqual(['a', 'gone'])
  })
})

describe('alias editing', () => {
  it('adds, sets and removes without touching the input', () => {
    const d = { a: ['x'] }
    const added = addPhrase(d, 'a')
    expect(added).toEqual({ a: ['x', ''] })
    expect(d).toEqual({ a: ['x'] })
    expect(setPhrase(added, 'a', 1, 'y')).toEqual({ a: ['x', 'y'] })
    expect(removePhrase({ a: ['x', 'y'] }, 'a', 0)).toEqual({ a: ['y'] })
    expect(addPhrase({}, 'b')).toEqual({ b: [''] })
  })
  it('ignores a bad index and a full list', () => {
    const d = { a: ['x'] }
    expect(setPhrase(d, 'a', 5, 'y')).toBe(d)
    expect(removePhrase(d, 'z', 0)).toBe(d)
    const full = { a: Array.from({ length: 10 }, (_, i) => `p${i}`) }
    expect(addPhrase(full, 'a')).toBe(full)
  })
})

describe('cleanAliases', () => {
  it('trims, drops blanks and agents left empty', () => {
    expect(cleanAliases({ a: [' x ', '', '  '], b: [''], c: ['y'] })).toEqual({ a: ['x'], c: ['y'] })
  })
  it('compares', () => {
    expect(sameAliases({ a: ['x'] }, { a: ['x'] })).toBe(true)
    expect(sameAliases({ a: ['x'] }, { a: ['y'] })).toBe(false)
  })
})
