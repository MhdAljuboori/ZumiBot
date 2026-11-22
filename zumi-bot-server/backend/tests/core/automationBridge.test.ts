import { afterAll, beforeAll, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { build } from 'vite'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { AUTOMATION_TOOLS } from '@zumibot/shared/automations'
import { serveAutomationIpc } from '../../src/core/automations/automationIpc'

let artifact: string
beforeAll(async () => {
  artifact = await mkdtemp(join(tmpdir(), 'cb-automation-bridge-test-'))
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

it('lists the nine tools and returns the service answer or its sentence', async () => {
  const calls: unknown[] = []
  const service = {
    run: async (owner: { chatId: string; writable: boolean }, call: { op: string; name?: string }) => {
      calls.push([owner, call])
      if (call.op === 'routine_delete') throw new Error(`That id is now named “Other”: check with the user.`)
      if (call.op === 'workflow_get') throw new Error('Cannot read /home/x/.config/zumibot')
      return call.op === 'routines_list' ? '[{"id":"r1"}]' : 'ok'
    }
  }
  const ipc = await serveAutomationIpc({
    service: service as never,
    runtime: { node: process.execPath, automationBridgeEntry: join(artifact, 'automationBridge.mjs'), electronNode: false }
  })
  const turn = ipc.createAutomationTurn({ chatId: 'c1', writable: true })
  const client = new Client({ name: 'test', version: '1' })
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [join(artifact, 'automationBridge.mjs')],
    env: turn.env as Record<string, string>,
    stderr: 'pipe'
  })
  let stderr = ''
  transport.stderr?.on('data', (d) => {
    stderr += d
  })
  try {
    await client.connect(transport)
    expect((await client.listTools()).tools.map((t) => t.name)).toEqual([...AUTOMATION_TOOLS])
    expect(await client.callTool({ name: 'routines_list', arguments: {} })).toEqual({ content: [{ type: 'text', text: '[{"id":"r1"}]' }] })
    expect(calls).toEqual([[{ chatId: 'c1', writable: true }, { op: 'routines_list' }]])
    expect(await client.callTool({ name: 'routine_delete', arguments: { id: 'r1', name: 'Daily' } })).toEqual({
      isError: true,
      content: [{ type: 'text', text: 'That id is now named “Other”: check with the user.' }]
    })
    // A path never reaches the agent.
    expect(await client.callTool({ name: 'workflow_get', arguments: { id: 'w1' } })).toEqual({
      isError: true,
      content: [{ type: 'text', text: 'Routines and workflows unavailable' }]
    })
    // Refused before it reaches the server: a chat id is no part of any tool, nor is a missing name.
    expect(await client.callTool({ name: 'routines_list', arguments: { chatId: 'other' } })).toMatchObject({ isError: true })
    expect(await client.callTool({ name: 'routine_delete', arguments: { id: 'r1' } })).toMatchObject({ isError: true })
    expect(await client.callTool({ name: 'chat_read', arguments: { chat: 'x'.repeat(10_000) } })).toMatchObject({ isError: true })
    expect(calls).toHaveLength(3)
    turn.dispose()
    expect(await client.callTool({ name: 'routines_list', arguments: {} })).toMatchObject({
      isError: true,
      content: [{ text: 'Routines and workflows unavailable' }]
    })
    expect(stderr).not.toContain(turn.env.ZUMIBOT_AUTOMATIONS_CAPABILITY)
  } finally {
    await client.close()
    turn.dispose()
    await ipc.close()
  }
})
