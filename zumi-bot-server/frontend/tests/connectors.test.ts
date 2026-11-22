import { describe, expect, it } from 'vitest'
import { CONNECTOR_TEXT, connectorById } from '@zumibot/shared/connectors'
import type { ConnectorCardView, ConnectorId, ConnectorState, ConnectorsView } from '@zumibot/shared/connectors'
import { REFRESH_GAP_MS, cardModel, engineNotes, shouldRefresh, switchRows, withRemember, withSwitch } from '../src/state/connectors'

const card = (id: ConnectorId, state: ConnectorState, extra: Partial<ConnectorCardView> = {}): ConnectorCardView => ({
  id,
  state,
  tools: [],
  unknownTools: [],
  on: [],
  remember: false,
  ...extra
})
const view = (extra: Partial<ConnectorsView> = {}): ConnectorsView => ({
  keyVar: null,
  migration: 'kept',
  error: null,
  agents: [
    { name: 'alpha', engine: 'claude' },
    { name: 'beta', engine: 'codex' },
    { name: 'gamma', engine: 'claude' }
  ],
  connectors: [card('gmail', 'connected', { on: ['gamma'] }), card('slack', 'not-connected', { on: ['alpha'] })],
  at: 0,
  ...extra
})

describe('cardModel', () => {
  it('shows a connected connector as ok with a Manage link and no hint', () => {
    const m = cardModel(card('gmail', 'connected'))
    expect(m).toMatchObject({ id: 'gmail', name: 'Gmail', blurb: connectorById('gmail').blurb, label: 'Connected', tone: 'ok', hint: null })
    expect(m.action).toEqual({ label: 'Manage on claude.ai', href: connectorById('gmail').connectUrl })
  })

  it('shows needs-attention as warn with Reconnect', () => {
    const m = cardModel(card('notion', 'needs-attention'))
    expect(m).toMatchObject({ label: 'Needs attention', tone: 'warn', hint: CONNECTOR_TEXT.needsAttention })
    expect(m.action).toEqual({ label: 'Reconnect', href: connectorById('notion').connectUrl })
  })

  it('shows not-connected as idle with Connect', () => {
    const m = cardModel(card('slack', 'not-connected'))
    expect(m).toMatchObject({ label: 'Not connected', tone: 'idle', hint: CONNECTOR_TEXT.notConnected })
    expect(m.action).toEqual({ label: 'Connect', href: connectorById('slack').connectUrl })
  })

  it('shows off-in-claude-code as idle with its hint and Manage', () => {
    const m = cardModel(card('linear', 'off-in-claude-code'))
    expect(m).toMatchObject({ label: 'Turned off in Claude Code', tone: 'idle', hint: CONNECTOR_TEXT.offInClaudeCode })
    expect(m.action.label).toBe('Manage on claude.ai')
  })

  it('shows unknown as idle with no hint', () => {
    const m = cardModel(card('google-drive', 'unknown'))
    expect(m).toMatchObject({ label: 'Not checked', tone: 'idle', hint: null })
    expect(m.action.label).toBe('Manage on claude.ai')
  })

  it('links every card to its catalog connectUrl, on claude.ai', () => {
    for (const s of ['connected', 'needs-attention', 'not-connected', 'off-in-claude-code', 'unknown'] as const) {
      const m = cardModel(card('google-calendar', s))
      expect(m.action.href).toBe('https://claude.ai/directory/2a838eaa-f7b4-4bc2-bd47-c326f3c813c5')
    }
  })

  it('gives only GitHub a custom URL', () => {
    expect(cardModel(card('github', 'not-connected')).customUrl).toBe('https://api.githubcopilot.com/mcp/')
    for (const id of ['gmail', 'google-calendar', 'google-drive', 'notion', 'slack', 'linear'] as const)
      expect(cardModel(card(id, 'connected')).customUrl).toBeNull()
  })

  it('words who it is on for, both forms', () => {
    expect(cardModel(card('gmail', 'connected')).onText).toBe('Off for every agent')
    expect(cardModel(card('gmail', 'connected', { on: ['alpha', 'gamma'] })).onText).toBe('On for alpha, gamma')
  })

  it('words the tools it does not know only when there are some', () => {
    expect(cardModel(card('gmail', 'connected')).unknownText).toBeNull()
    expect(cardModel(card('gmail', 'connected', { unknownTools: ['x', 'y'] })).unknownText).toBe('Tools ZumiBot does not know yet: x, y.')
  })
})

describe('switchRows', () => {
  it('lists the Claude agents only, in the view order, with their state', () => {
    expect(switchRows(view(), 'gmail')).toEqual([
      { agent: 'alpha', on: false },
      { agent: 'gamma', on: true }
    ])
  })

  it('shows every Claude agent off for a connector the view does not carry', () => {
    expect(switchRows(view(), 'notion')).toEqual([
      { agent: 'alpha', on: false },
      { agent: 'gamma', on: false }
    ])
  })
})

describe('engineNotes', () => {
  it('names each engine that gets no connectors once, in the view order, and leaves ACP and remote agents without switches', () => {
    const mixed = view({
      agents: [
        { name: 'alpha', engine: 'claude' },
        { name: 'rem', engine: 'ag-ui' },
        { name: 'beta', engine: 'codex' },
        { name: 'gem', engine: 'acp' },
        { name: 'gem2', engine: 'acp' }
      ]
    })
    expect(engineNotes(mixed)).toEqual([CONNECTOR_TEXT.agui, CONNECTOR_TEXT.codex, CONNECTOR_TEXT.acp])
    expect(engineNotes(view({ agents: [{ name: 'alpha', engine: 'claude' }] }))).toEqual([])
    expect(engineNotes(null)).toEqual([])
    expect(switchRows(mixed, 'gmail')).toEqual([{ agent: 'alpha', on: false }])
  })
})

describe('withSwitch', () => {
  it('adds an agent to one card and leaves the rest alone', () => {
    const v = view()
    const next = withSwitch(v, 'gmail', 'alpha', true)
    expect(next.connectors[0].on.slice().sort()).toEqual(['alpha', 'gamma'])
    expect(next.connectors[1]).toBe(v.connectors[1])
    expect(next.agents).toBe(v.agents)
    expect(v.connectors[0].on).toEqual(['gamma'])
  })

  it('removes an agent', () => {
    const next = withSwitch(view(), 'gmail', 'gamma', false)
    expect(next.connectors[0].on).toEqual([])
    expect(next.connectors[1].on).toEqual(['alpha'])
  })

  it('does not add an agent twice', () => {
    expect(withSwitch(view(), 'gmail', 'gamma', true).connectors[0].on).toEqual(['gamma'])
  })
})

describe('withRemember', () => {
  it('flips only the named card and returns a new view', () => {
    const v = view()
    const next = withRemember(v, 'gmail', true)
    expect(next).not.toBe(v)
    expect(next.connectors[0].remember).toBe(true)
    expect(next.connectors[0].on).toBe(v.connectors[0].on)
    expect(next.connectors[1]).toBe(v.connectors[1])
    expect(v.connectors[0].remember).toBe(false)
    expect(withRemember(next, 'gmail', false).connectors[0].remember).toBe(false)
  })
})

describe('shouldRefresh', () => {
  it('refreshes when never loaded or the last load is old enough', () => {
    expect(REFRESH_GAP_MS).toBe(5000)
    expect(shouldRefresh(null, 0)).toBe(true)
    expect(shouldRefresh(1000, 5999)).toBe(false)
    expect(shouldRefresh(1000, 6000)).toBe(true)
  })
})
