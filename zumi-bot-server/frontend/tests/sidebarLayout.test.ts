import { describe, expect, it } from 'vitest'
import type { SidebarLayout } from '@zumibot/shared/sidebarLayout'
import type { AgentSummary, ChatMeta } from '@zumibot/shared/types'
import {
  addSection,
  itemKeys,
  moveItem,
  moveSection,
  placeAfter,
  removeSection,
  renameSection,
  sectionOf,
  setSectionCollapsed,
  sidebarView,
  unassignedOrder
} from '../src/state/sidebarLayout'

const agent = (name: string): AgentSummary => ({
  filePath: `/agents/${name}.md`,
  name,
  description: '',
  color: null,
  icon: null,
  error: null,
  builtIn: false
})
const chat = (id: string, agentName: string, title: string, updatedAt: number): ChatMeta => ({
  id,
  agentName,
  sessionId: null,
  cwd: '/w',
  title,
  createdAt: 0,
  updatedAt,
  inFlight: false
})
const groupChat = (id: string, members: string[], title: string, updatedAt: number): ChatMeta => ({
  ...chat(id, '', title, updatedAt),
  group: { members, sessions: {}, seen: {}, role: '', active: [], queue: [] }
})
const sec = (id: string, items: string[], collapsed = false) => ({ id, name: id.toUpperCase(), collapsed, items })
const layout = (sections: ReturnType<typeof sec>[], unassigned: string[] = []): SidebarLayout => ({ sections, unassigned })

const agents = [agent('writer'), agent('qa'), agent('coder')]
const chats = [
  chat('c1', 'writer', 'Draft intro', 5),
  groupChat('g1', ['writer', 'qa'], 'Old room', 1),
  groupChat('g2', ['qa', 'coder'], 'Launch', 9)
]
const keys = itemKeys(agents, chats)
const shown = (l: SidebarLayout, query = '') => {
  const v = sidebarView(l, agents, chats, query)
  return { sections: v.sections.map((s) => [s.section.id, s.entries.map((e) => e.key)]), unassigned: v.unassigned.map((e) => e.key) }
}

describe('itemKeys', () => {
  it('lists group chats newest first, then agents in their order', () => {
    expect(keys).toEqual(['group:g2', 'group:g1', 'agent:writer', 'agent:qa', 'agent:coder'])
  })
})

describe('unassignedOrder', () => {
  it('puts items never placed first, then the stored order, leaving out items in a section', () => {
    const l = layout([sec('work', ['agent:qa'])], ['agent:coder', 'group:g1'])
    expect(unassignedOrder(l, keys)).toEqual(['group:g2', 'agent:writer', 'agent:coder', 'group:g1'])
  })
})

describe('sidebarView', () => {
  it('fills each section in its order and skips keys with nothing behind them', () => {
    const l = layout([sec('work', ['agent:coder', 'agent:gone', 'group:g1']), sec('empty', [])], ['agent:writer'])
    expect(shown(l)).toEqual({
      sections: [
        ['work', ['agent:coder', 'group:g1']],
        ['empty', []]
      ],
      unassigned: ['group:g2', 'agent:qa', 'agent:writer']
    })
  })

  it('a search keeps only matching rows, in sections and out', () => {
    const l = layout([sec('work', ['agent:coder', 'group:g1'])])
    expect(shown(l, 'launch')).toEqual({ sections: [['work', []]], unassigned: ['group:g2'] })
    expect(shown(l, 'draft')).toEqual({ sections: [['work', []]], unassigned: ['agent:writer'] })
  })
})

