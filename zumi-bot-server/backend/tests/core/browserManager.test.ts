import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BrowserManager, type BrowserManagerDependencies } from '../../src/core/browser/browserManager'
import { BrowserProfileStore } from '../../src/core/browser/profileStore'
import { loadBrowserConfig } from '../../src/core/browser/config'
import type { BrowserHandoff, BrowserOwner, BrowserResult, BrowserStamp, BrowserStatus, BrowserViewer } from '../../src/core/browser/types'
import type { VaultItem, VaultStatus } from '@zumibot/shared/vault'
import { BrowserLaunchCleanupError } from '../../src/core/browser/types'
import { SHOT_REFUSALS } from '../../src/core/browser/browserShots'
import { deferred, FAKE_PNG, FakeBrowserAdapter } from '../support/fakeBrowser'
const tick = () => vi.advanceTimersByTimeAsync(0)
const signal = () => new AbortController().signal
let root: string, profiles: BrowserProfileStore, adapter: FakeBrowserAdapter, manager: BrowserManager, handoffs: BrowserHandoff[]
const owner = async (agent: string, turnId = agent): Promise<BrowserOwner> => ({
  profileId: (await profiles.ensure(agent)).id,
  chatId: 'chat',
  turnId
})
const viewer = (id: string) => {
  const statuses: BrowserStatus[] = []
  return {
    id,
    sessionKey: 'session',
    sendStatus: (status: BrowserStatus) => {
      statuses.push(status)
    },
    sendFrame: vi.fn(),
    statuses
  } satisfies BrowserViewer & { statuses: BrowserStatus[] }
}
beforeEach(async () => {
  vi.useFakeTimers()
  root = await mkdtemp(join(tmpdir(), 'browser-manager-'))
  profiles = new BrowserProfileStore(root)
  await profiles.load()
  adapter = new FakeBrowserAdapter()
  handoffs = []
  let id = 0
  manager = new BrowserManager({
    profiles,
    adapter,
    config: loadBrowserConfig({}),
    now: Date.now,
    newId: () => `request${++id}`,
    resolveTarget: async (target) => ({ agent: target.agent, ...(await profiles.ensure(target.agent)) }),
    onHandoff: async (handoff) => {
      handoffs.push({ ...handoff })
    }
  })
})
afterEach(async () => {
  for (const instance of adapter.instances) instance.closeGate?.resolve()
  adapter.launchGate?.resolve()
  await manager.close()
  vi.useRealTimers()
  await rm(root, { recursive: true, force: true })
})
describe('ownership period reference boundary', () => {
  it.each(['release', 'inactivity'] as const)(
    'rejects same-turn old stamps after %s while a viewer keeps the generation alive',
    async (reason) => {
      const own = await owner('a'),
        subscription = await manager.watch({ agent: 'a' }, viewer('v'))
      const observation = await manager.run(own, { op: 'observe' }, signal())
      if (!observation.ok) throw Error('Observation failed')
      const stamp = (observation.data as { stamp: BrowserStamp }).stamp
      const instance = adapter.instances[0]
      if (reason === 'release') await manager.run(own, { op: 'release' }, signal())
      else await vi.advanceTimersByTimeAsync(120000)
      instance.invalidateGate = deferred<void>()
      const clicking = manager.run(own, { op: 'click', stamp, ref: 'e1' }, signal())
      await tick()
      expect(instance.commands.map((command) => command.op)).toEqual(['observe'])
      instance.invalidateGate.resolve()
      expect(await clicking).toMatchObject({ ok: false, code: 'stale_ref' })
      expect(adapter.instances).toHaveLength(1)
      expect(instance.closed).toBe(false)
      expect(instance.observations).toBe(1)
      const fresh = await manager.run(own, { op: 'observe' }, signal())
      if (!fresh.ok) throw Error('Observation failed')
      expect(
        await manager.run(own, { op: 'click', stamp: (fresh.data as { stamp: BrowserStamp }).stamp, ref: 'e1' }, signal())
      ).toMatchObject({ ok: true })
      expect(instance.observations).toBe(1)
      await subscription.close()
    }
  )
  it('retains references across uninterrupted same-turn commands', async () => {
    const own = await owner('a'),
      observation = await manager.run(own, { op: 'observe' }, signal())
    if (!observation.ok) throw Error('Observation failed')
    const stamp = (observation.data as { stamp: BrowserStamp }).stamp
    for (let n = 0; n < 3; n++) expect(await manager.run(own, { op: 'click', stamp, ref: 'e1' }, signal())).toMatchObject({ ok: true })
    expect(adapter.instances[0].observations).toBe(0)
  })
})
describe('lazy browser lifecycle', () => {
  it.each(['release-first', 'viewer-first'] as const)('closes promptly after the final owner and viewer leave: %s', async (order) => {
    const own = await owner('a'),
      subscription = await manager.watch({ agent: 'a' }, viewer('v'))
    await manager.run(own, { op: 'observe' }, signal())
    if (order === 'release-first') {
      await manager.run(own, { op: 'release' }, signal())
      expect(adapter.instances[0].closed).toBe(false)
      await subscription.close()
    } else {
      await subscription.close()
      expect(adapter.instances[0].closed).toBe(false)
      await manager.run(own, { op: 'release' }, signal())
    }
    await tick()
    expect(adapter.instances[0].closed).toBe(true)
    expect((await stat((await profiles.ensure('a')).dir)).isDirectory()).toBe(true)
  })
  it('closes promptly when the owning turn ends without a viewer', async () => {
    const own = await owner('a')
    await manager.run(own, { op: 'observe' }, signal())
    await manager.endTurn(own.turnId)
    await tick()
    expect(adapter.instances[0].closed).toBe(true)
  })
  it('closes a viewer-only browser after manual control drains', async () => {
    const sub = await manager.watch({ agent: 'a' }, viewer('v'))
    await manager.takeControl('v')
    const instance = adapter.instances[0]
    instance.invalidateGate = deferred<void>()
    const closing = sub.close()
    await tick()
    expect(instance.closed).toBe(false)
    instance.invalidateGate.resolve()
    await closing
    await tick()
    expect(instance.closed).toBe(true)
  })
  it('closes at ownership expiry even when the browser idle deadline is later', async () => {
    await manager.close()
    manager = new BrowserManager({
      profiles,
      adapter,
      config: { ...loadBrowserConfig({}), leaseIdleMs: 1000 },
      now: Date.now,
      newId: () => 'request',
      resolveTarget: async (target) => ({ agent: target.agent, ...(await profiles.ensure(target.agent)) }),
      onHandoff: async () => {}
    })
    await manager.run(await owner('a'), { op: 'observe' }, signal())
    await vi.advanceTimersByTimeAsync(999)
    expect(adapter.instances[0].closed).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(adapter.instances[0].closed).toBe(true)
  })
  it('hands ownership directly to queued commands without retiring their generation', async () => {
    const first = await owner('a', 'first'),
      second = await owner('a', 'second')
    await manager.run(first, { op: 'observe' }, signal())
    const next = manager.run(second, { op: 'observe' }, signal())
    await tick()
    await manager.run(first, { op: 'release' }, signal())
    expect((await next).ok).toBe(true)
    expect(adapter.instances).toHaveLength(1)
    expect(adapter.instances[0].closed).toBe(false)
    await manager.run(second, { op: 'release' }, signal())
    await tick()
    expect(adapter.instances[0].closed).toBe(true)
  })
  it('reserves a closing process slot while a new command waits to relaunch its saved profile', async () => {
    const own = await owner('a')
    await manager.run(own, { op: 'observe' }, signal())
    const old = adapter.instances[0]
    old.closeGate = deferred<void>()
    await manager.run(own, { op: 'release' }, signal())
    expect((await manager.status('a')).state).toBe('closing')
    const next = manager.run(own, { op: 'observe' }, signal())
    await tick()
    expect(adapter.instances).toHaveLength(1)
    old.closeGate.resolve()
    expect((await next).ok).toBe(true)
    expect(adapter.instances[1].dir).toBe(old.dir)
    expect(adapter.maxSlots).toBe(1)
  })
  it('reserves an uncertain failed launch until a later authoritative close succeeds', async () => {
    const launch = adapter.launch.bind(adapter)
    let fail = true
    adapter.launch = async (...args) => {
      const instance = await launch(...args)
      if (fail) {
        fail = false
        instance.closeGate = deferred<void>()
        const closing = instance.close()
        instance.closeGate.reject(new Error('Unconfirmed process teardown'))
        await closing.catch(() => undefined)
        throw new BrowserLaunchCleanupError(instance)
      }
      return instance
    }
    expect((await manager.run(await owner('a'), { op: 'observe' }, signal())).ok).toBe(false)
    expect((await manager.status('a')).state).toBe('closing')
    const b = await manager.watch({ agent: 'b' }, viewer('b'))
    const third = manager.run(await owner('c'), { op: 'observe' }, signal())
    await tick()
    expect(adapter.instances).toHaveLength(2)
    adapter.instances[0].closeGate = undefined
    await manager.clear('a')
    expect((await third).ok).toBe(true)
    expect(adapter.maxSlots).toBe(2)
    await b.close()
  })
  it('retries an unconfirmed close when its profile is requested again', async () => {
    const own = await owner('a')
    await manager.run(own, { op: 'observe' }, signal())
    const old = adapter.instances[0]
    old.closeGate = deferred<void>()
    await manager.run(own, { op: 'release' }, signal())
    old.closeGate.reject(new Error('Unconfirmed process teardown'))
    await tick()
    expect(await manager.status('a')).toMatchObject({ state: 'closing', error: 'Browser could not be closed safely' })
    old.closeGate = undefined
    const next = manager.run(own, { op: 'observe' }, signal())
    await tick()
    expect(old.closed).toBe(true)
    expect(adapter.instances).toHaveLength(2)
    expect((await next).ok).toBe(true)
    expect(adapter.maxSlots).toBe(1)
  })
  it('keeps an unconfirmed close reserved while the retried close still fails', async () => {
    const own = await owner('a')
    await manager.run(own, { op: 'observe' }, signal())
    const old = adapter.instances[0]
    old.closeGate = deferred<void>()
    await manager.run(own, { op: 'release' }, signal())
    old.closeGate.reject(new Error('Unconfirmed process teardown'))
    await tick()
    const next = manager.run(own, { op: 'observe' }, signal())
    await tick()
    expect(adapter.instances).toHaveLength(1)
    expect((await manager.status('a')).state).toBe('closing')
    await vi.advanceTimersByTimeAsync(120000)
    expect((await next).ok).toBe(false)
    old.closeGate = undefined
  })
  it('a confirmed missing-browser launch failure frees its slot for other profiles', async () => {
    const launch = adapter.launch.bind(adapter)
    let fail = true
    adapter.launch = async (...args) => {
      if (fail) {
        fail = false
        throw new Error('Browser unavailable')
      }
      return launch(...args)
    }
    expect((await manager.run(await owner('missing'), { op: 'observe' }, signal())).ok).toBe(false)
    const b = await manager.watch({ agent: 'b' }, viewer('b'))
    const c = await manager.watch({ agent: 'c' }, viewer('c'))
    expect(adapter.instances).toHaveLength(2)
    expect((await manager.status('missing')).state).toBe('unavailable')
    await b.close()
    await c.close()
  })
  it('retires a crashed generation and manual control before relaunching the retained profile', async () => {
    const own = await owner('a'),
      v = viewer('v')
    const subscription = await manager.watch({ agent: 'a' }, v)
    await manager.takeControl('v')
    const old = adapter.instances[0],
      dir = old.dir
    old.closeGate = deferred<void>()
    old.closed = true
    old.listeners.forEach((fn) => fn())
    await tick()
    expect((await manager.status('a')).state).toBe('closing')
    expect((await manager.status('a')).control).toBe('agent')
    await expect(manager.input('v', { generation: old.generation, tabId: 'tab1', type: 'text', text: 'stale' })).rejects.toThrow()
    const pending = manager.run(own, { op: 'observe' }, signal())
    await tick()
    expect(adapter.instances).toHaveLength(1)
    old.closeGate.resolve()
    expect((await pending).ok).toBe(true)
    expect(adapter.instances[1].dir).toBe(dir)
    expect(adapter.instances[1].generation).not.toBe(old.generation)
    expect(adapter.instances[1].inputs).toHaveLength(0)
    await subscription.close()
  })
  it('status launches nothing; concurrent watch and run share one launch', async () => {
    expect((await manager.status('a')).state).toBe('stopped')
    expect(adapter.instances).toHaveLength(0)
    adapter.launchGate = deferred<void>()
    const own = await owner('a')
    const watch = manager.watch({ agent: 'a' }, viewer('v'))
    const run = manager.run(own, { op: 'observe' }, signal())
    await vi.waitFor(() => expect(adapter.launching).toBe(1))
    adapter.launchGate.resolve()
    const subscription = await watch
    expect((await run).ok).toBe(true)
    expect(adapter.instances).toHaveLength(1)
    await subscription.close()
  })
  it('never exceeds two slots including an unfinished close', async () => {
    await manager.run(await owner('a'), { op: 'observe' }, signal())
    const second = await manager.watch({ agent: 'b' }, viewer('b'))
    adapter.instances[0].closeGate = deferred<void>()
    const third = manager.run(await owner('c'), { op: 'observe' }, signal())
    await tick()
    expect(adapter.instances).toHaveLength(2)
    expect((await manager.status('a')).state).toBe('closing')
    adapter.instances[0].closeGate.resolve()
    expect((await third).ok).toBe(true)
    expect(adapter.maxSlots).toBe(2)
    await second.close()
  })
  it('counts concurrent launches toward capacity and closes an abandoned launch before reuse', async () => {
    adapter.launchGate = deferred<void>()
    const abort = new AbortController()
    const a = manager.run(await owner('a'), { op: 'observe' }, abort.signal)
    const b = manager.run(await owner('b'), { op: 'observe' }, signal())
    const c = manager.run(await owner('c'), { op: 'observe' }, signal())
    await tick()
    expect(adapter.launching).toBe(2)
    abort.abort()
    expect((await a).ok).toBe(false)
    expect(adapter.launching).toBe(2)
    adapter.launchGate.resolve()
    expect((await b).ok).toBe(true)
    expect((await c).ok).toBe(true)
    expect(adapter.maxSlots).toBe(2)
    expect(adapter.instances[0].closed).toBe(true)
  })
  it('retries a failed launch and sanitizes adapter failures', async () => {
    adapter.launchGate = deferred<void>()
    const pending = manager.run(await owner('a'), { op: 'observe' }, signal())
    await tick()
    adapter.launchGate.reject(new Error('/secret/profile/path'))
    expect((await pending).ok).toBe(false)
    expect(JSON.stringify(await manager.status('a'))).not.toContain('/secret')
    adapter.launchGate = undefined
    expect((await manager.run(await owner('a'), { op: 'observe' }, signal())).ok).toBe(true)
  })
  it('stops the sole frame producer on last viewer close and does not stream from status', async () => {
    const one = viewer('one'),
      two = viewer('two')
    const a = await manager.watch({ agent: 'a' }, one),
      b = await manager.watch({ agent: 'a' }, two)
    const instance = adapter.instances[0]
    const frame = { generation: instance.generation, tabId: 'tab1', sequence: 1, width: 1280, height: 800, jpeg: new Uint8Array() }
    instance.frameCallback!(frame)
    expect(one.sendFrame).toHaveBeenCalledTimes(1)
    expect(two.sendFrame).toHaveBeenCalledTimes(1)
    await a.close()
    instance.frameCallback!(frame)
    expect(one.sendFrame).toHaveBeenCalledTimes(1)
    expect(two.sendFrame).toHaveBeenCalledTimes(2)
    await b.close()
    expect(instance.frameCallback).toBeUndefined()
    await manager.status('a')
    expect(instance.frameCallback).toBeUndefined()
  })
  it('rejects a fifth tab and closes idle browsers at two minutes preserving disk state', async () => {
    const own = await owner('a'),
      profile = await profiles.ensure('a')
    for (let i = 0; i < 3; i++) expect((await manager.run(own, { op: 'newTab' }, signal())).ok).toBe(true)
    expect(await manager.run(own, { op: 'newTab' }, signal())).toMatchObject({ ok: false, code: 'tab_limit' })
    await vi.advanceTimersByTimeAsync(119999)
    expect(adapter.instances[0].closed).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(adapter.instances[0].closed).toBe(true)
    expect((await stat(profile.dir)).isDirectory()).toBe(true)
  })
  it.each(['connect', 'disconnect'] as const)('answer-only %s preserves the existing browser idle deadline', async (action) => {
    await manager.run(await owner('a'), { op: 'observe' }, signal())
    const subscription = action === 'disconnect' ? await manager.connect({ agent: 'a' }, viewer('card'), { frames: false }) : undefined
    await vi.advanceTimersByTimeAsync(119999)
    if (subscription) await subscription.close()
    else await manager.connect({ agent: 'a' }, viewer('card'), { frames: false })
    await vi.advanceTimersByTimeAsync(1)
    expect(adapter.instances[0].closed).toBe(true)
  })
  it('expires capacity waiters and cancelled waiters never launch later', async () => {
    const a = await manager.watch({ agent: 'a' }, viewer('a')),
      b = await manager.watch({ agent: 'b' }, viewer('b'))
    const abort = new AbortController()
    const cancelled = manager.run(await owner('c'), { op: 'observe' }, abort.signal)
    const expired = manager.run(await owner('d'), { op: 'observe' }, signal())
    await tick()
    abort.abort()
    await tick()
    await vi.advanceTimersByTimeAsync(120000)
    expect((await cancelled).ok).toBe(false)
    expect((await expired).ok).toBe(false)
    await a.close()
    await b.close()
    await tick()
    expect(adapter.instances).toHaveLength(2)
  })
})
describe('browser ownership and control', () => {
  it('serializes group and single turns, while another agent progresses', async () => {
    const a = await owner('a', 'group'),
      b = await owner('a', 'single')
    await manager.run(a, { op: 'observe' }, signal())
    let second = false
    const pending = manager.run(b, { op: 'navigate', url: 'https://example.test' }, signal()).then((result) => {
      second = true
      return result
    })
    await manager.run(a, { op: 'scroll', deltaX: 0, deltaY: 5 }, signal())
    expect(second).toBe(false)
    expect((await manager.run(await owner('b'), { op: 'observe' }, signal())).ok).toBe(true)
    await manager.endTurn('group')
    expect((await pending).ok).toBe(true)
  })
  it('waits for current command, blocks observations, and invalidates references on release', async () => {
    const own = await owner('a'),
      v = viewer('v')
    await manager.watch({ agent: 'a' }, v)
    const observation = await manager.run(own, { op: 'observe' }, signal())
    const stamp = (observation as { ok: true; data: { stamp: { generation: string; tabId: string; observationId: string } } }).data.stamp
    const instance = adapter.instances[0]
    instance.executeGate = deferred()
    const running = manager.run(own, { op: 'reload' }, signal())
    await tick()
    let controlled = false,
      observed = false
    const control = manager.takeControl('v').then(() => {
      controlled = true
    })
    const blocked = manager.run(own, { op: 'observe' }, signal()).then((r) => {
      observed = true
      return r
    })
    await tick()
    expect(controlled).toBe(false)
    instance.executeGate.resolve({ ok: true, data: null })
    await running
    await control
    instance.executeGate = undefined
    expect(observed).toBe(false)
    expect(v.statuses.at(-1)?.control).toBe('you')
    await manager.releaseControl('v')
    await blocked
    expect(await manager.run(own, { op: 'click', stamp, ref: 'ref1' }, signal())).toMatchObject({ ok: false, code: 'stale_ref' })
  })
  it('duplicate takeover waits for the same active command to drain', async () => {
    const own = await owner('a')
    await manager.watch({ agent: 'a' }, viewer('v'))
    const instance = adapter.instances[0]
    instance.executeGate = deferred()
    const running = manager.run(own, { op: 'reload' }, signal())
    await tick()
    let firstDone = false,
      secondDone = false
    const first = manager.takeControl('v').then(() => {
      firstDone = true
    })
    const second = manager.takeControl('v').then(() => {
      secondDone = true
    })
    await tick()
    expect(firstDone).toBe(false)
    expect(secondDone).toBe(false)
    instance.executeGate.resolve({ ok: true, data: null })
    await running
    await first
    await second
    expect((await manager.status('a')).control).toBe('other')
  })
  it('does not grant a late takeover to a closed viewer', async () => {
    const own = await owner('a'),
      v = viewer('v'),
      sub = await manager.watch({ agent: 'a' }, v)
    const instance = adapter.instances[0]
    instance.executeGate = deferred()
    const running = manager.run(own, { op: 'reload' }, signal())
    await tick()
    const takeover = manager.takeControl('v')
    await tick()
    const closed = sub.close()
    instance.executeGate.resolve({ ok: true, data: null })
    await running
    await takeover
    await closed
    expect((await manager.status('a')).control).toBe('agent')
    await expect(manager.input('v', { type: 'text', generation: instance.generation, tabId: 'tab1', text: 'x' })).rejects.toThrow()
  })
  it('reopening the viewer during pending takeover never inherits the closed connection control', async () => {
    const own = await owner('a'),
      original = viewer('v'),
      sub = await manager.watch({ agent: 'a' }, original)
    const instance = adapter.instances[0]
    instance.executeGate = deferred()
    const running = manager.run(own, { op: 'reload' }, signal())
    await tick()
    const control = manager.takeControl('v')
    await tick()
    const closing = sub.close()
    const replacement = viewer('v')
    await manager.watch({ agent: 'a' }, replacement)
    instance.executeGate.resolve({ ok: true, data: null })
    await running
    await control
    await closing
    expect(replacement.statuses.at(-1)?.control).toBe('agent')
    await expect(manager.input('v', { type: 'text', generation: instance.generation, tabId: 'tab1', text: 'x' })).rejects.toThrow()
  })
  it('rejects another viewer control and input with the wrong generation or tab', async () => {
    await manager.watch({ agent: 'a' }, viewer('one'))
    await manager.watch({ agent: 'a' }, viewer('two'))
    await manager.takeControl('one')
    await expect(manager.takeControl('two')).rejects.toThrow()
    await expect(
      manager.input('two', { type: 'text', generation: adapter.instances[0].generation, tabId: 'tab1', text: 'x' })
    ).rejects.toThrow()
    await expect(manager.input('one', { type: 'text', generation: 'old', tabId: 'tab1', text: 'x' })).rejects.toThrow()
    await expect(
      manager.input('one', { type: 'text', generation: adapter.instances[0].generation, tabId: 'tab2', text: 'x' })
    ).rejects.toThrow()
    expect((await manager.navigate('one', { op: 'navigate', url: 'https://example.test' })).ok).toBe(true)
    expect((await manager.status('a')).tabs[0].url).toBe('https://example.test')
  })
  it('closes an uncertain page when reference invalidation stalls during control release', async () => {
    await manager.watch({ agent: 'a' }, viewer('v'))
    await manager.takeControl('v')
    adapter.instances[0].invalidateGate = deferred<void>()
    const release = manager.releaseControl('v')
    await tick()
    await vi.advanceTimersByTimeAsync(30000)
    await release
    expect(adapter.instances[0].closed).toBe(true)
    expect((await manager.status('a')).control).toBe('agent')
    expect((await manager.run(await owner('a'), { op: 'observe' }, signal())).ok).toBe(true)
    expect(adapter.instances[1].generation).not.toBe(adapter.instances[0].generation)
  })
  it('bounds reference invalidation before granting the next turn', async () => {
    await manager.watch({ agent: 'a' }, viewer('v'))
    const own = await owner('a', 'first')
    await manager.run(own, { op: 'observe' }, signal())
    await manager.endTurn('first')
    adapter.instances[0].invalidateGate = deferred<void>()
    const pending = manager.run(await owner('a', 'second'), { op: 'observe' }, signal())
    await tick()
    let settled = false
    void pending.then(() => {
      settled = true
    })
    await vi.advanceTimersByTimeAsync(30000)
    expect(settled).toBe(true)
    expect((await pending).ok).toBe(false)
    expect(adapter.instances[0].closed).toBe(true)
  })
  it.each(['start', 'stop'] as const)('closes an overdue command independently of stalled frame %s', async (phase) => {
    const own = await owner('a')
    await manager.run(own, { op: 'observe' }, signal())
    const instance = adapter.instances[0],
      v = viewer('v'),
      gate = deferred<void>()
    let frameWork: Promise<unknown>
    if (phase === 'start') {
      instance.frameGate = gate
      const start = vi.spyOn(instance, 'startFrames')
      frameWork = manager.watch({ agent: 'a' }, v)
      await vi.waitFor(() => expect(start).toHaveBeenCalledTimes(1))
    } else {
      const subscription = await manager.watch({ agent: 'a' }, v)
      instance.stopFrameGate = gate
      frameWork = subscription.close()
      await tick()
    }
    instance.closeGate = deferred<void>()
    const close = vi.spyOn(instance, 'close')
    instance.executeGate = deferred()
    let settled = false
    const running = manager.run(own, { op: 'reload' }, signal()).then((result) => {
      settled = true
      return result
    })
    await tick()
    await vi.advanceTimersByTimeAsync(30000)
    const attemptedCloseBeforeFrameCompletion = close.mock.calls.length
    expect(settled).toBe(false)
    instance.closeGate.resolve()
    await tick()
    const settledBeforeFrameCompletion = settled,
      closedBeforeFrameCompletion = instance.closed
    gate.resolve()
    await frameWork
    await running
    expect(attemptedCloseBeforeFrameCompletion).toBe(1)
    expect(settledBeforeFrameCompletion).toBe(true)
    expect(closedBeforeFrameCompletion).toBe(true)
    expect(instance.frameCallback).toBeUndefined()
    expect(await running).toMatchObject({ ok: false, code: 'command_timeout' })
    expect(v.sendFrame).not.toHaveBeenCalled()
  })
  it('restarts frames for the retained viewer after timeout recovery relaunch', async () => {
    const own = await owner('a'),
      v = viewer('v')
    await manager.watch({ agent: 'a' }, v)
    adapter.instances[0].executeGate = deferred()
    const running = manager.run(own, { op: 'reload' }, signal())
    await tick()
    await vi.advanceTimersByTimeAsync(30000)
    expect(await running).toMatchObject({ ok: false, code: 'command_timeout' })
    expect((await manager.run(own, { op: 'observe' }, signal())).ok).toBe(true)
    await tick()
    const replacement = adapter.instances[1]
    expect(replacement.frameCallback).toBeTypeOf('function')
    replacement.frameCallback!({
      generation: replacement.generation,
      tabId: 'tab1',
      sequence: 1,
      width: 1280,
      height: 800,
      jpeg: new Uint8Array()
    })
    expect(v.sendFrame).toHaveBeenCalledTimes(1)
  })
  it('late frame completion cannot overwrite replacement capture state', async () => {
    const own = await owner('a'),
      v = viewer('v')
    await manager.run(own, { op: 'observe' }, signal())
    const old = adapter.instances[0]
    old.frameGate = deferred<void>()
    old.stopFrameGate = deferred<void>()
    const start = vi.spyOn(old, 'startFrames')
    const watching = manager.watch({ agent: 'a' }, v)
    await vi.waitFor(() => expect(start).toHaveBeenCalledTimes(1))
    old.executeGate = deferred()
    const running = manager.run(own, { op: 'reload' }, signal())
    await tick()
    await vi.advanceTimersByTimeAsync(30000)
    await running
    const subscription = await watching
    await manager.run(own, { op: 'observe' }, signal())
    await tick()
    const replacement = adapter.instances[1],
      capture = replacement.frameCallback
    old.frameGate.resolve()
    await tick()
    old.frameCallback?.({ generation: old.generation, tabId: 'tab1', sequence: 1, width: 1280, height: 800, jpeg: new Uint8Array() })
    expect(v.sendFrame).not.toHaveBeenCalled()
    old.stopFrameGate.resolve()
    await tick()
    expect(replacement.frameCallback).toBe(capture)
    capture!({ generation: replacement.generation, tabId: 'tab1', sequence: 2, width: 1280, height: 800, jpeg: new Uint8Array() })
    expect(v.sendFrame).toHaveBeenCalledTimes(1)
    await subscription.close()
    expect(replacement.frameCallback).toBeUndefined()
  })
  it('aborts overdue commands and closes uncertain pages before granting takeover', async () => {
    const own = await owner('a')
    await manager.watch({ agent: 'a' }, viewer('v'))
    adapter.instances[0].executeGate = deferred()
    const running = manager.run(own, { op: 'observe' }, signal())
    await tick()
    const control = manager.takeControl('v')
    await vi.advanceTimersByTimeAsync(30000)
    expect(await running).toMatchObject({ ok: false, code: 'command_timeout' })
    await control
    expect(adapter.instances[0].closed).toBe(true)
  })
})
describe('handoff integration', () => {
  it.each(['clear', 'remove'] as const)('notifies connected viewers before and after %s retires a profile', async (operation) => {
    const v = viewer('v')
    const subscription = await manager.watch({ agent: 'a' }, v)
    await manager.takeControl('v')
    const browser = adapter.instances[0]
    browser.closeGate = deferred<void>()
    const retirement = operation === 'clear' ? manager.clear('a') : manager.removeAgents(['a'])
    try {
      await vi.waitFor(() => expect(v.statuses.at(-1)).toMatchObject({ state: 'closing', control: 'agent' }))
      browser.frameCallback?.({
        generation: browser.generation,
        tabId: 'tab1',
        sequence: 1,
        width: 1,
        height: 1,
        jpeg: new Uint8Array([1])
      })
      expect(v.sendFrame).not.toHaveBeenCalled()
    } finally {
      browser.closeGate.resolve()
      await retirement
    }
    expect(v.statuses.at(-1)).toMatchObject({ state: 'stopped', control: 'agent', activeTabId: null })
    await expect(manager.input('v', { generation: browser.generation, tabId: 'tab1', type: 'text', text: 'stale' })).rejects.toThrow()
    await subscription.close()
  })
  it('blocks parallel same-owner browser calls during handoff while other agents and manual control work', async () => {
    const own = await owner('a')
    const pending = manager.run(own, { op: 'requestUserAction', reason: 'Help' }, signal())
    await tick()
    for (const command of [{ op: 'observe' }, { op: 'navigate', url: 'https://example.com' }] as const) {
      expect(await manager.run(own, command, signal())).toMatchObject({ ok: false, code: 'waiting_for_user' })
    }
    expect((await manager.run(await owner('b'), { op: 'observe' }, signal())).ok).toBe(true)
    const subscription = await manager.watch({ agent: 'a' }, viewer('v'))
    await manager.takeControl('v')
    expect((await manager.navigate('v', { op: 'reload' })).ok).toBe(true)
    await manager.answer('v', handoffs[0].id, 'done')
    expect((await pending).ok).toBe(true)
    expect((await manager.run(own, { op: 'observe' }, signal())).ok).toBe(true)
    await subscription.close()
  })
  it('keeps a pending handoff alive after explicit release and the last viewer closes', async () => {
    const own = await owner('a'),
      subscription = await manager.watch({ agent: 'a' }, viewer('v'))
    const pending = manager.run(own, { op: 'requestUserAction', reason: 'Sign in' }, signal())
    await tick()
    await manager.run(own, { op: 'release' }, signal())
    await subscription.close()
    await vi.advanceTimersByTimeAsync(120000)
    expect(adapter.instances[0].closed).toBe(false)
    expect((await manager.status('a')).pendingRequestId).toBe(handoffs[0].id)
    await manager.endTurn(own.turnId)
    expect(await pending).toMatchObject({ ok: false, code: 'handoff_interrupted' })
    await tick()
    expect(adapter.instances[0].closed).toBe(true)
  })
  it('creates no frames for a pending card and excludes waiting from command timeout', async () => {
    const own = await owner('a')
    const pending = manager.run(own, { op: 'requestUserAction', reason: 'Sign in' }, signal())
    await tick()
    expect(handoffs[0]?.status).toBe('pending')
    expect(adapter.instances[0].frameCallback).toBeUndefined()
    await vi.advanceTimersByTimeAsync(30000)
    expect(handoffs).toHaveLength(1)
    await manager.endTurn(own.turnId)
    expect(await pending).toMatchObject({ ok: false, code: 'handoff_interrupted' })
  })
  it('endTurn waits for delayed pending and interrupted persistence before unregistering', async () => {
    const own = await owner('a'),
      gate = deferred<void>(),
      statuses: string[] = []
    manager.registerTurn(own.turnId, async (handoff) => {
      statuses.push(handoff.status)
      if (handoff.status === 'pending') await gate.promise
    })
    const pending = manager.run(own, { op: 'requestUserAction', reason: 'Help' }, signal())
    await tick()
    expect(statuses).toEqual(['pending'])
    let ended = false,
      settled = false
    void pending.then(() => {
      settled = true
    })
    const ending = manager.endTurn(own.turnId).then(() => {
      ended = true
    })
    await tick()
    const completedEarly = ended
    gate.resolve()
    await ending
    expect(completedEarly).toBe(false)
    expect(statuses).toEqual(['pending', 'interrupted'])
    expect(settled).toBe(true)
    expect(await pending).toMatchObject({ ok: false, code: 'handoff_interrupted' })
  })
  it('allows takeover during a pending handoff and viewer answers resume the turn', async () => {
    const own = await owner('a')
    const pending = manager.run(own, { op: 'requestUserAction', reason: 'Help' }, signal())
    await tick()
    await manager.watch({ agent: 'a' }, viewer('v'))
    await manager.takeControl('v')
    await manager.input('v', { type: 'text', generation: adapter.instances[0].generation, tabId: 'tab1', text: 'demo' })
    await manager.answer('v', handoffs[0].id, 'done')
    expect((await pending).ok).toBe(true)
    expect((await manager.status('a')).control).toBe('agent')
  })
  it.each(['done', 'cancel'] as const)('answer-only connections never launch or stream and can answer %s', async (decision) => {
    const card = viewer('card')
    await manager.connect({ agent: 'a' }, card, { frames: false })
    expect(adapter.instances).toHaveLength(0)
    await expect(manager.takeControl('card')).rejects.toThrow()
    const pending = manager.run(await owner('a'), { op: 'requestUserAction', reason: 'Help' }, signal())
    await tick()
    expect(adapter.instances[0].frameCallback).toBeUndefined()
    await manager.answer('card', handoffs[0].id, decision)
    expect((await pending).ok).toBe(decision === 'done')
  })
  it('answer-only connections do not suspend unattended expiry or allow cross-profile answers', async () => {
    await manager.connect({ agent: 'a' }, viewer('card'), { frames: false })
    await manager.connect({ agent: 'b' }, viewer('other'), { frames: false })
    const pending = manager.run(await owner('a'), { op: 'requestUserAction', reason: 'Help' }, signal())
    await tick()
    await expect(manager.answer('other', handoffs[0].id, 'done')).rejects.toThrow()
    await vi.advanceTimersByTimeAsync(600000)
    expect(await pending).toMatchObject({ ok: false, code: 'handoff_expired' })
  })
  it('connecting answer-only just before expiry does not restart the handoff timer', async () => {
    const pending = manager.run(await owner('a'), { op: 'requestUserAction', reason: 'Help' }, signal())
    await tick()
    await vi.advanceTimersByTimeAsync(599999)
    await manager.connect({ agent: 'a' }, viewer('card'), { frames: false })
    let settled = false
    void pending.then(() => {
      settled = true
    })
    await vi.advanceTimersByTimeAsync(1)
    expect(settled).toBe(true)
    expect(await pending).toMatchObject({ ok: false, code: 'handoff_expired' })
  })
  it('clear invalidates an in-flight command even if the adapter never acknowledges abort', async () => {
    const own = await owner('a')
    await manager.run(own, { op: 'observe' }, signal())
    adapter.instances[0].executeGate = deferred()
    const pending = manager.run(own, { op: 'reload' }, signal())
    await tick()
    await manager.clear('a')
    let settled = false
    void pending.then(() => {
      settled = true
    })
    await tick()
    expect(settled).toBe(true)
    expect((await pending).ok).toBe(false)
  })
  it('a stale answer cannot release human control', async () => {
    await manager.watch({ agent: 'a' }, viewer('v'))
    await manager.takeControl('v')
    await expect(manager.answer('v', 'old-request', 'done')).rejects.toThrow()
    expect((await manager.status('a')).control).toBe('other')
  })
  it('renames pending handoffs and preserves the original profile identity', async () => {
    const own = await owner('a')
    const pending = manager.run(own, { op: 'requestUserAction', reason: 'Help' }, signal())
    await tick()
    await manager.renameAgent('a', 'renamed')
    expect((await profiles.byId(own.profileId))?.agent).toBe('renamed')
    expect(handoffs.at(-1)).toMatchObject({ agent: 'renamed', profileId: own.profileId, status: 'pending' })
    expect((await manager.status('renamed')).profileId).toBe(own.profileId)
    await manager.endTurn(own.turnId)
    expect((await pending).ok).toBe(false)
  })
  it('rejects a target resolved before its agent was removed', async () => {
    const profile = await profiles.ensure('a'),
      gate = deferred<void>()
    await manager.close()
    manager = new BrowserManager({
      profiles,
      adapter,
      config: loadBrowserConfig({}),
      now: Date.now,
      newId: () => 'id',
      resolveTarget: async () => {
        await gate.promise
        return { ...profile, agent: 'a' }
      },
      onHandoff: async () => {}
    })
    const connecting = manager.watch({ agent: 'a' }, viewer('v'))
    const rejected = expect(connecting).rejects.toThrow()
    await manager.removeAgents(['a'])
    gate.resolve()
    await rejected
    expect(adapter.instances).toHaveLength(0)
  })
  it('clear and removal invalidate old owners and interrupt requests', async () => {
    const own = await owner('a')
    const pending = manager.run(own, { op: 'requestUserAction', reason: 'Help' }, signal())
    await tick()
    await manager.clear('a')
    expect((await pending).ok).toBe(false)
    expect(await profiles.byId(own.profileId)).toBeNull()
    expect((await manager.run(own, { op: 'observe' }, signal())).ok).toBe(false)
    const next = await owner('a')
    await manager.removeAgents(['a'])
    expect(await profiles.byId(next.profileId)).toBeNull()
    expect((await manager.run(next, { op: 'observe' }, signal())).ok).toBe(false)
  })
})

