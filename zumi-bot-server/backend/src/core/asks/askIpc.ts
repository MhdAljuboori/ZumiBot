import { createServer, createConnection, type Socket } from 'node:net'
import { randomBytes } from 'node:crypto'
import { rm } from 'node:fs/promises'
import { ipcEndpoint, secureEndpoint } from '../ipc/ipcEndpoint'
import { dirname, isAbsolute, join } from 'node:path'
import { ASK_SERVER } from '@zumibot/shared/agentAsk'
import { claudeMcpConfig, type McpServerSpec } from '../ipc/mcpSpec'
import { resolveBrowserRuntime, type BrowserRuntime } from '../browser/browserRuntime'
import { parseAskWire, parseSideWire, type AskCall, type SideAskCall } from './askTools'

export type { AskCall, SideAskCall } from './askTools'
/** Who an ask comes from. `agent` is read per call: in a room the speaking member is known only when it runs. `chain` is the agents already waiting on this ask. */
export interface AskOwner {
  chatId: string
  agent: () => string
  chain: readonly string[]
  turn: string
  /** Set only on a side run's owner: the side entry the call belongs to, so its link is exact. */
  side?: { chatId: string; entryId: string }
  /** The asking turn is unattended (a routine's or workflow's): the asked turn is too, so it may not write to a connector. */
  auto?: true
}
export interface AskTurn {
  args: string[]
  mcp: McpServerSpec
  env: NodeJS.ProcessEnv
  dispose(): void
}
export type AskIpcService = {
  ask(owner: AskOwner, call: AskCall, signal: AbortSignal): Promise<string>
  sideAsk(owner: AskOwner, call: SideAskCall, signal: AbortSignal): Promise<string>
}
type Runtime = Pick<BrowserRuntime, 'node' | 'askBridgeEntry' | 'electronNode'>

// Framing as the to-do IPC (todoIpc.ts). A 20 000-character message is up to ~120 KB once UTF-8 and JSON escaping are counted.
const requestLimit = 262144,
  responseLimit = 1024 * 1024,
  pendingLimit = 4
