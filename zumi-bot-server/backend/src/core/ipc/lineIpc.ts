import { createConnection, type Socket } from 'node:net'
import { isAbsolute } from 'node:path'

// Shared by the browser and desktop IPC: newline-framed JSON with byte limits and an authenticated client.
export const requestLimit = 65536,
  responseLimit = 6 * 1024 * 1024,
  pendingLimit = 16
export function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}
export function exact(value: Record<string, unknown>, keys: string[]): boolean {
  return Object.keys(value).every((k) => keys.includes(k))
}
export function send(socket: Socket, value: unknown): void {
  if (socket.destroyed) return
  const data = JSON.stringify(value) + '\n'
  if (Buffer.byteLength(data) > responseLimit || socket.writableLength + Buffer.byteLength(data) > responseLimit * 2) {
    socket.destroy()
    return
  }
  socket.write(data)
}
/** Newline framing with byte limits enforced before JSON parsing. */
export function readLines(socket: Socket, limit: number, consume: (message: Record<string, unknown>) => void): void {
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
        if (!record(value)) throw new Error('Invalid message')
        consume(value)
      } catch {
        socket.destroy()
        return
      }
    }
  })
}

export interface LineIpcOptions {
  /** The feature's own error, so each caller keeps its message ("Browser unavailable"). */
  unavailable: () => Error
  /** Throws on a command the server would refuse; the same parser the server uses. */
  parse: (command: unknown) => unknown
}
type Pending<R> = { resolve: (result: R) => void; reject: (error: Error) => void; cleanup(): void }

/** One authenticated connection per bridge; bounded in-flight calls and no caller owner fields. */
export class LineIpcClient<C, R extends { ok: boolean }> {
  private nextId = 0
  private readonly pending = new Map<number, Pending<R>>()
  private constructor(
    private readonly socket: Socket,
    private readonly options: LineIpcOptions
  ) {}
  static async connect<C, R extends { ok: boolean }>(path: string, token: string, options: LineIpcOptions): Promise<LineIpcClient<C, R>> {
    const { unavailable } = options
    if (!isAbsolute(path) || !token || token.length > 128) throw unavailable()
    const socket = createConnection(path),
      client = new LineIpcClient<C, R>(socket, options)
    return await new Promise<LineIpcClient<C, R>>((resolve, reject) => {
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
        if (message.error || !record(message.result) || typeof message.result.ok !== 'boolean') p.reject(unavailable())
        else p.resolve(message.result as unknown as R)
      })
      socket.once('connect', () => send(socket, { type: 'auth', token }))
    })
  }
  run(command: C, signal: AbortSignal): Promise<R> {
    const { unavailable } = this.options
    if (signal.aborted || this.socket.destroyed || this.pending.size >= pendingLimit || this.nextId >= 1e9)
      return Promise.reject(unavailable())
    try {
      this.options.parse(command)
      if (Buffer.byteLength(JSON.stringify(command)) > requestLimit - 100) throw unavailable()
    } catch {
      return Promise.reject(unavailable())
    }
    const id = ++this.nextId
    return new Promise((resolve, reject) => {
      const abort = () => {
        this.pending.delete(id)
        send(this.socket, { type: 'cancel', id })
        reject(unavailable())
      }
      this.pending.set(id, { resolve, reject, cleanup: () => signal.removeEventListener('abort', abort) })
      signal.addEventListener('abort', abort, { once: true })
      send(this.socket, { type: 'run', id, command })
    })
  }
  close(): void {
    this.socket.destroy()
  }
}
