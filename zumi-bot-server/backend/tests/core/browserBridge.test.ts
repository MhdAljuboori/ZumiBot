import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { createInterface } from 'node:readline'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { build } from 'vite'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { BrowserCapabilities } from '../../src/core/browser/browserCapabilities'
import { serveBrowserIpc } from '../../src/core/browser/browserIpc'
import type { BrowserCommand, BrowserOwner } from '../../src/core/browser/types'
let artifact: string
beforeAll(async () => {
  artifact = await mkdtemp(join(tmpdir(), 'cb-bridge-test-'))
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
const owner: BrowserOwner = { profileId: 'p', chatId: 'c', turnId: 't' }
it('discovers without browser work and routes only scoped validated tools; images are MCP images', async () => {
  const calls: BrowserCommand[] = []
  const capabilities = new BrowserCapabilities()
  const service = await serveBrowserIpc({
    capabilities,
    runtime: { node: process.execPath, bridgeEntry: join(artifact, 'browserBridge.mjs'), electronNode: true },
    manager: {
      registerTurn: () => () => {},
      endTurn: async () => {},
      run: async (actual, command) => {
        expect(actual).toEqual(owner)
        calls.push(command)
        if (command.op === 'screenshot') return { ok: true, data: { mimeType: 'image/jpeg', base64: '/9j/AA==' } }
        return {
          ok: true,
          data: {
            stamp: { generation: 'g', tabId: 'tab', observationId: 'obs' },
            text: 'a'.repeat(100000),
            elements: [{ ref: 'e1', role: 'button', name: 'Go', text: 'Go' }]
          }
        }
      }
    }
  })
  const turn = await service.createBrowserTurn(owner, async () => {})
  const config = JSON.parse(turn.args[turn.args.indexOf('--mcp-config') + 1]).mcpServers.zumibot_browser
  expect(config.timeout).toBe(86400000)
  expect(turn.args).toContain('--no-chrome')
  expect(turn.args.join(' ')).not.toContain(turn.env.ZUMIBOT_BROWSER_CAPABILITY)
  expect(turn.env.ELECTRON_RUN_AS_NODE).toBeUndefined()
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
    expect(tools.tools.map((t) => t.name)).toContain('browser_request_user_action')
    expect(calls).toHaveLength(0)
    const result = await client.callTool({ name: 'browser_observe', arguments: {} })
    expect(JSON.stringify(result).length).toBeLessThan(50000)
    expect(JSON.stringify(result)).toContain('e1')
    expect(JSON.parse((result.content as { type: string; text: string }[])[0].text).data.truncated).toBe(true)
    expect(await client.callTool({ name: 'browser_screenshot', arguments: {} })).toMatchObject({
      content: [{ type: 'image', mimeType: 'image/jpeg', data: '/9j/AA==' }]
    })
    expect(await client.callTool({ name: 'browser_observe', arguments: { agent: 'other' } })).toMatchObject({ isError: true })
    expect(calls).toHaveLength(2)
    await turn.dispose()
    expect(await client.callTool({ name: 'browser_tabs', arguments: {} })).toMatchObject({ isError: true })
    expect(stderr).not.toContain(turn.env.ZUMIBOT_BROWSER_CAPABILITY)
  } finally {
    await client.close()
    await turn.dispose()
    await service.close()
  }
})
it('keeps terminal persistence registered until dispose finishes and issues fresh attempt capabilities', async () => {
  let callback: (() => Promise<void>) | undefined,
    finish!: () => void,
    removed = false
  const persisted = new Promise<void>((r) => {
    finish = r
  })
  const capabilities = new BrowserCapabilities()
  const service = await serveBrowserIpc({
    capabilities,
    manager: {
      registerTurn: (_id, cb) => {
        callback = () =>
          cb({
            id: 'handoff',
            profileId: 'p',
            generation: 'g',
            chatId: 'c',
            turnId: 't',
            site: 'https://example.test',
            reason: 'Sign in',
            createdAt: 1,
            agent: 'test-agent',
            status: 'interrupted'
          })
        return () => {
          removed = true
        }
      },
      endTurn: async () => {
        await callback?.()
      },
      run: async () => ({ ok: true, data: null })
    }
  })
  const first = await service.createBrowserTurn(owner, () => persisted)
  const disposing = first.dispose()
  expect(capabilities.resolve(first.env.ZUMIBOT_BROWSER_CAPABILITY!)).toBeNull()
  expect(removed).toBe(false)
  finish()
  await disposing
  expect(removed).toBe(true)
  const next = await service.createBrowserTurn({ ...owner, turnId: 'next-attempt' }, async () => {})
  expect(next.env.ZUMIBOT_BROWSER_CAPABILITY).not.toBe(first.env.ZUMIBOT_BROWSER_CAPABILITY)
  await next.dispose()
  await service.close()
})

it('transport cancellation aborts a pending user wait without publishing its reason in progress', async () => {
  let started!: () => void, aborted!: () => void
  const start = new Promise<void>((r) => {
      started = r
    }),
    abort = new Promise<void>((r) => {
      aborted = r
    })
  const service = await serveBrowserIpc({
    capabilities: new BrowserCapabilities(),
    runtime: { node: process.execPath, bridgeEntry: join(artifact, 'browserBridge.mjs'), electronNode: false },
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
        return { ok: false, code: 'handoff_interrupted', message: 'Browser request interrupted' }
      }
    }
  })
  const turn = await service.createBrowserTurn(owner, async () => {})
  const client = new Client({ name: 'test', version: '1' })
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [join(artifact, 'browserBridge.mjs')],
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
    const pending = client.callTool({ name: 'browser_request_user_action', arguments: { reason: 'Private sign-in context' } }, undefined, {
      signal: controller.signal,
      timeout: 40000,
      onprogress: (value) => {
        progress.push(value)
        notified()
      }
    })
    await start
    await notification
    expect(progress).toEqual([{ progress: 1, message: 'Waiting for browser user action' }])
    expect(JSON.stringify(progress)).not.toContain('Private')
    controller.abort()
    await expect(pending).rejects.toThrow()
    await abort
  } finally {
    await client.close()
    await turn.dispose()
    await service.close()
  }
}, 40000)

