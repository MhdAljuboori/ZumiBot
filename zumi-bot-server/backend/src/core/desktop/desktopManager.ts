// Owns the agent desktops: lazy start, the server-wide cap and its fair queue, one turn at a time per desktop
// (BrowserLeases), Take control, handoffs (BrowserHandoffs), idle stop and crash restarts. Modelled on
// BrowserManager without tabs, viewports, frames or files; the picture reaches viewers as VNC, which the
// viewer socket relays itself once told where (`attach`). What the agent last saw lives in DesktopObservations.
import { promises as fs } from 'node:fs'
import {
  boundDesktopStatus,
  type DesktopCommand,
  type DesktopConfig,
  type DesktopHandoff,
  type DesktopOwner,
  type DesktopResult,
  type DesktopStamp,
  type DesktopStatus,
  type DesktopTarget
} from '@zumibot/shared/desktop'
import { BrowserHandoffs } from '../browser/browserHandoffs'
import { BrowserLeases, BrowserQueueTimeout, browserTimers, type BrowserTimers } from '../browser/browserLeases'
import type { BrowserProfile, BrowserProfileStore } from '../browser/profileStore'
import { DesktopObservations } from './desktopObservation'
import { boundDesktopResult, cuaPlan, shapeResult, type CuaCall } from './desktopTools'
import { DesktopLaunchCleanupError, DesktopUnavailableError, type CuaResult, type DesktopAdapter, type DesktopInstance } from './types'

export interface DesktopViewer {
  id: string
  sessionKey: string
  signal?: AbortSignal
  sendStatus(status: DesktopStatus): void
  /** Connect to this generation's VNC socket; called again with each new generation while the viewer watches. */
  attach(vncSocket: string, generation: string): void
  /** Once per attach, when it ends: the desktop stopped, crashed or was cleared, or the subscription closed. */
  detach(): void
}
export interface DesktopSubscription {
  close(): Promise<void>
}
export interface DesktopManagerDependencies {
  profiles: BrowserProfileStore
  adapter: DesktopAdapter
  config: DesktopConfig
  now: () => number
  newId: () => string
  resolveTarget: (target: DesktopTarget) => Promise<BrowserProfile & { agent: string }>
  onHandoff: (handoff: DesktopHandoff) => Promise<void>
  timers?: BrowserTimers
  /** Fixed sentences naming at most the agent; defaults to console.error. */
  log?: (line: string) => void
}

/** `watching` is false for an answer-only card: it gets statuses and may answer, nothing else. */
type Viewer = {
  viewer: DesktopViewer
  entry: Entry
  watching: boolean
  controller: AbortController
  attached?: string
  takeover?: Promise<void>
  releasing?: Promise<void>
  detachAbort?: () => void
  disconnecting?: Promise<void>
}
type Demand = { resolve: (instance: DesktopInstance) => void; reject: (error: Error) => void }
type Entry = BrowserProfile & {
  agent: string
  state: DesktopStatus['state']
  instance?: DesktopInstance
  invalid: boolean
  abort: AbortController
  demands: Demand[]
  busy: number
  viewers: Set<Viewer>
  control?: Viewer
  pausing: boolean
  idle?: ReturnType<typeof setTimeout>
  closing?: Promise<void>
  launching?: Promise<void>
  unsubscribe?: () => void
  error: string | null
  missing?: string[]
  seen: DesktopObservations
  reportedBusy: boolean
  /** A close could not be confirmed (logged once); `closeRound` is the demand round of the last close attempt. */
  stuck: boolean
  closeRound: number
}

/** A refusal the agent gets as `code`; the message is fixed text, never host detail. */
class Refusal extends Error {
  constructor(
    readonly code: string,
    message: string
  ) {
    super(message)
  }
}
const failure = (code: string, message: string): DesktopResult => ({ ok: false, code, message })
const STALE = failure('stale', 'The desktop changed; take a new screenshot')
const WAITING = failure('waiting_for_user', 'The desktop is waiting for the user')
const CANCELLED = failure('cancelled', 'Desktop request cancelled')
const BUSY = 'The desktop is busy; try again later'
const UNAVAILABLE = 'Desktop unavailable on this server'
const NOT_STARTED = 'The desktop could not be started'
const hasStamp = (command: DesktopCommand): command is Extract<DesktopCommand, { stamp: DesktopStamp }> => 'stamp' in command

