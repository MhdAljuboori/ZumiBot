import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  CODEX_BLOCKED_TOOL,
  CODEX_CARD_DIFF_MAX,
  CODEX_DIFF_MAX,
  CODEX_TOOL_OUTPUT_MAX,
  CodexEventMapper
} from '../../src/core/codex/codexEvents'
import type { RunEvent } from '../../src/core/chat/streamParser'
import { parseQuestions, QUESTION_TOOL } from '@zumibot/shared/questions'
import { SNAPSHOT_MAX_BYTES } from '../../src/core/files/snapshotStore'
import { DispatchRecorder } from '../../src/core/dispatch/dispatchRecorder'
import { priceCodex } from '@zumibot/shared/pricing'

const FIX = join(__dirname, '..', 'fixtures', 'codex')
// Spend events (one per priced request) have tests of their own; the replays list the rest.
const kinds = (ev: RunEvent[]) => ev.filter((e) => e.kind !== 'spend').map((e) => e.kind)

// Feeds the recorded lines from codex (dir 'in') the way the runner would; a line with id and method is a server request.
// A fixture may hold several processes (a fork, a resume): each `initialize` is a new one, with its own mapper and thread,
// as the runner has. The returned mapper is the last process's.
function replay(name: string, model = 'gpt-6-astra') {
  const lines = readFileSync(join(FIX, name), 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l))
  let m = new CodexEventMapper()
  let started = false
  const events: RunEvent[] = []
  const kindsOfRequests: unknown[] = []
  for (const l of lines) {
    if (l.dir === 'out' && l.msg?.method === 'initialize' && started) {
      events.push(...m.flush()) // as the runner does when the process ends
      m = new CodexEventMapper()
      started = false
    }
    if (l.dir === 'in' && l.msg?.result?.thread?.id && !started) {
      events.push(...m.started(l.msg.result.thread.id, model, '0.164.0'))
      started = true
    }
    if (l.dir !== 'in' || !l.msg?.method) continue
    if (l.msg.id !== undefined) {
      events.push(...m.flush()) // as the runner does before a request
      const r = m.serverRequest(l.msg.id, l.msg.method, l.msg.params)
      events.push(...r.events)
      kindsOfRequests.push(r.kind)
    } else events.push(...m.notification(l.msg.method, l.msg.params))
  }
  events.push(...m.flush()) // as the runner does when the process ends
  return { m, events, kindsOfRequests }
}

const mapper = (model: string | null = 'gpt-6-astra') => {
  const m = new CodexEventMapper()
  m.started('thread-1', model, null)
  return m
}

const usage = (last: Record<string, number>, window: number | null = 258400) => ({
  threadId: 'thread-1',
  turnId: 'u',
  tokenUsage: { total: last, last, modelContextWindow: window }
})
const tokens = (input: number, cached: number, output: number) => ({
  totalTokens: input + output,
  inputTokens: input,
  cachedInputTokens: cached,
  cacheWriteInputTokens: 0,
  outputTokens: output,
  reasoningOutputTokens: 0
})

describe('CodexEventMapper replays', () => {
  it('check 1: a command run in auto mode', () => {
    const { events } = replay('codex-check1.jsonl')
    const k = kinds(events)
    expect(k[0]).toBe('init')
    expect(k.filter((x) => x === 'textDelta').length).toBeGreaterThan(0)
    expect(k.indexOf('toolUse')).toBeGreaterThan(k.indexOf('textDelta'))
    expect(k.indexOf('toolResult')).toBeGreaterThan(k.indexOf('toolUse'))
    expect(k.indexOf('context')).toBeGreaterThan(k.indexOf('toolResult'))
    expect(k.at(-1)).toBe('result')
    expect(k).toContain('rateLimit')
    expect(events.filter((e) => e.kind === 'rateLimit').every((e) => (e as any).provider === 'codex')).toBe(true)
    const use = events.find((e) => e.kind === 'toolUse') as any
    expect(use.name).toBe('Bash')
    expect(use.input).toEqual({ command: "/bin/bash -lc 'echo hi'", cwd: expect.any(String) })
    const res = events.find((e) => e.kind === 'toolResult') as any
    expect(res).toMatchObject({ toolUseId: use.id, content: 'hi\n', isError: false })
    const ctx = events.find((e) => e.kind === 'context') as any
    expect(ctx).toEqual({ kind: 'context', model: 'gpt-6-astra', tokens: 14342 + 49 })
    const done = events.at(-1) as any
    expect(done).toMatchObject({
      kind: 'result',
      subtype: 'completed',
      isError: false,
      numTurns: 1,
      denials: [],
      windows: { 'gpt-6-astra': 258400 }
    })
    expect(done.uuid).toBeTruthy()
    expect(done.sessionId).toBe('01a1c020-5d31-7bc0-bad8-1dea3e49eb34')
    expect(done.cost.models['gpt-6-astra']).toMatchObject({ input: 4438, cacheRead: 24320, output: 59 }) // the two updates' last, same as the final total
    expect(events[0]).toEqual({ kind: 'init', sessionId: '01a1c020-5d31-7bc0-bad8-1dea3e49eb34', version: '0.164.0' })
  })

  it('reasoning summary (codex 0.164.0, model_reasoning_summary auto): the summary streams, then is kept before the reply', () => {
    const { events } = replay('codex-reasoning-summary.jsonl')
    const k = kinds(events)
    expect(k.filter((x) => x === 'thinkingDelta')).toHaveLength(1)
    expect(k.indexOf('thinking')).toBeGreaterThan(k.indexOf('thinkingDelta'))
    expect(k.indexOf('thinking')).toBeLessThan(k.indexOf('textDelta'))
    const thought = events.find((e) => e.kind === 'thinking') as Extract<RunEvent, { kind: 'thinking' }>
    expect(thought.text).toBe('**Checking prime divisors**')
    expect(thought.startedAt).toBe(1794591065287)
    expect(events.at(-1)).toMatchObject({ kind: 'result', isError: false })
  })

  it('check 2: a plain reply ends done with a cost', () => {
    const { events } = replay('codex-check2.jsonl')
    expect(kinds(events)).toContain('assistantText')
    expect(kinds(events)).not.toContain('toolUse')
    expect(events.at(-1)).toMatchObject({ kind: 'result', isError: false })
  })

  it('check 3: a declined command is an error result, the request is cancelled when it resolves', () => {
    const { events, kindsOfRequests } = replay('codex-check3.jsonl')
    const k = kinds(events)
    const req = events.find((e) => e.kind === 'permissionRequest') as any
    expect(req).toMatchObject({
      requestId: '0',
      toolName: 'Bash',
      input: { command: "/bin/bash -lc 'touch ../outside-marker'" },
      toolUseId: expect.stringMatching(/^exec-/)
    })
    expect(kindsOfRequests).toEqual(['command', 'command', 'command', 'command']) // the fixture holds four turns
    expect(k.indexOf('permissionCancel')).toBe(k.indexOf('permissionRequest') + 1)
    const res = events.find((e) => e.kind === 'toolResult') as any
    expect(res.isError).toBe(true)
    expect(events.at(-1)).toMatchObject({ kind: 'result', subtype: 'completed' })
  })

  it('check 4 and 5 (auto mode): approval reviews and guardian warnings are dropped', () => {
    for (const [f, turns] of [
      ['codex-check4.jsonl', 4],
      ['codex-check5.jsonl', 1]
    ] as const) {
      const { events } = replay(f)
      expect(kinds(events)).not.toContain('permissionRequest')
      expect(kinds(events).filter((x) => x === 'result')).toHaveLength(turns)
    }
    const { events } = replay('codex-check5.jsonl')
    const use = events.find((e) => e.kind === 'toolUse') as any
    expect(use).toMatchObject({ name: 'mcp__probe__probe_echo', input: { text: 'hello' } })
    expect(events.find((e) => e.kind === 'toolResult')).toMatchObject({ toolUseId: use.id, content: 'echo: hello', isError: false })
  })

  it('check 5 (manual): the MCP elicitation becomes a permission request for the started tool', () => {
    const { events, kindsOfRequests } = replay('codex-check5-manual.jsonl')
    const req = events.find((e) => e.kind === 'permissionRequest') as any
    expect(req).toMatchObject({ requestId: '0', toolName: 'mcp__probe__probe_echo', input: { text: 'hello' } })
    expect(req.toolUseId).toMatch(/^exec-/)
    expect(kindsOfRequests).toEqual(['elicitation'])
    expect(kinds(events)).toContain('permissionCancel')
  })

  it('check 7: one entry per turn, each right before its result and never before text', () => {
    const { events } = replay('codex-check7.jsonl')
    const k = kinds(events)
    expect(k.filter((x) => x === 'entry')).toHaveLength(5)
    k.forEach((x, i) => {
      if (x === 'result') expect(k[i - 1]).toBe('entry')
    })
    k.forEach((x, i) => {
      if (x === 'entry') expect(k[i + 1]).toBe('result')
    })
    for (const e of events) if (e.kind === 'result') expect(events[events.indexOf(e) - 1]).toEqual({ kind: 'entry', uuid: e.uuid })
    const firstText = k.indexOf('assistantText')
    expect(k.indexOf('entry')).toBeGreaterThan(firstText)
  })

  it('check 9: a compaction turn is reported once, with its entry and result', () => {
    const { events } = replay('codex-check9.jsonl')
    expect(kinds(events).filter((x) => x === 'compacted')).toHaveLength(1)
    expect(kinds(events).slice(-2)).toEqual(['entry', 'result'])
    const auto = replay('codex-check9-auto.jsonl').events
    expect(kinds(auto).filter((x) => x === 'compacted')).toHaveLength(1) // the fixture's one compaction item, and no thread/compacted
  })

  it('check 10: the file change result carries each full diff and its kind', () => {
    const { events } = replay('codex-check10.jsonl')
    const res = events.find((e) => e.kind === 'toolResult') as any
    expect(res.detail).toEqual({
      codexChanges: [
        {
          path: expect.stringMatching(/a\.txt$/),
          kind: 'update',
          movePath: null,
          diff: '@@ -1,3 +1,3 @@\n line one\n-line two\n+line TWO changed\n line three\n'
        },
        { path: expect.stringMatching(/b\.txt$/), kind: 'add', movePath: null, diff: 'brand new\n' },
        { path: expect.stringMatching(/c\.txt$/), kind: 'delete', movePath: null, diff: 'to be deleted\n' }
      ]
    })
    expect(res.isError).toBe(false)
  })

  it('check 15: the question request becomes a question card the card parser accepts', () => {
    const { events, kindsOfRequests } = replay('codex-check15.jsonl')
    expect(kindsOfRequests).toEqual(['userInput'])
    const req = events.find((e) => e.kind === 'permissionRequest') as any
    expect(req).toMatchObject({ requestId: '0', toolName: QUESTION_TOOL, toolUseId: 'call_907c7bf7259c4b0893d73dd0dbdc874b' })
    expect(req.input).toEqual({
      questions: [
        {
          question: 'Which color do you pick?',
          header: 'Color',
          multiSelect: false,
          codexId: 'color',
          options: [
            { label: 'Red', description: 'Pick red.' },
            { label: 'Blue', description: 'Pick blue.' }
          ]
        }
      ]
    })
    const parsed = parseQuestions(req.input)!
    expect(parsed.questions).toHaveLength(1)
    expect(parsed.questions[0]).toMatchObject({
      kind: 'choice',
      text: 'Which color do you pick?',
      options: [{ label: 'Red' }, { label: 'Blue' }]
    })
    expect(kinds(events)).toContain('permissionCancel')
  })

  it('check 6: an interrupted turn is not an error', () => {
    const { events } = replay('codex-check6.jsonl')
    expect(events.at(-1)).toMatchObject({ kind: 'result', subtype: 'interrupted', isError: false })
  })
})

