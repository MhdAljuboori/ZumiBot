import { afterEach, expect, it, vi } from 'vitest'
import { connect } from 'node:net'
import { once } from 'node:events'
import { stat } from 'node:fs/promises'
import { dirname } from 'node:path'
import { serveTodoIpc, TodoIpcClient } from '../../src/core/todos/todoIpc'
import { parseTodoCall, todoTools } from '../../src/core/todos/todoTools'
import { TODO_ADD_MAX, TODO_GROUP_MAX, TODO_TEXT_MAX } from '@zumibot/shared/todos'

const runtime = { node: '/usr/bin/node', todoBridgeEntry: '/opt/cb/todoBridge.mjs', electronNode: true }
// Counts the disk probes of a server started without a runtime.
const resolved = vi.hoisted(() => ({ calls: 0 }))
vi.mock('../../src/core/browser/browserRuntime', () => ({
  resolveBrowserRuntime: () => {
    resolved.calls++
    return { node: '/usr/bin/node', todoBridgeEntry: '/opt/cb/todoBridge.mjs', electronNode: false }
  }
}))
const cleanups: (() => Promise<void> | void)[] = []
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close()
})

interface Seen {
  fn: string
  args: unknown[]
}
function fakeService(seen: Seen[] = [], fail?: Error) {
  const answer =
    (fn: string) =>
    async (...args: unknown[]) => {
      seen.push({ fn, args })
      if (fail) throw fail
      return `ok ${fn}`
    }
  return {
    agentList: answer('list'),
    agentAdd: answer('add'),
    agentCheck: answer('check'),
    agentRemove: answer('remove'),
    agentAskUser: answer('ask'),
    agentReview: answer('review'),
    agentComment: answer('comment')
  } as never
}
async function fixture(service = fakeService()) {
  const ipc = await serveTodoIpc({ service, runtime })
  cleanups.push(() => ipc.close())
  return ipc
}
const owner = (agent = 'ann') => ({ chatId: 'c1', agent: () => agent, turn: 't1', label: '/my-day' })

it('uses a private socket and rejects a wrong token', async () => {
  const ipc = await fixture()
  if (process.platform !== 'win32') expect((await stat(ipc.socketPath)).mode & 0o777).toBe(0o600)
  if (process.platform !== 'win32') expect((await stat(dirname(ipc.socketPath))).mode & 0o777).toBe(0o700)
  await expect(TodoIpcClient.connect(ipc.socketPath, 'unknown')).rejects.toThrow('To-do list unavailable')
})

it('rejects a line over the limit before parsing', async () => {
  const ipc = await fixture()
  const turn = ipc.createTodoTurn(owner())
  const socket = connect(ipc.socketPath)
  cleanups.push(() => {
    socket.destroy()
  })
  await once(socket, 'connect')
  // The server cuts the line while it is still being written, which can reset the write on this side: wait for the
  // close alone, since once() would reject on that error.
  socket.on('error', () => {})
  const closed = new Promise((resolve) => socket.once('close', resolve))
  // Not JSON on purpose: the byte limit must cut it before any parse.
  socket.write('x'.repeat(1_100_000))
  await closed
  turn.dispose()
})

it("a revoked turn's socket is closed", async () => {
  const ipc = await fixture()
  const turn = ipc.createTodoTurn(owner())
  const client = await TodoIpcClient.connect(ipc.socketPath, turn.env.ZUMIBOT_TODOS_CAPABILITY!)
  cleanups.push(() => client.close())
  expect(await client.run({ op: 'list' })).toBe('ok list')
  turn.dispose()
  await expect(client.run({ op: 'list' })).rejects.toThrow('To-do list unavailable')
  await expect(TodoIpcClient.connect(ipc.socketPath, turn.env.ZUMIBOT_TODOS_CAPABILITY!)).rejects.toThrow('To-do list unavailable')
})