it('stdin EOF cancels a pending bridge request and exits cleanly', async () => {
  let started!: () => void, aborted!: () => void
  const start = new Promise<void>((r) => {
      started = r
    }),
    abort = new Promise<void>((r) => {
      aborted = r
    })
  const service = await serveBrowserIpc({
    capabilities: new BrowserCapabilities(),
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
        return { ok: false, code: 'cancelled', message: 'Cancelled' }
      }
    }
  })
  const turn = await service.createBrowserTurn(owner, async () => {})
  const child = spawn(process.execPath, [join(artifact, 'browserBridge.mjs')], {
    env: { ...process.env, ...turn.env },
    stdio: ['pipe', 'pipe', 'pipe']
  })
  const exit = once(child, 'exit')
  let output = ''
  child.stdout.on('data', (data) => {
    output += data
  })
  try {
    child.stdin.write(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'test', version: '1' } }
      }) + '\n'
    )
    await new Promise<void>((r) => child.stdout.once('data', () => r()))
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n')
    child.stdin.write(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: { name: 'browser_request_user_action', arguments: { reason: 'User help' } }
      }) + '\n'
    )
    await start
    child.stdin.end()
    await abort
    expect((await exit)[0]).toBe(0)
    expect(output).not.toContain(turn.env.ZUMIBOT_BROWSER_CAPABILITY)
  } finally {
    child.kill()
    await turn.dispose()
    await service.close()
  }
})

