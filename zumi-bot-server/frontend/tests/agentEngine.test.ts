import { describe, expect, it } from 'vitest'
import { CODEX_REFUSALS, engineCaps, spendCapRefusal, type Engine, type EngineCaps } from '@zumibot/shared/engine'
import { ZUMI_BOT_NAME } from '@zumibot/shared/zumiBot'
import { ACP_API_KEY_NOTE } from '@zumibot/shared/acp'
import { AGUI_API_KEY_NOTE, AGUI_TEXT } from '@zumibot/shared/agui'
import type { AgentSummary, ChatMeta, GroupInfo } from '@zumibot/shared/types'
import {
  CODEX_UNUSED_NOTE,
  CODEX_VAULT_NOTE,
  API_KEY_CODEX_NOTE,
  codexModelChoices,
  codexVaultNote,
  engineChoices,
  engineTag,
  modelAfterEngineSwitch,
  usesCodex,
  vaultGrantNote,
  CODEX_INFO_FALLBACK,
  CLAUDE_NOT_FOUND,
  cliMissing,
  showsCompactAt,
  joinsRooms,
  memberCaps,
  chatCaps,
  missingFeatures,
  missingFeaturesTitle,
  dailyCapAfterEngineSwitch,
  dailyCapBlocked,
  roomMissingFeaturesTitle,
  remoteChip,
  offersTodo
} from '../src/state/agentEngine'

describe('engineChoices', () => {
  it('offers Claude, Codex, ACP and a remote agent, the active one pressed', () => {
    expect(engineChoices(null, { found: true, models: [] }).map((c) => [c.value, c.label, c.active, c.disabled])).toEqual([
      ['claude', 'Claude', true, false],
      ['codex', 'Codex', false, false],
      // Never off: each ACP agent has its own command, which the server checks when a send runs.
      ['acp', 'ACP agent', false, false],
      // Never off: a remote agent needs nothing installed here.
      ['ag-ui', 'Remote agent (AG-UI)', false, false]
    ])
    expect(engineChoices('codex', { found: true, models: [] }).map((c) => c.active)).toEqual([false, true, false, false])
    expect(engineChoices('acp', { found: false, models: [] }).map((c) => [c.active, c.disabled])).toEqual([
      [false, false],
      [false, true],
      [true, false],
      [false, false]
    ])
    expect(engineChoices('ag-ui', { found: false, models: [] }).map((c) => [c.active, c.disabled])).toEqual([
      [false, false],
      [false, true],
      [false, false],
      [true, false]
    ])
  })
  it('disables Codex with the not-found sentence when the CLI is missing, but never the pick already made', () => {
    const missing = engineChoices(null, { found: false, models: [] })
    expect(missing[1]).toMatchObject({ disabled: true, title: CODEX_REFUSALS.notFound })
    expect(missing[0].disabled).toBe(false)
    // An agent already on Codex stays selectable so the user can see it and switch back.
    expect(engineChoices('codex', { found: false, models: [] })[1]).toMatchObject({ active: true, disabled: true })
  })
  it('a pick maps to the frontmatter value: codex or acp, or null for Claude', () => {
    expect(engineChoices(null, { found: true, models: [] }).map((c) => c.provider)).toEqual([null, 'codex', 'acp', 'ag-ui'])
  })
})

describe('showsCompactAt', () => {
  it("follows the agent's engine's compact cap", () => {
    expect(showsCompactAt(null)).toBe(engineCaps('claude').compact)
    expect(showsCompactAt('codex')).toBe(engineCaps('codex').compact)
  })
  it('hides Compact at for Codex while its compact cap is off, and only for Codex', () => {
    const codexOff = (e: 'claude' | 'codex') => ({ ...engineCaps(e), ...(e === 'codex' ? { compact: false } : {}) })
    expect(showsCompactAt('codex', codexOff)).toBe(false)
    expect(showsCompactAt(null, codexOff)).toBe(true)
    expect(showsCompactAt(undefined, codexOff)).toBe(true)
    const on = (e: 'claude' | 'codex') => ({ ...engineCaps(e), compact: true })
    expect(showsCompactAt('codex', on)).toBe(true)
  })
})

describe('usesCodex', () => {
  it('is true only for the exact codex provider', () => {
    expect(usesCodex({ provider: 'codex' })).toBe(true)
    expect(usesCodex({ provider: null })).toBe(false)
  })
})

