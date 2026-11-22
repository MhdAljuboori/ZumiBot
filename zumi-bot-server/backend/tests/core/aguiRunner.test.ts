import { afterEach, describe, expect, it, vi } from 'vitest'
import { AGUI_TEXT, type AguiThread } from '@zumibot/shared/agui'
import { QUESTION_TOOL } from '@zumibot/shared/questions'
import { startAgui, type AguiRunOptions } from '../../src/core/agui/aguiRunner'
import { AGUI_TOOL } from '../../src/core/agui/aguiEvents'
import type { AguiMessage } from '../../src/core/agui/aguiMessages'
import { allowResponse, denyResponse } from '../../src/core/chat/controlProtocol'
import type { RunEvent } from '../../src/core/chat/streamParser'
import type { RunHandle } from '../../src/core/engines/engine'
import { startFakeAgui, stopFakeAgui, type AguiStep, type FakeAgui } from '../support/fakeAgui'

afterEach(async () => {
  await stopFakeAgui()
  vi.restoreAllMocks()
})

const KEY = 'sk-live-7f3a9c'
const THREAD = '11111111-2222-4333-8444-555555555555'
const MESSAGES: AguiMessage[] = [{ id: 'u1', role: 'user', content: 'Find the docs' }]
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

type Opts = Partial<AguiRunOptions> & { react?: (e: RunEvent, h: RunHandle) => void }
function run(f: FakeAgui, o: Opts = {}) {
  const events: RunEvent[] = []
  const threads: AguiThread[] = []
  const { react, ...rest } = o
  let h: RunHandle | null = null
  h = startAgui({
    endpoint: f.url,
    headers: { Authorization: `Bearer ${KEY}` },
    authKey: 'AGENT_KEY',
    threadId: THREAD,
    messages: MESSAGES,
    thread: null,
    onThread: (t) => {
      threads.push(structuredClone(t))
    },
    requestTag: 'tag-1',
    allowLocal: true,
    onEvent: (e) => {
      events.push(e)
      react?.(e, h!)
    },
    ...rest
  })
  return { h, events, threads }
}
const fake = (...requests: AguiStep[][]) => startFakeAgui(requests)
const kinds = (events: RunEvent[]) => events.map((e) => e.kind)
const of = <K extends RunEvent['kind']>(events: RunEvent[], kind: K) =>
  events.filter((e): e is Extract<RunEvent, { kind: K }> => e.kind === kind)
const silenceLog = () => vi.spyOn(console, 'error').mockImplementation(() => {})

// An interrupt whose schema maps as a question card: one yes/no question.
const approval = (id: string, extra: object = {}) => ({
  id,
  reason: 'tool_approval',
  message: 'Run the deploy?',
  responseSchema: { type: 'object', properties: { approved: { type: 'boolean', title: 'Approve' } }, required: ['approved'] },
  ...extra
})
const interrupt = (...interrupts: object[]): AguiStep => ({ finish: { outcome: { type: 'interrupt', interrupts } } })
// The card's answer as ChatService sends it: the input the run gave, with the answers by question text.
const answer = (req: Extract<RunEvent, { kind: 'permissionRequest' }>, answers: Record<string, string>) =>
  allowResponse(req.requestId, { ...(req.input as object), answers })

async function waitFor(ok: () => boolean, ms = 3000): Promise<void> {
  for (const end = Date.now() + ms; Date.now() < end;) {
    if (ok()) return
    await new Promise((r) => setTimeout(r, 15))
  }
  expect(ok()).toBe(true)
}

