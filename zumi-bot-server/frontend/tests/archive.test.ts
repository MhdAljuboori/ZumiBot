import { describe, expect, it } from 'vitest'
import type { AgentSummary, ChatMeta, GroupInfo } from '@zumibot/shared/types'
import { archivedLabel, archivedRows, liveChats } from '../src/state/archive'

const agent = (name: string): AgentSummary => ({
  filePath: `/agents/${name}.md`,
  name,
  description: '',
  color: null,
  icon: null,
  error: null,
  builtIn: false
})
const chat = (id: string, agentName: string, title: string, extra: Partial<ChatMeta> = {}): ChatMeta => ({
  id,
  agentName,
  sessionId: null,
  cwd: '/w/site',
  title,
  createdAt: 0,
  updatedAt: 0,
  inFlight: false,
  ...extra
})
const room = (id: string, members: string[], title: string, extra: Partial<ChatMeta> = {}): ChatMeta =>
  chat(id, '', title, { group: { members, sessions: {}, seen: {}, role: '', active: [], queue: [] } as GroupInfo, ...extra })

describe('liveChats', () => {
  it('leaves archived chats out, and keeps one archived then brought back', () => {
    const list = [chat('a', 'w', 'A'), chat('b', 'w', 'B', { archivedAt: 5 }), chat('c', 'w', 'C', { archivedAt: 5, unarchivedAt: 6 })]
    expect(liveChats(list).map((c) => c.id)).toEqual(['a', 'c'])
  })
})

describe('archivedRows', () => {
  const agents = [agent('writer'), agent('code-reviewer')]
  const list = [
    chat('live', 'writer', 'Live'),
    chat('old', 'writer', 'Old plan', { archivedAt: 10 }),
    room('r', ['writer', 'code-reviewer', 'gone'], 'Launch room', { archivedAt: 30, cwd: '/w/launch' }),
    chat('new', 'code-reviewer', '', { archivedAt: 20 }),
    chat('orphan', 'deleted-agent', 'No agent', { archivedAt: 40 })
  ]

  it('lists archived chats and rooms, newest archived first, skipping a chat whose agent is gone', () => {
    const rows = archivedRows(list, agents, '')
    expect(rows.map((r) => r.chat.id)).toEqual(['r', 'new', 'old'])
    expect(rows[0]).toMatchObject({ agent: null, folder: 'launch' })
    expect(rows[0].members.map((m) => m.name)).toEqual(['writer', 'code-reviewer'])
    expect(rows[1]).toMatchObject({ agent: agents[1], members: [], folder: 'site' })
  })

  it('searches titles, agent and member names and the folder', () => {
    const ids = (q: string) => archivedRows(list, agents, q).map((r) => r.chat.id)
    expect(ids('plan')).toEqual(['old'])
    expect(ids('Code Reviewer')).toEqual(['r', 'new']) // display name
    expect(ids('code-rev')).toEqual(['r', 'new'])
    expect(ids('launch')).toEqual(['r'])
    expect(ids('new chat')).toEqual(['new']) // an untitled chat shows as New chat
    expect(ids('  ')).toEqual(['r', 'new', 'old'])
    expect(ids('nothing')).toEqual([])
  })
})

describe('archivedLabel', () => {
  const now = new Date(2026, 10, 4, 15, 0).getTime()
  it('says today, yesterday, a date this year, or a full date', () => {
    expect(archivedLabel(new Date(2026, 10, 4, 1, 0).getTime(), now)).toBe('Archived today')
    expect(archivedLabel(new Date(2026, 10, 3, 23, 0).getTime(), now)).toBe('Archived yesterday')
    expect(archivedLabel(new Date(2026, 0, 9).getTime(), now)).toMatch(/^Archived (9 Jan|Jan 9)$/)
    expect(archivedLabel(new Date(2025, 11, 30).getTime(), now)).toMatch(/2025/)
  })
})
