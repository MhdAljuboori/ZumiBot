import { randomUUID } from 'node:crypto'
import type { WebSocket } from 'ws'
import { CLOSE_SIGNED_OUT } from '@zumibot/shared/rpc'
import { BROWSER_COMMAND_BYTES, boundBrowserStatus, encodeBrowserFrame, parseBrowserRequest } from '@zumibot/shared/browser'
import type { BrowserFrame, BrowserInput, BrowserRequest, BrowserResponse, BrowserResult, BrowserStatus } from '@zumibot/shared/browser'
import type { BrowserManager, BrowserSubscription } from '../core/browser/types'

export interface BrowserHub {
  stageUpload(
    sessionKey: string,
    token: string,
    location: Pick<BrowserInput, 'generation' | 'tabId'>,
    source: AsyncIterable<Uint8Array>,
    name: string
  ): Promise<{ id: string; name: string; size: number }>
  attach(ws: WebSocket, sessionKey: string): void
  closeSession(key: string | 'all'): void
  drain(): void
  closeAll(code: number): void
  dispose(): void
}
type QueuedInput = { input: BrowserInput; ids: number[] }
type QueuedWork = QueuedInput | { navigation: Extract<BrowserRequest, { op: 'navigate' }>; ids: number[] }
type Watch = {
  watchId: number
  viewerId: string
  abort: AbortController
  subscription?: BrowserSubscription
  status?: BrowserStatus
  epoch: number
  controlling: boolean
  releasePending: boolean
  work: QueuedWork[]
  admission: Promise<void>
  inputTimer?: ReturnType<typeof setTimeout>
  flushing: boolean
  pendingFrame?: Uint8Array
  frameTimer?: ReturnType<typeof setTimeout>
  frameBusy: boolean
  lastFrame: number
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
  inputs: number
  commands: number
  pressure?: number
}
// Room for one whole frame in flight (frames are sent one at a time) before backpressure counts.
const HIGH_WATER = 4 * 1024 * 1024

