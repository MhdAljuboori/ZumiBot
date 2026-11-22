import { createServer, createConnection, type Socket } from 'node:net'
import { randomBytes } from 'node:crypto'
import { rm } from 'node:fs/promises'
import { ipcEndpoint, secureEndpoint } from '../ipc/ipcEndpoint'
import { dirname, isAbsolute, join } from 'node:path'
import { PROCESS_REFUSALS } from '@zumibot/shared/processes'
import { claudeMcpConfig, type McpServerSpec } from '../ipc/mcpSpec'
import { exact, readLines, record, send } from '../ipc/lineIpc'
import { resolveBrowserRuntime, type BrowserRuntime } from '../browser/browserRuntime'
import type { ProcessService } from './processService'
import { PROCESS_ASK_SETTINGS, PROCESS_SERVER, parseProcessWire, type ProcessCall } from './processTools'

export type ProcessIpcService = Pick<ProcessService, 'agentStart' | 'agentList' | 'agentLogs' | 'agentWait' | 'agentStop'>
/**
 * Who a bridge acts as. `agent` is read per call: in a room the speaking member is known only when it runs. `planning` is true while
 * the turn started in Plan mode and its plan is not yet approved. A side run's bridge only holds the definitions: every call is refused.
 */
export interface ProcessOwner {
  chatId: string
  agent: () => string
  turn: string
  planning?: () => boolean
  side?: true
}
export interface ProcessTurn {
  args: string[]
  mcp: McpServerSpec
  env: NodeJS.ProcessEnv
  dispose(): void
}
type Runtime = Pick<BrowserRuntime, 'node' | 'processBridgeEntry' | 'electronNode'>

const requestLimit = 64 * 1024,
  responseLimit = 256 * 1024,
  pendingLimit = 16
// wait may block 120 s; the CLI's MCP timeout must not cut it first.
export const PROCESS_MCP_TIMEOUT_MS = 150_000
const unavailable = () => new Error('Processes unavailable')
// Only the service's own sentences reach the agent. A failure that names a path or an errno becomes the generic text.
const SAFE_MESSAGE = /^[A-Za-z0-9 .,:;'"(){}?_/-]{1,300}$/
function errorText(error: unknown): string {
  return error instanceof Error && SAFE_MESSAGE.test(error.message) && !/^[A-Z]+:/.test(error.message) && !error.message.includes('/')
    ? error.message
    : unavailable().message
}

export async function serveProcessIpc(options: { service: ProcessIpcService; socketPath?: string; runtime?: Runtime }) {
  const { service } = options
  const runtime = options.runtime ?? resolveBrowserRuntime()
  const { ownedDir, socketPath } = await ipcEndpoint('p', options.socketPath, unavailable)
  const owners = new Map<string, ProcessOwner>()
  const sockets = new Map<Socket, { token?: string; calls: Set<AbortController> }>()
  let closed = false,
    closing: Promise<void> | undefined
  const run = (owner: ProcessOwner, call: ProcessCall, signal: AbortSignal): Promise<string> => {
    if (owner.side) throw new Error('No tools in a side answer')
    const agent = owner.agent()
    switch (call.op) {
      case 'start':
        if (owner.planning?.()) throw new Error(PROCESS_REFUSALS.plan)
        return service.agentStart(owner.chatId, agent, {
          command: call.command,
          name: call.name,
          cwd: call.cwd,
          timeoutMinutes: call.timeoutMinutes,
          ...(call.notify ? { notify: call.notify } : {})
        })
      case 'list':
        return Promise.resolve(service.agentList(owner.chatId))
      case 'logs':
        return service.agentLogs(owner.chatId, call)
      case 'wait':
        return service.agentWait(owner.chatId, call, signal)
      case 'stop':
        return service.agentStop(owner.chatId, call.id)
    }
  }
  const server = createServer((socket) => {
    if (closed || sockets.size >= 64) {
      socket.destroy()
      return
    }
    const state: { token?: string; calls: Set<AbortController> } = { calls: new Set() }
    sockets.set(socket, state)
    let lastId = 0
    const authTimer = setTimeout(() => socket.destroy(), 5000)
    authTimer.unref()
    socket.on('error', () => {})
    // A closed bridge (the turn's Stop, its end) ends a wait still blocking.
    socket.on('close', () => {
      clearTimeout(authTimer)
      for (const c of state.calls) c.abort()
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
        state.calls.size >= pendingLimit
      ) {
        socket.destroy()
        return
      }
      const id = message.id as number
      lastId = id
      let call: ProcessCall
      try {
        call = parseProcessWire(message.call)
      } catch (error) {
        send(socket, { type: 'result', id, ok: false, text: errorText(error) })
        return
      }
      const ac = new AbortController()
      state.calls.add(ac)
      void (async () => {
        try {
          send(socket, { type: 'result', id, ok: true, text: await run(owner, call, ac.signal) })
        } catch (error) {
          send(socket, { type: 'result', id, ok: false, text: errorText(error) })
        } finally {
          state.calls.delete(ac)
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
    createProcessTurn(owner: ProcessOwner): ProcessTurn {
      if (closed) throw unavailable()
      if (!isAbsolute(runtime.processBridgeEntry) || !isAbsolute(runtime.node)) throw unavailable()
      const token = randomBytes(32).toString('hex')
      owners.set(token, { ...owner })
      const mcp: McpServerSpec = {
        name: PROCESS_SERVER,
        command: runtime.node,
        args: [runtime.processBridgeEntry],
        passEnv: ['ZUMIBOT_PROCESSES_CAPABILITY', 'ZUMIBOT_PROCESSES_IPC'],
        fixedEnv: runtime.electronNode ? { ELECTRON_RUN_AS_NODE: '1' } : {},
        alwaysLoad: true,
        timeoutMs: PROCESS_MCP_TIMEOUT_MS
      }
      return {
        mcp,
        // A side run's guard takes the place of the ask rule: its one settings object must stay as the side guard pins it.
        args: ['--mcp-config', JSON.stringify(claudeMcpConfig(mcp)), ...(owner.side ? [] : ['--settings', PROCESS_ASK_SETTINGS])],
        env: { ZUMIBOT_PROCESSES_CAPABILITY: token, ZUMIBOT_PROCESSES_IPC: socketPath },
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
export class ProcessIpcClient {
  private nextId = 0
  private readonly pending = new Map<number, { resolve: (text: string) => void; reject: (error: Error) => void }>()
  private constructor(private readonly socket: Socket) {}
  static async connect(path: string, token: string): Promise<ProcessIpcClient> {
    if (!isAbsolute(path) || !token || token.length > 128) throw unavailable()
    const socket = createConnection(path),
      client = new ProcessIpcClient(socket)
    return await new Promise<ProcessIpcClient>((resolve, reject) => {
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
  run(call: ProcessCall): Promise<string> {
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
