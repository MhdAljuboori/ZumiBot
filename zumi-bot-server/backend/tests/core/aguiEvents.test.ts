import { describe, expect, it } from 'vitest'
import { AGUI_TEXT } from '@zumibot/shared/agui'
import { AGUI_TOOL, AguiEventMapper, type AguiMapped } from '../../src/core/agui/aguiEvents'
import { CODEX_TOOL_OUTPUT_MAX } from '../../src/core/codex/codexEvents'
import type { RunEvent } from '../../src/core/chat/streamParser'

const T = 'thread-1'
const R = 'run-1'
const started = { type: 'RUN_STARTED', threadId: T, runId: R }
const finished = (extra: object = {}) => ({ type: 'RUN_FINISHED', threadId: T, runId: R, ...extra })
const text = (id: string, ...deltas: string[]) => [
  { type: 'TEXT_MESSAGE_START', messageId: id, role: 'assistant' },
  ...deltas.map((delta) => ({ type: 'TEXT_MESSAGE_CONTENT', messageId: id, delta })),
  { type: 'TEXT_MESSAGE_END', messageId: id }
]
const call = (id: string, name: string, args: string, parentMessageId?: string) => [
  { type: 'TOOL_CALL_START', toolCallId: id, toolCallName: name, ...(parentMessageId ? { parentMessageId } : {}) },
  { type: 'TOOL_CALL_ARGS', toolCallId: id, delta: args },
  { type: 'TOOL_CALL_END', toolCallId: id }
]

function run(events: unknown[], close = true) {
  const m = new AguiEventMapper({ threadId: T, runId: R })
  const all: AguiMapped[] = events.map((e) => m.event(typeof e === 'string' ? e : JSON.stringify(e)))
  const ev: RunEvent[] = all.flatMap((r) => r.events)
  if (close) ev.push(...m.close())
  return {
    m,
    ev,
    states: all.flatMap((r) => (r.state ? [r.state] : [])),
    terminals: all.flatMap((r) => (r.terminal ? [r.terminal] : [])),
    fatal: all.flatMap((r) => (r.fatal ? [r.fatal] : []))
  }
}
// Only what the run's own content gave, past init and entry.
const body = (events: unknown[]) => run([started, ...events]).ev.slice(2)

describe('AguiEventMapper RUN_STARTED', () => {
  it('gives init with the thread and an entry with the run, which stamps the turn', () => {
    expect(run([started]).ev).toEqual([
      { kind: 'init', sessionId: T },
      { kind: 'entry', uuid: R }
    ])
  })

  it('takes protocol version 1.x, and no version', () => {
    for (const v of ['1.0', '1', '1.4.2']) expect(run([{ ...started, protocolVersion: v }]).fatal).toEqual([])
    expect(run([started]).fatal).toEqual([])
  })

  it('ends the run on a major other than 1', () => {
    for (const v of ['2.0', '0.9', '10.0', 'v1', '']) {
      const r = run([{ ...started, protocolVersion: v }, ...text('m1', 'hi')])
      expect(r.fatal).toEqual([AGUI_TEXT.protocol])
      expect(r.ev).toEqual([])
    }
  })

  it('ends the run on a start with a field missing or of the wrong type', () => {
    expect(run([{ ...started, protocolVersion: 1 }]).fatal).toEqual([AGUI_TEXT.unreadable])
    expect(run([{ type: 'RUN_STARTED', threadId: T }]).fatal).toEqual([AGUI_TEXT.unreadable])
  })

  it('ends the run on another thread', () => {
    expect(run([{ ...started, threadId: 'other' }]).fatal).toEqual([AGUI_TEXT.unreadable])
  })

  it('ends the run on a second start of our run', () => {
    expect(run([started, started]).fatal).toEqual([AGUI_TEXT.unreadable])
  })
})

