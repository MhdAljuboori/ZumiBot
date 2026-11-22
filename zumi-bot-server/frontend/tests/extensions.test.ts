import { describe, expect, it } from 'vitest'
import type { Loadout, LoadoutPlugin, LoadoutServer, LoadoutSkill } from '@zumibot/shared/extensions'
import type { AgentFields } from '@zumibot/shared/frontmatter'
import {
  SOURCE_LABEL,
  agentPluginRows,
  agentServerRows,
  agentSkillRows,
  blockedByTools,
  groupBySource,
  nonEditableNote,
  pluginHint,
  togglePlugin,
  toggleServer,
  toggleSkill,
  totals
} from '../src/state/extensions'

const fields = (extra: Partial<AgentFields> = {}): AgentFields => ({
  name: 'a',
  description: 'd',
  model: null,
  color: null,
  icon: null,
  tools: null,
  commands: null,
  memory: null,
  memoryLimit: null,
  computerUse: null,
  provider: null,
  autoCompactWindow: null,
  serversOff: null,
  skillsOff: null,
  plugins: null,
  mcpServers: null,
  hooks: null,
  acp: null,
  agui: null,
  ...extra
})
const server = (name: string, extra: Partial<LoadoutServer> = {}): LoadoutServer => ({
  name,
  status: 'connected',
  source: 'user',
  transport: 'stdio',
  plugin: null,
  tools: [],
  scope: 'user',
  note: null,
  connector: null,
  ...extra
})
const skill = (name: string, extra: Partial<LoadoutSkill> = {}): LoadoutSkill => ({
  name,
  description: '',
  source: 'user',
  plugin: null,
  tokens: null,
  on: true,
  editable: true,
  ...extra
})
const plugin = (id: string, enabled: boolean): LoadoutPlugin => ({ id, enabled, skills: 0, servers: 0, hooks: 0 })
const loadout = (extra: Partial<Loadout> = {}): Loadout => ({
  engine: 'claude',
  version: '2.1.322',
  folder: '/w',
  agent: null,
  servers: [],
  plugins: [],
  skills: [],
  hooks: [],
  errors: {},
  at: 0,
  ...extra
})

describe('SOURCE_LABEL and groupBySource', () => {
  it('names every source', () => {
    expect(SOURCE_LABEL).toEqual({
      user: 'You',
      local: 'This folder only',
      project: 'Project',
      plugin: 'Plugin',
      claudeai: 'claude.ai',
      agent: 'This agent',
      zumibot: 'Added by ZumiBot',
      bundled: 'Built in',
      other: 'Other'
    })
  })

  it('groups in the fixed source order, keeps each group in input order and leaves empty groups out', () => {
    const rows = [
      { source: 'other' as const, n: 1 },
      { source: 'plugin' as const, n: 2 },
      { source: 'user' as const, n: 3 },
      { source: 'claudeai' as const, n: 4 },
      { source: 'plugin' as const, n: 5 },
      { source: 'zumibot' as const, n: 6 }
    ]
    const groups = groupBySource(rows)
    expect(groups.map((g) => g.source)).toEqual(['user', 'plugin', 'claudeai', 'zumibot', 'other'])
    expect(groups.find((g) => g.source === 'plugin')?.rows.map((r) => r.n)).toEqual([2, 5])
    expect(groupBySource([])).toEqual([])
  })

  it('puts a source it does not know after the known ones, never dropping its rows', () => {
    const groups = groupBySource([{ source: 'mystery' }, { source: 'user' }])
    expect(groups.map((g) => g.source)).toEqual(['user', 'mystery'])
  })
})

