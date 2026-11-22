import { describe, expect, it } from 'vitest'
import { AcpEventMapper } from '../../src/core/acp/acpEvents'
import type { RunEvent } from '../../src/core/chat/streamParser'

const text = (t: string) => ({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: t } })
const thought = (t: string) => ({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: t } })

function run(updates: unknown[], onMode?: (id: string) => void) {
  const m = new AcpEventMapper({ onMode })
  const ev: RunEvent[] = []
  for (const u of updates) ev.push(...m.update(u))
  ev.push(...m.turnEnd())
  return { ev, m }
}

describe('AcpEventMapper text and thoughts', () => {
  it('streams text deltas and joins the run into assistantText at the turn end', () => {
    const { ev } = run([text('Hel'), text('lo')])
    expect(ev).toEqual([
      { kind: 'textDelta', text: 'Hel' },
      { kind: 'textDelta', text: 'lo' },
      { kind: 'assistantText', text: 'Hello' }
    ])
  })

  it('joins thought runs into one thinking item', () => {
    const { ev } = run([thought('a'), thought('b')])
    expect(ev).toEqual([
      { kind: 'thinkingDelta', text: 'a' },
      { kind: 'thinkingDelta', text: 'b' },
      { kind: 'thinking', text: 'ab' }
    ])
  })

  it('a thought breaks a text run and the other way round', () => {
    const { ev } = run([text('one'), thought('hm'), text('two')])
    expect(ev.map((e) => e.kind)).toEqual(['textDelta', 'assistantText', 'thinkingDelta', 'thinking', 'textDelta', 'assistantText'])
    expect(ev[1]).toEqual({ kind: 'assistantText', text: 'one' })
    expect(ev[5]).toEqual({ kind: 'assistantText', text: 'two' })
  })

  it('a tool call breaks the text run', () => {
    const { ev } = run([
      text('before'),
      { sessionUpdate: 'tool_call', toolCallId: 't1', title: 'x', kind: 'other', status: 'in_progress' },
      text('after')
    ])
    expect(ev.map((e) => e.kind)).toEqual(['textDelta', 'assistantText', 'toolUse', 'textDelta', 'assistantText'])
  })

  it('drops image and resource chunks and whitespace-only runs', () => {
    const { ev } = run([
      { sessionUpdate: 'agent_message_chunk', content: { type: 'image', data: 'x', mimeType: 'image/png' } },
      { sessionUpdate: 'agent_message_chunk', content: { type: 'resource_link', uri: 'file:///a', name: 'a' } },
      text('  \n')
    ])
    expect(ev.filter((e) => e.kind === 'assistantText')).toEqual([])
  })

  it('ignores user_message_chunk', () => {
    expect(run([{ sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'hi' } }]).ev).toEqual([])
  })

  it('turnEnd flushes once and a second call has nothing left', () => {
    const m = new AcpEventMapper()
    m.update(text('x'))
    expect(m.turnEnd()).toEqual([{ kind: 'assistantText', text: 'x' }])
    expect(m.turnEnd()).toEqual([])
  })
})

