import { describe, expect, it, vi } from 'vitest'
import type { ConnectionStatus, ServerMode } from '@zumibot/shared/types'
import { watchMode } from '../../src/net/modeProbe'

const flush = () => new Promise((r) => setTimeout(r, 0))

function setup(getMode: () => Promise<ServerMode>) {
  let push: (s: ConnectionStatus) => void = () => {}
  const off = vi.fn()
  const onStatus = (cb: (s: ConnectionStatus) => void) => {
    push = cb
    return off
  }
  const seen: ServerMode[] = []
  const stop = watchMode(onStatus, getMode, (m) => seen.push(m))
  return { push: (s: ConnectionStatus) => push(s), seen, stop, off }
}

describe('watchMode', () => {
  it('waits for the socket before asking, so a start-up call is not lost', async () => {
    const getMode = vi.fn().mockResolvedValue('vps')
    const t = setup(getMode)
    t.push('reconnecting')
    expect(getMode).not.toHaveBeenCalled()
    t.push('connected')
    await flush()
    expect(t.seen).toEqual(['vps'])
  })

  it('asks again on the next connect when the first call failed, then stops asking', async () => {
    const getMode = vi.fn().mockRejectedValueOnce(new Error('down')).mockResolvedValue('local')
    const t = setup(getMode)
    t.push('connected')
    await flush()
    expect(t.seen).toEqual([])
    t.push('reconnecting')
    t.push('connected')
    await flush()
    expect(t.seen).toEqual(['local'])
    t.push('reconnecting')
    t.push('connected')
    await flush()
    expect(getMode).toHaveBeenCalledTimes(2)
  })

  it('reports nothing after stop, and unsubscribes', async () => {
    const t = setup(() => Promise.resolve('vps'))
    t.push('connected')
    t.stop()
    await flush()
    expect(t.seen).toEqual([])
    expect(t.off).toHaveBeenCalled()
  })
})