describe('startAgui: a turn', () => {
  it('streams text, reasoning and a remote tool row with its result, then ends in one result', async () => {
    const f = await fake([
      { reasoning: 'Thinking it over' },
      { text: 'Searching.', id: 'm1' },
      { tool: { id: 'call_1', name: 'search', args: { q: 'docs' }, result: 'Found 3', parent: 'm1' } },
      { text: 'Done.' },
      { finish: {} }
    ])
    const { h, events } = run(f)
    const out = await h.done
    expect(out).toMatchObject({ stderr: '', spawnError: null, stopped: false, exitCode: null, signal: null })
    expect(out.missingSession).toBeUndefined()
    expect(kinds(events)).toEqual([
      'init',
      'entry',
      'thinkingDelta',
      'thinking',
      'textDelta',
      'assistantText',
      'toolUse',
      'toolResult',
      'textDelta',
      'assistantText',
      'result'
    ])
    expect(events[0]).toEqual({ kind: 'init', sessionId: THREAD })
    expect(of(events, 'thinking')[0].text).toBe('Thinking it over')
    expect(of(events, 'toolUse')[0]).toEqual({
      kind: 'toolUse',
      id: 'tag-1:call_1',
      name: AGUI_TOOL,
      input: { tool: 'search', args: { q: 'docs' } }
    })
    expect(of(events, 'toolResult')[0]).toEqual({ kind: 'toolResult', toolUseId: 'tag-1:call_1', content: 'Found 3', isError: false })
    const result = of(events, 'result')[0]
    expect(result).toMatchObject({ subtype: 'success', isError: false, sessionId: THREAD, denials: [], windows: {}, cost: null })
    expect(out.result).toEqual(result)
    expect(kinds(events)).not.toContain('context')
  })

  it('sends a RunAgentInput of AG-UI 1.0 with nothing local in it', async () => {
    const f = await fake([{ finish: {} }])
    await run(f).h.done
    const [req] = f.requests()
    expect(Object.keys(req.body).sort()).toEqual([
      'context',
      'forwardedProps',
      'messages',
      'protocolVersion',
      'runId',
      'state',
      'threadId',
      'tools'
    ])
    expect(req.body).toMatchObject({
      threadId: THREAD,
      protocolVersion: '1.0',
      state: {},
      messages: MESSAGES,
      tools: [],
      context: [],
      forwardedProps: {}
    })
    expect(req.body.runId).toMatch(UUID)
    expect(req.headers.accept).toBe('text/event-stream')
  })

  it('sends the key in its header only: never in the path, the query or the body (Review Focus 2)', async () => {
    for (const headers of [{ Authorization: `Bearer ${KEY}` }, { 'X-Api-Key': KEY }] as Record<string, string>[]) {
      const f = await fake([{ text: 'ok' }, { finish: {} }])
      await run(f, { endpoint: `${f.url}?team=a`, headers }).h.done
      const [req] = f.requests()
      const name = Object.keys(headers)[0].toLowerCase()
      expect(req.headers[name]).toContain(KEY)
      const { [name]: _key, ...others } = req.headers
      expect(JSON.stringify([req.path, req.query, req.body, others])).not.toContain(KEY)
      expect(f.logText().split(KEY)).toHaveLength(2)
    }
  })
})

describe('startAgui: state', () => {
  it('keeps the state across two handles on one thread, and starts a new thread at {}', async () => {
    const f = await fake(
      [
        { state: { snapshot: { count: 1, items: ['a'] } } },
        {
          state: {
            delta: [
              { op: 'replace', path: '/count', value: 2 },
              { op: 'add', path: '/items/-', value: 'b' }
            ]
          }
        },
        { finish: {} }
      ],
      [{ finish: {} }]
    )
    const first = run(f)
    await first.h.done
    const kept = first.threads.at(-1)!
    expect(kept).toEqual({ v: 1, threadId: THREAD, state: { count: 2, items: ['a', 'b'] }, interrupts: [] })

    await run(f, { thread: kept }).h.done
    expect(f.requests()[1].body.state).toEqual({ count: 2, items: ['a', 'b'] })

    const fresh = run(f, { threadId: 'another-thread', thread: kept })
    await fresh.h.done
    expect(f.requests()[2].body).toMatchObject({ threadId: 'another-thread', state: {} })
    expect(f.requests()[2].body.resume).toBeUndefined()
    expect(fresh.threads.at(-1)).toEqual({ v: 1, threadId: 'another-thread', state: {}, interrupts: [] })
  })

  it('drops the state with one log line when a patch fails, and sends {} next', async () => {
    const err = silenceLog()
    const f = await fake(
      [
        { state: { snapshot: { a: 1 } } },
        { state: { delta: [{ op: 'replace', path: '/missing', value: 1 }] } },
        { state: { delta: [{ op: 'add', path: '/b', value: 2 }] } },
        { finish: {} }
      ],
      [{ finish: {} }]
    )
    const first = run(f)
    await first.h.done
    expect(first.threads.at(-1)!.state).toBeNull()
    expect(err).toHaveBeenCalledTimes(1)
    expect(String(err.mock.calls[0][0])).toContain('127.0.0.1')
    await run(f, { thread: first.threads.at(-1)! }).h.done
    expect(f.requests()[1].body.state).toEqual({})
  })

  it('drops a state over its cap with one log line', async () => {
    const err = silenceLog()
    const f = await fake([{ state: { snapshot: { big: 'x'.repeat(2000) } } }, { finish: {} }])
    const r = run(f, { limits: { stateBytes: 1024 } })
    await r.h.done
    expect(r.threads.at(-1)!.state).toBeNull()
    expect(err).toHaveBeenCalledTimes(1)
  })

  it('drops a snapshot over the default cap (256 KiB) with one log line', async () => {
    const err = silenceLog()
    const f = await fake([{ state: { snapshot: { big: 'x'.repeat(300 * 1024) } } }, { finish: {} }])
    const r = run(f)
    expect(await r.h.done).toMatchObject({ stderr: '', spawnError: null })
    expect(r.threads.at(-1)!.state).toBeNull()
    expect(err).toHaveBeenCalledTimes(1)
  })

  it('drops a small delta that doubles the state past the cap while it patches, and the run goes on', async () => {
    const err = silenceLog()
    // 26 doubling copies in one 1 KiB event would build a document of tens of millions of nodes before any cap check.
    const delta = Array.from({ length: 26 }, () => ({ op: 'copy', from: '/a', path: '/a/-' }))
    const f = await fake([{ state: { snapshot: { a: [1] } } }, { state: { delta } }, { text: 'ok' }, { finish: {} }])
    const t = Date.now()
    const r = run(f)
    const out = await r.h.done
    expect(Date.now() - t).toBeLessThan(2000)
    expect(out.result).toMatchObject({ subtype: 'success' })
    expect(r.threads.at(-1)!.state).toBeNull()
    expect(err).toHaveBeenCalledTimes(1)
    expect(String(err.mock.calls[0][0])).toContain('a state patch did not apply')
  })
})

