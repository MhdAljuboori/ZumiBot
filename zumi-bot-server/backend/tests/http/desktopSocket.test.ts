import { spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { createConnection, createServer, type Server, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { WebSocket } from 'ws'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type {
  DesktopConfig,
  DesktopHandoff,
  DesktopOwner,
  DesktopRequest,
  DesktopServerMessage,
  DesktopStatus
} from '@zumibot/shared/desktop'
import { AuthStore } from '../../src/auth/authStore'
import { createGate } from '../../src/auth/guard'
import { createLimiter } from '../../src/auth/rateLimit'
import { BrowserProfileStore } from '../../src/core/browser/profileStore'
import { DesktopManager } from '../../src/core/desktop/desktopManager'
import { RfbClientFilter } from '../../src/core/desktop/rfbFilter'
import type { CuaResult, DesktopAdapter, DesktopInstance } from '../../src/core/desktop/types'
import { createDesktopHub, type DesktopHub } from '../../src/http/desktopSocket'
import { startRig, type Rig } from './helpers'

const ORIGIN = 'http://desktop.test',
  SECRET = '0123456789abcdef0123456789abcdef'
const FIXTURE = fileURLToPath(new URL('../fixtures/fake-xvnc.mjs', import.meta.url))
const CONFIG: DesktopConfig = {
  max: 2,
  idleMs: 900000,
  leaseIdleMs: 120000,
  handoffIdleMs: 600000,
  commandMs: 30000,
  queueMs: 120000,
  width: 1280,
  height: 800
}
const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const fn of cleanups.splice(0).reverse()) await fn().catch(() => undefined)
})

/** One fake desktop: the repo's fake Xvnc on a unix socket, logging the RFB input it receives. */
class XvncDesktop implements DesktopInstance {
  private exited = false
  private closing = false
  private readonly listeners = new Set<() => void>()
  private readonly exit: Promise<void>
  constructor(
    readonly generation: string,
    readonly vncSocket: string,
    readonly display: number,
    private readonly log: string,
    readonly child: ChildProcess,
    private readonly proxy?: { server: Server; fronts: Set<Socket> }
  ) {
    this.exit = new Promise((resolve) =>
      child.once('exit', () => {
        this.exited = true
        resolve()
        if (!this.closing) for (const cb of [...this.listeners]) cb()
      })
    )
  }
  async call(tool: string): Promise<CuaResult> {
    if (tool === 'get_desktop_state')
      return {
        content: [{ type: 'image', mimeType: 'image/png', data: 'iVBORw0KGgo=' }],
        isError: false,
        structuredContent: { screenshot_width: 1280, screenshot_height: 800 }
      }
    return { content: [], isError: false, structuredContent: {} }
  }
  isClosed() {
    return this.exited
  }
  onExit(cb: () => void) {
    this.listeners.add(cb)
    return () => {
      this.listeners.delete(cb)
    }
  }
  async close() {
    this.closing = true
    this.proxy?.server.close()
    this.cut()
    if (!this.exited) this.child.kill('SIGTERM')
    await this.exit
  }
  /** Xvnc drops its viewers' connections while it keeps running (needs the adapter's proxy). */
  cut() {
    for (const front of this.proxy?.fronts ?? []) front.destroy()
  }
  /** Xvnc dies on its own: the adapter's crash path. */
  crash() {
    this.child.kill('SIGKILL')
  }
  entries(): Record<string, unknown>[] {
    try {
      return readFileSync(this.log, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Record<string, unknown>)
    } catch {
      return []
    }
  }
  inputs() {
    return this.entries().filter((e) => e.type === 'key' || e.type === 'pointer' || e.type === 'cut')
  }
}
class XvncAdapter implements DesktopAdapter {
  instances: XvncDesktop[] = []
  /** Put a unix-socket proxy in front of Xvnc, so a test can drop viewer connections. */
  proxy = false
  constructor(private readonly root: string) {}
  async launch(): Promise<DesktopInstance> {
    const n = this.instances.length + 1,
      sock = join(this.root, `vnc${n}.sock`),
      log = join(this.root, `xvnc${n}.log`)
    const real = this.proxy ? join(this.root, `vnc${n}.real.sock`) : sock
    const child = spawn(process.execPath, [FIXTURE, `:${90 + n}`, '-rfbunixpath', real], {
      env: { PATH: process.env.PATH, FAKE_XVNC_LOG: log },
      stdio: 'ignore'
    })
    let proxy: { server: Server; fronts: Set<Socket> } | undefined
    if (this.proxy) {
      const fronts = new Set<Socket>()
      const server = createServer((front) => {
        const back = createConnection(real)
        fronts.add(front)
        front.pipe(back)
        back.pipe(front)
        const end = () => {
          fronts.delete(front)
          front.destroy()
          back.destroy()
        }
        for (const side of [front, back]) {
          side.on('error', end)
          side.on('close', end)
        }
      })
      await new Promise<void>((resolve) => server.listen(sock, resolve))
      proxy = { server, fronts }
    }
    const instance = new XvncDesktop(`gen${n}`, sock, 90 + n, log, child, proxy)
    this.instances.push(instance)
    for (let i = 0; ; i++) {
      if (instance.isClosed() || i > 500) throw new Error('fake Xvnc did not start')
      try {
        await stat(real)
        break
      } catch {
        await sleep(10)
      }
    }
    return instance
  }
}
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

