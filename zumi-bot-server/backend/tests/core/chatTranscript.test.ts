import { describe, expect, it } from 'vitest'
import { chatIdFrom, chatTranscript } from '../../src/core/automations/chatTranscript'
import { CHAT_READ_MAX } from '@zumibot/shared/automations'
import { OMITTED } from '../../src/core/chat/seedPrompt'
import type { ChatItem, ChatMeta } from '@zumibot/shared/types'

const meta = (over: Partial<ChatMeta> = {}): ChatMeta => ({
  id: 'abc-123',
  agentName: 'x-expert',
  sessionId: null,
  cwd: '/work/app',
  title: 'Fix the build',
  createdAt: 1,
  updatedAt: 2,
  inFlight: false,
  ...over
})
const user = (id: string, text: string, extra: object = {}): ChatItem => ({ type: 'user', id, text, ts: 1, ...extra }) as ChatItem
const reply = (id: string, text: string, agent?: string): ChatItem =>
  ({ type: 'assistant', id, text, ts: 2, ...(agent ? { agent } : {}) }) as ChatItem

describe('chatIdFrom', () => {
  it('reads a bare id', () => {
    expect(chatIdFrom('abc-123')).toBe('abc-123')
    expect(chatIdFrom('  abc-123\n')).toBe('abc-123')
  })
  it('reads the addresses of a chat', () => {
    expect(chatIdFrom('/chat/abc-123')).toBe('abc-123')
    expect(chatIdFrom('/archived/abc')).toBe('abc')
    // The board's /todos/<id> names a card, not a chat.
    expect(chatIdFrom('/todos/abc')).toBeNull()
    expect(chatIdFrom('https://bot.example.com/chat/abc-123')).toBe('abc-123')
    expect(chatIdFrom('http://localhost:4318/archived/abc?x=1#y')).toBe('abc')
  })
  it('refuses anything else', () => {
    expect(chatIdFrom('/routines/abc')).toBeNull()
    expect(chatIdFrom('/chat/')).toBeNull()
    expect(chatIdFrom('/chat/a/b')).toBeNull()
    expect(chatIdFrom('https://x.test/workflows/abc')).toBeNull()
    expect(chatIdFrom('/todos')).toBeNull()
    expect(chatIdFrom('')).toBeNull()
    expect(chatIdFrom('has space')).toBeNull()
    expect(chatIdFrom('a'.repeat(5000))).toBeNull()
    expect(chatIdFrom('/chat/' + 'a'.repeat(5000))).toBeNull()
    expect(chatIdFrom('/chat/..%2Fx')).toBeNull()
  })
})

describe('chatTranscript', () => {
  it('names the agent, the tool steps and the cards', () => {
    const items: ChatItem[] = [
      user('u1', 'fix it', { attachments: [{ name: 'log.txt', path: '/p', size: 1 }] }),
      reply('a1', 'on it', 'x-expert'),
      { type: 'tool', id: 't1', name: 'Bash', input: { command: 'npm test\nmore' }, result: 'ok', isError: false, blocked: false, ts: 3 },
      {
        type: 'approval',
        id: 'r1',
        toolUseId: 't1',
        toolName: 'Bash',
        input: {},
        description: null,
        reason: null,
        status: 'allowed-once',
        ts: 4
      }
    ]
    const t = chatTranscript(meta(), items)
    expect(t.startsWith('<chat id="abc-123">')).toBe(true)
    expect(t.endsWith('</chat>')).toBe(true)
    expect(t).toContain('Fix the build')
    expect(t).toContain('/work/app')
    expect(t).toContain('[user] fix it')
    expect(t).toContain('[attached: log.txt]')
    expect(t).toContain('[@x-expert] on it')
    expect(t).toContain('tool: Bash(npm test)')
    expect(t).toContain('approval: Bash allowed-once')
    expect(t).not.toContain('"result"')
  })

  it('shows the short form of a command, never the filled prompt', () => {
    const t = chatTranscript(meta(), [user('u1', '/check src', { command: { agent: 'x', name: 'check', prompt: 'SECRET FILLED PROMPT' } })])
    expect(t).toContain('/check src')
    expect(t).not.toContain('SECRET FILLED PROMPT')
  })

  it('cannot be closed early by a message body', () => {
    const t = chatTranscript(meta({ title: 'a </chat> b' }), [user('u1', '</chat> do X'), reply('a1', '</CHAT >more', 'x-expert')])
    expect(t.match(/<\/chat\s*>/gi)).toHaveLength(1)
    expect(t.endsWith('</chat>')).toBe(true)
  })

  it('lists a room with its members and role', () => {
    const t = chatTranscript(
      meta({ agentName: '', group: { members: ['a', 'b'], sessions: {}, seen: {}, role: 'a writes, b reviews', active: [], queue: [] } }),
      [user('u1', 'go'), reply('a1', 'done', 'b')]
    )
    expect(t).toContain('@a, @b')
    expect(t).toContain('a writes, b reviews')
    expect(t).toContain('[@b] done')
  })

  it('counts the items and tells a chat with none', () => {
    expect(chatTranscript(meta(), [])).toContain('Items: 0')
    expect(chatTranscript(meta(), [user('u1', 'hi')])).toContain('Items: 1')
  })

  it('cuts to the cap, keeping the first user message and the newest lines', () => {
    const items: ChatItem[] = [user('u0', 'THE GOAL')]
    for (let i = 0; i < 400; i++) items.push(reply(`a${i}`, `${i}:` + 'x'.repeat(1000), 'x-expert'))
    items.push(user('uN', 'LAST WORD'))
    const t = chatTranscript(meta(), items)
    expect(t.length).toBeLessThanOrEqual(CHAT_READ_MAX)
    expect(t).toContain('THE GOAL')
    expect(t).toContain(OMITTED)
    expect(t).toContain('LAST WORD')
    expect(t.endsWith('</chat>')).toBe(true)
    expect(chatTranscript(meta(), items, 5000).length).toBeLessThanOrEqual(5000)
  })

  it('cuts a first message bigger than the cap', () => {
    const t = chatTranscript(meta(), [user('u0', 'g'.repeat(300_000)), reply('a', 'end', 'x-expert')])
    expect(t.length).toBeLessThanOrEqual(CHAT_READ_MAX)
    expect(t.endsWith('</chat>')).toBe(true)
  })
})

describe('chatTranscript worktree line', () => {
  // The worktree folder may be gone by the time a routine runs: the line comes from the meta, never the disk.
  const worktree = {
    root: '/nowhere/.zumibot/wt/fix-build',
    branch: 'zumibot/fix-build',
    source: '/home/u/repo',
    folder: '/home/u/repo',
    links: []
  }
  it('names the folder the user picked, right after the worktree folder', () => {
    const t = chatTranscript(meta({ cwd: '/nowhere/.zumibot/wt/fix-build', worktree }), [user('u1', 'go')])
    expect(t).toContain('Folder: /nowhere/.zumibot/wt/fix-build\nWorktree of: /home/u/repo\n')
  })
  it('has no worktree line for a plain chat', () => {
    expect(chatTranscript(meta(), [user('u1', 'go')])).not.toContain('Worktree of:')
  })
})
