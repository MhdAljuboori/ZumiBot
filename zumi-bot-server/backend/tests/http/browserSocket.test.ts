import { BrowserFiles } from '../../src/core/browser/browserFiles'
import { join } from 'node:path'
import { EventEmitter } from 'node:events'
import { rm } from 'node:fs/promises'
import { WebSocket } from 'ws'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createBrowserHub, type BrowserHub } from '../../src/http/browserSocket'
import { BrowserManager } from '../../src/core/browser/browserManager'
import { BrowserProfileStore } from '../../src/core/browser/profileStore'
import { loadBrowserConfig } from '../../src/core/browser/config'
import { AuthStore } from '../../src/auth/authStore'
import { createGate } from '../../src/auth/guard'
import { createLimiter } from '../../src/auth/rateLimit'
import { decodeBrowserFrame } from '@zumibot/shared/browser'
import type { BrowserRequest, BrowserResponse, BrowserStatusMessage } from '@zumibot/shared/browser'
import { deferred, FakeBrowserAdapter } from '../support/fakeBrowser'
import { startRig, type Rig } from './helpers'

const ORIGIN = 'http://browser.test',
  SECRET = '0123456789abcdef0123456789abcdef'
type Message = BrowserResponse | BrowserStatusMessage
const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  vi.useRealTimers()
  await Promise.all(
    cleanups
      .splice(0)
      .reverse()
      .map((fn) => fn())
  )
})
async function setup(mode: 'local' | 'vps' = 'local') {
  let clock = 1700000000000
  const rig = await startRig()
  const profiles = new BrowserProfileStore(rig.root)
  await profiles.load()
  const adapter = new FakeBrowserAdapter()
  const files = new BrowserFiles(join(rig.root, 'browser-files'), { now: () => clock })
  await files.clear()
  const manager = new BrowserManager({
    profiles,
    adapter,
    files,
    config: loadBrowserConfig({}),
    now: () => clock,
    newId: () => crypto.randomUUID(),
    resolveTarget: async (target) => {
      if (!['a', 'b'].includes(target.agent) || (target.chatId && target.chatId !== 'chat')) throw new Error('Denied target')
      return { agent: target.agent, ...(await profiles.ensure(target.agent)) }
    },
    onHandoff: async () => {}
  })
  const auth = new AuthStore(rig.root, () => clock)
  const hub = createBrowserHub({ manager, isValid: mode === 'vps' ? (k) => auth.checkSessionKey(k) : async () => true, now: () => clock })
  const gate = createGate({
    config: {
      mode,
      port: 0,
      dataDir: rig.root,
      vaultKeyFile: join(rig.root, '..', 'unused-vault.key'),
      agentsDir: rig.root,
      webDir: rig.webDir,
      origin: ORIGIN,
      localSecret: SECRET,
      migrateFrom: null
    },
    auth,
    limiter: createLimiter({ now: () => clock }),
    hub: () => rig.hub,
    browserHub: () => hub,
    log: () => {}
  })
  await rig.close()
  const live = await startRig({ gate, browserHub: hub, browserFiles: files, sessionKey: gate.sessionKey })
  cleanups.push(async () => {
    hub.closeAll(1001)
    hub.dispose()
    await manager.close()
    await files.close()
    await live.close()
    await rm(rig.root, { recursive: true, force: true })
    await rm(live.root, { recursive: true, force: true })
  })
  const cookie = mode === 'local' ? `cb_local=${SECRET}` : `cb_session=${await auth.createSession()}`
  return {
    rig: live,
    manager,
    adapter,
    files,
    hub,
    auth,
    cookie,
    advance: (ms: number) => {
      clock += ms
    }
  }
}
async function connect(rig: Rig, cookie: string, origin = ORIGIN) {
  const ws = new WebSocket(`ws://127.0.0.1:${rig.port}/ws/browser`, { headers: { Cookie: cookie, Origin: origin } })
  const messages: Message[] = [],
    frames: ReturnType<typeof decodeBrowserFrame>[] = []
  ws.on('message', (data, binary) => {
    if (binary) frames.push(decodeBrowserFrame(new Uint8Array(data as Buffer)))
    else messages.push(JSON.parse(String(data)))
  })
  await new Promise<void>((resolve, reject) => {
    ws.once('open', resolve)
    ws.once('error', reject)
  })
  cleanups.push(async () => {
    ws.terminate()
  })
  const send = (req: BrowserRequest) => ws.send(JSON.stringify(req))
  const response = async (id: number) => {
    await vi.waitFor(() => expect(messages.some((m) => m.type === 'response' && m.id === id)).toBe(true))
    return messages.find((m) => m.type === 'response' && m.id === id) as BrowserResponse
  }
  const status = () => [...messages].reverse().find((m) => m.type === 'status') as BrowserStatusMessage
  return { ws, messages, frames, send, response, status }
}
const stamp = { generation: 'generation1', tabId: 'tab1' }
describe('authenticated browser socket', () => {
  it.each(['local', 'vps'] as const)('gates %s upgrades by cookie and exact Origin', async (mode) => {
    const s = await setup(mode)
    for (const [cookie, origin] of [
      ['wrong=cookie', ORIGIN],
      [s.cookie, 'http://evil.test']
    ]) {
      const c = await connect(s.rig, cookie, origin)
      const code = await new Promise<number>((resolve) => c.ws.once('close', resolve))
      expect(code).toBe(4401)
    }
    const c = await connect(s.rig, s.cookie)
    c.send({ id: 1, op: 'watch', target: { agent: 'a' } })
    expect((await c.response(1)).ok).toBe(true)
  })
  it('opening alone captures nothing; two explicit watchers share capture; final unwatch stops immediately', async () => {
    const s = await setup(),
      a = await connect(s.rig, s.cookie),
      b = await connect(s.rig, s.cookie)
    expect(s.adapter.instances).toHaveLength(0)
    a.send({ id: 1, op: 'watch', target: { agent: 'a' } })
    await a.response(1)
    b.send({ id: 10, op: 'watch', target: { agent: 'a' } })
    await b.response(10)
    expect(s.adapter.instances).toHaveLength(1)
    const browser = s.adapter.instances[0]
    a.send({ id: 2, op: 'unwatch', watchId: 1 })
    await a.response(2)
    expect(browser.frameCallback).toBeDefined()
    b.send({ id: 11, op: 'unwatch', watchId: 10 })
    await b.response(11)
    expect(browser.frameCallback).toBeUndefined()
  })
  it('denies fabricated identities and unauthorized agent/chat targets', async () => {
    const s = await setup(),
      c = await connect(s.rig, s.cookie)
    c.ws.send(JSON.stringify({ id: 1, op: 'watch', target: { agent: 'a' }, viewerId: 'other' }))
    expect((await c.response(1)).ok).toBe(false)
    for (const [id, target] of [
      [2, { agent: 'other' }],
      [3, { agent: 'a', chatId: 'not-member' }]
    ] as const) {
      c.send({ id, op: 'watch', target })
      expect((await c.response(id)).ok).toBe(false)
    }
    expect(s.adapter.instances).toHaveLength(0)
  })
  it('requires control and exact watch/generation/tab; validates actual viewport bounds', async () => {
    const s = await setup(),
      c = await connect(s.rig, s.cookie)
    c.send({ id: 1, op: 'watch', target: { agent: 'a' } })
    await c.response(1)
    c.send({ id: 2, op: 'navigate', watchId: 1, ...stamp, command: { op: 'navigate', url: 'https://x.test' } })
    expect((await c.response(2)).ok).toBe(false)
    c.send({ id: 3, op: 'takeControl', watchId: 1, ...stamp })
    expect((await c.response(3)).ok).toBe(true)
    for (const [id, input] of [
      [4, { ...stamp, generation: 'old', type: 'text', text: 'x' }],
      [5, { ...stamp, tabId: 'old', type: 'text', text: 'x' }],
      [6, { ...stamp, type: 'mouseMove', x: 1280, y: 1 }]
    ] as const) {
      c.send({ id, op: 'input', watchId: 1, input })
      expect((await c.response(id)).ok).toBe(false)
    }
    c.send({ id: 7, op: 'watch', target: { agent: 'a' } })
    await c.response(7)
    c.send({ id: 8, op: 'releaseControl', watchId: 1, ...stamp })
    expect((await c.response(8)).ok).toBe(false)
    expect(s.adapter.instances[0].inputs).toHaveLength(0)
  })
  it('sizes the page for any visible watch without control and refuses a stale watch', async () => {
    const s = await setup(),
      c = await connect(s.rig, s.cookie)
    c.send({ id: 1, op: 'watch', target: { agent: 'a' } })
    await c.response(1)
    c.send({ id: 2, op: 'viewport', watchId: 1, width: 390, height: 586, scale: 2 })
    expect((await c.response(2)).ok).toBe(true)
    expect(s.adapter.instances[0].viewports).toEqual([{ width: 390, height: 586, scale: 2 }])
    c.send({ id: 3, op: 'viewport', watchId: 9, width: 600, height: 586, scale: 1 })
    expect((await c.response(3)).ok).toBe(false)
    c.send({ id: 4, op: 'viewport', watchId: 1, width: 600.5, height: 586, scale: 1 } as unknown as BrowserRequest)
    expect((await c.response(4)).ok).toBe(false)
    expect(s.adapter.instances[0].viewports).toHaveLength(1)
    // A click on the sized page is bounded by its new width.
    c.send({ id: 5, op: 'takeControl', watchId: 1, ...stamp })
    expect((await c.response(5)).ok).toBe(true)
    c.send({ id: 6, op: 'input', watchId: 1, input: { ...stamp, type: 'mouseDown', x: 400, y: 1, button: 'left' } })
    expect((await c.response(6)).ok).toBe(false)
  })
  it('unwatch cancels a starting subscription without a late ack, frame, or pin', async () => {
    const s = await setup(),
      c = await connect(s.rig, s.cookie)
    s.adapter.launchGate = deferred<void>()
    c.send({ id: 1, op: 'watch', target: { agent: 'a' } })
    await vi.waitFor(() => expect(s.adapter.launching).toBe(1))
    c.send({ id: 2, op: 'unwatch', watchId: 1 })
    expect((await c.response(2)).ok).toBe(true)
    s.adapter.launchGate.resolve()
    await vi.waitFor(() => expect(s.adapter.instances[0]?.closed).toBe(true))
    expect(c.messages.some((m) => m.type === 'response' && m.id === 1)).toBe(false)
    expect(s.adapter.instances[0].frameCallback).toBeUndefined()
  })
  it('answer-only authenticates target without launching or replacing an active watch', async () => {
    const s = await setup(),
      c = await connect(s.rig, s.cookie)
    c.send({ id: 1, op: 'answer', target: { agent: 'a' }, requestId: 'missing', decision: 'done' })
    expect((await c.response(1)).ok).toBe(false)
    expect(s.adapter.instances).toHaveLength(0)
    c.send({ id: 2, op: 'watch', target: { agent: 'a' } })
    await c.response(2)
    c.send({ id: 3, op: 'answer', target: { agent: 'a' }, requestId: 'missing', decision: 'cancel' })
    await c.response(3)
    expect(s.adapter.instances[0].frameCallback).toBeDefined()
  })
  it('expires VPS sessions before granting control and revokes watches on sign-out', async () => {
    const s = await setup('vps'),
      c = await connect(s.rig, s.cookie)
    c.send({ id: 1, op: 'watch', target: { agent: 'a' } })
    await c.response(1)
    s.advance(31 * 24 * 3600000)
    const closed = new Promise<number>((resolve) => c.ws.once('close', resolve))
    c.send({ id: 2, op: 'takeControl', watchId: 1, ...stamp })
    expect(await closed).toBe(4401)
    await vi.waitFor(() => expect(s.adapter.instances[0].frameCallback).toBeUndefined())
    const d = await connect(s.rig, `cb_session=${await s.auth.createSession()}`)
    d.send({ id: 3, op: 'watch', target: { agent: 'a' } })
    await d.response(3)
    const signedOut = new Promise<number>((resolve) => d.ws.once('close', resolve))
    const res = await fetch(`${s.rig.base}/api/logout`, {
      method: 'POST',
      headers: { Cookie: `cb_session=${await s.auth.createSession()}`, Origin: ORIGIN }
    })
    expect(res.status).toBe(204)
    // Session-specific revocation must preserve a different session.
    expect(d.ws.readyState).toBe(WebSocket.OPEN)
    const resAll = await fetch(`${s.rig.base}/api/logout-all`, {
      method: 'POST',
      headers: { Cookie: `cb_session=${await s.auth.createSession()}`, Origin: ORIGIN }
    })
    expect(resAll.status).toBe(204)
    expect(await signedOut).toBe(4401)
  })
})

