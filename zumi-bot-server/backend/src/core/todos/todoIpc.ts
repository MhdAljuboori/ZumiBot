import { createServer, createConnection, type Socket } from 'node:net'
import { randomBytes } from 'node:crypto'
import { rm } from 'node:fs/promises'
import { ipcEndpoint, secureEndpoint } from '../ipc/ipcEndpoint'
import { dirname, isAbsolute, join } from 'node:path'
import { claudeMcpConfig, type McpServerSpec } from '../ipc/mcpSpec'
import { resolveBrowserRuntime, type BrowserRuntime } from '../browser/browserRuntime'
import type { TodoService } from './todoService'
import { parseTodoWire, type TodoCall } from './todoTools'

export type TodoIpcService = Pick<
  TodoService,
  'agentList' | 'agentAdd' | 'agentCheck' | 'agentRemove' | 'agentAskUser' | 'agentReview' | 'agentComment'
>
/** Who a bridge acts as. `agent` is read per call: in a room the speaking member is known only when it runs. */
export interface TodoOwner {
  chatId: string
  agent: () => string
  turn: string
  label: string
}
export interface TodoTurn {
  args: string[]
  mcp: McpServerSpec
  env: NodeJS.ProcessEnv
  dispose(): void
}
type Runtime = Pick<BrowserRuntime, 'node' | 'todoBridgeEntry' | 'electronNode'>

// Same framing as the browser IPC (browserIpc.ts). The request limit is wider: an add of 50 items with their notes.
const requestLimit = 1024 * 1024,
  responseLimit = 1024 * 1024,
  pendingLimit = 16
const unavailable = () => new Error('To-do list unavailable')
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
// looks like one becomes the generic text.
const SAFE_MESSAGE = /^[A-Za-z0-9 .,:;'(){}?-]{1,200}$/
function errorText(error: unknown): string {
  return error instanceof Error && SAFE_MESSAGE.test(error.message) && !/^[A-Z]+:/.test(error.message)
    ? error.message
    : unavailable().message
}

export async function serveTodoIpc(options: { service: TodoIpcService; socketPath?: string; runtime?: Runtime }) {
  const { service } = options
  // Once: resolving probes the disk synchronously, and every attempt of every turn makes a to-do turn.
  const runtime = options.runtime ?? resolveBrowserRuntime()
  const { ownedDir, socketPath } = await ipcEndpoint('t', options.socketPath, unavailable)
  const owners = new Map<string, TodoOwner>(),
    sockets = new Map<Socket, string | undefined>()
  let closed = false,
    closing: Promise<void> | undefined
  const server = createServer((socket) => {
    if (closed || sockets.size >= 64) {
      socket.destroy()
      return
    }
    sockets.set(socket, undefined)
    let token: string | undefined,
      lastId = 0,
      pending = 0
    const authTimer = setTimeout(() => socket.destroy(), 5000)
    authTimer.unref()
    socket.on('error', () => {})
    socket.on('close', () => {
      clearTimeout(authTimer)
      sockets.delete(socket)
    })
    readLines(socket, requestLimit, (message) => {
      if (!token) {
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
        token = message.token
        sockets.set(socket, token)
        clearTimeout(authTimer)
        send(socket, { type: 'auth', ok: true })
        return
      }
      // Re-checked per call: dispose may have run since the auth line.
      const owner = owners.get(token)
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
        pending >= pendingLimit
      ) {
        socket.destroy()
        return
      }
      const id = message.id as number
      lastId = id
      let call: TodoCall
      try {
        call = parseTodoWire(message.call)
      } catch (error) {
        send(socket, { type: 'result', id, ok: false, text: errorText(error) })
        return
      }
      pending++
      void (async () => {
        try {
          // The chat, agent, turn and label come from the token alone.
          const agent = owner.agent()
          const text =
            call.op === 'list'
              ? await service.agentList(owner.chatId, agent)
              : call.op === 'add'
                ? await service.agentAdd(owner.chatId, agent, owner.turn, owner.label, call.items)
                : call.op === 'check'
                  ? await service.agentCheck(owner.chatId, agent, owner.turn, call.ids, call.done)
                  : call.op === 'remove'
                    ? await service.agentRemove(owner.chatId, agent, owner.turn, call.ids)
                    : call.op === 'ask_user'
                      ? await service.agentAskUser(
                          owner.chatId,
                          agent,
                          owner.turn,
                          call.questions.map((q) => ({ text: q.question, options: q.options }))
                        )
                      : call.op === 'comment'
                        ? await service.agentComment(owner.chatId, agent, owner.turn, call.id, call.text)
                        : await service.agentReview(owner.chatId, agent, owner.turn, call.summary)
          send(socket, { type: 'result', id, ok: true, text })
        } catch (error) {
          send(socket, { type: 'result', id, ok: false, text: errorText(error) })
        } finally {
          pending--
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
    createTodoTurn(owner: TodoOwner): TodoTurn {
      if (closed) throw unavailable()
      if (!isAbsolute(runtime.todoBridgeEntry) || !isAbsolute(runtime.node)) throw unavailable()
      const token = randomBytes(32).toString('hex')
      owners.set(token, { ...owner })
      // alwaysLoad: with many MCP tools the CLI defers the rest behind tool search, and an agent that never searches for ours would never reach them.
      const mcp: McpServerSpec = {
        name: 'zumibot_todos',
        command: runtime.node,
        args: [runtime.todoBridgeEntry],
        passEnv: ['ZUMIBOT_TODOS_CAPABILITY', 'ZUMIBOT_TODOS_IPC'],
        fixedEnv: runtime.electronNode ? { ELECTRON_RUN_AS_NODE: '1' } : {},
        alwaysLoad: true
      }
      return {
        // The token itself stays out of argv: it is only in the env the CLI expands the placeholders from.
        mcp,
        args: ['--mcp-config', JSON.stringify(claudeMcpConfig(mcp))],
        env: { ZUMIBOT_TODOS_CAPABILITY: token, ZUMIBOT_TODOS_IPC: socketPath },
        dispose() {
          owners.delete(token)
          for (const [socket, t] of sockets) if (t === token) socket.destroy()
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
export class TodoIpcClient {
  private nextId = 0
  private readonly pending = new Map<number, { resolve: (text: string) => void; reject: (error: Error) => void }>()
  private constructor(private readonly socket: Socket) {}
  static async connect(path: string, token: string): Promise<TodoIpcClient> {
    if (!isAbsolute(path) || !token || token.length > 128) throw unavailable()
    const socket = createConnection(path),
      client = new TodoIpcClient(socket)
    return await new Promise<TodoIpcClient>((resolve, reject) => {
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
  run(call: TodoCall): Promise<string> {
    if (this.socket.destroyed || this.pending.size >= pendingLimit || this.nextId >= 1e9) return Promise.reject(unavailable())
    if (Buffer.byteLength(JSON.stringify(call)) > requestLimit - 100) return Promise.reject(unavailable())
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