describe('codexModelChoices', () => {
  it('Default (no key) first, then each model the CLI offers, the current one active', () => {
    const info = { found: true, models: ['gpt-5', 'gpt-5-mini'] }
    expect(codexModelChoices(null, info)).toEqual({
      choices: [
        { value: null, label: 'Default', active: true },
        { value: 'gpt-5', label: 'gpt-5', active: false },
        { value: 'gpt-5-mini', label: 'gpt-5-mini', active: false }
      ],
      custom: null
    })
    expect(codexModelChoices('gpt-5-mini', info).choices.map((c) => c.active)).toEqual([false, false, true])
  })
  it('a model outside the list, or any model when the list is empty, is custom free text', () => {
    expect(codexModelChoices('my-model', { found: true, models: ['gpt-5'] }).custom).toBe('my-model')
    expect(codexModelChoices('my-model', { found: true, models: [] })).toEqual({
      choices: [{ value: null, label: 'Default', active: false }],
      custom: 'my-model'
    })
    expect(codexModelChoices('inherit', { found: true, models: [] }).choices[0].active).toBe(true)
  })
})

describe('engineTag', () => {
  it('names Codex agents only', () => {
    expect(engineTag({ provider: 'codex' })).toBe('Codex')
    expect(engineTag({})).toBeNull()
  })
})

describe('vaultGrantNote', () => {
  const keysOff = (e: 'claude' | 'codex') => ({ ...engineCaps(e), ...(e === 'codex' ? { vaultKeys: false } : {}) })
  it('marks no agent while Codex runs get API keys (the vaultKeys cap, on by default)', () => {
    expect(engineCaps('codex').vaultKeys).toBe(true)
    for (const kind of ['apiKey', 'login', 'card', 'contact'] as const) {
      expect(vaultGrantNote(kind, { provider: 'codex' })).toBeNull()
      expect(vaultGrantNote(kind, {})).toBeNull()
    }
  })
  it('with the cap off, only an API key item shows the note, and only beside a Codex agent', () => {
    expect(vaultGrantNote('apiKey', { provider: 'codex' }, keysOff)).toBe(API_KEY_CODEX_NOTE)
    expect(vaultGrantNote('apiKey', {}, keysOff)).toBeNull()
    expect(vaultGrantNote('login', { provider: 'codex' }, keysOff)).toBeNull()
    expect(vaultGrantNote('card', { provider: 'codex' }, keysOff)).toBeNull()
  })
})

describe('texts and fallback', () => {
  it('uses the fixed sentence for the hidden controls', () => {
    expect(CODEX_UNUSED_NOTE).toBe('Tools, memory, computer use and command models are not used by Codex agents.')
    expect(API_KEY_CODEX_NOTE).toBe('API keys need a later version for Codex agents')
  })
  it('a failed lookup does not disable Codex', () => {
    expect(CODEX_INFO_FALLBACK).toEqual({ found: true, models: [] })
  })
})

describe('modelAfterEngineSwitch', () => {
  const models = ['gpt-5', 'gpt-5-mini']
  it('a Claude model does not carry over to Codex', () => {
    expect(modelAfterEngineSwitch('opus', 'codex', models)).toBeNull()
    expect(modelAfterEngineSwitch(null, 'codex', models)).toBeNull()
    expect(modelAfterEngineSwitch('inherit', 'codex', models)).toBeNull()
  })
  it('a Codex model does not carry over to Claude', () => {
    expect(modelAfterEngineSwitch('gpt-x', 'claude', models)).toBeNull()
    expect(modelAfterEngineSwitch('gpt-5', 'claude', models)).toBeNull()
  })
  it('a model valid for the target engine is kept', () => {
    expect(modelAfterEngineSwitch('opus', 'claude', models)).toBe('opus')
    expect(modelAfterEngineSwitch('inherit', 'claude', models)).toBe('inherit')
    expect(modelAfterEngineSwitch('gpt-5', 'codex', models)).toBe('gpt-5')
  })
})

describe('codexVaultNote', () => {
  it('states the honest limit every agent lives with under the Engine select, only while Codex is picked', () => {
    expect(CODEX_VAULT_NOTE).toBe(
      "Codex agents are kept off the vault's files as Claude agents are: a speed bump, not a wall. Agents run as the same user as this server, so a determined agent could still read the vault files. A reply whose guard can't start runs without it and without the agent's API keys, after a notice in the chat saying so."
    )
    expect(CODEX_VAULT_NOTE).not.toMatch(/no vault protection/i)
    expect(codexVaultNote('codex')).toBe(CODEX_VAULT_NOTE)
    expect(codexVaultNote(null)).toBeNull()
    expect(codexVaultNote(undefined)).toBeNull()
  })
})

