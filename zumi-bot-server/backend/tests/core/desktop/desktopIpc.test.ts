import { afterEach, expect, it } from 'vitest'
import { connect } from 'node:net'
import { once } from 'node:events'
import { stat } from 'node:fs/promises'
import { dirname } from 'node:path'
import { DESKTOP_ACTION_TOOLS, desktopToolName } from '@zumibot/shared/desktop'
import { BrowserCapabilities } from '../../../src/core/browser/browserCapabilities'
import { DESKTOP_ASK_SETTINGS, DesktopIpcClient, serveDesktopIpc, type DesktopIpcManager } from '../../../src/core/desktop/desktopIpc'
import { desktopPrompt } from '../../../src/core/desktop/desktopPrompt'
import { DESKTOP_ASK_SETTINGS as PROBE_ASK_SETTINGS } from '../../../../e2e/desktopAskProbe.mjs'
import { DESKTOP_ACTIONS as FAKE_ACTIONS, PROCESS_START as FAKE_PROCESS_START } from '../../fixtures/fake-desktop-actions.mjs'
import { PROCESS_START_TOOL } from '../../../src/core/processes/processTools'

const owner = { profileId: 'p', chatId: 'c', turnId: 't' }
const runtime = { node: '/usr/bin/node', bridgeEntry: '/opt/cb/desktopBridge.mjs', electronNode: false }
const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close()
})
async function fixture(
  run: DesktopIpcManager['run'] = async (o, command) => ({ ok: true, data: { owner: o, command } }),
  manager: Partial<DesktopIpcManager> = {}
) {
  const capabilities = new BrowserCapabilities()
  const service = await serveDesktopIpc({
    capabilities,
    runtime,
    manager: { run, registerTurn: () => () => {}, endTurn: async () => {}, ...manager }
  })
  cleanups.push(() => service.close())
  return { capabilities, service }
}
const reply = (socket: ReturnType<typeof connect>) => once(socket, 'data')

// A named pipe on Windows: no socket file, folder or mode to check.
it.skipIf(process.platform === 'win32')('uses a private socket in a private directory', async () => {
  const { service } = await fixture()
  if (process.platform !== 'win32') expect((await stat(service.socketPath)).mode & 0o777).toBe(0o600)
  if (process.platform !== 'win32') expect((await stat(dirname(service.socketPath))).mode & 0o777).toBe(0o700)
  expect(dirname(service.socketPath).startsWith('/tmp/cb-d-')).toBe(true)
  expect(Buffer.byteLength(service.socketPath)).toBeLessThanOrEqual(100)
})

it('unauthenticated socket is dropped', async () => {
  let dispatched = 0
  const { service } = await fixture(async () => {
    dispatched++
    return { ok: true, data: null }
  })
  await expect(DesktopIpcClient.connect(service.socketPath, 'unknown')).rejects.toThrow('Desktop unavailable')
  const socket = connect(service.socketPath)
  socket.on('error', () => {})
  const closed = once(socket, 'close')
  socket.write(JSON.stringify({ type: 'run', id: 1, command: { op: 'screenshot' } }) + '\n')
  await closed
  expect(dispatched).toBe(0)
})

it.each(['{bad json}\n', 'x'.repeat(70000)])('closes malformed or oversized unauthenticated input', async (input) => {
  const { service } = await fixture()
  const socket = connect(service.socketPath)
  socket.on('error', () => {})
  const closed = once(socket, 'close')
  socket.write(input)
  await closed
})

it('capability scopes the owner', async () => {
  const { capabilities, service } = await fixture()
  const issued = capabilities.issue(owner),
    client = await DesktopIpcClient.connect(service.socketPath, issued.token)
  cleanups.push(async () => client.close())
  expect(await client.run({ op: 'screenshot' }, new AbortController().signal)).toMatchObject({
    ok: true,
    data: { owner, command: { op: 'screenshot' } }
  })
  // A caller field is refused by the shared parser before it leaves the bridge.
  await expect(client.run({ op: 'screenshot', profileId: 'other' } as never, new AbortController().signal)).rejects.toThrow(
    'Desktop unavailable'
  )
  const other = capabilities.issue({ ...owner, turnId: 'u', chatId: 'd' }),
    second = await DesktopIpcClient.connect(service.socketPath, other.token)
  cleanups.push(async () => second.close())
  expect(await second.run({ op: 'windows' }, new AbortController().signal)).toMatchObject({
    data: { owner: { ...owner, turnId: 'u', chatId: 'd' } }
  })
})

