import { afterEach, expect, it } from 'vitest'
import { connect } from 'node:net'
import { once } from 'node:events'
import { stat } from 'node:fs/promises'
import { dirname } from 'node:path'
import { serveAskIpc, AskIpcClient, type AskOwner } from '../../src/core/asks/askIpc'

const runtime = { node: '/usr/bin/node', askBridgeEntry: '/opt/cb/askBridge.mjs', electronNode: true }
const cleanups: (() => Promise<void> | void)[] = []
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close()
})

interface Seen {
  owner: AskOwner
  call: { agent: string; message: string }
  signal: AbortSignal
}
interface SeenSide {
  owner: AskOwner
  call: { agent: string; question: string }
  signal: AbortSignal
}
/** A service whose ask waits until its signal aborts (wait) or answers at once. */
function fakeService(opts: { fail?: Error; wait?: boolean } = {}) {
  const seen: Seen[] = [],
    seenSide: SeenSide[] = []
  const service = {
    sideAsk: async (owner: AskOwner, call: SeenSide['call'], signal: AbortSignal): Promise<string> => {
      seenSide.push({ owner, call, signal })
      if (opts.fail) throw opts.fail
      if (!opts.wait) return `side answer to ${call.agent}`
      return await new Promise<string>((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new Error('Stopped')), { once: true })
      })
    },
    ask: async (owner: AskOwner, call: Seen['call'], signal: AbortSignal): Promise<string> => {
      seen.push({ owner, call, signal })
      if (opts.fail) throw opts.fail
      if (!opts.wait) return `answer to ${call.agent}`
      return await new Promise<string>((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new Error('Stopped')), { once: true })
      })
    }
  }
  return { service, seen, seenSide }
}
async function fixture(service: ReturnType<typeof fakeService>['service']) {
  const ipc = await serveAskIpc({ service, runtime })
  cleanups.push(() => ipc.close())
  return ipc
}
const owner = (): AskOwner => ({ chatId: 'c1', agent: () => 'ann', chain: ['ann'], turn: 't1' })
async function client(ipc: Awaited<ReturnType<typeof fixture>>, token: string) {
  const c = await AskIpcClient.connect(ipc.socketPath, token)
  cleanups.push(() => c.close())
  return c
}
const never = () => new AbortController().signal

it("uses a private socket and gives the turn's client the service text, owner from the token", async () => {
  const f = fakeService()
  const ipc = await fixture(f.service)
  if (process.platform !== 'win32') expect((await stat(ipc.socketPath)).mode & 0o777).toBe(0o600)
  if (process.platform !== 'win32') expect((await stat(dirname(ipc.socketPath))).mode & 0o777).toBe(0o700)
  const turn = ipc.createAskTurn(owner())
  const c = await client(ipc, turn.env.ZUMIBOT_ASKS_CAPABILITY!)
  expect(await c.run({ agent: '@b', message: 'hi' }, never())).toBe('answer to @b')
  expect(f.seen[0].owner).toMatchObject({ chatId: 'c1', chain: ['ann'], turn: 't1' })
  expect(f.seen[0].owner.agent()).toBe('ann')
  expect(f.seen[0].call).toEqual({ agent: '@b', message: 'hi' })
  turn.dispose()
})

it('refuses a wrong token', async () => {
  const ipc = await fixture(fakeService().service)
  await expect(AskIpcClient.connect(ipc.socketPath, 'unknown')).rejects.toThrow('Agents unavailable')
})

it('a foreign key in a request cuts the socket and never reaches the service', async () => {
  const f = fakeService()
  const ipc = await fixture(f.service)
  const turn = ipc.createAskTurn(owner())
  const raw = connect(ipc.socketPath)
  cleanups.push(() => {
    raw.destroy()
  })
  const lines: string[] = []
  raw.on('data', (b) => lines.push(...String(b).split('\n').filter(Boolean)))
  raw.write(JSON.stringify({ type: 'auth', token: turn.env.ZUMIBOT_ASKS_CAPABILITY }) + '\n')
  await expect.poll(() => lines.length).toBe(1)
  const closed = once(raw, 'close')
  raw.write(JSON.stringify({ type: 'run', id: 1, chatId: 'other', call: { agent: 'b', message: 'hi' } }) + '\n')
  await closed
  expect(f.seen).toHaveLength(0)
  turn.dispose()
})

it('a message of 20 000 multi-byte and escaped characters fits the request limit', async () => {
  const f = fakeService()
  const ipc = await fixture(f.service)
  const turn = ipc.createAskTurn(owner())
  const c = await client(ipc, turn.env.ZUMIBOT_ASKS_CAPABILITY!)
  for (const ch of ['ع', '\u0001', '"']) {
    const message = ch.repeat(20_000)
    expect(await c.run({ agent: 'b', message }, never())).toBe('answer to b')
    expect(f.seen.at(-1)!.call.message).toBe(message)
  }
  turn.dispose()
})

