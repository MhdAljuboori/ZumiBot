// JSON-RPC over stdio lines for `codex app-server`: one JSON object per line, no `jsonrpc` field.
// Pure: the caller spawns the process, feeds stdout lines to receive() and supplies write().

export type RpcId = string | number

export type RpcIncoming =
  { kind: 'notification'; method: string; params: any } | { kind: 'request'; id: RpcId; method: string; params: any }

export class RpcError extends Error {
  constructor(
    readonly code: number,
    message: string
  ) {
    super(message)
    this.name = 'RpcError'
  }
}

type Pending = { resolve: (v: any) => void; reject: (e: Error) => void }

const isId = (v: unknown): v is RpcId => typeof v === 'number' || typeof v === 'string'

export class CodexRpc {
  private next = 1
  private pending = new Map<number, Pending>()
  private closed: Error | null = null

  // write returns false when the line could not be sent (a closed pipe).
  constructor(private readonly write: (line: string) => boolean) {}

  request<T>(method: string, params: unknown): Promise<T> {
    if (this.closed) return Promise.reject(this.closed)
    const id = this.next++
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      // Key order id, method, params is part of the wire format the tests pin.
      if (!this.send({ id, method, params })) {
        this.pending.delete(id)
        reject(new Error('Codex is not accepting input'))
      }
    })
  }

  notify(method: string, params?: unknown): void {
    this.send(params === undefined ? { method } : { method, params })
  }

  respond(id: RpcId, result: unknown): void {
    this.send({ id, result })
  }

  respondError(id: RpcId, code: number, message: string): void {
    this.send({ id, error: { code, message } })
  }

  // Settles a response here (null); a notification or server request goes back to the caller.
  // Anything that is not a JSON object is ignored: stdout may carry stray text.
  receive(line: string): RpcIncoming | null {
    let msg: any
    try {
      msg = JSON.parse(line)
    } catch {
      return null
    }
    if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return null
    if (typeof msg.method === 'string') {
      if (isId(msg.id)) return { kind: 'request', id: msg.id, method: msg.method, params: msg.params }
      if (msg.id === undefined) return { kind: 'notification', method: msg.method, params: msg.params }
      return null
    }
    if (typeof msg.id !== 'number') return null
    const p = this.pending.get(msg.id)
    if (!p) return null
    this.pending.delete(msg.id)
    if (msg.error && typeof msg.error === 'object') {
      const code = typeof msg.error.code === 'number' ? msg.error.code : -32000
      // Only the server's own message text; never the request's params.
      p.reject(new RpcError(code, typeof msg.error.message === 'string' ? msg.error.message : 'Codex request failed'))
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
