import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DesktopConfig, DesktopHandoff, DesktopOwner, DesktopResult, DesktopStamp, DesktopStatus } from '@zumibot/shared/desktop'
import { BrowserProfileStore } from '../../../src/core/browser/profileStore'
import { DesktopManager, type DesktopViewer } from '../../../src/core/desktop/desktopManager'
import {
  DesktopLaunchCleanupError,
  DesktopUnavailableError,
  type CuaResult,
  type DesktopAdapter,
  type DesktopInstance
} from '../../../src/core/desktop/types'

type Deferred<T> = { promise: Promise<T>; resolve: (value: T) => void; reject: (error: Error) => void }
function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void, reject!: (error: Error) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}
const PNG = 'iVBORw0KGgo='
const WINDOW = 37748739
const ok = (structuredContent: Record<string, unknown> | null, content: CuaResult['content'] = []): CuaResult => ({
  content,
  isError: false,
  structuredContent
})
const refused = (code: string): CuaResult => ({ content: [{ type: 'text', text: 'refused' }], isError: true, structuredContent: { code } })

/** One fake desktop: records cua calls and answers them with the spike's result shapes. */
class FakeDesktop implements DesktopInstance {
  readonly vncSocket: string
  readonly display = 90
  calls: { tool: string; args: Record<string, unknown> }[] = []
  replies: Record<string, (args: Record<string, unknown>) => CuaResult> = {}
  gate?: Deferred<void>
  closeGate?: Deferred<void>
  closed = false
  closes = 0
  failClose = false
  /** Fail this many closes, then succeed. */
  failCloses = 0
  states = 0
  private readonly listeners = new Set<() => void>()
  constructor(
    readonly generation: string,
    readonly dir: string
  ) {
    this.vncSocket = `/run/desk/${generation}/vnc.sock`
  }
  async call(tool: string, args: Record<string, unknown>): Promise<CuaResult> {
    if (this.closed) throw new Error('Desktop unavailable')
    this.calls.push({ tool, args })
    if (this.gate) await this.gate.promise
    const reply = this.replies[tool]
    if (reply) return reply(args)
    switch (tool) {
      case 'get_desktop_state':
        return ok({ screenshot_width: 1280, screenshot_height: 800 }, [{ type: 'image', mimeType: 'image/png', data: PNG }])
      case 'list_windows':
        return ok({
          windows: [
            {
              window_id: WINDOW,
              pid: 4242,
              app_name: 'Mousepad',
              title: 'Untitled',
              bounds: { x: 5, y: 56, width: 640, height: 480 },
              is_on_screen: true,
              z_index: 1
            }
          ]
        })
      case 'list_apps':
        return ok({
          apps: [
            { kind: 'desktop', name: 'Mousepad', running: false },
            { kind: 'process', name: 'bash' }
          ]
        })
      case 'get_window_state':
        this.states++
        return ok(
          {
            window_title: 'Untitled',
            screenshot_width: 640,
            screenshot_height: 480,
            elements: [
              {
                element_token: `s0000000${this.states}:3`,
                role: 'button',
                label: 'Save',
                actions: ['click'],
                frame: { x: 10, y: 60, w: 40, h: 20 }
              }
            ]
          },
          [{ type: 'image', mimeType: 'image/png', data: PNG }]
        )
      case 'zoom':
        return ok({ width: 100, height: 50 }, [{ type: 'image', mimeType: 'image/jpeg', data: PNG }])
      case 'launch_app':
        return ok({
          windows: [
            {
              window_id: 5000,
              pid: 77,
              app_name: 'Mousepad',
              title: 'New',
              bounds: { x: 0, y: 0, width: 300, height: 200 },
              is_on_screen: true
            }
          ]
        })
      default:
        return ok({})
    }
  }
  tools(name?: string) {
    return this.calls.map((c) => c.tool).filter((t) => !name || t === name)
  }
  isClosed() {
    return this.closed
  }
  onExit(cb: () => void) {
    this.listeners.add(cb)
    return () => {
      this.listeners.delete(cb)
    }
  }
  async close() {
    this.closes++
    if (this.closeGate) await this.closeGate.promise
    if (this.failClose) throw new Error('Desktop processes did not exit')
    if (this.failCloses > 0) {
      this.failCloses--
      throw new Error('Desktop processes did not exit')
    }
    this.closed = true
  }
  /** The adapter's crash path: cleanup done, then onExit. */
  crash() {
    this.closed = true
    for (const cb of [...this.listeners]) cb()
  }
}
class FakeAdapter implements DesktopAdapter {
  instances: FakeDesktop[] = []
  launches = 0
  launching = 0
  maxSlots = 0
  gate?: Deferred<void>
  fail?: (instance: FakeDesktop) => Error | undefined
  async launch(dir: string): Promise<DesktopInstance> {
    this.launches++
    this.launching++
    this.maxSlots = Math.max(this.maxSlots, this.launching + this.instances.filter((i) => !i.closed).length)
    try {
      if (this.gate) await this.gate.promise
      const instance = new FakeDesktop(`gen${this.launches}`, dir),
        error = this.fail?.(instance)
      if (error instanceof DesktopLaunchCleanupError) this.instances.push(instance)
      if (error) throw error
      this.instances.push(instance)
      return instance
    } finally {
      this.launching--
    }
  }
}

const config: DesktopConfig = {
  max: 2,
  idleMs: 900000,
  leaseIdleMs: 120000,
  handoffIdleMs: 600000,
  commandMs: 30000,
  queueMs: 120000,
  width: 1280,
  height: 800
}
const tick = () => vi.advanceTimersByTimeAsync(0)
const signal = () => new AbortController().signal
const STALE = { ok: false, code: 'stale', message: 'The desktop changed; take a new screenshot' }
let root: string, profiles: BrowserProfileStore, adapter: FakeAdapter, manager: DesktopManager, handoffs: DesktopHandoff[], logs: string[]

