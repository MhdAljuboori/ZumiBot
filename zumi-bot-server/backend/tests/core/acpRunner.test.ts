import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { ACP_TEXT } from '@zumibot/shared/acp'
import { acpPreamble, startAcp, type AcpRunOptions } from '../../src/core/acp/acpRunner'
import { allowResponse, denyResponse, type UserContent } from '../../src/core/chat/controlProtocol'
import type { RunEvent } from '../../src/core/chat/streamParser'
import type { RunHandle } from '../../src/core/engines/engine'

const FAKE = fileURLToPath(new URL('../fixtures/fake-acp-agent.mjs', import.meta.url))
// Real path: on macOS tmpdir() is /var/…, a link to /private/var/…, and the agent's process.cwd() reports the latter.
const root = realpathSync(mkdtempSync(join(tmpdir(), 'cb-acp-runner-')))
// Retries: on Windows an ended agent's tree can hold the folder for a moment.
afterAll(() => rmSync(root, { recursive: true, force: true, maxRetries: 5 }))

let dir: string
let n = 0
beforeEach(() => {
  dir = join(root, `case-${n++}`)
  mkdirSync(join(dir, 'ws'), { recursive: true })
})
afterEach(() => {
  vi.restoreAllMocks()
})

const ws = () => join(dir, 'ws')
const file = (name: string) => join(dir, name)
const lines = (p: string): any[] =>
  existsSync(p)
    ? readFileSync(p, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l))
    : []
const log = () => lines(file('log.jsonl'))
const methods = () =>
  log()
    .filter((m) => typeof m.method === 'string' && m.id !== undefined)
    .map((m) => m.method)
const sent = (method: string) => log().find((m) => m.method === method)
const answers = () => log().filter((m) => m.method === undefined)
const pids = () => lines(file('pids.jsonl')) as Array<{ pid: number; role: string }>

const alive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
async function goneWithin(pid: number, ms: number): Promise<boolean> {
  for (const end = Date.now() + ms; Date.now() < end;) {
    if (!alive(pid)) return true
    await new Promise((r) => setTimeout(r, 25))
  }
  return !alive(pid)
}

type Opts = Partial<AcpRunOptions> & { react?: (e: RunEvent, h: RunHandle) => void; extraEnv?: Record<string, string> }
function run(script: object = {}, o: Opts = {}) {
  const events: RunEvent[] = []
  const { react, extraEnv, ...rest } = o
  let h: RunHandle | null = null
  h = startAcp({
    bin: process.execPath,
    args: [FAKE],
    cwd: ws(),
    env: {
      ...process.env,
      FAKE_ACP_SCRIPT: JSON.stringify(script),
      FAKE_ACP_LOG: file('log.jsonl'),
      FAKE_ACP_PIDS: file('pids.jsonl'),
      FAKE_ACP_START: file('start.jsonl'),
      ...extraEnv
    },
    start: { kind: 'new' },
    prompt: 'hello',
    systemPrompt: '',
    requestTag: 'tag-1',
    onEvent: (e) => {
      events.push(e)
      react?.(e, h!)
    },
    ...rest
  })
  return { h, events }
}

const kinds = (events: RunEvent[]) => events.map((e) => e.kind)
const of = <K extends RunEvent['kind']>(events: RunEvent[], kind: K) =>
  events.filter((e): e is Extract<RunEvent, { kind: K }> => e.kind === kind)
const caps = (c: object) => ({ initialize: { agentCapabilities: c } })

const CLIENT_CAPABILITIES = {
  fs: { readTextFile: false, writeTextFile: false },
  terminal: false,
  auth: { terminal: false },
  elicitation: { form: {} },
  session: {}
}

describe('startAcp: a turn', () => {
  test('text, thinking and a tool call with a diff: init, the mapped events, then the result; one process, exit 0', async () => {
    const a = join(ws(), 'a.txt')
    const { h, events } = run({
      steps: [
        { thought: 'Let me think.' },
        { text: 'Hello' },
        { toolCall: { toolCallId: 't1', title: 'Edit a.txt', kind: 'edit', status: 'pending', locations: [{ path: a }] } },
        { toolUpdate: { toolCallId: 't1', status: 'completed', content: [{ type: 'diff', path: a, oldText: 'old', newText: 'new' }] } },
        { text: ' done' },
        { usage: { used: 1200, size: 200000 } }
      ]
    })
    const out = await h.done
    expect(kinds(events)).toEqual([
      'init',
      'thinkingDelta',
      'thinking',
      'textDelta',
      'assistantText',
      'toolUse',
      'toolResult',
      'textDelta',
      'context',
      'assistantText',
      'result'
    ])
    expect(events[0]).toEqual({ kind: 'init', sessionId: 'fake-session-1', version: '0.0.1' })
    expect(of(events, 'thinking')[0].text).toBe('Let me think.')
    expect(of(events, 'toolUse')[0]).toMatchObject({ id: 'tag-1:t1', name: 'AcpEdit', input: { paths: [a] } })
    expect(of(events, 'toolResult')[0]).toMatchObject({
      toolUseId: 'tag-1:t1',
      isError: false,
      detail: { acpDiffs: [{ path: a, oldText: 'old', newText: 'new' }] }
    })
    expect(of(events, 'context')[0]).toEqual({ kind: 'context', model: null, tokens: 1200 })
    expect(of(events, 'assistantText').map((e) => e.text)).toEqual(['Hello', ' done'])
    const result = events.at(-1)
    expect(result).toEqual({
      kind: 'result',
      subtype: 'end_turn',
      isError: false,
      numTurns: 1,
      sessionId: 'fake-session-1',
      denials: [],
      windows: { acp: 200000 },
      uuid: null,
      cost: null
    })
    expect(out).toMatchObject({ exitCode: 0, signal: null, spawnError: null, stopped: false, stderr: '', result })
    expect(out.missingSession).toBeUndefined()
    expect(methods()).toEqual(['initialize', 'session/new', 'session/prompt'])
    expect(sent('initialize').params).toEqual({
      protocolVersion: 1,
      clientCapabilities: CLIENT_CAPABILITIES,
      clientInfo: { name: 'zumibot', title: 'ZumiBot', version: '1.0.0' }
    })
    expect(sent('session/new').params).toEqual({ cwd: ws(), mcpServers: [] })
    expect(sent('session/prompt').params).toEqual({ sessionId: 'fake-session-1', prompt: [{ type: 'text', text: 'hello' }] })
    expect(sent('initialize').jsonrpc).toBe('2.0')
    expect(pids().filter((p) => p.role === 'agent')).toHaveLength(1)
  })

  test('windows is {} when the agent never reports a context size', async () => {
    const { h } = run({ steps: [{ text: 'x' }] })
    expect((await h.done).result?.windows).toEqual({})
  })

  test('spawns the command with its args in the chat folder, with every ZUMIBOT_* name stripped from the env', async () => {
    const { h } = run({}, { args: [FAKE, '--acp', '--model=x'], extraEnv: { ZUMIBOT_TEST_SECRET: 'v', OTHER_NAME: 'kept' } })
    await h.done
    const [start] = lines(file('start.jsonl'))
    expect(start.argv).toEqual(['--acp', '--model=x'])
    expect(start.cwd).toBe(ws())
    expect(start.envKeys.filter((k: string) => k.startsWith('ZUMIBOT_'))).toEqual([])
    expect(start.envKeys).toContain('OTHER_NAME')
  })

  test('a tool call still open when the turn ends is closed with an error result before the result, so no row stays running', async () => {
    const { h, events } = run({
      steps: [{ toolCall: { toolCallId: 'r1', title: 'Read', kind: 'read', status: 'in_progress' } }, { text: 'ok' }]
    })
    await h.done
    const closing = of(events, 'toolResult')
    expect(closing).toEqual([{ kind: 'toolResult', toolUseId: 'tag-1:r1', content: ACP_TEXT.toolUnfinished, isError: true }])
    expect(kinds(events).indexOf('toolResult')).toBeLessThan(kinds(events).indexOf('result'))
  })

  test('max_tokens, max_turn_requests and refusal end with an error result and the fixed stop-reason sentence', async () => {
    for (const reason of ['max_tokens', 'max_turn_requests', 'refusal']) {
      const { h, events } = run({ steps: [{ text: 'part' }, { stopReason: reason }] })
      const out = await h.done
      expect(events.at(-1)).toMatchObject({ kind: 'result', subtype: reason, isError: true })
      expect(out.stderr).toBe(ACP_TEXT.stopReason(reason))
      expect(of(events, 'assistantText').map((e) => e.text)).toEqual(['part'])
      dir = join(root, `case-${n++}`)
      mkdirSync(join(dir, 'ws'), { recursive: true })
    }
  })

  test('a JSON-RPC error on session/prompt ends with no result and its message, cut to 500 characters', async () => {
    const { h, events } = run({ failPrompt: { code: -32603, message: 'x'.repeat(700) } })
    const out = await h.done
    expect(out.result).toBeNull()
    expect(out.stderr).toBe('x'.repeat(500))
    expect(events.some((e) => e.kind === 'result')).toBe(false)
  })

  test('an image or resource message chunk is dropped, with one log line per kind naming only the kind', async () => {
    const logged: string[] = []
    vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => {
      logged.push(a.map(String).join(' '))
    })
    const chunk = (content: object) => ({ update: { sessionUpdate: 'agent_message_chunk', content } })
    const { h, events } = run({
      steps: [
        chunk({ type: 'image', mimeType: 'image/png', data: 'SECRETDATA' }),
        chunk({ type: 'image', mimeType: 'image/png', data: 'SECRETDATA' }),
        chunk({ type: 'resource', resource: { uri: 'file:///x', text: 'SECRETTEXT' } }),
        { text: 'ok' }
      ]
    })
    await h.done
    expect(of(events, 'assistantText').map((e) => e.text)).toEqual(['ok'])
    const drops = logged.filter((l) => l.includes('dropped'))
    expect(drops).toHaveLength(2)
    expect(drops.some((l) => l.includes('image'))).toBe(true)
    expect(drops.some((l) => l.includes('resource'))).toBe(true)
    expect(logged.join('\n')).not.toMatch(/SECRET/)
  })
})