describe('AguiEventMapper before RUN_STARTED', () => {
  it('ends the run on anything but RUN_ERROR', () => {
    for (const first of [
      text('m1', 'hi')[0],
      { type: 'STATE_SNAPSHOT', snapshot: {} },
      { type: 'CUSTOM', name: 'x', value: 1 },
      { type: 'SOMETHING_NEW' },
      finished()
    ]) {
      const r = run([first, started, ...text('m1', 'hi')])
      expect(r.fatal).toEqual([AGUI_TEXT.unreadable])
      expect(r.ev).toEqual([])
    }
  })

  it('takes a RUN_ERROR as the run refused', () => {
    const r = run([{ type: 'RUN_ERROR', message: 'bad input', code: 'INVALID' }])
    expect(r.terminals).toEqual([{ kind: 'error', message: 'bad input', code: 'INVALID', usage: [] }])
    expect(r.fatal).toEqual([])
  })

  it('ends the run on a payload that is not a JSON event', () => {
    for (const raw of ['{not json', '', '"text"', '[1]', '{"no":"type"}', '{"type":5}'])
      expect(run([raw]).fatal).toEqual([AGUI_TEXT.unreadable])
  })
})

describe('AguiEventMapper text', () => {
  it('streams assistant text and gives one assistantText at its END', () => {
    expect(body(text('m1', 'Hel', 'lo'))).toEqual([
      { kind: 'textDelta', text: 'Hel' },
      { kind: 'textDelta', text: 'lo' },
      { kind: 'assistantText', text: 'Hello' }
    ])
  })

  it('treats a START with no role as assistant', () => {
    expect(
      body([
        { type: 'TEXT_MESSAGE_START', messageId: 'm1' },
        { type: 'TEXT_MESSAGE_CONTENT', messageId: 'm1', delta: 'x' },
        { type: 'TEXT_MESSAGE_END', messageId: 'm1' }
      ])
    ).toEqual([
      { kind: 'textDelta', text: 'x' },
      { kind: 'assistantText', text: 'x' }
    ])
  })

  it('drops the other roles', () => {
    for (const role of ['user', 'system', 'developer']) {
      expect(
        body([
          { type: 'TEXT_MESSAGE_START', messageId: 'm1', role },
          { type: 'TEXT_MESSAGE_CONTENT', messageId: 'm1', delta: 'secret' },
          { type: 'TEXT_MESSAGE_END', messageId: 'm1' },
          { type: 'TEXT_MESSAGE_CHUNK', messageId: 'm2', role, delta: 'more' }
        ])
      ).toEqual([])
    }
  })

  it('gives no assistantText for a blank message', () => {
    expect(body(text('m1', ' '))).toEqual([{ kind: 'textDelta', text: ' ' }])
  })

  it("gives nothing for an empty message, as Pydantic AI opens one before a tool call, and its transcript keeps the call's parent", () => {
    // Pydantic AI 2.65, recorded: TEXT_MESSAGE_START/END with no content, then the call naming that message as its parent.
    const r = run([
      started,
      ...text('m0'),
      ...call('c1', 'delete_demo_file', '{"path":"demo.txt"}', 'm0'),
      ...text('m1', 'done'),
      finished()
    ])
    expect(r.ev.slice(2)).toEqual([
      { kind: 'toolUse', id: 'c1', name: AGUI_TOOL, input: { tool: 'delete_demo_file', args: { path: 'demo.txt' } } },
      { kind: 'textDelta', text: 'done' },
      { kind: 'assistantText', text: 'done' }
    ])
    expect(r.m.transcript()).toEqual([
      {
        id: 'm0',
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'c1', type: 'function', function: { name: 'delete_demo_file', arguments: '{"path":"demo.txt"}' } }]
      },
      { id: 'm1', role: 'assistant', content: 'done' }
    ])
  })

  it('keeps interleaved messages apart', () => {
    expect(
      body([
        { type: 'TEXT_MESSAGE_START', messageId: 'a' },
        { type: 'TEXT_MESSAGE_START', messageId: 'b' },
        { type: 'TEXT_MESSAGE_CONTENT', messageId: 'a', delta: 'A' },
        { type: 'TEXT_MESSAGE_CONTENT', messageId: 'b', delta: 'B' },
        { type: 'TEXT_MESSAGE_END', messageId: 'b' },
        { type: 'TEXT_MESSAGE_END', messageId: 'a' }
      ]).filter((e) => e.kind === 'assistantText')
    ).toEqual([
      { kind: 'assistantText', text: 'B' },
      { kind: 'assistantText', text: 'A' }
    ])
  })

  it('reads a chunk run as one message, ended by the first event that is not its chunk', () => {
    expect(
      body([
        { type: 'TEXT_MESSAGE_CHUNK', messageId: 'm1', delta: 'He' },
        { type: 'TEXT_MESSAGE_CHUNK', delta: 'll' },
        { type: 'TEXT_MESSAGE_CHUNK', messageId: 'm1', delta: 'o' },
        { type: 'CUSTOM', name: 'x', value: 1 },
        { type: 'TEXT_MESSAGE_CHUNK', messageId: 'm2', delta: 'Bye' },
        { type: 'TEXT_MESSAGE_CHUNK', messageId: 'm3', delta: 'Again' }
      ])
    ).toEqual([
      { kind: 'textDelta', text: 'He' },
      { kind: 'textDelta', text: 'll' },
      { kind: 'textDelta', text: 'o' },
      { kind: 'assistantText', text: 'Hello' },
      { kind: 'textDelta', text: 'Bye' },
      { kind: 'assistantText', text: 'Bye' },
      { kind: 'textDelta', text: 'Again' },
      { kind: 'assistantText', text: 'Again' }
    ])
  })

  it('ends the run on a first chunk with no messageId', () => {
    expect(run([started, { type: 'TEXT_MESSAGE_CHUNK', delta: 'x' }]).fatal).toEqual([AGUI_TEXT.unreadable])
  })
})

