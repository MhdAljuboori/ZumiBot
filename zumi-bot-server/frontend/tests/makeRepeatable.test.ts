import { describe, expect, it } from 'vitest'
import { leadingCommand } from '@zumibot/shared/commands'
import { CLAUDE_CODE_SETTINGS } from '@zumibot/shared/appPaths'
import { ZUMI_BOT_NAME } from '@zumibot/shared/zumiBot'
import type { AgentSummary, ChatMeta } from '@zumibot/shared/types'
import { settingsPath } from '../src/state/route'
import {
  MAKE_REPEATABLE,
  canChoose,
  canMakeRepeatable,
  repeatableKinds,
  repeatableRequest,
  repeatableText,
  type RepeatableKind
} from '../src/state/makeRepeatable'

const ALL: RepeatableKind[] = ['command', 'skill', 'routine', 'workflow']
const agent = (name: string, o: Partial<AgentSummary> = {}): AgentSummary => ({
  filePath: `/agents/${name}.md`,
  name,
  description: '',
  color: null,
  icon: null,
  error: null,
  builtIn: false,
  ...o
})
const agents = [
  agent('coder'),
  agent('codexer', { provider: 'codex' }),
  agent('acper', { provider: 'acp' }),
  agent('remote', { provider: 'ag-ui' }),
  agent(ZUMI_BOT_NAME, { builtIn: true })
]
const chat = (o: Partial<ChatMeta> = {}): ChatMeta => ({
  id: 'abc',
  agentName: 'coder',
  sessionId: null,
  cwd: '/work',
  title: 'Fix',
  createdAt: 1,
  updatedAt: 2,
  inFlight: false,
  replyAt: 2,
  ...o
})

describe('repeatableKinds', () => {
  it('offers all four on a finished Claude chat, and lets Zumi Bot choose', () => {
    expect(repeatableKinds(chat(), agents)).toEqual(ALL)
    expect(canChoose(ALL)).toBe(true)
  })
  it('leaves out Skill for Codex and ACP agents, which do not load Claude Code skills', () => {
    expect(repeatableKinds(chat({ agentName: 'codexer' }), agents)).toEqual(['command', 'routine', 'workflow'])
    expect(repeatableKinds(chat({ agentName: 'acper' }), agents)).toEqual(['command', 'routine', 'workflow'])
  })
  it('offers only a slash command for a remote agent, with nothing to choose from', () => {
    expect(repeatableKinds(chat({ agentName: 'remote' }), agents)).toEqual(['command'])
    expect(canChoose(['command'])).toBe(false)
  })
  it('offers only a slash command when the agent is gone', () => {
    expect(repeatableKinds(chat({ agentName: 'deleted' }), agents)).toEqual(['command'])
  })
  it('offers all four in a room', () => {
    const room = chat({ agentName: 'group', group: { members: ['coder', 'remote'], role: '' } as ChatMeta['group'] })
    expect(repeatableKinds(room, agents)).toEqual(ALL)
  })
  it("offers nothing on Zumi Bot's own chat or a chat with no reply yet", () => {
    expect(repeatableKinds(chat({ agentName: ZUMI_BOT_NAME }), agents)).toEqual([])
    expect(repeatableKinds(chat({ replyAt: undefined }), agents)).toEqual([])
  })
})

describe('canMakeRepeatable', () => {
  it('is true for a finished chat with kinds', () => {
    expect(canMakeRepeatable(chat(), agents)).toBe(true)
  })
  it('is false while a reply runs, and where no kind is offered', () => {
    expect(canMakeRepeatable(chat({ inFlight: true }), agents)).toBe(false)
    expect(canMakeRepeatable(chat({ agentName: ZUMI_BOT_NAME }), agents)).toBe(false)
  })
})

describe('repeatableText', () => {
  it('names the kind and the chat by its address', () => {
    expect(repeatableText('skill', { id: 'abc' }, ALL)).toBe('/make-repeatable skill /chat/abc')
  })
  it('lists the kinds to choose from for any', () => {
    expect(repeatableText('any', { id: 'abc' }, ['command', 'routine'])).toBe('/make-repeatable any (command, routine) /chat/abc')
  })
  it('encodes the chat id as every chat address does', () => {
    expect(repeatableText('routine', { id: 'a b' }, ALL)).toBe('/make-repeatable routine /chat/a%20b')
  })
  it('starts with the command, so the server takes the pick and not plain text', () => {
    expect(leadingCommand(repeatableText('workflow', { id: 'abc' }, ALL))).toEqual({ name: MAKE_REPEATABLE, args: 'workflow /chat/abc' })
  })
})

it('the skill link Zumi Bot gets is the settings page the app routes', () => {
  expect(CLAUDE_CODE_SETTINGS).toBe(settingsPath('claude-code'))
})

describe('repeatableRequest', () => {
  // Checked against the chat as it is when the pick lands: a sidebar menu holds the copy from when it opened.
  it('builds the text for an offered kind of a finished chat', () => {
    expect(repeatableRequest('abc', [chat()], agents, 'skill')).toBe('/make-repeatable skill /chat/abc')
    expect(repeatableRequest('abc', [chat({ agentName: 'codexer' })], agents, 'any')).toBe(
      '/make-repeatable any (command, routine, workflow) /chat/abc'
    )
  })
  it('sends nothing once a reply started after the menu opened', () => {
    expect(repeatableRequest('abc', [chat({ inFlight: true })], agents, 'skill')).toBeNull()
  })
  it('sends nothing for a kind the chat does not offer, or a chat that is gone', () => {
    expect(repeatableRequest('abc', [chat({ agentName: 'remote' })], agents, 'routine')).toBeNull()
    expect(repeatableRequest('abc', [chat({ agentName: 'remote' })], agents, 'any')).toBeNull()
    expect(repeatableRequest('gone', [chat()], agents, 'skill')).toBeNull()
  })
})
