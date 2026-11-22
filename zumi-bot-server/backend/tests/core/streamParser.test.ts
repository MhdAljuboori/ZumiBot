import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { expect, test } from 'vitest'
import {
  isCutRefused,
  APPROVAL_REQUIRED,
  LineSplitter,
  isMissingSession,
  parseLine,
  type ResultEvent,
  type RunEvent
} from '../../src/core/chat/streamParser'

const fixtures = fileURLToPath(new URL('../fixtures/', import.meta.url))
const events = (n: string) => readFileSync(`${fixtures}stream/${n}.jsonl`, 'utf8').split('\n').flatMap(parseLine)

test('basic: init, deltas join to final text, success result', () => {
  const ev = events('basic')
  expect(ev[0]).toMatchObject({ kind: 'init', sessionId: expect.stringMatching(/^[0-9a-f-]{36}$/) })
  const deltas = ev
    .filter((e) => e.kind === 'textDelta')
    .map((e) => (e as any).text)
    .join('')
  const final = ev
    .filter((e) => e.kind === 'assistantText')
    .map((e) => (e as any).text)
    .join('')
  expect(deltas.length).toBeGreaterThan(0)
  expect(deltas).toBe(final)
  expect(final.toLowerCase()).toContain('pong')
  expect(ev.at(-1)).toMatchObject({ kind: 'result', subtype: 'success', isError: false, denials: [] })
})

test('tool-ok: Read use and successful result', () => {
  const ev = events('tool-ok')
  const use = ev.find((e) => e.kind === 'toolUse') as any
  expect(use.name).toBe('Read')
  expect(ev).toContainEqual(
    expect.objectContaining({
      kind: 'toolResult',
      toolUseId: use.id,
      isError: false,
      content: expect.stringContaining('hello from fixture')
    })
  )
})

test('a tool use carries the API message it came in: parallel calls of one response share it', () => {
  const line = (id: string, message?: unknown) =>
    JSON.stringify({
      type: 'assistant',
      uuid: `u-${id}`,
      parent_tool_use_id: null,
      message: {
        ...(message === undefined ? {} : { id: message }),
        role: 'assistant',
        content: [{ type: 'tool_use', id, name: 'Bash', input: {} }]
      }
    })
  const use = (l: string) => parseLine(l).find((e) => e.kind === 'toolUse')
  expect(use(line('t1', 'msg_1'))).toEqual({ kind: 'toolUse', id: 't1', name: 'Bash', input: {}, message: 'msg_1' })
  expect(use(line('t2', 'msg_1'))).toMatchObject({ message: 'msg_1' })
  expect(use(line('t3'))).toEqual({ kind: 'toolUse', id: 't3', name: 'Bash', input: {} })
  expect(use(line('t4', ''))).toEqual({ kind: 'toolUse', id: 't4', name: 'Bash', input: {} })
  // As the CLI writes it: one line per content block, all under the response's id.
  expect((events('tool-ok').find((e) => e.kind === 'toolUse') as { message?: string }).message).toMatch(/^msg_/)
})

test('tool-blocked: error result and denial for same id', () => {
  const ev = events('tool-blocked')
  const use = ev.find((e) => e.kind === 'toolUse' && (e as any).name === 'Bash') as any
  expect(ev).toContainEqual({ kind: 'toolResult', toolUseId: use.id, isError: true, content: APPROVAL_REQUIRED })
  expect((ev.at(-1) as any).denials).toContainEqual({ toolUseId: use.id, toolName: 'Bash' })
})

test('permission_denied: the reason type comes through, so only the classifier is told apart', () => {
  const use = (n: string) => events(n).find((e) => e.kind === 'toolUse' && (e as any).name === 'Bash') as any
  expect(events('tool-classifier')).toContainEqual({ kind: 'denied', toolUseId: use('tool-classifier').id, reasonType: 'classifier' })
  expect(events('tool-blocked')).toContainEqual({ kind: 'denied', toolUseId: use('tool-blocked').id, reasonType: 'other' })
  const denied = (m: object) => parseLine(JSON.stringify({ type: 'system', subtype: 'permission_denied', ...m }))
  expect(denied({ tool_use_id: 't1' })).toEqual([{ kind: 'denied', toolUseId: 't1', reasonType: '' }])
  expect(denied({ decision_reason_type: 'classifier' })).toEqual([])
})