describe('startAgui: interrupts', () => {
  it('turns a mappable interrupt into a question card, and resumes on the same thread with a new run and the payload', async () => {
    const f = await fake(
      [
        { text: 'Deploying.', id: 'm1' },
        { tool: { id: 'call_9', name: 'deploy', args: { env: 'prod' }, parent: 'm1' } },
        interrupt(approval('int-1', { toolCallId: 'call_9' }))
      ],
      [{ tool: { id: 'call_9', name: 'deploy', args: { env: 'prod' }, result: 'deployed' } }, { text: 'Deployed.' }, { finish: {} }]
    )
    let requests = 0
    const r = run(f, {
      react: (e, h) => {
        if (e.kind !== 'permissionRequest') return
        requests++
        // The interrupt is kept before the card waits.
        expect(r.threads.at(-1)!.interrupts).toEqual([{ id: 'int-1', expiresAt: null }])
        expect(h.send(allowResponse('int-1', {}))).toBe(false)
        expect(h.send(allowResponse('other:int-1', {}))).toBe(false)
        expect(h.send(answer(e, { Approve: 'Yes' }))).toBe(true)
        expect(h.send(answer(e, { Approve: 'Yes' }))).toBe(false)
      }
    })
    const out = await r.h.done
    expect(requests).toBe(1)
    const card = of(r.events, 'permissionRequest')[0]
    expect(card).toMatchObject({
      requestId: 'tag-1:int-1',
      toolName: QUESTION_TOOL,
      toolUseId: 'tag-1:call_9',
      description: null,
      reason: null
    })
    expect((card.input as { title: string }).title).toBe('Run the deploy?')

    const [one, two] = f.requests()
    expect(two.body.threadId).toBe(THREAD)
    expect(two.body.runId).toMatch(UUID)
    expect(two.body.runId).not.toBe(one.body.runId)
    expect(two.body.resume).toEqual([{ interruptId: 'int-1', status: 'resolved', payload: { approved: true } }])
    // The history, then this turn's transcript so far, by the server's ids.
    expect(two.body.messages).toEqual([
      ...MESSAGES,
      {
        id: 'm1',
        role: 'assistant',
        content: 'Deploying.',
        toolCalls: [{ id: 'call_9', type: 'function', function: { name: 'deploy', arguments: '{"env":"prod"}' } }]
      }
    ])
    expect(one.body.resume).toBeUndefined()
    // The resumed call's result reaches the first round's row, tagged as it was; the call announced again opens no second row.
    expect(of(r.events, 'toolResult')).toContainEqual({
      kind: 'toolResult',
      toolUseId: 'tag-1:call_9',
      content: 'deployed',
      isError: false
    })
    expect(of(r.events, 'toolUse').map((e) => e.id)).toEqual(['tag-1:call_9'])
    // Kept at the interrupt, cleared once the resume run started.
    expect(r.threads.map((t) => t.interrupts.length)).toEqual([1, 0, 0])
    expect(out).toMatchObject({ stderr: '', spawnError: null, stopped: false })
    expect(of(r.events, 'result')).toHaveLength(1)
  })

  it("asks a real server's approval as the one question it requires (Pydantic AI 2.65)", async () => {
    const schema = {
      type: 'object',
      properties: { approved: { type: 'boolean' }, editedArgs: { type: 'object' }, reason: { type: 'string' } },
      required: ['approved']
    }
    const f = await fake([interrupt({ id: 'int-p', reason: 'tool_call', responseSchema: schema })], [{ finish: {} }])
    const r = run(f, {
      react: (e, h) => {
        if (e.kind === 'permissionRequest') h.send(answer(e, { approved: 'Yes' }))
      }
    })
    await r.h.done
    expect(of(r.events, 'notice')).toEqual([])
    const card = of(r.events, 'permissionRequest')[0]
    expect((card.input as { questions: { question: string }[] }).questions.map((q) => q.question)).toEqual(['approved'])
    expect(f.requests()[1].body.resume).toEqual([{ interruptId: 'int-p', status: 'resolved', payload: { approved: true } }])
  })

  it('cancels a card the user skips', async () => {
    const f = await fake([interrupt(approval('int-1'))], [{ finish: {} }])
    const r = run(f, {
      react: (e, h) => {
        if (e.kind === 'permissionRequest') h.send(denyResponse(e.requestId, 'skip'))
      }
    })
    await r.h.done
    expect(f.requests()[1].body.resume).toEqual([{ interruptId: 'int-1', status: 'cancelled' }])
  })

  it('answers an unmappable interrupt cancelled at once, with a notice naming its reason cut to 100 characters', async () => {
    // Each run of control characters becomes one space.
    const reason = 'needs\u0007\u0000' + 'r'.repeat(200)
    const f = await fake([interrupt({ id: 'int-x', reason }, approval('int-y'))], [{ finish: {} }])
    const r = run(f, {
      react: (e, h) => {
        if (e.kind === 'permissionRequest') h.send(answer(e, { Approve: 'No' }))
      }
    })
    await r.h.done
    const notices = of(r.events, 'notice')
    expect(notices).toHaveLength(1)
    expect(notices[0].text).toBe(AGUI_TEXT.interruptDeclined(('needs ' + 'r'.repeat(200)).slice(0, 100)))
    expect(of(r.events, 'permissionRequest').map((e) => e.requestId)).toEqual(['tag-1:int-y'])
    expect(f.requests()[1].body.resume).toEqual([
      { interruptId: 'int-x', status: 'cancelled' },
      { interruptId: 'int-y', status: 'resolved', payload: { approved: false } }
    ])
  })

  it('cancels an interrupt already expired without a card', async () => {
    const f = await fake([interrupt(approval('int-1', { expiresAt: '2000-01-01T00:00:00Z' }))], [{ finish: {} }])
    const r = run(f)
    await r.h.done
    expect(of(r.events, 'permissionRequest')).toEqual([])
    expect(f.requests()[1].body.resume).toEqual([{ interruptId: 'int-1', status: 'cancelled' }])
  })

  it('cancels a card at its expiresAt', async () => {
    const f = await fake()
    // Set once the server runs, so its start time never eats into the wait.
    const expiresAt = new Date(Date.now() + 700).toISOString()
    f.script([[interrupt(approval('int-1', { expiresAt }))], [{ finish: {} }]])
    const r = run(f)
    await r.h.done
    expect(kinds(r.events).filter((k) => k.startsWith('permission'))).toEqual(['permissionRequest', 'permissionCancel'])
    expect(of(r.events, 'permissionCancel')[0].requestId).toBe('tag-1:int-1')
    expect(r.threads[0].interrupts).toEqual([{ id: 'int-1', expiresAt }])
    expect(f.requests()[1].body.resume).toEqual([{ interruptId: 'int-1', status: 'cancelled' }])
  })

  it('Stop with a card open sends nothing more, and the next handle cancels the interrupt (Review Focus 4)', async () => {
    const f = await fake([interrupt(approval('int-1'), approval('int-2'))], [{ text: 'Cancelled both.' }, { finish: {} }])
    const first = run(f, {
      react: (e, h) => {
        if (e.kind === 'permissionRequest' && e.requestId.endsWith('int-2')) h.stop()
      }
    })
    const out = await first.h.done
    expect(out.stopped).toBe(true)
    expect(
      of(first.events, 'permissionCancel')
        .map((e) => e.requestId)
        .sort()
    ).toEqual(['tag-1:int-1', 'tag-1:int-2'])
    expect(first.h.send(allowResponse('tag-1:int-1', {}))).toBe(false)
    await new Promise((r) => setTimeout(r, 100))
    expect(f.requests()).toHaveLength(1)
    const kept = first.threads.at(-1)!
    expect(kept.interrupts.map((i) => i.id)).toEqual(['int-1', 'int-2'])

    const next = run(f, { thread: kept, requestTag: 'tag-2' })
    await next.h.done
    expect(f.requests()[1].body.resume).toEqual([
      { interruptId: 'int-1', status: 'cancelled' },
      { interruptId: 'int-2', status: 'cancelled' }
    ])
    expect(next.threads.at(-1)!.interrupts).toEqual([])

    // An Edit starts a new thread, which cancels nothing.
    await run(f, { thread: kept, threadId: 'edited-thread' }).h.done
    expect(f.requests()[2].body.resume).toBeUndefined()
  })

  it('keeps the interrupts when the resume run is refused, so the next send cancels them again', async () => {
    const f = await fake([{ status: { code: 500 } }])
    const kept: AguiThread = { v: 1, threadId: THREAD, state: { a: 1 }, interrupts: [{ id: 'old', expiresAt: null }] }
    const r = run(f, { thread: kept })
    const out = await r.h.done
    expect(out.stderr).toBe(AGUI_TEXT.status(500))
    expect(f.requests()[0].body).toMatchObject({ state: { a: 1 }, resume: [{ interruptId: 'old', status: 'cancelled' }] })
    // No run started, so the thread file is never rewritten: it still holds the interrupt.
    expect(r.threads).toEqual([])
  })

  it('drops the stored interrupts when the server definitively refuses the request carrying them', async () => {
    for (const code of [409, 422]) {
      const f = await fake([{ status: { code, body: 'stale resume' } }])
      const kept: AguiThread = { v: 1, threadId: THREAD, state: { a: 1 }, interrupts: [{ id: 'old', expiresAt: null }] }
      const r = run(f, { thread: kept })
      const out = await r.h.done
      expect(out.stderr).toBe(AGUI_TEXT.status(code))
      expect(f.requests()[0].body.resume).toEqual([{ interruptId: 'old', status: 'cancelled' }])
      expect(r.threads).toEqual([{ v: 1, threadId: THREAD, state: { a: 1 }, interrupts: [] }])
    }
  })

  it('keeps them on an auth or rate refusal, so a fixed key or a retry still resumes', async () => {
    for (const code of [401, 403, 408, 429]) {
      const f = await fake([{ status: { code } }])
      const r = run(f, { thread: { v: 1, threadId: THREAD, state: {}, interrupts: [{ id: 'old', expiresAt: null }] } })
      await r.h.done
      expect(r.threads).toEqual([])
    }
  })

  it("drops a round's interrupts when the server refuses its resume run", async () => {
    const f = await fake([interrupt({ id: 'int-1', reason: 'no schema' })], [{ status: { code: 422 } }])
    const r = run(f)
    const out = await r.h.done
    expect(out.stderr).toBe(AGUI_TEXT.status(422))
    expect(r.threads.map((t) => t.interrupts.map((i) => i.id))).toEqual([['int-1'], []])
  })

  it('drops the interrupts of a run a late RUN_ERROR failed, with no card', async () => {
    const f = await fake([interrupt(approval('int-1')), { lateError: { message: 'it broke' }, ms: 30 }])
    const r = run(f, { limits: { finishGraceMs: 2000 } })
    const out = await r.h.done
    expect(out.stderr).toBe(AGUI_TEXT.runError('it broke', null))
    expect(of(r.events, 'permissionRequest')).toEqual([])
    expect(r.threads.map((t) => t.interrupts.map((i) => i.id))).toEqual([['int-1'], []])
    expect(f.requests()).toHaveLength(1)
  })

  it('ends the turn after the rounds cap when the server keeps asking', async () => {
    const f = await fake([interrupt({ id: 'again', reason: 'loop' })])
    const r = run(f, { limits: { rounds: 2 } })
    const out = await r.h.done
    expect(out.stderr).toBe(AGUI_TEXT.tooManyRounds)
    expect(out.result).toBeNull()
    expect(f.requests()).toHaveLength(3)
    expect(of(r.events, 'notice')).toHaveLength(2)
    // The last interrupt stays kept, so the next send cancels it.
    expect(r.threads.at(-1)!.interrupts).toEqual([{ id: 'again', expiresAt: null }])
  })

  it('gives a repeated interrupt id a card of its own in a later round', async () => {
    const f = await fake([interrupt(approval('int-1'))], [interrupt(approval('int-1'))], [{ finish: {} }])
    const r = run(f, {
      react: (e, h) => {
        if (e.kind === 'permissionRequest') expect(h.send(answer(e, { Approve: 'Yes' }))).toBe(true)
      }
    })
    const out = await r.h.done
    expect(out.stderr).toBe('')
    const ids = of(r.events, 'permissionRequest').map((e) => e.requestId)
    expect(ids).toHaveLength(2)
    expect(new Set(ids).size).toBe(2)
    expect(f.requests()[2].body.resume).toEqual([{ interruptId: 'int-1', status: 'resolved', payload: { approved: true } }])
  })

  it('keeps every answer ChatService gives inside the request event itself', async () => {
    const f = await fake([interrupt(approval('int-1'), approval('int-2'))], [{ finish: {} }])
    const r = run(f, {
      react: (e, h) => {
        if (e.kind === 'permissionRequest') expect(h.send(answer(e, { Approve: 'Yes' }))).toBe(true)
      }
    })
    const out = await r.h.done
    expect(out.stderr).toBe('')
    expect(f.requests()[1].body.resume).toEqual([
      { interruptId: 'int-1', status: 'resolved', payload: { approved: true } },
      { interruptId: 'int-2', status: 'resolved', payload: { approved: true } }
    ])
  })
})