it.skipIf(process.env.ZUMIBOT_TEST_REAL_CLI !== '1')(
  'installed Claude discovers runtime injected config through control protocol without a model request',
  async () => {
    const configDir = await mkdtemp(join(tmpdir(), 'cb-cli-mcp-'))
    let calls = 0
    const service = await serveBrowserIpc({
      capabilities: new BrowserCapabilities(),
      runtime: { node: process.execPath, bridgeEntry: join(artifact, 'browserBridge.mjs'), electronNode: false },
      manager: {
        registerTurn: () => () => {},
        endTurn: async () => {},
        run: async () => {
          calls++
          return { ok: true, data: null }
        }
      }
    })
    const turn = await service.createBrowserTurn(owner, async () => {})
    const existingConfig = JSON.stringify({
      mcpServers: { unrelated_fixture: { command: process.execPath, args: [join(artifact, 'browserBridge.mjs')] } }
    })
    const child = spawn(
      'claude',
      [
        '-p',
        '--input-format',
        'stream-json',
        '--output-format',
        'stream-json',
        '--verbose',
        '--no-session-persistence',
        '--mcp-config',
        existingConfig,
        ...turn.args
      ],
      {
        env: { ...process.env, ...turn.env, CLAUDE_CONFIG_DIR: configDir },
        cwd: configDir,
        stdio: ['pipe', 'pipe', 'pipe']
      }
    )
    const lines = createInterface({ input: child.stdout })
    const requests = new Map<string, (message: Record<string, unknown>) => void>()
    let sequence = 0
    lines.on('line', (line) => {
      const message = JSON.parse(line)
      if (message.type === 'control_response') requests.get(message.response.request_id)?.(message.response)
    })
    const control = (subtype: string): Promise<Record<string, unknown>> =>
      new Promise((resolve, reject) => {
        const id = String(++sequence)
        const timer = setTimeout(() => {
          requests.delete(id)
          reject(new Error('CLI control response timed out'))
        }, 15000)
        requests.set(id, (response) => {
          clearTimeout(timer)
          requests.delete(id)
          resolve(response)
        })
        child.stdin.write(JSON.stringify({ type: 'control_request', request_id: id, request: { subtype } }) + '\n')
      })
    try {
      expect((await control('initialize')).subtype).toBe('success')
      let selected: { name: string; status: string } | undefined, unrelated: { name: string; status: string } | undefined
      const deadline = Date.now() + 15000
      do {
        const status = await control('mcp_status')
        const response = status.response as { mcpServers?: { name: string; status: string }[] }
        selected = response?.mcpServers?.find((server) => server.name === 'zumibot_browser')
        unrelated = response?.mcpServers?.find((server) => server.name === 'unrelated_fixture')
        if (selected?.status === 'connected' && unrelated?.status === 'connected') break
        await new Promise((r) => setTimeout(r, 100))
      } while (Date.now() < deadline)
      expect(selected ? { name: selected.name, status: selected.status } : null).toEqual({ name: 'zumibot_browser', status: 'connected' })
      expect(unrelated ? { name: unrelated.name, status: unrelated.status } : null).toEqual({
        name: 'unrelated_fixture',
        status: 'connected'
      })
      expect(calls).toBe(0)
    } finally {
      lines.close()
      child.stdin.end()
      child.kill()
      await turn.dispose()
      await service.close()
      await rm(configDir, { recursive: true, force: true })
    }
  },
  40000
)

it('rejects duplicate live or disposed attempt IDs without revoking the first attempt', async () => {
  const capabilities = new BrowserCapabilities()
  let ended = 0
  const service = await serveBrowserIpc({
    capabilities,
    manager: {
      registerTurn: () => () => {},
      endTurn: async () => {
        ended++
      },
      run: async () => ({ ok: true, data: null })
    }
  })
  const turn = await service.createBrowserTurn(owner, async () => {})
  try {
    await expect(service.createBrowserTurn(owner, async () => {})).rejects.toThrow()
    expect(ended).toBe(0)
    expect(capabilities.resolve(turn.env.ZUMIBOT_BROWSER_CAPABILITY!)).toEqual(owner)
    await turn.dispose()
    await expect(service.createBrowserTurn(owner, async () => {})).rejects.toThrow()
  } finally {
    await service.close()
  }
})

it('preserves stamp and usable refs under escaped oversized observations and rejects oversized images', async () => {
  const { browserToolResult } = await import('../../src/core/browser/browserTools')
  const result = browserToolResult({
    ok: true,
    data: {
      stamp: { generation: 'g', tabId: 'tab', observationId: 'o' },
      text: '\u0001'.repeat(100000),
      elements: [{ ref: 'e1', role: 'button', name: 'Continue', text: 'Continue' }]
    }
  })
  expect(result.content[0].type).toBe('text')
  if (result.content[0].type !== 'text') throw new Error('Expected text')
  expect(result.content[0].text.length).toBeLessThan(50000)
  expect(JSON.parse(result.content[0].text)).toMatchObject({
    ok: true,
    data: { stamp: { generation: 'g', tabId: 'tab', observationId: 'o' }, elements: [{ ref: 'e1' }], truncated: true }
  })
  expect(browserToolResult({ ok: true, data: { mimeType: 'image/jpeg', base64: 'A'.repeat(6 * 1024 * 1024) } })).toMatchObject({
    isError: true
  })
  expect(browserToolResult({ ok: true, data: { mimeType: 'image/jpeg', base64: 'A'.repeat(5 * 1024 * 1024) } })).toMatchObject({
    content: [{ type: 'image' }]
  })
})

it('keeps disposal bound to the original server-issued owner when the caller mutates its copy', async () => {
  const ended: string[] = []
  const capabilities = new BrowserCapabilities()
  const service = await serveBrowserIpc({
    capabilities,
    manager: {
      registerTurn: () => () => {},
      endTurn: async (id) => {
        ended.push(id)
      },
      run: async () => ({ ok: true, data: null })
    }
  })
  const supplied = { ...owner }
  const turn = await service.createBrowserTurn(supplied, async () => {})
  supplied.turnId = 'unrelated-turn'
  await turn.dispose()
  expect(ended).toEqual(['t'])
  await service.close()
})