test('rate_limit_event: session and weekly windows as percent and epoch ms', () => {
  expect(events('basic')).toContainEqual({
    kind: 'rateLimit',
    session: { percent: 15, resetsAt: 1792764000_000 },
    weekly: { percent: 21, resetsAt: 1793329200_000 }
  })
  const info = (unifiedWindows: unknown) => line({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed', unifiedWindows } })
  expect(parseLine(info({ seven_day: { utilization: 0.5 } }))).toEqual([
    { kind: 'rateLimit', session: null, weekly: { percent: 50, resetsAt: null } }
  ])
  for (const w of [undefined, null, {}, { five_hour: { utilization: 'x' } }, { five_hour: null, seven_day: 3 }])
    expect(parseLine(info(w))).toEqual([])
})

test('rate_limit_event: a rejected status is a limit hit, with its reset in epoch ms', () => {
  // As CLI 2.1.299 sends it after a 429.
  const rejected = {
    status: 'rejected',
    resetsAt: 1792539600,
    rateLimitType: 'five_hour',
    overageStatus: 'rejected',
    isUsingOverage: false
  }
  expect(parseLine(line({ type: 'rate_limit_event', rate_limit_info: rejected }))).toEqual([{ kind: 'limited', resetsAt: 1792539600_000 }])
  expect(
    parseLine(
      line({
        type: 'rate_limit_event',
        rate_limit_info: { ...rejected, unifiedWindows: { five_hour: { utilization: 1, resetsAt: 1792539600 } } }
      })
    )
  ).toEqual([
    { kind: 'rateLimit', session: { percent: 100, resetsAt: 1792539600_000 }, weekly: null },
    { kind: 'limited', resetsAt: 1792539600_000 }
  ])
  expect(parseLine(line({ type: 'rate_limit_event', rate_limit_info: { status: 'rejected' } }))).toEqual([
    { kind: 'limited', resetsAt: null }
  ])
  for (const status of ['allowed', 'allowed_warning']) {
    expect(parseLine(line({ type: 'rate_limit_event', rate_limit_info: { ...rejected, status } }))).toEqual([])
  }
})

test('ignores junk', () => {
  for (const l of ['', 'not json', '{"type":"rate_limit_event"}', '{"type":"system","subtype":"task_summary"}'])
    expect(parseLine(l)).toEqual([])
})

test('a thinking block is its text alone; a redacted one is dropped', () => {
  const l = JSON.stringify({
    type: 'assistant',
    message: {
      content: [
        { type: 'thinking', thinking: 'x' },
        { type: 'redacted_thinking', data: 'enc' }
      ]
    }
  })
  expect(parseLine(l)).toEqual([{ kind: 'thinking', text: 'x' }])
})

test('tool_result array content is normalized', () => {
  const l = JSON.stringify({
    type: 'user',
    message: {
      content: [
        { type: 'tool_result', tool_use_id: 't1', content: [{ type: 'text', text: 'a' }, { type: 'image' }, { type: 'text', text: 'b' }] }
      ]
    }
  })
  expect(parseLine(l)).toEqual([{ kind: 'toolResult', toolUseId: 't1', content: 'a\n[image]\nb', isError: false }])
})

test('LineSplitter joins a line spread over many chunks, keeps empty lines and a CR split from its LF', () => {
  const s = new LineSplitter()
  const big = 'x'.repeat(1000)
  for (let i = 0; i < 50; i++) expect(s.push(big)).toEqual([])
  expect(s.push('y\r')).toEqual([])
  expect(s.push('\na\n\nb')).toEqual([big.repeat(50) + 'y', 'a', ''])
  expect(s.push('')).toEqual([])
  expect(s.flush()).toEqual(['b'])
  expect(s.flush()).toEqual([])
})

test('LineSplitter handles split chunks and CRLF', () => {
  const s = new LineSplitter()
  expect(s.push('{"a":1}\r\n{"b"')).toEqual(['{"a":1}'])
  expect(s.push(':2}\n')).toEqual(['{"b":2}'])
  expect(s.flush()).toEqual([])
})

test('LineSplitter flush returns trailing partial line', () => {
  const s = new LineSplitter()
  s.push('tail')
  expect(s.flush()).toEqual(['tail'])
})

test('isMissingSession', () => {
  const r = events('missing-session').find((e) => e.kind === 'result') as ResultEvent
  const err = readFileSync(`${fixtures}stream/missing-session.stderr.txt`, 'utf8')
  expect(isMissingSession(true, r, err)).toBe(true)
  expect(isMissingSession(true, r, '')).toBe(true)
  expect(isMissingSession(false, r, err)).toBe(false)
  expect(isMissingSession(true, null, 'boom')).toBe(false)
})

const line = (o: unknown) => JSON.stringify(o)

test('subagent (parent_tool_use_id) text and every tool_use are kept; deltas are ignored', () => {
  const parent = 'toolu_parent'
  expect(parseLine(line({ type: 'assistant', parent_tool_use_id: parent, message: { content: [{ type: 'text', text: 'sub' }] } }))).toEqual(
    [{ kind: 'subText', parent, text: 'sub' }]
  )
  expect(
    parseLine(
      line({
        type: 'assistant',
        parent_tool_use_id: parent,
        message: { content: [{ type: 'tool_use', id: 't', name: 'Read', input: {} }] }
      })
    )
  ).toEqual([{ kind: 'subToolUse', parent, id: 't', name: 'Read', input: {}, subagent: null }])
  expect(
    parseLine(
      line({ type: 'user', parent_tool_use_id: parent, message: { content: [{ type: 'tool_result', tool_use_id: 't', content: 'x' }] } })
    )
  ).toEqual([{ kind: 'subToolResult', parent, toolUseId: 't', content: 'x', isError: false }])
  expect(
    parseLine(
      line({
        type: 'stream_event',
        parent_tool_use_id: parent,
        event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'sub' } }
      })
    )
  ).toEqual([])
  // The subagent's prompt line is the dispatch's own input: not a step.
  expect(parseLine(line({ type: 'user', parent_tool_use_id: parent, message: { content: [{ type: 'text', text: 'do it' }] } }))).toEqual([])
})

