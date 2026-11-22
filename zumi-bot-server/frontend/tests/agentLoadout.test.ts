import { describe, expect, it } from 'vitest'
import { EXT_TEXT, type Loadout, type LoadoutHook, type LoadoutServer, type LoadoutSkill } from '@zumibot/shared/extensions'
import type { AgentFields } from '@zumibot/shared/frontmatter'
import { parseAgent, serializeAgent } from '@zumibot/shared/frontmatter'
import type { VaultListItem } from '@zumibot/shared/vault'
import { agentServerRows, agentSkillRows, blockNoteOf } from '../src/state/extensions'
import {
  CACHE_NOTE,
  cacheNote,
  chooseFolder,
  defOfInput,
  hookTags,
  loadoutKey,
  ownHookRows,
  ownHookSeed,
  ownServerRows,
  ownServerSeed,
  readOnlyNote,
  removeOwnHook,
  removeOwnServer,
  saveOwnHook,
  saveOwnServer,
  serverTags,
  skillTags,
  totalsText,
  vaultKeysOf
} from '../src/state/agentLoadout'

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
const hook = (extra: Partial<LoadoutHook> = {}): LoadoutHook => ({
  event: 'PreToolUse',
  matcher: '',
  type: 'command',
  command: 'x',
  timeout: null,
  source: 'user',
  plugin: null,
  at: null,
  stamp: null,
  ...extra
})
const loadout = (extra: Partial<Loadout> = {}): Loadout => ({
  engine: 'claude',
  version: '2.1.322',
  folder: '/w',
  agent: 'a',
  servers: [],
  plugins: [],
  skills: [],
  hooks: [],
  errors: {},
  at: 0,
  ...extra
})

describe('serverTags', () => {
  const row = (s: LoadoutServer, f = fields()) => agentServerRows(loadout({ servers: [s] }), f)[0]

  it('says a ZumiBot row is always on and an own row is in the file', () => {
    expect(serverTags(row(server('zumibot_todos', { source: 'zumibot' })))).toEqual(['Added by ZumiBot · always on'])
    expect(serverTags(row(server('mine', { source: 'agent' })))).toEqual(["In this agent's file"])
  })

  it('adds the fixed sentence of a dropped own server', () => {
    const note = 'Not started: no Vault key GITHUB_TOKEN is granted to this agent'
    expect(serverTags(row(server('mine', { source: 'agent', status: 'disabled', note })))).toEqual(["In this agent's file", note])
  })

  it('says a server the tools list leaves out is not in it, and has no tag when nothing applies', () => {
    expect(serverTags(row(server('github'), fields({ tools: ['Read'] })))).toEqual(["Not in this agent's tools list"])
    expect(serverTags(row(server('github')))).toEqual([])
  })
})

describe('skillTags', () => {
  it('names a skill that is off for everyone, since it has no switch', () => {
    const rows = agentSkillRows(loadout({ skills: [skill('a', { on: false }), skill('b')] }), fields())
    expect(skillTags(rows[0])).toEqual(['Off for everyone'])
    expect(skillTags(rows[1])).toEqual([])
  })
})

describe('hookTags', () => {
  it('tells where a hook comes from and how to drop it', () => {
    expect(hookTags(hook({ source: 'plugin' }))).toEqual(['Turn off the plugin that adds it to drop it'])
    expect(hookTags(hook({ source: 'zumibot' }))).toEqual(['Added by ZumiBot · always on'])
    expect(hookTags(hook({ source: 'agent' }))).toEqual(["In this agent's file"])
    expect(hookTags(hook({ source: 'user' }))).toEqual(['Applies to every agent'])
    expect(hookTags(hook({ source: 'project' }))).toEqual(['Applies to every agent'])
  })
})

