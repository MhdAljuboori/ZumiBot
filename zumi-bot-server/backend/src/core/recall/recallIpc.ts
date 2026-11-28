import { createServer, createConnection, type Socket } from 'node:net'
import { randomBytes } from 'node:crypto'
import { rm } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import { RECALL_SERVER } from '@zumibot/shared/recall'
import { ipcEndpoint, secureEndpoint } from '../ipc/ipcEndpoint'
import { claudeMcpConfig, type McpServerSpec } from '../ipc/mcpSpec'
import { exact, readLines, record, send } from '../ipc/lineIpc'
import { resolveBrowserRuntime, type BrowserRuntime } from '../browser/browserRuntime'
import { RECALL_TEXT, type RecallOwnerRef } from './recallService'
import { parseRecallWire, type RecallCall } from './recallTools'

export type RecallIpcService = { run(owner: RecallOwnerRef, call: RecallCall): Promise<string> }
/**
 * Who a bridge acts as. `agent` is read per call: in a room the speaking member is known only when it runs. A side run's bridge only
 * holds the definitions, so its tools match the main run's: every call is refused.
 */
export interface RecallOwner {
  chatId: string
  agent: () => string
  turn: string
  side?: true
}
export interface RecallTurn {
  args: string[]
  mcp: McpServerSpec
  env: NodeJS.ProcessEnv
  dispose(): void
}
type Runtime = Pick<BrowserRuntime, 'node' | 'recallBridgeEntry' | 'electronNode'>

// A read answers at most one 8 000-character message and four 1 500-character ones.
const requestLimit = 16 * 1024,
  responseLimit = 256 * 1024,
  pendingLimit = 8
const unavailable = () => new Error('Recall unavailable')
// Only the service's own sentences reach the agent. A failure that names a path or an errno becomes the generic text.
const OWN = new Set<string>(Object.values(RECALL_TEXT))
function errorText(error: unknown): string {
  if (!(error instanceof Error)) return unavailable().message
  return OWN.has(error.message) || error.message.startsWith('Invalid recall call: ') ? error.message : unavailable().message
}

