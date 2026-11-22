import { describe, expect, it } from 'vitest'
import type { AgentSummary, ChatMeta, GroupInfo } from '@zumibot/shared/types'
import type { Routine } from '@zumibot/shared/routines'
import type { Workflow } from '@zumibot/shared/workflows'
import {
  GROUP_LIMITS,
  itemScore,
  messageQuery,
  moveActive,
  paletteItems,
  paletteSections,
  queryWords,
  type PaletteItem,
  type PaletteSources
} from '../src/state/commandPalette'

const agent = (name: string, extra: Partial<AgentSummary> = {}): AgentSummary => ({
  filePath: `/agents/${name}.md`,
  name,
  description: `Does ${name} work.\nMore lines.`,
  color: null,
  icon: null,
  error: null,
  builtIn: false,
  ...extra
})
const chat = (id: string, agentName: string, title: string, updatedAt: number, extra: Partial<ChatMeta> = {}): ChatMeta => ({
  id,
  agentName,
  sessionId: null,
  cwd: '/w/site',
  title,
  createdAt: 0,
  updatedAt,
  inFlight: false,
  ...extra
})
const room = (id: string, members: string[], title: string, updatedAt: number): ChatMeta =>
  chat(id, '', title, updatedAt, { group: { members, sessions: {}, seen: {}, role: '', active: [], queue: [] } as GroupInfo })
const routine = (id: string, name: string, enabled = true): Routine => ({ id, name, enabled }) as Routine
const workflow = (id: string, name: string, enabled = true): Workflow => ({ id, name, enabled }) as Workflow

const sources = (extra: Partial<PaletteSources> = {}): PaletteSources => ({
  chats: [
    chat('c1', 'code-reviewer', 'Review the login page', 300),
    chat('c2', 'writer', 'Weekly report draft', 200),
    chat('c3', 'writer', 'Old café notes', 100, { archivedAt: 50 }),
    chat('c4', 'gone-agent', 'Orphan', 400),
    room('r1', ['code-reviewer', 'writer'], 'Launch room', 250)
  ],
  agents: [
    agent('code-reviewer'),
    agent('writer'),
    agent('broken-bot', { error: 'bad frontmatter' }),
    agent('codexer', { provider: 'codex' })
  ],
  routines: [routine('rt1', 'Weekly report'), routine('rt2', 'Nightly backup', false)],
  workflows: [workflow('wf1', 'Triage issues')],
  vps: false,
  desktop: false,
  island: false,
  ...extra
})

const keys = (items: readonly PaletteItem[]): string[] => items.map((i) => i.key)
const byKey = (items: readonly PaletteItem[], key: string): PaletteItem => {
  const found = items.find((i) => i.key === key)
  if (!found) throw new Error(`no ${key}`)
  return found
}

describe('paletteItems', () => {
  it('lists the views, each Settings section, the creates, chats, agents, routines and workflows', () => {
    const items = paletteItems(sources())
    expect(keys(items.filter((i) => i.group === 'goto'))).toEqual([
      'view:agents',
      'view:routines',
      'view:workflows',
      'view:todos',
      'view:inbox',
      'view:archived',
      'settings:general',
      'settings:notifications',
      'settings:vault',
      'settings:claude-code',
      'settings:connectors',
      'settings:channels',
      'settings:audit',
      'settings:voice',
      'settings:jev',
      'settings:usage',
      'settings:sync',
      'settings:about'
    ])
    expect(keys(items.filter((i) => i.group === 'create'))).toEqual([
      'action:new-chat',
      'action:new-group',
      'action:new-agent',
      'action:new-routine',
      'action:new-workflow'
    ])
    expect(keys(items.filter((i) => i.group === 'routines'))).toEqual(['routine:rt1', 'routine:rt2'])
    expect(keys(items.filter((i) => i.group === 'workflows'))).toEqual(['workflow:wf1'])
  })

  it('has Account only on a server with a sign-in, and Sync & server in the desktop shell', () => {
    const items = paletteItems(sources({ vps: true, desktop: true }))
    expect(byKey(items, 'settings:account').label).toBe('Account')
    expect(byKey(items, 'settings:sync').label).toBe('Sync & server')
  })

  it('has Island & startup only in a shell with the island, after Sync', () => {
    expect(keys(paletteItems(sources({ desktop: true })))).not.toContain('settings:island')
    const items = paletteItems(sources({ desktop: true, island: true }))
    expect(byKey(items, 'settings:island').label).toBe('Island & startup')
    const goto = keys(items.filter((i) => i.group === 'goto'))
    expect(goto.indexOf('settings:island')).toBe(goto.indexOf('settings:sync') + 1)
  })

  it('leaves out a single chat whose agent is gone, and tags an archived one', () => {
    const items = paletteItems(sources())
    expect(keys(items.filter((i) => i.group === 'chats'))).toEqual(['chat:c1', 'chat:c2', 'chat:c3', 'chat:r1'])
    expect(byKey(items, 'chat:c3').tag).toBe('Archived')
    expect(byKey(items, 'chat:c1')).toMatchObject({ detail: 'Code Reviewer · site', icon: { kind: 'agent', name: 'code-reviewer' } })
    expect(byKey(items, 'chat:r1')).toMatchObject({
      detail: 'Code Reviewer, Writer · site',
      icon: { kind: 'room', members: ['code-reviewer', 'writer'] }
    })
  })

  it('opens a broken agent in Agent Studio, tags a Codex one, and tags a switched-off routine', () => {
    const items = paletteItems(sources())
    expect(byKey(items, 'agent:broken-bot')).toMatchObject({
      detail: 'Has an error · opens Agent Studio',
      target: { kind: 'agent', broken: true }
    })
    expect(byKey(items, 'agent:writer')).toMatchObject({ detail: 'Does writer work.', target: { kind: 'agent', broken: false } })
    expect(byKey(items, 'agent:codexer').tag).toBe('Codex')
    expect(byKey(items, 'routine:rt2').tag).toBe('Off')
    expect(byKey(items, 'routine:rt1').tag).toBeUndefined()
  })
})