test('subagent tool_use becomes subToolUse after its text; no entry or context comes with them', () => {
  const parent = 'toolu_parent'
  for (const name of ['Edit', 'Write', 'Agent', 'Task', 'Bash']) {
    expect(
      parseLine(
        line({
          type: 'assistant',
          uuid: 'u1',
          parent_tool_use_id: parent,
          subagent_type: 'general-purpose',
          message: {
            model: 'm',
            usage: { input_tokens: 1 },
            content: [
              { type: 'text', text: 'sub' },
              { type: 'tool_use', id: 't1', name, input: { file_path: '/x' } }
            ]
          }
        })
      )
    ).toEqual([
      { kind: 'subText', parent, text: 'sub' },
      { kind: 'subToolUse', parent, id: 't1', name, input: { file_path: '/x' }, subagent: 'general-purpose' }
    ])
  }
  expect(
    parseLine(
      line({
        type: 'assistant',
        parent_tool_use_id: parent,
        message: { content: [{ type: 'tool_use', id: 't', name: 'Edit', input: {} }] }
      })
    )
  ).toMatchObject([{ kind: 'subToolUse', subagent: null }])
})

test('a subagent tool_use_result object rides on subToolResult as detail', () => {
  const r = (tur: unknown) =>
    parseLine(
      line({
        type: 'user',
        parent_tool_use_id: 'p',
        tool_use_result: tur,
        message: { content: [{ type: 'tool_result', tool_use_id: 't', content: 'x' }] }
      })
    )
  expect(r({ totalTokens: 5 })).toEqual([
    { kind: 'subToolResult', parent: 'p', toolUseId: 't', content: 'x', isError: false, detail: { totalTokens: 5 } }
  ])
  expect(r('nope')).toEqual([{ kind: 'subToolResult', parent: 'p', toolUseId: 't', content: 'x', isError: false }])
})

