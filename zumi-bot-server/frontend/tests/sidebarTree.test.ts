import { describe, expect, it } from 'vitest'
import type { AgentSummary, ChatMeta } from '@zumibot/shared/types'
import {
  applyAgentRenames,
  buildTree,
  chatTitle,
  flatChats,
  folderName,
  groupByFolder,
  groupRows,
  reusableChat
} from '../src/state/sidebarTree'

const agent = (name: string): AgentSummary => ({
  filePath: `/agents/${name}.md`,
  name,
  description: '',
  color: null,
  icon: null,
  error: null,
  builtIn: false
})

const chat = (id: string, agentName: string, cwd: string, title: string, updatedAt: number, inFlight = false): ChatMeta => ({
  id,
  agentName,
  sessionId: null,
  cwd,
  title,
  createdAt: 0,
  updatedAt,
  inFlight
})

describe('folderName', () => {
  it('returns the last path segment', () => {
    expect(folderName('/home/me/projects/app')).toBe('app')
    expect(folderName('/home/me/projects/app/')).toBe('app')
  })
  it('falls back to the path for the root', () => {
    expect(folderName('/')).toBe('/')
  })
})

describe('groupByFolder', () => {
  it('orders folders by their most recent chat and chats newest first', () => {
    const groups = groupByFolder([
      chat('a1', 'x', '/w/alpha', 'A1', 10),
      chat('b1', 'x', '/w/beta', 'B1', 30),
      chat('a2', 'x', '/w/alpha', 'A2', 20)
    ])
    expect(groups.map((g) => g.cwd)).toEqual(['/w/beta', '/w/alpha'])
    expect(groups[0].name).toBe('beta')
    expect(groups[1].chats.map((c) => c.id)).toEqual(['a2', 'a1'])
  })

  it('worktree chats group under the picked folder', () => {
    const wt = { root: '/w/alpha-x', branch: 'zumibot/x', source: '/w/alpha', folder: '/w/alpha', links: [] }
    const groups = groupByFolder([chat('plain', 'x', '/w/alpha', 'P', 10), { ...chat('iso', 'x', '/w/alpha-x', 'I', 20), worktree: wt }])
    expect(groups.map((g) => g.cwd)).toEqual(['/w/alpha'])
    expect(groups[0].chats.map((c) => c.id)).toEqual(['iso', 'plain'])
  })
})

describe('chatTitle', () => {
  it('writes agent handles in the title as display names', () => {
    expect(chatTitle(chat('c', 'x', '/w', '/edit-agent @code-reviewer so', 1), [agent('code-reviewer')])).toBe(
      '/edit-agent @Code Reviewer so'
    )
  })
  it('names an untitled chat New chat', () => {
    expect(chatTitle(chat('c', 'x', '/w', '', 1), [])).toBe('New chat')
  })
})

describe('buildTree', () => {
  const agents = [agent('writer'), agent('reviewer')]
  const chats = [
    chat('w1', 'writer', '/w/site', 'Draft landing copy', 5),
    chat('w2', 'writer', '/w/blog', 'Fix typo', 6),
    chat('r1', 'reviewer', '/w/site', 'Review landing PR', 7)
  ]

  it('shows every agent with all its chats when the query is empty', () => {
    const tree = buildTree(agents, chats, '  ')
    expect(tree.map((n) => n.agent.name)).toEqual(['writer', 'reviewer'])
    expect(tree[0].folders.flatMap((f) => f.chats.map((c) => c.id))).toEqual(['w2', 'w1'])
    expect(tree.every((n) => !n.forceOpen)).toBe(true)
  })

  it('keeps all chats of an agent whose name matches, without forcing it open', () => {
    const tree = buildTree(agents, chats, 'WRIT')
    expect(tree.map((n) => n.agent.name)).toEqual(['writer'])
    expect(tree[0].folders.flatMap((f) => f.chats.map((c) => c.id)).sort()).toEqual(['w1', 'w2'])
    expect(tree[0].forceOpen).toBe(false)
  })

  it('keeps only matching chats of other agents and forces them open', () => {
    const tree = buildTree(agents, chats, 'landing')
    expect(tree.map((n) => n.agent.name)).toEqual(['writer', 'reviewer'])
    expect(tree[0].folders.flatMap((f) => f.chats.map((c) => c.id))).toEqual(['w1'])
    expect(tree[0].forceOpen).toBe(true)
    expect(tree[1].folders.flatMap((f) => f.chats.map((c) => c.id))).toEqual(['r1'])
  })

  it('matches untitled chats by their shown title', () => {
    const tree = buildTree(agents, [chat('n1', 'reviewer', '/w/site', '', 1)], 'new chat')
    expect(tree.map((n) => n.agent.name)).toEqual(['reviewer'])
  })

  it('matches an agent by its shown name, spaces and all', () => {
    const tree = buildTree([agent('code-reviewer'), agent('writer')], [], 'code rev')
    expect(tree.map((n) => n.agent.name)).toEqual(['code-reviewer'])
  })

  it('matches a title by the agent names it shows, or the handles it holds', () => {
    const all = [agent('writer'), agent('code-reviewer')]
    const own = [chat('t1', 'writer', '/w/site', 'ask @code-reviewer first', 1)]
    expect(buildTree(all, own, 'ask @code rev')[0].folders[0].chats.map((c) => c.id)).toEqual(['t1'])
    expect(buildTree(all, own, '@code-reviewer')[0].folders[0].chats.map((c) => c.id)).toEqual(['t1'])
  })

  it('drops agents with no match', () => {
    expect(buildTree(agents, chats, 'nothing here')).toEqual([])
  })
})