describe('cacheNote', () => {
  it('is null when nothing the switches write differs from the saved agent', () => {
    expect(cacheNote(fields(), fields())).toBeNull()
    expect(cacheNote(fields(), null)).toBeNull()
    expect(cacheNote(fields({ serversOff: ['a', 'b'] }), fields({ serversOff: ['b', 'a'] }))).toBeNull()
    expect(cacheNote(fields({ plugins: { x: true, y: false } }), fields({ plugins: { y: false, x: true } }))).toBeNull()
  })

  it('shows the re-read note when an off list or a plugin choice differs', () => {
    expect(CACHE_NOTE).toBe("Changing these makes the agent's next message re-read its whole context once.")
    expect(cacheNote(fields({ serversOff: ['a'] }), fields())).toBe(CACHE_NOTE)
    expect(cacheNote(fields({ skillsOff: ['s'] }), fields())).toBe(CACHE_NOTE)
    expect(cacheNote(fields({ plugins: { x: false } }), fields())).toBe(CACHE_NOTE)
    expect(cacheNote(fields(), fields({ skillsOff: ['s'] }))).toBe(CACHE_NOTE)
  })

  it("also shows it when the agent's own servers differ (they change the tool list), never for its own hooks (they change no prompt)", () => {
    const srv = (command: string) => ({ entries: [{ name: 'db', def: { command } }], editable: true })
    expect(cacheNote(fields({ mcpServers: srv('a') }), fields())).toBe(CACHE_NOTE)
    expect(cacheNote(fields({ mcpServers: srv('b') }), fields({ mcpServers: srv('a') }))).toBe(CACHE_NOTE)
    expect(cacheNote(fields(), fields({ mcpServers: srv('a') }))).toBe(CACHE_NOTE)
    expect(cacheNote(fields({ mcpServers: srv('a') }), fields({ mcpServers: srv('a') }))).toBeNull()
    expect(
      cacheNote(fields({ hooks: { config: { Stop: [{ hooks: [{ type: 'command', command: 'x' }] }] }, editable: true } }), fields())
    ).toBeNull()
  })
})

describe('loadoutKey', () => {
  it('changes with what the saved agent loads and not with the rest of the file', () => {
    expect(loadoutKey(fields({ description: 'other' }))).toBe(loadoutKey(fields()))
    expect(loadoutKey(fields({ serversOff: ['a'] }))).not.toBe(loadoutKey(fields()))
    expect(loadoutKey(fields({ plugins: { x: true } }))).not.toBe(loadoutKey(fields()))
    expect(loadoutKey(fields({ hooks: { config: {}, editable: true } }))).not.toBe(loadoutKey(fields()))
    expect(loadoutKey(null)).toBe(loadoutKey(null))
  })
})

describe('chooseFolder', () => {
  it('uses the agent last folder, else home', () => {
    expect(chooseFolder('/work/app', '/home/me')).toBe('/work/app')
    expect(chooseFolder(null, '/home/me')).toBe('/home/me')
    expect(chooseFolder('', '/home/me')).toBe('/home/me')
  })
})

describe('totalsText', () => {
  it('reads like the card header', () => {
    expect(totalsText({ servers: 3, connected: 2, tools: 40, skillsOn: 5, skillTokens: 1200 })).toBe(
      '3 servers · 2 connected · 40 tools · 5 skills on (~1,200 tokens)'
    )
    expect(totalsText({ servers: 1, connected: 1, tools: 1, skillsOn: 1, skillTokens: 0 })).toBe(
      '1 server · 1 connected · 1 tool · 1 skill on'
    )
  })
})

describe('vaultKeysOf', () => {
  const item = (extra: Record<string, unknown>) =>
    ({ id: 'i', updatedAt: 1, name: 'n', agents: [], label: 'n', ...extra }) as unknown as VaultListItem
  it('keeps the API keys granted to the agent, by name, one per env name', () => {
    const items = [
      item({ id: '1', kind: 'apiKey', name: 'Zed', env: 'Z_TOKEN', agents: ['a'] }),
      item({ id: '2', kind: 'apiKey', name: 'Github', env: 'GITHUB_TOKEN', agents: ['a', 'b'] }),
      item({ id: '3', kind: 'apiKey', name: 'Other', env: 'OTHER', agents: ['b'] }),
      item({ id: '4', kind: 'login', name: 'Site', agents: ['a'] }),
      item({ id: '5', kind: 'apiKey', name: 'Github 2', env: 'GITHUB_TOKEN', agents: ['a'] })
    ]
    expect(vaultKeysOf(items, 'a')).toEqual([
      { env: 'GITHUB_TOKEN', name: 'Github 2' },
      { env: 'Z_TOKEN', name: 'Zed' }
    ])
  })
})

describe('defOfInput', () => {
  it('keeps the picked transport and every typed value, dropping a keep-it null', () => {
    expect(defOfInput({ type: 'stdio', command: 'node', args: ['s.js'], env: { A: '1', B: null } })).toEqual({
      type: 'stdio',
      command: 'node',
      args: ['s.js'],
      env: { A: '1' }
    })
    expect(defOfInput({ type: 'http', url: 'https://x', headers: { Authorization: 'Bearer ${vault:T}' } })).toEqual({
      type: 'http',
      url: 'https://x',
      headers: { Authorization: 'Bearer ${vault:T}' }
    })
  })
})

