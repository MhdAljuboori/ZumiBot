import { claudeMcpConfig, type McpServerSpec } from '../ipc/mcpSpec'
import { createServer, type Socket } from 'node:net'
import { rm } from 'node:fs/promises'
import { ipcEndpoint, secureEndpoint } from '../ipc/ipcEndpoint'
import { dirname, isAbsolute, join } from 'node:path'
import {
  DESKTOP_ACTION_TOOLS,
  DESKTOP_SERVER,
  desktopToolName,
  parseDesktopCommand,
  type DesktopCommand,
  type DesktopHandoff,
  type DesktopOwner,
  type DesktopResult
} from '@zumibot/shared/desktop'
import { exact, pendingLimit, readLines, requestLimit, send, LineIpcClient } from '../ipc/lineIpc'
import type { BrowserCapabilities } from '../browser/browserCapabilities'
import type { DesktopManager } from './desktopManager'
import { desktopPrompt } from './desktopPrompt'
import { resolveDesktopRuntime, type DesktopRuntime } from './desktopRuntime'
import { boundDesktopResult } from './desktopTools'

export type DesktopIpcManager = Pick<DesktopManager, 'run' | 'endTurn' | 'registerTurn'>
export interface DesktopTurn {
  args: string[]
  mcp: McpServerSpec
  env: NodeJS.ProcessEnv
  prompt: string
  dispose(): Promise<void>
}
type Runtime = Pick<DesktopRuntime, 'node' | 'bridgeEntry' | 'electronNode'>
const unavailable = () => new Error('Desktop unavailable')
// Turn ids are random and single-use: the most recent ones are enough to refuse a reuse, and the set stays bounded.
const USED_TURN_IDS = 10000

/** Every action tool asks for approval on each call, even when the agent file or user settings allow it. */
export const DESKTOP_ASK_RULES: readonly string[] = Object.freeze(DESKTOP_ACTION_TOOLS.map(desktopToolName))
export const DESKTOP_ASK_SETTINGS: string = JSON.stringify({ permissions: { ask: DESKTOP_ASK_RULES } })

export async function serveDesktopIpc(options: { manager: DesktopIpcManager; capabilities: BrowserCapabilities; runtime?: Runtime }) {
  const { manager, capabilities } = options
  const { ownedDir, socketPath } = await ipcEndpoint('d', undefined, unavailable)
  const sockets = new Set<Socket>(),
    turns = new Map<string, DesktopTurn>(),
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
      // The owner always comes from the capability; a message has no owner, agent or profile field.
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
      let command: DesktopCommand
      try {
        command = parseDesktopCommand(message.command)
      } catch {
        send(socket, { type: 'result', id, error: true })
        return
      }
      const controller = new AbortController()
      requests.set(id, controller)
      void (async () => {
        try {
          const result = boundDesktopResult(await manager.run(owner, command, controller.signal))
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
    /** A side run (/btw) gets its own capability and no handoff cards, and no `--settings`: it passes its own deny hook. */
    async createDesktopTurn(
      owner: DesktopOwner,
      onHandoff: (handoff: DesktopHandoff) => Promise<void>,
      o: { side?: boolean } = {}
    ): Promise<DesktopTurn> {
      owner = { ...owner }
      if (closed || usedTurnIds.has(owner.turnId)) throw unavailable()
      const runtime = options.runtime ?? resolveDesktopRuntime()
      if (!isAbsolute(runtime.bridgeEntry) || !isAbsolute(runtime.node)) throw unavailable()
      usedTurnIds.add(owner.turnId)
      if (usedTurnIds.size > USED_TURN_IDS) usedTurnIds.delete(usedTurnIds.values().next().value!)
      const grant = capabilities.issue(owner)
      let unregister = () => {}
      if (!o.side) {
        try {
          unregister = manager.registerTurn(owner.turnId, onHandoff)
        } catch {
          grant.revoke()
          throw unavailable()
        }
      }
      const mcp: McpServerSpec = {
        name: DESKTOP_SERVER,
        command: runtime.node,
        args: [runtime.bridgeEntry],
        passEnv: ['ZUMIBOT_DESKTOP_CAPABILITY', 'ZUMIBOT_DESKTOP_IPC'],
        fixedEnv: runtime.electronNode ? { ELECTRON_RUN_AS_NODE: '1' } : {},
        timeoutMs: 86400000
      }
      let disposing: Promise<void> | undefined
      const turn: DesktopTurn = {
        mcp,
        args: ['--mcp-config', JSON.stringify(claudeMcpConfig(mcp)), ...(o.side ? [] : ['--settings', DESKTOP_ASK_SETTINGS])],
        env: {
          ZUMIBOT_DESKTOP_CAPABILITY: grant.token,
          ZUMIBOT_DESKTOP_IPC: socketPath,
          CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: '1',
          CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS: '0'
        },
        prompt: desktopPrompt,
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

export type DesktopIpcClient = LineIpcClient<DesktopCommand, DesktopResult>
export const DesktopIpcClient = {
  connect: (path: string, token: string): Promise<DesktopIpcClient> =>
    LineIpcClient.connect<DesktopCommand, DesktopResult>(path, token, { unavailable, parse: parseDesktopCommand })
}
