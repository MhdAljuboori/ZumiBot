import { describe, expect, it } from 'vitest'
import { buildExport, closeFences, formatTime, mdCode, mdText, replyRange, toMarkdown, validZone } from '../../src/core/export/chatExport'
import type { ChatItem, ChatMeta } from '@zumibot/shared/types'

const T = Date.UTC(2026, 10, 12, 13, 5) // 2026-11-12 13:05 UTC
const meta = (over: Partial<ChatMeta> = {}): ChatMeta => ({
  id: 'abc-123',
  agentName: 'x-expert',
  sessionId: null,
  cwd: '/home/me/secret-project',
  title: 'Fix the build',
  createdAt: 1,
  updatedAt: 2,
  inFlight: false,
  ...over
})
const user = (id: string, text: string, extra: object = {}): ChatItem => ({ type: 'user', id, text, ts: T, ...extra }) as ChatItem
const reply = (id: string, text: string, agent?: string): ChatItem =>
  ({ type: 'assistant', id, text, ts: T + 60_000, ...(agent ? { agent } : {}) }) as ChatItem
const tool = (id: string, name: string, input: unknown, extra: object = {}): ChatItem =>
  ({ type: 'tool', id, name, input, result: 'ok', isError: false, blocked: false, ts: T, ...extra }) as ChatItem
const opts = (over: object = {}) => ({ steps: false, item: null, now: T, zone: 'UTC', ...over })

describe('formatTime and validZone', () => {
  it('reads a time in the zone', () => {
    expect(formatTime(T, 'UTC')).toBe('2026-11-12 13:05')
    expect(formatTime(T, 'Asia/Dubai')).toBe('2026-11-12 17:05')
  })
  it('keeps only zones Intl knows', () => {
    expect(validZone('Europe/Berlin')).toBe('Europe/Berlin')
    expect(validZone('Mars/Base')).toBeNull()
    expect(validZone(null)).toBeNull()
  })
})