describe('startAgui: outcomes', () => {
  it('answers each pending tool call that has a row with an error, with one notice, and drops one with no row', async () => {
    const err = silenceLog()
    const f = await fake([
      { tool: { id: 'call_a', name: 'client_tool', args: {} } },
      { tool: { id: 'call_b', name: 'other', args: 'not json' } },
      { finish: { outcome: { type: 'success', pendingToolCallIds: ['call_a', 'ghost'] } } }
    ])
    const r = run(f)
    await r.h.done
    expect(of(r.events, 'toolResult')).toEqual([
      { kind: 'toolResult', toolUseId: 'tag-1:call_a', content: AGUI_TEXT.noTools, isError: true },
      { kind: 'toolResult', toolUseId: 'tag-1:call_b', content: AGUI_TEXT.toolUnfinished, isError: true }
    ])
    expect(of(r.events, 'notice')).toEqual([{ kind: 'notice', text: AGUI_TEXT.pendingTools }])
    expect(err).toHaveBeenCalledTimes(1)
    expect(kinds(r.events).at(-1)).toBe('result')
  })

  it('records usage tokens without a cost, keyed by model', async () => {
    const usage = [
      { model: 'gpt-x', inputTokens: 100, cachedInputTokens: 30, cacheWriteInputTokens: 10, outputTokens: 7 },
      { model: 'gpt-x', inputTokens: 5, cachedInputTokens: 9, outputTokens: 1 },
      { inputTokens: 4, outputTokens: 2 }
    ]
    const f = await fake([{ finish: { usage } }])
    const r = run(f)
    const out = await r.h.done
    expect(out.result!.cost).toEqual({
      totalUsd: 0,
      models: {
        'gpt-x': { input: 60, output: 8, cacheRead: 39, cacheWrite: 10, costUsd: null },
        unknown: { input: 4, output: 2, cacheRead: 0, cacheWrite: 0, costUsd: null }
      }
    })
    expect(kinds(r.events)).not.toContain('context')
  })

  it('sums the usage of every round', async () => {
    const f = await fake(
      [
        {
          finish: {
            outcome: { type: 'interrupt', interrupts: [{ id: 'i', reason: 'r' }] },
            usage: [{ model: 'm', inputTokens: 10, outputTokens: 1 }]
          }
        }
      ],
      [{ finish: { usage: [{ model: 'm', inputTokens: 20, outputTokens: 2 }] } }]
    )
    const out = await run(f).h.done
    expect(out.result!.cost!.models.m).toEqual({ input: 30, output: 3, cacheRead: 0, cacheWrite: 0, costUsd: null })
  })

  it('a cancelled outcome is a stop', async () => {
    const f = await fake([{ text: 'Stopping.' }, { finish: { outcome: { type: 'cancelled' } } }])
    const r = run(f)
    const out = await r.h.done
    expect(out.stopped).toBe(true)
    expect(out.result).toMatchObject({ subtype: 'cancelled', isError: false })
  })

  it('a RUN_ERROR echoing the key: its message cut to 500 characters, control characters stripped, the key only in the header', async () => {
    const message = `bad key ${KEY}\n\u0000\u001b[31m` + 'y'.repeat(800)
    const f = await fake([{ text: 'Trying.' }, { error: { message, code: 'AUTH\u0007' } }])
    const r = run(f)
    const out = await r.h.done
    const shown = ('bad key ' + KEY + ' [31m' + 'y'.repeat(800)).slice(0, 500)
    expect(out.stderr).toBe(AGUI_TEXT.runError(shown, 'AUTH'))
    // eslint-disable-next-line no-control-regex
    expect(out.stderr).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/)
    expect(out.result).toMatchObject({ subtype: 'error', isError: true })
    expect(out.spawnError).toBeNull()
    const [req] = f.requests()
    const { authorization, ...others } = req.headers
    expect(authorization).toBe(`Bearer ${KEY}`)
    expect(JSON.stringify([req.path, req.query, req.body, others])).not.toContain(KEY)
  })

  it('a refusal before any byte is sent is a spawn error', async () => {
    const f = await fake([{ finish: {} }])
    const out = await run(f, { allowLocal: false }).h.done
    expect(out).toMatchObject({ spawnError: AGUI_TEXT.endpointInvalid, stderr: '', result: null })
    const lookup = async () => [{ address: '10.1.2.3', family: 4 }]
    const out2 = await run(f, { endpoint: 'https://agents.example/run', allowLocal: false, lookup }).h.done
    expect(out2).toMatchObject({ spawnError: AGUI_TEXT.notPublic('agents.example'), result: null })
    expect(f.requests()).toEqual([])
  })

  it('an HTTP error status is the run error, the status only', async () => {
    const f = await fake([{ status: { code: 401, body: `rejected ${KEY}` } }])
    const out = await run(f).h.done
    expect(out).toMatchObject({ stderr: AGUI_TEXT.unauthorized(401, 'AGENT_KEY'), spawnError: null, result: null })
  })

  it('a cross-host redirect ends the run with the redirect sentence', async () => {
    const other = await fake([{ finish: {} }])
    const f = await fake([{ redirect: { status: 307, location: `http://localhost:${other.port}/run` } }])
    const out = await run(f).h.done
    expect(out).toMatchObject({ stderr: AGUI_TEXT.redirected, result: null })
    expect(other.requests()).toEqual([])
  })
})

