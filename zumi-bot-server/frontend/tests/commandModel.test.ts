import { describe, expect, it } from 'vitest'
import { engineCaps } from '@zumibot/shared/engine'
import type { AgentSummary, ChatMeta } from '@zumibot/shared/types'
import { chatModelSource, commandModelOptions, modelPicker, newChatModelSource } from '../src/state/commandModel'

describe('commandModelOptions', () => {
  it("offers the agent's model and the three it can name", () => {
    expect(commandModelOptions(undefined)).toEqual([
      ['', "Agent's model"],
      ['opus', 'Opus'],
      ['sonnet', 'Sonnet'],
      ['haiku', 'Haiku']
    ])
  })
  it('keeps a value typed into the file as its own option, so the select shows it', () => {
    expect(commandModelOptions('gpt-5').at(-1)).toEqual(['gpt-5', 'gpt-5 (not valid)'])
  })
})

describe('modelPicker', () => {
  const agent = (model?: string, extra: Partial<AgentSummary> = {}): AgentSummary => ({
    filePath: '/a/wk.md',
    name: 'wk',
    description: '',
    color: null,
    icon: null,
    error: null,
    builtIn: false,
    commands: [
      { name: 'card', description: 'Card', model: 'sonnet' },
      { name: 'fix', description: 'Fix' },
      { name: 'quick', description: 'Quick', model: 'haiku' }
    ],
    ...(model ? { model } : {}),
    ...extra
  })
  const chat = (o: Partial<ChatMeta> = {}): ChatMeta => ({
    id: 'c',
    agentName: 'wk',
    sessionId: 's',
    cwd: '/w',
    title: 't',
    createdAt: 1,
    updatedAt: 1,
    inFlight: false,
    ...o
  })
  const view = (c: ChatMeta, a: AgentSummary, text = '') => modelPicker(chatModelSource(c), a, text)

  it("reads Default with the agent's Agent Studio model, and plain Default for one that inherits", () => {
    expect(view(chat(), agent('opus'))).toMatchObject({ label: 'Default (Opus)', current: null })
    expect(view(chat(), agent())?.label).toBe('Default')
    expect(view(chat(), agent('inherit'))?.label).toBe('Default')
    expect(view(chat(), agent('claude-opus-5-5'))?.label).toBe('Default (claude-opus-5-5)')
  })

  it('offers Default and the three models, Default first', () => {
    expect(view(chat(), agent('opus'))?.options).toEqual([
      { model: null, label: 'Default (Opus)' },
      { model: 'opus', label: 'Opus' },
      { model: 'sonnet', label: 'Sonnet' },
      { model: 'haiku', label: 'Haiku' }
    ])
  })

  it('shows the model a command set, and the one picked by hand, each checked in the menu', () => {
    expect(view(chat({ model: 'sonnet' }), agent('opus'))).toMatchObject({ label: 'Sonnet', current: 'sonnet' })
    expect(view(chat({ model: 'haiku', modelByHand: true }), agent('opus'))).toMatchObject({ label: 'Haiku', current: 'haiku' })
  })

  it("previews a command's model while it is typed, in a chat whose next turn starts a session", () => {
    const fresh = chat({ sessionId: null })
    expect(view(fresh, agent('opus'), '/card login bug')).toMatchObject({ label: 'Sonnet · /card', current: null })
    expect(view(fresh, agent('opus'), '/todo /card login bug')?.label).toBe('Sonnet · /card')
    // A reseed starts a session too.
    expect(view(chat({ next: { seed: true } }), agent('opus'), '/quick')?.label).toBe('Haiku · /quick')
    // A command with no model, an unknown one, or a command further in leaves it.
    expect(view(fresh, agent('opus'), '/fix it')?.label).toBe('Default (Opus)')
    expect(view(fresh, agent('opus'), '/nope')?.label).toBe('Default (Opus)')
    expect(view(fresh, agent('opus'), 'run /card')?.label).toBe('Default (Opus)')
  })

  it('in a running conversation previews only a stronger model, and says why a cheaper one is skipped', () => {
    expect(view(chat({ model: 'haiku' }), agent('opus'), '/card x')?.label).toBe('Sonnet · /card')
    const cheaper = view(chat(), agent('opus'), '/quick x')
    expect(cheaper?.label).toBe('Default (Opus)')
    expect(cheaper?.title).toContain('/quick')
    expect(cheaper?.title).toContain('only moves to a stronger model')
    // A command naming the model the chat already runs on skips nothing.
    const same = modelPicker(
      chatModelSource(chat()),
      agent('opus', { commands: [{ name: 'deep', description: 'Deep', model: 'opus' }] }),
      '/deep x'
    )
    expect(same?.title).not.toContain('skipped')
  })

  it('a model picked by hand is never moved by a command, and the title says so', () => {
    const v = view(chat({ model: 'haiku', modelByHand: true, sessionId: null }), agent('opus'), '/card x')
    expect(v?.label).toBe('Haiku')
    expect(v?.title).toContain('you picked')
  })

  it('the new-chat screen starts a session, so any command previews, unless a model was picked there', () => {
    expect(modelPicker(newChatModelSource(undefined), agent('opus'), '/quick x')?.label).toBe('Haiku · /quick')
    expect(modelPicker(newChatModelSource('sonnet'), agent('opus'), '/quick x')).toMatchObject({ label: 'Sonnet', current: 'sonnet' })
  })

  it('says a pick reloads a running conversation, and not one about to start', () => {
    expect(view(chat(), agent('opus'))?.reloads).toBe(true)
    expect(view(chat({ sessionId: null }), agent('opus'))?.reloads).toBe(false)
  })

  it('shows nothing for no agent', () => {
    expect(modelPicker(chatModelSource(chat()), undefined, '')).toBeNull()
  })

  it('ignores a Codex pick left from when the agent ran on Codex: it reads Default and previews commands', () => {
    const c = chat({ model: 'gpt-6.1-sol', modelByHand: true, sessionId: null })
    expect(view(c, agent('opus'))).toMatchObject({ label: 'Default (Opus)', current: null })
    expect(view(c, agent('opus'), '/card x')?.label).toBe('Sonnet · /card')
  })
})