describe('own servers', () => {
  const own = (entries: Array<{ name: string; def: object | null }>, editable = true) =>
    fields({ mcpServers: { entries: entries as never, editable } })

  it('lists inline servers with their transport and a bare reference as already loaded', () => {
    const f = own([
      { name: 'db', def: { command: 'node' } },
      { name: 'web', def: { url: 'https://x' } },
      { name: 'github', def: null }
    ])
    const rows = ownServerRows(f, null)
    expect(rows.map((r) => [r.name, r.detail])).toEqual([
      ['db', 'stdio'],
      ['web', 'http'],
      ['github', 'already loaded']
    ])
    expect(ownServerRows(fields(), null)).toEqual([])
  })

  it('flags an inline server named like one the agent already loads, and shows why a dropped one is off', () => {
    const f = own([
      { name: 'github', def: { command: 'x' } },
      { name: 'db', def: { command: 'x' } },
      { name: 'ref', def: null }
    ])
    const l = loadout({
      servers: [
        server('github', { source: 'plugin' }),
        server('db', { source: 'agent', status: 'disabled', note: 'Not started: no Vault key T is granted to this agent' }),
        server('ref', { source: 'user' })
      ]
    })
    const rows = ownServerRows(f, l)
    expect(rows[0].note).toBe('Same name as a server this agent already loads.')
    expect(rows[1].note).toBe('Not started: no Vault key T is granted to this agent')
    expect(rows[2].note).toBeNull()
  })

  it("shows the server's own clash note when the CLI listed only the agent's server (it replaced the configured one)", () => {
    const f = own([{ name: 'github', def: { command: 'x' } }])
    const rows = ownServerRows(f, loadout({ servers: [server('github', { source: 'agent', note: EXT_TEXT.sameName })] }))
    expect(rows[0].note).toBe(EXT_TEXT.sameName)
  })

  it('opens a form on the entry as a view with no stored values', () => {
    const v = ownServerSeed({ name: 'db', def: { command: 'node', env: { A: '1' } } })
    expect(v).toMatchObject({ name: 'db', def: { command: 'node', env: { A: '1' } }, hidden: { env: [], headers: [] } })
  })

  it('adds, replaces in place, renames and removes; an empty list is null', () => {
    const base = own([
      { name: 'a', def: { command: 'x' } },
      { name: 'b', def: { command: 'y' } }
    ])
    const added = saveOwnServer(base, null, 'c', { type: 'stdio', command: 'z' })
    expect(added).toEqual({
      ok: true,
      patch: {
        mcpServers: {
          entries: [
            { name: 'a', def: { command: 'x' } },
            { name: 'b', def: { command: 'y' } },
            { name: 'c', def: { type: 'stdio', command: 'z' } }
          ],
          editable: true
        }
      }
    })
    const renamed = saveOwnServer(base, 'a', 'a2', { type: 'stdio', command: 'x2' })
    expect(renamed.ok && renamed.patch.mcpServers?.entries.map((e) => e.name)).toEqual(['a2', 'b'])
    const first = saveOwnServer(fields(), null, 'solo', { type: 'http', url: 'https://x' })
    expect(first.ok && first.patch.mcpServers?.entries).toEqual([{ name: 'solo', def: { type: 'http', url: 'https://x' } }])
    expect(removeOwnServer(base, 'a')).toEqual({
      ok: true,
      patch: { mcpServers: { entries: [{ name: 'b', def: { command: 'y' } }], editable: true } }
    })
    expect(removeOwnServer(own([{ name: 'a', def: { command: 'x' } }]), 'a')).toEqual({ ok: true, patch: { mcpServers: null } })
  })

  it('refuses a name another entry already has and a def with no command or url', () => {
    const base = own([
      { name: 'a', def: { command: 'x' } },
      { name: 'b', def: null }
    ])
    expect(saveOwnServer(base, null, 'a', { type: 'stdio', command: 'z' })).toMatchObject({ ok: false })
    expect(saveOwnServer(base, 'b', 'a', { type: 'stdio', command: 'z' })).toMatchObject({ ok: false })
    expect(saveOwnServer(base, null, 'c', { type: 'stdio', command: '' })).toMatchObject({ ok: false })
    expect(saveOwnServer(own([], false), null, 'c', { type: 'stdio', command: 'z' })).toMatchObject({ ok: false })
  })

  it('writes a valid entry through the file and keeps the others', () => {
    const raw = '---\nname: a\ndescription: d\n---\nbody\n'
    const parsed = parseAgent(raw)
    if (!parsed.ok) throw new Error('parse')
    const r = saveOwnServer(parsed.fields, null, 'db', {
      type: 'stdio',
      command: 'node',
      args: ['s.js'],
      env: { URL: 'Bearer ${vault:T}' }
    })
    if (!r.ok) throw new Error(r.error)
    const text = serializeAgent(raw, { ...parsed.fields, ...r.patch }, parsed.body)
    const back = parseAgent(text)
    expect(back.ok && back.fields.mcpServers).toEqual({
      entries: [{ name: 'db', def: { type: 'stdio', command: 'node', args: ['s.js'], env: { URL: 'Bearer ${vault:T}' } } }],
      editable: true
    })
  })
})

