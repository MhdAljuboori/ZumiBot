import { describe, expect, it } from 'vitest'
import { AGUI_TEXT } from '@zumibot/shared/agui'
import type { ChatItem, SessionCut } from '@zumibot/shared/types'
import { aguiMessages, foreignHistory, untag } from '../../src/core/agui/aguiMessages'
import { AGUI_TOOL, AguiEventMapper } from '../../src/core/agui/aguiEvents'
import type { RunEvent } from '../../src/core/chat/streamParser'

const ts = 1
const user = (id: string, text: string, extra: object = {}): ChatItem => ({ type: 'user', id, text, ts, ...extra })
const reply = (id: string, text: string, extra: object = {}): ChatItem => ({ type: 'assistant', id, text, ts, ...extra })
const thought = (id: string): ChatItem => ({ type: 'thinking', id, text: 'a private thought', ts })
const tool = (id: string, input: unknown, result: string | null, isError = false, name = AGUI_TOOL): ChatItem => ({
  type: 'tool',
  id,
  name,
  input,
  result,
  isError,
  blocked: false,
  ts
})
// A stamp as a turn of that engine leaves it; 'ag-ui' is written as Task 4 will once the engine exists.
const stamp = (engine?: string): SessionCut => ({ session: 's', at: 'a', ...(engine ? { engine } : {}) }) as SessionCut
const ended = (item: ChatItem, engine?: string): ChatItem => ({ ...item, end: stamp(engine) })

describe('untag', () => {
  it("gives back the server's id: what follows the first colon", () => {
    expect(untag('k1:call_1')).toBe('call_1')
    expect(untag('k1:call:2')).toBe('call:2')
    expect(untag('plain')).toBe('plain')
  })
})