/** Socket write completion is the external boundary; stalled writes must not accumulate frame copies. */
class WriteSocket extends EventEmitter {
  OPEN = 1
  readyState = 1
  bufferedAmount = 0
  code?: number
  writes: (string | Uint8Array)[] = []
  callbacks: (() => void)[] = []
  stall = false
  send(data: string | Uint8Array, callback?: () => void) {
    this.writes.push(data)
    if (this.stall && typeof data !== 'string') this.callbacks.push(callback!)
    else callback?.()
  }
  ping() {}
  close(code: number) {
    this.code = code
    this.readyState = 3
    this.emit('close')
  }
  terminate() {
    this.close(1006)
  }
  request(req: BrowserRequest) {
    this.emit('message', Buffer.from(JSON.stringify(req)), false)
  }
  responses() {
    return this.writes
      .filter((w) => typeof w === 'string')
      .map((w) => JSON.parse(w as string))
      .filter((w) => w.type === 'response') as BrowserResponse[]
  }
}
describe('browser socket resource bounds', () => {
  it.each(['releaseControl', 'unwatch'] as const)('admits %s after fast typing fills the ordinary command budget', async (op) => {
    const s = await setup(),
      ws = new WriteSocket()
    s.hub.attach(ws as unknown as WebSocket, 'session')
    ws.request({ id: 1, op: 'watch', target: { agent: 'a' } })
    await vi.waitFor(() => expect(ws.responses()).toHaveLength(1))
    ws.request({ id: 2, op: 'takeControl', watchId: 1, ...stamp })
    await vi.waitFor(() => expect(ws.responses()).toHaveLength(2))
    // Ordinary UI typing sends down/text/up before the worker finishes prior input.
    for (let id = 3; id < 45; id++) ws.request({ id, op: 'input', watchId: 1, input: { ...stamp, type: 'text', text: 'fixture' } })
    ws.request(op === 'unwatch' ? { id: 45, op, watchId: 1 } : { id: 45, op, watchId: 1, ...stamp })
    expect(ws.readyState).toBe(ws.OPEN)
    await vi.waitFor(() => expect(ws.responses().find((r) => r.id === 45)).toMatchObject({ ok: true }))
    expect(s.adapter.instances).toHaveLength(1)
    expect(s.adapter.instances[0].inputs).toHaveLength(0)
    expect((await s.manager.status('a')).control).toBe('agent')
  })
  it('quick release drains active input and discards a typing burst without replacing the generation', async () => {
    const s = await setup(),
      ws = new WriteSocket()
    s.hub.attach(ws as unknown as WebSocket, 'session')
    ws.request({ id: 1, op: 'watch', target: { agent: 'a' } })
    await vi.waitFor(() => expect(ws.responses()).toHaveLength(1))
    ws.request({ id: 2, op: 'takeControl', watchId: 1, ...stamp })
    await vi.waitFor(() => expect(ws.responses()).toHaveLength(2))
    const browser = s.adapter.instances[0],
      gate = deferred<void>()
    const input = vi.spyOn(browser, 'input').mockImplementation(async (value) => {
      browser.inputs.push(value)
      await gate.promise
    })
    ws.request({ id: 3, op: 'input', watchId: 1, input: { ...stamp, type: 'text', text: 'active' } })
    await vi.waitFor(() => expect(input).toHaveBeenCalledTimes(1))
    for (let id = 4; id < 46; id++) ws.request({ id, op: 'input', watchId: 1, input: { ...stamp, type: 'text', text: 'queued' } })
    ws.request({ id: 46, op: 'releaseControl', watchId: 1, ...stamp })
    expect(ws.readyState).toBe(ws.OPEN)
    expect(ws.responses().some((r) => r.id === 46)).toBe(false)
    gate.resolve()
    await vi.waitFor(() => expect(ws.responses().find((r) => r.id === 46)).toMatchObject({ ok: true }))
    expect(browser.closed).toBe(false)
    expect(input).toHaveBeenCalledTimes(1)
    expect((await s.manager.status('a')).generation).toBe(browser.generation)
  })
  it('caps JPEG size, forwards at 10fps, and retains only the newest pending frame behind one write', async () => {
    const s = await setup(),
      ws = new WriteSocket()
    s.hub.attach(ws as unknown as WebSocket, 'session')
    ws.request({ id: 1, op: 'watch', target: { agent: 'a' } })
    await vi.waitFor(() => expect(ws.responses()).toHaveLength(1))
    const browser = s.adapter.instances[0],
      frame = (sequence: number, size = 4) => ({ ...stamp, sequence, width: 1280, height: 800, jpeg: new Uint8Array(size) })
    ws.stall = true
    browser.frameCallback!(frame(0, 1048577))
    browser.frameCallback!(frame(1))
    for (let i = 2; i <= 100; i++) browser.frameCallback!(frame(i))
    expect(ws.writes.filter((w) => typeof w !== 'string')).toHaveLength(1)
    s.advance(100)
    ws.callbacks.shift()!()
    await vi.waitFor(() => expect(ws.writes.filter((w) => typeof w !== 'string')).toHaveLength(2))
    const frames = ws.writes.filter((w) => typeof w !== 'string') as Uint8Array[]
    expect(decodeBrowserFrame(frames[1]).sequence).toBe(100)
    expect(ws.callbacks).toHaveLength(1)
  })
  it('drops frames over 4 MiB buffered output and disconnects sustained pressure', async () => {
    const s = await setup(),
      ws = new WriteSocket()
    s.hub.attach(ws as unknown as WebSocket, 'session')
    ws.request({ id: 1, op: 'watch', target: { agent: 'a' } })
    await vi.waitFor(() => expect(ws.responses()).toHaveLength(1))
    const browser = s.adapter.instances[0],
      frame = { ...stamp, sequence: 1, width: 1280, height: 800, jpeg: new Uint8Array(4) }
    ws.bufferedAmount = 4194305
    browser.frameCallback!(frame)
    expect(ws.writes.filter((w) => typeof w !== 'string')).toHaveLength(0)
    s.advance(10001)
    browser.frameCallback!(frame)
    expect(ws.code).toBe(1008)
    await vi.waitFor(() => expect(browser.frameCallback).toBeUndefined())
  })
  it('coalesces moves/wheels without moving them across key/button boundaries; release discards queued input', async () => {
    const s = await setup(),
      ws = new WriteSocket()
    s.hub.attach(ws as unknown as WebSocket, 'session')
    ws.request({ id: 1, op: 'watch', target: { agent: 'a' } })
    await vi.waitFor(() => expect(ws.responses()).toHaveLength(1))
    ws.request({ id: 2, op: 'takeControl', watchId: 1, ...stamp })
    await vi.waitFor(() => expect(ws.responses()).toHaveLength(2))
    const inputs = [
      { type: 'mouseMove', x: 1, y: 1 },
      { type: 'mouseMove', x: 2, y: 2 },
      { type: 'mouseDown', x: 2, y: 2, button: 'left' },
      { type: 'mouseMove', x: 3, y: 3 },
      { type: 'mouseUp', x: 3, y: 3, button: 'left' },
      { type: 'keyDown', key: 'Enter', code: 'Enter' },
      { type: 'keyUp', key: 'Enter', code: 'Enter' }
    ] as const
    inputs.forEach((input, i) => ws.request({ id: i + 3, op: 'input', watchId: 1, input: { ...stamp, ...input } }))
    await vi.waitFor(() => expect(s.adapter.instances[0].inputs).toHaveLength(6))
    expect(s.adapter.instances[0].inputs.map((i) => i.type)).toEqual(['mouseMove', 'mouseDown', 'mouseMove', 'mouseUp', 'keyDown', 'keyUp'])
    expect(s.adapter.instances[0].inputs[0]).toMatchObject({ x: 2, y: 2 })
    ws.request({ id: 20, op: 'input', watchId: 1, input: { ...stamp, type: 'text', text: 'discard' } })
    ws.request({ id: 21, op: 'releaseControl', watchId: 1, ...stamp })
    await vi.waitFor(() => expect(ws.responses().some((r) => r.id === 21)).toBe(true))
    expect(s.adapter.instances[0].inputs).toHaveLength(6)
  })
  it('rejects oversized commands and closes input senders above 120 events per second', async () => {
    const s = await setup(),
      ws = new WriteSocket()
    s.hub.attach(ws as unknown as WebSocket, 'session')
    ws.emit('message', Buffer.from('x'.repeat(65537)), false)
    expect(ws.code).toBe(1009)
    const c = new WriteSocket()
    s.hub.attach(c as unknown as WebSocket, 'session')
    c.request({ id: 1, op: 'watch', target: { agent: 'a' } })
    await vi.waitFor(() => expect(c.responses()).toHaveLength(1))
    for (let i = 0; i < 121; i++) c.request({ id: i + 2, op: 'input', watchId: 1, input: { ...stamp, type: 'mouseMove', x: i, y: 0 } })
    expect(c.code).toBe(1008)
    expect(s.adapter.instances[0].inputs).toHaveLength(0)
  })
})