// A patch the rule allowed; a refusal fails the test with its sentence.
const patchOf = (r: { ok: true; patch: Partial<AgentFields> } | { ok: false; error: string }): Partial<AgentFields> => {
  if (!r.ok) throw new Error(r.error)
  return r.patch
}

describe('blocks the file keeps but does not apply (M1)', () => {
  const cmd = (command: string) => ({ type: 'command' as const, command })
  it('refuses to remove an own server, or to add, change or remove a hook, of such a block', () => {
    expect(
      removeOwnServer(fields({ mcpServers: { entries: [{ name: 'a', def: { command: 'x' } }], editable: false } }), 'a')
    ).toMatchObject({ ok: false })
    const locked = fields({ hooks: { config: { Stop: [{ hooks: [cmd('a')] }] }, editable: false } })
    expect(saveOwnHook(locked, { event: 'Stop', matcher: '', command: 'b' })).toMatchObject({ ok: false })
    expect(saveOwnHook(locked, { event: 'Stop', matcher: '', command: 'b', at: { group: 0, hook: 0 } })).toMatchObject({ ok: false })
    expect(removeOwnHook(locked, 'Stop', { group: 0, hook: 0 })).toMatchObject({ ok: false })
  })
  it('names the block from its flag, not from the wording of a note', () => {
    expect(blockNoteOf(fields({ mcpServers: { entries: [], editable: false } }), 'mcpServers')).toMatch(/kept in the file but not applied/)
    expect(blockNoteOf(fields({ mcpServers: { entries: [], editable: false } }), 'hooks')).toBeNull()
    expect(blockNoteOf(fields({ hooks: { config: {}, editable: false } }), 'hooks')).toMatch(/kept in the file but not applied/)
    expect(blockNoteOf(fields(), 'hooks')).toBeNull()
  })
})