test('task_started, task_progress and task_updated system lines', () => {
  expect(
    parseLine(
      line({
        type: 'system',
        subtype: 'task_started',
        task_id: 'ta',
        tool_use_id: 'toolu_A',
        description: 'Review',
        subagent_type: 'general-purpose',
        prompt: 'Go'
      })
    )
  ).toEqual([
    { kind: 'taskStarted', toolUseId: 'toolu_A', taskId: 'ta', description: 'Review', subagentType: 'general-purpose', prompt: 'Go' }
  ])
  expect(parseLine(line({ type: 'system', subtype: 'task_started', task_id: 'ta', tool_use_id: 'toolu_A' }))).toEqual([
    { kind: 'taskStarted', toolUseId: 'toolu_A', taskId: 'ta', description: null, subagentType: null, prompt: null }
  ])
  expect(
    parseLine(
      line({
        type: 'system',
        subtype: 'task_progress',
        task_id: 'ta',
        tool_use_id: 'toolu_A',
        description: 'Reading a.txt',
        usage: { total_tokens: 37796, tool_uses: 1, duration_ms: 1338 }
      })
    )
  ).toEqual([{ kind: 'taskProgress', toolUseId: 'toolu_A', description: 'Reading a.txt', tokens: 37796, toolUses: 1, durationMs: 1338 }])
  expect(parseLine(line({ type: 'system', subtype: 'task_progress', tool_use_id: 'toolu_A', usage: { total_tokens: 'x' } }))).toEqual([
    { kind: 'taskProgress', toolUseId: 'toolu_A', description: null, tokens: null, toolUses: null, durationMs: null }
  ])
  expect(
    parseLine(line({ type: 'system', subtype: 'task_updated', task_id: 'ta', patch: { status: 'completed', end_time: 1793651754493 } }))
  ).toEqual([{ kind: 'taskUpdated', taskId: 'ta', status: 'completed', endTime: 1793651754493 }])
  expect(parseLine(line({ type: 'system', subtype: 'task_updated', task_id: 'ta' }))).toEqual([
    { kind: 'taskUpdated', taskId: 'ta', status: null, endTime: null }
  ])
  // No ids, nothing to attach the line to.
  expect(parseLine(line({ type: 'system', subtype: 'task_started', task_id: 'ta' }))).toEqual([])
  expect(parseLine(line({ type: 'system', subtype: 'task_progress' }))).toEqual([])
  expect(parseLine(line({ type: 'system', subtype: 'task_updated' }))).toEqual([])
})

test('dispatch-nested: two parallel dispatches and a nested one keep their own lines', () => {
  const ev = events('dispatch-nested')
  const texts = ev.filter((e) => e.kind === 'subText') as Extract<RunEvent, { kind: 'subText' }>[]
  expect(texts.map((t) => [t.parent, t.text])).toEqual([
    ['toolu_A', 'Looking at the diff.'],
    ['toolu_N', 'Searching.'],
    ['toolu_N', 'Found one caller.'],
    ['toolu_A', 'Review done: no Critical.'],
    ['toolu_B', 'Structure fine.']
  ])
  const uses = ev.filter((e) => e.kind === 'subToolUse') as Extract<RunEvent, { kind: 'subToolUse' }>[]
  expect(uses.map((u) => [u.parent, u.name])).toEqual([
    ['toolu_A', 'Bash'],
    ['toolu_B', 'Read'],
    ['toolu_A', 'Agent'],
    ['toolu_N', 'Grep']
  ])
  expect(ev.filter((e) => e.kind === 'taskStarted')).toHaveLength(3)
  expect(ev.filter((e) => e.kind === 'taskUpdated').map((e) => (e as any).status)).toEqual(['completed', 'completed', 'failed'])
  const nestedEnd = ev.find((e) => e.kind === 'subToolResult' && e.toolUseId === 'toolu_N') as Extract<RunEvent, { kind: 'subToolResult' }>
  expect(nestedEnd.detail).toMatchObject({ totalTokens: 1000 })
  expect(ev.filter((e) => e.kind === 'assistantText').map((e) => (e as any).text)).toEqual(['Both reviews ran.'])
})