async function setup(o: { mode?: 'local' | 'vps'; config?: Partial<DesktopConfig>; pingMs?: number } = {}) {
  let clock = 1700000000000
  const mode = o.mode ?? 'local'
  const root = await mkdtemp(join(tmpdir(), 'cb-desk-'))
  const profiles = new BrowserProfileStore(root, undefined, 'desktops')
  await profiles.load()
  const adapter = new XvncAdapter(root),
    handoffs: DesktopHandoff[] = []
  const manager = new DesktopManager({
    profiles,
    adapter,
    config: { ...CONFIG, ...o.config },
    now: () => clock,
    newId: () => randomUUID(),
    resolveTarget: async (target) => {
      if (!['a', 'b'].includes(target.agent) || (target.chatId && target.chatId !== 'chat')) throw new Error('Denied target')
      return { agent: target.agent, ...(await profiles.ensure(target.agent)) }
    },
    onHandoff: async (handoff) => {
      handoffs.push({ ...handoff })
    },
    log: () => {}
  })
  const auth = new AuthStore(root, () => clock)
  const hub = createDesktopHub({
    manager,
    isValid: mode === 'vps' ? (k) => auth.checkSessionKey(k) : async () => true,
    now: () => clock,
    pingMs: o.pingMs
  })
  let rig!: Rig
  const gate = createGate({
    config: {
      mode,
      port: 0,
      dataDir: root,
      vaultKeyFile: join(root, '..', 'unused-vault.key'),
      agentsDir: root,
      webDir: root,
      origin: ORIGIN,
      localSecret: SECRET,
      migrateFrom: null
    },
    auth,
    limiter: createLimiter({ now: () => clock }),
    hub: () => rig.hub,
    desktopHub: () => hub,
    log: () => {}
  })
  rig = await startRig({ gate, desktopHub: hub, sessionKey: gate.sessionKey })
  cleanups.push(async () => {
    hub.closeAll(1001)
    hub.dispose()
    await manager.close()
    await rig.close()
    for (const instance of adapter.instances) if (!instance.isClosed()) instance.child.kill('SIGKILL')
    await rm(rig.root, { recursive: true, force: true })
    await rm(root, { recursive: true, force: true })
  })
  const cookie = mode === 'local' ? `cb_local=${SECRET}` : `cb_session=${await auth.createSession()}`
  const owner = async (agent = 'a', turnId = 'turn'): Promise<DesktopOwner> => ({
    profileId: (await profiles.ensure(agent)).id,
    chatId: 'chat',
    turnId
  })
  return {
    rig,
    root,
    manager,
    adapter,
    hub,
    auth,
    cookie,
    handoffs,
    owner,
    clock: () => clock,
    advance: (ms: number) => {
      clock += ms
    }
  }
}

type Event = { kind: 'json'; message: DesktopServerMessage } | { kind: 'bytes'; data: Buffer }
type Response = Extract<DesktopServerMessage, { type: 'response' }>
interface Peer {
  events: Event[]
  request(req: DesktopRequest): void
  bytes(data: Uint8Array | number[]): void
}

async function connect(rig: Rig, cookie: string, origin = ORIGIN) {
  const ws = new WebSocket(`ws://127.0.0.1:${rig.port}/ws/desktop`, { headers: { Cookie: cookie, Origin: origin } })
  const events: Event[] = []
  ws.on('message', (data, binary) => {
    events.push(binary ? { kind: 'bytes', data: Buffer.from(data as Buffer) } : { kind: 'json', message: JSON.parse(String(data)) })
  })
  const closed = new Promise<number>((resolve) => ws.once('close', resolve))
  await new Promise<void>((resolve, reject) => {
    ws.once('open', resolve)
    ws.once('error', reject)
  })
  cleanups.push(async () => {
    ws.terminate()
  })
  const peer: Peer & { ws: WebSocket; closed: Promise<number> } = {
    ws,
    events,
    closed,
    request: (req) => ws.send(JSON.stringify(req)),
    bytes: (data) => ws.send(Buffer.from(data), { binary: true })
  }
  return peer
}

/** A socket the test drives directly: write completion and buffered bytes are the external boundary. */
class FakeSocket extends EventEmitter implements Peer {
  OPEN = 1
  CLOSED = 3
  readyState = 1
  bufferedAmount = 0
  code?: number
  pings = 0
  events: Event[] = []
  send(data: string | Uint8Array, callback?: (error?: Error) => void) {
    this.events.push(typeof data === 'string' ? { kind: 'json', message: JSON.parse(data) } : { kind: 'bytes', data: Buffer.from(data) })
    callback?.()
  }
  ping() {
    this.pings++
  }
  close(code: number) {
    if (this.readyState === 3) return
    this.code = code
    this.readyState = 3
    this.emit('close')
  }
  terminate() {
    this.close(1006)
  }
  request(req: DesktopRequest) {
    this.emit('message', Buffer.from(JSON.stringify(req)), false)
  }
  bytes(data: Uint8Array | number[]) {
    this.emit('message', Buffer.from(data), true)
  }
}
function fake(hub: DesktopHub, key = 'session'): FakeSocket {
  const ws = new FakeSocket()
  hub.attach(ws as unknown as WebSocket, key)
  return ws
}