/** BrowserHandoffs words its results for the browser; the agent should read "desktop". */
function handoffResult(result: DesktopResult): DesktopResult {
  if (result.ok) return result
  const status = result.code.replace(/^handoff_/, '')
  return failure(result.code, status === 'pending' ? 'A desktop request is already pending' : `Desktop request ${status}`)
}

export class DesktopManager {
  private readonly entries = new Map<string, Entry>()
  private readonly viewers = new Map<string, Viewer>()
  private readonly turns = new Map<string, AbortController>()
  private readonly leases: BrowserLeases
  private readonly handoffs: BrowserHandoffs
  private readonly timers: BrowserTimers
  private readonly log: (line: string) => void
  private readonly queue: Entry[] = []
  /** Grows with every new demand, so a stuck close is retried at most once per demand. */
  private demandRound = 0
  private closed = false
  constructor(private readonly deps: DesktopManagerDependencies) {
    this.timers = deps.timers ?? browserTimers
    this.log = deps.log ?? ((line) => console.error(line))
    this.leases = new BrowserLeases({
      leaseIdleMs: deps.config.leaseIdleMs,
      queueMs: deps.config.queueMs,
      timers: this.timers,
      onIdle: (id) => {
        const entry = this.entries.get(id)
        if (entry) {
          this.reportBusy(entry)
          this.touch(entry)
        }
      }
    })
    this.handoffs = new BrowserHandoffs({
      idleMs: deps.config.handoffIdleMs,
      now: deps.now,
      newId: deps.newId,
      agent: (id) => this.entries.get(id)?.agent ?? '',
      timers: this.timers,
      onHandoff: async (handoff) => {
        await deps.onHandoff(handoff)
        const entry = this.entries.get(handoff.profileId)
        if (entry) this.broadcast(entry)
      }
    })
  }
  registerTurn(turnId: string, callback: (handoff: DesktopHandoff) => Promise<void>): () => void {
    return this.handoffs.registerTurn(turnId, callback)
  }

  // ---- Status --------------------------------------------------------------------------------

  private entry(profile: BrowserProfile & { agent: string }): Entry {
    let entry = this.entries.get(profile.id)
    if (!entry) {
      entry = {
        ...profile,
        state: 'stopped',
        invalid: false,
        abort: new AbortController(),
        demands: [],
        busy: 0,
        viewers: new Set(),
        pausing: false,
        error: null,
        seen: new DesktopObservations(),
        reportedBusy: false,
        stuck: false,
        closeRound: -1
      }
      this.entries.set(profile.id, entry)
    }
    return entry
  }
  /** A pending handoff is the user's turn ('Waiting for you'); no agent call runs while it is pending. */
  private busy(entry: Entry): boolean {
    return !this.handoffs.pendingId(entry.id) && (entry.busy > 0 || this.leases.hasDemand(entry.id))
  }
  private watched(entry: Entry): boolean {
    return [...entry.viewers].some((viewer) => viewer.watching)
  }
  private statusOf(entry: Entry, viewer?: Viewer): DesktopStatus {
    return boundDesktopStatus({
      agent: entry.agent,
      profileId: entry.id,
      generation: entry.instance?.generation ?? '',
      state: entry.state,
      // Only the controller sees its own pause; everyone else is told another window has control.
      control: entry.control && entry.control !== viewer ? 'other' : entry.pausing ? 'pausing' : entry.control ? 'you' : 'agent',
      pendingRequestId: this.handoffs.pendingId(entry.id),
      error: entry.error,
      width: this.deps.config.width,
      height: this.deps.config.height,
      busy: this.busy(entry),
      ...(entry.state === 'unavailable' && entry.missing ? { missing: entry.missing } : {})
    })
  }
  async status(agent: string): Promise<DesktopStatus> {
    return this.statusOf(this.entry({ agent, ...(await this.deps.profiles.ensure(agent)) }))
  }
  private broadcast(entry: Entry): void {
    entry.reportedBusy = this.busy(entry)
    for (const viewer of entry.viewers) {
      try {
        viewer.viewer.sendStatus(this.statusOf(entry, viewer))
      } catch {
        /* A socket failure cannot break process ownership. */
      }
    }
  }
  /** Viewers hear when a turn starts or stops holding the desktop, not about every call. */
  private reportBusy(entry: Entry): void {
    if (this.busy(entry) !== entry.reportedBusy) this.broadcast(entry)
  }

  // ---- Processes: cap, queue, idle stop, crashes -------------------------------------------------