const unavailable = () => new Error('Agents unavailable')
function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}
function exact(value: Record<string, unknown>, keys: string[]): boolean {
  return Object.keys(value).every((k) => keys.includes(k))
}
function send(socket: Socket, value: unknown): void {
  if (socket.destroyed) return
  const data = JSON.stringify(value) + '\n'
  if (Buffer.byteLength(data) > responseLimit || socket.writableLength + Buffer.byteLength(data) > responseLimit * 2) {
    socket.destroy()
    return
  }
  socket.write(data)
}
/** Newline framing with byte limits enforced before JSON parsing. */
function readLines(socket: Socket, limit: number, consume: (message: Record<string, unknown>) => void): void {
  let buffer = Buffer.alloc(0)
  socket.on('data', (chunk) => {
    buffer = Buffer.concat([buffer, chunk])
    while (!socket.destroyed) {
      const end = buffer.indexOf(10)
      if (end < 0) {
        if (buffer.length > limit) socket.destroy()
        return
      }
      if (end > limit) {
        socket.destroy()
        return
      }
      const line = buffer.subarray(0, end)
      buffer = buffer.subarray(end + 1)
      try {
        const value: unknown = JSON.parse(line.toString('utf8'))
        if (!record(value)) throw unavailable()
        consume(value)
      } catch {
        socket.destroy()
        return
      }
    }
  })
}
// Only the service's own plain sentences reach the agent. A store failure names a path or a code, so anything that
// looks like one becomes the generic text (so no `/`). 400 so the unknown-agent sentence with its handle list fits; `@` and `_` because handles carry them.
export const SAFE_ASK_MESSAGE = /^[A-Za-z0-9 .,:;'(){}?@_-]{1,400}$/
function errorText(error: unknown): string {
  return error instanceof Error && SAFE_ASK_MESSAGE.test(error.message) && !/^[A-Z]+:/.test(error.message)
    ? error.message
    : unavailable().message
}

interface Conn {
  token?: string
  requests: Map<number, AbortController>
}

export async function serveAskIpc(options: { service: AskIpcService; socketPath?: string; runtime?: Runtime }) {
  const { service } = options
  // Once: resolving probes the disk synchronously, and every attempt of every turn makes an ask turn.
  const runtime = options.runtime ?? resolveBrowserRuntime()
  const { ownedDir, socketPath } = await ipcEndpoint('a', options.socketPath, unavailable)
  const owners = new Map<string, AskOwner>(),
    sockets = new Map<Socket, Conn>()
  let closed = false,
    closing: Promise<void> | undefined
  // An abort is what stops the asked agent when the asking agent's CLI dies, so every way a call can end aborts it.
  const abortAll = (conn: Conn) => {
    for (const request of conn.requests.values()) request.abort()
    conn.requests.clear()
  }
  const server = createServer((socket) => {
    if (closed || sockets.size >= 64) {
      socket.destroy()
      return
    }
    const conn: Conn = { requests: new Map() },
      requests = conn.requests
    sockets.set(socket, conn)
    let lastId = 0
    const authTimer = setTimeout(() => socket.destroy(), 5000)
    authTimer.unref()
    socket.on('error', () => {})
    socket.on('close', () => {
      clearTimeout(authTimer)
      abortAll(conn)
      sockets.delete(socket)
    })
    readLines(socket, requestLimit, (message) => {
      if (!conn.token) {
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
        conn.token = message.token
        clearTimeout(authTimer)
        send(socket, { type: 'auth', ok: true })
        return
      }
      // Re-checked per call: dispose may have run since the auth line.
      const owner = owners.get(conn.token)
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
      const kind = message.type
      if (
        !exact(message, ['type', 'id', 'call']) ||
        (kind !== 'run' && kind !== 'side') ||
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
      let call: AskCall | SideAskCall
      try {
        call = kind === 'side' ? parseSideWire(message.call) : parseAskWire(message.call)
      } catch (error) {
        send(socket, { type: 'result', id, ok: false, text: errorText(error) })
        return
      }
      const controller = new AbortController()
      requests.set(id, controller)
      void (async () => {
        try {
          // The chat, agent, chain and turn come from the token alone.
          const text =
            kind === 'side'
              ? await service.sideAsk(owner, call as SideAskCall, controller.signal)
              : await service.ask(owner, call as AskCall, controller.signal)
          send(socket, { type: 'result', id, ok: true, text })
        } catch (error) {
          send(socket, { type: 'result', id, ok: false, text: errorText(error) })
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
    createAskTurn(owner: AskOwner): AskTurn {
      if (closed) throw unavailable()
      if (!isAbsolute(runtime.askBridgeEntry) || !isAbsolute(runtime.node)) throw unavailable()
      const token = randomBytes(32).toString('hex')
      owners.set(token, { ...owner })
      // A call waits for the other agent's whole reply, so the CLI's tool timeout is a day.
      const mcp: McpServerSpec = {
        name: ASK_SERVER,
        command: runtime.node,
        args: [runtime.askBridgeEntry],
        passEnv: ['ZUMIBOT_ASKS_CAPABILITY', 'ZUMIBOT_ASKS_IPC'],
        fixedEnv: runtime.electronNode ? { ELECTRON_RUN_AS_NODE: '1' } : {},
        timeoutMs: 86400000
      }
      return {
        // The token itself stays out of argv: it is only in the env the CLI expands the placeholders from.
        mcp,
        args: ['--mcp-config', JSON.stringify(claudeMcpConfig(mcp))],
        // MCP_AUTO_BACKGROUND_MS=0: the CLI must not push a long ask to the background, the reply is the tool result.
        env: { ZUMIBOT_ASKS_CAPABILITY: token, ZUMIBOT_ASKS_IPC: socketPath, CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS: '0' },
        dispose() {
          owners.delete(token)
          for (const [socket, conn] of sockets)
            if (conn.token === token) {
              abortAll(conn)
              socket.destroy()
            }
        }
      }
    },
    close(): Promise<void> {
      if (closing) return closing
      closed = true
      closing = (async () => {
        owners.clear()
        for (const [socket, conn] of sockets) {
          abortAll(conn)
          socket.destroy()
        }
        await new Promise<void>((resolve) => server.close(() => resolve()))
        if (ownedDir) await rm(ownedDir, { recursive: true, force: true })
      })()
      return closing
    }
  }
}

/** One authenticated connection per bridge; bounded in-flight calls and no caller owner fields. */
export class AskIpcClient {
  private nextId = 0
  private readonly pending = new Map<number, { resolve: (text: string) => void; reject: (error: Error) => void; cleanup(): void }>()
  private constructor(private readonly socket: Socket) {}
  static async connect(path: string, token: string): Promise<AskIpcClient> {
    if (!isAbsolute(path) || !token || token.length > 128) throw unavailable()
    const socket = createConnection(path),
      client = new AskIpcClient(socket)
    return await new Promise<AskIpcClient>((resolve, reject) => {
      let authenticated = false
      const timer = setTimeout(() => {
        socket.destroy()
        reject(unavailable())
      }, 5000)
      timer.unref()
      const fail = () => {
        clearTimeout(timer)
        reject(unavailable())
        for (const p of client.pending.values()) {
          p.cleanup()
          p.reject(unavailable())
        }
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
        p.cleanup()
        if (typeof message.text !== 'string') p.reject(unavailable())
        else if (message.ok === true) p.resolve(message.text)
        else p.reject(new Error(message.text))
      })
      socket.once('connect', () => send(socket, { type: 'auth', token }))
    })
  }
  run(call: AskCall, signal: AbortSignal): Promise<string> {
    return this.request('run', call, signal)
  }
  side(call: SideAskCall, signal: AbortSignal): Promise<string> {
    return this.request('side', call, signal)
  }
  private request(type: 'run' | 'side', call: AskCall | SideAskCall, signal: AbortSignal): Promise<string> {
    if (signal.aborted || this.socket.destroyed || this.pending.size >= pendingLimit || this.nextId >= 1e9)
      return Promise.reject(unavailable())
    if (Buffer.byteLength(JSON.stringify(call)) > requestLimit - 100) return Promise.reject(unavailable())
    const id = ++this.nextId
    return new Promise((resolve, reject) => {
      const abort = () => {
        this.pending.delete(id)
        send(this.socket, { type: 'cancel', id })
        reject(unavailable())
      }
      this.pending.set(id, { resolve, reject, cleanup: () => signal.removeEventListener('abort', abort) })
      signal.addEventListener('abort', abort, { once: true })
      send(this.socket, { type, id, call })
    })
  }
  close(): void {
    this.socket.destroy()
  }
}
