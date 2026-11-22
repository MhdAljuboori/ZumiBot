import { afterEach, expect, it, vi } from 'vitest'
import { connect } from 'node:net'
import { once } from 'node:events'
import { stat } from 'node:fs/promises'
import { dirname } from 'node:path'
import { CONFIRM_ONLY_TOOLS, STALE_REFUSED, WRITE_REFUSED } from '@zumibot/shared/automations'
import type { AgentSummary } from '@zumibot/shared/types'
import { AutomationIpcClient, serveAutomationIpc } from '../../src/core/automations/automationIpc'
import { AUTOMATION_ASK_SETTINGS } from '../../src/core/automations/automationTools'
import { ZUMI_BOT_REFUSED, agentResolver } from '../../src/core/automations/agentNames'
import { routineFromAuthoring, workflowFromAuthoring, said } from '../../src/core/automations/authoring'

const runtime = { node: '/usr/bin/node', automationBridgeEntry: '/opt/cb/automationBridge.mjs', electronNode: true }
const resolved = vi.hoisted(() => ({ calls: 0 }))
vi.mock('../../src/core/browser/browserRuntime', () => ({
  resolveBrowserRuntime: () => {
    resolved.calls++
    return { node: '/usr/bin/node', automationBridgeEntry: '/opt/cb/automationBridge.mjs', electronNode: false }
  }
}))
const cleanups: (() => Promise<void> | void)[] = []
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close()
})

interface Seen {
  owner: unknown
  call: unknown
}
function fakeService(seen: Seen[] = [], fail?: Error) {
  return {
    run: async (owner: unknown, call: unknown) => {
      seen.push({ owner, call })
      if (fail) throw fail
      return `ok ${(call as { op: string }).op}`
    }
  } as never
}
async function fixture(service = fakeService()) {
  const ipc = await serveAutomationIpc({ service, runtime })
  cleanups.push(() => ipc.close())
  return ipc
}
const cap = (turn: { env: NodeJS.ProcessEnv }) => turn.env.ZUMIBOT_AUTOMATIONS_CAPABILITY!
const owner = (writable = true) => ({ chatId: 'c1', writable })

it('uses a private socket and drops a wrong token', async () => {
  const ipc = await fixture()
  if (process.platform !== 'win32') expect((await stat(ipc.socketPath)).mode & 0o777).toBe(0o600)
  if (process.platform !== 'win32') expect((await stat(dirname(ipc.socketPath))).mode & 0o777).toBe(0o700)
  // Windows has no socket files: a fresh named pipe instead.
  if (process.platform === 'win32') expect(ipc.socketPath).toMatch(/^\\\\\.\\pipe\\zumibot-r-/)
  else expect(dirname(ipc.socketPath)).toMatch(/^\/tmp\/cb-r-/)
  await expect(AutomationIpcClient.connect(ipc.socketPath, 'unknown')).rejects.toThrow('Routines and workflows unavailable')
})

it('rejects a line over the limit before parsing', async () => {
  const ipc = await fixture()
  const turn = ipc.createAutomationTurn(owner())
  const socket = connect(ipc.socketPath)
  cleanups.push(() => {
    socket.destroy()
  })
  await once(socket, 'connect')
  // The server cuts the line while it is still being written, which can reset the write on this side (EPIPE on macOS,
  // whose socket buffer is small): wait for the close alone, since once() would reject on that error.
  socket.on('error', () => {})
  const closed = new Promise((resolve) => socket.once('close', resolve))
  socket.write('x'.repeat(140_000))
  await closed
  turn.dispose()
})

it("a revoked turn's socket is closed", async () => {
  const ipc = await fixture()
  const turn = ipc.createAutomationTurn(owner())
  const client = await AutomationIpcClient.connect(ipc.socketPath, cap(turn))
  cleanups.push(() => client.close())
  expect(await client.run({ op: 'routines_list' })).toBe('ok routines_list')
  turn.dispose()
  await expect(client.run({ op: 'routines_list' })).rejects.toThrow('Routines and workflows unavailable')
  await expect(AutomationIpcClient.connect(ipc.socketPath, cap(turn))).rejects.toThrow('Routines and workflows unavailable')
})

it("the owner's chat and writable reach the service, and a call cannot name another chat", async () => {
  const seen: Seen[] = []
  const ipc = await fixture(fakeService(seen))
  const writer = ipc.createAutomationTurn({ chatId: 'c1', writable: true })
  const reader = ipc.createAutomationTurn({ chatId: 'c2', writable: false })
  const w = await AutomationIpcClient.connect(ipc.socketPath, cap(writer))
  const r = await AutomationIpcClient.connect(ipc.socketPath, cap(reader))
  cleanups.push(() => {
    w.close()
    r.close()
  })
  await w.run({ op: 'routine_delete', id: 'r1', name: 'Daily' })
  await r.run({ op: 'chat_read', chat: '/chat/x' })
  expect(seen).toEqual([
    { owner: { chatId: 'c1', writable: true }, call: { op: 'routine_delete', id: 'r1', name: 'Daily' } },
    { owner: { chatId: 'c2', writable: false }, call: { op: 'chat_read', chat: '/chat/x' } }
  ])
  await expect(w.run({ op: 'routines_list', chatId: 'other' } as never)).rejects.toThrow()
  expect(seen).toHaveLength(2)
  // At the message level too: the socket is cut.
  const raw = connect(ipc.socketPath)
  cleanups.push(() => {
    raw.destroy()
  })
  const lines: string[] = []
  raw.on('data', (b) => lines.push(...String(b).split('\n').filter(Boolean)))
  raw.write(JSON.stringify({ type: 'auth', token: cap(writer) }) + '\n')
  await expect.poll(() => lines.length).toBe(1)
  const closed = once(raw, 'close')
  raw.write(JSON.stringify({ type: 'run', id: 1, chatId: 'other', call: { op: 'routines_list' } }) + '\n')
  await closed
  expect(seen).toHaveLength(2)
})