describe('reusableChat', () => {
  it('finds an unused chat for the agent in that folder', () => {
    const list = [chat('used', 'writer', '/w/site', 'Hello', 5), chat('blank', 'writer', '/w/site', '', 4)]
    expect(reusableChat(list, 'writer', '/w/site', false)?.id).toBe('blank')
  })
  it('ignores other folders, other agents and running chats', () => {
    const list = [
      chat('other-folder', 'writer', '/w/blog', '', 1),
      chat('other-agent', 'reviewer', '/w/site', '', 1),
      chat('running', 'writer', '/w/site', '', 1, true)
    ]
    expect(reusableChat(list, 'writer', '/w/site', false)).toBeUndefined()
  })
  it('ignores an archived chat', () => {
    expect(reusableChat([{ ...chat('blank', 'writer', '/w/site', '', 4), archivedAt: 9 }], 'writer', '/w/site', false)).toBeUndefined()
  })
  it('only reuses the matching kind', () => {
    const wt = { root: '/r-x', branch: 'zumibot/x', source: '/r', folder: '/r', links: [] }
    const list = [chat('plain', 'writer', '/r', '', 4), { ...chat('iso', 'writer', '/r-x', '', 3), worktree: wt }]
    expect(reusableChat(list, 'writer', '/r', true)?.id).toBe('iso')
    expect(reusableChat(list, 'writer', '/r', false)?.id).toBe('plain')
  })
})

describe('flatChats', () => {
  it('lists every chat across folders newest first', () => {
    const folders = groupByFolder([
      chat('a1', 'x', '/w/alpha', 'A1', 10),
      chat('b1', 'x', '/w/beta', 'B1', 30),
      chat('a2', 'x', '/w/alpha', 'A2', 20),
      chat('b0', 'x', '/w/beta', 'B0', 5)
    ])
    expect(flatChats(folders).map((c) => c.id)).toEqual(['b1', 'a2', 'a1', 'b0'])
  })
})

describe('applyAgentRenames', () => {
  it('moves chats to the new name and leaves others alone', () => {
    const keep = chat('k', 'other', '/w', 'K', 1)
    const out = applyAgentRenames([chat('m', 'old', '/w', 'M', 1), keep], [{ from: 'old', to: 'new' }])
    expect(out.map((c) => c.agentName)).toEqual(['new', 'other'])
    expect(out[1]).toBe(keep)
  })
  it("moves a room member's session engine with its session", () => {
    const room: ChatMeta = {
      ...chat('r', '', '/w', 'R', 1),
      group: {
        members: ['old', 'b'],
        sessions: { old: 'th-1', b: 's-2' },
        seen: {},
        role: '',
        active: [],
        queue: [],
        sessionEngines: { old: 'codex' }
      }
    }
    const [out] = applyAgentRenames([room], [{ from: 'old', to: 'new' }])
    expect(out.group).toMatchObject({ members: ['new', 'b'], sessions: { new: 'th-1', b: 's-2' } })
    expect(out.group?.sessionEngines).toEqual({ new: 'codex' })
  })
})