describe('startAcp: permissions, questions and other requests', () => {
  const exec = (id: string, command: string) => ({
    toolCall: { toolCallId: id, title: `Run ${command}`, kind: 'execute', status: 'pending', rawInput: { command } }
  })

  test('allow and deny select allow_once and reject_once, classified from the merged tool call', async () => {
    const results: boolean[] = []
    const { h, events } = run(
      {
        steps: [
          exec('c1', 'ls'),
          { permission: { toolCall: { toolCallId: 'c1' } } },
          exec('c2', 'rm -rf x'),
          { permission: { toolCall: { toolCallId: 'c2', title: 'Run rm' } } },
          { text: 'done' }
        ]
      },
      {
        react: (e, hh) => {
          if (e.kind !== 'permissionRequest') return
          const cmd = (e.input as { command: string }).command
          results.push(hh.send(cmd === 'ls' ? allowResponse(e.requestId, e.input) : denyResponse(e.requestId, 'No.')))
        }
      }
    )
    const out = await h.done
    expect(of(events, 'permissionRequest')).toEqual([
      {
        kind: 'permissionRequest',
        requestId: 'tag-1:0',
        toolName: 'Bash',
        input: { command: 'ls' },
        description: null,
        reason: null,
        toolUseId: 'tag-1:c1'
      },
      {
        kind: 'permissionRequest',
        requestId: 'tag-1:1',
        toolName: 'Bash',
        input: { command: 'rm -rf x' },
        description: null,
        reason: null,
        toolUseId: 'tag-1:c2'
      }
    ])
    expect(results).toEqual([true, true])
    expect(answers()).toEqual([
      { jsonrpc: '2.0', id: 0, result: { outcome: { outcome: 'selected', optionId: 'allow-once' } } },
      { jsonrpc: '2.0', id: 1, result: { outcome: { outcome: 'selected', optionId: 'reject-once' } } }
    ])
    expect(out.result?.isError).toBe(false)
  })

  test("every tool id carries the attempt's tag (rows, results, a card's row and plan rows), so a later attempt reusing an id never names an earlier row", async () => {
    const plan = { update: { sessionUpdate: 'plan', entries: [{ content: 'Step one', status: 'pending', priority: 'high' }] } }
    const script = {
      steps: [
        plan,
        { toolCall: { toolCallId: 'x1', kind: 'read', title: 'Read a', status: 'in_progress' } },
        { permission: { toolCall: { toolCallId: 'x1' } } },
        { toolUpdate: { toolCallId: 'x1', status: 'completed' } }
      ]
    }
    const ids = async (requestTag: string) => {
      const { h, events } = run(script, {
        requestTag,
        react: (e, hh) => {
          if (e.kind === 'permissionRequest') hh.send(allowResponse(e.requestId, e.input))
        }
      })
      await h.done
      return {
        uses: of(events, 'toolUse').map((e) => e.id),
        results: of(events, 'toolResult').map((e) => e.toolUseId),
        cards: of(events, 'permissionRequest').map((e) => e.toolUseId)
      }
    }
    expect(await ids('tag-a')).toEqual({
      uses: ['tag-a:acp-plan-1', 'tag-a:x1'],
      results: ['tag-a:acp-plan-1', 'tag-a:x1'],
      cards: ['tag-a:x1']
    })
    expect(await ids('tag-b')).toEqual({
      uses: ['tag-b:acp-plan-1', 'tag-b:x1'],
      results: ['tag-b:acp-plan-1', 'tag-b:x1'],
      cards: ['tag-b:x1']
    })
  })

  test('a permission for a call the stream never announced opens its row before the card', async () => {
    const { h, events } = run(
      { steps: [{ permission: { toolCall: { toolCallId: 'r9', kind: 'read', title: 'Read x', locations: [{ path: 'x' }] } } }] },
      {
        react: (e, hh) => {
          if (e.kind === 'permissionRequest') hh.send(allowResponse(e.requestId, e.input))
        }
      }
    )
    await h.done
    const use = events.findIndex((e) => e.kind === 'toolUse')
    const card = events.findIndex((e) => e.kind === 'permissionRequest')
    expect(use).toBeGreaterThan(-1)
    expect(use).toBeLessThan(card)
    expect(events[card]).toMatchObject({ toolName: 'AcpRead', input: { paths: ['x'] }, toolUseId: 'tag-1:r9' })
  })

  test('send answers only ids carrying its tag, once, and never throws on odd input', async () => {
    const results: boolean[] = []
    const { h } = run(
      { steps: [exec('c1', 'ls'), { permission: { toolCall: { toolCallId: 'c1' } } }] },
      {
        react: (e, hh) => {
          if (e.kind !== 'permissionRequest') return
          results.push(
            hh.send(allowResponse('0', {})),
            hh.send(allowResponse('tag-2:0', {})),
            hh.send(allowResponse('tag-1', {})),
            hh.send(allowResponse('tag-1:7', {})),
            hh.send({}),
            hh.send({ response: null }),
            hh.send(null as unknown as object)
          )
          results.push(hh.send(allowResponse(e.requestId, {})), hh.send(allowResponse(e.requestId, {})))
        }
      }
    )
    await h.done
    expect(results).toEqual([false, false, false, false, false, false, false, true, false])
    expect(answers()).toHaveLength(1)
    expect(h.send(allowResponse('tag-1:0', {}))).toBe(false)
  })

  test('an elicitation becomes an AskUserQuestion card, and its answer goes back as accept with the schema values', async () => {
    const requestedSchema = {
      type: 'object',
      properties: { color: { type: 'string', title: 'Color', enum: ['red', 'blue'] }, go: { type: 'boolean', title: 'Proceed' } },
      required: ['color']
    }
    const { h, events } = run(
      { steps: [{ elicitation: { message: 'Pick one', requestedSchema } }, { text: 'thanks' }] },
      {
        react: (e, hh) => {
          if (e.kind !== 'permissionRequest') return
          hh.send(allowResponse(e.requestId, { ...(e.input as object), answers: { Color: 'blue', Proceed: 'Yes' } }))
        }
      }
    )
    const out = await h.done
    const [card] = of(events, 'permissionRequest')
    expect(card).toMatchObject({ requestId: 'tag-1:0', toolName: 'AskUserQuestion', toolUseId: null })
    expect((card.input as { title: string; questions: unknown[] }).title).toBe('Pick one')
    expect((card.input as { questions: unknown[] }).questions).toHaveLength(2)
    expect(answers()).toEqual([{ jsonrpc: '2.0', id: 0, result: { action: 'accept', content: { color: 'blue', go: true } } }])
    expect(out.result?.isError).toBe(false)
  })

  test('Skip on a question card declines it', async () => {
    const requestedSchema = { type: 'object', properties: { name: { type: 'string' } } }
    const { h } = run(
      { steps: [{ elicitation: { requestedSchema } }] },
      {
        react: (e, hh) => {
          if (e.kind === 'permissionRequest') hh.send(denyResponse(e.requestId, 'skip'))
        }
      }
    )
    await h.done
    expect(answers()).toEqual([{ jsonrpc: '2.0', id: 0, result: { action: 'decline' } }])
  })

  test('an elicitation no card can show (a nested schema, or url mode) is declined at once, with no card', async () => {
    const { h, events } = run({
      steps: [
        { elicitation: { requestedSchema: { type: 'object', properties: { a: { type: 'object', properties: {} } } } } },
        { elicitation: { mode: 'url', url: 'https://example.com', message: 'Open it' } },
        { text: 'after' }
      ]
    })
    const out = await h.done
    expect(of(events, 'permissionRequest')).toEqual([])
    expect(answers()).toEqual([
      { jsonrpc: '2.0', id: 0, result: { action: 'decline' } },
      { jsonrpc: '2.0', id: 1, result: { action: 'decline' } }
    ])
    expect(out.result?.isError).toBe(false)
  })

  test('a request ZumiBot does not serve (fs, terminal, anything else) gets -32601 at once, with no event', async () => {
    const { h, events } = run({
      steps: [
        { request: { method: 'fs/read_text_file', params: { sessionId: 'fake-session-1', path: '/etc/hosts' } } },
        { request: { method: 'terminal/create', params: { sessionId: 'fake-session-1', command: 'ls' } } },
        { text: 'ok' }
      ]
    })
    const out = await h.done
    expect(answers()).toEqual([
      { jsonrpc: '2.0', id: 0, error: { code: -32601, message: expect.any(String) } },
      { jsonrpc: '2.0', id: 1, error: { code: -32601, message: expect.any(String) } }
    ])
    expect(events.some((e) => e.kind === 'controlUnknown' || e.kind === 'permissionRequest')).toBe(false)
    expect(out.result?.isError).toBe(false)
  })
})

