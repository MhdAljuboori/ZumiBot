import type { BrowserFiles, BrowserFileOwner } from './browserFiles'
import { SHOT_REFUSALS, type BrowserShots } from './browserShots'
import { promises as fs } from 'node:fs'
import type { BrowserProfile, BrowserProfileStore } from './profileStore'
import { BrowserLeases, browserTimers, type BrowserTimers } from './browserLeases'
import { BrowserHandoffs } from './browserHandoffs'
import { fitBrowserViewport, sameBrowserViewport } from '@zumibot/shared/browser'
import type {
  BrowserAdapter,
  BrowserCommand,
  BrowserConfig,
  BrowserHandoff,
  BrowserInput,
  BrowserInstance,
  BrowserManager as Manager,
  BrowserOwner,
  BrowserResult,
  BrowserStatus,
  BrowserSubscription,
  BrowserTarget,
  BrowserViewer,
  BrowserViewport
} from './types'
import { BrowserLaunchCleanupError } from './types'
import type { VaultApprovalRequest, VaultItem, VaultStatus } from '@zumibot/shared/vault'
import { fillPlan, type FillPlan } from '../vault/vaultFill'
import { scrubBrowserResult, type ScrubbedString } from '../vault/scrub'
import { cutBrowserResult } from './browserTools'
/** What a vault fill needs; values leave it only inside a BrowserFill to the worker. */
export interface BrowserVault {
  item(id: string): VaultItem | null
  status(): VaultStatus
  addApproval(id: string, site: string, frameSite: string): Promise<void>
  /**
   * The card's first use on a pair waits on a chat card under the owner's turn; `pending` when another card already waits on the
   * profile, `unavailable` when the turn has no card to show it on.
   */
  approve(
    o: Omit<VaultApprovalRequest, 'id' | 'status' | 'chatId' | 'turnId' | 'profileId'> & { owner: BrowserOwner },
    signal: AbortSignal
  ): Promise<'allow' | 'deny' | 'interrupted' | 'pending' | 'unavailable'>
  /** Every secret held, whoever it is granted to: none may reach an agent in a browser result. */
  secrets(): { values: string[]; cards: string[] }
}
type FillCommand = Extract<BrowserCommand, { op: 'fillVault' }>
type ShotCommand = Extract<BrowserCommand, { op: 'saveScreenshot' }>
type ViewportCommand = Extract<BrowserCommand, { op: 'setViewport' }>
type ShotRefusal = (typeof SHOT_REFUSALS)[keyof typeof SHOT_REFUSALS]
// The store's refusals as sentences the agent can act on; the store itself never names a path.
const SHOT_REFUSED: Record<ShotRefusal, string> = {
  invalid_shot_name: 'The screenshot name must be 1 to 64 lowercase letters, digits, - or _, starting with a letter or digit',
  invalid_chat: 'Screenshots cannot be kept for this chat',
  too_many_shots: 'This chat already keeps the most screenshots it can: reuse an earlier name to replace one',
  image_too_large: 'The screenshot is over 5 MiB: shoot one element or a smaller area instead',
  unsafe_path: "The chat's screenshot folder is not safe to write to"
}
const shotRefusal = (message: string): ShotRefusal | undefined => Object.values(SHOT_REFUSALS).find((code) => code === message)
/**
 * Only keepShot may hold a PNG, and it writes it. A save a page dialog interrupted comes back as the answer to the dialog, so any
 * other command's PNG is that unsaved shot: the agent is told to shoot again and never gets the bytes.
 */
const carriesPng = (result: BrowserResult): boolean => {
  if (!result.ok || !result.data || typeof result.data !== 'object') return false
  const data = result.data as { mimeType?: unknown; base64?: unknown }
  return data.mimeType === 'image/png' && typeof data.base64 === 'string'
}
const shotNotSaved = (): BrowserResult => ({
  ok: true,
  data: { dialogAnswered: true, note: 'A screenshot was in progress and was not saved: run browser_save_screenshot again.' }
})
// Each round needs the user's click; a page that keeps moving to new pairs gets an answer instead of an endless series of cards.
const FILL_ROUNDS = 3
export interface BrowserManagerDependencies {
  profiles: BrowserProfileStore
  adapter: BrowserAdapter
  config: BrowserConfig
  now: () => number
  newId: () => string
  resolveTarget: (target: BrowserTarget) => Promise<BrowserProfile & { agent: string }>
  onHandoff: (handoff: BrowserHandoff) => Promise<void>
  files?: BrowserFiles
  timers?: BrowserTimers
  vault?: BrowserVault
  shots?: Pick<BrowserShots, 'save'>
}
type Viewer = {
  viewer: BrowserViewer
  entry: Entry
  frames: boolean
  controller: AbortController
  takeover?: Promise<void>
  detachAbort?: () => void
  disconnecting?: Promise<void>
  viewport?: BrowserViewport
  sizedAt?: number
}
type Demand = { resolve: (instance: BrowserInstance) => void; reject: (error: Error) => void }
type Entry = BrowserProfile & {
  agent: string
  state: BrowserStatus['state']
  instance?: BrowserInstance
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
  frames: boolean
  frameAbort: AbortController
  frameWork: Promise<void>
  manualWork: Promise<unknown>
  unsubscribe?: () => void
  fileOwner?: BrowserFileOwner
  lastLeaseEpoch?: number
  error: string | null
  /** The size the running instance has, or is being given. */
  viewport: BrowserViewport
  /** `browser_set_viewport`: held while the agent's lease lasts, and dropped at relaunch. */
  agentViewport?: { width: number; height: number }
}
const failure = (code: string, message: string): BrowserResult => ({ ok: false, code, message })

