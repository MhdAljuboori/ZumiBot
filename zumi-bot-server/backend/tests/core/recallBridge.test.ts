import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { build } from 'vite'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { serveRecallIpc, type RecallIpcService } from '../../src/core/recall/recallIpc'
import { RECALL_TEXT } from '../../src/core/recall/recallService'

let artifact: string
beforeAll(async () => {
  artifact = await mkdtemp(join(tmpdir(), 'cb-recall-bridge-test-'))
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

const runtime = () => ({ node: process.execPath, recallBridgeEntry: join(artifact, 'recallBridge.mjs'), electronNode: false })

async function connect(env: NodeJS.ProcessEnv) {
  const client = new Client({ name: 'test', version: '1' })
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [join(artifact, 'recallBridge.mjs')],
    env: env as Record<string, string>,
    stderr: 'pipe'
  })
  await client.connect(transport)
  return client
}

describe('zumibot_recall bridge', () => {
  it('lists search and read, and runs each call as the token’s chat and agent', async () => {
    const calls: unknown[][] = []
    const service: RecallIpcService = {
      run: async (owner, call) => {
        calls.push([owner, call])
        if (call.op === 'read') throw new Error(RECALL_TEXT.noChat)
        return '1 message matches, newest first:'
      }
    }
    const ipc = await serveRecallIpc({ service, runtime: runtime() })
    let agent = 'ann'
    const turn = ipc.createRecallTurn({ chatId: 'c1', agent: () => agent, turn: 't1' })
    expect(JSON.parse(turn.args[1]).mcpServers.zumibot_recall).toMatchObject({ alwaysLoad: true })
    expect(turn.args.join(' ')).not.toContain(turn.env.ZUMIBOT_RECALL_CAPABILITY as string)
    const client = await connect(turn.env)
    try {
      expect((await client.listTools()).tools.map((t) => t.name).sort()).toEqual(['read', 'search'])
      expect(await client.callTool({ name: 'search', arguments: { query: 'postgres' } })).toMatchObject({
        content: [{ text: '1 message matches, newest first:' }]
      })
      expect(calls[0]).toEqual([{ chatId: 'c1', agent: 'ann' }, { op: 'search', query: 'postgres' }])
      // The speaking member is read per call.
      agent = 'bob'
      expect(await client.callTool({ name: 'read', arguments: { chatId: 'c2', messageId: 'm1' } })).toEqual({
        isError: true,
        content: [{ type: 'text', text: RECALL_TEXT.noChat }]
      })
      expect(calls[1]).toEqual([{ chatId: 'c1', agent: 'bob' }, { op: 'read', chatId: 'c2', messageId: 'm1' }])
      // A chat id smuggled into a search never reaches the service.
      expect(await client.callTool({ name: 'search', arguments: { query: 'x', chatId: 'c9' } })).toMatchObject({ isError: true })
      expect(calls).toHaveLength(2)
    } finally {
      await client.close()
      turn.dispose()
      await ipc.close()
    }
  }, 30000)

  it('a side owner holds the definitions only: every call is refused', async () => {
    const calls: unknown[] = []
    const ipc = await serveRecallIpc({
      service: { run: async (...a) => (calls.push(a), 'x') },
      runtime: runtime()
    })
    const turn = ipc.createRecallTurn({ chatId: 'c1', agent: () => 'ann', turn: 't1', side: true })
    const client = await connect(turn.env)
    try {
      expect(await client.callTool({ name: 'search', arguments: { query: 'x' } })).toEqual({
        isError: true,
        content: [{ type: 'text', text: RECALL_TEXT.side }]
      })
      expect(calls).toHaveLength(0)
    } finally {
      await client.close()
      turn.dispose()
      await ipc.close()
    }
  }, 30000)

  it('a disposed turn’s token no longer works', async () => {
    const ipc = await serveRecallIpc({ service: { run: async () => 'x' }, runtime: runtime() })
    const turn = ipc.createRecallTurn({ chatId: 'c1', agent: () => 'ann', turn: 't1' })
    turn.dispose()
    await expect(connect(turn.env)).rejects.toThrow()
    await ipc.close()
  }, 30000)
})
