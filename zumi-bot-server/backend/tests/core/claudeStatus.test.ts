import { describe, expect, it } from 'vitest'
import { describeClaude, keyVarInUse } from '../../src/core/claudeStatus'

const USER = 'bot'
const profile = { uuid: 'u1', name: 'Someone', email: 'someone@example.com', plan: 'Max' }

describe('keyVarInUse', () => {
  it('names the variable Claude Code would use, and only when it has a value', () => {
    expect(keyVarInUse({})).toBeNull()
    expect(keyVarInUse({ ANTHROPIC_API_KEY: '' })).toBeNull()
    expect(keyVarInUse({ ANTHROPIC_API_KEY: 'x' })).toBe('ANTHROPIC_API_KEY')
    expect(keyVarInUse({ CLAUDE_CODE_OAUTH_TOKEN: 'x' })).toBe('CLAUDE_CODE_OAUTH_TOKEN')
    // Claude Code prefers the bearer token over the api key.
    expect(keyVarInUse({ ANTHROPIC_API_KEY: 'x', ANTHROPIC_AUTH_TOKEN: 'y' })).toBe('ANTHROPIC_AUTH_TOKEN')
  })
})

describe('describeClaude', () => {
  it('asks for an install when the CLI is not there', () => {
    const s = describeClaude({ path: null, profile: null, keyVar: null, user: USER })
    expect(s.ready).toBe(false)
    expect(s.found).toBeNull()
    expect(s.fix).toEqual(['npm i -g @anthropic-ai/claude-code', 'claude'])
    expect(s.user).toBe(USER)
  })

  it('reports the signed-in account and its plan', () => {
    const s = describeClaude({ path: '/usr/bin/claude', profile, keyVar: null, user: USER })
    expect(s.ready).toBe(true)
    expect(s.how).toBe('someone@example.com')
    expect(s.message).toContain('someone@example.com')
    expect(s.message).toContain('Max')
    expect(s.fix).toEqual([])
  })

  it('counts a key in the environment as ready, naming the variable and never a value', () => {
    const s = describeClaude({ path: '/usr/bin/claude', profile: null, keyVar: 'ANTHROPIC_API_KEY', user: USER })
    expect(s.ready).toBe(true)
    expect(s.how).toBe('ANTHROPIC_API_KEY')
    expect(s.message).toContain('ANTHROPIC_API_KEY')
    expect(s.fix).toEqual([])
  })

  it('prefers the login over a key when both are there', () => {
    const s = describeClaude({ path: '/usr/bin/claude', profile, keyVar: 'ANTHROPIC_API_KEY', user: USER })
    expect(s.how).toBe('someone@example.com')
  })

  it('asks for a sign-in when found with no credential, without claiming the check is complete', () => {
    const s = describeClaude({ path: '/usr/bin/claude', profile: null, keyVar: null, user: USER })
    expect(s.ready).toBe(false)
    expect(s.found).toBe('/usr/bin/claude')
    expect(s.fix).toEqual(['claude'])
    expect(s.message).toMatch(/Keychain/)
  })
})