describe('pending viewer cancellation', () => {
  it('aborts a starting watch before its subscription exists and never captures late', async () => {
    adapter.launchGate = deferred<void>()
    const abort = new AbortController()
    const pending = manager.watch({ agent: 'a' }, { ...viewer('cancelled'), signal: abort.signal })
    const rejected = expect(pending).rejects.toThrow()
    await vi.waitFor(() => expect(adapter.launching).toBe(1))
    abort.abort()
    await rejected
    adapter.launchGate.resolve()
    await vi.waitFor(() => expect(adapter.instances[0]?.closed).toBe(true))
    expect(adapter.instances[0].frameCallback).toBeUndefined()
    await expect(manager.takeControl('cancelled')).rejects.toThrow()
  })
  it('does not launch after cancellation during asynchronous target resolution', async () => {
    const target = deferred<void>(),
      abort = new AbortController()
    const ensure = profiles.ensure.bind(profiles)
    profiles.ensure = async (agent) => {
      await target.promise
      return ensure(agent)
    }
    const pending = manager.watch({ agent: 'a' }, { ...viewer('cancelled'), signal: abort.signal })
    abort.abort()
    target.resolve()
    await expect(pending).rejects.toThrow()
    expect(adapter.instances).toHaveLength(0)
  })
})

it('binds staged uploads to the controlling viewer and current generation before private adapter dispatch', async () => {
  vi.useRealTimers()
  const { BrowserFiles } = await import('../../src/core/browser/browserFiles')
  const files = new BrowserFiles(join(root, 'files'))
  await files.clear()
  await manager.close()
  manager = new BrowserManager({
    profiles,
    adapter,
    files,
    config: loadBrowserConfig({}),
    now: Date.now,
    newId: () => crypto.randomUUID(),
    resolveTarget: async (target) => ({ agent: target.agent, ...(await profiles.ensure(target.agent)) }),
    onHandoff: async () => {}
  })
  const v = viewer('v'),
    sub = await manager.watch({ agent: 'a' }, v)
  const location = { generation: adapter.instances[0].generation, tabId: 'tab1' }
  const source = async function* () {
    yield Buffer.from('native upload')
  }
  await expect(manager.stageUpload('v', location, source(), 'file.txt')).rejects.toThrow('control')
  await manager.takeControl('v')
  const staged = await manager.stageUpload('v', location, source(), 'file.txt')
  const execute = vi.spyOn(adapter.instances[0], 'execute')
  expect(await manager.navigate('v', { op: 'chooseFiles', fileIds: [staged.id] }, location)).toMatchObject({ ok: true })
  expect(execute.mock.calls.at(-1)?.[2]).toEqual([expect.stringMatching(/file.txt$/)])
  await expect(manager.stageUpload('v', { ...location, generation: 'stale' }, source(), 'file.txt')).rejects.toThrow('Stale')
  await manager.releaseControl('v')
  await sub.close()
  await expect(
    files.resolveUpload({ profileId: (await profiles.ensure('a')).id, generation: location.generation, viewerId: 'v' }, [staged.id])
  ).rejects.toThrow('unavailable')
  await files.close()
})
// Windows cannot remove a folder while a transfer still holds a file in it open, so cleanup races there (the agent
// browser is Linux-only).
it.skipIf(process.platform !== 'linux')(
  'revokes new and partial turn downloads on endTurn and removes completed links on profile clear',
  async () => {
    vi.useRealTimers()
    const { BrowserFiles } = await import('../../src/core/browser/browserFiles')
    const files = new BrowserFiles(join(root, 'files'))
    await files.clear()
    await manager.close()
    let hooks: import('../../src/core/browser/types').BrowserFileHooks | undefined
    manager = new BrowserManager({
      profiles,
      adapter: {
        launch: async (path, config, files) => {
          hooks = files
          return adapter.launch(path, config)
        }
      },
      files,
      config: loadBrowserConfig({}),
      now: Date.now,
      newId: () => crypto.randomUUID(),
      resolveTarget: async (target) => ({ agent: target.agent, ...(await profiles.ensure(target.agent)) }),
      onHandoff: async () => {}
    })
    const own = await owner('a', 'download-turn')
    await manager.run(own, { op: 'observe' }, signal())
    const generation = adapter.instances[0].generation
    const complete = await hooks!.download(
      (async function* () {
        yield Buffer.from('complete')
      })(),
      'complete',
      generation
    )
    let started!: () => void
    const start = new Promise<void>((resolve) => {
      started = resolve
    })
    const pending = hooks!.download(
      (async function* () {
        yield Buffer.from('partial')
        started()
        await new Promise(() => {})
      })(),
      'partial',
      generation
    )
    const rejected = expect(pending).rejects.toThrow('unavailable')
    await start
    await manager.endTurn(own.turnId)
    await rejected
    await expect(
      hooks!.download(
        (async function* () {
          yield Buffer.from('late')
        })(),
        'late',
        generation
      )
    ).rejects.toThrow('unavailable')
    expect(await files.download(complete.id)).not.toBeNull()
    await manager.clear('a')
    expect(await files.download(complete.id)).toBeNull()
    await files.close()
  },
  3000
)
describe('viewer-sized page', () => {
  const phone = { width: 390, height: 586, scale: 2 },
    desk = { width: 700, height: 900, scale: 1 },
    base = { width: 1280, height: 800, scale: 1 }
  it('sizes the page to the latest viewer and back to the default once nobody watches', async () => {
    const one = await manager.watch({ agent: 'a' }, viewer('one')),
      two = await manager.watch({ agent: 'a' }, viewer('two'))
    const instance = adapter.instances[0]
    // The agent's lease keeps the page open after the viewers leave.
    expect((await manager.run(await owner('a'), { op: 'observe' }, signal())).ok).toBe(true)
    await manager.resize('one', phone)
    await manager.resize('two', desk)
    await manager.resize('two', desk)
    expect(instance.viewports).toEqual([phone, desk])
    await two.close()
    await tick()
    expect(instance.viewports.at(-1)).toEqual(phone)
    await one.close()
    await tick()
    expect(instance.viewports.at(-1)).toEqual(base)
  })
  it('lets the controller size win and keeps other sizes for after release', async () => {
    await manager.watch({ agent: 'a' }, viewer('one'))
    await manager.watch({ agent: 'a' }, viewer('two'))
    const instance = adapter.instances[0]
    await manager.resize('one', phone)
    await manager.takeControl('one')
    await manager.resize('two', desk)
    expect(instance.viewports).toEqual([phone])
    await manager.releaseControl('one')
    expect(instance.viewports).toEqual([phone, desk])
  })
  it('bounds pointer input by the current page size', async () => {
    await manager.watch({ agent: 'a' }, viewer('v'))
    await manager.takeControl('v')
    const at = { generation: adapter.instances[0].generation, tabId: 'tab1', type: 'mouseMove' as const }
    await manager.input('v', { ...at, x: 1000, y: 700 })
    await manager.resize('v', phone)
    await expect(manager.input('v', { ...at, x: 1000, y: 10 })).rejects.toThrow('Input outside viewport')
    await manager.input('v', { ...at, x: 389, y: 585 })
    expect(adapter.instances[0].inputs.map((i) => 'x' in i && i.x)).toEqual([1000, 389])
  })
  it('gives a relaunched page the wanted size and refuses unfitted or hidden sizes', async () => {
    const sub = await manager.watch({ agent: 'a' }, viewer('v'))
    await manager.resize('v', phone)
    const first = adapter.instances[0]
    first.closed = true
    first.listeners.forEach((fn) => fn())
    await tick()
    expect((await manager.run(await owner('a'), { op: 'observe' }, signal())).ok).toBe(true)
    expect(adapter.instances).toHaveLength(2)
    expect(adapter.instances[1].viewports).toEqual([phone])
    await expect(manager.resize('v', { width: 390, height: 586, scale: 3 })).rejects.toThrow()
    await expect(manager.resize('v', { width: 100, height: 586, scale: 1 })).rejects.toThrow()
    await manager.connect({ agent: 'a' }, viewer('answer'), { frames: false })
    await expect(manager.resize('answer', desk)).rejects.toThrow()
    await sub.close()
  })
})
describe('saved screenshots', () => {
  let saved: { chatId: string; name: string; png: Uint8Array }[], fail: Error | undefined
  const shots: NonNullable<BrowserManagerDependencies['shots']> = {
    save: async (chatId, name, png) => {
      if (fail) throw fail
      saved.push({ chatId, name, png })
      return { path: `/data/browser-shots/${chatId}/${name}.png`, bytes: png.byteLength }
    }
  }
  const make = async (withShots: boolean) => {
    await manager.close()
    let id = 0
    manager = new BrowserManager({
      profiles,
      adapter,
      config: loadBrowserConfig({}),
      now: Date.now,
      newId: () => `request${++id}`,
      resolveTarget: async (target) => ({ agent: target.agent, ...(await profiles.ensure(target.agent)) }),
      onHandoff: async (handoff) => {
        handoffs.push({ ...handoff })
      },
      ...(withShots ? { shots } : {})
    })
  }
  beforeEach(async () => {
    saved = []
    fail = undefined
    await make(true)
  })
  const png = Buffer.from(FAKE_PNG, 'base64')

  it("writes the PNG into the chat's folder and hands back where it is, never the bytes", async () => {
    const own = await owner('a')
    const result = await manager.run(own, { op: 'saveScreenshot', name: 'row-hover' }, signal())
    expect(result).toEqual({
      ok: true,
      data: { path: '/data/browser-shots/chat/row-hover.png', name: 'row-hover', bytes: png.byteLength, width: 1, height: 1 }
    })
    expect(saved.map((s) => [s.chatId, s.name])).toEqual([[own.chatId, 'row-hover']])
    expect(Buffer.from(saved[0].png).equals(png)).toBe(true)
    const json = JSON.stringify(result)
    expect(json).not.toContain('base64')
    expect(json).not.toContain(FAKE_PNG)
    expect(adapter.instances[0].commands).toEqual([{ op: 'saveScreenshot', name: 'row-hover' }])
  })

  it('saves an element shot under its own name', async () => {
    const own = await owner('a'),
      observation = await manager.run(own, { op: 'observe' }, signal())
    if (!observation.ok) throw Error('Observation failed')
    const stamp = (observation.data as { stamp: BrowserStamp }).stamp
    const result = await manager.run(own, { op: 'saveScreenshot', name: 'save-button', stamp, ref: 'e1' }, signal())
    expect(result).toEqual({
      ok: true,
      data: { path: '/data/browser-shots/chat/save-button.png', name: 'save-button', bytes: png.byteLength, width: 1, height: 1 }
    })
  })

  it.each(Object.values(SHOT_REFUSALS))('passes the store refusal %s on as its code', async (code) => {
    fail = new Error(code)
    const result = await manager.run(await owner('a'), { op: 'saveScreenshot', name: 'shot' }, signal())
    expect(result).toEqual({ ok: false, code, message: expect.any(String) })
    expect(JSON.stringify(result)).not.toContain(FAKE_PNG)
  })

  it('reports an unexpected store error as shot_failed and keeps the browser', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const own = await owner('a')
      fail = new Error("EACCES: permission denied, open '/data/browser-shots/chat/shot.png'")
      const result = await manager.run(own, { op: 'saveScreenshot', name: 'shot' }, signal())
      expect(result).toEqual({ ok: false, code: 'shot_failed', message: expect.any(String) })
      expect(JSON.stringify(result)).not.toContain('EACCES')
      expect(log).toHaveBeenCalledTimes(1)
      expect(JSON.stringify(log.mock.calls)).not.toContain(FAKE_PNG)
      // The store failed, not the page: the same browser keeps answering.
      expect(adapter.instances).toHaveLength(1)
      expect(adapter.instances[0].closed).toBe(false)
      fail = undefined
      expect((await manager.run(own, { op: 'observe' }, signal())).ok).toBe(true)
      expect(adapter.instances).toHaveLength(1)
    } finally {
      log.mockRestore()
    }
  })

  it('passes an adapter failure through unchanged and writes nothing', async () => {
    const own = await owner('a')
    await manager.run(own, { op: 'observe' }, signal())
    const failed: BrowserResult = {
      ok: false,
      code: 'image_too_large',
      message: 'The screenshot is over 5 MiB: shoot one element or a smaller area instead'
    }
    adapter.instances[0].respond = (command) => (command.op === 'saveScreenshot' ? failed : undefined)
    expect(await manager.run(own, { op: 'saveScreenshot', name: 'big', fullPage: true }, signal())).toEqual(failed)
    expect(saved).toEqual([])
  })

  it('fails with shots_unavailable when the server keeps no screenshots', async () => {
    await make(false)
    const result = await manager.run(await owner('a'), { op: 'saveScreenshot', name: 'shot' }, signal())
    expect(result).toEqual({ ok: false, code: 'shots_unavailable', message: expect.any(String) })
    // Nothing was shot that could not be kept.
    expect(adapter.instances.flatMap((i) => i.commands)).toEqual([])
  })

  it('leaves the other commands as they were', async () => {
    const own = await owner('a'),
      observation = await manager.run(own, { op: 'observe' }, signal())
    const browser = adapter.instances[0],
      stamp = { generation: browser.generation, tabId: 'tab1', observationId: 'obs0' }
    expect(observation).toEqual({ ok: true, data: { stamp } })
    const jpeg = { mimeType: 'image/jpeg', base64: 'AAAA', width: 2, height: 2 }
    browser.respond = (command) => (command.op === 'screenshot' ? { ok: true, data: jpeg } : undefined)
    expect(await manager.run(own, { op: 'screenshot' }, signal())).toEqual({ ok: true, data: jpeg })
    expect(await manager.run(own, { op: 'click', stamp, ref: 'e1' }, signal())).toEqual({ ok: true, data: null })
    expect(saved).toEqual([])
  })

  // What the adapter's guarded() answers: the save yields to a page dialog, then the dialog's answer returns the suspended save.
  const shotAnswer: BrowserResult = { ok: true, data: { mimeType: 'image/png', base64: FAKE_PNG, width: 1, height: 1 } }
  const notSaved = {
    ok: true,
    data: { dialogAnswered: true, note: 'A screenshot was in progress and was not saved: run browser_save_screenshot again.' }
  }
  it('hands on the dialog cue of a save a dialog interrupted, and never the suspended picture', async () => {
    const own = await owner('a')
    await manager.run(own, { op: 'observe' }, signal())
    const browser = adapter.instances[0]
    browser.respond = (command) =>
      command.op === 'saveScreenshot' ? { ok: true, data: { dialogPending: true } } : command.op === 'dialog' ? shotAnswer : undefined
    expect(await manager.run(own, { op: 'saveScreenshot', name: 'row' }, signal())).toEqual({ ok: true, data: { dialogPending: true } })
    const answer = await manager.run(own, { op: 'dialog', accept: true }, signal())
    expect(answer).toEqual(notSaved)
    expect(JSON.stringify(answer)).not.toContain('base64')
    expect(JSON.stringify(answer)).not.toContain(FAKE_PNG.slice(0, 16))
    expect(saved).toEqual([])
    // The page is fine: a save after the dialog is kept as usual.
    browser.respond = undefined
    expect(await manager.run(own, { op: 'saveScreenshot', name: 'row' }, signal())).toMatchObject({
      ok: true,
      data: { path: '/data/browser-shots/chat/row.png' }
    })
    expect(saved.map((s) => s.name)).toEqual(['row'])
  })

  it('never lets a PNG through any command but the save that kept it, and leaves JPEG frames alone', async () => {
    const own = await owner('a')
    await manager.run(own, { op: 'observe' }, signal())
    const browser = adapter.instances[0],
      jpeg: BrowserResult = { ok: true, data: { mimeType: 'image/jpeg', base64: 'AAAA', width: 2, height: 2 } }
    browser.respond = (command) =>
      command.op === 'screenshot' ? jpeg : command.op === 'reload' || command.op === 'dialog' ? shotAnswer : undefined
    expect(await manager.run(own, { op: 'reload' }, signal())).toEqual(notSaved)
    expect(await manager.run(own, { op: 'dialog', accept: false }, signal())).toEqual(notSaved)
    expect(await manager.run(own, { op: 'screenshot' }, signal())).toEqual(jpeg)
    // A dialog answered with nothing suspended answers as it always did.
    browser.respond = undefined
    expect(await manager.run(own, { op: 'dialog', accept: true }, signal())).toEqual({ ok: true, data: null })
    expect(saved).toEqual([])
  })
})
describe('saved screenshots and the vault scrub', () => {
  // A saved API key is "zumibot": the data folder's own name must not be hidden in the path the agent attaches.
  const make = async (path: string) => {
    await manager.close()
    let id = 0
    const shots: NonNullable<BrowserManagerDependencies['shots']> = {
      save: async (_chat, name, bytes) => ({ path: `${path}/${name}.png`, bytes: bytes.byteLength })
    }
    manager = new BrowserManager({
      profiles,
      adapter,
      config: loadBrowserConfig({}),
      now: Date.now,
      newId: () => `request${++id}`,
      resolveTarget: async (target) => ({ agent: target.agent, ...(await profiles.ensure(target.agent)) }),
      onHandoff: async (handoff) => {
        handoffs.push({ ...handoff })
      },
      shots,
      vault: {
        item: () => null,
        status: () => 'ready',
        addApproval: async () => {},
        approve: async () => 'unavailable',
        secrets: () => ({ values: ['zumibot'], cards: [] })
      }
    })
  }
  const H = '[hidden by vault]'

  it('keeps the path of a successful save whole, whatever the vault holds', async () => {
    await make('/home/u/.local/share/zumibot/browser-shots/chat')
    const result = await manager.run(await owner('a'), { op: 'saveScreenshot', name: 'row-hover' }, signal())
    expect(result).toMatchObject({
      ok: true,
      data: { path: '/home/u/.local/share/zumibot/browser-shots/chat/row-hover.png', name: 'row-hover' }
    })
  })

  it('still scrubs a failure, and every other command, of the same secret', async () => {
    await make('/data/zumibot/shots')
    const own = await owner('a')
    await manager.run(own, { op: 'observe' }, signal())
    const browser = adapter.instances[0]
    browser.respond = (command) =>
      command.op === 'saveScreenshot'
        ? { ok: false, code: 'screenshot_failed', message: 'Failed near zumibot' }
        : command.op === 'tabs'
          ? { ok: true, data: { tabs: [{ id: 'tab1', title: 'zumibot', url: 'https://x.test/zumibot' }], activeTabId: 'tab1' } }
          : undefined
    expect(await manager.run(own, { op: 'saveScreenshot', name: 'x' }, signal())).toEqual({
      ok: false,
      code: 'screenshot_failed',
      message: `Failed near ${H}`
    })
    expect(await manager.run(own, { op: 'tabs' }, signal())).toEqual({
      ok: true,
      data: { tabs: [{ id: 'tab1', title: H, url: `https://x.test/${H}` }], activeTabId: 'tab1' }
    })
  })

  it('does not exempt a saveScreenshot answer the manager did not build', async () => {
    await make('/data/shots')
    const own = await owner('a')
    await manager.run(own, { op: 'observe' }, signal())
    // The worker's own answer is never handed over as it is: keepShot rebuilds it or fails the command.
    adapter.instances[0].respond = (command) =>
      command.op === 'saveScreenshot' ? { ok: true, data: { path: 'zumibot', width: 1, height: 1 } } : undefined
    const result = await manager.run(own, { op: 'saveScreenshot', name: 'x' }, signal())
    expect(JSON.stringify(result)).not.toContain('zumibot')
  })
})
describe('agent viewport', () => {
  const small = { width: 800, height: 600, scale: 1 },
    wide = { width: 1440, height: 900, scale: 1 }
  const setWide = { op: 'setViewport' as const, width: 1440, height: 900 }

  it('applies the size once, answers with it and keeps references', async () => {
    const own = await owner('a'),
      observation = await manager.run(own, { op: 'observe' }, signal())
    if (!observation.ok) throw Error('Observation failed')
    const stamp = (observation.data as { stamp: BrowserStamp }).stamp,
      instance = adapter.instances[0]
    expect(await manager.run(own, setWide, signal())).toEqual({ ok: true, data: { width: 1440, height: 900 } })
    expect(instance.viewports).toEqual([wide])
    expect(await manager.run(own, setWide, signal())).toEqual({ ok: true, data: { width: 1440, height: 900 } })
    expect(instance.viewports).toEqual([wide])
    // Owned by the manager: the adapter is resized, never asked to execute it, and a resize voids no reference.
    expect(instance.commands.map((c) => c.op)).toEqual(['observe'])
    expect(await manager.run(own, { op: 'click', stamp, ref: 'e1' }, signal())).toEqual({ ok: true, data: null })
    expect(instance.observations).toBe(0)
  })

  it('bounds a size it is handed directly', async () => {
    const own = await owner('a')
    expect(await manager.run(own, { op: 'setViewport', width: 4000, height: 100 }, signal())).toEqual({
      ok: true,
      data: { width: 1920, height: 200 }
    })
    expect(adapter.instances[0].viewports).toEqual([{ width: 1920, height: 200, scale: 1 }])
  })

  it("keeps the watching viewer's pixel density", async () => {
    const sub = await manager.watch({ agent: 'a' }, viewer('v'))
    await manager.resize('v', { width: 390, height: 586, scale: 2 })
    expect(await manager.run(await owner('a'), setWide, signal())).toEqual({ ok: true, data: { width: 1440, height: 900 } })
    expect(adapter.instances[0].viewports.at(-1)).toEqual({ width: 1440, height: 900, scale: 1.75 })
    await sub.close()
  })

  it('wins over a viewer while the agent holds the lease and gives the viewer its size back on release', async () => {
    const sub = await manager.watch({ agent: 'a' }, viewer('v')),
      instance = adapter.instances[0],
      own = await owner('a')
    await manager.resize('v', small)
    expect(instance.viewports).toEqual([small])
    expect(await manager.run(own, setWide, signal())).toMatchObject({ ok: true })
    expect(instance.viewports).toEqual([small, wide])
    await manager.resize('v', small)
    expect(instance.viewports).toEqual([small, wide])
    await manager.run(own, { op: 'release' }, signal())
    await tick()
    expect(instance.viewports).toEqual([small, wide, small])
    // The next ownership period starts on the viewer's size.
    expect((await manager.run(own, { op: 'observe' }, signal())).ok).toBe(true)
    expect(instance.viewports).toEqual([small, wide, small])
    await sub.close()
  })

  it.each(['turn end', 'lease idle'] as const)('drops the override at %s', async (how) => {
    const sub = await manager.watch({ agent: 'a' }, viewer('v')),
      instance = adapter.instances[0],
      own = await owner('a')
    await manager.resize('v', small)
    await manager.run(own, setWide, signal())
    expect(instance.viewports).toEqual([small, wide])
    if (how === 'turn end') await manager.endTurn(own.turnId)
    else await vi.advanceTimersByTimeAsync(120000)
    await tick()
    expect(instance.viewports).toEqual([small, wide, small])
    await sub.close()
  })

  it('never hands the override to the next turn', async () => {
    const sub = await manager.watch({ agent: 'a' }, viewer('v')),
      instance = adapter.instances[0]
    const first = await owner('a', 'first'),
      second = await owner('a', 'second')
    await manager.resize('v', small)
    await manager.run(first, setWide, signal())
    const waiting = manager.run(second, { op: 'observe' }, signal())
    await tick()
    expect(instance.commands.map((c) => c.op)).toEqual([])
    await manager.run(first, { op: 'release' }, signal())
    expect((await waiting).ok).toBe(true)
    expect(instance.viewports).toEqual([small, wide, small])
    await sub.close()
  })

  it('drops the override when the browser relaunches', async () => {
    const sub = await manager.watch({ agent: 'a' }, viewer('v')),
      own = await owner('a')
    await manager.resize('v', small)
    await manager.run(own, setWide, signal())
    const first = adapter.instances[0]
    expect(first.viewports).toEqual([small, wide])
    first.closed = true
    first.listeners.forEach((fn) => fn())
    await tick()
    expect((await manager.run(own, { op: 'observe' }, signal())).ok).toBe(true)
    expect(adapter.instances).toHaveLength(2)
    expect(adapter.instances[1].viewports).toEqual([small])
    await sub.close()
  })
})
describe('vault fills', () => {
  type Ask = {
    o: Parameters<NonNullable<BrowserManagerDependencies['vault']>['approve']>[0]
    answer: ReturnType<typeof deferred<'allow' | 'deny' | 'interrupted' | 'pending' | 'unavailable'>>
  }
  const card = (): VaultItem => ({
    id: 'c1',
    updatedAt: 1,
    name: 'Work Visa',
    agents: ['a'],
    kind: 'card',
    holder: 'Bob',
    number: '4242 4242 4242 4242',
    expiry: '07/29',
    cvc: '123',
    approved: []
  })
  const pair = (site: string, frameSite: string): BrowserResult => ({ ok: true, data: { approve: { site, frameSite } } })
  let items: VaultItem[],
    asks: Ask[],
    added: [string, string, string][],
    status: VaultStatus,
    longValues: string[] = []
  const vault = (): NonNullable<BrowserManagerDependencies['vault']> => ({
    item: (id) => structuredClone(items.find((i) => i.id === id) ?? null),
    status: () => status,
    addApproval: async (id, site, frameSite) => {
      added.push([id, site, frameSite])
      const item = items.find((i) => i.id === id)
      if (item?.kind === 'card') item.approved.push({ site, frameSite, at: 1 })
    },
    approve: (o, _signal) => {
      const answer = deferred<'allow' | 'deny' | 'interrupted' | 'pending' | 'unavailable'>()
      asks.push({ o, answer })
      return answer.promise
    },
    secrets: () => ({ values: ['correct-horse', 'az-pat-value-0001', ...longValues], cards: ['4242424242424242'] })
  })
  beforeEach(async () => {
    items = [card()]
    asks = []
    added = []
    status = 'ready'
    longValues = []
    await manager.close()
    let id = 0
    manager = new BrowserManager({
      profiles,
      adapter,
      config: loadBrowserConfig({}),
      now: Date.now,
      newId: () => `request${++id}`,
      resolveTarget: async (target) => ({ agent: target.agent, ...(await profiles.ensure(target.agent)) }),
      onHandoff: async (handoff) => {
        handoffs.push({ ...handoff })
      },
      vault: vault()
    })
  })
  const observed = async (own: BrowserOwner) => {
    const o = await manager.run(own, { op: 'observe' }, signal())
    if (!o.ok) throw Error('Observation failed')
    return (o.data as { stamp: BrowserStamp }).stamp
  }
  const fillCommand = (stamp: BrowserStamp, field: 'number' | 'password' = 'number', item = 'c1') => ({
    op: 'fillVault' as const,
    stamp,
    ref: 'e1',
    item,
    field
  })

  it('fills after Allow and remembers the pair', async () => {
    const own = await owner('a'),
      stamp = await observed(own),
      browser = adapter.instances[0]
    browser.fillResults = [pair('shop.example.com', 'js.stripe.com')]
    const filling = manager.run(own, fillCommand(stamp), signal())
    await vi.waitFor(() => expect(asks).toHaveLength(1))
    expect(asks[0].o).toEqual({
      owner: own,
      itemId: 'c1',
      itemName: 'Work Visa',
      label: 'Visa •4242',
      site: 'shop.example.com',
      frameSite: 'js.stripe.com'
    })
    // The lease is kept while the card waits: no idle expiry hands the browser on or voids the stamp.
    await vi.advanceTimersByTimeAsync(10 * 60_000)
    asks[0].answer.resolve('allow')
    const result = await filling
    expect(result).toEqual({ ok: true, data: { filled: true, item: 'Work Visa', field: 'number' } })
    expect(added).toEqual([['c1', 'shop.example.com', 'js.stripe.com']])
    expect(browser.fills).toHaveLength(2)
    expect(browser.fills[0]).toMatchObject({
      stamp,
      ref: 'e1',
      value: '4242424242424242',
      secret: true,
      mask: true,
      target: 'input',
      loose: true,
      hosts: { kind: 'card', approved: [] }
    })
    expect(browser.fills[1]).toMatchObject({
      hosts: { kind: 'card', approved: [{ site: 'shop.example.com', frameSite: 'js.stripe.com' }] }
    })
    expect(browser.observations).toBe(0)
    expect(JSON.stringify(result)).not.toContain('4242')
    // An agent's fill never reaches execute, where a value could ride along.
    expect(browser.commands.map((c) => c.op)).toEqual(['observe'])
    // The pair is remembered: the next fill asks nobody.
    expect(await manager.run(own, fillCommand(stamp), signal())).toMatchObject({ ok: true, data: { filled: true } })
    expect(asks).toHaveLength(1)
  })

  it('Deny types nothing', async () => {
    const own = await owner('a'),
      stamp = await observed(own),
      browser = adapter.instances[0]
    browser.fillResults = [pair('shop.example.com', 'shop.example.com')]
    const denied = manager.run(own, fillCommand(stamp), signal())
    await vi.waitFor(() => expect(asks).toHaveLength(1))
    asks[0].answer.resolve('deny')
    expect(await denied).toMatchObject({ ok: false, code: 'denied' })
    browser.fillResults = [pair('shop.example.com', 'shop.example.com')]
    const stopped = manager.run(own, fillCommand(stamp), signal())
    await vi.waitFor(() => expect(asks).toHaveLength(2))
    asks[1].answer.resolve('interrupted')
    expect(await stopped).toMatchObject({ ok: false, code: 'cancelled' })
    // Another card already waiting on this browser is not the user's Deny.
    browser.fillResults = [pair('shop.example.com', 'shop.example.com')]
    const busy = manager.run(own, fillCommand(stamp), signal())
    await vi.waitFor(() => expect(asks).toHaveLength(3))
    asks[2].answer.resolve('pending')
    expect(await busy).toEqual({ ok: false, code: 'approval_pending', message: 'Another vault approval is already waiting for the user.' })
    // A turn with no card to show is not the user's Deny either: nobody could click.
    browser.fillResults = [pair('shop.example.com', 'shop.example.com')]
    const unseen = manager.run(own, fillCommand(stamp), signal())
    await vi.waitFor(() => expect(asks).toHaveLength(4))
    asks[3].answer.resolve('unavailable')
    expect(await unseen).toEqual({ ok: false, code: 'approval_unavailable', message: 'No approval card could be shown for this turn.' })
    // Only the checking passes reached the page, and each of those stopped at the approval.
    expect(browser.fills).toHaveLength(4)
    expect(added).toEqual([])
  })

  it.each(['grant removed', 'item deleted'] as const)(
    'refuses a fill whose grant was removed while its approval waited: %s',
    async (change) => {
      const own = await owner('a'),
        stamp = await observed(own),
        browser = adapter.instances[0]
      browser.fillResults = [pair('shop.example.com', 'js.stripe.com')]
      const filling = manager.run(own, fillCommand(stamp), signal())
      await vi.waitFor(() => expect(asks).toHaveLength(1))
      if (change === 'grant removed') items[0].agents = []
      else items = []
      asks[0].answer.resolve('allow')
      expect(await filling).toMatchObject({ ok: false, code: 'not_allowed' })
      expect(browser.fills).toHaveLength(1)
      // An Allow given for an agent that lost the card remembers nothing.
      expect(added).toEqual([])
    }
  )

  it('rechecks hosts after an approval', async () => {
    const own = await owner('a'),
      stamp = await observed(own),
      browser = adapter.instances[0]
    // The page moved to another checkout while the first card waited.
    browser.fillResults = [pair('shop.example.com', 'js.stripe.com'), pair('evil.example.net', 'js.stripe.com')]
    const filling = manager.run(own, fillCommand(stamp), signal())
    await vi.waitFor(() => expect(asks).toHaveLength(1))
    asks[0].answer.resolve('allow')
    await vi.waitFor(() => expect(asks).toHaveLength(2))
    expect(asks[1].o).toMatchObject({ site: 'evil.example.net', frameSite: 'js.stripe.com' })
    asks[1].answer.resolve('deny')
    expect(await filling).toMatchObject({ ok: false, code: 'denied' })
    expect(added).toEqual([['c1', 'shop.example.com', 'js.stripe.com']])
    expect(browser.fills).toHaveLength(2)
    // A login re-checked after the wait fails on its own: the worker answers wrong_site.
    items.push({
      id: 'l1',
      updatedAt: 1,
      name: 'Mail',
      agents: ['a'],
      kind: 'login',
      sites: ['mail.example.com'],
      username: 'bob',
      password: 'correct-horse',
      totp: null
    })
    browser.fillResults = [{ ok: false, code: 'wrong_site', message: 'This login is saved for mail.example.com' }]
    expect(await manager.run(own, fillCommand(stamp, 'password', 'l1'), signal())).toEqual({
      ok: false,
      code: 'wrong_site',
      message: 'This login is saved for mail.example.com'
    })
    expect(browser.fills.at(-1)).toMatchObject({
      value: 'correct-horse',
      target: 'password',
      loose: false,
      hosts: { kind: 'login', sites: ['mail.example.com'] }
    })
  })

  it('refuses a fill without a usable vault', async () => {
    const own = await owner('a'),
      stamp = await observed(own),
      browser = adapter.instances[0]
    status = 'keyMismatch'
    expect(await manager.run(own, fillCommand(stamp), signal())).toMatchObject({ ok: false, code: 'vault_unavailable' })
    status = 'ready'
    expect(await manager.run(own, fillCommand(stamp, 'number', 'nope'), signal())).toMatchObject({ ok: false, code: 'not_allowed' })
    expect(await manager.run(own, fillCommand(stamp, 'password'), signal())).toMatchObject({ ok: false, code: 'no_field' })
    expect(browser.fills).toEqual([])
  })

  it('sends an expiry part as not secret but masked, so a select may take it and an input masks it', async () => {
    items[0] = { ...card(), approved: [{ site: 'shop.example.com', frameSite: 'js.stripe.com', at: 1 }] } as VaultItem
    const own = await owner('a'),
      stamp = await observed(own),
      browser = adapter.instances[0]
    browser.fillResults = [{ ok: true, data: { filled: true } }]
    expect(await manager.run(own, { op: 'fillVault', stamp, ref: 'e1', item: 'c1', field: 'expiryYear' }, signal())).toMatchObject({
      ok: true
    })
    expect(browser.fills[0]).toMatchObject({ value: '2029', secret: false, mask: true, target: 'inputOrSelect' })
  })

  it('cuts page strings to their limits only after the scrub', async () => {
    const own = await owner('a')
    await observed(own)
    const browser = adapter.instances[0],
      H = '[hidden by vault]'
    // The instance hands over strings past the final limits, so a secret a limit falls inside is still whole here.
    browser.respond = (command) =>
      command.op === 'observe'
        ? {
            ok: true,
            data: {
              stamp: { generation: browser.generation, tabId: 'tab1', observationId: 'obs0' },
              text: `${'a'.repeat(31995)} correct-horse`,
              elements: [
                {
                  ref: 'e1',
                  role: `${'r'.repeat(75)} correct-horse`,
                  name: `${'x'.repeat(249)} az-pat-value-0001`,
                  text: `${'t'.repeat(250)} 4242 4242 4242 4242`
                }
              ]
            }
          }
        : command.op === 'tabs'
          ? {
              ok: true,
              data: {
                tabs: [
                  { id: 'tab1', title: `${'y'.repeat(495)} correct-horse`, url: `https://x.test/${'p'.repeat(8170)}?k=az-pat-value-0001` }
                ],
                activeTabId: 'tab1',
                dialog: {
                  tabId: 'tab1',
                  type: 'prompt',
                  message: `${'m'.repeat(1995)} correct-horse`,
                  defaultValue: `${'d'.repeat(1995)} az-pat-value-0001`
                },
                fileChooser: null
              }
            }
          : undefined
    const seen = await manager.run(own, { op: 'observe' }, signal())
    const element = {
      ref: 'e1',
      role: `${'r'.repeat(75)} ${H}`.slice(0, 80),
      name: `${'x'.repeat(249)} ${H}`.slice(0, 256),
      text: `${'t'.repeat(250)} ${H}`.slice(0, 256)
    }
    expect(seen).toEqual({
      ok: true,
      data: {
        stamp: { generation: browser.generation, tabId: 'tab1', observationId: 'obs0' },
        elements: [element],
        text: `${'a'.repeat(31995)} ${H}`.slice(0, 32000 - element.role.length - element.name.length - element.text.length)
      }
    })
    expect(await manager.run(own, { op: 'tabs' }, signal())).toEqual({
      ok: true,
      data: {
        tabs: [
          { id: 'tab1', title: `${'y'.repeat(495)} ${H}`.slice(0, 500), url: `https://x.test/${'p'.repeat(8170)}?k=${H}`.slice(0, 8192) }
        ],
        activeTabId: 'tab1',
        dialog: {
          tabId: 'tab1',
          type: 'prompt',
          message: `${'m'.repeat(1995)} ${H}`.slice(0, 2000),
          defaultValue: `${'d'.repeat(1995)} ${H}`.slice(0, 2000)
        },
        fileChooser: null
      }
    })
  })

  it('never shows the start of a secret the worker cut, when replacements before it shortened the string', async () => {
    const own = await owner('a')
    await observed(own)
    const browser = adapter.instances[0],
      H = '[hidden by vault]',
      V = 'k'.repeat(4200)
    // What the replacements took out moves a cut in steps of 256, so the cut's length never tells a secret's length.
    const up = (removed: number) => Math.ceil(removed / 256) * 256
    longValues = [V]
    // All the worker's own cut left of the saved card: its first digits, at the very end of each string it cut. Two 4 200-character
    // values before them shrink the string by 8 366 characters, so a cut at the final limit alone would land past them.
    const start = '4242 42',
      fill = (cap: number, mark: string) => `${V} ${V} ${mark.repeat(cap - 8402 - start.length - 1)} ${start}`
    const stamp = { generation: browser.generation, tabId: 'tab1', observationId: 'obs0' }
    let observation: unknown
    browser.respond = (command) =>
      command.op === 'observe'
        ? { ok: true, data: observation }
        : command.op === 'tabs'
          ? {
              ok: true,
              data: {
                tabs: [{ id: 'tab1', title: fill(500 + 8192, 'y'), url: fill(8192 + 8192, 'p') }],
                activeTabId: 'tab1',
                dialog: { tabId: 'tab1', type: 'prompt', message: fill(2000 + 8192, 'm'), defaultValue: fill(2000 + 8192, 'd') },
                fileChooser: null
              }
            }
          : undefined
    // Page text cut by the worker at 32 000 + 8 192 (no elements): only what lies 7 999 characters before that cut, counted after
    // the replacements, is shown.
    observation = { stamp, text: fill(32000 + 8192, 'a'), elements: [] }
    const texted = await manager.run(own, { op: 'observe' }, signal())
    expect(texted).toEqual({
      ok: true,
      data: { stamp, elements: [], text: `${H} ${H} ${'a'.repeat(32000 + 8192 - 7999 - up(2 * (4200 - H.length)) - 2 * H.length - 2)}` }
    })
    // An element name cut at 256 + 8 192: nothing of it is far enough from that cut. Its page text is not cut, so all of it shows.
    const element = { ref: 'e1', role: 'button', name: fill(256 + 8192, 'x'), text: '' }
    observation = { stamp, text: `Total ${V}`, elements: [element] }
    expect(await manager.run(own, { op: 'observe' }, signal())).toEqual({
      ok: true,
      data: { stamp, elements: [{ ...element, name: '' }], text: `Total ${H}` }
    })
    const tabs = await manager.run(own, { op: 'tabs' }, signal())
    expect(tabs).toEqual({
      ok: true,
      data: {
        tabs: [{ id: 'tab1', title: '', url: `${H} ${H}`.slice(0, 8192 + 8192 - 7999 - up(2 * (4200 - H.length))) }],
        activeTabId: 'tab1',
        dialog: { tabId: 'tab1', type: 'prompt', message: '', defaultValue: '' },
        fileChooser: null
      }
    })
    for (const r of [texted, tabs]) expect(JSON.stringify(r)).not.toContain('4242')
    // A string the worker did not cut keeps its whole limit after the scrub.
    observation = { stamp, text: 'Pay', elements: [{ ...element, name: `${V} ok` }] }
    expect(await manager.run(own, { op: 'observe' }, signal())).toEqual({
      ok: true,
      data: { stamp, elements: [{ ...element, name: `${H} ok` }], text: 'Pay' }
    })
    // So does one it cut whose replacements took out nothing: passwords that grow into the marker.
    const pay = { ref: 'e1', role: 'button', name: 'Pay', text: '' },
      grown = `${'correct-horse '.repeat(10)}`
    observation = { stamp, text: grown + 'a'.repeat(32000 + 8192 - 9 - grown.length), elements: [pay] }
    expect(await manager.run(own, { op: 'observe' }, signal())).toEqual({
      ok: true,
      data: { stamp, elements: [pay], text: `${`${H} `.repeat(10)}${'a'.repeat(32000)}`.slice(0, 32000 - 9) }
    })
    // A 100-character value replaced once takes out 83 characters, which count as 256: the cut moves that far, never by 83.
    const W = 'w'.repeat(100)
    longValues = [V, W]
    const prose = `${W} ${grown}`
    observation = { stamp, text: prose + 'a'.repeat(32000 + 8192 - 9 - prose.length), elements: [pay] }
    expect(await manager.run(own, { op: 'observe' }, signal())).toEqual({
      ok: true,
      data: { stamp, elements: [pay], text: `${H} ${`${H} `.repeat(10)}${'a'.repeat(32000)}`.slice(0, 32000 + 8192 - 9 - 7999 - 256) }
    })
  })

  it('scrubs vault secrets from observations, tab titles and errors', async () => {
    const own = await owner('a')
    await observed(own)
    const browser = adapter.instances[0]
    browser.respond = (command) =>
      command.op === 'observe'
        ? {
            ok: true,
            data: {
              stamp: { generation: browser.generation, tabId: 'tab1', observationId: 'obs0' },
              text: 'Your password: correct-horse',
              elements: [{ ref: 'e1', role: 'textbox', name: 'Card 4242 4242 4242 4242', text: '' }]
            }
          }
        : command.op === 'tabs'
          ? {
              ok: true,
              data: {
                tabs: [{ id: 'tab1', title: 'Paid with 4242-4242-4242-4242', url: 'https://x.test/?key=az-pat-value-0001' }],
                activeTabId: 'tab1'
              }
            }
          : command.op === 'reload'
            ? { ok: false, code: 'command_failed', message: 'Failed near correct-horse' }
            : undefined
    const results = [
      await manager.run(own, { op: 'observe' }, signal()),
      await manager.run(own, { op: 'tabs' }, signal()),
      await manager.run(own, { op: 'reload' }, signal())
    ]
    const json = JSON.stringify(results)
    for (const secret of ['correct-horse', '4242', 'az-pat-value-0001']) expect(json).not.toContain(secret)
    expect(results).toEqual([
      {
        ok: true,
        data: {
          stamp: { generation: browser.generation, tabId: 'tab1', observationId: 'obs0' },
          text: 'Your password: [hidden by vault]',
          elements: [{ ref: 'e1', role: 'textbox', name: 'Card [hidden by vault]', text: '' }]
        }
      },
      {
        ok: true,
        data: {
          tabs: [{ id: 'tab1', title: 'Paid with [hidden by vault]', url: 'https://x.test/?key=[hidden by vault]' }],
          activeTabId: 'tab1'
        }
      },
      { ok: false, code: 'command_failed', message: 'Failed near [hidden by vault]' }
    ])
  })
})