describe('browser socket cancellation and shutdown races', () => {
  it('cancels watch before asynchronous authorization resolves', async () => {
    const s = await setup(),
      auth = deferred<boolean>()
    const hub = createBrowserHub({ manager: s.manager, isValid: () => auth.promise })
    cleanups.push(async () => hub.dispose())
    const ws = new WriteSocket()
    hub.attach(ws as unknown as WebSocket, 'session')
    ws.request({ id: 1, op: 'watch', target: { agent: 'a' } })
    ws.request({ id: 2, op: 'unwatch', watchId: 1 })
    auth.resolve(true)
    await vi.waitFor(() => expect(ws.responses().some((r) => r.id === 2)).toBe(true))
    expect(s.adapter.instances).toHaveLength(0)
    expect(ws.responses()).toEqual([{ type: 'response', id: 2, ok: true, value: null }])
  })
  it('stops final capture synchronously before an unwatch authorization check completes', async () => {
    const s = await setup(),
      auth = deferred<boolean>()
    let stall = false
    const hub = createBrowserHub({ manager: s.manager, isValid: () => (stall ? auth.promise : Promise.resolve(true)) })
    cleanups.push(async () => hub.dispose())
    const ws = new WriteSocket()
    hub.attach(ws as unknown as WebSocket, 'session')
    ws.request({ id: 1, op: 'watch', target: { agent: 'a' } })
    await vi.waitFor(() => expect(ws.responses()).toHaveLength(1))
    stall = true
    ws.request({ id: 2, op: 'unwatch', watchId: 1 })
    await vi.waitFor(() => expect(s.adapter.instances[0].frameCallback).toBeUndefined())
    auth.resolve(true)
  })
  it('acknowledges takeover only after agent work drains and rejects late takeover after unwatch', async () => {
    const s = await setup(),
      c = await connect(s.rig, s.cookie)
    c.send({ id: 1, op: 'watch', target: { agent: 'a' } })
    await c.response(1)
    const browser = s.adapter.instances[0],
      gate = deferred<import('@zumibot/shared/browser').BrowserResult>()
    browser.executeGate = gate
    const run = s.manager.run(
      { profileId: (await s.manager.status('a')).profileId, chatId: 'chat', turnId: 'turn' },
      { op: 'observe' },
      new AbortController().signal
    )
    await vi.waitFor(() => expect(browser.commands).toHaveLength(1))
    c.send({ id: 2, op: 'takeControl', watchId: 1, ...stamp })
    await vi.waitFor(() => expect(c.status().status.control).toBe('pausing'))
    expect(c.messages.some((m) => m.type === 'response' && m.id === 2)).toBe(false)
    c.send({ id: 3, op: 'unwatch', watchId: 1 })
    await vi.waitFor(() => expect(browser.frameCallback).toBeUndefined())
    gate.resolve({ ok: true, data: null })
    await run
    await c.response(3)
    expect(c.messages.some((m) => m.type === 'response' && m.id === 2)).toBe(false)
    expect((await s.manager.status('a')).control).toBe('agent')
  })
  it('drain cancels watches and refuses new work, disposal releases capture', async () => {
    const s = await setup(),
      c = await connect(s.rig, s.cookie)
    c.send({ id: 1, op: 'watch', target: { agent: 'a' } })
    await c.response(1)
    s.hub.drain()
    await vi.waitFor(() => expect(s.adapter.instances[0].frameCallback).toBeUndefined())
    c.send({ id: 2, op: 'watch', target: { agent: 'a' } })
    s.hub.dispose()
    expect((await s.manager.status('a')).control).toBe('agent')
  })
  it('requires two missed heartbeats and periodically fails closed for expired viewers', async () => {
    const s = await setup()
    let valid = true
    const hub = createBrowserHub({ manager: s.manager, isValid: async () => valid, pingMs: 20 })
    cleanups.push(async () => hub.dispose())
    const ws = new WriteSocket()
    hub.attach(ws as unknown as WebSocket, 'session')
    ws.request({ id: 1, op: 'watch', target: { agent: 'a' } })
    await vi.waitFor(() => expect(ws.responses()).toHaveLength(1), { interval: 1 })
    valid = false
    await vi.waitFor(() => expect(ws.code).toBe(4401), { interval: 1 })
    expect(s.adapter.instances[0].frameCallback).toBeUndefined()
    const dead = new WriteSocket()
    valid = true
    hub.attach(dead as unknown as WebSocket, 'session')
    await vi.waitFor(() => expect(dead.code).toBe(1006), { interval: 1 })
  })
})

