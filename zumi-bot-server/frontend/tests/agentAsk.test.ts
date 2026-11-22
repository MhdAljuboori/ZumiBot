import { describe, expect, it } from 'vitest'
import { ASK_SIDE_TOOL, ASK_TOOL } from '@zumibot/shared/agentAsk'
import type { SideQuestion } from '@zumibot/shared/btw'
import { ZUMI_BOT_NAME } from '@zumibot/shared/zumiBot'
import { engineCaps } from '@zumibot/shared/engine'
import type { AgentSummary, ChatItem, ChatMeta } from '@zumibot/shared/types'
import {
  askCardState,
  askLive,
  askableAgents,
  askedBarText,
  askedChatOf,
  findSideEntry,
  mentionHandles,
  pendingAsked,
  sideAskCardState,
  userAuthor
} from '../src/state/agentAsk'

const chat = (id: string, agentName: string, extra: Partial<ChatMeta> = {}): ChatMeta => ({
  id,
  agentName,
  sessionId: null,
  cwd: '/w',
  title: id,
  createdAt: 0,
  updatedAt: 0,
  inFlight: false,
  ...extra
})
const user = (extra: { from?: string } = {}): Extract<ChatItem, { type: 'user' }> => ({
  type: 'user',
  id: 'u1',
  text: 'hi',
  ts: 1,
  ...extra
})

describe('askedBarText', () => {
  const asked = { by: 'code-writer', from: 'c1', fromTitle: 'Login bug', chain: [] }
  it('names both agents by display name and the chat it started from', () => {
    expect(askedBarText(asked, 'b', true, [])).toEqual({
      lead: 'Conversation between @Code Writer and @B, started from',
      source: 'Login bug'
    })
  })
  it('has no source when that chat is gone', () => {
    expect(askedBarText(asked, 'b', false, [])).toEqual({ lead: 'Conversation between @Code Writer and @B, started from', source: null })
  })
  it('falls back to a plain title for an untitled source', () => {
    expect(askedBarText({ ...asked, fromTitle: '' }, 'b', true, []).source).toBe('New chat')
  })
  it('writes agent handles in the source title as display names', () => {
    expect(askedBarText({ ...asked, fromTitle: 'ask @code-writer' }, 'b', true, [{ name: 'code-writer' }]).source).toBe('ask @Code Writer')
  })
})

describe('askedChatOf', () => {
  const list = [
    chat('x1', 'b', { asked: { by: 'a', from: 'c1', fromTitle: 'T', chain: [] } }),
    chat('x2', 'b', { asked: { by: 'a', from: 'c2', fromTitle: 'T', chain: [] } }),
    chat('x3', 'c', { asked: { by: 'a', from: 'c1', fromTitle: 'T', chain: [] } }),
    chat('plain', 'b')
  ]
  it('finds the chat asked from that source for that agent, whatever the handle looks like', () => {
    expect(askedChatOf(list, 'c1', '@B')?.id).toBe('x1')
    expect(askedChatOf(list, 'c1', 'c')?.id).toBe('x3')
  })
  it('returns null for another source or an agent never asked', () => {
    expect(askedChatOf(list, 'c9', '@b')).toBeNull()
    expect(askedChatOf(list, 'c2', '@c')).toBeNull()
  })
})

describe('userAuthor', () => {
  it('is an agent when another agent asked', () => {
    expect(userAuthor(user({ from: 'a' }))).toEqual({ kind: 'agent', name: 'a' })
  })
  it('is you otherwise', () => {
    expect(userAuthor(user())).toEqual({ kind: 'you' })
  })
})

const askTool = (extra: Partial<Extract<ChatItem, { type: 'tool' }>> = {}): Extract<ChatItem, { type: 'tool' }> => ({
  type: 'tool',
  id: 't1',
  name: ASK_TOOL,
  input: { agent: '@B', message: 'Review this' },
  result: null,
  isError: false,
  blocked: false,
  ts: 1,
  ...extra
})

