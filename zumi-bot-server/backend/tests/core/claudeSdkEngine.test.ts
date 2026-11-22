import { describe, expect, it } from 'vitest'
import { engineCaps } from '@zumibot/shared/engine'
import type { Options, Query, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import { claudeSdkEngine, sdkDecision, sdkResume, splitExtraArgs, type QueryFn } from '../../src/core/engines/claudeSdkEngine'
import { turnStart, type EngineTurn } from '../../src/core/engines/engine'
import type { ClaudeTurnConfig } from '../../src/core/engines/claudeEngine'
import { allowResponse, denyResponse, errorResponse } from '../../src/core/chat/controlProtocol'
import type { RunEvent } from '../../src/core/chat/streamParser'

// The second Claude adapter: the same binary through the SDK. These tests drive it with a fake query(), so nothing spawns.
// See docs/architecture/engines.md.

interface Call {
  options: Options
  prompt: AsyncIterable<SDKUserMessage>
}

/** A fake `query()`: yields the given CLI-shaped lines, then ends. `hold` keeps it open until interrupt() or close(). */
function fake(messages: object[] = [], o: { hold?: boolean } = {}) {
  const calls: Call[] = []
  const state = { interrupted: 0, closed: 0 }
  let release = () => {}
  const held = new Promise<void>((r) => {
    release = r
  })
  const query: QueryFn = (args) => {
    calls.push(args)
    const gen = (async function* () {
      for (const m of messages) yield m as never
      if (o.hold) await held
    })()
    const q = gen as unknown as Query
    q.interrupt = async () => {
      state.interrupted++
      release()
      return undefined
    }
    q.close = async () => {
      state.closed++
      release()
    }
    return q
  }
  return { query, calls, state }
}

const CONFIG: ClaudeTurnConfig = { agentName: 'ann', permissionMode: 'manual', disallowedTools: [], extraArgs: [] }
const turn = (start = turnStart(null), onEvent: (e: RunEvent) => void = () => {}): EngineTurn => ({
  bin: '/bin/claude',
  cwd: '/w',
  start,
  action: { kind: 'turn', prompt: 'hi' },
  onEvent
})

const INIT = { type: 'system', subtype: 'init', session_id: 's1', claude_code_version: '2.1.325' }
const TEXT = { type: 'assistant', uuid: 'u1', message: { id: 'm1', role: 'assistant', content: [{ type: 'text', text: 'hello' }] } }
const RESULT = { type: 'result', subtype: 'success', is_error: false, num_turns: 1, session_id: 's1' }

describe('sdkResume', () => {
  it('is the documented form of the hidden pair', () => {
    expect(sdkResume(turnStart(null))).toEqual({})
    expect(sdkResume(turnStart('s1'))).toEqual({ resume: 's1' })
    expect(sdkResume(turnStart('s1', 'u1'))).toEqual({ resume: 's1', resumeSessionAt: 'u1', forkSession: true })
    expect(sdkResume(turnStart('s1', 'u1', 'p1'))).toEqual({
      resume: 's1',
      resumeSessionAt: 'u1',
      forkSession: true,
      resumeDropsTurn: 'p1'
    })
  })
})

describe('splitExtraArgs', () => {
  it('collects the flags ZumiBot repeats and keeps single flags as they are', () => {
    const got = splitExtraArgs([
      '--mcp-config',
      '{"mcpServers":{"a":{}}}',
      '--mcp-config',
      '{"mcpServers":{"b":{}}}',
      '--settings',
      '{"hooks":{}}',
      '--add-dir',
      '/one',
      '--add-dir',
      '/two',
      '--no-session-persistence',
      '--model-config',
      'x'
    ])
    expect(got.mcpConfigs).toEqual(['{"mcpServers":{"a":{}}}', '{"mcpServers":{"b":{}}}'])
    expect(got.settings).toEqual(['{"hooks":{}}'])
    expect(got.addDirs).toEqual(['/one', '/two'])
    expect(got.flags).toEqual({ 'no-session-persistence': null, 'model-config': 'x' })
    expect(got.unsupported).toEqual([])
  })

  it('reports what it cannot carry: a repeated unknown flag and a stray value', () => {
    const got = splitExtraArgs(['--thing', 'a', '--thing', 'b', 'loose'])
    expect(got.flags).toEqual({ thing: 'a' })
    expect(got.unsupported).toEqual(['--thing', 'loose'])
  })
})

describe('sdkDecision', () => {
  it("turns ZumiBot's control_response into the SDK's answer", () => {
    const allow = allowResponse('r1', { command: 'ls' }) as { response: Record<string, unknown> }
    expect(sdkDecision(allow.response)).toEqual({ behavior: 'allow', updatedInput: { command: 'ls' } })
    const mode = allowResponse('r1', { plan: 'p' }, [{ type: 'setMode', mode: 'auto', destination: 'session' }]) as {
      response: Record<string, unknown>
    }
    expect(sdkDecision(mode.response)).toEqual({
      behavior: 'allow',
      updatedInput: { plan: 'p' },
      updatedPermissions: [{ type: 'setMode', mode: 'auto', destination: 'session' }]
    })
    const deny = denyResponse('r1', 'no thanks') as { response: Record<string, unknown> }
    expect(sdkDecision(deny.response)).toEqual({ behavior: 'deny', message: 'no thanks' })
  })

  it('denies on an error response, so nothing runs on one', () => {
    const err = errorResponse('r1', 'boom') as { response: Record<string, unknown> }
    expect(sdkDecision(err.response)).toEqual({ behavior: 'deny', message: 'boom' })
    expect(sdkDecision({ subtype: 'success', response: {} })).toMatchObject({ behavior: 'deny' })
  })
})

describe('claudeSdkEngine options', () => {
  const adapter = (q: QueryFn) => claudeSdkEngine({ caps: () => engineCaps('claude'), locate: async () => '/bin/claude', query: q })

  it('names the binary, the agent, the fork and the flags the SDK has no option for', async () => {
    const f = fake([RESULT])
    await adapter(f.query).start(turn(turnStart('s1', 'u1')), {
      ...CONFIG,
      model: 'opus',
      effort: 'high',
      thinking: true,
      appendSystemPrompt: 'house style',
      disallowedTools: ['Bash(rm *)'],
      extraArgs: [
        '--mcp-config',
        '{"mcpServers":{"a":{"x":1}}}',
        '--mcp-config',
        '{"mcpServers":{"b":{}}}',
        '--settings',
        '{"hooks":{"A":[1]}}',
        '--settings',
        '{"hooks":{"A":[2]}}',
        '--add-dir',
        '/files'
      ]
    }).done
    const o = f.calls[0].options
    expect(o).toMatchObject({
      pathToClaudeCodeExecutable: '/bin/claude',
      cwd: '/w',
      agent: 'ann',
      model: 'opus',
      effort: 'high',
      resume: 's1',
      resumeSessionAt: 'u1',
      forkSession: true,
      additionalDirectories: ['/files'],
      disallowedTools: ['Bash(rm *)'],
      includePartialMessages: true
    })
    // The preset, or the agent file's body would never apply; the appended text rides on it.
    expect(o.systemPrompt).toEqual({ type: 'preset', preset: 'claude_code', append: 'house style' })
    expect(o.extraArgs).toEqual({
      'permission-mode': 'manual',
      'mcp-config': '{"mcpServers":{"a":{"x":1},"b":{}}}',
      settings: '{"hooks":{"A":[1,2]}}',
      'thinking-display': 'summarized',
      'system-prompt-snapshot': 'off'
    })
    expect(o.env?.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS).toBe('1')
    expect(o.env).toMatchObject({ BASH_DEFAULT_TIMEOUT_MS: '600000', BASH_MAX_TIMEOUT_MS: '1800000' })
  })

  it('sends no resume for a fresh session and no snapshot flag without appended text', async () => {
    const f = fake([RESULT])
    await adapter(f.query).start(turn(), CONFIG).done
    const o = f.calls[0].options
    expect(o.resume).toBeUndefined()
    expect(o.forkSession).toBeUndefined()
    expect(o.systemPrompt).toEqual({ type: 'preset', preset: 'claude_code' })
    expect(o.extraArgs).toEqual({ 'permission-mode': 'manual' })
  })

  it('refuses to start a turn whose arguments it would have to drop', async () => {
    const f = fake([RESULT])
    const outcome = await adapter(f.query).start(turn(), { ...CONFIG, extraArgs: ['--thing', 'a', '--thing', 'b'] }).done
    expect(outcome.spawnError).toContain('--thing')
    expect(f.calls).toHaveLength(0)
    expect(outcome.result).toBeNull()
  })

  it("merges the run env under the turn's own", async () => {
    const f = fake([RESULT])
    const a = claudeSdkEngine({
      caps: () => engineCaps('claude'),
      locate: async () => null,
      query: f.query,
      env: () => ({ PATH: '/p', A: 'base' })
    })
    await a.start({ ...turn(), env: { A: 'turn' } }, CONFIG).done
    expect(f.calls[0].options.env).toMatchObject({ PATH: '/p', A: 'turn', CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: '1' })
  })
})

describe('claudeSdkEngine run', () => {
  const adapter = (q: QueryFn, intercept?: (e: RunEvent, pass: (e: RunEvent) => void) => void) =>
    claudeSdkEngine({ caps: () => engineCaps('claude'), locate: async () => '/bin/claude', query: q, ...(intercept ? { intercept } : {}) })

  it("reads the SDK's messages with the one stream parser", async () => {
    const f = fake([INIT, TEXT, RESULT])
    const seen: RunEvent[] = []
    const outcome = await adapter(f.query).start(
      turn(turnStart(null), (e) => seen.push(e)),
      CONFIG
    ).done
    expect(seen.map((e) => e.kind)).toEqual(['init', 'entry', 'assistantText', 'result'])
    expect(seen[0]).toEqual({ kind: 'init', sessionId: 's1', version: '2.1.325' })
    expect(outcome.result).toMatchObject({ subtype: 'success', sessionId: 's1' })
    expect(outcome.exitCode).toBe(0)
    expect(outcome.spawnError).toBeNull()
    expect(outcome.stopped).toBe(false)
  })

  it('hands every event to the interceptor first', async () => {
    const f = fake([INIT, RESULT])
    const seen: string[] = []
    const passed: string[] = []
    await adapter(f.query, (e, pass) => {
      seen.push(e.kind)
      if (e.kind !== 'init') pass(e)
    }).start(
      turn(turnStart(null), (e) => passed.push(e.kind)),
      CONFIG
    ).done
    expect(seen).toEqual(['init', 'result'])
    expect(passed).toEqual(['result'])
  })

  it('turns a canUseTool call into a card and answers it from send()', async () => {
    const f = fake([], { hold: true })
    const seen: RunEvent[] = []
    const handle = adapter(f.query).start(
      turn(turnStart(null), (e) => seen.push(e)),
      CONFIG
    )
    await new Promise((r) => setTimeout(r, 0))
    const controller = new AbortController()
    const decision = f.calls[0].options.canUseTool!(
      'Bash',
      { command: 'ls' },
      {
        signal: controller.signal,
        requestId: 'req-1',
        toolUseID: 'tu-1',
        description: 'List files',
        decisionReason: 'ask rule'
      }
    )
    await new Promise((r) => setTimeout(r, 0))
    expect(seen).toEqual([
      {
        kind: 'permissionRequest',
        requestId: 'req-1',
        toolName: 'Bash',
        input: { command: 'ls' },
        description: 'List files',
        reason: 'ask rule',
        toolUseId: 'tu-1'
      }
    ])
    expect(handle.send(allowResponse('req-1', { command: 'ls' }))).toBe(true)
    await expect(decision).resolves.toEqual({ behavior: 'allow', updatedInput: { command: 'ls' } })
    // An answer for a request that is gone goes nowhere.
    expect(handle.send(allowResponse('req-1', {}))).toBe(false)
    handle.stop()
    await handle.done
  })

  it('cancels a card the SDK aborts, and never leaves one unanswered when the run ends', async () => {
    const f = fake([], { hold: true })
    const seen: RunEvent[] = []
    const handle = adapter(f.query).start(
      turn(turnStart(null), (e) => seen.push(e)),
      CONFIG
    )
    await new Promise((r) => setTimeout(r, 0))
    const controller = new AbortController()
    const cancelled = f.calls[0].options.canUseTool!('Write', {}, { signal: controller.signal, requestId: 'req-2', toolUseID: 'tu-2' })
    await new Promise((r) => setTimeout(r, 0))
    controller.abort()
    await expect(cancelled).resolves.toMatchObject({ behavior: 'deny' })
    expect(seen.map((e) => e.kind)).toEqual(['permissionRequest', 'permissionCancel'])
    const open = f.calls[0].options.canUseTool!(
      'Write',
      {},
      { signal: new AbortController().signal, requestId: 'req-3', toolUseID: 'tu-3' }
    )
    handle.stop()
    await handle.done
    await expect(open).resolves.toMatchObject({ behavior: 'deny' })
  })

  it('stops by interrupting the query', async () => {
    const f = fake([INIT], { hold: true })
    const handle = adapter(f.query).start(turn(), CONFIG)
    await new Promise((r) => setTimeout(r, 0))
    handle.stop()
    const outcome = await handle.done
    expect(f.state.interrupted).toBe(1)
    expect(outcome.stopped).toBe(true)
    expect(outcome.exitCode).toBeNull()
    expect(outcome.spawnError).toBeNull()
  })

  it('reports a query that throws as a spawn error, and a stop as neither', async () => {
    const boom: QueryFn = () => {
      const gen = (async function* () {
        throw new Error('claude is missing')
      })()
      const q = gen as unknown as Query
      q.interrupt = async () => undefined
      q.close = async () => {}
      return q
    }
    const outcome = await adapter(boom).start(turn(), CONFIG).done
    expect(outcome.spawnError).toBe('claude is missing')
    expect(outcome.result).toBeNull()
  })

  it('declares the turn a fork discards and writes the prompt under the given id', async () => {
    const f = fake([RESULT])
    const handleOne = adapter(f.query).start(
      { ...turn(turnStart('s1', 'u1', 'p1')), action: { kind: 'turn', prompt: 'hi', promptUuid: 'p9' } },
      CONFIG
    )
    await handleOne.done
    expect(f.calls[0].options).toMatchObject({ resume: 's1', resumeSessionAt: 'u1', forkSession: true, resumeDropsTurn: 'p1' })
    const sent: SDKUserMessage[] = []
    for await (const m of f.calls[0].prompt) sent.push(m)
    expect(sent[0]).toMatchObject({ uuid: 'p9' })
  })

  it('sends one user message and keeps the input open until the result', async () => {
    const f = fake([RESULT])
    const handle = adapter(f.query).start(turn(), CONFIG)
    await handle.done
    const sent: SDKUserMessage[] = []
    for await (const m of f.calls[0].prompt) sent.push(m)
    expect(sent).toEqual([{ type: 'user', message: { role: 'user', content: 'hi' }, parent_tool_use_id: null }])
  })
})