describe('blockedByTools', () => {
  it('is false when the agent has no tools list or an empty one', () => {
    expect(blockedByTools(null, 'github')).toBe(false)
    expect(blockedByTools([], 'github')).toBe(false)
  })

  it('is true when a tools list names nothing of the server', () => {
    expect(blockedByTools(['Read'], 'github')).toBe(true)
    expect(blockedByTools(['mcp__githubx__a', 'mcp__gith'], 'github')).toBe(true)
  })

  it('is false for a tool of the server or the bare server prefix', () => {
    expect(blockedByTools(['mcp__github__x'], 'github')).toBe(false)
    expect(blockedByTools(['Read', 'mcp__github'], 'github')).toBe(false)
  })

  it('reads a server name the way the CLI turns it into a tool prefix', () => {
    expect(blockedByTools(['mcp__claude_ai_Gmail__send'], 'claude.ai Gmail')).toBe(false)
    expect(blockedByTools(['mcp__plugin_chrome-devtools-mcp_chrome-devtools__click'], 'plugin:chrome-devtools-mcp:chrome-devtools')).toBe(
      false
    )
    expect(blockedByTools(['mcp__claude_ai_Gmail__send'], 'claude.ai Drive')).toBe(true)
  })
})

describe('agentServerRows', () => {
  const l = loadout({
    servers: [
      server('github'),
      server('claude.ai Gmail', { source: 'claudeai' }),
      server('zumibot_todos', { source: 'zumibot' }),
      server('own', { source: 'agent' })
    ]
  })

  it('marks what the agent switched off and what its tools list leaves out', () => {
    const rows = agentServerRows(l, fields({ serversOff: ['claude.ai Gmail'], tools: ['mcp__github__x'] }))
    expect(rows.map((r) => [r.name, r.onForAgent, r.blockedByTools])).toEqual([
      ['github', true, false],
      ['claude.ai Gmail', false, true],
      ['zumibot_todos', true, true],
      ['own', true, true]
    ])
  })

  it("lets only a server that is not ZumiBot's or the agent's own be switched", () => {
    const rows = agentServerRows(l, fields())
    expect(rows.map((r) => [r.name, r.toggleable])).toEqual([
      ['github', true],
      ['claude.ai Gmail', true],
      ['zumibot_todos', false],
      ['own', false]
    ])
  })

  it('never lets a catalog connector row be switched here', () => {
    const rows = agentServerRows(
      loadout({
        servers: [server('claude.ai Gmail', { source: 'claudeai', connector: 'gmail' }), server('claude.ai Other', { source: 'claudeai' })]
      }),
      fields()
    )
    expect(rows.map((r) => [r.name, r.toggleable])).toEqual([
      ['claude.ai Gmail', false],
      ['claude.ai Other', true]
    ])
  })

  it('lets a catalog connector row be switched back on only while the draft serversOff lists it', () => {
    const gmail = loadout({ servers: [server('claude.ai Gmail', { source: 'claudeai', connector: 'notion' })] })
    const [listed] = agentServerRows(gmail, fields({ serversOff: ['claude.ai Gmail'] }))
    expect([listed.toggleable, listed.onForAgent]).toEqual([true, false])
    const [cleared] = agentServerRows(gmail, fields({ serversOff: ['other'] }))
    expect([cleared.toggleable, cleared.onForAgent]).toEqual([false, true])
    // A fixed source stays fixed even when listed.
    const [fixed] = agentServerRows(
      loadout({ servers: [server('zumibot_todos', { source: 'zumibot', connector: 'notion' })] }),
      fields({ serversOff: ['zumibot_todos'] })
    )
    expect(fixed.toggleable).toBe(false)
  })

  it("keeps the loadout row's own fields", () => {
    const [row] = agentServerRows(l, fields())
    expect(row).toMatchObject({ name: 'github', status: 'connected', source: 'user', transport: 'stdio' })
  })
})

describe('agentSkillRows', () => {
  const l = loadout({ skills: [skill('a'), skill('b'), skill('c', { on: false })] })

  it('is on for the agent unless it is off globally or listed off', () => {
    const rows = agentSkillRows(l, fields({ skillsOff: ['b', 'c'] }))
    expect(rows.map((r) => [r.name, r.onForAgent])).toEqual([
      ['a', true],
      ['b', false],
      ['c', false]
    ])
  })

  it('lets a skill be switched for one agent only while it is on globally', () => {
    expect(agentSkillRows(l, fields()).map((r) => r.toggleable)).toEqual([true, true, false])
  })
})