describe('browser handoff answers', () => {
  it('Done releases matching manual control before resuming the waiting agent without stopping the watch', async () => {
    const s = await setup(),
      c = await connect(s.rig, s.cookie)
    c.send({ id: 1, op: 'watch', target: { agent: 'a', chatId: 'chat' } })
    await c.response(1)
    const pending = s.manager.run(
      { profileId: (await s.manager.status('a')).profileId, chatId: 'chat', turnId: 'turn' },
      { op: 'requestUserAction', reason: 'Help' },
      new AbortController().signal
    )
    await vi.waitFor(() => expect(c.status().status.pendingRequestId).toBeTruthy())
    const requestId = c.status().status.pendingRequestId!
    c.send({ id: 2, op: 'takeControl', watchId: 1, ...stamp })
    await c.response(2)
    c.send({ id: 3, op: 'answer', target: { agent: 'a', chatId: 'chat', requestId }, requestId, decision: 'done' })
    expect((await c.response(3)).ok).toBe(true)
    expect((await pending).ok).toBe(true)
    expect((await s.manager.status('a')).control).toBe('agent')
    expect(s.adapter.instances[0].frameCallback).toBeDefined()
  })
  it('Done without an explicit watch never starts capture', async () => {
    const s = await setup(),
      c = await connect(s.rig, s.cookie),
      profile = await s.manager.status('a')
    const pending = s.manager.run(
      { profileId: profile.profileId, chatId: 'chat', turnId: 'turn' },
      { op: 'requestUserAction', reason: 'Help' },
      new AbortController().signal
    )
    await vi.waitFor(async () => expect((await s.manager.status('a')).pendingRequestId).toBeTruthy())
    const requestId = (await s.manager.status('a')).pendingRequestId!
    c.send({ id: 1, op: 'answer', target: { agent: 'a', chatId: 'chat', requestId }, requestId, decision: 'done' })
    expect((await c.response(1)).ok).toBe(true)
    expect((await pending).ok).toBe(true)
    expect(s.adapter.instances[0].frameCallback).toBeUndefined()
    expect(c.messages.filter((m) => m.type === 'status')).toHaveLength(0)
  })
})

