import { describe, expect, it } from 'vitest'
import { AGUI_TEXT } from '@zumibot/shared/agui'
import { engineCaps } from '@zumibot/shared/engine'
import type { AgentSummary } from '@zumibot/shared/types'
import { ROUTINE_PLACE, agentResolver, keptKey } from '../../src/core/automations/agentNames'
import { isSafeMessage } from '../../src/core/automations/automationIpc'

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

describe('agentResolver and remote agents', () => {
  const roster = [
    agent('alpha'),
    agent('gem', { provider: 'acp' }),
    agent('remote-one', { provider: 'ag-ui', remoteHost: 'agents.example.com' })
  ]

  it('refuses a remote agent Zumi Bot would add, with the fixed sentence, whatever place and spelling', () => {
    const resolve = agentResolver(roster)
    expect(() => resolve('remote-one')).toThrow(AGUI_TEXT.zumiBotPick('remote-one'))
    expect(() => resolve('Remote One', 'find')).toThrow(AGUI_TEXT.zumiBotPick('remote-one'))
  })
  it('resolves a remote agent only in the place that already holds it', () => {
    const resolve = agentResolver(roster, new Set([keptKey('find', 'remote-one')]))
    expect(resolve('@Remote One', 'find')).toBe('remote-one')
    // Moved to another step, a new step, or no place at all: a pick again.
    expect(() => resolve('remote-one', 'other')).toThrow(AGUI_TEXT.zumiBotPick('remote-one'))
    expect(() => resolve('remote-one')).toThrow(AGUI_TEXT.zumiBotPick('remote-one'))
    // Another remote agent in the held place is a new one too.
    const two = [...roster, agent('remote-two', { provider: 'ag-ui' })]
    expect(() => agentResolver(two, new Set([keptKey('find', 'remote-one')]))('remote-two', 'find')).toThrow(
      AGUI_TEXT.zumiBotPick('remote-two')
    )
    expect(agentResolver(roster, new Set([keptKey(ROUTINE_PLACE, 'remote-one')]))('remote-one', ROUTINE_PLACE)).toBe('remote-one')
  })
  it('leaves Claude, Codex and ACP agents as they were', () => {
    const resolve = agentResolver([...roster, agent('cx', { provider: 'codex' })])
    expect([resolve('alpha'), resolve('gem'), resolve('cx')]).toEqual(['alpha', 'gem', 'cx'])
  })
  it('reads the injected caps, not the engine name', () => {
    expect(agentResolver(roster, new Set(), (e) => ({ ...engineCaps(e), remote: false }))('remote-one')).toBe('remote-one')
    expect(() => agentResolver(roster, new Set(), (e) => ({ ...engineCaps(e), remote: e === 'acp' }))('gem')).toThrow(
      AGUI_TEXT.zumiBotPick('gem')
    )
  })
  it('the refusal reaches the agent as written (the IPC filter, with its rule on "/")', () => {
    expect(isSafeMessage(AGUI_TEXT.zumiBotPick('remote-one'))).toBe(true)
    expect(isSafeMessage(AGUI_TEXT.zumiBotPick('a/b'))).toBe(false)
  })
})
