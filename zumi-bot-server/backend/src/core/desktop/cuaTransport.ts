import type { ChildProcessByStdio } from 'node:child_process'
import type { Readable, Writable } from 'node:stream'
import { ReadBuffer, serializeMessage } from '@modelcontextprotocol/sdk/shared/stdio.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js'

// One log line a second at most: a chatty app could otherwise flood the server log.
const SKIP_LOG_MS = 1000

/**
 * MCP over the stdio of a cua-driver we spawned ourselves: the SDK's StdioClientTransport cannot
 * start a detached child and copies parts of the server env. Apps that cua-driver launches inherit
 * its stdout, so foreign lines are skipped; the log says so in a fixed sentence, never their text.
 */
export class CuaTransport implements Transport {
  onclose?: () => void
  onerror?: (error: Error) => void
  onmessage?: (message: JSONRPCMessage) => void
  private readonly buffer = new ReadBuffer()
  private readonly waiting = new Set<() => void>()
  private closed = false
  private skipLoggedAt = -Infinity

  constructor(
    private readonly child: ChildProcessByStdio<Writable, Readable, null>,
    private readonly log: (line: string) => void
  ) {}

  async start(): Promise<void> {
    this.child.stdout.on('data', (chunk: Buffer) => {
      if (this.closed) return
      try {
        this.buffer.append(chunk)
      } catch {
        // Over the reader's cap: the rest of that line arrives as garbage and is skipped below.
        this.skipped('Desktop: dropped an oversized message from cua-driver')
        return
      }
      while (!this.closed) {
        let message: JSONRPCMessage | null
        try {
          message = this.buffer.readMessage()
        } catch {
          this.skipped('Desktop: skipped a line from cua-driver that is not JSON-RPC')
          continue
        }
        if (!message) break
        this.onmessage?.(message)
      }
    })
    // A read or write error (EPIPE after cua-driver exits) ends the transport; the desktop handles the exit itself.
    this.child.stdout.on('error', () => this.finish())
    this.child.stdout.once('close', () => this.finish())
    this.child.stdin.on('error', () => this.finish())
  }

  send(message: JSONRPCMessage): Promise<void> {
    return new Promise((resolve, reject) => {
      const stdin = this.child.stdin
      if (this.closed || !stdin.writable) {
        reject(new Error('cua-driver is not running'))
        return
      }
      if (stdin.write(serializeMessage(message))) {
        resolve()
        return
      }
      // Settles either way: a child that dies with a full pipe never drains.
      const settle = (ok: boolean) => {
        stdin.off('drain', drained)
        this.waiting.delete(gone)
        if (ok) resolve()
        else reject(new Error('cua-driver is not running'))
      }
      const drained = () => settle(true)
      const gone = () => settle(false)
      stdin.once('drain', drained)
      this.waiting.add(gone)
    })
  }

  /** Ending stdin is how cua-driver is asked to exit (it does in ~270 ms). */
  async close(): Promise<void> {
    if (!this.child.stdin.destroyed) this.child.stdin.end()
    this.finish()
  }

  private skipped(line: string): void {
    const now = Date.now()
    if (now - this.skipLoggedAt < SKIP_LOG_MS) return
    this.skipLoggedAt = now
    this.log(line)
  }

  private finish(): void {
    if (this.closed) return
    this.closed = true
    this.buffer.clear()
    for (const gone of [...this.waiting]) gone()
    this.onclose?.()
  }
}
