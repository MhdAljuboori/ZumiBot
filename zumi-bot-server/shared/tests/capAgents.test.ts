import { describe, expect, it } from 'vitest'
import { routineRefs, spendCapBlocker, workflowRefs } from '@zumibot/shared/capAgents'
import { engineCaps, type Engine } from '@zumibot/shared/engine'
import type { AgentSummary, ChatMeta, GroupInfo } from '@zumibot/shared/types'
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
const group = (members: string[]): GroupInfo => ({ members, sessions: {}, seen: {}, role: '', active: [], queue: [] })
const chats: Record<string, Pick<ChatMeta, 'agentName' | 'group'>> = {
  single: { agentName: 'gem' },
  room: { agentName: '', group: group(['ui', 'gem']) },
  fine: { agentName: 'ui' }
}
const chatOf = (id: string) => chats[id]
const base = { x: 0, y: 0, name: 'n' }

describe('routineRefs', () => {
  it('names the agent, the members, or the existing chat to look up', () => {
    expect(routineRefs({ kind: 'new-chat', agent: 'ui', cwd: '/w' })).toEqual({ agents: ['ui'], chats: [] })
    expect(routineRefs({ kind: 'new-group', members: ['ui', 'gem'], role: '', cwd: '/w' })).toEqual({ agents: ['ui', 'gem'], chats: [] })
    expect(routineRefs({ kind: 'chat', chatId: 'room' })).toEqual({ agents: [], chats: ['room'] })
  })
})

describe('workflowRefs', () => {
  it('collects what Agent, For each, Room and Chat steps run, and ignores the rest', () => {
    const steps = [
      { id: 't', handle: 't', kind: 'trigger', ...base },
      { id: 'a', handle: 'a', kind: 'agent', agent: 'ui', prompt: '', cwd: '/w', ...base },
      { id: 'f', handle: 'f', kind: 'foreach', agent: 'gem', prompt: '', cwd: '/w', ...base },
      { id: 'r', handle: 'r', kind: 'room', room: 'room', prompt: '', ...base },
      { id: 'm', handle: 'm', kind: 'room', room: '', prompt: '', members: ['cx'], role: '', cwd: '/w', ...base },
      { id: 'c', handle: 'c', kind: 'chat', chat: 'single', prompt: '', ...base },
      { id: 'w', handle: 'w', kind: 'wait', minutes: 1, ...base }
    ] as Step[]
    expect(workflowRefs(steps)).toEqual({ agents: ['ui', 'gem', 'cx'], chats: ['room', 'single'] })
  })
})

describe('spendCapBlocker', () => {
  it('is null while every agent reports a cost, or there is none to judge', () => {
    expect(spendCapBlocker({ agents: ['ui', 'cx'], chats: ['fine'] }, agents, chatOf)).toBeNull()
    expect(spendCapBlocker({ agents: [], chats: [] }, agents, chatOf)).toBeNull()
    // A chat that is gone, and a name no agent file has (counted as Claude), judge nothing.
    expect(spendCapBlocker({ agents: ['ghost'], chats: ['gone'] }, agents, chatOf)).toBeNull()
  })
  it('names the first agent whose engine has no cost, with the fixed sentence', () => {
    expect(spendCapBlocker({ agents: ['ui', 'gem'], chats: [] }, agents, chatOf)).toBe(
      "gem is an ACP agent, whose cost may not be in dollars, so a spend cap can't hold for it."
    )
  })
  it("reaches a chat's agent, and every member of a room", () => {
    expect(spendCapBlocker({ agents: [], chats: ['single'] }, agents, chatOf)).toMatch(/^gem is an ACP agent/)
    expect(spendCapBlocker({ agents: [], chats: ['room'] }, agents, chatOf)).toMatch(/^gem is an ACP agent/)
  })
  it('reads the cap, not the engine name', () => {
    const noCostForCodex = (e: Engine) => ({ ...engineCaps(e), cost: e !== 'codex' })
    expect(spendCapBlocker({ agents: ['cx'], chats: [] }, agents, chatOf, noCostForCodex)).toMatch(/^cx runs on Codex/)
    expect(spendCapBlocker({ agents: ['cx'], chats: [] }, agents, chatOf)).toBeNull()
  })
})
