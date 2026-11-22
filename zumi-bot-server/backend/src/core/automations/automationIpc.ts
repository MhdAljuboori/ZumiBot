import { createServer, createConnection, type Socket } from 'node:net'
import { randomBytes } from 'node:crypto'
import { rm } from 'node:fs/promises'
import { ipcEndpoint, secureEndpoint } from '../ipc/ipcEndpoint'
import { dirname, isAbsolute, join } from 'node:path'
import { claudeMcpConfig, type McpServerSpec } from '../ipc/mcpSpec'
import { AUTOMATIONS_SERVER } from '@zumibot/shared/automations'
import { resolveBrowserRuntime, type BrowserRuntime } from '../browser/browserRuntime'
import type { AutomationCall, AutomationOwner, AutomationService } from './automationService'
import { AUTOMATION_ASK_SETTINGS, parseAutomationWire } from './automationTools'

export type AutomationIpcService = Pick<AutomationService, 'run'>
export interface AutomationTurn {
  args: string[]
  mcp: McpServerSpec
  env: NodeJS.ProcessEnv
  dispose(): void
}
type Runtime = Pick<BrowserRuntime, 'node' | 'automationBridgeEntry' | 'electronNode'>

// Same framing as the todo IPC. The request limit leaves room for the 60 000-byte authoring object of a save; the
// response limit for a chat transcript (at most 150 000 characters).
const requestLimit = 128 * 1024,
  responseLimit = 1024 * 1024,
  pendingLimit = 16
const unavailable = () => new Error('Routines and workflows unavailable')
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
// looks like one becomes the generic text. Wider than the to-do filter: the refusals quote names (" “ ” ') and a chat
// address is a path ("/"), and the longest one (an unknown agent with a roster) is cut to fit 400.
const SAFE_MESSAGE = /^[A-Za-z0-9 .,:;'"“”/(){}?-]{1,400}$/
// A "/" is allowed only where the service itself puts one: inside a quoted span (authoring's `said()` makes every quote
// in an echoed value a "?", so only the service's own quotes remain) and in the one fixed time-zone example. Everything
// else with a "/" (a path, an address, a relative file) is not the service's sentence.
const IANA_EXAMPLE = 'such as Europe/Istanbul'
const withoutQuoted = (text: string): string =>
  text
    .replaceAll(IANA_EXAMPLE, '')
    .replace(/"[^"]*"/g, '')
    .replace(/“[^”]*”/g, '')
/** Whether a refusal sentence reaches the agent as written (what `errorText` lets through). Exported so each fixed sentence's test uses the real rule. */
export const isSafeMessage = (message: string): boolean =>
  SAFE_MESSAGE.test(message) && !/^[A-Z]+:/.test(message) && !withoutQuoted(message).includes('/')
function errorText(error: unknown): string {
  return error instanceof Error && isSafeMessage(error.message) ? error.message : unavailable().message
}

export async function serveAutomationIpc(options: { service: AutomationIpcService; socketPath?: string; runtime?: Runtime }) {
  const { service } = options
  // Once: resolving probes the disk synchronously, and every attempt of every Zumi Bot turn makes an automation turn.
  const runtime = options.runtime ?? resolveBrowserRuntime()
  const { ownedDir, socketPath } = await ipcEndpoint('r', options.socketPath, unavailable)
  const owners = new Map<string, AutomationOwner>(),
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
      let call: AutomationCall
      try {
        call = parseAutomationWire(message.call)
      } catch (error) {
        send(socket, { type: 'result', id, ok: false, text: errorText(error) })
        return
      }
      pending++
      void (async () => {
        try {
          // The chat and whether the turn may write come from the token alone.
          const text = await service.run({ ...owner }, call)
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
    /** side: a /btw run, whose guard blocks the tools anyway, so it gets no ask rules (its settings stay byte for byte). */
    createAutomationTurn(owner: AutomationOwner, o: { side?: true } = {}): AutomationTurn {
      if (closed) throw unavailable()
      if (!isAbsolute(runtime.automationBridgeEntry) || !isAbsolute(runtime.node)) throw unavailable()
      const token = randomBytes(32).toString('hex')
      owners.set(token, { ...owner })
      // alwaysLoad: with many MCP tools the CLI defers the rest behind tool search, and an agent that never searches for ours would never reach them.
      const mcp: McpServerSpec = {
        name: AUTOMATIONS_SERVER,
        command: runtime.node,
        args: [runtime.automationBridgeEntry],
        passEnv: ['ZUMIBOT_AUTOMATIONS_CAPABILITY', 'ZUMIBOT_AUTOMATIONS_IPC'],
        fixedEnv: runtime.electronNode ? { ELECTRON_RUN_AS_NODE: '1' } : {},
        alwaysLoad: true
      }
      return {
        // The token itself stays out of argv: it is only in the env the CLI expands the placeholders from.
        mcp,
        args: ['--mcp-config', JSON.stringify(claudeMcpConfig(mcp)), ...(o.side ? [] : ['--settings', AUTOMATION_ASK_SETTINGS])],
        env: { ZUMIBOT_AUTOMATIONS_CAPABILITY: token, ZUMIBOT_AUTOMATIONS_IPC: socketPath },
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
export class AutomationIpcClient {
  private nextId = 0
  private readonly pending = new Map<number, { resolve: (text: string) => void; reject: (error: Error) => void }>()
  private constructor(private readonly socket: Socket) {}
  static async connect(path: string, token: string): Promise<AutomationIpcClient> {
    if (!isAbsolute(path) || !token || token.length > 128) throw unavailable()
    const socket = createConnection(path),
      client = new AutomationIpcClient(socket)
    return await new Promise<AutomationIpcClient>((resolve, reject) => {
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
  run(call: AutomationCall): Promise<string> {
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

export { AUTOMATION_ASK_SETTINGS }