describe('AcpEventMapper tool calls', () => {
  it('tool_call becomes a toolUse with the classified name and input', () => {
    const { ev } = run([
      { sessionUpdate: 'tool_call', toolCallId: 't1', title: 'Run', kind: 'execute', status: 'pending', rawInput: { command: 'ls' } }
    ])
    expect(ev).toEqual([{ kind: 'toolUse', id: 't1', name: 'Bash', input: { command: 'ls' } }])
  })

  it('an edit row carries the paths only, no diffs', () => {
    const { ev } = run([
      {
        sessionUpdate: 'tool_call',
        toolCallId: 't1',
        title: 'Edit',
        kind: 'edit',
        content: [{ type: 'diff', path: '/p/a.ts', oldText: 'a', newText: 'b' }]
      }
    ])
    expect(ev).toEqual([{ kind: 'toolUse', id: 't1', name: 'AcpEdit', input: { paths: ['/p/a.ts'] } }])
  })

  it('completed update gives a toolResult with the text content', () => {
    const { ev } = run([
      { sessionUpdate: 'tool_call', toolCallId: 't1', title: 'Run', kind: 'execute', rawInput: { command: 'ls' } },
      { sessionUpdate: 'tool_call_update', toolCallId: 't1', status: 'in_progress' },
      {
        sessionUpdate: 'tool_call_update',
        toolCallId: 't1',
        status: 'completed',
        content: [{ type: 'content', content: { type: 'text', text: 'a\nb' } }]
      }
    ])
    expect(ev).toEqual([
      { kind: 'toolUse', id: 't1', name: 'Bash', input: { command: 'ls' } },
      { kind: 'toolResult', toolUseId: 't1', content: 'a\nb', isError: false }
    ])
  })

  it('failed update is an error result', () => {
    const { ev } = run([
      { sessionUpdate: 'tool_call', toolCallId: 't1', title: 'Run', kind: 'other' },
      {
        sessionUpdate: 'tool_call_update',
        toolCallId: 't1',
        status: 'failed',
        content: [{ type: 'content', content: { type: 'text', text: 'boom' } }]
      }
    ])
    expect(ev[1]).toEqual({ kind: 'toolResult', toolUseId: 't1', content: 'boom', isError: true })
  })

  it('a tool_call that arrives already completed gives both events', () => {
    const { ev } = run([
      {
        sessionUpdate: 'tool_call',
        toolCallId: 't1',
        title: 'Read',
        kind: 'read',
        status: 'completed',
        content: [{ type: 'content', content: { type: 'text', text: 'file' } }]
      }
    ])
    expect(ev.map((e) => e.kind)).toEqual(['toolUse', 'toolResult'])
  })

  it('a second terminal update gives no second result, and later content does not reopen it', () => {
    const { ev } = run([
      { sessionUpdate: 'tool_call', toolCallId: 't1', title: 'x', kind: 'other' },
      { sessionUpdate: 'tool_call_update', toolCallId: 't1', status: 'completed' },
      { sessionUpdate: 'tool_call_update', toolCallId: 't1', status: 'completed' },
      { sessionUpdate: 'tool_call_update', toolCallId: 't1', status: 'failed' }
    ])
    expect(ev.filter((e) => e.kind === 'toolResult')).toHaveLength(1)
  })

  it('a repeated tool_call for a known id is read as an update, not a second row', () => {
    const { ev } = run([
      { sessionUpdate: 'tool_call', toolCallId: 't1', title: 'x', kind: 'other' },
      { sessionUpdate: 'tool_call', toolCallId: 't1', title: 'x', kind: 'other', status: 'completed' }
    ])
    expect(ev.map((e) => e.kind)).toEqual(['toolUse', 'toolResult'])
  })

  it('an update for an unseen id opens the row first', () => {
    const { ev } = run([{ sessionUpdate: 'tool_call_update', toolCallId: 'z', title: 'Late', status: 'completed' }])
    expect(ev.map((e) => e.kind)).toEqual(['toolUse', 'toolResult'])
  })

  it('a completed edit carries its diffs as detail.acpDiffs (oldText null for a new file)', () => {
    const { ev } = run([
      { sessionUpdate: 'tool_call', toolCallId: 't1', title: 'Edit', kind: 'edit', locations: [{ path: '/p/a.ts' }] },
      {
        sessionUpdate: 'tool_call_update',
        toolCallId: 't1',
        status: 'completed',
        content: [
          { type: 'diff', path: '/p/a.ts', oldText: 'old', newText: 'new' },
          { type: 'diff', path: '/p/b.ts', newText: 'fresh' }
        ]
      }
    ])
    const r = ev.find((e) => e.kind === 'toolResult') as Extract<RunEvent, { kind: 'toolResult' }>
    expect(r.isError).toBe(false)
    expect(r.detail).toEqual({
      acpDiffs: [
        { path: '/p/a.ts', oldText: 'old', newText: 'new' },
        { path: '/p/b.ts', oldText: null, newText: 'fresh' }
      ]
    })
  })

  it('a failed edit has no detail, and a non-edit never has one', () => {
    const failed = run([
      { sessionUpdate: 'tool_call', toolCallId: 't1', title: 'Edit', kind: 'edit', content: [{ type: 'diff', path: 'a', newText: 'b' }] },
      { sessionUpdate: 'tool_call_update', toolCallId: 't1', status: 'failed' }
    ]).ev.at(-1) as Extract<RunEvent, { kind: 'toolResult' }>
    expect(failed.detail).toBeUndefined()
    const read = run([
      {
        sessionUpdate: 'tool_call',
        toolCallId: 't2',
        title: 'Read',
        kind: 'read',
        status: 'completed',
        content: [{ type: 'diff', path: 'a', newText: 'b' }]
      }
    ]).ev.at(-1) as Extract<RunEvent, { kind: 'toolResult' }>
    expect(read.detail).toBeUndefined()
  })

  it('update content replaces the earlier content', () => {
    const { ev } = run([
      { sessionUpdate: 'tool_call', toolCallId: 't1', title: 'x', kind: 'execute' },
      {
        sessionUpdate: 'tool_call_update',
        toolCallId: 't1',
        status: 'in_progress',
        content: [{ type: 'content', content: { type: 'text', text: 'first' } }]
      },
      {
        sessionUpdate: 'tool_call_update',
        toolCallId: 't1',
        status: 'completed',
        content: [{ type: 'content', content: { type: 'text', text: 'second' } }]
      }
    ])
    expect((ev.at(-1) as Extract<RunEvent, { kind: 'toolResult' }>).content).toBe('second')
  })

  it('the row keeps the name it opened with, even when a later update would classify differently', () => {
    const { ev } = run([
      { sessionUpdate: 'tool_call', toolCallId: 't1', title: 'x', kind: 'other', status: 'in_progress' },
      { sessionUpdate: 'tool_call_update', toolCallId: 't1', kind: 'edit', rawInput: { command: 'ls' } },
      { sessionUpdate: 'tool_call_update', toolCallId: 't1', status: 'completed', content: [{ type: 'diff', path: 'a', newText: 'b' }] }
    ])
    expect((ev[0] as Extract<RunEvent, { kind: 'toolUse' }>).name).toBe('AcpCall')
    expect((ev[1] as Extract<RunEvent, { kind: 'toolResult' }>).detail).toBeUndefined()
  })

  it('toolCall(id) gives the merged state, a copy, or undefined for an unseen id', () => {
    const m = new AcpEventMapper()
    m.update({ sessionUpdate: 'tool_call', toolCallId: 't1', title: 'Run', kind: 'execute', locations: [{ path: 'a' }] })
    m.update({
      sessionUpdate: 'tool_call_update',
      toolCallId: 't1',
      rawInput: { command: 'ls' },
      content: [{ type: 'terminal', terminalId: 'x' }]
    })
    expect(m.toolCall('t1')).toEqual({
      kind: 'execute',
      title: 'Run',
      rawInput: { command: 'ls' },
      content: [{ type: 'terminal', terminalId: 'x' }],
      locations: [{ path: 'a' }]
    })
    expect(m.toolCall('nope')).toBeUndefined()
    const snap = m.toolCall('t1')!
    snap.title = 'changed'
    expect(m.toolCall('t1')!.title).toBe('Run')
  })

  it('cuts a long result like tool rows', () => {
    const { ev } = run([
      {
        sessionUpdate: 'tool_call',
        toolCallId: 't1',
        title: 'x',
        kind: 'other',
        status: 'completed',
        content: [{ type: 'content', content: { type: 'text', text: 'z'.repeat(40_000) } }]
      }
    ])
    const r = ev.at(-1) as Extract<RunEvent, { kind: 'toolResult' }>
    expect(r.content.length).toBe(30_000 + '\n[output cut]'.length)
    expect(r.content.endsWith('\n[output cut]')).toBe(true)
  })

  it('ignores a terminal content item and a tool call with no id', () => {
    const { ev } = run([
      { sessionUpdate: 'tool_call', title: 'no id' },
      {
        sessionUpdate: 'tool_call',
        toolCallId: 't1',
        title: 'x',
        kind: 'other',
        status: 'completed',
        content: [{ type: 'terminal', terminalId: 'term' }]
      }
    ])
    expect(ev).toEqual([
      { kind: 'toolUse', id: 't1', name: 'AcpCall', input: { title: 'x' } },
      { kind: 'toolResult', toolUseId: 't1', content: '', isError: false }
    ])
  })
})