describe('modelPicker for a Codex agent', () => {
  const codex = (model?: string): AgentSummary => ({
    filePath: '/a/wa.md',
    name: 'wa',
    description: '',
    color: null,
    icon: null,
    error: null,
    builtIn: false,
    provider: 'codex',
    commands: [{ name: 'card', description: 'Card', model: 'sonnet' }],
    ...(model !== undefined ? { model } : {})
  })
  const chat = (o: Partial<ChatMeta> = {}): ChatMeta => ({
    id: 'c',
    agentName: 'wa',
    sessionId: 't',
    cwd: '/w',
    title: 't',
    createdAt: 1,
    updatedAt: 1,
    inFlight: false,
    ...o
  })
  const MODELS = ['gpt-6.1-sol', 'gpt-6-mini']
  const view = (c: ChatMeta, a: AgentSummary, text = '', models: string[] | undefined = MODELS) =>
    modelPicker(chatModelSource(c), a, text, models)

  it("reads Default with the agent file's model as Codex names it, and offers Codex's own models", () => {
    expect(view(chat(), codex('gpt-6.1-sol'))).toMatchObject({
      label: 'Default (gpt-6.1-sol)',
      current: null,
      options: [
        { model: null, label: 'Default (gpt-6.1-sol)' },
        { model: 'gpt-6.1-sol', label: 'gpt-6.1-sol' },
        { model: 'gpt-6-mini', label: 'gpt-6-mini' }
      ]
    })
    expect(view(chat(), codex())?.label).toBe('Default')
    expect(view(chat(), codex('inherit'))?.label).toBe('Default')
  })

  it('shows a model picked by hand, checked, and keeps it in the menu before the list loads', () => {
    expect(view(chat({ model: 'gpt-6-mini', modelByHand: true }), codex('gpt-6.1-sol'))).toMatchObject({
      label: 'gpt-6-mini',
      current: 'gpt-6-mini'
    })
    const unlisted = modelPicker(chatModelSource(chat({ model: 'gpt-6-mini', modelByHand: true })), codex('gpt-6.1-sol'), '', undefined)
    expect(unlisted?.options.map((o) => o.model)).toEqual([null, 'gpt-6-mini'])
  })

  it('previews no command: Codex runs no command models', () => {
    expect(view(chat({ sessionId: null }), codex('gpt-6.1-sol'), '/card x')?.label).toBe('Default (gpt-6.1-sol)')
  })

  it('ignores a Claude model an earlier command or pick left', () => {
    expect(view(chat({ model: 'sonnet' }), codex('gpt-6.1-sol'))).toMatchObject({ label: 'Default (gpt-6.1-sol)', current: null })
    expect(view(chat({ model: 'haiku', modelByHand: true }), codex('gpt-6.1-sol'))?.label).toBe('Default (gpt-6.1-sol)')
  })

  it('says a pick reloads a running thread', () => {
    expect(view(chat(), codex('gpt-6.1-sol'))?.reloads).toBe(true)
    expect(view(chat({ sessionId: null }), codex('gpt-6.1-sol'))?.reloads).toBe(false)
  })
})

describe('modelPicker for an ACP agent', () => {
  it("shows none: an ACP agent's model is its own config option", () => {
    const gem: AgentSummary = {
      filePath: '/a/gem.md',
      name: 'gem',
      description: '',
      color: null,
      icon: null,
      error: null,
      builtIn: false,
      provider: 'acp'
    }
    expect(modelPicker(newChatModelSource(undefined), gem, 'hello')).toBeNull()
  })
  it("shows none for a remote agent: its model is its server's", () => {
    const rem: AgentSummary = {
      filePath: '/a/rem.md',
      name: 'rem',
      description: '',
      color: null,
      icon: null,
      error: null,
      builtIn: false,
      provider: 'ag-ui'
    }
    expect(modelPicker(newChatModelSource(undefined), rem, 'hello')).toBeNull()
    // Even with a models cap forced on, no picker is built for it.
    expect(modelPicker(newChatModelSource(undefined), rem, 'hello', undefined, (e) => ({ ...engineCaps(e), models: true }))).toBeNull()
  })
  it('reads the models cap, not the engine: an engine with the cap off shows none', () => {
    const wk: AgentSummary = { filePath: '/a/wk.md', name: 'wk', description: '', color: null, icon: null, error: null, builtIn: false }
    expect(modelPicker(newChatModelSource(undefined), wk, 'hello')).not.toBeNull()
    expect(modelPicker(newChatModelSource(undefined), wk, 'hello', undefined, (e) => ({ ...engineCaps(e), models: false }))).toBeNull()
  })
})