it('aborting the client signal aborts the service signal', async () => {
  const f = fakeService({ wait: true })
  const ipc = await fixture(f.service)
  const turn = ipc.createAskTurn(owner())
  const c = await client(ipc, turn.env.ZUMIBOT_ASKS_CAPABILITY!)
  const ctl = new AbortController()
  const run = c.run({ agent: 'b', message: 'hi' }, ctl.signal)
  await expect.poll(() => f.seen.length).toBe(1)
  expect(f.seen[0].signal.aborted).toBe(false)
  ctl.abort()
  await expect(run).rejects.toThrow('Agents unavailable')
  await expect.poll(() => f.seen[0].signal.aborted).toBe(true)
  // A cancelled call leaves the connection usable.
  f.service.ask = async () => 'again'
  expect(await c.run({ agent: 'b', message: 'hi' }, never())).toBe('again')
  turn.dispose()
})

it('closing the client socket aborts the service signal', async () => {
  const f = fakeService({ wait: true })
  const ipc = await fixture(f.service)
  const turn = ipc.createAskTurn(owner())
  const c = await AskIpcClient.connect(ipc.socketPath, turn.env.ZUMIBOT_ASKS_CAPABILITY!)
  const run = c.run({ agent: 'b', message: 'hi' }, never()).catch(() => {})
  await expect.poll(() => f.seen.length).toBe(1)
  c.close()
  await run
  await expect.poll(() => f.seen[0].signal.aborted).toBe(true)
  turn.dispose()
})

it('dispose aborts a running call and rejects new calls and new connections', async () => {
  const f = fakeService({ wait: true })
  const ipc = await fixture(f.service)
  const turn = ipc.createAskTurn(owner())
  const token = turn.env.ZUMIBOT_ASKS_CAPABILITY!
  const c = await client(ipc, token)
  const run = c.run({ agent: 'b', message: 'hi' }, never()).catch((e: Error) => e)
  await expect.poll(() => f.seen.length).toBe(1)
  turn.dispose()
  expect(f.seen[0].signal.aborted).toBe(true)
  expect(((await run) as Error).message).toBe('Agents unavailable')
  await expect(c.run({ agent: 'b', message: 'hi' }, never())).rejects.toThrow('Agents unavailable')
  await expect(AskIpcClient.connect(ipc.socketPath, token)).rejects.toThrow('Agents unavailable')
})

it('puts the capability in env only, with the long timeout and no MCP auto-background', async () => {
  const ipc = await fixture(fakeService().service)
  const turn = ipc.createAskTurn(owner())
  expect(turn.args[0]).toBe('--mcp-config')
  expect(turn.args).toHaveLength(2)
  expect(turn.args[1]).toContain('"timeout":86400000')
  expect(JSON.parse(turn.args[1]).mcpServers.zumibot_agents).toEqual({
    type: 'stdio',
    command: '/usr/bin/node',
    args: ['/opt/cb/askBridge.mjs'],
    timeout: 86400000,
    env: {
      ZUMIBOT_ASKS_CAPABILITY: '${ZUMIBOT_ASKS_CAPABILITY}',
      ZUMIBOT_ASKS_IPC: '${ZUMIBOT_ASKS_IPC}',
      ELECTRON_RUN_AS_NODE: '1'
    }
  })
  expect(turn.args.join(' ')).not.toContain(turn.env.ZUMIBOT_ASKS_CAPABILITY!)
  expect(turn.env).toMatchObject({ ZUMIBOT_ASKS_IPC: ipc.socketPath, CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS: '0' })
  expect(turn.env.ZUMIBOT_ASKS_CAPABILITY).toMatch(/^[0-9a-f]{64}$/)
  expect(ipc.createAskTurn(owner()).env.ZUMIBOT_ASKS_CAPABILITY).not.toBe(turn.env.ZUMIBOT_ASKS_CAPABILITY)
})

it('the service error text reaches the caller only when it is a plain sentence', async () => {
  const plain = await fixture(fakeService({ fail: new Error('No agent named b. Agents you can ask: ann, carl') }).service)
  const t1 = plain.createAskTurn(owner())
  const c1 = await client(plain, t1.env.ZUMIBOT_ASKS_CAPABILITY!)
  await expect(c1.run({ agent: 'b', message: 'hi' }, never())).rejects.toThrow('No agent named b. Agents you can ask: ann, carl')
  const leaky = await fixture(fakeService({ fail: new Error('Error: ENOENT /x') }).service)
  const t2 = leaky.createAskTurn(owner())
  const c2 = await client(leaky, t2.env.ZUMIBOT_ASKS_CAPABILITY!)
  const err = await c2.run({ agent: 'b', message: 'hi' }, never()).catch((e: Error) => e)
  expect((err as Error).message).toBe('Agents unavailable')
})

