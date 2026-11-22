import { afterEach, expect, it } from 'vitest'
import { connect } from 'node:net'
import { once } from 'node:events'
import { stat } from 'node:fs/promises'
import { dirname } from 'node:path'
import { BrowserCapabilities } from '../../src/core/browser/browserCapabilities'
import { serveBrowserIpc, BrowserIpcClient } from '../../src/core/browser/browserIpc'
import type { BrowserIpcManager } from '../../src/core/browser/browserIpc'

const owner = { profileId: 'p', chatId: 'c', turnId: 't' }
const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close()
})
async function fixture(run: BrowserIpcManager['run'] = async (o, command) => ({ ok: true, data: { owner: o, command } })) {
  const capabilities = new BrowserCapabilities()
  const service = await serveBrowserIpc({ capabilities, manager: { run, registerTurn: () => () => {}, endTurn: async () => {} } })
  cleanups.push(() => service.close())
  return { capabilities, service }
}
it('uses private socket and rejects unknown tokens, foreign owner fields and revoked live connections', async () => {
  const { capabilities, service } = await fixture()
  if (process.platform !== 'win32') expect((await stat(service.socketPath)).mode & 0o777).toBe(0o600)
  if (process.platform !== 'win32') expect((await stat(dirname(service.socketPath))).mode & 0o777).toBe(0o700)
  await expect(BrowserIpcClient.connect(service.socketPath, 'unknown')).rejects.toThrow('Browser unavailable')
  const issued = capabilities.issue(owner),
    client = await BrowserIpcClient.connect(service.socketPath, issued.token)
  cleanups.push(async () => client.close())
  expect(await client.run({ op: 'tabs' }, new AbortController().signal)).toMatchObject({ ok: true, data: { owner } })
  await expect(client.run({ op: 'tabs', profileId: 'other' } as never, new AbortController().signal)).rejects.toThrow()
  issued.revoke()
  await expect(client.run({ op: 'tabs' }, new AbortController().signal)).rejects.toThrow()
})
it.each(['{bad json}\n', 'x'.repeat(70000)])('closes malformed or oversized unauthenticated input', async (input) => {
  const { service } = await fixture()
  const socket = connect(service.socketPath)
  socket.on('error', () => {})
  const closed = once(socket, 'close')
  socket.write(input)
  await closed
})
it('cancellation and connection EOF abort running requests', async () => {
  let started!: () => void, aborted!: () => void
  let start = new Promise<void>((r) => {
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
  const client = await BrowserIpcClient.connect(service.socketPath, capabilities.issue(owner).token)
  const controller = new AbortController(),
    pending = client.run({ op: 'requestUserAction', reason: 'Sign in' }, controller.signal)
  await start
  controller.abort()
  await expect(pending).rejects.toThrow()
  await abort
  start = new Promise<void>((r) => {
    started = r
  })
  abort = new Promise<void>((r) => {
    aborted = r
  })
  const second = client.run({ op: 'observe' }, new AbortController().signal)
  await start
  client.close()
  await expect(second).rejects.toThrow()
  await abort
})

it('rejects raw foreign owner fields and duplicate request IDs before dispatch', async () => {
  let dispatched = 0
  const { capabilities, service } = await fixture(async () => {
    dispatched++
    return { ok: true, data: null }
  })
  const socket = connect(service.socketPath)
  socket.on('error', () => {})
  const reply = () => once(socket, 'data')
  let received = reply()
  socket.write(JSON.stringify({ type: 'auth', token: capabilities.issue(owner).token }) + '\n')
  await received
  received = reply()
  socket.write(JSON.stringify({ type: 'run', id: 1, command: { op: 'tabs', agent: 'other' } }) + '\n')
  expect(JSON.parse(String((await received)[0]))).toMatchObject({ type: 'result', id: 1, error: true })
  expect(dispatched).toBe(0)
  received = reply()
  socket.write(JSON.stringify({ type: 'run', id: 2, command: { op: 'tabs' } }) + '\n')
  await received
  expect(dispatched).toBe(1)
  const closed = once(socket, 'close')
  socket.write(JSON.stringify({ type: 'run', id: 2, command: { op: 'tabs' } }) + '\n')
  await closed
  expect(dispatched).toBe(1)
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
  const turn = await service.createBrowserTurn(owner, async () => {})
  const client = await BrowserIpcClient.connect(service.socketPath, turn.env.ZUMIBOT_BROWSER_CAPABILITY!)
  const pending = client.run({ op: 'observe' }, new AbortController().signal)
  const failed = expect(pending).rejects.toThrow()
  await start
  await service.close()
  await abort
  await failed
  expect(capabilities.resolve(turn.env.ZUMIBOT_BROWSER_CAPABILITY!)).toBeNull()
  await expect(stat(dirname(service.socketPath))).rejects.toThrow()
})
