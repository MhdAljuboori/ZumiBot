import { describe, expect, it } from 'vitest'
import {
  SETTINGS_SECTIONS,
  archivedFromPath,
  archivedPath,
  chatIdFromPath,
  historyStep,
  inboxFromPath,
  inboxPath,
  pathFor,
  routinesFromPath,
  routinesPath,
  settingsFromPath,
  settingsPath,
  todosFromPath,
  todosPath
} from '../src/state/route'

describe('route', () => {
  it('reads the chat id from /chat/<id>', () => {
    expect(chatIdFromPath('/chat/abc-123')).toBe('abc-123')
    expect(chatIdFromPath('/chat/a%20b')).toBe('a b')
  })

  it('routes nothing else', () => {
    for (const p of ['/', '', '/chat', '/chat/', '/chat/a/b', '/chats/a', '/login', '/chat/%E0%A4%A']) expect(chatIdFromPath(p)).toBeNull()
  })

  it('round-trips ids through pathFor', () => {
    expect(pathFor(null)).toBe('/')
    expect(pathFor('abc-123')).toBe('/chat/abc-123')
    for (const id of ['abc', 'a b', 'a/b', '%', 'é']) expect(chatIdFromPath(pathFor(id))).toBe(id)
  })

  it("pushes the app's own moves and replaces addresses the view did not follow", () => {
    expect(historyStep('/chat/a', '/chat/a', '/chat/a')).toBeNull()
    expect(historyStep('/chat/a', '/chat/b', '/chat/a')).toBe('push')
    expect(historyStep('/chat/a', '/', '/chat/a')).toBe('push')
    // The first sync after load: a routed chat that no longer exists.
    expect(historyStep('/chat/gone', '/', null)).toBe('replace')
    // Back landed on a chat the view did not open (deleted, or the unsaved-changes dialog was cancelled).
    expect(historyStep('/chat/gone', '/', '/')).toBe('replace')
  })

  it('reads the Settings section from /settings/<section>, with /settings meaning General', () => {
    expect(settingsFromPath('/settings')).toBe('general')
    expect(settingsFromPath('/settings/')).toBe('general')
    expect(settingsFromPath('/settings/voice')).toBe('voice')
    expect(settingsFromPath('/settings/usage')).toBe('usage')
  })

  it('opens General for an unknown section and routes nothing outside /settings', () => {
    expect(settingsFromPath('/settings/nope')).toBe('general')
    expect(settingsFromPath('/settings/voice/x')).toBe('general')
    for (const p of ['/', '/chat/a', '/settingsx', '/login']) expect(settingsFromPath(p)).toBeNull()
    expect(chatIdFromPath(settingsPath('voice'))).toBeNull()
  })

  it('round-trips sections through settingsPath', () => {
    expect(settingsPath('jev')).toBe('/settings/jev')
    for (const s of [
      'general',
      'notifications',
      'vault',
      'claude-code',
      'connectors',
      'audit',
      'voice',
      'jev',
      'usage',
      'sync',
      'account',
      'about'
    ] as const)
      expect(settingsFromPath(settingsPath(s))).toBe(s)
  })

  it('/settings/vault parses and round-trips', () => {
    expect(settingsFromPath('/settings/vault')).toBe('vault')
    expect(settingsPath('vault')).toBe('/settings/vault')
    expect(settingsFromPath(settingsPath('vault'))).toBe('vault')
    expect(SETTINGS_SECTIONS.indexOf('vault')).toBe(SETTINGS_SECTIONS.indexOf('notifications') + 1)
  })

  it('/settings/connectors parses, round-trips and sits right after Claude Code', () => {
    expect(settingsFromPath('/settings/connectors')).toBe('connectors')
    expect(settingsPath('connectors')).toBe('/settings/connectors')
    expect(settingsFromPath(settingsPath('connectors'))).toBe('connectors')
    expect(SETTINGS_SECTIONS.indexOf('connectors')).toBe(SETTINGS_SECTIONS.indexOf('claude-code') + 1)
    expect(settingsFromPath('/settings/connectors/x')).toBe('general')
  })

  it('/settings/claude-code parses, round-trips and sits right after Vault', () => {
    expect(settingsFromPath('/settings/claude-code')).toBe('claude-code')
    expect(settingsPath('claude-code')).toBe('/settings/claude-code')
    expect(settingsFromPath(settingsPath('claude-code'))).toBe('claude-code')
    expect(SETTINGS_SECTIONS.indexOf('claude-code')).toBe(SETTINGS_SECTIONS.indexOf('vault') + 1)
    expect(settingsFromPath('/settings/claude-code/x')).toBe('general')
  })

  it('reads the Archived page and the archived chat open in it', () => {
    expect(archivedFromPath('/archived')).toEqual({ chatId: null })
    expect(archivedFromPath('/archived/abc-1')).toEqual({ chatId: 'abc-1' })
    expect(archivedFromPath('/archived/a%20b')).toEqual({ chatId: 'a b' })
    for (const p of ['/', '/archive', '/archived/', '/archived/a/b', '/archivedx', '/chat/a', '/archived/%E0%A4%A'])
      expect(archivedFromPath(p)).toBeNull()
  })

  it('round-trips archived paths', () => {
    expect(archivedPath(null)).toBe('/archived')
    expect(archivedPath('a b')).toBe('/archived/a%20b')
    expect(archivedFromPath(archivedPath('x/y'))).toEqual({ chatId: 'x/y' })
    // An archived chat address is not a chat address, so a /chat/ reader never picks it up.
    expect(chatIdFromPath(archivedPath('x'))).toBeNull()
    expect(settingsFromPath(archivedPath('x'))).toBeNull()
  })

  it('reads /todos and /todos/<id>', () => {
    expect(todosFromPath('/todos')).toEqual({ taskId: null })
    expect(todosFromPath('/todos/a%20b')).toEqual({ taskId: 'a b' })
    expect(todosFromPath('/todos/mine')).toEqual({ taskId: null }) // My to-dos before the board: the board itself
    for (const p of ['/todos/', '/todos/a/b', '/todo', '/todos/%E0%A4%A', '/']) expect(todosFromPath(p)).toBeNull()
    expect(todosPath(null)).toBe('/todos')
    expect(todosPath('a b')).toBe('/todos/a%20b')
  })

  it('reads /routines, /routines/new and /routines/<id>', () => {
    expect(routinesFromPath('/routines')).toEqual({ routine: null })
    expect(routinesFromPath('/routines/new')).toEqual({ routine: { id: null } })
    expect(routinesFromPath('/routines/abc-1')).toEqual({ routine: { id: 'abc-1' } })
    expect(routinesFromPath('/routines/a%20b')).toEqual({ routine: { id: 'a b' } })
    for (const p of ['/', '/routine', '/routines/', '/routines/a/b', '/routinesx', '/chat/a', '/routines/%E0%A4%A'])
      expect(routinesFromPath(p)).toBeNull()
  })

  it('round-trips routines paths', () => {
    expect(routinesPath(null)).toBe('/routines')
    expect(routinesPath({ id: null })).toBe('/routines/new')
    expect(routinesPath({ id: 'a b' })).toBe('/routines/a%20b')
    for (const id of ['abc', 'a b', 'a/b', '%', 'é']) expect(routinesFromPath(routinesPath({ id }))).toEqual({ routine: { id } })
    // A routine address is no other view's address.
    expect(chatIdFromPath(routinesPath({ id: 'x' }))).toBeNull()
    expect(settingsFromPath(routinesPath(null))).toBeNull()
    expect(todosFromPath(routinesPath(null))).toBeNull()
    expect(archivedFromPath(routinesPath(null))).toBeNull()
  })

  it('inboxFromPath parses /inbox and /inbox/<id>', () => {
    expect(inboxFromPath('/inbox')).toEqual({ messageId: null })
    expect(inboxFromPath('/inbox/a%20b')).toEqual({ messageId: 'a b' })
    for (const p of ['/inbox/', '/inbox/a/b', '/inboxes', '/inbox/%E0%A4%A', '/']) expect(inboxFromPath(p)).toBeNull()
    expect(inboxPath()).toBe('/inbox')
    expect(inboxPath(null)).toBe('/inbox')
  })

  it('inboxPath round-trips an id with a slash', () => {
    expect(inboxPath('a/b')).toBe('/inbox/a%2Fb')
    expect(inboxFromPath(inboxPath('a/b'))).toEqual({ messageId: 'a/b' })
  })
})