describe('cliMissing: why a chat cannot send for want of its CLI', () => {
  const found = { found: true, models: [] },
    gone = { found: false, models: [] }
  it('a Codex chat is blocked by a missing codex, with the fixed sentence', () => {
    expect(cliMissing('codex', true, gone)).toBe(CODEX_REFUSALS.notFound)
    expect(cliMissing('codex', false, gone)).toBe(CODEX_REFUSALS.notFound)
  })
  it('a Codex chat with codex is never blocked by a missing claude', () => {
    expect(cliMissing('codex', false, found)).toBeNull()
    expect(cliMissing('codex', true, found)).toBeNull()
  })
  it('a Codex chat whose lookup has not answered (or failed) is not blocked: the server refuses a missing codex itself', () => {
    expect(cliMissing('codex', false, undefined)).toBeNull()
    expect(cliMissing('codex', false, CODEX_INFO_FALLBACK)).toBeNull()
  })
  it('a Claude chat keeps its rule: blocked by a missing claude, whatever codex does', () => {
    expect(CLAUDE_NOT_FOUND).toBe('Claude CLI not found')
    expect(cliMissing('claude', false, found)).toBe(CLAUDE_NOT_FOUND)
    expect(cliMissing('claude', false, undefined)).toBe(CLAUDE_NOT_FOUND)
    expect(cliMissing('claude', true, gone)).toBeNull()
  })
})

describe('rooms and engines', () => {
  const agent = (name: string, provider?: 'codex'): AgentSummary => ({
    filePath: `/a/${name}.md`,
    name,
    description: '',
    color: null,
    icon: null,
    error: null,
    builtIn: false,
    ...(provider ? { provider } : {})
  })
  const agents = [agent('ui'), agent('cx', 'codex'), agent(ZUMI_BOT_NAME)]
  const off =
    (flags: Partial<EngineCaps>) =>
    (e: Engine): EngineCaps => ({ ...engineCaps(e), ...(e === 'codex' ? flags : {}) })
  const group = (members: string[]): GroupInfo => ({ members, sessions: {}, seen: {}, role: '', active: [], queue: [] })
  const room = (members: string[]): ChatMeta => ({
    id: 'r',
    agentName: '',
    sessionId: null,
    cwd: '/w',
    title: '',
    createdAt: 1,
    updatedAt: 1,
    inFlight: false,
    group: group(members)
  })
  const single = (agentName: string): ChatMeta => ({
    id: 's',
    agentName,
    sessionId: null,
    cwd: '/w',
    title: '',
    createdAt: 1,
    updatedAt: 1,
    inFlight: false
  })

  it('a Codex agent joins a room while Codex rooms are on; Zumi Bot never does', () => {
    expect(joinsRooms(agent('ui'))).toBe(true)
    expect(joinsRooms(agent('cx', 'codex'))).toBe(true)
    expect(joinsRooms(agent(ZUMI_BOT_NAME))).toBe(false)
    expect(joinsRooms(agent('cx', 'codex'), off({ rooms: false }))).toBe(false)
    expect(joinsRooms(agent('ui'), off({ rooms: false }))).toBe(true)
  })

  it("a member's caps are its own engine's", () => {
    const caps = off({ compact: false, pause: false })
    expect(memberCaps(room(['ui', 'cx']), agents, 'cx', caps)).toMatchObject({ compact: false, pause: false, desktop: false })
    expect(memberCaps(room(['ui', 'cx']), agents, 'ui', caps)).toMatchObject({ compact: true, pause: true, desktop: true })
    // A member whose agent file is gone counts as Claude, as the server's lookup does.
    expect(memberCaps(room(['ui', 'gone']), agents, 'gone', caps)).toEqual(engineCaps('claude'))
  })

  it("a single chat's caps are its agent's engine's", () => {
    expect(chatCaps(single('cx'), agents)).toEqual(engineCaps('codex'))
    expect(chatCaps(single('ui'), agents)).toEqual(engineCaps('claude'))
  })

  it('a room offers what any member can do, but Pause only when every member can pause', () => {
    const caps = off({ pause: false, btw: false, files: false })
    const mixed = chatCaps(room(['ui', 'cx']), agents, caps)
    // Side questions, Files and the panels reach one member at a time: the Claude member has them.
    expect(mixed).toMatchObject({ btw: true, files: true, dispatch: true, desktop: true })
    // One Pause stops every member, and the server refuses it when any member's engine can't pause.
    expect(mixed.pause).toBe(false)
    expect(chatCaps(room(['ui', 'cx']), agents).pause).toBe(true)
    // A room of Codex members alone has only what Codex has.
    expect(chatCaps(room(['cx']), agents, caps)).toMatchObject({ btw: false, files: false, pause: false, desktop: false })
    expect(chatCaps(room(['ui']), agents, caps)).toEqual(engineCaps('claude'))
  })
})

