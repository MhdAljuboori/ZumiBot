import { afterEach, expect, it } from 'vitest'
import { connect } from 'node:net'
import { once } from 'node:events'
import { stat } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { VaultAgentItem } from '@zumibot/shared/vault'
import { serveVaultIpc, VaultIpcClient } from '../../src/core/vault/vaultIpc'
import { parseVaultCall, parseVaultWire, vaultTools } from '../../src/core/vault/vaultTools'

const runtime = { node: '/usr/bin/node', vaultBridgeEntry: '/opt/cb/vaultBridge.mjs', electronNode: true }
const cleanups: (() => Promise<void> | void)[] = []
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close()
})

const itemsOf: Record<string, VaultAgentItem[]> = {
  ann: [{ id: 'k1', kind: 'apiKey', name: 'Azure PAT', env: 'AZURE_PAT', description: 'devops' }],
  bob: [{ id: 'l1', kind: 'login', name: 'Gmail', sites: ['mail.google.com'], username: 'bob@x.com', hasCode: true }]
}
async function fixture() {
  const seen: string[] = []
  const ipc = await serveVaultIpc({
    items: (agent) => {
      seen.push(agent)
      return itemsOf[agent] ?? []
    },
    runtime
  })
  cleanups.push(() => ipc.close())
  return { ipc, seen }
}
const owner = (agent = 'ann') => ({ chatId: 'c1', agent: () => agent, turn: 't1' })

it("lists only the owner agent's items", async () => {
  const { ipc, seen } = await fixture()
  let speaker = 'ann'
  const turn = ipc.createVaultTurn({ chatId: 'c1', agent: () => speaker, turn: 't1' })
  const client = await VaultIpcClient.connect(ipc.socketPath, turn.env.ZUMIBOT_VAULT_CAPABILITY!)
  cleanups.push(() => client.close())
  expect(JSON.parse(await client.run({ op: 'items' }))).toEqual(itemsOf.ann)
  speaker = 'bob' // a room's speaker is read at call time
  expect(JSON.parse(await client.run({ op: 'items' }))).toEqual(itemsOf.bob)
  speaker = 'nobody'
  expect(await client.run({ op: 'items' })).toBe('[]')
  expect(seen).toEqual(['ann', 'bob', 'nobody'])
  if (process.platform !== 'win32') expect((await stat(ipc.socketPath)).mode & 0o777).toBe(0o600)
  if (process.platform !== 'win32') expect((await stat(dirname(ipc.socketPath))).mode & 0o777).toBe(0o700)
  // Windows has no socket files: a fresh named pipe instead.
  expect(ipc.socketPath).toMatch(process.platform === 'win32' ? /^\\\\\.\\pipe\\zumibot-v-/ : /^\/tmp\/cb-v-/)
})

it('refuses a revoked token', async () => {
  const { ipc } = await fixture()
  await expect(VaultIpcClient.connect(ipc.socketPath, 'unknown')).rejects.toThrow('Vault unavailable')
  const turn = ipc.createVaultTurn(owner())
  const client = await VaultIpcClient.connect(ipc.socketPath, turn.env.ZUMIBOT_VAULT_CAPABILITY!)
  cleanups.push(() => client.close())
  expect(await client.run({ op: 'items' })).toContain('AZURE_PAT')
  turn.dispose()
  await expect(client.run({ op: 'items' })).rejects.toThrow('Vault unavailable')
  await expect(VaultIpcClient.connect(ipc.socketPath, turn.env.ZUMIBOT_VAULT_CAPABILITY!)).rejects.toThrow('Vault unavailable')
})