describe('own hooks', () => {
  it.each(['constructor', 'toString', '__proto__', 'hasOwnProperty'])(
    'takes the event name %s as data, never a prototype key (M2)',
    (event) => {
      const added = patchOf(saveOwnHook(fields(), { event, matcher: '', command: 'x' }))
      expect(Object.keys(added.hooks?.config ?? {})).toEqual([event])
      expect(removeOwnHook(fields(), event, { group: 0, hook: 0 })).toEqual({ ok: true, patch: { hooks: null } })
      expect(patchOf(saveOwnHook(fields(), { event, matcher: '', command: 'x', at: { group: 0, hook: 0 } })).hooks?.config[event]).toEqual([
        { hooks: [{ type: 'command', command: 'x' }] }
      ])
    }
  )

  const cmd = (command: string, timeout?: number) => ({ type: 'command' as const, command, ...(timeout !== undefined ? { timeout } : {}) })
  const withHooks = (config: Record<string, Array<{ matcher?: string; hooks: object[] }>>) =>
    fields({ hooks: { config: config as never, editable: true } })

  it('lists every command hook with its place', () => {
    const f = withHooks({
      PreToolUse: [{ matcher: 'Bash', hooks: [cmd('a.sh', 5), cmd('b.sh')] }, { hooks: [cmd('c.sh')] }],
      Stop: [{ hooks: [cmd('d.sh')] }]
    })
    const rows = ownHookRows(f)
    expect(rows.map((r) => [r.event, r.group, r.hook, r.matcher, r.command, r.timeout])).toEqual([
      ['PreToolUse', 0, 0, 'Bash', 'a.sh', 5],
      ['PreToolUse', 0, 1, 'Bash', 'b.sh', null],
      ['PreToolUse', 1, 0, '', 'c.sh', null],
      ['Stop', 0, 0, '', 'd.sh', null]
    ])
    expect(ownHookRows(fields())).toEqual([])
    expect(ownHookSeed(rows[0])).toEqual({
      event: 'PreToolUse',
      matcher: 'Bash',
      command: 'a.sh',
      timeout: 5,
      at: { group: 0, hook: 0 },
      stamp: null
    })
  })

  it('adds a hook as its own group, leaving matchers empty out of the group', () => {
    const r = saveOwnHook(fields(), { event: 'Stop', matcher: '', command: 'x.sh' })
    expect(r).toEqual({
      ok: true,
      patch: { hooks: { config: { Stop: [{ hooks: [{ type: 'command', command: 'x.sh' }] }] }, editable: true } }
    })
    const more = patchOf(
      saveOwnHook(withHooks({ Stop: [{ hooks: [cmd('a')] }] }), { event: 'Stop', matcher: 'Bash', command: 'b', timeout: 3 })
    )
    expect(more.hooks?.config.Stop).toEqual([{ hooks: [cmd('a')] }, { matcher: 'Bash', hooks: [cmd('b', 3)] }])
  })

  it('edits in place, and moves a hook to a group of its own when its matcher changes in a shared group', () => {
    const f = withHooks({ PreToolUse: [{ matcher: 'Bash', hooks: [cmd('a'), cmd('b')] }] })
    const same = patchOf(saveOwnHook(f, { event: 'PreToolUse', matcher: 'Bash', command: 'a2', timeout: 9, at: { group: 0, hook: 0 } }))
    expect(same.hooks?.config.PreToolUse).toEqual([{ matcher: 'Bash', hooks: [cmd('a2', 9), cmd('b')] }])
    const moved = patchOf(saveOwnHook(f, { event: 'PreToolUse', matcher: 'Edit', command: 'a', at: { group: 0, hook: 0 } }))
    expect(moved.hooks?.config.PreToolUse).toEqual([
      { matcher: 'Bash', hooks: [cmd('b')] },
      { matcher: 'Edit', hooks: [cmd('a')] }
    ])
    const whole = patchOf(
      saveOwnHook(withHooks({ PreToolUse: [{ matcher: 'Bash', hooks: [cmd('a')] }] }), {
        event: 'PreToolUse',
        matcher: 'Edit',
        command: 'a',
        at: { group: 0, hook: 0 }
      })
    )
    expect(whole.hooks?.config.PreToolUse).toEqual([{ matcher: 'Edit', hooks: [cmd('a')] }])
  })

  it('removes a hook, dropping its empty group and event, and an empty block is null', () => {
    const f = withHooks({ PreToolUse: [{ matcher: 'Bash', hooks: [cmd('a'), cmd('b')] }], Stop: [{ hooks: [cmd('c')] }] })
    expect(patchOf(removeOwnHook(f, 'PreToolUse', { group: 0, hook: 0 })).hooks?.config).toEqual({
      PreToolUse: [{ matcher: 'Bash', hooks: [cmd('b')] }],
      Stop: [{ hooks: [cmd('c')] }]
    })
    expect(patchOf(removeOwnHook(f, 'Stop', { group: 0, hook: 0 })).hooks?.config).toEqual({
      PreToolUse: [{ matcher: 'Bash', hooks: [cmd('a'), cmd('b')] }]
    })
    expect(removeOwnHook(withHooks({ Stop: [{ hooks: [cmd('c')] }] }), 'Stop', { group: 0, hook: 0 })).toEqual({
      ok: true,
      patch: { hooks: null }
    })
  })

  it('does not change the fields it was given', () => {
    const f = withHooks({ Stop: [{ hooks: [cmd('a')] }] })
    const before = JSON.stringify(f)
    saveOwnHook(f, { event: 'Stop', matcher: 'x', command: 'b', at: { group: 0, hook: 0 } })
    removeOwnHook(f, 'Stop', { group: 0, hook: 0 })
    expect(JSON.stringify(f)).toBe(before)
  })

  it('writes through the file as a block the parser reads back whole', () => {
    const raw = '---\nname: a\ndescription: d\n---\nbody\n'
    const parsed = parseAgent(raw)
    if (!parsed.ok) throw new Error('parse')
    const patch = patchOf(saveOwnHook(parsed.fields, { event: 'PreToolUse', matcher: 'Bash', command: './check.sh', timeout: 5 }))
    const back = parseAgent(serializeAgent(raw, { ...parsed.fields, ...patch }, parsed.body))
    expect(back.ok && back.fields.hooks).toEqual({
      config: { PreToolUse: [{ matcher: 'Bash', hooks: [cmd('./check.sh', 5)] }] },
      editable: true
    })
  })
})

describe('readOnlyNote', () => {
  it('says per-agent choices are for Claude agents, and that Zumi Bot is fixed', () => {
    expect(readOnlyNote('codex')).toBe('Per-agent choices apply to Claude agents only.')
    expect(readOnlyNote('acp')).toBe('Per-agent choices apply to Claude agents only.')
    expect(readOnlyNote('ag-ui')).toBe('Per-agent choices apply to Claude agents only.')
    expect(readOnlyNote('claude')).toBe("Zumi Bot's servers, skills and plugins are fixed, so this is a view only.")
  })
})
