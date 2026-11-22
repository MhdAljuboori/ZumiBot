import { afterAll, beforeAll, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { build } from 'vite'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { serveAskIpc } from '../../src/core/asks/askIpc'

let artifact: string
beforeAll(async () => {
  artifact = await mkdtemp(join(tmpdir(), 'cb-ask-bridge-test-'))
  await build({
    root: resolve('zumi-bot-server/backend'),
    configFile: resolve('zumi-bot-server/backend/vite.config.ts'),
    build: { outDir: artifact },
    logLevel: 'silent'
  })
}, 30000)
afterAll(async () => {
  await rm(artifact, { recursive: true, force: true })
})

it('lists both tools and returns the service answer or its error text', async () => {
  const calls: unknown[] = []
  let aborted = false
  const service = {
    ask: async (owner: { chatId: string; agent: () => string }, call: { agent: string; message: string }, signal: AbortSignal) => {
      calls.push([owner.chatId, owner.agent(), call])
      if (call.agent === 'slow')
        return await new Promise<string>((_r, reject) =>
          signal.addEventListener(
            'abort',
            () => {
              aborted = true
              reject(new Error('Stopped'))
            },
            { once: true }
          )
        )
      if (call.agent === 'nobody') throw new Error('No agent named nobody. Agents you can ask: ann')
      return 'the reply'
    }
  }
  const sideCalls: unknown[] = []
  const sideService = {
    ...service,
    sideAsk: async (owner: { chatId: string }, call: { agent: string; question: string }) => {
      sideCalls.push([owner.chatId, call])
      return 'the side answer'
    }
  }
  const ipc = await serveAskIpc({
    service: sideService,
    runtime: { node: process.execPath, askBridgeEntry: join(artifact, 'askBridge.mjs'), electronNode: false }
  })
  const turn = ipc.createAskTurn({ chatId: 'c1', agent: () => 'ann', chain: ['ann'], turn: 't1' })
  const client = new Client({ name: 'test', version: '1' })
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [join(artifact, 'askBridge.mjs')],
    env: turn.env as Record<string, string>,
    stderr: 'pipe'
  })
  let stderr = ''
  transport.stderr?.on('data', (d) => {
    stderr += d
  })
  try {
    await client.connect(transport)
    expect((await client.listTools()).tools.map((t) => t.name)).toEqual(['ask', 'side_question'])
    expect(await client.callTool({ name: 'ask', arguments: { agent: '@b', message: 'hi' } })).toEqual({
      content: [{ type: 'text', text: 'the reply' }]
    })
    expect(calls).toEqual([['c1', 'ann', { agent: '@b', message: 'hi' }]])
    expect(await client.callTool({ name: 'ask', arguments: { agent: 'nobody', message: 'hi' } })).toEqual({
      isError: true,
      content: [{ type: 'text', text: 'No agent named nobody. Agents you can ask: ann' }]
    })
    expect(await client.callTool({ name: 'side_question', arguments: { agent: '@b', question: 'why?' } })).toEqual({
      content: [{ type: 'text', text: 'the side answer' }]
    })
    expect(sideCalls).toEqual([['c1', { agent: '@b', question: 'why?' }]])
    expect(calls).toHaveLength(2)
    expect(await client.callTool({ name: 'side_question', arguments: { agent: 'b', message: 'hi' } })).toMatchObject({ isError: true })
    expect(sideCalls).toHaveLength(1)
    // A chat id is not part of the tool: refused before it reaches the server.
    expect(await client.callTool({ name: 'ask', arguments: { agent: 'b', message: 'hi', chatId: 'other' } })).toMatchObject({
      isError: true
    })
    expect(calls).toHaveLength(2)
    // The SDK's request signal reaches the service: cancelling the call aborts it.
    const ctl = new AbortController()
    const slow = client
      .callTool({ name: 'ask', arguments: { agent: 'slow', message: 'hi' } }, undefined, { signal: ctl.signal })
      .catch(() => 'cancelled')
    await expect.poll(() => calls.length).toBe(3)
    ctl.abort()
    expect(await slow).toBe('cancelled')
    await expect.poll(() => aborted).toBe(true)
    turn.dispose()
    expect(await client.callTool({ name: 'ask', arguments: { agent: 'b', message: 'hi' } })).toMatchObject({
      isError: true,
      content: [{ text: 'Agents unavailable' }]
    })
    expect(stderr).not.toContain(turn.env.ZUMIBOT_ASKS_CAPABILITY)
  } finally {
    await client.close()
    turn.dispose()
    await ipc.close()
  }
})