describe('CodexEventMapper notifications', () => {
  it('keeps the command as codex gives it and caps big output', () => {
    const m = mapper()
    const big = 'x'.repeat(100_000)
    const ev = m.notification('item/completed', {
      item: { type: 'commandExecution', id: 'c1', command: 'ls', cwd: '/w', status: 'completed', aggregatedOutput: big, exitCode: 0 }
    })
    const res = ev.find((e) => e.kind === 'toolResult') as any
    expect(res.content.length).toBe(CODEX_TOOL_OUTPUT_MAX + '\n[output cut]'.length)
    expect(res.content.endsWith('\n[output cut]')).toBe(true)
  })

  it('a non-zero exit code or failed status is an error', () => {
    const m = mapper()
    const done = (id: string, status: string, exitCode: number | null) =>
      m
        .notification('item/completed', {
          item: { type: 'commandExecution', id, command: 'c', cwd: '/w', status, aggregatedOutput: null, exitCode }
        })
        .find((e) => e.kind === 'toolResult') as any
    expect(done('a', 'completed', 2)).toMatchObject({ isError: true, content: '' })
    expect(done('b', 'failed', null).isError).toBe(true)
    expect(done('c', 'completed', 0).isError).toBe(false)
  })

  it('maps an MCP call to the mcp__server__tool name', () => {
    const m = mapper()
    const ev = m.notification('item/started', {
      item: {
        type: 'mcpToolCall',
        id: 'm1',
        server: 'zumibot_todos',
        tool: 'add',
        status: 'inProgress',
        arguments: { texts: ['a'] },
        result: null,
        error: null
      }
    })
    expect(ev).toEqual([
      { kind: 'toolUse', id: 'm1', name: 'mcp__zumibot_todos__add', input: { texts: ['a'] }, message: 'thread-1:response-0' }
    ])
    const end = m.notification('item/completed', {
      item: {
        type: 'mcpToolCall',
        id: 'm1',
        server: 'zumibot_todos',
        tool: 'add',
        status: 'failed',
        arguments: {},
        result: null,
        error: { message: 'boom' }
      }
    })
    expect(end).toEqual([{ kind: 'toolResult', toolUseId: 'm1', content: 'boom', isError: true }])
  })

  it('maps file changes and web searches', () => {
    const m = mapper()
    const ch = [
      { path: '/w/a.ts', kind: { type: 'update', move_path: null }, diff: '@@' },
      { path: '/w/b.ts', kind: { type: 'add' }, diff: '' }
    ]
    expect(m.notification('item/started', { item: { type: 'fileChange', id: 'f1', changes: ch, status: 'inProgress' } })).toEqual([
      {
        kind: 'toolUse',
        id: 'f1',
        name: 'ApplyPatch',
        input: {
          changes: [
            { path: '/w/a.ts', kind: 'update' },
            { path: '/w/b.ts', kind: 'add' }
          ]
        },
        message: 'thread-1:response-0'
      }
    ])
    const end = m.notification('item/completed', { item: { type: 'fileChange', id: 'f1', changes: ch, status: 'declined' } })
    expect(end[0]).toMatchObject({ kind: 'toolResult', toolUseId: 'f1', isError: true })
    expect(m.notification('item/started', { item: { type: 'webSearch', id: 'w1', query: 'cats', action: null, results: null } })).toEqual([
      { kind: 'toolUse', id: 'w1', name: 'WebSearch', input: { query: 'cats' }, message: 'thread-1:response-0' }
    ])
    expect(
      m.notification('item/completed', { item: { type: 'webSearch', id: 'w1', query: 'cats', action: null, results: null } })[0]
    ).toMatchObject({ kind: 'toolResult', toolUseId: 'w1', isError: false })
  })

  it('a result that arrives with no start still gets its tool row', () => {
    const m = mapper()
    const ev = m.notification('item/completed', {
      item: { type: 'commandExecution', id: 'late', command: 'ls', cwd: '/w', status: 'completed', aggregatedOutput: 'a', exitCode: 0 }
    })
    expect(kinds(ev)).toEqual(['toolUse', 'toolResult'])
  })

  it('the context is input + output, cached input counted once', () => {
    const m = mapper()
    const ev = m.notification('thread/tokenUsage/updated', usage({ inputTokens: 1000, cachedInputTokens: 800, outputTokens: 50 }))
    expect(ev).toEqual([
      { kind: 'context', model: 'gpt-6-astra', tokens: 1050 },
      { kind: 'spend', id: 'codex:1', usd: priceCodex('gpt-6-astra', { input: 1000, cachedInput: 800, output: 50 }) }
    ])
  })

  it('each request is priced as a spend event of its own, numbered; an unpriced model adds none', () => {
    const m = mapper()
    const first = m.notification('thread/tokenUsage/updated', usage(tokens(100, 0, 10)))
    const second = m.notification('thread/tokenUsage/updated', usage(tokens(200, 100, 20)))
    expect(first.filter((e) => e.kind === 'spend')).toEqual([
      { kind: 'spend', id: 'codex:1', usd: priceCodex('gpt-6-astra', { input: 100, cachedInput: 0, output: 10 }) }
    ])
    expect(second.filter((e) => e.kind === 'spend')).toEqual([
      { kind: 'spend', id: 'codex:2', usd: priceCodex('gpt-6-astra', { input: 200, cachedInput: 100, output: 20 }) }
    ])
  })

  it('sums the last of every update into the turn cost', () => {
    const m = mapper()
    m.notification('turn/started', { threadId: 'thread-1', turn: { id: 'u' } })
    m.notification('thread/tokenUsage/updated', usage(tokens(1000, 800, 50)))
    m.notification('thread/tokenUsage/updated', usage(tokens(2000, 1000, 100)))
    const res = m
      .notification('turn/completed', { threadId: 'thread-1', turn: { id: 'u', status: 'completed', error: null } })
      .at(-1) as any
    expect(res.cost.models['gpt-6-astra']).toMatchObject({ input: 3000 - 1800, cacheRead: 1800, output: 150 })
    expect(res.windows).toEqual({ 'gpt-6-astra': 258400 })
    expect(res).toMatchObject({ uuid: 'u', sessionId: 'thread-1', subtype: 'completed', isError: false })
  })

  it('a turn with no token update has no cost, and a failed turn is an error', () => {
    const m = mapper()
    const res = m
      .notification('turn/completed', {
        threadId: 'thread-1',
        turn: { id: 'u', status: 'failed', error: { message: 'bad', codexErrorInfo: null } }
      })
      .at(-1) as any
    expect(res).toMatchObject({ cost: null, isError: true, subtype: 'failed', windows: {} })
    expect(m.lastError).toBe('bad')
  })

  it('keeps no window when the model is unknown', () => {
    const m = mapper(null)
    m.notification('thread/tokenUsage/updated', usage(tokens(10, 0, 1)))
    const res = m
      .notification('turn/completed', { threadId: 'thread-1', turn: { id: 'u', status: 'completed', error: null } })
      .at(-1) as any
    expect(res.windows).toEqual({})
  })

  const snapshot = (primary: any, secondary: any = null, reached: string | null = null) => ({
    rateLimits: { limitId: 'codex', primary, secondary, rateLimitReachedType: reached }
  })
  const limitErr = (info: unknown = 'usageLimitExceeded') => ({
    error: { message: 'You hit your usage limit', codexErrorInfo: info, additionalDetails: null },
    willRetry: false,
    threadId: 'thread-1',
    turnId: 'u'
  })

  it('a rate-limit snapshot is a Codex reading, primary as session and secondary as weekly, resets in ms', () => {
    const m = mapper()
    expect(
      m.notification(
        'account/rateLimits/updated',
        snapshot(
          { usedPercent: 14, windowDurationMins: 300, resetsAt: 1794240015 },
          { usedPercent: 19, windowDurationMins: 10080, resetsAt: 1794391539 }
        )
      )
    ).toEqual([
      {
        kind: 'rateLimit',
        provider: 'codex',
        session: { percent: 14, resetsAt: 1794240015_000 },
        weekly: { percent: 19, resetsAt: 1794391539_000 }
      }
    ])
  })

  it('a missing or malformed window is null, and no readable window emits nothing', () => {
    const m = mapper()
    expect(
      m.notification(
        'account/rateLimits/updated',
        snapshot({ usedPercent: 13, windowDurationMins: 300 }, { usedPercent: 'x', resetsAt: 5 })
      )
    ).toEqual([{ kind: 'rateLimit', provider: 'codex', session: { percent: 13, resetsAt: null }, weekly: null }])
    expect(m.notification('account/rateLimits/updated', snapshot(null, { resetsAt: 5 }))).toEqual([])
    expect(m.notification('account/rateLimits/updated', { rateLimits: null })).toEqual([])
  })

  it('the reading does not change the limited mapping', () => {
    const m = mapper()
    m.notification('account/rateLimits/updated', snapshot({ usedPercent: 100, windowDurationMins: 300, resetsAt: 1900000000 }))
    expect(m.notification('error', limitErr())).toEqual([{ kind: 'limited', resetsAt: 1900000000000 }])
  })

  it('a usage-limit error resets at the exhausted window', () => {
    const m = mapper()
    m.notification(
      'account/rateLimits/updated',
      snapshot(
        { usedPercent: 100, windowDurationMins: 300, resetsAt: 1900000000 },
        { usedPercent: 19, windowDurationMins: 10080, resetsAt: 1900500000 }
      )
    )
    expect(m.notification('error', limitErr())).toEqual([{ kind: 'limited', resetsAt: 1900000000000 }])
    expect(m.lastError).toBe('You hit your usage limit')
  })

  it('without an exhausted window it takes the later reset, or null', () => {
    const m = mapper()
    m.notification(
      'account/rateLimits/updated',
      snapshot(
        { usedPercent: 50, windowDurationMins: 300, resetsAt: 1900000000 },
        { usedPercent: 19, windowDurationMins: 10080, resetsAt: 1900500000 }
      )
    )
    expect(m.notification('error', limitErr())).toEqual([{ kind: 'limited', resetsAt: 1900500000000 }])
    const n = mapper()
    expect(n.notification('error', limitErr())).toEqual([{ kind: 'limited', resetsAt: null }])
  })

  it('a snapshot that says the limit was reached makes any error limited', () => {
    const m = mapper()
    m.notification(
      'account/rateLimits/updated',
      snapshot({ usedPercent: 100, windowDurationMins: 300, resetsAt: 1900000000 }, null, 'rate_limit_reached')
    )
    expect(m.notification('error', limitErr('other'))).toEqual([{ kind: 'limited', resetsAt: 1900000000000 }])
  })

  it('another error is just remembered', () => {
    const m = mapper()
    expect(m.notification('error', limitErr('unauthorized'))).toEqual([])
    expect(m.lastError).toBe('You hit your usage limit')
  })

  it('remembers the code of the last error, from a notice or else from the failed turn', () => {
    const m = mapper()
    expect(m.lastErrorInfo).toBeNull()
    m.notification('error', limitErr('unauthorized'))
    expect(m.lastErrorInfo).toBe('unauthorized')
    m.notification('error', limitErr({ httpConnectionFailed: { httpStatusCode: null } }))
    expect(m.lastErrorInfo).toBe('unauthorized')
    m.notification('turn/completed', {
      threadId: 'thread-1',
      turn: { id: 'u', status: 'failed', error: { message: 'x', codexErrorInfo: 'other' } }
    })
    expect(m.lastErrorInfo).toBe('unauthorized')
    const n = mapper()
    n.notification('turn/completed', {
      threadId: 'thread-1',
      turn: { id: 'u', status: 'failed', error: { message: 'x', codexErrorInfo: 'unauthorized' } }
    })
    expect(n.lastErrorInfo).toBe('unauthorized')
  })

  it('shows a compaction once even when codex reports it twice', () => {
    const m = mapper()
    m.notification('thread/tokenUsage/updated', usage(tokens(5000, 0, 100)))
    const a = m.notification('item/completed', { item: { type: 'contextCompaction', id: 'x' } })
    const b = m.notification('thread/compacted', { threadId: 'thread-1', turnId: 'u' })
    expect([...a, ...b]).toEqual([{ kind: 'compacted', pre: 5100, post: 0 }])
    expect(kinds(m.notification('thread/compacted', { threadId: 'thread-1', turnId: 'u' }))).toEqual(['compacted'])
  })

  it('streams text and ends a message', () => {
    const m = mapper()
    expect(m.notification('item/agentMessage/delta', { itemId: 'a', delta: 'Hi' })).toEqual([{ kind: 'textDelta', text: 'Hi' }])
    expect(m.notification('item/completed', { item: { type: 'agentMessage', id: 'a', text: 'Hi there', phase: 'final_answer' } })).toEqual([
      { kind: 'assistantText', text: 'Hi there' }
    ])
  })

  it('streams the reasoning summary as thinking and keeps it, timed from when the reasoning began; raw reasoning never shows', () => {
    const m = mapper()
    const at = { threadId: 'thread-1', turnId: 't1', itemId: 'r1' }
    expect(
      m.notification('item/started', {
        threadId: 'thread-1',
        turnId: 't1',
        item: { type: 'reasoning', id: 'r1', summary: [], content: [] },
        startedAtMs: 5000
      })
    ).toEqual([])
    expect(m.notification('item/reasoning/summaryPartAdded', { ...at, summaryIndex: 0 })).toEqual([])
    expect(m.notification('item/reasoning/summaryTextDelta', { ...at, summaryIndex: 0, delta: '**Checking**' })).toEqual([
      { kind: 'thinkingDelta', text: '**Checking**' }
    ])
    expect(m.notification('item/reasoning/summaryPartAdded', { ...at, summaryIndex: 1 })).toEqual([{ kind: 'thinkingDelta', text: '\n\n' }])
    expect(m.notification('item/reasoning/summaryTextDelta', { ...at, summaryIndex: 1, delta: 'Then the parser.' })).toEqual([
      { kind: 'thinkingDelta', text: 'Then the parser.' }
    ])
    expect(m.notification('item/reasoning/textDelta', { ...at, contentIndex: 0, delta: 'raw' })).toEqual([])
    expect(
      m.notification('item/completed', {
        threadId: 'thread-1',
        turnId: 't1',
        item: { type: 'reasoning', id: 'r1', summary: ['**Checking**', 'Then the parser.', ' '], content: ['raw'] }
      })
    ).toEqual([{ kind: 'thinking', text: '**Checking**\n\nThen the parser.', startedAt: 5000 }])
    // An empty summary (summaries off, or none for this model) keeps nothing; one whose start was not seen has no startedAt.
    expect(m.notification('item/completed', { item: { type: 'reasoning', id: 'r2', summary: [], content: [] } })).toEqual([])
    expect(m.notification('item/completed', { item: { type: 'reasoning', id: 'r3', summary: ['x'] } })).toEqual([
      { kind: 'thinking', text: 'x' }
    ])
  })

  it('drops what Phase 1 does not show, and never throws on odd input', () => {
    const m = mapper()
    for (const [method, params] of [
      ['item/started', { item: { type: 'reasoning', id: 'r' } }],
      ['item/completed', { item: { type: 'plan', id: 'p', text: 'x' } }],
      ['item/started', { item: { type: 'subAgentActivity', id: 'c', kind: 'started' } }], // names no child thread
      ['item/started', { item: { type: 'userMessage', id: 'u' } }],
      ['turn/plan/updated', {}],
      ['turn/diff/updated', {}],
      ['hook/started', {}],
      ['hook/completed', {}],
      ['item/autoApprovalReview/started', {}],
      ['item/autoApprovalReview/completed', {}],
      ['guardianWarning', {}],
      ['no/such/method', { a: 1 }],
      ['item/started', null],
      ['item/completed', {}],
      ['thread/tokenUsage/updated', {}],
      ['error', null],
      ['turn/completed', null],
      ['item/agentMessage/delta', null],
      ['item/reasoning/summaryTextDelta', null],
      ['item/reasoning/summaryTextDelta', { delta: 7 }],
      ['item/reasoning/summaryPartAdded', { summaryIndex: '2' }],
      ['item/completed', { item: { type: 'reasoning', id: 'r', summary: 'not a list' } }]
    ] as [string, any][])
      expect(m.notification(method, params)).toEqual([])
  })
})