describe('agentPluginRows', () => {
  const l = loadout({ plugins: [plugin('a@m', true), plugin('b@m', false), plugin('c@m', true)] })

  it("takes the agent's override over the global state", () => {
    const rows = agentPluginRows(l, fields({ plugins: { 'b@m': true, 'c@m': false } }))
    expect(rows.map((r) => [r.id, r.onForAgent, r.toggleable])).toEqual([
      ['a@m', true, true],
      ['b@m', true, true],
      ['c@m', false, true]
    ])
  })

  it('never reads an override through the prototype chain: ids like toString and __proto__ fall back to the global state', () => {
    const ids = ['toString', 'constructor', '__proto__', 'hasOwnProperty']
    const rows = agentPluginRows(
      loadout({ plugins: ids.flatMap((id) => [plugin(id, true), plugin(id + '!', false)]) }),
      fields({ plugins: { 'a@m': false } })
    )
    for (const r of rows) expect(r.onForAgent, r.id).toBe(r.enabled)
    expect(rows.every((r) => typeof r.onForAgent === 'boolean')).toBe(true)
  })

  it('still reads an own override with such an id', () => {
    const rows = agentPluginRows(
      loadout({ plugins: [plugin('__proto__', true), plugin('toString', false)] }),
      fields({
        plugins: Object.fromEntries([
          ['__proto__', false],
          ['toString', true]
        ])
      })
    )
    expect(rows.map((r) => [r.id, r.onForAgent])).toEqual([
      ['__proto__', false],
      ['toString', true]
    ])
  })
})

describe('toggleServer and toggleSkill', () => {
  it('switching a server off then on gives null again', () => {
    const off = toggleServer(fields(), 'github', false)
    expect(off).toEqual({ serversOff: ['github'] })
    const on = toggleServer(fields(off), 'github', true)
    expect(on).toEqual({ serversOff: null })
  })

  it('keeps the other names in order and adds each name once', () => {
    const f = fields({ serversOff: ['a', 'b'] })
    expect(toggleServer(f, 'c', false)).toEqual({ serversOff: ['a', 'b', 'c'] })
    expect(toggleServer(f, 'a', false)).toEqual({ serversOff: ['a', 'b'] })
    expect(toggleServer(f, 'a', true)).toEqual({ serversOff: ['b'] })
    expect(toggleServer(fields({ serversOff: ['a', 'b', 'a'] }), 'b', true)).toEqual({ serversOff: ['a'] })
  })

  it('switching on a server that was never off changes nothing', () => {
    expect(toggleServer(fields(), 'x', true)).toEqual({ serversOff: null })
    expect(toggleServer(fields({ serversOff: ['a'] }), 'x', true)).toEqual({ serversOff: ['a'] })
  })

  it('round-trips names with spaces, dots, colons and @', () => {
    const names = ['claude.ai Google Drive', 'plugin:chrome-devtools-mcp:chrome-devtools', 'a@b']
    let f = fields()
    for (const n of names) f = fields({ ...f, ...toggleServer(f, n, false) })
    expect(f.serversOff).toEqual(names)
    for (const n of names) f = fields({ ...f, ...toggleServer(f, n, true) })
    expect(f.serversOff).toBeNull()
  })

  it('does the same for skills, in its own key', () => {
    const off = toggleSkill(fields({ serversOff: ['s'] }), 'apple-design', false)
    expect(off).toEqual({ skillsOff: ['apple-design'] })
    expect(toggleSkill(fields(off), 'apple-design', true)).toEqual({ skillsOff: null })
    expect(Object.keys(off)).toEqual(['skillsOff'])
  })

  it('does not change the draft it was given', () => {
    const f = fields({ serversOff: ['a'] })
    toggleServer(f, 'b', false)
    toggleServer(f, 'a', true)
    expect(f.serversOff).toEqual(['a'])
  })
})