describe('group chats in the sidebar', () => {
  const groupChat = (id: string, members: string[], updatedAt: number, title = '', cwd = '/w/site'): ChatMeta => ({
    ...chat(id, '', cwd, title, updatedAt),
    group: { members, sessions: {}, seen: {}, role: '', active: [], queue: [] }
  })
  const agents = [agent('ui-ux-specialist'), agent('writer'), agent('qa')]

  it('groupRows lists group chats only, newest first, members resolved in order', () => {
    const rows = groupRows(
      agents,
      [
        chat('s', 'writer', '/w/site', 'single', 99),
        groupChat('g1', ['writer', 'qa'], 10),
        groupChat('g2', ['qa', 'gone', 'writer'], 20, '', '/w/api')
      ],
      ''
    )
    expect(rows.map((r) => r.chat.id)).toEqual(['g2', 'g1'])
    expect(rows[0].members.map((m) => m.name)).toEqual(['qa', 'writer'])
    expect(rows[0].folder).toBe('/w/api')
  })

  it('groupRows matches the title or a member name or display name', () => {
    const chats = [groupChat('g1', ['writer', 'qa'], 10, 'Launch plan'), groupChat('g2', ['ui-ux-specialist', 'qa'], 20)]
    expect(groupRows(agents, chats, 'launch').map((r) => r.chat.id)).toEqual(['g1'])
    expect(groupRows(agents, chats, 'UI UX').map((r) => r.chat.id)).toEqual(['g2'])
    expect(groupRows(agents, chats, 'ui-ux').map((r) => r.chat.id)).toEqual(['g2'])
    expect(groupRows(agents, chats, 'nothing')).toEqual([])
  })

  it('buildTree skips group chats', () => {
    const tree = buildTree(agents, [groupChat('g1', ['writer', 'qa'], 10)], '')
    expect(tree.every((n) => n.folders.length === 0)).toBe(true)
  })

  it('applyAgentRenames renames group members, active agent and queue', () => {
    const g = groupChat('g1', ['writer', 'qa'], 10)
    g.group = {
      ...g.group!,
      active: [{ agent: 'writer', turn: 't', since: 1 }],
      queue: [
        { agent: 'qa', after: [] },
        { agent: 'writer', after: ['qa'] }
      ],
      sessions: { writer: 's1', qa: null },
      seen: { writer: 'i1', qa: null }
    }
    const [out] = applyAgentRenames([g], [{ from: 'writer', to: 'author' }])
    expect(out.group).toEqual({
      members: ['author', 'qa'],
      role: '',
      active: [{ agent: 'author', turn: 't', since: 1 }],
      queue: [
        { agent: 'qa', after: [] },
        { agent: 'author', after: ['qa'] }
      ],
      sessions: { author: 's1', qa: null },
      seen: { author: 'i1', qa: null }
    })
  })

  it('applyAgentRenames keeps a group chat no rename touches', () => {
    const g = groupChat('g1', ['writer', 'qa'], 10)
    expect(applyAgentRenames([g], [{ from: 'ui-ux-specialist', to: 'designer' }])[0]).toBe(g)
    // a name found only in the group's maps still counts
    const stale = groupChat('g2', ['writer', 'qa'], 10)
    stale.group = { ...stale.group!, seen: { 'ui-ux-specialist': 'i1' } }
    expect(applyAgentRenames([stale], [{ from: 'ui-ux-specialist', to: 'designer' }])[0].group?.seen).toEqual({ designer: 'i1' })
  })
})

describe('no-folder (scratch) chats', () => {
  const s1 = '/home/me/zumibot/cache/2026-11-18-aaaaaaaa'
  const s2 = '/home/me/zumibot/cache/2026-11-18-bbbbbbbb'
  it('names the scratch root and each scratch folder No folder', () => {
    expect(folderName('/home/me/zumibot/cache')).toBe('No folder')
    expect(folderName(s1)).toBe('No folder')
  })
  it('groups every scratch chat into one No folder group', () => {
    const groups = groupByFolder([chat('a', 'writer', s1, 'A', 2), chat('b', 'writer', s2, 'B', 1)])
    expect(groups).toHaveLength(1)
    expect(groups[0]).toMatchObject({ cwd: '/home/me/zumibot/cache', name: 'No folder' })
  })
  it('reuses an empty scratch chat when asked for no folder', () => {
    const list = [chat('real', 'writer', '/w/site', '', 3), chat('blank', 'writer', s1, '', 2)]
    expect(reusableChat(list, 'writer', null, false)?.id).toBe('blank')
    expect(reusableChat([chat('real', 'writer', '/w/site', '', 3)], 'writer', null, false)).toBeUndefined()
  })
})