it('a save close to its 60 000-byte cap and a long transcript pass through', async () => {
  const big = 'ع'.repeat(25_000) // two bytes each: 50 000 bytes
  const seen: Seen[] = []
  const ipc = await serveAutomationIpc({
    runtime,
    service: {
      run: async (o: unknown, call: unknown) => {
        seen.push({ owner: o, call })
        return 'y'.repeat(150_000)
      }
    } as never
  })
  cleanups.push(() => ipc.close())
  const turn = ipc.createAutomationTurn(owner())
  const client = await AutomationIpcClient.connect(ipc.socketPath, cap(turn))
  cleanups.push(() => client.close())
  expect((await client.run({ op: 'workflow_save', workflow: { name: 'x', note: big } })).length).toBe(150_000)
  expect(seen).toHaveLength(1)
})

it('a service sentence reaches the caller, a path or a code does not', async () => {
  const known = async (text: string) => {
    const ipc = await fixture(fakeService([], new Error(text)))
    const client = await AutomationIpcClient.connect(ipc.socketPath, cap(ipc.createAutomationTurn(owner())))
    cleanups.push(() => client.close())
    return ((await client.run({ op: 'routines_list' }).catch((e: Error) => e)) as Error).message
  }
  expect(await known('At most 50 items per add')).toBe('At most 50 items per add')
  expect(await known('Cannot open /home/x/.config')).toBe('Routines and workflows unavailable')
  expect(await known("EACCES: permission denied, open '/home/u/.local/share/zumibot/routines.json'")).toBe(
    'Routines and workflows unavailable'
  )
  expect(await known('/home/x/.config/zumibot')).toBe('Routines and workflows unavailable')
  expect(await known('x'.repeat(401))).toBe('Routines and workflows unavailable')
  expect(await known('Line one\nline two')).toBe('Routines and workflows unavailable')
  // "/" outside the service's own quotes is never passed on, however short the path.
  for (const leak of [
    'Cannot open /home',
    'failed: /tmp',
    'rm -rf /',
    "Error: ENOENT, open '/a'",
    'No such file chats/abc.json',
    'x/y',
    'https://x.com/hooks/abc',
    'Cannot write "dir" to /data',
    'Unknown agent "a/b" at /home',
    'such as Europe/Istanbul and /tmp',
    'It is “a” in b/c'
  ]) {
    expect(await known(leak), leak).toBe('Routines and workflows unavailable')
  }
  // A slash inside the quotes said() puts around an echoed value, and the fixed zone example, still pass.
  for (const ok of [
    'Unknown agent "a/b". Agents: x, y',
    'That id is now named “Tags / Daily”: check with the user.',
    'timeZone must be an IANA time zone, such as Europe/Istanbul'
  ]) {
    expect(await known(ok), ok).toBe(ok)
  }
})