describe('startAgui: streams that never finish properly (Review Focus 5)', () => {
  const cases: Array<[string, AguiStep[], string, object?]> = [
    ['a cut', [{ text: 'Half', id: 'm1' }, { tool: { id: 'call_1', name: 'search', args: {} } }, { cut: true }], AGUI_TEXT.cut],
    [
      'a reset',
      [{ text: 'Half', id: 'm1' }, { tool: { id: 'call_1', name: 'search', args: {} } }, { sleep: 30 }, { cut: 'reset' }],
      AGUI_TEXT.cut
    ],
    [
      'an idle drip',
      [{ text: 'Half', id: 'm1' }, { tool: { id: 'call_1', name: 'search', args: {} } }, { hold: true }],
      AGUI_TEXT.idleTimeout,
      { idleMs: 200 }
    ],
    [
      'an oversize event',
      [{ text: 'Half', id: 'm1' }, { tool: { id: 'call_1', name: 'search', args: {} } }, { oversize: 5000 }, { finish: {} }],
      AGUI_TEXT.eventTooBig,
      { eventBytes: 2048 }
    ],
    [
      'a malformed known event',
      [{ text: 'Half', id: 'm1' }, { tool: { id: 'call_1', name: 'search', args: {} } }, { malformed: true }, { finish: {} }],
      AGUI_TEXT.unreadable
    ],
    [
      'an event that is not JSON',
      [{ text: 'Half', id: 'm1' }, { tool: { id: 'call_1', name: 'search', args: {} } }, { malformed: 'json' }, { finish: {} }],
      AGUI_TEXT.unreadable
    ],
    [
      'a final event with no blank line after it',
      [{ text: 'Half', id: 'm1' }, { tool: { id: 'call_1', name: 'search', args: {} } }, { finish: {}, open: true }],
      AGUI_TEXT.cut
    ]
  ]
  for (const [name, steps, text, limits] of cases) {
    it(`${name} ends with its sentence, never a success, closing what was open`, async () => {
      const f = await fake(steps)
      const r = run(f, { limits: limits as AguiRunOptions['limits'] })
      const out = await r.h.done
      expect(out).toMatchObject({ stderr: text, result: null, spawnError: null, stopped: false })
      expect(of(r.events, 'result')).toEqual([])
      expect(of(r.events, 'assistantText').map((e) => e.text)).toEqual(['Half'])
      expect(of(r.events, 'toolUse').map((e) => e.id)).toEqual(['tag-1:call_1'])
      expect(of(r.events, 'toolResult')).toEqual([
        { kind: 'toolResult', toolUseId: 'tag-1:call_1', content: AGUI_TEXT.toolUnfinished, isError: true }
      ])
    })
  }

  it('an event before RUN_STARTED is unreadable', async () => {
    const f = await fake([
      { raw: { type: 'TEXT_MESSAGE_START', messageId: 'm0', role: 'assistant' } },
      { raw: { type: 'RUN_STARTED', threadId: '$threadId', runId: '$runId' } },
      { finish: {} }
    ])
    const r = run(f)
    const out = await r.h.done
    expect(out).toMatchObject({ stderr: AGUI_TEXT.unreadable, result: null })
    expect(kinds(r.events)).toEqual([])
  })

  it('a version-2 producer ends the run with the protocol sentence', async () => {
    const f = await fake([
      { raw: { type: 'RUN_STARTED', threadId: '$threadId', runId: '$runId', protocolVersion: '2.0' } },
      { text: 'Hi' },
      { finish: {} }
    ])
    const out = await run(f).h.done
    expect(out).toMatchObject({ stderr: AGUI_TEXT.protocol, result: null })
  })

  it('a RUN_STARTED of another thread is unreadable', async () => {
    const f = await fake([{ raw: { type: 'RUN_STARTED', threadId: 'not-mine', runId: '$runId' } }, { finish: {} }])
    expect((await run(f).h.done).stderr).toBe(AGUI_TEXT.unreadable)
  })
})