const owner = async (agent: string, turnId = agent, chatId = 'chat'): Promise<DesktopOwner> => ({
  profileId: (await profiles.ensure(agent)).id,
  chatId,
  turnId
})
const viewer = (id: string) => {
  const statuses: DesktopStatus[] = []
  return {
    id,
    sessionKey: 'session',
    statuses,
    sendStatus: (status: DesktopStatus) => {
      statuses.push(status)
    },
    attach: vi.fn(),
    detach: vi.fn()
  } satisfies DesktopViewer & { statuses: DesktopStatus[] }
}
const stampOf = (result: DesktopResult): DesktopStamp => {
  if (!result.ok) throw new Error(`Observation failed: ${result.code}`)
  return (result.data as { stamp: DesktopStamp }).stamp
}
function create(overrides: Partial<DesktopConfig> = {}): DesktopManager {
  let id = 0
  return new DesktopManager({
    profiles,
    adapter,
    config: { ...config, ...overrides },
    now: Date.now,
    newId: () => `id${++id}`,
    resolveTarget: async (target) => ({ agent: target.agent, ...(await profiles.ensure(target.agent)) }),
    onHandoff: async (handoff) => {
      handoffs.push({ ...handoff })
    },
    log: (line) => {
      logs.push(line)
    }
  })
}

beforeEach(async () => {
  vi.useFakeTimers()
  root = await mkdtemp(join(tmpdir(), 'desktop-manager-'))
  profiles = new BrowserProfileStore(root, undefined, 'desktops')
  await profiles.load()
  adapter = new FakeAdapter()
  handoffs = []
  logs = []
  manager = create()
})
afterEach(async () => {
  adapter.gate?.resolve()
  adapter.fail = undefined
  for (const instance of adapter.instances) {
    instance.gate?.resolve()
    instance.closeGate?.resolve()
    instance.failClose = false
    instance.failCloses = 0
  }
  await manager.close()
  vi.useRealTimers()
  await rm(root, { recursive: true, force: true })
})

describe('desktop lifetime', () => {
  it('no desktop starts without a call or a viewer', async () => {
    const status = await manager.status('a')
    expect(status).toMatchObject({
      agent: 'a',
      state: 'stopped',
      control: 'agent',
      generation: '',
      busy: false,
      width: 1280,
      height: 800,
      pendingRequestId: null
    })
    manager.registerTurn('t', async () => {})
    await manager.endTurn('t')
    await vi.advanceTimersByTimeAsync(config.idleMs)
    expect(adapter.launches).toBe(0)
  })
  it('first call starts once for concurrent calls', async () => {
    adapter.gate = deferred<void>()
    const own = await owner('a'),
      v = viewer('v')
    const first = manager.run(own, { op: 'screenshot' }, signal())
    const second = manager.run(own, { op: 'windows' }, signal())
    const watching = manager.watch({ agent: 'a' }, v)
    await vi.waitFor(() => expect(adapter.launching).toBe(1))
    expect((await manager.status('a')).state).toBe('starting')
    adapter.gate.resolve()
    expect((await first).ok).toBe(true)
    expect((await second).ok).toBe(true)
    const subscription = await watching
    expect(adapter.launches).toBe(1)
    expect(v.attach).toHaveBeenCalledTimes(1)
    expect(v.attach).toHaveBeenCalledWith('/run/desk/gen1/vnc.sock', 'gen1')
    await subscription.close()
  })
  it('cap queues the third agent and evicts an idle desktop first', async () => {
    const a = await owner('a')
    expect((await manager.run(a, { op: 'screenshot' }, signal())).ok).toBe(true)
    await manager.run(a, { op: 'release' }, signal())
    const b = await manager.watch({ agent: 'b' }, viewer('b'))
    // a is idle (no viewer, lease or handoff), so c takes its slot at once.
    const c = await owner('c')
    expect((await manager.run(c, { op: 'screenshot' }, signal())).ok).toBe(true)
    expect(adapter.instances[0].closed).toBe(true)
    // b is watched and c's turn still holds its lease: d waits.
    const d = manager.run(await owner('d'), { op: 'screenshot' }, signal())
    await tick()
    expect((await manager.status('d')).state).toBe('queued')
    expect(adapter.launches).toBe(3)
    await manager.run(c, { op: 'release' }, signal())
    expect((await d).ok).toBe(true)
    expect(adapter.instances[2].closed).toBe(true)
    expect(adapter.launches).toBe(4)
    expect(adapter.maxSlots).toBe(2)
    await b.close()
  })
  it('queue times out with a busy result', async () => {
    const a = await manager.watch({ agent: 'a' }, viewer('a')),
      b = await manager.watch({ agent: 'b' }, viewer('b'))
    const c = manager.run(await owner('c'), { op: 'screenshot' }, signal())
    await vi.advanceTimersByTimeAsync(config.queueMs - 1)
    expect((await manager.status('c')).state).toBe('queued')
    await vi.advanceTimersByTimeAsync(1)
    expect(await c).toEqual({ ok: false, code: 'busy', message: 'The desktop is busy; try again later' })
    expect((await manager.status('c')).state).toBe('stopped')
    expect(adapter.launches).toBe(2)
    await a.close()
    await b.close()
  })
  it('idle stop after idleMs, not while a viewer watches', async () => {
    const a = await owner('a')
    await manager.run(a, { op: 'screenshot' }, signal())
    // The turn's lease lapses first, then the desktop's own idle time runs.
    await vi.advanceTimersByTimeAsync(config.leaseIdleMs + config.idleMs - 1)
    expect(adapter.instances[0].closed).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(adapter.instances[0].closed).toBe(true)
    expect((await manager.status('a')).state).toBe('stopped')
    const watched = await manager.watch({ agent: 'b' }, viewer('b'))
    await vi.advanceTimersByTimeAsync(config.idleMs * 3)
    expect(adapter.instances[1].closed).toBe(false)
    await watched.close()
    await vi.advanceTimersByTimeAsync(config.idleMs - 1)
    expect(adapter.instances[1].closed).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(adapter.instances[1].closed).toBe(true)
    expect((await stat((await profiles.ensure('a')).dir)).isDirectory()).toBe(true)
  })
  it('busy is true while a turn holds or waits for the desktop', async () => {
    const own = await owner('a'),
      v = viewer('v')
    const subscription = await manager.watch({ agent: 'a' }, v)
    expect((await manager.status('a')).busy).toBe(false)
    adapter.instances[0].gate = deferred<void>()
    const running = manager.run(own, { op: 'screenshot' }, signal())
    await tick()
    expect((await manager.status('a')).busy).toBe(true)
    expect(v.statuses.at(-1)?.busy).toBe(true)
    adapter.instances[0].gate.resolve()
    await running
    // Between calls the turn keeps its hold.
    expect((await manager.status('a')).busy).toBe(true)
    await manager.run(own, { op: 'release' }, signal())
    expect((await manager.status('a')).busy).toBe(false)
    expect(v.statuses.at(-1)?.busy).toBe(false)
    // A hold that lapses tells viewers too.
    await manager.run(own, { op: 'windows' }, signal())
    expect(v.statuses.at(-1)?.busy).toBe(true)
    await vi.advanceTimersByTimeAsync(config.leaseIdleMs)
    expect(v.statuses.at(-1)?.busy).toBe(false)
    await subscription.close()
  })
  it('one queued demand evicts one idle desktop, not two', async () => {
    await manager.close()
    manager = create({ leaseIdleMs: 1000 })
    const a = await owner('a'),
      b = await owner('b')
    await manager.run(a, { op: 'screenshot' }, signal())
    await manager.run(a, { op: 'release' }, signal())
    // b's turn still holds its lease, so only a is idle when c arrives.
    await manager.run(b, { op: 'screenshot' }, signal())
    adapter.instances[0].closeGate = deferred<void>()
    const c = manager.run(await owner('c'), { op: 'screenshot' }, signal())
    await tick()
    expect(adapter.instances[0].closes).toBe(1)
    // b's lease lapses while a is still closing: c already has a slot coming.
    await vi.advanceTimersByTimeAsync(1000)
    expect(adapter.instances[1].closes).toBe(0)
    adapter.instances[0].closeGate.resolve()
    expect((await c).ok).toBe(true)
    expect(adapter.instances[1].closed).toBe(false)
    expect(adapter.maxSlots).toBe(2)
  })
  it('lease queue times out with busy', async () => {
    await manager.close()
    manager = create({ leaseIdleMs: config.queueMs * 2 })
    const first = await owner('a', 'first'),
      second = await owner('a', 'second')
    await manager.run(first, { op: 'screenshot' }, signal())
    const waiting = manager.run(second, { op: 'screenshot' }, signal())
    await vi.advanceTimersByTimeAsync(config.queueMs)
    expect(await waiting).toEqual({ ok: false, code: 'busy', message: 'The desktop is busy; try again later' })
  })
  it('an unconfirmed close is retried at once', async () => {
    const own = await owner('a')
    await manager.run(own, { op: 'screenshot' }, signal())
    await manager.run(own, { op: 'release' }, signal())
    adapter.instances[0].failCloses = 1
    await vi.advanceTimersByTimeAsync(config.idleMs)
    expect(adapter.instances[0].closes).toBe(2)
    expect(adapter.instances[0].closed).toBe(true)
    expect(logs).toHaveLength(1)
    expect((await manager.status('a')).state).toBe('stopped')
  })
  it('at the cap the queue retries a stuck close before evicting a healthy desktop', async () => {
    const a = await owner('a')
    await manager.run(a, { op: 'screenshot' }, signal())
    await manager.run(a, { op: 'release' }, signal())
    adapter.instances[0].failClose = true
    await vi.advanceTimersByTimeAsync(config.idleMs)
    expect((await manager.status('a')).state).toBe('closing')
    const closes = adapter.instances[0].closes
    expect(logs).toHaveLength(1)
    const b = await owner('b')
    await manager.run(b, { op: 'screenshot' }, signal())
    await manager.run(b, { op: 'release' }, signal())
    adapter.instances[0].failClose = false
    const c = manager.run(await owner('c'), { op: 'screenshot' }, signal())
    await tick()
    expect(adapter.instances[0].closes).toBe(closes + 1)
    expect(adapter.instances[0].closed).toBe(true)
    expect(adapter.instances[1].closed).toBe(false)
    expect((await c).ok).toBe(true)
    expect(logs).toHaveLength(1)
  })
})