// Every refusal the earlier tasks can say must get through, quotes and all, or the agent could not act on it.
it('every real refusal sentence passes the filter', async () => {
  const roster = Array.from({ length: 40 }, (_, i) => ({ name: `agent-number-${i}`, error: null }) as unknown as AgentSummary)
  const resolve = agentResolver(roster)
  const ctx = { timeZone: 'Europe/Istanbul', folders: {}, groupFolder: null, home: '/home/u', newId: () => 'id' }
  const thrown = (fn: () => unknown): string => {
    try {
      fn()
    } catch (e) {
      return (e as Error).message
    }
    throw new Error('did not throw')
  }
  const sentences = [
    WRITE_REFUSED,
    STALE_REFUSED,
    ZUMI_BOT_REFUSED,
    'It changed since you read it: read it again.',
    'To edit it, read it first and send back the updatedAt it returned.',
    'No routine with that id',
    'No workflow with that id',
    'No chat with that id',
    `That id is now named “${said('Tags / Daily (2)', 100)}”: check with the user.`,
    thrown(() => resolve('nobody "quoted" / odd')),
    thrown(() => resolve('Zumi Bot')),
    thrown(() => resolve('@x')),
    thrown(() => routineFromAuthoring({ name: 'a', bogus: 1 }, ctx)),
    thrown(() => routineFromAuthoring({ name: 'a', trigger: { kind: 'x' } }, ctx)),
    thrown(() => routineFromAuthoring(null, ctx)),
    thrown(() => workflowFromAuthoring({ name: 'a', timeZone: 'Mars/Base', trigger: { kind: 'manual' }, steps: [], edges: [] }, null, ctx)),
    thrown(() =>
      workflowFromAuthoring({ name: 'a', trigger: { kind: 'manual' }, steps: [{ handle: 'A B', kind: 'agent' }], edges: [] }, null, ctx)
    ),
    thrown(() =>
      workflowFromAuthoring(
        {
          name: 'a',
          trigger: { kind: 'manual' },
          steps: [
            { handle: 'a', kind: 'condition' },
            { handle: 'b', kind: 'wait' }
          ],
          edges: [{ from: 'a', port: 'out', to: 'b' }]
        },
        null,
        ctx
      )
    ),
    thrown(() =>
      workflowFromAuthoring(
        { name: 'a', trigger: { kind: 'manual' }, steps: [{ handle: 'a', kind: 'wait' }], edges: [{ from: 'trigger', to: 'zz/"q' }] },
        null,
        ctx
      )
    )
  ]
  expect(sentences.every((s) => s.length > 0)).toBe(true)
  expect(Math.max(...sentences.map((s) => s.length))).toBeLessThanOrEqual(400)
  let index = 0
  // One server per sentence: the service throws that sentence for any call.
  for (const sentence of sentences) {
    const server = await serveAutomationIpc({
      runtime,
      service: {
        run: async () => {
          throw new Error(sentence)
        }
      } as never
    })
    cleanups.push(() => server.close())
    const client = await AutomationIpcClient.connect(server.socketPath, cap(server.createAutomationTurn(owner())))
    cleanups.push(() => client.close())
    const got = ((await client.run({ op: 'routines_list' }).catch((e: Error) => e)) as Error).message
    expect(got, `#${index++}`).toBe(sentence)
  }
})

it('puts the capability in env only and builds its own mcp-config and ask settings', async () => {
  const ipc = await fixture()
  const turn = ipc.createAutomationTurn(owner())
  expect(turn.args.slice(0, 2)[0]).toBe('--mcp-config')
  const config = JSON.parse(turn.args[1]).mcpServers.zumibot_automations
  expect(config).toEqual({
    type: 'stdio',
    command: '/usr/bin/node',
    args: ['/opt/cb/automationBridge.mjs'],
    alwaysLoad: true,
    env: {
      ZUMIBOT_AUTOMATIONS_CAPABILITY: '${ZUMIBOT_AUTOMATIONS_CAPABILITY}',
      ZUMIBOT_AUTOMATIONS_IPC: '${ZUMIBOT_AUTOMATIONS_IPC}',
      ELECTRON_RUN_AS_NODE: '1'
    }
  })
  expect(turn.args.slice(2)).toEqual(['--settings', AUTOMATION_ASK_SETTINGS])
  expect(JSON.parse(turn.args[3]).permissions.ask).toEqual([...CONFIRM_ONLY_TOOLS])
  expect(CONFIRM_ONLY_TOOLS).toEqual(['mcp__zumibot_automations__routine_delete', 'mcp__zumibot_automations__workflow_delete'])
  expect(turn.args.join(' ')).not.toContain(cap(turn))
  expect(turn.env.ZUMIBOT_AUTOMATIONS_IPC).toBe(ipc.socketPath)
  expect(cap(turn)).toMatch(/^[0-9a-f]{64}$/)
  expect(cap(ipc.createAutomationTurn(owner()))).not.toBe(cap(turn))
})

it('a side turn gets no ask rules', async () => {
  const ipc = await fixture()
  const turn = ipc.createAutomationTurn(owner(), { side: true })
  expect(turn.args).toHaveLength(2)
  expect(turn.args[0]).toBe('--mcp-config')
  expect(turn.args).not.toContain('--settings')
  expect(turn.args.join(' ')).not.toContain(cap(turn))
})

it('close revokes every turn, cuts the sockets and removes its directory', async () => {
  const ipc = await serveAutomationIpc({ service: fakeService(), runtime })
  const turn = ipc.createAutomationTurn(owner())
  const client = await AutomationIpcClient.connect(ipc.socketPath, cap(turn))
  await ipc.close()
  await expect(client.run({ op: 'routines_list' })).rejects.toThrow('Routines and workflows unavailable')
  await expect(stat(dirname(ipc.socketPath))).rejects.toThrow()
  expect(() => ipc.createAutomationTurn(owner())).toThrow('Routines and workflows unavailable')
})

it('resolves the bridge runtime once, at start, when none is given', async () => {
  const before = resolved.calls
  const ipc = await serveAutomationIpc({ service: fakeService() })
  cleanups.push(() => ipc.close())
  const turns = [ipc.createAutomationTurn(owner()), ipc.createAutomationTurn(owner())]
  expect(resolved.calls - before).toBe(1)
  expect(JSON.parse(turns[0].args[1]).mcpServers.zumibot_automations).toMatchObject({
    command: '/usr/bin/node',
    args: ['/opt/cb/automationBridge.mjs']
  })
  for (const t of turns) t.dispose()
})