it("a call runs as the turn's chat and agent and cannot name another chat", async () => {
  const seen: Seen[] = []
  const ipc = await fixture(fakeService(seen))
  let speaker = 'ann'
  const turn = ipc.createTodoTurn({ chatId: 'c1', agent: () => speaker, turn: 't1', label: '/my-day' })
  const client = await TodoIpcClient.connect(ipc.socketPath, turn.env.ZUMIBOT_TODOS_CAPABILITY!)
  cleanups.push(() => client.close())
  await client.run({ op: 'add', items: [{ text: 'Reply to Morjan', group: 'Slack' }] })
  speaker = 'bob' // a room's speaker is read at call time
  await client.run({ op: 'check', ids: ['a'], done: true })
  await client.run({ op: 'remove', ids: ['a'] })
  expect(seen).toEqual([
    { fn: 'add', args: ['c1', 'ann', 't1', '/my-day', [{ text: 'Reply to Morjan', group: 'Slack' }]] },
    { fn: 'check', args: ['c1', 'bob', 't1', ['a'], true] },
    { fn: 'remove', args: ['c1', 'bob', 't1', ['a']] }
  ])
  // A chatId (or any foreign key) is refused and never reaches the service.
  await expect(client.run({ op: 'list', chatId: 'other' } as never)).rejects.toThrow()
  await expect(client.run({ op: 'add', items: [], chatId: 'other' } as never)).rejects.toThrow()
  expect(seen).toHaveLength(3)
  // At the message level too: the socket is cut.
  const raw = connect(ipc.socketPath)
  cleanups.push(() => {
    raw.destroy()
  })
  const lines: string[] = []
  raw.on('data', (b) => lines.push(...String(b).split('\n').filter(Boolean)))
  raw.write(JSON.stringify({ type: 'auth', token: turn.env.ZUMIBOT_TODOS_CAPABILITY }) + '\n')
  await expect.poll(() => lines.length).toBe(1)
  const closed = once(raw, 'close')
  raw.write(JSON.stringify({ type: 'run', id: 1, chatId: 'other', call: { op: 'list' } }) + '\n')
  await closed
  expect(seen).toHaveLength(3)
})

it('the service error text reaches the caller, nothing else', async () => {
  const ipc = await fixture(fakeService([], new Error('At most 50 items per add')))
  const turn = ipc.createTodoTurn(owner())
  const client = await TodoIpcClient.connect(ipc.socketPath, turn.env.ZUMIBOT_TODOS_CAPABILITY!)
  cleanups.push(() => client.close())
  await expect(client.run({ op: 'add', items: [{ text: 'x' }] })).rejects.toThrow('At most 50 items per add')
  // An error that looks like an I/O failure (it names a path) is not passed on.
  const leaky = await fixture(
    fakeService(
      [],
      Object.assign(new Error("EACCES: permission denied, open '/home/u/.local/share/zumibot/chats/c1.todos.json'"), { code: 'EACCES' })
    )
  )
  const t2 = leaky.createTodoTurn(owner())
  const c2 = await TodoIpcClient.connect(leaky.socketPath, t2.env.ZUMIBOT_TODOS_CAPABILITY!)
  cleanups.push(() => c2.close())
  const err = await c2.run({ op: 'list' }).catch((e: Error) => e)
  expect((err as Error).message).toBe('To-do list unavailable')
})

it('puts the capability in env only and builds its own mcp-config from placeholders', async () => {
  const ipc = await fixture()
  const turn = ipc.createTodoTurn(owner())
  expect(turn.args[0]).toBe('--mcp-config')
  expect(turn.args).toHaveLength(2)
  const config = JSON.parse(turn.args[1]).mcpServers.zumibot_todos
  expect(config).toEqual({
    type: 'stdio',
    command: '/usr/bin/node',
    args: ['/opt/cb/todoBridge.mjs'],
    alwaysLoad: true,
    env: {
      ZUMIBOT_TODOS_CAPABILITY: '${ZUMIBOT_TODOS_CAPABILITY}',
      ZUMIBOT_TODOS_IPC: '${ZUMIBOT_TODOS_IPC}',
      ELECTRON_RUN_AS_NODE: '1'
    }
  })
  expect(turn.args.join(' ')).not.toContain(turn.env.ZUMIBOT_TODOS_CAPABILITY!)
  expect(turn.env.ZUMIBOT_TODOS_IPC).toBe(ipc.socketPath)
  expect(turn.env.ZUMIBOT_TODOS_CAPABILITY).toMatch(/^[0-9a-f]{64}$/)
  expect(ipc.createTodoTurn(owner()).env.ZUMIBOT_TODOS_CAPABILITY).not.toBe(turn.env.ZUMIBOT_TODOS_CAPABILITY)
})

it('close revokes every turn, cuts the sockets and removes its directory', async () => {
  const ipc = await serveTodoIpc({ service: fakeService(), runtime })
  const turn = ipc.createTodoTurn(owner())
  const client = await TodoIpcClient.connect(ipc.socketPath, turn.env.ZUMIBOT_TODOS_CAPABILITY!)
  await ipc.close()
  await expect(client.run({ op: 'list' })).rejects.toThrow('To-do list unavailable')
  await expect(stat(dirname(ipc.socketPath))).rejects.toThrow()
  expect(() => ipc.createTodoTurn(owner())).toThrow('To-do list unavailable')
})

