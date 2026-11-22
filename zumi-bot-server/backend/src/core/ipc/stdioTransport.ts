import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CancelledNotificationSchema, type JSONRPCMessage, type RequestId } from '@modelcontextprotocol/sdk/types.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import type { Writable } from 'node:stream'

const outputLimit = 12 * 1024 * 1024,
  dispatchLimit = 16

/** Reserve output until write completion; SDK drain waits alone do not bound concurrent sends. */
export class BoundedStdioTransport implements Transport {
  onmessage?: Transport['onmessage']
  onerror?: Transport['onerror']
  onclose?: Transport['onclose']
  private readonly stdio: StdioServerTransport
  private readonly requests = new Map<RequestId, { abort: AbortController; cancelled: boolean }>()
  private readonly writes = new Set<{ reject(error: Error): void }>()
  private queuedBytes = 0
  private closed = false
  constructor(
    private readonly output: Writable,
    private readonly overflow: () => void,
    private readonly closedMessage = 'Transport closed'
  ) {
    this.stdio = new StdioServerTransport(process.stdin, output, { maxBufferSize: 65536 })
    this.stdio.onmessage = (message) => {
      if (this.closed) return
      if ('method' in message && !('id' in message) && message.method === 'notifications/cancelled') {
        const parsed = CancelledNotificationSchema.safeParse(message)
        if (parsed.success && parsed.data.params.requestId !== undefined) {
          const request = this.requests.get(parsed.data.params.requestId)
          if (request) {
            request.cancelled = true
            request.abort.abort()
          }
        }
        // Keep the SDK completion reply: release only after its handler really settles.
        return
      }
      if ('method' in message && 'id' in message) {
        if (this.requests.has(message.id) || this.requests.size >= dispatchLimit) {
          this.overflow()
          return
        }
        this.requests.set(message.id, { abort: new AbortController(), cancelled: false })
      }
      this.onmessage?.(message)
    }
    this.stdio.onerror = () => {
      this.onerror?.(this.transportClosed())
    }
    this.stdio.onclose = () => {
      void this.close()
    }
    output.on('error', () => this.overflow())
  }
  private transportClosed(): Error {
    return new Error(this.closedMessage)
  }
  start(): Promise<void> {
    return this.stdio.start()
  }
  signal(id: RequestId): AbortSignal {
    return this.requests.get(id)?.abort.signal ?? AbortSignal.abort()
  }
  send(message: JSONRPCMessage): Promise<void> {
    if (this.closed) return Promise.reject(this.transportClosed())
    if ('id' in message && message.id !== undefined && this.requests.get(message.id)?.cancelled) {
      this.requests.delete(message.id)
      return Promise.resolve()
    }
    const frame = JSON.stringify(message) + '\n',
      bytes = Buffer.byteLength(frame)
    if (this.writes.size >= dispatchLimit || bytes > 6 * 1024 * 1024 || bytes + this.queuedBytes > outputLimit) {
      this.overflow()
      return Promise.reject(this.transportClosed())
    }
    this.queuedBytes += bytes
    return new Promise<void>((resolve, reject) => {
      const pending = { reject }
      this.writes.add(pending)
      const complete = (error?: Error | null) => {
        if (!this.writes.delete(pending)) return
        this.queuedBytes -= bytes
        if ('id' in message && message.id !== undefined) this.requests.delete(message.id)
        if (error) {
          reject(this.transportClosed())
          this.overflow()
        } else resolve()
      }
      try {
        this.output.write(frame, complete)
      } catch {
        complete(this.transportClosed())
      }
    })
  }
  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    for (const request of this.requests.values()) request.abort.abort()
    for (const pending of this.writes) pending.reject(this.transportClosed())
    this.writes.clear()
    this.requests.clear()
    this.queuedBytes = 0
    // Destroy queued writes as well as their promises: a paused reader may never drain.
    this.output.destroy()
    if ('unref' in this.output && typeof this.output.unref === 'function') this.output.unref()
    await this.stdio.close()
    this.onclose?.()
  }
}
