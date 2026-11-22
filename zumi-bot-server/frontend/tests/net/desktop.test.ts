import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createDesktopClient, type RfbChannel } from '../../src/net/desktop'
import type { DesktopStatus } from '@zumibot/shared/desktop'
import { FakeSocket } from './fakeSocket'

const status: DesktopStatus = {
  agent: 'a',
  profileId: 'p',
  generation: 'g',
  state: 'ready',
  control: 'agent',
  pendingRequestId: null,
  error: null,
  width: 1280,
  height: 800,
  busy: false
}
const json = (s: FakeSocket) => s.sent.filter((x): x is string => typeof x === 'string').map((x) => JSON.parse(x))
const binary = (s: FakeSocket) => (s.sent as unknown[]).filter((x) => typeof x !== 'string') as Uint8Array[]
const bytes = (...b: number[]) => new Uint8Array(b).buffer
const push = (s: FakeSocket, data: ArrayBuffer) => s.onmessage?.({ data } as never)
const tick = () => Promise.resolve()
const settle = async () => {
  for (let i = 0; i < 10; i++) await tick()
}

function setup() {
  const statuses: Array<DesktopStatus | null> = [],
    rfb: Array<[string, string]> = []
  const signedOut = vi.fn()
  const c = createDesktopClient({
    url: 'ws://fixture/ws/desktop',
    socket: (u) => new FakeSocket(u) as unknown as WebSocket,
    onSignedOut: signedOut
  })
  c.onStatus((s) => statuses.push(s))
  c.onRfb((state, generation) => rfb.push([state, generation]))
  return { c, statuses, rfb, signedOut }
}
/** A client watching agent `a` with id 1, the socket open and the watch answered. */
async function watching() {
  const t = setup()
  const watch = t.c.watch({ agent: 'a', chatId: 'c' })
  const s = FakeSocket.last()
  s.open()
  await tick()
  s.receive({ type: 'response', id: 1, ok: true, value: null })
  await watch
  return { ...t, s }
}
/** A leg opened for the watch, with noVNC's handler attached. */
function leg(s: FakeSocket, c: ReturnType<typeof setup>['c'], watchId = 1) {
  s.receive({ type: 'rfb', watchId, state: 'open', generation: 'g' })
  const ch = c.channel() as RfbChannel
  const got: ArrayBuffer[] = [],
    closes: unknown[] = []
  ch.onmessage = (e) => got.push(e.data)
  ch.onclose = (e) => closes.push(e)
  return { ch, got, closes }
}

beforeEach(() => {
  FakeSocket.reset()
  vi.useFakeTimers()
})
afterEach(() => vi.useRealTimers())