describe('startAgui: several runs in one response (Rulings 2)', () => {
  it('drops a replayed run ahead of ours', async () => {
    const f = await fake([{ replay: { text: 'Old words.' } }, { text: 'New words.' }, { finish: {} }])
    const r = run(f)
    const out = await r.h.done
    expect(out.stderr).toBe('')
    expect(of(r.events, 'assistantText').map((e) => e.text)).toEqual(['New words.'])
    expect(of(r.events, 'init')).toHaveLength(1)
  })

  it('a late RUN_ERROR inside the grace makes the run an error', async () => {
    const f = await fake([{ text: 'Done?' }, { finish: {} }, { lateError: { message: 'it failed after all', code: 'LATE' }, ms: 50 }])
    const r = run(f, { limits: { finishGraceMs: 2000 } })
    const out = await r.h.done
    expect(out.stderr).toBe(AGUI_TEXT.runError('it failed after all', 'LATE'))
    expect(out.result).toMatchObject({ isError: true })
    expect(of(r.events, 'result')).toHaveLength(1)
  })

  it('a late RUN_ERROR after the grace is never read: the run succeeded', async () => {
    const f = await fake([{ text: 'Done.' }, { finish: {} }, { lateError: { message: 'too late' }, ms: 1000 }])
    const started = Date.now()
    const out = await run(f, { limits: { finishGraceMs: 150 } }).h.done
    expect(out).toMatchObject({ stderr: '', result: { isError: false } })
    expect(Date.now() - started).toBeLessThan(900)
    await waitFor(() => f.log().some((e) => e.abort === 0))
  })

  it('anything unreadable after our terminal, inside the grace, is an error, never a success', async () => {
    const f = await fake([{ text: 'Done.' }, { finish: {} }, { malformed: 'json' }])
    const out = await run(f).h.done
    expect(out).toMatchObject({ stderr: AGUI_TEXT.unreadable, result: null })
  })

  it('a reset after our terminal still ends as our terminal says', async () => {
    const f = await fake([{ text: 'Done.' }, { finish: {} }, { sleep: 30 }, { cut: 'reset' }])
    const out = await run(f).h.done
    expect(out).toMatchObject({ stderr: '', result: { isError: false } })
  })

  it('delivers a result for a call this run never saw, tagged (a resumed approval)', async () => {
    const f = await fake([
      { raw: { type: 'TOOL_CALL_RESULT', messageId: 'r1', toolCallId: 'from-earlier', content: 'approved and ran' } },
      { finish: {} }
    ])
    const r = run(f)
    const out = await r.h.done
    expect(out.stderr).toBe('')
    expect(of(r.events, 'toolResult')).toEqual([
      { kind: 'toolResult', toolUseId: 'tag-1:from-earlier', content: 'approved and ran', isError: false }
    ])
  })
})

