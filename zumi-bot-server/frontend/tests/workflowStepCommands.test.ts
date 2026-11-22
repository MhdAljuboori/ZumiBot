import { describe, expect, it } from 'vitest'
import type { AgentSummary, ChatMeta } from '@zumibot/shared/types'
import type { Step } from '@zumibot/shared/workflows'
import { roomSourceOf, stepCommandAgents, withKeep, withPrompt, withRoomSource } from '../src/state/workflowStepCommands'

const agent = (name: string, commands: string[] = ['check']): AgentSummary =>
  ({ name, error: null, filePath: `/${name}.md`, commands: commands.map((c) => ({ name: c, description: c })) }) as unknown as AgentSummary
const agents = [agent('alpha'), agent('beta'), agent('gamma')]
const meta = (id: string, over: Partial<ChatMeta> = {}): ChatMeta => ({ id, title: id, agentName: '', updatedAt: 1, ...over }) as ChatMeta
const roomChat = (id: string, members: string[]): ChatMeta =>
  meta(id, { group: { members, sessions: {}, seen: {}, role: '', active: [], queue: [] } as unknown as ChatMeta['group'] })
const chats = [roomChat('r1', ['beta', 'gamma']), meta('s1', { agentName: 'alpha' })]
const base = { id: 'i', handle: 'h', name: 'n', x: 0, y: 0 }
const names = (r: { agents: AgentSummary[] }): string[] => r.agents.map((a) => a.name)

describe('stepCommandAgents', () => {
  it('gives an agent or For each step its own agent, ungrouped', () => {
    const a = { ...base, kind: 'agent', agent: 'alpha', prompt: '', cwd: '' } as Step
    const f = { ...base, kind: 'foreach', agent: 'beta', prompt: '', cwd: '' } as Step
    expect(stepCommandAgents(a, agents, chats)).toEqual({ agents: [agents[0]], grouped: false })
    expect(stepCommandAgents(f, agents, chats)).toEqual({ agents: [agents[1]], grouped: false })
  })
  it('gives none for an agent step with no agent or an unknown one', () => {
    expect(stepCommandAgents({ ...base, kind: 'agent', agent: '', prompt: '', cwd: '' } as Step, agents, chats).agents).toEqual([])
    expect(stepCommandAgents({ ...base, kind: 'agent', agent: 'zed', prompt: '', cwd: '' } as Step, agents, chats).agents).toEqual([])
  })
  it('gives a room from agents its members, grouped', () => {
    const s = { ...base, kind: 'room', room: '', prompt: '', members: ['gamma', 'alpha'], role: '', cwd: '' } as Step
    expect(stepCommandAgents(s, agents, chats)).toEqual({ agents: [agents[2], agents[0]], grouped: true })
  })
  it("gives a copied room the template's members, grouped, and none when it is gone or not a room", () => {
    const s = (room: string) => ({ ...base, kind: 'room', room, prompt: '' }) as Step
    expect(stepCommandAgents(s('r1'), agents, chats)).toEqual({ agents: [agents[1], agents[2]], grouped: true })
    expect(stepCommandAgents(s('gone'), agents, chats)).toEqual({ agents: [], grouped: true })
    expect(stepCommandAgents(s('s1'), agents, chats)).toEqual({ agents: [], grouped: true })
  })
  it("gives a chat step its single chat's agent, or its room's members grouped", () => {
    const s = (chat: string) => ({ ...base, kind: 'chat', chat, prompt: '' }) as Step
    expect(stepCommandAgents(s('s1'), agents, chats)).toEqual({ agents: [agents[0]], grouped: false })
    expect(names(stepCommandAgents(s('r1'), agents, chats))).toEqual(['beta', 'gamma'])
    expect(stepCommandAgents(s('r1'), agents, chats).grouped).toBe(true)
    expect(stepCommandAgents(s('gone'), agents, chats)).toEqual({ agents: [], grouped: false })
  })
  it('gives nothing for steps that run no agent command', () => {
    expect(stepCommandAgents({ ...base, kind: 'llm', prompt: '', model: 'haiku' } as Step, agents, chats)).toEqual({
      agents: [],
      grouped: false
    })
    expect(stepCommandAgents({ ...base, kind: 'wait', minutes: 1 } as Step, agents, chats)).toEqual({ agents: [], grouped: false })
  })
})

describe('withPrompt', () => {
  const step = { ...base, kind: 'agent', agent: 'alpha', prompt: '/check now', cwd: '', command: { agent: 'alpha', name: 'check' } } as Step
  it('keeps the pick while the prompt still starts with its name', () => {
    expect(withPrompt(step, '/check later')).toMatchObject({ prompt: '/check later', command: { agent: 'alpha', name: 'check' } })
  })
  it('drops the pick once the name no longer leads', () => {
    const out = withPrompt(step, 'check later')
    expect(out).toMatchObject({ prompt: 'check later' })
    expect('command' in out).toBe(false)
    expect('command' in withPrompt(step, '/chec')).toBe(false)
  })
  it('sets only the prompt on a step with no pick', () => {
    const s = { ...base, kind: 'chat', chat: 'c', prompt: '' } as Step
    const out = withPrompt(s, 'hi')
    expect(out).toEqual({ ...s, prompt: 'hi' })
    expect('command' in out).toBe(false)
  })
})

describe('withKeep', () => {
  const room = { ...base, kind: 'room', room: 'r1', prompt: '', keep: true, title: 'T', section: 'sec' } as Extract<Step, { kind: 'room' }>
  it('writes keep only as true', () => {
    expect(withKeep({ ...base, kind: 'agent', agent: 'a', prompt: '', cwd: '' } as Step, true)).toMatchObject({ keep: true })
  })
  it('clearing it drops the title and the section', () => {
    const out = withKeep(room, false)
    expect('keep' in out || 'title' in out || 'section' in out).toBe(false)
  })
})

describe('room source', () => {
  const copy = { ...base, kind: 'room', room: 'r1', prompt: 'p', rules: [{ tool: 'Edit' }] } as Extract<Step, { kind: 'room' }>
  it('reads the source from the members key', () => {
    expect(roomSourceOf(copy)).toBe('copy')
    expect(roomSourceOf({ ...copy, room: '', members: [] })).toBe('agents')
  })
  it('switching to agents clears the template and starts empty members, role and folder', () => {
    const out = withRoomSource(copy, 'agents')
    expect(out).toMatchObject({ room: '', members: [], role: '', cwd: '', prompt: 'p', rules: [{ tool: 'Edit' }] })
  })
  it('switching to copy removes members, role and folder', () => {
    const out = withRoomSource({ ...copy, room: '', members: ['a', 'b'], role: 'r', cwd: '/x' }, 'copy')
    expect(out.room).toBe('')
    expect('members' in out || 'role' in out || 'cwd' in out).toBe(false)
  })
  it('does nothing when the source is already the one asked', () => {
    expect(withRoomSource(copy, 'copy')).toBe(copy)
  })
})
