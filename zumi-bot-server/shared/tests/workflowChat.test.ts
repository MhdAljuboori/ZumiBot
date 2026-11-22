import { describe, expect, it } from 'vitest'
import type { AgentSummary, ChatMeta } from '@zumibot/shared/types'
import { agentProblem, chatStepProblem } from '@zumibot/shared/workflowChat'

const BOT = 'zumi-bot'
const agents = [{ name: 'alpha' }, { name: 'broken', error: 'bad file' }] as AgentSummary[]
const meta = (over: Partial<ChatMeta> = {}): ChatMeta => ({ id: 'c', title: 'c', agentName: 'alpha', updatedAt: 1, ...over }) as ChatMeta
const asked = { by: 'a', from: 'x', fromTitle: '', chain: [] }
const wf = { workflowId: 'w', runId: 'r', stepId: 's', name: 'W' }

describe('agentProblem', () => {
  it('names Zumi Bot, a gone agent and a broken one; null for a good one', () => {
    expect(agentProblem(BOT, agents, BOT)).toBe('Zumi Bot cannot be a workflow step')
    expect(agentProblem('nobody', agents, BOT)).toBe('Agent "nobody" not found')
    expect(agentProblem('broken', agents, BOT)).toBe('Agent "broken" has an error')
    expect(agentProblem('alpha', agents, BOT)).toBeNull()
  })
})

describe('chatStepProblem', () => {
  it('judges in the server order: missing, A to B, workflow, then the agent', () => {
    expect(chatStepProblem(null, agents, BOT)).toBe('Chat not found')
    expect(chatStepProblem(meta({ asked, workflowTest: 'W' }), agents, BOT)).toBe('This chat is read-only')
    expect(chatStepProblem(meta({ workflow: wf, agentName: BOT }), agents, BOT)).toBe('This chat belongs to a workflow')
    expect(chatStepProblem(meta({ workflowTest: 'W' }), agents, BOT)).toBe('This chat belongs to a workflow')
    expect(chatStepProblem(meta({ agentName: BOT }), agents, BOT)).toBe('Zumi Bot cannot be a workflow step')
    expect(chatStepProblem(meta({ agentName: 'broken' }), agents, BOT)).toBe('Agent "broken" has an error')
    expect(chatStepProblem(meta(), agents, BOT)).toBeNull()
  })
  it("does not judge a room's agent", () => {
    const group = { members: ['a', 'b'], sessions: {}, seen: {}, role: '', active: [], queue: [] }
    expect(chatStepProblem(meta({ group, agentName: BOT }) as ChatMeta, agents, BOT)).toBeNull()
  })
})