describe('startAcp: rows named from late input (as claude-agent-acp 0.108.0 sends them)', () => {
  // The call first, with an empty rawInput; what it does only in later updates.
  const pending = (id: string, kind: string, title: string, toolName: string) => ({
    toolCall: { toolCallId: id, kind, title, status: 'pending', rawInput: {}, _meta: { claudeCode: { toolName } } }
  })
  const upd = (id: string, fields: object) => ({ toolUpdate: { toolCallId: id, ...fields } })
  const out = (t: string) => [{ type: 'content', content: { type: 'text', text: t } }]

  test("Bash, Edit and Read rows are named from the update that carries their input, with the edit's diff on its result", async () => {
    const f = join(ws(), 'f.txt')
    const { h, events } = run({
      steps: [
        pending('b1', 'execute', 'Terminal', 'Bash'),
        upd('b1', { rawInput: { command: 'ls' } }),
        upd('b1', { rawInput: { command: 'ls', description: 'List files' } }),
        upd('b1', { status: 'completed', content: out('f.txt') }),
        pending('e1', 'edit', 'Edit', 'Edit'),
        upd('e1', { rawInput: { file_path: f }, locations: [{ path: f }] }),
        upd('e1', { content: [{ type: 'diff', path: f, oldText: 'one\ntwo', newText: 'one\nTWO' }] }),
        upd('e1', { status: 'completed' }),
        pending('r1', 'read', 'Read', 'Read'),
        upd('r1', { rawInput: { file_path: f } }),
        upd('r1', { status: 'completed', content: out('one\nTWO') }),
        { text: 'done' }
      ]
    })
    const res = await h.done
    expect(res.result?.isError).toBe(false)
    expect(of(events, 'toolUse')).toEqual([
      { kind: 'toolUse', id: 'tag-1:b1', name: 'Bash', input: { command: 'ls' } },
      { kind: 'toolUse', id: 'tag-1:e1', name: 'AcpEdit', input: { paths: [f] } },
      { kind: 'toolUse', id: 'tag-1:r1', name: 'AcpRead', input: { paths: [f] } }
    ])
    expect(of(events, 'toolResult')).toEqual([
      { kind: 'toolResult', toolUseId: 'tag-1:b1', content: 'f.txt', isError: false },
      {
        kind: 'toolResult',
        toolUseId: 'tag-1:e1',
        content: f,
        isError: false,
        detail: { acpDiffs: [{ path: f, oldText: 'one\ntwo', newText: 'one\nTWO' }] }
      },
      { kind: 'toolResult', toolUseId: 'tag-1:r1', content: 'one\nTWO', isError: false }
    ])
  })

  test('a permission for a call whose row still waits: the row, named from the request, lands right before its card', async () => {
    const { h, events } = run(
      {
        steps: [
          pending('c1', 'execute', 'Terminal', 'Bash'),
          { permission: { toolCall: { toolCallId: 'c1', kind: 'execute', title: 'ls', rawInput: { command: 'ls' } } } },
          upd('c1', { rawInput: { command: 'ls', description: 'List' } }),
          upd('c1', { status: 'completed', content: out('ok') }),
          { text: 'done' }
        ]
      },
      {
        react: (e, hh) => {
          if (e.kind === 'permissionRequest') hh.send(allowResponse(e.requestId, e.input))
        }
      }
    )
    await h.done
    const use = events.findIndex((e) => e.kind === 'toolUse')
    expect(events[use]).toEqual({ kind: 'toolUse', id: 'tag-1:c1', name: 'Bash', input: { command: 'ls' } })
    expect(events[use + 1]).toMatchObject({ kind: 'permissionRequest', toolName: 'Bash', input: { command: 'ls' }, toolUseId: 'tag-1:c1' })
    expect(of(events, 'toolUse')).toHaveLength(1)
    expect(of(events, 'toolResult')).toEqual([{ kind: 'toolResult', toolUseId: 'tag-1:c1', content: 'ok', isError: false }])
  })

  test('a row still waiting when the turn ends is shown and closed before the result', async () => {
    const { h, events } = run({ steps: [pending('w1', 'execute', 'Terminal', 'Bash'), { text: 'ok' }] })
    await h.done
    expect(kinds(events)).toEqual(['init', 'textDelta', 'assistantText', 'toolUse', 'toolResult', 'result'])
    expect(of(events, 'toolUse')).toEqual([
      { kind: 'toolUse', id: 'tag-1:w1', name: 'AcpCall', input: { title: 'Terminal', rawInput: {} } }
    ])
    expect(of(events, 'toolResult')).toEqual([
      { kind: 'toolResult', toolUseId: 'tag-1:w1', content: ACP_TEXT.toolUnfinished, isError: true }
    ])
  })
})