describe('AguiEventMapper reasoning', () => {
  it('maps REASONING_MESSAGE_* to thinkingDelta and thinking, the phase markers to nothing', () => {
    expect(
      body([
        { type: 'REASONING_START', messageId: 'r1' },
        { type: 'REASONING_MESSAGE_START', messageId: 'r1', role: 'reasoning' },
        { type: 'REASONING_MESSAGE_CONTENT', messageId: 'r1', delta: 'hmm ' },
        { type: 'REASONING_MESSAGE_CONTENT', messageId: 'r1', delta: 'ok' },
        { type: 'REASONING_MESSAGE_END', messageId: 'r1' },
        { type: 'REASONING_END', messageId: 'r1' }
      ])
    ).toEqual([
      { kind: 'thinkingDelta', text: 'hmm ' },
      { kind: 'thinkingDelta', text: 'ok' },
      { kind: 'thinking', text: 'hmm ok' }
    ])
  })

  it('reads a reasoning chunk run', () => {
    expect(
      body([
        { type: 'REASONING_MESSAGE_CHUNK', messageId: 'r1', delta: 'a' },
        { type: 'REASONING_MESSAGE_CHUNK', delta: 'b' },
        ...text('m1', 'x')
      ])
    ).toEqual([
      { kind: 'thinkingDelta', text: 'a' },
      { kind: 'thinkingDelta', text: 'b' },
      { kind: 'thinking', text: 'ab' },
      { kind: 'textDelta', text: 'x' },
      { kind: 'assistantText', text: 'x' }
    ])
  })

  it('drops encrypted values', () => {
    expect(body([{ type: 'REASONING_ENCRYPTED_VALUE', subtype: 'message', entityId: 'r1', encryptedValue: 'opaque' }])).toEqual([])
  })

  it('translates the legacy THINKING_* events', () => {
    expect(
      body([
        { type: 'THINKING_START', title: 'Plan' },
        { type: 'THINKING_TEXT_MESSAGE_START' },
        { type: 'THINKING_TEXT_MESSAGE_CONTENT', delta: 'one ' },
        { type: 'THINKING_TEXT_MESSAGE_CONTENT', delta: 'two' },
        { type: 'THINKING_TEXT_MESSAGE_END' },
        { type: 'THINKING_END' }
      ])
    ).toEqual([
      { kind: 'thinkingDelta', text: 'one ' },
      { kind: 'thinkingDelta', text: 'two' },
      { kind: 'thinking', text: 'one two' }
    ])
  })
})