/** Caller identity comes only from the authenticated upgrade. Every watch gets a new server-side viewer. */
export function createBrowserHub(o: {
  manager: BrowserManager
  isValid(key: string): Promise<boolean>
  now?: () => number
  pingMs?: number
}): BrowserHub {
  const clients = new Set<Client>(),
    now = o.now ?? Date.now
  let draining = false
  const current = (c: Client, w: Watch) => !c.dead && c.watch === w && !w.abort.signal.aborted
  function discardInputs(c: Client, w: Watch): void {
    w.epoch++
    w.controlling = false
    w.admission = Promise.resolve()
    if (w.inputTimer) clearTimeout(w.inputTimer)
    w.inputTimer = undefined
    for (const item of w.work.splice(0))
      for (const id of item.ids) {
        c.pending.delete(id)
        reply(c, id, false)
      }
  }
  function stopWatch(c: Client): Promise<void> {
    const w = c.watch
    if (!w) return Promise.resolve()
    c.watch = undefined
    discardInputs(c, w)
    w.abort.abort()
    if (w.frameTimer) clearTimeout(w.frameTimer)
    w.pendingFrame = undefined
    return w.subscription?.close().catch(() => undefined) ?? Promise.resolve()
  }
  function drop(c: Client, code: number): void {
    if (c.dead) return
    c.dead = true
    clients.delete(c)
    void stopWatch(c)
    for (const abort of c.answers) abort.abort()
    c.answers.clear()
    c.pending.clear()
    if (c.ws.readyState === c.ws.OPEN) c.ws.close(code)
    setTimeout(() => {
      if (c.ws.readyState !== c.ws.CLOSED) c.ws.terminate()
    }, 2000).unref()
  }
  function pressure(c: Client): boolean {
    if (c.ws.bufferedAmount <= HIGH_WATER) {
      c.pressure = undefined
      return false
    }
    c.pressure ??= now()
    if (now() - c.pressure >= 10000) drop(c, 1008)
    return true
  }
  function json(c: Client, message: BrowserResponse | { type: 'status'; watchId: number; status: BrowserStatus }): void {
    if (c.dead || c.ws.readyState !== c.ws.OPEN || pressure(c)) return
    c.ws.send(JSON.stringify(message), (error) => {
      if (error) drop(c, 1011)
    })
  }
  function reply(
    c: Client,
    id: number,
    ok: boolean,
    value: null | BrowserResult = null,
    error = 'Browser request denied or unavailable'
  ): void {
    json(c, ok ? { type: 'response', id, ok: true, value } : { type: 'response', id, ok: false, error })
  }
  async function valid(c: Client): Promise<boolean> {
    let ok = false
    try {
      ok = await o.isValid(c.key)
    } catch {
      /* Auth storage failures fail closed. */
    }
    if (!ok) drop(c, CLOSE_SIGNED_OUT)
    return ok && !c.dead && !draining
  }
  function frame(c: Client, w: Watch, f: BrowserFrame): void {
    if (
      !current(c, w) ||
      pressure(c) ||
      w.status?.state !== 'ready' ||
      f.generation !== w.status.generation ||
      f.tabId !== w.status.activeTabId
    )
      return
    try {
      w.pendingFrame = encodeBrowserFrame(w.watchId, f)
    } catch {
      return
    }
    flushFrame(c, w)
  }
  function flushFrame(c: Client, w: Watch): void {
    if (!current(c, w) || !w.pendingFrame || w.frameBusy || w.frameTimer) return
    if (pressure(c)) {
      w.pendingFrame = undefined
      return
    }
    const delay = 100 - (now() - w.lastFrame)
    if (delay > 0) {
      w.frameTimer = setTimeout(() => {
        w.frameTimer = undefined
        flushFrame(c, w)
      }, delay)
      w.frameTimer.unref()
      return
    }
    const bytes = w.pendingFrame
    w.pendingFrame = undefined
    w.frameBusy = true
    w.lastFrame = now()
    c.ws.send(bytes, (error) => {
      w.frameBusy = false
      if (error) drop(c, 1011)
      else flushFrame(c, w)
    })
  }
  function selected(c: Client, req: { watchId: number }): Watch {
    const w = c.watch
    if (!w || !current(c, w) || w.watchId !== req.watchId) throw new Error('Stale watch')
    return w
  }
  function checkStamp(w: Watch, generation: string, tabId: string): void {
    if (!w.status || w.status.state !== 'ready' || w.status.generation !== generation || w.status.activeTabId !== tabId)
      throw new Error('Stale browser')
  }
  function queueInput(c: Client, w: Watch, id: number, input: BrowserInput): void {
    checkStamp(w, input.generation, input.tabId)
    if (!w.controlling || w.status?.control !== 'you') throw new Error('Control required')
    // Manager also checks configured viewport dimensions before adapter dispatch.
    const previous = w.work.at(-1)
    if (
      previous &&
      'input' in previous &&
      previous.input.type === input.type &&
      previous.input.generation === input.generation &&
      previous.input.tabId === input.tabId &&
      (input.type === 'mouseMove' || input.type === 'wheel')
    ) {
      if (input.type === 'wheel' && previous.input.type === 'wheel') {
        input = {
          ...input,
          deltaX: Math.max(-10000, Math.min(10000, input.deltaX + previous.input.deltaX)),
          deltaY: Math.max(-10000, Math.min(10000, input.deltaY + previous.input.deltaY))
        }
      }
      previous.input = input
      previous.ids.push(id)
    } else w.work.push({ input, ids: [id] })
    if (!w.inputTimer && !w.flushing) {
      w.inputTimer = setTimeout(() => {
        w.inputTimer = undefined
        void flushWork(c, w)
      }, 8)
      w.inputTimer.unref()
    }
  }
  function queueNavigation(c: Client, w: Watch, req: Extract<BrowserRequest, { op: 'navigate' }>): void {
    if (!w.controlling || w.status?.control !== 'you') throw new Error('Control required')
    w.work.push({ navigation: req, ids: [req.id] })
    // Navigation is a barrier: drain earlier batched input before it, and later input after it.
    if (w.inputTimer) clearTimeout(w.inputTimer)
    w.inputTimer = undefined
    void flushWork(c, w)
  }
  async function flushWork(c: Client, w: Watch): Promise<void> {
    if (w.flushing) return
    w.flushing = true
    try {
      while (current(c, w) && w.controlling && w.work.length) {
        const item = w.work.shift()!,
          epoch = w.epoch
        let ok = false,
          value: null | BrowserResult = null
        try {
          if ((await valid(c)) && current(c, w) && epoch === w.epoch) {
            if ('input' in item) await o.manager.input(w.viewerId, item.input)
            else {
              const req = item.navigation
              const result = await o.manager.navigate(w.viewerId, req.command, { generation: req.generation, tabId: req.tabId })
              value = result.ok
                ? { ok: true, data: null }
                : { ok: false, code: result.code.slice(0, 128), message: result.message.slice(0, 512) }
            }
            ok = true
          }
        } catch {
          /* Bounded generic wire errors. */
        }
        for (const id of item.ids) {
          c.pending.delete(id)
          if (current(c, w) && epoch === w.epoch) reply(c, id, ok, value)
        }
      }
    } finally {
      w.flushing = false
    }
  }
  async function handle(c: Client, req: BrowserRequest, initial?: Watch, epoch?: number, stopped?: Promise<void>): Promise<void> {
    const authorization = valid(c)
    let releaseAdmission: (() => void) | undefined,
      queued = false
    if ((req.op === 'input' || req.op === 'navigate') && initial) {
      // Checks start independently, but admission follows receive order within this watch epoch.
      const preceding = initial.admission
      initial.admission = new Promise<void>((resolve) => {
        releaseAdmission = resolve
      })
      await preceding
    }
    try {
      if (!(await authorization)) return
      if (req.op === 'watch') {
        // Install the lifetime before any asynchronous target lookup or launch.
        const w = initial!
        await stopped
        if (!current(c, w)) return
        try {
          const subscription = await o.manager.watch(req.target, {
            id: w.viewerId,
            sessionKey: c.key,
            signal: w.abort.signal,
            sendStatus(status) {
              if (!current(c, w)) return
              if (w.controlling && status.control !== 'you') discardInputs(c, w)
              if (w.status?.generation !== status.generation || w.status.activeTabId !== status.activeTabId || status.state !== 'ready')
                w.pendingFrame = undefined
              w.status = { ...boundBrowserStatus(status), uploadToken: w.viewerId }
              w.controlling = status.control === 'you' && !w.releasePending
              json(c, { type: 'status', watchId: w.watchId, status: w.status })
            },
            sendFrame: (f) => frame(c, w, f)
          })
          if (!current(c, w)) {
            await subscription.close()
            return
          }
          w.subscription = subscription
          reply(c, req.id, true)
        } catch {
          if (current(c, w)) {
            await stopWatch(c)
            reply(c, req.id, false)
          }
        }
        return
      }
      if (req.op === 'answer') {
        const abort = new AbortController(),
          viewerId = randomUUID()
        c.answers.add(abort)
        let subscription: BrowserSubscription | undefined, profileId: string | undefined
        try {
          subscription = await o.manager.connect(
            req.target,
            {
              id: viewerId,
              sessionKey: c.key,
              signal: abort.signal,
              sendStatus(status) {
                profileId = status.profileId
              },
              sendFrame() {}
            },
            { frames: false }
          )
          if (!(await valid(c)) || abort.signal.aborted) return
          const active = c.watch
          const answerId = active && current(c, active) && active.status?.profileId === profileId ? active.viewerId : viewerId
          // Manager validates the pending request before releasing that viewer's control.
          await o.manager.answer(answerId, req.requestId, req.decision)
          reply(c, req.id, true)
        } finally {
          abort.abort()
          await subscription?.close()
          c.answers.delete(abort)
        }
        return
      }
      if (req.op === 'unwatch') {
        if (!initial || initial.watchId !== req.watchId) throw new Error('Stale watch')
        await stopped
        reply(c, req.id, true)
        return
      }
      const w = selected(c, req)
      if (req.op === 'viewport') {
        // Any visible viewer may size the page; control only decides whose size wins, so no input epoch applies.
        await o.manager.resize(w.viewerId, { width: req.width, height: req.height, scale: req.scale })
        if (current(c, w)) reply(c, req.id, true)
        return
      }
      if (initial !== w || epoch !== w.epoch) return
      if (req.op === 'input') {
        queueInput(c, w, req.id, req.input)
        queued = true
        return
      }
      checkStamp(w, req.generation, req.tabId)
      if (req.op === 'takeControl') {
        w.releasePending = false
        await o.manager.takeControl(w.viewerId)
      } else if (req.op === 'releaseControl') {
        await o.manager.releaseControl(w.viewerId)
      } else if (req.op === 'navigate') {
        queueNavigation(c, w, req)
        queued = true
        return
      }
      if (current(c, w) && epoch === w.epoch) reply(c, req.id, true)
    } catch (error) {
      if (initial && req.op !== 'unwatch' && (!current(c, initial) || epoch !== initial.epoch)) return
      reply(
        c,
        req.id,
        false,
        null,
        error instanceof Error && error.message === 'Browser is controlled by another viewer'
          ? 'Browser is controlled in another window'
          : undefined
      )
    } finally {
      releaseAdmission?.()
      if (!queued) c.pending.delete(req.id)
    }
  }
  const timer = setInterval(() => {
    for (const c of clients) {
      if (c.missed >= 2) {
        drop(c, 1001)
        c.ws.terminate()
        continue
      }
      if (pressure(c)) continue
      c.missed++
      c.ws.ping()
      void valid(c)
    }
  }, o.pingMs ?? 10000)
  timer.unref()
  return {
    async stageUpload(key, token, location, source, name) {
      const c = [...clients].find((c) => c.key === key && c.watch?.viewerId === token)
      const w = c?.watch
      if (!c || !w || !(await valid(c)) || !current(c, w) || !w.controlling || w.status?.control !== 'you')
        throw new Error('Browser control required')
      checkStamp(w, location.generation, location.tabId)
      return o.manager.stageUpload(w.viewerId, location, source, name)
    },
    attach(ws, key) {
      const c: Client = {
        ws,
        key,
        dead: false,
        missed: 0,
        lastId: -1,
        pending: new Set(),
        answers: new Set(),
        window: now(),
        inputs: 0,
        commands: 0
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
        if ((Array.isArray(data) ? data.reduce((n, b) => n + b.byteLength, 0) : data.byteLength) > BROWSER_COMMAND_BYTES) {
          drop(c, 1009)
          return
        }
        if (binary) {
          drop(c, 1008)
          return
        }
        if (now() - c.window >= 1000) {
          c.window = now()
          c.inputs = 0
          c.commands = 0
        }
        if (++c.commands > 240) {
          drop(c, 1008)
          return
        }
        let req: BrowserRequest
        try {
          req = parseBrowserRequest(JSON.parse(String(data)))
        } catch {
          let id = -1
          try {
            const raw = JSON.parse(String(data))
            if (Number.isSafeInteger(raw.id) && raw.id >= 0) id = raw.id
          } catch {
            /* Malformed JSON has no correlation ID. */
          }
          if (id >= 0) reply(c, id, false)
          else drop(c, 1008)
          return
        }
        if (req.id <= c.lastId) {
          drop(c, 1008)
          return
        }
        c.lastId = req.id
        if (req.op === 'input') c.inputs++
        // Revocation must clear queued typing even when ordinary command slots are full.
        const revoke = req.op === 'releaseControl' || req.op === 'unwatch'
        if (c.inputs > 120 || c.pending.size >= 128 || (req.op !== 'input' && !revoke && c.pending.size >= 16)) {
          drop(c, 1008)
          return
        }
        let w = c.watch,
          stopped: Promise<void> | undefined
        if (req.op === 'watch') {
          stopped = stopWatch(c)
          w = {
            watchId: req.id,
            viewerId: randomUUID(),
            abort: new AbortController(),
            epoch: 0,
            controlling: false,
            releasePending: false,
            work: [],
            admission: Promise.resolve(),
            flushing: false,
            frameBusy: false,
            lastFrame: -Infinity
          }
          c.watch = w
        }
        // Revoke queued input synchronously; an auth check must not reorder release behind it.
        if ((req.op === 'releaseControl' || req.op === 'unwatch') && w?.watchId === req.watchId) {
          w.releasePending = true
          discardInputs(c, w)
          if (req.op === 'unwatch') stopped = stopWatch(c)
        }
        const epoch = w?.epoch
        c.pending.add(req.id)
        void handle(c, req, w, epoch, stopped)
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