describe('ACP agents (the cases a new engine forces)', () => {
  const gem = { provider: 'acp' as const }
  it("needs no CLI of ZumiBot's own: the server names a missing command when a send runs", () => {
    expect(cliMissing('acp', false, { found: false, models: [] })).toBeNull()
  })
  it('is tagged ACP', () => {
    expect(engineTag(gem)).toBe('ACP')
  })
  it('an API key grant says it reaches the agent only through its sign-in keys', () => {
    expect(vaultGrantNote('apiKey', gem)).toBe(ACP_API_KEY_NOTE)
    expect(vaultGrantNote('login', gem)).toBeNull()
  })
  it('keeps no model across a switch to ACP: its models are its own config options', () => {
    expect(modelAfterEngineSwitch('opus', 'acp', ['gpt-x'])).toBeNull()
    expect(modelAfterEngineSwitch('gpt-x', 'acp', ['gpt-x'])).toBeNull()
  })
})

describe('remote (AG-UI) agents (the cases a new engine forces)', () => {
  const rem = { provider: 'ag-ui' as const }
  it("needs no CLI of ZumiBot's own", () => {
    expect(cliMissing('ag-ui', false, { found: false, models: [] })).toBeNull()
  })
  it('is tagged Remote', () => {
    expect(engineTag(rem)).toBe('Remote')
  })
  it('an API key grant says it reaches the agent only as its auth key', () => {
    expect(vaultGrantNote('apiKey', rem)).toBe(AGUI_API_KEY_NOTE)
    expect(vaultGrantNote('login', rem)).toBeNull()
  })
  it("keeps no model across a switch to a remote agent: its model is its server's", () => {
    expect(modelAfterEngineSwitch('opus', 'ag-ui', ['gpt-x'])).toBeNull()
    expect(modelAfterEngineSwitch('gpt-x', 'ag-ui', ['gpt-x'])).toBeNull()
  })
})

describe('caps a room needs from every member', () => {
  const agent = (name: string, provider?: 'codex' | 'acp'): AgentSummary => ({
    filePath: `/a/${name}.md`,
    name,
    description: '',
    color: null,
    icon: null,
    error: null,
    builtIn: false,
    ...(provider ? { provider } : {})
  })
  const agents = [agent('ui'), agent('gem', 'acp')]
  const group = (members: string[]): GroupInfo => ({ members, sessions: {}, seen: {}, role: '', active: [], queue: [] })
  const room = (members: string[]): ChatMeta => ({
    id: 'r',
    agentName: '',
    sessionId: null,
    cwd: '/w',
    title: '',
    createdAt: 1,
    updatedAt: 1,
    inFlight: false,
    group: group(members)
  })

  it('Resend, Fork and spend caps hold only when every member has them, like Pause (the server refuses them otherwise)', () => {
    const mixed = chatCaps(room(['ui', 'gem']), agents)
    expect(mixed).toMatchObject({ resend: false, fork: false, cost: false, pause: false })
    // What one member reaches at a time stays on while any member has it.
    expect(mixed).toMatchObject({ files: true, models: true, bridges: true })
    expect(chatCaps(room(['ui']), agents)).toMatchObject({ resend: true, fork: true, cost: true })
  })
})