describe('AguiEventMapper tool calls', () => {
  it('gives a remote tool row at END, with the arguments parsed', () => {
    expect(
      body([
        { type: 'TOOL_CALL_START', toolCallId: 'c1', toolCallName: 'search' },
        { type: 'TOOL_CALL_ARGS', toolCallId: 'c1', delta: '{"q":' },
        { type: 'TOOL_CALL_ARGS', toolCallId: 'c1', delta: '"x"}' },
        { type: 'TOOL_CALL_END', toolCallId: 'c1' }
      ])
    ).toEqual([{ kind: 'toolUse', id: 'c1', name: AGUI_TOOL, input: { tool: 'search', args: { q: 'x' } } }])
  })

  it('keeps arguments that are not JSON as text', () => {
    expect(body(call('c1', 'run', 'not json'))).toEqual([
      { kind: 'toolUse', id: 'c1', name: AGUI_TOOL, input: { tool: 'run', args: null, argsText: 'not json' } }
    ])
    expect(body(call('c2', 'noop', ''))).toEqual([
      { kind: 'toolUse', id: 'c2', name: AGUI_TOOL, input: { tool: 'noop', args: null, argsText: '' } }
    ])
  })

  it('cuts arguments over 20 000 characters, as ACP rows are', () => {
    const big = JSON.stringify({ blob: 'x'.repeat(25_000) })
    const [use] = body(call('c1', 'upload', big)) as Extract<RunEvent, { kind: 'toolUse' }>[]
    const input = use.input as { tool: string; args: null; argsText: string }
    expect(input.tool).toBe('upload')
    expect(input.args).toBeNull()
    expect(input.argsText).toBe(big.slice(0, 20_000) + '\n[output cut]')
  })

  it('reads a tool call chunk run', () => {
    expect(
      body([
        { type: 'TOOL_CALL_CHUNK', toolCallId: 'c1', toolCallName: 'search', delta: '{"q"' },
        { type: 'TOOL_CALL_CHUNK', delta: ':1}' },
        { type: 'TOOL_CALL_CHUNK', toolCallId: 'c2', toolCallName: 'other', delta: '[]' },
        { type: 'STEP_FINISHED', stepName: 's' }
      ])
    ).toEqual([
      { kind: 'toolUse', id: 'c1', name: AGUI_TOOL, input: { tool: 'search', args: { q: 1 } } },
      { kind: 'toolUse', id: 'c2', name: AGUI_TOOL, input: { tool: 'other', args: [] } }
    ])
  })

  it('ends the run on a first tool chunk that cannot be named', () => {
    expect(run([started, { type: 'TOOL_CALL_CHUNK', toolCallId: 'c1', delta: '{}' }]).fatal).toEqual([AGUI_TEXT.unreadable])
    expect(run([started, { type: 'TOOL_CALL_CHUNK', toolCallName: 'x', delta: '{}' }]).fatal).toEqual([AGUI_TEXT.unreadable])
  })

  it('gives a result, closing a call still open first', () => {
    expect(
      body([
        { type: 'TOOL_CALL_START', toolCallId: 'c1', toolCallName: 'search' },
        { type: 'TOOL_CALL_ARGS', toolCallId: 'c1', delta: '{}' },
        { type: 'TOOL_CALL_RESULT', messageId: 'r1', toolCallId: 'c1', content: 'found it' }
      ])
    ).toEqual([
      { kind: 'toolUse', id: 'c1', name: AGUI_TOOL, input: { tool: 'search', args: {} } },
      { kind: 'toolResult', toolUseId: 'c1', content: 'found it', isError: false }
    ])
  })

  it('gives a result for a call an earlier run made (a resumed approval)', () => {
    expect(body([{ type: 'TOOL_CALL_RESULT', messageId: 'r1', toolCallId: 'c0', content: 'done' }])).toEqual([
      { kind: 'toolResult', toolUseId: 'c0', content: 'done', isError: false }
    ])
  })

  it('joins text parts, names any other part, and caps the result', () => {
    expect(
      body([
        {
          type: 'TOOL_CALL_RESULT',
          messageId: 'r1',
          toolCallId: 'c1',
          content: [
            { type: 'text', text: 'a' },
            { type: 'binary', mimeType: 'image/png', data: 'xx' },
            { type: 'text', text: 'b' }
          ]
        }
      ])
    ).toEqual([{ kind: 'toolResult', toolUseId: 'c1', content: 'a\n[binary]\nb', isError: false }])
    const [res] = body([
      { type: 'TOOL_CALL_RESULT', messageId: 'r1', toolCallId: 'c1', content: 'y'.repeat(CODEX_TOOL_OUTPUT_MAX + 10) }
    ]) as Extract<RunEvent, { kind: 'toolResult' }>[]
    expect(res.content).toBe('y'.repeat(CODEX_TOOL_OUTPUT_MAX) + '\n[output cut]')
  })
})