describe('togglePlugin', () => {
  it('writes an override that differs from the global state', () => {
    expect(togglePlugin(fields(), 'a@m', false, true)).toEqual({ plugins: { 'a@m': false } })
    expect(togglePlugin(fields(), 'a@m', true, false)).toEqual({ plugins: { 'a@m': true } })
  })

  it('removes the entry when the choice equals the global state, and an empty map becomes null', () => {
    expect(togglePlugin(fields({ plugins: { 'a@m': false } }), 'a@m', true, true)).toEqual({ plugins: null })
    expect(togglePlugin(fields(), 'a@m', true, true)).toEqual({ plugins: null })
    expect(togglePlugin(fields({ plugins: { 'a@m': false, 'b@m': true } }), 'a@m', true, true)).toEqual({ plugins: { 'b@m': true } })
  })

  it('replaces an entry in place and keeps the other entries', () => {
    const f = fields({ plugins: { 'x@m': true, 'a@m': false, 'y@m': false } })
    const next = togglePlugin(f, 'a@m', true, false)
    expect(next.plugins).toEqual({ 'x@m': true, 'a@m': true, 'y@m': false })
    expect(Object.keys(next.plugins ?? {})).toEqual(['x@m', 'a@m', 'y@m'])
  })

  it('keeps an id with odd characters, even __proto__, as an own key', () => {
    const next = togglePlugin(fields(), '__proto__', false, true)
    expect(Object.keys(next.plugins ?? {})).toEqual(['__proto__'])
    expect(Object.getPrototypeOf(next.plugins)).toBe(Object.prototype)
    const spaced = togglePlugin(fields(), 'my plugin:v1.2@market place', false, true)
    expect(spaced.plugins).toEqual({ 'my plugin:v1.2@market place': false })
  })

  it('treats toString, constructor and __proto__ as plain ids next to other entries: only booleans, only own keys', () => {
    for (const id of ['toString', 'constructor', '__proto__']) {
      const f = fields({ plugins: { 'a@m': false } })
      const off = togglePlugin(f, id, false, true).plugins
      expect(Object.keys(off ?? {}), id).toEqual(['a@m', id])
      expect(
        Object.values(off ?? {}).every((v) => typeof v === 'boolean'),
        id
      ).toBe(true)
      // Matching the global state removes nothing that was never an own entry, and adds nothing.
      expect(togglePlugin(f, id, true, true).plugins, id).toEqual({ 'a@m': false })
      // Switching it back on from its own override drops the entry again.
      expect(togglePlugin(fields({ plugins: off }), id, true, true).plugins, id).toEqual({ 'a@m': false })
    }
  })

  it('does not change the draft it was given', () => {
    const f = fields({ plugins: { 'a@m': false } })
    togglePlugin(f, 'a@m', true, true)
    togglePlugin(f, 'b@m', false, true)
    expect(f.plugins).toEqual({ 'a@m': false })
  })
})

describe('totals', () => {
  it('counts only what is on for the agent', () => {
    const l = loadout({
      servers: [
        server('a', { tools: ['t1', 't2'] }),
        server('b', { status: 'failed', tools: ['t3'] }),
        server('c', { status: 'connected', tools: ['t4', 't5', 't6'] }),
        server('d', { status: 'needs-auth' })
      ],
      skills: [
        skill('s1', { tokens: 100 }),
        skill('s2', { tokens: null }),
        skill('s3', { tokens: 50 }),
        skill('s4', { tokens: 7, on: false })
      ]
    })
    const f = fields({ serversOff: ['c'], skillsOff: ['s3'] })
    expect(totals(agentServerRows(l, f), agentSkillRows(l, f))).toEqual({
      servers: 3,
      connected: 1,
      tools: 3,
      skillsOn: 2,
      skillTokens: 100
    })
  })

  it('ignores a disabled server: it is not loaded, so it adds no server, connection or tool', () => {
    const l = loadout({ servers: [server('a', { tools: ['t1'] }), server('gone', { status: 'disabled', tools: ['t2', 't3'] })] })
    expect(totals(agentServerRows(l, fields()), [])).toEqual({ servers: 1, connected: 1, tools: 1, skillsOn: 0, skillTokens: 0 })
  })

  it('counts a server the tools list leaves out as loaded and connected, but not its tools', () => {
    const l = loadout({ servers: [server('a', { tools: ['t1', 't2'] }), server('b', { tools: ['t3', 't4', 't5'] })] })
    const f = fields({ tools: ['mcp__a__t1'] })
    const rows = agentServerRows(l, f)
    expect(rows.map((r) => r.blockedByTools)).toEqual([false, true])
    expect(totals(rows, [])).toEqual({ servers: 2, connected: 2, tools: 2, skillsOn: 0, skillTokens: 0 })
  })

  it('is all zeros for an empty loadout', () => {
    expect(totals([], [])).toEqual({ servers: 0, connected: 0, tools: 0, skillsOn: 0, skillTokens: 0 })
  })
})