describe('buildExport', () => {
  it('keeps the conversation and leaves steps, notices and cards out by default', () => {
    const items: ChatItem[] = [
      user('u1', 'Why does it fail?'),
      reply('a1', 'Let me look.'),
      tool('t1', 'Bash', { command: 'npm test' }),
      reply('a2', 'Fixed it.'),
      { type: 'notice', id: 'n1', kind: 'stopped', text: 'Stopped.', ts: T },
      { type: 'error', id: 'e1', text: 'boom', ts: T },
      {
        type: 'approval',
        id: 'p1',
        toolUseId: 't1',
        toolName: 'Bash',
        input: {},
        description: null,
        reason: null,
        status: 'allowed-once',
        ts: T
      }
    ]
    const doc = buildExport(meta(), items, opts())!
    expect(doc.subtitle).toBe('Chat with X Expert')
    expect(doc.blocks).toEqual([
      { kind: 'message', role: 'user', who: 'You', ts: T, text: 'Why does it fail?', files: [], more: false },
      // No step between them once steps are off: the two parts read as one reply.
      { kind: 'message', role: 'agent', who: 'X Expert', ts: T + 60_000, text: 'Let me look.\n\nFixed it.', files: [], more: false }
    ])
  })

  it('shows steps and errors when asked, and the reply goes on after them without a new header', () => {
    const items: ChatItem[] = [
      user('u1', 'go'),
      reply('a1', 'Running.'),
      tool('t1', 'Bash', { command: 'npm test\nmore' }),
      tool('t2', 'Read', { file_path: '/x/a.ts' }, { isError: true }),
      { type: 'error', id: 'e1', text: 'Usage   limit\nreached', ts: T },
      reply('a2', 'Done.')
    ]
    const doc = buildExport(meta(), items, opts({ steps: true }))!
    expect(doc.blocks.map((b) => b.kind)).toEqual(['message', 'message', 'steps', 'message'])
    expect(doc.blocks[2]).toEqual({
      kind: 'steps',
      lines: [
        { text: 'Bash(npm test)', error: false },
        { text: 'Read /x/a.ts (failed)', error: true },
        { text: 'Usage limit reached', error: true }
      ]
    })
    expect(doc.blocks[3]).toMatchObject({ kind: 'message', text: 'Done.', more: true })
  })

  it('names room members, an asking agent and attachments', () => {
    const room = meta({ agentName: '', group: { members: ['a-one', 'b-two', 'c'], role: '' } as never })
    expect(buildExport(room, [], opts())!.subtitle).toBe('Room with A One, B Two and C')
    const asked = meta({ asked: { by: 'boss', from: 'x', fromTitle: 'x', chain: [] } })
    const doc = buildExport(
      asked,
      [user('u1', 'check this', { from: 'boss', attachments: [{ id: 'f', name: 'log.txt', mime: 'text/plain', size: 1, kind: 'file' }] })],
      opts()
    )!
    expect(doc.subtitle).toBe('Boss asking X Expert')
    expect(doc.blocks[0]).toMatchObject({ who: 'Boss', files: ['log.txt'] })
  })

  it('keeps answered questions and plans, not the other cards', () => {
    const q = {
      questions: [
        {
          question: 'Which DB?',
          header: 'DB',
          options: [
            { label: 'Postgres', description: 'x' },
            { label: 'SQLite', description: 'y' }
          ],
          multiSelect: false
        },
        {
          question: 'Region?',
          header: 'R',
          options: [
            { label: 'EU', description: '' },
            { label: 'US', description: '' }
          ],
          multiSelect: true
        }
      ]
    }
    const items: ChatItem[] = [
      {
        type: 'approval',
        id: 'q1',
        toolUseId: null,
        toolName: 'AskUserQuestion',
        input: q,
        description: null,
        reason: null,
        status: 'answered',
        answers: { 'Which DB?': 'Postgres', 'Region?': ['EU', 'US'] },
        ts: T
      },
      {
        type: 'approval',
        id: 'q2',
        toolUseId: null,
        toolName: 'AskUserQuestion',
        input: q,
        description: null,
        reason: null,
        status: 'skipped',
        ts: T
      },
      {
        type: 'approval',
        id: 'p1',
        toolUseId: null,
        toolName: 'ExitPlanMode',
        input: { plan: '1. Do it' },
        description: null,
        reason: null,
        status: 'approved',
        ts: T
      }
    ]
    const doc = buildExport(meta(), items, opts())!
    expect(doc.blocks).toEqual([
      {
        kind: 'questions',
        who: 'X Expert',
        ts: T,
        pairs: [
          { question: 'Which DB?', answer: 'Postgres' },
          { question: 'Region?', answer: 'EU, US' }
        ]
      },
      { kind: 'plan', who: 'X Expert', ts: T, status: 'approved', text: '1. Do it' }
    ])
    expect(buildExport(meta(), items, opts({ steps: true }))!.blocks[1]).toEqual({
      kind: 'steps',
      lines: [{ text: 'Question skipped', error: false }]
    })
  })

  it("exports one reply: that agent's run of items between other speakers", () => {
    const items: ChatItem[] = [
      user('u1', 'hi'),
      reply('a1', 'A part one', 'alpha'),
      tool('t1', 'Bash', { command: 'ls' }, { agent: 'alpha' }),
      reply('a2', 'A part two', 'alpha'),
      reply('b1', 'B says', 'beta'),
      user('u2', 'next')
    ]
    expect(replyRange(items, 'a2', '')).toEqual([1, 3])
    expect(replyRange(items, 'b1', '')).toEqual([4, 4])
    expect(replyRange(items, 'u1', '')).toBeNull()
    expect(replyRange(items, 'nope', '')).toBeNull()
    const room = meta({ agentName: '', group: { members: ['alpha', 'beta'], role: '' } as never })
    const doc = buildExport(room, items, opts({ item: 'a1', steps: true }))!
    expect(doc.reply).toBe(true)
    expect(doc.blocks.map((b) => (b.kind === 'message' ? b.text : b.kind))).toEqual(['A part one', 'steps', 'A part two'])
    expect(buildExport(room, items, opts({ item: 'u1' }))).toBeNull()
  })

  it('never shows the chat folder', () => {
    const md = toMarkdown(buildExport(meta(), [user('u1', 'x')], opts())!)
    expect(md).not.toContain('secret-project')
  })
})

describe('Markdown helpers', () => {
  it('closes a code fence a message left open', () => {
    expect(closeFences('a\n```ts\ncode')).toBe('a\n```ts\ncode\n```')
    expect(closeFences('~~~~\nx\n~~~')).toBe('~~~~\nx\n~~~\n~~~~')
    expect(closeFences('```\nx\n```')).toBe('```\nx\n```')
    expect(closeFences('``` a`b\nnot a fence')).toBe('``` a`b\nnot a fence')
  })
  it('keeps titles plain and code whole', () => {
    expect(mdText('# *Big* [link](x) <b>')).toBe('\\# \\*Big\\* \\[link\\](x) \\<b\\>')
    expect(mdCode('a `b` c')).toBe('``a `b` c``')
    expect(mdCode('`x')).toBe('`` `x ``')
  })
})

describe('toMarkdown', () => {
  it('writes a header, one block per message, and the steps as a quoted list', () => {
    const items: ChatItem[] = [
      user('u1', 'Show me'),
      reply('a1', 'Here:\n```js\nx()'),
      tool('t1', 'Bash', { command: 'echo `hi`' }),
      reply('a2', 'Bye')
    ]
    const md = toMarkdown(buildExport(meta({ title: 'Build *fix*' }), items, opts({ steps: true }))!)
    expect(md).toBe(
      [
        '# Build \\*fix\\*',
        '',
        'Chat with X Expert · exported 2026-11-12 13:05 (UTC)',
        '',
        '---',
        '',
        '**You** · 2026-11-12 13:05',
        '',
        'Show me',
        '',
        '---',
        '',
        '**X Expert** · 2026-11-12 13:06',
        '',
        'Here:\n```js\nx()\n```',
        '',
        '> - ``Bash(echo `hi`)``',
        '',
        'Bye',
        ''
      ].join('\n')
    )
  })
})
