import { describe, expect, it } from 'vitest'
import { capEngines } from '../../src/core/caps/capEngines'
import { engineCaps, spendCapRefusal } from '@zumibot/shared/engine'
import type { AgentSummary } from '@zumibot/shared/types'
import type { Step } from '@zumibot/shared/workflows'

const agent = (name: string, provider?: 'codex' | 'acp'): AgentSummary => ({
  filePath: `/a/${name}.md`,
  name,
  description: '',
  color: null,
  icon: null,
  error: null,
  builtIn: false,
  ...(provider ? { provider } : {})
})
const agents = [agent('ui'), agent('cx', 'codex'), agent('gem', 'acp')]
const lookups: string[] = []
const check = capEngines({
  agents: async () => agents,
  chats: {
    get: async (id) => {
      lookups.push(id)
      return id === 'room'
        ? { agentName: '', group: { members: ['ui', 'gem'], sessions: {}, seen: {}, role: '', active: [], queue: [] } }
        : id === 'gem-chat'
          ? { agentName: 'gem' }
          : null
    }
  }
})
const step = (agent: string): Step => ({ id: 'a', handle: 'agent', name: 'Agent', x: 0, y: 0, kind: 'agent', agent, prompt: '', cwd: '/w' })

describe('capEngines', () => {
  it('judges nothing without a spend cap, and looks nothing up', async () => {
    lookups.length = 0
    expect(await check.routine({ target: { kind: 'new-chat', agent: 'gem', cwd: '/w' } })).toBeNull()
    expect(await check.workflow({ steps: [step('gem')] })).toBeNull()
    expect(lookups).toEqual([])
  })
  it('names the agent whose engine has no cost, for a routine target of every kind', async () => {
    const over = spendCapRefusal('acp', 'gem')
    expect(await check.routine({ spendCap: 1, target: { kind: 'new-chat', agent: 'gem', cwd: '/w' } })).toBe(over)
    expect(await check.routine({ spendCap: 1, target: { kind: 'new-group', members: ['ui', 'gem'], role: '', cwd: '/w' } })).toBe(over)
    expect(await check.routine({ spendCap: 1, target: { kind: 'chat', chatId: 'room' } })).toBe(over)
    expect(await check.routine({ spendCap: 1, target: { kind: 'chat', chatId: 'gem-chat' } })).toBe(over)
  })
  it('lets a cap through while every agent reports a cost, or the chat is gone', async () => {
    expect(await check.routine({ spendCap: 1, target: { kind: 'new-chat', agent: 'cx', cwd: '/w' } })).toBeNull()
    expect(await check.routine({ spendCap: 1, target: { kind: 'chat', chatId: 'gone' } })).toBeNull()
    expect(await check.workflow({ spendCap: 1, steps: [step('ui'), step('cx')] })).toBeNull()
  })
  it('judges a workflow by its steps, and reads the caps it is given', async () => {
    expect(await check.workflow({ spendCap: 1, steps: [step('ui'), step('gem')] })).toBe(spendCapRefusal('acp', 'gem'))
    const noCodex = capEngines({
      agents: async () => agents,
      chats: { get: async () => null },
      caps: (e) => ({ ...engineCaps(e), cost: e !== 'codex' })
    })
    expect(await noCodex.workflow({ spendCap: 1, steps: [step('cx')] })).toBe(spendCapRefusal('codex', 'cx'))
  })
})