it('stale answers preserve current control and another window cannot resolve a controlled handoff', async () => {
  const s = await setup(),
    a = await connect(s.rig, s.cookie),
    b = await connect(s.rig, s.cookie)
  a.send({ id: 1, op: 'watch', target: { agent: 'a' } })
  await a.response(1)
  const pending = s.manager.run(
    { profileId: (await s.manager.status('a')).profileId, chatId: 'chat', turnId: 'turn' },
    { op: 'requestUserAction', reason: 'Help' },
    new AbortController().signal
  )
  await vi.waitFor(() => expect(a.status().status.pendingRequestId).toBeTruthy())
  const requestId = a.status().status.pendingRequestId!
  a.send({ id: 2, op: 'takeControl', watchId: 1, ...stamp })
  await a.response(2)
  a.send({ id: 3, op: 'answer', target: { agent: 'a' }, requestId: 'stale', decision: 'done' })
  expect((await a.response(3)).ok).toBe(false)
  expect(a.status().status.control).toBe('you')
  b.send({ id: 1, op: 'answer', target: { agent: 'a' }, requestId, decision: 'done' })
  expect((await b.response(1)).ok).toBe(false)
  expect((await s.manager.status('a')).pendingRequestId).toBe(requestId)
  expect(a.status().status.control).toBe('you')
  a.send({ id: 4, op: 'answer', target: { agent: 'a' }, requestId, decision: 'done' })
  expect((await a.response(4)).ok).toBe(true)
  expect((await pending).ok).toBe(true)
})