// Windows writes stdout to a pipe synchronously, so a stalled reader blocks a 5 MiB screenshot write outright; on macOS the
// four screenshots go out and the cap never trips within the deadline. The agent browser is Linux-only anyway, so the
// screenshot case runs there alone; the small-frame overflows run everywhere.
it.each(
  (['screenshots', 'discovery', 'errors', 'cancellations'] as const).filter((m) => m !== 'screenshots' || process.platform === 'linux')
)(
  'terminates stalled MCP output and aborts active IPC work on %s overflow',
  async (mode) => {
    let started!: () => void, aborted!: () => void
    const start = new Promise<void>((r) => {
        started = r
      }),
      abort = new Promise<void>((r) => {
        aborted = r
      })
    const image = 'A'.repeat(5 * 1024 * 1024)
    let screenshots = 0
    const service = await serveBrowserIpc({
      capabilities: new BrowserCapabilities(),
      manager: {
        registerTurn: () => () => {},
        endTurn: async () => {},
        run: async (_owner, command, signal) => {
          if (command.op === 'screenshot') {
            // Space IPC replies so its independent socket cap cannot cause this overflow.
            const sequence = ++screenshots
            await new Promise((r) => setTimeout(r, sequence * 250))
            return { ok: true, data: { mimeType: 'image/jpeg', base64: image } }
          }
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
        }
      }
    })
    const turn = await service.createBrowserTurn(owner, async () => {})
    const child = spawn(process.execPath, [join(artifact, 'browserBridge.mjs')], {
      env: { ...process.env, ...turn.env },
      stdio: ['pipe', 'pipe', 'pipe']
    })
    const exit = once(child, 'exit')
    child.stdin.on('error', () => {})
    let stderr = ''
    child.stderr.on('data', (data) => {
      stderr += data
    })
    const write = (message: object) => child.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n')
    try {
      write({
        id: 1,
        method: 'initialize',
        params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'test', version: '1' } }
      })
      await once(child.stdout, 'data')
      child.stdout.pause()
      write({ method: 'notifications/initialized' })
      write({
        id: 2,
        method: 'tools/call',
        params: {
          name: 'browser_request_user_action',
          arguments: { reason: 'Private browser context' },
          _meta: { progressToken: 'waiting' }
        }
      })
      await start
      const requests = mode === 'screenshots' ? 4 : 32
      const frames = Array.from({ length: requests }, (_unused, index) => ({
        jsonrpc: '2.0',
        id: index + 3,
        method:
          mode === 'screenshots'
            ? 'tools/call'
            : mode === 'discovery'
              ? 'tools/list'
              : mode === 'cancellations'
                ? 'ping'
                : 'unknown/method',
        ...(mode === 'screenshots' ? { params: { name: 'browser_screenshot', arguments: {} } } : {})
      }))
      child.stdin.write(
        frames
          .flatMap((frame) =>
            mode === 'cancellations'
              ? [frame, { jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: frame.id } }]
              : [frame]
          )
          .map((frame) => JSON.stringify(frame) + '\n')
          .join('')
      )
      await expect.poll(() => child.exitCode, { timeout: 3000 }).toBe(1)
      await exit
      await abort
      if (mode === 'screenshots') expect(screenshots).toBe(4)
      expect(stderr).not.toContain(turn.env.ZUMIBOT_BROWSER_CAPABILITY)
      expect(stderr).not.toContain('Private browser context')
      expect(stderr).not.toContain('MaxListenersExceededWarning')
    } finally {
      child.kill('SIGKILL')
      await exit
      await turn.dispose()
      await service.close()
    }
  },
  10000
)