describe('AguiEventMapper state', () => {
  it('passes a snapshot and a delta on', () => {
    const r = run([
      started,
      { type: 'STATE_SNAPSHOT', snapshot: { a: 1 } },
      { type: 'STATE_DELTA', delta: [{ op: 'add', path: '/b', value: 2 }] }
    ])
    expect(r.states).toEqual([
      { kind: 'snapshot', snapshot: { a: 1 } },
      { kind: 'delta', delta: [{ op: 'add', path: '/b', value: 2 }] }
    ])
    expect(r.fatal).toEqual([])
  })

  it('leaves a bad op to the patch, but ends the run on a delta that is not a list', () => {
    expect(run([started, { type: 'STATE_DELTA', delta: [{ op: 'nope' }] }]).fatal).toEqual([])
    expect(run([started, { type: 'STATE_DELTA', delta: { op: 'add' } }]).fatal).toEqual([AGUI_TEXT.unreadable])
    expect(run([started, { type: 'STATE_SNAPSHOT' }]).fatal).toEqual([AGUI_TEXT.unreadable])
  })
})

describe('AguiEventMapper RUN_FINISHED', () => {
  it('ends with success and the usage, absent counts left out', () => {
    const usage = [
      { model: 'gpt-x', inputTokens: 10, outputTokens: 5, cachedInputTokens: 2 },
      { provider: 'p', totalTokens: 3, reasoningTokens: -1 }
    ]
    expect(run([started, finished({ usage })]).terminals).toEqual([
      {
        kind: 'success',
        pendingToolCallIds: [],
        usage: [
          { model: 'gpt-x', inputTokens: 10, outputTokens: 5, cachedInputTokens: 2 },
          { provider: 'p', totalTokens: 3 }
        ]
      }
    ])
  })

  it('reads the success outcome with pending tool calls', () => {
    expect(run([started, finished({ outcome: { type: 'success', pendingToolCallIds: ['c1', 'c2'] } })]).terminals).toEqual([
      { kind: 'success', pendingToolCallIds: ['c1', 'c2'], usage: [] }
    ])
  })

  it('reads an unrecognised outcome as success', () => {
    for (const outcome of [{ type: 'something-new', x: 1 }, 'success', null]) {
      expect(run([started, finished({ outcome })]).terminals).toEqual([{ kind: 'success', pendingToolCallIds: [], usage: [] }])
    }
  })

  it('reads the interrupt outcome', () => {
    const interrupts = [
      {
        id: 'i1',
        reason: 'tool_approval',
        message: 'Run it?',
        toolCallId: 'c1',
        responseSchema: { type: 'object', properties: { approved: { type: 'boolean' } } },
        expiresAt: '2030-01-01T00:00:00Z',
        metadata: { k: 1 }
      },
      { id: 'i2', reason: 'input', subagentRunId: 'sub-1' }
    ]
    expect(run([started, finished({ outcome: { type: 'interrupt', interrupts } })]).terminals).toEqual([
      { kind: 'interrupt', interrupts, usage: [] }
    ])
  })

  it('reads the cancelled outcome', () => {
    expect(run([started, finished({ outcome: { type: 'cancelled' } })]).terminals).toEqual([{ kind: 'cancelled', usage: [] }])
  })

  it('ends the run on an interrupt outcome with no interrupts, duplicate ids, or a bad interrupt', () => {
    for (const outcome of [
      { type: 'interrupt' },
      { type: 'interrupt', interrupts: [] },
      {
        type: 'interrupt',
        interrupts: [
          { id: 'i1', reason: 'a' },
          { id: 'i1', reason: 'b' }
        ]
      },
      { type: 'interrupt', interrupts: [{ id: 'i1' }] },
      { type: 'interrupt', interrupts: [{ id: '', reason: 'a' }] },
      { type: 'interrupt', interrupts: [{ id: 'i1', reason: 'a', responseSchema: 'yes' }] },
      { type: 'interrupt', interrupts: [{ id: 'i1', reason: 'a', expiresAt: 5 }] },
      { type: 'success', pendingToolCallIds: [1] }
    ]) {
      const r = run([started, finished({ outcome })])
      expect(r.fatal).toEqual([AGUI_TEXT.unreadable])
      expect(r.terminals).toEqual([])
    }
  })

  it('flushes an unfinished message and call at the end', () => {
    expect(
      body([
        { type: 'TEXT_MESSAGE_START', messageId: 'm1' },
        { type: 'TEXT_MESSAGE_CONTENT', messageId: 'm1', delta: 'half' },
        { type: 'TOOL_CALL_START', toolCallId: 'c1', toolCallName: 'x' },
        finished()
      ])
    ).toEqual([
      { kind: 'textDelta', text: 'half' },
      { kind: 'assistantText', text: 'half' },
      { kind: 'toolUse', id: 'c1', name: AGUI_TOOL, input: { tool: 'x', args: null, argsText: '' } }
    ])
  })

  it('ends the run on a finish for another run or thread inside ours', () => {
    expect(run([started, { ...finished(), runId: 'other' }]).fatal).toEqual([AGUI_TEXT.unreadable])
    expect(run([started, { ...finished(), threadId: 'other' }]).fatal).toEqual([AGUI_TEXT.unreadable])
  })
})