it('refusal sentences carrying handles reach the caller verbatim', async () => {
  for (const text of ['@b finished without writing a reply.', '@my_agent is already waiting in this chain']) {
    const ipc = await fixture(fakeService({ fail: new Error(text) }).service)
    const t = ipc.createAskTurn(owner())
    const c = await client(ipc, t.env.ZUMIBOT_ASKS_CAPABILITY!)
    const err = await c.run({ agent: 'b', message: 'hi' }, never()).catch((e: Error) => e)
    expect((err as Error).message).toBe(text)
  }
})

it('close revokes every turn, aborts calls, cuts the sockets and removes its directory', async () => {
  const f = fakeService({ wait: true })
  const ipc = await serveAskIpc({ service: f.service, runtime })
  const turn = ipc.createAskTurn(owner())
  const c = await AskIpcClient.connect(ipc.socketPath, turn.env.ZUMIBOT_ASKS_CAPABILITY!)
  void c.run({ agent: 'b', message: 'hi' }, never()).catch(() => {})
  await expect.poll(() => f.seen.length).toBe(1)
  await ipc.close()
  expect(f.seen[0].signal.aborted).toBe(true)
  await expect(stat(dirname(ipc.socketPath))).rejects.toThrow()
  expect(() => ipc.createAskTurn(owner())).toThrow('Agents unavailable')
})

it('a side request reaches service.sideAsk with the token owner, not service.ask', async () => {
  const f = fakeService()
  const ipc = await fixture(f.service)
  const turn = ipc.createAskTurn(owner())
  const c = await client(ipc, turn.env.ZUMIBOT_ASKS_CAPABILITY!)
  expect(await c.side({ agent: '@b', question: 'why?' }, never())).toBe('side answer to @b')
  expect(f.seen).toHaveLength(0)
  expect(f.seenSide[0].owner).toMatchObject({ chatId: 'c1', chain: ['ann'], turn: 't1' })
  expect(f.seenSide[0].owner.agent()).toBe('ann')
  expect(f.seenSide[0].call).toEqual({ agent: '@b', question: 'why?' })
  turn.dispose()
})

it('a side request with an extra key or a run-shaped call gets an error result', async () => {
  const f = fakeService()
  const ipc = await fixture(f.service)
  const turn = ipc.createAskTurn(owner())
  const raw = connect(ipc.socketPath)
  cleanups.push(() => {
    raw.destroy()
  })
  const lines: string[] = []
  raw.on('data', (b) => lines.push(...String(b).split('\n').filter(Boolean)))
  raw.write(JSON.stringify({ type: 'auth', token: turn.env.ZUMIBOT_ASKS_CAPABILITY }) + '\n')
  await expect.poll(() => lines.length).toBe(1)
  raw.write(JSON.stringify({ type: 'side', id: 1, call: { agent: 'b', question: 'q', chatId: 'other' } }) + '\n')
  await expect.poll(() => lines.length).toBe(2)
  expect(JSON.parse(lines[1])).toMatchObject({ type: 'result', id: 1, ok: false })
  raw.write(JSON.stringify({ type: 'side', id: 2, call: { agent: 'b', message: 'hi' } }) + '\n')
  await expect.poll(() => lines.length).toBe(3)
  expect(JSON.parse(lines[2])).toMatchObject({ type: 'result', id: 2, ok: false })
  expect(f.seen).toHaveLength(0)
  expect(f.seenSide).toHaveLength(0)
  turn.dispose()
})

it('aborting the client signal aborts a side call signal', async () => {
  const f = fakeService({ wait: true })
  const ipc = await fixture(f.service)
  const turn = ipc.createAskTurn(owner())
  const c = await client(ipc, turn.env.ZUMIBOT_ASKS_CAPABILITY!)
  const ctl = new AbortController()
  const run = c.side({ agent: 'b', question: 'q' }, ctl.signal)
  await expect.poll(() => f.seenSide.length).toBe(1)
  expect(f.seenSide[0].signal.aborted).toBe(false)
  ctl.abort()
  await expect(run).rejects.toThrow('Agents unavailable')
  await expect.poll(() => f.seenSide[0].signal.aborted).toBe(true)
  turn.dispose()
})