test('a tool_use_result object rides on toolResult as detail; a string or null does not', () => {
  const r = (tur: unknown) =>
    parseLine(line({ type: 'user', tool_use_result: tur, message: { content: [{ type: 'tool_result', tool_use_id: 't', content: 'x' }] } }))
  expect(r({ filePath: '/a' })).toEqual([{ kind: 'toolResult', toolUseId: 't', content: 'x', isError: false, detail: { filePath: '/a' } }])
  expect(r('Error: nope')).toEqual([{ kind: 'toolResult', toolUseId: 't', content: 'x', isError: false }])
  expect(r(null)).toEqual([{ kind: 'toolResult', toolUseId: 't', content: 'x', isError: false }])
  expect(r(undefined)).toEqual([{ kind: 'toolResult', toolUseId: 't', content: 'x', isError: false }])
})

test('files-own: Edit, create Write and overwrite Write results carry detail', () => {
  const ev = events('files-own')
  const use = (name: string) => ev.filter((e) => e.kind === 'toolUse' && e.name === name) as Extract<RunEvent, { kind: 'toolUse' }>[]
  const detail = (id: string) =>
    (ev.find((e) => e.kind === 'toolResult' && e.toolUseId === id) as Extract<RunEvent, { kind: 'toolResult' }>).detail as any
  const edit = detail(use('Edit')[0].id)
  expect(edit.originalFile).toBe('alpha\nbeta\ngamma\n')
  expect(Array.isArray(edit.structuredPatch)).toBe(true)
  const [create, update] = use('Write').map((u) => detail(u.id))
  expect(create).toMatchObject({ type: 'create', filePath: '/work/b.txt', content: 'hello', originalFile: null })
  // Recorded with CLI 2.1.299: an overwrite does carry the old text and a patch.
  expect(update).toMatchObject({ type: 'update', filePath: '/work/c.txt', originalFile: 'old body\n' })
  expect(update.structuredPatch).toEqual([{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-old body', '+new body'] }])
})

test('files-subagent: the subagent Read, Edit and Write are kept under the top-level Agent', () => {
  const ev = events('files-subagent')
  const agent = ev.find((e) => e.kind === 'toolUse' && e.name === 'Agent') as Extract<RunEvent, { kind: 'toolUse' }>
  const subUses = ev.filter((e) => e.kind === 'subToolUse') as Extract<RunEvent, { kind: 'subToolUse' }>[]
  expect(subUses.map((u) => u.name)).toEqual(['Read', 'Edit', 'Write'])
  for (const u of subUses) expect(u).toMatchObject({ parent: agent.id, subagent: 'general-purpose' })
  const subResults = ev.filter((e) => e.kind === 'subToolResult') as Extract<RunEvent, { kind: 'subToolResult' }>[]
  for (const u of subUses) expect(subResults.some((r) => r.parent === agent.id && r.toolUseId === u.id)).toBe(true)
  expect(subResults).toHaveLength(3)
  // The agent's own lines: one Agent tool_use, its toolResult with detail, and its closing text; the subagent's usage stays out.
  expect(ev.filter((e) => e.kind === 'toolUse')).toHaveLength(1)
  expect(ev.filter((e) => e.kind === 'assistantText')).toHaveLength(1)
  const own = ev.find((e) => e.kind === 'toolResult' && e.toolUseId === agent.id) as Extract<RunEvent, { kind: 'toolResult' }>
  expect(own.detail).toMatchObject({ agentType: 'general-purpose' })
  expect(ev.filter((e) => e.kind === 'entry')).toHaveLength(new Set(ev.filter((e) => e.kind === 'entry').map((e) => (e as any).uuid)).size)
})

test('a null parent_tool_use_id is the agent itself', () => {
  expect(parseLine(line({ type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'text', text: 'hi' }] } }))).toEqual([
    { kind: 'assistantText', text: 'hi' }
  ])
  expect(
    parseLine(
      line({
        type: 'stream_event',
        parent_tool_use_id: null,
        event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'h' } }
      })
    )
  ).toEqual([{ kind: 'textDelta', text: 'h' }])
})

