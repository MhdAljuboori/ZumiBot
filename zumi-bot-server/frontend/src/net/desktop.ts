import type { DesktopRequest, DesktopServerMessage, DesktopStatus, DesktopTarget } from '@zumibot/shared/desktop'
import { CLOSE_SIGNED_OUT } from '@zumibot/shared/rpc'
import { defaultBackoff, NOT_CONNECTED } from './rpc'

// WebSocket's readyState numbers: noVNC compares the channel's against them.
const OPEN = 1
const CLOSED = 3
/** Bytes a leg holds before noVNC attaches. A handshake needs a few dozen: the server waits for the viewer's reply. */
const HELD_MAX = 4 * 1024 * 1024
/** The server closes a socket with 16 requests outstanding; releasing control and unwatching never wait on this. */
const PENDING_MAX = 12
/** A leg that lived this long was not part of a reconnect loop. */
const STEADY_MS = 10_000
const REWATCH_MAX = 5

/** The WebSocket-like object noVNC's RFB takes as its channel: one RFB leg of the shared `/ws/desktop` socket. */
export interface RfbChannel {
  binaryType: string
  readonly protocol: string
  readonly readyState: number
  onopen: ((e: Event) => void) | null
  onmessage: ((e: { data: ArrayBuffer }) => void) | null
  onclose: ((e: { code: number; reason: string; wasClean: boolean }) => void) | null
  onerror: ((e: Event) => void) | null
  send(data: ArrayBuffer | ArrayBufferView<ArrayBuffer>): void
  close(): void
}

export interface DesktopClient {
  /** One watch per socket: a new one replaces the old at the server. */
  watch(target: DesktopTarget): Promise<void>
  unwatch(): void
  /** What is watched or being watched now; null after an unwatch, a refusal or a lost socket. */
  watching(): DesktopTarget | null
  /** Releasing never throws: a closed socket already released control at the server. */
  takeControl(on: boolean): Promise<void>
  /** A card's I'm done or Cancel; needs no watch, so it works without the live view. */
  answer(target: DesktopTarget, requestId: string, decision: 'done' | 'cancel'): Promise<void>
  /** Statuses of the current watch; null when the client gave a watch up itself (a re-watch after a dropped leg failed). */
  onStatus(cb: (status: DesktopStatus | null) => void): () => void
  onRfb(cb: (state: 'open' | 'closed', generation: string) => void): () => void
  /** The current leg's channel while it is open. */
  channel(): RfbChannel | null
  close(): void
}

type Body = DesktopRequest extends infer R ? (R extends DesktopRequest ? Omit<R, 'id'> : never) : never
interface Pending {
  resolve(): void
  reject(error: Error): void
  watch: number | null
}
type Channel = ReturnType<typeof createChannel>
/** A leg on the wire, from its `rfb open` to its `rfb closed`; a stale watch's leg has no channel and its bytes go nowhere. */
interface Leg {
  watchId: number
  generation: string
  opened: number
  channel: Channel | null
}

function createChannel(o: { send(data: ArrayBuffer | ArrayBufferView<ArrayBuffer>): void; closed(): void }) {
  let readyState = OPEN,
    handler: RfbChannel['onmessage'] = null,
    held: ArrayBuffer[] = [],
    heldBytes = 0,
    flushing = false,
    ended = false
  const finish = (): void => {
    if (ended) return
    ended = true
    channel.onclose?.({ code: 1000, reason: '', wasClean: true })
  }
  const flush = (): void => {
    flushing = false
    while (held.length && handler && readyState === OPEN) {
      const data = held.shift()!
      heldBytes -= data.byteLength
      handler({ data })
    }
  }
  // Never from inside the setter: noVNC sets onmessage first and finishes attaching before it can read anything.
  const later = (): void => {
    if (!flushing) {
      flushing = true
      queueMicrotask(flush)
    }
  }
  const channel: RfbChannel = {
    binaryType: 'arraybuffer',
    protocol: '',
    get readyState() {
      return readyState
    },
    onopen: null,
    onclose: null,
    onerror: null,
    get onmessage() {
      return handler
    },
    set onmessage(fn) {
      handler = fn
      if (fn && held.length) later()
    },
    send(data) {
      if (readyState === OPEN) o.send(data)
    },
    close() {
      if (readyState === CLOSED) return
      readyState = CLOSED
      held = []
      heldBytes = 0
      o.closed()
      // A WebSocket reports its close later, not inside close().
      queueMicrotask(finish)
    }
  }
  return {
    channel,
    receive(data: ArrayBuffer): void {
      if (readyState !== OPEN) return
      if (handler && !held.length) {
        handler({ data })
        return
      }
      heldBytes += data.byteLength
      if (heldBytes > HELD_MAX) {
        channel.close()
        return
      }
      held.push(data)
      if (handler) later()
    },
    /** The server ended the leg: no bytes of it follow. */
    end(): void {
      readyState = CLOSED
      held = []
      heldBytes = 0
      finish()
    }
  }
}