describe('observations and stamps', () => {
  it('screenshot returns a stamp; click with it calls cua once', async () => {
    const own = await owner('a')
    const shot = await manager.run(own, { op: 'screenshot' }, signal())
    expect(shot).toMatchObject({ ok: true, data: { image: { mimeType: 'image/png', base64: PNG }, width: 1280, height: 800 } })
    const stamp = stampOf(shot)
    expect(stamp).toEqual({ generation: 'gen1', epoch: expect.any(Number), observationId: expect.any(String) })
    expect(await manager.run(own, { op: 'click', stamp, x: 10, y: 20 }, signal())).toMatchObject({ ok: true })
    expect(adapter.instances[0].calls.filter((c) => c.tool === 'click')).toEqual([
      { tool: 'click', args: { scope: 'desktop', x: 10, y: 20 } }
    ])
  })
  it('click with an older observation id is stale and never reaches cua', async () => {
    const own = await owner('a')
    const older = stampOf(await manager.run(own, { op: 'screenshot' }, signal()))
    const newer = stampOf(await manager.run(own, { op: 'screenshot' }, signal()))
    expect(newer.observationId).not.toBe(older.observationId)
    expect(await manager.run(own, { op: 'click', stamp: older, x: 10, y: 20 }, signal())).toEqual(STALE)
    expect(await manager.run(own, { op: 'type', stamp: { ...newer, epoch: newer.epoch + 1 }, text: 'x' }, signal())).toEqual(STALE)
    expect(await manager.run(own, { op: 'key', stamp: { ...newer, generation: 'other' }, keys: ['enter'] }, signal())).toEqual(STALE)
    expect(adapter.instances[0].tools('click')).toHaveLength(0)
    expect(adapter.instances[0].tools('type_text')).toHaveLength(0)
    expect((await manager.run(own, { op: 'click', stamp: newer, x: 10, y: 20 }, signal())).ok).toBe(true)
    expect(adapter.instances[0].tools('click')).toHaveLength(1)
  })
  it('zoom, windows and apps do not replace the observation', async () => {
    const own = await owner('a')
    const stamp = stampOf(await manager.run(own, { op: 'screenshot' }, signal()))
    expect(await manager.run(own, { op: 'windows' }, signal())).toMatchObject({
      ok: true,
      data: { windows: [{ windowId: WINDOW, app: 'Mousepad' }] }
    })
    expect(await manager.run(own, { op: 'apps' }, signal())).toEqual({ ok: true, data: { apps: [{ name: 'Mousepad', running: false }] } })
    const zoom = await manager.run(own, { op: 'zoom', windowId: WINDOW, x1: 0, y1: 0, x2: 100, y2: 50 }, signal())
    expect(zoom).toMatchObject({ ok: true, data: { image: { mimeType: 'image/jpeg' } } })
    expect((zoom as { data: Record<string, unknown> }).data.stamp).toBeUndefined()
    expect((await manager.run(own, { op: 'move', stamp, x: 1, y: 1 }, signal())).ok).toBe(true)
  })
  it('lease lost while card pending voids the stamp', async () => {
    const first = await owner('a', 'turnA', 'chat1'),
      second = await owner('a', 'turnB', 'chat2')
    const stamp = stampOf(await manager.run(first, { op: 'screenshot' }, signal()))
    // The approval card waits longer than the lease lasts; another chat uses the desktop meanwhile.
    await vi.advanceTimersByTimeAsync(config.leaseIdleMs)
    expect((await manager.run(second, { op: 'screenshot' }, signal())).ok).toBe(true)
    await manager.run(second, { op: 'release' }, signal())
    expect(await manager.run(first, { op: 'click', stamp, x: 10, y: 20 }, signal())).toEqual(STALE)
    expect(adapter.instances[0].tools('click')).toHaveLength(0)
    expect(adapter.launches).toBe(1)
  })
  it('a lapsed lease voids the stamp even when the other turn only listed windows', async () => {
    const first = await owner('a', 'turnA', 'chat1'),
      second = await owner('a', 'turnB', 'chat2')
    const stamp = stampOf(await manager.run(first, { op: 'screenshot' }, signal()))
    await vi.advanceTimersByTimeAsync(config.leaseIdleMs)
    expect((await manager.run(second, { op: 'windows' }, signal())).ok).toBe(true)
    await manager.run(second, { op: 'release' }, signal())
    expect(await manager.run(first, { op: 'click', stamp, x: 10, y: 20 }, signal())).toEqual(STALE)
    expect(adapter.instances[0].tools('click')).toHaveLength(0)
  })
  it('a lapsed lease voids the stamp with no other turn in between', async () => {
    const own = await owner('a')
    const stamp = stampOf(await manager.run(own, { op: 'screenshot' }, signal()))
    await vi.advanceTimersByTimeAsync(config.leaseIdleMs)
    expect(await manager.run(own, { op: 'click', stamp, x: 10, y: 20 }, signal())).toEqual(STALE)
    expect(adapter.instances[0].tools('click')).toHaveLength(0)
  })
  it('element token maps to the cua token of the latest window state', async () => {
    const own = await owner('a')
    const firstState = await manager.run(own, { op: 'windowState', windowId: WINDOW }, signal())
    expect(firstState).toMatchObject({
      ok: true,
      data: { windowId: WINDOW, title: 'Untitled', elements: [{ id: 'e1', role: 'button', label: 'Save' }] }
    })
    expect(JSON.stringify(firstState)).not.toContain('s00000001')
    const older = stampOf(firstState)
    const newer = stampOf(await manager.run(own, { op: 'windowState', windowId: WINDOW }, signal()))
    const instance = adapter.instances[0]
    expect(await manager.run(own, { op: 'click', stamp: older, element: 'e1' }, signal())).toEqual(STALE)
    expect(await manager.run(own, { op: 'click', stamp: newer, element: 'e9' }, signal())).toEqual(STALE)
    expect(instance.tools('click')).toHaveLength(0)
    expect((await manager.run(own, { op: 'click', stamp: newer, element: 'e1' }, signal())).ok).toBe(true)
    expect(instance.calls.filter((c) => c.tool === 'click').map((c) => c.args)).toEqual([{ element_token: 's00000002:3' }])
    // A screenshot is a newer observation: the window state's elements are void.
    const shot = stampOf(await manager.run(own, { op: 'screenshot' }, signal()))
    expect(await manager.run(own, { op: 'click', stamp: shot, element: 'e1' }, signal())).toEqual(STALE)
  })
  it('unknown window ids refresh the window list once', async () => {
    const own = await owner('a')
    expect((await manager.run(own, { op: 'windowState', windowId: WINDOW }, signal())).ok).toBe(true)
    const instance = adapter.instances[0]
    expect(instance.tools()).toEqual(['list_windows', 'get_window_state'])
    expect(instance.calls[1].args).toEqual({ pid: 4242, window_id: WINDOW, tree_format: 'elements' })
    expect(await manager.run(own, { op: 'windowState', windowId: 999 }, signal())).toMatchObject({ ok: false, code: 'unknown_window' })
    expect(instance.tools()).toEqual(['list_windows', 'get_window_state', 'list_windows'])
    // A known id needs no refresh.
    const stamp = stampOf(await manager.run(own, { op: 'screenshot' }, signal()))
    expect((await manager.run(own, { op: 'focus', stamp, windowId: WINDOW }, signal())).ok).toBe(true)
    expect(instance.calls.at(-1)).toEqual({ tool: 'bring_to_front', args: { pid: 4242, window_id: WINDOW } })
    expect(instance.tools('list_windows')).toHaveLength(2)
  })
  it('launch takes only a name from the filtered app list, refreshing it when unknown', async () => {
    const own = await owner('a')
    const stamp = stampOf(await manager.run(own, { op: 'screenshot' }, signal()))
    expect(await manager.run(own, { op: 'launch', stamp, name: 'bash' }, signal())).toMatchObject({ ok: false, code: 'unknown_app' })
    expect(await manager.run(own, { op: 'launch', stamp, name: 'Mousepad' }, signal())).toMatchObject({ ok: true, data: { done: true } })
    const instance = adapter.instances[0]
    expect(instance.tools()).toEqual(['get_desktop_state', 'list_apps', 'launch_app'])
    expect(instance.calls.at(-1)?.args).toEqual({ name: 'Mousepad' })
    // The launched window is known without another list_windows.
    expect((await manager.run(own, { op: 'focus', stamp, windowId: 5000 }, signal())).ok).toBe(true)
    expect(instance.calls.at(-1)).toEqual({ tool: 'bring_to_front', args: { pid: 77, window_id: 5000 } })
  })
  it('coordinates outside the real desktop and empty zoom regions never reach cua', async () => {
    const own = await owner('a')
    const stamp = stampOf(await manager.run(own, { op: 'screenshot' }, signal()))
    expect(await manager.run(own, { op: 'click', stamp, x: 1500, y: 10 }, signal())).toMatchObject({ ok: false, code: 'out_of_bounds' })
    expect(await manager.run(own, { op: 'drag', stamp, fromX: 1, fromY: 1, toX: 10, toY: 900 }, signal())).toMatchObject({
      ok: false,
      code: 'out_of_bounds'
    })
    expect(await manager.run(own, { op: 'zoom', windowId: WINDOW, x1: 10, y1: 0, x2: 10, y2: 50 }, signal())).toMatchObject({
      ok: false,
      code: 'out_of_bounds'
    })
    expect(await manager.run(own, { op: 'zoom', windowId: WINDOW, x1: 0, y1: 0, x2: 700, y2: 50 }, signal())).toMatchObject({
      ok: false,
      code: 'out_of_bounds'
    })
    expect(adapter.instances[0].tools().filter((t) => t !== 'get_desktop_state' && t !== 'list_windows')).toEqual([])
    // The stamp is still the current one.
    expect((await manager.run(own, { op: 'click', stamp, x: 1279, y: 799 }, signal())).ok).toBe(true)
  })
  it('runs plan calls in order, retries once on the retry code and stops at the first failure', async () => {
    const own = await owner('a')
    const stamp = stampOf(await manager.run(own, { op: 'windowState', windowId: WINDOW }, signal()))
    const instance = adapter.instances[0]
    instance.replies.click = (args) => (args.delivery_mode === 'foreground' ? ok({}) : refused('background_unavailable'))
    expect((await manager.run(own, { op: 'type', stamp, element: 'e1', text: 'مرحبا' }, signal())).ok).toBe(true)
    expect(instance.calls.slice(-3)).toEqual([
      { tool: 'click', args: { element_token: 's00000001:3' } },
      { tool: 'click', args: { element_token: 's00000001:3', delivery_mode: 'foreground' } },
      { tool: 'type_text', args: { scope: 'desktop', text: 'مرحبا' } }
    ])
    instance.replies.click = () => refused('element_not_found')
    expect(await manager.run(own, { op: 'type', stamp, element: 'e1', text: 'x' }, signal())).toEqual({
      ok: false,
      code: 'element_not_found',
      message: 'The element is stale; call desktop_window_state again'
    })
    expect(instance.tools('type_text')).toHaveLength(1)
  })
  it('a hung cua call times out and stops the desktop', async () => {
    const own = await owner('a')
    await manager.run(own, { op: 'screenshot' }, signal())
    adapter.instances[0].gate = deferred<void>()
    const hung = manager.run(own, { op: 'windows' }, signal())
    await vi.advanceTimersByTimeAsync(config.commandMs)
    expect(await hung).toMatchObject({ ok: false, code: 'command_timeout' })
    expect(adapter.instances[0].closed).toBe(true)
    expect((await manager.run(own, { op: 'screenshot' }, signal())).ok).toBe(true)
    expect(adapter.instances[1].generation).toBe('gen2')
  })
  it('a Stop during a cua call lets that call finish, sends nothing more and keeps the desktop', async () => {
    const own = await owner('a'),
      v = viewer('v')
    await manager.watch({ agent: 'a' }, v)
    const stamp = stampOf(await manager.run(own, { op: 'windowState', windowId: WINDOW }, signal()))
    const instance = adapter.instances[0]
    instance.gate = deferred<void>()
    const abort = new AbortController()
    let settled = false
    const stopped = manager.run(own, { op: 'type', stamp, element: 'e1', text: 'hello' }, abort.signal).then((result) => {
      settled = true
      return result
    })
    await tick()
    expect(instance.tools('click')).toHaveLength(1)
    abort.abort()
    await tick()
    expect(settled).toBe(false)
    // A takeover still waits for the call cua is running.
    let controlled = false
    const control = manager.takeControl('v').then(() => {
      controlled = true
    })
    await tick()
    expect(controlled).toBe(false)
    instance.gate.resolve()
    expect(await stopped).toEqual({ ok: false, code: 'cancelled', message: 'Desktop request cancelled' })
    await control
    expect(manager.canInput('v')).toBe(true)
    expect(instance.tools('type_text')).toHaveLength(0)
    expect(instance.closed).toBe(false)
    expect(adapter.launches).toBe(1)
  })
  it('a Stop voids the stamp even when the call was only looking', async () => {
    const own = await owner('a')
    const stamp = stampOf(await manager.run(own, { op: 'screenshot' }, signal()))
    const instance = adapter.instances[0]
    instance.gate = deferred<void>()
    const abort = new AbortController()
    const stopped = manager.run(own, { op: 'windows' }, abort.signal)
    await tick()
    abort.abort()
    instance.gate.resolve()
    expect(await stopped).toMatchObject({ ok: false, code: 'cancelled' })
    instance.gate = undefined
    expect(await manager.run(own, { op: 'click', stamp, x: 1, y: 1 }, signal())).toEqual(STALE)
    expect(instance.closed).toBe(false)
  })
  it('a turn end whose cua call hangs past commandMs stops the desktop', async () => {
    const own = await owner('a')
    await manager.run(own, { op: 'screenshot' }, signal())
    adapter.instances[0].gate = deferred<void>()
    const stopped = manager.run(own, { op: 'windows' }, signal())
    await tick()
    await manager.endTurn(own.turnId)
    await vi.advanceTimersByTimeAsync(config.commandMs - 1)
    expect(adapter.instances[0].closed).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(await stopped).toMatchObject({ ok: false, code: 'cancelled' })
    expect(adapter.instances[0].closed).toBe(true)
  })
})

