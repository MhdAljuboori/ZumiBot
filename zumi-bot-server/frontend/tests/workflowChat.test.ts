import { describe, expect, it } from 'vitest'
import type { AgentSummary, ChatMeta } from '@zumibot/shared/types'
import type { Step } from '@zumibot/shared/workflows'
import { stepSummary } from '../src/state/workflowCanvas'
import { chatOptions, chatStepNote, chatStepTitle } from '../src/state/workflowChat'

const meta = (id: string, over: Partial<ChatMeta> = {}): ChatMeta => ({ id, title: id, agentName: '', updatedAt: 1, ...over }) as ChatMeta
const room = (id: string, over: Partial<ChatMeta> = {}): ChatMeta =>
  meta(id, { group: { members: ['a', 'b'], sessions: {}, seen: {}, role: '', active: [], queue: [] }, ...over })

const BOT = 'zumi-bot'
const agents = [{ name: 'alpha' }, { name: 'broken', error: 'bad file' }, { name: 'workiom5-assistance' }] as AgentSummary[]
const single = (id: string, over: Partial<ChatMeta> = {}): ChatMeta => meta(id, { agentName: 'alpha', ...over })

describe('chatOptions', () => {
  it('splits rooms from single chats, each by title', () => {
    const chats = [
      single('s2', { title: 'Beta' }),
      room('r2', { title: 'Zed' }),
      single('s1', { title: 'Alpha' }),
      room('r1', { title: 'Team' })
    ]
    const { rooms, singles } = chatOptions(chats, '', agents, BOT)
    expect(rooms.map((c) => c.id)).toEqual(['r1', 'r2'])
    expect(singles.map((c) => c.id)).toEqual(['s1', 's2'])
  })
  it('sorts by the title shown, not the raw one', () => {
    // Raw, "@Zeta Tean" leads ("space" before "-"); shown, "@zeta-team" reads "@Zeta Team", which leads "@Zeta Tean".
    const chats = [single('b', { title: '@Zeta Tean' }), single('a', { title: '@zeta-team' })]
    expect([...chats].sort((x, y) => x.title.localeCompare(y.title)).map((c) => c.id)).toEqual(['b', 'a'])
    expect(chatOptions(chats, '', [...agents, { name: 'zeta-team' } as AgentSummary], BOT).singles.map((c) => c.id)).toEqual(['a', 'b'])
  })
  it('leaves out A to B, workflow, workflow test and archived chats', () => {
    const chats = [
      single('ok'),
      single('ab', { asked: { by: 'a', from: 'x', fromTitle: '', chain: [] } }),
      single('wf', { workflow: { workflowId: 'w', runId: 'r', stepId: 's', name: 'W' } }),
      single('test', { workflowTest: 'W' }),
      single('old', { archivedAt: 5 })
    ]
    expect(chatOptions(chats, '', agents, BOT).singles.map((c) => c.id)).toEqual(['ok'])
  })
  it('leaves out single chats of Zumi Bot, a gone agent or a broken one, but not rooms', () => {
    const chats = [
      single('ok'),
      single('bot', { agentName: BOT }),
      single('gone', { agentName: 'nobody' }),
      single('bad', { agentName: 'broken' }),
      room('r1')
    ]
    const { rooms, singles } = chatOptions(chats, '', agents, BOT)
    expect(singles.map((c) => c.id)).toEqual(['ok'])
    expect(rooms.map((c) => c.id)).toEqual(['r1'])
  })
  it('keeps the current pick whatever its kind, while the chat exists', () => {
    const wf = single('wf', { workflow: { workflowId: 'w', runId: 'r', stepId: 's', name: 'W' } })
    const ab = single('ab', { asked: { by: 'a', from: 'x', fromTitle: '', chain: [] } })
    const old = single('old', { archivedAt: 5 })
    const bot = single('bot', { agentName: BOT })
    for (const c of [wf, ab, old, bot])
      expect(
        chatOptions([c, single('ok')], c.id, agents, BOT)
          .singles.map((x) => x.id)
          .sort()
      ).toEqual([c.id, 'ok'].sort())
    expect(chatOptions([single('ok')], 'gone', agents, BOT).singles.map((x) => x.id)).toEqual(['ok'])
  })
})

describe('chatStepNote', () => {
  it('is null with no chat or a usable one (single or room)', () => {
    const chats = [single('s1'), room('r1')]
    expect(chatStepNote('', chats, agents, BOT)).toBeNull()
    expect(chatStepNote('s1', chats, agents, BOT)).toBeNull()
    expect(chatStepNote('r1', chats, agents, BOT)).toBeNull()
  })
  it("gives the server's own text for each refusal, in its order", () => {
    const chats = [
      single('ab', { asked: { by: 'a', from: 'x', fromTitle: '', chain: [] } }),
      single('wf', { workflow: { workflowId: 'w', runId: 'r', stepId: 's', name: 'W' } }),
      single('test', { workflowTest: 'W' }),
      single('bot', { agentName: BOT }),
      single('gone', { agentName: 'nobody' }),
      single('bad', { agentName: 'broken' }),
      // A to B beats workflow: the server checks read-only first.
      single('both', { asked: { by: 'a', from: 'x', fromTitle: '', chain: [] }, workflowTest: 'W' })
    ]
    const note = (id: string) => chatStepNote(id, chats, agents, BOT)
    expect(note('missing')).toBe('Chat not found')
    expect(note('ab')).toBe('This chat is read-only')
    expect(note('both')).toBe('This chat is read-only')
    expect(note('wf')).toBe('This chat belongs to a workflow')
    expect(note('test')).toBe('This chat belongs to a workflow')
    expect(note('bot')).toBe('Zumi Bot cannot be a workflow step')
    expect(note('gone')).toBe('Agent "nobody" not found')
    expect(note('bad')).toBe('Agent "broken" has an error')
  })
  it("a room's members are not judged here", () => {
    expect(chatStepNote('r1', [room('r1', { agentName: BOT })], agents, BOT)).toBeNull()
  })
})

describe('chatStepTitle', () => {
  const agents = [{ name: 'workiom5-assistance' }] as AgentSummary[]
  it('names agents by display name and falls back like the sidebar', () => {
    expect(chatStepTitle('s1', [meta('s1', { title: 'Ask @workiom5-assistance' })], agents)).toBe('Ask @Workiom5 Assistance')
    expect(chatStepTitle('s2', [meta('s2', { title: '' })], agents)).toBe('New chat')
  })
  it('is null with no chat or a gone one', () => {
    expect(chatStepTitle('', [], agents)).toBeNull()
    expect(chatStepTitle('gone', [meta('s1')], agents)).toBeNull()
  })
})

describe('Chat step node line', () => {
  const s = { id: 'x', handle: 'x', name: 'X', x: 0, y: 0, kind: 'chat', chat: '', prompt: '' } as Step
  it('reads Pick a chat, the chat title or Chat not found', () => {
    const titles: Record<string, string> = { c1: 'Daily notes' }
    expect(stepSummary(s, undefined, (id) => titles[id] ?? null)).toBe('Pick a chat')
    expect(stepSummary({ ...s, chat: 'c1' } as Step, undefined, (id) => titles[id] ?? null)).toBe('Daily notes')
    expect(stepSummary({ ...s, chat: 'gone' } as Step, undefined, (id) => titles[id] ?? null)).toBe('Chat not found')
    expect(stepSummary({ ...s, chat: 'c1' } as Step)).toBe('Chat')
  })
})
