import { describe, expect, it } from 'vitest'
import type { AgentSummary, ChatMeta } from '@zumibot/shared/types'
import { RECENT_MAX, chatToOpen, islandAgents, islandChats, islandMarks, recentChats, popupAgentOf } from '../src/state/island'

const baseChat: ChatMeta = { id: '', agentName: '', sessionId: null, cwd: '/w', title: 't', createdAt: 0, updatedAt: 0, inFlight: false }
const c = (id: string, extra: Partial<ChatMeta> = {}): ChatMeta => ({
  ...baseChat,
  id,
  agentName: 'w',
  updatedAt: Number(id.slice(1)),
  ...extra
})
const askedStub = { by: 'a', from: 'x', fromTitle: 'x', chain: [] }
const wfStub = { workflowId: 'w', runId: 'r', stepId: 's', name: 'n' }
const agent = (name: string, error: string | null = null): AgentSummary => ({
  filePath: `/a/${name}.md`,
  name,
  description: '',
  color: null,
  icon: null,
  error,
  builtIn: false
})

const chats = [
  c('c1'),
  c('c2', { replyAt: 5, seenAt: 1 }),
  c('c3', { archivedAt: 9 }),
  c('c4', { asked: askedStub }),
  c('c5', { workflow: wfStub }),
  c('c6', { inFlight: true })
]

describe('islandChats', () => {
  it('keeps the agent single plain chats, newest first', () => {
    expect(islandChats(chats, 'w').map((x) => x.id)).toEqual(['c6', 'c2', 'c1'])
  })
  it('lists a kept workflow chat, never an unkept one', () => {
    const more = [c('c1'), c('c5', { workflow: wfStub }), c('c6', { workflow: { ...wfStub, keep: true } })]
    expect(islandChats(more, 'w').map((x) => x.id)).toEqual(['c6', 'c1'])
  })
  it('leaves out other agents, rooms and workflow tests', () => {
    const more = [...chats, c('c7', { agentName: 'o' }), c('c8', { group: { members: [] } as never }), c('c9', { workflowTest: 'wf' })]
    expect(islandChats(more, 'w').map((x) => x.id)).toEqual(['c6', 'c2', 'c1'])
  })
})

describe('islandMarks', () => {
  it('sums approvals of island chats only, and reads working and unread', () => {
    expect(islandMarks(chats, 'w', { c1: 2, c3: 4 })).toEqual({ working: true, waiting: 2, unread: true })
  })
  it('is all quiet with nothing going on', () => {
    expect(islandMarks([c('c1')], 'w', {})).toEqual({ working: false, waiting: 0, unread: false })
  })
})

describe('chatToOpen', () => {
  it('opens the oldest waiting chat', () => {
    expect(chatToOpen(chats, 'w', { c1: 1, c6: 1 }, undefined)).toEqual({ kind: 'chat', chatId: 'c1' })
  })
  it('keeps a remembered chat that is still listed', () => {
    expect(chatToOpen(chats, 'w', {}, { kind: 'chat', chatId: 'c1' })).toEqual({ kind: 'chat', chatId: 'c1' })
  })
  it('drops a remembered chat that is archived, for the newest unread', () => {
    expect(chatToOpen(chats, 'w', {}, { kind: 'chat', chatId: 'c3' })).toEqual({ kind: 'chat', chatId: 'c2' })
  })
  it('keeps a remembered new chat', () => {
    expect(chatToOpen(chats, 'w', {}, { kind: 'new' })).toEqual({ kind: 'new' })
  })
  it('falls to the newest chat when none is unread', () => {
    expect(chatToOpen([c('c1'), c('c2')], 'w', {}, undefined)).toEqual({ kind: 'chat', chatId: 'c2' })
  })
  it('is a new chat with no chats', () => {
    expect(chatToOpen([], 'w', {}, undefined)).toEqual({ kind: 'new' })
  })
})

describe('recentChats', () => {
  it('stops at RECENT_MAX', () => {
    const many = Array.from({ length: RECENT_MAX + 3 }, (_, i) => c(`c${i + 1}`))
    expect(recentChats(many, 'w')).toHaveLength(RECENT_MAX)
    expect(recentChats(many, 'w')[0].id).toBe(`c${RECENT_MAX + 3}`)
  })
})

describe('islandAgents', () => {
  it('keeps pick order and drops missing and broken agents', () => {
    expect(islandAgents(['gone', 'w', 'broken'], [agent('w'), agent('broken', 'bad yaml')]).map((a) => a.name)).toEqual(['w'])
    expect(islandAgents(['b', 'a'], [agent('a'), agent('b')]).map((a) => a.name)).toEqual(['b', 'a'])
  })
})

describe('popupAgentOf', () => {
  const ok = (name: string, error: string | null = null) => ({ name, error }) as AgentSummary
  const agents = [ok('picked'), ok('voice-agent'), ok('broken', 'bad file')]
  it('opens a picked agent as before', () => expect(popupAgentOf('picked', ['picked'], null, agents)).toBe('picked'))
  it('opens the agent a voice request went to, picked or not', () =>
    expect(popupAgentOf('voice-agent', ['picked'], 'voice-agent', agents)).toBe('voice-agent'))
  it('never opens an agent that is neither picked nor the voice one', () =>
    expect(popupAgentOf('voice-agent', ['picked'], null, agents)).toBeNull())
  it('never opens an agent that is gone or broken', () => {
    expect(popupAgentOf('broken', [], 'broken', agents)).toBeNull()
    expect(popupAgentOf('gone', [], 'gone', agents)).toBeNull()
  })
  it('nothing open is nothing', () => expect(popupAgentOf(null, ['picked'], 'voice-agent', agents)).toBeNull())
})