describe('startAcp: sessions', () => {
  test('resume uses session/resume when advertised (preferred over load), with the given id', async () => {
    const { h, events } = run(
      { ...caps({ loadSession: true, sessionCapabilities: { resume: {} } }), sessions: ['s-old'] },
      {
        start: { kind: 'resume', sessionId: 's-old' }
      }
    )
    const out = await h.done
    expect(methods()).toEqual(['initialize', 'session/resume', 'session/prompt'])
    expect(sent('session/resume').params).toEqual({ sessionId: 's-old', cwd: ws(), mcpServers: [] })
    expect(events[0]).toMatchObject({ kind: 'init', sessionId: 's-old' })
    expect(sent('session/prompt').params.sessionId).toBe('s-old')
    expect(out.result?.sessionId).toBe('s-old')
    expect(out.missingSession).toBeUndefined()
  })

  test('load is used when only loadSession is advertised, and its replay is hidden', async () => {
    const replay = [
      { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'old question' } },
      { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'old reply' } },
      { sessionUpdate: 'tool_call', toolCallId: 'old-t', title: 'Old', kind: 'read', status: 'completed' },
      // A mode the session has since left: only the last replayed mode is the session's own.
      { sessionUpdate: 'current_mode_update', currentModeId: 'bypassPermissions' },
      { sessionUpdate: 'current_mode_update', currentModeId: 'default' }
    ]
    const { h, events } = run(
      { ...caps({ loadSession: true }), sessions: ['s-old'], replay, steps: [{ text: 'new reply' }] },
      {
        start: { kind: 'resume', sessionId: 's-old' }
      }
    )
    const out = await h.done
    expect(methods()).toEqual(['initialize', 'session/load', 'session/prompt'])
    expect(sent('session/load').params).toEqual({ sessionId: 's-old', cwd: ws(), mcpServers: [] })
    expect(kinds(events)).toEqual(['init', 'textDelta', 'assistantText', 'result'])
    expect(of(events, 'assistantText')[0].text).toBe('new reply')
    expect(out.spawnError).toBeNull()
  })

  test('an agent with neither resume nor load: missingSession marked noResume (a planned reseed), and no session request', async () => {
    const { h, events } = run({ sessions: ['s-old'] }, { start: { kind: 'resume', sessionId: 's-old' } })
    const out = await h.done
    expect(out.missingSession).toBe(true)
    expect(out.noResume).toBe(true)
    expect(methods()).toEqual(['initialize'])
    expect(events).toEqual([])
    expect(out).toMatchObject({ result: null, spawnError: null, stopped: false })
  })

  test('any error on resume or load (a session the agent no longer has) is missingSession, with no prompt', async () => {
    for (const c of [{ sessionCapabilities: { resume: {} } }, { loadSession: true }]) {
      const { h, events } = run({ ...caps(c), sessions: [] }, { start: { kind: 'resume', sessionId: 'gone' } })
      const out = await h.done
      expect(out.missingSession).toBe(true)
      // A lost session, not one the agent could never resume: the caller says so.
      expect(out.noResume).toBeUndefined()
      expect(out.spawnError).toBeNull()
      expect(methods()).not.toContain('session/prompt')
      expect(events).toEqual([])
      dir = join(root, `case-${n++}`)
      mkdirSync(join(dir, 'ws'), { recursive: true })
    }
    const { h } = run(
      { ...caps({ loadSession: true }), sessions: ['s'], failResume: -32603 },
      { start: { kind: 'resume', sessionId: 's' } }
    )
    expect((await h.done).missingSession).toBe(true)
  })

  test('auth required on session/new is the fixed sign-in sentence naming the auth methods', async () => {
    const { h, events } = run({
      initialize: { authMethods: [{ id: 'oauth-personal', name: 'Google login' }, { id: 'api-key' }] },
      failNew: -32000
    })
    const out = await h.done
    expect(out.spawnError).toBe(ACP_TEXT.notSignedIn(['Google login', 'api-key']))
    expect(out.result).toBeNull()
    expect(methods()).toEqual(['initialize', 'session/new'])
    expect(events).toEqual([])
  })

  test('auth required on a load is the sign-in sentence too, not a missing session', async () => {
    const { h } = run(
      { ...caps({ loadSession: true }), sessions: ['s'], failResume: -32000 },
      { start: { kind: 'resume', sessionId: 's' } }
    )
    const out = await h.done
    expect(out.spawnError).toBe(ACP_TEXT.notSignedIn([]))
    expect(out.missingSession).toBeUndefined()
  })

  test('a protocol version other than 1 is refused before any session', async () => {
    const { h } = run({ initialize: { protocolVersion: 2 } })
    const out = await h.done
    expect(out.spawnError).toBe(ACP_TEXT.protocol)
    expect(methods()).toEqual(['initialize'])
  })

  test('an unreadable reply to its own request (no session id) ends the run with the fixed sentence', async () => {
    const { h, events } = run({ newResult: { sessionId: 42 } })
    const out = await h.done
    expect(out.spawnError).toBe(ACP_TEXT.unreadable)
    expect(methods()).toEqual(['initialize', 'session/new'])
    expect(events).toEqual([])
  })
})

