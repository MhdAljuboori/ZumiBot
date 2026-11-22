// JSON-RPC 2.0 over stdio lines for an ACP agent: one JSON object per line, every message we write carries `jsonrpc`.
// Pure: the caller spawns the process, feeds stdout lines to receive() and supplies write().

export type AcpId = string | number

export type AcpIncoming =
  { kind: 'notification'; method: string; params: any } | { kind: 'request'; id: AcpId; method: string; params: any }

/** JSON-RPC's codes, and the ACP ones (-32800 cancelled, -32000 auth required, -32002 resource not found). */
export const ACP_ERROR = {
  parse: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internal: -32603,
  cancelled: -32800,
  authRequired: -32000,
  notFound: -32002
} as const

export class AcpRpcError extends Error {
  // data: the agent's own, kept off the message (an auth error lists its methods there).
  constructor(
    readonly code: number,
    message: string,
    readonly data?: unknown
  ) {
    super(message)
    this.name = 'AcpRpcError'
  }
}

type Pending = { resolve: (v: any) => void; reject: (e: Error) => void; onSettle?: () => void }

const isId = (v: unknown): v is AcpId => typeof v === 'number' || typeof v === 'string'

export class AcpRpc {
  private next = 1
  private pending = new Map<number, Pending>()
  private closed: Error | null = null
  /** Lines that were not a JSON object: the runner ends a turn that sees too many. */
  malformed = 0

  // write returns false when the line could not be sent (a closed pipe).
  constructor(private readonly write: (line: string) => boolean) {}

  /**
   * `onSettle` runs inside the `receive` that reads the response (result or error), before any later line: the promise
   * settles a microtask later, after the rest of that stdout chunk has been handled.
   */
  request<T>(method: string, params: unknown, onSettle?: () => void): Promise<T> {
    if (this.closed) return Promise.reject(this.closed)
    const id = this.next++
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve, reject, onSettle })
      // Key order jsonrpc, id, method, params is part of the wire format the tests pin.
      if (!this.send({ jsonrpc: '2.0', id, method, params })) {
        this.pending.delete(id)
        reject(new Error('The agent is not accepting input'))
      }
    })
  }

  notify(method: string, params?: unknown): void {
    this.send(params === undefined ? { jsonrpc: '2.0', method } : { jsonrpc: '2.0', method, params })
  }

  respond(id: AcpId, result: unknown): void {
    this.send({ jsonrpc: '2.0', id, result })
  }

  respondError(id: AcpId, code: number, message: string): void {
    this.send({ jsonrpc: '2.0', id, error: { code, message } })
  }

  // Settles a response here (null); a notification or agent request goes back to the caller.
  // A line that is not a JSON object is counted and ignored: stdout may carry stray text.
  receive(line: string): AcpIncoming | null {
    if (line.trim() === '') return null
    let msg: any
    try {
      msg = JSON.parse(line)
    } catch {
      this.malformed++
      return null
    }
    if (!msg || typeof msg !== 'object' || Array.isArray(msg)) {
      this.malformed++
      return null
    }
    if (typeof msg.method === 'string') {
      if (isId(msg.id)) return { kind: 'request', id: msg.id, method: msg.method, params: msg.params }
      if (msg.id === undefined) return { kind: 'notification', method: msg.method, params: msg.params }
      return null
    }
    if (typeof msg.id !== 'number') return null
    const p = this.pending.get(msg.id)
    if (!p) return null
    this.pending.delete(msg.id)
    p.onSettle?.()
    if (msg.error && typeof msg.error === 'object') {
      const code = typeof msg.error.code === 'number' ? msg.error.code : ACP_ERROR.internal
      // Only the agent's own message text; never the request's params.
      p.reject(new AcpRpcError(code, typeof msg.error.message === 'string' ? msg.error.message : 'ACP request failed', msg.error.data))
    } else p.resolve(msg.result)
    return null
  }

  close(err: Error): void {
    if (!this.closed) this.closed = err
    const all = [...this.pending.values()]
    this.pending.clear()
    for (const p of all) p.reject(err)
  }

  private send(obj: object): boolean {
    try {
      return this.write(JSON.stringify(obj) + '\n')
    } catch {
      return false
    }
  }
}