describe('watching and control', () => {
  it('control wait does not hit the queue timeout', async () => {
    const own = await owner('a'),
      v = viewer('v')
    await manager.watch({ agent: 'a' }, v)
    await manager.takeControl('v')
    expect(manager.canInput('v')).toBe(true)
    let settled = false
    const waiting = manager.run(own, { op: 'screenshot' }, signal()).then((result) => {
      settled = true
      return result
    })
    await vi.advanceTimersByTimeAsync(config.queueMs * 3)
    expect(settled).toBe(false)
    expect(adapter.instances[0].tools()).toEqual([])
    await manager.releaseControl('v')
    expect(manager.canInput('v')).toBe(false)
    expect((await waiting).ok).toBe(true)
  })
  it('a stopped turn ends the control wait', async () => {
    await manager.watch({ agent: 'a' }, viewer('v'))
    await manager.takeControl('v')
    const own = await owner('a'),
      abort = new AbortController()
    const waiting = manager.run(own, { op: 'screenshot' }, abort.signal)
    await tick()
    abort.abort()
    expect(await waiting).toMatchObject({ ok: false, code: 'cancelled' })
    const ending = manager.run(own, { op: 'screenshot' }, signal())
    await tick()
    await manager.endTurn(own.turnId)
    expect(await ending).toMatchObject({ ok: false, code: 'cancelled' })
  })
  it('a turn keeps no entry once it ended, and ending an unknown turn makes none', async () => {
    const turns = (manager as unknown as { turns: Map<string, AbortController> }).turns
    await manager.endTurn('never-ran')
    expect(turns.size).toBe(0)
    const own = await owner('a')
    await manager.watch({ agent: 'a' }, viewer('v'))
    await manager.takeControl('v')
    // Waits for control, so the turn's entry exists while it is in flight.
    const waiting = manager.run(own, { op: 'screenshot' }, signal())
    await tick()
    expect(turns.has(own.turnId)).toBe(true)
    await manager.endTurn(own.turnId)
    expect(await waiting).toMatchObject({ ok: false, code: 'cancelled' })
    expect(turns.size).toBe(0)
  })
  it('takeControl waits for the in-flight call', async () => {
    const own = await owner('a'),
      v = viewer('v')
    await manager.watch({ agent: 'a' }, v)
    const instance = adapter.instances[0]
    instance.gate = deferred<void>()
    const running = manager.run(own, { op: 'screenshot' }, signal())
    await tick()
    let controlled = false
    const control = manager.takeControl('v').then(() => {
      controlled = true
    })
    await tick()
    expect(controlled).toBe(false)
    expect(manager.canInput('v')).toBe(false)
    expect(v.statuses.at(-1)?.control).toBe('pausing')
    instance.gate.resolve()
    expect((await running).ok).toBe(true)
    await control
    expect(manager.canInput('v')).toBe(true)
    expect(v.statuses.at(-1)?.control).toBe('you')
  })
  it('a take right after a release, while an agent call drains, waits for the release and ends in control', async () => {
    const own = await owner('a'),
      v = viewer('v')
    await manager.watch({ agent: 'a' }, v)
    const instance = adapter.instances[0]
    instance.gate = deferred<void>()
    const running = manager.run(own, { op: 'screenshot' }, signal())
    await tick()
    const first = manager.takeControl('v'),
      release = manager.releaseControl('v'),
      second = manager.takeControl('v')
    await tick()
    instance.gate.resolve()
    expect((await running).ok).toBe(true)
    await Promise.all([first, release, second])
    expect(manager.canInput('v')).toBe(true)
    expect(v.statuses.at(-1)?.control).toBe('you')
  })
  it('other viewers see "other" while a controller takes, holds and releases control', async () => {
    const own = await owner('a'),
      one = viewer('one'),
      two = viewer('two')
    await manager.watch({ agent: 'a' }, one)
    await manager.watch({ agent: 'a' }, two)
    const instance = adapter.instances[0]
    instance.gate = deferred<void>()
    const running = manager.run(own, { op: 'screenshot' }, signal())
    await tick()
    const taking = manager.takeControl('one')
    await tick()
    expect(one.statuses.at(-1)?.control).toBe('pausing')
    expect(two.statuses.at(-1)?.control).toBe('other')
    expect((await manager.status('a')).control).toBe('other')
    instance.gate.resolve()
    await running
    await taking
    expect(one.statuses.at(-1)?.control).toBe('you')
    expect(two.statuses.at(-1)?.control).toBe('other')
    const seen = two.statuses.length
    await manager.releaseControl('one')
    expect(two.statuses.slice(seen).map((s) => s.control)).toEqual(['other', 'agent'])
    expect(one.statuses.at(-1)?.control).toBe('agent')
  })
  it('second viewer cannot take control while the first holds it', async () => {
    const one = viewer('one'),
      two = viewer('two')
    await manager.watch({ agent: 'a' }, one)
    await manager.watch({ agent: 'a' }, two)
    await manager.takeControl('one')
    await expect(manager.takeControl('two')).rejects.toThrow('controlled by another viewer')
    expect(manager.canInput('two')).toBe(false)
    expect(manager.canInput('one')).toBe(true)
    expect(two.statuses.at(-1)?.control).toBe('other')
    expect(one.statuses.at(-1)?.control).toBe('you')
    await expect(manager.releaseControl('two')).resolves.toBeUndefined()
    expect(manager.canInput('one')).toBe(true)
  })
  it('release voids the observation', async () => {
    const own = await owner('a')
    await manager.watch({ agent: 'a' }, viewer('v'))
    const stamp = stampOf(await manager.run(own, { op: 'screenshot' }, signal()))
    await manager.takeControl('v')
    await manager.releaseControl('v')
    expect(await manager.run(own, { op: 'click', stamp, x: 10, y: 20 }, signal())).toEqual(STALE)
    const fresh = stampOf(await manager.run(own, { op: 'screenshot' }, signal()))
    expect(fresh.epoch).toBe(stamp.epoch)
    expect((await manager.run(own, { op: 'click', stamp: fresh, x: 10, y: 20 }, signal())).ok).toBe(true)
  })
  it('closing the viewer releases its control', async () => {
    const own = await owner('a'),
      v = viewer('v')
    const subscription = await manager.watch({ agent: 'a' }, v)
    await manager.takeControl('v')
    const waiting = manager.run(own, { op: 'screenshot' }, signal())
    await subscription.close()
    expect(v.detach).toHaveBeenCalledTimes(1)
    expect(manager.canInput('v')).toBe(false)
    expect((await waiting).ok).toBe(true)
  })
  it('crashed desktop restarts on next call and voids stamps', async () => {
    const own = await owner('a'),
      v = viewer('v')
    await manager.watch({ agent: 'a' }, v)
    const stamp = stampOf(await manager.run(own, { op: 'screenshot' }, signal()))
    await manager.takeControl('v')
    adapter.instances[0].crash()
    await tick()
    expect(v.detach).toHaveBeenCalledTimes(1)
    expect(manager.canInput('v')).toBe(false)
    expect(v.statuses.at(-1)).toMatchObject({ state: 'stopped', control: 'agent' })
    expect(await manager.run(own, { op: 'click', stamp, x: 10, y: 20 }, signal())).toEqual(STALE)
    expect(adapter.launches).toBe(1)
    const fresh = stampOf(await manager.run(own, { op: 'screenshot' }, signal()))
    expect(fresh.generation).toBe('gen2')
    expect(v.attach).toHaveBeenLastCalledWith('/run/desk/gen2/vnc.sock', 'gen2')
    expect(v.statuses.at(-1)).toMatchObject({ state: 'ready', generation: 'gen2', error: null })
    expect(await manager.run(own, { op: 'click', stamp, x: 10, y: 20 }, signal())).toEqual(STALE)
    expect(adapter.instances[1].tools('click')).toHaveLength(0)
  })
  it('a call in flight when the desktop crashes says it restarted', async () => {
    const own = await owner('a')
    await manager.run(own, { op: 'screenshot' }, signal())
    const instance = adapter.instances[0]
    instance.replies.list_windows = () => {
      instance.crash()
      throw new Error('Desktop command did not complete')
    }
    expect(await manager.run(own, { op: 'windows' }, signal())).toMatchObject({ ok: false, code: 'desktop_restarted' })
  })
})