describe('startAcp: instructions and attachments', () => {
  test('without systemPrompt support the instructions lead the first prompt of a new session as a preamble', async () => {
    const { h } = run({}, { systemPrompt: 'Be terse.' })
    await h.done
    expect(sent('session/new').params).toEqual({ cwd: ws(), mcpServers: [] })
    expect(sent('session/prompt').params.prompt).toEqual([
      { type: 'text', text: acpPreamble('Be terse.') },
      { type: 'text', text: 'hello' }
    ])
    expect(acpPreamble('Be terse.')).toContain('Be terse.')
  })

  test('with systemPrompt support they go in session/new, and again on resume; the prompt carries no preamble', async () => {
    const c = caps({ sessionCapabilities: { systemPrompt: {}, resume: {} } })
    const systemPrompt = { mode: 'append', content: [{ type: 'text', text: 'Be terse.' }] }
    const first = run(c, { systemPrompt: 'Be terse.' })
    await first.h.done
    expect(sent('session/new').params).toEqual({ cwd: ws(), mcpServers: [], systemPrompt })
    expect(sent('session/prompt').params.prompt).toEqual([{ type: 'text', text: 'hello' }])
    dir = join(root, `case-${n++}`)
    mkdirSync(join(dir, 'ws'), { recursive: true })
    const again = run({ ...c, sessions: ['s'] }, { systemPrompt: 'Be terse.', start: { kind: 'resume', sessionId: 's' } })
    await again.h.done
    expect(sent('session/resume').params).toEqual({ sessionId: 's', cwd: ws(), mcpServers: [], systemPrompt })
  })

  test('a resume without systemPrompt support adds no preamble (the session already had it)', async () => {
    const { h } = run(
      { ...caps({ loadSession: true }), sessions: ['s'] },
      { systemPrompt: 'Be terse.', start: { kind: 'resume', sessionId: 's' } }
    )
    await h.done
    expect(sent('session/load').params).toEqual({ sessionId: 's', cwd: ws(), mcpServers: [] })
    expect(sent('session/prompt').params.prompt).toEqual([{ type: 'text', text: 'hello' }])
  })

  const withImage: UserContent = [
    { type: 'text', text: 'see' },
    { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } }
  ]

  test('an image to an agent without image prompts fails the run with the fixed sentence, before any session', async () => {
    const { h, events } = run({}, { prompt: withImage })
    const out = await h.done
    expect(out.spawnError).toBe(ACP_TEXT.noImages)
    expect(methods()).toEqual(['initialize'])
    expect(events).toEqual([])
  })

  test('an image goes as an image block when the agent takes images', async () => {
    const { h } = run(caps({ promptCapabilities: { image: true } }), { prompt: withImage })
    await h.done
    expect(sent('session/prompt').params.prompt).toEqual([
      { type: 'text', text: 'see' },
      { type: 'image', mimeType: 'image/png', data: 'AAAA' }
    ])
  })
})

describe('startAcp: refused modes', () => {
  test('a bypass mode reported mid-turn ends the turn with the fixed sentence; no further call gets a card', async () => {
    const { h, events } = run({
      steps: [
        { hold: true },
        { text: 'hi' },
        { mode: 'bypassPermissions' },
        { permission: { toolCall: { toolCallId: 'c1', kind: 'execute', rawInput: { command: 'rm -rf /' } } } },
        { text: 'never' }
      ]
    })
    const out = await h.done
    expect(out.spawnError).toBe(ACP_TEXT.refusedMode('bypassPermissions'))
    expect(out.result).toBeNull()
    expect(of(events, 'permissionRequest')).toEqual([])
    expect(of(events, 'assistantText').map((e) => e.text)).toEqual(['hi'])
    expect(answers().some((m) => m.result?.outcome?.outcome === 'selected')).toBe(false)
    // The whole group ends, the child the agent left included, not just the agent.
    const all = pids()
    expect(all.map((p) => p.role).sort()).toEqual(['agent', 'hold'])
    for (const p of all) expect(await goneWithin(p.pid, 3000)).toBe(true)
  }, 10_000)

  const bypass = { sessionUpdate: 'current_mode_update', currentModeId: 'bypassPermissions' }
  const modeOption = (value: string) => ({
    sessionUpdate: 'config_option_update',
    configOptions: [{ id: 'mode', name: 'Mode', category: 'mode', type: 'select', currentValue: value, options: [] }]
  })

  test("a mode reported in the same chunk right after a load's answer is checked: the replay ends at that answer", async () => {
    for (const after of [bypass, modeOption('yolo')]) {
      const { h, events } = run(
        {
          ...caps({ loadSession: true }),
          sessions: ['s-old'],
          replay: [{ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'old' } }],
          afterStart: [after],
          steps: [{ text: 'never' }]
        },
        { start: { kind: 'resume', sessionId: 's-old' } }
      )
      const out = await h.done
      expect(out.spawnError).toBe(ACP_TEXT.refusedMode(after === bypass ? 'bypassPermissions' : 'yolo'))
      expect(methods()).toEqual(['initialize', 'session/load'])
      expect(events).toEqual([])
      dir = join(root, `case-${n++}`)
      mkdirSync(join(dir, 'ws'), { recursive: true })
    }
  })

  test('a refused mode a load replays, with no mode in its answer, ends the run before the prompt', async () => {
    for (const replay of [[bypass], [modeOption('dangerous-auto')]]) {
      const { h, events } = run(
        { ...caps({ loadSession: true }), sessions: ['s-old'], replay, steps: [{ text: 'never' }] },
        {
          start: { kind: 'resume', sessionId: 's-old' }
        }
      )
      const out = await h.done
      expect(out.spawnError).toBe(ACP_TEXT.refusedMode(replay[0] === bypass ? 'bypassPermissions' : 'dangerous-auto'))
      expect(methods()).toEqual(['initialize', 'session/load'])
      expect(events).toEqual([])
      dir = join(root, `case-${n++}`)
      mkdirSync(join(dir, 'ws'), { recursive: true })
    }
  })

  test('a load answer that names the current mode wins over the replayed one', async () => {
    const { h } = run(
      {
        ...caps({ loadSession: true }),
        sessions: ['s-old'],
        replay: [bypass],
        resumeResult: { modes: { currentModeId: 'default', availableModes: [] } },
        steps: [{ text: 'ok' }]
      },
      { start: { kind: 'resume', sessionId: 's-old' } }
    )
    const out = await h.done
    expect(out.spawnError).toBeNull()
    expect(out.result?.isError).toBe(false)
  })

  test('before the session is known only a mode counts: text and tool updates are dropped, a refused mode ends the run', async () => {
    const early = [
      { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'early' } },
      { sessionUpdate: 'tool_call', toolCallId: 'pre', title: 'Early', kind: 'read', status: 'in_progress' }
    ]
    const first = run({ beforeStart: early, afterStart: early, steps: [{ text: 'reply' }] })
    const out = await first.h.done
    expect(out.spawnError).toBeNull()
    expect(kinds(first.events)).toEqual(['init', 'textDelta', 'assistantText', 'result'])
    expect(of(first.events, 'assistantText').map((e) => e.text)).toEqual(['reply'])
    dir = join(root, `case-${n++}`)
    mkdirSync(join(dir, 'ws'), { recursive: true })
    const second = run({ beforeStart: [...early, bypass], steps: [{ text: 'never' }] })
    const refused = await second.h.done
    expect(refused.spawnError).toBe(ACP_TEXT.refusedMode('bypassPermissions'))
    expect(methods()).toEqual(['initialize', 'session/new'])
    expect(second.events).toEqual([])
  })

  test('a refused mode or mode config value at the session start ends the run before the prompt', async () => {
    for (const newResult of [
      { modes: { currentModeId: 'yolo', availableModes: [{ id: 'yolo', name: 'YOLO' }] } },
      { configOptions: [{ id: 'mode', name: 'Mode', category: 'mode', type: 'select', currentValue: 'dangerous-auto', options: [] }] }
    ]) {
      const { h, events } = run({ newResult })
      const out = await h.done
      const id = newResult.modes ? 'yolo' : 'dangerous-auto'
      expect(out.spawnError).toBe(ACP_TEXT.refusedMode(id))
      expect(methods()).toEqual(['initialize', 'session/new'])
      expect(events).toEqual([])
      dir = join(root, `case-${n++}`)
      mkdirSync(join(dir, 'ws'), { recursive: true })
    }
  })

  test('a plain mode is fine', async () => {
    const { h } = run({ newResult: { modes: { currentModeId: 'default', availableModes: [] } }, steps: [{ mode: 'plan' }, { text: 'x' }] })
    const out = await h.done
    expect(out.spawnError).toBeNull()
    expect(out.result?.isError).toBe(false)
  })
})

