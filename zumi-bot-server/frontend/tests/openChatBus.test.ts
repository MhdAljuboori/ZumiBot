import { describe, expect, it, vi } from 'vitest'
import { createOpenChatBus, openChatMessage } from '../src/net/openChatBus'

describe('openChatMessage', () => {
  it('reads the worker message', () => {
    expect(openChatMessage({ type: 'open-chat', chatId: 'c1' })).toEqual({ chatId: 'c1' })
    expect(openChatMessage({ type: 'open-chat', chatId: null })).toEqual({ chatId: null })
  })
  it('ignores anything else', () => {
    for (const bad of [null, 'open-chat', { type: 'other', chatId: 'c1' }, { type: 'open-chat', chatId: 5 }, { type: 'open-chat' }]) {
      expect(openChatMessage(bad)).toBeNull()
    }
  })
})

describe('openChatBus', () => {
  it('delivers to a subscriber', () => {
    const bus = createOpenChatBus()
    const cb = vi.fn()
    bus.on(cb)
    bus.emit('c1')
    expect(cb).toHaveBeenCalledWith('c1')
  })
  it('replays the latest one to a late subscriber, once', () => {
    const bus = createOpenChatBus()
    bus.emit('c1')
    bus.emit('c2')
    const first = vi.fn()
    bus.on(first)
    expect(first.mock.calls).toEqual([['c2']])
    const second = vi.fn()
    bus.on(second)
    expect(second).not.toHaveBeenCalled()
  })
  it('stops after unsubscribing and holds the next one again', () => {
    const bus = createOpenChatBus()
    const cb = vi.fn()
    const off = bus.on(cb)
    off()
    bus.emit('c3')
    expect(cb).not.toHaveBeenCalled()
    const late = vi.fn()
    bus.on(late)
    expect(late).toHaveBeenCalledWith('c3')
  })
})
