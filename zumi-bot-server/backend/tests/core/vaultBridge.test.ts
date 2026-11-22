import { afterAll, beforeAll, expect, it } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { build } from 'vite'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { serveVaultIpc } from '../../src/core/vault/vaultIpc'

let artifact: string
beforeAll(async () => {
  artifact = await mkdtemp(join(tmpdir(), 'cb-vault-bridge-test-'))
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

async function start(items: () => never[] | unknown[]) {
  const ipc = await serveVaultIpc({
    items: items as never,
    runtime: { node: process.execPath, vaultBridgeEntry: join(artifact, 'vaultBridge.mjs'), electronNode: false }
  })
  const turn = ipc.createVaultTurn({ chatId: 'c1', agent: () => 'ann', turn: 't1' })
  const client = new Client({ name: 'test', version: '1' })
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [join(artifact, 'vaultBridge.mjs')],
    env: turn.env as Record<string, string>,
    stderr: 'pipe'
  })
  let stderr = ''
  transport.stderr?.on('data', (d) => {
    stderr += d
  })
  return { ipc, turn, client, transport, stderr: () => stderr }
}

it('exposes one tool vault_items with an empty schema', async () => {
  const t = await start(() => [{ id: 'k1', kind: 'apiKey', name: 'Azure PAT', env: 'AZURE_PAT', description: '' }])
  try {
    await t.client.connect(t.transport)
    const { tools } = await t.client.listTools()
    expect(tools.map((x) => x.name)).toEqual(['vault_items'])
    expect(tools[0].inputSchema).toMatchObject({ type: 'object', properties: {}, additionalProperties: false })
    const result = await t.client.callTool({ name: 'vault_items', arguments: {} })
    expect(result).toEqual({
      content: [
        { type: 'text', text: JSON.stringify([{ id: 'k1', kind: 'apiKey', name: 'Azure PAT', env: 'AZURE_PAT', description: '' }]) }
      ]
    })
    // No argument exists: an agent name is refused before it reaches the server.
    expect(await t.client.callTool({ name: 'vault_items', arguments: { agent: 'bob' } })).toMatchObject({ isError: true })
    expect(await t.client.callTool({ name: 'nope', arguments: {} })).toMatchObject({ isError: true })
    t.turn.dispose()
    expect(await t.client.callTool({ name: 'vault_items', arguments: {} })).toMatchObject({
      isError: true,
      content: [{ text: 'Vault unavailable' }]
    })
    expect(t.stderr()).not.toContain(t.turn.env.ZUMIBOT_VAULT_CAPABILITY)
  } finally {
    await t.client.close()
    t.turn.dispose()
    await t.ipc.close()
  }
})

// POSIX by design: the preload reports on SIGUSR2, which Windows cannot deliver.
it.skipIf(process.platform === 'win32')('deletes its capability env before serving', async () => {
  // A preload reports the bridge's own env on SIGUSR2, which is what any process it started would inherit.
  const dir = await mkdtemp(join(tmpdir(), 'cb-vault-env-'))
  const report = join(dir, 'env.json'),
    preload = join(dir, 'preload.cjs')
  await writeFile(
    preload,
    `process.on('SIGUSR2', () => require('fs').writeFileSync(${JSON.stringify(report)}, JSON.stringify({ cap: process.env.ZUMIBOT_VAULT_CAPABILITY ?? null, ipc: process.env.ZUMIBOT_VAULT_IPC ?? null, electron: process.env.ELECTRON_RUN_AS_NODE ?? null })))`
  )
  const ipc = await serveVaultIpc({
    items: () => [],
    runtime: { node: process.execPath, vaultBridgeEntry: join(artifact, 'vaultBridge.mjs'), electronNode: false }
  })
  const turn = ipc.createVaultTurn({ chatId: 'c1', agent: () => 'ann', turn: 't1' })
  const client = new Client({ name: 'test', version: '1' })
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ['--require', preload, join(artifact, 'vaultBridge.mjs')],
    env: { ...turn.env, ELECTRON_RUN_AS_NODE: '1' } as Record<string, string>
  })
  try {
    await client.connect(transport)
    await client.listTools() // serving: the env was read and cleared before this answered
    process.kill(transport.pid!, 'SIGUSR2')
    await expect.poll(() => readFile(report, 'utf8').catch(() => ''), { timeout: 3000 }).not.toBe('')
    expect(JSON.parse(await readFile(report, 'utf8'))).toEqual({ cap: null, ipc: null, electron: null })
  } finally {
    await client.close()
    turn.dispose()
    await ipc.close()
    await rm(dir, { recursive: true, force: true })
  }
})
