import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { build } from 'vite'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { PROCESS_REFUSALS } from '@zumibot/shared/processes'
import { ProcessIpcClient, serveProcessIpc, type ProcessIpcService } from '../../src/core/processes/processIpc'
import { PROCESS_ASK_SETTINGS, parseProcessCall } from '../../src/core/processes/processTools'

let artifact: string
beforeAll(async () => {
  artifact = await mkdtemp(join(tmpdir(), 'cb-process-bridge-test-'))
  await build({
    root: resolve('zumi-bot-server/backend'),
    configFile: resolve('zumi-bot-server/backend/vite.config.ts'),
    build: { outDir: artifact },
    logLevel: 'silent'
  })
}, 60000)
afterAll(async () => {
  await rm(artifact, { recursive: true, force: true })
})

const runtime = () => ({ node: process.execPath, processBridgeEntry: join(artifact, 'processBridge.mjs'), electronNode: false })

function fakeService(calls: unknown[][], onWait?: (signal?: AbortSignal) => Promise<string>): ProcessIpcService {
  return {
    agentStart: async (...a: unknown[]) => {
      calls.push(['start', ...a])
      return 'Started "dev" (p_0123456789).'
    },
    agentList: (...a: unknown[]) => {
      calls.push(['list', ...a])
      return 'No processes in this chat.'
    },
    agentLogs: async (...a: unknown[]) => {
      calls.push(['logs', ...a])
      return 'hello'
    },
    agentWait: async (_c: string, _a: unknown, signal?: AbortSignal) => (onWait ? onWait(signal) : 'Matched: ready'),
    agentStop: async (...a: unknown[]) => {
      calls.push(['stop', ...a])
      throw new Error(PROCESS_REFUSALS.notRunning)
    }
  } as unknown as ProcessIpcService
}

describe('zumibot_processes bridge', () => {
  it('lists five tools, binds the chat from the token, and passes refusals through', async () => {
    const calls: unknown[][] = []
    const ipc = await serveProcessIpc({ service: fakeService(calls), runtime: runtime() })
    const turn = ipc.createProcessTurn({ chatId: 'c1', agent: () => 'ann', turn: 't1' })
    expect(turn.args).toContain(PROCESS_ASK_SETTINGS)
    expect(JSON.parse(turn.args[1]).mcpServers.zumibot_processes).toMatchObject({ alwaysLoad: true, timeout: 150000 })
    const client = new Client({ name: 'test', version: '1' })
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [join(artifact, 'processBridge.mjs')],
      env: turn.env as Record<string, string>,
      stderr: 'pipe'
    })
    let stderr = ''
    transport.stderr?.on('data', (d) => {
      stderr += d
    })
    try {
      await client.connect(transport)
      expect((await client.listTools()).tools.map((t) => t.name).sort()).toEqual(['list', 'logs', 'start', 'stop', 'wait'])
      expect(await client.callTool({ name: 'start', arguments: { command: 'npm run dev', name: 'dev' } })).toMatchObject({
        content: [{ text: 'Started "dev" (p_0123456789).' }]
      })
      expect(calls[0]).toEqual(['start', 'c1', 'ann', { command: 'npm run dev', name: 'dev', cwd: undefined, timeoutMinutes: undefined }])
      expect(await client.callTool({ name: 'list', arguments: {} })).toMatchObject({ content: [{ text: 'No processes in this chat.' }] })
      expect(calls[1]).toEqual(['list', 'c1'])
      expect(await client.callTool({ name: 'stop', arguments: { id: 'p_0123456789' } })).toEqual({
        isError: true,
        content: [{ type: 'text', text: PROCESS_REFUSALS.notRunning }]
      })
      // A chat id is not part of any tool: refused before it reaches the server.
      expect(await client.callTool({ name: 'list', arguments: { chatId: 'other' } })).toMatchObject({ isError: true })
      expect(await client.callTool({ name: 'logs', arguments: { id: '../x' } })).toMatchObject({ isError: true })
      turn.dispose()
      expect(await client.callTool({ name: 'list', arguments: {} })).toMatchObject({
        isError: true,
        content: [{ text: 'Processes unavailable' }]
      })
      expect(stderr).not.toContain(turn.env.ZUMIBOT_PROCESSES_CAPABILITY)
    } finally {
      await client.close()
      turn.dispose()
      await ipc.close()
    }
  })

  it('refuses a start while planning and every call of a side run', async () => {
    const calls: unknown[][] = []
    const ipc = await serveProcessIpc({ service: fakeService(calls), runtime: runtime() })
    let planning = true
    const turn = ipc.createProcessTurn({ chatId: 'c1', agent: () => 'ann', turn: 't1', planning: () => planning })
    const side = ipc.createProcessTurn({ chatId: 'c1', agent: () => 'ann', turn: 't2', side: true })
    expect(side.args).not.toContain(PROCESS_ASK_SETTINGS)
    try {
      const c = await ProcessIpcClient.connect(ipc.socketPath, turn.env.ZUMIBOT_PROCESSES_CAPABILITY!)
      await expect(c.run({ op: 'start', command: 'x' })).rejects.toThrow(PROCESS_REFUSALS.plan)
      planning = false
      await expect(c.run({ op: 'start', command: 'x' })).resolves.toContain('Started')
      const s = await ProcessIpcClient.connect(ipc.socketPath, side.env.ZUMIBOT_PROCESSES_CAPABILITY!)
      await expect(s.run({ op: 'list' })).rejects.toThrow('No tools in a side answer')
      c.close()
      s.close()
    } finally {
      turn.dispose()
      side.dispose()
      await ipc.close()
    }
  })

  it('aborts a blocking wait when the bridge goes away', async () => {
    let aborted!: () => void
    const gone = new Promise<void>((r) => {
      aborted = r
    })
    const ipc = await serveProcessIpc({
      service: fakeService(
        [],
        (signal) =>
          new Promise((res) =>
            signal?.addEventListener('abort', () => {
              aborted()
              res('Wait ended.')
            })
          )
      ),
      runtime: runtime()
    })
    const turn = ipc.createProcessTurn({ chatId: 'c1', agent: () => 'ann', turn: 't1' })
    try {
      const c = await ProcessIpcClient.connect(ipc.socketPath, turn.env.ZUMIBOT_PROCESSES_CAPABILITY!)
      const w = c.run({ op: 'wait', id: 'p_0123456789', timeoutSeconds: 100 }).catch(() => 'closed')
      await new Promise((r) => setTimeout(r, 50))
      turn.dispose()
      await gone
      expect(await w).toBe('closed')
    } finally {
      await ipc.close()
    }
  })

  it('checks every argument exactly', () => {
    expect(parseProcessCall('start', { command: 'x', timeoutMinutes: 5 })).toEqual({ op: 'start', command: 'x', timeoutMinutes: 5 })
    expect(() => parseProcessCall('start', { command: 'x', timeoutMinutes: 0 })).toThrow(/timeoutMinutes/)
    expect(() => parseProcessCall('start', { command: 'x', shell: 'zsh' })).toThrow()
    expect(() => parseProcessCall('wait', { id: 'p_0123456789', patterns: [''] })).toThrow(/patterns/)
    expect(() => parseProcessCall('wait', { id: 'p_0123456789', patterns: ['a', 'b', 'c', 'd', 'e', 'f'] })).toThrow(/patterns/)
    expect(parseProcessCall('logs', { id: 'p_0123456789', grep: '' })).toEqual({ op: 'logs', id: 'p_0123456789' })
    expect(() => parseProcessCall('logs', { id: 'p_0123456789', from: -1 })).toThrow(/from/)
  })
})