describe('askCardState', () => {
  const b = chat('x1', 'b', { asked: { by: 'a', from: 'c1', fromTitle: 'T', chain: [] } })
  it('is stopped when there is no result and the source chat is not running', () => {
    expect(askCardState(askTool(), b, { x1: 2 }, false)).toMatchObject({
      status: 'stopped',
      target: 'b',
      message: 'Review this',
      reply: null,
      chatId: 'x1'
    })
  })
  it('is waiting when there is no result and the asked chat has pending cards', () => {
    expect(askCardState(askTool(), b, { x1: 1 }, true).status).toBe('waiting')
  })
  it('is working when there is no result and nothing is pending', () => {
    expect(askCardState(askTool(), b, {}, true).status).toBe('working')
    expect(askCardState(askTool(), null, {}, true)).toMatchObject({ status: 'working', chatId: null })
  })
  it('is failed with the refusal as the reply when the result is an error', () => {
    expect(askCardState(askTool({ result: 'Refused.', isError: true }), null, {}, false)).toMatchObject({
      status: 'failed',
      reply: 'Refused.'
    })
  })
  it('is done with the reply otherwise', () => {
    expect(askCardState(askTool({ result: 'Looks fine.' }), b, {}, false)).toMatchObject({ status: 'done', reply: 'Looks fine.' })
  })
  it('gives an empty message when the input has none', () => {
    expect(askCardState(askTool({ input: { agent: 'b', message: 5 } }), b, {}, true).message).toBe('')
    expect(askCardState(askTool({ input: {} }), b, {}, true).message).toBe('')
  })
})

describe('askLive', () => {
  const ask = askTool()
  it('is live while the source runs and no user message follows the call', () => {
    expect(askLive([user(), ask], 't1', true)).toBe(true)
  })
  it('is not live once a user message follows, even if the source runs again', () => {
    expect(askLive([user(), ask, { ...user(), id: 'u2' }], 't1', true)).toBe(false)
    expect(askCardState(ask, null, {}, askLive([user(), ask, { ...user(), id: 'u2' }], 't1', true)).status).toBe('stopped')
  })
  it('is not live when the source is idle or the call is unknown', () => {
    expect(askLive([user(), ask], 't1', false)).toBe(false)
    expect(askLive([user()], 't1', true)).toBe(false)
  })
})

describe('askableAgents', () => {
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
  it("leaves out the chat's own agent, Zumi Bot and broken agents, in name order", () => {
    const list = [agent('zed'), agent('me'), agent(ZUMI_BOT_NAME, { builtIn: true }), agent('broken', { error: 'bad' }), agent('amy')]
    expect(askableAgents(list, 'me').map((a) => a.name)).toEqual(['amy', 'zed'])
  })
  it('never lists a remote agent: its chat would carry the message and history off this machine', () => {
    const list = [agent('amy'), agent('rem', { provider: 'ag-ui', remoteHost: 'agents.example.com' }), agent('me')]
    expect(askableAgents(list, 'me').map((a) => a.name)).toEqual(['amy'])
    expect(askableAgents(list, 'me', (e) => ({ ...engineCaps(e), remote: false })).map((a) => a.name)).toEqual(['amy', 'rem'])
  })
  it('lists an ACP agent as a target, but offers nothing to an asker without bridges (its chat gets no ask tool)', () => {
    const list = [agent('gem', { provider: 'acp' }), agent('me'), agent('amy')]
    expect(askableAgents(list, 'me').map((a) => a.name)).toEqual(['amy', 'gem'])
    expect(askableAgents(list, 'gem')).toEqual([])
  })
})

describe('mentionHandles', () => {
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
  const list = [agent('zed'), agent('me'), agent(ZUMI_BOT_NAME, { builtIn: true }), agent('broken', { error: 'bad' }), agent('amy')]
  it("is a room's members as they are, a missing one included", () => {
    expect(mentionHandles(list, 'me', ['me', 'gone', 'zed'])).toEqual(['me', 'gone', 'zed'])
  })
  it('in a single chat is every other agent but Zumi Bot, broken ones kept for a greyed chip', () => {
    expect(mentionHandles(list, 'me', null)).toEqual(['zed', 'broken', 'amy'])
  })
})