/** The viewer's socket: watch requests and statuses as JSON, the current leg's RFB bytes as binary frames. */
export function createDesktopClient(o: {
  url: string
  socket?(url: string): WebSocket
  onSignedOut?(): void
  onConnection?(connected: boolean): void
}): DesktopClient {
  let socket: WebSocket | null = null,
    closed = false,
    signedOut = false,
    connected = false,
    nextId = 1,
    attempt = 0
  let retry: ReturnType<typeof setTimeout> | undefined, rewatch: ReturnType<typeof setTimeout> | undefined
  // `watchId` is the watch whose messages count; `live` says the server holds some watch for this socket.
  let watchId: number | null = null,
    target: DesktopTarget | null = null,
    status: DesktopStatus | null = null,
    live = false
  let leg: Leg | null = null,
    drops = 0,
    epoch = 0
  let opening: Array<{ resolve(): void; reject(e: Error): void }> = []
  const pending = new Map<number, Pending>()
  const statusSubs = new Set<(status: DesktopStatus | null) => void>()
  const rfbSubs = new Set<(state: 'open' | 'closed', generation: string) => void>()
  const emitStatus = (s: DesktopStatus | null): void => {
    for (const cb of [...statusSubs]) cb(s)
  }
  const emitRfb = (state: 'open' | 'closed', generation: string): void => {
    for (const cb of [...rfbSubs]) cb(state, generation)
  }

  const send = (body: Body, id: number, opts: { always?: boolean; watch?: number | null } = {}): Promise<void> => {
    if (!connected || !socket) return Promise.reject(new Error(NOT_CONNECTED))
    if (!opts.always && pending.size >= PENDING_MAX) return Promise.reject(new Error('Desktop connection is busy'))
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject, watch: opts.watch ?? null })
      try {
        socket!.send(JSON.stringify({ id, ...body }))
      } catch {
        pending.delete(id)
        reject(new Error(NOT_CONNECTED))
      }
    })
  }
  const stopRewatch = (): void => {
    clearTimeout(rewatch)
    rewatch = undefined
  }
  /** Forget the current watch locally; its pending requests can no longer matter to the caller. */
  const retire = (): void => {
    const old = watchId
    stopRewatch()
    epoch++
    watchId = null
    target = null
    status = null
    if (old === null) return
    for (const [id, p] of pending)
      if (p.watch === old) {
        pending.delete(id)
        p.reject(new Error('Desktop view closed'))
      }
  }
  /** The leg on the wire ended. The caller hears first, so a noVNC failing on the close finds no current leg. */
  const endLeg = (): Leg | null => {
    const old = leg
    leg = null
    if (old?.channel) {
      emitRfb('closed', old.generation)
      old.channel.end()
    }
    return old
  }
  const sendBinary = (handle: Channel, data: ArrayBuffer | ArrayBufferView<ArrayBuffer>): void => {
    // One noVNC send is one frame: the server expects a leg's version line as a frame of its own.
    if (leg?.channel !== handle || !connected || !socket) return
    try {
      socket.send(data)
    } catch {
      /* The socket's close handler cleans up. */
    }
  }
  const openLeg = (id: number, generation: string): void => {
    endLeg()
    const current = id === watchId
    const handle: Channel | null = current
      ? createChannel({
          send: (data) => sendBinary(handle!, data),
          // noVNC gave up on this leg (a failure, or its view went away): stop streaming what nobody shows.
          closed: () => {
            if (leg?.channel === handle && leg.watchId === watchId) client.unwatch()
          }
        })
      : null
    leg = { watchId: id, generation, opened: Date.now(), channel: handle }
    if (current) emitRfb('open', generation)
  }
  const closeLeg = (id: number): void => {
    if (!leg || leg.watchId !== id) return
    const ended = endLeg()!
    // Xvnc dropping only this connection leaves the desktop ready on the same generation; a new watch gets a new leg.
    if (ended.channel && ended.watchId === watchId && status?.state === 'ready' && status.generation === ended.generation)
      scheduleRewatch(ended)
  }
  const scheduleRewatch = (ended: Leg): void => {
    drops = Date.now() - ended.opened >= STEADY_MS ? 1 : drops + 1
    if (drops > REWATCH_MAX) {
      client.unwatch()
      emitStatus(null)
      return
    }
    const id = watchId,
      again = target!,
      generation = ended.generation
    stopRewatch()
    rewatch = setTimeout(
      () => {
        rewatch = undefined
        // A stopping desktop ends the leg just before its status says so: only a leg lost on a running desktop comes back.
        if (watchId !== id || leg !== null || status?.state !== 'ready' || status.generation !== generation) return
        void watch(again, true).catch(() => {
          if (watchId === null && target === null) emitStatus(null)
        })
      },
      defaultBackoff(drops - 1)
    )
  }
  const message = (data: unknown): void => {
    if (typeof data !== 'string') {
      const bytes = data instanceof ArrayBuffer ? data : data instanceof Uint8Array ? data.slice().buffer : null
      if (bytes) leg?.channel?.receive(bytes)
      return
    }
    let msg: DesktopServerMessage
    try {
      msg = JSON.parse(data)
    } catch {
      return
    }
    if (!msg || typeof msg !== 'object') return
    if (msg.type === 'response') {
      const p = pending.get(msg.id)
      if (!p) return
      pending.delete(msg.id)
      if (msg.ok) p.resolve()
      else p.reject(new Error(typeof msg.error === 'string' ? msg.error : 'Desktop request failed'))
    } else if (msg.type === 'status') {
      // A status of an earlier watch was in flight when it was replaced.
      if (watchId === null || msg.watchId !== watchId) return
      status = msg.status
      emitStatus(msg.status)
    } else if (msg.type === 'rfb') {
      if (msg.state === 'open') openLeg(msg.watchId, msg.generation)
      else closeLeg(msg.watchId)
    }
  }
  const connect = (): void => {
    if (socket || closed || signedOut) return
    const ws = (o.socket ?? ((url) => new WebSocket(url)))(o.url)
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
      if (socket === ws && !closed) message(e.data)
    }
    ws.onclose = (e) => {
      if (socket !== ws) return
      socket = null
      connected = false
      // The server drops a closed socket's watch and releases its control.
      live = false
      retire()
      endLeg()
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

  const watch = async (t: DesktopTarget, automatic: boolean): Promise<void> => {
    retire()
    // Only the client's own re-watches count toward giving up: a Retry or another view starts over.
    if (!automatic) drops = 0
    target = t
    const before = epoch
    await ready()
    if (before !== epoch || closed) throw new Error('Desktop view closed')
    const id = nextId++
    watchId = id
    live = true
    try {
      await send({ op: 'watch', target: t }, id, { watch: id })
    } catch (error) {
      if (watchId === id) {
        retire()
        live = false
      }
      throw error
    }
  }

  const client: DesktopClient = {
    watch: (t) => watch(t, false),
    unwatch() {
      const wasLive = live
      retire()
      live = false
      if (wasLive && connected) void send({ op: 'unwatch' }, nextId++, { always: true }).catch(() => {})
    },
    watching() {
      return target
    },
    async takeControl(on) {
      if (!on) {
        if (closed || !connected) return
        try {
          await send({ op: 'releaseControl' }, nextId++, { always: true })
        } catch {
          /* A closed socket released control already. */
        }
        return
      }
      if (watchId === null) throw new Error('Open the desktop view first')
      await send({ op: 'takeControl' }, nextId++, { watch: watchId })
    },
    async answer(t, requestId, decision) {
      await ready()
      await send({ op: 'answer', target: t, requestId, decision }, nextId++)
    },
    onStatus(cb) {
      statusSubs.add(cb)
      return () => {
        statusSubs.delete(cb)
      }
    },
    onRfb(cb) {
      rfbSubs.add(cb)
      return () => {
        rfbSubs.delete(cb)
      }
    },
    channel() {
      const ch = leg?.channel?.channel
      return ch && ch.readyState === OPEN ? ch : null
    },
    close() {
      closed = true
      clearTimeout(retry)
      live = false
      retire()
      endLeg()
      for (const p of pending.values()) p.reject(new Error('Desktop connection closed'))
      pending.clear()
      for (const p of opening) p.reject(new Error('Desktop connection closed'))
      opening = []
      const ws = socket
      socket = null
      connected = false
      ws?.close()
    }
  }
  return client
}