export async function serveRecallIpc(options: { service: RecallIpcService; socketPath?: string; runtime?: Runtime }) {
  const { service } = options
  const runtime = options.runtime ?? resolveBrowserRuntime()
  const { ownedDir, socketPath } = await ipcEndpoint('h', options.socketPath, unavailable)
  const owners = new Map<string, RecallOwner>()
  const sockets = new Map<Socket, { token?: string; pending: number }>()
  let closed = false,
    closing: Promise<void> | undefined
  const server = createServer((socket) => {
    if (closed || sockets.size >= 64) {
      socket.destroy()
      return
    }
    const state: { token?: string; pending: number } = { pending: 0 }
    sockets.set(socket, state)
    let lastId = 0
    const authTimer = setTimeout(() => socket.destroy(), 5000)
    authTimer.unref()
    socket.on('error', () => {})
    socket.on('close', () => {
      clearTimeout(authTimer)
      sockets.delete(socket)
    })
    readLines(socket, requestLimit, (message) => {
      if (!state.token) {
        if (
          !exact(message, ['type', 'token']) ||
          message.type !== 'auth' ||
          typeof message.token !== 'string' ||
          message.token.length > 128 ||
          !owners.has(message.token)
        ) {
          socket.destroy()
          return
        }
        state.token = message.token
        clearTimeout(authTimer)
        send(socket, { type: 'auth', ok: true })
        return
      }
      // Re-checked per call: dispose may have run since the auth line.
      const owner = owners.get(state.token)
      if (!owner) {
        socket.destroy()
        return
      }
      if (
        !exact(message, ['type', 'id', 'call']) ||
        message.type !== 'run' ||
        !Number.isSafeInteger(message.id) ||
        (message.id as number) <= lastId ||
        (message.id as number) > 1e9 ||
        state.pending >= pendingLimit
      ) {
        socket.destroy()
        return
      }
      const id = message.id as number
      lastId = id
      let call: RecallCall
      try {
        call = parseRecallWire(message.call)
      } catch (error) {
        send(socket, { type: 'result', id, ok: false, text: errorText(error) })
        return
      }
      if (owner.side) {
        send(socket, { type: 'result', id, ok: false, text: RECALL_TEXT.side })
        return
      }
      state.pending++
      void (async () => {
        try {
          // The chat and agent come from the token alone; the call carries neither.
          send(socket, { type: 'result', id, ok: true, text: await service.run({ chatId: owner.chatId, agent: owner.agent() }, call) })
        } catch (error) {
          send(socket, { type: 'result', id, ok: false, text: errorText(error) })
        } finally {
          state.pending--
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
    createRecallTurn(owner: RecallOwner): RecallTurn {
      if (closed) throw unavailable()
      if (!isAbsolute(runtime.recallBridgeEntry) || !isAbsolute(runtime.node)) throw unavailable()
      const token = randomBytes(32).toString('hex')
      owners.set(token, { ...owner })
      // alwaysLoad: with many MCP tools the CLI defers the rest behind tool search, and an agent that never searches for ours would never reach them.
      const mcp: McpServerSpec = {
        name: RECALL_SERVER,
        command: runtime.node,
        args: [runtime.recallBridgeEntry],
        passEnv: ['ZUMIBOT_RECALL_CAPABILITY', 'ZUMIBOT_RECALL_IPC'],
        fixedEnv: runtime.electronNode ? { ELECTRON_RUN_AS_NODE: '1' } : {},
        alwaysLoad: true
      }
      return {
        mcp,
        // The token itself stays out of argv: it is only in the env the CLI expands the placeholders from.
        args: ['--mcp-config', JSON.stringify(claudeMcpConfig(mcp))],
        env: { ZUMIBOT_RECALL_CAPABILITY: token, ZUMIBOT_RECALL_IPC: socketPath },
        dispose() {
          owners.delete(token)
          for (const [socket, s] of sockets) if (s.token === token) socket.destroy()
        }
      }
    },
    close(): Promise<void> {
      if (closing) return closing
      closed = true
      closing = (async () => {
        owners.clear()
        for (const socket of sockets.keys()) socket.destroy()
        await new Promise<void>((resolve) => server.close(() => resolve()))
        if (ownedDir) await rm(ownedDir, { recursive: true, force: true })
      })()
      return closing
    }
  }
}

/** One authenticated connection per bridge; bounded in-flight calls and no caller owner fields. */
export class RecallIpcClient {
  private nextId = 0
  private readonly pending = new Map<number, { resolve: (text: string) => void; reject: (error: Error) => void }>()
  private constructor(private readonly socket: Socket) {}
  static async connect(path: string, token: string): Promise<RecallIpcClient> {
    if (!isAbsolute(path) || !token || token.length > 128) throw unavailable()
    const socket = createConnection(path),
      client = new RecallIpcClient(socket)
    return await new Promise<RecallIpcClient>((resolve, reject) => {
      let authenticated = false
      const timer = setTimeout(() => {
        socket.destroy()
        reject(unavailable())
      }, 5000)
      timer.unref()
      const fail = () => {
        clearTimeout(timer)
        reject(unavailable())
        for (const p of client.pending.values()) p.reject(unavailable())
        client.pending.clear()
      }
      socket.on('error', fail)
      socket.on('close', fail)
      readLines(socket, responseLimit, (message) => {
        if (!authenticated) {
          if (message.type !== 'auth' || message.ok !== true) {
            socket.destroy()
            reject(unavailable())
            return
          }
          authenticated = true
          clearTimeout(timer)
          resolve(client)
          return
        }
        const p = client.pending.get(message.id as number)
        if (!p || message.type !== 'result') return
        client.pending.delete(message.id as number)
        if (typeof message.text !== 'string') p.reject(unavailable())
        else if (message.ok === true) p.resolve(message.text)
        else p.reject(new Error(message.text))
      })
      socket.once('connect', () => send(socket, { type: 'auth', token }))
    })
  }
  run(call: RecallCall): Promise<string> {
    if (this.socket.destroyed || this.pending.size >= pendingLimit || this.nextId >= 1e9) return Promise.reject(unavailable())
    if (!record(call) || Buffer.byteLength(JSON.stringify(call)) > requestLimit - 100) return Promise.reject(unavailable())
    const id = ++this.nextId
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      send(this.socket, { type: 'run', id, call })
    })
  }
  close(): void {
    this.socket.destroy()
  }
}
