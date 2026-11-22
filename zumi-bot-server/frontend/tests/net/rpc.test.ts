import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRpcClient } from '../../src/net/rpc'
import { FakeSocket } from './fakeSocket'

const make = (onSignedOut = vi.fn()) => {
  const rpc = createRpcClient({ url: 'ws://x/ws', WebSocketImpl: FakeSocket as unknown as typeof WebSocket, onSignedOut })
  return { rpc, onSignedOut }
}

beforeEach(() => {
  FakeSocket.reset()
  vi.useFakeTimers()
})
afterEach(() => vi.useRealTimers())

describe('rpc client', () => {
  it('call resolves with value', async () => {
    const { rpc } = make()
    FakeSocket.last().open()
    const p = rpc.call('chats:list', [1])
    const req = JSON.parse(FakeSocket.last().sent[0])
    expect(req).toMatchObject({ method: 'chats:list', args: [1] })
    FakeSocket.last().receive({ id: req.id, ok: true, value: ['a'] })
    await expect(p).resolves.toEqual(['a'])
  })

  it('call rejects with server error text', async () => {
    const { rpc } = make()
    FakeSocket.last().open()
    const p = rpc.call('x', [])
    const { id } = JSON.parse(FakeSocket.last().sent[0])
    FakeSocket.last().receive({ id, ok: false, error: 'boom' })
    await expect(p).rejects.toThrow('boom')
  })

  it('events reach on() subscribers', () => {
    const { rpc } = make()
    FakeSocket.last().open()
    const cb = vi.fn()
    const off = rpc.on('agents:changed', cb)
    FakeSocket.last().receive({ event: 'agents:changed', payload: [{ from: 'a', to: 'b' }] })
    expect(cb).toHaveBeenCalledWith([{ from: 'a', to: 'b' }])
    off()
    FakeSocket.last().receive({ event: 'agents:changed', payload: [] })
    expect(cb).toHaveBeenCalledTimes(1)
  })

  it('a subscriber that throws does not stop the others', () => {
    const { rpc } = make()
    FakeSocket.last().open()
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    const after = vi.fn()
    rpc.on('agents:changed', () => {
      throw new Error('bad')
    })
    rpc.on('agents:changed', after)
    FakeSocket.last().receive({ event: 'agents:changed', payload: [] })
    expect(after).toHaveBeenCalledOnce()
    expect(log).toHaveBeenCalledOnce()
    log.mockRestore()
  })

  it('ignores a message that is valid JSON but not an object', () => {
    make()
    FakeSocket.last().open()
    expect(() => FakeSocket.last().receive(null)).not.toThrow()
    expect(() => FakeSocket.last().receive(5)).not.toThrow()
  })

  describe('checkAlive', () => {
    it('an answered ping keeps the socket', async () => {
      const { rpc } = make()
      const sock = FakeSocket.last()
      sock.open()
      rpc.checkAlive(5000)
      const ping = JSON.parse(sock.sent[0])
      expect(ping.method).toBe('rpc:ping')
      sock.receive({ id: ping.id, ok: true, value: true })
      await Promise.resolve()
      vi.advanceTimersByTime(5000)
      expect(rpc.status()).toBe('connected')
      expect(FakeSocket.instances).toHaveLength(1)
    })

    it('no answer in time: pending calls fail, the socket is dropped and a new one opens', async () => {
      const { rpc } = make()
      const sock = FakeSocket.last()
      sock.open()
      const hung = rpc.call('chats:list', [])
      rpc.checkAlive(5000)
      rpc.checkAlive(5000) // one probe at a time
      expect(sock.sent).toHaveLength(2)
      vi.advanceTimersByTime(5000)
      await expect(hung).rejects.toThrow('Not connected')
      expect(rpc.status()).toBe('reconnecting')
      expect(sock.readyState).toBe(3)
      vi.advanceTimersByTime(500)
      expect(FakeSocket.instances).toHaveLength(2)
      // The dead socket's late close changes nothing.
      sock.drop()
      expect(FakeSocket.instances).toHaveLength(2)
    })

    it('does nothing while not connected', () => {
      const { rpc } = make()
      rpc.checkAlive(5000)
      expect(FakeSocket.last().sent).toHaveLength(0)
    })
  })

  it('drop → status reconnecting, pending calls reject "Not connected. Reconnecting…"', async () => {
    const { rpc } = make()
    FakeSocket.last().open()
    const statuses: string[] = []
    rpc.onStatus((s) => statuses.push(s))
    const p = rpc.call('x', [])
    FakeSocket.last().drop()
    await expect(p).rejects.toThrow('Not connected. Reconnecting…')
    expect(rpc.status()).toBe('reconnecting')
    expect(statuses).toEqual(['reconnecting'])
    await expect(rpc.call('y', [])).rejects.toThrow('Not connected. Reconnecting…')
  })

  describe('before the first open', () => {
    // A page loaded at its own address (a refresh on Settings › Notifications) asks for its data on mount, before the socket is up.
    it('a call waits for the open, then is sent and answered', async () => {
      const { rpc } = make()
      const sock = FakeSocket.last()
      const p = rpc.call('notify:status', ['dev-1'])
      expect(sock.sent).toHaveLength(0)
      sock.open()
      const req = JSON.parse(sock.sent[0])
      expect(req).toMatchObject({ method: 'notify:status', args: ['dev-1'] })
      sock.receive({ id: req.id, ok: true, value: 'ok' })
      await expect(p).resolves.toBe('ok')
    })

    it('waiting calls go out in the order they were made, before the ones made on connect', () => {
      const { rpc } = make()
      const sock = FakeSocket.last()
      void rpc.call('a', [])
      void rpc.call('b', [])
      rpc.onStatus((s) => s === 'connected' && void rpc.call('c', []))
      sock.open()
      expect(sock.sent.map((s) => JSON.parse(s).method)).toEqual(['a', 'b', 'c'])
    })

    it('a socket that closes before it ever opened keeps the calls for the next try', async () => {
      const { rpc } = make()
      let settled = false
      const p = rpc.call('x', []).then(
        () => (settled = true),
        () => (settled = true)
      )
      FakeSocket.last().drop()
      await vi.advanceTimersByTimeAsync(500)
      expect(settled).toBe(false)
      const next = FakeSocket.last()
      expect(FakeSocket.instances).toHaveLength(2)
      next.open()
      const { id } = JSON.parse(next.sent[0])
      next.receive({ id, ok: true, value: 1 })
      await p
      expect(settled).toBe(true)
    })

    it('a sign-out before the first open fails the waiting calls', async () => {
      const { rpc, onSignedOut } = make()
      const p = rpc.call('x', [])
      FakeSocket.last().drop(4401)
      await expect(p).rejects.toThrow('Not connected. Reconnecting…')
      expect(onSignedOut).toHaveBeenCalledOnce()
      await expect(rpc.call('y', [])).rejects.toThrow('Not connected. Reconnecting…')
    })
  })

  it('reconnects with 500, 1000, 2000 … capped 10000', () => {
    make()
    FakeSocket.last().open()
    const delays = [500, 1000, 2000, 4000, 8000, 10000, 10000]
    for (const d of delays) {
      const n = FakeSocket.instances.length
      FakeSocket.last().drop()
      vi.advanceTimersByTime(d - 1)
      expect(FakeSocket.instances.length).toBe(n)
      vi.advanceTimersByTime(1)
      expect(FakeSocket.instances.length).toBe(n + 1)
    }
  })

  it('close 4401 calls onSignedOut and does not reconnect', () => {
    const { onSignedOut } = make()
    FakeSocket.last().open()
    FakeSocket.last().drop(4401)
    vi.advanceTimersByTime(60_000)
    expect(onSignedOut).toHaveBeenCalledTimes(1)
    expect(FakeSocket.instances.length).toBe(1)
  })

  it('back to connected emits connected once', () => {
    const { rpc } = make()
    FakeSocket.last().open()
    const statuses: string[] = []
    rpc.onStatus((s) => statuses.push(s))
    FakeSocket.last().drop()
    vi.advanceTimersByTime(500)
    FakeSocket.last().open()
    expect(statuses).toEqual(['reconnecting', 'connected'])
    expect(rpc.status()).toBe('connected')
  })

  it('has no per-call timeout (chats:send resolves when the turn ends)', async () => {
    const { rpc } = make()
    FakeSocket.last().open()
    let settled = false
    const p = rpc.call('chats:send', []).then(() => (settled = true))
    await vi.advanceTimersByTimeAsync(3_600_000)
    expect(settled).toBe(false)
    const { id } = JSON.parse(FakeSocket.last().sent[0])
    FakeSocket.last().receive({ id, ok: true, value: undefined })
    await p
    expect(settled).toBe(true)
  })
})