// What claude-agent-acp 0.108.0 sends (captured from the real agent): the call first, with an empty rawInput, and what it does
// only in later updates. `_meta.claudeCode.toolName` names Claude's own tool.
const meta = (toolName: string) => ({ _meta: { claudeCode: { toolName } } })
const call = (id: string, kind: string, title: string, toolName: string) => ({
  sessionUpdate: 'tool_call',
  toolCallId: id,
  kind,
  title,
  status: 'pending',
  rawInput: {},
  ...meta(toolName)
})
const upd = (id: string, fields: object) => ({ sessionUpdate: 'tool_call_update', toolCallId: id, ...fields })
const done = (id: string, content?: unknown) => upd(id, { status: 'completed', ...(content === undefined ? {} : { content }) })
const out = (t: string) => [{ type: 'content', content: { type: 'text', text: t } }]

describe('AcpEventMapper: a row waits until its call can be named', () => {
  it("claude-agent-acp's Bash: the row opens on the update carrying the command, as Bash {command}", () => {
    const m = new AcpEventMapper()
    expect(m.update(call('b1', 'execute', 'Terminal', 'Bash'))).toEqual([])
    expect(m.update(upd('b1', { rawInput: { command: 'ls' } }))).toEqual([
      { kind: 'toolUse', id: 'b1', name: 'Bash', input: { command: 'ls' } }
    ])
    // Later input changes nothing on the row: its name and input are fixed once shown.
    expect(m.update(upd('b1', { rawInput: { command: 'ls', description: 'List files' }, title: 'ls' }))).toEqual([])
    expect(m.update(done('b1', out('a.txt')))).toEqual([{ kind: 'toolResult', toolUseId: 'b1', content: 'a.txt', isError: false }])
    expect(m.turnEnd()).toEqual([])
  })

  it("claude-agent-acp's Edit: AcpEdit with the path, and the diff on its result", () => {
    const f = '/w/f.txt'
    const { ev } = run([
      call('e1', 'edit', 'Edit', 'Edit'),
      upd('e1', { rawInput: { file_path: f }, locations: [{ path: f }] }),
      upd('e1', { content: [{ type: 'diff', path: f, oldText: 'one\ntwo', newText: 'one\nTWO' }] }),
      done('e1')
    ])
    expect(ev).toEqual([
      { kind: 'toolUse', id: 'e1', name: 'AcpEdit', input: { paths: [f] } },
      {
        kind: 'toolResult',
        toolUseId: 'e1',
        content: f,
        isError: false,
        detail: { acpDiffs: [{ path: f, oldText: 'one\ntwo', newText: 'one\nTWO' }] }
      }
    ])
  })

  it("claude-agent-acp's Read: AcpRead with the path", () => {
    const { ev } = run([call('r1', 'read', 'Read', 'Read'), upd('r1', { rawInput: { file_path: '/w/f.txt' } }), done('r1', out('text'))])
    expect(ev).toEqual([
      { kind: 'toolUse', id: 'r1', name: 'AcpRead', input: { paths: ['/w/f.txt'] } },
      { kind: 'toolResult', toolUseId: 'r1', content: 'text', isError: false }
    ])
  })

  it('locations alone, or diff content alone, open the row', () => {
    const m = new AcpEventMapper()
    m.update(call('a', 'read', 'Read', 'Read'))
    expect(m.update(upd('a', { locations: [{ path: 'x' }] }))).toEqual([
      { kind: 'toolUse', id: 'a', name: 'AcpRead', input: { paths: ['x'] } }
    ])
    m.update(call('b', 'edit', 'Edit', 'Edit'))
    expect(m.update(upd('b', { content: [{ type: 'diff', path: 'y', oldText: 'a', newText: 'b' }] }))).toEqual([
      { kind: 'toolUse', id: 'b', name: 'AcpEdit', input: { paths: ['y'] } }
    ])
  })

  it('empty input, empty locations and text content keep it waiting; in_progress shows it as it is', () => {
    const m = new AcpEventMapper()
    m.update(call('c', 'execute', 'Terminal', 'Bash'))
    expect(m.update(upd('c', { rawInput: {}, locations: [], content: out('starting') }))).toEqual([])
    expect(m.update(upd('c', { status: 'in_progress' }))).toEqual([
      { kind: 'toolUse', id: 'c', name: 'AcpCall', input: { title: 'Terminal', rawInput: {} } }
    ])
  })

  // claude-agent-acp sends rawInput one complete top-level field at a time.
  it('an unclassified call (an MCP tool) is never opened on input: its row waits for a status and shows the whole input', () => {
    const m = new AcpEventMapper()
    m.update(call('mcp', 'other', 'mcp__notes__add', 'mcp__notes__add'))
    expect(m.update(upd('mcp', { rawInput: { title: 'Groceries' } }))).toEqual([])
    expect(m.update(upd('mcp', { rawInput: { title: 'Groceries', body: 'milk' } }))).toEqual([])
    expect(m.update(upd('mcp', { status: 'in_progress' }))).toEqual([
      { kind: 'toolUse', id: 'mcp', name: 'AcpCall', input: { title: 'mcp__notes__add', rawInput: { title: 'Groceries', body: 'milk' } } }
    ])
  })

  it('an execute whose first field is not the command waits until the command arrives', () => {
    const m = new AcpEventMapper()
    m.update(call('x', 'execute', 'Terminal', 'Bash'))
    expect(m.update(upd('x', { rawInput: { description: 'List files' } }))).toEqual([])
    expect(m.update(upd('x', { rawInput: { description: 'List files', command: 'ls' } }))).toEqual([
      { kind: 'toolUse', id: 'x', name: 'Bash', input: { command: 'ls' } }
    ])
  })

  it("an unclassified call is shown by a permission request or the turn's end with its input as it then stands", () => {
    const m = new AcpEventMapper()
    m.update(call('t', 'think', 'Task', 'Task'))
    m.update(upd('t', { rawInput: { description: 'Look around' } }))
    m.update(upd('t', { rawInput: { description: 'Look around', prompt: 'Find the config' } }))
    expect(m.turnEnd()).toEqual([
      {
        kind: 'toolUse',
        id: 't',
        name: 'AcpCall',
        input: { title: 'Task', rawInput: { description: 'Look around', prompt: 'Find the config' } }
      }
    ])
  })

  it('completed or failed with nothing else shows the row, then its result', () => {
    const { ev } = run([call('d', 'other', 'Something', 'mcp__x__y'), upd('d', { status: 'failed', content: out('boom') })])
    expect(ev).toEqual([
      { kind: 'toolUse', id: 'd', name: 'AcpCall', input: { title: 'Something', rawInput: {} } },
      { kind: 'toolResult', toolUseId: 'd', content: 'boom', isError: true }
    ])
  })

  it("show(id, request) opens a waiting row from the call merged with a permission request's fields, once", () => {
    const m = new AcpEventMapper()
    m.update(call('p', 'execute', 'Terminal', 'Bash'))
    // As the runner passes it: the request's whole toolCall, its id and status included.
    const request: Record<string, unknown> = { toolCallId: 'p', status: 'pending', rawInput: { command: 'rm x' } }
    expect(m.show('p', request)).toEqual([{ kind: 'toolUse', id: 'p', name: 'Bash', input: { command: 'rm x' } }])
    expect(m.show('p', { rawInput: { command: 'other' } })).toEqual([])
    // The request's fields name the row only: the call as the stream told it is unchanged.
    expect(m.toolCall('p')!.rawInput).toEqual({})
    expect(m.update(done('p'))).toEqual([{ kind: 'toolResult', toolUseId: 'p', content: '', isError: false }])
  })

  it('show(id, request) for a call the stream never announced opens it from the request, closing the text run first', () => {
    const m = new AcpEventMapper()
    m.update(text('hi'))
    expect(m.show('q', { kind: 'read', title: 'Read', locations: [{ path: 'z' }] })).toEqual([
      { kind: 'assistantText', text: 'hi' },
      { kind: 'toolUse', id: 'q', name: 'AcpRead', input: { paths: ['z'] } }
    ])
    expect(m.toolCall('q')).toMatchObject({ kind: 'read', title: 'Read', locations: [{ path: 'z' }] })
  })

  it("the turn's end shows a row still waiting, after the open text run, so the runner can close it", () => {
    const { ev } = run([text('before'), call('w', 'execute', 'Terminal', 'Bash'), text('after')])
    expect(ev).toEqual([
      { kind: 'textDelta', text: 'before' },
      { kind: 'assistantText', text: 'before' },
      { kind: 'textDelta', text: 'after' },
      { kind: 'assistantText', text: 'after' },
      { kind: 'toolUse', id: 'w', name: 'AcpCall', input: { title: 'Terminal', rawInput: {} } }
    ])
  })

  it('a plan leaves a waiting row waiting; a second turnEnd shows nothing again', () => {
    const m = new AcpEventMapper()
    m.update(call('v', 'execute', 'Terminal', 'Bash'))
    const plan = m.update({ sessionUpdate: 'plan', entries: [{ content: 'a', priority: 'low', status: 'pending' }] })
    expect(plan.map((e) => e.kind)).toEqual(['toolUse', 'toolResult'])
    expect((plan[0] as Extract<RunEvent, { kind: 'toolUse' }>).name).toBe('Plan')
    expect(m.update(upd('v', { rawInput: { command: 'pwd' } }))).toEqual([
      { kind: 'toolUse', id: 'v', name: 'Bash', input: { command: 'pwd' } }
    ])
    expect(m.turnEnd()).toEqual([])
  })
})