it('invalid command gets an error result', async () => {
  let dispatched = 0
  const { capabilities, service } = await fixture(async () => {
    dispatched++
    return { ok: true, data: null }
  })
  const socket = connect(service.socketPath)
  socket.on('error', () => {})
  let received = reply(socket)
  socket.write(JSON.stringify({ type: 'auth', token: capabilities.issue(owner).token }) + '\n')
  await received
  received = reply(socket)
  socket.write(JSON.stringify({ type: 'run', id: 1, command: { op: 'screenshot', agent: 'other' } }) + '\n')
  expect(JSON.parse(String((await received)[0]))).toMatchObject({ type: 'result', id: 1, error: true })
  received = reply(socket)
  socket.write(JSON.stringify({ type: 'run', id: 2, command: { op: 'nope' } }) + '\n')
  expect(JSON.parse(String((await received)[0]))).toMatchObject({ type: 'result', id: 2, error: true })
  expect(dispatched).toBe(0)
  // A message carrying an owner field next to the command is a protocol violation.
  const closed = once(socket, 'close')
  socket.write(JSON.stringify({ type: 'run', id: 3, owner: { profileId: 'x' }, command: { op: 'screenshot' } }) + '\n')
  await closed
  expect(dispatched).toBe(0)
})

it('rejects duplicate request ids before dispatch', async () => {
  let dispatched = 0
  const { capabilities, service } = await fixture(async () => {
    dispatched++
    return { ok: true, data: null }
  })
  const socket = connect(service.socketPath)
  socket.on('error', () => {})
  let received = reply(socket)
  socket.write(JSON.stringify({ type: 'auth', token: capabilities.issue(owner).token }) + '\n')
  await received
  received = reply(socket)
  socket.write(JSON.stringify({ type: 'run', id: 2, command: { op: 'screenshot' } }) + '\n')
  await received
  expect(dispatched).toBe(1)
  const closed = once(socket, 'close')
  socket.write(JSON.stringify({ type: 'run', id: 2, command: { op: 'screenshot' } }) + '\n')
  await closed
  expect(dispatched).toBe(1)
})

it('results are bounded', async () => {
  const { capabilities, service } = await fixture(async () => ({
    ok: true,
    data: {
      windows: Array.from({ length: 5000 }, (_, i) => ({
        windowId: i + 1,
        pid: 1,
        app: 'a',
        title: 'x'.repeat(100),
        bounds: { x: 0, y: 0, width: 1, height: 1 },
        zIndex: i
      }))
    }
  }))
  const client = await DesktopIpcClient.connect(service.socketPath, capabilities.issue(owner).token)
  cleanups.push(async () => client.close())
  const result = await client.run({ op: 'windows' }, new AbortController().signal)
  expect(result.ok && JSON.stringify(result).length).toBeLessThan(60000)
  expect(result).toMatchObject({ ok: true, data: { truncated: true } })
  const huge = await fixture(async () => ({ ok: true, data: { image: { mimeType: 'image/png', base64: 'A'.repeat(8 * 1024 * 1024) } } }))
  const c2 = await DesktopIpcClient.connect(huge.service.socketPath, huge.capabilities.issue(owner).token)
  cleanups.push(async () => c2.close())
  expect(await c2.run({ op: 'screenshot' }, new AbortController().signal)).toMatchObject({ ok: false, code: 'image_limit' })
})

it('revoked capability drops the socket and aborts in-flight', async () => {
  let started!: () => void, aborted!: () => void
  const start = new Promise<void>((r) => {
      started = r
    }),
    abort = new Promise<void>((r) => {
      aborted = r
    })
  const { capabilities, service } = await fixture(async (_o, _c, signal) => {
    started()
    await new Promise<void>((r) =>
      signal.addEventListener(
        'abort',
        () => {
          aborted()
          r()
        },
        { once: true }
      )
    )
    return { ok: false, code: 'cancelled', message: 'Cancelled' }
  })
  const issued = capabilities.issue(owner),
    client = await DesktopIpcClient.connect(service.socketPath, issued.token)
  const pending = client.run({ op: 'windows' }, new AbortController().signal)
  const failed = expect(pending).rejects.toThrow()
  await start
  issued.revoke()
  await abort
  await failed
  await expect(client.run({ op: 'windows' }, new AbortController().signal)).rejects.toThrow()
  await expect(DesktopIpcClient.connect(service.socketPath, issued.token)).rejects.toThrow()
})

