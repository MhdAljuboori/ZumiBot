import { randomUUID } from 'node:crypto'
import type { WebSocket } from 'ws'
import { CLOSE_SIGNED_OUT, PING_METHOD, type RpcEvent, type RpcRequest, type RpcResponse } from '@zumibot/shared/rpc'
import type { Handlers } from './handlers'

/** Who is asking: handlers that need the connection (presence, the sign-in session) get this first. */
export interface ConnInfo {
  id: string
  sessionKey: string
}
export type ConnHandlers = Record<string, (conn: ConnInfo, ...args: unknown[]) => Promise<unknown>>

export interface Hub {
  attach(ws: WebSocket, sessionKey: string): void
  broadcast(e: RpcEvent): void
  // False when that connection is gone, so the caller can fall back to another channel.
  sendTo(connId: string, e: RpcEvent): boolean
  closeSession(sessionKey: string | 'all'): void
  // Shutdown: every socket gets this close code (1001 = going away, so clients reconnect).
  closeAll(code: number): void
  // Shutdown: new calls are refused so none can start work that nothing will stop.
  drain(): void
  size(): number
  dispose(): void
}

interface Client {
  id: string
  ws: WebSocket
  key: string
  alive: boolean
}

function parseRequest(data: string): RpcRequest | null {
  try {
    const v = JSON.parse(data) as Partial<RpcRequest> | null
    if (!v || typeof v.id !== 'number' || typeof v.method !== 'string') return null
    return { id: v.id, method: v.method, args: Array.isArray(v.args) ? v.args : [] }
  } catch {
    return null
  }
}

export function createHub(
  handlers: Handlers,
  o: {
    pingMs?: number
    closeGraceMs?: number
    isValid?(sessionKey: string): Promise<boolean>
    connHandlers?: ConnHandlers
    onDisconnect?(connId: string): void
  } = {}
): Hub {
  const clients = new Set<Client>()
  const byId = new Map<string, Client>()
  let draining = false

  // ws keeps emitting messages while CLOSING, and a client may ignore our close frame, so cut it off after a grace.
  const signOut = (ws: WebSocket): void => {
    if (ws.readyState !== ws.OPEN) return
    ws.close(CLOSE_SIGNED_OUT)
    setTimeout(() => ws.terminate(), o.closeGraceMs ?? 2000).unref()
  }

  const send = (ws: WebSocket, msg: RpcResponse | RpcEvent): void => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg))
  }

  // Close and terminate both end up here; the callback must run once per connection.
  const forget = (c: Client): void => {
    if (!clients.delete(c)) return
    byId.delete(c.id)
    try {
      o.onDisconnect?.(c.id)
    } catch {
      /* the socket is gone either way */
    }
  }

  async function answer(c: Client, req: RpcRequest): Promise<void> {
    const { ws } = c
    // First, so a liveness check answers even while shutting down: the socket is alive until it closes.
    if (req.method === PING_METHOD) return send(ws, { id: req.id, ok: true, value: true })
    // hasOwn: a method named "toString" or "__proto__" must not reach Object.prototype.
    if (draining) return send(ws, { id: req.id, ok: false, error: 'Server is shutting down' })
    // A name in both maps goes to the connection-aware one.
    const connFn = o.connHandlers && Object.hasOwn(o.connHandlers, req.method) ? o.connHandlers[req.method] : undefined
    const fn = connFn
      ? (...a: unknown[]) => connFn({ id: c.id, sessionKey: c.key }, ...a)
      : Object.hasOwn(handlers, req.method)
        ? handlers[req.method]
        : undefined
    if (!fn) return send(ws, { id: req.id, ok: false, error: `Unknown method: ${req.method}` })
    try {
      send(ws, { id: req.id, ok: true, value: await fn(...req.args) })
    } catch (err) {
      send(ws, { id: req.id, ok: false, error: err instanceof Error ? err.message : String(err) })
    }
  }

  // Two missed pings kill a dead socket; isValid catches a session that was signed out meanwhile.
  const timer = setInterval(() => {
    for (const c of clients) {
      if (!c.alive) {
        c.ws.terminate()
        forget(c)
        continue
      }
      c.alive = false
      c.ws.ping()
      if (o.isValid) {
        o.isValid(c.key).then(
          (ok) => {
            if (!ok) signOut(c.ws)
          },
          () => {} // a failed check is not a sign-out
        )
      }
    }
  }, o.pingMs ?? 30_000)
  timer.unref()

  return {
    attach(ws, key) {
      const c: Client = { id: randomUUID(), ws, key, alive: true }
      clients.add(c)
      byId.set(c.id, c)
      ws.on('pong', () => {
        c.alive = true
      })
      ws.on('message', (data, isBinary) => {
        if (isBinary || ws.readyState !== ws.OPEN) return
        const req = parseRequest(String(data))
        if (req) void answer(c, req)
      })
      ws.on('close', () => forget(c))
      ws.on('error', () => ws.terminate())
    },
    broadcast(e) {
      for (const c of clients) send(c.ws, e)
    },
    sendTo(connId, e) {
      const c = byId.get(connId)
      if (!c || c.ws.readyState !== c.ws.OPEN) return false
      send(c.ws, e)
      return true
    },
    closeSession(key) {
      for (const c of clients) {
        if (key === 'all' || c.key === key) signOut(c.ws)
      }
    },
    drain() {
      draining = true
    },
    closeAll(code) {
      for (const c of clients) {
        if (c.ws.readyState !== c.ws.OPEN) continue
        c.ws.close(code)
        setTimeout(() => c.ws.terminate(), o.closeGraceMs ?? 2000).unref()
      }
    },
    size: () => clients.size,
    dispose: () => clearInterval(timer)
  }
}