describe('AguiEventMapper RUN_ERROR', () => {
  it('ends with an error, its code and usage', () => {
    const r = run([started, ...text('m1', 'partial'), { type: 'RUN_ERROR', message: 'boom', code: 'E1', usage: [{ inputTokens: 1 }] }])
    expect(r.terminals).toEqual([{ kind: 'error', message: 'boom', code: 'E1', usage: [{ inputTokens: 1 }] }])
    expect(run([started, { type: 'RUN_ERROR', message: 'boom' }]).terminals).toEqual([
      { kind: 'error', message: 'boom', code: null, usage: [] }
    ])
  })

  it('ends the run on a RUN_ERROR with no message', () => {
    expect(run([started, { type: 'RUN_ERROR', code: 'E1' }]).fatal).toEqual([AGUI_TEXT.unreadable])
  })
})

describe('AguiEventMapper replays and late events', () => {
  const replay = (runId: string) => [
    { type: 'RUN_STARTED', threadId: T, runId },
    ...text('old', 'old words'),
    ...call('oc', 'old', '{}'),
    { type: 'STATE_SNAPSHOT', snapshot: { old: true } },
    { type: 'RUN_FINISHED', threadId: T, runId }
  ]

  it("drops another run's events until its terminal, then maps ours", () => {
    const r = run([
      ...replay('run-0'),
      { type: 'RUN_STARTED', threadId: T, runId: 'run-00' },
      { type: 'RUN_ERROR', message: 'old failure' },
      started,
      ...text('m1', 'new'),
      finished()
    ])
    expect(r.ev).toEqual([
      { kind: 'init', sessionId: T },
      { kind: 'entry', uuid: R },
      { kind: 'textDelta', text: 'new' },
      { kind: 'assistantText', text: 'new' }
    ])
    expect(r.states).toEqual([])
    expect(r.terminals).toEqual([{ kind: 'success', pendingToolCallIds: [], usage: [] }])
    expect(r.fatal).toEqual([])
  })

  it('takes a late RUN_ERROR after our finish as an error', () => {
    expect(run([started, finished(), { type: 'RUN_ERROR', message: 'late' }]).terminals).toEqual([
      { kind: 'success', pendingToolCallIds: [], usage: [] },
      { kind: 'error', message: 'late', code: null, usage: [] }
    ])
  })

  it('drops a later run after ours, its own RUN_ERROR included, and other events after our finish', () => {
    const r = run([
      started,
      finished(),
      ...text('x', 'stray'),
      ...replay('run-2'),
      { type: 'RUN_STARTED', threadId: T, runId: 'run-3' },
      { type: 'RUN_ERROR', message: 'theirs' }
    ])
    expect(r.terminals).toEqual([{ kind: 'success', pendingToolCallIds: [], usage: [] }])
    expect(r.ev).toEqual([
      { kind: 'init', sessionId: T },
      { kind: 'entry', uuid: R }
    ])
    expect(r.fatal).toEqual([])
  })

  it('ends the run on our run starting again after its finish', () => {
    expect(run([started, finished(), started]).fatal).toEqual([AGUI_TEXT.unreadable])
  })

  it('maps nothing after an error or a fatal event', () => {
    expect(run([started, { type: 'RUN_ERROR', message: 'x' }, ...text('m1', 'after')]).ev).toEqual([
      { kind: 'init', sessionId: T },
      { kind: 'entry', uuid: R }
    ])
    const r = run([started, '{bad', ...text('m1', 'after'), finished()])
    expect(r.fatal).toEqual([AGUI_TEXT.unreadable])
    expect(r.terminals).toEqual([])
  })
})