it('cancellation aborts a running request', async () => {
  let started!: () => void, aborted!: () => void
  const start = new Promise<void>((r) => {
      started = r
    }),
    abort = new Promise<void>((r) => {
      aborted = r
    })
  const { capabilities, service } = await fixture(async (_o, _c, signal) => {
    started()
    await new Promise<void>((r) =>
      signal.addEventListener(
        'abort',
        () => {
          aborted()
          r()
        },
        { once: true }
      )
    )
    return { ok: false, code: 'cancelled', message: 'Cancelled' }
  })
  const client = await DesktopIpcClient.connect(service.socketPath, capabilities.issue(owner).token)
  cleanups.push(async () => client.close())
  const controller = new AbortController(),
    pending = client.run({ op: 'requestUserAction', reason: 'Sign in' }, controller.signal)
  await start
  controller.abort()
  await expect(pending).rejects.toThrow()
  await abort
})

it('turn ids are single use', async () => {
  const { service } = await fixture()
  const first = await service.createDesktopTurn(owner, async () => {})
  await first.dispose()
  await expect(service.createDesktopTurn(owner, async () => {})).rejects.toThrow('Desktop unavailable')
  await expect(service.createDesktopTurn(owner, async () => {}, { side: true })).rejects.toThrow('Desktop unavailable')
})

it('remembers the newest 10 000 turn ids: one inside the window is refused, one pushed out is accepted again', async () => {
  const { service } = await fixture()
  const create = (turnId: string) => service.createDesktopTurn({ ...owner, turnId }, async () => {}, { side: true })
  for (let i = 0; i < 10000; i++) await (await create(`t${i}`)).dispose()
  await expect(create('t0')).rejects.toThrow('Desktop unavailable')
  await (await create('t10000')).dispose()
  // t0 was the oldest and is out; t1 is now the oldest still remembered.
  await expect(create('t1')).rejects.toThrow('Desktop unavailable')
  await expect(create('t10000')).rejects.toThrow('Desktop unavailable')
  await (await create('t0')).dispose()
}, 30000)

it('main turn args carry the ask settings, side turn args do not', async () => {
  const { capabilities, service } = await fixture()
  const main = await service.createDesktopTurn(owner, async () => {})
  const side = await service.createDesktopTurn({ ...owner, turnId: 'side' }, async () => {}, { side: true })
  expect(main.args[0]).toBe('--mcp-config')
  expect(main.args.slice(2)).toEqual(['--settings', DESKTOP_ASK_SETTINGS])
  expect(main.args.filter((a) => a === '--settings')).toHaveLength(1)
  expect(side.args).toHaveLength(2)
  expect(side.args).not.toContain('--settings')
  const asks = JSON.parse(DESKTOP_ASK_SETTINGS).permissions.ask as string[]
  expect(asks).toEqual(DESKTOP_ACTION_TOOLS.map(desktopToolName))
  expect(asks).toContain('mcp__zumibot_desktop__desktop_click')
  expect(asks).not.toContain('mcp__zumibot_desktop__desktop_screenshot')
  // Each run has its own capability; the owner is the issued one.
  expect(main.env.ZUMIBOT_DESKTOP_CAPABILITY).not.toBe(side.env.ZUMIBOT_DESKTOP_CAPABILITY)
  expect(capabilities.resolve(side.env.ZUMIBOT_DESKTOP_CAPABILITY!)).toEqual({ ...owner, turnId: 'side' })
  expect(main.prompt).toBe(desktopPrompt)
  await main.dispose()
  await side.dispose()
})

it('the real-CLI ask probe passes exactly the ask settings the app passes', () => {
  // The probe (npm run e2e) proves these rules force a card in auto mode; it must test the app's own string.
  expect(PROBE_ASK_SETTINGS).toBe(DESKTOP_ASK_SETTINGS)
})

it('the e2e fake claude expects ask rules for exactly the action tools', () => {
  // It asserts the `--settings` it gets against this list, so the two must not drift apart.
  expect(FAKE_ACTIONS).toEqual(DESKTOP_ACTION_TOOLS)
  // Every main run's one --settings also holds the process start rule, so the fake expects that too.
  expect(FAKE_PROCESS_START).toBe(PROCESS_START_TOOL)
})