describe('pluginHint', () => {
  it('asks for a save when the draft turns a plugin on that the saved agent has off', () => {
    const draft = fields({ plugins: { 'a@m': true } })
    expect(pluginHint(draft, fields(), 'a@m', false)).toBe('save-to-see')
  })

  it('shows nothing when the saved agent already has it on, or the draft has it off', () => {
    expect(pluginHint(fields({ plugins: { 'a@m': true } }), fields({ plugins: { 'a@m': true } }), 'a@m', false)).toBeNull()
    expect(pluginHint(fields(), fields(), 'a@m', true)).toBeNull()
    expect(pluginHint(fields({ plugins: { 'a@m': false } }), fields(), 'a@m', false)).toBeNull()
    expect(pluginHint(fields({ plugins: { 'a@m': false } }), fields(), 'a@m', true)).toBeNull()
  })

  it("reads each side's effective state: the global state unless overridden", () => {
    // Saved agent has it on by an override; the draft drops the override of a globally off plugin: off now, nothing to save for.
    expect(pluginHint(fields(), fields({ plugins: { 'a@m': true } }), 'a@m', false)).toBeNull()
    // Saved agent has it off by an override; the draft drops it on a globally on plugin: now on.
    expect(pluginHint(fields(), fields({ plugins: { 'a@m': false } }), 'a@m', true)).toBe('save-to-see')
  })

  it('never reads an override through the prototype chain', () => {
    for (const id of ['toString', 'constructor', '__proto__']) {
      const map = { 'a@m': false }
      // No own entry on either side: both read the global state, so nothing changed.
      expect(pluginHint(fields({ plugins: map }), fields({ plugins: map }), id, false), id).toBeNull()
      expect(pluginHint(fields({ plugins: map }), fields({ plugins: map }), id, true), id).toBeNull()
      // An own entry in the draft only is a real change.
      expect(
        pluginHint(fields({ plugins: { ...map, ...Object.fromEntries([[id, true]]) } }), fields({ plugins: map }), id, false),
        id
      ).toBe('save-to-see')
    }
  })

  it('shows nothing for an agent that was never saved', () => {
    expect(pluginHint(fields({ plugins: { 'a@m': true } }), null, 'a@m', false)).toBeNull()
  })
})

describe('nonEditableNote', () => {
  it('says nothing about a block that is absent or editable', () => {
    expect(nonEditableNote(fields())).toEqual([])
    expect(nonEditableNote(fields({ mcpServers: { entries: [], editable: true }, hooks: { config: {}, editable: true } }))).toEqual([])
  })

  it('names each block that is kept in the file but not applied', () => {
    expect(nonEditableNote(fields({ mcpServers: { entries: [], editable: false } }))).toEqual([
      'Its mcpServers block is kept in the file but not applied (its shape is not understood).'
    ])
    expect(nonEditableNote(fields({ mcpServers: { entries: [], editable: false }, hooks: { config: {}, editable: false } }))).toEqual([
      'Its mcpServers block is kept in the file but not applied (its shape is not understood).',
      'Its hooks block is kept in the file but not applied (its shape is not understood).'
    ])
  })
})