describe('pendingAsked', () => {
  const approval = (id: string, status: 'pending' | 'denied' = 'pending'): Extract<ChatItem, { type: 'approval' }> => ({
    type: 'approval',
    id,
    toolUseId: null,
    toolName: 'Bash',
    input: {},
    description: null,
    reason: null,
    status,
    ts: 1
  })
  it('lists only the pending approvals', () => {
    expect(pendingAsked([approval('p1'), approval('p2', 'denied'), askTool()]).map((i) => i.id)).toEqual(['p1'])
  })
  it('is empty without items', () => {
    expect(pendingAsked(undefined)).toEqual([])
  })
})

const sideTool = (extra: Partial<Extract<ChatItem, { type: 'tool' }>> = {}): Extract<ChatItem, { type: 'tool' }> => ({
  type: 'tool',
  id: 's1',
  name: ASK_SIDE_TOOL,
  input: { agent: '@B', question: 'Is it safe?' },
  result: null,
  isError: false,
  blocked: false,
  ts: 1,
  ...extra
})

describe('sideAskCardState', () => {
  it('is working with no result while live, stopped when not live', () => {
    expect(sideAskCardState(sideTool(), true)).toEqual({ target: 'b', question: 'Is it safe?', status: 'working', answer: null })
    expect(sideAskCardState(sideTool(), false)).toMatchObject({ status: 'stopped', answer: null })
  })
  it('is done with the answer on a result', () => {
    expect(sideAskCardState(sideTool({ result: 'Yes.' }), false)).toMatchObject({ status: 'done', answer: 'Yes.' })
  })
  it('is failed with the refusal as the answer on an error result', () => {
    expect(sideAskCardState(sideTool({ result: 'No conversation.', isError: true }), true)).toMatchObject({
      status: 'failed',
      answer: 'No conversation.'
    })
  })
  it('gives an empty question when the input has none', () => {
    expect(sideAskCardState(sideTool({ input: { agent: 'b', question: 5 } }), true).question).toBe('')
    expect(sideAskCardState(sideTool({ input: {} }), true)).toMatchObject({ target: '', question: '' })
  })
})

describe('findSideEntry', () => {
  const entry = (id: string, extra: Partial<SideQuestion> = {}): SideQuestion => ({
    id,
    question: 'Is it safe?',
    agent: 'b',
    from: 'a',
    askedAt: 1000,
    after: null,
    state: 'done',
    answer: 'Yes.',
    ...extra
  })
  it('picks the newest entry from that asker with that exact question', () => {
    const list = [entry('e1', { askedAt: 1000 }), entry('e2', { askedAt: 3000 }), entry('e3', { askedAt: 2000 })]
    expect(findSideEntry(list, 'a', 'Is it safe?', 500)?.id).toBe('e2')
  })
  it('ignores other askers, the user, other questions and different wording', () => {
    const list = [
      entry('e1', { from: 'c' }),
      entry('e2', { from: undefined }),
      entry('e3', { question: 'Is it safe' }),
      entry('e4', { question: 'is it safe?' })
    ]
    expect(findSideEntry(list, 'a', 'Is it safe?', 0)).toBeNull()
  })
  it('allows a 5 second grace before the call but no more', () => {
    expect(findSideEntry([entry('e1', { askedAt: 5000 })], 'a', 'Is it safe?', 10000)?.id).toBe('e1')
    expect(findSideEntry([entry('e1', { askedAt: 4999 })], 'a', 'Is it safe?', 10000)).toBeNull()
  })
  it('trims the asked question like the server stores it', () => {
    const list = [entry('e1')]
    expect(findSideEntry(list, 'a', 'Is it safe?\n', 0)?.id).toBe('e1')
    expect(findSideEntry(list, 'a', '  Is it safe?', 0)?.id).toBe('e1')
    expect(findSideEntry(list, 'a', 'Is it safe? Really', 0)).toBeNull()
  })
  it('is null for an empty list', () => {
    expect(findSideEntry([], 'a', 'q', 0)).toBeNull()
  })
})