const jsons = (p: Peer) => p.events.flatMap((e) => (e.kind === 'json' ? [e.message] : []))
async function response(p: Peer, id: number): Promise<Response> {
  const find = () => jsons(p).find((m) => m.type === 'response' && m.id === id) as Response | undefined
  await vi.waitFor(() => expect(find()).toBeDefined(), { timeout: 5000 })
  return find()!
}
const lastStatus = (p: Peer): DesktopStatus | undefined =>
  (
    jsons(p)
      .filter((m) => m.type === 'status')
      .at(-1) as { status: DesktopStatus } | undefined
  )?.status
const rfbs = (p: Peer) => jsons(p).filter((m) => m.type === 'rfb')
const legCount = (p: Peer) => rfbs(p).filter((m) => m.type === 'rfb' && m.state === 'open').length
/** Server bytes of the leg-th RFB leg (0-based): binary frames between its open and closed. */
function legBytes(p: Peer, leg: number): Buffer {
  let n = -1,
    inside = false
  const parts: Buffer[] = []
  for (const e of p.events) {
    if (e.kind === 'json') {
      if (e.message.type === 'rfb') {
        if (e.message.state === 'open') {
          n++
          inside = n === leg
        } else if (n === leg) inside = false
      }
    } else if (inside) parts.push(e.data)
  }
  return Buffer.concat(parts)
}
async function waitBytes(p: Peer, leg: number, n: number) {
  await vi.waitFor(() => expect(legBytes(p, leg).length).toBeGreaterThanOrEqual(n), { timeout: 5000 })
}
/** RFB 3.8, security None, a 'fake' named desktop: 12 + 2 + 4 + 28 server bytes. */
async function handshake(p: Peer, leg = legCount(p) - 1) {
  await waitBytes(p, leg, 12)
  expect(legBytes(p, leg).subarray(0, 12).toString()).toBe('RFB 003.008\n')
  p.bytes(Buffer.from('RFB 003.008\n'))
  await waitBytes(p, leg, 14)
  p.bytes([1])
  await waitBytes(p, leg, 18)
  p.bytes([0])
  await waitBytes(p, leg, 46)
}
// A one-pixel full update: its reply proves Xvnc has read every byte sent before it.
const UPDATE = [3, 0, 0, 0, 0, 0, 0, 1, 0, 1]
async function barrier(p: Peer, leg = legCount(p) - 1) {
  const before = legBytes(p, leg).length
  p.bytes(UPDATE)
  await waitBytes(p, leg, before + 20)
}
const pointer = (x: number, y: number) => [5, 1, x >> 8, x & 255, y >> 8, y & 255]
const KEY = [4, 1, 0, 0, 0, 0, 0, 0x61]
const CUT = [6, 0, 0, 0, 0, 0, 0, 2, 0x68, 0x69]
const watch = async (p: Peer, id: number, agent = 'a', chatId?: string) => {
  p.request({ id, op: 'watch', target: chatId ? { agent, chatId } : { agent } })
  return response(p, id)
}

describe('desktop socket routing', () => {
  it.each(['local', 'vps'] as const)('hostile Origin and missing session are refused with 4401 (%s)', async (mode) => {
    const s = await setup({ mode })
    for (const [cookie, origin] of [
      ['wrong=cookie', ORIGIN],
      [s.cookie, 'http://evil.test']
    ]) {
      const c = await connect(s.rig, cookie, origin)
      expect(await c.closed).toBe(4401)
    }
    expect(s.adapter.instances).toHaveLength(0)
    const c = await connect(s.rig, s.cookie)
    expect((await watch(c, 1)).ok).toBe(true)
  })
  it('caps a binary frame at 1 MiB plus a cut-text header and a request at 64 KiB', async () => {
    const s = await setup(),
      big = await connect(s.rig, s.cookie),
      json = await connect(s.rig, s.cookie)
    big.bytes(new Uint8Array(1024 * 1024 + 9))
    expect(await big.closed).toBe(1009)
    json.ws.send('x'.repeat(64 * 1024 + 1))
    expect(await json.closed).toBe(1009)
  })
})