describe('CodexEventMapper server requests', () => {
  it('a command approval is a Bash permission request', () => {
    const m = mapper()
    const r = m.serverRequest(7, 'item/commandExecution/requestApproval', {
      kind: 'command',
      itemId: 'e1',
      command: 'touch x',
      cwd: '/w',
      reason: 'outside the sandbox'
    })
    expect(r.kind).toBe('command')
    expect(r.events).toEqual([
      {
        kind: 'permissionRequest',
        requestId: '7',
        toolName: 'Bash',
        input: { command: 'touch x', cwd: '/w' },
        description: null,
        reason: 'outside the sandbox',
        toolUseId: 'e1'
      }
    ])
  })

  it('a file approval reads the changes, with each diff, from the item it saw start', () => {
    const m = mapper()
    const changes = [
      { path: '/w/a', kind: { type: 'delete' }, diff: '' },
      { path: '/w/b.ts', kind: { type: 'update' }, diff: '@@ -1 +1 @@\n-old\n+new' }
    ]
    m.notification('item/started', { item: { type: 'fileChange', id: 'f1', status: 'inProgress', changes } })
    const r = m.serverRequest('abc', 'item/fileChange/requestApproval', { itemId: 'f1', reason: null })
    expect(r.kind).toBe('fileChange')
    expect(r.events[0]).toMatchObject({
      kind: 'permissionRequest',
      requestId: 'abc',
      toolName: 'ApplyPatch',
      toolUseId: 'f1',
      input: {
        changes: [
          { path: '/w/a', kind: 'delete', diff: '' },
          { path: '/w/b.ts', kind: 'update', diff: '@@ -1 +1 @@\n-old\n+new' }
        ]
      }
    })
  })

  it("a file approval names a move's destination, so the card shows where the file goes", () => {
    const m = mapper()
    const changes = [
      { path: '/w/a.ts', kind: { type: 'update', move_path: '/w/lib/a.ts' }, diff: '@@ -1 +1 @@\n-x\n+y' },
      { path: '/w/b.ts', kind: { type: 'update', move_path: null }, diff: '' }
    ]
    m.notification('item/started', { item: { type: 'fileChange', id: 'f1', status: 'inProgress', changes } })
    const input = (m.serverRequest(2, 'item/fileChange/requestApproval', { itemId: 'f1' }).events[0] as any).input
    // A plain update keeps the card it had (and the rules keyed on it); only a move gains the key.
    expect(input.changes).toEqual([
      { path: '/w/a.ts', kind: 'update', movePath: '/w/lib/a.ts', diff: '@@ -1 +1 @@\n-x\n+y' },
      { path: '/w/b.ts', kind: 'update', diff: '' }
    ])
  })

  it('a file approval caps each diff and the whole card, and keys a cut diff by its full text', () => {
    const m = mapper()
    const big = (c: string) => c.repeat(9000)
    const changes = ['a', 'b', 'c', 'd', 'e', 'f'].map((c) => ({ path: `/w/${c}`, kind: { type: 'add' }, diff: big(c) }))
    m.notification('item/started', { item: { type: 'fileChange', id: 'f1', status: 'inProgress', changes } })
    const input = (m.serverRequest(1, 'item/fileChange/requestApproval', { itemId: 'f1' }).events[0] as any).input
    const diffs: string[] = input.changes.map((c: any) => c.diff)
    expect(diffs[0]).toBe('a'.repeat(CODEX_DIFF_MAX) + '…[cut]')
    expect(diffs.reduce((n, d) => n + d.replace('…[cut]', '').length, 0)).toBe(CODEX_CARD_DIFF_MAX)
    expect(diffs.at(-1)).toBe('…[cut]')
    // A cut diff carries a digest of the whole text, so "Allow for this chat" never matches a patch that differs past the cut.
    const other = mapper()
    other.notification('item/started', {
      item: { type: 'fileChange', id: 'f1', status: 'inProgress', changes: [{ ...changes[0], diff: big('a') + 'tail' }] }
    })
    const otherInput = (other.serverRequest(1, 'item/fileChange/requestApproval', { itemId: 'f1' }).events[0] as any).input
    expect(otherInput.changes[0].diff).toBe(diffs[0])
    expect(otherInput.changes[0].sha256).toMatch(/^[0-9a-f]{64}$/)
    expect(otherInput.changes[0].sha256).not.toBe(input.changes[0].sha256)
    expect(input.changes.every((c: any) => c.diff.endsWith('…[cut]') === (c.sha256 !== undefined))).toBe(true)
  })

  it('a file approval with no known changes shows no card, so the runner declines it', () => {
    const m = mapper()
    expect(m.serverRequest(8, 'item/fileChange/requestApproval', { itemId: 'zz' })).toEqual({ events: [], kind: 'fileChange' })
    m.notification('item/started', { item: { type: 'fileChange', id: 'f2', status: 'inProgress', changes: [] } })
    expect(m.serverRequest(9, 'item/fileChange/requestApproval', { itemId: 'f2' })).toEqual({ events: [], kind: 'fileChange' })
  })

  it('a file approval that asks for a session-wide write root shows no card, so the runner declines it', () => {
    const m = mapper()
    m.notification('item/started', {
      item: { type: 'fileChange', id: 'f1', status: 'inProgress', changes: [{ path: '/w/a', kind: { type: 'add' }, diff: 'x' }] }
    })
    // Accepting would allow writes under the root for the rest of the session, which no card or rule can show.
    expect(m.serverRequest(3, 'item/fileChange/requestApproval', { itemId: 'f1', reason: null, grantRoot: '/' })).toEqual({
      events: [],
      kind: 'fileChange'
    })
    expect(m.serverRequest(4, 'item/fileChange/requestApproval', { itemId: 'f1', grantRoot: '/w/lib' })).toEqual({
      events: [],
      kind: 'fileChange'
    })
    // A value off the protocol's shape is no "none": it fails closed as well.
    expect(m.serverRequest(6, 'item/fileChange/requestApproval', { itemId: 'f1', grantRoot: { path: '/' } })).toEqual({
      events: [],
      kind: 'fileChange'
    })
    // None asked: the card as before.
    for (const grantRoot of [null, undefined, '']) {
      const r = m.serverRequest(5, 'item/fileChange/requestApproval', { itemId: 'f1', grantRoot })
      expect(r.events).toHaveLength(1)
      expect(r.events[0]).toMatchObject({ kind: 'permissionRequest', toolName: 'ApplyPatch', toolUseId: 'f1' })
    }
  })

  it('a permissions request is SandboxPermissions', () => {
    const m = mapper()
    const perms = { network: { enabled: true } }
    const r = m.serverRequest(3, 'item/permissions/requestApproval', { itemId: 'p1', cwd: '/w', reason: 'net', permissions: perms })
    expect(r.kind).toBe('permissions')
    expect(r.events[0]).toMatchObject({
      toolName: 'SandboxPermissions',
      input: { permissions: perms, cwd: '/w' },
      reason: 'net',
      toolUseId: 'p1'
    })
  })

  const elicitation = (over: object = {}) => ({
    threadId: 'thread-1',
    turnId: 'u',
    serverName: 'probe',
    mode: 'form',
    message: 'Allow the probe MCP server to run tool "probe_echo"?',
    _meta: { codex_approval_kind: 'mcp_tool_call', tool_params: { text: 'hi' } },
    requestedSchema: { type: 'object', properties: {} },
    ...over
  })
  const startMcp = (m: CodexEventMapper, id: string, server: string, tool: string) =>
    m.notification('item/started', { item: { type: 'mcpToolCall', id, server, tool, status: 'inProgress', arguments: {} } })

  it('an MCP tool-call elicitation names the quoted tool, and its item when exactly one running call of the server is that tool', () => {
    const m = mapper()
    startMcp(m, 'm1', 'probe', 'old_tool')
    startMcp(m, 'm2', 'other', 'x')
    startMcp(m, 'm3', 'probe', 'probe_echo')
    const r = m.serverRequest(0, 'mcpServer/elicitation/request', elicitation())
    expect(r.kind).toBe('elicitation')
    expect(r.events).toEqual([
      {
        kind: 'permissionRequest',
        requestId: '0',
        toolName: 'mcp__probe__probe_echo',
        input: { text: 'hi' },
        description: null,
        reason: null,
        toolUseId: 'm3'
      }
    ])
  })

  it('with parallel calls on one server the quoted name wins over the newest call', () => {
    const m = mapper()
    startMcp(m, 'g1', 'srv', 'get_issue')
    startMcp(m, 'd1', 'srv', 'delete_repo')
    startMcp(m, 'g2', 'srv', 'get_issue')
    const r = m.serverRequest(
      0,
      'mcpServer/elicitation/request',
      elicitation({ serverName: 'srv', message: 'Allow the srv MCP server to run tool "delete_repo"?' })
    )
    expect(r.events).toEqual([
      {
        kind: 'permissionRequest',
        requestId: '0',
        toolName: 'mcp__srv__delete_repo',
        input: { text: 'hi' },
        description: null,
        reason: null,
        toolUseId: 'd1'
      }
    ])
    // Two running calls of the quoted tool: the name is sure, the item is not.
    const twice = m.serverRequest(
      1,
      'mcpServer/elicitation/request',
      elicitation({ serverName: 'srv', message: 'Allow the srv MCP server to run tool "get_issue"?' })
    )
    expect(twice.events[0]).toMatchObject({ toolName: 'mcp__srv__get_issue', toolUseId: null })
  })

  it('with no quoted name only a single running call of the server names the tool; none or several is declined with no card', () => {
    const m = mapper()
    const bare = () => elicitation({ serverName: 'srv', message: 'Allow it?' })
    startMcp(m, 'g1', 'srv', 'get_issue')
    startMcp(m, 'o1', 'other', 'x')
    expect(m.serverRequest(0, 'mcpServer/elicitation/request', bare()).events).toEqual([
      {
        kind: 'permissionRequest',
        requestId: '0',
        toolName: 'mcp__srv__get_issue',
        input: { text: 'hi' },
        description: null,
        reason: null,
        toolUseId: 'g1'
      }
    ])
    startMcp(m, 'd1', 'srv', 'delete_repo')
    expect(m.serverRequest(1, 'mcpServer/elicitation/request', bare())).toEqual({ events: [], kind: 'elicitation' })
  })

  it('falls back to the quoted name in the message, and to no events', () => {
    const m = mapper()
    const r = m.serverRequest(1, 'mcpServer/elicitation/request', elicitation())
    expect(r.kind).toBe('elicitation')
    expect(r.events[0]).toMatchObject({ toolName: 'mcp__probe__probe_echo', toolUseId: null })
    const none = m.serverRequest(2, 'mcpServer/elicitation/request', elicitation({ message: 'Allow it?' }))
    expect(none).toEqual({ events: [], kind: 'elicitation' })
  })

  it('a finished call is no longer a candidate', () => {
    const m = mapper()
    startMcp(m, 'm1', 'probe', 'old_tool')
    m.notification('item/completed', {
      item: { type: 'mcpToolCall', id: 'm1', server: 'probe', tool: 'old_tool', status: 'completed', result: null, error: null }
    })
    const r = m.serverRequest(1, 'mcpServer/elicitation/request', elicitation())
    expect((r.events[0] as any).toolName).toBe('mcp__probe__probe_echo')
    expect((r.events[0] as any).toolUseId).toBeNull()
  })

  it('an elicitation that is not a tool approval is declined by the runner, with no card', () => {
    const m = mapper()
    for (const meta of [{ codex_approval_kind: 'other' }, {}, null]) {
      expect(m.serverRequest(5, 'mcpServer/elicitation/request', elicitation({ _meta: meta }))).toEqual({ events: [], kind: 'elicitation' })
    }
    expect(m.serverRequest(6, 'mcpServer/elicitation/request', null)).toEqual({ events: [], kind: 'elicitation' })
  })

  it('a user-input request with no usable question shows no card, and unknown requests are unknown', () => {
    const m = mapper()
    for (const params of [{ itemId: 'q' }, { itemId: 'q', questions: [] }, { itemId: 'q', questions: [{ id: 'x' }, null] }]) {
      expect(m.serverRequest(1, 'item/tool/requestUserInput', params)).toEqual({ events: [], kind: 'userInput' })
    }
    expect(m.serverRequest(2, 'some/new/request', {})).toEqual({
      events: [{ kind: 'controlUnknown', requestId: '2', subtype: 'some/new/request' }],
      kind: null
    })
  })

  it('cancels only a request that is still open', () => {
    const m = mapper()
    m.serverRequest(7, 'item/commandExecution/requestApproval', { itemId: 'e1', command: 'x', cwd: '/w' })
    m.serverRequest(8, 'item/commandExecution/requestApproval', { itemId: 'e2', command: 'y', cwd: '/w' })
    m.answered(8)
    expect(m.notification('serverRequest/resolved', { threadId: 't', requestId: 8 })).toEqual([])
    expect(m.notification('serverRequest/resolved', { threadId: 't', requestId: 7 })).toEqual([
      { kind: 'permissionCancel', requestId: '7' }
    ])
    expect(m.notification('serverRequest/resolved', { threadId: 't', requestId: 7 })).toEqual([])
    expect(m.notification('serverRequest/resolved', { threadId: 't', requestId: 99 })).toEqual([])
  })

  it('exposes the model it started with', () => {
    expect(mapper('gpt-6-astra').model).toBe('gpt-6-astra')
    expect(mapper(null).model).toBeNull()
    expect(new CodexEventMapper().lastError).toBeNull()
  })

  it('a question with no options is a free-text question; text and ids stay unique and non-blank', () => {
    const m = mapper()
    const r = m.serverRequest(3, 'item/tool/requestUserInput', {
      itemId: 'q',
      questions: [
        { id: 'a', header: 'Name', question: 'Your name?', isOther: true, isSecret: true, options: null },
        {
          id: 'b',
          header: 'Name2',
          question: 'Your name?',
          isOther: false,
          isSecret: false,
          options: [
            { label: 'x', description: null },
            { label: ' ', description: 'blank' }
          ]
        },
        { id: 'c', header: 'Third', question: '  ', options: [] }
      ]
    })
    const input = (r.events[0] as any).input
    expect(input.questions.map((q: any) => [q.codexId, q.question, q.kind ?? 'choice'])).toEqual([
      ['a', 'Your name?', 'text'],
      ['b', 'Your name? (2)', 'choice'],
      ['c', 'Third', 'text']
    ])
    expect(input.questions[1].options).toEqual([{ label: 'x', description: null }])
    expect(parseQuestions(input)).not.toBeNull()
  })

  it('a turn boundary resets the compaction de-dup flags', () => {
    const m = mapper()
    const done = { item: { type: 'contextCompaction', id: 'x' } }
    expect(kinds(m.notification('item/completed', done))).toEqual(['compacted'])
    // The old notice that never came would have skipped the next turn's own compaction.
    m.notification('turn/completed', { turn: { id: 't1', status: 'completed' } })
    m.notification('turn/started', { turn: { id: 't2' } })
    expect(kinds(m.notification('item/completed', done))).toEqual(['compacted'])
    m.notification('turn/completed', { turn: { id: 't2', status: 'completed' } })
    expect(kinds(m.notification('thread/compacted', {}))).toEqual(['compacted'])
  })

  it('every turn end gets an entry first, whatever its status; none without a turn id', () => {
    for (const status of ['completed', 'failed', 'interrupted']) {
      const ev = mapper().notification('turn/completed', { turn: { id: 'turn-9', status } })
      expect(ev.map((e) => e.kind)).toEqual(['entry', 'result'])
      expect(ev[0]).toEqual({ kind: 'entry', uuid: 'turn-9' })
    }
    expect(kinds(mapper().notification('turn/completed', { turn: { status: 'completed' } }))).toEqual(['result'])
  })

  it('a long diff is kept whole in the detail up to the snapshot cap, and a move path is kept', () => {
    const m = mapper()
    const big = 'x'.repeat(CODEX_DIFF_MAX * 3)
    const huge = 'y'.repeat(SNAPSHOT_MAX_BYTES + 10)
    const mid = 'z'.repeat(300 * 1024) // past the old 256 KiB cut, still a copy the panel can keep
    const item = {
      type: 'fileChange',
      id: 'f',
      status: 'completed',
      changes: [
        { path: '/w/a', kind: { type: 'update', move_path: '/w/b' }, diff: big },
        { path: '/w/h', kind: { type: 'update', move_path: null }, diff: huge },
        { path: '/w/m', kind: { type: 'delete' }, diff: mid }
      ]
    }
    m.notification('item/started', { item })
    const res = m.notification('item/completed', { item }).find((e) => e.kind === 'toolResult') as any
    const [a, h, mm] = res.detail.codexChanges
    expect(mm).toEqual({ path: '/w/m', kind: 'delete', movePath: null, diff: mid })
    expect(a).toEqual({ path: '/w/a', kind: 'update', movePath: '/w/b', diff: big })
    expect(h).toMatchObject({ path: '/w/h', kind: 'update', movePath: null, cut: true })
    expect(a.cut).toBeUndefined()
    expect(h.diff.length).toBeLessThanOrEqual(SNAPSHOT_MAX_BYTES)
    // The row is unchanged (paths only); the card has its capped diff and names the move's destination.
    const started = m.notification('item/started', { item: { ...item, id: 'g' } })
    expect(started[0]).toMatchObject({
      input: {
        changes: [
          { path: '/w/a', kind: 'update' },
          { path: '/w/h', kind: 'update' },
          { path: '/w/m', kind: 'delete' }
        ]
      }
    })
    const card = m.serverRequest(4, 'item/fileChange/requestApproval', { itemId: 'g' }).events[0] as any
    expect(card.input.changes[0]).toEqual({
      path: '/w/a',
      kind: 'update',
      movePath: '/w/b',
      diff: 'x'.repeat(CODEX_DIFF_MAX) + '…[cut]',
      sha256: expect.any(String)
    })
  })

  it('a failed patch has no detail', () => {
    const m = mapper()
    const res = m
      .notification('item/completed', {
        item: { type: 'fileChange', id: 'f', status: 'failed', changes: [{ path: '/w/a', kind: { type: 'add' }, diff: 'x' }] }
      })
      .find((e) => e.kind === 'toolResult') as any
    expect(res.isError).toBe(true)
    expect(res.detail).toBeUndefined()
  })
})

