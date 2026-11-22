import { describe, expect, it } from 'vitest'
import type { AgentSummary, ChatMeta } from '@zumibot/shared/types'
import {
  emptyNewChatDraft,
  groupBlockedReason,
  newChatTarget,
  newGroupTarget,
  parentPath,
  recentFolders,
  renameDraftAgent
} from '../src/state/newChat'
import { ZUMI_BOT_NAME } from '@zumibot/shared/zumiBot'

const agent = (name: string, extra: Partial<AgentSummary> = {}): AgentSummary => ({
  filePath: `/agents/${name}.md`,
  name,
  description: '',
  color: null,
  icon: null,
  error: null,
  builtIn: false,
  ...extra
})

const chat = (id: string, agentName: string, cwd: string, updatedAt: number): ChatMeta => ({
  id,
  agentName,
  sessionId: null,
  cwd,
  title: '',
  createdAt: 0,
  updatedAt,
  inFlight: false
})

describe('recentFolders', () => {
  const agents = [agent('writer'), agent('reviewer'), agent('bot', { builtIn: true })]

  it('lists each folder once, most recently used first, across agents', () => {
    const chats = [chat('a', 'writer', '/w/site', 10), chat('b', 'reviewer', '/w/api', 30), chat('c', 'writer', '/w/site', 20)]
    expect(recentFolders(agents, chats)).toEqual(['/w/api', '/w/site'])
  })

  it('skips the fixed folder of built-in agents', () => {
    const chats = [chat('a', 'bot', '/agents', 50), chat('b', 'writer', '/w/site', 10)]
    expect(recentFolders(agents, chats)).toEqual(['/w/site'])
  })

  it('stops at the limit', () => {
    const chats = [chat('a', 'writer', '/1', 3), chat('b', 'writer', '/2', 2), chat('c', 'writer', '/3', 1)]
    expect(recentFolders(agents, chats, 2)).toEqual(['/1', '/2'])
  })

  it('never lists a worktree path', () => {
    const wt = { root: '/w/site-x', branch: 'zumibot/x', source: '/w/site', folder: '/w/site', links: [] }
    const chats = [{ ...chat('a', 'writer', '/w/site-x', 10), worktree: wt }]
    expect(recentFolders(agents, chats)).toEqual(['/w/site'])
  })
})

describe('newChatTarget', () => {
  const agents = [agent('writer'), agent('broken', { error: 'bad yaml' }), agent('bot', { builtIn: true })]

  it('is null until an agent is picked', () => {
    expect(newChatTarget({ ...emptyNewChatDraft, cwd: '/w/site' }, agents)).toBeNull()
  })

  it('needs no folder: with none picked the chat gets a scratch folder', () => {
    expect(newChatTarget({ ...emptyNewChatDraft, agentName: 'writer' }, agents)).toEqual({ agentName: 'writer', folder: 'none' })
  })

  it('targets the picked agent and folder', () => {
    expect(newChatTarget({ ...emptyNewChatDraft, agentName: 'writer', cwd: '/w/site' }, agents)).toEqual({
      agentName: 'writer',
      folder: { cwd: '/w/site' }
    })
  })

  it('is null when the picked agent is gone or has an error', () => {
    expect(newChatTarget({ ...emptyNewChatDraft, agentName: 'deleted', cwd: '/w/site' }, agents)).toBeNull()
    expect(newChatTarget({ ...emptyNewChatDraft, agentName: 'broken', cwd: '/w/site' }, agents)).toBeNull()
  })

  it('needs no folder for a built-in agent, whose folder is fixed', () => {
    expect(newChatTarget({ ...emptyNewChatDraft, agentName: 'bot', cwd: null }, agents)).toEqual({ agentName: 'bot', folder: 'last' })
    expect(newChatTarget({ ...emptyNewChatDraft, agentName: 'bot', cwd: '/w/site' }, agents)).toEqual({ agentName: 'bot', folder: 'last' })
  })
})

describe('renameDraftAgent', () => {
  it('follows a rename of the picked agent', () => {
    const draft = { ...emptyNewChatDraft, agentName: 'writer', cwd: '/w', text: 'hi' }
    expect(renameDraftAgent(draft, [{ from: 'writer', to: 'author' }])).toEqual({ ...draft, agentName: 'author' })
  })

  it('keeps the same draft when another agent is renamed', () => {
    const draft = { ...emptyNewChatDraft, agentName: 'writer', cwd: '/w', text: 'hi' }
    expect(renameDraftAgent(draft, [{ from: 'reviewer', to: 'critic' }])).toBe(draft)
  })
})

describe('parentPath', () => {
  it('drops the last segment', () => {
    expect(parentPath('/home/me/app')).toBe('/home/me')
    expect(parentPath('/home/me/app/')).toBe('/home/me')
  })
  it('stops at the root', () => {
    expect(parentPath('/app')).toBe('/')
  })
})

describe('group drafts', () => {
  const agents = [agent('writer'), agent('reviewer'), agent(ZUMI_BOT_NAME, { builtIn: true })]
  const draft = (extra: Partial<typeof emptyNewChatDraft>) => ({ ...emptyNewChatDraft, mode: 'group' as const, ...extra })

  it('starts as a single-agent draft with no members', () => {
    expect(emptyNewChatDraft.mode).toBe('single')
    expect(emptyNewChatDraft.members).toEqual([])
  })

  it('newGroupTarget carries the role', () => {
    expect(emptyNewChatDraft.role).toBe('')
    expect(newGroupTarget(draft({ members: ['writer', 'reviewer'], cwd: '/w', role: 'Be brief' }), agents)?.role).toBe('Be brief')
  })

  it('newGroupTarget needs two members, no Zumi Bot and existing agents; a folder is optional', () => {
    expect(newGroupTarget(draft({ members: ['writer', 'reviewer'], cwd: '/w' }), agents)).toEqual({
      members: ['writer', 'reviewer'],
      cwd: '/w',
      role: ''
    })
    expect(newGroupTarget(draft({ members: ['writer'], cwd: '/w' }), agents)).toBeNull()
    expect(newGroupTarget(draft({ members: ['writer', 'writer'], cwd: '/w' }), agents)).toBeNull()
    expect(newGroupTarget(draft({ members: ['writer', 'reviewer'], cwd: null }), agents)).toEqual({
      members: ['writer', 'reviewer'],
      cwd: null,
      role: ''
    })
    expect(newGroupTarget(draft({ members: ['writer', ZUMI_BOT_NAME], cwd: '/w' }), agents)).toBeNull()
    expect(newGroupTarget(draft({ members: ['writer', 'ghost'], cwd: '/w' }), agents)).toBeNull()
    expect(newGroupTarget({ ...draft({ members: ['writer', 'reviewer'], cwd: '/w' }), mode: 'single' }, agents)).toBeNull()
  })

  it('groupBlockedReason names what is missing', () => {
    expect(groupBlockedReason(draft({}), agents)).toBe('Pick at least 2 agents first')
    expect(groupBlockedReason(draft({ members: ['writer'], cwd: '/w' }), agents)).toBe('Pick at least 2 agents first')
    expect(groupBlockedReason(draft({ members: ['writer', 'reviewer'] }), agents)).toBeNull()
    expect(groupBlockedReason(draft({ members: ['writer', 'reviewer'], cwd: '/w' }), agents)).toBeNull()
  })

  it('renameDraftAgent renames members too', () => {
    const out = renameDraftAgent(draft({ members: ['writer', 'reviewer'] }), [{ from: 'writer', to: 'author' }])
    expect(out.members).toEqual(['author', 'reviewer'])
  })
})