describe('aguiMessages', () => {
  it('builds the input from a mixed list, sending only user, assistant and remote tool items', () => {
    const items: ChatItem[] = [
      user('u1', 'hi', { attachments: [{ id: 'f', name: 'secret.pdf', mime: 'application/pdf', size: 1, kind: 'file' }] }),
      thought('th1'),
      reply('a1', 'Let me search.'),
      tool('k1:c1', { tool: 'search', args: { q: 'x' } }, 'hit'),
      { type: 'notice', id: 'n1', kind: 'stopped', text: 'Stopped.', ts },
      tool('k1:c2', { tool: 'fetch', args: null, argsText: 'raw' }, 'boom', true),
      {
        type: 'approval',
        id: 'ap1',
        toolUseId: null,
        toolName: 'AskUserQuestion',
        input: { questions: [] },
        description: null,
        reason: null,
        status: 'answered',
        ts
      },
      ended(reply('a2', 'Done.'), 'ag-ui'),
      user('u2', 'second'),
      tool('k2:c3', { tool: 'slow', args: {} }, null),
      tool('k2:local', { command: 'cat ~/.ssh/id_rsa' }, 'KEY', false, 'Bash'),
      { type: 'error', id: 'e1', text: 'The connection ended before the agent finished.', ts },
      ended(reply('a3', 'After tools'), 'ag-ui'),
      // As the agent reads it: the reply's quote is in its text already (withReplies).
      user('u3', '> After tools\n\nnext', { replyTo: 'a3' })
    ]
    expect(aguiMessages(items)).toEqual([
      { id: 'u1', role: 'user', content: 'hi' },
      {
        id: 'a1',
        role: 'assistant',
        content: 'Let me search.',
        toolCalls: [
          { id: 'c1', type: 'function', function: { name: 'search', arguments: '{"q":"x"}' } },
          { id: 'c2', type: 'function', function: { name: 'fetch', arguments: 'raw' } }
        ]
      },
      { id: 'result-k1:c1', role: 'tool', toolCallId: 'c1', content: 'hit' },
      { id: 'result-k1:c2', role: 'tool', toolCallId: 'c2', content: 'boom', error: 'boom' },
      { id: 'a2', role: 'assistant', content: 'Done.' },
      { id: 'u2', role: 'user', content: 'second' },
      { id: 'calls-c3', role: 'assistant', toolCalls: [{ id: 'c3', type: 'function', function: { name: 'slow', arguments: '{}' } }] },
      { id: 'result-k2:c3', role: 'tool', toolCallId: 'c3', content: '', error: AGUI_TEXT.toolUnfinished },
      { id: 'a3', role: 'assistant', content: 'After tools' },
      { id: 'u3', role: 'user', content: '> After tools\n\nnext' }
    ])
  })

  it('never sends thinking, notices, errors, approvals, browser or vault items, or attachment names', () => {
    const items: ChatItem[] = [
      user('u1', 'hi', { attachments: [{ id: 'f', name: 'secret.pdf', mime: 'application/pdf', size: 1, kind: 'file' }] }),
      thought('th'),
      { type: 'notice', id: 'n', kind: 'expired', text: 'notice text', ts },
      { type: 'error', id: 'e', text: 'error text', ts },
      {
        type: 'approval',
        id: 'ap',
        toolUseId: null,
        toolName: 'Bash',
        input: { command: 'ls' },
        description: 'desc',
        reason: null,
        status: 'allowed-once',
        ts
      },
      { type: 'browser-action', id: 'b', ts, agent: 'x', handoff: { kind: 'login' } } as unknown as ChatItem,
      { type: 'vault-approval', id: 'v', ts, agent: 'x', request: { item: 'bank' } } as unknown as ChatItem,
      // A local row whose input happens to read like a remote one.
      tool('k:mcp', { tool: 'leak', args: { path: '/etc' } }, 'local output', false, 'mcp__files__read')
    ]
    const sent = JSON.stringify(aguiMessages(items))
    expect(JSON.parse(sent)).toEqual([{ id: 'u1', role: 'user', content: 'hi' }])
    for (const word of ['secret.pdf', 'private thought', 'notice text', 'error text', 'desc', 'login', 'bank', 'leak', 'local output'])
      expect(sent).not.toContain(word)
  })

  it('resends a pending call answered with noTools as a tool message with error, on every later run', () => {
    const items = [
      user('u1', 'go'),
      reply('a1', ''),
      ended(tool('k1:p1', { tool: 'client_tool', args: { a: 1 } }, AGUI_TEXT.noTools, true), 'ag-ui'),
      user('u2', 'again')
    ]
    expect(aguiMessages(items).filter((m) => m.role === 'tool')).toEqual([
      { id: 'result-k1:p1', role: 'tool', toolCallId: 'p1', content: AGUI_TEXT.noTools, error: AGUI_TEXT.noTools }
    ])
  })

  it('gives an error with no text toolUnfinished, since an empty error reads as none', () => {
    const items = [user('u1', 'go'), tool('k1:c1', { tool: 't', args: {} }, '', true)]
    expect(aguiMessages(items)[2]).toEqual({
      id: 'result-k1:c1',
      role: 'tool',
      toolCallId: 'c1',
      content: '',
      error: AGUI_TEXT.toolUnfinished
    })
  })

  it('sends a row whose input does not read as no call at all', () => {
    const items = [user('u1', 'go'), reply('a1', 'x'), tool('k1:c1', { args: {} }, 'r'), tool('k1:c2', 'text', 'r')]
    expect(aguiMessages(items)).toEqual([
      { id: 'u1', role: 'user', content: 'go' },
      { id: 'a1', role: 'assistant', content: 'x' }
    ])
  })

  it("names a call's own message as the run's transcript does", () => {
    const m = new AguiEventMapper({ threadId: 't', runId: 'r' })
    const events = [
      { type: 'RUN_STARTED', threadId: 't', runId: 'r' },
      { type: 'TOOL_CALL_START', toolCallId: 'c9', toolCallName: 'alone' },
      { type: 'TOOL_CALL_END', toolCallId: 'c9' }
    ].flatMap((e) => m.event(JSON.stringify(e)).events)
    const use = events.find((e) => e.kind === 'toolUse') as Extract<RunEvent, { kind: 'toolUse' }>
    // The row as ChatService stores it, under the runner's tag.
    const items = [user('u1', 'go'), tool(`k7:${use.id}`, use.input, null)]
    expect(aguiMessages(items)[1].id).toBe(m.transcript()[0].id)
    expect(m.transcript()[0].id).toBe('calls-c9')
  })

  it('keeps tool runs apart at each reply and each message', () => {
    const items = [
      user('u1', 'a'),
      tool('k:1', { tool: 't', args: 1 }, 'r1'),
      reply('a1', 'mid'),
      tool('k:2', { tool: 't', args: 2 }, 'r2'),
      user('u2', 'b'),
      tool('k:3', { tool: 't', args: 3 }, 'r3')
    ]
    expect(aguiMessages(items).map((m) => m.id)).toEqual(['u1', 'calls-1', 'result-k:1', 'a1', 'result-k:2', 'u2', 'calls-3', 'result-k:3'])
  })
})