it('drops old-tab and old-generation frames, including a frame queued before a tab change', async () => {
  const s = await setup(),
    ws = new WriteSocket()
  s.hub.attach(ws as unknown as WebSocket, 'session')
  ws.request({ id: 1, op: 'watch', target: { agent: 'a' } })
  await vi.waitFor(() => expect(ws.responses()).toHaveLength(1))
  const browser = s.adapter.instances[0],
    frame = (sequence: number) => ({ ...stamp, sequence, width: 1280, height: 800, jpeg: new Uint8Array(4) })
  ws.stall = true
  browser.frameCallback!(frame(1))
  browser.frameCallback!(frame(2))
  browser.tabs.push({ id: 'tab2', title: 'new', url: 'about:blank' })
  browser.activeTabId = 'tab2'
  browser.listeners.forEach((fn) => fn())
  s.advance(100)
  ws.callbacks.shift()!()
  browser.frameCallback!(frame(3))
  browser.frameCallback!({ ...frame(4), generation: 'old', tabId: 'tab2' })
  expect(ws.writes.filter((w) => typeof w !== 'string')).toHaveLength(1)
  browser.frameCallback!({ ...frame(5), tabId: 'tab2' })
  expect(ws.writes.filter((w) => typeof w !== 'string')).toHaveLength(2)
})

it('answering one agent preserves an unrelated watched and controlled browser', async () => {
  const s = await setup(),
    c = await connect(s.rig, s.cookie)
  c.send({ id: 1, op: 'watch', target: { agent: 'b' } })
  await c.response(1)
  c.send({ id: 2, op: 'takeControl', watchId: 1, ...stamp })
  await c.response(2)
  const profile = await s.manager.status('a')
  const pending = s.manager.run(
    { profileId: profile.profileId, chatId: 'chat', turnId: 'turn' },
    { op: 'requestUserAction', reason: 'Help' },
    new AbortController().signal
  )
  await vi.waitFor(async () => expect((await s.manager.status('a')).pendingRequestId).toBeTruthy())
  const requestId = (await s.manager.status('a')).pendingRequestId!
  c.send({ id: 3, op: 'answer', target: { agent: 'a', chatId: 'chat', requestId }, requestId, decision: 'done' })
  expect((await c.response(3)).ok).toBe(true)
  expect((await pending).ok).toBe(true)
  expect(c.status().status.agent).toBe('b')
  expect(c.status().status.control).toBe('you')
  expect(s.adapter.instances[0].frameCallback).toBeDefined()
  expect(s.adapter.instances[1].frameCallback).toBeUndefined()
})