describe('desktop client', () => {
  it('does not connect until asked, then watch sends a watch request and resolves on ok', async () => {
    const { c } = setup()
    expect(FakeSocket.instances).toHaveLength(0)
    const watch = c.watch({ agent: 'a', chatId: 'c' })
    const s = FakeSocket.last()
    s.open()
    await tick()
    expect(json(s)).toEqual([{ id: 1, op: 'watch', target: { agent: 'a', chatId: 'c' } }])
    expect(c.watching()).toEqual({ agent: 'a', chatId: 'c' })
    s.receive({ type: 'response', id: 1, ok: true, value: null })
    await expect(watch).resolves.toBeUndefined()
    c.close()
  })

  it('a refused watch rejects with the server text and stops watching', async () => {
    const { c } = setup()
    const watch = c.watch({ agent: 'a' })
    const s = FakeSocket.last()
    s.open()
    await tick()
    s.receive({ type: 'response', id: 1, ok: false, error: 'Desktop request denied or unavailable' })
    await expect(watch).rejects.toThrow('Desktop request denied or unavailable')
    expect(c.watching()).toBe(null)
    c.close()
  })

  it('status messages reach onStatus, even before the watch is answered', async () => {
    const { c, statuses } = setup()
    const watch = c.watch({ agent: 'a' })
    const s = FakeSocket.last()
    s.open()
    await tick()
    s.receive({ type: 'status', watchId: 1, status: { ...status, state: 'starting' } })
    expect(statuses.at(-1)).toMatchObject({ state: 'starting' })
    s.receive({ type: 'response', id: 1, ok: true, value: null })
    await watch
    s.receive({ type: 'status', watchId: 1, status })
    expect(statuses.at(-1)).toEqual(status)
    c.close()
  })

  it('ignores statuses and rfb opens of an earlier watch', async () => {
    const { c, s, statuses, rfb } = await watching()
    const second = c.watch({ agent: 'b' })
    await tick()
    expect(json(s).at(-1)).toEqual({ id: 2, op: 'watch', target: { agent: 'b' } })
    s.receive({ type: 'status', watchId: 1, status })
    s.receive({ type: 'rfb', watchId: 1, state: 'open', generation: 'g' })
    expect(statuses).toHaveLength(0)
    expect(rfb).toHaveLength(0)
    expect(c.channel()).toBe(null)
    // The stale leg's bytes go nowhere, and its close ends nothing the caller saw.
    push(s, bytes(1, 2))
    s.receive({ type: 'rfb', watchId: 1, state: 'closed', generation: 'g' })
    expect(rfb).toHaveLength(0)
    s.receive({ type: 'status', watchId: 2, status: { ...status, agent: 'b' } })
    expect(statuses.at(-1)).toMatchObject({ agent: 'b' })
    s.receive({ type: 'response', id: 2, ok: true, value: null })
    await second
    c.close()
  })

  it('rfb open creates a channel that is OPEN and receives only binary', async () => {
    const { c, s, rfb } = await watching()
    expect(c.channel()).toBe(null)
    const { ch, got } = leg(s, c)
    expect(rfb).toEqual([['open', 'g']])
    expect(ch.readyState).toBe(1)
    expect(ch.binaryType).toBe('arraybuffer')
    for (const prop of ['send', 'close', 'binaryType', 'onerror', 'onmessage', 'onopen', 'protocol', 'readyState'])
      expect(prop in ch).toBe(true)
    push(s, bytes(82, 70, 66))
    s.receive({ type: 'status', watchId: 1, status })
    expect(got.map((b) => [...new Uint8Array(b)])).toEqual([[82, 70, 66]])
    c.close()
  })

  it('holds the bytes that arrive before noVNC attaches and hands them over after', async () => {
    const { c, s } = await watching()
    s.receive({ type: 'rfb', watchId: 1, state: 'open', generation: 'g' })
    const ch = c.channel() as RfbChannel
    push(s, bytes(1))
    push(s, bytes(2))
    const got: number[][] = []
    ch.onmessage = (e) => got.push([...new Uint8Array(e.data)])
    // Not inside the setter: noVNC finishes attaching before its first message.
    expect(got).toEqual([])
    await tick()
    push(s, bytes(3))
    expect(got).toEqual([[1], [2], [3]])
    c.close()
  })

  it('channel.send writes one binary frame per send', async () => {
    const { c, s } = await watching()
    const { ch } = leg(s, c)
    const version = new TextEncoder().encode('RFB 003.008\n')
    ch.send(version)
    ch.send(new Uint8Array([4, 1]))
    expect(binary(s)).toHaveLength(2)
    expect(new TextDecoder().decode(binary(s)[0])).toBe('RFB 003.008\n')
    c.close()
  })

  it('rfb closed fires the channel onclose once and the leg reports closed', async () => {
    const { c, s, rfb } = await watching()
    const { ch, got, closes } = leg(s, c)
    s.receive({ type: 'rfb', watchId: 1, state: 'closed', generation: 'g' })
    expect(closes).toHaveLength(1)
    expect(ch.readyState).toBe(3)
    expect(rfb).toEqual([
      ['open', 'g'],
      ['closed', 'g']
    ])
    expect(c.channel()).toBe(null)
    push(s, bytes(9))
    ch.close()
    s.receive({ type: 'rfb', watchId: 1, state: 'closed', generation: 'g' })
    await tick()
    expect(closes).toHaveLength(1)
    expect(got).toHaveLength(0)
    // Closing a leg the server already ended is not an unwatch.
    expect(json(s).some((r) => r.op === 'unwatch')).toBe(false)
    c.close()
  })

  it('a closed leg of a replaced watch still ends its channel', async () => {
    const { c, s, rfb } = await watching()
    const { closes } = leg(s, c)
    const second = c.watch({ agent: 'a', chatId: 'c' }).catch(() => {})
    await tick()
    s.receive({ type: 'rfb', watchId: 1, state: 'closed', generation: 'g' })
    expect(closes).toHaveLength(1)
    expect(rfb.at(-1)).toEqual(['closed', 'g'])
    s.receive({ type: 'rfb', watchId: 2, state: 'open', generation: 'g' })
    expect(rfb.at(-1)).toEqual(['open', 'g'])
    expect(c.channel()?.readyState).toBe(1)
    s.receive({ type: 'response', id: 2, ok: true, value: null })
    await second
    c.close()
  })

  it('noVNC closing the channel unwatches and fires its onclose once', async () => {
    const { c, s } = await watching()
    const { ch, closes } = leg(s, c)
    ch.close()
    ch.close()
    expect(ch.readyState).toBe(3)
    expect(json(s).filter((r) => r.op === 'unwatch')).toEqual([{ id: 2, op: 'unwatch' }])
    expect(c.watching()).toBe(null)
    ch.send(new Uint8Array([1]))
    expect(binary(s)).toHaveLength(0)
    await tick()
    expect(closes).toHaveLength(1)
    s.receive({ type: 'rfb', watchId: 1, state: 'closed', generation: 'g' })
    expect(closes).toHaveLength(1)
    c.close()
  })

  it('unwatch sends one unwatch request and later statuses are ignored', async () => {
    const { c, s, statuses } = await watching()
    c.unwatch()
    c.unwatch()
    expect(json(s).filter((r) => r.op === 'unwatch')).toHaveLength(1)
    s.receive({ type: 'status', watchId: 1, status })
    expect(statuses).toHaveLength(0)
    c.close()
  })

  it('takeControl sends takeControl and releaseControl', async () => {
    const { c, s } = await watching()
    const take = c.takeControl(true)
    expect(json(s).at(-1)).toEqual({ id: 2, op: 'takeControl' })
    s.receive({ type: 'response', id: 2, ok: true, value: null })
    await take
    const release = c.takeControl(false)
    expect(json(s).at(-1)).toEqual({ id: 3, op: 'releaseControl' })
    s.receive({ type: 'response', id: 3, ok: true, value: null })
    await release
    const refused = c.takeControl(true)
    s.receive({ type: 'response', id: 4, ok: false, error: 'Desktop is controlled in another window' })
    await expect(refused).rejects.toThrow('Desktop is controlled in another window')
    c.close()
  })

  it('takeControl without a watch is refused without a request', async () => {
    const { c, s } = await watching()
    c.unwatch()
    await expect(c.takeControl(true)).rejects.toThrow()
    expect(json(s).some((r) => r.op === 'takeControl')).toBe(false)
    c.close()
  })

  it('takeControl(false) after a closed socket resolves without throwing', async () => {
    const { c, s } = await watching()
    s.drop()
    await expect(c.takeControl(false)).resolves.toBeUndefined()
    c.close()
    await expect(c.takeControl(false)).resolves.toBeUndefined()
  })

  it('takeControl(false) settles when the socket drops before its answer', async () => {
    const { c, s } = await watching()
    const release = c.takeControl(false)
    s.drop()
    await expect(release).resolves.toBeUndefined()
    c.close()
  })

  it('answer works without a watch: it connects and sends only the answer', async () => {
    const { c } = setup()
    const target = { agent: 'a', chatId: 'c', requestId: 'r' }
    const answer = c.answer(target, 'r', 'done')
    const s = FakeSocket.last()
    s.open()
    await tick()
    expect(json(s)).toEqual([{ id: 1, op: 'answer', target, requestId: 'r', decision: 'done' }])
    s.receive({ type: 'response', id: 1, ok: true, value: null })
    await expect(answer).resolves.toBeUndefined()
    const cancel = c.answer(target, 'r', 'cancel')
    await tick()
    s.receive({ type: 'response', id: 2, ok: false, error: 'Desktop request denied or unavailable' })
    await expect(cancel).rejects.toThrow('Desktop request denied or unavailable')
    expect(c.watching()).toBe(null)
    c.close()
  })

  it('responses with unknown ids and malformed messages are ignored', async () => {
    const { c, s, statuses } = await watching()
    const take = c.takeControl(true)
    s.receive({ type: 'response', id: 99, ok: false, error: 'nope' })
    s.onmessage?.({ data: '{not json' })
    s.receive({ type: 'response', id: 2, ok: true, value: null })
    await expect(take).resolves.toBeUndefined()
    expect(statuses).toHaveLength(0)
    c.close()
  })

  it('re-watches once the leg drops while the desktop is still ready on the same generation', async () => {
    const { c, s, rfb } = await watching()
    s.receive({ type: 'status', watchId: 1, status })
    leg(s, c)
    s.receive({ type: 'rfb', watchId: 1, state: 'closed', generation: 'g' })
    expect(json(s).filter((r) => r.op === 'watch')).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1000)
    expect(json(s).at(-1)).toEqual({ id: 2, op: 'watch', target: { agent: 'a', chatId: 'c' } })
    s.receive({ type: 'rfb', watchId: 2, state: 'open', generation: 'g' })
    expect(rfb.at(-1)).toEqual(['open', 'g'])
    expect(c.channel()?.readyState).toBe(1)
    c.close()
  })

  it('does not re-watch a desktop that is stopping, nor after an unwatch', async () => {
    const { c, s } = await watching()
    s.receive({ type: 'status', watchId: 1, status })
    leg(s, c)
    // A stopping desktop ends the leg first and says so right after.
    s.receive({ type: 'rfb', watchId: 1, state: 'closed', generation: 'g' })
    s.receive({ type: 'status', watchId: 1, status: { ...status, state: 'closing' } })
    await vi.advanceTimersByTimeAsync(5000)
    expect(json(s).filter((r) => r.op === 'watch')).toHaveLength(1)
    s.receive({ type: 'status', watchId: 1, status })
    s.receive({ type: 'rfb', watchId: 1, state: 'open', generation: 'g' })
    s.receive({ type: 'rfb', watchId: 1, state: 'closed', generation: 'g' })
    c.unwatch()
    await vi.advanceTimersByTimeAsync(5000)
    expect(json(s).filter((r) => r.op === 'watch')).toHaveLength(1)
    c.close()
  })

  it('gives up after five quick drops, and a manual watch gets its own automatic re-watches again', async () => {
    const { c, s, statuses } = await watching()
    const watchIds = () =>
      json(s)
        .filter((r) => r.op === 'watch')
        .map((r) => r.id as number)
    // A leg that opens and drops at once, on a desktop still ready on the same generation.
    const drop = (id: number) => {
      s.receive({ type: 'status', watchId: id, status })
      s.receive({ type: 'rfb', watchId: id, state: 'open', generation: 'g' })
      s.receive({ type: 'rfb', watchId: id, state: 'closed', generation: 'g' })
    }
    let id = 1
    for (let i = 0; i < 5; i++) {
      drop(id)
      await vi.advanceTimersByTimeAsync(20_000)
      expect(watchIds()).toHaveLength(i + 2)
      id = watchIds().at(-1)!
      s.receive({ type: 'response', id, ok: true, value: null })
    }
    drop(id)
    await vi.advanceTimersByTimeAsync(20_000)
    expect(watchIds()).toHaveLength(6)
    expect(statuses.at(-1)).toBe(null)
    expect(c.watching()).toBe(null)
    expect(json(s).at(-1)).toMatchObject({ op: 'unwatch' })
    // Retry by hand: the count starts over.
    const manual = c.watch({ agent: 'a', chatId: 'c' })
    await tick()
    id = watchIds().at(-1)!
    s.receive({ type: 'response', id, ok: true, value: null })
    await manual
    drop(id)
    await vi.advanceTimersByTimeAsync(1000)
    expect(watchIds()).toHaveLength(8)
    c.close()
  })

  it('a failed re-watch gives the watch up with a null status', async () => {
    const { c, s, statuses } = await watching()
    s.receive({ type: 'status', watchId: 1, status })
    leg(s, c)
    s.receive({ type: 'rfb', watchId: 1, state: 'closed', generation: 'g' })
    await vi.advanceTimersByTimeAsync(1000)
    s.receive({ type: 'response', id: 2, ok: false, error: 'Desktop request denied or unavailable' })
    await settle()
    expect(statuses.at(-1)).toBe(null)
    expect(c.watching()).toBe(null)
    c.close()
  })

  it('a dropped socket ends the leg and the watch, reports the connection and reconnects', async () => {
    const connections: boolean[] = []
    const c = createDesktopClient({
      url: 'ws://fixture',
      socket: (u) => new FakeSocket(u) as unknown as WebSocket,
      onConnection: (on) => connections.push(on)
    })
    const rfb: string[] = []
    c.onRfb((state) => rfb.push(state))
    const watch = c.watch({ agent: 'a' })
    const s = FakeSocket.last()
    s.open()
    await tick()
    s.receive({ type: 'response', id: 1, ok: true, value: null })
    await watch
    const { closes } = leg(s, c)
    const take = c.takeControl(true)
    s.drop()
    await expect(take).rejects.toThrow()
    expect(closes).toHaveLength(1)
    expect(rfb).toEqual(['open', 'closed'])
    expect(c.watching()).toBe(null)
    expect(connections).toEqual([true, false])
    await vi.runOnlyPendingTimersAsync()
    FakeSocket.last().open()
    expect(connections).toEqual([true, false, true])
    // Nothing is replayed on the new socket: the caller watches again if it still wants to.
    expect(FakeSocket.last().sent).toHaveLength(0)
    c.close()
  })

  it('signed out closes once without reconnecting', async () => {
    const { c, signedOut } = setup()
    const watch = c.watch({ agent: 'a' }).catch(() => {})
    FakeSocket.last().open()
    await tick()
    FakeSocket.last().drop(4401)
    await watch
    await vi.runOnlyPendingTimersAsync()
    expect(signedOut).toHaveBeenCalledTimes(1)
    expect(FakeSocket.instances).toHaveLength(1)
    c.close()
  })

  it('cancels a watch still waiting for the socket and never sends it', async () => {
    const { c } = setup()
    const opening = c.watch({ agent: 'a' }).catch((e: Error) => e.message)
    c.unwatch()
    const s = FakeSocket.last()
    s.open()
    expect(await opening).toBeTruthy()
    expect(s.sent).toHaveLength(0)
    c.close()
  })

  it('close ends the leg and refuses later calls', async () => {
    const { c, s } = await watching()
    const { closes } = leg(s, c)
    c.close()
    expect(closes).toHaveLength(1)
    expect(s.readyState).toBe(3)
    await expect(c.watch({ agent: 'a' })).rejects.toThrow()
    await expect(c.answer({ agent: 'a', chatId: 'c', requestId: 'r' }, 'r', 'done')).rejects.toThrow()
  })
})
