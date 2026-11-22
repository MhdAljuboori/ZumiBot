import { connect } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import WebSocket from 'ws'
import { PING_METHOD } from '@zumibot/shared/rpc'
import { startRig, type Rig } from './helpers'

let rig: Rig
afterEach(() => rig.close())

function open(r: Rig, session = 'k1', opts: object = {}): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${r.port}/ws`, { headers: { 'x-session': session }, ...opts })
    ws.once('open', () => resolve(ws))
    ws.once('error', reject)
  })
}

const call = (ws: WebSocket, req: object): Promise<any> =>
  new Promise((resolve) => {
    ws.once('message', (d) => resolve(JSON.parse(String(d))))
    ws.send(JSON.stringify(req))
  })

const closed = (ws: WebSocket): Promise<number> => new Promise((r) => ws.once('close', (code) => r(code)))

describe('hub', () => {
  it('answers a request with the handler value', async () => {
    rig = await startRig({ handlers: { 'x:add': async (a, b) => (a as number) + (b as number) } })
    const ws = await open(rig)
    expect(await call(ws, { id: 1, method: 'x:add', args: [2, 3] })).toEqual({ id: 1, ok: true, value: 5 })
  })

  it('answers a throwing handler with ok:false and its message', async () => {
    rig = await startRig({
      handlers: {
        'x:boom': async () => {
          throw new Error('nope')
        }
      }
    })
    const ws = await open(rig)
    expect(await call(ws, { id: 2, method: 'x:boom', args: [] })).toEqual({ id: 2, ok: false, error: 'nope' })
  })

  // The page's liveness check: answered by the hub itself, even while draining, since the socket is still alive.
  it('answers rpc:ping before any handler, also while draining', async () => {
    rig = await startRig()
    const ws = await open(rig)
    expect(await call(ws, { id: 9, method: PING_METHOD, args: [] })).toEqual({ id: 9, ok: true, value: true })
    rig.hub.drain()
    expect(await call(ws, { id: 10, method: PING_METHOD, args: [] })).toEqual({ id: 10, ok: true, value: true })
  })

  it('unknown method gives ok:false "Unknown method: x"', async () => {
    rig = await startRig()
    const ws = await open(rig)
    expect(await call(ws, { id: 3, method: 'x', args: [] })).toEqual({ id: 3, ok: false, error: 'Unknown method: x' })
  })

  it('does not resolve inherited names like toString', async () => {
    rig = await startRig()
    const ws = await open(rig)
    expect(await call(ws, { id: 4, method: 'toString', args: [] })).toEqual({ id: 4, ok: false, error: 'Unknown method: toString' })
  })

  it('broadcast reaches two clients', async () => {
    rig = await startRig()
    const a = await open(rig)
    const b = await open(rig)
    const got = [a, b].map((w) => new Promise<string>((r) => w.once('message', (d) => r(String(d)))))
    rig.hub.broadcast({ event: 'agents:changed', payload: [] })
    const msgs = await Promise.all(got)
    for (const m of msgs) expect(JSON.parse(m)).toEqual({ event: 'agents:changed', payload: [] })
  })

  it("closeSession(key) closes only that key's sockets with 4401", async () => {
    rig = await startRig()
    const a = await open(rig, 'k1')
    const b = await open(rig, 'k2')
    const codeA = closed(a)
    rig.hub.closeSession('k1')
    expect(await codeA).toBe(4401)
    await new Promise((r) => setTimeout(r, 50))
    expect(b.readyState).toBe(WebSocket.OPEN)
    expect(rig.hub.size()).toBe(1)
  })

  it("closeSession('all') closes all", async () => {
    rig = await startRig()
    const a = await open(rig)
    const b = await open(rig)
    const codes = Promise.all([closed(a), closed(b)])
    rig.hub.closeSession('all')
    expect(await codes).toEqual([4401, 4401])
  })

  it('a client that stops answering pings is terminated after 2 ping intervals', async () => {
    rig = await startRig({ pingMs: 50 })
    const ws = await open(rig, 'k1', { autoPong: false })
    const t0 = Date.now()
    await closed(ws)
    const elapsed = Date.now() - t0
    expect(elapsed).toBeGreaterThanOrEqual(2 * 50 - 30) // not killed at the first tick
    expect(elapsed).toBeLessThan(1000)
    expect(rig.hub.size()).toBe(0)
  })

  it('a socket whose isValid turns false is closed with 4401 at the next ping', async () => {
    let valid = true
    rig = await startRig({ pingMs: 50, isValid: async () => valid })
    const ws = await open(rig)
    await new Promise((r) => setTimeout(r, 120))
    expect(ws.readyState).toBe(WebSocket.OPEN)
    valid = false
    expect(await closed(ws)).toBe(4401)
  })
})

describe('hub connections', () => {
  it('gives a connHandler the connection id and session key, with a different id per socket', async () => {
    rig = await startRig({ connHandlers: { 'x:who': async (conn) => conn } })
    const a = await open(rig, 'k1')
    const b = await open(rig, 'k2')
    const ra = await call(a, { id: 1, method: 'x:who', args: [] })
    const rb = await call(b, { id: 1, method: 'x:who', args: [] })
    expect(ra.value.sessionKey).toBe('k1')
    expect(rb.value.sessionKey).toBe('k2')
    expect(typeof ra.value.id).toBe('string')
    expect(ra.value.id).not.toBe(rb.value.id)
    expect((await call(a, { id: 2, method: 'x:who', args: [] })).value.id).toBe(ra.value.id)
  })

  it('passes the call args after the connection', async () => {
    rig = await startRig({ connHandlers: { 'x:add': async (_c, a, b) => (a as number) + (b as number) } })
    const ws = await open(rig)
    expect(await call(ws, { id: 1, method: 'x:add', args: [2, 3] })).toEqual({ id: 1, ok: true, value: 5 })
  })

  it('plain handlers still work next to connHandlers, and a name in both uses the connHandler', async () => {
    rig = await startRig({
      handlers: { 'x:plain': async () => 'plain', 'x:both': async () => 'plain' },
      connHandlers: { 'x:both': async () => 'conn' }
    })
    const ws = await open(rig)
    expect((await call(ws, { id: 1, method: 'x:plain', args: [] })).value).toBe('plain')
    expect((await call(ws, { id: 2, method: 'x:both', args: [] })).value).toBe('conn')
  })

  it('does not resolve inherited names in connHandlers', async () => {
    rig = await startRig({ connHandlers: {} })
    const ws = await open(rig)
    expect(await call(ws, { id: 1, method: 'toString', args: [] })).toEqual({ id: 1, ok: false, error: 'Unknown method: toString' })
  })

  it('sendTo reaches only that socket and returns false after it closes or for an unknown id', async () => {
    rig = await startRig({ connHandlers: { 'x:who': async (conn) => conn.id } })
    const a = await open(rig)
    const b = await open(rig)
    const idA = (await call(a, { id: 1, method: 'x:who', args: [] })).value as string
    const gotB: string[] = []
    b.on('message', (d) => gotB.push(String(d)))
    const gotA = new Promise<string>((r) => a.once('message', (d) => r(String(d))))
    expect(rig.hub.sendTo(idA, { event: 'agents:changed', payload: [] })).toBe(true)
    expect(JSON.parse(await gotA)).toEqual({ event: 'agents:changed', payload: [] })
    await sleep(30)
    expect(gotB).toEqual([])
    const done = closed(a)
    a.close()
    await done
    await sleep(30)
    expect(rig.hub.sendTo(idA, { event: 'agents:changed', payload: [] })).toBe(false)
    expect(rig.hub.sendTo('nope', { event: 'agents:changed', payload: [] })).toBe(false)
  })

  it('onDisconnect fires once with the connection id when the socket closes', async () => {
    const gone: string[] = []
    rig = await startRig({ connHandlers: { 'x:who': async (conn) => conn.id }, onDisconnect: (id) => gone.push(id) })
    const a = await open(rig)
    const id = (await call(a, { id: 1, method: 'x:who', args: [] })).value as string
    expect(gone).toEqual([])
    const done = closed(a)
    a.close()
    await done
    await sleep(30)
    expect(gone).toEqual([id])
  })

  it('onDisconnect also fires for a socket terminated after missed pings', async () => {
    const gone: string[] = []
    rig = await startRig({ pingMs: 50, connHandlers: { 'x:who': async (conn) => conn.id }, onDisconnect: (id) => gone.push(id) })
    const ws = await open(rig, 'k1', { autoPong: false })
    const id = (await call(ws, { id: 1, method: 'x:who', args: [] })).value as string
    await closed(ws)
    await sleep(30)
    expect(gone).toEqual([id])
  })
})

const frame = (text: string): Buffer => {
  const p = Buffer.from(text)
  const mask = Buffer.from([1, 2, 3, 4])
  const out = Buffer.alloc(6 + p.length)
  out[0] = 0x81
  out[1] = 0x80 | p.length
  mask.copy(out, 2)
  for (let i = 0; i < p.length; i++) out[6 + i] = p[i]! ^ mask[i % 4]!
  return out
}
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

describe('hub after a sign-out close', () => {
  it('ignores requests from a client that ignores the close frame, then terminates it after the grace', async () => {
    const calls: string[] = []
    rig = await startRig({ closeGraceMs: 150, handlers: { 'x:side': async () => (calls.push('ran'), 1) } })
    const sock = connect(rig.port, '127.0.0.1')
    let got = ''
    let ended = false
    sock.on('data', (d) => (got += d.toString('latin1')))
    sock.on('close', () => (ended = true))
    sock.write(
      `GET /ws HTTP/1.1\r\nHost: 127.0.0.1:${rig.port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n`
    )
    await sleep(100)
    expect(got).toMatch(/^HTTP\/1.1 101/)
    rig.hub.closeSession('k1')
    await sleep(30)
    sock.write(frame(JSON.stringify({ id: 1, method: 'x:side', args: [] })))
    await sleep(50)
    expect(calls).toEqual([])
    expect(ended).toBe(false) // still inside the grace
    await sleep(300)
    expect(ended).toBe(true)
    expect(rig.hub.size()).toBe(0)
  })
})