describe('AguiEventMapper ignored events', () => {
  it('ignores snapshots, activity, steps, subagents, raw, custom and unknown events', () => {
    expect(
      body([
        { type: 'MESSAGES_SNAPSHOT', messages: [{ id: 'u', role: 'user', content: 'hi' }] },
        { type: 'ACTIVITY_SNAPSHOT', messageId: 'a', activityType: 'x', content: {} },
        { type: 'ACTIVITY_DELTA', messageId: 'a', activityType: 'x', patch: [] },
        { type: 'STEP_STARTED', stepName: 's' },
        { type: 'STEP_FINISHED', stepName: 's' },
        { type: 'SUBAGENT_STARTED', subagentRunId: 's1' },
        { type: 'SUBAGENT_FINISHED' },
        { type: 'RAW', event: { anything: true } },
        { type: 'CUSTOM', name: 'n', value: 1 },
        { type: 'BRAND_NEW_EVENT', whatever: 1 }
      ])
    ).toEqual([])
  })

  it("drops a subagent's text, reasoning, tool and state events", () => {
    const sub = { subagentRunId: 'sub-1' }
    const r = run([
      started,
      ...text('s1', 'sub words').map((e) => ({ ...e, ...sub })),
      ...call('sc', 'subtool', '{}').map((e) => ({ ...e, ...sub })),
      { type: 'TOOL_CALL_RESULT', messageId: 'sr', toolCallId: 'sc', content: 'x', ...sub },
      { type: 'REASONING_MESSAGE_CHUNK', messageId: 'sr1', delta: 'sub thought', ...sub },
      { type: 'STATE_SNAPSHOT', snapshot: { sub: true }, ...sub },
      { type: 'RUN_ERROR', message: 'sub failed', ...sub },
      ...text('m1', 'mine'),
      finished()
    ])
    expect(r.ev.slice(2)).toEqual([
      { kind: 'textDelta', text: 'mine' },
      { kind: 'assistantText', text: 'mine' }
    ])
    expect(r.states).toEqual([])
    expect(r.terminals).toEqual([{ kind: 'success', pendingToolCallIds: [], usage: [] }])
  })

  it("does not let a subagent's event end our chunk run", () => {
    expect(
      body([
        { type: 'TEXT_MESSAGE_CHUNK', messageId: 'm1', delta: 'a' },
        { type: 'CUSTOM', name: 'n', value: 1, subagentRunId: 's' },
        { type: 'TEXT_MESSAGE_CHUNK', delta: 'b' }
      ])
    ).toEqual([
      { kind: 'textDelta', text: 'a' },
      { kind: 'textDelta', text: 'b' },
      { kind: 'assistantText', text: 'ab' }
    ])
  })
})

describe('AguiEventMapper malformed known events', () => {
  it.each([
    ['TEXT_MESSAGE_START', { messageId: 1 }],
    ['TEXT_MESSAGE_CONTENT', { messageId: 'm1' }],
    ['TEXT_MESSAGE_END', {}],
    ['TEXT_MESSAGE_CHUNK', { messageId: 'm1', delta: 5 }],
    ['REASONING_MESSAGE_START', { messageId: 'r1' }],
    ['REASONING_MESSAGE_CONTENT', { messageId: 'r1', delta: null }],
    ['THINKING_TEXT_MESSAGE_CONTENT', {}],
    ['TOOL_CALL_START', { toolCallId: 'c1', toolCallName: 7 }],
    ['TOOL_CALL_ARGS', { toolCallId: 'c1' }],
    ['TOOL_CALL_END', { toolCallId: ['c1'] }],
    ['TOOL_CALL_RESULT', { messageId: 'r1', toolCallId: 'c1' }],
    ['TOOL_CALL_RESULT', { messageId: 'r1', toolCallId: 'c1', content: { text: 'x' } }],
    ['TOOL_CALL_RESULT', { messageId: 'r1', toolCallId: 'c1', content: [{ text: 'x' }] }],
    ['TOOL_CALL_RESULT', { messageId: 'r1', toolCallId: 'c1', content: [{ type: 'text', text: 3 }] }],
    ['RUN_FINISHED', { threadId: T, runId: R, usage: { inputTokens: 1 } }],
    ['RUN_FINISHED', { threadId: T, runId: R, usage: [{ inputTokens: '1' }] }],
    ['RUN_FINISHED', { threadId: T }]
  ])('ends the run on %s with %j', (type, fields) => {
    const r = run([started, { type, ...fields }, ...text('m1', 'after')])
    expect(r.fatal).toEqual([AGUI_TEXT.unreadable])
    expect(r.ev.slice(2)).toEqual([])
  })

  it('takes null for an absent optional field', () => {
    expect(
      body([
        { type: 'TOOL_CALL_START', toolCallId: 'c1', toolCallName: 'x', parentMessageId: null },
        { type: 'TOOL_CALL_END', toolCallId: 'c1' }
      ])
    ).toEqual([{ kind: 'toolUse', id: 'c1', name: AGUI_TOOL, input: { tool: 'x', args: null, argsText: '' } }])
  })
})

