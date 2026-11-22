import { describe, expect, it } from 'vitest'
import { groupRole, memberList, refuseCodexMembers, validateNewGroupMembers } from '../../src/core/groupMembers'
import { ROLE_MAX_CHARS, type AgentSummary } from '@zumibot/shared/types'
import { CODEX_REFUSALS, engineCaps, type Engine } from '@zumibot/shared/engine'

// A later probe turning Codex rooms off: every room refusal comes back.
const noRooms = (e: Engine) => ({ ...engineCaps(e), ...(e === 'codex' ? { rooms: false } : {}) })

const agent = (name: string, error: string | null = null): AgentSummary => ({
  filePath: `/a/${name}.md`,
  name,
  description: '',
  color: null,
  icon: null,
  error,
  builtIn: false
})
const agents = [agent('alpha'), agent('beta'), agent('broken', 'bad'), agent('zumi-bot'), { ...agent('cx'), provider: 'codex' as const }]

describe('memberList', () => {
  it('dedupes strings and rejects non-arrays and non-strings', () => {
    expect(memberList(['a', 'a', 'b'])).toEqual(['a', 'b'])
    expect(() => memberList('a')).toThrow(TypeError)
    expect(() => memberList(['a', 1])).toThrow(TypeError)
  })
})

describe('validateNewGroupMembers', () => {
  it('accepts two or more existing agents', () => {
    expect(validateNewGroupMembers(['alpha', 'beta'], agents)).toEqual(['alpha', 'beta'])
  })
  it('rejects too few (after dedupe), Zumi Bot, unknown and errored agents', () => {
    expect(() => validateNewGroupMembers(['alpha', 'alpha'], agents)).toThrow(/at least 2/)
    expect(() => validateNewGroupMembers(['alpha', 'zumi-bot'], agents)).toThrow(/Zumi Bot/)
    expect(() => validateNewGroupMembers(['alpha', 'ghost'], agents)).toThrow(/ghost/)
    expect(() => validateNewGroupMembers(['alpha', 'broken'], agents)).toThrow(/broken/)
  })
  it('takes a Codex agent while Codex rooms are on', () => {
    expect(validateNewGroupMembers(['alpha', 'cx'], agents)).toEqual(['alpha', 'cx'])
    expect(() => refuseCodexMembers(['alpha', 'cx'], agents)).not.toThrow()
  })
  it('with Codex rooms off, refuses a Codex agent with the fixed room sentence', () => {
    expect(() => validateNewGroupMembers(['alpha', 'cx'], agents, noRooms)).toThrow(CODEX_REFUSALS.room('cx'))
    expect(() => refuseCodexMembers(['alpha', 'cx'], agents, noRooms)).toThrow(CODEX_REFUSALS.room('cx'))
    expect(validateNewGroupMembers(['alpha', 'beta'], agents, noRooms)).toEqual(['alpha', 'beta'])
  })
})

describe('groupRole', () => {
  it('accepts a string up to the limit and rejects longer ones and non-strings', () => {
    expect(ROLE_MAX_CHARS).toBe(4000)
    expect(groupRole('')).toBe('')
    expect(groupRole('x'.repeat(ROLE_MAX_CHARS))).toHaveLength(ROLE_MAX_CHARS)
    expect(() => groupRole('x'.repeat(ROLE_MAX_CHARS + 1))).toThrow(/at most 4000 characters/)
    expect(() => groupRole(3)).toThrow(TypeError)
  })
})