describe('missingFeatures', () => {
  it('lists nothing for an engine that has every feature', () => {
    expect(missingFeatures(engineCaps('claude'))).toEqual([])
    expect(missingFeaturesTitle('claude', engineCaps('claude'))).toBeUndefined()
  })
  it("lists ACP's gaps in the order the buttons appear, as one sentence naming the engine", () => {
    const list = missingFeatures(engineCaps('acp'))
    expect(list).toEqual(
      expect.arrayContaining([
        'Edit and Resend',
        'Fork',
        'Pause',
        'Side questions',
        'Compact',
        'The model picker',
        'Spend caps',
        "ZumiBot's to-do, vault, ask and browser tools"
      ])
    )
    const title = missingFeaturesTitle('acp', engineCaps('acp'))
    expect(title).toMatch(/^ACP agents can't use: Edit and Resend, Fork/)
    expect(title).toMatch(/\.$/)
  })
  it('lists only what is off, by cap', () => {
    expect(missingFeatures({ ...engineCaps('claude'), fork: false })).toEqual(['Fork'])
  })
})

describe('dailyCapAfterEngineSwitch', () => {
  it('drops the daily cap on a switch to an engine without cost (the field is hidden there), keeps it otherwise', () => {
    expect(dailyCapAfterEngineSwitch(5, 'acp')).toBeNull()
    expect(dailyCapAfterEngineSwitch(5, 'codex')).toBe(5)
    expect(dailyCapAfterEngineSwitch(5, 'claude')).toBe(5)
    expect(dailyCapAfterEngineSwitch(null, 'acp')).toBeNull()
  })
  it('reads the cap, not the engine name', () => {
    expect(dailyCapAfterEngineSwitch(5, 'claude', (e) => ({ ...engineCaps(e), cost: false }))).toBeNull()
  })
})

describe('dailyCapBlocked', () => {
  it('is the fixed sentence only for a cap that is set on an engine without cost', () => {
    expect(dailyCapBlocked('acp', 'gem', 5)).toBe(spendCapRefusal('acp', 'gem'))
    expect(dailyCapBlocked('acp', 'gem', null)).toBeNull()
    expect(dailyCapBlocked('claude', 'ui', 5)).toBeNull()
    expect(dailyCapBlocked('claude', 'ui', 5, (e) => ({ ...engineCaps(e), cost: false }))).toMatch(/^ui /)
  })
})

describe('roomMissingFeaturesTitle', () => {
  it("lists what the room as a whole can't do: nothing for Claude members, Resend, Fork and Spend caps for a mix with ACP", () => {
    const agent = (name: string, provider?: 'acp'): AgentSummary => ({
      filePath: `/a/${name}.md`,
      name,
      description: '',
      color: null,
      icon: null,
      error: null,
      builtIn: false,
      ...(provider ? { provider } : {})
    })
    const agents = [agent('ui'), agent('gem', 'acp')]
    const room = (members: string[]): ChatMeta => ({
      id: 'r',
      agentName: '',
      sessionId: null,
      cwd: '/w',
      title: '',
      createdAt: 1,
      updatedAt: 1,
      inFlight: false,
      group: { members, sessions: {}, seen: {}, role: '', active: [], queue: [] }
    })
    expect(roomMissingFeaturesTitle(chatCaps(room(['ui']), agents))).toBeUndefined()
    expect(roomMissingFeaturesTitle(chatCaps(room(['ui', 'gem']), agents))).toBe(
      "This room can't use: Edit and Resend, Fork, Pause, Spend caps."
    )
  })
})

describe('remoteChip', () => {
  it('is "Remote · host" with the fixed notice for a remote agent, and nothing for any other', () => {
    expect(remoteChip({ provider: 'ag-ui', remoteHost: 'agents.example.com:8443' })).toEqual({
      label: 'Remote · agents.example.com:8443',
      title: AGUI_TEXT.remoteNotice('agents.example.com:8443')
    })
    expect(remoteChip({ provider: 'acp', remoteHost: 'agents.example.com' })).toBeNull()
    expect(remoteChip({ provider: 'codex' })).toBeNull()
    expect(remoteChip({})).toBeNull()
    expect(remoteChip(undefined)).toBeNull()
  })
  it('has no chip for a remote agent whose endpoint has no host yet', () => {
    expect(remoteChip({ provider: 'ag-ui' })).toBeNull()
  })
  it('reads the remote cap, not the engine name', () => {
    const noRemote = (e: Engine): EngineCaps => ({ ...engineCaps(e), remote: false })
    expect(remoteChip({ provider: 'ag-ui', remoteHost: 'h.example.com' }, noRemote)).toBeNull()
    expect(remoteChip({ provider: 'acp', remoteHost: 'h.example.com' }, (e) => ({ ...engineCaps(e), remote: e === 'acp' }))).toMatchObject({
      label: 'Remote · h.example.com'
    })
  })
})

describe('offersTodo', () => {
  it('is on only while every agent of the chat has the bridges cap (a room needs all its members to)', () => {
    expect(offersTodo([{}])).toBe(true)
    expect(offersTodo([{ provider: 'codex' }])).toBe(true)
    expect(offersTodo([{ provider: 'acp' }])).toBe(false)
    expect(offersTodo([{ provider: 'ag-ui' }])).toBe(false)
    expect(offersTodo([{}, { provider: 'acp' }])).toBe(false)
    expect(offersTodo([{}, { provider: 'codex' }])).toBe(true)
  })
  it('reads the bridges cap, not the engine name', () => {
    expect(offersTodo([{}], (e) => ({ ...engineCaps(e), bridges: false }))).toBe(false)
  })
})