/** Owns browser processes, not disk identities or authenticated target resolution. */
export class BrowserManager implements Manager {
  private readonly entries = new Map<string, Entry>()
  private readonly viewers = new Map<string, Viewer>()
  private readonly turns = new Map<string, AbortController>()
  private readonly leases: BrowserLeases
  private readonly handoffs: BrowserHandoffs
  private readonly timers: BrowserTimers
  private readonly queue: Entry[] = []
  private closed = false
  private sized = 0
  constructor(private readonly deps: BrowserManagerDependencies) {
    this.timers = deps.timers ?? browserTimers
    this.leases = new BrowserLeases({
      ...deps.config,
      timers: this.timers,
      onIdle: (id) => {
        const entry = this.entries.get(id)
        if (entry) this.touch(entry)
      },
      // The agent's size lasts as long as its ownership: whoever owns the browser next starts on the viewers' size.
      onRelease: (id) => {
        const entry = this.entries.get(id)
        if (!entry?.agentViewport) return
        entry.agentViewport = undefined
        if (!entry.invalid && !this.closed) void this.syncViewport(entry)
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
  registerTurn(turnId: string, callback: (handoff: BrowserHandoff) => Promise<void>): () => void {
    return this.handoffs.registerTurn(turnId, callback)
  }
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
        frames: false,
        frameAbort: new AbortController(),
        frameWork: Promise.resolve(),
        manualWork: Promise.resolve(),
        error: null,
        viewport: this.defaultViewport()
      }
      this.entries.set(profile.id, entry)
    }
    return entry
  }
  private statusOf(entry: Entry, viewer?: Viewer): BrowserStatus {
    return {
      agent: entry.agent,
      profileId: entry.id,
      generation: entry.instance?.generation ?? '',
      state: entry.state,
      ...(entry.instance?.status() ?? { tabs: [], activeTabId: null }),
      control: entry.pausing ? 'pausing' : entry.control ? (entry.control === viewer ? 'you' : 'other') : 'agent',
      pendingRequestId: this.handoffs.pendingId(entry.id),
      error: entry.error,
      downloads: this.deps.files?.list(entry.id) ?? []
    }
  }
  async status(agent: string): Promise<BrowserStatus> {
    return this.statusOf(this.entry({ agent, ...(await this.deps.profiles.ensure(agent)) }))
  }
  private broadcast(entry: Entry): void {
    for (const viewer of entry.viewers) {
      try {
        viewer.viewer.sendStatus(this.statusOf(entry, viewer))
      } catch {
        /* A socket failure cannot break process ownership. */
      }
    }
  }
  private visible(entry: Entry): boolean {
    return [...entry.viewers].some((viewer) => viewer.frames)
  }
  private defaultViewport(): BrowserViewport {
    return { width: this.deps.config.width, height: this.deps.config.height, scale: 1 }
  }
  /**
   * One page size for every viewer: the agent's own size while it holds the lease, else the controller's surface, else the
   * latest viewer's, else the default once nobody watches. The agent sets CSS pixels only; the viewers' density still applies.
   */
  private wantedViewport(entry: Entry): BrowserViewport {
    const control = entry.control?.frames ? entry.control.viewport : undefined
    const latest = [...entry.viewers].filter((v) => v.frames && v.viewport).sort((a, b) => (b.sizedAt ?? 0) - (a.sizedAt ?? 0))[0]
    const viewers = control ?? latest?.viewport ?? this.defaultViewport(),
      agent = entry.agentViewport
    return agent ? fitBrowserViewport(agent.width, agent.height, viewers.scale) : viewers
  }
  /** False when the resize failed; it never rejects, so callers may leave it unawaited. */
  private syncViewport(entry: Entry): Promise<boolean> {
    // A launching instance is given the wanted size once it is ready.
    if (!entry.instance || entry.state !== 'ready') return Promise.resolve(true)
    const wanted = this.wantedViewport(entry)
    if (sameBrowserViewport(wanted, entry.viewport)) return Promise.resolve(true)
    entry.viewport = wanted
    return this.bounded(entry, new AbortController().signal, (browser) => browser.setViewport(wanted)).then(
      () => true,
      () => false
    )
  }
  private idle(entry: Entry): boolean {
    return (
      !entry.busy && !entry.control && !entry.pausing && !entry.demands.length && !this.visible(entry) && !this.handoffs.pendingId(entry.id)
    )
  }
  private touch(entry: Entry): void {
    if (entry.idle) this.timers.clearTimeout(entry.idle)
    entry.idle = undefined
    if (entry.state === 'ready' && this.idle(entry)) {
      if (!this.leases.hasDemand(entry.id)) void this.stop(entry).catch(() => undefined)
      else
        entry.idle = this.timers.setTimeout(() => {
          void this.stop(entry).catch(() => undefined)
        }, this.deps.config.idleMs)
    }
    this.pump()
  }
  private ensure(entry: Entry, signal: AbortSignal): Promise<BrowserInstance> {
    if (signal.aborted || this.closed || entry.invalid) return Promise.reject(new Error('Browser request cancelled'))
    if (entry.state === 'ready' && entry.instance) return Promise.resolve(entry.instance)
    // A failed close is never retried by itself, so a new demand retries it once; the slot stays reserved until it is confirmed.
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
      const abort = () => demand.reject(new Error('Browser request cancelled'))
      const timer = this.timers.setTimeout(() => demand.reject(new Error('Browser capacity queue timed out')), this.deps.config.queueMs)
      signal.addEventListener('abort', abort, { once: true })
      entry.demands.push(demand)
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
        if (entry.state === 'queued') entry.state = 'stopped'
        continue
      }
      if (entry.state === 'starting' || entry.state === 'closing') {
        i++
        continue
      }
      const slots = [...this.entries.values()].filter((e) => e.instance || e.state === 'starting' || e.state === 'closing').length
      if (slots >= this.deps.config.maxBrowsers) {
        const candidate = [...this.entries.values()].find((e) => e.state === 'ready' && this.idle(e))
        if (candidate) void this.stop(candidate).catch(() => undefined)
        return
      }
      this.queue.splice(i, 1)
      entry.state = 'starting'
      this.broadcast(entry)
      entry.launching = this.launch(entry)
    }
  }
  private async launch(entry: Entry): Promise<void> {
    try {
      const instance = await this.deps.adapter.launch(entry.dir, this.deps.config, {
        sourceClosed: (id) => this.deps.files?.sourceClosed(id),
        download: async (source, name, generation, signal) => {
          const owner = entry.fileOwner
          if (!this.deps.files || !owner || entry.invalid || owner.generation !== generation || entry.instance?.generation !== generation)
            throw new Error('Browser file unavailable')
          const ownerSignal = 'turnId' in owner ? this.turns.get(owner.turnId)?.signal : this.viewers.get(owner.viewerId)?.controller.signal
          if (!ownerSignal || ownerSignal.aborted) throw new Error('Browser file unavailable')
          const combined = AbortSignal.any([entry.abort.signal, ownerSignal, ...(signal ? [signal] : [])])
          const result = await this.deps.files.stageDownload(owner, source, name, combined)
          this.broadcast(entry)
          return result
        }
      })
      entry.instance = instance
      entry.lastLeaseEpoch = undefined
      entry.frameAbort = new AbortController()
      if (entry.invalid || this.closed || !entry.demands.length) {
        await this.stop(entry)
        return
      }
      entry.state = 'ready'
      entry.error = null
      // A new page starts on the viewers' size: the agent observes it anyway, and sets its own size again if it needs one.
      entry.agentViewport = undefined
      entry.viewport = this.defaultViewport()
      void this.syncViewport(entry)
      entry.unsubscribe = instance.onChanged(() => {
        if (entry.instance !== instance) return
        if (instance.isClosed()) {
          entry.control = undefined
          entry.pausing = false
          this.leases.resume(entry.id)
          void this.handoffs.invalidate(entry.id).catch(() => undefined)
          void this.stop(entry).catch(() => undefined)
        } else this.broadcast(entry)
      })
      void this.updateFrames(entry).catch(() => {
        if (entry.instance === instance) {
          entry.error = 'Browser viewing is unavailable'
          this.broadcast(entry)
        }
      })
      for (const demand of [...entry.demands]) demand.resolve(instance)
      this.broadcast(entry)
      this.touch(entry)
    } catch (error) {
      if (error instanceof BrowserLaunchCleanupError) {
        entry.instance = error.instance
        entry.state = 'closing'
      } else if (!entry.instance) entry.state = 'unavailable'
      entry.error =
        error instanceof BrowserLaunchCleanupError ? 'Browser launch cleanup could not be confirmed' : 'Browser could not be started'
      for (const demand of [...entry.demands]) demand.reject(new Error(entry.error))
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
    entry.state = 'closing'
    entry.unsubscribe?.()
    entry.unsubscribe = undefined
    this.broadcast(entry)
    const instance = entry.instance
    entry.frameAbort.abort()
    entry.frameWork = Promise.resolve()
    entry.frames = false
    entry.closing = (async () => {
      try {
        // Process closure is authoritative even when capture acknowledgments stall.
        await instance.close()
        entry.instance = undefined
        entry.state = 'stopped'
        entry.lastLeaseEpoch = undefined
      } catch {
        // An unconfirmed close keeps its capacity slot reserved.
        entry.error = 'Browser could not be closed safely'
        throw new Error(entry.error)
      } finally {
        entry.closing = undefined
        this.broadcast(entry)
        this.pump()
      }
    })()
    return entry.closing
  }
  private turn(turnId: string): AbortController {
    let turn = this.turns.get(turnId)
    if (!turn) {
      turn = new AbortController()
      this.turns.set(turnId, turn)
    }
    return turn
  }
  /**
   * Every result an agent gets passes the vault scrub, whatever produced it: page text, tab titles, dialogs, errors. Then page
   * strings are cut to their final lengths: scrub first, so a cut never leaves the start of a secret, and the cut learns how
   * much the scrub shortened each string, since that pulls the worker's own cut closer.
   */
  async run(owner: BrowserOwner, command: BrowserCommand, signal: AbortSignal): Promise<BrowserResult> {
    const result = await this.runCommand(owner, command, signal)
    const vault = this.deps.vault
    if (!vault) return cutBrowserResult(result)
    // Fails closed: a result that could not be checked is not handed over.
    try {
      // A kept screenshot's answer is built by keepShot from the server's own data folder, chat id and parser-checked name, so a
      // secret that happens to be a word of that path ("zumibot") must not corrupt it. Only that exact object skips the scrub.
      if (command.op === 'saveScreenshot' && result.ok && this.keptShots.has(result)) return cutBrowserResult(result)
      const trace = new Map<string, ScrubbedString>()
      return cutBrowserResult(scrubBrowserResult(result, vault.secrets(), trace), trace)
    } catch {
      return failure('command_failed', 'Browser command did not complete')
    }
  }
  private async runCommand(owner: BrowserOwner, command: BrowserCommand, signal: AbortSignal): Promise<BrowserResult> {
    if (this.closed) return failure('unavailable', 'Browser service is closed')
    const profile = await this.deps.profiles.byId(owner.profileId)
    if (!profile) return failure('stale_profile', 'Browser profile no longer exists')
    const entry = this.entry(profile),
      combined = AbortSignal.any([signal, this.turn(owner.turnId).signal, entry.abort.signal])
    if (command.op === 'release') {
      this.leases.release(owner)
      return { ok: true, data: null }
    }
    // Checked before anything is shot: a picture that cannot be kept is never taken.
    if (command.op === 'saveScreenshot' && !this.deps.shots)
      return failure('shots_unavailable', 'Saved screenshots are unavailable on this server')
    if (this.handoffs.pendingId(entry.id)) return failure('waiting_for_user', 'Browser is waiting for user action')
    let release: (() => void) | undefined
    try {
      const lease = await this.leases.acquire(owner, combined)
      release = lease.release
      if (this.handoffs.pendingId(entry.id)) return failure('waiting_for_user', 'Browser is waiting for user action')
      entry.busy++
      this.touch(entry)
      try {
        const instance = await this.ensure(entry, combined)
        if (combined.aborted || entry.invalid) return failure('cancelled', 'Browser request cancelled')
        const leaseEpoch = lease.epoch
        if (command.op === 'requestUserAction') {
          if (entry.lastLeaseEpoch !== undefined && entry.lastLeaseEpoch !== leaseEpoch)
            await this.bounded(entry, combined, (browser) => browser.invalidateReferences())
          entry.lastLeaseEpoch = leaseEpoch
          const unprotect = this.leases.protect(owner)
          const waiting = this.handoffs.request(
            owner,
            instance.generation,
            instance.status().tabs.find((t) => t.id === instance.status().activeTabId)?.url ?? '',
            command.reason,
            combined
          )
          release()
          release = undefined
          try {
            return await waiting
          } finally {
            unprotect()
            this.broadcast(entry)
          }
        }
        if (command.op === 'fillVault') {
          return await this.fillVault(entry, owner, command, combined, {
            epoch: leaseEpoch,
            release: () => {
              release?.()
              release = undefined
            },
            // Untimed while the user controls the page: they may be looking before they answer.
            acquire: async () => {
              const next = await this.leases.acquire(owner, combined, { untimedWhilePaused: true })
              release = next.release
              return next.epoch
            }
          })
        }
        if (command.op === 'setViewport') return await this.setAgentViewport(entry, command)
        const result = await this.execute(entry, command, combined, leaseEpoch, { ...owner, generation: instance.generation })
        // Written while the lease is held, like the shot itself; the PNG never goes past this point.
        return command.op === 'saveScreenshot' ? await this.keepShot(owner, command, result, combined) : result
      } finally {
        entry.busy--
        this.touch(entry)
      }
    } catch {
      return failure('cancelled', 'Browser request cancelled or queue timed out')
    } finally {
      release?.()
    }
  }
  /**
   * `browser_set_viewport`: the manager owns the size, so it takes the path a viewer's resize does and `entry.viewport`
   * stays the size the page has. References stay valid: the page is not reloaded.
   */
  private async setAgentViewport(entry: Entry, command: ViewportCommand): Promise<BrowserResult> {
    // Bounded again although the parser refuses other sizes: the window size never trusts its caller.
    const { width, height } = fitBrowserViewport(command.width, command.height, 1)
    entry.agentViewport = { width, height }
    if (!(await this.syncViewport(entry))) return failure('command_failed', 'Browser command did not complete')
    return { ok: true, data: { width, height } }
  }
  /** The answers keepShot built itself: the one result the vault scrub leaves alone (see run). */
  private readonly keptShots = new WeakSet<object>()
  /**
   * `browser_save_screenshot`: the worker hands over the PNG, the server writes it and the agent gets only where it is.
   * Not bounded: a store failure is not the browser's, so it must never stop or relaunch the page.
   */
  private async keepShot(owner: BrowserOwner, command: ShotCommand, result: BrowserResult, signal: AbortSignal): Promise<BrowserResult> {
    if (!result.ok) return result
    // A page dialog interrupted the shot: the cue goes on unchanged so the agent answers it with browser_dialog (as fillVault does).
    if ((result.data as { dialogPending?: unknown } | null)?.dialogPending === true) return result
    const shots = this.deps.shots
    if (!shots) return failure('shots_unavailable', 'Saved screenshots are unavailable on this server')
    const data = result.data as { base64?: unknown; width?: unknown; height?: unknown } | null
    if (typeof data?.base64 !== 'string' || typeof data.width !== 'number' || typeof data.height !== 'number')
      return failure('command_failed', 'Browser command did not complete')
    // A stopped turn keeps nothing it can no longer hear about.
    if (signal.aborted) return failure('cancelled', 'Browser request cancelled')
    try {
      const saved = await shots.save(owner.chatId, command.name, Buffer.from(data.base64, 'base64'))
      const kept: BrowserResult = {
        ok: true,
        data: { path: saved.path, name: command.name, bytes: saved.bytes, width: data.width, height: data.height }
      }
      this.keptShots.add(kept)
      return kept
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const refusal = shotRefusal(message)
      if (refusal) return failure(refusal, SHOT_REFUSED[refusal])
      // The message only: never the image.
      console.error('browser screenshot not saved:', message)
      return failure('shot_failed', 'The screenshot could not be saved')
    }
  }
  private async bounded<T>(
    entry: Entry,
    signal: AbortSignal,
    operation: (instance: BrowserInstance, signal: AbortSignal) => Promise<T>
  ): Promise<T> {
    const instance = entry.instance
    if (!instance || entry.state !== 'ready') throw new Error('Browser is unavailable')
    const controller = new AbortController()
    let timedOut = false
    const timer = this.timers.setTimeout(() => {
      timedOut = true
      controller.abort()
    }, this.deps.config.commandMs)
    const combined = AbortSignal.any([signal, controller.signal, entry.abort.signal])
    let abort!: () => void
    const interrupted = new Promise<never>((_, reject) => {
      abort = () => reject(new Error(timedOut ? 'command_timeout' : 'cancelled'))
      if (combined.aborted) abort()
      else combined.addEventListener('abort', abort, { once: true })
    })
    try {
      return await Promise.race([operation(instance, combined), interrupted])
    } catch (error) {
      if (combined.aborted) await this.stop(entry)
      throw error
    } finally {
      this.timers.clearTimeout(timer)
      combined.removeEventListener('abort', abort)
    }
  }
  private async execute(
    entry: Entry,
    command: BrowserCommand,
    signal: AbortSignal,
    leaseEpoch?: number,
    fileOwner?: BrowserFileOwner
  ): Promise<BrowserResult> {
    if (command.op === 'newTab' && (entry.instance?.status().tabs.length ?? 0) >= this.deps.config.maxTabs)
      return failure('tab_limit', 'Browser tab limit reached')
    const result = await this.leased(entry, signal, leaseEpoch, async (instance, abort) => {
      if (fileOwner) entry.fileOwner = fileOwner
      let paths: string[] | undefined
      if (command.op === 'upload' || command.op === 'chooseFiles') {
        if (!this.deps.files || !fileOwner) return failure('invalid_files', 'Browser files unavailable')
        try {
          paths = command.fileIds.length ? await this.deps.files.resolveUpload(fileOwner, command.fileIds) : []
        } catch {
          return failure('invalid_files', 'Browser files unavailable')
        }
      }
      return instance.execute(command, abort, paths)
    })
    // Here rather than in run, so a viewer's dialog answer (navigate) is covered too.
    return command.op !== 'saveScreenshot' && carriesPng(result) ? shotNotSaved() : result
  }
  /** A bounded instance call that first voids references from an earlier lease period. */
  private async leased(
    entry: Entry,
    signal: AbortSignal,
    leaseEpoch: number | undefined,
    operation: (instance: BrowserInstance, signal: AbortSignal) => Promise<BrowserResult>
  ): Promise<BrowserResult> {
    try {
      return await this.bounded(entry, signal, async (instance, abort) => {
        if (leaseEpoch !== undefined) {
          if (entry.lastLeaseEpoch !== undefined && entry.lastLeaseEpoch !== leaseEpoch) await instance.invalidateReferences()
          if (abort.aborted) throw new Error('cancelled')
          entry.lastLeaseEpoch = leaseEpoch
        }
        return operation(instance, abort)
      })
    } catch (error) {
      return failure(
        error instanceof Error && error.message === 'command_timeout' ? 'command_timeout' : 'command_failed',
        'Browser command did not complete'
      )
    }
  }
  /**
   * `browser_fill_from_vault`: the plan (grant, field, value) is made here, the host and element checks in the worker right
   * before typing. A card on a new (page, frame) pair stops there with `approve`; the user's card decides, and after Allow
   * both are done again from the start, since the grant, the item and the page may all have changed while the card waited.
   */
  private async fillVault(
    entry: Entry,
    owner: BrowserOwner,
    command: FillCommand,
    signal: AbortSignal,
    lease: { epoch: number; release(): void; acquire(): Promise<number> }
  ): Promise<BrowserResult> {
    const vault = this.deps.vault
    if (!vault) return failure('vault_unavailable', 'The vault is unavailable')
    const plan = (): FillPlan => {
      const status = vault.status()
      if (status === 'keyMissing' || status === 'keyMismatch')
        return { ok: false, code: 'vault_unavailable', message: 'The vault cannot be opened on this server' }
      return fillPlan(vault.item(command.item), entry.agent, command.field, this.deps.now())
    }
    let current = plan(),
      epoch = lease.epoch
    const asked = new Set<string>()
    for (;;) {
      if (!current.ok) return failure(current.code, current.message)
      const { value, secret, mask, target, loose, hosts, itemName, label } = current
      const result = await this.leased(entry, signal, epoch, (instance, abort) =>
        instance.fill({ stamp: command.stamp, ref: command.ref, value, secret, mask, target, loose, hosts }, abort)
      )
      if (!result.ok) return result
      const data = result.data as { filled?: unknown; approve?: { site?: unknown; frameSite?: unknown } } | null
      if (data?.filled === true) return { ok: true, data: { filled: true, item: itemName, field: command.field } }
      // A dialog that opened mid-fill: answered with browser_dialog like any other command's.
      if (!data?.approve) return result
      const { site, frameSite } = data.approve
      if (hosts.kind !== 'card' || typeof site !== 'string' || typeof frameSite !== 'string')
        return failure('command_failed', 'Browser command did not complete')
      // The pair just allowed asked again: the approval did not stick, and the user is never asked in a loop.
      if (asked.has(`${site} ${frameSite}`)) return failure('vault_unavailable', 'The approval could not be saved')
      if (asked.size >= FILL_ROUNDS) return failure('wrong_site', 'The page kept moving to other sites; observe it again and retry')
      asked.add(`${site} ${frameSite}`)
      // The turn keeps the lease while the user decides (no idle expiry) but holds no grant, so the user can take control.
      const unprotect = this.leases.protect(owner)
      try {
        lease.release()
        let decision: Awaited<ReturnType<BrowserVault['approve']>>
        try {
          decision = await vault.approve({ owner, itemId: command.item, itemName, label, site, frameSite }, signal)
        } catch {
          decision = 'interrupted'
        }
        if (decision === 'deny') return failure('denied', 'The user did not allow this card on this site')
        if (decision === 'pending') return failure('approval_pending', 'Another vault approval is already waiting for the user.')
        if (decision === 'unavailable') return failure('approval_unavailable', 'No approval card could be shown for this turn.')
        if (decision !== 'allow' || signal.aborted) return failure('cancelled', 'Browser request cancelled')
        // Checked before anything is remembered: an Allow for an agent that lost the card, or for a deleted card, stores nothing.
        current = plan()
        if (!current.ok) return failure(current.code, current.message)
        try {
          await vault.addApproval(command.item, site, frameSite)
        } catch {
          return failure('vault_unavailable', 'The approval could not be saved')
        }
        current = plan()
        epoch = await lease.acquire()
        // Another call of this turn may have handed the browser to the user meanwhile.
        if (this.handoffs.pendingId(entry.id)) return failure('waiting_for_user', 'Browser is waiting for user action')
      } finally {
        unprotect()
      }
    }
  }
  watch(target: BrowserTarget, viewer: BrowserViewer): Promise<BrowserSubscription> {
    return this.connectViewer(target, viewer, true)
  }
  connect(target: BrowserTarget, viewer: BrowserViewer, _options: { frames: false }): Promise<BrowserSubscription> {
    return this.connectViewer(target, viewer, false)
  }
  private async connectViewer(target: BrowserTarget, viewer: BrowserViewer, frames: boolean): Promise<BrowserSubscription> {
    if (viewer.signal?.aborted || this.closed || this.viewers.has(viewer.id)) throw new Error('Browser viewer is unavailable')
    const profile = await this.deps.resolveTarget(target)
    if (viewer.signal?.aborted) throw new Error('Browser request cancelled')
    const current = await this.deps.profiles.byId(profile.id)
    if (!current || current.agent !== profile.agent) throw new Error('Browser target is stale')
    if (viewer.signal?.aborted || this.closed || this.viewers.has(viewer.id)) throw new Error('Browser viewer is unavailable')
    const entry = this.entry(current)
    if (entry.invalid) throw new Error('Browser profile invalidated')
    const connected: Viewer = { viewer, entry, frames, controller: new AbortController() }
    this.viewers.set(viewer.id, connected)
    entry.viewers.add(connected)
    const abort = () => {
      void this.disconnect(connected).catch(() => undefined)
    }
    viewer.signal?.addEventListener('abort', abort, { once: true })
    connected.detachAbort = () => viewer.signal?.removeEventListener('abort', abort)
    if (frames) {
      this.handoffs.setViewed(entry.id, this.visible(entry))
      this.touch(entry)
    }
    try {
      if (frames) {
        await this.ensure(entry, connected.controller.signal)
        await this.updateFrames(entry)
      }
      if (connected.controller.signal.aborted) throw new Error('Browser request cancelled')
      this.broadcast(entry)
    } catch (error) {
      await this.disconnect(connected)
      throw error
    }
    return { close: () => this.disconnect(connected) }
  }
  private updateFrames(entry: Entry): Promise<void> {
    const instance = entry.instance,
      signal = entry.frameAbort.signal
    if (!instance || signal.aborted) return Promise.resolve()
    const work = entry.frameWork
      .catch(() => undefined)
      .then(async () => {
        if (signal.aborted || entry.instance !== instance) return
        const wanted = this.visible(entry) && entry.state === 'ready' && !entry.invalid && !this.closed
        if (wanted && !entry.frames) {
          await instance.startFrames((frame) => {
            if (signal.aborted || entry.instance !== instance || entry.state !== 'ready' || frame.generation !== instance.generation) return
            for (const viewer of entry.viewers)
              if (viewer.frames) {
                try {
                  viewer.viewer.sendFrame(frame)
                } catch {
                  /* Socket handles disconnect. */
                }
              }
          })
          if (signal.aborted || entry.instance !== instance) {
            // A late acknowledgment belongs to the closed generation, never its replacement.
            void instance.stopFrames().catch(() => undefined)
            return
          }
          entry.frames = true
          if (!this.visible(entry) || entry.invalid || this.closed) {
            await instance.stopFrames()
            if (!signal.aborted && entry.instance === instance) entry.frames = false
          }
        } else if (!wanted && entry.frames) {
          await instance.stopFrames()
          if (!signal.aborted && entry.instance === instance) entry.frames = false
        }
      })
    let cancel!: () => void
    const cancelled = new Promise<void>((resolve) => {
      cancel = resolve
      signal.addEventListener('abort', cancel, { once: true })
    })
    entry.frameWork = Promise.race([work, cancelled]).finally(() => signal.removeEventListener('abort', cancel))
    return entry.frameWork
  }
  private disconnect(viewer: Viewer): Promise<void> {
    return (viewer.disconnecting ??= this.disconnectViewer(viewer))
  }
  private async disconnectViewer(viewer: Viewer): Promise<void> {
    if (this.viewers.get(viewer.viewer.id) !== viewer) return
    viewer.detachAbort?.()
    viewer.controller.abort()
    this.viewers.delete(viewer.viewer.id)
    viewer.entry.viewers.delete(viewer)
    // Capture must stop even while an agent action or manual input is still draining.
    let frames = Promise.resolve()
    if (viewer.frames) {
      this.handoffs.setViewed(viewer.entry.id, this.visible(viewer.entry))
      frames = this.updateFrames(viewer.entry)
      this.touch(viewer.entry)
    }
    await Promise.all([frames, this.releaseViewerControl(viewer), this.deps.files?.discardViewer(viewer.viewer.id)])
    if (viewer.frames) {
      this.syncViewport(viewer.entry)
      this.touch(viewer.entry)
    }
  }
  private viewer(id: string, visible = true): Viewer {
    const viewer = this.viewers.get(id)
    if (!viewer || viewer.entry.invalid || (visible && !viewer.frames)) throw new Error('Browser viewer is unavailable')
    return viewer
  }
  async takeControl(viewerId: string): Promise<void> {
    const viewer = this.viewer(viewerId),
      entry = viewer.entry
    if (entry.control && entry.control !== viewer) throw new Error('Browser is controlled by another viewer')
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
    await this.leases.pause(entry.id)
    if (this.viewers.get(viewerId) !== viewer || entry.control !== viewer || entry.invalid) return
    // Timeout recovery closed the uncertain generation; launch a fresh page before acknowledgment.
    try {
      await this.ensure(entry, viewer.controller.signal)
    } catch {
      await this.releaseViewerControl(viewer)
      return
    }
    if (this.viewers.get(viewerId) !== viewer || entry.control !== viewer || entry.invalid) return
    entry.pausing = false
    this.syncViewport(entry)
    await this.updateFrames(entry)
    this.broadcast(entry)
  }
  releaseControl(viewerId: string): Promise<void> {
    return this.releaseViewerControl(this.viewer(viewerId))
  }
  private async releaseViewerControl(viewer: Viewer): Promise<void> {
    const entry = viewer.entry
    if (entry.control !== viewer) return
    entry.pausing = true
    await entry.manualWork
    // Agent command may still be draining when its viewer disconnects.
    await this.leases.pause(entry.id)
    if (entry.instance && entry.state === 'ready') {
      try {
        await this.bounded(entry, new AbortController().signal, (browser) => browser.invalidateReferences())
      } catch {
        if (entry.instance) throw new Error('Browser references could not be invalidated')
      }
    }
    if (entry.control !== viewer) return
    entry.control = undefined
    entry.pausing = false
    this.leases.resume(entry.id)
    this.syncViewport(entry)
    this.broadcast(entry)
    this.touch(entry)
  }
  private manual<T>(viewerId: string, action: (entry: Entry, signal: AbortSignal) => Promise<T>): Promise<T> {
    const viewer = this.viewer(viewerId),
      entry = viewer.entry
    const work = entry.manualWork.then(async () => {
      if (this.viewers.get(viewerId) !== viewer || entry.control !== viewer || entry.pausing) throw new Error('Browser control is required')
      entry.busy++
      try {
        return await action(entry, viewer.controller.signal)
      } finally {
        entry.busy--
        this.touch(entry)
      }
    })
    entry.manualWork = work.catch(() => undefined)
    return work
  }
  async input(viewerId: string, input: BrowserInput): Promise<void> {
    return this.manual(viewerId, async (entry, signal) => {
      if ('x' in input && (input.x >= entry.viewport.width || input.y >= entry.viewport.height)) throw new Error('Input outside viewport')
      if (input.generation !== entry.instance?.generation || input.tabId !== entry.instance.status().activeTabId)
        throw new Error('Stale browser input')
      entry.fileOwner = { profileId: entry.id, generation: input.generation, viewerId }
      await this.bounded(entry, signal, (instance, abort) => instance.input(input, abort))
    })
  }
  async resize(viewerId: string, viewport: BrowserViewport): Promise<void> {
    const viewer = this.viewer(viewerId),
      fitted = fitBrowserViewport(viewport.width, viewport.height, viewport.scale)
    if (!sameBrowserViewport(fitted, viewport)) throw new Error('Invalid browser viewport')
    // Kept even while another viewer controls the page, so it applies once control is released.
    viewer.viewport = fitted
    viewer.sizedAt = ++this.sized
    this.syncViewport(viewer.entry)
  }
  navigate(viewerId: string, command: BrowserCommand, location?: Pick<BrowserInput, 'generation' | 'tabId'>): Promise<BrowserResult> {
    if (!['navigate', 'back', 'forward', 'reload', 'newTab', 'selectTab', 'closeTab', 'dialog', 'chooseFiles'].includes(command.op))
      return Promise.resolve(failure('invalid_command', 'Unsupported viewer command'))
    return this.manual(viewerId, (entry, signal) => {
      if (location && (location.generation !== entry.instance?.generation || location.tabId !== entry.instance.status().activeTabId))
        throw new Error('Stale browser navigation')
      return this.execute(entry, command, signal, undefined, { profileId: entry.id, generation: entry.instance!.generation, viewerId })
    })
  }
  stageUpload(viewerId: string, location: Pick<BrowserInput, 'generation' | 'tabId'>, source: AsyncIterable<Uint8Array>, name: string) {
    return this.manual(viewerId, async (entry, signal) => {
      if (location.generation !== entry.instance?.generation || location.tabId !== entry.instance.status().activeTabId)
        throw new Error('Stale browser upload')
      if (!this.deps.files) throw new Error('Browser files unavailable')
      const owner = { profileId: entry.id, generation: location.generation, viewerId }
      return this.bounded(entry, signal, async (_instance, abort) => this.deps.files!.stageUpload(owner, source, name, abort))
    })
  }
  async answer(viewerId: string, requestId: string, decision: 'done' | 'cancel'): Promise<void> {
    const viewer = this.viewer(viewerId, false),
      entry = viewer.entry
    if (!entry.instance || this.handoffs.pendingId(entry.id) !== requestId) throw new Error('Stale browser action request')
    if (entry.control && entry.control !== viewer) throw new Error('Browser is controlled by another viewer')
    // Release manual control before the awaiting agent can resume.
    if (entry.control === viewer) await this.releaseViewerControl(viewer)
    if (this.viewer(viewerId, false) !== viewer || viewer.controller.signal.aborted) throw new Error('Browser viewer is unavailable')
    if (entry.control) throw new Error('Browser is controlled by another viewer')
    await this.handoffs.answer(requestId, entry.id, entry.instance.generation, decision)
    this.broadcast(entry)
  }
  async endTurn(turnId: string): Promise<void> {
    this.turn(turnId).abort()
    this.leases.endTurn(turnId)
    await this.handoffs.endTurn(turnId)
    await this.deps.files?.discardTurn(turnId)
  }
  private async invalidate(entry: Entry): Promise<void> {
    const viewers = [...entry.viewers]
    entry.invalid = true
    entry.abort.abort()
    this.leases.invalidate(entry.id)
    entry.control = undefined
    entry.pausing = false
    entry.frameAbort.abort()
    entry.state = entry.instance || entry.launching ? 'closing' : 'stopped'
    this.broadcast(entry)
    for (const demand of [...entry.demands]) demand.reject(new Error('Browser profile invalidated'))
    await this.deps.files?.discardProfile(entry.id)
    await this.handoffs.invalidate(entry.id)
    for (const viewer of viewers) {
      viewer.detachAbort?.()
      viewer.controller.abort()
      this.viewers.delete(viewer.viewer.id)
    }
    entry.viewers.clear()
    entry.control = undefined
    entry.pausing = false
    this.handoffs.setViewed(entry.id, false)
    try {
      await entry.launching
      await this.stop(entry)
    } finally {
      // The subscription is retired, but its socket still needs the terminal status
      // to discard the old picture and held input without restoring the watch.
      for (const viewer of viewers) {
        try {
          viewer.viewer.sendStatus(this.statusOf(entry))
        } catch {
          /* Socket lifetime is independent. */
        }
      }
    }
  }
  async clear(agent: string): Promise<void> {
    const profile = await this.deps.profiles.ensure(agent),
      entry = this.entry({ ...profile, agent })
    await this.invalidate(entry)
    await this.deps.profiles.replace(agent)
    await fs.rm(profile.dir, { recursive: true, force: true })
  }
  async renameAgent(from: string, to: string): Promise<void> {
    await this.deps.profiles.renameAgent(from, to)
    for (const entry of this.entries.values())
      if (entry.agent === from) {
        entry.agent = to
        await this.handoffs.renameAgent(entry.id, to)
        this.broadcast(entry)
      }
  }
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