it.each(['ping', 'schema error', 'custom tool'] as const)(
  'reuses completed cancellation slots across SDK %s requests without interrupting unrelated work',
  async (mode) => {
    let started!: () => void,
      interrupted = false,
      dispatchedWaits = 0
    const start = new Promise<void>((r) => {
      started = r
    })
    const service = await serveBrowserIpc({
      capabilities: new BrowserCapabilities(),
      manager: {
        registerTurn: () => () => {},
        endTurn: async () => {},
        run: async (_owner, command, signal) => {
          if (command.op === 'tabs')
            return { ok: true, data: { tabs: [{ id: 'tab', title: 'Fixture', url: 'https://example.test' }], activeTabId: 'tab' } }
          dispatchedWaits++
          started()
          await new Promise<void>((r) =>
            signal.addEventListener(
              'abort',
              () => {
                interrupted = true
                r()
              },
              { once: true }
            )
          )
          return { ok: false, code: 'cancelled', message: 'Cancelled' }
        }
      }
    })
    const turn = await service.createBrowserTurn(owner, async () => {})
    const child = spawn(process.execPath, [join(artifact, 'browserBridge.mjs')], {
      env: { ...process.env, ...turn.env },
      stdio: ['pipe', 'pipe', 'pipe']
    })
    const exit = once(child, 'exit'),
      lines = createInterface({ input: child.stdout })
    child.stdin.on('error', () => {})
    child.stderr.resume()
    const responses = new Map<number, { resolve(value: Record<string, unknown>): void; reject(error: Error): void }>()
    lines.on('line', (line) => {
      const response = JSON.parse(line)
      responses.get(response.id)?.resolve(response)
    })
    child.on('exit', () => {
      for (const response of responses.values()) response.reject(new Error('Bridge exited before response'))
    })
    const write = (message: object) => child.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n')
    const request = async (id: number, method: string, params?: object, before: object[] = []): Promise<Record<string, unknown>> => {
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        return await new Promise((resolve, reject) => {
          responses.set(id, { resolve, reject })
          timer = setTimeout(() => reject(new Error('Bridge response timed out')), 2000)
          child.stdin.write(
            [...before, { id, method, ...(params ? { params } : {}) }]
              .map((message) => JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n')
              .join('')
          )
        })
      } finally {
        clearTimeout(timer)
        responses.delete(id)
      }
    }
    try {
      await request(1, 'initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'test', version: '1' } })
      write({ method: 'notifications/initialized' })
      write({ id: 2, method: 'tools/call', params: { name: 'browser_request_user_action', arguments: { reason: 'User help' } } })
      await start
      for (let index = 0; index < 24; index++) {
        const id = 10 + index * 2
        const cancelled = {
          id,
          method: mode === 'ping' ? 'ping' : 'tools/call',
          ...(mode === 'schema error'
            ? { params: { name: 123 } }
            : mode === 'custom tool'
              ? { params: { name: 'browser_request_user_action', arguments: { reason: 'Already cancelled' } } }
              : {})
        }
        // One input frame batch guarantees cancellation arrives before custom work begins.
        expect(
          await request(id + 1, 'ping', undefined, [cancelled, { method: 'notifications/cancelled', params: { requestId: id } }])
        ).toMatchObject({ result: {} })
      }
      expect(await request(1000, 'tools/list')).toMatchObject({
        result: { tools: expect.arrayContaining([expect.objectContaining({ name: 'browser_tabs' })]) }
      })
      const result = await request(1001, 'tools/call', { name: 'browser_tabs', arguments: {} })
      expect(JSON.stringify(result)).toContain('Fixture')
      expect(interrupted).toBe(false)
      expect(dispatchedWaits).toBe(1)
      expect(child.exitCode).toBeNull()
    } finally {
      lines.close()
      child.kill('SIGKILL')
      await exit
      await turn.dispose()
      await service.close()
    }
  }
)

it("keeps up to 32 framed elements ahead of the main frame's tail when the element budget runs out, in their order", async () => {
  const { boundBrowserResult } = await import('../../src/core/browser/browserTools')
  const stamp = { generation: 'g', tabId: 'tab', observationId: 'o' }
  const main = Array.from({ length: 224 }, (_, i) => ({
    ref: `m${i}`,
    role: 'button',
    name: `Main item ${i} `.padEnd(40, 'x'),
    text: `Main item ${i} `.padEnd(40, 'y')
  }))
  const framed = Array.from({ length: 40 }, (_, i) => ({
    ref: `f${i}`,
    role: 'textbox',
    name: `Card field ${i}`,
    text: '',
    frame: 'pay.example'
  }))
  const rest = [{ ref: 'm-rest', role: 'button', name: 'Rest', text: '' }]
  const bound = (elements: object[]) =>
    (
      boundBrowserResult({ ok: true, data: { stamp, text: 'page', elements } }) as {
        ok: true
        data: { elements: { ref: string }[]; truncated: boolean }
      }
    ).data
  const out = bound([...main, ...framed, ...rest])
  const refs = out.elements.map((e) => e.ref)
  // The first 32 framed elements are kept; the main frame's tail made room for them.
  expect(refs.filter((r) => r.startsWith('f'))).toEqual(Array.from({ length: 32 }, (_, i) => `f${i}`))
  expect(refs.filter((r) => r.startsWith('m'))).toEqual(refs.filter((r) => r.startsWith('m')).map((_, i) => `m${i}`))
  // The observation's own order is kept: the main frame's kept elements, then the framed ones.
  expect(refs.findIndex((r) => r.startsWith('f'))).toBe(refs.filter((r) => r.startsWith('m')).length)
  expect(JSON.stringify({ stamp, elements: out.elements, text: '', truncated: false }).length).toBeLessThanOrEqual(24000)
  expect(out.truncated).toBe(true)
})

describe('a hostile iframe gets no more than its share of the bound', () => {
  const stamp = { generation: 'g', tabId: 'tab', observationId: 'o' }
  type Shown = { ref: string; role: string; name: string; text: string; frame?: string }
  const bound = async (elements: Shown[]) => {
    const { boundBrowserResult } = await import('../../src/core/browser/browserTools')
    return (
      boundBrowserResult({ ok: true, data: { stamp, text: 'page', elements } }) as {
        ok: true
        data: { elements: Shown[]; truncated: boolean }
      }
    ).data
  }
  // JSON characters as the bound counts them: the empty observation, then each element and a comma between each two.
  const base = JSON.stringify({ stamp, elements: [], text: '', truncated: false }).length
  const FRAMED_JSON = 8192
  const leadingFit = (list: Shown[], room: number) => {
    let used = 0,
      n = 0
    for (const e of list) {
      const next = used + JSON.stringify(e).length + (n > 0 ? 1 : 0)
      if (next > room) break
      used = next
      n++
    }
    return n
  }
  const mainOf = (n: number, size: number): Shown[] =>
    Array.from({ length: n }, (_, i) => ({
      ref: `m${i}`,
      role: 'button',
      name: `Main ${i} `.padEnd(size, 'x'),
      text: `Main ${i} `.padEnd(size, 'y')
    }))

  it('keeps a main frame that fits beside 32 framed elements at their longest', async () => {
    const main = mainOf(100, 30)
    const framed = Array.from({ length: 32 }, (_, i): Shown => ({
      ref: `f${i}`,
      role: 'r'.repeat(80),
      name: 'n'.repeat(256),
      text: 't'.repeat(256),
      frame: 'ads.example'
    }))
    const out = await bound([...main, ...framed])
    expect(out.elements.filter((e) => e.frame === undefined)).toEqual(main)
    expect(out.elements.some((e) => e.frame !== undefined)).toBe(true)
    expect(out.truncated).toBe(true)
  })

  it('leaves the main frame at least what the share does not take, even when every framed character escapes to six', async () => {
    const main = mainOf(224, 40)
    // Inside the observation's own 4 096-character share for child frames, but each control character is six in JSON.
    const framed = Array.from({ length: 32 }, (_, i): Shown => ({
      ref: `f${i}`,
      role: 'textbox',
      name: '\u0001'.repeat(64),
      text: '\u0002'.repeat(64),
      frame: 'ads.example'
    }))
    const out = await bound([...main, ...framed])
    const kept = out.elements.filter((e) => e.frame === undefined)
    expect(kept).toEqual(main.slice(0, kept.length))
    expect(kept.length).toBeGreaterThanOrEqual(leadingFit(main, 24000 - base - FRAMED_JSON))
    expect(out.truncated).toBe(true)
  })

  it('offers the room left after the main frame to every framed element not yet kept, in order', async () => {
    const main = mainOf(10, 10)
    // 40 framed elements of about 400 characters: the share takes the first ~20, the room left takes the rest, none skipped.
    const framed = Array.from({ length: 40 }, (_, i): Shown => ({
      ref: `f${i}`,
      role: 'textbox',
      name: `Field ${i} `.padEnd(300, 'z'),
      text: '',
      frame: 'pay.example'
    }))
    const out = await bound([...main, ...framed])
    expect(out.elements.map((e) => e.ref)).toEqual([...main, ...framed].map((e) => e.ref))
  })
})

it('bounds a page without framed elements exactly as before: the leading elements that fit, nothing reordered', async () => {
  const { boundBrowserResult } = await import('../../src/core/browser/browserTools')
  const stamp = { generation: 'g', tabId: 'tab', observationId: 'o' }
  const elements = Array.from({ length: 300 }, (_, i) => ({
    ref: `e${i}`,
    role: 'button',
    name: `Item ${i}`.padEnd(30 + (i % 30), 'n'),
    text: 't'.repeat(10 + (i % 17))
  }))
  // The rule before framed elements got room: the first 256, pushed one by one, stopping at the first that would pass 24 000 characters.
  const before: object[] = []
  for (const e of elements.slice(0, 256)) {
    before.push(e)
    if (JSON.stringify({ stamp, elements: before, text: '', truncated: false }).length > 24000) {
      before.pop()
      break
    }
  }
  const out = (
    boundBrowserResult({ ok: true, data: { stamp, text: 'page', elements } }) as {
      ok: true
      data: { elements: object[]; truncated: boolean }
    }
  ).data
  expect(before.length).toBeLessThan(256)
  expect(out.elements).toEqual(before)
  expect(out.truncated).toBe(true)
})

it('keeps a bounded frame label', async () => {
  const { boundBrowserResult } = await import('../../src/core/browser/browserTools')
  const result = boundBrowserResult({
    ok: true,
    data: {
      stamp: { generation: 'g', tabId: 'tab', observationId: 'o' },
      text: 'page',
      elements: [
        { ref: 'e1', role: 'textbox', name: 'Card', text: '', frame: 'x'.repeat(1000) },
        { ref: 'e2', role: 'button', name: 'Go', text: '' }
      ]
    }
  })
  const elements = (result as { ok: true; data: { elements: { frame?: string }[] } }).data.elements
  expect(elements[0].frame).toBe('x'.repeat(253))
  expect('frame' in elements[1]).toBe(false)
})

describe('audit tools', () => {
  const stamp = { generation: 'g', tabId: 'tab', observationId: 'o' }
  it('routes each new tool to its command with the op set by the bridge, and answers in text only', async () => {
    const calls: BrowserCommand[] = []
    const service = await serveBrowserIpc({
      capabilities: new BrowserCapabilities(),
      runtime: { node: process.execPath, bridgeEntry: join(artifact, 'browserBridge.mjs'), electronNode: true },
      manager: {
        registerTurn: () => () => {},
        endTurn: async () => {},
        run: async (_owner, command) => {
          calls.push(command)
          if (command.op === 'saveScreenshot')
            return { ok: true, data: { path: '/tmp/shots/a.png', name: 'a', bytes: 10, width: 4, height: 3 } }
          if (command.op === 'computedStyle')
            return { ok: true, data: { style: { color: 'rgb(0, 0, 0)' }, rect: { x: 1, y: 2, width: 3, height: 4 } } }
          if (command.op === 'hover') return { ok: true, data: { hovered: true } }
          return { ok: true, data: { width: 390, height: 844 } }
        }
      }
    })
    const turn = await service.createBrowserTurn(owner, async () => {})
    const config = JSON.parse(turn.args[turn.args.indexOf('--mcp-config') + 1]).mcpServers.zumibot_browser
    const client = new Client({ name: 'test', version: '1' })
    const transport = new StdioClientTransport({
      command: config.command,
      args: config.args,
      env: { ...config.env, ...turn.env } as Record<string, string>,
      cwd: artifact,
      stderr: 'pipe'
    })
    const text = (r: unknown) => (r as { content: { type: string; text: string }[] }).content
    try {
      await client.connect(transport)
      const names = (await client.listTools()).tools.map((t) => t.name)
      for (const n of ['browser_save_screenshot', 'browser_computed_style', 'browser_hover', 'browser_set_viewport'])
        expect(names).toContain(n)
      const shot = await client.callTool({ name: 'browser_save_screenshot', arguments: { name: 'row-hover', ref: 'e1', stamp } })
      expect(text(shot).map((c) => c.type)).toEqual(['text'])
      expect(JSON.parse(text(shot)[0].text)).toMatchObject({ ok: true, data: { path: '/tmp/shots/a.png', name: 'a', bytes: 10 } })
      await client.callTool({ name: 'browser_save_screenshot', arguments: { name: 'full', fullPage: true } })
      expect(
        JSON.parse(text(await client.callTool({ name: 'browser_computed_style', arguments: { stamp, ref: 'e1' } }))[0].text)
      ).toMatchObject({ ok: true, data: { style: { color: 'rgb(0, 0, 0)' }, rect: { width: 3 } } })
      expect(JSON.parse(text(await client.callTool({ name: 'browser_hover', arguments: { stamp, ref: 'e1' } }))[0].text)).toMatchObject({
        ok: true,
        data: { hovered: true }
      })
      expect(
        JSON.parse(text(await client.callTool({ name: 'browser_set_viewport', arguments: { width: 390, height: 844 } }))[0].text)
      ).toMatchObject({ ok: true, data: { width: 390, height: 844 } })
      expect(calls).toEqual([
        { op: 'saveScreenshot', name: 'row-hover', ref: 'e1', stamp },
        { op: 'saveScreenshot', name: 'full', fullPage: true },
        { op: 'computedStyle', stamp, ref: 'e1' },
        { op: 'hover', stamp, ref: 'e1' },
        { op: 'setViewport', width: 390, height: 844 }
      ])
      // A client-sent op, and arguments outside the shared limits, never reach the manager.
      for (const [name, args] of [
        ['browser_hover', { stamp, ref: 'e1', op: 'click' }],
        ['browser_save_screenshot', { name: 'x', op: 'screenshot' }],
        ['browser_set_viewport', { width: 100, height: 900 }],
        ['browser_save_screenshot', { name: '../x' }],
        ['browser_save_screenshot', { name: 'x', fullPage: true, ref: 'e1', stamp }]
      ] as const) {
        expect(await client.callTool({ name, arguments: args })).toMatchObject({ isError: true })
      }
      expect(calls).toHaveLength(5)
    } finally {
      await client.close()
      await turn.dispose()
      await service.close()
    }
  })

  it('bounds a computed style result at 48 000 characters', async () => {
    const { boundBrowserResult } = await import('../../src/core/browser/browserTools')
    const style = (value: string) => ({ ok: true as const, data: { style: { color: value }, rect: { x: 0, y: 0, width: 1, height: 1 } } })
    expect(boundBrowserResult(style('a'.repeat(1000)))).toEqual(style('a'.repeat(1000)))
    expect(boundBrowserResult(style('a'.repeat(48000)))).toMatchObject({ ok: false, code: 'output_limit' })
  })

  it('refuses the realistic worst case: 40 values of 200 control characters escape past 48 000 and leak nothing', async () => {
    const { boundBrowserResult, cutBrowserResult } = await import('../../src/core/browser/browserTools')
    const { COMPUTED_STYLE_PROPS } = await import('../../src/core/browser/browserStyle')
    const raw = {
      ok: true as const,
      data: {
        style: Object.fromEntries(COMPUTED_STYLE_PROPS.map((n) => [n, '\u0001'.repeat(200)])),
        rect: { x: 0, y: 0, width: 1, height: 1 }
      }
    }
    const cut = cutBrowserResult(raw)
    expect(JSON.stringify(cut).length).toBeGreaterThan(48000)
    const bounded = boundBrowserResult(cut)
    expect(bounded).toEqual({ ok: false, code: 'output_limit', message: expect.any(String) })
    expect(JSON.stringify(bounded)).not.toContain('\\u0001')
  })

  it("declares the screenshot name with the parser's own pattern, so a one-letter name is allowed", async () => {
    const { browserTools } = await import('../../src/core/browser/browserTools')
    const { SHOT_NAME_RE } = await import('@zumibot/shared/browser')
    const schema = browserTools.find((t) => t.name === 'browser_save_screenshot')!.inputSchema as unknown as {
      properties: { name: Record<string, unknown> }
    }
    expect(schema.properties.name).toEqual({ type: 'string', pattern: SHOT_NAME_RE.source, maxLength: 64 })
    expect(new RegExp(schema.properties.name.pattern as string).test('a')).toBe(true)
    expect(browserTools.find((t) => t.name === 'browser_save_screenshot')!.description).toContain('PNG')
  })

  it('declares the viewport bounds from the shared constants the parser checks', async () => {
    const viewport = async () => {
      const { browserTools } = await import('../../src/core/browser/browserTools')
      const tool = browserTools.find((t) => t.name === 'browser_set_viewport')!
      return {
        description: tool.description,
        ...(tool.inputSchema as unknown as { properties: Record<'width' | 'height', Record<string, unknown>> }).properties
      }
    }
    const { BROWSER_VIEWPORT_MIN: min, BROWSER_VIEWPORT_MAX: max } = await import('@zumibot/shared/browser')
    expect(await viewport()).toEqual({
      width: { type: 'integer', minimum: min.width, maximum: max.width },
      height: { type: 'integer', minimum: min.height, maximum: max.height },
      description: expect.stringContaining(`from ${min.width}x${min.height} up to ${max.width}x${max.height}`)
    })
    // Other bounds in the constants show up in the schema: nothing is copied by hand.
    vi.resetModules()
    vi.doMock('@zumibot/shared/browser', async (original) => ({
      ...(await original<typeof import('@zumibot/shared/browser')>()),
      BROWSER_VIEWPORT_MIN: { width: 300, height: 250 },
      BROWSER_VIEWPORT_MAX: { width: 1600, height: 1000 }
    }))
    try {
      expect(await viewport()).toEqual({
        width: { type: 'integer', minimum: 300, maximum: 1600 },
        height: { type: 'integer', minimum: 250, maximum: 1000 },
        description: expect.stringContaining('from 300x250 up to 1600x1000')
      })
    } finally {
      vi.doUnmock('@zumibot/shared/browser')
      vi.resetModules()
    }
  })
})
