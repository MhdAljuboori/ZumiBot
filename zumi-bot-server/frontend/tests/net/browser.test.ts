import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createBrowserClient } from '../../src/net/browser'
import { encodeBrowserFrame, type BrowserStatus } from '@zumibot/shared/browser'
import { FakeSocket } from './fakeSocket'
const status: BrowserStatus = {
  agent: 'a',
  profileId: 'p',
  generation: 'g',
  state: 'ready',
  tabs: [{ id: 't', url: 'about:blank', title: '' }],
  activeTabId: 't',
  control: 'agent',
  pendingRequestId: null,
  error: null
}
const sent = (s: FakeSocket) => s.sent.map((x) => JSON.parse(x))
function setup() {
  const states: Array<BrowserStatus | null> = [],
    frames: unknown[] = []
  const c = createBrowserClient({
    url: 'ws://fixture/ws/browser',
    makeSocket: (u) => new FakeSocket(u) as unknown as WebSocket,
    onStatus: (s) => states.push(s),
    onFrame: (f) => frames.push(f),
    onSignedOut: vi.fn()
  })
  return { c, states, frames }
}
beforeEach(() => {
  FakeSocket.reset()
  vi.useFakeTimers()
})
afterEach(() => vi.useRealTimers())
describe('on-demand browser client', () => {
  it('does not connect or watch on mount and subscribes only after explicit open', async () => {
    const { c } = setup()
    expect(FakeSocket.instances).toHaveLength(0)
    const watch = c.watch({ agent: 'a' })
    const s = FakeSocket.last()
    s.open()
    await Promise.resolve()
    expect(sent(s)).toEqual([{ id: 1, op: 'watch', target: { agent: 'a' } }])
    s.receive({ type: 'response', id: 1, ok: true, value: null })
    await watch
    c.close()
  })
  it('accepts early status and shared binary frames but ignores replaced watches', async () => {
    const { c, states, frames } = setup()
    const watch = c.watch({ agent: 'a' })
    const s = FakeSocket.last()
    s.open()
    await Promise.resolve()
    s.receive({ type: 'status', watchId: 1, status })
    expect(states.at(-1)).toEqual(status)
    s.onmessage?.({
      data: encodeBrowserFrame(1, { generation: 'g', tabId: 't', sequence: 1, width: 100, height: 100, jpeg: new Uint8Array([1]) }).buffer
    } as never)
    expect(frames).toHaveLength(1)
    const done = watch.catch(() => {})
    c.unwatch()
    s.receive({ type: 'response', id: 1, ok: true, value: null })
    await done
    s.receive({ type: 'status', watchId: 1, status })
    expect(states.at(-1)).toBeNull()
    c.close()
  })
  it('cancels an in-flight takeover on unwatch and refuses stale input', async () => {
    const { c } = setup()
    const watch = c.watch({ agent: 'a' })
    const s = FakeSocket.last()
    s.open()
    await Promise.resolve()
    s.receive({ type: 'status', watchId: 1, status })
    s.receive({ type: 'response', id: 1, ok: true, value: null })
    await watch
    const control = c.takeControl(true).catch(() => {})
    c.unwatch()
    s.receive({ type: 'status', watchId: 1, status: { ...status, control: 'you' } })
    s.receive({ type: 'response', id: 2, ok: true, value: null })
    await control
    await expect(c.input({ type: 'text', text: 'private', generation: 'g', tabId: 't' })).rejects.toThrow()
    expect(sent(s).some((r) => r.op === 'input')).toBe(false)
    c.close()
  })
  it('returns to read-only after disconnect and does not replay input or watch', async () => {
    const { c } = setup()
    const watch = c.watch({ agent: 'a' }).catch(() => {})
    const s = FakeSocket.last()
    s.open()
    await Promise.resolve()
    s.drop()
    await watch
    await vi.runOnlyPendingTimersAsync()
    FakeSocket.last().open()
    await Promise.resolve()
    expect(FakeSocket.last().sent).toHaveLength(0)
    await expect(c.takeControl(true)).rejects.toThrow()
    c.close()
  })
  it('failed control stays observer and navigation includes the expected page', async () => {
    const { c } = setup()
    const watch = c.watch({ agent: 'a' })
    const s = FakeSocket.last()
    s.open()
    await Promise.resolve()
    s.receive({ type: 'status', watchId: 1, status })
    s.receive({ type: 'response', id: 1, ok: true, value: null })
    await watch
    const control = c.takeControl(true)
    s.receive({ type: 'response', id: 2, ok: false, error: 'Controlled elsewhere' })
    await expect(control).rejects.toThrow('Controlled elsewhere')
    await expect(c.navigate({ op: 'reload' })).rejects.toThrow()
    const owned = c.takeControl(true)
    s.receive({ type: 'status', watchId: 1, status: { ...status, control: 'you' } })
    s.receive({ type: 'response', id: 3, ok: true, value: null })
    await owned
    const nav = c.navigate({ op: 'reload' })
    expect(sent(s).at(-1)).toMatchObject({ op: 'navigate', watchId: 1, generation: 'g', tabId: 't', command: { op: 'reload' } })
    s.receive({ type: 'response', id: 4, ok: true, value: { ok: true, data: null } })
    await nav
    c.close()
  })
  it('Done without a viewer uses only an answer request', async () => {
    const { c } = setup()
    const answer = c.answer('request', 'done', { agent: 'a', chatId: 'chat', requestId: 'request' })
    const s = FakeSocket.last()
    s.open()
    await Promise.resolve()
    expect(sent(s)).toEqual([
      { id: 1, op: 'answer', target: { agent: 'a', chatId: 'chat', requestId: 'request' }, requestId: 'request', decision: 'done' }
    ])
    s.receive({ type: 'response', id: 1, ok: true, value: null })
    await answer
    c.close()
  })
  it('cancels before socket open and never sends a hidden watch', async () => {
    const { c } = setup()
    const opening = c.watch({ agent: 'a' }).catch(() => {})
    c.unwatch()
    const s = FakeSocket.last()
    s.open()
    await opening
    expect(s.sent).toHaveLength(0)
    c.close()
  })
  it('drops control on generation change and ignores stale control responses', async () => {
    const { c } = setup()
    const watching = c.watch({ agent: 'a' })
    const s = FakeSocket.last()
    s.open()
    await Promise.resolve()
    s.receive({ type: 'status', watchId: 1, status })
    s.receive({ type: 'response', id: 1, ok: true, value: null })
    await watching
    const control = c.takeControl(true)
    s.receive({ type: 'status', watchId: 1, status: { ...status, generation: 'new', control: 'you' } })
    s.receive({ type: 'response', id: 2, ok: true, value: null })
    await control
    await expect(c.input({ type: 'text', text: 'private', generation: 'new', tabId: 't' })).rejects.toThrow()
    c.close()
  })
  it('signed-out closes once without reconnecting', async () => {
    const signedOut = vi.fn()
    const c = createBrowserClient({
      url: 'ws://fixture',
      makeSocket: (u) => new FakeSocket(u) as unknown as WebSocket,
      onStatus: () => {},
      onFrame: () => {},
      onSignedOut: signedOut
    })
    const watch = c.watch({ agent: 'a' }).catch(() => {})
    FakeSocket.last().open()
    await Promise.resolve()
    FakeSocket.last().drop(4401)
    await watch
    await vi.runOnlyPendingTimersAsync()
    expect(signedOut).toHaveBeenCalledTimes(1)
    expect(FakeSocket.instances).toHaveLength(1)
    c.close()
  })

  it('answering another agent does not drop the unrelated viewer control', async () => {
    const { c } = setup()
    const watching = c.watch({ agent: 'a' })
    const s = FakeSocket.last()
    s.open()
    await Promise.resolve()
    s.receive({ type: 'status', watchId: 1, status })
    s.receive({ type: 'response', id: 1, ok: true, value: null })
    await watching
    const control = c.takeControl(true)
    s.receive({ type: 'status', watchId: 1, status: { ...status, control: 'you' } })
    s.receive({ type: 'response', id: 2, ok: true, value: null })
    await control
    const answer = c.answer('r', 'cancel', { agent: 'b', chatId: 'c', requestId: 'r' })
    await Promise.resolve()
    s.receive({ type: 'response', id: 3, ok: true, value: null })
    await answer
    const input = c.input({ type: 'text', text: 'synthetic', generation: 'g', tabId: 't' })
    expect(sent(s).at(-1)).toMatchObject({ op: 'input' })
    s.receive({ type: 'response', id: 4, ok: true, value: null })
    await input
    c.close()
  })

  it('keeps already acknowledged control when a manual tab selection changes the current tab', async () => {
    const { c } = setup()
    const watching = c.watch({ agent: 'a' })
    const s = FakeSocket.last()
    s.open()
    await Promise.resolve()
    s.receive({ type: 'status', watchId: 1, status })
    s.receive({ type: 'response', id: 1, ok: true, value: null })
    await watching
    const control = c.takeControl(true)
    s.receive({ type: 'status', watchId: 1, status: { ...status, control: 'you' } })
    s.receive({ type: 'response', id: 2, ok: true, value: null })
    await control
    s.receive({ type: 'status', watchId: 1, status: { ...status, activeTabId: 'new', control: 'you' } })
    const input = c.input({ type: 'text', text: 'synthetic', generation: 'g', tabId: 'new' }).catch((e) => {
      throw e
    })
    input.catch(() => {})
    expect(sent(s).at(-1)).toMatchObject({ op: 'input', input: { tabId: 'new' } })
    s.receive({ type: 'response', id: 3, ok: true, value: null })
    await input
    c.close()
  })

  it('keeps unavailable launch guidance when the failed watch is retired', async () => {
    const { c } = setup()
    const watching = c.watch({ agent: 'a' })
    const s = FakeSocket.last()
    s.open()
    await Promise.resolve()
    s.receive({ type: 'status', watchId: 1, status: { ...status, state: 'unavailable', error: 'Browser could not be started' } })
    s.receive({ type: 'response', id: 1, ok: false, error: 'Browser request failed' })
    await expect(watching).rejects.toThrow(/server.*setup/)
    c.close()
  })
})
