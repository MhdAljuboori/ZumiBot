// The /ws/desktop viewer socket. Text frames are JSON requests and server messages; binary frames are the RFB
// bytes of the current leg, one leg per desktop generation the watch is attached to. Client bytes pass the RFB
// filter, so input from a viewer without control never reaches Xvnc. The VNC socket path stays on the server.
import { randomUUID } from 'node:crypto'
import { createConnection, type Socket } from 'node:net'
import type { WebSocket } from 'ws'
import { CLOSE_SIGNED_OUT } from '@zumibot/shared/rpc'
import { boundDesktopStatus, parseDesktopRequest, type DesktopRequest, type DesktopServerMessage } from '@zumibot/shared/desktop'
import type { DesktopManager, DesktopSubscription } from '../core/desktop/desktopManager'
import { RfbClientFilter } from '../core/desktop/rfbFilter'

export interface DesktopHub {
  attach(ws: WebSocket, sessionKey: string): void
  closeSession(key: string | 'all'): void
  drain(): void
  closeAll(code: number): void
  dispose(): void
}
type Leg = { generation: string; sock: Socket; filter: RfbClientFilter; started: boolean }
type Watch = {
  /** The id of the request that made it; status and rfb messages carry it so the client can drop stale ones. */
  watchId: number
  viewerId: string
  abort: AbortController
  subscription?: DesktopSubscription
  profileId?: string
  leg?: Leg
  /** Set by releaseControl on receipt, so input after it is dropped even before the manager hears of it. */
  inputOff: boolean
  ready: Promise<void>
  settle(): void
}
type Client = {
  ws: WebSocket
  key: string
  dead: boolean
  missed: number
  lastId: number
  pending: Set<number>
  watch?: Watch
  answers: Set<AbortController>
  window: number
  commands: number
  pressure?: number
  relief?: ReturnType<typeof setInterval>
  /** When the session was last checked, from any path. */
  checked: number
  /** Control requests: each reaches the manager, then is answered, after the one received before it. */
  admission: Promise<void>
  answered: Promise<void>
}
type Outcome = { ok: true } | { ok: false; error: string }
// RFB bytes cannot be dropped like frames, so a slow viewer's leg pauses at this mark (Xvnc keeps the rest).
const HIGH_WATER = 4 * 1024 * 1024
const STALL_MS = 10000
const RELIEF_MS = 100
const REQUEST_BYTES = 64 * 1024
/** One RFB frame: room for a 1 MiB clipboard paste with its 8-byte cut-text header. */
export const DESKTOP_FRAME_BYTES = 1024 * 1024 + 8
const INPUT_CHECK_MS = 1000
const CONTROLLED = 'Desktop is controlled in another window'
const DENIED = 'Desktop request denied or unavailable'
const OK: Outcome = { ok: true },
  DENY: Outcome = { ok: false, error: DENIED }
// The viewer's version line starts with 'R'; no later client RFB message does.
const VERSION_START = 0x52