it('session-specific logout immediately stops only that session and discards pending input', async () => {
  const s = await setup('vps'),
    a = await connect(s.rig, s.cookie),
    b = await connect(s.rig, `cb_session=${await s.auth.createSession()}`)
  a.send({ id: 1, op: 'watch', target: { agent: 'a' } })
  await a.response(1)
  b.send({ id: 1, op: 'watch', target: { agent: 'b' } })
  await b.response(1)
  a.send({ id: 2, op: 'takeControl', watchId: 1, ...stamp })
  await a.response(2)
  const closed = new Promise<number>((resolve) => a.ws.once('close', resolve))
  const response = await fetch(`${s.rig.base}/api/logout`, { method: 'POST', headers: { Cookie: s.cookie, Origin: ORIGIN } })
  expect(response.status).toBe(204)
  expect(await closed).toBe(4401)
  await vi.waitFor(() => expect(s.adapter.instances[0].frameCallback).toBeUndefined())
  expect(s.adapter.instances[1].frameCallback).toBeDefined()
  expect(b.ws.readyState).toBe(WebSocket.OPEN)
  // This secondary hub uses a deliberately valid identity to isolate the revocation race from auth storage.
  const local = createBrowserHub({ manager: s.manager, isValid: async () => true })
  cleanups.push(async () => local.dispose())
  const viewer = new WriteSocket()
  local.attach(viewer as unknown as WebSocket, 'revoked')
  viewer.request({ id: 1, op: 'watch', target: { agent: 'a' } })
  await vi.waitFor(() => expect(viewer.responses()).toHaveLength(1))
  viewer.request({ id: 2, op: 'takeControl', watchId: 1, ...stamp })
  await vi.waitFor(() => expect(viewer.responses()).toHaveLength(2))
  viewer.request({ id: 3, op: 'input', watchId: 1, input: { ...stamp, type: 'text', text: 'must-not-replay' } })
  local.closeSession('revoked')
  await vi.waitFor(() => expect(s.adapter.instances[0].frameCallback).toBeUndefined())
  expect(s.adapter.instances[0].inputs).toHaveLength(0)
})

it('rechecks navigation tab identity when earlier queued manual work changes the tab', async () => {
  const s = await setup(),
    ws = new WriteSocket()
  s.hub.attach(ws as unknown as WebSocket, 'session')
  ws.request({ id: 1, op: 'watch', target: { agent: 'a' } })
  await vi.waitFor(() => expect(ws.responses()).toHaveLength(1))
  ws.request({ id: 2, op: 'takeControl', watchId: 1, ...stamp })
  await vi.waitFor(() => expect(ws.responses()).toHaveLength(2))
  ws.request({ id: 3, op: 'navigate', watchId: 1, ...stamp, command: { op: 'newTab' } })
  ws.request({ id: 4, op: 'navigate', watchId: 1, ...stamp, command: { op: 'navigate', url: 'https://wrong-tab.test' } })
  await vi.waitFor(() => expect(ws.responses()).toHaveLength(4))
  expect(ws.responses().find((r) => r.id === 4)?.ok).toBe(false)
  expect(s.adapter.instances[0].commands.map((c) => c.op)).toEqual(['newTab'])
  expect(s.adapter.instances[0].tabs[1].url).toBe('about:blank')
})

it('revocation during awaited answer control release cannot resolve the pending handoff', async () => {
  const s = await setup(),
    ws = new WriteSocket()
  s.hub.attach(ws as unknown as WebSocket, 'revoked')
  ws.request({ id: 1, op: 'watch', target: { agent: 'a' } })
  await vi.waitFor(() => expect(ws.responses()).toHaveLength(1))
  const pending = s.manager.run(
    { profileId: (await s.manager.status('a')).profileId, chatId: 'chat', turnId: 'turn' },
    { op: 'requestUserAction', reason: 'Help' },
    new AbortController().signal
  )
  await vi.waitFor(async () => expect((await s.manager.status('a')).pendingRequestId).toBeTruthy())
  const requestId = (await s.manager.status('a')).pendingRequestId!
  ws.request({ id: 2, op: 'takeControl', watchId: 1, ...stamp })
  await vi.waitFor(() => expect(ws.responses()).toHaveLength(2))
  const gate = deferred<void>()
  s.adapter.instances[0].invalidateGate = gate
  ws.request({ id: 3, op: 'answer', target: { agent: 'a' }, requestId, decision: 'done' })
  await vi.waitFor(async () => expect((await s.manager.status('a')).control).toBe('pausing'))
  s.hub.closeSession('revoked')
  gate.resolve()
  await vi.waitFor(async () => expect((await s.manager.status('a')).control).toBe('agent'))
  expect((await s.manager.status('a')).pendingRequestId).toBe(requestId)
  expect(ws.responses().some((r) => r.id === 3)).toBe(false)
  await s.manager.endTurn('turn')
  await pending
})