describe('startAcp: the asking mode', () => {
  const offered = (current: string) => ({
    modes: {
      currentModeId: current,
      availableModes: ['default', 'acceptEdits', 'plan', 'auto', 'bypassPermissions'].map((id) => ({ id, name: id }))
    }
  })
  const fresh = () => {
    dir = join(root, `case-${n++}`)
    mkdirSync(join(dir, 'ws'), { recursive: true })
  }

  test('a new session in another mode is put in `default` before the prompt, and the turn runs', async () => {
    const { h, events } = run({ newResult: offered('auto'), steps: [{ text: 'hi' }] })
    const out = await h.done
    expect(out.spawnError).toBeNull()
    expect(out.result?.isError).toBe(false)
    expect(methods()).toEqual(['initialize', 'session/new', 'session/set_mode', 'session/prompt'])
    expect(sent('session/set_mode').params).toEqual({ sessionId: 'fake-session-1', modeId: 'default' })
    // The agent's own update for the switch is no row and no text.
    expect(kinds(events)).toEqual(['init', 'textDelta', 'assistantText', 'result'])
  })

  test('a resumed session is put back in `default` on every turn', async () => {
    const { h } = run(
      {
        ...caps({ sessionCapabilities: { resume: {} } }),
        sessions: ['s-old'],
        resumeResult: offered('acceptEdits'),
        steps: [{ text: 'ok' }]
      },
      {
        start: { kind: 'resume', sessionId: 's-old' }
      }
    )
    expect((await h.done).spawnError).toBeNull()
    expect(methods()).toEqual(['initialize', 'session/resume', 'session/set_mode', 'session/prompt'])
    expect(sent('session/set_mode').params).toEqual({ sessionId: 's-old', modeId: 'default' })
  })

  test('a session already in `default`, or an agent that offers no `default`, gets no switch', async () => {
    for (const newResult of [
      offered('default'),
      {
        modes: {
          currentModeId: 'build',
          availableModes: [
            { id: 'build', name: 'Build' },
            { id: 'plan', name: 'Plan' }
          ]
        }
      },
      {}
    ]) {
      const { h } = run({ newResult, steps: [{ text: 'ok' }] })
      expect((await h.done).spawnError).toBeNull()
      expect(methods()).toEqual(['initialize', 'session/new', 'session/prompt'])
      fresh()
    }
  })

  test('an agent with its modes only as a config option is switched through that option', async () => {
    const opts = [
      { value: 'default', name: 'Ask' },
      { value: 'auto', name: 'Auto' }
    ]
    const { h } = run({
      newResult: {
        configOptions: [{ id: 'approval', name: 'Mode', category: 'mode', type: 'select', currentValue: 'auto', options: opts }]
      },
      steps: [{ text: 'ok' }]
    })
    expect((await h.done).spawnError).toBeNull()
    expect(methods()).toEqual(['initialize', 'session/new', 'session/set_config_option', 'session/prompt'])
    expect(sent('session/set_config_option').params).toEqual({ sessionId: 'fake-session-1', configId: 'approval', value: 'default' })
  })

  test('a switch the agent refuses ends the run before the prompt with the fixed sentence; signed out says so', async () => {
    const refused = run({ newResult: offered('auto'), failSetMode: -32603, steps: [{ text: 'never' }] })
    const out = await refused.h.done
    expect(out.spawnError).toBe(ACP_TEXT.askModeFailed)
    expect(out.result).toBeNull()
    expect(methods()).toEqual(['initialize', 'session/new', 'session/set_mode'])
    expect(refused.events).toEqual([])
    fresh()
    const signedOut = run({ newResult: offered('auto'), failSetMode: -32000, steps: [{ text: 'never' }] })
    expect((await signedOut.h.done).spawnError).toBe(ACP_TEXT.notSignedIn([]))
    expect(methods()).toEqual(['initialize', 'session/new', 'session/set_mode'])
  })

  test('a refused mode at the start still ends the run, even when `default` is offered: nothing is switched', async () => {
    const { h, events } = run({ newResult: offered('bypassPermissions'), steps: [{ text: 'never' }] })
    expect((await h.done).spawnError).toBe(ACP_TEXT.refusedMode('bypassPermissions'))
    expect(methods()).toEqual(['initialize', 'session/new'])
    expect(events).toEqual([])
  })

  test('a turn with a switch still shows a card for each call the agent asks about', async () => {
    const { h, events } = run(
      {
        newResult: offered('auto'),
        steps: [
          { permission: { toolCall: { toolCallId: 'c1', title: 'ls', kind: 'execute', rawInput: { command: 'ls' } } } },
          { text: 'done' }
        ]
      },
      {
        react: (e, hh) => {
          if (e.kind === 'permissionRequest') hh.send(allowResponse(e.requestId, e.input))
        }
      }
    )
    expect((await h.done).spawnError).toBeNull()
    expect(of(events, 'permissionRequest')).toHaveLength(1)
    expect(methods()).toEqual(['initialize', 'session/new', 'session/set_mode', 'session/prompt'])
  })

  const modeOption = (current: string) => ({
    id: 'mode',
    name: 'Mode',
    category: 'mode',
    type: 'select',
    currentValue: current,
    options: [
      { value: 'default', name: 'Manual' },
      { value: 'auto', name: 'Auto' }
    ]
  })

  test("the Claude adapter's start (modes, mirrored as a mode config option) takes one set_config_option on that option", async () => {
    const { h } = run({ newResult: { ...offered('auto'), configOptions: [modeOption('auto')] }, steps: [{ text: 'ok' }] })
    expect((await h.done).spawnError).toBeNull()
    expect(methods()).toEqual(['initialize', 'session/new', 'session/set_config_option', 'session/prompt'])
    expect(sent('session/set_config_option').params).toEqual({ sessionId: 'fake-session-1', configId: 'mode', value: 'default' })
  })

  test('a session loaded with its history is switched too, after the replay', async () => {
    const { h, events } = run(
      {
        ...caps({ loadSession: true }),
        sessions: ['s-old'],
        replay: [{ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'old' } }],
        resumeResult: offered('auto'),
        steps: [{ text: 'new' }]
      },
      { start: { kind: 'resume', sessionId: 's-old' } }
    )
    expect((await h.done).spawnError).toBeNull()
    expect(methods()).toEqual(['initialize', 'session/load', 'session/set_mode', 'session/prompt'])
    expect(of(events, 'assistantText').map((e) => e.text)).toEqual(['new'])
  })

  test('a refused mode the agent reports in reaction to the switch ends the run before the prompt', async () => {
    // set_mode: the agent's update names the mode; set_config_option: its answer does.
    for (const newResult of [offered('auto'), { configOptions: [modeOption('auto')] }]) {
      const { h, events } = run({ newResult, setModeEcho: 'bypassPermissions', steps: [{ text: 'never' }] })
      const out = await h.done
      expect(out.spawnError).toBe(ACP_TEXT.refusedMode('bypassPermissions'))
      expect(out.result).toBeNull()
      expect(methods()).not.toContain('session/prompt')
      expect(events).toEqual([])
      fresh()
    }
  })

  test('a set_config_option answer that leaves the option off `default`, or an error on it, ends the run before the prompt', async () => {
    for (const script of [{ setModeEcho: 'auto' }, { failSetMode: -32602 }]) {
      const { h, events } = run({ newResult: { configOptions: [modeOption('acceptEdits')] }, ...script, steps: [{ text: 'never' }] })
      const out = await h.done
      expect(out.spawnError).toBe(ACP_TEXT.askModeFailed)
      expect(methods()).toEqual(['initialize', 'session/new', 'session/set_config_option'])
      expect(events).toEqual([])
      fresh()
    }
  })

  test('Stop while the switch waits for its answer ends the run as stopped: no init, no prompt', async () => {
    const { h, events } = run({ newResult: offered('auto'), stallSetMode: true, steps: [{ text: 'never' }] }, { killGraceMs: 200 })
    for (let i = 0; i < 100 && !methods().includes('session/set_mode'); i++) await new Promise((r) => setTimeout(r, 20))
    expect(methods()).toContain('session/set_mode')
    h.stop()
    const out = await h.done
    expect(out.stopped).toBe(true)
    expect(out.spawnError).toBeNull()
    expect(out.result).toBeNull()
    expect(methods()).not.toContain('session/prompt')
    expect(events).toEqual([])
  })

  test('an agent that exits during the switch ends the run with the exit sentence; nothing is prompted', async () => {
    const { h, events } = run({ newResult: offered('auto'), stallSetMode: 'crash', steps: [{ text: 'never' }] })
    const out = await h.done
    expect(out.exitCode).toBe(4)
    expect(out.stderr).toContain(ACP_TEXT.stopped(4))
    expect(out.result).toBeNull()
    expect(methods()).toEqual(['initialize', 'session/new', 'session/set_mode'])
    expect(events).toEqual([])
  })
})