describe('watching', () => {
  it('watch starts the desktop and opens an rfb leg', async () => {
    const s = await setup(),
      c = await connect(s.rig, s.cookie)
    await sleep(20)
    expect(s.adapter.instances).toHaveLength(0)
    expect((await watch(c, 1)).ok).toBe(true)
    expect(s.adapter.instances).toHaveLength(1)
    expect(rfbs(c)).toEqual([{ type: 'rfb', watchId: 1, state: 'open', generation: 'gen1' }])
    await vi.waitFor(() => expect(lastStatus(c)).toMatchObject({ agent: 'a', state: 'ready', generation: 'gen1', control: 'agent' }))
    expect(
      jsons(c)
        .filter((m) => m.type === 'status')
        .every((m) => m.type === 'status' && m.watchId === 1)
    ).toBe(true)
    // The VNC socket path stays on the server.
    expect(JSON.stringify(jsons(c))).not.toContain(s.root)
  })
  it('RFB bytes flow both ways', async () => {
    const s = await setup(),
      c = await connect(s.rig, s.cookie)
    await watch(c, 1)
    await handshake(c)
    // A viewer never takes the desktop exclusively: ClientInit is forced to shared.
    await vi.waitFor(() => expect(s.adapter.instances[0].entries().filter((e) => e.type === 'init')).toEqual([{ type: 'init', shared: 1 }]))
    await barrier(c)
    expect(legBytes(c, 0).length).toBe(66)
  })
  it('pointer input without control never reaches the fake Xvnc log', async () => {
    const s = await setup(),
      c = await connect(s.rig, s.cookie)
    await watch(c, 1)
    await handshake(c)
    c.bytes(pointer(10, 20))
    c.bytes(KEY)
    c.bytes(CUT)
    await barrier(c)
    expect(s.adapter.instances[0].inputs()).toEqual([])
    expect(c.ws.readyState).toBe(WebSocket.OPEN)
  })
  it('with takeControl it does, and releaseControl stops it again', async () => {
    const s = await setup(),
      c = await connect(s.rig, s.cookie)
    await watch(c, 1)
    await handshake(c)
    c.request({ id: 2, op: 'takeControl' })
    expect(await response(c, 2)).toEqual({ type: 'response', id: 2, ok: true, value: null })
    expect(lastStatus(c)?.control).toBe('you')
    c.bytes(pointer(10, 20))
    c.bytes(KEY)
    await barrier(c)
    expect(s.adapter.instances[0].inputs()).toEqual([
      { type: 'pointer', mask: 1, x: 10, y: 20 },
      { type: 'key', down: true, key: 0x61 }
    ])
    c.request({ id: 3, op: 'releaseControl' })
    expect((await response(c, 3)).ok).toBe(true)
    c.bytes(pointer(30, 40))
    await barrier(c)
    expect(s.adapter.instances[0].inputs()).toHaveLength(2)
    expect(lastStatus(c)?.control).toBe('agent')
  })
  it('input sent after releaseControl is dropped before the manager has released', async () => {
    const s = await setup(),
      c = await connect(s.rig, s.cookie)
    await watch(c, 1)
    await handshake(c)
    c.request({ id: 2, op: 'takeControl' })
    expect((await response(c, 2)).ok).toBe(true)
    c.request({ id: 3, op: 'releaseControl' })
    c.bytes(pointer(7, 7))
    await barrier(c)
    expect(s.adapter.instances[0].inputs()).toEqual([])
    expect((await response(c, 3)).ok).toBe(true)
    // Taking control again turns input back on, in receive order too.
    c.request({ id: 4, op: 'takeControl' })
    expect((await response(c, 4)).ok).toBe(true)
    c.bytes(pointer(8, 8))
    await barrier(c)
    expect(s.adapter.instances[0].inputs()).toEqual([{ type: 'pointer', mask: 1, x: 8, y: 8 }])
  })
  it('second socket sees control other and its input is dropped', async () => {
    const s = await setup(),
      a = await connect(s.rig, s.cookie),
      b = await connect(s.rig, s.cookie)
    await watch(a, 1)
    await watch(b, 1)
    await handshake(a)
    await handshake(b)
    a.request({ id: 2, op: 'takeControl' })
    expect((await response(a, 2)).ok).toBe(true)
    await vi.waitFor(() => expect(lastStatus(b)?.control).toBe('other'))
    b.bytes(pointer(1, 2))
    await barrier(b)
    a.bytes(pointer(3, 4))
    await barrier(a)
    expect(s.adapter.instances[0].inputs()).toEqual([{ type: 'pointer', mask: 1, x: 3, y: 4 }])
    // Control is never stolen.
    b.request({ id: 2, op: 'takeControl' })
    expect(await response(b, 2)).toEqual({ type: 'response', id: 2, ok: false, error: 'Desktop is controlled in another window' })
    expect(lastStatus(a)?.control).toBe('you')
  })
  it('closing the socket releases control and leaves no viewer registered', async () => {
    const s = await setup({ config: { idleMs: 200 } }),
      a = await connect(s.rig, s.cookie),
      b = await connect(s.rig, s.cookie)
    await watch(a, 1)
    await watch(b, 1)
    a.request({ id: 2, op: 'takeControl' })
    expect((await response(a, 2)).ok).toBe(true)
    await vi.waitFor(() => expect(lastStatus(b)?.control).toBe('other'))
    a.ws.close()
    await vi.waitFor(() => expect(lastStatus(b)?.control).toBe('agent'))
    expect((await s.manager.status('a')).control).toBe('agent')
    b.request({ id: 2, op: 'takeControl' })
    expect((await response(b, 2)).ok).toBe(true)
    b.ws.close()
    // Only a desktop nobody watches or controls idles out.
    await vi.waitFor(() => expect(s.adapter.instances[0].isClosed()).toBe(true), { timeout: 3000 })
    expect(await s.manager.status('a')).toMatchObject({ state: 'stopped', control: 'agent' })
  })
  it('desktop restart sends rfb closed then open with the new generation', async () => {
    const s = await setup(),
      c = await connect(s.rig, s.cookie)
    await watch(c, 1)
    await handshake(c)
    s.adapter.instances[0].crash()
    await vi.waitFor(() =>
      expect(rfbs(c)).toEqual([
        { type: 'rfb', watchId: 1, state: 'open', generation: 'gen1' },
        { type: 'rfb', watchId: 1, state: 'closed', generation: 'gen1' }
      ])
    )
    // Bytes for a leg that ended are dropped.
    c.bytes(pointer(1, 1))
    // The agent's next call starts the next generation, and the watching viewer follows it.
    await s.manager.run(await s.owner(), { op: 'screenshot' }, new AbortController().signal)
    await vi.waitFor(() =>
      expect(rfbs(c)).toEqual([
        { type: 'rfb', watchId: 1, state: 'open', generation: 'gen1' },
        { type: 'rfb', watchId: 1, state: 'closed', generation: 'gen1' },
        { type: 'rfb', watchId: 1, state: 'open', generation: 'gen2' }
      ])
    )
    // Left over from the old leg's viewer: dropped before the new handshake starts.
    c.bytes(pointer(2, 2))
    await handshake(c, 1)
    await barrier(c, 1)
    expect(s.adapter.instances[1].entries().filter((e) => e.type === 'init')).toHaveLength(1)
    expect(lastStatus(c)).toMatchObject({ generation: 'gen2', state: 'ready' })
    expect(c.ws.readyState).toBe(WebSocket.OPEN)
  })
  it('Xvnc dropping only this connection closes the leg; a re-watch gets a new one', async () => {
    const s = await setup()
    s.adapter.proxy = true
    const c = await connect(s.rig, s.cookie)
    await watch(c, 1)
    await handshake(c)
    s.adapter.instances[0].cut()
    await vi.waitFor(() => expect(rfbs(c).at(-1)).toEqual({ type: 'rfb', watchId: 1, state: 'closed', generation: 'gen1' }))
    // The desktop itself still runs: the manager will not attach this watch again for the same generation.
    expect(lastStatus(c)).toMatchObject({ state: 'ready', generation: 'gen1' })
    await watch(c, 2)
    expect(rfbs(c).at(-1)).toEqual({ type: 'rfb', watchId: 2, state: 'open', generation: 'gen1' })
    await handshake(c)
    await barrier(c)
    expect(s.adapter.instances).toHaveLength(1)
  })
  it('a 1 MiB clipboard paste fits in one frame and reaches Xvnc through the filter', async () => {
    const s = await setup(),
      c = await connect(s.rig, s.cookie)
    await watch(c, 1)
    await handshake(c)
    c.request({ id: 2, op: 'takeControl' })
    expect((await response(c, 2)).ok).toBe(true)
    const paste = Buffer.alloc(8 + 1024 * 1024, 0x61)
    paste.fill(0, 0, 8)
    paste[0] = 6
    paste.writeInt32BE(1024 * 1024, 4)
    c.bytes(paste)
    await barrier(c)
    expect(s.adapter.instances[0].inputs().map((e) => (e.type === 'cut' ? (e.text as string).length : e.type))).toEqual([1024 * 1024])
    expect(c.ws.readyState).toBe(WebSocket.OPEN)
  })
  it('a new watch replaces the old one; unwatch closes the leg', async () => {
    const s = await setup(),
      c = await connect(s.rig, s.cookie)
    await watch(c, 1, 'a')
    await watch(c, 2, 'b')
    expect(rfbs(c)).toEqual([
      { type: 'rfb', watchId: 1, state: 'open', generation: 'gen1' },
      { type: 'rfb', watchId: 1, state: 'closed', generation: 'gen1' },
      { type: 'rfb', watchId: 2, state: 'open', generation: 'gen2' }
    ])
    expect(lastStatus(c)?.agent).toBe('b')
    c.request({ id: 3, op: 'unwatch' })
    expect((await response(c, 3)).ok).toBe(true)
    expect(rfbs(c).at(-1)).toEqual({ type: 'rfb', watchId: 2, state: 'closed', generation: 'gen2' })
    // A watch that ended hears nothing more, and bytes without a leg are dropped.
    const seen = c.events.length
    await s.manager.run(await s.owner('a'), { op: 'screenshot' }, new AbortController().signal)
    c.bytes(pointer(1, 1))
    c.request({ id: 4, op: 'releaseControl' })
    expect((await response(c, 4)).ok).toBe(true)
    expect(c.events.slice(seen).filter((e) => e.kind === 'bytes' || e.message.type !== 'response')).toEqual([])
  })
  it('refuses unauthorized targets and requests without a watch', async () => {
    const s = await setup(),
      c = await connect(s.rig, s.cookie)
    for (const [id, target] of [
      [1, { agent: 'other' }],
      [2, { agent: 'a', chatId: 'not-member' }]
    ] as const) {
      c.request({ id, op: 'watch', target })
      expect(await response(c, id)).toMatchObject({ ok: false, error: 'Desktop request denied or unavailable' })
    }
    c.request({ id: 3, op: 'takeControl' })
    expect((await response(c, 3)).ok).toBe(false)
    // A fabricated viewer id is not part of the contract.
    c.ws.send(JSON.stringify({ id: 4, op: 'watch', target: { agent: 'a' }, viewerId: 'other' }))
    expect((await response(c, 4)).ok).toBe(false)
    expect(s.adapter.instances).toHaveLength(0)
  })
})