describe('startAgui: Stop', () => {
  it('aborts the request mid-stream, closes what was open, and sets stopped', async () => {
    const f = await fake([{ text: 'Working', id: 'm1' }, { tool: { id: 'call_1', name: 'search', args: {} } }, { hold: true }])
    const r = run(f, {
      react: (e, h) => {
        if (e.kind === 'toolUse') setTimeout(() => h.stop(), 20)
      }
    })
    const out = await r.h.done
    expect(out).toMatchObject({ stopped: true, result: null, stderr: '', spawnError: null })
    expect(of(r.events, 'toolResult')).toEqual([
      { kind: 'toolResult', toolUseId: 'tag-1:call_1', content: AGUI_TEXT.toolUnfinished, isError: true }
    ])
    await waitFor(() => f.log().some((e) => e.abort === 0))
    expect(f.requests()).toHaveLength(1)
  })

  it('a Stop raised inside the batch of an interrupt terminal shows nothing more, yet keeps the interrupt for the next send', async () => {
    // RUN_FINISHED closes the open text and the open call: one batch of two events, with the interrupt as its terminal.
    const f = await fake(
      [
        { raw: { type: 'TEXT_MESSAGE_START', messageId: 'm1', role: 'assistant' } },
        { raw: { type: 'TEXT_MESSAGE_CONTENT', messageId: 'm1', delta: 'Half' } },
        { raw: { type: 'TOOL_CALL_START', toolCallId: 'call_1', toolCallName: 'search' } },
        interrupt(approval('int-1'))
      ],
      [{ finish: {} }]
    )
    const started = Date.now()
    const r = run(f, {
      react: (e, h) => {
        if (e.kind === 'assistantText') h.stop()
      },
      limits: { finishGraceMs: 3000 }
    })
    const out = await r.h.done
    expect(out).toMatchObject({ stopped: true, result: null, stderr: '' })
    // No grace wait, no card, and the rest of the batch never shown.
    expect(Date.now() - started).toBeLessThan(2000)
    expect(kinds(r.events).slice(kinds(r.events).indexOf('assistantText'))).toEqual(['assistantText'])
    expect(of(r.events, 'permissionRequest')).toEqual([])
    // The server holds the interrupt it sent, so the thread keeps it.
    expect(r.threads).toEqual([{ v: 1, threadId: THREAD, state: {}, interrupts: [{ id: 'int-1', expiresAt: null }] }])
    await new Promise((res) => setTimeout(res, 100))
    expect(f.requests()).toHaveLength(1)

    await run(f, { thread: r.threads.at(-1)!, requestTag: 'tag-2' }).h.done
    expect(f.requests()[1].body.resume).toEqual([{ interruptId: 'int-1', status: 'cancelled' }])
  })

  it('a Stop before anything was read sends nothing more', async () => {
    const f = await fake([{ sleep: 300 }, { finish: {} }])
    const r = run(f)
    r.h.stop()
    const out = await r.h.done
    expect(out.stopped).toBe(true)
    expect(r.h.send(allowResponse('tag-1:x', {}))).toBe(false)
    r.h.stop()
  })
})
