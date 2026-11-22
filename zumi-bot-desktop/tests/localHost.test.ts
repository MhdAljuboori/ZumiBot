import { describe, expect, it } from 'vitest'
import { createLocalHost, LaunchAborted } from '../src/main/localHost'

function fake() {
  const started: { stopped: boolean; resolve(): void; id: number }[] = []
  const start = () =>
    new Promise<{ id: number; stop(): Promise<void> }>((resolve) => {
      const rec = {
        stopped: false,
        id: started.length,
        resolve: () => resolve({ id: rec.id, stop: async () => void (rec.stopped = true) })
      }
      started.push(rec)
    })
  return { started, start }
}

describe('createLocalHost', () => {
  it('two ensure() calls during one launch start one server', async () => {
    const f = fake()
    const h = createLocalHost(f.start)
    const a = h.ensure()
    const b = h.ensure()
    f.started[0]!.resolve()
    expect((await a).id).toBe(0)
    expect((await b).id).toBe(0)
    expect(f.started).toHaveLength(1)
    expect((await h.ensure()).id).toBe(0) // and a live one is reused
    expect(f.started).toHaveLength(1)
  })

  it('stop() during a launch stops the server that comes up, and ensure() rejects LaunchAborted', async () => {
    const f = fake()
    const h = createLocalHost(f.start)
    const a = h.ensure()
    const stopping = h.stop()
    f.started[0]!.resolve()
    await expect(a).rejects.toBeInstanceOf(LaunchAborted)
    await stopping
    expect(f.started[0]!.stopped).toBe(true)
    expect(h.current()).toBeNull()
  })

  it('stop() stops a live server and the next ensure() starts a fresh one', async () => {
    const f = fake()
    const h = createLocalHost(f.start)
    const a = h.ensure()
    f.started[0]!.resolve()
    await a
    await h.stop()
    expect(f.started[0]!.stopped).toBe(true)
    const b = h.ensure()
    f.started[1]!.resolve()
    expect((await b).id).toBe(1)
  })

  it('a failed launch is not cached', async () => {
    let n = 0
    const h = createLocalHost(async () => {
      if (n++ === 0) throw new Error('boom')
      return { stop: async () => {} }
    })
    await expect(h.ensure()).rejects.toThrow('boom')
    await expect(h.ensure()).resolves.toBeTruthy()
  })

  it('forget() drops a server that died on its own', async () => {
    const f = fake()
    const h = createLocalHost(f.start)
    const a = h.ensure()
    f.started[0]!.resolve()
    const s = await a
    h.forget(s)
    expect(h.current()).toBeNull()
  })
})