describe('control order', () => {
  it('control requests reach the manager and are answered in receive order, whatever order the session checks finish in', async () => {
    const calls: string[] = []
    let control = false
    const manager = {
      watch: async () => ({ close: async () => {} }),
      connect: async () => ({ close: async () => {} }),
      takeControl: async () => {
        calls.push('take')
        control = true
        await sleep(30)
      },
      releaseControl: async () => {
        calls.push('release')
        control = false
      },
      answer: async () => {
        calls.push('answer')
      },
      canInput: () => control
    }
    let n = 0
    // Like auth.checkSessionKey reading auth.json: a later check may finish first.
    const hub = createDesktopHub({
      manager,
      isValid: async () => {
        const me = ++n
        await sleep(me === 2 ? 20 : 0)
        return true
      }
    })
    cleanups.push(async () => hub.dispose())
    const ws = fake(hub)
    await watch(ws, 1)
    ws.request({ id: 2, op: 'takeControl' })
    ws.request({ id: 3, op: 'releaseControl' })
    await response(ws, 3)
    expect(calls).toEqual(['take', 'release'])
    expect(control).toBe(false)
    expect(
      jsons(ws)
        .filter((m) => m.type === 'response')
        .map((m) => (m.type === 'response' ? m.id : -1))
    ).toEqual([1, 2, 3])
  })
  it('a takeControl still waiting on the agent does not hold back a later releaseControl', async () => {
    const calls: string[] = []
    let drained = () => {}
    const manager = {
      watch: async () => ({ close: async () => {} }),
      connect: async () => ({ close: async () => {} }),
      // Settles only once the release has reached the manager.
      takeControl: async () => {
        calls.push('take')
        await new Promise<void>((resolve) => {
          drained = resolve
        })
      },
      releaseControl: async () => {
        calls.push('release')
        drained()
      },
      answer: async () => {},
      canInput: () => false
    }
    const hub = createDesktopHub({ manager, isValid: async () => true })
    cleanups.push(async () => {
      drained()
      hub.dispose()
    })
    const ws = fake(hub)
    await watch(ws, 1)
    ws.request({ id: 2, op: 'takeControl' })
    ws.request({ id: 3, op: 'releaseControl' })
    await response(ws, 3)
    expect(calls).toEqual(['take', 'release'])
    expect(
      jsons(ws)
        .filter((m) => m.type === 'response')
        .map((m) => (m.type === 'response' ? m.id : -1))
    ).toEqual([1, 2, 3])
  })
})