/** Caller identity comes only from the authenticated upgrade. Every watch and every answer gets a new server-made viewer. */
export function createDesktopHub(o: {
  manager: Pick<DesktopManager, 'watch' | 'connect' | 'takeControl' | 'releaseControl' | 'answer' | 'canInput'>
  isValid(key: string): Promise<boolean>
  now?: () => number
  pingMs?: number
}): DesktopHub {
  const clients = new Set<Client>(),
    now = o.now ?? Date.now
  let draining = false
  const current = (c: Client, w: Watch) => !c.dead && c.watch === w && !w.abort.signal.aborted
  function send(c: Client, message: DesktopServerMessage): void {
    // Never dropped under pressure: the client's leg and request state depend on every one, and they are small.
    if (c.dead || c.ws.readyState !== c.ws.OPEN) return
    c.ws.send(JSON.stringify(message), (error) => {
      if (error) drop(c, 1011)
    })
  }
  function reply(c: Client, id: number, ok: boolean, error = DENIED): void {
    send(c, ok ? { type: 'response', id, ok: true, value: null } : { type: 'response', id, ok: false, error })
  }
  function endLeg(c: Client, w: Watch, leg = w.leg): void {
    if (!leg || w.leg !== leg) return
    w.leg = undefined
    leg.sock.destroy()
    send(c, { type: 'rfb', watchId: w.watchId, state: 'closed', generation: leg.generation })
  }
  function stopWatch(c: Client): Promise<void> {
    const w = c.watch
    if (!w) return Promise.resolve()
    // The abort alone unregisters a viewer whose watch has not resolved yet.
    c.watch = undefined
    endLeg(c, w)
    w.abort.abort()
    w.settle()
    return w.subscription?.close().catch(() => undefined) ?? Promise.resolve()
  }
  function drop(c: Client, code: number): void {
    if (c.dead) return
    c.dead = true
    clients.delete(c)
    if (c.relief) clearInterval(c.relief)
    c.relief = undefined
    void stopWatch(c)
    for (const abort of c.answers) abort.abort()
    c.answers.clear()
    c.pending.clear()
    if (c.ws.readyState === c.ws.OPEN) c.ws.close(code)
    setTimeout(() => {
      if (c.ws.readyState !== c.ws.CLOSED) c.ws.terminate()
    }, 2000).unref()
  }
  async function valid(c: Client): Promise<boolean> {
    c.checked = now()
    let ok = false
    try {
      ok = await o.isValid(c.key)
    } catch {
      /* Auth storage failures fail closed. */
    }
    if (!ok) drop(c, CLOSE_SIGNED_OUT)
    return ok && !c.dead && !draining
  }

  // ---- Server to viewer: backpressure pauses the leg, sustained pressure drops the viewer -------------

  function squeeze(c: Client): void {
    c.pressure ??= now()
    c.watch?.leg?.sock.pause()
    if (!c.relief) {
      c.relief = setInterval(() => relieve(c), RELIEF_MS)
      c.relief.unref()
    }
  }
  function relieve(c: Client): void {
    if (c.dead || c.pressure === undefined) return
    if (c.ws.bufferedAmount <= HIGH_WATER) {
      c.pressure = undefined
      if (c.relief) clearInterval(c.relief)
      c.relief = undefined
      c.watch?.leg?.sock.resume()
      return
    }
    // Only this viewer goes: its own unix connection was paused, so Xvnc and other viewers never waited on it.
    if (now() - c.pressure >= STALL_MS) drop(c, 1008)
  }
  function forward(c: Client, chunk: Buffer): void {
    if (c.ws.readyState !== c.ws.OPEN) return
    c.ws.send(chunk, (error) => {
      if (error) drop(c, 1011)
      else relieve(c)
    })
    if (c.ws.bufferedAmount > HIGH_WATER) squeeze(c)
  }
  /** The manager attached this watch to a generation's VNC socket: one leg, announced before any of its bytes. */
  function open(c: Client, w: Watch, vncSocket: string, generation: string): void {
    if (!current(c, w)) return
    endLeg(c, w)
    const leg: Leg = {
      generation: generation.slice(0, 128),
      sock: createConnection(vncSocket),
      started: false,
      filter: new RfbClientFilter({ canInput: () => !w.inputOff && o.manager.canInput(w.viewerId) })
    }
    w.leg = leg
    if (c.pressure !== undefined) leg.sock.pause()
    send(c, { type: 'rfb', watchId: w.watchId, state: 'open', generation: leg.generation })
    leg.sock.on('data', (chunk: Buffer) => {
      if (w.leg === leg && !c.dead) forward(c, chunk)
    })
    // Its error text names the socket path: neither logged nor sent.
    leg.sock.on('error', () => endLeg(c, w, leg))
    leg.sock.on('close', () => endLeg(c, w, leg))
  }

  // ---- Viewer to server: RFB bytes through the filter --------------------------------------------------

  function input(c: Client, bytes: Buffer): void {
    const w = c.watch,
      leg = w?.leg
    // No open leg: the bytes belong to one that already ended.
    if (!w || !leg || !current(c, w)) return
    if (!leg.started) {
      // A leg starts with the viewer's version line; anything else was sent to the previous leg.
      if (bytes[0] !== VERSION_START) return
      leg.started = true
    }
    // Heartbeats are 15 s apart: input re-checks the session at most once a second, without waiting for the answer.
    if (now() - c.checked >= INPUT_CHECK_MS) void valid(c)
    let result: ReturnType<RfbClientFilter['push']>
    try {
      result = leg.filter.push(bytes)
    } catch {
      drop(c, 1011)
      return
    }
    if (result.close) {
      drop(c, 1008)
      return
    }
    for (const chunk of result.forward) leg.sock.write(chunk)
    // Xvnc reads promptly; a viewer that gets this far ahead of it is not a person at a keyboard.
    if (leg.sock.writableLength > HIGH_WATER) drop(c, 1008)
  }

  // ---- Requests ---------------------------------------------------------------------------------------

  async function watch(
    c: Client,
    req: Extract<DesktopRequest, { op: 'watch' }>,
    w: Watch,
    stopped: Promise<void> | undefined
  ): Promise<Outcome> {
    await stopped
    if (!current(c, w)) return DENY
    try {
      const subscription = await o.manager.watch(req.target, {
        id: w.viewerId,
        sessionKey: c.key,
        signal: w.abort.signal,
        sendStatus(status) {
          if (!current(c, w)) return
          w.profileId = status.profileId
          send(c, { type: 'status', watchId: w.watchId, status: boundDesktopStatus(status) })
        },
        attach: (vncSocket, generation) => open(c, w, vncSocket, generation),
        detach: () => endLeg(c, w)
      })
      if (!current(c, w)) {
        await subscription.close()
        return DENY
      }
      w.subscription = subscription
      return OK
    } catch {
      if (current(c, w)) await stopWatch(c)
      return DENY
    }
  }
  async function answer(c: Client, req: Extract<DesktopRequest, { op: 'answer' }>, admit: () => void): Promise<Outcome> {
    const abort = new AbortController(),
      card = randomUUID()
    c.answers.add(abort)
    let subscription: DesktopSubscription | undefined, profileId: string | undefined
    try {
      // Authorizes the card's own target (agent, chat, request); an answer-only viewer starts and keeps alive nothing.
      subscription = await o.manager.connect(req.target, {
        id: card,
        sessionKey: c.key,
        signal: abort.signal,
        sendStatus(status) {
          profileId = status.profileId
        },
        attach() {},
        detach() {}
      })
      if (abort.signal.aborted || c.dead) return DENY
      // This window's own watch answers, so the manager releases its control first. Another window's control
      // makes the manager refuse; it is never taken or retried.
      const w = c.watch
      const viewerId = w && current(c, w) && w.subscription && w.profileId === profileId ? w.viewerId : card
      const answering = o.manager.answer(viewerId, req.requestId, req.decision)
      admit()
      await answering
      return OK
    } finally {
      abort.abort()
      await subscription?.close().catch(() => undefined)
      c.answers.delete(abort)
    }
  }
  /** `admit` lets the next control request through once this one has reached the manager. */
  async function run(
    c: Client,
    req: DesktopRequest,
    w: Watch | undefined,
    stopped: Promise<void> | undefined,
    admit: () => void
  ): Promise<Outcome> {
    switch (req.op) {
      case 'watch':
        return watch(c, req, w!, stopped)
      case 'unwatch':
        await stopped
        return OK
      case 'takeControl': {
        if (!w) return DENY
        await w.ready
        if (!current(c, w) || !w.subscription) return DENY
        const taking = o.manager.takeControl(w.viewerId)
        admit()
        await taking
        return current(c, w) ? OK : DENY
      }
      case 'releaseControl':
        // Releasing what is not held is not an error: an ended watch already gave its control back.
        if (w) {
          await w.ready
          if (w.subscription && !w.abort.signal.aborted) {
            const releasing = o.manager.releaseControl(w.viewerId).catch(() => undefined)
            admit()
            await releasing
          }
        }
        return OK
      case 'answer':
        return answer(c, req, admit)
    }
  }
  async function handle(c: Client, req: DesktopRequest, w: Watch | undefined, stopped: Promise<void> | undefined): Promise<void> {
    const authorization = valid(c)
    // Session checks finish in any order (VPS reads auth storage each time), so control requests queue: a later one
    // never reaches the manager, or is answered, before an earlier one. Watch and unwatch act on receipt instead.
    let admit = () => {},
      answered = () => {},
      turn = Promise.resolve(),
      earlier = Promise.resolve()
    if (req.op === 'takeControl' || req.op === 'releaseControl' || req.op === 'answer') {
      turn = c.admission
      c.admission = new Promise<void>((resolve) => {
        admit = resolve
      })
      earlier = c.answered
      c.answered = new Promise<void>((resolve) => {
        answered = resolve
      })
    }
    let outcome: Outcome | undefined
    try {
      await turn
      if (!(await authorization)) return
      outcome = await run(c, req, w, stopped, admit)
    } catch (error) {
      outcome = {
        ok: false,
        error: error instanceof Error && error.message === 'Desktop is controlled by another viewer' ? CONTROLLED : DENIED
      }
    } finally {
      admit()
      if (req.op === 'watch') w?.settle()
      await earlier
      if (outcome) reply(c, req.id, outcome.ok, outcome.ok ? undefined : outcome.error)
      answered()
      c.pending.delete(req.id)
    }
  }
  function request(c: Client, bytes: Buffer): void {
    if (now() - c.window >= 1000) {
      c.window = now()
      c.commands = 0
    }
    if (++c.commands > 60 || c.pending.size >= 16) {
      drop(c, 1008)
      return
    }
    let req: DesktopRequest
    try {
      req = parseDesktopRequest(JSON.parse(String(bytes)))
    } catch {
      let id = -1
      try {
        const raw = JSON.parse(String(bytes))
        if (Number.isSafeInteger(raw?.id) && raw.id > c.lastId) id = raw.id
      } catch {
        /* Malformed JSON has no correlation id. */
      }
      if (id >= 0) {
        c.lastId = id
        reply(c, id, false)
      } else drop(c, 1008)
      return
    }
    if (req.id <= c.lastId) {
      drop(c, 1008)
      return
    }
    c.lastId = req.id
    let w = c.watch,
      stopped: Promise<void> | undefined
    // Replacement and revocation take effect in receive order, before any asynchronous check.
    if (req.op === 'watch') {
      stopped = stopWatch(c)
      let settle!: () => void
      const ready = new Promise<void>((resolve) => {
        settle = resolve
      })
      w = { watchId: req.id, viewerId: randomUUID(), abort: new AbortController(), inputOff: false, ready, settle }
      c.watch = w
    } else if (req.op === 'unwatch') {
      stopped = stopWatch(c)
      w = undefined
    } else if (w && req.op === 'releaseControl') w.inputOff = true
    else if (w && req.op === 'takeControl') w.inputOff = false
    c.pending.add(req.id)
    void handle(c, req, w, stopped)
  }

  const timer = setInterval(() => {
    for (const c of clients) {
      if (c.missed >= 2) {
        drop(c, 1001)
        c.ws.terminate()
        continue
      }
      // A ping would queue behind the stalled bytes; the stall limit decides instead.
      if (c.pressure !== undefined) relieve(c)
      else {
        c.missed++
        c.ws.ping()
      }
      if (!c.dead) void valid(c)
    }
  }, o.pingMs ?? 15000)
  timer.unref()
  return {
    attach(ws, key) {
      // The upgrade has just checked the session.
      const c: Client = {
        ws,
        key,
        dead: false,
        missed: 0,
        lastId: -1,
        pending: new Set(),
        answers: new Set(),
        window: now(),
        commands: 0,
        checked: now(),
        admission: Promise.resolve(),
        answered: Promise.resolve()
      }
      clients.add(c)
      if (draining) {
        drop(c, 1001)
        return
      }
      ws.on('pong', () => {
        c.missed = 0
      })
      ws.on('close', () => drop(c, 1001))
      ws.on('error', () => {
        drop(c, 1011)
        ws.terminate()
      })
      ws.on('message', (data, binary) => {
        if (c.dead || draining || ws.readyState !== ws.OPEN) return
        const bytes = Buffer.isBuffer(data) ? data : Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data)
        if (bytes.byteLength > (binary ? DESKTOP_FRAME_BYTES : REQUEST_BYTES)) {
          drop(c, 1009)
          return
        }
        if (binary) input(c, bytes)
        else request(c, bytes)
      })
    },
    closeSession(key) {
      for (const c of clients) if (key === 'all' || c.key === key) drop(c, CLOSE_SIGNED_OUT)
    },
    drain() {
      draining = true
      for (const c of clients) {
        void stopWatch(c)
        for (const abort of c.answers) abort.abort()
      }
    },
    closeAll(code) {
      for (const c of clients) drop(c, code)
    },
    dispose() {
      clearInterval(timer)
      draining = true
      for (const c of clients) drop(c, 1001)
    }
  }
}