describe('handoffs and agents', () => {
  it('handoff pending blocks other calls with waiting_for_user; done resolves the tool', async () => {
    const own = await owner('a')
    const pending = manager.run(own, { op: 'requestUserAction', reason: 'Sign in please' }, signal())
    await tick()
    expect(handoffs[0]).toMatchObject({
      profileId: own.profileId,
      chatId: 'chat',
      turnId: 'a',
      generation: 'gen1',
      site: '',
      reason: 'Sign in please',
      agent: 'a',
      status: 'pending'
    })
    expect(await manager.run(own, { op: 'screenshot' }, signal())).toMatchObject({ ok: false, code: 'waiting_for_user' })
    expect((await manager.run(await owner('b'), { op: 'screenshot' }, signal())).ok).toBe(true)
    // The pending handoff keeps the desktop and the lease past both idle limits.
    await vi.advanceTimersByTimeAsync(config.leaseIdleMs * 2)
    expect(adapter.instances[0].closed).toBe(false)
    const v = viewer('v')
    await manager.watch({ agent: 'a' }, v)
    expect(v.statuses.at(-1)?.pendingRequestId).toBe(handoffs[0].id)
    await manager.takeControl('v')
    await manager.answer('v', handoffs[0].id, 'done')
    expect(await pending).toEqual({ ok: true, data: { status: 'done' } })
    expect(manager.canInput('v')).toBe(false)
    expect(handoffs.at(-1)?.status).toBe('done')
    expect((await manager.run(own, { op: 'screenshot' }, signal())).ok).toBe(true)
  })
  it('cancelled and unattended handoffs fail with desktop wording', async () => {
    const own = await owner('a')
    const cancelled = manager.run(own, { op: 'requestUserAction', reason: 'Help' }, signal())
    await tick()
    const subscription = await manager.watch({ agent: 'a' }, viewer('v'))
    await expect(manager.answer('v', 'other-request', 'done')).rejects.toThrow()
    await manager.answer('v', handoffs[0].id, 'cancel')
    expect(await cancelled).toEqual({ ok: false, code: 'handoff_cancelled', message: 'Desktop request cancelled' })
    await subscription.close()
    const expired = manager.run(own, { op: 'requestUserAction', reason: 'Help' }, signal())
    await vi.advanceTimersByTimeAsync(config.handoffIdleMs)
    expect(await expired).toEqual({ ok: false, code: 'handoff_expired', message: 'Desktop request expired' })
  })
  it('busy is false while only a handoff is pending', async () => {
    const own = await owner('a'),
      v = viewer('v')
    await manager.watch({ agent: 'a' }, v)
    const pending = manager.run(own, { op: 'requestUserAction', reason: 'Help' }, signal())
    await tick()
    expect(v.statuses.at(-1)).toMatchObject({ busy: false, pendingRequestId: handoffs[0].id })
    expect((await manager.status('a')).busy).toBe(false)
    await manager.answer('v', handoffs[0].id, 'done')
    await pending
    expect(v.statuses.at(-1)).toMatchObject({ busy: true, pendingRequestId: null })
  })
  it('answering a stale request launches nothing', async () => {
    const card = viewer('card')
    await manager.connect({ agent: 'a' }, card)
    expect(card.statuses.at(-1)).toMatchObject({ state: 'stopped', pendingRequestId: null })
    await expect(manager.answer('card', 'request9', 'done')).rejects.toThrow('Stale desktop action request')
    expect(adapter.launches).toBe(0)
    // A handoff that ended, on a desktop that stopped since.
    const own = await owner('a')
    const pending = manager.run(own, { op: 'requestUserAction', reason: 'Help' }, signal())
    await tick()
    await manager.endTurn(own.turnId)
    expect(await pending).toMatchObject({ ok: false, code: 'handoff_interrupted' })
    await vi.advanceTimersByTimeAsync(config.idleMs)
    expect(adapter.instances[0].closed).toBe(true)
    await expect(manager.answer('card', handoffs[0].id, 'done')).rejects.toThrow('Stale desktop action request')
    expect(adapter.launches).toBe(1)
    expect(card.attach).not.toHaveBeenCalled()
  })
  it('a connect-only viewer answers a pending handoff without watching', async () => {
    const own = await owner('a'),
      card = viewer('card')
    const pending = manager.run(own, { op: 'requestUserAction', reason: 'Help' }, signal())
    await tick()
    await manager.connect({ agent: 'a' }, card)
    expect(card.statuses.at(-1)?.pendingRequestId).toBe(handoffs[0].id)
    await expect(manager.takeControl('card')).rejects.toThrow()
    expect(manager.canInput('card')).toBe(false)
    await manager.answer('card', handoffs[0].id, 'done')
    expect(await pending).toEqual({ ok: true, data: { status: 'done' } })
    expect(card.attach).not.toHaveBeenCalled()
    expect(adapter.launches).toBe(1)
  })
  it('a connect-only viewer starts, queues and keeps alive nothing', async () => {
    const subscription = await manager.connect({ agent: 'b' }, viewer('card'))
    expect(adapter.launches).toBe(0)
    expect((await manager.status('b')).state).toBe('stopped')
    // It does not count as watching: an unattended handoff still expires, and the desktop still idles out.
    const own = await owner('a')
    await manager.connect({ agent: 'a' }, viewer('cardA'))
    const pending = manager.run(own, { op: 'requestUserAction', reason: 'Help' }, signal())
    await vi.advanceTimersByTimeAsync(config.handoffIdleMs)
    expect(await pending).toMatchObject({ ok: false, code: 'handoff_expired' })
    await manager.endTurn(own.turnId)
    await vi.advanceTimersByTimeAsync(config.idleMs)
    expect(adapter.instances[0].closed).toBe(true)
    expect(adapter.launches).toBe(1)
    await subscription.close()
  })
  it('rename keeps the desktop; removeAgents stops it; clear deletes the dir', async () => {
    const own = await owner('a'),
      dir = (await profiles.ensure('a')).dir
    await manager.run(own, { op: 'screenshot' }, signal())
    await manager.renameAgent('a', 'renamed')
    expect(await manager.status('renamed')).toMatchObject({
      agent: 'renamed',
      profileId: own.profileId,
      generation: 'gen1',
      state: 'ready'
    })
    expect(adapter.instances[0].closed).toBe(false)
    expect((await manager.run(own, { op: 'windows' }, signal())).ok).toBe(true)
    await manager.removeAgents(['renamed'])
    expect(adapter.instances[0].closed).toBe(true)
    expect((await stat(dir)).isDirectory()).toBe(true)
    expect(await manager.run(own, { op: 'screenshot' }, signal())).toMatchObject({ ok: false, code: 'stale_profile' })
    const b = await owner('b'),
      bDir = (await profiles.ensure('b')).dir
    await manager.run(b, { op: 'screenshot' }, signal())
    await manager.clear('b')
    expect(adapter.instances[1].closed).toBe(true)
    await expect(stat(bDir)).rejects.toThrow()
    expect((await manager.status('b')).profileId).not.toBe(b.profileId)
    expect(await manager.run(b, { op: 'screenshot' }, signal())).toMatchObject({ ok: false, code: 'stale_profile' })
  })
  it('clear detaches viewers and sends them the final status', async () => {
    const v = viewer('v')
    await manager.watch({ agent: 'a' }, v)
    await manager.takeControl('v')
    await manager.clear('a')
    expect(v.detach).toHaveBeenCalledTimes(1)
    expect(v.statuses.at(-1)).toMatchObject({ state: 'stopped', control: 'agent' })
    expect(manager.canInput('v')).toBe(false)
    await expect(manager.takeControl('v')).rejects.toThrow()
  })
  it('unavailable runtime gives state unavailable with missing list and a failed result', async () => {
    adapter.fail = () => new DesktopUnavailableError(['TigerVNC (Xvnc)', 'cua-driver'])
    const v = viewer('v')
    await expect(manager.watch({ agent: 'a' }, v)).rejects.toThrow('Desktop unavailable')
    expect(v.statuses.at(-1)).toMatchObject({ state: 'unavailable', missing: ['TigerVNC (Xvnc)', 'cua-driver'] })
    expect(await manager.run(await owner('a'), { op: 'screenshot' }, signal())).toEqual({
      ok: false,
      code: 'unavailable',
      message: 'Desktop unavailable on this server'
    })
    expect(await manager.status('a')).toMatchObject({
      state: 'unavailable',
      missing: ['TigerVNC (Xvnc)', 'cua-driver'],
      error: 'Desktop unavailable on this server'
    })
    expect(adapter.instances).toHaveLength(0)
    // Once the programs are there, the next call starts it.
    adapter.fail = undefined
    expect((await manager.run(await owner('a'), { op: 'screenshot' }, signal())).ok).toBe(true)
    expect('missing' in (await manager.status('a'))).toBe(false)
  })
  it('launch cleanup error keeps the slot and logs', async () => {
    adapter.fail = (instance) => {
      adapter.fail = undefined
      instance.failClose = true
      return new DesktopLaunchCleanupError(instance)
    }
    expect(await manager.run(await owner('a'), { op: 'screenshot' }, signal())).toMatchObject({ ok: false, code: 'start_failed' })
    expect((await manager.status('a')).state).toBe('closing')
    expect(logs).toHaveLength(1)
    expect(logs[0]).toContain('"a"')
    const b = await manager.watch({ agent: 'b' }, viewer('b'))
    const c = manager.run(await owner('c'), { op: 'screenshot' }, signal())
    await tick()
    expect(adapter.launches).toBe(2)
    expect((await manager.status('c')).state).toBe('queued')
    adapter.instances[0].failClose = false
    await manager.clear('a')
    expect((await c).ok).toBe(true)
    expect(adapter.maxSlots).toBe(2)
    await b.close()
  })
  it('a rejected close keeps the slot, logs, and is retried by the next call', async () => {
    const own = await owner('a')
    await manager.run(own, { op: 'screenshot' }, signal())
    await manager.run(own, { op: 'release' }, signal())
    adapter.instances[0].failClose = true
    await vi.advanceTimersByTimeAsync(config.idleMs)
    expect(await manager.status('a')).toMatchObject({ state: 'closing', error: 'The desktop could not be stopped safely' })
    expect(logs).toHaveLength(1)
    expect(logs[0]).toContain('"a"')
    adapter.instances[0].failClose = false
    expect((await manager.run(own, { op: 'screenshot' }, signal())).ok).toBe(true)
    expect(adapter.instances[0].closed).toBe(true)
    expect(adapter.maxSlots).toBe(1)
  })
  it('close stops all desktops', async () => {
    await manager.run(await owner('a'), { op: 'screenshot' }, signal())
    const v = viewer('v')
    await manager.watch({ agent: 'b' }, v)
    await manager.close()
    expect(adapter.instances.map((i) => i.closed)).toEqual([true, true])
    expect(v.detach).toHaveBeenCalledTimes(1)
    expect(await manager.run(await owner('a'), { op: 'screenshot' }, signal())).toMatchObject({ ok: false, code: 'unavailable' })
    await expect(manager.watch({ agent: 'a' }, viewer('w'))).rejects.toThrow()
  })
})
