import { describe, expect, it } from 'vitest'
import { isCodexChat } from '../../src/core/codex/isCodexChat'
import type { AgentSummary } from '@zumibot/shared/types'

const agent = (name: string, provider?: 'codex'): AgentSummary => ({
  filePath: `/a/${name}.md`,
  name,
  description: '',
  color: null,
  icon: null,
  error: null,
  builtIn: false,
  ...(provider ? { provider } : {})
})
const agents = [agent('cl'), agent('cx', 'codex')]

describe('isCodexChat', () => {
  it('is true for a chat whose agent is on Codex', () => {
    expect(isCodexChat({ agentName: 'cx' }, agents)).toBe(true)
  })
  it('is true for a chat that holds a Codex session even when its agent is back on Claude', () => {
    expect(isCodexChat({ agentName: 'cl', sessionEngine: 'codex' }, agents)).toBe(true)
  })
  it('is false for a Claude chat, an unknown agent and a room', () => {
    expect(isCodexChat({ agentName: 'cl' }, agents)).toBe(false)
    expect(isCodexChat({ agentName: 'gone' }, agents)).toBe(false)
    expect(isCodexChat({ agentName: 'cx', group: { members: ['cx', 'cl'] } as never }, agents)).toBe(false)
  })
})