describe('handoff answers', () => {
  it('answer done resolves the handoff through the watching viewer, releasing its control first', async () => {
    const s = await setup(),
      c = await connect(s.rig, s.cookie)
    await watch(c, 1, 'a', 'chat')
    const pending = s.manager.run(await s.owner(), { op: 'requestUserAction', reason: 'Sign in please' }, new AbortController().signal)
    await vi.waitFor(() => expect(lastStatus(c)?.pendingRequestId).toBeTruthy())
    const requestId = lastStatus(c)!.pendingRequestId!
    c.request({ id: 2, op: 'takeControl' })
    expect((await response(c, 2)).ok).toBe(true)
    c.request({ id: 3, op: 'answer', target: { agent: 'a', chatId: 'chat', requestId }, requestId, decision: 'done' })
    expect((await response(c, 3)).ok).toBe(true)
    expect(await pending).toEqual({ ok: true, data: { status: 'done' } })
    expect((await s.manager.status('a')).control).toBe('agent')
    // The watch keeps its leg.
    expect(rfbs(c)).toEqual([{ type: 'rfb', watchId: 1, state: 'open', generation: 'gen1' }])
  })
  it('answer done resolves the handoff without a watch, starting nothing', async () => {
    const s = await setup(),
      c = await connect(s.rig, s.cookie)
    const pending = s.manager.run(await s.owner(), { op: 'requestUserAction', reason: 'Help' }, new AbortController().signal)
    await vi.waitFor(() => expect(s.handoffs).toHaveLength(1))
    const requestId = s.handoffs[0].id
    c.request({ id: 1, op: 'answer', target: { agent: 'a', chatId: 'chat', requestId }, requestId, decision: 'cancel' })
    expect((await response(c, 1)).ok).toBe(true)
    expect(await pending).toMatchObject({ ok: false, code: 'handoff_cancelled' })
    expect(s.adapter.instances).toHaveLength(1)
    expect(rfbs(c)).toEqual([])
    // A stale answer is refused and launches nothing either.
    c.request({ id: 2, op: 'answer', target: { agent: 'b' }, requestId, decision: 'done' })
    expect(await response(c, 2)).toMatchObject({ ok: false, error: 'Desktop request denied or unavailable' })
    expect(s.adapter.instances).toHaveLength(1)
  })
  it('another viewer holding control makes answer fail with a fixed error', async () => {
    const s = await setup(),
      a = await connect(s.rig, s.cookie),
      b = await connect(s.rig, s.cookie)
    await watch(a, 1, 'a', 'chat')
    const pending = s.manager.run(await s.owner(), { op: 'requestUserAction', reason: 'Help' }, new AbortController().signal)
    await vi.waitFor(() => expect(lastStatus(a)?.pendingRequestId).toBeTruthy())
    const requestId = lastStatus(a)!.pendingRequestId!
    a.request({ id: 2, op: 'takeControl' })
    expect((await response(a, 2)).ok).toBe(true)
    const answer = { op: 'answer', target: { agent: 'a', chatId: 'chat', requestId }, requestId, decision: 'done' } as const
    // From a card (no watch), then from a window watching the same desktop: neither steals control.
    b.request({ id: 1, ...answer })
    expect(await response(b, 1)).toEqual({ type: 'response', id: 1, ok: false, error: 'Desktop is controlled in another window' })
    await watch(b, 2, 'a', 'chat')
    b.request({ id: 3, ...answer })
    expect(await response(b, 3)).toEqual({ type: 'response', id: 3, ok: false, error: 'Desktop is controlled in another window' })
    expect(lastStatus(a)).toMatchObject({ control: 'you', pendingRequestId: requestId })
    expect(s.handoffs.at(-1)?.status).toBe('pending')
    a.request({ id: 3, op: 'answer', target: { agent: 'a', chatId: 'chat', requestId }, requestId, decision: 'done' })
    expect((await response(a, 3)).ok).toBe(true)
    expect((await pending).ok).toBe(true)
  })
})