it('ignores caller-supplied chat or agent fields', async () => {
  const { ipc, seen } = await fixture()
  const turn = ipc.createVaultTurn(owner('ann'))
  const client = await VaultIpcClient.connect(ipc.socketPath, turn.env.ZUMIBOT_VAULT_CAPABILITY!)
  cleanups.push(() => client.close())
  // A foreign key in the call is refused and never reaches the items reader.
  await expect(client.run({ op: 'items', agent: 'bob' } as never)).rejects.toThrow()
  await expect(client.run({ op: 'items', chatId: 'other' } as never)).rejects.toThrow()
  expect(seen).toEqual([])
  // At the message level too: the socket is cut.
  const raw = connect(ipc.socketPath)
  cleanups.push(() => {
    raw.destroy()
  })
  const lines: string[] = []
  raw.on('data', (b) => lines.push(...String(b).split('\n').filter(Boolean)))
  raw.write(JSON.stringify({ type: 'auth', token: turn.env.ZUMIBOT_VAULT_CAPABILITY }) + '\n')
  await expect.poll(() => lines.length).toBe(1)
  const closed = once(raw, 'close')
  raw.write(JSON.stringify({ type: 'run', id: 1, agent: 'bob', call: { op: 'items' } }) + '\n')
  await closed
  expect(seen).toEqual([])
})

it('puts the capability in env only and builds its own mcp-config from placeholders', async () => {
  const { ipc } = await fixture()
  const turn = ipc.createVaultTurn(owner())
  expect(turn.args[0]).toBe('--mcp-config')
  expect(turn.args).toHaveLength(2)
  expect(JSON.parse(turn.args[1]).mcpServers.zumibot_vault).toEqual({
    type: 'stdio',
    command: '/usr/bin/node',
    args: ['/opt/cb/vaultBridge.mjs'],
    alwaysLoad: true,
    env: {
      ZUMIBOT_VAULT_CAPABILITY: '${ZUMIBOT_VAULT_CAPABILITY}',
      ZUMIBOT_VAULT_IPC: '${ZUMIBOT_VAULT_IPC}',
      ELECTRON_RUN_AS_NODE: '1'
    }
  })
  expect(turn.args.join(' ')).not.toContain(turn.env.ZUMIBOT_VAULT_CAPABILITY!)
  expect(turn.env.ZUMIBOT_VAULT_IPC).toBe(ipc.socketPath)
  expect(turn.env.ZUMIBOT_VAULT_CAPABILITY).toMatch(/^[0-9a-f]{64}$/)
  expect(ipc.createVaultTurn(owner()).env.ZUMIBOT_VAULT_CAPABILITY).not.toBe(turn.env.ZUMIBOT_VAULT_CAPABILITY)
})

it('a failing reader reaches the agent as the generic text only', async () => {
  const ipc = await serveVaultIpc({
    items: () => {
      throw Object.assign(new Error('VAULT_UNAVAILABLE'), { code: 'EACCES' })
    },
    runtime
  })
  cleanups.push(() => ipc.close())
  const turn = ipc.createVaultTurn(owner())
  const client = await VaultIpcClient.connect(ipc.socketPath, turn.env.ZUMIBOT_VAULT_CAPABILITY!)
  cleanups.push(() => client.close())
  expect(((await client.run({ op: 'items' }).catch((e: Error) => e)) as Error).message).toBe('Vault unavailable')
})

it('close revokes every turn, cuts the sockets and removes its directory', async () => {
  const ipc = await serveVaultIpc({ items: () => [], runtime })
  const turn = ipc.createVaultTurn(owner())
  const client = await VaultIpcClient.connect(ipc.socketPath, turn.env.ZUMIBOT_VAULT_CAPABILITY!)
  await ipc.close()
  await expect(client.run({ op: 'items' })).rejects.toThrow('Vault unavailable')
  await expect(stat(dirname(ipc.socketPath))).rejects.toThrow()
  expect(() => ipc.createVaultTurn(owner())).toThrow('Vault unavailable')
})

it('parseVaultCall takes no arguments at all', () => {
  expect(parseVaultCall('vault_items', {})).toEqual({ op: 'items' })
  expect(parseVaultWire({ op: 'items' })).toEqual({ op: 'items' })
  for (const [name, args] of [
    ['nope', {}],
    ['vault_items', { agent: 'bob' }],
    ['vault_items', null],
    ['vault_items', []]
  ] as const) {
    expect(() => parseVaultCall(name, args), JSON.stringify([name, args])).toThrow()
  }
  expect(() => parseVaultWire({ op: 'items', chatId: 'c' })).toThrow()
  expect(() => parseVaultWire(null)).toThrow()
  expect(vaultTools).toHaveLength(1)
  expect(vaultTools[0]).toMatchObject({ name: 'vault_items', inputSchema: { type: 'object', properties: {}, additionalProperties: false } })
})