describe('foreignHistory', () => {
  it('is false for an empty chat and for AG-UI turns only', () => {
    expect(foreignHistory([])).toBe(false)
    expect(foreignHistory([user('u1', 'hi')])).toBe(false)
    expect(
      foreignHistory([
        user('u1', 'hi'),
        reply('a1', 'x'),
        ended(tool('k:1', { tool: 't', args: {} }, 'r'), 'ag-ui'),
        user('u2', 'more'),
        ended(reply('a2', 'y'), 'ag-ui'),
        user('u3', 'now')
      ])
    ).toBe(false)
  })

  it.each([
    ['Claude', undefined],
    ['Codex', 'codex'],
    ['ACP', 'acp']
  ])('is true for a turn %s stamped', (_name, engine) => {
    expect(foreignHistory([user('u1', 'hi'), ended(reply('a1', 'x'), engine), user('u2', 'now')])).toBe(true)
    expect(
      foreignHistory([
        user('u1', 'hi'),
        ended(reply('a1', 'x'), 'ag-ui'),
        user('u2', 'b'),
        ended(reply('a2', 'y'), engine),
        user('u3', 'now')
      ])
    ).toBe(true)
  })

  it('is true for work with no AG-UI end, whatever the work', () => {
    expect(foreignHistory([user('u1', 'hi'), reply('a1', 'x'), user('u2', 'now')])).toBe(true)
    expect(foreignHistory([user('u1', 'hi'), thought('t1')])).toBe(true)
    expect(foreignHistory([user('u1', 'hi'), tool('t', { command: 'ls' }, 'out', false, 'Bash'), user('u2', 'now')])).toBe(true)
    expect(foreignHistory([reply('a0', 'before any message'), user('u1', 'hi')])).toBe(true)
  })

  it('is false for a stretch with no work and no stamp', () => {
    expect(
      foreignHistory([
        user('u1', 'hi'),
        { type: 'notice', id: 'n', kind: 'stopped', text: 'Stopped.', ts },
        { type: 'error', id: 'e', text: 'x', ts },
        user('u2', 'now')
      ])
    ).toBe(false)
  })

  it("is true for another engine's cut or end in an AG-UI stretch", () => {
    expect(
      foreignHistory([user('u1', 'hi'), reply('a1', 'x', { cut: stamp() }), ended(reply('a2', 'y'), 'ag-ui'), user('u2', 'now')])
    ).toBe(true)
    expect(
      foreignHistory([
        user('u1', 'hi'),
        ended(reply('a1', 'x'), 'ag-ui'),
        ended({ type: 'notice', id: 'n', kind: 'stopped', text: 'Stopped.', ts }, 'codex'),
        user('u2', 'now')
      ])
    ).toBe(true)
  })

  it('reads a stretch whose message carries the AG-UI mark as its own, though a hard crash left no end stamp', () => {
    // What recovery leaves of a turn killed mid-run: its rows as they were saved, then the interrupted notice.
    const crashed = (u: ChatItem): ChatItem[] => [
      u,
      thought('t1'),
      reply('a1', 'partial'),
      tool('k:1', { tool: 't', args: {} }, null),
      { type: 'notice', id: 'n', kind: 'interrupted', text: 'Interrupted.', ts },
      user('u2', 'now')
    ]
    expect(foreignHistory(crashed(user('u1', 'hi', { engine: 'ag-ui' })))).toBe(false)
    // A Claude turn in the same shape is still another engine's.
    expect(foreignHistory(crashed(user('u1', 'hi')))).toBe(true)
    // The mark never covers another engine's end or cut in its stretch.
    expect(foreignHistory([user('u1', 'hi', { engine: 'ag-ui' }), ended(reply('a1', 'x')), user('u2', 'now')])).toBe(true)
    expect(foreignHistory([user('u1', 'hi', { engine: 'ag-ui' }), reply('a1', 'x', { cut: stamp('codex') }), user('u2', 'now')])).toBe(true)
    // It covers only its own stretch: an earlier unmarked one with work and no end stays foreign.
    expect(foreignHistory([user('u0', 'a'), reply('a0', 'x'), ...crashed(user('u1', 'hi', { engine: 'ag-ui' }))])).toBe(true)
  })

  it("reads a stamp on a message as its own turn's, when that turn left no item", () => {
    expect(foreignHistory([ended(user('u1', 'hi')), user('u2', 'now')])).toBe(true)
    expect(foreignHistory([ended(user('u1', 'hi'), 'ag-ui'), user('u2', 'now')])).toBe(false)
  })
})
