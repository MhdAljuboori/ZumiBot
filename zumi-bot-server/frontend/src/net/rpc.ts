import { CLOSE_SIGNED_OUT, PING_METHOD, type RpcEvent, type RpcRequest, type RpcResponse } from '@zumibot/shared/rpc'
import type { ConnectionStatus } from '@zumibot/shared/types'

export interface RpcClient {
  call(method: string, args: unknown[]): Promise<unknown>
  on(event: RpcEvent['event'], cb: (payload: never) => void): () => void
  onStatus(cb: (s: ConnectionStatus) => void): () => void
  status(): ConnectionStatus
  /**
   * Pings the server; with no answer within `timeoutMs` the socket counts as dead and reconnects, as a close would. For the
   * moments the browser fires no close on a half-open connection (waking from sleep, Wi-Fi to mobile data).
   */
  checkAlive(timeoutMs?: number): void
}

export const ALIVE_TIMEOUT_MS = 5000

export const NOT_CONNECTED = 'Not connected. Reconnecting…'
export const defaultBackoff = (attempt: number): number => Math.min(500 * 2 ** attempt, 10_000)

interface Pending {
  resolve(v: unknown): void
  reject(e: Error): void
}

interface Early extends Pending {
  method: string
  args: unknown[]
}

export function createRpcClient(o: {
  url: string
  WebSocketImpl?: typeof WebSocket
  onSignedOut(): void
  backoffMs?: (attempt: number) => number
}): RpcClient {
  const Impl = o.WebSocketImpl ?? WebSocket
  const backoff = o.backoffMs ?? defaultBackoff
  const pending = new Map<number, Pending>()
  const eventSubs = new Map<RpcEvent['event'], Set<(payload: never) => void>>()
  const statusSubs = new Set<(s: ConnectionStatus) => void>()
  let ws: WebSocket | null = null
  let status: ConnectionStatus = 'reconnecting' // until the first open
  let attempt = 0
  let nextId = 1
  let signedOut = false
  let probing = false
  // Calls made before the socket first opened: a page loaded at its own address asks for its data on mount, and a
  // rejection then would leave it on "Not connected" for good. After the first open a call while down fails at once,
  // as a send or a click must not run late.
  let early: Early[] | null = []

  const setStatus = (s: ConnectionStatus): void => {
    if (s === status) return
    status = s
    for (const cb of [...statusSubs]) cb(s)
  }

  const failPending = (): void => {
    const all = [...pending.values()]
    pending.clear()
    for (const p of all) p.reject(new Error(NOT_CONNECTED))
  }

  const send = (method: string, args: unknown[], p: Pending): void => {
    const id = nextId++
    const req: RpcRequest = { id, method, args }
    pending.set(id, p)
    try {
      ws!.send(JSON.stringify(req))
    } catch (err) {
      pending.delete(id)
      p.reject(err instanceof Error ? err : new Error(String(err)))
    }
  }

  const connect = (): void => {
    const sock = new Impl(o.url)
    ws = sock
    sock.onopen = () => {
      attempt = 0
      // Before the status change, so they go out ahead of the calls its subscribers make.
      const waiting = early ?? []
      early = null
      for (const c of waiting) send(c.method, c.args, c)
      setStatus('connected')
    }
    sock.onmessage = (e: MessageEvent) => {
      let msg: RpcResponse | RpcEvent
      try {
        msg = JSON.parse(String(e.data))
      } catch {
        return
      }
      if (!msg || typeof msg !== 'object') return
      if ('event' in msg) {
        // One subscriber that throws must not keep the push from the others (unread counts, the island…).
        for (const cb of [...(eventSubs.get(msg.event) ?? [])]) {
          try {
            cb(msg.payload as never)
          } catch (err) {
            console.error(`${msg.event} subscriber failed:`, err)
          }
        }
        return
      }
      const p = pending.get(msg.id)
      if (!p) return
      pending.delete(msg.id)
      if (msg.ok) p.resolve(msg.value)
      else p.reject(new Error(msg.error))
    }
    sock.onclose = (e: CloseEvent) => dropped(sock, e.code)
  }

  const dropped = (sock: WebSocket, code: number): void => {
    if (ws !== sock) return
    ws = null
    probing = false
    failPending()
    if (code === CLOSE_SIGNED_OUT) {
      signedOut = true
      const waiting = early ?? []
      early = null
      for (const c of waiting) c.reject(new Error(NOT_CONNECTED))
      setStatus('reconnecting')
      o.onSignedOut()
      return
    }
    setStatus('reconnecting')
    setTimeout(connect, backoff(attempt++))
  }
  connect()

  const call = (method: string, args: unknown[]): Promise<unknown> => {
    if (signedOut) return Promise.reject(new Error(NOT_CONNECTED))
    const waiting = early
    if (waiting) return new Promise((resolve, reject) => void waiting.push({ method, args, resolve, reject }))
    if (status !== 'connected' || !ws) return Promise.reject(new Error(NOT_CONNECTED))
    // No timeout: chats:send settles only when the agent turn ends.
    return new Promise((resolve, reject) => send(method, args, { resolve, reject }))
  }

  return {
    call,
    on(event, cb) {
      const set = eventSubs.get(event) ?? new Set()
      eventSubs.set(event, set)
      set.add(cb)
      return () => void set.delete(cb)
    },
    onStatus(cb) {
      statusSubs.add(cb)
      return () => void statusSubs.delete(cb)
    },
    status: () => status,
    checkAlive(timeoutMs = ALIVE_TIMEOUT_MS) {
      const sock = ws
      if (probing || !sock || status !== 'connected') return
      probing = true
      const timer = setTimeout(() => {
        if (ws !== sock) return
        // A dead socket's close handshake would wait as long as TCP does: drop it now, then close it for the record.
        dropped(sock, 1006)
        try {
          sock.close()
        } catch {
          /* already gone */
        }
      }, timeoutMs)
      call(PING_METHOD, []).then(
        () => {
          clearTimeout(timer)
          if (ws === sock) probing = false
        },
        () => clearTimeout(timer) // rejected: the socket closed meanwhile, and its close already reconnects
      )
    }
  }
}