describe('manual receive ordering', () => {
  async function controlled() {
    const s = await setup(),
      checks: ReturnType<typeof deferred<boolean>>[] = []
    let gate = false
    const hub = createBrowserHub({
      manager: s.manager,
      isValid: () => {
        if (gate && checks.length < 2) {
          const check = deferred<boolean>()
          checks.push(check)
          return check.promise
        }
        return Promise.resolve(true)
      }
    })
    cleanups.push(async () => {
      checks.forEach((c) => c.resolve(true))
      hub.dispose()
    })
    const ws = new WriteSocket()
    hub.attach(ws as unknown as WebSocket, 'session')
    ws.request({ id: 1, op: 'watch', target: { agent: 'a' } })
    await vi.waitFor(() => expect(ws.responses()).toHaveLength(1))
    ws.request({ id: 2, op: 'takeControl', watchId: 1, ...stamp })
    await vi.waitFor(() => expect(ws.responses()).toHaveLength(2))
    const browser = s.adapter.instances[0],
      dispatched: string[] = []
    const input = browser.input.bind(browser),
      execute = browser.execute.bind(browser)
    browser.input = async (event) => {
      dispatched.push(event.type)
      await input(event)
    }
    browser.execute = async (command, signal) => {
      dispatched.push(command.op)
      return execute(command, signal)
    }
    return {
      ...s,
      hub,
      ws,
      browser,
      checks,
      dispatched,
      gate: () => {
        gate = true
      }
    }
  }
  it('admits key/button edges in receive order when later authorization finishes first', async () => {
    const s = await controlled()
    s.gate()
    s.ws.request({ id: 3, op: 'input', watchId: 1, input: { ...stamp, type: 'keyDown', key: 'Enter', code: 'Enter' } })
    s.ws.request({ id: 4, op: 'input', watchId: 1, input: { ...stamp, type: 'keyUp', key: 'Enter', code: 'Enter' } })
    expect(s.checks).toHaveLength(2)
    s.checks[1].resolve(true)
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(s.dispatched).toEqual([])
    s.checks[0].resolve(true)
    await vi.waitFor(() => expect(s.dispatched).toHaveLength(2))
    expect(s.dispatched).toEqual(['keyDown', 'keyUp'])
  })
  it.each(['input-first', 'navigation-first'] as const)('keeps same-tab navigation and input in receive order: %s', async (order) => {
    const s = await controlled()
    const input = { op: 'input', watchId: 1, input: { ...stamp, type: 'text', text: 'before destination changes' } } as const
    const navigation = { op: 'navigate', watchId: 1, ...stamp, command: { op: 'reload' } } as const
    const first = order === 'input-first' ? input : navigation,
      second = order === 'input-first' ? navigation : input
    s.ws.request({ id: 3, ...first })
    s.ws.request({ id: 4, ...second })
    await vi.waitFor(() => expect(s.dispatched).toHaveLength(2))
    expect(s.dispatched).toEqual(order === 'input-first' ? ['text', 'reload'] : ['reload', 'text'])
  })
  it.each(['input-first', 'navigation-first'] as const)('keeps mixed work ordered across reversed authorization: %s', async (order) => {
    const s = await controlled()
    s.gate()
    const input = { op: 'input', watchId: 1, input: { ...stamp, type: 'text', text: 'same-tab input' } } as const
    const navigation = { op: 'navigate', watchId: 1, ...stamp, command: { op: 'reload' } } as const
    s.ws.request({ id: 3, ...(order === 'input-first' ? input : navigation) })
    s.ws.request({ id: 4, ...(order === 'input-first' ? navigation : input) })
    s.checks[1].resolve(true)
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(s.dispatched).toEqual([])
    s.checks[0].resolve(true)
    await vi.waitFor(() => expect(s.dispatched).toHaveLength(2))
    expect(s.dispatched).toEqual(order === 'input-first' ? ['text', 'reload'] : ['reload', 'text'])
  })
  it('a cancelled authorization wait cannot block its replacement watch', async () => {
    const s = await controlled()
    s.gate()
    s.ws.request({ id: 3, op: 'input', watchId: 1, input: { ...stamp, type: 'text', text: 'cancelled' } })
    s.ws.request({ id: 4, op: 'input', watchId: 1, input: { ...stamp, type: 'text', text: 'also-cancelled' } })
    s.ws.request({ id: 5, op: 'unwatch', watchId: 1 })
    s.ws.request({ id: 6, op: 'watch', target: { agent: 'a' } })
    await vi.waitFor(() => expect(s.ws.responses().find((r) => r.id === 6)?.ok).toBe(true))
    expect(s.browser.inputs).toHaveLength(0)
    s.checks[1].resolve(true)
    s.checks[0].resolve(true)
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(s.dispatched).toEqual([])
  })
})

it('authenticates expiring download links without launching, watching or acquiring control', async () => {
  const s = await setup('vps')
  const file = await s.files.stageDownload(
    { profileId: 'p', generation: 'g', viewerId: 'v' },
    (async function* () {
      yield Buffer.from('download bytes')
    })(),
    '../../safe.html'
  )
  const url = `${s.rig.base}/api/browser/files/${file.id}`
  expect((await fetch(url)).status).toBe(401)
  const res = await fetch(url, { headers: { Cookie: s.cookie } })
  expect(res.status).toBe(200)
  expect(res.headers.get('content-disposition')).toContain('attachment;')
  expect(res.headers.get('cache-control')).toBe('private, no-store')
  expect(await res.text()).toBe('download bytes')
  expect(s.adapter.instances).toHaveLength(0)
  s.advance(3600000)
  expect((await fetch(url, { headers: { Cookie: s.cookie } })).status).toBe(404)
})
it('accepts native uploads only for the authenticated live controlling viewer and exact page', async () => {
  const s = await setup('vps'),
    c = await connect(s.rig, s.cookie)
  c.send({ id: 1, op: 'watch', target: { agent: 'a' } })
  await c.response(1)
  const post = (token: string, cookie = s.cookie, generation = stamp.generation) =>
    fetch(`${s.rig.base}/api/browser/files/stage`, {
      method: 'POST',
      headers: {
        Cookie: cookie,
        Origin: ORIGIN,
        'X-Browser-Upload': token,
        'X-Browser-Generation': generation,
        'X-Browser-Tab': stamp.tabId,
        'X-File-Name': 'native.txt'
      },
      body: 'native bytes'
    })
  const token = c.status().status.uploadToken!
  expect(typeof token).toBe('string')
  expect((await post(token)).status).toBe(403)
  c.send({ id: 2, op: 'takeControl', watchId: 1, ...stamp })
  await c.response(2)
  expect((await post(token, `cb_session=${await s.auth.createSession()}`)).status).toBe(403)
  expect((await post(token, s.cookie, 'stale')).status).toBe(403)
  const res = await post(token)
  expect(res.status).toBe(200)
  const file = await res.json()
  expect(file).toEqual({ id: expect.any(String), name: 'native.txt', size: 12 })
  c.send({ id: 3, op: 'navigate', watchId: 1, ...stamp, command: { op: 'chooseFiles', fileIds: [file.id] } })
  expect((await c.response(3)).ok).toBe(true)
  c.send({ id: 4, op: 'unwatch', watchId: 1 })
  await c.response(4)
  expect((await post(token)).status).toBe(403)
})