describe('startAcp: crashes and bad output', () => {
  test('a crash mid-turn keeps the partial text and closes open calls; the error has the exit code and the stderr tail', async () => {
    const { h, events } = run({
      steps: [
        { text: 'partial' },
        { toolCall: { toolCallId: 't1', title: 'Read', kind: 'read', status: 'in_progress' } },
        { stderr: 'boom trace' },
        { crash: 1 }
      ]
    })
    const out = await h.done
    expect(of(events, 'assistantText').map((e) => e.text)).toEqual(['partial'])
    expect(of(events, 'toolResult')).toEqual([
      { kind: 'toolResult', toolUseId: 'tag-1:t1', content: ACP_TEXT.toolUnfinished, isError: true }
    ])
    expect(out.exitCode).toBe(1)
    expect(out.result).toBeNull()
    expect(out.spawnError).toBeNull()
    expect(out.stderr).toContain(ACP_TEXT.stopped(1))
    expect(out.stderr).toContain('boom trace')
  })

  test('a malformed line is dropped and the turn goes on', async () => {
    const { h, events } = run({ steps: [{ text: 'a' }, { malformed: 1 }, { text: 'b' }] })
    const out = await h.done
    expect(of(events, 'assistantText').map((e) => e.text)).toEqual(['ab'])
    expect(out.result?.isError).toBe(false)
    expect(out.spawnError).toBeNull()
  })

  test('too many malformed lines end the run with the unreadable sentence', async () => {
    const { h } = run({ steps: [{ malformed: 1001 }, { sleep: 10000 }] })
    const out = await h.done
    expect(out.spawnError).toBe(ACP_TEXT.unreadable)
    expect(out.result).toBeNull()
  }, 10_000)

  test('a line over maxLineBytes kills the group and ends the run with the unreadable sentence', async () => {
    const t = Date.now()
    const { h, events } = run({ steps: [{ text: 'small' }, { text: 'x'.repeat(5000) }, { sleep: 30000 }] }, { maxLineBytes: 2000 })
    const out = await h.done
    expect(Date.now() - t).toBeLessThan(5000)
    expect(out.spawnError).toBe(ACP_TEXT.unreadable)
    expect(out.result).toBeNull()
    expect(of(events, 'textDelta').map((e) => e.text)).toEqual(['small'])
    for (const p of pids()) expect(await goneWithin(p.pid, 3000)).toBe(true)
  }, 10_000)
})

describe('startAcp: stop and lifecycle', () => {
  test('Stop with a card open: session/cancel, the card answered cancelled, and no pid of the group left alive', async () => {
    const { h, events } = run(
      {
        steps: [
          { hold: true },
          { text: 'x' },
          { permission: { toolCall: { toolCallId: 'c1', kind: 'execute', rawInput: { command: 'ls' } } } },
          { text: 'never' }
        ]
      },
      {
        react: (e, hh) => {
          if (e.kind === 'permissionRequest') hh.stop()
        }
      }
    )
    const out = await h.done
    expect(out.stopped).toBe(true)
    expect(log().filter((m) => m.method === 'session/cancel')).toEqual([
      { jsonrpc: '2.0', method: 'session/cancel', params: { sessionId: 'fake-session-1' } }
    ])
    expect(answers()).toEqual([{ jsonrpc: '2.0', id: 0, result: { outcome: { outcome: 'cancelled' } } }])
    expect(events).toContainEqual({ kind: 'permissionCancel', requestId: 'tag-1:0' })
    expect(events.at(-1)).toMatchObject({ kind: 'result', subtype: 'cancelled', isError: false })
    expect(of(events, 'textDelta').map((e) => e.text)).toEqual(['x'])
    expect(h.send(allowResponse('tag-1:0', {}))).toBe(false)
    const all = pids()
    expect(all.map((p) => p.role).sort()).toEqual(['agent', 'hold'])
    for (const p of all) expect(await goneWithin(p.pid, 3000)).toBe(true)
  }, 10_000)

  test('an answer sent after Stop goes nowhere', async () => {
    let after: boolean | null = null
    const { h } = run(
      { steps: [{ permission: { toolCall: { toolCallId: 'c1', kind: 'read' } } }] },
      {
        react: (e, hh) => {
          if (e.kind !== 'permissionRequest') return
          hh.stop()
          after = hh.send(allowResponse(e.requestId, {}))
        }
      }
    )
    await h.done
    expect(after).toBe(false)
    expect(answers()).toEqual([{ jsonrpc: '2.0', id: 0, result: { outcome: { outcome: 'cancelled' } } }])
  }, 10_000)

  // POSIX: the SIGTERM/SIGKILL ladder and its grace; Windows ends the tree with taskkill at once.
  test.skipIf(process.platform === 'win32')(
    'Stop on an agent that ignores session/cancel: after the grace, SIGTERM to the group',
    async () => {
      const { h } = run(
        { ignoreCancel: true, stayOpen: true, steps: [{ text: 'x' }, { sleep: 60000 }] },
        {
          killGraceMs: 100,
          react: (e, hh) => {
            if (e.kind === 'textDelta') hh.stop()
          }
        }
      )
      const out = await h.done
      expect(out.stopped).toBe(true)
      expect(out.signal).toBe('SIGTERM')
    },
    10_000
  )

  // POSIX: the SIGTERM/SIGKILL ladder and its grace; Windows ends the tree with taskkill at once.
  test.skipIf(process.platform === 'win32')(
    'then SIGKILL when SIGTERM is ignored too',
    async () => {
      const t = Date.now()
      const { h } = run(
        { ignoreCancel: true, stayOpen: true, ignoreSigterm: true, steps: [{ text: 'x' }, { sleep: 60000 }] },
        {
          killGraceMs: 100,
          killForceMs: 200,
          react: (e, hh) => {
            if (e.kind === 'textDelta') hh.stop()
          }
        }
      )
      const out = await h.done
      expect(out.signal).toBe('SIGKILL')
      expect(out.stopped).toBe(true)
      expect(Date.now() - t).toBeLessThan(5000)
    },
    10_000
  )

  test('a missing folder is a spawn error and nothing runs', async () => {
    const { h, events } = run({}, { cwd: '/nope/xyz' })
    const out = await h.done
    expect(out.spawnError).toBe('Folder not found: /nope/xyz')
    expect(events).toEqual([])
    expect(existsSync(file('log.jsonl'))).toBe(false)
  })

  test('a bad bin is a spawn error', async () => {
    const { h } = run({}, { bin: '/nope/agent' })
    const out = await h.done
    expect(out.spawnError).toContain('ENOENT')
    expect(out.exitCode).toBeNull()
  })

  test('stop before the process starts runs nothing', async () => {
    const { h, events } = run()
    h.stop()
    const out = await h.done
    expect(out.stopped).toBe(true)
    expect(events).toEqual([])
    expect(existsSync(file('log.jsonl'))).toBe(false)
  })

  test('stop and send after the end are no-ops', async () => {
    const { h } = run()
    const out = await h.done
    expect(() => {
      h.stop()
      h.stop()
    }).not.toThrow()
    expect(out.stopped).toBe(false)
    expect(h.send(allowResponse('tag-1:0', {}))).toBe(false)
  })
})