test('malformed content never throws', () => {
  const bad = [
    { type: 'assistant', message: { content: [null, { type: 'text', text: 'ok' }, 5] } },
    { type: 'assistant', message: { content: 'text' } },
    { type: 'assistant', message: null },
    { type: 'user', message: { content: [null, undefined] } },
    { type: 'user', message: { content: { type: 'tool_result' } } },
    { type: 'result', permission_denials: [null, { tool_use_id: 't', tool_name: 'Bash' }] }
  ]
  for (const b of bad) expect(() => parseLine(line(b))).not.toThrow()
  expect(parseLine(line(bad[0]))).toEqual([{ kind: 'assistantText', text: 'ok' }])
  expect(parseLine(line(bad[1]))).toEqual([])
})

test('permission-allow: one permissionRequest, then the tool result', () => {
  const ev = events('permission-allow')
  const reqs = ev.filter((e) => e.kind === 'permissionRequest') as any[]
  expect(reqs).toHaveLength(1)
  expect(reqs[0]).toMatchObject({ toolName: 'Bash', reason: APPROVAL_REQUIRED, toolUseId: expect.stringMatching(/^toolu_/) })
  expect(reqs[0].requestId.length).toBeGreaterThan(0)
  expect(reqs[0].input.command).toContain('print(6*7)')
  expect(ev).toContainEqual(expect.objectContaining({ kind: 'toolResult', content: '42', isError: false }))
})

test('permission-deny: one permissionRequest, error tool result, one denial', () => {
  const ev = events('permission-deny')
  expect(ev.filter((e) => e.kind === 'permissionRequest')).toHaveLength(1)
  expect(ev).toContainEqual(expect.objectContaining({ kind: 'toolResult', isError: true }))
  expect((ev.find((e) => e.kind === 'result') as ResultEvent).denials).toHaveLength(1)
})

test('control_cancel_request becomes permissionCancel', () => {
  expect(parseLine(line({ type: 'control_cancel_request', request_id: 'r1' }))).toEqual([{ kind: 'permissionCancel', requestId: 'r1' }])
})

test('unknown control_request subtypes become controlUnknown', () => {
  expect(parseLine(line({ type: 'control_request', request_id: 'r1', request: { subtype: 'hook_callback' } }))).toEqual([
    { kind: 'controlUnknown', requestId: 'r1', subtype: 'hook_callback' }
  ])
  expect(parseLine(line({ type: 'control_request', request: { subtype: 'hook_callback' } }))).toEqual([
    { kind: 'controlUnknown', requestId: null, subtype: 'hook_callback' }
  ])
})

test('can_use_tool without tool_name is controlUnknown, never a half-formed request', () => {
  expect(parseLine(line({ type: 'control_request', request_id: 'r1', request: { subtype: 'can_use_tool', input: {} } }))).toEqual([
    { kind: 'controlUnknown', requestId: 'r1', subtype: 'can_use_tool' }
  ])
})

test('malformed control lines never throw', () => {
  expect(parseLine('{"type":"control_request"')).toEqual([])
  expect(parseLine('{"type":"control_response"}')).toEqual([])
  for (const request of [undefined, null, 'x', 5]) {
    expect(parseLine(line({ type: 'control_request', request_id: 'r1', request }))).toEqual([
      { kind: 'controlUnknown', requestId: 'r1', subtype: '' }
    ])
  }
})

test('parseLine emits entry before content for an assistant line', () => {
  const line = JSON.stringify({ type: 'assistant', uuid: 'u1', message: { content: [{ type: 'text', text: 'hi' }] } })
  expect(parseLine(line)).toEqual([
    { kind: 'entry', uuid: 'u1' },
    { kind: 'assistantText', text: 'hi' }
  ])
})

test('parseLine emits entry for a tool_result user line', () => {
  const line = JSON.stringify({
    type: 'user',
    uuid: 'u2',
    message: { content: [{ type: 'tool_result', tool_use_id: 't', content: 'ok' }] }
  })
  expect(parseLine(line)).toEqual([
    { kind: 'entry', uuid: 'u2' },
    { kind: 'toolResult', toolUseId: 't', content: 'ok', isError: false }
  ])
})

