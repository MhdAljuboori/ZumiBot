import { describe, expect, it } from 'vitest'
import { engineCaps } from '@zumibot/shared/engine'
import { aguiEngine, aguiStartOf, type AguiRunRequest, type AguiTurnConfig } from '../../src/core/engines/aguiEngine'
import { turnStart, type RunHandle } from '../../src/core/engines/engine'

const handle: RunHandle = {
  stop: () => {},
  send: () => false,
  done: Promise.resolve({ exitCode: null, signal: null, stderr: '', spawnError: null, result: null, stopped: false })
}
const onEvent = () => {}
const onThread = () => {}
const config: AguiTurnConfig = {
  endpoint: 'https://agents.example/run',
  headers: { Authorization: 'Bearer v' },
  authKey: 'AGENT_KEY',
  messages: [{ id: 'u1', role: 'user', content: 'hi' }],
  thread: { v: 1, threadId: 't-old', state: { a: 1 }, interrupts: [] },
  onThread,
  requestTag: 'tag-1'
}

describe('aguiStartOf', () => {
  it('mints a thread for a new session and resumes the stored one', () => {
    expect(aguiStartOf(turnStart(null), () => 'minted')).toBe('minted')
    expect(aguiStartOf(turnStart('t-1'), () => 'minted')).toBe('t-1')
  })

  it('mints a UUID by default', () => {
    expect(aguiStartOf(turnStart(null))).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
  })

  it('throws on a fork, which never reaches AG-UI (rewind is off: the caller reseeds on a new thread)', () => {
    expect(() => aguiStartOf(turnStart('t-1', 'u1'))).toThrow()
  })
})

describe('aguiEngine', () => {
  const locates: Array<string | undefined> = []
  const seen: AguiRunRequest[] = []
  const adapter = aguiEngine({
    caps: () => engineCaps('claude'),
    locate: async (agent) => {
      locates.push(agent)
      return 'https://agents.example/run'
    },
    run: (o) => {
      seen.push(o)
      return handle
    }
  })

  it('is the ag-ui engine, and reads caps and locate through its deps, passing the agent name', async () => {
    expect(adapter.engine).toBe('ag-ui')
    expect(adapter.caps()).toEqual(engineCaps('claude'))
    expect(await adapter.locate('remote')).toBe('https://agents.example/run')
    expect(locates).toEqual(['remote'])
  })

  it('starts a run with its own config and the resumed thread; the turn folder, env and prompt stay local', () => {
    seen.length = 0
    const turn = {
      bin: 'https://agents.example/run',
      cwd: '/w',
      env: { SECRET: 'x' },
      start: turnStart('t-1'),
      action: { kind: 'turn' as const, prompt: 'hi' },
      onEvent
    }
    expect(adapter.start(turn, config)).toBe(handle)
    expect(seen).toEqual([
      {
        endpoint: 'https://agents.example/run',
        headers: { Authorization: 'Bearer v' },
        authKey: 'AGENT_KEY',
        threadId: 't-1',
        messages: config.messages,
        thread: config.thread,
        onThread,
        requestTag: 'tag-1',
        onEvent
      }
    ])
  })

  it('a new session gets a fresh thread id', () => {
    seen.length = 0
    adapter.start({ bin: '', cwd: '/w', start: turnStart(null), action: { kind: 'turn', prompt: 'hi' }, onEvent }, config)
    adapter.start({ bin: '', cwd: '/w', start: turnStart(null), action: { kind: 'turn', prompt: 'hi' }, onEvent }, config)
    expect(seen.map((o) => o.threadId)).toHaveLength(2)
    expect(seen[0].threadId).not.toBe(seen[1].threadId)
    expect(seen[0].threadId).not.toBe('t-old')
  })

  it('refuses a fork and a compaction, which AG-UI has no form of, before anything runs', () => {
    seen.length = 0
    expect(() =>
      adapter.start({ bin: '', cwd: '/w', start: turnStart('t-1', 'u1'), action: { kind: 'turn', prompt: 'hi' }, onEvent }, config)
    ).toThrow()
    expect(() =>
      adapter.start({ bin: '', cwd: '/w', start: turnStart('t-1'), action: { kind: 'compact', prompt: '/compact' }, onEvent }, config)
    ).toThrow()
    expect(seen).toEqual([])
  })
})