// Linux: sessions, process groups and /proc (Windows has none of them; the runner ends the tree with taskkill there). The
// walk past the group is Linux-only (procTree.ts): on macOS a child in a session of its own outlives the attempt.
describe.skipIf(process.platform !== 'linux')('startAcp: the whole process tree ends with the attempt', () => {
  // Running, not a zombie waiting for its new parent to reap it.
  const running = (pid: number) => {
    try {
      return readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1]?.[0] !== 'Z'
    } catch {
      return false
    }
  }
  async function endedWithin(pid: number, ms: number): Promise<boolean> {
    for (const end = Date.now() + ms; Date.now() < end;) {
      if (!running(pid)) return true
      await new Promise((r) => setTimeout(r, 25))
    }
    return !running(pid)
  }
  // A failing case must not leave its sleeps behind: only pids the fake recorded, and only while each is still a sleep, the
  // middle child (whose code names sleep), a trap child (whose code names SIGTERM) or the fake itself.
  afterEach(() => {
    for (const p of pids()) {
      let cmd = ''
      try {
        cmd = readFileSync(`/proc/${p.pid}/cmdline`, 'utf8')
      } catch {
        continue
      }
      if (/sleep|SIGTERM|fake-acp-agent/.test(cmd))
        try {
          process.kill(p.pid, 'SIGKILL')
        } catch {
          /* gone */
        }
    }
  })
  async function allEnded(roles: string[]) {
    const all = pids()
    expect(all.map((p) => p.role).sort()).toEqual([...roles].sort())
    for (const p of all) expect(await endedWithin(p.pid, 3000), `${p.role} ${p.pid} still runs`).toBe(true)
  }

  // A child of the agent in a session of its own, and a child in the agent's group whose own child runs in a session of its
  // own (claude-agent-acp's CLI and its Bash shell): a group kill misses both sleeps.
  const holds = [{ hold: 'session' }, { hold: 'nested' }]
  const ALL = ['agent', 'session', 'middle', 'nested']

  test('a normal turn end (stdin closed, the agent exits on its own) ends the tree', async () => {
    const { h } = run({ steps: [...holds, { text: 'ok' }] })
    const out = await h.done
    expect(out.result?.isError).toBe(false)
    await allEnded(ALL)
  }, 15_000)

  test('Stop with a card open ends the tree', async () => {
    const { h } = run(
      {
        steps: [...holds, { text: 'x' }, { permission: { toolCall: { toolCallId: 'c1', kind: 'execute', rawInput: { command: 'ls' } } } }]
      },
      {
        react: (e, hh) => {
          if (e.kind === 'permissionRequest') hh.stop()
        }
      }
    )
    const out = await h.done
    expect(out.stopped).toBe(true)
    await allEnded(ALL)
  }, 15_000)

  test('Stop on an agent that ignores the cancel and SIGTERM ends the tree after the force grace', async () => {
    const { h } = run(
      { ignoreCancel: true, stayOpen: true, ignoreSigterm: true, steps: [...holds, { text: 'x' }, { sleep: 60000 }] },
      {
        killGraceMs: 100,
        killForceMs: 200,
        react: (e, hh) => {
          if (e.kind === 'textDelta') hh.stop()
        }
      }
    )
    expect((await h.done).signal).toBe('SIGKILL')
    await allEnded(ALL)
  }, 15_000)

  test('a refused mode ends the tree', async () => {
    const { h } = run({ steps: [...holds, { mode: 'bypassPermissions' }, { sleep: 30000 }] })
    expect((await h.done).spawnError).toBe(ACP_TEXT.refusedMode('bypassPermissions'))
    await allEnded(ALL)
  }, 15_000)

  test('a line over the cap ends the tree', async () => {
    const { h } = run({ steps: [...holds, { text: 'x'.repeat(5000) }, { sleep: 30000 }] }, { maxLineBytes: 2000 })
    expect((await h.done).spawnError).toBe(ACP_TEXT.unreadable)
    await allEnded(ALL)
  }, 15_000)

  // A Bash command cleaning up (a git index.lock) needs the grace between SIGTERM and SIGKILL, also once the agent has exited.
  const graceRoles = async () => {
    const all = pids()
    const graceful = all.find((p) => p.role === 'graceful')!
    const stubborn = all.find((p) => p.role === 'stubborn')!
    // `done` has resolved: the stubborn child ignored its SIGTERM and still runs until the force grace's SIGKILL.
    expect(running(stubborn.pid)).toBe(true)
    expect(await endedWithin(graceful.pid, 3000)).toBe(true)
    expect(pids().some((p) => p.role === 'cleaned' && p.pid === graceful.pid)).toBe(true)
    expect(await endedWithin(stubborn.pid, 5000), 'the SIGKILL after the force grace').toBe(true)
  }
  const traps = [{ hold: 'graceful', ms: 300 }, { hold: 'stubborn' }]

  test('after a normal turn end the tree gets SIGTERM, then SIGKILL only after the force grace; done does not wait for it', async () => {
    const { h } = run({ steps: [...traps, { text: 'ok' }] }, { killForceMs: 1500 })
    expect((await h.done).result?.isError).toBe(false)
    await graceRoles()
  }, 15_000)

  test('after Stop the tree gets the same grace, counted from its SIGTERM', async () => {
    const { h } = run(
      { ignoreCancel: true, steps: [...traps, { text: 'x' }, { sleep: 60000 }] },
      {
        killGraceMs: 100,
        killForceMs: 1500,
        react: (e, hh) => {
          if (e.kind === 'textDelta') hh.stop()
        }
      }
    )
    expect((await h.done).stopped).toBe(true)
    await graceRoles()
  }, 15_000)

  test("a crash, with no snapshot before it: what is left in the agent's session, and below it, still ends", async () => {
    const { h } = run({ steps: [{ hold: 'nested' }, { crash: 1 }] })
    expect((await h.done).exitCode).toBe(1)
    await allEnded(['agent', 'middle', 'nested'])
  }, 15_000)
})