test('parseLine emits no entry for subagent lines, stream_event or system lines', () => {
  const sub = JSON.stringify({
    type: 'assistant',
    uuid: 'u3',
    parent_tool_use_id: 'x',
    message: { content: [{ type: 'text', text: 'hi' }] }
  })
  expect(parseLine(sub)).toEqual([{ kind: 'subText', parent: 'x', text: 'hi' }])
  const se = JSON.stringify({
    type: 'stream_event',
    uuid: 'u4',
    event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'a' } }
  })
  expect(parseLine(se)).toEqual([{ kind: 'textDelta', text: 'a' }])
  const sys = JSON.stringify({ type: 'system', subtype: 'init', uuid: 'u5', session_id: 's' })
  expect(parseLine(sys)).toEqual([{ kind: 'init', sessionId: 's' }])
})

test('parseLine reads claude_code_version on init', () => {
  expect(parseLine(JSON.stringify({ type: 'system', subtype: 'init', session_id: 's', claude_code_version: '2.1.299' }))).toEqual([
    { kind: 'init', sessionId: 's', version: '2.1.299' }
  ])
  const bare = parseLine(JSON.stringify({ type: 'system', subtype: 'init', session_id: 's' }))
  expect(bare).toEqual([{ kind: 'init', sessionId: 's' }])
  expect('version' in (bare[0] as object)).toBe(false)
})

const usage = { input_tokens: 2, cache_creation_input_tokens: 41250, cache_read_input_tokens: 10, output_tokens: 4 }

test('an agent message with usage reports how full its context is, after its content', () => {
  const l = line({
    type: 'assistant',
    parent_tool_use_id: null,
    message: { model: 'claude-haiku-5-5', content: [{ type: 'text', text: 'ok' }], usage }
  })
  expect(parseLine(l)).toEqual([
    { kind: 'assistantText', text: 'ok' },
    { kind: 'context', model: 'claude-haiku-5-5', tokens: 41266 }
  ])
})

test('basic: context from the agent message, the window per model from the result', () => {
  const ev = events('basic')
  expect(ev).toContainEqual({ kind: 'context', model: 'claude-haiku-5-5', tokens: 2 + 21910 + 22835 + 4 })
  expect(ev.at(-1)).toMatchObject({ kind: 'result', windows: { 'claude-haiku-5-5': 1000000 } })
})

test('subagent usage, synthetic messages and bad usage never report a context', () => {
  const msg = (extra: object, message: object = {}) =>
    line({ type: 'assistant', message: { content: [], usage, model: 'm', ...message }, ...extra })
  expect(parseLine(msg({ parent_tool_use_id: 'toolu_parent' }))).toEqual([])
  expect(parseLine(msg({}, { model: '<synthetic>' }))).toEqual([])
  for (const bad of [null, 'x', {}, { input_tokens: 'a' }, { input_tokens: -1 }]) expect(parseLine(msg({}, { usage: bad }))).toEqual([])
  expect(parseLine(msg({}, { model: 5 }))).toEqual([{ kind: 'context', model: null, tokens: 41266 }])
})

test("each request's price is a spend event under its message id, the agent's and a subagent's (spend caps)", () => {
  const priced = { model: 'claude-haiku-5-5', id: 'msg_1', content: [], usage }
  const usd = (0.1 * 2) / 1e6 + (0.125 * 41250) / 1e6 + (0.01 * 10) / 1e6 + (0.5 * 4) / 1e6
  const main = parseLine(line({ type: 'assistant', parent_tool_use_id: null, message: priced })).filter((e) => e.kind === 'spend')
  expect(main).toHaveLength(1)
  expect(main[0]).toMatchObject({ kind: 'spend', id: 'msg_1' })
  expect((main[0] as Extract<RunEvent, { kind: 'spend' }>).usd).toBeCloseTo(usd, 12)
  // A subagent's request is paid for too, though its usage never reports a context.
  expect(
    parseLine(line({ type: 'assistant', parent_tool_use_id: 'toolu_parent', message: { ...priced, id: 'msg_sub' } })).map((e) => e.kind)
  ).toEqual(['spend'])
  // No id, a synthetic message or a model the table does not know: nothing to price.
  expect(
    parseLine(line({ type: 'assistant', parent_tool_use_id: null, message: { ...priced, id: undefined } })).some((e) => e.kind === 'spend')
  ).toBe(false)
  expect(
    parseLine(line({ type: 'assistant', parent_tool_use_id: null, message: { ...priced, model: 'unknown-model' } })).some(
      (e) => e.kind === 'spend'
    )
  ).toBe(false)
})

