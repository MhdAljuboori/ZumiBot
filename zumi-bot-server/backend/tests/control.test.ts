import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { controlPath, queryBusy, serveControl } from '../src/control'

let dir: string
let sock: string
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'cb-ctl-'))
  // A named pipe on Windows, unique per temp dir.
  sock = controlPath(dir)
})
afterEach(() => rm(dir, { recursive: true, force: true }))

describe('control socket', () => {
  it('queryBusy returns busy()', async () => {
    let n = 3
    const close = await serveControl(sock, { busy: () => n })
    expect(await queryBusy(sock)).toBe(3)
    n = 0
    expect(await queryBusy(sock)).toBe(0)
    await close()
  })

  it.skipIf(process.platform === 'win32')('socket mode is 0o600', async () => {
    const close = await serveControl(sock, { busy: () => 0 })
    if (process.platform !== 'win32') expect((await stat(sock)).mode & 0o777).toBe(0o600)
    await close()
  })

  it.skipIf(process.platform === 'win32')('a leftover socket file from a crashed server is replaced', async () => {
    const first = await serveControl(sock, { busy: () => 1 })
    // Simulates a crash: the file stays, nobody listens. close() would remove it, so skip it and make a new server.
    const second = await serveControl(sock, { busy: () => 2 })
    expect(await queryBusy(sock)).toBe(2)
    await second()
    await first()
  })

  it('queryBusy rejects when no server', async () => {
    await expect(queryBusy(sock)).rejects.toThrow()
  })

  it('queryBusy rejects when the server never answers', async () => {
    const net = await import('node:net')
    const silent = net.createServer(() => {})
    await new Promise<void>((r) => silent.listen(sock, r))
    await expect(queryBusy(sock, 100)).rejects.toThrow()
    silent.close()
  })
})

describe('stdin control', () => {
  it('answers busy and processes lines, ignores others, and stops when stdin ends', async () => {
    const { PassThrough } = await import('node:stream')
    const { serveStdinControl } = await import('../src/control')
    const input = new PassThrough()
    const out: string[] = []
    let stopped = 0
    serveStdinControl(input, {
      query: (what) => (what === 'busy' ? Promise.resolve(2) : Promise.reject(new Error('no socket'))),
      out: (l) => out.push(l),
      stop: () => stopped++
    })
    input.write('busy\r\nhello\nprocesses\n')
    await new Promise((r) => setTimeout(r, 20))
    expect(out).toEqual(['CONTROL busy 2', 'CONTROL processes error'])
    expect(stopped).toBe(0)
    input.end()
    await new Promise((r) => setTimeout(r, 20))
    expect(stopped).toBe(1)
  })
})
