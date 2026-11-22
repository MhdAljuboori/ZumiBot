import { afterAll, beforeAll, expect, it } from 'vitest'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { build } from 'vite'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import type { DesktopCommand, DesktopOwner } from '@zumibot/shared/desktop'
import { BrowserCapabilities } from '../../../src/core/browser/browserCapabilities'
import { serveDesktopIpc } from '../../../src/core/desktop/desktopIpc'

let artifact: string
beforeAll(async () => {
  artifact = await mkdtemp(join(tmpdir(), 'cb-dbridge-test-'))
  await build({
    root: resolve('zumi-bot-server/backend'),
    configFile: resolve('zumi-bot-server/backend/vite.config.ts'),
    build: { outDir: artifact },
    logLevel: 'silent'
  })
}, 60000)
afterAll(async () => {
  await rm(artifact, { recursive: true, force: true })
})
const owner: DesktopOwner = { profileId: 'p', chatId: 'c', turnId: 't' }
const stamp = { generation: 'g', epoch: 1, observationId: 'obs' }
const bridge = () => join(artifact, 'desktopBridge.mjs')

it('is emitted by the backend build', async () => {
  expect((await stat(bridge())).isFile()).toBe(true)
})

it('tools/list returns the 15 tools, tools/call maps to an IPC run and returns text then image', async () => {
  const calls: DesktopCommand[] = []
  const service = await serveDesktopIpc({
    capabilities: new BrowserCapabilities(),
    runtime: { node: process.execPath, bridgeEntry: bridge(), electronNode: true },
    manager: {
      registerTurn: () => () => {},
      endTurn: async () => {},
      run: async (actual, command) => {
        expect(actual).toEqual(owner)
        calls.push(command)
        if (command.op === 'screenshot')
          return { ok: true, data: { stamp, width: 1280, height: 800, image: { mimeType: 'image/png', base64: 'iVBORw0K' } } }
        return { ok: true, data: { clicked: true } }
      }
    }
  })
  const turn = await service.createDesktopTurn(owner, async () => {})
  const config = JSON.parse(turn.args[turn.args.indexOf('--mcp-config') + 1]).mcpServers.zumibot_desktop
  expect(config.env.ELECTRON_RUN_AS_NODE).toBe('1')
  const client = new Client({ name: 'test', version: '1' })
  const transport = new StdioClientTransport({
    command: config.command,
    args: config.args,
    env: { ...config.env, ...turn.env } as Record<string, string>,
    cwd: artifact,
    stderr: 'pipe'
  })
  let stderr = ''
  transport.stderr?.on('data', (data) => {
    stderr += data
  })
  try {
    await client.connect(transport)
    const tools = await client.listTools()
    expect(tools.tools).toHaveLength(15)
    expect(tools.tools.map((t) => t.name)).toEqual(
      expect.arrayContaining(['desktop_screenshot', 'desktop_click', 'desktop_request_user_action', 'desktop_release'])
    )
    expect(calls).toHaveLength(0)
    const shot = await client.callTool({ name: 'desktop_screenshot', arguments: {} })
    expect((shot.content as { type: string }[]).map((c) => c.type)).toEqual(['text', 'image'])
    expect(shot.content).toMatchObject([
      { type: 'text', text: expect.stringContaining('"observationId":"obs"') },
      { type: 'image', mimeType: 'image/png', data: 'iVBORw0K' }
    ])
    expect(await client.callTool({ name: 'desktop_click', arguments: { stamp, x: 10, y: 20 } })).toMatchObject({
      content: [{ type: 'text', text: expect.stringContaining('"clicked":true') }]
    })
    expect(calls).toEqual([{ op: 'screenshot' }, { op: 'click', stamp, x: 10, y: 20 }])
    // A caller-supplied agent or profile is refused before it reaches the server.
    expect(await client.callTool({ name: 'desktop_screenshot', arguments: { agent: 'other' } })).toMatchObject({ isError: true })
    expect(await client.callTool({ name: 'desktop_nope', arguments: {} })).toMatchObject({ isError: true })
    expect(calls).toHaveLength(2)
    await turn.dispose()
    expect(await client.callTool({ name: 'desktop_windows', arguments: {} })).toMatchObject({ isError: true })
    expect(stderr).not.toContain(turn.env.ZUMIBOT_DESKTOP_CAPABILITY)
  } finally {
    await client.close()
    await turn.dispose()
    await service.close()
  }
}, 20000)

it('bridge scrubs its capability env and server name is zumibot_desktop', async () => {
  const service = await serveDesktopIpc({
    capabilities: new BrowserCapabilities(),
    runtime: { node: process.execPath, bridgeEntry: bridge(), electronNode: false },
    manager: {
      registerTurn: () => () => {},
      endTurn: async () => {},
      run: async () => ({ ok: true, data: null })
    }
  })
  const turn = await service.createDesktopTurn(owner, async () => {})
  const client = new Client({ name: 'test', version: '1' })
  try {
    await client.connect(
      new StdioClientTransport({ command: process.execPath, args: [bridge()], env: turn.env as Record<string, string>, stderr: 'pipe' })
    )
    expect(client.getServerVersion()?.name).toBe('zumibot_desktop')
  } finally {
    await client.close()
    await turn.dispose()
    await service.close()
  }
}, 20000)

it('requestUserAction keeps progress notifications and cancellation aborts the wait', async () => {
  let started!: () => void, aborted!: () => void
  const start = new Promise<void>((r) => {
      started = r
    }),
    abort = new Promise<void>((r) => {
      aborted = r
    })
  const service = await serveDesktopIpc({
    capabilities: new BrowserCapabilities(),
    runtime: { node: process.execPath, bridgeEntry: bridge(), electronNode: false },
    manager: {
      registerTurn: () => () => {},
      endTurn: async () => {},
      run: async (_owner, _command, signal) => {
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
        return { ok: false, code: 'handoff_interrupted', message: 'Desktop request interrupted' }
      }
    }
  })
  const turn = await service.createDesktopTurn(owner, async () => {})
  const client = new Client({ name: 'test', version: '1' })
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [bridge()],
    env: turn.env as Record<string, string>,
    stderr: 'pipe'
  })
  try {
    await client.connect(transport)
    const controller = new AbortController()
    const progress: unknown[] = []
    let notified!: () => void
    const notification = new Promise<void>((r) => {
      notified = r
    })
    const pending = client.callTool({ name: 'desktop_request_user_action', arguments: { reason: 'Private sign-in context' } }, undefined, {
      signal: controller.signal,
      timeout: 40000,
      onprogress: (value) => {
        progress.push(value)
        notified()
      }
    })
    await start
    await notification
    expect(progress).toEqual([{ progress: 1, message: 'Waiting for desktop user action' }])
    expect(JSON.stringify(progress)).not.toContain('Private')
    controller.abort()
    await expect(pending).rejects.toThrow()
    await abort
  } finally {
    await client.close()
    await turn.dispose()
    await service.close()
  }
}, 60000)