describe('AguiEventMapper close', () => {
  it('flushes open text and thought and shows a call that never ended', () => {
    const r = run(
      [
        started,
        { type: 'REASONING_MESSAGE_START', messageId: 'r1', role: 'reasoning' },
        { type: 'REASONING_MESSAGE_CONTENT', messageId: 'r1', delta: 'think' },
        { type: 'TEXT_MESSAGE_START', messageId: 'm1' },
        { type: 'TEXT_MESSAGE_CONTENT', messageId: 'm1', delta: 'cut off' },
        { type: 'TOOL_CALL_START', toolCallId: 'c1', toolCallName: 'x' },
        { type: 'TOOL_CALL_ARGS', toolCallId: 'c1', delta: '{"a"' }
      ],
      false
    )
    expect(r.m.close()).toEqual([
      { kind: 'thinking', text: 'think' },
      { kind: 'assistantText', text: 'cut off' },
      { kind: 'toolUse', id: 'c1', name: AGUI_TOOL, input: { tool: 'x', args: null, argsText: '{"a"' } }
    ])
    expect(r.m.close()).toEqual([])
  })
})

describe('AguiEventMapper transcript', () => {
  it("gives this run's assistant and tool messages by the server's ids", () => {
    const { m } = run([
      started,
      ...text('m1', 'Let me ', 'look.'),
      ...call('c1', 'search', '{"q":"x"}', 'm1'),
      ...call('c2', 'fetch', 'raw text', 'm1'),
      { type: 'TOOL_CALL_RESULT', messageId: 'r1', toolCallId: 'c1', content: 'hit' },
      { type: 'TOOL_CALL_RESULT', messageId: 'r2', toolCallId: 'c2', content: [{ type: 'text', text: 'page' }] },
      ...call('c3', 'alone', '{}'),
      { type: 'TEXT_MESSAGE_START', messageId: 'u1', role: 'user' },
      { type: 'TEXT_MESSAGE_CONTENT', messageId: 'u1', delta: 'not ours' },
      { type: 'TEXT_MESSAGE_END', messageId: 'u1' },
      { type: 'REASONING_MESSAGE_CHUNK', messageId: 'th', delta: 'never sent' },
      finished({ outcome: { type: 'interrupt', interrupts: [{ id: 'i1', reason: 'approve', toolCallId: 'c3' }] } })
    ])
    expect(m.transcript()).toEqual([
      {
        id: 'm1',
        role: 'assistant',
        content: 'Let me look.',
        toolCalls: [
          { id: 'c1', type: 'function', function: { name: 'search', arguments: '{"q":"x"}' } },
          { id: 'c2', type: 'function', function: { name: 'fetch', arguments: 'raw text' } }
        ]
      },
      { id: 'r1', role: 'tool', toolCallId: 'c1', content: 'hit' },
      { id: 'r2', role: 'tool', toolCallId: 'c2', content: 'page' },
      { id: 'calls-c3', role: 'assistant', toolCalls: [{ id: 'c3', type: 'function', function: { name: 'alone', arguments: '{}' } }] }
    ])
  })

  it('leaves replayed runs out', () => {
    const { m } = run([
      { type: 'RUN_STARTED', threadId: T, runId: 'old' },
      ...text('o1', 'old'),
      { type: 'RUN_FINISHED', threadId: T, runId: 'old' },
      started,
      finished()
    ])
    expect(m.transcript()).toEqual([])
  })
})