it('main turn config names the bridge, with env placeholders and a long timeout', async () => {
  const { service } = await fixture()
  const turn = await service.createDesktopTurn(owner, async () => {})
  const config = JSON.parse(turn.args[1]).mcpServers.zumibot_desktop
  expect(config).toEqual({
    type: 'stdio',
    command: runtime.node,
    args: [runtime.bridgeEntry],
    timeout: 86400000,
    env: { ZUMIBOT_DESKTOP_CAPABILITY: '${ZUMIBOT_DESKTOP_CAPABILITY}', ZUMIBOT_DESKTOP_IPC: '${ZUMIBOT_DESKTOP_IPC}' }
  })
  expect(turn.env).toMatchObject({
    CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: '1',
    CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS: '0',
    ZUMIBOT_DESKTOP_IPC: service.socketPath
  })
  await turn.dispose()
  const electron = await serveDesktopIpc({
    capabilities: new BrowserCapabilities(),
    runtime: { ...runtime, electronNode: true },
    manager: { run: async () => ({ ok: true, data: null }), registerTurn: () => () => {}, endTurn: async () => {} }
  })
  cleanups.push(() => electron.close())
  const e = await electron.createDesktopTurn(owner, async () => {})
  expect(JSON.parse(e.args[1]).mcpServers.zumibot_desktop.env.ELECTRON_RUN_AS_NODE).toBe('1')
  expect(e.env.ELECTRON_RUN_AS_NODE).toBeUndefined()
  await e.dispose()
})

it('capability and IPC path never appear in args', async () => {
  const { service } = await fixture()
  const turn = await service.createDesktopTurn(owner, async () => {})
  const joined = turn.args.join(' ')
  expect(joined).not.toContain(turn.env.ZUMIBOT_DESKTOP_CAPABILITY!)
  expect(joined).not.toContain(service.socketPath)
  await turn.dispose()
})

it('main turns register handoff cards, side turns do not, and dispose revokes and ends the turn', async () => {
  const registered: string[] = [],
    ended: string[] = []
  const { capabilities, service } = await fixture(undefined, {
    registerTurn: (id) => {
      registered.push(id)
      return () => {
        registered.push('-' + id)
      }
    },
    endTurn: async (id) => {
      ended.push(id)
    }
  })
  const main = await service.createDesktopTurn(owner, async () => {})
  const side = await service.createDesktopTurn({ ...owner, turnId: 'side' }, async () => {}, { side: true })
  expect(registered).toEqual(['t'])
  await main.dispose()
  await side.dispose()
  expect(capabilities.resolve(main.env.ZUMIBOT_DESKTOP_CAPABILITY!)).toBeNull()
  expect(capabilities.resolve(side.env.ZUMIBOT_DESKTOP_CAPABILITY!)).toBeNull()
  expect(ended.sort()).toEqual(['side', 't'])
  expect(registered).toEqual(['t', '-t'])
})

it('rejects a relative bridge entry', async () => {
  const service = await serveDesktopIpc({
    capabilities: new BrowserCapabilities(),
    runtime: { ...runtime, bridgeEntry: 'desktopBridge.mjs' },
    manager: { run: async () => ({ ok: true, data: null }), registerTurn: () => () => {}, endTurn: async () => {} }
  })
  cleanups.push(() => service.close())
  await expect(service.createDesktopTurn(owner, async () => {})).rejects.toThrow('Desktop unavailable')
})

it('shutdown revokes handles, aborts running work and removes its runtime directory', async () => {
  let started!: () => void, aborted!: () => void
  const start = new Promise<void>((r) => {
      started = r
    }),
    abort = new Promise<void>((r) => {
      aborted = r
    })
  const { capabilities, service } = await fixture(async (_o, _c, signal) => {
    started()
    await new Promise<void>((r) =>
      signal.addEventListener(
        'abort',
        () => {
          aborted()
          r()
        },
        { once: true }
      )
    )
    return { ok: false, code: 'cancelled', message: 'Cancelled' }
  })
  const turn = await service.createDesktopTurn(owner, async () => {})
  const client = await DesktopIpcClient.connect(service.socketPath, turn.env.ZUMIBOT_DESKTOP_CAPABILITY!)
  const failed = expect(client.run({ op: 'windows' }, new AbortController().signal)).rejects.toThrow()
  await start
  await service.close()
  await abort
  await failed
  expect(capabilities.resolve(turn.env.ZUMIBOT_DESKTOP_CAPABILITY!)).toBeNull()
  await expect(stat(dirname(service.socketPath))).rejects.toThrow()
})