describe('AcpEventMapper plan, usage, modes', () => {
  it('a plan becomes a Plan toolUse and a markdown checklist result', () => {
    const { ev } = run([
      {
        sessionUpdate: 'plan',
        entries: [
          { content: 'Read code', priority: 'high', status: 'completed' },
          { content: 'Write tests', priority: 'medium', status: 'in_progress' },
          { content: 'Ship', priority: 'low', status: 'pending' }
        ]
      }
    ])
    expect(ev).toHaveLength(2)
    const use = ev[0] as Extract<RunEvent, { kind: 'toolUse' }>
    const res = ev[1] as Extract<RunEvent, { kind: 'toolResult' }>
    expect(use.name).toBe('Plan')
    expect(res.toolUseId).toBe(use.id)
    expect(res.isError).toBe(false)
    expect(res.content).toBe('- [x] Read code\n- [ ] Write tests (in progress)\n- [ ] Ship')
  })

  it('each plan update is its own row; an empty plan gives nothing', () => {
    const e = [{ content: 'a', priority: 'low', status: 'pending' }]
    const { ev } = run([
      { sessionUpdate: 'plan', entries: e },
      { sessionUpdate: 'plan', entries: e },
      { sessionUpdate: 'plan', entries: [] },
      { sessionUpdate: 'plan' }
    ])
    const uses = ev.filter((x) => x.kind === 'toolUse') as Extract<RunEvent, { kind: 'toolUse' }>[]
    expect(uses).toHaveLength(2)
    expect(uses[0].id).not.toBe(uses[1].id)
  })

  it('usage_update gives context tokens, remembers the size, and never a cost or spend', () => {
    const { ev, m } = run([{ sessionUpdate: 'usage_update', used: 1234, size: 200000, cost: { amount: 0.5, currency: 'USD' } }])
    expect(ev).toEqual([{ kind: 'context', model: null, tokens: 1234 }])
    expect(m.contextWindow).toBe(200000)
  })

  it('usage_update with odd numbers is read defensively', () => {
    const { ev, m } = run([
      { sessionUpdate: 'usage_update', used: 'x', size: -3 },
      { sessionUpdate: 'usage_update', used: 10 }
    ])
    expect(ev).toEqual([{ kind: 'context', model: null, tokens: 10 }])
    expect(m.contextWindow).toBeNull()
  })

  it('current_mode_update reports the id through onMode', () => {
    const seen: string[] = []
    const { ev } = run([{ sessionUpdate: 'current_mode_update', currentModeId: 'bypassPermissions' }], (id) => seen.push(id))
    expect(seen).toEqual(['bypassPermissions'])
    expect(ev).toEqual([])
  })

  it('config_option_update reports only a mode-category current value', () => {
    const seen: string[] = []
    run(
      [
        {
          sessionUpdate: 'config_option_update',
          configOptions: [
            { id: 'mode', category: 'mode', currentValue: 'yolo' },
            { id: 'model', category: 'model', currentValue: 'big' },
            { id: 'x', currentValue: 'nope' },
            { id: 'flag', category: 'mode', currentValue: true }
          ]
        }
      ],
      (id) => seen.push(id)
    )
    expect(seen).toEqual(['yolo'])
  })

  it('unknown kinds and odd input are ignored and never throw', () => {
    const odd = [
      null,
      undefined,
      4,
      'x',
      [],
      {},
      { sessionUpdate: 7 },
      { sessionUpdate: 'available_commands_update', availableCommands: [] },
      { sessionUpdate: 'session_info_update', title: 't' },
      { sessionUpdate: 'future_kind', a: 1 },
      { sessionUpdate: 'agent_message_chunk' },
      { sessionUpdate: 'agent_message_chunk', content: 4 },
      { sessionUpdate: 'tool_call_update' },
      { sessionUpdate: 'plan', entries: 'x' }
    ]
    const m = new AcpEventMapper({
      onMode: () => {
        throw new Error('cb')
      }
    })
    for (const u of odd) expect(() => m.update(u)).not.toThrow()
    expect(m.turnEnd()).toEqual([])
  })
})