describe('moveItem', () => {
  it('moves an item into a section before another, or last', () => {
    const l = layout([sec('work', ['agent:qa'])])
    expect(moveItem(l, keys, 'agent:coder', { section: 'work', before: 'agent:qa' }).sections[0].items).toEqual(['agent:coder', 'agent:qa'])
    expect(moveItem(l, keys, 'group:g1', { section: 'work', before: null }).sections[0].items).toEqual(['agent:qa', 'group:g1'])
  })

  it('moves an item between sections and writes the unassigned order out in full', () => {
    const l = layout([sec('a', ['agent:qa']), sec('b', [])])
    const next = moveItem(l, keys, 'agent:qa', { section: 'b', before: null })
    expect(next.sections.map((s) => s.items)).toEqual([[], ['agent:qa']])
    expect(next.unassigned).toEqual(['group:g2', 'group:g1', 'agent:writer', 'agent:coder'])
  })

  it('takes an item out of its section to a spot among the unassigned ones', () => {
    const l = layout([sec('a', ['agent:qa'])], ['agent:writer'])
    const next = moveItem(l, keys, 'agent:qa', { section: null, before: 'agent:writer' })
    expect(next.sections[0].items).toEqual([])
    expect(next.unassigned).toEqual(['group:g2', 'group:g1', 'agent:coder', 'agent:qa', 'agent:writer'])
  })

  it('reorders inside the unassigned items; dropped on itself, nothing changes', () => {
    const l = layout([])
    expect(moveItem(l, keys, 'agent:coder', { section: null, before: 'group:g2' }).unassigned).toEqual([
      'agent:coder',
      'group:g2',
      'group:g1',
      'agent:writer',
      'agent:qa'
    ])
    expect(moveItem(l, keys, 'agent:qa', { section: null, before: 'agent:qa' })).toBe(l)
  })
})

describe('sections', () => {
  it('addSection adds an open, empty section last; rename and collapse edit only that one', () => {
    let l = addSection(layout([sec('a', [])]), 'b', 'New section')
    expect(l.sections[1]).toEqual({ id: 'b', name: 'New section', collapsed: false, items: [] })
    l = setSectionCollapsed(renameSection(l, 'b', 'Work'), 'b', true)
    expect(l.sections).toEqual([sec('a', []), { id: 'b', name: 'Work', collapsed: true, items: [] }])
  })

  it('removeSection puts its items at the top of the unassigned ones', () => {
    const l = layout([sec('a', ['agent:qa', 'group:g1']), sec('b', ['agent:coder'])], ['agent:writer'])
    const next = removeSection(l, keys, 'a')
    expect(next.sections).toEqual([sec('b', ['agent:coder'])])
    expect(next.unassigned).toEqual(['agent:qa', 'group:g1', 'group:g2', 'agent:writer'])
  })

  it('moveSection places a section before another, or last', () => {
    const l = layout([sec('a', []), sec('b', []), sec('c', [])])
    expect(moveSection(l, 'c', 'a').sections.map((s) => s.id)).toEqual(['c', 'a', 'b'])
    expect(moveSection(l, 'a', null).sections.map((s) => s.id)).toEqual(['b', 'c', 'a'])
    expect(moveSection(l, 'b', 'b')).toBe(l)
  })

  it('sectionOf finds the section holding an item', () => {
    const l = layout([sec('a', ['agent:qa'])])
    expect(sectionOf(l, 'agent:qa')).toBe('a')
    expect(sectionOf(l, 'agent:coder')).toBeNull()
  })
})

describe('placeAfter', () => {
  const four = ['group:new', 'group:a', 'group:old', 'group:b']

  it('puts the key right after an anchor in a section and takes it out of unassigned', () => {
    const l = layout([sec('s', ['group:a', 'group:old', 'group:b'])], ['group:new'])
    const next = placeAfter(l, four, 'group:new', 'group:old')
    expect(next.sections[0].items).toEqual(['group:a', 'group:old', 'group:new', 'group:b'])
    expect(next.unassigned).not.toContain('group:new')
  })

  it('puts the key last in a section when the anchor is last', () => {
    const l = layout([sec('s', ['group:a', 'group:old'])], ['group:new', 'group:b'])
    expect(placeAfter(l, four, 'group:new', 'group:old').sections[0].items).toEqual(['group:a', 'group:old', 'group:new'])
  })

  it('puts the key right after an anchor stored in unassigned', () => {
    const l = layout([], ['group:new', 'group:a', 'group:old', 'group:b'])
    expect(placeAfter(l, four, 'group:new', 'group:a').unassigned).toEqual(['group:a', 'group:new', 'group:old', 'group:b'])
  })

  it('writes the unassigned order out for an anchor that was never placed', () => {
    const next = placeAfter(layout([]), four, 'group:new', 'group:old')
    expect(next.unassigned).toEqual(['group:a', 'group:old', 'group:new', 'group:b'])
  })

  it('returns the layout unchanged when the anchor is unknown or is the key itself', () => {
    const l = layout([sec('s', ['group:a'])], ['group:new'])
    expect(placeAfter(l, four, 'group:new', 'group:gone')).toBe(l)
    expect(placeAfter(l, four, 'group:new', 'group:new')).toBe(l)
  })
})