describe('resource bounds and failures', () => {
  it('stalled viewer is dropped, others keep streaming', async () => {
    const s = await setup(),
      a = fake(s.hub),
      b = fake(s.hub)
    await watch(a, 1)
    await watch(b, 1)
    await handshake(a)
    await handshake(b)
    a.bufferedAmount = 5 * 1024 * 1024
    a.bytes(UPDATE)
    b.bytes(UPDATE)
    await waitBytes(a, 0, 66)
    await waitBytes(b, 0, 66)
    // Paused: Xvnc's next reply waits on the unix socket instead of piling up in memory.
    a.bytes(UPDATE)
    await barrier(b)
    await sleep(150)
    expect(legBytes(a, 0).length).toBe(66)
    s.advance(10001)
    await vi.waitFor(() => expect(a.code).toBe(1008))
    await barrier(b)
    await barrier(b)
    expect(b.readyState).toBe(1)
    expect(s.adapter.instances[0].isClosed()).toBe(false)
    expect(s.adapter.instances).toHaveLength(1)
  })
  it('a slow viewer resumes when its buffer drains', async () => {
    const s = await setup(),
      a = fake(s.hub)
    await watch(a, 1)
    await handshake(a)
    a.bufferedAmount = 5 * 1024 * 1024
    await barrier(a)
    a.bytes(UPDATE)
    await sleep(150)
    expect(legBytes(a, 0).length).toBe(66)
    s.advance(9000)
    a.bufferedAmount = 0
    await waitBytes(a, 0, 86)
    s.advance(2000)
    await barrier(a)
    expect(a.readyState).toBe(1)
  })
  it('a viewer that gets 4 MiB ahead of a stalled Xvnc is closed; the desktop stays', async () => {
    const s = await setup(),
      a = fake(s.hub)
    await watch(a, 1)
    await handshake(a)
    const xvnc = s.adapter.instances[0]
    xvnc.child.kill('SIGSTOP')
    cleanups.push(async () => {
      xvnc.child.kill('SIGCONT')
    })
    // Incremental update requests: forwarded for any watcher, and the fake neither logs nor answers them.
    const count = 104857,
      frame = Buffer.alloc(count * 10)
    for (let i = 0; i < count; i++) {
      frame[i * 10] = 3
      frame[i * 10 + 1] = 1
    }
    for (let i = 0; i < 8 && a.code === undefined; i++) {
      a.bytes(frame)
      await sleep(20)
    }
    expect(a.code).toBe(1008)
    xvnc.child.kill('SIGCONT')
    await sleep(50)
    expect(xvnc.isClosed()).toBe(false)
  })
  it('a filter exception closes the viewer without detail', async () => {
    const s = await setup(),
      c = await connect(s.rig, s.cookie)
    await watch(c, 1)
    c.request({ id: 2, op: 'takeControl' })
    expect((await response(c, 2)).ok).toBe(true)
    vi.spyOn(RfbClientFilter.prototype, 'push').mockImplementationOnce(() => {
      throw new Error(`filter failed at ${s.root}`)
    })
    await waitBytes(c, 0, 12)
    c.bytes(Buffer.from('RFB 003.008\n'))
    expect(await c.closed).toBe(1011)
    expect(JSON.stringify(jsons(c))).not.toContain('filter failed')
    await vi.waitFor(async () => expect((await s.manager.status('a')).control).toBe('agent'))
  })
  it('an RFB protocol violation closes the viewer before anything reaches Xvnc', async () => {
    const s = await setup(),
      c = await connect(s.rig, s.cookie)
    await watch(c, 1)
    await handshake(c)
    c.request({ id: 2, op: 'takeControl' })
    expect((await response(c, 2)).ok).toBe(true)
    c.bytes([...pointer(5, 5), 7])
    expect(await c.closed).toBe(1008)
    await sleep(50)
    expect(s.adapter.instances[0].inputs()).toEqual([])
  })
  it('oversized JSON closes with 1009; malformed requests are refused', async () => {
    const s = await setup(),
      a = fake(s.hub),
      b = fake(s.hub)
    a.emit('message', Buffer.from('x'.repeat(64 * 1024 + 1)), false)
    expect(a.code).toBe(1009)
    b.emit('message', Buffer.from(JSON.stringify({ id: 1, op: 'steal' })), false)
    expect(await response(b, 1)).toMatchObject({ ok: false })
    b.emit('message', Buffer.from('not json'), false)
    expect(b.code).toBe(1008)
  })
  it('closes a socket past 60 requests a second', async () => {
    const s = await setup(),
      a = fake(s.hub),
      b = fake(s.hub)
    for (let id = 1; id <= 60; id++) {
      a.request({ id, op: 'unwatch' })
      if (id % 10 === 0) await response(a, id)
    }
    expect(a.code).toBeUndefined()
    a.request({ id: 61, op: 'unwatch' })
    expect(a.code).toBe(1008)
    // Each second starts a new budget.
    for (let id = 1; id <= 50; id++) {
      b.request({ id, op: 'unwatch' })
      if (id % 10 === 0) await response(b, id)
    }
    s.advance(1000)
    for (let id = 51; id <= 100; id++) {
      b.request({ id, op: 'unwatch' })
      if (id % 10 === 0) await response(b, id)
    }
    expect(b.code).toBeUndefined()
  })
  it('closes a socket with 16 requests outstanding', async () => {
    const s = await setup()
    let open!: () => void
    const gate = new Promise<boolean>((resolve) => {
      open = () => resolve(true)
    })
    const hub = createDesktopHub({ manager: s.manager, isValid: () => gate })
    cleanups.push(async () => {
      open()
      hub.dispose()
    })
    const a = fake(hub)
    for (let id = 1; id <= 16; id++) a.request({ id, op: 'unwatch' })
    expect(a.code).toBeUndefined()
    a.request({ id: 17, op: 'unwatch' })
    expect(a.code).toBe(1008)
  })
  it('requires increasing request ids', async () => {
    const s = await setup(),
      a = fake(s.hub)
    a.request({ id: 5, op: 'unwatch' })
    await response(a, 5)
    a.request({ id: 5, op: 'unwatch' })
    expect(a.code).toBe(1008)
  })
})