describe('itemScore', () => {
  const item = (label: string, extra: Partial<PaletteItem> = {}): PaletteItem => ({
    key: label,
    group: 'goto',
    label,
    rank: 0,
    icon: { kind: 'glyph', name: 'x' },
    target: { kind: 'view', view: 'inbox' },
    ...extra
  })
  const score = (q: string, i: PaletteItem): number | null => itemScore(queryWords(q), i)

  it('ranks a label start over a word start over a substring over other text over letters in order', () => {
    const scores = [
      score('rep', item('Report weekly')),
      score('rep', item('Weekly report')),
      score('port', item('Weekly report')),
      score('rep', item('Other', { detail: 'the report' })),
      score('epo', item('Other', { keywords: 'reports' })),
      score('wkly', item('Weekly'))
    ]
    expect(scores).toEqual([100, 75, 50, 35, 20, 10])
    expect(score('zzz', item('Weekly'))).toBeNull()
    expect(score('re', item('Vault', { keywords: 'secrets' }))).toBeNull()
  })

  it('needs every word, folds case and accents, and favours the whole label', () => {
    expect(score('weekly draft', item('Weekly report draft'))).toBe(175)
    expect(score('weekly nope', item('Weekly report draft'))).toBeNull()
    expect(score('CAFE', item('Old café notes'))).toBe(75)
    expect(score('inbox', item('Inbox'))).toBe(150)
  })
})

describe('paletteSections', () => {
  const items = paletteItems(sources())

  it('lists the newest live chats, the places and the creates on a blank query', () => {
    const sections = paletteSections(items, '  ')
    expect(sections.map((s) => s.title)).toEqual(['Recent chats', 'Go to', 'Create'])
    // newest first; the archived chat and the orphan stay out
    expect(keys(sections[0].items)).toEqual(['chat:c1', 'chat:r1', 'chat:c2'])
  })

  it('puts the section with the best match first, and orders inside by score then recency', () => {
    const sections = paletteSections(items, 'weekly')
    expect(sections.map((s) => s.group)).toEqual(['chats', 'routines'])
    const report = paletteSections(items, 'report')
    expect(report.map((s) => [s.group, keys(s.items)])).toEqual([
      ['chats', ['chat:c2']],
      ['routines', ['routine:rt1']]
    ])
    const vault = paletteSections(items, 'passwords')
    expect(keys(vault[0].items)).toEqual(['settings:vault'])
  })

  it('puts the Claude Code section first for its keywords, ahead of every other section', () => {
    for (const q of ['mcp', 'mcp servers', 'hooks', 'skills', 'plugins', 'extensions']) {
      const sections = paletteSections(items, q)
      expect(sections[0].group, q).toBe('goto')
      expect(keys(sections[0].items), q).toEqual(['settings:claude-code'])
    }
    const item = byKey(items, 'settings:claude-code')
    expect(item).toMatchObject({
      label: 'Claude Code',
      detail: 'Settings',
      group: 'goto',
      target: { kind: 'settings', section: 'claude-code' }
    })
    expect(item.keywords).toBe('mcp servers plugins skills hooks tools extensions')
  })

  it('puts the Connectors section first for the services it connects', () => {
    for (const q of ['gmail', 'notion', 'connectors']) {
      const sections = paletteSections(items, q)
      expect(sections[0].group, q).toBe('goto')
      expect(keys(sections[0].items), q).toEqual(['settings:connectors'])
    }
    // "slack" is both a connector and a channel: both places are offered.
    expect(keys(paletteSections(items, 'slack')[0].items).sort()).toEqual(['settings:channels', 'settings:connectors'])
    expect(byKey(items, 'settings:connectors')).toMatchObject({
      label: 'Connectors',
      detail: 'Settings',
      group: 'goto',
      target: { kind: 'settings', section: 'connectors' }
    })
  })

  it('lists every Settings section for "settings", and a chat by its agent', () => {
    expect(keys(paletteSections(items, 'settings')[0].items)).toHaveLength(12)
    expect(paletteSections(items, 'code reviewer').map((s) => [s.group, keys(s.items)])).toEqual([
      ['agents', ['agent:code-reviewer']],
      ['chats', ['chat:c1', 'chat:r1']]
    ])
  })

  it('caps a section', () => {
    const many = paletteItems(sources({ chats: Array.from({ length: 20 }, (_, i) => chat(`m${i}`, 'writer', `Note ${i}`, i)) }))
    const notes = paletteSections(many, 'note')[0]
    expect(notes.items).toHaveLength(GROUP_LIMITS.chats)
    expect(notes.items[0].key).toBe('chat:m19')
  })
})

describe('moveActive', () => {
  it('wraps at either end and starts from nothing', () => {
    expect(moveActive(0, 1, 3)).toBe(1)
    expect(moveActive(2, 1, 3)).toBe(0)
    expect(moveActive(0, -1, 3)).toBe(2)
    expect(moveActive(-1, 1, 3)).toBe(0)
    expect(moveActive(-1, -1, 3)).toBe(2)
    expect(moveActive(1, 5, 3)).toBe(0)
    expect(moveActive(0, 1, 0)).toBe(-1)
  })
})

describe('messageQuery', () => {
  it('asks for messages once the query holds two characters', () => {
    expect(messageQuery(' a ')).toBe('')
    expect(messageQuery(' ab ')).toBe('ab')
  })
})