it('parseTodoCall accepts the four tools and throws on bad input', () => {
  expect(parseTodoCall('list', {})).toEqual({ op: 'list' })
  expect(parseTodoCall('add', { items: [{ text: 'a', group: 'G' }, { text: 'b' }] })).toEqual({
    op: 'add',
    items: [{ text: 'a', group: 'G' }, { text: 'b' }]
  })
  expect(parseTodoCall('check', { ids: ['x'], done: false })).toEqual({ op: 'check', ids: ['x'], done: false })
  expect(parseTodoCall('remove', { ids: ['x'] })).toEqual({ op: 'remove', ids: ['x'] })
  for (const [name, args] of [
    ['nope', {}],
    ['list', { chatId: 'c' }],
    ['list', null],
    ['add', {}],
    ['add', { items: 'a' }],
    ['add', { items: [{ text: 1 }] }],
    ['add', { items: [{ text: 'a', extra: 1 }] }],
    ['check', { ids: ['x'] }],
    ['check', { ids: [], done: true }],
    ['check', { ids: [1], done: true }],
    ['remove', { ids: ['x'], done: true }]
  ] as const) {
    expect(() => parseTodoCall(name, args), JSON.stringify([name, args])).toThrow()
  }
})

it('parseTodoCall cuts an over-long text and group to the caps the service keeps', () => {
  const call = parseTodoCall('add', {
    items: [
      { text: `  ${'a'.repeat(400)}  `, group: `${'g'.repeat(100)}` },
      { text: 'b', group: null }
    ]
  })
  expect(call).toEqual({
    op: 'add',
    items: [
      { text: 'a'.repeat(TODO_TEXT_MAX), group: 'g'.repeat(TODO_GROUP_MAX) },
      { text: 'b', group: null }
    ]
  })
  expect(todoTools.find((t) => t.name === 'add')!.inputSchema.properties.items).toMatchObject({
    items: {
      properties: {
        text: { maxLength: TODO_TEXT_MAX },
        group: { maxLength: TODO_GROUP_MAX }
      }
    }
  })
})

it('a full add of long items fits the IPC request limit', async () => {
  const seen: Seen[] = []
  const ipc = await fixture(fakeService(seen))
  const turn = ipc.createTodoTurn(owner())
  const client = await TodoIpcClient.connect(ipc.socketPath, turn.env.ZUMIBOT_TODOS_CAPABILITY!)
  cleanups.push(() => client.close())
  // Two-byte characters, longer than the caps: what an agent may send before the bridge cuts it.
  const items = Array.from({ length: TODO_ADD_MAX }, () => ({ text: 'ع'.repeat(2000), group: 'ج'.repeat(200) }))
  expect(await client.run(parseTodoCall('add', { items }))).toBe('ok add')
  const sent = seen[0].args[4] as { text: string; group: string }[]
  expect(sent).toHaveLength(TODO_ADD_MAX)
  expect(sent.every((i) => i.text.length === TODO_TEXT_MAX && i.group.length === TODO_GROUP_MAX)).toBe(true)
})

it('resolves the bridge runtime once, at start, when none is given', async () => {
  const before = resolved.calls
  const ipc = await serveTodoIpc({ service: fakeService() })
  cleanups.push(() => ipc.close())
  const turns = [ipc.createTodoTurn(owner()), ipc.createTodoTurn(owner())]
  expect(resolved.calls - before).toBe(1)
  expect(JSON.parse(turns[0].args[1]).mcpServers.zumibot_todos).toMatchObject({
    command: '/usr/bin/node',
    args: ['/opt/cb/todoBridge.mjs']
  })
  for (const t of turns) t.dispose()
})

it('carries ask_user, ready_for_review and comment over the socket as the bridge parsed them', async () => {
  const seen: Seen[] = []
  const ipc = await fixture(fakeService(seen))
  const turn = ipc.createTodoTurn(owner())
  const client = await TodoIpcClient.connect(ipc.socketPath, turn.env.ZUMIBOT_TODOS_CAPABILITY!)
  cleanups.push(() => client.close())
  // The bridge sends what parseTodoCall made; the server parses that same shape again.
  expect(await client.run(parseTodoCall('ask_user', { questions: [{ question: 'Which DB?', options: ['Postgres'] }] }))).toBe('ok ask')
  expect(await client.run(parseTodoCall('ready_for_review', { summary: 'Done.' }))).toBe('ok review')
  expect(await client.run(parseTodoCall('comment', { id: 'card1', text: 'Halfway there.' }))).toBe('ok comment')
  expect(seen).toEqual([
    { fn: 'ask', args: ['c1', 'ann', 't1', [{ text: 'Which DB?', options: ['Postgres'] }]] },
    { fn: 'review', args: ['c1', 'ann', 't1', 'Done.'] },
    { fn: 'comment', args: ['c1', 'ann', 't1', 'card1', 'Halfway there.'] }
  ])
  turn.dispose()
})