describe('sessions and heartbeat', () => {
  it('expires VPS sessions before granting control and revokes watches on sign-out', async () => {
    const s = await setup({ mode: 'vps' }),
      c = await connect(s.rig, s.cookie)
    await watch(c, 1)
    s.advance(31 * 24 * 3600000)
    c.request({ id: 2, op: 'takeControl' })
    expect(await c.closed).toBe(4401)
    expect((await s.manager.status('a')).control).toBe('agent')
    const d = await connect(s.rig, `cb_session=${await s.auth.createSession()}`)
    await watch(d, 3)
    const res = await fetch(`${s.rig.base}/api/logout`, {
      method: 'POST',
      headers: { Cookie: `cb_session=${await s.auth.createSession()}`, Origin: ORIGIN }
    })
    expect(res.status).toBe(204)
    // Another session's sign-out leaves this one alone.
    expect(d.ws.readyState).toBe(WebSocket.OPEN)
    const all = await fetch(`${s.rig.base}/api/logout-all`, {
      method: 'POST',
      headers: { Cookie: `cb_session=${await s.auth.createSession()}`, Origin: ORIGIN }
    })
    expect(all.status).toBe(204)
    expect(await d.closed).toBe(4401)
  })
  it('re-checks the session from the input path at most once a second', async () => {
    const s = await setup()
    let checks = 0,
      ok = true
    const hub = createDesktopHub({
      manager: s.manager,
      isValid: async () => {
        checks++
        return ok
      },
      now: s.clock
    })
    cleanups.push(async () => hub.dispose())
    const a = fake(hub)
    await watch(a, 1)
    await handshake(a)
    const before = checks
    a.bytes(UPDATE)
    a.bytes(UPDATE)
    a.bytes(UPDATE)
    expect(checks).toBe(before)
    s.advance(1000)
    a.bytes(UPDATE)
    a.bytes(UPDATE)
    a.bytes(UPDATE)
    expect(checks).toBe(before + 1)
    ok = false
    s.advance(1000)
    a.bytes(UPDATE)
    await vi.waitFor(() => expect(a.code).toBe(4401))
  })
  it('an expired VPS session stops input within a second, not at the next heartbeat', async () => {
    const s = await setup({ mode: 'vps' }),
      c = await connect(s.rig, s.cookie)
    await watch(c, 1)
    await handshake(c)
    c.request({ id: 2, op: 'takeControl' })
    expect((await response(c, 2)).ok).toBe(true)
    s.advance(31 * 24 * 3600000)
    const sent = Date.now()
    c.bytes(pointer(1, 1))
    expect(await c.closed).toBe(4401)
    expect(Date.now() - sent).toBeLessThan(1000)
    await vi.waitFor(async () => expect((await s.manager.status('a')).control).toBe('agent'))
  })
  it('two missed pongs close; a failed session check closes 4401', async () => {
    const s = await setup()
    let valid = true
    const hub = createDesktopHub({ manager: s.manager, isValid: async () => valid, pingMs: 20 })
    cleanups.push(async () => hub.dispose())
    const silent = fake(hub)
    await vi.waitFor(() => expect(silent.code).toBe(1001))
    expect(silent.pings).toBe(2)
    const answering = fake(hub)
    const pong = setInterval(() => answering.emit('pong'), 5)
    cleanups.push(async () => clearInterval(pong))
    await watch(answering, 1)
    await sleep(100)
    expect(answering.code).toBeUndefined()
    valid = false
    await vi.waitFor(() => expect(answering.code).toBe(4401))
  })
  it('drain stops watches, closeAll and dispose close sockets', async () => {
    const s = await setup(),
      a = fake(s.hub)
    await watch(a, 1)
    s.hub.drain()
    expect(rfbs(a).at(-1)).toEqual({ type: 'rfb', watchId: 1, state: 'closed', generation: 'gen1' })
    a.request({ id: 2, op: 'watch', target: { agent: 'a' } })
    await sleep(50)
    expect(jsons(a).some((m) => m.type === 'response' && m.id === 2)).toBe(false)
    s.hub.closeAll(1001)
    expect(a.code).toBe(1001)
    const late = fake(s.hub)
    expect(late.code).toBe(1001)
  })
})
