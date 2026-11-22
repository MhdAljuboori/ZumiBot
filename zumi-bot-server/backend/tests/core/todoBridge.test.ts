import { afterAll, beforeAll, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { build } from 'vite'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { addTodos, emptyTodos } from '@zumibot/shared/todos'
import { serveTodoIpc } from '../../src/core/todos/todoIpc'

let artifact: string
beforeAll(async () => {
  artifact = await mkdtemp(join(tmpdir(), 'cb-todo-bridge-test-'))
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

it('lists the six tools and returns the service answer or its error text', async () => {
  const calls: unknown[][] = []
  const service = {
    agentList: async (...a: unknown[]) => {
      calls.push(['list', ...a])
      return 'No open to-dos.'
    },
    // The real rule, so the 51-item message is the shipped text.
    agentAdd: async (_c: string, agent: string, _t: string, _l: string, items: { text: string }[]) => {
      addTodos(emptyTodos(), items, agent, { chatId: 'c', turn: 't', itemId: null, label: 'l', at: 1 }, 1, () => 'id')
      return 'Added.'
    },
    agentCheck: async () => 'Ticked 1 to-do.',
    agentRemove: async () => 'Removed 1 to-do.'
  }
  const ipc = await serveTodoIpc({
    service: service as never,
    runtime: { node: process.execPath, todoBridgeEntry: join(artifact, 'todoBridge.mjs'), electronNode: false }
  })
  const turn = ipc.createTodoTurn({ chatId: 'c1', agent: () => 'ann', turn: 't1', label: 'l' })
  const client = new Client({ name: 'test', version: '1' })
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [join(artifact, 'todoBridge.mjs')],
    env: turn.env as Record<string, string>,
    stderr: 'pipe'
  })
  let stderr = ''
  transport.stderr?.on('data', (d) => {
    stderr += d
  })
  try {
    await client.connect(transport)
    expect((await client.listTools()).tools.map((t) => t.name).sort()).toEqual([
      'add',
      'ask_user',
      'check',
      'comment',
      'list',
      'ready_for_review',
      'remove'
    ])
    expect(await client.callTool({ name: 'list', arguments: {} })).toEqual({ content: [{ type: 'text', text: 'No open to-dos.' }] })
    expect(calls).toEqual([['list', 'c1', 'ann']])
    const items = Array.from({ length: 51 }, (_, i) => ({ text: `item ${i}` }))
    expect(await client.callTool({ name: 'add', arguments: { items } })).toEqual({
      isError: true,
      content: [{ type: 'text', text: 'At most 50 items per add' }]
    })
    expect(await client.callTool({ name: 'check', arguments: { ids: ['a'], done: true } })).toMatchObject({
      content: [{ text: 'Ticked 1 to-do.' }]
    })
    // A chat id is not part of any tool: refused before it reaches the server.
    expect(await client.callTool({ name: 'list', arguments: { chatId: 'other' } })).toMatchObject({ isError: true })
    expect(await client.callTool({ name: 'nope', arguments: {} })).toMatchObject({ isError: true })
    turn.dispose()
    expect(await client.callTool({ name: 'list', arguments: {} })).toMatchObject({
      isError: true,
      content: [{ text: 'To-do list unavailable' }]
    })
    expect(stderr).not.toContain(turn.env.ZUMIBOT_TODOS_CAPABILITY)
  } finally {
    await client.close()
    turn.dispose()
    await ipc.close()
  }
})
