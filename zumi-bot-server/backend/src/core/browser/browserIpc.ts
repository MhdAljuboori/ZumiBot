import { claudeMcpConfig, type McpServerSpec } from '../ipc/mcpSpec'
import { createServer, type Socket } from 'node:net'
import { rm } from 'node:fs/promises'
import { ipcEndpoint, secureEndpoint } from '../ipc/ipcEndpoint'
import { dirname, isAbsolute, join } from 'node:path'
import { parseBrowserCommand } from '@zumibot/shared/browser'
import { exact, pendingLimit, readLines, requestLimit, send, LineIpcClient } from '../ipc/lineIpc'
import { BrowserCapabilities } from './browserCapabilities'
import { resolveBrowserRuntime, type BrowserRuntime } from './browserRuntime'
import { browserPrompt } from './browserPrompt'
import { boundBrowserResult } from './browserTools'
import type { BrowserHandoff, BrowserManager, BrowserOwner, BrowserCommand, BrowserResult } from './types'

export type BrowserIpcManager = Pick<BrowserManager, 'run' | 'endTurn' | 'registerTurn'>
export interface BrowserTurn {
  args: string[]
  mcp: McpServerSpec
  env: NodeJS.ProcessEnv
  prompt: string
  dispose(): Promise<void>
}
type Runtime = Pick<BrowserRuntime, 'node' | 'bridgeEntry' | 'electronNode'>
const unavailable = () => new Error('Browser unavailable')
export async function serveBrowserIpc(options: {
  manager: BrowserIpcManager
  capabilities: BrowserCapabilities
  socketPath?: string
  runtime?: Runtime
}) {
  const { manager, capabilities } = options
  const { ownedDir, socketPath } = await ipcEndpoint('b', options.socketPath, unavailable)
  const sockets = new Set<Socket>(),
    turns = new Map<string, BrowserTurn>(),
    usedTurnIds = new Set<string>()
  let closed = false,
    closing: Promise<void> | undefined
  const server = createServer((socket) => {
    if (closed || sockets.size >= 64) {
      socket.destroy()
      return
    }
    sockets.add(socket)
    let token: string | undefined,
      unwatch = () => {},
      lastId = 0
    const requests = new Map<number, AbortController>()
    const authTimer = setTimeout(() => socket.destroy(), 5000)
    authTimer.unref()
    socket.on('error', () => {})
    socket.on('close', () => {
      clearTimeout(authTimer)
      unwatch()
      sockets.delete(socket)
      for (const request of requests.values()) request.abort()
      requests.clear()
    })
    readLines(socket, requestLimit, (message) => {
      if (!token) {
        if (
          !exact(message, ['type', 'token']) ||
          message.type !== 'auth' ||
          typeof message.token !== 'string' ||
          message.token.length > 128 ||
          !capabilities.resolve(message.token)
        ) {
          socket.destroy()
          return
        }
        token = message.token
        clearTimeout(authTimer)
        unwatch = capabilities.onRevoke(token, () => {
          for (const c of requests.values()) c.abort()
          socket.destroy()
        })
        send(socket, { type: 'auth', ok: true })
        return
      }
      const owner = capabilities.resolve(token)
      if (!owner) {
        socket.destroy()
        return
      }
      if (message.type === 'cancel') {
        if (!exact(message, ['type', 'id']) || !Number.isSafeInteger(message.id)) {
          socket.destroy()
          return
        }
        requests.get(message.id as number)?.abort()
        return
      }
      if (
        !exact(message, ['type', 'id', 'command']) ||
        message.type !== 'run' ||
        !Number.isSafeInteger(message.id) ||
        (message.id as number) <= lastId ||
        (message.id as number) > 1e9 ||
        requests.size >= pendingLimit
      ) {
        socket.destroy()
        return
      }
      const id = message.id as number
      lastId = id
      let command: BrowserCommand
      try {
        command = parseBrowserCommand(message.command)
      } catch {
        send(socket, { type: 'result', id, error: true })
        return
      }
      const controller = new AbortController()
      requests.set(id, controller)
      void (async () => {
        try {
          const result = boundBrowserResult(await manager.run(owner, command, controller.signal))
          send(socket, { type: 'result', id, result })
        } catch {
          send(socket, { type: 'result', id, error: true })
        } finally {
          requests.delete(id)
        }
      })()
    })
  })
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(socketPath, () => {
        server.removeListener('error', reject)
        resolve()
      })
    })
    await secureEndpoint(socketPath)
  } catch (error) {
    server.close()
    if (ownedDir) await rm(ownedDir, { recursive: true, force: true })
    throw error
  }
  return {
    socketPath,
    async createBrowserTurn(owner: BrowserOwner, onHandoff: (handoff: BrowserHandoff) => Promise<void>): Promise<BrowserTurn> {
      owner = { ...owner }
      if (closed || usedTurnIds.has(owner.turnId)) throw unavailable()
      const runtime = options.runtime ?? resolveBrowserRuntime()
      if (!isAbsolute(runtime.bridgeEntry) || !isAbsolute(runtime.node)) throw unavailable()
      usedTurnIds.add(owner.turnId)
      const grant = capabilities.issue(owner)
      let unregister: () => void
      try {
        unregister = manager.registerTurn(owner.turnId, onHandoff)
      } catch {
        grant.revoke()
        throw unavailable()
      }
      const mcp: McpServerSpec = {
        name: 'zumibot_browser',
        command: runtime.node,
        args: [runtime.bridgeEntry],
        passEnv: ['ZUMIBOT_BROWSER_CAPABILITY', 'ZUMIBOT_BROWSER_IPC'],
        fixedEnv: runtime.electronNode ? { ELECTRON_RUN_AS_NODE: '1' } : {},
        timeoutMs: 86400000
      }
      let disposing: Promise<void> | undefined
      const turn: BrowserTurn = {
        mcp,
        args: ['--mcp-config', JSON.stringify(claudeMcpConfig(mcp)), '--no-chrome'],
        env: {
          ZUMIBOT_BROWSER_CAPABILITY: grant.token,
          ZUMIBOT_BROWSER_IPC: socketPath,
          CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: '1',
          CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS: '0'
        },
        prompt: browserPrompt,
        dispose() {
          grant.revoke()
          disposing ??= (async () => {
            try {
              await manager.endTurn(owner.turnId)
            } finally {
              unregister()
              if (turns.get(owner.turnId) === turn) turns.delete(owner.turnId)
            }
          })()
          return disposing
        }
      }
      turns.set(owner.turnId, turn)
      return turn
    },
    close(): Promise<void> {
      if (closing) return closing
      closed = true
      closing = (async () => {
        const drained = Promise.allSettled([...turns.values()].map((turn) => turn.dispose()))
        for (const socket of sockets) socket.destroy()
        await drained
        await new Promise<void>((resolve) => server.close(() => resolve()))
        if (ownedDir) await rm(ownedDir, { recursive: true, force: true })
      })()
      return closing
    }
  }
}

/** One authenticated connection per bridge; bounded in-flight calls and no caller owner fields. */
export type BrowserIpcClient = LineIpcClient<BrowserCommand, BrowserResult>
export const BrowserIpcClient = {
  connect: (path: string, token: string): Promise<BrowserIpcClient> =>
    LineIpcClient.connect<BrowserCommand, BrowserResult>(path, token, { unavailable, parse: parseBrowserCommand })
}