test('compact: compacting, the before and after the CLI reported, then a success with no turns', () => {
  const ev = events('compact')
  const kinds = ev.map((e) => e.kind)
  expect(kinds.indexOf('compacting')).toBeLessThan(kinds.indexOf('compacted'))
  expect(ev.filter((e) => e.kind === 'compacting')).toEqual([
    { kind: 'compacting', on: true },
    { kind: 'compacting', on: false }
  ])
  expect(ev).toContainEqual({ kind: 'compacted', pre: 41256, post: 3825 })
  expect(ev.at(-1)).toMatchObject({
    kind: 'result',
    subtype: 'success',
    isError: false,
    numTurns: 0,
    windows: { 'claude-haiku-5-5': 1000000 }
  })
  expect(ev.some((e) => e.kind === 'assistantText')).toBe(false)
})

test('malformed compact and window lines are ignored', () => {
  expect(parseLine(line({ type: 'system', subtype: 'compact_boundary' }))).toEqual([])
  expect(parseLine(line({ type: 'system', subtype: 'compact_boundary', compact_metadata: { pre_tokens: 'x', post_tokens: 1 } }))).toEqual(
    []
  )
  expect(parseLine(line({ type: 'system', subtype: 'status', status: 'requesting' }))).toEqual([])
  const r = parseLine(
    line({ type: 'result', subtype: 'success', modelUsage: { a: { contextWindow: 200000 }, b: { contextWindow: 'x' }, c: null } })
  )
  expect(r[0]).toMatchObject({ kind: 'result', windows: { a: 200000 } })
  expect(parseLine(line({ type: 'result', subtype: 'success' }))[0]).toMatchObject({ windows: {} })
})

test('parseLine result carries uuid and cost', () => {
  const r = events('tool-ok').at(-1) as ResultEvent
  expect(r.uuid).toBe('b5644967-5d34-47f7-a87c-73b111ed2b0b')
  expect(r.cost?.totalUsd).toBe(0.00502881)
})

test('thinking: summarized text streams and is kept per block; an empty (omitted) block is nothing', () => {
  // As claude 2.1.322 writes it: deltas carry the summary only with --thinking-display summarized, else '' and a token estimate.
  const delta = (thinking: string, estimated: number | null = null) =>
    JSON.stringify({
      type: 'stream_event',
      parent_tool_use_id: null,
      event: { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking, estimated_tokens: estimated } }
    })
  const block = (thinking: string) =>
    JSON.stringify({
      type: 'assistant',
      uuid: 'u-th',
      parent_tool_use_id: null,
      message: { id: 'msg_1', role: 'assistant', content: [{ type: 'thinking', thinking, signature: 'sig' }] }
    })
  expect(parseLine(delta("I'm checking"))).toEqual([{ kind: 'thinkingDelta', text: "I'm checking" }])
  expect(parseLine(delta('', 50))).toEqual([])
  expect(parseLine(block('I checked the file.\n\n'))).toEqual([
    { kind: 'entry', uuid: 'u-th' },
    { kind: 'thinking', text: 'I checked the file.\n\n' }
  ])
  expect(parseLine(block(''))).toEqual([{ kind: 'entry', uuid: 'u-th' }])
  expect(parseLine(block('  \n'))).toEqual([{ kind: 'entry', uuid: 'u-th' }])
  // A subagent's thinking is not the agent's.
  const sub = JSON.stringify({
    type: 'stream_event',
    parent_tool_use_id: 'toolu_1',
    event: { type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: 'sub' } }
  })
  expect(parseLine(sub)).toEqual([])
})

// A cut the CLI refused because it would discard more than the turn the cut declared: the caller reseeds, never retries.
test('isCutRefused reads the refusal of a declared cut, and nothing else', () => {
  expect(isCutRefused('Resume rejected by --resume-drops-turn: resuming at e1 would discard entries not attributable to turn p2')).toBe(
    true
  )
  expect(isCutRefused('No conversation found with session ID: s1')).toBe(false)
  expect(isCutRefused('')).toBe(false)
})
