import {
  decodeBrowserFrame,
  type BrowserCommand,
  type BrowserFrame,
  type BrowserInput,
  type BrowserResponse,
  type BrowserStatus,
  type BrowserTarget,
  type BrowserViewport
} from '@zumibot/shared/browser'
import { CLOSE_SIGNED_OUT } from '@zumibot/shared/rpc'
import { defaultBackoff, NOT_CONNECTED } from './rpc'

export interface BrowserClient {
  watch(target: BrowserTarget): Promise<void>
  unwatch(): void
  takeControl(on: boolean): Promise<void>
  input(input: BrowserInput): Promise<void>
  /** Needs no control: the server lets the controller's size win. */
  viewport(viewport: BrowserViewport): Promise<void>
  navigate(command: BrowserCommand): Promise<void>
  answer(requestId: string, decision: 'done' | 'cancel', target?: BrowserTarget): Promise<void>
  close(): void
}
interface Pending {
  resolve(value: unknown): void
  reject(error: Error): void
  watch: number | null
}
export function createBrowserClient(o: {
  url: string
  makeSocket?(url: string): WebSocket
  onStatus(status: BrowserStatus | null): void
  onFrame(frame: BrowserFrame): void
  onSignedOut?(): void
  onConnection?(connected: boolean): void
}): BrowserClient {
  let socket: WebSocket | null = null,
    closed = false,
    signedOut = false,
    connected = false,
    nextId = 1,
    attempt = 0
  let retry: ReturnType<typeof setTimeout> | undefined,
    watchId: number | null = null,
    target: BrowserTarget | null = null
  let status: BrowserStatus | null = null,
    epoch = 0,
    controlled = false
  let opening: Array<{ resolve(): void; reject(e: Error): void }> = []
  const pending = new Map<number, Pending>()
  const invalidate = (): void => {
    epoch++
    controlled = false
  }
  const cancelWatch = (): void => {
    const old = watchId
    watchId = null
    status = null
    invalidate()
    o.onStatus(null)
    for (const [id, p] of pending)
      if (p.watch === old && old !== null) {
        pending.delete(id)
        p.reject(new Error('Browser view closed'))
      }
  }
  const send = (body: object, watch: number | null = null, id = nextId++): Promise<unknown> => {
    if (!connected || !socket) return Promise.reject(new Error(NOT_CONNECTED))
    // Keep both outstanding commands and websocket output bounded; never queue input for reconnect.
    if (pending.size >= 128 || socket.bufferedAmount > 64 * 1024) return Promise.reject(new Error('Browser connection is busy'))
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject, watch })
      try {
        socket!.send(JSON.stringify({ id, ...body }))
      } catch {
        pending.delete(id)
        reject(new Error(NOT_CONNECTED))
      }
    })
  }
  const connect = (): void => {
    if (socket || closed || signedOut) return
    const ws = (o.makeSocket ?? ((url) => new WebSocket(url)))(o.url)
    socket = ws
    ws.binaryType = 'arraybuffer'
    ws.onopen = () => {
      if (socket !== ws || closed) return
      connected = true
      attempt = 0
      const waiting = opening
      opening = []
      for (const p of waiting) p.resolve()
      o.onConnection?.(true)
    }
    ws.onmessage = (e) => {
      if (socket !== ws || closed) return
      try {
        if (e.data instanceof ArrayBuffer || e.data instanceof Uint8Array) {
          const f = decodeBrowserFrame(e.data instanceof Uint8Array ? e.data : new Uint8Array(e.data))
          if (f.watchId === watchId && status?.state === 'ready' && f.generation === status.generation && f.tabId === status.activeTabId)
            o.onFrame(f)
          return
        }
        const msg = JSON.parse(String(e.data))
        if (msg.type === 'status') {
          if (msg.watchId !== watchId) return
          const s = msg.status as BrowserStatus
          const changedGeneration = status !== null && status.generation !== s.generation
          const changedTab = status !== null && status.activeTabId !== s.activeTabId
          if (changedGeneration || s.state !== 'ready' || (s.control !== 'you' && s.control !== 'pausing')) invalidate()
          else if (changedTab) epoch++
          status = s
          o.onStatus(s)
          return
        }
        if (msg.type !== 'response') return
        const r = msg as BrowserResponse,
          p = pending.get(r.id)
        if (!p) return
        pending.delete(r.id)
        if (!r.ok) p.reject(new Error(r.error))
        else if (r.value && !r.value.ok) p.reject(new Error(r.value.message))
        else p.resolve(r.value)
      } catch {
        /* Ignore malformed packets; no arbitrary site content enters the app DOM. */
      }
    }
    ws.onclose = (e) => {
      if (socket !== ws) return
      socket = null
      connected = false
      cancelWatch()
      for (const p of pending.values()) p.reject(new Error(NOT_CONNECTED))
      pending.clear()
      for (const p of opening) p.reject(new Error(NOT_CONNECTED))
      opening = []
      o.onConnection?.(false)
      if (e.code === CLOSE_SIGNED_OUT) {
        signedOut = true
        o.onSignedOut?.()
        return
      }
      if (!closed) retry = setTimeout(connect, defaultBackoff(attempt++))
    }
  }
  const ready = (): Promise<void> => {
    if (closed || signedOut) return Promise.reject(new Error(NOT_CONNECTED))
    if (connected) return Promise.resolve()
    const waiting = new Promise<void>((resolve, reject) => opening.push({ resolve, reject }))
    connect()
    return waiting
  }
  const page = (): { watchId: number; generation: string; tabId: string } => {
    if (watchId === null || status?.state !== 'ready' || !status.activeTabId) throw new Error('Browser page is unavailable')
    return { watchId, generation: status.generation, tabId: status.activeTabId }
  }
  return {
    async watch(t) {
      if (watchId !== null) this.unwatch()
      target = t
      const before = ++epoch
      await ready()
      if (before !== epoch || closed) throw new Error('Browser view closed')
      controlled = false
      const id = nextId++
      watchId = id
      try {
        await send({ op: 'watch', target: t }, id, id)
      } catch (error) {
        const unavailable = watchId === id && status?.state === 'unavailable'
        if (watchId === id) cancelWatch()
        if (unavailable) throw new Error('Browser unavailable. Check the server’s browser runtime setup, then retry.')
        throw error
      }
    },
    unwatch() {
      const old = watchId
      cancelWatch()
      if (old !== null && connected) void send({ op: 'unwatch', watchId: old }).catch(() => {})
    },
    async takeControl(on) {
      if (!on) invalidate()
      const p = page(),
        before = epoch
      try {
        await send({ op: on ? 'takeControl' : 'releaseControl', ...p }, p.watchId)
        if (on && before === epoch && watchId === p.watchId && status?.state === 'ready' && status.control === 'you') controlled = true
      } catch (error) {
        controlled = false
        throw error
      }
    },
    async input(input) {
      const p = page()
      if (!controlled || status?.control !== 'you' || input.generation !== p.generation || input.tabId !== p.tabId)
        throw new Error('Take control to interact with the browser')
      await send({ op: 'input', watchId: p.watchId, input }, p.watchId)
    },
    async viewport(v) {
      if (watchId === null || status?.state !== 'ready') throw new Error('Browser page is unavailable')
      await send({ op: 'viewport', watchId, ...v }, watchId)
    },
    async navigate(command) {
      const p = page()
      if (!controlled || status?.control !== 'you') throw new Error('Take control to navigate')
      await send({ op: 'navigate', ...p, command }, p.watchId)
    },
    async answer(requestId, decision, t = target ?? undefined) {
      if (!t) throw new Error('Browser request target is unavailable')
      await ready()
      if (t.agent === target?.agent) invalidate()
      await send({ op: 'answer', target: t, requestId, decision })
    },
    close() {
      closed = true
      clearTimeout(retry)
      cancelWatch()
      for (const p of pending.values()) p.reject(new Error('Browser connection closed'))
      pending.clear()
      for (const p of opening) p.reject(new Error('Browser connection closed'))
      opening = []
      const ws = socket
      socket = null
      connected = false
      ws?.close()
    }
  }
}