// Check 11: a call a PreToolUse hook blocks has no item; its text reaches the client only in `hook/completed`
// (`run.status: "blocked"`, feedback entries), and `run.id` ends with the call's tool_use_id.
describe('CodexEventMapper blocked calls', () => {
  const SRC = '/<session-flags>/config.toml'
  const run = (toolUseId: string, status: string, entries: unknown[] = [], order = 0) => ({
    id: `pre-tool-use:${order}:${SRC}:${toolUseId}`,
    eventName: 'preToolUse',
    handlerType: 'command',
    executionMode: 'sync',
    scope: 'turn',
    sourcePath: SRC,
    source: 'sessionFlags',
    displayOrder: order,
    status,
    statusMessage: null,
    startedAt: 1,
    completedAt: status === 'running' ? null : 1,
    durationMs: status === 'running' ? null : 2,
    entries
  })
  const hook = (
    method: 'hook/started' | 'hook/completed',
    toolUseId: string,
    status: string,
    entries: unknown[] = [],
    threadId = 'thread-1',
    order = 0
  ) => [method, { threadId, turnId: 'turn-1', run: run(toolUseId, status, entries, order) }] as const
  const blockedRows = (events: RunEvent[]) => events.filter((e) => e.kind === 'toolUse' && e.name === CODEX_BLOCKED_TOOL)

  it('check 11: each blocked call becomes its own row with the hook text; completed and failed hooks (exit 1, a timeout) add nothing', () => {
    const { events } = replay('codex-check11.jsonl')
    const uses = blockedRows(events) as Extract<RunEvent, { kind: 'toolUse' }>[]
    // `touch blocked-marker` in auto mode and `touch blocked-marker-manual` in manual mode.
    expect(uses.map((u) => u.id)).toEqual(['exec-7b42396a-f6ef-4d31-8492-df1da00963ae', 'exec-ed6e3e31-18c5-429a-8c63-a1e259d50a20'])
    for (const u of uses) {
      expect(u).toEqual({ kind: 'toolUse', id: u.id, name: 'Blocked', input: {}, message: expect.any(String) })
      const i = events.indexOf(u)
      expect(events[i + 1]).toEqual({ kind: 'toolResult', toolUseId: u.id, content: 'BLOCKED-BY-PROBE', isError: true })
    }
    // The exit 1 and timeout calls ran: their items are ordinary rows, and nothing else names a hook run.
    const ids = events.filter((e) => e.kind === 'toolUse').map((e) => (e as any).id)
    expect(ids).toContain('exec-0cc630f7-1914-4ebc-ae80-2736ed79aaa4')
    expect(ids).toContain('exec-fb3ff833-5fff-4e66-a882-c333d0368512')
    expect(events.filter((e) => e.kind === 'toolResult' && (e as any).content === 'BLOCKED-BY-PROBE')).toHaveLength(2)
    // Every turn still ends with its result, after the rows of that turn.
    expect(events.at(-1)?.kind).toBe('result')
  })

  it('check 11 subagent run: hooks that pass, on the main thread or a child, add nothing', () => {
    const { events } = replay('codex-check11-subagent.jsonl')
    expect(blockedRows(events)).toEqual([])
  })

  it('hook/started and a hook/completed that is not blocked map to nothing', () => {
    const m = mapper()
    expect(m.notification(...hook('hook/started', 'exec-a', 'running'))).toEqual([])
    expect(m.notification(...hook('hook/completed', 'exec-a', 'completed'))).toEqual([])
    expect(m.notification(...hook('hook/completed', 'exec-b', 'failed', [{ kind: 'error', text: 'hook exited with code 1' }]))).toEqual([])
    expect(m.notification(...hook('hook/completed', 'exec-c', 'failed', [{ kind: 'error', text: 'hook timed out after 5s' }]))).toEqual([])
    expect(m.flush()).toEqual([])
  })

  it("a child thread's blocked hook is left alone (its thread is not the main one)", () => {
    const m = mapper()
    expect(
      m.notification(...hook('hook/completed', 'exec-sub', 'blocked', [{ kind: 'feedback', text: 'PAUSED' }], 'child-thread'))
    ).toEqual([])
    // No thread at all is not the main thread either.
    expect(
      m.notification('hook/completed', { turnId: 'turn-1', run: run('exec-x', 'blocked', [{ kind: 'feedback', text: 'PAUSED' }]) })
    ).toEqual([])
    expect(m.flush()).toEqual([])
  })

  it('a block is held until the next notification, so every hook that blocked the same call lands in one row', () => {
    const m = mapper()
    expect(m.notification(...hook('hook/started', 'exec-1', 'running', [], 'thread-1', 0))).toEqual([])
    expect(m.notification(...hook('hook/completed', 'exec-1', 'blocked', [{ kind: 'feedback', text: 'VAULT' }], 'thread-1', 0))).toEqual([])
    expect(m.notification(...hook('hook/started', 'exec-1', 'running', [], 'thread-1', 1))).toEqual([])
    expect(
      m.notification(
        ...hook(
          'hook/completed',
          'exec-1',
          'blocked',
          [
            { kind: 'feedback', text: 'PAUSE' },
            { kind: 'feedback', text: 'again' }
          ],
          'thread-1',
          1
        )
      )
    ).toEqual([])
    const next = m.notification('item/agentMessage/delta', { threadId: 'thread-1', turnId: 'turn-1', itemId: 'm', delta: 'ok' })
    expect(next).toEqual([
      { kind: 'toolUse', id: 'exec-1', name: 'Blocked', input: {}, message: 'thread-1:response-0' },
      { kind: 'toolResult', toolUseId: 'exec-1', content: 'VAULT\nPAUSE\nagain', isError: true },
      { kind: 'textDelta', text: 'ok' }
    ])
    expect(m.flush()).toEqual([])
  })

  it("another call's hook ends the held block first; turn/completed puts it before the result", () => {
    const m = mapper()
    m.notification(...hook('hook/completed', 'exec-1', 'blocked', [{ kind: 'feedback', text: 'one' }]))
    expect(kinds(m.notification(...hook('hook/started', 'exec-2', 'running')))).toEqual(['toolUse', 'toolResult'])
    m.notification(...hook('hook/completed', 'exec-2', 'blocked', [{ kind: 'feedback', text: 'two' }]))
    const end = m.notification('turn/completed', { threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed' } })
    expect(kinds(end)).toEqual(['toolUse', 'toolResult', 'entry', 'result'])
    expect(end[1]).toMatchObject({ toolUseId: 'exec-2', content: 'two', isError: true })
  })

  it('a block with no feedback text still says it was blocked; a long text is capped', () => {
    const m = mapper()
    m.notification(...hook('hook/completed', 'exec-1', 'blocked', [{ kind: 'error', text: 'ignored' }]))
    const [, res] = m.flush() as any[]
    expect(res).toMatchObject({ toolUseId: 'exec-1', isError: true, content: 'Blocked by a hook' })
    m.notification(...hook('hook/completed', 'exec-2', 'blocked', [{ kind: 'feedback', text: 'y'.repeat(CODEX_TOOL_OUTPUT_MAX + 5) }]))
    expect((m.flush()[1] as any).content.length).toBe(CODEX_TOOL_OUTPUT_MAX + '\n[output cut]'.length)
  })

  it('a run id without the source path still gives the tool_use_id after its last colon; one with none gives no row', () => {
    const m = mapper()
    m.notification('hook/completed', {
      threadId: 'thread-1',
      turnId: 't',
      run: { ...run('ignored', 'blocked', [{ kind: 'feedback', text: 'x' }]), id: 'pre-tool-use:0:elsewhere:call_9', sourcePath: null }
    })
    expect(m.flush()[0]).toMatchObject({ kind: 'toolUse', id: 'call_9' })
    m.notification('hook/completed', {
      threadId: 'thread-1',
      turnId: 't',
      run: { ...run('ignored', 'blocked', [{ kind: 'feedback', text: 'x' }]), id: null }
    })
    expect(m.flush()).toEqual([])
  })
})

// Codex names no model response, so the mapper does (R18): the pause's safety cap counts one round per response, as it
// counts Claude's calls by their API message id.
describe('CodexEventMapper response ids (the pause rounds)', () => {
  const SRC = '/<session-flags>/config.toml'
  const started = (type: string, id: string, threadId: string | null = 'thread-1') =>
    ['item/started', { ...(threadId === null ? {} : { threadId }), turnId: 'turn-1', item: { type, id } }] as const
  const exec = (id: string, threadId = 'thread-1') =>
    [
      'item/started',
      { threadId, turnId: 'turn-1', item: { type: 'commandExecution', id, command: 'ls', cwd: '/w', status: 'inProgress' } }
    ] as const
  const blockedHook = (toolUseId: string, threadId = 'thread-1') =>
    [
      'hook/completed',
      {
        threadId,
        turnId: 'turn-1',
        run: {
          id: `pre-tool-use:0:${SRC}:${toolUseId}`,
          eventName: 'preToolUse',
          sourcePath: SRC,
          source: 'sessionFlags',
          status: 'blocked',
          entries: [{ kind: 'feedback', text: 'PAUSED' }]
        }
      }
    ] as const
  const messageOf = (events: RunEvent[], id: string) =>
    (events.find((e) => e.kind === 'toolUse' && e.id === id) as Extract<RunEvent, { kind: 'toolUse' }> | undefined)?.message

  it('calls of one response share an id, blocked rows too; an agentMessage or reasoning item after them starts the next', () => {
    const m = mapper()
    const ev: RunEvent[] = []
    for (const [method, params] of [
      started('reasoning', 'rs_1'),
      exec('c1'),
      blockedHook('b2'),
      blockedHook('b3'),
      started('agentMessage', 'msg_2'),
      exec('c4'),
      blockedHook('b5'),
      started('reasoning', 'rs_3'),
      started('agentMessage', 'msg_3'),
      blockedHook('b6')
    ] as const)
      ev.push(...m.notification(method, params))
    ev.push(...m.flush())
    const ids = ['c1', 'b2', 'b3', 'c4', 'b5', 'b6'].map((id) => messageOf(ev, id))
    for (const id of ids) expect(id).toEqual(expect.any(String))
    // One response: a call that ran and two blocked parallel ones.
    expect(new Set(ids.slice(0, 3)).size).toBe(1)
    expect(ids[3]).toBe(ids[4])
    expect(new Set([ids[0], ids[3], ids[5]]).size).toBe(3)
    // Reasoning then a message, with no call between, is still one response.
    expect(ids[5]).not.toBe(ids[4])
  })

  it('a blocked row keeps the id of the response its block came in, even when it goes out as the next one starts', () => {
    const m = mapper()
    const first = m.notification(...exec('c1'))
    m.notification(...blockedHook('b2'))
    const next = m.notification(...started('reasoning', 'rs_2'))
    expect(kinds(next)).toEqual(['toolUse', 'toolResult'])
    expect(messageOf(next, 'b2')).toBe(messageOf(first, 'c1'))
    const after = m.notification(...exec('c3'))
    expect(messageOf(after, 'c3')).not.toBe(messageOf(next, 'b2'))
    // Held to the end of the process: the runner's last flush keeps it too.
    m.notification(...blockedHook('b4'))
    expect(messageOf(m.flush(), 'b4')).toBe(messageOf(after, 'c3'))
  })

  it("a child thread's reasoning or message never starts a response of the main thread", () => {
    const m = mapper()
    const ev = [
      ...m.notification(...exec('c1')),
      ...m.notification(...started('reasoning', 'rs_child', 'child-thread')),
      ...m.notification(...exec('c2'))
    ]
    expect(messageOf(ev, 'c2')).toBe(messageOf(ev, 'c1'))
    // A notice that names no thread is the main one's.
    const later = [...m.notification(...started('agentMessage', 'msg_2', null)), ...m.notification(...exec('c3'))]
    expect(messageOf(later, 'c3')).not.toBe(messageOf(ev, 'c1'))
  })

  it('a row whose item came with no start, and a new turn, follow the same rule', () => {
    const m = mapper()
    const first = m.notification('item/completed', {
      threadId: 'thread-1',
      item: { type: 'commandExecution', id: 'late', command: 'ls', cwd: '/w', status: 'completed', aggregatedOutput: '', exitCode: 0 }
    })
    expect(messageOf(first, 'late')).toEqual(expect.any(String))
    m.notification('turn/started', { threadId: 'thread-1', turn: { id: 'turn-2' } })
    const second = m.notification(...exec('c2'))
    expect(messageOf(second, 'c2')).not.toBe(messageOf(first, 'late'))
  })

  it("ids name the thread, so two threads' first responses never share one", () => {
    const a = mapper()
    const b = new CodexEventMapper()
    b.started('thread-2', null, null)
    expect(messageOf(a.notification(...exec('c1')), 'c1')).not.toBe(messageOf(b.notification(...exec('c1', 'thread-2')), 'c1'))
  })

  it('check 11 turn 2: three model requests of one call each, with only token usage between them, are three responses', () => {
    const { events } = replay('codex-check11.jsonl')
    // The blocked `touch blocked-marker`, then the exit 1 and the timeout calls: no reasoning or message between them.
    const ids = [
      'exec-7b42396a-f6ef-4d31-8492-df1da00963ae',
      'exec-0cc630f7-1914-4ebc-ae80-2736ed79aaa4',
      'exec-fb3ff833-5fff-4e66-a882-c333d0368512'
    ].map((id) => messageOf(events, id))
    for (const id of ids) expect(id).toEqual(expect.any(String))
    expect(new Set(ids).size).toBe(3)
  })

  it("the main thread's token usage after a call starts the next response; usage with no call since, or a child thread's, does not", () => {
    const m = mapper()
    const usage = (threadId: string) =>
      [
        'thread/tokenUsage/updated',
        { threadId, turnId: 'turn-1', tokenUsage: { total: tokens(10, 0, 1), last: tokens(10, 0, 1), modelContextWindow: 258400 } }
      ] as const
    const ev: RunEvent[] = []
    ev.push(...m.notification(...exec('c1')))
    m.notification(...blockedHook('b1'))
    ev.push(...m.notification(...usage('child-thread'))) // flushes b1; a child's request is not the main thread's
    ev.push(...m.notification(...exec('c2')))
    ev.push(...m.notification(...usage('thread-1')))
    ev.push(...m.notification(...exec('c3'))) // a request of a call alone, with no reasoning or message before it
    // Usage twice, then reasoning: one new response, not three.
    ev.push(
      ...m.notification(...usage('thread-1')),
      ...m.notification(...usage('thread-1')),
      ...m.notification(...started('reasoning', 'rs_9'))
    )
    ev.push(...m.notification(...exec('c4')))
    expect(['c1', 'b1', 'c2', 'c3', 'c4'].map((id) => messageOf(ev, id))).toEqual([
      'thread-1:response-0',
      'thread-1:response-0',
      'thread-1:response-0',
      'thread-1:response-1',
      'thread-1:response-2'
    ])
  })

  it('check 11: every row carries an id, and the blocked calls of two turns are two responses', () => {
    const { events } = replay('codex-check11.jsonl')
    const uses = events.filter((e) => e.kind === 'toolUse') as Extract<RunEvent, { kind: 'toolUse' }>[]
    expect(uses.length).toBeGreaterThan(2)
    for (const u of uses) expect(u.message).toEqual(expect.any(String))
    const blocked = uses.filter((u) => u.name === CODEX_BLOCKED_TOOL)
    expect(blocked).toHaveLength(2)
    expect(blocked[0].message).not.toBe(blocked[1].message)
  })
})

// Probe check 13: a subagent shows on the main thread only as `subAgentActivity` items (started, then completed), and its
// own work streams on the same connection under the child's thread id. R21 maps that to the Dispatched agents panel's events.
describe('CodexEventMapper subagents', () => {
  type Ev = RunEvent
  // One line per event, so a whole replay reads as a list; text and plan readings are checked on their own.
  const brief = (e: Ev): string => {
    switch (e.kind) {
      case 'toolUse':
        return `toolUse ${e.name} ${e.id}`
      case 'toolResult':
        return `toolResult ${e.toolUseId}${e.isError ? ' error' : ''}`
      case 'subToolUse':
        return `subToolUse ${e.parent} ${e.name} ${e.id} by ${e.subagent}`
      case 'subToolResult':
        return `subToolResult ${e.parent} ${e.toolUseId}${e.isError ? ' error' : ''}`
      case 'subText':
        return `subText ${e.parent}`
      case 'taskStarted':
        return `taskStarted ${e.toolUseId} ${e.taskId}`
      case 'taskProgress':
        return `taskProgress ${e.toolUseId} ${e.tokens}`
      case 'taskUpdated':
        return `taskUpdated ${e.taskId} ${e.status}`
      case 'permissionRequest':
        return `permissionRequest ${e.requestId} ${e.toolName}`
      case 'permissionCancel':
        return `permissionCancel ${e.requestId}`
      case 'result':
        return `result ${e.subtype}`
      default:
        return e.kind
    }
  }
  const outline = (events: Ev[]) => events.filter((e) => e.kind !== 'textDelta' && e.kind !== 'rateLimit' && e.kind !== 'spend').map(brief)
  const of = <K extends Ev['kind']>(events: Ev[], kind: K) => events.filter((e): e is Extract<Ev, { kind: K }> => e.kind === kind)

  describe('check 13 replay', () => {
    const MAIN = '01a1c286-c543-7260-be8f-934899d363e3'
    const ECHO = '01a1c286-db35-7a42-a12f-2c3554d3bebb',
      SLEEP = '01a1c287-11bb-7441-9d08-10a84cb3f26f'
    const SPAWN1 = 'call_de75ffe5063c492e9368dff9f65b6fb9',
      WAIT1 = 'call_ff5910801d014b72a38dde1560aa3762'
    const SPAWN2 = 'call_8cfd3d1e00ee4d128f8c61c60f4bfe4e',
      WAIT2 = 'call_24b57752646642adb4bb6b6a09a0ba67'
    const EXEC1 = 'exec-c49ae0a4-7bbb-45c6-ad20-04b4e390b470',
      EXEC2 = 'exec-e92e52b5-5398-486a-9372-6e678d999ce4'

    it('each spawn is an Agent dispatch, the child works under it, and its end hands back its last message', () => {
      const { events } = replay('codex-check13.jsonl')
      expect(outline(events)).toEqual([
        'init',
        // Turn 1: the main thread starts echo_child and waits for it.
        'assistantText',
        `toolUse Agent ${SPAWN1}`,
        `taskStarted ${SPAWN1} ${ECHO}`,
        'context',
        `toolUse Subagents ${WAIT1}`,
        `subText ${SPAWN1}`,
        `subToolUse ${SPAWN1} Bash ${EXEC1} by echo_child`,
        'permissionRequest 0 Bash',
        'permissionCancel 0',
        `subToolResult ${SPAWN1} ${EXEC1}`,
        `taskProgress ${SPAWN1} 17056`,
        `subText ${SPAWN1}`,
        `taskProgress ${SPAWN1} 34147`,
        `taskUpdated ${ECHO} completed`,
        `toolResult ${SPAWN1}`,
        `toolResult ${WAIT1}`,
        'context',
        'assistantText',
        'context',
        'entry',
        'result completed',
        // Turn 2: sleep_child is still in its approved `sleep 60` when the main turn is interrupted. Codex sends nothing more
        // for it, so its dispatch stays open (the recorder ends it at the turn's end).
        'assistantText',
        `toolUse Agent ${SPAWN2}`,
        `taskStarted ${SPAWN2} ${SLEEP}`,
        'context',
        `toolUse Subagents ${WAIT2}`,
        `subToolUse ${SPAWN2} Bash ${EXEC2} by sleep_child`,
        'permissionRequest 1 Bash',
        'permissionCancel 1',
        `taskProgress ${SPAWN2} 17283`,
        'context',
        'entry',
        'result interrupted'
      ])
      expect(of(events, 'toolUse').find((e) => e.id === SPAWN1)).toEqual({
        kind: 'toolUse',
        id: SPAWN1,
        name: 'Agent',
        input: { description: 'echo_child', subagent_type: 'codex' },
        message: expect.any(String)
      })
      expect(of(events, 'taskStarted')[0]).toEqual({
        kind: 'taskStarted',
        toolUseId: SPAWN1,
        taskId: ECHO,
        description: 'echo_child',
        subagentType: 'codex',
        prompt: null
      })
      expect(of(events, 'subToolUse')[0]).toEqual({
        kind: 'subToolUse',
        parent: SPAWN1,
        id: EXEC1,
        name: 'Bash',
        input: { command: "/bin/bash -lc 'echo child'", cwd: '/tmp/codex-probe-PRG8Hb/ws' },
        subagent: 'echo_child'
      })
      expect(of(events, 'subToolResult')[0]).toEqual({
        kind: 'subToolResult',
        parent: SPAWN1,
        toolUseId: EXEC1,
        content: 'child\n',
        isError: false
      })
      expect(of(events, 'subText').map((e) => e.text)).toEqual([
        'I’ll run `echo child` and report its output.\n',
        'The command printed `child`.'
      ])
      expect(of(events, 'taskUpdated')).toEqual([{ kind: 'taskUpdated', taskId: ECHO, status: 'completed', endTime: null }])
      // The report is the child's last message, as the Agent row's result and the dispatch's report.
      expect(of(events, 'toolResult').find((e) => e.toolUseId === SPAWN1)).toEqual({
        kind: 'toolResult',
        toolUseId: SPAWN1,
        content: 'The command printed `child`.',
        isError: false,
        detail: { content: 'The command printed `child`.' }
      })
      expect(of(events, 'toolUse').find((e) => e.id === WAIT1)).toMatchObject({ name: 'Subagents', input: { tool: 'wait' } })
      expect(of(events, 'toolResult').find((e) => e.toolUseId === WAIT1)).toMatchObject({ isError: false })
      // The child's card names it; the main thread asked for nothing.
      expect(of(events, 'permissionRequest').map((e) => [e.requestId, e.description, e.toolUseId, (e.input as any).command])).toEqual([
        ['0', 'From subagent echo_child', EXEC1, "/bin/bash -lc 'echo child'"],
        ['1', 'From subagent sleep_child', EXEC2, "/bin/bash -lc 'sleep 60'"]
      ])
    })

    it("the child's text, usage and turns never reach the main thread's reply, context or result; its tokens add to the turn's cost", () => {
      const { events } = replay('codex-check13.jsonl')
      // Only the main thread's deltas stream into the reply.
      expect(
        of(events, 'textDelta')
          .map((e) => e.text)
          .join('')
      ).toBe(
        'I’ll start one subagent to run `echo child` and wait for its report.\nThe command printed `child`.I’ll start one subagent to run `sleep 60`, then wait for its report.\n'
      )
      expect(of(events, 'assistantText').map((e) => e.text)).toEqual([
        'I’ll start one subagent to run `echo child` and wait for its report.\n',
        'The command printed `child`.',
        'I’ll start one subagent to run `sleep 60`, then wait for its report.\n'
      ])
      // Five main-thread token updates; the child's three are its dispatch's progress instead.
      expect(of(events, 'context').map((e) => e.tokens)).toEqual([14310 + 75, 14407 + 21, 14495 + 10, 16391 + 82, 16495 + 21])
      // One result per main turn (the child's turn/completed ends nothing).
      const results = of(events, 'result')
      expect(results.map((r) => [r.uuid, r.sessionId])).toEqual([
        ['01a1c286-c559-71c3-9f58-865dfe7d00f1', MAIN],
        ['01a1c287-012b-75d2-8e3f-cf9f0f81d766', MAIN]
      ])
      // The child's requests are paid for: turn 1 costs the main thread's three requests (43 212 in, 40 576 cached, 106 out)
      // plus echo_child's two (34 057 in, 31 104 cached, 90 out), both on gpt-6-astra.
      const turn1 = { input: 43212 + 34057, cachedInput: 40576 + 31104, output: 106 + 90 }
      expect(results[0].cost!.models).toEqual({
        'gpt-6-astra': {
          input: turn1.input - turn1.cachedInput,
          cacheRead: turn1.cachedInput,
          cacheWrite: 0,
          output: turn1.output,
          costUsd: priceCodex('gpt-6-astra', turn1)
        }
      })
      expect(results[0].cost!.totalUsd).toBeCloseTo(priceCodex('gpt-6-astra', turn1)!, 9)
      // Turn 2 starts its own sums: the main thread's two requests and sleep_child's one, nothing of turn 1.
      const turn2 = { input: 16391 + 16495 + 17249, cachedInput: 12160 + 16256 + 16256, output: 82 + 21 + 34 }
      expect(results[1].cost!.models['gpt-6-astra']).toMatchObject({
        input: turn2.input - turn2.cachedInput,
        cacheRead: turn2.cachedInput,
        output: turn2.output
      })
    })

    it('the main thread keeps one response per model request: the spawn and the wait are separate rounds', () => {
      const { events } = replay('codex-check13.jsonl')
      const uses = of(events, 'toolUse')
      const msg = (id: string) => uses.find((u) => u.id === id)?.message
      expect(new Set([msg(SPAWN1), msg(WAIT1), msg(SPAWN2), msg(WAIT2)]).size).toBe(4)
      expect(msg(SPAWN1)).toMatch(new RegExp(`^${MAIN}:response-`))
    })
  })

  describe('check 11 subagent run replay', () => {
    const SPAWN = 'call_c4cd611a1fbf4264bdbd3f7acd32900e',
      WAIT = 'call_d2272b4df1b641d98e1842139d1467b8'
    const CHILD = '01a1c285-a1ad-7381-9eae-2bdb255a1e3f'
    const MAIN_EXEC = 'exec-2ba3c40c-30f6-4838-876a-16c826b43927',
      SUB_EXEC = 'exec-253422a4-7583-4865-b368-9ae2821967cf'

    it("the main thread's own call stays a main row, the child's goes under its dispatch, and passing hooks add nothing", () => {
      const { events } = replay('codex-check11-subagent.jsonl')
      expect(outline(events)).toEqual([
        'init',
        'assistantText',
        `toolUse Bash ${MAIN_EXEC}`,
        `toolResult ${MAIN_EXEC}`,
        'context',
        `toolUse Agent ${SPAWN}`,
        `taskStarted ${SPAWN} ${CHILD}`,
        'context',
        `toolUse Subagents ${WAIT}`,
        `subToolUse ${SPAWN} Bash ${SUB_EXEC} by echo_sub`,
        `subToolResult ${SPAWN} ${SUB_EXEC}`,
        `taskProgress ${SPAWN} 15538`,
        `subText ${SPAWN}`,
        `taskProgress ${SPAWN} 31110`,
        `taskUpdated ${CHILD} completed`,
        `toolResult ${SPAWN}`,
        `toolResult ${WAIT}`,
        'context',
        'assistantText',
        'context',
        'entry',
        'result completed'
      ])
      expect(of(events, 'toolResult').find((e) => e.toolUseId === SPAWN)).toMatchObject({ content: 'It printed `sub`.', isError: false })
      expect(of(events, 'subToolResult')[0]).toMatchObject({ toolUseId: SUB_EXEC, content: 'sub\n', isError: false })
      // The main exec, the spawn and the wait are three model requests, with the main thread's usage between them.
      const uses = of(events, 'toolUse')
      expect(new Set(uses.map((u) => u.message)).size).toBe(3)
    })
  })

  // A subagent named `helper` on thread `c1`, started by the main thread's item `sp1`.
  const SRC = '/<session-flags>/config.toml'
  const activity = (
    method: 'item/started' | 'item/completed',
    kind: string,
    agentThreadId: string,
    agentPath: string,
    id: string,
    threadId = 'thread-1',
    model: string | null = null
  ) =>
    [
      method,
      { threadId, turnId: 'turn-1', item: { type: 'subAgentActivity', model, reasoningEffort: null, id, kind, agentThreadId, agentPath } }
    ] as const
  const spawned = () => {
    const m = mapper()
    const ev = [
      ...m.notification(...activity('item/started', 'started', 'c1', '/root/helper', 'sp1')),
      ...m.notification(...activity('item/completed', 'started', 'c1', '/root/helper', 'sp1'))
    ]
    return { m, ev }
  }
  const childItem = (method: 'item/started' | 'item/completed', item: Record<string, unknown>, threadId = 'c1') =>
    [method, { threadId, turnId: 'ct-1', item }] as const
  const blockedHook = (threadId: string, toolUseId: string, text: string) =>
    [
      'hook/completed',
      {
        threadId,
        turnId: 'ct-1',
        run: {
          id: `pre-tool-use:0:${SRC}:${toolUseId}`,
          eventName: 'preToolUse',
          sourcePath: SRC,
          source: 'sessionFlags',
          status: 'blocked',
          entries: [{ kind: 'feedback', text }]
        }
      }
    ] as const

  it('a started item is the dispatch once: its completed echo and a second start of the same thread add nothing', () => {
    const { m, ev } = spawned()
    expect(ev.map(brief)).toEqual(['toolUse Agent sp1', 'taskStarted sp1 c1'])
    expect(m.notification(...activity('item/started', 'started', 'c1', '/root/helper', 'sp1-again'))).toEqual([])
    // A start naming no child thread dispatches nothing.
    expect(
      m.notification('item/started', {
        threadId: 'thread-1',
        item: { type: 'subAgentActivity', id: 'sp9', kind: 'started', agentPath: '/root/x' }
      })
    ).toEqual([])
  })

  it.each([false, true])(
    'reactivates an announced child and nested child once, with fresh reports (activity first: %s)',
    (activityFirst) => {
      const { m, ev } = spawned()
      const rec = new DispatchRecorder({ turn: 'main', now: () => 1, onChange: () => {}, privateTool: () => null })
      const feed = (events: RunEvent[]) => events.forEach((e) => rec.event(e))
      feed(ev)
      for (const [thread, parent, id, path] of [
        ['c1', 'thread-1', 'sp1', '/root/helper'],
        ['g1', 'c1', 'sp2', '/root/helper/grand']
      ]) {
        if (thread === 'g1') feed(m.notification(...activity('item/started', 'started', thread, path, id, parent)))
        feed(m.notification('turn/started', { threadId: thread, turn: { id: `${thread}-one` } }))
        feed(
          m.notification('thread/tokenUsage/updated', {
            threadId: thread,
            turnId: `${thread}-one`,
            tokenUsage: { last: { inputTokens: 10 } }
          })
        )
        feed(m.notification(...childItem('item/completed', { type: 'agentMessage', id: 'old', text: 'old report' }, thread)))
        const end = activity('item/started', 'completed', thread, path, `subagent-completed-${thread}-one`, parent)
        feed(m.notification(...end))
        expect(rec.entries().find((e) => e.id === id)).toMatchObject({ status: 'done', report: 'old report' })
        const start = activity('item/started', 'started', thread, path, `${id}-again`, parent)
        const turn = ['turn/started', { threadId: thread, turn: { id: `${thread}-two` } }] as const
        const first = activityFirst ? start : turn
        feed(m.notification(first[0], first[1]))
        expect(rec.entries().find((e) => e.id === id)).toMatchObject({ status: 'running', report: null, endedAt: null })
        feed(m.notification(...childItem('item/completed', { type: 'agentMessage', id: 'new', text: 'current report' }, thread)))
        const second = activityFirst ? turn : start
        feed(m.notification(second[0], second[1]))
        feed(
          m.notification('thread/tokenUsage/updated', {
            threadId: thread,
            turnId: `${thread}-two`,
            tokenUsage: { last: { inputTokens: 20 } }
          })
        )
        // Duplicate/late starts and completion echoes cannot clear the current report or close this task.
        feed(m.notification('turn/started', { threadId: thread, turn: { id: `${thread}-one` } }))
        feed(m.notification(...activity('item/completed', 'completed', thread, path, `subagent-completed-${thread}-one`, parent)))
        feed(m.notification(...activity('item/started', 'interrupted', thread, path, `subagent-interrupted-${thread}-one`, parent)))
        feed(
          m.notification('item/completed', {
            threadId: thread,
            turnId: `${thread}-one`,
            item: { type: 'agentMessage', id: 'late-report', text: 'stale' }
          })
        )
        feed(
          m.notification('thread/tokenUsage/updated', {
            threadId: thread,
            turnId: `${thread}-one`,
            tokenUsage: { last: { inputTokens: 5 } }
          })
        )
        expect(rec.entries().find((e) => e.id === id)?.status).toBe('running')
        feed(m.notification(...activity('item/started', 'completed', thread, path, `subagent-completed-${thread}-two`, parent)))
        expect(rec.entries().find((e) => e.id === id)).toMatchObject({ status: 'done', report: 'current report' })
        feed(m.notification(...turn))
        feed(m.notification(...activity('item/completed', 'started', thread, path, `${id}-again`, parent)))
        expect(rec.entries().find((e) => e.id === id)).toMatchObject({ status: 'done', report: 'current report' })
      }
      expect(rec.entries()).toHaveLength(2)
      const result = m
        .notification('turn/completed', { threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed' } })
        .find((e) => e.kind === 'result')
      expect(result?.cost?.models?.['gpt-6-astra'].input).toBe(70)
    }
  )

  it("a child's reasoning shows nowhere: not as the agent's thinking, nor under its dispatch", () => {
    const { m } = spawned()
    expect(
      m.notification('item/reasoning/summaryTextDelta', { threadId: 'c1', turnId: 'ct-1', itemId: 'cr', summaryIndex: 0, delta: 'Hmm' })
    ).toEqual([])
    expect(m.notification('item/reasoning/summaryPartAdded', { threadId: 'c1', turnId: 'ct-1', itemId: 'cr', summaryIndex: 1 })).toEqual([])
    expect(m.notification(...childItem('item/started', { type: 'reasoning', id: 'cr' }))).toEqual([])
    expect(m.notification(...childItem('item/completed', { type: 'reasoning', id: 'cr', summary: ['Hmm'] }))).toEqual([])
  })

  it("a child's agent message is a sub text, its deltas stream nowhere, and its last message is the report", () => {
    const { m } = spawned()
    expect(m.notification('item/agentMessage/delta', { threadId: 'c1', turnId: 'ct-1', itemId: 'cm', delta: 'Wor' })).toEqual([])
    expect(m.notification(...childItem('item/completed', { type: 'agentMessage', id: 'cm1', text: 'Working.' }))).toEqual([
      { kind: 'subText', parent: 'sp1', text: 'Working.' }
    ])
    m.notification(...childItem('item/completed', { type: 'agentMessage', id: 'cm2', text: 'Done: 3 files.' }))
    const end = m.notification(...activity('item/started', 'completed', 'c1', '/root/helper', 'subagent-completed-ct-1'))
    expect(end).toEqual([
      { kind: 'taskUpdated', taskId: 'c1', status: 'completed', endTime: null },
      { kind: 'toolResult', toolUseId: 'sp1', content: 'Done: 3 files.', isError: false, detail: { content: 'Done: 3 files.' } }
    ])
    // Its completed echo, and the child's own turn end, change nothing.
    expect(m.notification(...activity('item/completed', 'completed', 'c1', '/root/helper', 'subagent-completed-ct-1'))).toEqual([])
    expect(m.notification('turn/completed', { threadId: 'c1', turn: { id: 'ct-1', status: 'completed' } })).toEqual([])
  })

  it('an interrupted child is cut off (its dispatch ends interrupted, its result an error); one with no message gets a fixed sentence', () => {
    const { m } = spawned()
    expect(m.notification(...activity('item/started', 'interrupted', 'c1', '/root/helper', 'subagent-interrupted-1'))).toEqual([
      { kind: 'taskUpdated', taskId: 'c1', status: 'interrupted', endTime: null, cut: true },
      { kind: 'toolResult', toolUseId: 'sp1', content: 'The subagent was interrupted before it reported.', isError: true }
    ])
    const n = mapper()
    n.notification(...activity('item/started', 'started', 'c2', '/root/quiet', 'sp2'))
    expect(n.notification(...activity('item/started', 'completed', 'c2', '/root/quiet', 'end-2')).at(-1)).toEqual({
      kind: 'toolResult',
      toolUseId: 'sp2',
      content: 'The subagent finished without a report.',
      isError: false
    })
    // An end for a child never started ends nothing.
    expect(n.notification(...activity('item/started', 'completed', 'c9', '/root/ghost', 'end-9'))).toEqual([])
  })

  it("a child's tool calls are sub rows labelled with its name; a patch keeps its changes for the Files panel", () => {
    const { m } = spawned()
    const change = { path: '/w/a.txt', kind: { type: 'add' }, diff: 'hello\n' }
    expect(m.notification(...childItem('item/started', { type: 'fileChange', id: 'p1', status: 'inProgress', changes: [change] }))).toEqual(
      [
        {
          kind: 'subToolUse',
          parent: 'sp1',
          id: 'p1',
          name: 'ApplyPatch',
          input: { changes: [{ path: '/w/a.txt', kind: 'add' }] },
          subagent: 'helper'
        }
      ]
    )
    // Its approval card reads the changes the child's item carried, and names the child.
    const card = m.serverRequest(4, 'item/fileChange/requestApproval', {
      threadId: 'c1',
      turnId: 'ct-1',
      itemId: 'p1',
      reason: null,
      grantRoot: null
    }).events[0] as any
    expect(card).toMatchObject({
      kind: 'permissionRequest',
      requestId: '4',
      toolName: 'ApplyPatch',
      description: 'From subagent helper',
      toolUseId: 'p1'
    })
    expect(card.input.changes).toEqual([{ path: '/w/a.txt', kind: 'add', diff: 'hello\n' }])
    expect(
      m.notification(...childItem('item/completed', { type: 'fileChange', id: 'p1', status: 'completed', changes: [change] }))
    ).toEqual([
      {
        kind: 'subToolResult',
        parent: 'sp1',
        toolUseId: 'p1',
        content: 'add /w/a.txt',
        isError: false,
        detail: { codexChanges: [{ path: '/w/a.txt', kind: 'add', movePath: null, diff: 'hello\n' }] }
      }
    ])
    // An item that ends with no start still gets its sub row first; MCP calls follow the main thread's naming.
    expect(
      m
        .notification(
          ...childItem('item/completed', {
            type: 'mcpToolCall',
            id: 'mc1',
            server: 'zumibot_todos',
            tool: 'list',
            arguments: {},
            status: 'completed',
            result: { content: [{ type: 'text', text: 'none' }] }
          })
        )
        .map(brief)
    ).toEqual(['subToolUse sp1 mcp__zumibot_todos__list mc1 by helper', 'subToolResult sp1 mc1'])
    // Nothing of it is a main row.
    expect(m.flush()).toEqual([])
  })

  it('a main request names no subagent, as before', () => {
    const { m } = spawned()
    expect(
      m.serverRequest(5, 'item/commandExecution/requestApproval', {
        threadId: 'thread-1',
        turnId: 'turn-1',
        itemId: 'e1',
        command: 'ls',
        cwd: '/w'
      }).events[0]
    ).toMatchObject({ description: null })
  })

  it("a child's blocked call is a Blocked sub row with the hook's text; the main thread's pause rounds never see it", () => {
    const { m } = spawned()
    expect(m.notification(...blockedHook('c1', 'exec-x', 'VAULT'))).toEqual([])
    expect(m.notification(...blockedHook('c1', 'exec-x', 'AGAIN'))).toEqual([])
    const out = m.notification(...childItem('item/started', { type: 'reasoning', id: 'rs' }))
    expect(out).toEqual([
      { kind: 'subToolUse', parent: 'sp1', id: 'exec-x', name: CODEX_BLOCKED_TOOL, input: {}, subagent: 'helper' },
      { kind: 'subToolResult', parent: 'sp1', toolUseId: 'exec-x', content: 'VAULT\nAGAIN', isError: true }
    ])
    // Held to the end of the process too.
    m.notification(...blockedHook('c1', 'exec-y', 'LAST'))
    expect(m.flush().map(brief)).toEqual(['subToolUse sp1 Blocked exec-y by helper', 'subToolResult sp1 exec-y error'])
    // A thread nobody started is still left alone.
    m.notification(...blockedHook('stranger', 'exec-z', 'X'))
    expect(m.flush()).toEqual([])
  })

  it("a child's token usage is its dispatch's progress, counting its calls, and adds to the turn's cost; never the main context", () => {
    const { m } = spawned()
    m.notification(...childItem('item/started', { type: 'commandExecution', id: 'e1', command: 'ls', cwd: '/w', status: 'inProgress' }))
    m.notification(...childItem('item/started', { type: 'commandExecution', id: 'e2', command: 'pwd', cwd: '/w', status: 'inProgress' }))
    // Its request is priced for the spend caps too, before its progress.
    expect(
      m.notification('thread/tokenUsage/updated', {
        threadId: 'c1',
        turnId: 'ct-1',
        tokenUsage: { total: tokens(900, 0, 100), last: tokens(900, 0, 100), modelContextWindow: 258400 }
      })
    ).toEqual([
      { kind: 'spend', id: 'codex:1', usd: priceCodex('gpt-6-astra', { input: 900, cachedInput: 0, output: 100 }) },
      { kind: 'taskProgress', toolUseId: 'sp1', description: null, tokens: 1000, toolUses: 2, durationMs: null }
    ])
    // Its turn starting resets nothing of the main turn's sums, and the main context is the main thread's request alone.
    expect(m.notification('thread/tokenUsage/updated', usage(tokens(100, 0, 10))).filter((e) => e.kind !== 'spend')).toEqual([
      { kind: 'context', model: 'gpt-6-astra', tokens: 110 }
    ])
    m.notification('turn/started', { threadId: 'c1', turn: { id: 'ct-2' } })
    m.notification('error', {
      threadId: 'c1',
      turnId: 'ct-2',
      error: { message: 'child failed', codexErrorInfo: 'other' },
      willRetry: false
    })
    // A started activity that names no model: the child is priced as the main thread's model.
    const res = m.notification('turn/completed', { threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed' } }).at(-1) as any
    expect(res.cost.models).toEqual({
      'gpt-6-astra': {
        input: 1000,
        cacheRead: 0,
        cacheWrite: 0,
        output: 110,
        costUsd: priceCodex('gpt-6-astra', { input: 1000, cachedInput: 0, output: 110 })
      }
    })
    expect(m.lastError).toBeNull()
  })

  it('a child on another model is priced on it; the next main turn starts the sums again; a turn only children spent in still has a cost', () => {
    const m = mapper()
    m.notification(...activity('item/started', 'started', 'c1', '/root/cheap', 'sp1', 'thread-1', 'gpt-6-luna'))
    m.notification('thread/tokenUsage/updated', usage(tokens(1000, 400, 50)))
    m.notification('thread/tokenUsage/updated', {
      threadId: 'c1',
      turnId: 'ct-1',
      tokenUsage: { total: tokens(2000, 1000, 100), last: tokens(2000, 1000, 100), modelContextWindow: 258400 }
    })
    const one = (m.notification('turn/completed', { threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed' } }).at(-1) as any).cost
    const main = priceCodex('gpt-6-astra', { input: 1000, cachedInput: 400, output: 50 })!,
      luna = priceCodex('gpt-6-luna', { input: 2000, cachedInput: 1000, output: 100 })!
    expect(one.models).toEqual({
      'gpt-6-astra': { input: 600, cacheRead: 400, cacheWrite: 0, output: 50, costUsd: main },
      'gpt-6-luna': { input: 1000, cacheRead: 1000, cacheWrite: 0, output: 100, costUsd: luna }
    })
    expect(one.totalUsd).toBeCloseTo(main + luna, 12)
    // The next main turn: the child spends again, the main thread reports nothing.
    m.notification('turn/started', { threadId: 'thread-1', turn: { id: 'turn-2' } })
    m.notification('thread/tokenUsage/updated', {
      threadId: 'c1',
      turnId: 'ct-2',
      tokenUsage: { total: tokens(2500, 1000, 110), last: tokens(500, 0, 10), modelContextWindow: 258400 }
    })
    const two = (m.notification('turn/completed', { threadId: 'thread-1', turn: { id: 'turn-2', status: 'completed' } }).at(-1) as any).cost
    expect(two.models).toEqual({
      'gpt-6-luna': {
        input: 500,
        cacheRead: 0,
        cacheWrite: 0,
        output: 10,
        costUsd: priceCodex('gpt-6-luna', { input: 500, cachedInput: 0, output: 10 })
      }
    })
  })

  // R23: with subagents on, a thread can talk that this process never saw start (a child resumed in a later process, say).
  // Taken as the main thread's, it would put its rows, text, context and cost in the chat; it is dropped instead.
  it('a notice naming a thread no start announced is dropped once the main thread is known; serverRequest/resolved still passes', () => {
    const m = mapper()
    m.notification('thread/tokenUsage/updated', usage(tokens(100, 0, 10)))
    const card = m.serverRequest(7, 'item/commandExecution/requestApproval', {
      threadId: 'thread-1',
      itemId: 'e7',
      command: 'ls',
      cwd: '/w'
    })
    expect(card.events).toHaveLength(1)
    for (const [method, params] of [
      [
        'item/started',
        { threadId: 'stranger', item: { type: 'commandExecution', id: 'x1', command: 'ls', cwd: '/w', status: 'inProgress' } }
      ],
      [
        'item/completed',
        {
          threadId: 'stranger',
          item: { type: 'commandExecution', id: 'x1', command: 'ls', cwd: '/w', status: 'completed', aggregatedOutput: 'a', exitCode: 0 }
        }
      ],
      ['item/agentMessage/delta', { threadId: 'stranger', turnId: 'x', itemId: 'sm', delta: 'hi' }],
      ['item/completed', { threadId: 'stranger', item: { type: 'agentMessage', id: 'sm', text: 'hi' } }],
      [
        'item/started',
        { threadId: 'stranger', item: { type: 'subAgentActivity', id: 'sa', kind: 'started', agentThreadId: 'g', agentPath: '/root/g' } }
      ],
      ['thread/tokenUsage/updated', { ...usage(tokens(5000, 0, 500)), threadId: 'stranger' }],
      [
        'error',
        { threadId: 'stranger', turnId: 'x', error: { message: 'stranger failed', codexErrorInfo: 'usageLimitExceeded' }, willRetry: false }
      ],
      ['thread/compacted', { threadId: 'stranger', turnId: 'x' }],
      ['turn/started', { threadId: 'stranger', turn: { id: 'x' } }],
      ['turn/completed', { threadId: 'stranger', turn: { id: 'x', status: 'failed', error: { message: 'stranger failed' } } }]
    ] as [string, any][])
      expect(m.notification(method, params), method).toEqual([])
    expect(m.lastError).toBeNull()
    // Request ids are the process's: a resolved notice naming any thread still settles the card.
    expect(m.notification('serverRequest/resolved', { threadId: 'stranger', requestId: 7 })).toEqual([
      { kind: 'permissionCancel', requestId: '7' }
    ])
    const res = m.notification('turn/completed', { threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed' } })
    expect(kinds(res)).toEqual(['entry', 'result'])
    expect((res[1] as any).cost.models['gpt-6-astra']).toMatchObject({ input: 100, cacheRead: 0, output: 10 })
    // Before the main thread is known, nothing is anyone else's yet: notices map as before.
    expect(new CodexEventMapper().notification('item/agentMessage/delta', { threadId: 'early', delta: 'x' })).toEqual([
      { kind: 'textDelta', text: 'x' }
    ])
  })

  it('a request from a thread no start announced is declined at once with no card, whatever it asks', () => {
    const m = mapper()
    const asked = {
      threadId: 'stranger',
      turnId: 'x',
      itemId: 'x1',
      command: 'rm -rf /w',
      cwd: '/w',
      permissions: {},
      questions: [{ id: 'q', question: 'Which?', header: 'h', options: [] }],
      serverName: 'probe',
      message: 'Allow the probe MCP server to run tool "probe_echo"?',
      _meta: { codex_approval_kind: 'mcp_tool_call', tool_params: {} }
    }
    m.notification('item/started', {
      threadId: 'thread-1',
      item: { type: 'fileChange', id: 'x1', status: 'inProgress', changes: [{ path: '/w/a', kind: { type: 'add' }, diff: 'x' }] }
    })
    expect(
      [
        'item/commandExecution/requestApproval',
        'item/fileChange/requestApproval',
        'item/permissions/requestApproval',
        'mcpServer/elicitation/request',
        'item/tool/requestUserInput',
        'item/unknown/request'
      ].map((method, i) => m.serverRequest(i, method, asked))
    ).toEqual([
      { kind: 'command', events: [] },
      { kind: 'fileChange', events: [] },
      { kind: 'permissions', events: [] },
      { kind: 'elicitation', events: [] },
      { kind: 'userInput', events: [] },
      { kind: null, events: [] }
    ])
    // Nothing was left open for a resolved notice to cancel.
    expect(m.notification('serverRequest/resolved', { threadId: 'stranger', requestId: 0 })).toEqual([])
  })

  it("an MCP approval names only a running call of the thread that asked: the main thread's and a child's calls of one tool never mix", () => {
    const { m } = spawned()
    const mcp = (threadId: string, id: string) =>
      [
        'item/started',
        {
          threadId,
          turnId: 't',
          item: { type: 'mcpToolCall', id, server: 'probe', tool: 'probe_echo', status: 'inProgress', arguments: {} }
        }
      ] as const
    const ask = (threadId: string, quoted: boolean) => ({
      threadId,
      turnId: 't',
      serverName: 'probe',
      mode: 'form',
      message: quoted ? 'Allow the probe MCP server to run tool "probe_echo"?' : 'Allow the probe MCP server?',
      _meta: { codex_approval_kind: 'mcp_tool_call', tool_params: { text: 'hi' } }
    })
    m.notification(...mcp('c1', 'child-call'))
    m.notification(...mcp('thread-1', 'main-call'))
    expect(m.serverRequest(0, 'mcpServer/elicitation/request', ask('thread-1', true)).events[0]).toMatchObject({
      toolUseId: 'main-call',
      description: null
    })
    expect(m.serverRequest(1, 'mcpServer/elicitation/request', ask('c1', true)).events[0]).toMatchObject({
      toolUseId: 'child-call',
      description: 'From subagent helper'
    })
    // Unquoted, each thread's one running call of the server is no guess.
    expect(m.serverRequest(2, 'mcpServer/elicitation/request', ask('c1', false)).events[0]).toMatchObject({
      toolName: 'mcp__probe__probe_echo',
      toolUseId: 'child-call'
    })
  })

  it('collab calls other than a spawn are plain Subagents rows naming the children they reach', () => {
    const { m } = spawned()
    const item = {
      type: 'collabAgentToolCall',
      id: 'cb1',
      tool: 'sendInput',
      status: 'inProgress',
      senderThreadId: 'thread-1',
      receiverThreadIds: ['c1', 'c-unknown'],
      prompt: 'Also check b.txt',
      model: null,
      reasoningEffort: null,
      agentsStates: {}
    }
    expect(m.notification('item/started', { threadId: 'thread-1', turnId: 'turn-1', item })).toEqual([
      {
        kind: 'toolUse',
        id: 'cb1',
        name: 'Subagents',
        input: { tool: 'sendInput', agents: ['helper', 'c-unknown'], prompt: 'Also check b.txt' },
        message: expect.any(String)
      }
    ])
    expect(
      m.notification('item/completed', {
        threadId: 'thread-1',
        turnId: 'turn-1',
        item: { ...item, status: 'completed', agentsStates: { c1: { status: 'running' } } }
      })
    ).toEqual([{ kind: 'toolResult', toolUseId: 'cb1', content: 'helper: running', isError: false }])
    expect(
      m
        .notification('item/completed', {
          threadId: 'thread-1',
          turnId: 'turn-1',
          item: { ...item, id: 'cb2', tool: 'closeAgent', prompt: null, receiverThreadIds: [], status: 'failed' }
        })
        .map(brief)
    ).toEqual(['toolUse Subagents cb2', 'toolResult cb2 error'])
  })

  it("a child's own subagent nests under the child's dispatch, and its end hands its report up there", () => {
    const { m } = spawned()
    expect(m.notification(...activity('item/started', 'started', 'g1', '/root/helper/grand', 'sp2', 'c1'))).toEqual([
      {
        kind: 'subToolUse',
        parent: 'sp1',
        id: 'sp2',
        name: 'Agent',
        input: { description: 'grand', subagent_type: 'codex' },
        subagent: 'helper'
      },
      { kind: 'taskStarted', toolUseId: 'sp2', taskId: 'g1', description: 'grand', subagentType: 'codex', prompt: null }
    ])
    expect(
      m
        .notification(
          ...childItem('item/started', { type: 'commandExecution', id: 'ge', command: 'ls', cwd: '/w', status: 'inProgress' }, 'g1')
        )
        .map(brief)
    ).toEqual(['subToolUse sp2 Bash ge by grand'])
    m.notification(...childItem('item/completed', { type: 'agentMessage', id: 'gm', text: 'grand done' }, 'g1'))
    expect(m.notification(...activity('item/started', 'completed', 'g1', '/root/helper/grand', 'end-g', 'c1'))).toEqual([
      { kind: 'taskUpdated', taskId: 'g1', status: 'completed', endTime: null },
      { kind: 'subToolResult', parent: 'sp1', toolUseId: 'sp2', content: 'grand done', isError: false, detail: { content: 'grand done' } }
    ])
    // The grandchild's text was its own step, not its parent's report.
    m.notification(...childItem('item/completed', { type: 'agentMessage', id: 'cm', text: 'helper done' }))
    expect(m.notification(...activity('item/started', 'completed', 'c1', '/root/helper', 'end-c')).at(-1)).toMatchObject({
      toolUseId: 'sp1',
      content: 'helper done'
    })
  })

  it('a path with no name still labels the subagent', () => {
    const m = mapper()
    expect(m.notification(...activity('item/started', 'started', 'c3', '/', 'sp3'))[0]).toMatchObject({
      input: { description: 'subagent', subagent_type: 'codex' }
    })
  })
})