  private idle(entry: Entry): boolean {
    return (
      !entry.busy &&
      !entry.control &&
      !entry.pausing &&
      !entry.demands.length &&
      !this.watched(entry) &&
      !this.handoffs.pendingId(entry.id) &&
      !this.leases.hasDemand(entry.id)
    )
  }
  private touch(entry: Entry): void {
    if (entry.idle) this.timers.clearTimeout(entry.idle)
    entry.idle = undefined
    if (entry.state === 'ready' && this.idle(entry)) {
      entry.idle = this.timers.setTimeout(() => {
        entry.idle = undefined
        if (this.idle(entry)) void this.stop(entry).catch(() => undefined)
      }, this.deps.config.idleMs)
    }
    this.pump()
  }
  private ensure(entry: Entry, signal: AbortSignal): Promise<DesktopInstance> {
    if (signal.aborted || this.closed || entry.invalid) return Promise.reject(new Refusal('cancelled', 'Desktop request cancelled'))
    if (entry.state === 'ready' && entry.instance) return Promise.resolve(entry.instance)
    // This agent's own stuck close is retried for its new demand; the slot stays reserved until a close is confirmed.
    if (entry.state === 'closing' && entry.instance && !entry.closing && !entry.launching) void this.stop(entry).catch(() => undefined)
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        this.timers.clearTimeout(timer)
        signal.removeEventListener('abort', abort)
        entry.demands = entry.demands.filter((d) => d !== demand)
      }
      const demand: Demand = {
        resolve: (instance) => {
          cleanup()
          resolve(instance)
        },
        reject: (error) => {
          cleanup()
          reject(error)
          this.touch(entry)
        }
      }
      const abort = () => demand.reject(new Refusal('cancelled', 'Desktop request cancelled'))
      const timer = this.timers.setTimeout(() => demand.reject(new Refusal('busy', BUSY)), this.deps.config.queueMs)
      signal.addEventListener('abort', abort, { once: true })
      entry.demands.push(demand)
      this.demandRound++
      if (!this.queue.includes(entry)) this.queue.push(entry)
      if (entry.state !== 'starting' && entry.state !== 'closing') entry.state = 'queued'
      this.broadcast(entry)
      this.pump()
    })
  }
  private pump(): void {
    if (this.closed) return
    for (let i = 0; i < this.queue.length;) {
      const entry = this.queue[i]
      if (!entry.demands.length || entry.invalid) {
        this.queue.splice(i, 1)
        if (entry.state === 'queued') {
          entry.state = 'stopped'
          this.broadcast(entry)
        }
        continue
      }
      if (entry.state === 'starting' || entry.state === 'closing') {
        i++
        continue
      }
      // Starting and closing desktops count: their processes still run.
      const slots = [...this.entries.values()].filter((e) => e.instance || e.state === 'starting' || e.state === 'closing').length
      if (slots >= this.deps.config.max) {
        this.free()
        return
      }
      this.queue.splice(i, 1)
      entry.state = 'starting'
      this.broadcast(entry)
      entry.launching = this.launch(entry)
    }
  }
  /** At the cap: free one slot for the queue, one stop at a time. */
  private free(): void {
    const entries = [...this.entries.values()]
    // A stop under way frees a slot or fails and pumps again: evicting more would cost two desktops for one demand.
    if (entries.some((e) => e.closing)) return
    // A close that could not be confirmed is retried once per new demand, before a healthy desktop is evicted.
    const stuck = entries.find((e) => e.state === 'closing' && e.instance && !e.launching && e.closeRound !== this.demandRound)
    const candidate = stuck ?? entries.find((e) => e.state === 'ready' && this.idle(e))
    if (candidate) void this.stop(candidate).catch(() => undefined)
  }
  private async launch(entry: Entry): Promise<void> {
    try {
      const instance = await this.deps.adapter.launch(entry.dir, this.deps.config, entry.abort.signal)
      entry.instance = instance
      entry.missing = undefined
      entry.seen.reset()
      if (entry.invalid || this.closed || !entry.demands.length) {
        await this.stop(entry)
        return
      }
      entry.state = 'ready'
      entry.error = null
      entry.unsubscribe = instance.onExit(() => {
        if (entry.instance === instance) this.crashed(entry)
      })
      for (const viewer of entry.viewers) this.attach(viewer)
      for (const demand of [...entry.demands]) demand.resolve(instance)
      this.broadcast(entry)
      this.touch(entry)
    } catch (error) {
      if (error instanceof DesktopLaunchCleanupError) {
        // Its processes may still run: logged once, closed again right away; the slot stays reserved until a close confirms it.
        entry.instance = error.instance
        entry.state = 'closing'
        entry.error = NOT_STARTED
        entry.stuck = true
        this.log(
          `Desktop for agent ${JSON.stringify(entry.agent)}: cleanup after a failed start could not be confirmed; its slot stays reserved`
        )
        void this.stop(entry).catch(() => undefined)
      } else if (error instanceof DesktopUnavailableError) {
        entry.state = 'unavailable'
        entry.missing = [...error.missing]
        entry.error = UNAVAILABLE
      } else if (!entry.instance) {
        entry.state = 'stopped'
        // A start aborted by Clear or removal is not a failure the user should see.
        if (!entry.invalid) entry.error = NOT_STARTED
      }
      const refusal =
        error instanceof DesktopUnavailableError ? new Refusal('unavailable', UNAVAILABLE) : new Refusal('start_failed', NOT_STARTED)
      for (const demand of [...entry.demands]) demand.reject(refusal)
      this.broadcast(entry)
    } finally {
      entry.launching = undefined
      this.pump()
    }
  }
  private stop(entry: Entry): Promise<void> {
    if (entry.closing) return entry.closing
    if (!entry.instance) return Promise.resolve()
    if (entry.idle) this.timers.clearTimeout(entry.idle)
    entry.idle = undefined
    // Unsubscribed first: a close() racing a crash teardown may still fire onExit, which must not re-enter.
    entry.state = 'closing'
    entry.unsubscribe?.()
    entry.unsubscribe = undefined
    entry.seen.reset()
    this.detachViewers(entry)
    this.broadcast(entry)
    const instance = entry.instance
    entry.closeRound = this.demandRound
    entry.closing = (async () => {
      let retry = false
      try {
        await instance.close()
        entry.instance = undefined
        entry.state = 'stopped'
        entry.stuck = false
      } catch {
        // An unconfirmed close keeps its capacity slot reserved: logged once, tried again right away,
        // then once per new demand at the cap (free) and on the next demand for this agent (ensure).
        entry.error = 'The desktop could not be stopped safely'
        if (!entry.stuck) {
          entry.stuck = true
          retry = true
          this.log(`Desktop for agent ${JSON.stringify(entry.agent)}: stopping could not be confirmed; its slot stays reserved`)
        }
        throw new Error(entry.error)
      } finally {
        entry.closing = undefined
        if (retry) void this.stop(entry).catch(() => undefined)
        this.broadcast(entry)
        this.pump()
      }
    })()
    return entry.closing
  }
  /** The adapter already cleaned up; the next call or watch starts a fresh generation. */
  private crashed(entry: Entry): void {
    entry.control = undefined
    entry.pausing = false
    this.leases.resume(entry.id)
    entry.error = 'The desktop stopped unexpectedly'
    void this.handoffs.invalidate(entry.id).catch(() => undefined)
    void this.stop(entry).catch(() => undefined)
  }
  private attach(viewer: Viewer): void {
    const instance = viewer.entry.instance
    if (!viewer.watching || !instance || viewer.entry.state !== 'ready' || viewer.attached === instance.generation) return
    viewer.attached = instance.generation
    try {
      viewer.viewer.attach(instance.vncSocket, instance.generation)
    } catch {
      /* The socket handles its own failure. */
    }
  }
  private detach(viewer: Viewer): void {
    if (viewer.attached === undefined) return
    viewer.attached = undefined
    try {
      viewer.viewer.detach()
    } catch {
      /* The socket handles its own failure. */
    }
  }
  private detachViewers(entry: Entry): void {
    for (const viewer of entry.viewers) this.detach(viewer)
  }

  // ---- Agent calls ----------------------------------------------------------------------------

  private turn(turnId: string): AbortController {
    let turn = this.turns.get(turnId)
    if (!turn) {
      turn = new AbortController()
      this.turns.set(turnId, turn)
    }
    return turn
  }
  async run(owner: DesktopOwner, command: DesktopCommand, signal: AbortSignal): Promise<DesktopResult> {
    if (this.closed) return failure('unavailable', 'Desktop service is closed')
    // Taken before any await, so an endTurn that runs meanwhile aborts this call's turn, not a fresh one.
    const turn = this.turn(owner.turnId).signal
    const profile = await this.deps.profiles.byId(owner.profileId).catch(() => null)
    if (!profile) return failure('stale_profile', 'Desktop profile no longer exists')
    if (this.closed) return failure('unavailable', 'Desktop service is closed')
    const entry = this.entry(profile),
      combined = AbortSignal.any([signal, turn, entry.abort.signal])
    if (command.op === 'release') {
      this.leases.release(owner)
      this.reportBusy(entry)
      return { ok: true, data: null }
    }
    if (this.handoffs.pendingId(entry.id)) return WAITING
    let release: (() => void) | undefined
    try {
      // While a viewer holds control the call waits without the queue limit: only Stop, turn end or release end it.
      const acquiring = this.leases.acquire(owner, combined, { untimedWhilePaused: true })
      this.reportBusy(entry)
      const lease = await acquiring.catch((error: Error) => {
        throw error instanceof BrowserQueueTimeout ? new Refusal('busy', BUSY) : new Refusal('cancelled', 'Desktop request cancelled')
      })
      release = lease.release
      if (this.handoffs.pendingId(entry.id)) return WAITING
      entry.busy++
      this.touch(entry)
      try {
        // A void stamp is refused before anything reaches cua, and before a stopped desktop is started again.
        if (hasStamp(command) && !(entry.state === 'ready' && entry.seen.isCurrent(command.stamp, entry.instance?.generation, lease.epoch)))
          return STALE
        const instance = await this.ensure(entry, combined)
        if (combined.aborted || entry.invalid) return CANCELLED
        if (command.op === 'requestUserAction') {
          // The pending handoff keeps the lease, but lets the user take control meanwhile.
          const unprotect = this.leases.protect(owner)
          const waiting = this.handoffs.request(owner, instance.generation, '', command.reason, combined)
          release()
          release = undefined
          try {
            return handoffResult(await waiting)
          } finally {
            // The agent must look again whatever the user did.
            unprotect()
            entry.seen.invalidate()
            this.broadcast(entry)
          }
        }
        return await this.execute(entry, instance, command, combined, lease.epoch)
      } finally {
        entry.busy--
        this.touch(entry)
      }
    } catch (error) {
      return error instanceof Refusal ? failure(error.code, error.message) : CANCELLED
    } finally {
      release?.()
      this.reportBusy(entry)
    }
  }
  private async execute(
    entry: Entry,
    instance: DesktopInstance,
    command: DesktopCommand,
    signal: AbortSignal,
    epoch: number
  ): Promise<DesktopResult> {
    // The parser refuses it too; a region without area has nothing to crop.
    if (command.op === 'zoom' && (command.x1 >= command.x2 || command.y1 >= command.y2))
      return failure('out_of_bounds', 'The zoom region is empty')
    const seen = entry.seen
    try {
      const result = await this.bounded(entry, signal, async (desktop, call, stop): Promise<DesktopResult> => {
        // cua needs a pid for every window tool; an id the agent got from an older list is looked up again once.
        if ('windowId' in command && !seen.knowsWindow(command.windowId))
          await this.refresh(desktop, 'list_windows', call, stop, (s) => seen.setWindows(s))
        if (command.op === 'launch' && !seen.knowsApp(command.name))
          await this.refresh(desktop, 'list_apps', call, stop, (s) => seen.setApps(s))
        // Bounds come from the running desktop's real size, not the parser's 1920x1080 ceiling.
        const plan = cuaPlan(command, seen.context({ width: this.deps.config.width, height: this.deps.config.height }))
        if ('error' in plan) return failure(plan.error.code, plan.error.message)
        const outputs = await this.calls(desktop, plan.calls, call, stop)
        seen.learn(command, outputs)
        const shaped = shapeResult(command, outputs)
        if (!shaped.ok || (command.op !== 'screenshot' && command.op !== 'windowState')) return shaped
        const stamp = seen.observe(
          this.deps.newId(),
          desktop.generation,
          epoch,
          outputs[outputs.length - 1].structuredContent,
          command.op === 'windowState'
        )
        return { ok: true, data: { ...(shaped.data as Record<string, unknown>), stamp } }
      })
      return boundDesktopResult(result)
    } catch (error) {
      // Stopped: whatever the call did may have landed, so the agent must look again.
      if (signal.aborted) {
        seen.invalidate()
        return CANCELLED
      }
      if (error instanceof Error && error.message === 'command_timeout')
        return failure('command_timeout', 'Desktop command did not complete')
      if (instance.isClosed() || entry.instance !== instance)
        return failure('desktop_restarted', 'The desktop restarted; take a new screenshot')
      return failure('command_failed', 'Desktop command did not complete')
    }
  }
  private async refresh(
    desktop: DesktopInstance,
    tool: string,
    call: AbortSignal,
    stop: AbortSignal,
    keep: (structured: Record<string, unknown> | null) => void
  ): Promise<void> {
    if (stop.aborted) throw new Error('cancelled')
    const out = await desktop.call(tool, {}, call)
    if (!out.isError) keep(out.structuredContent)
  }
  /** In order; one retry per call on its retry code; stops at the first failure, and before any call once stopped. */
  private async calls(desktop: DesktopInstance, calls: CuaCall[], call: AbortSignal, stop: AbortSignal): Promise<CuaResult[]> {
    const outputs: CuaResult[] = []
    for (const next of calls) {
      if (stop.aborted) throw new Error('cancelled')
      let out = await desktop.call(next.tool, next.args, call)
      if (out.isError && next.retry && out.structuredContent?.code === next.retry.onCode) {
        if (stop.aborted) throw new Error('cancelled')
        out = await desktop.call(next.tool, next.retry.args, call)
      }
      outputs.push(out)
      if (out.isError) break
    }
    return outputs
  }
  /**
   * One command within `commandMs`. Stop and turn end (`signal`) only keep further calls from starting: the call cua
   * is running settles first, under the lease, so the desktop and the agent's open apps survive. A timeout or
   * invalidation abandons that call, and the desktop with it, since a hung cua would otherwise hold the lease.
   * `operation` gets `call` for cua requests and `stop` to check before each one.
   */
  private async bounded<T>(
    entry: Entry,
    signal: AbortSignal,
    operation: (instance: DesktopInstance, call: AbortSignal, stop: AbortSignal) => Promise<T>
  ): Promise<T> {
    const instance = entry.instance
    if (!instance || entry.state !== 'ready') throw new Error('Desktop is unavailable')
    const controller = new AbortController()
    let timedOut = false
    const timer = this.timers.setTimeout(() => {
      timedOut = true
      controller.abort()
    }, this.deps.config.commandMs)
    const hard = AbortSignal.any([controller.signal, entry.abort.signal])
    let abort!: () => void
    const interrupted = new Promise<never>((_, reject) => {
      abort = () => reject(new Error(timedOut ? 'command_timeout' : 'cancelled'))
      if (hard.aborted) abort()
      else hard.addEventListener('abort', abort, { once: true })
    })
    try {
      const value = await Promise.race([operation(instance, hard, AbortSignal.any([signal, hard])), interrupted])
      if (signal.aborted) throw new Error('cancelled')
      return value
    } catch (error) {
      if (hard.aborted) await this.stop(entry).catch(() => undefined)
      throw error
    } finally {
      this.timers.clearTimeout(timer)
      hard.removeEventListener('abort', abort)
    }
  }

  // ---- Viewers and control ------------------------------------------------------------------------

  watch(target: DesktopTarget, viewer: DesktopViewer): Promise<DesktopSubscription> {
    return this.register(target, viewer, true)
  }
  /**
   * Answer-only, for a handoff card: statuses and `answer`, never `attach`, input or control. It starts, queues,
   * evicts and keeps alive nothing, and does not count as watching for an unattended handoff's expiry.
   */
  connect(target: DesktopTarget, viewer: DesktopViewer): Promise<DesktopSubscription> {
    return this.register(target, viewer, false)
  }
  private async register(target: DesktopTarget, viewer: DesktopViewer, watching: boolean): Promise<DesktopSubscription> {
    if (viewer.signal?.aborted || this.closed || this.viewers.has(viewer.id)) throw new Error('Desktop viewer is unavailable')
    const profile = await this.deps.resolveTarget(target)
    if (viewer.signal?.aborted) throw new Error('Desktop request cancelled')
    const current = await this.deps.profiles.byId(profile.id)
    if (!current || current.agent !== profile.agent) throw new Error('Desktop target is stale')
    if (viewer.signal?.aborted || this.closed || this.viewers.has(viewer.id)) throw new Error('Desktop viewer is unavailable')
    const entry = this.entry(current)
    if (entry.invalid) throw new Error('Desktop profile invalidated')
    const connected: Viewer = { viewer, entry, watching, controller: new AbortController() }
    this.viewers.set(viewer.id, connected)
    entry.viewers.add(connected)
    const abort = () => {
      void this.disconnect(connected).catch(() => undefined)
    }
    viewer.signal?.addEventListener('abort', abort, { once: true })
    connected.detachAbort = () => viewer.signal?.removeEventListener('abort', abort)
    const subscription = { close: () => this.disconnect(connected) }
    if (!watching) {
      try {
        viewer.sendStatus(this.statusOf(entry, connected))
      } catch {
        /* The socket handles its own failure. */
      }
      return subscription
    }
    this.handoffs.setViewed(entry.id, true)
    this.touch(entry)
    try {
      // Opening the view of a stopped desktop starts it, within the cap.
      await this.ensure(entry, connected.controller.signal)
      if (connected.controller.signal.aborted) throw new Error('Desktop request cancelled')
      this.attach(connected)
      this.broadcast(entry)
    } catch (error) {
      await this.disconnect(connected)
      throw error
    }
    return subscription
  }
  private disconnect(viewer: Viewer): Promise<void> {
    return (viewer.disconnecting ??= this.disconnectViewer(viewer))
  }
  private async disconnectViewer(viewer: Viewer): Promise<void> {
    if (this.viewers.get(viewer.viewer.id) !== viewer) return
    const entry = viewer.entry
    viewer.detachAbort?.()
    viewer.controller.abort()
    this.viewers.delete(viewer.viewer.id)
    entry.viewers.delete(viewer)
    this.detach(viewer)
    if (viewer.watching) this.handoffs.setViewed(entry.id, this.watched(entry))
    await this.releaseViewerControl(viewer)
    this.touch(entry)
  }
  private viewer(id: string, watching = true): Viewer {
    const viewer = this.viewers.get(id)
    if (!viewer || viewer.entry.invalid || (watching && !viewer.watching)) throw new Error('Desktop viewer is unavailable')
    return viewer
  }
  /** The relay drops every input byte unless this holds: only the controller, once the agent has paused. */
  canInput(viewerId: string): boolean {
    const viewer = this.viewers.get(viewerId),
      entry = viewer?.entry
    return !!viewer?.watching && !!entry && entry.control === viewer && !entry.pausing && !entry.invalid && entry.state === 'ready'
  }
  async takeControl(viewerId: string): Promise<void> {
    const viewer = this.viewer(viewerId),
      entry = viewer.entry
    // A release still draining would clear the control found here once it finishes: take afresh after it.
    while (viewer.releasing) {
      await viewer.releasing.catch(() => undefined)
      if (this.viewer(viewerId) !== viewer) throw new Error('Desktop viewer is unavailable')
    }
    // Control is never stolen silently.
    if (entry.control && entry.control !== viewer) throw new Error('Desktop is controlled by another viewer')
    if (entry.control === viewer) return viewer.takeover
    entry.control = viewer
    entry.pausing = true
    this.broadcast(entry)
    const takeover = this.grantControl(viewer)
    viewer.takeover = takeover
    try {
      await takeover
    } finally {
      if (viewer.takeover === takeover) viewer.takeover = undefined
    }
  }
  private async grantControl(viewer: Viewer): Promise<void> {
    const entry = viewer.entry,
      viewerId = viewer.viewer.id
    // Waits for the agent's in-flight call; later calls wait until release.
    await this.leases.pause(entry.id)
    if (this.viewers.get(viewerId) !== viewer || entry.control !== viewer || entry.invalid) return
    // A timed-out call may have stopped the desktop; the user gets a running one.
    try {
      await this.ensure(entry, viewer.controller.signal)
    } catch {
      await this.releaseViewerControl(viewer)
      throw new Error('Desktop control is unavailable')
    }
    if (this.viewers.get(viewerId) !== viewer || entry.control !== viewer || entry.invalid) return
    entry.seen.invalidate()
    this.attach(viewer)
    entry.pausing = false
    this.broadcast(entry)
  }
  releaseControl(viewerId: string): Promise<void> {
    return this.releaseViewerControl(this.viewer(viewerId, false))
  }
  private releaseViewerControl(viewer: Viewer): Promise<void> {
    if (viewer.entry.control !== viewer) return Promise.resolve()
    const releasing = (viewer.releasing ??= this.drainRelease(viewer).finally(() => {
      if (viewer.releasing === releasing) viewer.releasing = undefined
    }))
    return releasing
  }
  private async drainRelease(viewer: Viewer): Promise<void> {
    const entry = viewer.entry
    entry.pausing = true
    this.broadcast(entry)
    // A takeover may still be draining the agent's call when its viewer leaves.
    await this.leases.pause(entry.id)
    if (entry.control !== viewer) return
    entry.seen.invalidate()
    entry.control = undefined
    entry.pausing = false
    this.leases.resume(entry.id)
    this.broadcast(entry)
    this.touch(entry)
  }
  /** Never starts anything: a stopped desktop or a finished handoff is a stale request. */
  async answer(viewerId: string, requestId: string, decision: 'done' | 'cancel'): Promise<void> {
    const viewer = this.viewer(viewerId, false),
      entry = viewer.entry
    if (!entry.instance || this.handoffs.pendingId(entry.id) !== requestId) throw new Error('Stale desktop action request')
    if (entry.control && entry.control !== viewer) throw new Error('Desktop is controlled by another viewer')
    // Release manual control before the awaiting agent can resume.
    if (entry.control === viewer) await this.releaseViewerControl(viewer)
    if (this.viewers.get(viewerId) !== viewer || viewer.controller.signal.aborted) throw new Error('Desktop viewer is unavailable')
    if (entry.control) throw new Error('Desktop is controlled by another viewer')
    if (!entry.instance) throw new Error('Stale desktop action request')
    await this.handoffs.answer(requestId, entry.id, entry.instance.generation, decision)
    this.broadcast(entry)
  }

  // ---- Turns, agents, shutdown ------------------------------------------------------------------

  async endTurn(turnId: string): Promise<void> {
    this.turns.get(turnId)?.abort()
    this.turns.delete(turnId)
    this.leases.endTurn(turnId)
    await this.handoffs.endTurn(turnId)
  }
  private async invalidate(entry: Entry): Promise<void> {
    const viewers = [...entry.viewers]
    entry.invalid = true
    entry.abort.abort()
    this.leases.invalidate(entry.id)
    entry.control = undefined
    entry.pausing = false
    entry.state = entry.instance || entry.launching ? 'closing' : 'stopped'
    this.broadcast(entry)
    for (const demand of [...entry.demands]) demand.reject(new Refusal('cancelled', 'Desktop profile invalidated'))
    await this.handoffs.invalidate(entry.id)
    this.detachViewers(entry)
    for (const viewer of viewers) {
      viewer.detachAbort?.()
      viewer.controller.abort()
      if (this.viewers.get(viewer.viewer.id) === viewer) this.viewers.delete(viewer.viewer.id)
    }
    entry.viewers.clear()
    this.handoffs.setViewed(entry.id, false)
    try {
      await entry.launching
      await this.stop(entry)
    } finally {
      // The subscription is retired, but its socket still needs the final status to drop the old picture.
      for (const viewer of viewers) {
        try {
          viewer.viewer.sendStatus(this.statusOf(entry))
        } catch {
          /* Socket lifetime is independent. */
        }
      }
    }
  }
  /** Stops the desktop and deletes its home; the next start is a fresh profile. */
  async clear(agent: string): Promise<void> {
    const profile = await this.deps.profiles.ensure(agent),
      entry = this.entry({ ...profile, agent })
    await this.invalidate(entry)
    await this.deps.profiles.replace(agent)
    await fs.rm(profile.dir, { recursive: true, force: true })
  }
  /** The profile id, its running desktop and pending handoffs follow the new name. */
  async renameAgent(from: string, to: string): Promise<void> {
    await this.deps.profiles.renameAgent(from, to)
    for (const entry of this.entries.values())
      if (entry.agent === from) {
        entry.agent = to
        await this.handoffs.renameAgent(entry.id, to)
        this.broadcast(entry)
      }
  }
  /** A deleted agent's desktop stops at once; its folder stays until Clear desktop data. */
  async removeAgents(names: readonly string[]): Promise<void> {
    await this.deps.profiles.detachAgents(names)
    await Promise.all([...this.entries.values()].filter((entry) => names.includes(entry.agent)).map((entry) => this.invalidate(entry)))
  }
  async close(): Promise<void> {
    this.closed = true
    for (const turn of this.turns.values()) turn.abort()
    this.leases.close()
    await this.handoffs.close()
    await Promise.all([...this.entries.values()].map((entry) => this.invalidate(entry)))
  }
}
